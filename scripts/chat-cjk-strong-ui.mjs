#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const ui = path.join(root, "app/manage-ui");
const { build } = createRequire(path.join(ui, "package.json"))("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-cjk-strong-"));
const outputDir = process.env.CHAT_CJK_OUTPUT_DIR && path.resolve(process.env.CHAT_CJK_OUTPUT_DIR);
// Reproduce against a read-only source baseline without changing the worktree:
// CHAT_CJK_SOURCE_REF=<pre-fix-commit> node scripts/chat-cjk-strong-ui.mjs
try {
  await build({
    entryPoints: [path.join(root, "scripts/fixtures/chat-cjk-strong.tsx")], bundle: true, format: "esm",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    nodePaths: [path.join(ui, "node_modules")], outfile: path.join(temp, "fixture.js"), logLevel: "silent",
    plugins: process.env.CHAT_CJK_SOURCE_REF ? [{ name: "baseline-markdown", setup(builder) {
      builder.onLoad({ filter: /\/lib\/markdown\.ts$/ }, ({ path: file }) => ({
        contents: execFileSync("git", ["show", `${process.env.CHAT_CJK_SOURCE_REF}:${path.relative(root, file)}`],
          { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }), loader: "ts", resolveDir: path.dirname(file),
      }));
    } }] : [],
  });
  fs.writeFileSync(path.join(temp, "index.html"), `<!doctype html><meta charset="utf-8"><title>中文 Markdown 加粗兼容验证</title>
<link rel="stylesheet" href="fixture.css"><style>
html,body{margin:0;min-height:100%;background:#f4f4f4}.fixture-main{display:block!important;height:auto!important;min-height:100vh;padding:32px;box-sizing:border-box}
.fixture-main section{margin-bottom:24px}.fixture-main h1{font-size:24px;margin:0 0 8px}.fixture-caption{color:#788395;margin:0 0 24px}
.fixture-main .chat-group{margin:0}.fixture-main .chat-group__stack{max-width:100%}
#screenshot-content{min-height:0}
</style><div id="root"></div><script type="module" src="fixture.js"></script>`);
  if (outputDir) fs.mkdirSync(outputDir, { recursive: true });
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const {app,BrowserWindow,session}=require("electron"),fs=require("node:fs");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest({urls:["http://*/*","https://*/*"]},(_details,callback)=>callback({cancel:true}));
  const w=new BrowserWindow({show:false,width:1100,height:1800,webPreferences:{backgroundThrottling:false}});
  try{
    await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))});
    const results=[];
    for(const width of [1100,420]){
      w.setContentSize(width,1800);
      results.push(await w.webContents.executeJavaScript("window.runFixture("+width+")"));
    }
    console.log(JSON.stringify({passed:true,results}));
    ${outputDir ? `w.setContentSize(1100,1800);
    const rect=await w.webContents.executeJavaScript("window.showScreenshotSample(1100)");
    fs.writeFileSync(${JSON.stringify(path.join(outputDir, "chinese-markdown-bold.png"))},(await w.webContents.capturePage(rect)).toPNG());
    fs.writeFileSync(${JSON.stringify(path.join(outputDir, "result.json"))},JSON.stringify({passed:true,results},null,2)+"\\n");` : ""}
    w.destroy();app.exit(0);
  }catch(error){console.error(error);w.destroy();app.exit(1);}
}).catch(error=>{console.error(error);app.exit(1)});`);
  const result = spawnSync(path.join(root, "node_modules/.bin/electron"), [main], {
    encoding: "utf8", timeout: 45_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  process.stdout.write(result.stdout || "");
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error || ""));
  assert.equal(result.status, 0, "CJK strong Markdown UI fixture failed");
  assert.match(result.stdout, /"passed":true/);
  if (outputDir) console.log(`SCREENSHOT ${path.join(outputDir, "chinese-markdown-bold.png")}`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
