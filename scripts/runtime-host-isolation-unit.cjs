#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { openFixture, sendAndDrain, waitUntil, FakeChatSessionStore, createRealTransportHost,
  SESSION_KEY } = require("./shoggoth-work-run-coordinator-unit.cjs");
const { DEFAULT_RUNTIME_ACCOUNTS } = require("../app/agent-service/runtime-account");

test("canceled run approval cannot be answered by the next run on the same host", async () => {
  const f = await openFixture({ sessionStatus: "ready", threadId: "shared-thread",
    threads: [{ id: "shared-thread", threadSource: null, turns: [] }] });
  try {
    const first = (await sendAndDrain(f, { operationId: "first" })).ack.run.id;
    const run = f.coordinator.getRun(first);
    const pending = f.host.request("item/fileChange/requestApproval", {
      threadId: run.runtimeSessionRef?.sessionId, turnId: run.runtimeTurnRef?.turnId, itemId: "old-item",
      startedAtMs: 1, grantRoot: null, reason: null }, "old-raw-rpc");
    await waitUntil(() => f.coordinator.getRun(first).status === "waiting_approval", 1000, "approval");
    const requestId = f.coordinator.getRun(first).waitingRequestId;
    await f.coordinator.abort({ operationId: "abort-first", sessionKey: SESSION_KEY, runId: first });
    assert.deepEqual(await pending, { decision: "cancel" });
    const second = (await sendAndDrain(f, { operationId: "second" })).ack.run.id;
    assert.equal(f.coordinator.getRun(second).status, "running");
    await assert.rejects(f.coordinator.respondApproval({ operationId: "stale-via-second",
      runId: second, requestId, choice: "once" }), { code: "WORK_RUN_REQUEST_MISMATCH" });
    await assert.rejects(f.coordinator.respondApproval({ operationId: "stale-via-first",
      runId: first, requestId, choice: "once" }));
    assert.equal(f.coordinator.getRun(second).status, "running");
    assert.equal(f.coordinator.getMemoryStats().pendingRequests, 0);
  } finally { await f.coordinator.close(); }
});

function twoSessions() {
  const first = new FakeChatSessionStore([]);
  const second = new FakeChatSessionStore([]);
  second.session.id = "44444444-4444-4444-8444-444444444444";
  second.session.sessionKey = "22222222-2222-4222-8222-222222222222";
  const stores = new Map([[first.session.sessionKey, first], [second.session.sessionKey, second]]);
  const sessions = { listPendingBindings: () => [...stores.values()].flatMap(s => s.listPendingBindings()) };
  sessions.recoverBinding = input => stores.get(input.sessionKey).recoverBinding(input);
  for (const method of ["getSession", "requestBinding", "completeBinding", "getBinding"]) {
    sessions[method] = (key, ...args) => stores.get(key)?.[method](key, ...args) ?? null;
  }
  return { sessions, first: first.session.sessionKey, second: second.session.sessionKey };
}

test("one Codex app-server routes two concurrent sessions' approval and input independently", async () => {
  const transport = createRealTransportHost({
    fixturePath: path.join(__dirname, "fixtures", "codex-host-isolation-fake.cjs"),
    serverRequestTimeoutMs: 5000,
  });
  const stores = twoSessions();
  let f;
  try {
    await transport.host.initialize();
    f = await openFixture({ host: transport.host, sessions: stores.sessions, maxActive: 2, sandbox: "read-only" });
    const start = async (sessionKey, operationId) => {
      const ack = await f.coordinator.send({ sessionKey, operationId, prompt: "isolated fixture" });
      await f.coordinator.waitForIdle(ack.run.id);
      return ack.run.id;
    };
    const first = await start(stores.first, "session-one");
    const second = await start(stores.second, "session-two");
    await waitUntil(() => f.coordinator.getRun(first).status === "waiting_approval"
      && f.coordinator.getRun(second).status === "waiting_input", 2000, "two pending requests");
    const approvalId = f.coordinator.getRun(first).waitingRequestId;
    const inputId = f.coordinator.getRun(second).waitingRequestId;
    assert.notEqual(approvalId, inputId);
    assert.notEqual(f.coordinator.getRun(first).runtimeSessionRef?.sessionId, f.coordinator.getRun(second).runtimeSessionRef?.sessionId);
    await assert.rejects(f.coordinator.respondApproval({ operationId: "cross-approval",
      runId: second, requestId: approvalId, choice: "once" }), { code: "WORK_RUN_REQUEST_MISMATCH" });
    await assert.rejects(f.coordinator.respondInput({ operationId: "cross-input",
      runId: first, requestId: inputId, action: "submit", answers: { choice: "wrong" } }),
    { code: "WORK_RUN_REQUEST_MISMATCH" });
    await f.coordinator.respondInput({ operationId: "right-input", runId: second,
      requestId: inputId, action: "submit", answers: { choice: "second-only" } });
    assert.equal(f.coordinator.getRun(first).status, "waiting_approval");
    await f.coordinator.respondApproval({ operationId: "right-approval", runId: first,
      requestId: approvalId, choice: "once" });
    let replies;
    await waitUntil(() => {
      if (!fs.existsSync(transport.responsePath)) return false;
      replies = fs.readFileSync(transport.responsePath, "utf8").split("\n").slice(0, -1).filter(Boolean).map(JSON.parse);
      return replies.length === 2;
    }, 1000, "transport responses");
    assert.deepEqual(replies.map(reply => [reply.id, reply.result]), [
      ["raw-request-2", { action: "accept", content: { choice: "second-only" } }],
      ["raw-request-1", { decision: "accept" }],
    ]);
    assert.equal(f.coordinator.getMemoryStats().pendingRequests, 0);
  } finally {
    if (f) await f.coordinator.close();
    await transport.close();
  }
});

const policy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
const changedPolicy = { approvalPolicy: "never", sandbox: "danger-full-access" };
for (const [runtime, name] of [
  ["codex", "CodexRuntimePool"], ["pi", "PiRuntimePool"],
  ["deepseek-harness", "DeepSeekHarnessRuntimePool"], ["grok-build", "GrokBuildRuntimePool"],
  ["antigravity", "AntigravityRuntimePool"], ["claude-code", "ClaudeCodeRuntimePool"],
]) {
  test(`${runtime}: changed permission policy cannot reuse an existing execution host`, async () => {
    const Pool = require(`../app/agent-service/${runtime}-runtime-pool`)[name];
    const account = DEFAULT_RUNTIME_ACCOUNTS.find(value => value.runtime === runtime);
    const binding = { runtime, runtimeProfileId: "policy-fixture", runtimeAccountId: account.id };
    const homeEnvKey = { codex: "CODEX_HOME", pi: "PI_CODING_AGENT_DIR", "grok-build": "GROK_HOME",
      antigravity: "HOME", "claude-code": "CLAUDE_CONFIG_DIR", "deepseek-harness": "DSH_HOME" }[runtime];
    let created = 0;
    const createdOptions = [];
    const pool = new Pool({ runtimeAccountLookup: () => account,
      runtimeAccountResolver: { resolve: () => Object.freeze({ runtime, runtimeAccountId: account.id,
        home: "/tmp/policy-fixture", binaryPath: process.execPath, launchArgs: Object.freeze([]),
        spawnEnv: Object.freeze({ HOME: "/tmp/policy-fixture", [homeEnvKey]: "/tmp/policy-fixture" }),
        configurationMode: runtime === "codex" ? "overlay"
          : ["antigravity", "deepseek-harness"].includes(runtime) ? "integration" : "native" }) },
      hostFactory(hostOptions) { created += 1; createdOptions.push(hostOptions); return { async initialize() {}, beginAcquire() {},
        async stop() {}, terminated: new Promise(() => {}) }; },
    });
    try {
      const control = runtime === "codex" ? await pool.get(binding) : null;
      const first = await pool.get(binding, { workspace: "/tmp/policy-workspace", permissionPolicy: policy });
      if (runtime === "codex") {
        assert.equal(first, control, "first execution may bind a policy to an existing management host");
        assert.equal(await pool.get(binding), first, "management lookup does not reset the bound policy");
      }
      assert.equal(await pool.get(binding, { workspace: "/tmp/policy-workspace", permissionPolicy: policy }), first);
      await assert.rejects(pool.get(binding, { workspace: "/tmp/policy-workspace",
        permissionPolicy: changedPolicy }), { code: "RUNTIME_PERMISSION_POLICY_CONFLICT" });
      assert.equal(created, 1);
      await pool.stop(binding.runtimeProfileId);
      assert.notEqual(await pool.get(binding, { workspace: "/tmp/policy-workspace",
        permissionPolicy: changedPolicy }), first);
      assert.equal(created, 2);
      if (runtime !== "codex") {
        const firstRun = await pool.get(binding, { workspace: "/tmp/policy-workspace", permissionPolicy: changedPolicy,
          executionContract: { runId: "execution-one" } });
        const secondRun = await pool.get(binding, { workspace: "/tmp/policy-workspace", permissionPolicy: changedPolicy,
          executionContract: { runId: "execution-two" } });
        assert.notEqual(firstRun, secondRun, "a newer run must receive a new host and MCP bridge");
        assert.equal(await pool.get(binding, { workspace: "/tmp/policy-workspace", permissionPolicy: changedPolicy,
          executionContract: { runId: "execution-one" } }), firstRun);
        assert.deepEqual(createdOptions.map(value => value.mcpExecutionRunId), [null, null, "execution-one", "execution-two"]);
      }
    } finally { await pool.stopAll(); }
  });
}
