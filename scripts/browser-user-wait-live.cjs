#!/usr/bin/env node
"use strict";

// Real visible Chrome + official Playwright MCP + disposable Agent Service. The
// fake Runtime only holds a native turn open; no provider, account or shopping site
// is contacted. A local page changes via its server, standing in for a manual step.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { openBridgeFixture, waitUntil } = require("./fixtures/runtime-bridge-harness.cjs");
const { createPlaywrightMcpClient } = require("../app/agent-service/playwright-mcp-client");

async function main() {
  const events = [];
  let value, manualComplete = false, pageAcknowledged = false, launches = 0;
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", request.url === "/state" ? "application/json" : "text/html; charset=utf-8");
    if (request.url === "/state") response.end(JSON.stringify({ complete: manualComplete }));
    else if (request.url === "/ack") { pageAcknowledged = true; response.end("ok"); }
    else response.end('<!doctype html><title>Shoggoth local handoff test</title><h1 id="state">Waiting for manual step</h1><script>let done=false;setInterval(async()=>{if(done)return;const state=await (await fetch("/state")).json();if(state.complete){done=true;document.getElementById("state").textContent="Manual step complete";await fetch("/ack");}},100);</script>');
  });
  const ok = async (name, args) => {
    const result = (await value.callTool(name, args, 30_000).response).result;
    assert.equal(result.isError, false, JSON.stringify(result));
    return result.structuredContent;
  };
  const open = async () => {
    const pending = value.callTool("browser_session_open", value.source, 30_000);
    await value.confirm();
    const result = (await pending.response).result;
    assert.equal(result.isError, false, JSON.stringify(result));
    return { ...value.source, sessionId: result.structuredContent.sessionId };
  };
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    value = await openBridgeFixture({ serviceOptions: { browserClientFactory: async options => {
      assert.equal(options.settings.headless, false);
      assert.equal(options.settings.isolated, true);
      launches++;
      const client = await createPlaywrightMcpClient(options);
      return { listTools: () => client.listTools(), callTool: async (name, args) => {
        events.push({ name, sessionId: options.sessionId });
        return client.callTool(name, args);
      }, close: async () => { await client.close(); events.push({ name: "close", sessionId: options.sessionId }); } };
    } } });
    const scope = await open();
    await ok("browser_tool_call", { ...scope, toolName: "browser_navigate", arguments: { url: `http://127.0.0.1:${server.address().port}/` } });
    const before = await ok("browser_tool_call", { ...scope, toolName: "browser_snapshot", arguments: {} });
    assert.match(JSON.stringify(before), /Waiting for manual step/u);
    const pending = value.callTool("browser_session_wait_for_user", { ...scope, instructions: "完成本地测试页面中的人工步骤" }, 70_000);
    await waitUntil(() => value.run().status === "waiting_input", "browser handoff card");
    const started = Date.now(), callCount = events.length;
    // More than the usual 45-second Service tool deadline, with a real window.
    while (Date.now() - started < 46_000) {
      await value.service.browserUseController.reconcile();
      assert.equal((await value.service.browserUseController.status()).sessions[0].id, scope.sessionId);
      assert.equal(value.run().status, "waiting_input");
      assert.equal(events.length, callCount);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    manualComplete = true;
    await waitUntil(() => pageAcknowledged, "local page to finish the manual step");
    await value.answer("submit", { browser_user_action: "已完成操作" });
    const result = (await pending.response).result;
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.structuredContent.sessionId, scope.sessionId);
    assert.equal(result.structuredContent.canceled, false);
    assert.equal(result.structuredContent.untrusted, true);
    assert.match(JSON.stringify(result), /Manual step complete/u);
    assert.deepEqual(events.slice(callCount).map(event => event.name), ["browser_snapshot"]);
    assert.equal(launches, 1, "waiting and resuming must not relaunch Chrome");
    const cancel = value.callTool("browser_session_wait_for_user", { ...scope, instructions: "取消本地测试" });
    await value.answer("submit", { browser_user_action: "取消并关闭" });
    assert.equal((await cancel.response).result.structuredContent.canceled, true);
    assert.equal((await value.service.browserUseController.status()).sessions.length, 0);
    assert.equal(events.filter(event => event.name === "close").length, 1);
    const terminalScope = await open();
    await value.service.workRunCoordinator.abort({ operationId: "live-handoff-stop", sessionKey: value.session.sessionKey, runId: value.run().id });
    await waitUntil(() => events.some(event => event.name === "close" && event.sessionId === terminalScope.sessionId), "terminal Chrome exit");
    assert.equal((await value.service.browserUseController.status()).sessions.length, 0);
    const proof = { verified: true, realChrome: true, visible: true, isolated: true,
      serviceBridge: true, providerCalls: 0, waitedMs: Date.now() - started,
      keptSameSession: true, freshSnapshot: true, noActionsDuringWait: true,
      canceledCloses: true, terminalCloses: true, launches, events };
    if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify(proof, null, 2) + "\n");
    process.stdout.write(JSON.stringify(proof) + "\n");
  } finally {
    await value?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
