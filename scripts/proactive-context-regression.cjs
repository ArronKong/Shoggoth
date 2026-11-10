"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { A, fixture } = require("./fixtures/memory-repair-fixture.cjs");
const { conversationContextBudget } = require("../app/agent-service/conversation-context-budget");
const { core } = require("../app/agent-service/shoggoth-memory/host.cjs");

function ready(f, session) {
  const id = crypto.randomUUID();
  f.service.chatSessionStore.requestBinding(session.sessionKey, id, f.now());
  f.service.chatSessionStore.completeBinding(session.sessionKey, id, `runtime-${id}`);
  return f.service.chatSessionStore.getSession(session.sessionKey);
}
function append(f, input, text, extra = {}) {
  return f.service.transcriptStore.appendEvent({ profileId: A, sessionId: input.session.id,
    runId: input.run.id, id: crypto.randomUUID(), kind: "assistant", content: { text }, occurredAt: f.now(), ...extra });
}
function turnIn(f, session, text) {
  const id = crypto.randomUUID(), dispatcher = f.service.workDispatcher;
  dispatcher.enqueue({ id, profileId: A, source: "chat", sourceId: session.sessionKey,
    idempotencyKey: id, workspace: session.workspace });
  dispatcher.admit(id); dispatcher.transition(id, "running");
  const event = f.service.transcriptStore.appendEvent({ profileId: A, sessionId: session.id,
    runId: id, id: `user-${id}`, kind: "user", content: { text }, occurredAt: f.now() });
  return { profile: f.service.productStore.getAgentProfile(A), session, run: dispatcher.getRun(id), query: text, event };
}
function compile(f, input, window = 500000, freshSession = true) {
  const budget = conversationContextBudget(window);
  return f.service.contextCompiler.compile({ profile: input.profile, run: { ...input.run, source: "proactive" },
    transcriptSessionId: input.session.id,
    contextLifecycleV1: true, requestBudget: budget, transcriptTokenBudget: budget.triggerTokens, freshSession,
    currentOperationId: `system-check:${input.run.id}`, currentPrompt: "SYSTEM-INITIATED CHECK", query: "check" });
}

test("proactive context uses only the owning main conversation and validates sources through publication/restart", async t => {
  const f = await fixture(t), target = f.service.proactiveStore.getTarget(A);
  const main = ready(f, f.service.chatSessionStore.getSession(target.sessionKey));
  const input = turnIn(f, main, "Main user: the amber telescope review is complete.");
  append(f, input, "Main assistant: acknowledged the completed review.");
  append(f, input, "Hidden internal note", { contextExcluded: true });
  append(f, input, "Borrowed source text", { content: { text: "Borrowed source text", borrowedMemoryDerived: true } });
  append(f, input, "Tool output text", { kind: "tool_result" });
  await f.finish(input);
  const other = f.turn("Unrelated private conversation", ready(f, f.session())); await f.finish(other);
  const pending = turnIn(f, main, "Unfinished foreground task");
  append(f, pending, "Partial answer still running");
  const snapshot = compile(f, input), history = snapshot.blocks.find(block => block.kind === "transcript");
  assert.match(history.content, /Main user:.*Main assistant:/su);
  assert.doesNotMatch(history.content, /Hidden internal|Unrelated private/u);
  assert.equal(snapshot.report.proactiveConversation.sessionId, main.id);
  assert.equal(snapshot.report.proactiveConversation.selectedCount, 2);
  assert.ok(snapshot.report.composition.historyTokens > 0);
  assert.equal(snapshot.blocks.some(block => block.id === "proactive-conversation"), false, "No second bounded history replaces the normal transcript");
  const run = { profileId: A, contextSnapshotId: snapshot.id };
  assert.equal(f.service.proactiveService.isContextCurrent(run), true);
  await f.finish(pending);
  assert.equal(f.service.proactiveService.isContextCurrent(run), false, "completion of a previously pending exchange invalidates the review");
  run.contextSnapshotId = compile(f, input).id;
  assert.equal(f.service.proactiveService.isContextCurrent(run), true);
  const newer = turnIn(f, main, "A later main-conversation update changes the review context.");
  await f.finish(newer);
  assert.equal(f.service.proactiveService.isContextCurrent(run), false, "a completed new exchange invalidates the stale review");
  run.contextSnapshotId = compile(f, input).id;
  assert.equal(f.service.proactiveService.isContextCurrent(run), true);
  const noticeId = `notice-${"a".repeat(64)}`;
  append(f, input, "Published reminder", { id: `proactive-${noticeId}`, runId: null,
    content: { text: "Published reminder", proactiveNotice: { id: noticeId, kind: "heartbeat", items: [{ id: "check" }] } } });
  assert.equal(f.service.proactiveService.isContextCurrent(run), true, "publishing its own notice does not invalidate a review");
  assert.match(compile(f, input, 500000, false).blocks.find(block => block.id === "published-notices").content, /Published reminder/u);
  f.service.transcriptStore.setContextExcluded({ profileId: A, sessionId: main.id,
    eventId: input.event.id, contextExcluded: true });
  assert.equal(f.service.proactiveService.isContextCurrent(run), false, "hidden sources cannot authorize a pending notice");
  await f.service.stop({ notify: false }); await f.service.start();
  assert.equal(f.service.proactiveService.isContextCurrent(run), false, "the source receipt survives Service restart");
});

test("a wrong-owner or deleted main binding provides no conversation context", async t => {
  const f = await fixture(t), target = f.service.proactiveStore.getTarget(A), input = f.turn("ordinary context");
  const foreign = f.service.chatSessionStore.createSession({ profileId: f.B, workspace: f.workspace,
    operationId: crypto.randomUUID(), createdAt: f.now() });
  f.service.proactiveStore.setTarget(A, { ...target, sessionKey: foreign.sessionKey });
  assert.equal(compile(f, input).report.proactiveConversation, undefined);
  f.service.proactiveStore.setTarget(A, { ...target, deleted: true });
  assert.equal(compile(f, input).report.proactiveConversation, undefined);
  await f.finish(input);
});

test("file memory grows with available model capacity while preserving both recent daily files", async t => {
  const f = await fixture(t), config = f.owner.config(A);
  const dreaming = core.resolveMemoryDeepDreamingConfig({ cfg: config,
    pluginConfig: core.resolveMemoryDreamingPluginConfig(config) });
  const day = ms => core.formatMemoryDreamingDay(ms, dreaming.timezone);
  for (const [label, count, dailyNotePath] of [["long", 8, null], ["today", 3, `memory/${day(f.now())}.md`],
    ["yesterday", 3, `memory/${day(f.now() - 86400000)}.md`]]) {
    for (let i = 0; i < count; i++) await f.owner.propose({ profileId: A, scope: "agent", classification: "explicit",
      content: `${label}-${i}: ${"x".repeat(4900)} Complete condition ${i}.`,
      sourceRefs: [`user-edit:${label}-${i}`], ...(dailyNotePath ? { dailyNotePath } : {}) });
  }
  const input = f.turn("review");
  const large = compile(f, input), small = compile(f, input, 16000);
  assert.ok(large.report.hotMemory.memory.actualBytes > 12 * 1024);
  assert.ok(large.report.hotMemory.memory.actualBytes <= 64 * 1024);
  assert.ok(large.report.hotMemory.memory.fileCoverage.every(row => row.injectedBytes > 0));
  assert.ok(small.report.hotMemory.memory.estimatedTokens <= small.report.hotMemory.memory.budgetTokens);
  assert.ok(small.report.hotMemory.memory.actualBytes < large.report.hotMemory.memory.actualBytes);
  const memory = large.blocks.find(block => block.id === "memory");
  assert.ok(memory.content.includes("today-2:"), JSON.stringify(large.report.hotMemory.memory.fileCoverage));
  assert.ok(memory.content.includes("yesterday-2:"), JSON.stringify(large.report.hotMemory.memory.fileCoverage));
  assert.equal(memory.byteLength, large.report.hotMemory.memory.actualBytes);
  await f.finish(input);
});
