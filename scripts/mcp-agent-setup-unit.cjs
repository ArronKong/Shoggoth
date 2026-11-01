"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { NativeMcpStore } = require("../app/agent-service/native-mcp-store");
const { McpConnectorController } = require("../app/agent-service/mcp-connector-controller");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { planAgentMcpSetup } = require("../app/agent-service/mcp-agent-setup-plan");
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-agent-setup-unit-")); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ homeDir: root, trustedRoot: root, stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profiles") });
  fs.mkdirSync(paths.defaultWorkspaceDir, { recursive: true, mode: 0o700 });
  const store = new NativeMcpStore({ paths }).open(), records = new Map(), received = [];
  const owner = { profileId: "agent-a", agentId: "agent-a", backendId: "shoggoth", sessionKey: "chat-a", transcriptSessionId: "transcript-a", runId: "run-a" };
  let release, failAck = false; const finished = new Promise(resolve => { release = resolve; });
  const secrets = { refFor: id => `mcp-connector:${id}`, get: async ref => records.get(ref.replace(/^mcp-connector:/, "")) || null,
    read: async id => records.get(id), write: async (id, patch) => records.set(id, { ...records.get(id), ...patch }), remove: async id => records.delete(id) };
  const make = () => new McpConnectorController({ paths, store, secrets, manager: { closeServer: async () => {}, listTools: async () => [{ name: "echo" }] },
    oauth: { close: async () => {} }, getOwner: async () => owner, waitForSetupOwner: () => finished,
    onComplete: async value => { received.push(value); if (failAck) throw Error("lost ACK"); } }).open();
  let controller = make(); controller.captureRun({ id: owner.runId, profileId: owner.profileId });
  return { paths, store, owner, received, release, get controller() { return controller; }, failAck: () => { failAck = true; },
    restart: async () => { await controller.close(); controller = make(); controller.agentSetup.changed(); },
    close: async () => { await controller.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
const args = (suffix = "one") => ({ url: `https://example.test/${suffix}`, purpose: "Continue original request" });
test("planner rejects embedded secrets and validates every JSON entry before installing", () => {
  const paths = { defaultWorkspaceDir: "/tmp" };
  for (const config of [ { url: "https://example.test", headers: { Authorization: "Bearer actual-secret" } }, { url: "https://example.test?api_key=secret" },
    { url: "https://example.test", requiredFields: ["env:TOKEN"] }, { mcpServers: { good: { url: "https://example.test" }, bad: { command: "missing", url: "https://example.test" } } } ]) {
    assert.throws(() => planAgentMcpSetup("mcp_server_import", { config: JSON.stringify(config) }, paths));
  }
  const plan = planAgentMcpSetup("mcp_server_import", { config: JSON.stringify({ servers: { key: { url: "https://example.test", headers: { "X-Api-Key": "${TOKEN}" } } } }) }, paths);
  assert.deepEqual(plan[0].requiredFields, ["header:X-Api-Key"]); assert.deepEqual(plan[0].input.fields, {});
});
test("multiple additions wait for source completion and the entire batch, then resume once", async () => {
  const f = fixture(); try {
    const one = await f.controller.agentSetup.install("mcp_server_add", args(), f.owner);
    const two = await f.controller.agentSetup.install("mcp_server_add", { ...args("two"), requiredFields: ["header:X-Key"] }, f.owner);
    assert.equal(one.servers[0].status, "ready"); assert.equal(two.servers[0].status, "needsSetup");
    assert.equal((await f.controller.agentSetup.install("mcp_server_add", args(), f.owner)).request.requestId, one.request.requestId);
    f.release(true); await tick(); assert.equal(f.received.length, 0);
    await f.controller.credentials({ id: two.servers[0].id, fields: { headers: { "X-Key": "secret-canary" } }, expectedRevision: f.store.revision });
    await tick(); assert.equal(f.received.length, 1); assert.match(f.received[0].idempotencyKey, /^mcp-request-setup-/);
    assert.ok([...f.controller.requests.values()].every(request => request.status === "completed"));
    assert.equal(JSON.stringify(f.received).includes("secret-canary"), false);
    await f.restart(); await tick(); assert.equal(f.received.length, 1);
  } finally { await f.close(); }
});
test("uncertain continuation is persisted and never replayed after completion retries or restart", async () => {
  const f = fixture(); try {
    f.failAck(); const result = await f.controller.agentSetup.install("mcp_server_add", args(), f.owner);
    f.release(true); await tick(); assert.equal(f.received.length, 1);
    assert.equal(f.controller.requests.get(result.request.requestId).continuation, "unknown");
    await assert.rejects(f.controller.complete({ requestId: result.request.requestId }), { code: "MCP_REQUEST_ACK_UNKNOWN" });
    await f.restart(); await f.controller.verify(result.servers[0].id); await tick(); assert.equal(f.received.length, 1);
  } finally { await f.close(); }
});
test("canceled source and disabled existing connectors never start an automatic continuation", async () => {
  const f = fixture(); try {
    const result = await f.controller.agentSetup.install("mcp_server_add", args(), f.owner); f.release(false); await tick(); assert.equal(f.received.length, 0);
    f.store.update({ id: result.servers[0].id, patch: { disabledProfileIds: [f.owner.profileId] }, expectedRevision: f.store.revision });
    const denied = await f.controller.agentSetup.install("mcp_server_add", args(), { ...f.owner, runId: "run-b" });
    assert.equal(denied.request, null); assert.equal(denied.errors[0].errorCode, "MCP_CONNECTOR_ACCESS_DENIED"); assert.equal(f.received.length, 0);
  } finally { await f.close(); }
});
