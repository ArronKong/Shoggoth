"use strict";

// Exercise the installed OpenClaw runtime, an isolated Shoggoth Service and a
// local fake model. This does not claim a live provider account or packaged App.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { WebSocket } = require("ws");
const { BackendRegistry } = require("../app/core/backend-registry");
const { buildConnectParams, generateIdentity } =
  require("../app/core/device-auth");
const { startProxyGateway } = require("../app/core/proxy-gateway");
const { createFixture, SKILL_ID } = require("./plugin-real-host-service-fixture.cjs");
const { createChatPageStopDriver } = require("./plugin-chatpage-stop-driver.cjs");

const PLUGIN_ID = "shoggoth-shared-capabilities";
const TOOL = "shoggoth_capability_search";
const READ_TOOL = "shoggoth_skill_read";
const CALL_TOOL = "shoggoth_plugin_call";
const MODEL = "shoggoth-host-probe";

function completion(text, tool = null) {
  const choice = tool
    ? { index: 0, message: { role: "assistant", content: null,
      tool_calls: [{ id: `call_${tool.name}`, type: "function",
        function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] },
    finish_reason: "tool_calls" }
    : { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" };
  return { id: "chatcmpl-shoggoth-probe", object: "chat.completion", created: 1,
    model: MODEL, choices: [choice], usage: { prompt_tokens: 16,
      completion_tokens: 8, total_tokens: 24 } };
}

function streamCompletion(response, text, tool) {
  const parts = tool ? [
    { role: "assistant", tool_calls: [{ index: 0, id: `call_${tool.name}`,
      type: "function", function: { name: tool.name, arguments: "" } }] },
    { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(tool.args) } }] },
  ] : [{ role: "assistant", content: text }];
  response.writeHead(200, { "content-type": "text/event-stream",
    "cache-control": "no-cache" });
  for (const delta of parts) response.write(`data: ${JSON.stringify({
    id: "chatcmpl-shoggoth-probe", object: "chat.completion.chunk",
    created: 1, model: MODEL, choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-shoggoth-probe",
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
    const timer = setTimeout(() => child.kill("SIGTERM"), 45_000);
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

// A chat.send and its Stop request must use the same authenticated browser
// connection through Shoggoth's proxy. Separate gateway-call CLI invocations
// have different owners and are intentionally denied by OpenClaw's policy.
async function openChatClient(url, gatewayToken) {
  const socket = new WebSocket(url, { headers: { Origin: "http://127.0.0.1" } });
  const pending = new Map();
  const identity = generateIdentity();
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
  const request = (method, params) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error("OpenClaw chat socket is closed")); return;
    }
    const id = `shoggoth-chat-${++sequence}`;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ type: "req", id, method, params }));
  });
  socket.on("message", data => {
    const frame = JSON.parse(data.toString());
    if (frame.type === "event" && frame.event === "connect.challenge" && !connectSent) {
      connectSent = true;
      // Only ordinary write scope: admin could abort anyone's run and would
      // hide a broken same-connection ownership path.
      const auth = { ...identity, token: gatewayToken, scopes: ["operator.write"] };
      void request("connect", buildConnectParams(auth, frame.payload?.nonce))
        .then(readyResolve, readyReject);
      return;
    }
    if (frame.type !== "res") return;
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    if (frame.ok) entry.resolve(frame.payload);
    else entry.reject(new Error(`${frame.error?.code || "GATEWAY_ERROR"}: ${frame.error?.message || "unknown"}`));
  });
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("OpenClaw chat socket closed")));
  try { await within(ready, "OpenClaw browser chat connect", 10_000); }
  catch (error) { socket.close(); throw error; }
  return { request, close: () => socket.close() };
}

async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitUntil(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("OpenClaw gateway host fixture timed out");
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sgoh-")));
  const fixture = createFixture(root, "openclaw");
  const calls = [];
  let skillComponentId = null;
  let business = null;
  let modelCalls = 0;
  let gateway = null;
  let proxy = null;
  let chatClient = null;
  let otherChatClient = null;
  let chatPageDriver = null;
  let stalledCall = null;
  let cancelMode = null;
  let gatewayOutput = "";
  const server = http.createServer(async (request, response) => {
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
      response.writeHead(404).end(); return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push(body);
    modelCalls += 1;
    const previousTools = body.messages?.filter(message => message.role === "tool") || [];
    const cancelProbe = JSON.stringify(body.messages).includes("Shoggoth cancel probe");
    const businessProbe = JSON.stringify(body.messages).includes("Shoggoth business probe");
    const tool = cancelProbe && previousTools.length === 0
      ? { name: CALL_TOOL, args: { serverId: "plugin.fixture", toolName: "blocked",
        arguments: {} } }
      : businessProbe && previousTools.length === 0
        ? { name: CALL_TOOL, args: { serverId: business.serverId,
          toolName: business.toolName, arguments: { value: "host-business" } } }
      : previousTools.length === 0
      ? { name: TOOL, args: { query: SKILL_ID } }
      : previousTools.length === 1
        && JSON.stringify(previousTools[0]).includes(skillComponentId)
        ? { name: "shoggoth_skill_read", args: { skillId: skillComponentId } } : null;
    if (body.stream) streamCompletion(response, "Host probe finished", tool);
    else response.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(completion("Host probe finished", tool)));
  });
  try {
    await fixture.start();
    skillComponentId = fixture.install().componentId;
    business = await fixture.installMcpTool();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    const gatewayPort = await freeLoopbackPort();
    const pluginDir = path.join(root, "plugin");
    const workspace = path.join(root, "workspace");
    const logFile = path.join(root, "host-events.jsonl");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const adapter = pathToFileURL(path.join(__dirname,
      "../resources/external-plugin-adapters/openclaw/index.mjs")).href;
    const clientPath = path.join(__dirname, "../app/agent-service/client.js");
    const servicePaths = { runtimeDir: fixture.paths.runtimeDir,
      socketPath: fixture.paths.socketPath };
    fs.writeFileSync(path.join(pluginDir, "package.json"), JSON.stringify({
      name: "shoggoth-host-probe", version: "0.0.0", private: true,
      type: "module", openclaw: { extensions: ["./index.mjs"] },
    }));
    fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), JSON.stringify({
      id: PLUGIN_ID, name: "Shoggoth Host Probe", version: "0.0.0",
      activation: { onStartup: true }, contracts: { tools: [TOOL, READ_TOOL, CALL_TOOL] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }));
    fs.writeFileSync(path.join(pluginDir, "index.mjs"), `
import fs from "node:fs";
import { createRequire } from "node:module";
import { createAdapter } from ${JSON.stringify(adapter)};
const require = createRequire(import.meta.url);
const { requestService } = require(${JSON.stringify(clientPath)});
const servicePaths = ${JSON.stringify(servicePaths)};
const logFile = ${JSON.stringify(logFile)};
function log(value) { fs.appendFileSync(logFile, JSON.stringify(value) + "\\n"); }
export default { id: ${JSON.stringify(PLUGIN_ID)}, name: "Shoggoth Host Probe",
  register(api) {
    log({ phase: "register" });
    api.on("before_prompt_build", (event, ctx) => {
      log({ phase: "prompt", currentUserMessageId: event.currentUserMessageId,
        runId: ctx?.runId, agentId: ctx?.agentId, sessionId: ctx?.sessionId });
    });
    api.on("before_agent_run", (_event, ctx) => {
      log({ phase: "agent-run", runId: ctx?.runId,
        agentId: ctx?.agentId, sessionId: ctx?.sessionId });
    });
    const bridge = createAdapter({ credential: () => ${JSON.stringify(fixture.credential)},
      requestService: async (method, params, options = {}) => {
        log({ phase: "service", method, identity: params.identity });
        try {
          const result = await requestService(servicePaths, { version: 11, method, params },
            { timeoutMs: options.timeoutMs || 10_000, signal: options.signal });
          log({ phase: "service-result", method, result: method === "plugin.external.open"
            ? { opened: !!result.token } : result });
          return result;
        } catch (error) {
          log({ phase: "service-error", method, code: error.code || "SHOGGOTH_ADAPTER_UNAVAILABLE" });
          throw error;
        }
      } });
    api.on("before_tool_call", (event, ctx) => {
      log({ phase: "hook", toolName: event.toolName, toolCallId: event.toolCallId,
        runId: event.runId, ctxRunId: ctx?.runId, agentId: ctx?.agentId,
        sessionId: ctx?.sessionId });
      return bridge.beforeToolCall(event, ctx);
    });
    for (const name of ${JSON.stringify([TOOL, READ_TOOL, CALL_TOOL])}) api.registerTool(context => {
      log({ phase: "factory", context: {
        agentId: context?.agentId, sessionId: context?.sessionId,
        sessionKey: context?.sessionKey, runId: context?.runId,
        keys: Object.keys(context || {}) } });
      const tool = bridge.tool(name, context);
      const execute = tool.execute;
      return { ...tool, execute(callId, args, signal) {
        log({ phase: "execute", callId });
        return execute(callId, args, signal);
      } };
    },
      { name });
  } };
`);
    const configPath = path.join(root, "openclaw.json");
    fs.writeFileSync(configPath, JSON.stringify({
      models: { mode: "replace", providers: { probe: {
        baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "fixture-only",
        api: "openai-completions", models: [{ id: MODEL, name: MODEL,
          reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_000, maxTokens: 1_024 }],
      } } },
      agents: { defaults: { model: { primary: `probe/${MODEL}` },
        workspace, skipBootstrap: true } },
      tools: { profile: "coding", alsoAllow: [TOOL, READ_TOOL, CALL_TOOL] },
      gateway: { mode: "local", port: gatewayPort, bind: "loopback",
        auth: { mode: "token", token: "shoggoth-host-fixture-token" },
        controlUi: { enabled: true } },
      discovery: { mdns: { mode: "off" } },
      update: { checkOnStart: false },
      plugins: { load: { paths: [pluginDir] }, entries: {
        [PLUGIN_ID]: { enabled: true, hooks: { allowConversationAccess: true } },
      } },
    }));
    const env = { HOME: root, PATH: process.env.PATH || "/usr/bin:/bin",
      LANG: process.env.LANG || "en_US.UTF-8", TMPDIR: os.tmpdir(),
      USER: process.env.USER || "fixture", LOGNAME: process.env.LOGNAME || "fixture",
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: configPath };
    const pluginList = await run(process.env.SHOGGOTH_TEST_OPENCLAW_BIN || "openclaw",
      ["plugins", "list", "--json"], { cwd: workspace, env });
    const listed = JSON.parse(pluginList.stdout);
    const listedProbe = listed.plugins?.find(item => item.id === PLUGIN_ID);
    const bin = process.env.SHOGGOTH_TEST_OPENCLAW_BIN || "openclaw";
    gateway = spawn(bin, ["gateway", "run", "--port", String(gatewayPort),
      "--auth", "token", "--token", "shoggoth-host-fixture-token"],
    { cwd: workspace, detached: true, env: { ...env, OPENCLAW_NO_AUTO_UPDATE: "1",
      OPENCLAW_DISABLE_BONJOUR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    gateway.stdout.on("data", chunk => { gatewayOutput += chunk; });
    gateway.stderr.on("data", chunk => { gatewayOutput += chunk; });
    await waitUntil(async () => {
      if (gateway.exitCode !== null) throw new Error(`gateway exited: ${gatewayOutput.slice(-3000)}`);
      const probe = await run(bin, ["gateway", "call", "health", "--json",
        "--url", `ws://127.0.0.1:${gatewayPort}`, "--token", "shoggoth-host-fixture-token",
        "--timeout", "3000"], { cwd: workspace, env });
      return probe.code === 0;
    }, 30_000);
    proxy = await startProxyGateway({ port: 0, origin: "http://127.0.0.1",
      getUpstreamUrl: () => `ws://127.0.0.1:${gatewayPort}` });
    const dispatchIds = Array.from({ length: 4 }, (_, index) => `shoggoth-host-probe-${index}`);
    const results = await Promise.all(dispatchIds.map((id, index) => run(bin,
      ["gateway", "call", "chat.send", "--json",
        "--url", `ws://127.0.0.1:${gatewayPort}`, "--token", "shoggoth-host-fixture-token",
        "--params", JSON.stringify({ sessionKey: `agent:main:shoggoth-probe-${index}`,
          message: "Call the Shoggoth search tool once.", idempotencyKey: id })],
      { cwd: workspace, env })));
    await waitUntil(() => calls.length >= 12 && fs.existsSync(logFile)
      && fs.readFileSync(logFile, "utf8").split("\n")
        .filter(line => line.includes('"method":"plugin.external.skill.read"')
          && line.includes('"phase":"service-result"')).length >= 4,
    35_000).catch(error => {
      const trace = fs.existsSync(logFile)
        ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
      throw new Error(`${error.message}: ${JSON.stringify({ modelCalls: calls.length,
        lastMessages: calls.at(-1)?.messages?.slice(-3),
        service: trace.filter(item => item.phase === "service" || item.phase === "service-result")
          .map(item => [item.phase, item.method, item.result?.total]) }).slice(0, 5000)}`);
    });
    const events = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    for (const result of results) {
      assert.equal(result.code, 0, `${result.stderr.slice(-2000)}; gateway=${gatewayOutput.slice(-2000)}`);
    }
    assert.ok(calls.length >= 12, `model calls=${calls.length}; gateway=${gatewayOutput.slice(-1500)}`);
    assert.ok(calls.some(call => call.tools?.some(item => item.function?.name === TOOL)),
      `OpenClaw did not expose the registered Shoggoth tool: ${JSON.stringify({
        tools: calls[0].tools?.map(item => item.function?.name),
        events, listedProbe,
        stderr: results[0].stderr.slice(-2000), stdout: results[0].stdout.slice(-1000),
      })}`);
    const hooks = events.filter(item => item.phase === "hook" && item.toolName === TOOL);
    const opens = events.filter(item => item.phase === "service" && item.method === "plugin.external.open");
    const searches = events.filter(item => item.phase === "service" && item.method === "plugin.external.search");
    assert.equal(hooks.length, 4, `host hooks=${JSON.stringify(hooks)}; gateway=${gatewayOutput.slice(-1500)}`);
    assert.equal(opens.length, 8);
    assert.equal(searches.length, 4);
    const found = events.filter(item => item.phase === "service-result"
      && item.method === "plugin.external.search");
    assert.equal(found.length, 4);
    assert.ok(found.every(item => item.result.items.some(skill => skill.name === SKILL_ID)),
      `Service did not project installed Skill: ${JSON.stringify(found)}`);
    const reads = events.filter(item => item.phase === "service-result"
      && item.method === "plugin.external.skill.read");
    assert.equal(reads.length, 4);
    assert.ok(reads.every(item => item.result.content.includes("Host probe")));
    const businessAck = await run(bin, ["gateway", "call", "chat.send", "--json",
      "--url", `ws://127.0.0.1:${gatewayPort}`, "--token", "shoggoth-host-fixture-token",
      "--params", JSON.stringify({ sessionKey: "agent:main:shoggoth-probe-business",
        message: "Shoggoth business probe", idempotencyKey: "shoggoth-host-probe-business" })],
    { cwd: workspace, env });
    assert.equal(businessAck.code, 0, businessAck.stderr);
    await waitUntil(() => fs.readFileSync(logFile, "utf8").split("\n")
      .some(line => line.includes('"method":"plugin.external.call"')
        && line.includes('"phase":"service-result"')), 30_000);
    const businessResults = fs.readFileSync(logFile, "utf8").trim().split("\n")
      .filter(Boolean).map(JSON.parse).filter(item => item.phase === "service-result"
        && item.method === "plugin.external.call");
    assert.equal(businessResults.length, 1);
    assert.equal(businessResults[0].result.result.structuredContent.echoed, "host-business");
    const businessIdentity = fs.readFileSync(logFile, "utf8").trim().split("\n")
      .filter(Boolean).map(JSON.parse).find(item => item.phase === "service"
        && item.method === "plugin.external.call")?.identity;
    assert(businessIdentity);
    const auditedBusiness = (await fixture.listAuditedCalls("openclaw")).items.find(row =>
      row.sessionId === businessIdentity.sessionId
        && row.runId === businessIdentity.runId
        && row.toolCallId === businessIdentity.toolCallId);
    assert(auditedBusiness);
    assert.equal(auditedBusiness.backendId, "openclaw");
    assert.equal(auditedBusiness.instanceId, businessIdentity.instanceId);
    assert.equal(auditedBusiness.agentId, businessIdentity.agentId);
    assert.equal(auditedBusiness.bindingId, business.bindingId);
    assert.equal(auditedBusiness.installationId, business.installationId);
    assert.equal(auditedBusiness.toolIdentity, business.toolIdentity);
    assert.equal(auditedBusiness.status, "confirmed");
    assert.match(auditedBusiness.resultDigest, /^[a-f0-9]{64}$/u);
    await business.requireEachCall();
    const approvedAck = await run(bin, ["gateway", "call", "chat.send", "--json",
      "--url", `ws://127.0.0.1:${gatewayPort}`, "--token", "shoggoth-host-fixture-token",
      "--params", JSON.stringify({ sessionKey: "agent:main:shoggoth-probe-each-call",
        message: "Shoggoth business probe", idempotencyKey: "shoggoth-host-probe-each-call" })],
    { cwd: workspace, env });
    assert.equal(approvedAck.code, 0, approvedAck.stderr);
    await waitUntil(async () => (await fixture.listPendingApprovals("openclaw")).items.length === 1,
      30_000);
    const pendingApproval = (await fixture.listPendingApprovals("openclaw")).items[0];
    assert.equal(pendingApproval.backendId, "openclaw");
    assert.equal(pendingApproval.toolName, business.toolName);
    assert.equal((await fixture.respondApproval(pendingApproval.requestId, true)).approved, true);
    await waitUntil(() => fs.readFileSync(logFile, "utf8").split("\n")
      .filter(line => line.includes('"method":"plugin.external.call"')
        && line.includes('"phase":"service-result"')).length === 2, 30_000);
    const approvedAudit = (await fixture.listAuditedCalls("openclaw")).items.find(row =>
      row.sessionId === pendingApproval.sessionId && row.toolCallId === pendingApproval.toolCallId);
    assert.equal(approvedAudit?.status, "confirmed");
    await business.revoke();
    const deniedAck = await run(bin, ["gateway", "call", "chat.send", "--json",
      "--url", `ws://127.0.0.1:${gatewayPort}`, "--token", "shoggoth-host-fixture-token",
      "--params", JSON.stringify({ sessionKey: "agent:main:shoggoth-probe-revoked",
        message: "Shoggoth business probe", idempotencyKey: "shoggoth-host-probe-revoked" })],
    { cwd: workspace, env });
    assert.equal(deniedAck.code, 0, deniedAck.stderr);
    await waitUntil(() => fs.readFileSync(logFile, "utf8").split("\n")
      .some(line => line.includes('"method":"plugin.external.call"')
        && line.includes('"phase":"service-error"')), 30_000);
    const deniedCalls = fs.readFileSync(logFile, "utf8").trim().split("\n")
      .filter(Boolean).map(JSON.parse).filter(item => item.phase === "service-error"
        && item.method === "plugin.external.call");
    assert.deepEqual(deniedCalls.map(item => item.code), ["CAPABILITY_FORBIDDEN"]);
    const hookBySession = new Map(hooks.map(item => [item.sessionId, item]));
    assert.equal(hookBySession.size, 4);
    for (const search of searches) {
      const open = opens.find(item => JSON.stringify(item.identity)
        === JSON.stringify(search.identity));
      const hook = hookBySession.get(search.identity.sessionId);
      assert.ok(hook && open, `missing host identity: ${JSON.stringify(search)}`);
      assert.ok([hook.runId, hook.ctxRunId].some(value => typeof value === "string" && value.length),
        `no trusted run ID: ${JSON.stringify(hook)}`);
      assert.equal(open.identity.toolCallId, hook.toolCallId);
      assert.equal(search.identity.toolCallId, hook.toolCallId);
      assert.equal(search.identity.runId, open.identity.runId);
    }
    const ackIds = results.map(result => JSON.parse(result.stdout).runId);
    assert.deepEqual(ackIds.slice().sort(), dispatchIds.slice().sort());
    assert.ok(opens.every(item => dispatchIds.includes(item.identity.runId)),
      `host run IDs differed from gateway ack in fixture: ${JSON.stringify(opens)}`);
    assert.ok(events.some(item => item.phase === "prompt"), `no prompt hook: ${JSON.stringify({
      listedProbe, stdout: results[0].stdout.slice(-1800), stderr: results[0].stderr.slice(-1800),
      gateway: gatewayOutput.slice(-2500),
    })}`);
    await fixture.restart();
    const persistedBusiness = (await fixture.listAuditedCalls("openclaw")).items.find(row =>
      row.callId === auditedBusiness.callId);
    assert.deepEqual(persistedBusiness, auditedBusiness);
    const retry = await run(bin, ["gateway", "call", "chat.send", "--json",
      "--url", `ws://127.0.0.1:${gatewayPort}`, "--token", "shoggoth-host-fixture-token",
      "--params", JSON.stringify({ sessionKey: "agent:main:shoggoth-probe-restart",
        message: "Call the Shoggoth search tool once.", idempotencyKey: "shoggoth-host-probe-restart" })],
    { cwd: workspace, env });
    assert.equal(retry.code, 0, retry.stderr);
    await waitUntil(() => fs.readFileSync(logFile, "utf8").split("\n")
      .filter(line => line.includes('"method":"plugin.external.search"')
        && line.includes('"phase":"service-result"')).length >= 5, 20_000);
    await waitUntil(() => fs.readFileSync(logFile, "utf8").split("\n")
      .filter(line => line.includes('"method":"plugin.external.skill.read"')
        && line.includes('"phase":"service-result"')).length >= 5, 20_000);
    fixture.disable();
    const revoked = await run(bin, ["gateway", "call", "chat.send", "--json",
      "--url", `ws://127.0.0.1:${gatewayPort}`, "--token", "shoggoth-host-fixture-token",
      "--params", JSON.stringify({ sessionKey: "agent:main:shoggoth-probe-disabled",
        message: "Call the Shoggoth search tool once.", idempotencyKey: "shoggoth-host-probe-disabled" })],
    { cwd: workspace, env });
    assert.equal(revoked.code, 0, revoked.stderr);
    await waitUntil(() => fs.readFileSync(logFile, "utf8").split("\n")
      .filter(line => line.includes('"method":"plugin.external.search"')
        && line.includes('"phase":"service-result"')).length >= 6, 20_000);
    const finalResults = fs.readFileSync(logFile, "utf8").trim().split("\n")
      .filter(Boolean).map(JSON.parse).filter(item => item.phase === "service-result"
        && item.method === "plugin.external.search");
    assert.ok(finalResults[4].result.items.some(item => item.name === SKILL_ID));
    assert.equal(finalResults[5].result.total, 0);
    const finalReads = fs.readFileSync(logFile, "utf8").trim().split("\n")
      .filter(Boolean).map(JSON.parse).filter(item => item.phase === "service-result"
        && item.method === "plugin.external.skill.read");
    assert.equal(finalReads.length, 5);
    chatClient = await openChatClient(proxy.url,
      "shoggoth-host-fixture-token");
    // Exercise the real Gateway behind the browser Proxy: an unavailable
    // selection must never reach either the model or Service, and it must not
    // reserve the user's idempotency key for an ordinary retry.
    const rejectedSelectionPrompt = "Shoggoth blocked external selection probe";
    const selectionRetryKey = "shoggoth-host-probe-selection-retry";
    const serviceCallsBeforeSelection = fs.readFileSync(logFile, "utf8").split("\n")
      .filter(line => line.includes('"phase":"service"')).length;
    await assert.rejects(within(chatClient.request("chat.send", {
      sessionKey: "agent:main:shoggoth-probe-selection", message: rejectedSelectionPrompt,
      idempotencyKey: selectionRetryKey,
      pluginSelection: [{ installationId: business.installationId,
        revision: business.installationRevision }],
    }), "OpenClaw selected chat.send"), /PLUGIN_SELECTION_UNAVAILABLE/u);
    assert.equal(calls.some(call => JSON.stringify(call.messages).includes(rejectedSelectionPrompt)), false);
    assert.equal(fs.readFileSync(logFile, "utf8").split("\n")
      .filter(line => line.includes('"phase":"service"')).length, serviceCallsBeforeSelection,
    "selected request reached Service before the rejection");
    const searchResultsBeforeRetry = fs.readFileSync(logFile, "utf8").split("\n")
      .filter(line => line.includes('"method":"plugin.external.search"')
        && line.includes('"phase":"service-result"')).length;
    await within(chatClient.request("chat.send", {
      sessionKey: "agent:main:shoggoth-probe-selection",
      message: "Call the Shoggoth search tool once.", idempotencyKey: selectionRetryKey,
    }), "OpenClaw ordinary retry after selected rejection");
    await waitUntil(() => fs.readFileSync(logFile, "utf8").split("\n")
      .filter(line => line.includes('"method":"plugin.external.search"')
        && line.includes('"phase":"service-result"')).length > searchResultsBeforeRetry, 20_000);
    assert.equal(calls.some(call => JSON.stringify(call.messages).includes(rejectedSelectionPrompt)), false,
      "selected request reached the model after the rejection");
    stalledCall = fixture.stallNextCall();
    const cancelSessionKey = "agent:main:shoggoth-probe-cancel";
    const cancelAck = await within(chatClient.request("chat.send", {
      sessionKey: cancelSessionKey, message: "Shoggoth cancel probe",
      idempotencyKey: "shoggoth-host-probe-cancel",
    }), "OpenClaw browser chat.send");
    const entered = await within(stalledCall.entered, "OpenClaw Service call");
    assert.equal(entered.identity.backendId, "openclaw");
    otherChatClient = await openChatClient(proxy.url,
      "shoggoth-host-fixture-token");
    await assert.rejects(within(otherChatClient.request("chat.abort", {
      sessionKey: cancelSessionKey, runId: cancelAck.runId || "shoggoth-host-probe-cancel",
    }), "other OpenClaw browser chat.abort"), /INVALID_REQUEST: unauthorized/u);
    otherChatClient.close();
    otherChatClient = null;
    // The actual composer Stop button sends only sessionKey; runId from the
    // chat.send acknowledgement is deliberately not supplied here.
    const abort = await within(chatClient.request("chat.abort", {
      sessionKey: cancelSessionKey,
    }), "Shoggoth-proxied browser chat.abort");
    assert.equal(abort.aborted, true, JSON.stringify(abort));
    cancelMode = "shoggoth-proxy-same-connection-chat.abort";
    const canceled = await within(stalledCall.canceled, "OpenClaw Service cancel");
    assert.deepEqual(canceled.params.identity, entered.identity);
    assert.equal(canceled.errorCode, null);
    chatClient.close();
    chatClient = null;
    stalledCall.release();
    stalledCall = null;
    // Real ChatPage Stop button -> same authenticated browser broker WS ->
    // proxy chat.abort -> isolated OpenClaw adapter lease cancellation.
    stalledCall = fixture.stallNextCall();
    const uiCancelSessionKey = "agent:main:shoggoth-probe-cancel-ui";
    const uiRegistry = new BackendRegistry();
    // The real OpenClaw Gateway is running in this fixture; mirror only its
    // connectivity in the management-plane status endpoint. The actual chat
    // transport and host cancellation still traverse the real Proxy/Gateway.
    uiRegistry.getStatus = async () => [{ id: "openclaw", name: "OpenClaw",
      connected: true, info: {} }];
    chatPageDriver = await createChatPageStopDriver({ root, proxyUrl: proxy.url,
      registry: uiRegistry,
      sessionKey: uiCancelSessionKey, backendId: "openclaw", agentId: "main",
      token: "shoggoth-host-fixture-token" });
    await chatPageDriver.ready;
    const uiSent = await chatPageDriver.command("send");
    const uiEntered = await within(stalledCall.entered, "OpenClaw ChatPage Service call");
    assert.equal(uiEntered.identity.backendId, "openclaw");
    const uiStopped = await chatPageDriver.command("stop");
    const uiCanceled = await within(stalledCall.canceled, "OpenClaw ChatPage Service cancel");
    assert.deepEqual(uiCanceled.params.identity, uiEntered.identity);
    assert.equal(uiCanceled.errorCode, null);
    assert.equal(stalledCall.cancelCount, 1,
      "ChatPage Stop must revoke only one Service lease");
    const sentFrame = uiSent.find(row => row.method === "chat.send");
    const abortFrame = uiStopped.find(row => row.method === "chat.abort");
    assert.equal(sentFrame?.sessionKey, uiCancelSessionKey);
    assert.equal(abortFrame?.sessionKey, uiCancelSessionKey);
    assert.equal(abortFrame?.socketId, sentFrame?.socketId,
      "ChatPage send and Stop must use its same browser WebSocket");
    assert.ok(uiStopped.some(row => row.event === "open"
      && row.socketId === sentFrame.socketId && row.url.endsWith("/__chatws")));
    assert.ok(uiStopped.some(row => row.event === "gateway.ready"
      && row.socketId === sentFrame.socketId && row.degraded === false),
    "ChatPage socket must complete the authenticated broker handshake");
    assert.equal(uiStopped.filter(row => row.method === "chat.abort").length, 1,
      "Stop must abort only the active UI turn");
    await chatPageDriver.close();
    chatPageDriver = null;
    stalledCall.release();
    stalledCall = null;
    const prompts = events.filter(item => item.phase === "prompt");
    const agentRuns = events.filter(item => item.phase === "agent-run");
    console.log("plugin-openclaw-real-host-run-fixture: ok", JSON.stringify({
      hostHook: { hasRunId: hooks.every(item => !!item.runId),
        hasCtxRunId: hooks.every(item => !!item.ctxRunId),
        hasToolCallId: hooks.every(item => !!item.toolCallId),
        hasSessionId: hooks.every(item => !!item.sessionId) },
      gatewayAck: ackIds,
      promptIds: prompts.map(item => ({ userMessageId: item.currentUserMessageId || null,
        runId: item.runId || null })),
      agentRuns: agentRuns.map(item => item.runId || null),
      modelCalls: calls.length,
      service: { initial: found.length, afterRestart: finalResults[4].result.total,
        afterDisable: finalResults[5].result.total, businessCalls: businessResults.length,
        revokedCalls: deniedCalls.length,
        hostCancel: cancelMode, chatPageStop: true },
    }));
  } finally {
    otherChatClient?.close();
    chatClient?.close();
    await chatPageDriver?.close();
    stalledCall?.release();
    await proxy?.close();
    if (gateway && gateway.exitCode === null) {
      try { process.kill(-gateway.pid, "SIGTERM"); } catch { gateway.kill("SIGTERM"); }
      await Promise.race([new Promise(resolve => gateway.once("close", resolve)),
        new Promise(resolve => setTimeout(resolve, 5_000))]);
      if (gateway.exitCode === null) {
        try { process.kill(-gateway.pid, "SIGKILL"); } catch { gateway.kill("SIGKILL"); }
      }
    }
    await fixture.stop();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
