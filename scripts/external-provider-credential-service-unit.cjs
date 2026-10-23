"use strict";
// Actual Service lifecycle/auth/socket and AES files; the positive physical
// writer authority is explicitly controlled. This is not a real Host/model run.
const assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path"), net = require("node:net");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { ensureCredential } = require("../app/agent-service/external-plugin-adapter-auth");
const results = [], mark = name => results.push({ name, status: "PASS" });
const deferred = () => { let resolve; const promise = new Promise(next => { resolve = next; }); return { resolve, promise }; };
function storage() {
  const key = crypto.randomBytes(32); let decryptions = 0;
  return { get decryptions() { return decryptions; }, safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString(value) { const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      return Buffer.concat([nonce, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]); },
    decryptString(bytes) { decryptions++; const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8"); },
  } };
}
async function fixture(controlled = true) {
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sgpsc-")); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "u"), cacheRoot: path.join(root, "c"), trustedRoot: root });
  const cryptoStore = storage();
  const state = { current: true, factories: 0, closed: 0, checks: 0, barrier: null };
  const service = createAgentService({ paths, safeStorage: cryptoStore.safeStorage, prewarmMcpAuth: false, parentEnv: {},
    ...(controlled ? { externalProviderWriterVerifierFactory({ paths: actualPaths, resourcesRoot }) {
      assert.equal(actualPaths, paths); assert(path.isAbsolute(resourcesRoot)); state.factories++; let current = true;
      return { async verify(writer, context) {
        state.checks++; assert(context.assertCurrent()); assert.equal(writer.operationId, context.scope.operationId);
        assert.equal(writer.requestDigest, context.scope.requestDigest);
        if (state.barrier) { state.barrier.entered.resolve(); await state.barrier.resume.promise; }
        return () => current && state.current && context.assertCurrent() === true;
      }, close() { current = false; state.closed++; state.barrier?.resume.resolve(); } };
    } } : {}),
  });
  const rpc = (name, params = {}, options = {}) => requestService(paths, { version: SERVICE_PROTOCOL_VERSION,
    token: readClientToken(paths), method: name.startsWith("service.") ? name : "external.provider.credential." + name, params,
    ...(options.id === undefined ? {} : { id: options.id }) }, { timeoutMs: 20000, ...options });
  const raw = request => new Promise((resolve, reject) => {
    const socket = net.createConnection(paths.socketPath); let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("fixture raw timeout")); }, 10000);
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n")); socket.on("data", chunk => { bytes = Buffer.concat([bytes, chunk]); });
    socket.on("error", error => { clearTimeout(timer); reject(error); });
    socket.on("end", () => { clearTimeout(timer); try { resolve(JSON.parse(bytes.toString().trim())); } catch (error) { reject(error); } });
  });
  const scope = operationId => ({ backendId: "openclaw", providerKey: "local-test", baseUrl: "https://model.invalid/v1",
    api: "openai-completions", operationId, requestDigest: crypto.createHash("sha256").update(operationId).digest("hex") });
  const writer = scoped => ({ version: 1, backendId: "openclaw", operationId: scoped.operationId, requestDigest: scoped.requestDigest,
    pid: process.pid, startIdentity: "controlled-writer-start", nonce: "a".repeat(64), generation: "controlled-generation",
    runtimeRoot: path.join(root, "controlled-runtime"), runtimeTreeSha256: "b".repeat(64),
    dataRoot: path.join(paths.stateDir, "external-plugin-host-data", "openclaw", "v1"), interpreterPath: fs.realpathSync(process.execPath),
    entryPath: path.join(root, "controlled-runtime", "openclaw.mjs"), expiresAt: Date.now() + 120000 });
  const close = async () => { state.barrier?.resume.resolve(); await service.stop({ notify: false }); fs.rmSync(root, { recursive: true, force: true }); };
  return { root, paths, service, rpc, raw, state, scope, writer, cryptoStore, close };
}
const privateKeys = ["apiKey", "credentialRef", "capability", "ownerGeneration"];
const management = value => { assert.deepEqual(Object.keys(value).sort(), ["backendId", "hasSecret", "operationId", "providerKey", "state", "version"]);
  const text = JSON.stringify(value); for (const key of privateKeys) assert(!text.includes('"' + key + '"')); };
async function main() {
  const f = await fixture();
  const secret = crypto.randomBytes(24).toString("hex");
  try {
    assert.equal(f.state.factories, 0); await f.service.start(); assert.equal(f.state.factories, 1);
    const originalService = await f.rpc("service.status"); assert.equal(originalService.healthy, true);
    mark("private verifier is created only after actual Service private roots and Store startup");
    const scope = f.scope("service-unit-original"), writer = f.writer(scope);
    for (const token of ["untrusted-file-token", ensureCredential(f.paths, "openclaw"), ensureCredential(f.paths, "hermes")]) {
      const result = await f.raw({ id: crypto.randomUUID(), version: SERVICE_PROTOCOL_VERSION, token,
        method: "external.provider.credential.prepare", params: { scope, action: "set", secret } });
      assert.equal(result.ok, false); assert.equal(result.error.code, "AUTH_FAILED");
    }
    assert.equal(f.state.checks, 0); assert.equal((await f.rpc("observe", { scope })).state, "not_found");
    mark("untrusted file token and legitimate scoped adapter tokens cannot prepare an operation or reach private writer authority");
    for (const id of ["i".repeat(129), "bad-汉", "escaped\n", 7]) {
      const result = await f.raw({ id, version: SERVICE_PROTOCOL_VERSION, token: readClientToken(f.paths),
        method: "external.provider.credential.prepare", params: { scope, action: "set", secret } });
      assert.equal(result.id, null); assert.equal(result.error.code, "EXTERNAL_PROVIDER_CREDENTIAL_RPC_INVALID");
    }
    await assert.rejects(f.rpc("prepare", { scope, action: "set", secret, writer }), { code: "EXTERNAL_PROVIDER_CREDENTIAL_RPC_INVALID" });
    const extra = await f.raw({ id: crypto.randomUUID(), version: SERVICE_PROTOCOL_VERSION, token: readClientToken(f.paths),
      method: "external.provider.credential.prepare", params: { scope, action: "set", secret }, unexpected: true });
    assert.equal(extra.error.code, "EXTERNAL_PROVIDER_CREDENTIAL_RPC_INVALID");
    assert.equal((await f.rpc("observe", { scope })).state, "not_found");
    mark("private ids and envelope/params are closed before any credential persistence");
    const prepared = await f.rpc("prepare", { scope, action: "set", secret }); management(prepared); assert.equal(prepared.state, "prepared");
    const absentProvider = { ...scope, providerKey: "other-provider" }; await assert.rejects(f.rpc("observe", { scope: absentProvider }), { code: "EXTERNAL_PROVIDER_CREDENTIAL_OPERATION_MISMATCH" });
    mark("real private operation ledger preserves exact scope and public six-field management DTO");
    const permit = await f.rpc("owner.open", { scope, holderEpoch: "service-main-epoch", writer });
    assert.deepEqual(Object.keys(permit).sort(), ["owner", "scope", "service", "version", "writer"]);
    assert.deepEqual(permit.service, Object.fromEntries(["instanceNonce", "pid", "startedAt", "protocolVersion"].map(k => [k, originalService[k]])));
    await assert.rejects(f.rpc("lease.read", { scope, owner: { ...permit.owner, capability: "f".repeat(64) }, writer }), { code: "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_FORBIDDEN" });
    const checks = f.state.checks, read = await f.rpc("lease.read", { scope, owner: permit.owner, writer });
    assert(read.envelope.apiKey === secret); assert.equal(f.state.checks, checks + 2); assert.deepEqual(read.service, permit.service);
    mark("actual Service socket returns key only under original random capability and two independently checked writer guards");
    const asserted = await f.rpc("lease.assert", { scope, owner: permit.owner, writer }); assert.equal(Object.hasOwn(asserted.envelope, "apiKey"), false);
    management(await f.rpc("observe", { scope }));
    assert.equal(typeof asserted.envelope.ownerGeneration, "string");
    mark("private assertion retains lease metadata without key; management projection omits key/reference/capability/generation");
    await f.rpc("owner.close", { owner: permit.owner });
    await assert.rejects(f.rpc("lease.read", { scope, owner: permit.owner, writer }), { code: "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_FORBIDDEN" });
    await assert.rejects(f.rpc("owner.open", { scope, holderEpoch: "service-main-epoch", writer }), { code: "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION" });
    mark("closing inflight owner retires original capability and cannot mint a replacement owner");
    await f.service.stop({ notify: false }); assert.equal(f.state.closed, 1); await f.service.start(); assert.equal(f.state.factories, 2);
    const afterRestart = await f.rpc("observe", { scope }); management(afterRestart); assert.equal(afterRestart.state, "needs_verification");
    await assert.rejects(f.rpc("lease.read", { scope, owner: permit.owner, writer }), { code: "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_FORBIDDEN" });
    await assert.rejects(f.rpc("owner.open", { scope, holderEpoch: "new-main-epoch", writer }), { code: "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION" });
    mark("actual Service restart keeps original durable unknown receipt and rejects old capability/new authorization");
    const status = await f.rpc("service.status"), impact = await f.rpc("service.stopImpact");
    await f.rpc("service.quiesceIdle", { instanceNonce: status.instanceNonce, revision: impact.revision });
    await assert.rejects(f.rpc("observe", { scope }), { code: "SERVICE_QUIESCED" });
    await assert.rejects(f.rpc("owner.open", { scope, holderEpoch: "new-main-epoch", writer }), { code: "SERVICE_QUIESCED" });
    mark("maintenance quiescence blocks all private management and owner grants");
  } finally { await f.close(); }
  const d = await fixture(false);
  try {
    await d.service.start(); const scope = d.scope("unbound-default-writer"), writer = d.writer(scope);
    await d.rpc("prepare", { scope, action: "set", secret }); const decryptions = d.cryptoStore.decryptions;
    await assert.rejects(d.rpc("owner.open", { scope, holderEpoch: "default-physical", writer }));
    assert.equal(d.cryptoStore.decryptions, decryptions); assert.equal((await d.rpc("observe", { scope })).state, "prepared");
    mark("production physical verifier denies caller-supplied unbound writer before any private key decrypt");
  } finally { await d.close(); }
  const late = await fixture();
  try {
    await late.service.start(); const scope = late.scope("late-owner-open"), writer = late.writer(scope);
    await late.rpc("prepare", { scope, action: "set", secret });
    late.state.barrier = { entered: deferred(), resume: deferred() };
    const opening = late.rpc("owner.open", { scope, holderEpoch: "late-main", writer }).then(() => "accepted", error => error.code);
    await late.state.barrier.entered.promise; await late.service.stop({ notify: false });
    assert.notEqual(await opening, "accepted"); assert.equal(late.state.closed, 1);
    await late.service.start(); late.state.barrier = null;
    assert.equal((await late.rpc("observe", { scope })).state, "needs_verification");
    mark("stop during physical await retires request and prevents any late owner/secret publication");
  } finally { await late.close(); }
  process.stdout.write(JSON.stringify({ status: "PASS", groups: results.length, results,
    boundary: "actual authenticated Service IPC/lifecycle and encrypted private files; positive writer verifier controlled, default writer reject real; no actual Host or model",
    hostStarts: 0, modelRequests: 0, userTokenReads: 0 }) + "\n");
}
main().catch(error => { process.stderr.write((error.code || "FIXTURE_ASSERTION_FAILED") + "\n" + error.stack + "\n"); process.exitCode = 1; });
