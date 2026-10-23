"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { runBoundedModelResolution, validateModelResolution } = require("../app/agent-service/runtime-model-resolution");
const { DeepSeekHarnessRuntimeHost } = require("../app/agent-service/deepseek-harness-runtime-host");
const { runtimeHandleV1, validateRuntimeHandleResult } = require("../app/agent-service/runtime-handle-v1");
const input = { operationId: "discover-model" };
const selection = { model: "fixture/actual-model", provider: "fixture" };

test("Runtime V1 requires explicit-discovery capability before passing a requested model", async () => {
  for (const explicit of [false, true]) {
    let called = 0;
    const binding = { runtime: "pi", runtimeProfileId: "profile", runtimeAccountId: "account" };
    const raw = { ...binding, capabilities: { "model.resolve.toolFree": true, "model.resolve.explicit": explicit },
      terminated: new Promise(() => {}), subscribe: () => () => {},
      async resolveModelOnly(request) { called++; assert.equal(request.model, "fixture/alias"); return selection; } };
    const pending = runtimeHandleV1(raw, binding).resolveModelOnly({ ...input, model: "fixture/alias" });
    if (explicit) assert.deepEqual(await pending, selection);
    else await assert.rejects(pending, { code: "RUNTIME_CAPABILITY_UNSUPPORTED" });
    assert.equal(called, explicit ? 1 : 0);
  }
});

test("model discovery accepts only control metadata and rejects malformed actual selections", async () => {
  for (const extra of [{ prompt: "private memory" }, { model: "" }, { model: null }, { model: "bad model" }, { onText() {} }]) {
    await assert.rejects(runBoundedModelResolution({ ...input, ...extra }, () => selection), { code: "MODEL_RESOLUTION_INVALID" });
  }
  for (const result of [{ model: "fixture/actual-model" }, { ...selection, text: "private" }, { ...selection, model: "bad\nmodel" }, { ...selection, provider: "" }]) {
    assert.throws(() => validateModelResolution(result), { code: "MODEL_RESOLUTION_INVALID" });
    assert.throws(() => validateRuntimeHandleResult("resolveModelOnly", result), { code: "MODEL_RESOLUTION_INVALID" });
  }
  assert.deepEqual(await runBoundedModelResolution(input, () => selection), selection);
  assert.deepEqual(await runBoundedModelResolution({ ...input, model: "fixture/alias" }, () => selection), selection);
});

test("DeepSeek explicit discovery verifies exact native metadata without dispatching a model", async () => {
  const { BridgeRuntime } = await import("../resources/deepseek-harness/shoggoth-dsh-bridge.mjs");
  const lookups = [], bridge = new BridgeRuntime({
    agentDefaultModel: { currentSelection() { assert.fail("explicit request must not use CLI default"); } },
    llm: { async resolveModelInfo(provider, id, signal) { lookups.push({ provider, id });
      assert.ok(signal instanceof AbortSignal); return { provider, id }; },
      stream() { assert.fail("metadata resolution dispatched a prompt"); } },
  });
  const host = { _assertReady() {}, process: { request: async (method, params) => bridge.dispatch(method, params) } };
  const request = { ...input, model: selection.model };
  assert.deepEqual(await DeepSeekHarnessRuntimeHost.prototype.resolveModelOnly.call(host, request), selection);
  assert.deepEqual(lookups, [{ provider: "fixture", id: "actual-model" }]);
  assert.equal(bridge.modelRequests.size, 0);
  for (const result of [{ provider: "different", id: "actual-model" }, { provider: "fixture", id: "alias-target" }]) {
    bridge.ctx.llm.resolveModelInfo = async () => result;
    await assert.rejects(DeepSeekHarnessRuntimeHost.prototype.resolveModelOnly.call(host, request), { code: "RUNTIME_MODEL_UNAVAILABLE" });
    assert.equal(bridge.modelRequests.size, 0);
  }
});

test("DeepSeek explicit resolution cancellation waits for metadata cleanup and refuses unknown completion", async () => {
  const { BridgeRuntime } = await import("../resources/deepseek-harness/shoggoth-dsh-bridge.mjs");
  const controller = new AbortController(); let ready, cleaned = false;
  const started = new Promise(resolve => { ready = resolve; });
  const bridge = new BridgeRuntime({ llm: { resolveModelInfo(provider, id, signal) {
    return new Promise(resolve => { signal.addEventListener("abort", () => setTimeout(() => {
      cleaned = true; resolve({ provider, id });
    }, 10), { once: true }); ready(); });
  } } });
  const host = { _assertReady() {}, process: { request: async (method, params) => bridge.dispatch(method, params) } };
  const pending = DeepSeekHarnessRuntimeHost.prototype.resolveModelOnly.call(host, { ...input, model: selection.model, signal: controller.signal });
  await started; controller.abort(); await assert.rejects(pending, { code: "MODEL_ONLY_CANCELED" });
  assert.ok(cleaned); assert.equal(bridge.modelRequests.size, 0);
  host.process.request = () => { throw Object.assign(new Error("transport timeout"), { code: "RPC_TIMEOUT" }); };
  await assert.rejects(DeepSeekHarnessRuntimeHost.prototype.resolveModelOnly.call(host, { ...input, model: selection.model }), { code: "RUNTIME_STOP_UNCONFIRMED" });
});

test("discovery cancellation waits for cleanup, and cleanup failure overrides cancellation", async () => {
  for (const failure of [false, true]) {
    const controller = new AbortController(); let ready, cleaned = false;
    const started = new Promise(resolve => { ready = resolve; });
    const pending = runBoundedModelResolution({ ...input, signal: controller.signal }, signal => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => setTimeout(() => {
        cleaned = true;
        if (failure) reject(Object.assign(new Error("not stopped"), { code: "RUNTIME_STOP_UNCONFIRMED" }));
        else resolve(selection);
      }, 10), { once: true }); ready();
    }));
    await started; controller.abort();
    await assert.rejects(pending, { code: failure ? "RUNTIME_STOP_UNCONFIRMED" : "MODEL_ONLY_CANCELED" });
    assert.ok(cleaned);
  }
});

test("DeepSeek host obtains the bridge current selection without a prompt or model invocation", async () => {
  const { BridgeRuntime } = await import("../resources/deepseek-harness/shoggoth-dsh-bridge.mjs");
  const requests = [], bridge = new BridgeRuntime({
    agentDefaultModel: { currentSelection: () => ({ provider: "fixture", model: "actual-model" }) },
    llm: { stream() { assert.fail("discovery invoked model"); } },
  });
  const host = { _assertReady() {}, process: { async request(method, params) {
    requests.push({ method, params }); return bridge.dispatch(method, params);
  } } };
  assert.deepEqual(await DeepSeekHarnessRuntimeHost.prototype.resolveModelOnly.call(host, input), selection);
  assert.deepEqual(requests, [{ method: "model/resolve", params: {} }]);
  assert.equal(bridge.modelRequests.size, 0);
  assert.throws(() => bridge.dispatch("model/resolve", { prompt: "private" }), { code: "MODEL_RESOLUTION_INVALID" });
  bridge.ctx.agentDefaultModel.currentSelection = () => null;
  await assert.rejects(DeepSeekHarnessRuntimeHost.prototype.resolveModelOnly.call(host, input), { code: "RUNTIME_MODEL_UNAVAILABLE" });
});
