#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const { build } = createRequire(path.join(root, "app/manage-ui/package.json"))("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-chat-copy-"));
let serving = false;
try {
  await build({
    entryPoints: [path.join(root, "scripts/fixtures/chat-message-copy.tsx")], bundle: true, format: "esm",
    define: { "process.env.NODE_ENV": '"production"' }, loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(root, "app/manage-ui/node_modules")], logLevel: "silent",
    plugins: process.env.CHAT_COPY_SOURCE_REF ? [{ name: "baseline", setup(builder) {
      builder.onLoad({ filter: /\/ChatPage\.tsx$/ }, ({ path: file }) => ({
        contents: execFileSync("git", ["show", `${process.env.CHAT_COPY_SOURCE_REF}:${path.relative(root, file)}`],
          { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }), loader: "tsx", resolveDir: path.dirname(file),
      }));
    } }] : [],
  });
  fs.writeFileSync(path.join(temp, "index.html"), `<!doctype html><meta charset="utf-8"><title>聊天气泡复制检查</title>
<link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}#root{display:flex;flex-direction:column}#fixture-controls{position:fixed;right:12px;top:12px;z-index:2000;background:white;padding:8px;max-width:280px;font-size:12px}#clipboard-output{white-space:pre-wrap;overflow-wrap:anywhere}</style>
<div id="root"></div><details id="fixture-controls"><summary>隔离验证</summary><button id="run-fixture">运行复制回归</button><p id="fixture-result"></p><pre id="clipboard-output"></pre></details><script type="module" src="fixture.js"></script>`);
  if (process.argv.includes("--serve")) {
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url, "http://fixture").pathname;
      const file = ({ "/": "index.html", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css" })[pathname];
      if (!file) { res.writeHead(404); res.end(); return; }
      res.setHeader("Content-Type", file.endsWith("js") ? "text/javascript" : file.endsWith("css") ? "text/css" : "text/html");
      res.end(fs.readFileSync(path.join(temp, file)));
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    serving = true;
    console.log(`PREVIEW http://127.0.0.1:${server.address().port}/#/chat`);
    const close = () => { server.close(); server.closeAllConnections(); fs.rmSync(temp, { recursive: true, force: true }); process.exit(); };
    process.on("SIGTERM", close);
    process.on("SIGINT", close);
  } else {
    const main = path.join(temp, "main.cjs");
    fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1360,height:950,webPreferences:{backgroundThrottling:false}});let passed=false;
try{await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))});console.log(JSON.stringify(await w.webContents.executeJavaScript('window.runFixture()')));passed=true;}catch(e){console.error(e);}finally{w.destroy();app.exit(passed?0:1);}});`);
    const result = spawnSync(path.join(root, "node_modules/.bin/electron"), [main], {
      encoding: "utf8", timeout: 30_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
    });
    process.stdout.write(result.stdout || "");
    if (result.status !== 0) process.stderr.write(result.stderr || String(result.error));
    assert.equal(result.status, 0, "chat message-copy UI fixture failed");
    assert.match(result.stdout, /"passed":true/);
  }
} finally {
  if (!serving) fs.rmSync(temp, { recursive: true, force: true });
}
