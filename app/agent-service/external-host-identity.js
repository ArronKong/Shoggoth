"use strict";
const BACKENDS = new Set(["openclaw", "hermes"]);
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const validId = (value, maxBytes = 256) => typeof value === "string" && OPAQUE.test(value) && Buffer.byteLength(value) <= maxBytes;
function validIdentity(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || !BACKENDS.has(value.backendId)
    || !validId(value.instanceId, 128) || !validId(value.agentId, 128) || !validId(value.sessionId) || !validId(value.toolCallId)) return false;
  return value.backendId === "openclaw"
    ? Object.keys(value).sort().join(",") === "agentId,backendId,instanceId,runId,sessionId,toolCallId" && validId(value.runId)
    : Object.keys(value).sort().join(",") === "agentId,backendId,instanceId,sessionId,taskId,toolCallId,turnId" && validId(value.taskId) && validId(value.turnId);
}
function validToken(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  try { return bytes.length === 32 && bytes.toString("base64url") === value; } finally { bytes.fill(0); }
}
module.exports = { validIdentity, validToken };
