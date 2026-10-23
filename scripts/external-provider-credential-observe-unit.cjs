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
  const makeController = secretStore => new ExternalProviderCredentialController({ paths, secretStore,
    async authorizeManagement(captured, context) { if (value.authorizeWait) await value.authorizeWait.promise;
      if (!managementContexts.has(context)) return {}; return createExternalProviderManagementAuthority(() => context.live); },
    async authorizeManagedLease(captured, context) { if (!managedContexts.has(context)) return {};
      return createExternalProviderManagedLeaseAuthority({ assertCurrent: () => context.live, ownerGeneration: context.ownerGeneration,
        expiresAt: context.expiresAt, ...(context.previousOwnerGeneration ? { previousOwnerGeneration: context.previousOwnerGeneration } : {}) }); },
  });
  value.secretStore = new EncryptedSecretStore({ paths, cryptoBroker }); await value.secretStore.open();
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
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

test("initial absence is exact frozen not_found without ciphertext or operation record", async () => {
  const value = await fixture(); try {
    const input = scope("never-prepared"), result = await value.controller.observe(input, value.management);
    assert.deepEqual(result, { version: 1, backendId: "openclaw", providerKey: input.providerKey,
      state: "not_found", hasSecret: false, operationId: input.operationId });
    assert.equal(Object.isFrozen(result), true); checkDTO(result);
    assert.equal(value.secretStore.listMetadata().length, 0);
    assert.equal(Object.hasOwn(value.controller.state.operations, input.operationId), false);
    await rejects(value.controller.observe(input, {}), "EXTERNAL_PROVIDER_CREDENTIAL_FORBIDDEN");
  } finally { await value.close(); }
});

test("original prepared/inflight/unknown operations and compact terminal receipt remain exact", async () => {
  const value = await fixture(); try {
    const input = scope("original-observed"); await value.controller.prepare({ ...input, action: "set", secret: "fixture-observe-synthetic-key" }, value.management);
    const observe = () => value.controller.observe(input, value.management);
    assert.equal((await observe()).state, "prepared"); checkDTO(await observe());
    await value.controller.readForManagedLease(input, value.managed);
    assert.equal((await observe()).state, "inflight");
    await value.restart(); assert.equal((await observe()).state, "needs_verification");
    await value.controller.readForManagedLease({ ...input, recovery: true }, value.managed);
    await value.controller.settleManagedLease({ scope: input, outcome: "applied" }, value.managed);
    assert.equal(Object.hasOwn(value.controller.state.operations, input.operationId), false);
    const terminal = await observe(); assert.equal(terminal.state, "applied"); assert.equal(terminal.hasSecret, true); checkDTO(terminal);
    await value.restart(); assert.deepEqual(await observe(), terminal);
  } finally { await value.close(); }
});

test("known original scope mismatch is never downgraded to not_found across pending and receipt states", async () => {
  const value = await fixture(); try {
    const input = scope("existing-observed"); await value.controller.prepare({ ...input, action: "preserve" }, value.management);
    const patches = [{ requestDigest: digest("wrong-digest") }, { providerKey: "other-provider" },
      { baseUrl: "https://other-model.invalid/v1" }, { api: "anthropic-messages" }];
    const rejectMismatches = async () => { for (const patch of patches)
      await rejects(value.controller.observe({ ...input, ...patch }, value.management), "EXTERNAL_PROVIDER_CREDENTIAL_OPERATION_MISMATCH"); };
    await rejectMismatches(); await value.controller.readForManagedLease(input, value.managed); await rejectMismatches();
    await value.restart(); await rejectMismatches();
    await value.controller.readForManagedLease({ ...input, recovery: true }, value.managed);
    await value.controller.settleManagedLease({ scope: input, outcome: "compensated" }, value.managed); await rejectMismatches();
    await value.restart(); await rejectMismatches();
  } finally { await value.close(); }
});

test("new absent operation for already configured provider remains not_found rather than inheriting stored state", async () => {
  const value = await fixture(); try {
    await complete(value, scope("old-complete"), "set", "fixture-observe-old-synthetic-key");
    const input = scope("new-absent"), before = value.secretStore.listMetadata();
    assert.deepEqual(await value.controller.observe(input, value.management), { version: 1, backendId: "openclaw",
      providerKey: input.providerKey, state: "not_found", hasSecret: false, operationId: input.operationId });
    assert.equal((await value.controller.getStatus(provider(input), value.management)).state, "stored");
    assert.deepEqual(value.secretStore.listMetadata(), before);
  } finally { await value.close(); }
});

const watchdog = setTimeout(() => { throw Error("bounded observe fixture timeout"); }, 30000);
(async () => {
  const results = []; for (const { name, action } of tests) { try { await action(); results.push({ name, status: "PASS" }); }
    catch (error) { results.push({ name, status: "FAIL", code: error.code || error.name }); console.error(name + "\n" + error.stack); } }
  assert.equal(roots.size, 0); const passed = results.every(row => row.status === "PASS");
  process.stdout.write(JSON.stringify({ status: passed ? "PASS" : "FAIL", groups: results.length, results,
    boundary: "Controller management observe with real private encrypted Store; no Service socket/Main/Worker/Host claim",
    hostStarts: 0, modelRequests: 0, realAccountRequests: 0, globalWrites: 0 }) + "\n"); if (!passed) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
