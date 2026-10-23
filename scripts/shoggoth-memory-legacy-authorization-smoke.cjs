"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { JsonlProductStore, DEFAULT_AGENT_PROFILE_ID, snapshotChecksum } = require("../app/agent-service/product-store");
const { ChatSessionStore } = require("../app/agent-service/chat-session-store");
const { TranscriptStore } = require("../app/agent-service/transcript-store");
const { MemoryStore } = require("../app/agent-service/memory-store");
const { MemoryEngine, workspaceMemoryRefs } = require("../app/agent-service/memory-engine");
const { RecallPolicyStore } = require("../app/agent-service/recall-policy-store");
const { MemoryCandidateStore } = require("../app/agent-service/memory-candidate-store");
const { MemoryCandidateService } = require("../app/agent-service/memory-candidate-service");
const { ConversationRecallService } = require("../app/agent-service/conversation-recall-service");
const { createWorkDispatcher } = require("../app/agent-service/work-run");
const { captureLegacyAuthorizationSnapshot, verifyLegacyRollback } = require("../app/agent-service/shoggoth-memory/legacy-rollback-verifier.cjs");
const { openLegacyAuthorizationResources } = require("../app/agent-service/shoggoth-memory/legacy-authorization-verifier.cjs");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}` : JSON.stringify(value);
function disk(root) {
  const rows = [];
  const walk = directory => {
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name), s = fs.lstatSync(target);
      if (s.isDirectory()) { rows.push([target, s.dev, s.ino, s.mode]); walk(target); }
      else rows.push([target, sha(fs.readFileSync(target)), s.dev, s.ino, s.mode, s.nlink, s.mtimeMs, s.ctimeMs]);
    }
  }; walk(root); return rows;
}
async function fixture(t, { withdraw = false, stageFirst = false } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-legacy-auth-")); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const repo = path.join(root, "repo"), linked = path.join(root, "linked"), other = path.join(root, "other");
  fs.mkdirSync(path.join(repo, ".git", "worktrees", "linked"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(linked, { mode: 0o700 }); fs.mkdirSync(other, { mode: 0o700 });
  fs.writeFileSync(path.join(linked, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "linked")}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(repo, ".git", "worktrees", "linked", "commondir"), "../..\n", { mode: 0o600 });
  let clock = 1000, serial = 0; const tick = () => ++clock;
  const product = new JsonlProductStore({ paths, now: tick }); product.open();
  const main = product.putAgentProfile({ ...product.getAgentProfile(DEFAULT_AGENT_PROFILE_ID), defaultCwd: repo });
  const peer = product.putAgentProfile({ ...main, id: crypto.randomUUID(), name: "Synthetic peer", agentId: "synthetic-peer", runtimeProfileId: "synthetic-peer", isDefault: false, defaultCwd: linked });
  const profiles = [main.id, peer.id];
  const sessions = new ChatSessionStore({ paths, now: tick }); sessions.open();
  const transcripts = new TranscriptStore({ paths, now: tick }); transcripts.open();
  const store = new MemoryStore({ paths }); store.open();
  const engine = new MemoryEngine({ store, transcriptStore: transcripts, chatSessionStore: sessions, strictSourceResolution: true,
    sharedProfiles: () => product.listAgentProfiles().map(p => p.id), now: tick }); engine.open(profiles);
  const dispatcher = createWorkDispatcher({ store: product, now: tick });
  const recall = new ConversationRecallService({ paths, transcriptStore: transcripts, chatSessionStore: sessions, workDispatcher: dispatcher,
    getRunSessionKey: run => run.sourceId, recallPolicy: engine.recallPolicy, memoryStore: store, now: tick });
  const receipts = new MemoryCandidateStore({ paths, now: tick });
  let answer = { candidates: [] };
  const candidates = new MemoryCandidateService({ candidateStore: receipts, memoryEngine: engine, memoryStore: store,
    conversationRecallService: recall, chatSessionStore: sessions, extractCandidates: async () => answer, isProfileEligible: () => true, now: tick });
  const sources = [];
  for (const [profileId, workspace, scope] of [[main.id, repo, "user"], [peer.id, linked, "project"]]) {
    const session = sessions.createSession({ operationId: `session-${++serial}`, profileId, workspace, createdAt: tick() });
    const bindingId = `binding-${serial}`; sessions.requestBinding(session.sessionKey, bindingId, tick());
    sessions.completeBinding(session.sessionKey, bindingId, `synthetic-runtime-${serial}`);
    const runId = `source-run-${serial}`;
    dispatcher.enqueue({ id: runId, source: "chat", sourceId: session.sessionKey, idempotencyKey: `source-command-${serial}`, profileId, workspace });
    assert.equal(dispatcher.admit(runId).disposition, "started"); dispatcher.transition(runId, "running"); dispatcher.transition(runId, "completed");
    const eventId = `source-event-${serial}`, text = `I prefer cobalt-${serial} telescope calibration every Friday.`;
    const event = transcripts.appendEvent({ profileId, sessionId: session.id, runId, id: eventId, kind: "user", content: { text }, runtimeRef: null, contextExcluded: false, occurredAt: tick() });
    answer = { candidates: [{ eventId, sourceQuote: `cobalt-${serial} telescope calibration`, content: `User prefers cobalt-${serial} telescope calibration`, scope }] };
    assert.equal((await candidates.processSession({ profileId, sessionId: session.id })).created, 1);
    const page = candidates.list({ profileId });
    let memoryItem;
    if (stageFirst && profileId === main.id) {
      memoryItem = engine.proposeReviewedBatch({ profileId, expectedRevision: store.getRevision(profileId), proposals: [{
        id: `reviewed-${page.items[0].id}`, profileId, content: page.items[0].content, scope, sensitivity: page.items[0].sensitivity,
        type: "semantic", classification: "imported", sourceRefs: [event.id, runId, ...(["project", "workspace"].includes(scope) ? workspaceMemoryRefs(workspace, scope) : [])],
      }] })[0];
      assert.equal(memoryItem.status, "candidate");
    } else {
      const accepted = candidates.accept({ profileId, candidateId: page.items[0].id, expectedRevision: page.revision, expectedMemoryRevision: store.getRevision(profileId) });
      memoryItem = accepted.memoryItem;
      assert.equal(memoryItem.status, "active"); assert.equal(engine.isReviewCommitted(profileId, memoryItem), true);
    }
    sources.push({ profileId, workspace, session, runId, event, candidateId: page.items[0].id, item: memoryItem });
  }
  const plain = [];
  for (const scope of ["user", "agent", "project", "workspace"]) {
    const refs = [`user-edit:synthetic-${scope}`, ...(["project", "workspace"].includes(scope) ? workspaceMemoryRefs(repo, scope) : [])];
    plain.push(engine.propose({ profileId: main.id, content: `Owner ${scope} amber observatory convention`, scope, type: "semantic", classification: "explicit", sourceRefs: refs }));
  }
  plain.push(engine.propose({ profileId: main.id, content: "Private indigo observatory schedule", scope: "user", type: "semantic", classification: "explicit", sourceRefs: ["user-edit:synthetic-private"], sensitivity: "private" }));
  for (const [id, fields] of [["candidate", { status: "candidate" }], ["restricted", { sensitivity: "restricted" }], ["future", { validFrom: 30_000 }], ["expired", { validUntil: 5000 }], ["untrusted", { sourceRefs: ["untrusted:synthetic"] }]]) {
    store.upsert({ ...plain[0], id, content: `${id} forbidden celadon memory`, createdAt: tick(), updatedAt: tick(), ...fields });
  }
  if (withdraw) {
    engine.recallPolicy.recordReason({ profileId: main.id, item: { ...plain[0], id: "source-withdrawal", content: "The cobalt telescope source was withdrawn", sourceRefs: [sources[0].event.id, sources[0].runId] }, reason: "forgotten", operationId: "known-source-withdrawal" });
    assert.equal(engine.isReviewCommitted(main.id, sources[0].item), false);
  }
  const policyState = engine.recallPolicy._read(main.id, engine.recallPolicy._paths(main.id));
  const rows = store.list(main.id), revision = store.getRevision(main.id), profile = path.join(paths.agentsDir, main.id);
  const migration = path.join(profile, "memory-migration-shoggoth-v1"), workspace = path.join(profile, "memory-workspace");
  for (const directory of [migration, path.join(migration, "backup"), workspace, path.join(profile, "generated")]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const [target, bytes] of [[path.join(migration, "manifest.json"), '{"synthetic":true}\n'], [path.join(migration, "legacy-snapshot.json"), JSON.stringify(rows) + "\n"], [path.join(workspace, "MEMORY.md"), "# Synthetic file owner\n"]]) fs.writeFileSync(target, bytes, { mode: 0o600 });
  const plan = { format: "shoggoth-stopped-memory-rollback-plan", schemaVersion: 1, profileId: main.id, mappingReady: true, blockers: [],
    snapshot: { legacyRecords: rows, recallRecords: policyState.records, revisions: { legacy: revision, recall: policyState.revision }, legacyFiles: [], files: [], backupFiles: [], product: { files: [] }, core: { files: [] } }, journalBatches: [] };
  recall.close(); engine.close(); store.close(); sessions.close(); transcripts.close(); product.close();
  const options = { paths, profileId: main.id, now: 20_000, assertCurrent: () => true };
  const snapshot = () => { const captured = captureLegacyAuthorizationSnapshot(options); plan.authorizationSnapshotHash = captured.sha256; return captured; };
  const verify = authorizationSnapshot => verifyLegacyRollback({ ...options, plan, authorizationSnapshot });
  return { root, paths, main, peer, profiles, repo, linked, other, sources, plain, profile, plan, options, snapshot, verify };
}
function cellsFor(snapshot, item, fields = {}) { return snapshot.cells.filter(c => c.home === item.profileId && c.id === item.id && Object.entries(fields).every(([k, v]) => c[k] === v)); }
function rewriteReceipt(f, profileId, mutate) {
  const store = new MemoryCandidateStore({ paths: f.paths }); store.mutate(profileId, store.get(profileId).revision, mutate);
}


test("real durable Product, ready Session, completed Run, Transcript and CandidateService accepted receipts stay visible and read only", async t => {
  const f = await fixture(t), before = disk(f.root), snapshot = f.snapshot(), result = f.verify(snapshot);
  assert.equal(result.valid, true); assert.equal(result.authorizationMatrixVerified, true); assert.equal(result.authorizationResourceReadOnlyVerified, true);
  assert.equal(result.authorizationProfileCount, 2); assert.ok(result.authorizationCellCount >= 100); assert.equal(result.authorizationPersistedRecordCount, snapshot.records.length);
  assert.ok(cellsFor(snapshot, f.sources[0].item, { viewer: f.main.id }).every(c => c.visible));
  assert.ok(cellsFor(snapshot, f.sources[0].item, { viewer: f.peer.id }).every(c => c.visible));
  assert.ok(result.visibleIds.includes(f.sources[0].item.id), "valid reviewed item must not pass by being hidden");
  assert.deepEqual(disk(f.root), before); assert.equal(JSON.stringify(result).includes("cobalt"), false);
});
test("shared user/project/workspace, agent privacy, sensitivity and git worktree audience use original algorithms", async t => {
  const f = await fixture(t), snapshot = f.snapshot();
  const byScope = scope => f.plain.find(r => r.scope === scope);
  assert.ok(cellsFor(snapshot, byScope("user"), { viewer: f.peer.id }).every(c => c.visible));
  assert.ok(cellsFor(snapshot, byScope("agent"), { viewer: f.peer.id }).every(c => !c.visible));
  assert.ok(cellsFor(snapshot, byScope("project"), { viewer: f.peer.id, workspace: f.linked }).every(c => c.visible));
  assert.ok(cellsFor(snapshot, byScope("workspace"), { viewer: f.peer.id, workspace: f.linked }).every(c => !c.visible));
  assert.ok(cellsFor(snapshot, byScope("workspace"), { viewer: f.peer.id, workspace: f.repo }).every(c => c.visible));
  const privateItem = f.plain.find(r => r.sensitivity === "private");
  assert.ok(cellsFor(snapshot, privateItem, { sensitivity: "normal" }).every(c => !c.visible));
  assert.ok(cellsFor(snapshot, privateItem, { sensitivity: "private" }).every(c => c.visible));
  for (const id of ["candidate", "restricted", "future", "expired", "untrusted"]) assert.ok(snapshot.cells.filter(c => c.id === id).every(c => !c.visible));
  assert.equal(f.verify(snapshot).authorizationMatrixVerified, true);
});
test("known real source withdrawal remains denied for owner and peers through original CandidateService and Policy", async t => {
  const f = await fixture(t, { withdraw: true }), before = disk(f.root), snapshot = f.snapshot();
  assert.ok(cellsFor(snapshot, f.sources[0].item).every(c => !c.visible));
  const result = f.verify(snapshot); assert.equal(result.authorizationMatrixVerified, true);
  assert.ok(result.excluded.some(r => r.id === f.sources[0].item.id && r.reasons.includes("review-source-denied")));
  assert.deepEqual(disk(f.root), before);
});
test("preserved reviewed/shared rows cannot silently pass without authorization resources", async t => {
  const f = await fixture(t), before = disk(f.root);
  assert.throws(() => f.verify(), e => e.code === "MEMORY_ROLLBACK_AUTHORIZATION_SNAPSHOT_REQUIRED"); assert.deepEqual(disk(f.root), before);
});
for (const type of ["missing", "corrupt", "pending", "rejected", "changed-content"]) test(`review ${type} is explicit failure, never hidden compatibility`, async t => {
  const f = await fixture(t), source = f.sources[0], target = path.join(f.profile, "memory", "candidate-review.json");
  if (type === "missing") fs.unlinkSync(target);
  else if (type === "corrupt") fs.writeFileSync(target, "{}\n", { mode: 0o600 });
  else rewriteReceipt(f, source.profileId, state => {
    const candidate = state.candidates[source.candidateId];
    if (type === "changed-content") candidate.content = "Unsupported changed cyan source";
    else { candidate.status = type; candidate.acceptedMemoryId = null; }
  });
  const before = disk(f.root);
  assert.throws(() => f.snapshot(), e => type === "corrupt" ? e.code === "MEMORY_CANDIDATE_CORRUPT"
    : ["MEMORY_ROLLBACK_REVIEW_RESOURCE_MISSING", "MEMORY_ROLLBACK_REVIEW_RECEIPT_MISMATCH"].includes(e.code));
  assert.deepEqual(disk(f.root), before);
});
test("missing source event fails without creating replacement files", async t => {
  const f = await fixture(t), journal = path.join(f.paths.agentsDir, f.main.id, "transcripts", f.sources[0].session.id, "events.jsonl");
  fs.unlinkSync(journal); const before = disk(f.root);
  assert.throws(() => f.snapshot(), e => ["TRANSCRIPT_MANIFEST_CORRUPT", "MEMORY_ROLLBACK_REVIEW_RESOURCE_MISSING"].includes(e.code)); assert.deepEqual(disk(f.root), before);
});
test("missing Session catalog is explicit failure and no writer lease is acquired", async t => {
  const f = await fixture(t); fs.unlinkSync(path.join(f.paths.stateDir, "chat-sessions.json")); const before = disk(f.root);
  assert.throws(() => f.snapshot(), e => e.code === "MEMORY_ROLLBACK_AUTHORIZATION_RESOURCE_MISSING"); assert.deepEqual(disk(f.root), before);
});
test("missing Product Run journal is explicit failure and no empty journal is manufactured", async t => {
  const f = await fixture(t); fs.unlinkSync(f.paths.eventLogPath); const before = disk(f.root);
  assert.throws(() => f.snapshot(), e => e.code === "MEMORY_ROLLBACK_AUTHORIZATION_RESOURCE_MISSING"); assert.deepEqual(disk(f.root), before);
});
test("peer policy missing cannot disappear behind original Engine damaged-peer catch", async t => {
  const f = await fixture(t); fs.unlinkSync(path.join(f.paths.agentsDir, f.peer.id, "memory", "recall-policy.seal.json")); const before = disk(f.root);
  assert.throws(() => f.snapshot(), e => e.code === "MEMORY_ROLLBACK_AUTHORIZATION_RESOURCE_MISSING"); assert.deepEqual(disk(f.root), before);
});
test("foreign Session/Product atomic transaction and transcript torn tail are rejected without recovery", async t => {
  const f = await fixture(t), residue = path.join(f.paths.stateDir, "chat-sessions.json.backup-foreign"); fs.writeFileSync(residue, "foreign", { mode: 0o600 });
  const before = disk(f.root); assert.throws(() => f.snapshot(), e => e.code === "MEMORY_ROLLBACK_TRANSACTION_UNSETTLED"); assert.deepEqual(disk(f.root), before);
  fs.unlinkSync(residue);
  const journal = path.join(f.paths.agentsDir, f.main.id, "transcripts", f.sources[0].session.id, "events.jsonl"); fs.appendFileSync(journal, '{"partial":');
  const torn = disk(f.root); assert.throws(() => f.snapshot(), e => e.code === "TRANSCRIPT_TRANSACTION_UNSETTLED"); assert.deepEqual(disk(f.root), torn);
});
test("all forbidden writer startup, view, repair, model, lease and filesystem mutation paths stay unused", async t => {
  const f = await fixture(t), originals = [], before = disk(f.root);
  const block = (object, key) => { originals.push([object, key, object[key]]); object[key] = () => { throw new Error(`forbidden: ${key}`); }; };
  for (const [object, methods] of [[JsonlProductStore.prototype, ["open", "putWorkRun", "putAgentProfile"]], [ChatSessionStore.prototype, ["open", "createSession", "requestBinding"]],
    [TranscriptStore.prototype, ["open", "_repairPartialTail", "_writeManifest", "appendEvent"]], [MemoryStore.prototype, ["open", "upsert", "upsertMany", "_writeSnapshot"]],
    [MemoryEngine.prototype, ["open", "_rebuildViews", "quarantineInvalidReviewed", "_quarantineUnreceiptedReviewed"]], [RecallPolicyStore.prototype, ["open", "_load", "_reconcile", "_init", "_append"]],
    [MemoryCandidateService.prototype, ["processSession", "accept", "acceptMany"]], [fs, ["mkdirSync", "chmodSync", "fchmodSync", "writeFileSync", "appendFileSync", "renameSync", "unlinkSync", "ftruncateSync", "fsyncSync"]]]) for (const method of methods) block(object, method);
  try { assert.equal(f.verify(f.snapshot()).authorizationMatrixVerified, true); }
  finally { for (const [object, key, value] of originals.reverse()) object[key] = value; }
  assert.deepEqual(disk(f.root), before);
});
test("forged boolean matrix cannot grant denied peer agent or hide accepted valid reviewed fact", async t => {
  const f = await fixture(t), snapshot = structuredClone(f.snapshot()), cell = snapshot.cells.find(c => c.id === f.sources[0].item.id && c.visible);
  cell.visible = false; snapshot.sha256 = sha(stable(Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "sha256"))));
  f.plan.authorizationSnapshotHash = snapshot.sha256;
  const before = disk(f.root); assert.throws(() => f.verify(snapshot), e => e.code === "MEMORY_ROLLBACK_AUTHORIZATION_MATRIX_CHANGED"); assert.deepEqual(disk(f.root), before);
});
test("changed receipt authority after captured preimage fails CAS without rewriting draft", async t => {
  const f = await fixture(t), snapshot = f.snapshot();
  rewriteReceipt(f, f.main.id, state => { state.usage.calls += 1; }); const before = disk(f.root);
  assert.throws(() => f.verify(snapshot), e => e.code === "MEMORY_ROLLBACK_AUTHORIZATION_SOURCE_CHANGED"); assert.deepEqual(disk(f.root), before);
});
test("one owned new real Store batch preserves old authorization matrix but is proven persisted independently", async t => {
  const f = await fixture(t), snapshot = f.snapshot(), store = new MemoryStore({ paths: f.paths }); store.open();
  const added = { ...f.plain[1], id: "post-migration-new", content: "Fresh mauve telescope assembly instruction", sourceRefs: ["user-edit:new-mauve"], createdAt: 15000, updatedAt: 15000 };
  f.plan.journalBatches.push({ expectedRevision: store.getRevision(f.main.id), items: [added] }); store.upsert(added); store.close();
  const before = disk(f.root), result = f.verify(snapshot); assert.equal(result.authorizationMatrixVerified, true); assert.ok(result.visibleIds.includes(added.id));
  assert.equal(result.legacyRevision, f.plan.snapshot.revisions.legacy + 1); assert.equal(result.authorizationPersistedRecordCount, snapshot.records.length);
  assert.deepEqual(disk(f.root), before);
});
test("genuine staged review batch plus pending original receipt is preserved as candidate with no actor access", async t => {
  const f = await fixture(t, { stageFirst: true }), before = disk(f.root), snapshot = f.snapshot(), staged = f.sources[0].item;
  assert.equal(staged.status, "candidate"); assert.ok(cellsFor(snapshot, staged).every(c => !c.visible));
  const result = f.verify(snapshot); assert.equal(result.authorizationMatrixVerified, true);
  assert.ok(result.excluded.some(r => r.id === staged.id && r.reasons.includes("candidate"))); assert.deepEqual(disk(f.root), before);
});
test("snapshot without fixed plan hash binding is never an accepted authorization comparison", async t => {
  const f = await fixture(t), snapshot = f.snapshot(); delete f.plan.authorizationSnapshotHash;
  const before = disk(f.root); assert.throws(() => f.verify(snapshot), e => e.code === "MEMORY_ROLLBACK_AUTHORIZATION_PLAN_BINDING_REQUIRED"); assert.deepEqual(disk(f.root), before);
});
for (const type of ["missing-run", "non-chat-owner"]) test(`exact durable ${type} is explicit source failure`, async t => {
  const f = await fixture(t), state = JSON.parse(fs.readFileSync(f.paths.stateSnapshotPath, "utf8"));
  if (type === "missing-run") state.workRuns = state.workRuns.filter(run => run.id !== f.sources[0].runId);
  else state.workRuns.find(run => run.id === f.sources[0].runId).source = "inspiration";
  // Tamper a real fixture's valid durable owner snapshot; this removes/changes
  // authority and never manufactures a receipt or a successful source oracle.
  state.checksum = snapshotChecksum(state); fs.writeFileSync(f.paths.stateSnapshotPath, JSON.stringify(state) + "\n", { mode: 0o600 });
  const before = disk(f.root); assert.throws(() => f.snapshot(), e => type === "missing-run"
    ? e.code === "MEMORY_ROLLBACK_REVIEW_RESOURCE_MISSING" : e.code === "MEMORY_ROLLBACK_REVIEW_SOURCE_UNSUPPORTED"); assert.deepEqual(disk(f.root), before);
});
test("changed peer catalog after real preimage fails shared authority CAS", async t => {
  const f = await fixture(t), snapshot = f.snapshot(), product = new JsonlProductStore({ paths: f.paths, now: () => 3000 }); product.open();
  product.putAgentProfile({ ...product.getAgentProfile(f.peer.id), name: "Changed synthetic peer" }); product.close();
  const before = disk(f.root); assert.throws(() => f.verify(snapshot), e => e.code === "MEMORY_ROLLBACK_AUTHORIZATION_SOURCE_CHANGED"); assert.deepEqual(disk(f.root), before);
});
test("viewer real content cutoff denies an old foreign item while its home authorization remains intact", async t => {
  const f = await fixture(t), store = new MemoryStore({ paths: f.paths }); store.open();
  const policy = new RecallPolicyStore({ paths: f.paths, memoryStore: store, now: () => 5000 }); policy.open(f.profiles);
  policy.recordReason({ profileId: f.peer.id, item: { ...f.plain[0], id: "viewer-cutoff", profileId: f.peer.id }, reason: "forgotten", operationId: "viewer-real-content-cutoff" });
  policy.close(); store.close();
  const before = disk(f.root), snapshot = f.snapshot();
  assert.ok(cellsFor(snapshot, f.plain[0], { viewer: f.main.id }).every(c => c.visible));
  assert.ok(cellsFor(snapshot, f.plain[0], { viewer: f.peer.id }).every(c => !c.visible));
  assert.equal(f.verify(snapshot).authorizationMatrixVerified, true); assert.deepEqual(disk(f.root), before);
});
test("readonly durable owners reject explicit mutation APIs after openReadOnly", async t => {
  const f = await fixture(t), before = disk(f.root), context = openLegacyAuthorizationResources(f.options);
  try {
    assert.throws(() => context.product.putAgentProfile({ ...context.product.getAgentProfile(f.main.id), name: "attempted writer" }), e => e.code === "STORE_READ_ONLY");
    assert.throws(() => context.sessions.createSession({ operationId: "forbidden-new-session", profileId: f.main.id, workspace: f.repo, createdAt: 20000 }), e => e.code === "CHAT_SESSION_READ_ONLY");
    assert.throws(() => context.transcripts.ensureSession({ profileId: f.main.id, sessionId: f.sources[0].session.id }), e => e.code === "TRANSCRIPT_READ_ONLY");
    assert.throws(() => context.receipts.mutate(f.main.id, null, () => {}), e => e.code === "MEMORY_LEGACY_READ_ONLY");
  } finally { context.close(); }
  assert.deepEqual(disk(f.root), before);
});
test("original repository resolver cache must match fixed git metadata before authorization capture", async t => {
  const f = await fixture(t);
  fs.mkdirSync(path.join(f.other, ".git"), { mode: 0o700 });
  fs.writeFileSync(path.join(f.repo, ".git", "worktrees", "linked", "commondir"), path.join(f.other, ".git") + "\n", { mode: 0o600 });
  const before = disk(f.root); assert.throws(() => f.snapshot(), e => e.code === "MEMORY_ROLLBACK_WORKSPACE_SOURCE_CHANGED"); assert.deepEqual(disk(f.root), before);
});
test("all five original types, four scopes and four statuses retain real Policy permissions in the matrix", async t => {
  const f = await fixture(t), store = new MemoryStore({ paths: f.paths }); store.open();
  const policy = new RecallPolicyStore({ paths: f.paths, memoryStore: store, now: () => 5000 }); policy.open(f.profiles);
  const rows = [];
  for (const type of ["semantic", "episodic", "procedural", "project", "temporary"]) for (const scope of ["user", "agent", "project", "workspace"]) for (const status of ["active", "candidate", "superseded", "deleted"]) {
    const id = `matrix-${type}-${scope}-${status}`;
    const row = { ...f.plain[0], id, type, scope, status, content: `${id} synthetic astronomical convention`, validFrom: 0,
      sourceRefs: [`user-edit:${id}`, ...(["project", "workspace"].includes(scope) ? workspaceMemoryRefs(f.repo, scope) : [])], createdAt: 2000, updatedAt: 6000 };
    if (status === "deleted") {
      store.upsert({ ...row, status: "active" });
      policy.recordReason({ profileId: f.main.id, item: { ...row, status: "active" }, reason: "forgotten", operationId: `delete-${id}` });
    }
    store.upsert(row); rows.push(row);
  }
  const policyState = policy._read(f.main.id, policy._paths(f.main.id));
  f.plan.snapshot.legacyRecords = store.list(f.main.id); f.plan.snapshot.revisions.legacy = store.getRevision(f.main.id);
  f.plan.snapshot.recallRecords = policyState.records; f.plan.snapshot.revisions.recall = policyState.revision;
  policy.close(); store.close();
  const before = disk(f.root), snapshot = f.snapshot(), result = f.verify(snapshot);
  assert.equal(rows.length, 80); assert.equal(result.authorizationMatrixVerified, true);
  for (const row of rows) {
    const own = cellsFor(snapshot, row, { viewer: f.main.id, workspace: f.repo, sensitivity: "private" });
    assert.equal(own.length, 1); assert.equal(own[0].visible, row.status === "active");
    const peer = cellsFor(snapshot, row, { viewer: f.peer.id, workspace: f.repo, sensitivity: "private" });
    assert.equal(peer[0].visible, row.status === "active" && row.scope !== "agent");
  }
  assert.deepEqual(disk(f.root), before);
});
