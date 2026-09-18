"use strict";

const { serviceError } = require("./security");
const path = require("node:path");
const { validExecutors, validGrowthSettings } = require("./inspiration-growth");
const {
  validInteractiveApprovalDetails, validInteractiveApprovalChoice,
  validInteractiveApprovalOptions, interactiveApprovalCanAllow,
} = require("../core/shoggoth-interaction-contract");
const { validAttachment, validAttachments, attachmentFields, decodeChunk, CHUNK_BYTES } = require("./inspiration-media");
const METHODS = Object.freeze({
  "inspiration.media.write": ["attachment", "offset", "content"],
  "inspiration.media.read": ["id", "offset"],
  "inspiration.agent-stats": ["agents"],
  "inspiration.activities": ["sinceMs", "cursor", "limit"],
  "inspiration.growth.get": [],
  "inspiration.growth.set": ["expectedRevision", "enabled", "executors"],
  "inspiration.list": ["query", "filter", "cursor", "limit"],
  "inspiration.get": ["id"],
  "inspiration.create": ["operationId", "body"],
  "inspiration.import": ["operationId", "archiveId"],
  "inspiration.update": ["id", "operationId", "expectedRevision", "patch"],
  "inspiration.delete": ["id", "operationId", "expectedRevision"],
  "inspiration.start": ["id", "operationId", "expectedRevision", "agentId", "backendId", "instruction", "workspace"],
  "inspiration.executions": ["id", "cursor", "limit"],
  "inspiration.activity.binding": ["id", "runId"],
  "inspiration.respond": ["id", "operationId", "runId", "requestId", "response"],
  "inspiration.cancel": ["id", "operationId", "runId"],
  "inspiration.session.get": ["backendId", "agentId", "sessionKey"],
  "inspiration.session.messages": ["backendId", "agentId", "sessionKey", "cursor", "limit"],
  "inspiration.session.send": ["backendId", "agentId", "sessionKey", "operationId", "prompt"],
});
const INSPIRATION_SERVICE_METHODS = Object.freeze(Object.keys(METHODS));
const PUBLIC_MESSAGES = Object.freeze({
  INSPIRATION_INVALID: "灵感参数无效",
  INSPIRATION_NOT_FOUND: "灵感不存在",
  INSPIRATION_UNAVAILABLE: "灵感服务暂不可用，输入仍保留在本机",
  INSPIRATION_BUSY: "这条灵感已有未结束的执行",
  INSPIRATION_AGENT_BUSY: "这个 Agent 正在处理另一条灵感，完成后才能接下一条",
  INSPIRATION_REVISION_CONFLICT: "灵感已在另一处更新，请先查看最新内容",
  INSPIRATION_OPERATION_CONFLICT: "同一次操作的内容发生了变化，请重新提交",
  INSPIRATION_BINDING_INVALID: "灵感与 Agent 会话关联不匹配",
  INSPIRATION_REQUEST_EXPIRED: "这个请求已失效，请查看最新执行状态",
  INSPIRATION_ARCHIVED: "请先恢复这条灵感",
  INSPIRATION_NOT_COMPLETED: "灵感发芽后才能标记为结果",
  INSPIRATION_CAPACITY: "灵感存储已达到容量上限",
  INSPIRATION_SENSITIVE_CONTENT: "请移除凭据后保存灵感",
  INSPIRATION_COMMIT_UNCERTAIN: "灵感保存状态需要恢复核对，请重新连接服务",
  INSPIRATION_STORE_CORRUPT: "灵感数据需要恢复核对",
  INSPIRATION_RESPONSE_INVALID: "灵感服务返回了无法读取的数据",
  INSPIRATION_UNSUPPORTED: "这个 Agent 暂不支持灵感执行",
  INSPIRATION_ARCHIVE_INVALID: "便签包损坏、版本不支持或超过容量限制，未导入任何便签",
});
const FILTERS = new Set(["all", "saved", "active", "result", "favorite", "archived"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const uuid = (value) => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === fields.length
  && fields.every((key) => own(value, key));
const string = (value, max, empty = true) => typeof value === "string" && value.isWellFormed()
  && !value.includes("\0") && (empty || value.trim().length > 0)
  && Buffer.byteLength(JSON.stringify(value), "utf8") <= max;
const invalid = (code = "INSPIRATION_INVALID") => { throw serviceError(code, PUBLIC_MESSAGES[code]); };
const validInspirationPaperTone = (value) => Number.isInteger(value) && value >= 0 && value < 8;
const paperFields = (value, fields) => value && own(value, "paperTone") ? [...fields, "paperTone"] : fields;

function validateInspirationServiceParams(method, input) {
  const fields = method === "inspiration.create" ? attachmentFields(input, paperFields(input, METHODS[method]))
    : method === "inspiration.list" && input && (own(input, "backendId") || own(input, "agentId"))
      ? [...METHODS[method], "backendId", "agentId"]
    : method === "inspiration.media.read" && input && own(input, "preview") ? [...METHODS[method], "preview"] : METHODS[method];
  if (!fields || !exact(input, fields) || Buffer.byteLength(JSON.stringify(input)) > 48 * 1024) invalid();
  if (method === "inspiration.agent-stats" && (!Array.isArray(input.agents) || input.agents.length > 50
    || !input.agents.every(agent => exact(agent, ["backendId", "agentId"])
      && publicId(agent.backendId) && publicId(agent.agentId))
    || new Set(input.agents.map(agent => `${agent.backendId}/${agent.agentId}`)).size !== input.agents.length)) invalid();
  if (method === "inspiration.growth.set" && (typeof input.enabled !== "boolean" || !validExecutors(input.executors)
    || (input.enabled && input.executors.length === 0))) invalid();
  if (fields.includes("id") && !uuid(input.id)) invalid();
  if (fields.includes("archiveId") && !uuid(input.archiveId)) invalid();
  for (const key of ["operationId", "agentId", "backendId", "runId", "requestId"]) {
    if (fields.includes(key) && (typeof input[key] !== "string" || !ID.test(input[key]))) invalid();
  }
  if (fields.includes("expectedRevision") && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) invalid();
  if (fields.includes("cursor") && input.cursor !== null && !string(input.cursor, 256, false)) invalid();
  if (fields.includes("limit") && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50)) invalid();
  if (fields.includes("sinceMs") && (!Number.isSafeInteger(input.sinceMs) || input.sinceMs < 0)) invalid();
  if (fields.includes("body") && !string(input.body, 16 * 1024, Boolean(input.attachments?.length))) invalid();
  if (fields.includes("attachments") && !validAttachments(input.attachments)) invalid();
  if (method.startsWith("inspiration.media.")) {
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset % CHUNK_BYTES) invalid();
    if (own(input, "preview") && input.preview !== true) invalid();
    if (method === "inspiration.media.write") {
      if (!validAttachment(input.attachment) || input.offset >= input.attachment.size
        || decodeChunk(input.content).length !== Math.min(CHUNK_BYTES, input.attachment.size - input.offset)) invalid();
    }
  }
  if (fields.includes("paperTone") && !validInspirationPaperTone(input.paperTone)) invalid();
  if (fields.includes("instruction") && !string(input.instruction, 16 * 1024)) invalid();
  if (fields.includes("prompt") && !string(input.prompt, 16 * 1024, false)) invalid();
  if (fields.includes("sessionKey") && (!string(input.sessionKey, 512, false)
    || !["openclaw", "hermes"].includes(input.backendId))) invalid();
  if (fields.includes("workspace") && input.workspace !== null && !string(input.workspace, 4096, false)) invalid();
  if (fields.includes("query") && !string(input.query, 1024)) invalid();
  if (fields.includes("filter") && !FILTERS.has(input.filter)) invalid();
  if (fields.includes("patch")) {
    const patch = input.patch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0
      || Object.keys(patch).some((key) => !["body", "title", "favorite", "archived", "accepted", "attachments"].includes(key))
      || (own(patch, "body") && !string(patch.body, 16 * 1024))
      || (own(patch, "attachments") && !validAttachments(patch.attachments))
      || (own(patch, "title") && patch.title !== null && !string(patch.title, 512, false))
      || ["favorite", "archived", "accepted"].some((key) => own(patch, key) && typeof patch[key] !== "boolean")) invalid();
  }
  if (fields.includes("response") && (!input.response || typeof input.response !== "object" || Array.isArray(input.response))) invalid();
  return structuredClone(input);
}

const STATUSES = new Set(["saved", "queued", "starting", "running", "waiting_input", "waiting_approval",
  "completed", "failed", "canceled", "interrupted", "skipped", "unknown"]);

const at = (value) => Number.isSafeInteger(value) && value >= 0;
const optionalAt = (value) => value === null || at(value);
const optionalText = (value, max) => value === null || string(value, max);
const publicId = (value) => typeof value === "string" && ID.test(value);
const VIEW_FIELDS = ["id", "body", "title", "revision", "favorite", "archivedAt", "acceptedAt", "createdAt", "updatedAt", "status", "latestExecution"];
const EXECUTION_VIEW_FIELDS = ["id", "ideaId", "runId", "profileId", "agentId", "backendId", "workspace", "sessionKey", "ideaRevision", "createdAt", "retryOf", "status", "resultSummary", "errorCode", "finishedAt", "attention"];
function validRequest(request, runId) {
  return request !== null && typeof request === "object"
    && exact(request, ["version", "requestId", "runId", "kind", "title", "message", "fields", "approvalChoices", "expiresAt",
    ...(own(request, "approvalDetails") ? ["approvalDetails"] : []),
    ...(own(request, "approvalOptions") ? ["approvalOptions"] : [])])
    && (!own(request, "approvalDetails") || (request.fields?.length === 0
      && Array.isArray(request.approvalChoices) && interactiveApprovalCanAllow(request)
      && validInteractiveApprovalDetails(request.approvalDetails)))
    && (!own(request, "approvalOptions") || (request.kind === "runtime_approval"
      && Array.isArray(request.approvalChoices)
      && validInteractiveApprovalOptions(request.approvalOptions)
      && request.approvalOptions.every((option) => request.approvalChoices.includes(option.choice))
      && request.approvalChoices.every((choice) => ["deny", "cancel"].includes(choice)
        || request.approvalOptions.some((option) => option.choice === choice))))
    && request.version === 1 && request.runId === runId && publicId(request.requestId)
    && ["user_input", "runtime_approval", "product_confirmation", "mcp_permission"].includes(request.kind)
    && string(request.title, 2048) && string(request.message, 16 * 1024)
    && optionalAt(request.expiresAt) && Array.isArray(request.fields) && request.fields.length <= 32
    && request.fields.every((field) => exact(field, ["id", "type", "label", "description", "required", "secret", "options"])
      && publicId(field.id) && ["text", "choice", "choice_or_text"].includes(field.type)
      && string(field.label, 4096) && string(field.description, 16 * 1024)
      && typeof field.required === "boolean" && typeof field.secret === "boolean"
      && Array.isArray(field.options) && field.options.length <= 64
      && field.options.every((option) => exact(option, ["value", "label", "description"])
        && string(option.value, 4096, false) && string(option.label, 4096, false) && string(option.description, 16 * 1024)))
    && Array.isArray(request.approvalChoices) && request.approvalChoices.length <= 34
    && request.approvalChoices.every((choice) => validInteractiveApprovalChoice(choice)
      && (!choice.startsWith("runtime:") || request.approvalOptions?.some((option) => option.choice === choice)))
    && (request.fields.length === 0 ? request.approvalChoices.length > 0 : request.approvalChoices.length === 0);
}
function validInspirationAttention(attention, runId) {
  return attention === null || (exact(attention, ["request", "active", "occurredAt", "command", "cwd", "details"])
    && typeof attention.active === "boolean" && at(attention.occurredAt)
    && optionalText(attention.details, 48 * 1024) && optionalText(attention.command, 32 * 1024)
    && optionalText(attention.cwd, 4096) && validRequest(attention.request, runId));
}
function validateExecution(execution) {
  const external = ["openclaw", "hermes"].includes(execution?.backendId);
  if (!exact(execution, EXECUTION_VIEW_FIELDS) || !uuid(execution.id) || !uuid(execution.ideaId) || !uuid(execution.runId)
    || (execution.sessionKey !== null && !(external ? string(execution.sessionKey, 512, false) : uuid(execution.sessionKey)))
    || ![execution.agentId, execution.backendId].every(publicId)
    || (external ? execution.profileId !== null : !publicId(execution.profileId))
    || (!(external && execution.workspace === null)
      && (!string(execution.workspace, 4096, false) || !path.isAbsolute(execution.workspace)))
    || !Number.isSafeInteger(execution.ideaRevision) || execution.ideaRevision < 1
    || !at(execution.createdAt) || !optionalAt(execution.finishedAt)
    || (execution.retryOf !== null && !uuid(execution.retryOf))
    || !optionalText(execution.resultSummary, 16 * 1024) || !optionalText(execution.errorCode, 512)
    || !STATUSES.has(execution.status) || execution.status === "saved") invalid("INSPIRATION_RESPONSE_INVALID");
  if (!validInspirationAttention(execution.attention, execution.runId)) invalid("INSPIRATION_RESPONSE_INVALID");
}
function validateView(value) {
  if (!exact(value, attachmentFields(value, paperFields(value, VIEW_FIELDS))) || !uuid(value.id) || !string(value.body, 16 * 1024, Boolean(value.attachments?.length))
    || (own(value, "attachments") && !validAttachments(value.attachments))
    || (own(value, "paperTone") && !validInspirationPaperTone(value.paperTone))
    || (value.title !== null && !string(value.title, 512, false))
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.favorite !== "boolean" || !STATUSES.has(value.status)
    || !at(value.createdAt) || !at(value.updatedAt) || value.updatedAt < value.createdAt
    || !optionalAt(value.archivedAt) || !optionalAt(value.acceptedAt)) invalid("INSPIRATION_RESPONSE_INVALID");
  if (value.latestExecution !== null) {
    validateExecution(value.latestExecution);
    if (value.latestExecution.ideaId !== value.id || value.latestExecution.ideaRevision > value.revision
      || value.status !== value.latestExecution.status) invalid("INSPIRATION_RESPONSE_INVALID");
  } else if (value.status !== "saved") invalid("INSPIRATION_RESPONSE_INVALID");
}

function validateInspirationServiceResult(method, result) {
  if (!METHODS[method] || !result || typeof result !== "object" || Array.isArray(result)
    || Buffer.byteLength(JSON.stringify(result)) > 60 * 1024) invalid("INSPIRATION_RESPONSE_INVALID");
  if (method.startsWith("inspiration.media.")) {
    const read = method === "inspiration.media.read";
    if (!exact(result, read ? ["attachment", "content", "nextOffset"] : ["attachment", "nextOffset"])
      || !validAttachment(result.attachment) || !Number.isSafeInteger(result.nextOffset)
      || result.nextOffset < 1 || result.nextOffset > result.attachment.size
      || (read && decodeChunk(result.content).length !== (result.nextOffset % CHUNK_BYTES || CHUNK_BYTES))) invalid("INSPIRATION_RESPONSE_INVALID");
  } else if (method === "inspiration.agent-stats") {
    if (!exact(result, ["agents"]) || !Array.isArray(result.agents) || result.agents.length > 50
      || !result.agents.every(agent => exact(agent, ["backendId", "agentId", "executionCount"])
        && publicId(agent.backendId) && publicId(agent.agentId) && at(agent.executionCount))
      || new Set(result.agents.map(agent => `${agent.backendId}/${agent.agentId}`)).size !== result.agents.length) {
      invalid("INSPIRATION_RESPONSE_INVALID");
    }
  } else if (method.startsWith("inspiration.growth.")) {
    if (!exact(result, ["settings", "failures", "errorCode"]) || !validGrowthSettings(result.settings)
      || !optionalText(result.errorCode, 512) || !Array.isArray(result.failures) || result.failures.length > 20
      || !result.failures.every(value => exact(value, ["ideaId", "title", "runId", "attempts", "errorCode"])
        && uuid(value.ideaId) && string(value.title, 512) && (value.runId === null || uuid(value.runId))
        && [1, 2].includes(value.attempts) && publicId(value.errorCode))) invalid("INSPIRATION_RESPONSE_INVALID");
  } else if (method === "inspiration.session.get") {
    if (!exact(result, ["origin"]) || (result.origin !== null
      && (!exact(result.origin, ["inspirationId", "inspirationTitle"])
        || !uuid(result.origin.inspirationId) || !string(result.origin.inspirationTitle, 512, false)))) {
      invalid("INSPIRATION_RESPONSE_INVALID");
    }
  } else if (method === "inspiration.activity.binding") {
    if (!exact(result, ["execution", "prompt"]) || !string(result.prompt, 48 * 1024, false)) invalid("INSPIRATION_RESPONSE_INVALID");
    validateExecution(result.execution);
  } else if (["inspiration.list", "inspiration.executions", "inspiration.activities", "inspiration.session.messages"].includes(method)) {
    const field = method === "inspiration.executions" ? "executions" : "items";
    if (!exact(result, [field, "total", "hasMore", "nextCursor"]) || !Array.isArray(result[field])
      || result[field].length > 50 || !Number.isSafeInteger(result.total) || result.total < 0
      || typeof result.hasMore !== "boolean"
      || (result.hasMore ? !string(result.nextCursor, 256, false) : result.nextCursor !== null)) invalid("INSPIRATION_RESPONSE_INVALID");
    if (method === "inspiration.session.messages") {
      for (const item of result.items) {
        if (!exact(item, ["id", "createdAt", "promptHash", "text", "attachments"])
          || !uuid(item.id) || !at(item.createdAt) || !/^[a-f0-9]{64}$/u.test(item.promptHash)
          || !string(item.text, 34 * 1024) || !validAttachments(item.attachments)) invalid("INSPIRATION_RESPONSE_INVALID");
      }
    } else if (method === "inspiration.activities") {
      for (const item of result.items) {
        if (!exact(item, ["id", "ideaId", "runId", "backendId", "agentId", "createdAt", "title", "summary", "status"])
          || ![item.id, item.ideaId, item.runId].every(uuid) || ![item.backendId, item.agentId].every(publicId)
          || !at(item.createdAt) || !string(item.title, 1024) || !string(item.summary, 4096)
          || !STATUSES.has(item.status) || item.status === "saved") invalid("INSPIRATION_RESPONSE_INVALID");
      }
    } else if (field === "items") result.items.forEach(validateView);
    else result.executions.forEach(validateExecution);
  } else if (method === "inspiration.delete") {
    if (!exact(result, ["id", "deleted"]) || !uuid(result.id) || result.deleted !== true) invalid("INSPIRATION_RESPONSE_INVALID");
  } else {
    if (!exact(result, ["idea"])) invalid("INSPIRATION_RESPONSE_INVALID");
    validateView(result.idea);
  }
  return structuredClone(result);
}

module.exports = { INSPIRATION_SERVICE_METHODS, PUBLIC_MESSAGES,
  validateInspirationServiceParams, validateInspirationServiceResult, validInspirationAttention, validInspirationPaperTone };
