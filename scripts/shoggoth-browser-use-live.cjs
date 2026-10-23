"use strict";

// Real official Playwright MCP + Chrome, local pages and disposable owned data only.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { BrowserUseController } = require("../app/agent-service/browser-use-controller");

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-browser-live-")));
  const settings = { enabled: true, browser: "chrome", headless: true, isolated: true };
  const controller = new BrowserUseController({ paths: { stateDir: path.join(root, "state"), trustedRoot: root },
    getSettings: () => settings, isAuthorized: () => true });
  controller.open();
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(request.url === "/large" ? '<title>Large</title>' + '<button>大型网页内容</button>'.repeat(5000)
      : '<!doctype html><title>Browser Use Fixture</title><h1>Browser Use Fixture</h1><label>Name<input id="name"></label><button id="increment" onclick="count.textContent=Number(count.textContent)+1">Increment</button><output id="count">0</output><a href="/next">Next page</a>');
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const url = `http://127.0.0.1:${server.address().port}/`;
    const create = (profileId, workRunId) => controller.create({ profileId, workRunId, workspace: root });
    const common = session => ({ profileId: session.profileId, workRunId: session.workRunId, sessionId: session.id });
    const call = async (session, toolName, args) => {
      const result = await controller.callTool({ ...common(session), toolName, arguments: args });
      assert.equal(result.isError, false, JSON.stringify(result));
      return result;
    };
    const text = result => result.content.map(part => part.text).join("\n");
    const ref = (result, name) => {
      const line = text(result).split("\n").find(value => value.includes(`"${name}"`) && value.includes("ref="));
      assert.ok(line, `No snapshot ref for ${name}: ${text(result).slice(0, 2000)}`);
      return line.match(/ref=([^\]\s]+)/u)[1];
    };
    const a = await create("agent-a", "run-a");
    const tools = controller.listTools(common(a)).tools;
    for (const name of ["browser_navigate", "browser_snapshot", "browser_type", "browser_tabs", "browser_take_screenshot"]) assert.ok(tools.some(tool => tool.name === name));
    assert.ok(!tools.some(tool => tool.name === "browser_run_code_unsafe"));
    await call(a, "browser_navigate", { url });
    assert.equal(a.expiresAt, null);
    await controller.reconcile();
    assert.equal((await controller.status()).sessions[0].id, a.id);
    const first = await call(a, "browser_snapshot", {});
    await call(a, "browser_type", { target: ref(first, "Name"), text: "Shoggoth Browser Use" });
    const fresh = await call(a, "browser_snapshot", {});
    await call(a, "browser_click", { target: ref(fresh, "Increment") });
    const state = await call(a, "browser_evaluate", { function: '() => ({name:document.querySelector("#name").value,count:document.querySelector("#count").textContent})' });
    assert.match(text(state), /Shoggoth Browser Use/u); assert.match(text(state), /"count": "1"/u);
    await call(a, "browser_evaluate", { function: '() => {document.cookie="browser_fixture=agent-a; Max-Age=3600; Path=/"; return document.cookie;}' });
    const b = await create("agent-b", "run-b");
    await call(b, "browser_navigate", { url });
    assert.doesNotMatch(text(await call(b, "browser_evaluate", { function: "() => document.cookie" })), /browser_fixture/u);
    await controller.closeSession(common(b));
    await call(a, "browser_tabs", { action: "new", url: url + "next" });
    assert.match(text(await call(a, "browser_tabs", { action: "list" })), /1:/u);
    await call(a, "browser_take_screenshot", { scale: "css", type: "png" });
    const artifacts = path.join(root, "browser-output", a.id);
    assert.ok(fs.readdirSync(artifacts).some(name => name.endsWith(".png")));
    await assert.rejects(controller.callTool({ ...common(a), toolName: "browser_navigate", arguments: { url: "file:///etc/passwd" } }), error => error.code === "BROWSER_ARGUMENTS_INVALID");
    await call(a, "browser_navigate", { url: url + "large" });
    const large = await call(a, "browser_snapshot", {});
    assert.equal(large.outputTruncated, true); assert.ok(Buffer.byteLength(JSON.stringify(large)) < 48 * 1024);
    await controller.closeSession(common(a));
    const again = await create("agent-a", "run-a2");
    await call(again, "browser_navigate", { url });
    assert.doesNotMatch(text(await call(again, "browser_evaluate", { function: "() => document.cookie" })), /browser_fixture/u);
    await controller.closeSession(common(again));
    settings.isolated = false;
    const persistent = await create("agent-a", "persist-1");
    await call(persistent, "browser_navigate", { url });
    await call(persistent, "browser_evaluate", { function: '() => {document.cookie="browser_fixture=persistent; Max-Age=3600; Path=/"; return document.cookie;}' });
    await controller.closeSession(common(persistent));
    const restored = await create("agent-a", "persist-2");
    await call(restored, "browser_navigate", { url });
    assert.match(text(await call(restored, "browser_evaluate", { function: "() => document.cookie" })), /browser_fixture=persistent/u);
    settings.enabled = false;
    assert.equal((await controller.status()).reason, "BROWSER_DISABLED");
    assert.equal((await controller.status()).sessions.length, 0);
    console.log(JSON.stringify({ verified: true, engine: "@playwright/mcp 0.0.82", browser: "Chrome", tools: tools.length,
      noFixedSessionDeadline: true, navigation: true, click: true, typing: true, tabs: true, screenshot: true, largeOutput: true,
      agentIsolation: true, temporaryStateCleared: true, persistentStateRestored: true, disabledCleanup: true }));
  } finally {
    await controller.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
