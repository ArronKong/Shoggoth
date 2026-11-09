import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { viteArtworkFixturePlugin } from "./fixtures/vite-artwork-esbuild.cjs";
const root = path.resolve(import.meta.dirname, "..");
const { build } = createRequire(path.join(root, "app/manage-ui/package.json"))("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-native-attachments-ui-"));
await build({ entryPoints: [path.join(root, "scripts/fixtures/native-chat-attachments.tsx")], bundle: true, format: "esm",
  define: { "process.env.NODE_ENV": '"production"' }, loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
  outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(root, "app/manage-ui/node_modules")], logLevel: "silent",
  plugins: [viteArtworkFixturePlugin(root)] });
fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><title>原生 Agent 附件验证</title><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}#checks{position:fixed;top:0;right:0;z-index:99999;background:#fff;padding:4px;font:12px sans-serif;max-width:600px}</style><div id="checks"><button id="run-checks">验证附件与路径</button><span id="status">隔离测试环境</span></div><div id="root"></div><script type="module" src="fixture.js"></script>');
if (process.argv.includes("--serve")) {
  const server = http.createServer((req, res) => {
    const file = ({ "/": "index.html", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css" })[req.url];
    if (!file) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", file.endsWith("js") ? "text/javascript" : file.endsWith("css") ? "text/css" : "text/html");
    res.end(fs.readFileSync(path.join(temp, file)));
  });
  server.listen(0, "127.0.0.1", () => console.log(`PREVIEW http://127.0.0.1:${server.address().port}`));
  process.on("SIGTERM", () => { server.close(); fs.rmSync(temp, { recursive: true, force: true }); process.exit(); });
} else {
  try {
    const main = path.join(temp, "main.cjs");
    const scenario = process.argv.includes("--attachment-history") ? "attachment-history"
      : process.argv.includes("--operation-history") ? "operation-history" : "";
    const runFixture = ({ "attachment-history": "window.runAttachmentHistoryFixture()",
      "operation-history": "window.runOperationHistoryFixture()" })[scenario]
      ?? (process.argv.includes("--files-only") ? "window.runFileRevealFixture()" : "window.runFixture()");
    const preload = path.join(temp, "preload.cjs");
    fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('fixtureClipboard',{
  write: value=>ipcRenderer.invoke('shoggoth:chat:write-clipboard',value),
  read: chatOnly=>ipcRenderer.invoke('shoggoth:chat:clipboard-files',{withCaption:true,chatOnly}),
  inspect: ()=>ipcRenderer.invoke('fixture:clipboard:inspect')
});`);
    fs.writeFileSync(main, `const {app,BrowserWindow,ipcMain,ClipboardItem}=require("electron");
const {registerDesktopChatClipboardIpc,clipboardFilePaths}=require(${JSON.stringify(path.join(root, "app/desktop-chat-clipboard-ipc.js"))});
const fs=require('node:fs'),path=require('node:path');
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1360,height:950,webPreferences:{backgroundThrottling:false,preload:${JSON.stringify(preload)}}});let passed=false;
let items=[],writes=0;
// Exercise the production bridge and Electron ClipboardItem without changing the user's clipboard.
const clipboard={read:async()=>items,write:async values=>{items=values;writes++}};
const dispose=registerDesktopChatClipboardIpc({ipcMain,clipboard,ClipboardItem,getWindows:()=>[w],getUiOrigin:()=>w.webContents.getURL()});
ipcMain.handle('fixture:clipboard:inspect',async()=>{
  const item=items[0];
  const read=async type=>item?.types.includes(type)?item.getType(type):null;
  return {writes,text:await (await read('text/plain'))?.text(),png:Buffer.from(await (await read('image/png'))?.arrayBuffer()??[]).toString('base64'),
    files:(await clipboardFilePaths(clipboard)).map(file=>({name:path.basename(file),base64:fs.readFileSync(file).toString('base64')}))};
});
w.webContents.on('console-message',({level,message})=>{if(level==='error')console.error(message)});
try{await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))}, { search: ${JSON.stringify(scenario)} });
const result=await w.webContents.executeJavaScript(${JSON.stringify(`(async()=>{try{return await ${runFixture}}catch(error){return {error:error?.stack||String(error)}}})()`)});
if(!result?.passed)throw Error(result?.error||'Fixture failed');console.log(JSON.stringify(result));passed=true;}catch(e){console.error(e);}finally{dispose();w.destroy();app.exit(passed?0:1);}});`);
    const result = spawnSync(path.join(root, "node_modules/.bin/electron"), [main], { encoding: "utf8", timeout: 45000,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
    process.stdout.write(result.stdout || "");
    if (result.status !== 0) process.stderr.write(result.stderr || String(result.error));
    assert.equal(result.status, 0);
    assert.match(result.stdout, /"passed":true/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
