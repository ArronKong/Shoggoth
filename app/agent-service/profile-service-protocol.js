"use strict";

const { validModelCapabilities } = require("./chat-model-settings");

const {
  validateChatServiceResult,
} = require("./chat-service-protocol");

const PROFILE_SERVICE_METHODS = Object.freeze([
  "profile.models.list", "profile.auth.read", "profile.bind", "profile.configure", "profile.clear",
]);
const PROFILE_SERVICE_METHOD_SET = new Set(PROFILE_SERVICE_METHODS);
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const PUBLIC_MESSAGES = Object.freeze({
  INVALID_PARAMS: "请求参数无效",
  PROFILE_TARGET_FORBIDDEN: "只允许配置 Shoggoth 内置 Codex Profile",
  PROFILE_NOT_FOUND: "Shoggoth Profile 不存在",
  PROFILE_PROVIDER_NOT_FOUND: "Provider 不存在",
  PROFILE_PROVIDER_NOT_READY: "Provider 尚未通过本地协议验证",
  PROFILE_PROVIDER_TARGET_FORBIDDEN: "OpenAI Provider 已绑定其他 Profile",
  PROFILE_MODEL_MISMATCH: "模型与 Provider 配置不一致",
  PROFILE_MODEL_NOT_AVAILABLE: "所选模型不在当前 Agent 的可用目录中",
  PROFILE_MODEL_CATALOG_UNAVAILABLE: "暂时无法读取当前 Agent 的模型目录",
  PROFILE_AUTH_REQUIRED: "ChatGPT 尚未登录",
  PROFILE_AUTH_STATUS_UNAVAILABLE: "暂时无法验证 Agent CLI 登录状态",
  PROFILE_OPERATION_CONFLICT: "operationId 已用于其他 Profile 配置",
  PROFILE_ACCOUNT_BUSY: "该运行账号当前有任务或配置操作正在进行",
  PROFILE_OPERATION_EXPIRED: "Profile 配置操作已过期",
  PROFILE_SERVICE_CLOSED: "Profile 配置服务不可用",
  PROFILE_COMMIT_UNCERTAIN: "Profile 配置结果不确定，需要重启 Service",
  PROFILE_RESPONSE_INVALID: "Profile 配置响应无效",
  INTERNAL_ERROR: "Service 内部请求处理失败",
});

function protocolError(code) {
  const safeCode = Object.prototype.hasOwnProperty.call(PUBLIC_MESSAGES, code)
    ? code : "INTERNAL_ERROR";
  const error = new Error(PUBLIC_MESSAGES[safeCode]);
  error.code = safeCode;
  return error;
}

function ownDataObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) return false;
  return Object.keys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, "value");
  });
}

function exactObject(value, fields) {
  return ownDataObject(value) && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function validString(value, maxBytes, nullable = false) {
  if (nullable && value === null) return true;
  return typeof value === "string" && value.length > 0 && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function validText(value, maxBytes) {
  return typeof value === "string" && value.isWellFormed() && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function validOpaqueId(value, nullable = false) {
  return validString(value, 128, nullable) && (value === null || OPAQUE_ID_PATTERN.test(value));
}

function cloneParams(value) {
  return Object.fromEntries(Object.keys(value).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return [key, descriptor.value];
  }));
}

function validateProfileServiceParams(method, params) {
  if (!PROFILE_SERVICE_METHOD_SET.has(method)) throw protocolError("INVALID_PARAMS");
  if (method === "profile.models.list") {
    if (!exactObject(params, ["profileId", "cursor", "limit"])
      || !validOpaqueId(params.profileId) || !validString(params.cursor, 1024, true)
      || !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100) {
      throw protocolError("INVALID_PARAMS");
    }
    return cloneParams(params);
  }
  if (method === "profile.auth.read") {
    if (!exactObject(params, ["profileId"]) || !validOpaqueId(params.profileId)) {
      throw protocolError("INVALID_PARAMS");
    }
    return cloneParams(params);
  }
  const fields = method === "profile.configure"
    ? ["operationId", "profileId", "providerRef", "defaultModel", "secret", "createdAt"]
    : ["operationId", "profileId", "providerRef", "defaultModel", "createdAt"];
  if (!exactObject(params, fields) || !validOpaqueId(params.operationId)
    || !validOpaqueId(params.profileId) || !validOpaqueId(params.providerRef, true)
    || !validString(params.defaultModel, 512, method === "profile.clear")
    || !Number.isSafeInteger(params.createdAt) || params.createdAt < 0
    || (method === "profile.configure"
      && (params.providerRef === null || !validString(params.secret, 64 * 1024)
        || Buffer.byteLength(params.secret, "utf8") < 4))
    || (method === "profile.clear"
      && ((params.providerRef === null) !== (params.defaultModel === null)))) {
    throw protocolError("INVALID_PARAMS");
  }
  return cloneParams(params);
}

function validateProfileServiceResult(method, result) {
  if (method === "profile.auth.read") {
    if (!exactObject(result, ["status"])
      || !["authenticated", "unverified", "unauthenticated"].includes(result.status)) {
      throw protocolError("PROFILE_RESPONSE_INVALID");
    }
    return { status: result.status };
  }
  if (method === "profile.models.list") {
    if (!exactObject(result, ["models", "nextCursor", "hasMore"])
      || !Array.isArray(result.models) || result.models.length > 100
      || !validString(result.nextCursor, 1024, true)
      || typeof result.hasMore !== "boolean"
      || result.hasMore !== (result.nextCursor !== null)) {
      throw protocolError("PROFILE_RESPONSE_INVALID");
    }
    const seen = new Set();
    const models = result.models.map((model) => {
      if (!exactObject(model, ["id", "displayName", "description", "isDefault",
        ...(Object.hasOwn(model || {}, "capabilities") ? ["capabilities"] : [])])
        || (Object.hasOwn(model || {}, "capabilities") && !validModelCapabilities(model.capabilities))
        || !validString(model.id, 512) || !validString(model.displayName, 512)
        || !validText(model.description, 4096) || typeof model.isDefault !== "boolean"
        || seen.has(model.id)) {
        throw protocolError("PROFILE_RESPONSE_INVALID");
      }
      seen.add(model.id);
      return {
        id: model.id,
        displayName: model.displayName,
        description: model.description,
        isDefault: model.isDefault,
        ...(model.capabilities ? { capabilities: structuredClone(model.capabilities) } : {}),
      };
    });
    return { models, nextCursor: result.nextCursor, hasMore: result.hasMore };
  }
  if (!PROFILE_SERVICE_METHOD_SET.has(method) || !exactObject(result, ["profile"])) {
    throw protocolError("PROFILE_RESPONSE_INVALID");
  }
  try {
    const profile = validateChatServiceResult("profile.list", {
      profiles: [Object.getOwnPropertyDescriptor(result, "profile").value],
      nextCursor: null,
      hasMore: false,
    }).profiles[0];
    return { profile };
  } catch {
    throw protocolError("PROFILE_RESPONSE_INVALID");
  }
}

function mapProfileServiceError(error) {
  let code = null;
  try {
    const descriptor = error && (typeof error === "object" || typeof error === "function")
      ? Object.getOwnPropertyDescriptor(error, "code") : null;
    if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
      && typeof descriptor.value === "string") code = descriptor.value;
  } catch {}
  if (!Object.prototype.hasOwnProperty.call(PUBLIC_MESSAGES, code)) code = "INTERNAL_ERROR";
  return Object.freeze({ code, message: PUBLIC_MESSAGES[code] });
}

module.exports = {
  PROFILE_SERVICE_METHODS,
  PUBLIC_MESSAGES,
  mapProfileServiceError,
  validateProfileServiceParams,
  validateProfileServiceResult,
};
