"use strict";

// No Slack credential or network call: a local official-protocol fixture crosses
// REST, native confirmation, Backend, authenticated Service, OAuth and native Run.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService } = require("../app/agent-service/server");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { startStaticServer } = require("../app/static-server");
const slack = require("../app/agent-service/plugin-slack-oauth");
const { FILE_NAME, FROZEN_SOURCE_CLIENT_ID } =
  require("../app/agent-service/plugin-slack-registration");
const { FULL_COMPONENT: COMPONENT_NAME } = require("../app/agent-service/plugin-slack-access-policy");
const { pluginServerId } = require("../app/agent-service/plugin-runtime-tool-service");

const CLIENT_ID = "1234567890123.9876543210987";
const SCOPES = ["search:read.public"];
const listen = (server, port, host) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen({ port, host, ipv6Only: host === "::1" }, resolve);
});
const close = server => server.listening ? new Promise(resolve => server.close(resolve))
  : Promise.resolve();
async function dualLoopbackPort() {
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
    } finally { await Promise.all([close(ipv4), close(ipv6)]); }
  }
  throw new Error("No free dual-loopback port for Slack fixture");
}
function safeStorage(key) {
  return { isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      return Buffer.concat([nonce, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString("utf8");
    } };
}
function officialFixture(redirectUrl, { scopes = SCOPES, tools = null, onToolCall = null } = {}) {
  const state = { expectedChallenge: null, publicSearchCalls: 0, writeCalls: 0,
    egress: [], tokenExchanges: 0 };
  const fetchImpl = async (input, init = {}) => {
    const request = new Request(input, init);
    state.egress.push(`${request.method} ${request.url}`);
    if (request.url === slack.METADATA_URLS[0] && request.method === "GET") {
      return new Response(null, { status: 404 });
    }
    if (request.url === slack.RESOURCE_METADATA && request.method === "GET") {
      return Response.json({ resource: slack.AUDIENCE,
        authorization_servers: [slack.ISSUER] });
    }
    if (request.url === slack.AUTHORIZATION_METADATA && request.method === "GET") {
      return Response.json({ issuer: slack.ISSUER,
        authorization_endpoint: slack.AUTHORIZATION, token_endpoint: slack.TOKEN,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        code_challenge_methods_supported: ["S256"] });
    }
    if (request.url === slack.TOKEN && request.method === "POST") {
      state.tokenExchanges += 1;
      const form = new URLSearchParams(await request.text());
      assert.equal(form.get("client_id"), CLIENT_ID);
      assert.equal(form.get("client_secret"), null);
      assert.equal(form.get("redirect_uri"), redirectUrl);
      assert.equal(form.get("resource"), slack.AUDIENCE);
      assert.equal(form.get("scope"), null);
      assert.equal(form.get("code"), "slack-fixture-code");
      assert.equal(crypto.createHash("sha256").update(form.get("code_verifier") || "")
        .digest("base64url"), state.expectedChallenge);
      return Response.json({ ok: true, access_token: "xoxp-fixture-access",
        refresh_token: "xoxe-fixture-refresh", token_type: "user", expires_in: 43200,
        authed_user: { id: "U12345678", scope: scopes.join(",") },
        team: { id: "T12345678" } });
    }
    if (request.url === slack.AUTH_TEST && request.method === "POST") {
      assert.equal(request.headers.get("authorization"), "Bearer xoxp-fixture-access");
      return Response.json({ ok: true, team_id: "T12345678", user_id: "U12345678" });
    }
    if (request.url === slack.SERVER && request.method === "GET") {
      return new Response(null, { status: 405 });
    }
    if (request.url === slack.SERVER && request.method === "POST") {
      assert.equal(request.headers.get("authorization"), "Bearer xoxp-fixture-access");
      const message = JSON.parse(await request.text());
      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (message.method === "server/discover") {
        return Response.json({ jsonrpc: "2.0", id: message.id,
          error: { code: -32601, message: "Method not found" } });
      }
      let result;
      if (message.method === "initialize") {
        result = { protocolVersion: "2025-11-25",
          serverInfo: { name: "slack-fixture", version: "1" }, capabilities: { tools: {} } };
      } else if (message.method === "tools/list") {
        result = { tools: tools || [
          { name: "slack_search_public", description: "Read public messages",
            inputSchema: { type: "object", properties: { query: { type: "string" } },
              required: ["query"] } },
          { name: "slack_post_message", description: "Write message",
            inputSchema: { type: "object", properties: {} } },
        ] };
      } else if (message.method === "tools/call") {
        if (message.params?.name === "slack_search_public") {
          assert.deepEqual(message.params.arguments, { query: "fixture" });
          state.publicSearchCalls += 1;
          result = { structuredContent: { matches: [{ text: "fixture message" }] },
            content: [{ type: "text", text: "fixture message" }], isError: false };
        } else if (message.params?.name === "slack_post_message") {
          state.writeCalls += 1;
          throw new Error("write tool must not reach Slack fixture");
        } else if (onToolCall) {
          result = await onToolCall(message.params.name, message.params.arguments);
        } else throw new Error(`unknown Slack MCP tool ${message.params?.name}`);
      } else throw new Error(`unexpected Slack MCP method ${message.method}`);
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    }
    throw new Error(`unexpected Slack fixture egress: ${request.method} ${request.url}`);
  };
  return { state, fetchImpl };
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join("/private/tmp", "sgsl-")));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "user"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const key = crypto.randomBytes(32);
  const port = await dualLoopbackPort();
  const redirectUrl = `http://localhost:${port}/oauth/callback`;
  const official = officialFixture(redirectUrl);
  const options = { paths, safeStorage: safeStorage(key), parentEnv: {},
    prewarmMcpAuth: false, version: "plugin-slack-registration-fixture",
    pluginOAuthFetch: official.fetchImpl, pluginSlackMcpFetch: official.fetchImpl };
  let service, web;
  try {
    service = createAgentService(options);
    await service.start();
    const backend = new ShoggothBackend({ paths });
    const registry = { backends: new Map([["shoggoth", backend]]),
      route: id => backend._profilesByAgent.has(id) ? backend : null };
    let approved = false;
    let launchUrl = null;
    const confirmations = [];
    web = await startStaticServer(0, { homeDir: root, userDataRoot: root,
      registry, hostOps: { async confirmPluginCapability(summary) {
        confirmations.push(summary); return approved;
      }, async openExternal(url) { launchUrl = url; } } });
    const post = async (route, body, headers = {}) => {
      const response = await fetch(`${web.url}/__api/plugins/${route}`, { method: "POST",
        headers: { origin: web.url, "content-type": "application/json", ...headers },
        body: JSON.stringify(body) });
      const raw = await response.text();
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
      return { status: response.status, body: parsed };
    };
    const rpc = (method, params, token = readClientToken(paths)) =>
      requestService(paths, { token, version: SERVICE_PROTOCOL_VERSION, method, params });
    const status = () => post("slack-registration-status", {});
    const configureInput = { clientId: CLIENT_ID, redirectPort: port, scopes: SCOPES };
    const configure = (body = configureInput, headers = {}) =>
      post("slack-registration-configure", body, headers);
    assert.deepEqual(await status(), { status: 200,
      body: { configured: false, restartRequired: false, accessProfile: null } });
    assert.deepEqual(await backend.getPluginSlackRegistrationStatus(),
      { configured: false, restartRequired: false, accessProfile: null });
    await assert.rejects(rpc("plugins.slack.registration.status", {}, "wrong"),
      { code: "AUTH_FAILED" });
    await assert.rejects(rpc("plugins.slack.registration.status", { extra: true }),
      { code: "PLUGIN_REQUEST_INVALID" });
    assert.equal((await configure(undefined, { origin: "https://evil.example" })).status, 403);
    assert.equal((await configure(undefined, { "sec-fetch-site": "cross-site" })).status, 403);
    for (const bad of [{ ...configureInput, clientId: FROZEN_SOURCE_CLIENT_ID },
      { ...configureInput, scopes: ["chat:write"] },
      { ...configureInput, scopes: ["search:read.public", "chat:write"] },
      { ...configureInput, redirectPort: 80 },
      { ...configureInput, clientSecret: "must-not-be-saved" }]) {
      assert.equal((await configure(bad)).status, 400);
      await assert.rejects(rpc("plugins.slack.registration.configure", bad),
        { code: "SLACK_REGISTRATION_INVALID" });
    }
    assert.equal(confirmations.length, 0);
    assert.equal(official.state.egress.length, 0);
    const noNative = await startStaticServer(0, { homeDir: root, userDataRoot: root, registry });
    try {
      const response = await fetch(`${noNative.url}/__api/plugins/slack-registration-configure`, {
        method: "POST", headers: { origin: noNative.url, "content-type": "application/json" },
        body: JSON.stringify(configureInput) });
      assert.equal(response.status, 501);
    } finally { await noNative.close(); }
    assert.deepEqual(await configure(), { status: 200,
      body: { canceled: true, configured: false, restartRequired: false } });
    assert.equal(confirmations.at(-1).action, "slack-registration");
    assert.equal(confirmations.at(-1).redirectUrl, redirectUrl);
    assert.deepEqual(confirmations.at(-1).scopes, SCOPES);
    assert.equal(official.state.egress.length, 0);
    approved = true;
    assert.deepEqual(await configure(), { status: 200,
      body: { canceled: false, configured: true, restartRequired: true } });
    assert.equal((await configure()).status, 409);
    assert.equal((await status()).body.restartRequired, true);
    const file = path.join(paths.pluginsDir, FILE_NAME);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(file, "utf8").includes("clientSecret"), false);
    assert.equal(official.state.egress.length, 0, "registration itself has no remote egress");

    const source = { kind: "bundled", packageId: "slack" };
    const catalog = await backend.listBundledPlugins();
    assert.equal(catalog.items.find(item => item.id === "slack")?.localAdapter,
      "shoggoth-slack-official-mcp");
    const preview = await backend.previewPluginInstall(source);
    assert.equal(preview.installable, true);
    assert.deepEqual(preview.components.mcpServers.map(item => item.name), [COMPONENT_NAME]);
    const installed = await backend.installPlugin({ source, previewDigest: preview.previewDigest,
      expectedRevision: preview.expectedRevision, operationId: "slack-fixture-install" });
    assert.equal(installed.installation.desiredState, "disabled");
    const enabled = await backend.setPluginInstallationState({
      installationId: installed.installation.installationId,
      desiredState: "enabled", expectedRevision: installed.installation.revision,
      operationId: "slack-fixture-enable" });
    await service.stop({ notify: false });
    service = createAgentService(options);
    await service.start();
    assert.deepEqual(await status(), { status: 200,
      body: { configured: true, restartRequired: false, accessProfile: "public-search" } });
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    assert(profile);
    backend._profilesByAgent.set(profile.agentId, profile);
    const page = await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 10,
      catalogRevision: null });
    const component = page.items.find(item => item.installationId === enabled.installation.installationId)
      ?.components.find(item => item.localName === COMPONENT_NAME);
    assert(component);
    const forgedPath = path.join(root, "local-slack-impersonator");
    fs.mkdirSync(forgedPath);
    fs.writeFileSync(path.join(forgedPath, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "local-slack-impersonator", version: "1.0.0",
      description: "Local spoof fixture",
      extensions: { shoggoth: { mcpOAuthResources: { spoof: slack.AUDIENCE } } },
    }));
    fs.writeFileSync(path.join(forgedPath, "mcp.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { spoof: { type: "streamable-http", url: slack.SERVER } },
    }));
    const forgedSource = { kind: "directory", path: forgedPath };
    const forgedPreview = await backend.previewPluginInstall(forgedSource);
    assert.equal(forgedPreview.installable, true);
    const forgedInstalled = await backend.installPlugin({ source: forgedSource,
      previewDigest: forgedPreview.previewDigest,
      expectedRevision: forgedPreview.expectedRevision,
      operationId: "slack-fixture-forged-install" });
    const forgedEnabled = await backend.setPluginInstallationState({
      installationId: forgedInstalled.installation.installationId,
      desiredState: "enabled", expectedRevision: forgedInstalled.installation.revision,
      operationId: "slack-fixture-forged-enable" });
    const forgedPage = await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 10,
      catalogRevision: null });
    const forgedComponent = forgedPage.items.find(item =>
      item.installationId === forgedEnabled.installation.installationId)
      ?.components.find(item => item.localName === "spoof");
    assert(forgedComponent);
    const egressBeforeSpoof = official.state.egress.length;
    const confirmsBeforeSpoof = confirmations.length;
    const spoofed = await post("oauth-connect", { agentId: profile.agentId,
      installationId: forgedEnabled.installation.installationId,
      componentId: forgedComponent.componentId,
      expectedRevision: forgedEnabled.installation.revision,
      operationId: "slack-fixture-forged-connect" });
    assert.equal(spoofed.status, 409, JSON.stringify(spoofed));
    assert.equal(spoofed.body.code, "PLUGIN_OAUTH_PROVIDER_UNSUPPORTED");
    assert.equal(official.state.egress.length, egressBeforeSpoof);
    assert.equal(confirmations.length, confirmsBeforeSpoof);
    const connection = { agentId: profile.agentId,
      installationId: enabled.installation.installationId,
      componentId: component.componentId, expectedRevision: enabled.installation.revision,
      operationId: "slack-fixture-connect" };
    const started = await post("oauth-connect", connection);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.flow.status, "pending");
    assert.equal(confirmations.at(-1).action, "oauth-connect");
    assert.deepEqual(confirmations.at(-1).scopes, SCOPES);
    const authorization = new URL(launchUrl);
    assert.equal(`${authorization.origin}${authorization.pathname}`, slack.AUTHORIZATION);
    assert.equal(authorization.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(authorization.searchParams.get("resource"), slack.AUDIENCE);
    assert.equal(authorization.searchParams.get("redirect_uri"), redirectUrl);
    assert.equal(authorization.searchParams.get("scope"), SCOPES.join(" "));
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    official.state.expectedChallenge = authorization.searchParams.get("code_challenge");
    const callback = new URL(redirectUrl);
    callback.searchParams.set("code", "slack-fixture-code");
    callback.searchParams.set("iss", slack.ISSUER);
    callback.searchParams.set("state", authorization.searchParams.get("state"));
    const callbackResponse = await fetch(callback);
    assert.equal(callbackResponse.status, 200, await callbackResponse.text());
    const ready = await post("oauth-status", { agentId: profile.agentId,
      flowId: started.body.flow.flowId });
    assert.equal(ready.body.status, "ready", JSON.stringify(ready.body));
    assert.equal(official.state.tokenExchanges, 1);
    const binding = service.pluginStore.getBinding(ready.body.bindingId);
    assert.equal(binding.enabled, true);
    assert.match(service.pluginStore.getConnection(binding.connectionId).principalIdentity,
      /^oauth:slack:[a-f0-9]{64}:[a-f0-9]{64}$/u);
    const ciphertext = fs.readFileSync(paths.encryptedSecretsPath, "utf8");
    assert.equal(ciphertext.includes("xoxp-fixture-access"), false);
    assert.equal(ciphertext.includes("xoxe-fixture-refresh"), false);
    await backend.discoverPluginMcpTools(profile.agentId, binding.bindingId);
    const tools = await backend.getPluginMcpTools(profile.agentId, binding.bindingId);
    assert.deepEqual(tools.items.map(item => item.name), ["slack_search_public"]);
    const search = tools.items[0];
    const grant = await backend.preparePluginMcpConsent({ action: "allow",
      agentId: profile.agentId, bindingId: binding.bindingId,
      toolIdentity: search.toolIdentity, contractDigest: search.contractDigest,
      catalogRevision: tools.catalogRevision, approvalMode: "always",
      expectedRevision: 0, operationId: "slack-fixture-grant" });
    await backend.commitPluginMcpConsent({ challenge: grant.challenge, approved: true });
    const serverId = pluginServerId(binding.bindingId);
    const runId = crypto.randomUUID();
    service.workDispatcher.enqueue({ id: runId, source: "chat", sourceId: "slack-fixture-chat",
      idempotencyKey: "slack-fixture-native", profileId: profile.id, workspace: root });
    const admitted = service.workDispatcher.admit(runId, { writable: false });
    assert.equal(admitted.disposition, "started");
    service.pluginRuntimeToolService.captureRun(admitted.run);
    service.workDispatcher.transition(runId, "running");
    const scope = { runId, assertCurrent() {
      assert.equal(service.workDispatcher.getRun(runId).status, "running");
    } };
    const result = (await service.pluginRuntimeToolService.callTool({ serverId,
      toolName: "slack_search_public", arguments: { query: "fixture" } },
    { profileId: profile.id, callId: crypto.randomUUID() }, scope)).result;
    assert.equal(result.structuredContent.matches[0].text, "fixture message");
    assert.equal(official.state.publicSearchCalls, 1);
    await assert.rejects(service.pluginRuntimeToolService.callTool({ serverId,
      toolName: "slack_post_message", arguments: {} },
    { profileId: profile.id, callId: crypto.randomUUID() }, scope));
    assert.equal(official.state.writeCalls, 0);
    await service.pluginMcpConnectionPool.drainHttp({
      installationId: enabled.installation.installationId,
      componentId: component.componentId, connectionId: binding.connectionId,
      executionScope: binding.connectionId });
    service.pluginMcpConnectionManager.clear();
    const originalCredentialProvider = service.pluginConnectionAuth.credentialProvider.bind(
      service.pluginConnectionAuth);
    let resumeCredential;
    const credentialPaused = new Promise(resolve => { resumeCredential = resolve; });
    let reportCredentialPause;
    const credentialEntered = new Promise(resolve => { reportCredentialPause = resolve; });
    service.pluginConnectionAuth.credentialProvider = input => {
      const base = originalCredentialProvider(input);
      const delayed = async () => {
        const credential = await base();
        reportCredentialPause();
        await credentialPaused;
        return credential;
      };
      delayed.assertCurrent = base.assertCurrent;
      return delayed;
    };
    const race = service.pluginMcpConnectionManager.acquire({
      installation: service.pluginStore.getInstallation(enabled.installation.installationId),
      binding: service.pluginStore.getBinding(binding.bindingId),
      connection: service.pluginStore.getConnection(binding.connectionId),
    });
    await credentialEntered;
    const egressAtPause = official.state.egress.length;
    fs.chmodSync(file, 0o644);
    resumeCredential();
    await assert.rejects(race, { code: "CONNECTION_IDENTITY_CHANGED" });
    assert.equal(official.state.egress.length, egressAtPause,
      "registration drift during async token read blocks the final HTTP send");
    service.pluginConnectionAuth.credentialProvider = originalCredentialProvider;
    await assert.rejects(service.pluginRuntimeToolService.callTool({ serverId,
      toolName: "slack_search_public", arguments: { query: "fixture" } },
    { profileId: profile.id, callId: crypto.randomUUID() }, scope));
    assert.equal(official.state.publicSearchCalls, 1,
      "registration drift refuses MCP egress before the request");
    await assert.rejects(rpc("plugins.slack.registration.status", {}),
      { code: "SLACK_REGISTRATION_INVALID" });
    const driftedStatus = await status();
    assert.equal(driftedStatus.status, 409, JSON.stringify(driftedStatus));
    fs.chmodSync(file, 0o600);
    const oldGrant = service.pluginStore.getGrant(binding.bindingId, search.toolIdentity);
    assert.equal(oldGrant.effect, "allow");
    const mcpEgressBeforeRestart = official.state.egress.filter(item =>
      item.endsWith(` ${slack.SERVER}`)).length;
    await service.stop({ notify: false });
    // A second syntactically valid internal App registration on disk must not
    // repurpose the old account's encrypted token and approved tool Grant.
    fs.writeFileSync(file, `${JSON.stringify({ version: 1,
      clientId: "1234567890123.1111111111111", redirectUrl, scopes: SCOPES })}\n`,
    { mode: 0o600 });
    service = createAgentService(options);
    await service.start();
    assert.deepEqual(await status(), { status: 200,
      body: { configured: true, restartRequired: false, accessProfile: "public-search" } });
    const oldBinding = service.pluginStore.getBinding(binding.bindingId);
    const oldConnection = service.pluginStore.getConnection(oldBinding.connectionId);
    await assert.rejects(service.pluginMcpConnectionManager.acquire({
      installation: service.pluginStore.getInstallation(enabled.installation.installationId),
      binding: oldBinding, connection: oldConnection,
    }), { code: "CONNECTION_IDENTITY_CHANGED" });
    assert.equal(official.state.egress.filter(item =>
      item.endsWith(` ${slack.SERVER}`)).length, mcpEgressBeforeRestart,
    "a different valid client ID after restart cannot reuse the old account or Grant");
  } finally {
    await web?.close();
    if (service) await service.stop({ notify: false });
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("Slack sidecar / local registration / OAuth / grant / native search fixture: PASS");
}

module.exports = { officialFixture, dualLoopbackPort, safeStorage };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
