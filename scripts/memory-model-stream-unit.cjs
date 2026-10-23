"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createMemoryModelTextStream } = require("../app/agent-service/memory-model-text-stream");
const { partialSummary } = require("../app/agent-service/shoggoth-memory/partial-summary.cjs");
const { runtimeHandleV1 } = require("../app/agent-service/runtime-handle-v1");
const { ClaudeCodeRuntimeHost } = require("../app/agent-service/claude-code-runtime-host");
const { PiRuntimeHost } = require("../app/agent-service/pi-runtime-host");
const { DeepSeekHarnessRuntimeHost } = require("../app/agent-service/deepseek-harness-runtime-host");
const input = { prompt: "Recall the amber telescope", model: null, operationId: "stream-test" };
const tick = () => new Promise(resolve => setImmediate(resolve));

test("private model stream coalesces backpressure, drains before close and rejects late callbacks", async () => {
  const seen = []; let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const stream = createMemoryModelTextStream({ maxBytes: 1024, check() {}, abort() { assert.fail("unexpected abort"); },
    consume: async text => { seen.push(text); if (text === "first") { entered(); await held; } } });
  stream.push("first"); await started;
  for (let i = 0; i < 1000; i++) stream.push(`snapshot-${i}`);
  const closing = stream.close(); stream.push("late"); release(); await closing;
  assert.deepEqual(seen, ["first", "snapshot-999"]); assert.equal(stream.error, null);
});

test("invalid stream bytes and source changes abort generation without exposing the rejected text", async () => {
  for (const text of ["x".repeat(33), "\0", "\ud800", 123]) {
    let aborted = false, consumed = false;
    const stream = createMemoryModelTextStream({ maxBytes: 32, check() {}, abort() { aborted = true; }, consume() { consumed = true; } });
    stream.push(text); await stream.close();
    assert.equal(stream.error.code, "MEMORY_IMPORT_OUTPUT_INVALID"); assert.ok(aborted); assert.equal(consumed, false);
  }
  let valid = true, aborted = false;
  const stream = createMemoryModelTextStream({ maxBytes: 32, check() { if (!valid) throw Object.assign(new Error(), { code: "STALE" }); },
    abort() { aborted = true; }, consume() { assert.fail("revoked text must not be consumed"); } });
  stream.push("queued"); valid = false; await stream.close(); assert.equal(stream.error.code, "STALE"); assert.ok(aborted);
});

test("partial JSON summaries decode escapes and revoke invalid suffixes without mistaking tools for summaries", () => {
  for (const [text, expected] of [
    ['{"summary":"Amber', "Amber"], [' { "summary" : "Amber\\n观测', "Amber\n观测"],
    ['{"summary":"Amber\\', "Amber"], ['{"summary":"Amber\\uD83', "Amber"],
    ['{"summary":"Amber\\uD83D', "Amber"], ['{"summary":"Amber\\uD83D\\uDE80"}', "Amber🚀"],
    ['{"summary":"Amber\\"scope\\""} ', 'Amber"scope"'],
    ['{"summary":"Amber",', null], ['{"summary":"Amber"} trailing', null],
    ['{"summary":"Amber\\x', null], ['{"tool":"memory_get","arguments":{"path":"MEMORY.md"}}', null],
    ['I will check the telescope.', null], ['{"summary":"bad\nline', null],
  ]) assert.equal(partialSummary(text), expected, text);
});

test("Runtime V1 scopes model-only text observers to one live local call", async () => {
  const binding = { runtime: "pi", runtimeProfileId: "profile", runtimeAccountId: "account" }, seen = [];
  let observer;
  const raw = { ...binding, capabilities: { "model.generate.toolFree": true },
    subscribe: () => () => {}, terminated: new Promise(() => {}),
    async generateModelOnly(request) { observer = request.onText; observer("partial"); return { text: "done" }; } };
  const host = runtimeHandleV1(raw, binding);
  assert.deepEqual(await host.generateModelOnly({ ...input, onText: text => seen.push(text) }), { text: "done" });
  observer("late"); assert.deepEqual(seen, ["partial"]);
  await assert.rejects(host.generateModelOnly({ ...input, onText: "not a capability" }), { code: "RUNTIME_PROTOCOL_INVALID" });
});

test("Claude model-only transport streams text only and closes its SDK query on cancellation or tool use", async () => {
  for (const action of ["success", "cancel", "tool"]) {
    const controller = new AbortController(), seen = []; let closed = false, options;
    const host = Object.assign(Object.create(ClaudeCodeRuntimeHost.prototype), {
      state: "ready", userHome: "/fixture", binaryPath: "/fixture/claude", _spawnEnvironment: () => ({}),
      _spawnSdkControlProcess() {}, controlProcesses: new Map(), controlQueries: new Set(), sdk: { query(request) {
        options = request.options;
        return { close() { closed = true; }, async *[Symbol.asyncIterator]() {
          yield { type: "stream_event", event: { type: "message_start" } };
          yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "private reasoning" } } };
          yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Amber" } } };
          if (action === "tool") yield { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use" } } };
          if (action === "cancel") controller.abort();
          yield { type: "result", subtype: "success", result: "Amber", modelUsage: {} };
        } };
      } } });
    const result = ClaudeCodeRuntimeHost.prototype.generateModelOnly.call(host, { ...input, signal: controller.signal, onText: text => seen.push(text) });
    if (action === "success") assert.equal((await result).text, "Amber");
    else await assert.rejects(result, { code: action === "tool" ? "MODEL_ONLY_TOOLS_FORBIDDEN" : "MODEL_ONLY_CANCELED" });
    assert.ok(seen.includes("Amber")); assert.ok(!seen.join("").includes("private reasoning"));
    assert.equal(options.includePartialMessages, true); assert.deepEqual(options.tools, []);
    assert.ok(closed); assert.equal(host.controlQueries.size, 0);
  }
});

test("Pi model-only RPC streams before terminal completion and rejects an oversized partial", async () => {
  for (const overflow of [false, true]) {
    let killed = false, observedBeforeEnd = false, finish;
    const seen = [], rpc = { closed: false, closedPromise: new Promise(resolve => { finish = resolve; }),
      kill() { killed = true; rpc.closed = true; finish(); }, endInput() {} };
    const host = { _assertReady() {}, _modelCatalogIdentity: () => "fixed", killGraceMs: 5,
      _runControl: async () => ({ code: 0, stdout: '{"status":"ready"}' }),
      _spawnControlRpc({ onEvent }) {
        rpc.request = async method => {
          if (method === "get_state") return { model: { provider: "fixture", id: "model" } };
          if (method === "get_messages") return { messages: [{ role: "assistant", content: [{ type: "text", text: "Amber" }], stopReason: "stop" }] };
          if (method === "prompt") {
            onEvent({ type: "message_start", message: { role: "assistant" } });
            onEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" } });
            onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: overflow ? "x".repeat(32769) : "Amber" } });
            observedBeforeEnd = seen.includes("Amber"); onEvent({ type: "agent_end" });
          }
          return {};
        }; return rpc;
      } };
    const result = PiRuntimeHost.prototype.generateModelOnly.call(host, { ...input, onText: text => seen.push(text) });
    if (overflow) await assert.rejects(result, { code: "MODEL_ONLY_OUTPUT_INVALID" });
    else { assert.equal((await result).text, "Amber"); assert.ok(observedBeforeEnd); }
    assert.ok(killed); assert.ok(!seen.join("").includes("private reasoning"));
  }
});

test("DeepSeek native model stream is operation scoped and never published as a chat event", async () => {
  const { BridgeRuntime } = await import("../resources/deepseek-harness/shoggoth-dsh-bridge.mjs");
  const bridge = new BridgeRuntime({}), seen = [], requests = [];
  const host = { _assertReady() {}, modelTextObservers: new Map(), _handleEvent() { assert.fail("model text reached chat"); } };
  bridge.ctx = { agentDefaultModel: { currentSelection: () => ({ provider: "fixture", model: "model" }) },
    llm: { async *stream() { yield { type: "text-delta", text: "Am" }; yield { type: "text-delta", text: "ber" }; yield { type: "finish", reason: { kind: "stop" } }; } } };
  bridge.write = async ({ event }) => {
    DeepSeekHarnessRuntimeHost.prototype._onEvent.call(host, { ...event, operationId: "other-operation", delta: "foreign" });
    DeepSeekHarnessRuntimeHost.prototype._onEvent.call(host, event);
  };
  host.process = { async request(method, params) { requests.push({ method, params });
    return method === "model/generate" ? bridge.generateModelOnly(params) : {}; } };
  const result = await DeepSeekHarnessRuntimeHost.prototype.generateModelOnly.call(host, { ...input, onText: text => seen.push(text) });
  assert.equal(result.text, "Amber"); assert.deepEqual(seen, ["Am", "Amber"]);
  assert.equal(requests[0].params.streamText, true); assert.equal(host.modelTextObservers.size, 0);
  DeepSeekHarnessRuntimeHost.prototype._onEvent.call(host, { known: true, method: "deepseek-harness/model_text", type: "model_text", operationId: input.operationId, delta: "late" });
  assert.deepEqual(seen, ["Am", "Amber"]); assert.equal(bridge.modelRequests.size, 0);
});
