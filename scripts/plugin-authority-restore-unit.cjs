"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { componentId } = require("../app/agent-service/plugin-component-catalog");
const { buildPluginToolCatalog } = require("../app/agent-service/plugin-tool-contract");
const { CapabilityDispatcher } = require("../app/agent-service/capability-dispatcher");
const { PermissionEngine } = require("../app/agent-service/permission-engine");
const { createAuthorityBackup, restoreAuthorityBackup, verifyAuthorityBackup } = require("../app/agent-service/authority-backup");

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fileHash = target => hash(fs.readFileSync(target));
const write = (target, content) => {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, content, { mode: 0o600 });
};

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-restore-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "source/state"),
    userDataRoot: path.join(root, "source"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  let store;
  const otherStores = [];
  try {
    store = new PluginStore({ paths }).open();
    const originalIncarnation = store.getAuthorityIncarnation();
    assert.match(originalIncarnation, /^[a-f0-9]{64}$/u);
    const installer = new PluginPackageInstaller({ store });
    const sourcePath = path.join(__dirname, "fixtures/plugins/project-assistant");
    const preview = installer.preview(sourcePath);
    let installation = installer.install({ sourcePath, previewDigest: preview.contentDigest,
      operationId: "install-original", expectedRevision: 0 });
    installation = store.setInstallationDesiredState({ installationId: installation.installationId,
      desiredState: "enabled", expectedRevision: installation.revision });
    let connection = store.createConnection({ connectionId: "restore-connection", installationId: installation.installationId,
      componentId: componentId(installation.installationId, "mcp-server", "local-issues"), endpointIdentity: "fixture://restore" });
    connection = store.setConnectionIdentity({ connectionId: connection.connectionId,
      principalIdentity: "fixture-account", state: "ready", expectedRevision: connection.revision });
    let binding = store.createBinding({ bindingId: "restore-binding", profileId: "profile-a", installationId: installation.installationId,
      componentId: connection.componentId, connectionId: connection.connectionId });
    binding = store.setBindingEnabled({ bindingId: binding.bindingId, enabled: true, expectedRevision: binding.revision });
    const catalog = buildPluginToolCatalog({ installationId: installation.installationId, componentId: connection.componentId,
      connectionId: connection.connectionId, tools: ["write", "approve-write"].map(name => ({ name, inputSchema: { type: "object" } })) });
    const tools = new Map(catalog.entries.map(entry => [entry.downstreamName, { ...entry, catalogRevision: catalog.generationDigest }]));
    for (const tool of tools.values()) store.setGrant({ grantId: `grant-${tool.downstreamName}`, bindingId: binding.bindingId,
      toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest, effect: "allow",
      approvalMode: tool.downstreamName === "write" ? "always" : "each-call", expectedRevision: 0 });
    const profile = { id: "profile-a", name: "Fixture", enabled: true };
    const policy = new PermissionEngine({ toolRegistry: { revision: "fixture", get: () => ({ enabled: true, risk: "write" }), list: () => [] } });
    const dynamicStore = new Proxy({}, { get: (_target, key) => typeof store[key] === "function" ? store[key].bind(store) : store[key] });
    const dispatcher = new CapabilityDispatcher({ store: dynamicStore, permissionEngine: policy,
      resolveToolContract: ({ toolIdentity }) => [...tools.values()].find(tool => tool.toolIdentity === toolIdentity) });
    const request = (callId, name = "write") => {
      const tool = tools.get(name);
      const records = store.getCapabilityRecords(binding.bindingId, tool.toolIdentity);
      return { callId, authority: { kind: "native-profile", profileId: profile.id, profile, confirmed: false },
        execution: { kind: "native-run", profileId: profile.id, workspace: root,
          run: { id: "original-run", profileId: profile.id, workspace: root } },
        envelope: { authorityIncarnation: records.authorityIncarnation, runId: "original-run",
          bindingId: binding.bindingId, installationId: installation.installationId,
          releaseDigest: installation.releaseDigest, componentId: connection.componentId,
          connectionId: connection.connectionId, principalIdentity: connection.principalIdentity,
          bindingRevision: records.binding.revision, grantEpoch: records.grant.epoch,
          connectionAuthRevision: records.connection.authRevision, toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest },
        bindingId: binding.bindingId, toolIdentity: tool.toolIdentity, downstreamToolName: name,
        contractDigest: tool.contractDigest, arguments: {} };
    };
    const oldRequest = request("old-ticket");
    const oldApprovalRequest = request("old-approval", "approve-write");
    const oldTicket = dispatcher.issueTicket(oldRequest);
    const oldApproval = dispatcher.approveCall(oldApprovalRequest);
    const originalRecords = store.getCapabilityRecords(binding.bindingId, tools.get("write").toolIdentity);
    const originalApprovedGrant = store.getGrant(binding.bindingId, tools.get("approve-write").toolIdentity);
    const receipt = (callId, phase = "prepared") => {
      const input = request(callId);
      store.beginCapabilityCall({ callId, runRef: "original-run", bindingId: binding.bindingId,
        connectionId: connection.connectionId, principalIdentity: connection.principalIdentity,
        toolIdentity: input.toolIdentity, contractDigest: input.contractDigest, argumentDigest: hash("{}") });
      if (phase !== "prepared") store.markCapabilityCallSendStarted(callId);
      if (phase === "result_confirmed") store.finishCapabilityCall(callId, { resultConfirmed: true });
    };
    receipt("snapshot-prepared"); receipt("snapshot-sent", "send_started"); receipt("snapshot-confirmed", "result_confirmed");
    const pendingFingerprint = "a".repeat(64);
    store.beginInstall({ operationId: "pending-install", fingerprint: pendingFingerprint });
    const dataRelative = `plugins/data/${installation.installationId}/fixture/record.json`;
    write(path.join(paths.stateDir, dataRelative), '{"data":"snapshot"}\n');
    write(path.join(paths.pluginStagingDir, "transient/secret"), "excluded transient fixture");
    write(paths.encryptedSecretsPath, '{"fixtureCiphertext":"preserved"}\n');
    store.close();
    const backupId = "before-revoke-and-write";
    const backup = createAuthorityBackup({ paths, backupId });
    assert.equal(backup.manifest.entries.some(entry => entry.path.startsWith("plugins/staging")), false);
    assert.equal(backup.manifest.entries.some(entry => entry.path === dataRelative), true);
    const backupCatalog = path.join(backup.backupPath, "payload/plugins/catalog.sqlite");
    const backupCatalogDigest = fileHash(backupCatalog);
    const packageFiles = backup.manifest.entries.filter(entry => entry.type === "file" && entry.path.startsWith("plugins/packages/"));
    assert(packageFiles.length > 0);

    store = new PluginStore({ paths }).open();
    let effects = 0;
    const client = { async callTool(name, args, authority) {
      dispatcher.authorizeEgress({ connectionId: connection.connectionId,
        principalIdentity: connection.principalIdentity, toolName: name, arguments: args, authority });
      effects += 1;
      return { content: [{ type: "text", text: "write completed" }] };
    } };
    await dispatcher.dispatch({ ...request("write-after-backup"), client });
    assert.equal(effects, 1);
    store.performManagementOperation({ operationId: "operation-after-backup", kind: "grant-revoke",
      fingerprint: "b".repeat(64), apply: () => ({ fixture: true }) });
    for (const tool of tools.values()) {
      const grant = store.getGrant(binding.bindingId, tool.toolIdentity);
      store.revokeGrant({ bindingId: binding.bindingId, toolIdentity: tool.toolIdentity, expectedRevision: grant.revision });
    }
    write(path.join(paths.stateDir, dataRelative), '{"data":"newer"}\n');
    store.close();
    const currentCatalogDigest = fileHash(paths.pluginCatalogPath);
    write(paths.lockPath, "stopped-fixture-lock");
    assert.throws(() => restoreAuthorityBackup({ paths, backupId, destinationStateDir: path.join(root, "active-denied") }),
      { code: "BACKUP_SERVICE_ACTIVE" });
    fs.unlinkSync(paths.lockPath);
    const destinationStateDir = path.join(root, "restored");
    const restored = restoreAuthorityBackup({ paths, backupId, destinationStateDir });
    assert.notEqual(restored.pluginRestore.authorityIncarnation, originalIncarnation);
    assert.equal(restored.pluginRestore.receiptGap, false);
    assert.equal(restored.pluginRestore.importedCalls, 1);
    assert.equal(restored.pluginRestore.importedOperations, 1);
    assert.equal(restored.pluginRestore.grantsRequireConfirmation, 2);
    assert.equal(fileHash(paths.pluginCatalogPath), currentCatalogDigest, "restore never writes source catalog");
    assert.equal(fileHash(backupCatalog), backupCatalogDigest, "restore never writes backup catalog");
    assert.equal(verifyAuthorityBackup({ paths, backupId }).manifest.rootDigest, backup.manifest.rootDigest);
    assert.equal(fs.readFileSync(path.join(destinationStateDir, dataRelative), "utf8"), '{"data":"snapshot"}\n');
    for (const entry of packageFiles) assert.equal(fileHash(path.join(destinationStateDir, entry.path)), entry.sha256);
    assert.equal(fileHash(path.join(destinationStateDir, "encrypted-secrets.json")), fileHash(paths.encryptedSecretsPath));
    const restoredPaths = resolveServicePaths({ stateRoot: destinationStateDir, trustedRoot: root });
    store = new PluginStore({ paths: restoredPaths }).open();
    assert.equal(store.getAuthorityIncarnation(), restored.pluginRestore.authorityIncarnation);
    assert.equal(store.getInstallation(installation.installationId).desiredState, "disabled");
    assert.equal(store.getBinding(binding.bindingId).enabled, false);
    assert.equal(store.getConnection(connection.connectionId).state, "disconnected");
    for (const tool of tools.values()) assert.equal(store.getGrant(binding.bindingId, tool.toolIdentity).effect, "deny");
    for (const callId of ["old-ticket", "snapshot-prepared", "snapshot-sent", "write-after-backup"]) {
      assert.equal(store.getCapabilityCall(callId).phase, "outcome_unknown");
      assert.throws(() => receipt(callId), { code: "CALL_ALREADY_RECORDED" });
    }
    assert.equal(store.getCapabilityCall("snapshot-confirmed").phase, "result_confirmed");
    assert.equal(store.getOperation("pending-install").phase, "outcome_unknown");
    assert.throws(() => store.beginInstall({ operationId: "pending-install", fingerprint: pendingFingerprint }),
      { code: "PLUGIN_OPERATION_OUTCOME_UNKNOWN" });
    store.markFailed("pending-install", "ignored");
    assert.equal(store.getOperation("pending-install").phase, "outcome_unknown");
    assert.throws(() => store.performManagementOperation({ operationId: "operation-after-backup", kind: "grant-revoke",
      fingerprint: "b".repeat(64), apply: () => { effects += 1; } }), { code: "PLUGIN_OPERATION_OUTCOME_UNKNOWN" });
    assert.equal(effects, 1);

    // Simulate freshly verified account/Grants and even exact old numeric
    // revision collisions. Only the random incarnation differs from the Run.
    store._db().prepare("UPDATE installations SET desired_state = 'enabled', revision = ?").run(originalRecords.installation.revision);
    store._db().prepare("UPDATE bindings SET enabled = 1, revision = ?").run(originalRecords.binding.revision);
    store._db().prepare("UPDATE connections SET state = 'ready', auth_revision = ?, revision = ?")
      .run(originalRecords.connection.authRevision, originalRecords.connection.revision);
    for (const grant of [originalRecords.grant, originalApprovedGrant]) {
      store._db().prepare("UPDATE grants SET effect = 'allow', epoch = ?, revision = ? WHERE id = ?")
        .run(grant.epoch, grant.revision, grant.grantId);
    }
    assert.throws(() => dispatcher.issueTicket({ ...oldRequest, callId: "old-envelope-new-id" }), { code: "TOOL_CONTRACT_CHANGED" });
    assert.throws(() => dispatcher.issueTicket({ ...oldApprovalRequest, approvalReceipt: oldApproval }), { code: "TOOL_CONTRACT_CHANGED" });
    assert.throws(() => dispatcher.authorizeEgress({ connectionId: connection.connectionId,
      principalIdentity: connection.principalIdentity, toolName: "write", arguments: {}, authority: { ticketId: oldTicket } }),
    { code: "TOOL_CONTRACT_CHANGED" });
    await assert.rejects(dispatcher.dispatch({ ...request("write-after-backup"), client }), { code: "CALL_ALREADY_RECORDED" });
    assert.equal(effects, 1, "completed external write must not be replayed after restoring older snapshot");
    await dispatcher.dispatch({ ...request("fresh-explicit-call"), client });
    assert.equal(effects, 2, "fresh authority can execute a new explicitly authorized call");
    store.close();
    store = new PluginStore({ paths: restoredPaths }).open();
    assert.equal(store.getAuthorityIncarnation(), restored.pluginRestore.authorityIncarnation, "ordinary restart does not rotate authority");
    store.close();

    const second = restoreAuthorityBackup({ paths, backupId, destinationStateDir: path.join(root, "restored-again") });
    assert.notEqual(second.pluginRestore.authorityIncarnation, restored.pluginRestore.authorityIncarnation);
    fs.renameSync(paths.pluginCatalogPath, `${paths.pluginCatalogPath}.fixture-held`);
    const gap = restoreAuthorityBackup({ paths, backupId, destinationStateDir: path.join(root, "receipt-gap") });
    assert.equal(gap.pluginRestore.receiptGap, true);
    const gapStore = new PluginStore({ paths: resolveServicePaths({ stateRoot: gap.destinationStateDir, trustedRoot: root }) }).open();
    otherStores.push(gapStore);
    assert.equal(gapStore.getAuthorityState().receiptGap, true);
    assert.notEqual(gapStore.getAuthorityIncarnation(), originalIncarnation);
    assert.equal(gapStore.getGrant(binding.bindingId, tools.get("write").toolIdentity).effect, "deny");
    fs.renameSync(`${paths.pluginCatalogPath}.fixture-held`, paths.pluginCatalogPath);

    // A product-only archive from before the first plugin store open preserves
    // its bytes and receives no synthetic plugin database or receipt fields.
    const oldPaths = resolveServicePaths({ stateRoot: path.join(root, "product-only/state"),
      userDataRoot: path.join(root, "product-only"), trustedRoot: root });
    write(oldPaths.stateSnapshotPath, '{"schemaVersion":15,"fixture":true}\n');
    createAuthorityBackup({ paths: oldPaths, backupId: "product-only" });
    const oldRestore = restoreAuthorityBackup({ paths: oldPaths, backupId: "product-only",
      destinationStateDir: path.join(root, "product-only-restored") });
    assert.equal(Object.hasOwn(oldRestore, "pluginRestore"), false);
    assert.equal(fs.existsSync(path.join(oldRestore.destinationStateDir, "plugins")), false);
    assert.equal(fileHash(path.join(oldRestore.destinationStateDir, "state.snapshot.json")), fileHash(oldPaths.stateSnapshotPath));
    console.log("plugin authority restore/incarnation/no-replay fixture: PASS");
  } finally {
    store?.close(); for (const other of otherStores) other.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
