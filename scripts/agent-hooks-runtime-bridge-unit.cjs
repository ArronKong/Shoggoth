"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const crypto = require("node:crypto"), path = require("node:path");
const { PiRuntimeHost } = require("../app/agent-service/pi-runtime-host");
const { RuntimeHookBridge, runtimeHookCapabilities, assertHookSupported, HOOK_RUNTIME_TARGETS } = require("../app/agent-service/runtime-hook-bridge");
const { PI_HOOK_TITLE, PI_CALL_BINDING_TITLE, PI_HOOK_VERSION, piNativeHookCapabilities } = require("../app/agent-service/pi-hook-contract");
const { bindingElicitation } = require("../app/agent-service/runtime-mcp-call-binding");
const { openFixture, sendAndDrain, FakeHost, directRuntimeManager } = require("./shoggoth-work-run-coordinator-unit.cjs");

test("Pi Hook integrity gate: shipped extension bytes and runtime version match the reviewed pin", () => {
  const manifest = require("../app/agent-service/pi-hook-extension-manifest.json");
  const extension = require("node:fs").readFileSync(path.join(__dirname, "../resources/pi/shoggoth-pi-extension.mjs"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.runtimeVersion, PI_HOOK_VERSION, "Pi Hook manifest must match the reviewed runtime contract");
  assert.equal(manifest.extensionSha256, crypto.createHash("sha256").update(extension).digest("hex"),
    "Pi native Hooks are disabled: extension bytes diverged from the reviewed pin. Review tool_call hooks, binding payloads and argument handling before updating pi-hook-extension-manifest.json; never auto-regenerate the pin.");
});

function routingHost() {
  const host = Object.assign(Object.create(PiRuntimeHost.prototype), { state: "ready", cliVersion: [0, 84, 4],
    extensionPath: path.join(__dirname, "../resources/pi/shoggoth-pi-extension.mjs"), serverRequestHandlers: new Map(),
    nativeHookScope: { runId: "run", snapshotId: "snapshot", toolNames: ["write"] }, now: Date.now });
  const active = { settled: false, sessionId: "session", turnId: "turn", promptTimer: null, promptTimeoutPaused: false };
  return { host, active };
}
test("Pi private input routes full Hook and MCP binding payloads without a user input dialog", async () => {
  const { host, active } = routingHost(), calls = [];
  host.serverRequestHandlers.set("shoggoth/hooks/tool", input => { calls.push(input); return { arguments: { path: "final.txt", content: "final" } }; });
  const response = await host._onExtensionRequest(active, { id: "private-one", method: "input", title: PI_HOOK_TITLE,
    placeholder: JSON.stringify({ phase: "before", toolCallId: "call", toolName: "write", arguments: { path: "a", content: "b" }, inputSchema: {} }) });
  assert.equal(response.cancelled, undefined); assert.equal(JSON.parse(response.value).arguments.path, "final.txt");
  assert.equal(calls[0].sessionId, "session"); assert.equal(calls[0].turnId, "turn");
  let proof;
  host.serverRequestHandlers.set("mcpServer/elicitation/request", params => { proof = params; return { action: "accept" }; });
  const params = bindingElicitation({ callId: crypto.randomUUID(), name: "hook_list", arguments: {}, sessionToken: "a".repeat(43) });
  const binding = await host._onExtensionRequest(active, { id: "private-two", method: "input", title: PI_CALL_BINDING_TITLE, placeholder: JSON.stringify(params) });
  assert.equal(binding.value, "accept"); assert.deepEqual(proof._meta, params._meta);
  assert.equal(proof.serverName, "shoggoth"); assert.equal(proof.sessionId, active.sessionId);
});
test("Pi private requests reject changed versions, inactive turns, undeclared tools, injected deadlines and oversized data", async () => {
  const { host, active } = routingHost(); let effects = 0;
  host.serverRequestHandlers.set("shoggoth/hooks/tool", () => { effects++; return {}; });
  const request = { id: "private", method: "input", title: PI_HOOK_TITLE,
    placeholder: JSON.stringify({ phase: "before", toolCallId: "call", toolName: "read" }) };
  assert.equal((await host._onExtensionRequest(active, request)).cancelled, true);
  request.placeholder = JSON.stringify({ phase: "before", toolCallId: "call", toolName: "write" });
  for (const value of [{ ...request, timeout: 1000 }, { ...request, placeholder: "x".repeat(65537) }]) {
    assert.equal((await host._onExtensionRequest(active, value)).cancelled, true);
  }
  active.settled = true; assert.equal((await host._onExtensionRequest(active, request)).cancelled, true); active.settled = false;
  host.cliVersion = [0, 84, 5]; assert.equal((await host._onExtensionRequest(active, request)).cancelled, true);
  assert.equal(effects, 0);
});
test("Coordinator binds the native Hook reverse request to its actual Pi Host, Run, turn and current lease", async () => {
  const rawHost = new FakeHost([]); let revision = "one", release, effects = 0;
  const fixture = await openFixture({ runtime: "pi", host: rawHost, runtimeManager: directRuntimeManager(rawHost, "pi"), getCapabilityPolicyRevision: () => revision });
  const calls = [], hook = {
    store: { snapshotForRun: () => ({ entries: [] }), assertCurrent() {} },
    prepareRun: async () => ({ snapshot: { id: "fixture-snapshot" }, contributions: [], summary: { rules: [], count: 0 } }),
    observeRun() {}, observeSession() {}, runner: { cancelRun: async () => {} }, releaseRun() {},
  };
  hook.runtimeToolEvent = async (request, scope) => { calls.push({ request, runId: scope.runId, bindingId: scope.bindingId });
    await new Promise(resolve => { release = resolve; }); scope.assertCurrent(); effects++; return { approved: true }; };
  hook.runtimeBridge = new RuntimeHookBridge({ service: hook, resolveAssignment: id => {
    const assignment = fixture.coordinator.runHostAssignments.get(id);
    return assignment && { host: assignment.host, bindingId: fixture.coordinator.runExecutionContracts.get(id).runtimeProfileId };
  } });
  fixture.coordinator.hookService = hook;
  try {
    const { ack } = await sendAndDrain(fixture), run = fixture.dispatcher.getRun(ack.run.id);
    assert.equal(run.status, "running");
    const handler = rawHost.serverRequestHandlers.get("shoggoth/hooks/tool"); assert.equal(typeof handler, "function");
    const params = { sessionId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId, request: { phase: "approve", toolCallId: "actual-call" } };
    assert.throws(() => handler({ ...params, turnId: "other-turn" }), { code: "WORK_RUN_REQUEST_UNROUTABLE" });
    assert.throws(() => handler({ ...params, profileId: "other-profile" }), { code: "WORK_RUN_REQUEST_UNROUTABLE" });
    const pending = handler(params); assert.equal(typeof release, "function");
    assert.equal(calls[0].runId, run.id); assert.equal(calls[0].bindingId, fixture.coordinator.runExecutionContracts.get(run.id).runtimeProfileId);
    revision = "two"; release(); await assert.rejects(pending, { code: "HOST_CAPABILITY_REVOKED" }); assert.equal(effects, 0);
  } finally { await fixture.coordinator.close(); }
});
test("eight-entry capability matrix is explicit; only pinned Pi has a native tool bridge", () => {
  assert.equal(HOOK_RUNTIME_TARGETS.length, 8);
  const { host } = routingHost(), native = piNativeHookCapabilities(host);
  for (const runtime of HOOK_RUNTIME_TARGETS) {
    const caps = runtimeHookCapabilities(runtime, runtime === "pi" ? native : {});
    for (const scope of ["product", "native_mcp", "plugin_mcp"]) for (const kind of ["guard", "arguments", "result", "action", "observe"]) assert.equal(caps.scopes[scope][kind].status, "supported");
    assert.equal(caps.scopes.runtime_builtin.guard.status, runtime === "pi" ? "supported" : "unsupported");
    assert.equal(caps.scopes.runtime_mcp.guard.status, "unsupported");
    assert.equal(caps.events["model.request.before"].status, "unsupported");
    if (runtime !== "pi") assert.throws(() => assertHookSupported({ event: "tool.before", kind: "guard", matcher: { toolScopes: ["runtime_builtin"] }, handler: { type: "builtin", name: "guard.block" } }, caps), { code: "HOOK_RUNTIME_UNSUPPORTED" });
  }
});
test("Pi pool never replaces the native Hook scope of an already acquired Run", async () => {
  const { PiRuntimePool } = require("../app/agent-service/pi-runtime-pool");
  const { piPermissionFingerprint } = require("../app/agent-service/pi-runtime-paths");
  const binding = { runtime: "pi", runtimeProfileId: "fixture", runtimeAccountId: "native-pi-default-v1" };
  const permissionPolicy = { approvalPolicy: "never", sandbox: "workspace-write" };
  const nativeHookScope = { runId: "fixture-run", snapshotId: "snapshot-one", toolNames: ["write"] };
  const options = { workspace: "/private/tmp/fixture", permissionPolicy, executionContract: { runId: "fixture-run" }, nativeHookScope };
  const pool = Object.assign(Object.create(PiRuntimePool.prototype), { blockedProfiles: new Set(), stoppingProfiles: new Set(), closing: false,
    entries: new Map(), options: {} });
  const host = { beginAcquire() {} };
  const key = JSON.stringify([binding.runtimeProfileId, binding.runtimeAccountId, "execution", options.workspace, "fixture-run"]);
  pool.entries.set(key, { runtimeProfileId: binding.runtimeProfileId, runtimeAccountId: binding.runtimeAccountId,
    policyFingerprint: JSON.stringify([piPermissionFingerprint(permissionPolicy), null]), hookScopeFingerprint: JSON.stringify(nativeHookScope), promise: Promise.resolve(host) });
  assert.equal(await pool.get(binding, options), host);
  await assert.rejects(pool.get(binding, { ...options, nativeHookScope: { ...nativeHookScope, snapshotId: "snapshot-two" } }), { code: "RUNTIME_HOOK_SCOPE_CONFLICT" });
});
