"use strict";

// Real Service, production startup/Controller hook/Consent/ConnectionManager,
// current persisted Grant and an isolated stdio MCP. The external execution
// requester is synthetic: this does not replace the Hermes/OpenClaw Host proof.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService } = require("../app/agent-service/server");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { ensureCredential } = require("../app/agent-service/external-plugin-adapter-auth");
const { requestService } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { pluginServerId } = require("../app/agent-service/plugin-runtime-tool-service");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(predicate, label, timeout = 8000) { const deadline = Date.now() + timeout; while (!await predicate()) {
  if (Date.now() >= deadline) throw new Error(label + " timeout"); await sleep(20);
} }
const root = fs.mkdtempSync("/private/tmp/sgh-catalog-service-");
const paths = resolveServicePaths({ userDataRoot: path.join(root, "service"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
const control = path.join(root, "mcp-control.json"), trace = path.join(root, "mcp-requests.jsonl");
const state = { hold: false, drift: false };
const controlWrite = patch => { Object.assign(state, patch); fs.writeFileSync(control, JSON.stringify(state)); };
const traffic = method => fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse).filter(row => row.method === method).length : 0;
let service;
const backend = new ShoggothBackend({ paths });
const subject = { backendId: "hermes", instanceId: "catalog-fixture", agentId: "hermes-fixture", sessionId: "catalog-fixture-session" };
const credential = ensureCredential(paths, "hermes");
const privateRequest = (method, params) => requestService(paths, { version: SERVICE_PROTOCOL_VERSION, method, params }, { timeoutMs: 5000 });
async function start() {
  service = createAgentService({ paths, prewarmMcpAuth: false, parentEnv: {}, version: "plugin-catalog-restorer-fixture",
    externalPluginAgentVerifier: async identity => identity.agentId === subject.agentId && identity.backendId === subject.backendId
      ? { id: subject.agentId, backendId: subject.backendId } : null });
  await service.start(); assert(service.pluginCatalogRestorer);
}
async function restart() { await service.stop(); service = null; await start(); }
function authority(bindingId, toolIdentity) {
  const records = service.pluginStore.getCapabilityRecords(bindingId, toolIdentity);
  return { authorityIncarnation: records.authorityIncarnation, binding: records.binding,
    installation: records.installation, connection: records.connection, grant: records.grant };
}
async function main() {
  try {
    controlWrite({}); await start();
    const sourcePath = path.join(root, "source");
    fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), sourcePath, { recursive: true });
    // MCP-only ensures selection readiness really waits for a fresh allowed
    // tool; an unrelated Skill must not make this test pass prematurely.
    fs.rmSync(path.join(sourcePath, "skills"), { recursive: true });
    fs.writeFileSync(path.join(sourcePath, "mcp.json"), JSON.stringify({ "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { "local-issues": {
      type: "stdio", command: "./bin/issue-fixture", args: [], cwd: "${PLUGIN_ROOT}" } } }));
    fs.copyFileSync(path.join(__dirname, "fixtures/plugins/mcp-sdk-fixture.cjs"), path.join(sourcePath, "bin/mcp-sdk-fixture.cjs"));
    fs.writeFileSync(path.join(sourcePath, "bin/issue-fixture"), `#!${process.execPath}\n`
      + `const fs=require('node:fs');const readline=require('node:readline');const {handle,TOOL}=require('./mcp-sdk-fixture.cjs');\n`
      + `const control=${JSON.stringify(control)},trace=${JSON.stringify(trace)};const timers=new Set();\n`
      + `const settings=()=>JSON.parse(fs.readFileSync(control,'utf8'));\n`
      + `const send=response=>{try{process.stdout.write(JSON.stringify(response)+'\\n');}catch{process.exit(0);}};\n`
      + `const input=readline.createInterface({input:process.stdin});process.stdout.on('error',()=>process.exit(0));\n`
      + `input.on('close',()=>{for(const timer of timers)clearInterval(timer);process.exit(0);});\n`
      + `input.on('line',line=>{const request=JSON.parse(line);fs.appendFileSync(trace,JSON.stringify({method:request.method,pid:process.pid})+'\\n');\n`
      + `const response=handle(request);if(!response)return;const finish=()=>{if(request.method==='tools/list'){const config=settings();response.result.tools=[config.drift?{...TOOL,inputSchema:{type:'object',properties:{value:{type:'number'}},required:['value'],additionalProperties:false}}:TOOL];}send(response);};\n`
      + `if(request.method==='tools/list'&&settings().hold){const timer=setInterval(()=>{if(!settings().hold){clearInterval(timer);timers.delete(timer);finish();}},10);timers.add(timer);}else finish();});\n`, { mode: 0o700 });
    fs.chmodSync(path.join(sourcePath, "bin/issue-fixture"), 0o700);
    const source = { kind: "directory", path: sourcePath }, preview = await backend.previewPluginInstall(source);
    assert.equal(preview.installable, true);
    const installed = await backend.installPlugin({ source, previewDigest: preview.previewDigest,
      expectedRevision: preview.expectedRevision, operationId: "catalog-install" });
    const enabled = await backend.setPluginInstallationState({ installationId: installed.installation.installationId,
      desiredState: "enabled", expectedRevision: installed.installation.revision, operationId: "catalog-enable" });
    const installationId = enabled.installation.installationId;
    const rows = await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 10, catalogRevision: null });
    const component = rows.items.find(row => row.installationId === installationId).components.find(row => row.localName === "local-issues");
    assert(component, "local MCP component missing: " + JSON.stringify(rows.items.map(row => row.components.map(c => ({kind:c.kind,localName:c.localName})))));
    const profiles = await backend._page("profile.list", { backendId: "shoggoth", enabledOnly: true }, "profiles", { maxBytes: 512000, maxItems: 256 });
    const profileId = profiles.find(row => row.enabled).id;
    const connect = await backend._call("plugins.mcp.consent.prepare", { action: "connect", profileId, installationId,
      componentId: component.componentId, expectedRevision: enabled.installation.revision, operationId: "catalog-connect" });
    const bindingId = (await backend.commitPluginMcpConsent({ challenge: connect.challenge, approved: true })).receipt.bindingId;
    await backend._call("plugins.mcp.discover", { profileId, bindingId });
    const catalog = await backend._call("plugins.mcp.tools.list", { profileId, bindingId });
    const echo = catalog.items.find(row => row.name === "echo"); assert(echo);
    const allow = await backend._call("plugins.mcp.consent.prepare", { action: "allow", profileId, bindingId,
      toolIdentity: echo.toolIdentity, contractDigest: echo.contractDigest, catalogRevision: catalog.catalogRevision,
      approvalMode: "always", expectedRevision: 0, operationId: "catalog-grant" });
    await backend.commitPluginMcpConsent({ challenge: allow.challenge, approved: true });
    const selection = [{ installationId, revision: enabled.installation.revision }];
    const preparedParams = operationId => ({ subject, operationId, requiredAdapterId: "shoggoth_shared_capabilities",
      adapterGeneration: "fixture-current-generation", pluginSelection: selection });
    const before = authority(bindingId, echo.toolIdentity), firstLists = traffic("tools/list");
    controlWrite({ hold: true }); await restart();
    await wait(() => traffic("tools/list") === firstLists + 1, "actual automatic startup discovery");
    assert.equal(service.pluginCatalogRestorer.getState().running, 1);
    const preparedPromise = backend.prepareExternalPluginSelection(preparedParams("catalog-restored-turn"));
    const toolsPromise = backend._call("plugins.mcp.tools.list", { profileId, bindingId });
    await sleep(50);
    assert.equal(await backend.getExternalPluginSelection({ subject, operationId: "catalog-restored-turn" }), null);
    assert.equal(service.pluginToolCatalogRegistry.listForBinding(service.pluginStore.getCapabilityRecords(bindingId, "projection")), null);
    assert.equal(traffic("tools/list"), firstLists + 1, "startup/read/selection must coalesce the actual tools/list");
    controlWrite({ hold: false }); const [prepared, restored] = await Promise.all([preparedPromise, toolsPromise]);
    assert.equal(restored.available, true); assert.equal(restored.items[0].savedGrant.matchesCurrentContract, true);
    assert.deepEqual(authority(bindingId, echo.toolIdentity), before);
    const identity = { ...subject, taskId: "catalog-task", turnId: "catalog-turn" };
    const bound = await privateRequest("plugin.external.selection.bind", { credentialToken: credential,
      envelope: prepared.envelope, identity }); assert.equal(bound.receipt.state, "bound");
    const toolIdentity = { ...identity, toolCallId: "catalog-call" };
    const lease = await privateRequest("plugin.external.open", { credentialToken: credential, identity: toolIdentity, selectionEnvelope: prepared.envelope });
    const result = await privateRequest("plugin.external.call", { token: lease.token, identity: toolIdentity,
      serverId: pluginServerId(bindingId), toolName: "echo", arguments: { value: "restored-local-echo" } });
    assert.equal(result.result.structuredContent.echoed, "restored-local-echo");
    await privateRequest("plugin.external.selection.finish", { credentialToken: credential, envelope: prepared.envelope, identity });
    const audit = (await backend.getPluginExternalCalls({ backendId: "hermes", cursor: null, limit: 20 })).items.find(row => row.toolCallId === "catalog-call");
    assert(audit); assert.equal(audit.status, "confirmed"); assert.equal(audit.bindingId, bindingId);
    // Schema drift is rediscovered, but an old Grant is never rewritten or
    // applied to a new contract. MCP-only selection and tool egress stay shut.
    const beforeDrift = authority(bindingId, echo.toolIdentity), businessCalls = traffic("tools/call");
    controlWrite({ drift: true }); await restart();
    const drift = await backend._call("plugins.mcp.tools.list", { profileId, bindingId });
    assert.equal(drift.available, true); assert.equal(drift.items[0].savedGrant.matchesCurrentContract, false);
    assert.deepEqual(authority(bindingId, echo.toolIdentity), beforeDrift);
    const replayLists = traffic("tools/list");
    const original = await backend.prepareExternalPluginSelection(preparedParams("catalog-restored-turn"));
    assert.deepEqual(original.envelope, prepared.envelope); assert.equal(original.receipt.state, "completed");
    await assert.rejects(backend.prepareExternalPluginSelection({ ...preparedParams("catalog-restored-turn"),
      pluginSelection: [{ ...selection[0], revision: selection[0].revision + 1 }] }), { code: "EXTERNAL_PLUGIN_SELECTION_CONFLICT" });
    assert.equal(traffic("tools/list"), replayLists, "known original observation/conflict cannot rediscover or remint");
    await assert.rejects(backend.prepareExternalPluginSelection(preparedParams("catalog-drift-selected")), { code: "PLUGIN_SELECTION_UNAVAILABLE" });
    const deniedIdentity = { ...subject, taskId: "drift-task", turnId: "drift-turn", toolCallId: "drift-call" };
    const deniedLease = await privateRequest("plugin.external.open", { credentialToken: credential, identity: deniedIdentity });
    await assert.rejects(privateRequest("plugin.external.call", { token: deniedLease.token, identity: deniedIdentity,
      serverId: pluginServerId(bindingId), toolName: "echo", arguments: { value: "blocked" } }), { code: "CAPABILITY_FORBIDDEN" });
    assert.equal(traffic("tools/call"), businessCalls);
    const grant = drift.items[0].savedGrant;
    await backend._call("plugins.mcp.grants.revoke", { profileId, bindingId, toolIdentity: echo.toolIdentity,
      expectedRevision: grant.revision, operationId: "catalog-revoke" });
    const deniedBefore = authority(bindingId, echo.toolIdentity), noGrantLists = traffic("tools/list");
    controlWrite({ drift: false }); await restart(); await sleep(100);
    assert.equal(service.pluginCatalogRestorer.getState().running, 0); assert.equal(traffic("tools/list"), noGrantLists);
    const deniedCatalog = await backend._call("plugins.mcp.tools.list", { profileId, bindingId });
    assert.equal(deniedCatalog.available, false);
    await assert.rejects(backend.prepareExternalPluginSelection(preparedParams("catalog-revoked-selected")), { code: "PLUGIN_SELECTION_UNAVAILABLE" });
    assert.equal(traffic("tools/list"), noGrantLists); assert.deepEqual(authority(bindingId, echo.toolIdentity), deniedBefore);
    console.log(JSON.stringify({ ok: true, actualServiceStartup: true, currentAuthorityUnchanged: true,
      startupSelectionReadCoalesced: true, noPublicationBeforeCheckpoint: true, restoredSelectedCall: true,
      exactConfirmedAudit: true, originalReceiptObservation: true, schemaDriftDenied: true, revokedNoDiscovery: true,
      localMcpBusinessCalls: businessCalls, noRemote: true, syntheticExecutionRequester: true }));
  } finally {
    controlWrite({ hold: false }); await service?.stop(); fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error("Catalog Service fixture stopped: " + error.message + " (" + (error.code || "UNKNOWN") + ")"); process.exitCode = 1; });
