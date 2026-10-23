#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, ".."), ui = path.join(root, "app/manage-ui");
const requireUi = createRequire(path.join(ui, "package.json")), { build } = requireUi("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-chat-send-recovery-"));
const outputIndex = process.argv.indexOf("--output"), output = outputIndex < 0 ? null : process.argv[outputIndex + 1];
const screenshotIndex = process.argv.indexOf("--screenshot"), screenshot = screenshotIndex < 0 ? null : process.argv[screenshotIndex + 1];
const bufferedOnly = process.argv.includes("--buffered-only");
const observationCases = [["native-active-recovery", "shoggoth"], ["native-active-recovery-immersive", "shoggoth"],
  ["legacy-observer-loop", "shoggoth"], ["legacy-observer-loop-immersive", "shoggoth"],
  ["native-active-stale", "shoggoth"], ["native-active-storage-failure", "shoggoth"],
  ["observer-idle", "shoggoth"], ["observer-idle-pending", "shoggoth"],
  ["observer-idle-terminal", "shoggoth"], ["native-approval", "shoggoth"], ["native-approval-immersive", "shoggoth"],
  ["runtime-abort", "openclaw"], ["runtime-abort-immersive", "openclaw"],
  ["runtime-snapshot", "openclaw"], ["runtime-abort-pending", "shoggoth"],
  ["silent-queue", "openclaw"], ["silent-queue-immersive", "openclaw"],
  ["native-rejected", "shoggoth"], ["native-rejected-immersive", "shoggoth"],
  ["legacy-recovery", "shoggoth"], ["legacy-recovery-immersive", "shoggoth"],
  ["legacy-unresolved", "shoggoth"], ["legacy-unavailable", "shoggoth"],
  ["legacy-accepted", "shoggoth"], ["legacy-late-accepted", "shoggoth"]];
const observationOnly = process.argv.includes("--observation-only");
const ordinaryRecoveryOnly = process.argv.includes("--ordinary-recovery-only");
const ordinaryRecoveryCases = ["live", "late-ack", "reload"].flatMap(kind => ["", "-immersive"]
  .map(suffix => [`ordinary-recovery-${kind}${suffix}`, "openclaw"]));
const upstreamOnly = process.argv.includes("--upstream-only");
const slashOnly = process.argv.includes("--slash-only");
const scenarioIndex = process.argv.indexOf("--scenario");
const selectedScenario = scenarioIndex < 0 ? null : process.argv[scenarioIndex + 1];
const slashCases = ["slash-order", "slash-order-error", "slash-order-uncertain", "slash-order-immersive", "slash-order-uncertain-immersive"]
  .filter(scenario => !selectedScenario || scenario === selectedScenario).map(scenario => [scenario, "hermes"]);
assert.ok(!slashOnly || slashCases.length, "unknown slash fixture scenario");
const upstreamCases = [["upstream-error", "shoggoth"], ["upstream-error-immersive", "shoggoth"]];
const failureIndex = process.argv.indexOf("--error-code");
const publicFailureCode = failureIndex < 0 ? "RUNTIME_UPSTREAM_UNAVAILABLE" : process.argv[failureIndex + 1];
const publicFailures = {
  RUNTIME_UPSTREAM_UNAVAILABLE: "上游模型服务不可用，请稍后重试，或选择其他可用模型",
  RUNTIME_OUTPUT_LIMIT_EXCEEDED: "CLI 的单条数据或当前保留内容超过安全容量，本次任务已停止；已生成的文件可能仍然存在，请检查原生会话结果",
  RUNTIME_ATTACHMENT_UNSUPPORTED: "当前模型不支持这种附件输入，请改用文件路径读取，或选择支持该附件的模型",
  RUNTIME_ATTACHMENT_RECOVERY_REQUIRED: "未能安全处理旧会话中的附件，原记录已保留；请稍后重试或新建会话",
};
assert.ok(Object.hasOwn(publicFailures, publicFailureCode), "unknown public error fixture");
// Use the App bridge's public message in both the terminal frame and history.
const { ShoggothBackend } = createRequire(path.join(root, "package.json"))("./app/core/shoggoth-backend");
const bridge = new ShoggothBackend({ requestService: async () => { throw Error("fixture stays offline"); } });
let upstreamError;
await bridge._settleTerminal({ sessionKey: "fixture", run: { id: "upstream-fixture" },
  hooks: { error: message => { upstreamError = message; } } }, { settled: false },
{ id: "upstream-fixture", status: "failed", errorCode: publicFailureCode });
assert.equal(upstreamError, publicFailures[publicFailureCode]);
let server;
const cleanup = async () => { if (server) await new Promise(resolve => server.close(resolve)); fs.rmSync(temp, { recursive: true, force: true }); };
try {
  await build({ entryPoints: [path.join(root, "scripts/fixtures/chat-send-recovery.tsx")], bundle: true,
    format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"', __UPSTREAM_ERROR__: JSON.stringify(upstreamError),
      __PUBLIC_FAILURE_CODE__: JSON.stringify(publicFailureCode) },
    loader: { ".woff2": "dataurl", ".woff": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(ui, "node_modules")], logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;min-height:0}#root{height:100vh}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const allowed = { "/": "index.html", "/index.html": "index.html", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css" };
    const file = allowed[pathname];
    if (!file) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" });
    res.end(fs.readFileSync(path.join(temp, file)));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  if (process.argv.includes("--serve")) {
    console.log(JSON.stringify({ outcome: "READY", url: `${url}?scenario=restored&backend=openclaw#/chat`, scope: "isolated-real-ChatPage-fixture" }));
    process.on("SIGINT", async () => { await cleanup(); process.exit(0); });
    process.on("SIGTERM", async () => { await cleanup(); process.exit(0); });
    await new Promise(() => {});
  }
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron"), fs=require("node:fs");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{const window=new BrowserWindow({show:false,width:1080,height:920,webPreferences:{backgroundThrottling:false}});
window.webContents.on("console-message",event=>{if(event.level==="error") console.error(event.message);});
const cases=${JSON.stringify(ordinaryRecoveryOnly ? ordinaryRecoveryCases : slashOnly ? slashCases : upstreamOnly ? upstreamCases : observationOnly ? observationCases : bufferedOnly ? [["ordinary-buffered", "openclaw"], ["ordinary-buffered-immersive", "openclaw"]] : [["uncertain", "openclaw"], ["uncertain", "hermes"], ["uncertain", "shoggoth"], ["started", "openclaw"], ["restored", "openclaw"], ["restored", "hermes"], ["newer", "openclaw"], ["rejected", "openclaw"], ["rejected", "hermes"], ["ordinary", "hermes"], ["ordinary", "openclaw"], ["ordinary", "shoggoth"], ["accepted-error", "openclaw"], ["accepted-uncertain", "hermes"], ["stale-query", "openclaw"], ["reselect", "shoggoth"], ["terminal-race", "openclaw"], ["terminal-timeout", "hermes"], ["terminal-reload", "openclaw"], ["ordinary-upstream", "openclaw"], ["ordinary-receipt", "openclaw"], ["ordinary-buffered", "openclaw"], ["ordinary-buffered-immersive", "openclaw"], ...observationCases, ...upstreamCases, ...slashCases, ...ordinaryRecoveryCases])};
const rows=[];try{for(const [scenario,backend] of cases) {
  const testUrl=${JSON.stringify(url)}+"?scenario="+scenario+"&backend="+backend+"#/chat";
  await window.loadURL(testUrl);let row;
  try {row=await window.webContents.executeJavaScript("window.runChatSendRecoveryFixture()",true);}
  catch(error){console.error(JSON.stringify({scenario,backend,diagnostic:await window.webContents.executeJavaScript("({text:document.body.innerText.slice(0,2000),pending:localStorage.getItem('shoggoth.chat.pending-native-sends.v1'),selection:localStorage.getItem('shoggoth.chat.plugin-selection.v1')})",true)}));throw error;}
  rows.push(row);console.log(JSON.stringify(row));
  if(scenario.startsWith("native-rejected") || scenario.startsWith("legacy-recovery")) {
    ${screenshot ? `fs.writeFileSync(${JSON.stringify(screenshot)}.replace(/\\.png$/u,"-"+scenario+".png"),(await window.webContents.capturePage()).toPNG());` : ""}
  }
  if(scenario.startsWith("legacy-recovery") || scenario.startsWith("native-active-recovery") || scenario.startsWith("ordinary-recovery-")) {
    await window.loadURL(testUrl.replace("#/chat","&reload=1#/chat"));
    const restored=await window.webContents.executeJavaScript("window.runChatSendRecoveryFixture()",true);rows.push(restored);console.log(JSON.stringify(restored));
  }
  if(scenario.startsWith("slash-order")) {
    ${screenshot ? `fs.writeFileSync(${JSON.stringify(screenshot)}.replace(/\\.png$/u,"-"+scenario+".png"),(await window.webContents.capturePage()).toPNG());` : ""}
  }
  if(scenario.startsWith("upstream-error")) {
    ${screenshot ? `fs.writeFileSync(${JSON.stringify(screenshot)}.replace(/\\.png$/u,"-"+scenario+"-live.png"),(await window.webContents.capturePage()).toPNG());` : ""}
    await window.loadURL(testUrl.replace("#/chat","&reload=1#/chat"));
    const restored=await window.webContents.executeJavaScript("window.runChatSendRecoveryFixture()",true);rows.push(restored);console.log(JSON.stringify(restored));
    ${screenshot ? `fs.writeFileSync(${JSON.stringify(screenshot)}.replace(/\\.png$/u,"-"+scenario+"-reload.png"),(await window.webContents.capturePage()).toPNG());` : ""}
  }
  if((scenario==="uncertain"||scenario==="terminal-reload"||scenario==="ordinary-upstream"||scenario==="ordinary-receipt")&&backend==="openclaw") {
    ${screenshot ? `fs.writeFileSync(${JSON.stringify(screenshot)},(await window.webContents.capturePage()).toPNG());` : ""}
    await window.loadURL(testUrl.replace("#/chat","&reload=1#/chat"));
    const restored=await window.webContents.executeJavaScript("window.runChatSendRecoveryFixture()",true);rows.push(restored);console.log(JSON.stringify(restored));
  }
}
${output ? `fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({outcome:"PASS",scope:"real-ChatPage-isolated-rendering",scenarios:rows,liveProvider:false,userData:false},null,2)+"\\n");` : ""}
}finally{window.destroy();app.quit();}}).catch(error=>{console.error(error);app.exit(1)});`);
  const child = spawn(createRequire(path.join(root, "package.json"))("electron"), [main], { env: { ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => process.stdout.write(chunk)); child.stderr.on("data", chunk => process.stderr.write(chunk));
  const timeout = setTimeout(() => child.kill("SIGTERM"), 90_000);
  const status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  clearTimeout(timeout); assert.equal(status, 0, "ChatPage original-operation recovery UI fixture failed");
} finally { await cleanup(); }
