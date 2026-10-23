"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const repo = path.resolve(__dirname, "..");
const { resolveServicePaths } = require(path.join(repo, "app/agent-service/paths"));
const { EncryptedSecretStore } = require(path.join(repo, "app/agent-service/encrypted-secret-store"));
const { ExternalProviderCredentialController, createExternalProviderManagementAuthority,
  createExternalProviderManagedLeaseAuthority } = require(path.join(repo, "app/agent-service/external-provider-credential-controller"));
const { reconcileExternalProviderCredentialSecrets, EXTERNAL_PROVIDER_SECRET_KIND,
  EXTERNAL_PROVIDER_CREDENTIAL_PREFIX } = require(path.join(repo, "app/agent-service/external-provider-credential-reconciliation"));
const tests = [], roots = new Set(); const test = (name, action) => tests.push({ name, action });
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const scope = (operationId, patch = {}) => ({ backendId: "openclaw", providerKey: "fixture-provider",
  baseUrl: "https://model.invalid/v1", api: "openai-completions", operationId, requestDigest: digest(operationId), ...patch });
const provider = input => Object.fromEntries(["backendId", "providerKey", "baseUrl", "api"].map(key => [key, input[key]]));
const deferred = () => { let resolve; const promise = new Promise(next => { resolve = next; }); return { promise, resolve }; };
const keys = ["version", "backendId", "providerKey", "state", "hasSecret", "operationId"];
const checkDTO = value => { assert.deepEqual(Object.keys(value), keys); assert.equal(JSON.stringify(value).includes("credentialRef"), false);
  assert.equal(JSON.stringify(value).includes("apiKey"), false); assert.equal(JSON.stringify(value).includes("Revision"), false); };

async function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-external-provider-credentials-")); roots.add(root); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const key = crypto.randomBytes(32), cryptoState = { locked: false };
  const cryptoBroker = {
    async encrypt(bytes) { if (cryptoState.locked) throw Error("locked"); const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]); },
    async decrypt(bytes) { if (cryptoState.locked) throw Error("locked");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]); },
  };
  const management = { live: true }, managed = { live: true, ownerGeneration: "holder-one", expiresAt: Date.now() + 120000 };
  const managementContexts = new WeakSet([management]), managedContexts = new WeakSet([managed]);
  const value = { root, paths, cryptoState, cryptoBroker, key, management, managed, managementContexts, managedContexts, authorizeWait: null };
  const makeController = (secretStore, namespace) => new ExternalProviderCredentialController({ paths, secretStore, ...(namespace ? { namespace } : {}),
    async authorizeManagement(captured, context) { if (value.authorizeWait) await value.authorizeWait.promise;
      if (!managementContexts.has(context)) return {}; return createExternalProviderManagementAuthority(() => context.live); },
    async authorizeManagedLease(captured, context) { if (!managedContexts.has(context)) return {};
      return createExternalProviderManagedLeaseAuthority({ assertCurrent: () => context.live, ownerGeneration: context.ownerGeneration,
        expiresAt: context.expiresAt, ...(context.previousOwnerGeneration ? { previousOwnerGeneration: context.previousOwnerGeneration } : {}) }); },
  });
  value.secretStore = new EncryptedSecretStore({ paths, cryptoBroker }); await value.secretStore.open();
  value.makeController = makeController;
  value.controller = makeController(value.secretStore); await value.controller.open();
  value.restart = async () => { await value.controller.close(); await value.secretStore.close();
    value.secretStore = new EncryptedSecretStore({ paths, cryptoBroker }); await value.secretStore.open();
    value.controller = makeController(value.secretStore); await value.controller.open(); };
  value.close = async () => { await value.controller.close(); await value.secretStore.close(); key.fill(0); fs.rmSync(root, { recursive: true, force: true }); roots.delete(root); };
  return value;
}
async function complete(value, input, action = "preserve", secret) {
  const prepared = await value.controller.prepare({ ...input, action, ...(secret ? { secret } : {}) }, value.management); checkDTO(prepared);
  const material = await value.controller.readForManagedLease(input, value.managed);
  const settled = await value.controller.settleManagedLease({ scope: input, outcome: "applied" }, value.managed); checkDTO(settled);
  return material;
}
test("native auth scope isolates Agent credentials, preserves shared connections and keeps legacy ciphertext separate", async () => {
  const { nativeAuthProviderScope, NATIVE_AUTH_SECRET_PREFIX } = require("../app/managed-openclaw-auth-profile-scope");
  const config = { agents: { entries: { main: {}, other: {} } } };
  const spec = { kind: "update-provider", providerKey: "builtin", agentId: "main", patch: {} };
  const first = nativeAuthProviderScope(spec, config), second = nativeAuthProviderScope({ ...spec, agentId: "other" }, config);
  assert.notEqual(first.providerKey, second.providerKey);
  assert.equal(first.baseUrl, null);
  const connected = { ...config, models: { providers: { builtin: { baseUrl: "https://first.invalid" } } } };
  const shared = nativeAuthProviderScope(spec, connected);
  const unifiedSpec = { kind: "update-provider", providerKey: "builtin", credentialScope: "provider", patch: {} };
  const unified = nativeAuthProviderScope(unifiedSpec, config);
  assert.deepEqual(unified, nativeAuthProviderScope(unifiedSpec, connected));
  assert.notEqual(unified.providerKey, first.providerKey);
  assert.notEqual(unified.providerKey, shared.providerKey);
  assert.deepEqual(shared, nativeAuthProviderScope({ ...spec, agentId: "other" }, connected));
  assert.deepEqual(shared, nativeAuthProviderScope({ ...spec, providerKey: "BUILTIN" }, connected));
  assert.deepEqual(shared, nativeAuthProviderScope(spec, { ...connected, models: { providers: { builtin: { baseUrl: "https://changed.invalid" } } } }));
  const value = await fixture(); let native;
  try {
    await complete(value, scope("legacy-isolation"), "set", "legacy-synthetic-key");
    native = value.makeController(value.secretStore, "auth-profile"); await native.open();
    const input = { ...first, operationId: "native-isolation", requestDigest: digest("native-isolation") };
    await native.prepare({ ...input, action: "set", secret: "native-synthetic-key" }, value.management);
    assert.equal((await native.readForManagedLease(input, value.managed)).apiKey, "native-synthetic-key");
    await native.settleManagedLease({ scope: input, outcome: "applied" }, value.managed);
    await assert.rejects(value.controller.getStatus(first, value.management));
    await assert.rejects(native.getStatus(provider(scope("legacy")), value.management));
    assert.equal(value.secretStore.listMetadata().filter(row => row.credentialRef.startsWith(NATIVE_AUTH_SECRET_PREFIX)).length, 1);
    await native.close(); native = null;
    await value.restart();
    assert.equal(value.secretStore.listMetadata().length, 2, "legacy reconciliation must retain native ciphertext");
    native = value.makeController(value.secretStore, "auth-profile"); await native.open();
    assert.equal((await native.getStatus(first, value.management)).hasSecret, true);
    assert.equal(value.secretStore.listMetadata().length, 2, "native reconciliation must retain legacy ciphertext");
  } finally { await native?.close(); await value.close(); }
});
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

test("actual encrypted store + private ledger retain no plaintext; only private managed read returns synthetic key", async () => {
  const value = await fixture(); try {
    const input = scope("first-key"), canary = "fixture-initial-credential-canary-0001";
    assert.equal((await value.controller.getStatus(provider(input), value.management)).state, "unconfigured");
    const dto = await value.controller.prepare({ ...input, action: "set", secret: canary }, value.management); checkDTO(dto);
    assert.equal(dto.state, "prepared"); const metadata = value.secretStore.listMetadata(); assert.equal(metadata.length, 1);
    assert.equal(metadata[0].kind, EXTERNAL_PROVIDER_SECRET_KIND); assert.ok(metadata[0].credentialRef.startsWith(EXTERNAL_PROVIDER_CREDENTIAL_PREFIX));
    for (const file of [value.paths.encryptedSecretsPath, value.controller.file]) {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.readFileSync(file, "utf8").includes(canary), false);
    }
    const material = await value.controller.readForManagedLease(input, value.managed);
    assert.equal(material.apiKey, canary); assert.equal(material.bindingRevision, 0); assert.ok(material.credentialRevision >= 1);
    assert.equal(Object.hasOwn(material, "credentialRef"), false); assert.ok(material.expiresAt > Date.now() && material.expiresAt <= Date.now() + 30000);
    const current = await value.controller.assertForManagedLease(input, value.managed);
    assert.equal(current.credentialRevision, material.credentialRevision); assert.equal(Object.hasOwn(current, "apiKey"), false);
    await value.controller.settleManagedLease({ scope: input, outcome: "applied" }, value.managed);
    assert.equal((await value.controller.getStatus(provider(input), value.management)).state, "stored");
  } finally { await value.close(); }
});

test("rotation keeps old binding and key until verified outcome; compensation preserves original binding revision", async () => {
  const value = await fixture(); try {
    await complete(value, scope("old-key"), "set", "fixture-old-credential-canary-0001");
    const before = JSON.parse(fs.readFileSync(value.controller.file, "utf8")).bindings["fixture-provider"];
    const input = scope("rotate-key"); await value.controller.prepare({ ...input, action: "set", secret: "fixture-new-credential-canary-0002" }, value.management);
    assert.deepEqual(JSON.parse(fs.readFileSync(value.controller.file, "utf8")).bindings["fixture-provider"], before);
    const material = await value.controller.readForManagedLease(input, value.managed); assert.equal(material.bindingRevision, before.revision);
    assert.equal(await value.secretStore.get(before.credentialRef), "fixture-old-credential-canary-0001");
    await value.controller.settleManagedLease({ scope: input, outcome: "compensated" }, value.managed);
    assert.deepEqual(JSON.parse(fs.readFileSync(value.controller.file, "utf8")).bindings["fixture-provider"], before);
    await reconcileExternalProviderCredentialSecrets({ controller: value.controller, secretStore: value.secretStore });
    assert.equal(value.secretStore.listMetadata().length, 1); assert.equal(await value.secretStore.get(before.credentialRef), "fixture-old-credential-canary-0001");
  } finally { await value.close(); }
});

test("applied rotation advances binding revision; clear/preserve never manufacture key or private reference", async () => {
  const value = await fixture(); try {
    await complete(value, scope("initial-key"), "set", "fixture-first-credential-canary-0001");
    await complete(value, scope("second-key"), "set", "fixture-second-credential-canary-0002");
    const saved = JSON.parse(fs.readFileSync(value.controller.file, "utf8")).bindings["fixture-provider"]; assert.equal(saved.revision, 2);
    const preserved = await complete(value, scope("preserve-key")); assert.equal(Object.hasOwn(preserved, "apiKey"), false);
    const input = scope("clear-key"); const prepared = await value.controller.prepare({ ...input, action: "clear" }, value.management);
    assert.equal(prepared.hasSecret, false); const material = await value.controller.readForManagedLease(input, value.managed);
    assert.equal(Object.hasOwn(material, "apiKey"), false); assert.equal(material.credentialRevision, null);
    await value.controller.settleManagedLease({ scope: input, outcome: "applied" }, value.managed);
    await reconcileExternalProviderCredentialSecrets({ controller: value.controller, secretStore: value.secretStore });
    assert.equal(value.secretStore.listMetadata().length, 0);
    assert.equal((await value.controller.getStatus(provider(input), value.management)).hasSecret, false);
  } finally { await value.close(); }
});

test("same-operation retry keeps one ciphertext; different input/key/endpoint/digest cannot reuse original operation", async () => {
  const value = await fixture(); try {
    const input = scope("same-operation"), secret = "fixture-retry-credential-canary-0001";
    await value.controller.prepare({ ...input, action: "set", secret }, value.management);
    await value.controller.prepare({ ...input, action: "set", secret }, value.management);
    assert.equal(value.secretStore.listMetadata().length, 1);
    await rejects(value.controller.prepare({ ...input, action: "set", secret: secret + "-different" }, value.management), "EXTERNAL_PROVIDER_CREDENTIAL_OPERATION_MISMATCH");
    for (const patch of [{ providerKey: "foreign-provider" }, { baseUrl: "https://other.invalid/v1" }, { requestDigest: "a".repeat(64) }])
      await rejects(value.controller.observe({ ...input, ...patch }, value.management), "EXTERNAL_PROVIDER_CREDENTIAL_OPERATION_MISMATCH");
    await rejects(value.controller.prepare({ ...input, action: "clear" }, value.management), "EXTERNAL_PROVIDER_CREDENTIAL_OPERATION_MISMATCH");
  } finally { await value.close(); }
});

test("strict own-data scope, authenticated local WeakMap brands, canonical URL and exact backend deny caller readiness/ref/revision claims", async () => {
  const value = await fixture(); try {
    const input = scope("closed-scope");
    for (const patch of [{ credentialRef: "claimed" }, { credentialRevision: 1 }, { ready: true }, { nativeMeta: {} }, { ticket: "claimed" }])
      await assert.rejects(value.controller.readForManagedLease({ ...input, ...patch }, value.managed));
    for (const baseUrl of ["https://model.invalid/v1?apiKey=x", "https://user:password@model.invalid/v1", "https://model.invalid/v1#x", "https://MODEL.invalid/v1", "https://model.invalid/v1/"])
      await assert.rejects(value.controller.prepare({ ...input, baseUrl, action: "preserve" }, value.management));
    await assert.rejects(value.controller.prepare({ ...input, backendId: "hermes", action: "preserve" }, value.management));
    await rejects(value.controller.prepare({ ...input, action: "preserve" }, {}), "EXTERNAL_PROVIDER_CREDENTIAL_FORBIDDEN");
    await value.controller.prepare({ ...input, action: "preserve" }, value.management);
    await rejects(value.controller.readForManagedLease(input, { assertCurrent: () => true, ownerGeneration: "claimed", expiresAt: Date.now() + 60000 }),
      "EXTERNAL_PROVIDER_CREDENTIAL_FORBIDDEN");
    const getter = { ...input }; Object.defineProperty(getter, "providerKey", { enumerable: true, get() { throw Error("accessor invoked"); } });
    await assert.rejects(value.controller.observe(getter, value.management), error => error.code === "EXTERNAL_PROVIDER_CREDENTIAL_INVALID");
    await assert.rejects(value.controller.observe(Object.assign(Object.create({ ready: true }), input), value.management));
  } finally { await value.close(); }
});

test("async authorization cannot mutate validated operation or key; prototype-name IDs are isolated own records", async () => {
  const value = await fixture(); try {
    value.authorizeWait = deferred(); const input = { ...scope("constructor", { providerKey: "constructor" }), action: "set", secret: "fixture-captured-credential-canary-0001" };
    const original = { ...input }; const prepared = value.controller.prepare(input, value.management);
    input.operationId = "mutated"; input.providerKey = "mutated"; input.secret = "fixture-mutated-credential-canary-0002";
    value.authorizeWait.resolve(); await prepared; value.authorizeWait = null;
    const material = await value.controller.readForManagedLease(scope("constructor", { providerKey: "constructor" }), value.managed);
    assert.equal(material.apiKey, original.secret); assert.equal(material.operationId, "constructor"); assert.equal(material.providerKey, "constructor");
    assert.deepEqual(await value.controller.observe(scope("mutated"), value.management), {
      version: 1, backendId: "openclaw", providerKey: "fixture-provider", state: "not_found", hasSecret: false, operationId: "mutated" });
  } finally { await value.close(); }
});

test("concurrent new operations serialize and hold the original provider; public list has only bounded safe DTOs", async () => {
  const value = await fixture(); try {
    const results = await Promise.allSettled(["concurrent-a", "concurrent-b"].map(operationId => value.controller.prepare({ ...scope(operationId), action: "preserve" }, value.management)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.find(result => result.status === "rejected").reason.code, "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    const listed = await value.controller.list(value.management); assert.equal(listed.length, 1); checkDTO(listed[0]);
  } finally { await value.close(); }
});

test("retired managed authority after real decrypt cannot publish envelope; held original input cannot become new operation", async () => {
  const value = await fixture(); try {
    const input = scope("retired-key"); await value.controller.prepare({ ...input, action: "set", secret: "fixture-retired-credential-canary-0001" }, value.management);
    const gate = deferred(), entered = deferred(), actual = value.secretStore.get.bind(value.secretStore);
    value.secretStore.get = async ref => { const secret = await actual(ref); entered.resolve(); await gate.promise; return secret; };
    const pending = value.controller.readForManagedLease(input, value.managed); await entered.promise;
    value.managed.live = false; gate.resolve(); await rejects(pending, "EXTERNAL_PROVIDER_CREDENTIAL_RETIRED");
    assert.equal((await value.controller.observe(input, value.management)).state, "inflight");
    await rejects(value.controller.prepare({ ...scope("new-key"), action: "preserve" }, value.management), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
  } finally { await value.close(); }
});

test("unrelated encrypted-store revision change during decrypt fences issued material; no caller revision may bypass it", async () => {
  const value = await fixture(); try {
    const input = scope("revision-fence"); await value.controller.prepare({ ...input, action: "set", secret: "fixture-fenced-credential-canary-0001" }, value.management);
    const gate = deferred(), entered = deferred(), actual = value.secretStore.get.bind(value.secretStore);
    value.secretStore.get = async ref => { const secret = await actual(ref); entered.resolve(); await gate.promise; return secret; };
    const pending = value.controller.readForManagedLease(input, value.managed); await entered.promise;
    await value.secretStore.putIfRevision("native-unrelated-fixture", "fixture-native-credential-canary-0002", { kind: "custom-responses" }, null);
    gate.resolve(); await rejects(pending, "EXTERNAL_PROVIDER_CREDENTIAL_CHANGED");
    assert.equal((await value.controller.observe(input, value.management)).state, "inflight");
  } finally { await value.close(); }
});

test("owner changes require a privately branded exact previous owner; old holder cannot regain current envelope", async () => {
  const value = await fixture(); try {
    const input = scope("owner-fence"); await value.controller.prepare({ ...input, action: "preserve" }, value.management);
    await value.controller.readForManagedLease(input, value.managed);
    const foreign = { live: true, ownerGeneration: "holder-two", expiresAt: Date.now() + 60000 }; value.managedContexts.add(foreign);
    await rejects(value.controller.readForManagedLease(input, foreign), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_CHANGED");
    foreign.previousOwnerGeneration = "holder-one"; await value.controller.readForManagedLease(input, foreign);
    await rejects(value.controller.readForManagedLease(input, value.managed), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_CHANGED");
    await rejects(value.controller.assertForManagedLease(input, value.managed), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    const current = await value.controller.assertForManagedLease(input, foreign); assert.equal(current.ownerGeneration, "holder-two");
  } finally { await value.close(); }
});

test("restart keeps unknown original operation and both ciphertexts; only exact explicit recovery may reread", async () => {
  const value = await fixture(); try {
    await complete(value, scope("committed-key"), "set", "fixture-committed-credential-canary-0001");
    const input = scope("lost-ack-key"); await value.controller.prepare({ ...input, action: "set", secret: "fixture-pending-credential-canary-0002" }, value.management);
    await value.controller.readForManagedLease(input, value.managed); await value.restart();
    assert.equal(value.secretStore.listMetadata().length, 2); assert.equal((await value.controller.observe(input, value.management)).state, "needs_verification");
    await rejects(value.controller.readForManagedLease(input, value.managed), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    await rejects(value.controller.prepare({ ...scope("fresh-retry-key"), action: "preserve" }, value.management), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    const material = await value.controller.readForManagedLease({ ...input, recovery: true }, value.managed);
    assert.equal(material.apiKey, "fixture-pending-credential-canary-0002"); assert.equal(material.bindingRevision, 1);
    await value.controller.settleManagedLease({ scope: input, outcome: "compensated" }, value.managed);
    await reconcileExternalProviderCredentialSecrets({ controller: value.controller, secretStore: value.secretStore });
    assert.equal(value.secretStore.listMetadata().length, 1);
  } finally { await value.close(); }
});

test("terminal tombstones survive restart with exact original scope; no stale outcome or old operation emits another secret", async () => {
  const value = await fixture(); try {
    const input = scope("terminal-id"); await complete(value, input, "set", "fixture-terminal-credential-canary-0001"); await value.restart();
    const before = fs.readFileSync(value.controller.file), revision = value.secretStore.getCredentialRevision(value.secretStore.listMetadata()[0].credentialRef);
    const dto = await value.controller.prepare({ ...input, action: "set", secret: "fixture-other-credential-canary-0002" }, value.management);
    assert.equal(dto.state, "applied"); assert.deepEqual(fs.readFileSync(value.controller.file), before);
    assert.equal(value.secretStore.getCredentialRevision(value.secretStore.listMetadata()[0].credentialRef), revision);
    await rejects(value.controller.readForManagedLease(input, value.managed), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    await rejects(value.controller.settleManagedLease({ scope: input, outcome: "compensated" }, value.managed), "EXTERNAL_PROVIDER_CREDENTIAL_OUTCOME_MISMATCH");
    await rejects(value.controller.observe({ ...input, baseUrl: "https://foreign.invalid/v1" }, value.management), "EXTERNAL_PROVIDER_CREDENTIAL_OPERATION_MISMATCH");
    const receiptNames = fs.readdirSync(value.controller.receiptsDir); assert.equal(receiptNames.length, 1);
    const receipt = JSON.parse(fs.readFileSync(path.join(value.controller.receiptsDir, receiptNames[0]), "utf8"));
    assert.equal(Object.hasOwn(receipt, "candidateRef"), false); assert.equal(Object.hasOwn(receipt, "credentialFingerprint"), false);
  } finally { await value.close(); }
});

test("256 normal completed saves do not exhaust pending capacity, and oldest tombstone still prevents replay", async () => {
  const value = await fixture(); try {
    for (let index = 0; index < 258; index++) await complete(value, scope("normal-save-" + index));
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(value.controller.file, "utf8")).operations).length, 0);
    assert.equal(fs.readdirSync(value.controller.receiptsDir).length, 258);
    assert.equal((await value.controller.observe(scope("normal-save-0"), value.management)).state, "applied");
    await rejects(value.controller.readForManagedLease(scope("normal-save-0"), value.managed), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
  } finally { await value.close(); }
});

test("locked encryption has known no-effect rejection; locked decryption retains original in-flight operation", async () => {
  const value = await fixture(); try {
    const input = scope("locked-put"); value.cryptoState.locked = true;
    await rejects(value.controller.prepare({ ...input, action: "set", secret: "fixture-locked-credential-canary-0001" }, value.management), "credentials_locked");
    assert.equal((await value.controller.observe(input, value.management)).state, "failed"); assert.equal(value.secretStore.listMetadata().length, 0);
    value.cryptoState.locked = false; await complete(value, scope("unlocked-key"), "set", "fixture-readable-credential-canary-0002");
    const locked = scope("locked-read"); await value.controller.prepare({ ...locked, action: "set", secret: "fixture-new-locked-credential-canary-0003" }, value.management);
    value.cryptoState.locked = true; await value.restart();
    await rejects(value.controller.readForManagedLease({ ...locked, recovery: true }, value.managed), "credentials_locked");
    assert.equal((await value.controller.observe(locked, value.management)).state, "inflight");
  } finally { await value.close(); }
});

test("actual ciphertext persisted followed by unknown write result holds original scope across restart; orphan reconciliation preserves it", async () => {
  const value = await fixture(); try {
    const input = scope("unknown-credential-write"), actual = value.secretStore.putIfRevision.bind(value.secretStore);
    value.secretStore.putIfRevision = async (...args) => { await actual(...args); throw Object.assign(Error("synthetic post-commit lost result"), { code: "SECRET_COMMIT_UNCERTAIN" }); };
    await rejects(value.controller.prepare({ ...input, action: "set", secret: "fixture-unknown-credential-canary-0001" }, value.management), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    await rejects(value.controller.prepare({ ...scope("new-after-unknown"), action: "preserve" }, value.management), "EXTERNAL_PROVIDER_CREDENTIAL_COMMIT_UNCERTAIN");
    await value.restart(); assert.equal(value.secretStore.listMetadata().length, 1);
    assert.equal((await value.controller.observe(input, value.management)).state, "needs_verification");
    await rejects(value.controller.readForManagedLease({ ...input, recovery: true }, value.managed), "EXTERNAL_PROVIDER_CREDENTIAL_CHANGED");
    await rejects(value.controller.prepare({ ...scope("new-after-restart"), action: "preserve" }, value.management), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
  } finally { await value.close(); }
});

test("only new external prefix is reconciled; native/MCP secrets remain owned by their existing authority", async () => {
  const value = await fixture(); try {
    await value.secretStore.putIfRevision("provider-credential-native-fixture", "fixture-native-kept-credential-0001", { kind: "openai-api-key" }, null);
    await value.secretStore.putIfRevision("mcp-credential-fixture", "fixture-mcp-kept-credential-0002", { kind: "mcp-bearer" }, null);
    await value.secretStore.putIfRevision(EXTERNAL_PROVIDER_CREDENTIAL_PREFIX + "orphan", "fixture-external-orphan-credential-0003", { kind: EXTERNAL_PROVIDER_SECRET_KIND }, null);
    const result = await reconcileExternalProviderCredentialSecrets({ controller: value.controller, secretStore: value.secretStore });
    assert.equal(result.deletedCredentialCount, 1); assert.deepEqual(value.secretStore.listMetadata().map(row => row.credentialRef).sort(),
      ["mcp-credential-fixture", "provider-credential-native-fixture"]);
    await assert.rejects(reconcileExternalProviderCredentialSecrets({ controller: { credentialOwnershipSnapshot: () => [] }, secretStore: value.secretStore }),
      error => error.code === "EXTERNAL_PROVIDER_CREDENTIAL_RECONCILIATION_FAILED");
  } finally { await value.close(); }
});

test("credential ABA/ciphertext overwrite and an expired private holder cannot mint current authority", async () => {
  const value = await fixture(); try {
    const input = scope("ciphertext-fence"); await value.controller.prepare({ ...input, action: "set", secret: "fixture-ciphertext-credential-canary-0001" }, value.management);
    const ref = value.secretStore.listMetadata()[0].credentialRef;
    await value.secretStore.putIfRevision(ref, "fixture-replaced-credential-canary-0002", { kind: EXTERNAL_PROVIDER_SECRET_KIND }, value.secretStore.getCredentialRevision(ref));
    await rejects(value.controller.readForManagedLease(input, value.managed), "EXTERNAL_PROVIDER_CREDENTIAL_CHANGED");
    value.managed.expiresAt = Date.now() - 1; await rejects(value.controller.readForManagedLease(input, value.managed), "EXTERNAL_PROVIDER_CREDENTIAL_FORBIDDEN");
  } finally { await value.close(); }
});

test("authorization awaiting old controller incarnation cannot become valid after close/reopen", async () => {
  const value = await fixture(); try {
    value.authorizeWait = deferred(); const pending = value.controller.prepare({ ...scope("old-incarnation"), action: "preserve" }, value.management);
    await value.controller.close(); await value.controller.open(); value.authorizeWait.resolve();
    await rejects(pending, "EXTERNAL_PROVIDER_CREDENTIAL_RETIRED"); value.authorizeWait = null;
    assert.equal(fs.existsSync(value.controller.file), false); assert.equal(value.secretStore.listMetadata().length, 0);
  } finally { await value.close(); }
});

test("management retirement during actual encryption keeps unpublished candidate held and previous binding untouched", async () => {
  const value = await fixture(); try {
    await complete(value, scope("before-management-retire"), "set", "fixture-before-retire-credential-0001");
    const before = JSON.parse(fs.readFileSync(value.controller.file, "utf8")).bindings["fixture-provider"];
    const gate = deferred(), entered = deferred(), actual = value.cryptoBroker.encrypt.bind(value.cryptoBroker);
    value.cryptoBroker.encrypt = async bytes => { const encrypted = await actual(bytes); entered.resolve(); await gate.promise; return encrypted; };
    const input = scope("management-retired-put"), pending = value.controller.prepare({ ...input, action: "set", secret: "fixture-after-retire-credential-0002" }, value.management);
    await entered.promise; value.management.live = false; gate.resolve(); await rejects(pending, "EXTERNAL_PROVIDER_CREDENTIAL_RETIRED");
    assert.deepEqual(JSON.parse(fs.readFileSync(value.controller.file, "utf8")).bindings["fixture-provider"], before);
    const current = { live: true }; value.managementContexts.add(current);
    assert.equal((await value.controller.observe(input, current)).state, "needs_verification");
    assert.equal(value.secretStore.listMetadata().length, 2);
    await rejects(value.controller.prepare({ ...scope("after-management-retire"), action: "preserve" }, current), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
  } finally { await value.close(); }
});

test("actual private metadata published with lost result cannot authorize another operation after restart", async () => {
  const value = await fixture(); try {
    const original = value.controller.fs; let armed = true;
    value.controller.fs = { ...fs, renameSync(from, to) { fs.renameSync(from, to);
      if (armed && to === value.controller.file) { armed = false; throw Object.assign(Error("synthetic metadata result loss"), { code: "EIO" }); } } };
    const input = scope("unknown-metadata-write");
    await rejects(value.controller.prepare({ ...input, action: "set", secret: "fixture-metadata-credential-canary-0001" }, value.management), "EXTERNAL_PROVIDER_CREDENTIAL_COMMIT_UNCERTAIN");
    assert.equal(value.secretStore.listMetadata().length, 0); value.controller.fs = original; await value.restart();
    assert.equal((await value.controller.observe(input, value.management)).state, "needs_verification");
    await rejects(value.controller.prepare({ ...scope("after-unknown-metadata"), action: "preserve" }, value.management), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
  } finally { await value.close(); }
});

test("terminal receipt publication loss is recovered from verified durable terminal state without repeating private material", async () => {
  const value = await fixture(); try {
    const input = scope("unknown-terminal-receipt"); await value.controller.prepare({ ...input, action: "preserve" }, value.management);
    await value.controller.readForManagedLease(input, value.managed);
    let armed = true; const original = value.controller.fs;
    value.controller.fs = { ...fs, renameSync(from, to) { fs.renameSync(from, to);
      if (armed && path.dirname(to) === value.controller.receiptsDir) { armed = false; throw Object.assign(Error("synthetic receipt result loss"), { code: "EIO" }); } } };
    await rejects(value.controller.settleManagedLease({ scope: input, outcome: "applied" }, value.managed), "EXTERNAL_PROVIDER_CREDENTIAL_COMMIT_UNCERTAIN");
    value.controller.fs = original; await value.restart(); assert.equal((await value.controller.observe(input, value.management)).state, "applied");
    await rejects(value.controller.readForManagedLease(input, value.managed), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(value.controller.file, "utf8")).operations).length, 0);
  } finally { await value.close(); }
});

(async () => {
  const results = []; for (const { name, action } of tests) { try { await action(); results.push({ name, status: "PASS" }); }
    catch (error) { results.push({ name, status: "FAIL", code: error.code || error.name }); console.error(name + "\n" + error.stack); } }
  assert.equal(roots.size, 0, "all fixture state roots must be explicitly closed and removed");
  const passed = results.every(result => result.status === "PASS");
  process.stdout.write(JSON.stringify({ status: passed ? "PASS" : "FAIL", groups: results.length, results,
    encryptedStore: "real EncryptedSecretStore with memory-only AES-GCM test broker and private real filesystem",
    boundary: "credential lifecycle/authority unit; Service IPC/Main/Worker product integration not claimed",
    hostStarts: 0, modelRequests: 0, realAccountRequests: 0, globalWrites: 0 }) + "\n");
  if (!passed) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
