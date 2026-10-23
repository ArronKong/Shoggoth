"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const repo = process.env.EXTERNAL_PROVIDER_RPC_FIXTURE_REPO || path.resolve(__dirname, "..");
const { resolveServicePaths } = require(path.join(repo, "app/agent-service/paths"));
const { EncryptedSecretStore } = require(path.join(repo, "app/agent-service/encrypted-secret-store"));
const { createExternalProviderCredentialRpc, EXTERNAL_PROVIDER_CREDENTIAL_IPC_METHODS } = require(path.join(repo, "app/agent-service/external-provider-credential-rpc"));
const PREFIX = "external.provider.credential.";
const tests = [], roots = new Set(); const test = (name, action) => tests.push({ name, action });
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const scope = (operationId, patch = {}) => ({ backendId: "openclaw", providerKey: "fixture-provider", baseUrl: "https://model.invalid/v1",
  api: "openai-completions", operationId, requestDigest: digest(operationId), ...patch });
const provider = value => Object.fromEntries(["backendId", "providerKey", "baseUrl", "api"].map(key => [key, value[key]]));
const ownerOf = value => ({ ownerId: value.ownerId, capability: value.capability });
const deferred = () => { let resolve; const promise = new Promise(next => { resolve = next; }); return { promise, resolve }; };
const rejected = (promise, expected) => assert.rejects(promise, error => expected === undefined
  || (Array.isArray(expected) ? expected : [expected]).includes(error.code));
const DTO_FIELDS = ["version", "backendId", "providerKey", "state", "hasSecret", "operationId"];
function checkDTO(value, canaries = []) {
  assert.deepEqual(Object.keys(value), DTO_FIELDS); const json = JSON.stringify(value);
  for (const field of ["apiKey", "secret", "credentialRef", "Revision", "owner", "capability", "expiresAt", "ready"])
    assert.equal(json.includes(field), false, field + " never appears in management DTO");
  for (const canary of canaries) assert.equal(json.includes(canary), false);
}

async function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-external-provider-rpc-")); roots.add(root); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const key = crypto.randomBytes(32), cryptoState = { locked: false, encryptCalls: 0, decryptCalls: 0, encryptBarrier: null, decryptBarrier: null };
  const cryptoBroker = {
    async encrypt(bytes) { cryptoState.encryptCalls += 1; if (cryptoState.encryptBarrier) { cryptoState.encryptBarrier.entered.resolve();
      await cryptoState.encryptBarrier.resume.promise; } if (cryptoState.locked) throw Error("locked");
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]); },
    async decrypt(bytes) { cryptoState.decryptCalls += 1; if (cryptoState.decryptBarrier) { cryptoState.decryptBarrier.entered.resolve();
      await cryptoState.decryptBarrier.resume.promise; } if (cryptoState.locked) throw Error("locked");
      const cipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]); },
  };
  const state = { serviceCurrent: true, now: Date.now() }, contextStates = [];
  const secretStore = new EncryptedSecretStore({ paths, cryptoBroker }); await secretStore.open();
  const value = { root, paths, key, cryptoState, state, contextStates, secretStore };
  value.storeGetCalls = 0; const actualGet = secretStore.get.bind(secretStore);
  secretStore.get = (...args) => { value.storeGetCalls += 1; return actualGet(...args); };
  value.rpc = createExternalProviderCredentialRpc({ paths, secretStore, assertServiceCurrent: () => state.serviceCurrent, now: () => state.now });
  await value.rpc.open();
  value.context = () => { const current = { live: true }; contextStates.push(current);
    return { state: current, handle: value.rpc.createRequestContext(() => current.live) }; };
  value.management = value.context();
  value.call = (method, params = {}, context = value.management.handle) => value.rpc.dispatch(PREFIX + method, params, context);
  value.openOwner = (input, holderEpoch = "fixture-main-holder") => value.call("owner.open", { scope: input, holderEpoch });
  value.prepare = (input, action = "set", secret = "fixture-private-key-canary-0001") => value.call("prepare", { scope: input, action, // gitleaks:allow -- synthetic canary
    ...(action === "set" ? { secret } : {}) });
  value.read = (input, owner, recovery) => value.call("lease.read", { scope: input, owner: ownerOf(owner),
    ...(recovery === undefined ? {} : { recovery }) });
  value.settle = (input, owner, outcome = "applied") => value.call("lease.settle", { scope: input, owner: ownerOf(owner), outcome });
  value.ledger = () => JSON.parse(fs.readFileSync(path.join(paths.stateDir, "external-provider-credentials.json"), "utf8"));
  // A successful open warms the real Store's plaintext matcher cache. Force a
  // real locked-cache open, then unlock the synthetic broker so the next get
  // actually exercises AES-GCM decryption, rather than waiting on a cache hit.
  value.reopenSecretStore = async () => { await value.secretStore.close(); const previous = cryptoState.locked;
    cryptoState.locked = true; try { await value.secretStore.open(); } finally { cryptoState.locked = previous; } };
  value.close = async () => { cryptoState.encryptBarrier?.resume.resolve(); cryptoState.decryptBarrier?.resume.resolve();
    await value.rpc.close(); await value.secretStore.close(); key.fill(0);
    fs.rmSync(root, { recursive: true, force: true }); roots.delete(root); };
  return value;
}
async function complete(value, input, action, secret, outcome = "applied") {
  checkDTO(await value.prepare(input, action, secret)); const owner = await value.openOwner(input);
  const material = await value.read(input, owner); checkDTO(await value.settle(input, owner, outcome));
  await value.call("owner.close", { owner: ownerOf(owner) }); return material;
}

test("closed in-flight owner cannot mint a new capability for unknown original operation", async () => {
  const value = await fixture(); try {
    const input = scope("closed-inflight"); await value.prepare(input); const owner = await value.openOwner(input);
    await value.read(input, owner); await value.call("owner.close", { owner: ownerOf(owner) });
    assert.equal((await value.call("observe", { scope: input })).state, "inflight");
    await rejected(value.openOwner(input, "different-main-holder"), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
  } finally { await value.close(); }
});

test("fixed private methods and genuine Service-created request context reject spoofed management authority", async () => {
  const value = await fixture(); try {
    assert.equal(EXTERNAL_PROVIDER_CREDENTIAL_IPC_METHODS.length, 9);
    for (const method of EXTERNAL_PROVIDER_CREDENTIAL_IPC_METHODS) assert.equal(value.rpc.isMethod(method), true);
    assert.equal(value.rpc.isMethod("provider.credentials.get"), false);
    await rejected(value.rpc.dispatch("external.provider.credential.read", {}, value.management.handle), "EXTERNAL_PROVIDER_CREDENTIAL_METHOD_INVALID");
    for (const fake of [{}, { assertCurrent: () => true, ready: true }, Object.assign({}, value.management.handle),
      Object.create(value.management.handle), null, "claimed-local-file-token"])
      await rejected(value.call("list", {}, fake), "EXTERNAL_PROVIDER_CREDENTIAL_RPC_RETIRED");
    assert.throws(() => value.rpc.createRequestContext(() => Promise.resolve(true)), error => error.code === "EXTERNAL_PROVIDER_CREDENTIAL_RPC_RETIRED");
    const other = value.context(); other.state.live = false;
    await rejected(value.call("list", {}, other.handle), "EXTERNAL_PROVIDER_CREDENTIAL_RPC_RETIRED");
    assert.equal(value.secretStore.listMetadata().length, 0);
  } finally { await value.close(); }
});

test("captured wire data rejects getters, non-plain prototypes, symbols, functions, extra fields and oversized graphs", async () => {
  const value = await fixture(); try {
    let getterCalls = 0; const getter = { action: "set", secret: "fixture-malicious-getter-key" };
    Object.defineProperty(getter, "scope", { enumerable: true, get() { getterCalls += 1; return scope("getter"); } });
    const inherited = Object.create({ scope: scope("inherited") }); inherited.action = "set"; inherited.secret = "fixture-inherited-key";
    const nullProto = Object.assign(Object.create(null), { scope: scope("null-proto"), action: "set", secret: "fixture-null-key" });
    const symbol = { scope: scope("symbol"), action: "set", secret: "fixture-symbol-key", [Symbol("extra")]: true };
    const nonEnumerable = { scope: scope("non-enumerable"), action: "set", secret: "fixture-hidden-key" };
    Object.defineProperty(nonEnumerable, "extra", { value: true });
    const forbidden = JSON.parse('{"scope":{},"action":"set","secret":"fixture-prototype-key","__proto__":{}}');
    const cyclic = {}; cyclic.self = cyclic;
    const values = [getter, inherited, nullProto, symbol, nonEnumerable, forbidden,
      { scope: scope("function"), action: "set", secret: () => "claimed-key" },
      { scope: scope("extra"), action: "set", secret: "fixture-extra-key", ready: true },
      { scope: scope("huge"), action: "set", secret: "x".repeat(65536) },
      { scope: scope("cycle"), action: "set", secret: cyclic },
      { scope: scope("nan"), action: "set", secret: NaN }];
    for (const params of values) await rejected(value.call("prepare", params), "EXTERNAL_PROVIDER_CREDENTIAL_RPC_INVALID");
    assert.equal(getterCalls, 0); assert.equal(value.cryptoState.encryptCalls, 0); assert.equal(value.secretStore.listMetadata().length, 0);
    assert.equal(fs.existsSync(path.join(value.paths.stateDir, "external-provider-credentials.json")), false);
  } finally { await value.close(); }
});

test("real encrypted files are 0600 and no management DTO includes key, ref or owner capability", async () => {
  const value = await fixture(); try {
    const input = scope("management-projection"), canary = "fixture-management-secret-canary-0001";
    checkDTO(await value.call("status", { scope: provider(input) }));
    checkDTO(await value.prepare(input, "set", canary), [canary]);
    checkDTO(await value.call("observe", { scope: input }), [canary]);
    const owner = await value.openOwner(input);
    for (const dto of await value.call("list")) checkDTO(dto, [canary, owner.ownerId, owner.capability, owner.ownerGeneration]);
    for (const file of [value.paths.encryptedSecretsPath, path.join(value.paths.stateDir, "external-provider-credentials.json")]) {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.readFileSync(file, "utf8").includes(canary), false);
      assert.equal(fs.readFileSync(file, "utf8").includes(owner.capability), false);
    }
    const material = await value.read(input, owner); assert.equal(material.apiKey, canary); assert.equal(Object.hasOwn(material, "credentialRef"), false);
    assert.equal(material.ownerGeneration, owner.ownerGeneration); assert.ok(material.expiresAt > Date.now() && material.expiresAt <= Date.now() + 30000);
    const current = await value.call("lease.assert", { scope: input, owner: ownerOf(owner) });
    assert.equal(Object.hasOwn(current, "apiKey"), false); assert.equal(current.credentialRevision, material.credentialRevision);
    checkDTO(await value.settle(input, owner), [canary, owner.capability]);
    checkDTO(await value.call("status", { scope: provider(input) }), [canary]);
    for (const dto of await value.call("list")) checkDTO(dto, [canary, owner.capability]);
  } finally { await value.close(); }
});

test("wire capture freezes original operation before asynchronous authorization", async () => {
  const value = await fixture(); try {
    const input = scope("capture-original"), original = { ...input }, canary = "fixture-original-wire-key-canary-0001";
    const params = { scope: input, action: "set", secret: canary }; const pending = value.call("prepare", params);
    input.operationId = "mutated-operation"; input.requestDigest = digest("mutated"); input.baseUrl = "https://foreign.invalid/v1";
    params.secret = "fixture-mutated-wire-key-canary-0002"; params.action = "clear"; // gitleaks:allow -- synthetic canary
    const dto = await pending; assert.equal(dto.operationId, original.operationId);
    const owner = await value.openOwner(original); assert.equal((await value.read(original, owner)).apiKey, canary);
    assert.equal(value.ledger().operations[original.operationId].baseUrl, original.baseUrl);
    assert.equal(Object.hasOwn(value.ledger().operations, "mutated-operation"), false);
  } finally { await value.close(); }
});

test("owner opens only after durable preparation; same-operation concurrency preserves one exact holder", async () => {
  const value = await fixture(); try {
    const input = scope("concurrent-owner");
    await rejected(value.openOwner(input), "EXTERNAL_PROVIDER_CREDENTIAL_OPERATION_MISMATCH");
    await value.prepare(input); const same = await Promise.all([value.openOwner(input), value.openOwner(input)]);
    assert.deepEqual(same[0], same[1]);
    await rejected(value.openOwner(input, "foreign-holder"), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_SCOPE_MISMATCH");
    assert.equal(value.cryptoState.decryptCalls, 0);
    const another = scope("different-owner-race", { providerKey: "fixture-second-provider" }); await value.prepare(another);
    const racing = await Promise.allSettled([value.openOwner(another, "first-holder"), value.openOwner(another, "second-holder")]);
    assert.equal(racing.filter(row => row.status === "fulfilled").length, 1);
    assert.equal(racing.filter(row => row.status === "rejected")[0].reason.code, "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_SCOPE_MISMATCH");
  } finally { await value.close(); }
});

test("guessed, cross-operation, foreign target and expanded owner objects fail before decrypt", async () => {
  const value = await fixture(); try {
    const input = scope("owner-scope"); await value.prepare(input); const owner = await value.openOwner(input), handle = ownerOf(owner);
    await rejected(value.call("lease.read", { scope: input, owner: { ...handle, capability: "0".repeat(64) } }), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_FORBIDDEN");
    await rejected(value.call("lease.read", { scope: input, owner: { ...handle, ownerId: crypto.randomUUID() } }), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_FORBIDDEN");
    for (const patch of [{ operationId: "other-operation" }, { requestDigest: digest("different-digest") }, { providerKey: "other-provider" },
      { baseUrl: "https://foreign.invalid/v1" }, { api: "openai-responses" }])
      await rejected(value.call("lease.read", { scope: { ...input, ...patch }, owner: handle }), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_SCOPE_MISMATCH");
    for (const patch of [{ backendId: "hermes" }, { baseUrl: "https://model.invalid/v1/" }, { requestDigest: "not-a-hash" },
      { credentialRef: "external-provider-credential-claimed" }, { revision: 1 }, { nativeMeta: {} }, { ownerGeneration: owner.ownerGeneration }])
      await rejected(value.call("lease.read", { scope: { ...input, ...patch }, owner: handle }));
    for (const patch of [{ holderEpoch: owner.holderEpoch }, { ownerGeneration: owner.ownerGeneration }, { ready: true }, { ticket: "claimed" }])
      await rejected(value.call("lease.read", { scope: input, owner: { ...handle, ...patch } }), "EXTERNAL_PROVIDER_CREDENTIAL_RPC_INVALID");
    await rejected(value.call("lease.read", { scope: input, owner: handle, recovery: "true" }), "EXTERNAL_PROVIDER_CREDENTIAL_INVALID");
    assert.equal(value.storeGetCalls, 0); assert.equal((await value.read(input, owner)).operationId, input.operationId);
  } finally { await value.close(); }
});

test("retired authenticated socket during real decrypt publishes zero late keys", async () => {
  const value = await fixture(); try {
    const input = scope("socket-retired"); await value.prepare(input); const owner = await value.openOwner(input), active = value.context();
    await value.reopenSecretStore();
    const barrier = { entered: deferred(), resume: deferred() }; value.cryptoState.decryptBarrier = barrier;
    let materialPublished = 0; const pending = value.call("lease.read", { scope: input, owner: ownerOf(owner) }, active.handle)
      .then(result => { if (result.apiKey) materialPublished += 1; return result; });
    await barrier.entered.promise; active.state.live = false; barrier.resume.resolve();
    await rejected(pending, "EXTERNAL_PROVIDER_CREDENTIAL_RETIRED"); assert.equal(materialPublished, 0);
    assert.equal((await value.call("observe", { scope: input })).state, "inflight");
  } finally { await value.close(); }
});

test("owner retirement during real decrypt publishes zero late keys and denies replacement owner", async () => {
  const value = await fixture(); try {
    const input = scope("owner-retired"); await value.prepare(input); const owner = await value.openOwner(input);
    await value.reopenSecretStore();
    const barrier = { entered: deferred(), resume: deferred() }; value.cryptoState.decryptBarrier = barrier;
    let materialPublished = 0; const pending = value.read(input, owner).then(result => { if (result.apiKey) materialPublished += 1; return result; });
    await barrier.entered.promise; await value.call("owner.close", { owner: ownerOf(owner) }); barrier.resume.resolve();
    await rejected(pending, "EXTERNAL_PROVIDER_CREDENTIAL_RETIRED"); assert.equal(materialPublished, 0);
    await rejected(value.openOwner(input, "replacement-holder"), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
  } finally { await value.close(); }
});

test("Service retirement during decrypt cannot return material or accept fresh request contexts", async () => {
  const value = await fixture(); try {
    const input = scope("service-retired"); await value.prepare(input); const owner = await value.openOwner(input);
    await value.reopenSecretStore();
    const barrier = { entered: deferred(), resume: deferred() }; value.cryptoState.decryptBarrier = barrier;
    let materialPublished = 0; const pending = value.read(input, owner).then(result => { if (result.apiKey) materialPublished += 1; return result; });
    await barrier.entered.promise; value.state.serviceCurrent = false; barrier.resume.resolve();
    await rejected(pending, "EXTERNAL_PROVIDER_CREDENTIAL_RETIRED"); assert.equal(materialPublished, 0);
    assert.throws(() => value.context(), error => error.code === "EXTERNAL_PROVIDER_CREDENTIAL_RPC_RETIRED");
    await rejected(value.call("list"), "EXTERNAL_PROVIDER_CREDENTIAL_RPC_RETIRED");
  } finally { await value.close(); }
});

test("expired capabilities cannot decrypt, close or reopen an original in-flight operation", async () => {
  const value = await fixture(); try {
    const input = scope("expired-owner"); await value.prepare(input); const owner = await value.openOwner(input);
    await value.read(input, owner); const getCalls = value.storeGetCalls;
    value.state.now = owner.expiresAt;
    await rejected(value.read(input, owner), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_RETIRED");
    await rejected(value.call("owner.close", { owner: ownerOf(owner) }), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_RETIRED");
    await rejected(value.openOwner(input), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_RETIRED");
    assert.equal(value.storeGetCalls, getCalls);
  } finally { await value.close(); }
});

test("close-reopen invalidates old Service contexts and capabilities; pending restart cannot mint recovery owner", async () => {
  const value = await fixture(); try {
    const input = scope("rpc-incarnation"); await value.prepare(input); const owner = await value.openOwner(input);
    await value.read(input, owner); const oldContext = value.management.handle;
    await value.rpc.close(); await value.rpc.open(); value.management = value.context();
    await rejected(value.call("list", {}, oldContext), "EXTERNAL_PROVIDER_CREDENTIAL_RPC_RETIRED");
    await rejected(value.read(input, owner), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_FORBIDDEN");
    assert.equal((await value.call("observe", { scope: input })).state, "needs_verification");
    await rejected(value.openOwner(input), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    await rejected(value.prepare(scope("new-operation-after-restart")), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
  } finally { await value.close(); }
});

test("gate close during real decrypt fences late material before waiting for queued controller work", async () => {
  const value = await fixture(); try {
    const input = scope("close-during-decrypt"); await value.prepare(input); const owner = await value.openOwner(input);
    await value.reopenSecretStore();
    const barrier = { entered: deferred(), resume: deferred() }; value.cryptoState.decryptBarrier = barrier;
    let materialPublished = 0; const pending = value.read(input, owner).then(result => { if (result.apiKey) materialPublished += 1; return result; });
    await barrier.entered.promise; const closing = value.rpc.close(); barrier.resume.resolve();
    await rejected(pending, ["EXTERNAL_PROVIDER_CREDENTIAL_CLOSED", "EXTERNAL_PROVIDER_CREDENTIAL_RETIRED"]);
    await closing; assert.equal(materialPublished, 0); await value.rpc.open(); value.management = value.context();
    await rejected(value.read(input, owner), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_FORBIDDEN");
  } finally { await value.close(); }
});

test("set, rotation, compensation, clear and preserve retain exact private binding revisions", async () => {
  const value = await fixture(); try {
    const firstKey = "fixture-rpc-first-key-canary-0001", secondKey = "fixture-rpc-second-key-canary-0002";
    await complete(value, scope("rpc-initial"), "set", firstKey); const initial = value.ledger().bindings["fixture-provider"];
    await complete(value, scope("rpc-compensated"), "set", secondKey, "compensated");
    assert.deepEqual(value.ledger().bindings["fixture-provider"], initial);
    const rotated = await complete(value, scope("rpc-rotated"), "set", secondKey); assert.equal(rotated.bindingRevision, initial.revision);
    assert.equal(value.ledger().bindings["fixture-provider"].revision, initial.revision + 1);
    const preserved = await complete(value, scope("rpc-preserved"), "preserve");
    assert.equal(Object.hasOwn(preserved, "apiKey"), false); assert.equal(Object.hasOwn(preserved, "credentialRef"), false);
    await rejected(value.prepare(scope("rpc-foreign-preserve", { baseUrl: "https://foreign.invalid/v1" }), "preserve"),
      "EXTERNAL_PROVIDER_CREDENTIAL_ENDPOINT_CHANGED");
    const cleared = await complete(value, scope("rpc-cleared"), "clear");
    assert.equal(Object.hasOwn(cleared, "apiKey"), false); assert.equal(cleared.credentialRevision, null);
    const status = await value.call("status", { scope: provider(scope("status")) }); checkDTO(status, [firstKey, secondKey]); assert.equal(status.hasSecret, false);
    assert.equal(value.ledger().bindings["fixture-provider"].credentialRef, null);
  } finally { await value.close(); }
});

test("real ciphertext commit with lost result stays unknown after restart and cannot issue owner for recovery", async () => {
  const value = await fixture(); try {
    const input = scope("ciphertext-lost-ack"), original = value.secretStore.putIfRevision.bind(value.secretStore);
    value.secretStore.putIfRevision = async (...args) => { await original(...args); const error = Error("lost synthetic acknowledgement");
      error.code = "SECRET_COMMIT_UNCERTAIN"; throw error; };
    await rejected(value.prepare(input), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    assert.equal(value.secretStore.listMetadata().length, 1);
    await value.rpc.close(); value.secretStore.putIfRevision = original; await value.secretStore.close(); await value.secretStore.open();
    await value.rpc.open(); value.management = value.context();
    assert.equal((await value.call("observe", { scope: input })).state, "needs_verification");
    await rejected(value.openOwner(input), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    await rejected(value.prepare(scope("cannot-mask-unknown")), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    assert.equal(value.storeGetCalls, 0); assert.equal(value.secretStore.listMetadata().length, 1);
  } finally { await value.close(); }
});

test("only retained original capability may recover explicit unknown outcome; new holder or operation cannot bypass", async () => {
  const value = await fixture(); try {
    const input = scope("original-unknown"); await value.prepare(input); const owner = await value.openOwner(input);
    await value.read(input, owner); checkDTO(await value.settle(input, owner, "needs_verification"));
    await rejected(value.read(input, owner), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    await rejected(value.openOwner(input, "new-owner-for-unknown"), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    const original = await value.read(input, owner, true); assert.equal(original.ownerGeneration, owner.ownerGeneration);
    checkDTO(await value.settle(input, owner, "compensated"));
    await rejected(value.read(input, owner, true), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
  } finally { await value.close(); }
});

test("terminal receipts expose only safe DTO and cannot reissue material or changed outcome", async () => {
  const value = await fixture(); try {
    const input = scope("terminal-receipt"); await value.prepare(input); const owner = await value.openOwner(input);
    await value.read(input, owner); checkDTO(await value.settle(input, owner));
    checkDTO(await value.prepare(input)); checkDTO(await value.call("observe", { scope: input }));
    await rejected(value.openOwner(input), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    await rejected(value.read(input, owner, true), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    await rejected(value.settle(input, owner, "compensated"), "EXTERNAL_PROVIDER_CREDENTIAL_OUTCOME_MISMATCH");
    const receiptDir = path.join(value.paths.stateDir, "external-provider-credential-receipts");
    assert.equal(fs.readdirSync(receiptDir).length, 1);
    for (const filename of fs.readdirSync(receiptDir)) { const file = path.join(receiptDir, filename);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.readFileSync(file, "utf8").includes(owner.capability), false);
      assert.equal(fs.readFileSync(file, "utf8").includes("credentialRef"), false); }
  } finally { await value.close(); }
});

test("management retirement during real encryption holds candidate without publishing successful preparation", async () => {
  const value = await fixture(); try {
    const input = scope("encrypt-retired"), active = value.context(), barrier = { entered: deferred(), resume: deferred() };
    value.cryptoState.encryptBarrier = barrier; let published = 0;
    const pending = value.call("prepare", { scope: input, action: "set", secret: "fixture-retired-encrypt-key-canary" }, active.handle)
      .then(result => { published += 1; return result; });
    await barrier.entered.promise; active.state.live = false; barrier.resume.resolve();
    await rejected(pending, "EXTERNAL_PROVIDER_CREDENTIAL_RETIRED"); assert.equal(published, 0);
    assert.equal(value.secretStore.listMetadata().length, 1); assert.equal((await value.call("observe", { scope: input })).state, "needs_verification");
    await rejected(value.openOwner(input), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
  } finally { await value.close(); }
});

test("locked real crypto storage never turns credential failure into usable owner or ready DTO", async () => {
  const value = await fixture(); try {
    value.cryptoState.locked = true; const locked = scope("encrypt-locked"); await rejected(value.prepare(locked), "credentials_locked");
    const failed = await value.call("observe", { scope: locked }); checkDTO(failed); assert.equal(failed.state, "failed"); assert.equal(failed.hasSecret, false);
    await rejected(value.openOwner(locked), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    value.cryptoState.locked = false; const input = scope("decrypt-locked"); await value.prepare(input); const owner = await value.openOwner(input);
    await value.reopenSecretStore(); value.cryptoState.locked = true; await rejected(value.read(input, owner), "credentials_locked");
    const current = await value.call("observe", { scope: input }); checkDTO(current); assert.equal(current.state, "inflight");
    value.cryptoState.locked = false; assert.equal((await value.read(input, owner)).operationId, input.operationId);
  } finally { await value.close(); }
});

const watchdog = setTimeout(() => { throw Error("bounded RPC credential fixture did not finish within 20 seconds"); }, 20000);
(async () => {
  const only = process.argv[2]; const selected = only ? tests.filter(row => row.name.includes(only)) : tests;
  assert.ok(selected.length > 0, "a bounded filter must match actual scenarios");
  const results = []; for (const { name, action } of selected) { try { await action(); results.push({ name, status: "PASS" }); }
    catch (error) { results.push({ name, status: "FAIL", code: error.code || error.name }); console.error(name + "\n" + error.stack); } }
  assert.equal(roots.size, 0, "all owned fixture roots closed and removed"); const passed = results.every(row => row.status === "PASS");
  process.stdout.write(JSON.stringify({ status: passed ? "PASS" : "FAIL", groups: results.length, results,
    encryptedStore: "real EncryptedSecretStore with memory-only AES-GCM test broker and private real filesystem",
    boundary: "private IPC gate contract/authority unit; file-token server/Main/Worker product connection not claimed",
    hostStarts: 0, modelRequests: 0, realAccountRequests: 0, globalWrites: 0 }) + "\n");
  if (!passed) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
