"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { runBoundedModelOnly, validateModelOnlyInput } = require("../app/agent-service/runtime-model-only");
const { observeCryptoBroker, RuntimeTelemetry } = require("../app/agent-service/runtime-telemetry");
const input = { prompt: "Summarize", model: null, operationId: "summary-operation" };
test("the expanded model-only input budget is limited to proactive context", () => {
  const large = { ...input, prompt: "a".repeat(128 * 1024 + 1) };
  assert.throws(() => validateModelOnlyInput(large), { code: "MODEL_ONLY_INVALID" });
  assert.doesNotThrow(() => validateModelOnlyInput({ ...large, purpose: "proactive" }));
  assert.throws(() => validateModelOnlyInput({ ...large, purpose: "proactive", prompt: "a".repeat(256 * 1024 + 1) }),
    { code: "MODEL_ONLY_INVALID" });
});
test("canceling a model-only task waits for child cleanup before returning capacity", async () => {
  const controller = new AbortController(); let cleaned = false, started;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = runBoundedModelOnly({ ...input, signal: controller.signal }, signal => new Promise(resolve => {
    signal.addEventListener("abort", () => setTimeout(() => { cleaned = true; resolve({ text: "{}" }); }, 20), { once: true });
    started();
  }), { timeoutMs: 200, cleanupMs: 100 });
  await ready; controller.abort(); await assert.rejects(pending, { code: "MODEL_ONLY_CANCELED" }); assert.equal(cleaned, true);
});
test("an unconfirmed child stop cannot be reported as a normal cancellation", async () => {
  const controller = new AbortController(); let started;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = runBoundedModelOnly({ ...input, signal: controller.signal }, () => { started(); return new Promise(() => {}); }, { cleanupMs: 20 });
  await ready; controller.abort(); await assert.rejects(pending, { code: "RUNTIME_STOP_UNCONFIRMED" });
  assert.throws(() => validateModelOnlyInput({ ...input, model: "bad\nmodel" }), { code: "MODEL_ONLY_INVALID" });
  assert.throws(() => validateModelOnlyInput({ ...input, operationId: "../outside" }), { code: "MODEL_ONLY_INVALID" });
});
test("crypto diagnostics measure actual await time and never record arguments or results", async () => {
  const telemetry = new RuntimeTelemetry();
  class Broker { #value = "private result"; async encrypt() { await new Promise(resolve => setTimeout(resolve, 15)); return this.#value; } }
  assert.equal(await observeCryptoBroker(new Broker(), telemetry).encrypt("private argument"), "private result");
  const snapshot = telemetry.snapshot(); assert.ok(snapshot.cryptoWaitMs >= 10); assert.doesNotMatch(JSON.stringify(snapshot), /private result|private argument/u);
});

test("a cleanup failure reported after cancellation retains the unconfirmed-stop error", async () => {
  const controller = new AbortController(); let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const pending = runBoundedModelOnly({ ...input, signal: controller.signal }, signal => new Promise((_, reject) => {
    signal.addEventListener("abort", () => setImmediate(() => reject(Object.assign(new Error(), { code: "RUNTIME_STOP_UNCONFIRMED" }))));
    ready();
  }));
  await started; controller.abort(); await assert.rejects(pending, { code: "RUNTIME_STOP_UNCONFIRMED" });
});

test("a dedicated native model worker may return its result after confirmed exit, but cannot be reused", async () => {
  const { runtimeHandleV1 } = require("../app/agent-service/runtime-handle-v1");
  const binding = { runtime: "grok-build", runtimeProfileId: "review", runtimeAccountId: "account" };
  for (const mode of ["confirmed", "ordinary", "failed", "canceled"]) {
    let resolve, reject;
    const terminated = new Promise((yes, no) => { resolve = yes; reject = no; });
    const controller = new AbortController();
    const raw = { ...binding, capabilities: { "model.generate.toolFree": true }, terminated,
      modelOnlyStopsHost: mode !== "ordinary", host: { modelOnlyInstance: true, state: "ready" }, subscribe: () => () => {},
      async generateModelOnly() {
        if (mode === "canceled") controller.abort();
        raw.host.state = mode === "failed" ? "failed" : "stopped";
        if (mode === "failed") reject(new Error("unconfirmed exit")); else resolve();
        await Promise.resolve(); return { text: "{}" };
      } };
    const handle = runtimeHandleV1(raw, binding);
    const pending = handle.generateModelOnly({ ...input, signal: controller.signal });
    if (mode === "confirmed") assert.deepEqual(await pending, { text: "{}" });
    else await assert.rejects(pending, { code: mode === "canceled" ? "MODEL_ONLY_CANCELED" : "RUNTIME_HANDLE_TERMINATED" });
    await assert.rejects(handle.generateModelOnly(input), { code: "RUNTIME_HANDLE_TERMINATED" });
  }
});
