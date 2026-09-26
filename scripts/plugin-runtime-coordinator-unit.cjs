"use strict";

const assert = require("node:assert/strict");
const { openFixture, sendAndDrain, recoveryStore, SESSION_KEY, RUNTIME_ACCOUNT_ID } =
  require("./shoggoth-work-run-coordinator-unit.cjs");

function projection() {
  const active = new Set();
  const captures = [];
  const releases = [];
  return { active, captures, releases,
    captureRun(run) {
      assert.equal(run.status, "starting");
      assert(!active.has(run.id), "a Run is never re-frozen while active");
      captures.push(structuredClone(run)); active.add(run.id);
    },
    releaseRun(id) { releases.push(id); active.delete(id); },
  };
}

async function main() {
  const plugins = projection();
  const value = await openFixture({ pluginRuntimeToolService: plugins });
  try {
    const { ack } = await sendAndDrain(value, { operationId: "plugin-runtime-admission" });
    const run = value.dispatcher.getRun(ack.run.id);
    assert.equal(plugins.captures.length, 1);
    assert.equal(plugins.captures[0].id, run.id);
    assert(plugins.active.has(run.id));
    const scope = await value.coordinator.invokeRuntimeCapability({ runId: run.id,
      runtimeProfileId: "runtime-default", runtimeAccountId: RUNTIME_ACCOUNT_ID }, input => {
      input.assertCurrent(); return input;
    });
    assert.equal(scope.runId, run.id, "runtime scope includes the authenticated Run identity");
    Object.assign(value.host.threads[0].turns[0], { status: "completed" });
    value.host.emit({ known: true, type: "complete", method: "turn/completed",
      threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId, status: "completed" });
    await value.coordinator.waitForIdle(run.id);
    assert.equal(value.dispatcher.getRun(run.id).status, "completed");
    assert(!plugins.active.has(run.id));
    assert(plugins.releases.includes(run.id));
    assert.throws(() => scope.assertCurrent(), error => error.code === "HOST_CAPABILITY_REVOKED");
  } finally { await value.coordinator.close(); }

  const queuedProjection = projection();
  const queued = await openFixture({ busy: true, pluginRuntimeToolService: queuedProjection });
  try {
    const { ack } = await sendAndDrain(queued, { operationId: "plugin-runtime-queued" });
    assert.equal(queued.dispatcher.getRun(ack.run.id).status, "queued");
    assert.equal(queuedProjection.active.size, 0, "queued admission retains no plugin authority");
    assert.equal(queued.host.turnStartCalls, 0);
  } finally { await queued.coordinator.close(); }

  const failure = Object.assign(new Error("fixture capture failed"), { code: "PLUGIN_STORE_CLOSED" });
  const failedProjection = projection();
  failedProjection.captureRun = () => { throw failure; };
  const failed = await openFixture({ pluginRuntimeToolService: failedProjection });
  try {
    await assert.rejects(failed.coordinator.send({ operationId: "plugin-capture-failure",
      sessionKey: SESSION_KEY, prompt: "must stay queued" }), error => error === failure);
    assert(failed.dispatcher.listRuns().every(run => run.status === "queued"),
      "capture failure occurs before durable starting admission");
    assert.equal(failed.host.turnStartCalls, 0);
    assert.equal(failed.coordinator.runExecutionContracts.size, 0);
    assert(failedProjection.releases.length > 0);
  } finally { await failed.coordinator.close(); }

  const store = recoveryStore();
  const firstProjection = projection();
  const first = await openFixture({ runExecutionStore: store, pluginRuntimeToolService: firstProjection });
  const { ack } = await sendAndDrain(first, { operationId: "plugin-no-refreeze-on-restart" });
  await first.coordinator.close();
  const threads = structuredClone(first.host.threads);
  threads[0].turns[0].status = "completed";
  const restoredProjection = projection();
  restoredProjection.captureRun = () => { throw new Error("recovery must not capture current Grants"); };
  const restored = await openFixture({ runExecutionStore: store, dispatcher: first.dispatcher,
    inbox: first.inbox, sessions: first.sessions, threads, pluginRuntimeToolService: restoredProjection });
  try {
    assert.equal(restored.dispatcher.getRun(ack.run.id).status, "completed");
    assert.equal(restored.host.turnStartCalls, 0);
    assert.equal(restoredProjection.active.size, 0);
  } finally { await restored.coordinator.close(); }
  console.log("plugin-runtime-coordinator-unit: fresh admission, failure, queue, final lease and restart isolation passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
