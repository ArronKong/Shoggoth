"use strict";

const { EXTERNAL_INSPIRATION_METHODS, validateExternalInspirationParams,
  validateExternalInspirationResult } = require("./external-inspiration-protocol");

const FEDERATION_PROTOCOL_VERSION = 1;
const FEDERATION_MAX_FRAME_BYTES = 64 * 1024;
const FEDERATION_METHODS = Object.freeze([
  "backend.status", "backend.require",
  "inspiration.executor.ready",
  "cron.list",
  "agent.list", "agent.get", "agent.create", "agent.update", "agent.delete",
  "agent.file.list", "agent.file.read", "agent.file.write",
  "agent.channels", "agent.artifacts", "agent.run",
  "federation.run", "federation.message", "federation.task.get", "federation.task.cancel",
  ...EXTERNAL_INSPIRATION_METHODS,
]);
const FEDERATION_METHOD_SET = new Set(FEDERATION_METHODS);
const BACKEND_IDS = new Set(["openclaw", "hermes"]);
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const EXTERNAL_ERROR_CODES = new Set([
  "INTERACTION_RESPONSE_INVALID",
  "HERMES_ACP_INTERACTION_UNSUPPORTED", "HERMES_CANCELLATION_UNCONFIRMED", "HERMES_EXECUTION_FAILED",
  "HERMES_EXECUTION_UNCONFIRMED", "HERMES_INSPIRATION_CONFLICT", "HERMES_INSPIRATION_INVALID_REQUEST",
  "HERMES_INSPIRATION_SESSION_UNCONFIRMED", "HERMES_INSPIRATION_TARGET_MISMATCH",
  "HERMES_INSPIRATION_WORKSPACE_UNCONFIRMED", "HERMES_INTERACTION_INVALID",
  "HERMES_INTERACTION_STALE", "HERMES_INTERACTION_UNSUPPORTED",
  "OPENCLAW_ADAPTER_INVALID", "OPENCLAW_AGENT_UNAVAILABLE", "OPENCLAW_APPROVAL_IDENTITY_MISMATCH",
  "OPENCLAW_APPROVAL_INVALID", "OPENCLAW_EXECUTION_IDENTITY_INVALID", "OPENCLAW_INSPECT_UNAVAILABLE",
  "OPENCLAW_INSPIRATION_SCOPE_REQUIRED", "OPENCLAW_INSPIRATION_UNSUPPORTED",
  "OPENCLAW_INTERACTION_IDENTITY_AMBIGUOUS", "OPENCLAW_INTERACTION_IDENTITY_UNAVAILABLE",
  "OPENCLAW_INTERACTION_RESPONSE_INVALID", "OPENCLAW_PROMPT_INVALID", "OPENCLAW_QUESTION_INVALID",
  "OPENCLAW_QUESTION_UNSUPPORTED", "OPENCLAW_REQUEST_STALE", "OPENCLAW_RESPONSE_UNCERTAIN",
  "OPENCLAW_RESPONSE_UNCONFIRMED", "OPENCLAW_RUN_FAILED", "OPENCLAW_RUN_TIMED_OUT",
  "OPENCLAW_SESSION_IDENTITY_MISMATCH", "OPENCLAW_START_IDENTITY_MISMATCH", "OPENCLAW_START_UNCERTAIN",
  "OPENCLAW_STOP_UNCONFIRMED", "OPENCLAW_TASK_IDENTITY_AMBIGUOUS", "OPENCLAW_TASK_IDENTITY_MISMATCH",
  "OPENCLAW_TASK_NOT_FOUND", "OPENCLAW_TASK_RESPONSE_INVALID", "OPENCLAW_TASK_SCAN_INCOMPLETE",
  "OPENCLAW_TASK_STATUS_UNKNOWN", "OPENCLAW_WORKSPACE_MISMATCH", "OPENCLAW_WORKSPACE_UNAVAILABLE",
]);

function isPublicExternalInspirationError(code) {
  return typeof code === "string" && (/^INSPIRATION_[A-Z0-9_]{1,112}$/u.test(code)
    || EXTERNAL_ERROR_CODES.has(code));
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function boundedString(value, maxBytes, options = {}) {
  return (options.nullable && value === null)
    || (typeof value === "string" && (options.allowEmpty || value.length > 0)
      && value.isWellFormed() && !value.includes("\0")
      && Buffer.byteLength(value, "utf8") <= maxBytes);
}

function validAgentId(value) {
  return boundedString(value, 128) && OPAQUE_ID_PATTERN.test(value);
}

function validBackendId(value) {
  return BACKEND_IDS.has(value);
}

function validOperationId(value) {
  return boundedString(value, 128) && /^mcp-v1-[a-f0-9]{48}$/u.test(value);
}

function validFileName(value) {
  return boundedString(value, 256) && !value.startsWith(".")
    && !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..";
}

function ownPatch(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => allowed.has(key));
}

function validAgentSpec(value, backendId) {
  const allowed = new Set(["name", "workspace", "model", "emoji", "cloneFromDefault", "noSkills"]);
  if (!ownPatch(value, allowed)) return false;
  for (const [key, item] of Object.entries(value)) {
    if (["cloneFromDefault", "noSkills"].includes(key)) {
      if (typeof item !== "boolean") return false;
    } else if (!boundedString(item, key === "workspace" ? 4096 : key === "model" ? 512 : 256,
      { allowEmpty: key === "emoji" })) return false;
  }
  return boundedString(value.name, 256)
    && (backendId !== "openclaw" || boundedString(value.workspace, 4096));
}

function validAgentPatch(value) {
  const allowed = new Set(["name", "workspace", "model", "emoji"]);
  if (!ownPatch(value, allowed)) return false;
  for (const [key, item] of Object.entries(value)) {
    if (!boundedString(item, key === "workspace" ? 4096 : key === "model" ? 512 : 256,
      { allowEmpty: key === "emoji" })) return false;
  }
  return true;
}

function validNullableTimestamp(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function validFederatedTask(value) {
  const statuses = new Set(["starting", "running", "waiting_input", "completed", "failed", "canceled"]);
  return exactObject(value, [
    "taskId", "sessionKey", "status", "turn", "waitingFor", "result", "errorCode",
  ])
    && boundedString(value.taskId, 256) && OPAQUE_ID_PATTERN.test(value.taskId)
    && boundedString(value.sessionKey, 512)
    && statuses.has(value.status)
    && Number.isSafeInteger(value.turn) && value.turn >= 1 && value.turn <= 32
    && value.waitingFor === (value.status === "waiting_input" ? "input" : null)
    && (value.result === null || boundedString(value.result, 32 * 1024, { allowEmpty: true }))
    && (value.errorCode === null
      || (boundedString(value.errorCode, 128) && /^[A-Z][A-Z0-9_]*$/u.test(value.errorCode)));
}

function validCronJob(value, backendId) {
  return exactObject(value, [
    "id", "backendId", "agentId", "name", "description", "scheduleDisplay",
    "enabled", "state", "stateLabel", "createdAt", "lastRunAt", "lastStatus",
    "nextRunAt", "model", "provider", "hasError",
  ])
    && boundedString(value.id, 256)
    && value.backendId === backendId
    && (value.agentId === null || boundedString(value.agentId, 128))
    && boundedString(value.name, 256)
    && (value.description === null || boundedString(value.description, 1024, { allowEmpty: true }))
    && (value.scheduleDisplay === null || boundedString(value.scheduleDisplay, 512, { allowEmpty: true }))
    && typeof value.enabled === "boolean"
    && (value.state === null || boundedString(value.state, 128, { allowEmpty: true }))
    && (value.stateLabel === null || boundedString(value.stateLabel, 256, { allowEmpty: true }))
    && validNullableTimestamp(value.createdAt)
    && validNullableTimestamp(value.lastRunAt)
    && (value.lastStatus === null || boundedString(value.lastStatus, 128, { allowEmpty: true }))
    && validNullableTimestamp(value.nextRunAt)
    && (value.model === null || boundedString(value.model, 512, { allowEmpty: true }))
    && (value.provider === null || boundedString(value.provider, 256, { allowEmpty: true }))
    && typeof value.hasError === "boolean";
}

function validateFederationParams(method, params) {
  if (!FEDERATION_METHOD_SET.has(method)) return false;
  if (EXTERNAL_INSPIRATION_METHODS.includes(method)) return validateExternalInspirationParams(method, params);
  if (method === "backend.status") return exactObject(params, []);
  // Read-only readiness includes native backends. Federation mutations retain
  // their existing external-backend allowlist below.
  if (method === "inspiration.executor.ready") return exactObject(params, ["backendId", "agentId"])
    && validAgentId(params.backendId) && validAgentId(params.agentId);
  if (method === "backend.require" || method === "agent.list") {
    return exactObject(params, ["backendId"]) && validBackendId(params.backendId);
  }
  if (method === "cron.list") {
    return exactObject(params, ["backendId", "enabled", "limit"])
      && validBackendId(params.backendId)
      && (params.enabled === null || typeof params.enabled === "boolean")
      && Number.isSafeInteger(params.limit) && params.limit >= 1 && params.limit <= 100;
  }
  if (["agent.get", "agent.file.list", "agent.channels"].includes(method)) {
    return exactObject(params, ["backendId", "agentId"])
      && validBackendId(params.backendId) && validAgentId(params.agentId);
  }
  if (method === "agent.artifacts") {
    return exactObject(params, ["backendId", "agentId", "limit"])
      && validBackendId(params.backendId) && validAgentId(params.agentId)
      && Number.isSafeInteger(params.limit) && params.limit >= 1 && params.limit <= 100;
  }
  if (method === "agent.create") {
    return exactObject(params, ["backendId", "spec", "operationId"])
      && validBackendId(params.backendId) && validAgentSpec(params.spec, params.backendId)
      && validOperationId(params.operationId);
  }
  if (method === "agent.update") {
    return exactObject(params, ["backendId", "agentId", "patch", "operationId"])
      && validBackendId(params.backendId) && validAgentId(params.agentId)
      && validAgentPatch(params.patch) && validOperationId(params.operationId);
  }
  if (method === "agent.delete") {
    return exactObject(params, ["backendId", "agentId", "operationId"])
      && validBackendId(params.backendId) && validAgentId(params.agentId)
      && validOperationId(params.operationId);
  }
  if (method === "agent.file.read") {
    return exactObject(params, ["backendId", "agentId", "file"])
      && validBackendId(params.backendId) && validAgentId(params.agentId)
      && validFileName(params.file);
  }
  if (method === "agent.file.write") {
    return exactObject(params, ["backendId", "agentId", "file", "content", "operationId"])
      && validBackendId(params.backendId) && validAgentId(params.agentId)
      && validFileName(params.file) && boundedString(params.content, 32 * 1024, { allowEmpty: true })
      && validOperationId(params.operationId);
  }
  if (method === "federation.run") {
    return exactObject(params, ["backendId", "agentId", "prompt", "timeoutMs", "operationId"])
      && validBackendId(params.backendId) && validAgentId(params.agentId)
      && boundedString(params.prompt, 16 * 1024)
      && Number.isSafeInteger(params.timeoutMs) && params.timeoutMs >= 5_000
      && params.timeoutMs <= 120_000 && validOperationId(params.operationId);
  }
  if (method === "federation.message") {
    return exactObject(params, [
      "backendId", "agentId", "taskId", "expectedTurn", "prompt", "timeoutMs", "operationId",
    ]) && validBackendId(params.backendId) && validAgentId(params.agentId)
      && boundedString(params.taskId, 256) && OPAQUE_ID_PATTERN.test(params.taskId)
      && Number.isSafeInteger(params.expectedTurn) && params.expectedTurn >= 1
      && params.expectedTurn <= 32 && boundedString(params.prompt, 16 * 1024)
      && Number.isSafeInteger(params.timeoutMs) && params.timeoutMs >= 5_000
      && params.timeoutMs <= 120_000 && validOperationId(params.operationId);
  }
  if (method === "federation.task.get") {
    return exactObject(params, ["backendId", "agentId", "taskId"])
      && validBackendId(params.backendId) && validAgentId(params.agentId)
      && boundedString(params.taskId, 256) && OPAQUE_ID_PATTERN.test(params.taskId);
  }
  if (method === "federation.task.cancel") {
    return exactObject(params, ["backendId", "agentId", "taskId", "operationId"])
      && validBackendId(params.backendId) && validAgentId(params.agentId)
      && boundedString(params.taskId, 256) && OPAQUE_ID_PATTERN.test(params.taskId)
      && validOperationId(params.operationId);
  }
  return method === "agent.run"
    && exactObject(params, ["backendId", "agentId", "prompt", "timeoutMs", "operationId"])
    && validBackendId(params.backendId) && validAgentId(params.agentId)
    && boundedString(params.prompt, 16 * 1024)
    && Number.isSafeInteger(params.timeoutMs) && params.timeoutMs >= 5_000 && params.timeoutMs <= 120_000
    && validOperationId(params.operationId);
}

function safeJsonValue(value, state = { nodes: 0 }, depth = 0) {
  if (++state.nodes > 8192 || depth > 24) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.isWellFormed() && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= 32 * 1024;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 256
    && value.every((item) => safeJsonValue(item, state, depth + 1));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length > 128) return false;
  return Object.keys(value).every((key) => boundedString(key, 256)
    && safeJsonValue(value[key], state, depth + 1));
}

function validateFederationResult(method, result, params) {
  if (!FEDERATION_METHOD_SET.has(method) || !safeJsonValue(result)) return false;
  if (EXTERNAL_INSPIRATION_METHODS.includes(method)) {
    if (!validateExternalInspirationResult(method, result)) return false;
    if (!params) return true;
    if (!validateExternalInspirationParams(method, params)) return false;
    if (method === "inspiration.external.prepare") {
      return (params.backendId === "openclaw" ? result.binding.mode === "openclaw" : result.binding.mode !== "openclaw")
        && (params.sessionKey === null || result.binding.sessionKey === params.sessionKey)
        && (params.workspace === null || result.binding.workspace === params.workspace);
    }
    return (method === "inspiration.external.get" || result.hostId === params.hostId)
      && ["executionId", "runId", "backendId", "agentId", "sessionKey", "workspace", "mode"]
      .every((field) => result.snapshot[field] === params[field]);
  }
  if (["backend.status", "backend.require"].includes(method)) {
    return exactObject(result, method === "backend.status" ? ["backends"] : ["backend"])
      && (method === "backend.status" ? Array.isArray(result.backends) : !!result.backend);
  }
  if (method === "inspiration.executor.ready") return exactObject(result, ["ready"])
    && typeof result.ready === "boolean";
  if (method === "agent.list") return exactObject(result, ["backendId", "agents"])
    && validBackendId(result.backendId) && Array.isArray(result.agents);
  if (method === "cron.list") {
    return exactObject(result, ["backendId", "total", "jobs"])
      && validBackendId(result.backendId)
      && Number.isSafeInteger(result.total) && result.total >= 0
      && Array.isArray(result.jobs) && result.jobs.length <= 100
      && result.total >= result.jobs.length
      && result.jobs.every((job) => validCronJob(job, result.backendId))
      && new Set(result.jobs.map((job) => job.id)).size === result.jobs.length;
  }
  if (["agent.get", "agent.create", "agent.update"].includes(method)) {
    return exactObject(result, ["agent"]) && result.agent && typeof result.agent === "object";
  }
  if (method === "agent.delete") return exactObject(result, ["backendId", "agentId", "deleted"])
    && validBackendId(result.backendId) && validAgentId(result.agentId) && result.deleted === true;
  if (method === "agent.file.list") return exactObject(result, ["files"]) && Array.isArray(result.files);
  if (["agent.file.read", "agent.file.write"].includes(method)) {
    return exactObject(result, ["file"]) && result.file && typeof result.file === "object";
  }
  if (method === "agent.channels") return exactObject(result, ["channels"])
    && Array.isArray(result.channels);
  if (method === "agent.artifacts") return exactObject(result, ["artifacts"])
    && result.artifacts && typeof result.artifacts === "object";
  if (["federation.run", "federation.message", "federation.task.get",
    "federation.task.cancel"].includes(method)) {
    return exactObject(result, ["task"]) && validFederatedTask(result.task);
  }
  return method === "agent.run" && exactObject(result, ["backendId", "agentId", "sessionKey", "text"])
    && validBackendId(result.backendId) && validAgentId(result.agentId)
    && boundedString(result.sessionKey, 512) && boundedString(result.text, 32 * 1024, { allowEmpty: true });
}

module.exports = {
  FEDERATION_MAX_FRAME_BYTES,
  FEDERATION_METHODS,
  FEDERATION_PROTOCOL_VERSION,
  isPublicExternalInspirationError,
  validateFederationParams,
  validateFederationResult,
};
