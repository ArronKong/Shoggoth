"use strict";
const { serviceError } = require("./security");
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === fields.length && fields.every(key => {
    const field = Object.getOwnPropertyDescriptor(value, key); return field?.enumerable && Object.hasOwn(field, "value");
  });
const nullableText = value => value === null || (typeof value === "string" && value.length > 0
  && value.length <= 512 && value.isWellFormed() && !value.includes("\0"));
const BREAKDOWN_METHOD = "chat.context.breakdown";
const METHODS = ["chat.context.compact", BREAKDOWN_METHOD];
const MESSAGES = Object.freeze(require("./chat-error-messages.json").productContext);
function compactionErrorCode(error) {
  const code = error?.code;
  if (typeof code === "string" && Object.hasOwn(MESSAGES, code) && code.startsWith("PRODUCT_COMPACTION_")) return code;
  if (["AUTH_REQUIRED", "RUNTIME_AUTH_REQUIRED", "RUNTIME_ACCOUNT_BLOCKED"].includes(code)) return "PRODUCT_COMPACTION_AUTH_REQUIRED";
  if (["RUNTIME_MODEL_UNAVAILABLE", "RUNTIME_MODEL_SETTINGS_INVALID"].includes(code)) return "PRODUCT_COMPACTION_MODEL_UNAVAILABLE";
  if (["MODEL_ONLY_OUTPUT_INVALID", "CHECKPOINT_INVALID", "CHECKPOINT_SUMMARY_TOO_LARGE"].includes(code)) return "PRODUCT_COMPACTION_OUTPUT_INVALID";
  if (["MODEL_ONLY_ACCEPTANCE_UNKNOWN", "COMPACTION_RECOVERY_UNAVAILABLE"].includes(code)) return "PRODUCT_COMPACTION_OUTCOME_UNKNOWN";
  return "PRODUCT_COMPACTION_FAILED";
}
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
  const fields = ["profileId", "sessionKey", method === BREAKDOWN_METHOD ? "runId" : "operationId"];
  if (!METHODS.includes(method) || !exact(value, fields)
    || !fields.every(key => typeof value[key] === "string"
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value[key]))) invalid();
  return { ...value };
}
function validateResult(value) {
  if (!exact(value, ["runId", "status"]) || !nullableText(value.runId)
    || !["queued", "running", "completed", "failed", "unchanged"].includes(value.status)) invalid();
  return { ...value };
}
// Shoggoth's own token estimates for one reply's request. History is zero when
// a resumed native session carries it instead of Shoggoth. With toolExposure
// "all" the CLI decides which listed tool definitions it loads.
const COMPOSITION_TOKENS = ["rulesTokens", "definitionTokens", "toolTokens", "memoryTokens", "skillTokens",
  "historyTokens", "messageTokens"];
const COMPOSITION_FIELDS = ["historyDelivered", "toolExposure", ...COMPOSITION_TOKENS, "toolCount"];
const count = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
function validComposition(value) {
  return exact(value, COMPOSITION_FIELDS) && typeof value.historyDelivered === "boolean"
    && ["resident", "all"].includes(value.toolExposure)
    && COMPOSITION_TOKENS.every(key => count(value[key], 1_000_000_000)) && count(value.toolCount, 10_000)
    && (value.historyDelivered || value.historyTokens === 0);
}
function validateBreakdown(value) {
  if (!exact(value, ["runId", "snapshotId", "composition"]) || typeof value.runId !== "string" || !nullableText(value.runId)
    || !(value.snapshotId === null || (typeof value.snapshotId === "string" && /^ctx-[a-f0-9]{64}$/u.test(value.snapshotId)))
    || !(value.composition === null || validComposition(value.composition))) invalid();
  return structuredClone(value);
}
function validateMethodResult(method, value) {
  return method === BREAKDOWN_METHOD ? validateBreakdown(value) : validateResult(value);
}
module.exports = { METHODS, BREAKDOWN_METHOD, MESSAGES, COMPOSITION_FIELDS, compactionErrorCode, validateProductContext,
  validateParams, validateResult, validComposition, validateBreakdown, validateMethodResult };
