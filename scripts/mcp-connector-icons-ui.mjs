#!/usr/bin/env node
// Production Vite transforms and real Chromium image decoding under a saturated
// HTTP/1 connection pool. All HTTP traffic and Electron state are disposable.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "../app/manage-ui/node_modules/vite/dist/node/index.js";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { UI_CONTENT_SECURITY_POLICY } = require("../app/ui-content-security.js");
const ui = path.join(root, "app/manage-ui");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-connector-icons-"));
const dist = path.join(temp, "dist");
const held = new Set();
const imageRequests = [];
let server, serving = false;
const release = () => { for (const res of held) res.end("released"); held.clear(); };
try {
  const result = await build({ root: ui, publicDir: false, logLevel: "error",
    resolve: { alias: { react: path.join(ui, "node_modules/react"), "react-dom": path.join(ui, "node_modules/react-dom") } },
    build: { outDir: dist, assetsInlineLimit: 0, rollupOptions: { input: path.join(root, "scripts/fixtures/mcp-connector-icons.tsx") } } });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const entry = output.find(item => item.type === "chunk" && item.isEntry).fileName;
  const css = output.filter(item => item.fileName.endsWith(".css")).map(item => `<link rel="stylesheet" href="/${item.fileName}">`).join("");
  fs.writeFileSync(path.join(dist, "index.html"), `<!doctype html><html data-theme="light"><meta charset="utf-8"><title>Connector icon loading fixture</title>${css}<style>html{color-scheme:light dark}html[data-theme=light]{color-scheme:light}html[data-theme=dark]{color-scheme:dark}body{font:14px system-ui;margin:24px}.catalog{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:24px;margin-top:24px}.item{display:flex;align-items:center;flex-direction:column;gap:8px;text-align:center;overflow-wrap:anywhere}button{padding:8px 16px}</style><div id="root"></div><script type="module" src="/${entry}"></script></html>`);
  server = http.createServer((req, res) => {
    const route = new URL(req.url, "http://127.0.0.1").pathname;
    if (route.startsWith("/slow/")) { if (serving) { res.end("preview"); return; } held.add(res); res.on("close", () => held.delete(res)); return; }
    const file = path.resolve(dist, "." + (route === "/" ? "/index.html" : route));
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(file);
    if (ext === ".png") imageRequests.push(route);
    res.writeHead(200, { "Content-Type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" })[ext] || "application/octet-stream",
      "Cache-Control": "no-cache", "Content-Security-Policy": UI_CONTENT_SECURITY_POLICY });
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  if (process.argv.includes("--serve")) {
    // Browser preview runs without artificial API saturation; the automatic
    // Electron check below supplies that condition out of band.
    fs.appendFileSync(path.join(dist, entry), "\nwindow.heldRequests=6;window.releaseRequests=async()=>{};\n");
    serving = true;
    console.log(JSON.stringify({ url, temp, entryBytes: fs.statSync(path.join(dist, entry)).size }));
    const close = () => { release(); server.closeAllConnections(); server.close(); fs.rmSync(temp, { recursive: true, force: true }); process.exit(); };
    process.once("SIGTERM", close); process.once("SIGINT", close);
  } else {
    const driver = path.join(temp, "main.cjs");
    const screenshot = process.argv.find(value => value.startsWith("--screenshot="))?.slice(13);
    fs.writeFileSync(driver, `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(temp, "profile"))});app.setPath('sessionData',${JSON.stringify(path.join(temp, "session"))});
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1400,height:1200,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});let passed=false;
try{await win.loadURL(${JSON.stringify(url)});
const waitFor=async(code)=>{const until=Date.now()+5000;while(!await win.webContents.executeJavaScript(code)){if(Date.now()>until)throw Error('Fixture not ready');await new Promise(r=>setTimeout(r,20));}};
await waitFor('typeof window.runFixture === "function"');
await win.webContents.executeJavaScript('window.goOffline=()=>new Promise(resolve=>{window.offlineReady=resolve;window.offlineRequested=true});window.releaseRequests=()=>{window.releaseRequested=true};void 0');
const timer=setInterval(()=>{process.send?.({type:'held'});},20);
let checking=false,offline=false,pendingUpdates=0,driverError;
const onMessage=async message=>{if(message.type!=='held')return;pendingUpdates++;try{await win.webContents.executeJavaScript('window.heldRequests='+message.count);}catch(error){driverError=error;}finally{pendingUpdates--;}};
process.on('message',onMessage);
const offlineTimer=setInterval(async()=>{if(checking)return;checking=true;try{if(!offline&&await win.webContents.executeJavaScript('!!window.offlineRequested')){offline=true;win.webContents.session.enableNetworkEmulation({offline:true});await win.webContents.executeJavaScript('window.offlineReady();void 0');}if(await win.webContents.executeJavaScript('!!window.releaseRequested'))process.send?.({type:'release'});}catch(error){driverError=error;}finally{checking=false;}},20);
try{const report=await win.webContents.executeJavaScript('window.runFixture()');console.log(JSON.stringify(report));
if(${JSON.stringify(Boolean(screenshot))})require('node:fs').writeFileSync(${JSON.stringify(screenshot || "")},(await win.webContents.capturePage()).toPNG());passed=true;}finally{clearInterval(timer);clearInterval(offlineTimer);process.off('message',onMessage);while(checking||pendingUpdates)await new Promise(resolve=>setTimeout(resolve,5));if(driverError)throw driverError;}
}catch(error){passed=false;console.error(error);}finally{win.destroy();app.exit(passed?0:1);}});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [driver], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 20000);
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    child.on("message", message => { if (message.type === "held" && child.connected) child.send({ type: "held", count: held.size }); if (message.type === "release") release(); });
    const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
    clearTimeout(timeout);
    assert.equal(code, 0, "connector icon browser regression failed");
    assert.equal(imageRequests.length, 0, "bundled artwork must not compete with API requests");
  }
} finally {
  if (!serving) {
    release(); server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
