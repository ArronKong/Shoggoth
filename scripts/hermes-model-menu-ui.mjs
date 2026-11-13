#!/usr/bin/env node
// Production backend catalog -> production React menus in an isolated Electron
// profile. Provider I/O is in-memory and the renderer cannot access the network.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
const { HermesBackend } = require("./app/core/hermes-backend");
const { build } = createRequire(path.join(root, "app/manage-ui/package.json"))("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-hermes-model-menu-"));
const screenshots = path.join(root, ".artifacts/hermes-model-20261113");
try {
  const backend = new HermesBackend();
  backend.profileById.set("hermes-default", "default");
  backend.dashboards.set("default", {});
  backend._dashGet = async () => ({ status: 200, body: JSON.stringify({ providers: [
    { slug: "xiaomi", name: "Xiaomi MiMo", models: ["mimo-v2.6-pro"] },
    { slug: "custom:xiaomi", name: "xiaomi1", is_user_defined: true,
      api_url: "https://token-plan-cn.xiaomimimo.com/v1", models: ["mimo-v2.6-pro", "mimo-v2.6-flash"] },
    { slug: "declared", name: "Declared fixture", models: ["reasoning-fixture"],
      capabilities: { "reasoning-fixture": { reasoning: true, supported_efforts: ["low", "high", "max"] } } },
    { slug: "unknown", name: "Unknown fixture", models: ["unknown-fixture"],
      capabilities: { "unknown-fixture": { reasoning: true } } },
  ] }) });
  await backend.refreshModelChoices();
  const models = await backend.getModels();
  const source = `import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import ChatModelMenu from '../app/manage-ui/src/pages/ChatModelMenu';
import ChatThinkFastMenu from '../app/manage-ui/src/pages/ChatThinkFastMenu';
import {applyConfiguredLocale} from '../app/manage-ui/src/i18n';
import '../app/manage-ui/src/styles.css';
import '../app/manage-ui/src/manage-skin.css';
import '../app/manage-ui/src/pages/ChatPage.css';
const models = ${JSON.stringify(models)};
const checks = [];
const check = (ok, name) => { if (!ok) throw Error(name); checks.push(name); };
const pause = () => new Promise(resolve => setTimeout(resolve, 160));
const errors = [];
window.addEventListener('error', e => errors.push(e.message));
window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
const writes = [];
function Fixture() {
  const [selected,setSelected] = useState(models.find(m => m.provider === 'custom:xiaomi'));
  const [level,setLevel] = useState('high');
  return <main style={{padding:48,height:'100vh',boxSizing:'border-box',display:'flex',flexDirection:'column'}}><h2>Hermes 模型与思考档位</h2>
    <div style={{display:'flex',gap:12,marginTop:'auto'}}>
    <ChatModelMenu models={models} activeModel={selected.id} activeProvider={selected.provider}
      onSelect={(id,provider) => {writes.push({id,provider});setSelected(models.find(m => m.id===id && m.provider===provider));}} />
    {selected.thinkingOptions.length>0 && <ChatThinkFastMenu levels={selected.thinkingOptions} value={level} defaultValue={selected.thinkingDefault}
      defaultLabel="默认" levelLabel={value=>value} fastCapable={false} fastOn={false}
      onChangeThinking={value=>{writes.push({level:value});setLevel(value);}} onChangeFast={()=>{}} />}
    </div></main>;
}
window.runHermesMenu = async () => {
  const trigger = () => document.querySelector('.chat-model-menu > button');
  while (!trigger()) await pause();
  trigger().click(); await pause();
  const options = () => [...document.querySelectorAll('.model-menu__item')];
  check(options().filter(el=>el.title==='mimo-v2.6-pro').length===2,'same model keeps distinct providers');
  check(options().filter(el=>el.getAttribute('aria-selected')==='true').length===1,'exact provider selected');
  const names = [...document.querySelectorAll('.model-menu [role="tab"]')].map(el=>el.textContent);
  check(names.includes('xiaomi1') && names.includes('Xiaomi MiMo'),'configured and builtin names displayed');
  const input = document.querySelector('.model-menu__search');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'xiaomi1');
  input.dispatchEvent(new Event('input',{bubbles:true})); await pause();
  check(options().length===2,'search finds configured endpoint name');
  options().find(el=>el.title==='mimo-v2.6-flash').click(); await pause();
  check(writes[0].provider==='custom:xiaomi' && writes[0].id==='mimo-v2.6-flash','selection preserves routing identity');
  document.querySelector('.chat-pill--think').click(); await pause();
  const slider = document.querySelector('[role="slider"]');
  check(slider.getAttribute('aria-valuemax')==='3','four supported reasoning levels');
  check(slider.getAttribute('aria-valuetext')==='high','supported high effort displayed');
  slider.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true})); await pause();
  check(writes.at(-1).level==='none','keyboard selects supported disabled effort');
  slider.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true})); await pause();
  slider.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})); await pause();
  check(writes.every(row=>!row.level || ['none','low','medium','high'].includes(row.level)),'keyboard cannot select unsupported effort');
  check(!document.querySelector('.think-fast-menu')?.textContent?.match(/xhigh|max|ultra|minimal/),'unsupported effort labels absent');
  const selectModel = async id => {
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await pause();
    trigger().click(); await pause(); options().find(el=>el.title===id).click(); await pause();
  };
  await selectModel('unknown-fixture');
  check(!document.querySelector('.chat-pill--think'),'unknown provider remains selectable without invented effort controls');
  await selectModel('reasoning-fixture');
  document.querySelector('.chat-pill--think').click(); await pause();
  const declared = document.querySelector('[role="slider"]');
  check(declared.getAttribute('aria-valuemax')==='2','another provider uses its declared three levels');
  declared.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true})); await pause();
  check(writes.at(-1).level==='max','another provider can select its supported max');
  await selectModel('mimo-v2.6-flash');
  document.querySelector('.chat-pill--think').click(); await pause();
  document.querySelector('[role="slider"]').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true})); await pause();
  check(errors.length===0,'no renderer errors');
  return {checks,writes};
};
window.openHermesModels = async () => {document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  await pause();document.querySelector('.chat-model-menu > button').click();await pause();};
void applyConfiguredLocale('zh-CN').then(()=>createRoot(document.getElementById('root')).render(<Fixture/>));`;
  await build({ stdin: { contents: source, resolveDir: path.join(root, "scripts"), sourcefile: "hermes-menu.tsx", loader: "tsx" },
    bundle: true, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    nodePaths: [path.join(root, "app/manage-ui/node_modules")], outfile: path.join(temp, "fixture.js"),
    plugins: [{ name: "local-fonts", setup(builder) { builder.onResolve({ filter: /^\/fonts\// }, args => ({
      path: pathToFileURL(path.join(root, "app/manage-ui/public", args.path)).href, external: true,
    })); } }], loader: { ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" }, logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const {app,BrowserWindow,session}=require('electron'),fs=require('node:fs'),path=require('node:path');
app.setPath('userData',${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{
session.defaultSession.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!/^(file:|data:)/.test(d.url)}));
const w=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{backgroundThrottling:false}});
try {
await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))});
const result=await w.webContents.executeJavaScript('window.runHermesMenu()',true);
fs.mkdirSync(${JSON.stringify(screenshots)},{recursive:true});
fs.writeFileSync(path.join(${JSON.stringify(screenshots)},'hermes-thinking.png'),(await w.webContents.capturePage()).toPNG());
await w.webContents.executeJavaScript('window.openHermesModels()',true);
fs.writeFileSync(path.join(${JSON.stringify(screenshots)},'hermes-models.png'),(await w.webContents.capturePage()).toPNG());
console.log(JSON.stringify({passed:true,...result}));w.destroy();app.exit(0);
}catch(e){console.error(e);console.error(await w.webContents.executeJavaScript('document.body.innerText'));w.destroy();app.exit(1);}
});`);
  const result = spawnSync(require("electron"), [main], { encoding: "utf8", timeout: 45000,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
  process.stdout.write(result.stdout || "");
  if (result.status !== 0) process.stderr.write(result.stderr || result.error?.message || "Electron failed");
  assert.equal(result.status, 0, "Hermes model menu regression failed");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
