"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { resolveServicePaths } = require(
  "../app/agent-service/paths",
);
const { JsonlProductStore, snapshotChecksum } = require("../app/agent-service/product-store");
const { PluginStore, PLUGIN_STORE_SCHEMA_VERSION } = require(
  "../app/agent-service/plugin-store",
);
const { PluginPackageInstaller } = require(
  "../app/agent-service/plugin-package-installer",
);
const { createAgentService } = require("../app/agent-service/server");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { newPluginCredentialRef } = require("../app/agent-service/plugin-credential-vault");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");

const fixtureKey = crypto.randomBytes(32);
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString(value) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", fixtureKey, nonce);
    return Buffer.concat([nonce, cipher.update(value, "utf8"),
      cipher.final(), cipher.getAuthTag()]);
  },
  decryptString(value) {
    const nonce = value.subarray(0, 12);
    const decipher = crypto.createDecipheriv("aes-256-gcm", fixtureKey, nonce);
    decipher.setAuthTag(value.subarray(-16));
    return Buffer.concat([decipher.update(value.subarray(12, -16)),
      decipher.final()]).toString("utf8");
  },
};
function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function service(paths, overrides = {}) {
  return createAgentService({ paths, safeStorage, prewarmMcpAuth: false,
    parentEnv: {}, version: "plugin-candidate-fixture", ...overrides });
}
function pluginRpc(paths, method, params, extra = {}) {
  return requestService(paths, { token: readClientToken(paths),
    version: SERVICE_PROTOCOL_VERSION, method, params, ...extra },
  { timeoutMs: 10_000 });
}

async function main() {
  // The macOS Service socket has a short sockaddr_un limit, so keep the
  // entire synthetic root under /private/tmp rather than the long TMPDIR.
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sgp-"));
  fs.chmodSync(root, 0o700);
  try {
    const current = resolveServicePaths({ userDataRoot: path.join(root, "current"),
      cacheRoot: path.join(root, "cache"), trustedRoot: root });
    const standard = service(current);
    assert(standard.pluginStore, "plugins are available in the default product root");
    assert.notEqual(standard.runtimeSkillStore, standard.nativeSkillStore);
    await standard.start();
    assert.equal((await new ShoggothBackend({ paths: current })
      .getPluginCapabilitiesPage({ cursor: 0, limit: 10, catalogRevision: null })).supported, true);
    await standard.stop({ notify: false });
    assert.equal(fs.existsSync(current.pluginCatalogPath), true);

    const candidate = resolveServicePaths({
      userDataRoot: path.join(root, "other"), cacheRoot: path.join(root, "other-cache"), trustedRoot: root,
    });
    const first = service(candidate, { pluginPrincipalVerifier: ({ accessToken }) =>
      ["fixture-access-vault", "fixture-access-vault-rotated"].includes(accessToken)
        ? "fixture-account-a" : null,
    pluginRefreshTokens: async () => ({ access_token: "fixture-access-vault-rotated",
      refresh_token: "fixture-refresh-vault-rotated", token_type: "Bearer",
      expires_in: 120, scope: "issues:read" }) });
    assert(first.pluginStore);
    assert.notEqual(first.runtimeSkillStore, first.nativeSkillStore);
    assert.equal(first.contextCompiler.skillStore, first.runtimeSkillStore);
    await first.start();
    assert.deepEqual(first.pluginStore.listInstallations(), []);
    await assert.rejects(pluginRpc(candidate, "plugins.capabilities.list",
      { cursor: 0, limit: 10, catalogRevision: null }, { token: "invalid-token" }),
    { code: "AUTH_FAILED" });
    assert.deepEqual((await pluginRpc(candidate, "plugins.capabilities.list",
      { cursor: 0, limit: 10, catalogRevision: null })).items, []);
    const fixture = path.join(__dirname, "fixtures", "plugins", "project-assistant");
    const source = { kind: "directory", path: fixture };
    await assert.rejects(pluginRpc(candidate, "plugins.install.preview",
      { source, extra: true }), { code: "PLUGIN_REQUEST_INVALID" });
    await assert.rejects(pluginRpc(candidate, "plugins.install.preview",
      { source }, { unexpected: true }), { code: "PLUGIN_REQUEST_INVALID" });
    const emptyPage = first.pluginServiceController.handle("plugins.capabilities.list",
      { cursor: 0, limit: 10, catalogRevision: null });
    assert.deepEqual(emptyPage.items, []);
    assert.throws(() => first.pluginServiceController.handle("plugins.install.preview",
      { source: { kind: "directory", path: "./relative" } }),
    { code: "PLUGIN_REQUEST_INVALID" });
    assert.throws(() => first.pluginServiceController.handle("plugins.install.preview",
      { source, extra: true }), { code: "PLUGIN_REQUEST_INVALID" });
    assert.throws(() => first.pluginServiceController.handle("plugins.install.preview",
      { source: { kind: "git", repositoryPath: root, commit: "HEAD", subdir: null } }),
    { code: "PLUGIN_REQUEST_INVALID" });
    const preview = await pluginRpc(candidate, "plugins.install.preview", { source });
    const candidateBackend = new ShoggothBackend({ paths: candidate });
    assert.deepEqual(await candidateBackend.previewPluginInstall(source), preview);
    const unsafePreviewBackend = new ShoggothBackend({ paths: candidate,
      readToken: () => "fixture-token",
      requestService: async () => ({ ...preview, sourceIdentity: `local:${fixture}` }) });
    await assert.rejects(unsafePreviewBackend.previewPluginInstall(source),
      { code: "PLUGIN_RESPONSE_INVALID" });
    assert.equal(preview.installable, true);
    assert.equal(preview.sourceKind, "directory");
    assert.equal(Object.hasOwn(preview, "sourceIdentity"), false);
    assert.equal(Object.hasOwn(preview, "root"), false);
    assert.equal(Object.hasOwn(preview, "files"), false);
    assert.throws(() => first.pluginServiceController.handle("plugins.install", {
      source, previewDigest: { toString() { throw new Error("must not coerce"); } },
      operationId: "invalid-request", expectedRevision: 0,
    }), { code: "PLUGIN_REQUEST_INVALID" });
    assert.equal(first.pluginStore.getOperation("invalid-request"), null);
    const installedResult = await pluginRpc(candidate, "plugins.install", {
      source, previewDigest: preview.previewDigest,
      operationId: "candidate-fixture-install", expectedRevision: preview.expectedRevision,
    });
    const installed = installedResult.installation;
    assert.deepEqual((await candidateBackend.installPlugin({
      source, previewDigest: preview.previewDigest,
      operationId: "candidate-fixture-install", expectedRevision: preview.expectedRevision,
    })).installation, installed);
    assert.equal(installedResult.operation.phase, "completed");
    assert.equal(installed.sourceKind, "directory");
    assert.equal(Object.hasOwn(installed, "sourceIdentity"), false);
    assert.equal(Object.hasOwn(installedResult.operation.result, "sourceIdentity"), false);
    assert.equal((await pluginRpc(candidate, "plugins.operations.get",
      { operationId: "candidate-fixture-install" })).operation.phase, "completed");
    assert.equal((await candidateBackend.getPluginOperation("candidate-fixture-install"))
      .operation.phase, "completed");
    assert.equal((await pluginRpc(candidate, "plugins.operations.get",
      { operationId: "missing-operation" })).found, false);
    assert.equal(installed.desiredState, "disabled");
    const firstPage = first.pluginServiceController.handle("plugins.capabilities.list",
      { cursor: 0, limit: 10, catalogRevision: null });
    assert.equal(firstPage.items.length, 1);
    assert.equal(Object.hasOwn(firstPage.items[0], "sourceIdentity"), false);
    assert.deepEqual((await pluginRpc(candidate, "plugins.capabilities.list",
      { cursor: 0, limit: 10, catalogRevision: null })).items, firstPage.items);
    const backendPage = await new ShoggothBackend({ paths: candidate })
      .getPluginCapabilitiesPage({ cursor: 0, limit: 10, catalogRevision: null });
    assert.equal(backendPage.supported, true);
    assert.equal(backendPage.items[0].installationId, installed.installationId);
    assert.equal(Object.hasOwn(backendPage.items[0], "sourceIdentity"), false);
    assert.equal(Object.hasOwn(backendPage.items[0], "diagnostics"), false);
    const unsafeBackend = new ShoggothBackend({ paths: candidate,
      readToken: () => "fixture-token",
      requestService: async () => ({ ...firstPage,
        items: [{ ...firstPage.items[0], sourceIdentity: `local:${fixture}` }] }) });
    await assert.rejects(unsafeBackend.getPluginCapabilitiesPage({
      cursor: 0, limit: 10, catalogRevision: null,
    }), { code: "PLUGIN_RESPONSE_INVALID" });
    assert.equal(firstPage.nextCursor, null);
    const components = first.pluginComponentCatalog.list()[0].components;
    assert.equal(components.length, 3);
    const selectedSkill = components.find((item) => item.kind === "skill");
    const skillRef = { installationId: installed.installationId,
      releaseDigest: installed.releaseDigest, componentId: selectedSkill.componentId,
      descriptorDigest: selectedSkill.descriptorDigest };
    assert.throws(() => first.pluginComponentResolver.inspectSkill(skillRef),
      { code: "PLUGIN_COMPONENT_INACTIVE" });
    const enableInput = { installationId: installed.installationId,
      desiredState: "enabled", expectedRevision: installed.revision,
      operationId: "candidate-enable-installation" };
    const enabledResult = await pluginRpc(candidate, "plugins.installations.set", enableInput);
    const enabled = enabledResult.installation;
    assert.equal(enabled.desiredState, "enabled");
    assert.deepEqual(await candidateBackend.setPluginInstallationState(enableInput),
      enabledResult);
    assert.deepEqual(await pluginRpc(candidate, "plugins.installations.set", enableInput),
      enabledResult);
    await assert.rejects(pluginRpc(candidate, "plugins.installations.set", {
      ...enableInput, desiredState: "disabled",
    }), { code: "REVISION_CONFLICT" });
    const boundProfile = first.productStore.listAgentProfiles().find((item) => item.enabled);
    assert(boundProfile);
    const bindInput = { profileId: boundProfile.id,
      installationId: installed.installationId, componentId: selectedSkill.componentId,
      enabled: true, expectedRevision: 0, operationId: "candidate-bind-skill" };
    const bindingResult = await pluginRpc(candidate, "plugins.skills.bindings.set", bindInput);
    assert.equal(bindingResult.binding.enabled, true);
    candidateBackend._profilesByAgent.set(boundProfile.agentId, boundProfile);
    assert.deepEqual(await candidateBackend.setPluginSkillBinding({
      ...bindInput, agentId: boundProfile.agentId }), bindingResult);
    assert.deepEqual(await pluginRpc(candidate, "plugins.skills.bindings.set", bindInput),
      bindingResult);
    assert.equal((await pluginRpc(candidate, "plugins.skills.bindings.list",
      { profileId: boundProfile.id })).items.length, 1);
    assert.equal((await candidateBackend.getPluginSkillBindings(boundProfile.agentId))
      .items.length, 1);
    const projectedSkill = first.runtimeSkillStore.catalog(boundProfile.id).items
      .find((item) => item.source === "plugin");
    assert(projectedSkill);
    assert.match(first.runtimeSkillStore.read({ profileId: boundProfile.id,
      name: projectedSkill.name, contentHash: projectedSkill.contentHash }).content,
    /issue-summary/u);
    assert.throws(() => first.pluginServiceController.handle("plugins.capabilities.list",
      { cursor: 1, limit: 10, catalogRevision: firstPage.catalogRevision }),
    { code: "REVISION_CONFLICT" });
    assert.match(first.pluginComponentResolver.inspectSkill(skillRef).content,
      /issue-summary/u);
    const mcpComponent = components.find((item) => item.localName === "remote-issues");
    const initialMcpStatus = await pluginRpc(candidate, "plugins.mcp.status", {
      profileId: boundProfile.id, installationId: installed.installationId });
    assert.equal(initialMcpStatus.items.find((item) =>
      item.componentId === mcpComponent.componentId).connections.verified, 0);
    await assert.rejects(pluginRpc(candidate, "plugins.mcp.status", {
      profileId: boundProfile.id, installationId: installed.installationId,
      includeSecrets: true }), { code: "PLUGIN_REQUEST_INVALID" });
    const vaultConnection = first.pluginStore.createConnection({
      connectionId: "candidate-vault-connection",
      installationId: installed.installationId,
      componentId: mcpComponent.componentId,
      endpointIdentity: "https://fixture.example/mcp",
      credentialRef: newPluginCredentialRef(),
    });
    await first.pluginCredentialVault.storePendingOAuthTokens({
      connectionId: vaultConnection.connectionId,
      expectedRevision: vaultConnection.revision,
      tokens: { access_token: "fixture-access-vault",
        refresh_token: "fixture-refresh-vault", token_type: "Bearer",
        expires_in: 120, scope: "issues:read" },
      issuer: "https://fixture.example/", audience: "fixture-api",
      requestedScopes: ["issues:read"],
    });
    assert.equal(await first.pluginCredentialVault.readCredential(
      vaultConnection.connectionId), null);
    const vaultReady = await first.pluginCredentialVault.verifyAndActivate({
      connectionId: vaultConnection.connectionId,
      expectedRevision: vaultConnection.revision,
    });
    assert.equal(vaultReady.principalIdentity, "fixture-account-a");
    assert.equal(Object.hasOwn(vaultReady, "credentialRef"), false);
    const credentialProvider = first.pluginConnectionAuth.credentialProvider({
      connectionId: vaultReady.connectionId,
      principalIdentity: vaultReady.principalIdentity,
      authRevision: vaultReady.authRevision,
      endpointIdentity: vaultReady.endpointIdentity,
      issuer: "https://fixture.example/", audience: "fixture-api",
      requiredScopes: ["issues:read"],
    });
    assert.equal((await credentialProvider()).accessToken, "fixture-access-vault");
    assert.equal(fs.readFileSync(candidate.encryptedSecretsPath, "utf8")
      .includes("fixture-access-vault"), false);
    assert.equal(fs.readFileSync(candidate.pluginCatalogPath)
      .includes(Buffer.from("fixture-access-vault")), false);
    const vaultCatalogContext = {
      installation: { ...enabled, activeReleaseDigest: enabled.releaseDigest },
      binding: { componentId: vaultReady.componentId,
        connectionId: vaultReady.connectionId },
      connection: vaultReady,
    };
    await first.pluginToolCatalogRegistry.refresh({ ...vaultCatalogContext,
      client: { async listTools() {
        return [{ name: "issues/read", inputSchema: { type: "object" } }];
      } } });
    assert(first.pluginToolCatalogRegistry.listForBinding(vaultCatalogContext));
    await first.pluginCredentialVault.refreshCredential({
      connectionId: vaultReady.connectionId,
      principalIdentity: vaultReady.principalIdentity,
      authRevision: vaultReady.authRevision,
      endpointIdentity: vaultReady.endpointIdentity,
    });
    assert.equal(first.pluginToolCatalogRegistry.listForBinding(vaultCatalogContext),
      null, "Service token refresh invalidates its previous tool contract view");
    assert.equal((await first.pluginCredentialVault.readCredential(
      vaultReady.connectionId)).accessToken, "fixture-access-vault-rotated");
    const pending = first.pluginStore.createConnection({
      connectionId: "candidate-connection", installationId: installed.installationId,
      componentId: mcpComponent.componentId,
      endpointIdentity: "https://example.com/mcp",
      credentialRef: "candidate-credential",
    });
    const ready = first.pluginStore.setConnectionIdentity({
      connectionId: pending.connectionId, principalIdentity: "fixture-account",
      state: "ready", expectedRevision: pending.revision,
    });
    const profile = first.productStore.listAgentProfiles()[0];
    const createdBinding = first.pluginStore.createBinding({
      bindingId: "candidate-binding", profileId: profile.id,
      installationId: installed.installationId,
      componentId: mcpComponent.componentId, connectionId: ready.connectionId,
    });
    const binding = first.pluginStore.setBindingEnabled({
      bindingId: createdBinding.bindingId, enabled: true,
      expectedRevision: createdBinding.revision,
    });
    const catalog = await first.pluginToolCatalogRegistry.refresh({
      installation: enabled, connection: ready,
      client: { listTools: async () => [{ name: "issues/read",
        inputSchema: { type: "object" } }] },
    });
    const tool = catalog.entries[0];
    const grant = first.pluginStore.setGrant({ grantId: "candidate-grant",
      bindingId: binding.bindingId, toolIdentity: tool.toolIdentity,
      contractDigest: tool.contractDigest, effect: "allow",
      approvalMode: "always", expectedRevision: 0,
    });
    const mcpStatus = await pluginRpc(candidate, "plugins.mcp.status", {
      profileId: profile.id, installationId: installed.installationId });
    const remoteStatus = mcpStatus.items.find((item) =>
      item.componentId === mcpComponent.componentId);
    assert.equal(remoteStatus.connections.verified, 2);
    assert.equal(remoteStatus.binding.enabled, true);
    assert.equal(remoteStatus.binding.connectionState, "ready");
    assert.deepEqual(remoteStatus.binding.grants, { allow: 1, deny: 0 });
    assert.deepEqual(await candidateBackend.getPluginMcpStatus(profile.agentId,
      installed.installationId), mcpStatus);
    const mcpTools = await pluginRpc(candidate, "plugins.mcp.tools.list", {
      profileId: profile.id, bindingId: binding.bindingId });
    assert.equal(mcpTools.available, true);
    assert.equal(mcpTools.items.length, 1);
    assert.equal(mcpTools.items[0].name, "issues/read");
    assert.deepEqual(mcpTools.items[0].savedGrant, { effect: "allow",
      approvalMode: "always", revision: grant.revision,
      expired: false,
      matchesCurrentContract: true });
    assert.deepEqual(await candidateBackend.getPluginMcpTools(profile.agentId,
      binding.bindingId), mcpTools);
    const unsafeToolsBackend = new ShoggothBackend({ paths: candidate,
      readToken: () => "fixture-token",
      requestService: async () => ({ ...mcpTools,
        items: [{ ...mcpTools.items[0], principalIdentity: "private" }] }) });
    unsafeToolsBackend._profilesByAgent.set(profile.agentId, profile);
    await assert.rejects(unsafeToolsBackend.getPluginMcpTools(profile.agentId,
      binding.bindingId), { code: "PLUGIN_RESPONSE_INVALID" });
    await assert.rejects(pluginRpc(candidate, "plugins.mcp.tools.list", {
      profileId: boundProfile.id, bindingId: binding.bindingId,
      includeSecrets: true }), { code: "PLUGIN_REQUEST_INVALID" });
    const otherProfile = first.productStore.listAgentProfiles().find((item) =>
      item.id !== profile.id);
    if (otherProfile) await assert.rejects(pluginRpc(candidate, "plugins.mcp.tools.list", {
      profileId: otherProfile.id, bindingId: binding.bindingId }),
    { code: "PLUGIN_BINDING_INVALID" });
    for (const privateValue of ["https://fixture.example/mcp", "fixture-account-a",
      "fixture-access-vault", "candidate-credential"]) {
      assert.equal(JSON.stringify(mcpStatus).includes(privateValue), false);
      assert.equal(JSON.stringify(mcpTools).includes(privateValue), false);
    }
    const unsafeStatusBackend = new ShoggothBackend({ paths: candidate,
      readToken: () => "fixture-token",
      requestService: async () => ({ ...mcpStatus,
        items: [{ ...remoteStatus, endpointIdentity: "https://secret.invalid" }] }) });
    unsafeStatusBackend._profilesByAgent.set(profile.agentId, profile);
    await assert.rejects(unsafeStatusBackend.getPluginMcpStatus(profile.agentId,
      installed.installationId), { code: "PLUGIN_RESPONSE_INVALID" });
    const run = { id: "candidate-run", profileId: profile.id, workspace: root };
    const ticketInput = {
      callId: "candidate-pending-call", bindingId: binding.bindingId,
      toolIdentity: tool.toolIdentity, downstreamToolName: tool.downstreamName,
      contractDigest: tool.contractDigest, arguments: { issueId: "1" },
      authority: { kind: "native-profile", profileId: profile.id,
        profile: { id: profile.id, enabled: true }, confirmed: true },
      execution: { kind: "native-run", profileId: profile.id, workspace: root, run },
      envelope: { runId: run.id, authorityIncarnation: first.pluginStore.getAuthorityIncarnation(), bindingId: binding.bindingId,
        installationId: installed.installationId, releaseDigest: installed.releaseDigest,
        componentId: mcpComponent.componentId, connectionId: ready.connectionId,
        principalIdentity: ready.principalIdentity, bindingRevision: binding.revision,
        grantEpoch: grant.epoch, connectionAuthRevision: ready.authRevision,
        toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest },
    };
    const ticketId = first.pluginCapabilityDispatcher.issueTicket(ticketInput);
    assert.equal(typeof ticketId, "string");
    assert.equal(first.pluginStore.getCapabilityCall("candidate-pending-call").phase,
      "prepared");
    const sentTicket = first.pluginCapabilityDispatcher.issueTicket({ ...ticketInput,
      callId: "candidate-send-started-call" });
    first.pluginCapabilityDispatcher.authorizeEgress({
      connectionId: ready.connectionId, principalIdentity: ready.principalIdentity,
      toolName: tool.downstreamName, arguments: ticketInput.arguments,
      authority: { ticketId: sentTicket },
    });
    assert.equal(first.pluginStore.getCapabilityCall("candidate-send-started-call").phase,
      "send_started");
    const stdioOptions = { installationId: installed.installationId,
      scopeId: "d".repeat(64), releaseDigest: installed.releaseDigest,
      componentId: components.find((item) => item.localName === "local-issues").componentId,
      connectionId: "candidate-pool-connection", principalIdentity: "fixture-account",
      authRevision: 1, executionScope: "candidate-fixture",
      command: process.execPath,
      args: [path.join(__dirname, "fixtures", "plugins", "mcp-data-lease-fixture.cjs")],
      cwd: __dirname, env: { PATH: process.env.PATH }, timeoutMs: 3000 };
    const heldConnection = await first.pluginMcpConnectionPool.acquireStdio(stdioOptions);
    assert(Array.isArray(await heldConnection.listTools()));
    const poolCatalogContext = {
      installation: { ...enabled, activeReleaseDigest: enabled.releaseDigest },
      binding: { componentId: stdioOptions.componentId,
        connectionId: stdioOptions.connectionId },
      connection: { connectionId: stdioOptions.connectionId,
        installationId: installed.installationId,
        componentId: stdioOptions.componentId,
        endpointIdentity: "fixture://stdio", principalIdentity: "fixture-account",
        state: "ready", authRevision: 1 },
    };
    await first.pluginToolCatalogRegistry.refresh({ ...poolCatalogContext,
      client: heldConnection });
    assert(first.pluginToolCatalogRegistry.listForBinding(poolCatalogContext));
    const disableInput = { installationId: installed.installationId,
      desiredState: "disabled", expectedRevision: enabled.revision,
      operationId: "candidate-disable-installation" };
    await assert.rejects(pluginRpc(candidate, "plugins.installations.set", disableInput),
      { code: "ACTIVATION_DEFERRED" });
    assert.equal(first.pluginToolCatalogRegistry.listForBinding(poolCatalogContext),
      null, "a pending Service disable must fence the existing tool catalog");
    assert.equal(first.pluginStore.getInstallation(installed.installationId).desiredState,
      "enabled", "a held connection must not be reported as fully disabled");
    assert.equal(first.pluginStore.getOperation(disableInput.operationId).phase, "created");
    await assert.rejects(pluginRpc(candidate, "plugins.install", {
      source, previewDigest: preview.previewDigest,
      operationId: "candidate-install-while-draining",
      expectedRevision: enabled.revision,
    }), { code: "ACTIVATION_DEFERRED" });
    await assert.rejects(pluginRpc(candidate, "plugins.installations.set", {
      ...disableInput, desiredState: "enabled",
    }), { code: "REVISION_CONFLICT" });
    await assert.rejects(pluginRpc(candidate, "plugins.installations.set", {
      ...disableInput, operationId: "candidate-competing-disable",
    }), { code: "REVISION_CONFLICT" });
    await assert.rejects(pluginRpc(candidate, "plugins.installations.set", {
      installationId: installed.installationId, desiredState: "enabled",
      expectedRevision: enabled.revision, operationId: "candidate-noop-enable-during-drain",
    }), { code: "ACTIVATION_DEFERRED" });
    await assert.rejects(first.pluginMcpConnectionPool.acquireStdio(stdioOptions),
      { code: "PLUGIN_COMPONENT_INACTIVE" });
    await assert.rejects(heldConnection.listTools(), { code: "PLUGIN_CONNECTION_CLOSED" });
    await heldConnection.release();
    await first.stop({ notify: false });
    await assert.rejects(credentialProvider(), { code: "PLUGIN_STORE_CLOSED" });
    assert.equal(JSON.parse(fs.readFileSync(candidate.stateSnapshotPath, "utf8")).schemaVersion, 15);
    assert(fs.statSync(candidate.pluginCatalogPath).isFile());

    const pendingRestart = service(candidate);
    await pendingRestart.start();
    assert.equal((await pluginRpc(candidate, "plugins.operations.get",
      { operationId: disableInput.operationId })).operation.phase, "created");
    await assert.rejects(pendingRestart.pluginMcpConnectionPool.acquireStdio(stdioOptions),
      { code: "PLUGIN_COMPONENT_INACTIVE" });
    const disabledResult = await pluginRpc(candidate, "plugins.installations.set", disableInput);
    assert.equal(disabledResult.installation.desiredState, "disabled");
    await assert.rejects(pendingRestart.pluginMcpConnectionPool.acquireStdio(stdioOptions),
      { code: "PLUGIN_COMPONENT_INACTIVE" });
    const reenabled = await pluginRpc(candidate, "plugins.installations.set", {
      installationId: installed.installationId, desiredState: "enabled",
      expectedRevision: disabledResult.installation.revision,
      operationId: "candidate-reenable-installation",
    });
    assert.equal(reenabled.installation.desiredState, "enabled");
    assert.deepEqual(await pluginRpc(candidate, "plugins.installations.set", disableInput),
      disabledResult, "replay must not drain a later enabled generation");
    assert.equal(pendingRestart.pluginStore.getInstallation(installed.installationId).desiredState,
      "enabled");
    const grantBeforeRevoke = pendingRestart.pluginStore.getGrant(binding.bindingId,
      tool.toolIdentity);
    const revokeInput = { profileId: profile.id, bindingId: binding.bindingId,
      toolIdentity: tool.toolIdentity, expectedRevision: grantBeforeRevoke.revision,
      operationId: "candidate-revoke-tool-grant" };
    await assert.rejects(pluginRpc(candidate, "plugins.mcp.grants.revoke", {
      ...revokeInput, expectedRevision: grantBeforeRevoke.revision + 1 }),
    { code: "REVISION_CONFLICT" });
    if (otherProfile) await assert.rejects(pluginRpc(candidate,
      "plugins.mcp.grants.revoke", { ...revokeInput,
        profileId: otherProfile.id }), { code: "PLUGIN_BINDING_INVALID" });
    const revokeResult = await candidateBackend.revokePluginMcpGrant({
      agentId: profile.agentId, ...revokeInput });
    assert.deepEqual(Object.keys(revokeResult.grant).sort(),
      ["bindingId", "effect", "epoch", "revision", "toolIdentity"]);
    assert.equal(revokeResult.grant.effect, "deny");
    assert(revokeResult.grant.epoch > grantBeforeRevoke.epoch);
    const unsafeGrantBackend = new ShoggothBackend({ paths: candidate,
      readToken: () => "fixture-token",
      requestService: async () => ({ ...revokeResult,
        grant: { ...revokeResult.grant, principalIdentity: "private" } }) });
    unsafeGrantBackend._profilesByAgent.set(profile.agentId, profile);
    await assert.rejects(unsafeGrantBackend.revokePluginMcpGrant({
      agentId: profile.agentId, ...revokeInput }),
    { code: "PLUGIN_RESPONSE_INVALID" });
    assert.deepEqual(await pluginRpc(candidate, "plugins.mcp.grants.revoke",
      revokeInput), revokeResult);
    assert.deepEqual((await pluginRpc(candidate, "plugins.operations.get", {
      operationId: revokeInput.operationId })).operation.result, revokeResult.grant);
    assert.equal(pendingRestart.pluginStore.getGrant(binding.bindingId,
      tool.toolIdentity).effect, "deny");
    assert.deepEqual(pendingRestart.pluginStore.getOperation(
      revokeInput.operationId).result, revokeResult.grant);
    for (const privateValue of ["https://fixture.example/mcp", "fixture-account-a",
      "fixture-access-vault", "candidate-credential"]) {
      assert.equal(JSON.stringify(revokeResult).includes(privateValue), false);
    }
    assert.equal((await pluginRpc(candidate, "plugins.mcp.tools.list", {
      profileId: profile.id, bindingId: binding.bindingId })).available, false,
    "revocation must work after the in-memory tool catalog is lost on restart");
    const reallowed = pendingRestart.pluginStore.setGrant({
      grantId: "candidate-grant", bindingId: binding.bindingId,
      toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest,
      effect: "allow", approvalMode: "always",
      expectedRevision: revokeResult.grant.revision });
    const currentBinding = pendingRestart.pluginStore.getBinding(binding.bindingId);
    const bulkInput = { profileId: profile.id, bindingId: binding.bindingId,
      expectedRevision: currentBinding.revision,
      operationId: "candidate-revoke-all-grants" };
    await assert.rejects(pluginRpc(candidate, "plugins.mcp.grants.revoke-all", {
      ...bulkInput, expectedRevision: currentBinding.revision + 1 }),
    { code: "REVISION_CONFLICT" });
    if (otherProfile) await assert.rejects(pluginRpc(candidate,
      "plugins.mcp.grants.revoke-all", { ...bulkInput,
        profileId: otherProfile.id }), { code: "PLUGIN_BINDING_INVALID" });
    const bulkResult = await candidateBackend.revokeAllPluginMcpGrants({
      agentId: profile.agentId, ...bulkInput });
    assert.equal(bulkResult.revocation.revokedCount, 1);
    assert(bulkResult.revocation.epoch > reallowed.epoch);
    assert.deepEqual(await pluginRpc(candidate, "plugins.mcp.grants.revoke-all",
      bulkInput), bulkResult);
    assert.deepEqual((await pluginRpc(candidate, "plugins.operations.get", {
      operationId: bulkInput.operationId })).operation.result,
    bulkResult.revocation);
    assert.equal(pendingRestart.pluginStore.getGrant(binding.bindingId,
      tool.toolIdentity).effect, "deny");
    const unsafeBulkBackend = new ShoggothBackend({ paths: candidate,
      readToken: () => "fixture-token",
      requestService: async () => ({ ...bulkResult,
        revocation: { ...bulkResult.revocation, principalIdentity: "private" } }) });
    unsafeBulkBackend._profilesByAgent.set(profile.agentId, profile);
    await assert.rejects(unsafeBulkBackend.revokeAllPluginMcpGrants({
      agentId: profile.agentId, ...bulkInput }),
    { code: "PLUGIN_RESPONSE_INVALID" });
    const staleConnection = await pendingRestart.pluginMcpConnectionPool.acquireStdio(stdioOptions);
    const staleDisable = { installationId: installed.installationId,
      desiredState: "disabled", expectedRevision: reenabled.installation.revision,
      operationId: "candidate-stale-disable" };
    await assert.rejects(pluginRpc(candidate, "plugins.installations.set", staleDisable),
      { code: "ACTIVATION_DEFERRED" });
    await staleConnection.release();
    const directDisabled = pendingRestart.pluginStore.setInstallationDesiredState({
      installationId: installed.installationId, desiredState: "disabled",
      expectedRevision: reenabled.installation.revision,
    });
    const staleResult = await pluginRpc(candidate, "plugins.installations.set", staleDisable);
    assert.equal(staleResult.operation.phase, "failed");
    assert.equal(staleResult.operation.result.code, "REVISION_CONFLICT");
    assert.equal(pendingRestart.pluginStore.hasPendingInstallationDisable(
      installed.installationId), false);
    await pluginRpc(candidate, "plugins.installations.set", {
      installationId: installed.installationId, desiredState: "enabled",
      expectedRevision: directDisabled.revision,
      operationId: "candidate-reenable-after-stale-intent",
    });
    await pendingRestart.stop({ notify: false });
    const reopened = service(candidate);
    await reopened.start();
    assert.equal(reopened.pluginStore.listInstallations()[0].installationId,
      installed.installationId);
    assert.equal((await reopened.pluginCredentialVault.readCredential(
      vaultReady.connectionId)).accessToken, "fixture-access-vault-rotated");
    const reopenedCredentialProvider = reopened.pluginConnectionAuth.credentialProvider({
      connectionId: vaultReady.connectionId,
      principalIdentity: vaultReady.principalIdentity,
      authRevision: vaultReady.authRevision,
      endpointIdentity: vaultReady.endpointIdentity,
      issuer: "https://fixture.example/", audience: "fixture-api",
      requiredScopes: ["issues:read"],
    });
    assert.equal((await reopenedCredentialProvider()).accessToken,
      "fixture-access-vault-rotated");
    reopened.pluginStore.setConnectionIdentity({
      connectionId: vaultReady.connectionId,
      principalIdentity: vaultReady.principalIdentity,
      state: "disconnected", expectedRevision: vaultReady.revision,
    });
    await assert.rejects(reopenedCredentialProvider(),
      { code: "CONNECTION_IDENTITY_CHANGED" });
    assert.equal(reopened.pluginComponentCatalog.list()[0].components.length, 3);
    assert.equal(reopened.pluginStore.getCapabilityCall("candidate-pending-call").phase,
      "rejected_before_send");
    assert.equal(reopened.pluginStore.getCapabilityCall("candidate-send-started-call").phase,
      "outcome_unknown");
    const reopenedConnection = await reopened.pluginMcpConnectionPool.acquireStdio(stdioOptions);
    assert(Array.isArray(await reopenedConnection.listTools()));
    await reopenedConnection.release();
    const lifecycleAgent = (await pluginRpc(candidate, "agent.create", {
      operationId: "candidate-plugin-archive-agent", backendId: "shoggoth",
      name: "Candidate plugin archive", defaultCwd: null,
      createdAt: Date.now() })).profile;
    const lifecycleBinding = reopened.pluginStore.createBinding({
      bindingId: "candidate-lifecycle-binding", profileId: lifecycleAgent.id,
      installationId: installed.installationId, componentId: mcpComponent.componentId,
      connectionId: ready.connectionId });
    const lifecycleEnabled = reopened.pluginStore.setBindingEnabled({
      bindingId: lifecycleBinding.bindingId, enabled: true,
      expectedRevision: lifecycleBinding.revision });
    const lifecycleGrant = reopened.pluginStore.setGrant({
      grantId: "candidate-lifecycle-grant", bindingId: lifecycleBinding.bindingId,
      toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest,
      effect: "allow", approvalMode: "always", expectedRevision: 0 });
    const archivedAgent = (await pluginRpc(candidate, "agent.archive", {
      operationId: "candidate-plugin-archive", profileId: lifecycleAgent.id,
      expectedUpdatedAt: lifecycleAgent.updatedAt,
      createdAt: Date.now() })).profile;
    assert.equal(archivedAgent.enabled, false);
    assert.equal(reopened.pluginStore.getBinding(lifecycleBinding.bindingId).enabled,
      false);
    assert.equal(reopened.pluginStore.getGrant(lifecycleBinding.bindingId,
      tool.toolIdentity).effect, "deny");
    const restoredAgent = (await pluginRpc(candidate, "agent.restore", {
      operationId: "candidate-plugin-restore", profileId: lifecycleAgent.id,
      expectedUpdatedAt: archivedAgent.updatedAt,
      createdAt: Date.now() })).profile;
    assert.equal(restoredAgent.enabled, true);
    assert.equal(reopened.pluginStore.getGrant(lifecycleBinding.bindingId,
      tool.toolIdentity).effect, "deny");
    const reenabledLifecycle = reopened.pluginStore.setBindingEnabled({
      bindingId: lifecycleBinding.bindingId, enabled: true,
      expectedRevision: reopened.pluginStore.getBinding(lifecycleBinding.bindingId).revision });
    const regrantedLifecycle = reopened.pluginStore.setGrant({
      grantId: "candidate-lifecycle-grant", bindingId: lifecycleBinding.bindingId,
      toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest,
      effect: "allow", approvalMode: "always",
      expectedRevision: reopened.pluginStore.getGrant(lifecycleBinding.bindingId,
        tool.toolIdentity).revision });
    assert(reenabledLifecycle.revision > lifecycleEnabled.revision);
    assert(regrantedLifecycle.epoch > lifecycleGrant.epoch);
    // Simulate a crash after the Product profile was disabled but before the
    // separate plugin transaction ran. Startup must reconcile before IPC opens.
    reopened.productStore.putAgentProfile({ ...restoredAgent, enabled: false });
    await reopened.stop({ notify: false });
    assert.throws(() => reopened.pluginStore.listInstallations(),
      { code: "PLUGIN_STORE_CLOSED" });
    let retentionNow = Date.now();
    const reconciled = service(candidate, { now: () => retentionNow });
    await reconciled.start();
    assert.equal(reconciled.pluginStore.getBinding(lifecycleBinding.bindingId).enabled,
      false);
    assert.equal(reconciled.pluginStore.getGrant(lifecycleBinding.bindingId,
      tool.toolIdentity).effect, "deny");
    await reconciled.agentArchiveRetention.inFlight;
    const retained = reconciled.agentArchiveRetention.entries[lifecycleAgent.id];
    assert(retained, "startup records the disabled Agent for timed retention");
    reconciled.pluginStore.beginCapabilityCall({
      callId: "candidate-retention-in-flight", runRef: "run-retention-fixture",
      bindingId: lifecycleBinding.bindingId, connectionId: ready.connectionId,
      principalIdentity: "fixture-account-a", toolIdentity: tool.toolIdentity,
      contractDigest: tool.contractDigest, argumentDigest: "a".repeat(64) });
    reconciled.pluginStore.markCapabilityCallSendStarted("candidate-retention-in-flight");
    retentionNow = retained.deleteAfter;
    await assert.rejects(reconciled.agentLifecycleServiceController.runMaintenance(() =>
      reconciled.agentArchiveRetention.sweep()),
    { code: "ACTIVATION_DEFERRED" });
    assert(reconciled.productStore.getAgentProfile(lifecycleAgent.id));
    assert(reconciled.pluginStore.getBinding(lifecycleBinding.bindingId));
    reconciled.pluginStore.finishCapabilityCall("candidate-retention-in-flight",
      { resultConfirmed: true });
    await reconciled.agentLifecycleServiceController.runMaintenance(() =>
      reconciled.agentArchiveRetention.sweep());
    assert.equal(reconciled.productStore.getAgentProfile(lifecycleAgent.id), null);
    assert.equal(reconciled.pluginStore.getBinding(lifecycleBinding.bindingId), null);
    assert.equal(reconciled.pluginStore.getGrant(lifecycleBinding.bindingId,
      tool.toolIdentity), null);
    assert.equal(reconciled.pluginStore.getConnection(ready.connectionId).state,
      "ready", "shared plugin Connection must not be deleted with one Agent");
    await reconciled.stop({ notify: false });
    assert.equal(fs.existsSync(current.pluginCatalogPath), true);

    const rejected = resolveServicePaths({
      userDataRoot: path.join(root, "old-state"),
      cacheRoot: path.join(root, "old-cache"), trustedRoot: root,
    });
    const oldReaderPaths = resolveServicePaths({ userDataRoot: rejected.userDataRoot,
      cacheRoot: rejected.cacheDir, trustedRoot: root });
    new JsonlProductStore({ paths: oldReaderPaths }).open().close();
    const oldSnapshot = JSON.parse(fs.readFileSync(rejected.stateSnapshotPath, "utf8"));
    oldSnapshot.schemaVersion = 14; oldSnapshot.checksum = snapshotChecksum(oldSnapshot);
    fs.writeFileSync(rejected.stateSnapshotPath, JSON.stringify(oldSnapshot), { mode: 0o600 });
    const oldSnapshotDigest = digest(rejected.stateSnapshotPath);
    const oldEventsDigest = digest(rejected.eventLogPath);
    await assert.rejects(service(rejected).start(),
      { code: "SHOGGOTH_DATA_RESET_REQUIRED" });
    assert.equal(digest(rejected.stateSnapshotPath), oldSnapshotDigest);
    assert.equal(digest(rejected.eventLogPath), oldEventsDigest);
    assert.equal(fs.existsSync(rejected.pluginCatalogPath), false,
      "rejected root must not create plugin authority");

    const unsupported = resolveServicePaths({
      userDataRoot: path.join(root, "old-catalog"),
      cacheRoot: path.join(root, "catalog-cache"), trustedRoot: root,
    });
    new JsonlProductStore({ paths: unsupported }).open().close();
    new PluginStore({ paths: unsupported }).open().close();
    const raw = new Database(unsupported.pluginCatalogPath);
    raw.pragma(`user_version = ${PLUGIN_STORE_SCHEMA_VERSION - 1}`);
    raw.close();
    const before = {
      snapshot: digest(unsupported.stateSnapshotPath),
      events: digest(unsupported.eventLogPath),
      catalog: digest(unsupported.pluginCatalogPath),
    };
    await assert.rejects(service(unsupported).start(),
      { code: "PLUGIN_STORE_UNSUPPORTED" });
    assert.equal(digest(unsupported.stateSnapshotPath), before.snapshot);
    assert.equal(digest(unsupported.eventLogPath), before.events);
    assert.equal(digest(unsupported.pluginCatalogPath), before.catalog);
    assert.equal(fs.existsSync(unsupported.encryptedSecretsPath), false,
      "unsupported plugin catalog must be rejected before credential writer opens");

    const interrupted = resolveServicePaths({
      userDataRoot: path.join(root, "interrupted"),
      cacheRoot: path.join(root, "interrupted-cache"), trustedRoot: root,
    });
    const injectedStore = new PluginStore({ paths: interrupted });
    let interruptedOnce = false;
    const crashingInstaller = new PluginPackageInstaller({ store: injectedStore,
      onPhase(phase) {
        if (phase === "published" && !interruptedOnce) {
          interruptedOnce = true;
          throw Object.assign(new Error("fixture interruption"),
            { code: "PLUGIN_SIMULATED_CRASH" });
        }
      },
    });
    const beforeCrash = service(interrupted, { pluginStore: injectedStore,
      pluginPackageInstaller: crashingInstaller });
    await beforeCrash.start();
    const interruptedPreview = beforeCrash.pluginPackageInstaller.preview(fixture);
    const interruptedInput = { sourcePath: fixture,
      previewDigest: interruptedPreview.contentDigest,
      operationId: "candidate-interrupted-install", expectedRevision: 0 };
    assert.throws(() => beforeCrash.pluginPackageInstaller.install(interruptedInput),
      { code: "PLUGIN_SIMULATED_CRASH" });
    assert.equal(beforeCrash.pluginStore.getOperation(interruptedInput.operationId).phase,
      "created");
    await beforeCrash.stop({ notify: false });
    const afterCrash = service(interrupted);
    await afterCrash.start();
    const recovered = afterCrash.pluginPackageInstaller.install(interruptedInput);
    assert.equal(recovered.desiredState, "disabled");
    assert.equal(afterCrash.pluginStore.getOperation(interruptedInput.operationId).phase,
      "completed");
    await afterCrash.stop({ notify: false });

    assert.throws(() => createAgentService({ paths: current, safeStorage,
      pluginStore: {} }), /PluginPackageInstaller requires PluginStore/u);
    console.log("default plugin Service lifecycle local fixture: PASS");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
