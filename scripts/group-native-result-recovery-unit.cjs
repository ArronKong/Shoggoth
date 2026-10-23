"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = process.env.GROUP_RESULT_TEST_ROOT || path.resolve(__dirname, "..");
const { openHandoffFixture } = require(path.join(ROOT, "scripts/fixtures/runtime-handoff-service.cjs"));
const { GroupChatDriver } = require(path.join(ROOT, "app/agent-service/group-chat-driver"));

async function fixture(t, answer = "Original final answer; no model replay.") {
  const f = await openHandoffFixture();
  const close = f.close.bind(f); let closed = false;
  f.close = async options => { if (!closed) { closed = true; await close(options); } };
  const store = f.service.groupChatStore, executor = f.service.groupChatDriver.executor;
  f.service.groupChatDriver.stop();
  const errors = [];
  const driver = new GroupChatDriver({ store, executor, onError: error => errors.push(error.code) });
  // This fixture claims its original turn explicitly. Keep successor work queued;
  // scheduling and failover execution are covered by the full driver regressions.
  driver.wake = () => {};
  await driver.start();
  t.after(async () => { driver.stop(); await f.close(); });
  const { groupId } = store.createGroup({ operationId: "recovery-create", name: "Recovery fixture", purpose: "", mode: "independent",
    members: [0, 1].map(index => ({ backendId: "shoggoth", profileId: index ? "unused-fixture-profile" : f.profile.id,
      agentId: index ? "unused-fixture-agent" : f.profile.id, displayName: `Fixture ${index}` })) });
  const member = store.getGroup(groupId).members[0];
  store.appendUserMessage({ groupId, clientMessageId: "recovery-message", body: "One synthetic answer",
    mentionMemberIds: [member.id], requestMode: "new" });
  const claim = store.claimNext(groupId, driver.fence);
  const sessionKey = await executor.ensureSession(claim.binding);
  store.bindSession({ groupId, memberId: member.id, sessionKey, fence: driver.fence });
  const run = await executor.start({ sessionKey, operationId: claim.opportunity.operationId, prompt: "One synthetic answer" });
  await f.service.workRunCoordinator.waitForIdle(run.id);
  store.recordRun({ opportunityId: claim.opportunity.id, runId: run.id, sessionKey, fence: driver.fence });
  const running = f.service.workRunCoordinator.getRun(run.id), raw = f.transport.hosts.get("codex");
  const thread = raw.threads.find(value => value.id === running.runtimeSessionRef.sessionId);
  const turn = thread.turns.find(value => value.id === running.runtimeTurnRef.turnId);
  turn.status = "completed";
  turn.items.push({ type: "agentMessage", id: "final-fixture-answer", text: answer, phase: "final_answer" });
  // Omit the text notification. The authoritative native history still has it.
  raw.emit({ known: true, type: "complete", threadId: thread.id, turnId: turn.id });
  await f.service.workRunCoordinator.waitForIdle(run.id);
  assert.equal(f.service.workRunCoordinator.getRun(run.id).status, "completed");
  await driver.reconcile(claim.opportunity.id);
  assert.equal(store.getOpportunity(claim.opportunity.id).recovery.type, "result");
  const session = f.service.chatSessionStore.getSession(sessionKey);
  return { f, store, executor, driver, errors, groupId, member, claim, run: f.service.workRunCoordinator.getRun(run.id), raw, thread, turn, session, answer,
    reconcile: () => driver.reconcile(claim.opportunity.id),
    opportunity: () => store.getOpportunity(claim.opportunity.id),
    recovered: () => f.service.transcriptStore.listEvents(f.profile.id, session.id).map(event => f.service.transcriptStore.displayEvent(f.profile.id, session.id, event))
      .filter(event => event.runId === run.id && event.content?.recovered),
    messages: () => store.listMessages({ groupId, limit: 100 }).messages.filter(message => message.author.kind === "member") };
}

const startsForOriginal = x => x.raw.threads.reduce((count, thread) => count + thread.turns.filter(turn =>
  turn.items.some(item => item.type === "userMessage" && item.clientId === x.claim.opportunity.operationId)).length, 0);

for (const long of [false, true]) test(`missing native final is restored in full and published once; long=${long}`, async t => {
  const x = await fixture(t, long ? "完整正文🙂".repeat(6000) + "尾部完整" : undefined);
  await x.reconcile(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(x.opportunity().state, "replied", x.errors.join(","));
  assert.equal(x.messages().length, 1);
  assert.equal(x.messages()[0].fullResult.bytes, Buffer.byteLength(x.answer));
  assert.equal(x.executor.finalText(x.run), x.answer);
  assert.equal(x.recovered().length, 1);
  await x.reconcile(); await x.reconcile();
  assert.equal(x.messages().length, 1);
  assert.equal(x.recovered().length, 1);
  assert.equal(startsForOriginal(x), 1, "successor coordination is separate; the original operation is never replayed");
});

for (const fault of [null, "writeSync", "fsyncSync"]) test(`completed missing answer survives restart after ${fault}; original operation is not replayed`, async t => {
  const x = await fixture(t);
  const nativeThreads = structuredClone(x.raw.threads);
  if (fault) {
    const transcript = x.f.service.transcriptStore;
    let fail = true;
    transcript.fs = new Proxy(fs, { get(target, key) {
      if (key !== fault) return Reflect.get(target, key);
      return (...args) => {
        if (fail) { fail = false; throw Object.assign(Error("synthetic disk full"), { code: "ENOSPC" }); }
        return target[fault](...args);
      };
    } });
    assert.throws(() => transcript.appendEvent({ profileId: x.f.profile.id, sessionId: x.session.id, runId: x.run.id,
      id: "uncertain-final", kind: "assistant", content: { text: x.answer, phase: "final_answer" },
      runtimeRef: x.run.runtimeTurnRef, contextExcluded: false, occurredAt: x.run.finishedAt }), { code: "TRANSCRIPT_COMMIT_UNCERTAIN" });
  }
  x.driver.stop(); await x.f.close({ remove: false });
  const reopened = await openHandoffFixture({ root: x.f.root });
  t.after(async () => { await reopened.close(); });
  const coordinator = reopened.service.workRunCoordinator;
  const ref = x.run.runtimeSessionRef;
  await coordinator.runtimeManager.acquire({ runtime: ref.runtime, runtimeProfileId: ref.runtimeProfileId, runtimeAccountId: ref.runtimeAccountId });
  const raw = reopened.transport.hosts.get("codex");
  raw.threads = nativeThreads; raw.loadedThreads = new Set(nativeThreads.map(thread => thread.id));
  await reopened.service.groupChatDriver.reconcile(x.claim.opportunity.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reopened.service.groupChatStore.getOpportunity(x.claim.opportunity.id).state, "replied");
  assert.equal(reopened.service.groupChatDriver.executor.finalText(x.run), x.answer);
  assert.equal(startsForOriginal({ ...x, raw }), 1, "native history retains exactly the one pre-restart original turn");
  assert.ok(raw.threads.flatMap(thread => thread.turns).filter(turn => turn.items.some(item => item.type === "userMessage"
    && item.clientId === x.claim.opportunity.operationId)).every(turn => turn.id === x.run.runtimeTurnRef.turnId));
});

const invalid = {
  "wrong session": x => { x.thread.id = "foreign-session"; },
  "wrong turn": x => { x.turn.id = "foreign-turn"; },
  "wrong operation": x => { x.turn.items.find(item => item.type === "userMessage").clientId = "foreign-operation"; },
  "duplicate operation": x => { x.turn.items.push({ ...x.turn.items.find(item => item.type === "userMessage") }); },
  "partial history": x => { x.turn.itemsView = "summary"; },
  "incomplete scope": x => { x.thread.historyScope = { operationId: x.claim.opportunity.operationId, complete: false }; },
  "async-only final": x => { x.turn.items.at(-1).delivery = "async"; },
  "commentary-only final": x => { x.turn.items.at(-1).phase = "commentary"; },
  "invalid text": x => { x.turn.items.at(-1).text = "invalid\0text"; },
  "secret rejected": x => { x.f.service.workRunCoordinator.assertSecretSafe = () => false; },
  "revoked memory source": x => { x.f.service.workRunCoordinator.conversationCheckpointStore.nativeSessionStale = () => true; },
  "excluded source": x => {
    const user = x.f.service.transcriptStore.listEvents(x.f.profile.id, x.session.id).find(event => event.runId === x.run.id && event.kind === "user");
    x.f.service.transcriptStore.setContextExcluded({ profileId: x.f.profile.id, sessionId: x.session.id, eventId: user.id, contextExcluded: true });
  },
  "removed member": x => { x.store.removeMember({ groupId: x.groupId, memberId: x.member.id, expectedRosterRevision: x.store.getGroup(x.groupId).group.rosterRevision }); },
};
for (const [name, mutate] of Object.entries(invalid)) test(`recovery rejects ${name} without publishing or replay`, async t => {
  const x = await fixture(t); mutate(x);
  await x.reconcile(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(x.messages().length, 0);
  assert.equal(x.recovered().length, 0);
  assert.equal(x.raw.turnStartCalls, 1);
});

test("stop during the native read fences late text and preserves the original execution", async t => {
  const x = await fixture(t);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const read = x.raw.threadRead.bind(x.raw);
  x.raw.threadRead = async params => { entered(); await gate; return read(params); };
  const pending = x.reconcile(); await started;
  x.store.requestAbort({ opportunityId: x.claim.opportunity.id, reason: "GROUP_DISCUSSION_STOPPED" });
  release(); await pending;
  assert.equal(x.recovered().length, 0);
  assert.equal(x.messages().length, 0);
  assert.equal(x.raw.turnStartCalls, 1);
});

test("account and session changes while reading prevent a late canonical append", async t => {
  for (const change of ["account", "session"]) {
    const x = await fixture(t);
    const read = x.raw.threadRead.bind(x.raw);
    x.raw.threadRead = async params => {
      const result = await read(params);
      if (change === "account") {
        const original = x.f.service.workRunCoordinator.runtimeAccountAdmission.read.bind(x.f.service.workRunCoordinator.runtimeAccountAdmission);
        x.f.service.workRunCoordinator.runtimeAccountAdmission.read = id => ({ ...original(id), mutationActive: true });
      } else {
        const original = x.f.service.chatSessionStore.getSession.bind(x.f.service.chatSessionStore);
        x.f.service.chatSessionStore.getSession = key => {
          const session = original(key); return key === x.run.sourceId ? { ...session, revision: session.revision + 1 } : session;
        };
      }
      return result;
    };
    await x.reconcile();
    assert.equal(x.recovered().length, 0);
    assert.equal(x.messages().length, 0);
    assert.equal(x.raw.turnStartCalls, 1);
  }
});

test("driver stop during history observation rejects the late original result", async t => {
  const x = await fixture(t), read = x.raw.threadRead.bind(x.raw);
  x.raw.threadRead = async params => { const response = await read(params); x.driver.stop(); return response; };
  await x.reconcile();
  assert.equal(x.recovered().length, 0);
  assert.equal(x.messages().length, 0);
  assert.equal(startsForOriginal(x), 1);
});

test("concurrent rereads restore one canonical answer and one public reply", async t => {
  const x = await fixture(t);
  await Promise.all([x.reconcile(), x.reconcile(), x.reconcile()]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(x.recovered().length, 1);
  assert.equal(x.messages().filter(message => message.origin?.opportunityId === x.claim.opportunity.id).length, 1);
  assert.equal(startsForOriginal(x), 1);
});
