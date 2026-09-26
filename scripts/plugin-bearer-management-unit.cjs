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
const { verifyGitHubBearer } = require("../app/agent-service/plugin-github-bearer-verifier");
const { PluginMcpClient } = require("../app/agent-service/plugin-mcp-client");
const { handle: fixtureMcpHandle } = require("./fixtures/plugins/mcp-sdk-fixture.cjs");

const TOKEN_A = "github_pat_fixture_private_a";
const TOKEN_B = "github_pat_fixture_private_b";
const ENDPOINT = "https://api.githubcopilot.com/mcp/";

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sgbear-"));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "user"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const encryptionKey = crypto.randomBytes(32);
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, nonce);
      return Buffer.concat([nonce, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString("utf8");
    },
  };
  const probes = [];
  const fetchImpl = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, "https://api.github.com/user");
    assert.equal(request.redirect, "error");
    assert.equal(request.method, "GET");
    const token = request.headers.get("authorization");
    probes.push(token);
    if (token === `Bearer ${TOKEN_A}`) return Response.json({ id: 42, login: "fixture-a" });
    if (token === `Bearer ${TOKEN_B}`) return Response.json({ id: 43, login: "fixture-b" });
    return Response.json({ message: "Bad credentials" }, { status: 401 });
  };
  const options = { paths, safeStorage, prewarmMcpAuth: false,
    parentEnv: {}, pluginGitHubFetch: fetchImpl, version: "bearer-management-fixture" };
  let service = createAgentService(options);
  let web, mcpFixture;
  try {
    await service.start();
    const backend = new ShoggothBackend({ paths });
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    backend._profilesByAgent.set(profile.agentId, profile);
    const preview = await backend.previewPluginInstall({ kind: "bundled", packageId: "github" });
    assert.equal(preview.components.mcpServers[0].name, "github");
    assert.ok(preview.diagnostics.some(item => item.reasonCode === "CODEX_BEARER_CONNECTION_REQUIRED"));
    const installed = await backend.installPlugin({ source: { kind: "bundled", packageId: "github" },
      previewDigest: preview.previewDigest, expectedRevision: preview.expectedRevision,
      operationId: "bearer-install" });
    const enabled = await backend.setPluginInstallationState({ installationId: installed.installation.installationId,
      desiredState: "enabled", expectedRevision: installed.installation.revision,
      operationId: "bearer-enable" });
    const page = await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 10, catalogRevision: null });
    const component = page.items[0].components.find(item => item.localName === "github");
    assert.equal(component.transport, "streamable-http");
    let approve = false, confirmations = 0;
    web = await startStaticServer(0, { homeDir: root, userDataRoot: root,
      registry: { route: id => id === profile.agentId ? backend : null,
        backends: new Map([["shoggoth", backend]]) },
      hostOps: { async confirmPluginCapability(summary) {
        confirmations += 1;
        assert.equal(summary.action, "bearer-connect");
        assert.equal(summary.provider, "GitHub");
        assert.equal(summary.agent, "所有助理");
        assert.equal(JSON.stringify(summary).includes(TOKEN_A), false);
        return approve;
      } } });
    const post = async (input, origin = web.url) => {
      const response = await fetch(`${web.url}/__api/plugins/bearer-connect`, { method: "POST",
        headers: { origin, "content-type": "application/json" }, body: JSON.stringify(input) });
      const raw = await response.text();
      let body; try { body = JSON.parse(raw); } catch { body = { error: raw }; }
      const publicText = JSON.stringify(body);
      for (const privateValue of [TOKEN_A, TOKEN_B, "credentialRef", "principalIdentity", ENDPOINT]) {
        assert.equal(publicText.includes(privateValue), false);
      }
      return { status: response.status, body };
    };
    const input = { agentId: profile.agentId, installationId: enabled.installation.installationId,
      componentId: component.componentId, expectedRevision: enabled.installation.revision,
      operationId: "bearer-connect-a", accessToken: TOKEN_A };
    assert.equal((await post(input, "https://evil.example")).status, 403);
    assert.equal((await post({ ...input, remoteUrl: ENDPOINT })).status, 400);
    assert.equal(confirmations, 0);
    assert.deepEqual(await post(input), { status: 200, body: { canceled: true, receipt: null } });
    assert.equal(probes.length, 0);
    assert.equal(service.pluginStore.getConnectionCountsForComponent(input.installationId, input.componentId).pending, 0);
    approve = true;
    assert.notEqual((await post({ ...input, accessToken: "wrong-token",
      operationId: "bearer-bad-token" })).status, 200);
    assert.equal(service.pluginStore.listGlobalBindings().length, 0);
    const localSource = path.join(root, "local-impersonator");
    fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), localSource, { recursive: true });
    fs.writeFileSync(path.join(localSource, "mcp.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { github: { type: "streamable-http", url: ENDPOINT } },
    }));
    const localPreview = await backend.previewPluginInstall({ kind: "directory", path: localSource });
    const localInstalled = await backend.installPlugin({ source: { kind: "directory", path: localSource },
      previewDigest: localPreview.previewDigest, expectedRevision: localPreview.expectedRevision,
      operationId: "bearer-impersonator-install" });
    const localEnabled = await backend.setPluginInstallationState({
      installationId: localInstalled.installation.installationId,
      desiredState: "enabled", expectedRevision: localInstalled.installation.revision,
      operationId: "bearer-impersonator-enable" });
    const localPage = await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 10, catalogRevision: null });
    const localComponent = localPage.items.find(item =>
      item.installationId === localEnabled.installation.installationId).components.find(item =>
      item.localName === "github");
    const probeCount = probes.length;
    assert.notEqual((await post({ ...input, installationId: localEnabled.installation.installationId,
      componentId: localComponent.componentId, expectedRevision: localEnabled.installation.revision,
      operationId: "bearer-impersonator-connect" })).status, 200);
    assert.equal(probes.length, probeCount, "an unrelated package cannot request GitHub token verification");
    const connected = await post(input);
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
    assert.equal(connected.body.receipt.kind, "mcp-connect");
    assert.equal(probes.length, 2);
    let binding = service.pluginStore.getBinding(connected.body.receipt.bindingId);
    assert.equal(binding.enabled, true);
    const firstConnection = service.pluginStore.getConnection(binding.connectionId);
    assert.equal(firstConnection.principalIdentity, "github:42");
    assert.equal(firstConnection.endpointIdentity, ENDPOINT);
    assert.equal((await service.pluginCredentialVault.readCredential(firstConnection.connectionId)).accessToken, TOKEN_A);
    assert.equal((await service.pluginConnectionAuth.credentialProvider(firstConnection)()).accessToken, TOKEN_A);
    assert.equal(fs.readFileSync(paths.encryptedSecretsPath, "utf8").includes(TOKEN_A), false);
    assert.equal(fs.readFileSync(paths.pluginCatalogPath).includes(Buffer.from(TOKEN_A)), false);
    assert.equal((await backend.getPluginOperation(input.operationId)).operation.phase, "completed");
    const toolIdentity = `plugin:${input.installationId}:${input.componentId}:${binding.connectionId}:${"a".repeat(64)}`;
    service.pluginStore.setGrant({ grantId: "bearer-old-grant", bindingId: binding.bindingId,
      toolIdentity, contractDigest: "b".repeat(64), effect: "allow", approvalMode: "always", expectedRevision: 0 });
    const renewed = await post({ ...input, operationId: "bearer-connect-b", accessToken: TOKEN_B });
    assert.equal(renewed.status, 200);
    binding = service.pluginStore.getBinding(binding.bindingId);
    assert.equal(binding.enabled, true);
    assert.notEqual(binding.connectionId, firstConnection.connectionId);
    assert.equal(service.pluginStore.getConnection(binding.connectionId).principalIdentity, "github:43");
    assert.equal(service.pluginStore.getGrant(binding.bindingId, toolIdentity).effect, "deny");
    assert.equal(service.pluginStore.listGlobalBindings().some(item =>
      item.connectionId === firstConnection.connectionId && item.enabled), false);
    assert.equal((await service.pluginConnectionAuth.credentialProvider(
      service.pluginStore.getConnection(binding.connectionId))()).accessToken, TOKEN_B);
    const mcpState = { calls: 0, authorizedRequests: 0 };
    mcpFixture = http.createServer(async (request, response) => {
      if (request.url !== "/mcp" || request.method !== "POST") {
        response.writeHead(request.method === "GET" ? 405 : 404); response.end(); return;
      }
      if (request.headers.authorization !== `Bearer ${TOKEN_B}`) {
        response.writeHead(401); response.end(); return;
      }
      mcpState.authorizedRequests += 1;
      let body = "";
      for await (const chunk of request) body += chunk;
      const result = fixtureMcpHandle(JSON.parse(body), "2025-11-25", mcpState);
      if (!result) { response.writeHead(202); response.end(); return; }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    });
    await new Promise((resolve, reject) => {
      mcpFixture.once("error", reject); mcpFixture.listen(0, "127.0.0.1", resolve);
    });
    const fixtureUrl = `http://127.0.0.1:${mcpFixture.address().port}/mcp`;
    const currentConnection = service.pluginStore.getConnection(binding.connectionId);
    const mcpClient = await PluginMcpClient.connectHttp({ url: ENDPOINT,
      connectionId: currentConnection.connectionId, principalIdentity: currentConnection.principalIdentity,
      authRevision: currentConnection.authRevision,
      credentialProvider: service.pluginConnectionAuth.credentialProvider(currentConnection),
      authorizeEgress: () => true, timeoutMs: 3000,
      fetchImpl: (target, init) => {
        assert.equal(target.href, ENDPOINT, "SDK may only target the pinned MCP endpoint");
        return fetch(fixtureUrl, { ...init, redirect: "manual" });
      } });
    try {
      assert.deepEqual((await mcpClient.listTools()).map(tool => tool.name), ["echo"]);
      assert.equal((await mcpClient.callTool("echo", { value: "local-fixture" },
        { runId: "fixture-run" })).structuredContent.echoed, "local-fixture");
      assert.equal(mcpState.calls, 1);
      assert.ok(mcpState.authorizedRequests >= 2);
    } finally { await mcpClient.close(); }
    await service.stop({ notify: false });
    service = createAgentService(options);
    await service.start();
    const reopenedBinding = service.pluginStore.getBinding(binding.bindingId);
    assert.equal(reopenedBinding.enabled, true);
    assert.equal(reopenedBinding.connectionId, currentConnection.connectionId);
    assert.equal((await service.pluginConnectionAuth.credentialProvider(
      service.pluginStore.getConnection(reopenedBinding.connectionId))()).accessToken, TOKEN_B,
    "encrypted GitHub connection remains usable after a clean Service restart");
    await assert.rejects(verifyGitHubBearer("bad\nheader", { fetchImpl }),
      error => error.code === "CONNECTION_AUTH_REQUIRED" && !JSON.stringify(error).includes("bad\nheader"));
    await assert.rejects(verifyGitHubBearer(TOKEN_A, { fetchImpl: () =>
      Response.json({ id: "42", login: "fixture-a" }) }), { code: "CONNECTION_AUTH_REQUIRED" });
    await assert.rejects(verifyGitHubBearer(TOKEN_A, { fetchImpl: () =>
      new Response("x".repeat(20_000)) }), { code: "CONNECTION_AUTH_REQUIRED" });
    console.log("bundled GitHub bearer Service / Backend / REST / encrypted account / reconnect / restart fixture: PASS");
  } finally {
    await web?.close(); await service.stop({ notify: false });
    if (mcpFixture) await new Promise(resolve => {
      mcpFixture.close(resolve); mcpFixture.closeIdleConnections();
    });
    encryptionKey.fill(0); fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
