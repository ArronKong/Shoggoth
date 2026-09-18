#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiRoot = path.join(root, "app/manage-ui");
const { build } = createRequire(path.join(uiRoot, "package.json"))("esbuild");
// Optional read-only baseline, without checking out files in a dirty worktree:
// CHAT_PERF_SOURCE_REF=<commit> node scripts/chat-rendering-performance-regression.mjs
// Include the first-group remount case with CHAT_PERF_ARCHIVE_AT_TOP=1.
// Include structured historical tool payloads with CHAT_PERF_WITH_TOOLS=1.
const sourceRef = process.env.CHAT_PERF_SOURCE_REF;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-chat-rendering-"));
try {
  const bundle = path.join(temp, "fixture.js");
  await build({
    entryPoints: [path.join(root, "scripts/fixtures/chat-rendering-performance.tsx")],
    bundle: true, format: "esm", define: {
      "process.env.NODE_ENV": '"production"',
      __CHAT_PERF_WITH_TOOLS__: String(process.env.CHAT_PERF_WITH_TOOLS === "1"),
    },
    loader: { ".woff2": "dataurl", ".svg": "dataurl" }, outfile: bundle,
    nodePaths: [path.join(uiRoot, "node_modules")], logLevel: "silent",
    plugins: [{ name: "markdown-work", setup(builder) {
      builder.onLoad({ filter: /\/lib\/markdown\.ts$/ }, ({ path: file }) => ({
        contents: fs.readFileSync(file, "utf8").replace(
          /export function toSanitizedMarkdownHtml\(markdown: string[^)]*\): string \{/,
          "$& (window as any).markdownCalls = ((window as any).markdownCalls || 0) + 1;",
        ),
        loader: "ts", resolveDir: path.dirname(file),
      }));
    } }, { name: "render-key-work", setup(builder) {
      builder.onLoad({ filter: /\/lib\/chatRuntime\.ts$/ }, ({ path: file }) => {
        const source = sourceRef
          ? execFileSync("git", ["show", `${sourceRef}:${path.relative(root, file)}`], { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
          : fs.readFileSync(file, "utf8");
        return {
          contents: source.replace("const parentKey = chatMessageBaseKey(message);",
            "(window as any).childKeyCalls = ((window as any).childKeyCalls || 0) + 1; const parentKey = chatMessageBaseKey(message);"),
          loader: "ts", resolveDir: path.dirname(file),
        };
      });
    } }, ...(sourceRef ? [{ name: "baseline-source", setup(builder) {
      builder.onLoad({ filter: /(?:ChatPage\.(?:tsx|css)|chatRuntime\.ts)$/ }, ({ path: file }) => ({
        contents: execFileSync("git", ["show", `${sourceRef}:${path.relative(root, file)}`], { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }),
        loader: path.extname(file).slice(1), resolveDir: path.dirname(file),
      }));
    } }] : [])],
  });
  const page = path.join(temp, "index.html");
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{
  const w=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{backgroundThrottling:false}});
  let passed=false;
  try {
    await w.loadFile(${JSON.stringify(page)});
    const result=await w.webContents.executeJavaScript('window.baseline=${Boolean(sourceRef) || process.env.CHAT_PERF_BASELINE === "1"};window.archiveAtTop=${process.env.CHAT_PERF_ARCHIVE_AT_TOP === "1"};window.runFixture()');
    console.log(JSON.stringify(result));
    passed=true;
  } catch(error) {console.error(error);}
  finally {w.destroy();app.exit(passed?0:1);}
}).catch(error=>{console.error(error);app.exit(1)});`);
  const result = spawnSync(path.join(root, "node_modules/.bin/electron"), [main], {
    encoding: "utf8", timeout: 45_000,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  process.stdout.write(result.stdout || "");
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error || ""));
  assert.equal(result.status, 0, "chat rendering Electron fixture failed");
  assert.match(result.stdout, /"bubbleReplacements":/, "fixture must report its completed assertions");
  if (process.env.CHAT_PERF_PREVIEW_DIR) {
    const preview = path.resolve(process.env.CHAT_PERF_PREVIEW_DIR);
    fs.mkdirSync(preview, { recursive: true });
    for (const file of ["index.html", "fixture.js", "fixture.css"]) fs.copyFileSync(path.join(temp, file), path.join(preview, file));
    fs.writeFileSync(path.join(preview, "result.json"), result.stdout.trim() + "\n");
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
