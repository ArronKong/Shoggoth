#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const { build } = createRequire(path.join(uiRoot, "package.json"))("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-agent-capsule-"));
let serving = false;
let server;
try {
  await build({ entryPoints: [path.join(root, "scripts/fixtures/chat-agent-capsule.tsx")], bundle: true,
    format: "esm", define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(uiRoot, "node_modules")], logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><title>Agent 胶囊交互 · 隔离预览</title><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}#root{display:flex;flex-direction:column}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://fixture").pathname;
    if (pathname.startsWith("/avatar/")) {
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="48" fill="#d6e8dc"/><circle cx="48" cy="49" r="28" fill="#eef5e3"/><circle cx="38" cy="43" r="4" fill="#244d46"/><circle cx="58" cy="43" r="4" fill="#244d46"/><path d="M38 59Q48 69 58 59" fill="none" stroke="#244d46" stroke-width="3" stroke-linecap="round"/></svg>');
      return;
    }
    const file = ({ "/": "index.html", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css" })[pathname];
    if (!file) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", file.endsWith("js") ? "text/javascript" : file.endsWith("css") ? "text/css" : "text/html");
    res.end(fs.readFileSync(path.join(temp, file)));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${server.address().port}/#/chat`;
  if (process.argv.includes("--serve")) {
    serving = true;
    console.log(`PREVIEW ${url}`);
    const close = () => { server.close(); server.closeAllConnections(); fs.rmSync(temp, { recursive: true, force: true }); process.exit(); };
    process.on("SIGTERM", close);
    process.on("SIGINT", close);
  } else {
    const reviewDir = process.env.CHAT_CAPSULE_REVIEW_DIR || path.join(temp, "review");
    fs.mkdirSync(reviewDir, { recursive: true });
    const main = path.join(temp, "main.cjs");
    fs.writeFileSync(main, `const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
app.setPath("userData", ${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1360, height: 950, webPreferences: { backgroundThrottling: false } });
  let passed = false;
  try {
    await window.loadURL(${JSON.stringify(url)});
    console.log(JSON.stringify(await window.webContents.executeJavaScript("window.runCapsuleFixture()", true)));
    for (const [view, theme, width, height] of [["profile", "light", 1360, 950], ["cron", "light", 1360, 950], ["inspiration", "light", 1360, 950], ["profile", "dark", 1360, 950], ["profile", "light", 600, 800], ["inspiration", "light", 600, 800], ["profile", "light", 390, 844], ["inspiration", "light", 390, 844]]) {
      window.setSize(width, height);
      await window.webContents.executeJavaScript("window.prepareCapsuleShot(" + JSON.stringify(view) + "," + JSON.stringify(theme) + ")", true);
      let geometry;
      // Watch several frames so a height/visibility feedback loop cannot pass
      // just because the screenshot happened to land on its smaller frame.
      for (let sample = 0; sample < 4; sample++) {
        geometry = await window.webContents.executeJavaScript(
        "(() => { const header = document.querySelector('.chat-header'); const region = document.getElementById('chat-agent-panel'); const composer = document.querySelector('.chat-botdock'); return { width: header.offsetWidth, headerHeight: header.offsetHeight, regionHeight: region.offsetHeight, overflow: header.scrollWidth > header.clientWidth + 1, overlapsComposer: header.getBoundingClientRect().bottom > composer.getBoundingClientRect().top - 8, controls: Array.from(header.querySelectorAll('.chat-header__tools > button:not([hidden])')).map(button => ({title: button.title, disabled: button.disabled})) }; })()", true);
        if (geometry.overflow) throw Error("Capsule overflow at " + width + "px " + JSON.stringify(geometry));
        if (geometry.overlapsComposer) throw Error("Capsule overlaps the composer at " + width + "px " + JSON.stringify(geometry));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const shot = await window.webContents.capturePage();
      fs.writeFileSync(${JSON.stringify(reviewDir)} + "/" + view + "-" + theme + "-" + width + ".png", shot.toPNG());
      console.log(JSON.stringify({ view, theme, viewport: [width, height], ...geometry }));
    }
    passed = true;
  } catch (error) {
    console.error(error);
    console.error(await window.webContents.executeJavaScript("JSON.stringify({ text: document.body.innerText.slice(0, 2500), error: window.fixtureError, requests: window.requests.slice(-8) })"));
  } finally { window.destroy(); app.exit(passed ? 0 : 1); }
});`);
    const child = createRequire(path.join(root, "package.json"))("electron");
    const result = await new Promise(resolve => {
      // Keep the loopback server responsive while Electron executes the fixture.
      const childProcess = spawn(child, [main], { env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
      let stdout = "", stderr = "";
      childProcess.stdout.on("data", value => { stdout += value; });
      childProcess.stderr.on("data", value => { stderr += value; });
      const timeout = setTimeout(() => childProcess.kill("SIGTERM"), 60_000);
      childProcess.on("error", error => { clearTimeout(timeout); resolve({ status: null, stdout, stderr: String(error) }); });
      childProcess.on("exit", (status, signal) => { clearTimeout(timeout); resolve({ status, signal, stdout, stderr }); });
    });
    server.close(); server.closeAllConnections();
    process.stdout.write(result.stdout);
    if (result.status !== 0) process.stderr.write(result.stderr);
    assert.equal(result.status, 0, "Agent capsule UI fixture must exit naturally with success");
    assert.match(result.stdout, /"passed":true/);
  }
} finally {
  if (!serving) { server?.close(); server?.closeAllConnections(); fs.rmSync(temp, { recursive: true, force: true }); }
}
