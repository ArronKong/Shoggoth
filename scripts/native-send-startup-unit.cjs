"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { openFixture, sendAndDrain, waitUntil: fixtureWaitUntil, FakeHost, SESSION_KEY } = require("./shoggoth-work-run-coordinator-unit.cjs");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const waitUntil = predicate => fixtureWaitUntil(predicate, 1500, "startup proof");
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test("startup stages are visible while the actual runtime work is still pending", async () => {
  const runtimeGate = deferred(), resumeGate = deferred();
  const value = await openFixture({ runtimeGate, sessionStatus: "ready", threadId: "existing",
    threads: [{ id: "existing", threadSource: null, turns: [] }] });
  const original = value.host.threadResume.bind(value.host);
  value.host.threadResume = async input => { await resumeGate.promise; return original(input); };
  const ack = await value.coordinator.send({ operationId: "startup-progress", sessionKey: SESSION_KEY, prompt: "hello" });
  const stages = () => { const sub = value.coordinator.subscribeRun(ack.run.id, { streamId: null, afterSeq: 0 }, () => {});
    sub.unsubscribe(); return sub.events.filter(e => e.type === "status").map(e => e.payload.stage).filter(Boolean); };
  try {
    await waitUntil(() => stages().includes("connecting"));
    assert.equal(value.host.turnStartCalls, 0);
    runtimeGate.resolve();
    await waitUntil(() => stages().includes("restoring"));
    assert.equal(value.host.turnStartCalls, 0);
    assert.ok(!stages().includes("waiting"), "an unsubmitted request must not look sent");
    resumeGate.resolve();
    await value.coordinator.waitForIdle(ack.run.id);
    assert.deepEqual(stages(), ["connecting", "restoring", "waiting"]);
    const sub = value.coordinator.subscribeRun(ack.run.id, { streamId: null, afterSeq: 0 }, () => {});
    assert.ok(sub.events.some(e => e.type === "performance.stage" && e.payload.stage === "session_prepare"));
    sub.unsubscribe();
  } finally { runtimeGate.resolve(); resumeGate.resolve(); await value.coordinator.close(); }
});

test("both session inventories overlap and neither can be skipped before creating a session", async () => {
  const gates = [deferred(), deferred()], entered = [];
  const host = new FakeHost([]);
  host.threadList = async input => { const i = Number(input.archived); entered.push(i); await gates[i].promise;
    return { data: [], nextCursor: null }; };
  const value = await openFixture({ host });
  const sending = sendAndDrain(value, { operationId: "parallel-session-lookup" });
  try {
    await waitUntil(() => entered.length === 2);
    assert.deepEqual(entered.sort(), [0, 1]);
    gates[0].resolve();
    await new Promise(r => setImmediate(r));
    assert.equal(host.threadStartCalls, 0, "absence in the active partition is insufficient");
    gates[1].resolve();
    const { ack } = await sending;
    assert.equal(host.threadStartCalls, 1);
    assert.equal(host.turnStartCalls, 1);
    const sub = value.coordinator.subscribeRun(ack.run.id, { streamId: null, afterSeq: 0 }, () => {});
    assert.deepEqual(sub.events.filter(event => event.type === "status" && event.payload.stage).map(event => event.payload.stage),
      ["connecting", "opening", "waiting"]);
    sub.unsubscribe();
  } finally { gates.forEach(g => g.resolve()); await sending.catch(() => {}); await value.coordinator.close(); }
});

test("a failed inventory still waits for its sibling and never creates or sends", async () => {
  const gate = deferred(); let archivedStarted = false;
  const host = new FakeHost([]);
  host.threadList = async input => {
    if (!input.archived) throw Object.assign(new Error("fixture list unavailable"), { code: "CODEX_THREAD_LIST_INVALID_RESPONSE" });
    archivedStarted = true; await gate.promise; return { data: [], nextCursor: null };
  };
  const value = await openFixture({ host });
  const sending = sendAndDrain(value, { operationId: "failed-session-lookup" });
  let settled = false;
  void sending.finally(() => { settled = true; });
  try {
    await waitUntil(() => archivedStarted);
    assert.equal(host.threadStartCalls, 0);
    assert.equal(settled, false, "a failed partition must not abandon its sibling query");
    gate.resolve();
    const { ack } = await sending;
    assert.equal(value.coordinator.getRun(ack.run.id).status, "failed");
    assert.equal(value.coordinator.getRun(ack.run.id).errorCode, "RUNTIME_START_SESSION_START_OR_RESUME_FAILED");
    assert.equal(host.threadStartCalls, 0);
    assert.equal(host.turnStartCalls, 0);
  } finally { gate.resolve(); await sending.catch(() => {}); await value.coordinator.close(); }
});

test("parallel inventories retain cross-partition conflict and archived-session protection", async () => {
  for (const conflict of [false, true]) {
    const host = new FakeHost([]);
    const value = await openFixture({ host });
    host.threadList = async input => ({ data: input.archived || conflict
      ? [{ id: "same-session", threadSource: value.sessions.binding.threadSource, archived: input.archived, turns: [] }] : [], nextCursor: null });
    try {
      await assert.rejects(sendAndDrain(value, { operationId: `partition-proof-${conflict}` }),
        { code: conflict ? "CODEX_THREAD_STATE_CONFLICT" : "CODEX_THREAD_ARCHIVED" });
      assert.equal(host.threadStartCalls, 0);
      assert.equal(host.turnStartCalls, 0);
    } finally { await value.coordinator.close(); }
  }
});

test("startup stage changes survive backend deduplication and unknown strings stay private", () => {
  const backend = Object.create(ShoggothBackend.prototype), events = [], state = {};
  const hooks = { status: data => events.push(data) };
  for (const stage of ["connecting", "connecting", "restoring", "private detail"]) backend._emitRunStatus(hooks, state, "starting", { stage });
  backend._emitRunStatus(hooks, state, "running", { stage: "waiting" });
  assert.deepEqual(events.map(e => e.stage), ["connecting", "restoring", undefined, "waiting"]);
  assert.ok(!JSON.stringify(events).includes("private detail"));
});

test("pre-admission context and capability work is preparation, while capacity waits stay queued", () => {
  const backend = Object.create(ShoggothBackend.prototype), events = [], state = {};
  const hooks = { status: data => events.push(data) };
  for (const reason of ["CONTEXT_PREPARING", "CONTEXT_PREPARING", "RUNTIME_PREPARING", "CONTEXT_COMPACTING", "GLOBAL_CAPACITY"]) {
    backend._emitRunStatus(hooks, state, "queued", { reason, queuedAt: 123 });
  }
  assert.deepEqual(events, [
    { kind: "starting", text: "starting", stage: "context" },
    { kind: "starting", text: "starting", stage: "capabilities" },
    { kind: "starting", text: "starting", stage: "compacting" },
    { kind: "queued", text: "queued", reason: "GLOBAL_CAPACITY", queuedAt: 123 },
  ]);
});

test("native compaction auth recovery stays in the activity timeline through live and snapshot status", () => {
  const backend = Object.create(ShoggothBackend.prototype), events = [], state = {};
  const hooks = { status: data => events.push(data) };
  for (const stage of [undefined, "reconnecting", "reconnecting", undefined, "private auth failure"]) {
    backend._emitRunStatus(hooks, state, "queued", { reason: "CONTEXT_COMPACTING", queuedAt: 123, stage });
  }
  assert.deepEqual(events, [
    { kind: "starting", text: "starting", stage: "compacting" },
    { kind: "starting", text: "starting", stage: "reconnecting" },
    { kind: "starting", text: "starting", stage: "compacting" },
  ]);
  assert.ok(!JSON.stringify(events).includes("private auth failure"));
});

test("slow admission preparation reports its actual stage without consuming execution capacity", async () => {
  const contextGate = deferred(), hooksGate = deferred(), contextEntered = deferred(), hooksEntered = deferred();
  let prewarmed = false;
  const value = await openFixture({ getNativeRuntimeConfig: () => ({ maxActive: 32, startupConcurrency: 8,
    flags: { runtimeAdmissionV1: true } }), contextCompiler: {
    semanticSearch: {},
    async prepareRelated() { contextEntered.resolve(); await contextGate.promise; },
    compile: () => ({ id: `ctx-${"d".repeat(64)}`, developerInstructions: "", dynamicContext: "", report: {} }),
  } });
  value.coordinator.hookService = {
    async prepareRun() { hooksEntered.resolve(); await hooksGate.promise; return null; },
    observeRun() {}, observeSession() {}, releaseRun() {}, runner: { cancelRun: async () => {} },
  };
  value.coordinator.prepareChatRuntime = async () => { prewarmed = true; };
  const sending = value.coordinator.send({ operationId: "slow-admission-preparation", sessionKey: SESSION_KEY, prompt: "hello" });
  try {
    await contextEntered.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(prewarmed, true, "process preparation overlaps complete recall");
    const run = value.dispatcher.listRuns().find(row => row.status === "queued");
    assert.ok(run);
    const read = () => value.coordinator.getRunSnapshot(run.id);
    assert.equal(read().queue?.reason, "CONTEXT_PREPARING");
    assert.equal(read().run.status, "queued", "public preparation does not change durable admission");
    assert.equal(value.host.turnStartCalls, 0);
    assert.equal(value.host.threadStartCalls, 0, "preparation never creates a session before context is complete");
    contextGate.resolve();
    await hooksEntered.promise;
    assert.equal(read().queue?.reason, "RUNTIME_PREPARING");
    assert.equal(read().run.status, "queued");
    assert.equal(value.coordinator.getRuntimeObservability().counters["runtime.admission.queued"] || 0, 0,
      "working on preparation is not a capacity-blocked queue sample");
    hooksGate.resolve();
    const ack = await sending;
    await value.coordinator.waitForIdle(ack.run.id);
    assert.equal(value.host.turnStartCalls, 1);
    const sub = value.coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, () => {});
    const stages = sub.events.filter(e => e.type === "performance.stage").map(e => e.payload.stage);
    sub.unsubscribe();
    assert.ok(stages.includes("admission_context"));
    assert.ok(stages.includes("admission_runtime"));
  } finally {
    contextGate.resolve(); hooksGate.resolve(); await sending.catch(() => {}); await value.coordinator.close();
  }
});
