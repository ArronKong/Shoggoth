"use strict";

// Frozen Codex managed-only cards acquire independent Shoggoth Graph sidecars.
// Drive browser REST -> Service OAuth -> global Binding/Grant -> native Run with
// a local Microsoft substitute. This is not a real-provider acceptance test.
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
const { CAPABILITIES, SHAREPOINT_ITEMS_TOOL, SHAREPOINT_ITEM_FIELDS_TOOL } =
  require("../app/agent-service/plugin-microsoft-graph-capabilities");
const { componentFor, materializeGraphSidecar } =
  require("../app/agent-service/plugin-microsoft-graph-sidecar");

const CLIENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SITE_ID = "contoso.sharepoint.com,11111111-2222-4333-8444-555555555555,aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const LIST_ID = "b5dabb84-f89f-4317-a884-99b3d2067c2c";
const ITEM_INPUT = Object.freeze({ siteId: SITE_ID, listId: LIST_ID });
const FIELD_INPUT = Object.freeze({ ...ITEM_INPUT, itemId: "item-1",
  fieldNames: ["Title", "Quantity"] });
const INPUTS = Object.freeze({ "outlook-email": {}, sharepoint: { siteId: SITE_ID }, teams: {} });
const PACKAGE_IDS = Object.freeze(Object.keys(CAPABILITIES));
const json = value => new Response(JSON.stringify(value), { status: 200,
  headers: { "Content-Type": "application/json" } });

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
  const state = { challenge: null, accountId: "account-a",
    graphCalls: 0, tokenCalls: 0, requests: [] };
  return { state, async fetch(input, init = {}) {
    const url = new URL(input);
    state.requests.push({ method: init.method || "GET", url: url.href });
    if (url.origin === "https://login.microsoftonline.com") {
      assert.equal(url.pathname, "/common/oauth2/v2.0/token");
      const form = new URLSearchParams(init.body);
      assert.equal(form.get("client_id"), CLIENT_ID);
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(crypto.createHash("sha256").update(form.get("code_verifier"))
        .digest("base64url"), state.challenge);
      state.tokenCalls += 1;
      return json({ access_token: "local-access-secret", refresh_token: "local-refresh-secret",
        token_type: "Bearer", expires_in: 3600,
        scope: form.get("scope").split(" ").filter(scope => scope !== "offline_access").join(" ") });
    }
    assert.equal(url.origin, "https://graph.microsoft.com");
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, "Bearer local-access-secret");
    if (url.pathname === "/v1.0/me") return json({ id: state.accountId });
    state.graphCalls += 1;
    if (url.pathname === "/v1.0/me/messages") {
      assert.equal(url.searchParams.get("$top"), "20");
      return json({ value: [{ id: "mail-1", subject: "Fixture mail",
        sender: { emailAddress: { name: "Alice", address: "alice@example.test" } },
        body: { content: "private mail body" } }] });
    }
    if (url.pathname === `/v1.0/sites/${SITE_ID}/lists`) {
      return json({ value: [{ id: LIST_ID, name: "Documents",
        list: { template: "documentLibrary" }, columns: ["private column"] }] });
    }
    if (url.pathname === `/v1.0/sites/${SITE_ID}/lists/${LIST_ID}/items`) {
      return json({ value: [{ id: "item-1", name: "Document A",
        lastModifiedDateTime: "2026-09-27T01:00:00Z", fields: { Secret: "private field" } }],
      "@odata.nextLink": "https://evil.example/next" });
    }
    if (url.pathname === `/v1.0/sites/${SITE_ID}/lists/${LIST_ID}/items/item-1`) {
      assert.equal(url.searchParams.get("expand"), "fields(select=Title,Quantity)");
      assert.equal(url.searchParams.size, 1);
      return json({ id: "item-1", fields: { Title: "Document A", Quantity: 7,
        Secret: "private field" }, driveItem: { content: "private file" } });
    }
    if (url.pathname === "/v1.0/me/chats") {
      assert.equal(url.searchParams.get("$top"), "20");
      return json({ value: [{ id: "chat-1", topic: "Project",
        messages: ["private chat message"] }] });
    }
    throw new Error(`Unexpected Graph path: ${url.pathname}`);
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
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sg-graph-family-service-"));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "user"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  fs.mkdirSync(paths.pluginsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(paths.pluginsDir, "outlook-calendar-graph.json"),
    JSON.stringify({ version: 1, clientId: CLIENT_ID }), { mode: 0o600 });
  const substitute = graphSubstitute();
  const options = { paths, safeStorage: safeStorage(crypto.randomBytes(32)), parentEnv: {},
    prewarmMcpAuth: false, version: "graph-family-service-fixture",
    outlookCalendarGraphFetch: substitute.fetch };
  let service = createAgentService(options), web;
  const nativeUrls = [], confirmations = [];
  try {
    await service.start();
    const backend = new ShoggothBackend({ paths });
    const profile = service.productStore.listAgentProfiles().find(item => item.enabled);
    assert(profile);
    backend._profilesByAgent.set(profile.agentId, profile);
    const forged = materializeGraphSidecar(path.join(root, "untrusted-graph"), "teams",
      crypto.createHash("sha256").update("untrusted").digest("hex"));
    const untrusted = await backend.previewPluginInstall({ kind: "directory", path: forged });
    assert.equal(untrusted.components.mcpServers.length, 0,
      "a local package cannot claim the private Graph transport");
    web = await startStaticServer(0, { homeDir: root, userDataRoot: root,
      registry: { route: id => backend._profilesByAgent.has(id) ? backend : null,
        backends: new Map([["shoggoth", backend]]) },
      hostOps: { async confirmPluginCapability(summary) {
        confirmations.push(summary); return true;
      }, async openExternal(url) { nativeUrls.push(url); } } });
    const get = async route => {
      const response = await fetch(`${web.url}/__api/plugins/${route}`);
      const body = await response.json();
      assert.equal(response.status, 200, `${route}: ${JSON.stringify(body)}`);
      return body;
    };
    const post = async (route, input) => {
      const response = await fetch(`${web.url}/__api/plugins/${route}`, { method: "POST",
        headers: { origin: web.url, "Content-Type": "application/json" }, body: JSON.stringify(input) });
      const raw = await response.text();
      let body; try { body = JSON.parse(raw); } catch { body = { error: raw }; }
      assert.equal(response.status, 200, `${route}: ${JSON.stringify(body)}`);
      return body;
    };
    const bundled = await get("bundled");
    const family = {};
    for (const packageId of PACKAGE_IDS) {
      const card = bundled.items.find(item => item.id === packageId);
      assert(card, `missing frozen ${packageId} card`);
      assert.equal(card.localAdapter, "shoggoth-graph-read-only");
      assert.equal(card.importStatus, "needs-adapter");
      assert.equal(card.components.mcp, 0);
      const detail = await get(`bundled/${packageId}`);
      assert.equal(detail.detail.localAdapter, "shoggoth-graph-read-only");
      const preview = await post("bundled-preview", { packageId });
      assert.equal(preview.preview.installable, true);
      assert.equal(preview.preview.components.mcpServers[0].type, "shoggoth-graph");
      assert(preview.selectionHandle);
      const installed = await post("install", { selectionHandle: preview.selectionHandle,
        previewDigest: preview.preview.previewDigest,
        expectedRevision: preview.preview.expectedRevision,
        operationId: `graph-${packageId}-install` });
      assert.equal(installed.installation.sourceKind, "bundled");
      const installationId = installed.installation.installationId;
      const enabled = await post("state", { installationId, desiredState: "enabled",
        expectedRevision: installed.installation.revision,
        operationId: `graph-${packageId}-enable` });
      const page = await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 10,
        catalogRevision: null });
      const component = page.items.find(item => item.installationId === installationId)
        ?.components.find(item => item.localName === componentFor(packageId));
      assert(component, `missing independent ${packageId} component`);
      family[packageId] = { installationId, revision: enabled.installation.revision,
        componentId: component.componentId };
    }

    for (const packageId of PACKAGE_IDS) {
      const entry = family[packageId];
      const oauth = { agentId: profile.agentId, installationId: entry.installationId,
        componentId: entry.componentId, expectedRevision: entry.revision,
        operationId: `graph-${packageId}-oauth` };
      const started = await post("oauth-connect", oauth);
      assert.equal(started.flow.status, "pending");
      assert.equal(JSON.stringify(started).includes("authorizationUrl"), false);
      const authorization = new URL(nativeUrls.at(-1));
      assert.equal(authorization.origin, "https://login.microsoftonline.com");
      const scopes = authorization.searchParams.get("scope").split(" ");
      assert.ok(scopes.includes(CAPABILITIES[packageId].scope));
      assert.deepEqual(confirmations.at(-1).scopes, scopes,
        "Shoggoth confirmation must disclose every requested Graph scope");
      substitute.state.challenge = authorization.searchParams.get("code_challenge");
      const callback = new URL(authorization.searchParams.get("redirect_uri"));
      callback.search = new URLSearchParams({ code: "local-auth-code",
        state: authorization.searchParams.get("state") }).toString();
      assert.equal(await callbackRequest(callback), 200);
      const ready = await post("oauth-status", { agentId: profile.agentId,
        flowId: started.flow.flowId });
      assert.equal(ready.status, "ready");
      const binding = service.pluginStore.getBinding(ready.bindingId);
      assert.equal(binding.subjectKind, "global");
      assert.equal(service.pluginStore.getConnection(binding.connectionId).state, "ready");
      entry.bindingId = binding.bindingId;
      await post("mcp-discover", { agentId: profile.agentId, bindingId: binding.bindingId });
      const catalog = await get(`mcp-tools?agentId=${encodeURIComponent(profile.agentId)}&bindingId=${binding.bindingId}`);
      assert.deepEqual(catalog.items.map(item => item.name).sort(), packageId === "sharepoint"
        ? [CAPABILITIES[packageId].toolName, SHAREPOINT_ITEMS_TOOL,
          SHAREPOINT_ITEM_FIELDS_TOOL].sort()
        : [CAPABILITIES[packageId].toolName]);
      const tool = catalog.items.find(item => item.name === CAPABILITIES[packageId].toolName);
      entry.tool = tool;
      await post("mcp-consent", { action: "allow", agentId: profile.agentId,
        bindingId: binding.bindingId, toolIdentity: tool.toolIdentity,
        contractDigest: tool.contractDigest, catalogRevision: catalog.catalogRevision,
        approvalMode: "always", expectedRevision: 0,
        operationId: `graph-${packageId}-allow` });
      if (packageId === "sharepoint") {
        const itemTool = catalog.items.find(item => item.name === SHAREPOINT_ITEMS_TOOL);
        const fieldTool = catalog.items.find(item => item.name === SHAREPOINT_ITEM_FIELDS_TOOL);
        assert.notEqual(itemTool.toolIdentity, tool.toolIdentity);
        assert.notEqual(fieldTool.toolIdentity, itemTool.toolIdentity);
        entry.itemTool = itemTool;
        entry.fieldTool = fieldTool;
        entry.fieldCatalogRevision = catalog.catalogRevision;
        await post("mcp-consent", { action: "allow", agentId: profile.agentId,
          bindingId: binding.bindingId, toolIdentity: itemTool.toolIdentity,
          contractDigest: itemTool.contractDigest, catalogRevision: catalog.catalogRevision,
          approvalMode: "always", expectedRevision: 0,
          operationId: "graph-sharepoint-items-allow" });
      }
    }
    const encrypted = fs.readFileSync(paths.encryptedSecretsPath, "utf8");
    assert.equal(encrypted.includes("local-access-secret"), false);
    assert.equal(encrypted.includes("local-refresh-secret"), false);

    const call = async (activeService, packageId, profileId = profile.id,
      toolName = CAPABILITIES[packageId].toolName, args = INPUTS[packageId]) => {
      const entry = family[packageId];
      const id = crypto.randomUUID();
      activeService.workDispatcher.enqueue({ id, source: "chat", sourceId: `graph-${id}`,
        idempotencyKey: `graph-${id}`, profileId: profile.id, workspace: root });
      const admitted = activeService.workDispatcher.admit(id, { writable: false });
      assert.equal(admitted.disposition, "started");
      activeService.pluginRuntimeToolService.captureRun(admitted.run);
      activeService.workDispatcher.transition(id, "running");
      try {
        return await activeService.pluginRuntimeToolService.callTool({
          serverId: pluginServerId(entry.bindingId), toolName, arguments: args,
        }, { profileId, callId: crypto.randomUUID() }, { runId: id, assertCurrent() {
          assert.equal(activeService.workDispatcher.getRun(id).status, "running");
        } });
      } finally {
        activeService.pluginRuntimeToolService.releaseRun(id);
        if (activeService.workDispatcher.getRun(id)?.status === "running") {
          activeService.workDispatcher.transition(id, "completed");
        }
      }
    };
    let listIdFromRead = null;
    for (const packageId of PACKAGE_IDS) {
      const result = await call(service, packageId);
      assert.equal(result.result.structuredContent.items.length, 1);
      assert.equal(JSON.stringify(result).includes("private"), false);
      if (packageId === "sharepoint") listIdFromRead = result.result.structuredContent.items[0].id;
    }
    assert.equal(listIdFromRead, LIST_ID);
    const items = await call(service, "sharepoint", profile.id, SHAREPOINT_ITEMS_TOOL,
      { siteId: SITE_ID, listId: listIdFromRead });
    assert.deepEqual(items.result.structuredContent.items.map(item => item.name), ["Document A"]);
    assert.equal(items.result.structuredContent.truncated, true);
    assert.equal(JSON.stringify(items).includes("private"), false,
      "list item columns are not included in the independent metadata reader");
    const beforeFieldGrant = substitute.state.graphCalls;
    await assert.rejects(call(service, "sharepoint", profile.id,
      SHAREPOINT_ITEM_FIELDS_TOOL, FIELD_INPUT));
    assert.equal(substitute.state.graphCalls, beforeFieldGrant,
      "item metadata Grant cannot authorize column value reads");
    const sharepoint = family.sharepoint;
    await post("mcp-consent", { action: "allow", agentId: profile.agentId,
      bindingId: sharepoint.bindingId, toolIdentity: sharepoint.fieldTool.toolIdentity,
      contractDigest: sharepoint.fieldTool.contractDigest,
      catalogRevision: sharepoint.fieldCatalogRevision, approvalMode: "always",
      expectedRevision: 0, operationId: "graph-sharepoint-fields-allow" });
    const fields = await call(service, "sharepoint", profile.id,
      SHAREPOINT_ITEM_FIELDS_TOOL, FIELD_INPUT);
    assert.deepEqual(fields.result.structuredContent,
      { id: "item-1", fields: { Title: "Document A", Quantity: 7 } });
    assert.equal(JSON.stringify(fields).includes("private"), false,
      "only the requested scalar columns may leave the Graph broker");
    const beforeBadFieldInput = substitute.state.graphCalls;
    await assert.rejects(call(service, "sharepoint", profile.id,
      SHAREPOINT_ITEM_FIELDS_TOOL, { ...FIELD_INPUT, fieldNames: ["Title)" ] }));
    assert.equal(substitute.state.graphCalls, beforeBadFieldInput);
    assert.equal(substitute.state.requests.some(request =>
      request.url.startsWith("https://evil.example")), false,
    "the independent item reader must never follow a remote nextLink");
    const initialGraphCalls = PACKAGE_IDS.length + 2;
    assert.equal(substitute.state.graphCalls, initialGraphCalls);
    await assert.rejects(call(service, "outlook-email", "foreign-profile"));
    assert.equal(substitute.state.graphCalls, initialGraphCalls);

    await service.stop();
    service = createAgentService(options);
    await service.start();
    assert.equal(substitute.state.graphCalls, initialGraphCalls,
      "startup must never cause Graph data egress");
    for (const packageId of PACKAGE_IDS) {
      assert.equal((await call(service, packageId)).result.structuredContent.items.length, 1);
    }
    assert.equal((await call(service, "sharepoint", profile.id,
      SHAREPOINT_ITEMS_TOOL, ITEM_INPUT)).result.structuredContent.items.length, 1);
    assert.deepEqual((await call(service, "sharepoint", profile.id,
      SHAREPOINT_ITEM_FIELDS_TOOL, FIELD_INPUT)).result.structuredContent.fields,
    { Title: "Document A", Quantity: 7 });
    assert.equal(substitute.state.graphCalls, initialGraphCalls * 2,
      "current per-card Store authority can reactivate after restart");

    const email = family["outlook-email"];
    const grant = service.pluginStore.getGrant(email.bindingId, email.tool.toolIdentity);
    await post("mcp-grants/revoke", { agentId: profile.agentId,
      bindingId: email.bindingId, toolIdentity: email.tool.toolIdentity,
      expectedRevision: grant.revision, operationId: "graph-email-revoke" });
    await assert.rejects(call(service, "outlook-email"));
    assert.equal(substitute.state.graphCalls, initialGraphCalls * 2,
      "revoked Email Grant must send zero Graph requests");
    assert.equal((await call(service, "teams")).result.structuredContent.items.length, 1,
      "Email revoke must not remove an independently granted Teams card");
    const fieldGrant = service.pluginStore.getGrant(sharepoint.bindingId,
      sharepoint.fieldTool.toolIdentity);
    await post("mcp-grants/revoke", { agentId: profile.agentId,
      bindingId: sharepoint.bindingId, toolIdentity: sharepoint.fieldTool.toolIdentity,
      expectedRevision: fieldGrant.revision, operationId: "graph-sharepoint-fields-revoke" });
    const beforeFieldRevoke = substitute.state.graphCalls;
    await assert.rejects(call(service, "sharepoint", profile.id,
      SHAREPOINT_ITEM_FIELDS_TOOL, FIELD_INPUT));
    assert.equal(substitute.state.graphCalls, beforeFieldRevoke,
      "field Grant revocation must stop egress while the metadata Grant remains valid");
    assert.equal((await call(service, "sharepoint", profile.id,
      SHAREPOINT_ITEMS_TOOL, ITEM_INPUT)).result.structuredContent.items.length, 1);
    const itemGrant = service.pluginStore.getGrant(sharepoint.bindingId,
      sharepoint.itemTool.toolIdentity);
    await post("mcp-grants/revoke", { agentId: profile.agentId,
      bindingId: sharepoint.bindingId, toolIdentity: sharepoint.itemTool.toolIdentity,
      expectedRevision: itemGrant.revision, operationId: "graph-sharepoint-items-revoke" });
    const beforeItemRevoke = substitute.state.graphCalls;
    await assert.rejects(call(service, "sharepoint", profile.id,
      SHAREPOINT_ITEMS_TOOL, ITEM_INPUT));
    assert.equal(substitute.state.graphCalls, beforeItemRevoke,
      "item metadata Grant must be independent and revoked before Graph egress");
    assert.equal((await call(service, "sharepoint")).result.structuredContent.items.length, 1,
      "list metadata Grant must survive separate item-tool revocation");
    await post("mcp-discover", { agentId: profile.agentId, bindingId: sharepoint.bindingId });
    const sharepointCatalog = await get(`mcp-tools?agentId=${encodeURIComponent(profile.agentId)}&bindingId=${sharepoint.bindingId}`);
    const currentItemTool = sharepointCatalog.items.find(item => item.name === SHAREPOINT_ITEMS_TOOL);
    const deniedItemGrant = service.pluginStore.getGrant(sharepoint.bindingId,
      currentItemTool.toolIdentity);
    await post("mcp-consent", { action: "allow", agentId: profile.agentId,
      bindingId: sharepoint.bindingId, toolIdentity: currentItemTool.toolIdentity,
      contractDigest: currentItemTool.contractDigest,
      catalogRevision: sharepointCatalog.catalogRevision, approvalMode: "always",
      expectedRevision: deniedItemGrant.revision,
      operationId: "graph-sharepoint-items-reallow" });
    assert.equal((await call(service, "sharepoint", profile.id,
      SHAREPOINT_ITEMS_TOOL, ITEM_INPUT)).result.structuredContent.items.length, 1,
    "a fresh item Grant explicitly restores this one read tool");
    const countAfterOtherCard = substitute.state.graphCalls;
    await service.stop();
    service = createAgentService(options);
    await service.start();
    await assert.rejects(call(service, "outlook-email"));
    assert.equal((await call(service, "sharepoint", profile.id,
      SHAREPOINT_ITEMS_TOOL, ITEM_INPUT)).result.structuredContent.items.length, 1);
    const countBeforeAccountSwitch = substitute.state.graphCalls;
    assert.equal(countBeforeAccountSwitch, countAfterOtherCard + 1,
      "revoked Email Grant stays closed while a separately granted item read survives restart");

    // Switching the shared Microsoft identity must make every old card's
    // Connection/Binding visibly inactive. The newly connected card still
    // requires a fresh tool Grant for the new account.
    substitute.state.accountId = "account-b";
    const teams = family.teams;
    const switched = await post("oauth-connect", { agentId: profile.agentId,
      installationId: teams.installationId, componentId: teams.componentId,
      expectedRevision: teams.revision, operationId: "graph-teams-switch-account" });
    const authorization = new URL(nativeUrls.at(-1));
    assert.deepEqual(confirmations.at(-1).scopes,
      authorization.searchParams.get("scope").split(" "));
    substitute.state.challenge = authorization.searchParams.get("code_challenge");
    const callback = new URL(authorization.searchParams.get("redirect_uri"));
    callback.search = new URLSearchParams({ code: "local-switch-code",
      state: authorization.searchParams.get("state") }).toString();
    assert.equal(await callbackRequest(callback), 200);
    const switchReceipt = await post("oauth-status", { agentId: profile.agentId,
      flowId: switched.flow.flowId });
    assert.equal(switchReceipt.status, "ready");
    for (const packageId of PACKAGE_IDS) {
      const oldConnection = service.pluginStore.getConnection(
        service.pluginStore.getBinding(family[packageId].bindingId).connectionId);
      if (packageId === "teams") {
        assert.equal(oldConnection.state, "ready");
        assert.equal(service.pluginStore.getGrantCountsForBinding(teams.bindingId).allow, 0);
      } else {
        assert.equal(oldConnection.state, "disconnected");
        assert.equal(service.pluginStore.getBinding(family[packageId].bindingId).enabled, false);
      }
      await assert.rejects(call(service, packageId));
    }
    await assert.rejects(call(service, "sharepoint", profile.id,
      SHAREPOINT_ITEMS_TOOL, ITEM_INPUT));
    assert.equal(substitute.state.graphCalls, countBeforeAccountSwitch,
      "account switch revokes old grants before any further Graph egress");

    // Simulate a crash between durable OAuth-account replacement and the
    // plugin Store's onReady transaction. Startup reconciliation must demote
    // a stale ready Connection before restoring the tool catalog.
    const accountRef = "microsoft-graph-calendar-shared-v1";
    const accountRevision = service.secretStore.getCredentialRevision(accountRef);
    const accountRecord = JSON.parse(await service.secretStore.get(accountRef));
    accountRecord.principalHash = "f".repeat(64);
    await service.secretStore.putIfRevision(accountRef, JSON.stringify(accountRecord),
      { kind: "microsoft-graph-oauth" }, accountRevision);
    await service.stop();
    service = createAgentService(options);
    await service.start();
    const staleTeamsBinding = service.pluginStore.getBinding(teams.bindingId);
    assert.equal(staleTeamsBinding.enabled, false);
    assert.equal(service.pluginStore.getConnection(staleTeamsBinding.connectionId).state,
      "disconnected");
    assert.equal(substitute.state.graphCalls, countBeforeAccountSwitch,
      "startup demotes stale Graph authority without data egress");
    console.log("plugin-microsoft-graph-family-service-fixture: ok (3 cards REST install, shared account, native Run, restart/revoke/account-switch/crash)");
  } finally {
    if (web) await web.close();
    await service.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
