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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sg-higgsfield-registration-ui-"));
const outputDir = path.resolve(process.argv.find(value => value.startsWith("--output-dir="))?.slice(13)
  || path.join(root, ".artifacts/higgsfield-registration-ui-fixture"));
try {
  fs.mkdirSync(outputDir, { recursive: true });
  await build({ entryPoints: [path.join(root, "scripts/fixtures/plugin-higgsfield-registration.tsx")],
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
  const w=new BrowserWindow({show:false,width:900,height:900,webPreferences:{backgroundThrottling:false}});
  const outputDir=${JSON.stringify(outputDir)};
  const report={verified:false,network:"file/data only",states:[],geometry:[],screenshots:[],keyboard:{}};
  let passed=false;
  const run=(source)=>w.webContents.executeJavaScript(source,true);
  const wait=async(predicate,message)=>{for(let i=0;i<100;i++){if(await run(predicate))return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error(message)};
  const capture=async(name)=>{const target=path.join(outputDir,name+'.png');fs.writeFileSync(target,(await w.webContents.capturePage()).toPNG());report.screenshots.push(target);};
  const measure=async(state,width,theme)=>{
    w.setContentSize(width,900);
    const result=await run('window.higgsfieldGeometry('+JSON.stringify(theme)+')');
    assert.equal(result.viewport,width,JSON.stringify(result));
    assert(result.scrollWidth<=width+1 && result.cardLeft>=-1 && result.cardRight<=width+1
      && result.minLeft>=-1 && result.maxRight<=width+1,JSON.stringify(result));
    report.geometry.push(result);await capture(state+'-'+width+'-'+theme);
  };
  const key=(keyCode)=>{w.webContents.sendInputEvent({type:"keyDown",keyCode});
    if(keyCode==="Return")w.webContents.sendInputEvent({type:"char",keyCode:"\\r"});
    w.webContents.sendInputEvent({type:"keyUp",keyCode});};
  try {
    await w.loadFile(${JSON.stringify(page)});
    w.show();w.focus();w.webContents.focus();
    report.states.push(await run('window.setHiggsfieldScenario("unconfigured")'));
    assert.equal(report.states[0].buttons,1);
    assert(report.states[0].text.includes('https://mcp.higgsfield.ai/mcp'));
    assert(report.states[0].text.includes('openid email offline_access'));
    for(const width of [900,390,320]) for(const theme of ["light","dark"])
      await measure("unconfigured",width,theme);
    w.setContentSize(900,900);
    w.focus();w.webContents.focus();
    assert.equal(await run('window.higgsfieldFocusOpen()'),true);
    key("Return");
    const form=await run('window.higgsfieldFormState()');
    assert.deepEqual({expanded:form.expanded,labelAssociated:form.labelAssociated,inputType:form.inputType,min:form.min,max:form.max},
      {expanded:"true",labelAssociated:true,inputType:"number",min:"1024",max:"65535"});
    report.keyboard.open=form;
    key("Tab");await wait('window.higgsfieldActive()==="input"','Tab moves from disclosure to port input');
    report.keyboard.tabToInput=await run('window.higgsfieldActive()');
    for(const width of [390,320]) for(const theme of ["light","dark"])
      await measure("form",width,theme);
    report.invalidPort=await run('window.higgsfieldInvalidPort()');
    assert.deepEqual(report.invalidPort,{invalid:true,requests:0});
    const submit=await run('window.higgsfieldSubmit()');
    assert.equal(submit.requests,1);assert.deepEqual(submit.body,{redirectPort:45932});
    assert.equal(submit.pendingButtonsDisabled,true);
    assert.equal(submit.pendingText,true);
    report.submit=submit;
    const canceled=await run('window.higgsfieldResolveCanceled()');
    assert.equal(canceled.formOpen,true);report.canceled=canceled;
    assert.equal(await run('window.higgsfieldFocusCancel()'),true);
    key("Return");
    await wait('!document.querySelector("[data-higgsfield-registration] form")','cancel closes form');
    await new Promise(resolve=>setTimeout(resolve,100));
    report.keyboard.afterCancel=await run('window.higgsfieldActive()');
    report.states.push(await run('window.setHiggsfieldScenario("pending")'));
    assert.equal(report.states[1].buttons,1);
    assert(report.states[1].text.includes('previous registration may have reached'));
    for(const width of [900,390,320]) await measure("pending",width,"light");
    report.reconcile=await run('window.higgsfieldReconcile()');
    assert.deepEqual(report.reconcile.body,{reviewedRemoteOutcome:true});
    report.states.push(await run('window.setHiggsfieldScenario("configured")'));
    assert.equal(report.states[2].buttons,0);
    assert(report.states[2].text.includes('Restart Shoggoth'));
    for(const width of [900,390,320]) await measure("configured",width,"light");
    report.states.push(await run('window.setHiggsfieldScenario("unavailable")'));
    assert.equal(report.states[3].buttons,0);
    report.states.push(await run('window.setHiggsfieldScenario("conflict")'));
    assert.equal(report.states[4].buttons,0);
    assert(report.states[4].text.includes('cannot be overwritten'));
    report.errors=await run('window.fixtureErrors');assert.deepEqual(report.errors,[]);
    assert.equal(report.keyboard.afterCancel,"disclosure","keyboard cancel must return focus to disclosure");
    report.verified=true;passed=true;
  } catch(error) {
    report.error=String(error);
    report.errors=await run('window.fixtureErrors').catch(()=>null);
    await capture('failure').catch(()=>{});
    console.error(error);
  } finally {
    fs.writeFileSync(path.join(outputDir,"report.json"),JSON.stringify(report,null,2)+'\\n');
    console.log(JSON.stringify({verified:report.verified,reportPath:path.join(outputDir,"report.json"),
      error:report.error,keyboard:report.keyboard,states:report.states.map(value=>value.scenario),
      screenshots:report.screenshots.length,geometry:report.geometry.length}));w.destroy();app.exit(passed?0:1);
  }
}).catch(error=>{console.error(error);app.exit(1)});`);
  const result = spawnSync(createRequire(path.join(root, "package.json"))("electron"), [main], {
    encoding: "utf8", timeout: 60_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  process.stdout.write(result.stdout || "");
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error || ""));
  assert.equal(result.status, 0, `Higgsfield registration Electron UI regression failed: ${JSON.stringify({
    status: result.status, signal: result.signal, error: String(result.error || ""),
    stderr: result.stderr, stdout: result.stdout,
  })}`);
  assert.match(result.stdout, /"verified":true/u);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
