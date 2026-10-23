#!/usr/bin/env node
"use strict";
// Unmodified pinned Codex app-server, production MCP helper, actual Product
// Service and durable UI tools. The model endpoint is our local Responses fixture.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), http = require("node:http"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { createAgentService } = require("../app/agent-service/server"), { resolveServicePaths } = require("../app/agent-service/paths");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host"), { CodexRuntimePool } = require("../app/agent-service/codex-runtime-pool");
const { resolveCodexRuntimeLayout, CODEX_APP_SERVER_ARGS } = require("../app/agent-service/codex-runtime-paths");
const { declaration } = require("./native-chat-ui-service-unit.cjs");
const DIRECT_API = process.argv.includes("--native-api");
const repo = path.resolve(__dirname, ".."), root = fs.realpathSync(fs.mkdtempSync("/tmp/sguiruntime-")); fs.chmodSync(root, 0o700);
const runtimeHome = path.join(root, "runtime-home"); fs.mkdirSync(runtimeHome, { mode: 0o700 });
const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
const safeStorage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => Buffer.from(b).toString() };
let service, host, stage = 0, serial = 0, session, profile; const nativeEvents = [], hosts = [], calls = [], bindings = [], discoveries = [], outputs = [];
const provider = http.createServer((req, res) => { console.log("LOCAL_HTTP_REQUEST",JSON.stringify({method:req.method,url:req.url})); const chunks = []; req.on("data", chunk => chunks.push(chunk)); req.on("end", () => {
  try {
    assert.equal(req.method, "POST"); assert.equal(req.url, "/v1/responses"); const body = JSON.parse(Buffer.concat(chunks));
    const flatten = (items, namespace) => items.flatMap(item => item.tools ? flatten(item.tools, item.name) : [{ ...item, ...(namespace ? { namespace } : {}) }]);
    const tools = flatten(body.tools || body.input.filter(i => i.type === "additional_tools").flatMap(i => i.tools));
    discoveries.push(tools.filter(t => /render_ui|update_ui|get_ui_state/.test(t.name || "")).map(t => t.name));
    const codeMode = tools.some(t => t.type === "custom" && t.name === "exec"), n = ++serial;
    const pubs = service.chatUiStore.publicationsForRecovery().filter(p => p.status === "ready"), latest = pubs.at(-1);
    let name, args;
    if (stage === 0) { name = "render_ui"; args = declaration(); }
    else if (stage === 1) { assert.equal(pubs.length, 1); name = "update_ui"; args = { ...declaration(), artifactId: latest.artifactId, expectedRevision: 1, updateNote: "实际 Runtime 发布第二版" }; }
    else if (stage === 2) { assert.equal(pubs.length, 2); name = "get_ui_state"; args = { artifactId: latest.artifactId, revision: 2 }; }
    outputs.push(...body.input.filter(i => ["function_call_output", "custom_tool_call_output"].includes(i.type)));
    const id = `ui-local-response-${n}`, tool = name && tools.find(t => t.name?.endsWith(name));
    if (name) assert(tool || codeMode, `actual Runtime has no ${name}`);
    const item = !name ? { id: `ui-message-${n}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "实际 Runtime 工具验收完成", annotations: [] }] }
      : codeMode ? { id: `ui-call-${n}`, type: "custom_tool_call", call_id: `ui-call-${n}`, name: "exec", namespace: "functions", input: `text(await tools.mcp__shoggoth__${name}(${JSON.stringify(args)}));` }
      : { id: `ui-call-${n}`, type: "function_call", call_id: `ui-call-${n}`, name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: JSON.stringify(args), status: "completed" };
    if (name) { calls.push(name); stage++; }
    res.writeHead(200, { "Content-Type": "text/event-stream" }); let sequence = 0;
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
    event("response.created", { response: { id, object: "response", status: "in_progress", output: [] } });
    event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress" } });
    event("response.output_item.done", { output_index: 0, item });
    event("response.completed", { response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end();
  } catch (error) { console.error(error); if (!res.headersSent) res.writeHead(500); res.end("local UI fixture failed"); }
}); });
provider.on("connection",()=>console.log("LOCAL_HTTP_CONNECTION"));
(async () => {
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const binary = process.env.SHOGGOTH_TEST_CODEX_BINARY || resolveCodexRuntimeLayout({ repoRoot: repo }).runtimePath;
  const environment = binding => Object.freeze({ runtime: "codex", runtimeAccountId: binding.runtimeAccountId, kind: "shoggoth-managed", installationKind: "bundled", homeKind: "managed-shared", strategy: "managed-shared", home: runtimeHome, nativeHome: null, integrationRoot: null, binaryPath: binary, launchArgs: Object.freeze([...CODEX_APP_SERVER_ARGS]), spawnEnv: Object.freeze({ HOME: root, CODEX_HOME: runtimeHome }), configurationMode: "overlay" });
  const pool = new CodexRuntimePool({ paths, parentEnv: { HOME: root, PATH: process.env.PATH, TMPDIR: root }, runtimeAccountResolver: { resolve: environment }, hostFactory(options) {
    // The local model route belongs to this fixture. Production MCP and
    // thread/turn binding remain real; no Provider credentials are prepared.
    host = new CodexRuntimeHost({ ...options, prepareRuntime: async () => ({ spawnEnv: {}, registeredSecrets: [], configArgs: [], runtimeConfig: { provider: { kind: "custom-responses" } } }), repoRoot: repo, cwd: root, parentEnv: { HOME: root, PATH: process.env.PATH, TMPDIR: root }, spawnProcess(command, args, spawnOptions) {
      assert.equal(spawnOptions.env.HOME, root); assert.equal(spawnOptions.env.CODEX_HOME, runtimeHome); const child = spawn(command, args, spawnOptions); child.stderr.on("data",chunk=>console.log("NATIVE_STDERR",String(chunk).slice(0,2500))); let buffered = "";
      child.stdout.on("data", chunk => { buffered += chunk; for (;;) { const end = buffered.indexOf("\n"); if (end < 0) break; const line = buffered.slice(0, end); buffered = buffered.slice(end + 1); try { const value = JSON.parse(line); if (value.params?._meta?.["shoggoth/runtime-call-binding"]) bindings.push(value); if(value.method === "warning" || value.method?.startsWith("item/")) console.log("NATIVE_NOTICE",JSON.stringify({method:value.method,message:value.method === "warning" ? value.params?.message : undefined,itemType:value.params?.item?.type})); } catch {} } }); return child;
    } }); host.subscribe(event => { nativeEvents.push({method:event.method,type:event.type,message:event.error?.message,code:event.error?.code,threadId:event.threadId}); }); hosts.push(host); return host;
  } });
  service = createAgentService({ paths, safeStorage, prewarmMcpAuth: false, runtimePool: pool, parentEnv: {}, version: "native-ui-runtime-acceptance" }); await service.start();
  service.chatUiConfig.apply({ revision: 1, config: { nativeChatUiV1: true } }); profile = service.productStore.listAgentProfiles().find(p => p.enabled);
  const helper = path.join(root, "helper.cjs"); fs.writeFileSync(helper, `const {startShoggothMcpHelper}=require(${JSON.stringify(path.join(repo,"app/shoggoth-mcp-helper.js"))});startShoggothMcpHelper({paths:${JSON.stringify(paths)},electronApp:{whenReady:async()=>{},quit(){}},runtimeProfileId:${JSON.stringify(profile.runtimeProfileId)},runtimeAccountId:${JSON.stringify(profile.runtimeAccountId)},safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>Buffer.from(b).toString()},serviceVersion:'fixture'}).catch(e=>{console.error(e.code);process.exitCode=1});`, { mode: 0o600 });
  fs.writeFileSync(path.join(runtimeHome, "config.toml"), `cli_auth_credentials_store = "file"\nmodel = "gpt-6.1-sol"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Owned local UI fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nsupports_websockets = false\n[mcp_servers.shoggoth]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(helper)}]\nstartup_timeout_sec = 15\ntool_timeout_sec = 20\nrequired = true\n`, { mode: 0o600 });
  const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace, { mode: 0o700 }); fs.writeFileSync(path.join(workspace,"card.html"), "<!doctype html><h1>实际 Codex Runtime 产物</h1>");
  session = service.chatSessionStore.createSession({ operationId: crypto.randomUUID(), profileId: profile.id, workspace, createdAt: Date.now() });
  console.log("PHASE actual-runtime-ready");
  const ack = await service.workRunCoordinator.send({ operationId: crypto.randomUUID(), sessionKey: session.sessionKey, prompt: "Local isolated UI contract qualification." });
  const events=[];service.workRunCoordinator.subscribeRun(ack.run.id,{streamId:null,afterSeq:0},event=>events.push(event));
  // The required MCP helper has a 15 s startup budget. A 10 s observer
  // deadline can reject a valid cold startup before that budget expires.
  const until=Date.now()+30000;
  while(Date.now()<until) {
    host=hosts.find(h=>h.runtimeProfileId===profile.runtimeProfileId&&h.runtimeAccountId===profile.runtimeAccountId&&h.state==="ready");
    if(host || ["failed", "canceled", "interrupted"].includes(service.workDispatcher.getRun(ack.run.id).status)) break;
    await new Promise(r=>setTimeout(r,25));
  }
  const admission = service.workDispatcher.getRun(ack.run.id);
  assert(host,JSON.stringify({ reason: "matching production Runtime host did not initialize",
    run: { id: admission.id, status: admission.status, errorCode: admission.errorCode, runtimeSessionRef: admission.runtimeSessionRef },
    hosts: hosts.map(value => ({ state: value.state, startupStage: value.startupStage, runtimeProfileId: value.runtimeProfileId, runtimeAccountId: value.runtimeAccountId })),
    nativeEvents }));
  const effective=await host.configRead({includeLayers:false});console.log("EFFECTIVE_ROUTE",JSON.stringify({model:effective.config?.model,provider:effective.config?.model_provider ?? effective.config?.modelProvider,servers:Object.keys(effective.config?.mcp_servers||{})}));
  const bindingDeadline=Date.now()+10000;let current;
  do { current=service.workDispatcher.getRun(ack.run.id);if(current.runtimeSessionRef)break;await new Promise(r=>setTimeout(r,25)); } while(Date.now()<bindingDeadline&&!["failed","canceled","completed","interrupted"].includes(current.status));
  assert(current.runtimeSessionRef,JSON.stringify({reason:"Runtime session not bound",run:current,hostState:host.state,hostStage:host.startupStage}));
  const catalog=await host.mcpServerStatusList({threadId:current.runtimeSessionRef.sessionId});console.log("MCP_CATALOG",JSON.stringify((catalog.data || []).map(row=>({name:row.name,status:row.runtimeStatus,uiNames:Object.keys(row.tools||{}).filter(k=>/render_ui|update_ui|get_ui_state/.test(k))}))));
  const models=await host.modelList({limit:3});console.log("NATIVE_MODELS",JSON.stringify(models.data.map(m=>({model:m.model,isDefault:m.isDefault}))));
  const nativeThread = await host.threadRead({threadId:current.runtimeSessionRef.sessionId,includeTurns:false});console.log("NATIVE_THREAD",JSON.stringify({provider:nativeThread.thread?.modelProvider,status:nativeThread.thread?.status}));
  if (DIRECT_API) {
    for (const name of ["render_ui", "update_ui", "get_ui_state"]) {
      const pub = service.chatUiStore.publicationsForRecovery().at(-1);
      const args = name === "render_ui" ? declaration() : name === "update_ui"
        ? { ...declaration(), artifactId: pub.artifactId, expectedRevision: 1, updateNote: "原生 API 发布第二版" }
        : { artifactId: pub.artifactId, revision: 2 };
      const result = await host.mcpServerToolCall({threadId:current.runtimeSessionRef.sessionId,server:"shoggoth",tool:name,arguments:args},{timeoutMs:15000});
      assert.equal(result.isError,false,JSON.stringify(result)); outputs.push(result); calls.push(name);
    }
  }
  const deadline = Date.now() + 30000;
  while (!DIRECT_API && !["completed", "failed", "canceled", "interrupted"].includes(service.workDispatcher.getRun(ack.run.id).status)) { if (Date.now() > deadline) throw Error(JSON.stringify({reason:"actual Runtime UI timeout",run:service.workDispatcher.getRun(ack.run.id),events:events.map(e=>({type:e.type,payload:e.type.startsWith("waiting")?e.payload:undefined})),calls,bindingCount:bindings.length,hostStage:host?.startupStage,nativeEvents})); await new Promise(resolve => setTimeout(resolve, 25)); }
  const run = service.workDispatcher.getRun(ack.run.id); if(!DIRECT_API)assert.equal(run.status, "completed", JSON.stringify(run)); assert.deepEqual(calls, ["render_ui", "update_ui", "get_ui_state"]); assert.equal(bindings.length, 3);
  assert(bindings.every(v => v.params.threadId === run.runtimeSessionRef.sessionId && v.params.turnId === run.runtimeTurnRef.turnId));
  const pubs = service.chatUiStore.publicationsForRecovery(); assert.equal(pubs.length, 2); assert.equal(pubs[0].artifactId, pubs[1].artifactId); assert.notEqual(pubs[0].sourceEventId, pubs[1].sourceEventId);
  const owner = { profileId: profile.id, sessionKey: session.sessionKey, transcriptSessionId: session.id }; assert.equal(service.chatUiStore.revision(owner, pubs[1].artifactId, 2).state.selected, "A");
  const text = JSON.stringify(outputs); assert(text.includes("ui_artifact")); assert(text.includes("stateRevision")); assert(!text.includes("mcp_session_invalid"));
  const evidence = { status: "passed", runtimeBinary: binary, nativeRuntime: "unmodified-bundled-Codex", provider: "owned-local-Responses-endpoint", invocation:DIRECT_API ? "native-mcpServer-tool-call-during-owned-turn" : "local-Responses-model-tool-call", modelDriven:!DIRECT_API, calls, trustedCallBindings: bindings.length, runId: run.id, runtimeRef: run.runtimeSessionRef, artifactId: pubs[0].artifactId, revisions: pubs.map(p => ({ revision: p.revision, sourceEventId: p.sourceEventId, publicationId: p.publicationId })), discoveredUiNames: [...new Set([...(catalog.data||[]).flatMap(row=>Object.keys(row.tools||{}).filter(k=>/render_ui|update_ui|get_ui_state/.test(k))),...discoveries.flat()])], runtimeVersion:host.runtimeVersion };
  const output = path.join(repo,DIRECT_API ? ".artifacts/native-chat-ui/runtime-native-api-acceptance.json" : ".artifacts/native-chat-ui/runtime-acceptance.json"); fs.writeFileSync(output, JSON.stringify(evidence,null,2)); console.log("PASS unmodified Codex UI tools through actual helper and Service", JSON.stringify(evidence));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { try { await service?.stop({ notify: false }); } finally { try { await host?.stop(); } finally { provider.closeAllConnections(); await new Promise(resolve=>provider.close(resolve)); fs.rmSync(root,{recursive:true,force:true}); } } });
