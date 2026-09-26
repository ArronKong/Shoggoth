"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { componentId, PluginComponentCatalog } = require("../app/agent-service/plugin-component-catalog");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-uninstall-"));
const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), userDataRoot: root,
  profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
let store = new PluginStore({ paths }).open();
let installer = new PluginPackageInstaller({ store });
const digest = crypto.createHash("sha256").update("fixture-contract").digest("hex");
const rejected = (callback, code) => assert.throws(callback, { code });
const restart = () => {
  store.close();
  store = new PluginStore({ paths }).open();
  installer = new PluginPackageInstaller({ store });
};
function install(name, unique = false) {
  const sourcePath = path.join(root, name);
  fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), sourcePath, { recursive: true });
  if (unique) fs.appendFileSync(path.join(sourcePath, "skills/issue-summary/SKILL.md"), `\n${name}\n`);
  const preview = installer.preview(sourcePath);
  const installed = installer.install({ sourcePath, previewDigest: preview.contentDigest,
    operationId: `install-${name}`, expectedRevision: 0 });
  return { ...installed, sourcePath };
}
function authority(installed, prefix) {
  const enabled = store.setInstallationDesiredState({ installationId: installed.installationId,
    desiredState: "enabled", expectedRevision: installed.revision });
  const connection = store.createConnection({ connectionId: `${prefix}-connection`,
    installationId: installed.installationId,
    componentId: componentId(installed.installationId, "mcp-server", "local-issues"),
    endpointIdentity: `fixture://${prefix}`, credentialRef: `${prefix}-secret` });
  const ready = store.setConnectionIdentity({ connectionId: connection.connectionId,
    principalIdentity: `${prefix}-account`, state: "ready", expectedRevision: connection.revision });
  const binding = store.createBinding({ bindingId: `${prefix}-binding`, profileId: `${prefix}-agent`,
    installationId: installed.installationId, componentId: ready.componentId,
    connectionId: ready.connectionId });
  const bound = store.setBindingEnabled({ bindingId: binding.bindingId, enabled: true,
    expectedRevision: binding.revision });
  const grant = store.setGrant({ grantId: `${prefix}-grant`, bindingId: bound.bindingId,
    toolIdentity: "fixture-echo", contractDigest: digest, effect: "allow",
    approvalMode: "always", expectedRevision: 0 });
  return { enabled, ready, bound, grant };
}
function call(id, auth, phase) {
  store.beginCapabilityCall({ callId: id, runRef: "fixture-run", bindingId: auth.bound.bindingId,
    connectionId: auth.ready.connectionId, principalIdentity: auth.ready.principalIdentity,
    toolIdentity: "fixture-echo", contractDigest: digest, argumentDigest: digest });
  if (phase !== "prepared") store.markCapabilityCallSendStarted(id);
  if (phase === "outcome_unknown") store.finishCapabilityCall(id);
}

try {
  const a = install("source-a");
  const b = install("source-b");
  assert.equal(a.releaseDigest, b.releaseDigest, "two sources share immutable content");
  const authA = authority(a, "a");
  const authB = authority(b, "b");
  rejected(() => installer.beginUninstall({ installationId: a.installationId,
    expectedRevision: authA.enabled.revision, operationId: "enabled-uninstall" }),
  "PLUGIN_UNINSTALL_REQUIRES_DISABLE");
  assert.equal(store.getOperation("enabled-uninstall"), null);
  const disabledA = store.setInstallationDesiredState({ installationId: a.installationId,
    desiredState: "disabled", expectedRevision: authA.enabled.revision });
  call("prepared-a", authA, "prepared");
  call("sending-a", authA, "send_started");
  call("unknown-a", authA, "outcome_unknown");
  const data = path.join(paths.pluginDataDir, "retained-fixture.json");
  const secret = path.join(root, "encrypted-secrets-fixture");
  fs.writeFileSync(data, "persistent data", { mode: 0o600 });
  fs.writeFileSync(secret, "encrypted credential", { mode: 0o600 });
  const requestA = { installationId: a.installationId, expectedRevision: disabledA.revision,
    operationId: "uninstall-a" };
  const preview = installer.previewUninstall(requestA);
  assert.equal(preview.affectedAgentCount, 1);
  assert.equal(preview.bindingCount, 1);
  assert.equal(preview.connectionCount, 1);
  assert.equal(preview.activeCallCount, 1);
  assert.equal(preview.dataRetained, true);
  assert.equal(preview.credentialsRetained, true);
  assert.equal(installer.beginUninstall(requestA).phase, "created");
  const epoch = store.getGrant(authA.bound.bindingId, "fixture-echo").epoch;
  assert.equal(store.getGrant(authA.bound.bindingId, "fixture-echo").effect, "deny");
  assert.equal(store.getBinding(authA.bound.bindingId).enabled, false);
  assert.equal(store.getCapabilityCall("prepared-a").phase, "rejected_before_send");
  installer.beginUninstall(requestA);
  assert.equal(store.getGrant(authA.bound.bindingId, "fixture-echo").epoch, epoch,
    "retry does not repeat revocation");
  rejected(() => installer.uninstall(requestA), "ACTIVATION_DEFERRED");
  rejected(() => installer.beginUninstall({ ...requestA, expectedRevision: requestA.expectedRevision + 1 }),
    "REVISION_CONFLICT");
  rejected(() => installer.beginUninstall({ ...requestA, operationId: "competing-uninstall" }),
    "ACTIVATION_DEFERRED");
  rejected(() => store.setInstallationDesiredState({ installationId: a.installationId,
    desiredState: "enabled", expectedRevision: disabledA.revision }), "ACTIVATION_DEFERRED");
  rejected(() => store.setConnectionIdentity({ connectionId: authA.ready.connectionId,
    principalIdentity: "a-account", state: "ready", expectedRevision: authA.ready.revision }),
  "ACTIVATION_DEFERRED");
  rejected(() => installer.install({ sourcePath: a.sourcePath, previewDigest: a.releaseDigest,
    operationId: "install-during-uninstall", expectedRevision: disabledA.revision }), "ACTIVATION_DEFERRED");

  restart();
  assert.equal(store.hasPendingInstallationDisable(a.installationId), true);
  assert.equal(store.getCapabilityCall("sending-a").phase, "outcome_unknown");
  const resultA = installer.uninstall(requestA);
  assert.equal(resultA.packageRemoved, false, "another installation keeps the shared digest");
  assert.equal(resultA.dataRetained, true);
  assert.equal(resultA.credentialsRetained, true);
  assert.equal(store.getOperation(requestA.operationId).phase, "completed");
  assert.equal(store.listInstallations().length, 1);
  assert.equal(new PluginComponentCatalog({ store }).list()[0].installationId, b.installationId);
  assert.equal(store.getConnectionAuth(authA.ready.connectionId).credentialRef, "a-secret");
  assert.equal(store.getConnection(authA.ready.connectionId).state, "disconnected");
  assert.deepEqual(store.getConnection(authB.ready.connectionId), authB.ready);
  assert.deepEqual(store.getBinding(authB.bound.bindingId), authB.bound);
  assert.deepEqual(store.getGrant(authB.bound.bindingId, "fixture-echo"), authB.grant);
  assert.equal(store.getCapabilityCall("unknown-a").phase, "outcome_unknown");
  rejected(() => call("unknown-a", authA, "prepared"), "CALL_ALREADY_RECORDED");
  assert.equal(fs.readFileSync(data, "utf8"), "persistent data");
  assert.equal(fs.readFileSync(secret, "utf8"), "encrypted credential");
  rejected(() => store.setInstallationDesiredState({ installationId: a.installationId,
    desiredState: "enabled", expectedRevision: resultA.revision }), "PLUGIN_INSTALLATION_INVALID");
  const nextPreview = installer.preview(a.sourcePath);
  assert.equal(nextPreview.expectedRevision, resultA.revision);
  const reinstalled = installer.install({ sourcePath: a.sourcePath, previewDigest: a.releaseDigest,
    operationId: "reinstall-a", expectedRevision: nextPreview.expectedRevision });
  assert.equal(reinstalled.desiredState, "disabled");
  assert.equal(reinstalled.revision, resultA.revision + 1);
  assert.equal(store.getBinding(authA.bound.bindingId).enabled, false);
  assert.equal(store.getGrant(authA.bound.bindingId, "fixture-echo").effect, "deny");
  assert.deepEqual(installer.uninstall(requestA), resultA, "old operation replay cannot uninstall a new generation");
  assert.equal(store.getInstallation(a.installationId).revision, reinstalled.revision);

  for (const phase of ["uninstall-committed", "uninstall-removed"]) {
    const unique = install(`crash-${phase}`, true);
    const request = { installationId: unique.installationId, expectedRevision: unique.revision,
      operationId: `op-${phase}` };
    const crashing = new PluginPackageInstaller({ store, onPhase(current) {
      if (current === phase) throw Object.assign(new Error("simulated crash"), { code: "PLUGIN_SIMULATED_CRASH" });
    } });
    rejected(() => crashing.uninstall(request), "PLUGIN_SIMULATED_CRASH");
    assert.equal(store.getOperation(request.operationId).phase, "committed");
    assert.equal(store.getInstallation(unique.installationId).desiredState, "uninstalled");
    restart();
    const resumed = installer.uninstall(request);
    assert.equal(resumed.packageRemoved, true);
    assert.equal(fs.existsSync(path.join(paths.pluginPackagesDir, unique.releaseDigest)), false);
    assert.equal(fs.existsSync(unique.sourcePath), true);
    assert.equal(store.getOperation(request.operationId).phase, "completed");
  }

  const unsafe = install("unsafe-cleanup", true);
  const packagePath = path.join(paths.pluginPackagesDir, unsafe.releaseDigest);
  const savedPath = path.join(paths.pluginStagingDir, "unsafe-original");
  fs.renameSync(packagePath, savedPath);
  fs.symlinkSync(unsafe.sourcePath, packagePath);
  const unsafeRequest = { installationId: unsafe.installationId, expectedRevision: unsafe.revision,
    operationId: "unsafe-uninstall" };
  rejected(() => installer.uninstall(unsafeRequest), "PACKAGE_PATH_INVALID");
  assert.equal(store.getOperation(unsafeRequest.operationId).phase, "committed");
  assert.equal(fs.existsSync(path.join(unsafe.sourcePath, "skills/issue-summary/SKILL.md")), true);
  fs.unlinkSync(packagePath);
  fs.renameSync(savedPath, packagePath);
  assert.equal(installer.uninstall(unsafeRequest).packageRemoved, true);
  assert.equal(fs.readFileSync(data, "utf8"), "persistent data");
  assert.equal(fs.readFileSync(secret, "utf8"), "encrypted credential");
  console.log("plugin disabled uninstall/restart/data retention fixture: PASS");
} finally {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
