"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { openFixture, sendAndDrain, SESSION_KEY } = require("./shoggoth-work-run-coordinator-unit.cjs");
const { defaultNativeRuntimeConfig } = require("../app/agent-service/native-runtime-config");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");

test("a provider change during encrypted persistence fails before Runtime acquisition", async () => {
  let current = true;
  const f = await openFixture({
    captureExecutionProviderRoute: () => ({ provider: { modelRef: "frozen-model" } }),
    assertExecutionProviderRouteCurrent(contract) {
      assert.equal(contract.provider.modelRef, "frozen-model");
      if (!current) throw Object.assign(new Error("stale"), { code: "EXECUTION_CONTRACT_STALE" });
    },
    runExecutionStore: { has: () => false, get: async () => null, remove() {},
      async put() { current = false; } },
  });
  try {
    const { ack } = await sendAndDrain(f, { operationId: "frozen-provider" });
    const run = f.coordinator.getRun(ack.run.id);
    assert.equal(run.status, "failed");
    assert.equal(run.errorCode, "EXECUTION_CONTRACT_STALE");
    assert.equal(f.host.turnStartCalls, 0);
    assert.equal(f.log.includes("runtimePool.get"), false);
  } finally { await f.coordinator.close(); }
});

test("a resumed native session receives fresh memory but never repeats the transcript seed", async () => {
  for (const resumed of [false, true]) {
    const config = defaultNativeRuntimeConfig();
    config.flags = { ...config.flags, runtimeContextLifecycleV1: true };
    const f = await openFixture({ getNativeRuntimeConfig: () => config,
      ...(resumed ? { sessionStatus: "ready", threadId: "existing-thread",
        threads: [{ id: "existing-thread", threadSource: null, turns: [] }] } : {}),
      contextCompiler: { compile(input) {
        assert.equal(input.contextLifecycleV1, true);
        assert.equal(input.currentOperationId, "current-operation");
        return { id: `ctx-${"a".repeat(64)}`, developerInstructions: "instructions",
          dynamicContext: "fresh-memory\nprior-transcript-seed", dynamicContextWithoutTranscript: "fresh-memory" };
      } },
    });
    try {
      await sendAndDrain(f, { operationId: "current-operation", prompt: "current-user-message" });
      const text = f.host.lastTurnStartParams.input.map(item => item.text || "").join("\n");
      assert.match(text, /fresh-memory/);
      assert.match(text, /current-user-message/);
      assert.equal(text.includes("prior-transcript-seed"), !resumed);
    } finally { await f.coordinator.close(); }
  }
});

test("context usage routes by native session, compaction becomes unknown and never alters billing", async () => {
  const config = defaultNativeRuntimeConfig();
  config.flags = { ...config.flags, runtimeContextLifecycleV1: true };
  const changes = [];
  const f = await openFixture({ getNativeRuntimeConfig: () => config,
    onRuntimeContextChanged: change => changes.push(change) });
  try {
    const { ack } = await sendAndDrain(f, { operationId: "context-observation" });
    const run = f.coordinator.getRun(ack.run.id);
    const contextUsage = { runtimeSessionId: run.runtimeSessionRef?.sessionId, usedTokens: 123,
      contextWindow: 1000, quality: "exact", source: "runtime_event", observedAt: 1000 };
    f.host.emit({ known: true, type: "context_usage", threadId: "another-session", contextUsage });
    assert.equal(changes.length, 0);
    f.host.emit({ known: true, type: "context_usage", threadId: run.runtimeSessionRef?.sessionId, contextUsage });
    assert.equal(f.coordinator.getRuntimeContext(f.sessions.getSession(SESSION_KEY)).contextUsage.usedTokens, 123);
    f.host.emit({ known: true, type: "context_compacted", threadId: run.runtimeSessionRef?.sessionId,
      contextUsage: { ...contextUsage, usedTokens: null, quality: "unknown", observedAt: 1001 } });
    assert.equal(f.coordinator.getRuntimeContext(f.sessions.getSession(SESSION_KEY)).contextUsage.quality, "unknown");
    assert.equal(f.usageRecords.length, 0);
    config.flags = { ...config.flags, runtimeContextLifecycleV1: false };
    assert.equal(f.coordinator.getRuntimeContext(f.sessions.getSession(SESSION_KEY)), null);
  } finally { await f.coordinator.close(); }
});

test("5/15/30/50 rounds retain newest dialogue within bytes despite tool-heavy history", () => {
  for (const rounds of [5, 15, 30, 50]) {
    const f = contextFixture({ budgets: { transcript: 1024 } });
    try {
      for (let i = 0; i < rounds; i++) {
        f.append({ id: `user-${i}`, kind: "user", content: { text: `question-${i} ${"内容".repeat(80)}` } });
        f.append({ id: `answer-${i}`, kind: "assistant", content: { text: `answer-${i} recent-answer` } });
        for (let j = 0; j < 4; j++) f.append({ id: `tool-${i}-${j}`, kind: "tool_result",
          content: { text: `tool-only-secretless-noise-${i}-${j}` } });
      }
      f.append({ id: "current", kind: "user", content: { text: "current-independent", operationId: "current" } });
      f.append({ id: "future", kind: "user", content: { text: "not-yet-dispatched", operationId: "future" } });
      const snapshot = f.compiler.compile({ profile: f.profile, run: f.run,
        transcriptSessionId: f.transcriptSessionId, contextLifecycleV1: true, currentOperationId: "current" });
      const prior = snapshot.blocks.find(block => block.kind === "transcript");
      assert.ok(prior.byteLength <= 1024);
      assert.match(prior.content, new RegExp(`answer-${rounds - 1} recent-answer`));
      assert.doesNotMatch(prior.content, /tool-only|current-independent|not-yet-dispatched/);
      assert.ok(prior.content.endsWith("END UNTRUSTED PRIOR TRANSCRIPT DATA"));
      assert.doesNotMatch(snapshot.dynamicContextWithoutTranscript, /recent-answer/);
    } finally { f.cleanup(); }
  }
});

test("Cron handoff carries prior dialogue and shares the total byte budget with frozen definitions", () => {
  const f = contextFixture();
  try {
    const definition = f.definitions.get(f.profile.id);
    const rules = "Retain these safety rules. ".repeat(1200);
    f.definitions.update({ profileId: f.profile.id, expectedRevision: definition.manifest.revision,
      actor: "user", reason: "full-definition-handoff", documents: { AGENTS: rules,
        IDENTITY: "Agent identity. ".repeat(800), SOUL: "Agent style. ".repeat(1200) } });
    for (let i = 0; i < 50; i++) {
      f.append({ id: `cron-${i}`, kind: "user", content: { text: `earlier-cron-${i} ${"原文".repeat(160)}` } });
      f.append({ id: `cron-answer-${i}`, kind: "assistant", content: { text: `completed-cron-${i}` } });
    }
    f.append({ id: "cron-current", kind: "user", content: { text: "current-cron-prompt", operationId: "current" } });
    const snapshot = f.compiler.compile({ profile: f.profile, run: { ...f.run, source: "cron" },
      transcriptSessionId: f.transcriptSessionId, contextLifecycleV1: true, currentOperationId: "current",
      transcriptBudget: 48 * 1024, handoffSeed: "Continue the same Conversation using a fresh Runtime session." });
    const prior = snapshot.blocks.find(item => item.kind === "transcript");
    assert.ok(snapshot.report.totalBytes <= 96 * 1024);
    assert.ok(prior.byteLength < 48 * 1024);
    assert.equal(prior.truncated, true);
    assert.equal(snapshot.blocks.find(item => item.kind === "rules").content, rules);
    assert.match(prior.content, /completed-cron-49/);
    assert.doesNotMatch(prior.content, /current-cron-prompt/);
    assert.ok(prior.content.endsWith("END UNTRUSTED PRIOR TRANSCRIPT DATA"));
  } finally { f.cleanup(); }
});
