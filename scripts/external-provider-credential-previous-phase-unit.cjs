"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const repo = path.resolve(__dirname, "..");
const { resolveServicePaths } = require(path.join(repo, "app/agent-service/paths"));
const { EncryptedSecretStore } = require(path.join(repo, "app/agent-service/encrypted-secret-store"));
const { ExternalProviderCredentialController, createExternalProviderManagementAuthority,
  createExternalProviderManagedLeaseAuthority } = require(path.join(repo, "app/agent-service/external-provider-credential-controller"));
const tests = [], roots = new Set(); const test = (name, action) => tests.push({ name, action });
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const scopeKeys = ["backendId", "providerKey", "baseUrl", "api", "operationId", "requestDigest"];
const scope = (operationId, patch = {}) => ({ backendId: "openclaw", providerKey: "fixture-provider", baseUrl: "https://old-model.invalid/v1",
  api: "openai-completions", operationId, requestDigest: digest(operationId), ...patch });
const provider = input => Object.fromEntries(scopeKeys.slice(0, 4).map(key => [key, input[key]]));
const deferred = () => { let resolve; const promise = new Promise(next => { resolve = next; }); return { promise, resolve }; };
const rejected = (promise, code) => assert.rejects(promise, error => code === undefined || error.code === code);
const DTO_KEYS = ["version", "backendId", "providerKey", "state", "hasSecret", "operationId"];
function previousDTO(value, keyExpected = false) {
  assert.deepEqual(Object.keys(value), ["version", ...scopeKeys, "phase", "previousScope", "bindingRevision", "credentialRevision",
    "ownerGeneration", "expiresAt", ...(keyExpected ? ["apiKey"] : [])]);
  assert.equal(value.phase, "previous"); assert.equal(Object.isFrozen(value), true);
  assert.equal(value.previousScope === null || Object.isFrozen(value.previousScope), true);
  for (const field of ["credentialRef", "credentialFingerprint", "action"]) assert.equal(Object.hasOwn(value, field), false);
}
async function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-external-provider-previous-")); roots.add(root); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const key = crypto.randomBytes(32), cryptoState = { locked: false, decryptCalls: 0, barrier: null };
  const cryptoBroker = {
    async encrypt(bytes) { if (cryptoState.locked) throw Error("locked"); const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]); },
    async decrypt(bytes) { cryptoState.decryptCalls += 1; if (cryptoState.barrier) { cryptoState.barrier.entered.resolve(); await cryptoState.barrier.resume.promise; }
      if (cryptoState.locked) throw Error("locked"); const cipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]); },
  };
  const management = { live: true }, managed = { live: true, ownerGeneration: "fixture-original-holder", expiresAt: Date.now() + 120000 };
  const managers = new WeakSet([management]), consumers = new WeakSet([managed]);
  const value = { root, paths, key, cryptoState, cryptoBroker, management, managed, managers, consumers, authorizeWait: null, getCalls: 0 };
  const createStore = async () => { const store = new EncryptedSecretStore({ paths, cryptoBroker }); await store.open(); const actual = store.get.bind(store);
    store.get = (...args) => { value.getCalls += 1; return actual(...args); }; return store; };
  const createController = secretStore => new ExternalProviderCredentialController({ paths, secretStore,
    authorizeManagement(_captured, context) { return managers.has(context) ? createExternalProviderManagementAuthority(() => context.live) : {}; },
    async authorizeManagedLease(_captured, context) { if (value.authorizeWait) await value.authorizeWait.promise;
      return consumers.has(context) ? createExternalProviderManagedLeaseAuthority({ assertCurrent: () => context.live,
        ownerGeneration: context.ownerGeneration, expiresAt: context.expiresAt,
        ...(context.previousOwnerGeneration ? { previousOwnerGeneration: context.previousOwnerGeneration } : {}) }) : {}; },
  });
  value.secretStore = await createStore(); value.controller = createController(value.secretStore); await value.controller.open();
  value.restart = async () => { await value.controller.close(); await value.secretStore.close(); value.secretStore = await createStore();
    value.controller = createController(value.secretStore); await value.controller.open(); };
  value.realDecryptNext = async () => { await value.secretStore.close(); cryptoState.locked = true;
    try { await value.secretStore.open(); } finally { cryptoState.locked = false; } };
  value.previous = (input, extra = {}) => value.controller.readForManagedLease({ ...input, phase: "previous", ...extra }, managed);
  value.assertPrevious = input => value.controller.assertForManagedLease({ ...input, phase: "previous" }, managed);
  value.prepare = (input, action = "set", secret = "fixture-new-previous-key-canary-0002") => value.controller.prepare({ ...input, action,
    ...(action === "set" ? { secret } : {}) }, management);
  value.ledger = () => JSON.parse(fs.readFileSync(value.controller.file, "utf8"));
  value.close = async () => { cryptoState.barrier?.resume.resolve(); value.authorizeWait?.resolve(); await value.controller.close(); await value.secretStore.close();
    key.fill(0); fs.rmSync(root, { recursive: true, force: true }); roots.delete(root); };
  return value;
}
async function bind(value, input, action = "set", secret = "fixture-old-previous-key-canary-0001") {
  await value.prepare(input, action, secret); await value.controller.readForManagedLease(input, value.managed);
  await value.controller.settleManagedLease({ scope: input, outcome: "applied" }, value.managed); return value.ledger().bindings[input.providerKey];
}

test("default and explicit candidate retain exact legacy private envelope and public six-field DTO", async () => {
  const value = await fixture(); try {
    const input = scope("candidate-contract"), canary = "fixture-candidate-contract-key-canary"; await value.prepare(input, "set", canary);
    const implicit = await value.controller.readForManagedLease(input, value.managed);
    const explicit = await value.controller.readForManagedLease({ ...input, phase: "candidate" }, value.managed);
    assert.deepEqual(Object.keys(implicit), ["version", ...scopeKeys, "action", "bindingRevision", "credentialRevision", "ownerGeneration", "expiresAt", "apiKey"]);
    assert.deepEqual(Object.keys(explicit), Object.keys(implicit)); const stripTime = ({ expiresAt, ...rest }) => rest;
    assert.deepEqual(stripTime(explicit), stripTime(implicit)); assert.equal(implicit.apiKey, canary);
    const current = await value.controller.assertForManagedLease({ ...input, phase: "candidate" }, value.managed);
    assert.deepEqual(Object.keys(current), Object.keys(implicit).filter(key => key !== "apiKey"));
    assert.deepEqual(Object.keys(await value.controller.observe(input, value.management)), DTO_KEYS);
  } finally { await value.close(); }
});

test("initial unbound operation previous phase has null scope, revision zero and no key", async () => {
  const value = await fixture(); try {
    const input = scope("initial-no-previous"); await value.prepare(input);
    const previous = await value.previous(input); previousDTO(previous); assert.equal(previous.previousScope, null);
    assert.equal(previous.bindingRevision, 0); assert.equal(previous.credentialRevision, null); assert.equal(value.getCalls, 0);
    const current = await value.assertPrevious(input); previousDTO(current); assert.equal(current.previousScope, null);
    assert.equal((await value.controller.readForManagedLease(input, value.managed)).action, "set");
  } finally { await value.close(); }
});

test("rotation with different endpoint and API reads only original old binding domain", async () => {
  const value = await fixture(); try {
    const old = scope("old-domain"), oldKey = "fixture-old-domain-key-canary-0001", newKey = "fixture-new-domain-key-canary-0002";
    const binding = await bind(value, old, "set", oldKey);
    const input = scope("new-domain", { baseUrl: "https://new-model.invalid/v2", api: "anthropic-messages" }); await value.prepare(input, "set", newKey);
    const previous = await value.previous(input); previousDTO(previous, true); assert.equal(previous.apiKey, oldKey);
    assert.equal(previous.baseUrl, input.baseUrl); assert.equal(previous.api, input.api);
    assert.deepEqual(previous.previousScope, provider(old)); assert.equal(previous.bindingRevision, binding.revision);
    const assertion = await value.assertPrevious(input); previousDTO(assertion); assert.deepEqual(assertion.previousScope, provider(old));
    assert.equal(assertion.credentialRevision, previous.credentialRevision);
    const candidate = await value.controller.readForManagedLease(input, value.managed); assert.equal(candidate.apiKey, newKey);
    assert.equal(Object.hasOwn(candidate, "phase"), false); assert.equal(Object.hasOwn(candidate, "previousScope"), false);
    assert.deepEqual(value.ledger().bindings[input.providerKey], binding);
    for (const file of [value.paths.encryptedSecretsPath, value.controller.file]) { assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      const text = fs.readFileSync(file, "utf8"); assert.equal(text.includes(oldKey), false); assert.equal(text.includes(newKey), false); }
  } finally { await value.close(); }
});

test("clear and preserve previous phases retain old key while candidate phase manufactures no key", async () => {
  const value = await fixture(); try {
    const old = scope("clear-preserve-old"), oldKey = "fixture-clear-preserve-old-key-canary"; const binding = await bind(value, old, "set", oldKey);
    for (const action of ["clear", "preserve"]) {
      const input = scope("previous-" + action); await value.prepare(input, action);
      const previous = await value.previous(input); previousDTO(previous, true); assert.equal(previous.apiKey, oldKey);
      assert.deepEqual(previous.previousScope, provider(old)); assert.equal(previous.bindingRevision, binding.revision);
      const candidate = await value.controller.readForManagedLease(input, value.managed); assert.equal(Object.hasOwn(candidate, "apiKey"), false);
      await value.controller.settleManagedLease({ scope: input, outcome: "compensated" }, value.managed);
      assert.deepEqual(value.ledger().bindings[input.providerKey], binding);
    }
  } finally { await value.close(); }
});

test("existing credentialless old binding has old scope and revision but no previous key", async () => {
  const value = await fixture(); try {
    const old = scope("credentialless-old"), binding = await bind(value, old, "clear");
    const input = scope("credentialless-rotate", { baseUrl: "https://new-model.invalid/v2" }); await value.prepare(input);
    const previous = await value.previous(input); previousDTO(previous); assert.deepEqual(previous.previousScope, provider(old));
    assert.equal(previous.bindingRevision, binding.revision); assert.equal(previous.credentialRevision, null);
    previousDTO(await value.assertPrevious(input));
  } finally { await value.close(); }
});

test("rollback read and assertion remain available when separate candidate ciphertext is missing", async () => {
  const value = await fixture(); try {
    const oldKey = "fixture-missing-candidate-old-key-canary"; await bind(value, scope("missing-candidate-old"), "set", oldKey);
    const input = scope("missing-candidate-new"); await value.prepare(input); const operation = value.ledger().operations[input.operationId];
    assert.notEqual(operation.candidateRef, operation.previousBinding.credentialRef); await value.secretStore.delete(operation.candidateRef);
    await rejected(value.controller.readForManagedLease(input, value.managed), "EXTERNAL_PROVIDER_CREDENTIAL_CHANGED");
    const previous = await value.previous(input); previousDTO(previous, true); assert.equal(previous.apiKey, oldKey);
    const assertion = await value.assertPrevious(input); previousDTO(assertion); assert.equal(assertion.credentialRevision, previous.credentialRevision);
  } finally { await value.close(); }
});

test("previous phase rejects historical refs, wrong original scope, fabricated owner and malformed phase before key read", async () => {
  const value = await fixture(); try {
    await bind(value, scope("rejected-previous-old")); const input = scope("rejected-previous-new"); await value.prepare(input); const calls = value.getCalls;
    for (const patch of [{ operationId: "different-operation" }, { requestDigest: digest("different") }, { providerKey: "foreign-provider" },
      { baseUrl: "https://foreign.invalid/v1" }, { api: "anthropic-messages" }])
      await rejected(value.previous({ ...input, ...patch }), "EXTERNAL_PROVIDER_CREDENTIAL_OPERATION_MISMATCH");
    for (const patch of [{ credentialRef: "external-provider-credential-claimed" }, { revision: 1 }, { previousScope: provider(input) },
      { phase: "history" }, { phase: null }, { recovery: "true" }])
      await rejected(value.controller.readForManagedLease({ ...input, phase: "previous", ...patch }, value.managed), "EXTERNAL_PROVIDER_CREDENTIAL_INVALID");
    await rejected(value.controller.readForManagedLease({ ...input, phase: "previous" }, { ready: true, assertCurrent: () => true }),
      "EXTERNAL_PROVIDER_CREDENTIAL_FORBIDDEN");
    let called = 0; const getter = { ...input }; Object.defineProperty(getter, "phase", { enumerable: true, get() { called += 1; return "previous"; } });
    await rejected(value.controller.readForManagedLease(getter, value.managed), "EXTERNAL_PROVIDER_CREDENTIAL_INVALID");
    assert.equal(called, 0); assert.equal(value.getCalls, calls);
    await value.previous(input); value.managed.ownerGeneration = "foreign-holder";
    await rejected(value.previous(input), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_CHANGED");
    await rejected(value.assertPrevious(input), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
  } finally { await value.close(); }
});

test("previous scope and phase are captured before async authorization; no caller mutation selects candidate key", async () => {
  const value = await fixture(); try {
    const oldKey = "fixture-captured-previous-old-key-canary"; await bind(value, scope("capture-phase-old"), "set", oldKey);
    const input = scope("capture-phase-new"); await value.prepare(input); const params = { ...input, phase: "previous" };
    value.authorizeWait = deferred(); const pending = value.controller.readForManagedLease(params, value.managed);
    params.phase = "candidate"; params.baseUrl = "https://mutated.invalid/v1"; params.operationId = "mutated-operation";
    value.authorizeWait.resolve(); const previous = await pending; previousDTO(previous, true);
    assert.equal(previous.operationId, input.operationId); assert.equal(previous.baseUrl, input.baseUrl); assert.equal(previous.apiKey, oldKey);
  } finally { await value.close(); }
});

test("actual old AES-GCM decrypt followed by owner retirement returns zero late previous keys", async () => {
  const value = await fixture(); try {
    await bind(value, scope("retired-previous-old")); const input = scope("retired-previous-new"); await value.prepare(input); await value.realDecryptNext();
    const barrier = { entered: deferred(), resume: deferred() }; value.cryptoState.barrier = barrier; const before = value.cryptoState.decryptCalls;
    let published = 0; const pending = value.previous(input).then(result => { if (result.apiKey) published += 1; return result; });
    await barrier.entered.promise; value.managed.live = false; barrier.resume.resolve();
    await rejected(pending, "EXTERNAL_PROVIDER_CREDENTIAL_RETIRED"); assert.equal(published, 0); assert.equal(value.cryptoState.decryptCalls, before + 1);
  } finally { await value.close(); }
});

test("old ciphertext mutation during real decrypt invalidates both rollback read and assertion", async () => {
  const value = await fixture(); try {
    const binding = await bind(value, scope("mutated-previous-old")); const input = scope("mutated-previous-new"); await value.prepare(input); await value.realDecryptNext();
    const barrier = { entered: deferred(), resume: deferred() }; value.cryptoState.barrier = barrier; let published = 0;
    const pending = value.previous(input).then(result => { if (result.apiKey) published += 1; return result; });
    await barrier.entered.promise;
    await value.secretStore.put(binding.credentialRef, "fixture-overwritten-old-key-canary", { kind: "external-provider-api-key" });
    barrier.resume.resolve(); await rejected(pending, "EXTERNAL_PROVIDER_CREDENTIAL_BINDING_CHANGED"); assert.equal(published, 0);
    await rejected(value.assertPrevious(input), "EXTERNAL_PROVIDER_CREDENTIAL_BINDING_CHANGED");
  } finally { await value.close(); }
});

test("unrelated Store revision mutation during old decrypt fences previous material despite unchanged old ciphertext", async () => {
  const value = await fixture(); try {
    await bind(value, scope("revision-previous-old")); const input = scope("revision-previous-new"); await value.prepare(input); await value.realDecryptNext();
    const barrier = { entered: deferred(), resume: deferred() }; value.cryptoState.barrier = barrier; let published = 0;
    const pending = value.previous(input).then(result => { if (result.apiKey) published += 1; return result; });
    await barrier.entered.promise;
    await value.secretStore.put("native-unrelated-previous-fixture", "fixture-unrelated-synthetic-key-canary", { kind: "custom-responses" });
    barrier.resume.resolve(); await rejected(pending, "EXTERNAL_PROVIDER_CREDENTIAL_CHANGED"); assert.equal(published, 0);
  } finally { await value.close(); }
});

test("restart unknown requires explicit recovery for original previous binding and never leaks via public projection", async () => {
  const value = await fixture(); try {
    const old = scope("restart-previous-old"), oldKey = "fixture-restart-old-key-canary", newKey = "fixture-restart-new-key-canary";
    await bind(value, old, "set", oldKey); const input = scope("restart-previous-new"); await value.prepare(input, "set", newKey);
    await value.controller.readForManagedLease(input, value.managed); await value.restart();
    await rejected(value.previous(input), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    await rejected(value.assertPrevious(input), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    const previous = await value.previous(input, { recovery: true }); previousDTO(previous, true); assert.equal(previous.apiKey, oldKey);
    assert.deepEqual(previous.previousScope, provider(old)); previousDTO(await value.assertPrevious(input));
    for (const dto of [await value.controller.observe(input, value.management), ...(await value.controller.list(value.management))]) {
      assert.deepEqual(Object.keys(dto), DTO_KEYS); const json = JSON.stringify(dto);
      for (const forbidden of [oldKey, newKey, "apiKey", "previousScope", "credentialRef", "Fingerprint", "Revision", "ownerGeneration"])
        assert.equal(json.includes(forbidden), false);
    }
  } finally { await value.close(); }
});

const watchdog = setTimeout(() => { throw Error("bounded previous-phase fixture did not finish within 30 seconds"); }, 30000);
(async () => {
  const results = []; for (const { name, action } of tests) { try { await action(); results.push({ name, status: "PASS" }); }
    catch (error) { results.push({ name, status: "FAIL", code: error.code || error.name }); console.error(name + "\n" + error.stack); } }
  assert.equal(roots.size, 0, "all owned private roots closed and removed"); const passed = results.every(row => row.status === "PASS");
  process.stdout.write(JSON.stringify({ status: passed ? "PASS" : "FAIL", groups: results.length, results,
    encryptedStore: "real EncryptedSecretStore with memory-only AES-GCM test broker and private 0600 filesystem",
    boundary: "Controller previous-phase authority/lifecycle unit; Service gate/Main/Worker/actualHost not claimed",
    hostStarts: 0, modelRequests: 0, realAccountRequests: 0, globalWrites: 0 }) + "\n"); if (!passed) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
