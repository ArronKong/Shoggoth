"use strict";

const { serviceError } = require("./security");
const { validateMemoryItem } = require("./memory-store");
const { validateEvent } = require("./transcript-store");

const AGENT_HARNESS_METHODS = Object.freeze([
  "harness.definition.meta",
  "harness.definition.read",
  "harness.definition.update",
  "harness.definition.restore",
  "harness.definition.import.stage",
  "harness.definition.import.preview",
  "harness.definition.import.commit",
  "harness.memory.list",
  "harness.memory.create",
  "harness.memory.update",
  "harness.memory.delete",
  "harness.transcript.sessions",
  "harness.transcript.events",
  "harness.transcript.context.set",
  "harness.tools.list",
  "harness.tools.permission.set",
  "harness.skills.list",
  "harness.skills.preview",
  "harness.skills.install",
  "harness.skills.uninstall",
  "harness.skills.enable",
  "harness.skills.global.set",
  "harness.skills.usage",
  "harness.computer.status",
]);
const METHOD_SET = new Set(AGENT_HARNESS_METHODS);
const PUBLIC_MESSAGES = Object.freeze({
  INVALID_PARAMS: "请求参数无效",
  HARNESS_PROFILE_NOT_FOUND: "Shoggoth Agent 不存在",
  HARNESS_RESPONSE_INVALID: "Agent 管理响应无效",
  HARNESS_RESPONSE_TOO_LARGE: "Agent 管理响应超过本地协议上限",
  HARNESS_IMPORT_NOT_FOUND: "Definition 导入暂存不存在或已过期",
  HARNESS_IMPORT_INCOMPLETE: "Definition 导入包不完整",
  HARNESS_REVISION_CONFLICT: "数据已被其他窗口更新，请刷新后重试",
  HARNESS_SERVICE_CLOSED: "Agent 管理服务不可用",
  DEFINITION_REVISION_CONFLICT: "Agent Definition 已被其他窗口更新",
  DEFINITION_WRITE_FORBIDDEN: "该 Definition 文件不可直接编辑",
  DEFINITION_SECRET_REJECTED: "Agent Definition 拒绝保存敏感信息",
  MEMORY_NOT_CONFIRMABLE: "候选记忆不存在或已处理",
  MEMORY_NOT_FOUND: "记忆不存在",
  MEMORY_SECRET_REJECTED: "记忆拒绝保存敏感信息",
  MEMORY_INVALID: "记忆内容无效，请填写不超过 8 KB 的有效文本",
  TOOL_PERMISSION_REVISION_CONFLICT: "工具权限已被其他窗口更新",
  SKILL_REGISTRY_REVISION_CONFLICT: "Skill 列表已变化，请刷新后重试",
  SKILL_PROFILE_REVISION_CONFLICT: "Agent 的 Skill 配置已变化，请刷新后重试",
  SKILL_NOT_FOUND: "Skill 不存在",
  SKILL_NOT_ENABLED: "Skill 未为当前 Agent 启用",
  SKILL_PACKAGE_IN_USE: "Skill 仍被 Agent Profile 引用，不能卸载",
  SKILL_MANIFEST_INVALID: "Skill 包清单无效",
  SKILL_INSTALL_INVALID: "请选择有效的本地 Skill 目录或安装包",
  SKILL_UNINSTALL_INVALID: "内置 Skill 不能卸载",
  SKILL_PACKAGE_TOO_LARGE: "Skill 包超过容量上限",
  SKILL_PACKAGE_CHANGED: "Skill 包内容已变化，请重新安装或重试",
  SKILL_INELIGIBLE: "当前 Agent 的工具或 Runtime 能力不满足该 Skill 的依赖",
  SKILL_SECRET_REJECTED: "Skill 包包含敏感信息，已拒绝安装",
  SKILL_VERSION_CONFLICT: "同一 Skill 版本的内容冲突",
  SKILL_PROJECTION_COLLISION: "Codex Skill 投影目录已被其他来源占用",
  SKILL_PROJECTION_INVALID: "Skill 无法安全投影到 Codex Runtime",
  TRANSCRIPT_EVENT_NOT_FOUND: "会话事件不存在",
  INTERNAL_ERROR: "Service 内部请求处理失败",
});
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const KINDS = new Set(["IDENTITY", "SOUL", "USER", "AGENTS", "TOOLS", "MEMORY"]);
const MAX_RESULT_BYTES = 56 * 1024;

function protocolError(code) {
  const safe = Object.hasOwn(PUBLIC_MESSAGES, code) ? code : "INTERNAL_ERROR";
  return serviceError(safe, PUBLIC_MESSAGES[safe]);
}
function own(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).every((key) => typeof key === "string");
}
function exact(value, fields) {
  return own(value) && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}
function id(value) { return typeof value === "string" && ID.test(value); }
function text(value, max = 32 * 1024, empty = true) {
  return typeof value === "string" && (empty || value.length > 0) && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= max;
}
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function hash(value) { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function validDefinitionSummary(value) {
  if (!own(value) || !integer(value.revision, 1) || !text(value.actor, 128, false)
    || (value.reason !== null && !text(value.reason, 1024)) || !integer(value.updatedAt)
    || !own(value.documents)) return false;
  return ["IDENTITY", "SOUL", "USER", "AGENTS"].every((kind) => {
    const document = value.documents[kind];
    return own(document) && document.kind === kind && hash(document.contentHash)
      && integer(document.byteLength) && integer(document.revision, 1);
  });
}
function validPage(value, itemValidator, withRevision = false) {
  return own(value) && (!withRevision || integer(value.revision))
    && Array.isArray(value.items) && value.items.every(itemValidator)
    && integer(value.nextCursor) && typeof value.hasMore === "boolean";
}
function validMemoryItem(value) {
  try { validateMemoryItem(value); return true; } catch { return false; }
}
function validTranscriptEvent(value) {
  try { validateEvent(value); return true; } catch { return false; }
}
function validTranscriptSession(value) {
  return own(value) && id(value.id) && typeof value.sessionKey === "string"
    && id(value.profileId) && (value.title === null || text(value.title, 512, false))
    && text(value.status, 64, false) && integer(value.updatedAt)
    && integer(value.transcriptRevision) && integer(value.eventCount);
}
function validTool(value) {
  return own(value) && id(value.name) && text(value.domain, 128, false)
    && text(value.description, 4096) && ["read", "write", "confirm", "destructive"].includes(value.risk)
    && typeof value.enabled === "boolean" && ["allow", "deny"].includes(value.effect);
}
function validSkill(value) {
  return own(value) && id(value.id) && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.name)
    && text(value.version, 128, false) && text(value.description, 4096, false)
    && ["builtin", "user"].includes(value.source) && hash(value.contentHash)
    && Array.isArray(value.requiredTools) && value.requiredTools.every(id)
    && Array.isArray(value.requiredRuntimeCapabilities)
    && value.requiredRuntimeCapabilities.every(id)
    && Array.isArray(value.sourceCompatibility)
    && value.sourceCompatibility.every((item) => ["shoggoth", "codex", "openclaw", "hermes"].includes(item))
    && typeof value.enabled === "boolean" && typeof value.eligible === "boolean"
    && (value.ineligibleReason === null || text(value.ineligibleReason, 128, false));
}
function validComputerSession(value) {
  return own(value) && id(value.id) && id(value.profileId) && id(value.workRunId)
    && Array.isArray(value.allowedApplications) && value.allowedApplications.length >= 1
    && value.allowedApplications.length <= 8
    && value.allowedApplications.every((bundleId) => (
      typeof bundleId === "string" && /^[A-Za-z0-9][A-Za-z0-9.-]{0,255}$/u.test(bundleId)
    ))
    && ["ready", "paused", "closed", "failed"].includes(value.status)
    && integer(value.createdAt) && integer(value.updatedAt) && integer(value.expiresAt)
    && value.updatedAt >= value.createdAt && value.expiresAt >= value.createdAt
    && (value.pauseReason === null || text(value.pauseReason, 128, false));
}
function validComputerStatus(value) {
  if (!own(value) || typeof value.available !== "boolean"
    || (value.driverVersion !== null && !text(value.driverVersion, 64, false))
    || (value.contractVersion !== null && !text(value.contractVersion, 64, false))
    || !own(value.permissions)
    || ![value.permissions.accessibility, value.permissions.screenRecording].every(permission => (
      typeof permission === "boolean" || (value.available === false && permission === null)
    ))
    || !Array.isArray(value.sessions) || !value.sessions.every(validComputerSession)) return false;
  if (value.available === false) return text(value.reason, 128, false);
  return !Object.hasOwn(value, "reason");
}

function validateAgentHarnessParams(method, params) {
  if (!METHOD_SET.has(method) || !own(params)) throw protocolError("INVALID_PARAMS");
  const profileId = params.profileId;
  if (!id(profileId)) throw protocolError("INVALID_PARAMS");
  let valid = false;
  if (method === "harness.definition.meta" || method === "harness.tools.list"
    || method === "harness.skills.usage" || method === "harness.computer.status") {
    valid = exact(params, ["profileId"]);
  } else if (method === "harness.skills.list") {
    valid = exact(params, ["profileId", "cursor", "limit"])
      && integer(params.cursor, 0) && integer(params.limit, 1, 100);
  } else if (method === "harness.skills.preview") {
    valid = exact(params, ["profileId", "skillId", "source", "version", "cursor", "maxBytes"])
      && id(params.skillId) && ["builtin", "user"].includes(params.source)
      && text(params.version, 128, false) && integer(params.cursor, 0)
      && integer(params.maxBytes, 1, 32 * 1024);
  } else if (method === "harness.skills.install") {
    valid = exact(params, ["profileId", "sourcePath", "operationId", "expectedRevision"])
      && text(params.sourcePath, 4096, false) && id(params.operationId)
      && integer(params.expectedRevision, 1);
  } else if (method === "harness.skills.uninstall") {
    valid = exact(params, ["profileId", "skillId", "source", "version", "expectedRevision"])
      && id(params.skillId) && params.source === "user" && text(params.version, 128, false)
      && integer(params.expectedRevision, 1);
  } else if (method === "harness.skills.enable" || method === "harness.skills.global.set") {
    valid = exact(params, ["profileId", "skillId", "source", "version", "enabled", "expectedRevision"])
      && id(params.skillId) && (method === "harness.skills.global.set"
        ? params.source === "user" : params.source === "builtin")
      && text(params.version, 128, false) && typeof params.enabled === "boolean"
      && integer(params.expectedRevision, 1);
  } else if (method === "harness.transcript.sessions") {
    valid = exact(params, ["profileId", "cursor", "limit"])
      && integer(params.cursor, 0) && integer(params.limit, 1, 100);
  } else if (method === "harness.definition.read") {
    valid = exact(params, ["profileId", "kind", "revision"])
      && KINDS.has(params.kind) && (params.revision === null || integer(params.revision, 1));
  } else if (method === "harness.definition.update") {
    valid = exact(params, ["profileId", "kind", "content", "expectedRevision", "reason"])
      && KINDS.has(params.kind) && text(params.content) && integer(params.expectedRevision, 1)
      && (params.reason === null || text(params.reason, 1024));
  } else if (method === "harness.definition.restore") {
    valid = exact(params, ["profileId", "revision", "expectedRevision"])
      && integer(params.revision, 1) && integer(params.expectedRevision, 1);
  } else if (method === "harness.definition.import.stage") {
    valid = exact(params, ["profileId", "operationId", "kind", "content", "sourceProfileId", "sourceRevision"])
      && id(params.operationId) && KINDS.has(params.kind) && !["TOOLS", "MEMORY"].includes(params.kind)
      && text(params.content) && id(params.sourceProfileId) && integer(params.sourceRevision, 1);
  } else if (["harness.definition.import.preview", "harness.definition.import.commit"].includes(method)) {
    valid = exact(params, method.endsWith("commit")
      ? ["profileId", "operationId", "expectedRevision"] : ["profileId", "operationId"])
      && id(params.operationId) && (!method.endsWith("commit") || integer(params.expectedRevision, 1));
  } else if (method === "harness.memory.list") {
    valid = exact(params, ["profileId", "status", "scope", "cursor", "limit"])
      && (params.status === null || ["candidate", "active", "superseded", "deleted"].includes(params.status))
      && (params.scope === null || ["user", "agent", "project", "workspace"].includes(params.scope))
      && integer(params.cursor, 0) && integer(params.limit, 1, 100);
  } else if (method === "harness.memory.create") {
    valid = exact(params, ["profileId", "content", "scope", "expectedRevision"])
      && text(params.content, 8 * 1024, false) && params.content.trim().length > 0
      && ["user", "agent"].includes(params.scope) && integer(params.expectedRevision, 0);
  } else if (method === "harness.memory.delete") {
    valid = exact(params, ["profileId", "id", "expectedRevision"])
      && id(params.id) && integer(params.expectedRevision, 0);
  } else if (method === "harness.memory.update") {
    valid = exact(params, ["profileId", "id", "content", "confidence", "validUntil", "expectedRevision"])
      && id(params.id) && text(params.content, 8 * 1024, false)
      && typeof params.confidence === "number" && Number.isFinite(params.confidence)
      && params.confidence >= 0 && params.confidence <= 1
      && (params.validUntil === null || integer(params.validUntil, 0))
      && integer(params.expectedRevision, 0);
  } else if (method === "harness.transcript.events") {
    valid = exact(params, ["profileId", "sessionId", "cursor", "limit"])
      && id(params.sessionId) && integer(params.cursor, 0) && integer(params.limit, 1, 100);
  } else if (method === "harness.transcript.context.set") {
    valid = exact(params, ["profileId", "sessionId", "eventId", "contextExcluded", "expectedRevision"])
      && id(params.sessionId) && id(params.eventId) && typeof params.contextExcluded === "boolean"
      && integer(params.expectedRevision, 0);
  } else if (method === "harness.tools.permission.set") {
    valid = exact(params, ["profileId", "toolName", "effect", "expectedRevision"])
      && id(params.toolName) && ["allow", "deny"].includes(params.effect)
      && integer(params.expectedRevision, 1);
  }
  if (!valid) throw protocolError("INVALID_PARAMS");
  return structuredClone(params);
}

function validateAgentHarnessResult(method, result) {
  if (!METHOD_SET.has(method) || !own(result)) throw protocolError("HARNESS_RESPONSE_INVALID");
  let encoded;
  try { encoded = JSON.stringify(result); } catch { throw protocolError("HARNESS_RESPONSE_INVALID"); }
  if (!text(encoded, MAX_RESULT_BYTES)) throw protocolError("HARNESS_RESPONSE_TOO_LARGE");
  let valid = false;
  if (method === "harness.definition.meta") {
    valid = validDefinitionSummary(result.current) && Array.isArray(result.history)
      && result.history.every(validDefinitionSummary) && typeof result.historyHasMore === "boolean"
      && Array.isArray(result.files) && result.files.every((file) => own(file)
        && KINDS.has(file.kind) && file.name === `${file.kind}.md` && typeof file.readOnly === "boolean");
  } else if (method === "harness.definition.read") {
    valid = KINDS.has(result.kind) && (result.revision === null
      || integer(result.revision, ["MEMORY", "TOOLS"].includes(result.kind) ? 0 : 1)
      || hash(result.revision))
      && text(result.content) && typeof result.readOnly === "boolean";
  } else if (["harness.definition.update", "harness.definition.restore", "harness.definition.import.commit"].includes(method)) {
    valid = validDefinitionSummary(result.current);
  } else if (method === "harness.definition.import.stage") {
    valid = Array.isArray(result.staged) && result.staged.every((kind) => KINDS.has(kind));
  } else if (method === "harness.definition.import.preview") {
    valid = integer(result.baseRevision, 1) && Array.isArray(result.changes)
      && result.changes.every((change) => own(change) && KINDS.has(change.kind)
        && typeof change.changed === "boolean" && hash(change.beforeHash) && hash(change.afterHash));
  } else if (method === "harness.memory.list") {
    valid = validPage(result, validMemoryItem, true);
  } else if (["harness.memory.create", "harness.memory.update", "harness.memory.delete"].includes(method)) {
    valid = integer(result.revision) && (method === "harness.memory.create"
      ? validMemoryItem(result.item) && result.item.status === "active"
      : result.item === null || validMemoryItem(result.item));
  } else if (method === "harness.transcript.sessions") {
    valid = validPage(result, validTranscriptSession);
  } else if (method === "harness.transcript.events") {
    valid = validPage(result, validTranscriptEvent, true);
  } else if (method === "harness.transcript.context.set") {
    valid = integer(result.revision) && validTranscriptEvent(result.event);
  } else if (method === "harness.tools.list") {
    valid = hash(result.registryRevision) && integer(result.revision, 1)
      && Array.isArray(result.tools) && result.tools.every(validTool);
  } else if (method === "harness.tools.permission.set") {
    valid = integer(result.revision, 1) && Array.isArray(result.tools) && result.tools.every(validTool);
  } else if (method === "harness.skills.list") {
    valid = hash(result.registryRevision) && integer(result.registryVersion, 1)
      && integer(result.profileRevision, 1)
      && validPage(result, validSkill);
  } else if (method === "harness.skills.preview") {
    valid = validSkill(result.skill) && text(result.content, 32 * 1024, false)
      && integer(result.nextCursor, 0) && typeof result.hasMore === "boolean";
  } else if (method === "harness.skills.install" || method === "harness.skills.uninstall") {
    valid = integer(result.registryRevision, 1) && validSkill(result.skill);
  } else if (method === "harness.skills.enable") {
    valid = integer(result.profileRevision, 1) && validSkill(result.skill);
  } else if (method === "harness.skills.global.set") {
    valid = integer(result.registryRevision, 1) && validSkill(result.skill);
  } else if (method === "harness.skills.usage") {
    valid = result.supported === true && own(result.skills)
      && Object.entries(result.skills).every(([name, agents]) => (
        /^[a-z0-9][a-z0-9-]{0,63}$/u.test(name) && own(agents)
        && Object.entries(agents).every(([agent, count]) => id(agent) && integer(count, 1))
      ));
  } else if (method === "harness.computer.status") {
    valid = validComputerStatus(result);
  }
  if (!valid) throw protocolError("HARNESS_RESPONSE_INVALID");
  return structuredClone(result);
}

function mapAgentHarnessError(error) {
  let code;
  try { code = error?.code; } catch {}
  if (code === "MEMORY_REVISION_CONFLICT" || code === "TRANSCRIPT_REVISION_CONFLICT") {
    code = "HARNESS_REVISION_CONFLICT";
  }
  if (code === "SKILL_PROFILE_NOT_FOUND") code = "HARNESS_PROFILE_NOT_FOUND";
  if (["SKILL_INSTRUCTIONS_INVALID", "SKILL_TEXT_INVALID", "SKILL_PATH_INVALID",
    "SKILL_PACKAGE_NOT_FOUND", "UNSAFE_HARDLINK", "UNSAFE_OWNER", "UNSAFE_PATH",
    "UNSAFE_SYMLINK"].includes(code)) code = "SKILL_MANIFEST_INVALID";
  if (code === "SKILL_REVISION_CHANGED") code = "SKILL_REGISTRY_REVISION_CONFLICT";
  if (!Object.hasOwn(PUBLIC_MESSAGES, code)) code = "INTERNAL_ERROR";
  return Object.freeze({ code, message: PUBLIC_MESSAGES[code] });
}

module.exports = {
  AGENT_HARNESS_METHODS,
  PUBLIC_MESSAGES,
  mapAgentHarnessError,
  validateAgentHarnessParams,
  validateAgentHarnessResult,
};
