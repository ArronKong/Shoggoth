"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { PluginAppSessionManager, normalizeAppResource, MCP_APP_PROTOCOL_VERSION,
  MCP_APP_MIME_TYPE } = require("../app/agent-service/plugin-app-session");
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hash = "a".repeat(64);
const identity = (name, connection = "connection-a") => `plugin:installation-a:${hash}:${connection}:${sha(name)}`;
const sourceTool = { name: "dashboard", _meta: { ui: { resourceUri: "ui://fixture/dashboard" } } };
const resource = { uri: "ui://fixture/dashboard", mimeType: MCP_APP_MIME_TYPE,
  text: "<!doctype html><html><body><script>document.body.dataset.ready='yes'</script></body></html>" };
const authority = { profileId: "profile-a", conversationId: "conversation-a", runId: "run-a",
  installationId: "installation-a", releaseDigest: hash, componentId: hash,
  bindingId: "binding-a", bindingRevision: 1, connectionId: "connection-a",
  principalIdentity: "account-a", authRevision: 1, toolIdentity: identity("dashboard"),
  contractDigest: hash, catalogRevision: "catalog-a" };
const tools = ["dashboard", "refresh", "model-only"].map((downstreamName) => ({ downstreamName,
  toolIdentity: identity(downstreamName), contractDigest: hash,
  ...(downstreamName === "model-only" ? { visibility: ["model"] } : {}) }));
const base = { authority, tool: sourceTool, resource, tools, hostOrigin: "http://127.0.0.1:18799",
  sandboxOrigin: "http://127.0.0.1:18800", sourceId: "trusted-frame-a" };
const transportFor = (session, conversationId = authority.conversationId) => ({ sessionId: session.sessionId,
  nonce: session.nonce, sourceId: session.sourceId, origin: session.sandboxOrigin, conversationId });
const rpc = (id, method, params = {}) => ({ jsonrpc: "2.0", id, method, params });
const errorCode = (result) => result.error?.data?.code;
async function ready(manager, session) {
  const transport = transportFor(session);
  const initialized = await manager.handle(transport, rpc("initialize", "ui/initialize", {
    appInfo: { name: "Fixture", version: "1" }, appCapabilities: {}, protocolVersion: MCP_APP_PROTOCOL_VERSION,
  }));
  assert.equal(initialized.result.protocolVersion, MCP_APP_PROTOCOL_VERSION);
  assert.deepEqual(initialized.result.hostCapabilities.sandbox.permissions, {});
  assert.equal(initialized.result.hostCapabilities.serverResources, undefined);
  await manager.handle(transport, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
  return transport;
}

async function main() {
  const normalized = normalizeAppResource({ tool: sourceTool, resource });
  assert.match(normalized.policy.contentSecurityPolicy, /connect-src 'none'/u);
  assert.match(normalized.policy.contentSecurityPolicy, /frame-src 'none'/u);
  assert.equal(normalized.policy.navigation, "blocked");
  assert.equal(normalized.policy.nodeIntegration, false);
  assert.equal(normalized.policy.contextIsolation, true);
  assert.equal(normalized.policy.sandbox, true);
  assert.equal(normalized.policy.innerSandbox, "allow-scripts");
  const encoded = normalizeAppResource({ tool: sourceTool, resource: { uri: resource.uri,
    mimeType: resource.mimeType, blob: Buffer.from(resource.text).toString("base64") } });
  assert.equal(encoded.resourceDigest, normalized.resourceDigest);
  const requested = { ...resource, _meta: { ui: { domain: "attacker.invalid", permissions: { camera: {} },
    csp: { connectDomains: ["https://api.example.com", "https://unapproved.example.com"],
      resourceDomains: ["https://cdn.example.com"], frameDomains: ["https://frames.example.com"] } } } };
  const approved = normalizeAppResource({ tool: sourceTool, resource: requested,
    approvedCsp: { connectDomains: ["https://api.example.com", "https://undeclared.example.com"],
      resourceDomains: ["https://cdn.example.com"], frameDomains: ["https://frames.example.com"] } });
  assert.deepEqual(approved.policy.csp.connectDomains, ["https://api.example.com"]);
  assert.deepEqual(approved.policy.csp.frameDomains, []);
  assert.deepEqual(approved.policy.permissions, {});
  assert.equal(approved.policy.dedicatedOriginRequested, true);
  assert.notEqual(approved.resourceDigest, normalized.resourceDigest);
  for (const invalid of [
    { ...resource, uri: "ui://other/resource" }, { ...resource, mimeType: "text/html" },
    { ...resource, blob: "AAAA" }, { ...resource, text: "<script>bad()</script>" },
    { ...resource, text: "<!doctype html><html>" + "x".repeat(512 * 1024) },
    { uri: resource.uri, mimeType: resource.mimeType, blob: "8A==" },
  ]) assert.throws(() => normalizeAppResource({ tool: sourceTool, resource: invalid }), { code: "MCP_APP_RESOURCE_INVALID" });
  for (const domain of ["https://*.example.com", "http://example.com", "https://127.0.0.1", "https://localhost",
    "https://example.com/path", "https://example.com; script-src *"]) {
    assert.throws(() => normalizeAppResource({ tool: sourceTool,
      resource: { ...resource, _meta: { ui: { csp: { connectDomains: [domain] } } } } }),
    { code: "MCP_APP_ORIGIN_INVALID" });
  }

  let now = 1000;
  let active = true;
  const delivered = [];
  const manager = new PluginAppSessionManager({ now: () => now,
    assertAuthority: (context) => active && context.principalIdentity === "account-a"
      && context.authRevision === 1 && context.resourceDigest === normalized.resourceDigest,
    async dispatchCapability(input) {
      input.assertCurrent();
      delivered.push(input);
      return { content: [{ type: "text", text: "fixture result" }] };
    } });
  assert.throws(() => manager.create({ ...base, sandboxOrigin: base.hostOrigin }), { code: "MCP_APP_ORIGIN_INVALID" });
  assert.throws(() => manager.create({ ...base, sourceId: undefined }), { code: "MCP_APP_LIMIT" });
  for (const key of ["profileId", "conversationId", "runId", "installationId", "bindingId", "connectionId"]) {
    assert.throws(() => manager.create({ ...base, authority: { ...authority, [key]: undefined } }), { code: "MCP_APP_AUTHORITY_INVALID" });
    assert.throws(() => manager.create({ ...base, authority: { ...authority, [key]: 123 } }), { code: "MCP_APP_AUTHORITY_INVALID" });
  }
  assert.throws(() => manager.revoke({ profileId: undefined }), { code: "MCP_APP_AUTHORITY_INVALID" });
  assert.throws(() => manager.revoke({ connectionId: 123 }), { code: "MCP_APP_AUTHORITY_INVALID" });
  assert.throws(() => manager.create({ ...base, tool: { ...sourceTool,
    _meta: { ui: { resourceUri: resource.uri, visibility: ["invalid"] } } } }), { code: "MCP_APP_RESOURCE_INVALID" });
  assert.throws(() => manager.create({ ...base, tools: [{ ...tools[0], appUnsupported: true }] }), { code: "MCP_APP_AUTHORITY_INVALID" });
  assert.throws(() => manager.create({ ...base, tools: [{ ...tools[0], toolIdentity: identity("dashboard", "connection-b") }] }),
    { code: "MCP_APP_AUTHORITY_INVALID" });
  const session = manager.create(base);
  assert.match(session.sessionId, /^[a-f0-9]{64}$/u);
  assert.notEqual(session.nonce, session.sessionId);
  assert.equal(JSON.stringify(session).includes("account-a"), false, "renderer descriptor excludes principal");
  const transport = transportFor(session);
  for (const invalid of [{ ...transport, origin: base.hostOrigin }, { ...transport, sourceId: "other-frame" },
    { ...transport, conversationId: "conversation-b" }, { ...transport, nonce: "guessed" }]) {
    await assert.rejects(manager.handle(invalid, rpc("invalid", "ping")), { code: "MCP_APP_TRANSPORT_INVALID" });
  }
  assert.equal(errorCode(await manager.handle(transport, rpc("early", "tools/call", { name: "refresh" }))), "MCP_APP_NOT_READY");
  await ready(manager, session);
  const result = await manager.handle(transport, rpc("call", "tools/call", { name: "refresh", arguments: { value: 1 } }));
  assert.equal(result.result.content[0].text, "fixture result");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].tool.toolIdentity, identity("refresh"));
  assert.equal(delivered[0].context.resourceDigest, normalized.resourceDigest);
  assert.equal(delivered[0].context.runId, "run-a");
  assert.equal(Object.isFrozen(delivered[0].context), true);
  assert.equal(errorCode(await manager.handle(transport, rpc("call", "tools/call", { name: "refresh" }))), "MCP_APP_DUPLICATE_REQUEST");
  assert.equal(delivered.length, 1);
  for (const name of ["model-only", "other-server", "shell"]) {
    assert.equal(errorCode(await manager.handle(transport, rpc(`deny-${name}`, "tools/call", { name }))), "MCP_APP_TOOL_FORBIDDEN");
  }
  for (const method of ["resources/read", "ui/open-link", "ui/message", "ui/update-model-context",
    "fs/read", "http/fetch", "ui/request-display-mode", "ui/notifications/sandbox-resource-ready"]) {
    assert.equal(errorCode(await manager.handle(transport, rpc(method, method, { url: "file:///secret" }))), "MCP_APP_METHOD_UNSUPPORTED");
  }
  await assert.rejects(manager.handle(transport, rpc("large", "tools/call", { name: "refresh", arguments: { x: "x".repeat(65536) } })),
    { code: "MCP_APP_LIMIT" });
  const hostile = { jsonrpc: "2.0", id: "getter", method: "ping", get params() { throw new Error("must not execute getter"); } };
  await assert.rejects(manager.handle(transport, hostile), { code: "MCP_APP_MESSAGE_INVALID" });
  active = false;
  await assert.rejects(manager.handle(transport, rpc("revoked", "ping")), { code: "MCP_APP_AUTHORITY_REVOKED" });
  active = true;
  await assert.rejects(manager.handle(transport, rpc("restore", "ping")), { code: "MCP_APP_TRANSPORT_INVALID" });
  const expired = manager.create({ ...base, ttlMs: 1000 });
  now += 1001;
  await assert.rejects(manager.handle(transportFor(expired), rpc("expired", "ping")), { code: "MCP_APP_SESSION_EXPIRED" });

  const waits = [];
  let sends = 0;
  const delayed = new PluginAppSessionManager({ assertAuthority: () => active,
    dispatchCapability(input) {
      return new Promise((resolve) => waits.push(() => {
        try { input.assertCurrent(); sends += 1; resolve({ ok: true }); }
        catch { resolve({ neverDeliver: "late result" }); }
      }));
    } });
  const delayedSession = delayed.create(base);
  const delayedTransport = await ready(delayed, delayedSession);
  const pending = delayed.handle(delayedTransport, rpc("pending", "tools/call", { name: "refresh" }));
  await Promise.resolve();
  delayed.revoke({ connectionId: "connection-a" });
  assert.equal(errorCode(await pending), "MCP_APP_REQUEST_CANCELLED");
  waits.shift()();
  await Promise.resolve();
  assert.equal(sends, 0, "final dispatch assertion blocks a queued revoked request");

  const cancelSession = delayed.create(base);
  const cancelTransport = await ready(delayed, cancelSession);
  const cancellation = delayed.handle(cancelTransport, rpc(7, "tools/call", { name: "refresh" }));
  await Promise.resolve();
  await delayed.handle(cancelTransport, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } });
  assert.equal(errorCode(await cancellation), "MCP_APP_REQUEST_CANCELLED");
  assert.equal(errorCode(await delayed.handle(cancelTransport, rpc(7, "tools/call", { name: "refresh" }))), "MCP_APP_DUPLICATE_REQUEST");
  waits.shift()();
  await Promise.resolve();
  assert.equal(sends, 0);
  const closed = delayed.close(cancelTransport);
  assert.equal(closed.teardown.method, "ui/resource-teardown");
  await assert.rejects(delayed.handle(cancelTransport, rpc("reopen", "ping")), { code: "MCP_APP_TRANSPORT_INVALID" });

  const limited = delayed.create(base);
  const limitedTransport = await ready(delayed, limited);
  const pendingCalls = [0, 1, 2, 3].map((id) => delayed.handle(limitedTransport, rpc(id, "tools/call", { name: "refresh" })));
  await Promise.resolve();
  assert.equal(errorCode(await delayed.handle(limitedTransport, rpc(4, "tools/call", { name: "refresh" }))), "MCP_APP_LIMIT");
  delayed.clear();
  assert.equal((await Promise.all(pendingCalls)).every((item) => errorCode(item) === "MCP_APP_REQUEST_CANCELLED"), true);
  for (const complete of waits.splice(0)) complete();
  await Promise.resolve();
  const flood = manager.create(base);
  const floodTransport = await ready(manager, flood);
  let limit;
  for (let id = 0; id < 100; id += 1) {
    limit = await manager.handle(floodTransport, rpc(id, "ping"));
    if (limit.error) break;
  }
  assert.equal(errorCode(limit), "MCP_APP_LIMIT");
  await assert.rejects(manager.handle(floodTransport, rpc("after-limit", "ping")), { code: "MCP_APP_TRANSPORT_INVALID" });
  manager.clear(); delayed.clear();
  console.log("plugin MCP App authority/resource/bridge fixture: PASS");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
