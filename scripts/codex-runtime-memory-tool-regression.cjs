#!/usr/bin/env node
"use strict";

// Real bundled Codex app-server, production MCP helper and Service socket.
// Only the Responses provider is local and scripted; all state is disposable.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const packaged = process.argv[2] === "--packaged-app";
if (process.argv.length !== (packaged ? 4 : 2)) {
  throw new Error("usage: codex-runtime-memory-tool-regression.cjs [--packaged-app /absolute/Shoggoth.app]");
}
let resourcesPath = null;
if (packaged) {
  if (!path.isAbsolute(process.argv[3]) || process.env.ELECTRON_RUN_AS_NODE !== "1") {
    throw new Error("--packaged-app requires an absolute App path and ELECTRON_RUN_AS_NODE=1");
  }
  const appPath = fs.realpathSync(process.argv[3]);
  const executable = path.join(appPath, "Contents", "MacOS", "Shoggoth");
  assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(executable),
    "the regression must execute under the selected packaged Electron binary");
  resourcesPath = path.join(appPath, "Contents", "Resources");
}
const repo = packaged ? path.join(resourcesPath, "app.asar") : path.resolve(__dirname, "..");
const appRoot = path.join(repo, "app");
const fromApp = relative => require(path.join(appRoot, relative));
const { createAgentService, PROTOCOL_VERSION } = fromApp("agent-service/server.js");
const { requestService, readClientToken } = fromApp("agent-service/client.js");
const { resolveServicePaths } = fromApp("agent-service/paths.js");
const { CodexRuntimeHost } = fromApp("agent-service/codex-runtime-host.js");
const { CodexRuntimePool } = fromApp("agent-service/codex-runtime-pool.js");
const { resolveCodexRuntimeLayout, CODEX_APP_SERVER_ARGS } = fromApp("agent-service/codex-runtime-paths.js");
const root = fs.realpathSync(fs.mkdtempSync("/tmp/sgcmm-"));
const home = path.join(root, "codex");
const workspace = path.join(root, "workspace");
fs.mkdirSync(home, { mode: 0o700 });
fs.mkdirSync(workspace, { mode: 0o700 });
const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
  profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
const safeStorage = { isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from(text).reverse(),
  decryptString: bytes => Buffer.from(bytes).reverse().toString() };
const stages = [];
const bindings = [];
let currentStage = null;
let serial = 0;
let service;
let host;

const provider = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", chunk => chunks.push(chunk));
  req.on("end", () => {
    if (req.method !== "POST" || req.url !== "/v1/responses" || !currentStage) {
      res.writeHead(404); res.end(); return;
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks));
      const outputs = body.input.filter(item => ["function_call_output", "custom_tool_call_output"].includes(item.type));
      const completed = currentStage.callId && outputs.some(item => item.call_id === currentStage.callId);
      const flatten = (items, namespace) => items.flatMap(item => item.tools
        ? flatten(item.tools, item.name) : [{ ...item, ...(namespace ? { namespace } : {}) }]);
      const tools = flatten(body.tools || body.input.filter(item => item.type === "additional_tools")
        .flatMap(item => item.tools));
      const codeMode = tools.some(item => item.type === "custom" && item.name === "exec");
      const direct = tools.find(item => item.name?.endsWith(currentStage.name));
      if (currentStage.kind !== "bootstrap" && !completed && !codeMode && !direct) {
        throw new Error(`${currentStage.name} is absent from native tools`);
      }
      if (completed) currentStage.outputs.push(outputs.filter(item => item.call_id === currentStage.callId));
      const n = ++serial, responseId = `fixture-response-${n}`;
      const callId = `fixture-call-${n}`;
      if (currentStage.kind !== "bootstrap" && !completed) currentStage.callId = callId;
      const item = currentStage.kind === "bootstrap" || completed
        ? { id: `msg-${n}`, type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "Fixture complete", annotations: [] }] }
        : codeMode
          ? { id: `fc-${n}`, type: "custom_tool_call", call_id: callId,
            name: "exec", namespace: "functions",
            input: `text(await tools.mcp__shoggoth__${currentStage.name}(${JSON.stringify(currentStage.args)}));` }
          : { id: `fc-${n}`, type: "function_call", call_id: callId,
            name: direct.name, ...(direct.namespace ? { namespace: direct.namespace } : {}),
            arguments: JSON.stringify(currentStage.args), status: "completed" };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      let sequence = 0;
      const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type,
        sequence_number: sequence++, ...data })}\n\n`);
      event("response.created", { response: { id: responseId, object: "response",
        status: "in_progress", output: [] } });
      event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress" } });
      event("response.output_item.done", { output_index: 0, item });
      event("response.completed", { response: { id: responseId, object: "response",
        status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end();
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
});

async function main() {
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const binary = resolveCodexRuntimeLayout({ repoRoot: repo, packaged, resourcesPath }).runtimePath;
  const environment = binding => Object.freeze({ runtime: "codex",
    runtimeAccountId: binding.runtimeAccountId, kind: "shoggoth-managed",
    installationKind: "bundled", homeKind: "managed-shared", strategy: "managed-shared",
    home, nativeHome: null, integrationRoot: null, binaryPath: binary,
    launchArgs: Object.freeze([...CODEX_APP_SERVER_ARGS]),
    spawnEnv: Object.freeze({ HOME: root, CODEX_HOME: home }), configurationMode: "overlay" });
  const pool = new CodexRuntimePool({ paths, repoRoot: repo, packaged, resourcesPath,
    parentEnv: { HOME: root, PATH: process.env.PATH, TMPDIR: root },
    runtimeAccountResolver: { resolve: binding => environment(binding) },
    hostFactory(options) {
      host = new CodexRuntimeHost({ ...options, repoRoot: repo, packaged, resourcesPath, cwd: root,
        parentEnv: { HOME: root, PATH: process.env.PATH, TMPDIR: root },
        spawnProcess(command, args, options) {
          assert.equal(options.env.HOME, root);
          assert.equal(options.env.CODEX_HOME, home);
          const child = spawn(command, args, options);
          let buffered = "";
          child.stdout.on("data", chunk => {
            buffered += chunk.toString();
            for (;;) {
              const end = buffered.indexOf("\n");
              if (end < 0) break;
              const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
              try {
                const request = JSON.parse(line);
                if (request.params?._meta?.["shoggoth/runtime-call-binding"]) bindings.push(request);
              } catch {}
            }
          });
          return child;
        } });
      return host;
    } });
  service = createAgentService({ paths, safeStorage, prewarmMcpAuth: false,
    runtimePool: pool, parentEnv: {}, repoRoot: repo, packaged, resourcesPath,
    version: "codex-memory-tool-fixture" });
  await service.start();
  const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
  const helper = path.join(root, "helper.cjs");
  fs.writeFileSync(helper, `"use strict";const {startShoggothMcpHelper}=require(${JSON.stringify(path.join(appRoot, "shoggoth-mcp-helper.js"))});
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
${packaged ? '[mcp_servers.shoggoth.env]\nELECTRON_RUN_AS_NODE = "1"\n' : ''}
`, { mode: 0o600 });

  const ipc = (method, params) => requestService(paths, { id: crypto.randomUUID(),
    token: readClientToken(paths), version: PROTOCOL_VERSION, method, params });
  const waitRun = async (runId, label) => {
    const deadline = Date.now() + 30_000;
    let run;
    do {
      run = service.workDispatcher.getRun(runId);
      if (["completed", "failed", "canceled", "interrupted"].includes(run.status)) break;
      if (Date.now() > deadline) throw new Error(`${label} Run timed out: ${JSON.stringify(run)}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (true);
    assert.equal(run.status, "completed", `${label} Run failed: ${JSON.stringify(run)}`);
    return run;
  };
  const runStage = async (name, args, prompt, origin = null) => {
    const session = origin?.session || service.chatSessionStore.createSession({
      operationId: `create-${stages.length}`, profileId: profile.id, workspace, createdAt: Date.now() });
    currentStage = { kind: "tool", name, args: { source: origin ? "inspiration" : "chat",
      sourceId: origin?.idea.id || session.sessionKey, ...args }, outputs: [], callId: null };
    stages.push(currentStage);
    const operationId = `send-${stages.length}`;
    const ack = origin
      ? await ipc("chat.send", { operationId, sessionKey: session.sessionKey,
        prompt, createdAt: Date.now() })
      : await service.workRunCoordinator.send({ operationId, sessionKey: session.sessionKey, prompt });
    const run = await waitRun(ack.run.id, name);
    if (origin) {
      const execution = service.inspirationStore.executionForRun(run.id);
      assert.equal(run.source, "inspiration");
      assert.equal(run.sourceId, origin.idea.id);
      assert.equal(execution?.sessionKey, session.sessionKey);
      assert.equal(execution.inputSource, "chat");
    }
    assert.equal(currentStage.outputs.length, 1, `${name} tool output missing`);
    const output = JSON.stringify(currentStage.outputs[0]);
    assert.equal(currentStage.outputs[0].length, 1, `${name} produced unexpected tool outputs`);
    const outputText = currentStage.outputs[0][0].output;
    assert.equal(typeof outputText, "string", `${name} tool output is not text`);
    const marker = "\nOutput:\n";
    const offset = outputText.lastIndexOf(marker);
    const toolResult = JSON.parse(offset < 0 ? outputText : outputText.slice(offset + marker.length));
    const user = service.transcriptStore.listEvents(profile.id, session.id)
      .find(event => event.runId === run.id && event.kind === "user");
    assert.ok(user, `${name} lacks a durable direct-user source`);
    return { session, run, user, output, toolResult };
  };
  const startInspiration = async () => {
    currentStage = { kind: "bootstrap", outputs: [], callId: null };
    const ordinal = stages.length;
    const { idea } = await ipc("inspiration.create", { operationId: `idea-create-${ordinal}`,
      body: "本地测试会话。请只回复已准备。" });
    const started = await ipc("inspiration.start", { id: idea.id,
      operationId: `idea-start-${ordinal}`, expectedRevision: idea.revision,
      agentId: profile.agentId, backendId: profile.backendId, workspace,
      instruction: "请只回复已准备。" });
    const execution = started.idea.latestExecution;
    assert.ok(execution?.runId && execution.sessionKey);
    const run = await waitRun(execution.runId, "inspiration bootstrap");
    const session = service.chatSessionStore.getSession(execution.sessionKey);
    const stored = service.inspirationStore.executionForRun(run.id);
    assert.equal(run.source, "inspiration");
    assert.equal(run.sourceId, idea.id);
    assert.equal(stored?.inputSource === "chat", false);
    assert.equal(session?.status, "ready");
    return { idea, session };
  };
  const warmIndex = async () => {
    const deadline = Date.now() + 10_000;
    while (service.conversationRecallService.prebuildProfile(profile.id) === "rebuilding") {
      await service.conversationRecallService.whenIndexReady(profile.id);
      if (Date.now() > deadline) throw new Error("conversation index did not settle");
    }
  };
  const marker = `SGMEM${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  const quote = `我喜欢代号 ${marker} 的蓝色番茄计划`;
  const saved = await runStage("memory_save", { expectedRevision: service.memoryStore.getRevision(profile.id),
    content: `用户偏好代号 ${marker} 的蓝色番茄计划`, scope: "user",
    classification: "explicit", sourceQuote: quote }, `${quote}。`);
  assert.equal(saved.toolResult.saved, true, saved.output);
  const memory = service.memoryStore.list(profile.id, { status: "active" })
    .find(item => item.content.includes(marker));
  assert.ok(memory && memory.id === saved.toolResult.item.id && memory.sourceRefs.includes(saved.user.id));
  assert.equal(service.memoryProvenanceService.explain({ profileId: profile.id,
    id: memory.id, viewer: "user" }).evidence.status, "verified_quote");

  await warmIndex();
  const searchArgs = { sessionId: saved.session.id, query: "蓝色番茄", limit: 10 };
  const searched = await runStage("conversation_search", searchArgs, "请检索我上一段对话的蓝色番茄原话。");
  assert.equal(searched.toolResult.status, "ready", searched.output);
  assert.ok(searched.toolResult.results.some(item => item.sessionId === saved.session.id
    && item.eventId === saved.user.id && item.kind === "user" && item.snippet.includes(marker)),
  searched.output);
  const found = await runStage("conversation_get", { sessionId: saved.session.id,
    eventId: saved.user.id, window: 0 }, "请精确读取上一段对话的原话。");
  assert.deepEqual(found.toolResult.events.map(item => item.text), [`${quote}。`]);

  const forgetQuote = `请忘记代号 ${marker} 的蓝色番茄偏好`;
  const forgotten = await runStage("memory_forget", { id: memory.id,
    expectedRevision: service.memoryStore.getRevision(profile.id), sourceQuote: forgetQuote },
  `${forgetQuote}。`);
  assert.equal(forgotten.toolResult.item.status, "deleted", forgotten.output);
  assert.equal(forgotten.toolResult.saved, false);
  assert.equal(service.memoryStore.get(profile.id, memory.id).status, "deleted");
  assert.equal(service.memoryEngine.recallPolicy.getMemoryReason(profile.id,
    service.memoryStore.get(profile.id, memory.id)), "forgotten");

  await warmIndex();
  const hidden = await runStage("conversation_search", searchArgs, "请复查已忘记的旧原话。");
  assert.equal(hidden.toolResult.status, "ready", hidden.output);
  assert.deepEqual(hidden.toolResult.results, [], hidden.output);
  const denied = await runStage("conversation_get", { sessionId: saved.session.id,
    eventId: saved.user.id, window: 0 }, "请尝试读取已忘记的旧原话。");
  assert.equal(denied.toolResult.error?.code, "MCP_TOOL_NOT_FOUND", denied.output);

  const inspirationFirst = await startInspiration();
  const inspirationMarker = `SGINSP${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  const inspirationQuote = `我喜欢代号 ${inspirationMarker} 的蓝色番茄计划`;
  const inspirationSaved = await runStage("memory_save", {
    expectedRevision: service.memoryStore.getRevision(profile.id),
    content: `用户偏好代号 ${inspirationMarker} 的蓝色番茄计划`,
    scope: "user", classification: "explicit", sourceQuote: inspirationQuote,
  }, `${inspirationQuote}。`, inspirationFirst);
  assert.equal(inspirationSaved.toolResult.saved, true, inspirationSaved.output);
  const inspirationMemory = service.memoryStore.get(profile.id, inspirationSaved.toolResult.item.id);
  assert.ok(inspirationMemory.sourceRefs.includes(inspirationSaved.user.id));
  assert.equal(service.memoryProvenanceService.explain({ profileId: profile.id,
    id: inspirationMemory.id, viewer: "user" }).evidence.status, "verified_quote");

  await warmIndex();
  const inspirationSecond = await startInspiration();
  assert.notEqual(inspirationSecond.session.id, inspirationFirst.session.id);
  const inspirationSearchArgs = { sessionId: inspirationFirst.session.id, query: "蓝色番茄", limit: 10 };
  const inspirationSearched = await runStage("conversation_search", inspirationSearchArgs,
    "请检索上一段灵感对话的蓝色番茄原话。", inspirationSecond);
  assert.equal(inspirationSearched.toolResult.status, "ready", inspirationSearched.output);
  assert.ok(inspirationSearched.toolResult.results.some(item =>
    item.sessionId === inspirationFirst.session.id && item.eventId === inspirationSaved.user.id
      && item.kind === "user" && item.snippet.includes(inspirationMarker)), inspirationSearched.output);
  const inspirationFound = await runStage("conversation_get", {
    sessionId: inspirationFirst.session.id, eventId: inspirationSaved.user.id, window: 0,
  }, "请精确读取上一段灵感对话的原话。", inspirationSecond);
  assert.deepEqual(inspirationFound.toolResult.events.map(item => item.text), [`${inspirationQuote}。`]);

  const correctedQuote = `我现在偏好代号 ${inspirationMarker} 的绿色番茄计划`;
  const corrected = await runStage("memory_save", {
    expectedRevision: service.memoryStore.getRevision(profile.id),
    content: `用户偏好代号 ${inspirationMarker} 的绿色番茄计划`,
    scope: "user", classification: "explicit", sourceQuote: correctedQuote,
    supersedes: inspirationMemory.id,
  }, `${correctedQuote}，旧的蓝色计划不再有效。`, inspirationSecond);
  assert.equal(corrected.toolResult.saved, true, corrected.output);
  const correctedMemory = service.memoryStore.get(profile.id, corrected.toolResult.item.id);
  assert.equal(correctedMemory.supersedes, inspirationMemory.id);
  assert.equal(service.memoryStore.get(profile.id, inspirationMemory.id).status, "superseded");

  const inspirationForgetQuote = `请忘记代号 ${inspirationMarker} 的绿色番茄偏好`;
  const inspirationForgotten = await runStage("memory_forget", {
    id: correctedMemory.id, expectedRevision: service.memoryStore.getRevision(profile.id),
    sourceQuote: inspirationForgetQuote,
  }, `${inspirationForgetQuote}。`, inspirationSecond);
  assert.equal(inspirationForgotten.toolResult.item.status, "deleted", inspirationForgotten.output);
  assert.equal(service.memoryEngine.recallPolicy.getMemoryReason(profile.id,
    service.memoryStore.get(profile.id, correctedMemory.id)), "forgotten");
  const audit = await ipc("harness.transcript.events", { profileId: profile.id,
    sessionId: inspirationSecond.session.id, cursor: 0, limit: 100 });
  assert.equal(audit.items.find(item => item.id === inspirationForgotten.user.id)
    ?.content?.text, `${inspirationForgetQuote}。`,
  "the authenticated user audit must retain the forget request");
  const forgetEcho = audit.items.find(item => item.runId === inspirationForgotten.run.id
    && item.kind === "assistant");
  assert.ok(forgetEcho, "the forget Run should have an assistant echo for suppression checks");

  await warmIndex();
  const inspirationThird = await startInspiration();
  assert.notEqual(inspirationThird.session.id, inspirationFirst.session.id);
  assert.notEqual(inspirationThird.session.id, inspirationSecond.session.id);
  const inspirationHidden = await runStage("conversation_search", inspirationSearchArgs,
    "请复查已忘记的旧灵感原话。", inspirationThird);
  assert.equal(inspirationHidden.toolResult.status, "ready", inspirationHidden.output);
  assert.deepEqual(inspirationHidden.toolResult.results, [], inspirationHidden.output);
  const inspirationDenied = await runStage("conversation_get", {
    sessionId: inspirationFirst.session.id, eventId: inspirationSaved.user.id, window: 0,
  }, "请尝试读取已忘记的旧灵感原话。", inspirationThird);
  assert.equal(inspirationDenied.toolResult.error?.code, "MCP_TOOL_NOT_FOUND", inspirationDenied.output);
  const correctedHidden = await runStage("conversation_search", {
    sessionId: inspirationSecond.session.id, query: "绿色番茄", limit: 10,
  }, "请复查已忘记的绿色番茄更正原话。", inspirationThird);
  assert.equal(correctedHidden.toolResult.status, "ready", correctedHidden.output);
  assert.deepEqual(correctedHidden.toolResult.results, [], correctedHidden.output);
  const correctedDenied = await runStage("conversation_get", {
    sessionId: inspirationSecond.session.id, eventId: corrected.user.id, window: 0,
  }, "请尝试读取已忘记的绿色番茄更正原话。", inspirationThird);
  assert.equal(correctedDenied.toolResult.error?.code, "MCP_TOOL_NOT_FOUND", correctedDenied.output);
  for (const eventId of [inspirationForgotten.user.id, forgetEcho.id]) {
    const forgetRunDenied = await runStage("conversation_get", {
      sessionId: inspirationSecond.session.id, eventId, window: 0,
    }, "请尝试读取已忘记的请求所在会话。", inspirationThird);
    assert.equal(forgetRunDenied.toolResult.error?.code, "MCP_TOOL_NOT_FOUND", forgetRunDenied.output);
  }

  assert.equal(bindings.length, stages.length, "every memory call must use a real native host binding");
  assert.deepEqual(bindings.map(item => item.params._meta["shoggoth/runtime-call-binding"].name),
    stages.map(item => item.name));
  console.log(`PASS ${packaged ? "packaged Electron/Codex" : "bundled Codex"} + local Responses + production MCP helper/Service: direct chat and Inspiration save/search/get/correct/forget with native Run bindings`);
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { await service?.stop({ notify: false }); } finally {
    try { await host?.stop(); } finally {
      provider.closeAllConnections();
      await new Promise(resolve => provider.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
