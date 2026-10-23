import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, ".."), ui = path.join(root, "app/manage-ui");
const require = createRequire(path.join(ui, "package.json"));
const output = fs.mkdtempSync(path.join(os.tmpdir(), "codex-automation-preview-"));
await require("esbuild").build({ entryPoints: [path.join(root, "scripts/fixtures/codex-automation.tsx")],
  bundle: true, format: "esm", platform: "browser", target: "chrome120", outdir: output, entryNames: "preview",
  nodePaths: [path.join(ui, "node_modules")], define: { "process.env.NODE_ENV": JSON.stringify("development") },
  loader: { ".woff2": "file", ".woff": "file", ".svg": "file", ".png": "file" },
  plugins: [{ name: "provider-logo-raw-imports", setup(build) {
    build.onLoad({ filter: /ProviderLogo\.tsx$/ }, ({ path: file }) => {
      const directory = path.join(ui, "src/assets/provider-logos");
      const logos = Object.fromEntries(fs.readdirSync(directory).filter(name => name.endsWith(".svg"))
        .map(name => [`../../assets/provider-logos/${name}`, fs.readFileSync(path.join(directory, name), "utf8")]));
      return { contents: fs.readFileSync(file, "utf8").replace(/import\.meta\.glob\([^;]*?\}\)/u, JSON.stringify(logos)),
        loader: "tsx", resolveDir: path.dirname(file) };
    });
  } }], logLevel: "warning" });
const html = '<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex 自动任务隔离验证</title><link rel="stylesheet" href="/preview.css"><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>';
const types = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png" };
const server = http.createServer((request, response) => {
  const route = new URL(request.url, "http://localhost").pathname;
  if (["/", "/codex-automation-preview.html"].includes(route)) { response.writeHead(200, { "Content-Type": "text/html" }); response.end(html); return; }
  const file = path.resolve(output, `.${route}`);
  if (!file.startsWith(output + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" }); fs.createReadStream(file).pipe(response);
});
server.listen(5179, "127.0.0.1", () => console.log("Isolated preview: http://127.0.0.1:5179/codex-automation-preview.html"));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => { fs.rmSync(output, { recursive: true, force: true }); process.exit(0); }));
