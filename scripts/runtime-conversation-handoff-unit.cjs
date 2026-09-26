#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { waitUntil } = require("./shoggoth-work-run-coordinator-unit.cjs");

test("real stores preserve one conversation across Codex → Pi → DSH → Codex and same-Binding fresh session", async () => {
  const f = await openHandoffFixture();
  try {
    const session = f.createSession();
    const ids = [];
    for (const [index, runtime] of ["codex", "pi", "deepseek-harness", "codex", "codex"].entries()) {
      if (index) {
        const before = f.transport.acquisitions.length;
        await f.switch(session.sessionKey, runtime);
        assert.equal(f.transport.acquisitions.length, before, "switch must not start/acquire a native session");
        const changed = f.service.chatSessionStore.getSession(session.sessionKey);
        assert.equal(changed.runtimeSessionId, null);
        assert.equal(changed.id, session.id);
        assert.equal(changed.profileId, session.profileId);
        assert.equal(changed.retiredRuntimeSessions.length, index);
      }
      const run = await f.send(session.sessionKey, `chain-${index}`, `UNIQUE HISTORY MARKER ${index}`);
      assert.equal(run.status, "running", `${runtime}: ${run.errorCode}`);
      assert.equal(run.runtimeSessionRef.runtime, runtime);
      const ref = `${runtime}/${run.runtimeSessionRef.sessionId}`;
      assert.equal(ids.includes(ref), false, "retired native sessions must never resume");
      ids.push(ref);
      const execution = f.transport.acquisitions.at(-1).options.executionContract;
      if (index) {
        assert.match(execution.dynamicContext, /UNTRUSTED RUNTIME HANDOFF DATA/u);
        assert.match(execution.dynamicContext, new RegExp(`UNIQUE HISTORY MARKER ${index - 1}`, "u"));
        assert.equal(execution.contextLifecycleV1, true);
      }
      await f.complete(run, `PRESERVED ANSWER ${index}`);
    }
    const codex = f.transport.hosts.get("codex");
    assert.equal(codex.threadStartCalls, 3);
    assert.equal(codex.resumeCalls, 0);
    const events = f.service.transcriptStore.listEvents(session.profileId, session.id);
    for (let index = 0; index < 5; index++) {
      assert.ok(events.some(e => e.kind === "user" && e.content.text === `UNIQUE HISTORY MARKER ${index}`));
      assert.ok(events.some(e => e.kind === "assistant" && e.content.text === `PRESERVED ANSWER ${index}`));
    }
    const audits = events.filter(e => e.content.transcriptType === "runtime.switched");
    assert.equal(audits.length, 4);
    assert.ok(audits.every(e => e.contextExcluded && !Object.hasOwn(e.content, "text")));
    assert.equal(f.service.workRunCoordinator.getMemoryStats().runHostAssignments, 0);
  } finally { await f.close(); }
});

test("busy and pending approval forbid switching; cancel does not transfer approval to the fresh session", async () => {
  const f = await openHandoffFixture();
  try {
    const session = f.createSession();
    const first = await f.send(session.sessionKey, "old-approval");
    const raw = f.transport.hosts.get("codex");
    const pending = raw.request("item/fileChange/requestApproval", { threadId: first.runtimeSessionRef.sessionId,
      turnId: first.runtimeTurnRef.turnId, itemId: "old-change", startedAtMs: 1, grantRoot: null, reason: null }, "old-request");
    await waitUntil(() => f.service.workRunCoordinator.getRun(first.id).status === "waiting_approval", 1000, "approval");
    const requestId = f.service.workRunCoordinator.getRun(first.id).waitingRequestId;
    const before = f.service.chatSessionStore.getSession(session.sessionKey);
    await assert.rejects(f.switch(session.sessionKey, "pi"), { code: "SESSION_BUSY" });
    assert.deepEqual(f.service.chatSessionStore.getSession(session.sessionKey), before);
    await f.service.workRunCoordinator.abort({ operationId: "cancel-before-switch", sessionKey: session.sessionKey, runId: first.id });
    assert.deepEqual(await pending, { decision: "cancel" });
    await f.switch(session.sessionKey, "codex");
    const second = await f.send(session.sessionKey, "after-cancel");
    assert.notEqual(second.runtimeSessionRef.sessionId, first.runtimeSessionRef.sessionId);
    await assert.rejects(f.service.workRunCoordinator.respondApproval({ operationId: "old-approval-new-run",
      runId: second.id, requestId, choice: "once" }), { code: "WORK_RUN_REQUEST_MISMATCH" });
    assert.equal(f.service.workRunCoordinator.getMemoryStats().pendingRequests, 0);
    await f.complete(second);
  } finally { await f.close(); }
});

test("crash before CAS preserves the old binding; crash after CAS repairs one audit and never dispatches", async () => {
  let f = await openHandoffFixture();
  try {
    const session = f.createSession();
    await f.complete(await f.send(session.sessionKey, "before-cas"));
    const before = f.service.chatSessionStore.getSession(session.sessionKey);
    const switchRuntime = f.service.chatSessionStore.switchRuntime.bind(f.service.chatSessionStore);
    f.service.chatSessionStore.switchRuntime = () => { throw new Error("fixture before CAS"); };
    await assert.rejects(f.switch(session.sessionKey, "pi"), /fixture before CAS/u);
    assert.deepEqual(f.service.chatSessionStore.getSession(session.sessionKey), before);
    f.service.chatSessionStore.switchRuntime = switchRuntime;
    f.service.chatSessionStore.markRuntimeSwitchAudited = () => { throw new Error("fixture after CAS"); };
    await assert.rejects(f.switch(session.sessionKey, "pi"), /fixture after CAS/u);
    assert.equal(f.service.chatSessionStore.getSession(session.sessionKey).runtimeBindingId, f.binding("pi").id);
    assert.equal(f.service.chatSessionStore.listPendingRuntimeSwitches().length, 1);
    const old = f;
    await old.close({ remove: false });
    f = await openHandoffFixture({ root: old.root, transport: old.transport });
    assert.equal(f.service.chatSessionStore.listPendingRuntimeSwitches().length, 0);
    assert.equal(f.transport.hosts.has("pi"), false);
    const events = f.service.transcriptStore.listEvents(session.profileId, session.id);
    assert.equal(events.filter(e => e.content.transcriptType === "runtime.switched").length, 1);
    const next = await f.send(session.sessionKey, "after-cas-restart");
    assert.equal(next.status, "running", next.errorCode);
    assert.equal(next.runtimeSessionRef.runtime, "pi");
    await f.complete(next);
    assert.equal(f.transport.hosts.get("pi").threadStartCalls, 1);
  } finally { await f.close(); }
});

for (const boundary of ["inbox", "execution", "binding-pending", "binding-complete", "running"]) {
  test(`restart after first handoff send persisted ${boundary} never duplicates a native turn`, async () => {
    let f = await openHandoffFixture();
    try {
      const session = f.createSession();
      await f.complete(await f.send(session.sessionKey, `initial-${boundary}`));
      await f.switch(session.sessionKey, "pi");
      const coordinator = f.service.workRunCoordinator;
      const [object, method, matches] = {
        inbox: [f.service.pendingCommandInbox, "enqueue", () => true],
        execution: [coordinator.runExecutionStore, "put", () => true],
        "binding-pending": [f.service.chatSessionStore, "requestBinding", () => true],
        "binding-complete": [f.service.chatSessionStore, "completeBinding", () => true],
        running: [f.service.productStore, "putWorkRun", run => run.status === "running"],
      }[boundary];
      const original = object[method].bind(object);
      let cut = false;
      const after = args => {
        if (!cut && matches(...args)) { cut = true; coordinator.close().catch(() => {}); }
      };
      object[method] = function (...args) {
        const result = original(...args);
        if (result?.then) return result.then(value => { after(args); return value; });
        after(args); return result;
      };
      const operationId = `cut-${boundary}`;
      try { await f.send(session.sessionKey, operationId); } catch (error) {
        assert.ok(["WORK_RUN_COORDINATOR_CLOSING", "WORK_RUN_COORDINATOR_CLOSED"].includes(error.code), error.code);
      }
      await coordinator.close();
      assert.equal(cut, true);
      const old = f;
      await old.close({ remove: false });
      f = await openHandoffFixture({ root: old.root, transport: old.transport });
      const runs = f.service.workRunCoordinator.listSessionRuns(session.sessionKey)
        .filter(run => run.idempotencyKey === `shoggoth:chat-send:${operationId}`);
      assert.ok(runs.length <= 1);
      const run = runs[0];
      if (run) await f.service.workRunCoordinator.waitForIdle(run.id);
      const actual = run && f.service.workRunCoordinator.getRun(run.id);
      const nativeCount = f.transport.hosts.get("pi")?.turnStartCalls ?? 0;
      assert.ok(nativeCount <= 1, `${boundary} sent ${nativeCount} turns`);
      assert.ok(f.service.workRunCoordinator.listSessionRuns(session.sessionKey)
        .filter(run => ["starting", "running", "waiting_approval", "waiting_input"].includes(run.status)).length <= 1);
      if (actual?.status === "running") await f.complete(actual);
      // Repeat the durable operation after recovery; it must stay idempotent.
      try { await f.send(session.sessionKey, operationId); } catch (error) {
        assert.equal(error.code, "PENDING_COMMAND_IDEMPOTENCY_CONFLICT");
      }
      assert.equal(f.transport.hosts.get("pi")?.turnStartCalls ?? 0, nativeCount);
    } finally { await f.close(); }
  });
}

test("non-default frozen Binding survives a default change and restart without replay", async () => {
  let f = await openHandoffFixture();
  try {
    const session = f.createSession();
    await f.complete(await f.send(session.sessionKey, "frozen-initial"));
    await f.switch(session.sessionKey, "pi");
    const run = await f.send(session.sessionKey, "frozen-pi-run");
    const raw = f.transport.hosts.get("pi");
    const turn = raw.threads.find(t => t.id === run.runtimeSessionRef.sessionId).turns[0];
    turn.status = "completed";
    turn.items.push({ type: "agentMessage", id: "during-crash", text: "native terminal while Service unavailable" });
    const bindings = f.service.productStore.getAgentRuntimeBindings(f.profile.id);
    f.service.productStore.setAgentDefaultBinding(f.profile.id, f.binding("deepseek-harness").id,
      { revision: bindings.revision });
    const old = f;
    await old.close({ remove: false });
    f = await openHandoffFixture({ root: old.root, transport: old.transport });
    await f.service.workRunCoordinator.waitForIdle(run.id);
    const restored = f.service.workRunCoordinator.getRun(run.id);
    assert.equal(restored.status, "completed", restored.errorCode);
    assert.equal(restored.runtimeSessionRef.runtime, "pi");
    assert.equal(raw.turnStartCalls, 1);
    assert.equal(f.transport.hosts.has("deepseek-harness"), false);
    assert.equal(f.service.chatSessionStore.getSession(session.sessionKey).runtimeBindingId, f.binding("pi").id);
  } finally { await f.close(); }
});

test("preflight failure and unconfirmed adjustments do not mutate the conversation", async () => {
  const f = await openHandoffFixture();
  try {
    const session = f.createSession();
    const read = f.facts.read;
    f.facts.read = async () => ({ installed: false });
    await assert.rejects(f.switch(session.sessionKey, "pi"), { code: "RUNTIME_NOT_INSTALLED" });
    assert.deepEqual(f.service.chatSessionStore.getSession(session.sessionKey), session);
    f.facts.read = read;
    const override = f.service.chatSessionStore.setModelOverride(session.sessionKey, "unavailable-model");
    await assert.rejects(f.switch(session.sessionKey, "pi", { acceptAdjustments: false }),
      { code: "SESSION_RUNTIME_CONFIRMATION_REQUIRED" });
    assert.deepEqual(f.service.chatSessionStore.getSession(session.sessionKey), override);
    await f.switch(session.sessionKey, "pi");
    assert.equal(f.service.chatSessionStore.getSession(session.sessionKey).modelOverride, null);
    assert.equal(f.transport.acquisitions.length, 0);
  } finally { await f.close(); }
});

test("pending inbox encryption blocks switching and a newer model setting invalidates preflight CAS", async () => {
  const f = await openHandoffFixture();
  let releaseInbox, releaseFacts;
  try {
    const session = f.createSession();
    const enqueue = f.service.pendingCommandInbox.enqueue.bind(f.service.pendingCommandInbox);
    const inboxGate = new Promise(resolve => { releaseInbox = resolve; });
    let entered = false;
    f.service.pendingCommandInbox.enqueue = async input => { entered = true; await inboxGate; return enqueue(input); };
    const sending = f.service.workRunCoordinator.send({ operationId: "pending-inbox", sessionKey: session.sessionKey, prompt: "hold" });
    await waitUntil(() => entered, 1000, "inbox encryption gap");
    await assert.rejects(f.switch(session.sessionKey, "pi"), { code: "SESSION_BUSY" });
    releaseInbox();
    const ack = await sending;
    await f.service.workRunCoordinator.waitForIdle(ack.run.id);
    await f.complete(f.service.workRunCoordinator.getRun(ack.run.id));
    const read = f.facts.read;
    const factsGate = new Promise(resolve => { releaseFacts = resolve; });
    entered = false;
    f.facts.read = async (...args) => { entered = true; await factsGate; return read(...args); };
    const switching = f.switch(session.sessionKey, "pi");
    await waitUntil(() => entered, 1000, "support preflight gap");
    const newer = f.service.chatSessionStore.setModelOverride(session.sessionKey, "new-user-choice");
    releaseFacts();
    await assert.rejects(switching, { code: "CHAT_SESSION_REVISION_CONFLICT" });
    assert.deepEqual(f.service.chatSessionStore.getSession(session.sessionKey), newer);
  } finally { releaseInbox?.(); releaseFacts?.(); await f.close(); }
});
