#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const requireUi = createRequire(path.join(uiRoot, "package.json"));
const { build } = requireUi("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-chat-plugin-picker-"));
const outputDir = path.join(root, ".artifacts/chat-plugin-picker-ui-fixture");
fs.mkdirSync(outputDir, { recursive: true });
try {
  await build({ entryPoints: [path.join(root, "scripts/fixtures/chat-plugin-picker.tsx")], bundle: true,
    format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(uiRoot, "node_modules")], logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron");
const fs=require("node:fs"),path=require("node:path");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:900,height:900,webPreferences:{backgroundThrottling:false}});
const outputDir=${JSON.stringify(outputDir)};let passed=false;try{
await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))});w.show();w.focus();
const checks=await w.webContents.executeJavaScript("window.runChatPluginPickerFixture()",true);
const geometry=[];for(const width of [900,390]){w.setContentSize(width,900);for(const theme of ["light","dark"]){
geometry.push(await w.webContents.executeJavaScript('window.captureChatPluginPicker('+JSON.stringify(theme)+')',true));
fs.writeFileSync(path.join(outputDir,'picker-'+width+'-'+theme+'.png'),(await w.webContents.capturePage()).toPNG());}}
const report={checks,geometry,verified:true};fs.writeFileSync(path.join(outputDir,"report.json"),JSON.stringify(report,null,2)+"\\n");
console.log(JSON.stringify(report));passed=true;
}catch(error){console.error(error);console.error(await w.webContents.executeJavaScript("JSON.stringify({errors:window.fixtureErrors,text:document.body.innerText})"));
fs.writeFileSync(path.join(outputDir,"failure.png"),(await w.webContents.capturePage()).toPNG());
}finally{w.destroy();app.exit(passed?0:1);}}).catch(error=>{console.error(error);app.exit(1)});`);
  const result = spawnSync(createRequire(path.join(root, "package.json"))("electron"), [main], {
    encoding: "utf8", timeout: 35_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  process.stdout.write(result.stdout || "");
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error || ""));
  assert.equal(result.status, 0, "chat plugin picker Electron regression failed");
  const report = JSON.parse(fs.readFileSync(path.join(outputDir, "report.json"), "utf8"));
  for (const item of report.geometry) {
    assert.deepEqual(item.errors, []);
    assert.ok(item.scrollWidth <= item.width, `horizontal overflow at ${item.width}/${item.theme}`);
    assert.ok(item.panel.left >= 0 && item.panel.right <= item.width && item.panel.top >= 0,
      `picker panel outside window at ${item.width}/${item.theme}`);
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
