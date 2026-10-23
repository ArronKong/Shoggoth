"use strict";
const { serviceError } = require("./security");
const METHODS = Object.freeze(["source", "owner", "list", "get", "create", "update", "setStatus", "run", "runs.list", "runs.result", "runs.control", "content.read", "models.list"]
  .map(name => `codex.automation.${name}`));
const MESSAGES = Object.freeze({
  CODEX_AUTOMATION_UNAVAILABLE: "Codex 客户端任务来源暂不可用",
  CODEX_AUTOMATION_OWNER_UNAVAILABLE: "需要一个默认运行时为 Codex CLI 的 AI 助理",
  CODEX_AUTOMATION_NOT_FOUND: "Codex 任务或运行记录不存在",
  CODEX_AUTOMATION_FORMAT_UNSUPPORTED: "任务文件格式不受支持，原文件已保留",
  CODEX_AUTOMATION_STORAGE_UNKNOWN: "无法确认客户端存储模式，暂不能写入任务",
  CODEX_AUTOMATION_MIGRATED: "此任务已由 Codex 账号或云端管理，文件接入不能修改它",
  CODEX_AUTOMATION_DELETED: "客户端任务已删除，不能通过文件重新创建",
  CODEX_AUTOMATION_CAPACITY: "Codex 任务数据超过读取上限",
  CODEX_AUTOMATION_CONFLICT: "任务已被另一端修改，请刷新后再保存",
  CODEX_AUTOMATION_COMMIT_UNCERTAIN: "保存结果待核验，请刷新任务；不要重复提交",
  CODEX_AUTOMATION_SCHEDULE_UNSUPPORTED: "当前客户端支持每周指定时间或按小时间隔；原高级计划已保留",
  CODEX_AUTOMATION_MODEL_UNAVAILABLE: "所选模型或思考强度在原生 Codex CLI 中不可用",
  CODEX_AUTOMATION_RUN_UNSUPPORTED: "此任务需要 Codex 客户端原会话或项目环境，暂不能在 Shoggoth 手动运行",
  CODEX_AUTOMATION_WORKSPACE_UNAVAILABLE: "任务工作目录不可用，未使用默认目录代替",
  CODEX_AUTOMATION_RUN_BUSY: "此任务已有进行中的手动运行，请查看运行记录",
  CODEX_AUTOMATION_OPERATION_CONFLICT: "运行请求标识已用于另一个任务或配置",
  CODEX_AUTOMATION_PARAMS_INVALID: "Codex 任务参数无效",
  CODEX_AUTOMATION_RESPONSE_INVALID: "Codex 任务响应无效",
  CODEX_AUTOMATION_RESULT_UNAVAILABLE: "运行正文暂不可读取，摘要不代表完整结果",
});
const fields = {
  source: ["backendId"], owner: ["backendId"], list: ["profileId", "offset", "limit"], get: ["profileId", "id"],
  create: ["profileId", "operationId", "spec"], update: ["profileId", "id", "revision", "patch"],
  setStatus: ["profileId", "id", "revision", "enabled"], run: ["profileId", "id", "revision", "operationId"],
  "runs.list": ["profileId", "id", "offset", "limit"], "runs.result": ["profileId", "id", "runId"],
  "runs.control": ["profileId", "id", "runId", "operationId", "action", "requestId", "choice", "answers"],
  "content.read": ["profileId", "id", "field", "runId", "revision", "offset", "limit"], "models.list": ["profileId"],
};
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype && !Array.isArray(value);
const text = (value, max = 256) => typeof value === "string" && value.length > 0 && value.length <= max && value.isWellFormed() && !value.includes("\0");
const revision = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const invalid = () => { throw serviceError("CODEX_AUTOMATION_PARAMS_INVALID", MESSAGES.CODEX_AUTOMATION_PARAMS_INVALID); };
function validateParams(method, params) {
  const name = method.replace(/^codex\.automation\./u, ""), keys = fields[name];
  if (!keys || !plain(params) || Object.keys(params).sort().join() !== [...keys].sort().join()
    || Object.values(Object.getOwnPropertyDescriptors(params)).some(value => !("value" in value))) invalid();
  if (keys.includes("profileId") && !text(params.profileId, 128)) invalid();
  if (keys.includes("id") && !text(params.id, 256)) invalid();
  if (keys.includes("backendId") && !text(params.backendId, 64)) invalid();
  if (keys.includes("revision") && !revision(params.revision)) invalid();
  if (keys.includes("offset") && (!Number.isSafeInteger(params.offset) || params.offset < 0 || params.offset > 16 * 1024 * 1024)) invalid();
  if (keys.includes("limit") && (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > (name === "content.read" ? 6000 : 20))) invalid();
  if (keys.includes("enabled") && typeof params.enabled !== "boolean") invalid();
  if (keys.includes("operationId") && (!text(params.operationId, 128) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(params.operationId))) invalid();
  if (keys.includes("runId") && !(name === "content.read" && params.runId === null) && !text(params.runId, 256)) invalid();
  if (name === "content.read" && !["prompt", "result"].includes(params.field)) invalid();
  if (name === "runs.control" && (!["stop", "approval", "input", "cancel-input"].includes(params.action)
    || !(params.requestId === null || text(params.requestId, 128))
    || !(params.choice === null || text(params.choice, 128))
    || !plain(params.answers) || Object.keys(params.answers).length > 32
    || Object.entries(params.answers).some(([key, value]) => !text(key, 128) || typeof value !== "string" || value.length > 16384))) invalid();
  for (const key of ["spec", "patch"]) {
    if (!keys.includes(key)) continue;
    const value = params[key];
    if (!plain(value) || Object.keys(value).length === 0 || Object.keys(value).some(field => ![
      "name", "prompt", "rrule", "model", "reasoningEffort", "enabled", "kind", "cwd", "executionEnvironment", "targetThreadId",
    ].includes(field)) || Buffer.byteLength(JSON.stringify(value)) > 40 * 1024) invalid();
    if (key === "patch" && "kind" in value) invalid();
    for (const field of ["name", "prompt", "rrule", "cwd", "targetThreadId"]) {
      if (field in value && !text(value[field], field === "prompt" ? 32 * 1024 : field === "rrule" ? 2048 : field === "name" ? 256 : 4096)) invalid();
    }
    for (const field of ["model", "reasoningEffort"]) if (field in value && value[field] !== null && !text(value[field], 256)) invalid();
    if ("enabled" in value && typeof value.enabled !== "boolean") invalid();
    if ("kind" in value && !["cron", "heartbeat"].includes(value.kind)) invalid();
    if ("executionEnvironment" in value && !["local", "worktree"].includes(value.executionEnvironment)) invalid();
  }
  return params;
}
const { OWNER, ACCOUNT_ID } = require("./codex-automation-store");
const responseInvalid = () => { throw serviceError("CODEX_AUTOMATION_RESPONSE_INVALID", MESSAGES.CODEX_AUTOMATION_RESPONSE_INVALID); };
const timestamp = value => value === null || (Number.isSafeInteger(value) && value >= 0);
const nullableText = (value, max = 4096) => value === null || text(value, max);
const page = value => value === null || (Number.isSafeInteger(value) && value >= 0 && value <= 16 * 1024 * 1024);
const taskId = value => typeof value === "string" && /^codex-automation:[a-f0-9]{24}:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);
const STATUSES = new Set(["preparing", "admitted", "needs_verification", "queued", "starting", "running", "waiting_approval", "waiting_input", "completed", "failed", "canceled", "interrupted", "skipped", "unknown"]);
function closed(value, allowed, required = allowed) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !("value" in item))) responseInvalid();
}
// Ownership can move between Agents, so a task must belong to the owner the
// request named rather than to a fixed Agent.
function validateJob(job, ownerProfileId) {
  closed(job, ["id", "externalTaskId", "origin", "backendId", "agentId", "ownerProfileId", "runtimeAccountId", "revision", "name", "enabled", "state", "schedule", "model", "reasoningEffort", "createdAt", "updatedAt", "lastRunAt", "lastStatus", "lastError", "nextRunAt", "nextRunSource", "promptPreview", "promptLength", "actions", "sourceReason", "runReason", "codex"]);
  if (!taskId(job.id) || job.id.split(":").at(-1) !== job.externalTaskId || job.origin !== "codex-desktop"
    || !text(job.ownerProfileId, 128) || (ownerProfileId !== undefined && job.ownerProfileId !== ownerProfileId)
    || !text(job.agentId, 128) || job.backendId !== OWNER.backendId || job.runtimeAccountId !== ACCOUNT_ID
    || !revision(job.revision) || !text(job.name, 256) || typeof job.enabled !== "boolean" || !["ACTIVE", "PAUSED"].includes(job.state)
    || job.enabled !== (job.state === "ACTIVE") || !nullableText(job.model) || !nullableText(job.reasoningEffort)
    || ![job.createdAt, job.updatedAt, job.lastRunAt, job.nextRunAt].every(timestamp) || job.createdAt === null || job.updatedAt === null
    || !nullableText(job.promptPreview, 512) || !Number.isSafeInteger(job.promptLength) || job.promptLength < 1
    || !["calculated", "codex-desktop"].includes(job.nextRunSource) || !nullableText(job.lastError)
    || ![job.lastStatus, job.sourceReason, job.runReason].every(item => nullableText(item, 128))) responseInvalid();
  closed(job.schedule, ["kind", "rrule", "tz", "anchorMs"]);
  if (job.schedule.kind !== "rrule" || !text(job.schedule.rrule, 2048) || !text(job.schedule.tz, 128) || !timestamp(job.schedule.anchorMs) || job.schedule.anchorMs === null) responseInvalid();
  closed(job.actions, ["edit", "toggle", "delete", "run"]);
  if (Object.values(job.actions).some(item => typeof item !== "boolean") || job.actions.delete !== false) responseInvalid();
  closed(job.codex, ["kind", "cwd", "cwds", "target", "executionEnvironment", "targetThreadId", "modelEditable", "scheduler"]);
  if (!["cron", "heartbeat"].includes(job.codex.kind) || !nullableText(job.codex.cwd) || !Array.isArray(job.codex.cwds) || job.codex.cwds.length > 64
    || job.codex.cwds.some(item => !text(item, 4096)) || !nullableText(job.codex.executionEnvironment)
    || !nullableText(job.codex.targetThreadId) || typeof job.codex.modelEditable !== "boolean" || job.codex.scheduler !== "codex-desktop") responseInvalid();
  if (job.codex.target !== null) { closed(job.codex.target, ["type"]); if (!text(job.codex.target.type, 256)) responseInvalid(); }
}
const RUN_FIELDS = ["runId", "nativeThreadId", "executionOrigin", "status", "executionStatus", "completionStatus", "startedAt", "finishedAt", "summary", "error", "model", "reasoningEffort", "workspace", "taskRevision", "nameAtRun", "reviewStatus", "title"];
function validateRun(run, result = false) {
  closed(run, result ? [...RUN_FIELDS, "interaction", "available", "outputSource", "outputComplete", "contentLength", "contentRevision"] : RUN_FIELDS,
    ["runId", "executionOrigin", "status", "executionStatus", "completionStatus", "startedAt"]);
  if (!text(run.runId, 256) || !["codex-desktop", "shoggoth"].includes(run.executionOrigin)
    || (run.executionOrigin === "codex-desktop" ? !run.runId.startsWith("codex:") : !/^automation-[a-f0-9-]{36}$/u.test(run.runId))
    || !STATUSES.has(run.executionStatus) || !text(run.status, 128) || !["unknown", "succeeded", "failed"].includes(run.completionStatus)
    || !timestamp(run.startedAt) || run.startedAt === null) responseInvalid();
  for (const key of ["nativeThreadId", "model", "reasoningEffort", "workspace", "reviewStatus", "nameAtRun", "summary", "error", "title"]) {
    if (key in run && !(run[key] === null || (typeof run[key] === "string" && run[key].length <= 4096
      && run[key].isWellFormed() && !run[key].includes("\0")))) responseInvalid();
  }
  if (("finishedAt" in run && !timestamp(run.finishedAt)) || ("taskRevision" in run && !revision(run.taskRevision))) responseInvalid();
  if (result && (typeof run.available !== "boolean" || typeof run.outputComplete !== "boolean"
    || ![null, "native-session", "native-archive"].includes(run.outputSource)
    || !Number.isSafeInteger(run.contentLength) || run.contentLength < 0 || run.contentLength > 8 * 1024 * 1024 || !revision(run.contentRevision)
    || (!run.available && (run.outputComplete || run.contentLength !== 0)))) responseInvalid();
  if ("interaction" in run && run.interaction !== null) {
    closed(run.interaction, ["type", "payload"]);
    if (!["approval", "input"].includes(run.interaction.type) || !plain(run.interaction.payload)) responseInvalid();
  }
}
// Both owner fields are set together; null means no Agent can own the tasks.
function validOwnerIdentity(value) {
  return value.ownerProfileId === null ? value.ownerAgentId === null
    : text(value.ownerProfileId, 128) && text(value.ownerAgentId, 128);
}
function validateResult(method, value, params = {}) {
  if (!METHODS.includes(method) || !plain(value) || Buffer.byteLength(JSON.stringify(value)) > 60 * 1024) responseInvalid();
  const name = method.replace(/^codex\.automation\./u, "");
  if (name === "source") {
    closed(value, ["origin", "ownerProfileId", "ownerAgentId", "backendId", "timeZone", "scheduler", "clientRefreshRequired", "available", "canCreate", "reason", "unavailable", "homeIdentity"],
      ["origin", "ownerProfileId", "ownerAgentId", "backendId", "timeZone", "scheduler", "clientRefreshRequired", "available", "canCreate", "reason", "unavailable"]);
    if (value.origin !== "codex-desktop" || !validOwnerIdentity(value) || (value.available && value.ownerProfileId === null)
      || value.backendId !== OWNER.backendId
      || !text(value.timeZone, 128) || value.scheduler !== "codex-desktop" || value.clientRefreshRequired !== true
      || typeof value.available !== "boolean" || typeof value.canCreate !== "boolean" || (!value.available && value.canCreate)
      || !nullableText(value.reason, 128) || !Array.isArray(value.unavailable)
      || ("homeIdentity" in value && !/^[a-f0-9]{24}$/u.test(value.homeIdentity))) responseInvalid();
    for (const item of value.unavailable) { closed(item, ["id", "reason"]); if (!text(item.id, 128) || !text(item.reason, 128)) responseInvalid(); }
  } else if (name === "owner") {
    closed(value, ["ownerProfileId", "ownerAgentId"]);
    if (!validOwnerIdentity(value)) responseInvalid();
  } else if (["list", "runs.list"].includes(name)) {
    const key = name === "list" ? "jobs" : "runs";
    closed(value, key === "jobs" ? [key, "nextOffset"] : [key, "nextOffset", "sourceError"]);
    if (!Array.isArray(value[key]) || value[key].length > 20 || !page(value.nextOffset)
      || (key === "runs" && !nullableText(value.sourceError, 128))) responseInvalid();
    for (const item of value[key]) key === "jobs" ? validateJob(item, params.profileId) : validateRun(item);
  } else if (["get", "create", "update", "setStatus"].includes(name)) {
    closed(value, ["job"]); validateJob(value.job, params.profileId);
  } else if (name === "runs.result") validateRun(value, true);
  else if (name === "content.read") {
    closed(value, ["content", "revision", "nextOffset"]);
    if (typeof value.content !== "string" || value.content.length > 6000 || !revision(value.revision) || !page(value.nextOffset)) responseInvalid();
  } else if (name === "models.list") {
    closed(value, ["models", "defaultModelId"]);
    if (!Array.isArray(value.models) || value.models.length > 2000 || !nullableText(value.defaultModelId, 256)) responseInvalid();
    const ids = new Set();
    for (const model of value.models) {
      closed(model, ["id", "name", "isDefault", "thinkingOptions", "thinkingDefault"]);
      if (!text(model.id, 256) || !text(model.name, 256) || ids.has(model.id) || typeof model.isDefault !== "boolean"
        || !Array.isArray(model.thinkingOptions) || model.thinkingOptions.length > 16 || model.thinkingOptions.some(item => !text(item, 32))
        || !nullableText(model.thinkingDefault, 32) || (model.thinkingDefault !== null && !model.thinkingOptions.includes(model.thinkingDefault))) responseInvalid();
      ids.add(model.id);
    }
    if (value.defaultModelId !== null && !ids.has(value.defaultModelId)) responseInvalid();
  } else if (name === "run") {
    closed(value, ["runId", "status", "executionOrigin"]);
    if (!/^automation-[a-f0-9-]{36}$/u.test(value.runId) || !STATUSES.has(value.status) || value.executionOrigin !== "shoggoth") responseInvalid();
  } else if (name === "runs.control") {
    closed(value, ["accepted", "status"]); if (value.accepted !== true || !STATUSES.has(value.status)) responseInvalid();
  }
  return structuredClone(value);
}
module.exports = { METHODS, MESSAGES, validateParams, validateResult };
