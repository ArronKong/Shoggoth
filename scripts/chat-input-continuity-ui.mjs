#!/usr/bin/env node
import { viteArtworkFixturePlugin } from "./fixtures/vite-artwork-esbuild.cjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync, execFileSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, ".."), require = createRequire(import.meta.url);
const { build } = createRequire(path.join(root, "app/manage-ui/package.json"))("esbuild");
const { transcriptHistoryItem } = require("../app/agent-service/chat-service-controller");
const { transcriptEventId } = require("../app/agent-service/transcript-store");
const { normalizeInteractiveRequestV1 } = require("../app/core/shoggoth-interaction-contract");
const prompts = [], receipts = [];
for (let index = 0; index < 2; index++) {
  const payload = { requestId: `input-${index}`, message: index ? "确认订单" : "选择门店", requestedSchema: {
    type: "object", properties: { answer: { type: "string", title: index ? "确认内容" : "门店名称" } }, required: ["answer"],
  } };
  prompts.push(normalizeInteractiveRequestV1({ runId: "input-run", eventType: "prompt", payload, expiresAt: null }));
  receipts.push([
    { id: transcriptEventId("chat-request", payload.requestId), seq: index * 10 + 4, kind: "input", content: { transcriptType: "prompt", ...payload } },
    { id: transcriptEventId("interactive-response", payload.requestId), seq: index * 10 + 5, kind: "user", content: { text: `补充：answer: ${index ? "确认下单" : "门店 A"}` } },
  ].map(event => transcriptHistoryItem({ ...event, runId: "input-run", occurredAt: Date.now() }).payload.message));
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-input-continuity-"));
const output = path.resolve(process.env.CHAT_INPUT_OUTPUT || ".artifacts/chat-continuity-20261028");
fs.mkdirSync(output, { recursive: true });
try {
  await build({ entryPoints: [path.join(root, "scripts/fixtures/chat-input-continuity.tsx")], bundle: true, format: "esm",
    define: { "process.env.NODE_ENV": '"production"', __INPUT_FIXTURE__: JSON.stringify({ prompts, receipts }) },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".png": "dataurl", ".webp": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(root, "app/manage-ui/node_modules")], logLevel: "silent",
    plugins: [viteArtworkFixturePlugin(root), ...(process.env.CHAT_INPUT_BASELINE ? [{ name: "baseline", setup(builder) {
      builder.onLoad({ filter: /\/pages\/ChatPage\.tsx$/ }, () => ({ loader: "tsx", contents: execFileSync("git", ["show", "HEAD:app/manage-ui/src/pages/ChatPage.tsx"], { cwd: root, encoding: "utf8" }) }));
    } }] : [])],
  });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}#root{display:flex;flex-direction:column}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  fs.writeFileSync(path.join(temp, "main.cjs"), `const {app,BrowserWindow,protocol}=require("electron"),fs=require("node:fs");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.on("window-all-closed",()=>{});
app.whenReady().then(async()=>{let w;const results=[];try {
for(const scheme of ["http","https"])protocol.handle(scheme,request=>new Response('<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220"><rect width="220" height="220" fill="white"/><path d="M20 20h60v60H20zm120 0h60v60h-60zM20 140h60v60H20zm90-30h20v20h-20zm40 40h50v50h-50z" fill="black"/></svg>',{headers:{"content-type":"image/svg+xml"}}));
for(const immersive of [0,1])for(const width of [1200,390]){
w=new BrowserWindow({show:false,width,height:950,webPreferences:{backgroundThrottling:false}});
await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))},{query:{immersive:String(immersive)}});
const result=await w.webContents.executeJavaScript('window.runFixture()');results.push(result);
fs.writeFileSync(${JSON.stringify(output)}+'/input-'+immersive+'-'+width+'.png',(await w.webContents.capturePage()).toPNG());w.destroy();w=null;
}console.log(JSON.stringify({passed:true,results}));app.exit(0);
}catch(error){console.error(error.stack||error);if(w){fs.writeFileSync(${JSON.stringify(output)}+'/input-failed.png',(await w.webContents.capturePage()).toPNG());w.destroy()}app.exit(1)}});`);
  const result = spawnSync(path.join(root, "node_modules/.bin/electron"), [path.join(temp, "main.cjs")], {
    encoding: "utf8", timeout: 60_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  fs.writeFileSync(path.join(output, process.env.CHAT_INPUT_BASELINE ? "input-baseline.log" : "input-ui.log"), (result.stdout || "") + (result.stderr || ""));
  process.stdout.write(result.stdout || ""); if (result.status !== 0) process.stderr.write(result.stderr || String(result.error));
  assert.equal(result.status, 0, "input continuity UI fixture failed");
  assert.match(result.stdout, /"passed":true/, "the complete four-case fixture must finish");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
