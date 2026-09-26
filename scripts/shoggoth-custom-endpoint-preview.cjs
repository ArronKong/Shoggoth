#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "..");
const fixture = process.argv.includes("--openclaw") ? "openclaw-endpoint-selection" : "shoggoth-custom-endpoint";
const uiRequire = createRequire(path.join(root, "app/manage-ui/package.json"));
(async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-custom-endpoint-preview-"));
  await uiRequire("esbuild").build({
    entryPoints: [path.join(__dirname, `fixtures/${fixture}.tsx`)],
    bundle: true, format: "esm", platform: "browser", target: "chrome120", outdir: output,
    nodePaths: [path.join(root, "app/manage-ui/node_modules")],
    entryNames: "preview", define: { "process.env.NODE_ENV": '"development"' },
    loader: { ".woff2": "file", ".woff": "file", ".svg": "file", ".png": "file", ".webp": "file" },
    plugins: [{ name: "provider-logo-raw-imports", setup(build) {
      build.onLoad({ filter: /ProviderLogo\.tsx$/ }, ({ path: file }) => {
        const directory = path.join(root, "app/manage-ui/src/assets/provider-logos");
        const logos = Object.fromEntries(fs.readdirSync(directory).filter(name => name.endsWith(".svg"))
          .map(name => [`../../assets/provider-logos/${name}`, fs.readFileSync(path.join(directory, name), "utf8")]));
        const contents = fs.readFileSync(file, "utf8").replace(/import\.meta\.glob\([^;]*?\}\)/u, JSON.stringify(logos));
        return { contents, loader: "tsx", resolveDir: path.dirname(file) };
      });
    } }], logLevel: "warning",
  });
  fs.writeFileSync(path.join(output, "index.html"), '<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shoggoth 自定义端口预览</title><link rel="stylesheet" href="/preview.css"><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>');
  let endpointFixture;
  let apiServer;
  if (fixture === "openclaw-endpoint-selection") {
    endpointFixture = require("./fixtures/openclaw-endpoint-backend.cjs").createEndpointBackendFixture(output, {
      latePrimary: process.argv.includes("--late-primary"),
    });
    apiServer = await require("../app/static-server").startStaticServer(0, {
      registry: endpointFixture.coordinator.registry,
      modelChangeCoordinator: endpointFixture.coordinator,
      homeDir: output, userDataRoot: output,
    });
  }
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp" };
  const server = http.createServer((request, response) => {
    const route = new URL(request.url, "http://localhost").pathname;
    if (endpointFixture && route === "/__fixture/state") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(endpointFixture.state())); return;
    }
    if (apiServer && route.startsWith("/__api/models")) {
      const proxy = http.request(new URL(request.url, apiServer.url), {
        method: request.method, headers: { "Content-Type": "application/json" },
      }, upstream => {
        response.writeHead(upstream.statusCode, { "Content-Type": "application/json" });
        upstream.pipe(response);
      });
      proxy.on("error", error => { response.writeHead(502); response.end(JSON.stringify({ error: error.message })); });
      request.pipe(proxy); return;
    }
    const target = path.resolve(output, `.${route === "/" ? "/index.html" : route}`);
    if (!target.startsWith(output + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      response.writeHead(404); response.end(); return;
    }
    response.writeHead(200, { "Content-Type": types[path.extname(target)] || "application/octet-stream" });
    fs.createReadStream(target).pipe(response);
  });
  server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/`, output })));
})().catch(error => { console.error(error); process.exitCode = 1; });
