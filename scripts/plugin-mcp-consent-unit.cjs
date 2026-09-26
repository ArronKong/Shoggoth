"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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
const { validatePluginManagementResult } = require("../app/core/plugin-management-dto");

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-consent-"));
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
  try {
    const source = path.join(temp, "source");
    fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), source, { recursive: true });
    fs.writeFileSync(path.join(source, "bin/issue-fixture"), `#!${process.execPath}\n${
      fs.readFileSync(path.join(__dirname, "fixtures/plugins/mcp-data-lease-fixture.cjs"), "utf8")}`);
    fs.copyFileSync(path.join(__dirname, "fixtures/plugins/mcp-sdk-fixture.cjs"), path.join(source, "bin/mcp-sdk-fixture.cjs"));
    fs.chmodSync(path.join(source, "bin/issue-fixture"), 0o700);
    const installer = new PluginPackageInstaller({ store });
    const installed = installer.install({ sourcePath: source, previewDigest: installer.preview(source).contentDigest,
      expectedRevision: 0, operationId: "install-consent" });
    const installation = store.setInstallationDesiredState({ installationId: installed.installationId,
      desiredState: "enabled", expectedRevision: installed.revision });
    const component = new PluginComponentCatalog({ store }).list()[0].components.find(item => item.localName === "local-issues");
    const profile = { id: "profile-a", name: "Local Agent", enabled: true };
    const productStore = { getAgentProfile: id => id === profile.id ? profile : null };
    const manager = new PluginMcpConnectionManager({ store, resolver: new PluginComponentResolver({ store }), pool });
    let now = Date.now();
    const consent = new PluginMcpConsent({ store, productStore, manager, registry, now: () => now });
    const input = { action: "connect", profileId: profile.id, installationId: installation.installationId,
      componentId: component.componentId, expectedRevision: installation.revision, operationId: "connect-consent" };
    const canceled = consent.prepare(input);
    validatePluginManagementResult("plugins.mcp.consent.prepare", canceled);
    assert.equal(store.listBindingsForProfile(profile.id).length, 0, "preview cannot create execution authority");
    assert.equal((await consent.commit({ challenge: canceled.challenge, approved: false })).canceled, true);
    await assert.rejects(consent.commit({ challenge: canceled.challenge, approved: true }), { code: "PLUGIN_CONSENT_EXPIRED" });
    const stale = consent.prepare(input);
    profile.name = "Renamed Agent";
    await assert.rejects(consent.commit({ challenge: stale.challenge, approved: true }), { code: "REVISION_CONFLICT" });
    const expired = consent.prepare(input);
    now += 120_001;
    await assert.rejects(consent.commit({ challenge: expired.challenge, approved: true }), { code: "PLUGIN_CONSENT_EXPIRED" });
    const prepared = consent.prepare(input);
    const connected = await consent.commit({ challenge: prepared.challenge, approved: true });
    validatePluginManagementResult("plugins.mcp.consent.commit", connected);
    const binding = store.getBinding(connected.receipt.bindingId);
    assert.equal(store.getGrantCountsForBinding(binding.bindingId).allow, 0);
    await consent.discover({ profileId: profile.id, bindingId: binding.bindingId });
    const records = store.getCapabilityRecords(binding.bindingId, "unused");
    const catalog = registry.listForBinding(records);
    const tool = catalog.entries[0];
    const allowInput = { action: "allow", profileId: profile.id, bindingId: binding.bindingId,
      toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest,
      catalogRevision: catalog.catalogRevision, approvalMode: "always", expectedRevision: 0, operationId: "allow-consent" };
    const allow = consent.prepare(allowInput);
    const allowed = await consent.commit({ challenge: allow.challenge, approved: true });
    validatePluginManagementResult("plugins.mcp.consent.commit", allowed);
    const run = { id: "consent-run", profileId: profile.id, workspace: temp, status: "running" };
    const runtime = new PluginRuntimeToolService({ store, productStore, permissionEngine: policy,
      getRun: id => id === run.id ? run : null, toolCatalogRegistry: registry,
      capabilityDispatcher: dispatcher, acquireConnection: value => manager.acquire(value) });
    runtime.captureRun(run);
    const result = await runtime.callTool({ serverId: pluginServerId(binding.bindingId),
      toolName: tool.downstreamName, arguments: { value: "consented" } },
    { profileId: profile.id, callId: "consent-call" }, { runId: run.id, assertCurrent() {} });
    assert.equal(result.result.structuredContent.echoed, "consented");
    assert(result.result.structuredContent.dataDirectory.startsWith(fs.realpathSync(paths.pluginsDir)));
    const grant = store.getGrant(binding.bindingId, tool.toolIdentity);
    store.revokeGrant({ bindingId: binding.bindingId, toolIdentity: tool.toolIdentity, expectedRevision: grant.revision });
    await assert.rejects(runtime.callTool({ serverId: pluginServerId(binding.bindingId), toolName: tool.downstreamName,
      arguments: { value: "denied" } }, { profileId: profile.id, callId: "after-revoke" },
    { runId: run.id, assertCurrent() {} }));
    // A late tool catalog cannot make a revoked/archived binding usable.
    profile.enabled = false;
    await assert.rejects(consent.discover({ profileId: profile.id, bindingId: binding.bindingId }), { code: "PLUGIN_BINDING_INVALID" });
    runtime.clear(); consent.clear(); manager.clear();
    console.log("plugin native consent + real stdio + Runtime dispatch: PASS");
  } finally { await pool.close(); store.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
