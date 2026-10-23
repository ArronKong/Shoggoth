#!/usr/bin/env node
"use strict";

// The product path a Runtime uses for Computer Use and Browser Use, end to end and
// independent of which CLI is on the other side: scripted MCP client -> Service-hosted
// bridge -> helper handler -> confirmation card -> real Computer/Browser controllers
// (only the macOS driver and the Playwright engine are fakes) -> WorkRun-scoped sessions.
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { openBridgeFixture, waitUntil } = require("./fixtures/runtime-bridge-harness.cjs");

const CALCULATOR = "com.apple.calculator";

function fakeCuaSdk(driver) {
  const factory = { new: value => value };
  return {
    CuaDriver: { createPrivateWorker: () => driver },
    RuntimeAuthorizationOptions: factory, ConfiguredDriverOptions: factory, PrivateWorkerOptions: factory,
    EmbeddedEnvironmentVariable: factory, StartSessionInput: factory, EndSessionInput: factory,
    SessionPermissionMode: { Bounded: 1 },
    currentMacOsPermissionStatus: () => ({ accessibility: true, screenRecording: true }),
  };
}

function fakeDriver(calls) {
  const structured = value => ({ isError: false, degraded: false, images: [], structuredJson: JSON.stringify(value) });
  return {
    async metadata() { return { driverVersion: "0.22.0", contractVersion: "0.7.0", embedded: true, pid: 987 }; },
    async startSession() { return { active: true }; },
    async endSession() { return { active: false }; },
    async shutdown() { calls.push({ name: "shutdown" }); },
    async callTool(name, argsJson) {
      const args = JSON.parse(argsJson);
      calls.push({ name, args });
      if (name === "list_apps") {
        return structured({ apps: [
          { name: "Calculator", bundle_id: CALCULATOR, pid: 42, running: true, active: true },
          { name: "Other", bundle_id: "com.example.Other", pid: 99, running: true, active: false },
        ] });
      }
      if (name === "list_windows") {
        return structured({ windows: [
          { app_name: "Calculator", pid: 42, window_id: 7, title: "Calculator", bounds: { x: 1, y: 2, width: 3, height: 4 }, is_on_screen: true },
          { app_name: "Other", pid: 99, window_id: 8, title: "Secret", bounds: {}, is_on_screen: true },
        ] });
      }
      if (name === "get_window_state") {
        // A small JPEG stands in for the screenshot, so the reply takes the same
        // image + text path as the packaged Service's thumbnail.
        const images = [{ mimeType: "image/jpeg", dataBase64: Buffer.from("fixture-jpeg").toString("base64") }];
        return { isError: false, degraded: false, images,
          structuredJson: JSON.stringify({ snapshot_id: "s12345678", tree_markdown: "window tree", degraded: false,
            elements: [{ element_index: 1, element_token: "token-one", role: "button", label: "7", value: "",
              frame: { x: 1, y: 1, w: 2, h: 2 } }] }) };
      }
      return { ...structured({}), action: { effect: 0, route: 0 } };
    },
  };
}

function fakeBrowserClient(events, sessionId) {
  const schema = properties => ({ type: "object", properties, additionalProperties: false });
  return {
    async listTools() {
      return [
        { name: "browser_navigate", inputSchema: { ...schema({ url: { type: "string" } }), required: ["url"] } },
        { name: "browser_snapshot", inputSchema: schema({}) },
        { name: "node_repl_forbidden", inputSchema: schema({}) },
      ];
    },
    async callTool(name, args) {
      events.push({ name, args });
      return { isError: false, content: [{ type: "text", text: name === "browser_snapshot"
        ? "- heading \"Fixture Page\" [ref=e1]" : `Navigated to ${args.url}` }] };
    },
    async close() { events.push({ name: "close", sessionId }); },
  };
}

async function fixture() {
  const driverCalls = [], browserEvents = [];
  const value = await openBridgeFixture({ serviceOptions: root => ({
    computerDriverPath: path.join(root, "cua-driver"), computerVerifyBinary: false,
    computerDriverManifest: { version: "0.22.0", contractVersion: "0.7.0" },
    computerSdkLoader: async () => fakeCuaSdk(fakeDriver(driverCalls)),
    computerPermissionStatus: () => ({ accessibility: true, screenRecording: true }),
    browserEngineStatus: () => "0.0.82", browserExecutable: () => "/fake/chrome",
    browserClientFactory: async ({ sessionId }) => fakeBrowserClient(browserEvents, sessionId),
  }) });
  // A call refused by the protocol layer (JSON-RPC error) is as refused as a tool error.
  const call = async (name, args = {}) => {
    const { response } = value.callTool(name, args);
    const reply = await response;
    return reply.result ?? { isError: true, error: reply.error };
  };
  const ok = async (name, args) => {
    const result = await call(name, args);
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(result)}`);
    return result.structuredContent;
  };
  return { ...value, driverCalls, browserEvents, call, ok };
}

test("Computer Use: status, confirmed open, observe, act and close through the bridge", async () => {
  const value = await fixture();
  try {
    const status = await value.ok("computer_status");
    assert.equal(status.available, true);
    assert.deepEqual(status.permissions, { accessibility: true, screenRecording: true });

    const open = value.callTool("computer_session_open", { ...value.source, allowedApplications: [CALCULATOR] });
    await value.confirm();
    const opened = (await open.response).result;
    assert.equal(opened.isError, false, JSON.stringify(opened));
    assert.equal(opened.structuredContent.expiresAt, null);
    assert.equal((await value.ok("computer_status")).sessions[0].expiresAt, null);
    const sessionId = opened.structuredContent.id;
    assert.ok(sessionId, "the opened session id is returned to the Agent");
    const scope = { ...value.source, sessionId };

    const applications = await value.ok("computer_application_list", scope);
    assert.deepEqual(JSON.stringify(applications).includes("com.example.Other"), false,
      "applications outside the confirmed bundle IDs are never shown");
    const windows = await value.ok("computer_window_list", { ...scope, onScreenOnly: true });
    assert.equal(JSON.stringify(windows).includes("Secret"), false, "windows of other applications are filtered");
    const snapshotResult = await value.call("computer_snapshot", { ...scope, pid: 42, windowId: 7 });
    assert.equal(snapshotResult.isError, false, JSON.stringify(snapshotResult));
    const snapshot = snapshotResult.structuredContent;
    assert.ok(snapshot.snapshotRevision, "an action needs the fresh snapshot revision");
    // Pi, OpenCode and DeepSeek pass only the text content to the model: act on what it says.
    const text = snapshotResult.content.find((item) => item.type === "text").text;
    const revision = text.match(/snapshotRevision=(\S+)/u)?.[1];
    const ref = text.match(/^(c\d+) /mu)?.[1];
    assert.equal(revision, snapshot.snapshotRevision, "the text carries the fresh snapshot revision");
    assert.equal(ref, snapshot.elements[0].ref, "the text lists the snapshot-bound refs");
    await value.ok("computer_click", { ...scope, snapshotRevision: revision, pid: 42, windowId: 7,
      ref, x: null, y: null });
    assert.equal(value.driverCalls.some(call => call.name === "click"), true, "the click reached the driver");

    const stale = await value.call("computer_click", { ...scope, snapshotRevision: revision, pid: 42,
      windowId: 7, ref, x: null, y: null });
    assert.equal(stale.isError, true, "a used snapshot revision must not be replayed");
    assert.equal(stale.structuredContent.error.code, "COMPUTER_SNAPSHOT_STALE", "the model is told why");
    assert.match(stale.content[0].text, /重新调用 computer_snapshot/u);

    await value.ok("computer_session_close", scope);
    assert.equal(value.driverCalls.some(call => call.name === "shutdown"), true, "closing ends the private worker");
    const after = await value.call("computer_application_list", scope);
    assert.equal(after.isError, true, "a closed session cannot be used again");
  } finally { await value.close(); }
});

test("Computer Use: a declined confirmation opens nothing", async () => {
  const value = await fixture();
  try {
    const open = value.callTool("computer_session_open", { ...value.source, allowedApplications: [CALCULATOR] });
    await value.answer("submit", { confirm_product_action: "取消" });
    const result = (await open.response).result;
    assert.equal(result.structuredContent.canceled, true);
    assert.equal(value.driverCalls.length, 0, "no driver worker may start without the user's confirmation");
    assert.deepEqual((await value.ok("computer_status")).sessions, []);
  } finally { await value.close(); }
});

test("Browser Use: status, confirmed open, list tools, navigate, snapshot and close through the bridge", async () => {
  const value = await fixture();
  try {
    const status = await value.ok("browser_status");
    assert.equal(status.available, true);
    assert.equal(status.browser, "chrome");

    const open = value.callTool("browser_session_open", { ...value.source });
    await value.confirm();
    const opened = (await open.response).result;
    assert.equal(opened.isError, false, JSON.stringify(opened));
    assert.equal(opened.structuredContent.expiresAt, null);
    assert.equal((await value.ok("browser_status")).sessions[0].expiresAt, null);
    const sessionId = opened.structuredContent.sessionId;
    assert.ok(sessionId);
    const scope = { ...value.source, sessionId };

    const listed = await value.ok("browser_tool_list", scope);
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ["browser_navigate", "browser_snapshot"],
      "only whitelisted Playwright tools are exposed");
    const navigated = await value.ok("browser_tool_call", { ...scope, toolName: "browser_navigate",
      arguments: { url: "http://127.0.0.1:9/fixture" } });
    assert.equal(navigated.isError, false);
    assert.match(JSON.stringify(navigated), /Navigated to http:\/\/127\.0\.0\.1:9\/fixture/u);
    const snapshot = await value.ok("browser_tool_call", { ...scope, toolName: "browser_snapshot", arguments: {} });
    assert.match(JSON.stringify(snapshot), /Fixture Page/u);
    assert.equal(snapshot.untrusted, true, "page content is marked untrusted data");

    const forbidden = await value.call("browser_tool_call", { ...scope, toolName: "node_repl_forbidden", arguments: {} });
    assert.equal(forbidden.isError, true, "tools outside the whitelist are refused");
    const badUrl = await value.call("browser_tool_call", { ...scope, toolName: "browser_navigate",
      arguments: { url: "file:///etc/passwd" } });
    assert.equal(badUrl.isError, true, "only credential-free http(s) navigation is allowed");

    await value.ok("browser_session_close", scope);
    assert.equal(value.browserEvents.some(event => event.name === "close"), true, "closing ends the browser");
    const after = await value.call("browser_tool_call", { ...scope, toolName: "browser_snapshot", arguments: {} });
    assert.equal(after.isError, true, "a closed browser session cannot be used again");
  } finally { await value.close(); }
});

test("Browser Use: a declined confirmation never launches a browser", async () => {
  const value = await fixture();
  try {
    const open = value.callTool("browser_session_open", { ...value.source });
    await value.answer("submit", { confirm_product_action: "取消" });
    assert.equal((await open.response).result.structuredContent.canceled, true);
    assert.deepEqual(value.browserEvents, [], "no browser client may start without the user's confirmation");
  } finally { await value.close(); }
});

async function openBrowser(value) {
  const open = value.callTool("browser_session_open", value.source);
  await value.confirm();
  const opened = (await open.response).result;
  assert.equal(opened.isError, false, JSON.stringify(opened));
  return { ...value.source, sessionId: opened.structuredContent.sessionId };
}

test("Browser handoff uses the Service input card without Runtime elicitation, retaining the same session", async () => {
  const value = await fixture();
  try {
    const scope = await openBrowser(value);
    const pending = value.callTool("browser_session_wait_for_user", { ...scope, instructions: "在当前窗口完成本地测试操作" });
    await waitUntil(() => value.run().status === "waiting_input", "browser input card");
    await value.service.browserUseController.reconcile();
    assert.equal((await value.service.browserUseController.status()).sessions[0].id, scope.sessionId);
    assert.equal(value.browserEvents.length, 0, "no automatic page operation during the handoff");
    await assert.rejects(value.service.browserUseController.callTool({ profileId: value.profile.id,
      workRunId: value.run().id, sessionId: scope.sessionId, toolName: "browser_snapshot", arguments: {} }),
    { code: "BROWSER_SESSION_BUSY" });
    const request = value.service.workRunCoordinator.pendingRequests.get(value.run().waitingRequestId);
    assert.ok(request.expiresAt - request.waitingStartedAt >= 30 * 60_000
      && request.expiresAt - request.waitingStartedAt < 30 * 60_000 + 1000);
    assert.deepEqual(request.params.requestedSchema.properties.browser_user_action.enum, ["已完成操作", "取消并关闭"]);
    assert.match(request.params.message, /只在浏览器内输入/u);
    await value.answer("submit", { browser_user_action: "已完成操作" });
    const result = (await pending.response).result;
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.structuredContent.sessionId, scope.sessionId);
    assert.equal(result.structuredContent.canceled, false);
    assert.equal(result.structuredContent.untrusted, true);
    assert.match(JSON.stringify(result), /Fixture Page/u);
    assert.deepEqual(value.browserEvents.map(event => event.name), ["browser_snapshot"]);
    assert.equal((await value.ok("browser_status")).sessions[0].id, scope.sessionId);
    await value.ok("browser_tool_call", { ...scope, toolName: "browser_navigate", arguments: { url: "http://127.0.0.1:9/after" } });
    assert.equal(value.run().status, "running", "the original WorkRun continues after the user answers");
    await value.service.workRunCoordinator.abort({ operationId: "handoff-stop", sessionKey: value.session.sessionKey, runId: value.run().id });
    await waitUntil(() => value.browserEvents.some(event => event.name === "close"), "terminal browser cleanup");
    assert.equal((await value.service.browserUseController.status()).sessions.length, 0);
  } finally { await value.close(); }
});

test("Browser handoff cancellation, dismissal and input expiry close the owned session without a page call", async () => {
  for (const action of ["cancel-option", "dismiss", "expire"]) {
    const value = await fixture();
    try {
      const scope = await openBrowser(value);
      if (action === "expire") value.service.workRunCoordinator.promptTimeoutMs = 50;
      const pending = value.callTool("browser_session_wait_for_user", { ...scope, instructions: "本地测试操作" });
      if (action !== "expire") await value.answer(action === "dismiss" ? "cancel" : "submit",
        action === "dismiss" ? {} : { browser_user_action: "取消并关闭" });
      const result = (await pending.response).result;
      if (action === "expire") {
        await waitUntil(() => value.run().status === "interrupted", "input timeout terminal state");
        assert.equal(value.run().errorCode, "CODEX_PROMPT_TIMEOUT");
        // Timeout terminates the native Run and revokes its in-flight MCP lease;
        // a late tool reply may be fenced, rather than returned to that dead turn.
        assert.ok(result.isError || result.structuredContent.canceled === true, JSON.stringify(result));
      } else {
        assert.equal(result.isError, false, JSON.stringify(result));
        assert.equal(result.structuredContent.canceled, true, action);
        assert.equal(value.run().status, "running");
      }
      assert.deepEqual(value.browserEvents.map(event => event.name), ["close"], action);
      assert.equal(value.run().waitingRequestId, null);
      assert.equal((await value.service.browserUseController.status()).sessions.length, 0);
    } finally { await value.close(); }
  }
});

test("A disconnected bridge or stopped WorkRun withdraws browser input and drains cleanup", async () => {
  for (const action of ["disconnect", "stop"]) {
    const value = await fixture();
    try {
      const scope = await openBrowser(value);
      const pending = value.callTool("browser_session_wait_for_user", { ...scope, instructions: "本地测试操作" }, 100);
      await waitUntil(() => value.run().status === "waiting_input", "browser input card");
      if (action === "disconnect") value.connection.close();
      else await value.service.workRunCoordinator.abort({ operationId: "stop-waiting-browser", sessionKey: value.session.sessionKey, runId: value.run().id });
      await waitUntil(() => value.browserEvents.some(event => event.name === "close"), "withdrawn browser cleanup");
      assert.deepEqual(value.browserEvents.map(event => event.name), ["close"]);
      assert.equal((await value.service.browserUseController.status()).sessions.length, 0);
      assert.equal(value.service.workRunCoordinator.pendingRequests.size, 0);
      if (action === "disconnect") { assert.equal(value.run().status, "running"); await assert.rejects(pending.response); }
    } finally { await value.close(); }
  }
});

test("Browser handoff refuses malformed instructions, foreign sessions and foreign sources before requesting input", async () => {
  const value = await fixture();
  try {
    const scope = await openBrowser(value);
    for (const extra of [{ instructions: "" }, { instructions: " ".repeat(5) }, { instructions: "x".repeat(513) },
      { instructions: "bad\0input" }, { instructions: "\uD800" }, { instructions: "本地测试", runId: value.run().id },
      { instructions: "本地测试", sessionId: "foreign-session" }, { instructions: "本地测试", sourceId: "foreign-source" }]) {
      const result = await value.call("browser_session_wait_for_user", { ...scope, ...extra });
      assert.equal(result.isError, true, JSON.stringify(extra));
      assert.equal(value.service.workRunCoordinator.pendingRequests.size, 0);
      assert.equal(value.run().status, "running");
    }
    const coordinator = value.service.workRunCoordinator;
    assert.throws(() => coordinator.requestProductUserInput({ runId: value.run().id, profileId: value.profile.id }),
      { code: "HOST_CAPABILITY_REVOKED" });
    assert.throws(() => coordinator.requestProductUserInput({ runId: value.run().id, profileId: "foreign", assertCurrent() {} }),
      { code: "HOST_CAPABILITY_REVOKED" });
    assert.deepEqual(value.browserEvents, []);
    assert.equal((await value.ok("browser_status")).sessions.length, 1);
  } finally { await value.close(); }
});

test("Revoking the handoff tool during input withdraws the card before any snapshot", async () => {
  const value = await fixture();
  try {
    const scope = await openBrowser(value);
    const pending = value.callTool("browser_session_wait_for_user", { ...scope, instructions: "本地测试操作" });
    await waitUntil(() => value.run().status === "waiting_input", "browser input card");
    value.service.permissionEngine.setProfileOverride(value.profile.id, "browser_session_wait_for_user", "deny");
    await value.service.browserUseController.reconcile();
    await waitUntil(() => value.browserEvents.some(event => event.name === "close"), "handoff permission revocation cleanup");
    assert.equal((await pending.response).result.isError, true, "the revoked tool never returns success");
    assert.deepEqual(value.browserEvents.map(event => event.name), ["close"]);
    assert.equal(value.run().waitingRequestId, null);
    assert.equal(value.run().status, "running");
    assert.equal(value.service.workRunCoordinator.pendingRequests.size, 0);
  } finally { await value.close(); }
});
