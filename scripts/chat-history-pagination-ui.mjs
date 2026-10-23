#!/usr/bin/env node
// Production ChatPage -> broker -> proxy -> real backend paging adapters.
// Physical Gateway/Hermes/Service reads use disposable in-memory transcripts.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { WebSocket, WebSocketServer } from "ws";
const root = path.resolve(import.meta.dirname, ".."), require = createRequire(import.meta.url);
const { build } = createRequire(path.join(root, "app/manage-ui/package.json"))("esbuild");
const { startProxyGateway } = require("../app/core/proxy-gateway");
const { attachChatBroker } = require("../app/core/chat-broker");
const { generateIdentity } = require("../app/core/device-auth");
const { createHistoryBackends, transcript } = require("./fixtures/chat-history-backends.cjs");
const fixture = createHistoryBackends(), temp = fs.mkdtempSync(path.join(os.tmpdir(), "history-ui-"));
const hello = { type: "hello-ok", protocol: 4, server: { version: "2026.9.9" },
  features: { methods: [], events: [], capabilities: [] }, auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
  policy: { maxPayload: 16 * 1024 * 1024, maxBufferedBytes: 32 * 1024 * 1024 } };
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const close = server => new Promise(resolve => server.close(resolve));
const json = (response, value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
const upstreamHttp = createServer(), upstream = new WebSocketServer({ server: upstreamHttp }), forwarded = [];
upstream.on("connection", socket => {
  socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "fixture" } }));
  socket.on("message", data => {
    const frame = JSON.parse(data), method = frame.method; forwarded.push(frame);
    const payload = method === "connect" ? hello
      : method === "agents.list" ? { agents: [{ id: fixture.cases[0].agentId, name: "OpenClaw" }] }
      : method === "sessions.list" ? { sessions: [{ key: fixture.cases[0].key, label: "OpenClaw", updatedAt: 1800000000000 }], hasMore: false }
      : method === "models.list" ? { models: [] } : {};
    socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload }));
  });
});
await listen(upstreamHttp);
const proxy = await startProxyGateway({ port: 0, getUpstreamUrl: () => `ws://127.0.0.1:${upstreamHttp.address().port}`, registry: fixture.registry });
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/fixture/control") {
    const key = url.searchParams.get("key"), action = url.searchParams.get("action");
    if (!fixture.histories.has(key)) return json(response, { error: "unknown fixture" }, 400);
    if (action === "fail") fixture.controls.fail.add(key);
    if (action === "retry") fixture.controls.fail.delete(key);
    if (action === "append") fixture.append(key);
    if (action === "slow") fixture.controls.delay = 160;
    if (action === "fast") fixture.controls.delay = 20;
    return json(response, { ok: true });
  }
  if (url.pathname === "/fixture/stats") return json(response, {
    requests: fixture.controls.requests, watches: fixture.controls.watches, created: fixture.controls.created,
  });
  if (url.pathname.startsWith("/__api/")) {
    const p = url.pathname;
    const value = p.includes("cache-scope") ? { backendId: url.searchParams.get("backend"), cacheScope: "isolated-history" }
      : p.includes("runtime-models") ? { selection: { bindingId: "fixture-binding", runtime: "codex", model: null, canSwitch: false, candidates: [] },
        capabilities: { nativeUiArtifactsV1: true, attachments: {}, slash: false, steer: false }, models: [], runtimes: [] }
      : p === "/__api/status" ? { backends: ["openclaw", "hermes", "shoggoth"].map(id => ({ id, connected: true,
        info: { readyAgentIds: fixture.cases.filter(row => row.backendId === id).map(row => row.agentId) } })) }
      : p === "/__api/backends" ? { backends: [] }
      : p.includes("/archive") ? { archive: { supported: true,
        segments: fixture.controls.created.some(row => row.key === url.searchParams.get("key")) ? []
          : [{ sealedAt: 1700000000000, fromReset: true, messages: transcript("archive", 123) }] } }
      : p.includes("/groups") ? { groups: [] } : {};
    return json(response, value);
  }
  const filename = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (!["index.html", "fixture.js", "fixture.css"].includes(filename)) { response.writeHead(404); response.end(); return; }
  response.setHeader("content-type", filename.endsWith(".js") ? "text/javascript" : filename.endsWith(".css") ? "text/css" : "text/html");
  response.end(fs.readFileSync(path.join(temp, filename)));
});
const identity = generateIdentity();
const broker = attachChatBroker(server, { getUpstreamUrl: () => proxy.url,
  authResolver: { resolveConnectAuth: () => ({ ...identity, token: "isolated-token", scopes: ["operator.read", "operator.write"] }),
    storeDeviceToken() {}, clearDeviceToken() {} } });

async function proxyChecks() {
  const client = new WebSocket(proxy.url), pending = new Map();
  client.on("message", raw => { const frame = JSON.parse(raw); if (frame.type === "res") pending.get(frame.id)?.(frame); });
  await new Promise(resolve => client.once("open", resolve));
  let sequence = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = `probe-${++sequence}`, timer = setTimeout(() => reject(Error(`timeout ${method}`)), 4000);
    pending.set(id, frame => { clearTimeout(timer); pending.delete(id); resolve(frame); });
    client.send(JSON.stringify({ type: "req", id, method, params }));
  });
  try {
    const before = fixture.controls.requests.length;
    const denied = await rpc("chat.history", { page: true, sessionKey: fixture.cases[0].key });
    assert.equal(denied.error.code, "UNAUTHORIZED"); assert.equal(fixture.controls.requests.length, before);
    assert.equal((await rpc("connect", {})).ok, true);
    for (const item of fixture.cases) {
      const first = await rpc("chat.history", { page: true, sessionKey: item.key, limit: 100 });
      assert.equal(first.ok, true, JSON.stringify(first.error)); assert.equal(first.payload.hasMore, true);
      await new Promise(resolve => setTimeout(resolve, 10));
      const watches = fixture.controls.watches.filter(key => key === item.key).length;
      const older = await rpc("chat.history", { page: true, sessionKey: item.key, limit: 100, cursor: first.payload.nextCursor });
      assert.equal(older.ok, true, JSON.stringify(older.error));
      assert.equal(fixture.controls.watches.filter(key => key === item.key).length, watches, "older pages must not replace live watchers");
      const crossed = await rpc("chat.history", { page: true, sessionKey: fixture.cases.find(row => row.key !== item.key).key,
        cursor: first.payload.nextCursor });
      assert.equal(crossed.ok, false);
    }
    assert.equal((await rpc("chat.history", { page: true, sessionKey: fixture.cases[0].key, sessionId: "foreign" })).error.code, "INVALID_PARAMS");
    assert.equal(forwarded.some(frame => frame.method === "chat.history" || frame.method === "sessions.get"), false,
      "product cursors never reach the raw upstream passthrough");
    console.log("PASS authenticated product history proxy: four readers, cursor isolation, watcher continuity");
  } finally { client.terminate(); }
}
try {
  await proxyChecks();
  await build({ entryPoints: [path.join(root, "scripts/fixtures/chat-history-pagination.tsx")],
    bundle: true, format: "esm", define: { "process.env.NODE_ENV": '"production"', __HISTORY_CASES__: JSON.stringify(fixture.cases) },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(root, "app/manage-ui/node_modules")], logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}#root{display:flex;flex-direction:column}.history-fixture-toolbar{display:flex;gap:12px;padding:8px 20px;align-items:center;background:#eee;flex-shrink:0;font:13px system-ui}.history-fixture-toolbar button{padding:5px 10px}</style><div id="root"></div><script type="module" src="/fixture.js"></script>');
  await listen(server);
  const url = `http://127.0.0.1:${server.address().port}/#/chat`;
  console.log(`ISOLATED_HISTORY_URL=${url}`);
  if (process.argv.includes("--serve")) {
    await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  } else {
    const output = process.env.CHAT_HISTORY_PREVIEW_DIR ? path.resolve(process.env.CHAT_HISTORY_PREVIEW_DIR) : null;
    if (output) fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(temp, "electron.cjs"), `const {app,BrowserWindow}=require("electron");const fs=require("node:fs");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1360,height:950,webPreferences:{backgroundThrottling:false}});let ok=false;
try{await w.loadURL(${JSON.stringify(url)});const fresh=await w.webContents.executeJavaScript("window.runNewSessionHistoryFixture()");
const result=await w.webContents.executeJavaScript("window.runHistoryFixture()");
if(${!!output})fs.writeFileSync(${JSON.stringify(output ? path.join(output, "history-final.png") : "")},(await w.webContents.capturePage()).toPNG());
console.log(JSON.stringify({fresh,...result}));ok=true;}catch(error){console.error(error.stack||error);}finally{w.destroy();app.exit(ok?0:1);}});`);
    const child = spawn(path.join(root, "node_modules/.bin/electron"), [path.join(temp, "electron.cjs")],
      { env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill(), 120000);
    child.stdout.on("data", data => process.stdout.write(data)); child.stderr.on("data", data => process.stderr.write(data));
    const status = await new Promise(resolve => child.once("exit", resolve)); clearTimeout(timer);
    assert.equal(status, 0, "production history UI acceptance failed");
  }
} finally {
  for (const client of broker.clients) client.terminate();
  await close(broker); await close(server); await proxy.close();
  for (const client of upstream.clients) client.terminate();
  await close(upstream); await close(upstreamHttp);
  fs.rmSync(temp, { recursive: true, force: true });
}
