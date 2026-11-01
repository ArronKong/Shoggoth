"use strict";

const path = require("node:path");
const { runtimeBinding } = require("./runtime-adapter");
const { runtimeData } = require("./runtime-handle-v1");
const { safeSnapshot } = require("./codex-event-snapshot");
const { serviceError } = require("./security");

const METHODS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval",
  "item/permissions/requestApproval", "mcpServer/elicitation/request", "shoggoth/mcp.call"]);
const KINDS = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);
const FILE_KINDS = new Set(["edit", "delete", "move"]);
const revoked = () => serviceError("HOST_CAPABILITY_REVOKED", "ACP execution authority is unavailable");
const invalid = () => serviceError("RUNTIME_ACP_BRIDGE_INVALID", "ACP product bridge could not validate the operation");
const canceled = () => ({ outcome: { outcome: "cancelled" } });
const plain = value => value && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const text = (value, max = 512) => typeof value === "string" && value.length > 0 && value.isWellFormed()
  && !value.includes("\0") && Buffer.byteLength(value) <= max;
const sameAttempt = (left, right) => ["sessionId", "turnId", "operationId", "attemptId", "fingerprint"]
  .every(key => left?.[key] === right?.[key]);
function attemptIdentity(value) {
  if (!plain(value) || Object.keys(value).sort().join() !== "attemptId,fingerprint,operationId,sessionId,turnId"
    || ["sessionId", "turnId", "operationId", "attemptId"].some(key => !text(value[key]))
    || !/^[a-f0-9]{64}$/u.test(value.fingerprint)) throw invalid();
  return Object.freeze({ ...value });
}
function checkCurrent(assertCurrent) {
  const result = assertCurrent();
  if (result === false || result?.then) throw revoked();
}

// This object is created only by the trusted extension Adapter. Neither ACP
// messages nor gate files can create its closures or choose another Run.
class AcpProductBridge {
  constructor({ binding, host, rpc, mcpGateIssuer = null, executionContract = null }) {
    this.binding = runtimeBinding(binding); this.host = host; this.rpc = rpc; this.issuer = mcpGateIssuer;
    this.runId = executionContract?.runId ?? null;
    if (executionContract && (!text(this.runId, 256)
      || ["runtime", "runtimeProfileId", "runtimeAccountId"].some(key => executionContract[key] !== this.binding[key])
      || executionContract.workspace !== host.workspace)) throw invalid();
    if (this.runId && ["reserveMcpServer", "bindMcpServer", "revokeMcpServer"].some(method => typeof this.issuer?.[method] !== "function")) throw invalid();
    this.child = host.child; this.pid = host.child?.pid; this.workspace = host.workspace;
    this.handlers = new Map(); this.sessions = new Map(); this.slots = new Set(); this.pendingPermissions = new Set();
    this.active = null; this.closed = false;
  }
  _assertHost() {
    if (this.closed || this.host.child !== this.child || this.host.child?.pid !== this.pid
      || !Number.isSafeInteger(this.pid) || this.pid <= 1 || this.host.workspace !== this.workspace
      || this.host.mcpExecutionRunId !== this.runId) throw revoked();
    this.host.assertRuntimeIdentityCurrent();
  }
  _assertAttempt(active, { dispatched = true } = {}) {
    this._assertHost();
    if (!active || this.active !== active || active.controller.signal.aborted
      || (dispatched && active.dispatched !== true)) throw revoked();
    checkCurrent(active.assertCurrent);
    return active.identity;
  }
  registerServerRequestHandler(method, handler) {
    if (this.closed || !METHODS.has(method) || typeof handler !== "function") throw invalid();
    this.handlers.set(method, handler);
    return () => { if (this.handlers.get(method) === handler) this.handlers.delete(method); };
  }
  async prepareSession({ operation, sessionId } = {}) {
    this._assertHost();
    if (!["new", "load"].includes(operation) || (operation === "new" && sessionId !== undefined)
      || (operation === "load" && !text(sessionId))) throw invalid();
    if (!this.runId) return { mcpServers: [], bindSession() {}, revoke() {} };
    if (this.slots.size >= 64) throw serviceError("RUNTIME_HOST_CAPACITY", "ACP MCP session capacity is unavailable");
    const slot = { sessionId: null, reservationId: null, revoked: false };
    const assertExecutionCurrent = () => {
      const active = this.active, identity = this._assertAttempt(active);
      if (slot.revoked || !slot.sessionId || this.sessions.get(slot.sessionId) !== slot
        || identity.sessionId !== slot.sessionId) throw revoked();
      return true;
    };
    const descriptor = await this.issuer.reserveMcpServer({ ...this.binding,
      executionRunId: this.runId, parentExecutable: this.host.runtimeProcessExecutable,
      assertExecutionCurrent });
    slot.reservationId = descriptor.reservationId; this.slots.add(slot);
    const revoke = () => this._revokeSlot(slot);
    try {
      this._assertHost();
      await this.issuer.bindMcpServer({ reservationId: slot.reservationId, parentPid: this.pid });
      this._assertHost();
      return Object.freeze({ mcpServers: Object.freeze([Object.freeze({ name: descriptor.name,
        command: descriptor.command, args: [...descriptor.args], env: descriptor.env.map(entry => ({ ...entry })) })]),
      bindSession: nativeId => {
        this._assertHost();
        if (slot.revoked || !text(nativeId) || (sessionId !== undefined && nativeId !== sessionId)
          || (slot.sessionId !== null && slot.sessionId !== nativeId)) throw invalid();
        const previous = this.sessions.get(nativeId);
        if (previous && previous !== slot) this._revokeSlot(previous);
        slot.sessionId = nativeId; this.sessions.set(nativeId, slot);
      }, revoke });
    } catch (error) { revoke(); throw error; }
  }
  _revokeSlot(slot) {
    slot.revoked = true;
    if (slot.sessionId && this.sessions.get(slot.sessionId) === slot) this.sessions.delete(slot.sessionId);
    if (slot.reservationId) this.issuer.revokeMcpServer({ reservationId: slot.reservationId });
    this.slots.delete(slot);
  }
  prepareTurn(value, { signal, assertCurrent } = {}) {
    this._assertHost(); const identity = attemptIdentity(value);
    if (typeof assertCurrent !== "function") throw invalid();
    checkCurrent(assertCurrent);
    if (this.active) {
      if (sameAttempt(this.active.identity, identity)) { this._assertAttempt(this.active, { dispatched: false }); return; }
      throw serviceError("RUNTIME_TURN_ACCEPTANCE_UNKNOWN", "ACP execution is unresolved");
    }
    if (this.runId && !this.sessions.has(identity.sessionId)) throw invalid();
    const controller = new AbortController();
    const active = { identity, assertCurrent, controller, dispatched: false, replied: new Set(), signal, abort: null };
    active.abort = () => this.interruptTurn(identity);
    this.active = active;
    signal?.addEventListener("abort", active.abort, { once: true });
    if (signal?.aborted) this.interruptTurn(identity);
    this._assertAttempt(active, { dispatched: false });
  }
  dispatchAttempt(value) {
    const identity = attemptIdentity(value), active = this.active;
    if (!sameAttempt(active?.identity, identity)) throw revoked();
    this._assertAttempt(active, { dispatched: false }); active.dispatched = true;
  }
  interruptTurn(value) {
    const active = this.active;
    if (!active || !sameAttempt(active.identity, value)) return false;
    active.controller.abort();
    active.signal?.removeEventListener("abort", active.abort);
    for (const slot of [...this.slots]) if (slot.sessionId === active.identity.sessionId) {
      try { this._revokeSlot(slot); } catch { this.cleanupIncomplete = true; }
    }
    return true;
  }
  finishTurn(value) {
    const active = this.active;
    if (!active || !sameAttempt(active.identity, value)) return false;
    this.interruptTurn(value); this.active = null;
    return true;
  }
  async requestPermission(params, requestContext = {}) {
    const active = this.active;
    let identity;
    try { identity = this._assertAttempt(active); } catch { return canceled(); }
    if (!plain(params) || params.sessionId !== identity.sessionId || !plain(params.toolCall)
      || !text(params.toolCall.toolCallId) || !Array.isArray(params.options) || params.options.length < 1 || params.options.length > 32
      || params.options.some(option => !plain(option) || !text(option.optionId) || !text(option.name, 4096) || !KINDS.has(option.kind))
      || new Set(params.options.map(option => option.optionId)).size !== params.options.length
      || this.pendingPermissions.size >= 64 || active.replied.size >= 1024) return canceled();
    // Persistence scopes are not defined for an arbitrary ACP Agent. Offer only
    // once decisions; never invent an optionId for a missing allow/reject.
    const options = params.options.filter(option => ["allow_once", "reject_once"].includes(option.kind));
    if (!options.length) return canceled();
    const nativeRequestId = requestContext.id;
    if (!((typeof nativeRequestId === "string" && text(nativeRequestId, 256))
      || (Number.isSafeInteger(nativeRequestId) && nativeRequestId >= 0))) return canceled();
    const requestKey = JSON.stringify([typeof nativeRequestId, nativeRequestId]), toolKey = `tool:${params.toolCall.toolCallId}`;
    if (active.replied.has(requestKey) || active.replied.has(toolKey)) return canceled();
    const tool = params.toolCall, method = FILE_KINDS.has(tool.kind)
      ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval";
    const handler = this.handlers.get(method); if (!handler) return canceled();
    let rawInput;
    try { rawInput = tool.rawInput === undefined ? undefined : runtimeData(tool.rawInput, 32 * 1024); } catch { return canceled(); }
    const command = plain(rawInput) ? rawInput.command : undefined;
    if (command !== undefined && !text(command, 24 * 1024)) return canceled();
    const title = tool.title === undefined ? "Runtime tool" : tool.title;
    if (!text(title, 4096)) return canceled();
    const cwd = plain(rawInput) && rawInput.cwd !== undefined ? rawInput.cwd : this.workspace;
    if (typeof cwd !== "string" || !path.isAbsolute(cwd) || path.resolve(cwd) !== path.resolve(this.workspace)) return canceled();
    const displayInput = plain(rawInput) ? { ...rawInput } : rawInput;
    if (plain(displayInput)) delete displayInput.command;
    const approvalOptions = options.map((option, index) => ({ choice: options.findIndex(candidate => candidate.kind === option.kind) === index
      ? option.kind === "allow_once" ? "once" : "deny" : `runtime:${index}`, label: option.name, kind: option.kind }));
    const request = { sessionId: identity.sessionId, threadId: identity.sessionId, turnId: identity.turnId,
      attemptId: identity.attemptId, itemId: tool.toolCallId, nativeRequestId,
      ...(command === undefined ? {} : { command }), cwd,
      toolName: text(tool.title, 128) && /^[A-Za-z0-9_.:/-]+$/u.test(tool.title) ? tool.title : tool.kind || "runtime_tool",
      ...(rawInput === undefined ? {} : { toolInput: safeSnapshot(displayInput, { maxSnapshotBytes: 16 * 1024,
        registeredSecrets: this.host.registeredSecrets || [] }) }),
      reason: title, sessionApprovalAvailable: false, approvalOptions };
    if (Buffer.byteLength(JSON.stringify(request)) > 32 * 1024) return canceled();
    active.replied.add(requestKey); active.replied.add(toolKey);
    const pending = {}; this.pendingPermissions.add(pending);
    let release = () => {};
    try {
      this._assertAttempt(active);
      release = this.host.pauseManagedToolTimeout?.({ sessionId: identity.sessionId, turnId: identity.turnId }) || (() => {});
      const response = await handler(request, { method, sourceMethod: "session/request_permission", id: nativeRequestId,
        signal: active.controller.signal, attemptId: identity.attemptId });
      this._assertAttempt(active);
      if (response?.decision === "cancel") return canceled();
      let index;
      if (response?.approvalChoice !== undefined) index = approvalOptions.findIndex(option => option.choice === response.approvalChoice);
      else index = options.findIndex(option => option.kind === (response?.decision === "accept" ? "allow_once"
        : response?.decision === "decline" ? "reject_once" : null));
      if (index < 0 || response?.decision !== (options[index].kind === "allow_once" ? "accept" : "decline")) return canceled();
      return { outcome: { outcome: "selected", optionId: options[index].optionId } };
    } catch { return canceled(); }
    finally { try { release(); } finally { this.pendingPermissions.delete(pending); } }
  }
  isIdle() { return !this.cleanupIncomplete && this.active === null && this.pendingPermissions.size === 0; }
  close() {
    this.closed = true;
    if (this.active) {
      this.active.controller.abort(); this.active.signal?.removeEventListener("abort", this.active.abort); this.active = null;
    }
    this.handlers.clear();
    const failures = [];
    for (const slot of [...this.slots]) { try { this._revokeSlot(slot); } catch (error) { failures.push(error); } }
    this.cleanupIncomplete = failures.length > 0;
    if (failures.length) throw serviceError("RUNTIME_STOP_UNCONFIRMED", "ACP MCP reservations could not be revoked");
  }
}
module.exports = { AcpProductBridge };
