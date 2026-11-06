#!/usr/bin/env node
// Actual Dashboard and API client, delayed synthetic reads, private Electron profile.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "app/manage-ui/package.json"));
const output = path.resolve(process.env.DASHBOARD_LOADING_OUTPUT || path.join(root, ".artifacts/dashboard-loading-20261106"));
const temp = fs.mkdtempSync("/private/tmp/dashboard-loading-");
await require("esbuild").build({ entryPoints: [path.join(root, "scripts/fixtures/dashboard-loading.tsx")],
  bundle: true, format: "esm", jsx: "automatic", nodePaths: [path.join(root, "app/manage-ui/node_modules")],
  define: { "process.env.NODE_ENV": '"production"' }, external: ["/fonts/*"],
  loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
  outfile: path.join(temp, "fixture.js"), logLevel: "silent" });
fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dashboard loading preview</title><link rel="stylesheet" href="/fixture.css"><style>body{margin:0}#root{height:100vh;display:flex;padding-left:24px;box-sizing:border-box}@media(max-width:600px){#root{padding-left:12px}}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
const server = http.createServer((request, response) => {
  const name = new URL(request.url, "http://fixture").pathname;
  const paths = { "/": ["index.html", "text/html"], "/fixture.js": ["fixture.js", "text/javascript"], "/fixture.css": ["fixture.css", "text/css"] };
  if (name.startsWith("/fonts/") && /^[\w./-]+$/.test(name) && !name.includes("..")) {
    const font = path.join(root, "app/manage-ui/public", name);
    if (fs.existsSync(font)) { response.writeHead(200, { "Content-Type": "font/woff2" }); response.end(fs.readFileSync(font)); return; }
  }
  if (!paths[name]) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "Content-Type": paths[name][1] }); response.end(fs.readFileSync(path.join(temp, paths[name][0])));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
if (process.argv.includes("--serve")) {
  console.log(`PREVIEW ${url}`);
  const close = () => { server.close(); fs.rmSync(temp, { recursive: true, force: true }); process.exit(0); };
  process.once("SIGTERM", close); process.once("SIGINT", close);
} else {
  fs.mkdirSync(output, { recursive: true });
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron"),fs=require("node:fs");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{backgroundThrottling:false}});let passed=false;
const bounded=(promise,label)=>Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(Error("Timed out: "+label)),12000))]);
try{const results=[];
const cases=[["cold","zh-CN","light",1280],["cold","en","dark",1280],["cold","zh-CN","light",760],["cold","en","dark",390],
["pending","zh-CN","light",1280],["failure","en","light",1280],["cache","zh-CN","light",1280],["filter","en","light",760],
["unavailable","zh-CN","dark",1280],["cold","zh-CN","light",1280,"reduce"]];
for(const [scenario,language,theme,width,motion] of cases){w.setContentSize(width,900);console.log("CHECK",scenario,language,theme,width,motion||"motion");
await bounded(w.loadURL(${JSON.stringify(url)}+"/?"+new URLSearchParams({scenario,language,theme})),"navigation");
if(!w.webContents.debugger.isAttached())w.webContents.debugger.attach("1.3");
await bounded(w.webContents.debugger.sendCommand("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:motion||"no-preference"}]}),"media");
await bounded(w.webContents.executeJavaScript("window.prepareScreenshot()"),"loading screenshot");
const name=[scenario,language,theme,width,motion||"motion"].join("-");
fs.writeFileSync(${JSON.stringify(output)}+"/"+name+"-loading.png",(await w.webContents.capturePage()).toPNG());
results.push(await bounded(w.webContents.executeJavaScript("window.runFixture()"),"loading behavior"));
fs.writeFileSync(${JSON.stringify(output)}+"/"+name+"-settled.png",(await w.webContents.capturePage()).toPNG());}
fs.writeFileSync(${JSON.stringify(output)}+"/results.json",JSON.stringify(results,null,2));console.log("PASS Dashboard loading: "+results.length+" scenarios");passed=true;
}catch(e){console.error(e.stack||e);try{console.error(await bounded(w.webContents.executeJavaScript("document.body.innerText.slice(-2500)"),"failure diagnostics"));
fs.writeFileSync(${JSON.stringify(output)}+"/failure.png",(await w.webContents.capturePage()).toPNG());}catch(diagnostic){console.error(diagnostic.message);}}
finally{w.destroy();app.exit(passed?0:1);}});`);
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [main], { env, stdio: ["ignore", "pipe", "pipe"] });
  let verified = false, timedOut = false;
  child.stdout.on("data", data => { process.stdout.write(data); if (String(data).includes("PASS Dashboard loading:")) verified = true; });
  child.stderr.on("data", data => process.stderr.write(data));
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 90000);
  try {
    const status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(status, 0, "Dashboard loading regression failed");
    assert(!timedOut && verified, "Dashboard renderer must complete every scenario before exiting");
  } finally { clearTimeout(timer); server.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}
