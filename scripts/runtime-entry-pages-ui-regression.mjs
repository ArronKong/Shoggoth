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
const { build, context } = createRequire(path.join(uiRoot, "package.json"))("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-runtime-entry-ui-"));
try {
  const buildOptions = { entryPoints: [path.join(root, "scripts/fixtures/runtime-entry-pages.tsx")],
    bundle: true, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" }, outfile: path.join(temp, "fixture.js"),
    nodePaths: [path.join(uiRoot, "node_modules")], logLevel: "silent" };
  await build(buildOptions);
  const page = path.join(temp, "index.html");
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
  if (process.argv.includes("--serve")) {
    const clients = new Set();
    const watch = await context({ ...buildOptions, plugins: [{ name: "preview-reload", setup(builder) {
      builder.onEnd(result => { if (!result.errors.length) for (const client of clients) client.write("data: reload\n\n"); });
    } }] });
    await watch.watch();
    fs.appendFileSync(page, '<script>new EventSource("/__preview_reload").onmessage=()=>location.reload()</script>');
    const server = http.createServer((req, res) => {
      const name = new URL(req.url, "http://localhost").pathname.slice(1) || "index.html";
      if (name === "__preview_reload") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": connected\n\n"); clients.add(res); req.on("close", () => clients.delete(res)); return;
      }
      if (!["index.html", "fixture.js", "fixture.css"].includes(name)) { res.writeHead(404); res.end(); return; }
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html");
      res.end(fs.readFileSync(path.join(temp, name)));
    });
    const port = Number(process.argv.find(value => value.startsWith("--port="))?.slice(7) || 0);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    console.log(`Fixture: http://127.0.0.1:${server.address().port}/`);
    await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
    await watch.dispose();
    for (const client of clients) client.end();
    await new Promise((resolve) => server.close(resolve));
  } else {
    const main = path.join(temp, "main.cjs");
    const screenshot = process.argv.find((value) => value.startsWith("--screenshot="))?.slice("--screenshot=".length);
    fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron");
const assert=require("node:assert/strict");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{
  require("electron").session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file:|data:)/.test(details.url) }));
  const w=new BrowserWindow({show:false,width:1100,height:950,webPreferences:{backgroundThrottling:false}});
  let passed=false;
  try {
    await w.loadFile(${JSON.stringify(page)});
    let deadline;
    const result=await Promise.race([
      w.webContents.executeJavaScript("window.runRuntimeEntryFixture()",true),
      new Promise((_resolve,reject)=>{deadline=setTimeout(()=>reject(Error("capacity fixture deadline")),30000);})
    ]).finally(()=>clearTimeout(deadline));
    const geometry=[];
    for(const width of [1100,390]) {
      w.setContentSize(width,950);
      for(const theme of ["light","dark"]) geometry.push(await w.webContents.executeJavaScript('window.checkRuntimeEntryGeometry('+JSON.stringify(theme)+')'));
    }
    assert.equal(result.writes,3);
    ${screenshot ? `require("node:fs").writeFileSync(${JSON.stringify(path.resolve(screenshot))},(await w.webContents.capturePage()).toPNG());` : ""}
    ${screenshot ? `await w.webContents.executeJavaScript("window.prepareChatCapture()"); require("node:fs").writeFileSync(${JSON.stringify(path.resolve(screenshot).replace(/\.png$/u, "-chat.png"))},(await w.webContents.capturePage()).toPNG());` : ""}
    w.setContentSize(1100,950);
    const immersive = await w.webContents.executeJavaScript("window.checkImmersiveRuntime()",true);
    ${screenshot ? `
    await w.webContents.executeJavaScript('localStorage.removeItem("shoggoth.chat.immersive.v1")');
    w.setContentSize(1380,900);
    await w.loadFile(${JSON.stringify(page)}, {query:{preview:"1"}});
    await w.webContents.executeJavaScript('new Promise(resolve => { const check=()=>document.querySelector(".model-menu__item") ? requestAnimationFrame(()=>requestAnimationFrame(resolve)) : setTimeout(check,20); check(); })');
    const bounds = await w.webContents.executeJavaScript('(()=>{const r=document.querySelector(".model-menu").getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};})()');
    require("node:fs").writeFileSync(${JSON.stringify(path.resolve(screenshot).replace(/\.png$/u, "-preview.png"))},(await w.webContents.capturePage()).toPNG());
    require("node:fs").writeFileSync(${JSON.stringify(path.resolve(screenshot).replace(/\.png$/u, "-menu.png"))},(await w.webContents.capturePage(bounds)).toPNG());
    ` : ""}
    console.log(JSON.stringify({...result,geometry,immersive,verified:true}));
    passed=true;
  } catch(error) {console.error(error); console.error(await w.webContents.executeJavaScript("JSON.stringify({errors:window.fixtureErrors,text:document.body.innerText.slice(0,2500)})")); require("node:fs").writeFileSync("/tmp/shoggoth-runtime-entry-failure.png", (await w.webContents.capturePage()).toPNG());}
  finally {w.destroy();app.exit(passed?0:1);}
}).catch(error=>{console.error(error);app.exit(1)});`);
    const result = spawnSync(createRequire(path.join(root, "package.json"))("electron"), [main], {
      encoding: "utf8", timeout: 45_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
    });
    process.stdout.write(result.stdout || "");
    if (result.status !== 0) process.stderr.write(result.stderr || String(result.error || ""));
    assert.equal(result.status, 0, "runtime entry pages Electron DOM regression failed");
    assert.match(result.stdout, /"verified":true/);
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
