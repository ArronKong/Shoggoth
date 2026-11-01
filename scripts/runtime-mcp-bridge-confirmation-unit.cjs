#!/usr/bin/env node
"use strict";

// Every non-Codex Runtime reaches Shoggoth through the Service-hosted MCP bridge. A
// confirmation (Computer Use / Browser Use session open) used to be requested from
// the Runtime's own MCP client, so it failed for any CLI that does not forward MCP
// elicitation (Grok uses a private ACP method, Antigravity has none). The bridge now
// asks the user through the Coordinator, whatever the client declares.
const assert = require("node:assert/strict");
const test = require("node:test");
const { openBridgeFixture, waitUntil } = require("./fixtures/runtime-bridge-harness.cjs");
const { createSyntheticAppleNative } = require("./fixtures/apple-device-service-fixture.cjs");
const { createAppleDeviceHost } = require("../app/apple-device-host");

async function fixture() {
  const productCalls = [];
  const value = await openBridgeFixture({ mcpProductToolController: { async handle(name, args, authority) {
    productCalls.push({ name, confirmed: authority.confirmation === true });
    if (name === "computer_status") {
      return { available: true, permissions: { accessibility: true, screenRecording: true }, sessions: [] };
    }
    if (name === "browser_status") return { available: true, reason: null, sessions: [] };
    return { opened: name };
  } } });
  return { ...value, productCalls };
}

const computerArgs = { source: "chat", sourceId: "bridge-confirmation", allowedApplications: ["com.apple.calculator"] };
const browserArgs = { source: "chat", sourceId: "bridge-confirmation" };

test("a bridge client without elicitation support still gets the Computer Use confirmation card", async () => {
  const value = await fixture();
  try {
    const call = value.callTool("computer_session_open", computerArgs);
    await value.confirm();
    const result = (await call.response).result;
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.deepEqual(value.productCalls, [
      { name: "computer_status", confirmed: false },
      { name: "computer_session_open", confirmed: true },
    ]);
    assert(value.events.some(event => event.type === "prompt" || event.type === "approval"),
      "the confirmation must be a Coordinator prompt, not a Runtime-forwarded one");
  } finally { await value.close(); }
});

test("declining or cancelling the confirmation never reaches the product tool", async () => {
  const value = await fixture();
  try {
    const declined = value.callTool("browser_session_open", browserArgs);
    await value.answer("submit", { confirm_product_action: "取消" });
    const declinedResult = (await declined.response).result;
    assert.equal(declinedResult.isError, false);
    assert.equal(declinedResult.structuredContent.canceled, true);
    const cancelled = value.callTool("browser_session_open", browserArgs);
    await value.answer("cancel", {});
    const cancelledResult = (await cancelled.response).result;
    assert.equal(cancelledResult.isError, false);
    assert.equal(cancelledResult.structuredContent.canceled, true);
    assert.deepEqual(value.productCalls.filter(call => call.name === "browser_session_open"), [],
      "an unconfirmed session must never be opened");
  } finally { await value.close(); }
});

test("Browser Use opens after the user confirms, and a second prompt works independently", async () => {
  const value = await fixture();
  try {
    for (const [index, name, args] of [[1, "browser_session_open", browserArgs], [2, "computer_session_open", computerArgs]]) {
      const call = value.callTool(name, args);
      await value.confirm();
      assert.equal((await call.response).result.isError, false, `${name} #${index}`);
    }
    assert.deepEqual(value.productCalls.filter(call => call.confirmed).map(call => call.name),
      ["browser_session_open", "computer_session_open"]);
  } finally { await value.close(); }
});

for (const disconnect of ["close", "end"]) test(`${disconnect} on the bridge cancels its pending prompt and returns the Run to running`, async () => {
  const value = await fixture();
  try {
    const call = value.callTool("computer_session_open", computerArgs);
    await waitUntil(() => ["waiting_approval", "waiting_input"].includes(value.run().status), "the user prompt");
    value.connection[disconnect]();
    await waitUntil(() => value.run().status === "running", "abandoned prompt to be withdrawn");
    if (disconnect === "end") {
      assert.equal((await call.response).id, call.id, "the cancelled call response must still drain after input EOF");
      await waitUntil(() => value.connection.isClosed(), "bridge socket to close after draining");
    }
    assert.deepEqual(value.productCalls.map(call => call.name), ["computer_status"]);
  } finally { await value.close(); }
});

test("a timed-out Apple delete cancels its exact approval without closing the bridge or accepting a late approve", async () => {
  const synthetic = createSyntheticAppleNative(); synthetic.authorization.reminders = "fullAccess";
  const deviceHost = createAppleDeviceHost({ native: synthetic.native, openExternal: async () => assert.fail("no real settings") });
  const value = await openBridgeFixture({ serviceOptions: { federationHostClient: {
    async request(method, params, options) {
      if (method === "apple.device.invoke") return deviceHost.invoke(params, options);
      throw Object.assign(new Error("fixture external backends unavailable"), { code: "BACKEND_UNAVAILABLE" });
    },
  } } });
  try {
    const device = value.service.appleDeviceController;
    await device.setPolicy({ resource: "reminders", enabled: true, readPolicy: "allow", writePolicy: "ask", disabledProfileIds: [], expectedRevision: device.state.revision });
    const target = [...synthetic.reminders.values()][0];
    const args = { id: target.id, expectedRevision: target.revision };
    const call = value.callTool("apple_reminders_delete", args);
    await waitUntil(() => value.run().status === "waiting_approval", "Apple delete approval");
    const requestId = value.run().waitingRequestId;
    const pending = value.service.workRunCoordinator.pendingRequests.get(requestId);
    assert.equal(pending.params.toolName, "apple_reminders_delete");
    assert.equal(synthetic.count("reminders.delete"), 0);
    value.connection.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: {
      requestId: call.id, reason: "upstream MCP timeout after 180000ms",
    } });
    await waitUntil(() => value.run().status === "running"
      && !value.service.workRunCoordinator.pendingRequests.has(requestId), "canceled Apple approval to withdraw");
    const canceled = await call.response;
    assert.equal(canceled.id, call.id);
    assert.ok(canceled.error || canceled.result?.isError, JSON.stringify(canceled));
    assert.equal(value.connection.isClosed(), false, "request cancellation must not close the MCP connection");
    await assert.rejects(() => value.service.workRunCoordinator.respondApproval({ operationId: "late-device-approval",
      runId: value.run().id, requestId, choice: "once" }), error => error.code === "WORK_RUN_REQUEST_MISMATCH");
    assert.equal(synthetic.count("reminders.delete"), 0, "an expired upstream call must never dispatch its late approval");
    assert.equal(synthetic.reminders.has(target.id), true);
    assert.equal(device.ledger.size, 0, "an unapproved cancellation creates no native write receipt to replay");
    const read = value.callTool("apple_reminders_get", { id: target.id });
    assert.equal((await read.response).result.structuredContent.reminder.id, target.id);
    const fresh = value.callTool("apple_reminders_delete", args);
    await waitUntil(() => value.run().status === "waiting_approval", "a fresh delete approval");
    assert.notEqual(value.run().waitingRequestId, requestId);
    assert.equal(synthetic.count("reminders.delete"), 0, "fresh requests still require their own device approval");
    await value.service.workRunCoordinator.respondApproval({ operationId: "fresh-device-approval",
      runId: value.run().id, requestId: value.run().waitingRequestId, choice: "once" });
    assert.equal((await fresh.response).result.isError, false);
    assert.equal(synthetic.count("reminders.delete"), 1);
    assert.equal(synthetic.reminders.has(target.id), false);
  } finally { await value.close(); }
});
