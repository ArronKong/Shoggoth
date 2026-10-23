"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { validateMemoryModelExecution, resolveMemoryModelExecution: resolve } = require("../app/agent-service/memory-model-settings");
const { PiRuntimeHost } = require("../app/agent-service/pi-runtime-host");
const { DeepSeekHarnessRuntimeHost } = require("../app/agent-service/deepseek-harness-runtime-host");
const { runtimeHandleV1 } = require("../app/agent-service/runtime-handle-v1");
const input = { prompt: "Recall the amber telescope", model: null, operationId: "model-settings-test" };
const caps = (thinkingOptions = [], thinkingDefault = null, fastTier = null) => ({ thinkingOptions, thinkingDefault, fastTier });

test("native ranked selection clamps to advertised levels and preserves Runtime spellings", () => {
  for (const [request, capabilities, expected] of [
    ["off", caps(["none", "low", "high"], "high"), "none"],
    ["max", caps(["off", "low", "high"], "low"), "high"],
    ["minimal", caps(["off", "low", "high"], "high"), "low"],
    ["off", caps(["low", "medium", "high"], "high"), "low"],
    ["adaptive", caps(["low", "medium", "high"], "high"), "high"],
    ["adaptive", caps(["off", "low", "high"], "off"), "low"],
    ["adaptive", caps(["low", "adaptive", "high"], "high"), "adaptive"],
  ]) assert.deepEqual(resolve({ thinking: request }, capabilities), { thinkingLevel: expected });
  assert.deepEqual(resolve({ thinking: "off" }, caps()), {});
  for (const capabilities of [caps(), caps(["ultra"], "ultra"), caps(["unknown"], "unknown")]) {
    assert.throws(() => resolve({ thinking: "max" }, capabilities), { code: "MODEL_ONLY_SETTINGS_UNAVAILABLE" });
  }
  assert.throws(() => resolve({ thinking: "off" }, caps(["ultra"], "ultra")), { code: "MODEL_ONLY_SETTINGS_UNAVAILABLE" });
});

test("native auto speed retains its inclusive 60 second boundary and requires advertised support", () => {
  const execution = { thinking: "off", fastMode: "auto", startedAtMs: 1000 };
  assert.deepEqual(resolve(execution, caps([], null, "priority"), 61_000), { fastMode: true });
  assert.deepEqual(resolve(execution, caps([], null, "priority"), 61_001), { fastMode: false });
  assert.deepEqual(resolve(execution, caps([], null, "priority"), 999), { fastMode: true });
  assert.throws(() => resolve(execution, caps(), 61_000), { code: "MODEL_ONLY_SETTINGS_UNAVAILABLE" });
  assert.deepEqual(resolve(execution, caps(), 61_001), { fastMode: false });
  assert.deepEqual(resolve({ thinking: "off", fastMode: false }, caps()), { fastMode: false });
  assert.throws(() => resolve({ thinking: "off", fastMode: true }, caps()), { code: "MODEL_ONLY_SETTINGS_UNAVAILABLE" });
});

test("execution settings reject unknown knobs, malformed metadata and executable properties", () => {
  let read = false;
  const getter = { get thinking() { read = true; return "off"; } };
  for (const value of [getter, null, [], { thinking: "ultra" }, { thinking: "off", effort: "high" },
    { thinking: "off", fastMode: "on" }, { thinking: "off", fastMode: "auto" },
    { thinking: "off", startedAtMs: -1 }, { thinking: "off", startedAtMs: Infinity }]) {
    assert.throws(() => validateMemoryModelExecution(value), { code: "MODEL_ONLY_SETTINGS_INVALID" });
  }
  assert.equal(read, false);
  for (const capabilities of [null, caps(["low", "low"]), caps(["low"], "high"), caps([], null, "unverified")]) {
    assert.throws(() => resolve({ thinking: "off" }, capabilities), { code: "MODEL_ONLY_SETTINGS_UNAVAILABLE" });
  }
  const original = { thinking: "off" }, snapshot = validateMemoryModelExecution(original);
  original.thinking = "max"; assert.equal(snapshot.thinking, "off"); assert.ok(Object.isFrozen(snapshot));
});

function piFixture() {
  let finish;
  const calls = [], state = { model: { provider: "fixture", id: "model" }, thinkingLevel: "high" };
  const rpc = { closed: false, closedPromise: new Promise(resolve => { finish = resolve; }),
    kill() { rpc.closed = true; finish(); }, endInput() {} };
  const f = { calls, rpc, state, levels: ["off", "low", "high"], hook: () => {}, identity: "stable" };
  f.host = { _assertReady() {}, _modelCatalogIdentity: () => f.identity, killGraceMs: 5,
    _runControl: async () => ({ code: 0, stdout: '{"status":"ready"}' }),
    _spawnControlRpc({ onEvent }) {
      rpc.request = async (method, params) => {
        calls.push({ method, params }); await f.hook(method, params);
        if (method === "get_state") return structuredClone(state);
        if (method === "get_available_thinking_levels") return { levels: f.levels };
        if (method === "set_thinking_level") state.thinkingLevel = params.level;
        if (method === "prompt") onEvent({ type: "agent_end" });
        if (method === "get_messages") return { messages: [{ role: "assistant", stopReason: "stop", model: "model",
          provider: "fixture", content: [{ type: "text", text: "Amber" }] }] };
        return {};
      }; return rpc;
    } };
  f.generate = execution => PiRuntimeHost.prototype.generateModelOnly.call(f.host, { ...input, execution });
  return f;
}

test("Pi applies native thinking to the same private worker before its first prompt", async () => {
  const f = piFixture();
  assert.equal((await f.generate({ thinking: "max", fastMode: false })).text, "Amber");
  assert.deepEqual(f.calls.map(call => call.method), ["get_state", "get_available_thinking_levels", "set_thinking_level", "get_state", "prompt", "get_messages"]);
  assert.deepEqual(f.calls[2].params, { level: "high" }); assert.ok(f.rpc.closed);
  const off = piFixture(); await off.generate({ thinking: "off" });
  assert.deepEqual(off.calls.find(call => call.method === "set_thinking_level").params, { level: "off" });
});

test("Pi refuses unavailable speed, changed worker state, revoked sources and cancellation before prompting", async () => {
  for (const action of ["fast", "model", "level", "catalog", "source", "cancel"]) {
    const f = piFixture(), controller = new AbortController(); let valid = true;
    f.hook = method => {
      if (method !== "get_available_thinking_levels") return;
      if (action === "model") f.state.model.id = "other";
      if (action === "catalog") f.identity = "changed";
      if (action === "source") valid = false;
      if (action === "cancel") controller.abort();
    };
    if (action === "level") f.hook = method => { if (method === "get_state" && f.calls.length > 1) f.state.thinkingLevel = "low"; };
    await assert.rejects(PiRuntimeHost.prototype.generateModelOnly.call(f.host, { ...input, signal: controller.signal,
      execution: { thinking: "max", ...(action === "fast" ? { fastMode: true } : {}) },
      assertCurrent() { if (!valid) throw Object.assign(new Error(), { code: "SOURCE_REVOKED" }); },
    }), { code: action === "fast" ? "MODEL_ONLY_SETTINGS_UNAVAILABLE" : action === "source" ? "SOURCE_REVOKED"
      : action === "cancel" ? "MODEL_ONLY_CANCELED" : "RUNTIME_MODEL_CATALOG_CHANGED" });
    assert.equal(f.calls.some(call => call.method === "prompt"), false, action); assert.ok(f.rpc.closed);
  }
});

async function deepSeekFixture() {
  const { BridgeRuntime } = await import("../resources/deepseek-harness/shoggoth-dsh-bridge.mjs");
  const f = { calls: [], prepared: [], dispatched: [], defaultModel: "model", hook: () => {}, failPrepare: false };
  const bridge = f.bridge = new BridgeRuntime({ agentDefaultModel: { currentSelection: () => ({ provider: "fixture", model: f.defaultModel }) },
    llm: {
      async resolveModelInfo(provider, model) {
        await f.hook(); return { id: model, reasoning: { efforts: ["off", "low", "high", "max"].map(id => ({ id })), defaultEffort: "high" } };
      },
      async prepareCall(config) {
        f.prepared.push(config);
        if (f.failPrepare) throw new Error("private provider metadata");
        return { config, async *stream(request) { f.dispatched.push(request);
          yield { type: "text-delta", text: "Amber" }; yield { type: "finish", reason: { kind: "stop" } }; } };
      },
      stream() { assert.fail("settings call must use native prepared dispatch"); },
    } });
  const host = f.host = { _assertReady() {}, modelTextObservers: new Map(), process: {
    async request(method, params) { f.calls.push({ method, params }); return bridge.dispatch(method, params); },
  } };
  f.generate = extra => DeepSeekHarnessRuntimeHost.prototype.generateModelOnly.call(host, { ...input, ...extra });
  return f;
}

test("DeepSeek resolves real effort metadata without a prompt, pins the route and uses native prepared dispatch", async () => {
  const f = await deepSeekFixture(); f.hook = () => { f.defaultModel = "changed-default"; };
  assert.equal((await f.generate({ execution: { thinking: "medium", fastMode: false } })).text, "Amber");
  assert.deepEqual(f.calls.map(call => call.method), ["model/describe", "model/generate"]);
  assert.deepEqual(f.calls[0].params, { model: null });
  assert.equal(f.calls[1].params.model, "fixture/model");
  assert.deepEqual(f.prepared, [{ provider: "fixture", model: "model", maxTokens: 4096, reasoningEffort: "low" }]);
  assert.equal(f.dispatched[0].reasoningEffort, "low"); assert.deepEqual(f.dispatched[0].tools, []);
  assert.equal(f.host.modelTextObservers.size, 0); assert.equal(f.bridge.modelRequests.size, 0);
});

test("DeepSeek refuses missing SDK controls, unsupported speed and a rejected native preparation", async () => {
  for (const action of ["sdk", "fast", "prepare", "metadata"]) {
    const f = await deepSeekFixture();
    if (action === "sdk") f.bridge.ctx.llm.resolveModelInfo = undefined;
    if (action === "prepare") f.failPrepare = true;
    if (action === "metadata") f.bridge.ctx.llm.resolveModelInfo = async () => ({ id: "different", reasoning: undefined });
    await assert.rejects(f.generate({ execution: { thinking: "max", ...(action === "fast" ? { fastMode: true } : {}) } }), error => {
      assert.equal(error.code, "MODEL_ONLY_SETTINGS_UNAVAILABLE"); assert.doesNotMatch(error.message, /private/u); return true;
    });
    assert.equal(f.dispatched.length, 0); assert.equal(f.bridge.modelRequests.size, 0); assert.equal(f.host.modelTextObservers.size, 0);
  }
});

test("DeepSeek checks source authority and cancellation after metadata and before sending any prompt", async () => {
  for (const canceled of [false, true]) {
    const f = await deepSeekFixture(), controller = new AbortController(); let valid = true;
    f.hook = () => { valid = false; if (canceled) controller.abort(); };
    await assert.rejects(f.generate({ execution: { thinking: "high" }, signal: controller.signal,
      assertCurrent() { if (!valid && !canceled) throw Object.assign(new Error(), { code: "SOURCE_REVOKED" }); },
    }), { code: canceled ? "MODEL_ONLY_CANCELED" : "SOURCE_REVOKED" });
    assert.deepEqual(f.calls.map(call => call.method), ["model/describe"]); assert.equal(f.dispatched.length, 0);
  }
});

test("Runtime V1 keeps the dispatch fence local and rejects retained or malformed callbacks", async () => {
  const binding = { runtime: "pi", runtimeProfileId: "profile", runtimeAccountId: "account" };
  let late, checks = 0;
  const raw = { ...binding, capabilities: { "model.generate.toolFree": true, "model.generate.settings": true },
    subscribe: () => () => {}, terminated: new Promise(() => {}),
    async generateModelOnly(request) { late = request.assertCurrent; request.assertCurrent();
      assert.deepEqual(request.execution, { thinking: "high" }); return { text: "Amber" }; } };
  const host = runtimeHandleV1(raw, binding);
  assert.equal(host.capabilities["model.generate.settings"], true);
  await host.generateModelOnly({ ...input, execution: { thinking: "high" }, assertCurrent() { checks++; } });
  assert.equal(checks, 1); assert.throws(() => late(), { code: "MODEL_ONLY_CANCELED" }); assert.equal(checks, 1);
  await assert.rejects(host.generateModelOnly({ ...input, assertCurrent: true }), { code: "RUNTIME_PROTOCOL_INVALID" });
});
