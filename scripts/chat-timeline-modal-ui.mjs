#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { viteArtworkFixturePlugin } from "./fixtures/vite-artwork-esbuild.cjs";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const { build } = createRequire(path.join(uiRoot, "package.json"))("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-timeline-modal-"));
const open = process.argv.includes("--open");
const preview = process.argv.includes("--preview");
try {
  const plugins = process.env.TIMELINE_MODAL_BASELINE === "1" ? [{ name: "baseline-chat-page", setup(builder) {
    builder.onLoad({ filter: /\/pages\/ChatPage\.tsx$/ }, () => {
      const result = spawnSync("git", ["show", "HEAD:app/manage-ui/src/pages/ChatPage.tsx"], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0);
      return { contents: result.stdout, loader: "tsx", resolveDir: path.join(uiRoot, "src/pages") };
    });
  } }] : [];
  await build({ entryPoints: [path.join(root, "scripts/fixtures/chat-timeline-modal.tsx")], bundle: true,
    format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(uiRoot, "node_modules")],
    plugins: [viteArtworkFixturePlugin(root), ...plugins], logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><title>Shoggoth · 模拟对话预览</title><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div>'
    + `<style>
      body{display:flex;flex-direction:column}
      #root{flex:1;min-height:0;order:1}
      #demo:not([hidden]){display:flex;align-items:center;gap:8px;padding:8px 16px;background:var(--ui-surface-1);color:var(--ui-text-2);font-size:12px}
      #demo [data-demo-title]{margin-inline-end:auto}
      #demo button{border:1px solid var(--ui-control-border);border-radius:8px;padding:4px 10px;color:var(--ui-text-1);background:var(--ui-surface-2);cursor:pointer}
      </style>
      <div id="demo" hidden>
        <span data-demo-title>Shoggoth · 模拟对话</span>
        <span>在输入框发消息，或试用示例</span>
        <button type="button" onclick="window.previewSendSample()">发送示例</button>
      </div>
      <script>document.getElementById("demo").hidden = !new URLSearchParams(location.search).has("preview")</script>`
    + '<script type="module" src="fixture.js"></script>');
  if (preview && !open) {
    const server = http.createServer((req, res) => {
      const file = ["/fixture.js", "/fixture.css"].includes(req.url?.split("?")[0]) ? req.url.split("?")[0].slice(1) : "index.html";
      res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
      res.end(fs.readFileSync(path.join(temp, file)));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    console.log(`PREVIEW http://127.0.0.1:${server.address().port}/?preview=1#/chat`);
    await new Promise(resolve => process.once("SIGTERM", () => server.close(resolve)));
  } else {
    const main = path.join(temp, "main.cjs");
    fs.writeFileSync(main, `const { app, BrowserWindow } = require("electron");
app.setPath("userData", ${JSON.stringify(path.join(temp, "profile"))});
app.on("window-all-closed", () => app.quit());
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 1320, height: 940,
    webPreferences: { backgroundThrottling: false } });
  try {
    const previewUrl = ${JSON.stringify(pathToFileURL(path.join(temp, "index.html")).href)} + "?preview=1#/chat";
    if (${open}) {
      await w.loadURL(previewUrl);
      await w.webContents.executeJavaScript("window.previewReady");
      w.show();
      app.focus({ steal: true });
      w.focus();
      console.log(JSON.stringify({ opened: w.isVisible(), title: w.getTitle(), providerCalls: 0 }));
      return;
    }
    for (const backend of ["openclaw", "hermes", "shoggoth"]) for (const immersive of [0, 1]) {
      if (backend === "shoggoth") w.setSize(immersive ? 760 : 640, 850);
      await w.loadURL(${JSON.stringify(pathToFileURL(path.join(temp, "index.html")).href)} + "?backend=" + backend + "&immersive=" + immersive
        + (immersive ? "&theme=dark" : "") + "#/chat");
      console.log(JSON.stringify(await w.webContents.executeJavaScript("window.runTimelineModalFixture()", true)));
    }
    for (const backend of ["openclaw", "hermes", "shoggoth"]) for (const immersive of [0, 1]) {
      await w.loadURL(${JSON.stringify(pathToFileURL(path.join(temp, "index.html")).href)} + "?recovered=1&backend=" + backend + "&immersive=" + immersive + "#/chat");
      console.log(JSON.stringify(await w.webContents.executeJavaScript("window.runRecoveredActivityFixture()", true)));
    }
    for (const backend of ["openclaw", "hermes", "shoggoth"]) {
      await w.loadURL(${JSON.stringify(pathToFileURL(path.join(temp, "index.html")).href)} + "?recovered=1&terminal=aborted&backend=" + backend + "#/chat");
      console.log(JSON.stringify(await w.webContents.executeJavaScript("window.runRecoveredActivityFixture()", true)));
    }
    w.setSize(1200, 850);
    await w.loadURL(previewUrl);
    console.log(JSON.stringify(await w.webContents.executeJavaScript("window.runConversationPreviewFixture()", true)));
  } catch (error) {
    console.error(error);
    console.error(await w.webContents.executeJavaScript("JSON.stringify({errors:window.fixtureErrors,text:document.body.innerText.slice(-3500)})"));
    process.exitCode = 1;
  } finally { if (!${open} || process.exitCode) { w.destroy(); app.exit(process.exitCode || 0); } }
}).catch(error => { console.error(error); app.exit(1); });`);
    const child = spawn(createRequire(path.join(root, "package.json"))("electron"), [main], {
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", chunk => process.stdout.write(chunk));
    child.stderr.on("data", chunk => process.stderr.write(chunk));
    const timeout = open ? undefined : setTimeout(() => child.kill("SIGTERM"), 75_000);
    const status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    clearTimeout(timeout);
    assert.equal(status, 0, "ChatPage activity fixture failed");
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
