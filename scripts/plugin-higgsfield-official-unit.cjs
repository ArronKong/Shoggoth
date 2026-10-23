"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BundledPluginCatalog, bundledRoot } = require("../app/core/bundled-plugin-catalog");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginComponentResolver } = require("../app/agent-service/plugin-component-resolver");
const { evaluatePluginSkill } = require("../app/agent-service/plugin-skill-eligibility");
const { PluginOAuthProviderRegistry } = require("../app/agent-service/plugin-oauth-provider-registry");
const { PluginOAuthSessionManager } = require("../app/agent-service/plugin-oauth-session");
const { CapabilityDispatcher } = require("../app/agent-service/capability-dispatcher");
const { assertReservedOfficialEndpoint } = require("../app/agent-service/plugin-reserved-official-endpoints");
const { HiggsfieldRegistrationController } = require("../app/agent-service/plugin-higgsfield-registration");
const { SOURCE_DIGEST, COMPONENT_NAME, SERVER } =
  require("../app/agent-service/plugin-higgsfield-official-overlay");
const { ISSUER, SECONDARY_ISSUER, RESOURCE_METADATA, AUTH_METADATA, OIDC_METADATA,
  AUTHORIZATION_ENDPOINT, TOKEN_ENDPOINT, REGISTRATION_ENDPOINT, USERINFO_ENDPOINT, SCOPES,
  registerLocalHiggsfieldClient, trustedHiggsfieldProvider, principalFromUserinfo,
  loadHiggsfieldRegistration } = require("../app/agent-service/plugin-higgsfield-official-oauth");

const REDIRECT_PORT = 45932;
const REDIRECT = `http://127.0.0.1:${REDIRECT_PORT}/oauth/callback`;
const CLIENT = "local-higgsfield-fixture-client";
const resourceMetadata = { resource: SERVER,
  authorization_servers: [ISSUER.slice(0, -1), SECONDARY_ISSUER.slice(0, -1)],
  scopes_supported: [...SCOPES] };
const authMetadata = { issuer: ISSUER.slice(0, -1),
  authorization_endpoint: AUTHORIZATION_ENDPOINT, token_endpoint: TOKEN_ENDPOINT,
  registration_endpoint: REGISTRATION_ENDPOINT,
  response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] };
const oidcMetadata = { ...authMetadata, userinfo_endpoint: USERINFO_ENDPOINT };
const receipt = { client_id: CLIENT, redirect_uris: [REDIRECT],
  grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
  token_endpoint_auth_method: "none" };

function fixtureFetch({ resource = resourceMetadata, auth = authMetadata, oidc = oidcMetadata,
  registered = receipt, userinfo = { sub: "user_123" }, failPost = false, calls = [] } = {}) {
  return async (input, init = {}) => {
    const request = new Request(input, init);
    calls.push({ url: request.url, method: request.method, redirect: init.redirect,
      authorization: request.headers.get("authorization") });
    if (request.method === "GET" && request.url === RESOURCE_METADATA) return Response.json(resource);
    if (request.method === "GET" && request.url === AUTH_METADATA) return Response.json(auth);
    if (request.method === "GET" && request.url === OIDC_METADATA) return Response.json(oidc);
    if (request.method === "GET" && request.url === USERINFO_ENDPOINT) {
      assert.equal(request.headers.get("authorization"), "Bearer fixture-access-token");
      return Response.json(userinfo);
    }
    if (request.method === "POST" && request.url === REGISTRATION_ENDPOINT) {
      assert.deepEqual(await request.json(), { client_name: "Shoggoth (local)",
        redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"], token_endpoint_auth_method: "none",
        scope: SCOPES.join(" ") });
      if (failPost) throw new Error("remote reply lost after POST");
      return Response.json(registered, { status: 201 });
    }
    throw new Error(`unexpected fixture request: ${request.method} ${request.url}`);
  };
}

async function main() {
  const catalog = new BundledPluginCatalog(bundledRoot());
  assert.equal(catalog.assertCurrent("higgsfield").sourceDigest, SOURCE_DIGEST);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-higgsfield-fixture-"));
  let store;
  try {
    const paths = resolveServicePaths({ stateRoot: path.join(temp, "state"),
      userDataRoot: temp, profileRoot: path.join(temp, "profile"),
      cacheRoot: path.join(temp, "cache"), trustedRoot: temp });
    store = new PluginStore({ paths }).open();
    const installer = new PluginPackageInstaller({ store, bundledCatalog: catalog });
    const preview = installer.previewBundled("higgsfield");
    assert.equal(preview.installable, true);
    assert.deepEqual(preview.skills.map(skill => skill.name).sort(),
      ["faceless-channel", "narrator", "subtitles"]);
    assert.deepEqual(preview.mcpServers.map(server => server.name), [COMPONENT_NAME]);
    const installed = installer.installBundled({ packageId: "higgsfield",
      previewDigest: preview.contentDigest, expectedRevision: preview.expectedRevision,
      operationId: "higgsfield-first-install" });
    assert.equal(installed.sourceIdentity, "bundled:higgsfield");
    const resolver = new PluginComponentResolver({ store });
    const skills = resolver.listEnabledSkillDescriptors("fixture-agent");
    assert.equal(skills.length, 3);
    for (const skill of skills) {
      const eligibility = evaluatePluginSkill(skill, { runtimeCapabilities: ["higgsfield-sandbox"] });
      assert.equal(eligibility.eligible, false, "sandbox Skill remains ineligible until contract review");
      assert.equal(eligibility.dependency, "higgsfield-sandbox");
    }
    const mcp = store.getRelease(installed.sourceIdentity, installed.releaseDigest).components.mcpServers[0];
    assert.equal(mcp.name, COMPONENT_NAME);
    const next = installer.previewBundled("higgsfield");
    assert.equal(next.contentDigest, preview.contentDigest, "overlay is deterministic on upgrade preview");
    assert.equal(next.skills.length, 3, "upgrade preview retains all three Skill files");
    const upgraded = installer.installBundled({ packageId: "higgsfield",
      previewDigest: next.contentDigest, expectedRevision: next.expectedRevision,
      operationId: "higgsfield-upgrade-same-frozen-source" });
    assert.equal(upgraded.sourceIdentity, "bundled:higgsfield");
    assert.equal(upgraded.releaseDigest, installed.releaseDigest,
      "upgrade does not lose the OAuth resource overlay or frozen Skills");
    assert.equal(fs.readFileSync(path.join(paths.pluginPackagesDir, installed.releaseDigest,
      "plugin.json"), "utf8").includes('"mcpOAuthResources"'), true);

    const calls = [];
    const fetchImpl = fixtureFetch({ calls });
    const registration = await registerLocalHiggsfieldClient({ redirectUrl: REDIRECT, fetchImpl });
    assert.equal(registration.clientId, CLIENT);
    assert.deepEqual(registration.scopes, SCOPES);
    assert.equal(calls.filter(call => call.method === "POST").length, 1);
    assert.equal(calls.every(call => call.redirect === "manual"), true);
    for (const altered of [
      { resource: { ...resourceMetadata, authorization_servers: [...resourceMetadata.authorization_servers].reverse() } },
      { resource: { ...resourceMetadata, authorization_servers: [ISSUER, "https://evil.example"] } },
      { auth: { ...authMetadata, registration_endpoint: "https://evil.example/register" } },
      { auth: { ...authMetadata, code_challenge_methods_supported: ["plain"] } },
      { oidc: { ...oidcMetadata, userinfo_endpoint: "https://evil.example/userinfo" } },
      { registered: { ...receipt, client_secret: "unexpected" } },
      { registered: { ...receipt, grant_types: ["authorization_code"] } },
      { registered: { ...receipt, scope: "openid email" } },
      { registered: { ...receipt, scope: "openid email offline_access profile" } },
    ]) {
      const attempts = [];
      await assert.rejects(registerLocalHiggsfieldClient({ redirectUrl: REDIRECT,
        fetchImpl: fixtureFetch({ ...altered, calls: attempts }) }),
      { code: "CONNECTION_AUTH_REQUIRED" });
      if (!altered.registered) assert.equal(attempts.some(call => call.method === "POST"), false,
        "metadata drift must fail before any registration write");
    }
    assert.throws(() => principalFromUserinfo({ email: "missing-sub@example.com" }),
      { code: "CONNECTION_AUTH_REQUIRED" });
    let current = true;
    const provider = trustedHiggsfieldProvider(registration, { assertCurrent: () => current });
    assert.equal(assertReservedOfficialEndpoint({ sourceIdentity: "bundled:higgsfield",
      componentName: COMPONENT_NAME, serverUrl: SERVER, oauthResource: SERVER, provider }),
    "higgsfield");
    for (const spoof of [
      { sourceIdentity: "local:higgsfield", componentName: COMPONENT_NAME,
        serverUrl: SERVER, oauthResource: SERVER, provider },
      { sourceIdentity: "bundled:higgsfield", componentName: COMPONENT_NAME,
        serverUrl: SERVER, oauthResource: null, provider },
    ]) assert.throws(() => assertReservedOfficialEndpoint(spoof),
      { code: "CONNECTION_IDENTITY_CHANGED" });
    const dispatcherStore = {
      getCapabilityRecords: () => ({ installation: { sourceIdentity: "bundled:higgsfield" },
        connection: { endpointIdentity: SERVER } }),
      beginCapabilityCall: () => {}, markCapabilityCallSendStarted: () => {},
      finishCapabilityCall: () => {},
    };
    const dispatcher = new CapabilityDispatcher({ store: dispatcherStore,
      permissionEngine: { authorizeCapability: () => true },
      resolveToolContract: () => ({}) });
    assert.throws(() => dispatcher.issueTicket({ callId: "paid-generation-fixture",
      authority: {}, execution: { kind: "native-run", run: { id: "fixture-run" } },
      envelope: {}, bindingId: "fixture-binding", toolIdentity: "fixture-tool",
      downstreamToolName: "generate_video", contractDigest: "0".repeat(64), arguments: {} }),
    { code: "CAPABILITY_FORBIDDEN" }, "generation is denied before a ticket or egress exists");
    assert.throws(() => new PluginOAuthProviderRegistry({ providers: [{ ...provider,
      verifyPrincipal: () => "oauth:higgsfield:fake" }],
      registeredHiggsfieldClientId: CLIENT, fetchImpl }),
    { code: "PLUGIN_OAUTH_PROVIDER_UNSUPPORTED" });
    const registry = new PluginOAuthProviderRegistry({ providers: [provider],
      registeredHiggsfieldClientId: CLIENT, fetchImpl });
    const principal = await registry.verifyPrincipal({ endpointIdentity: SERVER,
      issuer: ISSUER, audience: SERVER, scopes: [...SCOPES],
      accessToken: "fixture-access-token" });
    assert.match(principal, /^oauth:higgsfield:[a-f0-9]{64}:[a-f0-9]{64}$/u);
    const metadata = await registry.fetchFor(SERVER)(RESOURCE_METADATA, { method: "GET" });
    assert.equal(metadata.ok, true, "two exact advertised issuers are accepted for Clerk-first discovery");
    const oauth = new PluginOAuthSessionManager({ fetchImpl: registry.fetchFor(SERVER) });
    const started = await oauth.start({ connectionId: "higgsfield-fixture-login", serverUrl: SERVER,
      redirectUrl: REDIRECT, clientId: CLIENT, scope: SCOPES.join(" "), allowLoopback: true });
    assert.equal(registry.assertAuthorizationUrl(SERVER, started.authorizationUrl, REDIRECT),
      started.authorizationUrl, "pinned SDK PKCE URL keeps Clerk, scopes and resource exact");
    oauth.cancel("higgsfield-fixture-login");
    current = false;
    await assert.rejects(registry.verifyPrincipal({ endpointIdentity: SERVER,
      issuer: ISSUER, audience: SERVER, scopes: [...SCOPES],
      accessToken: "fixture-access-token" }), { code: "CONNECTION_AUTH_REQUIRED" });

    const controllerCalls = [];
    const controller = new HiggsfieldRegistrationController({ paths, store: {
      getBySource: () => null, listGlobalBindings: () => [],
    }, fetchImpl: fixtureFetch({ failPost: true, calls: controllerCalls }) });
    await assert.rejects(controller.configure({ redirectPort: REDIRECT_PORT }),
      /remote reply lost after POST/u);
    assert.equal(controller.status().needsVerification, true);
    await assert.rejects(controller.configure({ redirectPort: REDIRECT_PORT }),
      { code: "HIGGSFIELD_REGISTRATION_NEEDS_VERIFICATION" });
    assert.equal(controllerCalls.filter(call => call.method === "POST").length, 1,
      "uncertain DCR must never retry automatically");
    assert.equal(loadHiggsfieldRegistration(paths), null);
    assert.equal(controller.reconcile({ reviewedRemoteOutcome: true }).needsVerification, false);
    assert.equal(controller.status().configured, false);
  } finally {
    store?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log("Higgsfield frozen Skills / original MCP overlay / DCR / identity gates: PASS");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
