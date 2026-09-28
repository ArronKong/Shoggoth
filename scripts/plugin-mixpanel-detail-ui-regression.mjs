#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const require = createRequire(path.join(uiRoot, "package.json"));
const outputDir = path.resolve(process.argv.find(value => value.startsWith("--output-dir="))?.slice(13)
  || path.join(root, ".artifacts", `mixpanel-detail-ui-${new Date().toISOString().replace(/[:.]/gu, "-")}`));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-mixpanel-detail-ui-"));
fs.mkdirSync(outputDir, { recursive: true });
try {
  await require("esbuild").build({ entryPoints: [path.join(root, "scripts/fixtures/plugins-page.tsx")],
    bundle: true, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(uiRoot, "node_modules")], logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const {app,BrowserWindow,session}=require("electron");
const fs=require("node:fs"),path=require("node:path");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel: !/^(file:|data:)/.test(details.url)}));
  const w=new BrowserWindow({show:true,width:900,height:900,webPreferences:{backgroundThrottling:false}});
  const outputDir=${JSON.stringify(outputDir)};
  const reportPath=path.join(outputDir,"report.json");
  let passed=false;
  try {
    await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))});
    const results=[];
    for(const width of [900,390]) {
      w.setContentSize(width,900);
      await w.webContents.executeJavaScript('window.prepareBundledCapture("light")',true);
      await new Promise(resolve=>setTimeout(resolve,200));
      const result=await w.webContents.executeJavaScript('window.prepareBundledDetailCapture()',true);
      const dialog=await w.webContents.executeJavaScript('(()=>{const d=document.querySelector("dialog[open]"); const r=d.getBoundingClientRect(); const b=d.querySelector("footer button:last-child").getBoundingClientRect(); const s=d.querySelector("[class*=scroll]"); return {warning:d.textContent.includes("来源包参考文档缺失"), left:r.left,right:r.right,top:r.top,bottom:r.bottom,viewport:innerWidth,viewportHeight:innerHeight,buttonTop:b.top,buttonBottom:b.bottom,scroll:s.scrollWidth,scrollHeight:s.scrollHeight,scrollClientHeight:s.clientHeight}})()',true);
      fs.writeFileSync(path.join(outputDir,'mixpanel-detail-'+width+'.png'),(await w.webContents.capturePage()).toPNG());
      results.push({width,...result,...dialog});
      await w.webContents.executeJavaScript('window.closeBundledDetail()',true);
    }
    fs.writeFileSync(reportPath,JSON.stringify({verified:true,results},null,2)+'\\n');
    passed=true;
  } catch(error) {
    const details=await w.webContents.executeJavaScript('JSON.stringify({errors:window.fixtureErrors,text:document.body.innerText.slice(0,2500)})').catch(()=>null);
    fs.writeFileSync(reportPath,JSON.stringify({verified:false,error:String(error),details},null,2)+'\\n');
    fs.writeFileSync(path.join(outputDir,'failure.png'),(await w.webContents.capturePage()).toPNG());
  } finally {w.destroy();app.exit(passed?0:1);}
}).catch(error=>{fs.writeFileSync(${JSON.stringify(path.join(outputDir, "report.json"))},JSON.stringify({verified:false,error:String(error)})+'\\n');app.exit(1)});`);
  const result = spawnSync(createRequire(path.join(root, "package.json"))("electron"), [main], {
    encoding: "utf8", timeout: 30_000,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  const reportPath = path.join(outputDir, "report.json");
  assert.ok(fs.existsSync(reportPath), `Electron produced no report (exit ${result.status}, signal ${result.signal}): ${result.stderr || result.stdout}`);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(result.status, 0, result.stderr || String(result.error || report.error || "Electron failed"));
  assert.equal(report.verified, true, report.error || "Mixpanel detail render failed");
  assert.deepEqual(report.results.map(value => value.width), [900, 390]);
  assert.ok(report.results.every(value => value.warning && value.horizontalOverflow === false
    && value.left >= 0 && value.right <= value.viewport
    && value.top >= 0 && value.bottom <= value.viewportHeight
    && value.buttonTop >= value.top && value.buttonBottom <= value.bottom));
  process.stdout.write(`Mixpanel detail warning rendered at 900px and 390px: PASS (${reportPath})\n`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
