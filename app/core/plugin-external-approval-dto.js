"use strict";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH = /^[a-f0-9]{64}$/u;
function exact(value, fields) {
  return value && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === fields.length
    && fields.every(field => Object.hasOwn(value, field));
}
function id(value, max = 256) {
  return typeof value === "string" && ID.test(value)
    && Buffer.byteLength(value, "utf8") <= max;
}
function label(value, max = 256) {
  return typeof value === "string" && value.length > 0 && value.isWellFormed()
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    && Buffer.byteLength(value, "utf8") <= max;
}
function invalid() { throw new TypeError("invalid external plugin approval response"); }
function item(value) {
  if (!exact(value, ["requestId", "backendId", "instanceId", "agentId", "sessionId",
    "runId", "taskId", "turnId", "toolCallId", "callId", "bindingId",
    "connectionId", "connectionAuthRevision", "packageName", "toolName",
    "command", "argumentDigest", "expiresAt"])
    || !id(value.requestId, 128) || !["openclaw", "hermes"].includes(value.backendId)
    || !id(value.instanceId, 128) || !id(value.agentId, 128)
    || !id(value.sessionId) || !id(value.toolCallId)
    || !id(value.callId, 128) || !id(value.bindingId, 128)
    || !id(value.connectionId, 128)
    || !Number.isSafeInteger(value.connectionAuthRevision)
    || value.connectionAuthRevision < 1
    || !label(value.packageName) || !label(value.toolName, 128)
    || typeof value.command !== "string"
    || Buffer.byteLength(value.command, "utf8") > 12 * 1024
    || !HASH.test(value.argumentDigest)
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0) invalid();
  if (value.backendId === "openclaw") {
    if (!id(value.runId) || value.taskId !== null || value.turnId !== null) invalid();
  } else if (!id(value.taskId) || !id(value.turnId) || value.runId !== null) invalid();
  try {
    const args = JSON.parse(value.command);
    if (!args || Object.getPrototypeOf(args) !== Object.prototype) invalid();
  } catch { invalid(); }
  return Object.freeze({ ...value });
}
function validateExternalPluginApprovalResult(method, value) {
  if (method === "plugins.external.approvals.list") {
    if (!exact(value, ["items", "nextCursor"]) || !Array.isArray(value.items)
      || value.items.length > 2
      || (value.nextCursor !== null && (!exact(value.nextCursor, ["offset", "revision"])
        || !Number.isSafeInteger(value.nextCursor.offset) || value.nextCursor.offset < 1
        || !Number.isSafeInteger(value.nextCursor.revision) || value.nextCursor.revision < 1))) invalid();
    return Object.freeze({ items: Object.freeze(value.items.map(item)),
      nextCursor: value.nextCursor && Object.freeze({ ...value.nextCursor }) });
  }
  if (method === "plugins.external.approvals.prepare") {
    if (!exact(value, ["completed", "approved", "challenge", "summary"])
      || typeof value.completed !== "boolean") invalid();
    if (value.completed) {
      if (typeof value.approved !== "boolean" || value.challenge !== null
        || value.summary !== null) invalid();
    } else if (value.approved !== null || !id(value.challenge, 128)
      || !exact(value.summary, ["action", "requestId", "backendId", "instanceId",
        "agentId", "sessionId", "runId", "taskId", "turnId", "toolCallId",
        "callId", "bindingId", "connectionId", "connectionAuthRevision",
        "packageName", "toolName", "command", "argumentDigest", "expiresAt"])
      || value.summary.action !== "external-plugin-call") invalid();
    if (!value.completed) item(Object.fromEntries(Object.entries(value.summary)
      .filter(([key]) => key !== "action")));
    return value;
  }
  if (method === "plugins.external.approvals.commit") {
    if (!exact(value, ["approved", "requestId"])
      || typeof value.approved !== "boolean" || !id(value.requestId, 128)) invalid();
    return Object.freeze({ ...value });
  }
  invalid();
}
module.exports = { validateExternalPluginApprovalResult };
