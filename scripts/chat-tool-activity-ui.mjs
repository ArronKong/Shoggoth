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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-tool-activity-ui-"));
const output = process.env.CHAT_ACTIVITY_UI_OUTPUT ? path.resolve(process.env.CHAT_ACTIVITY_UI_OUTPUT) : null;
const progressOnly = process.argv.includes("--progress-only");
const nestedOnly = process.argv.includes("--nested-only");
const openClawLongOnly = process.argv.includes("--openclaw-long-only");
let serving = false;
try {
  await build({ entryPoints: [path.join(root, "scripts/fixtures/chat-tool-activity.tsx")], bundle: true, format: "esm",
    define: { "process.env.NODE_ENV": '"production"' }, loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(root, "app/manage-ui/node_modules")], logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), `<!doctype html><meta charset="utf-8"><title>工具活动全链路验证</title>
<link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}#root{display:flex;flex-direction:column}</style>
<div id="root"></div><script type="module" src="fixture.js"></script>`);
  if (process.argv.includes("--serve")) {
    const server = http.createServer((request, response) => {
      const pathname = new URL(request.url, "http://fixture").pathname;
      const file = ({ "/": "index.html", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css" })[pathname];
      if (!file) return response.writeHead(404).end();
      response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
      response.end(fs.readFileSync(path.join(temp, file)));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); serving = true;
    console.log(`PREVIEW http://127.0.0.1:${server.address().port}/#/chat`);
    const close = () => { server.close(); server.closeAllConnections(); fs.rmSync(temp, { recursive: true, force: true }); process.exit(); };
    process.on("SIGTERM", close); process.on("SIGINT", close);
  } else {
    if (output) fs.mkdirSync(output, { recursive: true });
    const main = path.join(temp, "main.cjs");
    const scenes = [["openclaw", "external"], ["hermes", "external"], ...["codex", "claude-code", "pi", "grok-build", "opencode", "antigravity", "deepseek-harness"].map(runtime => ["shoggoth", runtime])];
    fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron"),fs=require("node:fs");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});app.whenReady().then(async()=>{
const w=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{backgroundThrottling:false}});let passed=false;
try{const results=[],nestedResults=[],nativeResults=[],openClawLongResults=[],progressResults=[];for(const [backend,runtime] of ${JSON.stringify(nestedOnly || openClawLongOnly || progressOnly ? [] : scenes)}){for(const [language,theme,width] of [["zh-CN","light",1280],["en","dark",1280]]){
w.setContentSize(width,900);await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))},{query:{backend,runtime,language,theme},hash:"/chat"});
const result=await w.webContents.executeJavaScript('window.runActivityFixture()');results.push(result);console.log(JSON.stringify({backend,runtime,language,passed:true}));
if(${Boolean(output)}&&(runtime==="external"||runtime==="grok-build"))fs.writeFileSync(${JSON.stringify(output)}+"/"+backend+"-"+runtime+"-"+language+".png",(await w.webContents.capturePage()).toPNG());
}}if(!${nestedOnly || openClawLongOnly || progressOnly}){w.setContentSize(600,800);await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))},{query:{backend:"hermes",language:"zh-CN"},hash:"/chat"});results.push(await w.webContents.executeJavaScript('window.runActivityFixture()'));
if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/narrow.png",(await w.webContents.capturePage()).toPNG());}
if(!${openClawLongOnly || progressOnly}){for(const [language,theme,width] of [["zh-CN","light",1280],["en","dark",1280],["zh-CN","light",600]]){
w.setContentSize(width,900);await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))},{query:{backend:"openclaw",language,theme,scenario:"nested"},hash:"/chat"});
nestedResults.push(await w.webContents.executeJavaScript('window.runNestedToolHistoryFixture()'));
if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/nested-"+language+"-"+width+".png",(await w.webContents.capturePage()).toPNG());}}
if(!${nestedOnly || openClawLongOnly || progressOnly}){for(const [language,theme,width] of [["zh-CN","light",1280],["en","dark",1280],["zh-CN","light",600]]){
w.setContentSize(width,900);await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))},{query:{backend:"shoggoth",runtime:"antigravity",language,theme,scenario:"native-long"},hash:"/chat"});
nativeResults.push(await w.webContents.executeJavaScript('window.runNativeLongHistoryFixture()'));
if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/native-long-"+language+"-"+width+".png",(await w.webContents.capturePage()).toPNG());}}
if(!${nestedOnly || progressOnly}){for(const [language,theme,width] of [["zh-CN","light",1280],["en","dark",1280],["zh-CN","light",600]]){
w.setContentSize(width,900);await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))},{query:{backend:"openclaw",runtime:"external",language,theme,scenario:"openclaw-long"},hash:"/chat"});
openClawLongResults.push(await w.webContents.executeJavaScript('window.runOpenClawLongHistoryFixture()'));
if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/openclaw-long-"+language+"-"+width+".png",(await w.webContents.capturePage()).toPNG());}}
if(!${nestedOnly || openClawLongOnly}){for(const [language,theme,width] of [["zh-CN","light",1280],["en","dark",1280],["zh-CN","light",600]]){
for(const scenario of ["native-progress-cold","native-progress","native-progress-approval"]){w.setContentSize(width,900);await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))},{query:{backend:"shoggoth",runtime:"codex",language,theme,scenario},hash:"/chat"});
progressResults.push(await w.webContents.executeJavaScript('window.runNativeProgressFixture()'));
if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/"+scenario+"-"+language+"-"+width+".png",(await w.webContents.capturePage()).toPNG());}}}
if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/result.json",JSON.stringify({passed:true,results,nestedResults,nativeResults,openClawLongResults,progressResults},null,2));console.log(JSON.stringify({passed:true,scenes:results.length,nestedScenes:nestedResults.length,nativeScenes:nativeResults.length,openClawLongScenes:openClawLongResults.length,progressScenes:progressResults.length,providerCalls:0}));passed=true;
}catch(error){console.error(error.stack||error);console.error(JSON.stringify(await w.webContents.executeJavaScript('({error:window.fixtureError,text:document.body.innerText.slice(-3500),requests:window.requests.slice(-8)})')));if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/failure.png",(await w.webContents.capturePage()).toPNG());}finally{w.destroy();app.exit(passed?0:1);}});`);
    const result = spawnSync(path.join(root, "node_modules/.bin/electron"), [main], {
      encoding: "utf8", timeout: 180_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
    process.stdout.write(result.stdout || "");
    if (result.status !== 0) process.stderr.write(result.stderr || String(result.error));
    assert.equal(result.status, 0, "ChatPage activity wire fixture failed");
    assert.match(result.stdout, new RegExp(`"passed":true,"scenes":${nestedOnly || openClawLongOnly || progressOnly ? 0 : 19},"nestedScenes":${openClawLongOnly || progressOnly ? 0 : 3},"nativeScenes":${nestedOnly || openClawLongOnly || progressOnly ? 0 : 3},"openClawLongScenes":${nestedOnly || progressOnly ? 0 : 3}`));
  }
} finally { if (!serving) fs.rmSync(temp, { recursive: true, force: true }); }
