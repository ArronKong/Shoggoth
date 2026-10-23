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

test("closing the bridge cancels its pending prompt and returns the Run to running", async () => {
  const value = await fixture();
  try {
    value.callTool("computer_session_open", computerArgs);
    await waitUntil(() => ["waiting_approval", "waiting_input"].includes(value.run().status), "the user prompt");
    value.connection.close();
    await waitUntil(() => value.run().status === "running", "abandoned prompt to be withdrawn");
    assert.deepEqual(value.productCalls.map(call => call.name), ["computer_status"]);
  } finally { await value.close(); }
});
