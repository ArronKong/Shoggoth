"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { configureDropboxRegistration, loadDropboxRegistration } =
  require("../app/agent-service/plugin-dropbox-registration");
const { PluginOAuthProviderRegistry } = require("../app/agent-service/plugin-oauth-provider-registry");
const { PluginOAuthSessionManager } = require("../app/agent-service/plugin-oauth-session");
const { assertReservedOfficialEndpoint } = require("../app/agent-service/plugin-reserved-official-endpoints");
const { SERVER, ISSUER, AUTHORIZATION, TOKEN, IDENTITY, METADATA_URLS, SCOPES,
  validDropboxProtocolProvider } =
  require("../app/agent-service/plugin-dropbox-oauth");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-dropbox-app-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), trustedRoot: root });
  fs.mkdirSync(paths.pluginsDir, { recursive: true, mode: 0o700 });
  const clientId = "ownDropboxAppKey123";
  const clientSecret = "private-dropbox-app-secret";
  const stored = new Map();
  const secretStore = { put: async (ref, secret, metadata) => { stored.set(ref, { secret, metadata }); },
    delete: async ref => { stored.delete(ref); },
    get: async ref => stored.get(ref)?.secret,
    listMetadata: () => [...stored].map(([credentialRef, value]) => ({ credentialRef,
      kind: value.metadata.kind })),
    getCredentialFingerprint: ref => stored.has(ref)
      ? crypto.createHash("sha256").update(stored.get(ref).secret).digest("hex") : null };
  const state = { requests: [], probes: 0, identity: 0, refreshes: 0,
    codes: new Map(), exchanges: 0 };
  const fetchImpl = async (input, init) => {
    const request = new Request(input, init);
    state.requests.push(`${request.method} ${request.url}`);
    assert([SERVER, TOKEN, IDENTITY, ...METADATA_URLS].includes(request.url));
    if (METADATA_URLS.slice(0, 2).includes(request.url)) {
      return Response.json({ resource: SERVER,
        authorization_servers: [ISSUER.slice(0, -1)], scopes_supported: SCOPES });
    }
    if (request.url === METADATA_URLS[2]) {
      return Response.json({ issuer: ISSUER.slice(0, -1), authorization_endpoint: AUTHORIZATION,
        token_endpoint: TOKEN, response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
        code_challenge_methods_supported: ["S256"] });
    }
    if (request.url === IDENTITY) {
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get("authorization"), "Bearer dropbox-fixture-access");
      state.identity += 1;
      return Response.json({ account_id: "dbid:AAH4f99T0taONIb-OurWxbNQ6ywGRopQngc",
        disabled: false });
    }
    if (request.url === TOKEN) {
      assert.equal(request.headers.get("authorization"), `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`);
      const form = new URLSearchParams(await request.text());
      if (form.get("grant_type") === "authorization_code") {
        const pending = state.codes.get(form.get("code"));
        assert(pending);
        assert.equal(form.get("redirect_uri"), pending.redirect);
        assert.equal(crypto.createHash("sha256").update(form.get("code_verifier") || "")
          .digest("base64url"), pending.challenge);
        state.codes.delete(form.get("code"));
        state.exchanges += 1;
        return Response.json({ access_token: "dropbox-fixture-access",
          refresh_token: "dropbox-fixture-refresh", token_type: "Bearer",
          expires_in: 3600, scope: SCOPES.join(" ") });
      }
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.equal(form.get("refresh_token"), "dropbox-fixture-refresh");
      state.refreshes += 1;
      return Response.json({ access_token: "dropbox-fixture-new-access",
        refresh_token: "dropbox-fixture-refresh", token_type: "Bearer",
        expires_in: 3600, scope: SCOPES.join(" ") });
    }
    if (request.url === SERVER && request.method === "GET") {
      return new Response(null, { status: 405 });
    }
    assert.equal(request.headers.get("authorization"), "Bearer dropbox-fixture-access");
    const rpc = JSON.parse(await request.text());
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (rpc.method === "server/discover") return Response.json({ jsonrpc: "2.0", id: rpc.id,
      error: { code: -32601, message: "Method not found" } });
    assert.equal(rpc.method, "initialize");
    state.probes += 1;
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result: {
      protocolVersion: "2025-11-25", capabilities: { tools: {} },
      serverInfo: { name: "dropbox-fixture", version: "1" } } });
  };
  try {
    assert.equal(loadDropboxRegistration(paths), null);
    assert.deepEqual(await configureDropboxRegistration(paths, secretStore,
      { clientId, clientSecret, redirectPort: 32777 }),
    { configured: true, restartRequired: true, provider: "dropbox" });
    const registration = loadDropboxRegistration(paths);
    assert.equal(validDropboxProtocolProvider(registration.provider, clientId), true);
    assert.equal(validDropboxProtocolProvider({ ...registration.provider,
      serverUrl: "https://attacker.example/mcp" }, clientId), false);
    assert.equal(registration.assertCurrent(), true);
    assert.equal(fs.readFileSync(path.join(paths.pluginsDir,
      "dropbox-client-registration.json"), "utf8").includes(clientSecret), false);
    assert.throws(() => new PluginOAuthProviderRegistry({ providers: [registration.provider],
      registeredDropboxClientId: "someoneElse", secretStore, fetchImpl }),
    { code: "PLUGIN_OAUTH_PROVIDER_UNSUPPORTED" });
    const providers = new PluginOAuthProviderRegistry({ providers: [registration.provider],
      registeredDropboxClientId: clientId, secretStore, fetchImpl });
    const oauth = new PluginOAuthSessionManager({ fetchImpl: providers.fetchFor(SERVER) });
    const started = await oauth.start({ connectionId: "dropbox-fixture-start",
      serverUrl: SERVER, redirectUrl: registration.provider.redirectUrl,
      clientId, clientSecret, scope: SCOPES.join(" "), expectedIssuer: ISSUER,
      allowLoopback: true });
    const authorized = new URL(providers.assertAuthorizationUrl(SERVER, started.authorizationUrl,
      registration.provider.redirectUrl));
    assert.equal(authorized.searchParams.get("token_access_type"), "offline");
    state.codes.set("dropbox-fixture-code", { redirect: registration.provider.redirectUrl,
      challenge: authorized.searchParams.get("code_challenge") });
    await oauth.finish({ connectionId: "dropbox-fixture-start",
      callbackUrl: `${registration.provider.redirectUrl}?state=${encodeURIComponent(
        authorized.searchParams.get("state"))}&code=dropbox-fixture-code` });
    let consumed;
    await oauth.consumeTokens({ connectionId: "dropbox-fixture-start", commit: async (tokens, metadata) => {
      consumed = { tokens, metadata };
    } });
    assert.equal(consumed.tokens.refresh_token, "dropbox-fixture-refresh");
    assert.equal(new URL(consumed.metadata.issuer).href, ISSUER);
    assert.equal(state.exchanges, 1);
    const baseUrl = new URL(AUTHORIZATION);
    for (const [key, value] of Object.entries({ client_id: clientId,
      redirect_uri: registration.provider.redirectUrl, scope: SCOPES.join(" "),
      resource: SERVER, response_type: "code", code_challenge_method: "S256",
      state: "state123", code_challenge: "challenge123" })) baseUrl.searchParams.set(key, value);
    const authorizedUrl = providers.assertAuthorizationUrl(SERVER, baseUrl.href,
      registration.provider.redirectUrl);
    assert.equal(new URL(authorizedUrl).searchParams.get("token_access_type"), "offline");
    await providers.fetchFor(SERVER)(METADATA_URLS[0]);
    await providers.fetchFor(SERVER)(METADATA_URLS[2]);
    const principal = await providers.verifyPrincipal({ endpointIdentity: SERVER,
      issuer: ISSUER, audience: SERVER, scopes: SCOPES,
      accessToken: "dropbox-fixture-access" });
    assert.match(principal, /^oauth:dropbox:[a-f0-9]{64}:[a-f0-9]{64}$/u);
    assert.equal(state.identity, 1);
    assert.equal(state.probes, 1);
    const refreshed = await providers.refreshTokens({ endpointIdentity: SERVER,
      issuer: ISSUER, audience: SERVER, scopes: SCOPES,
      refreshToken: "dropbox-fixture-refresh" });
    assert.equal(refreshed.access_token, "dropbox-fixture-new-access");
    assert.equal(state.refreshes, 1);
    assert.equal(assertReservedOfficialEndpoint({ sourceIdentity: "bundled:dropbox",
      componentName: "dropbox", serverUrl: SERVER, oauthResource: null,
      provider: providers.forEndpoint(SERVER) }), "dropbox");
    assert.throws(() => assertReservedOfficialEndpoint({ sourceIdentity: "local:spoof",
      componentName: "dropbox", serverUrl: SERVER, oauthResource: null }),
    { code: "CONNECTION_IDENTITY_CHANGED" });
    await assert.rejects(providers.fetchFor(SERVER)("https://attacker.example/"),
      { code: "CONNECTION_AUTH_REQUIRED" });
    console.log("Dropbox own-app registration + OAuth metadata/identity/MCP probe/refresh: PASS");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
