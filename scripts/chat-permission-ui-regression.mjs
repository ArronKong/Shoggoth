import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
const uiRoot = path.join(root, "app/manage-ui");
const { build } = createRequire(path.join(uiRoot, "package.json"))("esbuild");
const { runtimePermissionModeOptions } = require(path.join(root, "app/agent-service/runtime-permission-modes"));
const catalog = Object.fromEntries(["codex", "claude-code", "grok-build", "antigravity", "pi", "opencode", "deepseek-harness"]
  .map(runtime => [runtime, runtimePermissionModeOptions(runtime)]));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-permission-ui-"));
try {
  await build({ entryPoints: [path.join(root, "scripts/fixtures/chat-permission.tsx")], bundle: true,
    format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(uiRoot, "node_modules")], logLevel: "silent" });
  const page = path.join(temp, "index.html");
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="fixture.css"><div id="root"></div>
<script>window.permissionCatalog=${JSON.stringify(catalog)}</script><script type="module" src="fixture.js"></script>`);
  if (process.argv.includes("--serve")) {
    const server = http.createServer((req, res) => {
      const name = new URL(req.url, "http://localhost").pathname.slice(1) || "index.html";
      if (!["index.html", "fixture.js", "fixture.css"].includes(name)) { res.writeHead(404); res.end(); return; }
      res.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html");
      res.end(fs.readFileSync(path.join(temp, name)));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    console.log(`Fixture: http://127.0.0.1:${server.address().port}/`);
    await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
    await new Promise(resolve => server.close(resolve));
  } else {
    const main = path.join(temp, "main.cjs");
    fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:900,height:850,webPreferences:{backgroundThrottling:false}});
 try{await w.loadFile(${JSON.stringify(page)});
 const result=await w.webContents.executeJavaScript("window.runPermissionFixture()",true);
 console.log(JSON.stringify({...result,verified:true}));w.destroy();app.exit(0);
 }catch(error){console.error(error);w.destroy();app.exit(1);}
});`);
    const result = spawnSync(require("electron"), [main], { encoding: "utf8", timeout: 30_000,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
    process.stdout.write(result.stdout || "");
    if (result.status !== 0) process.stderr.write(result.stderr || String(result.error || ""));
    assert.equal(result.status, 0, "permission menu Electron DOM regression failed");
    assert.match(result.stdout, /"verified":true/);
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
