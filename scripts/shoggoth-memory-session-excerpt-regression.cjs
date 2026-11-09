"use strict";

// 2026-11-06 OpenClaw session-memory parity: when a direct conversation ends
// its newest messages become an excerpt in today's daily note (no model call),
// and the nightly pass runs excerpts, then the review, then Dreaming. Uses a
// real isolated Product Service and memory core.
const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { A, fixture } = require("./fixtures/memory-repair-fixture.cjs");
const { SESSION_CAPTURE_IDLE_MS, SESSION_CAPTURE_MAX_MESSAGES } = require("../app/agent-service/shoggoth-memory/session-capture.cjs");

const DAY = 24 * 60 * 60 * 1000;

function boundSession(f) {
  const session = f.session(), id = crypto.randomUUID();
  f.service.chatSessionStore.requestBinding(session.sessionKey, `binding-${id}`, f.now());
  f.service.chatSessionStore.completeBinding(session.sessionKey, `binding-${id}`, `runtime-${id}`);
  return f.service.chatSessionStore.getSession(session.sessionKey);
}

function chatTurn(f, session, user, assistant = null, { userContent = {} } = {}) {
  const { service } = f, id = crypto.randomUUID();
  service.workDispatcher.enqueue({ id, profileId: A, source: "chat", sourceId: session.sessionKey, idempotencyKey: id, workspace: f.workspace });
  service.workDispatcher.admit(id); service.workDispatcher.transition(id, "running");
  const event = service.transcriptStore.appendEvent({ profileId: A, sessionId: session.id, id: `user-${id}`, runId: id,
    kind: "user", content: { text: user, ...userContent }, occurredAt: f.now() });
  if (assistant) service.transcriptStore.appendEvent({ profileId: A, sessionId: session.id, id: `assistant-${id}`, runId: id,
    kind: "assistant", content: { text: assistant }, occurredAt: f.now() });
  service.workDispatcher.transition(id, "completed");
  return event;
}

const dailyNotes = f => {
  const directory = path.join(f.owner.store.workspace(A), "memory");
  if (!fs.existsSync(directory)) return "";
  return fs.readdirSync(directory).filter(name => /^\d{4}-\d{2}-\d{2}\.md$/u.test(name))
    .map(name => fs.readFileSync(path.join(directory, name), "utf8")).join("\n");
};
const excerpts = f => f.owner.store.list(A, { status: "active" }).filter(item => item.id.startsWith("session-excerpt-"));
const bootstrapText = f => f.owner.bootstrap({ profileId: A, workspace: f.workspace, mainSession: true, maxSensitivity: "private" })
  .memory.map(file => file.text).join("\n");

test("opening a new conversation keeps the previous one as an excerpt the next conversation loads", async (t) => {
  const f = await fixture(t);
  const capture = f.owner.sessionCapture;
  const first = boundSession(f);
  chatTurn(f, first, "我在准备北极星的发布清单，周四上午冻结代码。", "好的，发布前一天我会提醒你检查清单。");
  const second = boundSession(f);
  assert.deepEqual(await capture.onSessionCreated(A, second.id), { written: 1 });
  const notes = dailyNotes(f);
  assert.match(notes, /Session excerpt \(new-session\)/u);
  assert.match(notes, /- User: 我在准备北极星的发布清单，周四上午冻结代码。/u);
  assert.match(notes, /- Assistant: 好的，发布前一天我会提醒你检查清单。/u);
  assert.equal(excerpts(f).length, 1);
  assert.equal(excerpts(f)[0].memoryPath.startsWith("memory/"), true);
  assert.match(bootstrapText(f), /周四上午冻结代码/u, "today's note is part of the next conversation's bootstrap");
  assert.equal(f.modelCalls(), 0, "excerpts never call a model");
  // Nothing new: no second excerpt; new messages produce a new one with only them.
  assert.deepEqual(await capture.onSessionCreated(A, second.id), { written: 0 });
  chatTurn(f, first, "另外，发布说明用英文写。");
  assert.deepEqual(await capture.onSessionCreated(A, second.id), { written: 1 });
  const [older, newer] = excerpts(f).sort((a, b) => a.createdAt - b.createdAt);
  assert.match(older.content, /周四上午冻结代码/u);
  assert.match(newer.content, /发布说明用英文写/u);
  assert.doesNotMatch(newer.content, /周四上午冻结代码/u);
});

test("the idle sweep waits for a quiet conversation and keeps only the newest messages, without credentials", async (t) => {
  const f = await fixture(t);
  const capture = f.owner.sessionCapture;
  const session = boundSession(f);
  for (let index = 1; index <= SESSION_CAPTURE_MAX_MESSAGES + 3; index++) chatTurn(f, session, `第 ${index} 条普通消息。`);
  chatTurn(f, session, "临时 key 是 sk-proj-abcdefghijklmnopqrstuvwxyz123456，用完就删。");
  chatTurn(f, session, "确认执行", null, { userContent: { origin: "ui_action_submission" } });
  await capture.sweep();
  assert.equal(excerpts(f).length, 0, "a conversation active within the idle window is left alone");
  f.advance(SESSION_CAPTURE_IDLE_MS + 1000);
  await capture.sweep();
  assert.equal(excerpts(f).length, 1);
  const content = excerpts(f)[0].content;
  assert.match(content, /Session excerpt \(idle\)/u);
  assert.doesNotMatch(content, /sk-proj-|第 1 条普通消息|确认执行/u);
  assert.match(content, new RegExp(`第 ${SESSION_CAPTURE_MAX_MESSAGES + 3} 条普通消息`, "u"));
  assert.ok(content.split("\n").filter(line => line.startsWith("- ")).length <= SESSION_CAPTURE_MAX_MESSAGES);
  assert.doesNotMatch(dailyNotes(f), /sk-proj-/u);
  assert.doesNotThrow(() => bootstrapText(f), "a credential never blocks the daily note from context");
});

test("forgetting a conversation removes its excerpt; group-chat and stale conversations are never captured", async (t) => {
  const f = await fixture(t);
  const capture = f.owner.sessionCapture;
  const forgotten = boundSession(f);
  chatTurn(f, forgotten, "这个会话之后会被遗忘：银色望远镜的序列号是 77。");
  await capture.captureProfile(A, { reason: "nightly", idleMs: 0 });
  assert.match(dailyNotes(f), /序列号是 77/u);
  await f.owner.forgetSession(A, forgotten.id);
  assert.equal(excerpts(f).length, 0);
  assert.doesNotMatch(dailyNotes(f), /序列号是 77/u);
  assert.doesNotMatch(bootstrapText(f), /序列号是 77/u);

  const group = boundSession(f);
  chatTurn(f, group, "群聊里的一句话：灯塔计划下周开始。");
  capture.isInternalSession = key => key === group.sessionKey;
  assert.deepEqual(await capture.captureProfile(A, { reason: "nightly", idleMs: 0 }), { written: 0 });
  assert.doesNotMatch(dailyNotes(f), /灯塔计划/u);
  capture.isInternalSession = () => false;

  // A conversation whose last message predates the backfill window counts as done.
  const stale = await fixture(t);
  const old = boundSession(stale);
  chatTurn(stale, old, "很久以前的一句话：旧仓库在 /srv/legacy。");
  stale.advance(8 * DAY);
  assert.deepEqual(await stale.owner.sessionCapture.captureProfile(A, { reason: "nightly", idleMs: 0 }), { written: 0 });
  const progress = await stale.owner.sessionCapture.progress(A, old.id);
  assert.ok(progress.capturedSeq > 0 && progress.reviewedSeq === progress.capturedSeq);
});

test("the nightly pass finishes excerpts, then the review, then Dreaming; review failures never block", async (t) => {
  const f = await fixture(t);
  const session = boundSession(f);
  chatTurn(f, session, "今晚复盘前应该先被摘录：项目代号叫青鸟。");
  const order = [];
  f.owner.beforeNightlyDream = async (profileId, { signal }) => {
    assert.equal(profileId, A);
    assert.equal(signal instanceof AbortSignal, true);
    order.push(dailyNotes(f).includes("项目代号叫青鸟") ? "review-after-excerpt" : "review-before-excerpt");
    throw Object.assign(new Error("model down"), { code: "MEMORY_IMPORT_TIMEOUT" });
  };
  await f.owner.maintenance.beforeDream(A, new AbortController().signal);
  assert.deepEqual(order, ["review-after-excerpt"]);
  // A Service stop still interrupts the nightly pass.
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(f.owner.maintenance.beforeDream(A, stopped.signal));
});

test("an Agent without a working directory sees the previous conversation's excerpt; project directories stay apart", async (t) => {
  // As in the App: an Agent with no defaultCwd gets a generated directory
  // per new conversation (chat.session.create -> managedChatWorkspace).
  const f = await fixture(t);
  const { managedChatWorkspace } = require("../app/agent-service/chat-workspace");
  const home = path.join(f.owner.paths.defaultWorkspaceDir, A);
  const generated = id => { const value = managedChatWorkspace(home, id); fs.mkdirSync(value, { recursive: true, mode: 0o700 }); return value; };
  const open = workspace => {
    const session = f.service.chatSessionStore.createSession({ profileId: A, workspace, operationId: crypto.randomUUID(), createdAt: f.now() });
    const id = crypto.randomUUID();
    f.service.chatSessionStore.requestBinding(session.sessionKey, `binding-${id}`, f.now());
    f.service.chatSessionStore.completeBinding(session.sessionKey, `binding-${id}`, `runtime-${id}`);
    return f.service.chatSessionStore.getSession(session.sessionKey);
  };
  const turn = (session, user, assistant) => {
    const id = crypto.randomUUID(), { service } = f;
    service.workDispatcher.enqueue({ id, profileId: A, source: "chat", sourceId: session.sessionKey, idempotencyKey: id, workspace: session.workspace });
    service.workDispatcher.admit(id); service.workDispatcher.transition(id, "running");
    for (const [kind, text] of [["user", user], ["assistant", assistant]]) service.transcriptStore.appendEvent({ profileId: A,
      sessionId: session.id, id: `${kind}-${id}`, runId: id, kind, content: { text }, occurredAt: f.now() });
    service.workDispatcher.transition(id, "completed");
  };
  const loads = (workspace, text) => f.owner.bootstrap({ profileId: A, workspace, mainSession: true, maxSensitivity: "private" })
    .memory.some(file => file.text.includes(text));
  const first = open(generated("first-conversation"));
  turn(first, "实测代号叫 QNHOME7311，周四上午冻结代码。", "记下了。");
  const second = open(generated("second-conversation"));
  assert.deepEqual(await f.owner.sessionCapture.onSessionCreated(A, second.id), { written: 1 });
  assert.equal(loads(second.workspace, "QNHOME7311"), true, "the next generated conversation loads the excerpt");
  assert.equal(loads(home, "QNHOME7311"), true, "the Agent's root directory is the same home");
  assert.equal(loads(f.workspace, "QNHOME7311"), false, "a project directory does not see home conversations");
  // A project conversation's excerpt stays out of the home directories.
  const project = open(f.workspace);
  turn(project, "项目里的代号叫 QNPROJ7311。", "好的。");
  assert.deepEqual(await f.owner.sessionCapture.onSessionCreated(A, second.id), { written: 1 });
  assert.equal(loads(f.workspace, "QNPROJ7311"), true);
  assert.equal(loads(second.workspace, "QNPROJ7311"), false, "home conversations do not see a project's excerpt");
  // Another Agent's generated directory is not this Agent's home.
  assert.equal(f.owner.sameEvidenceWorkspace(A, second.workspace, managedChatWorkspace(path.join(f.owner.paths.defaultWorkspaceDir, f.B), "x")), false);
  // Forgetting the source conversation still withdraws its excerpt everywhere.
  await f.owner.forgetSession(A, first.id);
  assert.equal(loads(second.workspace, "QNHOME7311"), false);
});
