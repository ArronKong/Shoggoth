"use strict";
const { serviceError } = require("./security");
const { validateNativeMemoryConfigProjection, nativeMemoryConfigError } = require("./native-memory-config-protocol");
const METHOD = "memory.active.command";
const MESSAGES = Object.freeze({
  MEMORY_COMMAND_INVALID: "记忆命令参数无效", MEMORY_COMMAND_UNAVAILABLE: "当前记忆服务不支持此命令",
  MEMORY_COMMAND_SESSION_UNAVAILABLE: "记忆命令的聊天归属已变化或不可用",
  MEMORY_COMMAND_STATE_INVALID: "会话记忆设置无法安全读取", MEMORY_COMMAND_CONFIG_REQUIRED: "全局记忆设置需要通过应用的配置入口保存",
  MEMORY_COMMAND_STALE: "记忆命令执行期间设置已变化，请重试",
});
const fail = code => { throw serviceError(code, MESSAGES[code]); };
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const field = Object.getOwnPropertyDescriptor(value, key); return field?.enumerable && Object.hasOwn(field, "value");
  });
const isCommand = text => typeof text === "string" && /^\/active-memory(?:\s|$)/u.test(text.trim());
function validateParams(input) {
  if (!exact(input, ["sessionKey", "text"]) || typeof input.sessionKey !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(input.sessionKey)
    || !isCommand(input.text) || !input.text.isWellFormed() || input.text.includes("\0") || input.text.length > 4096) fail("MEMORY_COMMAND_INVALID");
  return { ...input, text: input.text.trim() };
}
function globalEnabledChange(text) {
  if (!isCommand(text)) return undefined;
  const tokens = text.trim().slice("/active-memory".length).trim().split(/\s+/u).filter(Boolean);
  if (!tokens.includes("--global")) return undefined;
  const action = (tokens.find(token => token !== "--global") || "status").toLowerCase();
  return ["on", "enable", "enabled"].includes(action) ? true
    : ["off", "disable", "disabled"].includes(action) ? false : undefined;
}
function validateResult(input, params) {
  if (!exact(input, ["text", "configUpdate"]) || typeof input.text !== "string" || !input.text.length
    || !input.text.isWellFormed() || input.text.includes("\0") || input.text.length > 8192) fail("MEMORY_COMMAND_INVALID");
  if (params) {
    const enabled = globalEnabledChange(validateParams(params).text);
    if ((enabled !== undefined) !== (input.configUpdate !== null)
      || (enabled !== undefined && input.text !== `Active Memory: ${enabled ? "on" : "off"} globally.`)) fail("MEMORY_COMMAND_INVALID");
  }
  if (input.configUpdate === null) return { text: input.text, configUpdate: null };
  const update = input.configUpdate;
  if (!exact(update, ["expectedRevision", "config"]) || !Number.isSafeInteger(update.expectedRevision)
    || update.expectedRevision < 0 || update.expectedRevision >= Number.MAX_SAFE_INTEGER) fail("MEMORY_COMMAND_INVALID");
  const next = validateNativeMemoryConfigProjection({ revision: update.expectedRevision + 1, config: update.config });
  return { text: input.text, configUpdate: { expectedRevision: update.expectedRevision, config: next.config } };
}
function validateConfigUpdate(update, params, current) {
  const enabled = globalEnabledChange(validateParams(params).text);
  if (enabled === undefined) fail("MEMORY_COMMAND_INVALID");
  const before = validateNativeMemoryConfigProjection(current);
  if (update.expectedRevision !== before.revision) throw nativeMemoryConfigError("NATIVE_MEMORY_CONFIG_STALE");
  // An IPC response may propose only the two fields owned by this command.
  // Check the rest against Core's authoritative snapshot before any write.
  const expected = structuredClone(before.config);
  expected.plugins ??= {}; expected.plugins.entries ??= {};
  const entry = expected.plugins.entries["active-memory"] ??= {};
  entry.enabled = true; entry.config ??= {}; entry.config.enabled = enabled;
  const checked = validateNativeMemoryConfigProjection({ revision: before.revision + 1, config: expected });
  const next = validateNativeMemoryConfigProjection({ revision: before.revision + 1, config: update.config });
  if (JSON.stringify(next) !== JSON.stringify(checked)) fail("MEMORY_COMMAND_INVALID");
  return { expectedRevision: before.revision, config: checked.config };
}
module.exports = { METHOD, MESSAGES, fail, isCommand, validateParams, validateResult, validateConfigUpdate };
