#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const { build } = createRequire(path.join(uiRoot, "package.json"))("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-binding-ui-"));
try {
  await build({ entryPoints: [path.join(root, "scripts/fixtures/agent-runtime-bindings.tsx")],
    bundle: true, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl" }, outfile: path.join(temp, "fixture.js"),
    nodePaths: [path.join(uiRoot, "node_modules")], logLevel: "silent" });
  const page = path.join(temp, "index.html");
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
  if (process.argv.includes("--serve")) {
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
    const main = path.join(temp, "main.cjs");
    const screenshot = process.argv.find((value) => value.startsWith("--screenshot="))?.slice("--screenshot=".length);
    fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron");
const assert=require("node:assert/strict");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{
  const w=new BrowserWindow({show:false,width:1100,height:950,webPreferences:{backgroundThrottling:false}});
  let passed=false;
  try {
    await w.loadFile(${JSON.stringify(page)});
    let deadline;
    const result=await Promise.race([
      w.webContents.executeJavaScript("window.runBindingFixture()",true),
      new Promise((_resolve,reject)=>{deadline=setTimeout(()=>reject(Error("capacity fixture deadline")),15000);})
    ]).finally(()=>clearTimeout(deadline));
    const geometry=[];
    for(const width of [1100,390]) {
      w.setContentSize(width,950);
      for(const theme of ["light","dark"]) geometry.push(await w.webContents.executeJavaScript('window.checkBindingGeometry('+JSON.stringify(theme)+')'));
    }
    assert.equal(result.writes,7);
    ${screenshot ? `require("node:fs").writeFileSync(${JSON.stringify(path.resolve(screenshot))},(await w.webContents.capturePage()).toPNG());` : ""}
    console.log(JSON.stringify({...result,geometry,verified:true}));
    passed=true;
  } catch(error) {console.error(error);}
  finally {w.destroy();app.exit(passed?0:1);}
}).catch(error=>{console.error(error);app.exit(1)});`);
    const result = spawnSync(createRequire(path.join(root, "package.json"))("electron"), [main], {
      encoding: "utf8", timeout: 30_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
    });
    process.stdout.write(result.stdout || "");
    if (result.status !== 0) process.stderr.write(result.stderr || String(result.error || ""));
    assert.equal(result.status, 0, "runtime binding Electron DOM regression failed");
    assert.match(result.stdout, /"verified":true/);
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
