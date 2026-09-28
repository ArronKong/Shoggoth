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
const { PluginMcpClient } = require("../app/agent-service/plugin-mcp-client");
const { handle: fixtureMcpHandle } = require("./fixtures/plugins/mcp-sdk-fixture.cjs");

// Static production-shaped HTTPS trust configuration; only the injected
// Service fetch below maps those exact URLs onto this isolated loopback server.
const ISSUER = "https://oauth-fixture.example";
const ACCESS = "fixture-secret-access-not-for-browser";
const REFRESH = "fixture-secret-refresh-not-for-browser";
const AIRTABLE_ENDPOINT = "https://mcp.airtable.com/mcp";
const SHOPIFY_ENDPOINT = "https://setup.shopify.com/mcp";
async function oauthServer(endpoint) {
  const state = { requests: 0, exchanges: 0, probes: 0, codes: new Map(), accounts: new Map() };
  const server = http.createServer(async (request, response) => {
    state.requests += 1;
    const url = new URL(request.url, ISSUER);
    const json = (body, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body));
    };
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      json({ resource: endpoint, authorization_servers: [ISSUER], scopes_supported: ["issues:read"] }); return;
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
      if (!authorization || params.get("resource") !== endpoint
        || params.get("client_id") !== "fixture-public-client"
        || params.get("redirect_uri") !== authorization.redirect
        || crypto.createHash("sha256").update(params.get("code_verifier") || "").digest("base64url") !== authorization.challenge) {
        json({ error: "invalid_grant" }, 400); return;
      }
      state.codes.delete(params.get("code")); state.exchanges += 1;
      const account = authorization.account || "account-a";
      const accessToken = `${ACCESS}-${account}`;
      state.accounts.set(accessToken, account);
      json({ access_token: accessToken, refresh_token: `${REFRESH}-${account}`, token_type: "Bearer",
        expires_in: 3600, scope: "issues:read" }); return;
    }
    if (url.pathname === "/identity") {
      state.probes += 1;
      const account = state.accounts.get((request.headers.authorization || "").replace(/^Bearer /u, ""));
      if (!account) { json({ error: "unauthorized" }, 401); return; }
      json({ id: account }); return;
    }
    json({ error: "fixture route unavailable" }, 404);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const local = `http://127.0.0.1:${server.address().port}`;
  return { state,
    async fetchImpl(input, init) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      assert.ok(url.origin === ISSUER || url.origin === new URL(endpoint).origin,
        "fixture cannot make a nonlocal provider request");
      return fetch(`${local}${url.pathname}${url.search}`, { method: request.method, headers: request.headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
        redirect: "manual", signal: request.signal });
    },
    close: () => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }),
  };
}
function assertPublic(value) {
  const text = JSON.stringify(value);
  for (const secret of [ACCESS, REFRESH, "account-a", "account-b", "authorizationUrl", "code_challenge",
    "credentialRef", "principalIdentity", "endpointIdentity", `${ISSUER}/authorize`, `${ISSUER}/token`]) {
    assert.equal(text.includes(secret), false, `${secret} must not cross browser REST`);
  }
}

async function main({ airtable = false, shopify = false } = {}) {
  assert.equal(airtable && shopify, false);
  const bundledProvider = airtable || shopify;
  const endpoint = shopify ? SHOPIFY_ENDPOINT : airtable ? AIRTABLE_ENDPOINT : `${ISSUER}/mcp`;
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sgom-"));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "user"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const fixture = await oauthServer(endpoint);
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
  let callbackBlocker;
  if (bundledProvider) {
    callbackBlocker = http.createServer((_request, response) => { response.writeHead(503); response.end(); });
    await new Promise((resolve, reject) => {
      callbackBlocker.once("error", reject); callbackBlocker.listen(0, "127.0.0.1", resolve);
    });
  }
  const fixedRedirect = callbackBlocker
    ? `http://127.0.0.1:${callbackBlocker.address().port}/oauth/callback` : null;
  const providerConfig = { version: 1, providers: [{ id: "fixture", name: "Trusted local fixture",
    serverUrl: endpoint, issuer: ISSUER, audience: endpoint, authorizationEndpoint: `${ISSUER}/authorize`,
    tokenEndpoint: `${ISSUER}/token`, clientId: "fixture-public-client", scopes: ["issues:read"],
    ...(fixedRedirect ? { redirectUrl: fixedRedirect } : {}),
    metadataUrls: ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]
      .map(item => new URL(item, endpoint).href).concat([
        `${ISSUER}/.well-known/oauth-authorization-server`, `${ISSUER}/.well-known/openid-configuration`]),
    identity: { url: `${ISSUER}/identity`, subjectField: "id" } }] };
  fs.writeFileSync(path.join(paths.pluginsDir, "oauth-providers.json"), JSON.stringify(providerConfig), { mode: 0o600 });
  const options = { paths, safeStorage, prewarmMcpAuth: false, parentEnv: {},
    pluginOAuthFetch: fixture.fetchImpl, version: "oauth-management-fixture" };
  let service = createAgentService(options);
  let web, mcpFixture;
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
    let sourceInput;
    if (bundledProvider) sourceInput = { kind: "bundled", packageId: shopify ? "shopify" : "airtable" };
    else {
      const source = path.join(root, "package");
      fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), source, { recursive: true });
      const mcpFile = path.join(source, "mcp.json");
      const mcp = JSON.parse(fs.readFileSync(mcpFile, "utf8"));
      mcp.mcpServers["remote-issues"].url = endpoint;
      fs.writeFileSync(mcpFile, JSON.stringify(mcp));
      sourceInput = { kind: "directory", path: source };
    }
    const preview = await backend.previewPluginInstall(sourceInput);
    if (bundledProvider) {
      assert.equal(preview.components.mcpServers[0].name, shopify ? "shopify" : "airtable");
      assert.ok(preview.diagnostics.some(item => item.reasonCode === "CODEX_OAUTH_CLIENT_REGISTRATION_REQUIRED"));
      assert.equal(JSON.stringify(preview).includes(shopify
        ? "<SHOPIFY_PUBLIC_CLIENT_ID>" : "<AIRTABLE_PUBLIC_CLIENT_ID>"), false);
    }
    const installed = await backend.installPlugin({ source: sourceInput, previewDigest: preview.previewDigest,
      expectedRevision: preview.expectedRevision ?? 0, operationId: "oauth-management-install" });
    const enabled = await backend.setPluginInstallationState({ installationId: installed.installation.installationId,
      desiredState: "enabled", expectedRevision: installed.installation.revision, operationId: "oauth-management-enable" });
    const page = await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 10, catalogRevision: null });
    const component = page.items[0].components.find(item =>
      item.localName === (shopify ? "shopify" : airtable ? "airtable" : "remote-issues"));
    assert(component);
    const hostOps = { async confirmPluginCapability(summary) {
      confirmations += 1;
      assert.ok(summary.action === "oauth-connect" || (bundledProvider && summary.action === "mcp-disconnect"));
      if (summary.action === "oauth-connect") {
        assert.equal(summary.provider, "Trusted local fixture");
        assert.deepEqual(summary.scopes, ["issues:read"]);
      }
      assertPublic(summary);
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
    if (bundledProvider) {
      const occupied = await post("oauth-connect", { ...input, operationId: "airtable-occupied-callback" });
      assert.notEqual(occupied.status, 200, "occupied registered port must not use a random redirect");
      assert.equal(nativeUrls.length, 0);
      assert.equal(service.pluginStore.listGlobalBindings().length, 0);
      assert.equal(service.pluginStore.getConnectionCountsForComponent(input.installationId, input.componentId).pending, 0);
      await new Promise(resolve => callbackBlocker.close(resolve));
      callbackBlocker = null;
    }
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
    assert.equal(authorization.searchParams.get("client_id"), "fixture-public-client");
    assert.equal(authorization.searchParams.get("resource"), endpoint);
    assert.notEqual(authorization.searchParams.get("client_id"), shopify
      ? "<SHOPIFY_PUBLIC_CLIENT_ID>" : "<AIRTABLE_PUBLIC_CLIENT_ID>");
    if (bundledProvider) assert.equal(redirect, fixedRedirect, "authorization uses exactly the registered redirect URI");
    fixture.state.codes.set("correct-code", { redirect,
      challenge: authorization.searchParams.get("code_challenge"), account: "account-a" });
    const callback = new URL(redirect);
    callback.searchParams.set("code", "correct-code"); callback.searchParams.set("iss", ISSUER);
    callback.searchParams.set("state", "wrong-state");
    assert.equal((await fetch(callback)).status, 400); assert.equal(fixture.state.exchanges, 0);
    callback.searchParams.set("state", authorization.searchParams.get("state"));
    assert.equal((await fetch(callback)).status, 200);
    const ready = await post("oauth-status", selector);
    assert.equal(ready.body.status, "ready"); assert.equal(ready.body.receipt.kind, "mcp-connect");
    assert.equal(fixture.state.exchanges, 1); assert.equal(fixture.state.probes, 1);
    let binding = service.pluginStore.getBinding(ready.body.bindingId);
    assert.equal(binding.enabled, true);
    assert.match(service.pluginStore.getConnection(binding.connectionId).principalIdentity, /^oauth:fixture:[a-f0-9]{64}$/u);
    assert.equal(service.pluginStore.getGrantCountsForBinding(binding.bindingId).allow, 0);
    const ciphertext = fs.readFileSync(paths.encryptedSecretsPath, "utf8");
    assert.equal(ciphertext.includes(ACCESS), false); assert.equal(ciphertext.includes(REFRESH), false);
    assert.equal((await backend.getPluginOperation(input.operationId)).operation.phase, "completed");

    if (bundledProvider) {
      const tools = shopify ? [
        { name: "list_products", description: "Read products in a shop", inputSchema: {
          type: "object", properties: { shopId: { type: "string" } }, required: ["shopId"] } },
        { name: "create_product", description: "Create a product in a shop", inputSchema: {
          type: "object", properties: { shopId: { type: "string" }, title: { type: "string" } },
          required: ["shopId", "title"] } },
      ] : [
        { name: "list_records", description: "Read records in a base", inputSchema: {
          type: "object", properties: { baseId: { type: "string" }, tableId: { type: "string" } },
          required: ["baseId", "tableId"] } },
        { name: "create_record", description: "Create a record in a base", inputSchema: {
          type: "object", properties: { baseId: { type: "string" }, tableId: { type: "string" },
            fields: { type: "object" } }, required: ["baseId", "tableId", "fields"] } },
      ];
      const mcpState = { calls: 0, authorizedRequests: 0, items: [] };
      mcpFixture = http.createServer(async (request, response) => {
        if (request.url !== "/mcp" || request.method !== "POST") {
          response.writeHead(request.method === "GET" ? 405 : 404); response.end(); return;
        }
        if (request.headers.authorization !== `Bearer ${ACCESS}-account-a`) {
          response.writeHead(401); response.end(); return;
        }
        mcpState.authorizedRequests += 1;
        let body = ""; for await (const chunk of request) body += chunk;
        const rpc = JSON.parse(body);
        let result;
        if (rpc.method === "tools/list") result = { jsonrpc: "2.0", id: rpc.id, result: { tools } };
        else if (rpc.method === "tools/call") {
          const { name, arguments: args } = rpc.params || {};
          if (shopify) assert.equal(args?.shopId, "shopFixture");
          else { assert.equal(args?.baseId, "appFixture"); assert.equal(args?.tableId, "tblFixture"); }
          mcpState.calls += 1;
          let structuredContent;
          if (name === (shopify ? "create_product" : "create_record")) {
            const item = shopify ? { id: "productFixture", title: args.title }
              : { id: "recFixture", fields: args.fields };
            mcpState.items.push(item);
            structuredContent = { id: item.id };
          } else if (name === (shopify ? "list_products" : "list_records")) {
            structuredContent = shopify ? { products: mcpState.items } : { records: mcpState.items };
          } else assert.fail(`unexpected bundled MCP fixture tool ${name}`);
          result = { jsonrpc: "2.0", id: rpc.id, result: {
            content: [{ type: "text", text: JSON.stringify(structuredContent) }],
            structuredContent, isError: false } };
        } else result = fixtureMcpHandle(rpc, "2025-11-25", mcpState);
        if (!result) { response.writeHead(202); response.end(); return; }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      });
      await new Promise((resolve, reject) => {
        mcpFixture.once("error", reject); mcpFixture.listen(0, "127.0.0.1", resolve);
      });
      const fixtureUrl = `http://127.0.0.1:${mcpFixture.address().port}/mcp`;
      const firstConnection = service.pluginStore.getConnection(binding.connectionId);
      const client = await PluginMcpClient.connectHttp({ url: endpoint,
        connectionId: firstConnection.connectionId, principalIdentity: firstConnection.principalIdentity,
        authRevision: firstConnection.authRevision,
        credentialProvider: service.pluginConnectionAuth.credentialProvider(firstConnection),
        authorizeEgress: () => true, timeoutMs: 3000,
        fetchImpl: (target, init) => {
          assert.equal(target.href, endpoint, "MCP SDK may only target the frozen bundled endpoint");
          return fetch(fixtureUrl, { ...init, redirect: "manual" });
        } });
      try {
        const readName = shopify ? "list_products" : "list_records";
        const writeName = shopify ? "create_product" : "create_record";
        assert.deepEqual((await client.listTools()).map(tool => tool.name), [readName, writeName]);
        await service.pluginToolCatalogRegistry.refresh({
          installation: { ...service.pluginStore.getInstallation(input.installationId),
            activeReleaseDigest: enabled.installation.releaseDigest },
          connection: firstConnection, client,
        });
        const visible = await backend.getPluginMcpTools(profile.agentId, binding.bindingId);
        assert.deepEqual(visible.items.map(item => item.name).sort(), [writeName, readName].sort());
        assert.deepEqual(visible.portableCapabilities ?? [], [],
          "independent bundled MCP tools are not claimed equivalent to the managed connector");
        const writeArgs = shopify ? { shopId: "shopFixture", title: "Created through MCP" }
          : { baseId: "appFixture", tableId: "tblFixture", fields: { Name: "Created through MCP" } };
        const readArgs = shopify ? { shopId: "shopFixture" }
          : { baseId: "appFixture", tableId: "tblFixture" };
        assert.equal((await client.callTool(writeName, writeArgs,
          { runId: `${shopify ? "shopify" : "airtable"}-write` })).structuredContent.id,
        shopify ? "productFixture" : "recFixture");
        const readback = await client.callTool(readName, readArgs,
          { runId: `${shopify ? "shopify" : "airtable"}-read` });
        assert.equal(shopify ? readback.structuredContent.products[0].title
          : readback.structuredContent.records[0].fields.Name, "Created through MCP");
        assert.equal(mcpState.calls, 2); assert.ok(mcpState.authorizedRequests >= 2);
      } finally { await client.close(); }

      const oldToolIdentity = `plugin:${input.installationId}:${input.componentId}:${binding.connectionId}:${"a".repeat(64)}`;
      service.pluginStore.setGrant({ grantId: "bundled-oauth-old-grant", bindingId: binding.bindingId,
        toolIdentity: oldToolIdentity, contractDigest: "b".repeat(64), effect: "allow",
        approvalMode: "always", expectedRevision: 0 });
      const switchStart = await post("oauth-connect", { ...input, operationId: "bundled-oauth-account-b" });
      assert.equal(switchStart.status, 200);
      const switchAuth = new URL(nativeUrls.at(-1));
      const switchRedirect = switchAuth.searchParams.get("redirect_uri");
      assert.equal(switchRedirect, fixedRedirect);
      fixture.state.codes.set("account-b-code", { redirect: switchRedirect,
        challenge: switchAuth.searchParams.get("code_challenge"), account: "account-b" });
      const switchCallback = new URL(switchRedirect);
      for (const [key, value] of Object.entries({ code: "account-b-code", iss: ISSUER,
        state: switchAuth.searchParams.get("state") })) switchCallback.searchParams.set(key, value);
      assert.equal((await fetch(switchCallback)).status, 200);
      assert.equal((await post("oauth-status", { agentId: profile.agentId,
        flowId: switchStart.body.flow.flowId })).body.status, "ready");
      const oldConnectionId = binding.connectionId;
      binding = service.pluginStore.getBinding(binding.bindingId);
      assert.notEqual(binding.connectionId, oldConnectionId);
      assert.notEqual(service.pluginStore.getConnection(binding.connectionId).principalIdentity,
        firstConnection.principalIdentity);
      assert.equal(service.pluginStore.getGrant(binding.bindingId, oldToolIdentity).effect, "deny");
      const disconnect = await post("disconnect", { agentId: profile.agentId,
        bindingId: binding.bindingId, expectedRevision: binding.revision,
        operationId: "bundled-oauth-disconnect" });
      assert.equal(disconnect.status, 200, JSON.stringify(disconnect.body));
      assert.equal(service.pluginStore.getBinding(binding.bindingId).enabled, false);
      assert.equal(service.pluginStore.getConnection(binding.connectionId).state, "disconnected");
      assert.equal(service.pluginStore.getGrant(binding.bindingId, oldToolIdentity).effect, "deny");
    }

    if (!bundledProvider) {
    const reconnect = await post("oauth-connect", { ...input, operationId: "oauth-management-cancel" });
    assert.equal(reconnect.status, 200);
    assert.equal(service.pluginStore.getBinding(binding.bindingId).enabled, true);
    const cancelResult = await post("oauth-cancel", { agentId: profile.agentId, flowId: reconnect.body.flow.flowId });
    assert.equal(cancelResult.body.status, "canceled");
    await assert.rejects(fetch(new URL(nativeUrls.at(-1)).searchParams.get("redirect_uri")), TypeError);
    openingFails = true;
    assert.notEqual((await post("oauth-connect", { ...input, operationId: "oauth-native-open-fails" })).status, 200);
    assert.equal(service.pluginStore.getConnectionCountsForComponent(input.installationId, input.componentId).pending, 0,
      "native browser failure cancels newly created OAuth authority");
    assert.equal(service.pluginStore.getBinding(binding.bindingId).enabled, true);
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
    assert.equal(service.pluginStore.getBinding(binding.bindingId).enabled, true);
    }
    console.log(bundledProvider
      ? `bundled ${shopify ? "Shopify" : "Airtable"} registered-client OAuth / fixed callback / MCP read-write / account revoke fixture: PASS`
      : "plugin OAuth static trust / Service / Backend / REST / native consent fixture: PASS");
  } finally {
    await web?.close(); await service.stop({ notify: false });
    if (callbackBlocker) await new Promise(resolve => callbackBlocker.close(resolve));
    if (mcpFixture) await new Promise(resolve => { mcpFixture.close(resolve); mcpFixture.closeIdleConnections(); });
    await fixture.close(); encryptionKey.fill(0); fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
