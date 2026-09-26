"use strict";

const { RUNTIME_ACCOUNT_RUNTIMES } = require("./runtime-account");

const RUNTIME_ACCOUNT_SERVICE_METHODS = Object.freeze([
  "runtime.account.list",
  "runtime.account.read",
  "runtime.account.auth.read",
  "runtime.account.login.start",
  "runtime.account.login.cancel",
  "runtime.account.logout",
  "runtime.account.storage.read",
]);
const RUNTIME_ACCOUNT_SERVICE_METHOD_SET = new Set(RUNTIME_ACCOUNT_SERVICE_METHODS);
const RUNTIME_SET = new Set(RUNTIME_ACCOUNT_RUNTIMES);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const AUTH_STATUSES = new Set([
  "starting", "waiting", "succeeded", "failed", "canceling", "canceled",
  "timed_out", "interrupted", "unknown",
]);
const PUBLIC_MESSAGES = Object.freeze({
  INVALID_PARAMS: "请求参数无效",
  RUNTIME_ACCOUNT_NOT_FOUND: "运行环境账号不存在",
  RUNTIME_ACCOUNT_SERVICE_CLOSED: "运行环境账号服务不可用",
  RUNTIME_ACCOUNT_RESPONSE_INVALID: "运行环境账号响应无效",
  RUNTIME_ACCOUNT_AUTH_UNSUPPORTED: "此运行环境不支持在 Shoggoth Service 内登录或退出",
  RUNTIME_ACCOUNT_HOME_INVALID: "运行环境目录不安全",
  RUNTIME_ACCOUNT_HOME_MISSING: "运行环境目录不存在",
  AUTH_LOGIN_IN_PROGRESS: "登录已在进行中",
  AUTH_LOGIN_NOT_FOUND: "登录请求不存在",
  AUTH_LOGIN_NOT_ACTIVE: "登录请求已结束",
  AUTH_LOGIN_TIMEOUT: "登录已超时",
  AUTH_LOGIN_CANCELED: "登录已取消",
  AUTH_CANCEL_FAILED: "无法确认登录取消状态",
  AUTH_MANAGER_CLOSED: "登录服务不可用",
  AUTH_ACCOUNT_BINDING_INVALID: "运行环境账号绑定无效",
  RUNTIME_ACCOUNT_ACTIVE: "账号仍有任务运行，暂不能更改",
  RUNTIME_ACCOUNT_MUTATION_BUSY: "账号正在登录或退出",
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
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some((key) => typeof key !== "string")) return false;
  return Object.keys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true
      && Object.prototype.hasOwnProperty.call(descriptor, "value");
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

function validId(value, nullable = false) {
  return validString(value, 128, nullable) && (value === null || ID_PATTERN.test(value));
}

function validInteger(value, nullable = false) {
  return (nullable && value === null) || (Number.isSafeInteger(value) && value >= 0);
}

function cloneObject(value) {
  return Object.fromEntries(Object.keys(value).map((key) => [
    key, Object.getOwnPropertyDescriptor(value, key).value,
  ]));
}

function validatePageParams(params, includeAccount) {
  const fields = includeAccount
    ? ["runtimeAccountId", "cursor", "limit"] : ["cursor", "limit"];
  if (!exactObject(params, fields)
    || (includeAccount && !validId(params.runtimeAccountId, true))
    || !validString(params.cursor, 1024, true)
    || !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100) {
    throw protocolError("INVALID_PARAMS");
  }
  return cloneObject(params);
}

function validateRuntimeAccountServiceParams(method, params) {
  if (!RUNTIME_ACCOUNT_SERVICE_METHOD_SET.has(method)) throw protocolError("INVALID_PARAMS");
  if (method === "runtime.account.list") return validatePageParams(params, false);
  if ([
    "runtime.account.read", "runtime.account.auth.read", "runtime.account.logout",
    "runtime.account.storage.read",
  ].includes(method)) {
    if (!exactObject(params, ["runtimeAccountId"]) || !validId(params.runtimeAccountId)) {
      throw protocolError("INVALID_PARAMS");
    }
    return cloneObject(params);
  }
  if (method === "runtime.account.login.start") {
    if (!exactObject(params, ["runtimeAccountId", "mode"])
      || !validId(params.runtimeAccountId)
      || !["browser", "deviceCode"].includes(params.mode)) {
      throw protocolError("INVALID_PARAMS");
    }
    return cloneObject(params);
  }
  if (method === "runtime.account.login.cancel") {
    if (!exactObject(params, ["runtimeAccountId", "requestId"])
      || !validId(params.runtimeAccountId) || !validId(params.requestId)) {
      throw protocolError("INVALID_PARAMS");
    }
    return cloneObject(params);
  }
  throw protocolError("INVALID_PARAMS");
}

function validateAdmission(value) {
  if (!exactObject(value, [
    "generation", "active", "maxActive", "mutationActive", "backoffUntil",
  ]) || !Number.isSafeInteger(value.generation) || value.generation < 1
    || !validInteger(value.active) || !Number.isSafeInteger(value.maxActive)
    || value.maxActive < 1
    || typeof value.mutationActive !== "boolean"
    || !validInteger(value.backoffUntil, true)) throw protocolError("RUNTIME_ACCOUNT_RESPONSE_INVALID");
  return cloneObject(value);
}

function validateAccount(value) {
  if (!exactObject(value, [
    "id", "runtime", "kind", "installationKind", "homeKind", "isDefault",
    "sharedAgentCount", "admission",
  ]) || !validId(value.id) || !require("./runtime-adapter").validRuntime(value.runtime)
    || !["native-user", "shoggoth-managed"].includes(value.kind)
    || !["system", "bundled"].includes(value.installationKind)
    || !["system-default", "managed-shared"].includes(value.homeKind)
    || typeof value.isDefault !== "boolean" || !validInteger(value.sharedAgentCount)
    || value.sharedAgentCount > 10_000) throw protocolError("RUNTIME_ACCOUNT_RESPONSE_INVALID");
  return { ...cloneObject(value), admission: validateAdmission(value.admission) };
}

function validateStorage(value) {
  if (!exactObject(value, [
    "runtimeAccountId", "scope", "available", "bytes", "files", "dirs",
    "symlinks", "incomplete", "limitReason",
  ]) || !validId(value.runtimeAccountId)
    || !["native-system", "managed-account"].includes(value.scope)
    || typeof value.available !== "boolean" || !validInteger(value.bytes)
    || !validInteger(value.files) || !validInteger(value.dirs)
    || !validInteger(value.symlinks) || typeof value.incomplete !== "boolean"
    || (value.limitReason !== null
      && !["bytes", "depth", "duration", "entries"].includes(value.limitReason))
    || value.incomplete !== (value.limitReason !== null)
    || (!value.available && (value.bytes !== 0 || value.files !== 0 || value.dirs !== 0
      || value.symlinks !== 0 || value.incomplete))) {
    throw protocolError("RUNTIME_ACCOUNT_RESPONSE_INVALID");
  }
  return cloneObject(value);
}

function validatePage(result, key, validateItem) {
  if (!exactObject(result, [key, "nextCursor", "hasMore"])
    || !Array.isArray(result[key]) || result[key].length > 100
    || !validString(result.nextCursor, 1024, true)
    || typeof result.hasMore !== "boolean"
    || result.hasMore !== (result.nextCursor !== null)) {
    throw protocolError("RUNTIME_ACCOUNT_RESPONSE_INVALID");
  }
  const seen = new Set();
  const items = result[key].map((item) => {
    const safe = validateItem(item);
    if (seen.has(safe.id)) throw protocolError("RUNTIME_ACCOUNT_RESPONSE_INVALID");
    seen.add(safe.id);
    return safe;
  });
  return { [key]: items, nextCursor: result.nextCursor, hasMore: result.hasMore };
}

function validAuthUrl(value) {
  if (!validString(value, 4096) || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && Boolean(parsed.hostname)
      && !parsed.username && !parsed.password;
  } catch { return false; }
}

function validateAuthAccount(value) {
  if (value === null) return null;
  if (!ownDataObject(value) || !validString(value.type, 64)) {
    throw protocolError("RUNTIME_ACCOUNT_RESPONSE_INVALID");
  }
  if (value.type === "chatgpt") {
    if (!exactObject(value, value.planType === undefined ? ["type"] : ["type", "planType"])
      || (value.planType !== undefined && !validString(value.planType, 64))) {
      throw protocolError("RUNTIME_ACCOUNT_RESPONSE_INVALID");
    }
  } else if (value.type === "apiKey") {
    if (!exactObject(value, ["type"])) throw protocolError("RUNTIME_ACCOUNT_RESPONSE_INVALID");
  } else if (value.type === "amazonBedrock") {
    if (!exactObject(value, ["type", "usesCodexManagedCredentials"])
      || typeof value.usesCodexManagedCredentials !== "boolean") {
      throw protocolError("RUNTIME_ACCOUNT_RESPONSE_INVALID");
    }
  } else throw protocolError("RUNTIME_ACCOUNT_RESPONSE_INVALID");
  return cloneObject(value);
}

function validateAuthRead(result) {
  if (!exactObject(result, ["account", "requiresOpenaiAuth", "login",
    ...(result?.authSource === undefined ? [] : ["authSource"])])
    || (result.authSource !== undefined
      && (result.authSource !== "native-codex" || result.account?.type !== "chatgpt"))
    || typeof result.requiresOpenaiAuth !== "boolean") {
    throw protocolError("RUNTIME_ACCOUNT_RESPONSE_INVALID");
  }
  let login = null;
  if (result.login !== null) {
    if (!exactObject(result.login, ["requestId", "mode", "status", "updatedAt", "errorCode"])
      || !validId(result.login.requestId)
      || !["browser", "deviceCode"].includes(result.login.mode)
      || !AUTH_STATUSES.has(result.login.status) || !validInteger(result.login.updatedAt)
      || (result.login.errorCode !== null
        && (!validString(result.login.errorCode, 64)
          || !/^[A-Z][A-Z0-9_]*$/u.test(result.login.errorCode)))) {
      throw protocolError("RUNTIME_ACCOUNT_RESPONSE_INVALID");
    }
    login = cloneObject(result.login);
  }
  return {
    account: validateAuthAccount(result.account),
    requiresOpenaiAuth: result.requiresOpenaiAuth,
    login,
    ...(result.authSource === "native-codex" ? { authSource: "native-codex" } : {}),
  };
}

function validateLoginStart(result) {
  if (!ownDataObject(result) || !validId(result.requestId)
    || !["browser", "deviceCode"].includes(result.mode)
    || !["waiting", "succeeded", "failed"].includes(result.status)
    || !validString(result.loginId, 256)) throw protocolError("RUNTIME_ACCOUNT_RESPONSE_INVALID");
  if (result.mode === "browser") {
    if (!exactObject(result, ["requestId", "mode", "status", "loginId", "authUrl"])
      || !validAuthUrl(result.authUrl)) throw protocolError("RUNTIME_ACCOUNT_RESPONSE_INVALID");
  } else if (!exactObject(result, [
    "requestId", "mode", "status", "loginId", "verificationUrl", "userCode",
  ]) || !validAuthUrl(result.verificationUrl) || !validString(result.userCode, 256)) {
    throw protocolError("RUNTIME_ACCOUNT_RESPONSE_INVALID");
  }
  return cloneObject(result);
}

function validateRuntimeAccountServiceResult(method, result) {
  if (method === "runtime.account.list") return validatePage(result, "accounts", validateAccount);
  if (method === "runtime.account.read") {
    if (!exactObject(result, ["account"])) throw protocolError("RUNTIME_ACCOUNT_RESPONSE_INVALID");
    return { account: validateAccount(result.account) };
  }
  if (method === "runtime.account.auth.read") return validateAuthRead(result);
  if (method === "runtime.account.login.start") return validateLoginStart(result);
  if (method === "runtime.account.login.cancel") {
    if (!exactObject(result, ["requestId", "status"]) || !validId(result.requestId)
      || !AUTH_STATUSES.has(result.status) || ["starting", "waiting", "canceling"].includes(result.status)) {
      throw protocolError("RUNTIME_ACCOUNT_RESPONSE_INVALID");
    }
    return cloneObject(result);
  }
  if (method === "runtime.account.logout") {
    if (!exactObject(result, ["loggedOut"]) || result.loggedOut !== true) {
      throw protocolError("RUNTIME_ACCOUNT_RESPONSE_INVALID");
    }
    return { loggedOut: true };
  }
  if (method === "runtime.account.storage.read") return validateStorage(result);
  throw protocolError("RUNTIME_ACCOUNT_RESPONSE_INVALID");
}

function mapRuntimeAccountServiceError(error) {
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
  PUBLIC_MESSAGES,
  RUNTIME_ACCOUNT_SERVICE_METHODS,
  RUNTIME_ACCOUNT_SERVICE_METHOD_SET,
  mapRuntimeAccountServiceError,
  validateRuntimeAccountServiceParams,
  validateRuntimeAccountServiceResult,
};
