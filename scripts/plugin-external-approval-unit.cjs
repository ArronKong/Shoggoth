"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { ExternalPluginApprovalBroker } = require("../app/agent-service/external-plugin-approval-broker");
const { validateExternalPluginApprovalResult } = require("../app/core/plugin-external-approval-dto");
const { escapeInvisibleJsonCharacters } = require("../app/core/plugin-approval-display");

async function main() {
  const invisibleCommand = JSON.stringify({ value: `left\u202eright\u0085\u2066\u2028${String.fromCodePoint(0xe0001)}` });
  const commandDigest = crypto.createHash("sha256").update(invisibleCommand).digest("hex");
  const visibleCommand = escapeInvisibleJsonCharacters(invisibleCommand);
  assert(visibleCommand.includes("left\\u202eright\\u0085\\u2066\\u2028\\udb40\\udc01"));
  assert(!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(visibleCommand));
  assert.deepEqual(JSON.parse(visibleCommand), JSON.parse(invisibleCommand));
  assert.equal(JSON.parse(invisibleCommand).value,
    `left\u202eright\u0085\u2066\u2028${String.fromCodePoint(0xe0001)}`);
  assert.equal(crypto.createHash("sha256").update(invisibleCommand).digest("hex"), commandDigest);

  let now = 1_000;
  let nextTimer = 0;
  const timers = new Map();
  const broker = new ExternalPluginApprovalBroker({ now: () => now, timeoutMs: 1_000,
    setTimer(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, due: now + delay }); return id; },
    clearTimer(id) { timers.delete(id); } });
  const token = Buffer.alloc(32, 1).toString("base64url");
  const base = { backendId: "openclaw", instanceId: "host-a", agentId: "agent-a",
    sessionId: "session-a", runId: "run-a", toolCallId: "call-a" };
  const pending = (identity, value, controller = new AbortController(), assertCurrent = () => {}) => {
    const promise = broker.request({ token, identity, callId: `external-${identity.toolCallId}`,
      bindingId: "binding-a", connectionId: "connection-a", connectionAuthRevision: 2,
      packageName: "Project assistant", toolName: "write", arguments: { value },
      signal: controller.signal, assertCurrent });
    promise.catch(() => {});
    return { promise, controller };
  };
  const first = pending(base, "one");
  const second = pending({ ...base, toolCallId: "call-b" }, "two");
  const hermes = pending({ backendId: "hermes", instanceId: "host-b", agentId: "agent-b",
    sessionId: "session-b", taskId: "task-b", turnId: "turn-b", toolCallId: "call-c" }, "three");
  const listed = validateExternalPluginApprovalResult("plugins.external.approvals.list", broker.list());
  const listedTail = validateExternalPluginApprovalResult("plugins.external.approvals.list",
    broker.list({ cursor: listed.nextCursor }));
  assert.equal(listed.items.length, 2);
  assert.deepEqual([...listed.items, ...listedTail.items].map(row => JSON.parse(row.command).value),
    ["one", "two", "three"]);
  assert.deepEqual(broker.list({ backendId: "hermes" }).items.map(row => row.toolCallId), ["call-c"]);
  assert(!JSON.stringify(listed).includes(token));
  const [a, b, c] = [...listed.items, ...listedTail.items].map(row => row.requestId);
  const preparedA = validateExternalPluginApprovalResult("plugins.external.approvals.prepare",
    broker.prepare({ requestId: a, operationId: "approve-a", decision: "once" }));
  assert.deepEqual(JSON.parse(preparedA.summary.command), { value: "one" });
  assert.equal(preparedA.summary.sessionId, "session-a");
  assert.throws(() => broker.commit({ challenge: "forged", approved: true }),
    error => error.code === "PLUGIN_REQUEST_INVALID");
  assert.throws(() => broker.prepare({ requestId: b, operationId: "approve-a", decision: "once" }),
    error => error.code === "PLUGIN_REQUEST_INVALID");
  const preparedB = broker.prepare({ requestId: b, operationId: "deny-b", decision: "deny" });
  assert.throws(() => broker.commit({ challenge: preparedB.challenge, approved: true }),
    error => error.code === "PLUGIN_REQUEST_INVALID");
  broker.commit({ challenge: preparedB.challenge, approved: false });
  assert.deepEqual(await second.promise, { approved: false, requestId: b,
    argumentDigest: listed.items[1].argumentDigest });
  broker.commit({ challenge: preparedA.challenge, approved: true });
  assert.deepEqual(await first.promise, { approved: true, requestId: a,
    argumentDigest: listed.items[0].argumentDigest });
  assert.throws(() => broker.commit({ challenge: preparedA.challenge, approved: false }),
    error => error.code === "PLUGIN_REQUEST_INVALID");
  assert.deepEqual(broker.prepare({ requestId: a, operationId: "approve-a", decision: "once" }),
    { completed: true, approved: true, challenge: null, summary: null });
  assert.throws(() => broker.prepare({ requestId: a, operationId: "approve-a", decision: "deny" }),
    error => error.code === "PLUGIN_REQUEST_INVALID");
  assert.equal(broker.list().items[0].requestId, c, "other host remains independent");
  hermes.controller.abort();
  await assert.rejects(hermes.promise, error => error.code === "CAPABILITY_FORBIDDEN"
    && error.approvalOutcome === "withdrawn" && error.approvalRequestId === c);
  assert.equal(broker.list().items.length, 0);

  const expiring = pending({ ...base, toolCallId: "call-expire" }, "expired");
  const expiryId = broker.list().items[0].requestId;
  now += 1_001;
  for (const timer of [...timers.values()]) if (timer.due <= now) timer.callback();
  await assert.rejects(expiring.promise, error => error.code === "CAPABILITY_FORBIDDEN"
    && error.approvalOutcome === "expired" && error.approvalRequestId === expiryId);
  assert.throws(() => broker.prepare({ requestId: expiryId, operationId: "late", decision: "once" }),
    error => error.code === "PLUGIN_REQUEST_INVALID");
  assert.throws(() => broker.commit({ challenge: preparedB.challenge, approved: true }),
    error => error.code === "PLUGIN_REQUEST_INVALID", "completed denial cannot flip on retry");

  const expiringPrepared = pending({ ...base, toolCallId: "call-prepare-expire" }, "expire-after-prepare");
  const expiringId = broker.list().items[0].requestId;
  const expiringChallenge = broker.prepare({ requestId: expiringId,
    operationId: "expire-after-prepare", decision: "once" }).challenge;
  now += 1_001;
  for (const timer of [...timers.values()]) if (timer.due <= now) timer.callback();
  await assert.rejects(expiringPrepared.promise, error => error.code === "CAPABILITY_FORBIDDEN");
  assert.throws(() => broker.commit({ challenge: expiringChallenge, approved: true }),
    error => error.code === "PLUGIN_REQUEST_INVALID", "expired challenge cannot approve");

  let current = true;
  const stale = pending({ ...base, toolCallId: "call-stale" }, "stale", new AbortController(),
    () => { if (!current) throw Object.assign(new Error("revoked"), { code: "GRANT_REVOKED" }); });
  const staleId = broker.list().items[0].requestId;
  const stalePrepared = broker.prepare({ requestId: staleId, operationId: "stale-op", decision: "once" });
  current = false;
  assert.throws(() => broker.commit({ challenge: stalePrepared.challenge, approved: true }),
    error => error.code === "GRANT_REVOKED");
  await assert.rejects(stale.promise, error => error.code === "GRANT_REVOKED");

  const restarting = pending({ ...base, toolCallId: "call-restart" }, "restart");
  broker.clear();
  await assert.rejects(restarting.promise, error => error.code === "CAPABILITY_FORBIDDEN"
    && error.approvalOutcome === "withdrawn");
  assert.deepEqual(broker.list(), { items: [], nextCursor: null });

  const large = Array.from({ length: 6 }, (_, index) => pending({ ...base,
    toolCallId: `call-large-${index}` }, "x".repeat(11_000)));
  const page = broker.list();
  assert.equal(page.items.length, 2);
  assert(Buffer.byteLength(JSON.stringify(page), "utf8") < 48 * 1024);
  assert(page.nextCursor);
  const secondPage = broker.list({ cursor: page.nextCursor });
  assert.equal(secondPage.items.length, 2);
  assert(Buffer.byteLength(JSON.stringify(secondPage), "utf8") < 48 * 1024);
  large[0].controller.abort();
  await assert.rejects(large[0].promise, error => error.code === "CAPABILITY_FORBIDDEN");
  assert.throws(() => broker.list({ cursor: secondPage.nextCursor }),
    error => error.code === "CATALOG_REVISION_CHANGED");
  broker.clear();
  await Promise.all(large.slice(1).map(row => assert.rejects(row.promise,
    error => error.code === "CAPABILITY_FORBIDDEN")));
  const durableBroker = new ExternalPluginApprovalBroker();
  const requestInput = { token, identity: { ...base, toolCallId: "durable" },
    callId: "external-durable", bindingId: "binding-a", connectionId: "connection-a",
    connectionAuthRevision: 2, packageName: "Project assistant", toolName: "write",
    arguments: { value: "secret-argument" }, signal: new AbortController().signal,
    assertCurrent: () => {} };
  let delivered = false;
  const committed = [];
  const durablePromise = durableBroker.request({ ...requestInput,
    recordDecision(callId, requestId, outcome) {
      assert.equal(delivered, false, "decision must persist before the awaiting tool service resumes");
      committed.push({ callId, requestId, outcome });
    } });
  durablePromise.then(() => { delivered = true; });
  const durableRequest = durableBroker.list().items[0].requestId;
  const durableChallenge = durableBroker.prepare({ requestId: durableRequest,
    operationId: "durable-op", decision: "once" }).challenge;
  durableBroker.commit({ challenge: durableChallenge, approved: true });
  assert.deepEqual(committed, [{ callId: "external-durable", requestId: durableRequest,
    outcome: "approved" }]);
  await durablePromise;
  assert.equal(delivered, true);

  const unavailable = durableBroker.request({ ...requestInput,
    identity: { ...base, toolCallId: "journal-failure" }, callId: "external-journal-failure",
    recordDecision() { throw new Error("journal unavailable"); } });
  unavailable.catch(() => {});
  const unavailableRequest = durableBroker.list().items[0].requestId;
  const unavailableChallenge = durableBroker.prepare({ requestId: unavailableRequest,
    operationId: "unavailable-op", decision: "once" }).challenge;
  assert.throws(() => durableBroker.commit({ challenge: unavailableChallenge, approved: true }),
    error => error.code === "EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE");
  await assert.rejects(unavailable, error => error.code === "EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE"
    && error.approvalJournalUnavailable === true);
  assert.throws(() => durableBroker.prepare({ requestId: unavailableRequest,
    operationId: "unavailable-op", decision: "once" }),
  error => error.code === "PLUGIN_REQUEST_INVALID", "failed journal write must not cache approval");
  console.log("plugin-external-approval-unit: exact identity, args, native challenge, concurrent calls, denial, cancel, expiry, revocation and restart passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
