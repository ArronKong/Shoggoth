#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, ".."), uiRoot = path.join(root, "app/manage-ui");
const require = createRequire(path.join(root, "package.json"));
const uiRequire = createRequire(path.join(uiRoot, "package.json"));
const outputDir = path.resolve(process.argv.find(value => value.startsWith("--output-dir="))?.slice(13) || "/private/tmp/codex-security-detail-ui");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-security-detail-ui-"));
const dto = require("./app/core/plugin-codex-security-status-dto");
const evidence = require("./docs/architecture/codex-security-service-wiring-evidence-2026-09-28.json");
const raw = evidence.accountProjection;
const base = dto.projectCodexSecurityServiceStatus(raw, { installationId: raw.installation.installationId, runtimeProfileId: raw.candidate.runtimeProfileId });
const cases = [{ scenario: "unauthenticated", width: 900, theme: "light" },
  { scenario: "authenticated", width: 900, theme: "dark" }, { scenario: "missing", width: 390, theme: "light" },
  { scenario: "disabled", width: 390, theme: "dark" }, { scenario: "error", width: 900, theme: "light" },
  { scenario: "delayed", width: 900, theme: "light" }];
fs.mkdirSync(outputDir, { recursive: true });
try {
  await uiRequire("esbuild").build({ entryPoints: [path.join(root, "scripts/fixtures/plugin-codex-security-detail.tsx")],
    bundle: true, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"', "__CODEX_SECURITY_RENDER_BASE__": JSON.stringify(base) },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(uiRoot, "node_modules")], logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
  const main = path.join(temp, "main.cjs"), reportPath = path.join(outputDir, "report.json");
  fs.writeFileSync(main, `const {app,BrowserWindow,session}=require("electron");
const fs=require("node:fs"),path=require("node:path");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!/^(file:|data:)/.test(details.url)}));
 const w=new BrowserWindow({show:false,width:900,height:900,webPreferences:{backgroundThrottling:false}});
 let passed=false;const results=[];
 try{
  for(const entry of ${JSON.stringify(cases)}){
   w.setContentSize(entry.width,900);await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))});
   const result=await w.webContents.executeJavaScript('window.runCodexSecurityDetail('+JSON.stringify(entry.scenario)+','+JSON.stringify(entry.theme)+')',true);
   await new Promise(resolve=>setTimeout(resolve,100));
   if(entry.scenario!=='delayed')fs.writeFileSync(path.join(${JSON.stringify(outputDir)},entry.scenario+'-'+entry.width+'.png'),(await w.webContents.capturePage()).toPNG());
   const errors=await w.webContents.executeJavaScript('window.fixtureErrors',true);if(errors.length)throw new Error(JSON.stringify(errors));
   results.push(result);
  }
  fs.writeFileSync(${JSON.stringify(reportPath)},JSON.stringify({passed:true,results,api:'controlled status responses; production React/PluginsPage/detail/CSS'},null,2)+'\\n');passed=true;
 }catch(error){
  const details=await w.webContents.executeJavaScript('JSON.stringify({errors:window.fixtureErrors,text:document.body.innerText.slice(-5000)})').catch(()=>null);
  fs.writeFileSync(${JSON.stringify(reportPath)},JSON.stringify({passed:false,error:String(error),details,results},null,2)+'\\n');
  fs.writeFileSync(path.join(${JSON.stringify(outputDir)},'failure.png'),(await w.webContents.capturePage()).toPNG());
 }finally{w.destroy();app.exit(passed?0:1);}
});`);
  const result = spawnSync(require("electron"), [main], { encoding: "utf8", timeout: 60_000,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
  assert(fs.existsSync(reportPath), result.stderr || String(result.error || "no render report"));
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(result.status, 0, report.error || result.stderr || String(result.error));
  assert.equal(report.passed, true); assert.equal(report.results.length, cases.length);
  console.log(`Codex Security production detail render: ${report.results.length} scenarios PASS (${reportPath})`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
