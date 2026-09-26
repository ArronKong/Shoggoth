"use strict";

const { RUNTIME_FRAMEWORK_FLAG_NAMES, resolveRuntimeFrameworkFlags } = require("./runtime-framework-flags");
const { serviceError } = require("./security");

const NATIVE_RUNTIME_CONFIG_METHODS = Object.freeze(["runtime.config.apply", "runtime.capacity.read"]);
const NATIVE_RUNTIME_CONFIG_PUBLIC_MESSAGES = Object.freeze({
  NATIVE_RUNTIME_CONFIG_INVALID: "原生并发配置无效",
  NATIVE_RUNTIME_CONFIG_STALE: "原生并发配置已更新，请刷新后重试",
  NATIVE_RUNTIME_CONFIG_CONFLICT: "原生并发配置版本冲突",
  NATIVE_RUNTIME_CONFIG_UNAVAILABLE: "暂时无法读取原生并发状态",
  NATIVE_RUNTIME_CONFIG_APPLY_FAILED: "未能应用原生并发配置，已恢复原设置",
  NATIVE_RUNTIME_CONFIG_ROLLBACK_PENDING: "原生并发配置未确认恢复，请刷新并检查服务状态",
});

function invalid() {
  return serviceError("NATIVE_RUNTIME_CONFIG_INVALID", NATIVE_RUNTIME_CONFIG_PUBLIC_MESSAGES.NATIVE_RUNTIME_CONFIG_INVALID);
}

function dataRecord(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => !keys.includes(key))) throw invalid();
  return Object.fromEntries(keys.map((key) => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw invalid();
    return [key, field.value];
  }));
}

function integer(value, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid();
  return value;
}

function validateNativeRuntimeConfigProjection(value) {
  try {
    const record = dataRecord(value, ["revision", "maxActive", "startupConcurrency", "flags"]);
    const flags = resolveRuntimeFrameworkFlags(dataRecord(record.flags, RUNTIME_FRAMEWORK_FLAG_NAMES));
    return Object.freeze({
      revision: integer(record.revision, 0),
      maxActive: integer(record.maxActive, 1, 100),
      startupConcurrency: integer(record.startupConcurrency, 1, 16),
      flags,
    });
  } catch { throw invalid(); }
}

function validateNativeCapacitySnapshot(value) {
  try {
    const record = dataRecord(value, ["revision", "maxActive", "startupConcurrency", "enabled", "active", "queued", "byReason"]);
    if (typeof record.enabled !== "boolean") throw invalid();
    const list = record.byReason;
    if (!Array.isArray(list) || Object.getPrototypeOf(list) !== Array.prototype) throw invalid();
    const length = Object.getOwnPropertyDescriptor(list, "length").value;
    if (length > 64 || Reflect.ownKeys(list).length !== length + 1) throw invalid();
    const seen = new Set();
    let total = 0;
    const byReason = [];
    for (let index = 0; index < length; index += 1) {
      const field = Object.getOwnPropertyDescriptor(list, String(index));
      if (!field?.enumerable || !Object.hasOwn(field, "value")) throw invalid();
      const item = dataRecord(field.value, ["reason", "count"]);
      if (typeof item.reason !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(item.reason)
        || seen.has(item.reason)) throw invalid();
      seen.add(item.reason);
      total += integer(item.count, 1);
      byReason.push(Object.freeze({ reason: item.reason, count: item.count }));
    }
    const queued = integer(record.queued, 0);
    if (!Number.isSafeInteger(total) || total > queued) throw invalid();
    return Object.freeze({
      revision: integer(record.revision, 0), maxActive: integer(record.maxActive, 1, 100),
      startupConcurrency: integer(record.startupConcurrency, 1, 16), enabled: record.enabled,
      active: integer(record.active, 0), queued, byReason: Object.freeze(byReason),
    });
  } catch { throw invalid(); }
}

function validateNativeRuntimeConfigParams(method, params) {
  if (method === "runtime.config.apply") return validateNativeRuntimeConfigProjection(params);
  if (method === "runtime.capacity.read") {
    try { dataRecord(params, []); return Object.freeze({}); } catch { throw invalid(); }
  }
  throw invalid();
}

function validateNativeRuntimeConfigResult(method, result) {
  if (method === "runtime.config.apply") return validateNativeRuntimeConfigProjection(result);
  if (method === "runtime.capacity.read") return validateNativeCapacitySnapshot(result);
  throw invalid();
}

module.exports = {
  NATIVE_RUNTIME_CONFIG_METHODS, NATIVE_RUNTIME_CONFIG_PUBLIC_MESSAGES,
  validateNativeRuntimeConfigProjection, validateNativeCapacitySnapshot,
  validateNativeRuntimeConfigParams, validateNativeRuntimeConfigResult,
};
