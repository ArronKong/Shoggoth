"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { discoverAuthorizationServerMetadata, refreshAuthorization } = require("@modelcontextprotocol/client");
const { PluginOAuthSessionManager } = require("../app/agent-service/plugin-oauth-session");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { componentId } = require("../app/agent-service/plugin-component-catalog");
const { EncryptedSecretStore } = require("../app/agent-service/encrypted-secret-store");
const { PluginCredentialVault, newPluginCredentialRef } = require("../app/agent-service/plugin-credential-vault");
const { PluginConnectionAuth } = require("../app/agent-service/plugin-connection-auth");

async function fixtureServer() {
  const state = { tokenRequests: 0, refreshRequests: 0,
    resources: [], refreshResources: [], challenges: new Map() };
  let base;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, base);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base],
        scopes_supported: ["issues:read"] }));
      return;
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")
      || url.pathname.startsWith("/.well-known/openid-configuration")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`, response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true }));
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const params = new URLSearchParams(body);
      if (params.get("grant_type") === "refresh_token") {
        state.refreshRequests += 1;
        state.refreshResources.push(params.get("resource"));
        if (params.get("refresh_token") !== "fixture-refresh-token"
          || params.get("client_id") !== "fixture-client") {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ access_token: "fixture-access-refreshed",
          token_type: "Bearer", expires_in: 3600, scope: "issues:read" }));
        return;
      }
      state.tokenRequests += 1;
      state.resources.push(params.get("resource"));
      const challenge = state.challenges.get(params.get("code"));
      const actual = crypto.createHash("sha256").update(params.get("code_verifier") || "")
        .digest("base64url");
      if (!challenge || actual !== challenge || params.get("client_id") !== "fixture-client"
        || params.get("grant_type") !== "authorization_code") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: "fixture-access-token",
        refresh_token: "fixture-refresh-token", token_type: "Bearer",
        expires_in: 3600, scope: "issues:read" }));
      return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return { state, base, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function main() {
  assert.throws(() => new PluginOAuthSessionManager(), TypeError);
  const fixture = await fixtureServer();
  let now = 1000;
  const fetchImpl = (input, init) => {
    const target = new URL(input);
    assert.equal(target.origin, fixture.base);
    return fetch(target, { ...init, redirect: "manual" });
  };
  const manager = new PluginOAuthSessionManager({ fetchImpl, now: () => now,
    lifetimeMs: 5000 });
  const input = { connectionId: "account-a", serverUrl: `${fixture.base}/mcp`,
    redirectUrl: `${fixture.base}/callback`, clientId: "fixture-client",
    scope: "issues:read", allowLoopback: true };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-oauth-vault-"));
  const paths = resolveServicePaths({ stateRoot: path.join(temp, "state"),
    userDataRoot: temp, profileRoot: path.join(temp, "profile"),
    cacheRoot: path.join(temp, "cache"), trustedRoot: temp });
  const key = crypto.randomBytes(32);
  const broker = {
    async encrypt(plaintext) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    },
    async decrypt(encrypted) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12));
      decipher.setAuthTag(encrypted.subarray(-16));
      return Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]);
    },
  };
  const store = new PluginStore({ paths }).open();
  const secrets = await new EncryptedSecretStore({ paths, cryptoBroker: broker }).open();
  const installer = new PluginPackageInstaller({ store });
  const sourcePath = path.join(__dirname, "fixtures/plugins/project-assistant");
  const preview = installer.preview(sourcePath);
  const installed = installer.install({ sourcePath, previewDigest: preview.contentDigest,
    operationId: "fixture-oauth-install", expectedRevision: 0 });
  store.createConnection({ connectionId: input.connectionId,
    installationId: installed.installationId,
    componentId: componentId(installed.installationId, "mcp-server", "remote-issues"),
    endpointIdentity: input.serverUrl, credentialRef: newPluginCredentialRef() });
  const vault = new PluginCredentialVault({ store, secretStore: secrets,
    verifyPrincipal: () => "fixture-principal-a", now: () => now });
  const callback = (start, code, iss = fixture.base) => {
    const authorization = new URL(start.authorizationUrl);
    assert.equal(authorization.origin, fixture.base);
    assert.equal(authorization.pathname, "/authorize");
    assert.equal(authorization.searchParams.get("resource"), input.serverUrl);
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorization.searchParams.get("scope"), "issues:read");
    fixture.state.challenges.set(code, authorization.searchParams.get("code_challenge"));
    const redirect = new URL(input.redirectUrl);
    redirect.searchParams.set("state", authorization.searchParams.get("state"));
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("iss", iss);
    return redirect.href;
  };
  try {
    await assert.rejects(manager.start({ ...input, scope: "issues:read admin:write\n" }),
      (error) => error.code === "CONNECTION_AUTH_REQUIRED");
    const first = await manager.start(input);
    assert.equal(manager.status(input.connectionId).status, "pending");
    await assert.rejects(manager.consumeTokens({ connectionId: input.connectionId,
      commit: async () => { throw new Error("must not run"); } }),
    (error) => error.code === "CONNECTION_AUTH_REQUIRED");
    assert.equal(manager.status(input.connectionId).status, "pending");
    await assert.rejects(manager.start(input), (error) => error.code === "CONNECTION_AUTH_REQUIRED");
    const firstCallback = callback(first, "first-code");
    await assert.rejects(manager.finish({ connectionId: input.connectionId,
      callbackUrl: firstCallback.replace(/state=[^&]+/u, "state=wrong") }),
    (error) => error.code === "CONNECTION_AUTH_REQUIRED");
    assert.equal(manager.status(input.connectionId).status, "pending");
    const wrongPath = new URL(firstCallback);
    wrongPath.pathname = "/other-callback";
    await assert.rejects(manager.finish({ connectionId: input.connectionId,
      callbackUrl: wrongPath.href }),
    (error) => error.code === "CONNECTION_AUTH_REQUIRED");
    assert.equal(manager.status(input.connectionId).status, "pending");
    await assert.rejects(manager.finish({ connectionId: input.connectionId,
      callbackUrl: callback(first, "first-code", `${fixture.base}/other`) }),
    (error) => error.code === "CONNECTION_AUTH_REQUIRED");
    assert.equal(fixture.state.tokenRequests, 0);
    assert.equal(manager.status(input.connectionId).status, "disconnected");

    const second = await manager.start(input);
    const secondCallback = callback(second, "second-code");
    assert.deepEqual(await manager.finish({ connectionId: input.connectionId,
      callbackUrl: secondCallback }), { connectionId: input.connectionId,
      status: "token_received_unverified", scopes: ["issues:read"] });
    assert.equal(fixture.state.tokenRequests, 1);
    assert.deepEqual(fixture.state.resources, [input.serverUrl]);
    assert.equal(manager.status(input.connectionId).status, "token_received_unverified");
    await assert.rejects(manager.finish({ connectionId: input.connectionId,
      callbackUrl: secondCallback }), (error) => error.code === "CONNECTION_AUTH_REQUIRED");
    assert.equal(fixture.state.tokenRequests, 1);
    let handedOff = 0;
    assert.deepEqual(await manager.consumeTokens({ connectionId: input.connectionId,
      commit: async (tokens, metadata) => {
        handedOff += 1;
        assert.equal(tokens.access_token, "fixture-access-token");
        assert.equal(metadata.issuer, fixture.base);
        assert.equal(metadata.audience, input.serverUrl);
        assert.deepEqual(metadata.requestedScopes, ["issues:read"]);
        await vault.storePendingOAuthTokens({ connectionId: input.connectionId,
          expectedRevision: 1, tokens, ...metadata });
      } }), { connectionId: input.connectionId,
      status: "token_consumed_unverified" });
    assert.equal(handedOff, 1);
    assert.equal(store.getConnection(input.connectionId).state, "pending");
    assert.equal(await vault.readCredential(input.connectionId), null);
    assert.equal(fs.readFileSync(paths.encryptedSecretsPath, "utf8")
      .includes("fixture-access-token"), false);
    assert.equal((await vault.verifyAndActivate({ connectionId: input.connectionId,
      expectedRevision: 1 })).principalIdentity, "fixture-principal-a");
    assert.equal((await vault.readCredential(input.connectionId)).accessToken,
      "fixture-access-token");
    assert.equal(manager.status(input.connectionId).status, "disconnected");
    await assert.rejects(manager.consumeTokens({ connectionId: input.connectionId,
      commit: async () => { handedOff += 1; } }),
    (error) => error.code === "CONNECTION_AUTH_REQUIRED");
    assert.equal(handedOff, 1);

    const third = await manager.start({ ...input, connectionId: "account-b" });
    await assert.rejects(manager.finish({ connectionId: "account-b",
      callbackUrl: secondCallback }),
    (error) => error.code === "CONNECTION_AUTH_REQUIRED");
    assert.equal(manager.status("account-b").status, "pending");
    const missingIssuer = new URL(callback(third, "third-code"));
    missingIssuer.searchParams.delete("iss");
    await assert.rejects(manager.finish({ connectionId: "account-b",
      callbackUrl: missingIssuer.href }),
    (error) => error.code === "CONNECTION_AUTH_REQUIRED");
    assert.equal(fixture.state.tokenRequests, 1);
    const fourth = await manager.start({ ...input, connectionId: "account-b" });
    callback(fourth, "fourth-code");
    assert.equal(manager.status("account-b").status, "pending");
    assert.equal(manager.cancel("account-b"), true);
    assert.equal(manager.status("account-b").status, "disconnected");
    await assert.rejects(manager.finish({ connectionId: "account-b",
      callbackUrl: callback(fourth, "fourth-code") }),
    (error) => error.code === "CONNECTION_AUTH_REQUIRED");
    const fifth = await manager.start({ ...input, connectionId: "account-b" });
    callback(fifth, "fifth-code");
    now += 5000;
    await assert.rejects(manager.finish({ connectionId: "account-b",
      callbackUrl: callback(fifth, "fifth-code") }),
    (error) => error.code === "CONNECTION_AUTH_REQUIRED");
    assert.equal(manager.status("account-b").status, "disconnected");
    const failedCommit = await manager.start({ ...input, connectionId: "account-c" });
    await manager.finish({ connectionId: "account-c",
      callbackUrl: callback(failedCommit, "sixth-code") });
    await assert.rejects(manager.consumeTokens({ connectionId: "account-c",
      commit: async () => { throw new Error("fixture secret write failed"); } }),
    /fixture secret write failed/u);
    assert.equal(manager.status("account-c").status, "disconnected");
    const expiring = await manager.start({ ...input, connectionId: "account-d" });
    await manager.finish({ connectionId: "account-d",
      callbackUrl: callback(expiring, "seventh-code") });
    now += 5000;
    assert.equal(manager.status("account-d").status, "disconnected");
    await assert.rejects(manager.consumeTokens({ connectionId: "account-d",
      commit: async () => { throw new Error("must not run"); } }),
    (error) => error.code === "CONNECTION_AUTH_REQUIRED");
    assert.equal(fixture.state.tokenRequests, 3);
    now += 3_580_000;
    const refreshVault = new PluginCredentialVault({ store, secretStore: secrets,
      now: () => now,
      verifyPrincipal: ({ accessToken }) => {
        assert.equal(accessToken, "fixture-access-refreshed");
        return "fixture-principal-a";
      },
      async refreshTokens({ issuer, audience, refreshToken, scopes }) {
        assert.equal(issuer, `${fixture.base}/`);
        assert.equal(audience, input.serverUrl);
        assert.deepEqual(scopes, ["issues:read"]);
        const metadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn: fetchImpl });
        return refreshAuthorization(issuer, { metadata,
          clientInformation: { client_id: "fixture-client" },
          refreshToken, resource: audience, fetchFn: fetchImpl });
      },
    });
    const refreshAuth = new PluginConnectionAuth({
      getConnection: (id) => store.getConnection(id),
      readCredential: (id) => refreshVault.readCredential(id),
      refreshCredential: (context) => refreshVault.refreshCredential(context),
      now: () => now,
    });
    const refreshed = await refreshAuth.credentialProvider({
      connectionId: input.connectionId, principalIdentity: "fixture-principal-a",
      authRevision: 1, endpointIdentity: input.serverUrl,
      issuer: `${fixture.base}/`, audience: input.serverUrl,
      requiredScopes: ["issues:read"],
    })();
    assert.equal(refreshed.accessToken, "fixture-access-refreshed");
    assert.equal(fixture.state.refreshRequests, 1);
    assert.deepEqual(fixture.state.refreshResources, [input.serverUrl]);
    assert.equal(store.getConnection(input.connectionId).authRevision, 1);
    assert.equal(fs.readFileSync(paths.encryptedSecretsPath, "utf8")
      .includes("fixture-access-refreshed"), false);
    console.log("plugin OAuth session local fixture: PASS");
  } finally {
    await secrets.close();
    store.close();
    key.fill(0);
    fs.rmSync(temp, { recursive: true, force: true });
    await fixture.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
