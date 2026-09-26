#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { openFixture, waitUntil, PROFILE_ID, SESSION_KEY, recoveryStore } = require("./shoggoth-work-run-coordinator-unit.cjs");
const { ConversationCheckpointStore, SUMMARY_FIELDS } = require("../app/agent-service/conversation-checkpoint-store");
const { RuntimeFairQueue } = require("../app/agent-service/runtime-fair-queue");

test("weighted service shares and aging survive a continuously replenished foreground queue", () => {
  const queue = new RuntimeFairQueue({ now: () => 200_000 });
  const counts = { chat: 0, kanban: 0, cron: 0, inspiration: 0, compaction: 0 };
  const runs = Object.keys(counts).map(source => ({ source }));
  for (let index = 0; index < 900; index++) {
    const run = queue.order(runs, () => 200_000)[0];
    counts[run.source]++;
    queue.admitted(run, Object.keys(counts));
  }
  assert.deepEqual(counts, { chat: 400, kanban: 200, cron: 100, inspiration: 100, compaction: 100 });
  assert.equal(queue.order(runs, run => run.source === "inspiration" ? 0 : 200_000)[0].source, "inspiration");
});

async function compactionFixture({ rounds = 50 } = {}) {
  const context = contextFixture();
  const checkpoints = new ConversationCheckpointStore({ paths: context.paths, transcriptStore: context.transcripts });
  checkpoints.open();
  const execution = recoveryStore();
  const value = await openFixture({ transcriptStore: context.transcripts, conversationCheckpointStore: checkpoints,
    runExecutionStore: execution, getNativeRuntimeConfig: () => ({ flags: { runtimeContextLifecycleV1: true,
      runtimeAdmissionV1: true }, maxActive: 2, startupConcurrency: 2 }) });
  const original = value.productStore.getAgentProfile;
  value.coordinator.getRuntimeModelContextWindow = () => 16_000;
  value.productStore.getAgentProfile = id => ({ ...original.call(value.productStore, id), defaultBindingId: "test-binding" });
  const events = context.transcripts;
  for (let index = 0; index < rounds; index++) for (const kind of ["user", "assistant"]) events.appendEvent({
    profileId: PROFILE_ID, sessionId: value.sessions.session.id, runId: `old-${index}`,
    id: `${kind}-${index}`, kind, content: { text: index === 0 ? "Keep blue triangles and never overwrite museum originals."
      : `${index}: ${"progress marker ".repeat(60)}` }, contextExcluded: false, runtimeRef: null, occurredAt: 500,
  });
  const acquire = value.coordinator.runtimeManager.acquire.bind(value.coordinator.runtimeManager);
  value.coordinator.runtimeManager.canGenerateModelOnly = () => true;
  let resolve, reject;
  const response = new Promise((yes, no) => { resolve = yes; reject = no; });
  let calls = 0;
  value.coordinator.runtimeManager.acquire = async (...args) => {
    const host = await acquire(...args);
    const facade = Object.create(host);
    Object.defineProperties(facade, {
      capabilities: { value: { ...host.capabilities, "model.generate.toolFree": true } },
      generateModelOnly: { value: async input => {
        calls++;
        assert.match(input.prompt, /Keep blue triangles/u);
        assert.equal(value.dispatcher.listRuns({ source: "chat" }).some(run => run.status === "running"), false);
        assert.ok(execution.records.size > 0, "recovery descriptor precedes dispatch");
        return response;
      } },
    });
    return facade;
  };
  const summary = Object.fromEntries(SUMMARY_FIELDS.map(field => [field, []]));
  summary.constraints = ["Keep blue triangles", "Never overwrite museum originals"];
  return { ...value, context, checkpoints, calls: () => calls, resolve: () => resolve({
    text: JSON.stringify(summary), model: "test-model", provider: null,
    usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0, totalTokens: 120 },
  }), reject, async cleanup() { await value.coordinator.close(); checkpoints.close(); context.cleanup(); } };
}

test("automatic product compaction occupies its own run, queues chat, commits across later appends and attributes usage", async () => {
  const f = await compactionFixture();
  try {
    const sent = await f.coordinator.send({ operationId: "after-long-history", sessionKey: SESSION_KEY, prompt: "continue" });
    assert.equal(sent.disposition, "queued");
    assert.equal(sent.reason, "CHAT_SESSION_BUSY");
    await waitUntil(() => f.calls() === 1, 2000, "model-only request");
    f.resolve();
    const run = f.dispatcher.listRuns({ source: "compaction" })[0];
    await f.coordinator.waitForIdle(run.id);
    assert.equal(f.dispatcher.getRun(run.id).status, "completed");
    assert.match(JSON.stringify(f.checkpoints.compatible(PROFILE_ID, f.sessions.session.id).summary), /blue triangles/u);
    assert.equal(f.usageRecords[0].source, "compaction");
    assert.equal(f.usageRecords[0].runId, run.id);
    assert.equal(f.usageRecords[0].usage.totalTokens, 120);
    await f.coordinator.waitForIdle(sent.run.id);
    await waitUntil(() => f.dispatcher.getRun(sent.run.id).status === "running", 8000, "all model-sized summary chunks");
    assert.equal(f.dispatcher.getRun(sent.run.id).status, "running");
  } finally { await f.cleanup(); }
});

test("an uncertain model request cannot be silently retried by another user message", async () => {
  const f = await compactionFixture();
  try {
    await f.coordinator.send({ operationId: "unknown-1", sessionKey: SESSION_KEY, prompt: "continue" });
    await waitUntil(() => f.calls() === 1, 2000, "model request");
    f.reject(Object.assign(new Error("disconnected"), { code: "MODEL_ONLY_ACCEPTANCE_UNKNOWN" }));
    const run = f.dispatcher.listRuns({ source: "compaction" })[0];
    await f.coordinator.waitForIdle(run.id);
    assert.equal(f.dispatcher.getRun(run.id).status, "failed");
    assert.equal(f.checkpoints.get(PROFILE_ID, f.sessions.session.id), null);
    await f.coordinator.send({ operationId: "unknown-2", sessionKey: SESSION_KEY, prompt: "continue" });
    assert.equal(f.calls(), 1);
  } finally { await f.cleanup(); }
});

test("multiple bounded summary chunks finish before a queued chat can consume the checkpoint", async () => {
  const f = await compactionFixture({ rounds: 120 });
  try {
    const sent = await f.coordinator.send({ operationId: "multi-chunk", sessionKey: SESSION_KEY, prompt: "continue" });
    assert.equal(sent.disposition, "queued"); f.resolve();
    await waitUntil(() => f.dispatcher.getRun(sent.run.id).status === "running", 8000, "all summary chunks");
    assert.ok(f.calls() >= 3);
    const summaries = f.dispatcher.listRuns({ source: "compaction" });
    assert.equal(summaries.length, f.calls()); assert.ok(summaries.every(run => run.status === "completed"));
    const checkpoint = f.checkpoints.compatible(PROFILE_ID, f.sessions.session.id);
    assert.ok(checkpoint.coveredThroughSeq > 200); assert.match(JSON.stringify(checkpoint.summary), /blue triangles/u);
    const tail = f.context.transcripts.listEvents(PROFILE_ID, f.sessions.session.id)
      .filter(event => event.seq > checkpoint.coveredThroughSeq && ["user", "assistant"].includes(event.kind));
    assert.ok(tail.length > 10, "adaptive retention keeps substantially more than the old 4 KiB tail");
    assert.ok(f.context.transcripts.listEvents(PROFILE_ID, f.sessions.session.id).length >= 240);
    assert.equal(f.usageRecords.filter(row => row.source === "compaction").length, summaries.length);
  } finally { await f.cleanup(); }
});
