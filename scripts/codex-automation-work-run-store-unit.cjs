"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { createHarness } = require("./helpers/codex-automation-harness.cjs");
const { OWNER } = require("../app/agent-service/codex-automation-store");
(async () => {
  const h = await createHarness();
  try {
    const owner = h.controller.owner(), run = { id: `automation-${crypto.randomUUID()}`, source: "automation",
      sourceId: owner.store.externalId("task"), idempotencyKey: "codex-automation:store-fixture", profileId: OWNER.id,
      workspace: h.root, status: "queued", contextSnapshotId: null, runtimeSessionRef: null, runtimeTurnRef: null,
      eventSeq: 1, waitingRequestId: null, startedAt: null, finishedAt: null, resultSummary: null, errorCode: null, retryOf: null };
    assert.throws(() => h.productStore.putWorkRun(run), { code: "STORE_INVALID_RECORD" });
    // The controller elects the owner; the store only admits runs of an existing, enabled Agent.
    assert.throws(() => h.automationStore.putWorkRun({ ...run, profileId: "clone" }), { code: "UNKNOWN_AGENT_PROFILE" });
    h.automationStore.putWorkRun(run);
    assert.equal(h.productStore.getWorkRun(run.id), null);
    assert.equal(fs.statSync(h.automationStore.file).mode & 0o777, 0o600);
    assert.throws(() => h.automationStore.putWorkRun({ ...run, eventSeq: 2, workspace: "/" }), { code: "WORK_RUN_IDENTITY_IMMUTABLE" });
    assert.throws(() => h.automationStore.putWorkRun(run), { code: "WORK_RUN_EVENT_SEQ_CONFLICT" });
    h.automationStore.putWorkRun({ ...run, eventSeq: 2, status: "starting", startedAt: Date.now() });
    h.automationStore.close(); h.automationStore.open();
    assert.equal(h.dispatcher.getRun(run.id).status, "starting");
    h.automationStore.recoverActiveRunAfterServiceRestart(run.id);
    assert.equal(h.dispatcher.getRun(run.id).status, "interrupted");
    assert.throws(() => h.automationStore.putWorkRun({ ...run, id: `automation-${crypto.randomUUID()}` }), { code: "WORK_RUN_IDEMPOTENCY_CONFLICT" });
    h.automationStore.close();
    const file = h.automationStore.file, backup = file + ".fixture";
    fs.renameSync(file, backup); fs.symlinkSync(backup, file);
    assert.throws(() => h.automationStore.open(), { code: "UNSAFE_SYMLINK" });
    fs.unlinkSync(file); fs.renameSync(backup, file); h.automationStore.open();
    h.productStore.close(); h.productStore.open();
    assert.equal(h.productStore.listWorkRuns().length, 0, "main-compatible shared snapshot still opens");
    console.log("PASS private automation run store: rollback compatibility, disk recovery, sole owner, namespace, immutable identity/sequence, idempotency, private mode and symlink rejection");
  } finally { await h.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
