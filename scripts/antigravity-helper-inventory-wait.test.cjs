"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { helperInventoryState, waitForHelperInventory } = require("./fixtures/antigravity-helper-inventory-wait.cjs");
const { createMcpStdioHandler } = require("../app/shoggoth-mcp-helper.js");
const source = { helpers: [{ pid: 101, ppid: 100 }], gateConsumptions: [{ parentPid: 100, actualProductionGateAccepted: true }] };
const request = (method, frameId, pid = 101, ppid = 100) => ({ direction: "runtime", method, frameId, pid, ppid });
const response = (frameId, fields, pid = 101, ppid = 100) => ({ direction: "helper", method: "response", frameId, pid, ppid, ...fields });
const initialize = [request("initialize", 2), response(2, { resultShape: { protocolVersion: "string" } })];
const inventory = [request("tools/list", 3), response(3, { groupToolsAvailable: ["group_messages_read"] })];

test("actual waiting continues after Gate.consume and waits for delayed same-helper inventory before stop", async () => {
  const observations = [], events = []; let stopped = false;
  const waiting = waitForHelperInventory({ read: () => ({ ...source, observations }), timeoutMs: 500, pollMs: 5 }).then(result => { stopped = true; events.push("stop"); return result; });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(stopped, false);
  observations.push(...initialize); events.push("initialize");
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(stopped, false);
  observations.push(...inventory); events.push("inventory");
  const result = await waiting; assert.equal(result.status, "ready"); assert.equal(result.helperPid, 101);
  assert.ok(result.elapsedMs >= 50); assert.deepEqual(events, ["initialize", "inventory", "stop"]);
});
test("gate alone reaches the bound and never reports inventory", async () => {
  const result = await waitForHelperInventory({ read: () => ({ ...source, observations: [] }), timeoutMs: 40, pollMs: 5 });
  assert.equal(result.status, "deadline"); assert.ok(result.elapsedMs >= 40); assert.equal(result.progress[0].gateAccepted, true);
});
test("a discovery error is observed but does not terminate the wait", () => {
  const observations = [request("server/discover", 1), response(1, { rpcError: true, rpcErrorCode: -32002 }), ...initialize, ...inventory];
  assert.equal(helperInventoryState({ ...source, observations }).status, "ready");
});
test("different helpers cannot combine initialize and inventory", () => {
  const observations = [...initialize, ...inventory.map(row => ({ ...row, pid: 102 }))];
  const state = helperInventoryState({ ...source, helpers: [...source.helpers, { pid: 102, ppid: 100 }], observations });
  assert.equal(state.status, "pending");
});
test("unconsumed parent and unmatched responses cannot report ready", () => {
  assert.equal(helperInventoryState({ ...source, observations: [...initialize, ...inventory], gateConsumptions: [] }).status, "pending");
  assert.equal(helperInventoryState({ ...source, observations: [initialize[1], ...inventory] }).status, "pending");
});
test("explicit helper failure stops promptly", async () => {
  const result = await waitForHelperInventory({ read: () => ({ ...source, observations: [{ pid: 101, ppid: 100, method: "helper.failure", code: "BOOTSTRAP_ROLE_REJECTED" }] }), timeoutMs: 500 });
  assert.equal(result.status, "failed"); assert.equal(result.reason, "BOOTSTRAP_ROLE_REJECTED"); assert.ok(result.elapsedMs < 100);
});
test("explicit bootstrap failure is terminal even before gate consumption", () => {
  const state = helperInventoryState({ ...source, gateConsumptions: [], observations: [{ pid: 101, ppid: 100, method: "helper.failure", code: "BOOTSTRAP_ROLE_REJECTED" }] });
  assert.equal(state.status, "failed"); assert.equal(state.reason, "BOOTSTRAP_ROLE_REJECTED");
});
test("actual native exit stops promptly while discovery failure alone does not", async () => {
  const result = await waitForHelperInventory({ read: () => ({ ...source, observations: [request("server/discover", 1), response(1, { rpcError: true })] }),
    readFailure: () => "AGY_KERNEL_NATIVE_EXIT_BEFORE_INVENTORY", timeoutMs: 500 });
  assert.equal(result.status, "failed"); assert.equal(result.reason, "AGY_KERNEL_NATIVE_EXIT_BEFORE_INVENTORY");
});
test("unmodified production handler returns discovery error and remains usable for legacy initialize and tools/list", async () => {
  const calls = [];
  const handler = createMcpStdioHandler({ runtimeProfileId: "rp", runtimeAccountId: "ra", sessionToken: Buffer.alloc(32, 0x51).toString("base64url"),
    paths: {}, requestService: async (_paths, value) => { calls.push(value.method); return {}; } });
  try {
    const discovered = await handler({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });
    assert.equal(discovered.error.code, -32002); assert.equal(discovered.error.message, "Server not initialized");
    const initialized = await handler({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "owned-source-probe", version: "1" } } });
    assert.equal(initialized.result.protocolVersion, "2025-06-18");
    const listed = await handler({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    assert.ok(listed.result.tools.some(tool => tool.name === "group_messages_read"));
    const unknown = await handler({ jsonrpc: "2.0", id: 4, method: "server/discover", params: {} });
    assert.equal(unknown.error.code, -32601); assert.deepEqual(calls, []);
  } finally { handler.close(); }
});
