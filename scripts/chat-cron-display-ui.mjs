#!/usr/bin/env node
// Real ChatPage, synthetic API/WS history, isolated Electron/browser storage.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, ".."), ui = path.join(root, "app/manage-ui");
const sourceRoot = process.env.CHAT_CRON_SOURCE_ROOT || root;
const require = createRequire(path.join(ui, "package.json"));
const { build } = require("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "chat-cron-display-"));
const output = process.env.CHAT_CRON_OUTPUT;
let serving = false, server;
try {
  const contents = fs.readFileSync(path.join(root, "scripts/fixtures/chat-cron-display.tsx"), "utf8")
    .replaceAll('"../../app/', '"' + sourceRoot + '/app/');
  await build({ stdin: { contents, sourcefile: "chat-cron-display.tsx", resolveDir: path.join(root, "scripts/fixtures"), loader: "tsx" },
    bundle: true, format: "esm", jsx: "automatic", nodePaths: [path.join(ui, "node_modules")],
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><title>隔离 Cron 聊天显示验收</title><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;height:100%;min-height:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  if (process.argv.includes("--serve")) {
    server = http.createServer((req, res) => {
      const file = { "/": "index.html", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css" }[new URL(req.url, "http://fixture").pathname];
      if (!file) { res.writeHead(404); res.end(); return; }
      res.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
      res.end(fs.readFileSync(path.join(temp, file)));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); serving = true;
    console.log("PREVIEW http://127.0.0.1:" + server.address().port + "/#/chat");
    const close = () => { server.close(); server.closeAllConnections(); fs.rmSync(temp, { recursive: true, force: true }); process.exit(); };
    process.on("SIGINT", close); process.on("SIGTERM", close);
  } else {
    if (output) fs.mkdirSync(output, { recursive: true });
    const run = async ({ temp, output, mode }) => {
      const { app, BrowserWindow } = require("electron");
      const fs = require("node:fs"), path = require("node:path");
      app.setPath("userData", path.join(temp, "profile")); await app.whenReady();
      const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { backgroundThrottling: false } });
      let passed = false;
      try {
        const results = [];
        for (const view of mode ? [mode] : ["normal", "immersive"]) for (const [language, width, height] of [["zh-CN", 1200, 900], ["en", 600, 800]]) {
          win.setSize(width, height);
          await win.loadFile(path.join(temp, "index.html"), { query: { mode: view, language }, hash: "/chat" });
          results.push(await win.webContents.executeJavaScript("window.runCronDisplayFixture()", true));
          console.log(JSON.stringify(results.at(-1)));
          if (output) fs.writeFileSync(path.join(output, view + "-" + language + ".png"), (await win.webContents.capturePage()).toPNG());
        }
        if (output) fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(results, null, 2));
        passed = true;
      } catch (error) {
        console.error(error.stack || error);
        console.error(await win.webContents.executeJavaScript("document.body.innerText.slice(0, 1200)"));
        if (output) fs.writeFileSync(path.join(output, "failure.png"), (await win.webContents.capturePage()).toPNG());
      } finally { win.destroy(); app.exit(passed ? 0 : 1); }
    };
    const main = path.join(temp, "main.cjs");
    fs.writeFileSync(main, "(" + run.toString() + ")(" + JSON.stringify({ temp, output, mode: process.env.CHAT_CRON_MODE })
      + ").catch(error => { console.error(error); require('electron').app.exit(1); });");
    const child = spawn(createRequire(path.join(root, "package.json"))("electron"), [main], {
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", bytes => process.stdout.write(bytes)); child.stderr.on("data", bytes => process.stderr.write(bytes));
    const timer = setTimeout(() => child.kill("SIGTERM"), 90_000);
    let status;
    try { status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(status, 0, "Cron display UI regression must exit naturally with success");
  }
} finally { if (!serving) fs.rmSync(temp, { recursive: true, force: true }); }
