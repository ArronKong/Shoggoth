import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const sourceRoot = path.resolve(import.meta.dirname, "..");
const root = path.resolve(option("repo") || sourceRoot);
const require = createRequire(path.join(root, "app/manage-ui/package.json"));
const { build } = require("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-agent-roster-ui-"));
const output = option("output");
let server;
try {
  await build({ stdin: { contents: fs.readFileSync(path.join(sourceRoot, "scripts/fixtures/chat-agent-roster.tsx"), "utf8"),
    resolveDir: path.join(root, "scripts/fixtures"), loader: "tsx" }, bundle: true, format: "esm", jsx: "automatic",
    nodePaths: [path.join(root, "app/manage-ui/node_modules")], define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><title>聊天 Agent 名单隔离验收</title><link rel="stylesheet" href="fixture.css"><style>html,body{margin:0;height:100%}body{display:flex;flex-direction:column}#root{display:flex;flex:1;min-height:0}#root>.chat-shell{width:100%}#result{max-height:120px;overflow:auto;margin:0;font-size:12px}</style><div><button id="run">运行隔离名单验收</button><pre id="result"></pre></div><div id="root"></div><script type="module" src="fixture.js"></script>');
  if (process.argv.includes("--serve")) {
    server = createServer((req, res) => {
      const pathname = new URL(req.url, "http://fixture").pathname;
      const file = ({ "/": "index.html", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css" })[pathname];
      if (!file) { res.writeHead(404); res.end(); return; }
      res.setHeader("Content-Type", file.endsWith("js") ? "text/javascript" : file.endsWith("css") ? "text/css" : "text/html");
      res.end(fs.readFileSync(path.join(temp, file)));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    console.log(`http://127.0.0.1:${server.address().port}/#/chat`);
    await new Promise(resolve => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
  } else {
    if (output) fs.mkdirSync(output, { recursive: true });
    const main = path.join(temp, "main.cjs");
    fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron"),fs=require("node:fs");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1200,height:850,webPreferences:{backgroundThrottling:false}});let passed=false;
try{const results=[];for(const language of ["zh-CN","en"]){
await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))},{query:{language},hash:"/chat"});
const result=await w.webContents.executeJavaScript("window.runRosterFixture()");results.push(result);console.log(JSON.stringify(result));
if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/"+language+".png",(await w.webContents.capturePage()).toPNG());
}if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/results.json",JSON.stringify(results,null,2));passed=true;
}catch(error){console.error(error.stack||error);console.error(await w.webContents.executeJavaScript("document.body.innerText.slice(0,1500)"));}finally{w.destroy();app.exit(passed?0:1);}});`);
    const child = spawn(require("electron"), [main], { env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }, stdio: "inherit" });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 60000);
    let status;
    try { status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }); }
    finally { clearTimeout(timeout); }
    assert.equal(status, 0, "Agent roster UI regression failed");
  }
} finally {
  server?.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
