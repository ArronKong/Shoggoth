"use strict";

// The frozen Outlook Calendar card installs an independent Shoggoth Graph
// read-only sidecar. Exercise the real browser REST, Service authority, Store,
// native Run and one-use dispatch with a local substitute for Microsoft IO.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService } = require("../app/agent-service/server");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { startStaticServer } = require("../app/static-server");
const { pluginServerId } = require("../app/agent-service/plugin-runtime-tool-service");
const { materializeOutlookGraphSidecar } =
  require("../app/agent-service/plugin-outlook-graph-sidecar");

const CLIENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const RANGE = { startDateTime: "2026-09-27T00:00:00+08:00",
  endDateTime: "2026-09-28T00:00:00+08:00" };
const EVENT = { id: "meeting-1", subject: "Fixture planning", body: { content: "private body" },
  start: { dateTime: "2026-09-27T01:00:00", timeZone: "UTC" },
  end: { dateTime: "2026-09-27T02:00:00", timeZone: "UTC" },
  isAllDay: false, showAs: "busy", location: { displayName: "Room" },
  organizer: { emailAddress: { name: "Fixture", address: "fixture@example.test" } } };

function safeStorage(key) {
  return { isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      return Buffer.concat([nonce, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString("utf8");
    } };
}

function graphSubstitute() {
  const state = { challenge: null, tokenCalls: 0, graphCalls: 0, requests: [] };
  const json = body => new Response(JSON.stringify(body), { status: 200,
    headers: { "Content-Type": "application/json" } });
  return { state, async fetch(input, init = {}) {
    const url = new URL(input);
    state.requests.push({ method: init.method || "GET", url: url.href });
    if (url.origin === "https://login.microsoftonline.com") {
      assert.equal(url.pathname, "/common/oauth2/v2.0/token");
      const form = new URLSearchParams(init.body);
      assert.equal(form.get("client_id"), CLIENT_ID);
      assert.equal(form.get("scope"), "Calendars.Read User.Read offline_access");
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(crypto.createHash("sha256").update(form.get("code_verifier"))
        .digest("base64url"), state.challenge);
      state.tokenCalls += 1;
      return json({ access_token: "local-access-secret", refresh_token: "local-refresh-secret",
        token_type: "Bearer", expires_in: 3600, scope: "Calendars.Read User.Read" });
    }
    assert.equal(url.origin, "https://graph.microsoft.com");
    assert.equal(init.headers.Authorization, "Bearer local-access-secret");
    if (url.pathname === "/v1.0/me") return json({ id: "account-a" });
    assert.equal(url.pathname, "/v1.0/me/calendarView");
    assert.equal(url.searchParams.get("startDateTime"), RANGE.startDateTime);
    assert.equal(url.searchParams.get("endDateTime"), RANGE.endDateTime);
    state.graphCalls += 1;
    return json({ value: [EVENT] });
  } };
}

function callbackRequest(redirect) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port: Number(redirect.port),
      path: `${redirect.pathname}${redirect.search}`, headers: { Host: redirect.host } }, response => {
      response.resume(); response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
  });
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sg-graph-service-"));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "user"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  fs.mkdirSync(paths.pluginsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(paths.pluginsDir, "outlook-calendar-graph.json"),
    JSON.stringify({ version: 1, clientId: CLIENT_ID }), { mode: 0o600 });
  const substitute = graphSubstitute();
  const options = { paths, safeStorage: safeStorage(crypto.randomBytes(32)), parentEnv: {},
    prewarmMcpAuth: false, version: "graph-service-fixture",
    outlookCalendarGraphFetch: substitute.fetch };
  let service = createAgentService(options), web;
  const nativeUrls = [], confirmations = [];
  try {
    await service.start();
    const backend = new ShoggothBackend({ paths });
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    assert(profile);
    backend._profilesByAgent.set(profile.agentId, profile);
    const forged = materializeOutlookGraphSidecar(path.join(root, "untrusted-graph"),
      crypto.createHash("sha256").update("untrusted").digest("hex"));
    const untrusted = await backend.previewPluginInstall({ kind: "directory", path: forged });
    assert.equal(untrusted.components.mcpServers.length, 0,
      "a local package cannot claim the private Graph transport");
    assert(untrusted.diagnostics.some(item => item.scope === "mcp-server"
      && item.name === "shoggoth-outlook-calendar-read"));
    web = await startStaticServer(0, { homeDir: root, userDataRoot: root,
      registry: { route: id => backend._profilesByAgent.has(id) ? backend : null,
        backends: new Map([["shoggoth", backend]]) },
      hostOps: { async confirmPluginCapability(summary) {
        confirmations.push(summary);
        return true;
      }, async openExternal(url) { nativeUrls.push(url); } } });
    const get = async route => {
      const response = await fetch(`${web.url}/__api/plugins/${route}`);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    };
    const post = async (route, input, origin = web.url) => {
      const response = await fetch(`${web.url}/__api/plugins/${route}`, { method: "POST",
        headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(input) });
      const text = await response.text();
      let body; try { body = JSON.parse(text); } catch { body = { error: text }; }
      return { status: response.status, body };
    };
    const checked = async (route, input) => {
      const result = await post(route, input);
      assert.equal(result.status, 200, `${route}: ${JSON.stringify(result.body)}`);
      return result.body;
    };
    const list = await get("bundled");
    const card = list.items.find(item => item.id === "outlook-calendar");
    assert.equal(card.localAdapter, "shoggoth-graph-read-only");
    assert.equal(card.importStatus, "needs-adapter");
    assert.equal(card.components.mcp, 0, "frozen Codex package stays unchanged");
    const detail = await get("bundled/outlook-calendar");
    assert.equal(detail.detail.localAdapter, "shoggoth-graph-read-only");
    const preview = await checked("bundled-preview", { packageId: "outlook-calendar" });
    assert.equal(preview.preview.installable, true);
    assert.equal(preview.preview.components.mcpServers[0].type, "shoggoth-graph");
    await assert.rejects(async () => service.pluginServiceController.handle("plugins.oauth.prepare", null),
      { code: "PLUGIN_REQUEST_INVALID" });
    assert.equal(service.pluginGraphConnectionController.matches(null), false);
    assert.equal(service.pluginGraphConnectionController.matches({ installationId: "missing",
      componentId: "0".repeat(64) }), false);
    assert(preview.selectionHandle);
    const installed = await checked("install", { selectionHandle: preview.selectionHandle,
      previewDigest: preview.preview.previewDigest, expectedRevision: preview.preview.expectedRevision,
      operationId: "graph-install" });
    assert.equal(installed.installation.sourceKind, "bundled");
    const installationId = installed.installation.installationId;
    const enabled = await checked("state", { installationId, desiredState: "enabled",
      expectedRevision: installed.installation.revision, operationId: "graph-enable" });
    const page = await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 10,
      catalogRevision: null });
    const component = page.items.find(item => item.installationId === installationId)
      ?.components.find(item => item.localName === "shoggoth-outlook-calendar-read");
    assert(component);
    const oauth = { agentId: profile.agentId, installationId, componentId: component.componentId,
      expectedRevision: enabled.installation.revision, operationId: "graph-oauth" };
    assert.equal((await post("oauth-connect", oauth, "https://evil.example")).status, 403);
    assert.equal(nativeUrls.length, 0);
    const started = await checked("oauth-connect", oauth);
    assert.equal(started.flow.status, "pending");
    assert.equal(nativeUrls.length, 1);
    assert.equal(JSON.stringify(started).includes("authorizationUrl"), false);
    assert.equal(confirmations.at(-1).provider, "Microsoft Graph");
    const authorize = new URL(nativeUrls[0]);
    assert.equal(authorize.origin, "https://login.microsoftonline.com");
    substitute.state.challenge = authorize.searchParams.get("code_challenge");
    const callback = new URL(authorize.searchParams.get("redirect_uri"));
    callback.search = new URLSearchParams({ code: "local-auth-code",
      state: authorize.searchParams.get("state") }).toString();
    assert.equal(await callbackRequest(callback), 200);
    const ready = await checked("oauth-status", { agentId: profile.agentId,
      flowId: started.flow.flowId });
    assert.equal(ready.status, "ready");
    const binding = service.pluginStore.getBinding(ready.bindingId);
    assert.equal(binding.subjectKind, "global");
    assert.equal(service.pluginStore.getConnection(binding.connectionId).state, "ready");
    assert.equal(service.pluginStore.getGrantCountsForBinding(binding.bindingId).allow, 0);
    assert.equal(fs.readFileSync(paths.encryptedSecretsPath, "utf8").includes("local-access-secret"), false);
    await checked("mcp-discover", { agentId: profile.agentId, bindingId: binding.bindingId });
    const catalog = await get(`mcp-tools?agentId=${encodeURIComponent(profile.agentId)}&bindingId=${binding.bindingId}`);
    assert.deepEqual(catalog.items.map(item => item.name), ["outlook_calendar_view"]);
    const tool = catalog.items[0];
    await checked("mcp-consent", { action: "allow", agentId: profile.agentId,
      bindingId: binding.bindingId, toolIdentity: tool.toolIdentity,
      contractDigest: tool.contractDigest, catalogRevision: catalog.catalogRevision,
      approvalMode: "always", expectedRevision: 0, operationId: "graph-allow" });
    assert.equal(service.pluginStore.getGrantCountsForBinding(binding.bindingId).allow, 1);
    const call = async (activeService, profileId = profile.id) => {
      const id = crypto.randomUUID();
      activeService.workDispatcher.enqueue({ id, source: "chat", sourceId: `graph-${id}`,
        idempotencyKey: `graph-${id}`, profileId: profile.id, workspace: root });
      const admitted = activeService.workDispatcher.admit(id, { writable: false });
      assert.equal(admitted.disposition, "started");
      activeService.pluginRuntimeToolService.captureRun(admitted.run);
      activeService.workDispatcher.transition(id, "running");
      return activeService.pluginRuntimeToolService.callTool({
        serverId: pluginServerId(binding.bindingId), toolName: "outlook_calendar_view", arguments: RANGE,
      }, { profileId, callId: crypto.randomUUID() }, { runId: id, assertCurrent() {
        assert.equal(activeService.workDispatcher.getRun(id).status, "running");
      } });
    };
    const initial = await call(service);
    assert.deepEqual(initial.result.structuredContent.events.map(item => item.id), ["meeting-1"]);
    assert.equal(JSON.stringify(initial).includes("private body"), false);
    assert.equal(substitute.state.graphCalls, 1);
    await assert.rejects(call(service, "foreign-profile"));
    assert.equal(substitute.state.graphCalls, 1, "foreign run cannot reach Graph");

    await service.stop();
    service = createAgentService(options);
    await service.start();
    assert.equal(substitute.state.graphCalls, 1, "startup restore performs no Graph egress");
    const resumed = await call(service);
    assert.equal(resumed.result.structuredContent.events.length, 1);
    assert.equal(substitute.state.graphCalls, 2, "current Connection and Grant permit reactivation");
    const grant = service.pluginStore.getGrant(binding.bindingId, tool.toolIdentity);
    await checked("mcp-grants/revoke", { agentId: profile.agentId, bindingId: binding.bindingId,
      toolIdentity: tool.toolIdentity, expectedRevision: grant.revision,
      operationId: "graph-revoke" });
    await assert.rejects(call(service));
    assert.equal(substitute.state.graphCalls, 2, "revocation fences Graph egress");
    await service.stop();
    service = createAgentService(options);
    await service.start();
    await assert.rejects(service.outlookCalendarGraph.calendarViewForPrincipal({
      principalIdentity: service.pluginStore.getConnection(binding.connectionId).principalIdentity,
      ...RANGE, assertCurrent() {} }), { code: "OUTLOOK_CALENDAR_AUTH_REQUIRED" });
    await assert.rejects(call(service));
    assert.equal(substitute.state.graphCalls, 2, "revoked Grant remains closed after restart");
    assert.equal(substitute.state.tokenCalls, 1);
    const principalIdentity = service.pluginStore.getConnection(binding.connectionId).principalIdentity;
    assert.equal(service.outlookCalendarGraph.hasStoredAccount(), true);
    await service.outlookCalendarGraph.activatePluginAccount({ principalIdentity,
      assertCurrent() {
        assert.equal(service.pluginStore.getConnection(binding.connectionId).state, "ready");
      } });
    const currentBinding = service.pluginStore.getBinding(binding.bindingId);
    const disconnected = await checked("disconnect", { agentId: profile.agentId,
      bindingId: binding.bindingId, expectedRevision: currentBinding.revision,
      operationId: "graph-disconnect" });
    assert.equal(confirmations.at(-1).credentialDisposition, "retained_encrypted_shared");
    assert.equal(disconnected.receipt.credentialDisposition, "retained_encrypted_shared");
    assert.equal(disconnected.receipt.cleanupStatus, "complete");
    assert.equal(service.pluginStore.getConnection(binding.connectionId).state, "disconnected");
    assert.equal(service.outlookCalendarGraph.hasStoredAccount(), true,
      "disconnect retains the independent shared encrypted account");
    await assert.rejects(service.outlookCalendarGraph.calendarViewForPrincipal({
      principalIdentity, ...RANGE, assertCurrent() {} }),
    { code: "OUTLOOK_CALENDAR_AUTH_REQUIRED" });
    await assert.rejects(call(service));
    assert.equal(substitute.state.graphCalls, 2, "disconnected plugin never reaches Graph");
    await service.stop();
    service = createAgentService(options);
    await service.start();
    assert.equal(service.outlookCalendarGraph.hasStoredAccount(), true);
    await assert.rejects(call(service));
    assert.equal(substitute.state.graphCalls, 2, "retained account stays dormant after restart");
    await service.stop();
    fs.writeFileSync(path.join(paths.pluginsDir, "outlook-calendar-graph.json"),
      '{"version":1,"clientId":"invalid"}', { mode: 0o600 });
    service = createAgentService(options);
    await service.start();
    assert.equal(service.outlookCalendarGraph.config, null,
      "bad optional Graph config is isolated without preventing Service startup");
    await assert.rejects(call(service));
    assert.equal(substitute.state.graphCalls, 2);
    console.log("ok - frozen Outlook card installs independent Graph sidecar via browser REST and Service OAuth");
    console.log("ok - native Run uses current shared Grant; foreign run and revoke cause zero Graph egress");
    console.log("ok - restart requires current Store authority; ciphertext and revoked Grant cannot self-activate");
  } finally {
    if (web) await web.close();
    await service.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
