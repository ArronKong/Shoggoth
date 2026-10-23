"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { nativeResponseMetadata, gatewayResponseMetadata, validResponseMetadata } = require("../app/chat-response-metadata");
const external = require("../app/external-inspiration-protocol");
const federation = require("../app/federation-host-protocol");
const host = require("../app/group-runtime-host-protocol");
const usage = { inputTokens: 600, outputTokens: 40, cachedInputTokens: 200, cacheWriteInputTokens: 0, totalTokens: 640 };

test("native billing totals and context occupancy are independent, including multiple models", () => {
  const value = nativeResponseMetadata({ records: [{ ...usage, model: "actual-a" }, { ...usage, model: "actual-b" }],
    selectedModel: "later-config", context: { quality: "estimated", usedTokens: 500, contextWindow: 10000 } });
  assert.deepEqual(value.models, ["actual-a", "actual-b"]);
  assert.equal(value.modelSource, "reported");
  assert.equal(value.usage.inputTokens, 1200);
  assert.deepEqual(value.context, { usedTokens: 500, windowTokens: 10000, quality: "estimated" });
  assert.ok(validResponseMetadata(value));
});

test("unreported counters and unknown context stay absent; selected model is explicitly distinguished", () => {
  assert.equal(nativeResponseMetadata(), null);
  assert.deepEqual(nativeResponseMetadata({ selectedModel: "chosen", context: { quality: "unknown", usedTokens: 50, contextWindow: 1000 } }),
    { models: ["chosen"], modelSource: "selected" });
  assert.equal(nativeResponseMetadata({ records: [{ ...usage, inputTokens: Number.MAX_SAFE_INTEGER }, usage] })?.usage, undefined);
  const zero = nativeResponseMetadata({ records: [Object.fromEntries(Object.keys(usage).map(key => [key, 0]))] });
  assert.equal(zero.usage.inputTokens, 0, "reported zero remains known");
});

test("gateway response facts do not infer a context percentage from turn totals or include private identity", () => {
  const value = gatewayResponseMetadata({ role: "assistant", model: "model-a", usage: { input: 20000, output: 42, cacheRead: 2000 },
    sessionKey: "private", account: "private" });
  assert.deepEqual(value, { models: ["model-a"], modelSource: "reported", usage: { inputTokens: 20000, outputTokens: 42, cachedInputTokens: 2000 } });
  assert.equal(gatewayResponseMetadata({ role: "user", usage: { input: 1 } }), null);
  assert.equal(gatewayResponseMetadata({ role: "assistant", usage: { input: -1, output: NaN } }), null);
  assert.equal(gatewayResponseMetadata({ role: "assistant", usage: { contextUsed: 0, contextMax: 20000 } }).context.usedTokens, 0);
});

test("metadata transport rejects unbounded or unknown fields without changing the old snapshot DTO", () => {
  const params = { executionId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222",
    backendId: "hermes", agentId: "agent", sessionKey: "session", workspace: "/tmp/fixture", mode: "gateway",
    hostId: "33333333-3333-4333-8333-333333333333" };
  const result = { hostId: params.hostId, responseMetadata: nativeResponseMetadata({ records: [usage] }) };
  assert.ok(external.validateGroupExternalMetadataParams(params));
  assert.ok(external.validateGroupExternalMetadataResult(result));
  assert.ok(federation.validateFederationParams("group.external.metadata", params));
  assert.ok(federation.validateFederationResult("group.external.metadata", result, params));
  assert.ok(host.validHostRequest({ version: 2, id: params.executionId, hostId: params.hostId,
    authority: { groupId: params.executionId, ownerId: params.runId, epoch: 1 }, method: "group.external.metadata", params }));
  assert.ok(host.validHostResult("group.external.metadata", result));
  for (const bad of [{ ...result.responseMetadata, account: "secret" }, { models: ["x".repeat(513)] },
    { models: ["same", "same"] }, { usage: { inputTokens: -1 } }, { context: { usedTokens: 1, windowTokens: 0, quality: "exact" } }]) {
    assert.equal(!!validResponseMetadata(bad), false);
    assert.equal(!!external.validateGroupExternalMetadataResult({ ...result, responseMetadata: bad }), false);
  }
});
