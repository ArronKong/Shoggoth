"use strict";

const { validateChatServiceResult } = require("./chat-service-protocol");

const AGENT_LIFECYCLE_METHODS = Object.freeze([
  "agent.create",
  "agent.update",
  "agent.archive",
  "agent.restore",
  "agent.lifecycle.list",
]);
const AGENT_LIFECYCLE_METHOD_SET = new Set(AGENT_LIFECYCLE_METHODS);
const LIFECYCLE_STATES = Object.freeze([
  "active", "updating", "provisioning", "archiving", "archive-repair", "archived", "restoring",
]);
const LIFECYCLE_STATE_SET = new Set(LIFECYCLE_STATES);
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const BACKEND_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

const PUBLIC_MESSAGES = Object.freeze({
  INVALID_PARAMS: "请求参数无效",
  AGENT_BACKEND_NOT_SUPPORTED: "当前后端不支持创建长期 Agent",
  AGENT_NOT_FOUND: "Agent 不存在",
  AGENT_NAME_CONFLICT: "当前后端已有同名 Agent",
  AGENT_PROFILE_CONFLICT: "Agent 设置已被其他操作更新",
  AGENT_PROTECTED: "内置 Agent 不可归档",
  AGENT_ACTIVE_RUNS: "Agent 仍有待执行或运行中的任务",
  AGENT_OPERATION_BUSY: "Agent 正在执行另一个生命周期操作",
  AGENT_OPERATION_CONFLICT: "operationId 已用于其他 Agent 操作",
  AGENT_OPERATION_EXPIRED: "Agent 操作已过期",
  AGENT_INITIALIZATION_FAILED: "Agent 初始化未完成，请重试",
  AGENT_RUNTIME_CLEANUP_FAILED: "Agent 已停止调度，但运行时清理尚未完成，请重试",
  AGENT_SERVICE_CLOSED: "Agent 生命周期服务不可用",
  AGENT_COMMIT_UNCERTAIN: "Agent 生命周期结果不确定，需要重启 Service",
  AGENT_RESPONSE_INVALID: "Agent 生命周期响应无效",
  INTERNAL_ERROR: "Service 内部请求处理失败",
});

function protocolError(code) {
  const safeCode = Object.hasOwn(PUBLIC_MESSAGES, code) ? code : "INTERNAL_ERROR";
  const error = new Error(PUBLIC_MESSAGES[safeCode]);
  error.code = safeCode;
  return error;
}

function ownDataObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    });
}

function exactObject(value, fields) {
  return ownDataObject(value) && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function validString(value, maxBytes, nullable = false) {
  if (nullable && value === null) return true;
  return typeof value === "string" && value.length > 0 && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function validOpaqueId(value, nullable = false) {
  return validString(value, 128, nullable) && (value === null || OPAQUE_ID_PATTERN.test(value));
}

function cloneParams(value) {
  return Object.fromEntries(Object.keys(value).map((key) => [
    key, Object.getOwnPropertyDescriptor(value, key).value,
  ]));
}

function validMutationEnvelope(params) {
  return validOpaqueId(params.operationId)
    && Number.isSafeInteger(params.createdAt) && params.createdAt >= 0;
}

function validateAgentLifecycleParams(method, params) {
  if (!AGENT_LIFECYCLE_METHOD_SET.has(method)) throw protocolError("INVALID_PARAMS");
  if (method === "agent.lifecycle.list") {
    if (!exactObject(params, ["backendId"]) || typeof params.backendId !== "string"
      || !BACKEND_ID_PATTERN.test(params.backendId)) throw protocolError("INVALID_PARAMS");
    return cloneParams(params);
  }
  if (method === "agent.create") {
    if (!exactObject(params, ["operationId", "backendId", "name", "defaultCwd", "createdAt"])
      || !validMutationEnvelope(params) || !BACKEND_ID_PATTERN.test(params.backendId)
      || !validString(params.name, 128) || !validString(params.defaultCwd, 4096, true)) {
      throw protocolError("INVALID_PARAMS");
    }
    return cloneParams(params);
  }
  const fields = method === "agent.update"
    ? ["operationId", "profileId", "name", "defaultCwd", "expectedUpdatedAt", "createdAt"]
    : ["operationId", "profileId", "expectedUpdatedAt", "createdAt"];
  if (!exactObject(params, fields) || !validMutationEnvelope(params)
    || !validOpaqueId(params.profileId)
    || !Number.isSafeInteger(params.expectedUpdatedAt) || params.expectedUpdatedAt < 0
    || (method === "agent.update"
      && (!validString(params.name, 128) || !validString(params.defaultCwd, 4096, true)))) {
    throw protocolError("INVALID_PARAMS");
  }
  return cloneParams(params);
}

function validateProfile(value) {
  try {
    return validateChatServiceResult("profile.list", {
      profiles: [value], nextCursor: null, hasMore: false,
    }).profiles[0];
  } catch {
    throw protocolError("AGENT_RESPONSE_INVALID");
  }
}

function validateAgentLifecycleResult(method, result) {
  if (!AGENT_LIFECYCLE_METHOD_SET.has(method)) throw protocolError("AGENT_RESPONSE_INVALID");
  if (method !== "agent.lifecycle.list") {
    if (!exactObject(result, ["profile"])) throw protocolError("AGENT_RESPONSE_INVALID");
    return { profile: validateProfile(result.profile) };
  }
  if (!exactObject(result, ["agents"]) || !Array.isArray(result.agents)
    || result.agents.length > 8192) throw protocolError("AGENT_RESPONSE_INVALID");
  const seen = new Set();
  const agents = result.agents.map((entry) => {
    if (!exactObject(entry, ["profile", "state", "pendingOperationId"])
      || !LIFECYCLE_STATE_SET.has(entry.state)
      || !validOpaqueId(entry.pendingOperationId, true)) {
      throw protocolError("AGENT_RESPONSE_INVALID");
    }
    const profile = validateProfile(entry.profile);
    if (seen.has(profile.id)) throw protocolError("AGENT_RESPONSE_INVALID");
    seen.add(profile.id);
    return { profile, state: entry.state, pendingOperationId: entry.pendingOperationId };
  });
  return { agents };
}

function mapAgentLifecycleError(error) {
  let code = null;
  try {
    const descriptor = error && (typeof error === "object" || typeof error === "function")
      ? Object.getOwnPropertyDescriptor(error, "code") : null;
    if (descriptor && Object.hasOwn(descriptor, "value")
      && typeof descriptor.value === "string") code = descriptor.value;
  } catch {}
  if (!Object.hasOwn(PUBLIC_MESSAGES, code)) code = "INTERNAL_ERROR";
  return Object.freeze({ code, message: PUBLIC_MESSAGES[code] });
}

module.exports = {
  AGENT_LIFECYCLE_METHODS,
  LIFECYCLE_STATES,
  PUBLIC_MESSAGES,
  mapAgentLifecycleError,
  validateAgentLifecycleParams,
  validateAgentLifecycleResult,
};
