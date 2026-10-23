#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, ".."), uiRoot = path.join(root, "app/manage-ui");
const requireUi = createRequire(path.join(uiRoot, "package.json")), temp = fs.mkdtempSync(path.join(os.tmpdir(), "sg-managed-settings-ui-"));
const output = path.join(root, ".artifacts/managed-host-settings-ui-fixture"); fs.mkdirSync(output, { recursive: true });
const sourceFiles = ["app/manage-ui/src/pages/SettingsPage.tsx", "app/manage-ui/src/components/ManagedPluginHostPanel.tsx",
  "app/manage-ui/src/lib/managedPluginHostApi.ts", "app/manage-ui/src/lib/managedPluginHostRecovery.ts", "app/manage-ui/src/lib/managedPluginHostSettings.ts",
  "app/manage-ui/src/components/ManagedPluginHostPanel.module.css", "app/manage-ui/src/i18n/locales/zh-CN.ts", "app/manage-ui/src/i18n/locales/en.ts",
  "app/manage-ui/src/types.ts", "scripts/plugin-managed-host-settings-ui.mjs", "scripts/fixtures/managed-plugin-host-settings.tsx"];
const captureHashes = () => Object.fromEntries(sourceFiles.map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")]));
const sourceHashes = captureHashes();
try {
  await requireUi("esbuild").build({ entryPoints: [path.join(root, "scripts/fixtures/managed-plugin-host-settings.tsx")], bundle: true, format: "esm", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.glob": "fixtureGlob" }, banner: { js: "const fixtureGlob=()=>({});" },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".png": "dataurl", ".webp": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(uiRoot, "node_modules")], logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron"),fs=require("node:fs"),assert=require("node:assert/strict");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{let win,verified=false;try{win=new BrowserWindow({show:false,width:1000,height:1100,webPreferences:{backgroundThrottling:false}});
await win.loadFile(${JSON.stringify(path.join(temp, "index.html"))});win.show();let timer;
const report=await Promise.race([win.webContents.executeJavaScript("window.runManagedSettingsFixture()",true),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error("Settings guard deadline")),15000))]).finally(()=>clearTimeout(timer));
assert.equal(report.verified,true);fs.writeFileSync(${JSON.stringify(path.join(output, "report.json"))},JSON.stringify(report,null,2));
fs.writeFileSync(${JSON.stringify(path.join(output, "managed-settings.png"))},(await win.webContents.capturePage()).toPNG());console.log(JSON.stringify(report));verified=true;
}catch(error){console.error(error);if(win&&!win.isDestroyed()){console.error(await win.webContents.executeJavaScript("JSON.stringify({errors:window.fixtureErrors,text:document.body.innerText,requests:window.fixtureRequests})"));}}
finally{if(win&&!win.isDestroyed())win.destroy();app.exit(verified?0:1);}}).catch(error=>{console.error(error);app.exit(1)});`);
  const result = spawnSync(createRequire(path.join(root, "package.json"))("electron"), [main], { encoding: "utf8", timeout: 25000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
  process.stdout.write(result.stdout || ""); if (result.status !== 0) process.stderr.write(result.stderr || String(result.error || ""));
  assert.equal(result.status, 0, "actual Settings managed-mode render failed"); assert.match(result.stdout, /"verified":true/);
  assert.deepEqual(captureHashes(), sourceHashes, "Settings source changed during actual render proof; rerun required");
  const reportPath = path.join(output, "report.json");
  fs.writeFileSync(reportPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(reportPath, "utf8")), sourceHashes }, null, 2) + "\n");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
