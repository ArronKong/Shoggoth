"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { PROTOCOL_VERSION } = require("../app/agent-service/server");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { audit } = require("./runtime-upgrade-audit.cjs");
const { waitUntil } = require("./shoggoth-work-run-coordinator-unit.cjs");

test("compatible Service preserves v2 receipts, Stop, serial chat preparation and group Cron authority", { timeout: 60_000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-compat-")));
  let now = Date.now(), fixture, transport, previousNonce;
  const interval = 30 * 60_000;
  const prompt = "Check the synthetic status and publish a confirmed change.";
  const report = "Synthetic confirmed status change. [Evidence](https://example.com/status/change)";
  const quote = "Please schedule updates for this synthetic report.";
  const ipc = async (method, params) => {
    try {
      return await requestService(fixture.paths, {
        id: crypto.randomUUID(), token: readClientToken(fixture.paths), version: PROTOCOL_VERSION, method, params,
      }, { timeoutMs: 8_000 });
    } catch (error) {
      error.message = `${method}: ${error.message}`;
      throw error;
    }
  };
  const inboxIdentity = () => {
    const bytes = fs.readFileSync(path.join(fixture.paths.stateDir, "pending-commands.json"));
    return { bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  };
  const start = async workerWrites => {
    fixture = await openHandoffFixture({ root, transport, serviceOptions: { memoryCore: false, prewarmMcpAuth: false,
      now: () => now, setCronTimer: () => 1, clearCronTimer() {}, pendingCommandWorkerWrites: workerWrites,
      ...(workerWrites ? {} : { chatPreparationConcurrency: 1 }) } });
    transport = fixture.transport;
    assert.equal(Boolean(fixture.service.pendingCommandInbox.fileWriter), workerWrites);
    const status = await ipc("service.status", {});
    assert.equal(status.healthy, true);
    assert.equal(status.pendingCommandsLocked, false);
    assert.equal(status.chatAcceptanceV1, true);
    assert.notEqual(status.instanceNonce, previousNonce);
    previousNonce = status.instanceNonce;
  };
  const stop = async () => {
    await fixture.close({ remove: false });
    const stopped = audit(fixture.paths);
    assert.equal(stopped.quiescent, true, JSON.stringify(stopped.activeMarkers));
    fixture = null;
    return stopped;
  };
  const turns = () => [...transport.handles.values()].reduce((total, handle) => total + handle.host.turnStartCalls, 0);
  const getRun = id => fixture.service.workDispatcher.getRun(id);
  const waitFor = async (read, label) => {
    await waitUntil(read, 8_000, label);
    return read();
  };
  const runCron = async jobId => {
    const { nativeCronStore, nativeCronScheduler, workDispatcher } = fixture.service;
    now = nativeCronStore.getJob(jobId).nextRunAt;
    await nativeCronScheduler.tick();
    const run = await waitFor(() => workDispatcher.listRuns({ source: "cron", sourceId: jobId, status: "running" })
      .find(item => item.runtimeTurnRef), "scheduled group Cron turn");
    await fixture.complete(run, report);
    await nativeCronScheduler.waitForIdle(run.id);
    return run;
  };

  try {
    await start(true);
    const session = fixture.createSession();
    const inputs = ["old-workflow", "candidate-workflow"].map(operationId => ({ operationId, sessionKey: session.sessionKey,
      prompt: `Synthetic continuation input ${operationId}.`, createdAt: now }));
    const receipts = [];
    for (const input of inputs) {
      const receipt = await ipc("chat.send.accept", input);
      receipts.push(receipt);
      const run = await waitFor(() => getRun(receipt.runId)?.status === "running" && getRun(receipt.runId), "accepted chat turn");
      await fixture.complete(run);
    }

    await ipc("agent.create", { operationId: "create-cron-member", backendId: "shoggoth", name: "Other member",
      defaultCwd: null, createdAt: now });
    const members = fixture.service.productStore.listAgentProfiles().map(({ backendId, agentId }) => ({ backendId, agentId }));
    const { group } = await ipc("group.create", { operationId: "create-rollback-group", name: "Synthetic updates", purpose: "", members });
    const member = (await ipc("group.get", { groupId: group.id })).members.find(item => item.agentId === fixture.profile.agentId);
    const history = () => ipc("group.history", { groupId: group.id, afterSeq: null, beforeSeq: null, limit: 25 });
    await ipc("group.send", { groupId: group.id, clientMessageId: crypto.randomUUID(), body: quote,
      mentions: [member.id], replyTo: null, attachments: [] });
    const groupRun = await waitFor(() => fixture.service.groupChatStore.runningOpportunities()
      .map(item => getRun(item.runId)).find(run => run?.profileId === fixture.profile.id && run.status === "running" && run.runtimeTurnRef),
    "user-approved source group turn");
    const args = { name: "Rollback watch", prompt, sourceQuote: quote, watch: true,
      enabled: true, workspace: null, schedule: { kind: "every", everyMs: interval, anchorMs: now },
      misfirePolicy: "latest", maxCatchUp: 1, overlapPolicy: "skip" };
    const { job } = await fixture.service.workRunCoordinator.invokeRuntimeCapability({ ...groupRun.runtimeTurnRef, runId: groupRun.id },
      scope => fixture.service.mcpProductToolController.handle("cron_create", args, { profileId: groupRun.profileId, callId: crypto.randomUUID() }, scope));
    await fixture.complete(groupRun, "Saved the synthetic watch.");
    const originalRun = await runCron(job.id);
    const publication = { groupId: group.id, jobId: job.id, runId: originalRun.id };
    await waitFor(() => fixture.service.groupChatStore.hasPublishedCronReply(publication), "original group Cron publication");
    const visible = (await history()).messages.filter(item => item.origin?.cronJobId === job.id);
    assert.equal(visible.length, 1);
    assert.equal(visible[0].body, report);

    const pending = { operationId: "pending-before-compatible-restart", sessionKey: session.sessionKey,
      prompt: "Synthetic accepted input with no projected WorkRun.", createdAt: now };
    const pendingLookup = { operationId: pending.operationId, sessionKey: pending.sessionKey, includeAcceptance: true };
    const pendingStop = { operationId: pending.operationId, sessionKey: pending.sessionKey };
    const store = fixture.service.productStore;
    const putWorkRun = store.putWorkRun.bind(store);
    store.putWorkRun = input => {
      if (input.idempotencyKey === `shoggoth:chat-send:${pending.operationId}`) {
        throw Object.assign(new Error("fixture projection unavailable"), { code: "ENOSPC" });
      }
      return putWorkRun(input);
    };
    const beforePending = turns();
    const pendingReceipt = await ipc("chat.send.accept", pending);
    const pendingUserEvents = () => fixture.service.transcriptStore.listEvents(fixture.profile.id, session.id, { runId: pendingReceipt.runId })
      .filter(event => event.kind === "user" && event.content?.operationId === pending.operationId);
    assert.deepEqual(await ipc("chat.operation.get", pendingLookup), { status: "accepted", run: null, receipt: pendingReceipt });
    assert.deepEqual(await ipc("chat.send.cancel", pendingStop), pendingReceipt);
    assert.equal(fixture.service.pendingCommandInbox.get(pending.operationId).cancelRequested, true);
    assert.deepEqual(await ipc("chat.send.accept", pending), pendingReceipt);
    assert.equal(getRun(pendingReceipt.runId), null);
    assert.equal(pendingUserEvents().length, 0);
    assert.equal(turns(), beforePending);
    const candidate = await stop();
    assert.equal(candidate.pendingCommands.version, 2);

    const assertReceipts = async () => {
      for (const [index, input] of inputs.entries()) {
        assert.deepEqual(await ipc("chat.send.accept", input), receipts[index]);
        const result = await ipc("chat.operation.get", { operationId: input.operationId, sessionKey: input.sessionKey,
          includeAcceptance: true });
        assert.equal(result.run?.id, receipts[index].runId);
        assert.equal(result.run?.status, "completed");
        assert.equal(fixture.service.transcriptStore.listEvents(fixture.profile.id, session.id, { runId: result.run.id })
          .filter(event => event.kind === "user" && event.content?.operationId === input.operationId).length, 1);
      }
      assert.deepEqual(await ipc("chat.send.accept", pending), pendingReceipt);
      assert.deepEqual(await ipc("chat.send.cancel", pendingStop), pendingReceipt);
      const result = await ipc("chat.operation.get", pendingLookup);
      assert.equal(result.run?.id, pendingReceipt.runId);
      assert.equal(result.run?.status, "canceled");
      assert.equal(pendingUserEvents().length, 1);
    };
    const candidateTurns = turns();
    await start(false);
    await waitFor(() => fixture.service.pendingCommandInbox.get(pending.operationId)?.state === "canceled",
      "original Inbox-only Stop to settle after reopen");
    const afterOpen = inboxIdentity();
    await assertReceipts();
    assert.equal(turns(), candidateTurns, "compatible replay must not send either original operation again");
    assert.deepEqual(inboxIdentity(), afterOpen, "exact receipt replay leaves Inbox bytes unchanged after startup floor refresh");
    assert.equal((await ipc("cron.job.get", { jobId: job.id })).job.deliveryTarget, "group");
    assert.equal(fixture.service.groupChatStore.hasPublishedCronReply(publication), true);
    await fixture.service.cronReportIndex.rebuild();
    const repeated = await runCron(job.id);
    assert.equal(turns(), candidateTurns + 1, "only the intentionally scheduled fixture turn is new");
    assert.equal(fixture.service.workRunCoordinator.getCronOutput(repeated.id).reason, "duplicate");
    assert.deepEqual((await history()).messages.filter(item => item.origin?.cronJobId === job.id), visible);
    const coordinator = fixture.service.workRunCoordinator;
    const beforeSessionSend = coordinator.beforeSessionSend;
    const preparing = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const prepSessions = [fixture.createSession(), fixture.createSession()];
    const prepRequests = prepSessions.map((item, index) => ({ operationId: `compatible-preparation-${index}`,
      sessionKey: item.sessionKey, prompt: `Synthetic independent preparation ${index}.`, createdAt: now }));
    coordinator.beforeSessionSend = async input => {
      if (prepRequests.some(request => request.operationId === input.operationId)) preparing.push(input.operationId);
      if (input.operationId === prepRequests[0].operationId) await gate;
      return beforeSessionSend(input);
    };
    try {
      const first = await ipc("chat.send.accept", prepRequests[0]);
      await waitFor(() => preparing.includes(first.operationId), "first chat preparation to block");
      const second = await ipc("chat.send.accept", prepRequests[1]);
      await waitFor(() => fixture.service.transcriptStore.listEvents(fixture.profile.id, prepSessions[1].id, { runId: second.runId })
        .some(event => event.kind === "user" && event.content?.operationId === second.operationId), "second chat receipt to project");
      assert.ok(fixture.service.nativeRuntimeConfig.read().startupConcurrency > 1);
      assert.deepEqual(preparing, [first.operationId]);
      assert.equal(turns(), candidateTurns + 1);
      assert.deepEqual(await ipc("chat.send.cancel", { operationId: first.operationId, sessionKey: first.sessionKey }), first);
      release();
      const secondRun = await waitFor(() => getRun(second.runId)?.runtimeTurnRef && getRun(second.runId),
        "second chat to dispatch after the preparation slot is released");
      await fixture.complete(secondRun);
      assert.equal(getRun(first.runId)?.status, "canceled");
      assert.equal(turns(), candidateTurns + 2);
    } finally {
      release();
      coordinator.beforeSessionSend = beforeSessionSend;
    }
    const compatible = await stop();
    assert.equal(compatible.pendingCommands.version, 2);

    await start(true);
    const afterReopen = inboxIdentity();
    await assertReceipts();
    assert.equal(turns(), candidateTurns + 2);
    assert.deepEqual((await history()).messages.filter(item => item.origin?.cronJobId === job.id), visible);
    const reopened = await stop();
    assert.deepEqual(reopened.privateFiles["pending-commands.json"], afterReopen);
  } finally {
    if (fixture) await fixture.close({ remove: false });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
