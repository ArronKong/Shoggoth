"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { RuntimeMcpCallBindings, bindingElicitation, parseBindingElicitation,
  assertTrustedCodexTurn } = require("../app/agent-service/runtime-mcp-call-binding");
const { openFixture, sendAndDrain, PROFILE_ID, RUNTIME_ACCOUNT_ID } = require("./shoggoth-work-run-coordinator-unit.cjs");
const token = crypto.randomBytes(32).toString("base64url");
const input = () => ({ callId: crypto.randomUUID(), name: "mcp_server_call", arguments: { a: 1, z: 2 },
  confirmation: false, sessionToken: token, profileId: PROFILE_ID,
  runtimeProfileId: "runtime-default", runtimeAccountId: RUNTIME_ACCOUNT_ID });
const params = value => ({ ...bindingElicitation(value), serverName: "shoggoth" });

(async () => {
  let now = 1000, live = true;
  const store = new RuntimeMcpCallBindings({ now: () => now, maxPending: 2 });
  const register = (value, runId = "run-one") => store.register({ ...value, runId,
    proof: parseBindingElicitation(params(value)), assertCurrent() { if (!live) throw new Error("revoked"); } });
  const one = input(); register(one);
  for (const change of [{ profileId: "other" }, { runtimeAccountId: "other" }, { runtimeProfileId: "other" },
    { name: "profile_get" }, { arguments: { a: 3 } }, { confirmation: true },
    { sessionToken: crypto.randomBytes(32).toString("base64url") }]) {
    assert.throws(() => store.consume({ ...one, ...change }), { code: "MCP_SESSION_INVALID" });
  }
  assert.equal(store.consume({ ...one, arguments: { z: 2, a: 1 } }).runId, "run-one");
  assert.throws(() => store.consume(one), { code: "MCP_SESSION_INVALID" });
  assert.throws(() => register(one), { code: "MCP_SESSION_INVALID" });
  const turnStore = new RuntimeMcpCallBindings();
  const turnCall = input();
  const codexTurn = { threadId: "thread-owned", turnId: "turn-owned" };
  const addTurn = (call, selectedTurn = codexTurn) => turnStore.register({ ...call,
    proof: parseBindingElicitation(params(call)), runId: "run-owned", codexTurn: selectedTurn,
    assertCurrent() { if (!live) throw new Error("revoked"); } });
  addTurn(turnCall);
  const rotatedTurnCall = { ...turnCall, sessionToken: crypto.randomBytes(32).toString("base64url") };
  assert.throws(() => addTurn(rotatedTurnCall,
    { threadId: codexTurn.threadId, turnId: "another-turn" }),
  { code: "MCP_SESSION_INVALID" }, "auth refresh cannot move the call to another turn");
  addTurn(rotatedTurnCall);
  const turnBound = turnStore.consume(rotatedTurnCall);
  assert.equal(assertTrustedCodexTurn(turnBound, "run-owned").turnId, "turn-owned");
  assert.equal(assertTrustedCodexTurn(turnBound, "run-owned").turnId, "turn-owned",
    "the turn proof can be rechecked while its one-use call is live");
  assert.throws(() => assertTrustedCodexTurn(turnBound, "another-run"),
    { code: "MCP_SESSION_INVALID" });
  assert.throws(() => assertTrustedCodexTurn({ ...turnBound, runId: "another-run" }, "run-owned"),
    { code: "MCP_SESSION_INVALID" }, "the scope Run must match the issued proof");
  assert.throws(() => assertTrustedCodexTurn({ runId: "run-owned", trustedCodexTurn: {
    ...turnBound.trustedCodexTurn } }, "run-owned"),
  { code: "MCP_SESSION_INVALID" }, "a copied or model-supplied thread ID has no authority");
  live = false;
  assert.throws(() => assertTrustedCodexTurn(turnBound, "run-owned"), /revoked/u);
  live = true;
  turnStore.releaseRun("run-owned");
  assert.throws(() => assertTrustedCodexTurn(turnBound, "run-owned"),
    { code: "MCP_SESSION_INVALID" }, "releaseRun removes the brand even while the host is live");
  const clearStore = new RuntimeMcpCallBindings();
  const clearCall = input();
  clearStore.register({ ...clearCall, proof: parseBindingElicitation(params(clearCall)),
    runId: "run-clear", codexTurn, assertCurrent() {} });
  const clearBound = clearStore.consume(clearCall);
  assertTrustedCodexTurn(clearBound, "run-clear");
  clearStore.clear();
  assert.throws(() => assertTrustedCodexTurn(clearBound, "run-clear"),
    { code: "MCP_SESSION_INVALID" }, "clear removes all issued turn brands");
  const expired = input(); register(expired); now += 60_001;
  assert.throws(() => store.consume(expired), { code: "MCP_SESSION_INVALID" });
  const revoked = input(); register(revoked); live = false;
  assert.throws(() => store.consume(revoked), /revoked/u); live = true;
  const completed = input(); register(completed); store.releaseRun("run-one");
  assert.throws(() => store.consume(completed), { code: "MCP_SESSION_INVALID" });
  const first = input(), second = input(); register(first); register(second, "run-two");
  assert.throws(() => register(input()), { code: "MCP_SESSION_INVALID" });
  store.releaseRun("run-one"); assert.equal(store.consume(second).runId, "run-two");
  const refreshing = input(); register(refreshing); now += 30_000;
  const fresh = { ...refreshing, sessionToken: crypto.randomBytes(32).toString("base64url") };
  register(fresh);
  assert.throws(() => store.consume(refreshing), { code: "MCP_SESSION_INVALID" });
  assert.equal(store.consume(fresh).runId, "run-one");
  assert.throws(() => register({ ...fresh, sessionToken: token }), { code: "MCP_SESSION_INVALID" },
    "authentication refresh cannot re-execute a consumed call");
  now += 60_001;
  assert.throws(() => register({ ...fresh, sessionToken: crypto.randomBytes(32).toString("base64url") }),
    { code: "MCP_SESSION_INVALID" }, "consumed call remains fenced beyond proof TTL while its Run is active");
  const noExtension = input(); register(noExtension); now += 30_000;
  const renewed = { ...noExtension, sessionToken: crypto.randomBytes(32).toString("base64url") };
  register(renewed); now += 30_001;
  assert.throws(() => store.consume(renewed), { code: "MCP_SESSION_INVALID" }, "refresh cannot extend original call TTL");
  assert.throws(() => store.register({ ...input(), runId: "run-async", proof: parseBindingElicitation(params(input())),
    assertCurrent: async () => true }), { code: "MCP_SESSION_INVALID" }, "egress fence must be synchronous");
  const full = new RuntimeMcpCallBindings({ now: () => now });
  const addFull = (call, runId = "long-run") => full.register({ ...call, runId,
    proof: parseBindingElicitation(params(call)), assertCurrent() {} });
  const retired = input(); addFull(retired, "retired-run"); full.consume(retired);
  for (let index = 1; index < 4095; index += 1) { const call = input(); addFull(call); full.consume(call); }
  const last = input(), overflow = input(); addFull(last); addFull(overflow);
  full.consume(last);
  assert.throws(() => full.consume(overflow), { code: "MCP_SESSION_INVALID" }, "consumption cannot exceed tombstone cap");
  assert.throws(() => addFull(input()), { code: "MCP_SESSION_INVALID" }, "full used capacity rejects new registration");
  full.releaseRun("retired-run"); assert.equal(full.consume(overflow).runId, "long-run");
  for (const edit of [value => { value.serverName = "third-party"; },
    value => { value._meta["shoggoth/runtime-call-binding"].runId = "forged"; },
    value => { value.requestedSchema.properties.allow = { type: "boolean" }; }]) {
    const forged = params(input()); edit(forged);
    assert.throws(() => parseBindingElicitation(forged), { code: "MCP_SESSION_INVALID" });
  }

  const value = await openFixture();
  let capturedTurn;
  try {
    const { ack } = await sendAndDrain(value);
    const run = value.dispatcher.getRun(ack.run.id);
    const call = input();
    const binding = { ...params(call), threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId };
    for (const change of [{ threadId: "forged" }, { turnId: "forged" }]) {
      await assert.rejects(async () => value.host.request("mcpServer/elicitation/request", { ...binding, ...change }));
    }
    assert.deepEqual(await value.host.request("mcpServer/elicitation/request", binding), { action: "accept", content: {} });
    let executions = 0;
    const result = await value.coordinator.invokeBoundRuntimeMcpCall(call, scope => {
      assert.equal(scope.runId, run.id); scope.assertCurrent();
      capturedTurn = assertTrustedCodexTurn(scope, run.id);
      assert.equal(capturedTurn.threadId, run.runtimeSessionRef.sessionId);
      assert.equal(capturedTurn.turnId, run.runtimeTurnRef.turnId);
      executions += 1; return "matched";
    });
    assert.equal(result, "matched"); assert.equal(executions, 1);
    await assert.rejects(value.coordinator.invokeBoundRuntimeMcpCall(call, () => { executions += 1; }));
    assert.equal(executions, 1);
    assert.equal(value.dispatcher.getRun(run.id).status, "running", "internal binding never opens a user approval card");
    Object.assign(value.host.threads[0].turns[0], { status: "completed" });
    value.host.emit({ known: true, type: "complete", method: "turn/completed",
      threadId: capturedTurn.threadId, turnId: capturedTurn.turnId, status: "completed" });
    await value.coordinator.waitForIdle(run.id);
    assert.throws(() => assertTrustedCodexTurn({ runId: run.id,
      trustedCodexTurn: capturedTurn }, run.id),
      "completed turns cannot authorize later Codex Security work");
  } finally { await value.coordinator.close(); }
  assert.throws(() => assertTrustedCodexTurn({ runId: capturedTurn.runId,
    trustedCodexTurn: capturedTurn }, capturedTurn.runId),
    "Codex turn authority must die with the owning Coordinator");
  console.log("PASS Runtime MCP call binding: exact host/thread/turn, arguments, account, session restart, expiry, capacity and one-use fence");
})().catch(error => { console.error(error); process.exitCode = 1; });
