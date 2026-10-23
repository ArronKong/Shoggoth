#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { openFixture, sendAndDrain, FakeHost, directRuntimeManager } = require("./shoggoth-work-run-coordinator-unit.cjs");

const HOSTS = [
  ["grok-build", "GrokBuildRuntimeHost"],
  ["antigravity-acp", "AntigravityAcpRuntimeHost"],
  ["deepseek-harness", "DeepSeekHarnessRuntimeHost"],
  ["pi", "PiRuntimeHost"],
  ["claude-code", "ClaudeCodeRuntimeHost"],
  ["opencode", "OpenCodeRuntimeHost"],
];

// Exercise the public read method and real projection without launching a CLI.
// The transport must never be used to inspect an already committed terminal.
function catalogFixture(name, className) {
  const Host = require(`../app/agent-service/${name}-runtime-host`)[className];
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-terminal-catalog-")));
  const host = name === "opencode" ? new Host({
    paths: { stateDir: path.join(root, "state"), trustedRoot: root },
    runtimeBinding: { runtime: "opencode", runtimeProfileId: "profile-a", runtimeAccountId: "account-a" },
    runtimeEnvironment: Object.freeze({ runtime: "opencode", runtimeAccountId: "account-a", home: root,
      binaryPath: "/bin/true", configurationMode: "native", configSourceHome: root,
      launchArgs: Object.freeze([]), spawnEnv: Object.freeze({ HOME: root, XDG_DATA_HOME: root }) }),
    workspace: root, permissionPolicy: { approvalPolicy: "on-request", sandbox: "danger-full-access" },
  }) : Object.create(Host.prototype);
  const session = { id: "session-a", source: "chat:terminal", cwd: root,
    title: "terminal", archived: false, createdAt: 1, updatedAt: 2,
    turns: [{ id: "turn-a", operationId: "operation-a", acceptance: "accepted", status: "interrupted",
      errorCode: "RUNTIME_PROTOCOL_ERROR", assistantMessages: [], executionEndedAt: 2 }] };
  host.state = "failed";
  host.ledger = { snapshot: () => ({ sessions: [structuredClone(session)] }) };
  host.activeTurns = new Map();
  host.client = { request: () => assert.fail("terminal read must not contact native server") };
  host.rpc = null;
  return { host, session, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

for (const [name, className] of HOSTS) {
  test(`${name}: committed terminal remains readable after failure and shutdown`, async () => {
    const fixture = catalogFixture(name, className);
    try {
      for (const state of ["failed", "stopping", "stopped"]) {
        fixture.host.state = state;
        const { session } = await fixture.host.sessionRead({ sessionId: "session-a", includeTurns: true });
        assert.equal(session.id, "session-a");
        assert.equal(session.turns[0].status, "interrupted");
        assert.equal(session.turns[0].errorCode, "RUNTIME_PROTOCOL_ERROR");
        assert.equal(session.turns[0].itemsView, "full");
        assert.deepEqual(session.turns[0].items, [{ type: "userMessage", clientId: "operation-a" }]);
      }
      fixture.session.turns[0].status = "completed";
      fixture.session.turns[0].errorCode = null;
      fixture.session.turns[0].assistantMessages = [{ id: "answer-a", text: "committed answer" }];
      assert.equal((await fixture.host.sessionRead({ sessionId: "session-a", includeTurns: true }))
        .session.turns[0].items[1].text, "committed answer");
    } finally { fixture.cleanup(); }
  });

  test(`${name}: offline reads cannot resolve missing, active, unknown or uncommitted work`, async () => {
    const fixture = catalogFixture(name, className);
    const read = () => fixture.host.sessionRead({ sessionId: "session-a", includeTurns: true });
    try {
      await assert.rejects(async () => fixture.host.sessionRead({ sessionId: "another-session", includeTurns: true }));
      for (const patch of [
        { acceptance: "accepted", status: "inProgress", errorCode: null },
        { acceptance: "unknown", status: "interrupted", errorCode: null },
        { acceptance: "accepted", status: "failed", errorCode: "RUNTIME_TURN_OUTCOME_UNKNOWN" },
      ]) {
        Object.assign(fixture.session.turns[0], patch);
        await assert.rejects(async () => read());
      }
      fixture.host.ledger.snapshot = () => { throw Object.assign(new Error("commit uncertain"), { code: "STORE_COMMIT_UNCERTAIN" }); };
      await assert.rejects(async () => read());
    } finally { fixture.cleanup(); }
  });
}

const RUNTIME_ERRORS = [
  ["grok-build", "GROK_ACP_UNKNOWN_RESPONSE_ID"],
  ["antigravity", "ANTIGRAVITY_ACP_UNKNOWN_RESPONSE_ID"],
  ["codex", "RPC_DUPLICATE_RESPONSE"],
  ["codex", "RPC_UNKNOWN_RESPONSE_ID"],
  ["codex", "RPC_INVALID_RESPONSE_ID"],
  ["deepseek", "DEEPSEEK_HARNESS_RESPONSE_INVALID"],
  ["pi", "PI_RPC_RESPONSE_INVALID"],
  ["claude-code", "CLAUDE_CODE_STREAM_EVENT_INVALID"],
  ["claude-code", "CLAUDE_CODE_STREAM_SEQUENCE_INVALID"],
  ["opencode", "RUNTIME_PROTOCOL_ERROR"],
];

for (const [runtime, cause] of RUNTIME_ERRORS) {
  for (const unavailable of [false, true]) {
    test(`${runtime}: ${unavailable ? "transport failure during reconciliation" : "durable failure"} preserves ${cause}`, async () => {
      const host = new FakeHost([], { accountReadSupported: false,
        authenticationStateResult: { authenticated: true, credentialPresent: true } });
      const value = await openFixture({ runtime, host, runtimeManager: directRuntimeManager(host, runtime),
        terminalRetryDelaysMs: [0] });
      try {
        const { ack } = await sendAndDrain(value, { operationId: `terminal-${runtime}` });
        const run = value.coordinator.getRun(ack.run.id);
        assert.equal(run.status, "running");
        const turn = host.threads.find(t => t.id === run.runtimeSessionRef.sessionId).turns
          .find(t => t.id === run.runtimeTurnRef.turnId);
        turn.status = "interrupted";
        turn.errorCode = cause;
        if (unavailable) host.threadRead = async () => { throw Object.assign(new Error("unavailable"), { code: "RUNTIME_HOST_TERMINATED" }); };
        host.emit({ known: true, type: "complete", method: "fixture/error", status: "interrupted",
          threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId });
        if (unavailable) host.terminate(Object.assign(new Error("private diagnostic must not escape"), { code: cause }));
        const result = await value.coordinator.waitForIdle(run.id);
        assert.equal(result.status, "interrupted");
        assert.equal(result.errorCode, "RUNTIME_PROTOCOL_ERROR");
        assert.equal(result.resultSummary, null);
        assert.equal(host.turnStartCalls, 1, "must never replay the original operation");
      } finally { await value.coordinator.close(); }
    });
  }
}

test("canonical terminal wins over a later transport error and is published once", async () => {
  const value = await openFixture({ terminalRetryDelaysMs: [0] });
  try {
    const { ack } = await sendAndDrain(value, { operationId: "terminal-before-exit" });
    const run = value.coordinator.getRun(ack.run.id);
    const turn = value.host.threads.find(t => t.id === run.runtimeSessionRef.sessionId).turns
      .find(t => t.id === run.runtimeTurnRef.turnId);
    turn.status = "completed";
    turn.items.push({ type: "agentMessage", text: "durable answer", phase: "final_answer" });
    const event = { known: true, type: "complete", method: "turn/completed", status: "completed",
      threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId };
    value.host.emit(event);
    value.host.emit(event);
    value.host.terminate(Object.assign(new Error("connection closed"), { code: "RPC_UNKNOWN_RESPONSE_ID" }));
    const terminal = await value.coordinator.waitForIdle(run.id);
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.resultSummary, "durable answer");
    assert.equal(terminal.errorCode, null);
    const replay = value.coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, () => {});
    assert.equal(replay.events.filter(item => item.type === "terminal").length, 1);
    replay.unsubscribe();
    assert.equal(value.host.turnStartCalls, 1);
  } finally { await value.coordinator.close(); }
});

test("another host cannot supply a terminal failure cause for an active run", async () => {
  const value = await openFixture({ terminalRetryDelaysMs: [0] });
  try {
    const { ack } = await sendAndDrain(value, { operationId: "terminal-foreign-host" });
    const run = value.coordinator.getRun(ack.run.id);
    value.host.threadRead = async () => { throw new Error("unavailable history"); };
    const other = new FakeHost([]);
    other.terminate(Object.assign(new Error("foreign failure"), { code: "RPC_UNKNOWN_RESPONSE_ID" }));
    value.host.emit({ known: true, type: "complete", method: "fixture/error", status: "completed",
      threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId });
    const terminal = await value.coordinator.waitForIdle(run.id);
    assert.equal(terminal.status, "interrupted");
    assert.equal(terminal.errorCode, "CODEX_TERMINAL_RECONCILIATION_FAILED");
    assert.equal(value.host.turnStartCalls, 1);
  } finally { await value.coordinator.close(); }
});
