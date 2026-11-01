"use strict";
const crypto = require("node:crypto");
const { auth, refreshAuthorization, extractWWWAuthenticateParams, RegistrationRejectedError } = require("@modelcontextprotocol/client");
const { serviceError } = require("./security");
const { McpOAuthCallback, DEFAULT_CALLBACK_PORT } = require("./mcp-oauth-callback");
const { endpointOf, boundedHttpResponse, validOAuthToken } = require("./mcp-transport-utils");
const { McpDeviceAuthorization, deviceProfile } = require("./mcp-device-authorization");
const SESSION_LIFETIME_MS = 5 * 60_000;
function oauthError(code = "MCP_AUTH_REQUIRED") { return serviceError(code, "MCP 授权未完成，请在连接器页面重新登录"); }
class McpOAuthClient {
  constructor({ store, secrets, callback, callbackPort, fetch: fetchImpl = require("./mcp-http-fetch").getMcpFetch(), now = Date.now, onChange = null, deviceSleep } = {}) {
    if (!store || !secrets || typeof fetchImpl !== "function") throw new TypeError("McpOAuthClient requires store and encrypted secrets");
    this.store = store; this.secrets = secrets; this.fetch = fetchImpl; this.now = now; this.onChange = onChange;
    const configuredPort = callbackPort ?? Number(process.env.SHOGGOTH_MCP_OAUTH_CALLBACK_PORT || DEFAULT_CALLBACK_PORT);
    this.callback = callback || new McpOAuthCallback({ port: configuredPort, now });
    this.sessions = new Map(); this.refreshing = new Map(); this.challenges = new Map(); this.closed = false;
    this.device = new McpDeviceAuthorization({ fetch: this._oauthFetch.bind(this), now, ...(deviceSleep ? { wait: deviceSleep } : {}) });
  }
  open() { for (const id of this.sessions.keys()) this.cancel(id); this.closed=false; this.sessions.clear(); this.refreshing.clear(); this.challenges.clear(); this.callback.open?.(); return this; }
  get redirectUri() { return this.callback.redirectUri; }
  _record(id) {
    const record = this.store.getPrivate?.(id) ?? this.store.get(id);
    if (!record || !record.enabled || record.transport?.kind !== "remote") throw oauthError();
    endpointOf(record.transport.url);
    return record;
  }
  _changed(session) {
    try { const result = this.onChange?.({ id: session.id, signInId: session.signInId, status: session.status, errorCode: session.errorCode || null }); Promise.resolve(result).catch(() => {}); } catch {}
  }
  _active(session) { return !this.closed && this.sessions.get(session.signInId) === session && ["starting", "pending", "exchanging"].includes(session.status) && this.now() < session.expiresAt; }
  async _oauthFetch(input, init = {}) {
    const url = endpointOf(input instanceof URL ? input.href : input.url || input);
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000);
    let raw;
    try { raw = await this.fetch(url, { ...init, redirect: "manual", signal }); }
    catch { throw oauthError("MCP_SERVER_CONNECTION_FAILED"); }
    if (raw.status >= 300 && raw.status < 400) { void raw.body?.cancel().catch(() => {}); throw oauthError("MCP_OAUTH_REDIRECT_REJECTED"); }
    const response = boundedHttpResponse(raw);
    // Authorization-server error descriptions may echo secrets. Only the standard code is allowed into SDK errors/logs.
    if (!response.ok) {
      let error = "server_error";
      try { const value = await response.json(); if (typeof value.error === "string" && /^[a-z_]{1,64}$/u.test(value.error)) error = value.error; } catch {}
      return new Response(JSON.stringify({ error }), { status: response.status, headers: { "content-type": "application/json" } });
    }
    return response;
  }
  _provider(session) {
    return {
      get redirectUrl() { return session.redirectUri; },
      get clientMetadata() { return { client_name: "Shoggoth", redirect_uris: [session.redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: session.client?.client_secret ? (session.client.token_endpoint_auth_method || "client_secret_basic") : "none" }; },
      state: () => session.state,
      clientInformation: context => {
        // Discovery has already validated the issuer. Without a registration
        // endpoint (or a client metadata URL from us), the user must supply a client.
        if (!session.client && session.discovery?.authorizationServerMetadata
          && !session.discovery.authorizationServerMetadata.registration_endpoint) throw oauthError("MCP_OAUTH_CLIENT_REQUIRED");
        if (session.client && context?.issuer) {
          if (session.client.issuer && session.client.issuer !== context.issuer) throw oauthError("MCP_OAUTH_CLIENT_CHANGED");
          session.client = { ...session.client, issuer: context.issuer };
        }
        return session.client;
      },
      saveClientInformation: value => {
        if (!this._active(session)) throw oauthError("MCP_OAUTH_CANCELLED");
        if (session.preRegistered && value.client_id !== session.client.client_id) throw oauthError("MCP_OAUTH_CLIENT_CHANGED");
        session.client = value;
      },
      tokens: () => undefined,
      saveTokens: value => {
        if (!this._active(session)) throw oauthError("MCP_OAUTH_CANCELLED");
        if (!validOAuthToken(value.access_token) || String(value.token_type || "Bearer").toLowerCase() !== "bearer") throw oauthError("MCP_SERVER_RESPONSE_INVALID");
        session.tokens = { ...value, expiresAt: Number.isFinite(value.expires_in) ? this.now() + value.expires_in * 1000 : null };
      },
      redirectToAuthorization: value => { session.authorizationUrl = endpointOf(value.href).href; },
      saveCodeVerifier: value => { session.verifier = value; },
      codeVerifier: () => { if (!this._active(session) || !session.verifier) throw oauthError(); return session.verifier; },
      saveDiscoveryState: value => { session.discovery = value; },
      discoveryState: () => session.discovery,
      invalidateCredentials: scope => {
        if (scope === "all" || scope === "tokens") session.tokens = undefined;
        if (scope === "all" || scope === "verifier") session.verifier = undefined;
        if (scope === "all" || scope === "discovery") session.discovery = undefined;
        if ((scope === "all" || scope === "client") && !session.preRegistered) session.client = undefined;
      },
    };
  }
  async start(id) {
    if (this.closed) throw oauthError("MCP_OAUTH_CANCELLED");
    const record = this._record(id);
    for (const current of this.sessions.values()) if (current.id === id && this._active(current)) this.cancel(current.signInId);
    await Promise.allSettled([...this.sessions.values()].filter(current=>current.id===id&&current.completion).map(current=>current.completion));
    for (const [key, current] of this.sessions) if (this.now() >= current.expiresAt && !this._active(current)) this.sessions.delete(key);
    if (this.sessions.size >= 64) throw oauthError("MCP_OAUTH_SESSION_LIMIT");
    const saved = record.secretRef ? await this.secrets.get(record.secretRef) : {};
    if (!saved) throw oauthError("MCP_CREDENTIALS_LOCKED");
    const redirectUri = this.redirectUri;
    const preRegistered = record.auth?.kind === "oauth-client";
    let client = saved.oauthClient;
    if (client?.clientId) { client = {client_id:client.clientId,...(client.clientSecret ? {client_secret:client.clientSecret,token_endpoint_auth_method:"client_secret_basic"} : {token_endpoint_auth_method:"none"}),...(client.issuer?{issuer:client.issuer}:{})}; }
    if (client?.redirectUri && client.redirectUri !== redirectUri) {
      if (preRegistered) throw oauthError("MCP_OAUTH_REDIRECT_CHANGED");
      client = undefined;
    }
    if (client) { client = { ...client }; delete client.redirectUri; }
    const profile = deviceProfile(record, client);
    if (profile) return this._startDevice(record, saved, profile);
    if (client?.shoggothProfileId) throw oauthError("MCP_OAUTH_CLIENT_CHANGED");
    if (preRegistered && !client?.client_id) throw oauthError("MCP_OAUTH_CLIENT_REQUIRED");
    const session = { id, signInId: crypto.randomUUID(), state: crypto.randomBytes(32).toString("base64url"), redirectUri, client, preRegistered,
      status: "starting", createdAt: this.now(), expiresAt: this.now() + SESSION_LIFETIME_MS,
      // Bind discovery to this exact server URL. Saved discovery is only reused for a refresh.
      discovery: undefined, serverUrl: record.transport.url, verifier: undefined, tokens: undefined };
    this.sessions.set(session.signInId, session);
    try {
      await this.callback.register({ id: session.signInId, state: session.state, expiresAt: session.expiresAt,
        onCode: input => { session.completion=this._finish(session,input); return session.completion; }, onError: code => this._fail(session, code) });
      const result = await auth(this._provider(session), { serverUrl: session.serverUrl, forceReauthorization: true, fetchFn: this._oauthFetch.bind(this), ...this.challenges.get(id) });
      if (!this._active(session) || result !== "REDIRECT" || !session.authorizationUrl || !session.verifier || !session.discovery) throw oauthError();
      session.status = "pending"; this._changed(session);
      return this.get(session.signInId);
    } catch (error) {
      const code = ["MCP_OAUTH_CALLBACK_UNAVAILABLE", "MCP_OAUTH_CLIENT_REQUIRED", "MCP_SERVER_CONNECTION_FAILED"].includes(error?.code) ? error.code
        : error instanceof RegistrationRejectedError && [400, 401, 403].includes(error.status) ? "MCP_OAUTH_REGISTRATION_DENIED" : "MCP_AUTH_REQUIRED";
      this._fail(session, code); throw oauthError(session.errorCode);
    }
  }
  _deviceConfiguration(record) { return JSON.stringify({ source: record.source, transport: record.transport, auth: record.auth, secretRef: record.secretRef }); }
  _deviceCurrent(session) {
    if (!this._active(session) || this._deviceConfiguration(this._record(session.id)) !== session.configuration) throw oauthError("MCP_OAUTH_CLIENT_CHANGED");
  }
  async _startDevice(record, saved, profile) {
    const session = { id: record.id, signInId: crypto.randomUUID(), status: "starting", profile, redirectUri: null,
      configuration: this._deviceConfiguration(record), originalCredentials: JSON.stringify([saved.oauthClient || null, saved.oauthToken || null]),
      expiresAt: this.now() + SESSION_LIFETIME_MS, abort: new AbortController() };
    this.sessions.set(session.signInId, session);
    try {
      const grant = await this.device.start(profile, session.abort.signal); this._deviceCurrent(session);
      Object.assign(session, { grant, userCode: grant.userCode, expiresAt: grant.expiresAt, authorizationUrl: profile.verificationUri, status: "pending" });
      this._changed(session);
      session.completion = this._finishDevice(session).catch(() => this._fail(session, "MCP_CREDENTIALS_LOCKED"));
      return this.get(session.signInId);
    } catch (error) { this._fail(session, ["MCP_OAUTH_CANCELLED", "MCP_OAUTH_CLIENT_CHANGED", "MCP_SERVER_CONNECTION_FAILED"].includes(error?.code) ? error.code : "MCP_OAUTH_FAILED"); throw oauthError(session.errorCode); }
  }
  async _finishDevice(session) {
    let committed;
    try {
      const token = await this.device.authorize(session.profile, session.grant, session.abort.signal); this._deviceCurrent(session);
      const latest = await this.secrets.read(session.id); this._deviceCurrent(session);
      if (JSON.stringify([latest?.oauthClient || null, latest?.oauthToken || null]) !== session.originalCredentials) throw oauthError("MCP_OAUTH_CLIENT_CHANGED");
      session.status = "exchanging";
      const p = session.profile;
      const secretRef = await this.secrets.write(session.id, { oauthClient: { client_id: p.clientId, issuer: p.issuer, token_endpoint_auth_method: "none", shoggothProfileId: p.id },
        oauthToken: token, oauthDiscovery: { serverUrl: p.serverUrl, authorizationServerUrl: p.issuer, authorizationServerMetadata: { issuer: p.issuer, token_endpoint: p.tokenEndpoint }, deviceProfileId: p.id }, oauthCodeVerifier: null });
      committed = token.access_token; this._deviceCurrent(session);
      this.store.update({ id: session.id, patch: { secretRef, auth: { kind: "oauth-client" } }, expectedRevision: this.store.revision });
      session.status = "authorized"; session.authorizationUrl = null; session.userCode = null; session.grant = null;
      this._changed(session);
    } catch (error) {
      if (committed) { const latest = await this.secrets.read(session.id); if (latest?.oauthToken?.access_token === committed) await this.secrets.write(session.id, { oauthToken: null }); }
      if (error?.code === "MCP_OAUTH_EXPIRED") { this.get(session.signInId); if (session.status !== "expired") { this._fail(session, error.code); session.status = "expired"; } }
      else this._fail(session, ["MCP_OAUTH_DENIED", "MCP_OAUTH_CLIENT_CHANGED", "MCP_SERVER_CONNECTION_FAILED"].includes(error?.code) ? error.code : "MCP_OAUTH_FAILED");
    }
  }
  async _finish(session, { code, iss }) {
    if (!this._active(session) || session.status !== "pending") throw oauthError("MCP_OAUTH_CANCELLED");
    session.status = "exchanging";
    try {
      const result = await auth(this._provider(session), { serverUrl: session.serverUrl, authorizationCode: code, iss, fetchFn: this._oauthFetch.bind(this) });
      if (!this._active(session) || result !== "AUTHORIZED" || !session.tokens) throw oauthError();
      const current = this._record(session.id);
      if (current.transport.url !== session.serverUrl) throw oauthError("MCP_OAUTH_CLIENT_CHANGED");
      // secrets.write is a synchronous encrypted commit in production. Cancellation is checked before and after it.
      const secretRef = await this.secrets.write(session.id, JSON.parse(JSON.stringify({ oauthClient: { ...session.client, redirectUri: session.redirectUri }, oauthToken: session.tokens, oauthDiscovery: { ...session.discovery, serverUrl: session.serverUrl }, oauthCodeVerifier: null })));
      if (!this._active(session)) { await this.secrets.write(session.id, { oauthToken: null }); throw oauthError("MCP_OAUTH_CANCELLED"); }
      if (!current.secretRef && typeof this.store.update === "function") this.store.update({id:session.id,patch:{secretRef},expectedRevision:this.store.revision});
      session.status = "authorized"; session.authorizationUrl = null; session.state = null; session.verifier = null; session.tokens = null;
      this._changed(session);
    } catch (error) {
      const code = ["MCP_OAUTH_CLIENT_CHANGED", "MCP_OAUTH_CANCELLED", "MCP_OAUTH_EXPIRED", "MCP_CREDENTIALS_LOCKED",
        "MCP_SERVER_CONNECTION_FAILED", "MCP_SERVER_RESPONSE_INVALID", "MCP_SERVER_RESPONSE_TOO_LARGE", "MCP_OAUTH_REDIRECT_REJECTED"].includes(error?.code) ? error.code : "MCP_OAUTH_FAILED";
      this._fail(session, code); throw oauthError(code);
    }
  }
  _fail(session, code) {
    if (["cancelled", "authorized", "expired"].includes(session.status)) return;
    this.callback.cancel(session.signInId); session.abort?.abort(); session.grant = null; session.userCode = null; session.status = "failed"; session.errorCode = code; session.authorizationUrl = null; session.verifier = null; session.tokens = null; session.state = null;
    this._changed(session);
  }
  get(signInId) {
    const session = this.sessions.get(signInId);
    if (!session) throw oauthError("MCP_OAUTH_SESSION_NOT_FOUND");
    if (["pending", "starting", "exchanging"].includes(session.status) && this.now() >= session.expiresAt) { this.callback.cancel(signInId); session.abort?.abort(); session.grant = null; session.userCode = null; session.status = "expired"; session.errorCode = "MCP_OAUTH_EXPIRED"; session.authorizationUrl = null; session.verifier = null; session.state = null; this._changed(session); }
    return Object.freeze({ id: session.id, signInId, status: session.status, authorizationUrl: session.status === "pending" ? session.authorizationUrl : null, redirectUri: session.redirectUri, expiresAt: session.expiresAt, errorCode: session.errorCode || null,
      flow: session.profile ? "device" : "redirect", userCode: session.status === "pending" ? session.userCode || null : null, installationUrl: session.profile?.installationUrl || null });
  }
  cancel(signInId) {
    const session = this.sessions.get(signInId);
    if (!session || ["authorized", "failed", "cancelled", "expired"].includes(session.status)) return false;
    this.callback.cancel(signInId); session.abort?.abort(); session.grant = null; session.userCode = null; session.status = "cancelled"; session.authorizationUrl = null; session.verifier = null; session.tokens = null; session.state = null; this._changed(session); return true;
  }
  async noteUnauthorized(id, response) {
    try { const challenge = extractWWWAuthenticateParams(response); this.challenges.set(id, challenge); } catch {}
  }
  async authorization(id, { forceRefresh = false } = {}) {
    const record = this._record(id);
    const saved = record.secretRef ? await this.secrets.get(record.secretRef) : {};
    if (!saved) throw oauthError("MCP_CREDENTIALS_LOCKED");
    if (!saved.oauthToken) throw oauthError();
    if (saved.oauthClient?.shoggothProfileId || saved.oauthDiscovery?.deviceProfileId) {
      const profile = deviceProfile(record, saved.oauthClient), discovery = saved.oauthDiscovery;
      if (!profile || discovery?.deviceProfileId !== profile.id || discovery.serverUrl !== profile.serverUrl
        || discovery.authorizationServerUrl !== profile.issuer || discovery.authorizationServerMetadata?.token_endpoint !== profile.tokenEndpoint) throw oauthError("MCP_OAUTH_CLIENT_CHANGED");
    }
    const token = saved.oauthToken;
    if (!forceRefresh && (token.expiresAt === null || token.expiresAt === undefined || token.expiresAt > this.now() + 30000)) {
      if (!validOAuthToken(token.access_token) || String(token.token_type || "Bearer").toLowerCase() !== "bearer") throw oauthError();
      return { Authorization: `Bearer ${token.access_token}` };
    }
    if (this.refreshing.has(id)) return this.refreshing.get(id);
    const promise = this._refresh(id, record, saved);
    this.refreshing.set(id, promise);
    try { return await promise; } finally { if (this.refreshing.get(id) === promise) this.refreshing.delete(id); }
  }
  async _refresh(id, record, saved) {
    const discovery = saved.oauthDiscovery;
    const configuration = this._deviceConfiguration(record);
    if (!saved.oauthToken.refresh_token || !saved.oauthClient || discovery?.serverUrl !== record.transport.url || !discovery.authorizationServerUrl) throw oauthError();
    try {
      const resource = discovery.resourceMetadata?.resource || record.transport.url;
      const client = { ...saved.oauthClient }; delete client.redirectUri;
      const profile = discovery.deviceProfileId ? deviceProfile(record, client) : null;
      if (discovery.deviceProfileId && (!profile || discovery.authorizationServerUrl !== profile.issuer || discovery.authorizationServerMetadata?.token_endpoint !== profile.tokenEndpoint)) throw oauthError("MCP_OAUTH_CLIENT_CHANGED");
      const tokens = profile ? await this.device.refresh(profile, saved.oauthToken) : await refreshAuthorization(discovery.authorizationServerUrl, { metadata: discovery.authorizationServerMetadata, clientInformation: client,
        refreshToken: saved.oauthToken.refresh_token, resource, fetchFn: this._oauthFetch.bind(this) });
      // Readiness checks update status/timestamps without changing credentials.
      // Fence the actual resource/client configuration and token generation.
      if (this.closed || !validOAuthToken(tokens.access_token) || String(tokens.token_type || "Bearer").toLowerCase() !== "bearer"
        || this._deviceConfiguration(this._record(id)) !== configuration) throw oauthError();
      const latest = await this.secrets.read(id);
      if (latest?.oauthToken?.access_token !== saved.oauthToken.access_token || latest?.oauthToken?.refresh_token !== saved.oauthToken.refresh_token) throw oauthError();
      const value = { ...tokens, issuer: saved.oauthToken.issuer, expiresAt: Number.isFinite(tokens.expires_in) ? this.now() + tokens.expires_in * 1000 : null };
      await this.secrets.write(id, JSON.parse(JSON.stringify({ oauthToken: value })));
      return { Authorization: `Bearer ${value.access_token}` };
    } catch (error) {
      if (error?.code === "MCP_SERVER_CONNECTION_FAILED") throw oauthError(error.code);
      const latest = await this.secrets.read(id);
      if (latest?.oauthToken?.access_token === saved.oauthToken.access_token) await this.secrets.write(id, { oauthToken: null });
      this._changed({ id, status: "signedOut" }); throw oauthError();
    }
  }
  async cancelServer(id) {
    const matching=[...this.sessions.values()].filter(session=>session.id===id);
    for(const session of matching)this.cancel(session.signInId);
    await Promise.allSettled(matching.filter(session=>session.completion).map(session=>session.completion));
    if(this.refreshing.has(id))await this.refreshing.get(id).catch(()=>{});
  }
  async close() { this.closed = true; for (const id of this.sessions.keys()) this.cancel(id); await this.callback.close(); await Promise.allSettled([...this.refreshing.values(),...[...this.sessions.values()].filter(session=>session.completion).map(session=>session.completion)]); }
}
module.exports = { McpOAuthClient, SESSION_LIFETIME_MS };
