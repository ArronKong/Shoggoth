"use strict";

// Every mutation belongs to this script's private temporary directory. The
// actual legacy/FileStore, policy, engine and migration execute; there is no
// owner switch, production Service operation or invented policy verifier.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { MemoryStore } = require("../app/agent-service/memory-store");
const { MemoryEngine } = require("../app/agent-service/memory-engine");
const { ChatSessionStore } = require("../app/agent-service/chat-session-store");
const { TranscriptStore } = require("../app/agent-service/transcript-store");
const { RecallPolicyStore } = require("../app/agent-service/recall-policy-store");
const { MemoryDatabase } = require("../app/agent-service/shoggoth-memory/database.cjs");
const { ShoggothMemoryMigration, sha256 } = require("../app/agent-service/shoggoth-memory/migration.cjs");
const { FileMemoryStore } = require("../app/agent-service/shoggoth-memory/file-store.cjs");
const { ShoggothMemoryHost } = require("../app/agent-service/shoggoth-memory/host.cjs");
const { StoppedMemoryRollbackApply } = require("../app/agent-service/shoggoth-memory/rollback-apply.cjs");

const stable = value => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const json = file => JSON.parse(fs.readFileSync(file, "utf8"));
const bytesHash = file => fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
const sorted = records => records.toSorted((a, b) => a.id.localeCompare(b.id));
function item(id, { scope = "agent", status = "active", content = `${id} invented telescope notes`, now = 1000, ...fields } = {}) {
  return { id, profileId: "one", scope, type: "semantic", content, sourceRefs: [`user-edit:${id}`], confidence: 1,
    sensitivity: "normal", status, validFrom: 0, validUntil: null, supersedes: null, createdAt: now, updatedAt: now, ...fields };
}

function fixture({ pendingHidden = false, pendingExpiry = false, emptyLegacy = false, legacySnapshot = "current" } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-memory-rollback-apply-")); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  let now = 10000, stopped = false, expected, fault = () => {};
  const legacy = new MemoryStore({ paths }); legacy.open();
  const records = emptyLegacy ? [] : [item("original"), item("hidden"), item("expired", { validUntil: 9000 }), item("candidate", { status: "candidate" }), item("private-agent-old", { scope: "agent" })];
  if (records.length) legacy.upsertMany(records);
  const memory = path.join(paths.agentsDir, "one", "memory"), snapshotPath = path.join(memory, "snapshot.json");
  const initialSnapshot = fs.existsSync(snapshotPath) ? fs.readFileSync(snapshotPath) : null;
  const policy = new RecallPolicyStore({ paths, memoryStore: legacy, now: () => now }); policy.open(["one"]);
  if (!emptyLegacy) {
    policy.recordReason({ profileId: "one", item: records[1], reason: "forgotten", operationId: "fixture-initial-hidden" });
    // Complete only this fixture's own initial transactions. Pending variants
    // intentionally leave actual unfinished facts for the apply admission gate.
    legacy.upsert({ ...records[1], status: "deleted", updatedAt: now });
    const engine = new MemoryEngine({ store: legacy, recallPolicy: policy, now: () => now }); engine.open(["one"]);
    assert.equal(engine.consolidate("one"), 1);
    engine.close(); policy.open(["one"]);
  }
  // Construct a genuine interrupted transaction only after all writable
  // startup/reconciliation is complete. No subsequent policy reopen occurs.
  if (pendingHidden || pendingExpiry) {
    const pending = item(pendingHidden ? "pending-hidden" : "pending-expiry", pendingExpiry ? { validUntil: 9000 } : {});
    legacy.upsert(pending);
    policy.recordReason({ profileId: "one", item: pending, reason: pendingHidden ? "forgotten" : "expired", operationId: `fixture-${pending.id}` });
    assert.equal(legacy.get("one", pending.id).status, "active");
  }
  // Establish the genuine original snapshot state before migration captures
  // its backup. The stale bytes came from this fixture's actual native seq 1
  // transaction; no checksum, journal row or policy proof is manufactured.
  if (legacySnapshot === "missing") fs.unlinkSync(snapshotPath);
  else if (legacySnapshot === "stale") { assert.ok(initialSnapshot); fs.writeFileSync(snapshotPath, initialSnapshot); }
  const files = ["events.jsonl", "snapshot.json", "recall-policy.jsonl", "recall-policy.seal.json"].map(name => ({ name, path: path.join(memory, name) }));
  files.push({ name: "recall-policy-installed.json", path: path.join(paths.agentsDir, "one", "recall-policy-installed.json") },
    { name: "recall-policy-installation.json", path: path.join(paths.agentsDir, ".recall-policy-installations", "one.json") });
  const migration = new ShoggothMemoryMigration({ paths, now: () => now, fault: (...args) => fault(...args),
    readLegacy: profileId => ({ records: legacy.list(profileId), files: files.filter(file => fs.existsSync(file.path)), revision: legacy.getRevision(profileId), recallRevision: policy.getRevision(profileId),
      contentRevisions: Object.fromEntries(legacy.list(profileId).map(record => [record.id, legacy.getContentRevision(profileId, record.id)])),
      visibleIds: legacy.list(profileId).filter(record => record.status === "active" && policy.isMemoryVisible(profileId, record)).map(record => record.id) }),
    assertLegacyCurrent: (profileId, snapshot, saved) => { assert.equal(snapshot.revision, legacy.getRevision(profileId));
      for (const file of saved) assert.equal(bytesHash(file.source), file.sha256); } });
  const database = new MemoryDatabase({ paths, now: () => now }); database.open();
  const workspace = migration.locations("one").workspace;
  const host = new ShoggothMemoryHost({ paths, database, profileId: "one", workspaceDir: workspace,
    roster: () => [{ id: "one", workspace }], sessions: { list: () => [] } });
  const store = new FileMemoryStore({ paths, database, migration, getHost: () => host, now: () => now }); store.open(); store.ensureProfile("one");
  function stop() {
    if (stopped) return;
    expected = { legacy: legacy.getRevision("one"), file: store.getRevision("one"), recall: policy.getRevision("one") };
    store.close(); database.close(); legacy.close(); policy.close(); stopped = true;
  }
  const options = () => ({ expectedRevisions: { ...expected }, now, assertServiceStopped: () => { assert.equal(stopped, true, "Fixture Service must already be stopped"); } });
  const applier = () => new StoppedMemoryRollbackApply({ migration, paths, fault: (...args) => fault(...args) });
  const readOld = action => { const readOnly = new MemoryStore({ paths, readOnly: true }); readOnly.open();
    try { return action ? action(readOnly) : readOnly.list("one"); } finally { readOnly.close(); } };
  return { root, paths, records, policy, migration, database, store, workspace, memory, stop, options, applier, readOld,
    journal: path.join(memory, "events.jsonl"), snapshot: path.join(memory, "snapshot.json"),
    setNow: value => { now = value; }, setFault: value => { fault = value; },
    async add(count = 1) { const added = Array.from({ length: count }, (_, i) => item(`new-${String(i).padStart(3, "0")}`, { now: 12000 })); await store.upsertMany(added); return added; },
    prepare(operationId = "fixture-rollback") {
      stop(); const plan = migration.planRollback("one", options());
      const input = { ...options(), operationId, planHash: plan.planHash, ownershipHash: plan.ownershipHash };
      const prepared = applier().prepare("one", input);
      assert.match(prepared.applyIntentHash, /^[a-f0-9]{64}$/u);
      return { plan, prepared, options: { ...input, applyIntentHash: prepared.applyIntentHash } };
    },
    search() {
      // Engine startup is allowed to reconcile policy. Execute it only on an
      // exact owned copy, and prove the actual retained authorities unchanged.
      const source = files.map(file => ({ path: file.path, hash: bytesHash(file.path) }));
      const copy = path.join(root, "actual-search-copy"), copiedPaths = { ...paths, trustedRoot: copy, agentsDir: path.join(copy, "agents") };
      fs.mkdirSync(copy, { mode: 0o700 });
      for (const file of files) {
        const destination = path.join(copiedPaths.agentsDir, path.relative(paths.agentsDir, file.path));
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 }); fs.copyFileSync(file.path, destination);
      }
      const readOnly = new MemoryStore({ paths: copiedPaths, readOnly: true }); readOnly.open();
      const actualPolicy = new RecallPolicyStore({ paths: copiedPaths, memoryStore: readOnly, now: () => now });
      const actualEngine = new MemoryEngine({ store: readOnly, recallPolicy: actualPolicy, now: () => now });
      try { actualEngine.open(["one"]); return actualEngine.search({ profileId: "one", query: "", limit: 100, maxBytes: 128 * 1024, now }).items; }
      finally { actualEngine.close(); readOnly.close(); assertRetained(source); }
    },
  };
}


test("ordinary real plan/apply remains valid without invented Product or Session authorization resources",async t=>{
 const f=fixture();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));await f.add();const r=f.prepare();
 assert.equal(fs.existsSync(f.paths.eventLogPath),false);assert.equal(fs.existsSync(path.join(f.paths.stateDir,"chat-sessions.json")),false);
 assert.equal(r.plan.authorizationSnapshot,undefined);assert.equal(r.plan.snapshot.authorizationAuxiliaryAuthority,undefined);
 const actual=f.applier().apply("one",r.options);assert.equal(actual.storageVerified,true);assert.equal(actual.legacyVerification.valid,true);assert.equal(actual.canSelectLegacyWriter,false);
 assert.equal(actual.legacyVerification.authorizationMatrixVerified,undefined);
});
test("ordinary genuine empty revision zero plan remains a no-op without either native primary or external authorization source",async t=>{
 const f=fixture({emptyLegacy:true});t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));const r=f.prepare();
 assert.equal(r.plan.authorizationSnapshot,undefined);assert.equal(r.plan.journalBatches.length,0);
 const actual=f.applier().apply("one",r.options);assert.equal(actual.storageVerified,true);assert.equal(actual.canSelectLegacyWriter,false);
 assert.equal(fs.existsSync(f.journal),false);assert.equal(fs.existsSync(f.snapshot),false);
 const again=f.applier().recover("one",r.options);assert.equal(again.actualRevision,0);assert.equal(fs.existsSync(f.journal),false);assert.equal(fs.existsSync(f.snapshot),false);
});
