"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_ARGUMENT_BYTES = 256 * 1024;
const MAX_PENDING = 256;
const TICKET_LIFETIME_MS = 60_000;

function fail(code, message) { throw serviceError(code, message); }
function digest(value) {
  let json;
  try { json = JSON.stringify(value); } catch { fail("CAPABILITY_FORBIDDEN", "工具参数不是 JSON"); }
  if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > MAX_ARGUMENT_BYTES) {
    fail("CAPABILITY_FORBIDDEN", "工具参数超过容量上限");
  }
  return crypto.createHash("sha256").update(json).digest("hex");
}
function frozenCopy(value) {
  try { return structuredClone(value); } catch { fail("CAPABILITY_FORBIDDEN", "能力上下文无法冻结"); }
}

// Service-owned one-shot tickets connect a trusted execution envelope to the
// transport's synchronous final-send callback. This is not exposed to a model.
class CapabilityDispatcher {
  #store;
  #policy;
  #resolveToolContract;
  #now;
  #tickets = new Map();
  #approvals = new Map();

  constructor({ store, permissionEngine, resolveToolContract, now = Date.now } = {}) {
    if (typeof store?.getCapabilityRecords !== "function"
      || typeof store?.beginCapabilityCall !== "function"
      || typeof store?.markCapabilityCallSendStarted !== "function"
      || typeof store?.finishCapabilityCall !== "function"
      || typeof permissionEngine?.authorizeCapability !== "function"
      || typeof resolveToolContract !== "function") {
      throw new TypeError("CapabilityDispatcher requires PluginStore, PermissionEngine and tool catalog");
    }
    this.#store = store;
    this.#policy = permissionEngine;
    this.#resolveToolContract = resolveToolContract;
    this.#now = now;
  }

  #approvalFingerprint({ callId, authority, execution, envelope, bindingId,
    toolIdentity, downstreamToolName, contractDigest, arguments: args }) {
    return digest({ callId, profileId: authority?.profileId, executionKind: execution?.kind,
      runId: execution?.run?.id, envelope, bindingId, toolIdentity,
      downstreamToolName, contractDigest, argumentDigest: digest(args) });
  }

  // Only the Service calls this after its own pending approval was accepted.
  // Object identity is the receipt; serializing/copying it conveys no authority.
  approveCall(input) {
    const { authority, execution, envelope, bindingId, toolIdentity,
      downstreamToolName, contractDigest, arguments: args, assertCurrent } = input;
    this.#assertCurrent(assertCurrent);
    const now = this.#now();
    for (const [token, record] of this.#approvals) {
      if (record.approval.expiresAt <= now) this.#approvals.delete(token);
    }
    if (!Number.isSafeInteger(now) || now < 0 || this.#approvals.size >= MAX_PENDING) {
      fail("CAPABILITY_FORBIDDEN", "调用审批收据不可用");
    }
    const records = this.#store.getCapabilityRecords(bindingId, toolIdentity);
    if (records?.grant?.approvalMode !== "each-call" || execution?.kind !== "native-run") {
      fail("CAPABILITY_FORBIDDEN", "调用不需要或不能接受逐次审批");
    }
    this.#assertToolContract(records, toolIdentity, downstreamToolName, contractDigest);
    const approval = Object.freeze({ bindingId, connectionId: records.connection.connectionId,
      principalIdentity: records.connection.principalIdentity, toolIdentity, contractDigest,
      runId: execution.run?.id, argumentDigest: digest(args),
      expiresAt: now + TICKET_LIFETIME_MS, consumed: false });
    this.#policy.authorizeCapability({ ...records, authority,
      execution: { ...execution, approval }, envelope, toolIdentity,
      contractDigest, argumentDigest: approval.argumentDigest, now });
    const receipt = Object.freeze({});
    this.#approvals.set(receipt, { fingerprint: this.#approvalFingerprint(input),
      approval, ticketId: null });
    return receipt;
  }

  cancelApproval(receipt) { this.#approvals.delete(receipt); }

  issueTicket({ callId, authority, execution, envelope, bindingId, toolIdentity,
    downstreamToolName, contractDigest, arguments: args, assertCurrent = null,
    approvalReceipt = null }) {
    if (typeof callId !== "string" || !callId
      || typeof bindingId !== "string" || !bindingId
      || typeof toolIdentity !== "string" || !toolIdentity
      || typeof downstreamToolName !== "string" || !downstreamToolName
      || Buffer.byteLength(downstreamToolName, "utf8") > 128
      || !HASH_PATTERN.test(contractDigest) || !args || typeof args !== "object"
      || Array.isArray(args) || (assertCurrent !== null && typeof assertCurrent !== "function")) {
      fail("CAPABILITY_FORBIDDEN", "能力派发请求无效");
    }
    this.#assertCurrent(assertCurrent);
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) fail("CAPABILITY_FORBIDDEN", "派发时钟无效");
    for (const [id, ticket] of this.#tickets) {
      if (ticket.expiresAt <= now) this.cancel(id);
    }
    if (this.#tickets.size >= MAX_PENDING) fail("CAPABILITY_FORBIDDEN", "待派发能力已达上限");
    const argumentDigest = digest(args);
    const records = this.#store.getCapabilityRecords(bindingId, toolIdentity);
    if (!records) fail("CAPABILITY_FORBIDDEN", "能力绑定不存在");
    const catalogRevision = this.#assertToolContract(records, toolIdentity,
      downstreamToolName, contractDigest);
    const approved = this.#approvals.get(approvalReceipt);
    if (records.grant?.approvalMode === "each-call"
      && (!approved || approved.ticketId !== null || approved.approval.expiresAt <= now
        || approved.fingerprint !== this.#approvalFingerprint({ callId, authority, execution,
          envelope, bindingId, toolIdentity, downstreamToolName, contractDigest, arguments: args }))) {
      fail("CAPABILITY_FORBIDDEN", "调用缺少一次性用户审批收据");
    }
    // Never trust a plain execution.approval supplied by a caller. Only a
    // Service-owned receipt can produce the policy evaluator's approval view.
    const authorizedExecution = { ...execution, approval: approved?.approval };
    this.#policy.authorizeCapability({ ...records, authority, execution: authorizedExecution, envelope,
      toolIdentity, contractDigest, argumentDigest, now });
    const frozenAuthority = frozenCopy(authority);
    const frozenExecution = frozenCopy(authorizedExecution);
    const frozenEnvelope = frozenCopy(envelope);
    const runRef = execution.kind === "native-run" ? execution.run?.id
      : (typeof execution.managementTicket === "string"
        ? `ui-${crypto.createHash("sha256").update(execution.managementTicket).digest("hex")}`
        : null);
    this.#store.beginCapabilityCall({ callId, runRef, bindingId,
      connectionId: records.connection.connectionId,
      principalIdentity: records.connection.principalIdentity,
      toolIdentity, contractDigest, argumentDigest });
    const ticketId = crypto.randomUUID();
    if (approved) approved.ticketId = ticketId;
    this.#tickets.set(ticketId, {
      callId, authority: frozenAuthority, execution: frozenExecution,
      envelope: frozenEnvelope, bindingId, toolIdentity, downstreamToolName,
      contractDigest, argumentDigest, catalogRevision,
      connectionId: records.connection.connectionId,
      principalIdentity: records.connection.principalIdentity,
      assertCurrent,
      approvalReceipt,
      expiresAt: now + TICKET_LIFETIME_MS,
    });
    return ticketId;
  }

  authorizeEgress({ connectionId, principalIdentity, toolName,
    arguments: args, authority }) {
    const ticketId = authority?.ticketId;
    if (typeof ticketId !== "string" || !this.#tickets.has(ticketId)) {
      fail("CAPABILITY_FORBIDDEN", "派发票据不存在或已使用");
    }
    const ticket = this.#tickets.get(ticketId);
    this.#tickets.delete(ticketId);
    const now = this.#now();
    try {
      this.#assertCurrent(ticket.assertCurrent);
      if (ticket.expiresAt <= now || ticket.connectionId !== connectionId
        || ticket.principalIdentity !== principalIdentity
        || ticket.downstreamToolName !== toolName || ticket.argumentDigest !== digest(args)) {
        fail("CAPABILITY_FORBIDDEN", "派发票据与当前请求不匹配");
      }
      const records = this.#store.getCapabilityRecords(ticket.bindingId, ticket.toolIdentity);
      if (!records) fail("GRANT_REVOKED", "能力绑定已移除");
      if (records.grant?.approvalMode === "each-call"
        && this.#approvals.get(ticket.approvalReceipt)?.ticketId !== ticketId) {
        fail("CAPABILITY_FORBIDDEN", "调用审批收据已失效或已消费");
      }
      if (this.#assertToolContract(records, ticket.toolIdentity,
        ticket.downstreamToolName, ticket.contractDigest) !== ticket.catalogRevision) {
        fail("TOOL_CONTRACT_CHANGED", "MCP 工具目录代次已变化");
      }
      const decision = this.#policy.authorizeCapability({ ...records,
        authority: ticket.authority, execution: ticket.execution,
        envelope: ticket.envelope, toolIdentity: ticket.toolIdentity,
        contractDigest: ticket.contractDigest, argumentDigest: ticket.argumentDigest, now });
      // Persist before touching the transport. A crash after this point is
      // conservatively reported as unknown, never replayed.
      // Receipt consumption and send admission share this synchronous boundary.
      // A crash loses all in-memory receipts; the durable call is never replayed.
      this.#approvals.delete(ticket.approvalReceipt);
      this.#store.markCapabilityCallSendStarted(ticket.callId);
      return decision;
    } catch (error) {
      this.#approvals.delete(ticket.approvalReceipt);
      const record = this.#store.getCapabilityCall(ticket.callId);
      if (record?.phase === "prepared") this.#store.finishCapabilityCall(ticket.callId);
      throw error;
    }
  }

  #assertCurrent(assertCurrent) {
    const result = assertCurrent?.();
    if (result && typeof result.then === "function") {
      fail("CAPABILITY_FORBIDDEN", "执行权限检查必须同步完成");
    }
  }

  #assertToolContract(records, toolIdentity, downstreamToolName, contractDigest) {
    const current = this.#resolveToolContract({ installation: records.installation,
      binding: records.binding, connection: records.connection, toolIdentity });
    if (!current || typeof current.then === "function"
      || current.toolIdentity !== toolIdentity
      || current.downstreamName !== downstreamToolName
      || current.contractDigest !== contractDigest
      || typeof current.catalogRevision !== "string"
      || !current.catalogRevision || current.catalogRevision.length > 128) {
      fail("TOOL_CONTRACT_CHANGED", "MCP 工具合同或来源已变化");
    }
    return current.catalogRevision;
  }

  async dispatch({ client, ...input }) {
    if (typeof client?.callTool !== "function") fail("CAPABILITY_FORBIDDEN", "MCP 客户端不可用");
    const ticketId = this.issueTicket(input);
    try {
      const result = await client.callTool(input.downstreamToolName,
        input.arguments, { ticketId });
      this.#store.finishCapabilityCall(input.callId, { resultConfirmed: true });
      return result;
    } catch (error) {
      const record = this.#store.getCapabilityCall(input.callId);
      if (["prepared", "send_started"].includes(record?.phase)) {
        this.#store.finishCapabilityCall(input.callId);
      }
      throw error;
    } finally {
      this.cancel(ticketId);
    }
  }

  cancel(ticketId) {
    const ticket = this.#tickets.get(ticketId);
    if (!ticket) return;
    this.#tickets.delete(ticketId);
    this.#approvals.delete(ticket.approvalReceipt);
    const record = this.#store.getCapabilityCall(ticket.callId);
    if (record?.phase === "prepared") this.#store.finishCapabilityCall(ticket.callId);
  }
  clear() {
    for (const id of this.#tickets.keys()) this.cancel(id);
    this.#approvals.clear();
  }
}

module.exports = { CapabilityDispatcher };
