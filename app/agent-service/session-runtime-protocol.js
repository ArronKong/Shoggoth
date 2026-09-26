"use strict";

const { serviceError } = require("./security");
const { validateRuntimeContextUsage } = require("./runtime-context-usage");
const { RUNTIME_SUPPORT_CODES } = require("./runtime-support");
const SESSION_RUNTIME_METHODS = Object.freeze(["chat.session.runtime.get", "chat.session.runtime.state",
  "chat.session.runtime.switch", "chat.session.runtime.model.set"]);
const SESSION_RUNTIME_PUBLIC_MESSAGES = Object.freeze({
  INVALID_PARAMS: "会话 Runtime 请求无效", SESSION_RUNTIME_RESPONSE_INVALID: "会话 Runtime 响应无效",
  POLICY_REJECTED: "目标必须是该 Agent 已启用的 Runtime Binding", SESSION_BUSY: "会话仍有排队或运行中的任务",
  SESSION_RUNTIME_DISABLED: "手动续接尚未启用", SESSION_RUNTIME_CONFIRMATION_REQUIRED: "请确认模型和权限设置的变化",
  CHAT_SESSION_NOT_FOUND: "会话不存在", CHAT_SESSION_REVISION_CONFLICT: "会话已更新，请刷新后重试",
  CHAT_RUNTIME_HISTORY_CAPACITY: "该会话的原生会话索引已达容量上限，请新建会话",
  SESSION_RUNTIME_UNAVAILABLE: "暂时无法切换会话 Runtime",
  CONTEXT_INPUT_TOO_LARGE: "目标窗口无法容纳必需的指令、当前消息或附件，原会话已保留",
  CONTEXT_COMPACTION_REQUIRED: "目标窗口需要先摘要，请启用自动摘要并配置摘要 Runtime",
  CONTEXT_RECORD_TOO_LARGE: "单条历史超过摘要 Runtime 容量，原文已保留",
  CONTEXT_TRANSPORT_EXCEEDED: "目标 Runtime 的输入传输容量不足，请先压缩历史",
  CONTEXT_CONTENT_UNAVAILABLE: "部分原文无法读取，未进行不完整迁移",
  CONTEXT_CONTENT_CORRUPT: "原文校验未通过，未进行不完整迁移",
  PRODUCT_COMPACTION_FAILED: "上下文摘要未完成，原会话已保留",
  ...Object.fromEntries(RUNTIME_SUPPORT_CODES.map(code => [code, code])),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function error(code) { return serviceError(code, SESSION_RUNTIME_PUBLIC_MESSAGES[code]); }
function exact(value, fields) {
  return value && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === fields.length
    && fields.every(key => { const field = Object.getOwnPropertyDescriptor(value, key);
      return field?.enumerable && Object.hasOwn(field, "value"); });
}
function text(value, nullable = false) { return (nullable && value === null) || (typeof value === "string"
  && value.length > 0 && value.length <= 1024 && value.isWellFormed() && !value.includes("\0")); }
function revision(value) { return Number.isSafeInteger(value) && value >= 1; }
function validateSessionRuntimeParams(method, value) {
  const selectingModel = method === "chat.session.runtime.model.set";
  const switching = method === "chat.session.runtime.switch" || selectingModel;
  if (!SESSION_RUNTIME_METHODS.includes(method)
    || !exact(value, ["profileId", "sessionKey", ...(switching ? ["bindingId", "revision", "acceptAdjustments"] : []),
      ...(selectingModel ? ["model"] : [])])
    || !text(value.profileId) || value.profileId.length > 128 || !UUID.test(value.sessionKey)
    || (switching && (!UUID.test(value.bindingId) || !revision(value.revision) || typeof value.acceptAdjustments !== "boolean"))
    || (selectingModel && (!text(value.model) || Buffer.byteLength(value.model, "utf8") > 512))) {
    throw error("INVALID_PARAMS");
  }
  return Object.freeze({ ...value });
}
function validateSessionRuntimeResult(value, params) {
  try {
    if (!exact(value, ["sessionKey", "revision", "bindingId", "runtime", "model", "contextUsage", "candidates", "canSwitch"])
      || !UUID.test(value.sessionKey) || (params && value.sessionKey !== params.sessionKey)
      || !UUID.test(value.bindingId) || !revision(value.revision) || !text(value.runtime)
      || !text(value.model, true) || typeof value.canSwitch !== "boolean"
      || !Array.isArray(value.candidates) || value.candidates.length > 128) throw new Error();
    const ids = new Set();
    if (Object.getPrototypeOf(value.candidates) !== Array.prototype
      || Reflect.ownKeys(value.candidates).length !== value.candidates.length + 1) throw new Error();
    const candidates = Array.from({ length: value.candidates.length }, (_, index) => {
      const field = Object.getOwnPropertyDescriptor(value.candidates, String(index));
      if (!field?.enumerable || !Object.hasOwn(field, "value")) throw new Error();
      const candidate = field.value;
      if (!exact(candidate, ["bindingId", "support", "adjustments"]) || !UUID.test(candidate.bindingId)
        || ids.has(candidate.bindingId) || !exact(candidate.adjustments, ["clearModelOverride", "permissionMode"])
        || typeof candidate.adjustments.clearModelOverride !== "boolean" || !text(candidate.adjustments.permissionMode, true)) throw new Error();
      ids.add(candidate.bindingId);
      const support = candidate.support;
      if (!(exact(support, ["supported"]) && support.supported === true)
        && !(exact(support, ["supported", "code"]) && support.supported === false && RUNTIME_SUPPORT_CODES.includes(support.code))) throw new Error();
      return structuredClone(candidate);
    });
    if (!ids.has(value.bindingId)) throw new Error();
    return { ...value, candidates, contextUsage: value.contextUsage === null ? null : validateRuntimeContextUsage(value.contextUsage) };
  } catch { throw error("SESSION_RUNTIME_RESPONSE_INVALID"); }
}

module.exports = { SESSION_RUNTIME_METHODS, SESSION_RUNTIME_PUBLIC_MESSAGES, validateSessionRuntimeParams,
  validateSessionRuntimeResult };
