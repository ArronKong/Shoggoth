"use strict";

// Opt-in source-mode acceptance: one Service, one global plugin binding and
// real OpenClaw Gateway / Hermes Dashboard+CLI host processes. Both hosts use
// local deterministic models; only the fixed read-only MCP calls can reach
// the isolated GitHub repository. Never print a credential or MCP body.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { BackendRegistry } = require("../app/core/backend-registry");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { HermesBackend } = require("../app/core/hermes-backend");
const { createAuthResolver } = require("../app/core/device-auth");
const { createFederationHostServer } = require("../app/federation-host-server");
const { FederationHostClient } = require("../app/agent-service/federation-host-client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { ensureCredential } = require("../app/agent-service/external-plugin-adapter-auth");
const { pluginServerId } = require("../app/agent-service/plugin-runtime-tool-service");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { createFixture } = require("./plugin-real-host-service-fixture.cjs");
const { REPOSITORY, SEED, REQUIRED, launch, waitForConnection, withRun,
  grantTools, requireOperatorGate, resultContains, assertMcpSuccess,
} = require("./plugin-github-real-acceptance.cjs");

const PLUGIN_ID = "shoggoth-shared-capabilities";
const CALL = "shoggoth_plugin_call";
const READ = Object.freeze(["get_file_contents", "issue_read"]);
const WRITE = Object.freeze(["create_or_update_file", "add_issue_comment"]);
const MODEL = "shoggoth-three-real-host-probe";
const LOCAL_GATEWAY_TOKEN = "shoggoth-three-real-host-fixture-token";
const LOCAL_DASHBOARD_TOKEN = "shoggoth-three-real-host-dashboard-token";
const TIMEOUT_MS = 60_000;
const safeCodes = new Set(["BACKEND_UNAVAILABLE", "CAPABILITY_FORBIDDEN",
  "CONNECT_WAIT_TIMEOUT", "EXTERNAL_PLUGIN_LEASE_INVALID", "LIVE_TOOL_CONTRACT_MISMATCH",
  "MCP_AUTH_FAILED", "MCP_AUTH_REQUIRED", "MCP_RESULT_UNVERIFIED",
  "HOST_TIMEOUT", "OPERATOR_GATE_CLOSED", "OPERATOR_GATE_DENIED", "OPERATOR_STOPPED",
  "SERVICE_UNAVAILABLE", "TOOL_CONTRACT_CHANGED"]);

const repo = Object.freeze({ owner: REPOSITORY.owner, repo: REPOSITORY.repo });
function readArguments(name) {
  if (name === "get_file_contents") return { ...repo,
    path: "fixtures/input.txt", ref: REPOSITORY.branch };
  if (name === "issue_read") return { ...repo,
    method: "get", issue_number: REPOSITORY.issue };
  throw Object.assign(new Error(), { code: "READ_ONLY_TOOL_REQUIRED" });
}
function assertRead(name, result) {
  const checked = assertMcpSuccess({ result });
  if (name === "get_file_contents") {
    assert(resultContains(checked, SEED.fileLine) && resultContains(checked, SEED.initialValue));
  } else if (name === "issue_read") {
    assert(resultContains(checked, SEED.issueTitle) && resultContains(checked, SEED.issueBody));
  } else throw Object.assign(new Error(), { code: "READ_ONLY_TOOL_REQUIRED" });
}

function completion(tool) {
  return { id: "shoggoth-three-host-local", object: "chat.completion", created: 1,
    model: MODEL, choices: [{ index: 0,
      message: tool ? { role: "assistant", content: null,
        tool_calls: [{ id: `call_${tool.name}`, type: "function",
          function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
        : { role: "assistant", content: "Fixed read complete." },
      finish_reason: tool ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 16, completion_tokens: 8, total_tokens: 24 } };
}
function streamCompletion(response, tool) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const deltas = tool ? [
    { role: "assistant", tool_calls: [{ index: 0, id: `call_${tool.name}`,
      type: "function", function: { name: tool.name, arguments: "" } }] },
    { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(tool.args) } }] },
  ] : [{ role: "assistant", content: "Fixed read complete." }];
  for (const delta of deltas) response.write(`data: ${JSON.stringify({
    id: "shoggoth-three-host-local", object: "chat.completion.chunk", created: 1,
    model: MODEL, choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: "shoggoth-three-host-local",
    object: "chat.completion.chunk", created: 1, model: MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function operationFromMessages(messages, plan) {
  const text = JSON.stringify(messages || []);
  return plan.find(item => text.includes(`SHOGGOTH_FIXED_${item.marker}`));
}
async function startModelServer(mode, plan, serverId) {
  const state = { requests: 0, emitted: 0, sawRegisteredTool: false,
    verified: new Set() };
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end(); return;
    }
    let bodyBytes = 0;
    const chunks = [];
    for await (const chunk of request) {
      bodyBytes += chunk.length;
      if (bodyBytes > 1024 * 1024) { response.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { response.writeHead(400).end(); return; }
    state.requests += 1;
    state.sawRegisteredTool ||= (body.tools || []).some(item =>
      item.function?.name === (mode === "openclaw" ? CALL : "tool_call"));
    const operation = operationFromMessages(body.messages, plan);
    const prior = (body.messages || []).filter(item => item.role === "tool");
    if (operation && prior.length >= (mode === "hermes" ? 2 : 1)
      && operation.needles.every(needle => resultContains({
        structuredContent: prior, content: prior }, needle))) {
      state.verified.add(operation.marker);
    }
    let tool = null;
    if (operation && mode === "openclaw" && prior.length === 0) {
      tool = { name: CALL, args: { serverId, toolName: operation.name,
        arguments: operation.arguments } };
    } else if (operation && mode === "hermes" && prior.length === 0) {
      tool = { name: "tool_describe", args: { names: [CALL] } };
    } else if (operation && mode === "hermes" && prior.length === 1) {
      tool = { name: "tool_call", args: { calls: [{ name: CALL,
        arguments: { serverId, toolName: operation.name,
          arguments: operation.arguments } }] } };
    }
    if (tool?.name === CALL || (mode === "hermes" && tool?.name === "tool_call")) state.emitted += 1;
    if (body.stream) streamCompletion(response, tool);
    else response.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(completion(tool)));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { port: server.address().port, state, close: () => new Promise(resolve => server.close(resolve)) };
}

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
async function waitUntil(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Object.assign(new Error(), { code: "HOST_TIMEOUT" });
}
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let length = 0;
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs || TIMEOUT_MS);
    child.stdout.on("data", chunk => {
      length += chunk.length;
      if (length <= 256 * 1024) stdout += chunk;
      else child.kill("SIGTERM");
    });
    // Never surface host output: model results can contain repository content.
    child.stderr.resume();
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout }); });
  });
}
async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(resolve => child.once("close", resolve));
  try { process.kill(-child.pid, "SIGTERM"); }
  catch { child.kill("SIGTERM"); }
  await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch { child.kill("SIGKILL"); }
    await closed;
  }
}
function events(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function hostPlan(names, fixtureValue = null) {
  return names.map(name => {
    if (fixtureValue !== null) return { name, marker: "LOCAL_ECHO",
      arguments: { value: fixtureValue }, needles: [fixtureValue] };
    return { name, marker: name === "get_file_contents" ? "FILE" : "ISSUE",
      arguments: readArguments(name), needles: name === "get_file_contents"
        ? [SEED.fileLine, SEED.initialValue] : [SEED.issueTitle, SEED.issueBody] };
  });
}

async function startOpenClawHost(context, serverId, plan) {
  const root = path.join(context.root, "openclaw-host");
  const pluginDir = path.join(root, "plugin");
  const workspace = path.join(root, "workspace");
  const logFile = path.join(root, "events.jsonl");
  fs.mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const model = await startModelServer("openclaw", plan, serverId);
  const gatewayPort = await freePort();
  const adapterUrl = pathToFileURL(path.join(__dirname,
    "../resources/external-plugin-adapters/openclaw/index.mjs")).href;
  const clientPath = path.join(__dirname, "../app/agent-service/client.js");
  const authPath = path.join(__dirname, "../app/agent-service/external-plugin-adapter-auth.js");
  const servicePaths = { runtimeDir: context.paths.runtimeDir,
    socketPath: context.paths.socketPath, stateDir: context.paths.stateDir,
    trustedRoot: context.paths.trustedRoot };
  fs.writeFileSync(path.join(pluginDir, "package.json"), JSON.stringify({
    name: PLUGIN_ID, version: "0.0.0", private: true, type: "module",
    openclaw: { extensions: ["./index.mjs"] },
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), JSON.stringify({
    id: PLUGIN_ID, name: "Shoggoth Read Acceptance", version: "0.0.0",
    activation: { onStartup: true }, contracts: { tools: [CALL] },
    configSchema: { type: "object", additionalProperties: false, properties: {} },
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(pluginDir, "index.mjs"), `
import fs from "node:fs";
import { createRequire } from "node:module";
import { createAdapter } from ${JSON.stringify(adapterUrl)};
const require = createRequire(import.meta.url);
const { requestService } = require(${JSON.stringify(clientPath)});
const { readCredential } = require(${JSON.stringify(authPath)});
const paths = ${JSON.stringify(servicePaths)};
const logFile = ${JSON.stringify(logFile)};
function log(value) { fs.appendFileSync(logFile, JSON.stringify(value) + "\\n", { mode: 0o600 }); }
export default { id: ${JSON.stringify(PLUGIN_ID)}, name: "Shoggoth Read Acceptance",
  register(api) {
    const bridge = createAdapter({ instanceId: "openclaw-three-real-host-acceptance",
      credential: () => readCredential(paths, "openclaw"),
      requestService: async (method, params, options = {}) => {
        log({ phase: "service", method, identity: params.identity,
          toolName: method === "plugin.external.call" ? params.toolName : undefined });
        try {
          const result = await requestService(paths, {
            version: ${SERVICE_PROTOCOL_VERSION}, method, params,
          }, { timeoutMs: options.timeoutMs || 120000, signal: options.signal });
          log({ phase: "service-ok", method,
            toolName: method === "plugin.external.call" ? params.toolName : undefined });
          return result;
        } catch (error) {
          log({ phase: "service-error", method, code: error.code || "UNAVAILABLE" });
          throw error;
        }
      } });
    api.on("before_tool_call", (event, ctx) => {
      log({ phase: "hook", toolName: event.toolName, toolCallId: event.toolCallId,
        runId: event.runId, ctxRunId: ctx?.runId,
        agentId: ctx?.agentId, sessionId: ctx?.sessionId });
      return bridge.beforeToolCall(event, ctx);
    });
    api.registerTool(context => bridge.tool(${JSON.stringify(CALL)}, context),
      { name: ${JSON.stringify(CALL)} });
  } };
`, { mode: 0o600 });
  const configPath = path.join(root, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify({
    models: { mode: "replace", providers: { probe: {
      baseUrl: `http://127.0.0.1:${model.port}/v1`, apiKey: "fixture-only",
      api: "openai-completions", models: [{ id: MODEL, name: MODEL,
        reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_000, maxTokens: 1_024 }],
    } } },
    agents: { defaults: { model: { primary: `probe/${MODEL}` },
      workspace, skipBootstrap: true } },
    tools: { profile: "coding", alsoAllow: [CALL] },
    gateway: { mode: "local", port: gatewayPort, bind: "loopback",
      auth: { mode: "token", token: LOCAL_GATEWAY_TOKEN },
      controlUi: { enabled: true } },
    discovery: { mdns: { mode: "off" } },
    update: { checkOnStart: false },
    plugins: { load: { paths: [pluginDir] }, entries: {
      [PLUGIN_ID]: { enabled: true, hooks: { allowConversationAccess: true } },
    } },
  }), { mode: 0o600 });
  const env = { HOME: root, PATH: process.env.PATH || "/usr/bin:/bin",
    LANG: "en_US.UTF-8", TMPDIR: os.tmpdir(),
    USER: process.env.USER || "fixture", LOGNAME: process.env.LOGNAME || "fixture",
    OPENCLAW_STATE_DIR: path.join(root, "state"), OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_NO_AUTO_UPDATE: "1", OPENCLAW_DISABLE_BONJOUR: "1" };
  const bin = process.env.SHOGGOTH_TEST_OPENCLAW_BIN || "openclaw";
  let gateway;
  try {
    const listed = await run(bin, ["plugins", "list", "--json"], { cwd: workspace, env });
    assert.equal(listed.code, 0);
    assert(JSON.parse(listed.stdout).plugins?.some(item => item.id === PLUGIN_ID));
    gateway = spawn(bin, ["gateway", "run", "--port", String(gatewayPort),
      "--auth", "token", "--token", LOCAL_GATEWAY_TOKEN],
    { cwd: workspace, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    gateway.stdout.resume(); gateway.stderr.resume();
    await waitUntil(async () => {
      if (gateway.exitCode !== null) return false;
      const health = await run(bin, ["gateway", "call", "health", "--json",
        "--url", `ws://127.0.0.1:${gatewayPort}`, "--token", LOCAL_GATEWAY_TOKEN,
        "--timeout", "3000"], { cwd: workspace, env, timeoutMs: 6_000 });
      return health.code === 0;
    }, 30_000);
    const gatewayUrl = `ws://127.0.0.1:${gatewayPort}`;
    const authResolver = createAuthResolver({
      getConfig: () => ({ gatewayUrl, token: LOCAL_GATEWAY_TOKEN }),
      credentialsDir: path.join(root, "backend-credentials"),
      operatorIdentityDir: path.join(root, "unused-operator"),
      localGatewayConfigPath: configPath,
    });
    const backend = new OpenClawBackend({ getUpstreamUrl: () => gatewayUrl,
      getOrigin: () => "http://127.0.0.1", authResolver });
    return { backend, model, logFile,
      async invoke(item) {
        const before = events(logFile).filter(row => row.phase === "service-ok"
          && row.method === "plugin.external.call" && row.toolName === item.name).length;
        const response = await run(bin, ["gateway", "call", "chat.send", "--json",
          "--url", gatewayUrl, "--token", LOCAL_GATEWAY_TOKEN,
          "--params", JSON.stringify({
            sessionKey: `agent:main:shoggoth-three-${item.marker.toLowerCase()}`,
            message: `SHOGGOTH_FIXED_${item.marker}`,
            idempotencyKey: `shoggoth-three-real-${item.marker.toLowerCase()}`,
          })], { cwd: workspace, env });
        assert.equal(response.code, 0, "OpenClaw chat.send failed");
        const ack = JSON.parse(response.stdout);
        await waitUntil(() => events(logFile).filter(row => row.phase === "service-ok"
          && row.method === "plugin.external.call" && row.toolName === item.name).length > before
          && model.state.verified.has(item.marker), 40_000);
        return { runId: ack.runId };
      },
      async close() { await stopProcess(gateway); await model.close(); },
    };
  } catch (error) {
    await stopProcess(gateway);
    await model.close();
    throw error;
  }
}

async function startHermesHost(context, serverId, plan) {
  const root = path.join(context.root, "hermes-host");
  const hermesHome = path.join(root, "hermes");
  const pluginDir = path.join(hermesHome, "plugins", "shoggoth_shared_capabilities");
  const workspace = path.join(root, "workspace");
  const logFile = path.join(root, "events.jsonl");
  fs.mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const model = await startModelServer("hermes", plan, serverId);
  const dashboardPort = await freePort();
  const sourceDir = path.join(__dirname, "../resources/external-plugin-adapters/hermes");
  fs.copyFileSync(path.join(sourceDir, "plugin.yaml"), path.join(pluginDir, "plugin.yaml"));
  fs.writeFileSync(path.join(pluginDir, "__init__.py"), `
import importlib.util
import json
import pathlib
import sys

source = pathlib.Path(${JSON.stringify(path.join(sourceDir, "__init__.py"))})
spec = importlib.util.spec_from_file_location("_shoggoth_three_real_adapter", source,
    submodule_search_locations=[str(source.parent)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
log_file = pathlib.Path(${JSON.stringify(logFile)})
service_root = pathlib.Path(${JSON.stringify(context.paths.userDataRoot)})
module.request_service.__globals__["_root"] = lambda: service_root

def log(value):
    with log_file.open("a", encoding="utf-8") as output:
        output.write(json.dumps(value) + "\\n")

def request(method, params, **kwargs):
    log({"phase": "service", "method": method,
         "identity": params.get("identity"),
         "toolName": params.get("toolName") if method == "plugin.external.call" else None})
    try:
        result = module.request_service(method, params, **kwargs)
        log({"phase": "service-ok", "method": method,
             "toolName": params.get("toolName") if method == "plugin.external.call" else None})
        return result
    except Exception as exc:
        log({"phase": "service-error", "method": method,
             "code": getattr(exc, "code", "UNAVAILABLE")})
        raise

def register(ctx):
    bridge = module.Adapter(ctx.profile_name, request=request,
        credential=module.read_credential)
    def middleware(**kwargs):
        log({"phase": "middleware", "toolName": kwargs.get("tool_name"),
             "sessionId": kwargs.get("session_id"), "taskId": kwargs.get("task_id"),
             "turnId": kwargs.get("turn_id"), "toolCallId": kwargs.get("tool_call_id")})
        return bridge.middleware(**kwargs)
    ctx.register_middleware("tool_execution", middleware)
    ctx.register_hook("agent_loop_stopped", bridge.on_loop_stopped)
    for name in module.NAMES:
        ctx.register_tool(name=name, toolset="shoggoth_shared_capabilities",
            schema=module.SCHEMAS[name], handler=bridge.handler(name))
`, { mode: 0o600 });
  fs.writeFileSync(path.join(hermesHome, "config.yaml"),
    `model:\n  default: ${MODEL}\n  provider: custom\n  base_url: http://127.0.0.1:${model.port}/v1\n  api_key: fixture-only\n  api_mode: chat_completions\n  context_length: 128000\n`,
    { mode: 0o600 });
  const env = { HOME: root, HERMES_HOME: hermesHome,
    PATH: process.env.PATH || "/usr/bin:/bin", TMPDIR: os.tmpdir(),
    PYTHONDONTWRITEBYTECODE: "1", LANG: "en_US.UTF-8" };
  const bin = process.env.SHOGGOTH_TEST_HERMES_BIN || "hermes";
  let dashboard;
  try {
    const enabled = await run(bin, ["plugins", "enable", "shoggoth_shared_capabilities"],
      { cwd: workspace, env });
    assert.equal(enabled.code, 0, "Hermes plugin enable failed");
    dashboard = spawn(bin, ["dashboard", "--skip-build", "--no-open",
      "--isolated", "--port", String(dashboardPort)], {
      cwd: workspace, env: { ...env, HERMES_DASHBOARD_SESSION_TOKEN: LOCAL_DASHBOARD_TOKEN },
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    dashboard.stdout.resume(); dashboard.stderr.resume();
    await waitUntil(async () => {
      if (dashboard.exitCode !== null) return false;
      try {
        const response = await fetch(`http://127.0.0.1:${dashboardPort}/api/health`,
          { signal: AbortSignal.timeout(1_000) });
        return response.ok;
      } catch { return false; }
    }, 30_000);
    const backend = new HermesBackend({ getConfig: () => ({
      hermesMode: "remote", hermesRemotes: [{ profile: "default",
        baseUrl: `http://127.0.0.1:${dashboardPort}`,
        token: LOCAL_DASHBOARD_TOKEN }],
    }) });
    return { backend, model, logFile,
      async invoke(item) {
        const before = events(logFile).filter(row => row.phase === "service-ok"
          && row.method === "plugin.external.call" && row.toolName === item.name).length;
        const response = await run(bin, ["chat", "--oneshot", "-Q", "--ignore-rules",
          "--max-turns", "5", "--run-budget", "40", "--in", workspace,
          "-t", "shoggoth_shared_capabilities",
          "-q", `SHOGGOTH_FIXED_${item.marker}`], { cwd: workspace, env });
        assert.equal(response.code, 0, "Hermes chat run failed");
        await waitUntil(() => events(logFile).filter(row => row.phase === "service-ok"
          && row.method === "plugin.external.call" && row.toolName === item.name).length > before
          && model.state.verified.has(item.marker), 40_000);
      },
      async close() { await stopProcess(dashboard); await model.close(); },
    };
  } catch (error) {
    await stopProcess(dashboard);
    await model.close();
    throw error;
  }
}

async function startHosts(context, serverId, plan) {
  ensureCredential(context.paths, "openclaw");
  ensureCredential(context.paths, "hermes");
  let openclaw, hermes, hostRegistry, federation;
  try {
    openclaw = await startOpenClawHost(context, serverId, plan);
    hermes = await startHermesHost(context, serverId, plan);
    hostRegistry = new BackendRegistry();
    hostRegistry.register(openclaw.backend);
    hostRegistry.register(hermes.backend);
    const started = await hostRegistry.start();
    assert.equal(started.get("openclaw"), true, "real OpenClaw backend did not start");
    assert.equal(started.get("hermes"), true, "real Hermes backend did not start");
    federation = createFederationHostServer({ paths: context.paths, registry: hostRegistry });
    await federation.start();
    const client = new FederationHostClient({ paths: context.paths });
    const openclawAgent = (await client.request("agent.get", {
      backendId: "openclaw", agentId: "main" })).agent;
    const hermesAgent = (await client.request("agent.get", {
      backendId: "hermes", agentId: "hermes-default" })).agent;
    assert.equal(openclawAgent?.id, "main");
    assert.equal(openclawAgent?.backendId, "openclaw");
    assert.equal(hermesAgent?.id, "hermes-default");
    assert.equal(hermesAgent?.backendId, "hermes");
    assert.equal((await openclaw.backend.getAgent("main"))?.id, openclawAgent.id);
    assert.equal((await hermes.backend.getAgent("hermes-default"))?.id, hermesAgent.id);
    return { openclaw, hermes, agentIds: { openclaw: openclawAgent.id,
      hermes: hermesAgent.id },
    async close() {
      await federation.stop();
      await hostRegistry.stop();
      await hermes.close();
      await openclaw.close();
    } };
  } catch (error) {
    await federation?.stop().catch(() => {});
    await hostRegistry?.stop().catch(() => {});
    await hermes?.close().catch(() => {});
    await openclaw?.close().catch(() => {});
    throw error;
  }
}

function assertHostAudit(context, bindingId, plan, hosts) {
  const binding = context.service.pluginStore.getBinding(bindingId);
  const connection = context.service.pluginStore.getConnection(binding.connectionId);
  assert.equal(binding.subjectKind, "global");
  assert.equal(binding.enabled, true);
  assert.equal(connection.state, "ready");
  assert.equal(context.service.pluginStore.listGlobalBindings().length, 1);
  return context.backend.getPluginExternalCalls({ limit: 20 }).then(page => {
    const audited = page.items.filter(item => item.bindingId === bindingId);
    assert.equal(audited.length, plan.length * 2,
      "each real host must perform every fixed read exactly once");
    assert.equal(new Set(audited.map(row => `${row.backendId}\0${row.sessionId}`)).size,
      audited.length, "every audited business call must belong to a distinct host session");
    for (const [backendId, host] of [["openclaw", hosts.openclaw],
      ["hermes", hosts.hermes]]) {
      const rows = audited.filter(row => row.backendId === backendId);
      assert.deepEqual(new Set(rows.map(row => row.toolName)),
        new Set(plan.map(item => item.name)));
      const trace = events(host.logFile);
      assert.equal(trace.filter(row => row.phase === "service-error").length, 0);
      for (const row of rows) {
        assert.equal(row.connectionId, connection.connectionId);
        assert.equal(row.status, "confirmed");
        assert.equal(row.agentId, hosts.agentIds[backendId]);
        assert.match(row.resultDigest, /^[a-f0-9]{64}$/u);
        const service = trace.find(event => event.phase === "service"
          && event.method === "plugin.external.call"
          && event.toolName === row.toolName
          && event.identity?.backendId === row.backendId
          && event.identity?.sessionId === row.sessionId
          && event.identity?.toolCallId === row.toolCallId);
        assert(service, `${backendId} host-to-Service call identity missing`);
        for (const field of backendId === "openclaw"
          ? ["backendId", "instanceId", "agentId", "sessionId", "runId", "toolCallId"]
          : ["backendId", "instanceId", "agentId", "sessionId", "taskId", "turnId", "toolCallId"]) {
          assert.equal(service.identity[field], row[field],
            `${backendId} ${field} audit identity mismatch`);
        }
        if (backendId === "openclaw") {
          const hook = trace.find(event => event.phase === "hook"
            && event.toolName === CALL && event.toolCallId === row.toolCallId
            && event.sessionId === row.sessionId);
          assert(hook, "real OpenClaw before_tool_call hook missing");
          assert.equal(hook.agentId, row.agentId);
          assert([hook.runId, hook.ctxRunId].includes(row.runId));
        } else {
          const hook = trace.find(event => event.phase === "middleware"
            && event.toolName === CALL && event.toolCallId === row.toolCallId
            && event.sessionId === row.sessionId);
          assert(hook, "real Hermes tool_execution middleware missing");
          assert.equal(hook.taskId, row.taskId);
          assert.equal(hook.turnId, row.turnId);
        }
      }
      assert.equal(host.model.state.emitted, plan.length);
      assert.deepEqual(host.model.state.verified,
        new Set(plan.map(item => item.marker)));
      assert.equal(new Set(rows.map(row => row.sessionId)).size, plan.length,
        `${backendId} tool calls must belong to distinct real sessions`);
    }
    return audited.length;
  });
}

async function callNativeReads(context, bindingId, plan, verify) {
  await withRun(context, bindingId, async call => {
    for (const item of plan) verify(item.name, await call(item.name, item.arguments));
  });
}

async function runHostReads(context, bindingId, plan, hosts) {
  // All external requests go through real model -> host hook/middleware ->
  // production adapter -> one Service. The fake model supplies fixed args.
  const openclawAcks = new Map();
  for (const item of plan) {
    const ack = await hosts.openclaw.invoke(item);
    openclawAcks.set(item.name, ack.runId);
  }
  for (const item of plan) await hosts.hermes.invoke(item);
  const calls = await assertHostAudit(context, bindingId, plan, hosts);
  const openclawAudit = (await context.backend.getPluginExternalCalls({ limit: 20 })).items
    .filter(row => row.bindingId === bindingId && row.backendId === "openclaw");
  for (const row of openclawAudit) assert.equal(row.runId, openclawAcks.get(row.toolName),
    "OpenClaw Gateway acknowledgement and audited run differ");
  return { calls, agentGetVerified: true,
    openclawModelRequests: hosts.openclaw.model.state.requests,
    hermesModelRequests: hosts.hermes.model.state.requests };
}

async function runConcurrentLocalReads(context, bindingId, plan, hosts) {
  const replies = await Promise.all(plan.flatMap(item => [
    hosts.openclaw.invoke(item).then(ack => ({ backendId: "openclaw", runId: ack.runId })),
    hosts.hermes.invoke(item).then(() => ({ backendId: "hermes" })),
  ]));
  const calls = await assertHostAudit(context, bindingId, plan, hosts);
  const audited = (await context.backend.getPluginExternalCalls({ limit: 20 })).items
    .filter(row => row.bindingId === bindingId && row.backendId === "openclaw");
  assert.deepEqual(audited.map(row => row.runId).sort(),
    replies.filter(row => row.backendId === "openclaw").map(row => row.runId).sort(),
    "concurrent OpenClaw Gateway acknowledgements and audits must match");
  return { calls, agentGetVerified: true,
    openclawModelRequests: hosts.openclaw.model.state.requests,
    hermesModelRequests: hosts.hermes.model.state.requests };
}

async function revokeReadGrants(context, bindingId) {
  for (const name of READ) {
    const catalog = await context.backend.getPluginMcpTools(context.profile.agentId, bindingId);
    const tool = catalog.items.find(item => item.name === name);
    assert.equal(tool?.savedGrant?.effect, "allow");
    await context.backend.revokePluginMcpGrant({ agentId: context.profile.agentId,
      bindingId, toolIdentity: tool.toolIdentity,
      expectedRevision: tool.savedGrant.revision,
      operationId: `three-real-host-revoke-${name}-${crypto.randomUUID()}` });
  }
}

async function runSelfTest() {
  assert.deepEqual(new Set([...READ, ...WRITE]), new Set(REQUIRED));
  assert.throws(() => readArguments("add_issue_comment"),
    error => error.code === "READ_ONLY_TOOL_REQUIRED");
  assert.throws(() => readArguments("create_or_update_file"),
    error => error.code === "READ_ONLY_TOOL_REQUIRED");
  assert.deepEqual(hostPlan(READ).map(item => item.name), READ);
  const oldUmask = process.umask(0o077);
  let root;
  try { root = fs.realpathSync(fs.mkdtempSync(path.join("/private/tmp", "sg-three-real-host-"))); }
  finally { process.umask(oldUmask); }
  const fixture = createFixture(root, "openclaw", { externalPluginAgentVerifier: null });
  const report = { kind: "three-real-host-offline-self-test", stage: "startup",
    actualExternalCliModelRuns: false, remoteCalls: 0 };
  let hosts;
  try {
    const service = await fixture.start();
    const business = await fixture.installMcpTool();
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    assert(profile);
    const context = { root, paths: fixture.paths, service, profile,
      backend: new ShoggothBackend({ paths: fixture.paths }) };
    const plan = [
      { name: "echo", marker: "LOCAL_A",
        arguments: { value: "three-real-host-local-a" },
        needles: ["three-real-host-local-a"] },
      { name: "echo", marker: "LOCAL_B",
        arguments: { value: "three-real-host-local-b" },
        needles: ["three-real-host-local-b"] },
    ];
    report.stage = "real-host-identity";
    hosts = await startHosts(context, business.serverId, plan);
    report.stage = "native-read";
    await callNativeReads(context, business.bindingId, plan,
      (name, result) => {
        assert.equal(name, "echo");
        assert(["three-real-host-local-a", "three-real-host-local-b"]
          .includes(result.structuredContent?.echoed));
      });
    report.stage = "four-concurrent-real-host-reads";
    const results = await runConcurrentLocalReads(context, business.bindingId, plan, hosts);
    assert.equal(results.calls, 4);
    assert.equal(results.agentGetVerified, true);
    report.actualExternalCliModelRuns = true;
    report.federationAgentGetVerified = true;
    report.externalReadCallsAudited = results.calls;
    report.openclawModelRequests = results.openclawModelRequests;
    report.hermesModelRequests = results.hermesModelRequests;
    report.stage = "complete";
  } catch (error) {
    report.errorCode = safeCodes.has(error?.code) ? error.code : "SELF_TEST_ASSERTION_FAILED";
    // No provider account or remote MCP server is used in this mode.
    console.error("THREE_REAL_HOST_OFFLINE_DIAGNOSTIC", error?.stack || error?.code || "unknown");
    process.exitCode = 1;
  } finally {
    await hosts?.close().catch(() => { report.cleanup = "failed"; process.exitCode = 1; });
    await fixture.stop().catch(() => { report.cleanup = "failed"; process.exitCode = 1; });
    try { fs.rmSync(root, { recursive: true, force: true }); }
    catch { report.cleanup = "failed"; process.exitCode = 1; }
    console.log(`THREE_REAL_HOST_RESULT ${JSON.stringify(report)}`);
  }
}

async function runLive({ keepSession = false } = {}) {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let context, hosts;
  const report = { kind: "github-three-real-host-source-mode",
    repository: `${REPOSITORY.owner}/${REPOSITORY.repo}`, stage: "startup",
    actualExternalCliModelRuns: false, writeGrants: 0 };
  try {
    context = await launch({ live: true });
    console.log(`GITHUB_THREE_REAL_HOST_READY ${context.web.url}/#/plugins`);
    console.log("Connect the GitHub card in this temporary UI with the repository-scoped PAT. Never enter it in chat or terminal.");
    report.stage = "waiting-for-app-connection";
    const binding = await waitForConnection(context, abort.signal);
    report.verifiedGitHubPrincipal = true;
    report.stage = "read-only-discovery";
    await context.backend.discoverPluginMcpTools(context.profile.agentId, binding.bindingId);
    const catalog = await context.backend.getPluginMcpTools(context.profile.agentId,
      binding.bindingId);
    const operations = new Set((catalog.portableCapabilities || []).map(item => item.toolName));
    assert(REQUIRED.every(name => operations.has(name)), "GitHub live tool contract changed");
    assert(WRITE.every(name => catalog.items.some(item => item.name === name
      && !item.savedGrant)), "GitHub write tools must remain ungranted");
    await requireOperatorGate(`GRANT_READ_THREE_REAL_HOST ${REPOSITORY.owner}/${REPOSITORY.repo}`,
      abort.signal);
    await grantTools(context, binding, catalog, READ);
    const plan = hostPlan(READ);
    report.stage = "real-host-identity";
    hosts = await startHosts(context, pluginServerId(binding.bindingId), plan);
    report.stage = "native-read";
    await callNativeReads(context, binding.bindingId, plan, assertRead);
    report.nativeReadVerified = true;
    report.stage = "real-host-reads";
    const results = await runHostReads(context, binding.bindingId, plan, hosts);
    report.actualExternalCliModelRuns = true;
    report.federationAgentGetVerified = results.agentGetVerified;
    report.externalReadCallsAudited = results.calls;
    report.openclawModelRequests = results.openclawModelRequests;
    report.hermesModelRequests = results.hermesModelRequests;
    const after = await context.backend.getPluginMcpTools(context.profile.agentId,
      binding.bindingId);
    assert(WRITE.every(name => after.items.some(item => item.name === name
      && !item.savedGrant)), "GitHub write Grant appeared during read-only acceptance");
    report.stage = "revoke-read-grants";
    await revokeReadGrants(context, binding.bindingId);
    report.readGrantsRevoked = true;
    report.stage = "complete";
  } catch (error) {
    report.errorCode = safeCodes.has(error?.code) ? error.code : "ACCEPTANCE_ASSERTION_FAILED";
    process.exitCode = 1;
  } finally {
    if (hosts) {
      try { await hosts.close(); }
      catch { report.cleanup = "failed"; process.exitCode = 1; }
    }
    console.log(`GITHUB_THREE_REAL_HOST_RESULT ${JSON.stringify(report)}`);
    // Explicit source-workflow option: retain the same local UI, encrypted
    // Service and in-memory encryption key for subsequent acceptance checks.
    // It does not retry failed/unknown work or persist a plaintext PAT/key.
    if (keepSession && context && !abort.signal.aborted) {
      console.log(`GITHUB_ACCEPTANCE_SESSION_RETAINED ${context.web.url}/#/plugins`);
      console.log("The connection stays in this running Service; stop this process to clean its private temporary profile.");
      await new Promise(resolve => {
        if (abort.signal.aborted) resolve();
        else abort.signal.addEventListener("abort", resolve, { once: true });
      });
    }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (context) {
      try { await context.close(); }
      catch { report.cleanup = "failed"; process.exitCode = 1; }
    }
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const keepSession = args.length === 2 && args[0] === "--live" && args[1] === "--keep-session";
  if (!keepSession && (args.length !== 1 || !["--self-test", "--live"].includes(args[0]))) {
    console.error("Usage: node scripts/plugin-three-real-host-github-acceptance.cjs --self-test|--live [--keep-session]");
    process.exitCode = 2;
  } else void (args[0] === "--live" ? runLive({ keepSession }) : runSelfTest());
}

module.exports = { readArguments, assertRead, hostPlan };
