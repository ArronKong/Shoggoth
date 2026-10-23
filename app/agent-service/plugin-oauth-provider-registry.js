"use strict";

const { discoverAuthorizationServerMetadata, refreshAuthorization } = require("@modelcontextprotocol/client");
const { endpointOf } = require("./plugin-mcp-client");
const { serviceError } = require("./security");
const { bindOfficialPrincipal } = require("./plugin-reserved-official-endpoints");
const { AUTH_TEST: SLACK_AUTH_TEST, LOOPBACK_CALLBACK: SLACK_LOOPBACK_CALLBACK,
  AUTHORIZATION_METADATA: SLACK_AUTHORIZATION_METADATA,
  RESOURCE_METADATA: SLACK_RESOURCE_METADATA,
  METADATA_URLS: SLACK_METADATA_URLS,
  validSlackProtocolProvider,
  normalizedSlackTokenResponse } = require("./plugin-slack-oauth");
const { TOKEN: ZOOM_TOKEN, RESOURCE_METADATA: ZOOM_RESOURCE_METADATA,
  ROOT_RESOURCE_METADATA: ZOOM_ROOT_RESOURCE_METADATA,
  AUTHORIZATION_METADATA: ZOOM_AUTHORIZATION_METADATA,
  OIDC_METADATA: ZOOM_OIDC_METADATA, validZoomProtocolProvider,
  validZoomClientSecret } = require("./plugin-zoom-oauth");
const { TOKEN: DROPBOX_TOKEN, SERVER: DROPBOX_SERVER, IDENTITY: DROPBOX_IDENTITY,
  RESOURCE_METADATA: DROPBOX_RESOURCE_METADATA,
  ROOT_RESOURCE_METADATA: DROPBOX_ROOT_RESOURCE_METADATA,
  AUTHORIZATION_METADATA: DROPBOX_AUTHORIZATION_METADATA,
  validDropboxProtocolProvider, validDropboxClientSecret } = require("./plugin-dropbox-oauth");
const { RESOURCE_METADATA: HIGGSFIELD_RESOURCE_METADATA,
  AUTH_METADATA: HIGGSFIELD_AUTH_METADATA, OIDC_METADATA: HIGGSFIELD_OIDC_METADATA,
  SECONDARY_ISSUER: HIGGSFIELD_SECONDARY_ISSUER,
  REGISTRATION_ENDPOINT: HIGGSFIELD_REGISTRATION_ENDPOINT,
  USERINFO_ENDPOINT: HIGGSFIELD_USERINFO_ENDPOINT, SCOPES: HIGGSFIELD_SCOPES,
  validHiggsfieldProtocolProvider } = require("./plugin-higgsfield-official-oauth");

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SCOPE = /^[\x21\x23-\x5B\x5D-\x7E]{1,256}$/u;
const LOOPBACK_REDIRECT = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/oauth\/callback$/u;
const fail = (code = "PLUGIN_OAUTH_PROVIDER_UNSUPPORTED") => {
  throw serviceError(code, "HTTP OAuth 服务未受信、配置不完整或认证请求无效");
};
const normalizedIssuer = value => {
  try { return new URL(value).href; }
  catch { fail("CONNECTION_AUTH_REQUIRED"); }
};

// Constructed by Service code only. Package descriptors and browser requests
// cannot register a provider, choose scopes, supply a client ID, or replace its
// principal verifier. An empty registry intentionally supports no HTTP login.
class PluginOAuthProviderRegistry {
  #providers = new Map();
  #fetch;
  #secrets;

  constructor({ providers = [], fetchImpl = globalThis.fetch,
    registeredSlackClientId = null, registeredZoomClientId = null,
    registeredDropboxClientId = null, registeredHiggsfieldClientId = null,
    secretStore = null } = {}) {
    if (!Array.isArray(providers) || providers.length > 32 || typeof fetchImpl !== "function") {
      throw new TypeError("Trusted OAuth provider registry configuration required");
    }
    this.#fetch = fetchImpl;
    this.#secrets = secretStore;
    for (const value of providers) {
      if (value?.protocol === "slack-mcp") {
        if (!validSlackProtocolProvider(value, registeredSlackClientId)) fail();
      } else if (value?.protocol === "zoom-mcp") {
        if (!validZoomProtocolProvider(value, registeredZoomClientId)) fail();
      } else if (value?.protocol === "dropbox-mcp") {
        if (!validDropboxProtocolProvider(value, registeredDropboxClientId)) fail();
      } else if (value?.protocol === "higgsfield-mcp") {
        if (!validHiggsfieldProtocolProvider(value, registeredHiggsfieldClientId)) fail();
      } else if (value?.protocol != null) fail();
      const url = raw => {
        const parsed = endpointOf(raw, value.allowLoopback === true);
        if (parsed.search) fail();
        return parsed.href;
      };
      // RFC 8707 resource indicators are strings. A pathless origin is a
      // distinct indicator from its URL-serialized root path ("/"). Keep the
      // provider's exact pathless spelling when it is already canonical.
      const audience = raw => {
        const parsed = endpointOf(raw, value.allowLoopback === true);
        if (parsed.search) fail();
        return raw === parsed.origin ? raw : parsed.href;
      };
      if (!value || typeof value.id !== "string" || !ID.test(value.id) || typeof value.name !== "string" || !value.name
        || Buffer.byteLength(value.name) > 256 || typeof value.clientId !== "string"
        || !value.clientId || value.clientId.length > 512 || /[\x00-\x20\x7f]/u.test(value.clientId)
        || !Array.isArray(value.scopes) || !value.scopes.length || value.scopes.length > 32
        || value.scopes.some(scope => typeof scope !== "string" || !SCOPE.test(scope))
        || new Set(value.scopes).size !== value.scopes.length
        || typeof value.verifyPrincipal !== "function"
        || (value.assertCurrent != null && typeof value.assertCurrent !== "function")
        || !Array.isArray(value.metadataUrls) || value.metadataUrls.length > 16
        || !Array.isArray(value.identityUrls || []) || (value.identityUrls || []).length > 8) fail();
      let redirectUrl = null;
      if (value.redirectUrl !== undefined && value.redirectUrl !== null) {
        const callbackPattern = value.protocol === "slack-mcp"
          ? SLACK_LOOPBACK_CALLBACK : LOOPBACK_REDIRECT;
        const match = typeof value.redirectUrl === "string" && callbackPattern.exec(value.redirectUrl);
        if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535
          || new URL(value.redirectUrl).href !== value.redirectUrl) fail();
        redirectUrl = value.redirectUrl;
      }
      const provider = Object.freeze({ id: value.id, name: value.name,
        serverUrl: url(value.serverUrl), issuer: url(value.issuer),
        audience: value.audience ? audience(value.audience) : url(value.serverUrl),
        authorizationEndpoint: url(value.authorizationEndpoint), tokenEndpoint: url(value.tokenEndpoint),
        clientId: value.clientId, scopes: Object.freeze([...value.scopes]),
        metadataUrls: Object.freeze(value.metadataUrls.map(url)),
        identityUrls: Object.freeze((value.identityUrls || []).map(url)),
        verifyPrincipal: value.verifyPrincipal, assertCurrent: value.assertCurrent ?? null,
        allowLoopback: value.allowLoopback === true,
        redirectUrl, protocol: value.protocol ?? null,
        clientSecretRef: ["zoom-mcp", "dropbox-mcp"].includes(value.protocol)
          ? value.clientSecretRef : null });
      if (this.#providers.has(provider.serverUrl)) fail();
      this.#providers.set(provider.serverUrl, provider);
    }
  }

  forEndpoint(endpoint) {
    const provider = this.#providers.get(endpoint);
    if (!provider) fail();
    if (provider.assertCurrent && provider.assertCurrent() !== true) fail("CONNECTION_AUTH_REQUIRED");
    return provider;
  }

  clientSecretRevision(endpoint) {
    const provider = this.forEndpoint(endpoint);
    if (!["zoom-mcp", "dropbox-mcp"].includes(provider.protocol)) return null;
    if (!this.#secrets || typeof this.#secrets.listMetadata !== "function"
      || typeof this.#secrets.getCredentialFingerprint !== "function"
      || !this.#secrets.listMetadata().some(item => item.credentialRef === provider.clientSecretRef
        && item.kind === (provider.protocol === "zoom-mcp"
          ? "zoom-oauth-client" : "dropbox-oauth-client"))) fail("CONNECTION_AUTH_REQUIRED");
    const fingerprint = this.#secrets.getCredentialFingerprint(provider.clientSecretRef);
    if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(fingerprint)) {
      fail("CONNECTION_AUTH_REQUIRED");
    }
    return fingerprint;
  }

  async clientSecretFor(endpoint) {
    const provider = this.forEndpoint(endpoint);
    if (!["zoom-mcp", "dropbox-mcp"].includes(provider.protocol)
      || typeof this.#secrets?.get !== "function") {
      fail("CONNECTION_AUTH_REQUIRED");
    }
    const revision = this.clientSecretRevision(endpoint);
    const secret = await this.#secrets.get(provider.clientSecretRef);
    if (this.clientSecretRevision(endpoint) !== revision
      || !(provider.protocol === "zoom-mcp"
        ? validZoomClientSecret(secret) : validDropboxClientSecret(secret))) {
      fail("CONNECTION_AUTH_REQUIRED");
    }
    return secret;
  }

  fetchFor(endpoint) {
    const provider = this.forEndpoint(endpoint);
    return async (input, init = {}) => {
      if (provider.assertCurrent && provider.assertCurrent() !== true) fail("CONNECTION_AUTH_REQUIRED");
      const request = new Request(input, init);
      const url = new URL(request.url);
      const isToken = url.href === provider.tokenEndpoint && request.method === "POST";
      const isMetadata = provider.metadataUrls.includes(url.href);
      const isSlackIdentity = provider.protocol === "slack-mcp"
        && url.href === SLACK_AUTH_TEST && request.method === "POST";
      const isDropboxIdentity = provider.protocol === "dropbox-mcp"
        && url.href === DROPBOX_IDENTITY && request.method === "POST";
      const isDropboxProbe = provider.protocol === "dropbox-mcp"
        && url.href === DROPBOX_SERVER && request.method === "POST";
      const isRead = request.method === "GET" && (isMetadata || url.href === provider.serverUrl
        || (!["slack-mcp", "dropbox-mcp"].includes(provider.protocol)
          && provider.identityUrls.includes(url.href)));
      if ((!isToken && !isRead && !isSlackIdentity && !isDropboxIdentity && !isDropboxProbe)
        || url.username || url.password || url.hash) fail("CONNECTION_AUTH_REQUIRED");
      if (isSlackIdentity && (request.headers.get("accept") !== "application/json"
        || request.headers.get("content-type") !== "application/x-www-form-urlencoded"
        || !/^Bearer [A-Za-z0-9\-._~+/]+=*$/u.test(request.headers.get("authorization") || "")
        || [...request.headers.keys()].some(key => !["accept", "authorization", "content-type"].includes(key))
        || await request.clone().text() !== "")) fail("CONNECTION_AUTH_REQUIRED");
      if (provider.protocol === "slack-mcp" && isToken) {
        const params = new URLSearchParams(await request.clone().text());
        if (params.has("client_secret") || params.get("client_id") !== provider.clientId
          || params.get("resource") !== provider.audience
          || (params.get("grant_type") === "authorization_code"
            ? !params.get("code_verifier") || !params.get("code")
              || params.get("redirect_uri") !== provider.redirectUrl
            : params.get("grant_type") !== "refresh_token"
              || !params.get("refresh_token"))) fail("CONNECTION_AUTH_REQUIRED");
      }
      if (provider.protocol === "zoom-mcp" && isToken) {
        const secret = await this.clientSecretFor(provider.serverUrl);
        const expected = `Basic ${Buffer.from(`${provider.clientId}:${secret}`, "utf8").toString("base64")}`;
        const params = new URLSearchParams(await request.clone().text());
        if (url.href !== ZOOM_TOKEN || request.headers.get("authorization") !== expected
          || params.has("client_secret") || params.has("client_id")) fail("CONNECTION_AUTH_REQUIRED");
      }
      if (provider.protocol === "dropbox-mcp" && isToken) {
        const secret = await this.clientSecretFor(provider.serverUrl);
        const expected = `Basic ${Buffer.from(`${provider.clientId}:${secret}`, "utf8").toString("base64")}`;
        const params = new URLSearchParams(await request.clone().text());
        if (url.href !== DROPBOX_TOKEN || request.headers.get("authorization") !== expected
          || params.has("client_secret") || params.has("client_id")
          || (params.has("resource") && params.get("resource") !== provider.audience)
          || (params.get("grant_type") === "authorization_code"
            ? !params.get("code_verifier") || !params.get("code")
              || params.get("redirect_uri") !== provider.redirectUrl
            : params.get("grant_type") !== "refresh_token"
              || !params.get("refresh_token"))) fail("CONNECTION_AUTH_REQUIRED");
      }
      if (provider.protocol === "higgsfield-mcp" && isToken) {
        const params = new URLSearchParams(await request.clone().text());
        if (request.headers.has("authorization") || params.has("client_secret")
          || params.get("client_id") !== provider.clientId
          || params.get("resource") !== provider.audience
          || (params.get("grant_type") === "authorization_code"
            ? !params.get("code_verifier") || !params.get("code")
              || params.get("redirect_uri") !== provider.redirectUrl
            : params.get("grant_type") !== "refresh_token"
              || !params.get("refresh_token"))) fail("CONNECTION_AUTH_REQUIRED");
      }
      if (provider.protocol === "higgsfield-mcp" && url.href === HIGGSFIELD_USERINFO_ENDPOINT) {
        if (request.method !== "GET" || request.headers.get("accept") !== "application/json"
          || !/^Bearer [A-Za-z0-9\-._~+/]+=*$/u.test(request.headers.get("authorization") || "")
          || [...request.headers.keys()].some(key => !["accept", "authorization"].includes(key))
          || await request.clone().text() !== "") fail("CONNECTION_AUTH_REQUIRED");
      }
      if (isDropboxIdentity) {
        if (request.headers.get("accept") !== "application/json"
          || !/^Bearer [A-Za-z0-9\-._~+/]+=*$/u.test(request.headers.get("authorization") || "")
          || [...request.headers.keys()].some(key => !["accept", "authorization"].includes(key))
          || await request.clone().text() !== "") fail("CONNECTION_AUTH_REQUIRED");
      }
      if (isDropboxProbe) {
        let message;
        try { message = JSON.parse(await request.clone().text()); } catch { fail("CONNECTION_AUTH_REQUIRED"); }
        if (!/^(?:Bearer [A-Za-z0-9\-._~+/]+=*)$/u.test(request.headers.get("authorization") || "")
          || !["server/discover", "initialize", "notifications/initialized"].includes(message?.method)) {
          fail("CONNECTION_AUTH_REQUIRED");
        }
      }
      if (provider.assertCurrent && provider.assertCurrent() !== true) fail("CONNECTION_AUTH_REQUIRED");
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
      if (provider.protocol === "slack-mcp" && isToken && response.ok) {
        return Response.json(normalizedSlackTokenResponse(body, provider.scopes));
      }
      if (isMetadata && response.ok) {
        let metadata;
        try { metadata = JSON.parse(body.toString("utf8")); } catch { fail("CONNECTION_AUTH_REQUIRED"); }
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
          fail("CONNECTION_AUTH_REQUIRED");
        }
        if (metadata.issuer !== undefined && (normalizedIssuer(metadata.issuer) !== provider.issuer
          || normalizedIssuer(metadata.authorization_endpoint) !== provider.authorizationEndpoint
          || normalizedIssuer(metadata.token_endpoint) !== provider.tokenEndpoint)) fail("CONNECTION_AUTH_REQUIRED");
        if (metadata.resource !== undefined && (metadata.resource !== provider.audience
          || !Array.isArray(metadata.authorization_servers) || !metadata.authorization_servers.length
          || (provider.protocol !== "higgsfield-mcp"
            && metadata.authorization_servers.some(issuer => normalizedIssuer(issuer) !== provider.issuer)))) {
          fail("CONNECTION_AUTH_REQUIRED");
        }
        if (provider.protocol === "higgsfield-mcp") {
          if (url.href === HIGGSFIELD_RESOURCE_METADATA) {
            if (metadata.resource !== provider.audience
              || metadata.authorization_servers?.length !== 2
              || normalizedIssuer(metadata.authorization_servers[0]) !== provider.issuer
              || normalizedIssuer(metadata.authorization_servers[1]) !== HIGGSFIELD_SECONDARY_ISSUER
              || !Array.isArray(metadata.scopes_supported)
              || HIGGSFIELD_SCOPES.some(scope => !metadata.scopes_supported.includes(scope))) {
              fail("CONNECTION_AUTH_REQUIRED");
            }
          } else if (url.href === HIGGSFIELD_AUTH_METADATA || url.href === HIGGSFIELD_OIDC_METADATA) {
            if (normalizedIssuer(metadata.issuer) !== provider.issuer
              || normalizedIssuer(metadata.authorization_endpoint) !== provider.authorizationEndpoint
              || normalizedIssuer(metadata.token_endpoint) !== provider.tokenEndpoint
              || !metadata.code_challenge_methods_supported?.includes("S256")
              || !metadata.token_endpoint_auth_methods_supported?.includes("none")
              || (url.href === HIGGSFIELD_AUTH_METADATA
                ? metadata.registration_endpoint !== HIGGSFIELD_REGISTRATION_ENDPOINT
                : metadata.userinfo_endpoint !== HIGGSFIELD_USERINFO_ENDPOINT)) {
              fail("CONNECTION_AUTH_REQUIRED");
            }
          } else fail("CONNECTION_AUTH_REQUIRED");
        }
        if (provider.protocol === "slack-mcp") {
          if ([SLACK_METADATA_URLS[0], SLACK_RESOURCE_METADATA].includes(url.href)) {
            if (metadata.resource !== provider.audience
              || !Array.isArray(metadata.authorization_servers)
              || metadata.authorization_servers.length !== 1
              || normalizedIssuer(metadata.authorization_servers[0]) !== provider.issuer) {
              fail("CONNECTION_AUTH_REQUIRED");
            }
          } else if (url.href === SLACK_AUTHORIZATION_METADATA
            && (normalizedIssuer(metadata.issuer) !== provider.issuer
              || normalizedIssuer(metadata.authorization_endpoint) !== provider.authorizationEndpoint
              || normalizedIssuer(metadata.token_endpoint) !== provider.tokenEndpoint
              || !metadata.code_challenge_methods_supported?.includes("S256"))) {
            fail("CONNECTION_AUTH_REQUIRED");
          }
        }
        if (provider.protocol === "zoom-mcp") {
          if ([ZOOM_RESOURCE_METADATA, ZOOM_ROOT_RESOURCE_METADATA].includes(url.href)) {
            if (metadata.resource !== provider.audience
              || !Array.isArray(metadata.authorization_servers)
              || metadata.authorization_servers.length !== 1
              || normalizedIssuer(metadata.authorization_servers[0]) !== provider.issuer) {
              fail("CONNECTION_AUTH_REQUIRED");
            }
          } else if ([ZOOM_AUTHORIZATION_METADATA, ZOOM_OIDC_METADATA].includes(url.href)
            && (normalizedIssuer(metadata.issuer) !== provider.issuer
              || normalizedIssuer(metadata.authorization_endpoint) !== provider.authorizationEndpoint
              || normalizedIssuer(metadata.token_endpoint) !== provider.tokenEndpoint
              || !metadata.token_endpoint_auth_methods_supported?.includes("client_secret_basic")
              || !metadata.code_challenge_methods_supported?.includes("S256"))) {
            fail("CONNECTION_AUTH_REQUIRED");
          }
        }
        if (provider.protocol === "dropbox-mcp") {
          if ([DROPBOX_RESOURCE_METADATA, DROPBOX_ROOT_RESOURCE_METADATA].includes(url.href)) {
            if (metadata.resource !== provider.audience
              || !Array.isArray(metadata.authorization_servers)
              || metadata.authorization_servers.length !== 1
              || normalizedIssuer(metadata.authorization_servers[0]) !== provider.issuer) {
              fail("CONNECTION_AUTH_REQUIRED");
            }
          } else if (url.href === DROPBOX_AUTHORIZATION_METADATA
            && (normalizedIssuer(metadata.issuer) !== provider.issuer
              || normalizedIssuer(metadata.authorization_endpoint) !== provider.authorizationEndpoint
              || normalizedIssuer(metadata.token_endpoint) !== provider.tokenEndpoint
              || !metadata.token_endpoint_auth_methods_supported?.includes("client_secret_basic")
              || !metadata.code_challenge_methods_supported?.includes("S256"))) {
            fail("CONNECTION_AUTH_REQUIRED");
          }
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
    if (provider.protocol === "dropbox-mcp") {
      if (url.searchParams.getAll("token_access_type").length > 1
        || (url.searchParams.has("token_access_type")
          && url.searchParams.get("token_access_type") !== "offline")) fail("CONNECTION_AUTH_REQUIRED");
      url.searchParams.set("token_access_type", "offline");
    }
    return url.href;
  }

  #context(input) {
    const provider = this.forEndpoint(input.endpointIdentity);
    if (normalizedIssuer(input.issuer) !== provider.issuer || input.audience !== provider.audience
      || !Array.isArray(input.scopes) || !input.scopes.length
      || input.scopes.some(scope => !provider.scopes.includes(scope))
      || (provider.protocol === "slack-mcp" && (input.scopes.length !== provider.scopes.length
        || new Set(input.scopes).size !== provider.scopes.length))) {
      fail("CONNECTION_AUTH_REQUIRED");
    }
    return provider;
  }

  async verifyPrincipal(input) {
    const provider = this.#context(input);
    const principal = await provider.verifyPrincipal({ ...input,
      scopes: Object.freeze([...input.scopes]), fetchImpl: this.fetchFor(provider.serverUrl) });
    return bindOfficialPrincipal(provider, principal);
  }

  async refreshTokens(input) {
    const provider = this.#context(input);
    const fetchFn = this.fetchFor(provider.serverUrl);
    const metadata = await discoverAuthorizationServerMetadata(provider.issuer, { fetchFn });
    const confidential = ["zoom-mcp", "dropbox-mcp"].includes(provider.protocol) ? {
      client_secret: await this.clientSecretFor(provider.serverUrl),
      token_endpoint_auth_method: "client_secret_basic", issuer: provider.issuer } : {};
    return refreshAuthorization(provider.issuer, { metadata,
      clientInformation: { client_id: provider.clientId, ...confidential }, refreshToken: input.refreshToken,
      resource: provider.audience, fetchFn });
  }
}

module.exports = { PluginOAuthProviderRegistry };
