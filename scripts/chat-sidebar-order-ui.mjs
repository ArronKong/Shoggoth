#!/usr/bin/env node
// Actual ChatPage with synthetic API/WS data and a private Electron profile.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const require = createRequire(path.join(uiRoot, "package.json"));
const { build } = require("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-sidebar-order-"));
const output = process.env.CHAT_SIDEBAR_ORDER_OUTPUT || null;
let serving = false, server;
try {
  await build({ entryPoints: [path.join(root, "scripts/fixtures/chat-sidebar-order.tsx")], bundle: true,
    format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    nodePaths: [path.join(uiRoot, "node_modules")],
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"),
    '<!doctype html><meta charset="utf-8"><title>Chat sidebar ordering fixture</title><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;height:100%;min-height:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  if (process.argv.includes("--serve")) {
    server = http.createServer((req, res) => {
      const file = { "/": "index.html", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css" }[new URL(req.url, "http://fixture").pathname];
      if (!file) { res.writeHead(404); res.end(); return; }
      res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
      res.end(fs.readFileSync(path.join(temp, file)));
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    serving = true;
    console.log("PREVIEW http://127.0.0.1:" + server.address().port + "/#/chat");
    const close = () => { server.close(); server.closeAllConnections(); fs.rmSync(temp, { recursive: true, force: true }); process.exit(); };
    process.on("SIGINT", close); process.on("SIGTERM", close);
  } else {
    if (output) fs.mkdirSync(output, { recursive: true });
    const main = path.join(temp, "main.cjs");
    const runElectron = async ({ temp, output, scenario }) => {
      const { app, BrowserWindow } = require("electron");
      const fs = require("node:fs"), path = require("node:path");
      app.setPath("userData", path.join(temp, "profile"));
      await app.whenReady();
      const window = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { backgroundThrottling: false } });
      let passed = false;
      try {
        const results = [];
        for (const test of scenario ? [scenario] : ["session", "restored", "mixed", "unread", "unread-running", "unread-baseline",
          "sending-openclaw", "sending-hermes", "sending-shoggoth",
          "sending-openclaw-immersive", "sending-hermes-immersive", "sending-shoggoth-immersive",
          "steering-native", "steering-native-immersive", "queued-native", "queued-native-immersive", "events-user", "events-assistant", "events-string-time"]) {
          for (const [language, width, height] of [["zh-CN", 1200, 850], ["en", 600, 800]]) {
            window.setSize(width, height);
            await window.loadFile(path.join(temp, "index.html"), { query: { scenario: test, language }, hash: "/chat" });
            const result = await window.webContents.executeJavaScript("window.runSidebarOrderFixture()", true);
            results.push({ ...result, viewport: [width, height] }); console.log(JSON.stringify(results.at(-1)));
            if (output) fs.writeFileSync(path.join(output, test + "-" + language + ".png"), (await window.webContents.capturePage()).toPNG());
          }
        }
        fs.writeFileSync(path.join(temp, "results.json"), JSON.stringify(results));
        if (output) fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(results, null, 2));
        passed = true;
      } catch (error) {
        console.error(error.stack || error);
        console.error(await window.webContents.executeJavaScript("document.body.innerText.slice(0, 1200)"));
      } finally { window.destroy(); app.exit(passed ? 0 : 1); }
    };
    fs.writeFileSync(main, "(" + runElectron.toString() + ")(" + JSON.stringify({
      temp, output, scenario: process.env.CHAT_SIDEBAR_ORDER_SCENARIO || null,
    }) + ").catch(error => { console.error(error); require('electron').app.exit(1); });");
    const child = spawn(createRequire(path.join(root, "package.json"))("electron"), [main], {
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", chunk => process.stdout.write(chunk)); child.stderr.on("data", chunk => process.stderr.write(chunk));
    const timeout = setTimeout(() => child.kill("SIGTERM"), 90_000);
    let status;
    try { status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }); }
    finally { clearTimeout(timeout); }
    assert.equal(status, 0, "chat sidebar ordering regression must exit naturally with success");
    assert.ok(fs.existsSync(path.join(temp, "results.json")), "all sidebar scenarios must finish before accepting Electron exit");
  }
} finally {
  if (!serving) { server?.close(); server?.closeAllConnections(); fs.rmSync(temp, { recursive: true, force: true }); }
}
