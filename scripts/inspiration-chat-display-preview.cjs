"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { createRequire } = require("node:module");
const { InspirationStore } = require("../app/agent-service/inspiration-store");
const { InspirationService } = require("../app/agent-service/inspiration-service");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { inspirationUserText } = require("../app/core/inspiration-chat-history");

async function main() {
  const root = path.resolve(__dirname, "..");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shg-insp-display-ui-"));
  const { build } = createRequire(path.join(root, "app/manage-ui/package.json"))("esbuild");
  const store = new InspirationStore({ paths: { trustedRoot: temp, stateDir: path.join(temp, "state") } }).open();
  const service = new InspirationService({ store });
  const histories = new Map();
  const displayTexts = [];
  const targetFor = backendId => ({ backendId, agentId: backendId === "hermes" ? "hermes-fixture" : "main",
    sessionKey: `agent:${backendId === "hermes" ? "hermes-fixture" : "main"}:inspiration-display` });
  for (const backendId of ["hermes", "openclaw"]) {
    let idea = store.create({ operationId: randomUUID(), body: "rsi 是什么" });
    const messages = [];
    for (const [instruction, inputSource] of [["", null], ["请用一个简单例子解释", null], ["请再简短一点", "chat"]]) {
      const target = targetFor(backendId);
      const execution = store.prepareExternalExecution({ operationId: randomUUID(), id: idea.id,
        expectedRevision: idea.revision, agentId: target.agentId, backendId, workspace: temp, instruction,
        ...(inputSource ? { inputSource } : {}) }, () => true, target.sessionKey);
      const at = execution.createdAt;
      messages.push({ id: execution.id, role: "user", content: service.buildPrompt(execution), timestamp: at });
      if (backendId === "hermes") displayTexts.push(inspirationUserText(execution));
      messages.push({ id: `${execution.id}-reply`, role: "assistant", content: inputSource === "chat"
        ? "好的，我会用更简短的方式继续解释。" : instruction
        ? "可以。下面用一组简化数据说明 RSI 的计算过程。"
        : "RSI 是相对强弱指数，用来描述一段时间内价格上涨与下跌的相对强度。", timestamp: at + 1000 });
      store.finishExternalBeforeStart(execution.id, { status: "canceled" });
      idea = store.get(idea.id);
    }
    histories.set(backendId, { messages });
  }
  const native = histories.get("hermes").messages.map((message, index) => message.role === "user"
    ? { ...message, content: [{ type: "text", text: displayTexts[index / 2] }] }
    : message);
  histories.set("shoggoth", { messages: native });
  service.open();
  const owner = new ShoggothBackend();
  owner._call = (method, params) => service.handle(method, params);
  let server;
  const close = () => { server?.close(); service.close(); store.close(); fs.rmSync(temp, { recursive: true, force: true }); };
  try {
    await build({ entryPoints: [path.join(root, "scripts/fixtures/inspiration-chat-display.tsx")], bundle: true, format: "esm",
      define: { "process.env.NODE_ENV": '"production"' }, loader: { ".woff2": "dataurl", ".svg": "dataurl" },
      outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(root, "app/manage-ui/node_modules")], logLevel: "silent" });
    fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><title>灵感聊天展示预览</title><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/fixture-history") {
        const backendId = url.searchParams.get("backend");
        if (!histories.has(backendId)) { res.writeHead(404); res.end(); return; }
        const history = histories.get(backendId);
        const displayed = backendId === "shoggoth" ? history
          : await owner.projectExternalInspirationHistory(targetFor(backendId), history);
        res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(displayed)); return;
      }
      const file = ({ "/": "index.html", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css" })[url.pathname];
      if (!file) { res.writeHead(404); res.end(); return; }
      res.setHeader("Content-Type", file.endsWith("js") ? "text/javascript" : file.endsWith("css") ? "text/css" : "text/html");
      res.end(fs.readFileSync(path.join(temp, file)));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    console.log(`PREVIEW http://127.0.0.1:${server.address().port}/?backend=hermes`);
    for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { close(); process.exit(); });
  } catch (error) { close(); throw error; }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
