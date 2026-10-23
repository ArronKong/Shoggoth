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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sg-zoom-ui-"));
const outputDir = path.resolve(process.argv.find(value => value.startsWith("--output-dir="))?.slice(13)
  || path.join(temp, "screenshots"));
try {
  fs.mkdirSync(outputDir, { recursive: true });
  await build({ entryPoints: [path.join(root, "scripts/fixtures/plugin-zoom-registration.tsx")],
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
  const w=new BrowserWindow({show:false,width:900,height:850,webPreferences:{backgroundThrottling:false}});
  let passed=false;
  try {
    await w.loadFile(${JSON.stringify(page)});
    await w.webContents.executeJavaScript("window.prepareZoomRegistration()",true);
    const geometry=[];
    for(const width of [900,390]) {
      w.setContentSize(width,850);
      const size=await w.webContents.executeJavaScript("window.zoomGeometry()",true);
      assert(size.formVisible && size.passwordMasked);
      assert(size.fullWidth<=width+1,JSON.stringify(size));
      assert(size.maxRight<=width+1,JSON.stringify(size));
      geometry.push(size);
      fs.writeFileSync(path.join(${JSON.stringify(outputDir)},'zoom-registration-'+width+'.png'),
        (await w.webContents.capturePage()).toPNG());
    }
    const submit=await w.webContents.executeJavaScript("window.submitZoomRegistration()",true);
    assert.deepEqual(submit,{cleared:true,configured:true,noOverwrite:true,secretAbsent:true});
    console.log(JSON.stringify({verified:true,geometry,submit}));passed=true;
  } catch(error) {console.error(error);}
  finally {w.destroy();app.exit(passed?0:1);}
}).catch(error=>{console.error(error);app.exit(1)});`);
  const result = spawnSync(createRequire(path.join(root, "package.json"))("electron"), [main], {
    encoding: "utf8", timeout: 60_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  process.stdout.write(result.stdout || "");
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error || ""));
  assert.equal(result.status, 0, "Zoom registration Electron UI regression failed");
  assert.match(result.stdout, /"verified":true/u);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
