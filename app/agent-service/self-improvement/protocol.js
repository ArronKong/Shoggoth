"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("../security");
const { hasSecret } = require("../memory-engine");

const POLICY_VERSION = 1;
const DAY_MS = 86_400_000;
const LIMITS = Object.freeze({ inputBytes: 128 * 1024, outputBytes: 32 * 1024,
  skillBytes: 24 * 1024, fileBytes: 8 * 1024, references: 4, evidence: 64,
  calls: 16, page: 30 });
// Development ships dormant. Only an explicit per-Agent settings change may
// authorize exporting task evidence and publishing automatically learned Skills.
const DEFAULT_CONFIG = Object.freeze({ mode: "off", model: null, maxInputTokens: null,
  toolResultThreshold: 10, turnThreshold: 4, curationEnabled: true });
const METHODS = new Set(["learning.status", "learning.configure", "learning.request",
  "learning.history", "learning.skills.list", "learning.skills.read", "learning.skills.change",
  "learning.proposal.read", "learning.proposal.resolve"]);
const TERMINAL = new Set(["applied", "pending_review", "noop", "failed", "canceled", "interrupted",
  "outcome_unknown", "rejected", "withdrawn"]);
const PUBLIC_ERRORS = Object.freeze({
  LEARNING_INVALID: "自动学习请求无效", LEARNING_UNAVAILABLE: "自动学习服务不可用",
  LEARNING_CONFLICT: "自动学习记录已变化，请刷新后重试", LEARNING_SOURCE_UNAVAILABLE: "原任务来源已不可用",
  LEARNING_SOURCE_REVOKED: "原任务来源已撤回或变化",
  LEARNING_PROFILE_UNAVAILABLE: "当前 Agent 不可用", LEARNING_UNSUPPORTED: "当前 Runtime 不支持无工具复盘",
  LEARNING_BUDGET: "单次复盘已达到迭代上限", LEARNING_INPUT_BUDGET: "单次复盘已达到输入预算", LEARNING_PROTECTED: "该技能当前不允许自动修改",
  LEARNING_OUTPUT_INVALID: "复盘结果格式或内容未通过检查", LEARNING_STORE_CORRUPT: "自动学习存储校验失败",
  LEARNING_VERSION_UNAVAILABLE: "技能版本已撤回或不可用", LEARNING_BUSY: "当前 Agent 正忙",
});
function fail(code = "LEARNING_INVALID") { throw serviceError(code, PUBLIC_ERRORS[code] || "自动学习操作未能完成"); }
const digest = value => crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const object = value => !!value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).every(key => typeof key === "string" && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"));
const exact = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const text = (value, max = 1024, empty = false) => typeof value === "string" && value.isWellFormed()
  && !/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  && (empty || value.trim().length > 0) && Buffer.byteLength(value) <= max;
const configValidators = {
  mode: value => ["auto", "review", "off"].includes(value),
  model: value => value === null || text(value, 512) && !/\s/u.test(value),
  maxInputTokens: value => value === null || Number.isSafeInteger(value),
  toolResultThreshold: value => integer(value, 1, 100), turnThreshold: value => integer(value, 1, 50),
  curationEnabled: value => typeof value === "boolean",
};
function validateConfig(value, partial = false) {
  if (!object(value) || !Object.keys(value).length
    || !partial && Object.keys(value).length !== Object.keys(DEFAULT_CONFIG).length
    || Object.entries(value).some(([key, val]) => !Object.hasOwn(configValidators, key) || !configValidators[key](val))) fail();
  return structuredClone(value);
}
// Schema v1 had additional daily quotas and waiting periods. Validate before
// migrating so malformed settings never become an authorization grant.
function migrateLegacyConfig(value) {
  const legacy = { maxRunsPerDay: val => integer(val, 1, 32), maxTokensPerDay: val => integer(val, 1024, 1_000_000),
    idleSeconds: val => integer(val, 30, 3600), cooldownMinutes: val => integer(val, 1, 1440) };
  const current = Object.keys(DEFAULT_CONFIG).filter(key => key !== "maxInputTokens");
  if (!exact(value, [...current, ...Object.keys(legacy)])
    || current.some(key => !configValidators[key](value[key]))
    || Object.entries(legacy).some(([key, check]) => !check(value[key]))) fail("LEARNING_STORE_CORRUPT");
  return { ...Object.fromEntries(current.map(key => [key, value[key]])), maxInputTokens: null };
}
function reviewInputBudget(config, contextWindow = null) {
  if (config.maxInputTokens !== null) return config.maxInputTokens > 0 ? config.maxInputTokens : null;
  return integer(contextWindow, 1) ? Math.min(Math.floor(contextWindow * 0.75), 600_000) : 120_000;
}
function validateParams(method, params) {
  if (!METHODS.has(method) || !object(params) || !id(params.profileId)) fail();
  let valid = false;
  if (method === "learning.status") valid = exact(params, ["profileId"]);
  else if (method === "learning.configure") {
    valid = exact(params, ["profileId", "expectedRevision", "patch"], ["consent"])
      && integer(params.expectedRevision) && (params.consent === undefined || params.consent === true);
    if (valid) validateConfig(params.patch, true);
  } else if (method === "learning.request") valid = exact(params, ["profileId", "runId"]) && id(params.runId);
  else if (["learning.history", "learning.skills.list"].includes(method)) valid = exact(params, ["profileId"], ["cursor", "limit"])
    && (params.cursor === undefined || params.cursor === null || integer(params.cursor, 1))
    && (params.limit === undefined || integer(params.limit, 1, LIMITS.page));
  else if (method === "learning.skills.read") valid = exact(params, ["profileId", "skillId"], ["versionHash"])
    && id(params.skillId) && (params.versionHash === undefined || hash(params.versionHash));
  else if (method === "learning.proposal.read") valid = exact(params, ["profileId", "jobId"]) && id(params.jobId);
  else if (method === "learning.skills.change") valid = exact(params, ["profileId", "skillId", "expectedRevision", "action"], ["versionHash", "body"])
    && id(params.skillId) && integer(params.expectedRevision, 1)
    && ["pin", "unpin", "archive", "restore", "adopt", "revert", "edit"].includes(params.action)
    && (params.action === "revert" ? hash(params.versionHash) : params.versionHash === undefined)
    && (params.action === "edit" ? text(params.body, LIMITS.fileBytes) && !hasSecret(params.body) : params.body === undefined);
  else if (method === "learning.proposal.resolve") valid = exact(params, ["profileId", "jobId", "expectedRevision", "action"])
    && id(params.jobId) && integer(params.expectedRevision, 1) && ["accept", "reject"].includes(params.action);
  if (!valid) fail();
  return structuredClone(params);
}
function validateProposal(value) {
  if (exact(value, ["action", "reason"]) && value.action === "noop" && text(value.reason, 1024) && !hasSecret(value.reason)) return structuredClone(value);
  if (!exact(value, ["action", "reason", "title", "description", "body", "references", "evidence"], ["skillId", "baseVersionHash"])
    || !["create", "patch"].includes(value.action)
    || !text(value.reason, 1024) || !text(value.title, 160) || !text(value.description, 512)
    || !text(value.body, LIMITS.fileBytes) || !Array.isArray(value.references) || value.references.length > LIMITS.references
    || !Array.isArray(value.evidence) || !value.evidence.length || value.evidence.length > LIMITS.evidence
    || (value.action === "patch" ? !id(value.skillId) || !hash(value.baseVersionHash) : value.skillId !== undefined || value.baseVersionHash !== undefined)
    || hasSecret(JSON.stringify(value))) fail("LEARNING_OUTPUT_INVALID");
  const paths = new Set();
  for (const file of value.references) {
    if (!exact(file, ["path", "content"]) || !/^references\/[a-z0-9][a-z0-9-]{0,63}\.(?:md|txt)$/u.test(file.path)
      || paths.has(file.path) || !text(file.content, LIMITS.fileBytes)) fail("LEARNING_OUTPUT_INVALID");
    paths.add(file.path);
  }
  if (value.evidence.some(ref => !exact(ref, ["runId", "eventId"]) || !id(ref.runId) || !id(ref.eventId))
    || Buffer.byteLength(JSON.stringify(value)) > LIMITS.skillBytes) fail("LEARNING_OUTPUT_INVALID");
  return structuredClone(value);
}
function parseProposal(raw) {
  if (!text(raw, LIMITS.outputBytes)) fail("LEARNING_OUTPUT_INVALID");
  try { return validateProposal(JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u, "$1"))); }
  catch { fail("LEARNING_OUTPUT_INVALID"); }
}
function reviewRequired(proposal) {
  return /(?:ignore|override|bypass)\s+(?:all\s+)?(?:previous|user|system|permission|approval)|(?:绕过|忽略|覆盖).{0,8}(?:用户指令|系统指令|权限|审批)|(?:api[_-]?key|access[_-]?token)\s*[:=]/iu
    .test(JSON.stringify(proposal));
}
function validateResult(method, result) {
  if (!METHODS.has(method) || !object(result) || Buffer.byteLength(JSON.stringify(result)) > 44 * 1024) fail("LEARNING_OUTPUT_INVALID");
  const safe = (value, depth = 0) => {
    if (depth > 12) return false;
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "string") return text(value, 32 * 1024, true);
    if (Array.isArray(value)) return value.length <= 256 && value.every(item => safe(item, depth + 1));
    return object(value) && Object.entries(value).every(([key, item]) => !["__proto__", "prototype", "constructor",
      "credentialRef", "runtimeProfileId", "runtimeAccountId", "bindingId", "fingerprint", "sourceRefs", "workspace", "accountHome", "filePath"].includes(key)
      && safe(item, depth + 1));
  };
  const skill = value => object(value) && id(value.id) && id(value.name) && hash(value.head)
    && integer(value.revision, 1) && ["managed", "user"].includes(value.owner)
    && [value.pinned, value.archived, value.revoked].every(item => typeof item === "boolean");
  let valid = safe(result);
  if (["learning.status", "learning.configure"].includes(method)) {
    valid &&= exact(result, ["supported", "settings", "capability", "budget", "running", "latestRunId", "agentName", "policyVersion", "curation"])
      && result.supported === true && object(result.settings) && integer(result.settings.revision)
      && object(result.capability) && typeof result.capability.supported === "boolean" && typeof result.running === "boolean"
      && (result.latestRunId === null || id(result.latestRunId)) && object(result.budget)
      && ["tokens", "runs", "globalTokens", "unknownCalls"].every(key => integer(result.budget[key]));
    if (valid) validateConfig(result.settings.config);
  } else if (["learning.history", "learning.skills.list"].includes(method)) {
    valid &&= exact(result, ["supported", "items", "nextCursor"]) && result.supported === true
      && Array.isArray(result.items) && result.items.length <= LIMITS.page
      && (result.nextCursor === null || integer(result.nextCursor, 1));
    if (valid) valid = result.items.every(item => method === "learning.skills.list" ? skill(item)
      : object(item) && id(item.id) && integer(item.revision, 1) && Array.isArray(item.calls) && item.calls.length <= LIMITS.calls
        && ["queued", "reviewing", "validating", ...TERMINAL].includes(item.state));
  } else if (method === "learning.request") valid &&= exact(result, ["queued", "runId", "jobId", "state"])
    && typeof result.queued === "boolean" && id(result.runId) && (result.jobId === null || id(result.jobId));
  else if (method === "learning.skills.read") valid &&= exact(result, ["skill", "version", "files", "history", "changes", "usage"])
    && skill(result.skill) && object(result.version) && hash(result.version.hash) && Array.isArray(result.files)
    && result.files.length <= LIMITS.references + 1 && result.files.every(file => exact(file, ["path", "content"])
      && (file.path === "SKILL.md" || /^references\/[a-z0-9][a-z0-9-]{0,63}\.(?:md|txt)$/u.test(file.path))
      && text(file.content, LIMITS.skillBytes)) && Array.isArray(result.history) && result.history.length <= 10;
  else if (method === "learning.skills.change") valid &&= exact(result, ["skill"]) && skill(result.skill);
  else if (method === "learning.proposal.read") {
    valid &&= exact(result, ["id", "revision", "state", "proposal", "runIds", "sourceCount"])
      && id(result.id) && integer(result.revision, 1) && Array.isArray(result.runIds);
    if (valid) validateProposal(result.proposal);
  } else if (method === "learning.proposal.resolve") valid &&= exact(result, ["skill"]) ? skill(result.skill)
    : exact(result, ["id", "revision", "state"]) && id(result.id) && integer(result.revision, 1) && result.state === "rejected";
  if (!valid) fail("LEARNING_OUTPUT_INVALID");
  return structuredClone(result);
}
module.exports = { POLICY_VERSION, DAY_MS, LIMITS, DEFAULT_CONFIG, METHODS, TERMINAL, PUBLIC_ERRORS,
  fail, digest, object, exact, id, hash, integer, text, validateConfig, validateParams,
  validateProposal, parseProposal, reviewRequired, validateResult, migrateLegacyConfig, reviewInputBudget };
