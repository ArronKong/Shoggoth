"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService } = require("../app/agent-service/server");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { PluginAppController } = require("../app/agent-service/plugin-app-controller");
const { PluginRuntimeToolService, pluginServerId } = require("../app/agent-service/plugin-runtime-tool-service");
const { MCP_APP_PROTOCOL_VERSION } = require("../app/agent-service/plugin-app-session");
const { validatePluginAppResult } = require("../app/core/plugin-app-dto");

// The only synthetic authorities below are a fresh default Profile and a local
// Run/conversation. All package, connection, binding and Grant mutations go
// through authenticated Service IPC and the production Backend DTO validators.
// Native dialog decisions are explicitly simulated; no provider credentials or
// installed App data are accessed.
const encryptionKey = crypto.randomBytes(32);
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString(value) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, nonce);
    return Buffer.concat([nonce, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
  },
  decryptString(value) {
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, value.subarray(0, 12));
    decipher.setAuthTag(value.subarray(-16));
    return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString("utf8");
  },
};
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const rpc = (id, method, params = {}) => ({ jsonrpc: "2.0", id, method, params });
function write(root, relative, text, mode = 0o600) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode });
}
function makeSource(root) {
  fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), root, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "fixtures/plugins/mcp-sdk-fixture.cjs"), path.join(root, "bin/mcp-sdk-fixture.cjs"));
  write(root, "bin/issue-fixture", `#!${process.execPath}\n${String.raw`
const readline = require("node:readline");
const { handle, TOOL } = require("./mcp-sdk-fixture.cjs");
const html = "<!doctype html><html><body>" + "local App fixture ".repeat(2500) + "</body></html>";
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  let response = handle(request);
  if (!response) return;
  if (request.method === "initialize") response.result.capabilities.resources = {};
  if (request.method === "tools/list") response.result.tools = [TOOL,
    { ...TOOL, name: "each-call" }, { ...TOOL, name: "dashboard",
      _meta: { ui: { resourceUri: "ui://fixture/dashboard" } } }];
  if (request.method === "resources/read") response = { jsonrpc: "2.0", id: request.id,
    result: { contents: [{ uri: "ui://fixture/dashboard", mimeType: "text/html;profile=mcp-app", text: html }] } };
  if (request.method === "tools/call") response.result.structuredContent.fixtureProcess = process.pid;
  process.stdout.write(JSON.stringify(response) + "\n");
});
`}`, 0o700);
  fs.chmodSync(path.join(root, "bin/issue-fixture"), 0o700);
}
function assertPublic(value, root) {
  const json = JSON.stringify(value);
  assert.equal(json.includes(root), false, "private source/state paths cannot cross DTO");
  for (const field of ["sourceIdentity", "credentialRef", "principalIdentity", "endpointIdentity"]) {
    assert.equal(json.includes(`\"${field}\"`), false, `${field} cannot cross management DTO`);
  }
}

async function main() {
  // Keep the macOS Unix-domain socket comfortably below sockaddr_un's limit.
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sgmf-"));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "user"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const service = createAgentService({ paths, safeStorage, prewarmMcpAuth: false,
    parentEnv: {}, version: "plugin-management-fixture" });
  let appController;
  let runtime;
  const mismatchedErrors = [];
  async function expectError(promise, code) {
    await assert.rejects(promise, error => {
      if (error.code !== code) mismatchedErrors.push({ expected: code, actual: error.code });
      return true;
    });
  }
  try {
    await service.start();
    const backend = new ShoggothBackend({ paths });
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    assert(profile, "isolated Service creates its own Profile");
    backend._profilesByAgent.set(profile.agentId, profile);
    const sourcePath = path.join(root, "source");
    makeSource(sourcePath);
    const source = { kind: "directory", path: sourcePath };
    const preview = await backend.previewPluginInstall(source);
    assert.equal(preview.installable, true);
    assertPublic(preview, root);
    const installed = await backend.installPlugin({ source, previewDigest: preview.previewDigest,
      expectedRevision: preview.expectedRevision, operationId: "management-install" });
    assert.equal(installed.installation.desiredState, "disabled");
    assert.equal(installed.operation.phase, "completed");
    let installation = (await backend.setPluginInstallationState({
      installationId: installed.installation.installationId, desiredState: "enabled",
      expectedRevision: installed.installation.revision, operationId: "management-enable",
    })).installation;
    const page = await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 10, catalogRevision: null });
    const component = page.items[0].components.find(item => item.localName === "local-issues");
    assert(component);
    const connect = { action: "connect", agentId: profile.agentId,
      installationId: installation.installationId, componentId: component.componentId,
      expectedRevision: installation.revision, operationId: "management-connect" };
    const canceled = await backend.preparePluginMcpConsent(connect);
    assertPublic(canceled, root);
    assert.deepEqual(await backend.commitPluginMcpConsent({ challenge: canceled.challenge, approved: false }),
      { canceled: true, receipt: null });
    await expectError(backend.commitPluginMcpConsent({ challenge: canceled.challenge, approved: true }),
      "PLUGIN_CONSENT_EXPIRED");
    const canceledStatus = await backend.getPluginMcpStatus(profile.agentId, installation.installationId);
    assert(canceledStatus.items.every(item => item.binding === null
      && item.connections.verified === 0 && item.connections.pending === 0));
    assert.equal((await backend.getPluginOperation(connect.operationId)).found, false);
    const challenge = await backend.preparePluginMcpConsent(connect);
    const connected = await backend.commitPluginMcpConsent({ challenge: challenge.challenge, approved: true });
    assert.equal(connected.receipt.kind, "mcp-connect");
    const bindingId = connected.receipt.bindingId;
    assert.equal((await backend.getPluginOperation(connect.operationId)).operation.kind, "mcp-connect");
    assert.equal((await backend.getPluginMcpTools(profile.agentId, bindingId)).available, false);
    const discovered = await backend.discoverPluginMcpTools(profile.agentId, bindingId);
    let tools = await backend.getPluginMcpTools(profile.agentId, bindingId);
    assert.equal(tools.catalogRevision, discovered.catalogRevision);
    assert.deepEqual(tools.items.map(item => item.name).sort(), ["dashboard", "each-call", "echo"]);
    assert(tools.items.every(item => item.savedGrant === null));
    const firstTool = tools.items.find(item => item.name === "echo");
    const canceledAllow = await backend.preparePluginMcpConsent({ action: "allow", agentId: profile.agentId,
      bindingId, toolIdentity: firstTool.toolIdentity, contractDigest: firstTool.contractDigest,
      catalogRevision: tools.catalogRevision, approvalMode: "always", expectedRevision: 0,
      operationId: "cancel-allow" });
    assert.equal((await backend.commitPluginMcpConsent({ challenge: canceledAllow.challenge, approved: false })).canceled, true);
    assert((await backend.getPluginMcpTools(profile.agentId, bindingId)).items.every(item => item.savedGrant === null));
    assert.equal((await backend.getPluginOperation("cancel-allow")).found, false);
    async function allow(name, approvalMode, operationId) {
      tools = await backend.getPluginMcpTools(profile.agentId, bindingId);
      const tool = tools.items.find(item => item.name === name);
      const prepared = await backend.preparePluginMcpConsent({ action: "allow", agentId: profile.agentId,
        bindingId, toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest,
        catalogRevision: tools.catalogRevision, approvalMode, expectedRevision: tool.savedGrant?.revision || 0,
        operationId });
      assert.equal(prepared.summary.approvalMode, approvalMode);
      const result = await backend.commitPluginMcpConsent({ challenge: prepared.challenge, approved: true });
      assert.equal(result.receipt.kind, "grant-allow");
      assert.equal((await backend.getPluginOperation(operationId)).operation.result.toolIdentity, tool.toolIdentity);
      return result;
    }
    await allow("echo", "always", "allow-echo");
    await allow("each-call", "each-call", "allow-each");
    await allow("dashboard", "always", "allow-dashboard");
    tools = await backend.getPluginMcpTools(profile.agentId, bindingId);
    assert.equal(tools.items.find(item => item.name === "each-call").savedGrant.approvalMode, "each-call");
    assertPublic(tools, root);

    // A normal Runtime dispatch creates the originating receipt; the App test
    // only injects the otherwise-running WorkRun/conversation lookup.
    const run = { id: "management-run", source: "chat", profileId: profile.id,
      workspace: root, status: "running" };
    const conversationId = crypto.randomUUID();
    appController = new PluginAppController({ store: service.pluginStore, productStore: service.productStore,
      getRun: id => id === run.id ? run : null,
      getConversation: () => ({ id: conversationId, profileId: profile.id }),
      manager: service.pluginMcpConnectionManager, catalog: service.pluginToolCatalogRegistry,
      dispatcher: service.pluginCapabilityDispatcher, permissionEngine: service.permissionEngine });
    runtime = new PluginRuntimeToolService({ store: service.pluginStore, productStore: service.productStore,
      getRun: id => id === run.id ? run : null, toolCatalogRegistry: service.pluginToolCatalogRegistry,
      capabilityDispatcher: service.pluginCapabilityDispatcher, permissionEngine: service.permissionEngine,
      acquireConnection: records => service.pluginMcpConnectionManager.acquire(records),
      recordAppCall: input => appController.recordCall(input) });
    assert.equal(runtime.captureRun(run).serverCount, 1);
    const origin = await runtime.callTool({ serverId: pluginServerId(bindingId), toolName: "dashboard",
      arguments: { value: "open local UI" } }, { profileId: profile.id, callId: "origin", confirmation: true },
    { runId: run.id, assertCurrent() {} });
    assert.equal(origin.result.structuredContent.echoed, "open local UI");
    assert.equal(Number.isInteger(origin.result.structuredContent.fixtureProcess), true);
    assert(origin.shoggothPluginApp?.callId);
    run.status = "completed";
    service.pluginServiceController.getAppController = () => appController;
    const sessionKey = `agent:${profile.agentId}:${conversationId}`;
    backend._sessionsByKey.set(conversationId, { sessionKey: conversationId, profileId: profile.id });
    const appCanceled = await backend.preparePluginApp(sessionKey, origin.shoggothPluginApp.callId);
    assert.deepEqual(await backend.commitPluginApp({ challenge: appCanceled.challenge, approved: false }),
      { canceled: true, descriptor: null });
    const appPrepared = await backend.preparePluginApp(sessionKey, origin.shoggothPluginApp.callId);
    const appOpened = await backend.commitPluginApp({ challenge: appPrepared.challenge, approved: true,
      hostOrigin: "http://127.0.0.1:18799", sandboxOrigin: "http://127.0.0.1:18800", sourceId: "local-frame" });
    const { descriptor } = appOpened;
    assert.deepEqual(descriptor.initialNotifications[0], { jsonrpc: "2.0", method: "ui/notifications/tool-input",
      params: { arguments: { value: "open local UI" } } });
    assert.equal(descriptor.initialNotifications[1].method, "ui/notifications/tool-result");
    assert.deepEqual(descriptor.initialNotifications[1].params, origin.result);
    assert(descriptor.resource.chunkCount > 1, "resource crosses several bounded Service chunks");
    assertPublic(descriptor, root);
    const chunks = [];
    for (let index = 0; index < descriptor.resource.chunkCount; index += 1) {
      chunks.push((await backend.readPluginAppChunk(descriptor.transport, index)).text);
    }
    const html = Buffer.from(chunks.join(""), "base64");
    assert.equal(sha(html), descriptor.resource.contentDigest);
    assert.equal(html.length, descriptor.resource.byteLength);
    assert.match(html.toString("utf8"), /^<!doctype html><html>/u);
    const initialized = await backend.messagePluginApp(descriptor.transport, rpc("init", "ui/initialize", {
      appInfo: { name: "local-fixture", version: "1" }, appCapabilities: {}, protocolVersion: MCP_APP_PROTOCOL_VERSION,
    }));
    assert.equal(initialized.result.protocolVersion, MCP_APP_PROTOCOL_VERSION);
    assert.equal(await backend.messagePluginApp(descriptor.transport,
      { jsonrpc: "2.0", method: "ui/notifications/initialized" }), null);
    const result = await backend.messagePluginApp(descriptor.transport,
      rpc("app-echo", "tools/call", { name: "echo", arguments: { value: "App dispatcher" } }));
    assert.equal(result.result.structuredContent.echoed, "App dispatcher");
    const denied = await backend.messagePluginApp(descriptor.transport,
      rpc("app-each", "tools/call", { name: "each-call", arguments: { value: "must not send" } }));
    assert.equal(denied.error.data.code, "MCP_APP_TOOL_FORBIDDEN");
    const closed = await backend.closePluginApp(descriptor.transport);
    assert.equal(closed.closed, true);
    await expectError(backend.readPluginAppChunk(descriptor.transport, 0), "MCP_APP_SESSION_EXPIRED");
    for (const [method, value] of [["plugins.apps.prepare", appPrepared], ["plugins.apps.commit", appOpened],
      ["plugins.apps.message", initialized], ["plugins.apps.close", closed]]) {
      assert.throws(() => validatePluginAppResult(method, { ...value, privateAuthority: "forged" }), TypeError);
    }
    runtime.clear();

    tools = await backend.getPluginMcpTools(profile.agentId, bindingId);
    const echo = tools.items.find(item => item.name === "echo");
    const revoked = await backend.revokePluginMcpGrant({ agentId: profile.agentId, bindingId,
      toolIdentity: echo.toolIdentity, expectedRevision: echo.savedGrant.revision, operationId: "revoke-echo" });
    assert.equal(revoked.grant.effect, "deny");
    const status = await backend.getPluginMcpStatus(profile.agentId, installation.installationId);
    const binding = status.items.find(item => item.binding?.bindingId === bindingId).binding;
    const bulk = await backend.revokeAllPluginMcpGrants({ agentId: profile.agentId, bindingId,
      expectedRevision: binding.revision, operationId: "revoke-all" });
    assert.equal(bulk.revocation.revokedCount, 2);
    const enabledPreview = await backend.previewPluginUninstall({ installationId: installation.installationId,
      expectedRevision: installation.revision });
    assert.equal(enabledPreview.requiresDisable, true);
    await expectError(backend.uninstallPlugin({ installationId: installation.installationId,
      expectedRevision: installation.revision, operationId: "uninstall-too-soon" }),
    "PLUGIN_UNINSTALL_REQUIRES_DISABLE");
    assert.equal((await backend.getPluginOperation("uninstall-too-soon")).found, false);
    const disableInput = { installationId: installation.installationId, desiredState: "disabled",
      expectedRevision: installation.revision, operationId: "management-disable" };
    const held = await service.pluginMcpConnectionManager.acquire(
      service.pluginStore.getCapabilityRecords(bindingId, echo.toolIdentity));
    try {
      await expectError(backend.setPluginInstallationState(disableInput), "ACTIVATION_DEFERRED");
      const pendingDisable = await backend.getPluginOperation(disableInput.operationId);
      assert.equal(pendingDisable.operation.phase, "created");
      assert.equal(pendingDisable.operation.result, null);
      assertPublic(pendingDisable, root);
    } finally { await held.release(); }
    installation = (await backend.setPluginInstallationState(disableInput)).installation;
    const uninstallPreview = await backend.previewPluginUninstall({ installationId: installation.installationId,
      expectedRevision: installation.revision });
    assert.equal(uninstallPreview.requiresDisable, false);
    assert.equal(uninstallPreview.affectedAgentCount, 1);
    assert.equal(uninstallPreview.connectionCount, 1);
    const uninstallInput = { installationId: installation.installationId,
      expectedRevision: installation.revision, operationId: "management-uninstall" };
    const uninstalled = await backend.uninstallPlugin(uninstallInput);
    assert.equal(uninstalled.operation.phase, "completed");
    assert.equal(uninstalled.uninstall.packageRemoved, true);
    assert.equal(uninstalled.uninstall.dataRetained, true);
    assert.equal(uninstalled.uninstall.credentialsRetained, true);
    assertPublic(uninstalled, root);
    assert.deepEqual(await backend.uninstallPlugin(uninstallInput), uninstalled);
    assert.deepEqual((await backend.getPluginOperation(uninstallInput.operationId)).operation, uninstalled.operation);
    assert.equal((await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 10, catalogRevision: null })).items.length, 0);
    assert.equal(fs.existsSync(sourcePath), true, "uninstall preserves source directory");

    const legacyPath = path.join(root, "legacy");
    write(legacyPath, ".claude-plugin/plugin.json", JSON.stringify({ name: "legacy-service-fixture", version: "1.0.0",
      hooks: { command: "touch NEVER_EXECUTE" } }));
    write(legacyPath, "skills/review/SKILL.md", "---\nname: review\ndescription: Local review fixture\n---\nReview locally.\n");
    write(legacyPath, ".mcp.json", JSON.stringify({ mcpServers: {
      remote: { type: "http", url: "https://example.invalid/mcp" },
      secret: { type: "http", url: "https://example.invalid/private", headers: { Authorization: "private-fixture-token" } },
    } }));
    const before = sha(fs.readFileSync(path.join(legacyPath, ".mcp.json")));
    const legacySource = { kind: "legacy-directory", path: legacyPath, format: "claude-plugin", components: ["skills", "mcp-servers"] };
    const legacyPreview = await backend.previewPluginInstall(legacySource);
    assert.equal(legacyPreview.sourceKind, "legacy-directory");
    assert.equal(legacyPreview.installable, true);
    assert(legacyPreview.diagnostics.some(item => item.reasonCode === "LEGACY_CREDENTIAL_UNSUPPORTED"));
    assertPublic(legacyPreview, root);
    assert.equal(JSON.stringify(legacyPreview).includes("private-fixture-token"), false);
    const legacyInput = { source: legacySource, previewDigest: legacyPreview.previewDigest,
      expectedRevision: legacyPreview.expectedRevision, operationId: "legacy-management-import" };
    const legacy = await backend.installPlugin(legacyInput);
    assert.equal(legacy.installation.sourceKind, "legacy-directory");
    assert.equal(legacy.installation.desiredState, "disabled");
    assert.deepEqual(await backend.installPlugin(legacyInput), legacy);
    assert.deepEqual((await backend.getPluginOperation(legacyInput.operationId)).operation, legacy.operation);
    assert.equal(sha(fs.readFileSync(path.join(legacyPath, ".mcp.json"))), before);
    assert.equal(fs.existsSync(path.join(legacyPath, "NEVER_EXECUTE")), false);
    assert.equal(JSON.stringify(legacy).includes("private-fixture-token"), false);
    assertPublic(legacy, root);
    await backend.uninstallPlugin({ installationId: legacy.installation.installationId,
      expectedRevision: legacy.installation.revision, operationId: "legacy-management-uninstall" });
    const bundledBefore = await backend.listBundledPlugins();
    if (bundledBefore.items.length > 0) {
      assert.equal(bundledBefore.items.find(item => item.id === "chatcut").installedReleaseDigest, null);
      const bundledSource = { kind: "bundled", packageId: "chatcut" };
      const bundledPreview = await backend.previewPluginInstall(bundledSource);
      const bundledInstall = await backend.installPlugin({ source: bundledSource,
        previewDigest: bundledPreview.previewDigest, expectedRevision: bundledPreview.expectedRevision,
        operationId: "management-bundled-install" });
      assert.equal(bundledInstall.installation.desiredState, "enabled");
      assert.equal((await backend.listBundledPlugins()).items.find(item => item.id === "chatcut")
        .installedReleaseDigest, bundledPreview.previewDigest);
    } else {
      assert.deepEqual(bundledBefore.items, []);
    }
    assert.deepEqual(mismatchedErrors, [], "Backend must preserve fixed public Service error codes");
    console.log("plugin management Service + Backend consent/discovery/Grants/App DTO/legacy/uninstall flow: PASS");
  } finally {
    runtime?.clear(); appController?.clear();
    await service.stop({ notify: false });
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
