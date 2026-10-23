"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { MemoryStore } = require("../app/agent-service/memory-store");
const { ChatSessionStore } = require("../app/agent-service/chat-session-store");
const { JsonlProductStore, DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { MemoryEngine } = require("../app/agent-service/memory-engine");
const { RecallPolicyStore } = require("../app/agent-service/recall-policy-store");
const { verifyLegacyRollback, captureLegacyRollbackAuthority, captureLegacyRollbackAuxiliaryAuthority } = require("../app/agent-service/shoggoth-memory/legacy-rollback-verifier.cjs");

const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function item(id, fields = {}) {
  return { id, profileId: "one", scope: "agent", type: "semantic", content: `${id} telescope calibration notes`, sourceRefs: [`user-edit:${id}`],
    confidence: 1, sensitivity: "normal", status: "active", validFrom: 0, validUntil: null, supersedes: null, createdAt: 1000, updatedAt: 1000, ...fields };
}
function disk(root) {
  const result = [];
  const walk = target => {
    for (const entry of fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = path.join(target, entry.name), stat = fs.lstatSync(next);
      if (entry.isDirectory()) { result.push([next, stat.dev, stat.ino, stat.mode]); walk(next); }
      else result.push([next, sha(fs.readFileSync(next)), stat.dev, stat.ino, stat.mode, stat.mtimeMs, stat.ctimeMs]);
    }
  };
  walk(root); return result;
}
// All catalog and session authorities are created before migration/planning.
// The real Product catalog keeps its built-in peer; every actual Profile gets
// its original MemoryStore and sealed RecallPolicy resources below.
function authorizationCatalog(paths, memoryStore, now) {
  const product = new JsonlProductStore({ paths, now }); product.open();
  const { bindings, bindingOperations, defaultBindingId, bindingsRevision, ...base } = product.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  product.putAgentProfile({ ...base, id: "one", name: "Synthetic rollback owner",
    agentId: "synthetic-rollback-owner", runtimeProfileId: "synthetic-rollback-owner", isDefault: false, defaultCwd: null });
  const profiles = product.listAgentProfiles().map(profile => profile.id);
  const sessions = new ChatSessionStore({ paths, now }); sessions.open();
  for (const profileId of profiles) {
    sessions.createSession({ operationId: `synthetic-session-${profileId}`, profileId, workspace: null, createdAt: now() });
    if (profileId !== "one") memoryStore.ensureProfile(profileId);
  }
  sessions.close(); product.close();
  return profiles;
}

function fixture(t, { addCount = 2, empty = false } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-legacy-rollback-verify-")); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const store = new MemoryStore({ paths }); store.open();
  const profiles = authorizationCatalog(paths, store, () => 5000);
  const rows = [item("original"), item("hidden", { content: "Forgotten azure calibration preference", sourceRefs: ["withdrawn-event", "withdrawn-run"] }),
    item("copy", { content: "Forgotten azure calibration preference" }), item("sibling", { content: "Distinct withdrawn source brother", sourceRefs: ["withdrawn-event", "withdrawn-run"] }),
    item("expired", { validUntil: 9000 }), item("candidate", { status: "candidate" }), item("restricted", { sensitivity: "restricted" }),
    item("private", { sensitivity: "private" }), item("untrusted", { sourceRefs: ["untrusted:external"] }), item("future", { validFrom: 11000 })];
  if (!empty) store.upsertMany(rows);
  const policy = new RecallPolicyStore({ paths, memoryStore: store, now: () => 5000 }); policy.open(profiles);
  if (!empty) {
    policy.recordReason({ profileId: "one", item: rows[1], reason: "forgotten", operationId: "initial-hidden" });
    store.upsert({ ...rows[1], status: "deleted", updatedAt: 5000 });
  }
  const base = store.list("one"), baseRevision = store.getRevision("one");
  const profile = path.join(paths.agentsDir, "one"), migration = path.join(profile, "memory-migration-shoggoth-v1"), workspace = path.join(profile, "memory-workspace");
  for (const target of [migration, path.join(migration, "backup"), workspace, path.join(workspace, "memory"), path.join(profile, "generated")]) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const [target, content] of [[path.join(migration, "manifest.json"), '{"profileId":"one","phase":"active"}\n'],
    [path.join(migration, "legacy-snapshot.json"), JSON.stringify(base) + "\n"], [path.join(workspace, "MEMORY.md"), "# New file authority\n"],
    [path.join(workspace, "USER.md"), "# User\n"], [path.join(workspace, ".shoggoth-memory-migration.json"), '{"profileId":"one"}\n'],
    [path.join(profile, "generated", "MEMORY.md"), "# Retained generated memory\n"], [path.join(migration, "backup", "events.jsonl"), empty ? Buffer.alloc(0) : fs.readFileSync(path.join(profile, "memory", "events.jsonl"))]]) fs.writeFileSync(target, content, { mode: 0o600 });
  const added = Array.from({ length: addCount }, (_, index) => item(`new-${String(index).padStart(3, "0")}`, { content: `Unique new-${String(index).padStart(3, "0")} postmigration violet telescope fact`, createdAt: 7000, updatedAt: 7000 }));
  const batches = [];
  for (let index = 0; index < added.length; index += 128) {
    const batch = added.slice(index, index + 128); batches.push({ expectedRevision: store.getRevision("one"), items: batch }); store.upsertMany(batch);
  }
  const policyState = policy._read("one", policy._paths("one"));
  const plan = { format: "shoggoth-stopped-memory-rollback-plan", schemaVersion: 1, profileId: "one", mappingReady: true, blockers: [],
    snapshot: { legacyRecords: base, recallRecords: policyState.records, revisions: { legacy: baseRevision, recall: policyState.revision },
      legacyFiles: [], files: [], backupFiles: [], product: { files: [] }, core: { files: [] } }, journalBatches: batches,
    operations: added.map(after => ({ id: after.id, before: null, after })) };
  store.close(); policy.close();
  const verify = (options = {}) => verifyLegacyRollback({ paths, profileId: "one", plan, now: 10000, assertCurrent: () => true, ...options });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, paths, profile, migration, workspace, plan, added, verify };
}
function mutatePlanToCurrent(f) {
  const store = new MemoryStore({ paths: f.paths, readOnly: true }); store.opened = true;
  try { f.plan.snapshot.legacyRecords = store.list("one"); f.plan.snapshot.revisions.legacy = store.getRevision("one"); }
  finally { store.close(); }
  f.plan.journalBatches = []; f.plan.operations = [];
  const policy = new RecallPolicyStore({ paths: f.paths, memoryStore: {} });
  const state = policy._read("one", policy._paths("one"));
  f.plan.snapshot.recallRecords = state.records; f.plan.snapshot.revisions.recall = state.revision;
}

test("real readOnly Store, original sealed Policy and Engine search preserve new facts and all exclusion gates without authority writes", t => {
  const f = fixture(t), before = disk(f.root), result = f.verify();
  assert.equal(result.valid, true); assert.equal(result.legacySearchVerified, true); assert.equal(result.withdrawalVerified, true);
  assert.equal(result.futureAuthorizationVerified, true); assert.equal(result.authorityPreserved, true);
  assert.equal(result.legacyRevision, 3); assert.equal(result.recallRevision, 2);
  assert.deepEqual(result.visibleIds, ["new-000", "new-001", "original", "private"]);
  assert.deepEqual(result.excluded.map(row => row.id), ["candidate", "copy", "expired", "future", "hidden", "restricted", "sibling", "untrusted"]);
  assert.equal(result.future.length, 1); assert.equal(result.future[0].checks.length, 8);
  assert.ok(result.future[0].checks.includes("mixed-revoked-source"));
  assert.match(result.authorityHash, /^[a-f0-9]{64}$/u); assert.ok(result.authorityFileCount >= 23);
  assert.deepEqual(disk(f.root), before);
  assert.equal(JSON.stringify(result).includes(f.added[0].content), false, "evidence must not expose fact bodies");
  assert.ok(Object.isFrozen(result.future[0].checks));
});

test("verification never starts either owner, opens writable stores, reconciles policy, quarantines or builds persisted views", t => {
  const f = fixture(t), originals = [];
  const block = (object, key) => { originals.push([object, key, object[key]]); object[key] = () => { throw new Error(`forbidden verification side effect: ${key}`); }; };
  for (const [object, methods] of [[MemoryStore.prototype, ["open", "upsert", "upsertMany", "_writeSnapshot"]],
    [MemoryEngine.prototype, ["open", "_rebuildViews", "_quarantineUnreceiptedReviewed"]],
    [RecallPolicyStore.prototype, ["open", "_reconcile", "_init", "_append"]],
    [fs, ["mkdirSync", "chmodSync", "fchmodSync", "writeFileSync", "appendFileSync", "renameSync", "unlinkSync", "ftruncateSync", "fsyncSync"]]]) {
    for (const key of methods) block(object, key);
  }
  try { assert.equal(f.verify().authorityPreserved, true); }
  finally { for (const [object, key, value] of originals) object[key] = value; }
});

test("129 concrete new facts across two real journal batches are retrieved individually despite the search limit", t => {
  const f = fixture(t, { addCount: 129 }), before = disk(f.root), result = f.verify();
  assert.equal(result.legacyRevision, 4); assert.equal(result.visibleIds.filter(id => id.startsWith("new-")).length, 129);
  assert.deepEqual(disk(f.root), before);
});

test("incomplete journals and private atomic-write leftovers fail closed without repair", t => {
  const f = fixture(t), journal = path.join(f.profile, "memory", "events.jsonl"), original = fs.readFileSync(journal);
  fs.appendFileSync(journal, '{"unfinished":'); let before = disk(f.root);
  assert.throws(() => f.verify(), { code: "MEMORY_ROLLBACK_TRANSACTION_UNSETTLED" }); assert.deepEqual(disk(f.root), before);
  fs.writeFileSync(journal, original);
  fs.writeFileSync(path.join(f.profile, "memory", "snapshot.json.tmp"), "pending", { mode: 0o600 }); before = disk(f.root);
  assert.throws(() => f.verify(), { code: "MEMORY_ROLLBACK_TRANSACTION_UNSETTLED" }); assert.deepEqual(disk(f.root), before);
});

test("real checksum/seal/install marker and independent anchor failures cannot become a policy boolean", t => {
  const f = fixture(t);
  const targets = [path.join(f.profile, "memory", "recall-policy.jsonl"), path.join(f.profile, "memory", "recall-policy.seal.json"),
    path.join(f.profile, "recall-policy-installed.json"), path.join(f.paths.agentsDir, ".recall-policy-installations", "one.json")];
  for (const target of targets) {
    const original = fs.readFileSync(target), corrupt = original.toString().replace(/[a-f0-9]{64}/u, "f".repeat(64));
    assert.notEqual(corrupt, original.toString()); fs.writeFileSync(target, corrupt); const before = disk(f.root);
    assert.throws(() => f.verify(), { code: "RECALL_POLICY_CORRUPT" }); assert.deepEqual(disk(f.root), before);
    fs.writeFileSync(target, original);
  }
});

test("synchronous source proof is mandatory and post-check authority changes are detected for generated and SQLite sidecar files", t => {
  const f = fixture(t), before = disk(f.root);
  assert.throws(() => f.verify({ assertCurrent: undefined }), { code: "MEMORY_ROLLBACK_STOP_PROOF_REQUIRED" });
  assert.throws(() => f.verify({ assertCurrent: () => false }), { code: "MEMORY_ROLLBACK_SOURCE_CHANGED" });
  assert.throws(() => f.verify({ assertCurrent: () => Promise.resolve(true) }), { code: "MEMORY_ROLLBACK_SOURCE_CHANGED" });
  assert.deepEqual(disk(f.root), before);
  let checks = 0;
  assert.throws(() => f.verify({ assertCurrent: () => { if (++checks === 2) fs.appendFileSync(path.join(f.profile, "generated", "MEMORY.md"), "changed\n"); } }), { code: "MEMORY_ROLLBACK_SOURCE_CHANGED" });
  checks = 0;
  assert.throws(() => f.verify({ assertCurrent: () => { if (++checks === 2) fs.writeFileSync(path.join(f.paths.stateDir, "shoggoth-memory.sqlite-wal"), "changed", { mode: 0o600 }); } }), { code: "MEMORY_ROLLBACK_SOURCE_CHANGED" });
});

test("the full post-apply target and retained policy revision must match, with no silent missing facts", t => {
  const f = fixture(t), before = disk(f.root);
  assert.throws(() => f.verify({ expectedRecords: f.plan.snapshot.legacyRecords }), { code: "MEMORY_ROLLBACK_PLAN_INVALID" });
  const saved = f.plan.journalBatches; f.plan.journalBatches = [];
  assert.throws(() => f.verify(), { code: "MEMORY_ROLLBACK_LEGACY_TARGET_MISMATCH" }); f.plan.journalBatches = saved;
  f.plan.snapshot.revisions.recall += 1;
  assert.throws(() => f.verify(), { code: "MEMORY_ROLLBACK_RECALL_MISMATCH" });
  assert.deepEqual(disk(f.root), before);
});

test("unsettled real withdrawal intent and replaced expiry primary proof never trigger writable reconciliation", t => {
  const f = fixture(t), store = new MemoryStore({ paths: f.paths }); store.open();
  const hidden = store.get("one", "hidden"); store.upsert({ ...hidden, status: "active" }); store.close(); mutatePlanToCurrent(f);
  let before = disk(f.root); assert.throws(() => f.verify(), { code: "MEMORY_ROLLBACK_TRANSACTION_UNSETTLED" }); assert.deepEqual(disk(f.root), before);
  store.open(); store.upsert(hidden);
  const expired = store.get("one", "expired"), policy = new RecallPolicyStore({ paths: f.paths, memoryStore: store, now: () => 10000 }); policy.open(["one"]);
  policy.recordReason({ profileId: "one", item: expired, reason: "expired", operationId: "expiry-intent" });
  const deleted = { ...expired, status: "deleted", updatedAt: 10000 }; store.upsert(deleted);
  policy.recordExpiryCommit({ profileId: "one", item: deleted, operationId: "expiry-intent" }); policy.close(); store.close(); mutatePlanToCurrent(f);
  assert.equal(f.verify().valid, true, "a genuine completed expiry is accepted");
  store.open(); store.upsert({ ...deleted, updatedAt: 10001 }); store.close(); mutatePlanToCurrent(f); before = disk(f.root);
  assert.throws(() => f.verify(), { code: "MEMORY_ROLLBACK_TRANSACTION_UNSETTLED" }); assert.deepEqual(disk(f.root), before);
});

test("a real higher content withdrawal cutoff cannot trap the next legacy authorization behind a smaller journal sequence", t => {
  const f = fixture(t), journal = path.join(f.profile, "memory", "events.jsonl"), snapshot = path.join(f.profile, "memory", "snapshot.json");
  const savedJournal = fs.readFileSync(journal), savedSnapshot = fs.readFileSync(snapshot);
  const store = new MemoryStore({ paths: f.paths }); store.open();
  const hidden = store.get("one", "hidden"), original = store.get("one", "original");
  for (let index = 0; index < 8; index++) store.upsert({ ...original, updatedAt: 10000 + index });
  const policy = new RecallPolicyStore({ paths: f.paths, memoryStore: store, now: () => 15000 }); policy.open(["one"]);
  policy.recordReason({ profileId: "one", item: hidden, reason: "forgotten", operationId: "new-high-cutoff" }); policy.close(); store.close();
  fs.writeFileSync(journal, savedJournal); fs.writeFileSync(snapshot, savedSnapshot); mutatePlanToCurrent(f); const before = disk(f.root);
  assert.throws(() => f.verify(), { code: "MEMORY_ROLLBACK_FUTURE_REVISION_FENCE" }); assert.deepEqual(disk(f.root), before);
});

test("symlink, hardlink and non-memory manifest paths are rejected before any authority mutation", t => {
  const f = fixture(t), target = path.join(f.workspace, "memory", "unsafe.md"), outside = path.join(f.root, "unrelated.txt");
  fs.writeFileSync(outside, "unrelated", { mode: 0o600 }); fs.symlinkSync(outside, target);
  assert.throws(() => f.verify(), { code: "MEMORY_ROLLBACK_PATH_UNSAFE" }); fs.unlinkSync(target);
  fs.linkSync(outside, target); assert.throws(() => f.verify(), { code: "UNSAFE_HARDLINK" }); fs.unlinkSync(target);
  f.plan.snapshot.files.push({ path: outside }); const before = disk(f.root);
  assert.throws(() => f.verify(), { code: "MEMORY_ROLLBACK_PATH_UNSAFE" }); assert.deepEqual(disk(f.root), before);
});


test("101 identical actual facts bypass only ranking truncation through actual-record readOnly projections", t => {
  const f = fixture(t, { addCount: 101 }), store = new MemoryStore({ paths: f.paths }); store.open();
  store.upsertMany(f.added.map(record => ({ ...record, content: "Identical jade astronomy preference", updatedAt: 8000 })));
  store.close(); mutatePlanToCurrent(f); const before = disk(f.root), result = f.verify();
  assert.equal(result.individualSearchProjectionVerified, true);
  assert.equal(result.visibleIds.filter(id => id.startsWith("new-")).length, 101);
  assert.equal(result.fullSearchReturnedIds.filter(id => id.startsWith("new-")).length, 100, "actual full-store search keeps the original top-100 cap");
  assert.deepEqual(disk(f.root), before);
});

test("a genuine empty legacy authority proves a no-op without creating events.jsonl or snapshot.json", t => {
  const f = fixture(t, { addCount: 0, empty: true }), journal = path.join(f.profile, "memory", "events.jsonl"), snapshot = path.join(f.profile, "memory", "snapshot.json");
  assert.equal(fs.existsSync(journal), false); assert.equal(fs.existsSync(snapshot), false);
  const before = disk(f.root), result = f.verify({ expectedRecords: [] });
  assert.equal(result.legacyRevision, 0); assert.equal(result.recallRevision, 1); assert.deepEqual(result.visibleIds, []);
  assert.equal(result.authorityPreserved, true); assert.deepEqual(disk(f.root), before);
  assert.equal(fs.existsSync(journal), false); assert.equal(fs.existsSync(snapshot), false);
  f.plan.journalBatches = [{ expectedRevision: 0, items: [item("must-exist")] }];
  assert.throws(() => f.verify(), { code: "MEMORY_ROLLBACK_SOURCE_MISSING" }); assert.deepEqual(disk(f.root), before);
});

test("full and auxiliary captures preserve extra authority while only fixed, proven native primary artifacts can be excluded", t => {
  const f = fixture(t), options = { paths: f.paths, profileId: "one", plan: f.plan };
  const full = captureLegacyRollbackAuthority(options), auxiliary = captureLegacyRollbackAuxiliaryAuthority(options);
  assert.equal(Object.isFrozen(full.files[0]), true); assert.equal(auxiliary.primaryExcluded, true);
  assert.ok(full.files.some(file => file.path.endsWith("generated/MEMORY.md")));
  assert.ok(!auxiliary.files.some(file => file.path === path.join(f.profile, "memory", "events.jsonl")));
  const snapshot = path.join(f.profile, "memory", "snapshot.json"), artifactName = "snapshot.json.backup-123-0123456789abcdef";
  fs.linkSync(snapshot, path.join(f.profile, "memory", artifactName));
  assert.throws(() => captureLegacyRollbackAuthority(options));
  assert.throws(() => captureLegacyRollbackAuxiliaryAuthority(options), { code: "MEMORY_ROLLBACK_TRANSACTION_UNSETTLED" });
  const owned = captureLegacyRollbackAuxiliaryAuthority({ ...options, ownedSnapshotArtifactsNames: [artifactName] });
  assert.deepEqual(owned, auxiliary, "caller-proven native primary artifact is excluded only from auxiliary evidence");
  assert.throws(() => captureLegacyRollbackAuxiliaryAuthority({ ...options, ownedSnapshotArtifactsNames: ["../elsewhere"] }), { code: "MEMORY_ROLLBACK_PATH_UNSAFE" });
  assert.throws(() => captureLegacyRollbackAuxiliaryAuthority({ ...options, ownedSnapshotArtifactsNames: ["snapshot.json.backup-foreign"] }), { code: "MEMORY_ROLLBACK_PATH_UNSAFE" });
  fs.unlinkSync(path.join(f.profile, "memory", artifactName));
  fs.writeFileSync(path.join(f.workspace, "MEMORY.md.backup-foreign"), "foreign", { mode: 0o600 }); const before = disk(f.root);
  assert.throws(() => captureLegacyRollbackAuthority(options), { code: "MEMORY_ROLLBACK_TRANSACTION_UNSETTLED" });
  assert.throws(() => captureLegacyRollbackAuxiliaryAuthority(options), { code: "MEMORY_ROLLBACK_TRANSACTION_UNSETTLED" });
  assert.deepEqual(disk(f.root), before);
});


test("readOnly capture accepts blocked planning preimages without granting apply verification", t => {
  const f = fixture(t), options = { paths: f.paths, profileId: "one", plan: f.plan };
  const expected = captureLegacyRollbackAuthority(options), expectedAuxiliary = captureLegacyRollbackAuxiliaryAuthority(options);
  const blocked = { ...f.plan, mappingReady: false, blockers: [{ code: "UNPROVEN_PROVENANCE" }] }, before = disk(f.root);
  assert.deepEqual(captureLegacyRollbackAuthority({ ...options, plan: blocked }), expected);
  assert.deepEqual(captureLegacyRollbackAuxiliaryAuthority({ ...options, plan: { snapshot: f.plan.snapshot } }), expectedAuxiliary);
  assert.throws(() => f.verify({ plan: blocked }), { code: "MEMORY_ROLLBACK_PLAN_INVALID" });
  assert.throws(() => captureLegacyRollbackAuthority({ ...options, profileId: "../outside" }), { code: "MEMORY_ROLLBACK_PLAN_INVALID" });
  assert.throws(() => captureLegacyRollbackAuthority({ ...options, plan: { profileId: "two", snapshot: f.plan.snapshot } }), { code: "MEMORY_ROLLBACK_PLAN_INVALID" });
  assert.deepEqual(disk(f.root), before);
});
