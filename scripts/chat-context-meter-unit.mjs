#!/usr/bin/env node
import assert from "node:assert/strict";
import { sessionContextMeter, contextParts, latestContextReply, meterPercentLabel } from "../app/manage-ui/src/lib/chatContextMeter.ts";

const contextUsage = { usedTokens: 85_000, contextWindow: 100_000, quality: "exact" };
const flat = { totalTokens: 85_000, contextTokens: 100_000, totalTokensFresh: true };
for (const native of [true, false]) {
  for (const [usedTokens, level, label] of [
    [0, "normal", "0%"], [69_999, "normal", "<70%"], [70_000, "warning", "70%"], [75_000, "warning", "75%"],
    [80_000, "warning", "80%"], [80_001, "high", ">80%"], [85_000, "high", "85%"], [101_000, "high", "100%"],
  ]) {
    const active = native ? { contextUsage: { ...contextUsage, usedTokens } } : { ...flat, totalTokens: usedTokens };
    const meter = sessionContextMeter(active, native);
    assert.equal(meter.level, level);
    assert.equal(meterPercentLabel(meter), label);
    assert.equal(meter.percent, Math.min(100, usedTokens / 100_000 * 100));
  }
}
const estimate = sessionContextMeter({ contextUsage: { ...contextUsage, quality: "estimated" } }, true);
assert.equal(estimate.estimated, true);
assert.equal(meterPercentLabel(estimate), "85%");
for (const [label, native, active] of [
  ["native no usage", true, { ...flat, contextUsage: { ...contextUsage, usedTokens: null } }],
  ["native no window", true, { ...flat, contextUsage: { ...contextUsage, contextWindow: null } }],
  ["native unknown", true, { ...flat, contextUsage: { ...contextUsage, quality: "unknown" } }],
  ["native absent", true, flat],
  ["gateway with native data only", false, { contextUsage }],
  ["gateway stale", false, { ...flat, totalTokensFresh: false }],
  ["gateway no usage", false, { ...flat, totalTokens: undefined }],
  ["gateway no window", false, { ...flat, contextTokens: undefined }],
  ["gateway invalid window", false, { ...flat, contextTokens: 0 }],
  ["gateway invalid usage", false, { ...flat, totalTokens: -1 }],
]) {
  assert.equal(sessionContextMeter(active, native), null, label);
}

const usage = sessionContextMeter({ contextUsage }, true);
const context = { usedTokens: 85_000, windowTokens: 100_000, quality: "exact" };
const reply = { role: "assistant", nativeRunId: "turn-b", responseMetadata: { context } };
assert.deepEqual(latestContextReply([{ role: "user" }, reply, { role: "system", local: true }]), { runId: "turn-b", context });
for (const boundary of [{ role: "user" }, { ...reply, pending: true }, { ...reply, isError: true }, { ...reply, stopReason: "error" }, { role: "system", divider: {} },
  ...["modelSwitch", "contextRenewed", "contextCompacted", "runInterrupted"].map(notice => ({ role: "assistant", notice }))]) {
  assert.equal(latestContextReply([reply, boundary]), null, "never attribute an earlier turn across a boundary");
}
assert.equal(latestContextReply([reply, { role: "assistant" }]), null, "an unowned reply cannot borrow earlier data");

const composition = { historyDelivered: false, toolExposure: "all", toolCount: 48, messageTokens: 400, historyTokens: 0,
  definitionTokens: 1100, rulesTokens: 3000, toolTokens: 21000, memoryTokens: 700, skillTokens: 200 };
const parts = contextParts(composition, usage, context);
assert.deepEqual(parts.catalog, { count: 48, tokens: 21000 });
assert.equal(parts.parts.find(part => part.key === "other").tokens, 79600);
assert(!parts.parts.some(part => part.key === "tools" || part.key === "history"));
assert.equal(parts.parts.reduce((sum, row) => sum + row.tokens, 0), usage.usedTokens);
const resident = contextParts({ ...composition, toolExposure: "resident", historyDelivered: true, historyTokens: 1000 }, usage, context);
assert.equal(resident.catalog, null);
assert.equal(resident.parts.find(part => part.key === "tools").tokens, 21000);
assert.equal(resident.parts.find(part => part.key === "history").tokens, 1000);
for (const result of [contextParts(composition, usage), contextParts(composition, usage, { ...context, usedTokens: 84000 }),
  contextParts(composition, usage, { ...context, quality: "estimated" }),
  contextParts({ ...composition, rulesTokens: 100000 }, usage, context)]) {
  assert.equal(result.reconciled, false);
  assert(!result.parts.some(part => part.key === "other"), "unmatched estimates never partition the live window");
}
console.log("PASS chat context meter: native and gateway occupancy, latest reply ownership, composition and deferred tools");
