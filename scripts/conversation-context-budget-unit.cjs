"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { conversationContextBudget, estimateContextTokens, documentedModelWindow } = require("../app/agent-service/conversation-context-budget");
const { planConversationCompaction } = require("../app/agent-service/conversation-compaction");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { createRuntimeSupportFacts } = require("../app/agent-service/runtime-support");
const { validateProductContext } = require("../app/agent-service/product-context-protocol");

function history(rounds = 30, text = "ordinary text ".repeat(570)) {
  return Array.from({ length: rounds }, (_, index) => ({ seq: index + 1, id: `event-${index}`,
    kind: index % 2 ? "assistant" : "user", content: { text: `${index}: ${text}` },
    contextExcluded: false, occurredAt: 100 }));
}
function plan(events, options = {}) {
  return planConversationCompaction({ profileId: "profile-1", sessionId: "session-1",
    transcriptStore: { listEvents: () => events, getRevision: () => events.length },
    checkpointStore: { compatible: () => null }, ...options });
}

test("the same history compacts on a small window and stays verbatim on a larger model", () => {
  const events = history();
  const small = plan(events, { budget: conversationContextBudget(64_000) });
  assert.ok(small);
  assert.ok(small.targetThroughSeq < events.length - 2);
  assert.equal(plan(events, { budget: conversationContextBudget(1_000_000) }), null);
  assert.equal(plan(events, { budget: conversationContextBudget(258_400) }), null);
  assert.ok(plan(events, { budget: conversationContextBudget(64_000) }), "switching back reevaluates the smaller budget");
});

test("unknown capacity uses the requested 1M budget, and native current pressure wins over accumulated history", () => {
  const budget = conversationContextBudget(null);
  assert.deepEqual(budget, { tokens: 1000000, source: "fallback", triggerTokens: 800000, retainedTokens: 500000 });
  for (const value of [0, -1, Infinity, NaN, 1.5]) assert.equal(conversationContextBudget(value).source, "fallback");
  assert.ok(plan(history(430), { budget }));
  assert.equal(plan(history(380), { budget }), null);
  assert.equal(plan(history(430), { budget, usage: { usedTokens: 1000, observedAt: 101 } }), null,
    "native compaction already reduced pressure; old transcript totals must not cause another summary");
  assert.ok(plan(history(10), { budget, usage: { usedTokens: 850_000, observedAt: 101 } }),
    "hidden native tool/system context can cause pressure with a shorter transcript");
  assert.equal(estimateContextTokens("中文"), 4);
  assert.equal(estimateContextTokens("abcd"), 1);
});

test("Gemini's documented input limit is not its 64k output limit or a fabricated runtime observation", () => {
  const capacity = documentedModelWindow("antigravity", "gemini-3.8-flash-medium");
  assert.equal(capacity, 1_048_576);
  assert.deepEqual(conversationContextBudget(capacity, "model_spec"), {
    tokens: 1_048_576, source: "model_spec", triggerTokens: 838_860, retainedTokens: 524_288 });
  assert.equal(documentedModelWindow("codex", "gemini-3.8-flash-medium"), null);
  assert.equal(documentedModelWindow("antigravity", "gemini-3.8-flash-unknown"), null);
  assert.equal(documentedModelWindow("antigravity", null), null);
  for (const model of ["gpt-6-sol", "gpt-6-luna", "gpt-6-astra"]) {
    assert.equal(documentedModelWindow("codex", model), 1_050_000);
    assert.equal(documentedModelWindow("pi", `openai-codex/${model}`), 1_050_000);
  }
});

test("a handoff uses the destination transport limit without the former 2 MiB truncation", () => {
  const events = history(300);
  assert.equal(plan(events, { budget: conversationContextBudget(1_000_000) }), null);
  assert.equal(plan(events, { budget: conversationContextBudget(1_000_000), freshSession: true }), null);
  assert.equal(plan(history(600), { budget: conversationContextBudget(2_000_000) }), null);
  assert.ok(plan(history(600), { budget: conversationContextBudget(2_000_000), freshSession: true }));
  assert.equal(plan(history(30), { budget: conversationContextBudget(1_000_000), freshSession: true }), null);
});

test("CLI catalog windows are selected by model and invalidated by binding/account changes", async () => {
  let generation = 1;
  const binding = { id: "binding", revision: 1, enabled: true, runtime: "pi", runtimeAccountId: "account" };
  const profile = { permissionPolicy: { sandbox: "read-only", approvalPolicy: "never" } };
  const facts = createRuntimeSupportFacts({ runtimeAccountAdmission: { read: () => ({ generation }) },
    runtimeManager: { acquire: async () => ({ authenticationState: () => ({ authenticated: true }),
      modelsList: () => ({ data: [
        { model: "small", contextWindow: 128000, isDefault: true, maxContextWindow: 1000000 },
        { model: "large", contextWindow: 1000000 },
        { model: "unknown", maxContextWindow: 2000000 },
      ] }) }) } });
  await facts.read(binding, profile);
  assert.equal(facts.contextWindow(binding, profile, "small"), 128000);
  assert.equal(facts.contextWindow(binding, profile, "large"), 1000000);
  assert.equal(facts.contextWindow(binding, profile, "unknown"), null);
  assert.equal(facts.contextWindow(binding, profile, null), 128000);
  assert.equal(facts.contextWindow({ ...binding, revision: 2 }, profile, "small"), null);
  generation++;
  assert.equal(facts.contextWindow(binding, profile, "large"), null);
});

test("large-window projection preserves more than 48 KiB and survives snapshot persistence", () => {
  const f = contextFixture({ runtime: "pi" });
  try {
    for (const event of history(30, "nonsecret context ".repeat(2500))) f.append(event);
    f.append({ id: "current", kind: "user", content: { text: "continue", operationId: "current" } });
    const compile = transcriptTokenBudget => f.compiler.compile({ profile: f.profile, run: f.run,
      transcriptSessionId: f.transcriptSessionId, contextLifecycleV1: true, currentOperationId: "current", transcriptTokenBudget });
    const small = compile(32000), large = compile(500000);
    assert.ok(Buffer.byteLength(large.dynamicContext) > 1024 * 1024);
    assert.ok(Buffer.byteLength(large.dynamicContext) > Buffer.byteLength(small.dynamicContext) * 5);
    assert.match(large.dynamicContext, /USER: 0: nonsecret context/u);
    assert.doesNotMatch(small.dynamicContext, /USER: 0: nonsecret context/u);
    assert.deepEqual(f.snapshots.get(f.profile.id, large.id), large);
  } finally { f.cleanup(); }
});

test("the public budget includes its provenance and cannot be mistaken for a measured percentage", () => {
  const state = { automatic: "enabled", reason: null, summaryBindingId: "binding", summaryRuntime: "pi", summaryModel: null,
    checkpointId: null, coveredThroughSeq: 0, pendingRunId: null, lastError: null, measurement: "missing", nativeAuto: "unknown", transfer: null,
    budget: conversationContextBudget(null) };
  assert.deepEqual(validateProductContext(state), state);
  assert.throws(() => validateProductContext({ ...state, budget: { ...state.budget, source: "guessed" } }), { code: "PRODUCT_CONTEXT_INVALID" });
  assert.throws(() => validateProductContext({ ...state, budget: { ...state.budget, retainedTokens: 1000001 } }), { code: "PRODUCT_CONTEXT_INVALID" });
  const transfer = { state: "ready", targetBindingId: "target", model: null, sourceRevision: 12,
    sourceSessionRevision: 2, snapshotId: "prepared", mode: "transport_summary", errorCode: null, updatedAt: 1000 };
  assert.deepEqual(validateProductContext({ ...state, transfer }).transfer, transfer);
  for (const patch of [{ state: "sent" }, { mode: "complete" }, { sourceRevision: -1 }, { sourceSessionRevision: 1.5 },
    { targetBindingId: null }, { unknown: true }]) {
    assert.throws(() => validateProductContext({ ...state, transfer: { ...transfer, ...patch } }), { code: "PRODUCT_CONTEXT_INVALID" });
  }
});
