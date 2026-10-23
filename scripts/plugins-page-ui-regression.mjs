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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugins-page-ui-"));
const outputDir = path.resolve(process.argv.find(value => value.startsWith("--output-dir="))?.slice(13)
  || path.join(root, ".artifacts", `plugins-page-ui-${new Date().toISOString().replace(/[:.]/gu, "-")}`));
fs.mkdirSync(outputDir, { recursive: true });
try {
  await build({ entryPoints: [path.join(root, "scripts/fixtures/plugins-page.tsx")], bundle: true,
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
  const w=new BrowserWindow({show:false,width:900,height:1050,webPreferences:{backgroundThrottling:false}});
  let passed=false;
  const outputDir=${JSON.stringify(outputDir)};
  let timeout;
  try {
    await w.loadFile(${JSON.stringify(page)});
    await Promise.race([(async()=>{
      w.show();app.focus({steal:true});w.focus();w.webContents.focus();
      await new Promise(resolve=>setTimeout(resolve,150));
      assert.equal((await w.webContents.executeJavaScript("window.preparePluginKeyboard()",true)).focused,true);
      app.focus({steal:true});w.focus();w.webContents.focus();
      w.webContents.sendInputEvent({type:"keyDown",keyCode:"Return"});
      w.webContents.sendInputEvent({type:"char",keyCode:"\\r"});
      w.webContents.sendInputEvent({type:"keyUp",keyCode:"Return"});
      await w.webContents.executeJavaScript("window.checkPluginKeyboard()",true);
      w.webContents.sendInputEvent({type:"keyDown",keyCode:"Tab"});
      w.webContents.sendInputEvent({type:"keyUp",keyCode:"Tab"});
      const keyboard=await w.webContents.executeJavaScript("window.checkPluginTab()",true);
      const result=await w.webContents.executeJavaScript("window.runPluginsPageFixture()",true);
      const oauth=await w.webContents.executeJavaScript("window.runPluginOAuthFixture()",true);
      const dependency=await w.webContents.executeJavaScript("window.runPluginDependencyFixture()",true);
      const disconnect=await w.webContents.executeJavaScript("window.runPluginDisconnectFixture()",true);
      const defaultPlugins=await w.webContents.executeJavaScript("window.runPluginDefaultFixture()",true);
      const quickSetup=await w.webContents.executeJavaScript("window.runPluginQuickSetupFixture()",true);
      quickSetup.screenshot=path.join(outputDir,'plugins-900-quick-setup.png');
      fs.writeFileSync(quickSetup.screenshot,(await w.webContents.capturePage()).toPNG());
      Object.assign(quickSetup,await w.webContents.executeJavaScript("window.finishPluginQuickSetupFixture()",true));
      const rollback=await w.webContents.executeJavaScript("window.runPluginRollbackFixture()",true);
      w.focus();w.webContents.focus();
      assert.equal((await w.webContents.executeJavaScript("window.preparePluginHostKeyboard()",true)).focused,true);
      for(const type of ["keyDown","keyUp"]) w.webContents.sendInputEvent({type,keyCode:"Right"});
      await w.webContents.executeJavaScript("window.checkPluginHostFocus()",true);
      w.webContents.sendInputEvent({type:"keyDown",keyCode:"Return"});
      w.webContents.sendInputEvent({type:"char",keyCode:"\\r"});
      w.webContents.sendInputEvent({type:"keyUp",keyCode:"Return"});
      const hostKeyboard=await w.webContents.executeJavaScript("window.checkPluginHostKeyboard()",true);
      const hostTabs=await w.webContents.executeJavaScript("window.runPluginHostTabsFixture()",true);
      const detailInstallEntry=await w.webContents.executeJavaScript("window.runPluginDetailInstallEntry()",true);
      const installWorkflow=await w.webContents.executeJavaScript("window.preparePluginInstallPreview()",true);
      assert.equal((await w.webContents.executeJavaScript("window.preparePluginInstallFocusTrap()",true)).focused,true);
      w.focus();w.webContents.focus();
      for(const type of ["keyDown","keyUp"]) w.webContents.sendInputEvent({type,keyCode:"Tab"});
      Object.assign(installWorkflow,await w.webContents.executeJavaScript("window.checkPluginInstallFocusTrap()",true));
      for (const [stage, action] of [["preview", null], ["progress", "window.startPluginDialogInstallation()"], ["result", "window.finishPluginDialogInstallation()"]]) {
        if(stage==="result") {
          w.webContents.sendInputEvent({type:"keyDown",keyCode:"Escape"});
          w.webContents.sendInputEvent({type:"keyUp",keyCode:"Escape"});
        }
        if(action) Object.assign(installWorkflow,await w.webContents.executeJavaScript(action,true));
        await w.webContents.executeJavaScript("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",true);
        fs.writeFileSync(path.join(outputDir,'plugins-900-install-'+stage+'.png'),(await w.webContents.capturePage()).toPNG());
      }
      const installRecovery=await w.webContents.executeJavaScript("window.runPluginInstallRecoveryFixture()",true);
      const geometry=[],screenshots=[];
      for(const width of [900,390]) {
        w.setContentSize(width,1050);
        for(const theme of ["light","dark"]) {
          geometry.push(await w.webContents.executeJavaScript('window.preparePluginListCapture('+JSON.stringify(theme)+')',true));
          const listScreenshot=path.join(outputDir,'plugins-'+width+'-'+theme+'-list.png');
          fs.writeFileSync(listScreenshot,(await w.webContents.capturePage()).toPNG()); screenshots.push(listScreenshot);
          geometry.push(await w.webContents.executeJavaScript('window.prepareBundledCapture('+JSON.stringify(theme)+')',true));
          const bundledScreenshot=path.join(outputDir,'plugins-'+width+'-'+theme+'-bundled.png');
          fs.writeFileSync(bundledScreenshot,(await w.webContents.capturePage()).toPNG()); screenshots.push(bundledScreenshot);
          geometry.push(await w.webContents.executeJavaScript('window.prepareBundledDetailCapture()',true));
          const detailScreenshot=path.join(outputDir,'plugins-'+width+'-'+theme+'-detail.png');
          fs.writeFileSync(detailScreenshot,(await w.webContents.capturePage()).toPNG()); screenshots.push(detailScreenshot);
          if(width===390) {
            geometry.push(await w.webContents.executeJavaScript('window.expandBundledSkills()',true));
            const fullDetail=path.join(outputDir,'plugins-'+width+'-'+theme+'-detail-all-skills.png');
            fs.writeFileSync(fullDetail,(await w.webContents.capturePage()).toPNG()); screenshots.push(fullDetail);
          }
          w.webContents.sendInputEvent({type:"keyDown",keyCode:"Escape"});
          w.webContents.sendInputEvent({type:"keyUp",keyCode:"Escape"});
          await w.webContents.executeJavaScript('window.checkBundledDetailClosed()',true);
          if(width===390) {
            geometry.push(await w.webContents.executeJavaScript('window.expandBundledGap()',true));
            const expanded=path.join(outputDir,'plugins-'+width+'-'+theme+'-bundled-expanded.png');
            fs.writeFileSync(expanded,(await w.webContents.capturePage()).toPNG()); screenshots.push(expanded);
            await w.webContents.executeJavaScript('window.closeBundledDetail()',true);
          }
          geometry.push(await w.webContents.executeJavaScript('window.preparePluginCapture('+JSON.stringify(theme)+')',true));
          const screenshot=path.join(outputDir,'plugins-'+width+'-'+theme+'.png');
          fs.writeFileSync(screenshot,(await w.webContents.capturePage()).toPNG()); screenshots.push(screenshot);
          if(width===390) {
            await w.webContents.executeJavaScript("window.preparePluginRollbackCapture()",true);
            const rollbackPanel=path.join(outputDir,'plugins-'+width+'-'+theme+'-rollback.png');
            fs.writeFileSync(rollbackPanel,(await w.webContents.capturePage()).toPNG()); screenshots.push(rollbackPanel);
            await w.webContents.executeJavaScript('(()=>{const d=document.querySelector("[role=dialog] > div");d.scrollTop=d.scrollHeight;})()');
            const detail=path.join(outputDir,'plugins-'+width+'-'+theme+'-tools.png');
            fs.writeFileSync(detail,(await w.webContents.capturePage()).toPNG()); screenshots.push(detail);
          }
          for(const host of ["Hermes","OpenClaw"]) {
            geometry.push(await w.webContents.executeJavaScript('window.preparePluginExternalCapture('+JSON.stringify(theme)+','+JSON.stringify(host)+')',true));
            const external=path.join(outputDir,'plugins-'+width+'-'+theme+'-'+host.toLowerCase()+'.png');
            fs.writeFileSync(external,(await w.webContents.capturePage()).toPNG()); screenshots.push(external);
          }
        }
      }
      const bearer=await w.webContents.executeJavaScript('window.runPluginBearerFixture()',true);
      const bearerScreenshot=path.join(outputDir,'plugins-390-github-account.png');
      fs.writeFileSync(bearerScreenshot,(await w.webContents.capturePage()).toPNG()); screenshots.push(bearerScreenshot);
      const externalActivity=await w.webContents.executeJavaScript('window.runPluginExternalActivityFixture()',true);
      geometry.push(await w.webContents.executeJavaScript('window.preparePluginExternalApprovalCapture()',true));
      const approvalScreenshot=path.join(outputDir,'plugins-390-dark-external-approval.png');
      fs.writeFileSync(approvalScreenshot,(await w.webContents.capturePage()).toPNG()); screenshots.push(approvalScreenshot);
      const bundledManagement=await w.webContents.executeJavaScript('window.runBundledManageFixture()',true);
      const deferredOAuth=await w.webContents.executeJavaScript('window.runDeferredOAuthFixture()',true);
      const report={...result,oauth,bearer,externalActivity,dependency,disconnect,defaultPlugins,quickSetup,rollback,keyboard,hostKeyboard,hostTabs,detailInstallEntry,installWorkflow,installRecovery,bundledManagement,deferredOAuth,geometry,screenshots,verified:true};
      fs.writeFileSync(path.join(outputDir,"report.json"),JSON.stringify(report,null,2)+"\\n");
      console.log(JSON.stringify(report)); passed=true;
    })(),new Promise((_resolve,reject)=>{timeout=setTimeout(()=>reject(Error("Plugins page fixture deadline")),90000);})]);
  } catch(error) {
    console.error(error);
    console.error(await w.webContents.executeJavaScript("JSON.stringify({errors:window.fixtureErrors,keys:window.fixtureKeys.slice(-8),writes:window.fixtureWrites.slice(-8),text:document.body.innerText.slice(0,6000)})"));
    fs.writeFileSync(path.join(outputDir,"failure.png"),(await w.webContents.capturePage()).toPNG());
  } finally {clearTimeout(timeout);w.destroy();app.exit(passed?0:1);}
}).catch(error=>{console.error(error);app.exit(1)});`);
  const result = spawnSync(createRequire(path.join(root, "package.json"))("electron"), [main], {
    encoding: "utf8", timeout: 120_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  process.stdout.write(result.stdout || "");
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error || ""));
  assert.equal(result.status, 0, "Plugins page Electron rendered regression failed");
  assert.match(result.stdout, /"verified":true/u);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
