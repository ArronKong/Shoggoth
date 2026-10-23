#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const require = createRequire(path.join(root, "package.json"));
const { BundledPluginCatalog, bundledRoot } = require("./app/core/bundled-plugin-catalog");
const { build } = createRequire(path.join(uiRoot, "package.json"))("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sg-bundled-catalog-ui-"));
const output = path.resolve(process.argv.find(value => value.startsWith("--output-dir="))?.slice(13)
  || path.join(root, ".artifacts/plugin-bundled-catalog-ui"));
fs.mkdirSync(output, { recursive: true });
try {
  const catalogPath = path.join(temp, "catalog.json");
  const proof = spawnSync(process.execPath, [path.join(root, "scripts/plugin-bundled-catalog-regression.cjs")], {
    env: { ...process.env, SHOGGOTH_TEST_BUNDLED_CATALOG: catalogPath }, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(proof.status, 0, proof.stdout + proof.stderr);
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const scope = JSON.parse(fs.readFileSync(path.join(root,
    "docs/architecture/bundled-plugin-scope-2026-10-02.json"), "utf8"));
  assert.deepEqual(catalog.items.map(item => item.id).sort(), [...scope.activePackageIds].sort(),
    "App library must show only the nine scoped bundled packages");
  const source = new BundledPluginCatalog(bundledRoot());
  const icons = {};
  const details = Object.fromEntries(catalog.items.map(item => [item.id, source.detail(item.id)]));
  fs.mkdirSync(path.join(temp, "icons"));
  for (const item of catalog.items) {
    const icon = source.readIcon(item.id);
    if (!icon) continue;
    const file = path.join(temp, "icons", `${item.id}.${icon.mimeType.split("/")[1].replace("svg+xml", "svg")}`);
    fs.writeFileSync(file, icon.bytes);
    icons[item.id] = file;
  }
  await build({ entryPoints: [path.join(root, "scripts/fixtures/plugins-page.tsx")], bundle: true,
    format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(uiRoot, "node_modules")], logLevel: "silent" });
  const page = path.join(temp, "index.html");
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const {app,BrowserWindow,session}=require("electron");
const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict"),{pathToFileURL}=require("node:url");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{
  const icons=${JSON.stringify(icons)};
  session.defaultSession.webRequest.onBeforeRequest((d,cb)=>{
    const match=d.url.match(/\\/__api\\/plugins\\/bundled-icon\\/([a-z0-9-]+)/);
    if(match&&icons[match[1]])return cb({redirectURL:pathToFileURL(icons[match[1]]).href});
    cb({cancel: !/^(file:|data:)/.test(d.url)});
  });
  const w=new BrowserWindow({show:false,width:1100,height:950,webPreferences:{backgroundThrottling:false}});
  let passed=false;
  try {
    await w.loadFile(${JSON.stringify(page)});
    await w.webContents.executeJavaScript(${JSON.stringify(`(async()=>{
      const wait=async check=>{for(let n=0;n<150;n++){if(check())return;await new Promise(r=>setTimeout(r,40));}throw Error("bundled library did not render");};
      await wait(()=>typeof window.remountPlugins==="function");
      window.verifiedBundledCatalog=${JSON.stringify(catalog)};
      window.verifiedBundledDetails=${JSON.stringify(details)};
      window.authoredCatalog={supported:true,catalogRevision:"empty-installations",nextCursor:null,items:[]};
      window.remountPlugins();
      const cards=()=>[...document.querySelectorAll('button[aria-label]')].filter(card=>/^查看 .+ 详情$/.test(card.getAttribute("aria-label")));
      const host=()=>document.querySelector('[role="tab"][aria-label="Shoggoth"]');
      await wait(()=>host());
      host().click();
      await wait(()=>cards().length===${catalog.items.length});
      await wait(()=>host().getAttribute("aria-selected")==="true");
      if(document.querySelector('[role="dialog"]'))throw Error("catalog is hidden in a dialog");
      const names=cards().map(card=>card.getAttribute("aria-label"));
      const expected=${JSON.stringify(catalog.items.map(item => `查看 ${item.displayName} 详情`))};
      if(expected.some(name=>!names.includes(name)))throw Error("missing bundled plugin cards");
      const groupCount=[...document.querySelectorAll('[data-plugin-group] h2 + span')].reduce((count,span)=>count+Number(span.textContent),0);
      if(groupCount!==${catalog.items.length})throw Error("incorrect grouped library count");
      if(document.querySelector('#plugin-library-search, #plugin-library-category'))throw Error("removed library filters remain");
      if([...document.querySelectorAll('button')].some(button=>["打开技能","从文件或 Git 安装"].includes(button.textContent)))throw Error("removed toolbar actions remain");
      if(document.body.innerText.includes("内置插件目录暂不可用"))throw Error("library unavailable");
      await wait(()=>[...document.querySelectorAll('[data-plugin-id] img')].filter(img=>{const r=img.getBoundingClientRect();return r.top<innerHeight&&r.bottom>0;}).every(img=>img.complete&&img.naturalWidth>0));
      if(window.fixtureErrors.length)throw Error(window.fixtureErrors.join("\\n"));
      if(document.documentElement.scrollWidth>innerWidth)throw Error("horizontal overflow");
      return {verified:true,packages:names.length};
    })()` )},true);
    await w.webContents.executeJavaScript("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",true);
    const screenshot=path.join(${JSON.stringify(output)},"bundled-plugins.png");
    fs.writeFileSync(screenshot,(await w.webContents.capturePage()).toPNG());
    const detailScreenshots=[];
    for(const width of [1100,390]) {
      w.setContentSize(width,950);
      await w.webContents.executeJavaScript(${JSON.stringify(`(async()=>{
        const wait=async check=>{for(let n=0;n<150;n++){if(check())return;await new Promise(r=>setTimeout(r,40));}throw Error("Gmail detail did not render");};
        document.getElementById("plugin-card-gmail").click();
        await wait(()=>{const dialog=document.querySelector('[role="dialog"]');return dialog&&getComputedStyle(dialog).opacity==="1"&&dialog.textContent.includes("gog mcp");});
        const dialog=document.querySelector('[role="dialog"]');
        const action=dialog.querySelector('header [class*="headerActions"] button');
        if(!action||action.disabled||action.textContent!=="+ 安装插件")throw Error("detail install action missing");
        const rect=dialog.getBoundingClientRect(),button=action.getBoundingClientRect();
        if(rect.left<0||rect.right>innerWidth||rect.top<0||rect.bottom>innerHeight)throw Error("detail exceeds viewport");
        if(button.top<rect.top||button.bottom>rect.bottom)throw Error("top install action not visible");
        if(window.fixtureErrors.length)throw Error(window.fixtureErrors.join("\\n"));
      })()` )},true);
      const detailScreenshot=path.join(${JSON.stringify(output)},'gmail-detail-'+width+'.png');
      fs.writeFileSync(detailScreenshot,(await w.webContents.capturePage()).toPNG());
      detailScreenshots.push(detailScreenshot);
      await w.webContents.executeJavaScript("window.closePluginInstaller()",true);
    }
    console.log(JSON.stringify({verified:true,screenshot,detailScreenshots,packages:${catalog.items.length},source:"real Service and desktop backend response"}));
    passed=true;
  }catch(error){console.error(error);console.error(await w.webContents.executeJavaScript("JSON.stringify({errors:window.fixtureErrors,text:document.body.innerText.slice(0,2000)})"));}
  finally{w.destroy();app.exit(passed?0:1);}
}).catch(error=>{console.error(error);app.exit(1)});`);
  const result = spawnSync(require("electron"), [main], {
    encoding: "utf8", timeout: 30_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /"verified":true/u);
  process.stdout.write(result.stdout);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
