#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { once } = require("node:events");
if (!process.versions.electron) {
  const root = fs.mkdtempSync("/private/tmp/native-ui-navigation-"), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = require("node:child_process").spawnSync(process.env.NATIVE_CHAT_UI_ELECTRON || require("electron"), [__filename, root], { env, stdio: "inherit", timeout: 40000 });
    assert.equal(result.status, 0, `navigation fixture failed: ${result.error || result.signal}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
} else {
  const { app, BrowserWindow, WebContentsView, ipcMain, session, webContents } = require("electron");
  const { DesktopChatUiHost } = require("../app/desktop-chat-ui-host");
  process.on("unhandledRejection", error => { console.error(error); app.exit(1); });
  app.setPath("userData", path.join(process.argv[2], "data")); app.setPath("sessionData", path.join(process.argv[2], "sessions")); app.on("window-all-closed", () => {});
  async function waitFor(check, label) { const end = Date.now() + 8000; while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error(label); }
  async function run() {
    await app.whenReady(); let owner, host; const closed = [], checks = [];
    const server = http.createServer((_request, response) => { response.writeHead(200, { "Content-Type": "text/html" }); response.end("<!doctype html><h1>Owned document lifecycle fixture</h1><iframe id=child></iframe>"); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    try {
      owner = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } }); await owner.loadURL(url);
      host = new DesktopChatUiHost({ WebContentsView, ipcMain, session, webContents });
      const listeners = owner.webContents.listenerCount("did-start-navigation");
      const mount = id => host.mount({ ownerWindow: owner, mountId: id, html: "<!doctype html><h2>Navigation card</h2>", descriptor: { title: "Navigation card" }, onMessage: async () => null, onClose: async () => closed.push(id) });
      await mount("before-reload"); const before = host.entries.get("before-reload"), child = before.view.webContents, resourceUrl = before.url;
      const hashNavigation = once(owner.webContents, "did-navigate-in-page"); await owner.webContents.executeJavaScript("location.hash='same-document';void 0"); await hashNavigation;
      assert.equal(host.entries.get("before-reload"), before); assert.deepEqual(closed, []); checks.push("same-document-navigation-preserves-card");
      await owner.webContents.executeJavaScript(`new Promise(resolve=>{const frame=document.querySelector('#child');frame.onload=()=>resolve(true);frame.src=${JSON.stringify(url + "child")};})`);
      assert.equal(host.entries.get("before-reload"), before); checks.push("owner-subframe-navigation-preserves-card");
      const loaded = once(owner.webContents, "did-finish-load"); owner.reload(); await loaded;
      await waitFor(() => closed.includes("before-reload"), "owner reload did not release its mounted card");
      assert.equal(host.entries.size, 0); assert.equal(host.byContents.size, 0); assert.equal(child.isDestroyed(), true); checks.push("main-document-reload-disposes-old-card-and-close-callback");
      await assert.rejects(fetch(resourceUrl), /fetch failed/); checks.push("old-private-resource-port-closed");
      await mount("after-reload"); assert.equal(host.entries.size, 1); assert.deepEqual(closed, ["before-reload"]); checks.push("new-document-can-mount-a-fresh-card");
      await host.close("after-reload"); assert.equal(owner.webContents.listenerCount("did-start-navigation"), listeners); assert.deepEqual(closed, ["before-reload", "after-reload"]); checks.push("owner-navigation-listener-released");
      await mount("owner-destroyed"); owner.destroy();
      await waitFor(() => closed.includes("owner-destroyed"), "destroyed owner did not release its card");
      assert.equal(host.entries.size, 0); checks.push("destroyed-owner-releases-card-without-unhandled-error");
      const output = process.env.NATIVE_CHAT_UI_NAVIGATION_OUTPUT;
      const result = { status: "passed", checks, electron: process.versions.electron, architecture: process.arch, interface: "actual-Electron-Host-document-lifecycle", nativeUserInput: false, agentRuns: 0 };
      if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n"); }
      console.log("PASS native UI owner navigation", JSON.stringify(result));
    } finally { await host?.closeAll(); owner?.destroy(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  }
  const deadline = setTimeout(() => { console.error("navigation fixture deadline"); app.exit(1); }, 35000);
  run().then(() => { clearTimeout(deadline); app.quit(); }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
