#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { viteArtworkFixturePlugin } from "./fixtures/vite-artwork-esbuild.cjs";

const root = path.resolve(import.meta.dirname, ".."), ui = path.join(root, "app/manage-ui");
const require = createRequire(path.join(ui, "package.json"));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-agent-typing-ui-"));
try {
  await require("esbuild").build({ entryPoints: [path.join(root, "scripts/fixtures/chat-agent-typing.tsx")],
    bundle: true, format: "esm", jsx: "automatic", nodePaths: [path.join(ui, "node_modules")],
    define: { "process.env.NODE_ENV": '"production"' }, plugins: [viteArtworkFixturePlugin(root)],
    loader: { ".woff2": "dataurl", ".woff": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><title>隔离 Agent 输入状态回归</title><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;height:100%;min-height:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  const run = async ({ temp }) => {
    const { app, BrowserWindow } = require("electron"), path = require("node:path");
    app.setPath("userData", path.join(temp, "profile")); await app.whenReady();
    const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { backgroundThrottling: false } });
    let passed = false;
    try {
      for (const backend of ["hermes", "openclaw", "shoggoth"]) for (const language of ["zh-CN", "en"]) {
        await win.loadFile(path.join(temp, "index.html"), { query: { backend, language }, hash: "/chat" });
        const result = await win.webContents.executeJavaScript("window.runAgentTypingFixture()", true);
        console.log(JSON.stringify(result));
      }
      passed = true;
    } catch (error) {
      console.error(error.stack || error);
      console.error(await win.webContents.executeJavaScript("JSON.stringify({error:window.fixtureError,text:document.body.innerText.slice(0,1600)})"));
    } finally { win.destroy(); app.exit(passed ? 0 : 1); }
  };
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `(${run.toString()})(${JSON.stringify({ temp })}).catch(error => { console.error(error); require("electron").app.exit(1); });`);
  const child = spawn(require("electron"), [main], { env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }, stdio: "inherit" });
  const timer = setTimeout(() => child.kill("SIGTERM"), 90_000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }); }
  finally { clearTimeout(timer); }
  assert.equal(code, 0, "Agent typing UI regression must pass");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
