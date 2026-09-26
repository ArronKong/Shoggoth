#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const { build } = createRequire(path.join(uiRoot, "package.json"))("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-app-reference-ui-"));
const outputDir = path.join(root, ".artifacts/plugin-app-reference-ui-fixture");
fs.mkdirSync(outputDir, { recursive: true });
try {
  await build({ entryPoints: [path.join(root, "scripts/fixtures/plugin-app-reference.tsx")], bundle: true,
    format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(uiRoot, "node_modules")], logLevel: "silent" });
  const page = path.join(temp, "index.html");
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const {app,BrowserWindow,session}=require("electron");
const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel: !/^(file:|data:)/.test(details.url)}));
  const w=new BrowserWindow({show:false,width:900,height:950,webPreferences:{backgroundThrottling:false}});
  const outputDir=${JSON.stringify(outputDir)};let passed=false,timeout;
  try {
    await w.loadFile(${JSON.stringify(page)});
    await Promise.race([(async()=>{
      w.show();w.focus();w.webContents.focus();
      assert.equal((await w.webContents.executeJavaScript("window.preparePluginAppKeyboard()",true)).focused,true);
      w.webContents.sendInputEvent({type:"keyDown",keyCode:"Return"});
      w.webContents.sendInputEvent({type:"char",keyCode:"\\r"});
      w.webContents.sendInputEvent({type:"keyUp",keyCode:"Return"});
      const result=await w.webContents.executeJavaScript("window.runPluginAppReferenceFixture()",true);
      const geometry=[],screenshots=[];
      for(const width of [900,390]) {
        w.setContentSize(width,950);
        for(const theme of ["light","dark"]) {
          geometry.push(await w.webContents.executeJavaScript('window.preparePluginAppCapture('+JSON.stringify(theme)+')',true));
          const screenshot=path.join(outputDir,'app-reference-'+width+'-'+theme+'.png');
          fs.writeFileSync(screenshot,(await w.webContents.capturePage()).toPNG());screenshots.push(screenshot);
        }
      }
      const report={...result,geometry,screenshots,verified:true};
      fs.writeFileSync(path.join(outputDir,"report.json"),JSON.stringify(report,null,2)+"\\n");
      console.log(JSON.stringify(report));passed=true;
    })(),new Promise((_resolve,reject)=>{timeout=setTimeout(()=>reject(Error("App reference fixture deadline")),20000);})]);
  } catch(error) {
    console.error(error);
    console.error(await w.webContents.executeJavaScript("JSON.stringify({errors:window.fixtureErrors,writes:window.fixtureWrites,text:document.body.innerText})"));
    fs.writeFileSync(path.join(outputDir,"failure.png"),(await w.webContents.capturePage()).toPNG());
  } finally {clearTimeout(timeout);w.destroy();app.exit(passed?0:1);}
}).catch(error=>{console.error(error);app.exit(1)});`);
  const result = spawnSync(createRequire(path.join(root, "package.json"))("electron"), [main], {
    encoding: "utf8", timeout: 35_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  process.stdout.write(result.stdout || "");
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error || ""));
  assert.equal(result.status, 0, "App reference Electron rendered regression failed");
  assert.match(result.stdout, /"verified":true/u);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
