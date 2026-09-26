#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { openRuntimeLedger } = require("../app/agent-service/runtime-shared-ledger");
const { runtimeFixture, MODEL, POLICY } = require("./deepseek-harness-runtime-unit.cjs");
const { DeepSeekHarnessRuntimeLedger } = require("../app/agent-service/deepseek-harness-runtime-ledger");
const { NATIVE_DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");

test("parallel ledger initialization shares one open and one failure", async () => {
  let opens = 0;
  let finish;
  const slot = { promise: null };
  const first = openRuntimeLedger(slot, () => {
    opens += 1;
    return new Promise(resolve => { finish = resolve; });
  });
  const second = openRuntimeLedger(slot, () => { throw new Error("second opener must not run"); });
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(opens, 1);
  const ledger = { snapshot() {} };
  finish(ledger);
  assert.equal(await first, ledger);
  assert.equal(await second, ledger);
  const failure = { promise: null };
  const failing = openRuntimeLedger(failure, () => { throw new Error("fixture-open-failed"); });
  assert.equal(openRuntimeLedger(failure, () => ledger), failing);
  await assert.rejects(failing, /fixture-open-failed/);
});

test("per-run DSH hosts share one workspace ledger and resume the original session without recovering an active sibling", async () => {
  const f = runtimeFixture();
  const binding = { runtime: "deepseek-harness", runtimeProfileId: "dsh-main",
    runtimeAccountId: NATIVE_DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_ID };
  const get = runId => f.pool.get(binding, { workspace: f.workspace, permissionPolicy: POLICY,
    executionContract: { runId } });
  const originalOpen = DeepSeekHarnessRuntimeLedger.prototype.open;
  let opens = 0;
  DeepSeekHarnessRuntimeLedger.prototype.open = function () { opens += 1; return originalOpen.call(this); };
  try {
    const [first, second] = await Promise.all([get("first-run"), get("second-run")]);
    assert.notEqual(first, second);
    assert.equal(first.ledger, second.ledger);
    assert.equal(opens, 1);
    assert.deepEqual(f.gateCalls.filter(entry => entry[0] === "reserve")
      .map(entry => entry[1].executionRunId), ["first-run", "second-run"]);
    const startSession = (host, source) => host.sessionStart({ source, cwd: f.workspace,
      model: MODEL, permissionPolicy: POLICY });
    const one = (await startSession(first, "first-session")).session.id;
    const two = (await startSession(second, "second-session")).session.id;
    const active = await first.turnStart({ sessionId: one, operationId: "hold-first", prompt: "wait",
      cwd: f.workspace, model: MODEL, permissionPolicy: POLICY });
    const third = await get("third-run");
    assert.equal(third.ledger, first.ledger);
    assert.equal(opens, 1, "new execution process must not run restart recovery against an active sibling");
    assert.equal(third.ledger.snapshot().sessions.find(row => row.id === one).turns[0].status, "inProgress");
    await third.sessionResume({ sessionId: two, cwd: f.workspace, model: MODEL, permissionPolicy: POLICY });
    await third.sessionRename({ sessionId: two, name: "second renamed" });
    const originalRemoteId = first.ledger.snapshot().sessions.find(row => row.id === two).remoteSessionId;
    assert.equal(f.bridgeMessages.findLast(message => message.command === "session/resume").params.remoteSessionId,
      originalRemoteId, "cross-run resume must preserve native conversation identity");
    const persisted = third.ledger.snapshot();
    assert.equal(persisted.sessions.length, 2);
    assert.equal(persisted.sessions.find(row => row.id === one).turns[0].id, active.turn.id);
    assert.equal(persisted.sessions.find(row => row.id === two).title, "second renamed");
  } finally {
    DeepSeekHarnessRuntimeLedger.prototype.open = originalOpen;
    await f.pool.stopAll();
    f.cleanup();
  }
});
