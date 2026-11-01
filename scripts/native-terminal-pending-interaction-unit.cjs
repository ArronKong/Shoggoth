#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { LEGAL_WORK_RUN_TRANSITIONS } = require("../app/agent-service/work-run");
const { openFixture, sendAndDrain, waitUntil, FakeHost, directRuntimeManager,
  PROFILE_ID, RUNTIME_ACCOUNT_ID } = require("./shoggoth-work-run-coordinator-unit.cjs");

async function pendingInteraction(t, { input = false, ...options } = {}) {
  const host = new FakeHost([], { accountReadSupported: false });
  const interactions = [], events = [], scheduled = new Set();
  const value = await openFixture({ runtime: "antigravity", host,
    runtimeManager: directRuntimeManager(host, "antigravity"), terminalRetryDelaysMs: [0],
    promptScheduler: { set(callback) { const handle = { callback }; scheduled.add(handle); return handle; },
      clear(handle) { scheduled.delete(handle); } },
    onRunInteraction(run, interaction) { interactions.push({ status: run.status, ...interaction }); },
    ...options });
  t.after(() => value.coordinator.close());
  // The ordinary fixture dispatcher accepts every state transition. Enforce the
  // production state machine so waiting -> completed cannot silently pass here.
  const transition = value.dispatcher.transition.bind(value.dispatcher);
  value.dispatcher.transition = (id, status, patch) => {
    const current = value.dispatcher.getRun(id);
    if (!LEGAL_WORK_RUN_TRANSITIONS[current.status]?.has(status)) {
      throw Object.assign(new Error("production transition rejected"), { code: "INVALID_WORK_RUN_TRANSITION" });
    }
    return transition(id, status, patch);
  };
  const { ack } = await sendAndDrain(value, { operationId: `pending-native-terminal-${input ? "input" : "device"}` });
  const run = value.coordinator.getRun(ack.run.id);
  const turn = host.threads.find(thread => thread.id === run.runtimeSessionRef.sessionId).turns
    .find(candidate => candidate.id === run.runtimeTurnRef.turnId);
  value.coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, event => events.push(event));
  let executions = 0, outcome;
  const pending = input ? host.request("mcpServer/elicitation/request", {
    threadId: run.runtimeSessionRef.sessionId, turnId: turn.id, serverName: "fixture",
    message: "Fixture input", requestedSchema: { type: "object", properties: { answer: { type: "string" } } },
  }) : value.coordinator.invokeRuntimeCapability({ runtimeProfileId: "runtime-default",
    runtimeAccountId: RUNTIME_ACCOUNT_ID, runId: run.id }, async scope => {
    const approval = await value.coordinator.requestToolApproval({ ...scope, runId: run.id,
      profileId: PROFILE_ID, toolName: "apple_reminders_delete", packageName: "提醒事项",
      purpose: "device", arguments: { id: "fixture-reminder", expectedRevision: "a".repeat(64) } });
    scope.assertCurrent();
    if (approval.approved) executions++;
    return approval;
  });
  const settled = pending.then(result => { outcome = result; return result; }, error => {
    outcome = { errorCode: error.code }; return outcome;
  });
  await waitUntil(() => value.coordinator.getRun(run.id).status === (input ? "waiting_input" : "waiting_approval"),
    1000, "pending native-terminal interaction");
  const requestId = value.coordinator.getRun(run.id).waitingRequestId;
  const complete = (status = "completed") => host.emit({ known: true, type: "complete", method: "session/prompt",
    threadId: run.runtimeSessionRef.sessionId, turnId: turn.id, status });
  const text = "The device operation did not run; its approval is still unanswered.";
  const final = () => host.emit({ known: true, type: "text", method: "session/update",
    threadId: run.runtimeSessionRef.sessionId, turnId: turn.id, text, phase: "final_answer", delivery: "local" });
  const confirm = (status = "completed") => {
    turn.status = status;
    turn.items.push({ type: "agentMessage", text, phase: "final_answer" });
  };
  return { ...value, run, turn, interactions, events, scheduled, requestId, settled, complete, final, confirm,
    outcome: () => outcome, executions: () => executions };
}

test("verified Antigravity terminal cancels an unanswered device approval before completing", async t => {
  const value = await pendingInteraction(t);
  value.host.emit({ known: true, type: "tool_result", method: "session/update",
    threadId: value.run.runtimeSessionRef.sessionId, turnId: value.turn.id, toolCallId: "fixture-delete",
    tool: { name: "apple_reminders_delete", status: "failed", success: false,
      errorCode: "ANTIGRAVITY_NATIVE_TOOL_RESULT_UNAVAILABLE" } });
  value.confirm(); value.final(); value.complete();
  const terminal = await value.coordinator.waitForIdle(value.run.id);
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.errorCode, null);
  assert.equal(terminal.waitingRequestId, null);
  assert.equal(terminal.resultSummary, "The device operation did not run; its approval is still unanswered.");
  assert.equal((await value.settled).errorCode, "HOST_CAPABILITY_REVOKED");
  assert.equal(value.executions(), 0);
  assert.equal(value.coordinator.getMemoryStats().pendingRequests, 0);
  assert.equal(value.scheduled.size, 0);
  assert.deepEqual(value.interactions.map(event => event.phase), ["requested", "resolved"]);
  assert.equal(value.events.filter(event => event.type === "terminal").length, 1);
  assert.equal(value.host.turnStartCalls, 1, "the original operation is not replayed");
  await assert.rejects(value.coordinator.respondApproval({ operationId: "late-device-approve", runId: value.run.id,
    requestId: value.requestId, choice: "once" }), { code: "WORK_RUN_REQUEST_MISMATCH" });
  assert.equal(value.executions(), 0);
  const resumed = value.log.indexOf("dispatcher.transition:running", value.log.indexOf("dispatcher.transition:waiting_approval"));
  assert.ok(resumed >= 0, "the waiting state must be cleared through a legal running transition");
  assert.ok(resumed < value.log.lastIndexOf("dispatcher.transition:completed"));
});

test("verified terminal cancels pending input without submitting an answer", async t => {
  const value = await pendingInteraction(t, { input: true });
  value.confirm(); value.complete();
  assert.equal((await value.coordinator.waitForIdle(value.run.id)).status, "completed");
  assert.deepEqual(await value.settled, { action: "cancel" });
  assert.equal(value.coordinator.getMemoryStats().pendingRequests, 0);
  await assert.rejects(value.coordinator.respondInput({ operationId: "late-input", runId: value.run.id,
    requestId: value.requestId, action: "submit", answers: { answer: "late" } }), { code: "WORK_RUN_REQUEST_MISMATCH" });
});

test("a displayed final and completion signal do not cancel approval until history proves the terminal", async t => {
  const retries = [];
  const value = await pendingInteraction(t, { terminalRetryDelaysMs: [1], terminalRetryScheduler: {
    set(callback) { const handle = { callback }; retries.push(handle); return handle; }, clear() {},
  } });
  value.final(); value.complete();
  await waitUntil(() => retries.length === 1, 1000, "history observation retry");
  assert.equal(value.coordinator.getRun(value.run.id).status, "waiting_approval");
  assert.equal(value.coordinator.getMemoryStats().pendingRequests, 1);
  assert.equal(value.outcome(), undefined);
  assert.deepEqual(value.interactions.map(event => event.phase), ["requested"]);
  value.confirm(); retries[0].callback();
  assert.equal((await value.coordinator.waitForIdle(value.run.id)).status, "completed");
  assert.equal((await value.settled).errorCode, "HOST_CAPABILITY_REVOKED");
  assert.equal(value.executions(), 0);
});

test("a completed turn with the wrong operation cannot settle the current approval", async t => {
  const value = await pendingInteraction(t);
  value.confirm(); value.final();
  value.turn.items.find(item => item.type === "userMessage").clientId = "foreign-operation";
  value.complete();
  await assert.rejects(value.coordinator.waitForIdle(value.run.id), { code: "CODEX_TERMINAL_OPERATION_MISMATCH" });
  assert.equal(value.coordinator.getRun(value.run.id).status, "waiting_approval");
  assert.equal(value.coordinator.getMemoryStats().pendingRequests, 1);
  assert.equal(value.outcome(), undefined);
  assert.equal(value.executions(), 0);
  assert.deepEqual(value.interactions.map(event => event.phase), ["requested"]);
});
