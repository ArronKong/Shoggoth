#!/usr/bin/env node
"use strict";

// Serve the current built App UI against the installed App's real brokers.
// Read only this test's canonical session metadata/history and session images
// through the source Backend connected to the same Service. No model response,
// chat history or image bytes are mocked.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { WebSocket, WebSocketServer } = require("ws");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { resolveCanonicalServicePaths } = require("../app/agent-service/paths");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { startStaticServer } = require("../app/static-server");
const { UI_CONTENT_SECURITY_POLICY } = require("../app/ui-content-security");

async function start({ output, upstream = "http://127.0.0.1:18799" }) {
  const url = new URL(upstream);
  if (url.hostname !== "127.0.0.1" || url.protocol !== "http:" || !path.isAbsolute(output)) throw Error("Local acceptance targets required");
  const backend = new ShoggothBackend({ paths: resolveCanonicalServicePaths(), readToken: readClientToken, requestService });
  const profiles = await backend._page("profile.list", { backendId: "shoggoth", enabledOnly: true }, "profiles");
  const readEvidence = () => JSON.parse(fs.readFileSync(path.join(output, "results.json"), "utf8"));
  const hydrate = () => {
    const evidence = readEvidence();
    for (const item of evidence.results) {
      const profile = profiles.find(p => p.id === item.profileId && p.agentId === item.agentId);
      const workspace = path.join(output, "workspaces", item.agentId);
      if (!profile || item.workspace !== workspace || item.session?.workspace !== workspace
        || item.session.profileId !== profile.id || item.session.sessionKey !== item.sessionId) continue;
      backend._profilesByAgent.set(profile.agentId, profile);
      backend._upsertSession(profile, item.session);
    }
    return evidence;
  };
  const requests = [];
  const originalRead = backend.readSessionImage.bind(backend);
  backend.readSessionImage = async (key, ref) => {
    hydrate();
    const image = await originalRead(key, ref);
    requests.push({ key, ref, loaded: !!image, bytes: image?.bytes.length,
      sha256: image ? crypto.createHash("sha256").update(image.bytes).digest("hex") : null });
    fs.writeFileSync(path.join(output, "http-images.json"), JSON.stringify(requests, null, 2) + "\n", { mode: 0o600 });
    return image;
  };
  const media = await startStaticServer(0, { registry: { getBackend: id => id === "shoggoth" ? backend : null },
    userDataRoot: path.join(output, "ui-data"), homeDir: output });
  const dist = path.resolve(__dirname, "../app/manage-ui/dist");
  const mime = file => ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
    ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2" })[path.extname(file)] || "application/octet-stream";
  let address;
  const allowed = req => req.headers.host === new URL(address).host
    && (!req.headers.origin || req.headers.origin === address)
    && req.headers["sec-fetch-site"] !== "cross-site";
  const server = http.createServer((req, res) => {
    if (!allowed(req)) { res.writeHead(403); res.end(); return; }
    const pathname = new URL(req.url, "http://acceptance").pathname;
    if (pathname.startsWith("/__api/") || pathname.startsWith("/avatar/") || pathname === "/__media") {
      const target = pathname === "/__api/sessions/image" ? media.url : upstream;
      const headers = { ...req.headers, host: new URL(target).host };
      if (headers.origin) headers.origin = target;
      const proxy = http.request(target + req.url, { method: req.method, headers }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      proxy.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(proxy); return;
    }
    if (pathname === "/__acceptance-seed.js") {
      const evidence = hydrate();
      const ready = evidence.results.filter(item => item.status === "provider_and_bytes_passed");
      const sessions = ready.map(item => ({ key: item.key, agentId: item.agentId, agentName: item.name, backendId: "shoggoth",
        updatedAt: Date.now(), displayName: `图片验收 · ${item.name}`, kind: "direct" }));
      res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
      res.end(`window.realImageAcceptance=${JSON.stringify(ready.map(item => ({ name: item.name, key: item.key, refs: item.imageRefs })))};localStorage.setItem("shoggoth.chat.sessions.v1",${JSON.stringify(JSON.stringify(sessions))});if(!localStorage.getItem("shoggoth.chat.lastActive.v1")&&${JSON.stringify(ready[0]?.key ?? "")})localStorage.setItem("shoggoth.chat.lastActive.v1",${JSON.stringify(ready[0]?.key ?? "")});`);
      return;
    }
    let decoded;
    try { decoded = decodeURIComponent(pathname); }
    catch { res.writeHead(400); res.end(); return; }
    let file = path.resolve(dist, "." + decoded);
    if (!file.startsWith(dist + path.sep)) file = path.join(dist, "index.html");
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(dist, "index.html");
    res.writeHead(200, { "Content-Type": mime(file), "Cache-Control": "no-store",
      ...(file.endsWith(".html") ? { "Content-Security-Policy": UI_CONTENT_SECURITY_POLICY } : {}) });
    if (file.endsWith(".html")) res.end(fs.readFileSync(file, "utf8").replace("</head>", '<script src="/__acceptance-seed.js"></script></head>'));
    else fs.createReadStream(file).pipe(res);
  });
  const sockets = new Set();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!allowed(req) || new URL(req.url, upstream).pathname !== "/__chatws") { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, client => {
      const upstreamSocket = new WebSocket(upstream.replace(/^http/, "ws") + req.url, { headers: { Origin: upstream } });
      sockets.add(client); sockets.add(upstreamSocket);
      const queue = [];
      client.on("message", (bytes, binary) => {
        // External Service clients create these test sessions independently of
        // the installed gateway's in-memory session cache. Read their current
        // canonical metadata/history through the real source Backend.
        let request;
        try { request = JSON.parse(bytes.toString()); } catch {}
        const evidence = hydrate();
        if (request?.type === "req" && request.method === "sessions.list") {
          client.send(JSON.stringify({ type: "res", id: request.id, ok: true,
            payload: { sessions: backend._rows, hasMore: false } }));
          return;
        }
        if (request?.type === "req" && request.method === "chat.history"
          && evidence.results.some(item => item.key === request.params?.sessionKey && item.session)) {
          backend.getHistory(request.params.sessionKey, request.params).then(payload => {
            if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "res", id: request.id, ok: true, payload }));
          }).catch(() => {
            if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "res", id: request.id, ok: false,
              error: { code: "ACCEPTANCE_HISTORY_UNAVAILABLE", message: "测试会话历史暂不可用" } }));
          });
          return;
        }
        if (upstreamSocket.readyState === WebSocket.OPEN) upstreamSocket.send(bytes, { binary });
        else if (upstreamSocket.readyState === WebSocket.CONNECTING && queue.length < 32) queue.push([bytes, binary]);
      });
      upstreamSocket.on("open", () => { for (const [bytes, binary] of queue.splice(0)) upstreamSocket.send(bytes, { binary }); });
      upstreamSocket.on("message", (bytes, binary) => { if (client.readyState === WebSocket.OPEN) client.send(bytes, { binary }); });
      client.on("close", () => { sockets.delete(client); upstreamSocket.close(); });
      upstreamSocket.on("close", () => { sockets.delete(upstreamSocket); client.close(); });
      client.on("error", () => upstreamSocket.close()); upstreamSocket.on("error", () => client.close());
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  address = `http://127.0.0.1:${server.address().port}`;
  return { url: address, close: async () => {
    for (const socket of sockets) socket.terminate();
    wss.close(); await new Promise(resolve => server.close(resolve)); await media.close();
  } };
}
async function main() {
  const output = process.argv[2];
  const server = await start({ output });
  console.log(JSON.stringify({ preview: server.url, output, history: "real-Service-through-source-Backend", media: "source-session-image-route" }));
  await new Promise(resolve => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
  await server.close();
}
if (require.main === module) main().catch(() => { console.error("REAL_IMAGE_UI_FAILED"); process.exitCode = 1; });
module.exports = { start };
