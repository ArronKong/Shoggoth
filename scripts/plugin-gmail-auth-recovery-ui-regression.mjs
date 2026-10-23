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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sg-gmail-recovery-ui-"));
const outputDir = path.resolve(process.argv.find(value => value.startsWith("--output-dir="))?.slice(13)
  || path.join(root, ".artifacts/gmail-auth-recovery-ui-fixture"));
try {
  fs.mkdirSync(outputDir, { recursive: true });
  await build({ entryPoints: [path.join(root, "scripts/fixtures/plugin-gmail-auth-recovery.tsx")],
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
  const w=new BrowserWindow({show:false,width:900,height:2000,webPreferences:{backgroundThrottling:false}});
  const outputDir=${JSON.stringify(outputDir)};
  const report={verified:false,network:"file/data only",geometry:[],screenshots:[]};
  let passed=false;
  const run=source=>w.webContents.executeJavaScript(source,true);
  const capture=async name=>{const target=path.join(outputDir,name+'.png');
    fs.writeFileSync(target,(await w.webContents.capturePage()).toPNG());report.screenshots.push(target);};
  try {
    await w.loadFile(${JSON.stringify(page)});
    report.initial=await run('window.gmailRecoveryInitial()');
    for(const state of report.initial) {
      assert(state.alert.includes('may have left credentials'),JSON.stringify(state));
      assert(state.alert.includes('Manually verify and clear'),JSON.stringify(state));
      assert.equal(state.inputDisabled,true);assert.equal(state.submitDisabled,true);
      assert.equal(state.cancelPresent,false);assert.equal(state.reconcilePresent,true);
      assert.equal(state.email,'fixture@example.invalid');assert.equal(state.storedFlow,null);
    }
    report.start=await run('window.gmailRecoveryRejectStart()');
    assert(report.start.alert.includes('may have left credentials'),JSON.stringify(report.start));
    assert.equal(report.start.inputDisabled,true);assert.equal(report.start.submitDisabled,true);
    assert.equal(report.start.reconcilePresent,true);
    assert.equal(report.start.startRequestsBeforeRetry,1);
    assert.equal(report.start.startRequestsAfterRetry,1);
    report.pendingCancel=await run('window.gmailRecoveryCancelPending()');
    assert.equal(report.pendingCancel.cancelPresent,true);
    assert.equal(report.pendingCancel.storedFlow,'fixture-pending-cancel-flow');
    assert.equal(report.pendingCancel.alert,undefined);
    assert(report.pendingCancel.statusReadsBeforeCancel>=1);
    report.afterCancel=await run('window.gmailRecoveryAfterCancel()');
    assert(report.afterCancel.alert.includes('may have left credentials'),JSON.stringify(report.afterCancel));
    assert.equal(report.afterCancel.cancelPresent,false);
    assert.equal(report.afterCancel.reconcilePresent,true);
    assert.equal(report.afterCancel.storedFlow,null);
    assert.equal(report.afterCancel.inputDisabled,true);assert.equal(report.afterCancel.submitDisabled,true);
    assert(report.afterCancel.statusReads>report.pendingCancel.statusReadsBeforeCancel);
    report.lateCancel=await run('window.gmailRecoveryLateCancel()');
    assert.equal(report.lateCancel.before.cancelPresent,true);
    assert.equal(report.lateCancel.before.storedFlow,'fixture-late-cancel-flow');
    assert(report.lateCancel.recovered.alert.includes('may have left credentials'));
    assert.equal(report.lateCancel.recovered.storedFlow,null);
    assert.equal(report.lateCancel.afterLateResponse.alert,report.lateCancel.recovered.alert);
    assert.equal(report.lateCancel.afterLateResponse.cancelPresent,false);
    assert.equal(report.lateCancel.afterLateResponse.reconcilePresent,true);
    assert.equal(report.lateCancel.afterLateResponse.submitDisabled,true);
    for(const width of [900,390,320]) {
      w.setContentSize(width,2000);
      for(const theme of ['light','dark']) {
        const result=await run('window.gmailRecoveryGeometry('+JSON.stringify(theme)+')');
        assert.equal(result.width,width,JSON.stringify(result));
        assert(result.scrollWidth<=width+1 && result.bounds.every(rect=>rect.left>=-1 && rect.right<=width+1),
          JSON.stringify(result));
        report.geometry.push(result);await capture('gmail-recovery-'+width+'-'+theme);
      }
    }
    assert.notEqual(report.geometry[0].bounds[0].background,report.geometry[1].bounds[0].background);
    report.chinese=await run('window.gmailRecoveryChinese()');
    assert(report.chinese.every(value=>value.alert.includes('人工核验并清理')
      && value.submitDisabled && value.inputDisabled));
    w.setContentSize(320,2000);
    const chineseGeometry=await run('window.gmailRecoveryGeometry("light")');
    assert(chineseGeometry.scrollWidth<=321 && chineseGeometry.bounds.every(rect=>rect.left>=-1 && rect.right<=321));
    report.geometry.push(chineseGeometry);await capture('gmail-recovery-320-zh-CN-light');
    await run('window.gmailRecoveryEnglish()');
    report.reconcileCanceled=await run('window.gmailRecoveryReconcile("canceled")');
    assert.equal(report.reconcileCanceled.reconcileRequests,1);
    assert.equal(report.reconcileCanceled.reconcilePresent,true);
    assert.equal(report.reconcileCanceled.submitDisabled,true);
    report.reconcileBlocked=await run('window.gmailRecoveryReconcile("blocked")');
    assert.equal(report.reconcileBlocked.reconcileRequests,2);
    assert.equal(report.reconcileBlocked.reconcilePresent,true);
    assert.equal(report.reconcileBlocked.submitDisabled,true);
    report.reconcileRecovered=await run('window.gmailRecoveryReconcile("recovered")');
    assert.equal(report.reconcileRecovered.reconcileRequests,3);
    assert.equal(report.reconcileRecovered.reconcilePresent,false);
    assert.equal(report.reconcileRecovered.submitDisabled,false);
    assert.equal(report.reconcileRecovered.inputDisabled,false);
    assert.deepEqual({agentId:report.reconcileRecovered.reconcileBody.agentId,
      installationId:report.reconcileRecovered.reconcileBody.installationId,
      email:report.reconcileRecovered.reconcileBody.email},
      {agentId:'start-rejected',installationId:'gmail-fixture-installation',
        email:'fixture@example.invalid'});
    w.setContentSize(390,900);
    await capture('gmail-recovery-recovered-390-light');
    report.requests=await run('window.fixtureRequests');
    assert.equal(report.requests.filter(value=>value.route==='/__api/plugins/gmail-auth-start').length,1);
    assert.equal(report.requests.filter(value=>value.route==='/__api/plugins/gmail-auth-cancel').length,2);
    assert.equal(report.requests.filter(value=>value.route==='/__api/plugins/gmail-auth-reconcile').length,3);
    assert(report.requests.every(value=>['/__api/plugins/gmail-auth-start',
      '/__api/plugins/gmail-auth-status','/__api/plugins/gmail-auth-cancel',
      '/__api/plugins/gmail-auth-recovery-status','/__api/plugins/gmail-auth-reconcile'].includes(value.route)));
    report.errors=await run('window.fixtureErrors');assert.deepEqual(report.errors,[]);
    report.verified=true;passed=true;
  } catch(error) {
    report.error=String(error);report.errors=await run('window.fixtureErrors').catch(()=>null);
    await capture('failure').catch(()=>{});console.error(error);
  } finally {
    fs.writeFileSync(path.join(outputDir,'report.json'),JSON.stringify(report,null,2)+'\\n');
    console.log(JSON.stringify({verified:report.verified,reportPath:path.join(outputDir,'report.json'),
      error:report.error,states:report.initial?.length,screenshots:report.screenshots.length}));
    w.destroy();app.exit(passed?0:1);
  }
}).catch(error=>{console.error(error);app.exit(1)});`);
  const result = spawnSync(createRequire(path.join(root, "package.json"))("electron"), [main], {
    encoding: "utf8", timeout: 60_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  process.stdout.write(result.stdout || "");
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error || ""));
  assert.equal(result.status, 0, `Gmail recovery Electron UI regression failed: ${JSON.stringify({
    status: result.status, signal: result.signal, stderr: result.stderr,
  })}`);
  assert.match(result.stdout, /"verified":true/u);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
