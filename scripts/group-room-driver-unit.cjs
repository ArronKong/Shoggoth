"use strict";
// 群聊单一机制的驱动：真实 GroupChatStore + 可控执行器、草稿与计时器，不启动模型。
// 覆盖顺序发言、正常慢任务不让位、连续异常两分钟让位但不中止、审批与后台结果、
// 群主失败顺延、重启恢复、升级时中止旧运行。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GroupChatStore } = require("../app/agent-service/group-chat-store");
const { GroupChatDriver } = require("../app/agent-service/group-chat-driver");
const { normalizeInteractiveRequestV1 } = require("../app/core/shoggoth-interaction-contract");
const { GroupActivityProjection } = require("../app/agent-service/group-activity");

const RELEASE_MS = 15_000;
const IDLE_MS = 2 * 60_000;

function fixture(t, names = ["Chief", "写手", "程序员"]) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grd-")));
  fs.chmodSync(root, 0o700);
  const paths = { stateDir: path.join(root, "state"), trustedRoot: root };
  let clock = 1_000_000;
  let runSequence = 0;
  const timers = [];
  const runs = new Map();
  const executor = {
    started: [], aborted: [],
    async ensureSession(binding) { return `session-${binding.memberId}`; },
    async start({ sessionKey, operationId, prompt }) {
      const run = { id: `run-${++runSequence}`, source: "chat", sourceId: sessionKey,
        idempotencyKey: `shoggoth:chat-send:${operationId}`, status: "running", text: null, errorCode: null };
      runs.set(run.id, run);
      executor.started.push({ sessionKey, prompt, run });
      return run;
    },
    interactionRequest(run, interaction) {
      return { request: normalizeInteractiveRequestV1({ runId: run.id, eventType: "approval",
        payload: { requestId: interaction.requestId, command: "rm -rf build", reason: "清理" }, expiresAt: null }), context: null };
    },
    async respond() {},
    findRun({ operationId }) { return [...runs.values()].find((run) => run.idempotencyKey.endsWith(operationId)) ?? null; },
    getRun(runId) { return runs.get(runId) ?? null; },
    async abort({ runId }) { executor.aborted.push(runId); },
    finalText(run) { return run.text; },
  };
  const drafts = { text: new Map(), watched: [], start() {}, stop() {}, watch(id) { drafts.watched.push(id); },
    forget() {}, draftFor(id) { return drafts.text.get(id) ?? null; }, activityFor() { return null; } };
  const open = () => new GroupChatStore({ paths, now: () => clock }).open();
  const driverFor = (store, options = {}) => new GroupChatDriver({ store, executor, drafts, abortGraceMs: 500,
    setTimer: (fn, ms) => { const timer = { fn, ms, at: clock + ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (timer) => { if (timer) timer.cleared = true; }, ...options });
  let store = open();
  const { groupId } = store.createGroup({ operationId: "g", name: "小团队", purpose: "",
    members: names.map((name, index) => ({ backendId: "shoggoth", agentId: `agent-${index}`, profileId: `p-${index}`, displayName: name })) });
  const ids = store.getGroup(groupId).members.map((member) => member.id);
  t.after(() => { try { store.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  const settle = async () => { for (let i = 0; i < 25; i++) await new Promise((resolve) => setImmediate(resolve)); };
  // 推进时钟并触发到期的计时器。
  const advance = async (ms) => {
    clock += ms;
    for (const timer of timers.filter((item) => !item.cleared && item.at <= clock)) { timer.cleared = true; timer.fn(); }
    await settle();
  };
  const started = (name) => executor.started.filter((item) => item.sessionKey === `session-${ids[names.indexOf(name)]}`);
  return {
    groupId, ids, executor, drafts, settle, advance, started, driverFor, runs, timers,
    get store() { return store; },
    reopen() { store.close(); store = open(); return store; },
    send: (body) => store.appendUserMessage({ groupId, clientMessageId: `c-${Math.random()}`, body, mentionMemberIds: [] }),
    finish(driver, item, text, status = "completed") { item.run.status = status; item.run.text = text; driver.onRunTerminal(item.run); },
    bodies: () => store.listMessages({ groupId, limit: 100 }).messages.map(message => message.author.kind === "system"
      ? `[${message.system.eventType}]` : `${message.author.kind === "user" ? "用户" : names[ids.indexOf(message.author.memberId)]}: ${message.body}`),
    opportunity: (item) => store.getOpportunity(item.run.idempotencyKey.replace("shoggoth:chat-send:group-turn-", "")),
  };
}

function activityFor(f, turn) {
  const binding = { groupId: turn.groupId, discussionId: turn.discussionId, memberId: turn.memberId,
    opportunityId: turn.id, runId: turn.runId,
    executionGeneration: [turn.fence ?? "", turn.sessionKey ?? "", turn.runId ?? "", turn.external?.executionId ?? ""].join(":") };
  const projection = new GroupActivityProjection(binding, { now: () => f.store.now() });
  let seq = 0;
  return { projection, event(type, payload) { projection.observeEvents([{ seq: ++seq, type, payload,
    createdAt: f.store.now() }], "fixture-stream"); return projection.snapshot(); } };
}

function unconfirmed(f, driver, item) {
  item.run.status = "unknown";
  const turn = f.opportunity(item);
  driver.onExecutionObservation(turn.id, { ...activityFor(f, turn).projection.snapshot(), status: "unknown" });
  return f.store.getOpportunity(turn.id);
}

test("a normally running member remains the speaker after twenty silent minutes", async t => {
  const f = fixture(t), driver = f.driverFor(f.store); await driver.start(); t.after(() => driver.stop());
  f.send("@写手 @程序员 依次协作"); driver.wake(f.groupId); await f.settle();
  const writer = f.started("写手")[0];
  await f.advance(20 * 60_000);
  assert.equal(f.opportunity(writer).released, false);
  assert.equal(f.started("程序员").length, 0); assert.deepEqual(f.executor.aborted, []);
  f.finish(driver, writer, "下一位需要的完整结论。"); await f.settle();
  assert.equal(f.started("程序员").length, 1);
  assert.match(f.started("程序员")[0].prompt, /下一位需要的完整结论/u);
});

test("normal tools keep the floor even without output for more than two minutes", async t => {
  const f = fixture(t), driver = f.driverFor(f.store); await driver.start(); t.after(() => driver.stop());
  f.send("@写手 @程序员 依次协作"); driver.wake(f.groupId); await f.settle();
  const writer = f.started("写手")[0], turn = f.opportunity(writer), source = activityFor(f, turn);
  driver.onActivity(turn.id, source.event("tool.start", { toolCallId: "compile", tool: { name: "exec" } }));
  await f.advance(20 * 60_000);
  assert.equal(f.opportunity(writer).released, false); assert.equal(f.started("程序员").length, 0);
  assert.deepEqual(f.executor.aborted, []);
});

test("one speaker at a time; @ passes the turn and the callee sees the order and its place", async (t) => {
  const f = fixture(t);
  const driver = f.driverFor(f.store); await driver.start();
  f.send("帮我写一篇博客"); driver.wake(f.groupId); await f.settle();
  assert.equal(f.executor.started.length, 1, "only the owner starts");
  const owner = f.started("Chief")[0];
  assert.match(owner.prompt, /You are the owner/u);
  assert.match(owner.prompt, /user: 帮我写一篇博客/u);
  f.finish(driver, owner, "@写手 先出骨架"); await f.settle();
  const writer = f.started("写手")[0];
  assert.ok(writer, "the writer is called next");
  assert.match(writer.prompt, /^\[Group "小团队" · Chief invited you\]/u);
  assert.match(writer.prompt, /Current speaking queue: Chief \(posted\) → you \(now\)\./u);
  assert.match(writer.prompt, /Chief: @写手 先出骨架/u);
  f.finish(driver, writer, "骨架三段。"); await f.settle();
  assert.equal(f.executor.started.length, 2);
  assert.deepEqual(f.bodies(), ["用户: 帮我写一篇博客", "Chief: @写手 先出骨架", "写手: 骨架三段。"]);
  driver.stop();
});

test("a member that keeps using tools gives up the floor after 15 seconds; its result comes back to the caller", async (t) => {
  const f = fixture(t);
  const driver = f.driverFor(f.store, { releaseAfterToolMs: RELEASE_MS }); await driver.start();
  f.send("把博客做出来"); driver.wake(f.groupId); await f.settle();
  f.finish(driver, f.started("Chief")[0], "@写手 写初稿，@程序员 给技术栈"); await f.settle();
  const writer = f.started("写手")[0];
  const writerTurn = f.opportunity(writer);
  f.drafts.text.set(writerTurn.id, "我来写初稿。");
  driver.onActivity(writerTurn.id, activityFor(f, writerTurn).event("tool.start", { toolCallId: "t1", tool: { name: "write" } }));
  await f.advance(RELEASE_MS - 1);
  assert.equal(f.started("程序员").length, 0, "still the writer's turn before 15 seconds");
  await f.advance(1);
  assert.equal(f.started("程序员").length, 1, "the coder speaks while the writer keeps working");
  assert.match(f.started("程序员")[0].prompt, /Still working; results will return: 写手 \(1 min\)/u);
  f.finish(driver, f.started("程序员")[0], "Astro。"); await f.settle();
  f.finish(driver, writer, "我来写初稿。\n\n初稿：……"); await f.settle();
  assert.equal(f.started("Chief").length, 2, "the owner asked for the work and answers its result");
  assert.match(f.started("Chief")[1].prompt, /写手 finished the work you assigned/u);
  assert.deepEqual(f.bodies(), ["用户: 把博客做出来", "Chief: @写手 写初稿，@程序员 给技术栈", "写手: 我来写初稿。",
    "程序员: Astro。", "写手: 初稿：……"]);
  driver.stop();
});

test("waiting for approval gives up the floor without being cancelled by the silence rule", async (t) => {
  const f = fixture(t);
  const driver = f.driverFor(f.store); await driver.start();
  f.send("@写手 @程序员 各做一件事"); driver.wake(f.groupId); await f.settle();
  const writer = f.started("写手")[0];
  writer.run.status = "waiting_approval";
  driver.onRunInteraction(writer.run, { phase: "requested", requestId: "approve-1" }); await f.settle();
  const coder = f.started("程序员")[0];
  assert.ok(coder, "the next member speaks while the writer waits for approval");
  assert.equal(f.store.getGroup(f.groupId).pendingInteractions.length, 1);
  await f.advance(20 * 60_000);
  assert.deepEqual(f.executor.aborted, []);
  assert.equal(f.store.getOpportunity(f.opportunity(writer).id).state, "waiting");
  f.finish(driver, coder, "技术说明。"); await f.settle();
  assert.equal(f.bodies().at(-1), "程序员: 技术说明。");
  assert.equal(f.store.getGroup(f.groupId).members.length, 3);
  driver.stop();
});

test("two unconfirmed minutes release the floor; the same task finishes twenty minutes later exactly once", async t => {
  const f = fixture(t), driver = f.driverFor(f.store); await driver.start(); t.after(() => driver.stop());
  f.send("@写手 @程序员 各做一件事"); driver.wake(f.groupId); await f.settle();
  const writer = f.started("写手")[0], original = f.opportunity(writer);
  unconfirmed(f, driver, writer);
  await f.advance(IDLE_MS - 1); assert.equal(f.started("程序员").length, 0);
  await f.advance(1);
  const released = f.store.getOpportunity(original.id);
  assert.equal(released.released, true); assert.equal(released.releasedReason, "idle");
  assert.equal(released.state, "running"); assert.equal(released.runId, original.runId);
  assert.equal(released.abortReason, null); assert.equal(f.started("程序员").length, 1);
  assert.match(f.started("程序员")[0].prompt, /Execution status unconfirmed: 写手/u);
  assert.match(f.started("程序员")[0].prompt, /do not assume their missing results are available/u);
  assert.deepEqual(f.executor.aborted, []); assert.equal(f.started("写手").length, 1);
  f.finish(driver, f.started("程序员")[0], "下一位已回答。"); await f.settle();
  await f.advance(20 * 60_000);
  f.finish(driver, writer, "后台原任务完成。"); await f.settle();
  f.finish(driver, writer, "后台原任务完成。"); await f.settle();
  assert.equal(f.bodies().filter(body => body === "写手: 后台原任务完成。").length, 1);
  assert.deepEqual(f.executor.aborted, []); assert.equal(f.started("写手").length, 1);
});

test("the anomaly interval starts at the failure signal, and a healthy response cancels it", async t => {
  const f = fixture(t), driver = f.driverFor(f.store); await driver.start(); t.after(() => driver.stop());
  f.send("@写手 @程序员 依次协作"); driver.wake(f.groupId); await f.settle();
  const writer = f.started("写手")[0];
  await f.advance(10 * 60_000);
  unconfirmed(f, driver, writer);
  await f.advance(IDLE_MS - 1); assert.equal(f.started("程序员").length, 0);
  const oldTimer = driver.timers.get(`idle:${f.opportunity(writer).id}`);
  writer.run.status = "running";
  const turn = f.opportunity(writer);
  driver.onExecutionObservation(turn.id, { ...activityFor(f, turn).projection.snapshot(), status: "running" });
  await f.advance(1); oldTimer.fn(); await f.settle();
  assert.equal(f.opportunity(writer).released, false);
  await f.advance(10 * 60_000); assert.equal(f.started("程序员").length, 0);
  unconfirmed(f, driver, writer);
  await f.advance(IDLE_MS); assert.equal(f.started("程序员").length, 1);
  assert.deepEqual(f.executor.aborted, []);
});

test("native reconciliation keeps checking automatically and publishes the original result without a UI action", async t => {
  const f = fixture(t), driver = f.driverFor(f.store); await driver.start(); t.after(() => driver.stop());
  f.send("@写手 @程序员 依次协作"); driver.wake(f.groupId); await f.settle();
  const writer = f.started("写手")[0], turn = unconfirmed(f, driver, writer);
  await f.advance(IDLE_MS); assert.equal(f.opportunity(writer).released, true);
  await f.advance(5000);
  assert.ok(driver.timers.has(turn.id), "an unknown snapshot does not end automatic reconciliation");
  writer.run.status = "completed"; writer.run.text = "自动读回的原任务结果。";
  await f.advance(5000);
  assert.equal(f.bodies().filter(body => body === "写手: 自动读回的原任务结果。").length, 1);
  assert.equal(f.started("写手").length, 1); assert.deepEqual(f.executor.aborted, []);
});

test("a normal native terminal snapshot is recovered automatically if the terminal hook was missed", async t => {
  const f = fixture(t), driver = f.driverFor(f.store); await driver.start(); t.after(() => driver.stop());
  f.send("@写手 @程序员 依次协作"); driver.wake(f.groupId); await f.settle();
  const writer = f.started("写手")[0], turn = f.opportunity(writer);
  writer.run.status = "completed"; writer.run.text = "自动发现的完整结果。";
  driver.onExecutionObservation(turn.id, { ...activityFor(f, turn).projection.snapshot(), status: "completed" });
  await f.settle();
  assert.equal(f.bodies().filter(body => body === "写手: 自动发现的完整结果。").length, 1);
  assert.equal(f.started("程序员").length, 1); assert.equal(f.started("写手").length, 1);
});

test("new public text resets the quiet interval; polling, event cursors and foreign activity do not", async t => {
  const f = fixture(t), driver = f.driverFor(f.store); await driver.start(); t.after(() => driver.stop());
  f.send("@写手 @程序员 继续"); driver.wake(f.groupId); await f.settle();
  const turn = f.opportunity(f.started("写手")[0]), source = activityFor(f, turn);
  unconfirmed(f, driver, f.started("写手")[0]);
  await f.advance(110_000);
  const progress = source.event("text.delta", { itemId: "a", delta: "正在整理。" }); driver.onActivity(turn.id, progress);
  const staleTimer = f.timers.filter(timer => timer.ms === IDLE_MS)[0];
  await f.advance(10_000); staleTimer.fn(); await f.settle();
  assert.equal(f.started("程序员").length, 0, "an already queued old callback rechecks the persisted deadline");
  await f.advance(109_999);
  driver.onActivity(turn.id, { ...progress, observedAt: f.store.now(), eventSeq: progress.eventSeq + 100 });
  driver.onActivity(turn.id, { ...progress, memberId: "foreign", lastProgressAt: f.store.now(), textMessages: [{ id: "x", text: "foreign" }] });
  driver.onActivity(turn.id, { ...progress, executionGeneration: "old", lastProgressAt: f.store.now(), textMessages: [{ id: "x", text: "stale" }] });
  assert.equal(f.started("程序员").length, 0);
  await f.advance(1); assert.equal(f.started("程序员").length, 1);
  assert.deepEqual(f.executor.aborted, []);
  assert.ok(!f.bodies().some(body => /foreign|stale/u.test(body)));
});

test("a ten minute normal task also keeps its floor during later silence", async t => {
  const f = fixture(t), driver = f.driverFor(f.store); await driver.start(); t.after(() => driver.stop());
  f.send("@写手 @程序员 继续"); driver.wake(f.groupId); await f.settle();
  const turn = f.opportunity(f.started("写手")[0]), source = activityFor(f, turn);
  for (let index = 0; index < 6; index++) {
    await f.advance(110_000);
    driver.onActivity(turn.id, source.event("text.delta", { itemId: "a", delta: `进展${index}。` }));
    assert.equal(f.started("程序员").length, 0);
  }
  await f.advance(IDLE_MS - 1); assert.equal(f.started("程序员").length, 0);
  await f.advance(1); assert.equal(f.started("程序员").length, 0);
  f.finish(driver, f.started("写手")[0], "完整结论。"); await f.settle();
  assert.equal(f.started("程序员").length, 1);
  assert.deepEqual(f.executor.aborted, []);
});

test("real tool progress without chat text resets silence; duplicate tool updates do not", async t => {
  const f = fixture(t), driver = f.driverFor(f.store, { releaseAfterToolMs: 30 * 60_000 });
  await driver.start(); t.after(() => driver.stop());
  f.send("@写手 @程序员 继续"); driver.wake(f.groupId); await f.settle();
  const turn = f.opportunity(f.started("写手")[0]), source = activityFor(f, turn);
  driver.onActivity(turn.id, source.event("tool.start", { toolCallId: "t", tool: { name: "exec" } }));
  await f.advance(110_000);
  driver.onActivity(turn.id, source.event("tool.update", { toolCallId: "t", progress: { lines: 10 } }));
  await f.advance(110_000); assert.equal(f.started("程序员").length, 0);
  driver.onActivity(turn.id, source.event("tool.update", { toolCallId: "t", progress: { lines: 10 } }));
  await f.advance(10_000); assert.equal(f.started("程序员").length, 0);
  assert.deepEqual(f.executor.aborted, []);
});

test("restart preserves the remaining anomaly interval and does not restart a task", async t => {
  const f = fixture(t); let driver = f.driverFor(f.store); await driver.start(); t.after(() => driver.stop());
  f.send("@写手 @程序员 继续"); driver.wake(f.groupId); await f.settle();
  const turn = f.opportunity(f.started("写手")[0]), source = activityFor(f, turn);
  await f.advance(60_000);
  driver.onActivity(turn.id, source.event("text.delta", { itemId: "a", delta: "原进展。" }));
  unconfirmed(f, driver, f.started("写手")[0]);
  await f.advance(90_000); driver.stop(); f.reopen();
  driver = f.driverFor(f.store); await driver.start(); await f.settle();
  assert.equal(f.executor.started.length, 1);
  const rebound = activityFor(f, f.store.getOpportunity(turn.id));
  driver.onActivity(turn.id, rebound.event("text", { itemId: "a", text: "原进展。" }));
  await f.advance(29_999); assert.equal(f.started("程序员").length, 0);
  await f.advance(1); assert.equal(f.started("程序员").length, 1);
  assert.deepEqual(f.executor.aborted, []);
});

test("a stop request wins over an already queued silence callback and does not advance the stopped discussion", async t => {
  const f = fixture(t), driver = f.driverFor(f.store); await driver.start(); t.after(() => driver.stop());
  f.send("@写手 @程序员 继续"); driver.wake(f.groupId); await f.settle();
  const turn = f.opportunity(f.started("写手")[0]);
  unconfirmed(f, driver, f.started("写手")[0]);
  const silence = f.timers.find(timer => timer.ms === IDLE_MS);
  const stopped = f.store.stopDiscussion({ groupId: f.groupId }); await driver.abortAll(stopped.aborts);
  await f.advance(IDLE_MS); silence.fn(); await f.settle();
  assert.equal(f.store.getOpportunity(turn.id).released, false);
  assert.equal(f.started("程序员").length, 0);
  assert.deepEqual(f.executor.aborted, [turn.runId]);
});

test("member stop frees the floor while cancellation hangs, keeps the same member busy and suppresses late results", async t => {
  const f = fixture(t), driver = f.driverFor(f.store); await driver.start(); t.after(() => driver.stop());
  let releaseAbort;
  f.executor.abort = async ({ runId }) => { f.executor.aborted.push(runId); await new Promise(resolve => { releaseAbort = resolve; }); };
  f.send("@写手 @程序员 继续"); driver.wake(f.groupId); await f.settle();
  const writer = f.started("写手")[0], turn = f.opportunity(writer);
  const stopped = f.store.stopMember({ groupId: f.groupId, memberId: turn.memberId });
  await driver.abortAll(stopped.aborts); driver.wake(f.groupId); await f.settle();
  assert.equal(f.started("程序员").length, 1, "the next member starts without a cancellation receipt");
  assert.match(f.started("程序员")[0].prompt, /The user ended 写手's turn\. Do not wait for that reply or assume the unfinished work completed/u);
  assert.equal(f.store.getOpportunity(turn.id).releasedReason, "stopped");
  f.send("@写手 新的问题"); driver.wake(f.groupId); await f.settle();
  await f.advance(500); await f.advance(5000); await f.advance(5000);
  assert.equal(f.started("写手").length, 1, "an unconfirmed old run is not replayed or overlapped");
  assert.deepEqual(f.executor.aborted, [writer.run.id], "automatic reads do not overlap an in-flight cancellation");
  f.finish(driver, f.started("程序员")[0], "(pass)"); await f.settle();
  f.finish(driver, writer, "迟到的结果 @Chief"); await f.settle();
  assert.equal(f.bodies().some(body => body.includes("迟到的结果")), false);
  assert.equal(f.bodies().filter(body => body === "[turn_stopped]").length, 1);
  releaseAbort(); await f.settle();
  assert.equal(f.started("写手").length, 2, "a confirmed terminal allows a fresh user message to continue");
});

test("restart releases a legacy member stop even when the original run cannot be queried", async t => {
  const f = fixture(t); let driver = f.driverFor(f.store); await driver.start(); t.after(() => driver.stop());
  f.send("@写手 @程序员 继续"); driver.wake(f.groupId); await f.settle();
  const writer = f.started("写手")[0], legacy = f.opportunity(writer);
  legacy.abortReason = "GROUP_MEMBER_STOPPED";
  f.store.db.prepare("UPDATE opportunities SET data=? WHERE id=?").run(JSON.stringify(legacy), legacy.id);
  driver.stop(); f.reopen(); f.runs.delete(writer.run.id);
  driver = f.driverFor(f.store); await driver.start(); await f.settle();
  assert.equal(f.started("写手").length, 1, "recovery does not resend the stopped work");
  assert.equal(f.started("程序员").length, 1, "an old unconfirmed stop no longer owns the floor");
  assert.equal(f.store.getOpportunity(legacy.id).releasedReason, "stopped");
  assert.equal(f.bodies().filter(body => body === "[turn_stopped]").length, 1);
});

test("member stop during model preparation never starts that model task", async t => {
  const f = fixture(t); let releasePreparation;
  f.executor.prepareModel = ({ member }) => member.displayName === "写手"
    ? new Promise(resolve => { releasePreparation = resolve; }) : Promise.resolve();
  const driver = f.driverFor(f.store); await driver.start(); t.after(() => driver.stop());
  f.send("@写手 @程序员 继续"); driver.wake(f.groupId); await f.settle();
  const turn = f.store.runningOpportunities()[0];
  await driver.abortAll(f.store.stopMember({ groupId: f.groupId, memberId: turn.memberId }).aborts);
  driver.wake(f.groupId); await f.settle();
  assert.equal(f.started("程序员").length, 1);
  releasePreparation(); await f.settle();
  assert.equal(f.started("写手").length, 0, "stopping a prepared but undispatched task prevents start");
  assert.equal(f.executor.aborted.length, 0, "no runtime task was started to cancel");
});

test("start latency alone does not skip a normal task or start it twice", async t => {
  const f = fixture(t), start = f.executor.start; let releaseStart;
  f.executor.start = async params => {
    const first = f.executor.started.length === 0, run = await start(params);
    return first ? new Promise(resolve => { releaseStart = () => resolve(run); }) : run;
  };
  const driver = f.driverFor(f.store); await driver.start(); t.after(() => driver.stop());
  f.send("@写手 @程序员 继续"); driver.wake(f.groupId); await f.settle();
  const writer = f.started("写手")[0];
  await f.advance(IDLE_MS);
  assert.equal(f.started("程序员").length, 0); assert.deepEqual(f.executor.aborted, []);
  releaseStart(); await f.settle();
  assert.equal(f.opportunity(writer).released, false); assert.equal(f.opportunity(writer).runId, writer.run.id);
  f.finish(driver, writer, "原启动请求的结果。"); await f.settle();
  assert.equal(f.started("写手").length, 1);
  assert.equal(f.bodies().filter(body => body === "写手: 原启动请求的结果。").length, 1);
});

test("a recovered missing native run yields for others while keeping its original identity under reconciliation", async t => {
  const f = fixture(t); let driver = f.driverFor(f.store); await driver.start(); t.after(() => driver.stop());
  f.send("@写手 @程序员 继续"); driver.wake(f.groupId); await f.settle();
  const writer = f.started("写手")[0], original = f.opportunity(writer);
  await f.advance(90_000); driver.stop(); f.runs.delete(writer.run.id); f.reopen();
  driver = f.driverFor(f.store); await driver.start(); await f.settle();
  assert.equal(f.store.getOpportunity(original.id).recovery.type, "execution");
  await f.advance(IDLE_MS - 1); assert.equal(f.started("程序员").length, 0);
  await f.advance(1);
  assert.equal(f.started("程序员").length, 1);
  assert.equal(f.store.getOpportunity(original.id).runId, original.runId);
  assert.equal(f.started("写手").length, 1); assert.deepEqual(f.executor.aborted, []);
});

test("a released member stays busy; stopping the whole group still stops its background task and the new speaker", async t => {
  const f = fixture(t), driver = f.driverFor(f.store); await driver.start(); t.after(() => driver.stop());
  f.send("@写手 @程序员 继续"); driver.wake(f.groupId); await f.settle();
  const writer = f.started("写手")[0]; unconfirmed(f, driver, writer); await f.advance(IDLE_MS);
  const coder = f.started("程序员")[0];
  f.send("@写手 下一件事"); driver.wake(f.groupId); await f.settle();
  assert.equal(f.started("写手").length, 1, "the busy member is not dispatched again");
  const stopped = f.store.stopDiscussion({ groupId: f.groupId }); await driver.abortAll(stopped.aborts); await f.settle();
  assert.deepEqual(f.executor.aborted.sort(), [writer.run.id, coder.run.id].sort());
  assert.deepEqual(f.store.getGroup(f.groupId).queuedMemberIds, []);
  f.finish(driver, writer, null, "canceled"); f.finish(driver, coder, null, "canceled"); await f.settle();
  await f.advance(20 * 60_000);
  assert.equal(f.executor.started.length, 2); assert.equal(f.store.getGroup(f.groupId).activeTurns.length, 0);
});

test("a failed owner hands a plain message to the next member", async (t) => {
  const f = fixture(t);
  const driver = f.driverFor(f.store); await driver.start();
  f.send("在吗"); driver.wake(f.groupId); await f.settle();
  f.finish(driver, f.started("Chief")[0], null, "failed"); await f.settle();
  assert.equal(f.started("写手").length, 1);
  assert.match(f.started("写手")[0].prompt, /owner could not answer/u);
  driver.stop();
});

test("restart keeps the speaking order and the running turn; old-mechanism runs are stopped once", async (t) => {
  const f = fixture(t);
  let driver = f.driverFor(f.store); await driver.start();
  f.send("@写手 @程序员 各说一句"); driver.wake(f.groupId); await f.settle();
  const writer = f.started("写手")[0];
  driver.stop(); f.reopen();
  driver = f.driverFor(f.store); await driver.start(); await f.settle();
  assert.equal(f.executor.started.length, 1, "the writer's run is observed, not restarted");
  f.finish(driver, writer, "好。"); await f.settle();
  assert.equal(f.started("程序员").length, 1, "the round goes on after restart");
  driver.stop();
});

test("upgrading a v9 group database retires old discussions and tasks and stops their runs once", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grm-")));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const { openDatabase } = require("../app/agent-service/inspiration-database");
  const db = openDatabase(path.join(stateDir, "group-chats.sqlite"));
  // 0.8.215（c2169df4）实际写出的 v9 群库结构。
  db.exec(fs.readFileSync(path.join(__dirname, "fixtures/group-chat-v9-schema.sql"), "utf8"));
  const put = (table, columns, values) => db.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...values);
  const group = { id: "g1", name: "旧群", purpose: "", status: "active", createdAt: 1, updatedAt: 1, metadataRevision: 1,
    rosterRevision: 1, directoryRevision: 0, controlEpoch: 1, lastSeq: 1, mode: "collaborative", coordination: { memberId: "m2", epoch: 3 } };
  put("groups", ["id", "status", "updated_at", "data"], ["g1", "active", 1, JSON.stringify(group)]);
  for (const [id, position] of [["m1", 0], ["m2", 1]]) put("members", ["id", "group_id", "position", "state", "handle", "data"],
    [id, "g1", position, "active", id, JSON.stringify({ id, groupId: "g1", backendId: "shoggoth", agentId: id, profileId: `p-${id}`,
      displayName: id, handle: id, state: "active", position, joinedSeq: 0 })]);
  put("discussions", ["id", "group_id", "status", "created_at", "data"], ["d1", "g1", "running", 1, JSON.stringify({ id: "d1", groupId: "g1", status: "running" })]);
  put("opportunities", ["id", "group_id", "discussion_id", "member_id", "state", "ordinal", "run_id", "data"],
    ["o1", "g1", "d1", "m1", "running", 1, "run-old", JSON.stringify({ id: "o1", groupId: "g1", discussionId: "d1", memberId: "m1",
      state: "running", runId: "run-old", sessionKey: "session-old", runKind: "native" })]);
  put("opportunities", ["id", "group_id", "discussion_id", "member_id", "state", "ordinal", "run_id", "data"],
    ["o2", "g1", "d1", "m2", "queued", 2, null, JSON.stringify({ id: "o2", groupId: "g1", discussionId: "d1", memberId: "m2", state: "queued" })]);
  put("tasks", ["id", "group_id", "status", "target_member_id", "created_at", "data"], ["t1", "g1", "running", "m2", 1,
    JSON.stringify({ id: "t1", groupId: "g1", status: "running", attempts: [{ id: "a1", state: "running", runId: "run-task", sessionKey: "session-task" }] })]);
  db.close();

  let clock = 5_000;
  const store = new GroupChatStore({ paths: { stateDir, trustedRoot: root }, now: () => clock }).open();
  t.after(() => { try { store.close(); } catch {} });
  assert.equal(store.diagnostics().schemaVersion, 10);
  assert.equal(store.getOpportunity("o1").state, "cancelled");
  assert.equal(store.getOpportunity("o2").errorCode, "GROUP_UPGRADE_RETIRED");
  assert.equal(store.getGroup("g1").group.ownerMemberId, "m1", "the owner follows the new default rule, not a temporary coordinator succession");
  const aborted = [];
  const driver = new GroupChatDriver({ store, executor: { async abort({ runId }) { aborted.push(runId); } },
    setTimer: () => ({}), clearTimer: () => {} });
  await driver.start();
  assert.deepEqual(aborted.sort(), ["run-old", "run-task"]);
  driver.stop();
  const again = new GroupChatDriver({ store, executor: { async abort({ runId }) { aborted.push(runId); } },
    setTimer: () => ({}), clearTimer: () => {} });
  await again.start();
  assert.equal(aborted.length, 2, "retired runs are stopped only once");
  again.stop();
  clock += 1;
});

test("a native session that cannot be compacted is renewed once; the new session sees recent messages and can look back", async (t) => {
  const f = fixture(t, ["Chief", "写手"]);
  // Like the real executor, a renewed binding gets a new creation key (retired generation).
  f.executor.ensureSession = async (binding) => `session-${binding.memberId}${binding.external?.retired?.length ? `-r${binding.external.retired.length}` : ""}`;
  const driver = f.driverFor(f.store); await driver.start();
  for (let n = 0; n < 7; n++) {
    f.send(`第 ${n} 条`); driver.wake(f.groupId); await f.settle();
    f.finish(driver, f.executor.started.at(-1), `收到 ${n}`); await f.settle();
  }
  const owner = f.ids[0];
  f.send("继续"); driver.wake(f.groupId); await f.settle();
  const pressured = f.executor.started.at(-1);
  assert.equal(pressured.sessionKey, `session-${owner}`);
  const reject = (item, errorCode) => { item.run.status = "failed"; item.run.errorCode = errorCode; item.run.runtimeTurnRef = null; driver.onRunTerminal(item.run); };
  reject(pressured, "RUNTIME_COMPACTION_FAILED"); await f.settle();
  const renewed = f.executor.started.at(-1);
  assert.notEqual(renewed, pressured, "the same turn is asked again");
  assert.equal(renewed.sessionKey, `session-${owner}-r1`);
  assert.match(renewed.prompt, /\(6 earlier messages not listed; read them with group_messages_read when needed\)/u);
  assert.match(renewed.prompt, /user: 继续/u);
  assert.ok(f.store.isInternalSessionKey(`session-${owner}`), "the retired session stays internal");
  assert.deepEqual(f.bodies().slice(-1), ["[session_renewed]"]);
  // A fresh session that still cannot take the input fails normally: no renewal loop.
  reject(renewed, "CONTEXT_COMPACTION_REQUIRED"); await f.settle();
  assert.equal(f.executor.started.filter((item) => item.sessionKey.startsWith(`session-${owner}`)).length, 9,
    "the owner is not asked a third time");
  assert.match(f.executor.started.at(-1).prompt, /the owner could not answer/u, "the ordinary owner fallback still applies");
  assert.deepEqual(f.bodies().slice(-2), ["[session_renewed]", "[turn_failed]"]);
  driver.stop();
});

test("only pre-send context rejections renew a session", async (t) => {
  const f = fixture(t, ["Chief", "写手"]);
  const driver = f.driverFor(f.store); await driver.start();
  f.send("一"); driver.wake(f.groupId); await f.settle();
  f.finish(driver, f.executor.started.at(-1), "好"); await f.settle();
  f.send("二"); driver.wake(f.groupId); await f.settle();
  const executed = f.executor.started.at(-1);
  executed.run.status = "failed"; executed.run.errorCode = "RUNTIME_COMPACTION_FAILED";
  executed.run.runtimeTurnRef = { turnId: "sent" };
  driver.onRunTerminal(executed.run); await f.settle();
  f.send("三"); driver.wake(f.groupId); await f.settle();
  const other = f.executor.started.at(-1);
  other.run.status = "failed"; other.run.errorCode = "CONTEXT_INPUT_TOO_LARGE"; other.run.runtimeTurnRef = null;
  driver.onRunTerminal(other.run); await f.settle();
  assert.equal(f.bodies().filter((body) => body === "[session_renewed]").length, 0);
  assert.equal(f.bodies().filter((body) => body === "[turn_failed]").length, 2);
  driver.stop();
});
