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
async function fixture(t, { withdraw = false, stageFirst = false, addCount = 1, updateAgent = false, updateShared = false } = {}) {
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
test("real immutable planner publication carries authorization matrix/digest/source fingerprint and ownership", async t=>{
  const f=await fixture(t), before=primary(f), p=f.plan();
  assert.equal(p.mappingReady,true); assert.deepEqual(p.blockers,[]); assert.deepEqual(p.legacyCompatibility.blockers,[]); assert.equal(p.canSelectLegacyWriter,false);
  assert.equal(sha(fs.readFileSync(p.planPath)),p.planHash); assert.equal(p.authorizationSnapshotHash,p.authorizationSnapshot.sha256);
  assert.deepEqual(p.authorizationSnapshot.auxiliaryAuthority,p.snapshot.authorizationAuxiliaryAuthority);
  const ownership=json(p.ownershipPath); assert.equal(ownership.authorizationSnapshotHash,p.authorizationSnapshotHash); assert.equal(ownership.authorizationAuthorityHash,p.snapshot.authorizationAuxiliaryAuthority.sha256);
  assert.equal(f.migration.verifyRollbackPlan(f.profileId,{...f.options(),planHash:p.planHash,ownershipHash:p.ownershipHash}).valid,true); retained(before);
});
test("real apply writes a compatible new fact and preserves actual accepted/shared authorization matrix", async t=>{
  const f=await fixture(t), r=f.prepare(), intent=json(path.join(r.prepared.operationDirectory,"intent.json"));
  assert.deepEqual(intent.authorizationSnapshot,r.plan.authorizationSnapshot); assert.equal(intent.authorizationSnapshotHash,r.plan.authorizationSnapshotHash);
  const applied=f.applier().apply(f.profileId,r.options); receiptProof(applied,r.plan); assert.ok(applied.legacyVerification.visibleIds.includes(f.added[0].id));
  const after=primary(f); receiptProof(f.applier().recover(f.profileId,r.options),r.plan); retained(after);
});
test("real zero batch auth plan preserves both actual primaries without creating an extra journal row", async t=>{
  const f=await fixture(t,{addCount:0}), before=primary(f), r=f.prepare(); assert.equal(r.plan.journalBatches.length,0);
  receiptProof(f.applier().apply(f.profileId,r.options),r.plan); receiptProof(f.applier().recover(f.profileId,r.options),r.plan); retained(before);
});
test("compatible changed agent item is not mislabeled as unchanged retained authorization, while all Review/shared rows stay fixed", async t=>{
  const f=await fixture(t,{addCount:0,updateAgent:true}), r=f.prepare(); const agent=f.plain.find(item=>item.scope==="agent");
  assert.equal(r.plan.authorizationSnapshot.records.some(item=>item.profileId===f.profileId && item.id===agent.id),false);
  assert.ok(r.plan.authorizationSnapshot.records.some(item=>item.profileId===f.profileId && item.id===f.sources[0].item.id));
  receiptProof(f.applier().apply(f.profileId,r.options),r.plan);
});
test("sealed original source withdrawal stays legitimate under genuine planner and real apply", async t=>{
  const f=await fixture(t,{withdraw:true}), r=f.prepare();
  assert.ok(r.plan.authorizationSnapshot.cells.filter(cell=>cell.home===f.profileId&&cell.id===f.sources[0].item.id).every(cell=>!cell.visible));
  receiptProof(f.applier().apply(f.profileId,r.options),r.plan);
});
const resources = {
  product: f=>f.paths.stateSnapshotPath,
  productJournal: f=>f.paths.eventLogPath,
  session: f=>path.join(f.paths.stateDir,"chat-sessions.json"),
  receipt: f=>path.join(f.paths.agentsDir,f.profileId,"memory","candidate-review.json"),
  peerPrimary: f=>path.join(f.paths.agentsDir,f.peer.id,"memory","events.jsonl"),
  peerSeal: f=>path.join(f.paths.agentsDir,f.peer.id,"memory","recall-policy.seal.json"),
  transcript: f=>{ const base=path.join(f.paths.agentsDir,f.profileId,"transcripts"); const walk=dir=>fs.readdirSync(dir).flatMap(name=>{const file=path.join(dir,name); return fs.statSync(file).isDirectory()?walk(file):[file];}); return walk(base).find(file=>file.endsWith(".jsonl")); },
  workspace: f=>path.join(f.repo,".git","worktrees","linked","commondir"),
};
for(const [name,target] of Object.entries(resources)) for(const phase of ["prepare","first-write"]) test(`genuine ${phase} rejects changed ${name} authority before primary write`,async t=>{
  const f=await fixture(t), p=f.plan(), input={...f.options(),operationId:`changed-${name}`,planHash:p.planHash,ownershipHash:p.ownershipHash}, before=primary(f); let hit=false;
  if(phase==="prepare") { fs.appendFileSync(target(f),"\n"); assert.throws(()=>f.applier().prepare(f.profileId,input)); }
  else { const prepared=f.applier().prepare(f.profileId,input); f.setFault(stage=>{if(stage==="rollback-apply-before-batch"&&!hit) {hit=true;fs.appendFileSync(target(f),"\n");}}); assert.throws(()=>f.applier().apply(f.profileId,{...input,applyIntentHash:prepared.applyIntentHash})); assert.equal(hit,true); }
  retained(before);
});
for(const stage of ["rollback-apply-journal-write","rollback-apply-snapshot","rollback-apply-after-batch"]) test(`actual same-owner recovery after ${stage} retains immutable authorization snapshot`,async t=>{
  const f=await fixture(t), r=f.prepare(); let hit=false; f.setFault(value=>{if(value===stage&&!hit){hit=true;throw Error("synthetic interruption");}});
  assert.throws(()=>f.applier().apply(f.profileId,r.options)); assert.equal(hit,true); f.setFault(()=>{}); receiptProof(f.applier().recover(f.profileId,r.options),r.plan);
  assert.deepEqual(json(path.join(r.prepared.operationDirectory,"intent.json")).authorizationSnapshot,r.plan.authorizationSnapshot);
});
function ownedShortWrite(f,r) {
 const intent=json(path.join(r.prepared.operationDirectory,"intent.json"));let hit=false;
 f.setFault((stage,profileId,details)=>{if(stage!=="rollback-apply-journal-write"||hit)return;hit=true;assert.equal(profileId,f.profileId);
  const row=Buffer.from(details.expectedRow),length=intent.states[0].journalBytes+Math.floor(row.length/2);
  const fd=fs.openSync(details.journalPath,fs.constants.O_RDWR|fs.constants.O_NOFOLLOW);
  try {fs.ftruncateSync(fd,length);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}throw Error("synthetic actual owned short write");
 });
 assert.throws(()=>f.applier().apply(f.profileId,r.options));assert.equal(hit,true);f.setFault(()=>{});
 const bytes=fs.readFileSync(f.journal),tail=bytes.subarray(intent.states[0].journalBytes);
 assert.ok(tail.length>0&&!tail.includes(10));assert.ok(Buffer.from(intent.batches[0].row).subarray(0,tail.length).equals(tail));
 return intent;
}
test("recover rejects changed authorization resources before truncating an exactly owned partial journal",async t=>{
  const f=await fixture(t),r=f.prepare();ownedShortWrite(f,r);
  const before=primary(f);fs.appendFileSync(resources.session(f),"\n");assert.throws(()=>f.applier().recover(f.profileId,r.options));retained(before);
});
test("actual owned short journal tail recovers with complete unchanged authorization CAS and no duplicate row",async t=>{
 const f=await fixture(t),r=f.prepare(),intent=ownedShortWrite(f,r);
 receiptProof(f.applier().recover(f.profileId,r.options),r.plan);assert.equal(fs.statSync(f.journal).size,intent.states[1].journalBytes);
 const after=primary(f);receiptProof(f.applier().recover(f.profileId,r.options),r.plan);retained(after);
});
test("caller cannot replace immutable snapshot/ownership/intent bindings or change fixed authorization time",async t=>{
  const f=await fixture(t), r=f.prepare(), before=primary(f);
  assert.throws(()=>f.applier().apply(f.profileId,{...r.options,now:20001}),{code:"MEMORY_ROLLBACK_AUTHORIZATION_PLAN_BINDING_REQUIRED"}); retained(before);
  const intentPath=path.join(r.prepared.operationDirectory,"intent.json"), original=fs.readFileSync(intentPath), intent=json(intentPath); intent.authorizationSnapshotHash="f".repeat(64); fs.writeFileSync(intentPath,stable(intent)+"\n");
  assert.throws(()=>f.applier().recover(f.profileId,{...r.options,applyIntentHash:sha(fs.readFileSync(intentPath))}),{code:"MEMORY_ROLLBACK_APPLY_INVALID"}); retained(before); fs.writeFileSync(intentPath,original);
  assert.throws(()=>f.applier().recover(f.profileId,{...r.options,operationId:"foreign-operation"})); retained(before);
});
test("full type shared mapping blockers are preserved even when authorization resources are now proven",async t=>{
  const f=await fixture(t,{updateShared:true}),before=primary(f),p=f.plan();
  assert.ok(p.blockers.some(blocker=>blocker.code==="LEGACY_SHARED_SCOPE_SEMANTICS")); assert.equal(p.canSelectLegacyWriter,false);
  assert.throws(()=>f.applier().prepare(f.profileId,{...f.options(),operationId:"blocked-fulltype",planHash:p.planHash,ownershipHash:p.ownershipHash}),{code:"MEMORY_ROLLBACK_MAPPING_BLOCKED"}); retained(before);
});
for(const status of ["canceled","skipped"]) test(`real fresh planner rejects accepted active Review with contradictory durable ${status} Run`,async t=>{
 const f=await fixture(t),before=primary(f),value=json(f.paths.stateSnapshotPath);
 value.workRuns.find(run=>run.id===f.sources[0].runId).status=status;value.checksum=snapshotChecksum(value);fs.writeFileSync(f.paths.stateSnapshotPath,JSON.stringify(value)+"\n");
 assert.throws(()=>f.plan(),{code:"MEMORY_ROLLBACK_REVIEW_SOURCE_MISMATCH"});retained(before);
});
test("foreign active owner cannot complete an otherwise exact prepared intent hardlink publication",async t=>{
 const f=await fixture(t),r=f.prepare(),intentPath=path.join(r.prepared.operationDirectory,"intent.json"),preparedPath=intentPath+".prepared";
 fs.linkSync(intentPath,preparedPath);const activePath=path.join(f.migration.locations(f.profileId).directory,"rollback-apply-active.json"),active=json(activePath);active.operationId="foreign-owner";fs.writeFileSync(activePath,stable(active)+"\n");
 const before=disk(f.root);assert.throws(()=>f.applier().recover(f.profileId,r.options),{code:"MEMORY_ROLLBACK_FOREIGN_TRANSACTION"});assert.deepEqual(disk(f.root),before);
});

function actualLinkedPublication(f) {
 const plan=f.plan(),input={...f.options(),operationId:"actual-linked-source-cas",planHash:plan.planHash,ownershipHash:plan.ownershipHash};let intentPath,hit=false;
 f.setFault((stage,profileId,details)=>{if(stage!=="rollback-apply-intent-linked"||hit)return;hit=true;assert.equal(profileId,f.profileId);intentPath=details.intentPath;throw Error("synthetic actual intent linked crash");});
 assert.throws(()=>f.applier().prepare(f.profileId,input));assert.equal(hit,true);f.setFault(()=>{});
 const preparedPath=intentPath+".prepared",left=fs.lstatSync(intentPath),right=fs.lstatSync(preparedPath);
 assert.equal(left.nlink,2);assert.equal(right.nlink,2);assert.equal(left.dev,right.dev);assert.equal(left.ino,right.ino);
 return {plan,input,options:{...input,applyIntentHash:sha(fs.readFileSync(intentPath))},intentPath,preparedPath};
}
for(const [name,method] of [["product","prepare"],["session","recover"],["peerPrimary","recover"]]) test(`actual linked publication rejects ${name} drift before ${method} can change any disk identity`,async t=>{
 const f=await fixture(t),r=actualLinkedPublication(f);fs.appendFileSync(resources[name](f),"\n");const before=disk(f.root);
 assert.throws(()=>method==="prepare"?f.applier().prepare(f.profileId,r.input):f.applier().recover(f.profileId,r.options));
 assert.deepEqual(disk(f.root),before);assert.equal(fs.statSync(r.intentPath).nlink,2);assert.equal(fs.statSync(r.preparedPath).nlink,2);
});
test("actual linked publication with unchanged complete authority finishes only its own pair and real apply",async t=>{
 const f=await fixture(t),r=actualLinkedPublication(f),primaryBefore=primary(f);
 const prepared=f.applier().prepare(f.profileId,r.input);assert.equal(prepared.applyIntentHash,r.options.applyIntentHash);assert.equal(fs.existsSync(r.preparedPath),false);assert.equal(fs.statSync(r.intentPath).nlink,1);retained(primaryBefore);
 receiptProof(f.applier().recover(f.profileId,r.options),r.plan);const after=primary(f);receiptProof(f.applier().recover(f.profileId,r.options),r.plan);retained(after);
});
