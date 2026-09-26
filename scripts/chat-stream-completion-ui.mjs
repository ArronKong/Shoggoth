#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { build } = createRequire(path.join(root, "app/manage-ui/package.json"))("esbuild");
const normalizerPath = path.join(root, "app/agent-service/codex-event-normalizer.js");
let { normalizeCodexEvent } = require(normalizerPath);
if (process.env.CHAT_STREAM_SOURCE_REF) {
  const source = execFileSync(process.env.GIT || "git", ["show", `${process.env.CHAT_STREAM_SOURCE_REF}:app/agent-service/codex-event-normalizer.js`], { cwd: root, encoding: "utf8" });
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: createRequire(normalizerPath), Buffer });
  normalizeCodexEvent = module.exports.normalizeCodexEvent;
}
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const backend = new ShoggothBackend({ requestService: async () => { throw Error("fixture must stay offline"); } });
const key = "agent:shoggoth-default:stream-fixture";
const note = "我会先检查资料，再整理成产品能力、使用场景与潜在风险三部分。";
const answer = "这是一段包含 **重点说明** 的完整回答。\n\n1. 第一部分保留清晰的分段。\n2. 第二部分包含可阅读的列表。\n3. 最后一部分给出结论。\n\n```js\nconst stable = true;\n```\n\n正文在输出过程中保持相同气泡，完成后仍然可以逐段复制。";
const frames = [];
const emit = (state, text) => frames.push({ type: "event", event: "chat", payload: {
  sessionKey: key, runId: "run-fixture", state, message: { role: "assistant", content: [{ type: "text", text }] },
} });
const context = { sessionKey: "stream-fixture", run: { id: "run-fixture" }, poll: {}, hooks: {
  delta: (text) => emit("delta", text), interim: (text) => emit("interim", text), final: (text) => emit("final", text),
  tool: (tool) => frames.push({ type: "event", event: "session.tool", payload: { sessionKey: key, data: tool } }),
} };
const live = { text: "", reasoning: "", settled: false };
// Use the native normalizer and App bridge, rather than hand-authoring the
// interim event whose absence caused the bug. No model or Service is started.
for (const [id, text, phase] of [["note", note, "commentary"], ["answer", answer, "final_answer"]]) {
  for (let offset = 0; offset < text.length; offset += 24) {
    const event = normalizeCodexEvent({ method: "item/agentMessage/delta", params: {
      threadId: "thread-fixture", turnId: "turn-fixture", itemId: id, delta: text.slice(offset, offset + 24),
    } });
    await backend._consumeEvent(context, live, { type: "text.delta", payload: event });
  }
  const event = normalizeCodexEvent({ method: "item/completed", params: {
    threadId: "thread-fixture", turnId: "turn-fixture", item: { id, type: "agentMessage", text, phase },
  } });
  await backend._consumeEvent(context, live, { type: "text", payload: event });
  if (id === "note") {
    for (const type of ["tool.start", "tool.result"]) await backend._consumeEvent(context, live, {
      type, payload: { itemId: "tool-1", toolCallId: "tool-1", tool: {
        name: "web_search", status: type === "tool.start" ? "inProgress" : "completed", resultSummary: "Found sources", durationMs: 300,
      } },
    });
  }
}
await backend._settleTerminal(context, live, { id: "run-fixture", status: "completed" });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-chat-stream-"));
try {
  await build({
    entryPoints: [path.join(root, "scripts/fixtures/chat-stream-completion.tsx")], bundle: true, format: "esm",
    define: { "process.env.NODE_ENV": '"production"', __STREAM_FIXTURE__: JSON.stringify({ key, note, answer, frames }) },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl" }, outfile: path.join(temp, "fixture.js"),
    nodePaths: [path.join(root, "app/manage-ui/node_modules")], logLevel: "silent",
  });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}#root{display:flex;flex-direction:column}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  const output = process.env.CHAT_STREAM_PREVIEW_DIR ? path.resolve(process.env.CHAT_STREAM_PREVIEW_DIR) : null;
  if (output) fs.mkdirSync(output, { recursive: true });
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron");const fs=require("node:fs");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1360,height:950,webPreferences:{backgroundThrottling:false}});let passed=false;
try {const results=[];for(const width of [1360,600])for(const theme of ["light","dark"]){
  w.setContentSize(width,950);await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))});
  await w.webContents.executeJavaScript('document.documentElement.setAttribute("data-theme",'+JSON.stringify(theme)+')');
  await w.webContents.executeJavaScript('window.startFixture()');
  if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/"+width+"-"+theme+"-live.png",(await w.webContents.capturePage()).toPNG());
  const result=await w.webContents.executeJavaScript('window.finishFixture()');results.push({width,theme,...result});
  if(${Boolean(output)})fs.writeFileSync(${JSON.stringify(output)}+"/"+width+"-"+theme+"-final.png",(await w.webContents.capturePage()).toPNG());
}console.log(JSON.stringify({passed:true,results}));passed=true;}catch(error){console.error(error.stack||error);}finally{w.destroy();app.exit(passed?0:1);}});`);
  const result = spawnSync(path.join(root, "node_modules/.bin/electron"), [main], {
    encoding: "utf8", timeout: 60_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  process.stdout.write(result.stdout || "");
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error));
  assert.equal(result.status, 0, "stream completion UI fixture failed");
  assert.match(result.stdout, /"passed":true/);
  if (output) fs.writeFileSync(path.join(output, "result.json"), result.stdout);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
