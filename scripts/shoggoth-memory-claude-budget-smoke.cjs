"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { adjustMaxTokensForThinking: adjust } = require("../app/agent-service/shoggoth-memory/core.cjs");
const { projectClaudeMemorySettings: project, describeClaudeMemoryModel: describe,
  resolveClaudeMemoryExecution: resolve } = require("../app/agent-service/claude-memory-model-settings");

// This exercises the actual pinned OpenClaw budget helper only. Importing the
// algorithm does not attest model capabilities or enable legacy SDK thinking.
test("pinned thinking budgets preserve the original default levels and xhigh clamp", () => {
  assert.equal(typeof adjust, "function", "rebuild the core from the upstream export before running this smoke");
  for (const [level, budget] of [["minimal", 1024], ["low", 2048], ["medium", 8192],
    ["high", 16384], ["max", 32768], ["xhigh", 16384]]) {
    assert.deepEqual(adjust(undefined, 65536, level), { maxTokens: 65536, thinkingBudget: budget });
    assert.deepEqual(adjust(2048, 65536, level), { maxTokens: 2048 + budget, thinkingBudget: budget });
  }
});

test("custom budgets replace only authored levels and preserve the caller input", () => {
  const budgets = Object.freeze({ low: 4096, high: 24000 });
  assert.deepEqual(adjust(2048, 65536, "low", budgets), { maxTokens: 6144, thinkingBudget: 4096 });
  assert.deepEqual(adjust(undefined, 65536, "high", budgets), { maxTokens: 65536, thinkingBudget: 24000 });
  assert.deepEqual(adjust(undefined, 65536, "xhigh", budgets), { maxTokens: 65536, thinkingBudget: 24000 });
  assert.deepEqual(adjust(undefined, 65536, "medium", budgets), { maxTokens: 65536, thinkingBudget: 8192 });
  assert.deepEqual(budgets, { low: 4096, high: 24000 });
});

test("model output caps bound the request and reserve visible output when the budget fills it", () => {
  assert.deepEqual(adjust(60000, 65536, "high"), { maxTokens: 65536, thinkingBudget: 16384 });
  assert.deepEqual(adjust(undefined, 8192, "high"), { maxTokens: 8192, thinkingBudget: 7168 });
  assert.deepEqual(adjust(4096, 8192, "high"), { maxTokens: 8192, thinkingBudget: 7168 });
  assert.deepEqual(adjust(undefined, 16384, "high"), { maxTokens: 16384, thinkingBudget: 15360 });
  assert.deepEqual(adjust(undefined, 16385, "high"), { maxTokens: 16385, thinkingBudget: 16384 });
});

test("subminimum thinking budgets remain visible to the caller without pretending transport enablement", () => {
  for (const [outputCap, budget] of [[2048, 1024], [2047, 1023], [1024, 0], [512, 0]]) {
    assert.deepEqual(adjust(undefined, outputCap, "high"), { maxTokens: outputCap, thinkingBudget: budget });
  }
  assert.deepEqual(adjust(undefined, 8192, "low", { low: 1000 }), { maxTokens: 8192, thinkingBudget: 1000 });
  // The helper computes a budget; Anthropic's separate transport policy decides
  // whether budgets below 1024 disable thinking. No transport is invoked here.
});

test("an omitted caller cap uses the model cap and remains distinct from an explicit zero", () => {
  assert.deepEqual(adjust(undefined, 65536, "high"), { maxTokens: 65536, thinkingBudget: 16384 });
  assert.deepEqual(adjust(0, 65536, "high"), { maxTokens: 16384, thinkingBudget: 15360 });
});

test("legacy CLI requests do not use fake SDK output caps or the direct-provider cap algorithm", () => {
  const model = "claude-sonnet-4-5";
  const settings = project({ applied: { model }, effective: { alwaysThinkingEnabled: false, fastMode: false } });
  for (const metadata of [
    { value: model },
    { value: model, supportsEffort: false },
    { value: model, supportsEffort: false, supportsAdaptiveThinking: false,
      maxOutputTokens: 65536, supportsManualThinking: true },
  ]) {
    const legacy = describe(settings, [metadata], model);
    assert.deepEqual(legacy.capabilities.thinkingOptions, ["off"]);
    assert.deepEqual(resolve({ thinking: "off" }, legacy), { thinkingEnabled: false, thinkingBudgetRequested: 0 });
    for (const [thinking, thinkingBudgetRequested] of [["minimal", 1024], ["low", 2048], ["medium", 8192],
      ["high", 16384], ["xhigh", 16384], ["max", 16384], ["adaptive", 8192]]) {
      assert.deepEqual(resolve({ thinking }, legacy), { thinkingEnabled: true, thinkingBudgetRequested });
    }
  }
  assert.throws(() => describe(settings, [{ value: model, supportsEffort: "false" }], model), { code: "MODEL_ONLY_SETTINGS_UNAVAILABLE" });
});
