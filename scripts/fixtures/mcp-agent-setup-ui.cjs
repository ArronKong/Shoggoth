#!/usr/bin/env node
"use strict";
// UI acceptance: real compiled product, REST, setup installer, OAuth and WorkRun
// continuation. Fixture supplies the trusted owner; helper binding is tested in
// mcp-agent-setup-e2e.cjs. No production accounts or preferences are touched.
const assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs"), http = require("node:http");
const { startUiAcceptance } = require("./mcp-connector-ui-acceptance.cjs");
const { until } = require("../mcp-connector-agent-lanes-e2e.cjs");
async function start() {
  const ui = await startUiAcceptance(), f = ui.fixture, uuid = () => crypto.randomUUID();
  const created = await f.ipc("agent.create", { operationId: uuid(), backendId: "shoggoth", name: "Agent setup UI acceptance", defaultCwd: null, createdAt: Date.now() });
  const profile = f.service.productStore.getAgentProfile(created.profile.id);
  const session = (await f.ipc("chat.session.create", { operationId: uuid(), profileId: profile.id, workspace: f.paths.defaultWorkspaceDir, createdAt: Date.now() })).session;
  const { run } = await f.ipc("chat.send", { operationId: uuid(), sessionKey: session.sessionKey, prompt: "Prepare this disposable connector UI validation.", createdAt: Date.now() });
  await f.service.workRunCoordinator.waitForTerminal(run.id);
  const owner = { profileId: profile.id, agentId: profile.agentId || profile.id, backendId: "shoggoth", sessionKey: session.sessionKey, transcriptSessionId: session.id, runId: run.id };
  let setup = null, started = false, closed = false;
  const state = () => ({ disposable: true, productUrl: ui.productUrl, providerUrl: ui.controlUrl, sessionKey: session.sessionKey, profileId: profile.id,
    setup, servers: ui.state().servers, requests: [...f.service.mcpConnectorController.requests.values()].map(r => ({ requestId: r.requestId, status: r.status, continuation: r.continuation })),
    workRuns: f.service.productStore.listWorkRuns().filter(r => r.sourceId === session.sessionKey).map(r => ({ id: r.id, status: r.status })) });
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/start") {
        assert.equal(started, false); started = true;
        setup = await f.service.mcpConnectorController.agentSetup.install("mcp_server_import", { purpose: "Complete the original task after user authentication", config: JSON.stringify({ mcpServers: {
          "Agent URL 验证": { url: ui.controlUrl + "/public/1.0.0" },
          "Agent JSON 密钥": { url: ui.controlUrl + "/header", headers: { Authorization: "Bearer ${TOKEN}" } },
          "Agent OAuth 登录": { url: ui.controlUrl + "/mcp" },
        } }) }, owner);
      } else assert.equal(req.url, "/state");
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(state()));
    } catch (error) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: error.code || error.message })); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const info = { ...state(), controlUrl: `http://127.0.0.1:${server.address().port}` };
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(info, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(info));
  const close = async () => {
    if (closed) return; closed = true;
    if (setup && [...f.service.mcpConnectorController.requests.values()].every(r => r.status === "completed")) {
      await until(() => f.service.productStore.listWorkRuns().filter(r => r.sourceId === session.sessionKey), rows => rows.length === 2 && rows.every(r => r.status === "completed"), "one UI continuation");
      console.log("PASS browser setup state: three connectors ready, one automatic completed continuation");
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await ui.close();
  };
  process.once("SIGINT", () => close().then(() => process.exit(0))); process.once("SIGTERM", () => close().then(() => process.exit(0)));
}
start().catch(error => { console.error(error.stack); process.exitCode = 1; });
