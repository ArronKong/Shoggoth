"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { openFixture, sendAndDrain, SESSION_KEY } = require("./shoggoth-work-run-coordinator-unit.cjs");
const { defaultNativeRuntimeConfig } = require("../app/agent-service/native-runtime-config");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");

test("product help reads only the frozen active Runtime and cannot inspect another Profile or a retired Run", async () => {
  const f = await openFixture();
  try {
    const { ack } = await sendAndDrain(f, { operationId: "product-help-runtime" });
    const run = f.coordinator.getRun(ack.run.id);
    const context = f.coordinator.getProductHelpContext(run.profileId, run.id);
    assert.ok(context); assert.equal(context.runtime, "codex");
    assert.equal(context.source, "chat");
    assert.equal(f.coordinator.getProductHelpContext("another-profile", run.id), null);
    assert.equal(f.coordinator.getProductHelpContext(run.profileId, "missing-run"), null);
    assert.equal(Object.isFrozen(context.capabilities), true);
    f.coordinator.runHostAssignments.delete(run.id);
    assert.equal(f.coordinator.getProductHelpContext(run.profileId, run.id), null);
  } finally { await f.coordinator.close(); }
});

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
      const turn = f.host.lastTurnStartParams;
      assert.equal(f.host.turnStartCalls, 1);
      assert.deepEqual(turn.input, [{ type: "text", text: "current-user-message", text_elements: [] }]);
      assert.deepEqual(f.host.lastInjectedItems, {
        threadId: turn.threadId,
        items: [{ type: "message", role: "user", content: [{ type: "input_text",
          text: resumed ? "fresh-memory" : "fresh-memory\nprior-transcript-seed" }] }],
      });
      assert.ok(f.log.lastIndexOf("host.threadInjectItems") < f.log.indexOf("host.turnStart"),
        "the current memory and first-session transcript seed must arrive before the user turn");
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

test("a new Agent's greeting reaches the first turn as prior dialogue", () => {
  const f = contextFixture();
  try {
    f.append({ id: "agent-greeting", kind: "assistant", runId: null,
      content: { text: "你好，我是 Grok，由你本机的 Grok 驱动。想让我帮你做什么？" } });
    f.append({ id: "first", kind: "user", content: { text: "first-user-request", operationId: "first" } });
    const snapshot = f.compiler.compile({ profile: f.profile, run: f.run,
      transcriptSessionId: f.transcriptSessionId, contextLifecycleV1: true, currentOperationId: "first" });
    const prior = snapshot.blocks.find(block => block.kind === "transcript");
    assert.match(prior.content, /你好，我是 Grok，由你本机的 Grok 驱动。/u);
    assert.doesNotMatch(prior.content, /first-user-request/);
  } finally { f.cleanup(); }
});

// Regression for a rebuilt Antigravity session that resumed an old 3D task
// after the user had moved on to news: old tool output filled the input.
function topicShiftHistory(f) {
  let seq = 0;
  const at = minute => Date.UTC(2026, 9, 21, 2, minute);
  f.append({ id: "build", kind: "user", occurredAt: at(0), content: { text: "构建 Gummy Bears 3D 页面" } });
  for (let i = 0; i < 40; i++) {
    const toolCallId = `call-${++seq}`;
    f.append({ id: `${toolCallId}-start`, kind: "tool_call", occurredAt: at(1), content: { transcriptType: "tool.start",
      toolCallId, tool: { name: "view_file", status: "in_progress",
        arguments: { AbsolutePath: "/workspace/index.html", StartLine: i * 90, toolSummary: "View lighting" } } } });
    f.append({ id: `${toolCallId}-result`, kind: "tool_result", occurredAt: at(1), content: { transcriptType: "tool.result",
      toolCallId, tool: { name: "view_file", status: "completed", success: true,
        output: `OLD_FILE_BODY_${i} ${"const gummyBear = new THREE.Mesh(geometry, material);\n".repeat(150)}` } } });
  }
  f.append({ id: "denied-start", kind: "tool_call", occurredAt: at(2), content: { transcriptType: "tool.start",
    toolCallId: "denied", tool: { name: "run_command", status: "in_progress", arguments: { CommandLine: "chrome --screenshot" } } } });
  f.append({ id: "denied-result", kind: "tool_result", occurredAt: at(2), content: { transcriptType: "tool.result",
    toolCallId: "denied", tool: { name: "run_command", status: "failed", success: false, output: "Denied by user (*)." } } });
  f.append({ id: "bear-done", kind: "assistant", occurredAt: at(3), content: { text: "软糖熊已改成软糖猫。" } });
  f.append({ id: "news", kind: "user", occurredAt: at(10), content: { text: "这几天有什么AI新闻" } });
  f.append({ id: "news-answer", kind: "assistant", occurredAt: at(11), content: { text: "以下是最近的 AI 新闻……" } });
  f.append({ id: "news-preference", kind: "user", occurredAt: at(12),
    content: { text: "以后让你查新闻要注意时效性，要每个新闻写出日期，写出来源" } });
  f.append({ id: "current", kind: "user", occurredAt: at(20), content: { text: "重新整理一份新闻", operationId: "current" } });
}

test("a fresh native session replays tool calls as short lines and restates the latest requests", () => {
  const f = contextFixture({ runtime: "antigravity" });
  try {
    topicShiftHistory(f);
    const compile = freshSession => f.compiler.compile({ profile: f.profile, run: f.run,
      transcriptSessionId: f.transcriptSessionId, contextLifecycleV1: true, currentOperationId: "current",
      transcriptTokenBudget: 500000, freshSession });
    const fresh = compile(true);
    const prior = fresh.blocks.find(block => block.kind === "transcript").content;
    assert.doesNotMatch(prior, /OLD_FILE_BODY|new THREE\.Mesh/u, "old tool output is not replayed");
    assert.match(prior, /TOOL_CALL: view_file \{"AbsolutePath":"\/workspace\/index\.html".*\} -> completed/u);
    assert.match(prior, /TOOL_RESULT: run_command failed: Denied by user/u);
    assert.doesNotMatch(prior, /TOOL_RESULT: view_file/u, "a successful result is folded into its call line");
    assert.ok(Buffer.byteLength(prior) < 16 * 1024, `replayed history stays small: ${Buffer.byteLength(prior)} bytes`);
    const recap = prior.slice(prior.indexOf("BEGIN UNTRUSTED RECENT USER REQUESTS DATA"));
    assert.ok(prior.indexOf("END UNTRUSTED PRIOR TRANSCRIPT DATA") < prior.indexOf("BEGIN UNTRUSTED RECENT USER REQUESTS DATA"),
      "the recap is the last block before the current request");
    assert.match(recap, /\[2026-10-21T02:00Z\] 构建 Gummy Bears 3D 页面\n\[2026-10-21T02:10Z\] 这几天有什么AI新闻\n\[2026-10-21T02:12Z\] 以后让你查新闻/u);
    assert.doesNotMatch(recap, /重新整理一份新闻/u, "the current request is delivered separately");
    assert.ok(fresh.dynamicContext.endsWith("END UNTRUSTED RECENT USER REQUESTS DATA"));
    assert.match(fresh.turnDeveloperInstructions, /started fresh from saved conversation history/u);
    const continuing = compile(false);
    assert.doesNotMatch(continuing.dynamicContextWithoutTranscript, /RECENT USER REQUESTS|PRIOR TRANSCRIPT/u);
    assert.doesNotMatch(continuing.turnDeveloperInstructions, /started fresh/u,
      "a continuing native session already holds its own history");
  } finally { f.cleanup(); }
});
