"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { runBoundedModelOnly, validateModelOnlyInput } = require("../app/agent-service/runtime-model-only");
const { observeCryptoBroker, RuntimeTelemetry } = require("../app/agent-service/runtime-telemetry");
const input = { prompt: "Summarize", model: null, operationId: "summary-operation" };
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
