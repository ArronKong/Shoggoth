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
const { build } = createRequire(path.join(uiRoot, "package.json"))("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sg-authoring-ui-"));
const output = path.resolve(process.argv.find(value => value.startsWith("--output-dir="))?.slice(13)
  || path.join(root, ".artifacts/plugin-authoring-ui"));
fs.mkdirSync(output, { recursive: true });
try {
  const catalogPath = path.join(temp, "catalog.json");
  const service = spawnSync(process.execPath, [path.join(root, "scripts/plugin-authoring-service-fixture.cjs")], {
    env: { ...process.env, SHOGGOTH_TEST_AUTHORING_CATALOG: catalogPath }, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(service.status, 0, service.stdout + service.stderr);
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const item = catalog.items.find(row => row.packageName === "shared-echo");
  assert(item && item.sourceKind === "legacy-directory");
  await build({ entryPoints: [path.join(root, "scripts/fixtures/plugins-page.tsx")], bundle: true,
    format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(uiRoot, "node_modules")], logLevel: "silent" });
  const page = path.join(temp, "index.html");
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const {app,BrowserWindow,session}=require("electron");
const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest((d,cb)=>cb({cancel: !/^(file:|data:)/.test(d.url)}));
  const w=new BrowserWindow({show:false,width:1100,height:950,webPreferences:{backgroundThrottling:false}});
  let passed=false;
  try {
    await w.loadFile(${JSON.stringify(page)});
    await w.webContents.executeJavaScript(${JSON.stringify(`(async()=>{
      const wait=async check=>{for(let n=0;n<150;n++){if(check())return;await new Promise(r=>setTimeout(r,40));}throw Error("authored plugin did not render");};
      await wait(()=>typeof window.remountPlugins==="function");
      window.authoredCatalog=${JSON.stringify(catalog)};
      window.remountPlugins();
      window.navigatePlugins(${JSON.stringify(item.installationId)});
      await wait(()=>document.querySelector('[data-targeted="true"]')?.textContent?.includes("shared-echo"));
      const card=document.querySelector('[data-targeted="true"]');
      await wait(()=>!card.textContent.includes("正在读取连接状态"));
      const labels=card.textContent;
      if(!labels.includes("0.1.0")||!labels.includes("echo")||!labels.includes("Hermes")||!labels.includes("OpenClaw")||!labels.includes("Codex / Claude"))throw Error("authored plugin metadata or global Skill scope missing: "+labels);
      if(window.fixtureErrors.length)throw Error(window.fixtureErrors.join("\\n"));
      const rect=card.getBoundingClientRect();
      if(rect.left<0||rect.right>innerWidth||document.documentElement.scrollWidth>innerWidth)throw Error("horizontal overflow");
      return {verified:true,package:"shared-echo",source:"actual Service Codex authoring receipt",globalSkills:true,installationTarget:true,readyMcp:false};
    })()` )},true);
    const screenshot=path.join(${JSON.stringify(output)},"authored-plugin.png");
    fs.writeFileSync(screenshot,(await w.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({verified:true,screenshot,installationId:${JSON.stringify(item.installationId)}}));
    passed=true;
  }catch(error){console.error(error);console.error(await w.webContents.executeJavaScript("JSON.stringify({errors:window.fixtureErrors,text:document.body.innerText.slice(0,6000)})"));}
  finally{w.destroy();app.exit(passed?0:1);}
}).catch(error=>{console.error(error);app.exit(1)});`);
  const result = spawnSync(require("electron"), [main], {
    encoding: "utf8", timeout: 30_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /"verified":true/u);
  process.stdout.write(result.stdout);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
