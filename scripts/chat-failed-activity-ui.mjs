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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-failed-activity-ui-"));
const output = process.env.CHAT_FAILED_ACTIVITY_OUTPUT ? path.resolve(process.env.CHAT_FAILED_ACTIVITY_OUTPUT) : null;
try {
  await build({ plugins: [viteArtworkFixturePlugin(root)], entryPoints: [path.join(root, "scripts/fixtures/chat-tool-activity.tsx")],
    bundle: true, format: "esm", define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(root, "app/manage-ui/node_modules")], logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}#root{display:flex;flex-direction:column}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  if (output) fs.mkdirSync(output, { recursive: true });
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron"),fs=require("node:fs");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{backgroundThrottling:false}});let passed=false;
try{const results=[];for(const [language,theme,width,immersive] of [["zh-CN","light",1280,"0"],["en","dark",600,"0"],["zh-CN","light",600,"1"],["en","dark",1280,"1"]]){
w.setContentSize(width,900);await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))},{query:{backend:"shoggoth",language,theme,immersive,scenario:"failed-turn"},hash:"/chat"});
results.push(await w.webContents.executeJavaScript('window.runFailedTurnFixture()'));
const point=await w.webContents.executeJavaScript('(()=>{const surface=document.querySelector("[data-testid=immersive-chat]")??document.querySelector(".chat-thread");const rect=surface.querySelector("[data-chat-footer-icon][aria-haspopup=dialog]").getBoundingClientRect();return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}})()');
w.webContents.sendInputEvent({type:"mouseMove",...point});await new Promise(resolve=>setTimeout(resolve,200));
if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/"+language+"-"+immersive+".png",(await w.webContents.capturePage()).toPNG());}
if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/result.json",JSON.stringify({passed:true,results},null,2));
console.log(JSON.stringify({passed:true,scenes:results.length,providerCalls:0}));passed=true;
}catch(error){console.error(error.stack||error);console.error(JSON.stringify(await w.webContents.executeJavaScript('({error:window.fixtureError,text:document.body.innerText.slice(-2500)})')));
if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/failure.png",(await w.webContents.capturePage()).toPNG());
}finally{w.destroy();app.exit(passed?0:1);}});`);
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(path.join(root, "node_modules/.bin/electron"), [main], { encoding: "utf8", timeout: 90_000, env });
  process.stdout.write(result.stdout || "");
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error));
  assert.equal(result.status, 0, "Failed-turn activity UI regression failed");
  assert.match(result.stdout, /"passed":true,"scenes":4/u);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
