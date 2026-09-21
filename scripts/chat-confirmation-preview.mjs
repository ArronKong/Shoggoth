#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const { build } = createRequire(path.join(uiRoot, "package.json"))("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-confirmation-preview-"));
let server;
const close = () => { server?.close(); server?.closeAllConnections(); fs.rmSync(temp, { recursive: true, force: true }); };
try {
  await build({ entryPoints: [path.join(root, "scripts/fixtures/chat-confirmation.tsx")], bundle: true, format: "esm",
    define: { "process.env.NODE_ENV": '"production"' }, loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(uiRoot, "node_modules")], logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>确认操作预览</title><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;min-height:100%;width:100%}body{background:#f4f4f4}button,input{font-family:inherit}</style><div id="root"></div><script type="module" src="fixture.js"></script></html>');
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://preview").pathname;
    const file = ({ "/": "index.html", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css" })[pathname];
    if (!file) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", file.endsWith("js") ? "text/javascript" : file.endsWith("css") ? "text/css" : "text/html");
    res.end(fs.readFileSync(path.join(temp, file)));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/` }));
  process.on("SIGTERM", () => { close(); process.exit(); });
  process.on("SIGINT", () => { close(); process.exit(); });
} catch (error) { close(); throw error; }
