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
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "synthetic-case-")); fs.chmodSync(root, 0o700);
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

function sourceEvidence(f) {
  const context = openLegacyAuthorizationResources(f.options), source = f.sources[0];
  try {
    const run = context.product.getWorkRun(source.runId);
    let gateError = null;
    try { context.candidates._assertCandidateVisible(source.profileId,
      context.receipts.get(source.profileId).candidates[source.candidateId]); }
    catch (error) { gateError = error.code; }
    const reviewed = context.engine.isReviewCommitted(source.profileId, source.item);
    const search = context.engine.search({profileId: source.profileId, query: source.item.content,
      workspace: f.repo, scopes:[source.item.scope], maxSensitivity:'private', now:f.options.now, limit:100, maxBytes:131072});
    return { runStatus:run.status, sourceGateError:gateError, reviewCommitted:reviewed,
      sourceReturned:search.items.some(row=>row.id===source.item.id) };
  } finally { context.close(); }
}
function report(name, fields) { console.log('SOURCE_STATUS_EVIDENCE '+JSON.stringify({name,...fields})); }

test('completed accepted source stays visible through real parsers and original gates', async t => {
  const f = await fixture(t), bytes = disk(f.root), snap = f.snapshot(), result = f.verify(snap);
  const evidence=sourceEvidence(f);
  assert.equal(evidence.runStatus,'completed'); assert.equal(evidence.sourceGateError,null);
  assert.equal(evidence.reviewCommitted,true); assert.equal(evidence.sourceReturned,true);
  assert.ok(cellsFor(snap,f.sources[0].item).some(cell=>cell.visible));
  assert.equal(result.valid,true); assert.deepEqual(disk(f.root),bytes);
  report('completed-control',{...evidence,valid:result.valid,readOnlyBytesPreserved:true});
});

test('real sealed policy withdrawal is a legitimate invisible accepted source', async t => {
  const f=await fixture(t,{withdraw:true}), bytes=disk(f.root), snap=f.snapshot(), result=f.verify(snap);
  const evidence=sourceEvidence(f);
  assert.equal(evidence.runStatus,'completed'); assert.equal(evidence.sourceGateError,'MEMORY_CANDIDATE_SOURCE_UNAVAILABLE');
  assert.equal(evidence.reviewCommitted,false); assert.equal(evidence.sourceReturned,false);
  assert.ok(cellsFor(snap,f.sources[0].item).every(cell=>!cell.visible));
  assert.equal(result.valid,true); assert.deepEqual(disk(f.root),bytes);
  report('sealed-policy-control',{...evidence,valid:result.valid,
    reasons:result.excluded.find(row=>row.id===f.sources[0].item.id).reasons,readOnlyBytesPreserved:true});
});

for (const status of ['canceled','skipped']) test(`contradictory accepted receipt with durable ${status} Run is rejected even by fresh capture`,async t=>{
  const f=await fixture(t), snapshotBefore=f.snapshot(), source=f.sources[0];
  // Prove this is not a legal post-acceptance Run transition, using the actual dispatcher.
  const product=new JsonlProductStore({paths:f.paths,readOnly:true}); product.openReadOnly();
  try {const dispatcher=createWorkDispatcher({store:product,now:()=>f.options.now});
    assert.throws(()=>dispatcher.transition(source.runId,status),error=>error.code==='INVALID_WORK_RUN_TRANSITION');}
  finally {product.close();}
  // Exactly the existing missing-run regression pattern: a valid durable synthetic
  // Product snapshot, original checksum, no fabricated candidate or policy receipt.
  const state=JSON.parse(fs.readFileSync(f.paths.stateSnapshotPath,'utf8'));
  const run=state.workRuns.find(row=>row.id===source.runId); assert.equal(run.status,'completed'); run.status=status;
  state.checksum=snapshotChecksum(state);
  fs.writeFileSync(f.paths.stateSnapshotPath,JSON.stringify(state)+'\n',{mode:0o600});
  const bytes=disk(f.root); let originalPreimageError=null;
  try {f.verify(snapshotBefore);} catch(error){originalPreimageError=error.code;}
  assert.equal(originalPreimageError,'MEMORY_ROLLBACK_REVIEW_SOURCE_MISMATCH');
  assert.throws(() => f.snapshot(), { code: 'MEMORY_ROLLBACK_REVIEW_SOURCE_MISMATCH' });
  assert.deepEqual(disk(f.root),bytes);
  report(status,{illegalTransitionRejected:true,freshCaptureRejected:true,originalPreimageError,readOnlyBytesPreserved:true});
});
