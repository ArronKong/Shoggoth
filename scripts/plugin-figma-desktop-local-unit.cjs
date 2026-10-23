"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { ENDPOINT, isFigmaDesktopComponent } = require("../app/core/figma-desktop-mcp");
const { verifyFigmaDesktopListener } = require("../app/agent-service/plugin-figma-desktop-listener");
const { convertLegacyPluginContents } = require("../app/core/legacy-plugin-content-adapter");
const { identifyLegacySource, scanLegacySource } = require("../app/agent-service/plugin-legacy-source");
const { BundledPluginCatalog, bundledRoot } = require("../app/core/bundled-plugin-catalog");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginComponentCatalog } = require("../app/agent-service/plugin-component-catalog");
const { PluginComponentResolver } = require("../app/agent-service/plugin-component-resolver");
const { PluginMcpConnectionPool } = require("../app/agent-service/plugin-mcp-connection-pool");
const { PluginDataScopeLeaseManager } = require("../app/agent-service/plugin-data-scope-lease");
const { PluginMcpConnectionManager } = require("../app/agent-service/plugin-mcp-connection-manager");
const { PluginMcpConsent } = require("../app/agent-service/plugin-mcp-consent");
const { PluginToolCatalogRegistry } = require("../app/agent-service/plugin-tool-catalog-registry");
const { CapabilityDispatcher } = require("../app/agent-service/capability-dispatcher");
const { PermissionEngine } = require("../app/agent-service/permission-engine");
const { PluginRuntimeToolService, pluginServerId } = require("../app/agent-service/plugin-runtime-tool-service");
const { evaluatePluginSkill } = require("../app/agent-service/plugin-skill-eligibility");
const { handle: fixtureHandle } = require("./fixtures/plugins/mcp-sdk-fixture.cjs");

const TOOL = { name: "get_design_context", description: "Read a local Figma selection",
  inputSchema: { type: "object", properties: { nodeId: { type: "string" } },
    required: ["nodeId"], additionalProperties: false } };
const REMOTE_ONLY = { name: "use_figma", description: "Remote-only trap",
  inputSchema: { type: "object", properties: {}, additionalProperties: false } };
const LOCAL_WRITE = { name: "add_code_connect_map", description: "Local write trap",
  inputSchema: { type: "object", properties: {}, additionalProperties: false } };

async function localFixture() {
  const state = { requests: [], calls: [] };
  const server = http.createServer(async (request, response) => {
    if (request.url !== "/mcp" || request.method !== "POST") {
      response.writeHead(405); response.end(); return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    state.requests.push({ method: message.method, auth: request.headers.authorization ?? null });
    let result = fixtureHandle(message, "2025-11-25", { calls: 0 });
    if (message.method === "tools/list") result.result.tools = [TOOL, REMOTE_ONLY, LOCAL_WRITE];
    if (message.method === "tools/call") {
      state.calls.push(message.params.name);
      result = { jsonrpc: "2.0", id: message.id, result: { content: [
        { type: "text", text: `selected ${message.params.arguments.nodeId}` }],
        structuredContent: { nodeId: message.params.arguments.nodeId }, isError: false } };
    }
    if (!result) { response.writeHead(202); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { state, url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise(resolve => server.close(resolve)) };
}

async function main() {
  const source = identifyLegacySource({ sourcePath: path.join(bundledRoot(), "packages", "figma"),
    format: "codex-plugin", components: ["skills", "mcp-servers"], trustedBundled: true });
  const snapshot = scanLegacySource(source);
  assert.deepEqual(snapshot.conversion.skills.map(skill => skill.name),
    ["figma-design-to-code", "figma-implement-motion"]);
  assert.deepEqual(snapshot.conversion.mcpServers.map(server => server.name), ["figma"]);
  assert.equal(JSON.parse(snapshot.conversion.generatedFiles.find(file => file.path === "mcp.json").content)
    .mcpServers.figma.url, ENDPOINT);
  const changedFiles = snapshot.files.map(file => file.path === ".mcp.json"
    ? { ...file, content: Buffer.from(file.content.toString("utf8").replace(
      "https://mcp.figma.com/mcp", "https://mcp.figma.com/changed")) } : file);
  const unreviewed = convertLegacyPluginContents({ format: "codex-plugin", files: changedFiles,
    components: ["skills", "mcp-servers"], bundledCodex: true });
  assert.deepEqual(unreviewed.mcpServers, []);
  assert(unreviewed.diagnostics.some(issue => issue.reasonCode === "FIGMA_DESKTOP_SOURCE_UNREVIEWED"));
  assert.equal(isFigmaDesktopComponent({ installation: { sourceIdentity: "local:figma" },
    component: { name: "figma", transport: "streamable-http", oauthResource: null,
      spec: { type: "streamable-http", url: ENDPOINT } } }), false);

  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-figma-local-")));
  const fakeApp = path.join(temp, "Figma.app");
  const fakeExecutable = path.join(fakeApp, "Contents", "MacOS", "Figma");
  fs.mkdirSync(path.dirname(fakeExecutable), { recursive: true });
  fs.writeFileSync(fakeExecutable, "fixture", { mode: 0o700 });
  const fakeHelper = path.join(fakeApp, "Contents", "Frameworks", "Figma Helper.app",
    "Contents", "MacOS", "Figma Helper");
  fs.mkdirSync(path.dirname(fakeHelper), { recursive: true });
  fs.writeFileSync(fakeHelper, "fixture", { mode: 0o700 });
  const fixtureUid = process.getuid?.() ?? 501;
  const listener = (pid = 1234, uid = fixtureUid, name = "127.0.0.1:3845") =>
    `p${pid}\ncFigma\nu${uid}\nf17u\ntIPv4\nn${name}\n`;
  const textFiles = (exe = fakeExecutable, pid = 1234, uid = fixtureUid) =>
    `p${pid}\ncFigma\nu${uid}\nftxt\ntREG\nn${exe}\nftxt\ntREG\nn/usr/lib/dyld\n`;
  const commandFixture = ({ socket = listener(), socketAfter = socket,
    executable = textFiles(), executableId = "com.figma.Desktop",
    team = "T8RA8NE3B7", verifyStatus = 0 } = {}) => {
    let listenerCalls = 0;
    return (binary, args) => {
      if (binary === "/usr/sbin/lsof") return { status: 0, signal: null, error: null,
        stdout: args.includes("-d") ? executable : (++listenerCalls === 1 ? socket : socketAfter),
        stderr: "" };
    if (binary === "/usr/bin/codesign") {
      if (args.includes("--verify")) return { status: verifyStatus,
        signal: null, error: null, stdout: "", stderr: "" };
      const target = args.at(-1);
      return { status: 0, signal: null, error: null, stdout: "", stderr:
        `Executable=${target === fakeApp ? fakeExecutable : target}\n`
        + `Identifier=${target === fakeApp ? "com.figma.Desktop" : executableId}\n`
        + `TeamIdentifier=${team}\n` };
    }
    throw new Error("unexpected command");
    };
  };
  const identity = run => verifyFigmaDesktopListener({ run, appPath: fakeApp,
    platform: "darwin", uid: fixtureUid });
  assert.equal(await identity(commandFixture()), true);
  assert.equal(await identity(commandFixture({ executable: textFiles(fakeHelper),
    executableId: "com.figma.Desktop.helper" })), true);
  for (const bad of [
    { socket: listener(1234, fixtureUid, "*:3845") },
    { socket: listener(1234, fixtureUid + 1) },
    { socket: `${listener()}${listener(5678)}` },
    { executable: textFiles("/tmp/Figma") },
    { team: "WRONGTEAM" },
    { verifyStatus: 1 },
    { socketAfter: listener(5678) },
  ]) await assert.rejects(identity(commandFixture(bad)), { code: "FIGMA_DESKTOP_IDENTITY_UNVERIFIED" });
  const linkedApp = path.join(temp, "Figma-link.app");
  fs.symlinkSync(fakeApp, linkedApp, "dir");
  await assert.rejects(verifyFigmaDesktopListener({ run: commandFixture({
    executable: textFiles(path.join(linkedApp, "Contents", "MacOS", "Figma")) }),
    appPath: linkedApp, platform: "darwin", uid: fixtureUid }),
  { code: "FIGMA_DESKTOP_IDENTITY_UNVERIFIED" });
  const paths = resolveServicePaths({ stateRoot: path.join(temp, "state"), trustedRoot: temp });
  const store = new PluginStore({ paths }).open();
  const registry = new PluginToolCatalogRegistry();
  const policy = new PermissionEngine({ toolRegistry: { revision: "fixture",
    get: name => ({ tool: name, enabled: true, risk: "write" }),
    list: () => [{ tool: "mcp_server_call", enabled: true, risk: "write" }] } });
  const dispatcher = new CapabilityDispatcher({ store, permissionEngine: policy,
    resolveToolContract: value => registry.resolve(value) });
  const pool = new PluginMcpConnectionPool({ leaseManager: new PluginDataScopeLeaseManager({ paths }),
    authorizeEgress: value => dispatcher.authorizeEgress(value),
    onConnectionInvalidated: ({ connectionId }) => registry.invalidate(connectionId),
    canAcquire: ({ installationId }) => store.getInstallation(installationId)?.desiredState === "enabled"
      && !store.hasPendingInstallationDisable(installationId) });
  const fixture = await localFixture();
  try {
    const catalog = new BundledPluginCatalog(bundledRoot());
    const installer = new PluginPackageInstaller({ store, bundledCatalog: catalog });
    const preview = installer.previewBundled("figma");
    assert.equal(preview.installable, true);
    const installed = installer.installBundled({ packageId: "figma", previewDigest: preview.contentDigest,
      operationId: "install-figma-desktop", expectedRevision: 0 });
    let installation = store.getInstallation(installed.installationId);
    const skillDescriptor = name => ({ ...preview.skills.find(skill => skill.name === name),
      sourceIdentity: "bundled:figma", installationId: installed.installationId });
    const boundTools = ["get_design_context", "get_motion_context"].map(name => ({
      name, sourceIdentity: "bundled:figma", installationId: installed.installationId }));
    assert.equal(evaluatePluginSkill(skillDescriptor("figma-design-to-code"),
      { pluginTools: boundTools.slice(0, 1) }).eligible, true);
    assert.equal(evaluatePluginSkill(skillDescriptor("figma-implement-motion"),
      { pluginTools: boundTools.slice(0, 1) }).eligible, false);
    assert.equal(evaluatePluginSkill(skillDescriptor("figma-implement-motion"),
      { pluginTools: boundTools }).eligible, true);
    if (installation.desiredState !== "enabled") installation = store.setInstallationDesiredState({
      installationId: installation.installationId, desiredState: "enabled",
      expectedRevision: installation.revision });
    const component = new PluginComponentCatalog({ store }).list()[0].components
      .find(item => item.localName === "figma");
    assert(component);
    const profile = { id: "figma-profile", name: "Figma fixture", enabled: true };
    const productStore = { getAgentProfile: id => id === profile.id ? profile : null };
    const forwarded = [];
    const figmaFetch = (target, init) => {
      assert.equal(new URL(target).href, ENDPOINT);
      forwarded.push(init.method || "GET");
      return fetch(fixture.url, init);
    };
    let identityChecks = 0;
    const manager = new PluginMcpConnectionManager({ store,
      resolver: new PluginComponentResolver({ store }), pool,
      figmaVerifyListener: () => { identityChecks += 1; return true; },
      figmaFetchImpl: () => Promise.reject(Object.assign(new Error("Desktop offline"), { code: "ECONNREFUSED" })) });
    const consent = new PluginMcpConsent({ store, productStore, manager, registry });
    const connect = operationId => ({ action: "connect", profileId: profile.id,
      installationId: installation.installationId, componentId: component.componentId,
      expectedRevision: installation.revision, operationId });
    const offline = consent.prepare(connect("figma-offline"));
    await assert.rejects(consent.commit({ challenge: offline.challenge, approved: true }));
    assert.equal(store.listConnections().length, 0, "offline Desktop never creates a ready connection");
    assert.equal(identityChecks, 1, "listener identity is checked before probe");
    manager.figmaFetchImpl = figmaFetch;
    manager.figmaVerifyListener = () => false;
    const impostor = consent.prepare(connect("figma-impostor"));
    await assert.rejects(consent.commit({ challenge: impostor.challenge, approved: true }),
      { code: "FIGMA_DESKTOP_IDENTITY_UNVERIFIED" });
    assert.equal(forwarded.length, 0, "unverified listener receives no HTTP request");
    manager.figmaVerifyListener = () => { identityChecks += 1; return true; };
    const prepared = consent.prepare(connect("figma-connect"));
    const receipt = await consent.commit({ challenge: prepared.challenge, approved: true });
    const binding = store.getBinding(receipt.receipt.bindingId);
    const connection = store.getConnectionAuth(binding.connectionId);
    assert.equal(connection.endpointIdentity, ENDPOINT);
    assert.equal(connection.credentialRef, null);
    assert.equal(connection.state, "ready");
    await consent.discover({ profileId: profile.id, bindingId: binding.bindingId });
    const records = store.getCapabilityRecords(binding.bindingId, "unused");
    const discovered = registry.listForBinding(records);
    assert.deepEqual(discovered.entries.map(entry => entry.downstreamName), ["get_design_context"]);
    const tool = discovered.entries[0];
    const allowed = consent.prepare({ action: "allow", profileId: profile.id,
      bindingId: binding.bindingId, toolIdentity: tool.toolIdentity,
      contractDigest: tool.contractDigest, catalogRevision: discovered.catalogRevision,
      approvalMode: "always", expectedRevision: 0, operationId: "figma-grant" });
    await consent.commit({ challenge: allowed.challenge, approved: true });
    const run = { id: "figma-run", profileId: profile.id, workspace: temp, status: "running" };
    const runtime = new PluginRuntimeToolService({ store, productStore, permissionEngine: policy,
      getRun: id => id === run.id ? run : null, toolCatalogRegistry: registry,
      capabilityDispatcher: dispatcher, acquireConnection: value => manager.acquire(value) });
    runtime.captureRun(run);
    const result = await runtime.callTool({ serverId: pluginServerId(binding.bindingId),
      toolName: "get_design_context", arguments: { nodeId: "1:2" } },
    { profileId: profile.id, callId: "figma-read" }, { runId: run.id, assertCurrent() {} });
    assert.equal(result.result.structuredContent.nodeId, "1:2");
    assert(identityChecks >= 3, "runtime HTTP acquisition checks listener identity");
    assert.deepEqual(fixture.state.calls, ["get_design_context"]);
    assert(fixture.state.requests.every(request => request.auth === null),
      "Figma Desktop calls must not transmit an OAuth or bearer token");
    const handle = await manager.acquire({ installation, binding: store.getBinding(binding.bindingId),
      connection: store.getConnection(binding.connectionId) });
    try {
      assert.throws(() => handle.callTool("use_figma", {}, {}, {}),
        { code: "CAPABILITY_FORBIDDEN" });
      assert.throws(() => handle.callTool("add_code_connect_map", {}, {}, {}),
        { code: "CAPABILITY_FORBIDDEN" });
    } finally { await handle.release(); }
    assert.deepEqual(fixture.state.calls, ["get_design_context"],
      "remote-only and local-write tools never reach the local endpoint");
    const grant = store.getGrant(binding.bindingId, tool.toolIdentity);
    store.revokeGrant({ bindingId: binding.bindingId, toolIdentity: tool.toolIdentity,
      expectedRevision: grant.revision });
    await assert.rejects(runtime.callTool({ serverId: pluginServerId(binding.bindingId),
      toolName: "get_design_context", arguments: { nodeId: "2:3" } },
    { profileId: profile.id, callId: "figma-revoked" }, { runId: run.id, assertCurrent() {} }));
    assert.deepEqual(fixture.state.calls, ["get_design_context"]);
    assert(forwarded.length > 0);
    runtime.clear(); consent.clear(); manager.clear();
    console.log("Figma Desktop listener identity + local MCP connect/discover/grant/read/revoke: PASS");
  } finally {
    await pool.close(); await fixture.close(); store.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
