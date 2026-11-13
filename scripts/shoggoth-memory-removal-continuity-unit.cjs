"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { ConversationMemoryService } = require("../app/agent-service/conversation-memory-service");
const { ConversationRecallService } = require("../app/agent-service/conversation-recall-service");
const { ConversationCheckpointStore } = require("../app/agent-service/conversation-checkpoint-store");
const { validateMemoryMcpArguments } = require("../app/agent-service/memory-mcp-tools");
const { conversationContextBudget } = require("../app/agent-service/conversation-context-budget");

function scenario() {
  let now = 1000;
  const f = contextFixture({ now: () => now });
  const profileId = f.profile.id;
  const session = { id: f.transcriptSessionId, sessionKey: f.run.sourceId, profileId,
    workspace: f.run.workspace, status: "ready", runtimeSessionId: "native-before-removal" };
  const sessions = { listSessions: () => [session], getSession: key => key === session.sessionKey ? session : null,
    getRevision: () => 1 };
  const runs = new Map();
  const policy = f.memoryEngine.recallPolicy;
  policy.transcriptStore = f.transcripts;
  policy.chatSessionStore = sessions;
  policy.requireOwnMemoryProvenance = true;
  const memory = new ConversationMemoryService({ memoryEngine: f.memoryEngine, memoryStore: f.memoryStore,
    transcriptStore: f.transcripts, chatSessionStore: sessions, getRunSessionKey: () => session.sessionKey });
  const recall = new ConversationRecallService({ paths: f.paths, transcriptStore: f.transcripts,
    chatSessionStore: sessions, workDispatcher: { getRun: id => runs.get(id) },
    getRunSessionKey: () => session.sessionKey, recallPolicy: policy, memoryStore: f.memoryStore, now: () => now });
  const checkpoints = new ConversationCheckpointStore({ paths: f.paths, transcriptStore: f.transcripts,
    memoryStore: f.memoryStore, recallPolicy: policy, now: () => now });
  checkpoints.open();
  const user = (id, text) => {
    now += 100;
    const run = { ...f.run, id, status: "running" }; runs.set(id, run);
    const event = f.append({ id: `${id}-user`, runId: id, kind: "user", content: { text }, occurredAt: now });
    return { run, event };
  };
  const write = (name, run, args, operationId) => memory.write(name, profileId, args, {
    binding: memory.bind(name, { source: "chat", sourceId: session.sessionKey, ...args }, run), operationId });
  const finish = (run, text) => {
    now += 100; run.status = "completed";
    // Matches pre-existing native conversations whose provenance is incomplete.
    return f.append({ id: `${run.id}-answer`, runId: run.id, kind: "assistant", occurredAt: now,
      content: { text, ownMemoryProvenance: { version: 1, profileId, runId: run.id, complete: false, refs: [] } } });
  };
  const close = f.cleanup;
  f.cleanup = () => { recall.close(); checkpoints.close(); close(); };
  return Object.assign(f, { policy, memory, recall, checkpoints, session, user, write, finish });
}

test("removing a saved memory preserves pending choice B across native context renewal without resaving it", async () => {
  const f = scenario(), profileId = f.profile.id;
  try {
    const old = f.user("telescope", "云层遮住星星时还能用望远镜吗？");
    f.finish(old.run, "云层会影响光学观测。");
    const topic = "跟进示例观测站的维护公告，发布后提醒我";
    const first = f.user("observatory", topic);
    const saved = await f.write("memory_save", first.run, { content: topic, sourceQuote: topic,
      scope: "user", classification: "explicit" }, "save-observatory");
    f.finish(first.run, "已把示例观测站维护公告的提醒写入 USER.md。");
    f.checkpoints.recordNativeSession(profileId, f.session.id, "native-before-removal", "binding",
      f.checkpoints.nativeMemoryVersion(profileId));
    const remove = f.user("remove", "请从 USER.md 移除该条目。\n我仍想设置定期检查。");
    const args = { id: saved.item.id, expectedRevision: f.memoryStore.getRevision(profileId),
      sourceQuote: "请从 USER.md 移除该条目。", mode: "memory_only" };
    assert.equal(validateMemoryMcpArguments("memory_forget", { source: "chat", sourceId: f.session.sessionKey, ...args }), true);
    await f.write("memory_forget", remove.run, args, "remove-observatory");
    const options = f.finish(remove.run, "已删除保存的条目。示例观测站维护公告的检查频率：\nA：每周检查\nB：高频跟进（每 3 小时或每 8 小时）\nC：自定频率。");
    const next = f.user("choose", "B");
    assert.equal(f.checkpoints.nativeSessionStale(profileId, f.session.id, "native-before-removal", "binding"), true);
    for (const runtime of ["codex", "antigravity", "grok-build", "pi", "opencode", "deepseek-harness"]) {
      for (const contextLifecycleV1 of [false, true]) {
        const compiled = f.compiler.compile({ profile: { ...f.profile, runtime }, run: next.run,
          transcriptSessionId: f.session.id, query: "B", currentPrompt: "B", freshSession: true, contextLifecycleV1,
          requestBudget: conversationContextBudget(64000) });
        assert.match(compiled.dynamicContext, /示例观测站维护公告/u, runtime);
        assert.match(compiled.dynamicContext, /B：高频跟进/u, runtime);
        assert.match(compiled.dynamicContext, /removed from saved memory/u, runtime);
        assert.equal(compiled.report.request.historyTruncated, false);
      }
    }
    assert.equal(f.memoryStore.get(profileId, saved.item.id).status, "deleted");
    assert.doesNotMatch(f.definitions.get(profileId).documents.USER, /示例观测站/u);
    assert.equal(f.memory.search(profileId, { query: "示例观测站" }, next.run).items.length, 0);
    assert.equal(f.policy.isEventVisible(profileId, options), true);
    assert.throws(() => f.memoryEngine.propose({ profileId, content: "持续查看示例观测设施公开的检修信息",
      sourceRefs: [remove.event.id, remove.run.id], scope: "agent", classification: "imported", type: "semantic" }),
    error => error.code === "MEMORY_SOURCE_REVOKED");
    assert.throws(() => f.memoryEngine.propose({ profileId, content: topic,
      sourceRefs: [next.event.id, next.run.id], scope: "agent", classification: "imported", type: "semantic" }),
    error => error.code === "MEMORY_SOURCE_REVOKED");
    assert.throws(() => f.recall.assertCandidateSourceCurrent(profileId, {
      sessionId: f.session.id, eventId: remove.event.id, runId: remove.run.id }),
    error => error.code === "MEMORY_CANDIDATE_SOURCE_OUTDATED");
    f.recall.prebuildProfile(profileId);
    await f.recall.whenIndexReady(profileId);
    const results = f.recall.search({ profileId, run: next.run,
      args: { source: "chat", sourceId: f.session.sessionKey, query: "高频跟进" } });
    assert.ok(results.results.some(row => row.eventId === options.id));
    f.policy.close(); f.policy.open([profileId]);
    assert.equal(f.policy.isEventVisible(profileId, options), true);
    assert.equal(f.policy.isSourceVisible(profileId, [remove.event.id, remove.run.id]), false);
    const before = f.policy.getRevision(profileId);
    await f.write("memory_forget", remove.run, args, "remove-observatory");
    assert.equal(f.policy.getRevision(profileId), before);
    // A later full forget must take precedence; memory_only cannot undo it.
    await f.write("memory_forget", remove.run, { ...args, mode: "everywhere" }, "forget-observatory");
    assert.equal(f.policy.isEventVisible(profileId, options), false);
    await f.write("memory_forget", remove.run, args, "remove-again");
    assert.equal(f.policy.isEventVisible(profileId, options), false);
  } finally { f.cleanup(); }
});

test("omitting removal mode preserves full forgetting and rejects invalid modes", () => {
  const source = { source: "chat", sourceId: "session", id: "memory", expectedRevision: 1, sourceQuote: "忘掉它" };
  assert.equal(validateMemoryMcpArguments("memory_forget", source), true);
  assert.equal(validateMemoryMcpArguments("memory_forget", { ...source, mode: "restore" }), false);
});
