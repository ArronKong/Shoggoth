"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { GroupActivityProjection } = require("../app/agent-service/group-activity");

test("real Service Run stream carries only bound explicit compaction events into group activity", async () => {
  const f = await openHandoffFixture();
  try {
    const config = f.service.nativeRuntimeConfig.read();
    f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
      flags: { ...config.flags, runtimeContextLifecycleV1: true } });
    const session = f.createSession(), run = await f.send(session.sessionKey, "group-compaction");
    assert.equal(run.status, "running", run.errorCode);
    const host = f.transport.hosts.get("codex"), coordinator = f.service.workRunCoordinator;
    const projection = new GroupActivityProjection({ groupId: "g", memberId: "m", opportunityId: "o", runId: run.id,
      executionGeneration: "bound-test-execution" });
    const observed = [];
    const subscription = coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, event => {
      observed.push(event); projection.observeEvents([event], event.streamId);
    });
    const native = run.runtimeSessionRef.sessionId, turn = run.runtimeTurnRef.turnId;
    // This is the same generic status envelope emitted by Claude system/status.
    const generic = status => ({ known: true, type: "status", sessionId: native, turnId: turn, status });
    host.emit(generic("compacting")); assert.equal(projection.snapshot().phase, "compacting");
    const observedAt = Date.now();
    // Codex/Pi explicitly report completion without guaranteeing a start event.
    const compacted = { known: true, type: "context_compacted", threadId: native, turnId: null,
      contextUsage: { runtimeSessionId: native, usedTokens: null, contextWindow: null,
        quality: "unknown", source: "runtime_event", observedAt } };
    host.emit({ ...compacted, threadId: "another-session" });
    host.emit({ ...compacted, turnId: "another-turn" });
    assert.equal(projection.snapshot().phase, "compacting");
    host.emit(compacted); assert.equal(projection.snapshot().phase, "compacted");
    assert.equal(projection.snapshot().compaction.status, "compacted");
    const matching = () => observed.filter(event => event.type === "status" && event.payload.status === "compacted");
    assert.equal(matching().length, 1);
    assert.equal(matching()[0].runId, run.id); assert.equal(matching()[0].streamId, subscription.streamId);
    host.emit({ known: true, type: "tool_start", threadId: native, turnId: turn, toolCallId: "after-compaction",
      tool: { name: "read_file", input: { path: "source.txt" } } });
    assert.equal(projection.snapshot().phase, "tool");
    const progressAt = projection.snapshot().lastProgressAt, firstObservedAt = projection.snapshot().compaction.observedAt;
    host.emit(compacted);
    assert.equal(projection.snapshot().lastProgressAt, progressAt, "repeated completion observations are not new business progress");
    assert.equal(projection.snapshot().phase, "tool", "unkeyed completion observation cannot replace resumed work");
    assert.equal(projection.snapshot().compaction.observedAt, firstObservedAt);
    host.emit(generic("compacting")); host.emit(compacted);
    assert.equal(projection.snapshot().phase, "compacted", "a newly observed start and completion form a new cycle");
    const before = projection.snapshot().compaction;
    await f.complete(run);
    assert.equal(projection.snapshot().phase, "completed");
    const count = observed.length;
    host.emit(generic("compacting")); host.emit({ ...compacted, contextUsage: { ...compacted.contextUsage, observedAt: observedAt + 1 } });
    assert.equal(observed.length, count, "terminal run cannot receive late progress");
    assert.deepEqual(projection.snapshot().compaction, before);
    subscription.unsubscribe?.();
  } finally { await f.close(); }
});
