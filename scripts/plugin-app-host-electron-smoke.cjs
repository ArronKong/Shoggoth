#!/usr/bin/env node
"use strict";

// This fixture never starts Shoggoth's main app or Service. Only local loopback
// listeners, a disposable Electron profile and the dedicated App Host are used.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const moduleRootArgument = process.argv.find(value => value.startsWith("--module-root="));
const moduleRoot = moduleRootArgument?.slice("--module-root=".length) || path.resolve(__dirname, "../app");
assert(path.isAbsolute(moduleRoot) && !moduleRoot.includes("\0"), "absolute source or packaged module root required");

if (!process.versions.electron) {
  const { spawnSync } = require("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-app-host-"));
  const output = path.resolve(process.argv.find(value => value.startsWith("--output-dir="))?.slice("--output-dir=".length)
    || path.join(__dirname, "../.artifacts/plugin-app-host-source"));
  try {
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(require("electron"), [__filename, "--fixture", root, output, `--module-root=${moduleRoot}`], {
      env, encoding: "utf8", timeout: 45_000, maxBuffer: 2 * 1024 * 1024,
    });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    assert.equal(child.status, 0, `Electron smoke failed: ${child.error || child.signal || child.stderr}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
} else {
  const { app, BrowserWindow, ipcMain, session } = require("electron");
  const { DesktopPluginAppHost } = require(path.join(moduleRoot, "desktop-plugin-app-host"));
  const { normalizeAppResource } = require(path.join(moduleRoot, "agent-service/plugin-app-session"));
  const at = process.argv.indexOf("--fixture");
  assert.ok(at > 0 && process.argv[at + 1] && process.argv[at + 2]);
  const root = process.argv[at + 1], output = process.argv[at + 2];
  app.setPath("userData", path.join(root, "user-data"));
  app.setPath("sessionData", path.join(root, "sessions"));
  app.setName("Shoggoth isolated plugin App fixture");
  app.on("window-all-closed", () => {});
  const timeout = setTimeout(() => { console.error("Plugin App renderer fixture timed out"); app.exit(1); }, 35_000);
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  async function waitFor(predicate, message) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) { if (predicate()) return; await delay(25); }
    throw new Error(message);
  }
  app.whenReady().then(async () => {
    let host, canary;
    const requests = [], closes = [], incoming = [];
    try {
      canary = http.createServer((request, response) => { incoming.push(request.url); response.end("UNEXPECTED"); });
      await new Promise(resolve => canary.listen(0, "127.0.0.1", resolve));
      const canaryUrl = `http://127.0.0.1:${canary.address().port}/forbidden`;
      const seeds = [
        { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { city: "fixture" } } },
        { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {
          content: [{ type: "text", text: "</script><script>globalThis.seedEscaped=true</script>" }] } },
      ];
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        body{font:17px system-ui;background:#131622;color:#e8ecff;padding:34px}h1{font-size:28px}
        .status{background:#203d37;border:1px solid #39796a;border-radius:14px;padding:22px;margin-top:26px}
        code{color:#8ee3c7}p{line-height:1.55;color:#bec8e3}
        </style></head><body><h1>Isolated MCP App</h1><p>Source renderer fixture · 本地隔离验收</p>
        <div class="status" id="status">Waiting for bridge response…</div><div id="child-only">Opaque sandbox</div>
        <script>
        (async()=>{
          let parentBlocked=false,storageBlocked=false;
          try{void parent.document.body;}catch{parentBlocked=true;}
          try{localStorage.setItem('fixture','no');}catch{storageBlocked=true;}
          let fetchBlocked=false;try{await fetch(${JSON.stringify(canaryUrl)});}catch{fetchBlocked=true;}
          const image=new Image();image.src=${JSON.stringify(`${canaryUrl}?image=1`)};
          const popup=window.open(${JSON.stringify(`${canaryUrl}?popup=1`)});
          addEventListener('message',event=>{
            if(event.source!==parent)return;
            if(event.data?.id==='initialize'&&event.data?.result?.ok){
              parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');
            }
            if(['ui/notifications/tool-input','ui/notifications/tool-result'].includes(event.data?.method)){
              parent.postMessage({jsonrpc:'2.0',method:'fixture/seed',params:event.data},'*');
            }
            if(event.source===parent&&event.data?.id==='report'&&event.data?.result?.ok){
              document.getElementById('status').textContent='Bridge verified · Network and permissions denied';
              parent.postMessage({jsonrpc:'2.0',method:'fixture/response-observed',params:{}},'*');
            }
          });
          parent.postMessage({jsonrpc:'2.0',id:'initialize',method:'ui/initialize',params:{}},'*');
          parent.postMessage({jsonrpc:'2.0',id:'report',method:'fixture/report',params:{
            origin:globalThis.origin,parentBlocked,storageBlocked,fetchBlocked,popupBlocked:popup===null,
            bridge:typeof pluginAppBridge,node:typeof require,process:typeof process,
            desktop:typeof openclawDesktop}},'*');
        })();
        </script></body></html>`;
      const policy = normalizeAppResource({ tool: { _meta: { ui: { resourceUri: "ui://fixture/app" } } },
        resource: { uri: "ui://fixture/app", mimeType: "text/html;profile=mcp-app", text: html } }).policy;
      const bytes = Buffer.from(html), chunks = [];
      for (let offset = 0; offset < bytes.length; offset += 18 * 1024) {
        chunks.push(bytes.subarray(offset, offset + 18 * 1024).toString("base64"));
      }
      let transport;
      const created = [];
      class FixtureWindow {
        constructor(options) {
          const window = new BrowserWindow(options); created.push(window);
          window.webContents.on("preload-error", (_event, _file, error) => { console.error("Preload error", error); });
          for (const event of ["did-navigate", "did-frame-navigate", "did-fail-load"]) {
            window.webContents.on(event, (_event, ...details) => {
              if (process.env.PLUGIN_APP_SMOKE_DEBUG === "1") console.log("fixture navigation", event, JSON.stringify(details));
            });
          }
          return window;
        }
      }
      host = new DesktopPluginAppHost({ BrowserWindow: FixtureWindow, ipcMain, session });
      const openOptions = { async create({ sandboxOrigin, sourceId }) {
        transport = { sessionId: "a".repeat(64), nonce: "b".repeat(64), sourceId,
          origin: sandboxOrigin, conversationId: "fixture-conversation" };
        return { canceled: false, descriptor: { sandboxOrigin, transport, expiresAt: Date.now() + 20_000,
          policy, initialNotifications: seeds, resource: { encoding: "base64", byteLength: bytes.length, chunkCount: chunks.length,
            contentDigest: crypto.createHash("sha256").update(bytes).digest("hex") } } };
      }, async readChunk(received, index) {
        assert.deepEqual(received, transport); return { index, data: chunks[index], total: chunks.length };
      }, async message(received, message) {
        assert.deepEqual(received, transport); requests.push(message);
        return message.id ? { jsonrpc: "2.0", id: message.id, result: { ok: true } } : null;
      }, async close(received) { assert.deepEqual(received, transport); closes.push(received); } };
      await host.open(openOptions);
      const window = created[0];
      await waitFor(() => requests.some(item => item.method === "fixture/response-observed"), "Opaque child did not complete bridge roundtrip");
      await waitFor(() => requests.filter(item => item.method === "fixture/seed").length === 2,
        "initialized child did not receive tool input/result notifications");
      assert.deepEqual(requests.filter(item => item.method === "fixture/seed").map(item => item.params), seeds);
      const report = requests.find(item => item.method === "fixture/report").params;
      assert.deepEqual(report, { origin: "null", parentBlocked: true, storageBlocked: true,
        fetchBlocked: true, popupBlocked: true, bridge: "undefined", node: "undefined",
        process: "undefined", desktop: "undefined" });
      const outer = await window.webContents.executeJavaScript(`({
        iframe:document.querySelectorAll('iframe').length,
        sandbox:document.querySelector('iframe').getAttribute('sandbox'),
        childSibling:document.querySelector('#child-only')!==null,
        seedEscaped:globalThis.seedEscaped===true,
        bridge:typeof pluginAppBridge,desktop:typeof openclawDesktop,node:typeof require
      })`);
      assert.deepEqual(outer, { iframe: 1, sandbox: "allow-scripts", childSibling: false,
        seedEscaped: false, bridge: "object", desktop: "undefined", node: "undefined" });
      assert.equal(window.webContents.session.isPersistent(), false);
      assert.equal(window.webContents.session.getStoragePath(), null);
      assert.equal(BrowserWindow.getAllWindows().length, 1);
      const before = requests.length;
      await window.webContents.executeJavaScript("window.postMessage({jsonrpc:'2.0',id:'forged',method:'fixture/spoof'},'*')");
      await delay(100);
      assert.equal(requests.length, before, "main frame cannot spoof the child postMessage source");
      const capturePath = path.join(output, "opaque-app-renderer.png");
      fs.writeFileSync(capturePath, (await window.webContents.capturePage()).toPNG());
      const child = window.webContents.mainFrame.frames.find(frame => frame.url === "about:srcdoc");
      assert.ok(child, "native frame tree must show one srcdoc child");
      await child.executeJavaScript(`location.href=${JSON.stringify(canaryUrl)}`);
      await delay(100);
      await waitFor(() => window.isDestroyed() && closes.length === 1,
        "failed child navigation must destroy renderer and release authority");
      await delay(100);
      assert.deepEqual(incoming, [], "no canary request may leave the plugin partition");
      // about:blank navigation can bypass will-navigate in Chromium; the
      // committed-navigation guard must still remove the privileged wrapper.
      await host.open(openOptions);
      const second = created[1];
      await waitFor(() => requests.filter(item => item.method === "fixture/response-observed").length === 2,
        "second opaque child did not initialize");
      try { await second.webContents.executeJavaScript("location.href='about:blank'"); }
      catch (error) { assert.match(String(error), /disposed|destroyed|frame|context/iu); }
      await waitFor(() => second.isDestroyed() && closes.length === 2,
        "committed main-frame navigation must destroy renderer and release authority");
      await host.closeAll();
      assert.equal(closes.length, 2);
      assert.equal(BrowserWindow.getAllWindows().length, 0);
      await assert.rejects(fetch(`${transport.origin}/unreachable`));
      fs.writeFileSync(path.join(output, "evidence.json"), `${JSON.stringify({ electron: process.versions.electron,
        source: path.join(moduleRoot, "desktop-plugin-app-host.js"), report, outer, canaryRequests: incoming.length,
        authorityCloses: closes.length, screenshot: capturePath }, null, 2)}\n`);
      console.log(`plugin App native source renderer: PASS ${capturePath}`);
    } catch (error) {
      console.error("Native fixture assertion failed", error);
      throw error;
    } finally {
      await host?.closeAll();
      if (canary?.listening) await new Promise(resolve => canary.close(resolve));
      clearTimeout(timeout);
    }
  }).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
}
