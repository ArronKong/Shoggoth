#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { viteArtworkFixturePlugin } from "./fixtures/vite-artwork-esbuild.cjs";
const repo = path.resolve(import.meta.dirname, ".."), require = createRequire(import.meta.url);
const { build } = createRequire(path.join(repo, "app/manage-ui/package.json"))("esbuild");
const { normalizeCodexEvent } = require("../app/agent-service/codex-event-normalizer");
const { transcriptHistoryItem } = require("../app/agent-service/chat-service-controller");
const output = path.resolve(process.env.CHAT_STEERING_OUTPUT || ".artifacts/chat-activity-continuity-20261106");
const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-steering-preview-"));
const open = process.argv.includes("--open");
fs.mkdirSync(output, { recursive: true });
const history = {}, runId = "steering-preview-run", now = Date.now(); let seq = 0;
const add = (name, kind, content, contextExcluded = false) => {
  const event = { id: `preview-${name}`, runId, seq: ++seq, kind, content, contextExcluded, occurredAt: now + seq };
  history[name] = transcriptHistoryItem(event)?.payload.message;
};
add("user", "user", { text: "他们都有案例吗？我想看看哪个效果好。" });
const thought = (index, text) => {
  const event = normalizeCodexEvent({ method: "item/completed", params: { threadId: "preview-thread", turnId: "preview-turn",
    item: { type: "reasoning", id: `thought-${index}`, summary: [], content: [text] } } });
  add(`thought${index}`, "status", { transcriptType: "reasoning", ...event });
};
const note = (name, text) => add(name, "assistant", { transcriptType: "text", phase: "commentary", text, segmentId: name });
const tool = (index, query) => {
  add(`call${index}`, "tool_call", { transcriptType: "tool.start", toolCallId: `call-${index}`,
    tool: { name: "web_search", displayArgs: { query } } });
  add(`result${index}`, "tool_result", { transcriptType: "tool.result", toolCallId: `call-${index}`,
    tool: { name: "web_search", status: "completed", resultSummary: "Synthetic links found", durationMs: 1000 } });
};
const compact = index => add(`compact${index}`, "status", { transcriptType: "context.native.compacted",
  runtimeSessionId: "preview-thread", compactionId: `compact-${index}` }, true);
thought(1, "正在读取视频制作技能。"); note("note1", "我正在查找公开案例。"); tool(1, "video examples"); compact(1);
thought(2, "正在定位官方案例页。"); note("note2", "已找到候选页面，正在整理。");
add("steer", "user", { transcriptType: "steer", text: "你不用核实，找到链接我看看就行" });
compact(2); thought(3, "正在整理已经找到的链接。");
note("note3", "已收到补充，接下来只整理案例链接。"); tool(2, "official showcase links");
note("partial", "已经找到一条案例链接，正在整理其余链接。");
try {
  await build({ entryPoints: [path.join(repo, "scripts/fixtures/chat-steering-activity.tsx")], bundle: true, format: "esm",
    define: { "process.env.NODE_ENV": '"production"', __STEERING_HISTORY__: JSON.stringify(history) },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".png": "dataurl", ".webp": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(repo, "app/manage-ui/node_modules")], logLevel: "silent",
    plugins: [viteArtworkFixturePlugin(repo)] });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}#root{display:flex;flex-direction:column}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  fs.writeFileSync(path.join(temp, "main.cjs"), `const {app,BrowserWindow}=require("electron"),fs=require("node:fs");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});app.on("window-all-closed",()=>{if(${open})app.quit();});app.whenReady().then(async()=>{let w;const results=[];try{
if(${open}){w=new BrowserWindow({show:false,width:1320,height:1040,title:"Shoggoth · 停止后保留动态（本地演示）",webPreferences:{backgroundThrottling:false}});await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))},{query:{manual:"1"}});await w.webContents.executeJavaScript('window.previewReady');w.show();app.focus({steal:true});w.focus();console.log(JSON.stringify({opened:true,visible:w.isVisible(),root:${JSON.stringify(temp)},providerCalls:0}));return;}
for(const immersive of [0,1])for(const [width,language,theme] of [[1280,"zh-CN","light"],[600,"en","dark"]]){
w=new BrowserWindow({show:false,width,height:1040,webPreferences:{backgroundThrottling:false}});await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))},{query:{immersive:String(immersive),language,theme}});
const live=await w.webContents.executeJavaScript('window.runFixture()');fs.writeFileSync(${JSON.stringify(output)}+'/stopped-'+immersive+'-'+language+'.png',(await w.webContents.capturePage()).toPNG());
await w.reload();await new Promise(r=>w.webContents.once('did-finish-load',r));const cold=await w.webContents.executeJavaScript('window.inspectStopped()');results.push({live,cold});w.destroy();w=null;
}fs.writeFileSync(${JSON.stringify(output)}+'/ui-result.json',JSON.stringify({passed:true,results,providerCalls:0},null,2));console.log(JSON.stringify({passed:true,scenes:results.length,providerCalls:0}));app.exit(0);
}catch(error){console.error(error.stack||error);if(w){console.error(JSON.stringify(await w.webContents.executeJavaScript('({error:window.fixtureError,text:document.body.innerText.slice(-3000),requests:window.requests})')));fs.writeFileSync(${JSON.stringify(output)}+'/ui-failed.png',(await w.webContents.capturePage()).toPNG())}app.exit(1)}});`);
  if (open) {
    const fd = fs.openSync(path.join(output, "preview.log"), "a");
    const child = spawn(path.join(repo, "node_modules/.bin/electron"), [path.join(temp, "main.cjs")], {
      detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
    child.unref(); fs.closeSync(fd);
    console.log(JSON.stringify({ launched: true, pid: child.pid, root: temp, providerCalls: 0 }));
  } else {
    const result = spawnSync(path.join(repo, "node_modules/.bin/electron"), [path.join(temp, "main.cjs")], {
      encoding: "utf8", timeout: 60_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
    fs.writeFileSync(path.join(output, "ui.log"), (result.stdout || "") + (result.stderr || ""));
    process.stdout.write(result.stdout || ""); if (result.status !== 0) process.stderr.write(result.stderr || String(result.error));
    assert.equal(result.status, 0, "steering/stop UI fixture failed");
    assert.match(result.stdout || "", /"passed":true,"scenes":4/, "all normal/immersive scenarios must finish");
  }
} finally { if (!open) fs.rmSync(temp, { recursive: true, force: true }); }
