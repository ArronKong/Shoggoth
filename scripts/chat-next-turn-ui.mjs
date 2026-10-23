import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {spawn} from "node:child_process";
const root=path.resolve(import.meta.dirname,".."),ui=path.join(root,"app/manage-ui"),requireUi=createRequire(path.join(ui,"package.json"));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"shoggoth-next-turn-ui-"));
let server;
try {
 await requireUi("esbuild").build({entryPoints:[path.join(root,"scripts/fixtures/chat-next-turn.tsx")],bundle:true,format:"esm",jsx:"automatic",define:{"process.env.NODE_ENV":'"production"'},loader:{".woff2":"dataurl",".woff":"dataurl",".png":"dataurl",".webp":"dataurl",".svg":"dataurl"},nodePaths:[path.join(ui,"node_modules")],outfile:path.join(temp,"fixture.js"),logLevel:"silent"});
 fs.writeFileSync(path.join(temp,"index.html"),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;min-height:0}#root{height:100vh}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
 server=http.createServer((req,res)=>{const name=new URL(req.url,"http://fixture").pathname.slice(1)||"index.html";if(!["index.html","fixture.js","fixture.css"].includes(name)){res.writeHead(404).end();return;}res.setHeader("Content-Type",name.endsWith("js")?"text/javascript":name.endsWith("css")?"text/css":"text/html");res.end(fs.readFileSync(path.join(temp,name)));});
 await new Promise(r=>server.listen(0,"127.0.0.1",r));const url=`http://127.0.0.1:${server.address().port}/`;
 if(process.argv.includes("--serve")){console.log(JSON.stringify({url:`${url}?runtime=codex&preview=1#/chat`,scope:"isolated-real-ChatPage"}));await new Promise(r=>{process.once("SIGINT",r);process.once("SIGTERM",r);});}
 else{
 const main=path.join(temp,"main.cjs"),output=process.argv.find(v=>v.startsWith("--output="))?.slice(9);
 fs.writeFileSync(main,`const {app,BrowserWindow}=require("electron"),fs=require("node:fs");app.setPath("userData",${JSON.stringify(path.join(temp,"profile"))});app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1150,height:940,webPreferences:{backgroundThrottling:false}}),rows=[];try{for(const runtime of ["codex","claude-code","pi","deepseek-harness","grok-build","antigravity","opencode","openclaw","hermes"]){for(const immersive of [false,true]){await w.loadURL(${JSON.stringify(url)}+"?runtime="+runtime+(immersive?"&immersive=1":"")+"#/chat");try{const result=await w.webContents.executeJavaScript("window.runNextTurnFixture()",true);rows.push(result);console.log(JSON.stringify(result));}catch(error){console.error(await w.webContents.executeJavaScript("JSON.stringify({text:document.body.innerText,requests:window.nextTurnFixture.requests})",true));throw error;}}}${output?`fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({outcome:"PASS",liveProvider:false,scenarios:rows},null,2));`:""}}finally{w.destroy();app.quit();}}).catch(e=>{console.error(e);app.exit(1)});`);
 const child=spawn(createRequire(path.join(root,"package.json"))("electron"),[main],{env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:"true"},stdio:["ignore","pipe","pipe"]});let stdout="";child.stdout.on("data",c=>{stdout+=c;process.stdout.write(c);});child.stderr.on("data",c=>process.stderr.write(c));const timer=setTimeout(()=>child.kill("SIGTERM"),120000);const code=await new Promise((r,j)=>{child.once("error",j);child.once("exit",r);});clearTimeout(timer);assert.equal(code,0,"next-turn ChatPage fixture failed");assert.equal(stdout.split("\n").filter(line=>line.startsWith('{"runtime":')).length,18,"all runtime and view scenarios must finish");}
}finally{if(server)await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});}
