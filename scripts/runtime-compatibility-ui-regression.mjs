import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, "..");
const ui = path.join(root, "app/manage-ui");
const require = createRequire(path.join(ui, "package.json"));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-compatibility-ui-"));
const screenshots = process.argv.find(value => value.startsWith("--screenshots="))?.slice(14);
try {
  // Resolve the same eager raw-SVG glob as Vite, without replacing ProviderLogo.
  const logos = Object.fromEntries(fs.readdirSync(path.join(ui, "src/assets/provider-logos")).filter(name => name.endsWith(".svg"))
    .map(name => [`../../assets/provider-logos/${name}`, fs.readFileSync(path.join(ui, "src/assets/provider-logos", name), "utf8")]));
  await require("esbuild").build({ entryPoints: [path.join(root, "scripts/fixtures/runtime-compatibility.tsx")],
    bundle: true, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"', "import.meta.glob": "fixtureSvgGlob" },
    banner: { js: `const fixtureSvgGlob=(pattern)=>{if(pattern!=="../../assets/provider-logos/*.svg")throw Error("Unexpected asset glob");return ${JSON.stringify(logos)}};` },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(ui, "node_modules")], logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const {app,BrowserWindow,session}=require("electron"),fs=require("node:fs"),path=require("node:path");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:! /^(file:|data:)/.test(details.url)}));
 const w=new BrowserWindow({show:false,width:1100,height:1000,webPreferences:{backgroundThrottling:false}});
 w.webContents.on("console-message",event=>{if(event.level==="error")console.error(event.message)});
 try {await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))});const checks=[];
 const deadline=Date.now()+5000;while(!await w.webContents.executeJavaScript("typeof window.verifyRuntimeCompatibility==='function'")){
 if(Date.now()>deadline)throw Error("Fixture module did not initialize");await new Promise(resolve=>setTimeout(resolve,20));}
 for(const locale of ["zh-CN","en"])for(const width of [1100,390]){
 w.setContentSize(width,1100);await new Promise(resolve=>setTimeout(resolve,100));
 checks.push(await w.webContents.executeJavaScript("window.verifyRuntimeCompatibility("+JSON.stringify(locale)+")"));
 const screenshots=${JSON.stringify(screenshots || null)};
 if(screenshots){fs.mkdirSync(screenshots,{recursive:true});fs.writeFileSync(path.join(screenshots,locale+"-"+width+".png"),(await w.webContents.capturePage()).toPNG());}
 }console.log(JSON.stringify({checks,verified:true}));w.destroy();app.exit(0);
 }catch(error){console.error(error);console.error(await w.webContents.executeJavaScript("document.body.innerText"));w.destroy();app.exit(1);}
}).catch(error=>{console.error(error);app.exit(1)});`);
  const result = spawnSync(createRequire(path.join(root, "package.json"))("electron"), [main], {
    encoding: "utf8", timeout: 45000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  process.stdout.write(result.stdout || "");
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error || ""));
  assert.equal(result.status, 0, "Runtime compatibility UI regression");
  assert.match(result.stdout, /"verified":true/);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
