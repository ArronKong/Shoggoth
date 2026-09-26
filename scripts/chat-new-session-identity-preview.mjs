#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const { build } = createRequire(path.join(uiRoot, "package.json"))("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-new-identity-"));
let server;
const close = () => { server?.close(); server?.closeAllConnections(); fs.rmSync(temp, { recursive: true, force: true }); };
try {
  await build({ entryPoints: [path.join(root, "scripts/fixtures/chat-new-session-identity.tsx")], bundle: true, format: "esm",
    define: { "process.env.NODE_ENV": '"production"' }, loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(uiRoot, "node_modules")], logLevel: "silent",
    plugins: process.env.CHAT_IDENTITY_SOURCE_REF ? [{ name: "baseline", setup(builder) {
      builder.onLoad({ filter: /\/ChatPage\.tsx$/ }, ({ path: file }) => ({
        contents: execFileSync("git", ["show", `${process.env.CHAT_IDENTITY_SOURCE_REF}:${path.relative(root, file)}`],
          { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }), loader: "tsx", resolveDir: path.dirname(file),
      }));
    } }] : [],
  });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><title>新会话名称回归</title><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}#root{display:flex;flex-direction:column}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://fixture").pathname;
    if (pathname.startsWith("/avatar/")) {
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="48" fill="#176e73"/><path d="M20 52L38 70L76 30" fill="none" stroke="white" stroke-width="9"/></svg>');
      return;
    }
    const file = ({ "/": "index.html", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css" })[pathname];
    if (!file) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", file.endsWith("js") ? "text/javascript" : file.endsWith("css") ? "text/css" : "text/html");
    res.end(fs.readFileSync(path.join(temp, file)));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/#/chat`, source: process.env.CHAT_IDENTITY_SOURCE_REF || "working-tree" }));
  process.on("SIGTERM", () => { close(); process.exit(); });
  process.on("SIGINT", () => { close(); process.exit(); });
} catch (error) { close(); throw error; }
