"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ConversationRecallIndex } = require("../app/agent-service/conversation-recall-index");
const { ConversationRecallService } = require("../app/agent-service/conversation-recall-service");
const { openDatabase } = require("../app/agent-service/inspiration-database");
const { validateMemoryMcpArguments } = require("../app/agent-service/memory-mcp-tools");
const { TranscriptStore } = require("../app/agent-service/transcript-store");

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const KEY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const KEY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function readySearch(service, input) {
  let result = service.search(input);
  if (result.status === "rebuilding") {
    await service.whenIndexReady(input.profileId);
    result = service.search(input);
  }
  assert.equal(result.status, "ready");
  return result;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-recall-"));
  fs.mkdirSync(path.join(root, "agents"), { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = { trustedRoot: root, agentsDir: path.join(root, "agents") };
  const sessions = [
    { id: SESSION_A, sessionKey: KEY_A, profileId: "agent-a", workspace: "/workspace-a", status: "ready" },
    { id: SESSION_B, sessionKey: KEY_B, profileId: "agent-a", workspace: "/workspace-a", status: "ready" },
  ];
  const events = new Map([[SESSION_A, []], [SESSION_B, []]]);
  const revisions = new Map([[SESSION_A, 0], [SESSION_B, 0]]);
  const runs = new Map();
  const revoked = new Set();
  const origins = new Map();
  const memoryItems = new Map();
  const memoryReasons = new Map();
  const stats = { fullReads: 0, pageReads: 0 };
  let policyRevision = 0;
  let historicalVisibilityRevision = null;
  let additionalVisibility = () => true;
  let memoryRevision = 0;
  let now = 2000;
  const sessionStore = {
    listSessions: () => structuredClone(sessions),
    getSession: (key) => structuredClone(sessions.find((item) => item.sessionKey === key) || null),
    getCronSessionOrigin: () => null,
  };
  const transcriptStore = {
    listEvents: (_profileId, sessionId) => {
      stats.fullReads += 1;
      return structuredClone(events.get(sessionId) || []);
    },
    listEventsPage: (_profileId, sessionId, afterSeq, limit) => {
      stats.pageReads += 1;
      return structuredClone((events.get(sessionId) || []).slice(afterSeq, afterSeq + limit));
    },
    getLastEventSeq: (_profileId, sessionId) => (events.get(sessionId) || []).length,
    getEvent: (_profileId, sessionId, eventId) => structuredClone(
      (events.get(sessionId) || []).find((event) => event.id === eventId) || null),
    hasUserEventForRun: (_profileId, sessionId, runId) => (events.get(sessionId) || [])
      .some((event) => event.runId === runId && event.kind === "user"
        && !event.contextExcluded && typeof event.content?.text === "string"),
    listEventWindow: (_profileId, sessionId, eventId, radius) => {
      const list = events.get(sessionId) || [];
      const index = list.findIndex((event) => event.id === eventId);
      return index < 0 ? null : structuredClone(list.slice(Math.max(0, index - radius),
        index + radius + 1));
    },
    getRevision: (_profileId, sessionId) => revisions.get(sessionId) || 0,
    contextEvent: (_profileId, _sessionId, event) => event,
  };
  const policy = {
    assertReady(profileId) { if (profileId === "blocked") throw Error("policy unavailable"); },
    getRevision() { return policyRevision; },
    getHistoricalVisibilityRevision() { return historicalVisibilityRevision ?? policyRevision; },
    getMemoryReason(_profileId, item) { return memoryReasons.get(item.id) || null; },
    isEventVisible(_profileId, event) {
      const suppressedRuns = new Set([...events.values()].flat()
        .filter((item) => revoked.has(item.id)).map((item) => item.runId));
      return !revoked.has(event.id) && !revoked.has(event.runId)
        && !suppressedRuns.has(event.runId) && additionalVisibility(event);
    },
  };
  const memoryStore = {
    getRevision: () => memoryRevision,
    list: () => structuredClone([...memoryItems.values()]),
  };
  const service = new ConversationRecallService({ paths, transcriptStore, chatSessionStore: sessionStore,
    workDispatcher: { getRun: (id) => structuredClone(runs.get(id) || null) },
    getRunSessionKey: (run) => run.source === "chat" ? run.sourceId : origins.get(run.id)?.sessionKey,
    getInspirationOrigin: (run) => structuredClone(origins.get(run.id) || null), recallPolicy: policy,
    memoryStore, now: () => now });
  t.after(() => service.close());
  const addRun = (id, key = KEY_A, source = "chat", options = {}) => {
    const run = { id, profileId: options.profileId || "agent-a", workspace: options.workspace || "/workspace-a",
      source, sourceId: source === "chat" ? key : (options.ideaId || "idea-1"),
      idempotencyKey: options.idempotencyKey || `${source}:${id}` };
    runs.set(id, run);
    if (source === "inspiration") origins.set(id, { runId: id, profileId: run.profileId,
      workspace: run.workspace, ideaId: run.sourceId, sessionKey: key,
      inputSource: options.inputSource });
    return run;
  };
  const addEvent = (sessionId, runId, kind, text, options = {}) => {
    const list = events.get(sessionId);
    const event = { id: options.id || `event-${sessionId.slice(0, 2)}-${list.length + 1}`,
      sessionId, runId, seq: list.length + 1, kind, content: { text },
      contextExcluded: options.contextExcluded || false, occurredAt: 1000 + list.length };
    list.push(event); revisions.set(sessionId, (revisions.get(sessionId) || 0) + 1);
    return event;
  };
  return { service, paths, sessions, events, revisions, revoked, stats,
    addRun, addEvent, bumpPolicy: () => { policyRevision += 1; },
    setHistoricalVisibilityRevision: (value) => { historicalVisibilityRevision = value; },
    setAdditionalVisibility: (value) => { additionalVisibility = value; },
    addMemory: (item, reason = null) => {
      memoryItems.set(item.id, { profileId: "agent-a", validUntil: null, ...item });
      if (reason) memoryReasons.set(item.id, reason);
      memoryRevision += 1;
    },
    setNow: (value) => { now = value; } };
}

function storedFixture(t) {
  const f = fixture(t);
  const transcripts = new TranscriptStore({ paths: f.paths, assertSecretSafe: () => true });
  transcripts.open();
  for (const sessionId of [SESSION_A, SESSION_B]) {
    transcripts.ensureSession({ profileId: "agent-a", sessionId });
  }
  f.service.transcripts = transcripts;
  t.after(() => transcripts.close());
  const append = (sessionId, runId, id, kind, content, contextContent) => transcripts.appendEvent({
    profileId: "agent-a", sessionId, runId, id, kind, content,
    ...(contextContent === undefined ? {} : { contextContent }),
  });
  return { ...f, transcripts, append };
}

test("tool schema admits bounded direct conversation search/get only", () => {
  const source = { source: "chat", sourceId: KEY_A };
  assert.equal(validateMemoryMcpArguments("conversation_search", { ...source, query: "上海" }), true);
  assert.equal(validateMemoryMcpArguments("conversation_search", { ...source, query: "上海", limit: 11 }), false);
  assert.equal(validateMemoryMcpArguments("conversation_get", { ...source, sessionId: SESSION_A,
    eventId: "event-1", window: 3 }), true);
  assert.equal(validateMemoryMcpArguments("conversation_get", { ...source, sessionId: SESSION_A,
    eventId: "event-1", window: 4 }), false);
});

test("TranscriptStore exact event and window reads preserve context exclusion", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-recall-transcript-"));
  fs.mkdirSync(path.join(root, "agents"), { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new TranscriptStore({ paths: { trustedRoot: root,
    agentsDir: path.join(root, "agents") }, assertSecretSafe: () => true });
  store.open(); t.after(() => store.close());
  store.ensureSession({ profileId: "agent-a", sessionId: SESSION_A });
  const beforeAppend = store.getChangeRevision("agent-a");
  store.appendEvent({ profileId: "agent-a", sessionId: SESSION_A, id: "first", runId: "run-a",
    kind: "user", content: { text: "旧会话原话" } });
  store.appendEvent({ profileId: "agent-a", sessionId: SESSION_A, id: "second", runId: "run-a",
    kind: "assistant", content: { text: "助手回显" } });
  store.appendEvent({ profileId: "agent-a", sessionId: SESSION_A, id: "third", runId: "run-b",
    kind: "user", content: { text: "下一轮原话" } });
  assert.equal(store.getChangeRevision("agent-a"), beforeAppend + 3);
  assert.equal(store.getEvent("agent-a", SESSION_A, "first").content.text, "旧会话原话");
  assert.equal(store.hasUserEventForRun("agent-a", SESSION_A, "run-a"), true);
  assert.deepEqual(store.listEventWindow("agent-a", SESSION_A, "second", 1).map((item) => item.id),
    ["first", "second", "third"]);
  assert.deepEqual(store.listEventsPage("agent-a", SESSION_A, 1, 1).map((item) => item.id),
    ["second"]);
  assert.equal(store.getLastEventSeq("agent-a", SESSION_A), 3);
  store.setContextExcluded({ profileId: "agent-a", sessionId: SESSION_A,
    eventId: "first", contextExcluded: true });
  assert.equal(store.getChangeRevision("agent-a"), beforeAppend + 4);
  assert.equal(store.hasUserEventForRun("agent-a", SESSION_A, "run-a"), false);
  assert.equal(store.hasUserEventForRun("agent-a", SESSION_A, "run-b"), true);
  assert.equal(store.getEvent("agent-a", SESSION_A, "first").contextExcluded, true);
  store.close(); store.open();
  assert.equal(store.hasUserEventForRun("agent-a", SESSION_A, "run-a"), false);
  store.setContextExcluded({ profileId: "agent-a", sessionId: SESSION_A,
    eventId: "first", contextExcluded: false });
  assert.equal(store.hasUserEventForRun("agent-a", SESSION_A, "run-a"), true);
});

test("conversation visibility revision changes on source writes and session changes", (t) => {
  const f = storedFixture(t);
  let sessionRevision = 1;
  f.service.sessions.getRevision = () => sessionRevision;
  const initial = f.service.getVisibilityRevision("agent-a");
  f.append(SESSION_A, "run-old", "source-event", "user", { text: "可核原话" });
  const afterAppend = f.service.getVisibilityRevision("agent-a");
  assert.notEqual(afterAppend, initial);
  f.transcripts.setContextExcluded({ profileId: "agent-a", sessionId: SESSION_A,
    eventId: "source-event", contextExcluded: true });
  const afterExclusion = f.service.getVisibilityRevision("agent-a");
  assert.notEqual(afterExclusion, afterAppend);
  sessionRevision += 1;
  const afterSessionChange = f.service.getVisibilityRevision("agent-a");
  assert.notEqual(afterSessionChange, afterExclusion);
  f.addMemory({ id: "old-note", status: "superseded",
    sourceRefs: ["source-event", "run-old"] });
  assert.notEqual(f.service.getVisibilityRevision("agent-a"), afterSessionChange);
});

test("verified user and assistant contextRef bodies are searchable and readable", async (t) => {
  const f = storedFixture(t);
  const history = f.addRun("run-context-history", KEY_A);
  const user = f.append(SESSION_A, history.id, "context-user", "user",
    { text: "用户显示摘要" }, { text: "用户原话确认紫藤计划" });
  const assistant = f.append(SESSION_A, history.id, "context-assistant", "assistant",
    { text: "助手显示摘要" }, { text: "助手原话说明晨星编号" });
  const current = f.addRun("run-context-current", KEY_B);
  f.append(SESSION_B, current.id, "context-current", "user", { text: "查找旧会话" });
  const source = { source: "chat", sourceId: KEY_B };
  for (const [query, expected] of [["紫藤", user], ["晨星", assistant]]) {
    const found = await readySearch(f.service, { profileId: "agent-a",
      args: { ...source, query }, run: current });
    assert.deepEqual(found.results.map((item) => item.eventId), [expected.id]);
    const read = f.service.get({ profileId: "agent-a", args: { ...source,
      sessionId: SESSION_A, eventId: expected.id }, run: current });
    assert.equal(read.events[0].text, f.transcripts.contextEvent("agent-a", SESSION_A, expected).content.text);
  }
  assert.equal((await readySearch(f.service, { profileId: "agent-a",
    args: { ...source, query: "显示摘要" }, run: current })).count, 0,
  "检索只使用校验后的正文，不使用 journal 显示摘要");
});

test("retired native session remains searchable after memory-triggered renewal", async (t) => {
  const f = storedFixture(t);
  const oldRun = f.addRun("run-before-renewal", KEY_A);
  const oldEvent = f.append(SESSION_A, oldRun.id, "before-renewal", "user",
    { text: "验收代号：蓝色番茄" });
  const current = f.addRun("run-after-renewal", KEY_B);
  f.append(SESSION_B, current.id, "current-query", "user", { text: "查找原话" });
  const args = { source: "chat", sourceId: KEY_B, query: "蓝色番茄" };
  f.sessions[0].status = "draft";
  f.sessions[0].runtimeSessionId = null;
  f.sessions[0].retiredRuntimeSessions = [{ runtimeSessionId: "retired-native-thread" }];
  const found = await readySearch(f.service, { profileId: "agent-a", args, run: current });
  assert.deepEqual(found.results.map((row) => row.eventId), [oldEvent.id]);
  assert.equal(f.service.get({ profileId: "agent-a", args: { source: "chat", sourceId: KEY_B,
    sessionId: SESSION_A, eventId: oldEvent.id }, run: current }).events[0].text,
  "验收代号：蓝色番茄");
  f.sessions[0].retiredRuntimeSessions = [];
  assert.equal((await readySearch(f.service, { profileId: "agent-a", args, run: current })).count, 0,
    "从未绑定 Runtime 的 draft 不能伪装成历史会话");
});

test("运行中原始 journal 丢失后会话检索和原话定位不能沿用缓存", async (t) => {
  const f = storedFixture(t);
  const old = f.addRun("run-journal-old", KEY_A);
  const event = f.append(SESSION_A, old.id, "journal-source", "user", { text: "原话代号 ZX-783" });
  const current = f.addRun("run-journal-current", KEY_B);
  f.append(SESSION_B, current.id, "journal-current", "user", { text: "查找旧记录" });
  const source = { source: "chat", sourceId: KEY_B };
  const input = { profileId: "agent-a", args: { ...source, query: "ZX-783" }, run: current };
  const found = await readySearch(f.service, input);
  assert.deepEqual(found.results.map((row) => row.eventId), [event.id]);
  const getInput = { profileId: "agent-a", args: { ...source,
    sessionId: SESSION_A, eventId: event.id, window: 0 }, run: current };
  assert.equal(f.service.get(getInput).events[0].text, "原话代号 ZX-783");
  const log = path.join(f.paths.agentsDir, "agent-a", "transcripts", SESSION_A, "events.jsonl");
  fs.unlinkSync(log);
  assert.throws(() => f.service.search(input), (error) => error.code === "TRANSCRIPT_SOURCE_CHANGED");
  assert.throws(() => f.service.get(getInput), (error) => error.code === "TRANSCRIPT_SOURCE_CHANGED");
});

test("missing or corrupt contextRef bodies fail closed on search and each get-window event", async (t) => {
  for (const damage of ["missing", "corrupt"]) {
    const f = storedFixture(t);
    const history = f.addRun(`run-${damage}-history`, KEY_A);
    const target = f.append(SESSION_A, history.id, `context-${damage}`, "user",
      { text: "可见显示摘要" }, { text: `原话包含${damage}紫藤密语` });
    const neighborRun = f.addRun(`run-${damage}-neighbor`, KEY_A);
    const neighbor = f.append(SESSION_A, neighborRun.id, `neighbor-${damage}`, "user",
      { text: `相邻可见${damage}记录` });
    const current = f.addRun(`run-${damage}-current`, KEY_B);
    f.append(SESSION_B, current.id, `current-${damage}`, "user", { text: "查找旧会话" });
    const source = { source: "chat", sourceId: KEY_B };
    const input = { profileId: "agent-a", args: { ...source, query: "紫藤" }, run: current };
    assert.deepEqual((await readySearch(f.service, input)).results.map((item) => item.eventId), [target.id]);
    const bodyPath = path.join(f.paths.agentsDir, "agent-a", "transcripts", SESSION_A,
      "context-content", `${target.content.contextRef.hash}.json`);
    if (damage === "missing") fs.unlinkSync(bodyPath);
    else fs.writeFileSync(bodyPath, "corrupt", { mode: 0o600 });
    assert.equal((await readySearch(f.service, input)).count, 0,
      `${damage} contextRef 不得返回旧索引片段`);
    assert.throws(() => f.service.get({ profileId: "agent-a", args: { ...source,
      sessionId: SESSION_A, eventId: target.id }, run: current }),
    (error) => error.code === "CONVERSATION_EVENT_NOT_FOUND");
    const window = f.service.get({ profileId: "agent-a", args: { ...source,
      sessionId: SESSION_A, eventId: neighbor.id, window: 1 }, run: current });
    assert.deepEqual(window.events[0], { hidden: true });
    assert.equal(window.events[1].text, neighbor.content.text);
  }
});

test("attachment body never enters conversation search or get text", async (t) => {
  const f = storedFixture(t);
  const history = f.addRun("run-attachment-history", KEY_A);
  const target = f.append(SESSION_A, history.id, "attachment-user", "user",
    { text: "用户原话提到雪松项目", attachments: [{ name: "note.txt", body: "雀羽附件独有密语" }] },
    { text: "用户原话提到雪松项目", attachments: [{ name: "note.txt", body: "雀羽附件独有密语" }] });
  const current = f.addRun("run-attachment-current", KEY_B);
  f.append(SESSION_B, current.id, "attachment-current", "user", { text: "查找旧会话" });
  const source = { source: "chat", sourceId: KEY_B };
  assert.deepEqual((await readySearch(f.service, { profileId: "agent-a",
    args: { ...source, query: "雪松" }, run: current })).results.map((item) => item.eventId), [target.id]);
  assert.equal((await readySearch(f.service, { profileId: "agent-a",
    args: { ...source, query: "雀羽" }, run: current })).count, 0);
  const read = f.service.get({ profileId: "agent-a", args: { ...source,
    sessionId: SESSION_A, eventId: target.id }, run: current });
  assert.equal(read.events[0].text, "用户原话提到雪松项目");
  assert.doesNotMatch(JSON.stringify(read), /雀羽/u);
});

test("cold index reports rebuilding before two-character Chinese and exact ID lookup", async (t) => {
  const f = fixture(t);
  const old = f.addRun("run-old", KEY_A);
  f.addEvent(SESSION_A, old.id, "user", "请记住上海项目的代号 Omega-123");
  const current = f.addRun("run-current", KEY_B);
  f.addEvent(SESSION_B, current.id, "user", "帮我找以前的原话");
  const source = { source: "chat", sourceId: KEY_B };
  const input = { profileId: "agent-a", args: { ...source, query: "上海" }, run: current };
  assert.equal(f.service.search(input).status, "rebuilding");
  await f.service.whenIndexReady("agent-a");
  const two = f.service.search(input);
  assert.equal(two.results.length, 1);
  assert.equal(two.results[0].sessionId, SESSION_A);
  assert.equal(two.results[0].scoreBasis, "fts5-bigram-unicode61");
  const english = await readySearch(f.service, { profileId: "agent-a",
    args: { ...source, query: "Omega-123" }, run: current });
  assert.equal(english.results.length, 1);
  assert.match(english.results[0].snippet, /Omega-123/u);
  const read = f.service.get({ profileId: "agent-a", args: { ...source,
    sessionId: SESSION_A, eventId: two.results[0].eventId }, run: current });
  assert.equal(read.events[0].text, "请记住上海项目的代号 Omega-123");
  assert.equal(f.stats.fullReads, 0, "热检索和精读不克隆完整 transcript");
});

test("concurrent transcript append does not poison a snapshot index build", async (t) => {
  const f = fixture(t);
  const old = f.addRun("run-old", KEY_A);
  const original = f.addEvent(SESSION_A, old.id, "user", "档案原话代号 A-17");
  const current = f.addRun("run-current", KEY_B);
  f.addEvent(SESSION_B, current.id, "user", "查找档案原话");
  const input = { profileId: "agent-a", args: { source: "chat", sourceId: KEY_B,
    query: "档案", sessionId: SESSION_A }, run: current };
  const readPage = f.service.transcripts.listEventsPage;
  let appended;
  f.service.transcripts.listEventsPage = (profileId, sessionId, afterSeq, limit) => {
    if (!appended && sessionId === SESSION_A && afterSeq === 0) {
      appended = f.addEvent(SESSION_A, old.id, "assistant", "档案补充代号 B-29");
    }
    return readPage(profileId, sessionId, afterSeq, limit);
  };
  assert.equal(f.service.search(input).status, "rebuilding");
  await f.service.whenIndexReady("agent-a");
  assert.ok(appended, "the transcript changed after the index captured lastSeq");
  assert.equal(f.service.search(input).status, "rebuilding",
    "a stale snapshot must be discarded, not installed or held in a failure cooldown");
  await f.service.whenIndexReady("agent-a");
  const result = f.service.search(input);
  assert.equal(result.status, "ready");
  assert.deepEqual(new Set(result.results.map((item) => item.eventId)),
    new Set([original.id, appended.id]));
});

test("outdated versions mark the exact user source and cautiously label later assistant echoes", async (t) => {
  const f = fixture(t);
  const old = f.addRun("run-old", KEY_A);
  const mixed = f.addEvent(SESSION_A, old.id, "user",
    "旧颜色是蓝色，旧交付日在周二，收货地址是上海。");
  const assistant = f.addEvent(SESSION_A, old.id, "assistant", "蓝色和上海我都听到了。");
  const other = f.addEvent(SESSION_A, old.id, "user", "另一条仍然有效的周三会议。");
  const current = f.addRun("run-current", KEY_B);
  f.addEvent(SESSION_B, current.id, "user", "查询过去的对话");
  f.addMemory({ id: "old-color", status: "superseded", sourceRefs: [mixed.id, old.id] });
  f.addMemory({ id: "old-delivery", status: "deleted", sourceRefs: [mixed.id, old.id] }, "expired");
  f.addMemory({ id: "current-address", status: "active", sourceRefs: [mixed.id, old.id] });
  f.addMemory({ id: "different-run", status: "superseded", sourceRefs: [mixed.id, "run-elsewhere"] });
  f.addMemory({ id: "different-event", status: "superseded", sourceRefs: [other.id, old.id] });
  const source = { source: "chat", sourceId: KEY_B };
  const searchInput = { profileId: "agent-a", args: { ...source, query: "蓝色" }, run: current };
  const search = await readySearch(f.service, searchInput);
  const linked = search.results.find((row) => row.eventId === mixed.id);
  assert.deepEqual(linked.outdatedMemories.refs, [
    { id: "old-color", status: "superseded" },
    { id: "old-delivery", status: "expired" },
  ]);
  assert.match(linked.outdatedMemories.note, /Other statements.*may still be current/u);
  const echoed = search.results.find((row) => row.eventId === assistant.id);
  assert.equal(echoed.outdatedMemories, undefined, "助手回复没有逐字记忆来源绑定");
  assert.deepEqual(echoed.historicalRunNotice.refs, [
    { id: "old-color", status: "superseded", sourceEventId: mixed.id },
    { id: "old-delivery", status: "expired", sourceEventId: mixed.id },
  ], "更晚的同 Run 用户事件不能被误认为早先助手回复的来源");
  assert.equal(echoed.historicalRunNotice.kind, "possible_echo");
  assert.match(echoed.historicalRunNotice.note, /other statements may still be current/u);
  const assistantOnly = await readySearch(f.service, { profileId: "agent-a",
    args: { ...source, query: "听到了" }, run: current });
  assert.deepEqual(assistantOnly.results.map((row) => row.eventId), [assistant.id]);
  assert.deepEqual(assistantOnly.results[0].historicalRunNotice, echoed.historicalRunNotice);
  const getInput = { profileId: "agent-a", args: { ...source,
    sessionId: SESSION_A, eventId: mixed.id, window: 2 }, run: current };
  const read = f.service.get(getInput);
  assert.deepEqual(read.events[0].outdatedMemories, linked.outdatedMemories);
  assert.equal(read.events[1].outdatedMemories, undefined);
  assert.deepEqual(read.events[1].historicalRunNotice, echoed.historicalRunNotice);
  assert.deepEqual(read.events[2].outdatedMemories.refs,
    [{ id: "different-event", status: "superseded" }]);
  f.addMemory({ id: "old-color", status: "active", sourceRefs: [mixed.id, old.id] });
  assert.throws(() => f.service.assertResultCurrent({ name: "conversation_search",
    profileId: "agent-a", args: { ...source, query: "听到了" }, run: current,
    result: assistantOnly }), /会话事件已变化/u,
  "已纠正版本状态变化后不能重放助手回显的旧提示");
  assert.throws(() => f.service.assertResultCurrent({ name: "conversation_search",
    profileId: "agent-a", args: searchInput.args, run: current, result: search }), /会话事件已变化/u);
  assert.throws(() => f.service.assertResultCurrent({ name: "conversation_get",
    profileId: "agent-a", args: getInput.args, run: current, result: read }), /会话事件已变化/u);
});

test("temporary memory is marked expired as soon as validUntil passes without a store write", async (t) => {
  const f = fixture(t);
  const old = f.addRun("run-old", KEY_A);
  const event = f.addEvent(SESSION_A, old.id, "user", "周五以前使用临时代号灯塔。");
  const current = f.addRun("run-current", KEY_B);
  f.addEvent(SESSION_B, current.id, "user", "查代号");
  f.addMemory({ id: "temporary-code", status: "active", validUntil: 3000,
    sourceRefs: [event.id, old.id] });
  const input = { profileId: "agent-a", args: { source: "chat", sourceId: KEY_B,
    query: "灯塔" }, run: current };
  const before = await readySearch(f.service, input);
  assert.equal(before.results[0].outdatedMemories, undefined);
  f.setNow(3000);
  const after = await readySearch(f.service, input);
  assert.deepEqual(after.results[0].outdatedMemories.refs,
    [{ id: "temporary-code", status: "expired" }]);
  assert.throws(() => f.service.assertResultCurrent({ name: "conversation_search",
    profileId: "agent-a", args: input.args, run: current, result: before }), /会话事件已变化/u);
});

test("seven large get-window messages fit the MCP frame and still recheck hidden neighbors", async (t) => {
  const f = fixture(t);
  const historyRuns = Array.from({ length: 4 }, (_, index) => f.addRun(`run-old-${index}`, KEY_A));
  const longText = `原话 ${'a"\\\n'.repeat(3072)}`;
  const history = Array.from({ length: 7 }, (_, index) => f.addEvent(SESSION_A,
    historyRuns[Math.floor(index / 2)].id,
    index % 2 === 0 ? "user" : "assistant", `${index}: ${longText}`));
  for (const event of history.filter((row) => row.kind === "user")) {
    for (let index = 0; index < 9; index += 1) {
      f.addMemory({ id: `${event.id}-${index}-${"x".repeat(220)}`, status: "superseded",
        sourceRefs: [event.id, event.runId] });
    }
  }
  const current = f.addRun("run-current", KEY_B);
  f.addEvent(SESSION_B, current.id, "user", "读长窗口");
  const searched = await readySearch(f.service, { profileId: "agent-a",
    args: { source: "chat", sourceId: KEY_B, query: "原话", limit: 10 }, run: current });
  assert.equal(searched.results.length, 7);
  assert.equal(searched.results.find((event) => event.eventId === history[1].id)
    .historicalRunNotice.total, 9,
  "助手同 Run 提示应在检索结果中保留，并按单事件上限裁剪引用");
  assert.equal(searched.results.find((event) => event.eventId === history[1].id)
    .historicalRunNotice.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify({ id: "\0".repeat(256), ok: true,
    result: searched }), "utf8") < 64 * 1024, "检索结果及过时标记需在 MCP 帧上限内");
  const input = { profileId: "agent-a", args: { source: "chat", sourceId: KEY_B,
    sessionId: SESSION_A, eventId: history[3].id, window: 3 }, run: current };
  const read = f.service.get(input);
  assert.equal(read.events.length, 7);
  assert.equal(read.events[0].outdatedMemories.refs.length, 8);
  assert.equal(read.events[0].outdatedMemories.total, 9);
  assert.equal(read.events[0].outdatedMemories.truncated, true);
  assert.equal(read.events[1].outdatedMemories, undefined);
  assert.equal(read.events[1].historicalRunNotice.refs.length, 8);
  assert.equal(read.events[1].historicalRunNotice.total, 9);
  assert.equal(read.events[3].text, history[3].content.text, "目标事件优先保留完整内容");
  assert.ok(read.events.some((event) => event.truncated), "超出总预算的邻近事件应标明截断");
  const frame = JSON.stringify({ id: "\0".repeat(256), ok: true, result: read });
  assert.ok(Buffer.byteLength(JSON.stringify(read), "utf8") <= 48 * 1024,
    "精读结果及过时标记需保留工具响应余量");
  assert.ok(Buffer.byteLength(frame, "utf8") < 64 * 1024, "完整响应需留在 MCP 帧上限内");
  f.revoked.add(history[0].id);
  const checked = f.service.get(input);
  assert.deepEqual(checked.events[0], { hidden: true });
  assert.deepEqual(checked.events[1], { hidden: true });
  assert.equal(checked.events[3].text, history[3].content.text);
});

test("revocation, context exclusion, workspace changes and neighboring windows fail closed", async (t) => {
  const f = fixture(t);
  const old = f.addRun("run-old", KEY_A);
  const first = f.addEvent(SESSION_A, old.id, "user", "hidden Alpha data");
  f.addEvent(SESSION_A, old.id, "assistant", "hidden Alpha echo");
  const another = f.addRun("run-another", KEY_A);
  const second = f.addEvent(SESSION_A, another.id, "user", "visible Alpha note");
  const current = f.addRun("run-current", KEY_B);
  f.addEvent(SESSION_B, current.id, "user", "find Alpha");
  const source = { source: "chat", sourceId: KEY_B };
  assert.equal((await readySearch(f.service, { profileId: "agent-a",
    args: { ...source, query: "hidden" }, run: current })).count, 2);
  f.revoked.add(first.id); f.bumpPolicy();
  f.service.refreshProfile("agent-a");
  assert.equal(fs.existsSync(path.join(f.paths.agentsDir, "agent-a", "conversation-recall.sqlite")), false);
  assert.deepEqual((await readySearch(f.service, { profileId: "agent-a",
    args: { ...source, query: "hidden" }, run: current })).results, []);
  assert.equal(f.service.scanEligibleSession({ profileId: "agent-a", sessionId: SESSION_A })
    .events.some((event) => event.runId === old.id), false);
  const read = f.service.get({ profileId: "agent-a", args: { ...source,
    sessionId: SESSION_A, eventId: second.id, window: 2 }, run: current });
  assert.deepEqual(read.events[0], { hidden: true });
  assert.deepEqual(read.events[1], { hidden: true });
  assert.equal(read.events[2].text, "visible Alpha note");
  f.sessions[0].workspace = "/other";
  assert.deepEqual((await readySearch(f.service, { profileId: "agent-a",
    args: { ...source, query: "visible" }, run: current })).results, []);
  assert.throws(() => f.service.get({ profileId: "agent-a", args: { ...source,
    sessionId: SESSION_A, eventId: second.id }, run: current }), /不可检索/u);
});

test("unproven Inspiration and federation runs are excluded; direct Inspiration chat is included", async (t) => {
  const f = fixture(t);
  const growth = f.addRun("run-growth", KEY_A, "inspiration", { ideaId: "idea-growth" });
  f.addEvent(SESSION_A, growth.id, "user", "growth-only idea text");
  const direct = f.addRun("run-direct", KEY_A, "inspiration", { ideaId: "idea-direct", inputSource: "chat" });
  const original = f.addEvent(SESSION_A, direct.id, "user", "direct inspiration 紫色项目");
  const federated = f.addRun("run-fed", KEY_A, "chat", {
    idempotencyKey: "shoggoth:chat-send:federation-send-test" });
  f.addEvent(SESSION_A, federated.id, "user", "federated secret idea");
  const current = f.addRun("run-current", KEY_B);
  f.addEvent(SESSION_B, current.id, "user", "find inspiration");
  const source = { source: "chat", sourceId: KEY_B };
  assert.deepEqual((await readySearch(f.service, { profileId: "agent-a", args: { ...source,
    query: "growth-only" }, run: current })).results, []);
  assert.deepEqual((await readySearch(f.service, { profileId: "agent-a", args: { ...source,
    query: "federated" }, run: current })).results, []);
  const matches = await readySearch(f.service, { profileId: "agent-a", args: { ...source,
    query: "紫色" }, run: current });
  assert.equal(matches.results[0].eventId, original.id);
  assert.deepEqual(f.service.scanEligibleSession({ profileId: "agent-a", sessionId: SESSION_A })
    .events.map((event) => event.eventId), [original.id]);
});

test("eligible background scan pages by event seq without cloning the full transcript", (t) => {
  const f = fixture(t);
  const first = f.addRun("run-first", KEY_A);
  const firstUser = f.addEvent(SESSION_A, first.id, "user", "第一条原话");
  const firstAnswer = f.addEvent(SESSION_A, first.id, "assistant", "第一条回复");
  const hidden = f.addRun("run-hidden", KEY_A);
  f.addEvent(SESSION_A, hidden.id, "user", "隐藏原话", { contextExcluded: true });
  f.addEvent(SESSION_A, first.id, "tool_result", "工具私有结果");
  const last = f.addRun("run-last", KEY_A);
  const lastUser = f.addEvent(SESSION_A, last.id, "user", "最后一条原话");
  const firstPage = f.service.scanEligibleSession({ profileId: "agent-a", sessionId: SESSION_A,
    afterSeq: 0, limit: 2 });
  assert.deepEqual(firstPage.events.map((event) => event.eventId), [firstUser.id, firstAnswer.id]);
  assert.equal(firstPage.throughSeq, 2);
  assert.equal(firstPage.hasMore, true);
  const secondPage = f.service.scanEligibleSession({ profileId: "agent-a", sessionId: SESSION_A,
    afterSeq: firstPage.throughSeq, limit: 2 });
  assert.deepEqual(secondPage.events, []);
  assert.equal(secondPage.throughSeq, 4);
  assert.equal(secondPage.hasMore, true);
  const thirdPage = f.service.scanEligibleSession({ profileId: "agent-a", sessionId: SESSION_A,
    afterSeq: secondPage.throughSeq, limit: 2 });
  assert.deepEqual(thirdPage.events.map((event) => event.eventId), [lastUser.id]);
  assert.equal(thirdPage.hasMore, false);
  assert.equal(f.stats.fullReads, 0);
  assert.equal(f.stats.pageReads, 3);
});

test("index rebuild never serves stale text after transcript revision changes", async (t) => {
  const f = fixture(t);
  const old = f.addRun("run-old", KEY_A);
  const record = f.addEvent(SESSION_A, old.id, "user", "旧记录 北京");
  const current = f.addRun("run-current", KEY_B);
  f.addEvent(SESSION_B, current.id, "user", "找北京");
  const source = { source: "chat", sourceId: KEY_B };
  assert.equal((await readySearch(f.service, { profileId: "agent-a",
    args: { ...source, query: "北京" }, run: current })).count, 1);
  record.contextExcluded = true;
  f.revisions.set(SESSION_A, f.revisions.get(SESSION_A) + 1);
  assert.equal((await readySearch(f.service, { profileId: "agent-a",
    args: { ...source, query: "北京" }, run: current })).count, 0);
});

test("a committed renewal reaches search without a transcript append; a denial stays hidden", async (t) => {
  const f = fixture(t);
  const deniedRun = f.addRun("run-denied", KEY_A);
  const denied = f.addEvent(SESSION_A, deniedRun.id, "user", "别再记住蓝色番茄计划");
  const renewedRun = f.addRun("run-renewed", KEY_A);
  const renewed = f.addEvent(SESSION_A, renewedRun.id, "user", "请记住蓝色番茄计划");
  const current = f.addRun("run-current", KEY_B);
  f.addEvent(SESSION_B, current.id, "user", "查找蓝色番茄计划");
  let committedRenewal = false;
  f.setAdditionalVisibility((event) => event.id !== denied.id
    && (event.id !== renewed.id || committedRenewal));
  f.setHistoricalVisibilityRevision(`2:${"a".repeat(64)}`);
  const source = { source: "chat", sourceId: KEY_B };
  const input = { profileId: "agent-a", args: { ...source, query: "蓝色番茄计划" }, run: current };
  assert.deepEqual((await readySearch(f.service, input)).results, []);
  assert.throws(() => f.service.get({ profileId: "agent-a", args: { ...source,
    sessionId: SESSION_A, eventId: denied.id }, run: current }),
  (error) => error.code === "CONVERSATION_EVENT_NOT_FOUND");
  committedRenewal = true;
  f.setHistoricalVisibilityRevision(`2:${"b".repeat(64)}`);
  assert.equal(f.service.search(input).status, "rebuilding");
  const found = await readySearch(f.service, input);
  assert.deepEqual(found.results.map((row) => row.eventId), [renewed.id]);
  f.addMemory({ id: "unrelated", status: "active", sourceRefs: ["other-event", "other-run"] });
  assert.equal(f.service.search(input).status, "ready",
    "an unrelated memory revision must not rebuild historical FTS");
  assert.throws(() => f.service.get({ profileId: "agent-a", args: { ...source,
    sessionId: SESSION_A, eventId: denied.id }, run: current }),
  (error) => error.code === "CONVERSATION_EVENT_NOT_FOUND");
});

test("interrupted and corrupt derived indexes rebuild without returning stale snippets", async (t) => {
  const f = fixture(t);
  const old = f.addRun("run-old", KEY_A);
  f.addEvent(SESSION_A, old.id, "user", "档案代号 ZX-901");
  const current = f.addRun("run-current", KEY_B);
  f.addEvent(SESSION_B, current.id, "user", "找档案");
  const input = { profileId: "agent-a", args: { source: "chat", sourceId: KEY_B,
    query: "ZX-901" }, run: current };
  const file = path.join(f.paths.agentsDir, "agent-a", "conversation-recall.sqlite");
  assert.equal(f.service.search(input).status, "rebuilding");
  const interrupted = f.service.whenIndexReady("agent-a");
  f.service.refreshProfile("agent-a");
  await interrupted;
  assert.equal(fs.existsSync(file), false);
  assert.equal((await readySearch(f.service, input)).results.length, 1);
  f.service.index.forgetProfile("agent-a");
  fs.writeFileSync(file, "corrupt derived index", { mode: 0o600 });
  assert.equal(f.service.search(input).status, "rebuilding");
  assert.equal((await readySearch(f.service, input)).results[0].eventId, "event-11-1");
});

test("missing FTS5 postings rebuild even when SQLite integrity_check is ok", async (t) => {
  const f = fixture(t);
  const old = f.addRun("run-old", KEY_A);
  const event = f.addEvent(SESSION_A, old.id, "user", "上海项目原话");
  const current = f.addRun("run-current", KEY_B);
  f.addEvent(SESSION_B, current.id, "user", "找以前的记录");
  const input = { profileId: "agent-a", args: { source: "chat", sourceId: KEY_B,
    query: "上海" }, run: current };
  assert.equal((await readySearch(f.service, input)).results[0].eventId, event.id);
  const file = path.join(f.paths.agentsDir, "agent-a", "conversation-recall.sqlite");
  f.service.index.forgetProfile("agent-a");
  const db = openDatabase(file);
  try {
    const row = db.prepare("SELECT id,search_terms FROM events WHERE event_id=?").get(event.id);
    db.prepare("INSERT INTO events_fts(events_fts,rowid,search_terms) VALUES('delete',?,?)")
      .run(row.id, row.search_terms);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { db.close(); }
  assert.equal(f.service.search(input).status, "rebuilding");
  assert.equal((await readySearch(f.service, input)).results[0].eventId, event.id);
});

test("an open index notices external SQLite posting changes before search", async (t) => {
  const f = fixture(t);
  const old = f.addRun("run-old", KEY_A);
  const event = f.addEvent(SESSION_A, old.id, "user", "绿色档案原话");
  const current = f.addRun("run-current", KEY_B);
  f.addEvent(SESSION_B, current.id, "user", "找以前的记录");
  const input = { profileId: "agent-a", args: { source: "chat", sourceId: KEY_B,
    query: "绿色" }, run: current };
  assert.equal((await readySearch(f.service, input)).count, 1);
  const file = path.join(f.paths.agentsDir, "agent-a", "conversation-recall.sqlite");
  const db = openDatabase(file);
  try {
    const row = db.prepare("SELECT id,search_terms FROM events WHERE event_id=?").get(event.id);
    db.prepare("INSERT INTO events_fts(events_fts,rowid,search_terms) VALUES('delete',?,?)")
      .run(row.id, row.search_terms);
  } finally { db.close(); }
  assert.equal(f.service.search(input).status, "rebuilding");
  assert.equal((await readySearch(f.service, input)).results[0].eventId, event.id);
});

test("an open index rejects broadened private file permissions", async (t) => {
  const f = fixture(t);
  const session = { ...f.sessions[0], revision: 1, lastSeq: 1 };
  for (const [number, suffix] of ["", "-wal", "-shm", "-journal"].entries()) {
    const profileId = `agent-private-${number}`;
    const index = new ConversationRecallIndex({ paths: f.paths });
    t.after(() => index.close());
    const page = () => ({ rows: [], throughSeq: 1 });
    assert.equal(index.ensure(profileId, [session], 0, page, () => true), "rebuilding");
    await index.whenReady(profileId);
    const file = path.join(f.paths.agentsDir, profileId, "conversation-recall.sqlite");
    const target = file + suffix;
    if (!fs.existsSync(target)) fs.writeFileSync(target, "", { mode: 0o600 });
    fs.chmodSync(target, 0o644);
    assert.throws(() => index.ensure(profileId, [session], 0, page, () => true),
      (error) => error.code === "CONVERSATION_INDEX_UNAVAILABLE", `suffix ${suffix || "main"}`);
    assert.equal(index.connections.has(profileId), false,
      `an unsafe ${suffix || "main"} file must close its SQLite connection`);
  }
});

test("an open index rebuilds after the SQLite main file is atomically replaced", async (t) => {
  const f = fixture(t);
  const index = new ConversationRecallIndex({ paths: f.paths });
  t.after(() => index.close());
  const session = { ...f.sessions[0], revision: 1, lastSeq: 1 };
  const page = () => ({ rows: [], throughSeq: 1 });
  assert.equal(index.ensure("agent-a", [session], 0, page, () => true), "rebuilding");
  await index.whenReady("agent-a");
  assert.equal(index.ensure("agent-a", [session], 0, page, () => true), "ready");
  const file = path.join(f.paths.agentsDir, "agent-a", "conversation-recall.sqlite");
  const oldInode = fs.statSync(file).ino;
  const replacement = `${file}.replacement`;
  fs.copyFileSync(file, replacement, fs.constants.COPYFILE_EXCL);
  fs.renameSync(replacement, file);
  assert.notEqual(fs.statSync(file).ino, oldInode);
  assert.equal(index.ensure("agent-a", [session], 0, page, () => true), "rebuilding",
    "data_version alone cannot detect a file replaced under an open SQLite handle");
  await index.whenReady("agent-a");
  assert.equal(index.ensure("agent-a", [session], 0, page, () => true), "ready");
});

test("a failed MATCH closes the damaged handle and rebuilds on the next search", async (t) => {
  const f = fixture(t);
  const old = f.addRun("run-old", KEY_A);
  const event = f.addEvent(SESSION_A, old.id, "user", "紫色档案原话");
  const current = f.addRun("run-current", KEY_B);
  f.addEvent(SESSION_B, current.id, "user", "找以前的记录");
  const input = { profileId: "agent-a", args: { source: "chat", sourceId: KEY_B,
    query: "紫色" }, run: current };
  assert.equal((await readySearch(f.service, input)).count, 1);
  f.service.index.connections.get("agent-a").exec("DROP TABLE events_fts");
  assert.throws(() => f.service.search(input),
    (error) => error.code === "CONVERSATION_INDEX_UNAVAILABLE");
  assert.equal(f.service.search(input).status, "rebuilding");
  assert.equal((await readySearch(f.service, input)).results[0].eventId, event.id);
});

test("transcript digest permits normal append but rebuilds same-counter and overwritten-prefix restores", async (t) => {
  const f = storedFixture(t);
  const old = f.addRun("run-old", KEY_A);
  const current = f.addRun("run-current", KEY_B);
  f.append(SESSION_A, old.id, "old-user", "user", { text: "初始蓝色项目" });
  f.append(SESSION_B, current.id, "current-user", "user", { text: "找旧会话" });
  const input = (query) => ({ profileId: "agent-a", args: { source: "chat",
    sourceId: KEY_B, query }, run: current });
  assert.equal((await readySearch(f.service, input("蓝色"))).count, 1);
  const initial = f.transcripts.getIndexSnapshot("agent-a", SESSION_A);
  f.append(SESSION_A, old.id, "old-assistant", "assistant", { text: "补充普通追加" });
  const appended = f.transcripts.getIndexSnapshot("agent-a", SESSION_A);
  assert.notEqual(appended.sourceIdentity, initial.sourceIdentity);
  assert.equal(f.transcripts.getIndexPrefixDigest("agent-a", SESSION_A, initial.revision),
    initial.sourceIdentity);
  assert.equal(f.service.search(input("普通追加")).status, "ready",
    "an ordinary append keeps the fast path");

  const originalDir = path.join(f.paths.agentsDir, "agent-a", "transcripts", SESSION_A);
  const originalLog = path.join(originalDir, "events.jsonl");
  const originalManifest = path.join(originalDir, "manifest.json");
  const originalInode = fs.statSync(originalLog).ino;
  const overwrite = (texts) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-restored-transcript-"));
    const paths = { trustedRoot: root, agentsDir: path.join(root, "agents") };
    const restored = new TranscriptStore({ paths, assertSecretSafe: () => true });
    try {
      restored.open();
      restored.ensureSession({ profileId: "agent-a", sessionId: SESSION_A });
      restored.appendEvent({ profileId: "agent-a", sessionId: SESSION_A,
        id: "old-user", runId: old.id, kind: "user", content: { text: texts[0] } });
      if (texts[1]) restored.appendEvent({ profileId: "agent-a", sessionId: SESSION_A,
        id: "old-assistant", runId: old.id, kind: "assistant", content: { text: texts[1] } });
      if (texts[2]) restored.appendEvent({ profileId: "agent-a", sessionId: SESSION_A,
        id: "new-assistant", runId: old.id, kind: "assistant", content: { text: texts[2] } });
      restored.close();
      const restoredDir = path.join(paths.agentsDir, "agent-a", "transcripts", SESSION_A);
      f.transcripts.close();
      fs.writeFileSync(originalLog, fs.readFileSync(path.join(restoredDir, "events.jsonl")));
      fs.writeFileSync(originalManifest, fs.readFileSync(path.join(restoredDir, "manifest.json")));
      assert.equal(fs.statSync(originalLog).ino, originalInode,
        "the restore deliberately overwrites the same journal inode");
      f.transcripts.open();
    } finally {
      restored.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  overwrite(["恢复红色项目", "补充普通追加"]);
  assert.equal(f.transcripts.getIndexSnapshot("agent-a", SESSION_A).revision, appended.revision,
    "the first restore keeps revision and lastSeq unchanged");
  assert.equal(f.service.search(input("红色")).status, "rebuilding");
  assert.equal((await readySearch(f.service, input("红色"))).count, 1);
  assert.equal((await readySearch(f.service, input("蓝色"))).count, 0);

  overwrite(["恢复绿色项目", "补充普通追加", "追加新证据"]);
  assert.equal(f.transcripts.getIndexSnapshot("agent-a", SESSION_A).revision, appended.revision + 1);
  assert.equal(f.service.search(input("绿色")).status, "rebuilding",
    "a restore followed by an append cannot reuse the old index prefix");
  assert.equal((await readySearch(f.service, input("绿色"))).count, 1);
  assert.equal((await readySearch(f.service, input("红色"))).count, 0);
});

test("failed background build reports unavailable and restart removes orphan plaintext files", async (t) => {
  const f = fixture(t);
  const session = { ...f.sessions[0], revision: 1, lastSeq: 1 };
  const index = new ConversationRecallIndex({ paths: f.paths });
  t.after(() => index.close());
  assert.equal(index.ensure("agent-a", [session], 0, () => { throw new Error("injected read failure"); },
    () => true), "rebuilding");
  await assert.rejects(index.whenReady("agent-a"), (error) => error.code === "CONVERSATION_INDEX_UNAVAILABLE");
  assert.throws(() => index.ensure("agent-a", [session], 0, () => ({ rows: [], throughSeq: 1 }),
    () => true), (error) => error.code === "CONVERSATION_INDEX_UNAVAILABLE");
  index.close();
  const orphan = path.join(f.paths.agentsDir, "agent-a",
    "conversation-recall.sqlite.building-2147483647-0123456789abcdef");
  fs.writeFileSync(orphan, "private previous build", { mode: 0o600 });
  const restarted = new ConversationRecallIndex({ paths: f.paths });
  t.after(() => restarted.close());
  assert.equal(restarted.ensure("agent-a", [session], 0,
    () => ({ rows: [], throughSeq: 1 }), () => true), "rebuilding");
  assert.equal(fs.existsSync(orphan), false);
  await restarted.whenReady("agent-a");
  assert.equal(restarted.ensure("agent-a", [session], 0,
    () => ({ rows: [], throughSeq: 1 }), () => true), "ready");
});

test("concurrent index instances preserve one another's active build files", async (t) => {
  const f = fixture(t);
  const first = new ConversationRecallIndex({ paths: f.paths });
  const second = new ConversationRecallIndex({ paths: f.paths });
  t.after(() => { first.close(); second.close(); });
  const session = { ...f.sessions[0], revision: 1, lastSeq: 1 };
  const dir = path.join(f.paths.agentsDir, "agent-a");
  let firstTemp;
  assert.equal(first.ensure("agent-a", [session], 0, () => {
    firstTemp = path.join(dir, fs.readdirSync(dir).find((name) => (
      name.startsWith("conversation-recall.sqlite.building-")
        && !/-(?:wal|shm|journal)$/u.test(name)
    )));
    assert.equal(fs.existsSync(firstTemp), true);
    assert.equal(second.ensure("agent-a", [session], 0,
      () => ({ rows: [], throughSeq: 1 }), () => true), "rebuilding");
    assert.equal(fs.existsSync(firstTemp), true,
      "a second instance must not delete a live builder's temp SQLite file");
    return { rows: [], throughSeq: 1 };
  }, () => true), "rebuilding");
  await Promise.all([first.whenReady("agent-a"), second.whenReady("agent-a")]);
  assert.equal(first.ensure("agent-a", [session], 0,
    () => ({ rows: [], throughSeq: 1 }), () => true), "ready");
});

test("revocation removes this instance's cancelled build without deleting another live build", async (t) => {
  const f = fixture(t);
  const first = new ConversationRecallIndex({ paths: f.paths });
  const second = new ConversationRecallIndex({ paths: f.paths });
  t.after(() => { first.close(); second.close(); });
  const firstSession = { ...f.sessions[0], revision: 513, lastSeq: 513 };
  const secondSession = { ...f.sessions[0], revision: 1, lastSeq: 1 };
  let invalidated = false;
  assert.equal(first.ensure("agent-a", [firstSession], 0, (_session, afterSeq, limit) => {
    return { rows: [], throughSeq: Math.min(513, afterSeq + limit) };
  }, () => true), "rebuilding");
  const cancelled = first.whenReady("agent-a");
  assert.equal(second.ensure("agent-a", [secondSession], 0, () => {
    const ownTemp = first.builds.get("agent-a").temp;
    const otherTemp = second.builds.get("agent-a").temp;
    assert.equal(fs.existsSync(ownTemp), true);
    assert.equal(fs.existsSync(otherTemp), true);
    first.invalidateProfile("agent-a");
    assert.equal(fs.existsSync(ownTemp), false,
      "revocation must erase its cancelled temp immediately");
    assert.equal(fs.existsSync(otherTemp), true,
      "revocation must preserve another active builder's temp");
    invalidated = true;
    return { rows: [], throughSeq: 1 };
  }, () => true), "rebuilding");
  await cancelled;
  await second.whenReady("agent-a");
  assert.equal(invalidated, true);
  assert.equal(fs.existsSync(path.join(f.paths.agentsDir, "agent-a",
    "conversation-recall.sqlite")), true);
});

test("small transcript append is indexed incrementally without a rebuild state", async (t) => {
  const f = fixture(t);
  const old = f.addRun("run-old", KEY_A);
  f.addEvent(SESSION_A, old.id, "user", "初始会话记录");
  const current = f.addRun("run-current", KEY_B);
  f.addEvent(SESSION_B, current.id, "user", "查历史");
  const source = { source: "chat", sourceId: KEY_B };
  await readySearch(f.service, { profileId: "agent-a", args: { ...source,
    query: "初始" }, run: current });
  const appended = f.addEvent(SESSION_A, old.id, "assistant", "追加说明代号 BR-88");
  const result = f.service.search({ profileId: "agent-a", args: { ...source,
    query: "BR-88" }, run: current });
  assert.equal(result.status, "ready");
  assert.equal(result.results[0].eventId, appended.id);
});
