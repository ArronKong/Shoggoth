"use strict";
// Writer verification below is a controlled local registry, not PID/fence/Host
// verification. The actual encrypted Store and private filesystem are exercised.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const repo = process.env.EXTERNAL_PROVIDER_RPC_FIXTURE_REPO || path.resolve(__dirname, "..");
const { resolveServicePaths } = require(path.join(repo, "app/agent-service/paths"));
const { EncryptedSecretStore } = require(path.join(repo, "app/agent-service/encrypted-secret-store"));
const { createExternalProviderCredentialRpc, EXTERNAL_PROVIDER_CREDENTIAL_IPC_METHODS } = require(path.join(repo, "app/agent-service/external-provider-credential-rpc"));
const { sameExternalProviderWriter } = require(path.join(repo, "app/agent-service/external-provider-credential-writer"));
const { SERVICE_PROTOCOL_VERSION } = require(path.join(repo, "app/agent-service/service-protocol-version"));
const PREFIX = "external.provider.credential.", tests = [], roots = new Set();
const test = (name, action) => tests.push({ name, action });
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const scope = (operationId, patch = {}) => ({ backendId: "openclaw", providerKey: "fixture-provider", baseUrl: "https://model.invalid/v1",
  api: "openai-completions", operationId, requestDigest: digest(operationId), ...patch });
const provider = input => Object.fromEntries(["backendId", "providerKey", "baseUrl", "api"].map(key => [key, input[key]]));
const deferred = () => { let resolve; const promise = new Promise(next => { resolve = next; }); return { promise, resolve }; };
const barrier = () => ({ entered: deferred(), resume: deferred() });
const rejected = (promise, code) => assert.rejects(promise, error => code === undefined || (Array.isArray(code) ? code : [code]).includes(error.code));
function dto(value, canaries = []) {
  assert.deepEqual(Object.keys(value), ["version", "backendId", "providerKey", "state", "hasSecret", "operationId"]);
  const text = JSON.stringify(value); for (const field of ["apiKey", "credentialRef", "Revision", "capability", "ownerGeneration", "expiresAt", "previousScope", ...canaries])
    assert.equal(text.includes(field), false);
}
function permit(value, input, identity) {
  assert.deepEqual(Object.keys(value), ["version", "owner", "scope", "service", "writer"]);
  assert.deepEqual(Object.keys(value.owner), ["ownerId", "capability"]); assert.deepEqual(value.scope, input); assert.deepEqual(value.service, identity);
  assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(value.owner), true);
  assert.match(value.owner.capability, /^[a-f0-9]{64}$/u); return value;
}
async function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-external-provider-rpc-final-")); roots.add(root); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const key = crypto.randomBytes(32), cryptoState = { locked: false, decryptCalls: 0, encryptCalls: 0, decryptBarrier: null, encryptBarrier: null };
  const cryptoBroker = {
    async encrypt(bytes) { cryptoState.encryptCalls += 1; if (cryptoState.encryptBarrier) { cryptoState.encryptBarrier.entered.resolve(); await cryptoState.encryptBarrier.resume.promise; }
      if (cryptoState.locked) throw Error("locked");
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]); },
    async decrypt(bytes) { cryptoState.decryptCalls += 1; if (cryptoState.decryptBarrier) { cryptoState.decryptBarrier.entered.resolve(); await cryptoState.decryptBarrier.resume.promise; }
      if (cryptoState.locked) throw Error("locked"); const cipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]); },
  };
  const state = { current: true, now: Date.now(), identity: { instanceNonce: crypto.randomBytes(24).toString("hex"),
    pid: process.pid, startedAt: Date.now(), protocolVersion: SERVICE_PROTOCOL_VERSION }, verifierMode: "guard", verifyBarrier: null,
    failVerifierCall: null, sequence: 0 };
  const physical = new Map(), initialWriters = new Map(), verifyCalls = [];
  const secretStore = new EncryptedSecretStore({ paths, cryptoBroker }); await secretStore.open();
  const value = { root, paths, key, cryptoState, state, physical, verifyCalls, secretStore, storeGetCalls: 0 };
  const actualGet = secretStore.get.bind(secretStore); secretStore.get = (...args) => { value.storeGetCalls += 1; return actualGet(...args); };
  value.writer = (input, patch = {}) => {
    const number = ++state.sequence, runtimeRoot = path.join(root, "controlled-runtime");
    const writer = { version: 1, backendId: "openclaw", operationId: input.operationId, requestDigest: input.requestDigest,
      pid: process.pid + number, startIdentity: "controlled-fixture-start-" + number, nonce: digest("nonce-" + number),
      generation: "controlled-generation-" + number, runtimeRoot, runtimeTreeSha256: digest("controlled-runtime-tree"),
      dataRoot: path.join(root, "controlled-data"), interpreterPath: "/usr/bin/false", entryPath: path.join(runtimeRoot, "openclaw.mjs"),
      expiresAt: Date.now() + 120000, ...patch };
    physical.set(writer.nonce, { writer: { ...writer }, live: true, paused: true, deadline: writer.expiresAt }); return writer;
  };
  value.initialWriter = input => { if (!initialWriters.has(input.operationId)) initialWriters.set(input.operationId, value.writer(input)); return initialWriters.get(input.operationId); };
  value.options = { paths, secretStore, assertServiceCurrent: () => state.current, now: () => state.now,
    getServiceIdentity: () => state.identity,
    async verifyManagedWriter(writer, context) {
      verifyCalls.push({ phase: context.phase, operationId: context.scope.operationId }); context.assertCurrent();
      if (typeof state.verifyHook === "function") await state.verifyHook(writer, context, verifyCalls.length);
      if (state.failVerifierCall === verifyCalls.length) return true;
      if (state.verifyBarrier) { state.verifyBarrier.entered.resolve(); await state.verifyBarrier.resume.promise; }
      if (state.verifierMode === "boolean") return true;
      if (state.verifierMode === "async-guard") return () => Promise.resolve(true);
      if (state.verifierMode === "throw") throw Object.assign(Error("controlled verifier failed"), { code: "CONTROLLED_WRITER_REJECTED" });
      return () => {
        context.assertCurrent(); const actual = physical.get(writer.nonce);
        if (!actual || !actual.live || !sameExternalProviderWriter(actual.writer, writer) || actual.deadline < writer.expiresAt
          || writer.expiresAt <= Date.now() || writer.operationId !== context.scope.operationId || writer.requestDigest !== context.scope.requestDigest) return false;
        if (context.phase === "advance" && (!context.previousWriter || physical.get(context.previousWriter.nonce)?.live !== false)) return false;
        return actual.paused === !(context.phase === "settle" && context.outcome !== "needs_verification"
          || context.phase === "terminal-observe" && context.writerState === "resumed");
      };
    },
  };
  value.rpc = createExternalProviderCredentialRpc(value.options); await value.rpc.open();
  value.context = () => { const current = { live: true }; return { state: current, handle: value.rpc.createRequestContext(() => current.live) }; };
  value.management = value.context();
  value.call = (method, params = {}, context = value.management.handle) => value.rpc.dispatch(PREFIX + method, params, context);
  value.prepare = (input, action = "set", secret = "fixture-private-candidate-key") => value.call("prepare", { scope: input, action, ...(action === "set" ? { secret } : {}) });
  value.owner = (input, writer = value.initialWriter(input), holderEpoch = "fixture-main-holder") => value.call("owner.open", { scope: input, holderEpoch, writer });
  value.read = (input, granted, extra = {}, context) => value.call("lease.read", { scope: input, owner: granted.owner, writer: granted.writer, ...extra }, context);
  value.assert = (input, granted, extra = {}) => value.call("lease.assert", { scope: input, owner: granted.owner, writer: granted.writer, ...extra });
  value.settle = (input, granted, outcome = "applied") => { physical.get(granted.writer.nonce).paused = outcome === "needs_verification";
    return value.call("lease.settle", { scope: input, owner: granted.owner, writer: granted.writer, outcome }); };
  value.terminal = (input, granted, outcome = "applied", writerState = "paused", extra = {}) => value.call("lease.terminal.observe",
    { scope: input, owner: granted.owner, writer: granted.writer, outcome, writerState, ...extra });
  value.realDecryptNext = async () => { await secretStore.close(); cryptoState.locked = true; try { await secretStore.open(); } finally { cryptoState.locked = false; } };
  value.ledger = () => { const file = path.join(paths.stateDir, "external-provider-credentials.json"); return fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8")) : { bindings: {}, operations: {} }; };
  value.close = async () => { cryptoState.decryptBarrier?.resume.resolve(); cryptoState.encryptBarrier?.resume.resolve(); state.verifyBarrier?.resume.resolve(); await value.rpc.close(); await secretStore.close();
    key.fill(0); fs.rmSync(root, { recursive: true, force: true }); roots.delete(root); };
  return value;
}
async function complete(value, input, action = "set", secret = "fixture-old-private-key", outcome = "applied") {
  dto(await value.prepare(input, action, secret)); const granted = await value.owner(input), result = await value.read(input, granted);
  dto((await value.settle(input, granted, outcome)).envelope); await value.call("owner.close", { owner: granted.owner }); return result;
}

test("mandatory Service identity + physical verifier return strict private guard, never boolean or Promise", async () => {
  const value = await fixture(); try {
    assert.equal(EXTERNAL_PROVIDER_CREDENTIAL_IPC_METHODS.length, 12);
    for (const method of EXTERNAL_PROVIDER_CREDENTIAL_IPC_METHODS) assert.equal(value.rpc.isMethod(method), true);
    for (const field of ["getServiceIdentity", "verifyManagedWriter", "assertServiceCurrent"]) {
      const options = { ...value.options }; delete options[field]; assert.throws(() => createExternalProviderCredentialRpc(options), error => error.code === "EXTERNAL_PROVIDER_CREDENTIAL_RPC_OPTIONS_INVALID");
    }
    const input = scope("mandatory-writer"); await value.prepare(input);
    for (const mode of ["boolean", "async-guard", "throw"]) { value.state.verifierMode = mode; await rejected(value.owner(input)); }
    value.state.verifierMode = "guard"; permit(await value.owner(input), input, value.state.identity); assert.equal(value.storeGetCalls, 0);
  } finally { await value.close(); }
});

test("real encrypted 0600 files and exact six-field management DTO never expose material, ref or owner", async () => {
  const value = await fixture(); try {
    const input = scope("management-projection"), key = "fixture-management-synthetic-canary"; dto(await value.prepare(input, "set", key), [key]);
    const granted = permit(await value.owner(input), input, value.state.identity);
    const read = await value.read(input, granted); assert.deepEqual(Object.keys(read), ["service", "envelope"]);
    assert.deepEqual(read.service, value.state.identity); assert.equal(read.envelope.apiKey, key);
    assert.equal(Object.hasOwn(read.envelope, "credentialRef"), false); assert.equal(Object.hasOwn((await value.assert(input, granted)).envelope, "apiKey"), false);
    for (const file of [value.paths.encryptedSecretsPath, path.join(value.paths.stateDir, "external-provider-credentials.json")]) {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.readFileSync(file, "utf8").includes(key), false);
    }
    for (const result of [await value.call("status", { scope: provider(input) }), await value.call("observe", { scope: input }), ...(await value.call("list"))])
      dto(result, [key, granted.owner.capability, granted.writer.nonce]);
  } finally { await value.close(); }
});

test("local context brands and hostile own-data shapes reject before cipher write; getters are never invoked", async () => {
  const value = await fixture(); try {
    const input = scope("malicious-shape"); let getterCalls = 0; const getter = { action: "set", secret: "fixture-getter-key" };
    Object.defineProperty(getter, "scope", { enumerable: true, get() { getterCalls += 1; return input; } });
    const inherited = Object.assign(Object.create({ claimed: true }), { scope: input, action: "set", secret: "fixture-inherited-key" });
    const nullProto = Object.assign(Object.create(null), { scope: input, action: "set", secret: "fixture-null-proto-key" });
    const cycle = {}; cycle.self = cycle;
    for (const params of [getter, inherited, nullProto, { scope: input, action: "set", secret: () => true }, { scope: input, action: "preserve", extra: true },
      { scope: input, action: "set", secret: "fixture-symbol-key", [Symbol("extra")]: true }, { scope: input, action: "preserve", extra: cycle }])
      await rejected(value.call("prepare", params));
    for (const fake of [{}, { assertCurrent: () => true }, Object.create(value.management.handle), null, "claimed-file-token"])
      await rejected(value.call("list", {}, fake), "EXTERNAL_PROVIDER_CREDENTIAL_RPC_RETIRED");
    assert.throws(() => value.rpc.createRequestContext(() => Promise.resolve(true)));
    assert.equal(getterCalls, 0); assert.equal(value.cryptoState.encryptCalls, 0); assert.equal(value.secretStore.listMetadata().length, 0);
  } finally { await value.close(); }
});

test("escaped wire-size budget rejects before ciphertext or operation persistence", async () => {
  const value = await fixture(); try {
    await rejected(value.prepare(scope("escaped-frame"), "set", "\n".repeat(40000)), "EXTERNAL_PROVIDER_CREDENTIAL_FRAME_TOO_LARGE");
    await rejected(value.prepare(scope("raw-frame"), "set", "x".repeat(65536)), "EXTERNAL_PROVIDER_CREDENTIAL_RPC_INVALID");
    assert.equal(value.cryptoState.encryptCalls, 0); assert.equal(value.secretStore.listMetadata().length, 0);
    assert.equal(Object.keys(value.ledger().operations).length, 0);
    dto(await value.call("observe", { scope: scope("escaped-frame") }));
    assert.equal((await value.call("observe", { scope: scope("escaped-frame") })).state, "not_found");
  } finally { await value.close(); }
});

test("prepared owner mint is idempotent only for exact original holder/writer; concurrent foreign holder gets no cap", async () => {
  const value = await fixture(); try {
    const input = scope("owner-idempotence"); await rejected(value.owner(input), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    await value.prepare(input); const [a, b] = await Promise.all([value.owner(input), value.owner(input)]); assert.deepEqual(a, b);
    await rejected(value.owner(input, a.writer, "foreign-holder"), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_SCOPE_MISMATCH");
    await rejected(value.owner(input, value.writer(input)), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_SCOPE_MISMATCH");
    const raced = scope("raced-holders", { providerKey: "fixture-second-provider" }); await value.prepare(raced);
    const outcomes = await Promise.allSettled([value.owner(raced, value.initialWriter(raced), "holder-a"), value.owner(raced, value.initialWriter(raced), "holder-b")]);
    assert.equal(outcomes.filter(row => row.status === "fulfilled").length, 1); assert.equal(outcomes.filter(row => row.status === "rejected").length, 1);
  } finally { await value.close(); }
});

test("guessed cap, original op/digest/provider/endpoint/API, physical owner and caller ref cannot reach Store.get", async () => {
  const value = await fixture(); try {
    const input = scope("scope-bound"); await value.prepare(input); const granted = await value.owner(input), count = value.storeGetCalls;
    await rejected(value.read(input, { ...granted, owner: { ...granted.owner, capability: "0".repeat(64) } }), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_FORBIDDEN");
    for (const patch of [{ operationId: "other-op" }, { requestDigest: digest("other-digest") }, { providerKey: "other-provider" },
      { baseUrl: "https://foreign.invalid/v1" }, { api: "anthropic-messages" }])
      await rejected(value.read({ ...input, ...patch }, granted), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_SCOPE_MISMATCH");
    for (const patch of [{ pid: granted.writer.pid + 1000 }, { nonce: digest("foreign-nonce") }, { generation: "foreign-generation" },
      { startIdentity: "foreign-start" }, { dataRoot: path.join(value.root, "foreign-data") }, { interpreterPath: "/bin/false" },
      { runtimeTreeSha256: digest("foreign-tree") }])
      await rejected(value.read(input, { ...granted, writer: { ...granted.writer, ...patch } }), "EXTERNAL_PROVIDER_CREDENTIAL_WRITER_CHANGED");
    for (const extra of [{ credentialRef: "claimed" }, { historyId: "claimed" }, { phase: "rollback" }, { recovery: "yes" }]) await rejected(value.read(input, granted, extra));
    await rejected(value.call("lease.read", { scope: input, owner: granted.owner }));
    assert.equal(value.storeGetCalls, count);
  } finally { await value.close(); }
});

test("wire inputs are captured before asynchronous writer verification and retired request cannot mint late owner", async () => {
  const value = await fixture(); try {
    const input = scope("capture-writer"), original = { ...input }; await value.prepare(input);
    const writer = value.initialWriter(input), originalWriter = { ...writer }, held = barrier(); value.state.verifyBarrier = held;
    const params = { scope: input, holderEpoch: "fixture-captured-holder", writer }, pending = value.call("owner.open", params);
    await held.entered.promise; input.operationId = "mutated-operation"; input.requestDigest = digest("mutated"); writer.nonce = digest("mutated-writer");
    params.holderEpoch = "mutated-holder"; held.resume.resolve(); const granted = await pending; value.state.verifyBarrier = null;
    assert.deepEqual(granted.scope, original); assert.deepEqual(granted.writer, originalWriter);
    assert.equal((await value.call("observe", { scope: scope("mutated-operation") })).state, "not_found");
    const next = scope("retired-mint", { providerKey: "fixture-another-provider" }); await value.prepare(next);
    const context = value.context(), waiting = barrier(); value.state.verifyBarrier = waiting;
    const mint = value.call("owner.open", { scope: next, holderEpoch: "fixture-holder", writer: value.writer(next) }, context.handle);
    await waiting.entered.promise; context.state.live = false; waiting.resume.resolve(); await rejected(mint, "EXTERNAL_PROVIDER_CREDENTIAL_RPC_RETIRED");
    value.state.verifyBarrier = null; permit(await value.owner(next), next, value.state.identity);
  } finally { await value.close(); }
});

test("close during actual decrypt rejects late key and closed inflight cannot mint replacement owner", async () => {
  const value = await fixture(); try {
    const input = scope("closed-decrypt"); await value.prepare(input); const granted = await value.owner(input); await value.realDecryptNext();
    const held = barrier(); value.cryptoState.decryptBarrier = held; let published = 0;
    const pending = value.read(input, granted).then(result => { if (result.envelope.apiKey) published += 1; return result; });
    await held.entered.promise; const closed = await value.call("owner.close", { owner: granted.owner }); assert.deepEqual(closed, { version: 1, closed: true });
    held.resume.resolve(); await rejected(pending, "EXTERNAL_PROVIDER_CREDENTIAL_RETIRED"); assert.equal(published, 0);
    value.cryptoState.decryptBarrier = null; assert.ok(value.cryptoState.decryptCalls > 0);
    assert.equal((await value.call("observe", { scope: input })).state, "inflight");
    await rejected(value.owner(input, granted.writer, "replacement-holder"), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    await rejected(value.read(input, granted), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_FORBIDDEN");
  } finally { await value.close(); }
});

test("physical writer and authenticated request retirement during decrypt produce zero late material", async () => {
  for (const retirement of ["physical", "request"]) {
    const value = await fixture(); try {
      const input = scope("late-" + retirement); await value.prepare(input); const granted = await value.owner(input); await value.realDecryptNext();
      const context = value.context(), held = barrier(); value.cryptoState.decryptBarrier = held; let published = 0;
      const pending = value.read(input, granted, {}, context.handle).then(result => { if (result.envelope.apiKey) published += 1; return result; });
      await held.entered.promise;
      if (retirement === "physical") value.physical.get(granted.writer.nonce).live = false; else context.state.live = false;
      held.resume.resolve(); await rejected(pending, "EXTERNAL_PROVIDER_CREDENTIAL_RETIRED");
      assert.equal(published, 0); assert.ok(value.cryptoState.decryptCalls > 0);
    } finally { await value.close(); }
  }
});

test("read cannot extend authority; only exact trusted renewal updates deadline and rewind is rejected", async () => {
  const value = await fixture(); try {
    const input = scope("renewal"), deadline = Date.now() + 10000; await value.prepare(input);
    const granted = await value.owner(input, value.writer(input, { expiresAt: deadline }));
    const extended = { ...granted.writer, expiresAt: Date.now() + 60000 }; value.physical.get(extended.nonce).deadline = extended.expiresAt;
    const before = await value.read(input, { ...granted, writer: extended }); assert.ok(before.envelope.expiresAt <= deadline);
    value.state.verifierMode = "boolean";
    await rejected(value.call("owner.renew", { scope: input, owner: granted.owner, writer: extended }), "EXTERNAL_PROVIDER_CREDENTIAL_WRITER_UNVERIFIED");
    value.state.verifierMode = "guard";
    const renewed = await value.call("owner.renew", { scope: input, owner: granted.owner, writer: extended }); assert.deepEqual(renewed.owner, granted.owner);
    assert.equal(renewed.writer.expiresAt, extended.expiresAt); assert.ok((await value.read(input, renewed)).envelope.expiresAt > deadline);
    await rejected(value.call("owner.renew", { scope: input, owner: renewed.owner, writer: { ...renewed.writer, expiresAt: deadline } }), "EXTERNAL_PROVIDER_CREDENTIAL_DEADLINE_REWIND");
    value.state.now = extended.expiresAt; const getCount = value.storeGetCalls;
    await rejected(value.read(input, renewed), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_RETIRED"); assert.equal(value.storeGetCalls, getCount);
  } finally { await value.close(); }
});

test("advance requires old writer actual exit and rotates cap; new cap rejects old physical identity", async () => {
  const value = await fixture(); try {
    const input = scope("advance-exact"); await value.prepare(input); const original = await value.owner(input), next = value.writer(input);
    await rejected(value.call("owner.advance", { scope: input, owner: original.owner, writer: next }), "EXTERNAL_PROVIDER_CREDENTIAL_WRITER_UNVERIFIED");
    value.physical.get(original.writer.nonce).live = false;
    const advanced = await value.call("owner.advance", { scope: input, owner: original.owner, writer: next });
    assert.equal(advanced.owner.ownerId, original.owner.ownerId); assert.notEqual(advanced.owner.capability, original.owner.capability);
    await rejected(value.read(input, original), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_FORBIDDEN");
    await rejected(value.read(input, { ...advanced, writer: original.writer }), "EXTERNAL_PROVIDER_CREDENTIAL_WRITER_CHANGED");
    assert.equal((await value.read(input, advanced)).envelope.apiKey, "fixture-private-candidate-key");
  } finally { await value.close(); }
});

test("concurrent advance has one winner; old cap is retired even with same logical operation", async () => {
  const value = await fixture(); try {
    const input = scope("advance-race"); await value.prepare(input); const original = await value.owner(input), a = value.writer(input), b = value.writer(input);
    value.physical.get(original.writer.nonce).live = false; const held = barrier(); value.state.verifyBarrier = held;
    const pending = [a, b].map(writer => value.call("owner.advance", { scope: input, owner: original.owner, writer }));
    await held.entered.promise; held.resume.resolve(); const rows = await Promise.allSettled(pending); value.state.verifyBarrier = null;
    assert.equal(rows.filter(row => row.status === "fulfilled").length, 1);
    const failed = rows.find(row => row.status === "rejected"); assert.equal(failed.reason.code, "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_RETIRED");
    const winner = rows.find(row => row.status === "fulfilled").value; assert.equal((await value.read(input, winner)).envelope.operationId, input.operationId);
    await rejected(value.read(input, original), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_FORBIDDEN");
  } finally { await value.close(); }
});

test("advance during actual decrypt retires old asynchronous read; new attempt can read original operation", async () => {
  const value = await fixture(); try {
    const input = scope("advance-decrypt"); await value.prepare(input); const original = await value.owner(input); await value.realDecryptNext();
    const held = barrier(); value.cryptoState.decryptBarrier = held; let published = 0;
    const pending = value.read(input, original).then(result => { if (result.envelope.apiKey) published += 1; return result; }); await held.entered.promise;
    value.physical.get(original.writer.nonce).live = false;
    const advanced = await value.call("owner.advance", { scope: input, owner: original.owner, writer: value.writer(input) });
    held.resume.resolve(); await rejected(pending, "EXTERNAL_PROVIDER_CREDENTIAL_RETIRED"); assert.equal(published, 0);
    value.cryptoState.decryptBarrier = null; assert.equal((await value.read(input, advanced)).envelope.operationId, input.operationId);
  } finally { await value.close(); }
});

test("Service identity change and close/reopen retire contexts/caps; unknown original cannot mint fresh owner", async () => {
  const value = await fixture(); try {
    const input = scope("service-incarnation"); await value.prepare(input); const granted = await value.owner(input); await value.read(input, granted);
    const oldContext = value.management.handle, oldIdentity = value.state.identity, count = value.storeGetCalls;
    value.state.identity = { ...oldIdentity, instanceNonce: digest("foreign-service").slice(0, 48) };
    await rejected(value.read(input, granted), "EXTERNAL_PROVIDER_CREDENTIAL_SERVICE_RETIRED"); assert.equal(value.storeGetCalls, count);
    value.state.identity = oldIdentity; await value.rpc.close(); await value.rpc.open(); value.management = value.context();
    await rejected(value.call("list", {}, oldContext), "EXTERNAL_PROVIDER_CREDENTIAL_RPC_RETIRED");
    await rejected(value.read(input, granted), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_FORBIDDEN");
    assert.equal((await value.call("observe", { scope: input })).state, "needs_verification");
    await rejected(value.owner(input, granted.writer, "new-incarnation-holder"), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    assert.equal(value.storeGetCalls, count);
  } finally { await value.close(); }
});

test("previous phase follows old actual binding for rotate/clear/preserve and never caller history/ref", async () => {
  const value = await fixture(); try {
    const old = scope("previous-old"), oldKey = "fixture-old-domain-synthetic-key"; await complete(value, old, "set", oldKey);
    const binding = { ...value.ledger().bindings[old.providerKey] };
    const changed = scope("previous-new", { baseUrl: "https://new-model.invalid/v2", api: "anthropic-messages" });
    await value.prepare(changed, "set", "fixture-new-domain-synthetic-key"); const granted = await value.owner(changed);
    const previous = (await value.read(changed, granted, { phase: "previous" })).envelope;
    assert.deepEqual(Object.keys(previous), ["version", "backendId", "providerKey", "baseUrl", "api", "operationId", "requestDigest",
      "phase", "previousScope", "bindingRevision", "credentialRevision", "ownerGeneration", "expiresAt", "apiKey"]);
    assert.equal(previous.apiKey, oldKey); assert.deepEqual(previous.previousScope, provider(old)); assert.equal(previous.bindingRevision, binding.revision);
    assert.equal((await value.read(changed, granted)).envelope.apiKey, "fixture-new-domain-synthetic-key");
    assert.equal(Object.hasOwn((await value.assert(changed, granted, { phase: "previous" })).envelope, "apiKey"), false);
    dto((await value.settle(changed, granted, "compensated")).envelope); assert.deepEqual(value.ledger().bindings[old.providerKey], binding);
    for (const action of ["preserve", "clear"]) {
      const input = scope("previous-" + action); await value.prepare(input, action); const owner = await value.owner(input);
      assert.equal((await value.read(input, owner, { phase: "previous" })).envelope.apiKey, oldKey);
      assert.equal(Object.hasOwn((await value.read(input, owner)).envelope, "apiKey"), false);
      dto((await value.settle(input, owner)).envelope, [oldKey]);
    }
    assert.equal((await value.call("status", { scope: provider(old) })).hasSecret, false);
    const fresh = scope("unbound-previous", { providerKey: "unbound-provider" }); await value.prepare(fresh); const owner = await value.owner(fresh);
    const noPrevious = (await value.read(fresh, owner, { phase: "previous" })).envelope;
    assert.equal(noPrevious.previousScope, null); assert.equal(noPrevious.bindingRevision, 0); assert.equal(noPrevious.credentialRevision, null);
    assert.equal(Object.hasOwn(noPrevious, "apiKey"), false);
  } finally { await value.close(); }
});

test("lost actual ciphertext commit result persists unknown original across restart and cannot authorize new op", async () => {
  const value = await fixture(); try {
    const input = scope("cipher-result-lost"), actual = value.secretStore.putIfRevision.bind(value.secretStore);
    value.secretStore.putIfRevision = async (...args) => { await actual(...args); throw Object.assign(Error("synthetic post-commit result loss"), { code: "EIO" }); };
    await rejected(value.prepare(input), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    value.secretStore.putIfRevision = actual; assert.equal(value.secretStore.listMetadata().length, 1);
    await rejected(value.owner(input), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION"); await value.rpc.close(); await value.rpc.open(); value.management = value.context();
    assert.equal((await value.call("observe", { scope: input })).state, "needs_verification");
    await rejected(value.owner(input), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    await rejected(value.prepare(scope("after-cipher-unknown"), "preserve"), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    assert.equal(value.storeGetCalls, 0);
  } finally { await value.close(); }
});

test("unknown outcome retains original owner only; explicit original recovery and terminal observation never mint another key", async () => {
  const value = await fixture(); try {
    const input = scope("unknown-original"); await value.prepare(input); const granted = await value.owner(input); await value.read(input, granted);
    dto((await value.settle(input, granted, "needs_verification")).envelope);
    await rejected(value.read(input, granted), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    await rejected(value.owner(input, granted.writer, "replacement-holder"), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    assert.equal((await value.read(input, granted, { recovery: true })).envelope.operationId, input.operationId);
    dto((await value.settle(input, granted, "compensated")).envelope);
    assert.equal((await value.call("observe", { scope: input })).state, "compensated");
    const before = value.storeGetCalls;
    await rejected(value.read(input, granted), "EXTERNAL_PROVIDER_CREDENTIAL_WRITER_UNVERIFIED"); assert.equal(value.storeGetCalls, before);
    await rejected(value.prepare({ ...input, requestDigest: digest("wrong-original") }), "EXTERNAL_PROVIDER_CREDENTIAL_OPERATION_MISMATCH");
  } finally { await value.close(); }
});

test("malformed or asynchronous Service identity cannot create request authority", async () => {
  const value = await fixture(); try {
    const original = value.state.identity; let calls = 0;
    const getter = { ...original }; Object.defineProperty(getter, "instanceNonce", { enumerable: true, get() { calls += 1; return original.instanceNonce; } });
    for (const identity of [{ ...original, pid: 1 }, { ...original, protocolVersion: SERVICE_PROTOCOL_VERSION + 1 },
      { ...original, extra: true }, Object.assign(Object.create({ claim: true }), original), getter, Promise.resolve(original)]) {
      value.state.identity = identity; assert.throws(() => value.context());
    }
    assert.equal(calls, 0); value.state.identity = original; dto(await value.call("observe", { scope: scope("identity-no-op") }));
    assert.equal(value.cryptoState.encryptCalls, 0);
  } finally { await value.close(); }
});

test("management retirement during actual encryption retains original unknown and old binding, zero fresh owner", async () => {
  const value = await fixture(); try {
    await complete(value, scope("before-management-retire"), "set", "fixture-existing-synthetic-key");
    const before = { ...value.ledger().bindings["fixture-provider"] }, input = scope("management-retire-new");
    const held = barrier(); value.cryptoState.encryptBarrier = held;
    const pending = value.prepare(input, "set", "fixture-retired-candidate-key"); await held.entered.promise;
    value.management.state.live = false; held.resume.resolve(); await rejected(pending, "EXTERNAL_PROVIDER_CREDENTIAL_RETIRED");
    value.cryptoState.encryptBarrier = null; value.management = value.context();
    assert.deepEqual(value.ledger().bindings["fixture-provider"], before); assert.equal(value.secretStore.listMetadata().length, 2);
    assert.equal((await value.call("observe", { scope: input })).state, "needs_verification");
    await rejected(value.owner(input), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    await rejected(value.prepare(scope("fresh-after-retirement"), "preserve"), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
  } finally { await value.close(); }
});

test("second independent writer verification after decrypt can withhold key despite original cheap guard remaining current", async () => {
  const value = await fixture(); try {
    const input = scope("reverify-decrypt"); await value.prepare(input); const granted = await value.owner(input); await value.realDecryptNext();
    const before = value.verifyCalls.length, held = barrier(); value.cryptoState.decryptBarrier = held; let published = 0;
    const pending = value.read(input, granted).then(result => { if (result.envelope.apiKey) published += 1; return result; });
    await held.entered.promise; value.state.verifierMode = "boolean"; held.resume.resolve();
    await rejected(pending, "EXTERNAL_PROVIDER_CREDENTIAL_WRITER_UNVERIFIED"); assert.equal(published, 0);
    assert.equal(value.verifyCalls.slice(before).filter(row => row.phase === "read").length, 2);
    assert.equal((await value.call("observe", { scope: input })).state, "inflight");
    value.state.verifierMode = "guard"; value.cryptoState.decryptBarrier = null;
    assert.equal((await value.read(input, granted)).envelope.operationId, input.operationId);
  } finally { await value.close(); }
});

test("post-Controller assert/terminal settle verification rejects private ACK; original durable terminal remains observable", async () => {
  const value = await fixture(); try {
    const input = scope("reverify-terminal"); await value.prepare(input); const granted = await value.owner(input); await value.read(input, granted);
    value.state.failVerifierCall = value.verifyCalls.length + 2;
    await rejected(value.assert(input, granted), "EXTERNAL_PROVIDER_CREDENTIAL_WRITER_UNVERIFIED");
    value.state.failVerifierCall = value.verifyCalls.length + 2;
    await rejected(value.settle(input, granted), "EXTERNAL_PROVIDER_CREDENTIAL_WRITER_UNVERIFIED");
    const observed = await value.call("observe", { scope: input }); dto(observed); assert.equal(observed.state, "applied");
    const before = value.cryptoState.encryptCalls; value.state.failVerifierCall = null;
    dto((await value.settle(input, granted)).envelope); assert.equal(value.cryptoState.encryptCalls, before);
    await rejected(value.prepare({ ...input, requestDigest: digest("foreign-terminal") }), "EXTERNAL_PROVIDER_CREDENTIAL_OPERATION_MISMATCH");
  } finally { await value.close(); }
});

async function retainedTerminal(value, input, action = "set", outcome = "applied") {
  await value.prepare(input, action); const granted = await value.owner(input); await value.read(input, granted);
  await value.settle(input, granted, outcome); value.physical.get(granted.writer.nonce).paused = true; return granted;
}
const snapshot = value => ({ gets: value.storeGetCalls, encrypt: value.cryptoState.encryptCalls, decrypt: value.cryptoState.decryptCalls,
  ledger: JSON.stringify(value.ledger()), credentials: JSON.stringify(value.secretStore.listMetadata()),
  receiptFiles: fs.readdirSync(path.join(value.paths.stateDir, "external-provider-credential-receipts")).sort().map(name =>
    [name, digest(fs.readFileSync(path.join(value.paths.stateDir, "external-provider-credential-receipts", name)))]) });

test("readonly terminal observation binds original durable receipt and version under two fresh physical checks, paused then resumed", async () => {
  const value = await fixture(); try {
    const input = scope("terminal-readonly-applied"), granted = await retainedTerminal(value, input), before = snapshot(value);
    const checks = value.verifyCalls.length, observed = await value.terminal(input, granted), envelope = observed.envelope;
    assert.deepEqual(Object.keys(observed), ["service", "envelope"]); assert.deepEqual(observed.service, granted.service);
    assert.deepEqual(Object.keys(envelope), ["version", "backendId", "providerKey", "baseUrl", "api", "operationId", "requestDigest",
      "outcome", "action", "bindingScope", "bindingRevision", "credentialRevision", "ownerGeneration", "expiresAt"]);
    assert.equal(envelope.outcome, "applied"); assert.equal(envelope.action, "set"); assert.deepEqual(envelope.bindingScope, provider(input));
    assert.equal(envelope.bindingRevision, 1); assert.ok(envelope.credentialRevision >= 1);
    assert.ok(envelope.expiresAt <= Date.now() + 10000 && envelope.expiresAt <= granted.writer.expiresAt);
    assert.equal(Object.isFrozen(envelope), true); assert.equal(Object.isFrozen(envelope.bindingScope), true);
    for (const forbidden of ["apiKey", "credentialRef", "credentialFingerprint", "capability", "fixture-private-candidate-key"])
      assert.equal(JSON.stringify(envelope).includes(forbidden), false);
    assert.deepEqual(value.verifyCalls.slice(checks).map(row => row.phase), ["terminal-observe", "terminal-observe"]);
    await rejected(value.terminal(input, granted, "applied", "resumed"));
    value.physical.get(granted.writer.nonce).paused = false;
    assert.equal((await value.terminal(input, granted, "applied", "resumed")).envelope.outcome, "applied");
    await rejected(value.terminal(input, granted, "applied", "paused")); assert.deepEqual(snapshot(value), before);
    await rejected(value.read(input, granted), "EXTERNAL_PROVIDER_CREDENTIAL_WRITER_UNVERIFIED");
    value.physical.get(granted.writer.nonce).paused = true;
    await rejected(value.read(input, granted), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
  } finally { await value.close(); }
});

test("compensated and blocked terminal proofs preserve actual previous binding and never infer candidate applied", async () => {
  for (const outcome of ["compensated", "blocked"]) {
    const value = await fixture(); try {
      const old = scope("terminal-old-" + outcome); await complete(value, old);
      const input = scope("terminal-" + outcome, { baseUrl: "https://changed.invalid/v1", api: "anthropic-messages" });
      const granted = await retainedTerminal(value, input, "clear", outcome), before = snapshot(value);
      const observed = (await value.terminal(input, granted, outcome)).envelope;
      assert.equal(observed.outcome, outcome); assert.deepEqual(observed.bindingScope, provider(old));
      assert.equal(observed.bindingRevision, 1); assert.equal(observed.action, "clear"); assert.deepEqual(snapshot(value), before);
      await rejected(value.terminal(input, granted, "applied"), "EXTERNAL_PROVIDER_CREDENTIAL_TERMINAL_UNVERIFIED");
    } finally { await value.close(); }
  }
  const value = await fixture(); try {
    const input = scope("terminal-blocked-absent"), granted = await retainedTerminal(value, input, "clear", "blocked");
    const observed = (await value.terminal(input, granted, "blocked")).envelope;
    assert.equal(observed.bindingScope, null); assert.equal(observed.bindingRevision, 0); assert.equal(observed.credentialRevision, null);
  } finally { await value.close(); }
});

test("terminal observation rejects guessed capability, wrong original scope/writer/outcome, extra secret fields and hostile input", async () => {
  const value = await fixture(); try {
    const input = scope("terminal-hostile"), granted = await retainedTerminal(value, input), before = snapshot(value); let getterCalls = 0;
    for (const extra of [{ apiKey: "fixture-not-a-secret-request" }, { credentialRef: "claimed" }, { phase: "previous" }, { recovery: true }])
      await rejected(value.terminal(input, granted, "applied", "paused", extra), "EXTERNAL_PROVIDER_CREDENTIAL_RPC_INVALID");
    await rejected(value.terminal(input, { ...granted, owner: { ...granted.owner, capability: "a".repeat(64) } }), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_FORBIDDEN");
    for (const patch of [{ operationId: "other-original" }, { requestDigest: digest("other-digest") }, { providerKey: "other-provider" },
      { baseUrl: "https://other.invalid/v1" }, { api: "anthropic-messages" }]) await rejected(value.terminal({ ...input, ...patch }, granted));
    await rejected(value.terminal(input, { ...granted, writer: { ...granted.writer, expiresAt: granted.writer.expiresAt + 1 } }),
      "EXTERNAL_PROVIDER_CREDENTIAL_TERMINAL_UNVERIFIED");
    const params = { scope: input, owner: granted.owner, writer: granted.writer, outcome: "applied" };
    Object.defineProperty(params, "writerState", { enumerable: true, get() { getterCalls++; return "paused"; } });
    await rejected(value.call("lease.terminal.observe", params)); assert.equal(getterCalls, 0);
    await rejected(value.terminal(input, granted, "needs_verification")); await rejected(value.terminal(input, granted, "applied", "claimed-resumed"));
    assert.deepEqual(snapshot(value), before);
  } finally { await value.close(); }
});

test("management receipt and restart cannot construct terminal authority; no proof before original terminal settle", async () => {
  const value = await fixture(); try {
    const input = scope("terminal-restart"), granted = await value.prepare(input).then(() => value.owner(input));
    await rejected(value.terminal(input, granted), "EXTERNAL_PROVIDER_CREDENTIAL_TERMINAL_UNVERIFIED");
    await value.read(input, granted); await value.settle(input, granted, "needs_verification");
    await rejected(value.terminal(input, granted), "EXTERNAL_PROVIDER_CREDENTIAL_TERMINAL_UNVERIFIED");
    await value.read(input, granted, { recovery: true }); await value.settle(input, granted); value.physical.get(granted.writer.nonce).paused = true;
    assert.equal((await value.terminal(input, granted)).envelope.outcome, "applied");
    await value.rpc.close(); await value.rpc.open(); value.management = value.context();
    dto(await value.call("observe", { scope: input })); assert.equal((await value.call("observe", { scope: input })).state, "applied");
    const before = value.storeGetCalls;
    await rejected(value.terminal(input, granted), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_FORBIDDEN");
    await rejected(value.owner(input), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION"); assert.equal(value.storeGetCalls, before);
  } finally { await value.close(); }
});

test("terminal authority never renews or advances, including already-awaiting attempts; original expiry remains authoritative", async () => {
  for (const phase of ["renew", "advance"]) {
    const value = await fixture(); try {
      const input = scope("terminal-late-" + phase); await value.prepare(input); const granted = await value.owner(input); await value.read(input, granted);
      const writer = phase === "renew" ? { ...granted.writer, expiresAt: granted.writer.expiresAt + 60000 } : value.writer(input);
      if (phase === "renew") value.physical.get(granted.writer.nonce).deadline = writer.expiresAt;
      const held = barrier(); value.state.verifyHook = async (_writer, context) => { if (context.phase === phase) {
        held.entered.resolve(); await held.resume.promise; } };
      const pending = value.call("owner." + phase, { scope: input, owner: granted.owner, writer });
      await held.entered.promise; await value.settle(input, granted); value.physical.get(granted.writer.nonce).paused = true;
      if (phase === "advance") value.physical.get(granted.writer.nonce).live = false;
      held.resume.resolve(); await rejected(pending, "EXTERNAL_PROVIDER_CREDENTIAL_TERMINAL_OWNER"); value.state.verifyHook = null;
      await rejected(value.call("owner." + phase, { scope: input, owner: granted.owner, writer }), "EXTERNAL_PROVIDER_CREDENTIAL_TERMINAL_OWNER");
      if (phase === "renew") {
        assert.ok((await value.terminal(input, granted)).envelope.expiresAt <= granted.writer.expiresAt);
        value.state.now = granted.writer.expiresAt + 1;
        await rejected(value.terminal(input, granted), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_RETIRED");
      }
    } finally { await value.close(); }
  }
});

test("changed current binding or credential revision rejects historical terminal cleanup, including mutation during second physical await", async () => {
  for (const mode of ["pending", "credential", "second-physical"]) {
    const value = await fixture(); try {
      const input = scope("terminal-changed-" + mode), granted = await retainedTerminal(value, input);
      if (mode === "pending") await value.prepare(scope("terminal-new-pending-" + mode), "preserve");
      if (mode === "credential") { const binding = value.ledger().bindings[input.providerKey];
        await value.secretStore.putIfRevision(binding.credentialRef, "fixture-replacement-credential", { kind: "external-provider-api-key" },
          value.secretStore.getCredentialRevision(binding.credentialRef)); }
      if (mode === "second-physical") {
        let count = 0; value.state.verifyHook = async (_writer, context) => {
          if (context.phase === "terminal-observe" && ++count === 2) await complete(value, scope("terminal-actual-later-binding"));
        };
      }
      const reads = value.storeGetCalls; await rejected(value.terminal(input, granted),
        ["EXTERNAL_PROVIDER_CREDENTIAL_BINDING_CHANGED", "EXTERNAL_PROVIDER_CREDENTIAL_TERMINAL_UNVERIFIED"]);
      if (mode !== "second-physical") assert.equal(value.storeGetCalls, reads);
    } finally { await value.close(); }
  }
});

test("second independent terminal physical verifier can withhold observation while original guard remains valid", async () => {
  const value = await fixture(); try {
    const input = scope("terminal-fresh-proof"), granted = await retainedTerminal(value, input), before = snapshot(value);
    value.state.failVerifierCall = value.verifyCalls.length + 2;
    await rejected(value.terminal(input, granted), "EXTERNAL_PROVIDER_CREDENTIAL_WRITER_UNVERIFIED");
    assert.deepEqual(snapshot(value), before); value.state.failVerifierCall = null;
    assert.equal((await value.terminal(input, granted)).envelope.outcome, "applied");
  } finally { await value.close(); }
});

const watchdog = setTimeout(() => { throw Error("bounded final RPC fixture did not finish within 30 seconds"); }, 30000);
(async () => {
  const results = []; for (const { name, action } of tests) { try { await action(); results.push({ name, status: "PASS" }); }
    catch (error) { results.push({ name, status: "FAIL", code: error.code || error.name }); console.error(name + "\n" + error.stack); } }
  assert.equal(roots.size, 0, "all owned private roots explicitly closed and removed"); const passed = results.every(row => row.status === "PASS");
  process.stdout.write(JSON.stringify({ status: passed ? "PASS" : "FAIL", groups: results.length, results,
    encryptedStore: "real EncryptedSecretStore; memory-only AES-GCM test broker; actual 0600 files",
    writerVerifier: "controlled local registry of synthetic writer records; not actual process/fence/Gateway proof",
    boundary: "final private RPC gate/Controller unit; no Service socket/Main/Worker/Host acceptance claim",
    hostStarts: 0, modelRequests: 0, realAccountRequests: 0, processProbes: 0, globalWrites: 0 }) + "\n"); if (!passed) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
