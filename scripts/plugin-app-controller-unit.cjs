"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { componentId } = require("../app/agent-service/plugin-component-catalog");
const { PluginToolCatalogRegistry } = require("../app/agent-service/plugin-tool-catalog-registry");
const { CapabilityDispatcher } = require("../app/agent-service/capability-dispatcher");
const { PermissionEngine } = require("../app/agent-service/permission-engine");
const { PluginAppController } = require("../app/agent-service/plugin-app-controller");
const { MCP_APP_PROTOCOL_VERSION } = require("../app/agent-service/plugin-app-session");

const TOOL = { name: "dashboard", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: "ui://fixture/dashboard" } } };
const TOOLS = [TOOL, ...["refresh", "each-call", "later"].map(name => ({ name, inputSchema: { type: "object" } }))];
const HTML = `<!doctype html><html><body>${"汉\\\u0001".repeat(12000)}</body></html>`;
const rpc = (id, method, params = {}) => ({ jsonrpc: "2.0", id, method, params });
const code = value => value.error?.data?.code;

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-app-controller-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), trustedRoot: root });
  const store = new PluginStore({ paths }).open();
  let controller;
  const fixture = { resourceReads: 0, sent: 0, releases: 0, readWait: null, callWait: null };
  try {
    const installer = new PluginPackageInstaller({ store });
    const sourcePath = path.join(__dirname, "fixtures/plugins/project-assistant");
    const preview = installer.preview(sourcePath);
    let installation = installer.install({ sourcePath, previewDigest: preview.contentDigest,
      operationId: "app-install", expectedRevision: 0 });
    installation = store.setInstallationDesiredState({ installationId: installation.installationId,
      desiredState: "enabled", expectedRevision: installation.revision });
    let connection = store.createConnection({ connectionId: "app-connection", installationId: installation.installationId,
      componentId: componentId(installation.installationId, "mcp-server", "local-issues"), endpointIdentity: "fixture://app" });
    connection = store.setConnectionIdentity({ connectionId: connection.connectionId, principalIdentity: "private-account",
      state: "ready", expectedRevision: connection.revision });
    let binding = store.createBinding({ bindingId: "app-binding", profileId: "profile-a", installationId: installation.installationId,
      componentId: connection.componentId, connectionId: connection.connectionId });
    binding = store.setBindingEnabled({ bindingId: binding.bindingId, enabled: true, expectedRevision: binding.revision });
    const catalog = new PluginToolCatalogRegistry();
    const snapshot = await catalog.refresh({ installation, connection, client: { listTools: async () => TOOLS } });
    const entries = new Map(snapshot.entries.map(entry => [entry.downstreamName, entry]));
    const grant = (name, approvalMode = "always") => {
      const entry = entries.get(name);
      const previous = store.getGrant(binding.bindingId, entry.toolIdentity);
      return store.setGrant({ grantId: `grant-${name}`, bindingId: binding.bindingId,
        toolIdentity: entry.toolIdentity, contractDigest: entry.contractDigest,
        effect: "allow", approvalMode, expectedRevision: previous?.revision || 0 });
    };
    grant("dashboard"); grant("refresh"); grant("each-call", "each-call");
    const originating = entries.get("dashboard");
    const originalArguments = { filter: { status: "open" } };
    const originalResult = { content: [{ type: "text", text: "trusted initial result" }],
      structuredContent: { count: 2 } };
    const initialArguments = structuredClone(originalArguments);
    const initialResult = structuredClone(originalResult);
    store.beginCapabilityCall({ callId: "original-call", runRef: "original-run", bindingId: binding.bindingId,
      connectionId: connection.connectionId, principalIdentity: connection.principalIdentity,
      toolIdentity: originating.toolIdentity, contractDigest: originating.contractDigest,
      argumentDigest: crypto.createHash("sha256").update(JSON.stringify(originalArguments)).digest("hex") });
    store.markCapabilityCallSendStarted("original-call");
    store.finishCapabilityCall("original-call", { resultConfirmed: true });
    let profile = { id: "profile-a", name: "Fixture Agent", enabled: true };
    const run = { id: "original-run", profileId: profile.id, status: "completed", workspace: root };
    let conversation = { id: "conversation-a", profileId: profile.id };
    const productStore = { getAgentProfile: id => id === profile.id ? profile : null };
    const toolRegistry = { revision: "fixture-tools", get: () => ({ tool: "mcp_server_call", enabled: true, risk: "write" }), list: () => [] };
    const permissionEngine = new PermissionEngine({ toolRegistry });
    const dispatcher = new CapabilityDispatcher({ store, permissionEngine,
      resolveToolContract: input => catalog.resolve(input) });
    const manager = { async acquire() {
      return { async readAppResource(input) {
        input.assertCurrent(); fixture.resourceReads += 1;
        if (fixture.readWait) await fixture.readWait();
        input.assertCurrent();
        assert.equal(input.resourceUri, TOOL._meta.ui.resourceUri);
        return { uri: input.resourceUri, mimeType: "text/html;profile=mcp-app", text: HTML };
      }, async callTool(name, args, authority) {
        if (fixture.callWait) await fixture.callWait();
        dispatcher.authorizeEgress({ connectionId: connection.connectionId,
          principalIdentity: connection.principalIdentity, toolName: name, arguments: args, authority });
        fixture.sent += 1;
        return { content: [{ type: "text", text: `${name} complete` }] };
      }, async release() { fixture.releases += 1; } };
    } };
    const dependencies = { store, productStore, getRun: id => id === run.id ? run : null,
      getConversation: () => conversation, manager, catalog, dispatcher, permissionEngine };
    controller = new PluginAppController(dependencies);
    const input = { profileId: profile.id, conversationId: conversation.id, callId: "original-call" };
    assert.throws(() => controller.prepare(input), { code: "MCP_APP_SEED_UNAVAILABLE" });
    assert.throws(() => controller.recordCall({ callId: "missing-call", arguments: {}, result: initialResult }),
      { code: "MCP_APP_SEED_UNCONFIRMED" });
    const addReceipt = (callId, confirmed = true) => {
      store.beginCapabilityCall({ callId, runRef: run.id, bindingId: binding.bindingId,
        connectionId: connection.connectionId, principalIdentity: connection.principalIdentity,
        toolIdentity: originating.toolIdentity, contractDigest: originating.contractDigest,
        argumentDigest: crypto.createHash("sha256").update("{}").digest("hex") });
      if (confirmed) { store.markCapabilityCallSendStarted(callId); store.finishCapabilityCall(callId, { resultConfirmed: true }); }
    };
    addReceipt("unconfirmed-seed", false);
    assert.throws(() => controller.recordCall({ callId: "unconfirmed-seed", arguments: {}, result: initialResult }),
      { code: "MCP_APP_SEED_UNCONFIRMED" });
    assert.throws(() => controller.recordCall({ callId: input.callId, arguments: { forged: true }, result: initialResult }),
      { code: "MCP_APP_SEED_INVALID" });
    assert.throws(() => controller.recordCall({ callId: input.callId, arguments: originalArguments,
      result: { content: [{ type: "text", text: "汉".repeat(12000) }] } }), { code: "MCP_APP_SEED_LIMIT" });
    const recorded = controller.recordCall({ callId: input.callId, arguments: originalArguments, result: originalResult });
    originalArguments.filter.status = "forged after registration";
    originalResult.content[0].text = "forged after registration";
    originalResult.structuredContent.count = 999;
    assert.deepEqual(controller.recordCall({ callId: input.callId, arguments: initialArguments, result: initialResult }), recorded);
    assert.throws(() => controller.recordCall({ callId: input.callId, arguments: initialArguments,
      result: { content: [{ type: "text", text: "replacement" }] } }), { code: "MCP_APP_SEED_INVALID" });
    assert.throws(() => controller.prepare({ ...input, initialNotifications: [] }), { code: "MCP_APP_AUTHORITY_INVALID" });
    const restarted = new PluginAppController(dependencies);
    assert.throws(() => restarted.prepare(input), { code: "MCP_APP_SEED_UNAVAILABLE" });
    restarted.clear();
    const host = { hostOrigin: "http://127.0.0.1:18799", sandboxOrigin: "http://127.0.0.1:18800", sourceId: "native-frame" };
    const open = async () => controller.commit({ challenge: controller.prepare(input).challenge, approved: true, ...host });
    const ready = async descriptor => {
      const transport = descriptor.transport;
      const result = await controller.message(transport, rpc("init", "ui/initialize", {
        appInfo: { name: "fixture", version: "1" }, appCapabilities: {}, protocolVersion: MCP_APP_PROTOCOL_VERSION,
      }));
      assert.equal(result.result.protocolVersion, MCP_APP_PROTOCOL_VERSION);
      await controller.message(transport, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
      return transport;
    };
    assert.throws(() => controller.prepare({ ...input, conversationId: "conversation-b" }), { code: "MCP_APP_AUTHORITY_INVALID" });
    assert.throws(() => controller.prepare({ ...input, profileId: undefined }), { code: "MCP_APP_AUTHORITY_INVALID" });
    assert.throws(() => controller.prepare({ ...input, callId: "unknown-call" }), { code: "MCP_APP_AUTHORITY_INVALID" });
    const canceled = controller.prepare(input);
    assert.equal(canceled.summary.action, "app-open");
    assert.deepEqual(await controller.commit({ challenge: canceled.challenge, approved: false }), { canceled: true, descriptor: null });
    assert.equal(fixture.resourceReads, 0);
    await assert.rejects(controller.commit({ challenge: canceled.challenge, approved: true, ...host }), { code: "MCP_APP_SESSION_EXPIRED" });
    const stale = controller.prepare(input);
    grant("dashboard");
    await assert.rejects(controller.commit({ challenge: stale.challenge, approved: true, ...host }), { code: "MCP_APP_AUTHORITY_REVOKED" });

    const opened = await open();
    const descriptor = opened.descriptor;
    assert.deepEqual(descriptor.initialNotifications, [
      { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: initialArguments } },
      { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: initialResult },
    ]);
    assert.equal(Buffer.byteLength(JSON.stringify(descriptor)) < 44 * 1024, true);
    descriptor.initialNotifications[0].params.arguments.filter.status = "mutated descriptor";
    descriptor.initialNotifications[1].params.content[0].text = "mutated descriptor";
    assert.equal(descriptor.resource.encoding, "base64");
    assert.equal(descriptor.resource.byteLength, Buffer.byteLength(HTML));
    assert.equal(JSON.stringify(descriptor).includes("private-account"), false);
    assert.equal(JSON.stringify(descriptor).includes("<html>"), false);
    assert.equal(descriptor.resource.contentDigest, crypto.createHash("sha256").update(HTML).digest("hex"));
    const chunks = [];
    for (let index = 0; index < descriptor.resource.chunkCount; index += 1) {
      const chunk = controller.readChunk(descriptor.transport, index);
      assert.equal(Buffer.byteLength(chunk.text) <= 24 * 1024, true);
      assert.equal(chunk.total, descriptor.resource.chunkCount);
      chunks.push(chunk.text);
    }
    assert.equal(Buffer.from(chunks.join(""), "base64").toString("utf8"), HTML);
    assert.throws(() => controller.readChunk({ ...descriptor.transport, conversationId: "conversation-b" }, 0), { code: "MCP_APP_TRANSPORT_INVALID" });
    assert.throws(() => controller.readChunk({ ...descriptor.transport, sourceId: "wrong-frame" }, 0), { code: "MCP_APP_TRANSPORT_INVALID" });
    assert.equal(controller.readChunk(descriptor.transport, 0).index, 0, "bad transport cannot destroy valid session");
    const transport = await ready(descriptor);
    const first = await controller.message(transport, rpc("refresh", "tools/call", { name: "refresh", arguments: { x: 1 } }));
    assert.equal(first.result.content[0].text, "refresh complete");
    assert.equal(fixture.sent, 1);
    const receipt = store._db().prepare("SELECT * FROM capability_calls WHERE run_ref LIKE 'ui-%'").get();
    assert.equal(receipt.phase, "result_confirmed");
    assert.match(receipt.run_ref, /^ui-/u);
    assert.equal(code(await controller.message(transport, rpc("each", "tools/call", { name: "each-call" }))), "MCP_APP_TOOL_FORBIDDEN");
    grant("later");
    assert.equal(code(await controller.message(transport, rpc("later", "tools/call", { name: "later" }))), "MCP_APP_TOOL_FORBIDDEN");
    assert.equal(fixture.sent, 1, "new Grants cannot widen an already-open App");

    let releaseCall;
    let queued;
    const queuedPromise = new Promise(resolve => { queued = resolve; });
    fixture.callWait = () => { queued(); return new Promise(resolve => { releaseCall = resolve; }); };
    const pending = controller.message(transport, rpc("queued", "tools/call", { name: "refresh" }));
    await queuedPromise;
    const refreshGrant = store.getGrant(binding.bindingId, entries.get("refresh").toolIdentity);
    store.revokeGrant({ bindingId: binding.bindingId, toolIdentity: refreshGrant.toolIdentity, expectedRevision: refreshGrant.revision });
    releaseCall();
    assert.equal(code(await pending), "MCP_APP_TOOL_FORBIDDEN");
    assert.equal(fixture.sent, 1);
    assert.equal(store._db().prepare("SELECT COUNT(*) count FROM capability_calls WHERE phase = 'rejected_before_send'").get().count, 1);
    fixture.callWait = null;
    controller.close(transport);
    assert.throws(() => controller.readChunk(transport, 0), { code: "MCP_APP_SESSION_EXPIRED" });
    const reopened = await open();
    assert.deepEqual(reopened.descriptor.initialNotifications[0].params.arguments, initialArguments);
    assert.deepEqual(reopened.descriptor.initialNotifications[1].params, initialResult);
    assert.notEqual(reopened.descriptor.transport.sessionId, transport.sessionId,
      "completed original Run can reopen only through fresh native consent");
    controller.close(reopened.descriptor.transport);

    let releaseRead;
    let reading;
    const readingPromise = new Promise(resolve => { reading = resolve; });
    fixture.readWait = () => { reading(); return new Promise(resolve => { releaseRead = resolve; }); };
    const loading = open();
    await readingPromise;
    controller.revoke({ conversationId: input.conversationId });
    releaseRead();
    await assert.rejects(loading, { code: "MCP_APP_SESSION_EXPIRED" });
    fixture.readWait = null;
    const final = await open();
    conversation = null;
    assert.throws(() => controller.readChunk(final.descriptor.transport, 0), { code: "MCP_APP_AUTHORITY_REVOKED" });
    conversation = { id: input.conversationId, profileId: profile.id };
    const archived = await open();
    profile = { ...profile, enabled: false };
    await assert.rejects(controller.message(archived.descriptor.transport, rpc("archived", "ping")), { code: "MCP_APP_AUTHORITY_REVOKED" });
    profile = { ...profile, enabled: true };
    const evictionSession = await open();
    const evictionPending = controller.prepare(input);
    for (let index = 0; index < 128; index += 1) {
      const callId = `seed-limit-${index}`;
      addReceipt(callId);
      controller.recordCall({ callId, arguments: {}, result: initialResult });
    }
    assert.throws(() => controller.prepare(input), { code: "MCP_APP_SEED_UNAVAILABLE" });
    assert.throws(() => controller.readChunk(evictionSession.descriptor.transport, 0), { code: "MCP_APP_SESSION_EXPIRED" });
    await assert.rejects(controller.commit({ challenge: evictionPending.challenge, approved: true, ...host }),
      { code: "MCP_APP_SESSION_EXPIRED" });
    const latestInput = { ...input, callId: "seed-limit-127" };
    assert.equal(typeof controller.prepare(latestInput).challenge, "string");
    controller.clear();
    assert.throws(() => controller.prepare(latestInput), { code: "MCP_APP_SEED_UNAVAILABLE" });
    assert.equal(fixture.resourceReads, fixture.releases - 2, "every resource and tool client lease releases");
    console.log("plugin MCP App controller native-consent/chunks/Dispatcher fixture: PASS");
  } finally {
    controller?.clear(); store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
