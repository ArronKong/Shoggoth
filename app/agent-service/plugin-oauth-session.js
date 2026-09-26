"use strict";

const crypto = require("node:crypto");
const { auth } = require("@modelcontextprotocol/client");
const { endpointOf } = require("./plugin-mcp-client");
const { serviceError } = require("./security");

const DEFAULT_LIFETIME_MS = 5 * 60_000;
const MAX_SESSIONS = 16;
const SCOPE = /^[\x21\x23-\x5B\x5D-\x7E]+$/u;

function fail(code, message) { throw serviceError(code, message); }
function callbackOf(value, allowLoopback) {
  const url = endpointOf(value, allowLoopback);
  if (url.search) {
    fail("CONNECTION_AUTH_REQUIRED", "OAuth 回调地址无效");
  }
  return url;
}
function singleParameter(params, name) {
  const values = params.getAll(name);
  return values.length === 1 && values[0] ? values[0] : null;
}
function sameState(left, right) {
  const a = Buffer.from(left || "", "utf8");
  const b = Buffer.from(right || "", "utf8");
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

// Service-internal, memory-only authorization session. The pinned SDK owns
// discovery, PKCE, issuer validation, resource indicators and token exchange.
// This wrapper owns callback state, expiry, one-use semantics and account slots.
// Persistence and live Connection commit are separate, still-closed gates.
class PluginOAuthSessionManager {
  #sessions = new Map();
  #fetch;
  #now;
  #lifetimeMs;

  constructor({ fetchImpl, now = Date.now,
    lifetimeMs = DEFAULT_LIFETIME_MS } = {}) {
    if (typeof fetchImpl !== "function" || typeof now !== "function"
      || !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1000
      || lifetimeMs > 10 * 60_000) {
      throw new TypeError("PluginOAuthSessionManager requires trusted fetch and clock");
    }
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#lifetimeMs = lifetimeMs;
  }

  async start({ connectionId, serverUrl, redirectUrl, clientId,
    scope, allowLoopback = false } = {}) {
    const createdAt = this.#now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      fail("CONNECTION_AUTH_REQUIRED", "OAuth 会话时钟无效");
    }
    for (const [id, session] of this.#sessions) {
      if (createdAt >= session.expiresAt) this.#sessions.delete(id);
    }
    if (typeof connectionId !== "string" || !connectionId || connectionId.length > 128
      || typeof serverUrl !== "string" || serverUrl.length > 4096
      || typeof redirectUrl !== "string" || redirectUrl.length > 4096
      || typeof clientId !== "string" || !clientId || clientId.length > 512
      || typeof scope !== "string" || !scope || scope.length > 2048
      || this.#sessions.has(connectionId)) {
      fail("CONNECTION_AUTH_REQUIRED", "OAuth 会话参数无效或连接已占用");
    }
    const requestedScopes = scope.split(" ");
    if (requestedScopes.length > 128 || requestedScopes.some((item) =>
      item.length === 0 || item.length > 256 || !SCOPE.test(item))
      || new Set(requestedScopes).size !== requestedScopes.length) {
      fail("CONNECTION_AUTH_REQUIRED", "OAuth scope 无效");
    }
    if (this.#sessions.size >= MAX_SESSIONS) {
      fail("PLUGIN_CONNECTION_LIMIT", "OAuth 待处理会话已达上限");
    }
    const server = endpointOf(serverUrl, allowLoopback);
    const redirect = callbackOf(redirectUrl, allowLoopback);
    const state = crypto.randomBytes(32).toString("base64url");
    const session = { state, serverUrl: server.href, redirectUrl: redirect.href,
      requestedScopes,
      expiresAt: createdAt + this.#lifetimeMs, phase: "starting", url: null,
      discovery: null, verifier: null, clientInformation: { client_id: clientId },
      tokens: null };
    const provider = {
      get redirectUrl() { return redirect.href; },
      get clientMetadata() { return {
        client_name: "Shoggoth",
        redirect_uris: [redirect.href],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }; },
      state: () => state,
      clientInformation: (context) => ({ ...session.clientInformation,
        issuer: session.clientInformation.issuer ?? context?.issuer }),
      saveClientInformation: (value) => { session.clientInformation = value; },
      tokens: () => session.tokens ?? undefined,
      saveTokens: (value) => { session.tokens = value; },
      redirectToAuthorization: (url) => { session.url = url.href; },
      saveCodeVerifier: (value) => { session.verifier = value; },
      codeVerifier: () => session.verifier,
      saveDiscoveryState: (value) => { session.discovery = value; },
      discoveryState: () => session.discovery ?? undefined,
    };
    session.provider = provider;
    this.#sessions.set(connectionId, session);
    try {
      const result = await auth(provider, { serverUrl: server, scope, fetchFn: this.#fetch });
      if (this.#sessions.get(connectionId) !== session || result !== "REDIRECT"
        || !session.url || !session.verifier || !session.discovery
        || this.#now() >= session.expiresAt) {
        fail("CONNECTION_AUTH_REQUIRED", "OAuth 授权启动未完成");
      }
      session.phase = "pending";
      return Object.freeze({ connectionId, authorizationUrl: session.url,
        expiresAt: session.expiresAt });
    } catch {
      if (this.#sessions.get(connectionId) === session) this.#sessions.delete(connectionId);
      fail("CONNECTION_AUTH_REQUIRED", "OAuth 授权启动失败");
    }
  }

  async finish({ connectionId, callbackUrl } = {}) {
    const session = this.#sessions.get(connectionId);
    if (!session || session.phase !== "pending") {
      fail("CONNECTION_AUTH_REQUIRED", "OAuth 授权会话不存在");
    }
    if (this.#now() >= session.expiresAt) {
      this.#sessions.delete(connectionId);
      fail("CONNECTION_AUTH_REQUIRED", "OAuth 授权会话已过期");
    }
    if (typeof callbackUrl !== "string" || callbackUrl.length > 16_384) {
      fail("CONNECTION_AUTH_REQUIRED", "OAuth 回调无效");
    }
    let callback;
    try { callback = new URL(callbackUrl); }
    catch { fail("CONNECTION_AUTH_REQUIRED", "OAuth 回调无效"); }
    const expected = new URL(session.redirectUrl);
    if (callback.origin !== expected.origin || callback.pathname !== expected.pathname
      || callback.hash || !sameState(singleParameter(callback.searchParams, "state"), session.state)) {
      fail("CONNECTION_AUTH_REQUIRED", "OAuth 回调来源或 state 无效");
    }
    // A matching state consumes the session before any network exchange. Failed
    // exchange, issuer mismatch and replay cannot redeem the code again.
    session.phase = "exchanging";
    const code = singleParameter(callback.searchParams, "code");
    const issValues = callback.searchParams.getAll("iss");
    if (!code || code.length > 4096 || issValues.length > 1
      || (issValues[0] && issValues[0].length > 2048)
      || callback.searchParams.has("error")) {
      this.#sessions.delete(connectionId);
      fail("CONNECTION_AUTH_REQUIRED", "OAuth 授权未完成");
    }
    try {
      const result = await auth(session.provider, { serverUrl: session.serverUrl,
        authorizationCode: code, iss: issValues[0], fetchFn: this.#fetch });
      if (this.#sessions.get(connectionId) !== session || result !== "AUTHORIZED"
        || !session.tokens?.access_token || this.#now() >= session.expiresAt) {
        fail("CONNECTION_AUTH_REQUIRED", "OAuth 授权结果无效");
      }
      // A token response alone does not prove the account principal or make a
      // PluginStore Connection ready. That separate Service check stays closed.
      session.phase = "token_received";
      session.state = null;
      session.verifier = null;
      session.url = null;
      return Object.freeze({ connectionId, status: "token_received_unverified",
        scopes: Object.freeze((session.tokens.scope || "").split(" ").filter(Boolean)) });
    } catch {
      if (this.#sessions.get(connectionId) === session) this.#sessions.delete(connectionId);
      fail("CONNECTION_AUTH_REQUIRED", "OAuth 授权交换失败");
    }
  }

  status(connectionId) {
    const session = this.#sessions.get(connectionId);
    if (!session) return Object.freeze({ connectionId, status: "disconnected" });
    if (this.#now() >= session.expiresAt) {
      this.#sessions.delete(connectionId);
      return Object.freeze({ connectionId, status: "disconnected" });
    }
    return Object.freeze({ connectionId,
      status: session.phase === "token_received"
        ? "token_received_unverified" : "pending" });
  }

  // Only trusted Service code may call this. The token is handed to one
  // persister/identity verifier, never returned through a management DTO.
  // Consume before awaiting it: a failed commit needs a new OAuth flow.
  async consumeTokens({ connectionId, commit } = {}) {
    if (typeof commit !== "function") {
      fail("CONNECTION_AUTH_REQUIRED", "OAuth token 交接缺少受信处理器");
    }
    const session = this.#sessions.get(connectionId);
    if (!session || session.phase !== "token_received") {
      fail("CONNECTION_AUTH_REQUIRED", "OAuth token 尚未可交接");
    }
    if (this.#now() >= session.expiresAt) {
      this.#sessions.delete(connectionId);
      fail("CONNECTION_AUTH_REQUIRED", "OAuth token 已过期");
    }
    this.#sessions.delete(connectionId);
    const issuer = session.discovery?.authorizationServerMetadata?.issuer;
    const audience = session.discovery?.resourceMetadata?.resource ?? session.serverUrl;
    if (typeof issuer !== "string" || !issuer || typeof audience !== "string" || !audience) {
      fail("CONNECTION_AUTH_REQUIRED", "OAuth 发行方或资源身份缺失");
    }
    const tokens = session.tokens;
    session.tokens = null;
    await commit(tokens, Object.freeze({ issuer, audience,
      requestedScopes: Object.freeze([...session.requestedScopes]) }));
    return Object.freeze({ connectionId, status: "token_consumed_unverified" });
  }

  cancel(connectionId) { return this.#sessions.delete(connectionId); }
}

module.exports = { PluginOAuthSessionManager };
