#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "app/manage-ui/package.json"));
const { build } = require("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-compaction-ui-"));
const output = process.env.CHAT_COMPACTION_UI_OUTPUT ? path.resolve(process.env.CHAT_COMPACTION_UI_OUTPUT) : null;
const scenes = ["openclaw", "hermes", "shoggoth"].flatMap(backend =>
  [["zh-CN", "light"], ["en", "dark"]].flatMap(([language, theme]) =>
    ["error", "aborted"].map(terminal => ({ backend, language, theme, terminal, width: 1280 }))));
scenes.push({ backend: "hermes", language: "zh-CN", theme: "light", terminal: "aborted", width: 600 });
try {
  await build({ entryPoints: [path.join(root, "scripts/fixtures/chat-tool-activity.tsx")], bundle: true, format: "esm",
    define: { "process.env.NODE_ENV": '"production"' }, loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(root, "app/manage-ui/node_modules")], logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), `<!doctype html><meta charset="utf-8"><title>上下文压缩动态验证</title>
<link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}#root{display:flex;flex-direction:column}</style>
<div id="root"></div><script type="module" src="fixture.js"></script>`);
  if (output) fs.mkdirSync(output, { recursive: true });
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron"),fs=require("node:fs");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});app.whenReady().then(async()=>{
const w=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{backgroundThrottling:false}});let passed=false;
try{const results=[];for(const scene of ${JSON.stringify(scenes)}){
w.setContentSize(scene.width,900);await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))},{query:{...scene,scenario:"compaction"},hash:"/chat"});
const result=await w.webContents.executeJavaScript('window.runCompactionFixture()');results.push(result);console.log(JSON.stringify({...scene,passed:true}));
if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/"+scene.backend+"-"+scene.language+"-"+scene.terminal+"-"+scene.width+".png",(await w.webContents.capturePage()).toPNG());
}if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/result.json",JSON.stringify({passed:true,results},null,2));console.log(JSON.stringify({passed:true,scenes:results.length,providerCalls:0,floatingToast:false}));passed=true;
}catch(error){console.error(error.stack||error);console.error(JSON.stringify(await w.webContents.executeJavaScript('({error:window.fixtureError,text:document.body.innerText.slice(-3000),requests:window.requests.slice(-5)})')));
if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/failure.png",(await w.webContents.capturePage()).toPNG());}finally{w.destroy();app.exit(passed?0:1);}});`);
  const result = spawnSync(path.join(root, "node_modules/.bin/electron"), [main], {
    encoding: "utf8", timeout: 180_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
  process.stdout.write(result.stdout || "");
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error));
  assert.equal(result.status, 0, "ChatPage context compaction fixture failed");
  assert.match(result.stdout, /"passed":true,"scenes":13,"providerCalls":0,"floatingToast":false/);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
