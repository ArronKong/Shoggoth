"use strict";
// Explicit live acceptance. Creates one PAUSED legacy definition in the user's
// native Codex Home and runs only a no-tools probe in a temporary workspace.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createHarness, waitUntil } = require("./helpers/codex-automation-harness.cjs");
const { OWNER } = require("../app/agent-service/codex-automation-store");
async function run() {
  if (!process.argv.includes("--live")) throw new Error("Pass --live only for an explicitly authorized native acceptance run");
  const h = await createHarness({ live: true });
  let job;
  const reuseId = process.argv.includes("--task-id") ? process.argv[process.argv.indexOf("--task-id") + 1] : null;
  const probePrompt = "请只回复 SHOGGOTH_AUTOMATION_CONNECTED，不使用任何工具，不读取、修改或创建文件。";
  try {
    const owner = h.controller.owner(), existing = owner.store.list().records.filter(record => record.definition.id !== reuseId).map(record => ({ id: record.definition.id, revision: record.revision }));
    const catalog = await h.call("models.list", { profileId: OWNER.id });
    const model = catalog.models.find(row => row.id === catalog.defaultModelId);
    assert.ok(model, "native default model must exist");
    const reasoningEffort = model.thinkingOptions.includes("low") ? "low" : model.thinkingDefault;
    if (reuseId) {
      const record = owner.store.read(reuseId);
      assert.equal(record.definition.status, "PAUSED");
      assert.equal(record.definition.prompt, probePrompt, "Only the dedicated no-tools probe may be reused");
      assert.ok(record.definition.name.startsWith("Shoggoth 接入"));
      job = h.controller.mapJob(record, owner);
      ({ job } = await h.call("update", { profileId: OWNER.id, id: job.id, revision: job.revision,
        patch: { cwd: h.root, model: model.id, reasoningEffort } }));
    } else ({ job } = await h.call("create", { profileId: OWNER.id, operationId: `native-acceptance-${crypto.randomUUID()}`, spec: {
      kind: "cron", name: "Shoggoth 接入测试（暂停）", prompt: probePrompt,
      rrule: "RRULE:FREQ=WEEKLY;BYDAY=SU;BYHOUR=23;BYMINUTE=30;BYSECOND=0", enabled: false, model: model.id,
      reasoningEffort, cwd: h.root, executionEnvironment: "local" } }));
    console.log(JSON.stringify({ phase: "created", name: job.name, taskId: job.externalTaskId, model: job.model, reasoningEffort: job.reasoningEffort, state: job.state }));
    ({ job } = await h.call("update", { profileId: OWNER.id, id: job.id, revision: job.revision, patch: { name: "Shoggoth 接入验证（暂停）",
      rrule: "RRULE:FREQ=WEEKLY;BYDAY=SU;BYHOUR=23;BYMINUTE=45;BYSECOND=0" } }));
    const receipt = await h.call("run", { profileId: OWNER.id, id: job.id, revision: job.revision, operationId: `native-run-${crypto.randomUUID()}` });
    console.log(JSON.stringify({ phase: "admitted", runId: receipt.runId, state: receipt.status }));
    await waitUntil(() => ["completed", "failed", "interrupted", "canceled"].includes(h.dispatcher.getRun(receipt.runId).status), "native automation completion", 55000);
    const nativeRun = h.dispatcher.getRun(receipt.runId);
    h.controller.results.clear();
    const result = await h.call("runs.result", { profileId: OWNER.id, id: job.id, runId: receipt.runId });
    const content = await h.call("content.read", { profileId: OWNER.id, id: job.id, field: "result", runId: receipt.runId,
      revision: result.contentRevision, offset: 0, limit: 6000 });
    const evidence = { verified: nativeRun.status === "completed" && content.content.includes("SHOGGOTH_AUTOMATION_CONNECTED"),
      source: "feature-worktree", scheduler: "codex-desktop", executionOrigin: "shoggoth", taskId: job.externalTaskId,
      runId: receipt.runId, runtimeAccountId: nativeRun.runtimeSessionRef?.runtimeAccountId, nativeSessionId: nativeRun.runtimeSessionRef?.sessionId,
      nativeTurnId: nativeRun.runtimeTurnRef?.turnId, status: nativeRun.status, errorCode: nativeRun.errorCode,
      model: job.model, reasoningEffort, outputComplete: result.outputComplete, result: content.content, paused: owner.store.read(job.externalTaskId).definition.status === "PAUSED",
      originalTasksUnchanged: existing.every(item => owner.store.read(item.id).revision === item.revision), timestamp: new Date().toISOString() };
    fs.writeFileSync(path.resolve(__dirname, "../docs/architecture/codex-automation-native-acceptance-2026-09-30.json"), JSON.stringify(evidence, null, 2) + "\n");
    console.log(JSON.stringify(evidence));
    assert.equal(evidence.verified, true); assert.equal(evidence.paused, true); assert.equal(evidence.originalTasksUnchanged, true);
  } finally {
    // The run's temporary workspace is removed, while the paused client-visible
    // probe keeps a valid directory and never enables periodic scheduling.
    if (job) {
      const current = h.controller.owner().store.read(job.externalTaskId);
      await h.call("update", { profileId: OWNER.id, id: job.id, revision: current.revision, patch: { cwd: "~", enabled: false } });
    }
    await h.close();
  }
}
if (require.main === module) run().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
