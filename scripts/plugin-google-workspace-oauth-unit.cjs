#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { loadPluginOAuthProviders } = require("../app/agent-service/plugin-oauth-config");
const { PluginOAuthProviderRegistry } = require("../app/agent-service/plugin-oauth-provider-registry");
const { PluginOAuthSessionManager } = require("../app/agent-service/plugin-oauth-session");
const { discoverAuthorizationServerMetadata } = require("@modelcontextprotocol/client");
const { PRODUCTS, OIDC_METADATA, USERINFO } = require("../app/agent-service/plugin-google-workspace-oauth");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService } = require("../app/agent-service/server");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");

const CLIENT_ID = "123456789012-shoggothfixture.apps.googleusercontent.com";
const ISSUER = "https://accounts.google.com";
const AUTH = `${ISSUER}/o/oauth2/v2/auth`;
const TOKEN = "https://oauth2.googleapis.com/token";
const EXAMPLE = path.resolve(__dirname, "../examples/plugins/google-workspace-mcp");
const SCOPES = {
  gmail: "https://www.googleapis.com/auth/gmail.readonly",
  "google-calendar": "https://www.googleapis.com/auth/calendar.events.readonly",
  "google-drive": "https://www.googleapis.com/auth/drive.file",
};

function privateProvider(endpoint, product) {
  const origin = new URL(endpoint).origin;
  return { id: product.id, name: `Fixture ${product.id}`, serverUrl: endpoint,
    issuer: ISSUER, audience: endpoint, authorizationEndpoint: AUTH,
    tokenEndpoint: TOKEN, clientId: CLIENT_ID,
    scopes: ["openid", "profile", SCOPES[product.id]],
    metadataUrls: [`${origin}/.well-known/oauth-protected-resource/mcp/v1`,
      `${origin}/.well-known/oauth-protected-resource`,
      `${ISSUER}/.well-known/oauth-authorization-server`, OIDC_METADATA],
    identity: { url: USERINFO, subjectField: "sub" } };
}

function privateConfigFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "google-workspace-oauth-"));
  const pluginsDir = path.join(root, "plugins");
  fs.mkdirSync(pluginsDir, { mode: 0o700 });
  const file = path.join(pluginsDir, "oauth-providers.json");
  const write = providers => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, providers }), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  };
  try { return run({ pluginsDir, write }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("three exact private Google providers require client ID shape and selected product scopes", () => {
  privateConfigFixture(({ pluginsDir, write }) => {
    const entries = Object.entries(PRODUCTS).map(([endpoint, product]) => privateProvider(endpoint, product));
    assert.deepEqual(loadPluginOAuthProviders({ pluginsDir }), []);
    write(entries);
    assert.equal(loadPluginOAuthProviders({ pluginsDir }).length, 3);
    for (const [index, provider] of entries.entries()) {
      const invalid = replacement => {
        write(entries.map((item, offset) => offset === index ? { ...item, ...replacement } : item));
        assert.throws(() => loadPluginOAuthProviders({ pluginsDir }),
          { code: "PLUGIN_OAUTH_CONFIG_INVALID" });
      };
      invalid({ clientId: `<${provider.id.toUpperCase().replaceAll("-", "_")}_PUBLIC_CLIENT_ID>` });
      invalid({ clientSecret: "frozen-placeholder" });
      invalid({ redirectUrl: "http://127.0.0.1:12798/oauth/callback" });
      invalid({ scopes: ["openid", "profile", provider.id === "google-drive"
        ? "https://www.googleapis.com/auth/gmail.readonly" : "https://www.googleapis.com/auth/drive"] });
      invalid({ scopes: [provider.scopes[2]] });
      invalid({ audience: "https://other.example/mcp" });
      invalid({ audience: `${new URL(provider.serverUrl).origin}/other` });
      invalid({ audience: `${new URL(provider.serverUrl).origin}/mcp/v` });
      invalid({ metadataUrls: [...provider.metadataUrls, "https://other.example/metadata"] });
      invalid({ identity: { url: "https://www.googleapis.com/oauth2/v3/userinfo", subjectField: "sub" } });
      invalid({ authorizationEndpoint: "https://accounts.google.com/other" });
      invalid({ serverUrl: `${provider.serverUrl}/other` });
      write(entries.map((item, offset) => offset === index
        ? { ...item, audience: new URL(provider.serverUrl).origin } : item));
      assert.equal(loadPluginOAuthProviders({ pluginsDir }).length, 3);
      write(entries);
    }
  });
});

test("local package has three separate exact endpoints and no frozen OAuth authority", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXAMPLE, "mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.mcpServers).sort(), Object.values(PRODUCTS).map(item => item.id).sort());
  for (const [endpoint, product] of Object.entries(PRODUCTS)) {
    assert.deepEqual(manifest.mcpServers[product.id], { type: "streamable-http", url: endpoint });
  }
  const serialized = JSON.stringify(manifest);
  for (const forbidden of ["clientId", "clientSecret", "client_id", "client_secret", "12798", "scopes"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("real Service management keeps deferred Calendar and Drive providers separate", async () => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sggoogle-"));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "user"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  fs.mkdirSync(paths.pluginsDir, { recursive: true, mode: 0o700 });
  const service = createAgentService({ paths, prewarmMcpAuth: false, parentEnv: {},
    version: "google-workspace-management-fixture" });
  try {
    await service.start();
    const backend = new ShoggothBackend({ paths });
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    backend._profilesByAgent.set(profile.agentId, profile);
    for (const packageId of ["google-calendar", "google-drive"]) {
      const source = { kind: "bundled", packageId };
      const preview = await backend.previewPluginInstall(source);
      assert.ok(preview.diagnostics.some(item => item.reasonCode === "CODEX_GOOGLE_DESKTOP_OAUTH_REQUIRED"));
      assert.equal(preview.components.mcpServers.length, 1);
      assert.equal(preview.components.mcpServers[0].name, packageId);
      assert.equal(JSON.stringify(preview).includes("12798"), false);
      const installed = await backend.installPlugin({ source,
        previewDigest: preview.previewDigest, expectedRevision: preview.expectedRevision ?? 0,
        operationId: `google-${packageId}-install` });
      const enabled = await backend.setPluginInstallationState({ installationId: installed.installation.installationId,
        desiredState: "enabled", expectedRevision: installed.installation.revision,
        operationId: `google-${packageId}-enable` });
      const page = await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 10, catalogRevision: null });
      const component = page.items.find(item => item.installationId === installed.installation.installationId)
        .components.find(item => item.localName === packageId);
      assert(component);
      const prepare = () => backend.preparePluginOAuth({ agentId: profile.agentId,
        installationId: installed.installation.installationId, componentId: component.componentId,
        expectedRevision: enabled.installation.revision, operationId: `google-${component.localName}-connect` });
      await assert.rejects(prepare(), error => ["PLUGIN_OAUTH_PROVIDER_UNSUPPORTED",
        "PLUGIN_SERVICE_FAILED"].includes(error.code));
      assert.equal(service.pluginStore.listGlobalBindings().length, 0,
        "unconfigured Google products must not acquire a connection or grant");
    }
    assert.equal(service.pluginStore.listGlobalBindings().length, 0);
  } finally {
    await service.stop({ notify: false });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Google-shaped isolated OAuth uses PKCE, exact resource, userinfo sub, and no secret", async () => {
  const [endpoint, product] = Object.entries(PRODUCTS)[0];
  let provider;
  privateConfigFixture(({ pluginsDir, write }) => {
    write([privateProvider(endpoint, product)]);
    [provider] = loadPluginOAuthProviders({ pluginsDir });
  });
  const calls = { metadata: 0, token: 0, identity: 0, refresh: 0 };
  let expectedChallenge;
  let metadataAudience = endpoint;
  const seen = [];
  const mockFetch = async input => {
    const request = new Request(input);
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.href}`);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      calls.metadata += 1;
      return Response.json({ resource: metadataAudience, authorization_servers: [ISSUER] });
    }
    if (url.href === `${ISSUER}/.well-known/oauth-authorization-server`) return new Response(null, { status: 404 });
    if (url.href === OIDC_METADATA) return Response.json({ issuer: ISSUER,
      authorization_endpoint: AUTH, token_endpoint: TOKEN,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
      subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"] });
    if (url.href === TOKEN) {
      const params = new URLSearchParams(await request.text());
      assert.equal(params.get("client_id"), CLIENT_ID);
      assert.equal(params.has("client_secret"), false);
      assert.equal(params.get("resource"), endpoint);
      if (params.get("grant_type") === "refresh_token") {
        calls.refresh += 1;
        assert.equal(params.get("refresh_token"), "fixture-refresh");
        return Response.json({ access_token: "fixture-access-refresh", token_type: "Bearer",
          expires_in: 3600, scope: provider.scopes.join(" ") });
      }
      calls.token += 1;
      assert.equal(params.get("grant_type"), "authorization_code");
      assert.equal(params.get("code"), "fixture-code");
      assert.equal(crypto.createHash("sha256").update(params.get("code_verifier") || "")
        .digest("base64url"), expectedChallenge);
      return Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh",
        token_type: "Bearer", expires_in: 3600, scope: provider.scopes.join(" ") });
    }
    if (url.href === USERINFO) {
      calls.identity += 1;
      assert.equal(request.headers.get("authorization"), "Bearer fixture-access");
      return Response.json({ sub: "google-fixture-subject" });
    }
    throw new Error(`unexpected OAuth fixture URL: ${url.href}`);
  };
  const registry = new PluginOAuthProviderRegistry({ providers: [provider], fetchImpl: mockFetch });
  await discoverAuthorizationServerMetadata(ISSUER, { fetchFn: registry.fetchFor(endpoint) });
  const session = new PluginOAuthSessionManager({ fetchImpl: registry.fetchFor(endpoint) });
  const redirectUrl = "http://127.0.0.1:49152/oauth/callback";
  const input = { connectionId: "google-fixture", serverUrl: endpoint, redirectUrl,
    clientId: CLIENT_ID, scope: provider.scopes.join(" "), allowLoopback: true };
  let start;
  try { start = await session.start(input); }
  catch (error) { assert.fail(`${error.message}: ${seen.join(", ")}`); }
  const authorization = new URL(registry.assertAuthorizationUrl(endpoint, start.authorizationUrl, redirectUrl));
  assert.equal(authorization.origin, ISSUER);
  assert.equal(authorization.searchParams.get("scope"), provider.scopes.join(" "));
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  expectedChallenge = authorization.searchParams.get("code_challenge");
  const callback = new URL(redirectUrl);
  callback.searchParams.set("code", "fixture-code");
  callback.searchParams.set("state", authorization.searchParams.get("state"));
  callback.searchParams.set("iss", ISSUER);
  await session.finish({ connectionId: input.connectionId, callbackUrl: callback.href });
  let received;
  await session.consumeTokens({ connectionId: input.connectionId, commit: async (tokens, metadata) => {
    received = { tokens, metadata };
  } });
  assert.equal(received.metadata.audience, endpoint);
  assert.deepEqual(received.metadata.requestedScopes, provider.scopes);
  const principal = await registry.verifyPrincipal({ endpointIdentity: endpoint, issuer: provider.issuer,
    audience: endpoint, scopes: provider.scopes, accessToken: received.tokens.access_token });
  assert.match(principal, /^oauth:gmail:[a-f0-9]{64}$/u);
  assert.equal(principal.includes("google-fixture-subject"), false);
  const refreshed = await registry.refreshTokens({ endpointIdentity: endpoint, issuer: provider.issuer,
    audience: endpoint, scopes: provider.scopes, refreshToken: received.tokens.refresh_token });
  assert.equal(refreshed.access_token, "fixture-access-refresh");
  assert.deepEqual(calls, { metadata: 1, token: 1, identity: 1, refresh: 1 });
  const badAuth = new URL(authorization);
  badAuth.searchParams.set("resource", "https://other.example/mcp");
  assert.throws(() => registry.assertAuthorizationUrl(endpoint, badAuth.href, redirectUrl),
    { code: "CONNECTION_AUTH_REQUIRED" });
  metadataAudience = "https://other.example/mcp";
  await assert.rejects(session.start({ ...input, connectionId: "mismatched-resource" }),
    { code: "CONNECTION_AUTH_REQUIRED" });
});
