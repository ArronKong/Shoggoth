#!/usr/bin/env node
"use strict";

// Slack's PKCE guide calls `http://localhost:<port>` a desktop redirect.
// Only the trusted Slack OAuth path may use it. Generic MCP endpoints and
// callers without that protocol remain closed; product registration and real
// Slack app approval are separate gates.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { endpointOf } = require("../app/agent-service/plugin-mcp-client");
const { PluginOAuthProviderRegistry } = require("../app/agent-service/plugin-oauth-provider-registry");
const { PluginOAuthSessionManager } = require("../app/agent-service/plugin-oauth-session");
const { PluginOAuthConnectionController } = require("../app/agent-service/plugin-oauth-connection-controller");
const registration = require("../app/agent-service/plugin-slack-registration");
const slack = require("../app/agent-service/plugin-slack-oauth");
const { COMPONENT_NAME } = require("../app/agent-service/plugin-slack-official-sidecar");

const clientId = "1234567890123.9876543210987";
const callback = "http://localhost:49152/oauth/callback";
const registered = registration.providerFromRegistration(registration.recordFromInput({
  clientId, redirectPort: 49152, scopes: ["search:read.public"],
}));
assert.equal(registered.redirectUrl, callback);
assert.throws(() => endpointOf(callback, true), { code: "MCP_SERVER_URL_INVALID" },
  "generic HTTP localhost remains blocked by design");
assert.doesNotThrow(() => registration.providerFromRegistration({
  version: 1, clientId, redirectUrl: callback, scopes: ["search:read.public"],
}));
assert.doesNotThrow(() => new PluginOAuthProviderRegistry({ providers: [
  { ...registered, redirectUrl: callback } ], registeredSlackClientId: clientId,
}));
assert.throws(() => new PluginOAuthProviderRegistry({ providers: [
  { ...registered, protocol: null, redirectUrl: callback } ],
}), { code: "PLUGIN_OAUTH_PROVIDER_UNSUPPORTED" });

const listen = (server, port, host) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen({ port, host, ipv6Only: host === "::1" }, resolve);
});
const close = server => server?.listening ? new Promise(resolve => {
  server.close(resolve);
  server.closeIdleConnections();
}) : Promise.resolve();
async function availableDualPort() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const ipv4 = http.createServer();
    const ipv6 = http.createServer();
    try {
      await listen(ipv4, 0, "127.0.0.1");
      const port = ipv4.address().port;
      await listen(ipv6, port, "::1");
      return port;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    } finally {
      await Promise.all([close(ipv4), close(ipv6)]);
    }
  }
  throw new Error("No available dual-loopback fixture port");
}
function callbackRequest(host, port, url, hostHeader) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: host, port,
      path: `${url.pathname}${url.search}`,
      headers: { Host: hostHeader } }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.once("error", reject);
  });
}
function controllerFixture(port) {
  const provider = registration.providerFromRegistration(registration.recordFromInput({
    clientId, redirectPort: port, scopes: ["search:read.public"],
  }));
  const state = { metadataRequests: 0, tokenExchanges: 0, expectedChallenge: null,
    tokens: null, connections: new Map(), bindings: [] };
  const mockFetch = async input => {
    const request = new Request(input);
    const url = new URL(request.url);
    if (slack.METADATA_URLS.includes(url.href)) state.metadataRequests += 1;
    if (url.href === slack.METADATA_URLS[0]) return new Response(null, { status: 404 });
    if (url.href === slack.RESOURCE_METADATA) return Response.json({ resource: slack.AUDIENCE,
      authorization_servers: [slack.ISSUER] });
    if (url.href === slack.AUTHORIZATION_METADATA) return Response.json({ issuer: slack.ISSUER,
      authorization_endpoint: slack.AUTHORIZATION, token_endpoint: slack.TOKEN,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
      code_challenge_methods_supported: ["S256"] });
    if (url.href === slack.TOKEN) {
      state.tokenExchanges += 1;
      const params = new URLSearchParams(await request.text());
      assert.equal(params.get("code"), "fixture-code");
      assert.equal(params.get("redirect_uri"), provider.redirectUrl);
      assert.equal(crypto.createHash("sha256").update(params.get("code_verifier") || "")
        .digest("base64url"), state.expectedChallenge);
      return Response.json({ ok: true, access_token: "xoxp-fixture-access",
        refresh_token: "xoxe-fixture-refresh", token_type: "user", expires_in: 43200,
        authed_user: { id: "U12345678", scope: "search:read.public" },
        team: { id: "T12345678" } });
    }
    if (url.href === slack.AUTH_TEST) return Response.json({ ok: true,
      team_id: "T12345678", user_id: "U12345678" });
    throw new Error(`Unexpected fixture egress: ${url.href}`);
  };
  const providers = new PluginOAuthProviderRegistry({ providers: [provider],
    registeredSlackClientId: clientId, fetchImpl: mockFetch });
  const profile = { id: "slack-fixture-profile", enabled: true };
  const installation = { installationId: "slack-fixture-install", revision: 1,
    sourceIdentity: "bundled:slack" };
  const component = { transport: "streamable-http", spec: { url: slack.SERVER },
    oauthResource: slack.AUDIENCE, descriptorDigest: "b".repeat(64), name: COMPONENT_NAME };
  const store = {
    listGlobalBindings: () => state.bindings,
    getConnection: id => state.connections.get(id) ?? null,
    getOperation: () => null,
    createConnection(input) { state.connections.set(input.connectionId,
      { ...input, state: "pending", revision: 1 }); },
    setConnectionIdentity(input) { const previous = state.connections.get(input.connectionId);
      const next = { ...previous, state: input.state, principalIdentity: input.principalIdentity,
        revision: previous.revision + 1 };
      state.connections.set(input.connectionId, next); return next; },
    performManagementOperation: ({ apply }) => ({ result: apply() }),
    createGlobalBinding(input) { const binding = { ...input, revision: 1, enabled: false };
      state.bindings.push(binding); return binding; },
    setBindingEnabled(input) { const index = state.bindings.findIndex(binding =>
      binding.bindingId === input.bindingId);
      const next = { ...state.bindings[index], enabled: input.enabled,
        revision: state.bindings[index].revision + 1 };
      state.bindings[index] = next; return next; },
  };
  const controller = new PluginOAuthConnectionController({ store,
    productStore: { getAgentProfile: id => id === profile.id ? profile : null },
    manager: { component: () => ({ installation, component, release: { name: "Slack" } }) },
    providers,
    vault: { async storePendingOAuthTokens(input) { state.tokens = input.tokens; },
      async verifyAndActivate({ connectionId }) {
        assert.equal(state.tokens.access_token, "xoxp-fixture-access");
        state.connections.set(connectionId, { ...state.connections.get(connectionId), state: "ready",
          principalIdentity: "fixture-user" });
      } },
  });
  const begin = async operationId => {
    const prepared = controller.prepare({ profileId: profile.id,
      installationId: installation.installationId, componentId: "a".repeat(64),
      expectedRevision: 1, operationId });
    return controller.commit({ challenge: prepared.challenge, approved: true });
  };
  return { controller, begin, state, profile };
}

// Session creation still requires its Service-only Slack flag. The full
// metadata/PKCE/nonce/token exchange is exercised below and in the Slack
// protocol fixture. This is not a real Slack account acceptance.
(async () => {
  const session = new PluginOAuthSessionManager({
    fetchImpl: async () => { throw new Error("must not egress"); },
  });
  await assert.rejects(session.start({ connectionId: "slack-localhost-design",
    serverUrl: slack.SERVER, redirectUrl: callback, clientId,
    scope: "search:read.public", allowLoopback: true }),
  { code: "MCP_SERVER_URL_INVALID" });
  const port = await availableDualPort();
  const fixture = controllerFixture(port);
  try {
    const { flow } = await fixture.begin("slack-dual-listener");
    assert.equal(flow.status, "pending");
    const authorization = new URL(flow.authorizationUrl);
    assert.equal(authorization.searchParams.get("redirect_uri"),
      `http://localhost:${port}/oauth/callback`);
    fixture.state.expectedChallenge = authorization.searchParams.get("code_challenge");
    const valid = new URL(authorization.searchParams.get("redirect_uri"));
    valid.searchParams.set("state", authorization.searchParams.get("state"));
    valid.searchParams.set("code", "fixture-code");
    valid.searchParams.set("iss", slack.ISSUER);
    const wrongState = new URL(valid);
    wrongState.searchParams.set("state", "wrong-state");
    for (const address of ["127.0.0.1", "::1"]) {
      assert.equal((await callbackRequest(address, port, valid, `evil.invalid:${port}`)).status, 400);
      assert.equal((await callbackRequest(address, port, wrongState, `localhost:${port}`)).status, 400);
      assert.equal(fixture.controller.status({ profileId: fixture.profile.id,
        flowId: flow.flowId }).status, "pending");
    }
    assert.equal(fixture.state.tokenExchanges, 0);
    assert.equal((await callbackRequest("::1", port, valid, `localhost:${port}`)).status, 200);
    assert.equal(fixture.state.tokenExchanges, 1);
    assert.equal(fixture.controller.status({ profileId: fixture.profile.id,
      flowId: flow.flowId }).status, "ready");
    try {
      const replay = await callbackRequest("127.0.0.1", port, valid, `localhost:${port}`);
      assert.equal(replay.status, 400, "an in-flight replay cannot exchange the code again");
    } catch (error) {
      if (error.code === "ERR_ASSERTION") throw error;
      assert.ok(["ECONNREFUSED", "ECONNRESET"].includes(error.code),
        "closed listener rejects a later replay");
    }
    assert.equal(fixture.state.tokenExchanges, 1);
  } finally { await fixture.controller.close(); }

  for (const occupiedHost of ["127.0.0.1", "::1"]) {
    const blockedPort = await availableDualPort();
    const blocker = http.createServer();
    await listen(blocker, blockedPort, occupiedHost);
    const blocked = controllerFixture(blockedPort);
    try {
      await assert.rejects(blocked.begin(`slack-${occupiedHost === "::1" ? "ipv6" : "ipv4"}-occupied`),
        { code: "EADDRINUSE" });
      assert.equal(blocked.state.metadataRequests, 0,
        "no authorization URL or OAuth metadata egress after either bind failure");
      assert.equal(blocked.state.bindings.length, 0);
      assert.ok([...blocked.state.connections.values()].every(connection =>
        connection.state === "disconnected"));
      const reclaimed = http.createServer();
      try { await listen(reclaimed, blockedPort, occupiedHost === "::1" ? "127.0.0.1" : "::1"); }
      finally { await close(reclaimed); }
    } finally {
      await blocked.controller.close();
      await close(blocker);
    }
  }
  const cancelPort = await availableDualPort();
  const canceled = controllerFixture(cancelPort);
  try {
    const { flow } = await canceled.begin("slack-canceled-dual-listener");
    assert.equal(canceled.controller.cancel({ profileId: canceled.profile.id,
      flowId: flow.flowId }).status, "canceled");
    const ipv4 = http.createServer();
    const ipv6 = http.createServer();
    try {
      await listen(ipv4, cancelPort, "127.0.0.1");
      await listen(ipv6, cancelPort, "::1");
    } finally { await Promise.all([close(ipv4), close(ipv6)]); }
  } finally { await canceled.controller.close(); }
  process.stdout.write("Slack localhost callback boundary and dual-loopback listener: PASS\n");
})().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
