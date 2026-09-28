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
const { verifiedMcpCapabilities } = require("../app/agent-service/plugin-verified-mcp-capabilities");
const { handle: fixtureMcpHandle } = require("./fixtures/plugins/mcp-sdk-fixture.cjs");

const TOKEN_A = "github_pat_fixture_private_a";
const TOKEN_B = "github_pat_fixture_private_b";
const ENDPOINT = "https://api.githubcopilot.com/mcp/";
const GITHUB_TOOLS = [
  { name: "get_file_contents", description: "Read a repository file", inputSchema: {
    type: "object", properties: { owner: { type: "string" }, repo: { type: "string" },
      path: { type: "string" }, ref: { type: "string" } }, required: ["owner", "repo"] } },
  { name: "create_or_update_file", description: "Write a repository file", inputSchema: {
    type: "object", properties: { owner: { type: "string" }, repo: { type: "string" },
      path: { type: "string" }, branch: { type: "string" }, content: { type: "string" },
      message: { type: "string" }, sha: { type: "string" } },
    required: ["owner", "repo", "path", "branch", "content", "message"] } },
  { name: "issue_read", description: "Read an issue", inputSchema: {
    type: "object", properties: { method: { type: "string", enum: ["get", "get_comments"] },
      owner: { type: "string" }, repo: { type: "string" }, issue_number: { type: "number" } },
    required: ["method", "owner", "repo", "issue_number"] } },
  { name: "add_issue_comment", description: "Comment on an issue", inputSchema: {
    type: "object", properties: { owner: { type: "string" }, repo: { type: "string" },
      issue_number: { type: "number" }, body: { type: "string", minLength: 1 } },
    required: ["owner", "repo", "issue_number"] } },
];

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
    let approve = false, confirmations = 0, accountSelections = 0;
    web = await startStaticServer(0, { homeDir: root, userDataRoot: root,
      registry: { route: id => id === profile.agentId ? backend : null,
        backends: new Map([["shoggoth", backend]]) },
      hostOps: { async confirmPluginCapability(summary) {
        confirmations += 1;
        if (summary.action === "mcp-account-select") {
          accountSelections += 1;
          assert.match(summary.account, /^GitHub #[0-9]+$/u);
          assert.ok(summary.grantsRevoked >= 0);
        } else {
          assert.equal(summary.action, "bearer-connect");
          assert.equal(summary.provider, "GitHub");
        }
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
    const status = await backend.getPluginMcpStatus(profile.agentId, input.installationId);
    const accounts = status.items.find(item => item.componentId === input.componentId).accounts;
    assert.deepEqual(accounts.map(item => item.label).sort(), ["GitHub #42", "GitHub #43"]);
    assert.equal(JSON.stringify(status).includes(TOKEN_A), false);
    assert.equal(JSON.stringify(status).includes(TOKEN_B), false);
    const selectedB = binding.connectionId;
    const grantB = `plugin:${input.installationId}:${input.componentId}:${selectedB}:${"c".repeat(64)}`;
    service.pluginStore.setGrant({ grantId: "bearer-b-grant", bindingId: binding.bindingId,
      toolIdentity: grantB, contractDigest: "d".repeat(64), effect: "allow",
      approvalMode: "always", expectedRevision: 0 });
    const select = async (connectionId, operationId, origin = web.url) => {
      const current = service.pluginStore.getBinding(binding.bindingId);
      const response = await fetch(`${web.url}/__api/plugins/account-select`, { method: "POST",
        headers: { origin, "content-type": "application/json" }, body: JSON.stringify({
          agentId: profile.agentId, bindingId: binding.bindingId, connectionId,
          expectedRevision: current.revision, operationId }) });
      const raw = await response.text();
      let body; try { body = JSON.parse(raw); } catch { body = { error: raw }; }
      return { status: response.status, body };
    };
    assert.equal((await select(firstConnection.connectionId, "account-switch-origin",
      "https://evil.example")).status, 403);
    approve = false;
    assert.deepEqual(await select(firstConnection.connectionId, "account-switch-cancel"),
      { status: 200, body: { canceled: true, receipt: null } });
    assert.equal(service.pluginStore.getBinding(binding.bindingId).connectionId, selectedB);
    approve = true;
    const switchedA = await select(firstConnection.connectionId, "account-switch-a");
    assert.equal(switchedA.status, 200, JSON.stringify(switchedA.body));
    assert.equal(switchedA.body.receipt.kind, "mcp-connect");
    assert.equal(service.pluginStore.getBinding(binding.bindingId).connectionId, firstConnection.connectionId);
    assert.equal(service.pluginStore.getGrant(binding.bindingId, grantB).effect, "deny");
    assert.equal((await service.pluginConnectionAuth.credentialProvider(
      service.pluginStore.getConnection(firstConnection.connectionId))()).accessToken, TOKEN_A);
    assert.equal((await backend.getPluginOperation("account-switch-a")).operation.phase, "completed");
    const switchedB = await select(selectedB, "account-switch-b");
    assert.equal(switchedB.status, 200, JSON.stringify(switchedB.body));
    assert.equal(service.pluginStore.getBinding(binding.bindingId).connectionId, selectedB);
    assert.equal(service.pluginStore.getGrant(binding.bindingId, grantB).effect, "deny",
      "switching back must not restore a previously allowed Grant");
    assert.equal(accountSelections, 3);
    const mcpState = { calls: 0, authorizedRequests: 0, files: new Map(), issueComments: [] };
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
      const rpc = JSON.parse(body);
      let result;
      if (rpc.method === "tools/list") {
        result = { jsonrpc: "2.0", id: rpc.id, result: { tools: GITHUB_TOOLS } };
      } else if (rpc.method === "tools/call") {
        const { name, arguments: args } = rpc.params || {};
        assert.equal(args?.owner, "fixture-owner");
        assert.equal(args?.repo, "fixture-repo");
        mcpState.calls += 1;
        let structuredContent;
        if (name === "create_or_update_file") {
          assert.equal(args?.path, "README.md");
          assert.equal(args.branch, "main");
          assert.equal(args.message, "Update fixture README");
          mcpState.files.set(args.path, args.content);
          structuredContent = { commitSha: "fixture-commit" };
        } else if (name === "get_file_contents") {
          assert.equal(args?.path, "README.md");
          structuredContent = { content: mcpState.files.get(args.path) ?? null };
        } else if (name === "issue_read") {
          assert.equal(args?.method, "get");
          assert.equal(args?.issue_number, 7);
          structuredContent = { number: 7, title: "Fixture issue",
            comments: [...mcpState.issueComments] };
        } else if (name === "add_issue_comment") {
          assert.equal(args?.issue_number, 7);
          assert.equal(args?.body, "Triage complete in the local fixture");
          mcpState.issueComments.push(args.body);
          structuredContent = { id: 101, body: args.body };
        } else assert.fail(`unexpected GitHub tool ${name}`);
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
      const liveTools = await mcpClient.listTools();
      assert.deepEqual(liveTools.map(tool => tool.name),
        ["get_file_contents", "create_or_update_file", "issue_read", "add_issue_comment"]);
      assert.deepEqual(verifiedMcpCapabilities({ installation: {
        installationId: input.installationId, sourceIdentity: "bundled:github" },
      connection: currentConnection, tools: liveTools }).map(item => item.id),
      ["repository-file-read", "repository-file-write", "repository-issue-read",
        "repository-issue-comment"]);
      await service.pluginToolCatalogRegistry.refresh({
        installation: { ...service.pluginStore.getInstallation(input.installationId),
          activeReleaseDigest: enabled.installation.releaseDigest },
        connection: currentConnection, client: mcpClient,
      });
      const visibleCatalog = await backend.getPluginMcpTools(profile.agentId, binding.bindingId);
      assert.deepEqual(visibleCatalog.portableCapabilities, [
        { id: "repository-file-read", toolName: "get_file_contents" },
        { id: "repository-file-write", toolName: "create_or_update_file" },
        { id: "repository-issue-read", toolName: "issue_read" },
        { id: "repository-issue-comment", toolName: "add_issue_comment" },
      ], "Service and Backend expose only the current verified independent MCP operations");
      assert.deepEqual(visibleCatalog.referenceCoverage, {
        packageId: "github", referenceName: "github",
        managedAppId: "connector_76869538009648d5b282a4bb21c3d157",
        relationship: "functional-overlap", equivalence: "unverified",
        operations: visibleCatalog.portableCapabilities,
      });
      assert.deepEqual(visibleCatalog.items.map(item => item.name).sort(),
        ["add_issue_comment", "create_or_update_file", "get_file_contents", "issue_read"]);
      const result = await mcpClient.callTool("create_or_update_file", {
        owner: "fixture-owner", repo: "fixture-repo", path: "README.md",
        branch: "main", content: "Updated through the independent MCP",
        message: "Update fixture README" }, { runId: "fixture-write" });
      assert.equal(result.structuredContent.commitSha, "fixture-commit");
      const readback = await mcpClient.callTool("get_file_contents", {
        owner: "fixture-owner", repo: "fixture-repo", path: "README.md", ref: "main",
      }, { runId: "fixture-read" });
      assert.equal(readback.structuredContent.content, "Updated through the independent MCP");
      const issue = await mcpClient.callTool("issue_read", { method: "get",
        owner: "fixture-owner", repo: "fixture-repo", issue_number: 7 }, { runId: "fixture-issue-read" });
      assert.equal(issue.structuredContent.title, "Fixture issue");
      const comment = await mcpClient.callTool("add_issue_comment", {
        owner: "fixture-owner", repo: "fixture-repo", issue_number: 7,
        body: "Triage complete in the local fixture" }, { runId: "fixture-issue-comment" });
      assert.equal(comment.structuredContent.id, 101);
      const issueAfter = await mcpClient.callTool("issue_read", { method: "get",
        owner: "fixture-owner", repo: "fixture-repo", issue_number: 7 }, { runId: "fixture-issue-readback" });
      assert.deepEqual(issueAfter.structuredContent.comments,
        ["Triage complete in the local fixture"]);
      assert.equal(mcpState.calls, 5);

      const issueCommentEntry = visibleCatalog.items.find(item => item.name === "add_issue_comment");
      assert.equal(issueCommentEntry.savedGrant, null,
        "functional coverage cannot create an execution Grant");
      const commentGrant = service.pluginStore.setGrant({ grantId: "github-fixture-issue-comment",
        bindingId: binding.bindingId, toolIdentity: issueCommentEntry.toolIdentity,
        contractDigest: issueCommentEntry.contractDigest, effect: "allow",
        approvalMode: "each-call", expectedRevision: 0 });
      assert.deepEqual((await backend.getPluginMcpTools(profile.agentId, binding.bindingId))
        .items.find(item => item.name === "add_issue_comment").savedGrant.effect, "allow");
      const deniedCommentGrant = service.pluginStore.setGrant({ grantId: commentGrant.grantId,
        bindingId: binding.bindingId,
        toolIdentity: issueCommentEntry.toolIdentity, contractDigest: issueCommentEntry.contractDigest,
        effect: "deny", approvalMode: "always", expectedRevision: commentGrant.revision });
      assert.equal((await backend.getPluginMcpTools(profile.agentId, binding.bindingId))
        .items.find(item => item.name === "add_issue_comment").savedGrant.effect, "deny",
      "revoking the tool changes its Service permission projection without changing the functional map");

      // The direct calls above establish the isolated provider contract. This
      // second client goes through the normal Service ticket at final egress.
      const guardedClient = await PluginMcpClient.connectHttp({ url: ENDPOINT,
        connectionId: currentConnection.connectionId,
        principalIdentity: currentConnection.principalIdentity,
        authRevision: currentConnection.authRevision,
        credentialProvider: service.pluginConnectionAuth.credentialProvider(currentConnection),
        authorizeEgress: input => service.pluginCapabilityDispatcher.authorizeEgress(input),
        timeoutMs: 3000,
        fetchImpl: (target, init) => {
          assert.equal(target.href, ENDPOINT);
          return fetch(fixtureUrl, { ...init, redirect: "manual" });
        } });
      try {
        const run = { id: "fixture-github-run", profileId: profile.id,
          workspace: root, status: "running" };
        const commentInput = () => {
          const records = service.pluginStore.getCapabilityRecords(binding.bindingId,
            issueCommentEntry.toolIdentity);
          const grant = records.grant;
          const commentArgs = { owner: "fixture-owner", repo: "fixture-repo", issue_number: 7,
            body: "Triage complete in the local fixture" };
          return { client: guardedClient,
            callId: `github-fixture-${crypto.randomUUID()}`,
            authority: { kind: "native-profile", profileId: profile.id,
              profile: service.productStore.getAgentProfile(profile.id),
              confirmed: true },
            execution: { kind: "native-run", profileId: profile.id, workspace: root, run },
            envelope: { runId: run.id, authorityIncarnation: records.authorityIncarnation,
              bindingId: binding.bindingId, installationId: input.installationId,
              releaseDigest: records.installation.activeReleaseDigest,
              componentId: binding.componentId, connectionId: currentConnection.connectionId,
              principalIdentity: currentConnection.principalIdentity,
              bindingRevision: records.binding.revision, grantEpoch: grant.epoch,
              connectionAuthRevision: currentConnection.authRevision,
              toolIdentity: issueCommentEntry.toolIdentity,
              contractDigest: issueCommentEntry.contractDigest },
            bindingId: binding.bindingId, toolIdentity: issueCommentEntry.toolIdentity,
            downstreamToolName: "add_issue_comment",
            contractDigest: issueCommentEntry.contractDigest, arguments: commentArgs };
        };
        await assert.rejects(service.pluginCapabilityDispatcher.dispatch(commentInput()),
          { code: "GRANT_REVOKED" });
        assert.equal(mcpState.calls, 5, "denied comment never reaches the MCP endpoint");
        service.pluginStore.setGrant({ grantId: deniedCommentGrant.grantId,
          bindingId: binding.bindingId, toolIdentity: issueCommentEntry.toolIdentity,
          contractDigest: issueCommentEntry.contractDigest, effect: "allow",
          approvalMode: "each-call", expectedRevision: deniedCommentGrant.revision });
        await assert.rejects(service.pluginCapabilityDispatcher.dispatch(commentInput()),
          { code: "CAPABILITY_FORBIDDEN" });
        assert.equal(mcpState.calls, 5, "each-call Grant alone cannot bypass approval");
        const approved = commentInput();
        const approvalReceipt = service.pluginCapabilityDispatcher.approveCall(approved);
        assert.equal((await service.pluginCapabilityDispatcher.dispatch({
          ...approved, approvalReceipt })).structuredContent.id, 101);
        assert.equal(mcpState.calls, 6,
          "one approved comment crosses the final Service egress gate");
      } finally { await guardedClient.close(); }
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
