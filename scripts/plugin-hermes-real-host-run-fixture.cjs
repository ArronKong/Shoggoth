"use strict";

// Real Hermes tool/middleware run against a local fake model and isolated Home.
// The production Hermes socket transport is pointed at an isolated Service;
// only its canonical root lookup is patched inside the test plugin wrapper.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { WebSocket } = require("ws");
const { BackendRegistry } = require("../app/core/backend-registry");
const { HermesBackend } = require("../app/core/hermes-backend");
const { startProxyGateway } = require("../app/core/proxy-gateway");
const { createFixture, SKILL_ID } = require("./plugin-real-host-service-fixture.cjs");
const { createChatPageStopDriver } = require("./plugin-chatpage-stop-driver.cjs");

const TOOL = "shoggoth_capability_search";
const MODEL = "shoggoth-host-probe";

function nextTool(body, skillComponentId, business) {
  const prior = body.messages?.filter(item => item.role === "tool") || [];
  if (JSON.stringify(body.messages).includes("Shoggoth cancel probe")) {
    if (prior.length === 0) return { name: "tool_describe",
      args: { names: ["shoggoth_plugin_call"] } };
    if (prior.length === 1) return { name: "tool_call",
      args: { calls: [{ name: "shoggoth_plugin_call",
        arguments: { serverId: "plugin.fixture", toolName: "blocked", arguments: {} } }] } };
    return null;
  }
  if (JSON.stringify(body.messages).includes("Shoggoth business probe")) {
    if (prior.length === 0) return { name: "tool_describe",
      args: { names: ["shoggoth_plugin_call"] } };
    if (prior.length === 1) return { name: "tool_call",
      args: { calls: [{ name: "shoggoth_plugin_call",
        arguments: { serverId: business.serverId, toolName: business.toolName,
          arguments: { value: "host-business" } } }] } };
    return null;
  }
  if (prior.length === 0) return { name: "tool_describe", args: { names: [TOOL] } };
  if (prior.length === 1) return { name: "tool_call",
    args: { calls: [{ name: TOOL, arguments: { query: SKILL_ID } }] } };
  if (prior.length === 2) return { name: "tool_describe",
    args: { names: ["shoggoth_skill_read"] } };
  if (prior.length === 3) return { name: "tool_call",
    args: { calls: [{ name: "shoggoth_skill_read",
      arguments: { skillId: skillComponentId } }] } };
  return null;
}

function reply(tool) {
  return { id: "chatcmpl-shoggoth-hermes-probe", object: "chat.completion",
    created: 1, model: MODEL, choices: [{ index: 0,
      message: tool ? { role: "assistant", content: "",
        tool_calls: [{ id: `call_shoggoth_${tool.name}`, type: "function",
          function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
        : { role: "assistant", content: "Hermes host probe finished" },
      finish_reason: tool ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 16, completion_tokens: 8, total_tokens: 24 } };
}

function stream(response, tool) {
  response.writeHead(200, { "content-type": "text/event-stream",
    "cache-control": "no-cache" });
  const deltas = tool ? [
    { role: "assistant", tool_calls: [{ index: 0, id: `call_shoggoth_${tool.name}`,
      type: "function", function: { name: tool.name, arguments: "" } }] },
    { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(tool.args) } }] },
  ] : [{ role: "assistant", content: "Hermes host probe finished" }];
  for (const delta of deltas) response.write(`data: ${JSON.stringify({
    id: "chatcmpl-shoggoth-hermes-probe", object: "chat.completion.chunk",
    created: 1, model: MODEL, choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-shoggoth-hermes-probe",
    object: "chat.completion.chunk", created: 1, model: MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 50_000);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function within(promise, label, timeoutMs = 20_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

// Exercise the exact ChatPage transport contract over Shoggoth's proxy: one
// browser socket sends chat.send and later chat.abort with only sessionKey.
async function openProxyChatClient(url) {
  const socket = new WebSocket(url, { headers: { Origin: "http://127.0.0.1" } });
  const pending = new Map();
  const events = [];
  let sequence = 0;
  let connectSent = false;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const fail = error => {
    readyReject(error);
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.reject(error);
    }
  };
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error("Hermes proxy chat socket is closed")); return;
    }
    const id = `shoggoth-hermes-proxy-${++sequence}`;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ type: "req", id, method, params }));
  });
  socket.on("message", data => {
    const frame = JSON.parse(data.toString());
    if (frame.type === "event" && frame.event === "connect.challenge" && !connectSent) {
      connectSent = true;
      void request("connect").then(readyResolve, readyReject);
      return;
    }
    if (frame.type === "event") events.push(frame);
    if (frame.type !== "res") return;
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    if (frame.ok) entry.resolve(frame.payload);
    else entry.reject(new Error(`${frame.error?.code || "PROXY_ERROR"}: ${frame.error?.message || "unknown"}`));
  });
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("Hermes proxy chat socket closed")));
  try { await within(ready, "Hermes proxy browser connect", 10_000); }
  catch (error) { socket.close(); throw error; }
  return { request, events, close: () => socket.close() };
}

async function freeLoopbackPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function waitUntil(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("Hermes dashboard host fixture timed out");
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sghh-")));
  const fixture = createFixture(root, "hermes");
  const requests = [];
  let skillComponentId = null;
  let business = null;
  let canceledChild = null;
  let dashboard = null;
  let dashboardBackend = null;
  let proxy = null;
  let chatClient = null;
  let chatPageDriver = null;
  let stalledCall = null;
  const server = http.createServer(async (request, response) => {
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
      response.writeHead(404).end(); return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    const tool = nextTool(body, skillComponentId, business);
    if (body.stream) stream(response, tool);
    else response.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(reply(tool)));
  });
  try {
    await fixture.start();
    skillComponentId = fixture.install().componentId;
    business = await fixture.installMcpTool();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const hermesHome = path.join(root, "hermes");
    const pluginDir = path.join(hermesHome, "plugins", "shoggoth_shared_capabilities");
    const workspace = path.join(root, "workspace");
    const logFile = path.join(root, "host-events.jsonl");
    const sourceDir = path.join(__dirname, "../resources/external-plugin-adapters/hermes");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(workspace);
    fs.copyFileSync(path.join(sourceDir, "plugin.yaml"), path.join(pluginDir, "plugin.yaml"));
    fs.writeFileSync(path.join(pluginDir, "__init__.py"), `
import importlib.util
import json
import pathlib
import sys

source = pathlib.Path(${JSON.stringify(path.join(sourceDir, "__init__.py"))})
spec = importlib.util.spec_from_file_location("_shoggoth_fixture_adapter", source,
    submodule_search_locations=[str(source.parent)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
log_file = pathlib.Path(${JSON.stringify(logFile)})
service_root = pathlib.Path(${JSON.stringify(fixture.paths.userDataRoot)})
module.request_service.__globals__["_root"] = lambda: service_root

def log(value):
    with log_file.open("a", encoding="utf-8") as output:
        output.write(json.dumps(value) + "\\n")

def request(method, params, **kwargs):
    log({"phase": "service", "method": method, "identity": params.get("identity")})
    try:
        result = module.request_service(method, params, **kwargs)
        log({"phase": "service-result", "method": method,
             "result": {"opened": bool(result.get("token"))} if method == "plugin.external.open" else result})
        return result
    except Exception as exc:
        log({"phase": "service-error", "method": method,
             "code": getattr(exc, "code", "SHOGGOTH_ADAPTER_UNAVAILABLE")})
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
    def stopped(**kwargs):
        log({"phase": "stopped", "sessionKey": kwargs.get("session_key"),
             "reason": kwargs.get("reason")})
        bridge.on_loop_stopped(**kwargs)
    ctx.register_hook("agent_loop_stopped", stopped)
    for name in module.NAMES:
        ctx.register_tool(name=name, toolset="shoggoth_shared_capabilities",
            schema=module.SCHEMAS[name], handler=bridge.handler(name))
`);
    fs.writeFileSync(path.join(hermesHome, "config.yaml"), `model:\n  default: ${MODEL}\n  provider: custom\n  base_url: http://127.0.0.1:${server.address().port}/v1\n  api_key: fixture-only\n  api_mode: chat_completions\n  context_length: 128000\n`);
    const env = { HOME: root, HERMES_HOME: hermesHome,
      PATH: process.env.PATH || "/usr/bin:/bin", TMPDIR: os.tmpdir(),
      PYTHONDONTWRITEBYTECODE: "1", LANG: "en_US.UTF-8" };
    const bin = process.env.SHOGGOTH_TEST_HERMES_BIN || "hermes";
    const enabled = await run(bin, ["plugins", "enable", "shoggoth_shared_capabilities"],
      { cwd: workspace, env });
    assert.equal(enabled.code, 0, enabled.stderr);
    const listed = await run(bin, ["plugins", "list", "--plain", "--no-bundled"],
      { cwd: workspace, env });
    const results = await Promise.all(Array.from({ length: 4 }, (_, index) => run(bin,
      ["chat", "--oneshot", "-Q", "--ignore-rules", "--max-turns", "5",
        "--run-budget", "40", "--in", workspace, "-t", "shoggoth_shared_capabilities",
        "-q", `Call the Shoggoth search tool once. Session ${index}.`],
      { cwd: workspace, env })));
    const events = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    for (const result of results) {
      assert.equal(result.code, 0, `${result.stderr.slice(-3000)}; ${result.stdout.slice(-1500)}`);
    }
    assert.ok(requests.length >= 12,
      `model requests=${requests.length}; ${results.map(item => item.stderr.slice(-800)).join("\n")}`);
    const middleware = events.filter(item => item.phase === "middleware" && item.toolName === TOOL);
    const opened = events.filter(item => item.phase === "service" && item.method === "plugin.external.open");
    const searched = events.filter(item => item.phase === "service" && item.method === "plugin.external.search");
    assert.equal(middleware.length, 4,
      `events=${JSON.stringify(events)}; pluginList=${listed.stdout.slice(-1800)}; stderr=${results.map(item => item.stderr.slice(-1500)).join("\n")}`);
    assert.equal(opened.length, 8);
    assert.equal(searched.length, 4);
    const found = events.filter(item => item.phase === "service-result"
      && item.method === "plugin.external.search");
    assert.equal(found.length, 4);
    assert.ok(found.every(item => item.result.items.some(skill => skill.name === SKILL_ID)),
      `Service did not project installed Skill: ${JSON.stringify(found)}`);
    const reads = events.filter(item => item.phase === "service-result"
      && item.method === "plugin.external.skill.read");
    assert.equal(reads.length, 4, JSON.stringify(events));
    assert.ok(reads.every(item => item.result.content.includes("Host probe")));
    assert.equal(new Set(middleware.map(item => item.sessionId)).size, 4);
    for (const search of searched) {
      const open = opened.find(item => JSON.stringify(item.identity)
        === JSON.stringify(search.identity));
      const middle = middleware.find(item => item.sessionId === search.identity.sessionId);
      assert.ok(middle && open);
      assert.equal(open.identity.taskId, middle.taskId);
      assert.equal(open.identity.turnId, middle.turnId);
      assert.equal(open.identity.toolCallId, middle.toolCallId);
      assert.deepEqual(search.identity, open.identity);
    }
    const businessRun = await run(bin, ["chat", "--oneshot", "-Q", "--ignore-rules",
      "--max-turns", "5", "--run-budget", "40", "--in", workspace,
      "-t", "shoggoth_shared_capabilities", "-q", "Shoggoth business probe"],
    { cwd: workspace, env });
    assert.equal(businessRun.code, 0,
      `${businessRun.stderr.slice(-2000)}; ${businessRun.stdout.slice(-1000)}`);
    const businessResults = fs.readFileSync(logFile, "utf8").trim().split("\n")
      .filter(Boolean).map(JSON.parse).filter(item => item.phase === "service-result"
        && item.method === "plugin.external.call");
    assert.equal(businessResults.length, 1, JSON.stringify(businessResults));
    assert.equal(businessResults[0].result.result.structuredContent.echoed, "host-business");
    const businessIdentity = fs.readFileSync(logFile, "utf8").trim().split("\n")
      .filter(Boolean).map(JSON.parse).find(item => item.phase === "service"
        && item.method === "plugin.external.call")?.identity;
    assert(businessIdentity);
    const auditedBusiness = (await fixture.listAuditedCalls("hermes")).items.find(row =>
      row.sessionId === businessIdentity.sessionId
        && row.taskId === businessIdentity.taskId
        && row.turnId === businessIdentity.turnId
        && row.toolCallId === businessIdentity.toolCallId);
    assert(auditedBusiness);
    assert.equal(auditedBusiness.backendId, "hermes");
    assert.equal(auditedBusiness.instanceId, businessIdentity.instanceId);
    assert.equal(auditedBusiness.agentId, businessIdentity.agentId);
    assert.equal(auditedBusiness.bindingId, business.bindingId);
    assert.equal(auditedBusiness.installationId, business.installationId);
    assert.equal(auditedBusiness.toolIdentity, business.toolIdentity);
    assert.equal(auditedBusiness.status, "confirmed");
    assert.match(auditedBusiness.resultDigest, /^[a-f0-9]{64}$/u);
    await business.requireEachCall();
    const approvedRun = run(bin, ["chat", "--oneshot", "-Q", "--ignore-rules",
      "--max-turns", "5", "--run-budget", "40", "--in", workspace,
      "-t", "shoggoth_shared_capabilities", "-q", "Shoggoth business probe, approve once."],
    { cwd: workspace, env });
    await waitUntil(async () => (await fixture.listPendingApprovals("hermes")).items.length === 1,
      30_000);
    const pendingApproval = (await fixture.listPendingApprovals("hermes")).items[0];
    assert.equal(pendingApproval.backendId, "hermes");
    assert.equal(pendingApproval.toolName, business.toolName);
    assert.equal((await fixture.respondApproval(pendingApproval.requestId, true)).approved, true);
    const approvedResult = await approvedRun;
    assert.equal(approvedResult.code, 0,
      `${approvedResult.stderr.slice(-2000)}; ${approvedResult.stdout.slice(-1000)}`);
    const approvedAudit = (await fixture.listAuditedCalls("hermes")).items.find(row =>
      row.sessionId === pendingApproval.sessionId && row.toolCallId === pendingApproval.toolCallId);
    assert.equal(approvedAudit?.status, "confirmed");
    await business.revoke();
    const deniedBusiness = await run(bin, ["chat", "--oneshot", "-Q", "--ignore-rules",
      "--max-turns", "5", "--run-budget", "40", "--in", workspace,
      "-t", "shoggoth_shared_capabilities", "-q", "Shoggoth business probe, revoked."],
    { cwd: workspace, env });
    assert.equal(deniedBusiness.code, 0,
      `${deniedBusiness.stderr.slice(-2000)}; ${deniedBusiness.stdout.slice(-1000)}`);
    const deniedCalls = fs.readFileSync(logFile, "utf8").trim().split("\n")
      .filter(Boolean).map(JSON.parse).filter(item => item.phase === "service-error"
        && item.method === "plugin.external.call");
    assert.deepEqual(deniedCalls.map(item => item.code), ["CAPABILITY_FORBIDDEN"]);
    await fixture.restart();
    const persistedBusiness = (await fixture.listAuditedCalls("hermes")).items.find(row =>
      row.callId === auditedBusiness.callId);
    assert.deepEqual(persistedBusiness, auditedBusiness);
    const resumed = await run(bin, ["chat", "--oneshot", "-Q", "--ignore-rules",
      "--max-turns", "5", "--run-budget", "40", "--in", workspace,
      "-t", "shoggoth_shared_capabilities",
      "-q", "Call the Shoggoth search tool once. Restart session."],
    { cwd: workspace, env });
    assert.equal(resumed.code, 0, `${resumed.stderr.slice(-2000)}; ${resumed.stdout.slice(-1000)}`);
    fixture.disable();
    const disabled = await run(bin, ["chat", "--oneshot", "-Q", "--ignore-rules",
      "--max-turns", "5", "--run-budget", "40", "--in", workspace,
      "-t", "shoggoth_shared_capabilities",
      "-q", "Call the Shoggoth search tool once. Disabled session."],
    { cwd: workspace, env });
    assert.equal(disabled.code, 0, `${disabled.stderr.slice(-2000)}; ${disabled.stdout.slice(-1000)}`);
    const finalResults = fs.readFileSync(logFile, "utf8").trim().split("\n")
      .filter(Boolean).map(JSON.parse).filter(item => item.phase === "service-result"
        && item.method === "plugin.external.search");
    assert.equal(finalResults.length, 6, JSON.stringify(finalResults));
    assert.ok(finalResults[4].result.items.some(item => item.name === SKILL_ID));
    assert.equal(finalResults[5].result.total, 0);
    const finalEvents = fs.readFileSync(logFile, "utf8").trim().split("\n")
      .filter(Boolean).map(JSON.parse);
    const finalReads = finalEvents.filter(item => item.phase === "service-result"
      && item.method === "plugin.external.skill.read");
    assert.equal(finalReads.length, 5, JSON.stringify(finalEvents.slice(-12)));
    assert.equal(finalEvents.filter(item => item.phase === "service"
      && item.method === "plugin.external.skill.read").length, 6);
    assert.deepEqual(finalEvents.filter(item => item.phase === "service-error"
      && item.method === "plugin.external.skill.read").map(item => item.code),
    ["CAPABILITY_FORBIDDEN"]);
    stalledCall = fixture.stallNextCall();
    canceledChild = spawn(bin, ["chat", "--oneshot", "-Q", "--ignore-rules",
      "--max-turns", "5", "--run-budget", "40", "--in", workspace,
      "-t", "shoggoth_shared_capabilities", "-q", "Shoggoth cancel probe"],
    { cwd: workspace, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const childExited = new Promise(resolve => canceledChild.once("exit", (code, signal) =>
      resolve({ code, signal })));
    canceledChild.stdout.resume();
    canceledChild.stderr.resume();
    const entered = await within(stalledCall.entered, "Hermes Service call");
    assert.equal(entered.identity.backendId, "hermes");
    process.kill(-canceledChild.pid, "SIGKILL");
    const exited = await within(childExited, "Hermes child exit");
    assert.equal(exited.signal, "SIGKILL");
    const canceled = await within(stalledCall.canceled, "Hermes Service cancel");
    assert.deepEqual(canceled.params.identity, entered.identity);
    assert.equal(canceled.errorCode, null);
    stalledCall.release();
    stalledCall = null;
    canceledChild = null;
    const dashboardPort = await freeLoopbackPort();
    const dashboardToken = "shoggoth-hermes-host-fixture-token";
    let dashboardOutput = "";
    dashboard = spawn(bin, ["dashboard", "--skip-build", "--no-open",
      "--isolated", "--port", String(dashboardPort)], {
      cwd: workspace, env: { ...env, HERMES_DASHBOARD_SESSION_TOKEN: dashboardToken },
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    dashboard.stdout.on("data", chunk => { dashboardOutput += chunk; });
    dashboard.stderr.on("data", chunk => { dashboardOutput += chunk; });
    await waitUntil(async () => {
      if (dashboard.exitCode !== null) throw new Error(`Hermes dashboard exited: ${dashboardOutput.slice(-2500)}`);
      try {
        const response = await fetch(`http://127.0.0.1:${dashboardPort}/api/health`,
          { signal: AbortSignal.timeout(1_000) });
        return response.ok;
      } catch { return false; }
    }, 30_000);
    dashboardBackend = new HermesBackend({ getConfig: () => ({
      hermesMode: "local", hermesRemotes: [],
    }) });
    dashboardBackend.profileById.set("hermes-host-probe", "default");
    dashboardBackend.dashboards.set("default", { baseUrl: `http://127.0.0.1:${dashboardPort}`,
      token: dashboardToken, proc: null, spawned: false });
    const dashboardSession = await dashboardBackend.createSession("hermes-host-probe", {
      model: MODEL, provider: "custom", workspace,
    });
    const registry = new BackendRegistry();
    registry.register(dashboardBackend);
    proxy = await startProxyGateway({ port: 0, getUpstreamUrl: () => "", registry });
    chatClient = await openProxyChatClient(proxy.url);
    // The real Dashboard is behind this browser Proxy. A selected send must
    // stop before model/Service execution, while an ordinary retry with the
    // same operation key must remain possible.
    const selectionSession = await dashboardBackend.createSession("hermes-host-probe", {
      model: MODEL, provider: "custom", workspace,
    });
    const rejectedSelectionPrompt = "Shoggoth blocked Hermes selection probe";
    const selectionRetryKey = "shoggoth-hermes-selection-retry";
    const serviceCallsBeforeSelection = fs.readFileSync(logFile, "utf8").split("\n")
      .filter(line => line.includes('"phase":"service"')).length;
    await assert.rejects(within(chatClient.request("chat.send", {
      sessionKey: selectionSession, message: rejectedSelectionPrompt,
      idempotencyKey: selectionRetryKey,
      pluginSelection: [{ installationId: business.installationId,
        revision: business.installationRevision }],
    }), "Hermes selected chat.send"), /PLUGIN_SELECTION_UNAVAILABLE/u);
    assert.equal(requests.some(request => JSON.stringify(request.messages)
      .includes(rejectedSelectionPrompt)), false);
    assert.equal(fs.readFileSync(logFile, "utf8").split("\n")
      .filter(line => line.includes('"phase":"service"')).length, serviceCallsBeforeSelection,
    "selected request reached Service before the rejection");
    const ordinaryRetryPrompt = "Shoggoth ordinary selection retry";
    const selectionRetry = await within(chatClient.request("chat.send", {
      sessionKey: selectionSession, message: ordinaryRetryPrompt,
      idempotencyKey: selectionRetryKey,
    }), "Hermes ordinary retry after selected rejection");
    assert.equal(selectionRetry.status, "started");
    await waitUntil(() => requests.some(request => JSON.stringify(request.messages)
      .includes(ordinaryRetryPrompt)), 25_000).catch(error => {
      const tail = fs.readFileSync(logFile, "utf8").trim().split("\n")
        .filter(Boolean).slice(-10).map(JSON.parse);
      throw new Error(`${error.message}: ${JSON.stringify({ session: selectionSession,
        proxyEvents: chatClient.events.slice(-8), modelRequests: requests.length,
        hostEvents: tail, dashboardOutput: dashboardOutput.slice(-2000) })}`);
    });
    await waitUntil(() => chatClient.events.some(frame => frame.event === "chat"
      && frame.payload?.sessionKey === selectionSession
      && frame.payload?.runId === selectionRetryKey
      && frame.payload?.state === "final"), 25_000);
    assert.equal(requests.some(request => JSON.stringify(request.messages)
      .includes(rejectedSelectionPrompt)), false,
      "selected request reached the model after the rejection");
    stalledCall = fixture.stallNextCall();
    const proxyRunId = "shoggoth-hermes-proxy-cancel";
    const sendAck = await within(chatClient.request("chat.send", {
      sessionKey: dashboardSession, message: "Shoggoth cancel probe",
      idempotencyKey: proxyRunId,
    }), "Hermes proxy browser chat.send");
    assert.equal(sendAck.status, "started");
    const dashboardEntered = await within(stalledCall.entered, "Hermes Gateway Service call")
      .catch(error => {
        const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim()
          .split("\n").filter(Boolean).slice(-12).map(JSON.parse) : [];
        throw new Error(`${error.message}: ${JSON.stringify({ modelRequests: requests.length,
          hostEvents: tail, dashboardOutput: dashboardOutput.slice(-2000) })}`);
      });
    assert.equal(dashboardEntered.identity.backendId, "hermes");
    await within(chatClient.request("chat.abort", { sessionKey: dashboardSession }),
      "Hermes proxy browser chat.abort");
    const dashboardCanceled = await within(stalledCall.canceled, "Hermes Gateway Service cancel")
      .catch(error => {
        const tail = fs.readFileSync(logFile, "utf8").trim().split("\n")
          .filter(Boolean).slice(-12).map(JSON.parse);
        throw new Error(`${error.message}: ${JSON.stringify(tail)}`);
      });
    assert.deepEqual(dashboardCanceled.params.identity, dashboardEntered.identity);
    assert.equal(dashboardCanceled.errorCode, null);
    stalledCall.release();
    stalledCall = null;
    await waitUntil(() => chatClient.events.some(frame => frame.event === "chat"
      && frame.payload?.sessionKey === dashboardSession
      && frame.payload?.runId === proxyRunId
      && frame.payload?.state === "final"), 10_000);
    chatClient.close();
    chatClient = null;
    const uiSession = await dashboardBackend.createSession("hermes-host-probe", {
      model: MODEL, provider: "custom", workspace,
    });
    stalledCall = fixture.stallNextCall();
    chatPageDriver = await createChatPageStopDriver({ root, proxyUrl: proxy.url,
      registry, sessionKey: uiSession, backendId: "hermes",
      agentId: "hermes-host-probe", token: "hermes-host-fixture-token" });
    await chatPageDriver.ready;
    const uiSent = await chatPageDriver.command("send");
    const uiEntered = await within(stalledCall.entered, "Hermes ChatPage Service call");
    assert.equal(uiEntered.identity.backendId, "hermes");
    const uiStopped = await chatPageDriver.command("stop");
    const uiCanceled = await within(stalledCall.canceled, "Hermes ChatPage Service cancel");
    assert.deepEqual(uiCanceled.params.identity, uiEntered.identity);
    assert.equal(uiCanceled.errorCode, null);
    assert.equal(stalledCall.cancelCount, 1,
      "ChatPage Stop must revoke only one Service lease");
    const sentFrame = uiSent.find(row => row.method === "chat.send");
    const abortFrame = uiStopped.find(row => row.method === "chat.abort");
    assert.equal(sentFrame?.sessionKey, uiSession);
    assert.equal(abortFrame?.sessionKey, uiSession);
    assert.equal(abortFrame?.socketId, sentFrame?.socketId,
      "ChatPage send and Stop must use its same browser WebSocket");
    assert.ok(uiStopped.some(row => row.event === "open"
      && row.socketId === sentFrame.socketId && row.url.endsWith("/__chatws")));
    assert.ok(uiStopped.some(row => row.event === "gateway.ready"
      && row.socketId === sentFrame.socketId),
    "ChatPage socket must complete the authenticated broker handshake");
    assert.equal(uiStopped.filter(row => row.method === "chat.abort").length, 1,
      "Stop must abort only the active UI turn");
    await chatPageDriver.close();
    chatPageDriver = null;
    stalledCall.release();
    stalledCall = null;
    await proxy.close();
    proxy = null;
    await dashboardBackend.stop();
    dashboardBackend = null;
    console.log("plugin-hermes-real-host-run-fixture: ok", JSON.stringify({
      modelRequests: requests.length, sessions: middleware.length,
      hasSessionId: middleware.every(item => !!item.sessionId),
      hasTaskId: middleware.every(item => !!item.taskId),
      hasTurnId: middleware.every(item => !!item.turnId),
      hasToolCallId: middleware.every(item => !!item.toolCallId),
      service: { initial: found.length, afterRestart: finalResults[4].result.total,
        afterDisable: finalResults[5].result.total,
        businessCalls: businessResults.length, revokedCalls: deniedCalls.length,
        hostCancel: true, gatewayCancel: true, shoggothProxyStop: true,
        chatPageStop: true },
    }));
  } finally {
    chatClient?.close();
    await chatPageDriver?.close();
    await proxy?.close();
    await dashboardBackend?.stop().catch(() => {});
    if (dashboard?.pid && dashboard.exitCode === null) {
      try { process.kill(-dashboard.pid, "SIGTERM"); } catch { dashboard.kill("SIGTERM"); }
      await Promise.race([new Promise(resolve => dashboard.once("close", resolve)),
        new Promise(resolve => setTimeout(resolve, 5_000))]);
      if (dashboard.exitCode === null) {
        try { process.kill(-dashboard.pid, "SIGKILL"); } catch { dashboard.kill("SIGKILL"); }
      }
    }
    if (canceledChild?.pid && canceledChild.exitCode === null) {
      try { process.kill(-canceledChild.pid, "SIGKILL"); } catch { /* Already exited. */ }
    }
    stalledCall?.release();
    await fixture.stop();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
