#!/usr/bin/env node
import { viteArtworkFixturePlugin } from "./fixtures/vite-artwork-esbuild.cjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, "..");
const requireUi = createRequire(path.join(root, "app/manage-ui/package.json"));
const { build } = requireUi("esbuild");
const out = process.env.LIVE_RECOVERY_OUTPUT || path.join(root, ".artifacts/chat-live-session-recovery-ui");
fs.mkdirSync(out, { recursive: true });
const baseline = process.env.LIVE_RECOVERY_SOURCE_REF;
const interruptedOnly = process.env.LIVE_RECOVERY_INTERRUPTED_ONLY === "1";
const reports = [];
for (const backendId of interruptedOnly ? ["shoggoth"] : baseline ? ["hermes"] : ["hermes", "openclaw", "shoggoth"]) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-live-recovery-"));
  try {
    await build({ entryPoints: [path.join(root, "scripts/fixtures/chat-live-session-recovery.tsx")], bundle: true, format: "esm",
      define: { "process.env.NODE_ENV": '"production"', __LIVE_RECOVERY_BACKEND__: JSON.stringify(backendId) },
      loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
      outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(root, "app/manage-ui/node_modules")], logLevel: "silent",
      plugins: [viteArtworkFixturePlugin(root), ...(baseline ? [{ name: "baseline", setup(builder) {
        builder.onLoad({ filter: /(?:ChatPage\.tsx|chatHistoryRuntime\.ts|McpApprovalInbox\.tsx)$/ }, ({ path: file }) => ({
          contents: execFileSync("git", ["show", `${baseline}:${path.relative(root, file)}`], { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }),
          loader: path.extname(file).slice(1), resolveDir: path.dirname(file),
        }));
      } }] : [])] });
    fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
    const main = path.join(temp, "main.cjs");
    fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron"),fs=require("node:fs");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{backgroundThrottling:false}});const timeout=setTimeout(()=>app.exit(2),45000);let passed=false;
w.webContents.on("console-message",event=>{if(event.level==="error")console.error("[fixture renderer] "+event.message);});
try{await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))},{hash:"/chat"});
const result=await w.webContents.executeJavaScript(${JSON.stringify(interruptedOnly ? "window.runInterruptedTailFixture()" : "window.runLiveRecoveryFixture()")});const geometry=[];
if(!${interruptedOnly})for(const width of [1200,390]){w.setContentSize(width,900);for(const theme of ['light','dark']){geometry.push(await w.webContents.executeJavaScript('window.captureMcpApproval('+JSON.stringify(theme)+')'));fs.writeFileSync(${JSON.stringify(out)}+'/'+${JSON.stringify(backendId)}+'-'+width+'-'+theme+'.png',(await w.webContents.capturePage()).toPNG());}}
if(${JSON.stringify(backendId)}==='shoggoth'){w.setContentSize(1200,900);if(!${interruptedOnly})result.interruptedTail=await w.webContents.executeJavaScript('window.runInterruptedTailFixture()');fs.writeFileSync(${JSON.stringify(out)}+'/shoggoth-interrupted-tail.png',(await w.webContents.capturePage()).toPNG());}
console.log(JSON.stringify({...result,geometry}));passed=true;
}catch(error){console.error(error.stack||error);console.error(await w.webContents.executeJavaScript('JSON.stringify({error:window.fixtureError,text:document.body.innerText.slice(-3500),replies:document.querySelectorAll(".chat-thread .is-assistant .chat-bubble").length})'));fs.writeFileSync(${JSON.stringify(out)}+'/'+${JSON.stringify(backendId)}+'-failure.png',(await w.webContents.capturePage()).toPNG());}
finally{clearTimeout(timeout);w.destroy();app.exit(passed?0:1);}});`);
    const result = spawnSync(path.join(root, "node_modules/.bin/electron"), [main], {
      encoding: "utf8", timeout: 50000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
    });
    fs.writeFileSync(path.join(out, `${backendId}${baseline ? "-baseline" : ""}.log`), (result.stdout || "") + (result.stderr || ""));
    if (result.status !== 0) process.stderr.write(result.stderr || String(result.error));
    assert.equal(result.status, 0, `${backendId} live recovery UI failed`);
    const report = result.stdout.split("\n").filter(line => line.startsWith('{"backendId":')).map(line => JSON.parse(line)).at(-1);
    assert(report); assert.equal(report.errors, null);
    for (const item of report.geometry) { assert(item.inline); assert(item.actionsReachable); assert(item.scrollWidth <= item.width, `overflow at ${backendId}/${item.width}/${item.theme}`); }
    reports.push(report); console.log(JSON.stringify(report));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(reports, null, 2) + "\n");
