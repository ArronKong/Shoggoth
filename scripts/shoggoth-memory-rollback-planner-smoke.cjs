"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { MemoryStore } = require("../app/agent-service/memory-store");
const { ChatSessionStore } = require("../app/agent-service/chat-session-store");
const { JsonlProductStore, DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { RecallPolicyStore } = require("../app/agent-service/recall-policy-store");
const { MemoryDatabase } = require("../app/agent-service/shoggoth-memory/database.cjs");
const { ShoggothMemoryMigration, sha256, renderMemoryEntry } = require("../app/agent-service/shoggoth-memory/migration.cjs");
const { FileMemoryStore } = require("../app/agent-service/shoggoth-memory/file-store.cjs");
const { ShoggothMemoryHost } = require("../app/agent-service/shoggoth-memory/host.cjs");
const { MAX_FILE_BYTES } = require("../app/agent-service/shoggoth-memory/rollback-planner.cjs");

function item(id, { scope = "agent", status = "active", content = `${id} telescope calibration notes`, now = 1000, ...fields } = {}) {
  return { id, profileId: "one", scope, type: "semantic", content, sourceRefs: [`user-edit:${id}`], confidence: 1,
    sensitivity: "normal", status, validFrom: 0, validUntil: null, supersedes: null, createdAt: now, updatedAt: now, ...fields };
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

function fixture(t, fault = () => {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-memory-rollback-plan-")); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  let now = 10000, stopped = false;
  const legacy = new MemoryStore({ paths }); legacy.open();
  const profiles = authorizationCatalog(paths, legacy, () => now);
  const records = [item("original"), item("hidden"), item("expired", { validUntil: 9000 }), item("candidate", { status: "candidate" }), item("shared-old", { scope: "user" })];
  legacy.upsertMany(records);
  const policy = new RecallPolicyStore({ paths, memoryStore: legacy, now: () => now }); policy.open(profiles);
  policy.recordReason({ profileId: "one", item: records[1], reason: "forgotten", operationId: "initial-hidden" });
  const names = ["events.jsonl", "snapshot.json", "recall-policy.jsonl", "recall-policy.seal.json"];
  const files = [...names.map(name => ({ name, path: path.join(paths.agentsDir, "one", "memory", name) })),
    { name: "recall-policy-installed.json", path: path.join(paths.agentsDir, "one", "recall-policy-installed.json") },
    { name: "recall-policy-installation.json", path: path.join(paths.agentsDir, ".recall-policy-installations", "one.json") }];
  const migration = new ShoggothMemoryMigration({ paths, now: () => now, fault,
    readLegacy: profileId => ({ records: legacy.list(profileId), files, revision: legacy.getRevision(profileId), recallRevision: policy.getRevision(profileId),
      contentRevisions: Object.fromEntries(records.map(record => [record.id, legacy.getContentRevision(profileId, record.id)])),
      visibleIds: legacy.list(profileId).filter(record => record.status === "active" && policy.isMemoryVisible(profileId, record)).map(record => record.id) }),
    assertLegacyCurrent: (profileId, snapshot, saved) => { assert.equal(snapshot.revision, legacy.getRevision(profileId));
      for (const file of saved) assert.equal(sha256(fs.readFileSync(file.source)), file.sha256); } });
  const database = new MemoryDatabase({ paths, now: () => now }); database.open();
  const workspace = migration.locations("one").workspace;
  const host = new ShoggothMemoryHost({ paths, database, profileId: "one", workspaceDir: workspace,
    roster: () => [{ id: "one", workspace }], sessions: { list: () => [] } });
  const store = new FileMemoryStore({ paths, database, migration, getHost: () => host, now: () => now }); store.open(); store.ensureProfile("one");
  let expected;
  const stop = ({ allowUnsettled = false } = {}) => {
    if (stopped) return;
    expected = { legacy: legacy.getRevision("one"), file: allowUnsettled
      ? database.db.prepare("SELECT revision FROM memory_file_profiles WHERE profile_id='one'").get().revision : store.getRevision("one"), recall: policy.getRevision("one") };
    store.close(); database.close(); legacy.close(); policy.close(); stopped = true;
  };
  const options = () => ({ assertServiceStopped: () => { assert.equal(stopped, true, "fixture Service is still running"); }, expectedRevisions: expected });
  const plan = () => migration.planRollback("one", options());
  const readOld = () => { const readonly = new MemoryStore({ paths, readOnly: true }); readonly.open();
    try { return readonly.list("one"); } finally { readonly.close(); } };
  t.after(() => { stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, paths, records, policy, migration, database, store, workspace, stop, options, plan, readOld, setNow: value => { now = value; } };
}

test("stopped planner captures actual canonical authority and proposes agent records without applying or changing the old owner", async t => {
  const f = fixture(t), added = item("new-agent", { content: "Zircon panorama postmigration observation", now: 12000 });
  await f.store.upsert(added); f.stop();
  const before = f.readOld(), plan = f.plan();
  assert.equal(plan.mappingReady, true); assert.equal(plan.canApply, false); assert.equal(plan.canSelectLegacyWriter, false);
  assert.deepEqual(plan.operations.map(operation => operation.after), [added]);
  assert.deepEqual(plan.journalBatches, [{ expectedRevision: 1, items: [added] }]);
  assert.deepEqual(plan.snapshot.files.filter(file => file.name.endsWith(".md")).map(file => file.name), ["MEMORY.md", "USER.md"]);
  assert.ok(plan.snapshot.files.find(file => file.name === "MEMORY.md").text.includes(added.content));
  assert.deepEqual(f.readOld(), before, "a plan is not an imported or searchable legacy fact");
  for (const file of [...plan.snapshot.product.files, ...plan.snapshot.core.files]) {
    assert.equal(fs.existsSync(file.path), file.present, "read-only planning must not create source SQLite sidecars");
    if (file.present) assert.equal(sha256(fs.readFileSync(file.path)), file.sha256, "read-only planning preserves actual database bytes");
  }
  assert.equal(f.readOld().some(record => record.id === added.id), false);
  assert.ok(Object.isFrozen(plan.operations[0].after.sourceRefs));
  assert.throws(() => { plan.operations[0].after.content = "changed"; }, TypeError);
  assert.deepEqual(f.plan(), plan, "repeated planning returns exactly the same immutable plan");
  assert.equal(f.migration.verifyRollbackPlan("one", { ...f.options(), planHash: plan.planHash, ownershipHash: plan.ownershipHash }).valid, true);
  assert.match(fs.readFileSync(plan.planPath, "utf8"), /apply-and-crash-recovery/u);
});

test("untouched hidden, expired, candidate and shared legacy preimages retain their exact original status and content revision", t => {
  const f = fixture(t); f.stop(); const plan = f.plan();
  assert.deepEqual(plan.operations, []); assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.snapshot.legacyRecords, f.readOld());
  assert.equal(plan.snapshot.metadata.find(record => record.id === "hidden").status, "deleted");
  assert.equal(plan.snapshot.legacyRecords.find(record => record.id === "hidden").status, "active");
  for (const id of ["hidden", "expired", "candidate", "shared-old"]) assert.equal(plan.snapshot.legacyContentRevisions[id], 1);
});

test("stopped proof and all three revision CAS values are required before a plan can be published", t => {
  const f = fixture(t);
  assert.throws(() => f.migration.planRollback("one", {}), { code: "MEMORY_ROLLBACK_STOP_PROOF_REQUIRED" });
  assert.throws(() => f.migration.planRollback("one", { assertServiceStopped: () => false }), { code: "MEMORY_ROLLBACK_SERVICE_RUNNING" });
  assert.throws(() => f.migration.planRollback("one", { assertServiceStopped: () => Promise.resolve(true) }), { code: "MEMORY_ROLLBACK_SERVICE_RUNNING" });
  assert.throws(() => f.plan(), /still running/u);
  f.stop();
  assert.throws(() => f.migration.planRollback("one", { assertServiceStopped: () => {} }), { code: "MEMORY_ROLLBACK_CAS_REQUIRED" });
  const options = f.options(); options.expectedRevisions = { ...options.expectedRevisions, file: options.expectedRevisions.file + 1 };
  assert.throws(() => f.migration.planRollback("one", options), { code: "MEMORY_ROLLBACK_REVISION_CONFLICT" });
  assert.equal(fs.existsSync(path.join(f.migration.locations("one").directory, "rollback-plans")), false);
});

test("snapshot includes nested daily files and core provenance; unmapped prose, promotion and shared scope are explicit blockers", async t => {
  const f = fixture(t);
  await f.store.upsert(item("new-user", { scope: "user" }));
  fs.mkdirSync(path.join(f.workspace, "memory", "nested"), { mode: 0o700 });
  fs.writeFileSync(path.join(f.workspace, "memory", "nested", "notes.md"), "# Notes\n\nUnidentified lapis observatory fact\n", { mode: 0o600 });
  fs.appendFileSync(path.join(f.workspace, "MEMORY.md"), "\n<!-- openclaw-memory-promotion:remembered-source -->\n- Provenance cannot be laundered into a user edit.\n");
  const core = new MemoryDatabase({ paths: f.paths, databasePath: path.join(f.paths.agentsDir, "one", "memory-core.sqlite") }); core.open();
  core.db.prepare("INSERT INTO memory_promotion_sources VALUES (?,?,?,?,?)").run("retained-key", "../library/memory/a.md", 2, 7, "a".repeat(64)); core.close();
  f.stop(); const plan = f.plan(), codes = plan.blockers.map(blocker => blocker.code);
  assert.ok(codes.includes("UNIDENTIFIED_FILE_FACT")); assert.ok(codes.includes("PROMOTION_SOURCE_SEMANTICS")); assert.ok(codes.includes("LEGACY_SHARED_SCOPE_SEMANTICS"));
  assert.ok(plan.snapshot.files.some(file => file.name === "memory/nested/notes.md"));
  assert.equal(plan.snapshot.core.tables.memory_promotion_sources[0].source_hash, "a".repeat(64));
  assert.equal(plan.journalBatches.length, 0); assert.equal(plan.mappingReady, false);
});

test("flush evidence, unknown compatibility fields and edited ID text cannot be silently discarded", async t => {
  const f = fixture(t);
  await f.store.upsert({ ...item("flush-proof"), sourceEvidence: [{ sessionId: "s", seq: 1, hash: "b".repeat(64) }] });
  await f.store.upsert({ ...item("future-proof"), futureAuthority: "unknown-semantics" });
  fs.appendFileSync(path.join(f.workspace, "USER.md"), renderMemoryEntry(item("orphan-id")));
  const memory = path.join(f.workspace, "MEMORY.md"); fs.writeFileSync(memory, fs.readFileSync(memory, "utf8").replace("original telescope", "rewritten telescope"));
  f.stop(); const plan = f.plan(), codes = plan.blockers.map(blocker => blocker.code);
  assert.ok(codes.includes("ADDITIONAL_RECORD_SEMANTICS")); assert.ok(codes.includes("FILE_EDIT_WITHOUT_COMPATIBLE_PROVENANCE")); assert.ok(codes.includes("FILE_ID_WITHOUT_METADATA"));
  assert.deepEqual(plan.operations, []); assert.equal(plan.mappingReady, false);
});

test("legacy search must not gain visibility of restricted or secret text hidden by the file owner", async t => {
  const f = fixture(t);
  await f.store.upsert(item("restricted", { sensitivity: "restricted" }));
  await f.store.upsert(item("synthetic-secret", { content: "api_key = sk-test1234567890abcdef1234567890abcdef" })); // gitleaks:allow -- Synthetic test-only marker
  f.stop(); const plan = f.plan();
  assert.deepEqual(plan.blockers.filter(blocker => blocker.code === "LEGACY_VISIBILITY_SEMANTICS").map(blocker => blocker.id).sort(), ["restricted", "synthetic-secret"]);
  assert.deepEqual(plan.operations, []); assert.equal(plan.mappingReady, false);
});

test("updated and deleted agent records propose exact legacy batches while retaining current recall policy", async t => {
  const f = fixture(t), original = f.records[0], replacement = item("replacement", { supersedes: original.id, content: "Violet telescope replacement", now: 12000 });
  await f.store.upsertMany([{ ...original, status: "superseded", updatedAt: 12000 }, replacement]);
  f.policy.memoryStore = f.store;
  f.policy.recordReason({ profileId: "one", item: replacement, reason: "user_deleted", operationId: "new-owner-delete" });
  await f.store.upsert({ ...replacement, status: "deleted", updatedAt: 13000 });
  f.stop(); const plan = f.plan();
  assert.deepEqual(plan.operations.map(operation => [operation.id, operation.after.status]), [["original", "superseded"], ["replacement", "deleted"]]);
  assert.ok(plan.snapshot.recallRecords.some(record => record.operationId === "new-owner-delete"));
  assert.equal(plan.snapshot.revisions.recall, 3); assert.equal(plan.mappingReady, true);
  assert.equal(f.readOld().find(record => record.id === "original").status, "active");
});

test("reauthorized content with a newer file cutoff requires an explicit revision-fence solution without adding fake facts", async t => {
  const f = fixture(t), original = f.records[0];
  f.database.db.prepare("UPDATE memory_file_profiles SET revision=700 WHERE profile_id='one'").run();
  f.policy.memoryStore = f.store; f.setNow(20000);
  f.policy.recordReason({ profileId: "one", item: original, reason: "forgotten", operationId: "high-file-revision" });
  await f.store.upsert({ ...original, status: "deleted", updatedAt: 20000 });
  f.setNow(30000);
  const fresh = item("fresh-authorization", { content: original.content, now: 30000 }); await f.store.upsert(fresh);
  assert.equal(f.policy.isMemoryVisible("one", f.store.get("one", fresh.id)), true);
  f.stop(); const plan = f.plan(), blocker = plan.blockers.find(record => record.code === "CONTENT_REVISION_FENCE_REQUIRED");
  assert.equal(blocker.id, fresh.id); assert.ok(blocker.currentContentRevision > blocker.cutoff); assert.ok(blocker.proposedContentRevision <= blocker.cutoff);
  assert.equal(plan.mappingReady, false);
  assert.ok(plan.journalBatches.every(batch => batch.items.every(record => f.records.some(original => original.id === record.id) || record.id === fresh.id)), "no fake padding records are proposed");
});

test("plan verification detects changed files and source CAS even if a caller reuses the previous revision", t => {
  const f = fixture(t); f.stop(); const plan = f.plan();
  fs.appendFileSync(path.join(f.workspace, "MEMORY.md"), "\nChanged later\n");
  assert.throws(() => f.migration.verifyRollbackPlan("one", { ...f.options(), planHash: plan.planHash, ownershipHash: plan.ownershipHash }), { code: "MEMORY_ROLLBACK_SOURCE_CHANGED" });
  const options = f.options(); options.expectedSourceFingerprint = plan.sourceFingerprint; options.expectedRevisions.file++;
  assert.throws(() => f.migration.planRollback("one", options), { code: "MEMORY_ROLLBACK_SOURCE_CHANGED" });
});

test("related content cutoff retains its revision semantics and does not gain authority from a lower legacy sequence", async t => {
  const f = fixture(t), original = f.records[0];
  f.database.db.prepare("UPDATE memory_file_profiles SET revision=800 WHERE profile_id='one'").run();
  f.policy.memoryStore = f.store; f.setNow(20000);
  f.policy.recordReason({ profileId: "one", item: f.records[1], relatedItems: [original], reason: "forgotten", operationId: "related-cutoff" });
  await f.store.upsert({ ...original, status: "deleted", updatedAt: 20000 });
  f.setNow(30000); await f.store.upsert(item("related-authorization", { content: original.content, now: 30000 }));
  f.stop(); const plan = f.plan();
  assert.ok(plan.blockers.some(blocker => blocker.code === "CONTENT_REVISION_FENCE_REQUIRED" && blocker.id === "related-authorization"));
  assert.equal(plan.mappingReady, false);
});

test("raw removal and invalid record paths cannot invent a deletion receipt or cross-Profile source", t => {
  const f = fixture(t), memory = path.join(f.workspace, "MEMORY.md");
  fs.writeFileSync(memory, fs.readFileSync(memory, "utf8").replace(renderMemoryEntry(f.records[0]).trimEnd(), ""));
  const row = f.database.db.prepare("SELECT data FROM memory_file_records WHERE profile_id='one' AND id='candidate'").get();
  f.database.db.prepare("UPDATE memory_file_records SET data=? WHERE profile_id='one' AND id='candidate'").run(JSON.stringify({ ...JSON.parse(row.data), memoryPath: "memory/../../two/MEMORY.md" }));
  f.stop(); const plan = f.plan();
  assert.ok(plan.blockers.some(blocker => blocker.code === "MISSING_DELETE_POLICY_RECEIPT" && blocker.id === "original"));
  assert.ok(plan.blockers.some(blocker => blocker.code === "RECORD_SOURCE_PATH_UNPROVEN" && blocker.id === "candidate"));
  assert.equal(plan.mappingReady, false);
});

for (const stopAt of ["rollback-plan-prepared", "rollback-plan-linked", "rollback-plan-published"]) test(`immutable plan publication recovers after ${stopAt} without touching either authority`, t => {
  let interrupted = false;
  const f = fixture(t, stage => { if (stage === stopAt && !interrupted) { interrupted = true; throw new Error("simulated stop"); } }); f.stop();
  const oldHash = sha256(fs.readFileSync(path.join(f.paths.agentsDir, "one", "memory", "events.jsonl")));
  assert.throws(f.plan, /simulated stop/u);
  const plan = f.plan(); assert.equal(f.migration.verifyRollbackPlan("one", { ...f.options(), planHash: plan.planHash, ownershipHash: plan.ownershipHash }).valid, true);
  assert.equal(sha256(fs.readFileSync(path.join(f.paths.agentsDir, "one", "memory", "events.jsonl"))), oldHash);
  assert.equal(fs.existsSync(path.join(path.dirname(plan.planPath), "prepared.json")), false);
});

test("loss of the stopped-Service proof after preparation leaves no selectable plan", t => {
  let permitted = true;
  const f = fixture(t, stage => { if (stage === "rollback-plan-prepared") permitted = false; }); f.stop();
  assert.throws(() => f.migration.planRollback("one", { ...f.options(), assertServiceStopped: () => permitted }), { code: "MEMORY_ROLLBACK_SERVICE_RUNNING" });
  const base = path.join(f.migration.locations("one").directory, "rollback-plans"), [hash] = fs.readdirSync(base);
  assert.equal(fs.existsSync(path.join(base, hash, "prepared.json")), true);
  assert.equal(fs.existsSync(path.join(base, hash, "plan.json")), false);
});

test("incomplete file intents and invalid text prevent a ready mapping", t => {
  const f = fixture(t);
  f.database.db.prepare("INSERT INTO memory_file_pending VALUES (?,?)").run("one", JSON.stringify({ unsettled: true }));
  // Shutdown does not settle this fixture's injected durable intent. Preflight
  // reports it without running the new writer's recovery operation.
  f.stop({ allowUnsettled: true }); const plan = f.plan();
  assert.ok(plan.blockers.some(blocker => blocker.code === "FILE_TRANSACTION_UNSETTLED"));
  assert.equal(plan.mappingReady, false);
  fs.writeFileSync(path.join(f.workspace, "MEMORY.md"), Buffer.from([0xff, 0xfe]));
  assert.throws(f.plan, { code: "MEMORY_ROLLBACK_TEXT_INVALID" });
});

test("a source or stop-proof change after preparation prevents publication and preserves the pending plan", t => {
  let changed = false;
  const f = fixture(t, stage => { if (stage === "rollback-plan-prepared" && !changed) { changed = true; fs.appendFileSync(path.join(f.workspace, "MEMORY.md"), "\nLate mutation\n"); } }); f.stop();
  assert.throws(f.plan, { code: "MEMORY_ROLLBACK_SOURCE_CHANGED" });
  const base = path.join(f.migration.locations("one").directory, "rollback-plans");
  const directories = fs.readdirSync(base); assert.equal(directories.length, 1);
  assert.equal(fs.existsSync(path.join(base, directories[0], "prepared.json")), true); assert.equal(fs.existsSync(path.join(base, directories[0], "plan.json")), false);
});

test("tampered immutable plans, unsafe hashes and foreign Profile paths are rejected", t => {
  const f = fixture(t); f.stop(); const plan = f.plan();
  assert.throws(() => f.migration.verifyRollbackPlan("one", { ...f.options(), planHash: "../outside", ownershipHash: plan.ownershipHash }), { code: "MEMORY_ROLLBACK_PLAN_INVALID" });
  fs.appendFileSync(plan.planPath, " ");
  assert.throws(() => f.migration.verifyRollbackPlan("one", { ...f.options(), planHash: plan.planHash, ownershipHash: plan.ownershipHash }), { code: "MEMORY_ROLLBACK_PLAN_INVALID" });
  assert.throws(() => f.migration.verifyRollbackPlan("two", { ...f.options(), planHash: plan.planHash, ownershipHash: plan.ownershipHash }));
});

for (const variant of ["file-symlink", "directory-symlink", "hardlink", "permissions", "oversize"]) test(`actual canonical sources reject ${variant} before planning`, t => {
  const f = fixture(t); f.stop(); const target = path.join(f.workspace, "MEMORY.md");
  if (variant === "file-symlink") { const original = path.join(f.workspace, "original.md"); fs.renameSync(target, original); fs.symlinkSync(original, target); }
  else if (variant === "directory-symlink") { fs.mkdirSync(path.join(f.workspace, "outside"), { mode: 0o700 }); fs.symlinkSync(path.join(f.workspace, "outside"), path.join(f.workspace, "memory", "alias")); }
  else if (variant === "hardlink") fs.linkSync(target, path.join(f.workspace, "alias.md"));
  else if (variant === "permissions") fs.chmodSync(target, 0o644);
  else fs.truncateSync(target, MAX_FILE_BYTES + 1);
  assert.throws(f.plan);
  assert.equal(fs.existsSync(path.join(f.migration.locations("one").directory, "rollback-plans")), false);
});

test("a forged migration source path cannot nominate another Profile or a non-memory file", t => {
  const f = fixture(t); f.stop(); const manifestPath = f.migration.locations("one").manifest;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); manifest.backupFiles[0].source = path.join(f.root, "foreign.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(f.plan, { code: "MEMORY_ROLLBACK_MIGRATION_INVALID" });
});

function replaceDirectoryPreservingChildren(directory) {
  const retained = `${directory}.retained-original`;
  fs.renameSync(directory, retained); fs.mkdirSync(directory, { mode: 0o700 });
  for (const name of fs.readdirSync(retained)) fs.renameSync(path.join(retained, name), path.join(directory, name));
  return retained;
}

for (const directoryKind of ["migration", "canonical", "sqlite-parent", "publication"]) test(`a real ${directoryKind} directory replacement cannot hide behind unchanged file inodes`, t => {
  let changed = false, originalInode;
  const f = fixture(t, stage => {
    if (stage !== "rollback-plan-prepared" || changed) return;
    changed = true;
    const migration = f.migration.locations("one").directory;
    const directory = directoryKind === "migration" ? migration : directoryKind === "canonical" ? f.workspace
      : directoryKind === "sqlite-parent" ? f.paths.stateDir : path.join(migration, "rollback-plans");
    originalInode = fs.statSync(path.join(f.workspace, "MEMORY.md")).ino;
    replaceDirectoryPreservingChildren(directory);
    assert.equal(fs.statSync(path.join(f.workspace, "MEMORY.md")).ino, originalInode, "the source file inode really is unchanged");
  }); f.stop();
  assert.throws(f.plan, { code: "MEMORY_ROLLBACK_SOURCE_CHANGED" });
  const base = path.join(f.migration.locations("one").directory, "rollback-plans"), [hash] = fs.readdirSync(base);
  assert.equal(fs.existsSync(path.join(base, hash, "prepared.json")), true);
  assert.equal(fs.existsSync(path.join(base, hash, "plan.json")), false);
});

test("published directory ownership and its externally supplied hash are both required across restart", t => {
  const f = fixture(t); f.stop(); const plan = f.plan();
  assert.throws(() => f.migration.verifyRollbackPlan("one", { ...f.options(), planHash: plan.planHash }), { code: "MEMORY_ROLLBACK_PLAN_INVALID" });
  replaceDirectoryPreservingChildren(path.dirname(plan.planPath));
  assert.throws(() => f.migration.verifyRollbackPlan("one", { ...f.options(), planHash: plan.planHash, ownershipHash: plan.ownershipHash }), { code: "MEMORY_ROLLBACK_SOURCE_CHANGED" });
  assert.throws(f.plan, { code: "MEMORY_ROLLBACK_SOURCE_CHANGED" });
});

test("replacement during linked publication prevents recovery from blessing the new parent", t => {
  let changed = false;
  const f = fixture(t, stage => {
    if (stage !== "rollback-plan-linked" || changed) return;
    changed = true; const base = path.join(f.migration.locations("one").directory, "rollback-plans"), [hash] = fs.readdirSync(base);
    replaceDirectoryPreservingChildren(path.join(base, hash));
  }); f.stop();
  assert.throws(f.plan, { code: "MEMORY_ROLLBACK_SOURCE_CHANGED" });
  const base = path.join(f.migration.locations("one").directory, "rollback-plans"), hash = fs.readdirSync(base).find(name => !name.endsWith(".retained-original"));
  const target = path.join(base, hash, "plan.json"), prepared = path.join(base, hash, "prepared.json");
  assert.equal(fs.statSync(target).nlink, 2); assert.equal(fs.statSync(prepared).ino, fs.statSync(target).ino);
  assert.throws(f.plan, { code: "MEMORY_ROLLBACK_SOURCE_CHANGED" });
});

test("preflight refuses an owner-read-only source directory without repairing its mode", t => {
  const f = fixture(t); f.stop(); const directory = path.join(f.paths.agentsDir, "one", "memory");
  fs.chmodSync(directory, 0o500);
  try {
    assert.throws(f.plan, { code: "MEMORY_ROLLBACK_PATH_UNSAFE" });
    assert.equal(fs.statSync(directory).mode & 0o777, 0o500, "the old reader must not chmod a retained source directory");
  } finally { fs.chmodSync(directory, 0o700); }
});

test("a stopped native WAL snapshot is read from its owned copy without changing source WAL or SHM bytes", t => {
  const f = fixture(t), target = f.database.path;
  const saved = ["", "-wal", "-shm"].map(suffix => ({ suffix, bytes: fs.readFileSync(target + suffix) }));
  assert.ok(saved.find(file => file.suffix === "-wal").bytes.length > 32, "the WAL contains native committed frames");
  f.stop();
  // Retain the exact native main/WAL/SHM snapshot that existed before orderly
  // shutdown checkpointed it. No connection or Service remains alive now.
  for (const file of saved) fs.writeFileSync(target + file.suffix, file.bytes, { mode: 0o600 });
  const plan = f.plan();
  assert.equal(plan.snapshot.product.tables.memory_file_records.length, f.records.length);
  for (const file of saved) {
    assert.equal(sha256(fs.readFileSync(target + file.suffix)), sha256(file.bytes));
    assert.equal(plan.snapshot.product.files.find(source => source.path === target + file.suffix).sha256, sha256(file.bytes));
  }
  assert.equal(f.migration.verifyRollbackPlan("one", { ...f.options(), planHash: plan.planHash, ownershipHash: plan.ownershipHash }).valid, true);
});
