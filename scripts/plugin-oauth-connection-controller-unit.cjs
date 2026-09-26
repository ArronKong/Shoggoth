"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginComponentResolver } = require("../app/agent-service/plugin-component-resolver");
const { PluginMcpConnectionManager } = require("../app/agent-service/plugin-mcp-connection-manager");
const { componentId } = require("../app/agent-service/plugin-component-catalog");
const { EncryptedSecretStore } = require("../app/agent-service/encrypted-secret-store");
const { PluginCredentialVault } = require("../app/agent-service/plugin-credential-vault");
const { PluginConnectionAuth } = require("../app/agent-service/plugin-connection-auth");
const { PluginOAuthProviderRegistry } = require("../app/agent-service/plugin-oauth-provider-registry");
const { PluginOAuthConnectionController } = require("../app/agent-service/plugin-oauth-connection-controller");
const { PluginConnectionController } = require("../app/agent-service/plugin-connection-controller");

const sha = value => crypto.createHash("sha256").update(value).digest("hex");
async function fixtureServer() {
  const state = { requests: 0, exchanges: 0, refreshes: 0, probes: 0, codes: new Map(),
    tokens: new Map(), tokenWait: null, verifyWait: null, metadataWait: null,
    badIssuer: false, widerScope: false, account: "account-a" };
  let base;
  const server = http.createServer(async (request, response) => {
    state.requests += 1;
    const url = new URL(request.url, base);
    const json = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      if (state.metadataWait) await state.metadataWait();
      json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["issues:read"] }); return;
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")
      || url.pathname.startsWith("/.well-known/openid-configuration")) {
      json({ issuer: state.badIssuer ? "https://evil.invalid/" : base,
        authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
        response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true }); return;
    }
    if (url.pathname === "/token") {
      let body = ""; for await (const chunk of request) body += chunk;
      const params = new URLSearchParams(body);
      assert.equal(params.get("resource"), `${base}/mcp`);
      assert.equal(params.get("client_id"), "preregistered-fixture");
      let account;
      if (params.get("grant_type") === "refresh_token") {
        state.refreshes += 1; account = state.tokens.get(params.get("refresh_token"));
      } else {
        state.exchanges += 1;
        const authorization = state.codes.get(params.get("code"));
        assert.equal(authorization.challenge, crypto.createHash("sha256").update(params.get("code_verifier")).digest("base64url"));
        assert.equal(params.get("redirect_uri"), authorization.redirect);
        account = authorization.account;
      }
      if (state.tokenWait) await state.tokenWait();
      if (!account) { json({ error: "invalid_grant" }, 400); return; }
      const access = `fixture-access-${state.exchanges}-${state.refreshes}`;
      const refresh = `fixture-refresh-${state.exchanges}-${state.refreshes}`;
      state.tokens.set(access, account); state.tokens.set(refresh, account);
      json({ access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 120,
        scope: state.widerScope ? "issues:read admin:write" : "issues:read" }); return;
    }
    if (url.pathname === "/identity") {
      state.probes += 1;
      const account = state.tokens.get((request.headers.authorization || "").replace(/^Bearer /u, ""));
      json(account ? { id: account } : { error: "unauthorized" }, account ? 200 : 401); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  return { state, base, close: () => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }) };
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sgoa-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), trustedRoot: root });
  const fixture = await fixtureServer();
  const store = new PluginStore({ paths }).open();
  const encryptionKey = crypto.randomBytes(32);
  const secrets = await new EncryptedSecretStore({ paths, cryptoBroker: {
    async encrypt(plaintext) {
      const nonce = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, nonce);
      return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    },
    async decrypt(encrypted) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, encrypted.subarray(0, 12));
      decipher.setAuthTag(encrypted.subarray(-16));
      return Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]);
    },
  } }).open();
  let controller;
  let now = 1_000_000;
  try {
    const source = path.join(root, "source");
    fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), source, { recursive: true });
    const mcp = JSON.parse(fs.readFileSync(path.join(source, "mcp.json"), "utf8"));
    mcp.mcpServers["remote-issues"].url = `${fixture.base}/mcp`;
    fs.writeFileSync(path.join(source, "mcp.json"), JSON.stringify(mcp));
    const installer = new PluginPackageInstaller({ store });
    const installed = installer.install({ sourcePath: source, previewDigest: installer.preview(source).contentDigest,
      operationId: "oauth-install", expectedRevision: 0 });
    const installation = store.setInstallationDesiredState({ installationId: installed.installationId,
      desiredState: "enabled", expectedRevision: installed.revision });
    const profile = { id: "profile-a", name: "Local Agent", enabled: true };
    const productStore = { getAgentProfile: id => id === profile.id ? profile : null };
    const providers = new PluginOAuthProviderRegistry({ providers: [{ id: "local-fixture", name: "Local fixture OAuth",
      serverUrl: `${fixture.base}/mcp`, issuer: fixture.base, authorizationEndpoint: `${fixture.base}/authorize`,
      tokenEndpoint: `${fixture.base}/token`, clientId: "preregistered-fixture", scopes: ["issues:read"], allowLoopback: true,
      metadataUrls: ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"].map(value => fixture.base + value),
      identityUrls: [`${fixture.base}/identity`],
      async verifyPrincipal({ accessToken, fetchImpl }) {
        const response = await fetchImpl(`${fixture.base}/identity`, { headers: { Authorization: `Bearer ${accessToken}` } });
        const principal = response.ok ? (await response.json()).id : null;
        if (fixture.state.verifyWait) await fixture.state.verifyWait();
        return principal;
      },
    }] });
    const invalidated = [];
    const vault = new PluginCredentialVault({ store, secretStore: secrets,
      verifyPrincipal: input => providers.verifyPrincipal(input), refreshTokens: input => providers.refreshTokens(input),
      invalidateToolCatalog: id => { invalidated.push(id); }, now: () => now });
    const manager = new PluginMcpConnectionManager({ store, resolver: new PluginComponentResolver({ store }) });
    controller = new PluginOAuthConnectionController({ store, productStore, manager, providers, vault,
      now: () => now, lifetimeMs: 5000 });
    const input = { profileId: profile.id, installationId: installation.installationId,
      componentId: componentId(installation.installationId, "mcp-server", "remote-issues"),
      expectedRevision: installation.revision, operationId: "oauth-connect-a" };
    const current = flow => controller.status({ profileId: profile.id, flowId: flow.flowId });
    const prepare = operationId => controller.prepare({ ...input, operationId });
    const begin = async operationId => (await controller.commit({ challenge: prepare(operationId).challenge, approved: true })).flow;
    const callback = (flow, code, account = fixture.state.account) => {
      const auth = new URL(flow.authorizationUrl);
      assert.equal(auth.searchParams.get("scope"), "issues:read");
      assert.equal(auth.searchParams.get("client_id"), "preregistered-fixture");
      const redirect = auth.searchParams.get("redirect_uri");
      assert.equal(new URL(redirect).hostname, "127.0.0.1");
      fixture.state.codes.set(code, { challenge: auth.searchParams.get("code_challenge"), redirect, account });
      const result = new URL(redirect);
      result.searchParams.set("state", auth.searchParams.get("state")); result.searchParams.set("code", code);
      result.searchParams.set("iss", fixture.base); return result;
    };
    const requestCount = fixture.state.requests;
    const preview = prepare("canceled-preview");
    assert.deepEqual(preview.summary.scopes, ["issues:read"]);
    assert.equal(preview.summary.reconnect, false);
    assert.equal(fixture.state.requests, requestCount, "preview has zero network side effects");
    assert.deepEqual(await controller.commit({ challenge: preview.challenge, approved: false }), { canceled: true, flow: null });
    assert.equal(store.getConnectionCountsForComponent(input.installationId, input.componentId).pending, 0);
    assert.throws(() => controller.prepare({ ...input, clientId: "attacker" }), { code: "PLUGIN_REQUEST_INVALID" });
    assert.throws(() => new PluginOAuthProviderRegistry().forEndpoint(`${fixture.base}/mcp`), { code: "PLUGIN_OAUTH_PROVIDER_UNSUPPORTED" });
    await assert.rejects(providers.fetchFor(`${fixture.base}/mcp`)("https://evil.invalid/token"), { code: "CONNECTION_AUTH_REQUIRED" });
    const first = await begin(input.operationId);
    assert.equal(store.listBindingsForProfile(profile.id).length, 0, "pending login grants no binding");
    assert.throws(() => controller.status({ profileId: "profile-b", flowId: first.flowId }), { code: "PLUGIN_OAUTH_FLOW_NOT_FOUND" });
    const correct = callback(first, "code-a");
    const wrong = new URL(correct); wrong.searchParams.set("state", "wrong-state");
    assert.equal((await fetch(wrong)).status, 400);
    assert.equal(current(first).status, "pending");
    assert.equal(fixture.state.exchanges, 0);
    assert.equal((await fetch(correct)).status, 200);
    const ready = current(first);
    assert.equal(ready.status, "ready");
    assert.equal(ready.receipt.kind, "mcp-connect");
    assert.equal(store.getOperation(input.operationId).phase, "completed");
    let binding = store.getBinding(ready.bindingId);
    const firstConnection = store.getConnection(binding.connectionId);
    assert.equal(firstConnection.principalIdentity, "account-a");
    assert.equal(binding.enabled, true);
    assert.equal(store.getGrantCountsForBinding(binding.bindingId).allow, 0);
    assert.equal(JSON.stringify(ready).includes("fixture-access"), false);
    assert.equal(fs.readFileSync(paths.encryptedSecretsPath, "utf8").includes("fixture-access"), false);
    await assert.rejects(fetch(correct), TypeError);
    const auth = new PluginConnectionAuth({ getConnection: id => store.getConnection(id),
      readCredential: id => vault.readCredential(id), refreshCredential: value => vault.refreshCredential(value), now: () => now });
    now += 95_000;
    const credential = await auth.credentialProvider(firstConnection)();
    assert.match(credential.accessToken, /^fixture-access-/u);
    assert.equal(fixture.state.refreshes, 1);
    assert.deepEqual(invalidated, [firstConnection.connectionId, firstConnection.connectionId]);
    assert.equal(store.getConnection(firstConnection.connectionId).authRevision, firstConnection.authRevision);
    assert.equal(fixture.state.probes, 2, "initial and refreshed access tokens both require principal proof");

    const toolIdentity = `plugin:${input.installationId}:${input.componentId}:${binding.connectionId}:${"a".repeat(64)}`;
    store.setGrant({ grantId: "old-http-grant", bindingId: binding.bindingId, toolIdentity,
      contractDigest: "b".repeat(64), effect: "allow", approvalMode: "always", expectedRevision: 0 });
    const reconnect = await begin("oauth-reconnect-b");
    assert.equal(store.getGrant(binding.bindingId, toolIdentity).effect, "deny");
    assert.equal(store.getBinding(binding.bindingId).enabled, false);
    assert.equal((await fetch(callback(reconnect, "code-b", "account-b"))).status, 200);
    binding = store.getBinding(binding.bindingId);
    assert.notEqual(binding.connectionId, firstConnection.connectionId);
    assert.equal(store.getConnection(binding.connectionId).principalIdentity, "account-b");
    assert.equal(store.getGrant(binding.bindingId, toolIdentity).effect, "deny");
    assert.equal(binding.enabled, true);

    const canceled = await begin("oauth-cancel");
    const canceledCallback = callback(canceled, "cancel-code");
    assert.equal(controller.cancel({ profileId: profile.id, flowId: canceled.flowId }).status, "canceled");
    await assert.rejects(fetch(canceledCallback), TypeError);
    assert.equal(store.getBinding(binding.bindingId).enabled, false);
    const expired = await begin("oauth-expire");
    now += 5001;
    assert.equal(current(expired).status, "expired");
    const revoked = await begin("oauth-profile-revoked");
    profile.enabled = false;
    assert.equal(current(revoked).status, "failed");
    profile.enabled = true;
    const widened = await begin("oauth-widened");
    fixture.state.widerScope = true;
    assert.equal((await fetch(callback(widened, "wide-code"))).status, 400);
    assert.equal(current(widened).status, "failed");
    fixture.state.widerScope = false;
    fixture.state.badIssuer = true;
    await assert.rejects(begin("oauth-untrusted-discovery"), { code: "CONNECTION_AUTH_REQUIRED" });
    fixture.state.badIssuer = false;

    let release;
    let exchanging;
    const reached = new Promise(resolve => { exchanging = resolve; });
    fixture.state.tokenWait = () => { exchanging(); return new Promise(resolve => { release = resolve; }); };
    const race = await begin("oauth-cancel-exchange");
    const responsePromise = fetch(callback(race, "race-code"));
    await reached;
    assert.equal(controller.cancel({ profileId: profile.id, flowId: race.flowId }).status, "canceled");
    release();
    assert.equal((await responsePromise).status, 400);
    assert.equal(current(race).status, "canceled");
    assert.equal(store.getBinding(binding.bindingId).enabled, false, "canceled token exchange cannot restore old authority");
    assert.equal(store.getOperation("oauth-cancel-exchange"), null);
    fixture.state.tokenWait = null;
    let releaseVerification;
    let verifying;
    const verificationReached = new Promise(resolve => { verifying = resolve; });
    fixture.state.verifyWait = () => { verifying(); return new Promise(resolve => { releaseVerification = resolve; }); };
    const verifyRace = await begin("oauth-cancel-verification");
    const verificationResponse = fetch(callback(verifyRace, "verify-race-code"));
    await verificationReached;
    assert.equal(controller.cancel({ profileId: profile.id, flowId: verifyRace.flowId }).status, "canceled");
    releaseVerification();
    assert.equal((await verificationResponse).status, 400);
    assert.equal(current(verifyRace).status, "canceled");
    assert.equal(store.getOperation("oauth-cancel-verification"), null);
    assert.equal(store.getBinding(binding.bindingId).enabled, false);
    fixture.state.verifyWait = null;
    assert.equal(store.getConnectionCountsForComponent(input.installationId, input.componentId).pending, 0);
    // Disconnect an already-disabled old binding while reconnect is verifying:
    // the binding must advance again or that pending login could late-bind.
    let finishDisconnectVerification, enteredDisconnectVerification;
    const disconnectVerificationReached = new Promise(resolve => { enteredDisconnectVerification = resolve; });
    fixture.state.verifyWait = () => { enteredDisconnectVerification(); return new Promise(resolve => { finishDisconnectVerification = resolve; }); };
    const disconnectRace = await begin("oauth-disconnect-race");
    const beforeDisconnect = store.getBinding(binding.bindingId);
    assert.equal(beforeDisconnect.enabled, false);
    const oldConnection = store.getConnectionAuth(beforeDisconnect.connectionId);
    const retainedSecret = await secrets.get(oldConnection.credentialRef);
    const disconnectResponse = fetch(callback(disconnectRace, "disconnect-race-code"));
    await disconnectVerificationReached;
    const disconnect = new PluginConnectionController({ store, productStore,
      drainConnection: async () => {}, invalidateConnection: () => {},
      cancelStaleOAuth: values => controller.cancelStaleForBindings(values) });
    const disconnectInput = { profileId: profile.id, bindingId: binding.bindingId,
      expectedRevision: beforeDisconnect.revision, operationId: "disconnect-old-http-account" };
    const disconnected = disconnect.commit({ challenge: disconnect.prepare(disconnectInput).challenge, approved: true });
    assert.equal(store.getConnection(oldConnection.connectionId).state, "disconnected");
    assert.equal(store.getBinding(binding.bindingId).revision, beforeDisconnect.revision + 1);
    await Promise.resolve();
    assert.equal(current(disconnectRace).status, "canceled");
    finishDisconnectVerification();
    assert.equal((await disconnectResponse).status, 400);
    assert.equal((await disconnected).receipt.cleanupStatus, "complete");
    assert.equal(store.getOperation("oauth-disconnect-race"), null);
    assert.equal(await vault.readCredential(oldConnection.connectionId), null);
    assert.equal(await secrets.get(oldConnection.credentialRef), retainedSecret, "disconnect retains encrypted credentials without making them usable");
    fixture.state.verifyWait = null;
    const freshAfterDisconnect = await begin("oauth-after-disconnect");
    assert.equal((await disconnect.commit({ challenge: disconnect.prepare(disconnectInput).challenge, approved: true })).receipt.cleanupStatus, "complete");
    assert.equal(current(freshAfterDisconnect).status, "pending", "old cleanup replay must not cancel freshly confirmed OAuth");
    controller.cancel({ profileId: profile.id, flowId: freshAfterDisconnect.flowId });
    let releaseDiscovery;
    let discovering;
    const discoveryReached = new Promise(resolve => { discovering = resolve; });
    fixture.state.metadataWait = () => { discovering(); return new Promise(resolve => { releaseDiscovery = resolve; }); };
    const closingStart = begin("oauth-close-starting");
    const rejectedStart = assert.rejects(closingStart, { code: "CONNECTION_AUTH_REQUIRED" });
    await discoveryReached;
    let timeout;
    try {
      assert.equal(await Promise.race([controller.close().then(() => "closed"),
        new Promise(resolve => { timeout = setTimeout(() => resolve("timeout"), 2000); })]), "closed",
      "Service shutdown aborts SDK discovery rather than waiting for its network deadline");
      await rejectedStart;
    } finally { clearTimeout(timeout); releaseDiscovery(); }
    fixture.state.metadataWait = null;
    assert.equal(store.getConnectionCountsForComponent(input.installationId, input.componentId).pending, 0);
    assert.throws(() => prepare("after-close"), { code: "PLUGIN_UNAVAILABLE" });
    console.log("plugin trusted OAuth lifecycle/loopback/PKCE/principal/refresh/reconnect/cancel fixture: PASS");
  } finally {
    await controller?.close(); await secrets.close(); store.close(); encryptionKey.fill(0);
    await fixture.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
