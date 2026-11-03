#!/usr/bin/env node
// Isolated local preview of the production group-chat UI. No real service APIs.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, ".."), require = createRequire(path.join(root, "app/manage-ui/package.json"));
const output = path.join(root, ".artifacts/group-message-stop-20261102/preview/ui");
const { sceneMenu } = require(path.join(root, "scripts/fixtures/group-message-stop-preview-data.cjs"));
fs.mkdirSync(output, { recursive: true });
await require("esbuild").build({ entryPoints: [path.join(root, "scripts/fixtures/group-message-stop-preview.tsx")],
  bundle: true, format: "esm", jsx: "automatic", nodePaths: [path.join(root, "app/manage-ui/node_modules")],
  loader: { ".woff2": "dataurl", ".svg": "dataurl", ".png": "dataurl", ".webp": "dataurl" },
  plugins: [{ name: "preview-memory-journal", setup(build) {
    build.onLoad({ filter: /[/\\]groupSendJournal\.ts$/ }, args => {
      const journal = path.join(root, "app/manage-ui/src/lib/groupSendJournal.ts");
      if (args.path !== journal) return null;
      const source = fs.readFileSync(journal, "utf8"), marker = "export const groupSendJournal = new GroupSendJournal();";
      if (!source.includes(marker)) throw Error("Preview journal injection needs review");
      const fixture = path.join(root, "scripts/fixtures/group-message-stop-preview-journal.ts");
      return { contents: source.replace(marker, `import { previewJournal } from ${JSON.stringify(fixture)};\nexport const groupSendJournal = previewJournal as unknown as GroupSendJournal;`),
        loader: "ts", resolveDir: path.dirname(journal) };
    });
  } }],
  define: { "process.env.NODE_ENV": '"production"' }, outfile: path.join(output, "fixture.js"), logLevel: "silent" });
fs.copyFileSync(path.join(root, "scripts/fixtures/group-message-stop-preview.html"), path.join(output, "index.html"));
fs.writeFileSync(path.join(output, "scenes.json"), JSON.stringify(sceneMenu));
fs.writeFileSync(path.join(output, "fixture.html"), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>群聊状态预览</title><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;height:100%;min-height:0}#root{display:flex;flex-direction:column}</style><div id="root" class="chat-shell"></div><script type="module" src="fixture.js"></script></html>');
const avatars = path.join(root, "app/assets/agent-avatars");
const library = JSON.parse(fs.readFileSync(path.join(avatars, "manifest.json"), "utf8")).entries;
const avatarMap = { opencode: "builtin/shoggoth_opencode.jpg", antigravity: "builtin/shoggoth_antigravity.jpg",
  deepseek: "builtin/shoggoth_deepseek.jpg", shoggoth: "builtin/Shoggoth.jpg",
  shrimp: `library/${library[15].file}`, maya: `library/${library[30].file}`, default: `library/${library[45].file}` };
console.log(JSON.stringify({ built: output, scenes: sceneMenu.length, stages: sceneMenu.reduce((n, scene) => n + scene.steps.length, 0) }));
if (process.argv.includes("--serve")) {
  const portArgument = process.argv.find(value => value.startsWith("--port="));
  const port = portArgument ? Number(portArgument.slice(7)) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error("Invalid preview port");
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://preview").pathname;
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    if (pathname.startsWith("/avatar/")) {
      const relative = avatarMap[decodeURIComponent(pathname.slice(8))];
      if (!relative) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "Content-Type": "image/jpeg" }); response.end(fs.readFileSync(path.join(avatars, relative))); return;
    }
    const files = { "/": "index.html", "/index.html": "index.html", "/fixture.html": "fixture.html", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css", "/scenes.json": "scenes.json" };
    const name = files[pathname];
    if (!name) { response.writeHead(404).end(); return; }
    const type = name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".json") ? "application/json" : "text/html";
    response.writeHead(200, { "Content-Type": type + "; charset=utf-8" }); response.end(fs.readFileSync(path.join(output, name)));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  fs.writeFileSync(path.join(output, "server.json"), JSON.stringify({ url, pid: process.pid }, null, 2));
  console.log("PREVIEW " + url);
  process.on("SIGTERM", () => server.close(() => process.exit()));
  process.on("SIGINT", () => server.close(() => process.exit()));
}
