"use strict";

const path = require("node:path");
const { validDigest, validOffset, validResultPage } = require("./group-result-content");
const { validInspirationAttention } = require("./agent-service/inspiration-service-protocol");
const { validModelSelection } = require("./group-member-model");

const EXTERNAL_INSPIRATION_METHODS = Object.freeze([
  "inspiration.external.prepare", "inspiration.external.start", "inspiration.external.get",
  "inspiration.external.respond", "inspiration.external.cancel",
]);
// 群聊外部成员复用同一套外部执行合同（群聊开发计划 R4），方法族并列、形状相同。
const GROUP_EXTERNAL_METHODS = Object.freeze(EXTERNAL_INSPIRATION_METHODS
  .map((method) => method.replace(/^inspiration\./u, "group.")));
const EXTERNAL_EXECUTION_METHODS = Object.freeze([...EXTERNAL_INSPIRATION_METHODS, ...GROUP_EXTERNAL_METHODS]);
/** group.external.X 与 inspiration.external.X 共用校验；返回 null 表示不是外部执行方法。 */
function canonicalExternalMethod(method) {
  if (!EXTERNAL_EXECUTION_METHODS.includes(method)) return null;
  return method.replace(/^group\./u, "inspiration.");
}
// 群聊专用的只读草稿读取：参数同 get（已绑定的执行身份），结果只有当前草稿文本。
const GROUP_EXTERNAL_DRAFT_METHOD = "group.external.draft";
const GROUP_EXTERNAL_ACTIVITY_METHOD = "group.external.activity";
const GROUP_EXTERNAL_RESULT_METHOD = "group.external.result";
const GROUP_EXTERNAL_METADATA_METHOD = "group.external.metadata";
const GROUP_EXTERNAL_ARTIFACT_METHOD = "group.external.artifact";
const { validAuthority, validRemoteBinding, validPreparationContext, validIsolation, validResource } = require("./group-runtime-binding");
// 群工具通道（D2）：该外部 Agent 是否真的注册了 shoggoth MCP。由 App 按实际注册结果回答，不靠猜。
const GROUP_EXTERNAL_CAPABILITIES_METHOD = "group.external.capabilities";
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
const workspace = value => text(value, 4096) && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));
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
  const dispatchFields = Object.hasOwn(value ?? {}, "dispatchState") ? ["dispatchState"] : [];
  return exact(value, [...SNAPSHOT_FIELDS, ...dispatchFields]) && validIdentity(value)
    && (!dispatchFields.length || value.dispatchState === "queued" && value.status === "queued" && value.sequence === 0)
    && text(value.sessionKey, 512) && workspace(value.workspace) && validMode(value.backendId, value.mode)
    && EXTERNAL_STATUSES.has(value.status) && timestamp(value.sequence)
    && (value.resultSummary === null || text(value.resultSummary, 16 * 1024, true))
    && (value.errorCode === null || (id(value.errorCode) && /^[A-Z][A-Z0-9_]*$/u.test(value.errorCode)))
    && (EXTERNAL_TERMINAL.has(value.status) ? timestamp(value.finishedAt) : value.finishedAt === null)
    && validInspirationAttention(value.attention, value.runId);
}

function validateExternalInspirationParams(rawMethod, value) {
  const method = canonicalExternalMethod(rawMethod);
  const group = typeof rawMethod === "string" && rawMethod.startsWith("group.external.");
  const contextFields = group && Object.hasOwn(value ?? {}, "context") ? ["context"] : [];
  const remoteFields = group && Object.hasOwn(value ?? {}, "remote") ? ["remote"] : [];
  const modelFields = group && Object.hasOwn(value ?? {}, "modelSelection") ? ["modelSelection"] : [];
  const stopFields = group && rawMethod === "group.external.cancel" && Object.hasOwn(value ?? {}, "stopGroup") ? ["stopGroup"] : [];
  if (stopFields.length && value.stopGroup !== true) return false;
  if (modelFields.length && (!method?.endsWith(".prepare") || !validModelSelection(value.modelSelection))) return false;
  if (contextFields.length && (!method?.endsWith(".prepare") || !validPreparationContext(value.context))) return false;
  if (remoteFields.length && !validRemoteBinding(value.remote)) return false;
  if (!method || !validIdentity(value)) return false;
  if (method === "inspiration.external.prepare") {
    return exact(value, [...COMMON_FIELDS, "operationId", ...contextFields, ...modelFields]) && id(value.operationId)
      && (value.sessionKey === null || text(value.sessionKey, 512))
      && (value.workspace === null || workspace(value.workspace));
  }
  const additional = method.endsWith(".start") ? ["prompt", "operationId"]
    : method.endsWith(".respond") ? ["requestId", "response", "operationId"]
      : method.endsWith(".cancel") ? ["operationId"] : [];
  if (!exact(value, [...BOUND_FIELDS, ...additional, ...remoteFields, ...stopFields]) || !uuid(value.hostId)
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

function validateExternalInspirationResult(rawMethod, value) {
  const method = canonicalExternalMethod(rawMethod);
  if (!method || !uuid(value?.hostId)) return false;
  const extras = rawMethod.startsWith("group.external.") ? ["remote", "isolation", "resource", ...(rawMethod === "group.external.cancel" ? ["groupStopped"] : [])].filter(key => Object.hasOwn(value, key)) : [];
  if (extras.includes("groupStopped") && typeof value.groupStopped !== "boolean") return false;
  if (extras.includes("remote") && !validRemoteBinding(value.remote)) return false;
  if (extras.includes("isolation") && !validIsolation(value.isolation)) return false;
  if (extras.includes("resource") && !validResource(value.resource)) return false;
  if (method === "inspiration.external.prepare") {
    return exact(value, ["hostId", "binding", ...extras]) && exact(value.binding, ["sessionKey", "workspace", "mode"])
      && text(value.binding.sessionKey, 512) && workspace(value.binding.workspace)
      && EXTERNAL_MODES.has(value.binding.mode);
  }
  return exact(value, ["hostId", "snapshot", ...extras]) && validExternalSnapshot(value.snapshot)
    && (rawMethod.startsWith("group.external.") || !Object.hasOwn(value.snapshot, "dispatchState"));
}

// Private Service -> local Host recovery receipt. Runner hostId may change on
// restart; the durable Host, owner, group and complete execution binding may not.
function validateGroupExecutionReceiptParams(value) {
  return exact(value, ["groupId", "ownerId", "hostId", "execution"])
    && uuid(value.groupId) && uuid(value.ownerId) && uuid(value.hostId)
    && exact(value.execution, BOUND_FIELDS) && validateExternalInspirationParams("group.external.get", value.execution);
}
function validateGroupExecutionReceiptResult(value, params = null) {
  if (!exact(value, ["receipt"])) return false;
  if (value.receipt === null) return true;
  const receipt = value.receipt;
  return exact(receipt, ["authority", "hostId", "snapshot"]) && validAuthority(receipt.authority)
    && uuid(receipt.hostId) && validExternalSnapshot(receipt.snapshot) && EXTERNAL_TERMINAL.has(receipt.snapshot.status)
    && (!params || receipt.hostId === params.hostId && receipt.authority.groupId === params.groupId
      && receipt.authority.ownerId === params.ownerId
      && [...COMMON_FIELDS, "mode"].every(key => receipt.snapshot[key] === params.execution[key]));
}

function validateGroupExternalResultParams(value) {
  if (!exact(value, [...BOUND_FIELDS, "offset", "digest", ...(Object.hasOwn(value ?? {}, "remote") ? ["remote"] : []),
    ...(Object.hasOwn(value ?? {}, "part") ? ["part"] : [])])) return false;
  const { offset, digest, part, ...bound } = value;
  if (Object.hasOwn(value, "part") && part !== "progress") return false;
  return validateExternalInspirationParams("group.external.get", bound) && validOffset(offset)
    && (digest === null ? offset === 0 : validDigest(digest));
}

function validateGroupExternalResultResult(value) {
  return exact(value, ["hostId", "page"]) && uuid(value.hostId) && (value.page === null || validResultPage(value.page));
}

function validateGroupExternalDraftParams(value) {
  return validateExternalInspirationParams("group.external.get", value);
}

function validateGroupExternalMetadataParams(value) {
  return validateExternalInspirationParams("group.external.get", value);
}
function validateGroupExternalMetadataResult(value) {
  return exact(value, ["hostId", "responseMetadata"]) && uuid(value.hostId)
    && (value.responseMetadata === null || require("./chat-response-metadata").validResponseMetadata(value.responseMetadata));
}

function validateGroupExternalDraftResult(value) {
  return exact(value, ["hostId", "draft"]) && uuid(value.hostId)
    && (value.draft === null || text(value.draft, 16 * 1024, true));
}

function validateGroupExternalCapabilitiesParams(value) {
  return exact(value, ["backendId", "agentId", ...(Object.hasOwn(value ?? {}, "peerId") ? ["peerId"] : []),
    ...(Object.hasOwn(value ?? {}, "protocolVersion") ? ["protocolVersion"] : [])]) && EXTERNAL_BACKENDS.has(value.backendId)
    && id(value.agentId) && (value.peerId === undefined || id(value.peerId))
    && (value.protocolVersion === undefined || value.protocolVersion === 2);
}

function validateGroupExternalCapabilitiesResult(value) {
  return exact(value, ["groupTools"]) && typeof value.groupTools === "boolean"
    || require("./agent-service/group-capabilities").validGroupCapabilities(value);
}

function validateGroupExternalActivityParams(value) { return validateExternalInspirationParams("group.external.get", value); }
function validateGroupExternalActivityResult(value) {
  return exact(value, ["hostId", "activity"]) && uuid(value.hostId)
    && (value.activity === null || require("./agent-service/group-activity").validGroupActivity(value.activity));
}

function validateGroupExternalArtifactParams(value) {
  return exact(value, ["execution", "path", "digest", "offset"]) && validateExternalInspirationParams("group.external.get", value.execution)
    && text(value.path, 2048) && (value.digest === null || validDigest(value.digest)) && validOffset(value.offset);
}
function validateGroupExternalArtifactResult(value) {
  return require("./group-runtime-host-protocol").validHostResult("host.artifact", value);
}
module.exports = {
  GROUP_EXTERNAL_METADATA_METHOD, validateGroupExternalMetadataParams, validateGroupExternalMetadataResult,
  validateGroupExecutionReceiptParams, validateGroupExecutionReceiptResult,
  GROUP_EXTERNAL_ACTIVITY_METHOD, validateGroupExternalActivityParams, validateGroupExternalActivityResult,
  GROUP_EXTERNAL_ARTIFACT_METHOD, validateGroupExternalArtifactParams, validateGroupExternalArtifactResult,
  GROUP_EXTERNAL_RESULT_METHOD, validateGroupExternalResultParams, validateGroupExternalResultResult,
  GROUP_EXTERNAL_DRAFT_METHOD, validateGroupExternalDraftParams, validateGroupExternalDraftResult,
  GROUP_EXTERNAL_CAPABILITIES_METHOD, validateGroupExternalCapabilitiesParams, validateGroupExternalCapabilitiesResult,
  EXTERNAL_INSPIRATION_METHODS, GROUP_EXTERNAL_METHODS, EXTERNAL_EXECUTION_METHODS, canonicalExternalMethod,
  EXTERNAL_BACKENDS, EXTERNAL_STATUSES, EXTERNAL_TERMINAL,
  validExternalSnapshot, validateExternalInspirationParams, validateExternalInspirationResult,
};
