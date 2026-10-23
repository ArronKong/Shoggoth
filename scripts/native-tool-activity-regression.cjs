"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { GrokBuildRuntimeHost } = require("../app/agent-service/grok-build-runtime-host");
const { AntigravityAcpRuntimeHost } = require("../app/agent-service/antigravity-acp-runtime-host");
const { ClaudeCodeRuntimeHost } = require("../app/agent-service/claude-code-runtime-host");

// Exercise the actual event readers, with no process, credentials or provider.
function acpFixture(Host) {
  const events = [];
  const active = { sessionId: "session", turnId: "turn", accepted: true, dispatchState: "write_attempted",
    toolCalls: new Map(), completedToolCalls: new Set(), pendingToolResults: new Map(),
    pendingToolResultBytes: 0, nativeToolCursor: null };
  const host = Object.assign(Object.create(Host.prototype), {
    activeTurns: new Map([["session", active]]), registeredSecrets: ["registered-private-value"],
    _acceptTurn() {}, _publish(event) { events.push(event); },
  });
  return { events, active, send(update) {
    host._onNotification({ method: "session/update", params: { sessionId: "session", update } });
  } };
}

test("Grok X search receipts preserve semantic, keyword and thread inputs without renaming calls", () => {
  const { events, send } = acpFixture(GrokBuildRuntimeHost);
  const samples = [
    ["x_semantic_search", { query: "AI discussions", limit: 10 }],
    ["x_keyword_search", { query: "AI filter:links", mode: "Latest", from_date: "2026-10-12" }],
    ["x_thread_fetch", { post_id: "1234567890123456789" }],
  ];
  for (const [name, input] of samples) {
    send({ sessionUpdate: "tool_call", toolCallId: name, title: "X search:", kind: "search",
      status: "in_progress", rawInput: { variant: "XSearch", backend: true } });
    send({ sessionUpdate: "tool_call_update", toolCallId: name, title: "X search:", kind: "search",
      status: "completed", rawOutput: { name, input: JSON.stringify(input), id: "receipt", call_id: name } });
    const result = events.at(-1);
    assert.equal(result.type, "tool_result");
    assert.equal(result.toolCallId, name);
    assert.equal(result.tool.name, "X search:");
    assert.equal(result.tool.success, true);
    assert.equal(result.tool.input.operation, name);
    const target = name === "x_thread_fetch" ? "post_id" : "query";
    assert.equal(result.tool.input[target], input[target]);
    assert.equal(result.contextTool.output.input, JSON.stringify(input));
  }
});

test("Grok only extracts known bounded X input schemas and keeps secret redaction", () => {
  const { events, send } = acpFixture(GrokBuildRuntimeHost);
  const emit = rawOutput => {
    send({ sessionUpdate: "tool_call_update", toolCallId: "search", title: "X search:", kind: "search",
      status: "completed", rawOutput });
    return events.at(-1).tool.input;
  };
  assert.equal(emit({ name: "unknown_function", input: '{"query":"private"}' }), undefined);
  assert.equal(emit({ name: "x_keyword_search", input: "{unfinished" }), undefined);
  assert.equal(emit({ name: "x_keyword_search", input: JSON.stringify({ query: "a".repeat(70_000) }) }), undefined);
  assert.equal(emit({ name: "x_keyword_search", input: '["query"]' }), undefined);
  const safe = emit({ name: "x_keyword_search", input: JSON.stringify({ query: "registered-private-value", body: "private body" }) });
  assert.ok(!JSON.stringify(safe).includes("registered-private-value"));
  assert.ok(!JSON.stringify(safe).includes("private body"));
});

for (const Host of [GrokBuildRuntimeHost, AntigravityAcpRuntimeHost]) {
  test(`${Host.name} publishes late ACP input during progress and completion`, () => {
    const { events, send } = acpFixture(Host);
    send({ sessionUpdate: "tool_call", toolCallId: "command", title: "run_command", kind: "execute",
      status: "pending", rawInput: {} });
    send({ sessionUpdate: "tool_call_update", toolCallId: "command", title: "run_command", kind: "execute",
      status: "in_progress", rawInput: { command: "npm test", description: "Check regressions" } });
    assert.equal(events.at(-1).type, "tool_update");
    assert.equal(events.at(-1).tool.input.description, "Check regressions");
    assert.equal(events.at(-1).tool.name, "run_command");
    send({ sessionUpdate: "tool_call_update", toolCallId: "command", title: "run_command", kind: "execute",
      status: "completed", rawInput: { command: "npm test" } });
    assert.equal(events.at(-1).type, "tool_result");
    assert.equal(events.at(-1).tool.input.command, "npm test");
    assert.equal(events.at(-1).tool.success, true);
  });
}

test("Claude streams an empty tool block before the complete assistant tool input", () => {
  const events = [];
  const host = Object.assign(Object.create(ClaudeCodeRuntimeHost.prototype), {
    registeredSecrets: [], _publish(event) { events.push(event); },
  });
  const active = { sessionId: "session", turnId: "turn", toolStarts: new Set(), toolNames: new Map() };
  host._onStreamEvent(active, { type: "content_block_start", index: 0,
    content_block: { type: "tool_use", id: "call", name: "Bash", input: {} } });
  host._onStreamEvent(active, { type: "content_block_delta", index: 0,
    delta: { type: "input_json_delta", partial_json: '{"command":"npm test"' } });
  const message = { message: { content: [{ type: "tool_use", id: "call", name: "Bash",
    input: { command: "npm test", description: "Check regressions" } }] } };
  host._onAssistantMessage(active, message);
  host._onAssistantMessage(active, message);
  const calls = events.filter(event => ["tool_start", "tool_update"].includes(event.type));
  assert.equal(calls.at(-1).tool.input.description, "Check regressions");
  assert.equal(calls.at(-1).contextTool.input.command, "npm test");
  assert.equal(calls.filter(event => event.type === "tool_start").length, 1);
  assert.equal(calls.filter(event => event.tool.input.description).length, 1);
});

test("Antigravity partial MCP updates inherit only the same call's argument envelope", () => {
  const { events, send, active } = acpFixture(AntigravityAcpRuntimeHost);
  send({ sessionUpdate: "tool_call", toolCallId: "mcp", title: "shoggoth_app_state_get", kind: "other",
    rawInput: { arguments: {} }, _meta: { mcp: { server: "shoggoth", tool: "app_state_get" } } });
  const identity = structuredClone(active.toolCalls.get("mcp"));
  send({ sessionUpdate: "tool_call_update", toolCallId: "mcp", status: "in_progress",
    rawInput: { arguments: { section: "agents" } } });
  assert.deepEqual(events.at(-1).tool.input, { section: "agents" });
  assert.deepEqual(active.toolCalls.get("mcp"), identity, "display recovery cannot rewrite native result ownership");
  send({ sessionUpdate: "tool_call_update", toolCallId: "unrelated", status: "in_progress",
    rawInput: { arguments: { section: "agents" } } });
  assert.deepEqual(events.at(-1).tool.input, { arguments: { section: "agents" } });
});
