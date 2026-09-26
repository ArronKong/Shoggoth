"use strict";
const { serviceError } = require("./security");
const KINDS = Object.freeze(["approval", "input", "mcp", "artifact"]);
const invalid = () => serviceError("HOST_CAPABILITY_REVOKED", "执行权限租约已失效");

// Authority is object identity in this Service lifetime. JSON identities,
// process credentials and a handle cached by an adapter cannot mint a lease.
class HostCapabilityIssuer {
  #records = new WeakMap();
  #active = new Set();
  constructor({ now = Date.now } = {}) { this.now = now; }
  issue({ identity, grants = KINDS, validate, signal, expiresAt = this.now() + 24 * 60 * 60_000 }) {
    if (!identity || ["runId", "profileId", "bindingId", "runtime", "runtimeAccountId", "attemptId"]
      .some(key => typeof identity[key] !== "string" || !identity[key]) || typeof validate !== "function"
      || !Number.isSafeInteger(expiresAt) || expiresAt <= this.now()
      || !Array.isArray(grants) || grants.some(kind => !KINDS.includes(kind))) throw invalid();
    const controller = new AbortController();
    const lease = Object.freeze({ version: 1, signal: controller.signal });
    const record = { lease, identity: Object.freeze(structuredClone(identity)), grants: new Set(grants),
      validate, expiresAt, controller, bindings: null, replies: new Set(), externalSignal: signal, onAbort: null };
    record.onAbort = () => this.revoke(lease);
    this.#records.set(lease, record); this.#active.add(record);
    signal?.addEventListener("abort", record.onAbort, { once: true });
    if (signal?.aborted) this.revoke(lease);
    this.assert(lease);
    return lease;
  }
  assert(lease, { kind = null, sessionId, turnId, identity } = {}) {
    const record = this.#records.get(lease);
    let valid = !!record && !record.controller.signal.aborted && this.now() < record.expiresAt;
    try { valid = valid && record.validate(record.identity) === true; } catch { valid = false; }
    if (!valid) { this.revoke(lease); throw invalid(); }
    if ((kind !== null && !record.grants.has(kind))
      || (identity && Object.keys(identity).some(key => record.identity[key] !== identity[key]))
      || (sessionId !== undefined && record.bindings?.sessionId !== sessionId)
      || (turnId !== undefined && record.bindings?.turnId !== turnId)) throw invalid();
    return record.identity;
  }
  bind(lease, { sessionId, turnId }) {
    this.assert(lease);
    const record = this.#records.get(lease);
    if (typeof sessionId !== "string" || !sessionId || typeof turnId !== "string" || !turnId
      || (record.bindings && (record.bindings.sessionId !== sessionId || record.bindings.turnId !== turnId))) throw invalid();
    record.bindings = Object.freeze({ sessionId, turnId });
  }
  async invoke(lease, scope, action) {
    this.assert(lease, scope);
    const result = await action(lease.signal);
    this.assert(lease, scope);
    return result;
  }
  consumeReply(lease, requestId, scope) {
    this.assert(lease, scope);
    const record = this.#records.get(lease);
    if (typeof requestId !== "string" || !requestId || record.replies.has(requestId)
      || record.replies.size >= 1024) throw invalid();
    record.replies.add(requestId);
  }
  revoke(lease) {
    const record = this.#records.get(lease);
    if (!record || record.controller.signal.aborted) return false;
    record.externalSignal?.removeEventListener("abort", record.onAbort);
    record.controller.abort(); this.#active.delete(record);
    return true;
  }
  revokeWhere(predicate) { for (const record of [...this.#active]) if (predicate(record.identity)) this.revoke(record.lease); }
  close() { this.revokeWhere(() => true); }
  get activeCount() { return this.#active.size; }
}
module.exports = { HostCapabilityIssuer, HOST_CAPABILITY_KINDS: KINDS };
