#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const uiRequire = createRequire(path.join(uiRoot, "package.json"));
const { build } = uiRequire("esbuild");
const ts = uiRequire("typescript");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-settings-locale-"));
const serve = process.argv.includes("--serve");
const standalone = process.argv.includes("--standalone");
const connections = process.argv.includes("--connections");
const accounts = process.argv.includes("--accounts");
const query = { ...(standalone ? { standalone: "1" } : {}), ...(connections ? { connections: "1" } : {}), ...(accounts ? { accounts: "1" } : {}) };
// Optional read-only comparison against the version that reproduced the bug.
const sourceRef = process.env.SETTINGS_LOCALE_SOURCE_REF;
const readSource = (file) => sourceRef
  ? execFileSync("git", ["show", `${sourceRef}:${path.relative(root, file)}`], { cwd: root, encoding: "utf8" })
  : fs.readFileSync(file, "utf8");
try {
  await build({
    entryPoints: [path.join(root, "scripts/fixtures/settings-locale.tsx")],
    bundle: true, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"', "import.meta.glob": "fixtureGlob" },
    // Vite's provider-logo glob is unrelated to settings behavior.
    banner: { js: "const fixtureGlob = () => ({});" },
    loader: { ".woff2": "dataurl", ".svg": "dataurl" }, outfile: path.join(temp, "fixture.js"),
    nodePaths: [path.join(uiRoot, "node_modules")], logLevel: "silent",
    plugins: sourceRef ? [{ name: "baseline-source", setup(builder) {
      builder.onLoad({ filter: /SettingsPage\.tsx$/ }, ({ path: file }) => ({
        contents: readSource(file), loader: "tsx", resolveDir: path.dirname(file),
      }));
    } }] : [],
  });
  const page = path.join(temp, "index.html");
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
  if (serve) {
    const server = http.createServer((req, res) => {
      const name = new URL(req.url, "http://localhost").pathname.slice(1) || "index.html";
      if (!["index.html", "fixture.js", "fixture.css"].includes(name)) { res.writeHead(404); res.end(); return; }
      res.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html");
      res.end(fs.readFileSync(path.join(temp, name)));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    console.log(`Fixture: http://127.0.0.1:${server.address().port}/`);
    await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
    await new Promise((resolve) => server.close(resolve));
  } else {
    // Execute the real host reaction without starting production services.
    const source = readSource(path.join(root, "app/ui-entry.js"));
    const ast = ts.createSourceFile("ui-entry.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const names = new Set(["connectionFieldsChanged", "applyConfigChange"]);
    const hostFunctions = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map((node) => node.getText(ast)).join("\n");
    assert.equal(hostFunctions.match(/function /g)?.length, 2);
    fs.writeFileSync(path.join(temp, "preload.cjs"), 'const {contextBridge,ipcRenderer}=require("electron");contextBridge.exposeInMainWorld("fixtureHost",{configSaved:(config)=>ipcRenderer.send("fixture:config-saved",config)});');
    const main = path.join(temp, "main.cjs");
    fs.writeFileSync(main, `const {app,BrowserWindow,ipcMain}=require("electron");
const vm=require("node:vm"),assert=require("node:assert/strict");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{
  const w=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{backgroundThrottling:false,preload:${JSON.stringify(path.join(temp, "preload.cjs"))}}});
  let passed=false,blockedReloads=0,reloads=0,menus=0;
  w.webContents.on("console-message",(_event,level,message)=>{if(level>=2)console.error(message);});
  w.webContents.on("will-prevent-unload",()=>blockedReloads++);
  let config={locale:"zh-CN",gatewayUrl:"ws://127.0.0.1:1",hermesMode:"local",hermesRemotes:[],disabledBackends:[]};
  const context=vm.createContext({configStore:{read:()=>config},appliedConfig:config,appBackendRegistry:null,nativeTheme:{},buildMenu:()=>menus++,mainWindow:{webContents:{reload:()=>{reloads++;w.webContents.reload();}}}});
  vm.runInContext(${JSON.stringify(hostFunctions)},context);
  ipcMain.on("fixture:config-saved",(_e,next)=>{config=next;context.applyConfigChange();});
  try {
    await w.loadFile(${JSON.stringify(page)},{query:${JSON.stringify(query)}});
    let deadline;
    const result=await Promise.race([
      w.webContents.executeJavaScript(${JSON.stringify(`window.${accounts ? "runModelAccountsFixture" : connections ? "runConnectionsFixture" : "runFixture"}().catch(error=>{console.error(error.stack);throw error;})`)},true),
      new Promise((_resolve,reject)=>{deadline=setTimeout(()=>reject(Error("settings fixture deadline")),15_000);}),
    ]).finally(()=>clearTimeout(deadline));
    assert.equal(reloads,0,"preference saves and connection toggles must not reload settings");
    assert.equal(blockedReloads,0,"no document reload should be attempted");
    assert.equal(menus,${standalone ? "0" : "result.writes"},"native menus must still follow saved config");
    if (!${accounts}) {
    await w.loadFile(${JSON.stringify(page)},{query:${JSON.stringify(query)}});
    const persisted=await w.webContents.executeJavaScript("({lang:document.documentElement.lang,...window.fixtureConfig()})");
    if (${connections}) {
      assert.deepEqual(persisted.disabledBackends,result.disabledBackends,"new document must load saved connection switches");
      assert.equal(persisted.gatewayUrl,"ws://127.0.0.1:9","corrected endpoint must auto-save");
    } else {
      assert.equal(persisted.lang,result.locale,"new document must load the saved locale");
      assert.equal(persisted.locale,result.locale);
    }
    }
    console.log(JSON.stringify({...result,mode:${JSON.stringify(standalone ? "browser" : "desktop")},blockedReloads,reloads,${accounts ? "verified" : "persisted"}:true}));
    context.mainWindow={webContents:{reload:()=>reloads++}};
    for (const patch of [{gatewayUrl:"ws://127.0.0.1:2"},{hermesMode:"remote"}]) {
      const before=reloads;config={...config,...patch};await context.applyConfigChange();
      assert.equal(reloads,before,"endpoint edits must apply without reloading");
    }
    config={...config,disabledBackends:["hermes"],theme:"dark",notifications:{chat:false,cron:true,task:false}};
    await context.applyConfigChange();
    assert.equal(reloads,0,"all settings must stay live");
    passed=true;
  } catch(error) {console.error(error);console.error(JSON.stringify({blockedReloads,reloads}));}
  finally {w.destroy();app.exit(passed?0:1);}
}).catch(error=>{console.error(error);app.exit(1)});`);
    const result = spawnSync(createRequire(path.join(root, "package.json"))("electron"), [main], {
      encoding: "utf8", timeout: 30_000,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
    });
    process.stdout.write(result.stdout || "");
    if (result.status !== 0) process.stderr.write(result.stderr || String(result.error || ""));
    assert.equal(result.status, 0, "settings locale Electron regression failed");
    assert.match(result.stdout, accounts ? /"verified":true/ : /"persisted":true/, "fixture must complete verification");
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
