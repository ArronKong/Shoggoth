#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { openFixture, FakeHost, waitUntil, recoveryStore, SESSION_KEY } = require("./shoggoth-work-run-coordinator-unit.cjs");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(options = {}) {
  const host = new FakeHost([], { threads: [{ id: "compact-thread", threadSource: null, turns: [] }] });
  host.compactCalls = 0;
  host.stopCalls = 0;
  host.threadCompactStart = async params => {
    assert.deepEqual(params, { threadId: "compact-thread" });
    host.compactCalls += 1;
    if (options.rpcError) throw new Error("private-rpc-error");
    return {};
  };
  host.stop = async () => {
    host.stopCalls += 1;
    if (options.stopGate) await options.stopGate.promise;
    if (options.stopError) throw new Error("private-stop-error");
    host.termination.resolve();
  };
  const f = await openFixture({ ...options, host, sessionStatus: "ready", threadId: "compact-thread" });
  const send = () => f.coordinator.send({ operationId: "compact-request", sessionKey: SESSION_KEY, prompt: "/compact" });
  return { ...f, send, complete(type = "context_compacted", threadId = "compact-thread") {
    host.emit({ known: true, type, threadId, ...(type === "usage" ? {
      usage: { inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0,
        outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 10 }, modelContextWindow: 100,
    } : {}) });
  } };
}

for (const evidence of ["context_compacted", "usage"]) {
  test(`Codex /compact acknowledgement waits for session-scoped ${evidence} evidence`, async () => {
    const f = await fixture();
    try {
      const ack = await f.send();
      await waitUntil(() => f.host.compactCalls === 1, 1000, "compact dispatch");
      assert.equal(f.coordinator.getRun(ack.run.id).status, "running");
      assert.equal(f.coordinator.getRun(ack.run.id).runtimeTurnRef, null);
      assert.equal(f.host.turnStartCalls, 0);
      f.complete(evidence, "another-session");
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.coordinator.getRun(ack.run.id).status, "running");
      f.complete(evidence);
      await f.coordinator.waitForIdle(ack.run.id);
      assert.equal(f.coordinator.getRun(ack.run.id).status, "completed");
      assert.equal(f.host.stopCalls, 0);
      assert.equal(f.coordinator.manualCompactions.size, 0);
      assert.equal(f.coordinator.getMemoryStats().runHostAssignments, 0);
    } finally { await f.coordinator.close(); }
  });
}

test("cancel holds capacity until the concrete Codex host confirms exit", async () => {
  const stopGate = deferred();
  const f = await fixture({ stopGate });
  try {
    const ack = await f.send();
    await waitUntil(() => f.host.compactCalls === 1, 1000, "compact dispatch");
    const cancel = f.coordinator.abort({ operationId: "cancel-compact", sessionKey: SESSION_KEY, runId: ack.run.id });
    await waitUntil(() => f.host.stopCalls === 1, 1000, "host stop");
    assert.equal(f.coordinator.getRun(ack.run.id).status, "running");
    assert.equal(f.coordinator.getMemoryStats().runHostAssignments, 1);
    stopGate.resolve();
    assert.equal((await cancel).status, "canceled");
    assert.equal(f.coordinator.getMemoryStats().runHostAssignments, 0);
    assert.equal(f.host.turnInterruptCalls, 0, "compact has no native turn id to interrupt");
  } finally { stopGate.resolve(); await f.coordinator.close(); }
});

for (const [name, options, code] of [
  ["timeout", { manualCompactionTimeoutMs: 20 }, "RUNTIME_COMPACTION_TIMEOUT"],
  ["RPC failure", { rpcError: true }, "RUNTIME_COMPACTION_ACCEPTANCE_UNKNOWN"],
]) {
  test(`${name} stops native compaction before releasing the run`, async () => {
    const f = await fixture(options);
    try {
      const ack = await f.send();
      await f.coordinator.waitForIdle(ack.run.id);
      const run = f.coordinator.getRun(ack.run.id);
      assert.equal(run.status, "interrupted");
      assert.equal(run.errorCode, code);
      assert.equal(f.host.stopCalls, 1);
      assert.equal(f.coordinator.getMemoryStats().runHostAssignments, 0);
    } finally { await f.coordinator.close(); }
  });
}

test("restart never redispatches a compact whose native acceptance is unknown", async () => {
  const store = recoveryStore();
  const first = await fixture({ runExecutionStore: store });
  const ack = await first.send();
  await waitUntil(() => first.host.compactCalls === 1, 1000, "compact dispatch");
  await first.coordinator.close();
  assert.equal(first.host.stopCalls, 1);
  const second = await fixture({ runExecutionStore: store, dispatcher: first.dispatcher,
    inbox: first.inbox, sessions: first.sessions });
  try {
    await Promise.allSettled(await second.coordinator.recover());
    await second.coordinator.waitForIdle(ack.run.id);
    assert.equal(second.host.compactCalls, 0);
    assert.equal(second.host.turnStartCalls, 0);
    assert.equal(second.coordinator.getRun(ack.run.id).status, "interrupted");
  } finally { await second.coordinator.close(); }
});

test("native exit interrupts acknowledged compaction without waiting for the timeout", async () => {
  const f = await fixture();
  try {
    const ack = await f.send();
    await waitUntil(() => f.host.compactCalls === 1, 1000, "compact dispatch");
    f.host.termination.resolve();
    await f.coordinator.waitForIdle(ack.run.id);
    assert.equal(f.coordinator.getRun(ack.run.id).status, "interrupted");
    assert.equal(f.coordinator.getMemoryStats().runHostAssignments, 0);
  } finally { await f.coordinator.close(); }
});

test("unconfirmed native stop poisons admission and retains the running assignment", async () => {
  const f = await fixture({ stopError: true });
  try {
    const ack = await f.send();
    await waitUntil(() => f.host.compactCalls === 1, 1000, "compact dispatch");
    await assert.rejects(f.coordinator.abort({ operationId: "stop-unconfirmed",
      sessionKey: SESSION_KEY, runId: ack.run.id }), { code: "RUNTIME_STOP_UNCONFIRMED" });
    assert.equal(f.dispatcher.getRun(ack.run.id).status, "running");
    assert.equal(f.coordinator.runHostAssignments.size, 1);
    await assert.rejects(f.coordinator.send({ operationId: "no-new-admission",
      sessionKey: SESSION_KEY, prompt: "hold" }), { code: "RUNTIME_STOP_UNCONFIRMED" });
  } finally { await f.coordinator.close(); }
});
