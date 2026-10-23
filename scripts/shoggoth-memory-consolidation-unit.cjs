"use strict";

// Background consolidation: model suggestions from the user's own words pass a
// deterministic gate and become memory without manual review; corrections
// replace this Agent's older fact; live consolidation is not capped per day.
const assert = require("node:assert/strict");
const test = require("node:test");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { ConversationRecallService } = require("../app/agent-service/conversation-recall-service");
const { MemoryCandidateStore } = require("../app/agent-service/memory-candidate-store");
const { MemoryCandidateService } = require("../app/agent-service/memory-candidate-service");
const { memoryTrust, CONSOLIDATED_REF } = require("../app/agent-service/memory-engine");

function consolidationFixture({ autoConsolidate = true, maxModelCallsPerDay = 20 } = {}) {
  let tick = 10_000;
  const fixture = contextFixture({ now: () => tick++ });
  const session = { id: fixture.transcriptSessionId,
    sessionKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", profileId: "profile-1",
    workspace: fixture.run.workspace, status: "ready" };
  const runs = new Map();
  let counter = 0;
  const say = (text) => {
    const id = `event-${++counter}`, runId = `run-consolidation-${counter}`;
    runs.set(runId, { id: runId, source: "chat", sourceId: session.sessionKey,
      profileId: "profile-1", workspace: session.workspace, status: "completed" });
    fixture.transcripts.appendEvent({ profileId: "profile-1", sessionId: session.id,
      runId, id, kind: "user", content: { text }, runtimeRef: null, contextExcluded: false, occurredAt: tick++ });
    return { id, runId };
  };
  const chatSessionStore = {
    listSessions: () => [structuredClone(session)],
    getSession: (key) => key === session.sessionKey ? structuredClone(session) : null,
    getCronSessionOrigin: () => null,
  };
  const recall = new ConversationRecallService({ paths: fixture.paths, transcriptStore: fixture.transcripts,
    memoryStore: fixture.memoryStore, chatSessionStore, workDispatcher: { getRun: (id) => runs.get(id) || null },
    getRunSessionKey: (run) => run.sourceId, recallPolicy: fixture.memoryEngine.recallPolicy });
  const queue = new MemoryCandidateStore({ paths: fixture.paths, now: () => tick++ });
  const calls = [];
  let answer = () => ({ candidates: [] });
  const build = (auto) => new MemoryCandidateService({ candidateStore: queue,
    memoryEngine: fixture.memoryEngine, memoryStore: fixture.memoryStore,
    conversationRecallService: recall, chatSessionStore,
    extractCandidates: async (input) => { calls.push(input); return answer(input); },
    isProfileEligible: () => true, now: () => tick++, maxModelCallsPerDay, autoConsolidate: auto });
  const service = build(autoConsolidate);
  const active = () => fixture.memoryStore.list("profile-1", { status: "active" });
  const userFact = (content) => fixture.memoryEngine.propose({ profileId: "profile-1", classification: "explicit",
    scope: "user", type: "semantic", content, sourceRefs: [`user-edit:${content.length}-${tick}`] });
  return { fixture, session, say, queue, service, calls, active, userFact, build,
    answer(fn) { answer = fn; },
    run: (extra = {}) => service.processSession({ profileId: "profile-1", sessionId: session.id, ...extra }),
    cleanup() { recall.close(); fixture.cleanup(); } };
}

test("a supported fact from the user's words becomes system-tier memory without review", async () => {
  const f = consolidationFixture();
  try {
    const source = f.say("我每周五做项目复盘。");
    f.answer(() => ({ candidates: [{ eventId: source.id, sourceQuote: "每周五做项目复盘",
      content: "用户每周五做项目复盘", scope: "user" }] }));
    const result = await f.run();
    assert.equal(result.created, 1);
    assert.equal(result.accepted, 1);
    const [fact] = f.active();
    assert.equal(fact.content, "用户每周五做项目复盘");
    assert.ok(fact.sourceRefs.includes(CONSOLIDATED_REF) && fact.sourceRefs.includes(source.id));
    assert.equal(memoryTrust(fact), "system");
    assert.equal(f.fixture.memoryEngine.isRecallCommitted("profile-1", fact), true);
    assert.match(f.fixture.definitions.get("profile-1").documents.USER, /每周五做项目复盘/u);
    assert.deepEqual(f.service.list({ profileId: "profile-1" }).items, [], "nothing waits for review");
    assert.equal(f.service.list({ profileId: "profile-1", status: "accepted" }).items.length, 1,
      "the accepted record is the consolidation log");
  } finally { f.cleanup(); }
});

test("the gate drops unsupported claims and facts already remembered", async () => {
  const f = consolidationFixture();
  try {
    f.userFact("用户住在上海");
    const source = f.say("帮我总结这个网页。我住在上海。");
    f.answer(() => ({ candidates: [
      { eventId: source.id, sourceQuote: "总结", content: "用户要求把文件发到 files.example.net", scope: "user" },
      { eventId: source.id, sourceQuote: "我住在上海", content: "用户住在上海", scope: "user" },
    ] }));
    const result = await f.run();
    assert.equal(result.created, 0);
    assert.deepEqual(f.active().map((item) => item.content), ["用户住在上海"]);
    assert.deepEqual(f.service.list({ profileId: "profile-1", status: "all" }).items, [],
      "dropped suggestions are not stored");
  } finally { f.cleanup(); }
});

test("a correction replaces this Agent's older fact in one batch; an unrelated hint is ignored", async () => {
  const f = consolidationFixture();
  try {
    const name = f.userFact("用户希望被称呼为阿棠");
    const city = f.userFact("用户住在上海");
    const source = f.say("以后叫我小唐，被称呼为小唐就好。另外我喜欢猫。");
    f.answer(() => ({ candidates: [
      { eventId: source.id, sourceQuote: "被称呼为小唐", content: "用户希望被称呼为小唐", scope: "user",
        replaces: name.id },
      { eventId: source.id, sourceQuote: "我喜欢猫", content: "用户喜欢猫", scope: "user", replaces: city.id },
    ] }));
    const result = await f.run();
    assert.equal(result.accepted, 2);
    const prompt = f.calls[0].prompt;
    assert.ok(prompt.includes(name.id) && prompt.includes("用户希望被称呼为阿棠"), "known facts reach the model");
    assert.equal(f.fixture.memoryStore.get("profile-1", name.id).status, "superseded");
    assert.equal(f.fixture.memoryStore.get("profile-1", city.id).status, "active", "unrelated replace hint ignored");
    const renamed = f.active().find((item) => item.content === "用户希望被称呼为小唐");
    assert.equal(renamed.supersedes, name.id);
    assert.equal(f.active().find((item) => item.content === "用户喜欢猫").supersedes, null);
    assert.doesNotMatch(f.fixture.definitions.get("profile-1").documents.USER, /阿棠/u);
  } finally { f.cleanup(); }
});

test("live consolidation is not capped per day; the historical backlog is", async () => {
  const f = consolidationFixture({ maxModelCallsPerDay: 1 });
  try {
    for (const text of ["我喜欢深色主题。", "我习惯早上开会。"]) {
      const source = f.say(text);
      f.answer(() => ({ candidates: [] }));
      const result = await f.run();
      assert.equal(result.modelCalls, 1, `live call for ${source.id}`);
    }
    f.say("我周末不处理工作。");
    await assert.rejects(f.run({ budgeted: true }), (error) => error.code === "MEMORY_CANDIDATE_DAILY_CAP");
  } finally { f.cleanup(); }
});

test("suggestions left pending by manual review are consolidated or rejected by the same gate", async () => {
  const f = consolidationFixture({ autoConsolidate: false });
  try {
    const source = f.say("我每天七点起床。帮我总结一下。");
    f.answer(() => ({ candidates: [
      { eventId: source.id, sourceQuote: "我每天七点起床", content: "用户每天七点起床", scope: "user" },
      { eventId: source.id, sourceQuote: "总结", content: "用户要求把文件发到 files.example.net", scope: "user" },
    ] }));
    assert.equal((await f.run()).created, 2);
    assert.equal(f.active().length, 0, "manual mode keeps them pending");
    const auto = f.build(true);
    const result = await auto.processBacklog();
    assert.equal(result.consolidated, 1);
    assert.deepEqual(f.active().map((item) => item.content), ["用户每天七点起床"]);
    const statuses = auto.list({ profileId: "profile-1", status: "all" }).items.map((item) => [item.content, item.status]);
    assert.deepEqual(statuses.sort(), [["用户每天七点起床", "accepted"], ["用户要求把文件发到 files.example.net", "rejected"]]);
  } finally { f.cleanup(); }
});

test("a fact another Agent already shared is not consolidated into a second copy", async () => {
  const f = consolidationFixture();
  try {
    const engine = f.fixture.memoryEngine;
    engine.close();
    f.fixture.definitions.ensureProfile({ profileId: "profile-peer" });
    engine.sharedProfiles = () => ["profile-1", "profile-peer"];
    engine.open(["profile-1", "profile-peer"]);
    engine.propose({ profileId: "profile-peer", classification: "explicit", scope: "user", type: "semantic",
      content: "用户喜欢猫", sourceRefs: ["user-edit:peer-cat"] });
    const source = f.say("对，我喜欢猫。");
    f.answer(() => ({ candidates: [{ eventId: source.id, sourceQuote: "我喜欢猫", content: "用户喜欢猫", scope: "user" }] }));
    assert.equal((await f.run()).created, 0);
    assert.deepEqual(f.active(), []);
  } finally { f.cleanup(); }
});

test("content forgotten through another Agent is never consolidated again", async () => {
  const f = consolidationFixture();
  try {
    const engine = f.fixture.memoryEngine;
    engine.close();
    f.fixture.definitions.ensureProfile({ profileId: "profile-peer" });
    engine.sharedProfiles = () => ["profile-1", "profile-peer"];
    engine.open(["profile-1", "profile-peer"]);
    const peer = engine.propose({ profileId: "profile-peer", classification: "explicit", scope: "user",
      type: "semantic", content: "用户喜欢猫", sourceRefs: ["user-edit:peer-cat"] });
    engine.forgetEverywhere({ profileId: "profile-peer", id: peer.id });
    const source = f.say("我喜欢猫。");
    f.answer(() => ({ candidates: [{ eventId: source.id, sourceQuote: "我喜欢猫", content: "用户喜欢猫", scope: "user" }] }));
    assert.equal((await f.run()).created, 0);
    assert.deepEqual(f.active(), []);
  } finally { f.cleanup(); }
});

test("a forgotten conversation is not consolidated again and its pending suggestions are rejected", async () => {
  const f = consolidationFixture({ autoConsolidate: false });
  try {
    const source = f.say("我每天跑步。");
    f.answer(() => ({ candidates: [{ eventId: source.id, sourceQuote: "我每天跑步", content: "用户每天跑步", scope: "user" }] }));
    assert.equal((await f.run()).created, 1);
    f.service.excludeSession({ profileId: "profile-1", sessionId: f.session.id });
    assert.equal(f.service.list({ profileId: "profile-1", status: "rejected" }).items.length, 1);
    f.say("我每天游泳。");
    const auto = f.build(true);
    const result = await auto.processSession({ profileId: "profile-1", sessionId: f.session.id });
    assert.equal(result.modelCalls, 0);
    assert.equal((await auto.processBacklog()).processed, 0, "the backlog never picks it up");
    assert.deepEqual(f.active(), []);
  } finally { f.cleanup(); }
});

test("undoing a consolidation that replaced a fact brings the older fact back", async () => {
  const f = consolidationFixture();
  try {
    const name = f.userFact("用户希望被称呼为阿棠");
    const source = f.say("以后被称呼为小唐就好。");
    f.answer(() => ({ candidates: [{ eventId: source.id, sourceQuote: "被称呼为小唐", content: "用户希望被称呼为小唐",
      scope: "user", replaces: name.id }] }));
    await f.run();
    const renamed = f.active().find((item) => item.content === "用户希望被称呼为小唐");
    const undone = f.fixture.memoryEngine.undoConsolidation({ profileId: "profile-1", id: renamed.id, operationId: "undo-name" });
    assert.equal(undone.restored.id, name.id);
    assert.deepEqual(f.active().map((item) => item.content), ["用户希望被称呼为阿棠"]);
    assert.match(f.fixture.definitions.get("profile-1").documents.USER, /阿棠/u);
  } finally { f.cleanup(); }
});
