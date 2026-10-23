"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");
const P = require("../app/agent-service/memory-provider-owner-protocol.cjs");
const { MemoryProviderOwnerController, createMemoryOwnerManagementAuthority, createMemoryOwnerStoppedLeaseAuthority,
  recoverStoppedMemoryOwnerCatalogLock, PREFIX, KIND } = require("../app/agent-service/memory-provider-owner-controller.cjs");
const { recoverStoppedMemoryOwnerCatalogFiles } = require("../app/agent-service/memory-provider-owner-controller.cjs");
// Constructor resources only. This imports stat/private-write helpers, never
// opens Shoggoth's config, production state, Vault or a network connection.
const privateFiles = require("../app/agent-service/private-file.js");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const rejected = (action, code) => assert.rejects(action, error => error.code === code);
const CREATE = { action: "create", operationId: "create-account", expectedCatalogRevision: 0,
  scope: { kind: "global" }, providerId: "openai", label: "Fixture account", baseUrl: "http://127.0.0.1:43210/v1", secretAction: "set", secret: "fixture-key-alpha-239842" };

// Synthetic encrypted metadata with the real SecretStore's global revision
// semantics. UUID keys are created only via expected null. No real broker is
// read. deleteIfFingerprint checks inside the same queue as its actual delete.
class SyntheticSecretStore {
  constructor(file, root) { this.file = file; this.root = root; this.key = crypto.randomBytes(32); this.state = { revision: 0, entries: {} };
    this.queue = Promise.resolve(); this.reads = 0; this.puts = 0; this.deletes = 0; this.putFault = null; this.deleteFault = null; this.beforeDelete = null; }
  #enqueue(action) { const result = this.queue.then(action); this.queue = result.catch(() => {}); return result; }
  #encrypt(value) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    return Buffer.concat([iv, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64"); }
  #plaintext(ref) { const entry = this.state.entries[ref]; if (!entry) return null;
    const bytes = Buffer.from(entry.ciphertext, "base64"), decipher = crypto.createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8"); }
  #persist(next) { privateFiles.atomicWritePrivateFile(this.file, `${JSON.stringify(next)}\n`, { trustedRoot: this.root }); this.state = next; }
  listMetadata() { return Object.entries(this.state.entries).map(([credentialRef, row]) => ({ credentialRef, kind: row.kind })); }
  getCredentialRevision(ref) { return Object.hasOwn(this.state.entries, ref) ? this.state.revision : null; }
  getCredentialFingerprint(ref) { const entry = this.state.entries[ref]; return entry ? sha(JSON.stringify([ref, entry.kind, entry.ciphertext])) : null; }
  get(ref) { return this.#enqueue(async () => { this.reads += 1; return this.#plaintext(ref); }); }
  withPlaintextMatcher(action) { return action(value => Object.keys(this.state.entries).some(ref => value.includes(this.#plaintext(ref)))); }
  putIfRevision(ref, value, { kind }, expectedRevision) { return this.#enqueue(async () => {
    const revision = this.getCredentialRevision(ref); if (revision !== expectedRevision) throw Object.assign(new Error("fixture conflict"), { code: "SECRET_REVISION_CONFLICT" });
    const next = { revision: this.state.revision + 1, entries: { ...this.state.entries, [ref]: { kind, ciphertext: this.#encrypt(value) } } };
    this.#persist(next); this.puts += 1; if (this.putFault) await this.putFault(ref); return { credentialRef: ref, kind, revision: next.revision };
  }); }
  async deleteIfFingerprint(ref, { kind, fingerprint, retained = [] }) {
    if (this.beforeDelete) await this.beforeDelete(ref);
    return this.#enqueue(async () => {
      const entry = this.state.entries[ref]; if (!entry) return false;
      if (entry.kind !== kind || this.getCredentialFingerprint(ref) !== fingerprint
        || retained.some(item => this.state.entries[item.credentialRef]?.kind !== item.kind || this.getCredentialFingerprint(item.credentialRef) !== item.fingerprint)) {
        throw Object.assign(new Error("fixture mismatch"), { code: "SECRET_REVISION_CONFLICT" });
      }
      if (this.deleteFault) await this.deleteFault(ref);
      const entries = { ...this.state.entries }; delete entries[ref]; this.#persist({ revision: this.state.revision + 1, entries }); this.deletes += 1; return true;
    });
  }
}

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-owner-catalog-fixture-")); fs.chmodSync(root, 0o700);
  const stateDir = path.join(root, "state"); fs.mkdirSync(stateDir, { mode: 0o700 });
  const secretStore = new SyntheticSecretStore(path.join(root, "secrets", "synthetic-secrets.json"), root);
  const config = { memory: { search: { providerRefs: {} } }, agents: { entries: { alpha: {}, beta: {} } } };
  const active = new Set(["alpha", "beta"]), contexts = new WeakMap(), retired = [];
  let serviceCurrent = true, controller;
  const dependencies = { paths: { stateDir, trustedRoot: root }, secretStore, privateFiles,
    authorizeManagement(scope, context) {
      const permit = contexts.get(context);
      return createMemoryOwnerManagementAuthority(() => !!permit?.active && (permit.global || scope.kind === "profile" && permit.profileId === scope.profileId));
    },
    assertServiceCurrent: () => serviceCurrent,
    assertProfileCurrent: id => active.has(id), getProfileIds: () => ["alpha", "beta"], getConfig: () => config,
    retireOwners: async packet => { retired.push({ ownerRefs: [...packet.ownerRefs], agentIds: [...packet.agentIds], reason: packet.reason }); }, now: () => 10000,
    ...overrides,
  };
  const management = Object.freeze({}), profileManagement = Object.freeze({});
  contexts.set(management, { active: true, global: true }); contexts.set(profileManagement, { active: true, profileId: "alpha" });
  const open = () => { controller = new MemoryProviderOwnerController(dependencies).open(); return controller; };
  open();
  return { root, stateDir, config, active, secretStore, dependencies, retired, management, profileManagement, contexts, open,
    get controller() { return controller; }, setServiceCurrent(value) { serviceCurrent = value; },
    async cleanup() { let failure; try { await controller.close(); } catch (error) { failure = error; }
      await secretStore.queue; secretStore.key.fill(0); fs.rmSync(root, { recursive: true, force: true }); if (failure) throw failure; },
    bind(ownerRef, providerId = "openai", profileId) { if (profileId) config.agents.entries[profileId].memory = { search: { providerRefs: { [providerId]: ownerRef } } };
      else config.memory.search.providerRefs[providerId] = ownerRef; },
  };
}
async function using(overrides, action) { const f = fixture(overrides); try { await action(f); } finally { await f.cleanup(); } }
function ledger(f) { return JSON.parse(fs.readFileSync(path.join(f.stateDir, "memory-provider-owners.json"), "utf8")); }
async function create(f, changes = {}) { return f.controller.apply({ ...CREATE, ...changes }, f.management); }
function update(f, row, changes = {}) { return f.controller.apply({ action: "update", operationId: "update-account", expectedCatalogRevision: ledger(f).catalogRevision,
  ownerRef: row.ownerRef, expectedOwnerRevision: row.ownerRevision, label: "Updated fixture", baseUrl: CREATE.baseUrl, secretAction: "preserve", ...changes }, f.management); }
function revoke(f, row, changes = {}) { return f.controller.apply({ action: "revoke", operationId: "revoke-account", expectedCatalogRevision: ledger(f).catalogRevision,
  ownerRef: row.ownerRef, expectedOwnerRevision: row.ownerRevision, ...changes }, f.management); }

test("closed pure schema rejects secret handles, accessors, prototypes and oversized frames before key access", () => {
  for (const value of [{ ...CREATE, credentialRef: "borrowed" }, { ...CREATE, apiKey: "literal" }, { ...CREATE, scope: { kind: "global", profileId: "alpha" } },
    { ...CREATE, secretAction: "preserve" }, { ...CREATE, secret: "x".repeat(16385) }, { ...CREATE, providerId: "none" },
    { ...CREATE, headers: { authorization: "Bearer key" } }, { ...CREATE, baseUrl: "https://user:key@example.invalid" },
    { ...CREATE, baseUrl: "https://example.invalid?key=x" }, { ...CREATE, baseUrl: "https://example.invalid#fragment" },
    { ...CREATE, headers: { "X-Tenant": "a", "x-tenant": "b" } }]) assert.throws(() => P.mutation(value), error => error.code === "MEMORY_OWNER_INVALID");
  let calls = 0; const getter = { ...CREATE }; Object.defineProperty(getter, "label", { enumerable: true, get() { calls++; return "bad"; } });
  assert.throws(() => P.mutation(getter)); assert.equal(calls, 0);
  assert.throws(() => P.mutation(Object.assign(Object.create(null), CREATE)));
});
test("metadata Context never returns plaintext, handles or fingerprints; exact resolver performs zero secret reads", async () => using({}, async f => {
  const row = await create(f); f.bind(row.ownerRef);
  const context = f.controller.context({}, f.management), encoded = JSON.stringify(context);
  assert.equal(context.catalogRevision, 1); assert.equal(context.owners[0].hasCredential, true);
  for (const word of [CREATE.secret, "credentialRef", "credentialFingerprint", "requestDigest", "idempotencyKey"]) assert.equal(encoded.includes(word), false);
  const alpha = f.controller.resolveOwner({ agentId: "alpha", providerId: "openai", ownerRef: row.ownerRef });
  const beta = f.controller.resolveOwner({ agentId: "beta", providerId: "openai", ownerRef: row.ownerRef });
  assert.equal(alpha.profileId, "alpha"); assert.equal(beta.profileId, "beta"); assert.equal(alpha.credentialRef, beta.credentialRef); assert.equal(f.secretStore.reads, 0);
  assert.equal(fs.statSync(path.join(f.stateDir, "memory-provider-owners.json")).mode & 0o777, 0o600);
  for (const file of [path.join(f.stateDir, "memory-provider-owners.json"), path.join(f.root, "secrets", "synthetic-secrets.json"),
    ...fs.readdirSync(path.join(f.stateDir, "memory-provider-owner-receipts")).map(name => path.join(f.stateDir, "memory-provider-owner-receipts", name))]) assert.equal(fs.readFileSync(file, "utf8").includes(CREATE.secret), false);
}));
test("unbranded or retired management cannot register; Profile manager cannot create global or foreign owners", async () => using({}, async f => {
  await rejected(() => f.controller.apply(CREATE, {}), "MEMORY_OWNER_FORBIDDEN");
  await rejected(() => f.controller.apply(CREATE, f.profileManagement), "MEMORY_OWNER_FORBIDDEN");
  await rejected(() => f.controller.apply({ ...CREATE, scope: { kind: "profile", profileId: "beta" } }, f.profileManagement), "MEMORY_OWNER_FORBIDDEN");
  assert.equal(f.secretStore.puts, 0); assert.equal(fs.existsSync(path.join(f.stateDir, "memory-provider-owners.json")), false);
  f.contexts.get(f.management).active = false;
  await rejected(() => create(f), "MEMORY_OWNER_FORBIDDEN");
}));
test("parallel catalog CAS admits one operation only; stale owner revision performs zero key writes", async () => using({}, async f => {
  const results = await Promise.allSettled([create(f), create(f, { operationId: "other-create" })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1); assert.equal(results.find(result => result.status === "rejected").reason.code, "MEMORY_OWNER_CONFLICT");
  const row = results.find(result => result.status === "fulfilled").value;
  await rejected(() => update(f, row, { expectedOwnerRevision: 9, secretAction: "set", secret: "fixture-key-new" }), "MEMORY_OWNER_CONFLICT"); assert.equal(f.secretStore.puts, 1);
}));
test("exclusive catalog lock rejects a second controller and preserves its existing key/file bytes", async () => using({}, async f => {
  await create(f); const before = fs.readFileSync(path.join(f.stateDir, "memory-provider-owners.json"));
  assert.throws(() => new MemoryProviderOwnerController(f.dependencies).open(), error => error.code === "MEMORY_OWNER_CONFLICT");
  assert.deepEqual(fs.readFileSync(path.join(f.stateDir, "memory-provider-owners.json")), before);
  await f.controller.close(); f.open(); assert.equal(f.controller.context({}, f.management).owners.length, 1);
}));
test("operation idempotence is durable and secret-sensitive; historical success cannot claim the current owner", async () => using({}, async f => {
  const row = await create(f), before = fs.readFileSync(path.join(f.stateDir, "memory-provider-owners.json"));
  assert.deepEqual(await create(f), row); assert.deepEqual(fs.readFileSync(path.join(f.stateDir, "memory-provider-owners.json")), before);
  await rejected(() => create(f, { secret: "different-fixture-secret" }), "MEMORY_OWNER_CONFLICT");
  await rejected(() => create(f, { label: "different-label" }), "MEMORY_OWNER_CONFLICT");
  await f.controller.close(); f.open(); assert.deepEqual(await create(f), row);
  await update(f, row); const historical = await create(f); assert.equal(historical.current, false); assert.equal(f.secretStore.puts, 1);
}));
test("rotation copies to a unique ref then retires all bound global Profiles before deleting old key", async () => using({}, async f => {
  const row = await create(f); f.bind(row.ownerRef); const old = ledger(f).owners[row.ownerRef].credentialRef;
  const entered = deferred(), release = deferred();
  f.dependencies.retireOwners = async packet => { f.retired.push({ agentIds: [...packet.agentIds] }); entered.resolve(); await release.promise; };
  // Existing controller retains its injected stable callback: replace the
  // callback on that isolated controller for the held physical retirement.
  f.controller.retireOwners = f.dependencies.retireOwners;
  let completed = false; const operation = update(f, row, { secretAction: "set", secret: "fixture-key-beta-438291" }).then(result => { completed = true; return result; });
  await entered.promise; assert.equal(completed, false); assert.ok(f.secretStore.getCredentialFingerprint(old));
  const next = ledger(f).owners[row.ownerRef]; assert.notEqual(next.credentialRef, old); assert.equal(next.revision, 2); assert.equal(next.status, "active");
  assert.deepEqual(f.retired.at(-1).agentIds, ["alpha", "beta"]); release.resolve();
  const result = await operation; assert.equal(result.cleanupComplete, true); assert.equal(f.secretStore.getCredentialFingerprint(old), null); assert.equal(f.secretStore.deletes, 1);
}));
test("endpoint change cannot preserve a key; rotation and no-key clear use explicit new authority", async () => using({}, async f => {
  const row = await create(f), before = fs.readFileSync(path.join(f.stateDir, "memory-provider-owners.json"));
  await rejected(() => update(f, row, { baseUrl: "http://127.0.0.1:43211/v1" }), "MEMORY_OWNER_FORBIDDEN"); assert.deepEqual(fs.readFileSync(path.join(f.stateDir, "memory-provider-owners.json")), before);
  const result = await update(f, row, { secretAction: "clear" }); f.bind(row.ownerRef);
  const owner = f.controller.resolveOwner({ agentId: "alpha", providerId: "openai", ownerRef: row.ownerRef }); assert.equal(owner.credentialRef, null); assert.equal(result.ownerRevision, 2); assert.equal(f.secretStore.listMetadata().length, 0);
}));
test("revocation tombstone withdraws new admission before physical cleanup; no deleted owner id reuse", async () => using({}, async f => {
  const row = await create(f); f.bind(row.ownerRef); const entered = deferred(), release = deferred();
  f.controller.retireOwners = async () => { entered.resolve(); await release.promise; };
  const operation = revoke(f, row); await entered.promise;
  assert.equal(f.controller.resolveOwner({ agentId: "alpha", providerId: "openai", ownerRef: row.ownerRef }), null);
  assert.equal(f.secretStore.listMetadata().length, 1); release.resolve(); const result = await operation;
  assert.equal(result.status, "revoked"); assert.equal(ledger(f).owners[row.ownerRef].status, "revoked"); assert.equal(f.secretStore.listMetadata().length, 0);
  await rejected(() => update(f, result), "MEMORY_OWNER_CONFLICT");
}));
test("Profile exact scope and per-key inheritance reject foreign refs and never restore a withdrawn local override", async () => using({}, async f => {
  const global = await create(f); f.bind(global.ownerRef);
  const local = await create(f, { operationId: "create-profile", expectedCatalogRevision: 1, scope: { kind: "profile", profileId: "alpha" }, secret: "fixture-alpha-profile-382" }); f.bind(local.ownerRef, "openai", "alpha");
  assert.equal(f.controller.resolveOwner({ agentId: "alpha", providerId: "openai", ownerRef: local.ownerRef }).profileId, "alpha");
  f.bind(local.ownerRef, "openai", "beta"); assert.throws(() => f.controller.resolveOwner({ agentId: "beta", providerId: "openai", ownerRef: local.ownerRef }), error => error.code === "MEMORY_OWNER_FORBIDDEN");
  delete f.config.agents.entries.beta.memory;
  await revoke(f, local); assert.equal(f.controller.resolveOwner({ agentId: "alpha", providerId: "openai", ownerRef: local.ownerRef }), null);
  assert.throws(() => f.controller.resolveOwner({ agentId: "alpha", providerId: "openai", ownerRef: global.ownerRef }), error => error.code === "MEMORY_OWNER_FORBIDDEN");
  assert.equal(f.controller.resolveOwner({ agentId: "beta", providerId: "openai", ownerRef: global.ownerRef }).ownerRef, global.ownerRef); assert.equal(f.secretStore.reads, 0);
}));
test("primary/fallback/custom alias refs are never borrowed across provider ids; projection preserves local native models", async () => using({}, async f => {
  const row = await create(f, { providerId: "fixture-compatible", api: "openai-responses" }); f.bind(row.ownerRef, "fixture-compatible");
  f.config.models = { providers: { "llama-cpp": { baseUrl: "http://127.0.0.1:1234", models: [{ id: "fixture-local" }] } } };
  const projected = f.controller.projectProviderMetadata("alpha");
  assert.deepEqual(projected.models.providers["fixture-compatible"], { api: "openai-responses", baseUrl: CREATE.baseUrl });
  assert.deepEqual(projected.models.providers["llama-cpp"], f.config.models.providers["llama-cpp"]);
  assert.equal(JSON.stringify(projected).includes("credentialRef"), false); assert.equal(JSON.stringify(projected).includes(CREATE.secret), false);
  assert.equal(Object.hasOwn(f.config.models.providers, "fixture-compatible"), false);
  assert.equal(Object.isFrozen(f.config), false); assert.equal(Object.isFrozen(f.config.models.providers["llama-cpp"]), false);
  f.config.models.providers["llama-cpp"].models.push({ id: "second-valid-fixture" }); assert.equal(f.config.models.providers["llama-cpp"].models.length, 2);
  f.bind(row.ownerRef, "openai"); assert.throws(() => f.controller.resolveOwner({ agentId: "alpha", providerId: "openai", ownerRef: row.ownerRef }), error => error.code === "MEMORY_OWNER_FORBIDDEN");
}));
test("global stop of one Profile does not revoke the shared owner or permit unknown profiles", async () => using({}, async f => {
  const row = await create(f); f.bind(row.ownerRef); f.active.delete("alpha");
  assert.throws(() => f.controller.resolveOwner({ agentId: "alpha", providerId: "openai", ownerRef: row.ownerRef }), error => error.code === "MEMORY_OWNER_FORBIDDEN");
  assert.equal(f.controller.resolveOwner({ agentId: "beta", providerId: "openai", ownerRef: row.ownerRef }).ownerRef, row.ownerRef);
  assert.throws(() => f.controller.resolveOwner({ agentId: "gamma", providerId: "openai", ownerRef: row.ownerRef }), error => error.code === "MEMORY_OWNER_FORBIDDEN");
}));
for (const stage of ["catalog-reserved", "catalog-credential-put", "catalog-credential-ready", "catalog-published", "catalog-retired", "catalog-cleaned", "catalog-completed"]) {
  test(`owned fault recovery at ${stage} does not duplicate credentials, owner revisions or receipts`, async () => {
    let failed = false; await using({ fault(point) { if (point === stage && !failed) { failed = true; throw new Error("synthetic interruption"); } } }, async f => {
      await assert.rejects(() => create(f)); const before = ledger(f); await f.controller.close(); f.open();
      if (["catalog-reserved", "catalog-credential-put"].includes(stage)) await rejected(() => f.controller.recover({ operationId: CREATE.operationId, mode: "resume" }, f.management), "MEMORY_OWNER_RECOVERY_REQUIRED");
      const result = await f.controller.recover({ operationId: CREATE.operationId, mode: "resume", secret: CREATE.secret }, f.management);
      assert.equal(result.phase, "completed"); assert.equal(result.ownerRevision, 1); assert.equal(ledger(f).catalogRevision, 1); assert.equal(f.secretStore.puts, 1);
      const saved = fs.readFileSync(path.join(f.stateDir, "memory-provider-owners.json")); assert.deepEqual(await create(f), result);
      assert.deepEqual(fs.readFileSync(path.join(f.stateDir, "memory-provider-owners.json")), saved);
      if (["catalog-published", "catalog-retired", "catalog-cleaned", "catalog-completed"].includes(stage)) assert.equal(before.catalogRevision, 1);
    });
  });
}
test("candidate with no durable fingerprint is not auto-adopted or deleted on cancel; explicit same-key reassertion is required", async () => {
  let failed = false; await using({ fault(stage) { if (stage === "catalog-credential-put" && !failed) { failed = true; throw new Error("stop"); } } }, async f => {
    await assert.rejects(() => create(f)); const candidate = ledger(f).operations[CREATE.operationId].candidateRef;
    await rejected(() => f.controller.recover({ operationId: CREATE.operationId, mode: "cancel" }, f.management), "MEMORY_OWNER_RECOVERY_REQUIRED");
    await rejected(() => f.controller.recover({ operationId: CREATE.operationId, mode: "cancel", secret: "wrong-key" }, f.management), "MEMORY_OWNER_RECOVERY_REQUIRED");
    assert.ok(f.secretStore.getCredentialFingerprint(candidate)); const result = await f.controller.recover({ operationId: CREATE.operationId, mode: "cancel", secret: CREATE.secret }, f.management);
    assert.equal(result.phase, "cancelled"); assert.equal(f.secretStore.getCredentialFingerprint(candidate), null); assert.equal(ledger(f).catalogRevision, 0); assert.equal(f.controller.context({}, f.management).owners.length, 0);
  });
});
test("cancel before secret put creates no credential or owner binding; repeat is harmless", async () => {
  await using({ fault(stage) { if (stage === "catalog-reserved") throw new Error("stop"); } }, async f => {
    await assert.rejects(() => create(f)); const result = await f.controller.recover({ operationId: CREATE.operationId, mode: "cancel" }, f.management);
    assert.equal(result.phase, "cancelled"); assert.equal(f.secretStore.puts, 0); assert.equal(f.secretStore.listMetadata().length, 0);
    assert.deepEqual(await f.controller.recover({ operationId: CREATE.operationId, mode: "cancel" }, f.management), result);
  });
});
test("published mutation cannot be compensated by canceling another transaction", async () => {
  let failed = false; await using({ fault(stage) { if (stage === "catalog-published" && !failed) { failed = true; throw new Error("stop"); } } }, async f => {
    await assert.rejects(() => create(f)); const before = fs.readFileSync(path.join(f.stateDir, "memory-provider-owners.json"));
    await rejected(() => f.controller.recover({ operationId: CREATE.operationId, mode: "cancel" }, f.management), "MEMORY_OWNER_RECOVERY_REQUIRED");
    assert.deepEqual(fs.readFileSync(path.join(f.stateDir, "memory-provider-owners.json")), before);
  });
});
test("unrelated SecretStore writes change global revision but do not invalidate per-ref ownership recovery", async () => {
  let failed = false; await using({ fault(stage) { if (stage === "catalog-credential-ready" && !failed) { failed = true; throw new Error("stop"); } } }, async f => {
    await assert.rejects(() => create(f)); const candidate = ledger(f).operations[CREATE.operationId].candidateRef, before = f.secretStore.getCredentialRevision(candidate);
    await f.secretStore.putIfRevision("unrelated-provider-fixture", "unrelated-key-fixture-9834", { kind: "openai-api-key" }, null);
    assert.ok(f.secretStore.getCredentialRevision(candidate) > before);
    await f.controller.recover({ operationId: CREATE.operationId, mode: "resume" }, f.management); assert.equal(f.secretStore.listMetadata().length, 2);
  });
});
test("atomic fingerprint cleanup refuses queued replacement and preserves the replacement key", async () => using({}, async f => {
  const row = await create(f), oldRef = ledger(f).owners[row.ownerRef].credentialRef;
  f.secretStore.beforeDelete = async ref => { f.secretStore.beforeDelete = null; await f.secretStore.putIfRevision(ref, "foreign-replacement-fixture-key", { kind: KIND }, f.secretStore.getCredentialRevision(ref)); };
  await rejected(() => revoke(f, row), "MEMORY_OWNER_CREDENTIAL_CHANGED");
  assert.equal(await f.secretStore.get(oldRef), "foreign-replacement-fixture-key"); assert.equal(f.secretStore.deletes, 0);
  assert.equal(ledger(f).owners[row.ownerRef].status, "revoked"); assert.equal(ledger(f).operations["revoke-account"].phase, "retired");
}));
test("missing atomic delete capability leaves durable cleanup obligation without invoking unconditioned delete", async () => using({}, async f => {
  const row = await create(f), old = ledger(f).owners[row.ownerRef].credentialRef; f.secretStore.deleteIfFingerprint = undefined;
  await rejected(() => revoke(f, row), "MEMORY_OWNER_CLEANUP_PENDING"); assert.ok(f.secretStore.getCredentialFingerprint(old));
  const pending = ledger(f).operations["revoke-account"]; assert.equal(pending.phase, "retired"); assert.equal(pending.cleanupRef, old); assert.equal(pending.receipt, null);
  f.secretStore.deleteIfFingerprint = SyntheticSecretStore.prototype.deleteIfFingerprint.bind(f.secretStore);
  assert.equal((await f.controller.recover({ operationId: "revoke-account", mode: "resume" }, f.management)).cleanupComplete, true);
}));
test("failed physical retirement keeps old secret and retries the same owner publication only", async () => using({}, async f => {
  const row = await create(f), old = ledger(f).owners[row.ownerRef].credentialRef;
  let fails = true; f.controller.retireOwners = async () => { if (fails) throw new Error(CREATE.secret); };
  await rejected(() => revoke(f, row), "MEMORY_OWNER_RETIRE_FAILED"); assert.ok(f.secretStore.getCredentialFingerprint(old)); const revision = ledger(f).catalogRevision;
  fails = false; const result = await f.controller.recover({ operationId: "revoke-account", mode: "resume" }, f.management);
  assert.equal(result.status, "revoked"); assert.equal(ledger(f).catalogRevision, revision); assert.equal(f.secretStore.getCredentialFingerprint(old), null);
}));
test("failed or uncertain credential cleanup is reported, retained, and recovered without more catalog revisions", async () => using({}, async f => {
  const row = await create(f), old = ledger(f).owners[row.ownerRef].credentialRef;
  f.secretStore.deleteFault = async () => { throw Object.assign(new Error(CREATE.secret), { code: "SECRET_COMMIT_UNCERTAIN" }); };
  await rejected(() => revoke(f, row), "MEMORY_OWNER_UNCERTAIN"); const rev = ledger(f).catalogRevision;
  assert.ok(f.secretStore.getCredentialFingerprint(old)); assert.equal(ledger(f).operations["revoke-account"].receipt, null);
  f.secretStore.deleteFault = null; await f.controller.close(); f.open(); await f.controller.recover({ operationId: "revoke-account", mode: "resume" }, f.management);
  assert.equal(ledger(f).catalogRevision, rev); assert.equal(f.secretStore.getCredentialFingerprint(old), null);
}));
test("uncertain secret put preserves reservation and requires key reassertion; errors contain no payload or plaintext", async () => using({}, async f => {
  f.secretStore.putFault = async () => { f.secretStore.putFault = null; throw Object.assign(new Error(CREATE.secret), { code: "SECRET_COMMIT_UNCERTAIN" }); };
  await assert.rejects(() => create(f), error => !JSON.stringify({ message: error.message, code: error.code }).includes(CREATE.secret));
  const pending = ledger(f).operations[CREATE.operationId]; assert.equal(pending.phase, "reserved"); assert.ok(f.secretStore.getCredentialFingerprint(pending.candidateRef));
  await rejected(() => f.controller.recover({ operationId: CREATE.operationId, mode: "resume", secret: CREATE.secret }, f.management), "MEMORY_OWNER_RETIRED");
  await f.controller.close(); f.open();
  await rejected(() => f.controller.recover({ operationId: CREATE.operationId, mode: "resume" }, f.management), "MEMORY_OWNER_RECOVERY_REQUIRED");
  await f.controller.recover({ operationId: CREATE.operationId, mode: "resume", secret: CREATE.secret }, f.management); assert.equal(f.secretStore.puts, 1);
}));
test("foreign refs/kinds and changed fingerprints are never claimed, scanned or garbage-collected", async () => using({}, async f => {
  await f.secretStore.putIfRevision("external-provider-credential-fixture-foreign", "foreign-key-fixture-123", { kind: KIND }, null);
  const row = await create(f), own = ledger(f).owners[row.ownerRef].credentialRef; f.bind(row.ownerRef);
  await f.secretStore.putIfRevision(own, "replacement-fixture-credentials", { kind: "mcp-oauth" }, f.secretStore.getCredentialRevision(own));
  assert.throws(() => f.controller.resolveOwner({ agentId: "alpha", providerId: "openai", ownerRef: row.ownerRef }), error => error.code === "MEMORY_OWNER_CREDENTIAL_CHANGED");
  await rejected(() => revoke(f, row), "MEMORY_OWNER_CREDENTIAL_CHANGED");
  assert.equal(f.secretStore.listMetadata().length, 2); assert.equal(f.secretStore.deletes, 0); assert.equal(f.secretStore.reads, 0);
}));
test("foreign fixed temp and backup artifacts are rejected without deletion or source changes", async () => using({}, async f => {
  const row = await create(f), file = path.join(f.stateDir, "memory-provider-owners.json"), before = fs.readFileSync(file);
  for (const suffix of [".tmp", ".backup-999-deadbeef00000000"]) {
    fs.writeFileSync(file + suffix, "foreign fixture evidence", { mode: 0o600 });
    await rejected(() => update(f, row), "MEMORY_OWNER_RECOVERY_REQUIRED"); assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(fs.readFileSync(file + suffix, "utf8"), "foreign fixture evidence"); fs.unlinkSync(file + suffix);
  }
}));
test("same-inode foreign ledger write fails byte CAS before key creation", async () => using({}, async f => {
  const row = await create(f), file = path.join(f.stateDir, "memory-provider-owners.json"), before = fs.readFileSync(file);
  fs.appendFileSync(file, " ");
  await rejected(() => update(f, row, { secretAction: "set", secret: "fixture-key-unpublished" }), "MEMORY_OWNER_STORAGE_CHANGED");
  assert.equal(f.secretStore.puts, 1); fs.writeFileSync(file, before, { mode: 0o600 });
}));
test("credential value in public label/header is rejected before persistence and key mutation", async () => using({}, async f => {
  await rejected(() => create(f, { label: CREATE.secret }), "MEMORY_OWNER_INVALID"); assert.equal(f.secretStore.puts, 0);
  await create(f);
  await rejected(() => create(f, { operationId: "second-create", expectedCatalogRevision: 1, secret: "fixture-second-key", headers: { "X-Tenant": CREATE.secret } }), "MEMORY_OWNER_INVALID"); assert.equal(f.secretStore.puts, 1);
}));
test("close withdraws admission immediately and physically joins a held retirement without deleting its old key", async () => using({}, async f => {
  const row = await create(f), entered = deferred(), release = deferred(), old = ledger(f).owners[row.ownerRef].credentialRef; f.bind(row.ownerRef);
  f.controller.retireOwners = async packet => { entered.resolve(); await release.promise; assert.equal(packet.signal.aborted, true); };
  const operation = revoke(f, row); await entered.promise; const closing = f.controller.close();
  assert.throws(() => f.controller.resolveOwner({ agentId: "alpha", providerId: "openai", ownerRef: row.ownerRef }), error => error.code === "MEMORY_OWNER_RETIRED");
  let closed = false; closing.then(() => { closed = true; }); await Promise.resolve(); assert.equal(closed, false);
  release.resolve(); await rejected(() => operation, "MEMORY_OWNER_RETIRED"); await closing;
  assert.ok(f.secretStore.getCredentialFingerprint(old)); assert.equal(ledger(f).operations["revoke-account"].phase, "published");
  f.dependencies.retireOwners = async () => {}; f.open(); await f.controller.recover({ operationId: "revoke-account", mode: "resume" }, f.management); assert.equal(f.secretStore.getCredentialFingerprint(old), null);
}));
test("underlying catalog commit uncertainty poisons admission; durable owned reservation recovers after clean reopen", async () => using({}, async f => {
  let failWrite = true; f.controller.privateFiles = { ...privateFiles, atomicWritePrivateFile(target, bytes, options) {
    privateFiles.atomicWritePrivateFile(target, bytes, options); if (failWrite && target === f.controller.file) { failWrite = false; throw Object.assign(new Error("fixture fsync ambiguity"), { code: "PRIVATE_FILE_COMMIT_UNCERTAIN" }); }
  } };
  await rejected(() => create(f), "MEMORY_OWNER_UNCERTAIN"); assert.throws(() => f.controller.context({}, f.management), error => error.code === "MEMORY_OWNER_RETIRED");
  const oldToken = JSON.parse(f.controller.lock.token).token; await f.controller.close();
  assert.equal(recoverStoppedMemoryOwnerCatalogFiles({ ...f.dependencies.paths, privateFiles,
    authorizeStoppedOwner: info => createMemoryOwnerStoppedLeaseAuthority(() => info.token === oldToken && f.controller.opened === false) }), 1);
  f.open(); const result = await f.controller.recover({ operationId: CREATE.operationId, mode: "resume", secret: CREATE.secret }, f.management);
  assert.equal(result.phase, "completed"); assert.equal(f.secretStore.puts, 1);
}));
test("effective inherited metadata and JSON-escaped key collisions cannot persist plaintext on rotation", async () => using({}, async f => {
  const nextSecret = 'fixture-quoted-"key\\value';
  const row = await create(f, { headers: { "X-Tenant": nextSecret } }), before = fs.readFileSync(f.controller.file);
  await rejected(() => update(f, row, { secretAction: "set", secret: nextSecret }), "MEMORY_OWNER_INVALID");
  assert.deepEqual(fs.readFileSync(f.controller.file), before); assert.equal(f.secretStore.puts, 1);
  await rejected(() => create(f, { operationId: "quoted-key", expectedCatalogRevision: 1, secret: 'other-"key\\value', label: 'other-"key\\value' }), "MEMORY_OWNER_INVALID");
}));
test("published candidate mutation on resume or during held retirement preserves previous key and refuses success", async () => using({}, async f => {
  const row = await create(f), oldRef = ledger(f).owners[row.ownerRef].credentialRef;
  const entered = deferred(), release = deferred(); f.controller.retireOwners = async () => { entered.resolve(); await release.promise; };
  const running = update(f, row, { secretAction: "set", secret: "candidate-fixture-key-684" }); await entered.promise;
  const candidateRef = ledger(f).owners[row.ownerRef].credentialRef;
  await f.secretStore.putIfRevision(candidateRef, "foreign-candidate-replacement", { kind: KIND }, f.secretStore.getCredentialRevision(candidateRef));
  release.resolve(); await rejected(() => running, "MEMORY_OWNER_CREDENTIAL_CHANGED");
  assert.ok(f.secretStore.getCredentialFingerprint(oldRef)); assert.equal(f.secretStore.deletes, 0);
  await rejected(() => f.controller.recover({ operationId: "update-account", mode: "resume" }, f.management), "MEMORY_OWNER_CREDENTIAL_CHANGED");
  assert.ok(f.secretStore.getCredentialFingerprint(oldRef)); assert.equal(ledger(f).operations["update-account"].phase, "published");
}));
test("retained fingerprint is checked atomically with obsolete deletion after queued candidate mutation", async () => using({}, async f => {
  const row = await create(f), oldRef = ledger(f).owners[row.ownerRef].credentialRef;
  f.secretStore.beforeDelete = async () => {
    f.secretStore.beforeDelete = null; const candidateRef = ledger(f).owners[row.ownerRef].credentialRef;
    await f.secretStore.putIfRevision(candidateRef, "queued-foreign-candidate", { kind: KIND }, f.secretStore.getCredentialRevision(candidateRef));
  };
  await rejected(() => update(f, row, { secretAction: "set", secret: "safe-new-fixture-key" }), "MEMORY_OWNER_CREDENTIAL_CHANGED");
  assert.ok(f.secretStore.getCredentialFingerprint(oldRef)); assert.equal(f.secretStore.deletes, 0);
}));
test("projection and context accessors are rejected before invocation and do not freeze caller config", async () => using({}, async f => {
  let calls = 0; const value = {}; Object.defineProperty(value, "profileId", { enumerable: true, get() { calls++; return "alpha"; } });
  assert.throws(() => f.controller.context(value, f.management), error => error.code === "MEMORY_OWNER_INVALID");
  const cfg = { ...f.config }; Object.defineProperty(cfg, "models", { enumerable: true, get() { calls++; return {}; } });
  assert.throws(() => f.controller.projectProviderMetadata("alpha", cfg), error => error.code === "MEMORY_OWNER_INVALID"); assert.equal(calls, 0); assert.equal(Object.isFrozen(cfg), false);
}));
test("real owned child crash leaves lock; only physical stopped-owner proof can recover its inode and reopen", async () => using({}, async f => {
  await f.controller.close();
  const source = `const fs=require('node:fs');const {MemoryProviderOwnerController}=require(${JSON.stringify(require.resolve("../app/agent-service/memory-provider-owner-controller.cjs"))});
    const privateFiles=require(${JSON.stringify(require.resolve("../app/agent-service/private-file.js"))});
    const secretStore=Object.fromEntries(['listMetadata','getCredentialFingerprint','getCredentialRevision','get','putIfRevision','withPlaintextMatcher'].map(name=>[name,()=>null]));
    const c=new MemoryProviderOwnerController({paths:${JSON.stringify(f.dependencies.paths)},secretStore,privateFiles,authorizeManagement:()=>null,assertServiceCurrent:()=>true,
      assertProfileCurrent:()=>true,getProfileIds:()=>[],getConfig:()=>({}),retireOwners:async()=>{}}).open();
    process.stdout.write('owned-crash-ready\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["-e", source], { env: { PATH: "/usr/bin:/bin", TMPDIR: "/private/tmp", ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = ""; child.stderr.on("data", bytes => { errors += bytes; });
  const ready = new Promise((resolve, reject) => { child.stdout.on("data", bytes => { output += bytes; if (output.includes("owned-crash-ready")) resolve(); });
    child.once("exit", () => reject(new Error(`fixture worker exited before ready: ${errors}`))); child.once("error", reject); });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    await ready; assert.throws(() => new MemoryProviderOwnerController(f.dependencies).open(), error => error.code === "MEMORY_OWNER_CONFLICT");
    const locked = fs.readFileSync(path.join(f.stateDir, "memory-provider-owners.json.lock"));
    assert.throws(() => recoverStoppedMemoryOwnerCatalogLock({ ...f.dependencies.paths, privateFiles, authorizeStoppedOwner: () => ({}) }), error => error.code === "MEMORY_OWNER_FORBIDDEN");
    assert.deepEqual(fs.readFileSync(path.join(f.stateDir, "memory-provider-owners.json.lock")), locked);
    const proveStopped = info => createMemoryOwnerStoppedLeaseAuthority(() => {
      assert.equal(info.pid, child.pid); try { process.kill(info.pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
    });
    assert.throws(() => recoverStoppedMemoryOwnerCatalogLock({ ...f.dependencies.paths, privateFiles, authorizeStoppedOwner: proveStopped }), error => error.code === "MEMORY_OWNER_FORBIDDEN");
    child.kill("SIGKILL"); const exit = await exited; assert.equal(exit.signal, "SIGKILL");
    assert.equal(recoverStoppedMemoryOwnerCatalogLock({ ...f.dependencies.paths, privateFiles, authorizeStoppedOwner: proveStopped }), true);
    f.open(); assert.equal(f.controller.context({}, f.management).catalogRevision, 0);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; }
}));
test("shared protocol rejects unknown methods and sensitive fields in Context and mutation receipts", async () => using({}, async f => {
  const receipt = await create(f), context = f.controller.context({}, f.management);
  assert.deepEqual(P.validateResult(P.METHODS[0], context), context); assert.deepEqual(P.validateResult(P.METHODS[1], receipt), receipt);
  assert.deepEqual(P.validateParams(P.METHODS[1], CREATE), P.mutation(CREATE));
  for (const key of ["apiKey", "secret", "credentialRef", "credentialFingerprint", "requestDigest", "unknown"]) {
    assert.throws(() => P.validateResult(P.METHODS[1], { ...receipt, [key]: "leak" }), error => error.code === "MEMORY_OWNER_INVALID");
    assert.throws(() => P.validateResult(P.METHODS[0], { ...context, owners: [{ ...context.owners[0], [key]: "leak" }] }), error => error.code === "MEMORY_OWNER_INVALID");
    assert.throws(() => P.validateParams(P.METHODS[0], { [key]: "leak" }), error => error.code === "MEMORY_OWNER_INVALID");
  }
  assert.throws(() => P.validateParams("memory.provider.owner.reveal", {}), error => error.code === "MEMORY_OWNER_INVALID");
  assert.throws(() => P.validateResult(P.METHODS[1], { ...receipt, phase: "cancelled" }), error => error.code === "MEMORY_OWNER_INVALID");
  let calls = 0; const getter = { ...receipt }; Object.defineProperty(getter, "current", { enumerable: true, get() { calls++; return true; } });
  assert.throws(() => P.validateResult(P.METHODS[1], getter)); assert.equal(calls, 0);
}));
test("Host and transport header mutations are rejected before key access, publication or retirement", async () => using({}, async f => {
  const row = await create(f), before = fs.readFileSync(f.controller.file), retired = f.retired.length;
  for (const name of ["Host", "HOST", "Connection", "Proxy-Connection", "Keep-Alive", "Transfer-Encoding", "Content-Length", "TE", "Trailer", "Upgrade"]) {
    await rejected(() => update(f, row, { headers: { [name]: "other.example" } }), "MEMORY_OWNER_INVALID");
  }
  assert.equal(f.secretStore.puts, 1); assert.equal(f.retired.length, retired); assert.deepEqual(fs.readFileSync(f.controller.file), before);
}));
test("dynamic public header names cannot carry new or existing keys into ledger", async () => using({}, async f => {
  await rejected(() => create(f, { secret: "fixtureKeyABC_12345", headers: { "X-fixtureKeyABC_12345": "ok" } }), "MEMORY_OWNER_INVALID"); // gitleaks:allow -- Synthetic test-only marker
  assert.equal(f.secretStore.puts, 0); assert.equal(fs.existsSync(f.controller.file), false);
}));

async function actualStoreUsing(action) {
  const { EncryptedSecretStore } = require("../app/agent-service/encrypted-secret-store.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-owner-encrypted-fixture-")); fs.chmodSync(root, 0o700);
  const stateDir = path.join(root, "state"); fs.mkdirSync(stateDir, { mode: 0o700 }); const paths = { stateDir, trustedRoot: root, encryptedSecretsPath: path.join(stateDir, "encrypted-secrets.json") };
  const key = crypto.randomBytes(32), config = { memory: { search: { providerRefs: {} } }, agents: { entries: { alpha: {}, beta: {} } } };
  const management = Object.freeze({}), active = new Set(["alpha", "beta"]); const retired = [];
  const cryptoBroker = { async encrypt(payload) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    return Buffer.concat([iv, cipher.update(payload), cipher.final(), cipher.getAuthTag()]); },
  async decrypt(payload) { const decipher = crypto.createDecipheriv("aes-256-gcm", key, payload.subarray(0, 12)); decipher.setAuthTag(payload.subarray(-16));
    return Buffer.concat([decipher.update(payload.subarray(12, -16)), decipher.final()]); } };
  let store, controller;
  const dependencies = { paths, privateFiles,
    authorizeManagement: (_scope, context) => createMemoryOwnerManagementAuthority(() => context === management),
    assertServiceCurrent: () => true, assertProfileCurrent: id => active.has(id), getProfileIds: () => ["alpha", "beta"], getConfig: () => config,
    retireOwners: async packet => { retired.push({ agentIds: [...packet.agentIds], reason: packet.reason }); }, now: () => 10000 };
  async function open() { store = await new EncryptedSecretStore({ paths, cryptoBroker }).open();
    controller = new MemoryProviderOwnerController({ ...dependencies, secretStore: store }).open(); }
  try { await open(); await action({ root, stateDir, paths, cryptoBroker, config, management, active, retired, dependencies, open,
    get controller() { return controller; }, get store() { return store; },
    async restart() { await controller.close(); await store.close(); await open(); } }); }
  finally { if (controller) await controller.close(); if (store) await store.close(); key.fill(0); fs.rmSync(root, { recursive: true, force: true }); }
}
test("actual EncryptedSecretStore registration, exact private binding, Context and original generic metadata projection", async () => actualStoreUsing(async f => {
  const row = await f.controller.apply({ ...CREATE, providerId: "fixture-generic", api: "openai-responses" }, f.management);
  f.config.memory.search.providerRefs["fixture-generic"] = row.ownerRef;
  const owner = f.controller.resolveOwner({ agentId: "alpha", providerId: "fixture-generic", ownerRef: row.ownerRef });
  assert.match(owner.credentialRef, new RegExp(`^${PREFIX}`)); assert.equal(owner.credentialKind, KIND);
  assert.equal(await f.store.get(owner.credentialRef), CREATE.secret);
  const projected = f.controller.projectProviderMetadata("alpha"); assert.deepEqual(projected.models.providers["fixture-generic"], { api: "openai-responses", baseUrl: CREATE.baseUrl });
  const context = P.validateResult(P.METHODS[0], f.controller.context({}, f.management));
  for (const file of [f.controller.file, f.paths.encryptedSecretsPath]) assert.equal(fs.readFileSync(file, "utf8").includes(CREATE.secret), false);
  assert.equal(JSON.stringify(context).includes(owner.credentialRef), false); await f.restart();
  assert.equal(f.controller.resolveOwner({ agentId: "alpha", providerId: "fixture-generic", ownerRef: row.ownerRef }).credentialRef, owner.credentialRef);
  assert.equal(await f.store.get(owner.credentialRef), CREATE.secret);
}));
test("actual Store rotation awaits held physical retirement then deletes only the obsolete immutable key", async () => actualStoreUsing(async f => {
  const row = await f.controller.apply(CREATE, f.management); f.config.memory.search.providerRefs.openai = row.ownerRef;
  const old = f.controller.resolveOwner({ agentId: "alpha", providerId: "openai", ownerRef: row.ownerRef }).credentialRef;
  const entered = deferred(), release = deferred(); f.controller.retireOwners = async packet => { assert.deepEqual(packet.agentIds, ["alpha", "beta"]); entered.resolve(); await release.promise; };
  const operation = f.controller.apply({ action: "update", operationId: "real-rotate", expectedCatalogRevision: 1, ownerRef: row.ownerRef,
    expectedOwnerRevision: 1, label: "Updated fixture", baseUrl: CREATE.baseUrl, secretAction: "set", secret: "actual-store-fixture-rotate" }, f.management);
  await entered.promise; const newRef = f.controller.resolveOwner({ agentId: "alpha", providerId: "openai", ownerRef: row.ownerRef }).credentialRef;
  assert.notEqual(newRef, old); assert.equal(await f.store.get(old), CREATE.secret); release.resolve(); const result = await operation;
  assert.equal(result.cleanupComplete, true); assert.equal(f.store.getCredentialFingerprint(old), null); assert.equal(await f.store.get(newRef), "actual-store-fixture-rotate");
}));
test("actual Store retained proof rejects queued replacement and leaves previous key available", async () => actualStoreUsing(async f => {
  const row = await f.controller.apply(CREATE, f.management); f.config.memory.search.providerRefs.openai = row.ownerRef;
  const old = f.controller.resolveOwner({ agentId: "alpha", providerId: "openai", ownerRef: row.ownerRef }).credentialRef, nativeDelete = f.store.deleteIfFingerprint.bind(f.store);
  f.store.deleteIfFingerprint = async (ref, proof) => {
    const candidateRef = proof.retained[0].credentialRef;
    await f.store.put(candidateRef, "real-store-foreign-candidate", { kind: KIND }); return nativeDelete(ref, proof);
  };
  await rejected(() => f.controller.apply({ action: "update", operationId: "real-race", expectedCatalogRevision: 1, ownerRef: row.ownerRef,
    expectedOwnerRevision: 1, label: "Updated fixture", baseUrl: CREATE.baseUrl, secretAction: "set", secret: "real-candidate-fixture" }, f.management), "MEMORY_OWNER_CREDENTIAL_CHANGED");
  assert.equal(await f.store.get(old), CREATE.secret); assert.equal(f.controller.context({}, f.management).pendingOperations[0].phase, "retired");
}));
test("actual Store crash after candidate put recovers only with matching original transient key", async () => actualStoreUsing(async f => {
  let interrupted = false; f.controller.fault = stage => { if (stage === "catalog-credential-put" && !interrupted) { interrupted = true; throw new Error("owned fixture interruption"); } };
  await assert.rejects(() => f.controller.apply(CREATE, f.management)); const pending = JSON.parse(fs.readFileSync(f.controller.file, "utf8")).operations[CREATE.operationId];
  assert.equal(pending.candidateFingerprint, null); assert.ok(f.store.getCredentialFingerprint(pending.candidateRef)); await f.restart();
  await rejected(() => f.controller.recover({ operationId: CREATE.operationId, mode: "resume" }, f.management), "MEMORY_OWNER_RECOVERY_REQUIRED");
  const result = await f.controller.recover({ operationId: CREATE.operationId, mode: "resume", secret: CREATE.secret }, f.management);
  assert.equal(result.ownerRevision, 1); assert.equal(f.store.listMetadata().length, 1); assert.equal(await f.store.get(pending.candidateRef), CREATE.secret);
}));
test("actual Store unrelated global revision and foreign credential namespaces survive withdrawal cleanup", async () => actualStoreUsing(async f => {
  const row = await f.controller.apply(CREATE, f.management); f.config.memory.search.providerRefs.openai = row.ownerRef;
  const owner = f.controller.resolveOwner({ agentId: "alpha", providerId: "openai", ownerRef: row.ownerRef }), fingerprint = f.store.getCredentialFingerprint(owner.credentialRef), before = f.store.getCredentialRevision(owner.credentialRef);
  await f.store.put("external-provider-credential-owned-elsewhere", "other-fixture-account-key", { kind: KIND });
  assert.ok(f.store.getCredentialRevision(owner.credentialRef) > before); assert.equal(f.store.getCredentialFingerprint(owner.credentialRef), fingerprint);
  await f.controller.apply({ action: "revoke", operationId: "actual-revoke", expectedCatalogRevision: 1, ownerRef: row.ownerRef, expectedOwnerRevision: 1 }, f.management);
  assert.equal(f.store.getCredentialFingerprint(owner.credentialRef), null); assert.equal(await f.store.get("external-provider-credential-owned-elsewhere"), "other-fixture-account-key");
  await f.restart(); assert.equal(f.controller.resolveOwner({ agentId: "alpha", providerId: "openai", ownerRef: row.ownerRef }), null);
}));
async function crashWorker(f, stage, request) {
  const source = `const fs=require('node:fs');const base=require(${JSON.stringify(require.resolve("../app/agent-service/private-file.js"))});
    const {MemoryProviderOwnerController,createMemoryOwnerManagementAuthority}=require(${JSON.stringify(require.resolve("../app/agent-service/memory-provider-owner-controller.cjs"))});
    const stage=${JSON.stringify(stage)}, target=${JSON.stringify(path.join(f.stateDir, "memory-provider-owners.json"))};
    function pause(){process.stdout.write('crash-window-ready\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
    const privateFiles={...base,atomicWritePrivateFile(file,bytes,options){
      const paths=new Map();let renamed=false;const injected=new Proxy(options.fs||fs,{get(object,key){
        if(key==='openSync')return (...args)=>{const fd=object.openSync(...args);paths.set(fd,args[0]);return fd;};
        if(key==='writeSync')return (...args)=>{const result=object.writeSync(...args);if((stage==='tmp-write'&&file===target||stage==='receipt-write'&&file.includes('memory-provider-owner-receipts'))&&String(paths.get(args[0])).includes('.owner-tmp-'))pause();return result;};
        if(key==='linkSync')return (...args)=>{const result=object.linkSync(...args);if(stage==='backup-link'&&file===target&&String(args[1]).includes('.backup-'))pause();return result;};
        if(key==='renameSync')return (...args)=>{const result=object.renameSync(...args);if(file===target&&args[1]===target){renamed=true;if(stage==='rename')pause();}return result;};
        if(key==='fsyncSync')return (...args)=>{const result=object.fsyncSync(...args);if(stage==='dir-fsync'&&file===target&&renamed&&paths.get(args[0])===${JSON.stringify(f.stateDir)})pause();return result;};
        return object[key];}});return base.atomicWritePrivateFile(file,bytes,{...options,fs:injected});}};
    const secretStore={listMetadata:()=>[],getCredentialFingerprint:()=>null,getCredentialRevision:()=>null,get:async()=>null,putIfRevision:async()=>{throw Error('no key write allowed');},withPlaintextMatcher:action=>action(()=>false)};
    const c=new MemoryProviderOwnerController({paths:${JSON.stringify(f.dependencies.paths)},secretStore,privateFiles,
      authorizeManagement:()=>createMemoryOwnerManagementAuthority(()=>true),assertServiceCurrent:()=>true,assertProfileCurrent:()=>true,
      getProfileIds:()=>['alpha','beta'],getConfig:()=>({}),retireOwners:async()=>{},leaseFault:point=>{if(point===stage)pause();}}).open();
    c.apply(${JSON.stringify(request)},{}).then(()=>{process.stdout.write('unexpected-complete\\n');process.exit(3);},error=>{process.stderr.write(error.code||'failed');process.exit(2);});`;
  const child = spawn(process.execPath, ["-e", source], { env: { PATH: "/usr/bin:/bin", TMPDIR: "/private/tmp", ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "", timer; child.stderr.on("data", bytes => { errors += bytes; });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`owned worker timeout at ${stage}: ${errors}`)), 10000);
    child.stdout.on("data", bytes => { output += bytes; if (output.includes("crash-window-ready")) resolve(); });
    child.once("error", reject); child.once("exit", () => reject(new Error(`owned worker exit at ${stage}: ${errors}`)));
  });
  try { await ready; child.kill("SIGKILL"); assert.equal((await exited).signal, "SIGKILL"); }
  finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; }
  return info => createMemoryOwnerStoppedLeaseAuthority(() => {
    assert.equal(info.pid, child.pid); try { process.kill(child.pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
  });
}
for (const stage of ["lease-created", "lease-prepared", "lease-linked", "tmp-write", "backup-link", "rename", "dir-fsync", "receipt-write"]) {
  test(`real owned SIGKILL at ${stage} permits only proven startup recovery and repeats one final owner revision`, async () => using({}, async f => {
    const initial = { ...CREATE, secretAction: "clear" }; delete initial.secret;
    const row = await f.controller.apply(initial, f.management); await f.controller.close();
    const request = { action: "update", operationId: "crashed-real-update", expectedCatalogRevision: 1, ownerRef: row.ownerRef,
      expectedOwnerRevision: 1, label: "Changed by owned worker", baseUrl: CREATE.baseUrl, secretAction: "preserve" };
    const proveStopped = await crashWorker(f, stage, request);
    const lockPath = path.join(f.stateDir, "memory-provider-owners.json.lock");
    if (fs.existsSync(lockPath)) recoverStoppedMemoryOwnerCatalogLock({ ...f.dependencies.paths, privateFiles, authorizeStoppedOwner: proveStopped });
    recoverStoppedMemoryOwnerCatalogFiles({ ...f.dependencies.paths, privateFiles, authorizeStoppedOwner: proveStopped });
    f.open(); const result = await f.controller.apply(request, f.management);
    assert.equal(result.ownerRevision, 2); assert.equal(result.catalogRevision, 2); assert.equal(f.secretStore.puts, 0);
    assert.deepEqual(await f.controller.apply(request, f.management), result);
    const names = fs.readdirSync(f.stateDir); assert.equal(names.some(name => name.endsWith(".tmp") || name.includes(".backup-") || name.includes(".owner-tmp-")), false);
    assert.equal(names.some(name => name.endsWith(".json") && name.includes(".owner-write-")), false);
  }));
}
test("a new key cannot collide with retained public metadata or historical requests of a different owner", async () => using({}, async f => {
  const futureKey = "opaque-next-key-ABC123"; await create(f, { label: futureKey, headers: { "X-Previous": futureKey } });
  const before = fs.readFileSync(f.controller.file);
  await rejected(() => create(f, { operationId: "different-account", expectedCatalogRevision: 1, secret: futureKey }), "MEMORY_OWNER_INVALID");
  assert.deepEqual(fs.readFileSync(f.controller.file), before); assert.equal(f.secretStore.puts, 1);
}));
test("prospective Context frame rejects oversized global catalog before reservation while preserving readable state", async () => using({}, async f => {
  const baseUrl = `http://127.0.0.1:43210/${"a".repeat(3950)}`; let successes = 0, rejectedCapacity = false;
  for (let index = 0; index < 24; index++) {
    const before = fs.existsSync(f.controller.file) ? fs.readFileSync(f.controller.file) : null;
    const request = { action: "create", operationId: `capacity-${index}`, expectedCatalogRevision: successes, scope: { kind: "global" },
      providerId: "openai", label: `Owner ${index}`, baseUrl, secretAction: "clear" };
    try { await f.controller.apply(request, f.management); successes++; }
    catch (error) { assert.equal(error.code, "MEMORY_OWNER_CAPACITY"); rejectedCapacity = true;
      assert.deepEqual(fs.readFileSync(f.controller.file), before); break; }
  }
  assert.equal(rejectedCapacity, true); assert.ok(successes > 0 && successes < 24);
  const dto = f.controller.context({}, f.management); assert.equal(dto.owners.length, successes); assert.equal(dto.pendingOperations.length, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(dto)) < 65536); assert.equal(f.secretStore.puts, 0);
}));
test("foreign backup hard-link with matching old bytes is preserved unless the immutable exact slot was reserved", async () => using({}, async f => {
  const request = { ...CREATE, secretAction: "clear" }; delete request.secret;
  const row = await f.controller.apply(request, f.management); await f.controller.close();
  const updateRequest = { action: "update", operationId: "crashed-real-update", expectedCatalogRevision: 1, ownerRef: row.ownerRef,
    expectedOwnerRevision: 1, label: "Changed by owned worker", baseUrl: CREATE.baseUrl, secretAction: "preserve" };
  const proveStopped = await crashWorker(f, "tmp-write", updateRequest), target = path.join(f.stateDir, "memory-provider-owners.json");
  recoverStoppedMemoryOwnerCatalogLock({ ...f.dependencies.paths, privateFiles, authorizeStoppedOwner: proveStopped });
  const foreign = `${target}.backup-999999-deadbeef12345678`; fs.linkSync(target, foreign);
  const names = fs.readdirSync(f.stateDir), before = fs.readFileSync(target);
  assert.throws(() => recoverStoppedMemoryOwnerCatalogFiles({ ...f.dependencies.paths, privateFiles, authorizeStoppedOwner: proveStopped }), error => error.code === "MEMORY_OWNER_STORAGE_CHANGED");
  assert.deepEqual(fs.readdirSync(f.stateDir), names); assert.deepEqual(fs.readFileSync(target), before); assert.equal(fs.existsSync(foreign), true);
  fs.unlinkSync(foreign); recoverStoppedMemoryOwnerCatalogFiles({ ...f.dependencies.paths, privateFiles, authorizeStoppedOwner: proveStopped }); f.open();
  assert.equal((await f.controller.apply(updateRequest, f.management)).ownerRevision, 2);
}));
test("stopped file recovery enforces trustedRoot before modifying owned evidence", async () => using({}, async f => {
  let once = true; f.controller.privateFiles = { ...privateFiles, atomicWritePrivateFile(target, bytes, options) {
    privateFiles.atomicWritePrivateFile(target, bytes, options); if (once && target === f.controller.file) { once = false; throw new Error("owned simulated commit ambiguity"); }
  } };
  await assert.rejects(() => create(f)); const token = JSON.parse(f.controller.lock.token).token; await f.controller.close();
  const outsideRoot = path.join(f.root, "unrelated-root"); fs.mkdirSync(outsideRoot, { mode: 0o700 });
  const names = fs.readdirSync(f.stateDir), file = f.controller.file, before = fs.readFileSync(file);
  const proof = info => createMemoryOwnerStoppedLeaseAuthority(() => info.token === token && !f.controller.opened);
  assert.throws(() => recoverStoppedMemoryOwnerCatalogFiles({ stateDir: f.stateDir, trustedRoot: outsideRoot, privateFiles, authorizeStoppedOwner: proof }), error => error.code === "UNSAFE_PATH");
  assert.deepEqual(fs.readdirSync(f.stateDir), names); assert.deepEqual(fs.readFileSync(file), before);
  recoverStoppedMemoryOwnerCatalogFiles({ ...f.dependencies.paths, privateFiles, authorizeStoppedOwner: proof }); f.open();
  assert.equal((await f.controller.recover({ operationId: CREATE.operationId, mode: "resume", secret: CREATE.secret }, f.management)).ownerRevision, 1);
}));
test("catalog uncertainty immediately withdraws admission and joins all existing physical resources before reporting failure", async () => using({}, async f => {
  const row = await create(f); f.bind(row.ownerRef); const entered = deferred(), release = deferred();
  f.controller.retireOwners = async packet => { assert.equal(packet.reason, "uncertain"); assert.deepEqual(packet.agentIds, ["alpha", "beta"]);
    assert.equal(packet.signal.aborted, true); entered.resolve(); await release.promise; };
  let once = true; f.controller.privateFiles = { ...privateFiles, atomicWritePrivateFile(target, bytes, options) {
    privateFiles.atomicWritePrivateFile(target, bytes, options); if (once && target === f.controller.file) { once = false; throw new Error("own commit ambiguity"); }
  } };
  const running = update(f, row); await entered.promise; let finished = false; running.catch(() => { finished = true; }); await Promise.resolve(); assert.equal(finished, false);
  assert.throws(() => f.controller.resolveOwner({ agentId: "alpha", providerId: "openai", ownerRef: row.ownerRef }), error => error.code === "MEMORY_OWNER_RETIRED");
  release.resolve(); await rejected(() => running, "MEMORY_OWNER_UNCERTAIN"); assert.equal(finished, true);
}));
test("shortening update still reserves pending Context budget against the actual old rows before its first write", async () => using({}, async f => {
  const frameBytes = dto => Buffer.byteLength(JSON.stringify({ id: "i".repeat(128), ok: true, result: dto })) + 1;
  let count = 0;
  while (65536 - frameBytes(f.controller.context({}, f.management)) > 4500) {
    await f.controller.apply({ action: "create", operationId: `large-${count}`, expectedCatalogRevision: count,
      scope: { kind: "global" }, providerId: "openai", label: `Large ${count}`, baseUrl: `http://127.0.0.1:43210/${"a".repeat(3950)}`, secretAction: "clear" }, f.management); count++;
  }
  const dto = f.controller.context({}, f.management), fakeOwner = "memory-owner-00000000-0000-4000-8000-000000000000";
  const row = { ownerRef: fakeOwner, label: "Padding", scope: { kind: "global" }, providerId: "openai", api: "openai-completions",
    baseUrl: "http://127.0.0.1:43210/x", revision: 1, status: "active", hasCredential: false };
  const prospective = { catalogRevision: count + 1, owners: [...dto.owners, row], pendingOperations: [{ operationId: "z", ownerRef: fakeOwner, phase: "credential_ready" }] };
  const pad = 65535 - frameBytes(prospective); assert.ok(pad >= 0 && row.baseUrl.length + pad <= 4096);
  const padding = await f.controller.apply({ action: "create", operationId: "z", expectedCatalogRevision: count,
    scope: { kind: "global" }, providerId: "openai", label: "Padding", baseUrl: row.baseUrl + "b".repeat(pad), secretAction: "clear" }, f.management);
  const before = fs.readFileSync(f.controller.file); let reservationHit = false;
  f.controller.fault = stage => { if (stage === "catalog-reserved") { reservationHit = true; throw new Error("reserved should be rejected before writing"); } };
  await rejected(() => f.controller.apply({ action: "update", operationId: "u".repeat(128), expectedCatalogRevision: count + 1, ownerRef: padding.ownerRef,
    expectedOwnerRevision: 1, label: "Short", baseUrl: CREATE.baseUrl, secretAction: "clear" }, f.management), "MEMORY_OWNER_CAPACITY");
  assert.equal(reservationHit, false); assert.deepEqual(fs.readFileSync(f.controller.file), before);
  assert.equal(f.controller.context({}, f.management).pendingOperations.length, 0); assert.equal(f.secretStore.puts, 0);
}));
test("locked SecretStore mutation withdraws all provider admission and joins physical retirement before returning recovery error", async () => using({}, async f => {
  const row = await create(f); f.bind(row.ownerRef); const entered = deferred(), release = deferred();
  f.controller.retireOwners = async packet => { assert.equal(packet.reason, "uncertain"); assert.equal(packet.signal.aborted, true); entered.resolve(); await release.promise; };
  f.secretStore.putFault = async () => { f.secretStore.putFault = null; throw Object.assign(new Error("synthetic encryption authority locked"), { code: "credentials_locked" }); };
  let returned = false; const running = update(f, row, { secretAction: "set", secret: "invented-locked-authority-new-key-1982" });
  const checked = rejected(() => running, "MEMORY_OWNER_RECOVERY_REQUIRED").then(() => { returned = true; });
  await entered.promise; assert.equal(returned, false);
  assert.throws(() => f.controller.resolveOwner({ agentId: "alpha", providerId: "openai", ownerRef: row.ownerRef }), { code: "MEMORY_OWNER_RETIRED" });
  assert.ok(ledger(f).operations["update-account"].candidateRef); release.resolve(); await checked;
  await f.controller.close(); f.open();
  assert.equal((await f.controller.recover({ operationId: "update-account", mode: "resume", secret: "invented-locked-authority-new-key-1982" }, f.management)).phase, "completed");
}));
test("known SecretStore uncertainty discovered during synchronous metadata admission keeps a physical retirement tail for close", async () => using({}, async f => {
  const row = await create(f); f.bind(row.ownerRef); const entered = deferred(), release = deferred();
  f.controller.retireOwners = async packet => { assert.deepEqual(packet.agentIds, ["alpha", "beta"]); assert.equal(packet.signal.aborted, true); entered.resolve(); await release.promise; };
  f.secretStore.commitUncertain = true;
  assert.throws(() => f.controller.context({}, f.management), { code: "MEMORY_OWNER_RETIRED" }); await entered.promise;
  let done = false; const closing = f.controller.close().then(() => { done = true; }); await Promise.resolve(); assert.equal(done, false);
  release.resolve(); await closing; assert.equal(done, true); f.secretStore.commitUncertain = false;
}));
