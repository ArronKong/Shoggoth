"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { AppleDeviceApprovalBroker } = require("../app/agent-service/apple-device-approval-broker");

const identity = { backendId: "openclaw", agentId: "agent-1", profileId: "external:openclaw:agent-1", sessionId: "session-1", runId: "run-1", callId: "call-1" };
const args = { title: "Approve this exact event", start: "2026-10-27T06:00:00.000Z", end: "2026-10-27T07:00:00.000Z" };
const coded = code => error => error.code === code;
function request(broker, overrides = {}) {
  const controller = new AbortController();
  let current = true;
  const promise = broker.request({ identity: { ...identity }, name: "apple_calendar_create", arguments: structuredClone(args), reason: "Create this calendar event",
    assertCurrent() { if (!current) throw Object.assign(new Error("revoked"), { code: "APPLE_DEVICE_ACCESS_REVOKED" }); }, signal: controller.signal, ...overrides });
  promise.catch(() => {}); // Cleanup cancellation stays handled after a failed assertion.
  return { promise, controller, revoke() { current = false; } };
}
function card(broker) { const result = broker.list(); assert.equal(result.items.length, 1); return result.items[0]; }

test("device approval binds exact identity, generation, tool and full argument digest", async () => {
  let waits = 0, leaves = 0;
  const broker = new AppleDeviceApprovalBroker({ generation: 7, onWaiting() { waits++; return () => { leaves++; }; } });
  try {
    const pending = request(broker);
    const details = card(broker);
    assert.equal(details.backendId, identity.backendId); assert.equal(details.agentId, identity.agentId); assert.equal(details.sessionId, identity.sessionId);
    assert.equal(details.toolName, "apple_calendar_create"); assert.equal(details.serverId, "apple-calendar");
    assert.deepEqual(JSON.parse(details.argumentsPreview), args);
    assert.equal(details.argumentDigest, crypto.createHash("sha256").update(JSON.stringify([7, identity, "apple_calendar_create", args, null])).digest("hex"));
    assert.throws(() => broker.resolve({ requestId: details.requestId, argumentDigest: "0".repeat(64), approved: true }), coded("APPLE_DEVICE_APPROVAL_INVALID"));
    assert.throws(() => broker.resolve({ requestId: "apple-device-unknown", argumentDigest: details.argumentDigest, approved: true }), coded("APPLE_DEVICE_APPROVAL_INVALID"));
    assert.equal(broker.list().items.length, 1);
    assert.deepEqual(broker.resolve({ requestId: details.requestId, argumentDigest: details.argumentDigest, approved: true }), { resolved: true, approved: true });
    assert.deepEqual(await pending.promise, { approved: true });
    assert.equal(waits, 1); assert.equal(leaves, 1); assert.deepEqual(broker.list().items, []);
    assert.throws(() => broker.resolve({ requestId: details.requestId, argumentDigest: details.argumentDigest, approved: true }), coded("APPLE_DEVICE_APPROVAL_INVALID"));
  } finally { broker.close(); }
});

test("identity changes produce different approval bindings and invalid identities never create cards", async () => {
  const broker = new AppleDeviceApprovalBroker();
  try {
    const baseline = request(broker); const baselineCard = card(broker); const baselineDenied = assert.rejects(baseline.promise, coded("APPLE_DEVICE_APPROVAL_DENIED"));
    broker.resolve({ requestId: baselineCard.requestId, argumentDigest: baselineCard.argumentDigest, approved: false }); await baselineDenied;
    for (const field of ["agentId", "profileId", "sessionId", "runId", "callId"]) {
      const pending = request(broker, { identity: { ...identity, [field]: `${identity[field]}-other` } });
      const details = card(broker); assert.notEqual(details.argumentDigest, baselineCard.argumentDigest);
      const cancelled = assert.rejects(pending.promise, coded("APPLE_DEVICE_CANCELLED")); pending.controller.abort(); await cancelled;
    }
    for (const changed of [{ ...identity, backendId: "model-supplied" }, { ...identity, profileId: "" }, { ...identity, sessionId: "bad\nidentity" }, { ...identity, callId: null }])
      assert.throws(() => request(broker, { identity: changed }), coded("APPLE_DEVICE_APPROVAL_UNAVAILABLE"));
    assert.deepEqual(broker.list().items, []);
  } finally { broker.close(); }
});

test("model confirmation flags cannot approve a device call or replace the digest", async () => {
  const broker = new AppleDeviceApprovalBroker();
  try {
    const pending = request(broker, { approved: true, confirmed: true, userApproved: true });
    let settled = false; pending.promise.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false);
    const details = card(broker);
    for (const approval of [true, "true", 1]) {
      assert.throws(() => broker.resolve({ requestId: details.requestId, approved: approval }), coded("APPLE_DEVICE_APPROVAL_INVALID"));
    }
    assert.equal(settled, false);
    const denied = assert.rejects(pending.promise, coded("APPLE_DEVICE_APPROVAL_DENIED"));
    broker.resolve({ requestId: details.requestId, argumentDigest: details.argumentDigest, approved: false }); await denied;
    assert.deepEqual(broker.list().items, []);
  } finally { broker.close(); }
});

test("write approval includes and binds the current target preview", async () => {
  const broker = new AppleDeviceApprovalBroker({ generation: 3 });
  const target = { id: "event:fixture", title: "Existing appointment", revision: "a".repeat(64), recurring: true };
  try {
    const pending = request(broker, { reviewOnly: target }); const details = card(broker);
    assert.deepEqual(JSON.parse(details.argumentsPreview), { target, arguments: args });
    assert.equal(details.argumentDigest, crypto.createHash("sha256").update(JSON.stringify([3, identity, "apple_calendar_create", args, target])).digest("hex"));
    const missingTargetDigest = crypto.createHash("sha256").update(JSON.stringify([3, identity, "apple_calendar_create", args, null])).digest("hex");
    assert.throws(() => broker.resolve({ requestId: details.requestId, argumentDigest: missingTargetDigest, approved: true }), coded("APPLE_DEVICE_APPROVAL_INVALID"));
    const canceled = assert.rejects(pending.promise, coded("APPLE_DEVICE_CANCELLED")); pending.controller.abort(); await canceled;
  } finally { broker.close(); }
});

test("denial, cancellation and expiry settle once and release waiting state", async () => {
  let now = 1000, leaves = 0;
  const broker = new AppleDeviceApprovalBroker({ now: () => now, timeoutMs: 5000, onWaiting: () => () => { leaves++; } });
  try {
    const denied = request(broker); const details = card(broker);
    const denial = assert.rejects(denied.promise, coded("APPLE_DEVICE_APPROVAL_DENIED"));
    broker.resolve({ requestId: details.requestId, argumentDigest: details.argumentDigest, approved: false }); await denial;
    const canceled = request(broker); const cancellation = assert.rejects(canceled.promise, coded("APPLE_DEVICE_CANCELLED"));
    canceled.controller.abort(); await cancellation; canceled.controller.abort();
    const expired = request(broker); const expiredCard = card(broker); const expiration = assert.rejects(expired.promise, coded("APPLE_DEVICE_APPROVAL_EXPIRED"));
    now = expiredCard.expiresAt;
    assert.throws(() => broker.resolve({ requestId: expiredCard.requestId, argumentDigest: expiredCard.argumentDigest, approved: true }), coded("APPLE_DEVICE_APPROVAL_INVALID"));
    assert.deepEqual(broker.list().items, []); await expiration;
    assert.equal(leaves, 3);
  } finally { broker.close(); }
});

test("revoked policy and replaced generation invalidate already displayed approvals", async () => {
  const broker = new AppleDeviceApprovalBroker();
  try {
    const revoked = request(broker); const details = card(broker); const cancellation = assert.rejects(revoked.promise, coded("APPLE_DEVICE_CANCELLED"));
    revoked.revoke();
    assert.throws(() => broker.resolve({ requestId: details.requestId, argumentDigest: details.argumentDigest, approved: true }), coded("APPLE_DEVICE_APPROVAL_INVALID"));
    await cancellation; assert.deepEqual(broker.list().items, []);
    const listRevoked = request(broker); const listCancellation = assert.rejects(listRevoked.promise, coded("APPLE_DEVICE_CANCELLED"));
    listRevoked.revoke(); assert.deepEqual(broker.list().items, []); await listCancellation;
    const old = request(broker); const oldCard = card(broker); const closed = assert.rejects(old.promise, coded("APPLE_DEVICE_CANCELLED"));
    broker.open(2); await closed;
    const current = request(broker); const currentCard = card(broker);
    assert.notEqual(currentCard.argumentDigest, oldCard.argumentDigest); assert.equal(broker.list().generation, 2);
    assert.throws(() => broker.resolve({ requestId: oldCard.requestId, argumentDigest: oldCard.argumentDigest, approved: true }), coded("APPLE_DEVICE_APPROVAL_INVALID"));
    const canceled = assert.rejects(current.promise, coded("APPLE_DEVICE_CANCELLED")); broker.close(); await canceled;
    assert.throws(() => request(broker), coded("APPLE_DEVICE_APPROVAL_UNAVAILABLE"));
  } finally { broker.close(); }
});

test("approval previews fail closed on secret checks or oversized actions", () => {
  const broker = new AppleDeviceApprovalBroker({ assertSecretSafe(text) { if (text.includes("fixture-sensitive-value")) throw Object.assign(new Error("secret"), { code: "SECRET_FOUND" }); } });
  try {
    assert.throws(() => request(broker, { arguments: { title: "fixture-sensitive-value" } }), coded("SECRET_FOUND"));
    assert.throws(() => request(broker, { arguments: { notes: "x".repeat(13000) } }), coded("APPLE_DEVICE_APPROVAL_UNAVAILABLE"));
    assert.deepEqual(broker.list().items, []);
  } finally { broker.close(); }
});
