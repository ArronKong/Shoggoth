#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { PluginOAuthProviderRegistry } = require("../app/agent-service/plugin-oauth-provider-registry");
const { PluginOAuthSessionManager } = require("../app/agent-service/plugin-oauth-session");
const { loadPluginOAuthProviders } = require("../app/agent-service/plugin-oauth-config");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { BundledPluginCatalog, bundledRoot } = require("../app/core/bundled-plugin-catalog");
const slack = require("../app/agent-service/plugin-slack-oauth");

const CLIENT_ID = "1234567890123.9876543210987"; // synthetic, not a registered Slack App
const SCOPES = ["search:read.public"];
function provider() {
  return { protocol: "slack-mcp", id: "slack", name: "Slack protocol fixture",
    serverUrl: slack.SERVER, issuer: slack.ISSUER, audience: slack.AUDIENCE,
    authorizationEndpoint: slack.AUTHORIZATION, tokenEndpoint: slack.TOKEN,
    clientId: CLIENT_ID, scopes: [...SCOPES], redirectUrl: "http://localhost:49152/oauth/callback",
    metadataUrls: [...slack.METADATA_URLS],
    identityUrls: [slack.AUTH_TEST], verifyPrincipal: slack.verifySlackPrincipal };
}
function tokenResponse(overrides = {}) {
  return { ok: true, access_token: "xoxp-fixture-access", refresh_token: "xoxe-fixture-refresh",
    token_type: "user", expires_in: 43200,
    authed_user: { id: "U12345678", scope: SCOPES.join(",") },
    team: { id: "T12345678" }, ...overrides };
}

test("frozen Slack MCP remains unconverted; independent reviewed official MCP component previews", () => {
  const catalog = new BundledPluginCatalog(bundledRoot());
  const item = catalog.get("slack");
  assert.equal(item.importStatus, "needs-adapter");
  assert.deepEqual(item.converted, { skills: 0, mcp: 0 });
  assert.deepEqual(item.unconvertedMcp,
    [{ name: "slack", reasonCode: "LEGACY_MCP_FIELD_UNSUPPORTED" }]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-slack-blocked-"));
  const paths = resolveServicePaths({ userDataRoot: root, cacheRoot: path.join(root, "cache"),
    trustedRoot: root });
  const store = new PluginStore({ paths }).open();
  try {
    const installer = new PluginPackageInstaller({ store, bundledCatalog: catalog });
    const preview = installer.previewBundled("slack");
    assert.equal(preview.installable, true);
    assert.deepEqual(preview.mcpServers.map(item => item.name),
      ["shoggoth-slack-official-mcp"]);
    assert.equal(preview.sourceIdentity, "bundled:slack");
    assert.deepEqual(store.listInstallations(), []);
    assert.deepEqual(store.listGlobalBindings(), []);
    assert.throws(() => store.setGrant({ grantId: "slack-blocked-grant",
      bindingId: "slack-blocked-binding", toolIdentity: "slack_search",
      contractDigest: "0".repeat(64), effect: "allow", approvalMode: "each-call",
      expectedRevision: 0 }), { code: "CONNECTION_AUTH_REQUIRED" });
    assert.equal(store.getGrant("slack-blocked-binding", "slack_search"), null);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("private provider file cannot turn a foreign Slack client ID into Shoggoth authority", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-slack-config-"));
  const pluginsDir = path.join(root, "plugins");
  fs.mkdirSync(pluginsDir, { mode: 0o700 });
  const { protocol, identityUrls, verifyPrincipal, ...internal } = provider();
  const entry = { ...internal, identity: { url: slack.AUTH_TEST, subjectField: "id" } };
  const file = path.join(pluginsDir, "oauth-providers.json");
  try {
    for (const serverUrl of [slack.SERVER, `${slack.SERVER}/other`]) {
      fs.writeFileSync(file, JSON.stringify({ version: 1,
        providers: [{ ...entry, serverUrl }] }), { mode: 0o600 });
      assert.throws(() => loadPluginOAuthProviders({ pluginsDir }),
        { code: "PLUGIN_OAUTH_CONFIG_INVALID" });
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Slack protocol is fixed to official endpoint, audience and minimum selected scopes", () => {
  assert.equal(slack.isSlackMcpHost(slack.SERVER), true);
  assert.equal(slack.isSlackMcpHost("https://other.example/mcp"), false);
  const valid = provider();
  assert.throws(() => new PluginOAuthProviderRegistry({ providers: [valid] }),
    { code: "PLUGIN_OAUTH_PROVIDER_UNSUPPORTED" },
    "a syntactically valid client ID is not proof of Shoggoth ownership");
  assert.doesNotThrow(() => new PluginOAuthProviderRegistry({ providers: [valid],
    registeredSlackClientId: CLIENT_ID }));
  assert.equal(slack.validSlackProtocolProvider({ ...valid,
    redirectUrl: "http://localhost:49152/oauth/callback" }, CLIENT_ID), true);
  assert.doesNotThrow(() => new PluginOAuthProviderRegistry({ providers: [
    { ...valid, redirectUrl: "http://localhost:49152/oauth/callback" } ],
    registeredSlackClientId: CLIENT_ID }),
  "only the trusted Slack protocol permits its fixed localhost redirect");
  const frozenClientId = JSON.parse(fs.readFileSync(path.join(bundledRoot(),
    "packages", "slack", ".mcp.json"), "utf8")).mcpServers.slack.oauth.client_id;
  assert.notEqual(frozenClientId, CLIENT_ID);
  assert.throws(() => new PluginOAuthProviderRegistry({ providers: [
    { ...valid, clientId: frozenClientId } ], registeredSlackClientId: CLIENT_ID }),
  { code: "PLUGIN_OAUTH_PROVIDER_UNSUPPORTED" });
  for (const replacement of [
    { id: "source-client" }, { serverUrl: `${slack.SERVER}/other` },
    { audience: slack.SERVER }, { issuer: "https://slack.com" },
    { authorizationEndpoint: "https://slack.com/oauth/v2/authorize" },
    { tokenEndpoint: "https://slack.com/api/oauth.v2.access" },
    { clientId: "<SLACK_CLIENT_ID>" }, { scopes: ["chat:write", "admin"] },
    { metadataUrls: [...slack.METADATA_URLS, "https://other.example/metadata"] },
    { identityUrls: ["https://other.example/auth.test"] },
    { redirectUrl: "http://localhost:80/oauth/callback" },
    { redirectUrl: "http://127.0.0.1:49152/oauth/callback" },
  ]) {
    assert.throws(() => new PluginOAuthProviderRegistry({ providers: [
      { ...valid, ...replacement } ], registeredSlackClientId: CLIENT_ID }),
    { code: "PLUGIN_OAUTH_PROVIDER_UNSUPPORTED" });
  }
});

test("Slack user token parsing requires explicit success, exact scopes and rotating fields", () => {
  const parsed = slack.normalizedSlackTokenResponse(Buffer.from(JSON.stringify(tokenResponse())), SCOPES);
  assert.deepEqual(parsed, { access_token: "xoxp-fixture-access",
    refresh_token: "xoxe-fixture-refresh", expires_in: 43200,
    token_type: "Bearer", scope: "search:read.public" });
  for (const replacement of [
    { ok: false }, { token_type: "bot" }, { refresh_token: null },
    { expires_in: undefined }, { authed_user: { id: "U12345678", scope: "chat:write" } },
    { authed_user: { id: "U12345678", scope: "search:read.public,chat:write" } },
    { authed_user: { id: "U12345678", scope: "search:read.public,search:read.public" } },
    { authed_user: { id: "bad", scope: "search:read.public" } },
    { team: { id: "bad" } },
    { scope: "chat:write" },
  ]) {
    assert.throws(() => slack.normalizedSlackTokenResponse(
      Buffer.from(JSON.stringify(tokenResponse(replacement))), SCOPES),
    { code: "CONNECTION_AUTH_REQUIRED" });
  }
});

test("isolated Slack metadata, PKCE, exact resource, token, principal and refresh stay in allowlist", async () => {
  const seen = [];
  let expectedChallenge;
  let metadataAudience = slack.AUDIENCE;
  let pkceMethods = ["S256"];
  const mockFetch = async input => {
    const request = new Request(input);
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.href}`);
    if (url.href === slack.METADATA_URLS[0]) return new Response(null, { status: 404 });
    if (url.href === slack.RESOURCE_METADATA) {
      return Response.json({ resource: metadataAudience, authorization_servers: [slack.ISSUER] });
    }
    if (url.href === slack.AUTHORIZATION_METADATA) return Response.json({ issuer: slack.ISSUER,
      authorization_endpoint: slack.AUTHORIZATION, token_endpoint: slack.TOKEN,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
      code_challenge_methods_supported: pkceMethods });
    if (url.href === slack.TOKEN) {
      const params = new URLSearchParams(await request.text());
      assert.equal(request.method, "POST");
      assert.equal(params.get("client_id"), CLIENT_ID);
      assert.equal(params.has("client_secret"), false);
      assert.equal(params.get("resource"), slack.AUDIENCE);
      if (params.get("grant_type") === "refresh_token") {
        assert.equal(params.get("refresh_token"), "xoxe-fixture-refresh");
        return Response.json(tokenResponse({ access_token: "xoxp-refreshed",
          refresh_token: "xoxe-refreshed" }));
      }
      assert.equal(params.get("grant_type"), "authorization_code");
      assert.equal(params.get("code"), "fixture-code");
      assert.equal(crypto.createHash("sha256").update(params.get("code_verifier") || "")
        .digest("base64url"), expectedChallenge);
      return Response.json(tokenResponse());
    }
    if (url.href === slack.AUTH_TEST) {
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get("authorization"), "Bearer xoxp-fixture-access");
      return Response.json({ ok: true, team_id: "T12345678", user_id: "U12345678" });
    }
    throw new Error(`unexpected Slack fixture egress: ${url.href}`);
  };
  const registry = new PluginOAuthProviderRegistry({ providers: [provider()],
    registeredSlackClientId: CLIENT_ID, fetchImpl: mockFetch });
  const trustedFetch = registry.fetchFor(slack.SERVER);
  for (const [url, init] of [
    ["https://other.example/collect", {}],
    [slack.AUTH_TEST, { method: "GET" }],
    [slack.TOKEN, { method: "GET" }],
    [slack.TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=authorization_code&client_id=${CLIENT_ID}&client_secret=untrusted&resource=${encodeURIComponent(slack.AUDIENCE)}&code=fixture&code_verifier=fixture&redirect_uri=http%3A%2F%2Flocalhost%3A49152%2Foauth%2Fcallback` }],
    [slack.SERVER, { method: "POST" }],
    [slack.AUTH_TEST, { method: "POST", body: "token=leak" }],
    [slack.AUTH_TEST, { method: "POST", headers: { Authorization: "Bearer fixture",
      Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded",
      Cookie: "session=leak" }, body: "" }],
  ]) await assert.rejects(trustedFetch(url, init), { code: "CONNECTION_AUTH_REQUIRED" });
  assert.deepEqual(seen, [], "rejected requests must never reach the network");

  const session = new PluginOAuthSessionManager({ fetchImpl: trustedFetch });
  const redirectUrl = "http://localhost:49152/oauth/callback";
  const input = { connectionId: "slack-protocol-fixture", serverUrl: slack.SERVER,
    redirectUrl, clientId: CLIENT_ID, scope: SCOPES.join(" "), allowLoopback: true,
    allowSlackLocalhostCallback: true };
  const started = await session.start(input);
  const authorization = new URL(registry.assertAuthorizationUrl(slack.SERVER,
    started.authorizationUrl, redirectUrl));
  assert.equal(authorization.origin, "https://slack.com");
  assert.equal(authorization.searchParams.get("scope"), SCOPES.join(" "));
  assert.equal(authorization.searchParams.get("resource"), slack.AUDIENCE);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  expectedChallenge = authorization.searchParams.get("code_challenge");
  const callback = new URL(redirectUrl);
  callback.searchParams.set("code", "fixture-code");
  callback.searchParams.set("state", authorization.searchParams.get("state"));
  callback.searchParams.set("iss", slack.ISSUER);
  await session.finish({ connectionId: input.connectionId, callbackUrl: callback.href });
  let received;
  await session.consumeTokens({ connectionId: input.connectionId,
    commit: async (tokens, metadata) => { received = { tokens, metadata }; } });
  assert.equal(received.metadata.audience, slack.AUDIENCE);
  assert.deepEqual(received.metadata.requestedScopes, SCOPES);
  assert.equal(received.tokens.token_type, "Bearer");
  const principal = await registry.verifyPrincipal({ endpointIdentity: slack.SERVER,
    issuer: `${slack.ISSUER}/`, audience: slack.AUDIENCE,
    scopes: SCOPES, accessToken: received.tokens.access_token });
  assert.match(principal, /^oauth:slack:[a-f0-9]{64}:[a-f0-9]{64}$/u);
  assert.equal(principal.includes("U12345678"), false);
  const refreshed = await registry.refreshTokens({ endpointIdentity: slack.SERVER,
    issuer: `${slack.ISSUER}/`, audience: slack.AUDIENCE,
    scopes: SCOPES, refreshToken: received.tokens.refresh_token });
  assert.equal(refreshed.access_token, "xoxp-refreshed");
  assert.equal(refreshed.scope, "search:read.public");
  assert.ok(seen.some(item => item === `POST ${slack.AUTH_TEST}`));
  assert.ok(seen.every(item => item.startsWith("GET https://mcp.slack.com/")
    || item === `POST ${slack.TOKEN}` || item === `POST ${slack.AUTH_TEST}`));

  metadataAudience = "https://other.example";
  await assert.rejects(trustedFetch(slack.RESOURCE_METADATA),
    { code: "CONNECTION_AUTH_REQUIRED" });
  metadataAudience = slack.AUDIENCE;
  pkceMethods = [];
  await assert.rejects(trustedFetch(slack.AUTHORIZATION_METADATA),
    { code: "CONNECTION_AUTH_REQUIRED" },
    "an authorization server without S256 PKCE cannot start a Slack public-client flow");
  await assert.rejects(registry.verifyPrincipal({ endpointIdentity: slack.SERVER,
    issuer: `${slack.ISSUER}/`, audience: slack.SERVER, scopes: SCOPES,
    accessToken: "xoxp-fixture-access" }), { code: "CONNECTION_AUTH_REQUIRED" });
  const expanded = new PluginOAuthProviderRegistry({ providers: [
    { ...provider(), scopes: [...SCOPES, "chat:write"] } ],
  registeredSlackClientId: CLIENT_ID, fetchImpl: mockFetch });
  await assert.rejects(expanded.refreshTokens({ endpointIdentity: slack.SERVER,
    issuer: `${slack.ISSUER}/`, audience: slack.AUDIENCE,
    scopes: SCOPES, refreshToken: "xoxe-fixture-refresh" }),
  { code: "CONNECTION_AUTH_REQUIRED" },
  "changing the registered scope set requires a new connection");
});

test("Slack identity endpoint must confirm a user and workspace; no bot or API error", async () => {
  for (const identity of [
    { ok: false, error: "invalid_auth" },
    { ok: true, team_id: "T12345678", user_id: "U12345678", bot_id: "B12345678" },
    { ok: true, team_id: "bad", user_id: "U12345678" },
    { ok: true, team_id: "T12345678", user_id: "bad" },
  ]) {
    await assert.rejects(slack.verifySlackPrincipal({ accessToken: "xoxp-fixture",
      issuer: `${slack.ISSUER}/`, fetchImpl: async () => Response.json(identity) }),
    { code: "CONNECTION_AUTH_REQUIRED" });
  }
});
