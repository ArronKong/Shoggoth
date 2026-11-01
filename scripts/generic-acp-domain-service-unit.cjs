#!/usr/bin/env node
"use strict";
// Actual Generic ACP Service regression: autonomous domain sources must retain
// the extension's supported profile permission contract.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { createFixture, sourceFingerprint } = require("./fixtures/generic-acp-service-fixture.cjs");
async function main() {
  const before = sourceFingerprint(); const fixture = await createFixture({ agents: 2 });
  const results = [], failures = [];
  const execute = fixture.service.workRunCoordinator.executeDomainRun.bind(fixture.service.workRunCoordinator);
  fixture.service.workRunCoordinator.executeDomainRun = async input => {
    try { return await execute(input); }
    catch (error) { failures.push({ runId: input.runId, code: error.code, stack: error.stack }); throw error; }
  };
  try {
    const job = (await fixture.rpc("cron.job.create", { operationId: "generic-domain-cron-create", name: "Controlled Generic ACP Cron", enabled: false,
      profileId: fixture.profiles[0].id, prompt: "[ACP_PROBE:domain-cron] controlled Cron task", workspace: fixture.metadata.workspaces[0],
      schedule: { kind: "every", everyMs: 60000, anchorMs: 0 }, misfirePolicy: "latest", maxCatchUp: 1,
      overlapPolicy: "skip", threadPolicy: "new", threadId: null, createdAt: Date.now() })).job;
    const ack = await fixture.rpc("cron.run.trigger", { operationId: "generic-domain-cron-trigger", jobId: job.id, createdAt: Date.now() });
    const cron = await fixture.service.nativeCronScheduler.waitForIdle(ack.run.id);
    assert.equal(cron.status, "completed", cron.errorCode); assert.equal(cron.runtimeTurnRef.runtime, fixture.runtime);
    assert.equal(cron.runtimeAttemptRef.dispatchState, "write_attempted");
    results.push({ source: "cron", run: cron }); console.log("ok 1 - Generic ACP Cron preserves supported profile permission mode");
    const board = (await fixture.rpc("kanban.board.create", { operationId: "generic-domain-board-create", profileId: fixture.profiles[1].id,
      slug: "generic-domain-proof", name: "Controlled Generic ACP Kanban", description: null, createdAt: Date.now() })).board;
    const card = (await fixture.rpc("kanban.card.create", { operationId: "generic-domain-card-create", boardId: board.id, profileId: fixture.profiles[1].id,
      title: "Controlled Generic ACP card", body: "[ACP_PROBE:domain-kanban] controlled Kanban task", status: "backlog", position: 0, createdAt: Date.now() })).card;
    const dispatched = await fixture.rpc("kanban.run.dispatch", { operationId: "generic-domain-card-dispatch", cardId: card.id, workspace: fixture.metadata.workspaces[1], createdAt: Date.now() });
    const kanban = await fixture.service.kanbanRunService.waitForIdle(dispatched.run.id);
    assert.equal(kanban.status, "completed", kanban.errorCode); assert.equal(kanban.runtimeTurnRef.runtime, fixture.runtime);
    assert.equal(kanban.runtimeAttemptRef.dispatchState, "write_attempted");
    assert.notEqual(cron.runtimeSessionRef.sessionId, kanban.runtimeSessionRef.sessionId);
    results.push({ source: "kanban", run: kanban }); console.log("ok 2 - Generic ACP Kanban stays on its account and prepared attempt");
    assert.equal(fixture.auditRows().filter(row => row.kind === "prompt" && row.token === "domain-cron").length, 1);
    assert.equal(fixture.auditRows().filter(row => row.kind === "prompt" && row.token === "domain-kanban").length, 1);
    for (const [index, approvalPolicy] of ["on-request", "never"].entries()) {
      const profile = fixture.service.productStore.getAgentProfile(fixture.profiles[1].id);
      fixture.service.productStore.putAgentProfile({ ...profile, permissionPolicy: { ...profile.permissionPolicy, approvalPolicy } });
      const token = `domain-permission-${index}`, createdAt = Date.now();
      const askingJob = (await fixture.rpc("cron.job.create", { operationId: `generic-ask-${index}-create`, name: `Controlled Generic ACP ${approvalPolicy}`, enabled: false,
        profileId: profile.id, prompt: `[ACP_PROBE:${token}] [ACP_APPROVAL] controlled extra Cron ask`, workspace: fixture.metadata.workspaces[1],
        schedule: { kind: "every", everyMs: 60000, anchorMs: 0 }, misfirePolicy: "latest", maxCatchUp: 1,
        overlapPolicy: "skip", threadPolicy: "new", threadId: null, createdAt })).job;
      const asking = await fixture.rpc("cron.run.trigger", { operationId: `generic-ask-${index}-trigger`, jobId: askingJob.id, createdAt: Date.now() });
      const denied = await fixture.service.nativeCronScheduler.waitForIdle(asking.run.id);
      assert.equal(denied.status, "canceled", "Extra unattended Generic permission request must never claim successful completion");
      assert.equal(denied.errorCode, null); assert.equal(denied.runtimeTurnRef.runtime, fixture.runtime);
      const response = fixture.auditRows().find(row => row.kind === "permission-response" && row.token === token);
      assert(response); assert.equal(response.outcome, "selected"); assert.equal(response.optionId, "controlled-deny-once");
      assert.equal(fixture.auditRows().some(row => row.kind === "first-text" && row.token === token), false);
      const session = fixture.service.chatSessionStore.getSession(fixture.service.workRunCoordinator.getRunSessionKey(denied));
      const transcript = fixture.service.transcriptStore.listEvents(profile.id, session.id).filter(row => row.runId === denied.id);
      const deny = transcript.find(row => row.content?.transcriptType === "cron.authorization");
      assert(deny); assert.equal(deny.content.decision, "deny");
      assert.equal(deny.content.reason, approvalPolicy === "never" ? "profile-never" : "unsupported-permission-mode");
      assert.equal(transcript.some(row => row.kind === "assistant"), false);
      results.push({ source: "cron", approvalPolicy, denied: true, run: denied, authorization: deny.content });
      console.log(`ok ${index + 3} - Generic ACP Cron ${approvalPolicy} extra ask is explicitly denied without success`);
    }
    // End-turn is transport completion. The existing output policy permits
    // a non-empty alternative report, but a denied ask followed by silence is
    // a visible failure. None of these controlled peers performs an operation.
    const hostileProfile = fixture.service.productStore.getAgentProfile(fixture.profiles[1].id);
    fixture.service.productStore.putAgentProfile({ ...hostileProfile, permissionPolicy: { ...hostileProfile.permissionPolicy, approvalPolicy: "on-request" } });
    for (const [index, final] of ["NO_REPLY", "empty", "nonempty-report"].entries()) {
      const token = `domain-ignore-deny-${index}`, flags = final === "NO_REPLY" ? "[ACP_SILENT_FINAL]" : final === "empty" ? "[ACP_EMPTY_FINAL]" : "";
      const hostileJob = (await fixture.rpc("cron.job.create", { operationId: `generic-ignore-deny-${index}-create`, name: `Agent ignores deny and reports ${final}`, enabled: false,
        profileId: hostileProfile.id, prompt: `[ACP_PROBE:${token}] [ACP_APPROVAL] [ACP_IGNORE_DENY] ${flags} controlled no-operation protocol response`, workspace: fixture.metadata.workspaces[1],
        schedule: { kind: "every", everyMs: 60000, anchorMs: 0 }, misfirePolicy: "latest", maxCatchUp: 1,
        overlapPolicy: "skip", threadPolicy: "new", threadId: null, createdAt: Date.now() })).job;
      const hostileAck = await fixture.rpc("cron.run.trigger", { operationId: `generic-ignore-deny-${index}-trigger`, jobId: hostileJob.id, createdAt: Date.now() });
      const hostile = await fixture.service.nativeCronScheduler.waitForIdle(hostileAck.run.id);
      if (final === "nonempty-report") {
        assert.equal(hostile.status, "completed"); assert.equal(hostile.errorCode, null);
        assert(hostile.resultSummary.includes(`ACP answer ${token}`));
      } else {
        assert.equal(hostile.status, "failed"); assert.equal(hostile.errorCode, "CRON_AUTHORIZATION_DENIED"); assert.equal(hostile.resultSummary, null);
      }
      const decision = fixture.service.workRunCoordinator.getCronOutput(hostile); assert.equal(decision.disposition, "deliver");
      assert.equal(fixture.auditRows().find(row => row.kind === "permission-response" && row.token === token).optionId, "controlled-deny-once");
      assert.equal(fixture.auditRows().find(row => row.kind === "terminal" && row.token === token).stopReason, "end_turn");
      assert.equal(fixture.auditRows().find(row => row.kind === "ignored-deny-still-end-turn" && row.token === token).controlledNoOperation, true);
      const hostileSession = fixture.service.chatSessionStore.getSession(fixture.service.workRunCoordinator.getRunSessionKey(hostile));
      const hostileEvents = fixture.service.transcriptStore.listEvents(hostileProfile.id, hostileSession.id).filter(row => row.runId === hostile.id);
      assert(hostileEvents.some(row => row.content?.transcriptType === "cron.authorization" && row.content.decision === "deny"));
      assert(hostileEvents.some(row => row.content?.transcriptType === "terminal" && row.content.status === hostile.status && row.content.errorCode === hostile.errorCode));
      results.push({ source: "cron", case: `Agent ignores deny and reports ${final}`, controlledNoOperation: true,
        semanticBoundary: "Only transport turn completion and existing delivery policy are verified; no business outcome is proven", run: hostile, cronOutput: decision });
      console.log(`ok ${index + 5} - Denied Generic ACP Cron ${final} follows explicit terminal/delivery policy`);
    }
    assert.equal(failures.length, 0);
  } finally {
    const workRuns = fixture.service.productStore.listWorkRuns();
    const resources = await fixture.closeAndObserve(), after = sourceFingerprint();
    const receipt = { version: 1, root: fixture.root, beforeDigest: before.digest, afterDigest: after.digest,
      results, failures, workRuns, audit: fixture.auditRows(), resources, sourceUnchanged: before.digest === after.digest };
    const file = path.join(fixture.root, "domain-service-result.json"); fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
    console.log(`Evidence: ${file}`); assert.equal(after.digest, before.digest);
  }
  assert.equal(results.length, 7); console.log("Generic ACP domain Service tests: 7/7 passed");
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
