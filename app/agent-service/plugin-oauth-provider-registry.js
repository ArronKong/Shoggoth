"use strict";

const { discoverAuthorizationServerMetadata, refreshAuthorization } = require("@modelcontextprotocol/client");
const { endpointOf } = require("./plugin-mcp-client");
const { serviceError } = require("./security");

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SCOPE = /^[\x21\x23-\x5B\x5D-\x7E]{1,256}$/u;
const fail = (code = "PLUGIN_OAUTH_PROVIDER_UNSUPPORTED") => {
  throw serviceError(code, "HTTP OAuth 服务未受信、配置不完整或认证请求无效");
};
const normalizedIssuer = value => new URL(value).href;

// Constructed by Service code only. Package descriptors and browser requests
// cannot register a provider, choose scopes, supply a client ID, or replace its
// principal verifier. An empty registry intentionally supports no HTTP login.
class PluginOAuthProviderRegistry {
  #providers = new Map();
  #fetch;

  constructor({ providers = [], fetchImpl = globalThis.fetch } = {}) {
    if (!Array.isArray(providers) || providers.length > 32 || typeof fetchImpl !== "function") {
      throw new TypeError("Trusted OAuth provider registry configuration required");
    }
    this.#fetch = fetchImpl;
    for (const value of providers) {
      const url = raw => {
        const parsed = endpointOf(raw, value.allowLoopback === true);
        if (parsed.search) fail();
        return parsed.href;
      };
      if (!value || typeof value.id !== "string" || !ID.test(value.id) || typeof value.name !== "string" || !value.name
        || Buffer.byteLength(value.name) > 256 || typeof value.clientId !== "string"
        || !value.clientId || value.clientId.length > 512 || /[\x00-\x20\x7f]/u.test(value.clientId)
        || !Array.isArray(value.scopes) || !value.scopes.length || value.scopes.length > 32
        || value.scopes.some(scope => typeof scope !== "string" || !SCOPE.test(scope))
        || new Set(value.scopes).size !== value.scopes.length
        || typeof value.verifyPrincipal !== "function"
        || !Array.isArray(value.metadataUrls) || value.metadataUrls.length > 16
        || !Array.isArray(value.identityUrls || []) || (value.identityUrls || []).length > 8) fail();
      const provider = Object.freeze({ id: value.id, name: value.name,
        serverUrl: url(value.serverUrl), issuer: url(value.issuer), audience: url(value.audience || value.serverUrl),
        authorizationEndpoint: url(value.authorizationEndpoint), tokenEndpoint: url(value.tokenEndpoint),
        clientId: value.clientId, scopes: Object.freeze([...value.scopes]),
        metadataUrls: Object.freeze(value.metadataUrls.map(url)),
        identityUrls: Object.freeze((value.identityUrls || []).map(url)),
        verifyPrincipal: value.verifyPrincipal, allowLoopback: value.allowLoopback === true });
      if (this.#providers.has(provider.serverUrl)) fail();
      this.#providers.set(provider.serverUrl, provider);
    }
  }

  forEndpoint(endpoint) {
    const provider = this.#providers.get(endpoint);
    if (!provider) fail();
    return provider;
  }

  fetchFor(endpoint) {
    const provider = this.forEndpoint(endpoint);
    return async (input, init = {}) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const isToken = url.href === provider.tokenEndpoint && request.method === "POST";
      const isMetadata = provider.metadataUrls.includes(url.href);
      const isRead = request.method === "GET" && (isMetadata || url.href === provider.serverUrl
        || provider.identityUrls.includes(url.href));
      if ((!isToken && !isRead) || url.username || url.password || url.hash) fail("CONNECTION_AUTH_REQUIRED");
      const response = await this.#fetch(request, { redirect: "manual",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]) });
      if (!(response instanceof Response) || (response.status >= 300 && response.status < 400)) {
        void response?.body?.cancel().catch(() => {}); fail("CONNECTION_AUTH_REQUIRED");
      }
      const reader = response.body?.getReader();
      let size = 0;
      const parts = [];
      try {
        if (reader) while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 64 * 1024) fail("CONNECTION_AUTH_REQUIRED");
          parts.push(Buffer.from(chunk.value));
        }
      } catch (error) { await reader?.cancel().catch(() => {}); throw error; }
      const body = Buffer.concat(parts);
      if (isMetadata && response.ok) {
        let metadata;
        try { metadata = JSON.parse(body.toString("utf8")); } catch { fail("CONNECTION_AUTH_REQUIRED"); }
        if (metadata.issuer !== undefined && (normalizedIssuer(metadata.issuer) !== provider.issuer
          || new URL(metadata.authorization_endpoint).href !== provider.authorizationEndpoint
          || new URL(metadata.token_endpoint).href !== provider.tokenEndpoint)) fail("CONNECTION_AUTH_REQUIRED");
        if (metadata.resource !== undefined && (metadata.resource !== provider.audience
          || !Array.isArray(metadata.authorization_servers) || !metadata.authorization_servers.length
          || metadata.authorization_servers.some(issuer => normalizedIssuer(issuer) !== provider.issuer))) {
          fail("CONNECTION_AUTH_REQUIRED");
        }
      }
      return new Response(body.length ? body : null, { status: response.status, headers: response.headers });
    };
  }

  assertAuthorizationUrl(endpoint, value, redirectUrl) {
    const provider = this.forEndpoint(endpoint);
    let url;
    try { url = new URL(value); } catch { fail("CONNECTION_AUTH_REQUIRED"); }
    const destination = new URL(url);
    destination.search = "";
    const single = key => url.searchParams.getAll(key).length === 1 && url.searchParams.get(key);
    if (destination.href !== provider.authorizationEndpoint || url.hash
      || single("client_id") !== provider.clientId || single("redirect_uri") !== redirectUrl
      || single("scope") !== provider.scopes.join(" ") || single("resource") !== provider.audience
      || single("response_type") !== "code" || single("code_challenge_method") !== "S256"
      || !single("state") || !single("code_challenge")) fail("CONNECTION_AUTH_REQUIRED");
    return url.href;
  }

  #context(input) {
    const provider = this.forEndpoint(input.endpointIdentity);
    if (normalizedIssuer(input.issuer) !== provider.issuer || input.audience !== provider.audience
      || !Array.isArray(input.scopes) || !input.scopes.length
      || input.scopes.some(scope => !provider.scopes.includes(scope))) fail("CONNECTION_AUTH_REQUIRED");
    return provider;
  }

  async verifyPrincipal(input) {
    const provider = this.#context(input);
    return provider.verifyPrincipal({ ...input, scopes: Object.freeze([...input.scopes]),
      fetchImpl: this.fetchFor(provider.serverUrl) });
  }

  async refreshTokens(input) {
    const provider = this.#context(input);
    const fetchFn = this.fetchFor(provider.serverUrl);
    const metadata = await discoverAuthorizationServerMetadata(provider.issuer, { fetchFn });
    return refreshAuthorization(provider.issuer, { metadata,
      clientInformation: { client_id: provider.clientId }, refreshToken: input.refreshToken,
      resource: provider.audience, fetchFn });
  }
}

module.exports = { PluginOAuthProviderRegistry };
