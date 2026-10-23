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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sg-slack-registration-ui-"));
const outputDir = path.resolve(process.argv.find(value => value.startsWith("--output-dir="))?.slice(13)
  || path.join(root, ".artifacts/slack-registration-ui-fixture"));

try {
  fs.mkdirSync(outputDir, { recursive: true });
  await build({
    entryPoints: [path.join(root, "scripts/fixtures/plugin-slack-registration.tsx")],
    bundle: true, format: "esm", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(uiRoot, "node_modules")],
    logLevel: "silent",
  });
  const page = path.join(temp, "index.html");
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, [
    'const {app,BrowserWindow,session}=require("electron");',
    'const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");',
    'app.setPath("userData",' + JSON.stringify(path.join(temp, "profile")) + ');',
    'app.whenReady().then(async()=>{',
    '  session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel: !/^(file:|data:)/.test(details.url)}));',
    '  const w=new BrowserWindow({show:false,width:900,height:900,webPreferences:{backgroundThrottling:false}});',
    '  let passed=false;',
    '  try {',
    '    await w.loadFile(' + JSON.stringify(page) + ');',
    '    await w.webContents.executeJavaScript("window.prepareSlackCatalog()",true);',
    '    const geometry=[];',
    '    for(const width of [900,390]) {',
    '      w.setContentSize(width,900);',
    '      for(const theme of ["light","dark"]) {',
    '        const result=await w.webContents.executeJavaScript("window.catalogGeometry("+JSON.stringify(theme)+")",true);',
    '        assert.equal(result.viewport,width,JSON.stringify(result));',
    '        assert(result.fullWidth<=width+1 && result.cardLeft>=-1 && result.cardRight<=width+1',
    '          && result.cardWidth<=result.cardClientWidth+1,JSON.stringify(result));',
    '        geometry.push(result);',
    '        fs.writeFileSync(path.join(' + JSON.stringify(outputDir) + ',"slack-catalog-"+width+"-"+theme+".png"),',
    '          (await w.webContents.capturePage()).toPNG());',
    '      }',
    '    }',
    '    assert.notEqual(geometry[0].textColor,geometry[1].textColor,"catalog text adapts to the theme");',
    '    await w.webContents.executeJavaScript("window.openSlackDetailForm()",true);',
    '    for(const width of [900,390]) {',
    '      w.setContentSize(width,900);',
    '      for(const theme of ["light","dark"]) {',
    '        const result=await w.webContents.executeJavaScript("window.detailGeometry("+JSON.stringify(theme)+")",true);',
    '        assert.equal(result.viewport,width,JSON.stringify(result));',
    '        assert(result.formVisible && result.fullWidth<=width+1',
    '          && result.dialogLeft>=-1 && result.dialogRight<=width+1',
    '          && result.panelLeft>=-1 && result.panelRight<=width+1',
    '          && result.minFieldLeft>=-1 && result.maxFieldRight<=width+1',
    '          && result.dialogWidth<=result.dialogClientWidth+1',
    '          && result.panelWidth<=result.panelClientWidth+1,JSON.stringify(result));',
    '        geometry.push(result);',
    '        fs.writeFileSync(path.join(' + JSON.stringify(outputDir) + ',"slack-detail-form-"+width+"-"+theme+".png"),',
    '          (await w.webContents.capturePage()).toPNG());',
    '      }',
    '    }',
    '    assert.notEqual(geometry[4].background,geometry[5].background,"registration themes differ");',
    '    const profiles=[];',
    '    for(const profile of ["workspace-read","workspace-write"]) {',
    '      profiles.push(await w.webContents.executeJavaScript("window.selectSlackProfile("+JSON.stringify(profile)+")",true));',
    '      for(const width of [900,390]) {',
    '        w.setContentSize(width,900);',
    '        for(const theme of ["light","dark"]) {',
    '          const result=await w.webContents.executeJavaScript("window.detailGeometry("+JSON.stringify(theme)+")",true);',
    '          assert(result.fullWidth<=width+1 && result.panelWidth<=result.panelClientWidth+1',
    '            && result.minFieldLeft>=-1 && result.maxFieldRight<=width+1,JSON.stringify(result));',
    '          geometry.push(result);',
    '          fs.writeFileSync(path.join(' + JSON.stringify(outputDir) + ',"slack-detail-"+profile+"-"+width+"-"+theme+".png"),',
    '            (await w.webContents.capturePage()).toPNG());',
    '        }',
    '      }',
    '    }',
    '    assert.deepEqual(profiles,[{profile:"workspace-read",scopeCount:21},{profile:"workspace-write",scopeCount:30}]);',
    '    await w.webContents.executeJavaScript("window.selectSlackProfile("+JSON.stringify("public-search")+")",true);',
    '    const interaction=await w.webContents.executeJavaScript("window.submitSlackRegistration()",true);',
    '    assert.equal(interaction.canceledBeforeRequest,true);assert.equal(interaction.canceledReceipt,true);',
    '    assert.equal(interaction.configureRequests,2);assert.equal(interaction.restartPrompt,true);',
    '    assert.deepEqual(interaction.firstBody,{clientId:"123456789.987654321",redirectPort:49152,scopes:["search:read.public"]});',
    '    assert.deepEqual(interaction.body,{clientId:"123456789.987654321",redirectPort:49152,scopes:require(' + JSON.stringify(path.join(root,"app/agent-service/plugin-slack-access-policy.js")) + ').FULL_SCOPES});',
    '    fs.writeFileSync(path.join(' + JSON.stringify(outputDir) + ',"slack-detail-success-390-dark.png"),',
    '      (await w.webContents.capturePage()).toPNG());',
    '    const preview=await w.webContents.executeJavaScript("window.openSlackInstallPreview()",true);',
    '    assert.deepEqual(preview,{previewRequests:1,configuredInPreview:true,unexpectedRequests:[]});',
    '    const errors=await w.webContents.executeJavaScript("window.fixtureErrors",true);',
    '    assert.deepEqual(errors,[],"renderer has no uncaught errors");',
    '    fs.writeFileSync(path.join(' + JSON.stringify(outputDir) + ',"slack-install-preview-390-dark.png"),',
    '      (await w.webContents.capturePage()).toPNG());',
    '    const report={verified:true,geometry,profiles,interaction,preview,network:"file/data only",',
    '      screenshots:18};',
    '    fs.writeFileSync(path.join(' + JSON.stringify(outputDir) + ',"report.json"),JSON.stringify(report,null,2)+"\\n");',
    '    console.log(JSON.stringify(report));passed=true;',
    '  } catch(error) {',
    '    console.error(error);',
    '    console.error(await w.webContents.executeJavaScript("JSON.stringify({errors:window.fixtureErrors,text:document.body.innerText})"));',
    '  } finally {w.destroy();app.exit(passed?0:1);}',
    '}).catch(error=>{console.error(error);app.exit(1)});',
  ].join("\n"));
  const result = spawnSync(createRequire(path.join(root, "package.json"))("electron"), [main], {
    encoding: "utf8", timeout: 60_000,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  process.stdout.write(result.stdout || "");
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error || ""));
  assert.equal(result.status, 0, "Slack registration Electron UI regression failed");
  assert.match(result.stdout, /"verified":true/u);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
