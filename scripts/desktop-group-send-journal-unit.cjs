#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { DesktopGroupSendJournalStore } = require("../app/desktop-group-send-journal-store");
const { CHANNEL, registerDesktopGroupSendJournalIpc } = require("../app/desktop-group-send-journal-ipc");
const tests = [], test = (name, run) => tests.push({ name, run });
const compose = text => ({ text, mentionIds: [], replyTo: null, replyTask: null, requestRef: null, newRequest: false, summaryMemberId: "", files: [] });
const input = (id = "original") => ({ clientMessageId: id, ownerScope: "owner", body: "A", mentions: [], expectedPolicyVersion: 1 });
const scope = { ownerScope: "owner", groupId: "g" };
async function fixture(options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/shoggoth-group-native-journal-")); fs.chmodSync(root, 0o700);
  const store = new DesktopGroupSendJournalStore({ userDataRoot: root, ...options }); await store.open();
  const save = (text, revision = 1, expectedStorageRevision = 0) => store.saveComposer({ ...scope, draftId: "draft", revision, composer: compose(text), expectedStorageRevision });
  const prepare = draft => store.prepare({ ...scope, inputSnapshot: input(), draft });
  return { root, store, save, prepare, file: path.join(root,"group-send-journal/journal.json"), async cleanup() { await store.close(); fs.rmSync(root,{recursive:true,force:true}); } };
}
test("quoted member replies keep their origin, including late results, through native draft persistence", async () => {
  const { createFixture } = require("./fixtures/group-store-fixture.cjs");
  const cleanups = [], group = createFixture({ after: callback => cleanups.push(callback) });
  const f = await fixture(); let reopened;
  try {
    group.send("请给出一条固定结论。", { mentionMemberIds: [group.roster[1].id] });
    const claim = group.store.claimNext(group.groupId, group.fence);
    group.store.bindSession({ groupId: group.groupId, memberId: claim.member.id, sessionKey: "session-quote", fence: group.fence });
    group.store.recordRun({ opportunityId: claim.opportunity.id, runId: "run-quote", sessionKey: "session-quote", fence: group.fence });
    group.store.releaseTurn({ opportunityId: claim.opportunity.id, fence: group.fence, reason: "working" });
    group.store.completeTurn({ opportunityId: claim.opportunity.id, fence: group.fence, status: "completed", text: "固定结论：2+2=4。" });
    const history = await group.service.handle("group.history", { groupId: group.groupId, afterSeq: null, beforeSeq: null, limit: 50 });
    const message = history.messages.find(row => row.author.kind === "member");
    assert.equal(message.origin.late, true, "a result finished after giving up the floor is a late result");
    const value = { ...compose("引用这条结果补充。"), replyTo: message };
    const saved = await f.store.saveComposer({ ...scope, draftId: "quote", revision: 1, composer: value, expectedStorageRevision: 0 });
    assert.deepEqual(saved.composer.replyTo.origin, message.origin);
    await f.store.close(); reopened = new DesktopGroupSendJournalStore({ userDataRoot: f.root }); await reopened.open();
    assert.deepEqual((await reopened.read(scope)).draft.composer.replyTo.origin, message.origin);
    for (const origin of [{ ...message.origin, late: "true" }, { ...message.origin, partial: 1 }, { ...message.origin, requestRevision: 0 }, { ...message.origin, credential: "refused" }]) {
      assert.throws(() => reopened.saveComposer({ ...scope, draftId: "bad", revision: 1, composer: { ...value, replyTo: { ...message, origin } }, expectedStorageRevision: 0 }), { code: "GROUP_JOURNAL_INVALID" });
    }
  } finally { await reopened?.close(); await f.cleanup(); for (const cleanup of cleanups.reverse()) await cleanup(); }
});
test("private durable frozen payload, close/reopen and multiwindow CAS", async () => {
  const f = await fixture(); try {
    const draft = await f.save("A"); const payload = input(); const preparing = f.store.prepare({ ...scope, inputSnapshot: payload, draft }); payload.mentions.push("mutated");
    const original = await preparing; assert.deepEqual(original.inputSnapshot.mentions, []);
    const race = await Promise.allSettled([f.save("B one",2,draft.storageRevision),f.save("B two",2,draft.storageRevision)]);
    assert.equal(race.filter(row=>row.status==="fulfilled").length,1); assert.equal(race.find(row=>row.status==="rejected").reason.code,"GROUP_DRAFT_CONFLICT");
    assert.equal(fs.statSync(path.dirname(f.file)).mode&0o7777,0o700); assert.equal(fs.statSync(f.file).mode&0o7777,0o600);
    await f.store.close(); const next = new DesktopGroupSendJournalStore({userDataRoot:f.root});await next.open();
    const recovered = await next.read(scope);assert.equal(recovered.sends[0].clientMessageId,"original");assert.match(recovered.draft.composer.text,/^B (one|two)$/);await next.close();
  }finally{await f.cleanup()}
});
test("exact acceptance keeps later draft and late errors cannot downgrade confirmation", async()=>{
  const f=await fixture();try{const draft=await f.save("A"),record=await f.prepare(draft);await f.save("B",2,draft.storageRevision);
    await assert.rejects(f.store.accepted({record,message:{id:"wrong",groupId:"other",seq:2},discussionId:"d"}),{code:"GROUP_SEND_LOOKUP_IDENTITY_MISMATCH"});
    const accepted=await f.store.accepted({record,message:{id:"canonical",groupId:"g",seq:2},discussionId:"d"});assert.equal(accepted.draft.composer.text,"B");
    const late=await f.store.update({record,patch:{phase:"needs_verification",lastError:"late"}});assert.equal(late.phase,"observed");assert.equal(late.acceptedMessageId,"canonical");
    await assert.rejects(f.store.prepare({...scope,inputSnapshot:{...input(),body:"changed"},draft}),{code:"GROUP_SEND_PAYLOAD_CONFLICT"});
  }finally{await f.cleanup()}
});
test("a detached new-request snapshot never replaces the current composer on recovery",async()=>{
  const f=await fixture();try{const current=await f.save("draft B"),detached=await f.store.saveComposer({...scope,draftId:"fork",revision:0,composer:compose("original A"),expectedStorageRevision:0,detached:true});
    const fork=await f.store.prepare({...scope,inputSnapshot:{...input("fork-id"),body:"original A",requestMode:"new"},draft:detached});
    assert.equal((await f.store.read(scope)).draft.draftId,current.draftId);await f.store.close();
    const next=new DesktopGroupSendJournalStore({userDataRoot:f.root});try{await next.open();assert.equal((await next.read(scope)).draft.composer.text,"draft B");
      await next.accepted({record:fork,message:{id:"fork-message",groupId:"g",seq:4},discussionId:"new-discussion"});assert.equal((await next.read(scope)).draft.composer.text,"draft B");
    }finally{await next.close()}
  }finally{await f.cleanup()}
});
test("bounded storage retains originals and ENOSPC before commit preserves input",async()=>{
  const fileSystem=Object.create(fs);let fail=false;fileSystem.writeSync=(...args)=>{if(fail)throw Object.assign(Error("full"),{code:"ENOSPC"});return fs.writeSync(...args)};
  const f=await fixture({fs:fileSystem,limits:{records:1}});try{const draft=await f.save("A");await f.prepare(draft);const original=fs.readFileSync(f.file);
    await assert.rejects(f.store.prepare({...scope,inputSnapshot:input("second"),draft}),{code:"GROUP_JOURNAL_FULL"});assert.deepEqual(fs.readFileSync(f.file),original);
    fail=true;await assert.rejects(f.save("B",2,draft.storageRevision),{code:"GROUP_JOURNAL_WRITE_FAILED"});fail=false;
    assert.equal((await f.store.read(scope)).draft.composer.text,"A");assert.deepEqual(fs.readFileSync(f.file),original);
  }finally{await f.cleanup()}
});
test("replacement/uncertain write fences later operations and independent reopen revalidates disk",async()=>{
  const fileSystem=Object.create(fs);let uncertain=false;fileSystem.renameSync=(...args)=>{const result=fs.renameSync(...args);if(uncertain)throw Object.assign(Error("post rename failure"),{code:"EIO"});return result};
  const f=await fixture({fs:fileSystem});try{const draft=await f.save("A");uncertain=true;await assert.rejects(f.save("B",2,draft.storageRevision),{code:"GROUP_JOURNAL_COMMIT_UNKNOWN"});
    await assert.rejects(f.store.read(scope),{code:"GROUP_JOURNAL_UNAVAILABLE"});await f.store.close();uncertain=false;
    const next=new DesktopGroupSendJournalStore({userDataRoot:f.root});await next.open();assert.equal((await next.read(scope)).draft.composer.text,"B");await next.close();
  }finally{await f.cleanup()}
});
test("single writer, symlink and malformed metadata refuse unsafe storage",async()=>{
  const f=await fixture();try{const overlap=new DesktopGroupSendJournalStore({userDataRoot:f.root});await assert.rejects(overlap.open(),{code:"GROUP_JOURNAL_ALREADY_OPEN"});await overlap.close();
    assert.throws(()=>f.store.saveComposer({...scope,draftId:"d",revision:1,composer:{...compose("A"),credential:"hidden"},expectedStorageRevision:0}),{code:"GROUP_JOURNAL_INVALID"});
    const file=fs.readFileSync(f.file);await f.store.close();fs.unlinkSync(f.file);const outside=path.join(f.root,"external.json");fs.writeFileSync(outside,file,{mode:0o600});fs.symlinkSync(outside,f.file);
    const next=new DesktopGroupSendJournalStore({userDataRoot:f.root});await assert.rejects(next.open(),{code:"GROUP_JOURNAL_UNSAFE_PATH"});await next.close();assert.deepEqual(fs.readFileSync(outside),file);
  }finally{await f.cleanup()}
});
test("legacy adoption preserves original IDs, requires fresh verification and cannot replace Main's newer draft",async()=>{
  const f=await fixture();try{const draft=await f.save("A"),record=await f.prepare(draft);await f.store.close();
    const otherRoot=fs.realpathSync(fs.mkdtempSync("/private/tmp/shoggoth-group-journal-import-")),other=new DesktopGroupSendJournalStore({userDataRoot:otherRoot});
    try{await other.open();await other.importLegacy({sends:[record],drafts:[draft]});assert.equal((await other.read(scope)).sends[0].phase,"needs_verification");
      const saved=await other.saveComposer({...scope,draftId:"draft",revision:2,composer:compose("B"),expectedStorageRevision:draft.storageRevision});await other.importLegacy({sends:[record],drafts:[draft]});assert.equal((await other.read(scope)).draft.storageRevision,saved.storageRevision);
    }finally{await other.close();fs.rmSync(otherRoot,{recursive:true,force:true})}
  }finally{await f.cleanup()}
});
test("corrupt Main records retain scoped original text through a read-only recovery IPC", async () => {
  const f = await fixture(); let damaged, registration;
  try {
    const snapshot = await f.save("draft B"), record = await f.prepare(snapshot); await f.store.close();
    const state = JSON.parse(fs.readFileSync(f.file, "utf8")); state.sends[0].phase = "broken";
    state.sends.push({ ...record, ownerScope: "foreign", key: JSON.stringify(["foreign", "g", record.clientMessageId]), inputSnapshot: { ...record.inputSnapshot, body: "foreign-only-text" } });
    fs.writeFileSync(f.file, JSON.stringify(state) + "\n", { mode: 0o600 }); const original = fs.readFileSync(f.file);
    damaged = new DesktopGroupSendJournalStore({ userDataRoot: f.root }); await assert.rejects(damaged.open(), { code: "GROUP_JOURNAL_CORRUPT" });
    const handlers = new Map(), notifications = [], frame = { url: "http://127.0.0.1:4999/" };
    const webContents = { mainFrame: frame, isDestroyed: () => false, send: (...args) => notifications.push(args) };
    const window = { webContents, isDestroyed: () => false }, event = { sender: webContents, senderFrame: frame };
    registration = registerDesktopGroupSendJournalIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
      getMainWindow: () => window, getUiOrigin: () => frame.url, getAuthorityScope: async () => "owner", lookupSend: () => { throw Error("unexpected lookup"); },
      getStore: async ({ readonlyRecovery } = {}) => { if (!readonlyRecovery) throw Object.assign(Error("corrupt"), { code: "GROUP_JOURNAL_CORRUPT" }); return damaged; } });
    const invoke = value => handlers.get(CHANNEL)(event, { method: "recover", value });
    const result = await invoke({ ...scope, offset: 0, snapshotDigest: null }); assert.equal(result.ok, true);
    assert.equal(result.value.readOnly, true); assert.deepEqual(result.value.items.map(item => item.text), ["A", "draft B"]);
    assert.equal(result.value.items.every(item => item.unverified === true && !("inputSnapshot" in item) && !("attachmentRefs" in item)), true);
    assert.doesNotMatch(JSON.stringify(result.value), /foreign-only-text/); assert.equal(notifications.length, 0);
    assert.equal((await invoke({ ...scope, ownerScope: "foreign", offset: 0, snapshotDigest: null })).error.code, "GROUP_JOURNAL_OWNER_CHANGED");
    assert.equal((await invoke({ ...scope, offset: 0, snapshotDigest: null, repair: true })).error.code, "GROUP_JOURNAL_INVALID");
    await assert.rejects(damaged.read(scope), { code: "GROUP_JOURNAL_UNAVAILABLE" });
    assert.equal(damaged.mode, "failed"); assert.deepEqual(fs.readFileSync(f.file), original);
  } finally { registration?.dispose(); await damaged?.close(); await f.cleanup(); }
});
test("recovery pages bind the unchanged private original and never parse a damaged JSON prefix", async () => {
  const f = await fixture(); let damaged;
  try {
    const draft = await f.save("saved"), record = await f.prepare(draft); await f.store.close();
    const state = JSON.parse(fs.readFileSync(f.file, "utf8"));
    state.sends = Array.from({ length: 25 }, (_, i) => ({ ...record, clientMessageId: "original-" + i, key: JSON.stringify(["owner", "g", "original-" + i]), phase: "broken", inputSnapshot: { ...record.inputSnapshot, body: "text " + i } }));
    fs.writeFileSync(f.file, JSON.stringify(state) + "\n"); damaged = new DesktopGroupSendJournalStore({ userDataRoot: f.root });
    await assert.rejects(damaged.open(), { code: "GROUP_JOURNAL_CORRUPT" });
    const first = await damaged.recover({ ...scope, offset: 0, snapshotDigest: null }); assert.equal(first.items.length, 20); assert.equal(first.nextOffset, 20);
    const second = await damaged.recover({ ...scope, offset: first.nextOffset, snapshotDigest: first.snapshotDigest }); assert.equal(second.items.length, 6); assert.equal(second.hasMore, false);
    state.sends[0].inputSnapshot.body = "changed source"; fs.writeFileSync(f.file, JSON.stringify(state) + "\n");
    await assert.rejects(damaged.recover({ ...scope, offset: first.nextOffset, snapshotDigest: first.snapshotDigest }), { code: "GROUP_JOURNAL_RECOVERY_CHANGED" });
    const malformed = Buffer.from('{"version":1,"sends":[{"body":"cannot trust a JSON prefix"}'); fs.writeFileSync(f.file, malformed);
    await assert.rejects(damaged.recover({ ...scope, offset: 0, snapshotDigest: null }), { code: "GROUP_JOURNAL_RECOVERY_UNAVAILABLE" }); assert.deepEqual(fs.readFileSync(f.file), malformed);
    fs.unlinkSync(f.file); const other = path.join(f.root, "outside.json"); fs.writeFileSync(other, JSON.stringify(state), { mode: 0o600 }); fs.symlinkSync(other, f.file);
    await assert.rejects(damaged.recover({ ...scope, offset: 0, snapshotDigest: null }), { code: "GROUP_JOURNAL_UNSAFE_PATH" });
  } finally { await damaged?.close(); await f.cleanup(); }
});
test("IPC verifies exact main frame, current authority and accepted receipts through readonly lookup",async()=>{
  const f=await fixture(),handlers=new Map(),calls=[];let owner="owner",found=false,origin="http://127.0.0.1:4999/",alive=true;
  const frame={url:origin},webContents={mainFrame:frame,isDestroyed:()=>!alive,send:()=>{}},window={webContents,isDestroyed:()=>!alive},event={sender:webContents,senderFrame:frame};
  const ipc=registerDesktopGroupSendJournalIpc({ipcMain:{handle:(key,value)=>handlers.set(key,value),removeHandler:key=>handlers.delete(key)},getMainWindow:()=>window,getUiOrigin:()=>origin,getStore:()=>f.store,
    getAuthorityScope:async()=>{calls.push("scope readonly");return owner},lookupSend:async request=>{calls.push("lookup readonly");return found?{status:"found",ownerScope:"owner",groupId:"g",clientMessageId:request.clientMessageId,payloadMatches:true,payloadDigest:request.payloadDigest,message:{id:"canonical",groupId:"g",seq:3,author:{kind:"user"}},discussionId:"d"}:{status:"not_found"}}});
  const invoke=(method,value,caller=event)=>handlers.get(CHANNEL)(caller,{method,value});
  try{const snapshot=(await invoke("saveComposer",{...scope,draftId:"draft",revision:1,composer:compose("A"),expectedStorageRevision:0})).value;
    const record=(await invoke("prepare",{...scope,inputSnapshot:input(),draft:snapshot})).value;const before=fs.readFileSync(f.file);
    const untrusted=await invoke("read",scope,{...event,senderFrame:{url:origin}});assert.equal(untrusted.error.code,"GROUP_JOURNAL_CALLER_REQUIRED");
    assert.equal((await invoke("update",{record,patch:{phase:"observed"}})).error.code,"GROUP_JOURNAL_INVALID");
    assert.equal((await invoke("accepted",{record,message:{id:"forged",groupId:"g",seq:999},discussionId:"fake"})).error.code,"GROUP_SEND_LOOKUP_UNVERIFIED");assert.deepEqual(fs.readFileSync(f.file),before);
    found=true;const accepted=await invoke("accepted",{record,message:{id:"forged",groupId:"g",seq:999},discussionId:"fake"});assert.equal(accepted.value.record.acceptedMessageId,"canonical");assert.equal(accepted.value.draft.composer.text,"");
    owner="other-owner";assert.equal((await invoke("read",scope)).error.code,"GROUP_JOURNAL_OWNER_CHANGED");
    frame.url="https://external.invalid/";assert.equal((await invoke("read",scope)).error.code,"GROUP_JOURNAL_CALLER_REQUIRED");assert.equal(calls.every(value=>value.endsWith("readonly")),true);
  }finally{ipc.dispose();await f.cleanup()}
});
(async()=>{for(const {name,run} of tests){await run();console.log("PASS "+name)}console.log(`desktop group send journal: ${tests.length}/${tests.length}; Provider / group execution calls 0`)})().catch(error=>{console.error(error);process.exitCode=1});
