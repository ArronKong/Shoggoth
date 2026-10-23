"use strict";
// 群聊单一机制的驱动：真实 GroupChatStore + 可控执行器、草稿与计时器，不启动模型。
// 覆盖一个接一个发言、用工具满 15 秒让位、审批让位、30 分钟无动静超时、迟到结果由派活者回应、
// 群主失败顺延、重启恢复、升级时中止旧运行。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GroupChatStore } = require("../app/agent-service/group-chat-store");
const { GroupChatDriver } = require("../app/agent-service/group-chat-driver");
const { normalizeInteractiveRequestV1 } = require("../app/core/shoggoth-interaction-contract");

const RELEASE_MS = 15_000;
const IDLE_MS = 30 * 60_000;

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
  const driverFor = (store) => new GroupChatDriver({ store, executor, drafts, abortGraceMs: 500,
    setTimer: (fn, ms) => { const timer = { fn, ms, at: clock + ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (timer) => { if (timer) timer.cleared = true; } });
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
    groupId, ids, executor, drafts, settle, advance, started, driverFor, runs,
    get store() { return store; },
    reopen() { store.close(); store = open(); return store; },
    send: (body) => store.appendUserMessage({ groupId, clientMessageId: `c-${Math.random()}`, body, mentionMemberIds: [] }),
    finish(driver, item, text, status = "completed") { item.run.status = status; item.run.text = text; driver.onRunTerminal(item.run); },
    bodies: () => store.listMessages({ groupId, limit: 100 }).messages.map(message => message.author.kind === "system"
      ? `[${message.system.eventType}]` : `${message.author.kind === "user" ? "用户" : names[ids.indexOf(message.author.memberId)]}: ${message.body}`),
    opportunity: (item) => store.getOpportunity(item.run.idempotencyKey.replace("shoggoth:chat-send:group-turn-", "")),
  };
}

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
  const driver = f.driverFor(f.store); await driver.start();
  f.send("把博客做出来"); driver.wake(f.groupId); await f.settle();
  f.finish(driver, f.started("Chief")[0], "@写手 写初稿，@程序员 给技术栈"); await f.settle();
  const writer = f.started("写手")[0];
  const writerTurn = f.opportunity(writer);
  f.drafts.text.set(writerTurn.id, "我来写初稿。");
  const now = f.store.now();
  driver.onActivity(writerTurn.id, { tool: { id: "t1", startedAt: now }, recentTools: [], streamGeneration: "s" });
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

test("waiting for approval gives up the floor; thirty quiet minutes time the speaker out", async (t) => {
  const f = fixture(t);
  const driver = f.driverFor(f.store); await driver.start();
  f.send("@写手 @程序员 各做一件事"); driver.wake(f.groupId); await f.settle();
  const writer = f.started("写手")[0];
  writer.run.status = "waiting_approval";
  driver.onRunInteraction(writer.run, { phase: "requested", requestId: "approve-1" }); await f.settle();
  const coder = f.started("程序员")[0];
  assert.ok(coder, "the next member speaks while the writer waits for approval");
  assert.equal(f.store.getGroup(f.groupId).pendingInteractions.length, 1);
  await f.advance(IDLE_MS - 1000);
  driver.onActivity(f.opportunity(coder).id, { tool: null, recentTools: [], streamGeneration: "s" });
  await f.advance(IDLE_MS - 1000);
  assert.deepEqual(f.executor.aborted, [], "any movement restarts the quiet timer");
  await f.advance(1000);
  assert.deepEqual(f.executor.aborted, [coder.run.id]);
  f.finish(driver, coder, null, "canceled"); await f.settle();
  assert.equal(f.bodies().at(-1), "[turn_failed]");
  assert.equal(f.store.getGroup(f.groupId).members.length, 3);
  driver.stop();
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
