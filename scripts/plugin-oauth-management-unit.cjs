"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService } = require("../app/agent-service/server");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { startStaticServer } = require("../app/static-server");

// Static production-shaped HTTPS trust configuration; only the injected
// Service fetch below maps those exact URLs onto this isolated loopback server.
const ISSUER = "https://oauth-fixture.example";
const ACCESS = "fixture-secret-access-not-for-browser";
const REFRESH = "fixture-secret-refresh-not-for-browser";
async function oauthServer() {
  const state = { requests: 0, exchanges: 0, probes: 0, codes: new Map() };
  const server = http.createServer(async (request, response) => {
    state.requests += 1;
    const url = new URL(request.url, ISSUER);
    const json = (body, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body));
    };
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      json({ resource: `${ISSUER}/mcp`, authorization_servers: [ISSUER], scopes_supported: ["issues:read"] }); return;
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")
      || url.pathname.startsWith("/.well-known/openid-configuration")) {
      json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
        response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true }); return;
    }
    if (url.pathname === "/token") {
      let body = ""; for await (const chunk of request) body += chunk;
      const params = new URLSearchParams(body);
      const authorization = state.codes.get(params.get("code"));
      if (!authorization || params.get("resource") !== `${ISSUER}/mcp`
        || params.get("client_id") !== "fixture-public-client"
        || params.get("redirect_uri") !== authorization.redirect
        || crypto.createHash("sha256").update(params.get("code_verifier") || "").digest("base64url") !== authorization.challenge) {
        json({ error: "invalid_grant" }, 400); return;
      }
      state.codes.delete(params.get("code")); state.exchanges += 1;
      json({ access_token: ACCESS, refresh_token: REFRESH, token_type: "Bearer", expires_in: 3600, scope: "issues:read" }); return;
    }
    if (url.pathname === "/identity") {
      state.probes += 1;
      if (request.headers.authorization !== `Bearer ${ACCESS}`) { json({ error: "unauthorized" }, 401); return; }
      json({ id: "private-fixture-account" }); return;
    }
    json({ error: "fixture route unavailable" }, 404);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const local = `http://127.0.0.1:${server.address().port}`;
  return { state,
    async fetchImpl(input, init) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      assert.equal(url.origin, ISSUER, "fixture cannot make a nonlocal provider request");
      return fetch(`${local}${url.pathname}${url.search}`, { method: request.method, headers: request.headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
        redirect: "manual", signal: request.signal });
    },
    close: () => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }),
  };
}
function assertPublic(value) {
  const text = JSON.stringify(value);
  for (const secret of [ACCESS, REFRESH, "private-fixture-account", "authorizationUrl", "code_challenge",
    "credentialRef", "principalIdentity", "endpointIdentity", `${ISSUER}/authorize`, `${ISSUER}/token`]) {
    assert.equal(text.includes(secret), false, `${secret} must not cross browser REST`);
  }
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sgom-"));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "user"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const fixture = await oauthServer();
  const encryptionKey = crypto.randomBytes(32);
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, nonce);
      return Buffer.concat([nonce, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString("utf8");
    },
  };
  fs.mkdirSync(paths.pluginsDir, { recursive: true, mode: 0o700 });
  const providerConfig = { version: 1, providers: [{ id: "fixture", name: "Trusted local fixture",
    serverUrl: `${ISSUER}/mcp`, issuer: ISSUER, audience: `${ISSUER}/mcp`, authorizationEndpoint: `${ISSUER}/authorize`,
    tokenEndpoint: `${ISSUER}/token`, clientId: "fixture-public-client", scopes: ["issues:read"],
    metadataUrls: ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"].map(item => ISSUER + item),
    identity: { url: `${ISSUER}/identity`, subjectField: "id" } }] };
  fs.writeFileSync(path.join(paths.pluginsDir, "oauth-providers.json"), JSON.stringify(providerConfig), { mode: 0o600 });
  const options = { paths, safeStorage, prewarmMcpAuth: false, parentEnv: {},
    pluginOAuthFetch: fixture.fetchImpl, version: "oauth-management-fixture" };
  let service = createAgentService(options);
  let web;
  let approve = false;
  let openingFails = false;
  let confirmations = 0;
  const nativeUrls = [];
  try {
    await service.start();
    const backend = new ShoggothBackend({ paths });
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    backend._profilesByAgent.set(profile.agentId, profile);
    backend._profilesByAgent.set("other-agent", { ...profile, id: "other-profile", agentId: "other-agent" });
    const source = path.join(root, "package");
    fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), source, { recursive: true });
    const mcpFile = path.join(source, "mcp.json");
    const mcp = JSON.parse(fs.readFileSync(mcpFile, "utf8"));
    mcp.mcpServers["remote-issues"].url = `${ISSUER}/mcp`;
    fs.writeFileSync(mcpFile, JSON.stringify(mcp));
    const sourceInput = { kind: "directory", path: source };
    const preview = await backend.previewPluginInstall(sourceInput);
    const installed = await backend.installPlugin({ source: sourceInput, previewDigest: preview.previewDigest,
      expectedRevision: 0, operationId: "oauth-management-install" });
    const enabled = await backend.setPluginInstallationState({ installationId: installed.installation.installationId,
      desiredState: "enabled", expectedRevision: installed.installation.revision, operationId: "oauth-management-enable" });
    const page = await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 10, catalogRevision: null });
    const component = page.items[0].components.find(item => item.localName === "remote-issues");
    const hostOps = { async confirmPluginCapability(summary) {
      confirmations += 1;
      assert.equal(summary.action, "oauth-connect"); assert.equal(summary.provider, "Trusted local fixture");
      assert.deepEqual(summary.scopes, ["issues:read"]); assertPublic(summary);
      return approve;
    }, async openExternal(url) {
      nativeUrls.push(url);
      assert.equal(new URL(url).origin, ISSUER);
      if (openingFails) throw new Error(`native launch failed: ${url}`);
    } };
    web = await startStaticServer(0, { homeDir: root, userDataRoot: root, registry: {
      route: id => backend._profilesByAgent.has(id) ? backend : null, backends: new Map([["shoggoth", backend]]),
    }, hostOps });
    const post = async (route, input, origin = web.url) => {
      const response = await fetch(`${web.url}/__api/plugins/${route}`, { method: "POST",
        headers: { origin, "content-type": "application/json" }, body: JSON.stringify(input) });
      const text = await response.text();
      let body; try { body = JSON.parse(text); } catch { body = { error: text }; }
      assertPublic(body);
      return { status: response.status, body };
    };
    const input = { agentId: profile.agentId, installationId: enabled.installation.installationId,
      componentId: component.componentId, expectedRevision: enabled.installation.revision, operationId: "oauth-management-connect" };
    assert.equal((await post("oauth-connect", input, "https://evil.example")).status, 403);
    assert.equal((await post("oauth-connect", { ...input, clientId: "attacker" })).status, 400);
    assert.equal(confirmations, 0); assert.equal(fixture.state.requests, 0);
    const canceled = await post("oauth-connect", input);
    assert.deepEqual(canceled, { status: 200, body: { canceled: true, flow: null } });
    assert.equal(nativeUrls.length, 0); assert.equal(fixture.state.requests, 0, "canceled consent has no OAuth IO");
    assert.equal(service.pluginStore.getConnectionCountsForComponent(input.installationId, input.componentId).pending, 0);
    approve = true;
    const start = await post("oauth-connect", input);
    assert.equal(start.status, 200); assert.equal(start.body.flow.status, "pending");
    assert.deepEqual(Object.keys(start.body.flow).sort(), ["expiresAt", "flowId", "status"]);
    assert.equal(nativeUrls.length, 1);
    const flowId = start.body.flow.flowId;
    const selector = { agentId: profile.agentId, flowId };
    assert.equal((await post("oauth-status", selector)).body.status, "pending");
    assert.notEqual((await post("oauth-status", { agentId: "other-agent", flowId })).status, 200);
    assert.equal((await post("oauth-cancel", selector, "https://evil.example")).status, 403);
    const authorization = new URL(nativeUrls[0]);
    const redirect = authorization.searchParams.get("redirect_uri");
    fixture.state.codes.set("correct-code", { redirect, challenge: authorization.searchParams.get("code_challenge") });
    const callback = new URL(redirect);
    callback.searchParams.set("code", "correct-code"); callback.searchParams.set("iss", ISSUER);
    callback.searchParams.set("state", "wrong-state");
    assert.equal((await fetch(callback)).status, 400); assert.equal(fixture.state.exchanges, 0);
    callback.searchParams.set("state", authorization.searchParams.get("state"));
    assert.equal((await fetch(callback)).status, 200);
    const ready = await post("oauth-status", selector);
    assert.equal(ready.body.status, "ready"); assert.equal(ready.body.receipt.kind, "mcp-connect");
    assert.equal(fixture.state.exchanges, 1); assert.equal(fixture.state.probes, 1);
    const binding = service.pluginStore.getBinding(ready.body.bindingId);
    assert.equal(binding.enabled, true);
    assert.match(service.pluginStore.getConnection(binding.connectionId).principalIdentity, /^oauth:fixture:[a-f0-9]{64}$/u);
    assert.equal(service.pluginStore.getGrantCountsForBinding(binding.bindingId).allow, 0);
    const ciphertext = fs.readFileSync(paths.encryptedSecretsPath, "utf8");
    assert.equal(ciphertext.includes(ACCESS), false); assert.equal(ciphertext.includes(REFRESH), false);
    assert.equal((await backend.getPluginOperation(input.operationId)).operation.phase, "completed");

    const reconnect = await post("oauth-connect", { ...input, operationId: "oauth-management-cancel" });
    assert.equal(reconnect.status, 200);
    assert.equal(service.pluginStore.getBinding(binding.bindingId).enabled, false);
    const cancelResult = await post("oauth-cancel", { agentId: profile.agentId, flowId: reconnect.body.flow.flowId });
    assert.equal(cancelResult.body.status, "canceled");
    await assert.rejects(fetch(new URL(nativeUrls.at(-1)).searchParams.get("redirect_uri")), TypeError);
    openingFails = true;
    assert.notEqual((await post("oauth-connect", { ...input, operationId: "oauth-native-open-fails" })).status, 200);
    assert.equal(service.pluginStore.getConnectionCountsForComponent(input.installationId, input.componentId).pending, 0,
      "native browser failure cancels newly created OAuth authority");
    openingFails = false;
    const stopping = await post("oauth-connect", { ...input, operationId: "oauth-service-stop" });
    assert.equal(stopping.status, 200);
    const stoppingRedirect = new URL(nativeUrls.at(-1)).searchParams.get("redirect_uri");
    await service.stop({ notify: false });
    await assert.rejects(fetch(stoppingRedirect), TypeError);
    service = createAgentService(options);
    await service.start();
    await assert.rejects(backend.getPluginOAuthStatus(profile.agentId, stopping.body.flow.flowId),
      error => error.code === "PLUGIN_OAUTH_FLOW_NOT_FOUND");
    assert.equal(service.pluginStore.getConnectionCountsForComponent(input.installationId, input.componentId).pending, 0);
    assert.equal(service.pluginStore.getBinding(binding.bindingId).enabled, false);
    console.log("plugin OAuth static trust / Service / Backend / REST / native consent fixture: PASS");
  } finally {
    await web?.close(); await service.stop({ notify: false });
    await fixture.close(); encryptionKey.fill(0); fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
