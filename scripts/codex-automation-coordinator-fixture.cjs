"use strict";
const assert = require("node:assert/strict");
const { createHarness, waitUntil } = require("./helpers/codex-automation-harness.cjs");
const { OWNER } = require("../app/agent-service/codex-automation-store");
async function run() {
  const h = await createHarness();
  try {
    const { job } = await h.call("create", { profileId: OWNER.id, operationId: "create-production-fixture", spec: { kind: "cron", name: "fixture",
      prompt: "This is the frozen automation prompt", rrule: "RRULE:FREQ=HOURLY;INTERVAL=1", enabled: false,
      model: "fixture-model", reasoningEffort: "high", cwd: h.root, executionEnvironment: "local" } });
    const input = { profileId: OWNER.id, id: job.id, revision: job.revision, operationId: "run-production-fixture" };
    const receipt = await h.call("run", input);
    await waitUntil(() => h.dispatcher.getRun(receipt.runId).status === "running", "native turn start");
    assert.equal(h.host.turnParams.model, "fixture-model"); assert.equal(h.host.turnParams.effort, "high");
    assert.equal(h.host.startParams.cwd, h.root); assert.equal(h.productStore.getAgentProfile(OWNER.id).defaultModel, null);
    assert.equal((await h.call("run", input)).runId, receipt.runId); assert.equal(h.host.turnStarts, 1);
    let run = h.dispatcher.getRun(receipt.runId);
    const approval = h.host.request("item/commandExecution/requestApproval", { threadId: run.runtimeSessionRef.sessionId,
      turnId: run.runtimeTurnRef.turnId, itemId: "command-one", command: "echo fixture", cwd: h.root, reason: "fixture" });
    await waitUntil(() => h.dispatcher.getRun(run.id).status === "waiting_approval", "approval");
    const waiting = await h.call("runs.result", { profileId: OWNER.id, id: job.id, runId: run.id });
    assert.equal(waiting.interaction.type, "approval");
    await h.call("runs.control", { profileId: OWNER.id, id: job.id, runId: run.id, operationId: "approve-fixture", action: "approval",
      requestId: h.dispatcher.getRun(run.id).waitingRequestId, choice: "once", answers: {} });
    assert.deepEqual(await approval, { decision: "accept" });
    // Stop the Service subscription, complete the original turn, then recover.
    await h.coordinator.close(); h.host.finish(run.runtimeTurnRef.turnId, "# Complete result\n\n" + "Output ".repeat(3000));
    await h.rebuild();
    await waitUntil(() => h.dispatcher.getRun(run.id).status === "completed", "durable native reconciliation");
    assert.equal(h.host.turnStarts, 1, "recovery must not submit another turn");
    assert.equal(h.productStore.getWorkRun(run.id), null, "shared ProductStore must remain compatible with main");
    assert.equal(h.automationStore.getWorkRun(run.id).status, "completed", "separate feature records survive disk reload");
    h.controller.results.clear();
    const result = await h.call("runs.result", { profileId: OWNER.id, id: job.id, runId: run.id });
    assert.equal(result.completionStatus, "succeeded"); assert.equal(result.outputComplete, true); assert.ok(result.contentLength > 18000);
    assert.equal(h.controller.owner().store.read(job.externalTaskId).definition.status, "PAUSED");
    const second = await h.call("run", { ...input, operationId: "run-stop-fixture" });
    await waitUntil(() => h.dispatcher.getRun(second.runId).status === "running", "second native turn");
    await h.call("runs.control", { profileId: OWNER.id, id: job.id, runId: second.runId, operationId: "stop-fixture", action: "stop", requestId: null, choice: null, answers: {} });
    assert.ok(["interrupted", "canceled"].includes(h.dispatcher.getRun(second.runId).status));
    console.log("PASS production Coordinator: native model/effort/workspace, approval, durable recovery without replay, long original-turn result, stop and paused definition");
  } finally { await h.close(); }
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
