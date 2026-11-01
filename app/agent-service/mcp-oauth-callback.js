"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const { serviceError } = require("./security");
const CALLBACK_PATH = "/mcp/oauth/callback";
const DEFAULT_CALLBACK_PORT = 18873;
function sameState(a, b) {
  const x = Buffer.from(a || ""); const y = Buffer.from(b || "");
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}
class McpOAuthCallback {
  constructor({ port = DEFAULT_CALLBACK_PORT, now = Date.now } = {}) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw serviceError("MCP_OAUTH_CALLBACK_INVALID", "OAuth 回调端口无效");
    this.port = port; this.now = now; this.sessions = new Map(); this.server = null; this.starting = null; this.closed = false;
  }
  open() { if(this.server) throw serviceError("MCP_OAUTH_CALLBACK_UNAVAILABLE", "OAuth 回调尚未关闭"); this.closed=false; this.starting=null; this.sessions.clear(); return this; }
  get redirectUri() { return `http://127.0.0.1:${this.port}${CALLBACK_PATH}`; }
  async start() {
    if (this.closed) throw serviceError("MCP_OAUTH_CANCELLED", "OAuth 回调已关闭");
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => { void this._handle(req, res); });
      server.requestTimeout = 5000; server.headersTimeout = 5000;
      server.once("error", () => { this.server = null; this.starting = null; reject(serviceError("MCP_OAUTH_CALLBACK_UNAVAILABLE", "OAuth 回调端口不可用，请更换端口或关闭占用它的程序")); });
      server.listen({ host: "127.0.0.1", port: this.port, exclusive: true }, () => { this.server = server; server.unref(); resolve(this.redirectUri); });
    });
    return this.starting;
  }
  async register({ id, state, expiresAt, onCode, onError }) {
    await this.start();
    if (this.closed || typeof id !== "string" || typeof state !== "string" || state.length < 32 || this.sessions.has(id)) throw serviceError("MCP_OAUTH_CALLBACK_INVALID", "OAuth 回调会话无效");
    this.sessions.set(id, { state, expiresAt, onCode, onError });
    return this.redirectUri;
  }
  cancel(id) { return this.sessions.delete(id); }
  async _handle(req, res) {
    const reply = (status, text) => { if (!res.writableEnded) { res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" }); res.end(text); } };
    try {
      if (req.method !== "GET" || !req.url || req.url.length > 16384 || req.headers.host !== `127.0.0.1:${this.port}`) return reply(400, "Invalid OAuth callback.");
      const url = new URL(req.url, this.redirectUri);
      if (url.pathname !== CALLBACK_PATH || url.hash || url.searchParams.getAll("state").length !== 1) return reply(400, "Invalid OAuth callback.");
      let found;
      for (const [id, session] of this.sessions) if (sameState(url.searchParams.get("state"), session.state)) { found = [id, session]; break; }
      if (!found) return reply(400, "This authorization request is unavailable. Return to Shoggoth and sign in again.");
      const [id, session] = found;
      // Consume before the exchange. Matching callbacks and cancellation can never redeem twice.
      this.sessions.delete(id);
      if (this.now() >= session.expiresAt) { session.onError?.("MCP_OAUTH_EXPIRED"); return reply(410, "Authorization expired."); }
      const codes = url.searchParams.getAll("code"); const issuers = url.searchParams.getAll("iss");
      if (url.searchParams.has("error") || codes.length !== 1 || !codes[0] || codes[0].length > 4096 || issuers.length > 1 || (issuers[0]?.length || 0) > 2048) {
        session.onError?.("MCP_OAUTH_DENIED"); return reply(400, "Authorization was not completed. Return to Shoggoth.");
      }
      await session.onCode({ code: codes[0], iss: issuers[0] });
      reply(200, "Authorization received. You can return to Shoggoth.");
    } catch { reply(400, "Authorization failed. Return to Shoggoth and try again."); }
  }
  async close() {
    this.closed = true; this.sessions.clear();
    await this.starting?.catch(() => {});
    const server = this.server; this.server = null;
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
  }
}
module.exports = { McpOAuthCallback, DEFAULT_CALLBACK_PORT, CALLBACK_PATH, sameState };
