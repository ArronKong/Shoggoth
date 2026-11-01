"use strict";

const crypto = require("node:crypto");
const { isExecutionTimeoutMs, executionTimeoutMs } = require("../execution-timeout");
const { serviceError } = require("./security");

const fail = code => { throw serviceError(code, "设备操作未获批准，未执行"); };
const bounded = (value, max) => typeof value === "string" && value.length > 0
  && value.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.byteLength(value) <= max;
function validIdentity(identity) {
  return identity && Object.getPrototypeOf(identity) === Object.prototype
    && ["shoggoth", "openclaw", "hermes"].includes(identity.backendId)
    && ["agentId", "profileId", "callId"].every(key => bounded(identity[key], 256))
    && bounded(identity.sessionId, 4096)
    && (identity.runId === null || identity.runId === undefined || bounded(identity.runId, 256));
}

// This broker only receives identities derived from the authenticated Product
// execution scope. A model-provided confirmation flag is never an approval.
class AppleDeviceApprovalBroker {
  constructor({ now = Date.now, generation = 1, timeoutMs = null,
    assertSecretSafe = () => {}, onWaiting = () => () => {} } = {}) {
    this.now = now; this.timeoutMs = executionTimeoutMs(timeoutMs);
    if (!isExecutionTimeoutMs(this.timeoutMs)) fail("APPLE_DEVICE_APPROVAL_INVALID"); this.generation = generation;
    this.assertSecretSafe = assertSecretSafe; this.onWaiting = onWaiting;
    this.pending = new Map(); this.closed = false;
  }
  open(generation) { this.close(); this.closed = false; this.generation = generation; }
  request({ identity, name, arguments: args, reviewOnly, reason, assertCurrent, signal }) {
    if (this.closed || !validIdentity(identity) || !/^apple_(?:calendar|reminders)_[a-z_]+$/u.test(name)
      || typeof assertCurrent !== "function" || !signal || signal.aborted || this.pending.size >= 128) {
      fail("APPLE_DEVICE_APPROVAL_UNAVAILABLE");
    }
    assertCurrent();
    const argumentsPreview = JSON.stringify(reviewOnly ? { target: reviewOnly, arguments: args } : args, null, 2);
    // Never display a truncated action for approval. The device schemas are
    // bounded, but a large notes edit can still require the user to shorten it.
    if (!bounded(argumentsPreview.replace(/[\r\n\t]/gu, " "), 12000)
      || !bounded(reason, 1000)) fail("APPLE_DEVICE_APPROVAL_UNAVAILABLE");
    this.assertSecretSafe(argumentsPreview); this.assertSecretSafe(reason);
    const createdAt = this.now(), requestId = `apple-device-${crypto.randomUUID()}`;
    const argumentDigest = crypto.createHash("sha256")
      .update(JSON.stringify([this.generation, identity, name, args, reviewOnly || null])).digest("hex");
    const details = { requestId, backendId: identity.backendId, agentId: identity.agentId,
      sessionId: identity.sessionId, toolName: name,
      serverId: name.startsWith("apple_calendar_") ? "apple-calendar" : "apple-reminders",
      argumentsPreview, argumentDigest, reason, createdAt, expiresAt: this.timeoutMs === null ? null : createdAt + this.timeoutMs };
    return new Promise((resolve, reject) => {
      const onAbort = () => this._settle(requestId, false, "APPLE_DEVICE_CANCELLED");
      const timer = this.timeoutMs === null ? null : setTimeout(() => this._settle(requestId, false, "APPLE_DEVICE_APPROVAL_EXPIRED"), this.timeoutMs);
      timer?.unref?.();
      let leaveWaiting = () => {};
      try { leaveWaiting = this.onWaiting(identity) || leaveWaiting; }
      catch { clearTimeout(timer); reject(serviceError("APPLE_DEVICE_APPROVAL_UNAVAILABLE", "设备审批暂不可用")); return; }
      this.pending.set(requestId, { details, assertCurrent, signal, onAbort, timer, resolve, reject, leaveWaiting });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
  _settle(id, approved, code = null) {
    const record = this.pending.get(id); if (!record) return;
    this.pending.delete(id); clearTimeout(record.timer);
    record.signal.removeEventListener("abort", record.onAbort);
    try { record.leaveWaiting(); } catch { /* A canceled run cannot regain approval. */ }
    if (code) record.reject(serviceError(code, "设备操作未获批准，未执行"));
    else if (!approved) record.reject(serviceError("APPLE_DEVICE_APPROVAL_DENIED", "用户拒绝了本次设备操作"));
    else record.resolve({ approved: true });
  }
  list() {
    for (const [id, record] of this.pending) {
      if (record.details.expiresAt !== null && this.now() >= record.details.expiresAt) this._settle(id, false, "APPLE_DEVICE_APPROVAL_EXPIRED");
      else { try { record.assertCurrent(); } catch { this._settle(id, false, "APPLE_DEVICE_CANCELLED"); } }
    }
    return { items: [...this.pending.values()].map(record => ({ ...record.details })), generation: this.generation };
  }
  resolve({ requestId, argumentDigest, approved }) {
    if (this.closed || typeof approved !== "boolean") fail("APPLE_DEVICE_APPROVAL_INVALID");
    const record = this.pending.get(requestId);
    if (!record || record.details.argumentDigest !== argumentDigest || record.details.expiresAt !== null && this.now() >= record.details.expiresAt) {
      fail("APPLE_DEVICE_APPROVAL_INVALID");
    }
    try { record.assertCurrent(); } catch { this._settle(requestId, false, "APPLE_DEVICE_CANCELLED"); fail("APPLE_DEVICE_APPROVAL_INVALID"); }
    if (record.signal.aborted) { this._settle(requestId, false, "APPLE_DEVICE_CANCELLED"); fail("APPLE_DEVICE_APPROVAL_INVALID"); }
    this._settle(requestId, approved); return { resolved: true, approved };
  }
  close() {
    this.closed = true;
    for (const id of this.pending.keys()) this._settle(id, false, "APPLE_DEVICE_CANCELLED");
  }
}

module.exports = { AppleDeviceApprovalBroker };
