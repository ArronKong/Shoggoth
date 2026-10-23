#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "app/manage-ui/package.json"));
const { build } = require("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plan-dock-"));
const output = process.env.CHAT_PLAN_UI_OUTPUT ? path.resolve(process.env.CHAT_PLAN_UI_OUTPUT) : null;
let serving = false;
try {
  await build({
    entryPoints: [path.join(root, "scripts/fixtures/chat-plan-dock.tsx")], bundle: true, format: "esm",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(root, "app/manage-ui/node_modules")], logLevel: "silent",
  });
  fs.writeFileSync(path.join(temp, "index.html"), `<!doctype html><meta charset="utf-8"><title>计划输入区验证</title>
<link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}#root{display:flex;flex-direction:column}</style>
<div id="root"></div><script type="module" src="fixture.js"></script>`);
  if (process.argv.includes("--serve")) {
    const server = http.createServer((request, response) => {
      const pathname = new URL(request.url, "http://fixture").pathname;
      const file = ({ "/": "index.html", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css" })[pathname];
      if (!file) { response.writeHead(404).end(); return; }
      response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
      response.end(fs.readFileSync(path.join(temp, file)));
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    serving = true;
    console.log(`PREVIEW http://127.0.0.1:${server.address().port}/#/chat`);
    const close = () => { server.close(); server.closeAllConnections(); fs.rmSync(temp, { recursive: true, force: true }); process.exit(); };
    process.on("SIGTERM", close); process.on("SIGINT", close);
  } else {
    if (output) fs.mkdirSync(output, { recursive: true });
    const main = path.join(temp, "main.cjs");
    fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron"), fs=require("node:fs");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{backgroundThrottling:false}});let passed=false;
try{const results=[];for(const [width,height,theme] of [[1280,900,"light"],[1280,900,"dark"],[600,800,"light"]]){
  w.setContentSize(width,height);await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))});
  await w.webContents.executeJavaScript('document.documentElement.setAttribute("data-theme",'+JSON.stringify(theme)+')');
  await w.webContents.executeJavaScript('window.preparePlanFixture()');
  if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/"+width+"-"+theme+"-expanded.png",(await w.webContents.capturePage()).toPNG());
  const result=await w.webContents.executeJavaScript('window.runPlanFixture()');results.push({width,height,theme,...result});
  if(width>=1000&&${Boolean(output)}){
    await w.webContents.executeJavaScript('window.previewPlanDock(false,false)');
    fs.writeFileSync(${JSON.stringify(output)}+"/"+width+"-"+theme+"-collapsed.png",(await w.webContents.capturePage()).toPNG());
    await w.webContents.executeJavaScript('window.previewPlanDock(true,true)');
    fs.writeFileSync(${JSON.stringify(output)}+"/"+width+"-"+theme+"-immersive.png",(await w.webContents.capturePage()).toPNG());
  }
}console.log(JSON.stringify({passed:true,results}));passed=true;}catch(error){
  console.error(error.stack||error);
  if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/failure.png",(await w.webContents.capturePage()).toPNG());
  console.error(JSON.stringify(await w.webContents.executeJavaScript('({error:window.fixtureError,text:document.body.innerText.slice(-2000),requests:window.requests.slice(-8),geometry:[...document.querySelectorAll("[data-chat-plan-dock],[data-chat-composer]")].map(e=>({class:e.className,rect:e.getBoundingClientRect().toJSON()}))})')));
}finally{w.destroy();app.exit(passed?0:1);}});`);
    const result = spawnSync(path.join(root, "node_modules/.bin/electron"), [main], {
      encoding: "utf8", timeout: 60_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
    });
    process.stdout.write(result.stdout || "");
    if (result.status !== 0) process.stderr.write(result.stderr || String(result.error));
    assert.equal(result.status, 0, "chat plan dock UI fixture failed");
    assert.match(result.stdout, /"passed":true/);
    if (output) fs.writeFileSync(path.join(output, "result.json"), result.stdout);
  }
} finally { if (!serving) fs.rmSync(temp, { recursive: true, force: true }); }
