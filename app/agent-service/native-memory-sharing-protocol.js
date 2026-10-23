"use strict";
const { serviceError } = require("./security");
const NATIVE_MEMORY_SHARING_METHODS = Object.freeze([
  "memory.sharing.config.apply", "memory.sharing.config.read", "memory.sharing.config.context",
]);
const NATIVE_MEMORY_SHARING_PUBLIC_MESSAGES = Object.freeze({
  NATIVE_MEMORY_SHARING_INVALID: "记忆互查设置无效",
  NATIVE_MEMORY_SHARING_STALE: "记忆互查设置已更新，请刷新后重试",
  NATIVE_MEMORY_SHARING_CONFLICT: "记忆互查设置版本冲突",
  NATIVE_MEMORY_SHARING_UNAVAILABLE: "暂时无法读取记忆互查设置",
  NATIVE_MEMORY_SHARING_UNCERTAIN: "记忆互查设置写入结果尚未确认",
  NATIVE_MEMORY_SHARING_APPLY_FAILED: "未能应用记忆互查设置，已恢复原设置",
  NATIVE_MEMORY_SHARING_ROLLBACK_PENDING: "记忆互查设置未确认恢复，请刷新并检查服务状态",
});
const error = code => serviceError(code, NATIVE_MEMORY_SHARING_PUBLIC_MESSAGES[code]);
const invalid = () => { throw error("NATIVE_MEMORY_SHARING_INVALID"); };
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)
  && !["__proto__", "prototype", "constructor"].includes(value) ? value : invalid();
function record(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) invalid();
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) invalid();
  }
  return value;
}
// The Product settings schema lives only in Core's config-store. Lazy access
// lets Core consume the protocol's errors without introducing a load cycle.
const validateNativeMemorySharingProjection = value => require("../core/config-store").validateNativeMemorySharingProjection(value);
function validateNativeMemorySharingParams(method, value) {
  if (method === "memory.sharing.config.apply") return validateNativeMemorySharingProjection(value);
  if (NATIVE_MEMORY_SHARING_METHODS.includes(method)) { record(value, []); return Object.freeze({}); }
  invalid();
}
function validateNativeMemorySharingResult(method, value) {
  if (method !== "memory.sharing.config.context") return validateNativeMemorySharingProjection(value);
  try {
    record(value, ["owner", "featureReady", "effectiveEnabled", "revision", "agents"]);
    if (!["shoggoth-memory-core", "legacy"].includes(value.owner) || typeof value.featureReady !== "boolean"
      || typeof value.effectiveEnabled !== "boolean" || !Number.isSafeInteger(value.revision) || value.revision < 0
      || value.effectiveEnabled && (!value.featureReady || value.owner !== "shoggoth-memory-core")
      || !Array.isArray(value.agents) || Object.getPrototypeOf(value.agents) !== Array.prototype
      || value.agents.length > 256 || Reflect.ownKeys(value.agents).length !== value.agents.length + 1) invalid();
    const agents = value.agents.map(agent => {
      record(agent, ["profileId", "agentId", "name", "participating"]); id(agent.profileId);
      if (typeof agent.agentId !== "string" || agent.agentId.length > 128 || !agent.agentId.isWellFormed()
        || typeof agent.name !== "string" || agent.name.length > 512 || !agent.name.isWellFormed()
        || typeof agent.participating !== "boolean" || /[\u0000-\u001f\u007f]/u.test(agent.name + agent.agentId)) invalid();
      return Object.freeze({ profileId: agent.profileId, agentId: agent.agentId, name: agent.name, participating: agent.participating });
    });
    if (new Set(agents.map(agent => agent.profileId)).size !== agents.length) invalid();
    return Object.freeze({ owner: value.owner, featureReady: value.featureReady, effectiveEnabled: value.effectiveEnabled,
      revision: value.revision, agents: Object.freeze(agents) });
  } catch { throw error("NATIVE_MEMORY_SHARING_UNAVAILABLE"); }
}
module.exports = { NATIVE_MEMORY_SHARING_METHODS, NATIVE_MEMORY_SHARING_PUBLIC_MESSAGES,
  nativeMemorySharingError: error, validateNativeMemorySharingProjection,
  validateNativeMemorySharingParams, validateNativeMemorySharingResult };
