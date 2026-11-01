"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const CANARY = "mcp-secret-canary-Bc92E3f";
async function startFixture({ accessToken = CANARY, refreshAccessToken } = {}) {
  const state = { registrations: [], exchanges: [], refreshes: 0, refreshRequests: [], calls: 0, rejectedCalls: 0, requests: [], refreshDenied: false, requireAuth: true, token: CANARY, accessToken, refreshAccessToken, sseAttempts: 0, firstPostStatus: 404, connections: new Set() };
  let origin;
  const codes = new Map(); const streams = new Map();
  const tools = [{ name: "echo", description: "Read-only fixture echo", inputSchema: { type: "object", properties: { value: { type: "string" } } } }];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const json = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
    const read = async () => { let text = ""; for await (const chunk of req) { text += chunk; if (text.length > 262144) throw Error("too large"); } return text; };
    try {
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["read"] });
      if (["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"].includes(url.pathname)) return json(200, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none", "client_secret_basic"], code_challenge_methods_supported: ["S256"] });
      if (url.pathname === "/register") { const registration = JSON.parse(await read()); state.registrations.push(registration); return json(201, { ...registration, client_id: "fixture-dcr", client_id_issued_at: 1 }); }
      if (url.pathname === "/authorize") {
        const code = crypto.randomUUID(); codes.set(code, Object.fromEntries(url.searchParams));
        const redirect = new URL(url.searchParams.get("redirect_uri")); redirect.searchParams.set("code", code); redirect.searchParams.set("state", url.searchParams.get("state")); redirect.searchParams.set("iss", origin);
        res.writeHead(302, { location: redirect.href }); return res.end();
      }
      if (url.pathname === "/token") {
        const body = new URLSearchParams(await read());
        if (body.get("grant_type") === "refresh_token") {
          state.refreshes += 1;
          state.refreshRequests.push(Object.fromEntries(body));
          if (state.refreshDenied) return json(400, { error: "invalid_grant", error_description: CANARY });
          state.token = state.refreshAccessToken ?? `refreshed-${state.refreshes}-${CANARY}`;
          return json(200, { access_token: state.token, refresh_token: "fixture-refresh", token_type: "Bearer", expires_in: 3600 });
        }
        const authorization = codes.get(body.get("code")); codes.delete(body.get("code"));
        state.exchanges.push(Object.fromEntries(body));
        if(state.exchangeWait)await state.exchangeWait;
        const hash = crypto.createHash("sha256").update(body.get("code_verifier") || "").digest("base64url");
        if (!authorization || authorization.code_challenge !== hash || body.get("redirect_uri") !== authorization.redirect_uri || body.get("resource") !== `${origin}/mcp`) return json(400, { error: "invalid_grant", error_description: CANARY });
        state.token = state.accessToken;
        return json(200, { access_token: state.token, refresh_token: "fixture-refresh", token_type: "Bearer", expires_in: 3600 });
      }
      if (url.pathname === "/sse") {
        if (req.method === "POST") return json(state.firstPostStatus, { error: "use sse" });
        state.sseAttempts += 1;
        const id = crypto.randomUUID(); streams.set(id, res);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`); req.on("close", () => streams.delete(id)); return;
      }
      if (url.pathname === "/huge") { res.writeHead(200, { "content-type": "application/json", "content-length": "1048577" }); return res.end("{}"); }
      if (url.pathname === "/redirect") { res.writeHead(307, { location: `${origin}/mcp` }); return res.end(); }
      if (!["/mcp", "/public", "/messages", "/disconnect", "/rejected"].includes(url.pathname)) return json(404, {});
      if (req.method === "GET") { res.writeHead(405); return res.end(); }
      if (req.method === "DELETE") { res.writeHead(200); return res.end(); }
      const msg = JSON.parse(await read());
      state.requests.push({ method: msg.method, params: msg.params, protocolVersion: req.headers["mcp-protocol-version"] });
      if (state.requireAuth && url.pathname === "/mcp" && req.headers.authorization !== `Bearer ${state.token}`) return json(401, {}, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="read"` });
      if (msg.method === "tools/call") {
        state.calls += 1;
        if (url.pathname === "/disconnect") { req.socket.destroy(); return; }
        if (url.pathname === "/rejected") { state.rejectedCalls += 1; return json(401, {}, { "www-authenticate": "Bearer" }); }
      }
      if (msg.id === undefined) { res.writeHead(202); return res.end(); }
      let result;
      if (msg.method === "initialize" && state.modernVersions) return json(200, { jsonrpc: "2.0", id: msg.id, error: { code: -32022, message: "Unsupported protocol version", data: { requested: msg.params.protocolVersion, supported: state.modernVersions } } });
      if (msg.method === "server/discover" && state.modernVersions && !state.rejectDiscovery) result = { supportedVersions: state.modernVersions, capabilities: { tools: {} }, ttlMs: 0, cacheScope: "private" };
      else if (msg.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
      else if (msg.method === "tools/list") result = { tools: state.echoTokenInTools ? tools.map(tool=>({...tool,description:state.token})) : tools, ...(state.modernVersions ? { ttlMs: 0, cacheScope: "private" } : {}) };
      else if (msg.method === "tools/call") result = { content: [{ type: "text", text: msg.params.arguments.value || "fixture" }] };
      else return json(200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Unknown method" } });
      if (state.modernVersions) result.resultType = "complete";
      const message = { jsonrpc: "2.0", id: msg.id, result };
      if (url.pathname === "/messages") { streams.get(url.searchParams.get("sessionId"))?.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`); res.writeHead(202); return res.end(); }
      return json(200, message);
    } catch { if (!res.headersSent) json(400, {}); else res.end(); }
  });
  server.on("connection", socket => { state.connections.add(socket); socket.on("close", () => state.connections.delete(socket)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, state, async close() { for (const stream of streams.values()) stream.end(); for (const socket of state.connections) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { startFixture, CANARY };
