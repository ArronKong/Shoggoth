"use strict";
// 外部成员群回合（里程碑③）：真实 GroupChatStore + GroupChatDriver + GroupExternalExecutor，
// App 私有桥用可控的假客户端代替（形状与 group.external.* 合同一致）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GroupChatStore } = require("../app/agent-service/group-chat-store");
const { GroupChatDriver } = require("../app/agent-service/group-chat-driver");
const { GroupExternalExecutor } = require("../app/agent-service/group-external-executor");
const { normalizeInteractiveRequestV1 } = require("../app/core/shoggoth-interaction-contract");

const { resultPage } = require("../app/group-result-content");
const HOST = "11111111-1111-4111-8111-111111111111";

function fakeClient() {
  const client = {
    calls: [], snapshots: new Map(), failStartOnce: false, sessions: 0, startStatus: () => "running",
    lostSessions: new Set(), failGet: false,
    reply: () => ({ status: "completed", resultSummary: "外部成员的回答", errorCode: null, attention: null }),
    async request(method, params) {
      client.calls.push({ method, params: structuredClone(params) });
      const snapshot = (status, extra = {}) => ({ hostId: HOST, snapshot: { executionId: params.executionId, runId: params.runId,
        backendId: params.backendId, agentId: params.agentId, sessionKey: params.sessionKey, workspace: params.workspace,
        mode: params.mode, status, sequence: 1, resultSummary: null, errorCode: null, finishedAt: null, attention: null, ...extra } });
      if (method === "group.external.prepare") {
        if (params.sessionKey && client.lostSessions.has(params.sessionKey)) {
          throw Object.assign(new Error("unconfirmed"), { code: "HERMES_INSPIRATION_SESSION_UNCONFIRMED" });
        }
        const sessionKey = params.sessionKey ?? `agent:${params.agentId}:group-${++client.sessions}`;
        return { hostId: HOST, binding: { sessionKey, workspace: params.workspace ?? "/tmp/hermes-ws", mode: "gateway" } };
      }
      if (method === "group.external.start") {
        if (client.failStartOnce) { client.failStartOnce = false; throw Object.assign(new Error("lost"), { code: "FEDERATION_COMMIT_UNCERTAIN" }); }
        client.snapshots.set(params.executionId, { ...client.reply(params), prompt: params.prompt });
        return snapshot(client.startStatus(params));
      }
      if (method === "group.external.get") {
        if (client.failGet) throw Object.assign(new Error("bridge down"), { code: "APP_HOST_UNAVAILABLE" });
        const value = client.snapshots.get(params.executionId) ?? { status: "running" };
        return snapshot(value.status, { resultSummary: value.resultSummary ?? null, errorCode: value.errorCode ?? null,
          attention: value.attention ?? null, finishedAt: ["completed", "failed", "canceled"].includes(value.status) ? 1 : null });
      }
      if (method === "group.external.result") {
        if (client.failResult) throw new Error("receipt unavailable");
        const text = client.snapshots.get(params.executionId)?.resultSummary;
        return { hostId: HOST, page: typeof text === "string" ? resultPage(text, params) : null };
      }
      if (method === "group.external.respond") {
        client.snapshots.set(params.executionId, { status: "completed", resultSummary: `已按「${params.response.choice}」处理` });
        return snapshot("running");
      }
      if (method === "group.external.cancel") {
        client.snapshots.set(params.executionId, { status: "canceled" });
        return snapshot("canceled", { finishedAt: 1 });
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return client;
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gex-")));
  fs.chmodSync(root, 0o700);
  const paths = { stateDir: path.join(root, "state"), trustedRoot: root };
  let store = new GroupChatStore({ paths }).open();
  const client = fakeClient();
  const timers = [];
  const setTimer = (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; };
  const clearTimer = (timer) => { if (timer) timer.cleared = true; };
  const nativeStarts = [];
  let clock = 0;
  const nativeExecutor = { async ensureSession(b) { return `native-${b.memberId}`; },
    async start({ prompt }) { nativeStarts.push(prompt); return { id: `n-${nativeStarts.length}`, status: "running" }; },
    findRun() { return null; }, getRun() { return null; }, async abort() {}, finalText() { return null; } };
  const make = () => {
    let driver;
    const external = new GroupExternalExecutor({ store, getClient: () => client, pollMs: 10, setTimer, clearTimer,
      now: () => clock, unconfirmedTimeoutMs: 90_000,
      onTerminal: (id, outcome) => driver.onExternalTerminal(id, outcome),
      onResumed: id => driver.onExternalResumed(id),
      onInteraction: (id, attention) => driver.onExternalInteraction(id, attention) });
    driver = new GroupChatDriver({ store, executor: nativeExecutor, externalExecutor: external, setTimer, clearTimer,
      attachmentPath: (attachment) => (attachment.name === "丢了.pdf" ? null : `/state/inspiration-media/${attachment.id}.bin`),
      inactivityMs: 60_000, abortGraceMs: 30_000 });
    return driver;
  };
  const { groupId } = store.createGroup({ operationId: "g", name: "混合群", purpose: "", members: [
    { backendId: "hermes", agentId: "helper", profileId: null, displayName: "Hermes Helper" },
    { backendId: "openclaw", agentId: "main", profileId: null, displayName: "OpenClaw Main" },
  ] });
  const ids = Object.fromEntries(store.getGroup(groupId).members.map((member) => [member.agentId, member.id]));
  t.after(() => { try { store.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve)); };
  // 依次触发到期的轮询计时器（不触发超时类的长计时器）。
  const tick = async (rounds = 5) => {
    for (let round = 0; round < rounds; round++) {
      for (const timer of timers.filter((item) => !item.cleared && item.ms === 10)) { timer.cleared = true; timer.fn(); }
      await settle();
    }
  };
  return { get store() { return store; }, reopen() { store.close(); store = new GroupChatStore({ paths }).open(); },
    client, make, groupId, ids, settle, tick, timers, nativeStarts, advance(ms) { clock += ms; },
    send: (body) => store.appendUserMessage({ groupId, clientMessageId: `c-${Math.random()}`, body, mentionMemberIds: [] }),
    messages: () => store.listMessages({ groupId, afterSeq: null, beforeSeq: null, limit: 100 }).messages };
}

test("external group replies retain verified response facts and optional unsupported metadata never fails the answer", async t => {
  for (const supported of [true, false]) await t.test(String(supported), async t => {
    const f = fixture(t), driver = f.make(), original = f.client.request.bind(f.client);
    const metadata = { models: ["external-actual"], modelSource: "reported", usage: { inputTokens: 120, outputTokens: 6 } };
    f.client.request = (method, params) => method === "group.external.metadata"
      ? supported ? Promise.resolve({ hostId: HOST, responseMetadata: metadata }) : Promise.reject(Object.assign(Error("old host"), { code: "INVALID_PARAMS" }))
      : original(method, params);
    await driver.start();
    f.send(`@${f.store.getGroup(f.groupId).members[0].handle} reply once`);
    driver.wake(f.groupId); await f.settle(); await f.tick();
    const reply = f.messages().find(message => message.author.kind === "member");
    assert.ok(reply, "verified answer still published");
    assert.deepEqual(reply.responseMetadata, supported ? metadata : undefined);
    assert.equal(f.client.calls.filter(call => call.method === "group.external.start").length, 1);
    driver.stop();
  });
});

test("a persisted stop retries the same cancel operation after a temporary bridge failure", async t => {
  for (const failGet of [false, true]) await t.test(`status read ${failGet ? "unavailable" : "available"}`, async t => {
  const f = fixture(t), driver = f.make(); await driver.start();
  f.client.reply = () => ({ status: "running" });
  f.send(`@${f.store.getGroup(f.groupId).members[0].handle} keep running`);
  driver.wake(f.groupId); await f.settle();
  const original = f.store.runningOpportunities()[0];
  const request = f.client.request.bind(f.client), cancels = [];
  let failCancel = true, releaseCancel;
  const pendingCancel = new Promise(resolve => { releaseCancel = resolve; });
  f.client.request = async (method, params) => {
    if (method === "group.external.cancel") {
      cancels.push(structuredClone(params));
      if (failCancel) throw Object.assign(new Error("temporary bridge failure"), { code: "APP_HOST_UNAVAILABLE" });
      await pendingCancel;
    }
    return request(method, params);
  };
  await driver.abortAll(f.store.stopDiscussion({ groupId: f.groupId }).aborts); await f.settle();
  assert.equal(cancels.length, 1);
  assert.equal(f.store.getGroup(f.groupId).activeTurns[0].recovery.cancelRequested, true);
  failCancel = false; f.client.failGet = failGet; await f.tick(1);
  assert.equal(cancels.length, 2, "status reconciliation must resume the already-persisted cancellation");
  assert.deepEqual(cancels[1], cancels[0], "retry keeps the same execution, authority and cancellation operation");
  assert.equal(cancels[1].runId, original.runId);
  await f.tick(3);
  assert.equal(cancels.length, 2, "polling never overlaps an in-flight cancellation");
  releaseCancel(); await f.settle(); await f.tick(1);
  assert.equal(f.store.getGroup(f.groupId).activeTurns.length, 0);
  assert.equal(f.store.getGroup(f.groupId).round, null);
  assert.equal(f.client.calls.filter(call => call.method === "group.external.start").length, 1,
    "recovering a stop never starts a new model run");
  driver.stop();
  });
});

test("a proven Host queue clears legacy start uncertainty, gives up the floor without cancelling and accepts the same run once", async t => {
  const f = fixture(t), driver = f.make(); await driver.start();
  t.after(() => driver.stop());
  let proven = false;
  f.client.startStatus = () => "queued"; f.client.reply = () => ({ status: "queued" });
  const request = f.client.request.bind(f.client);
  f.client.request = async (method, params) => {
    const result = await request(method, params);
    if (result.snapshot?.status === "queued") {
      result.snapshot.sequence = 0;
      if (proven) result.snapshot.dispatchState = "queued";
    }
    return result;
  };
  f.send(`@${f.store.getGroup(f.groupId).members[0].handle} wait`); driver.wake(f.groupId); await f.settle();
  const original = f.store.runningOpportunities()[0];
  f.advance(91_000); await f.tick(1);
  assert.equal(f.store.getOpportunity(original.id).recovery.reason, "GROUP_EXTERNAL_START_UNCONFIRMED");
  proven = true; await f.tick(1);
  let current = f.store.getOpportunity(original.id);
  assert.equal(current.recovery, null); assert.equal(current.observation.dispatchState, "queued");
  assert.equal(current.observation.unknownSince, null); assert.equal(current.observation.acceptedAt, null);
  f.advance(600_000); await f.tick(2);
  // Even a timeout armed before the queue proof must re-read current state.
  for (const timer of f.timers.filter(timer => !timer.cleared && timer.ms > 10)) { timer.cleared = true; timer.fn(); }
  await f.settle();
  current = f.store.getOpportunity(original.id);
  assert.equal(current.recovery, null); assert.ok(!current.abortReason);
  assert.equal(current.released, true, "a Host-queued run gives up the floor instead of timing out");
  assert.equal(f.client.calls.some(call => call.method === "group.external.cancel"), false);
  f.client.snapshots.set(original.external.executionId, { status: "running" }); await f.tick(1);
  current = f.store.getOpportunity(original.id);
  assert.equal(current.runId, original.runId); assert.equal(current.observation.dispatchState, null);
  assert.ok(current.observation.acceptedAt > 0);
  f.client.snapshots.set(original.external.executionId, { status: "completed", resultSummary: "same run finished" }); await f.tick(1);
  assert.equal(f.store.getOpportunity(original.id).state, "replied");
  assert.equal(f.client.calls.filter(call => call.method === "group.external.start" && call.params.executionId === original.external.executionId).length, 1);
});

test("a disconnected unaccepted queue is never cancelled for silence, including across restart", async t => {
  for (const restart of [false, true]) await t.test(`restart=${restart}`, async t => {
    const f = fixture(t); let now = 1; f.store.now = () => now;
    let driver = f.make(); await driver.start(); t.after(() => driver.stop());
    f.client.startStatus = () => "queued"; f.client.reply = () => ({ status: "queued" });
    const request = f.client.request.bind(f.client);
    f.client.request = async (method, params) => {
      const result = await request(method, params);
      if (result.snapshot?.status === "queued") Object.assign(result.snapshot, { sequence: 0, dispatchState: "queued" });
      return result;
    };
    f.send(`@${f.store.getGroup(f.groupId).members[0].handle} wait`); driver.wake(f.groupId); await f.settle();
    const original = f.store.runningOpportunities()[0];
    const preflight = f.timers.find(timer => timer.ms === 60_000);
    f.client.failGet = true; await f.tick(1);
    assert.equal(f.store.getOpportunity(original.id).observation.status, "unavailable");
    assert.equal(f.store.getOpportunity(original.id).activeSince, null);
    now += 9 * 60 * 60_000; f.advance(9 * 60 * 60_000);
    if (restart) {
      driver.stop(); f.reopen(); f.store.now = () => now;
      driver = f.make(); await driver.start();
      for (const timer of f.timers.filter(timer => !timer.cleared && timer.ms !== 10)) { timer.cleared = true; timer.fn(); }
    } else preflight.fn(); // A timeout callback may already be queued when cleared.
    await f.settle();
    assert.ok(!f.store.getOpportunity(original.id).abortReason, "transport downtime cannot consume an unaccepted execution budget");
    assert.equal(f.client.calls.some(call => call.method === "group.external.cancel"), false);
    f.client.failGet = false; await f.tick(1);
    f.client.snapshots.set(original.external.executionId, { status: "running" }); await f.tick(1);
    assert.equal(f.store.getOpportunity(original.id).activeSince, now);
    assert.equal(f.store.getOpportunity(original.id).releasedReason, "busy", "the unobservable run gave up the floor instead");
    f.client.snapshots.set(original.external.executionId, { status: "completed", resultSummary: "original run finished" }); await f.tick(1);
    assert.equal(f.store.getOpportunity(original.id).state, "replied");
    assert.equal(f.client.calls.filter(call => call.method === "group.external.start").length, 1);
  });
});

test("queue proof cannot erase a cancellation request or accepted execution", async t => {
  const f = fixture(t), driver = f.make(); await driver.start();
  t.after(() => driver.stop());
  f.client.startStatus = () => "queued"; f.client.reply = () => ({ status: "queued" });
  f.send(`@${f.store.getGroup(f.groupId).members[0].handle} wait`); driver.wake(f.groupId); await f.settle();
  const turn = f.store.runningOpportunities()[0], input = { kind: "turn", id: turn.id, runId: turn.runId,
    hostId: turn.external.hostId, fence: f.store.getDriverFence() };
  f.store.markReconciliation({ ...input, reason: "GROUP_EXTERNAL_START_UNCONFIRMED", cancelRequested: true });
  let result = f.store.recordExecutionObservation({ ...input, status: "queued", dispatchState: "queued", sequence: 0 });
  assert.equal(result.record.recovery.cancelRequested, true);
  f.store.recordExecutionObservation({ ...input, status: "running", sequence: 1 });
  result = f.store.recordExecutionObservation({ ...input, status: "queued", dispatchState: "queued", sequence: 0 });
  assert.equal(result.record.observation.dispatchState, null);
  assert.ok(result.record.observation.acceptedAt != null);
});

test("external members take turns through the bridge, reuse their session and get no tool hints", async (t) => {
  const f = fixture(t);
  const driver = f.make();
  await driver.start();
  f.send("@all 大家好"); driver.wake(f.groupId); await f.settle(); await f.tick();
  const members = f.messages().filter((message) => message.author.kind === "member");
  assert.deepEqual(members.map((message) => message.author.memberId), [f.ids.helper, f.ids.main], "one after another, owner first");
  assert.deepEqual(members.map((message) => message.body), ["外部成员的回答", "外部成员的回答"]);
  const prepares = f.client.calls.filter((call) => call.method === "group.external.prepare");
  assert.deepEqual(prepares.map((call) => call.params.sessionKey), [null, null], "first turns create sessions");
  const starts = f.client.calls.filter((call) => call.method === "group.external.start");
  assert.equal(starts[0].params.runId, prepares[0].params.runId, "prepare and start share one execution identity");
  assert.doesNotMatch(starts[0].params.prompt, /group_member_role_read/u);
  assert.match(starts[0].params.prompt, /混合群/u);
  assert.match(starts[1].params.prompt, /Hermes Helper: 外部成员的回答/u, "the second speaker sees the first one's reply");
  assert.match(starts[1].params.prompt, /Your queued position: 2\/2/u);
  const binding = f.store.getGroup(f.groupId).internalSessionKeys;
  assert.deepEqual(binding.sort(), ["agent:helper:group-1", "agent:main:group-2"]);

  f.client.calls.length = 0;
  f.send(`@${f.store.getGroup(f.groupId).members[0].handle} 再说一句`); driver.wake(f.groupId); await f.settle(); await f.tick();
  const again = f.client.calls.find((call) => call.method === "group.external.prepare");
  assert.equal(again.params.sessionKey, "agent:helper:group-1", "later turns reuse the member's group session");
  assert.equal(again.params.workspace, "/tmp/hermes-ws", "and its actual workspace");
});

test("an external interaction becomes a group card and the answer goes back through the bridge (M29)", async (t) => {
  const f = fixture(t);
  const request = (runId) => normalizeInteractiveRequestV1({ runId, eventType: "approval",
    payload: { requestId: "ext-req-1", command: "git push", reason: "推送分支" }, expiresAt: null });
  f.client.reply = (params) => ({ status: "waiting_approval", attention: { active: true, request: request(params.runId) } });
  const driver = f.make();
  await driver.start();
  f.send(`@${f.store.getGroup(f.groupId).members[0].handle} 帮我推送`); driver.wake(f.groupId); await f.settle(); await f.tick(2);
  const pending = f.store.getGroup(f.groupId).pendingInteractions;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].request.requestId, "ext-req-1");
  assert.ok(!f.client.calls.some((call) => call.method === "group.external.cancel"), "the turn waits instead of being cancelled");
  await driver.respondInteraction({ opportunityId: pending[0].opportunityId, requestId: "ext-req-1",
    response: { choice: "once" }, operationId: "op-ext" });
  const respond = f.client.calls.find((call) => call.method === "group.external.respond");
  assert.deepEqual([respond.params.requestId, respond.params.response, respond.params.operationId], ["ext-req-1", { choice: "once" }, "op-ext"]);
  await f.tick();
  assert.equal(f.messages().at(-1).body, "已按「once」处理");
  assert.equal(f.store.getGroup(f.groupId).pendingInteractions.length, 0);
});

test("an uncertain start keeps checking the same execution instead of resending", async (t) => {
  const f = fixture(t);
  f.client.failStartOnce = true;
  const driver = f.make();
  await driver.start();
  f.send(`@${f.store.getGroup(f.groupId).members[0].handle} 你好`); driver.wake(f.groupId); await f.settle();
  // The lost start reached the host; the snapshot becomes available on the next poll.
  f.client.snapshots.set(f.client.calls.find((call) => call.method === "group.external.prepare").params.executionId,
    { status: "completed", resultSummary: "迟到但确认的回答" });
  await f.tick();
  assert.equal(f.client.calls.filter((call) => call.method === "group.external.start").length, 1, "start is not resent");
  assert.equal(f.messages().at(-1).body, "迟到但确认的回答");
});

test("restart recovery resumes an external turn by its recorded identity", async (t) => {
  const f = fixture(t);
  f.client.reply = () => ({ status: "running" });
  let driver = f.make();
  await driver.start();
  f.send(`@${f.store.getGroup(f.groupId).members[0].handle} 长回答`); driver.wake(f.groupId); await f.settle();
  const executionId = f.client.calls.find((call) => call.method === "group.external.start").params.executionId;
  driver.stop();
  f.reopen();
  driver = f.make();
  f.client.snapshots.set(executionId, { status: "completed", resultSummary: "重启后拿到的回答" });
  await driver.start(); await f.settle(); await f.tick();
  assert.equal(f.client.calls.filter((call) => call.method === "group.external.start").length, 1);
  assert.equal(f.messages().at(-1).body, "重启后拿到的回答");
});

test("removing an external member mid-turn cancels it and drops a late reply", async (t) => {
  const f = fixture(t);
  f.client.reply = () => ({ status: "running" });
  const driver = f.make();
  await driver.start();
  f.send(`@${f.store.getGroup(f.groupId).members[0].handle} 慢慢想`); driver.wake(f.groupId); await f.settle();
  const group = f.store.getGroup(f.groupId).group;
  const { aborts } = f.store.removeMember({ groupId: f.groupId, expectedRosterRevision: group.rosterRevision, memberId: f.ids.helper });
  await driver.abortAll(aborts); await f.settle(); await f.tick();
  assert.ok(f.client.calls.some((call) => call.method === "group.external.cancel"));
  assert.ok(!f.messages().some((message) => message.author.kind === "member"));
  assert.equal(f.messages().at(-1).system?.eventType, "member_removed");
  assert.equal(f.store.getGroup(f.groupId).group.ownerMemberId, f.ids.main, "the owner role moves to a remaining member");
});

test("an unconfirmed start becomes pending after 90 seconds, keeps its slot and can still complete", async (t) => {
  const f = fixture(t);
  const driver = f.make();
  await driver.start();
  const handle = (agentId) => f.store.getGroup(f.groupId).members.find((member) => member.agentId === agentId).handle;
  // Hermes 那边一直说不清这次执行有没有开始。
  f.client.startStatus = () => "unknown";
  f.client.reply = () => ({ status: "unknown", errorCode: "EXTERNAL_START_UNCONFIRMED" });
  f.send(`@${handle("helper")} 你好`); driver.wake(f.groupId); await f.settle(); await f.tick();
  f.advance(60_000); await f.tick();
  assert.ok(!f.store.runningOpportunities()[0].recovery, "60 seconds without confirmation is still waiting");
  f.advance(31_000); await f.tick();
  const waiting = f.store.runningOpportunities()[0];
  assert.equal(waiting.recovery.reason, "GROUP_EXTERNAL_START_UNCONFIRMED");
  assert.equal(f.client.calls.some((call) => call.method === "group.external.cancel"), false);
  assert.equal(f.store.getGroup(f.groupId).activeTurns.length, 1);
  assert.throws(() => f.store.retryMember({ groupId: f.groupId, memberId: f.ids.helper, operationId: "again" }),
    { code: "GROUP_CHAT_NOTHING_TO_RETRY" });
  f.client.snapshots.set(waiting.external.executionId, { status: "completed", resultSummary: "迟到的原始回答" });
  await f.tick();
  assert.equal(f.store.getGroup(f.groupId).activeTurns.length, 0);
  assert.equal(f.messages().at(-1).body, "迟到的原始回答");
  // 已确认开始的运行：状态是「运行中」就不受执行器时限影响，答多久都可以。
  f.client.startStatus = () => "running";
  f.client.reply = () => ({ status: "running" });
  f.send(`@${handle("main")} 慢慢做`); driver.wake(f.groupId); await f.settle(); await f.tick();
  const mainExecution = f.client.calls.filter((call) => call.method === "group.external.start").at(-1).params.executionId;
  f.advance(1_200_000); await f.tick();
  assert.equal(f.store.getGroup(f.groupId).activeTurns.length, 1);
  // 后端短暂查不到它（例如网关重连），或者 App 的桥暂时不可用：恢复后照常继续。
  f.client.snapshots.set(mainExecution, { status: "unknown", errorCode: "OPENCLAW_INSPECT_UNAVAILABLE" });
  await f.tick(); f.advance(100_000); await f.tick();
  assert.equal(f.store.getGroup(f.groupId).activeTurns.length, 1, "a short outage is not a lost run");
  f.client.snapshots.set(mainExecution, { status: "running" });
  await f.tick();
  f.client.failGet = true;
  f.advance(600_000); await f.tick();
  assert.equal(f.store.getGroup(f.groupId).activeTurns.length, 1, "bridge errors never count as a lost run");
  f.client.failGet = false;
  f.client.snapshots.set(mainExecution, { status: "completed", resultSummary: "跑了很久之后的回答" });
  await f.tick();
  assert.equal(f.messages().at(-1).body, "跑了很久之后的回答");
  assert.equal(f.store.getGroup(f.groupId).round, null);
});

test("a confirmed run lost by the backend remains pending and is not implicitly cancelled or replayed", async (t) => {
  const f = fixture(t);
  const driver = f.make();
  await driver.start();
  f.client.reply = () => ({ status: "running" });
  f.send(`@${f.store.getGroup(f.groupId).members[1].handle} 你好`); driver.wake(f.groupId); await f.settle(); await f.tick();
  const execution = f.client.calls.find((call) => call.method === "group.external.start").params.executionId;
  // 网关重启把进行中的运行丢了：之后一直查不到它。
  f.client.snapshots.set(execution, { status: "unknown", errorCode: "OPENCLAW_RUN_INTERRUPTED" });
  await f.tick(); f.advance(170_000); await f.tick();
  assert.equal(f.store.getGroup(f.groupId).activeTurns.length, 1, "still inside the window");
  f.advance(15_000); await f.tick();
  assert.equal(f.store.getGroup(f.groupId).activeTurns[0].recovery.reason, "GROUP_EXTERNAL_RUN_LOST");
  assert.equal(f.client.calls.some((call) => call.method === "group.external.cancel"), false);
  const starts = f.client.calls.filter((call) => call.method === "group.external.start").length;
  driver.stop(); f.reopen();
  const restarted = f.make(); await restarted.start(); f.advance(400_000); await f.tick();
  assert.equal(f.client.calls.filter((call) => call.method === "group.external.start").length, starts);
  assert.equal(f.store.runningOpportunities()[0].observation.acceptedAt, 0, "acceptance survives restart");
  f.client.snapshots.set(execution, { status: "completed", resultSummary: "重启后读回的回答" });
  await f.tick();
  assert.equal(f.messages().at(-1).body, "重启后读回的回答");
  assert.equal(f.store.getGroup(f.groupId).activeTurns.length, 0);
});

test("a hidden session the backend no longer resumes is replaced: new session, recent group history replayed, old one stays hidden", async (t) => {
  const f = fixture(t);
  const driver = f.make();
  await driver.start();
  const helper = f.store.getGroup(f.groupId).members[0];
  f.send(`@${helper.handle} 第一个问题`); driver.wake(f.groupId); await f.settle(); await f.tick();
  assert.equal(f.messages().at(-1).body, "外部成员的回答");
  const oldSession = f.store.getGroup(f.groupId).internalSessionKeys[0];
  // App 重启之后，Hermes 不再认这条旧会话。
  f.client.lostSessions.add(oldSession);
  f.client.reply = () => ({ status: "completed", resultSummary: "换了新会话后的回答", errorCode: null, attention: null });
  f.send(`@${helper.handle} 第二个问题`); driver.wake(f.groupId); await f.settle(); await f.tick();
  assert.equal(f.messages().at(-1).body, "换了新会话后的回答");
  assert.equal(f.messages().some((message) => message.system?.eventType === "turn_failed"), false, "the member is not reported as failed");
  const prepares = f.client.calls.filter((call) => call.method === "group.external.prepare");
  assert.deepEqual(prepares.map((call) => call.params.sessionKey), [null, oldSession, null]);
  assert.notEqual(prepares[2].params.executionId, prepares[1].params.executionId, "the retry uses a fresh execution identity");
  const start = f.client.calls.filter((call) => call.method === "group.external.start").at(-1).params;
  assert.notEqual(start.sessionKey, oldSession);
  const replay = start.prompt.split("\n").filter(line => /^(user|Hermes Helper \(you\)): /u.test(line));
  assert.deepEqual(replay, [`user: @${helper.handle} 第一个问题`, "Hermes Helper (you): 外部成员的回答", `user: @${helper.handle} 第二个问题`],
    "the new session replays the recent group history, including its own prior answer");
  const keys = f.store.getGroup(f.groupId).internalSessionKeys;
  assert.ok(keys.includes(oldSession) && keys.includes(start.sessionKey), "both sessions stay out of the ordinary chat list");
  // 新会话之后照常续用，不再回放。
  f.send(`@${helper.handle} 第三个问题`); driver.wake(f.groupId); await f.settle(); await f.tick();
  const third = f.client.calls.filter((call) => call.method === "group.external.start").at(-1).params;
  assert.equal(third.sessionKey, start.sessionKey);
  assert.doesNotMatch(third.prompt, /第一个问题/u);
  // 重启后放弃的旧会话仍然算群内部会话。
  driver.stop(); f.reopen();
  assert.ok(f.store.getGroup(f.groupId).internalSessionKeys.includes(oldSession));
});

test("external members get attachments as a note with local paths instead of files", async (t) => {
  const f = fixture(t);
  const driver = f.make();
  await driver.start();
  const helper = f.store.getGroup(f.groupId).members[0];
  const attachments = [{ id: "00000000-0000-4000-8000-000000000001", name: "截图.png", mimeType: "image/png", size: 10 },
    { id: "00000000-0000-4000-8000-000000000002", name: "丢了.pdf", mimeType: "application/pdf", size: 20 }];
  f.store.appendUserMessage({ groupId: f.groupId, clientMessageId: "x1", body: `@${helper.handle} 看一下`, mentionMemberIds: [], attachments });
  driver.wake(f.groupId); await f.settle(); await f.tick();
  const start = f.client.calls.find((call) => call.method === "group.external.start").params;
  assert.ok(start.prompt.includes(`user: @${helper.handle} 看一下 [Files: 截图.png, 丢了.pdf]`));
  assert.ok(start.prompt.includes("- 截图.png (image/png): /state/inspiration-media/00000000-0000-4000-8000-000000000001.bin"));
  assert.ok(start.prompt.includes("- 丢了.pdf (application/pdf): local path unavailable"));
  assert.equal(Object.hasOwn(start, "attachments"), false, "the bridge contract stays text only");
});


test("M32: confirmed acceptance survives a bridge outage and service restart, and prevents retry", async (t) => {
  const f = fixture(t); let driver = f.make(); await driver.start();
  f.client.reply = () => ({ status: "running" });
  f.send(`@${f.store.getGroup(f.groupId).members[0].handle} 写入`); driver.wake(f.groupId); await f.settle();
  const original = f.store.runningOpportunities()[0];
  assert.equal(original.observation.acceptedAt, 0);
  f.client.failGet = true; await f.tick();
  driver.stop(); f.reopen(); driver = f.make(); await driver.start();
  f.advance(181_000); await f.tick();
  const pending = f.store.runningOpportunities()[0];
  assert.equal(pending.runId, original.runId);
  assert.equal(pending.recovery.reason, "GROUP_EXTERNAL_RUN_LOST");
  assert.throws(() => f.store.retryMember({ groupId: f.groupId, memberId: pending.memberId, operationId: "no-double-write" }),
    { code: "GROUP_CHAT_NOTHING_TO_RETRY" });
  assert.equal(f.client.calls.filter((call) => call.method === "group.external.start" && call.params.agentId === "helper").length, 1,
    "coordination handoff never replays the original execution");
  f.client.failGet = false;
  f.client.snapshots.set(pending.external.executionId, { status: "completed", resultSummary: "原执行完成" });
  await driver.reconcile(pending.id); await f.settle();
  assert.equal(f.messages().at(-1).body, "原执行完成");
  driver.stop();
});

test("M34/M36: a missing external receipt is retried independently of the summary, including after restart", async (t) => {
  const f = fixture(t); let driver = f.make(); await driver.start();
  const text = "完整内容🙂\n".repeat(10_000) + "尾部 END";
  f.client.reply = () => ({ status: "completed", resultSummary: text });
  f.client.failResult = true;
  f.send(`@${f.store.getGroup(f.groupId).members[0].handle} 给出完整结果`); driver.wake(f.groupId); await f.settle(); await f.tick(1);
  const pending = f.store.runningOpportunities()[0];
  assert.equal(pending.recovery.type, "result");
  assert.equal(pending.observation.terminalStatus, "completed");
  driver.stop(); f.reopen(); driver = f.make(); await driver.start();
  // 状态桥即便断了，已确认的完成证据仍然有效；结果走独立的只读通道。
  f.client.failGet = true; f.client.failResult = false;
  await driver.reconcile(pending.id); await f.settle();
  assert.equal(f.client.calls.filter((call) => call.method === "group.external.start" && call.params.agentId === "helper").length, 1,
    "the original result is read without another run; a successor may start separately");
  const published = f.messages().at(-1);
  assert.equal(published.fullResult.bytes, Buffer.byteLength(text));
  let offset = 0, all = "";
  do { const { page } = f.store.readMessage({ groupId: f.groupId, seq: published.seq, offset, digest: published.fullResult.digest });
    all += page.text; offset = page.nextOffset; } while (offset !== null);
  assert.equal(all, text);
  driver.stop();
});

test("M37: mismatched result pages are never published and late snapshots from another execution are ignored", async (t) => {
  const f = fixture(t); const driver = f.make(); await driver.start();
  const request = f.client.request.bind(f.client);
  let corrupt = true, wrongIdentity = false;
  f.client.reply = () => ({ status: "completed", resultSummary: "真实正文" });
  f.client.request = async (method, params) => {
    const result = await request(method, params);
    if (method === "group.external.result" && corrupt) result.page.text = "另一运行的正文";
    if (method === "group.external.get" && wrongIdentity) result.snapshot.runId = "different-run";
    return result;
  };
  f.send(`@${f.store.getGroup(f.groupId).members[0].handle} 回答`); driver.wake(f.groupId); await f.settle(); await f.tick(1);
  assert.equal(f.messages().filter((message) => message.author.kind === "member").length, 0);
  assert.equal(f.store.runningOpportunities()[0].recovery.type, "result");
  corrupt = false; await driver.reconcile(f.store.runningOpportunities()[0].id); await f.settle();
  assert.equal(f.messages().at(-1).body, "真实正文");
  wrongIdentity = true;
  f.send(`@${f.store.getGroup(f.groupId).members[0].handle} 下一条`); driver.wake(f.groupId); await f.settle(); await f.tick(1);
  assert.equal(f.messages().filter((message) => message.author.kind === "member").length, 1);
  wrongIdentity = false; await driver.reconcile(f.store.runningOpportunities()[0].id); await f.settle();
  assert.equal(f.messages().filter((message) => message.author.kind === "member").length, 2);
  driver.stop();
});


test("an obsolete external driver cannot renew authority, cancel or change the adopted execution observation", async t => {
  const f = fixture(t); f.client.reply = () => ({ status: "running" });
  const old = f.make(); await old.start();
  f.send(`@${f.store.getGroup(f.groupId).members[0].handle} 开始`); old.wake(f.groupId); await f.settle();
  const opportunity = f.store.getOpportunity(f.store.getGroup(f.groupId).activeTurns[0]?.opportunityId); assert.ok(opportunity?.external);
  const current = f.make(); await current.start(); await f.settle();
  const calls = f.client.calls.length;
  await old.externalExecutor.reconcile(opportunity);
  assert.equal(f.client.calls.length, calls, "the old epoch is refused before any App RPC");
  assert.notEqual(f.store.getOpportunity(opportunity.id).observation?.status, "unavailable", "an old driver's failure cannot overwrite recovery");
  old.externalExecutor.cancel(opportunity); await f.settle();
  assert.ok(!f.client.calls.slice(calls).some(call => call.method === "group.external.cancel"));
  old.stop(); current.stop();
});
