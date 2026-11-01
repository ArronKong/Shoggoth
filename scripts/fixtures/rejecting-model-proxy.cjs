"use strict";
const http = require("node:http"), assert = require("node:assert/strict");

// Never forwards a request or records its headers, token, body or full URL.
async function rejectingModelProxy(enabled) {
  const requests = [], env = {};
  const record = (method, address) => {
    let loopback = false;
    try { loopback = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(address.includes("://") ? address : `http://${address}`).hostname); } catch {}
    requests.push({ method, loopback });
  };
  const server = http.createServer((req, res) => {
    record(req.method, req.url || ""); req.resume(); res.writeHead(502).end("synthetic proxy refusal");
  });
  server.on("connect", (req, socket) => { record("CONNECT", req.url || ""); socket.destroy(); });
  if (enabled) {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const proxy = `http://127.0.0.1:${server.address().port}`;
    Object.assign(env, { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
      NO_PROXY: "", no_proxy: "", NODE_USE_ENV_PROXY: "1" });
  }
  return { env, requests,
    assertLoopbackBypassed() { assert(!requests.some(request => request.loopback), "local model and projection requests must bypass the proxy"); },
    async close() { if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } },
  };
}
module.exports = { rejectingModelProxy };
