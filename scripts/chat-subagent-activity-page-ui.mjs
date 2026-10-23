#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const { build } = createRequire(path.join(uiRoot, "package.json"))("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-subagent-page-"));
const preview = process.argv.includes("--preview");
const output = process.env.SUBAGENT_ARTIFACT_DIR;
if (output) fs.mkdirSync(output, { recursive: true });
try {
  const plugins = process.env.SUBAGENT_BASELINE === "1" ? [{ name: "original-chat-page", setup(builder) {
    builder.onLoad({ filter: /\/pages\/ChatPage\.tsx$/ }, () => {
      const result = spawnSync("git", ["show", "HEAD:app/manage-ui/src/pages/ChatPage.tsx"], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0);
      return { contents: result.stdout, loader: "tsx", resolveDir: path.join(uiRoot, "src/pages") };
    });
  } }] : [];
  await build({ entryPoints: [path.join(root, "scripts/fixtures/chat-subagent-activity-page.tsx")],
    bundle: true, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(uiRoot, "node_modules")], plugins, logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><title>子代理进展 · 隔离测试</title><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  if (preview) {
    const server = http.createServer((req, res) => {
      const file = ["/fixture.js", "/fixture.css"].includes(req.url) ? req.url.slice(1) : "index.html";
      res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
      res.end(fs.readFileSync(path.join(temp, file)));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    console.log(`PREVIEW http://127.0.0.1:${server.address().port}/#/chat`);
    await new Promise(resolve => process.once("SIGTERM", () => server.close(resolve)));
  } else {
    const main = path.join(temp, "main.cjs");
    fs.writeFileSync(main, `const { app, BrowserWindow } = require("electron"); const fs = require("node:fs");
app.setPath("userData", ${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 1200, height: 1000, webPreferences: { backgroundThrottling: false } });
  try {
    for (const [immersive, language, theme, width] of [[0,"zh-CN","light",1200],[1,"zh-CN","light",1200],[0,"en","dark",1200],[0,"zh-CN","light",600]]) {
      w.setContentSize(width, 1000);
      await w.loadURL(${JSON.stringify(pathToFileURL(path.join(temp, "index.html")).href)} + "?immersive=" + immersive + "&language=" + language + "&theme=" + theme + "#/chat");
      console.log(JSON.stringify(await w.webContents.executeJavaScript("window.runSubagentPageFixture()", true)));
      if (${Boolean(output)}) fs.writeFileSync(${JSON.stringify(output)} + "/" + [immersive,language,theme,width].join("-") + ".png", (await w.webContents.capturePage()).toPNG());
    }
  } catch (error) {
    console.error(error);
    console.error(await w.webContents.executeJavaScript("JSON.stringify({errors:window.fixtureErrors,text:document.body.innerText.slice(-1800),calls:window.fixtureCalls.map(x=>x.method)})"));
    process.exitCode = 1;
  } finally { w.destroy(); app.exit(process.exitCode || 0); }
}).catch(error => { console.error(error); app.exit(1); });`);
    const result = spawnSync(createRequire(path.join(root, "package.json"))("electron"), [main], {
      encoding: "utf8", timeout: 60_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
    });
    process.stdout.write(result.stdout || "");
    if (result.status !== 0) process.stderr.write(result.stderr || String(result.error || ""));
    assert.equal(result.status, 0, "actual ChatPage subagent activity lifecycle failed");
    assert.equal(result.stdout.split("\n").filter(line => line.startsWith('{"immersive":')).length, 4);
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
