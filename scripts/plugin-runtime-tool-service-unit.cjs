"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginComponentCatalog } = require("../app/agent-service/plugin-component-catalog");
const { PluginToolCatalogRegistry } = require("../app/agent-service/plugin-tool-catalog-registry");
const { CapabilityDispatcher } = require("../app/agent-service/capability-dispatcher");
const { PermissionEngine } = require("../app/agent-service/permission-engine");
const { PluginRuntimeToolService, pluginServerId } = require("../app/agent-service/plugin-runtime-tool-service");
const { McpProductToolController, validateMcpProductToolArguments } = require("../app/agent-service/mcp-product-tool-controller");

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-runtime-"));
  const paths = resolveServicePaths({ stateRoot: path.join(temp, "state"), userDataRoot: temp,
    profileRoot: path.join(temp, "profile"), cacheRoot: path.join(temp, "cache"), trustedRoot: temp });
  const store = new PluginStore({ paths }).open();
  const catalogs = new PluginToolCatalogRegistry();
  try {
    const sourcePath = path.join(temp, "source");
    fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), sourcePath, { recursive: true });
    const installer = new PluginPackageInstaller({ store });
    const installed = installer.install({ sourcePath, previewDigest: installer.preview(sourcePath).contentDigest,
      operationId: "runtime-install", expectedRevision: 0 });
    const installation = store.setInstallationDesiredState({ installationId: installed.installationId,
      desiredState: "enabled", expectedRevision: installed.revision });
    const component = new PluginComponentCatalog({ store }).list()[0].components
      .find(entry => entry.localName === "local-issues");
    const pending = store.createConnection({ connectionId: "runtime-connection", installationId: installed.installationId,
      componentId: component.componentId, endpointIdentity: "fixture://local" });
    const connection = store.setConnectionIdentity({ connectionId: pending.connectionId,
      principalIdentity: "fixture-account", state: "ready", expectedRevision: pending.revision });
    const created = store.createBinding({ bindingId: "runtime-binding", profileId: "agent-a",
      installationId: installed.installationId, componentId: component.componentId, connectionId: connection.connectionId });
    const binding = store.setBindingEnabled({ bindingId: created.bindingId, enabled: true, expectedRevision: created.revision });
    let tools = ["read", "write"].map(name => ({ name, description: name,
      inputSchema: { type: "object", properties: { value: { type: "string" } } } }));
    tools.push({ name: "app-only", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["app"] } } },
      { name: "invalid-ui", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["unknown"] } } });
    let beforeSend = null;
    let sends = 0;
    let releases = 0;
    const productRegistry = { revision: "fixture", get: name => ({ tool: name, enabled: true, risk: "write" }),
      list: () => [{ tool: "mcp_server_call", enabled: true, risk: "write" }],
      publicProjection: () => ({ capabilities: [] }) };
    const policy = new PermissionEngine({ toolRegistry: productRegistry });
    const dispatcher = new CapabilityDispatcher({ store, permissionEngine: policy,
      resolveToolContract: value => catalogs.resolve(value) });
    const client = { listTools: async () => tools, release: async () => { releases += 1; },
      callTool: async (name, args, ticket) => {
        if (beforeSend) await beforeSend();
        dispatcher.authorizeEgress({ connectionId: connection.connectionId,
          principalIdentity: connection.principalIdentity, toolName: name, arguments: args, authority: ticket });
        sends += 1;
        return { content: [], structuredContent: { name, value: args.value } };
      } };
    const catalog = await catalogs.refresh({ installation, connection, client });
    const read = catalog.entries.find(entry => entry.downstreamName === "read");
    const write = catalog.entries.find(entry => entry.downstreamName === "write");
    store.setGrant({ grantId: "runtime-grant-read", bindingId: binding.bindingId,
      toolIdentity: read.toolIdentity, contractDigest: read.contractDigest,
      effect: "allow", approvalMode: "always", expectedRevision: 0 });
    for (const tool of catalog.entries.filter(entry => ["app-only", "invalid-ui"].includes(entry.downstreamName))) {
      store.setGrant({ grantId: `grant-${tool.downstreamName}`, bindingId: binding.bindingId,
        toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest,
        effect: "allow", approvalMode: "always", expectedRevision: 0 });
    }
    const profiles = new Map(["a", "b"].map(suffix => [`agent-${suffix}`, { id: `agent-${suffix}`, enabled: true }]));
    const runs = new Map();
    const newRun = (id, profileId = "agent-a") => {
      const run = { id, profileId, workspace: temp, status: "running" };
      runs.set(id, run); return run;
    };
    const productStore = { getAgentProfile: id => profiles.get(id), lookupMcpToolCall: () => null,
      addRunNote() {}, beginMcpToolCall() {}, completeMcpToolCall() {} };
    const runtime = new PluginRuntimeToolService({ store, productStore, getRun: id => runs.get(id),
      toolCatalogRegistry: catalogs, capabilityDispatcher: dispatcher, permissionEngine: policy,
      acquireConnection: async () => client });
    runtime.captureRun(newRun("run-a"));
    runtime.captureRun(newRun("run-b", "agent-b"));
    let current = true;
    const scope = { runId: "run-a", assertCurrent() {
      if (!current) throw Object.assign(new Error("revoked"), { code: "HOST_CAPABILITY_REVOKED" });
    } };
    const authority = () => ({ profileId: "agent-a", callId: crypto.randomUUID() });
    const serverId = pluginServerId(binding.bindingId);
    const args = { serverId, toolName: "read", arguments: { value: "hello" } };
    assert(validateMcpProductToolArguments("mcp_server_call", args));
    assert(!validateMcpProductToolArguments("mcp_server_remove", { id: serverId, expectedRevision: 1 }));
    assert.equal(runtime.listServers(authority(), scope)[0].id, serverId);
    assert.deepEqual(runtime.listServers({ profileId: "agent-b" }, { ...scope, runId: "run-b" }), []);
    await assert.rejects(runtime.callTool(args, { profileId: "agent-b", callId: crypto.randomUUID() }, scope),
      error => error.code === "CAPABILITY_FORBIDDEN");
    await assert.rejects(runtime.callTool(args, { ...authority(), federationClient: "hermes" }, scope),
      error => error.code === "CAPABILITY_FORBIDDEN");
    assert.deepEqual((await runtime.listTools({ serverId, cursor: 0, limit: 20 }, authority(), scope))
      .items.map(entry => entry.name), ["read"]);
    for (const toolName of ["app-only", "invalid-ui"]) await assert.rejects(
      runtime.callTool({ ...args, toolName }, authority(), scope), error => error.code === "CAPABILITY_FORBIDDEN");
    const duplicate = authority();
    assert.equal((await runtime.callTool(args, duplicate, scope)).result.structuredContent.value, "hello");
    await assert.rejects(runtime.callTool(args, duplicate, scope), error => error.code === "CALL_ALREADY_RECORDED");
    assert.equal(sends, 1, "durable plugin receipt forbids repeat effects");

    store.setGrant({ grantId: "runtime-grant-write", bindingId: binding.bindingId,
      toolIdentity: write.toolIdentity, contractDigest: write.contractDigest,
      effect: "allow", approvalMode: "always", expectedRevision: 0 });
    await assert.rejects(runtime.callTool({ ...args, toolName: "write" }, authority(), scope),
      error => error.code === "CAPABILITY_FORBIDDEN");
    assert.throws(() => runtime.captureRun(runs.get("run-a")), error => error.code === "TOOL_CONTRACT_CHANGED");
    runtime.captureRun(newRun("run-new"));
    assert.equal((await runtime.callTool({ ...args, toolName: "write" }, authority(), { ...scope, runId: "run-new" }))
      .result.structuredContent.name, "write");

    beforeSend = async () => { current = false; };
    const revokedCall = authority();
    await assert.rejects(runtime.callTool(args, revokedCall, scope), error => error.code === "HOST_CAPABILITY_REVOKED");
    const revokedReceipt = `runtime-${crypto.createHash("sha256")
      .update(JSON.stringify(["run-a", "agent-a", revokedCall.callId])).digest("hex")}`;
    assert.equal(store.getCapabilityCall(revokedReceipt).phase, "rejected_before_send");
    assert.equal(sends, 2, "lease revoked during transport wait cannot send");
    current = true;
    beforeSend = async () => { profiles.get("agent-a").enabled = false; };
    await assert.rejects(runtime.callTool(args, authority(), scope), error => error.code === "CAPABILITY_FORBIDDEN");
    assert.equal(sends, 2, "Profile is checked again at final egress");
    profiles.get("agent-a").enabled = true;
    beforeSend = null;
    policy.setProfileOverride("agent-a", "mcp_server_call", "deny");
    runtime.captureRun(newRun("run-product-denied"));
    policy.setProfileOverride("agent-a", "mcp_server_call", "allow");
    await assert.rejects(runtime.callTool(args, authority(), { ...scope, runId: "run-product-denied" }),
      error => error.code === "CAPABILITY_FORBIDDEN");
    beforeSend = async () => { policy.setProfileOverride("agent-a", "mcp_server_call", "deny"); };
    await assert.rejects(runtime.callTool(args, authority(), scope), error => error.code === "MCP_TOOL_FORBIDDEN");
    assert.equal(sends, 2, "current Product policy intersects frozen admission permission");
    policy.setProfileOverride("agent-a", "mcp_server_call", "allow");
    beforeSend = null;

    const noop = () => null;
    let standaloneCalls = 0;
    const controller = new McpProductToolController({ productStore, toolRegistry: productRegistry, permissionEngine: policy,
      domainController: { handle: noop }, kanbanStore: Object.fromEntries([
        "getBoard", "getCard", "listCardRunLinks", "getCardRunLinkByRunId", "addComment", "addArtifact", "listArtifacts",
      ].map(name => [name, noop])), kanbanRunService: { requestCompletionFromAgent: noop },
      cronStore: { getJob: noop }, workDispatcher: { getRun: id => runs.get(id) },
      nativeMcpStore: { list: () => ({ revision: 1, servers: [{ id: "standalone", name: "standalone" }] }),
        prepare: noop, get: noop, register: noop, remove: noop },
      nativeMcpClientManager: { probe: noop, listTools: async () => tools, closeServer: noop,
        callTool: async () => { standaloneCalls += 1; return { content: [] }; } },
      pluginRuntimeToolService: runtime, notificationSender: async () => {},
      isSensitiveValue: () => false, artifactRoot: temp });
    const listed = await controller.handle("mcp_server_list", {}, authority(), scope);
    assert.deepEqual(listed.servers.map(entry => entry.id), ["standalone", serverId]);
    const foreignList = await controller.handle("mcp_server_list", {}, { ...authority(), federationClient: "hermes" });
    assert.deepEqual(foreignList.servers.map(entry => entry.id), ["standalone"]);
    await assert.rejects(controller.handle("mcp_server_call", args,
      { ...authority(), federationClient: "hermes" }), error => error.code === "MCP_TOOL_FORBIDDEN");
    await controller.handle("mcp_server_call", { ...args, serverId: "standalone" }, authority());
    assert.equal(standaloneCalls, 1);
    const once = authority();
    await controller.handle("mcp_server_call", args, once, scope);
    const count = sends;
    await controller.handle("mcp_server_call", args, once, scope);
    assert.equal(sends, count, "controller exact replay never repeats effect");
    assert.equal(standaloneCalls, 1, "plugin dispatch never reaches NativeMcpClientManager");

    const writeGrant = store.getGrant(binding.bindingId, write.toolIdentity);
    store.setGrant({ grantId: writeGrant.grantId, bindingId: binding.bindingId,
      toolIdentity: write.toolIdentity, contractDigest: write.contractDigest,
      effect: "allow", approvalMode: "each-call", expectedRevision: writeGrant.revision });
    runtime.captureRun(newRun("run-each-call"));
    await assert.rejects(runtime.callTool({ ...args, toolName: "write" },
      { ...authority(), confirmation: true }, { ...scope, runId: "run-each-call" }),
    error => error.code === "CAPABILITY_FORBIDDEN");
    assert.equal(sends, count, "model confirmation cannot manufacture per-call consent");

    const existingGrant = store.getGrant(binding.bindingId, read.toolIdentity);
    const denied = store.setGrant({ grantId: existingGrant.grantId, bindingId: binding.bindingId,
      toolIdentity: read.toolIdentity, contractDigest: read.contractDigest,
      effect: "deny", approvalMode: "always", expectedRevision: existingGrant.revision });
    store.setGrant({ grantId: existingGrant.grantId, bindingId: binding.bindingId,
      toolIdentity: read.toolIdentity, contractDigest: read.contractDigest,
      effect: "allow", approvalMode: "always", expectedRevision: denied.revision });
    await assert.rejects(runtime.callTool(args, authority(), scope), error => error.code === "GRANT_REVOKED");
    assert.equal(sends, count, "regrant never revives the old Run envelope");
    runtime.captureRun(newRun("run-fresh"));
    const freshScope = { ...scope, runId: "run-fresh" };

    catalogs.invalidate(connection.connectionId);
    tools = [{ name: "read", description: "changed contract", inputSchema: { type: "object" } }];
    await assert.rejects(runtime.callTool(args, authority(), freshScope), error => error.code === "TOOL_CONTRACT_CHANGED");
    assert.equal(sends, count, "reconnect cannot replace the frozen tool contract");
    runtime.releaseRun("run-a");
    await assert.rejects(runtime.callTool(args, authority(), scope), error => error.code === "CAPABILITY_FORBIDDEN");
    assert(releases > 0);
    runtime.clear();
    console.log("plugin-runtime-tool-service-unit: native dispatch, final egress, frozen grants, replay, federation and standalone isolation passed");
  } finally { store.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
