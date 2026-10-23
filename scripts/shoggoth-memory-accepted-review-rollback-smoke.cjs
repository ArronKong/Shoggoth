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
const { MemoryDatabase } = require("../app/agent-service/shoggoth-memory/database.cjs");
const { ShoggothMemoryMigration } = require("../app/agent-service/shoggoth-memory/migration.cjs");
const { FileMemoryStore } = require("../app/agent-service/shoggoth-memory/file-store.cjs");
const { ShoggothMemoryHost } = require("../app/agent-service/shoggoth-memory/host.cjs");
const { captureLegacyAcceptedReviewProof } = require("../app/agent-service/shoggoth-memory/legacy-accepted-review-verifier.cjs");
const { ShoggothMemoryService } = require("../app/agent-service/shoggoth-memory/service.cjs");
const { StoppedMemoryRollbackApply } = require("../app/agent-service/shoggoth-memory/rollback-apply.cjs");
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
async function fixture(t, { withdraw = false, stageFirst = false, addCount = 1, updateAgent = false, updateShared = false, deleteReviewed = false, changeReviewed = null, receiptMutation = null, addPending = false, originalAcceptedDelta = false, persistedDerived = false, sourceTombstoned = false } = {}) {
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
  const profileId = main.id, memory = path.join(paths.agentsDir, profileId, "memory");
  const names = ["events.jsonl", "snapshot.json", "recall-policy.jsonl", "recall-policy.seal.json", "provenance.jsonl", "candidate-review.json"];
  const files = names.map(name => ({ name, path: path.join(memory, name) })).filter(file => fs.existsSync(file.path));
  files.push({ name: "recall-policy-installed.json", path: path.join(paths.agentsDir, profileId, "recall-policy-installed.json") },
    { name: "recall-policy-installation.json", path: path.join(paths.agentsDir, ".recall-policy-installations", profileId + ".json") });
  let fault = () => {}, stopped = false;
  const migration = new ShoggothMemoryMigration({ paths, now: () => 20000, fault: (...args) => fault(...args),
    readLegacy: id => ({ records: store.list(id), files, revision: store.getRevision(id), recallRevision: engine.recallPolicy.getRevision(id),
      contentRevisions: Object.fromEntries(store.list(id).map(item => [item.id, store.getContentRevision(id,item.id)])),
      visibleIds: store.list(id).filter(item => item.status === "active" && item.validFrom <= 20000 && (item.validUntil === null || item.validUntil > 20000)
        && engine.recallPolicy.isMemoryVisible(id,item) && engine.isReviewCommitted(id,item)).map(item => item.id) }),
    assertLegacyCurrent: (id, snapshot, saved) => { assert.equal(snapshot.revision,store.getRevision(id)); for (const file of saved) assert.equal(sha(fs.readFileSync(file.source)),file.sha256); } });
  const database = new MemoryDatabase({ paths, now: () => 20000 }); database.open();
  const workspace = migration.locations(profileId).workspace;
  const host = new ShoggothMemoryHost({ paths, database, profileId, workspaceDir: workspace, roster: () => [{ id: profileId, workspace }], sessions: { list: () => [] } });
  const fileStore = new FileMemoryStore({ paths, database, migration, getHost: () => host, now: () => 20000 }); fileStore.open(); fileStore.ensureProfile(profileId);
  const added = Array.from({ length: addCount }, (_, index) => ({ ...plain.find(item => item.scope === "agent"), id: `new-agent-${index}`, content: `Fresh agent cobalt calibration ${index}`, sourceRefs: [`user-edit:actual-${index}`], createdAt: 19000, updatedAt: 19000 }));
  if (added.length) await fileStore.upsertMany(added);
  if (updateAgent) { const original = plain.find(item => item.scope === "agent"); await fileStore.upsert({ ...original, content: "Changed agent amber observatory convention", updatedAt: 19000 }); }
  if (updateShared) { const original = plain.find(item => item.scope === "user"); await fileStore.upsert({ ...original, content: "Changed shared amber observatory convention", updatedAt: 19000 }); }
  if (persistedDerived) {
    const current=fileStore.get(profileId,sources[0].item.id), row=fileStore._metadata(profileId).get(current.id);
    for (const key of ["startLine","endLine","fileHash"]) row[key]=current[key];
    database.db.prepare("UPDATE memory_file_records SET data=? WHERE profile_id=? AND id=?").run(JSON.stringify(row),profileId,current.id);
  }
  if (deleteReviewed) {
    await ShoggothMemoryService.prototype.delete.call({ assertProfile: id => assert.equal(id, profileId),
      recallPolicy: engine.recallPolicy, store: fileStore, now: () => 19000,
      // This original delete transaction fixture has no running reader to revoke.
      sharing: { withdraw() {}, async reconcileConfig() {} } }, { profileId, id: sources[0].item.id, operationId: "actual-native-delete" });
  }
  if (changeReviewed) await fileStore.upsert({ ...fileStore.get(profileId, sources[0].item.id), ...changeReviewed, updatedAt: 19000 });
  if (addPending || originalAcceptedDelta) {
    const session = sessions.createSession({ operationId: "later-real-source", profileId, workspace: repo, createdAt: tick() });
    sessions.requestBinding(session.sessionKey, "later-binding", tick()); sessions.completeBinding(session.sessionKey, "later-binding", "synthetic-later-runtime");
    const runId = "later-source-run";
    dispatcher.enqueue({ id: runId, source: "chat", sourceId: session.sessionKey, idempotencyKey: "later-command", profileId, workspace: repo });
    dispatcher.admit(runId); dispatcher.transition(runId,"running"); dispatcher.transition(runId,"completed");
    const text = "I prefer vermilion observatory observations every Monday.";
    const event = transcripts.appendEvent({ profileId, sessionId: session.id, runId, id: "later-source-event", kind: "user", content: { text }, runtimeRef: null, contextExcluded: false, occurredAt: tick() });
    answer = { candidates: [{ eventId: event.id, sourceQuote: "vermilion observatory observations", content: "User prefers vermilion observatory observations", scope: "user" }] };
    assert.equal((await candidates.processSession({ profileId, sessionId: session.id })).created,1);
    const page = candidates.list({profileId}), candidate = page.items.find(value => value.source.eventId === event.id);
    assert.ok(candidate);
    if (originalAcceptedDelta) {
      // A genuine old owner transaction after migration is foreign authority,
      // never disguised as a new native Review endpoint.
      const accepted = candidates.accept({profileId,candidateId:candidate.id,expectedRevision:page.revision,expectedMemoryRevision:store.getRevision(profileId)});
      await fileStore.upsert({ ...accepted.memoryItem, updatedAt: 19000 });
    }
  }
  if (receiptMutation) {
    const state=receipts.get(profileId); receipts.mutate(profileId,state.revision,next => receiptMutation(next, sources[0]));
  }
  if (sourceTombstoned) {
    const coreDatabase=new MemoryDatabase({paths,databasePath:path.join(paths.agentsDir,profileId,"memory-core.sqlite"),now:()=>20000});coreDatabase.open();
    coreDatabase.db.prepare("INSERT INTO memory_session_tombstones VALUES (?,?,?,?)").run(sources[0].session.id,profileId,"actual-native-forget",19000);coreDatabase.close();
  }
  const expectedRevisions = { legacy: store.getRevision(profileId), file: fileStore.getRevision(profileId), recall: engine.recallPolicy.getRevision(profileId) };
  fileStore.close(); database.close(); recall.close(); engine.close(); store.close(); sessions.close(); transcripts.close(); product.close(); stopped = true;
  const options = () => ({ expectedRevisions, now: 20000, assertServiceStopped: () => { assert.equal(stopped,true); return true; } });
  const applier = () => new StoppedMemoryRollbackApply({ migration, paths, fault: (...args) => fault(...args) });
  const plan = () => migration.planRollback(profileId, options());
  const prepare = (operationId = "synthetic-auth-rollback") => { const published = plan(); const input = { ...options(), operationId, planHash: published.planHash, ownershipHash: published.ownershipHash }; const prepared = applier().prepare(profileId,input); return { plan: published, options: { ...input, applyIntentHash: prepared.applyIntentHash }, prepared }; };
  return { root, paths, profileId, main, peer, profiles, repo, linked, other, sources, plain, workspace, migration, options, applier, plan, prepare, added,
    journal: path.join(memory,"events.jsonl"), snapshot: path.join(memory,"snapshot.json"), setFault(value) { fault=value; } };
}

function primary(f) { return [f.journal,f.snapshot].map(file=>({file,bytes:fs.existsSync(file)?fs.readFileSync(file):null,ino:fs.existsSync(file)?fs.statSync(file).ino:null})); }
function retained(rows) { for (const row of rows) { assert.equal(fs.existsSync(row.file),!!row.bytes); if(row.bytes) { assert.deepEqual(fs.readFileSync(row.file),row.bytes); assert.equal(fs.statSync(row.file).ino,row.ino); } } }
function json(file) { return JSON.parse(fs.readFileSync(file,"utf8")); }
function receiptProof(value, plan) {
  assert.equal(value.phase,"applied"); assert.equal(value.storageVerified,true); assert.equal(value.legacySearchVerified,true); assert.equal(value.canSelectLegacyWriter,false);
  const evidence=value.legacyVerification; assert.equal(evidence.authorizationMatrixVerified,true); assert.equal(evidence.authorizationSnapshotHash,plan.authorizationSnapshotHash);
  assert.equal(evidence.authorizationSourceOwnerScope,"chat-only"); assert.equal(evidence.authorizationWorkspaceScope,"private-fixed-git-metadata"); assert.equal(evidence.authorityPreserved,true);
}
test("existing accepted active has original physical candidate/receipt/activation and exact source proof", async t => {
  const f = await fixture(t, { addCount: 0 }), before = disk(f.paths.stateDir), p = f.plan();
  assert.equal(p.mappingReady,true); assert.deepEqual(p.blockers,[]);
  const proof=p.snapshot.acceptedReviewProof, entry=proof.proofs.find(value=>value.id===f.sources[0].item.id);
  assert.equal(proof.audienceProven,false); assert.equal(entry.source.authorized,true);
  assert.ok(entry.transaction.candidateSequence < entry.transaction.activationSequence);
  assert.equal(entry.id,f.sources[0].item.id); assert.equal(entry.status,"active");
  assert.equal(json(p.ownershipPath).acceptedReviewProofHash,proof.sha256);
  // Plan publication is inside the native archive; existing authority remains.
  assert.deepEqual(disk(f.paths.stateDir).filter(row=>!row[0].includes("rollback-plans")),before);
});
test("native actual delete of accepted fact applies its original id/scope/source and reopens hidden", async t => {
  const f = await fixture(t, { addCount: 0, deleteReviewed: true }), receiptFile=path.join(f.paths.agentsDir,f.profileId,"memory","candidate-review.json"), receiptBefore=fs.readFileSync(receiptFile);
  const preliminary=f.plan(); assert.deepEqual(preliminary.blockers,[]); assert.deepEqual(preliminary.legacyCompatibility.blockers,[]);
  const r=f.prepare(), intent=json(path.join(r.prepared.operationDirectory,"intent.json"));
  assert.equal(r.plan.operations.length,1); assert.equal(r.plan.operations[0].id,f.sources[0].item.id);
  assert.equal(r.plan.operations[0].after.scope,"user"); assert.equal(r.plan.operations[0].after.status,"deleted");
  assert.equal(intent.acceptedReviewProofHash,r.plan.snapshot.acceptedReviewProof.sha256);
  const value=f.applier().apply(f.profileId,r.options); receiptProof(value,r.plan);
  assert.deepEqual(fs.readFileSync(receiptFile),receiptBefore);
  const resources=openLegacyAuthorizationResources({paths:f.paths,profileId:f.profileId,now:20000,assertCurrent:()=>true});
  try {
    assert.equal(resources.store.get(f.profileId,f.sources[0].item.id).status,"deleted");
    for(const viewer of resources.profileIds) assert.equal(resources.engine.search({profileId:viewer,query:"cobalt-1 telescope",workspace:f.repo,maxSensitivity:"private",limit:100}).items.some(row=>row.id===f.sources[0].item.id),false);
  } finally {resources.close();}
  const current=primary(f); receiptProof(f.applier().recover(f.profileId,r.options),r.plan); retained(current);
});
test("legal new pending source leaves complete old accepted receipt set intact and is not blanket backup drift", async t => {
  const f=await fixture(t,{addCount:0,addPending:true}), before=primary(f), p=f.plan();
  assert.equal(p.mappingReady,true); assert.deepEqual(p.blockers,[]);
  assert.equal(p.snapshot.acceptedReviewProof.delta.length,1); assert.equal(p.snapshot.acceptedReviewProof.delta[0].to,"pending");
  retained(before); const r=f.prepare("receipt-delta-preserve"); receiptProof(f.applier().apply(f.profileId,r.options),r.plan);
});
test("real accepted original transaction after migration is proved but foreign old writer and active audience stay blocked", async t => {
  const f=await fixture(t,{addCount:0,originalAcceptedDelta:true}), before=primary(f), p=f.plan();
  assert.ok(p.snapshot.acceptedReviewProof.delta.some(value=>value.to==="accepted"));
  assert.ok(p.blockers.some(value=>value.code==="LEGACY_AUTHORITY_CHANGED"));
  assert.ok(p.blockers.some(value=>value.code==="LEGACY_SHARED_SCOPE_SEMANTICS"));
  assert.throws(()=>f.prepare("foreign-original-review"),error=>error.code==="MEMORY_ROLLBACK_MAPPING_BLOCKED"); retained(before);
});
for (const [name, mutation] of [
  ["accepted正文变化",(next,source)=>{next.candidates[source.candidateId].content="Tampered accepted observatory fact";}],
  ["accepted quote hash变化",(next,source)=>{next.candidates[source.candidateId].source.quoteHash="a".repeat(64);}],
  ["accepted改pending",(next,source)=>{next.candidates[source.candidateId].status="pending";next.candidates[source.candidateId].acceptedMemoryId=null;}],
  ["accepted改rejected",(next,source)=>{next.candidates[source.candidateId].status="rejected";next.candidates[source.candidateId].acceptedMemoryId=null;}],
  ["accepted回执删除",(next,source)=>{delete next.candidates[source.candidateId];}],
]) test(`original checksum-valid receipt mutation ${name} is rejected and writes no old journal`, async t=>{
  const f=await fixture(t,{addCount:0,receiptMutation:mutation}), before=primary(f);
  assert.throws(()=>f.plan(),error=>["MEMORY_ROLLBACK_REVIEW_RESOURCE_MISSING","MEMORY_ROLLBACK_REVIEW_RECEIPT_CHANGED","MEMORY_ROLLBACK_REVIEW_RECEIPT_REMOVED","MEMORY_ROLLBACK_REVIEW_RECEIPT_MISMATCH","MEMORY_ROLLBACK_REVIEW_SOURCE_MISMATCH"].includes(error.code)); retained(before);
});
test("accepted file body, scope, sensitivity or extra source cannot be reinterpreted", async t=>{
  for(const changeReviewed of [{content:"Edited accepted telescope fact"},{scope:"agent"},{sensitivity:"private"},{sourceRefs:["user-edit:invented"]}]) {
    const f=await fixture(t,{addCount:0,changeReviewed}),before=primary(f);
    assert.throws(()=>f.plan(),error=>["MEMORY_ROLLBACK_REVIEW_RECEIPT_MISMATCH","MEMORY_ROLLBACK_REVIEW_ADDITIONAL_SOURCE_SEMANTICS","MEMORY_ROLLBACK_REVIEW_TARGET_CHANGED"].includes(error.code)); retained(before);
  }
});
test("proof/candidate source drift after prepare fences first physical legacy write",async t=>{
  const f=await fixture(t,{addCount:0,deleteReviewed:true}),r=f.prepare(),before=primary(f);
  const store=new MemoryCandidateStore({paths:f.paths}),state=store.get(f.profileId);
  store.mutate(f.profileId,state.revision,next=>{next.candidates[f.sources[0].candidateId].content="New foreign accepted fact";});
  assert.throws(()=>f.applier().apply(f.profileId,r.options),error=>["MEMORY_ROLLBACK_SOURCE_CHANGED","MEMORY_ROLLBACK_REVIEW_RECEIPT_CHANGED","MEMORY_ROLLBACK_REVIEW_RECEIPT_MISMATCH"].includes(error.code)); retained(before);
});
test("mismatched or foreign derived read fields remain persisted and blocked instead of silently discarded",async t=>{
  for(const changeReviewed of [{startLine:98765},{endLine:98765},{fileHash:"b".repeat(64)},{documentKind:"foreign-report"},{foreignAuthority:"unknown-extra"}]) {
    const f=await fixture(t,{addCount:0,changeReviewed}),before=primary(f),p=f.plan();
    assert.ok(p.blockers.some(value=>value.code==="ADDITIONAL_RECORD_SEMANTICS")); retained(before);
    assert.throws(()=>f.prepare("unproven-derived-read"),error=>error.code==="MEMORY_ROLLBACK_MAPPING_BLOCKED"); retained(before);
  }
});
test("persisted own read-evidence names are never stripped by native real delete",async t=>{
  const f=await fixture(t,{addCount:0,persistedDerived:true,deleteReviewed:true}),before=primary(f),p=f.plan();
  assert.ok(p.blockers.some(value=>value.code==="ADDITIONAL_RECORD_SEMANTICS"&&value.fields.includes("fileHash")));
  retained(before);assert.throws(()=>f.prepare("persisted-evidence-semantics"),error=>error.code==="MEMORY_ROLLBACK_MAPPING_BLOCKED");retained(before);
});
test("an accepted target with archived complete source that is now withdrawn cannot be activated",async t=>{
  const f=await fixture(t,{addCount:0,withdraw:true,changeReviewed:{status:"active"}}),before=primary(f);
  assert.throws(()=>f.plan(),error=>error.code==="MEMORY_ROLLBACK_REVIEW_SOURCE_REVOKED"); retained(before);
});
test("actual persisted native session tombstone blocks review target before publication",async t=>{
  const f=await fixture(t,{addCount:0,sourceTombstoned:true}),before=primary(f);
  assert.throws(()=>f.plan(),error=>error.code==="MEMORY_ROLLBACK_REVIEW_SOURCE_TOMBSTONED"); retained(before);
});
test("original accepted receipt without physical activation transaction is not promoted by proof or rollback",async t=>{
  const f=await fixture(t,{addCount:0,stageFirst:true}),before=primary(f),store=new MemoryCandidateStore({paths:f.paths}),state=store.get(f.profileId);
  store.mutate(f.profileId,state.revision,next=>{const candidate=next.candidates[f.sources[0].candidateId];candidate.status="accepted";candidate.acceptedMemoryId=f.sources[0].item.id;candidate.updatedAt=2000;});
  const baselineReceiptPath=path.join(f.migration.locations(f.profileId).directory,"backup","candidate-review.json");
  assert.throws(()=>captureLegacyAcceptedReviewProof({paths:f.paths,profileId:f.profileId,records:[f.sources[0].item],baselineReceiptPath,now:20000,assertCurrent:()=>true}),error=>error.code==="MEMORY_ROLLBACK_REVIEW_TRANSACTION_UNPROVEN");
  const p=f.plan();assert.ok(p.blockers.some(value=>value.code==="LEGACY_AUTHORITY_CHANGED"));retained(before);
});
test("exact owned short journal tail recovers with the same accepted proof and original receipt",async t=>{
  const f=await fixture(t,{addCount:0,deleteReviewed:true}),r=f.prepare(),receiptFile=path.join(f.paths.agentsDir,f.profileId,"memory","candidate-review.json"),receiptBefore=fs.readFileSync(receiptFile);
  let fired=false;
  f.setFault((stage,profileId,details)=>{if(stage==="rollback-apply-journal-write"&&!fired){fired=true;assert.equal(profileId,f.profileId);assert.equal(details.journalPath,f.journal);fs.truncateSync(f.journal,fs.statSync(f.journal).size-9);throw new Error("synthetic-own-short-write");}});
  assert.throws(()=>f.applier().apply(f.profileId,r.options),error=>error.code==="MEMORY_COMMIT_UNCERTAIN");assert.equal(fired,true);
  f.setFault(()=>{});const result=f.applier().recover(f.profileId,r.options);receiptProof(result,r.plan);
  assert.equal(result.acceptedReviewProofHash,r.plan.snapshot.acceptedReviewProof.sha256);assert.deepEqual(fs.readFileSync(receiptFile),receiptBefore);
  const current=primary(f);receiptProof(f.applier().recover(f.profileId,r.options),r.plan);retained(current);
});
test("legacy reopen consumes actual future source withdrawal and hides preserved accepted facts for every real Profile",async t=>{
  const f=await fixture(t,{addCount:1}),r=f.prepare(),value=f.applier().apply(f.profileId,r.options);receiptProof(value,r.plan);
  const searchVisible=()=>{const resources=openLegacyAuthorizationResources({paths:f.paths,profileId:f.profileId,now:20000,assertCurrent:()=>true});try {
    return resources.profileIds.map(viewer=>resources.engine.search({profileId:viewer,query:"cobalt-1 telescope",workspace:f.repo,maxSensitivity:"private",limit:100}).items.some(row=>row.id===f.sources[0].item.id));
  }finally{resources.close();}};
  assert.ok(searchVisible().every(Boolean));
  const actualStore=new MemoryStore({paths:f.paths});actualStore.open();const policy=new RecallPolicyStore({paths:f.paths,memoryStore:actualStore,now:()=>21000});policy.open(f.profiles);
  try {policy.recordReason({profileId:f.profileId,item:{...f.sources[0].item,id:"actual-future-source-withdrawal",content:"The cobalt telescope original source is now withdrawn"},reason:"forgotten",operationId:"actual-after-rollback-user-forget",revocationSourceRefs:[f.sources[0].event.id,f.sources[0].runId]});}
  finally{policy.close();actualStore.close();}
  assert.ok(searchVisible().every(value=>value===false));
});
