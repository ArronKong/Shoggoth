#!/usr/bin/env node
"use strict";
// Real private file-token socket, Gate, Controller and encrypted files. Physical
// writer attestation and Worker finish are controlled doubles, never a Host proof.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), net = require("node:net"), crypto = require("node:crypto");
const repo = process.env.SG_CREDENTIAL_BROKER_REPO || path.resolve(__dirname, "..");
const { createManagedOpenClawProviderCredentialBroker } = require(path.join(repo, "app/managed-openclaw-provider-credential-broker"));
const { createExternalProviderCredentialRpc } = require(path.join(repo, "app/agent-service/external-provider-credential-rpc"));
const { EncryptedSecretStore } = require(path.join(repo, "app/agent-service/encrypted-secret-store"));
const { resolveServicePaths } = require(path.join(repo, "app/agent-service/paths"));
const { requestService } = require(path.join(repo, "app/agent-service/client"));
const { SERVICE_PROTOCOL_VERSION } = require(path.join(repo, "app/agent-service/service-protocol-version"));
const PREFIX = "external.provider.credential.", roots = new Set(), tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const scope = (id, patch = {}) => ({ backendId: "openclaw", providerKey: "unit-provider", baseUrl: "https://model.example.invalid/v1",
  api: "openai-completions", operationId: id, requestDigest: sha(id), ...patch });
const writer = (s, patch = {}) => ({ version: 1, backendId: "openclaw", operationId: s.operationId, requestDigest: s.requestDigest,
  pid: 43210, startIdentity: "controlled physical writer", nonce: "a".repeat(64), generation: "controlled-generation-1",
  runtimeRoot: "/private/tmp/controlled-runtime", runtimeTreeSha256: "b".repeat(64), dataRoot: "/private/tmp/controlled-private-data",
  interpreterPath: "/private/tmp/controlled-node", entryPath: "/private/tmp/controlled-runtime/openclaw.mjs", expiresAt: Date.now() + 90000, ...patch });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const denied = (promise, code) => assert.rejects(promise, error => code === undefined || error.code === code);
async function fixture(nativeAuth = false) {
  const PREFIX = nativeAuth ? "external.provider.authProfile." : "external.provider.credential.";
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-credential-broker-")); roots.add(root); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ userDataRoot: root, stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  fs.mkdirSync(paths.runtimeDir, { mode: 0o700 });
  const token = crypto.randomBytes(32).toString("hex"); fs.writeFileSync(paths.tokenPath, token, { mode: 0o600 });
  const aesKey = crypto.randomBytes(32), state = { service: true, product: true, provider: true, encrypts: 0, decrypts: 0,
    finished: false, encryptionBarrier: null, drop: null, replyPatch: null, writers: new Map(), requests: [], timeouts: [], sockets: new Set() };
  const ownerBrand = Object.freeze({}), brands = new WeakSet([ownerBrand]);
  const modelController = { isModelOwnerCurrent: brand => state.product && brands.has(brand) };
  const service = { instanceNonce: crypto.randomBytes(24).toString("hex"), pid: process.pid, startedAt: Date.now(), protocolVersion: SERVICE_PROTOCOL_VERSION };
  const secretStore = new EncryptedSecretStore({ paths, cryptoBroker: {
    async encrypt(bytes) { state.encrypts++; if (state.encryptionBarrier) { state.encryptionBarrier.entered.resolve(); await state.encryptionBarrier.resume.promise; }
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
      return Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]); },
    async decrypt(bytes) { state.decrypts++; const cipher = crypto.createDecipheriv("aes-256-gcm", aesKey, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]); }
  }}); await secretStore.open();
  const rpc = createExternalProviderCredentialRpc({ paths, secretStore, assertServiceCurrent: () => state.service,
    ...(nativeAuth ? { namespace: "auth-profile" } : {}),
    getServiceIdentity: () => service,
    async verifyManagedWriter(value, options) {
      const expected = state.writers.get(value.operationId); options.assertCurrent();
      assert.deepEqual(value, expected, "independent controlled writer identity must match");
      if (options.phase === "settle") assert.equal(state.finished, true, "verified Worker.finish is mandatory");
      else assert.equal(state.finished, false, "retired physical writer cannot read or reopen");
      return () => state.service && JSON.stringify(state.writers.get(value.operationId)) === JSON.stringify(value)
        && (options.phase === "settle" ? state.finished : !state.finished);
    }
  }); await rpc.open();
  const server = net.createServer(socket => {
    state.sockets.add(socket); socket.on("close", () => state.sockets.delete(socket)); socket.on("error", () => {});
    let bytes = ""; socket.on("data", chunk => { bytes += chunk.toString("utf8"); if (!bytes.includes("\n")) return;
      socket.removeAllListeners("data"); (async () => {
        let request; try { request = JSON.parse(bytes); assert.equal(request.token, token); assert.equal(request.version, SERVICE_PROTOCOL_VERSION);
          // Record only the method, request ID and exact property names; no token
          // or secret/request body is retained in evidence.
          state.requests.push({ method: request.method === "service.status" ? request.method : request.method.slice(PREFIX.length), id: request.id, keys: Object.keys(request.params) });
          const context = rpc.createRequestContext(() => state.service);
          let result = request.method === "service.status"
            ? { ...service, healthy: true, maintenanceQuiesced: false }
            : await rpc.dispatch(request.method, request.params, context);
          if (state.drop === request.method.slice(PREFIX.length)) { state.drop = null; socket.destroy(); return; }
          if (state.replyPatch) { const patch = state.replyPatch; state.replyPatch = null; result = patch(result); }
          socket.end(JSON.stringify({ id: request.id, ok: true, result }) + "\n");
        } catch (error) { if (!socket.destroyed) socket.end(JSON.stringify({ id: request?.id, ok: false, error: { code: error.code || "CONTROLLED_WRITER_REJECTED", message: "private controlled rejection" } }) + "\n"); }
      })().catch(() => socket.destroy());
    });
  }); await new Promise((resolve, reject) => { server.once("error", reject); server.listen(paths.socketPath, resolve); }); fs.chmodSync(paths.socketPath, 0o600);
  const makeBroker = () => createManagedOpenClawProviderCredentialBroker({ paths, modelController,
    requestService(p, req, options) { state.timeouts.push(options.timeoutMs); return requestService(p, req, options); } });
  const broker = makeBroker(), signal = new AbortController();
  const contextFor = b => b.createContext({ modelOwner: ownerBrand, signal: signal.signal, nativeAuth,
    assertProviderLease() { if (!state.provider) throw new Error("controlled provider retired"); } });
  const context = contextFor(broker);
  const call = (method, params) => rpc.dispatch(PREFIX + method, params, rpc.createRequestContext(() => state.service));
  const prepare = async (s, action = "set", secret = "synthetic-test-key-1", ctx = context, b = broker) => {
    state.finished = false; const w = writer(s); state.writers.set(s.operationId, w);
    return b.prepareAndOpen({ scope: s, action, ...(action === "set" ? { secret } : {}), writer: w }, ctx);
  };
  const read = (p, phase) => call("lease.read", { scope: p.scope, owner: p.owner, writer: p.writer, ...(phase ? { phase } : {}) });
  const finish = async (p, outcome = "applied", b = broker, ctx = context) => {
    state.finished = true;
    const receipt = await call("lease.settle", { scope: p.scope, owner: p.owner, writer: p.writer, outcome });
    assert.deepEqual(receipt.service, p.service); assert.equal(receipt.envelope.state, outcome);
    return b.observeFinished(p, outcome, ctx, true);
  };
  return { root, paths, state, service, modelController, ownerBrand, broker, context, signal, secretStore, call, prepare, read, finish, makeBroker, contextFor,
    async close() { broker.retire(); state.encryptionBarrier?.resume.resolve(); for (const socket of state.sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve)); await rpc.close(); await secretStore.close(); aesKey.fill(0);
      fs.rmSync(root, { recursive: true, force: true }); roots.delete(root); }
  };
}

test("actual private socket prepares encrypted key; Worker settles and Main only observes original terminal then closes", async () => {
  const f = await fixture(); try {
    const p = await f.prepare(scope("initial-set")); assert.deepEqual(Object.keys(p), ["version", "owner", "scope", "service", "writer"]);
    assert.equal(f.state.encrypts, 1); assert.equal(JSON.stringify(p).includes("synthetic-test-key-1"), false);
    assert.deepEqual(f.state.requests.map(x => x.method), ["observe", "prepare", "owner.open"]);
    assert(f.state.timeouts.every(x => x === 45000));
    assert.equal((fs.statSync(f.paths.encryptedSecretsPath).mode & 0o777), 0o600);
    assert.equal(fs.readFileSync(f.paths.encryptedSecretsPath, "utf8").includes("synthetic-test-key-1"), false);
    const envelope = await f.read(p); assert.equal(envelope.envelope.apiKey, "synthetic-test-key-1");
    const dto = await f.finish(p); assert.equal(dto.state, "applied"); assert.equal(dto.hasSecret, true);
    assert.deepEqual(f.state.requests.slice(-4).map(x => x.method), ["service.status", "observe", "service.status", "owner.close"]);
    assert.equal(f.state.requests.some(x => ["lease.read", "lease.assert", "lease.settle"].includes(x.method)), false);
    await denied(f.broker.observeFinished(p, "applied", f.context, true), "MANAGED_CREDENTIAL_PERMIT_RETIRED");
  } finally { await f.close(); }
});

test("native auth-profile IPC uses an independent namespace and no fabricated endpoint", async () => {
  const f = await fixture(true);
  try {
    const { nativeAuthProviderScope } = require("../app/managed-openclaw-auth-profile-scope");
    const s = { ...nativeAuthProviderScope({ kind: "update-provider", providerKey: "builtin", agentId: "main" }, {}),
      operationId: "native-scope", requestDigest: sha("native-scope") };
    const permit = await f.prepare(s);
    assert.equal(permit.scope.baseUrl, null);
    assert.equal((await f.read(permit)).envelope.apiKey, "synthetic-test-key-1");
    await f.finish(permit);
    assert.equal(f.state.requests.some(row => row.method === "prepare"), true);
  } finally { await f.close(); }
});

test("rotation and clear use immutable original operation and candidate/previous encrypted bindings", async () => {
  const f = await fixture(); try {
    let p = await f.prepare(scope("rotation-original")); await f.read(p); await f.finish(p);
    p = await f.prepare(scope("rotation-next"), "set", "synthetic-rotated-key-2");
    assert.equal((await f.read(p)).envelope.apiKey, "synthetic-rotated-key-2"); // gitleaks:allow -- synthetic fixture key
    assert.equal((await f.read(p, "previous")).envelope.apiKey, "synthetic-test-key-1"); await f.finish(p);
    p = await f.prepare(scope("clear-current"), "clear"); const cleared = (await f.read(p)).envelope;
    assert.equal(cleared.action, "clear"); assert.equal(Object.hasOwn(cleared, "apiKey"), false);
    assert.equal((await f.read(p, "previous")).envelope.apiKey, "synthetic-rotated-key-2"); // gitleaks:allow -- synthetic fixture key
    assert.equal((await f.finish(p)).hasSecret, false);
  } finally { await f.close(); }
});

test("new endpoint candidate retains exact old credential domain for compensated previous phase", async () => {
  const f = await fixture(); try {
    let p = await f.prepare(scope("domain-original")); await f.read(p); await f.finish(p);
    const target = scope("domain-change", { baseUrl: "https://new.example.invalid/v1", api: "openai-responses" });
    p = await f.prepare(target, "set", "synthetic-new-domain-key"); await f.read(p);
    const old = (await f.read(p, "previous")).envelope;
    assert.equal(old.previousScope.baseUrl, scope("unused").baseUrl); assert.equal(old.previousScope.api, "openai-completions");
    assert.equal(old.apiKey, "synthetic-test-key-1"); assert.equal((await f.finish(p, "compensated")).state, "compensated");
    assert.equal((await f.broker.status(scope("status-old"), f.context)).hasSecret, true);
  } finally { await f.close(); }
});

for (const lost of ["prepare", "owner.open"]) test("lost " + lost + " ACK only observes original operation; no new prepare or owner", async () => {
  const f = await fixture(); try {
    const s = scope("lost-" + lost.replace(".", "-")); f.state.drop = lost;
    await denied(f.prepare(s)); const encrypted = f.state.encrypts;
    const before = f.state.requests.filter(x => x.method === "owner.open").length;
    const w = f.state.writers.get(s.operationId);
    await denied(f.broker.prepareAndOpen({ scope: s, action: "set", secret: "synthetic-test-key-1", writer: w }, f.context), "MANAGED_CREDENTIAL_NEEDS_VERIFICATION");
    assert.equal(f.state.encrypts, encrypted); assert.equal(f.state.requests.filter(x => x.method === "owner.open").length, before);
    assert.equal(f.state.requests.filter(x => x.method === "prepare").length, 1);
    await denied(f.broker.prepareAndOpen({ scope: s, action: "set", secret: "different-test-key", writer: w }, f.context), "MANAGED_CREDENTIAL_OPERATION_CONFLICT");
    const second = f.makeBroker(); try { await denied(second.prepareAndOpen({ scope: s, action: "set", secret: "synthetic-test-key-1", writer: w }, f.contextFor(second)), "MANAGED_CREDENTIAL_NEEDS_VERIFICATION"); }
    finally { second.retire(); }
    assert.equal(f.state.requests.filter(x => x.method === "prepare").length, 1);
  } finally { await f.close(); }
});

test("cancel during actual encrypted prepare discards late authorization and cannot mint owner", async () => {
  const f = await fixture(); try {
    f.state.encryptionBarrier = { entered: deferred(), resume: deferred() };
    const pending = f.prepare(scope("canceled-prepare")); const rejected = denied(pending);
    await f.state.encryptionBarrier.entered.promise; f.signal.abort(); f.state.encryptionBarrier.resume.resolve(); await rejected;
    await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(f.state.requests.some(x => x.method === "owner.open"), false);
    assert.equal(f.state.requests.filter(x => x.method === "prepare").length, 1);
    await denied(f.broker.list(f.context), "MANAGED_CREDENTIAL_BROKER_RETIRED");
  } finally { await f.close(); }
});

test("opaque product owner and provider lease retirement reject before and after each awaited RPC", async () => {
  const f = await fixture(); try {
    assert.throws(() => f.broker.createContext({ modelOwner: {}, assertProviderLease() {} }), { code: "MANAGED_CREDENTIAL_MODEL_OWNER_RETIRED" });
    assert.throws(() => f.broker.createContext({ modelOwner: f.ownerBrand, assertProviderLease() { return Promise.resolve(true); } }));
    f.state.encryptionBarrier = { entered: deferred(), resume: deferred() };
    const pending = f.prepare(scope("retired-prepare")); const rejected = denied(pending, "MANAGED_CREDENTIAL_MODEL_OWNER_RETIRED");
    await f.state.encryptionBarrier.entered.promise; f.state.product = false; f.state.encryptionBarrier.resume.resolve(); await rejected;
    assert.equal(f.state.requests.some(x => x.method === "owner.open"), false);
    f.state.product = true; f.state.provider = false; await denied(f.broker.list(f.context), "MANAGED_CREDENTIAL_PROVIDER_LEASE_RETIRED");
  } finally { await f.close(); }
});

test("raw renewal precedes Service renew; exact restart advances same owner with rotated capability and rejects old permit", async () => {
  const f = await fixture(); try {
    let p = await f.prepare(scope("renew-advance"));
    const renewed = { ...p.writer, expiresAt: p.writer.expiresAt + 1000 }; f.state.writers.set(p.scope.operationId, renewed);
    const p2 = await f.broker.renew(p, renewed, f.context); assert.deepEqual(p2.owner, p.owner);
    await denied(f.broker.renew(p, renewed, f.context), "MANAGED_CREDENTIAL_PERMIT_RETIRED");
    const advanced = { ...p2.writer, pid: p2.writer.pid + 1, startIdentity: "controlled restart", nonce: "c".repeat(64), generation: "controlled-generation-2" };
    f.state.writers.set(p.scope.operationId, advanced); p = await f.broker.advance(p2, advanced, f.context);
    assert.equal(p.owner.ownerId, p2.owner.ownerId); assert.notEqual(p.owner.capability, p2.owner.capability);
    await denied(f.read(p2)); await f.read(p); await f.finish(p);
  } finally { await f.close(); }
});

test("unverified finish sends no request; lost terminal observation ACK cannot close or reauthorize the owner", async () => {
  const f = await fixture(); try {
    const p = await f.prepare(scope("settle-unknown")); await f.read(p);
    await denied(f.broker.observeFinished(p, "applied", f.context, false), "MANAGED_CREDENTIAL_FINISH_UNVERIFIED");
    assert.equal(f.state.requests.some(x => x.method === "lease.settle"), false);
    f.state.finished = true;
    await f.call("lease.settle", { scope: p.scope, owner: p.owner, writer: p.writer, outcome: "applied" });
    f.state.drop = "observe"; await denied(f.broker.observeFinished(p, "applied", f.context, true));
    await denied(f.broker.observeFinished(p, "applied", f.context, true), "MANAGED_CREDENTIAL_PERMIT_RETIRED");
    assert.equal((await f.broker.observe(p.scope, f.context)).state, "applied");
    assert.equal(f.state.requests.filter(x => x.method === "lease.settle").length, 0);
    assert.equal(f.state.requests.some(x => x.method === "owner.close"), false);
  } finally { await f.close(); }
});

test("same immutable concurrent preparation reuses one RPC flight; forged permit and bad service reply never gain authority", async () => {
  const f = await fixture(); try {
    f.state.encryptionBarrier = { entered: deferred(), resume: deferred() };
    const s = scope("single-flight"), first = f.prepare(s); await f.state.encryptionBarrier.entered.promise;
    const next = f.broker.prepareAndOpen({ scope: s, action: "set", secret: "synthetic-test-key-1", writer: f.state.writers.get(s.operationId) }, f.context);
    f.state.encryptionBarrier.resume.resolve(); const p = await first; assert.equal(await next, p);
    assert.equal(f.state.requests.filter(x => x.method === "prepare").length, 1);
    await denied(f.broker.observeFinished(JSON.parse(JSON.stringify(p)), "applied", f.context, true), "MANAGED_CREDENTIAL_PERMIT_RETIRED");
    await f.read(p);
    f.state.replyPatch = result => ({ ...result, pid: result.pid + 1 });
    f.state.finished = true;
    await f.call("lease.settle", { scope: p.scope, owner: p.owner, writer: p.writer, outcome: "applied" });
    await denied(f.broker.observeFinished(p, "applied", f.context, true), "MANAGED_CREDENTIAL_SERVICE_CHANGED");
    assert.equal(f.state.requests.some(x => x.method === "owner.close"), false);
  } finally { await f.close(); }
});

module.exports = { fixture, scope, writer };
if (require.main === module) (async () => {
  const passed = []; for (const { name, fn } of tests) { await fn(); passed.push(name); }
  console.log(JSON.stringify({ verified: true, passed: passed.length, boundary: "real private IPC/Gate/Controller/encrypted storage; physical writer and Worker finish are controlled doubles; no actual Host/model/remote", tests: passed }));
})().catch(error => { for (const root of roots) { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }
  console.error(JSON.stringify({ verified: false, code: error.code || "LOCAL_BROKER_UNIT_FAILED", message: error.message, stack: error.stack })); process.exitCode = 1; });
