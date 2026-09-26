#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const { build } = createRequire(path.join(uiRoot, "package.json"))("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-avatar-focus-"));
const uploads = new Map();
let server;
let serving = false;
try {
  await build({
    entryPoints: [path.join(root, "scripts/fixtures/chat-avatar-focus.tsx")], bundle: true, format: "esm",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(uiRoot, "node_modules")], logLevel: "silent",
    // Read-only comparison without changing the working tree.
    plugins: process.env.CHAT_AVATAR_SOURCE_REF ? [{ name: "baseline", setup(builder) {
      builder.onLoad({ filter: /\/ChatPage\.tsx$/ }, ({ path: file }) => ({
        contents: execFileSync("git", ["show", `${process.env.CHAT_AVATAR_SOURCE_REF}:${path.relative(root, file)}`], { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }),
        loader: "tsx", resolveDir: path.dirname(file),
      }));
    } }] : [],
  });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><title>Shoggoth 头像切回前台回归</title><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://fixture").pathname;
    if (/^\/avatar\/fixture-\d+$/.test(pathname)) {
      if (req.method === "PUT") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        uploads.set(pathname, Buffer.concat(chunks));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
        return;
      }
      const uploaded = uploads.get(pathname);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#202020"/><text x="48" y="59" text-anchor="middle" font-size="32" fill="white">${Number(pathname.split("-").at(-1)) + 1}</text></svg>`;
      // Slow enough to expose a reset-to-loading frame if focus invalidates src.
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": uploaded ? "image/png" : "image/svg+xml", "Cache-Control": "no-store" });
        res.end(uploaded || svg);
      }, 120);
      return;
    }
    const file = ({ "/": "index.html", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css" })[pathname];
    if (!file) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", file.endsWith("js") ? "text/javascript" : file.endsWith("css") ? "text/css" : "text/html");
    res.end(fs.readFileSync(path.join(temp, file)));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/#/chat`;
  if (process.argv.includes("--serve")) {
    serving = true;
    console.log(`PREVIEW ${url}`);
    const close = () => { server.close(); fs.rmSync(temp, { recursive: true, force: true }); process.exit(); };
    process.on("SIGTERM", close);
    process.on("SIGINT", close);
  } else {
    const main = path.join(temp, "main.cjs");
    fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1360,height:950,webPreferences:{backgroundThrottling:false}});let passed=false;
try{await w.loadURL(${JSON.stringify(url)});console.log(JSON.stringify(await w.webContents.executeJavaScript('window.runFixture()')));passed=true;}catch(e){console.error(e);}finally{w.destroy();app.exit(passed?0:1);}});`);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(path.join(root, "node_modules/.bin/electron"), [main], {
        env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
      });
      let stdout = "", stderr = "";
      const timeout = setTimeout(() => child.kill(), 30_000);
      child.stdout.on("data", (data) => { stdout += data; });
      child.stderr.on("data", (data) => { stderr += data; });
      child.on("error", (error) => { clearTimeout(timeout); reject(error); });
      child.on("close", (status) => { clearTimeout(timeout); resolve({ status, stdout, stderr }); });
    });
    process.stdout.write(result.stdout);
    if (result.status !== 0) process.stderr.write(result.stderr);
    assert.equal(result.status, 0, "chat avatar focus fixture failed");
    assert.match(result.stdout, /"passed":true/);
  }
} finally {
  if (!serving) {
    server?.close();
    server?.closeAllConnections();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
