"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BundledPluginCatalog, bundledRoot } = require("../app/core/bundled-plugin-catalog");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginComponentResolver } = require("../app/agent-service/plugin-component-resolver");
const { PluginMcpConnectionManager } = require("../app/agent-service/plugin-mcp-connection-manager");
const { PluginOAuthConnectionController } = require("../app/agent-service/plugin-oauth-connection-controller");
const { PluginOAuthProviderRegistry } = require("../app/agent-service/plugin-oauth-provider-registry");
const { PluginOAuthSessionManager } = require("../app/agent-service/plugin-oauth-session");
const { componentId } = require("../app/agent-service/plugin-component-catalog");
const { previewPluginDirectory } = require("../app/agent-service/plugin-package-parser");

const SOURCE = path.resolve(__dirname, "../examples/plugins/lovable-official-mcp");
const SERVER = "https://mcp.lovable.dev";
const ISSUER = "https://lovable.dev/oauth";
const METADATA = `${SERVER}/.well-known/oauth-protected-resource`;

function trustedFixture({ serverUrl = SERVER, audience = serverUrl, resource = audience } = {}) {
  let observed = resource;
  let requests = 0;
  const issuer = serverUrl === SERVER ? ISSUER : "https://issuer.example/oauth";
  const provider = { id: "fixture", name: "Fixture only", serverUrl, issuer, audience,
    authorizationEndpoint: `${issuer}/authorize`, tokenEndpoint: `${issuer}/token`,
    clientId: "fixture-client", scopes: ["workspaces:read"],
    metadataUrls: [new URL("/.well-known/oauth-protected-resource", serverUrl).href],
    verifyPrincipal: async () => "fixture-principal" };
  const registry = new PluginOAuthProviderRegistry({ providers: [provider],
    fetchImpl: async request => {
      requests += 1;
      assert.equal(request.method, "GET");
      return Response.json({ resource: observed, authorization_servers: [issuer] });
    } });
  return { provider: registry.forEndpoint(new URL(serverUrl).href), registry,
    metadataUrl: provider.metadataUrls[0], setResource(value) { observed = value; },
    get requests() { return requests; } };
}

async function pathlessProtocolFixture() {
  const redirectUrl = "http://127.0.0.1:45678/oauth/callback";
  const requests = [];
  let challenge;
  const fetchImpl = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({ method: request.method, url: request.url });
    if (url.origin === SERVER && url.pathname === "/.well-known/oauth-protected-resource") {
      return Response.json({ resource: SERVER, authorization_servers: [ISSUER],
        scopes_supported: ["workspaces:read"] });
    }
    if (url.origin === "https://lovable.dev" && (url.pathname.includes("oauth-authorization-server")
      || url.pathname.includes("openid-configuration"))) {
      return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`, response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true });
    }
    if (request.method === "POST" && request.url === `${ISSUER}/token`) {
      const body = new URLSearchParams(await request.text());
      assert.equal(body.get("client_id"), "fixture-client");
      assert.equal(body.get("resource"), SERVER, "token requests use the exact pathless resource");
      if (body.get("grant_type") === "authorization_code") {
        assert.equal(body.get("redirect_uri"), redirectUrl);
        assert.equal(body.get("code"), "fixture-code");
        assert.equal(crypto.createHash("sha256").update(body.get("code_verifier"))
          .digest("base64url"), challenge);
        return Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh",
          token_type: "Bearer", expires_in: 3600, scope: "workspaces:read" });
      }
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("refresh_token"), "fixture-refresh");
      return Response.json({ access_token: "fixture-access-refreshed", token_type: "Bearer",
        expires_in: 3600, scope: "workspaces:read" });
    }
    return new Response(null, { status: 404 });
  };
  const manager = new PluginOAuthSessionManager({ fetchImpl, now: () => 1000, lifetimeMs: 5000 });
  const started = await manager.start({ connectionId: "fixture-pathless", serverUrl: SERVER,
    redirectUrl, clientId: "fixture-client", scope: "workspaces:read", allowLoopback: true });
  const authorization = new URL(started.authorizationUrl);
  assert.equal(authorization.searchParams.get("resource"), SERVER,
    "the SDK must use the protected resource metadata spelling in authorization");
  challenge = authorization.searchParams.get("code_challenge");
  const callback = new URL(redirectUrl);
  callback.searchParams.set("state", authorization.searchParams.get("state"));
  callback.searchParams.set("code", "fixture-code");
  callback.searchParams.set("iss", ISSUER);
  await manager.finish({ connectionId: "fixture-pathless", callbackUrl: callback.href });
  await manager.consumeTokens({ connectionId: "fixture-pathless", commit: async (tokens, metadata) => {
    assert.equal(tokens.access_token, "fixture-access");
    assert.equal(metadata.issuer, ISSUER);
    assert.equal(metadata.audience, SERVER, "Service token handoff preserves the pathless resource");
  } });
  assert.equal(requests.filter(item => item.url === `${ISSUER}/token`).length, 1);
  const registry = new PluginOAuthProviderRegistry({ providers: [{
    id: "fixture", name: "Fixture only", serverUrl: SERVER, issuer: ISSUER, audience: SERVER,
    authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: `${ISSUER}/token`,
    clientId: "fixture-client", scopes: ["workspaces:read"],
    metadataUrls: [METADATA, "https://lovable.dev/.well-known/oauth-authorization-server/oauth",
      `${ISSUER}/.well-known/oauth-authorization-server`,
      "https://lovable.dev/.well-known/openid-configuration/oauth"],
    verifyPrincipal: async () => "fixture-principal",
  }], fetchImpl });
  const refreshed = await registry.refreshTokens({ endpointIdentity: `${SERVER}/`, issuer: ISSUER,
    audience: SERVER, scopes: ["workspaces:read"], refreshToken: "fixture-refresh" });
  assert.equal(refreshed.access_token, "fixture-access-refreshed");
  assert.equal(requests.filter(item => item.url === `${ISSUER}/token`).length, 2,
    "refresh uses the same exact resource indicator as authorization and exchange");
}

async function main() {
  const catalog = new BundledPluginCatalog(bundledRoot());
  assert.equal(catalog.assertCurrent("lovable").importStatus, "needs-adapter",
    "the frozen hosted app remains a separate, unchanged source");
  const frozen = fs.readFileSync(path.join(catalog.packagePath("lovable"), ".app.json"), "utf8");
  assert.match(frozen, /asdk_app_693a0a79ffe48191901173077edcf914/u);
  assert.equal(fs.existsSync(path.join(SOURCE, ".app.json")), false);
  const candidate = previewPluginDirectory(SOURCE);
  assert.equal(candidate.installable, true);
  assert.equal(candidate.name, "lovable-official-mcp");
  assert.equal(candidate.mcpServers.length, 1);
  assert.equal(candidate.mcpServers[0].name, "lovable-official");
  assert.equal(candidate.mcpServers[0].type, "streamable-http");

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-lovable-official-"));
  const paths = resolveServicePaths({ stateRoot: path.join(temp, "state"),
    userDataRoot: temp, profileRoot: path.join(temp, "profile"),
    cacheRoot: path.join(temp, "cache"), trustedRoot: temp });
  let store;
  try {
    store = new PluginStore({ paths }).open();
    const installer = new PluginPackageInstaller({ store });
    const preview = installer.preview(SOURCE);
    const installed = installer.install({ sourcePath: SOURCE, previewDigest: preview.contentDigest,
      expectedRevision: preview.expectedRevision, operationId: "install-lovable-official-candidate" });
    assert.equal(installed.sourceIdentity, `local:${SOURCE}`);
    assert.notEqual(installed.sourceIdentity, "bundled:lovable");
    const enabled = store.setInstallationDesiredState({ installationId: installed.installationId,
      desiredState: "enabled", expectedRevision: installed.revision });
    const selectedId = componentId(installed.installationId, "mcp-server", "lovable-official");
    const resolver = new PluginComponentResolver({ store });
    const manager = new PluginMcpConnectionManager({ store, resolver });
    const current = manager.component(installed.installationId, selectedId);
    assert.equal(current.component.spec.url, SERVER);
    assert.equal(current.component.oauthResource, SERVER,
      "the exact pathless RFC 8707 resource survives install and readback");

    let networkRequests = 0;
    const noProviders = new PluginOAuthProviderRegistry({ fetchImpl: async () => {
      networkRequests += 1; throw new Error("untrusted network request");
    } });
    const controller = new PluginOAuthConnectionController({ store,
      productStore: { getAgentProfile: () => ({ id: "fixture-profile", enabled: true }) },
      manager, providers: noProviders,
      vault: { storePendingOAuthTokens() {}, verifyAndActivate() {} } });
    assert.throws(() => controller.prepare({ profileId: "fixture-profile",
      installationId: installed.installationId, componentId: selectedId,
      expectedRevision: enabled.revision, operationId: "lovable-connect-attempt" }),
    { code: "PLUGIN_OAUTH_PROVIDER_UNSUPPORTED" },
    "installing a candidate does not create OAuth authority");
    assert.equal(networkRequests, 0);

    const root = trustedFixture();
    assert.equal(root.provider.serverUrl, `${SERVER}/`);
    assert.equal(root.provider.audience, SERVER);
    assert.equal(root.metadataUrl, METADATA);
    const legacyDefault = new PluginOAuthProviderRegistry({ providers: [{ ...root.provider,
      audience: undefined }] });
    assert.equal(legacyDefault.forEndpoint(`${SERVER}/`).audience, `${SERVER}/`,
      "providers without an explicit audience keep their previous URL-normalized default");
    const fetchMetadata = () => root.registry.fetchFor(root.provider.serverUrl)(root.metadataUrl);
    assert.equal((await fetchMetadata()).status, 200);
    for (const changed of [`${SERVER}/`, `${SERVER}/mcp`, "https://different.example"] ) {
      root.setResource(changed);
      await assert.rejects(fetchMetadata(), { code: "CONNECTION_AUTH_REQUIRED" },
        `resource ${changed} must not silently replace the trusted audience`);
    }
    assert.equal(root.requests, 4);
    const authorize = new URL(root.provider.authorizationEndpoint);
    authorize.searchParams.set("client_id", root.provider.clientId);
    authorize.searchParams.set("redirect_uri", "http://127.0.0.1:45678/oauth/callback");
    authorize.searchParams.set("scope", root.provider.scopes.join(" "));
    authorize.searchParams.set("resource", SERVER);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("code_challenge", "fixture-challenge");
    authorize.searchParams.set("state", "fixture-state");
    assert.equal(root.registry.assertAuthorizationUrl(root.provider.serverUrl, authorize.href,
      "http://127.0.0.1:45678/oauth/callback"), authorize.href);
    authorize.searchParams.set("resource", `${SERVER}/`);
    assert.throws(() => root.registry.assertAuthorizationUrl(root.provider.serverUrl, authorize.href,
      "http://127.0.0.1:45678/oauth/callback"), { code: "CONNECTION_AUTH_REQUIRED" });
    await assert.rejects(root.registry.verifyPrincipal({ endpointIdentity: root.provider.serverUrl,
      issuer: ISSUER, audience: `${SERVER}/`, scopes: ["workspaces:read"], accessToken: "fixture-token" }),
    { code: "CONNECTION_AUTH_REQUIRED" }, "stored audience changes are rejected before identity verification");

    const nested = trustedFixture({ serverUrl: "https://nested.example/mcp" });
    assert.equal(nested.provider.audience, "https://nested.example/mcp");
    assert.equal((await nested.registry.fetchFor(nested.provider.serverUrl)(nested.metadataUrl)).status, 200);
    nested.setResource("https://nested.example");
    await assert.rejects(nested.registry.fetchFor(nested.provider.serverUrl)(nested.metadataUrl),
      { code: "CONNECTION_AUTH_REQUIRED" }, "a non-root resource path remains distinct from its origin");

    const altered = path.join(temp, "altered-candidate");
    fs.cpSync(SOURCE, altered, { recursive: true });
    const manifestPath = path.join(altered, "plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.extensions.shoggoth.mcpOAuthResources["lovable-official"] = "https://different.example";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => previewPluginDirectory(altered), { code: "PACKAGE_INVALID" },
      "an MCP package cannot move its OAuth resource to another origin");
    await pathlessProtocolFixture();
    console.log("Lovable independent MCP candidate / exact OAuth resource / no-provider gate: PASS");
  } finally {
    store?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
