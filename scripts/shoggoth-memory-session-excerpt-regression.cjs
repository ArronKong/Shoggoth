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
const { AsyncLocalStorage } = require("node:async_hooks");
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

test("excerpt lookup uses a fresh worker view and keeps deleted duplicates deleted", async (t) => {
  const f = await fixture(t);
  const { store, sessionCapture: capture } = f.owner;
  const session = boundSession(f);
  for (let index = 0; index < SESSION_CAPTURE_MAX_MESSAGES + 1; index++) {
    chatTurn(f, session, `保留每日笔记的例行检查 ${index}。`);
  }
  const captureScope = new AsyncLocalStorage();
  const captureExcerpt = () => captureScope.run(true, () => capture.capture(A, session.id, { reason: "nightly" }));
  const readView = f.owner.withAsyncMemoryReadView.bind(f.owner);
  let releaseBackground, reads = 0, gets = 0, walks = 0;
  const startBackground = new Promise(resolve => { releaseBackground = resolve; });
  t.mock.method(f.owner, "withAsyncMemoryReadView", (...args) => {
    if (captureScope.getStore()) {
      reads++;
      releaseBackground();
    }
    return readView(...args);
  });
  const syncGet = store.get.bind(store), syncWalk = store._filesystemStamp.bind(store);
  t.mock.method(store, "get", (...args) => {
    if (captureScope.getStore()) gets++;
    return syncGet(...args);
  });
  t.mock.method(store, "_filesystemStamp", (...args) => {
    if (captureScope.getStore()) walks++;
    return syncWalk(...args);
  });
  const sessions = f.owner.host(A).sessions;
  const originalRead = sessions.read.bind(sessions);
  const expectedSource = originalRead(A, session.id);
  let captures = 0;
  t.mock.method(sessions, "read", (...args) => {
    const scoped = captureScope.getStore() === true;
    if (scoped) {
      captures++;
      assert.ok(f.owner.memoryViewFor(A), "tape selection must use the worker view");
    }
    const source = originalRead(...args);
    if (scoped) assert.deepEqual(source, expectedSource);
    return source;
  });
  const originalStamp = sessions.stamp.bind(sessions);
  t.mock.method(sessions, "stamp", (...args) => {
    if (captureScope.getStore()) {
      assert.ok(f.owner.memoryViewFor(A), "session revision must never rewalk the tree at the writer fence");
    }
    return originalStamp(...args);
  });
  const background = startBackground.then(() => f.owner.withAsyncMemoryReadView(f.B, undefined, view => {
    assert.equal(captureScope.getStore(), undefined);
    return view.getRevisions();
  }));
  const excerpt = captureExcerpt().finally(releaseBackground);
  const [result, backgroundRevision] = await Promise.all([excerpt, background]);
  assert.ok(Number.isSafeInteger(backgroundRevision.revision), "the other Profile completed its own worker read");
  assert.equal(reads, 1);
  assert.equal(gets, 0);
  assert.equal(walks, 0);
  assert.equal(captures, 1);
  assert.equal(excerpts(f).length, 1);
  const item = excerpts(f)[0];
  assert.equal(result.id, item.id);
  await store.upsertMany([{ ...item, status: "deleted" }]);
  // Reproduce a write that survived before its progress receipt was advanced.
  await capture.store(A).update(`session:${session.id}`, () => ({ capturedSeq: 0, reviewedSeq: 0 }));
  const upsert = t.mock.method(store, "upsertMany");
  sessions.read.mock.restore();
  assert.equal((await captureExcerpt()).id, result.id);
  assert.equal(upsert.mock.callCount(), 0, "deleted entries remain duplicates");
  assert.equal(excerpts(f).length, 0);
  assert.equal((await capture.progress(A, session.id)).capturedSeq, capture.lastSeq(A, session.id));
});

test("an abort or source change during the excerpt lookup cannot write or advance capture progress", async (t) => {
  const f = await fixture(t);
  const { store, sessionCapture: capture } = f.owner;
  const session = boundSession(f);
  const hidden = chatTurn(f, session, "验证并发摘录不会保留已撤回内容。");
  const originalRead = store.withAsyncReadView.bind(store);
  const upsert = t.mock.method(store, "upsertMany");
  let change;
  t.mock.method(store, "withAsyncReadView", async (...args) => {
    const result = await originalRead(...args);
    // Explicitly cross the worker boundary before returning its lookup to capture.
    change();
    return result;
  });
  const stop = new AbortController();
  const aborted = new Error("stop the isolated capture");
  change = () => stop.abort(aborted);
  await assert.rejects(capture.capture(A, session.id, { reason: "nightly", signal: stop.signal }),
    error => error === aborted);
  assert.equal((await capture.progress(A, session.id)).capturedSeq, 0);

  change = () => chatTurn(f, session, "读取期间会话来源发生了变化。");
  await assert.rejects(capture.capture(A, session.id, { reason: "nightly" }), { code: "MEMORY_SOURCE_REVOKED" });
  assert.equal((await capture.progress(A, session.id)).capturedSeq, 0);
  assert.equal(upsert.mock.callCount(), 0);
  assert.equal(excerpts(f).length, 0);
  assert.equal((await capture.progress(A, session.id)).observedSeq ?? 0, 0);

  change = () => f.service.transcriptStore.setContextExcluded({ profileId: A, sessionId: session.id,
    eventId: hidden.id, contextExcluded: true });
  await assert.rejects(capture.capture(A, session.id, { reason: "nightly" }), { code: "MEMORY_SOURCE_REVOKED" });
  assert.equal((await capture.progress(A, session.id)).observedSeq ?? 0, 0);
  assert.equal(upsert.mock.callCount(), 0);
});

test("an unfinished turn can be captured after completion without another transcript append", async t => {
  const f = await fixture(t);
  const capture = f.owner.sessionCapture;
  const session = boundSession(f);
  const finished = chatTurn(f, session, "已完成的第一条。");
  const pending = f.turn("稍后完成的第二条。", session);
  const first = await capture.capture(A, session.id, { reason: "nightly" });
  assert.equal(first.written, 1);
  assert.equal((await capture.progress(A, session.id)).observedSeq, finished.seq);
  assert.doesNotMatch(dailyNotes(f), /稍后完成/u);

  await f.finish(pending);
  assert.equal(capture.lastSeq(A, session.id), pending.event.seq);
  assert.deepEqual(await capture.captureProfile(A, { reason: "nightly", idleMs: 0 }), { written: 1 });
  assert.equal((await capture.progress(A, session.id)).observedSeq, pending.event.seq);
  assert.match(dailyNotes(f), /稍后完成/u);
});

test("a memory expiry during excerpt selection fences the old tape without advancing progress", async t => {
  const f = await fixture(t);
  const capture = f.owner.sessionCapture;
  const session = boundSession(f);
  const pending = f.turn("山顶的灯塔今天开放。", session);
  await f.finish(pending);
  t.mock.method(f.service.conversationRecallService.historicalMemory, "now", f.now);
  await f.owner.propose({ profileId: A, scope: "agent", content: "山顶的灯塔今天开放。", classification: "explicit",
    sourceRefs: [pending.event.id, pending.run.id], validUntil: f.now() + 1000, type: "temporary" });
  const originalRead = f.owner.withAsyncMemoryReadView.bind(f.owner);
  const scan = t.mock.method(f.owner, "withAsyncMemoryReadView", async (...args) => {
    const value = await originalRead(...args);
    f.advance(1001);
    return value;
  });
  await assert.rejects(capture.capture(A, session.id, { reason: "nightly" }), { code: "MEMORY_SOURCE_REVOKED" });
  assert.equal((await capture.progress(A, session.id)).observedSeq ?? 0, 0);
  assert.equal(excerpts(f).length, 0);
  scan.mock.restore();
  assert.equal((await capture.capture(A, session.id, { reason: "nightly" })).written, 0);
  assert.equal((await capture.progress(A, session.id)).observedSeq, pending.event.seq);
});

test("a concurrent excerpt writer cannot be overwritten after a fresh lookup", async (t) => {
  const f = await fixture(t);
  const { store, sessionCapture: capture } = f.owner;
  const session = boundSession(f);
  chatTurn(f, session, "这是会话摘录的测试消息。");
  // Test the writer CAS independently from the session fence, which normally
  // also sees this competing memory write through the recall revision.
  const sessions = f.owner.host(A).sessions;
  t.mock.method(sessions, "stamp", () => "unchanged-session-authority");
  const upsert = store.upsertMany.bind(store);
  const concurrentContent = "另一位写入者已经保存了相同来源的摘录。";
  const intercept = t.mock.method(store, "upsertMany", async (items, options) => {
    await upsert(items.map(item => ({ ...item, content: concurrentContent })));
    return upsert(items, options);
  });
  await assert.rejects(capture.capture(A, session.id, { reason: "nightly" }), { code: "MEMORY_REVISION_CONFLICT" });
  assert.equal((await capture.progress(A, session.id)).capturedSeq, 0);
  assert.equal(excerpts(f)[0].content, concurrentContent);
  intercept.mock.restore();
  await capture.capture(A, session.id, { reason: "nightly" });
  assert.equal(excerpts(f)[0].content, concurrentContent);
  assert.equal((await capture.progress(A, session.id)).capturedSeq, capture.lastSeq(A, session.id));
});

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
