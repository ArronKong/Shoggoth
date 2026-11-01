#!/usr/bin/env node
"use strict";
// Actual native helper + Runtime binding, external adapters, Service, REST and
// MCP transports. Only model/Host/provider accounts are disposable fixtures.
const assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
const { pathToFileURL } = require("node:url"), { WebSocketServer } = require("ws");
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
const { startFixture, CANARY } = require("./fixtures/mcp-connector-http-fixture.cjs");
const { ControlledHost, startHermes, until } = require("./mcp-connector-agent-lanes-e2e.cjs");
const { createFederationHostServer } = require("../app/federation-host-server");
const { MCP_CONNECTION_CONFIRMATION } = require("../app/mcp-connection-host");
const { ensureCredential, readCredential } = require("../app/agent-service/external-host-pairing");
const { requestService } = require("../app/agent-service/client");
const { authenticateMcpSession, createMcpStdioHandler } = require("../app/shoggoth-mcp-helper");
const { PROTOCOL_VERSION } = require("../app/agent-service/server");
const uuid = () => crypto.randomUUID(), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class SetupHost extends ControlledHost {
  constructor(id) { super(id); this.idle = false; }
  async resolveMcpConnectionSession({ agentId, sessionId }) {
    await this.getAgent(agentId);
    return [this.id + "-p5-session", `agent:${agentId}:canonical`].includes(sessionId)
      ? { sessionKey: `agent:${agentId}:canonical`, kind: "direct", idle: this.idle } : null;
  }
}
async function main() {
  const provider = await startFixture(), oauthProvider = await startFixture();
  const oc = new SetupHost("openclaw"), hm = new SetupHost("hermes");
  const broker = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise(resolve => broker.once("listening", resolve));
  const brokerOrigin = `http://127.0.0.1:${broker.address().port}`, confirmations = [];
  broker.on("connection", socket => socket.on("message", raw => {
    const frame = JSON.parse(raw); confirmations.push(frame);
    assert.equal(frame.params.message, MCP_CONNECTION_CONFIRMATION);
    socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { status: "started", runId: "controlled-continuation" } }));
  }));
  let f, helper, host, hermes;
  try {
    f = await startInspirationFixture({ groupControlledRuntime: true, extraBackends: [oc, hm], serviceOptions: {
      prewarmMcpAuth: false, autoSparkNotes: false, setCronTimer: () => 1, clearCronTimer() {}, setProactiveTimer: () => 1, clearProactiveTimer() {},
    } });
    await f.desktopHost.stop();
    host = createFederationHostServer({ paths: f.paths, registry: f.registry, mcpConnectionOrigin: brokerOrigin }); await host.start();
    const rest = async (endpoint, body) => {
      const response = await fetch(f.url + "/__api/connectors/mcp/" + endpoint, body === undefined ? {} : {
        method: "POST", headers: { Origin: f.url, "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value));
      assert.equal(JSON.stringify(value).includes(CANARY), false); return value;
    };
    const created = await f.ipc("agent.create", { operationId: uuid(), backendId: "shoggoth", name: "Agent connector setup", defaultCwd: null, createdAt: Date.now() });
    const profile = f.service.productStore.getAgentProfile(created.profile.id);
    const session = (await f.ipc("chat.session.create", { operationId: uuid(), profileId: profile.id, workspace: f.paths.defaultWorkspaceDir, createdAt: Date.now() })).session;
    let context;
    const control = async (action, params) => {
      const id = uuid(), dir = path.join(f.root, "group-control"), file = path.join(dir, id + ".response.json");
      fs.writeFileSync(path.join(dir, id + ".request.json"), JSON.stringify({ id, action, threadId: context.threadId, turnId: context.turnId, params }), { mode: 0o600 });
      const response = await until(() => { try { return JSON.parse(fs.readFileSync(file)); } catch { return null; } }, v => v !== null, action);
      assert.equal(response.error, undefined); return response.result;
    };
    const setContext = async run => { context = await until(() => f.service.workRunCoordinator.runContexts.get(run.id), v => v?.threadId && v?.turnId, "native turn"); };
    const send = async () => { const { run } = await f.ipc("chat.send", { operationId: uuid(), sessionKey: session.sessionKey, prompt: "Add the requested connectors and use them to finish this task.", createdAt: Date.now() }); await setContext(run); return run; };
    const complete = async run => { await control("complete"); await f.service.workRunCoordinator.waitForTerminal(run.id); };
    const auth = await authenticateMcpSession({ paths: f.paths, runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId,
      safeStorage: { isEncryptionAvailable: () => true, encryptString: v => Buffer.from(v), decryptString: v => v.toString() } });
    helper = createMcpStdioHandler({ paths: f.paths, runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId, sessionToken: auth.token, bindRuntimeCalls: true, requestService });
    await helper({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "agent-setup-e2e", version: "1" } } });
    let confirmationsRequested = 0;
    const call = async (name, args, allowConfirmation = false) => {
      const response = await helper({ jsonrpc: "2.0", id: uuid(), method: "tools/call", params: { name, arguments: args } }, {
        requestClient: async (method, params) => {
          assert.equal(method, "elicitation/create");
          if (params._meta?.["shoggoth/runtime-call-binding"]) return control("binding", params);
          confirmationsRequested++; assert.ok(allowConfirmation, "setup must not ask for an extra confirmation");
          return { action: "accept", content: { confirm_product_action: "确认执行" } };
        },
      });
      const value = response.result.structuredContent; assert.equal(value.error, undefined, JSON.stringify(value)); return value;
    };
    const resumed = async request => {
      const saved = await until(() => f.service.mcpConnectorController.requests.get(request.requestId), v => v.status === "completed", "automatic continuation");
      const runs = f.service.productStore.listWorkRuns().filter(run => run.sourceId === session.sessionKey);
      const run = runs.find(run => run.status === "running") || await until(() => f.service.productStore.listWorkRuns().find(run => run.sourceId === session.sessionKey && run.status === "running"), Boolean, "resumed run");
      assert.equal(saved.continuation, "scheduled"); await setContext(run); return run;
    };
    let run = await send();
    const args = { url: provider.origin + "/public", name: "Agent URL connector", purpose: "Finish original task" };
    const added = await call("mcp_server_add", args), repeated = await call("mcp_server_add", args);
    assert.equal(added.servers[0].status, "ready"); assert.equal(added.continuation, "after_current_turn");
    assert.equal(added.request.requestId, repeated.request.requestId); assert.equal((await rest("list")).servers.length, 1);
    assert.equal((await call("mcp_server_list", {})).servers.length, 0); assert.equal(confirmationsRequested, 0);
    await complete(run); run = await resumed(added.request);
    assert.ok((await call("mcp_server_tools", { serverId: added.servers[0].id, cursor: 0, limit: 20 })).items.some(tool => tool.name === "echo"));
    const echoed = await call("mcp_server_call", { serverId: added.servers[0].id, toolName: "echo", arguments: { value: "URL continued" } }, true);
    assert.equal(echoed.result.content[0].text, "URL continued"); await complete(run);
    console.log("PASS URL: actual native tool adds without confirmation, REST list sees it, source turn stays frozen, one automatic next turn lists and calls MCP");

    const command = path.join(f.paths.defaultWorkspaceDir, "agent-setup-stdio.cjs");
    fs.writeFileSync(command, `#!${process.execPath}\nrequire('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'stdio-setup',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:process.env.LOCAL_TOKEN?'stdio continued':'missing'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});\n`, { mode: 0o700 });
    run = await send();
    const imported = await call("mcp_server_import", { purpose: "Use both remote and local tools", config: JSON.stringify({ mcpServers: {
      "Agent JSON remote": { url: provider.origin + "/mcp", headers: { Authorization: "Bearer ${MCP_TOKEN}" } },
      "Agent JSON local": { command, env: { LOCAL_TOKEN: "${LOCAL_TOKEN}", MODE: "test" } },
    } }) });
    assert.deepEqual(imported.servers.map(s => s.status), ["needsSetup", "needsSetup"]); assert.equal(imported.continuation, "after_setup");
    await complete(run); const before = f.service.productStore.listWorkRuns().length;
    for (const [index, fields] of [{ headers: { Authorization: "Bearer " + CANARY } }, { env: { LOCAL_TOKEN: CANARY } }].entries()) {
      const result = await rest("credentials", { id: imported.servers[index].id, fields, expectedRevision: (await rest("list")).revision });
      assert.equal(result.server.status, "ready");
      if (index === 0) { await delay(100); assert.equal(f.service.productStore.listWorkRuns().length, before); }
    }
    run = await resumed(imported.request); assert.equal(f.service.productStore.listWorkRuns().length, before + 1);
    for (const [index, expected] of ["remote continued", "stdio continued"].entries()) {
      const result = await call("mcp_server_call", { serverId: imported.servers[index].id, toolName: "echo", arguments: { value: expected } }, true);
      assert.equal(result.result.content[0].text, expected);
    }
    await complete(run); await rest("request-complete", { requestId: imported.request.requestId });
    assert.equal(f.service.productStore.listWorkRuns().length, before + 1);
    console.log("PASS JSON batch: remote + stdio placeholders, private credential writes, whole batch readiness, exactly one continuation, both actual transports called");

    run = await send(); const oauth = await call("mcp_server_add", { url: oauthProvider.origin + "/mcp", name: "Agent OAuth connector", purpose: "Continue after sign-in" });
    assert.equal(oauth.servers[0].status, "signedOut"); await complete(run);
    const signin = await rest("signin", { id: oauth.servers[0].id });
    await fetch(signin.authorizationUrl); // Synthetic provider grants this disposable test account.
    run = await resumed(oauth.request);
    const oauthResult = await call("mcp_server_call", { serverId: oauth.servers[0].id, toolName: "echo", arguments: { value: "OAuth continued" } }, true);
    assert.equal(oauthResult.result.content[0].text, "OAuth continued"); await complete(run);
    console.log("PASS OAuth: signedOut card, actual PKCE callback/token exchange, ready projection, automatic continuation and authenticated MCP call");

    ensureCredential(f.paths, "openclaw"); ensureCredential(f.paths, "hermes"); oc.addAgent("oc-p5-new"); hm.addAgent("hermes-p5-new");
    const { createAdapter } = await import(pathToFileURL(path.join(__dirname, "../resources/external-plugin-adapters/openclaw/index.mjs")).href);
    const adapter = createAdapter({ instanceId: "agent-setup-oc", credential: () => readCredential(f.paths, "openclaw"), requestService: (method, params, options) => requestService(f.paths, { id: uuid(), version: PROTOCOL_VERSION, method, params }, options) });
    const tools = new Map(); let beforeTool;
    adapter.register({ on(name, fn) { if (name === "before_tool_call") beforeTool = fn; }, registerTool(factory, { name }) { tools.set(name, factory); } });
    const ocCall = async (name, args, turn) => { const ctx = { agentId: "oc-p5-new", sessionId: "openclaw-p5-session", runId: turn }, id = uuid(); beforeTool({ toolName: name, toolCallId: id }, ctx); return (await tools.get(name)(ctx).execute(id, args)).details; };
    hermes = startHermes(f); await hermes.ready;
    for (const lane of [{ backend: "openclaw", host: oc, call: ocCall }, { backend: "hermes", host: hm, call: hermes.call }]) {
      const initial = confirmations.length;
      const result = await lane.call("mcp_server_add", { url: provider.origin + "/public?lane=" + lane.backend, name: "Agent " + lane.backend, purpose: "Continue external task" }, "setup");
      assert.equal(result.servers[0].status, "ready"); await delay(100); assert.equal(confirmations.length, initial);
      lane.host.idle = true;
      await until(() => f.service.mcpConnectorController.requests.get(result.request.requestId), v => v.status === "completed", lane.backend + " continuation");
      assert.equal(confirmations.length, initial + 1);
      assert.ok((await lane.call("mcp_server_tools", { serverId: result.servers[0].id, cursor: 0, limit: 20 }, "continued")).items.length);
      const pending = lane.call("mcp_server_call", { serverId: result.servers[0].id, toolName: "echo", arguments: { value: lane.backend + " continued" } }, "continued");
      const approvals = await until(() => rest("approvals"), v => v.items.some(item => item.backendId === lane.backend), "business approval");
      const item = approvals.items.find(item => item.backendId === lane.backend);
      await rest("approval-resolve", { requestId: item.requestId, argumentDigest: item.argumentDigest, approved: true });
      assert.equal((await pending).result.content[0].text, lane.backend + " continued");
      console.log("PASS " + lane.backend + ": actual adapter add, authoritative idle gate, one fixed continuation, next-turn tools and approved actual MCP call");
    }
    assert.equal(confirmations.length, 2);
    assert.equal(fs.readFileSync(f.service.mcpConnectorController.requestsPath, "utf8").includes(CANARY), false);
    await host.stop(); host = null; await f.backend.stop(); await f.service.stop(); await f.service.start(); await f.backend.start();
    assert.equal([...f.service.mcpConnectorController.requests.values()].every(r => r.status === "completed"), true);
    assert.equal(confirmations.length, 2);
    console.log("PASS restart: completed setup ledger survives without replay; public records and continuations contain no credentials");
  } finally {
    const failures = [];
    for (const close of [() => hermes?.close(), () => helper?.close(), () => host?.stop(), () => f?.close(), () => provider.close(), () => oauthProvider.close(), () => new Promise(resolve => { for (const socket of broker.clients) socket.terminate(); broker.close(resolve); })]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "setup e2e cleanup");
  }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { run: main };
