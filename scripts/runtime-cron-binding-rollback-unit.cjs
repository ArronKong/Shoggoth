"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { waitUntil } = require("./shoggoth-work-run-coordinator-unit.cjs");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { PROTOCOL_VERSION } = require("../app/agent-service/server");

function setHandoff(f, enabled) {
  const config = f.service.nativeRuntimeConfig.read();
  f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
    flags: { ...config.flags, runtimeConversationHandoff: enabled } });
}
function setDefault(f, runtime) {
  const state = f.service.productStore.getAgentRuntimeBindings(f.profile.id);
  f.service.productStore.setAgentDefaultBinding(f.profile.id, f.binding(runtime).id, { revision: state.revision });
}
async function cronFixture(f) {
  const ipc = (method, params) => requestService(f.paths, { id: crypto.randomUUID(),
    token: readClientToken(f.paths), version: PROTOCOL_VERSION, method, params }, { timeoutMs: 10_000 });
  const now = Date.now();
  const { job } = await ipc("cron.job.create", { operationId: crypto.randomUUID(),
    name: "Isolated Cron Binding regression", enabled: false, profileId: f.profile.id,
    prompt: "Fixture only", workspace: f.workspace, schedule: { kind: "at", at: now + 600_000 },
    misfirePolicy: "latest", maxCatchUp: 1, overlapPolicy: "skip", threadPolicy: "continue",
    threadId: null, createdAt: now });
  const trigger = async () => {
    const { run } = await ipc("cron.run.trigger", { operationId: crypto.randomUUID(),
      jobId: job.id, createdAt: Date.now() });
    await waitUntil(() => ["running", "failed", "interrupted"].includes(
      f.service.workRunCoordinator.getRun(run.id)?.status), 5000, "Cron native execution").catch(error => {
        error.message += JSON.stringify({ run: f.service.workRunCoordinator.getRun(run.id),
          schedulerError: f.service.nativeCronScheduler.lastError?.message,
          coordinatorError: f.service.workRunCoordinator.lastErrors.get(run.id)?.message });
        throw error;
      });
    const current = f.service.workRunCoordinator.getRun(run.id);
    assert.equal(current.status, "running", current.errorCode);
    return current;
  };
  trigger.setThreadHint = (threadId) => f.service.nativeCronStore.updateJobDerived({
    operationId: crypto.randomUUID(), jobId: job.id, patch: { threadId }, createdAt: Date.now(),
  });
  return trigger;
}

test("handoff disabled keeps a continuing Cron on its original Binding after the Agent default changes", async () => {
  const f = await openHandoffFixture();
  try {
    setHandoff(f, false);
    const trigger = await cronFixture(f);
    const first = await trigger();
    await f.complete(first);
    const key = f.service.workRunCoordinator.getRunSessionKey(first);
    const before = f.service.chatSessionStore.getSession(key);
    setDefault(f, "pi");
    const second = await trigger();
    assert.deepEqual(second.runtimeSessionRef, first.runtimeSessionRef);
    assert.equal(f.service.workRunCoordinator.getRunSessionKey(second), key);
    assert.equal(f.service.chatSessionStore.getSession(key).runtimeBindingId, before.runtimeBindingId);
    assert.equal(f.transport.hosts.has("pi"), false);
    await f.complete(second);
  } finally { await f.close(); }
});

test("handoff rollback preserves the selected Cron namespace even when native session IDs collide", async () => {
  const f = await openHandoffFixture();
  try {
    const trigger = await cronFixture(f);
    const first = await trigger();
    await f.complete(first);
    setDefault(f, "pi");
    const second = await trigger();
    assert.equal(second.runtimeSessionRef.runtime, "pi");
    assert.equal(second.runtimeSessionRef.sessionId, first.runtimeSessionRef.sessionId,
      "fixture deliberately returns identical native IDs in different namespaces");
    await f.complete(second);
    const key = f.service.workRunCoordinator.getRunSessionKey(second);
    const before = f.service.chatSessionStore.getSession(key);
    setHandoff(f, false);
    setDefault(f, "deepseek-harness");
    const third = await trigger();
    assert.deepEqual(third.runtimeSessionRef, second.runtimeSessionRef);
    const after = f.service.chatSessionStore.getSession(key);
    assert.equal(after.runtimeBindingId, before.runtimeBindingId);
    assert.deepEqual(after.retiredRuntimeSessions, before.retiredRuntimeSessions);
    assert.equal(f.transport.hosts.has("deepseek-harness"), false);
    assert.equal(f.transport.hosts.get("pi").threadStartCalls, 1);
    await f.complete(third);
  } finally { await f.close(); }
});

test("disabling handoff after a Cron switch but before its first send still creates the selected fresh session", async () => {
  const f = await openHandoffFixture();
  try {
    const trigger = await cronFixture(f);
    const first = await trigger();
    await f.complete(first);
    const key = f.service.workRunCoordinator.getRunSessionKey(first);
    await f.switch(key, "pi");
    setHandoff(f, false);
    const second = await trigger();
    assert.equal(second.runtimeSessionRef.runtime, "pi");
    assert.equal(f.service.workRunCoordinator.getRunSessionKey(second), key);
    assert.equal(f.transport.hosts.get("pi").threadStartCalls, 1);
    assert.equal(f.transport.hosts.get("codex").turnStartCalls, 1);
    await f.complete(second);
  } finally { await f.close(); }
});

test("an explicit legacy Cron thread hint cannot overwrite its conversation after handoff", async () => {
  const f = await openHandoffFixture();
  try {
    const acquire = f.service.workRunCoordinator.runtimeManager.acquire.bind(f.service.workRunCoordinator.runtimeManager);
    f.service.workRunCoordinator.runtimeManager.acquire = async (...args) => {
      const host = await acquire(...args);
      const raw = f.transport.hosts.get("pi");
      if (args[0].runtime === "pi" && raw.threadStartCalls === 0) raw.threadStartCalls = 1;
      return host;
    };
    const trigger = await cronFixture(f);
    const first = await trigger();
    await f.complete(first);
    trigger.setThreadHint(first.runtimeSessionRef.sessionId);
    setDefault(f, "pi");
    const second = await trigger();
    assert.equal(second.runtimeSessionRef.runtime, "pi");
    assert.notEqual(second.runtimeSessionRef.sessionId, first.runtimeSessionRef.sessionId);
    await f.complete(second);
    const third = await trigger();
    assert.deepEqual(third.runtimeSessionRef, second.runtimeSessionRef,
      "job.threadId is only an initial hint; the selected conversation owns subsequent native IDs");
    await f.complete(third);
  } finally { await f.close(); }
});
