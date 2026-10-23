"use strict";
const c = require("./chat-ui-contract");
const STATUSES = new Set(["accepted", "queued", "running", "completed", "failed", "cancelled", "unknown", "expired"]);
function validateUiOperationResult(method, value) {
  const fields = ["actionRequestId", "operationId", "artifactId", "revision", "sourceEventId", "actionId",
    "stateRevision", "status", "runId", "reason", "errorCode", "errorMessage", "createdAt"];
  c.fields(value, fields, fields);
  for (const key of ["actionRequestId", "operationId", "artifactId", "sourceEventId", "actionId"]) c.id(value[key]);
  c.positive(value.revision); c.positive(value.stateRevision, "UI_REQUEST_INVALID", true); c.positive(value.createdAt, "UI_REQUEST_INVALID", true);
  if (!STATUSES.has(value.status)) throw c.uiError("UI_REQUEST_INVALID");
  if (value.runId !== null) c.id(value.runId);
  for (const key of ["reason", "errorCode"]) if (value[key] !== null && (typeof value[key] !== "string"
    || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(value[key]))) throw c.uiError("UI_REQUEST_INVALID");
  if (value.errorMessage !== null) c.text(value.errorMessage, 600, 2400);
  if (["queued", "running", "completed", "cancelled"].includes(value.status) && !value.runId) throw c.uiError("UI_REQUEST_INVALID");
  return c.bounded(value, c.LIMITS.reference);
}
module.exports = { STATUSES, validateUiOperationResult };
