import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, "..");
const { build } = createRequire(path.join(root, "app/manage-ui/package.json"))("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-native-attachments-ui-"));
await build({ entryPoints: [path.join(root, "scripts/fixtures/native-chat-attachments.tsx")], bundle: true, format: "esm",
  define: { "process.env.NODE_ENV": '"production"' }, loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
  outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(root, "app/manage-ui/node_modules")], logLevel: "silent" });
fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><title>原生 Agent 附件验证</title><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}#checks{position:fixed;top:0;right:0;z-index:99999;background:#fff;padding:4px;font:12px sans-serif;max-width:600px}</style><div id="checks"><button id="run-checks">验证附件与路径</button><span id="status">隔离测试环境</span></div><div id="root"></div><script type="module" src="fixture.js"></script>');
if (process.argv.includes("--serve")) {
  const server = http.createServer((req, res) => {
    const file = ({ "/": "index.html", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css" })[req.url];
    if (!file) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", file.endsWith("js") ? "text/javascript" : file.endsWith("css") ? "text/css" : "text/html");
    res.end(fs.readFileSync(path.join(temp, file)));
  });
  server.listen(0, "127.0.0.1", () => console.log(`PREVIEW http://127.0.0.1:${server.address().port}`));
  process.on("SIGTERM", () => { server.close(); fs.rmSync(temp, { recursive: true, force: true }); process.exit(); });
} else {
  try {
    const main = path.join(temp, "main.cjs");
    fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1360,height:950,webPreferences:{backgroundThrottling:false}});let passed=false;
try{await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))});console.log(JSON.stringify(await w.webContents.executeJavaScript('window.runFixture()')));passed=true;}catch(e){console.error(e);}finally{w.destroy();app.exit(passed?0:1);}});`);
    const result = spawnSync(path.join(root, "node_modules/.bin/electron"), [main], { encoding: "utf8", timeout: 45000,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
    process.stdout.write(result.stdout || "");
    if (result.status !== 0) process.stderr.write(result.stderr || String(result.error));
    assert.equal(result.status, 0);
    assert.match(result.stdout, /"passed":true/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
