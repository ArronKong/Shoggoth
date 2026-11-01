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

test("revokeGrants aborts every managed action immediately and rejects old replies or any new tool invocation", async () => {
  const issuer = new HostCapabilityIssuer();
  const lease = issuer.issue({ identity, validate: () => true });
  const kinds = ["approval", "input", "mcp", "artifact"], scope = kind => ({ kind, sessionId: "session", turnId: "turn" });
  issuer.bind(lease, { sessionId: "session", turnId: "turn" });
  issuer.consumeReply(lease, "already-consumed", scope("approval"));
  const resume = [], signals = [], aborted = [];
  const pending = kinds.map(kind => issuer.invoke(lease, scope(kind), signal => {
    signals.push(signal); signal.addEventListener("abort", () => aborted.push(kind), { once: true });
    return new Promise(resolve => { resume.push(resolve); });
  }));
  assert.equal(issuer.inspectReply(lease, "unclaimed", scope("approval")).active, true);
  issuer.revokeGrants(lease);
  assert.equal(lease.signal.aborted, true); assert.deepEqual(aborted, kinds);
  assert(signals.every(signal => signal === lease.signal && signal.aborted));
  assert.deepEqual(issuer.assert(lease, { identity, sessionId: "session", turnId: "turn" }), identity,
    "base identity remains available only to reconcile the already assigned execution");
  assert.equal(issuer.activeCount, 1);
  let newActions = 0;
  for (const kind of kinds) {
    assert.throws(() => issuer.assert(lease, scope(kind)), { code: "HOST_CAPABILITY_REVOKED" });
    assert.equal(issuer.inspectReply(lease, "unclaimed", scope(kind)).active, false);
    for (const requestId of ["already-consumed", "unclaimed"])
      assert.throws(() => issuer.consumeReply(lease, requestId, scope(kind)), { code: "HOST_CAPABILITY_REVOKED" });
    await assert.rejects(issuer.invoke(lease, scope(kind), () => { newActions++; }), { code: "HOST_CAPABILITY_REVOKED" });
  }
  assert.equal(newActions, 0);
  const settled = Promise.all(pending.map(promise => assert.rejects(promise, { code: "HOST_CAPABILITY_REVOKED" })));
  resume.forEach(resolve => resolve("late managed result")); await settled;
  issuer.close(); assert.equal(issuer.activeCount, 0);
});

test("revokeGrants is repeatable without reviving grants and full revoke removes even reconciliation identity", () => {
  const issuer = new HostCapabilityIssuer(), lease = issuer.issue({ identity, validate: () => true });
  issuer.bind(lease, { sessionId: "session", turnId: "turn" });
  let aborts = 0; lease.signal.addEventListener("abort", () => { aborts++; });
  issuer.revokeGrants(lease); issuer.revokeGrants(lease); assert.equal(aborts, 1);
  issuer.bind(lease, { sessionId: "session", turnId: "turn" });
  assert.deepEqual(issuer.assert(lease, { sessionId: "session", turnId: "turn" }), identity);
  for (const scope of [{ sessionId: "other" }, { turnId: "other" }, { identity: { attemptId: "other" } }])
    assert.throws(() => issuer.assert(lease, scope), { code: "HOST_CAPABILITY_REVOKED" });
  assert.throws(() => issuer.bind(lease, { sessionId: "session", turnId: "other" }), { code: "HOST_CAPABILITY_REVOKED" });
  assert.throws(() => issuer.assert(JSON.parse(JSON.stringify(lease))), { code: "HOST_CAPABILITY_REVOKED" });
  assert.equal(issuer.revoke(lease), true); assert.equal(issuer.revoke(lease), false);
  assert.throws(() => issuer.assert(lease), { code: "HOST_CAPABILITY_REVOKED" });
  assert.throws(() => issuer.revokeGrants(lease), { code: "HOST_CAPABILITY_REVOKED" });
  assert.equal(aborts, 1); assert.equal(issuer.activeCount, 0);
  issuer.close(); issuer.close();
});

test("revokeGrants retains account validation and external abort fences while native sibling leases stay independent", () => {
  const external = new AbortController(), issuer = new HostCapabilityIssuer(); let current = true;
  const lease = issuer.issue({ identity, validate: () => current, signal: external.signal });
  const sibling = issuer.issue({ identity: { ...identity, runtime: "codex", runId: "native-sibling" }, validate: () => true });
  issuer.revokeGrants(lease); assert.equal(issuer.activeCount, 2);
  issuer.assert(sibling, { kind: "mcp" }); assert.equal(sibling.signal.aborted, false);
  current = false;
  assert.throws(() => issuer.assert(lease), { code: "HOST_CAPABILITY_REVOKED" });
  assert.equal(issuer.activeCount, 1); issuer.assert(sibling, { kind: "approval" });
  const aborted = issuer.issue({ identity: { ...identity, runId: "external-cancel" }, validate: () => true, signal: external.signal });
  issuer.revokeGrants(aborted); external.abort();
  assert.throws(() => issuer.assert(aborted), { code: "HOST_CAPABILITY_REVOKED" });
  assert.equal(issuer.activeCount, 1); issuer.close();
  assert.equal(sibling.signal.aborted, true); assert.equal(issuer.activeCount, 0);
});

test("revokeGrants does not extend expiry and existing native revokeWhere or close fully remove canceled leases", () => {
  let now = 0; const issuer = new HostCapabilityIssuer({ now: () => now });
  const lease = issuer.issue({ identity, validate: () => true, expiresAt: 10 });
  issuer.bind(lease, { sessionId: "session", turnId: "turn" }); issuer.revokeGrants(lease);
  assert.deepEqual(issuer.inspectReply(lease, "request", { kind: "input", sessionId: "session", turnId: "turn" }), { active: false, expiresAt: 10 });
  now = 10;
  assert.throws(() => issuer.assert(lease), { code: "HOST_CAPABILITY_REVOKED" }); assert.equal(issuer.activeCount, 0);
  const canceled = issuer.issue({ identity, validate: () => true, expiresAt: 100 });
  const sibling = issuer.issue({ identity: { ...identity, runId: "native-still-live" }, validate: () => true, expiresAt: 100 });
  issuer.revokeGrants(canceled); issuer.revokeWhere(value => value.runId === identity.runId);
  assert.throws(() => issuer.assert(canceled), { code: "HOST_CAPABILITY_REVOKED" });
  issuer.assert(sibling, { kind: "artifact" }); assert.equal(issuer.activeCount, 1);
  issuer.close(); assert.throws(() => issuer.assert(sibling), { code: "HOST_CAPABILITY_REVOKED" });
  assert.equal(issuer.activeCount, 0);
});
