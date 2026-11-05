#!/usr/bin/env node
// Real group chat components with synthetic messages and APIs; no providers or user data.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, ".."), require = createRequire(path.join(root, "app/manage-ui/package.json"));
const output = path.resolve(process.env.GROUP_QUIET_OUTPUT || path.join(root, ".artifacts/group-chat-quiet-20261101"));
const baseline = process.argv.includes("--baseline"), variant = baseline ? "before" : "after";
const bundle = path.join(output, variant);
fs.mkdirSync(bundle, { recursive: true });
await require("esbuild").build({ entryPoints: [path.join(root, "scripts/fixtures/group-chat-quiet.tsx")],
  bundle: true, format: "esm", jsx: "automatic", nodePaths: [path.join(root, "app/manage-ui/node_modules")],
  loader: { ".woff2": "dataurl", ".svg": "dataurl", ".png": "dataurl", ".webp": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"', GROUP_QUIET_BASELINE: String(baseline) },
  outfile: path.join(bundle, "fixture.js"), logLevel: "silent" });
fs.writeFileSync(path.join(bundle, "index.html"), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>群聊消息预览</title><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;height:100%;min-height:0}#root{display:flex;flex-direction:column}</style><div id="root" class="chat-shell"></div><script type="module" src="fixture.js"></script>');
if (!baseline) fs.writeFileSync(path.join(output, "index.html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>群聊消息样式 · 修改前后</title><style>*{box-sizing:border-box}body{margin:0;background:#eeefed;color:#292c29;font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}main{max-width:1580px;margin:auto;padding:28px 32px}h1{font-size:24px;font-weight:600;margin:0 0 6px}p{margin:0;color:#686e67}nav{display:flex;gap:8px;margin:20px 0}button{font:inherit;border:1px solid #d3d8d0;background:#f9faf7;border-radius:20px;padding:7px 18px;cursor:pointer}button[aria-pressed=true]{color:#fff;background:#364b39;border-color:#364b39}.columns{display:grid;grid-template-columns:1fr 1fr;gap:20px}.label{display:flex;align-items:center;gap:10px;margin-bottom:10px;font-weight:600}.label span{font-size:12px;font-weight:400;color:#6f756d}iframe{display:block;width:100%;height:730px;border:1px solid #d7dad4;border-radius:16px;background:#fff}.note{font-size:12px;margin-top:12px}@media(max-width:850px){main{padding:20px}.columns{grid-template-columns:1fr}iframe{height:650px}}</style><main><h1>群聊消息样式</h1><p>同一组消息，对比等待回复、正文输出和文件入口。</p><nav><button data-scene="waiting" aria-pressed="true">等待回复</button><button data-scene="streaming" aria-pressed="false">正在输出</button><button data-scene="files" aria-pressed="false">文件去重</button></nav><div class="columns"><section><div class="label">修改前 <span>讨论回合与过程信息</span></div><iframe title="修改前" src="before/index.html?scene=waiting"></iframe></section><section><div class="label">修改后 <span>普通消息与单聊加载动画</span></div><iframe title="修改后" src="after/index.html?scene=waiting"></iframe></section></div><p class="note">真实界面组件 · 隔离示例数据</p></main><script>for(const button of document.querySelectorAll('[data-scene]'))button.onclick=()=>{for(const tab of document.querySelectorAll('[data-scene]'))tab.setAttribute('aria-pressed',String(tab===button));for(const frame of document.querySelectorAll('iframe')){const url=new URL(frame.src);url.searchParams.set('scene',button.dataset.scene);frame.src=url}};</script></html>`);

if (process.argv.includes("--serve")) {
  const server = http.createServer((request, response) => {
    const requested = new URL(request.url, "http://fixture").pathname;
    const file = path.resolve(output, "." + (requested === "/" ? "/index.html" : requested));
    if (!file.startsWith(output + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return; }
    response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
    response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  console.log(`PREVIEW http://127.0.0.1:${server.address().port}`);
  process.on("SIGTERM", () => server.close(() => process.exit()));
  process.on("SIGINT", () => server.close(() => process.exit()));
} else if (!process.argv.includes("--build-only")) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-group-quiet-"));
  try {
    fs.writeFileSync(path.join(temp, "main.cjs"), `const{app,BrowserWindow}=require('electron'),fs=require('node:fs');app.setPath('userData',${JSON.stringify(path.join(temp, "profile"))});app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});let ok=false;try{const results=[];for(const width of[1200,390])for(const theme of['light','dark'])for(const scene of['waiting','streaming','files','scroll']){w.setSize(width,900);await w.loadFile(${JSON.stringify(path.join(bundle, "index.html"))},{query:{scene,theme}});const result=await w.webContents.executeJavaScript('window.runFixture()');results.push({...result,width,theme});fs.writeFileSync(${JSON.stringify(output)}+'/'+${JSON.stringify(variant)}+'-'+scene+'-'+width+'-'+theme+'.png',(await w.webContents.capturePage()).toPNG());if(scene==='streaming'&&!${baseline}){result.settlement=await w.webContents.executeJavaScript('window.settleFixture()');fs.writeFileSync(${JSON.stringify(output)}+'/after-settled-'+width+'-'+theme+'.png',(await w.webContents.capturePage()).toPNG())}}console.log(JSON.stringify(results));fs.writeFileSync(${JSON.stringify(path.join(output, variant + "-results.json"))},JSON.stringify(results,null,2));ok=true}catch(error){console.error(error.stack||error);fs.writeFileSync(${JSON.stringify(path.join(output, "failed.png"))},(await w.webContents.capturePage()).toPNG())}finally{w.destroy();app.exit(ok?0:1)}});`);
    const child = spawn(require("electron"), [path.join(temp, "main.cjs")], { env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", data => process.stdout.write(data));
    child.stderr.on("data", data => process.stderr.write(data));
    const timer = setTimeout(() => child.kill("SIGTERM"), 60000);
    const status = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
    clearTimeout(timer);
    assert.equal(status, 0, "quiet group chat UI acceptance failed");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
