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
const { JsonlProductStore, DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
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

function fixture({ pendingHidden = false, pendingExpiry = false, emptyLegacy = false, legacySnapshot = "current" } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-memory-rollback-apply-")); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  let now = 10000, stopped = false, expected, fault = () => {};
  const legacy = new MemoryStore({ paths }); legacy.open();
  const profiles = authorizationCatalog(paths, legacy, () => now);
  const records = emptyLegacy ? [] : [item("original"), item("hidden"), item("expired", { validUntil: 9000 }), item("candidate", { status: "candidate" }), item("shared-old", { scope: "user" })];
  if (records.length) legacy.upsertMany(records);
  const memory = path.join(paths.agentsDir, "one", "memory"), snapshotPath = path.join(memory, "snapshot.json");
  const initialSnapshot = fs.existsSync(snapshotPath) ? fs.readFileSync(snapshotPath) : null;
  const policy = new RecallPolicyStore({ paths, memoryStore: legacy, now: () => now }); policy.open(profiles);
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

function isolated(name, run, settings) {
  test(name, async t => {
    const f = fixture(settings); let passed = false;
    try { await run(f, t); passed = true; }
    finally {
      try { f.stop(); }
      finally { if (passed) fs.rmSync(f.root, { recursive: true, force: true }); else t.diagnostic(`Retained isolated fixture: ${f.root}`); }
    }
  });
}

function assertReceipt(f, request, receipt) {
  assert.equal(receipt.phase, "applied");
  assert.equal(receipt.storageVerified, true); assert.equal(receipt.legacySearchVerified, true);
  assert.equal(receipt.legacyVerification.valid, true); assert.equal(receipt.legacyVerification.authorityPreserved, true);
  assert.equal(receipt.legacyVerification.withdrawalVerified, true); assert.equal(receipt.legacyVerification.futureAuthorizationVerified, true);
  assert.equal(receipt.canSelectLegacyWriter, false);
  assert.equal(receipt.completedBatches, request.plan.journalBatches.length);
  assert.equal(receipt.actualRevision, request.plan.snapshot.revisions.legacy + request.plan.journalBatches.length);
  assert.equal(receipt.journalHash, bytesHash(f.journal));
  assert.equal(f.readOld(store => store.getRevision("one")), receipt.actualRevision);
  const expected = new Map(request.plan.snapshot.legacyRecords.map(record => [record.id, record]));
  for (const operation of request.plan.operations) expected.set(operation.id, operation.after);
  assert.deepEqual(sorted(f.readOld()), sorted([...expected.values()]));
  const rows = fs.readFileSync(f.journal, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
  for (let i = 0; i < request.plan.journalBatches.length; i++) {
    const row = rows[request.plan.snapshot.revisions.legacy + i], batch = request.plan.journalBatches[i];
    assert.equal(row.seq, batch.expectedRevision + 1); assert.equal(row.type, "memory.batch"); assert.deepEqual(row.items, batch.items);
    assert.equal(f.readOld(store => store.getContentRevision("one", batch.items[0].id)), row.seq);
  }
  assert.equal(json(f.snapshot).revision, receipt.actualRevision);
}

function assertIntent(f, request) {
  const intent = json(request.prepared.intentPath); assert.equal(bytesHash(request.prepared.intentPath), request.options.applyIntentHash);
  assert.equal(intent.operationId, request.options.operationId); assert.equal(intent.planHash, request.plan.planHash);
  assert.equal(intent.ownershipHash, request.plan.ownershipHash); assert.deepEqual(intent.revisions, request.options.expectedRevisions);
  assert.equal(intent.canSelectLegacyWriter, false); assert.equal(intent.states.length, intent.batches.length + 1);
  let prefix = fs.existsSync(f.journal) ? fs.readFileSync(f.journal) : Buffer.alloc(0);
  for (let count = 0; count <= intent.batches.length; count++) {
    if (count) {
      const batch = intent.batches[count - 1], row = Buffer.from(batch.row);
      assert.equal(batch.rowBytes, row.length); assert.equal(batch.rowHash, sha256(row));
      assert.equal(batch.seq, request.plan.journalBatches[count - 1].expectedRevision + 1);
      assert.deepEqual(JSON.parse(batch.row).items, request.plan.journalBatches[count - 1].items);
      prefix = Buffer.concat([prefix, row]);
    }
    const state = intent.states[count]; assert.equal(state.journalBytes, prefix.length); assert.equal(state.journalHash, sha256(prefix));
    assert.equal(state.revision, request.plan.snapshot.revisions.legacy + count); assert.equal(state.snapshotPath ? bytesHash(state.snapshotPath) : null, state.snapshotHash);
    // Replay the captured bytes through the actual Store in another fixture
    // subdirectory; assertions do not manufacture journal checksums.
    const agentsDir = path.join(f.root, `prefix-${count}`), memory = path.join(agentsDir, "one", "memory");
    fs.mkdirSync(memory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(memory, "events.jsonl"), prefix, { mode: 0o600 });
    if (state.snapshotPath) fs.copyFileSync(state.snapshotPath, path.join(memory, "snapshot.json"));
    const replay = new MemoryStore({ paths: { ...f.paths, agentsDir }, readOnly: true }); replay.open();
    try {
      const records = sorted(replay.list("one")); assert.equal(replay.getRevision("one"), state.revision);
      const actual = { records, contentRevisions: Object.fromEntries(records.map(record => [record.id, replay.getContentRevision("one", record.id)])),
        writeProofs: Object.fromEntries(records.map(record => [record.id, replay.getItemWriteProof("one", record.id)])) };
      assert.equal(sha256(stable(actual)), state.stateHash);
    } finally { replay.close(); }
  }
  return intent;
}

function retainedSources(plan) {
  return [...plan.snapshot.files, ...plan.snapshot.product.files, ...plan.snapshot.core.files,
    ...plan.snapshot.legacyFiles.filter(file => !["events.jsonl", "snapshot.json"].includes(file.name)),
    plan.snapshot.manifest, plan.snapshot.legacySnapshot, ...plan.snapshot.backupFiles]
    .map(file => ({ path: file.path, hash: bytesHash(file.path) }));
}
function assertRetained(files) { for (const file of files) assert.equal(bytesHash(file.path), file.hash, `Retained authority changed: ${file.path}`); }

isolated("actual rollback apply writes 129 compatible facts in two real legacy batches and repeats without extra revisions", async f => {
  await f.add(129); const request = f.prepare(), retained = retainedSources(request.plan), before = fs.readFileSync(f.journal);
  assertIntent(f, request);
  assert.equal(request.plan.journalBatches.length, 2); assert.equal(request.plan.journalBatches[0].items.length, 128);
  assert.equal(request.plan.journalBatches[1].items.length, 1);
  const receipt = f.applier().apply("one", request.options); assertReceipt(f, request, receipt); assertRetained(retained);
  assert.ok(fs.readFileSync(f.journal).subarray(0, before.length).equals(before));
  const completed = fs.readFileSync(f.journal), snapshotHash = bytesHash(f.snapshot);
  for (const method of ["apply", "recover", "verify"]) {
    const repeated = f.applier()[method]("one", request.options); assert.equal(repeated.canSelectLegacyWriter, false);
    assert.ok(fs.readFileSync(f.journal).equals(completed)); assert.equal(bytesHash(f.snapshot), snapshotHash);
  }
  const visible = f.search(); assert.ok(visible.every(record => !["hidden", "expired", "candidate"].includes(record.id)));
  assertRetained(retained);
});

for (const stage of ["rollback-apply-active", "rollback-apply-preparation", "rollback-apply-staging", "rollback-apply-intent-prepared", "rollback-apply-intent-linked"]) isolated(`prepare restarts after actual ${stage} without touching either authority`, async f => {
  await f.add(); f.stop(); const before = [f.journal, f.snapshot].map(file => ({ path: file, hash: bytesHash(file) })); let hit = false;
  f.setFault((actual, profileId) => { if (actual === stage && !hit) { hit = true; assert.equal(profileId, "one"); throw new Error(`fixture interrupted preparation at ${stage}`); } });
  assert.throws(() => f.prepare()); assert.equal(hit, true); assertRetained(before); f.setFault(() => {});
  const request = f.prepare(); assertIntent(f, request); assertRetained(before);
  assertReceipt(f, request, f.applier().recover("one", request.options));
});

for (const stage of ["rollback-apply-staging", "rollback-apply-intent-linked"]) isolated(`prepare restart after ${stage} rejects a replacement directory with unchanged child inodes`, async f => {
  await f.add(); f.stop(); let hit = false;
  f.setFault((actual) => { if (actual === stage && !hit) { hit = true; throw new Error("fixture stop before directory replacement"); } });
  assert.throws(() => f.prepare()); assert.equal(hit, true); f.setFault(() => {});
  const before = bytesHash(f.journal), inode = fs.statSync(f.journal).ino;
  replaceDirectory(f.migration.locations("one").directory); assert.equal(fs.statSync(f.journal).ino, inode);
  assert.throws(() => f.prepare()); assert.equal(bytesHash(f.journal), before);
});

for (const variant of ["owned", "foreign-inode", "foreign-bytes"]) isolated(`snapshot recovery accepts only ${variant} evidence belonging to the actual interrupted transaction`, async f => {
  await f.add(); const request = f.prepare(); let hit = false, retainedBackup;
  const unlink = fs.unlinkSync;
  f.setFault((stage) => {
    if (stage !== "rollback-apply-snapshot" || hit) return;
    hit = true; const names = fs.readdirSync(f.memory).filter(name => name.startsWith("snapshot.json.backup-")); assert.equal(names.length, 1);
    retainedBackup = path.join(f.memory, names[0]);
    // Fail cleanup only for the inode created inside this exact fixture's
    // interrupted native snapshot transaction. Restore the API immediately.
    fs.unlinkSync = target => { if (target === retainedBackup) throw new Error("fixture backup cleanup interrupted"); return unlink(target); };
    throw new Error("fixture snapshot installed but cleanup uncertain");
  });
  try { assert.throws(() => f.applier().apply("one", request.options), { code: "MEMORY_COMMIT_UNCERTAIN" }); }
  finally { fs.unlinkSync = unlink; }
  assert.equal(hit, true); assert.ok(fs.existsSync(retainedBackup)); f.setFault(() => {});
  const proof = json(path.join(request.prepared.operationDirectory, "artifacts.json"));
  const artifact = proof.files.find(file => file.path === retainedBackup), actual = fs.statSync(retainedBackup);
  assert.ok(artifact); assert.equal(artifact.ino, actual.ino); assert.equal(artifact.dev, actual.dev);
  assert.equal(artifact.sha256, bytesHash(retainedBackup)); assert.equal(actual.nlink, 1);
  if (variant === "foreign-inode") { fs.renameSync(retainedBackup, retainedBackup + ".retained-original"); fs.copyFileSync(retainedBackup + ".retained-original", retainedBackup); }
  else if (variant === "foreign-bytes") fs.appendFileSync(retainedBackup, "foreign snapshot tail");
  const before = [f.journal, f.snapshot, retainedBackup].map(file => ({ path: file, hash: bytesHash(file) }));
  assert.throws(() => f.applier().apply("one", request.options), { code: "MEMORY_ROLLBACK_RECOVERY_REQUIRED" }); assertRetained(before);
  if (variant === "owned") { assertReceipt(f, request, f.applier().recover("one", request.options)); assert.equal(fs.existsSync(retainedBackup), false); }
  else { assert.throws(() => f.applier().recover("one", request.options), { code: "MEMORY_ROLLBACK_FOREIGN_TRANSACTION" }); assertRetained(before); }
});

isolated("migration wrappers execute the same bound intent, recovery and genuine legacy verifier", async f => {
  await f.add(); f.stop(); const plan = f.migration.planRollback("one", f.options());
  const input = { ...f.options(), operationId: "migration-wrapper", planHash: plan.planHash, ownershipHash: plan.ownershipHash };
  const prepared = f.migration.prepareRollbackApply("one", input), options = { ...input, applyIntentHash: prepared.applyIntentHash }, request = { plan, prepared, options };
  assertIntent(f, request); assertReceipt(f, request, f.migration.applyRollback("one", options));
  const before = bytesHash(f.journal); assertReceipt(f, request, f.migration.recoverRollbackApply("one", options));
  assertReceipt(f, request, f.migration.verifyRollbackApplied("one", options)); assert.equal(bytesHash(f.journal), before);
});

for (const stage of ["rollback-apply-prepared", "rollback-apply-before-batch", "rollback-apply-journal-write", "rollback-apply-journal-fsynced", "rollback-apply-journal-closed", "rollback-apply-snapshot", "rollback-apply-after-batch", "rollback-apply-completed"]) {
  isolated(`real apply recovery after ${stage} does not duplicate or bless an owner switch`, async f => {
    await f.add(129); let hit = false;
    f.setFault((actual, profileId) => { assert.equal(profileId, "one"); if (actual === stage && !hit) { hit = true; throw new Error(`fixture interruption at ${stage}`); } });
    if (stage === "rollback-apply-prepared") {
      assert.throws(() => f.prepare(), /fixture interruption/u); assert.equal(hit, true); f.setFault(() => {});
      const request = f.prepare(), receipt = f.applier().recover("one", request.options); assertReceipt(f, request, receipt);
    } else {
      const request = f.prepare(), retained = retainedSources(request.plan);
      assert.throws(() => f.applier().apply("one", request.options)); assert.equal(hit, true);
      f.setFault(() => {}); const receipt = f.applier().recover("one", request.options); assertReceipt(f, request, receipt); assertRetained(retained);
      const after = bytesHash(f.journal); f.applier().recover("one", request.options); assert.equal(bytesHash(f.journal), after);
    }
  });
}

for (const stage of ["rollback-apply-before-batch", "rollback-apply-journal-write", "rollback-apply-journal-fsynced", "rollback-apply-journal-closed", "rollback-apply-snapshot", "rollback-apply-after-batch"]) isolated(`second batch recovery after ${stage} retains the first committed prefix`, async f => {
  await f.add(129); const request = f.prepare(), intent = assertIntent(f, request); let hit = false;
  f.setFault((actual, profileId, details) => {
    assert.equal(profileId, "one");
    if (actual === stage && details.index === 1 && !hit) {
      hit = true; assert.equal(details.operationId, request.options.operationId); assert.equal(details.applyIntentHash, request.options.applyIntentHash);
      assert.equal(details.journalPath, f.journal); assert.equal(details.expectedRow, intent.batches[1].row);
      throw new Error(`fixture second batch interruption at ${stage}`);
    }
  });
  assert.throws(() => f.applier().apply("one", request.options)); assert.equal(hit, true);
  const prefix = fs.readFileSync(f.journal), expected = Buffer.concat([fs.readFileSync(f.journal).subarray(0, intent.states[0].journalBytes), Buffer.from(intent.batches[0].row)]);
  assert.ok(prefix.subarray(0, expected.length).equals(expected));
  assert.ok(f.readOld(store => store.getRevision("one")) >= intent.states[1].revision);
  f.setFault(() => {}); assertReceipt(f, request, f.applier().recover("one", request.options));
});

isolated("a real uncertain short write repairs only the exact owned next-row prefix and never duplicates the first row", async f => {
  await f.add(129); const request = f.prepare(), intent = assertIntent(f, request); let hit = false;
  f.setFault((stage, profileId, details) => {
    if (stage !== "rollback-apply-journal-write" || details.index !== 1 || hit) return;
    hit = true; assert.equal(profileId, "one"); assert.equal(details.journalPath, f.journal);
    const row = Buffer.from(details.expectedRow), length = intent.states[1].journalBytes + Math.floor(row.length / 2);
    const fd = fs.openSync(details.journalPath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    try { fs.ftruncateSync(fd, length); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    throw new Error("fixture actual uncertain short write");
  });
  assert.throws(() => f.applier().apply("one", request.options), { code: "MEMORY_COMMIT_UNCERTAIN" }); assert.equal(hit, true);
  const partial = fs.readFileSync(f.journal), tail = partial.subarray(intent.states[1].journalBytes);
  assert.ok(tail.length > 0 && !tail.includes(10)); assert.ok(Buffer.from(intent.batches[1].row).subarray(0, tail.length).equals(tail));
  assert.equal(f.readOld(store => store.getRevision("one")), intent.states[1].revision);
  f.setFault(() => {}); assert.throws(() => f.applier().apply("one", request.options)); assert.ok(fs.readFileSync(f.journal).equals(partial));
  assertReceipt(f, request, f.applier().recover("one", request.options));
  const complete = fs.readFileSync(f.journal); assert.equal(complete.length, intent.states[2].journalBytes);
  f.applier().recover("one", request.options); assert.ok(fs.readFileSync(f.journal).equals(complete));
});

for (const variant of ["partial", "valid-row", "damaged-prefix"]) isolated(`recovery rejects ${variant} from another transaction without repairing it`, async f => {
  await f.add(129); const request = f.prepare(), intent = assertIntent(f, request); let hit = false;
  f.setFault((stage, _profile, details) => { if (stage === "rollback-apply-before-batch" && details.index === 1 && !hit) { hit = true; throw new Error("fixture stop after first prefix"); } });
  assert.throws(() => f.applier().apply("one", request.options)); assert.equal(hit, true); f.setFault(() => {});
  if (variant === "partial") fs.appendFileSync(f.journal, '{"checksum":"foreign-owned-tail');
  else if (variant === "valid-row") {
    const foreign = new MemoryStore({ paths: f.paths }); foreign.open();
    try { foreign.upsert(item("foreign-owned-fact", { now: 13000 })); } finally { foreign.close(); }
  } else {
    const bytes = fs.readFileSync(f.journal), position = bytes.indexOf("invented telescope"); assert.ok(position >= 0); bytes[position] ^= 1; fs.writeFileSync(f.journal, bytes);
  }
  const bytes = fs.readFileSync(f.journal), snapshot = fs.readFileSync(f.snapshot);
  assert.throws(() => f.applier().recover("one", request.options));
  assert.ok(fs.readFileSync(f.journal).equals(bytes)); assert.ok(fs.readFileSync(f.snapshot).equals(snapshot));
  assert.equal(json(request.prepared.intentPath).states[1].journalHash, intent.states[1].journalHash);
});

isolated("recovery refuses foreign snapshot temp evidence and preserves every byte", async f => {
  await f.add(); const request = f.prepare(), temporary = f.snapshot + ".tmp";
  fs.writeFileSync(temporary, "foreign snapshot intent", { mode: 0o600 });
  const before = [f.journal, f.snapshot, temporary].map(file => ({ path: file, hash: bytesHash(file) }));
  assert.throws(() => f.applier().recover("one", request.options), { code: "MEMORY_ROLLBACK_FOREIGN_TRANSACTION" }); assertRetained(before);
});

function replaceDirectory(directory) {
  const retained = directory + ".retained-original"; fs.renameSync(directory, retained); fs.mkdirSync(directory, { mode: 0o700 });
  for (const name of fs.readdirSync(retained)) fs.renameSync(path.join(retained, name), path.join(directory, name)); return retained;
}
for (const variant of ["source-parent", "operation-parent", "journal-inode", "journal-symlink", "journal-hardlink", "permissions"]) isolated(`apply rejects changed ${variant} after preparation before appending a fact`, async f => {
  await f.add(); const request = f.prepare(), before = bytesHash(f.journal);
  if (variant === "source-parent") replaceDirectory(f.memory);
  else if (variant === "operation-parent") replaceDirectory(request.prepared.operationDirectory);
  else if (variant === "journal-inode" || variant === "journal-symlink") {
    const retained = f.journal + ".retained-original"; fs.renameSync(f.journal, retained);
    if (variant === "journal-inode") fs.copyFileSync(retained, f.journal); else fs.symlinkSync(retained, f.journal);
  } else if (variant === "journal-hardlink") fs.linkSync(f.journal, f.journal + ".foreign-link");
  else fs.chmodSync(f.journal, 0o644);
  assert.throws(() => f.applier().apply("one", request.options)); assert.equal(bytesHash(f.journal), before);
  if (variant === "permissions") assert.equal(fs.statSync(f.journal).mode & 0o777, 0o644);
});

isolated("a real policy revision changed after preparation remains intact and prevents apply", async f => {
  await f.add(); const request = f.prepare(), before = bytesHash(f.journal), old = new MemoryStore({ paths: f.paths, readOnly: true }); old.open();
  const policy = new RecallPolicyStore({ paths: f.paths, memoryStore: old, now: () => 20000 });
  try { policy.open(["one"]); policy.recordReason({ profileId: "one", item: old.get("one", "original"), reason: "forgotten", operationId: "foreign-policy-change" }); }
  finally { policy.close(); old.close(); }
  const policyHash = bytesHash(path.join(f.memory, "recall-policy.jsonl"));
  assert.throws(() => f.applier().apply("one", request.options)); assert.equal(bytesHash(f.journal), before);
  assert.equal(bytesHash(path.join(f.memory, "recall-policy.jsonl")), policyHash);
});

isolated("a high file-owner cutoff blocks future authorization even without a current replacement fact", async f => {
  f.database.db.prepare("UPDATE memory_file_profiles SET revision=700 WHERE profile_id='one'").run();
  f.policy.memoryStore = f.store; f.setNow(20000);
  f.policy.recordReason({ profileId: "one", item: f.records[0], reason: "forgotten", operationId: "high-file-cutoff" });
  await f.store.upsert({ ...f.records[0], status: "deleted", updatedAt: 20000 }); f.stop();
  const plan = f.migration.planRollback("one", f.options()), before = bytesHash(f.journal);
  assert.ok([...plan.blockers, ...plan.legacyCompatibility.blockers].some(record => record.code === "FUTURE_AUTHORIZATION_REVISION_FENCE_REQUIRED"));
  assert.deepEqual(plan.operations.map(record => record.id), ["original"]);
  assert.throws(() => f.applier().prepare("one", { ...f.options(), operationId: "fenced-future", planHash: plan.planHash, ownershipHash: plan.ownershipHash }));
  assert.equal(bytesHash(f.journal), before);
});

isolated("mapping an expired record to a new journal row cannot inherit its old expiry checksum proof", async f => {
  const expired = f.readOld(store => store.get("one", "expired")); await f.store.upsert({ ...expired, updatedAt: 20000 }); f.stop();
  const plan = f.migration.planRollback("one", f.options()), before = bytesHash(f.journal);
  assert.ok(plan.legacyCompatibility.blockers.some(record => record.code === "LEGACY_EXPIRY_PRIMARY_PROOF_UNPROVEN" && record.id === "expired"));
  assert.throws(() => f.applier().prepare("one", { ...f.options(), operationId: "changed-expiry", planHash: plan.planHash, ownershipHash: plan.ownershipHash }));
  assert.equal(bytesHash(f.journal), before);
});

isolated("a real later user transcript event can reauthorize forgotten text above the retained legacy cutoff", async f => {
  await f.add(); const request = f.prepare(); assertReceipt(f, request, f.applier().apply("one", request.options));
  const sessions = new ChatSessionStore({ paths: f.paths, now: () => 30000 }), transcripts = new TranscriptStore({ paths: f.paths, now: () => 30000 });
  const old = new MemoryStore({ paths: f.paths }); old.open();
  const policy = new RecallPolicyStore({ paths: f.paths, memoryStore: old, transcriptStore: transcripts, chatSessionStore: sessions,
    strictSourceResolution: true, now: () => 30000 });
  const engine = new MemoryEngine({ store: old, recallPolicy: policy, now: () => 30000 });
  try {
    sessions.open(); transcripts.open();
    const session = sessions.createSession({ profileId: "one", workspace: f.root, operationId: "fresh-authorize-session", createdAt: 30000 });
    const event = transcripts.appendEvent({ profileId: "one", sessionId: session.id, id: "fresh-authorize-event", runId: "fresh-authorize-run", kind: "user",
      content: { text: `I explicitly authorize ${f.records[1].content} again.` }, occurredAt: 30000 });
    engine.open(["one"]);
    const renewed = old.upsert(item("fresh-authorization", { content: f.records[1].content, sourceRefs: [event.id, event.runId], now: 30000 }));
    assert.equal(policy.isMemoryVisible("one", renewed), true); assert.equal(policy.isMemoryVisible("one", old.get("one", "hidden")), false);
    const authored = old.upsert(item("fresh-ui-authorization", { content: f.records[1].content, sourceRefs: ["user-edit:future-owned-ui"], now: 30001 }));
    assert.equal(policy.isMemoryVisible("one", authored), true, "A genuine later UI save must also cross the retained cutoff");
    const search = engine.search({ profileId: "one", query: "", limit: 100, now: 30000 });
    assert.ok(search.items.some(record => record.id === renewed.id)); assert.ok(search.items.some(record => record.id === authored.id));
    assert.ok(search.items.every(record => record.id !== "hidden"));
  } finally { engine.close(); old.close(); transcripts.close(); sessions.close(); }
});

for (const kind of ["pendingHidden", "pendingExpiry"]) isolated(`actual ${kind} is rejected before journal mutation`, async f => {
  await f.add(); f.stop(); const plan = f.migration.planRollback("one", f.options());
  const before = [f.journal, f.snapshot, ...plan.snapshot.legacyFiles.map(file => file.path)].map(file => ({ path: file, hash: bytesHash(file) }));
  assert.throws(() => f.applier().prepare("one", { ...f.options(), operationId: "pending-rejected", planHash: plan.planHash, ownershipHash: plan.ownershipHash }));
  assertRetained(before);
}, { [kind]: true });

isolated("apply binds external operation, intent and all stopped revisions before the first write", async f => {
  await f.add(); const request = f.prepare(), before = bytesHash(f.journal);
  for (const changed of [{ operationId: "other-operation" }, { applyIntentHash: "f".repeat(64) }, { planHash: "e".repeat(64) },
    { ownershipHash: "d".repeat(64) }, { applyIntentHash: undefined }, { expectedRevisions: { ...request.options.expectedRevisions, recall: request.options.expectedRevisions.recall + 1 } },
    { assertServiceStopped: () => false }, { assertServiceStopped: () => Promise.resolve(true) }]) {
    assert.throws(() => f.applier().apply("one", { ...request.options, ...changed })); assert.equal(bytesHash(f.journal), before);
  }
  assert.throws(() => f.applier().apply("two", request.options)); assert.equal(bytesHash(f.journal), before);
  assertReceipt(f, request, f.applier().apply("one", request.options));
});

function injectAuxiliary(f, variant) {
  const generated = path.join(f.paths.agentsDir, "one", "generated");
  let target;
  if (variant === "policy-tmp") target = path.join(f.memory, "recall-policy.jsonl.tmp");
  else if (variant === "provenance-tmp") target = path.join(f.memory, "provenance.jsonl.tmp");
  else {
    fs.mkdirSync(generated, { recursive: true, mode: 0o700 });
    if (variant === "generated-tmp") target = path.join(generated, "MEMORY.md.tmp");
    else if (variant === "generated-file") target = path.join(generated, "foreign-generation.md");
    else { const directory = path.join(generated, "foreign-generation"); fs.mkdirSync(directory, { mode: 0o700 }); target = path.join(directory, "MEMORY.md"); }
  }
  fs.writeFileSync(target, `Invented unfinished auxiliary source: ${variant}\n`, { mode: 0o600 });
  return { path: target, hash: bytesHash(target), ino: fs.statSync(target).ino };
}

for (const variant of ["policy-tmp", "provenance-tmp", "generated-tmp", "generated-file", "generated-directory"]) {
  for (const phase of ["prepare", "first-batch"]) isolated(`${phase} rejects actual foreign ${variant} and preserves policy, journal and auxiliary evidence`, async f => {
    await f.add(); f.stop(); const plan = f.migration.planRollback("one", f.options());
    const input = { ...f.options(), operationId: `aux-${variant}-${phase}`, planHash: plan.planHash, ownershipHash: plan.ownershipHash };
    const retained = retainedSources(plan), before = [f.journal, f.snapshot].map(file => ({ path: file, hash: bytesHash(file) }));
    let auxiliary, hit = false;
    if (phase === "prepare") {
      auxiliary = injectAuxiliary(f, variant);
      assert.throws(() => f.applier().prepare("one", input));
    } else {
      const prepared = f.applier().prepare("one", input), options = { ...input, applyIntentHash: prepared.applyIntentHash };
      f.setFault((stage, profileId, details) => {
        if (stage !== "rollback-apply-before-batch" || details.index !== 0 || hit) return;
        hit = true; assert.equal(profileId, "one"); auxiliary = injectAuxiliary(f, variant);
      });
      assert.throws(() => f.applier().apply("one", options)); assert.equal(hit, true);
    }
    assertRetained(retained); assertRetained(before); assertRetained([auxiliary]);
    assert.equal(fs.statSync(auxiliary.path).ino, auxiliary.ino, "Rejecting another transaction must not replace its evidence");
  });
}

function nativeFileIdentity(file) {
  if (!fs.existsSync(file)) return { present: false };
  const stat = fs.lstatSync(file);
  return { present: true, sha256: bytesHash(file), dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink, size: stat.size };
}

for (const [variant, settings] of [["empty", { emptyLegacy: true }], ["missing", { legacySnapshot: "missing" }], ["stale", { legacySnapshot: "stale" }]]) {
  isolated(`zero batches preserve genuine ${variant} legacy journal and snapshot through actual wrappers and repeated recovery`, async f => {
    f.stop(); const original = [f.journal, f.snapshot].map(file => ({ path: file, identity: nativeFileIdentity(file) }));
    const assertNativeUnchanged = () => { for (const file of original) assert.deepEqual(nativeFileIdentity(file.path), file.identity); };
    if (variant === "empty") {
      assert.equal(original[0].identity.present, false); assert.equal(original[1].identity.present, false);
      assert.equal(f.readOld(store => store.getRevision("one")), 0); assert.deepEqual(f.readOld(), []);
    } else {
      assert.equal(original[0].identity.present, true); assert.equal(f.readOld(store => store.getRevision("one")), 3);
      if (variant === "missing") assert.equal(original[1].identity.present, false);
      else { assert.equal(original[1].identity.present, true); assert.equal(json(f.snapshot).revision, 1); }
    }
    assertNativeUnchanged(); const request = f.prepare(`zero-${variant}`), retained = retainedSources(request.plan);
    assert.equal(request.plan.operations.length, 0); assert.equal(request.plan.journalBatches.length, 0);
    const intent = assertIntent(f, request); assert.equal(intent.batches.length, 0);
    assert.equal(intent.states[0].snapshotHash, bytesHash(f.snapshot)); assertNativeUnchanged();
    const wrappedPreparation = f.migration.prepareRollbackApply("one", request.options);
    assert.equal(wrappedPreparation.applyIntentHash, request.options.applyIntentHash); assertNativeUnchanged();
    const assertZeroReceipt = receipt => {
      assert.equal(receipt.phase, "applied"); assert.equal(receipt.completedBatches, 0);
      assert.equal(receipt.actualRevision, request.options.expectedRevisions.legacy); assert.equal(receipt.canSelectLegacyWriter, false);
      assert.equal(receipt.storageVerified, true); assert.equal(receipt.legacySearchVerified, true);
      for (const flag of ["valid", "authorityPreserved", "withdrawalVerified", "futureAuthorizationVerified"]) assert.equal(receipt.legacyVerification[flag], true);
      assert.equal(receipt.journalHash, intent.states[0].journalHash);
      assert.equal(f.readOld(store => store.getRevision("one")), receipt.actualRevision);
      assert.deepEqual(sorted(f.readOld()), sorted(request.plan.snapshot.legacyRecords));
      assertNativeUnchanged(); assertRetained(retained);
    };
    for (let repeat = 0; repeat < 2; repeat++) {
      for (const method of ["apply", "recover", "verify"]) assertZeroReceipt(f.applier()[method]("one", request.options));
      for (const method of ["applyRollback", "recoverRollbackApply", "verifyRollbackApplied"]) assertZeroReceipt(f.migration[method]("one", request.options));
    }
  }, settings);
}
