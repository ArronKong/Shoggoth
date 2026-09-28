"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { classifyProviderFailure, classifyProviderLimit } = require("../app/agent-service/runtime-provider-errors");

test("real model and capacity failures produce finite public codes", () => {
  for (const [text, expected] of [
    ["The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.", "RUNTIME_MODEL_UNAVAILABLE"],
    ["Codex error: The model `gpt-5.5` does not exist or you do not have access to it.", "RUNTIME_MODEL_UNAVAILABLE"],
    [JSON.stringify({ error: { code: "unsupported_value", message: "Unsupported value: 'max' is not supported with the 'gpt-5.5' model.", param: "reasoning.effort" }, status: 400 }), "RUNTIME_MODEL_SETTINGS_INVALID"],
    ["server_overloaded: Selected model is at capacity", "RUNTIME_UPSTREAM_UNAVAILABLE"],
    ["Rate limit reached for this API key, please retry later", "RUNTIME_RATE_LIMITED"],
    ["insufficient_quota: You exceeded your current quota", "RUNTIME_QUOTA_EXHAUSTED"],
    ["Unexpected provider error", null],
  ]) assert.equal(classifyProviderFailure(text), expected, text);
});

test("unknown failures and unbounded payloads cannot impersonate a public reason", () => {
  for (const text of [null, {}, "I use the model for capacity planning.", "2026-09-28 08:04:29.429",
    "The reasoning model should support my project.", "x".repeat(1024 * 1024 + 1) + " model_not_found"]) {
    assert.equal(classifyProviderFailure(text), null);
  }
  assert.equal(classifyProviderLimit("server_overloaded"), null, "capacity is not a login or quota failure");
  const message = "server_overloaded: private authorization header Bearer PRIVATE_TEST_VALUE";
  assert.equal(classifyProviderFailure(message), "RUNTIME_UPSTREAM_UNAVAILABLE");
  assert.equal(classifyProviderFailure(message).includes("PRIVATE_TEST_VALUE"), false);
});
