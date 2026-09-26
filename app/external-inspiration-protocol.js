"use strict";

const path = require("node:path");
const { validInspirationAttention } = require("./agent-service/inspiration-service-protocol");

const EXTERNAL_INSPIRATION_METHODS = Object.freeze([
  "inspiration.external.prepare", "inspiration.external.start", "inspiration.external.get",
  "inspiration.external.respond", "inspiration.external.cancel",
]);
const EXTERNAL_BACKENDS = new Set(["openclaw", "hermes"]);
const EXTERNAL_STATUSES = new Set([
  "queued", "starting", "running", "waiting_input", "waiting_approval",
  "completed", "failed", "canceled", "interrupted", "unknown",
]);
const EXTERNAL_TERMINAL = new Set(["completed", "failed", "canceled", "interrupted"]);
const EXTERNAL_MODES = new Set(["openclaw", "gateway", "acp"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
const uuid = value => typeof value === "string" && UUID.test(value);
const text = (value, max, empty = false) => typeof value === "string" && (empty || value.length > 0)
  && value.isWellFormed() && !value.includes("\0") && Buffer.byteLength(JSON.stringify(value)) <= max;
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === fields.length
  && fields.every(key => Object.prototype.hasOwnProperty.call(value, key));
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const workspace = value => text(value, 4096) && path.isAbsolute(value);
const COMMON_FIELDS = ["executionId", "runId", "backendId", "agentId", "sessionKey", "workspace"];
const BOUND_FIELDS = [...COMMON_FIELDS, "mode", "hostId"];
const SNAPSHOT_FIELDS = [...COMMON_FIELDS, "mode", "status", "sequence", "resultSummary", "errorCode", "finishedAt", "attention"];

function validMode(backendId, mode) {
  return EXTERNAL_MODES.has(mode) && (backendId === "openclaw" ? mode === "openclaw" : mode !== "openclaw");
}

function validIdentity(value) {
  return uuid(value?.executionId) && uuid(value?.runId) && EXTERNAL_BACKENDS.has(value?.backendId)
    && id(value?.agentId);
}

function validExternalSnapshot(value) {
  return exact(value, SNAPSHOT_FIELDS) && validIdentity(value)
    && text(value.sessionKey, 512) && workspace(value.workspace) && validMode(value.backendId, value.mode)
    && EXTERNAL_STATUSES.has(value.status) && timestamp(value.sequence)
    && (value.resultSummary === null || text(value.resultSummary, 16 * 1024, true))
    && (value.errorCode === null || (id(value.errorCode) && /^[A-Z][A-Z0-9_]*$/u.test(value.errorCode)))
    && (EXTERNAL_TERMINAL.has(value.status) ? timestamp(value.finishedAt) : value.finishedAt === null)
    && validInspirationAttention(value.attention, value.runId);
}

function validateExternalInspirationParams(method, value) {
  if (!EXTERNAL_INSPIRATION_METHODS.includes(method) || !validIdentity(value)) return false;
  if (method === "inspiration.external.prepare") {
    return exact(value, [...COMMON_FIELDS, "operationId"]) && id(value.operationId)
      && (value.sessionKey === null || text(value.sessionKey, 512))
      && (value.workspace === null || workspace(value.workspace));
  }
  const additional = method.endsWith(".start") ? ["prompt", "operationId"]
    : method.endsWith(".respond") ? ["requestId", "response", "operationId"]
      : method.endsWith(".cancel") ? ["operationId"] : [];
  if (!exact(value, [...BOUND_FIELDS, ...additional]) || !uuid(value.hostId)
    || !text(value.sessionKey, 512) || !workspace(value.workspace) || !validMode(value.backendId, value.mode)
    || (additional.includes("operationId") && !id(value.operationId))) return false;
  if (method.endsWith(".start")) return text(value.prompt, 40 * 1024);
  if (method.endsWith(".respond")) {
    const response = value.response;
    return id(value.requestId) && (exact(response, ["choice"])
      ? ["once", "session", "deny", "cancel"].includes(response.choice)
      : exact(response, ["action", "answers"]) && ["submit", "cancel"].includes(response.action)
        && response.answers && typeof response.answers === "object" && !Array.isArray(response.answers)
        && Object.getPrototypeOf(response.answers) === Object.prototype
        && Object.keys(response.answers).length <= 32
        && Object.entries(response.answers).every(([key, answer]) => id(key) && text(answer, 16 * 1024, true)))
      && Buffer.byteLength(JSON.stringify(response)) <= 24 * 1024;
  }
  return true;
}

function validateExternalInspirationResult(method, value) {
  if (!EXTERNAL_INSPIRATION_METHODS.includes(method) || !uuid(value?.hostId)) return false;
  if (method === "inspiration.external.prepare") {
    return exact(value, ["hostId", "binding"]) && exact(value.binding, ["sessionKey", "workspace", "mode"])
      && text(value.binding.sessionKey, 512) && workspace(value.binding.workspace)
      && EXTERNAL_MODES.has(value.binding.mode);
  }
  return exact(value, ["hostId", "snapshot"]) && validExternalSnapshot(value.snapshot);
}

module.exports = {
  EXTERNAL_INSPIRATION_METHODS, EXTERNAL_BACKENDS, EXTERNAL_STATUSES, EXTERNAL_TERMINAL,
  validExternalSnapshot, validateExternalInspirationParams, validateExternalInspirationResult,
};
