"use strict";
const { serviceError } = require("./security");
const METHOD = "memory.active.status";
const MESSAGES = Object.freeze({
  MEMORY_STATUS_INVALID: "记忆状态参数或响应无效",
  MEMORY_STATUS_UNAVAILABLE: "暂时无法读取此会话的记忆状态",
});
const fail = code => { throw serviceError(code, MESSAGES[code]); };
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const field = Object.getOwnPropertyDescriptor(value, key); return field?.enumerable && Object.hasOwn(field, "value");
  });
const text = (value, max) => typeof value === "string" && value.length <= max && value.isWellFormed() && !value.includes("\0");
function validateParams(input) {
  if (!exact(input, ["profileId", "sessionKey", "includeTrace"])
    || !text(input.profileId, 128) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(input.profileId)
    || !text(input.sessionKey, 36) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(input.sessionKey)
    || typeof input.includeTrace !== "boolean") fail("MEMORY_STATUS_INVALID");
  return { ...input };
}
const outcomes = ["ok", "empty", "failed", "no_relevant_memory", "timeout", "timeout_partial", "unavailable"];
function validateResult(input, params) {
  if (exact(input, ["supported"]) && input.supported === false) return { supported: false };
  const lines = value => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
    && value.length <= 2 && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index)))
      .every(field => field?.enumerable && Object.hasOwn(field, "value") && text(field.value, 4096));
  if (!exact(input, ["supported", "phase", "outcome", "updatedAt", "statusLines", "traceLines"])
    || input.supported !== true || !["disabled", "idle", "preparing", "recalling", "cleaning", "complete", "stale", "recovery_pending"].includes(input.phase)
    || input.outcome !== null && !outcomes.includes(input.outcome)
    || input.updatedAt !== null && (!Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0)
    || !lines(input.statusLines) || !lines(input.traceLines)
    || params?.includeTrace !== true && input.traceLines.length > 0
    || input.phase !== "complete" && (input.statusLines.length || input.traceLines.length || input.outcome !== null || input.updatedAt !== null)) fail("MEMORY_STATUS_INVALID");
  return structuredClone(input);
}
module.exports = { METHOD, MESSAGES, fail, validateParams, validateResult };
