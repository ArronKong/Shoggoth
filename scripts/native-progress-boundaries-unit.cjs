#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { openFixture, sendAndDrain, FakeHost, directRuntimeManager } = require("./shoggoth-work-run-coordinator-unit.cjs");
const { normalizeCodexEvent } = require("../app/agent-service/codex-event-normalizer");
const { transcriptHistoryItem } = require("../app/agent-service/chat-service-controller");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");

test("Claude complete assistant blocks expose public text once before the tool", () => {
  const { ClaudeCodeRuntimeHost } = require("../app/agent-service/claude-code-runtime-host");
  const host = Object.create(ClaudeCodeRuntimeHost.prototype), events = [];
  host._publish = event => events.push(event); host.registeredSecrets = [];
  const active = { sessionId: "session", turnId: "turn", toolStarts: new Set(), toolNames: new Map() };
  const message = { message: { content: [{ type: "thinking", thinking: "private reasoning" },
    { type: "text", text: "先核对目录。" }, { type: "tool_use", id: "pwd", name: "Bash", input: { command: "pwd" } }] } };
  host._onAssistantMessage(active, message); host._onAssistantMessage(active, message);
  assert.deepEqual(events.map(event => event.type), ["text", "tool_start"]);
  assert.equal(events[0].phase, "commentary"); assert.equal(events[0].text, "先核对目录。");
  assert.equal(JSON.stringify(events).includes("private reasoning"), false);
});

test("ACP native titles keep the MCP identity and execution arguments intact", () => {
  const { AntigravityAcpRuntimeHost } = require("../app/agent-service/antigravity-acp-runtime-host");
  const active = { sessionId: "session", turnId: "turn", accepted: true, dispatchState: "write_attempted",
    toolCalls: new Map(), completedToolCalls: new Set() }, events = [];
  const host = Object.assign(Object.create(AntigravityAcpRuntimeHost.prototype), {
    activeTurns: new Map([[active.sessionId, active]]), registeredSecrets: [], _acceptTurn() {}, _publish: event => events.push(event),
  });
  host._onNotification({ method: "session/update", params: { sessionId: active.sessionId, update: {
    sessionUpdate: "tool_call", toolCallId: "call", kind: "search", title: "核对官方资源限制",
    _meta: { mcp: { server: "shoggoth", tool: "web_search" } }, rawInput: { arguments: { query: "Oracle free limits" } },
  } } });
  assert.equal(events[0].tool.name, "mcp__shoggoth__web_search");
  assert.equal(events[0].tool.activityTitle, "核对官方资源限制");
  assert.deepEqual(events[0].tool.input, { query: "Oracle free limits" });
  assert.deepEqual(events[0].contextTool.input, { query: "Oracle free limits" });
});

// Exercise the shared Service -> Transcript -> Backend path with the different
// native wire shapes, including runtimes whose full text arrives only at end.
for (const runtime of ["codex", "claude-code", "pi", "antigravity", "grok-build", "opencode", "deepseek-harness"]) {
  test(`${runtime}: public text seals before tools, keeps identity and survives replay/history`, async () => {
    const stored = [], host = new FakeHost([]);
    const f = await openFixture({ runtime, host, runtimeManager: directRuntimeManager(host, runtime),
      transcriptStore: { listEvents: () => stored, appendEvent: input => {
        const existing = stored.find(event => event.id === input.id);
        if (existing) return structuredClone(existing);
        const event = { ...structuredClone(input), seq: stored.length + 1 }; stored.push(event); return event;
      } } });
    try {
      const { ack } = await sendAndDrain(f, { operationId: `progress-${runtime}` });
      const run = f.coordinator.getRun(ack.run.id), events = [];
      const sub = f.coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, event => events.push(event));
      const base = { known: true, sessionId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId };
      const emit = event => host.emit({ ...base, method: `${runtime}/fixture`, ...event });
      const note = "先核对官方资源限制。", answer = "这是最终核对结果。";
      const itemId = runtime === "claude-code" ? undefined : "public-note";
      emit({ type: "reasoning_delta", delta: "private reasoning stays separate" });
      emit({ type: "text_delta", itemId, delta: note });
      if (runtime === "codex") host.emit(normalizeCodexEvent({ method: "item/completed", params: {
        threadId: base.sessionId, turnId: base.turnId,
        item: { id: itemId, type: "agentMessage", text: note, phase: "commentary" },
      } }));
      if (runtime === "pi") emit({ type: "text", itemId, text: note, phase: "commentary" });
      if (runtime === "deepseek-harness") {
        const { BridgeRuntime } = await import("../resources/deepseek-harness/shoggoth-dsh-bridge.mjs");
        const texts = BridgeRuntime.prototype.mapEvent.call({}, base, { type: "assistant/message", data: {
          message: { content: [{ type: "text", text: note }, { type: "tool-call", id: "call", name: "web_search", arguments: {} }] },
        } });
        for (const event of texts) emit({ ...event, itemId });
      }
      const tool = { name: "web_search", kind: "search", activityTitle: "核对官方配额", input: { query: "Oracle free limits" } };
      emit({ type: "tool_start", itemId: "call", toolCallId: "call", tool });
      emit({ type: "tool_start", itemId: "call", toolCallId: "call", tool });
      const progress = events.filter(event => event.type === "text" && event.payload.phase === "commentary");
      assert.equal(progress.length, 1, "one public segment despite duplicate tool starts");
      assert.equal(progress[0].payload.text, note);
      assert.ok(events.indexOf(progress[0]) < events.findIndex(event => event.type === "tool.start"));
      assert.ok(progress[0].payload.segmentId);
      emit({ type: "tool_result", itemId: "call", toolCallId: "call", tool: { status: "completed", output: "quota document" } });
      const finalId = runtime === "antigravity" ? itemId : "final-answer";
      emit({ type: "text_delta", itemId: finalId, delta: answer });
      if (["grok-build", "opencode"].includes(runtime)) emit({ type: "text", itemId, text: note, phase: "final_answer" });
      const full = runtime === "antigravity" ? note + answer : answer;
      emit({ type: "text", itemId: finalId, text: full, phase: "final_answer" });
      emit({ type: "tool_start", itemId: "later-call", toolCallId: "later-call", tool });
      assert.equal(events.filter(event => event.type === "text" && event.payload.phase === "commentary").length, 1,
        "an explicit completed answer is not reclassified, and tool titles cannot manufacture public text");

      const backend = new ShoggothBackend({}), seen = { interim: [], tool: [] }, state = { text: "", reasoning: "", settled: false };
      const context = { run, hooks: { interim: (text, meta) => seen.interim.push({ text, id: meta.activityId }), tool: value => seen.tool.push(value) } };
      for (const event of events) await backend._consumeEvent(context, state, event);
      await backend._consumeEvent(context, state, progress[0]);
      assert.deepEqual(seen.interim, [{ text: note, id: progress[0].payload.segmentId }]);
      assert.equal(state.text, answer, "late full snapshots must not reintroduce sealed progress");
      assert.equal(state.reasoning, "private reasoning stays separate");
      assert.equal(seen.tool.at(-1).args.nativeActivityTitle, "核对官方配额");
      const history = stored.map(event => transcriptHistoryItem(event)).filter(Boolean).map(item => item.payload.message);
      const textParts = history.filter(message => message.role === "assistant").flatMap(message => message.content).filter(part => part.type === "text");
      assert.deepEqual(textParts.map(part => [part.text, !!part.activity]), [[note, true], [answer, false]]);
      assert.equal(textParts[0].segmentId, progress[0].payload.segmentId);
      if (runtime === "antigravity") {
        const last = stored.filter(event => event.kind === "assistant").at(-1);
        assert.equal(last.contextContent.text, full, "UI segmentation preserves full model context");
        assert.equal(stored.find(event => event.content.segmentId === progress[0].payload.segmentId).contextExcluded, true);
      }
      sub.unsubscribe();
    } finally { await f.coordinator.close(); }
  });
}

test("an input request seals public text before the card even without a tool event", async () => {
  const stored = [];
  const f = await openFixture({ transcriptStore: { listEvents: () => stored, appendEvent: event => {
    const saved = { ...structuredClone(event), seq: stored.length + 1 }; stored.push(saved); return saved;
  } } });
  try {
    const { ack } = await sendAndDrain(f, { operationId: "prompt-boundary" });
    const run = f.coordinator.getRun(ack.run.id), events = [];
    const sub = f.coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, event => events.push(event));
    const base = { threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId };
    f.host.emit({ known: true, ...base, method: "text", type: "text_delta", itemId: "note", delta: "先确认操作范围。" });
    const pending = f.host.request("mcpServer/elicitation/request", { ...base, serverName: "fixture", message: "确认操作范围",
      mode: "form", requestedSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } });
    pending.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    const note = events.findIndex(event => event.type === "text" && event.payload.phase === "commentary");
    assert.ok(note >= 0 && note < events.findIndex(event => event.type === "prompt"));
    assert.equal(events[note].payload.text, "先确认操作范围。");
    sub.unsubscribe();
  } finally { await f.coordinator.close(); }
});
