#!/usr/bin/env node
// Run with Node to open the review page. Use --build-only for a portable local copy.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { viteArtworkFixturePlugin } from "./fixtures/vite-artwork-esbuild.cjs";

const repo = path.resolve(import.meta.dirname, "..");
const ui = path.join(repo, "app/manage-ui");
const require = createRequire(path.join(ui, "package.json"));
const output = path.join(repo, ".artifacts/background-task-gallery");
const fixture = path.join(repo, "scripts/fixtures/background-task-gallery");
const args = process.argv.slice(2);
const buildOnly = args.includes("--build-only");
const port = Number(args.find(value => /^\d+$/.test(value)) || 61838);
if (args.some(value => value !== "--build-only" && !/^\d+$/.test(value)) || port < 1 || port > 65535) {
  throw Error("Usage: node scripts/background-task-gallery.mjs [port] [--build-only]");
}
fs.mkdirSync(output, { recursive: true });
for (const [file, destination] of [
  [path.join(ui, "public/logo.png"), "logo.png"], [path.join(ui, "public/immersive/idle.mp4"), "idle.mp4"],
  [path.join(repo, "app/assets/agent-avatars/builtin/shoggoth_codex.jpg"), "codex.jpg"],
]) fs.copyFileSync(file, path.join(output, destination));

fs.writeFileSync(path.join(output, "index.html"), `<!doctype html>
<html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>后台任务 · Shoggoth 界面预览</title><link rel="icon" href="./logo.png"><link rel="stylesheet" href="./gallery.css"></head>
<body><div id="root"></div><script src="./gallery.js"></script>
${buildOnly ? "" : `<script>if(window.top===window && location.protocol==="http:"){new EventSource("/esbuild").addEventListener("change",()=>location.reload());}</script>`}</body></html>\n`);

const esbuild = require("esbuild");
const options = { absWorkingDir: ui, entryPoints: [path.join(fixture, "Gallery.tsx")],
  bundle: true, format: "iife", jsx: "automatic", nodePaths: [path.join(ui, "node_modules")],
  define: { "process.env.NODE_ENV": '"production"' }, target: ["es2022"], minify: true,
  loader: { ".woff2": "dataurl", ".svg": "dataurl", ".png": "dataurl", ".webp": "dataurl" },
  external: ["/fonts/*", "/immersive/*"], plugins: [viteArtworkFixturePlugin(repo)],
  outfile: path.join(output, "gallery.js"), logLevel: "info" };
if (buildOnly) {
  await esbuild.build(options);
  console.log(path.join(output, "index.html"));
} else {
  const context = await esbuild.context(options);
  process.once("SIGINT", () => void context.dispose());
  process.once("SIGTERM", () => void context.dispose());
  try {
    await context.rebuild();
    await context.watch();
    await context.serve({ servedir: output, host: "127.0.0.1", port });
    console.log(`http://127.0.0.1:${port}/`);
  } catch (error) { await context.dispose(); throw error; }
}
