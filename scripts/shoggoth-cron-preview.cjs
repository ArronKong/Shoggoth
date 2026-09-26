#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "..");
const uiRequire = createRequire(path.join(root, "app/manage-ui/package.json"));
(async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-cron-preview-"));
  const context = await uiRequire("esbuild").context({
    entryPoints: [path.join(__dirname, "fixtures/cron-create.tsx")],
    bundle: true, format: "esm", platform: "browser", target: "chrome120", outdir: output,
    nodePaths: [path.join(root, "app/manage-ui/node_modules")],
    entryNames: "preview", define: { "process.env.NODE_ENV": '"development"' },
    loader: { ".woff2": "file", ".woff": "file", ".svg": "file", ".png": "file" },
    plugins: [{ name: "provider-logo-raw-imports", setup(build) {
      build.onLoad({ filter: /ProviderLogo\.tsx$/u }, ({ path: file }) => {
        const directory = path.join(root, "app/manage-ui/src/assets/provider-logos");
        const logos = Object.fromEntries(fs.readdirSync(directory).filter(name => name.endsWith(".svg"))
          .map(name => [`../../assets/provider-logos/${name}`, fs.readFileSync(path.join(directory, name), "utf8")]));
        const contents = fs.readFileSync(file, "utf8").replace(/import\.meta\.glob\([^;]*?\}\)/u, JSON.stringify(logos));
        return { contents, loader: "tsx", resolveDir: path.dirname(file) };
      });
    } }],
    logLevel: "warning",
  });
  await context.rebuild();
  await context.watch();
  fs.writeFileSync(path.join(output, "index.html"), '<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cron 创建流程预览</title><link rel="stylesheet" href="/preview.css"><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>');
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };
  const server = http.createServer((request, response) => {
    const route = new URL(request.url, "http://localhost").pathname;
    if (route.startsWith("/avatar/")) {
      const initial = decodeURIComponent(route.split("/").at(-1)).split("-").at(-1).slice(0, 1).toUpperCase().replace(/[<>&"']/g, "");
      response.writeHead(200, { "Content-Type": "image/svg+xml" });
      response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" rx="24" fill="#e4edff"/><text x="24" y="31" text-anchor="middle" fill="#376ccc" font-family="sans-serif" font-size="20">${initial}</text></svg>`);
      return;
    }
    const target = path.resolve(output, `.${route === "/" ? "/index.html" : route}`);
    if (!target.startsWith(output + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      response.writeHead(404); response.end(); return;
    }
    response.writeHead(200, { "Content-Type": types[path.extname(target)] || "application/octet-stream" });
    fs.createReadStream(target).pipe(response);
  });
  server.listen(Number(process.env.CRON_PREVIEW_PORT) || 0, "127.0.0.1", () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/#/cron`, output })));
})().catch(error => { console.error(error); process.exitCode = 1; });
