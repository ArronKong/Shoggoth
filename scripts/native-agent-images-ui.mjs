import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { startStaticServer } = require("../app/static-server.js");
const { UI_CONTENT_SECURITY_POLICY } = require("../app/ui-content-security.js");
const { nativeAgentImages } = require("./fixtures/native-agent-images.cjs");
const root = path.resolve(import.meta.dirname, "..");
const { build } = createRequire(path.join(root, "app/manage-ui/package.json"))("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-native-images-ui-"));
const fixture = nativeAgentImages(temp);
const screenshotArgument = process.argv.indexOf("--screenshots");
const screenshotDir = screenshotArgument >= 0 ? path.resolve(process.argv[screenshotArgument + 1]) : null;
if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="360"><rect width="800" height="360" rx="24" fill="#dae5ee"/><circle cx="160" cy="160" r="90" fill="#4e7597"/><path d="M310 300 460 70 650 300Z" fill="#d78850"/><text x="32" y="332" font-family="sans-serif" font-size="22" fill="#243b50">Native Agent image preview</text></svg>';
fs.writeFileSync(path.join(temp, "preview.svg"), svg);
fixture.history[1].content[0].text += "\n\n![宽图](./preview.svg)";
const requests = [];
const originalRead = fixture.backend.readSessionImage.bind(fixture.backend);
fixture.backend.readSessionImage = async (key, ref) => { requests.push({ key, ref }); return originalRead(key, ref); };
let mediaServer, server;
try {
  await build({ entryPoints: [path.join(root, "scripts/fixtures/native-agent-images.tsx")], bundle: true, format: "esm",
    define: { "process.env.NODE_ENV": '"production"' }, loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(root, "app/manage-ui/node_modules")], logLevel: "silent",
    plugins: process.env.IMAGE_SOURCE_REF ? [{ name: "baseline", setup(builder) {
      builder.onLoad({ filter: /\/manage-ui\/src\/(?:lib\/(?:markdown|agentMedia)\.ts|components\/ChatMarkdown\.tsx|pages\/ChatPage\.tsx)$/ }, ({ path: file }) => ({
        contents: execFileSync("git", ["show", `${process.env.IMAGE_SOURCE_REF}:${path.relative(root, file)}`],
          { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }), loader: file.endsWith("tsx") ? "tsx" : "ts", resolveDir: path.dirname(file),
      }));
    } }] : [],
  });
  const seed = JSON.stringify({ key: fixture.key, otherKey: fixture.otherKey, agentId: fixture.agentId, history: fixture.history });
  fs.writeFileSync(path.join(temp, "seed.js"), `window.imageFixture=${seed};`);
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><title>原生 Agent 图片修复验证</title><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}#checks{position:fixed;right:8px;top:8px;z-index:99999;background:white;padding:6px;font:12px sans-serif;max-width:300px}#status{display:block;max-height:130px;overflow:auto}</style><details id="checks"><summary>隔离图片验证</summary><button id="run-checks">运行检查</button><span id="status">真实图片文件与原生后端读取链路</span></details><div id="root"></div><script src="seed.js"></script><script type="module" src="fixture.js"></script>');
  mediaServer = await startStaticServer(0, { registry: { getBackend: id => id === "shoggoth" ? fixture.backend : null },
    homeDir: temp, userDataRoot: path.join(temp, "server-data") });
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://fixture").pathname;
    if (pathname.startsWith("/__api/sessions/image")) {
      const proxy = http.request(mediaServer.url + req.url, { headers: { ...req.headers, host: new URL(mediaServer.url).host } }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      proxy.on("error", error => res.destroy(error)); req.pipe(proxy); return;
    }
    const file = ({ "/": "index.html", "/seed.js": "seed.js", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css" })[pathname];
    if (!file) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", file.endsWith("js") ? "text/javascript" : file.endsWith("css") ? "text/css" : "text/html");
    if (file.endsWith("html")) res.setHeader("Content-Security-Policy", UI_CONTENT_SECURITY_POLICY);
    res.end(fs.readFileSync(path.join(temp, file)));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  if (process.argv.includes("--serve")) {
    console.log(`PREVIEW ${url}`);
    await new Promise(resolve => process.on("SIGTERM", resolve));
  } else {
    const main = path.join(temp, "electron.cjs");
    const nativePointScript = `(async () => {
      const image = document.querySelector(".chat-thread img[alt='宽图']");
      image.scrollIntoView({ block: "center" });
      await new Promise(resolve => setTimeout(resolve, 60));
      const bounds = image.getBoundingClientRect();
      const x = Math.round(bounds.x + bounds.width / 2), y = Math.round(bounds.y + bounds.height / 2);
      if (document.elementFromPoint(x, y) !== image) throw Error("image hit target is blocked");
      return { x, y };
    })()`;
    fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1200,height:950,webPreferences:{backgroundThrottling:false}});let passed=false;
w.webContents.on("console-message",(_event,level,message)=>{if(level===3)console.error(message);});
try{for(const width of [1200,600]){w.setSize(width,950);await w.loadURL(${JSON.stringify(url)});const result=await w.webContents.executeJavaScript('window.runFixture()');
const point=await w.webContents.executeJavaScript(${JSON.stringify(nativePointScript)});
w.webContents.focus();w.webContents.sendInputEvent({type:"mouseDown",button:"left",clickCount:1,...point});w.webContents.sendInputEvent({type:"mouseUp",button:"left",clickCount:1,...point});
if(!await w.webContents.executeJavaScript('new Promise(r=>setTimeout(()=>r(!!document.querySelector(".chat-lightbox__img")),80))'))throw Error("native mouse click must open image viewer");
w.webContents.sendInputEvent({type:"keyDown",keyCode:"Escape"});w.webContents.sendInputEvent({type:"keyUp",keyCode:"Escape"});
if(await w.webContents.executeJavaScript('new Promise(r=>setTimeout(()=>r(!!document.querySelector(".chat-lightbox")),80))'))throw Error("native Escape must close image viewer");
if(${JSON.stringify(screenshotDir)})require("node:fs").writeFileSync(require("node:path").join(${JSON.stringify(screenshotDir)},"normal-"+width+".png"),(await w.webContents.capturePage()).toPNG());
console.log(JSON.stringify({...result,nativeMouseZoom:true,nativeEscape:true}));}passed=true;}catch(e){console.error(e);}finally{w.destroy();app.exit(passed?0:1);}});`);
    const child = spawn(path.join(root, "node_modules/.bin/electron"), [main], {
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; process.stdout.write(data); });
    child.stderr.on("data", data => { stderr += data; });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 45000);
    const status = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
    clearTimeout(timeout);
    if (status !== 0) process.stderr.write(stderr);
    assert.equal(status, 0);
    assert.equal((stdout.match(/"passed":true/g) || []).length, 2);
    assert.ok(requests.length > 0 && requests.every(request => request.key === fixture.key), "only the displayed session requests native images");
    console.log(`native-agent-images-ui: PASS (${requests.length} real image reads)`);
  }
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await mediaServer?.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
