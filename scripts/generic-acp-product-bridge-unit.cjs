"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { AcpProductBridge } = require("../app/agent-service/runtime-acp-product-bridge");
const { RuntimeMcpGateIssuer } = require("../app/agent-service/runtime-mcp-gate");
const { resolveServicePaths } = require("../app/agent-service/paths");
const binding = { runtime: "ext-acp-bridge-fixture", runtimeProfileId: "acp-bridge-profile", runtimeAccountId: "acp-bridge-account" };
const parentExecutable = fs.realpathSync(process.execPath);
const turn = (overrides = {}) => ({ sessionId: "native-session", turnId: "local-turn", operationId: "operation", attemptId: "attempt",
  fingerprint: crypto.createHash("sha256").update("fixture").digest("hex"), ...overrides });
const permission = (overrides = {}) => ({ sessionId: "native-session",
  toolCall: { toolCallId: "native-tool-call", kind: "execute", title: "Run fixture command", rawInput: { command: "printf fixture" } },
  options: [{ optionId: "real-option-allow", name: "Allow this operation once", kind: "allow_once" },
    { optionId: "real-option-reject", name: "Reject this operation once", kind: "reject_once" }], ...overrides });
const context = { id: "native-request-1", method: "session/request_permission" };
function fixture(t, { realGate = false, contract = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-acp-product-bridge-")));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile") });
  const clock = { now: 10_000, parentIdentity: "fixture-parent-identity", executable: parentExecutable, live: true, paused: 0, checks: 0 };
  const contractValue = contract ? { ...binding, runId: "execution-run", profileId: "product-profile", workspace: root } : null;
  const records = [], revoked = [];
  const fakeIssuer = {
    reserveMcpServer(input) { records.push(input); return { reservationId: `${records.length}`.padStart(64, "0"), name: "shoggoth",
      command: parentExecutable, args: [path.resolve(__dirname, "../app/bootstrap.js"), "--shoggoth-internal-role=mcp"],
      env: [{ name: "SHOGGOTH_RUNTIME_MCP_GATE_NONCE", value: "fixture-one-use-nonce" }] }; },
    bindMcpServer(input) { assert.ok(input.parentPid > 1); },
    revokeMcpServer(input) { revoked.push(input.reservationId); return { revoked: true }; },
  };
  const issuer = realGate ? new RuntimeMcpGateIssuer({ paths, mcpHelperLaunch: { command: parentExecutable, argsPrefix: [] },
    bootstrapPath: path.resolve(__dirname, "../app/bootstrap.js"), now: () => clock.now,
    getProcessIdentity: () => clock.parentIdentity,
    getProcessLink: () => ({ ppid: process.ppid, executable: clock.executable, command: `${clock.executable} fixture.cjs` }),
  }).open() : fakeIssuer;
  const host = { ...binding, child: { pid: process.pid }, workspace: root, runtimeProcessExecutable: parentExecutable,
    mcpExecutionRunId: contractValue?.runId ?? null, permissionPolicy: { approvalPolicy: "on-request", sandbox: "danger-full-access" },
    assertRuntimeIdentityCurrent() { clock.checks++; if (!clock.live) throw Object.assign(new Error("changed"), { code: "RUNTIME_EXECUTABLE_CHANGED" }); },
    pauseManagedToolTimeout(scope) { assert.equal(scope.sessionId, "native-session"); assert.equal(scope.turnId, "local-turn"); clock.paused++;
      return () => { clock.paused--; }; },
  };
  const bridge = new AcpProductBridge({ binding, host, rpc: {}, mcpGateIssuer: issuer, executionContract: contractValue });
  const current = () => { if (!clock.live) throw Object.assign(new Error("revoked"), { code: "HOST_CAPABILITY_REVOKED" }); };
  const provision = async (operation = "new", sessionId) => {
    const descriptor = await bridge.prepareSession({ operation, ...(sessionId === undefined ? {} : { sessionId }) });
    descriptor.bindSession(sessionId || "native-session"); return descriptor;
  };
  const dispatch = async () => { const descriptor = await provision(); bridge.prepareTurn(turn(), { assertCurrent: current }); bridge.dispatchAttempt(turn()); return descriptor; };
  t.after(() => { bridge.close(); if (realGate) issuer.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, paths, host, bridge, issuer, clock, records, revoked, provision, dispatch, current };
}

test("MCP authority is unavailable until exact prepared execution crosses the dispatch boundary", async t => {
  const f = fixture(t), descriptor = await f.provision(), guard = f.records[0].assertExecutionCurrent;
  assert.throws(guard, { code: "HOST_CAPABILITY_REVOKED" });
  f.bridge.prepareTurn(turn(), { assertCurrent: f.current }); assert.throws(guard, { code: "HOST_CAPABILITY_REVOKED" });
  assert.throws(() => f.bridge.dispatchAttempt(turn({ attemptId: "foreign-attempt" })), { code: "HOST_CAPABILITY_REVOKED" });
  f.bridge.dispatchAttempt(turn()); assert.equal(guard(), true);
  assert.equal(JSON.stringify(descriptor.mcpServers).includes("execution-run"), false);
  assert.equal(JSON.stringify(descriptor.mcpServers).includes("sessionToken"), false);
  assert.equal(f.bridge.isIdle(), false);
  f.bridge.finishTurn(turn()); assert.throws(guard, { code: "HOST_CAPABILITY_REVOKED" }); assert.equal(f.bridge.isIdle(), true);
});

test("session slots cannot give an old helper the authority of another session or a reload", async t => {
  const f = fixture(t); await f.provision(); const oldGuard = f.records[0].assertExecutionCurrent;
  await f.provision("load", "native-session"); const currentGuard = f.records[1].assertExecutionCurrent;
  f.bridge.prepareTurn(turn(), { assertCurrent: f.current }); f.bridge.dispatchAttempt(turn());
  assert.throws(oldGuard, { code: "HOST_CAPABILITY_REVOKED" }); assert.equal(currentGuard(), true);
  const wrong = await f.bridge.prepareSession({ operation: "load", sessionId: "foreign-session" }); wrong.bindSession("foreign-session");
  assert.throws(f.records[2].assertExecutionCurrent, { code: "HOST_CAPABILITY_REVOKED" });
  assert.equal(currentGuard(), true, "a distinct unprompted session cannot change the assigned turn");
});

test("allow, reject and cancel decisions map only to original Agent option IDs", async t => {
  for (const [decision, expected] of [["accept", "real-option-allow"], ["decline", "real-option-reject"], ["cancel", null]]) {
    const f = fixture(t); await f.dispatch(); let request;
    f.bridge.registerServerRequestHandler("item/commandExecution/requestApproval", async (value, ctx) => {
      request = value; assert.equal(ctx.sourceMethod, "session/request_permission"); assert.equal(ctx.id, context.id);
      assert.equal(ctx.attemptId, "attempt"); return { decision };
    });
    const result = await f.bridge.requestPermission(permission(), context);
    assert.deepEqual(result, expected ? { outcome: { outcome: "selected", optionId: expected } } : { outcome: { outcome: "cancelled" } });
    assert.equal(request.command, "printf fixture"); assert.equal(request.itemId, "native-tool-call");
    assert.equal(request.nativeRequestId, context.id); assert.equal(request.attemptId, "attempt");
    assert.equal(request.sessionApprovalAvailable, false); assert.equal(f.clock.paused, 0);
  }
});

test("permissions before dispatch, from another session, or without a product handler are canceled", async t => {
  const f = fixture(t); await f.provision(); let calls = 0;
  f.bridge.registerServerRequestHandler("item/commandExecution/requestApproval", async () => { calls++; return { decision: "accept" }; });
  assert.equal((await f.bridge.requestPermission(permission(), context)).outcome.outcome, "cancelled");
  f.bridge.prepareTurn(turn(), { assertCurrent: f.current });
  assert.equal((await f.bridge.requestPermission(permission(), context)).outcome.outcome, "cancelled");
  f.bridge.dispatchAttempt(turn());
  assert.equal((await f.bridge.requestPermission(permission({ sessionId: "foreign-session" }), context)).outcome.outcome, "cancelled");
  assert.equal((await f.bridge.requestPermission(permission({ toolCall: { toolCallId: "file-1", kind: "edit", title: "Edit file" } }), context)).outcome.outcome, "cancelled");
  assert.equal(calls, 0);
});

test("missing once options, malformed options and persistent-only approvals do not fabricate a grant", async t => {
  const f = fixture(t); await f.dispatch(); let calls = 0;
  f.bridge.registerServerRequestHandler("item/commandExecution/requestApproval", async () => { calls++; return { decision: "accept" }; });
  for (const [index, options] of [[], [{ optionId: "always", name: "Trust forever", kind: "allow_always" }],
    [{ optionId: "dup", name: "One", kind: "allow_once" }, { optionId: "dup", name: "Two", kind: "reject_once" }],
    [{ optionId: "invalid", name: "Invalid", kind: "invented_kind" }],
    [{ optionId: "deny-only", name: "Deny", kind: "reject_once" }]].entries()) {
    const value = permission({ toolCall: { toolCallId: `native-${index}`, kind: "execute", title: "Fixture" }, options });
    assert.deepEqual(await f.bridge.requestPermission(value, { id: index }), { outcome: { outcome: "cancelled" } });
  }
  assert.equal(calls, 1, "a real deny-only option is displayed, but cannot authorize accept");
});

test("multiple once options retain their distinct semantic choices and raw option IDs", async t => {
  const f = fixture(t); await f.dispatch();
  f.bridge.registerServerRequestHandler("item/commandExecution/requestApproval", async request => {
    assert.deepEqual(request.approvalOptions.map(value => value.choice), ["once", "runtime:1", "deny"]);
    return { decision: "accept", approvalChoice: "runtime:1" };
  });
  const options = [{ optionId: "allow-a", name: "Allow A once", kind: "allow_once" },
    { optionId: "allow-b", name: "Allow B once", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }];
  assert.deepEqual(await f.bridge.requestPermission(permission({ options }), context), { outcome: { outcome: "selected", optionId: "allow-b" } });
});

test("duplicate native requests and the same toolCall under another request ID consume no second approval", async t => {
  const f = fixture(t); await f.dispatch(); let calls = 0;
  f.bridge.registerServerRequestHandler("item/commandExecution/requestApproval", async () => { calls++; return { decision: "accept" }; });
  assert.equal((await f.bridge.requestPermission(permission(), context)).outcome.optionId, "real-option-allow");
  assert.equal((await f.bridge.requestPermission(permission(), context)).outcome.outcome, "cancelled");
  assert.equal((await f.bridge.requestPermission(permission(), { id: "different-request" })).outcome.outcome, "cancelled");
  assert.equal(calls, 1);
});

test("canceling a prepared turn revokes pending approval, MCP authority and late user replies", async t => {
  const f = fixture(t); await f.dispatch(); let answer, received;
  f.bridge.registerServerRequestHandler("item/commandExecution/requestApproval", async (_params, ctx) => {
    received = ctx; return new Promise(resolve => { answer = resolve; });
  });
  const pending = f.bridge.requestPermission(permission(), context); await new Promise(setImmediate);
  assert.equal(f.clock.paused, 1); assert.equal(received.signal.aborted, false);
  f.bridge.interruptTurn(turn()); assert.equal(received.signal.aborted, true);
  assert.throws(f.records[0].assertExecutionCurrent, { code: "HOST_CAPABILITY_REVOKED" });
  answer({ decision: "accept" }); assert.deepEqual(await pending, { outcome: { outcome: "cancelled" } });
  assert.equal(f.clock.paused, 0); assert.equal(f.bridge.isIdle(), false, "interruption does not invent a terminal receipt");
  f.bridge.finishTurn(turn()); assert.equal(f.bridge.isIdle(), true);
});

test("external abort signals and stale attempt cancellation cannot authorize or cancel another execution", async t => {
  const f = fixture(t); await f.provision(); const controller = new AbortController();
  f.bridge.prepareTurn(turn(), { signal: controller.signal, assertCurrent: f.current }); f.bridge.dispatchAttempt(turn());
  assert.equal(f.bridge.interruptTurn(turn({ attemptId: "old-attempt" })), false);
  assert.equal(f.records[0].assertExecutionCurrent(), true);
  controller.abort(); assert.throws(f.records[0].assertExecutionCurrent, { code: "HOST_CAPABILITY_REVOKED" });
});

test("file permissions use the existing file-change handler and never claim a system sandbox", async t => {
  const f = fixture(t); await f.dispatch(); let request;
  f.bridge.registerServerRequestHandler("item/fileChange/requestApproval", async value => { request = value; return { decision: "decline" }; });
  const result = await f.bridge.requestPermission(permission({ toolCall: { toolCallId: "file-call", kind: "edit", title: "edit_file",
    rawInput: { path: "fixture.txt", value: "fixture" } } }), context);
  assert.equal(result.outcome.optionId, "real-option-reject"); assert.equal(request.toolName, "edit_file");
  assert.equal(Object.hasOwn(request, "sandbox"), false); assert.equal(Object.hasOwn(request, "permissions"), false);
});

test("command displays are complete and oversize/foreign-workspace operations cannot be approved", async t => {
  const f = fixture(t); await f.dispatch(); const seen = [];
  f.bridge.registerServerRequestHandler("item/commandExecution/requestApproval", async value => { seen.push(value); return { decision: "accept" }; });
  const command = "x".repeat(20 * 1024);
  assert.equal((await f.bridge.requestPermission(permission({ toolCall: { toolCallId: "long", kind: "execute", title: "Long fixture", rawInput: { command } } }), context)).outcome.optionId, "real-option-allow");
  assert.equal(seen[0].command, command);
  for (const [index, rawInput] of [{ command: "x".repeat(25 * 1024) }, { cwd: path.dirname(f.root), command: "pwd" }].entries()) {
    const result = await f.bridge.requestPermission(permission({ toolCall: { toolCallId: `invalid-${index}`, kind: "execute", title: "Fixture", rawInput } }), { id: index });
    assert.equal(result.outcome.outcome, "cancelled");
  }
  assert.equal(seen.length, 1);
});

test("a never policy delegates to the existing product decision instead of allowing a native option locally", async t => {
  const f = fixture(t); f.host.permissionPolicy.approvalPolicy = "never"; await f.dispatch(); let calls = 0;
  f.bridge.registerServerRequestHandler("item/commandExecution/requestApproval", async () => { calls++; return { decision: "decline" }; });
  assert.equal((await f.bridge.requestPermission(permission(), context)).outcome.optionId, "real-option-reject"); assert.equal(calls, 1);
});

test("host identity, account/run binding and late assignment changes revoke product authority", async t => {
  const f = fixture(t); await f.dispatch(); const guard = f.records[0].assertExecutionCurrent;
  f.clock.live = false; assert.throws(guard, { code: "RUNTIME_EXECUTABLE_CHANGED" }); f.clock.live = true;
  f.host.mcpExecutionRunId = "foreign-run"; assert.throws(guard, { code: "HOST_CAPABILITY_REVOKED" });
  f.host.mcpExecutionRunId = "execution-run"; f.host.child = { pid: process.pid };
  assert.throws(guard, { code: "HOST_CAPABILITY_REVOKED" });
});

function consume(issuer, descriptor, overrides = {}) {
  const env = Object.fromEntries(descriptor.mcpServers[0].env.map(value => [value.name, value.value]));
  return issuer.consume({ runtimeProfileId: binding.runtimeProfileId, runtimeAccountId: binding.runtimeAccountId,
    gatePath: env.SHOGGOTH_RUNTIME_MCP_GATE_FILE, nonce: env.SHOGGOTH_RUNTIME_MCP_GATE_NONCE, parentPid: process.pid, ...overrides });
}

test("a real gate can connect eagerly but its private product authority requires dispatch and never enters JSON", async t => {
  const f = fixture(t, { realGate: true }), descriptor = await f.provision();
  const env = Object.fromEntries(descriptor.mcpServers[0].env.map(value => [value.name, value.value]));
  const file = env.SHOGGOTH_RUNTIME_MCP_GATE_FILE;
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, "utf8").includes("execution-run"), false);
  assert.equal(fs.readFileSync(file, "utf8").includes("assertExecutionCurrent"), false);
  const authority = consume(f.issuer, descriptor);
  assert.equal(authority.executionRunId, "execution-run"); assert.equal(typeof authority.assertExecutionCurrent, "function");
  assert.equal(JSON.stringify(authority).includes("assertExecutionCurrent"), false);
  assert.throws(authority.assertExecutionCurrent, { code: "HOST_CAPABILITY_REVOKED" });
  f.bridge.prepareTurn(turn(), { assertCurrent: f.current }); f.bridge.dispatchAttempt(turn()); assert.equal(authority.assertExecutionCurrent(), true);
  assert.throws(() => consume(f.issuer, descriptor), { code: "RUNTIME_MCP_GATE_INVALID" });
  f.bridge.finishTurn(turn()); assert.throws(authority.assertExecutionCurrent, { code: "HOST_CAPABILITY_REVOKED" });
});

test("the consumed bridge rechecks its actual process executable and PID start identity on every call", async t => {
  const f = fixture(t, { realGate: true }), descriptor = await f.dispatch(), authority = consume(f.issuer, descriptor);
  assert.equal(authority.assertExecutionCurrent(), true);
  f.clock.executable = "/bin/sh"; assert.throws(authority.assertExecutionCurrent, { code: "RUNTIME_MCP_GATE_INVALID" });
  f.clock.executable = parentExecutable; assert.equal(authority.assertExecutionCurrent(), true);
  f.clock.parentIdentity = "reused-pid"; assert.throws(authority.assertExecutionCurrent, { code: "RUNTIME_MCP_GATE_INVALID" });
});

test("Service gate close/reopen cannot revive a previously consumed execution closure", async t => {
  const f = fixture(t, { realGate: true }), descriptor = await f.dispatch(), authority = consume(f.issuer, descriptor);
  assert.equal(authority.assertExecutionCurrent(), true); f.issuer.close();
  assert.throws(authority.assertExecutionCurrent, { code: "RUNTIME_MCP_GATE_INVALID" }); f.issuer.open();
  assert.throws(authority.assertExecutionCurrent, { code: "RUNTIME_MCP_GATE_INVALID" });
});

test("real gate consumption rejects foreign accounts, expiry and replaced ticket inodes", async t => {
  for (const mode of ["account", "expired", "inode"]) {
    const f = fixture(t, { realGate: true }), descriptor = await f.provision();
    if (mode === "account") assert.throws(() => consume(f.issuer, descriptor, { runtimeAccountId: "foreign-account" }), { code: "RUNTIME_MCP_GATE_INVALID" });
    else if (mode === "expired") { f.clock.now += 46_000; assert.throws(() => consume(f.issuer, descriptor), { code: "RUNTIME_MCP_GATE_INVALID" }); }
    else {
      const env = Object.fromEntries(descriptor.mcpServers[0].env.map(value => [value.name, value.value]));
      const ticket = env.SHOGGOTH_RUNTIME_MCP_GATE_FILE, copy = fs.readFileSync(ticket);
      fs.renameSync(ticket, `${ticket}.original`); fs.writeFileSync(ticket, copy, { mode: 0o600 });
      assert.throws(() => consume(f.issuer, descriptor), { code: "RUNTIME_MCP_GATE_INVALID" });
    }
  }
});

test("a gate execution guard needs an authenticated Run and rejects asynchronous or false authority", t => {
  const f = fixture(t, { realGate: true });
  assert.throws(() => f.issuer.reserveMcpServer({ ...binding, parentExecutable, assertExecutionCurrent() {} }), { code: "RUNTIME_MCP_GATE_INPUT_INVALID" });
  for (const assertExecutionCurrent of [() => false, () => Promise.resolve(true)]) {
    const reserved = f.issuer.reserveMcpServer({ ...binding, parentExecutable, executionRunId: "execution-run", assertExecutionCurrent });
    f.issuer.bindMcpServer({ reservationId: reserved.reservationId, parentPid: process.pid });
    const authority = consume(f.issuer, { mcpServers: [reserved] });
    assert.throws(authority.assertExecutionCurrent, { code: "RUNTIME_MCP_GATE_INVALID" });
  }
});
