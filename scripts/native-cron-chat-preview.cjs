"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "..");
const uiRequire = createRequire(path.join(root, "app/manage-ui/package.json"));
(async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "native-cron-chat-preview-"));
  const result = spawnSync(process.execPath, ["--test", "--test-name-pattern=scheduled cron", "scripts/native-cron-chat-unit.cjs"], {
    cwd: root, env: { ...process.env, NATIVE_CRON_PREVIEW_DATA: path.join(output, "fixture-data.json") }, encoding: "utf8",
  });
  if (result.status !== 0) throw Error(result.stdout + result.stderr);
  await uiRequire("esbuild").build({ entryPoints: [path.join(__dirname, "fixtures/native-cron-chat.tsx")],
    bundle: true, format: "esm", platform: "browser", target: "chrome120", outdir: output,
    nodePaths: [path.join(root, "app/manage-ui/node_modules")], entryNames: "preview",
    define: { "process.env.NODE_ENV": '"development"' },
    loader: { ".woff2": "file", ".woff": "file", ".svg": "file", ".png": "file" },
    plugins: [{ name: "provider-logos", setup(build) {
      build.onLoad({ filter: /ProviderLogo\.tsx$/u }, ({ path: file }) => {
        const directory = path.join(root, "app/manage-ui/src/assets/provider-logos");
        const logos = Object.fromEntries(fs.readdirSync(directory).filter((name) => name.endsWith(".svg"))
          .map((name) => [`../../assets/provider-logos/${name}`, fs.readFileSync(path.join(directory, name), "utf8")]));
        return { contents: fs.readFileSync(file, "utf8").replace(/import\.meta\.glob\([^;]*?\}\)/u, JSON.stringify(logos)),
          loader: "tsx", resolveDir: path.dirname(file) };
      });
    } }], logLevel: "warning" });
  fs.writeFileSync(path.join(output, "index.html"), '<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>原生 Cron 会话验证</title><link rel="stylesheet" href="/preview.css"><style>html,body,#root{margin:0;height:100%;width:100%}</style><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>');
  const server = http.createServer((request, response) => {
    const route = new URL(request.url, "http://localhost").pathname;
    const file = path.resolve(output, `.${route === "/" ? "/index.html" : route}`);
    if (!file.startsWith(output + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404); response.end(); return;
    }
    response.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" })[path.extname(file)] || "application/octet-stream");
    fs.createReadStream(file).pipe(response);
  });
  server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/#/chat`, output })));
})().catch((error) => { console.error(error); process.exitCode = 1; });
