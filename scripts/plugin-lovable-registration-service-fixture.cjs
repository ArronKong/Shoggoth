"use strict";

// Local protocol fixture: frozen sidecar install and Lovable's public DCR
// contract cross REST, Backend, native confirmation and authenticated Service.
// It never contacts Lovable or signs in to a real account.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService } = require("../app/agent-service/server");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { startStaticServer } = require("../app/static-server");
const { SERVER, RESOURCE, ISSUER, RESOURCE_METADATA, AUTH_METADATA,
  REGISTRATION_ENDPOINT, REGISTRATION_FILE, loadLovableRegistration } =
  require("../app/agent-service/plugin-lovable-official-oauth");
const { COMPONENT_NAME } = require("../app/agent-service/plugin-lovable-official-sidecar");
const { pluginServerId } = require("../app/agent-service/plugin-runtime-tool-service");
const { PENDING_FILE } = require("../app/agent-service/plugin-lovable-registration");

const PORT = 45678;
const REDIRECT = `http://127.0.0.1:${PORT}/oauth/callback`;
const CLIENT_ID = "shoggoth-lovable-local-fixture";

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

function officialFixture() {
  const requests = [];
  const codes = new Map();
  const state = { getMeCalls: 0, workspaceCalls: 0, deployCalls: 0,
    registrationPosts: 0, loseNextRegistrationReceipt: false };
  const fetchImpl = async (input, init = {}) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, method: request.method,
      redirect: request.redirect, body: request.method === "POST" ? await request.clone().text() : null });
    if (request.url === RESOURCE_METADATA && request.method === "GET") {
      return Response.json({ resource: RESOURCE, authorization_servers: [ISSUER],
        scopes_supported: ["workspaces:read", "projects:read"] });
    }
    if (request.url === AUTH_METADATA && request.method === "GET") {
      return Response.json({ issuer: ISSUER,
        authorization_endpoint: "https://lovable.dev/oauth/authorize",
        token_endpoint: "https://lovable.dev/oauth/token",
        registration_endpoint: REGISTRATION_ENDPOINT,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"] });
    }
    if (request.url === REGISTRATION_ENDPOINT && request.method === "POST") {
      state.registrationPosts += 1;
      const body = JSON.parse(await request.text());
      assert.deepEqual(body, { client_name: "Shoggoth (local)",
        redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"], token_endpoint_auth_method: "none",
        scope: "workspaces:read" });
      if (state.loseNextRegistrationReceipt) {
        state.loseNextRegistrationReceipt = false;
        throw new Error("synthetic lost DCR receipt after remote creation");
      }
      return Response.json({ client_id: CLIENT_ID, redirect_uris: [REDIRECT],
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
        token_endpoint_auth_method: "none" }, { status: 201 });
    }
    if (request.url === "https://lovable.dev/oauth/token" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      const code = form.get("code");
      const pending = codes.get(code);
      assert(pending, "unknown fixture authorization code");
      assert.equal(form.get("client_id"), CLIENT_ID);
      assert.equal(form.get("redirect_uri"), REDIRECT);
      assert.equal(form.get("resource"), RESOURCE);
      assert.equal(crypto.createHash("sha256").update(form.get("code_verifier") || "")
        .digest("base64url"), pending.challenge);
      codes.delete(code);
      return Response.json({ access_token: "lovable-fixture-access-user-a",
        refresh_token: "lovable-fixture-refresh-user-a", token_type: "Bearer",
        expires_in: 3600, scope: "workspaces:read" });
    }
    if (request.url === `${SERVER}/` && request.method === "GET") {
      return new Response(null, { status: 405 });
    }
    if (request.url === `${SERVER}/` && request.method === "POST") {
      assert.equal(request.headers.get("authorization"), "Bearer lovable-fixture-access-user-a");
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
          serverInfo: { name: "lovable-fixture", version: "1" }, capabilities: { tools: {} } };
      } else if (message.method === "tools/list") {
        result = { tools: [
          { name: "get_me", description: "Read current user",
            inputSchema: { type: "object", properties: {}, required: [] } },
          { name: "list_workspaces", description: "List workspaces",
            inputSchema: { type: "object", properties: {} } },
          { name: "deploy_project", description: "Write: publish project",
            inputSchema: { type: "object", properties: { project_id: { type: "string" } } } },
        ] };
      } else if (message.method === "tools/call") {
        if (message.params?.name === "get_me") {
          assert.deepEqual(message.params.arguments, {});
          state.getMeCalls += 1;
          result = { structuredContent: { user: { id: "lovable-user-a" } },
            content: [{ type: "text", text: "fixture user" }], isError: false };
        } else if (message.params?.name === "list_workspaces") {
          state.workspaceCalls += 1;
          result = { structuredContent: { workspaces: [{ id: "workspace-a" }] },
            content: [{ type: "text", text: "fixture workspace" }], isError: false };
        } else if (message.params?.name === "deploy_project") {
          state.deployCalls += 1;
          throw new Error("write tool must never reach Lovable fixture");
        } else throw new Error(`unknown MCP tool ${message.params?.name}`);
      } else throw new Error(`unexpected MCP method ${message.method}`);
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    }
    throw new Error(`unexpected Lovable fixture egress: ${request.method} ${request.url}`);
  };
  return { requests, codes, state, fetchImpl };
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join("/private/tmp", "sglo-")));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "user"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const key = crypto.randomBytes(32);
  const official = officialFixture();
  const options = { paths, safeStorage: safeStorage(key), parentEnv: {},
    prewarmMcpAuth: false, version: "plugin-lovable-registration-fixture",
    pluginLovableRegistrationFetch: official.fetchImpl,
    pluginOAuthFetch: official.fetchImpl,
    pluginLovableMcpFetch: official.fetchImpl };
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
        confirmations.push(summary);
        return approved;
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
    const status = () => post("lovable-registration-status", {});
    const configure = (body = { redirectPort: PORT }, headers = {}) =>
      post("lovable-registration-configure", body, headers);
    const reconcile = (body = { reviewedRemoteOutcome: true }, headers = {}) =>
      post("lovable-registration-reconcile", body, headers);
    assert.deepEqual(await status(), { status: 200,
      body: { configured: false, restartRequired: false, needsVerification: false } });
    assert.equal(loadLovableRegistration(paths), null);
    assert.deepEqual(await backend.getPluginLovableRegistrationStatus(),
      { configured: false, restartRequired: false, needsVerification: false });
    await assert.rejects(rpc("plugins.lovable.registration.status", {}, "wrong"),
      { code: "AUTH_FAILED" });
    await assert.rejects(rpc("plugins.lovable.registration.status", { extra: true }),
      { code: "PLUGIN_REQUEST_INVALID" });
    assert.equal((await configure(undefined, { origin: "https://evil.example" })).status, 403);
    assert.equal((await configure(undefined, { "sec-fetch-site": "cross-site" })).status, 403);
    for (const bad of [{ redirectPort: 80 }, { redirectPort: "45678" },
      { redirectPort: PORT, clientId: "untrusted" }]) {
      assert.equal((await configure(bad)).status, 400);
      await assert.rejects(rpc("plugins.lovable.registration.configure", bad),
        { code: "LOVABLE_REGISTRATION_INVALID" });
    }
    assert.equal(confirmations.length, 0);
    assert.equal(official.requests.length, 0);
    const noNative = await startStaticServer(0, { homeDir: root, userDataRoot: root, registry });
    try {
      const response = await fetch(`${noNative.url}/__api/plugins/lovable-registration-configure`, {
        method: "POST", headers: { origin: noNative.url, "content-type": "application/json" },
        body: JSON.stringify({ redirectPort: PORT }) });
      assert.equal(response.status, 501);
    } finally { await noNative.close(); }
    assert.deepEqual(await configure(), { status: 200,
      body: { canceled: true, configured: false, restartRequired: false,
        needsVerification: false } });
    assert.equal(official.requests.length, 0, "native cancellation precedes all DCR egress");
    assert.equal(confirmations[0].action, "lovable-registration");
    assert.equal(confirmations[0].redirectUrl, REDIRECT);
    assert.deepEqual(confirmations[0].scopes, ["workspaces:read"]);
    approved = true;
    official.state.loseNextRegistrationReceipt = true;
    const uncertain = await configure();
    assert.equal(uncertain.status, 409);
    assert.equal(official.state.registrationPosts, 1,
      "remote registration was accepted before its reply was lost");
    assert.deepEqual(await status(), { status: 200,
      body: { configured: false, restartRequired: false, needsVerification: true } });
    const pendingFile = path.join(paths.pluginsDir, PENDING_FILE);
    assert.equal(fs.statSync(pendingFile).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(pendingFile, "utf8")),
      { version: 1, redirectPort: PORT });
    const confirmationsBeforeRetry = confirmations.length;
    assert.deepEqual(await configure(), { status: 409,
      body: { error: "Prior Lovable registration needs verification",
        code: "LOVABLE_REGISTRATION_NEEDS_VERIFICATION" } });
    assert.equal(confirmations.length, confirmationsBeforeRetry,
      "pending outcome blocks another native approval and DCR request");
    await assert.rejects(rpc("plugins.lovable.registration.configure", { redirectPort: PORT }),
      { code: "LOVABLE_REGISTRATION_NEEDS_VERIFICATION" });
    assert.equal(official.state.registrationPosts, 1);
    await service.stop({ notify: false });
    service = createAgentService(options);
    await service.start();
    assert.equal((await status()).body.needsVerification, true,
      "uncertain remote outcome survives a Service restart");
    assert.equal((await reconcile(undefined, { origin: "https://evil.example" })).status, 403);
    assert.equal((await reconcile({ reviewedRemoteOutcome: false })).status, 400);
    approved = false;
    assert.deepEqual(await reconcile(), { status: 200,
      body: { canceled: true, configured: false, restartRequired: false,
        needsVerification: true } });
    assert.equal(fs.existsSync(pendingFile), true,
      "native cancellation preserves the uncertain-outcome marker");
    approved = true;
    assert.deepEqual(await reconcile(), { status: 200,
      body: { canceled: false, configured: false, restartRequired: false,
        needsVerification: false } });
    assert.equal(confirmations.at(-1).action, "lovable-registration-reconcile");
    assert.equal(fs.existsSync(pendingFile), false);
    assert.equal(official.state.registrationPosts, 1,
      "explicit local reconciliation itself sends no remote request");
    assert.deepEqual(await configure(), { status: 200,
      body: { canceled: false, configured: true, restartRequired: true,
        needsVerification: false } });
    assert.deepEqual(official.requests.map(item => `${item.method} ${item.url}`), [
      `GET ${RESOURCE_METADATA}`, `GET ${AUTH_METADATA}`, `POST ${REGISTRATION_ENDPOINT}`,
      `GET ${RESOURCE_METADATA}`, `GET ${AUTH_METADATA}`, `POST ${REGISTRATION_ENDPOINT}`]);
    assert.equal(official.requests.every(item => item.redirect === "manual"), true);
    const file = path.join(paths.pluginsDir, REGISTRATION_FILE);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(file, "utf8").includes("asdk_app_"), false);
    assert.equal(loadLovableRegistration(paths).clientId, CLIENT_ID);
    assert.equal((await configure()).status, 409);
    assert.equal(official.requests.length, 6, "existing client cannot register again");
    assert.deepEqual(await status(), { status: 200,
      body: { configured: true, restartRequired: true, needsVerification: false } });

    const source = { kind: "bundled", packageId: "lovable" };
    const catalog = await backend.listBundledPlugins();
    assert.equal(catalog.items.find(item => item.id === "lovable")?.localAdapter,
      "shoggoth-lovable-official-mcp");
    const preview = await backend.previewPluginInstall(source);
    assert.equal(preview.installable, true);
    assert.deepEqual(preview.components.mcpServers.map(item => item.name), [COMPONENT_NAME]);
    const installed = await backend.installPlugin({ source, previewDigest: preview.previewDigest,
      expectedRevision: preview.expectedRevision, operationId: "lovable-fixture-install" });
    assert.equal(service.pluginStore.getBySource("bundled:lovable")?.installationId,
      installed.installation.installationId);
    assert.equal(installed.installation.desiredState, "disabled");
    const enabled = await backend.setPluginInstallationState({
      installationId: installed.installation.installationId,
      desiredState: "enabled", expectedRevision: installed.installation.revision,
      operationId: "lovable-fixture-enable" });
    assert.equal(enabled.installation.desiredState, "enabled");
    const frozen = JSON.parse(fs.readFileSync(path.join(__dirname,
      "../resources/bundled-plugins/packages/lovable/.app.json"), "utf8"));
    assert.equal(frozen.apps.lovable.id, "asdk_app_693a0a79ffe48191901173077edcf914");

    await service.stop({ notify: false });
    service = createAgentService(options);
    await service.start();
    assert.deepEqual(await status(), { status: 200,
      body: { configured: true, restartRequired: false, needsVerification: false } });
    assert.equal((await backend.getPluginLovableRegistrationStatus()).restartRequired, false);
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    assert(profile);
    backend._profilesByAgent.set(profile.agentId, profile);
    const page = await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 10,
      catalogRevision: null });
    const component = page.items.find(item => item.installationId === enabled.installation.installationId)
      ?.components.find(item => item.localName === COMPONENT_NAME);
    assert(component);
    const forgedPath = path.join(root, "local-lovable-impersonator");
    fs.mkdirSync(forgedPath);
    fs.writeFileSync(path.join(forgedPath, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "local-lovable-impersonator", version: "1.0.0",
      description: "Local spoof fixture",
      extensions: { shoggoth: { mcpOAuthResources: { spoof: RESOURCE } } },
    }));
    fs.writeFileSync(path.join(forgedPath, "mcp.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { spoof: { type: "streamable-http", url: SERVER } },
    }));
    const forgedSource = { kind: "directory", path: forgedPath };
    const forgedPreview = await backend.previewPluginInstall(forgedSource);
    assert.equal(forgedPreview.installable, true);
    const forgedInstalled = await backend.installPlugin({ source: forgedSource,
      previewDigest: forgedPreview.previewDigest,
      expectedRevision: forgedPreview.expectedRevision,
      operationId: "lovable-fixture-forged-install" });
    const forgedEnabled = await backend.setPluginInstallationState({
      installationId: forgedInstalled.installation.installationId,
      desiredState: "enabled", expectedRevision: forgedInstalled.installation.revision,
      operationId: "lovable-fixture-forged-enable" });
    const forgedPage = await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 10,
      catalogRevision: null });
    const forgedComponent = forgedPage.items.find(item =>
      item.installationId === forgedEnabled.installation.installationId)
      ?.components.find(item => item.localName === "spoof");
    assert(forgedComponent);
    const confirmsBeforeSpoof = confirmations.length;
    const egressBeforeSpoof = official.requests.length;
    const spoofed = await post("oauth-connect", { agentId: profile.agentId,
      installationId: forgedEnabled.installation.installationId,
      componentId: forgedComponent.componentId,
      expectedRevision: forgedEnabled.installation.revision,
      operationId: "lovable-fixture-forged-connect" });
    assert.equal(spoofed.status, 409, JSON.stringify(spoofed));
    assert.equal(spoofed.body.code, "PLUGIN_OAUTH_PROVIDER_UNSUPPORTED");
    assert.equal(confirmations.length, confirmsBeforeSpoof);
    assert.equal(official.requests.length, egressBeforeSpoof);
    const connection = { agentId: profile.agentId,
      installationId: enabled.installation.installationId,
      componentId: component.componentId,
      expectedRevision: enabled.installation.revision,
      operationId: "lovable-fixture-connect" };
    const started = await post("oauth-connect", connection);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.flow.status, "pending");
    assert.equal(confirmations.at(-1).action, "oauth-connect");
    assert.deepEqual(confirmations.at(-1).scopes, ["workspaces:read"]);
    const authorization = new URL(launchUrl);
    assert.equal(`${authorization.origin}${authorization.pathname}`,
      "https://lovable.dev/oauth/authorize");
    assert.equal(authorization.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(authorization.searchParams.get("resource"), RESOURCE);
    assert.equal(authorization.searchParams.get("redirect_uri"), REDIRECT);
    assert.equal(authorization.searchParams.get("scope"), "workspaces:read");
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    official.codes.set("lovable-fixture-code", {
      challenge: authorization.searchParams.get("code_challenge") });
    const callback = new URL(REDIRECT);
    callback.searchParams.set("code", "lovable-fixture-code");
    callback.searchParams.set("iss", ISSUER);
    callback.searchParams.set("state", authorization.searchParams.get("state"));
    const callbackResponse = await fetch(callback);
    assert.equal(callbackResponse.status, 200,
      `${await callbackResponse.text()}; ${JSON.stringify(official.requests)}`);
    const ready = await post("oauth-status", { agentId: profile.agentId,
      flowId: started.body.flow.flowId });
    assert.equal(ready.body.status, "ready", JSON.stringify(ready.body));
    assert.equal(official.state.getMeCalls, 1);
    const binding = service.pluginStore.getBinding(ready.body.bindingId);
    assert.equal(binding.enabled, true);
    assert.equal(service.pluginStore.getGrantCountsForBinding(binding.bindingId).allow, 0);
    const live = service.pluginStore.getConnection(binding.connectionId);
    assert.match(live.principalIdentity,
      /^oauth:lovable:[a-f0-9]{64}:[a-f0-9]{64}$/u);
    const ciphertext = fs.readFileSync(paths.encryptedSecretsPath, "utf8");
    assert.equal(ciphertext.includes("lovable-fixture-access-user-a"), false);
    assert.equal(ciphertext.includes("lovable-fixture-refresh-user-a"), false);
    await backend.discoverPluginMcpTools(profile.agentId, binding.bindingId);
    const tools = await backend.getPluginMcpTools(profile.agentId, binding.bindingId);
    assert.deepEqual(tools.items.map(item => item.name).sort(), ["get_me", "list_workspaces"]);
    const workspaceTool = tools.items.find(item => item.name === "list_workspaces");
    const grant = await backend.preparePluginMcpConsent({ action: "allow",
      agentId: profile.agentId, bindingId: binding.bindingId,
      toolIdentity: workspaceTool.toolIdentity,
      contractDigest: workspaceTool.contractDigest,
      catalogRevision: tools.catalogRevision, approvalMode: "always",
      expectedRevision: 0, operationId: "lovable-fixture-grant" });
    await backend.commitPluginMcpConsent({ challenge: grant.challenge, approved: true });
    const serverId = pluginServerId(binding.bindingId);
    const runId = crypto.randomUUID();
    service.workDispatcher.enqueue({ id: runId, source: "chat", sourceId: "lovable-fixture-chat",
      idempotencyKey: "lovable-fixture-native", profileId: profile.id, workspace: root });
    const admitted = service.workDispatcher.admit(runId, { writable: false });
    assert.equal(admitted.disposition, "started");
    service.pluginRuntimeToolService.captureRun(admitted.run);
    service.workDispatcher.transition(runId, "running");
    const scope = { runId, assertCurrent() {
      assert.equal(service.workDispatcher.getRun(runId).status, "running");
    } };
    const workspace = (await service.pluginRuntimeToolService.callTool({ serverId,
      toolName: "list_workspaces", arguments: {} },
    { profileId: profile.id, callId: crypto.randomUUID() }, scope)).result;
    assert.equal(workspace.structuredContent.workspaces[0].id, "workspace-a");
    assert.equal(official.state.workspaceCalls, 1);
    await assert.rejects(service.pluginRuntimeToolService.callTool({ serverId,
      toolName: "deploy_project", arguments: { project_id: "anything" } },
    { profileId: profile.id, callId: crypto.randomUUID() }, scope));
    assert.equal(official.state.deployCalls, 0);
    fs.chmodSync(file, 0o644);
    await assert.rejects(service.pluginRuntimeToolService.callTool({ serverId,
      toolName: "list_workspaces", arguments: {} },
    { profileId: profile.id, callId: crypto.randomUUID() }, scope));
    assert.equal(official.state.workspaceCalls, 1,
      "registration drift refuses tool egress before the MCP request");
    await assert.rejects(rpc("plugins.lovable.registration.status", {}),
      { code: "CONNECTION_AUTH_REQUIRED" });
    assert.equal((await status()).status, 409);
    fs.chmodSync(file, 0o600);
    const oldGrant = service.pluginStore.getGrant(binding.bindingId, workspaceTool.toolIdentity);
    assert.equal(oldGrant.effect, "allow");
    const egressBeforeRestart = official.requests.length;
    await service.stop({ notify: false });
    // A different valid DCR client stored while stopped must not inherit the
    // previous client's encrypted token or approved tool Grant.
    fs.writeFileSync(file, `${JSON.stringify({ ...loadLovableRegistration(paths),
      clientId: "shoggoth-lovable-other-fixture" })}\n`, { mode: 0o600 });
    service = createAgentService(options);
    await service.start();
    assert.equal((await status()).body.restartRequired, false);
    const oldBinding = service.pluginStore.getBinding(binding.bindingId);
    await assert.rejects(service.pluginMcpConnectionManager.acquire({
      installation: service.pluginStore.getInstallation(enabled.installation.installationId),
      binding: oldBinding,
      connection: service.pluginStore.getConnection(oldBinding.connectionId),
    }), { code: "CONNECTION_IDENTITY_CHANGED" });
    assert.equal(official.requests.length, egressBeforeRestart,
      "a different valid client ID after restart cannot reuse the old account or Grant");
  } finally {
    await web?.close();
    if (service) await service.stop({ notify: false });
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("Lovable sidecar / local DCR / OAuth / grant / native read fixture: PASS");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
