#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { viteArtworkFixturePlugin } from "./fixtures/vite-artwork-esbuild.cjs";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "app/manage-ui/package.json"));
const { build } = require("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-compaction-ui-"));
const output = process.env.CHAT_COMPACTION_UI_OUTPUT ? path.resolve(process.env.CHAT_COMPACTION_UI_OUTPUT) : null;
const scenes = ["openclaw", "hermes", "shoggoth"].flatMap(backend =>
  [["zh-CN", "light"], ["en", "dark"]].flatMap(([language, theme]) =>
    ["error", "aborted"].map(terminal => ({ backend, language, theme, terminal, width: 1280 }))));
scenes.push({ backend: "hermes", language: "zh-CN", theme: "light", terminal: "aborted", width: 600 });
const meters = [
  { backend: "shoggoth", runtime: "codex", meterCase: "full", language: "zh-CN", theme: "light", width: 1100 },
  { backend: "shoggoth", runtime: "pi", meterCase: "resident", language: "en", theme: "dark", width: 850 },
  { backend: "shoggoth", runtime: "codex", meterCase: "missing", language: "zh-CN", theme: "dark", width: 700 },
  { backend: "shoggoth", runtime: "codex", meterCase: "switch", language: "zh-CN", theme: "light", width: 900 },
  ...["hermes", "openclaw"].map(backend => ({ backend, runtime: "gateway", meterCase: "total", language: "zh-CN", theme: "light", width: 700 })),
  ...["shoggoth", "openclaw", "hermes"].map(backend => ({ backend, runtime: backend === "shoggoth" ? "codex" : "gateway",
    meterCase: backend === "shoggoth" ? "full" : "total", immersive: "1", language: "zh-CN", theme: "dark", width: 900 })),
];
const terminals = process.argv.includes("--meter-only") ? [] : scenes;
try {
  await build({ entryPoints: [path.join(root, "scripts/fixtures/chat-tool-activity.tsx")], bundle: true, format: "esm",
    define: { "process.env.NODE_ENV": '"production"' }, loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(root, "app/manage-ui/node_modules")],
    plugins: [viteArtworkFixturePlugin(root)], logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), `<!doctype html><meta charset="utf-8"><title>上下文压缩动态验证</title>
<link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}#root{display:flex;flex-direction:column}</style>
<div id="root"></div><script type="module" src="fixture.js"></script>`);
  if (output) fs.mkdirSync(output, { recursive: true });
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron"),fs=require("node:fs");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});app.whenReady().then(async()=>{
const w=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{backgroundThrottling:false}});let passed=false;
try{const results=[];for(const scene of ${JSON.stringify(terminals)}){
w.setContentSize(scene.width,900);await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))},{query:{...scene,scenario:"compaction"},hash:"/chat"});
const result=await w.webContents.executeJavaScript('window.runCompactionFixture()');results.push(result);console.log(JSON.stringify({...scene,passed:true}));
if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/"+scene.backend+"-"+scene.language+"-"+scene.terminal+"-"+scene.width+".png",(await w.webContents.capturePage()).toPNG());
}
const mouse=(x,y)=>w.webContents.debugger.sendCommand("Input.dispatchMouseEvent",{type:"mouseMoved",x,y});
const key=async(name,code)=>{for(const type of ["keyDown","keyUp"])await w.webContents.debugger.sendCommand("Input.dispatchKeyEvent",{type,key:name,code:name,windowsVirtualKeyCode:code,...(name==="Enter"&&type==="keyDown"?{text:String.fromCharCode(13)}:{})});};
for(const scene of ${JSON.stringify(meters)}){
  w.setContentSize(scene.width,800);await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))},{query:{...scene,scenario:"context-meter"},hash:"/chat"});
  if(!w.webContents.debugger.isAttached())w.webContents.debugger.attach();
  await w.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled",{enabled:true});
  const evaluate=expr=>w.webContents.executeJavaScript(expr);
  const point=await evaluate("window.prepareContextMeter()");
  await mouse(1,1);await mouse(point.x,point.y);
  if(scene.meterCase==="switch"){
    const other=await evaluate("window.switchMeterSession()");await mouse(1,1);await mouse(other.x,other.y);
    results.push(await evaluate("window.checkLateMeterSnapshot()"));console.log(JSON.stringify({...scene,passed:true}));continue;
  }
  const bounds=await evaluate('window.inspectContextMeter("pointer")');
  const center=await evaluate('(()=>{const p=document.querySelector("[data-chat-context-details]"),b=p.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})()');
  await mouse(center.x,center.y);await new Promise(resolve=>setTimeout(resolve,220));
  if(!await evaluate('!!document.querySelector("[data-chat-context-details]")'))throw Error("hover cannot reach controls");
  if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/meter-"+scene.backend+"-"+scene.meterCase+(scene.immersive?"-immersive":"")+".png",(await w.webContents.capturePage(bounds)).toPNG());
  await mouse(1,1);await new Promise(resolve=>setTimeout(resolve,300));
  if(await evaluate('!!document.querySelector("[data-chat-context-details]")'))throw Error("pointer exit did not close the panel");
  await evaluate('document.querySelector("[data-chat-context-trigger]").focus()');await key("Enter",13);
  await evaluate('window.inspectContextMeter("keyboard")');await key("Escape",27);
  await evaluate('window.checkContextMeterClosed()');
  await mouse(point.x,point.y);await evaluate('window.inspectContextMeter("reopen")');
  results.push(await evaluate("window.clickContextCompact()"));console.log(JSON.stringify({...scene,passed:true}));
}
if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/result.json",JSON.stringify({passed:true,results},null,2));console.log(JSON.stringify({passed:true,scenes:results.length,providerCalls:0,floatingToast:false}));passed=true;
}catch(error){console.error(error.stack||error);console.error(JSON.stringify(await w.webContents.executeJavaScript('({error:window.fixtureError,text:document.body.innerText.slice(-3000),requests:window.requests.slice(-5)})')));
if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/failure.png",(await w.webContents.capturePage()).toPNG());}finally{w.destroy();app.exit(passed?0:1);}});`);
  const result = spawnSync(path.join(root, "node_modules/.bin/electron"), [main], {
    encoding: "utf8", timeout: 180_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
  process.stdout.write(result.stdout || "");
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error));
  assert.equal(result.status, 0, "ChatPage context compaction fixture failed");
  assert.ok(result.stdout.includes(JSON.stringify({ passed: true, scenes: terminals.length + meters.length, providerCalls: 0, floatingToast: false })));
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
