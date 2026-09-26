"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { HostCapabilityIssuer } = require("../app/agent-service/host-capability-issuer");
const identity = { runId: "run", profileId: "profile", bindingId: "binding", runtime: "pi", runtimeAccountId: "account", attemptId: "attempt" };
test("leases reject serialization, other runs, stale replies, expiry and independent shared-host revocation", () => {
  let now = 0;
  const issuer = new HostCapabilityIssuer({ now: () => now });
  const lease = issuer.issue({ identity, validate: () => true, expiresAt: 10 });
  const sibling = issuer.issue({ identity: { ...identity, runId: "sibling" }, validate: () => true });
  issuer.bind(lease, { sessionId: "session", turnId: "turn" });
  assert.throws(() => issuer.assert(JSON.parse(JSON.stringify(lease))));
  assert.throws(() => issuer.assert(lease, { identity: { runId: "other" } }));
  assert.throws(() => issuer.assert(lease, { sessionId: "other-session" }));
  issuer.consumeReply(lease, "reply", { kind: "approval", turnId: "turn" });
  assert.throws(() => issuer.consumeReply(lease, "reply", { kind: "approval" }));
  now = 11;
  assert.throws(() => issuer.assert(lease));
  assert.equal(lease.signal.aborted, true);
  issuer.assert(sibling);
  assert.equal(issuer.activeCount, 1);
  issuer.close(); assert.equal(sibling.signal.aborted, true);
});
test("account changes during an asynchronous call invalidate the result; no grants are inherited by tool-free work", async () => {
  let current = true, resume;
  const issuer = new HostCapabilityIssuer();
  const lease = issuer.issue({ identity, validate: () => current });
  const pending = issuer.invoke(lease, { kind: "mcp" }, () => new Promise(resolve => { resume = resolve; }));
  current = false; resume("late result");
  await assert.rejects(pending, { code: "HOST_CAPABILITY_REVOKED" });
  const model = issuer.issue({ identity, validate: () => true, grants: [] });
  assert.throws(() => issuer.assert(model, { kind: "mcp" }));
  issuer.close();
});

test("extension reverse MCP calls are bound to the exact live turn and cannot commit after policy revocation", async () => {
  const { openFixture, sendAndDrain, FakeHost, directRuntimeManager } = require("./shoggoth-work-run-coordinator-unit.cjs");
  const host = new FakeHost([]); let revision = "one", release, effects = 0;
  const fixture = await openFixture({ runtime: "ext-fixture", host,
    runtimeManager: directRuntimeManager(host, "ext-fixture"), getCapabilityPolicyRevision: () => revision,
    onRuntimeMcpRequest: async (_profile, _request, scope) => {
      await new Promise(resolve => { release = resolve; }); scope.assertCurrent(); effects++; return { content: [] };
    } });
  try {
    const { ack } = await sendAndDrain(fixture);
    const run = fixture.dispatcher.getRun(ack.run.id); assert.equal(run.status, "running");
    const handler = host.serverRequestHandlers.get("shoggoth/mcp.call"); assert.equal(typeof handler, "function");
    const params = { sessionId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId,
      callId: require("node:crypto").randomUUID(), name: "artifact_publish", arguments: {} };
    assert.throws(() => handler({ ...params, turnId: "other-turn" }), { code: "WORK_RUN_REQUEST_UNROUTABLE" });
    const pending = handler(params); assert.equal(typeof release, "function"); revision = "two"; release();
    await assert.rejects(pending, { code: "HOST_CAPABILITY_REVOKED" }); assert.equal(effects, 0);
    assert.throws(() => handler(params), { code: "HOST_CAPABILITY_REVOKED" });
  } finally { await fixture.coordinator.close(); }
});
