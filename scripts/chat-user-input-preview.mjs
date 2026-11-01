#!/usr/bin/env node
// Real card + MCP helper roundtrip, isolated from user data, providers and orders.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { createMcpStdioHandler } = require("../app/shoggoth-mcp-helper");
const { normalizeInteractiveRequestV1, validateInteractiveResponseV1 } = require("../app/core/shoggoth-interaction-contract");
const { ElicitRequestFormParamsSchema } = require("@modelcontextprotocol/core");
const { context } = createRequire(path.join(root, "app/manage-ui/package.json"))("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-user-input-preview-"));
const pending = new Map();
let server;
let bundler;
const close = () => {
  for (const row of pending.values()) { row.resolve({ action: "cancel" }); row.handler.close(); }
  pending.clear(); server?.close(); server?.closeAllConnections(); void bundler?.dispose(); fs.rmSync(temp, { recursive: true, force: true });
};
try {
  bundler = await context({ entryPoints: [path.join(root, "scripts/fixtures/chat-user-input.tsx")], bundle: true, format: "esm",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(root, "app/manage-ui/node_modules")], logLevel: "silent" });
  await bundler.rebuild();
  await bundler.watch();
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shoggoth · 补充信息预览</title><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>');
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://preview");
    const json = (value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
    try {
      if (req.method === "GET" && url.pathname === "/request") {
        if (pending.size >= 16) {
          const [id, row] = pending.entries().next().value;
          row.resolve({ action: "cancel" }); row.handler.close(); pending.delete(id);
        }
        const en = url.searchParams.get("lang") === "en";
        const textOnly = url.searchParams.get("mode") === "text";
        const id = randomUUID();
        const question = { id: "food", header: en ? "Choose your food" : "选择餐品",
          question: en ? "What would you like? Choose an offer or tell me what you have in mind."
            : "你想吃点什么？可以选择下面的优惠，也可以直接告诉我想吃的餐品。",
          ...(!textOnly ? { options: [
            { label: en ? "Spicy chicken burger" : "麦辣鸡腿汉堡", description: en ? "One burger · ¥11.90" : "单个汉堡，优惠后预览价 11.90 元。" },
            { label: en ? "Pick 2 fried chicken sides" : "王牌炸鸡任选2", description: en ? "Choose any two sides · ¥19.90" : "优惠券标价 19.90 元，可从鸡翅、中薯、鸡腿等任选两份。" },
          ] } : {}),
        };
        const handler = createMcpStdioHandler({ runtimeProfileId: "input-preview", runtimeAccountId: "input-preview-account",
          sessionToken: Buffer.alloc(32, 0x61).toString("base64url"), requestService: async () => { throw Error("Preview forbids product calls"); } });
        await handler({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18",
          capabilities: { elicitation: {} }, clientInfo: { name: "input-preview", version: "1" } } });
        let ready;
        const card = new Promise(resolve => { ready = resolve; });
        const result = handler({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "request_user_input", arguments: { questions: [question] } } }, {
          requestClient: async (_method, params) => {
            const parsed = ElicitRequestFormParamsSchema.parse(params);
            const request = normalizeInteractiveRequestV1({ runId: "preview-run", eventType: "prompt", payload: {
              ...parsed, requestId: id, method: "mcpServer/elicitation/request", kind: "mcp_elicitation", mode: "form", serverName: "shoggoth",
            } });
            return new Promise(resolve => {
              pending.set(id, { request, resolve, handler }); ready({ ...request, id });
            });
          },
        });
        const entry = await card;
        pending.get(id).result = result;
        json(entry); return;
      }
      if (req.method === "POST" && url.pathname === "/respond") {
        let body = "";
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 64 * 1024) throw Error("Response too large"); }
        const data = JSON.parse(body);
        const row = pending.get(data.requestId);
        if (!row) { json({ error: "Request already answered" }, 409); return; }
        const response = validateInteractiveResponseV1(row.request, data.response);
        row.resolve(response.action === "cancel" ? { action: "cancel" } : { action: "accept", content: response.answers });
        const result = await row.result;
        row.handler.close(); pending.delete(data.requestId);
        if (result.result?.isError || !result.result?.structuredContent) throw Error("MCP answer failed");
        json(result.result.structuredContent); return;
      }
      const file = ({ "/": "index.html", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css" })[url.pathname];
      if (!file || req.method !== "GET") { res.writeHead(404); res.end(); return; }
      res.setHeader("Content-Type", file.endsWith("js") ? "text/javascript" : file.endsWith("css") ? "text/css" : "text/html; charset=utf-8");
      res.end(fs.readFileSync(path.join(temp, file)));
    } catch (error) { json({ error: error.message }, 400); }
  });
  const port = Number(process.argv.find(arg => arg.startsWith("--port="))?.slice(7) || 0);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/`, providerCalls: 0 }));
  process.on("SIGTERM", () => { close(); process.exit(); });
  process.on("SIGINT", () => { close(); process.exit(); });
} catch (error) { close(); throw error; }
