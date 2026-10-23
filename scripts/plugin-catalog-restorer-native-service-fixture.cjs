"use strict";

// Real Service + App-auth IPC + Native Coordinator/inbox/Run/transcript stores
// with the production Codex adapter over a local deterministic Runtime. The
// MCP child is real stdio; no provider, account or remote host IO occurs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService } = require("../app/agent-service/server");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { FakeHost } = require("./shoggoth-work-run-coordinator-unit.cjs");
const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
const { requestService } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { pluginServerId } = require("../app/agent-service/plugin-runtime-tool-service");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(predicate, label, timeout = 8000) { const deadline = Date.now() + timeout; while (!await predicate()) {
  if (Date.now() >= deadline) throw new Error(label + " timeout"); await sleep(20);
} }
const root = fs.mkdtempSync("/private/tmp/sgh-catalog-native-");
const paths = resolveServicePaths({ userDataRoot: path.join(root, "service"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
const control = path.join(root, "mcp-control.json"), trace = path.join(root, "mcp-requests.jsonl");
const state = { hold: false, drift: false };
const controlWrite = patch => { Object.assign(state, patch); fs.writeFileSync(control, JSON.stringify(state)); };
const traffic = method => fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse).filter(row => row.method === method).length : 0;
let service;
const backend = new ShoggothBackend({ paths });
const runtimeHosts = new Map();
const adapter = new CodexRuntimeAdapter({ runtimePool: {
  async get(binding) {
    if (!runtimeHosts.has(binding.runtimeProfileId)) {
      const host = new FakeHost([]);
      host.modelList = async () => ({ data: [{ model: service?.productStore.listAgentProfiles().find(row => row.enabled)?.defaultModel || "gpt-test", isDefault: true }], nextCursor: null });
      runtimeHosts.set(binding.runtimeProfileId, host);
    }
    return runtimeHosts.get(binding.runtimeProfileId);
  }, async stop() {}, async stopAll() {},
} });
const modelRequests = () => [...runtimeHosts.values()].reduce((sum, host) => sum + host.turnStartCalls, 0);
const runtimeFacts = async () => ({ installed: true, releaseEnabled: true, authenticated: true,
  models: [service?.productStore.listAgentProfiles().find(row => row.enabled)?.defaultModel || "gpt-test"], attachmentKinds: [], permissionEnforcementProven: true });
async function start() {
  service = createAgentService({ paths, prewarmMcpAuth: false, parentEnv: {}, version: "plugin-catalog-native-fixture",
    codexRuntimeAdapter: adapter, runtimeManager: adapter, runtimeSupportDiscover: runtimeFacts,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  await service.start(); assert(service.pluginCatalogRestorer);
  assert.equal(typeof service.workRunCoordinator.preparePluginSelection, "function");
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
    const createSession = operationId => backend._call("chat.session.create", { operationId, profileId, workspace: null, createdAt: Date.now() });
    const nativeSession = (await createSession("native-create-session")).session;
    const request = { operationId: "native-restored-concurrent", sessionKey: nativeSession.sessionKey,
      prompt: "Use the original selected local echo plugin", pluginSelection: selection, createdAt: Date.now() };
    const before = authority(bindingId, echo.toolIdentity), firstLists = traffic("tools/list");
    controlWrite({ hold: true }); await restart();
    await wait(() => traffic("tools/list") === firstLists + 1, "actual startup discovery pending");
    const anotherClient = new ShoggothBackend({ paths });
    const first = backend._call("chat.send", request), second = anotherClient._call("chat.send", structuredClone(request));
    await sleep(75);
    assert.equal(service.pendingCommandInbox.get(request.operationId), null);
    assert.equal(service.workDispatcher.listRuns().length, 0);
    assert.equal(modelRequests(), 0);
    assert.equal(traffic("tools/list"), firstLists + 1);
    assert.equal(service.pluginToolCatalogRegistry.listForBinding(service.pluginStore.getCapabilityRecords(bindingId, "projection")), null);
    controlWrite({ hold: false });
    const [firstReceipt, secondReceipt] = await Promise.all([first, second]);
    assert.equal(firstReceipt.run.id, secondReceipt.run.id);
    await service.workRunCoordinator.waitForIdle(firstReceipt.run.id);
    const run = service.workRunCoordinator.getRun(firstReceipt.run.id);
    assert.equal(run.status, "running", run.errorCode);
    assert.equal(service.workDispatcher.listRuns().length, 1); assert.equal(modelRequests(), 1);
    assert.deepEqual(authority(bindingId, echo.toolIdentity), before);
    const user = service.transcriptStore.listEvents(profileId, nativeSession.id).find(row => row.kind === "user");
    assert.deepEqual(user.content.pluginSelection, selection); assert.equal(user.content.text, request.prompt);
    assert.equal(user.content.pluginSelectionSnapshot[0].installationId, installationId);
    const host = runtimeHosts.get(run.runtimeSessionRef.runtimeProfileId);
    assert(JSON.stringify(host.lastTurnStartParams.input).includes(installationId), "actual local Runtime receives the Service-resolved selected plugin preference in turn context");
    const thread = host.threads.find(row => row.id === run.runtimeSessionRef.sessionId), turn = thread.turns.find(row => row.id === run.runtimeTurnRef.turnId);
    turn.status = "completed";
    turn.items.push({ type: "agentMessage", id: "native-local-result", text: "Selected local turn complete", phase: "final_answer" });
    host.emit({ known: true, type: "text", method: "item/completed", threadId: thread.id, turnId: turn.id,
      itemId: "native-local-result", text: "Selected local turn complete", phase: "final_answer" });
    host.emit({ known: true, type: "complete", method: "turn/completed", threadId: thread.id, turnId: turn.id, status: "completed" });
    await service.workRunCoordinator.waitForIdle(run.id);
    assert.equal(service.workRunCoordinator.getRun(run.id).status, "completed");
    const current = await backend._call("plugins.mcp.tools.list", { profileId, bindingId });
    const grant = current.items[0].savedGrant;
    await backend._call("plugins.mcp.grants.revoke", { profileId, bindingId, toolIdentity: echo.toolIdentity,
      expectedRevision: grant.revision, operationId: "native-revoke-after-complete" });
    const beforeReplay = traffic("tools/list");
    const replay = await anotherClient._call("chat.send", request);
    assert.equal(replay.disposition, "completed"); assert.equal(replay.run.id, run.id);
    const observed = await backend._call("chat.operation.get", { operationId: request.operationId, sessionKey: nativeSession.sessionKey });
    assert.equal(observed.status, "found"); assert.equal(observed.run.id, run.id);
    assert.equal(modelRequests(), 1); assert.equal(traffic("tools/list"), beforeReplay);
    await assert.rejects(backend._call("chat.send", { ...request, prompt: "Changed completed message" }), { code: "CHAT_OPERATION_ID_CONFLICT" });
    await assert.rejects(backend._call("chat.send", { ...request, operationId: "native-revoked-new-operation" }), { code: "PLUGIN_SELECTION_UNAVAILABLE" });
    assert.equal(service.workDispatcher.listRuns().length, 1); assert.equal(modelRequests(), 1);
    console.log(JSON.stringify({ ok: true, actualService: true, appAuthenticatedIpc: true, productionNativeCoordinator: true,
      realStdioDiscovery: true, noMintOrModelBeforeRecovery: true, twoClientsOneRun: true, currentGrantUnchanged: true,
      originalContextAndTranscript: true, completedReplayAfterRevokeNoRestore: true, changedMessageConflict: true,
      revokedNewOperationDenied: true, modelRequests: modelRequests(), noRemote: true, localDeterministicRuntime: true }));
  } finally {
    controlWrite({ hold: false }); await service?.stop(); fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error("Native catalog Service fixture stopped: " + error.message + " (" + (error.code || "UNKNOWN") + ")"); process.exitCode = 1; });
