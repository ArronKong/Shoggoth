"use strict";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const TOOL_ID = /^plugin:[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[a-f0-9]{64}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[a-f0-9]{64}$/u;
const STATUSES = new Set(["pending", "confirmed", "rejected_before_send",
  "canceled_before_send", "outcome_unknown", "canceled_outcome_unknown"]);

function exact(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === fields.length
    && fields.every(field => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    });
}
function invalid() { throw new TypeError("invalid external plugin audit result"); }
function id(value) { return typeof value === "string" && ID.test(value); }
function opaque(value, max = 256) {
  return typeof value === "string" && OPAQUE.test(value)
    && Buffer.byteLength(value, "utf8") <= max;
}
function toolName(value) {
  // MCP names are provider-defined. Match the bounded catalog contract rather
  // than restricting them to Shoggoth's internal opaque-ID alphabet.
  return typeof value === "string" && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 128;
}
function timestamp(value) { return Number.isSafeInteger(value) && value >= 0; }
function cursor(value) {
  if (value === null) return null;
  if (!exact(value, ["createdAt", "callId"]) || !timestamp(value.createdAt)
    || !id(value.callId)) invalid();
  return { createdAt: value.createdAt, callId: value.callId };
}
function validateExternalPluginAuditPage(value) {
  if (!exact(value, ["items", "nextCursor"]) || !Array.isArray(value.items)
    || value.items.length > 20) invalid();
  const items = value.items.map(row => {
    if (!exact(row, ["callId", "backendId", "instanceId", "agentId", "sessionId",
      "runId", "taskId", "turnId", "toolCallId", "bindingId", "installationId",
      "componentId", "connectionId", "toolIdentity", "toolName", "status",
      "cancelRequested", "resultDigest", "resultBytes", "errorCode",
      "approvalRequestId", "approvalOutcome", "approvalUpdatedAt",
      "createdAt", "updatedAt"])
      || !id(row.callId) || !["openclaw", "hermes"].includes(row.backendId)
      || !opaque(row.instanceId, 128) || !opaque(row.agentId, 128)
      || !opaque(row.sessionId) || !opaque(row.toolCallId)
      || !id(row.bindingId) || !id(row.installationId)
      || typeof row.componentId !== "string" || !HASH.test(row.componentId)
      || !id(row.connectionId) || typeof row.toolIdentity !== "string"
      || !TOOL_ID.test(row.toolIdentity) || !toolName(row.toolName)
      || !STATUSES.has(row.status) || typeof row.cancelRequested !== "boolean"
      || (row.resultDigest !== null && (typeof row.resultDigest !== "string"
        || !HASH.test(row.resultDigest)))
      || (row.resultBytes !== null && (!Number.isSafeInteger(row.resultBytes)
        || row.resultBytes < 0))
      || (row.errorCode !== null && (typeof row.errorCode !== "string"
        || !CODE.test(row.errorCode)))
      || (row.approvalRequestId !== null && !id(row.approvalRequestId))
      || (row.approvalOutcome !== null && !["approved", "denied", "expired", "withdrawn"]
        .includes(row.approvalOutcome))
      || (row.approvalUpdatedAt !== null && !timestamp(row.approvalUpdatedAt))
      || ((row.approvalRequestId === null || row.approvalOutcome === null
        || row.approvalUpdatedAt === null)
        && !(row.approvalRequestId === null && row.approvalOutcome === null
          && row.approvalUpdatedAt === null))
      || !timestamp(row.createdAt) || !timestamp(row.updatedAt)
      || row.updatedAt < row.createdAt
      || (row.approvalUpdatedAt !== null
        && (row.approvalUpdatedAt < row.createdAt || row.approvalUpdatedAt > row.updatedAt))) invalid();
    if (row.backendId === "openclaw") {
      if (!opaque(row.runId) || row.taskId !== null || row.turnId !== null) invalid();
    } else if (!opaque(row.taskId) || !opaque(row.turnId) || row.runId !== null) invalid();
    return { ...row };
  });
  const nextCursor = cursor(value.nextCursor);
  if (nextCursor !== null && items.length === 0) invalid();
  return { items, nextCursor };
}

module.exports = { validateExternalPluginAuditPage };
