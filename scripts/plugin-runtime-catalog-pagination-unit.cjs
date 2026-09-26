"use strict";

const assert = require("node:assert/strict");
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

async function main() {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plugin-pagination-")));
  const paths = resolveServicePaths({ userDataRoot: path.join(temp, "user"),
    cacheRoot: path.join(temp, "cache"), trustedRoot: temp });
  const store = new PluginStore({ paths }).open();
  const installer = new PluginPackageInstaller({ store });
  const catalogs = new PluginToolCatalogRegistry();
  let runtime, dispatcher;
  try {
    const source = path.join(temp, "source");
    fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), source, { recursive: true });
    const receipt = installer.install({ sourcePath: source, previewDigest: installer.preview(source).contentDigest,
      operationId: "pagination-install", expectedRevision: 0 });
    const installation = store.setInstallationDesiredState({ installationId: receipt.installationId,
      desiredState: "enabled", expectedRevision: receipt.revision });
    const component = new PluginComponentCatalog({ store }).list()[0].components.find(item => item.localName === "local-issues");
    const pending = store.createConnection({ connectionId: "pagination-connection", installationId: installation.installationId,
      componentId: component.componentId, endpointIdentity: "fixture://pagination" });
    const connection = store.setConnectionIdentity({ connectionId: pending.connectionId, principalIdentity: "fixture-account",
      state: "ready", expectedRevision: pending.revision });
    const created = store.createBinding({ bindingId: "pagination-binding", profileId: "agent-fixture",
      installationId: installation.installationId, componentId: component.componentId, connectionId: connection.connectionId });
    const binding = store.setBindingEnabled({ bindingId: created.bindingId, enabled: true, expectedRevision: created.revision });
    const originalTools = Array.from({ length: 45 }, (_, index) => ({ name: `read_${String(index).padStart(3, "0")}`,
      description: "Local pagination fixture", inputSchema: { type: "object", additionalProperties: false } }));
    let tools = [...originalTools].reverse(), onList = null, beforeSend = null, sends = 0, callCounter = 0;
    const registry = { revision: "fixture", list: () => [{ tool: "mcp_server_call", enabled: true, risk: "read" }],
      get: name => ({ tool: name, enabled: true, risk: "read" }) };
    const permissionEngine = new PermissionEngine({ toolRegistry: registry });
    dispatcher = new CapabilityDispatcher({ store, permissionEngine, resolveToolContract: value => catalogs.resolve(value) });
    const client = { listTools: async () => { if (onList) await onList(); return structuredClone(tools); }, release: async () => {},
      callTool: async (name, args, authority) => {
        if (beforeSend) await beforeSend();
        dispatcher.authorizeEgress({ connectionId: connection.connectionId, principalIdentity: connection.principalIdentity,
          toolName: name, arguments: args, authority });
        sends++; return { content: [{ type: "text", text: "local fixture" }] };
      } };
    const catalog = await catalogs.refresh({ installation, connection, client });
    for (const [index, entry] of catalog.entries.entries()) store.setGrant({ grantId: `pagination-grant-${index}`,
      bindingId: binding.bindingId, toolIdentity: entry.toolIdentity, contractDigest: entry.contractDigest,
      effect: "allow", approvalMode: "always", expectedRevision: 0 });
    const profile = { id: "agent-fixture", enabled: true }, runs = new Map();
    runtime = new PluginRuntimeToolService({ store, productStore: { getAgentProfile: id => id === profile.id ? profile : null },
      getRun: id => runs.get(id), toolCatalogRegistry: catalogs, capabilityDispatcher: dispatcher, permissionEngine,
      acquireConnection: async () => client });
    const capture = id => {
      const run = { id, profileId: profile.id, status: "running", workspace: temp }; runs.set(id, run);
      runtime.captureRun(run); return { runId: id, assertCurrent() {} };
    };
    const authority = () => ({ profileId: profile.id, callId: `fixture-call-${++callCounter}` });
    const serverId = pluginServerId(binding.bindingId);
    const page = (scope, cursor, limit = 20) => runtime.listTools({ serverId, cursor, limit }, authority(), scope);
    const nativePrepare = store.db.prepare.bind(store.db);
    let prepares = 0;
    store.db.prepare = sql => { prepares++; return nativePrepare(sql); };
    const scope = capture("run-pagination");
    await assert.rejects(page(scope, 20), { code: "TOOL_CONTRACT_CHANGED" });
    const first = await page(scope, 0);
    tools.reverse(); // Remote order is not a cursor-generation change.
    const second = await page(scope, first.nextCursor);
    const third = await page(scope, second.nextCursor);
    assert.deepEqual([...first.items, ...second.items, ...third.items].map(item => item.name), originalTools.map(item => item.name));
    assert.equal(third.hasMore, false);
    assert(prepares < 20, `bounded SQL compilation expected, got ${prepares}`);
    const compiledAfterWarmup = prepares;
    for (let repeat = 0; repeat < 10; repeat++) {
      let cursor = 0, more;
      do { const value = await page(scope, cursor); cursor = value.nextCursor; more = value.hasMore; } while (more);
    }
    assert.equal(prepares, compiledAfterWarmup, "page walks reuse SQL programs without caching authority rows");

    await page(scope, 0);
    tools = [...originalTools, { name: "new_ungranted", inputSchema: { type: "object" } }];
    await assert.rejects(page(scope, 20), { code: "TOOL_CONTRACT_CHANGED" });
    assert(!(await page(scope, 0)).items.some(item => item.name === "new_ungranted"), "new catalog tools cannot broaden Run authority");
    tools = structuredClone(originalTools);
    await page(scope, 0);
    tools[30].description = "changed contract";
    await assert.rejects(page(scope, 20), { code: "TOOL_CONTRACT_CHANGED" });
    tools = structuredClone(originalTools);

    const revoke = entry => {
      const grant = store.getGrant(binding.bindingId, entry.toolIdentity);
      return store.revokeGrant({ bindingId: binding.bindingId, toolIdentity: entry.toolIdentity, expectedRevision: grant.revision });
    };
    await page(scope, 0);
    const revoked = revoke(catalog.entries[0]);
    await assert.rejects(page(scope, 20), { code: "TOOL_CONTRACT_CHANGED" });
    assert(!(await page(scope, 0)).items.some(item => item.name === "read_000"));
    store.setGrant({ grantId: revoked.grantId, bindingId: binding.bindingId, toolIdentity: revoked.toolIdentity,
      contractDigest: revoked.contractDigest, effect: "allow", approvalMode: "always", expectedRevision: revoked.revision });
    assert(!(await page(scope, 0)).items.some(item => item.name === "read_000"), "regrant cannot revive a frozen epoch");
    const fresh = capture("run-fresh");
    assert.equal((await page(fresh, 0)).items[0].name, "read_000");
    onList = () => { onList = null; revoke(catalog.entries[1]); };
    assert(!(await page(fresh, 0)).items.some(item => item.name === "read_001"), "revocation during transport is read after await");
    beforeSend = () => { beforeSend = null; revoke(catalog.entries[2]); };
    await assert.rejects(runtime.callTool({ serverId, toolName: "read_002", arguments: {} }, authority(), fresh), { code: "GRANT_REVOKED" });
    assert.equal(sends, 0, "final Dispatcher egress still rejects authority revoked after dispatch admission");
    onList = () => { onList = null; store.setConnectionIdentity({ connectionId: connection.connectionId,
      principalIdentity: "different-account", state: "ready", expectedRevision: connection.revision }); };
    await assert.rejects(page(fresh, 0), { code: "GRANT_REVOKED" });

    assert.throws(() => store.getCapabilityRecordsForTools(binding.bindingId, Array.from({ length: 257 }, (_, i) => `tool-${i}`)),
      { code: "PLUGIN_GRANT_INVALID" });
    const current = store.getCapabilityRecordsForTools(binding.bindingId, [catalog.entries[0].toolIdentity]);
    current.records.connection.principalIdentity = "forged";
    assert.equal(store.getCapabilityRecordsForTools(binding.bindingId, []).records.connection.principalIdentity, "different-account");
    const oldIncarnation = store.getAuthorityIncarnation();
    store.rotateAuthorityForRestore({ backupId: "fixture-restore" });
    assert.notEqual(store.getAuthorityIncarnation(), oldIncarnation, "reused SQL always reads current authority incarnation");
    const restoredIncarnation = store.getAuthorityIncarnation();
    store.close(); store.open();
    assert.equal(store.getAuthorityIncarnation(), restoredIncarnation, "cached statements are discarded on close and reopen");
    assert.equal(store.getCapabilityRecordsForTools(binding.bindingId, []).records.connection.state, "disconnected");
    console.log("plugin-runtime-catalog-pagination: stable pages, bounded SQL compilation, fresh grants, revoke/regrant, contract drift, final egress and reopen PASS");
  } finally {
    runtime?.clear(); dispatcher?.clear(); await installer.remoteGitFetcher.close(); store.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
