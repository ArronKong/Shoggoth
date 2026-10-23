"use strict";
// Actual Service/REST/PKCE/PluginStore/Coordinator/Dispatcher/MCP HTTP paths.
// All Slack responses and Runtime turns are controlled local fixtures. This
// never uses an actual Slack account or sends any real workspace message.
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
const { pluginServerId } = require("../app/agent-service/plugin-runtime-tool-service");
const { FILE_NAME } = require("../app/agent-service/plugin-slack-registration");
const { FULL_COMPONENT, PROFILES } = require("../app/agent-service/plugin-slack-access-policy");
const slack = require("../app/agent-service/plugin-slack-oauth");
const { officialFixture, dualLoopbackPort, safeStorage } = require("./plugin-slack-registration-service-fixture.cjs");
const { FakeHost, directRuntimeManager, waitUntil } = require("./shoggoth-work-run-coordinator-unit.cjs");
const { normalizeInteractiveRequestV1 } = require("../app/core/shoggoth-interaction-contract");
const CLIENT_ID = "1234567890123.9876543210987";
const READS = ["slack_search_public", "slack_search_public_and_private", "slack_search_channels",
  "slack_search_users", "slack_read_channel", "slack_read_thread", "slack_read_file",
  "slack_read_user_profile", "slack_list_channel_members", "slack_get_reactions"];
const WRITES = ["slack_send_message", "slack_send_message_draft", "slack_schedule_message",
  "slack_add_reaction", "slack_create_canvas", "slack_get_file_upload_url", "slack_complete_file_upload"];
const remoteTools = [...READS, ...WRITES, "slack_post_message", "slack_read_unknown"].map(name => ({
  name, description: "Local controlled Slack protocol fixture", annotations: { readOnlyHint: true },
  inputSchema: { type: "object" },
}));
const outputPath = process.argv[2];
const sources = ["app/agent-service/server.js", "app/core/shoggoth-backend.js", "app/static-server.js",
  "app/core/bundled-plugin-catalog.js", "app/agent-service/plugin-slack-access-policy.js",
  "app/agent-service/plugin-slack-registration.js", "app/agent-service/plugin-slack-oauth.js",
  "app/agent-service/plugin-slack-official-plugin.js", "app/agent-service/plugin-mcp-connection-manager.js",
  "app/agent-service/plugin-mcp-consent.js", "app/agent-service/capability-dispatcher.js",
  "app/agent-service/plugin-runtime-tool-service.js", "app/agent-service/plugin-package-installer.js",
  "app/agent-service/plugin-component-resolver.js", "app/agent-service/plugin-package-parser.js",
  "app/agent-service/plugin-tool-catalog-registry.js", "app/agent-service/permission-engine.js",
  "app/agent-service/work-run-coordinator.js", "app/agent-service/plugin-store.js",
  "app/agent-service/plugin-reserved-official-endpoints.js", "app/agent-service/encrypted-secret-store.js",
  "scripts/plugin-slack-reviewed-tools-service-fixture.cjs", "scripts/plugin-slack-registration-service-fixture.cjs"];
const sourceHashes = () => Object.fromEntries(sources.map(file => [file,
  crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "..", file))).digest("hex")]));
const report = { verified: false, boundary: "actual local Service and Coordinator; controlled Slack and Runtime, no real account/business", profiles: [], checks: [] };
async function profileCase(selected) {
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-slack-reviewed-"));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, "home"); fs.mkdirSync(home, { mode: 0o700 });
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "user"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root, homeDir: home });
  const key = crypto.randomBytes(32), port = await dualLoopbackPort();
  const redirectUrl = `http://localhost:${port}/oauth/callback`;
  const calls = [], nativeEvents = [];
  const official = officialFixture(redirectUrl, { scopes: selected.scopes, tools: remoteTools,
    onToolCall(name, args) {
      assert([...READS, ...WRITES].includes(name), "unknown actions never reach the local transport");
      calls.push({ name, arguments: structuredClone(args) });
      return { content: [{ type: "text", text: "controlled local result" }],
        structuredContent: { accepted: true }, isError: false };
    } });
  const host = new FakeHost([]);
  const baseRuntime = directRuntimeManager(host, "codex");
  const runtimeManager = { async acquire(binding) {
    const handle = await baseRuntime.acquire(binding);
    return { ...handle, runtimeProfileId: binding.runtimeProfileId, runtimeAccountId: binding.runtimeAccountId };
  }, stop: () => {}, stopAll: () => {}, canGenerateModelOnly: () => false };
  const options = { paths, safeStorage: safeStorage(key), parentEnv: {}, prewarmMcpAuth: false,
    version: "slack-reviewed-tool-access-fixture", runtimeManager,
    pluginOAuthFetch: official.fetchImpl, pluginSlackMcpFetch: official.fetchImpl };
  let service, web, backend;
  try {
    service = createAgentService(options); await service.start();
    backend = new ShoggothBackend({ paths });
    const registry = { backends: new Map([["shoggoth", backend]]), route: id => backend._profilesByAgent.has(id) ? backend : null };
    let launchUrl;
    web = await startStaticServer(0, { homeDir: home, userDataRoot: root, registry,
      hostOps: { confirmPluginCapability: async summary => {
        if (["slack-registration", "oauth-connect"].includes(summary.action)) assert.deepEqual(summary.scopes, selected.scopes);
        return true;
      }, openExternal: async url => { launchUrl = url; } } });
    const post = async (route, body) => {
      const response = await fetch(`${web.url}/__api/plugins/${route}`, { method: "POST",
        headers: { origin: web.url, "content-type": "application/json" }, body: JSON.stringify(body) });
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
    };
    const rpc = (method, params) => requestService(paths, { token: readClientToken(paths),
      version: SERVICE_PROTOCOL_VERSION, method, params }, { timeoutMs: 10000 });
    const configured = await post("slack-registration-configure", { clientId: CLIENT_ID, redirectPort: port, scopes: selected.scopes });
    assert.equal(configured.restartRequired, true);
    const source = { kind: "bundled", packageId: "slack" }, preview = await backend.previewPluginInstall(source);
    const installed = await backend.installPlugin({ source, previewDigest: preview.previewDigest,
      expectedRevision: preview.expectedRevision, operationId: crypto.randomUUID() });
    const enabled = await backend.setPluginInstallationState({ installationId: installed.installation.installationId,
      desiredState: "enabled", expectedRevision: installed.installation.revision, operationId: crypto.randomUUID() });
    await service.stop({ notify: false });
    service = createAgentService(options); await service.start();
    assert.deepEqual(await post("slack-registration-status", {}),
      { configured: true, restartRequired: false, accessProfile: selected.id });
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    backend._profilesByAgent.set(profile.agentId, profile);
    const page = await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 10, catalogRevision: null });
    const component = page.items.find(row => row.installationId === enabled.installation.installationId)
      .components.find(row => row.localName === FULL_COMPONENT);
    assert(component);
    const started = await post("oauth-connect", { agentId: profile.agentId, installationId: enabled.installation.installationId,
      componentId: component.componentId, expectedRevision: enabled.installation.revision, operationId: crypto.randomUUID() });
    const authorization = new URL(launchUrl);
    assert.equal(authorization.searchParams.get("scope"), selected.scopes.join(" "));
    assert.equal(authorization.searchParams.get("resource"), slack.AUDIENCE);
    official.state.expectedChallenge = authorization.searchParams.get("code_challenge");
    const callback = new URL(redirectUrl);
    for (const [name, value] of [["code", "slack-fixture-code"], ["iss", slack.ISSUER], ["state", authorization.searchParams.get("state")]]) callback.searchParams.set(name, value);
    const completed = await fetch(callback); assert.equal(completed.status, 200, await completed.text());
    const ready = await post("oauth-status", { agentId: profile.agentId, flowId: started.flow.flowId });
    assert.equal(ready.status, "ready"); assert.equal(official.state.tokenExchanges, 1);
    const binding = service.pluginStore.getBinding(ready.bindingId);
    await backend.discoverPluginMcpTools(profile.agentId, binding.bindingId);
    const tools = await backend.getPluginMcpTools(profile.agentId, binding.bindingId);
    const expected = selected.id === "public-search" ? ["slack_search_public", "slack_search_channels"]
      : selected.id === "workspace-read" ? READS : [...READS, ...WRITES];
    assert.deepEqual(tools.items.map(row => row.name).sort(), [...expected].sort());
    assert(!tools.items.some(row => ["slack_post_message", "slack_read_unknown"].includes(row.name)));
    for (const tool of tools.items) {
      const write = WRITES.includes(tool.name);
      const input = { action: "allow", agentId: profile.agentId, bindingId: binding.bindingId,
        toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest, catalogRevision: tools.catalogRevision,
        approvalMode: write ? "each-call" : "always", expectedRevision: 0, operationId: crypto.randomUUID() };
      if (write) {
        await assert.rejects(backend.preparePluginMcpConsent({ ...input, approvalMode: "always" }), { code: "CAPABILITY_FORBIDDEN" });
        assert.equal(service.pluginStore.getGrant(binding.bindingId, tool.toolIdentity), null);
      }
      const consent = await backend.preparePluginMcpConsent(input);
      await backend.commitPluginMcpConsent({ challenge: consent.challenge, approved: true });
    }
    const sessionResult = await rpc("chat.session.create", { operationId: crypto.randomUUID(), profileId: profile.id,
      workspace: root, createdAt: Date.now() });
    const session = sessionResult.session;
    const ack = await rpc("chat.send", { operationId: crypto.randomUUID(), sessionKey: session.sessionKey,
      prompt: "Local Slack access contract fixture; no actual provider request", createdAt: Date.now() });
    await service.workRunCoordinator.waitForIdle(ack.run.id);
    assert.equal(service.workDispatcher.getRun(ack.run.id).status, "running");
    service.workRunCoordinator.subscribeRun(ack.run.id, { streamId: null, afterSeq: 0 }, event => nativeEvents.push(event));
    const serverId = pluginServerId(binding.bindingId);
    const args = name => name === "slack_search_public" ? { query: "fixture" }
      : { channel_id: "C_FIXTURE", text: "local fixture only; never sent to Slack" };
    const invoke = (name, authority = { profileId: profile.id, callId: crypto.randomUUID(), confirmation: true }) =>
      service.workRunCoordinator.invokeRuntimeCapability({ runId: ack.run.id,
        runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId },
      scope => service.pluginRuntimeToolService.callTool({ serverId, toolName: name, arguments: args(name) }, authority, scope));
    const waitApproval = async () => {
      await waitUntil(() => service.workDispatcher.getRun(ack.run.id).status === "waiting_approval", 3000, "real Coordinator approval");
      return service.workDispatcher.getRun(ack.run.id).waitingRequestId;
    };
    const respond = (requestId, choice) => rpc("run.approval.respond", { operationId: crypto.randomUUID(),
      runId: ack.run.id, requestId, choice, createdAt: Date.now() });
    for (const name of expected.filter(name => READS.includes(name))) {
      const result = await invoke(name);
      assert.equal(result.result.isError, false);
    }
    for (const name of ["slack_post_message", "slack_read_unknown"]) await assert.rejects(invoke(name));
    const beforeWrites = calls.length;
    if (selected.id === "workspace-write") {
      const denied = invoke("slack_send_message"); denied.catch(() => {});
      const requestId = await waitApproval();
      assert.equal(calls.length, beforeWrites, "model confirmation cannot send before a real approval");
      const event = nativeEvents.find(item => item.type === "approval" && item.payload.requestId === requestId);
      assert(event);
      const card = normalizeInteractiveRequestV1({ runId: ack.run.id, eventType: "approval", payload: event.payload });
      assert.deepEqual(JSON.parse(card.approvalDetails.command), args("slack_send_message"));
      assert(!card.approvalChoices.includes("session"));
      await respond(requestId, "deny"); await assert.rejects(denied, { code: "CAPABILITY_FORBIDDEN" });
      assert.equal(calls.length, beforeWrites);
      for (const name of WRITES) {
        const authority = { profileId: profile.id, callId: crypto.randomUUID(), confirmation: true };
        const pending = invoke(name, authority);
        const id = await waitApproval();
        await assert.rejects(respond(id, "session"));
        await respond(id, "once");
        assert.equal((await pending).result.structuredContent.accepted, true);
        await assert.rejects(invoke(name, authority), { code: "CALL_ALREADY_RECORDED" });
      }
      assert.equal(calls.length, beforeWrites + 7);
      const registrationFile = path.join(paths.pluginsDir, FILE_NAME);
      const originalRegistration = fs.readFileSync(registrationFile);
      const changing = invoke("slack_send_message"); changing.catch(() => {});
      const id = await waitApproval();
      const changed = JSON.parse(originalRegistration.toString()); changed.scopes = [...PROFILES[1].scopes];
      fs.writeFileSync(registrationFile, JSON.stringify(changed));
      await respond(id, "once"); await assert.rejects(changing, { code: "CAPABILITY_FORBIDDEN" });
      assert.equal(calls.length, beforeWrites + 7, "changed account scopes cannot inherit a completed prompt");
      assert.equal((await backend.getPluginSlackRegistrationStatus()).restartRequired, true);
      fs.writeFileSync(registrationFile, originalRegistration);
      const revoked = invoke("slack_send_message"); revoked.catch(() => {});
      const revokeRequest = await waitApproval();
      const tool = tools.items.find(row => row.name === "slack_send_message");
      const grant = service.pluginStore.getGrant(binding.bindingId, tool.toolIdentity);
      await backend.revokePluginMcpGrant({ agentId: profile.agentId, bindingId: binding.bindingId,
        toolIdentity: tool.toolIdentity, expectedRevision: grant.revision, operationId: crypto.randomUUID() });
      await respond(revokeRequest, "once"); await assert.rejects(revoked, { code: "GRANT_REVOKED" });
      assert.equal(calls.length, beforeWrites + 7, "approval cannot restore a revoked Grant");
      report.checks.push("actual Service-owned native approval once/deny, 7 write tools, session denial, durable no replay, changed scopes and Grant revocation");
    } else {
      for (const name of WRITES) await assert.rejects(invoke(name));
      assert.equal(calls.length, beforeWrites, "public/read account never gains write egress");
    }
    const ciphertext = fs.readFileSync(paths.encryptedSecretsPath, "utf8");
    assert(!ciphertext.includes("xoxp-fixture-access") && !ciphertext.includes("xoxe-fixture-refresh"));
    report.profiles.push({ accessProfile: selected.id, scopes: selected.scopes.length, visibleTools: expected.length,
      readCalls: expected.filter(name => READS.includes(name)).length, approvedWriteCalls: calls.length - beforeWrites,
      oauthExchanges: official.state.tokenExchanges, originalHostedEquivalent: false, actualSlackAccount: false });
  } finally {
    await web?.close();
    await service?.stop({ notify: false });
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
async function main() {
  if (outputPath && fs.existsSync(outputPath)) throw Error("New evidence path required");
  report.sourcesBefore = sourceHashes();
  for (const profile of PROFILES) await profileCase(profile);
  report.sourcesAfter = sourceHashes();
  assert.deepEqual(report.sourcesAfter, report.sourcesBefore);
  report.verified = true;
  if (outputPath) fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
