"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { conversationContextBudget, estimateContextTokens } = require("../app/agent-service/conversation-context-budget");
const { measureComposition, compositionOf, ContextBreakdownReader } = require("../app/agent-service/context-breakdown");
const protocol = require("../app/agent-service/product-context-protocol");

const TOKENS = ["rulesTokens", "definitionTokens", "toolTokens", "memoryTokens", "skillTokens", "historyTokens", "messageTokens"];
const total = composition => TOKENS.reduce((sum, key) => sum + composition[key], 0);
const SNAPSHOT_ID = `ctx-${"a".repeat(64)}`;

function compile(f, extra = {}) {
  f.append({ id: "old-user", kind: "user", content: { text: "Which colour was the telescope?", operationId: "old" } });
  f.append({ id: "old-reply", kind: "assistant", content: { text: "It was violet." } });
  f.append({ id: "current", kind: "user", content: { text: "continue", operationId: "current" } });
  const budget = conversationContextBudget(200000);
  return f.compiler.compile({ profile: f.profile, run: f.run, transcriptSessionId: f.transcriptSessionId,
    contextLifecycleV1: true, transcriptTokenBudget: budget.triggerTokens, requestBudget: budget,
    currentOperationId: "current", currentPrompt: "continue", freshSession: true, query: "continue", ...extra });
}

test("parts follow what Shoggoth delivers: resumed sessions keep history, Skill bodies leave the rules", () => {
  const blocks = [{ kind: "skill", estimatedTokens: 40 }, { kind: "skill-catalog", estimatedTokens: 7 },
    { kind: "user", estimatedTokens: 5 }, { kind: "memory", estimatedTokens: 11 }, { kind: "hook-data", estimatedTokens: 3 },
    { kind: "transcript", estimatedTokens: 300 }, { kind: "checkpoint", estimatedTokens: 20 }, { kind: "handoff", estimatedTokens: 2 }];
  const input = { stableInstructions: "s".repeat(400), turnInstructions: "t".repeat(200), definitionText: "d".repeat(80),
    tools: [{ name: "lookup" }], toolExposure: "resident", blocks, historyDelivered: true, prompt: "hello",
    attachments: [{ name: "a.txt", mimeType: "text/plain", id: "a" }] };
  const fresh = measureComposition(input);
  assert.equal(fresh.version, 1);
  assert.equal(fresh.definitionTokens, 20);
  assert.equal(fresh.rulesTokens, 100 + 50 - 20 - 40, "definition files and Skill bodies are not counted as rules");
  assert.equal(fresh.skillTokens, 47);
  assert.equal(fresh.memoryTokens, 19);
  assert.equal(fresh.historyTokens, 322);
  assert.equal(fresh.toolTokens, estimateContextTokens(JSON.stringify(input.tools)));
  assert.ok(fresh.messageTokens > estimateContextTokens("hello"), "attachments count toward the message");
  const resumed = measureComposition({ ...input, historyDelivered: false, toolExposure: "all" });
  assert.equal(resumed.historyTokens, 0); assert.equal(resumed.historyDelivered, false); assert.equal(resumed.toolExposure, "all");
});

test("a compiled snapshot records a composition that sums to the request estimate", () => {
  for (const runtime of ["pi", "codex"]) for (const freshSession of [true, false]) {
    const f = contextFixture({ runtime });
    try {
      const snapshot = compile(f, { freshSession });
      const composition = compositionOf(f.snapshots.get("profile-1", snapshot.id));
      assert.ok(composition, `${runtime} records a composition`);
      assert.ok(Math.abs(total(composition) - snapshot.report.request.estimatedTokens) <= 2,
        `${runtime}/${freshSession}: parts ${total(composition)} vs request ${snapshot.report.request.estimatedTokens}`);
      assert.equal(composition.historyDelivered, freshSession);
      assert.equal(composition.historyTokens > 0, freshSession, "only a fresh session carries Shoggoth's history");
      assert.equal(composition.toolExposure, runtime === "pi" ? "resident" : "all");
      assert.ok(composition.definitionTokens > 0 && composition.rulesTokens > 0 && composition.toolCount > 0);
      assert.deepEqual(protocol.validateBreakdown({ runId: "run-1", snapshotId: snapshot.id, composition: { ...composition } }).composition,
        { ...composition });
    } finally { f.cleanup(); }
  }
  const f = contextFixture({ runtime: "pi" });
  try {
    const legacy = f.compiler.compile({ profile: f.profile, run: f.run, transcriptSessionId: f.transcriptSessionId, query: "x" });
    assert.equal(legacy.report.composition, undefined, "no request budget means no composition");
    assert.equal(compositionOf(f.snapshots.get("profile-1", legacy.id)), null);
  } finally { f.cleanup(); }
});

test("older or altered snapshot compositions are reported as missing, never guessed", () => {
  const good = measureComposition({ stableInstructions: "s", turnInstructions: "t", definitionText: "", tools: [],
    toolExposure: "resident", blocks: [], historyDelivered: true });
  assert.ok(compositionOf({ report: { composition: good } }));
  assert.equal(compositionOf({ report: {} }), null);
  assert.equal(compositionOf({ report: { composition: { ...good, version: 2 } } }), null);
  assert.equal(compositionOf({ report: { composition: { ...good, extra: 1 } } }), null);
  assert.equal(compositionOf({ report: { composition: { ...good, toolTokens: -1 } } }), null);
  assert.equal(compositionOf({ report: { composition: { ...good, historyDelivered: false, historyTokens: 5 } } }), null);
  assert.equal(compositionOf({ report: { composition: { ...good, toolExposure: "some" } } }), null);
});

test("the reader verifies each immutable snapshot once and bounds its cache", () => {
  const composition = measureComposition({ stableInstructions: "s", turnInstructions: "t", definitionText: "", tools: [],
    toolExposure: "all", blocks: [], historyDelivered: false });
  const reads = [];
  const reader = new ContextBreakdownReader({ limit: 2, snapshotStore: { get(profileId, id) {
    reads.push(id); return id === SNAPSHOT_ID ? { report: { composition } } : { report: {} };
  } } });
  const run = { id: "run-1", profileId: "profile-1", contextSnapshotId: SNAPSHOT_ID };
  for (let n = 0; n < 5; n++) assert.equal(reader.forRun(run).composition.toolExposure, "all");
  assert.deepEqual(reads, [SNAPSHOT_ID]);
  assert.deepEqual(reader.forRun({ ...run, contextSnapshotId: null }), { runId: "run-1", snapshotId: null, composition: null });
  assert.equal(reads.length, 1, "a run without a snapshot reads nothing");
  reader.read("profile-1", `ctx-${"b".repeat(64)}`); reader.read("profile-1", `ctx-${"c".repeat(64)}`);
  assert.equal(reader.cache.size, 2, "least recently used entries are evicted");
  reader.forRun(run);
  assert.equal(reads.filter(id => id === SNAPSHOT_ID).length, 2, "an evicted snapshot is read again");
  assert.throws(() => Object.assign(reader.forRun(run).composition, { toolTokens: 1 }), "cached values are frozen");
});

test("the breakdown method has its own exact params and result DTO", () => {
  const params = { profileId: "profile-1", sessionKey: "session-1", runId: "6fdefc90-cbe9-43fd-a9b9-6bdd7d5ea70c" };
  assert.ok(protocol.METHODS.includes(protocol.BREAKDOWN_METHOD));
  assert.deepEqual(protocol.validateParams(protocol.BREAKDOWN_METHOD, params), params);
  for (const bad of [{ ...params, operationId: "x" }, { profileId: "p", sessionKey: "s" }, { ...params, runId: "../x" }]) {
    assert.throws(() => protocol.validateParams(protocol.BREAKDOWN_METHOD, bad), { code: "PRODUCT_CONTEXT_INVALID" });
  }
  assert.throws(() => protocol.validateParams("chat.context.compact", params), { code: "PRODUCT_CONTEXT_INVALID" },
    "compaction still requires its operationId");
  const composition = { historyDelivered: true, toolExposure: "resident", rulesTokens: 1, definitionTokens: 2, toolTokens: 3,
    memoryTokens: 4, skillTokens: 5, historyTokens: 6, messageTokens: 7, toolCount: 8 };
  const result = { runId: params.runId, snapshotId: SNAPSHOT_ID, composition };
  assert.deepEqual(protocol.validateMethodResult(protocol.BREAKDOWN_METHOD, result), result);
  assert.deepEqual(protocol.validateBreakdown({ ...result, snapshotId: null, composition: null }), { ...result, snapshotId: null, composition: null });
  for (const bad of [{ ...result, extra: true }, { ...result, snapshotId: "ctx-bad" }, { ...result, composition: { ...composition, toolCount: 1.5 } },
    { ...result, composition: { ...composition, version: 1 } }, { ...result, runId: "" }]) {
    assert.throws(() => protocol.validateBreakdown(bad), { code: "PRODUCT_CONTEXT_INVALID" });
  }
  assert.deepEqual(protocol.validateMethodResult("chat.context.compact", { runId: null, status: "unchanged" }), { runId: null, status: "unchanged" });
  assert.ok(protocol.MESSAGES.PRODUCT_CONTEXT_BREAKDOWN_UNAVAILABLE);
});
