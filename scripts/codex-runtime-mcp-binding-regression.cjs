#!/usr/bin/env node
"use strict";

// Actual pinned Codex app-server + production helper + Service IPC. All homes,
// encryption and Responses output belong to a disposable local fixture.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { resolveCanonicalServicePaths } = require("../app/agent-service/paths");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginComponentCatalog } = require("../app/agent-service/plugin-component-catalog");
const { PluginDependencyRegistry } = require("../app/agent-service/plugin-dependency-registry");
const { pluginServerId } = require("../app/agent-service/plugin-runtime-tool-service");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { CodexRuntimePool } = require("../app/agent-service/codex-runtime-pool");
const { resolveCodexRuntimeLayout, CODEX_APP_SERVER_ARGS } = require("../app/agent-service/codex-runtime-paths");

const repo = path.resolve(__dirname, "..");
const root = fs.realpathSync(fs.mkdtempSync("/tmp/sgcmb-"));
const candidate = process.argv.includes("--candidate");
const home = path.join(root, "codex");
fs.mkdirSync(home, { mode: 0o700 });
const paths = candidate ? resolveCanonicalServicePaths({ userInfo: () => ({ homedir: root }) })
  : resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
  profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
const safeStorage = { isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from(text).reverse(), decryptString: bytes => Buffer.from(bytes).reverse().toString() };
let service; let host; let serial = 0;
let pluginArguments;
const captures = [], bindings = [], results = [];
let firstRequests = [];
const provider = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", chunk => chunks.push(chunk));
  req.on("end", () => {
    if (req.method !== "POST" || req.url !== "/v1/responses") { res.writeHead(404); res.end(); return; }
    const body = JSON.parse(Buffer.concat(chunks)); captures.push(body);
    const response = () => {
      const completed = body.input.some(item => ["function_call_output", "custom_tool_call_output"].includes(item.type));
      const tools = body.tools || body.input.filter(item => item.type === "additional_tools").flatMap(item => item.tools);
      const flatten = (items, namespace) => items.flatMap(item => item.tools ? flatten(item.tools, item.name)
        : [{ ...item, ...(namespace ? { namespace } : {}) }]);
      const toolName = candidate ? "mcp_server_call" : "mcp_server_list";
      const toolArguments = candidate ? pluginArguments : {};
      const tool = flatten(tools).find(item => item.name?.endsWith(toolName));
      const codeMode = flatten(tools).some(item => item.type === "custom" && item.name === "exec");
      if (!tool && !codeMode) { res.writeHead(500); res.end("missing fixture tools"); return; }
      const n = ++serial, id = `fixture-response-${n}`;
      const item = completed ? { id: `msg-${n}`, type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "Fixture complete", annotations: [] }] }
        : codeMode ? { id: `fc-${n}`, type: "custom_tool_call", call_id: `fixture-call-${n}`,
          name: "exec", namespace: "functions", input: `text(await tools.mcp__shoggoth__${toolName}(${JSON.stringify(toolArguments)}));` }
          : { id: `fc-${n}`, type: "function_call", call_id: `fixture-call-${n}`, name: tool.name,
            ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: JSON.stringify(toolArguments), status: "completed" };
      if (completed) results.push(body.input.filter(item => ["function_call_output", "custom_tool_call_output"].includes(item.type)));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      let sequence = 0;
      const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
      event("response.created", { response: { id, object: "response", status: "in_progress", output: [] } });
      event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress" } });
      event("response.output_item.done", { output_index: 0, item });
      event("response.completed", { response: { id, object: "response", status: "completed", output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end();
    };
    // Prove three conversations reached the same native app-server concurrently.
    if (!body.input.some(item => ["function_call_output", "custom_tool_call_output"].includes(item.type)) && firstRequests.length < 3) {
      firstRequests.push(response);
      if (firstRequests.length === 3) for (const respond of firstRequests) respond();
    } else response();
  });
});

(async () => {
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const binary = resolveCodexRuntimeLayout({ repoRoot: repo }).runtimePath;
  const environment = binding => Object.freeze({ runtime: "codex", runtimeAccountId: binding.runtimeAccountId,
    kind: "shoggoth-managed", installationKind: "bundled", homeKind: "managed-shared", strategy: "managed-shared",
    home, nativeHome: null, integrationRoot: null, binaryPath: binary,
    launchArgs: Object.freeze([...CODEX_APP_SERVER_ARGS]), spawnEnv: Object.freeze({ HOME: root, CODEX_HOME: home }),
    configurationMode: "overlay" });
  const pool = new CodexRuntimePool({ paths, parentEnv: { HOME: root, PATH: process.env.PATH, TMPDIR: root },
    runtimeAccountResolver: { resolve: binding => environment(binding) },
    hostFactory(options) {
      host = new CodexRuntimeHost({ ...options, repoRoot: repo, cwd: root,
        parentEnv: { HOME: root, PATH: process.env.PATH, TMPDIR: root },
        spawnProcess(command, args, options) {
          assert.equal(options.env.HOME, root); assert.equal(options.env.CODEX_HOME, home);
          const child = spawn(command, args, options);
          // Record only internal proof metadata from this synthetic fixture.
          let buffered = "";
          child.stdout.on("data", chunk => { buffered += chunk.toString(); for (;;) {
            const end = buffered.indexOf("\n"); if (end < 0) break;
            const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
            try { const request = JSON.parse(line); if (request.params?._meta?.["shoggoth/runtime-call-binding"]) bindings.push(request); } catch {}
          } });
          return child;
        } });
      return host;
    } });
  service = createAgentService({ paths, safeStorage, prewarmMcpAuth: false, runtimePool: pool,
    parentEnv: {}, version: "codex-run-binding-fixture" });
  await service.start();
  const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
  if (candidate) {
    const installer = new PluginPackageInstaller({ store: service.pluginStore });
    const sourcePath = path.join(repo, "examples/plugins/local-notes");
    const preview = installer.preview(sourcePath);
    const installed = installer.install({ sourcePath, previewDigest: preview.contentDigest,
      expectedRevision: 0, operationId: "codex-plugin-install" });
    const component = new PluginComponentCatalog({ store: service.pluginStore }).list()[0].components
      .find(value => value.localName === "notes");
    const pin = { installationId: installed.installationId, releaseDigest: installed.releaseDigest,
      componentId: component.componentId, descriptorDigest: component.descriptorDigest };
    const dependencies = new PluginDependencyRegistry({ store: service.pluginStore });
    const dependency = dependencies.preview({ ...pin, executablePath: process.execPath });
    dependencies.prepare({ ...pin, executablePath: process.execPath, previewDigest: dependency.previewDigest,
      expectedRevision: 0, operationId: "codex-plugin-node", confirmed: true });
    const installation = service.pluginStore.setInstallationDesiredState({ installationId: installed.installationId,
      desiredState: "enabled", expectedRevision: installed.revision });
    const connect = await service.pluginMcpConsent.prepare({ action: "connect", profileId: profile.id,
      installationId: installed.installationId, componentId: component.componentId,
      expectedRevision: installation.revision, operationId: "codex-plugin-connect" });
    const connected = await service.pluginMcpConsent.commit({ challenge: connect.challenge, approved: true });
    const bindingId = connected.receipt.bindingId;
    const records = service.pluginStore.getCapabilityRecords(bindingId, "__projection__");
    const client = await service.pluginMcpConnectionManager.acquire(records);
    const catalog = await service.pluginToolCatalogRegistry.refresh({ ...records, client }); await client.release();
    const read = catalog.entries.find(value => value.downstreamName === "read_note");
    service.pluginStore.setGrant({ grantId: "codex-plugin-read", bindingId, toolIdentity: read.toolIdentity,
      contractDigest: read.contractDigest, effect: "allow", approvalMode: "always", expectedRevision: 0 });
    pluginArguments = { serverId: pluginServerId(bindingId), toolName: "read_note", arguments: {} };
  }
  const helper = path.join(root, "helper.cjs");
  fs.writeFileSync(helper, `"use strict";const {startShoggothMcpHelper}=require(${JSON.stringify(path.join(repo, "app/shoggoth-mcp-helper.js"))});
startShoggothMcpHelper({paths:${JSON.stringify(paths)},electronApp:{whenReady:async()=>{},quit(){}},runtimeProfileId:${JSON.stringify(profile.runtimeProfileId)},
runtimeAccountId:${JSON.stringify(profile.runtimeAccountId)},safeStorage:{isEncryptionAvailable:()=>true,
encryptString:s=>Buffer.from(s).reverse(),decryptString:b=>Buffer.from(b).reverse().toString()},serviceVersion:"fixture"})
.catch(e=>{console.error(e.code);process.exitCode=1});\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(home, "config.toml"), `model = "gpt-4.1"
model_provider = "fixture"
[model_providers.fixture]
name = "Local fixture"
base_url = "http://127.0.0.1:${provider.address().port}/v1"
wire_api = "responses"
supports_websockets = false
[mcp_servers.shoggoth]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(helper)}]
startup_timeout_sec = 15
tool_timeout_sec = 20
required = true
`, { mode: 0o600 });
  const sessions = ["one", "two", "three"].map(label => {
    const workspace = path.join(root, label); fs.mkdirSync(workspace, { mode: 0o700 });
    return service.chatSessionStore.createSession({ operationId: `create-${label}`,
      profileId: profile.id, workspace, createdAt: Date.now() });
  });
  const acks = await Promise.all(sessions.map((value, index) => service.workRunCoordinator.send({
    operationId: `send-${index}`, sessionKey: value.sessionKey, prompt: `Local fixture ${index}.` })));
  const runEvents = acks.map(() => []);
  acks.forEach((ack, index) => service.workRunCoordinator.subscribeRun(ack.run.id,
    { streamId: null, afterSeq: 0 }, event => runEvents[index].push(event)));
  const deadline = Date.now() + 30_000;
  while (acks.some(ack => !["completed", "failed", "canceled", "interrupted"].includes(service.workDispatcher.getRun(ack.run.id).status))) {
    if (Date.now() > deadline) throw new Error(`Run timeout: ${JSON.stringify(acks.map(ack => service.workDispatcher.getRun(ack.run.id)))}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  for (const ack of acks) assert.equal(service.workDispatcher.getRun(ack.run.id).status, "completed",
    JSON.stringify(service.workDispatcher.getRun(ack.run.id)));
  assert.equal(firstRequests.length, 3);
  assert.equal(bindings.length, 3, "real Codex forwards all helper binding elicitations");
  assert.equal(new Set(bindings.map(value => value.params.threadId)).size, 3);
  assert(bindings.every(value => typeof value.params.turnId === "string"));
  assert.equal(results.length, 3);
  assert(results.every(output => JSON.stringify(output).includes(candidate ? "shoggothPluginApp" : "servers")), JSON.stringify(results));
  assert(!JSON.stringify(results).includes("mcp_session_invalid"));
  if (candidate) {
    for (let index = 0; index < acks.length; index += 1) {
      const event = runEvents[index].find(value => value.type === "tool.result" && value.payload.tool?.pluginAppCallId);
      assert(event, "actual Codex native tool result must project App receipt to the UI stream");
      const callId = event.payload.tool.pluginAppCallId;
      assert.equal(service.pluginStore.getCapabilityCall(callId).phase, "result_confirmed");
      const prepared = service.pluginAppController.prepare({ profileId: profile.id,
        conversationId: sessions[index].sessionKey, callId });
      assert.equal(prepared.summary.capability, "read_note");
      const opened = await service.pluginAppController.commit({ challenge: prepared.challenge, approved: true,
        hostOrigin: "http://127.0.0.1:18799", sandboxOrigin: "http://127.0.0.1:18800", sourceId: `codex-fixture-${index}` });
      assert.deepEqual(opened.descriptor.initialNotifications[0].params.arguments, {});
      assert.equal(opened.descriptor.initialNotifications[1].method, "ui/notifications/tool-result");
      assert(opened.descriptor.resource.byteLength > 0, "real stdio resources/read initializes the App");
    }
  }
  console.log(`PASS real bundled Codex + local Responses + production helper + Service: 3 concurrent thread/turn bindings and ${candidate ? "default local-notes read + App receipt" : "default product MCP calls"}`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { await service?.stop({ notify: false }); } finally {
    try { await host?.stop(); } finally {
      provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  if (!candidate && !process.exitCode) {
    const child = spawn(process.execPath, [__filename, "--candidate"], { stdio: "inherit" });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    if (code !== 0) process.exitCode = 1;
  }
});
