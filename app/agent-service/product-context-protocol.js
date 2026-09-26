"use strict";
const { serviceError } = require("./security");
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === fields.length && fields.every(key => {
    const field = Object.getOwnPropertyDescriptor(value, key); return field?.enumerable && Object.hasOwn(field, "value");
  });
const nullableText = value => value === null || (typeof value === "string" && value.length > 0
  && value.length <= 512 && value.isWellFormed() && !value.includes("\0"));
const METHODS = ["chat.context.compact"];
const MESSAGES = Object.freeze({ PRODUCT_CONTEXT_INVALID: "上下文请求或响应无效", PRODUCT_CONTEXT_UNAVAILABLE: "请在 Agent 设置中配置可生成摘要的 Runtime",
  PRODUCT_CONTEXT_DISABLED: "产品级上下文管理未启用", SESSION_BUSY: "会话仍有任务，请完成后再压缩", CHAT_SESSION_NOT_FOUND: "会话不存在",
  PRODUCT_CONTEXT_FAILED: "上下文压缩未完成，请查看任务状态" });
function invalid() { throw serviceError("PRODUCT_CONTEXT_INVALID", MESSAGES.PRODUCT_CONTEXT_INVALID); }
function validateProductContext(value) {
  if (!exact(value, ["automatic", "reason", "summaryBindingId", "summaryRuntime", "summaryModel", "checkpointId",
    "coveredThroughSeq", "pendingRunId", "lastError", "measurement", "nativeAuto", "budget", "transfer"])
    || !["enabled", "unavailable", "disabled"].includes(value.automatic)
    || ![null, "NO_TOOL_FREE_BINDING", "FEATURE_DISABLED"].includes(value.reason)
    || !["live", "restored", "missing", "stale", "unsupported"].includes(value.measurement)
    || !["enabled", "disabled", "unknown"].includes(value.nativeAuto)
    || !["summaryBindingId", "summaryRuntime", "summaryModel", "checkpointId", "pendingRunId", "lastError"].every(key => nullableText(value[key]))
    || !Number.isSafeInteger(value.coveredThroughSeq) || value.coveredThroughSeq < 0) invalid();
  const budget = value.budget;
  if (!exact(budget, ["tokens", "source", "triggerTokens", "retainedTokens"])
    || !["runtime", "catalog", "last_observed", "model_spec", "fallback"].includes(budget.source)
    || !["tokens", "triggerTokens", "retainedTokens"].every(key => Number.isSafeInteger(budget[key]) && budget[key] > 0)
    || budget.retainedTokens > budget.triggerTokens || budget.triggerTokens > budget.tokens) invalid();
  const transfer = value.transfer;
  if (transfer !== null && (!exact(transfer, ["state", "targetBindingId", "model", "sourceRevision", "sourceSessionRevision", "snapshotId", "mode", "errorCode", "updatedAt"])
    || !["preparing", "ready", "accepted", "unknown", "failed"].includes(transfer.state)
    || !["original", "summary", "partial", "transport_summary"].includes(transfer.mode)
    || typeof transfer.targetBindingId !== "string" || !nullableText(transfer.targetBindingId)
    || !["model", "snapshotId", "errorCode"].every(key => nullableText(transfer[key]))
    || !["sourceRevision", "sourceSessionRevision", "updatedAt"].every(key => Number.isSafeInteger(transfer[key]) && transfer[key] >= 0))) invalid();
  return structuredClone(value);
}
function validateParams(method, value) {
  if (!METHODS.includes(method) || !exact(value, ["profileId", "sessionKey", "operationId"])
    || !["profileId", "sessionKey", "operationId"].every(key => typeof value[key] === "string"
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value[key]))) invalid();
  return { ...value };
}
function validateResult(value) {
  if (!exact(value, ["runId", "status"]) || !nullableText(value.runId)
    || !["queued", "running", "completed", "failed", "unchanged"].includes(value.status)) invalid();
  return { ...value };
}
module.exports = { METHODS, MESSAGES, validateProductContext, validateParams, validateResult };
