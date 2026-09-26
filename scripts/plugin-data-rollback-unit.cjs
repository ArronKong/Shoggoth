"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginDataRollback } = require("../app/agent-service/plugin-data-rollback");

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-data-rollback-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), trustedRoot: root });
  let store = new PluginStore({ paths }).open();
  let installer = new PluginPackageInstaller({ store });
  let drains = 0, writerActive = false;
  const make = onPhase => new PluginDataRollback({ store, onPhase, drainInstallation: async () => {
    drains++; if (writerActive) throw Object.assign(new Error("fixture writer still alive"), { code: "ACTIVATION_DEFERRED" });
  } });
  const sourcePath = path.join(root, "source");
  fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), sourcePath, { recursive: true });
  function install(operationId) {
    const preview = installer.preview(sourcePath);
    return installer.install({ sourcePath, previewDigest: preview.contentDigest, expectedRevision: preview.expectedRevision, operationId });
  }
  const old = install("install-old");
  const dataRoot = path.join(paths.pluginDataDir, old.installationId);
  const dataFile = path.join(dataRoot, "account-scope", "data.json");
  fs.mkdirSync(path.dirname(dataFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(dataFile, '{"version":1,"items":["old"]}', { mode: 0o600 });
  const original = fs.readFileSync(dataFile);
  const core = make();
  const snapshot = await core.createSnapshot({ installationId: old.installationId, expectedRevision: old.revision, operationId: "snapshot-v1" });
  assert.equal(snapshot.dataState, "snapshot_preserved");
  fs.appendFileSync(path.join(sourcePath, "skills/issue-summary/SKILL.md"), "\nVersion two changed code.\n");
  const newer = install("install-new");
  fs.writeFileSync(dataFile, '{"version":2,"items":["old","new-write"]}');
  const latest = fs.readFileSync(dataFile);
  const base = { installationId: newer.installationId, expectedRevision: newer.revision };
  try {
    await run({ root, paths, sourcePath, old, newer, base, snapshot, core, dataRoot, dataFile, original, latest,
      store: () => store, installer: () => installer, make,
      setWriter: value => { writerActive = value; }, drains: () => drains,
      restart() { store.close(); store = new PluginStore({ paths }).open(); installer = new PluginPackageInstaller({ store }); return make(); } });
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
const rejects = (fn, code) => assert.rejects(fn, { code });
async function main() {
  await fixture(async f => {
    const store = f.store();
    const unrelated = path.join(f.paths.pluginDataDir, "another-installation");
    fs.mkdirSync(unrelated, { mode: 0o700 }); fs.writeFileSync(path.join(unrelated, "marker"), "leave alone");
    const enable = store.setInstallationDesiredState({ ...f.base, desiredState: "enabled" });
    await rejects(() => f.core.previewCodeRollback({ installationId: enable.installationId, expectedRevision: enable.revision,
      targetDigest: f.old.releaseDigest }), "PLUGIN_MAINTENANCE_REQUIRES_DISABLE");
    const disabled = store.setInstallationDesiredState({ installationId: enable.installationId,
      expectedRevision: enable.revision, desiredState: "disabled" });
    const input = { installationId: disabled.installationId, expectedRevision: disabled.revision, targetDigest: f.old.releaseDigest };
    f.setWriter(true);
    await rejects(() => f.core.previewCodeRollback(input), "ACTIVATION_DEFERRED");
    assert.deepEqual(fs.readFileSync(f.dataFile), f.latest);
    f.setWriter(false);
    const preview = await f.core.previewCodeRollback(input);
    await rejects(() => f.core.rollbackCode({ preview: { ...preview, targetDigest: f.newer.releaseDigest }, operationId: "tampered" }),
      "PLUGIN_DATA_PREVIEW_CHANGED");
    assert.equal(store.getOperation("tampered"), null);
    const code = await f.core.rollbackCode({ preview, operationId: "rollback-code" });
    assert.equal(code.codeState, "rolled_back_disabled");
    assert.equal(code.dataState, "rollback_requires_data_restore");
    assert.equal(store.getOperation("rollback-code").phase, "committed");
    assert.deepEqual(fs.readFileSync(f.dataFile), f.latest, "code rollback does not replace data");
    assert.throws(() => store.setInstallationDesiredState({ installationId: code.installationId,
      expectedRevision: code.installationRevision, desiredState: "enabled" }), { code: "ACTIVATION_DEFERRED" });
    store.markFailed("rollback-code", "TEST_ERROR");
    assert.equal(store.getOperation("rollback-code").phase, "committed", "generic failure cannot erase rollback fence");
    assert.deepEqual(await f.core.rollbackCode({ preview, operationId: "rollback-code" }), code);
    const core = f.restart();
    assert(f.store().hasPendingInstallationDisable(code.installationId), "fence survives restart");
    const restorePreview = await core.previewDataRestore({ installationId: code.installationId,
      expectedRevision: code.installationRevision, snapshotId: f.snapshot.snapshotId, snapshotDigest: f.snapshot.snapshotDigest });
    assert.equal(restorePreview.dataLossRequired, true);
    assert.equal(restorePreview.rollbackOperationId, "rollback-code");
    await rejects(() => core.restoreData({ preview: restorePreview, operationId: "restore-data" }), "PLUGIN_DATA_RESTORE_CONFIRMATION_REQUIRED");
    assert.equal(f.store().getOperation("restore-data"), null);
    const restored = await core.restoreData({ preview: restorePreview, operationId: "restore-data", approvedDataLoss: true });
    assert.equal(restored.dataState, "restored_from_snapshot");
    assert.deepEqual(fs.readFileSync(f.dataFile), f.original);
    const retained = path.join(core.root, "replaced", restored.retainedDataId, "account-scope", "data.json");
    assert.deepEqual(fs.readFileSync(retained), f.latest, "new-version writes remain preserved separately");
    assert.equal(fs.readFileSync(path.join(unrelated, "marker"), "utf8"), "leave alone");
    assert.equal(f.store().hasPendingInstallationDisable(code.installationId), false);
    assert.equal(f.store().getOperation("rollback-code").phase, "completed");
    assert.equal(f.store().getOperation("rollback-code").result.receipt.dataRestoreOperationId, "restore-data");
    assert.deepEqual(await core.restoreData({ preview: restorePreview, operationId: "restore-data", approvedDataLoss: true }), restored);
    assert.equal(f.store().setInstallationDesiredState({ installationId: code.installationId,
      expectedRevision: restored.installationRevision, desiredState: "enabled" }).desiredState, "enabled");
  });

  for (const phase of ["snapshot-published", "code-rollback-committed", "restore-staged", "restore-old-retained", "restore-data-published"]) {
    await fixture(async f => {
      let crash = true;
      const core = f.make(observed => { if (observed === phase && crash) { crash = false;
        throw Object.assign(new Error("simulated crash"), { code: "PLUGIN_SIMULATED_CRASH" }); } });
      if (phase === "snapshot-published") {
        const request = { ...f.base, operationId: "snapshot-v2-crash" };
        await rejects(() => core.createSnapshot(request), "PLUGIN_SIMULATED_CRASH");
        const recovered = await f.restart().createSnapshot(request);
        assert.equal(recovered.releaseDigest, f.newer.releaseDigest); return;
      }
      const preview = await core.previewCodeRollback({ ...f.base, targetDigest: f.old.releaseDigest });
      let code;
      if (phase === "code-rollback-committed") {
        await rejects(() => core.rollbackCode({ preview, operationId: "crash-code" }), "PLUGIN_SIMULATED_CRASH");
        code = await f.restart().rollbackCode({ preview, operationId: "crash-code" });
        assert.equal(code.dataState, "rollback_requires_data_restore"); return;
      }
      code = await core.rollbackCode({ preview, operationId: "crash-code" });
      const restorePreview = await core.previewDataRestore({ installationId: code.installationId,
        expectedRevision: code.installationRevision, snapshotId: f.snapshot.snapshotId, snapshotDigest: f.snapshot.snapshotDigest });
      const request = { preview: restorePreview, operationId: "crash-restore", approvedDataLoss: true };
      await rejects(() => core.restoreData(request), "PLUGIN_SIMULATED_CRASH");
      assert(f.store().hasPendingInstallationDisable(code.installationId));
      const result = await f.restart().restoreData(request);
      assert.equal(result.dataState, "restored_from_snapshot");
      assert.deepEqual(fs.readFileSync(f.dataFile), f.original);
    });
  }

  await fixture(async f => {
    const preview = await f.core.previewCodeRollback({ ...f.base, targetDigest: f.old.releaseDigest });
    fs.appendFileSync(f.dataFile, "edited after preview");
    await rejects(() => f.core.rollbackCode({ preview, operationId: "stale-data" }), "PLUGIN_DATA_CHANGED");
    assert.equal(f.store().getOperation("stale-data"), null);
    const snapshotDirectory = path.join(f.core.root, "snapshots", f.snapshot.snapshotId);
    fs.appendFileSync(path.join(snapshotDirectory, "data", "account-scope", "data.json"), "tampered");
    await rejects(() => f.core.previewDataRestore({ ...f.base, snapshotId: f.snapshot.snapshotId,
      snapshotDigest: f.snapshot.snapshotDigest }), "PLUGIN_DATA_SNAPSHOT_CHANGED");
    fs.writeFileSync(path.join(snapshotDirectory, "data", "account-scope", "data.json"), f.original);
    fs.symlinkSync(f.sourcePath, path.join(f.dataRoot, "outside-link"));
    await rejects(() => f.core.previewCodeRollback({ ...f.base, targetDigest: f.old.releaseDigest }), "PLUGIN_DATA_PATH_INVALID");
    assert(fs.existsSync(path.join(f.sourcePath, "plugin.json")), "source not touched");
  });
  await fixture(async f => {
    const saved = fs.readFileSync(path.join(f.paths.pluginPackagesDir, f.old.releaseDigest, "skills/issue-summary/SKILL.md"));
    fs.writeFileSync(path.join(f.sourcePath, "skills/issue-summary/SKILL.md"), saved);
    const oldPreview = f.installer().preview(f.sourcePath);
    assert.throws(() => f.installer().install({ sourcePath: f.sourcePath, previewDigest: oldPreview.contentDigest,
      expectedRevision: f.base.expectedRevision, operationId: "bypass-via-install" }), { code: "PLUGIN_ROLLBACK_REQUIRES_PREVIEW" });
    const preview = await f.core.previewCodeRollback({ ...f.base, targetDigest: f.old.releaseDigest });
    await f.core.rollbackCode({ preview, operationId: "old-authority-code" });
    f.store().rotateAuthorityForRestore({ backupId: "fixture-restored-authority" });
    await rejects(() => f.core.rollbackCode({ preview, operationId: "old-authority-code" }), "PLUGIN_OPERATION_OUTCOME_UNKNOWN");
    assert(f.store().hasPendingInstallationDisable(f.base.installationId));
    assert.equal(f.store().getOperation("old-authority-code").phase, "outcome_unknown");
  });
  await fixture(async f => {
    const operationId = "snapshot-partial-prefix";
    const snapshotId = crypto.createHash("sha256").update(JSON.stringify([f.store().getAuthorityIncarnation(), operationId])).digest("hex");
    const partial = path.join(f.core.root, "staging", snapshotId, "data", "account-scope", "data.json");
    fs.mkdirSync(path.dirname(partial), { recursive: true, mode: 0o700 });
    fs.writeFileSync(partial, f.latest.subarray(0, 5), { mode: 0o600 });
    const recovered = await f.core.createSnapshot({ ...f.base, operationId });
    assert.equal(recovered.byteLength, f.latest.length, "power-loss prefix is completed only in private staging");
    assert.deepEqual(fs.readFileSync(path.join(f.core.root, "snapshots", snapshotId, "data", "account-scope", "data.json")), f.latest);
    const huge = path.join(f.dataRoot, "too-large");
    const fd = fs.openSync(huge, "w", 0o600); fs.ftruncateSync(fd, 16 * 1024 * 1024 + 1); fs.closeSync(fd);
    await rejects(() => f.core.previewCodeRollback({ ...f.base, targetDigest: f.old.releaseDigest }), "PLUGIN_DATA_LIMIT");
  });
  await fixture(async f => {
    const saved = path.join(f.core.root, "snapshots", f.snapshot.snapshotId);
    const moved = path.join(f.root, "held-snapshot");
    const input = { ...f.base, targetDigest: f.old.releaseDigest };
    fs.renameSync(saved, moved);
    await rejects(() => f.core.previewCodeRollback(input), "PLUGIN_ROLLBACK_SNAPSHOT_REQUIRED");
    assert.equal(f.store().getInstallation(f.base.installationId).releaseDigest, f.newer.releaseDigest);
    assert.equal(f.store().hasPendingInstallationDisable(f.base.installationId), false);
    fs.renameSync(moved, saved);
    const preview = await f.core.previewCodeRollback(input);
    fs.renameSync(saved, moved);
    await rejects(() => f.core.rollbackCode({ preview, operationId: "snapshot-removed-after-preview" }), "PLUGIN_ROLLBACK_SNAPSHOT_REQUIRED");
    assert.equal(f.store().getOperation("snapshot-removed-after-preview"), null, "no dead-end fence before matching snapshot exists");
    assert.deepEqual(fs.readFileSync(f.dataFile), f.latest);
  });
  console.log("plugin data rollback: separate code/data receipts, persistent fence, crash retry, CAS, retained writes and restore barrier PASS");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
