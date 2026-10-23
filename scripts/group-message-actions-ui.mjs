#!/usr/bin/env node
// Production Panel and shared direct/group actions; only isolated APIs, storage and synthetic sends.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, ".."), require = createRequire(path.join(root, "app/manage-ui/package.json"));
const { build } = require("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-group-actions-"));
const design = process.argv.includes("--design");
const timeline = process.argv.includes("--timeline");
const output = path.resolve(process.env.GROUP_MESSAGE_ACTIONS_OUTPUT || path.join(root,
  timeline ? ".artifacts/group-timeline-20261017/ui" : design ? ".artifacts/group-chat-figma-20261017/ui" : ".artifacts/group-message-actions-20261017/ui"));
let server, serving = false;
try {
  await build({ entryPoints: [path.join(root,"scripts/fixtures/group-message-actions.tsx")], bundle: true, format: "esm", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }, nodePaths: [path.join(root,"app/manage-ui/node_modules")],
    loader: { ".woff2":"dataurl", ".svg":"dataurl", ".webp":"dataurl", ".png":"dataurl" }, outfile: path.join(temp,"fixture.js"), logLevel: "silent",
    plugins: process.env.GROUP_MESSAGE_ACTIONS_BASELINE_PANEL ? [{ name: "baseline-panel", setup(builder) {
      builder.onLoad({ filter: /\/GroupChatPanel\.tsx$/ }, ({path: file}) => ({
        contents: fs.readFileSync(process.env.GROUP_MESSAGE_ACTIONS_BASELINE_PANEL,"utf8"), loader: "tsx", resolveDir: path.dirname(file),
      }));
    } }] : [] });
  fs.writeFileSync(path.join(temp,"index.html"),'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Group message actions</title><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;height:100%;min-height:0}#root{display:flex;flex-direction:column}.fixture-controls{position:fixed;right:12px;top:12px;z-index:2000;background:var(--ui-surface-1);padding:6px;font-size:12px}</style><div id="root" class="chat-shell"></div><details class="fixture-controls"><summary>隔离验证</summary><button id="run-fixture">运行交互检查</button><p id="fixture-result"></p></details><script type="module" src="fixture.js"></script>');
  if (process.argv.includes("--serve")) {
    server = http.createServer((req,res) => {
      if (new URL(req.url,"http://fixture").pathname.startsWith("/avatar/")) {
        const names = ["Shoggoth.jpg","shoggoth_pi.jpg","shoggoth_codex.jpg","shoggoth_deepseek.jpg","shoggoth_grok.jpg"];
        const index = Number(new URL(req.url,"http://fixture").pathname.match(/-(\d+)$/)?.[1]) || 0;
        res.setHeader("Content-Type","image/jpeg");
        res.end(fs.readFileSync(path.join(root,"app/assets/agent-avatars/builtin",names[index % names.length]))); return;
      }
      const file = { "/":"index.html", "/fixture.js":"fixture.js", "/fixture.css":"fixture.css" }[new URL(req.url,"http://fixture").pathname];
      if (!file) { res.writeHead(404); res.end(); return; }
      res.setHeader("Content-Type",file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
      res.end(fs.readFileSync(path.join(temp,file)));
    });
    await new Promise((resolve,reject) => { server.once("error",reject); server.listen(0,"127.0.0.1",resolve); });
    serving = true; console.log("PREVIEW http://127.0.0.1:"+server.address().port+"/");
    const close = () => { server.close(); server.closeAllConnections(); fs.rmSync(temp,{recursive:true,force:true}); process.exit(); };
    process.on("SIGINT",close); process.on("SIGTERM",close);
  } else {
    fs.mkdirSync(output,{recursive:true});
    const run = async ({temp,output,design,timeline}) => {
      const { app,BrowserWindow } = require("electron"), fs = require("node:fs"), path = require("node:path");
      app.setPath("userData",path.join(temp,"profile")); await app.whenReady(); app.on("window-all-closed",()=>{});
      let window, passed = false; const results = [];
      try {
        for (const width of [1200,390]) for (const language of ["zh-CN","en"]) for (const theme of ["light","dark"]) {
          window = new BrowserWindow({ show:false,width,height:850,webPreferences:{backgroundThrottling:false,partition:"actions-"+results.length} });
          await window.loadFile(path.join(temp,"index.html"),{query:{language,theme}});
          const result = {...await window.webContents.executeJavaScript(timeline ? "window.runTimelineFixture()" : design ? "window.runDesignFixture()" : "window.runFixture()"),width};
          if (!result.passed) throw Error("Incomplete group message actions"); results.push(result); console.log(JSON.stringify(result));
          fs.writeFileSync(path.join(output,[width,language,theme].join("-")+".png"),(await window.webContents.capturePage()).toPNG());
          if (design) for (const mode of ["members","files"]) {
            await window.webContents.executeJavaScript(`window.showDesignState(${JSON.stringify(mode)})`);
            fs.writeFileSync(path.join(output,[width,language,theme,mode].join("-")+".png"),(await window.webContents.capturePage()).toPNG());
          }
          window.destroy(); window = null;
        }
        fs.writeFileSync(path.join(output,"results.json"),JSON.stringify(results,null,2)); passed = results.length===8;
      } catch (error) {
        console.error(error.stack||error);
        if (window && !window.isDestroyed()) {
          console.error(await window.webContents.executeJavaScript("document.body.innerText.slice(0,1600)"));
          fs.writeFileSync(path.join(output,"failed.png"),(await window.webContents.capturePage()).toPNG());
        }
      } finally { if(window&&!window.isDestroyed())window.destroy(); app.exit(passed?0:1); }
    };
    const main = path.join(temp,"main.cjs");
    fs.writeFileSync(main,"("+run.toString()+")("+JSON.stringify({temp,output,design,timeline})+").catch(error=>{console.error(error);require('electron').app.exit(1)});");
    const child=spawn(require("electron"),[main],{env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:"true"},stdio:["ignore","pipe","pipe"]});
    child.stdout.on("data",chunk=>process.stdout.write(chunk)); child.stderr.on("data",chunk=>process.stderr.write(chunk));
    const timeout=setTimeout(()=>child.kill("SIGTERM"),120000);
    let code; try { code=await new Promise((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject)}); } finally {clearTimeout(timeout);}
    assert.equal(code,0,"group message actions acceptance failed");
    assert.equal(JSON.parse(fs.readFileSync(path.join(output,"results.json"),"utf8")).length,8);
  }
} finally { if(!serving){server?.close();server?.closeAllConnections();fs.rmSync(temp,{recursive:true,force:true});} }
