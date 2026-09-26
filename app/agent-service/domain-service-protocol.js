"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const {
  MAX_CURSOR_BYTES,
  MAX_FRAME_BYTES,
  MAX_ITEM_BYTES,
  MAX_PAGE_LIMIT,
  createQueryCursorCodec,
  validateChatServiceResult,
} = require("./chat-service-protocol");
const { CARD_STATUSES } = require("./native-kanban-store");
const {
  MISFIRE_POLICIES,
  OVERLAP_POLICIES,
  THREAD_POLICIES,
  computeNextOccurrence,
  normalizeSchedule,
} = require("./native-cron-store");
const {
  WORK_RUN_FIELDS,
  validateWorkRun,
} = require("./product-store");
const { WORK_RUN_STATUSES } = require("./work-run");

const MAX_CONTENT_PREVIEW_BYTES = 512;
const MAX_CONTENT_READ_BYTES = 32 * 1024;
const MAX_QUERY_POSITION_BYTES = 256;
const MAX_TEXT_BYTES = 1024 * 1024;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const DOMAIN_SERVICE_METHODS = Object.freeze([
  "kanban.board.list",
  "kanban.board.get",
  "kanban.board.create",
  "kanban.board.update",
  "kanban.card.list",
  "kanban.card.get",
  "kanban.card.body.read",
  "kanban.card.create",
  "kanban.card.update",
  "kanban.card.status.set",
  "kanban.card.archived.set",
  "kanban.card.complete.manual",
  "kanban.comment.list",
  "kanban.comment.body.read",
  "kanban.comment.add",
  "kanban.attachment.list",
  "kanban.artifact.list",
  "kanban.audit.list",
  "kanban.run.list",
  "kanban.run.dispatch",
  "kanban.run.retry",
  "cron.job.list",
  "cron.job.get",
  "cron.job.prompt.read",
  "cron.job.create",
  "cron.job.update",
  "cron.job.delete",
  "cron.job.enabled.set",
  "cron.run.list",
  "cron.run.trigger",
  "cron.run.retry",
]);
const DOMAIN_SERVICE_METHOD_SET = new Set(DOMAIN_SERVICE_METHODS);

const CONTENT_READ_METHODS = new Set([
  "kanban.card.body.read",
  "kanban.comment.body.read",
  "cron.job.prompt.read",
]);

const PUBLIC_MESSAGES = Object.freeze({
  INVALID_PARAMS: "请求参数无效",
  REQUEST_TOO_LARGE: "请求超过本地协议上限",
  DOMAIN_RESPONSE_INVALID: "Kanban/Cron Service 响应无效",
  DOMAIN_ITEM_TOO_LARGE: "单条列表数据超过本地协议上限",
  CONTENT_CURSOR_INVALID: "内容游标无效",
  CONTENT_CHUNK_TOO_LARGE: "内容分块超过本地协议上限",
  RESOURCE_CHANGED: "资源内容已变更，请重新读取",
  RESPONSE_TOO_LARGE: "响应超过本地协议上限",
  OPERATION_ID_CONFLICT: "operationId 已用于其他操作",
  OPERATION_EXPIRED: "操作已超过幂等窗口",
  KANBAN_BOARD_NOT_FOUND: "Board 不存在",
  KANBAN_CARD_NOT_FOUND: "Card 不存在",
  KANBAN_COMMENT_NOT_FOUND: "Comment 不存在",
  CRON_JOB_NOT_FOUND: "Cron Job 不存在",
  WORK_RUN_NOT_FOUND: "Run 不存在",
  STATE_CONFLICT: "当前状态不允许该操作",
  KANBAN_CAPACITY: "Kanban 容量已满",
  CRON_CAPACITY: "Cron 容量已满",
  KANBAN_COMMIT_UNCERTAIN: "Kanban 提交结果不确定，请刷新后确认",
  CRON_COMMIT_UNCERTAIN: "Cron 提交结果不确定，请刷新后确认",
  KANBAN_UNAVAILABLE: "Kanban Service 暂时不可用",
  CRON_UNAVAILABLE: "Cron Service 暂时不可用",
  SERVICE_UNAVAILABLE: "Shoggoth Service 暂时不可用",
  INTERNAL_ERROR: "Service 内部请求处理失败",
});

const DIRECT_INTERNAL_ERROR_MAP = Object.freeze({
  KANBAN_OPERATION_ID_CONFLICT: "OPERATION_ID_CONFLICT",
  CRON_OPERATION_ID_CONFLICT: "OPERATION_ID_CONFLICT",
  WORK_RUN_OPERATION_CONFLICT: "OPERATION_ID_CONFLICT",
  KANBAN_OPERATION_EXPIRED: "INVALID_PARAMS",
  CRON_OPERATION_EXPIRED: "INVALID_PARAMS",
  KANBAN_BOARD_NOT_FOUND: "KANBAN_BOARD_NOT_FOUND",
  KANBAN_CARD_NOT_FOUND: "KANBAN_CARD_NOT_FOUND",
  KANBAN_COMMENT_NOT_FOUND: "KANBAN_COMMENT_NOT_FOUND",
  CRON_JOB_NOT_FOUND: "CRON_JOB_NOT_FOUND",
  WORK_RUN_NOT_FOUND: "WORK_RUN_NOT_FOUND",
  KANBAN_STATUS_TRANSITION_INVALID: "STATE_CONFLICT",
  KANBAN_CARD_NOT_DISPATCHABLE: "STATE_CONFLICT",
  KANBAN_CARD_NOT_RETRYABLE: "STATE_CONFLICT",
  KANBAN_COMPLETION_REQUEST_INVALID: "STATE_CONFLICT",
  KANBAN_RUN_NOT_COMPLETED: "STATE_CONFLICT",
  CRON_RETRY_REFERENCE_INVALID: "STATE_CONFLICT",
  CRON_OVERLAP_SKIPPED: "STATE_CONFLICT",
  CRON_SCHEDULER_CLOSED: "CRON_UNAVAILABLE",
  CRON_SCHEDULER_CLOSING: "CRON_UNAVAILABLE",
  CRON_SCHEDULER_POISONED: "CRON_UNAVAILABLE",
  CRON_RUN_CORRUPT: "CRON_UNAVAILABLE",
  KANBAN_SERVICE_CLOSED: "KANBAN_UNAVAILABLE",
  KANBAN_COMMIT_UNCERTAIN: "KANBAN_COMMIT_UNCERTAIN",
  CRON_COMMIT_UNCERTAIN: "CRON_COMMIT_UNCERTAIN",
});

const DOMAIN_INPUT_ERROR_CODES = new Set([
  "KANBAN_TIMESTAMP_INVALID",
  "KANBAN_RETRY_TIMESTAMP_INVALID",
  "KANBAN_BOARD_INVALID",
  "KANBAN_CARD_INVALID",
  "KANBAN_COMMENT_INVALID",
  "KANBAN_ATTACHMENT_INVALID",
  "KANBAN_ARTIFACT_INVALID",
  "KANBAN_DISPATCH_INVALID",
  "KANBAN_RETRY_INVALID",
  "KANBAN_MANUAL_COMPLETION_INVALID",
  "CRON_TIMESTAMP_INVALID",
  "CRON_JOB_INVALID",
  "CRON_SCHEDULE_INVALID",
  "CRON_MANUAL_TRIGGER_INVALID",
  "CRON_RETRY_INVALID",
]);

const DOMAIN_STATE_ERROR_CODES = new Set([
  "KANBAN_RUN_BINDING_INVALID",
  "KANBAN_RUN_LINEAGE_INVALID",
  "KANBAN_RUN_LINK_MISSING",
  "KANBAN_RUN_STATUS_INVALID",
  "CRON_OVERLAP_QUEUE_FULL",
  "CRON_MISFIRE_SKIPPED",
  "CRON_JOB_DELETED",
]);

const BOARD_FIELDS = Object.freeze([
  "id", "profileId", "slug", "name", "description", "createdAt", "updatedAt",
]);
const CARD_FIELDS = Object.freeze([
  "id", "boardId", "profileId", "title", "bodyMeta", "status", "position",
  "archivedAt", "completionRequest", "completion", "createdAt", "updatedAt",
]);
const COMMENT_FIELDS = Object.freeze([
  "id", "cardId", "authorType", "authorId", "bodyMeta", "createdAt",
]);
const ATTACHMENT_FIELDS = Object.freeze([
  "id", "cardId", "name", "mimeType", "sizeBytes", "sha256", "storageKey", "createdAt",
]);
const ARTIFACT_FIELDS = Object.freeze([
  "id", "cardId", "runId", "name", "kind", "mimeType", "sizeBytes", "sha256",
  "storageKey", "createdAt",
]);
const AUDIT_FIELDS = Object.freeze([
  "id", "cardId", "kind", "actorId", "runId", "note", "createdAt",
]);
const CARD_RUN_LINK_FIELDS = Object.freeze([
  "id", "cardId", "runId", "retryOf", "createdAt",
]);
const CRON_JOB_FIELDS = Object.freeze([
  "id", "name", "enabled", "profileId", "promptMeta", "workspace", "schedule",
  "misfirePolicy", "maxCatchUp", "overlapPolicy", "threadPolicy", "threadId",
  "nextRunAt", "createdAt", "updatedAt",
]);
const CRON_RUN_ITEM_FIELDS = Object.freeze(["run", "kind", "createdAt"]);
const CONTENT_META_FIELDS = Object.freeze(["byteLength", "sha256", "preview"]);
const CONTENT_CHUNK_FIELDS = Object.freeze([
  "text", "offsetBytes", "totalBytes", "sha256", "nextCursor", "hasMore",
]);

function protocolError(code) {
  const safeCode = Object.prototype.hasOwnProperty.call(PUBLIC_MESSAGES, code)
    ? code : "INTERNAL_ERROR";
  const error = new Error(PUBLIC_MESSAGES[safeCode]);
  error.code = safeCode;
  return error;
}

function failParams(code = "INVALID_PARAMS") {
  throw protocolError(code);
}

function failResponse(code = "DOMAIN_RESPONSE_INVALID") {
  throw protocolError(code);
}

function ownDataObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) return false;
  return Object.keys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true
      && Object.prototype.hasOwnProperty.call(descriptor, "value")
      && descriptor.value !== undefined;
  });
}

function probeOwnDataValue(value, key) {
  try {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      return { ok: true, found: false, value: undefined };
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      return { ok: true, found: false, value: undefined };
    }
    return { ok: true, found: true, value: descriptor.value };
  } catch {
    return { ok: false, found: false, value: undefined };
  }
}

function exactObject(value, fields) {
  return ownDataObject(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function validString(value, maxBytes, options = {}) {
  if (options.nullable && value === null) return true;
  return typeof value === "string"
    && (options.allowEmpty === true || value.length > 0)
    && value.isWellFormed()
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= maxBytes;
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

function validSlug(value) {
  return validString(value, 64) && SLUG_PATTERN.test(value);
}

function validWorkRunId(value, nullable = false) {
  if (nullable && value === null) return true;
  return validOpaqueId(value);
}

function validTimestamp(value, nullable = false) {
  return (nullable && value === null) || (Number.isSafeInteger(value) && value >= 0);
}

function validLimit(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_PAGE_LIMIT;
}

function validCursor(value) {
  return value === null || validString(value, MAX_CURSOR_BYTES);
}

function validContentReadSize(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_CONTENT_READ_BYTES;
}

function validSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function cloneCanonical(value, depth = 0, ancestors = new Set()) {
  if (depth > 64) failResponse();
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
      return keys.map((key, index) => {
        if (key !== String(index)) failResponse();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable
          || descriptor.value === undefined) failResponse();
        return cloneCanonical(descriptor.value, depth + 1, ancestors);
      });
    }
    if (!ownDataObject(value)) failResponse();
    const output = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cloneCanonical(
          Object.getOwnPropertyDescriptor(value, key).value,
          depth + 1,
          ancestors,
        ),
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
  try {
    encoded = JSON.stringify(value);
  } catch {
    failResponse();
  }
  if (typeof encoded !== "string") failResponse();
  return Buffer.byteLength(`${encoded}\n`, "utf8");
}

function validOperationBase(value, fields) {
  return exactObject(value, fields)
    && validOpaqueId(value.operationId)
    && validTimestamp(value.createdAt);
}

function validPage(value, fields, predicate) {
  return exactObject(value, fields)
    && validCursor(value.cursor)
    && validLimit(value.limit)
    && predicate(value);
}

function validPatch(value, allowed, validators) {
  if (!ownDataObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0
    && keys.every((key) => allowed.includes(key) && validators[key](value[key]));
}

function validKanbanWorkspace(value) {
  return validString(value, 4096, { nullable: true });
}

function validCronWorkspace(value) {
  return value === null || (validString(value, 4096) && path.isAbsolute(value));
}

function validStorageKey(value) {
  if (!validString(value, 4096) || path.isAbsolute(value) || value.includes("\\")) return false;
  return value.split("/").every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

function validSchedule(value) {
  if (!ownDataObject(value)) return false;
  try {
    normalizeSchedule(value);
    return true;
  } catch {
    return false;
  }
}

function validThreadBinding(value) {
  return THREAD_POLICIES.has(value.threadPolicy)
    && (value.threadPolicy === "new"
      ? value.threadId === null
      : value.threadId === null || validOpaqueIdWithLimit(value.threadId, 256));
}

const BOARD_PATCH_VALIDATORS = Object.freeze({
  name: (value) => validString(value, 512),
  description: (value) => validString(value, 16 * 1024, { nullable: true, allowEmpty: true }),
});
const CARD_PATCH_VALIDATORS = Object.freeze({
  title: (value) => validString(value, 2048),
  body: (value) => validString(value, MAX_TEXT_BYTES, { nullable: true, allowEmpty: true }),
  position: (value) => Number.isSafeInteger(value) && value >= 0,
});
const CRON_PATCH_VALIDATORS = Object.freeze({
  name: (value) => validString(value, 512),
  prompt: (value) => validString(value, MAX_TEXT_BYTES),
  workspace: validCronWorkspace,
  schedule: validSchedule,
  misfirePolicy: (value) => MISFIRE_POLICIES.has(value),
  maxCatchUp: (value) => Number.isSafeInteger(value) && value >= 1 && value <= 100,
  overlapPolicy: (value) => OVERLAP_POLICIES.has(value),
  threadPolicy: (value) => THREAD_POLICIES.has(value),
  threadId: (value) => value === null || validOpaqueIdWithLimit(value, 256),
});

function validCronPatch(value) {
  if (!validPatch(value, Object.keys(CRON_PATCH_VALIDATORS), CRON_PATCH_VALIDATORS)) {
    return false;
  }
  const hasThreadPolicy = Object.prototype.hasOwnProperty.call(value, "threadPolicy");
  const hasThreadId = Object.prototype.hasOwnProperty.call(value, "threadId");
  if (!hasThreadPolicy || !hasThreadId) return true;
  return value.threadPolicy === "new"
    ? value.threadId === null
    : value.threadId === null || validOpaqueIdWithLimit(value.threadId, 256);
}

function validCronCreateOccurrence(value) {
  return !value.enabled || value.schedule.kind !== "at"
    || value.schedule.at > value.createdAt;
}

function validateDomainServiceParams(method, params) {
  if (!DOMAIN_SERVICE_METHOD_SET.has(method)) failParams();
  let valid = false;
  if (method === "kanban.board.list") {
    valid = validPage(params, ["profileId", "cursor", "limit"],
      (value) => validUuid(value.profileId));
  } else if (method === "kanban.board.get") {
    valid = exactObject(params, ["boardId"]) && validUuid(params.boardId);
  } else if (method === "kanban.board.create") {
    valid = validOperationBase(
      params,
      ["operationId", "profileId", "slug", "name", "description", "createdAt"],
    ) && validUuid(params.profileId) && validSlug(params.slug)
      && validString(params.name, 512)
      && validString(params.description, 16 * 1024, { nullable: true, allowEmpty: true });
  } else if (method === "kanban.board.update") {
    valid = validOperationBase(params, ["operationId", "boardId", "patch", "createdAt"])
      && validUuid(params.boardId)
      && validPatch(params.patch, Object.keys(BOARD_PATCH_VALIDATORS), BOARD_PATCH_VALIDATORS);
  } else if (method === "kanban.card.list") {
    valid = validPage(params, ["boardId", "status", "cursor", "limit"],
      (value) => validUuid(value.boardId)
        && (value.status === null || CARD_STATUSES.has(value.status)));
  } else if (method === "kanban.card.get") {
    valid = exactObject(params, ["cardId"]) && validUuid(params.cardId);
  } else if (method === "kanban.card.body.read") {
    valid = exactObject(params, ["cardId", "cursor", "maxBytes"])
      && validUuid(params.cardId) && validCursor(params.cursor)
      && validContentReadSize(params.maxBytes);
  } else if (method === "kanban.card.create") {
    valid = validOperationBase(params, [
      "operationId", "boardId", "profileId", "title", "body", "status", "position", "createdAt",
    ]) && validUuid(params.boardId) && validUuid(params.profileId)
      && validString(params.title, 2048)
      && validString(params.body, MAX_TEXT_BYTES, { nullable: true, allowEmpty: true })
      && ["triage", "backlog"].includes(params.status)
      && Number.isSafeInteger(params.position) && params.position >= 0;
  } else if (method === "kanban.card.update") {
    valid = validOperationBase(params, ["operationId", "cardId", "patch", "createdAt"])
      && validUuid(params.cardId)
      && validPatch(params.patch, Object.keys(CARD_PATCH_VALIDATORS), CARD_PATCH_VALIDATORS);
  } else if (method === "kanban.card.status.set") {
    valid = validOperationBase(params, ["operationId", "cardId", "status", "createdAt"])
      && validUuid(params.cardId) && CARD_STATUSES.has(params.status)
      && params.status !== "done";
  } else if (method === "kanban.card.archived.set") {
    valid = validOperationBase(params, ["operationId", "cardId", "archived", "createdAt"])
      && validUuid(params.cardId) && typeof params.archived === "boolean";
  } else if (method === "kanban.card.complete.manual") {
    valid = validOperationBase(params, ["operationId", "cardId", "note", "createdAt"])
      && validUuid(params.cardId)
      && validString(params.note, 4096, { nullable: true, allowEmpty: true });
  } else if (method === "kanban.comment.list") {
    valid = validPage(params, ["cardId", "cursor", "limit"],
      (value) => validUuid(value.cardId));
  } else if (method === "kanban.comment.body.read") {
    valid = exactObject(params, ["commentId", "cursor", "maxBytes"])
      && validUuid(params.commentId) && validCursor(params.cursor)
      && validContentReadSize(params.maxBytes);
  } else if (method === "kanban.comment.add") {
    valid = validOperationBase(params, ["operationId", "cardId", "body", "createdAt"])
      && validUuid(params.cardId) && validString(params.body, 64 * 1024);
  } else if ([
    "kanban.attachment.list", "kanban.artifact.list", "kanban.audit.list",
  ].includes(method)) {
    valid = validPage(params, ["cardId", "cursor", "limit"],
      (value) => validUuid(value.cardId));
  } else if (method === "kanban.run.list") {
    valid = validPage(params, ["cardId", "status", "cursor", "limit"],
      (value) => validUuid(value.cardId)
        && (value.status === null || WORK_RUN_STATUSES.includes(value.status)));
  } else if (method === "kanban.run.dispatch") {
    valid = validOperationBase(params, ["operationId", "cardId", "workspace", "createdAt"])
      && validUuid(params.cardId) && validKanbanWorkspace(params.workspace);
  } else if (method === "kanban.run.retry") {
    valid = validOperationBase(
      params,
      ["operationId", "cardId", "retryOf", "workspace", "createdAt"],
    ) && validUuid(params.cardId) && validWorkRunId(params.retryOf)
      && validKanbanWorkspace(params.workspace);
  } else if (method === "cron.job.list") {
    valid = validPage(params, ["profileId", "enabled", "cursor", "limit"],
      (value) => validUuid(value.profileId)
        && (value.enabled === null || typeof value.enabled === "boolean"));
  } else if (method === "cron.job.get") {
    valid = exactObject(params, ["jobId"]) && validUuid(params.jobId);
  } else if (method === "cron.job.prompt.read") {
    valid = exactObject(params, ["jobId", "cursor", "maxBytes"])
      && validUuid(params.jobId) && validCursor(params.cursor)
      && validContentReadSize(params.maxBytes);
  } else if (method === "cron.job.create") {
    valid = validOperationBase(params, [
      "operationId", "name", "enabled", "profileId", "prompt", "workspace", "schedule",
      "misfirePolicy", "maxCatchUp", "overlapPolicy", "threadPolicy", "threadId", "createdAt",
    ]) && validString(params.name, 512) && typeof params.enabled === "boolean"
      && validUuid(params.profileId) && validString(params.prompt, MAX_TEXT_BYTES)
      && validCronWorkspace(params.workspace) && validSchedule(params.schedule)
      && MISFIRE_POLICIES.has(params.misfirePolicy)
      && Number.isSafeInteger(params.maxCatchUp) && params.maxCatchUp >= 1 && params.maxCatchUp <= 100
      && OVERLAP_POLICIES.has(params.overlapPolicy) && validThreadBinding(params)
      && validCronCreateOccurrence(params);
  } else if (method === "cron.job.update") {
    valid = validOperationBase(params, ["operationId", "jobId", "patch", "createdAt"])
      && validUuid(params.jobId)
      && validCronPatch(params.patch);
  } else if (method === "cron.job.delete") {
    valid = validOperationBase(params, ["operationId", "jobId", "createdAt"])
      && validUuid(params.jobId);
  } else if (method === "cron.job.enabled.set") {
    valid = validOperationBase(params, ["operationId", "jobId", "enabled", "createdAt"])
      && validUuid(params.jobId) && typeof params.enabled === "boolean";
  } else if (method === "cron.run.list") {
    valid = validPage(params, ["jobId", "status", "cursor", "limit"],
      (value) => validUuid(value.jobId)
        && (value.status === null || WORK_RUN_STATUSES.includes(value.status)));
  } else if (method === "cron.run.trigger") {
    valid = validOperationBase(params, ["operationId", "jobId", "createdAt"])
      && validUuid(params.jobId);
  } else if (method === "cron.run.retry") {
    valid = validOperationBase(params, ["operationId", "jobId", "retryOf", "createdAt"])
      && validUuid(params.jobId) && validWorkRunId(params.retryOf);
  }
  if (!valid) failParams();
  return cloneParams(params);
}

function validRequestId(value) {
  return (typeof value === "string" && validString(value, 256))
    || (typeof value === "number" && Number.isFinite(value));
}

function validateDomainServiceRequest(request) {
  if (!exactObject(request, ["id", "token", "version", "method", "params"])
    || !validRequestId(request.id) || !validString(request.token, 1024)
    || !Number.isSafeInteger(request.version) || !DOMAIN_SERVICE_METHOD_SET.has(request.method)) {
    failParams();
  }
  const params = validateDomainServiceParams(request.method, request.params);
  const canonical = {
    id: request.id,
    token: request.token,
    version: request.version,
    method: request.method,
    params,
  };
  if (jsonlBytes(canonical) > MAX_FRAME_BYTES) failParams("REQUEST_TOO_LARGE");
  return canonical;
}

function validateContentMeta(value, nullable = false) {
  if (nullable && value === null) return null;
  if (!exactObject(value, CONTENT_META_FIELDS)
    || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0
    || !validSha256(value.sha256)
    || !validString(value.preview, MAX_CONTENT_PREVIEW_BYTES, { allowEmpty: true })
    || Buffer.byteLength(value.preview, "utf8") > value.byteLength) failResponse();
  return cloneCanonical(value);
}

function validateCompletionRequest(value) {
  if (value === null) return null;
  if (!exactObject(value, ["runId", "requestedAt"])
    || !validWorkRunId(value.runId) || !validTimestamp(value.requestedAt)) failResponse();
  return cloneCanonical(value);
}

function validateCompletion(value) {
  if (value === null) return null;
  if (!ownDataObject(value) || !Object.prototype.hasOwnProperty.call(value, "mode")) failResponse();
  const mode = Object.getOwnPropertyDescriptor(value, "mode").value;
  if (mode === "run") {
    if (!exactObject(value, ["mode", "runId", "actorId", "at"])
      || !validWorkRunId(value.runId) || !validOpaqueId(value.actorId)
      || !validTimestamp(value.at)) failResponse();
  } else if (mode === "manual") {
    if (!exactObject(value, ["mode", "runId", "actorId", "at", "note"])
      || value.runId !== null || !validOpaqueId(value.actorId) || !validTimestamp(value.at)
      || !validString(value.note, 4096, { nullable: true, allowEmpty: true })) failResponse();
  } else {
    failResponse();
  }
  return cloneCanonical(value);
}

function validateBoard(value) {
  if (!exactObject(value, BOARD_FIELDS) || !validUuid(value.id)
    || !validUuid(value.profileId) || !validSlug(value.slug)
    || !validString(value.name, 512)
    || !validString(value.description, 16 * 1024, { nullable: true, allowEmpty: true })
    || !validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt)
    || value.updatedAt < value.createdAt) failResponse();
  return cloneCanonical(value);
}

function validateCard(value) {
  if (!exactObject(value, CARD_FIELDS) || !validUuid(value.id)
    || !validUuid(value.boardId) || !validUuid(value.profileId)
    || !validString(value.title, 2048) || !CARD_STATUSES.has(value.status)
    || !Number.isSafeInteger(value.position) || value.position < 0
    || !(value.archivedAt === null || validTimestamp(value.archivedAt))
    || !validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt)
    || value.updatedAt < value.createdAt) failResponse();
  const bodyMeta = validateContentMeta(value.bodyMeta, true);
  const completionRequest = validateCompletionRequest(value.completionRequest);
  const completion = validateCompletion(value.completion);
  if ((value.status === "done") !== (completion !== null)) failResponse();
  return {
    ...cloneCanonical(value),
    bodyMeta,
    completionRequest,
    completion,
  };
}

function validateComment(value) {
  if (!exactObject(value, COMMENT_FIELDS) || !validUuid(value.id)
    || !validUuid(value.cardId) || !["human", "agent", "product"].includes(value.authorType)
    || !validOpaqueId(value.authorId) || !validTimestamp(value.createdAt)) failResponse();
  return { ...cloneCanonical(value), bodyMeta: validateContentMeta(value.bodyMeta) };
}

function validateAttachment(value) {
  if (!exactObject(value, ATTACHMENT_FIELDS) || !validUuid(value.id)
    || !validUuid(value.cardId) || !validString(value.name, 1024)
    || !validString(value.mimeType, 256, { nullable: true })
    || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0
    || !validSha256(value.sha256) || !validStorageKey(value.storageKey)
    || !validTimestamp(value.createdAt)) failResponse();
  return cloneCanonical(value);
}

function validateArtifact(value) {
  if (!exactObject(value, ARTIFACT_FIELDS) || !validUuid(value.id)
    || !validUuid(value.cardId) || !validWorkRunId(value.runId)
    || !validString(value.name, 1024) || !validOpaqueIdWithLimit(value.kind, 64)
    || !validString(value.mimeType, 256, { nullable: true })
    || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0
    || !validSha256(value.sha256) || !validStorageKey(value.storageKey)
    || !validTimestamp(value.createdAt)) failResponse();
  return cloneCanonical(value);
}

function validateAuditEvent(value) {
  if (!exactObject(value, AUDIT_FIELDS) || !validUuid(value.id)
    || !validUuid(value.cardId) || value.kind !== "manual_completion"
    || !validOpaqueId(value.actorId) || value.runId !== null
    || !validString(value.note, 4096, { nullable: true, allowEmpty: true })
    || !validTimestamp(value.createdAt)) failResponse();
  return cloneCanonical(value);
}

function validateCardRunLink(value) {
  if (!exactObject(value, CARD_RUN_LINK_FIELDS) || !validUuid(value.id)
    || !validUuid(value.cardId) || !validWorkRunId(value.runId)
    || !validWorkRunId(value.retryOf, true) || value.retryOf === value.runId
    || !validTimestamp(value.createdAt)) failResponse();
  return cloneCanonical(value);
}

function validateRun(value, expectedSource = null) {
  if (!exactObject(value, WORK_RUN_FIELDS)) failResponse();
  let run;
  try {
    run = validateWorkRun(cloneCanonical(value));
    run = validateChatServiceResult("run.get", { run }).run;
  } catch {
    failResponse();
  }
  if (!validUuid(run.profileId)
    || (expectedSource !== null
      && (run.source !== expectedSource || !validUuid(run.sourceId)))) failResponse();
  return cloneCanonical(run);
}

function validateRunListBinding(run, params, sourceIdField) {
  if (run.sourceId !== params[sourceIdField]
    || (params.status !== null && run.status !== params.status)) failResponse();
  return run;
}

function validateKanbanRunItem(value, params) {
  if (Object.hasOwn(value || {}, "sessionKey")) {
    const { sessionKey, ...run } = value;
    if (!validUuid(sessionKey)) failResponse();
    return { ...validateKanbanRunItem(run, params), sessionKey };
  }
  return validateRunListBinding(validateRun(value, "kanban"), params, "cardId");
}

function validateCronRunItem(value, params) {
  if (Object.hasOwn(value || {}, "sessionKey")) {
    const { sessionKey, ...item } = value;
    if (!validUuid(sessionKey)) failResponse();
    return { ...validateCronRunItem(item, params), sessionKey };
  }
  if (!exactObject(value, CRON_RUN_ITEM_FIELDS)
    || !["schedule", "manual", "retry"].includes(value.kind)
    || !validTimestamp(value.createdAt)) failResponse();
  const run = validateRunListBinding(
    validateRun(value.run, "cron"), params, "jobId",
  );
  if ((value.kind === "retry") !== (run.retryOf !== null)) failResponse();
  return { run, kind: value.kind, createdAt: value.createdAt };
}

function validateCronJob(value) {
  if (!exactObject(value, CRON_JOB_FIELDS) || !validUuid(value.id)
    || !validString(value.name, 512) || typeof value.enabled !== "boolean"
    || !validUuid(value.profileId) || !validCronWorkspace(value.workspace)
    || !validSchedule(value.schedule) || !MISFIRE_POLICIES.has(value.misfirePolicy)
    || !Number.isSafeInteger(value.maxCatchUp) || value.maxCatchUp < 1 || value.maxCatchUp > 100
    || !OVERLAP_POLICIES.has(value.overlapPolicy) || !validThreadBinding(value)
    || !validTimestamp(value.nextRunAt, true) || !validTimestamp(value.createdAt)
    || !validTimestamp(value.updatedAt) || value.updatedAt < value.createdAt) failResponse();
  let schedule;
  try {
    schedule = normalizeSchedule(value.schedule);
  } catch {
    failResponse();
  }
  if (!value.enabled) {
    if (value.nextRunAt !== null) failResponse();
  } else {
    let expected;
    try {
      expected = computeNextOccurrence(schedule, value.updatedAt);
    } catch {
      failResponse();
    }
    if (expected === null || value.nextRunAt !== expected) failResponse();
  }
  return {
    ...cloneCanonical(value),
    promptMeta: validateContentMeta(value.promptMeta),
    schedule,
  };
}

function ensureItemSize(value) {
  if (jsonlBytes(value) > MAX_ITEM_BYTES) failResponse("DOMAIN_ITEM_TOO_LARGE");
  return value;
}

function denseDataArray(value) {
  if (!Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === value.length && keys.every((key, index) => {
    if (key !== String(index)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true
      && Object.prototype.hasOwnProperty.call(descriptor, "value")
      && descriptor.value !== undefined;
  });
}

function validatePageResult(value, field, validator) {
  if (!exactObject(value, [field, "nextCursor", "hasMore"])
    || !denseDataArray(value[field]) || value[field].length > MAX_PAGE_LIMIT
    || !validCursor(value.nextCursor) || typeof value.hasMore !== "boolean"
    || (value.hasMore ? value.nextCursor === null : value.nextCursor !== null)) failResponse();
  return {
    [field]: value[field].map((item) => ensureItemSize(validator(item))),
    nextCursor: value.nextCursor,
    hasMore: value.hasMore,
  };
}

function validateContentChunk(value) {
  if (!exactObject(value, CONTENT_CHUNK_FIELDS)) failResponse();
  if (typeof value.text === "string" && value.text.isWellFormed() && !value.text.includes("\0")
    && Buffer.byteLength(value.text, "utf8") > MAX_CONTENT_READ_BYTES) {
    failResponse("CONTENT_CHUNK_TOO_LARGE");
  }
  if (!validString(value.text, MAX_CONTENT_READ_BYTES, { allowEmpty: true })
    || !Number.isSafeInteger(value.offsetBytes) || value.offsetBytes < 0
    || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < value.offsetBytes
    || !validSha256(value.sha256) || !validCursor(value.nextCursor)
    || typeof value.hasMore !== "boolean"
    || (value.hasMore ? value.nextCursor === null : value.nextCursor !== null)) failResponse();
  const textBytes = Buffer.byteLength(value.text, "utf8");
  const end = value.offsetBytes + textBytes;
  if (textBytes > MAX_CONTENT_READ_BYTES || (value.hasMore && textBytes === 0)
    || end > value.totalBytes
    || (value.hasMore ? end >= value.totalBytes : end !== value.totalBytes)) failResponse();
  if (value.offsetBytes === 0 && !value.hasMore
    && crypto.createHash("sha256").update(value.text, "utf8").digest("hex") !== value.sha256) {
    failResponse();
  }
  const result = cloneCanonical(value);
  if (jsonlBytes(result) > MAX_ITEM_BYTES) failResponse("CONTENT_CHUNK_TOO_LARGE");
  return result;
}

function validateDispatchResult(value, params, retry) {
  if (!exactObject(value, ["run", "card", "link"])) failResponse();
  const run = validateRun(value.run, "kanban");
  const cardValue = validateCard(value.card);
  const link = validateCardRunLink(value.link);
  const expectedRetryOf = retry ? params.retryOf : null;
  if (cardValue.id !== params.cardId || run.sourceId !== params.cardId
    || run.sourceId !== cardValue.id || link.cardId !== cardValue.id
    || link.runId !== run.id || run.retryOf !== expectedRetryOf
    || link.retryOf !== expectedRetryOf) failResponse();
  return { run, card: cardValue, link };
}

function validatedResultParams(method, params) {
  try {
    return validateDomainServiceParams(method, params);
  } catch {
    failResponse();
  }
}

function ensureResultSize(result) {
  if (jsonlBytes(result) > MAX_FRAME_BYTES) failResponse("RESPONSE_TOO_LARGE");
  return result;
}

function validateDomainServiceResult(method, result, params) {
  if (!DOMAIN_SERVICE_METHOD_SET.has(method)) failResponse();
  let output;
  if (method === "kanban.board.list") {
    output = validatePageResult(result, "boards", validateBoard);
  } else if (["kanban.board.get", "kanban.board.create", "kanban.board.update"].includes(method)) {
    if (!exactObject(result, ["board"])) failResponse();
    output = { board: validateBoard(result.board) };
  } else if (method === "kanban.card.list") {
    output = validatePageResult(result, "cards", validateCard);
  } else if ([
    "kanban.card.get", "kanban.card.create", "kanban.card.update", "kanban.card.status.set",
    "kanban.card.archived.set",
  ].includes(method)) {
    if (!exactObject(result, ["card"])) failResponse();
    output = { card: validateCard(result.card) };
  } else if (method === "kanban.card.complete.manual") {
    if (!exactObject(result, ["card", "audit"])) failResponse();
    const cardValue = validateCard(result.card);
    const audit = validateAuditEvent(result.audit);
    const completion = cardValue.completion;
    if (completion?.mode !== "manual" || audit.cardId !== cardValue.id
      || audit.actorId !== completion.actorId || audit.note !== completion.note
      || audit.createdAt !== completion.at) failResponse();
    output = { card: cardValue, audit };
  } else if (method === "kanban.comment.list") {
    output = validatePageResult(result, "comments", validateComment);
  } else if (method === "kanban.comment.add") {
    if (!exactObject(result, ["comment"])) failResponse();
    output = { comment: validateComment(result.comment) };
  } else if (method === "kanban.attachment.list") {
    output = validatePageResult(result, "attachments", validateAttachment);
  } else if (method === "kanban.artifact.list") {
    output = validatePageResult(result, "artifacts", validateArtifact);
  } else if (method === "kanban.audit.list") {
    output = validatePageResult(result, "auditEvents", validateAuditEvent);
  } else if (method === "kanban.run.list") {
    const resultParams = validatedResultParams(method, params);
    output = validatePageResult(
      result, "runs", (value) => validateKanbanRunItem(value, resultParams),
    );
  } else if (method === "kanban.run.dispatch") {
    output = validateDispatchResult(
      result, validatedResultParams(method, params), false,
    );
  } else if (method === "kanban.run.retry") {
    output = validateDispatchResult(
      result, validatedResultParams(method, params), true,
    );
  } else if (method === "cron.job.list") {
    output = validatePageResult(result, "jobs", validateCronJob);
  } else if (["cron.job.get", "cron.job.create", "cron.job.update", "cron.job.enabled.set"].includes(method)) {
    if (!exactObject(result, ["job"])) failResponse();
    output = { job: validateCronJob(result.job) };
  } else if (method === "cron.job.delete") {
    if (!exactObject(result, ["jobId", "deleted"])
      || !validUuid(result.jobId) || result.deleted !== true) failResponse();
    output = cloneCanonical(result);
  } else if (method === "cron.run.list") {
    const resultParams = validatedResultParams(method, params);
    output = validatePageResult(
      result, "runs", (value) => validateCronRunItem(value, resultParams),
    );
  } else if (method === "cron.run.trigger" || method === "cron.run.retry") {
    if (!exactObject(result, ["run"])) failResponse();
    const resultParams = validatedResultParams(method, params);
    const run = validateRun(result.run, "cron");
    const expectedRetryOf = method === "cron.run.retry" ? resultParams.retryOf : null;
    if (run.sourceId !== resultParams.jobId || run.retryOf !== expectedRetryOf) failResponse();
    output = { run };
  } else if (CONTENT_READ_METHODS.has(method)) {
    output = validateContentChunk(result);
  } else {
    failResponse();
  }
  return ensureResultSize(output);
}

function createContentMeta(content) {
  if (!validString(content, MAX_TEXT_BYTES, { allowEmpty: true })) failParams();
  let preview = "";
  let previewBytes = 0;
  for (const codePoint of content) {
    const bytes = Buffer.byteLength(codePoint, "utf8");
    if (previewBytes + bytes > MAX_CONTENT_PREVIEW_BYTES) break;
    preview += codePoint;
    previewBytes += bytes;
  }
  return Object.freeze({
    byteLength: Buffer.byteLength(content, "utf8"),
    sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
    preview,
  });
}

function createDomainQueryCursorCodec(options = {}) {
  return createQueryCursorCodec(options);
}

const PAGED_METHOD_FIELDS = Object.freeze({
  "kanban.board.list": "boards",
  "kanban.card.list": "cards",
  "kanban.comment.list": "comments",
  "kanban.attachment.list": "attachments",
  "kanban.artifact.list": "artifacts",
  "kanban.audit.list": "auditEvents",
  "kanban.run.list": "runs",
  "cron.job.list": "jobs",
  "cron.run.list": "runs",
});

function queryForPage(method, params) {
  const queryParams = { ...params };
  delete queryParams.cursor;
  return { method, params: queryParams };
}

function validResponseId(value) {
  return value === null || validRequestId(value);
}

function responseFrameBytes(responseId, result) {
  const bytes = jsonlBytes({ id: responseId, ok: true, result });
  if (bytes > MAX_FRAME_BYTES) failResponse("RESPONSE_TOO_LARGE");
  if (!validResponseId(responseId)) failResponse();
  return bytes;
}

function validateListItem(method, item, params) {
  if (method === "kanban.board.list") return validateBoard(item);
  if (method === "kanban.card.list") return validateCard(item);
  if (method === "kanban.comment.list") return validateComment(item);
  if (method === "kanban.attachment.list") return validateAttachment(item);
  if (method === "kanban.artifact.list") return validateArtifact(item);
  if (method === "kanban.audit.list") return validateAuditEvent(item);
  if (method === "kanban.run.list") return validateKanbanRunItem(item, params);
  if (method === "cron.job.list") return validateCronJob(item);
  if (method === "cron.run.list") return validateCronRunItem(item, params);
  failResponse();
}

function paginateDomainServiceItems(options = {}) {
  const field = PAGED_METHOD_FIELDS[options.method];
  if (!field || !Array.isArray(options.entries)
    || !options.cursorCodec || typeof options.cursorCodec.encode !== "function"
    || typeof options.cursorCodec.decode !== "function") failResponse();
  const params = validateDomainServiceParams(options.method, options.params);
  const empty = { [field]: [], nextCursor: null, hasMore: false };
  responseFrameBytes(options.responseId, empty);
  const seen = new Set();
  const entries = options.entries.map((entry) => {
    if (!exactObject(entry, ["key", "item"])
      || !validString(entry.key, MAX_QUERY_POSITION_BYTES) || seen.has(entry.key)) failResponse();
    seen.add(entry.key);
    return {
      key: entry.key,
      item: ensureItemSize(validateListItem(options.method, entry.item, params)),
    };
  }).sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  const query = queryForPage(options.method, params);
  let position = null;
  if (params.cursor !== null) {
    try {
      position = options.cursorCodec.decode(params.cursor, query).position;
    } catch {
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
    const candidate = { [field]: candidateItems, nextCursor, hasMore };
    try {
      responseFrameBytes(options.responseId, candidate);
    } catch (error) {
      const codeProbe = probeOwnDataValue(error, "code");
      if (!codeProbe.ok || !codeProbe.found) failResponse("INTERNAL_ERROR");
      if (codeProbe.value === "RESPONSE_TOO_LARGE") break;
      throw error;
    }
    selected.push(available[index].item);
  }
  if (selected.length === 0 && available.length > 0) failResponse("DOMAIN_ITEM_TOO_LARGE");
  const hasMore = selected.length < available.length;
  const nextCursor = hasMore
    ? options.cursorCodec.encode({ query, position: available[selected.length - 1].key }) : null;
  const result = validateDomainServiceResult(options.method, {
    [field]: selected,
    nextCursor,
    hasMore,
  }, params);
  responseFrameBytes(options.responseId, result);
  return result;
}

function contentQuery(method, params) {
  const queryParams = { ...params };
  delete queryParams.cursor;
  return { method, params: queryParams };
}

function contentCursorPosition(offsetBytes, meta) {
  return `${offsetBytes}:${meta.byteLength}:${meta.sha256}`;
}

function parseContentCursorPosition(position) {
  const match = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*):([a-f0-9]{64})$/u.exec(position);
  if (!match) failParams("CONTENT_CURSOR_INVALID");
  const offsetBytes = Number(match[1]);
  const byteLength = Number(match[2]);
  if (!Number.isSafeInteger(offsetBytes) || !Number.isSafeInteger(byteLength)) {
    failParams("CONTENT_CURSOR_INVALID");
  }
  return { offsetBytes, byteLength, sha256: match[3] };
}

function stringIndexAtByteOffset(content, offset) {
  if (offset === 0) return 0;
  let bytes = 0;
  let index = 0;
  for (const codePoint of content) {
    bytes += Buffer.byteLength(codePoint, "utf8");
    index += codePoint.length;
    if (bytes === offset) return index;
    if (bytes > offset) return null;
  }
  return bytes === offset ? index : null;
}

function contentSlicePoints(content, startIndex, maxBytes) {
  const codePoints = [];
  const cumulativeBytes = [];
  let bytes = 0;
  for (const codePoint of content.slice(startIndex)) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (bytes + size > maxBytes) {
      if (bytes === 0) failParams();
      break;
    }
    bytes += size;
    codePoints.push(codePoint);
    cumulativeBytes.push(bytes);
  }
  return { codePoints, cumulativeBytes };
}

function contentChunkCandidate(options) {
  const bytes = options.count === 0 ? 0 : options.cumulativeBytes[options.count - 1];
  const end = options.offsetBytes + bytes;
  const hasMore = end < options.meta.byteLength;
  return {
    text: options.codePoints.slice(0, options.count).join(""),
    offsetBytes: options.offsetBytes,
    totalBytes: options.meta.byteLength,
    sha256: options.meta.sha256,
    nextCursor: hasMore
      ? options.cursorCodec.encode({
        query: options.query,
        position: contentCursorPosition(end, options.meta),
      })
      : null,
    hasMore,
  };
}

function contentChunkFits(responseId, candidate) {
  return jsonlBytes(candidate) <= MAX_ITEM_BYTES
    && jsonlBytes({ id: responseId, ok: true, result: candidate }) <= MAX_FRAME_BYTES;
}

function chunkDomainContent(options = {}) {
  if (!CONTENT_READ_METHODS.has(options.method)
    || !options.cursorCodec || typeof options.cursorCodec.encode !== "function"
    || typeof options.cursorCodec.decode !== "function") failResponse();
  const params = validateDomainServiceParams(options.method, options.params);
  const meta = createContentMeta(options.content);
  const query = contentQuery(options.method, params);
  let offsetBytes = 0;
  if (params.cursor !== null) {
    let position;
    try {
      position = options.cursorCodec.decode(params.cursor, query).position;
    } catch {
      failParams("CONTENT_CURSOR_INVALID");
    }
    const cursorState = parseContentCursorPosition(position);
    if (cursorState.byteLength !== meta.byteLength || cursorState.sha256 !== meta.sha256) {
      failParams("RESOURCE_CHANGED");
    }
    offsetBytes = cursorState.offsetBytes;
    if (offsetBytes > meta.byteLength) {
      failParams("CONTENT_CURSOR_INVALID");
    }
  }
  const startIndex = stringIndexAtByteOffset(options.content, offsetBytes);
  if (startIndex === null) failParams("CONTENT_CURSOR_INVALID");
  if (!validResponseId(options.responseId)) failResponse();
  const slice = contentSlicePoints(options.content, startIndex, params.maxBytes);
  const candidateOptions = {
    ...slice,
    offsetBytes,
    meta,
    cursorCodec: options.cursorCodec,
    query,
  };
  let count = slice.codePoints.length;
  let candidate = contentChunkCandidate({ ...candidateOptions, count });
  if (!contentChunkFits(options.responseId, candidate)) {
    let low = 1;
    let high = count - 1;
    let best = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const middleCandidate = contentChunkCandidate({ ...candidateOptions, count: middle });
      if (contentChunkFits(options.responseId, middleCandidate)) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best === 0) {
      const smallest = contentChunkCandidate({ ...candidateOptions, count: Math.min(1, count) });
      if (jsonlBytes(smallest) > MAX_ITEM_BYTES) failResponse("CONTENT_CHUNK_TOO_LARGE");
      failResponse("RESPONSE_TOO_LARGE");
    }
    count = best;
    candidate = contentChunkCandidate({ ...candidateOptions, count });
  }
  const result = validateDomainServiceResult(options.method, candidate);
  responseFrameBytes(options.responseId, result);
  return result;
}

function mapDomainServiceError(error, context = {}) {
  const codeProbe = probeOwnDataValue(error, "code");
  if (!codeProbe.ok) {
    return Object.freeze({ code: "INTERNAL_ERROR", message: PUBLIC_MESSAGES.INTERNAL_ERROR });
  }
  const internalCode = codeProbe.found && typeof codeProbe.value === "string"
    ? codeProbe.value : "";
  let publicCode = Object.prototype.hasOwnProperty.call(PUBLIC_MESSAGES, internalCode)
    ? internalCode : DIRECT_INTERNAL_ERROR_MAP[internalCode];
  if (!publicCode && internalCode.endsWith("_COMMIT_UNCERTAIN")) {
    const methodProbe = probeOwnDataValue(context, "method");
    if (!methodProbe.ok) {
      return Object.freeze({ code: "INTERNAL_ERROR", message: PUBLIC_MESSAGES.INTERNAL_ERROR });
    }
    if (methodProbe.found && typeof methodProbe.value === "string"
      && DOMAIN_SERVICE_METHOD_SET.has(methodProbe.value)) {
      if (methodProbe.value.startsWith("kanban.")) publicCode = "KANBAN_COMMIT_UNCERTAIN";
      if (methodProbe.value.startsWith("cron.")) publicCode = "CRON_COMMIT_UNCERTAIN";
    }
  }
  if (!publicCode && internalCode.startsWith("KANBAN_")
    && internalCode.endsWith("_CAPACITY")) publicCode = "KANBAN_CAPACITY";
  if (!publicCode && internalCode.startsWith("CRON_")
    && internalCode.endsWith("_CAPACITY")) publicCode = "CRON_CAPACITY";
  if (!publicCode && DOMAIN_INPUT_ERROR_CODES.has(internalCode)) publicCode = "INVALID_PARAMS";
  if (!publicCode && (internalCode.startsWith("KANBAN_") || internalCode.startsWith("CRON_"))
    && (internalCode.endsWith("_NOT_FOUND") || internalCode.includes("REFERENCE_INVALID"))) {
    publicCode = "STATE_CONFLICT";
  }
  if (!publicCode && (internalCode.startsWith("KANBAN_") || internalCode.startsWith("CRON_"))
    && (DOMAIN_STATE_ERROR_CODES.has(internalCode) || internalCode.endsWith("_CONFLICT")
      || internalCode.endsWith("_STALE"))) publicCode = "STATE_CONFLICT";
  if (!publicCode && internalCode.startsWith("KANBAN_")
    && (internalCode.endsWith("_CLOSED") || internalCode.endsWith("_CLOSING")
      || internalCode.endsWith("_POISONED") || internalCode.endsWith("_RUN_CORRUPT"))) {
    publicCode = "KANBAN_UNAVAILABLE";
  }
  if (!publicCode && internalCode.startsWith("CRON_")
    && (internalCode.endsWith("_CLOSED") || internalCode.endsWith("_CLOSING")
      || internalCode.endsWith("_POISONED") || internalCode.endsWith("_RUN_CORRUPT"))) {
    publicCode = "CRON_UNAVAILABLE";
  }
  if (!publicCode && (internalCode.startsWith("WRITER_LEASE_")
    || internalCode.startsWith("PRIVATE_FILE_") || internalCode.startsWith("UNSAFE_")
    || internalCode.endsWith("_STORE_CORRUPT") || internalCode.endsWith("_WRITE_FAILED")
    || internalCode.endsWith("_STORE_CLOSED")
    || internalCode === "LEASE_RELEASE_FAILED")) publicCode = "SERVICE_UNAVAILABLE";
  if (!Object.prototype.hasOwnProperty.call(PUBLIC_MESSAGES, publicCode)) publicCode = "INTERNAL_ERROR";
  return Object.freeze({ code: publicCode, message: PUBLIC_MESSAGES[publicCode] });
}

module.exports = {
  DOMAIN_SERVICE_METHODS,
  MAX_CONTENT_PREVIEW_BYTES,
  MAX_CONTENT_READ_BYTES,
  MAX_CURSOR_BYTES,
  MAX_FRAME_BYTES,
  MAX_ITEM_BYTES,
  MAX_PAGE_LIMIT,
  PUBLIC_MESSAGES,
  chunkDomainContent,
  createContentMeta,
  createDomainQueryCursorCodec,
  createQueryCursorCodec: createDomainQueryCursorCodec,
  mapDomainServiceError,
  paginateDomainServiceItems,
  validateContentChunk,
  validateContentMeta,
  validateDomainServiceParams,
  validateDomainServiceRequest,
  validateDomainServiceResult,
};
