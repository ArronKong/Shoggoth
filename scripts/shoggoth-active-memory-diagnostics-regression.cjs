"use strict";

// Memory repair stage 6: every way an automatic recall can fail leaves a
// bounded, text-free diagnostic with its stage and original code.
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { A, FACT, fixture } = require("./fixtures/memory-repair-fixture.cjs");

async function recall(f) {
  const input = f.turn("What do you remember about the amber telescope?", undefined, { queued: true });
  await f.owner.prepareActiveMemory(input);
  const taken = f.owner.takeActiveMemory(input);
  await f.finish(input);
  return taken;
}
const textFree = records => assert.doesNotMatch(JSON.stringify(records), /amber|telescope|calibrat/u);

for (const sample of [
  { name: "non-JSON response", text: "amber telescope response", code: "MEMORY_ACTIVE_RESPONSE_INVALID", calls: 1 },
  { name: "sentinel with appended action", text: 'NONE\n{"tool":"exec","arguments":{}}', code: "MEMORY_ACTIVE_RESPONSE_INVALID", calls: 1 },
  { name: "oversized response", text: "x".repeat(65537), code: "MEMORY_ACTIVE_RESPONSE_INVALID", calls: 1 },
  { name: "forbidden tool", text: '{"tool":"exec","arguments":{"command":"amber telescope"}}', code: "MEMORY_ACTIVE_TOOL_INVALID", calls: 1 },
  { name: "foreign search field", text: '{"tool":"memory_search","arguments":{"query":"amber telescope","source":"chat"}}', code: "MEMORY_ACTIVE_TOOL_FAILED", calls: 1 },
  { name: "nested checkpoint", text: '{"tool":"memory_search","arguments":{"query":"amber telescope","checkpoint":"amber telescope"}}', code: "MEMORY_ACTIVE_TOOL_FAILED", calls: 1 },
  { name: "repeated lookup", action: () => ({ tool: "memory_search", arguments: { query: "amber telescope" } }), code: "MEMORY_ACTIVE_TOOL_REPEATED", calls: 2 },
  { name: "exhausted steps", action: step => ({ tool: "memory_search", arguments: { query: `amber telescope ${step}` } }), code: "MEMORY_ACTIVE_STEP_LIMIT", calls: 6 },
]) test(`post-response ${sample.name} retains its rejection code`, { timeout: 60000 }, async t => {
  const f = await fixture(t, { mode: "always" });
  let calls = 0;
  f.model = async () => ({ text: sample.action ? JSON.stringify(sample.action(++calls)) : (calls++, sample.text) });
  assert.equal((await recall(f))?.content || "", "");
  assert.equal(calls, sample.calls);
  const records = f.diagnostics();
  assert.ok(records.some(record => record.stage === "recall-runtime" && record.code === sample.code), JSON.stringify(records));
  assert.ok(records.some(record => record.stage === "recall-result" && record.outcome === "failed"));
  textFree(records);
  assert.doesNotMatch(JSON.stringify(records), /command|response|65537/u);
});

for (const text of ['{"summary":"NONE"}', 'NONE', ' \nNONE\n ']) test(`native empty result ${JSON.stringify(text)} remains a non-error result`, { timeout: 60000 }, async t => {
  const f = await fixture(t, { mode: "always" });
  f.model = async () => ({ text });
  const input = f.turn("What do you remember about the amber telescope?", undefined, { queued: true });
  await f.owner.prepareActiveMemory(input);
  assert.equal(f.owner.takeActiveMemory(input)?.content || "", "");
  const status = await f.owner.activeMemory.status.read({ profileId: A, sessionKey: input.session.sessionKey, includeTrace: false });
  assert.equal(status.outcome, "no_relevant_memory");
  await f.finish(input);
  const records = f.diagnostics();
  assert.ok(!records.some(record => ["error", "failed", "timeout"].includes(record.outcome)));
  textFree(records);
});

test("a failing recall tool leaves its code", { timeout: 60000 }, async t => {
  const f = await fixture(t, { mode: "always" }); await f.saveUser(FACT);
  f.model = async () => ({ text: JSON.stringify({ tool: "memory_get", arguments: { path: "../outside.md" } }) });
  await recall(f);
  const records = f.diagnostics();
  assert.ok(records.some(record => record.stage === "recall-tool" && record.outcome === "error" && /^[A-Z]/u.test(record.code)), JSON.stringify(records));
  textFree(records);
});

test("a timed-out recall is recorded as a timeout", { timeout: 60000 }, async t => {
  const f = await fixture(t, { mode: "always", activeMemory: { timeoutMs: 400, setupGraceTimeoutMs: 0 } }); await f.saveUser(FACT);
  f.model = ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  await recall(f);
  const records = f.diagnostics();
  assert.ok(records.some(record => record.stage === "recall-model" && ["TIMEOUT", "ABORTED"].includes(record.code)), JSON.stringify(records));
  assert.ok(records.some(record => record.stage === "recall-result" && record.outcome === "timeout"), JSON.stringify(records));
  textFree(records);
});

test("a cited memory withdrawn during recall is recorded as discarded", { timeout: 60000 }, async t => {
  const f = await fixture(t, { mode: "always" }); const saved = await f.saveUser(FACT);
  f.model = async () => {
    await f.owner.delete({ profileId: A, id: saved.id, reason: "forgotten", operationId: crypto.randomUUID() });
    return { text: JSON.stringify({ summary: "The amber telescope is calibrated every evening." }) };
  };
  assert.equal(await recall(f), null);
  const records = f.diagnostics();
  assert.ok(records.some(record => record.outcome === "discarded"), JSON.stringify(records));
  textFree(records);
});
