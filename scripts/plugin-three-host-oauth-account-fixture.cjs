"use strict";

// A real local OAuth code/PKCE exchange creates the account used by all three
// production dispatch paths. No ready Connection is seeded into PluginStore.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { requestService } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { ensureCredential } = require("../app/agent-service/external-plugin-adapter-auth");
const { pluginServerId } = require("../app/agent-service/plugin-runtime-tool-service");
const { createFixture } = require("./plugin-real-host-service-fixture.cjs");

const SEARCH = "shoggoth_capability_search";
const CALL = "shoggoth_plugin_call";
const TOOLS = [
  { name: "notes/read", description: "Read shared account note", inputSchema: {
    type: "object", properties: {}, additionalProperties: false } },
  { name: "notes/write", description: "Write shared account note", inputSchema: {
    type: "object", properties: { value: { type: "string" } },
    required: ["value"], additionalProperties: false } },
];

async function localProvider() {
  const state = { authorizingAccount: "a", codes: new Map(), access: new Map(),
    notes: { a: "initial-a", b: "initial-b" }, exchanges: 0, probes: 0, calls: [], requests: [] };
  let origin;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, origin);
    state.requests.push(`${request.method} ${url.pathname}`);
    const json = (value, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      json({ resource: `${origin}/mcp`, authorization_servers: [origin],
        scopes_supported: ["notes:read", "notes:write"] }); return;
    }
    if (request.method === "GET" && (url.pathname === "/.well-known/oauth-authorization-server"
      || url.pathname === "/.well-known/openid-configuration")) {
      json({ issuer: origin, authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`, response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true }); return;
    }
    if (request.method === "GET" && url.pathname === "/authorize") {
      if (url.searchParams.get("client_id") !== "three-host-public-client"
        || url.searchParams.get("resource") !== `${origin}/mcp`
        || url.searchParams.get("scope") !== "notes:read notes:write"
        || url.searchParams.get("code_challenge_method") !== "S256"
        || !url.searchParams.get("code_challenge") || !url.searchParams.get("state")) {
        json({ error: "invalid_authorization" }, 400); return;
      }
      const redirect = url.searchParams.get("redirect_uri");
      if (!redirect?.startsWith("http://127.0.0.1:")) {
        json({ error: "invalid_redirect" }, 400); return;
      }
      const code = `fixture-code-${crypto.randomUUID()}`;
      state.codes.set(code, { account: state.authorizingAccount, redirect,
        challenge: url.searchParams.get("code_challenge") });
      const callback = new URL(redirect);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", url.searchParams.get("state"));
      callback.searchParams.set("iss", origin);
      response.writeHead(302, { location: callback.href }); response.end(); return;
    }
    if (request.method === "POST" && url.pathname === "/token") {
      let body = ""; for await (const chunk of request) body += chunk;
      const form = new URLSearchParams(body);
      const code = form.get("code"), pending = state.codes.get(code);
      if (!pending || form.get("client_id") !== "three-host-public-client"
        || form.get("resource") !== `${origin}/mcp`
        || form.get("redirect_uri") !== pending.redirect
        || crypto.createHash("sha256").update(form.get("code_verifier") || "")
          .digest("base64url") !== pending.challenge) {
        json({ error: "invalid_grant" }, 400); return;
      }
      state.codes.delete(code);
      state.exchanges += 1;
      const token = `fixture-access-${pending.account}-${crypto.randomUUID()}`;
      state.access.set(token, pending.account);
      json({ access_token: token, refresh_token: `fixture-refresh-${crypto.randomUUID()}`,
        token_type: "Bearer", expires_in: 3600, scope: "notes:read notes:write" }); return;
    }
    const token = request.headers.authorization?.replace(/^Bearer /u, "");
    const account = state.access.get(token);
    if (request.method === "GET" && url.pathname === "/identity") {
      state.probes += 1;
      json(account ? { id: `fixture-account-${account}` } : { error: "unauthorized" },
        account ? 200 : 401); return;
    }
    if (request.method === "POST" && url.pathname === "/mcp") {
      if (!account) { json({ error: "unauthorized" }, 401); return; }
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 262_144) { json({ error: "too_large" }, 413); return; }
      }
      const message = JSON.parse(body);
      if (message.method === "notifications/initialized") {
        response.writeHead(202); response.end(); return;
      }
      let result;
      if (message.method === "initialize") result = {
        protocolVersion: "2025-11-25", capabilities: { tools: {} },
        serverInfo: { name: "three-host-account-fixture", version: "1" } };
      else if (message.method === "tools/list") result = { tools: TOOLS };
      else if (message.method === "tools/call") {
        const name = message.params?.name, args = message.params?.arguments || {};
        if (!TOOLS.some(tool => tool.name === name)) {
          json({ jsonrpc: "2.0", id: message.id,
            error: { code: -32601, message: "Unknown tool" } }); return;
        }
        state.calls.push({ account, name, value: args.value ?? null });
        if (name === "notes/write") state.notes[account] = args.value;
        result = { content: [{ type: "text", text: state.notes[account] }],
          structuredContent: { account, value: state.notes[account] }, isError: false };
      } else { json({ jsonrpc: "2.0", id: message.id,
        error: { code: -32601, message: "Unknown method" } }); return; }
      json({ jsonrpc: "2.0", id: message.id, result }); return;
    }
    json({ error: "not_found" }, 404);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const serverUrl = `${origin}/mcp`;
  const provider = { id: "three-host-local", name: "Local three-host test account",
    serverUrl, issuer: origin, audience: serverUrl,
    authorizationEndpoint: `${origin}/authorize`, tokenEndpoint: `${origin}/token`,
    clientId: "three-host-public-client", scopes: ["notes:read", "notes:write"],
    metadataUrls: ["/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]
      .map(part => `${origin}${part}`), identityUrls: [`${origin}/identity`],
    allowLoopback: true,
    async verifyPrincipal({ accessToken, issuer, fetchImpl }) {
      const verified = await fetchImpl(`${origin}/identity`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
      assert.equal(verified.ok, true);
      const subject = (await verified.json()).id;
      return `oauth:three-host-local:${crypto.createHash("sha256")
        .update(JSON.stringify([issuer, subject])).digest("hex")}`;
    } };
  return { state, origin, serverUrl, provider,
    close: () => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }) };
}

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

function runHermesProbe(serviceRoot, commands) {
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
      if (code !== 0) { reject(new Error(`Hermes adapter probe exited ${code}: ${stderr}`)); return; }
      try { resolve(JSON.parse(stdout)); }
      catch (error) { reject(new Error(`Hermes response invalid: ${error.message}; ${stdout}; ${stderr}`)); }
    });
    child.stdin.end(JSON.stringify({ commands }));
  });
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg3o-")));
  const provider = await localProvider();
  const key = crypto.randomBytes(32);
  const fixture = createFixture(root, "openclaw", { safeStorage: safeStorageFixture(key),
    pluginOAuthProviders: [provider.provider], pluginAllowLoopback: true });
  let service = null, runId = null;
  try {
    service = await fixture.start();
    const backend = new ShoggothBackend({ paths: fixture.paths });
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    assert(profile);
    backend._profilesByAgent.set(profile.agentId, profile);
    const sourcePath = path.join(root, "account-plugin");
    fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), sourcePath,
      { recursive: true });
    fs.writeFileSync(path.join(sourcePath, "mcp.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { "account-notes": { type: "streamable-http", url: provider.serverUrl } },
    }));
    const source = { kind: "directory", path: sourcePath };
    const preview = await backend.previewPluginInstall(source);
    assert.equal(preview.installable, true);
    const installed = await backend.installPlugin({ source, previewDigest: preview.previewDigest,
      expectedRevision: preview.expectedRevision, operationId: "three-host-oauth-install" });
    const enabled = await backend.setPluginInstallationState({
      installationId: installed.installation.installationId, desiredState: "enabled",
      expectedRevision: installed.installation.revision, operationId: "three-host-oauth-enable" });
    const page = await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 10,
      catalogRevision: null });
    const component = page.items.find(item => item.installationId === enabled.installation.installationId)
      ?.components.find(item => item.localName === "account-notes");
    assert(component);
    assert.equal(service.pluginStore.listGlobalBindings().length, 0,
      "no account or binding exists before the fixture login");
    const prepared = await backend.preparePluginOAuth({ agentId: profile.agentId,
      installationId: enabled.installation.installationId, componentId: component.componentId,
      expectedRevision: enabled.installation.revision, operationId: "three-host-oauth-connect" });
    assert.equal(prepared.summary.action, "oauth-connect");
    const started = await backend.commitPluginOAuth({ challenge: prepared.challenge, approved: true })
      .catch(error => { error.message += `; provider requests: ${provider.state.requests.join(", ")}`; throw error; });
    assert.equal(started.flow.status, "pending");
    assert.equal((await fetch(started.flow.authorizationUrl)).status, 200,
      "fixture browser must complete OAuth callback and code exchange");
    const ready = await backend.getPluginOAuthStatus(profile.agentId, started.flow.flowId);
    assert.equal(ready.status, "ready");
    assert.equal(provider.state.exchanges, 1);
    assert.equal(provider.state.probes, 1);
    const binding = service.pluginStore.getBinding(ready.bindingId);
    const connection = service.pluginStore.getConnection(binding.connectionId);
    assert.equal(binding.subjectKind, "global");
    assert.equal(binding.enabled, true);
    assert.equal(connection.state, "ready");
    assert.equal(connection.endpointIdentity, provider.serverUrl);
    assert.equal(service.pluginStore.listGlobalBindings().length, 1);
    assert.equal(fs.readFileSync(fixture.paths.encryptedSecretsPath, "utf8")
      .includes("fixture-access-"), false);

    await backend.discoverPluginMcpTools(profile.agentId, binding.bindingId);
    const catalog = await backend.getPluginMcpTools(profile.agentId, binding.bindingId);
    assert.deepEqual(catalog.items.map(item => item.name).sort(), ["notes/read", "notes/write"]);
    for (const tool of catalog.items) {
      const grant = await backend.preparePluginMcpConsent({ action: "allow",
        agentId: profile.agentId, bindingId: binding.bindingId,
        toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest,
        catalogRevision: catalog.catalogRevision, approvalMode: "always",
        expectedRevision: 0, operationId: `three-host-grant-${tool.name.replace("/", "-")}` });
      await backend.commitPluginMcpConsent({ challenge: grant.challenge, approved: true });
    }
    const serverId = pluginServerId(binding.bindingId);
    runId = crypto.randomUUID();
    service.workDispatcher.enqueue({ id: runId, source: "chat", sourceId: "three-host-oauth-chat",
      idempotencyKey: "three-host-oauth-native", profileId: profile.id, workspace: root });
    const admitted = service.workDispatcher.admit(runId, { writable: false });
    assert.equal(admitted.disposition, "started");
    assert.equal(service.pluginRuntimeToolService.captureRun(admitted.run).serverCount, 1);
    service.workDispatcher.transition(runId, "running");
    const nativeScope = { runId, assertCurrent() {
      assert.equal(service.workDispatcher.getRun(runId).status, "running");
    } };
    const nativeCall = async (name, args) => (await service.pluginRuntimeToolService.callTool({
      serverId, toolName: name, arguments: args },
    { profileId: profile.id, callId: crypto.randomUUID() }, nativeScope)).result.structuredContent;
    assert.deepEqual(await nativeCall("notes/read", {}), { account: "a", value: "initial-a" });
    assert.deepEqual(await nativeCall("notes/write", { value: "native-wrote" }),
      { account: "a", value: "native-wrote" });

    const rpc = (method, params, options = {}) => requestService(fixture.paths, {
      version: SERVICE_PROTOCOL_VERSION, method, params,
    }, { timeoutMs: options.timeoutMs || 10_000 });
    const { createAdapter } = await import(pathToFileURL(path.join(__dirname,
      "../resources/external-plugin-adapters/openclaw/index.mjs")).href);
    const openclaw = createAdapter({ instanceId: "openclaw-three-host-oauth-fixture",
      credential: () => fixture.credential,
      requestService: (method, params, options) => rpc(method, params, options) });
    let openclawCallId = 0;
    const openclawInvoke = async (name, args) => {
      const toolCallId = `openclaw-three-host-oauth-call-${++openclawCallId}`;
      const context = { agentId: "openclaw-three-host-oauth-agent",
        sessionId: "openclaw-three-host-oauth-session", runId: "openclaw-three-host-oauth-run" };
      assert.equal(openclaw.beforeToolCall({ toolName: name, toolCallId,
        runId: context.runId }, context), undefined);
      return (await openclaw.tool(name, context).execute(toolCallId, args)).details;
    };
    const openclawCatalog = await openclawInvoke(SEARCH, { query: "notes" });
    assert(openclawCatalog.items.some(item => item.serverId === serverId
      && item.name === "notes/read"));
    assert(openclawCatalog.items.some(item => item.serverId === serverId
      && item.name === "notes/write"));
    const openclawTool = (name, args) => openclawInvoke(CALL, { serverId,
      toolName: name, arguments: args });
    assert.deepEqual((await openclawTool("notes/read", {})).result.structuredContent,
      { account: "a", value: "native-wrote" });
    assert.deepEqual((await openclawTool("notes/write", { value: "openclaw-wrote" }))
      .result.structuredContent, { account: "a", value: "openclaw-wrote" });

    ensureCredential(fixture.paths, "hermes");
    const hermes = await runHermesProbe(fixture.paths.userDataRoot, [
      { name: SEARCH, args: { query: "notes" } },
      { name: CALL, args: { serverId, toolName: "notes/read", arguments: {} } },
      { name: CALL, args: { serverId, toolName: "notes/write",
        arguments: { value: "hermes-wrote" } } },
    ]);
    assert(hermes[0].items.some(item => item.serverId === serverId && item.name === "notes/read"));
    assert.deepEqual(hermes[1].result.structuredContent,
      { account: "a", value: "openclaw-wrote" });
    assert.deepEqual(hermes[2].result.structuredContent,
      { account: "a", value: "hermes-wrote" });
    assert.deepEqual(await nativeCall("notes/read", {}),
      { account: "a", value: "hermes-wrote" });
    assert.equal(provider.state.exchanges, 1,
      "all host calls must reuse the one verified OAuth account");
    assert.equal(service.pluginStore.listGlobalBindings().length, 1);
    assert.deepEqual(new Set(provider.state.calls.map(call => call.account)), new Set(["a"]));
    assert.deepEqual(provider.state.calls.map(call => call.name), [
      "notes/read", "notes/write", "notes/read", "notes/write",
      "notes/read", "notes/write", "notes/read" ]);
    const audited = (await fixture.listAuditedCalls(null)).items.filter(item =>
      item.bindingId === binding.bindingId);
    assert.equal(audited.length, 4);
    assert.deepEqual(new Set(audited.map(item => item.backendId)),
      new Set(["openclaw", "hermes"]));
    assert(audited.every(item => item.connectionId === connection.connectionId
      && item.status === "confirmed"));

    const oldOpenclawIdentity = { backendId: "openclaw",
      instanceId: "openclaw-three-host-oauth-fixture",
      agentId: "openclaw-three-host-oauth-agent", sessionId: "openclaw-old-account-session",
      runId: "openclaw-old-account-run", toolCallId: "openclaw-old-account-call" };
    const oldHermesIdentity = { backendId: "hermes", instanceId: "hermes-three-host-fixture",
      agentId: "hermes-default", sessionId: "hermes-old-account-session",
      taskId: "hermes-old-account-task", turnId: "hermes-old-account-turn",
      toolCallId: "hermes-old-account-call" };
    const oldOpenclawLease = await rpc("plugin.external.open", {
      credentialToken: fixture.credential, identity: oldOpenclawIdentity });
    const oldHermesLease = await rpc("plugin.external.open", {
      credentialToken: ensureCredential(fixture.paths, "hermes"), identity: oldHermesIdentity });
    provider.state.authorizingAccount = "b";
    const switchPrepared = await backend.preparePluginOAuth({ agentId: profile.agentId,
      installationId: enabled.installation.installationId, componentId: component.componentId,
      expectedRevision: enabled.installation.revision,
      operationId: "three-host-oauth-switch-b" });
    assert.equal(switchPrepared.summary.reconnect, true);
    const switchStarted = await backend.commitPluginOAuth({
      challenge: switchPrepared.challenge, approved: true });
    assert.equal((await fetch(switchStarted.flow.authorizationUrl)).status, 200);
    const switched = await backend.getPluginOAuthStatus(profile.agentId, switchStarted.flow.flowId);
    assert.equal(switched.status, "ready");
    assert.equal(switched.bindingId, binding.bindingId);
    const newBinding = service.pluginStore.getBinding(binding.bindingId);
    assert.notEqual(newBinding.connectionId, connection.connectionId);
    assert.equal(service.pluginStore.listGlobalBindings().length, 1);
    assert.equal(provider.state.exchanges, 2);
    assert.equal(provider.state.probes, 2);
    for (const tool of catalog.items) {
      assert.equal(service.pluginStore.getGrant(binding.bindingId, tool.toolIdentity).effect, "deny",
        "switching account must revoke old tool grants");
    }
    for (const [lease, identity] of [[oldOpenclawLease, oldOpenclawIdentity],
      [oldHermesLease, oldHermesIdentity]]) {
      await assert.rejects(rpc("plugin.external.call", { token: lease.token, identity,
        serverId, toolName: "notes/write", arguments: { value: "old-lease-must-fail" } }),
      error => ["GRANT_REVOKED", "CONNECTION_IDENTITY_CHANGED"].includes(error.code));
    }
    await assert.rejects(nativeCall("notes/write", { value: "old-run-must-fail" }),
      error => ["GRANT_REVOKED", "CONNECTION_IDENTITY_CHANGED"].includes(error.code));
    assert.deepEqual(provider.state.notes, { a: "hermes-wrote", b: "initial-b" });
    await backend.discoverPluginMcpTools(profile.agentId, binding.bindingId);
    const catalogB = await backend.getPluginMcpTools(profile.agentId, binding.bindingId);
    for (const tool of catalogB.items) {
      const grant = await backend.preparePluginMcpConsent({ action: "allow",
        agentId: profile.agentId, bindingId: binding.bindingId,
        toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest,
        catalogRevision: catalogB.catalogRevision, approvalMode: "always",
        expectedRevision: 0, operationId: `three-host-b-grant-${tool.name.replace("/", "-")}` });
      await backend.commitPluginMcpConsent({ challenge: grant.challenge, approved: true });
    }
    assert.deepEqual((await openclawTool("notes/read", {})).result.structuredContent,
      { account: "b", value: "initial-b" });
    assert.deepEqual((await openclawTool("notes/write", { value: "b-only" }))
      .result.structuredContent, { account: "b", value: "b-only" });
    const hermesAfterSwitch = await runHermesProbe(fixture.paths.userDataRoot, [
      { name: CALL, args: { serverId, toolName: "notes/read", arguments: {} } },
    ]);
    assert.deepEqual(hermesAfterSwitch[0].result.structuredContent,
      { account: "b", value: "b-only" });
    assert.deepEqual(provider.state.notes, { a: "hermes-wrote", b: "b-only" },
      "account switch must not cross-write account A");

    const disconnect = await backend.preparePluginDisconnect({ agentId: profile.agentId,
      bindingId: binding.bindingId, expectedRevision: service.pluginStore.getBinding(binding.bindingId).revision,
      operationId: "three-host-oauth-disconnect-b" });
    await backend.commitPluginDisconnect({ challenge: disconnect.challenge, approved: true });
    assert.equal(service.pluginStore.getBinding(binding.bindingId).enabled, false);
    const callsBeforeRevoked = provider.state.calls.length;
    await assert.rejects(openclawTool("notes/write", { value: "disconnected" }),
      error => error.code === "CAPABILITY_FORBIDDEN");
    assert.equal(provider.state.calls.length, callsBeforeRevoked,
      "disconnected account must not receive a downstream call");
    console.log("plugin-three-host-oauth-account-fixture: PASS", JSON.stringify({
      oauthExchanges: provider.state.exchanges, verifiedPrincipals: provider.state.probes,
      globalBindings: 1, firstConnectionId: connection.connectionId,
      nativeCalls: 3, externalCallsBeforeSwitch: audited.length,
      account: "two local fixture accounts, one active at a time",
      liveProviderAccount: false, actualExternalCliModelRuns: false }));
  } finally {
    if (service && runId && service.workDispatcher.getRun(runId)?.status === "running") {
      service.pluginRuntimeToolService.releaseRun(runId);
      service.workDispatcher.transition(runId, "completed");
    }
    await fixture.stop();
    await provider.close();
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
