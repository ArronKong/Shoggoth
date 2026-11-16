#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { waitUntil } = require("./shoggoth-work-run-coordinator-unit.cjs");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
const { PROTOCOL_VERSION } = require("../app/agent-service/server");

test("Cron and chat renew the same Antigravity conversation after failed checkpoints", async () => {
  const f = await openHandoffFixture();
  try {
    const { productStore, chatSessionStore, transcriptStore, workRunCoordinator: coordinator } = f.service;
    const { binding } = productStore.addAgentRuntimeBinding(f.profile.id, { runtime: "antigravity",
      runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID }, { operationId: "fixture-antigravity-cron" });
    productStore.setAgentDefaultBinding(f.profile.id, binding.id,
      { revision: productStore.getAgentRuntimeBindings(f.profile.id).revision });
    const config = f.service.nativeRuntimeConfig.read();
    f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
      flags: { ...config.flags, runtimeConversationHandoff: false } });

    const id = crypto.randomUUID;
    const ipc = (method, params) => requestService(f.paths, { id: id(), token: readClientToken(f.paths),
      version: PROTOCOL_VERSION, method, params });
    const { job } = await ipc("cron.job.create", { operationId: id(), createdAt: Date.now(), enabled: false,
      name: "Antigravity checkpoint recovery", profileId: f.profile.id, workspace: f.workspace,
      prompt: "Produce the first report", schedule: { kind: "at", at: Date.now() + 60_000 },
      overlapPolicy: "skip", misfirePolicy: "latest", maxCatchUp: 1 });
    const trigger = async (operationId = id(), createdAt = Date.now()) => (await ipc("cron.run.trigger",
      { operationId, createdAt, jobId: job.id })).run;
    const running = async run => {
      await waitUntil(() => {
        const current = coordinator.getRun(run.id);
        return current && !["queued", "starting"].includes(current.status);
      }, 5000, "Run admission");
      const current = coordinator.getRun(run.id);
      assert.equal(current.status, "running", current.errorCode);
      return current;
    };
    const setPrompt = prompt => ipc("cron.job.update", { operationId: id(), jobId: job.id,
      patch: { prompt }, createdAt: Date.now() });
    const first = await running(await trigger());
    const key = coordinator.getRunSessionKey(first);
    const session = chatSessionStore.getSession(key);
    const host = f.transport.hosts.get("antigravity");
    const failCheckpoint = async (run, errorCode) => {
      const nativeSessionId = run.runtimeSessionRef.sessionId;
      const thread = host.threads.find(item => item.id === nativeSessionId);
      const turn = thread.turns.find(item => item.id === run.runtimeTurnRef.turnId);
      turn.status = "failed";
      turn.errorCode = errorCode;
      host.emit({ known: true, type: "complete", threadId: nativeSessionId, turnId: turn.id, status: "failed", errorCode });
      await coordinator.waitForIdle(run.id);
      assert.equal(coordinator.getRun(run.id).errorCode, errorCode);
      coordinator.runtimeManager.hasFailedContextCheckpoint = (owner, candidateId) => (
        owner.runtime === binding.runtime && owner.runtimeAccountId === binding.runtimeAccountId && candidateId === nativeSessionId);
    };
    const oldNativeId = first.runtimeSessionRef.sessionId;
    const oldThread = host.threads.find(thread => thread.id === oldNativeId);
    assert.equal(oldThread.threadSource, chatSessionStore.getBinding(key).threadSource,
      "Cron uses the normal durable conversation binding even with handoff disabled");
    await f.complete(first, "LAST KNOWN GOOD REPORT");
    await f.complete(await running(await trigger()), "NO_REPLY");

    await setPrompt("OLD FAILED PROMPT");
    const failedOperation = id(), failedAt = Date.now();
    const failed = await running(await trigger(failedOperation, failedAt));
    // Simulate a terminal saved by older builds when nested checkpoint errors
    // were still classified as region errors.
    await failCheckpoint(failed, "ANTIGRAVITY_REGION_UNSUPPORTED");
    assert.equal((await trigger(failedOperation, failedAt)).id, failed.id);
    assert.equal(host.turnStartCalls, 3, "a terminal occurrence is never replayed");

    await setPrompt("RUN ONLY THIS NEW PROMPT");
    chatSessionStore.setPermissionMode(key, "request-approval");
    const recovered = await running(await trigger());
    const contract = coordinator.runExecutionContracts.get(recovered.id);
    assert.equal(coordinator.getRunSessionKey(recovered), key);
    assert.notEqual(recovered.runtimeSessionRef.sessionId, oldNativeId);
    assert.equal(recovered.runtimeSessionRef.runtimeAccountId, first.runtimeSessionRef.runtimeAccountId);
    assert.equal(contract.permissionMode, "full-access");
    assert.equal(host.lastTurnStartParams.permissionMode, "full");
    assert.equal(host.lastTurnStartParams.model, contract.effectiveModel);
    assert.match(contract.turnDeveloperInstructions, /Frozen permission context:.*danger-full-access/u);
    assert.equal(host.lastTurnStartParams.prompt, "RUN ONLY THIS NEW PROMPT");
    assert.match(host.lastTurnStartParams.context, /LAST KNOWN GOOD REPORT/u);
    assert.doesNotMatch(host.lastTurnStartParams.context, /OLD FAILED PROMPT|NO_REPLY/u);
    assert.equal(host.turnStartCalls, 4);
    assert.deepEqual(chatSessionStore.getSession(key).retiredRuntimeSessions.map(entry => entry.runtimeSessionId), [oldNativeId]);
    assert.equal(chatSessionStore.getSession(key).id, session.id);
    assert.equal(coordinator.getRun(failed.id).runtimeSessionRef.sessionId, oldNativeId);
    await f.complete(recovered, "RECOVERED REPORT");
    assert.ok(transcriptStore.listEvents(f.profile.id, session.id)
      .some(event => event.runId === recovered.id && event.content?.transcriptType === "context.native.seeded"));

    const sendChat = async prompt => {
      const receipt = await ipc("chat.send.accept", { operationId: id(), sessionKey: key, prompt, createdAt: Date.now() });
      return running({ id: receipt.runId });
    };
    const reply = await sendChat("Follow up on the recovered report");
    assert.equal(reply.runtimeSessionRef.sessionId, recovered.runtimeSessionRef.sessionId);
    const chatContract = coordinator.runExecutionContracts.get(reply.id);
    for (const field of ["bindingId", "runtime", "runtimeAccountId", "runtimeProfileId", "effectiveModel", "workspace",
      "toolRegistryRevision", "toolPermissionRevision"]) {
      assert.equal(chatContract[field], contract[field], field);
    }
    assert.equal(chatContract.permissionMode, "request-approval");
    await failCheckpoint(reply, "ANTIGRAVITY_CONTEXT_CHECKPOINT_FAILED");

    const recoveredChat = await sendChat("Continue after the checkpoint failure");
    assert.notEqual(recoveredChat.runtimeSessionRef.sessionId, reply.runtimeSessionRef.sessionId);
    assert.equal(recoveredChat.runtimeSessionRef.runtimeAccountId, reply.runtimeSessionRef.runtimeAccountId);
    assert.equal(recoveredChat.sourceId, key);
    assert.equal(chatSessionStore.getSession(key).id, session.id);
    assert.equal(coordinator.runExecutionContracts.get(recoveredChat.id).permissionMode, "request-approval");
    assert.match(host.lastTurnStartParams.context, /RECOVERED REPORT/u);
    assert.equal(host.turnStartCalls, 6);
    await f.complete(recoveredChat);
  } finally { await f.close(); }
});

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

test("a native session from a retired transport is replaced before the next send and keeps the conversation", async () => {
  const f = await openHandoffFixture();
  try {
    const session = f.createSession();
    await f.switch(session.sessionKey, "pi");
    const first = await f.send(session.sessionKey, "retired-first", "UNIQUE RETIRED MARKER");
    assert.equal(first.status, "running", first.errorCode);
    await f.complete(first, "RETIRED ANSWER");
    const legacy = first.runtimeSessionRef.sessionId;
    f.transport.retired = (runtime, sessionId) => runtime === "pi" && sessionId === legacy;
    const pi = f.transport.hosts.get("pi");
    const resumes = pi.resumeCalls;
    const second = await f.send(session.sessionKey, "retired-second", "AFTER RETIREMENT");
    assert.equal(second.status, "running", second.errorCode);
    assert.notEqual(second.runtimeSessionRef.sessionId, legacy, "a retired native session is never resumed");
    assert.equal(pi.resumeCalls, resumes);
    const renewed = f.service.chatSessionStore.getSession(session.sessionKey);
    assert.equal(renewed.runtimeBindingId, f.binding("pi").id, "the conversation keeps its Binding");
    assert.equal(renewed.retiredRuntimeSessions.at(-1).runtimeSessionId, legacy);
    const execution = f.transport.acquisitions.at(-1).options.executionContract;
    assert.match(execution.dynamicContext, /UNTRUSTED RUNTIME HANDOFF DATA/u);
    assert.match(execution.dynamicContext, /UNIQUE RETIRED MARKER/u, "the fresh session is seeded from the transcript");
    await f.complete(second);
    const audits = f.service.transcriptStore.listEvents(session.profileId, session.id)
      .filter(e => e.content.transcriptType === "runtime.switched");
    assert.ok(audits.at(-1).contextExcluded);
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
      const savedCommand = f.service.pendingCommandInbox.get(operationId);
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
      if (boundary === "inbox") {
        // A legacy Inbox-only command has no frozen execution ownership.
        assert.equal(savedCommand.state, "pending");
        assert.equal(savedCommand.acceptance, undefined);
        assert.equal(run, undefined);
        assert.equal(nativeCount, 0);
        await assert.rejects(f.send(session.sessionKey, operationId), {
          code: "CHAT_OPERATION_VERIFICATION_REQUIRED", receiptUncertain: true,
        });
        assert.deepEqual(f.service.pendingCommandInbox.get(operationId), savedCommand);
        assert.equal(f.service.workRunCoordinator.getChatRunByOperation(operationId, session.sessionKey), null);
      } else {
        const replay = await f.send(session.sessionKey, operationId);
        assert.equal(replay.id, run.id);
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
