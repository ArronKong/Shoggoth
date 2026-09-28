"use strict";

const crypto = require("node:crypto");
const { validIdentity, validToken } = require("./external-plugin-lease");
const { serviceError } = require("./security");

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MAX_PENDING = 128;
const MAX_PAGE = 2;
const MAX_RESPONSE_BYTES = 48 * 1024;
const MAX_ARGUMENT_BYTES = 12 * 1024;
const APPROVAL_TIMEOUT_MS = 60_000;

function fail(code = "CAPABILITY_FORBIDDEN") {
  throw serviceError(code, "外部插件调用审批无效或已过期");
}
function id(value, maxBytes = 256) {
  return typeof value === "string" && ID.test(value)
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}
function jsonArguments(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail();
  let command;
  try { command = JSON.stringify(value); } catch { fail(); }
  if (typeof command !== "string" || Buffer.byteLength(command, "utf8") > MAX_ARGUMENT_BYTES) {
    fail("MCP_TOOL_CAPACITY");
  }
  return command;
}
function label(value, maxBytes = 256) {
  return typeof value === "string" && value.length > 0 && value.isWellFormed()
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}
function checkCurrent(assertCurrent) {
  const result = assertCurrent();
  if (result && typeof result.then === "function") fail();
}

// An external host can submit a call only through its paired, one-use lease.
// The broker never accepts approval from that host or a model: only the
// Service's UI-facing prepare/commit path can resolve an exact pending call.
// Pending approvals live in memory and fail closed on Service restart.
class ExternalPluginApprovalBroker {
  #pending = new Map();
  #challenges = new Map();
  #outcomes = new Map();
  #now;
  #setTimer;
  #clearTimer;
  #timeoutMs;
  #revision = 1;

  constructor({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    timeoutMs = APPROVAL_TIMEOUT_MS } = {}) {
    if (typeof now !== "function" || typeof setTimer !== "function"
      || typeof clearTimer !== "function" || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1 || timeoutMs > APPROVAL_TIMEOUT_MS) throw new TypeError("Invalid external approval broker");
    this.#now = now;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#timeoutMs = timeoutMs;
  }

  request({ token, identity, callId, bindingId, connectionId, connectionAuthRevision,
    packageName, toolName, arguments: args, signal, assertCurrent,
    recordDecision = null }) {
    if (!validToken(token) || !validIdentity(identity) || !id(callId, 128)
      || !id(bindingId, 128) || !id(connectionId, 128)
      || !Number.isSafeInteger(connectionAuthRevision) || connectionAuthRevision < 1
      || !label(packageName) || !label(toolName, 128)
      || !signal || typeof signal.addEventListener !== "function"
      || typeof assertCurrent !== "function"
      || (recordDecision !== null && typeof recordDecision !== "function")) fail();
    const command = jsonArguments(args);
    checkCurrent(assertCurrent);
    if (signal.aborted || this.#pending.size >= MAX_PENDING) fail();
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - this.#timeoutMs) fail();
    const requestId = crypto.randomUUID();
    const details = Object.freeze({ requestId, backendId: identity.backendId,
      instanceId: identity.instanceId, agentId: identity.agentId,
      sessionId: identity.sessionId, runId: identity.runId || null,
      taskId: identity.taskId || null, turnId: identity.turnId || null,
      toolCallId: identity.toolCallId, callId, bindingId, connectionId,
      connectionAuthRevision, packageName, toolName, command,
      argumentDigest: crypto.createHash("sha256").update(command).digest("hex"),
      expiresAt: now + this.#timeoutMs });
    return new Promise((resolve, reject) => {
      const onAbort = () => this.#settle(requestId, null, serviceError(
        "CAPABILITY_FORBIDDEN", "外部插件执行已取消"), "withdrawn");
      const timer = this.#setTimer(() => this.#settle(requestId, null, serviceError(
        "CAPABILITY_FORBIDDEN", "外部插件审批已过期"), "expired"), this.#timeoutMs);
      this.#pending.set(requestId, { details, assertCurrent, signal,
        resolve, reject, timer, onAbort, challenge: null, operationId: null,
        operationDecision: null, recordDecision });
      this.#revision += 1;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  list({ backendId = null, cursor = null, limit = MAX_PAGE } = {}) {
    if (backendId !== null && !["openclaw", "hermes"].includes(backendId)) fail("PLUGIN_REQUEST_INVALID");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE
      || (cursor !== null && (!cursor || Object.getPrototypeOf(cursor) !== Object.prototype
        || Object.keys(cursor).sort().join(",") !== "offset,revision"
        || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0
        || !Number.isSafeInteger(cursor.revision) || cursor.revision < 1))) fail("PLUGIN_REQUEST_INVALID");
    this.#expire();
    if (cursor && cursor.revision !== this.#revision) fail("CATALOG_REVISION_CHANGED");
    const all = [...this.#pending.values()].filter(row =>
      backendId === null || row.details.backendId === backendId)
      .map(row => ({ ...row.details }));
    const offset = cursor?.offset || 0;
    if (offset > all.length) fail("PLUGIN_REQUEST_INVALID");
    const page = [];
    for (const row of all.slice(offset, offset + limit)) {
      const candidate = { items: [...page, row], nextCursor: null };
      if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_RESPONSE_BYTES) break;
      page.push(row);
    }
    if (page.length === 0 && offset < all.length) fail("MCP_TOOL_CAPACITY");
    return { items: page, nextCursor: offset + page.length < all.length
      ? { offset: offset + page.length, revision: this.#revision } : null };
  }

  prepare({ requestId, operationId, decision }) {
    if (!id(requestId, 128) || !id(operationId, 128)
      || !["once", "deny"].includes(decision)) fail("PLUGIN_REQUEST_INVALID");
    this.#expire();
    const outcome = this.#outcomes.get(`operation:${operationId}`);
    if (outcome) {
      if (outcome.requestId !== requestId || outcome.decision !== decision) fail("PLUGIN_REQUEST_INVALID");
      return { completed: true, approved: outcome.approved, challenge: null, summary: null };
    }
    const pending = this.#pending.get(requestId);
    if (!pending || pending.challenge) fail("PLUGIN_REQUEST_INVALID");
    if ([...this.#pending.values()].some(row => row.operationId === operationId)) {
      fail("PLUGIN_REQUEST_INVALID");
    }
    try { checkCurrent(pending.assertCurrent); }
    catch (error) { this.#settle(requestId, null, error, "withdrawn"); throw error; }
    if (pending.signal.aborted) fail();
    const challenge = crypto.randomUUID();
    pending.challenge = challenge;
    pending.operationId = operationId;
    pending.operationDecision = decision;
    this.#challenges.set(challenge, requestId);
    return { completed: false, approved: null, challenge,
      summary: { action: "external-plugin-call", ...pending.details } };
  }

  commit({ challenge, approved }) {
    if (!id(challenge, 128) || typeof approved !== "boolean") fail("PLUGIN_REQUEST_INVALID");
    this.#expire();
    const previous = this.#outcomes.get(`challenge:${challenge}`);
    if (previous) {
      if (previous.approved !== approved) fail("PLUGIN_REQUEST_INVALID");
      return { approved, requestId: previous.requestId };
    }
    const requestId = this.#challenges.get(challenge);
    const pending = requestId && this.#pending.get(requestId);
    if (!pending || pending.challenge !== challenge || pending.signal.aborted) fail("PLUGIN_REQUEST_INVALID");
    if (pending.operationDecision === "deny" && approved) fail("PLUGIN_REQUEST_INVALID");
    if (approved) {
      try { checkCurrent(pending.assertCurrent); }
      catch (error) { this.#settle(requestId, null, error, "withdrawn"); throw error; }
    }
    const outcome = { requestId, approved, decision: pending.operationDecision };
    const settlementError = this.#settle(requestId, { approved, requestId,
      argumentDigest: pending.details.argumentDigest });
    if (settlementError) throw settlementError;
    this.#outcomes.set(`challenge:${challenge}`, outcome);
    this.#outcomes.set(`operation:${pending.operationId}`, outcome);
    if (this.#outcomes.size > MAX_PENDING * 4) {
      for (const key of [...this.#outcomes.keys()].slice(0, MAX_PENDING * 2)) this.#outcomes.delete(key);
    }
    return { approved, requestId };
  }

  #expire() {
    for (const [requestId, pending] of this.#pending) {
      if (pending.details.expiresAt <= this.#now()) this.#settle(requestId, null,
        serviceError("CAPABILITY_FORBIDDEN", "外部插件审批已过期"), "expired");
    }
  }
  #settle(requestId, value, error = null, outcome = null) {
    const pending = this.#pending.get(requestId);
    if (!pending) return null;
    const decision = outcome || (value ? value.approved === true ? "approved" : "denied" : null);
    let persistenceError = null;
    if (decision && pending.recordDecision) {
      try { pending.recordDecision(pending.details.callId, requestId, decision); }
      catch {
        // An undurable decision cannot authorize a call. Close the broker
        // request without reporting that its original decision committed.
        persistenceError = serviceError("EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE", "外部插件审批记录不可用");
        Object.defineProperty(persistenceError, "approvalJournalUnavailable", { value: true });
        error = persistenceError;
        outcome = null;
      }
    }
    this.#pending.delete(requestId);
    this.#revision += 1;
    if (pending.challenge) this.#challenges.delete(pending.challenge);
    this.#clearTimer(pending.timer);
    pending.signal.removeEventListener("abort", pending.onAbort);
    if (error) {
      // These labels are broker decisions, not claims about a tool result.
      // Keep them internal; the tool service records them against the exact
      // callId before the public, bounded audit projection is read.
      if (outcome) {
        try {
          Object.defineProperties(error, {
            approvalOutcome: { value: outcome, configurable: true },
            approvalRequestId: { value: requestId, configurable: true },
          });
        } catch { /* A frozen host error still rejects; no outcome is inferred. */ }
      }
      pending.reject(error);
    }
    else pending.resolve(value);
    return persistenceError;
  }
  clear() {
    for (const requestId of this.#pending.keys()) this.#settle(requestId, null,
      serviceError("CAPABILITY_FORBIDDEN", "外部插件审批已关闭"), "withdrawn");
    this.#challenges.clear();
    this.#outcomes.clear();
  }
}

module.exports = { ExternalPluginApprovalBroker };
