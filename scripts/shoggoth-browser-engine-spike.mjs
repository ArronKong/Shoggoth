#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const electron = path.join(
  ROOT, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);
if (!fs.existsSync(electron)) throw new Error("Electron binary missing");

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-browser-spike-")));
const fixture = path.join(temp, "fixture.mjs");
const source = String.raw`
import http from "node:http";
import { app, BrowserWindow, session } from "electron";

const result = {
  visible: false,
  axNodes: 0,
  clicked: false,
  typed: false,
  staleRejected: false,
  screenshotBytes: 0,
  tabs: 0,
  popupBlocked: false,
  permissionDenied: false,
  downloadBlocked: false,
};

app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/download") {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=blocked.bin" });
      response.end("blocked download");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end('<!doctype html><meta charset="utf-8"><title>Spike</title><button id="go">Run</button><input id="name" aria-label="Name"><div id="state"></div><script>go.onclick=()=>state.textContent="clicked"<\/script>');
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = "http://127.0.0.1:" + server.address().port;
  const partition = "browser-spike-" + process.pid;
  const browserSession = session.fromPartition(partition, { cache: false });
  browserSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    result.permissionDenied = true;
    callback(false);
  });
  browserSession.on("will-download", (event) => {
    result.downloadBlocked = true;
    event.preventDefault();
  });
  const window = new BrowserWindow({
    width: 900,
    height: 700,
    show: true,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => {
    result.popupBlocked = true;
    return { action: "deny" };
  });
  await window.loadURL(origin);
  result.visible = window.isVisible();
  const debug = window.webContents.debugger;
  debug.attach("1.3");
  await debug.sendCommand("DOM.enable");
  await debug.sendCommand("Accessibility.enable");
  await debug.sendCommand("Page.enable");
  const ax = await debug.sendCommand("Accessibility.getFullAXTree");
  result.axNodes = ax.nodes.length;
  const button = ax.nodes.find((node) => node.role?.value === "button" && node.name?.value === "Run");
  const textbox = ax.nodes.find((node) => node.role?.value === "textbox" && node.name?.value === "Name");
  if (!button?.backendDOMNodeId || !textbox?.backendDOMNodeId) throw new Error("AX refs missing");
  let revision = 1;
  const buttonRef = revision + ":" + button.backendDOMNodeId;
  const click = async (ref) => {
    const [expected, backend] = ref.split(":").map(Number);
    if (expected !== revision) throw Object.assign(new Error("stale"), { code: "STALE_REF" });
    const box = await debug.sendCommand("DOM.getBoxModel", { backendNodeId: backend });
    const x = (box.model.content[0] + box.model.content[4]) / 2;
    const y = (box.model.content[1] + box.model.content[5]) / 2;
    await debug.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await debug.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  await click(buttonRef);
  result.clicked = await window.webContents.executeJavaScript('document.querySelector("#state").textContent === "clicked"');
  await debug.sendCommand("DOM.focus", { backendNodeId: textbox.backendDOMNodeId });
  await debug.sendCommand("Input.insertText", { text: "Shoggoth" });
  result.typed = await window.webContents.executeJavaScript('document.querySelector("#name").value === "Shoggoth"');
  revision += 1;
  try { await click(buttonRef); } catch (error) { result.staleRejected = error.code === "STALE_REF"; }
  const screenshot = await debug.sendCommand("Page.captureScreenshot", { format: "jpeg", quality: 45 });
  result.screenshotBytes = Buffer.from(screenshot.data, "base64").length;
  await window.webContents.executeJavaScript('window.open("https://example.com", "_blank")');
  const second = new BrowserWindow({ show: false, webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await second.loadURL(origin);
  result.tabs = BrowserWindow.getAllWindows().length;
  await window.webContents.executeJavaScript('navigator.mediaDevices?.getUserMedia({audio:true}).catch(()=>{})');
  await window.webContents.executeJavaScript('(()=>{const a=document.createElement("a");a.href="/download";a.download="blocked.bin";document.body.append(a);a.click()})()');
  await new Promise((resolve) => setTimeout(resolve, 100));
  debug.detach();
  second.destroy();
  window.destroy();
  await new Promise((resolve) => server.close(resolve));
  process.stdout.write(JSON.stringify(result));
  app.quit();
}).catch((error) => {
  process.stderr.write(String(error?.stack || error));
  app.exit(1);
});
`;
fs.writeFileSync(fixture, source, { mode: 0o600 });

try {
  const child = spawn(electron, [pathToFileURL(fixture).pathname], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("browser spike timeout"));
    }, 20_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (value) => { clearTimeout(timer); resolve(value); });
  });
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.visible, true);
  assert.equal(result.axNodes > 0, true);
  assert.equal(result.clicked, true);
  assert.equal(result.typed, true);
  assert.equal(result.staleRejected, true);
  assert.equal(result.screenshotBytes > 0, true);
  assert.equal(result.tabs, 2);
  assert.equal(result.popupBlocked, true);
  assert.equal(result.permissionDenied, true);
  assert.equal(result.downloadBlocked, true);
  console.log(`PASS Electron+CDP browser spike ${JSON.stringify(result)}`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
