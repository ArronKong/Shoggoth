#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { viteArtworkFixturePlugin } from "./fixtures/vite-artwork-esbuild.cjs";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const { build } = createRequire(path.join(root, "app/manage-ui/package.json"))("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-chat-file-links-"));
let serving = false, server;
try {
  await build({
    entryPoints: [path.join(root, "scripts/fixtures/chat-local-file-links.tsx")], bundle: true, format: "esm",
    define: { "process.env.NODE_ENV": '"production"' }, loader: { ".woff2": "dataurl", ".svg": "dataurl", ".png": "dataurl", ".webp": "dataurl" },
    external: ["/fonts/*"], plugins: [viteArtworkFixturePlugin(root)],
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(root, "app/manage-ui/node_modules")], logLevel: "silent",
  });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><title>Chat 本地文件路径预览</title><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  server = http.createServer((req, res) => {
    const file = ({ "/": "index.html", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css" })[req.url];
    if (!file) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", file.endsWith("js") ? "text/javascript" : file.endsWith("css") ? "text/css" : "text/html");
    res.end(fs.readFileSync(path.join(temp, file)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  if (process.argv.includes("--serve")) {
    serving = true;
    console.log(`PREVIEW http://127.0.0.1:${server.address().port}`);
    const close = () => { server.close(); fs.rmSync(temp, { recursive: true, force: true }); process.exit(); };
    process.on("SIGTERM", close);
    process.on("SIGINT", close);
  } else {
    const main = path.join(temp, "main.cjs");
    fs.writeFileSync(main, `const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const { shouldOpenExternalUrl } = require(${JSON.stringify(path.join(root, "app/board-widget-navigation.js"))});
const origin = ${JSON.stringify(origin)};
const screenshotPath = ${JSON.stringify(process.env.CHAT_FILE_LINK_SCREENSHOT || "")};
app.setPath("userData", ${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: ${Number(process.env.CHAT_FILE_LINK_WIDTH || 1360)}, height: 950,
    webPreferences: { backgroundThrottling: false } });
  const externalOpens = [];
  window.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (request, callback) => {
    callback({ cancel: new URL(request.url).origin !== origin });
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenExternalUrl(url)) externalOpens.push(url);
    return { action: "deny" };
  });
  let passed = false;
  try {
    await window.loadURL(origin);
    const result = await window.webContents.executeJavaScript('window.runFixture()');
    assert.deepEqual(externalOpens, result.externalLinks, "Only the external links reach the desktop browser handler");
    console.log(JSON.stringify(result));
    if (screenshotPath) require("node:fs").writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());
    passed = true;
  } catch (error) {
    console.error(error);
  } finally {
    window.destroy();
    app.exit(passed ? 0 : 1);
  }
});
`);
    const result = await promisify(execFile)(path.join(root, "node_modules/.bin/electron"), [main], {
      encoding: "utf8", timeout: 30_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
    });
    process.stdout.write(result.stdout || "");
    assert.match(result.stdout, /"passed":true/);
  }
} finally {
  if (!serving) {
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
