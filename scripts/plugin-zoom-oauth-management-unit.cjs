"use strict";

// Frozen Zoom meeting MCP, Shoggoth-owned confidential OAuth client, and
// local protocol fixture. No Zoom account or remote request is involved.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { startStaticServer } = require("../app/static-server");
const { createFixture } = require("./plugin-real-host-service-fixture.cjs");
const { BundledPluginCatalog, bundledRoot } = require("../app/core/bundled-plugin-catalog");
const { pluginServerId } = require("../app/agent-service/plugin-runtime-tool-service");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { ensureCredential } = require("../app/agent-service/external-plugin-adapter-auth");
const { loadPluginOAuthProviders } = require("../app/agent-service/plugin-oauth-config");
const { loadZoomRegistration } = require("../app/agent-service/plugin-zoom-registration");
const { PluginOAuthProviderRegistry } = require("../app/agent-service/plugin-oauth-provider-registry");
const { SERVER, ISSUER, AUTHORIZATION, TOKEN, IDENTITY, METADATA_URLS,
  MEETING_SCOPES, IDENTITY_SCOPE } = require("../app/agent-service/plugin-zoom-oauth");

const CLIENT_ID = "shoggoth-zoom-owned-fixture-client";
const CLIENT_SECRET = "zoom-fixture-secret-only-in-encrypted-store";
const SECRET_REF = "plugin-zoom-client-00000000-0000-4000-8000-000000000001";
const SCOPES = [IDENTITY_SCOPE, MEETING_SCOPES[0]];
const ACCESS = "zoom-fixture-access-account-a";
const REFRESH = "zoom-fixture-refresh-account-a";
const TOOLS = [{ name: "search_meetings", description: "Find meetings", inputSchema: {
  type: "object", properties: { query: { type: "string" } }, required: ["query"] } }];

function safeStorageFixture(key) {
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

function providerFixture() {
  const state = { requests: [], codes: new Map(), exchanges: 0, probes: 0, calls: 0 };
  const basic = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
  const fetchImpl = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    state.requests.push(`${request.method} ${url.href}`);
    assert.ok(url.href === SERVER || url.href === TOKEN || url.href === IDENTITY
      || METADATA_URLS.includes(url.href), `unexpected Zoom fixture egress ${url.href}`);
    if (request.method === "GET" && METADATA_URLS.slice(0, 2).includes(url.href)) {
      return Response.json({ resource: SERVER, authorization_servers: [ISSUER],
        scopes_supported: SCOPES });
    }
    if (request.method === "GET" && METADATA_URLS.slice(2).includes(url.href)) {
      return Response.json({ issuer: ISSUER, authorization_endpoint: AUTHORIZATION,
        token_endpoint: TOKEN, response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true });
    }
    if (url.href === TOKEN && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      state.tokenAttempt = { authMatches: request.headers.get("authorization") === basic,
        formKeys: [...form.keys()], resource: form.get("resource"),
        codeKnown: state.codes.has(form.get("code")) };
      assert.equal(request.headers.get("authorization"), basic,
        "SDK must send registered client credentials via Basic");
      assert.equal(form.has("client_secret"), false);
      assert.equal(form.has("client_id"), false);
      assert.equal(form.get("resource"), SERVER);
      if (form.get("grant_type") === "refresh_token") {
        assert.equal(form.get("refresh_token"), REFRESH);
        state.refreshes = (state.refreshes || 0) + 1;
        return Response.json({ access_token: "zoom-fixture-refreshed-account-a",
          refresh_token: REFRESH, token_type: "Bearer", expires_in: 3600,
          scope: SCOPES.join(" ") });
      }
      const pending = state.codes.get(form.get("code"));
      state.tokenAttempt.redirectMatches = form.get("redirect_uri") === pending?.redirect;
      state.tokenAttempt.challengeMatches = crypto.createHash("sha256")
        .update(form.get("code_verifier") || "").digest("base64url") === pending?.challenge;
      assert(pending, "unknown fixture authorization code");
      assert.equal(form.get("redirect_uri"), pending.redirect);
      assert.equal(crypto.createHash("sha256").update(form.get("code_verifier") || "")
        .digest("base64url"), pending.challenge);
      state.codes.delete(form.get("code"));
      state.exchanges += 1;
      return Response.json({ access_token: ACCESS, refresh_token: REFRESH,
        token_type: "Bearer", expires_in: 3600, scope: SCOPES.join(" ") });
    }
    if (url.href === IDENTITY && request.method === "GET") {
      assert.equal(request.headers.get("authorization"), `Bearer ${ACCESS}`);
      state.probes += 1;
      return Response.json({ id: "user_a", account_id: "account_a", email: "private@example.test" });
    }
    if (url.href === SERVER && request.method === "GET") {
      return new Response(null, { status: 405 });
    }
    if (url.href === SERVER && request.method === "POST") {
      assert.equal(request.headers.get("authorization"), `Bearer ${ACCESS}`);
      const rpc = JSON.parse(await request.text());
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      let result;
      if (rpc.method === "server/discover") {
        return Response.json({ jsonrpc: "2.0", id: rpc.id,
          error: { code: -32601, message: "Method not found" } });
      }
      if (rpc.method === "initialize") result = { protocolVersion: "2025-11-25",
        capabilities: { tools: {} }, serverInfo: { name: "zoom-meeting-fixture", version: "1" } };
      else if (rpc.method === "tools/list") result = { tools: TOOLS };
      else if (rpc.method === "tools/call") {
        assert.equal(rpc.params?.name, "search_meetings");
        assert.equal(rpc.params?.arguments?.query, "release");
        state.calls += 1;
        result = { content: [{ type: "text", text: "Fixture meeting" }],
          structuredContent: { meetings: [{ id: "meeting_a", topic: "release" }] },
          isError: false };
      } else assert.fail(`unsupported MCP request ${rpc.method}`);
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
    }
    assert.fail(`unsupported Zoom fixture request ${request.method} ${url.href}`);
  };
  return { state, fetchImpl };
}

function hermesProbe(serviceRoot, commands) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.SHOGGOTH_TEST_PYTHON_BIN || "python3",
      [path.join(__dirname, "plugin-three-host-hermes-probe.py")], {
        env: { ...process.env, SHOGGOTH_THREE_HOST_SERVICE_ROOT: serviceRoot,
          PYTHONDONTWRITEBYTECODE: "1" }, stdio: ["pipe", "pipe", "pipe"],
      });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 20_000);
    child.stdout.on("data", bytes => { stdout += bytes; });
    child.stderr.on("data", bytes => { stderr += bytes; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`Hermes probe exited ${code}: ${stderr}`)); return; }
      try { resolve(JSON.parse(stdout)); }
      catch (error) { reject(new Error(`Hermes response invalid: ${error.message}`)); }
    });
    child.stdin.end(JSON.stringify({ commands }));
  });
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sgzo-")));
  const key = crypto.randomBytes(32);
  const provider = providerFixture();
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    return url.href === SERVER ? provider.fetchImpl(input, init) : nativeFetch(input, init);
  };
  // Zoom is a hidden package since the 2026-10-02 catalog scope, so the App
  // catalog no longer offers it. The retained package and its frozen catalog
  // entry form a fixture catalog that keeps the OAuth management path covered.
  assert.equal(new BundledPluginCatalog(bundledRoot()).get("zoom"), null, "Zoom is not in the App catalog");
  const catalogRoot = path.join(root, "bundled-plugins");
  fs.cpSync(path.join(bundledRoot(), "packages", "zoom"), path.join(catalogRoot, "packages", "zoom"), { recursive: true });
  const zoomEntry = require("./fixtures/plugins/zoom-hidden-catalog-entry.json");
  fs.writeFileSync(path.join(catalogRoot, "catalog.json"), JSON.stringify({ version: 4,
    batchDigest: crypto.createHash("sha256").update(zoomEntry.sourceDigest).digest("hex"), packages: [zoomEntry] }));
  const fixture = createFixture(root, "openclaw", { safeStorage: safeStorageFixture(key),
    pluginOAuthFetch: provider.fetchImpl, bundledPluginCatalog: new BundledPluginCatalog(catalogRoot) });
  const paths = fixture.paths;
  fs.mkdirSync(paths.pluginsDir, { recursive: true, mode: 0o700 });
  const callbackBlocker = http.createServer((_request, response) => { response.writeHead(503); response.end(); });
  await new Promise((resolve, reject) => {
    callbackBlocker.once("error", reject);
    callbackBlocker.listen(0, "127.0.0.1", resolve);
  });
  const redirectUrl = `http://127.0.0.1:${callbackBlocker.address().port}/oauth/callback`;
  const privateProvider = { version: 1, providers: [{ id: "zoom-meetings", name: "Zoom Meetings",
    serverUrl: SERVER, issuer: ISSUER, audience: SERVER,
    authorizationEndpoint: AUTHORIZATION, tokenEndpoint: TOKEN,
    clientId: CLIENT_ID, clientSecretRef: SECRET_REF, scopes: SCOPES,
    metadataUrls: METADATA_URLS, identity: { url: IDENTITY, subjectField: "id" },
    redirectUrl }] };
  fs.writeFileSync(path.join(paths.pluginsDir, "oauth-providers.json"),
    JSON.stringify(privateProvider), { mode: 0o600 });
  assert.throws(() => loadPluginOAuthProviders(paths),
    { code: "PLUGIN_OAUTH_CONFIG_INVALID" }, "a private file cannot self-register a Zoom client");
  const providerFile = path.join(paths.pluginsDir, "oauth-providers.json");
  fs.writeFileSync(providerFile, JSON.stringify({ ...privateProvider, providers: [{
    ...privateProvider.providers[0], clientId: "<ZOOM_PUBLIC_CLIENT_ID>",
  }] }), { mode: 0o600 });
  assert.throws(() => loadPluginOAuthProviders(paths, { registeredZoomClientId: CLIENT_ID }),
    { code: "PLUGIN_OAUTH_CONFIG_INVALID" }, "frozen source client placeholder cannot become authority");
  fs.writeFileSync(providerFile, JSON.stringify(privateProvider), { mode: 0o600 });
  assert.equal(JSON.stringify(privateProvider).includes(CLIENT_SECRET), false);
  fs.unlinkSync(providerFile);
  let service, web, runId;
  try {
    service = await fixture.start();
    const backend = new ShoggothBackend({ paths });
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    backend._profilesByAgent.set(profile.agentId, profile);
    const source = { kind: "bundled", packageId: "zoom" };
    const preview = await backend.previewPluginInstall(source);
    assert.equal(preview.installable, true);
    assert(preview.components.mcpServers.some(item => item.name === "zoom"));
    assert(preview.diagnostics.some(item => item.reasonCode === "CODEX_OAUTH_CLIENT_REGISTRATION_REQUIRED"));
    assert.equal(JSON.stringify(preview).includes("<ZOOM_PUBLIC_CLIENT_ID>"), false);
    const installed = await backend.installPlugin({ source, previewDigest: preview.previewDigest,
      expectedRevision: preview.expectedRevision ?? 0, operationId: "zoom-fixture-install" });
    const enabled = await backend.setPluginInstallationState({
      installationId: installed.installation.installationId, desiredState: "enabled",
      expectedRevision: installed.installation.revision, operationId: "zoom-fixture-enable" });
    const page = await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 10,
      catalogRevision: null });
    const component = page.items.find(item => item.installationId === installed.installation.installationId)
      ?.components.find(item => item.localName === "zoom");
    assert(component);
    const connection = { agentId: profile.agentId, installationId: enabled.installation.installationId,
      componentId: component.componentId, expectedRevision: enabled.installation.revision,
      operationId: "zoom-fixture-connect" };
    await assert.rejects(backend.preparePluginOAuth(connection),
      error => error.code === "PLUGIN_OAUTH_PROVIDER_UNSUPPORTED");
    assert.equal(provider.state.requests.length, 0, "unregistered client fails before IO");
    const configure = await requestService(paths, { token: readClientToken(paths),
      version: SERVICE_PROTOCOL_VERSION, method: "plugins.zoom.registration.configure",
      params: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
        redirectPort: callbackBlocker.address().port, scopes: SCOPES } },
    { timeoutMs: 10_000 });
    assert.deepEqual(configure, { configured: true, restartRequired: true,
      provider: "zoom-meetings" });
    assert.equal(JSON.stringify(configure).includes(CLIENT_SECRET), false);
    await assert.rejects(requestService(paths, { token: readClientToken(paths),
      version: SERVICE_PROTOCOL_VERSION, method: "plugins.zoom.registration.configure",
      params: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
        redirectPort: callbackBlocker.address().port, scopes: SCOPES } },
    { timeoutMs: 10_000 }), { code: "PLUGIN_REQUEST_INVALID" });
    const registered = loadZoomRegistration(paths);
    assert.equal(registered.clientId, CLIENT_ID);
    assert.equal(JSON.stringify(registered).includes(CLIENT_SECRET), false);
    assert.equal(fs.readFileSync(path.join(paths.pluginsDir,
      "zoom-client-registration.json"), "utf8").includes(CLIENT_SECRET), false);
    const secretRef = registered.provider.clientSecretRef;
    const clientSecretFingerprint = service.secretStore.getCredentialFingerprint(secretRef);
    service = await fixture.restart();
    let launchUrl;
    web = await startStaticServer(0, { homeDir: root, userDataRoot: root,
      registry: { route: id => backend._profilesByAgent.has(id) ? backend : null,
        backends: new Map([["shoggoth", backend]]) },
      hostOps: { async confirmPluginCapability(summary) {
        assert.equal(summary.action, "oauth-connect");
        assert.deepEqual(summary.scopes, SCOPES);
        assert.equal(JSON.stringify(summary).includes(CLIENT_SECRET), false);
        return true;
      }, async openExternal(url) { launchUrl = url; } } });
    const post = async (route, input, origin = web.url) => {
      const response = await nativeFetch(`${web.url}/__api/plugins/${route}`, { method: "POST",
        headers: { origin, "content-type": "application/json" }, body: JSON.stringify(input) });
      const raw = await response.text();
      let body;
      try { body = JSON.parse(raw); } catch { body = { error: raw }; }
      for (const secret of [CLIENT_SECRET, ACCESS, REFRESH, SECRET_REF,
        "<ZOOM_PUBLIC_CLIENT_ID>"]) assert.equal(JSON.stringify(body).includes(secret), false);
      return { status: response.status, body };
    };
    assert.equal((await post("oauth-connect", connection, "https://evil.example")).status, 403);
    assert.equal((await post("oauth-connect", { ...connection, clientId: "foreign" })).status, 400);
    const occupied = await post("oauth-connect", { ...connection, operationId: "zoom-fixture-occupied" });
    assert.notEqual(occupied.status, 200);
    assert.equal(launchUrl, undefined);
    await new Promise(resolve => callbackBlocker.close(resolve));
    const started = await post("oauth-connect", connection);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.flow.status, "pending");
    const authorization = new URL(launchUrl);
    assert.equal(authorization.origin, new URL(AUTHORIZATION).origin);
    assert.equal(authorization.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(authorization.searchParams.get("redirect_uri"), redirectUrl);
    assert.equal(authorization.searchParams.get("resource"), SERVER);
    assert.equal(authorization.searchParams.get("scope"), SCOPES.join(" "));
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    provider.state.codes.set("zoom-fixture-code", { redirect: redirectUrl,
      challenge: authorization.searchParams.get("code_challenge") });
    const callback = new URL(redirectUrl);
    callback.searchParams.set("code", "zoom-fixture-code");
    callback.searchParams.set("iss", ISSUER);
    callback.searchParams.set("state", authorization.searchParams.get("state"));
    const callbackResponse = await nativeFetch(callback);
    assert.equal(callbackResponse.status, 200,
      `${await callbackResponse.text()}; requests: ${provider.state.requests.join(", ")}; token: ${JSON.stringify(provider.state.tokenAttempt)}`);
    const ready = await post("oauth-status", { agentId: profile.agentId,
      flowId: started.body.flow.flowId });
    assert.equal(ready.body.status, "ready", JSON.stringify(ready.body));
    assert.equal(provider.state.exchanges, 1);
    assert.equal(provider.state.probes, 1);
    const binding = service.pluginStore.getBinding(ready.body.bindingId);
    assert.equal(binding.enabled, true);
    assert.equal(service.pluginStore.getGrantCountsForBinding(binding.bindingId).allow, 0);
    const active = service.pluginStore.getConnection(binding.connectionId);
    assert.match(active.principalIdentity, /^oauth:zoom-meetings:[a-f0-9]{64}$/u);
    const ciphertext = fs.readFileSync(paths.encryptedSecretsPath, "utf8");
    for (const secret of [CLIENT_SECRET, ACCESS, REFRESH]) assert.equal(ciphertext.includes(secret), false);
    assert.equal(service.secretStore.getCredentialFingerprint(secretRef), clientSecretFingerprint,
      "OAuth token write must not invalidate the independent registered client secret");
    service = await fixture.restart();
    assert.equal(service.secretStore.getCredentialFingerprint(secretRef), clientSecretFingerprint);
    assert.equal(service.pluginStore.getBinding(binding.bindingId).enabled, true);
    const registry = new PluginOAuthProviderRegistry({
      providers: [loadZoomRegistration(paths).provider],
      registeredZoomClientId: CLIENT_ID, secretStore: service.secretStore,
      fetchImpl: provider.fetchImpl });
    const refreshed = await registry.refreshTokens({ endpointIdentity: SERVER,
      issuer: ISSUER, audience: SERVER, scopes: SCOPES, refreshToken: REFRESH });
    assert.equal(refreshed.access_token, "zoom-fixture-refreshed-account-a");
    assert.equal(provider.state.refreshes, 1);
    const badMetadata = new PluginOAuthProviderRegistry({
      providers: [loadZoomRegistration(paths).provider],
      registeredZoomClientId: CLIENT_ID, secretStore: service.secretStore,
      fetchImpl: async () => Response.json({ issuer: "https://attacker.example/",
        authorization_endpoint: AUTHORIZATION, token_endpoint: TOKEN,
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
        code_challenge_methods_supported: ["S256"] }),
    });
    await assert.rejects(badMetadata.fetchFor(SERVER)(METADATA_URLS[2]),
      { code: "CONNECTION_AUTH_REQUIRED" });
    await backend.discoverPluginMcpTools(profile.agentId, binding.bindingId);
    const catalog = await backend.getPluginMcpTools(profile.agentId, binding.bindingId);
    const tool = catalog.items.find(item => item.name === "search_meetings");
    assert(tool);
    const grant = await backend.preparePluginMcpConsent({ action: "allow", agentId: profile.agentId,
      bindingId: binding.bindingId, toolIdentity: tool.toolIdentity,
      contractDigest: tool.contractDigest, catalogRevision: catalog.catalogRevision,
      approvalMode: "always", expectedRevision: 0, operationId: "zoom-fixture-grant" });
    await backend.commitPluginMcpConsent({ challenge: grant.challenge, approved: true });
    const serverId = pluginServerId(binding.bindingId);
    runId = crypto.randomUUID();
    service.workDispatcher.enqueue({ id: runId, source: "chat", sourceId: "zoom-fixture-chat",
      idempotencyKey: "zoom-fixture-native", profileId: profile.id, workspace: root });
    const admitted = service.workDispatcher.admit(runId, { writable: false });
    assert.equal(admitted.disposition, "started");
    service.pluginRuntimeToolService.captureRun(admitted.run);
    // Plugin tool calls run inside the Run's frozen Hook snapshot (Agent hooks).
    service.hookService.freezeRun(admitted.run, profile);
    service.workDispatcher.transition(runId, "running");
    const scope = { runId, assertCurrent() {
      assert.equal(service.workDispatcher.getRun(runId).status, "running");
    } };
    const result = (await service.pluginRuntimeToolService.callTool({ serverId,
      toolName: "search_meetings", arguments: { query: "release" } },
    { profileId: profile.id, callId: crypto.randomUUID() }, scope)).result;
    assert.equal(result.structuredContent.meetings[0].id, "meeting_a");
    assert.equal(provider.state.calls, 1);
    const rpc = (method, params, options = {}) => requestService(paths, {
      version: SERVICE_PROTOCOL_VERSION, method, params,
    }, { timeoutMs: options.timeoutMs || 10_000 });
    const { createAdapter } = await import(pathToFileURL(path.join(__dirname,
      "../resources/external-plugin-adapters/openclaw/index.mjs")).href);
    const openclaw = createAdapter({ instanceId: "openclaw-zoom-fixture",
      credential: () => fixture.credential,
      requestService: (method, params, options) => rpc(method, params, options) });
    const context = { agentId: "openclaw-zoom-agent", sessionId: "openclaw-zoom-session",
      runId: "openclaw-zoom-run" };
    const openclawInvoke = async (name, args) => {
      const toolCallId = `openclaw-zoom-${crypto.randomUUID()}`;
      assert.equal(openclaw.beforeToolCall({ toolName: name, toolCallId,
        runId: context.runId }, context), undefined);
      return (await openclaw.tool(name, context).execute(toolCallId, args)).details;
    };
    const discovered = await openclawInvoke("shoggoth_capability_search", { query: "meeting" });
    assert(discovered.items.some(item => item.serverId === serverId && item.name === "search_meetings"));
    const externalArgs = { serverId, toolName: "search_meetings", arguments: { query: "release" } };
    assert.equal((await openclawInvoke("shoggoth_plugin_call", externalArgs))
      .result.structuredContent.meetings[0].id, "meeting_a");
    ensureCredential(paths, "hermes");
    const hermes = await hermesProbe(paths.userDataRoot, [
      { name: "shoggoth_capability_search", args: { query: "meeting" } },
      { name: "shoggoth_plugin_call", args: externalArgs },
    ]);
    assert(hermes[0].items.some(item => item.serverId === serverId && item.name === "search_meetings"));
    assert.equal(hermes[1].result.structuredContent.meetings[0].id, "meeting_a");
    assert.equal(provider.state.exchanges, 1, "all three hosts share one verified account");
    assert.equal(provider.state.calls, 3);
    const audit = (await fixture.listAuditedCalls(null)).items.filter(item =>
      item.bindingId === binding.bindingId);
    assert.deepEqual(new Set(audit.map(item => item.backendId)), new Set(["openclaw", "hermes"]));
    const disconnected = await backend.preparePluginDisconnect({ agentId: profile.agentId,
      bindingId: binding.bindingId, expectedRevision: binding.revision,
      operationId: "zoom-fixture-disconnect" });
    await backend.commitPluginDisconnect({ challenge: disconnected.challenge, approved: true });
    await assert.rejects(service.pluginRuntimeToolService.callTool({ serverId,
      toolName: "search_meetings", arguments: { query: "release" } },
    { profileId: profile.id, callId: crypto.randomUUID() }, scope),
    error => ["GRANT_REVOKED", "CONNECTION_IDENTITY_CHANGED", "PLUGIN_COMPONENT_INACTIVE"].includes(error.code));
    await assert.rejects(openclawInvoke("shoggoth_plugin_call", externalArgs),
      error => error.code === "CAPABILITY_FORBIDDEN");
    assert.equal(provider.state.calls, 3, "revoked account cannot reach Zoom MCP");
    const rotating = await post("oauth-connect", { ...connection,
      operationId: "zoom-fixture-secret-rotation" });
    assert.equal(rotating.status, 200);
    const rotationAuthorization = new URL(launchUrl);
    const tokenRequestsBeforeRotation = provider.state.requests.filter(item =>
      item === `POST ${TOKEN}`).length;
    await service.secretStore.put(secretRef, "zoom-fixture-rotated-client-secret",
      { kind: "zoom-oauth-client" });
    assert.notEqual(service.secretStore.getCredentialFingerprint(secretRef), clientSecretFingerprint);
    const rotatedCallback = new URL(redirectUrl);
    rotatedCallback.searchParams.set("code", "unredeemed-after-secret-rotation");
    rotatedCallback.searchParams.set("iss", ISSUER);
    rotatedCallback.searchParams.set("state", rotationAuthorization.searchParams.get("state"));
    assert.equal((await nativeFetch(rotatedCallback)).status, 400);
    assert.equal(provider.state.requests.filter(item => item === `POST ${TOKEN}`).length,
      tokenRequestsBeforeRotation, "rotated client secret cancels pending flow before token IO");
    assert.equal((await post("oauth-status", { agentId: profile.agentId,
      flowId: rotating.body.flow.flowId })).body.status, "failed");
    console.log("plugin-zoom-oauth-management-unit: PASS");
  } finally {
    if (service && runId && service.workDispatcher.getRun(runId)?.status === "running") {
      service.pluginRuntimeToolService.releaseRun(runId);
      service.workDispatcher.transition(runId, "completed");
    }
    await web?.close();
    await fixture.stop();
    if (callbackBlocker.listening) await new Promise(resolve => callbackBlocker.close(resolve));
    globalThis.fetch = nativeFetch;
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
