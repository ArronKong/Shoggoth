"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService } = require("../app/agent-service/server");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { startStaticServer } = require("../app/static-server");
const { validatePluginRollbackResult } = require("../app/core/plugin-rollback-dto");

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sgrb-"));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "user"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const key = crypto.randomBytes(32);
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(value) { const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      return Buffer.concat([nonce, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]); },
    decryptString(value) { const cipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString("utf8"); } };
  const options = { paths, safeStorage, prewarmMcpAuth: false, parentEnv: {}, version: "rollback-management-fixture" };
  let service = createAgentService(options), web, approved = false, confirmations = 0;
  try {
    await service.start();
    const backend = new ShoggothBackend({ paths });
    const source = path.join(root, "source");
    fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), source, { recursive: true });
    const sourceInput = { kind: "directory", path: source };
    const install = async operationId => {
      const preview = await backend.previewPluginInstall(sourceInput);
      return (await backend.installPlugin({ source: sourceInput, previewDigest: preview.previewDigest,
        expectedRevision: preview.expectedRevision, operationId })).installation;
    };
    const old = await install("old-code");
    const dataFile = path.join(paths.pluginDataDir, old.installationId, "scope", "data.json");
    fs.mkdirSync(path.dirname(dataFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(dataFile, "old-data", { mode: 0o600 });
    const native = { async confirmPluginCapability(summary) {
      assert(summary.action.startsWith("rollback-")); confirmations++;
      assert.equal(summary.fromDigest.length, 64);
      return approved;
    } };
    web = await startStaticServer(0, { homeDir: root, userDataRoot: root,
      registry: { backends: new Map([["shoggoth", backend]]) }, hostOps: native });
    const post = async (route, body, origin = web.url) => {
      const response = await fetch(`${web.url}/__api/plugins/${route}`, { method: "POST",
        headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
      const bodyText = await response.text();
      let value; try { value = JSON.parse(bodyText); } catch { value = { error: bodyText }; }
      const json = JSON.stringify(value);
      for (const forbidden of [root, "sourceIdentity", "authorityIncarnation", "previewDigest", "challenge", '"request":', "account-scope"])
        assert(!json.includes(forbidden), `private ${forbidden} leaked`);
      return { status: response.status, body: value };
    };
    const snapshotInput = { action: "snapshot", installationId: old.installationId, expectedRevision: old.revision, operationId: "snapshot-one" };
    assert.equal((await post("rollback-change", snapshotInput, "https://evil.example")).status, 403);
    assert.equal((await post("rollback-change", { ...snapshotInput, approved: true })).status, 400);
    assert.equal(confirmations, 0);
    assert.equal((await post("rollback-change", snapshotInput)).body.canceled, true);
    assert.equal(service.pluginStore.getOperation(snapshotInput.operationId), null);
    approved = true;
    const snapshotResult = await post("rollback-change", snapshotInput);
    assert.equal(snapshotResult.status, 200); assert.equal(snapshotResult.body.receipt.state, "snapshot_preserved");
    const snapshot = snapshotResult.body.receipt;
    const list = await post("rollback-list", { installationId: old.installationId });
    assert.equal(list.status, 200); assert.equal(list.body.snapshots.length, 1);
    assert.throws(() => validatePluginRollbackResult("plugins.rollback.list", { ...list.body, path: root }));
    fs.appendFileSync(path.join(source, "skills/issue-summary/SKILL.md"), "\nChanged version.\n");
    const newer = await install("new-code");
    fs.writeFileSync(dataFile, "new-data-writes");
    const codeInput = { action: "code", installationId: newer.installationId, expectedRevision: newer.revision,
      targetDigest: old.releaseDigest, operationId: "rollback-code" };
    const rollback = await post("rollback-change", codeInput);
    assert.equal(rollback.status, 200); assert.equal(rollback.body.receipt.state, "rollback_requires_data_restore");
    assert.equal(fs.readFileSync(dataFile, "utf8"), "new-data-writes");
    await assert.rejects(backend.setPluginInstallationState({ installationId: old.installationId,
      expectedRevision: rollback.body.receipt.installationRevision, desiredState: "enabled", operationId: "blocked-enable" }),
      error => error.code === "ACTIVATION_DEFERRED");
    await service.stop({ notify: false }); service = createAgentService(options); await service.start();
    const pending = await post("rollback-list", { installationId: old.installationId });
    assert.equal(pending.body.pending[0].state, "rollback_requires_data_restore");
    const restoreInput = { action: "restore", installationId: old.installationId,
      expectedRevision: rollback.body.receipt.installationRevision, snapshotId: snapshot.snapshotId,
      snapshotDigest: snapshot.snapshotDigest, operationId: "restore-data" };
    let crash = true;
    service.pluginRollbackController.rollback.onPhase = phase => { if (phase === "restore-old-retained" && crash) {
      crash = false; throw Object.assign(new Error("fixture crash"), { code: "PLUGIN_SIMULATED_CRASH" });
    } };
    assert.notEqual((await post("rollback-change", restoreInput)).status, 200);
    const unfinished = await post("rollback-operation", { installationId: old.installationId, operationId: "restore-data" });
    assert.equal(unfinished.body.phase, "committed"); assert.equal(unfinished.body.receipt, null);
    await service.stop({ notify: false }); service = createAgentService(options); await service.start();
    const resumed = await post("rollback-change", { action: "retry", installationId: old.installationId,
      expectedRevision: rollback.body.receipt.installationRevision, operationId: "restore-data" });
    assert.equal(resumed.status, 200); assert.equal(resumed.body.receipt.state, "restored_from_snapshot");
    assert.equal(fs.readFileSync(dataFile, "utf8"), "old-data");
    assert.equal((await post("rollback-list", { installationId: old.installationId })).body.pending.length, 0);
    const receipt = await post("rollback-operation", { installationId: old.installationId, operationId: "restore-data" });
    assert.equal(receipt.body.phase, "completed");
    assert.equal((await post("rollback-operation", { installationId: "another-installation", operationId: "restore-data" })).body.found, false);
    const stale = await backend.preparePluginRollback({ ...snapshotInput, expectedRevision: resumed.body.receipt.installationRevision, operationId: "stale-challenge" });
    service.pluginRollbackController.clear();
    await assert.rejects(backend.commitPluginRollback({ challenge: stale.challenge, approved: true }), error => error.code === "PLUGIN_CONSENT_EXPIRED");
    console.log("plugin rollback Service / Backend / REST / native confirmation / crash recovery fixture: PASS");
  } finally { await web?.close(); await service.stop({ notify: false }); key.fill(0); fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
