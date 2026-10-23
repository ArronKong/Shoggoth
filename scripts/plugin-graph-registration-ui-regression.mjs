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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sg-graph-registration-ui-"));
const outputDir = path.resolve(process.argv.find(value => value.startsWith("--output-dir="))?.slice(13)
  || path.join(root, ".artifacts/graph-registration-ui-fixture"));
try {
  fs.mkdirSync(outputDir, { recursive: true });
  await build({ entryPoints: [path.join(root, "scripts/fixtures/plugin-graph-registration.tsx")],
    bundle: true, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
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
  const w=new BrowserWindow({show:false,width:900,height:1000,webPreferences:{backgroundThrottling:false}});
  let passed=false;
  try {
    await w.loadFile(${JSON.stringify(page)});
    await w.webContents.executeJavaScript("window.prepareGraphRegistration()",true);
    const geometry=[];
    for(const width of [900,390]) {
      w.setContentSize(width,1000);
      for(const theme of ["light","dark"]) {
        const result=await w.webContents.executeJavaScript('window.graphGeometry('+JSON.stringify(theme)+')',true);
        assert(result.formVisible && result.fullWidth<=width+1 && result.maxRight<=width+1
          && result.minLeft>=-1,JSON.stringify(result));
        geometry.push(result);
        fs.writeFileSync(path.join(${JSON.stringify(outputDir)},'graph-registration-'+width+'-'+theme+'.png'),
          (await w.webContents.capturePage()).toPNG());
      }
    }
    assert.notEqual(geometry[0].background,geometry[1].background,"light and dark surfaces differ");
    const interaction=await w.webContents.executeJavaScript("window.submitGraphRegistration()",true);
    assert.deepEqual(interaction,{requests:2,sharedControls:5});
    const orphanedAccount=await w.webContents.executeJavaScript("window.verifyOrphanedGraphAccount()",true);
    assert.equal(orphanedAccount,true);
    const report={verified:true,geometry,interaction,orphanedAccount};
    fs.writeFileSync(path.join(${JSON.stringify(outputDir)},"report.json"),JSON.stringify(report,null,2)+"\\n");
    console.log(JSON.stringify(report));passed=true;
  } catch(error) {
    console.error(error);
    console.error(await w.webContents.executeJavaScript("JSON.stringify({errors:window.fixtureErrors,text:document.body.innerText})"));
  } finally {w.destroy();app.exit(passed?0:1);}
}).catch(error=>{console.error(error);app.exit(1)});`);
  const result = spawnSync(createRequire(path.join(root, "package.json"))("electron"), [main], {
    encoding: "utf8", timeout: 60_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  process.stdout.write(result.stdout || "");
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error || ""));
  assert.equal(result.status, 0, "Graph registration Electron UI regression failed");
  assert.match(result.stdout, /"verified":true/u);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
