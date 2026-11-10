#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-main-model-menu-"));
const { build } = createRequire(path.join(uiRoot, "package.json"))("esbuild");
const screenshotDir = process.argv.find(value => value.startsWith("--screenshots="))?.slice(14);
try {
  await build({ entryPoints: [path.join(root, "scripts/fixtures/agent-main-model-menu.tsx")],
    bundle: true, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "local-fonts", setup(builder) {
      builder.onResolve({ filter: /^\/fonts\// }, args => ({
        path: pathToFileURL(path.join(uiRoot, "public", args.path)).href, external: true,
      }));
    } }],
    loader: { ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(uiRoot, "node_modules")], logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
app.setPath('userData', ${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file:|data:)/.test(details.url) }));
  const w = new BrowserWindow({ show: false, width: 1100, height: 900, useContentSize: true, webPreferences: { backgroundThrottling: false } });
  try {
    await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))});
    const behavior = await w.webContents.executeJavaScript('window.runMainModelMenu()', true);
    const geometry = [];
    for (const [width, height, locale, theme] of [[1100,900,'zh-CN','light'],[390,780,'en','dark']]) {
      w.setContentSize(width,height);
      geometry.push(await w.webContents.executeJavaScript('window.checkMainModelGeometry('+JSON.stringify(locale)+','+JSON.stringify(theme)+')',true));
      const dir = ${JSON.stringify(screenshotDir ? path.resolve(screenshotDir) : null)};
      if (dir) { fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,'isolated-menu-'+width+'.png'),(await w.webContents.capturePage()).toPNG()); }
    }
    console.log(JSON.stringify({ passed: true, behavior, geometry }));
    w.destroy(); app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(await w.webContents.executeJavaScript('document.body.innerText'));
    w.destroy(); app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });`);
  const result = spawnSync(createRequire(path.join(root, "package.json"))("electron"), [main], {
    encoding: "utf8", timeout: 45_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  process.stdout.write(result.stdout || "");
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "");
    console.error({ status: result.status, signal: result.signal, error: result.error?.message });
  }
  assert.equal(result.status, 0, "main-model menu Electron regression failed");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
