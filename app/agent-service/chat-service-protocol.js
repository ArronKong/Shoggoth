"use strict";

const crypto = require("node:crypto");
const { validInteractiveApprovalChoice } = require("../core/shoggoth-interaction-contract");
const { PUBLIC_MESSAGES: INSPIRATION_PUBLIC_MESSAGES } = require("./inspiration-service-protocol");
const { validAttachments, attachmentFields } = require("./inspiration-media");
const { validModelSettings, validModelSettingsPatch } = require("./chat-model-settings");
const { validateRuntimeContextUsage, validateRuntimeContextCapabilities } = require("./runtime-context-usage");

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_ITEM_BYTES = 48 * 1024;
const MAX_CURSOR_BYTES = 512;
const MAX_PAGE_LIMIT = 100;
const MAX_CANONICAL_DEPTH = 64;
const MAX_QUERY_BYTES = 8 * 1024;
const MAX_POSITION_BYTES = 256;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const BACKEND_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const HISTORY_TYPES = new Set(["text", "thinking", "plan", "tool", "status", "prompt", "error"]);
const HISTORY_ROLES = new Set(["user", "assistant", "toolResult", "system"]);
const COMMAND_CATEGORIES = new Set(["session", "model", "tools", "agents"]);
const SESSION_STATUSES = new Set(["draft", "binding", "ready", "archived", "delete_pending"]);
const WORK_RUN_SOURCES = new Set(["chat", "kanban", "cron", "inspiration", "compaction"]);
const WORK_RUN_STATUSES = new Set([
  "queued", "starting", "running", "waiting_approval", "waiting_input",
  "completed", "failed", "canceled", "interrupted", "skipped",
]);
const ACTIVE_WORK_RUN_STATUSES = new Set([
  "starting", "running", "waiting_approval", "waiting_input",
]);
const TERMINAL_WORK_RUN_STATUSES = new Set([
  "completed", "failed", "canceled", "interrupted", "skipped",
]);
// requestedStreamId=null 只由 Coordinator 的 terminal stream 重建分支产生。
// WeakSet 让普通 DTO 即使字段完全仿造，也不能绕过协议入口的来源检查。
const AUTHORITATIVE_NULL_RESET_GAPS = new WeakSet();

const CHAT_SERVICE_METHODS = Object.freeze([
  "profile.list",
  "chat.session.list",
  "chat.session.create",
  "chat.session.model.set",
  "chat.session.settings.set",
  "chat.session.permission.set",
  "chat.session.rename",
  "chat.session.archive",
  "chat.session.delete",
  "chat.history",
  "chat.search",
  "chat.command.list",
  "chat.command.exec",
  "chat.send",
  "chat.steer",
  "chat.abort",
  "run.list",
  "run.get",
  "run.subscribe",
  "run.approval.respond",
  "run.input.respond",
]);
const CHAT_SERVICE_METHOD_SET = new Set(CHAT_SERVICE_METHODS);

const PUBLIC_MESSAGES = Object.freeze({
  ...INSPIRATION_PUBLIC_MESSAGES,
  RUNTIME_AUTH_REQUIRED: "当前 Agent 尚未登录或登录已失效，请前往「设置」登录后重试",
  INVALID_PARAMS: "请求参数无效",
  SERVICE_UNAVAILABLE: "Shoggoth Service 暂时不可用",
  BACKEND_NOT_READY: "Shoggoth Agent 暂不可用",
  OPERATION_EXPIRED: "操作已超过幂等窗口",
  CHAT_OPERATION_ID_CONFLICT: "operationId 已用于其他操作",
  CHAT_SESSION_INVALID: "ChatSession 参数无效",
  CHAT_SESSION_NOT_FOUND: "ChatSession 不存在",
  CHAT_SESSION_NOT_READY: "ChatSession 当前不可执行该操作",
  CHAT_SESSION_DELETED: "ChatSession 已删除",
  CHAT_SESSION_CAPACITY: "ChatSession 幂等窗口容量已满",
  CHAT_SESSION_COMMIT_UNCERTAIN: "ChatSession 提交结果不确定",
  CHAT_SESSION_MODEL_CONFLICT: "请求模型与 Shoggoth Profile 默认模型不一致",
  CHAT_SESSION_MODEL_NOT_AVAILABLE: "该模型当前不可用",
  CHAT_SESSION_MODEL_SETTINGS_INVALID: "当前模型不支持该思考强度或快速模式",
  CHAT_SESSION_PERMISSION_INVALID: "该权限模式不可用",
  RUNTIME_CAPABILITY_UNSUPPORTED: "当前 Agent Runtime 不支持该操作",
  CHAT_SEND_TOO_LARGE: "消息超过本地协议上限",
  CHAT_ATTACHMENT_INVALID: "附件无效或超过限制，请重新添加（最多 8 个，总计 50 MB，单张图片 10 MB）",
  CHAT_HISTORY_CURSOR_INVALID: "聊天历史游标无效",
  CHAT_HISTORY_ITEM_TOO_LARGE: "单条聊天历史超过本地协议上限",
  CHAT_COMMAND_NOT_FOUND: "当前 Agent 不支持该命令",
  CHAT_COMMAND_SESSION_REQUIRED: "请先开始一次对话后再使用该命令",
  CHAT_COMMAND_UNAVAILABLE: "当前 Agent 的命令目录暂不可用",
  CHAT_COMMAND_CLI_ONLY: "该命令需要在对应 CLI 终端中使用，未发送给模型",
  CHAT_COMMAND_CLIENT_REQUIRED: "该命令需要通过 Shoggoth 对话界面执行",
  CHAT_RESPONSE_INVALID: "Chat Service 响应无效",
  WORK_RUN_NOT_FOUND: "Run 不存在",
  THREAD_ACTIVE_TURN_CONFLICT: "该会话已有活动任务",
  RUN_REQUEST_NOT_FOUND: "Run 等待请求不存在",
  RUN_REQUEST_STATE_CONFLICT: "Run 等待请求状态冲突",
  RUN_APPROVAL_DECISION_INVALID: "审批选择无效",
  RUN_INPUT_RESPONSE_INVALID: "补充输入无效",
  RUN_EVENT_CURSOR_INVALID: "Run event 游标无效",
  RUN_EVENT_SNAPSHOT_TOO_LARGE: "Run snapshot 超过本地协议上限",
  RUN_EVENT_TOO_LARGE: "单条 Run event 超过本地协议上限",
  RESPONSE_TOO_LARGE: "响应超过本地协议上限",
  INTERNAL_ERROR: "Service 内部请求处理失败",
});

const DIRECT_INTERNAL_ERROR_MAP = Object.freeze({
  PENDING_COMMAND_IDEMPOTENCY_CONFLICT: "CHAT_OPERATION_ID_CONFLICT",
  PENDING_COMMAND_TIMESTAMP_INVALID: "INVALID_PARAMS",
  PENDING_COMMAND_CAPACITY: "CHAT_SESSION_CAPACITY",
  PENDING_COMMAND_COMMIT_UNCERTAIN: "CHAT_SESSION_COMMIT_UNCERTAIN",
  CHAT_BINDING_INVALID: "CHAT_SESSION_INVALID",
  CHAT_REMOTE_OPERATION_INVALID: "CHAT_SESSION_INVALID",
  CHAT_OPERATION_TIMESTAMP_INVALID: "INVALID_PARAMS",
  CHAT_SESSION_BINDING_CONFLICT: "CHAT_SESSION_NOT_READY",
  CHAT_REMOTE_OPERATION_CONFLICT: "CHAT_SESSION_NOT_READY",
  CODEX_HISTORY_CURSOR_INVALID: "CHAT_HISTORY_CURSOR_INVALID",
  CODEX_HISTORY_CURSOR_STALE: "CHAT_HISTORY_CURSOR_INVALID",
  CODEX_HISTORY_CURSOR_THREAD_MISMATCH: "CHAT_HISTORY_CURSOR_INVALID",
  WORK_RUN_NOT_FOUND: "WORK_RUN_NOT_FOUND",
  WORK_RUN_OPERATION_CONFLICT: "CHAT_OPERATION_ID_CONFLICT",
  WORK_RUN_CONTROL_MISMATCH: "RUN_REQUEST_NOT_FOUND",
  WORK_RUN_CONTROL_STALE: "RUN_REQUEST_STATE_CONFLICT",
  WORK_RUN_CONTROL_UNASSIGNED: "RUN_REQUEST_STATE_CONFLICT",
  WORK_RUN_CONTROL_BUSY: "RUN_REQUEST_STATE_CONFLICT",
  WORK_RUN_NOT_CONTROLLABLE: "RUN_REQUEST_STATE_CONFLICT",
  WORK_RUN_REQUEST_ID_INVALID: "RUN_REQUEST_NOT_FOUND",
  WORK_RUN_REQUEST_MISMATCH: "RUN_REQUEST_NOT_FOUND",
  WORK_RUN_REQUEST_UNROUTABLE: "RUN_REQUEST_NOT_FOUND",
  WORK_RUN_REQUEST_BUSY: "RUN_REQUEST_STATE_CONFLICT",
  WORK_RUN_APPROVAL_RESPONSE_INVALID: "RUN_APPROVAL_DECISION_INVALID",
  WORK_RUN_INPUT_RESPONSE_INVALID: "RUN_INPUT_RESPONSE_INVALID",
  WORK_RUN_COORDINATOR_CLOSED: "SERVICE_UNAVAILABLE",
  WORK_RUN_COORDINATOR_CLOSING: "SERVICE_UNAVAILABLE",
  THREAD_ACTIVE_TURN_CONFLICT: "THREAD_ACTIVE_TURN_CONFLICT",
  AUTH_REQUIRED: "RUNTIME_AUTH_REQUIRED",
  RUNTIME_AUTH_REQUIRED: "RUNTIME_AUTH_REQUIRED",
  CODEX_SYSTEM_BINARY_NOT_FOUND: "BACKEND_NOT_READY",
  CODEX_RUNTIME_VERSION_MISMATCH: "BACKEND_NOT_READY",
  CODEX_RUNTIME_VERSION_PROBE_FAILED: "BACKEND_NOT_READY",
  CODEX_SCHEMA_ERROR: "BACKEND_NOT_READY",
  RUNTIME_COMMAND_NOT_FOUND: "CHAT_COMMAND_NOT_FOUND",
  RUNTIME_COMMAND_SESSION_REQUIRED: "CHAT_COMMAND_SESSION_REQUIRED",
  RUNTIME_COMMAND_PARAMS_INVALID: "INVALID_PARAMS",
  RUNTIME_COMMAND_CATALOG_INVALID: "CHAT_COMMAND_UNAVAILABLE",
  RUNTIME_COMMAND_CATALOG_UNAVAILABLE: "CHAT_COMMAND_UNAVAILABLE",
  RUNTIME_COMMAND_CLI_ONLY: "CHAT_COMMAND_CLI_ONLY",
  RUNTIME_COMMAND_CLIENT_REQUIRED: "CHAT_COMMAND_CLIENT_REQUIRED",
});

function protocolError(code) {
  const safeCode = Object.prototype.hasOwnProperty.call(PUBLIC_MESSAGES, code)
    ? code : "INTERNAL_ERROR";
  const error = new Error(PUBLIC_MESSAGES[safeCode]);
  error.code = safeCode;
  return error;
}

function failParams() {
  throw protocolError("INVALID_PARAMS");
}

function failResponse(code = "CHAT_RESPONSE_INVALID") {
  throw protocolError(code);
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
  return ownDataObject(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function validString(value, maxBytes, nullable = false) {
  if (nullable && value === null) return true;
  return typeof value === "string" && value.length > 0 && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function validOpaqueIdWithLimit(value, maxBytes) {
  return validString(value, maxBytes) && OPAQUE_ID_PATTERN.test(value);
}

function validOpaqueId(value) {
  return validOpaqueIdWithLimit(value, 128);
}

function validUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function validTimestamp(value, nullable = false) {
  return (nullable && value === null) || (Number.isSafeInteger(value) && value >= 0);
}

function validLimit(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_PAGE_LIMIT;
}

function validCursor(value) {
  return value === null || (validString(value, MAX_CURSOR_BYTES)
    && Buffer.byteLength(value, "utf8") <= MAX_CURSOR_BYTES);
}

function validNullableOpaqueId(value) {
  return value === null || validOpaqueId(value);
}

function cloneCanonical(value, depth = 0, ancestors = new Set()) {
  if (depth > MAX_CANONICAL_DEPTH) failResponse();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!value.isWellFormed()) failResponse();
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) failResponse();
    return value;
  }
  if (!value || typeof value !== "object" || ancestors.has(value)) failResponse();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== value.length) failResponse();
      const output = [];
      for (let index = 0; index < value.length; index += 1) {
        if (keys[index] !== String(index)) failResponse();
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) failResponse();
        output.push(cloneCanonical(descriptor.value, depth + 1, ancestors));
      }
      return output;
    }
    if (!ownDataObject(value)) failResponse();
    const output = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: cloneCanonical(
          Object.getOwnPropertyDescriptor(value, key).value,
          depth + 1,
          ancestors,
        ),
        writable: true,
      });
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function cloneParams(value) {
  try {
    return cloneCanonical(value);
  } catch {
    failParams();
  }
}

function jsonlBytes(value) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { failResponse(); }
  return Buffer.byteLength(`${encoded}\n`, "utf8");
}

function validatePageParams(params, fields, extraCheck) {
  if (!exactObject(params, fields) || !validCursor(params.cursor)
    || !validLimit(params.limit) || !extraCheck(params)) failParams();
}

function validateOperationBase(params, fields) {
  return exactObject(params, fields) && validOpaqueId(params.operationId)
    && validTimestamp(params.createdAt);
}

function validAnswers(value) {
  if (!ownDataObject(value) || Object.keys(value).length > 32) return false;
  return Object.entries(value).every(([key, answer]) => validOpaqueId(key)
    && typeof answer === "string" && answer.isWellFormed()
    && !answer.includes("\0") && Buffer.byteLength(answer, "utf8") <= 16 * 1024);
}

function validateChatServiceParams(method, params) {
  if (!CHAT_SERVICE_METHOD_SET.has(method)) failParams();
  if (method === "profile.list") {
    validatePageParams(params, ["backendId", "cursor", "limit", "enabledOnly"],
      (value) => validString(value.backendId, 64)
        && BACKEND_ID_PATTERN.test(value.backendId)
        && typeof value.enabledOnly === "boolean");
  } else if (method === "chat.session.list") {
    validatePageParams(params, ["profileId", "cursor", "limit", "includeArchived"],
      (value) => validOpaqueId(value.profileId) && typeof value.includeArchived === "boolean");
  } else if (method === "chat.session.create") {
    if (!validateOperationBase(params, ["operationId", "profileId", "workspace", "createdAt"])
      || !validOpaqueId(params.profileId) || !validString(params.workspace, 4096, true)) failParams();
  } else if (method === "chat.session.model.set") {
    if (!exactObject(params, ["sessionKey", "model"])
      || !validUuid(params.sessionKey) || !validString(params.model, 512)) failParams();
  } else if (method === "chat.session.settings.set") {
    if (!exactObject(params, ["sessionKey", "patch"]) || !validUuid(params.sessionKey)
      || !validModelSettingsPatch(params.patch)) failParams();
  } else if (method === "chat.session.permission.set") {
    if (!exactObject(params, ["sessionKey", "mode"])
      || !validUuid(params.sessionKey) || !validString(params.mode, 64)) failParams();
  } else if (method === "chat.session.rename") {
    if (!validateOperationBase(params, ["operationId", "sessionKey", "title", "createdAt"])
      || !validUuid(params.sessionKey) || !validString(params.title, 512, true)) failParams();
  } else if (method === "chat.session.archive" || method === "chat.session.delete") {
    if (!validateOperationBase(params, ["operationId", "sessionKey", "createdAt"])
      || !validUuid(params.sessionKey)) failParams();
  } else if (method === "chat.history") {
    validatePageParams(params, ["sessionKey", "cursor", "limit"],
      (value) => validUuid(value.sessionKey));
  } else if (method === "chat.search") {
    if (!exactObject(params, ["profileId", "query", "limit"]) || !validOpaqueId(params.profileId)
      || !validString(params.query, 4096) || !params.query.trim()
      || !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 50) failParams();
  } else if (method === "chat.command.list") {
    if (!exactObject(params, ["sessionKey"]) || !validUuid(params.sessionKey)) failParams();
  } else if (method === "chat.command.exec") {
    if (!exactObject(params, ["sessionKey", "text"])
      || !validUuid(params.sessionKey) || !validString(params.text, MAX_FRAME_BYTES)
      || !params.text.trimStart().startsWith("/")) failParams();
  } else if (method === "chat.send") {
    if (!validateOperationBase(params, attachmentFields(params, ["operationId", "sessionKey", "prompt", "createdAt"]))
      || !validUuid(params.sessionKey)
      || (params.attachments !== undefined && !validAttachments(params.attachments))
      || !(validString(params.prompt, MAX_FRAME_BYTES) || (params.prompt === "" && params.attachments?.length))) failParams();
  } else if (method === "chat.steer") {
    if (!validateOperationBase(
      params,
      ["operationId", "sessionKey", "runId", "message", "createdAt"],
    ) || !validUuid(params.sessionKey) || !validNullableOpaqueId(params.runId)
      || !validString(params.message, MAX_FRAME_BYTES)) failParams();
  } else if (method === "chat.abort") {
    if (!validateOperationBase(params, ["operationId", "sessionKey", "runId", "createdAt"])
      || !validUuid(params.sessionKey) || !validNullableOpaqueId(params.runId)) failParams();
  } else if (method === "run.list") {
    validatePageParams(
      params,
      ["profileId", "sessionKey", "status", "cursor", "limit"],
      (value) => validNullableOpaqueId(value.profileId)
        && (value.sessionKey === null || validUuid(value.sessionKey))
        && (value.status === null || WORK_RUN_STATUSES.has(value.status)),
    );
  } else if (method === "run.get") {
    if (!exactObject(params, ["runId"]) || !validOpaqueId(params.runId)) failParams();
  } else if (method === "run.subscribe") {
    if (!exactObject(params, ["runId", "streamId", "afterSeq", "limit"])
      || !validOpaqueId(params.runId) || (params.streamId !== null && !validUuid(params.streamId))
      || !Number.isSafeInteger(params.afterSeq) || params.afterSeq < 0
      || !validLimit(params.limit)) failParams();
  } else if (method === "run.approval.respond") {
    if (!validateOperationBase(
      params,
      ["operationId", "createdAt", "runId", "requestId", "choice"],
    ) || !validOpaqueId(params.runId) || !validOpaqueId(params.requestId)
      || !validInteractiveApprovalChoice(params.choice)) failParams();
  } else if (method === "run.input.respond") {
    if (!validateOperationBase(
      params,
      ["operationId", "createdAt", "runId", "requestId", "action", "answers"],
    ) || !validOpaqueId(params.runId) || !validOpaqueId(params.requestId)
      || !["submit", "cancel"].includes(params.action) || !validAnswers(params.answers)
      || (params.action === "cancel" && Object.keys(params.answers).length !== 0)) failParams();
  }
  return cloneParams(params);
}

function validRequestId(value) {
  return (typeof value === "string" && validString(value, 256))
    || (typeof value === "number" && Number.isFinite(value));
}

function validateChatServiceRequest(request) {
  if (!exactObject(request, ["id", "token", "version", "method", "params"])
    || !validRequestId(request.id) || !validString(request.token, 1024)
    || !Number.isSafeInteger(request.version) || !CHAT_SERVICE_METHOD_SET.has(request.method)) {
    failParams();
  }
  const params = validateChatServiceParams(request.method, request.params);
  const canonical = {
    id: request.id,
    token: request.token,
    version: request.version,
    method: request.method,
    params,
  };
  if (jsonlBytes(canonical) > MAX_FRAME_BYTES) {
    throw protocolError(request.method === "chat.send" ? "CHAT_SEND_TOO_LARGE" : "INVALID_PARAMS");
  }
  return canonical;
}

function validateProfile(value) {
  const hasBindings = Object.hasOwn(value || {}, "defaultBindingId") || Object.hasOwn(value || {}, "bindingsRevision");
  const fields = [
    "id", "backendId", "agentId", "name", "runtime", "runtimeProfileId",
    "runtimeAccountId", "providerRef", "defaultModel", "defaultCwd", "permissionPolicy", "concurrency",
    "isDefault", "enabled", "createdAt", "updatedAt",
    ...(hasBindings ? ["defaultBindingId", "bindingsRevision"] : []),
  ];
  if (!exactObject(value, fields) || !validOpaqueId(value.id)
    || !validString(value.backendId, 64) || !BACKEND_ID_PATTERN.test(value.backendId)
    || !validOpaqueId(value.agentId)
    || !validString(value.name, 512)
    || typeof value.runtime !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(value.runtime)
    || !validOpaqueId(value.runtimeProfileId) || !validOpaqueId(value.runtimeAccountId)
    || !validString(value.providerRef, 128, true)
    || !validString(value.defaultModel, 512, true) || !validString(value.defaultCwd, 4096, true)
    || !exactObject(value.permissionPolicy, ["approvalPolicy", "sandbox"])
    || !["untrusted", "on-failure", "on-request", "never"].includes(
      value.permissionPolicy.approvalPolicy,
    ) || !["read-only", "workspace-write", "danger-full-access"].includes(
      value.permissionPolicy.sandbox,
    ) || !exactObject(value.concurrency, ["maxActive", "maxWorkspaceWrites"])
    || (value.concurrency.maxActive !== null
      && (!Number.isSafeInteger(value.concurrency.maxActive) || value.concurrency.maxActive < 1))
    || (value.concurrency.maxWorkspaceWrites !== null
      && (!Number.isSafeInteger(value.concurrency.maxWorkspaceWrites)
        || value.concurrency.maxWorkspaceWrites < 0))
    || typeof value.isDefault !== "boolean" || typeof value.enabled !== "boolean"
    || !validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt)
    || value.updatedAt < value.createdAt
    || (hasBindings && (!validUuid(value.defaultBindingId)
      || !Number.isSafeInteger(value.bindingsRevision) || value.bindingsRevision < 1))) failResponse();
  return cloneCanonical(value);
}

const SESSION_FIELDS = [
  "id", "sessionKey", "profileId", "runtimeSessionId", "workspace", "title",
  "modelOverride", "permissionMode", "status", "createdAt", "updatedAt",
];

function validateRuntimeSessionFields(value, recurse) {
  const { runtimeBindingId, retiredRuntimeSessions, revision, ...session } = value;
  if (!(runtimeBindingId === null || validUuid(runtimeBindingId)) || !Number.isSafeInteger(revision) || revision < 1
    || !Array.isArray(retiredRuntimeSessions) || retiredRuntimeSessions.length > 4096
    || retiredRuntimeSessions.some(item => !exactObject(item,
      ["bindingId", "runtime", "runtimeAccountId", "runtimeSessionId", "retiredAt"])
      || !validUuid(item.bindingId) || !validString(item.runtime, 64)
      || !validString(item.runtimeAccountId, 128) || !validString(item.runtimeSessionId, 512)
      || !validTimestamp(item.retiredAt))) failResponse();
  return { ...recurse(session), runtimeBindingId, retiredRuntimeSessions: cloneCanonical(retiredRuntimeSessions), revision };
}
function hasRuntimeSessionFields(value) {
  return ["runtimeBindingId", "retiredRuntimeSessions", "revision"].some(key => Object.hasOwn(value || {}, key));
}

function validateSession(value) {
  if (hasRuntimeSessionFields(value)) return validateRuntimeSessionFields(value, validateSession);
  if (Object.hasOwn(value || {}, "modelSettings")) {
    const { modelSettings, ...session } = value;
    if (!validModelSettings(modelSettings)) failResponse();
    return { ...validateSession(session), modelSettings: cloneCanonical(modelSettings) };
  }
  if (!exactObject(value, SESSION_FIELDS) || !validUuid(value.id) || !validUuid(value.sessionKey)
    || !validOpaqueId(value.profileId) || !validString(value.runtimeSessionId, 256, true)
    || !validString(value.workspace, 4096, true) || !validString(value.title, 512, true)
    || !validString(value.modelOverride, 512, true)
    || !validString(value.permissionMode, 64, true)
    || !SESSION_STATUSES.has(value.status) || !validTimestamp(value.createdAt)
    || !validTimestamp(value.updatedAt) || value.updatedAt < value.createdAt) failResponse();
  const unbound = value.status === "draft" || value.status === "binding";
  if (unbound && value.runtimeSessionId !== null) {
    failResponse();
  }
  return cloneCanonical(value);
}

function validateListedSession(value) {
  if (Object.hasOwn(value || {}, "productContext")) {
    const { productContext, ...session } = value;
    return { ...validateListedSession(session), productContext: require("./product-context-protocol").validateProductContext(productContext) };
  }
  if (hasRuntimeSessionFields(value)) return validateRuntimeSessionFields(value, validateListedSession);
  if (Object.hasOwn(value || {}, "contextUsage") || Object.hasOwn(value || {}, "contextCapabilities")) {
    const { contextUsage, contextCapabilities, ...session } = value;
    let usage, capabilities;
    try {
      usage = contextUsage === null ? null : validateRuntimeContextUsage(contextUsage);
      capabilities = validateRuntimeContextCapabilities(contextCapabilities);
    } catch { failResponse(); }
    if (usage !== null && usage.runtimeSessionId !== session.runtimeSessionId) failResponse();
    return { ...validateListedSession(session), contextUsage: usage, contextCapabilities: capabilities };
  }
  if (Object.hasOwn(value || {}, "cronJobId") || Object.hasOwn(value || {}, "cronRunIds")) {
    const { cronJobId, cronRunIds, ...session } = value;
    if (!validOpaqueId(cronJobId) || !Array.isArray(cronRunIds) || cronRunIds.length === 0
      || cronRunIds.length > 65_536 || cronRunIds.some((id) => !validOpaqueId(id))
      || new Set(cronRunIds).size !== cronRunIds.length || Object.hasOwn(session, "inspirationId")) failResponse();
    return { ...validateListedSession(session), cronJobId, cronRunIds: [...cronRunIds] };
  }
  if (Object.hasOwn(value || {}, "modelSettings")) {
    const { modelSettings, ...session } = value;
    if (!validModelSettings(modelSettings)) failResponse();
    return { ...validateListedSession(session), modelSettings: cloneCanonical(modelSettings) };
  }
  if (Object.hasOwn(value || {}, "inspirationId") || Object.hasOwn(value || {}, "inspirationTitle")) {
    const { inspirationId, inspirationTitle, ...session } = value;
    if (!validUuid(inspirationId) || !validString(inspirationTitle, 512)) failResponse();
    return { ...validateListedSession(session), inspirationId, inspirationTitle };
  }
  if (exactObject(value, SESSION_FIELDS)) {
    return { ...validateSession(value), derivedTitle: null };
  }
  if (!exactObject(value, [...SESSION_FIELDS, "derivedTitle"])
    || !validString(value.derivedTitle, 512, true)) failResponse();
  const session = Object.fromEntries(SESSION_FIELDS.map((field) => [field, value[field]]));
  return { ...validateSession(session), derivedTitle: value.derivedTitle };
}

function validateRemoteOperation(value, expectedKind) {
  const fields = [
    "operationId", "sessionKey", "kind", "title", "state",
    "createdAt", "updatedAt", "finishedAt",
  ];
  if (!exactObject(value, fields) || !validOpaqueId(value.operationId)
    || !validUuid(value.sessionKey) || value.kind !== expectedKind
    || !["pending", "completed"].includes(value.state)
    || (value.kind === "rename" ? !validString(value.title, 512, true) : value.title !== null)
    || !validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt)
    || value.updatedAt < value.createdAt || !validTimestamp(value.finishedAt, true)
    || (value.state === "pending" && value.finishedAt !== null)
    || (value.state === "completed"
      && (value.finishedAt === null || value.finishedAt < value.createdAt))) failResponse();
  return cloneCanonical(value);
}

function validateRun(value) {
  try { return require("./product-store").validateWorkRun(cloneCanonical(value)); }
  catch { failResponse(); }
}

function validateFragment(value) {
  return value === null || (exactObject(value, ["messageId", "index", "count"])
    && validOpaqueId(value.messageId) && Number.isSafeInteger(value.index) && value.index >= 0
    && Number.isSafeInteger(value.count) && value.count > 1 && value.index < value.count);
}

function validateHistoryItem(value) {
  if (!exactObject(value, ["id", "runId", "role", "type", "payload", "createdAt", "fragment"])
    || !validOpaqueId(value.id) || !validNullableOpaqueId(value.runId)
    || !HISTORY_ROLES.has(value.role) || !HISTORY_TYPES.has(value.type)
    || !validTimestamp(value.createdAt) || !validateFragment(value.fragment)) failResponse();
  const item = cloneCanonical(value);
  if (jsonlBytes(item) > MAX_ITEM_BYTES) failResponse("CHAT_HISTORY_ITEM_TOO_LARGE");
  return item;
}

function validCommandText(value, maxBytes, nullable = false) {
  return (nullable && value === null) || (typeof value === "string" && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes);
}

function validateRuntimeCommand(value) {
  if (!exactObject(value, ["name", "description", "args", "category", "aliases",
    ...(Object.hasOwn(value || {}, "source") ? ["source"] : []),
    ...(Object.hasOwn(value || {}, "execution") ? ["execution"] : []),
  ])
    || !validCommandText(value.name, 128)
    || !/^[a-z0-9_][a-z0-9._:-]*$/u.test(value.name)
    || !validCommandText(value.description, 16 * 1024)
    || !validCommandText(value.args, 2 * 1024, true)
    || !COMMAND_CATEGORIES.has(value.category)
    || !Array.isArray(value.aliases) || value.aliases.length > 32
    || value.aliases.some((alias) => !validCommandText(alias, 128)
      || !/^[a-z0-9_][a-z0-9._:-]*$/u.test(alias))
    || new Set(value.aliases).size !== value.aliases.length
    || value.aliases.includes(value.name)
    || (value.source !== undefined && !validCommandText(value.source, 256))
    || (value.execution !== undefined && !["runtime", "client", "cli"].includes(value.execution))) failResponse();
  return cloneCanonical(value);
}

function validateRunEvent(value) {
  if (!exactObject(value, ["runId", "streamId", "seq", "type", "payload"])
    || !validOpaqueId(value.runId) || !validUuid(value.streamId)
    || !Number.isSafeInteger(value.seq) || value.seq < 1
    || !validString(value.type, 128) || !/^[a-z][a-z0-9._-]*$/u.test(value.type)) failResponse();
  const item = cloneCanonical(value);
  if (jsonlBytes(item) > MAX_ITEM_BYTES) failResponse("RUN_EVENT_TOO_LARGE");
  return item;
}

function validatePageResult(value, field, validator) {
  if (!exactObject(value, [field, "nextCursor", "hasMore"])
    || !Array.isArray(value[field]) || !validCursor(value.nextCursor)
    || typeof value.hasMore !== "boolean"
    || (value.hasMore ? value.nextCursor === null : value.nextCursor !== null)
    || value[field].length > MAX_PAGE_LIMIT) failResponse();
  return {
    [field]: value[field].map(validator),
    nextCursor: value.nextCursor,
    hasMore: value.hasMore,
  };
}

function validateGap(value, result) {
  if (value === null) return null;
  if (value?.code === "CURSOR_GAP") {
    if (!exactObject(value, ["code", "requestedAfterSeq", "baseSeq"])
      || !Number.isSafeInteger(value.requestedAfterSeq) || value.requestedAfterSeq < 0
      || value.baseSeq !== result.baseSeq || value.requestedAfterSeq >= value.baseSeq) failResponse();
  } else if (value?.code === "STREAM_RESET") {
    const authoritativeNullReset = value.requestedStreamId === null
      && AUTHORITATIVE_NULL_RESET_GAPS.has(value)
      && isAuthoritativeNullResetResult(result);
    if (!exactObject(value, [
      "code", "requestedStreamId", "currentStreamId", "requestedAfterSeq", "baseSeq", "latestSeq",
    ]) || (!validUuid(value.requestedStreamId) && !authoritativeNullReset)
      || value.currentStreamId !== result.streamId
      || value.requestedStreamId === value.currentStreamId
      || !Number.isSafeInteger(value.requestedAfterSeq) || value.requestedAfterSeq < 0
      || value.baseSeq !== result.baseSeq || value.latestSeq !== result.latestSeq) failResponse();
  } else failResponse();
  const gap = cloneCanonical(value);
  if (value.requestedStreamId === null) AUTHORITATIVE_NULL_RESET_GAPS.add(gap);
  return gap;
}

function terminalSnapshotRun(snapshot, runId) {
  if (!exactObject(snapshot, ["run"])) return null;
  let run;
  try { run = validateRun(snapshot.run); } catch { return null; }
  return run.id === runId && TERMINAL_WORK_RUN_STATUSES.has(run.status) ? run : null;
}

function isAuthoritativeNullResetResult(result) {
  return result?.gap?.code === "STREAM_RESET"
    && result.gap.requestedStreamId === null
    && result.baseSeq === 0 && result.latestSeq === 0
    && result.cursor === 0 && result.nextCursor === 0
    && result.hasMore === false && Array.isArray(result.events) && result.events.length === 0
    && terminalSnapshotRun(result.snapshot, result.runId) !== null;
}

function validateRunSubscribeResult(value) {
  const fields = [
    "runId", "streamId", "events", "cursor", "nextCursor", "hasMore",
    "baseSeq", "latestSeq", "gap", "snapshot",
  ];
  if (!exactObject(value, fields) || !validOpaqueId(value.runId) || !validUuid(value.streamId)
    || !Array.isArray(value.events) || value.events.length > MAX_PAGE_LIMIT
    || !Number.isSafeInteger(value.cursor) || value.cursor < 0
    || !Number.isSafeInteger(value.nextCursor) || value.nextCursor < value.cursor
    || typeof value.hasMore !== "boolean" || !Number.isSafeInteger(value.baseSeq)
    || value.baseSeq < 0 || !Number.isSafeInteger(value.latestSeq)
    || value.latestSeq < value.baseSeq || value.nextCursor > value.latestSeq) failResponse();
  const gap = validateGap(value.gap, value);
  const snapshot = value.snapshot === null ? null : cloneCanonical(value.snapshot);
  if (snapshot !== null && jsonlBytes(snapshot) > MAX_ITEM_BYTES) {
    failResponse("RUN_EVENT_SNAPSHOT_TOO_LARGE");
  }
  const events = value.events.map(validateRunEvent);
  let previousSeq = value.cursor;
  for (const item of events) {
    if (item.runId !== value.runId || item.streamId !== value.streamId
      || item.seq <= previousSeq || item.seq > value.latestSeq) failResponse();
    previousSeq = item.seq;
  }
  if (events.length > 0 && value.nextCursor !== events.at(-1).seq) failResponse();
  if (events.length === 0 && value.gap === null && value.nextCursor !== value.cursor) failResponse();
  if (gap !== null && (snapshot === null || events.length !== 0 || value.hasMore
    || value.cursor !== value.latestSeq || value.nextCursor !== value.latestSeq)) failResponse();
  if (gap === null && snapshot !== null) failResponse();
  if (value.hasMore && value.nextCursor >= value.latestSeq) failResponse();
  return {
    runId: value.runId,
    streamId: value.streamId,
    events,
    cursor: value.cursor,
    nextCursor: value.nextCursor,
    hasMore: value.hasMore,
    baseSeq: value.baseSeq,
    latestSeq: value.latestSeq,
    gap,
    snapshot,
  };
}

function validateChatServiceResult(method, result) {
  if (!CHAT_SERVICE_METHOD_SET.has(method)) failResponse();
  if (method === "profile.list") return validatePageResult(result, "profiles", validateProfile);
  if (method === "chat.session.list") {
    return validatePageResult(result, "sessions", validateListedSession);
  }
  if (method === "chat.session.create") {
    if (!exactObject(result, ["session"])) failResponse();
    return { session: validateSession(result.session) };
  }
  if (["chat.session.model.set", "chat.session.permission.set", "chat.session.settings.set"].includes(method)) {
    if (!exactObject(result, ["session"])) failResponse();
    return { session: validateSession(result.session) };
  }
  if (["chat.session.rename", "chat.session.archive", "chat.session.delete"].includes(method)) {
    if (!exactObject(result, ["session", "operation"])) failResponse();
    const kind = method.slice("chat.session.".length);
    const operation = validateRemoteOperation(result.operation, kind);
    const session = result.session === null ? null : validateSession(result.session);
    if (session !== null && session.sessionKey !== operation.sessionKey) failResponse();
    if (kind === "rename" && session !== null && session.title !== operation.title) failResponse();
    if (kind === "archive" && session?.status !== "archived") failResponse();
    if (kind === "delete" && session !== null && session.status !== "delete_pending") failResponse();
    return { session, operation };
  }
  if (method === "chat.history") return validatePageResult(result, "messages", validateHistoryItem);
  if (method === "chat.search") {
    if (!exactObject(result, ["results", "truncated"]) || !Array.isArray(result.results)
      || result.results.length > 50 || typeof result.truncated !== "boolean") failResponse();
    for (const item of result.results) {
      if (!exactObject(item, ["sessionKey", "messageId", "role", "ts", "snippet"])
        || !validUuid(item.sessionKey) || !validString(item.messageId, 512)
        || !["user", "assistant"].includes(item.role) || !validTimestamp(item.ts)
        || !validString(item.snippet, 1024)) failResponse();
    }
    return cloneCanonical(result);
  }
  if (method === "chat.command.list") {
    if (!exactObject(result, ["supported", "reason", "commands"])
      || typeof result.supported !== "boolean"
      || !validString(result.reason, 1024, true)
      || !Array.isArray(result.commands) || result.commands.length > 256
      || (!result.supported && result.reason === null)
      || (!result.supported && result.commands.length !== 0)) failResponse();
    const commands = result.commands.map(validateRuntimeCommand);
    const commandNames = commands.flatMap((command) => [command.name, ...command.aliases]);
    if (new Set(commandNames).size !== commandNames.length) failResponse();
    return { supported: result.supported, reason: result.reason, commands };
  }
  if (method === "chat.command.exec") {
    if (!exactObject(result, ["kind", "text", "warning"])
      || !["output", "send", "prefill"].includes(result.kind)
      || !validString(result.text, MAX_FRAME_BYTES)
      || !validString(result.warning, 16 * 1024, true)) failResponse();
    return cloneCanonical(result);
  }
  if (method === "chat.send") {
    if (!exactObject(result, ["disposition", "reason", "run"])
      || !["started", "queued", "completed"].includes(result.disposition)
      || !validString(result.reason, 128, true)
      || (result.disposition === "started" && result.reason !== null)
      || (result.disposition === "completed" && result.reason !== null)
      || (result.disposition === "queued" && result.reason === null)) failResponse();
    const run = validateRun(result.run);
    if ((result.disposition === "queued" && run.status !== "queued")
      || (result.disposition === "started" && !ACTIVE_WORK_RUN_STATUSES.has(run.status))
      || (result.disposition === "completed" && !TERMINAL_WORK_RUN_STATUSES.has(run.status))) {
      failResponse();
    }
    return { disposition: result.disposition, reason: result.reason, run };
  }
  if (method === "chat.steer") {
    if (!exactObject(result, ["accepted", "runId", "turnId"])
      || result.accepted !== true || !validOpaqueId(result.runId)
      || !validString(result.turnId, 256, true)) failResponse();
    return cloneCanonical(result);
  }
  if (method === "chat.abort") {
    if (!exactObject(result, ["run"])) failResponse();
    return { run: result.run === null ? null : validateRun(result.run) };
  }
  if (method === "run.list") return validatePageResult(result, "runs", validateRun);
  if (method === "run.get") {
    if (!exactObject(result, ["run"])) failResponse();
    return { run: validateRun(result.run) };
  }
  if (method === "run.subscribe") return validateRunSubscribeResult(result);
  if (method === "run.approval.respond" || method === "run.input.respond") {
    if (!exactObject(result, ["requestId", "state", "run"])
      || !validOpaqueId(result.requestId) || result.state !== "responded") failResponse();
    return { requestId: result.requestId, state: "responded", run: validateRun(result.run) };
  }
  failResponse();
}

function stableJson(value) {
  const canonical = cloneCanonical(value);
  function sort(entry) {
    if (Array.isArray(entry)) return entry.map(sort);
    if (!entry || typeof entry !== "object") return entry;
    return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, sort(entry[key])]));
  }
  const encoded = JSON.stringify(sort(canonical));
  if (Buffer.byteLength(encoded, "utf8") > MAX_QUERY_BYTES) failParams();
  return encoded;
}

function queryDigest(query) {
  return crypto.createHash("sha256").update(stableJson(query)).digest("base64url");
}

function createQueryCursorCodec(options = {}) {
  const secret = Buffer.isBuffer(options.secret)
    ? Buffer.from(options.secret)
    : typeof options.secret === "string" ? Buffer.from(options.secret, "utf8") : null;
  if (!secret || secret.length < 32 || secret.length > 1024) {
    throw new TypeError("cursor secret 必须是 32..1024 bytes");
  }
  function sign(payload) {
    return crypto.createHmac("sha256", secret).update(payload).digest();
  }
  return Object.freeze({
    encode(input) {
      if (!exactObject(input, ["query", "position"])
        || !validString(input.position, MAX_POSITION_BYTES)) failParams();
      const payload = Buffer.from(JSON.stringify({
        v: 1,
        q: queryDigest(input.query),
        p: input.position,
      }), "utf8");
      const cursor = `${payload.toString("base64url")}.${sign(payload).toString("base64url")}`;
      if (Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES) failParams();
      return cursor;
    },
    decode(cursor, expectedQuery) {
      if (!validString(cursor, MAX_CURSOR_BYTES)
        || Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES) failParams();
      const parts = cursor.split(".");
      if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))) failParams();
      let payload;
      let signature;
      try {
        payload = Buffer.from(parts[0], "base64url");
        signature = Buffer.from(parts[1], "base64url");
      } catch { failParams(); }
      if (payload.toString("base64url") !== parts[0]
        || signature.toString("base64url") !== parts[1]
        || signature.length !== 32 || !crypto.timingSafeEqual(signature, sign(payload))) failParams();
      let parsed;
      try { parsed = JSON.parse(payload.toString("utf8")); } catch { failParams(); }
      if (!exactObject(parsed, ["v", "q", "p"]) || parsed.v !== 1
        || parsed.q !== queryDigest(expectedQuery) || !validString(parsed.p, MAX_POSITION_BYTES)) {
        failParams();
      }
      return { position: parsed.p };
    },
  });
}

const PAGED_METHOD_FIELDS = Object.freeze({
  "profile.list": "profiles",
  "chat.session.list": "sessions",
  "chat.history": "messages",
  "run.list": "runs",
});

function queryForPage(method, params) {
  const queryParams = { ...params };
  delete queryParams.cursor;
  return { method, params: queryParams };
}

function responseFrameBytes(responseId, result) {
  if (!validRequestId(responseId) && responseId !== null) failResponse();
  return jsonlBytes({ id: responseId, ok: true, result });
}

function pageResult(field, items, nextCursor, hasMore) {
  return { [field]: items, nextCursor, hasMore };
}

function validateListItem(method, item) {
  if (method === "profile.list") return validateProfile(item);
  if (method === "chat.session.list") return validateListedSession(item);
  if (method === "chat.history") return validateHistoryItem(item);
  if (method === "run.list") return validateRun(item);
  failResponse();
}

function paginateChatServiceItems(options = {}) {
  const field = PAGED_METHOD_FIELDS[options.method];
  if (!field || !Array.isArray(options.entries)
    || !options.cursorCodec || typeof options.cursorCodec.encode !== "function"
    || typeof options.cursorCodec.decode !== "function") failResponse();
  const params = validateChatServiceParams(options.method, options.params);
  if (responseFrameBytes(options.responseId, pageResult(field, [], null, false)) > MAX_FRAME_BYTES) {
    throw protocolError("RESPONSE_TOO_LARGE");
  }
  const seen = new Set();
  const entries = options.entries.map((entry) => {
    if (!exactObject(entry, ["key", "item"]) || !validString(entry.key, MAX_POSITION_BYTES)
      || seen.has(entry.key)) failResponse();
    seen.add(entry.key);
    return { key: entry.key, item: validateListItem(options.method, entry.item) };
  }).sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  const query = queryForPage(options.method, params);
  let position = null;
  if (params.cursor !== null) {
    try {
      position = options.cursorCodec.decode(params.cursor, query).position;
    } catch {
      if (options.method === "chat.history") {
        throw protocolError("CHAT_HISTORY_CURSOR_INVALID");
      }
      failParams();
    }
  }
  const available = position === null ? entries : entries.filter((entry) => entry.key > position);
  const selected = [];
  for (let index = 0; index < available.length && selected.length < params.limit; index += 1) {
    const candidateItems = [...selected, available[index].item];
    const hasMore = index + 1 < available.length;
    const nextCursor = hasMore
      ? options.cursorCodec.encode({ query, position: available[index].key }) : null;
    const candidate = pageResult(field, candidateItems, nextCursor, hasMore);
    if (responseFrameBytes(options.responseId, candidate) > MAX_FRAME_BYTES) break;
    selected.push(available[index].item);
  }
  if (selected.length === 0 && available.length > 0) {
    if (options.method === "chat.history") failResponse("CHAT_HISTORY_ITEM_TOO_LARGE");
    failResponse();
  }
  const hasMore = selected.length < available.length;
  const nextCursor = hasMore
    ? options.cursorCodec.encode({ query, position: available[selected.length - 1].key }) : null;
  const result = validateChatServiceResult(
    options.method,
    pageResult(field, selected, nextCursor, hasMore),
  );
  if (responseFrameBytes(options.responseId, result) > MAX_FRAME_BYTES) {
    throw protocolError("RESPONSE_TOO_LARGE");
  }
  return result;
}

function validateRawSubscription(subscription) {
  if (!ownDataObject(subscription)) failResponse();
  const required = [
    "runId", "streamId", "events", "gap", "snapshot", "baseSeq", "latestSeq", "nextSeq",
  ];
  const allowed = new Set([...required, "unsubscribe"]);
  if (!required.every((field) => Object.prototype.hasOwnProperty.call(subscription, field))
    || Object.keys(subscription).some((field) => !allowed.has(field))
    || (Object.prototype.hasOwnProperty.call(subscription, "unsubscribe")
      && typeof subscription.unsubscribe !== "function")
    || !validOpaqueId(subscription.runId) || !validUuid(subscription.streamId)
    || !Array.isArray(subscription.events) || !Number.isSafeInteger(subscription.baseSeq)
    || subscription.baseSeq < 0 || !Number.isSafeInteger(subscription.latestSeq)
    || subscription.latestSeq < subscription.baseSeq
    || subscription.nextSeq !== subscription.latestSeq + 1) failResponse();
}

function expectedGapFor(params, subscription) {
  if (params.streamId !== null && params.streamId !== subscription.streamId) {
    return {
      code: "STREAM_RESET",
      requestedStreamId: params.streamId,
      currentStreamId: subscription.streamId,
      requestedAfterSeq: params.afterSeq,
      baseSeq: subscription.baseSeq,
      latestSeq: subscription.latestSeq,
    };
  }
  if (params.afterSeq < subscription.baseSeq) {
    return { code: "CURSOR_GAP", requestedAfterSeq: params.afterSeq, baseSeq: subscription.baseSeq };
  }
  return null;
}

function isAuthoritativeNullResetSubscription(params, subscription) {
  const gap = subscription.gap;
  return params.streamId === null
    && exactObject(gap, [
      "code", "requestedStreamId", "currentStreamId", "requestedAfterSeq", "baseSeq", "latestSeq",
    ])
    && gap.code === "STREAM_RESET" && gap.requestedStreamId === null
    && gap.currentStreamId === subscription.streamId
    && gap.requestedAfterSeq === params.afterSeq
    && gap.baseSeq === 0 && gap.latestSeq === 0
    && subscription.baseSeq === 0 && subscription.latestSeq === 0 && subscription.nextSeq === 1
    && subscription.events.length === 0
    && terminalSnapshotRun(subscription.snapshot, subscription.runId) !== null;
}

function sameJson(left, right) {
  return stableJson(left) === stableJson(right);
}

function paginateRunSubscription(options = {}) {
  const params = validateChatServiceParams("run.subscribe", options.params);
  validateRawSubscription(options.subscription);
  const subscription = options.subscription;
  if (subscription.runId !== params.runId) failResponse();
  if (params.streamId === subscription.streamId && params.afterSeq > subscription.latestSeq) {
    throw protocolError("RUN_EVENT_CURSOR_INVALID");
  }
  let expectedGap = expectedGapFor(params, subscription);
  if (expectedGap === null && isAuthoritativeNullResetSubscription(params, subscription)) {
    AUTHORITATIVE_NULL_RESET_GAPS.add(subscription.gap);
    expectedGap = subscription.gap;
  }
  if (!sameJson(subscription.gap, expectedGap)) failResponse();
  if (expectedGap !== null) {
    if (subscription.events.length !== 0 || subscription.snapshot === null) failResponse();
    const result = validateChatServiceResult("run.subscribe", {
      runId: subscription.runId,
      streamId: subscription.streamId,
      events: [],
      cursor: subscription.latestSeq,
      nextCursor: subscription.latestSeq,
      hasMore: false,
      baseSeq: subscription.baseSeq,
      latestSeq: subscription.latestSeq,
      gap: subscription.gap,
      snapshot: subscription.snapshot,
    });
    if (responseFrameBytes(options.responseId, result) > MAX_FRAME_BYTES) {
      throw protocolError("RUN_EVENT_SNAPSHOT_TOO_LARGE");
    }
    return result;
  }
  if (subscription.gap !== null || subscription.snapshot !== null) failResponse();
  const available = subscription.events.map(validateRunEvent);
  let previous = params.afterSeq;
  for (const item of available) {
    if (item.runId !== params.runId || item.streamId !== subscription.streamId
      || item.seq <= previous || item.seq > subscription.latestSeq) failResponse();
    previous = item.seq;
  }
  const selected = [];
  for (let index = 0; index < available.length && selected.length < params.limit; index += 1) {
    const candidateEvents = [...selected, available[index]];
    const nextCursor = candidateEvents.at(-1).seq;
    const candidate = {
      runId: params.runId,
      streamId: subscription.streamId,
      events: candidateEvents,
      cursor: params.afterSeq,
      nextCursor,
      hasMore: index + 1 < available.length,
      baseSeq: subscription.baseSeq,
      latestSeq: subscription.latestSeq,
      gap: null,
      snapshot: null,
    };
    if (responseFrameBytes(options.responseId, candidate) > MAX_FRAME_BYTES) break;
    selected.push(available[index]);
  }
  if (selected.length === 0 && available.length > 0) failResponse("RUN_EVENT_TOO_LARGE");
  const result = validateChatServiceResult("run.subscribe", {
    runId: params.runId,
    streamId: subscription.streamId,
    events: selected,
    cursor: params.afterSeq,
    nextCursor: selected.at(-1)?.seq ?? params.afterSeq,
    hasMore: selected.length < available.length,
    baseSeq: subscription.baseSeq,
    latestSeq: subscription.latestSeq,
    gap: null,
    snapshot: null,
  });
  if (responseFrameBytes(options.responseId, result) > MAX_FRAME_BYTES) {
    throw protocolError("RESPONSE_TOO_LARGE");
  }
  return result;
}

function mapChatServiceError(error) {
  const internalCode = typeof error?.code === "string" ? error.code : "";
  let publicCode = Object.prototype.hasOwnProperty.call(PUBLIC_MESSAGES, internalCode)
    ? internalCode : DIRECT_INTERNAL_ERROR_MAP[internalCode];
  if (!publicCode && (internalCode.startsWith("CODEX_")
    || internalCode.startsWith("RPC_")
    || internalCode.startsWith("PROVIDER_RUNTIME_"))) publicCode = "BACKEND_NOT_READY";
  if (!publicCode && (internalCode.startsWith("PENDING_COMMAND_")
    || internalCode.startsWith("WRITER_LEASE_")
    || internalCode.startsWith("PRIVATE_FILE_")
    || internalCode.startsWith("UNSAFE_")
    || internalCode.includes("PATH")
    || internalCode.endsWith("_STORE_CORRUPT")
    || internalCode.endsWith("_WRITE_FAILED")
    || internalCode.endsWith("_STORE_CLOSED")
    || internalCode === "LEASE_RELEASE_FAILED")) publicCode = "SERVICE_UNAVAILABLE";
  if (!Object.prototype.hasOwnProperty.call(PUBLIC_MESSAGES, publicCode)) publicCode = "INTERNAL_ERROR";
  return Object.freeze({ code: publicCode, message: PUBLIC_MESSAGES[publicCode] });
}

module.exports = {
  CHAT_SERVICE_METHODS,
  MAX_CURSOR_BYTES,
  MAX_FRAME_BYTES,
  MAX_ITEM_BYTES,
  MAX_PAGE_LIMIT,
  PUBLIC_MESSAGES,
  createQueryCursorCodec,
  mapChatServiceError,
  paginateChatServiceItems,
  paginateRunSubscription,
  validateChatServiceParams,
  validateChatServiceRequest,
  validateChatServiceResult,
};
