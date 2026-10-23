"use strict";

const { serviceError } = require("./security");
const { validateChatServiceResult } = require("./chat-service-protocol");
const { UUID } = require("./codex-desktop-session-store");
const METHODS = ["sessions.list", "session.attach", "history"].map(name => `codex.desktop.${name}`);
const MESSAGES = Object.freeze({
  CODEX_DESKTOP_CONTEXT_CHANGED: "原对话的 Shoggoth 记忆或撤回状态已变化，请新建会话继续",
  CODEX_DESKTOP_MANAGED_BY_CLIENT: "请在 Codex 客户端重命名或归档原对话",
  CODEX_DESKTOP_OWNER_UNAVAILABLE: "Codex Desktop 会话需要定时任务所属的原生 Codex Agent",
  CODEX_DESKTOP_STORAGE_UNAVAILABLE: "Codex Desktop 会话来源暂不可用",
  CODEX_DESKTOP_FORMAT_UNSUPPORTED: "当前 Codex Desktop 会话格式尚不受支持",
  CODEX_DESKTOP_NOT_FOUND: "Codex Desktop 原会话已归档、删除或不属于当前来源",
  CODEX_DESKTOP_BUSY: "原对话正在 Codex 客户端运行，请等当前回合结束后再发送",
  CODEX_DESKTOP_RUNTIME_PINNED: "Codex Desktop 原对话需要使用原生 Codex CLI",
  CODEX_DESKTOP_PARAMS_INVALID: "Codex Desktop 会话请求无效",
  CODEX_DESKTOP_RESPONSE_INVALID: "Codex Desktop 会话响应无效",
  CODEX_DESKTOP_UNAVAILABLE: "Codex Desktop 原会话暂不可用",
});
const text = (value, max = 128) => typeof value === "string" && value.length > 0 && value.length <= max && value.isWellFormed() && !value.includes("\0");
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const closed = (value, fields) => plain(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const fail = code => { throw serviceError(code, MESSAGES[code]); };
function validateParams(method, value) {
  if (!METHODS.includes(method) || !plain(value)) fail("CODEX_DESKTOP_PARAMS_INVALID");
  const listing = method.endsWith("sessions.list"), attaching = method.endsWith("session.attach");
  const fields = listing ? ["backendId", "cursor", "limit"] : ["profileId", "threadId", "homeIdentity", ...(attaching ? [] : ["cursor", "limit"])];
  if (!closed(value, fields) || !(listing ? text(value.backendId, 64)
    : text(value.profileId) && typeof value.threadId === "string" && UUID.test(value.threadId)
      && typeof value.homeIdentity === "string" && /^[a-f0-9]{24}$/u.test(value.homeIdentity))) fail("CODEX_DESKTOP_PARAMS_INVALID");
  if (!attaching && (!(value.cursor === null || text(value.cursor, 2048))
    || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 100)) fail("CODEX_DESKTOP_PARAMS_INVALID");
  return structuredClone(value);
}
function validateResult(method, value) {
  if (!METHODS.includes(method) || !plain(value) || Buffer.byteLength(JSON.stringify(value)) > 60 * 1024) fail("CODEX_DESKTOP_RESPONSE_INVALID");
  if (method.endsWith("session.attach")) return validateChatServiceResult("chat.session.create", value);
  if (method.endsWith("history")) return validateChatServiceResult("chat.history", value);
  if (!closed(value, ["sessions", "available", "reason", "nextCursor", "hasMore"])
    || !Array.isArray(value.sessions) || value.sessions.length > 100 || typeof value.available !== "boolean"
    || !(value.reason === null || text(value.reason) && Object.hasOwn(MESSAGES, value.reason)) || typeof value.hasMore !== "boolean"
    || !(value.nextCursor === null || text(value.nextCursor, 2048))
    || value.hasMore !== (value.nextCursor !== null) || (!value.available && (value.sessions.length || value.hasMore || !value.reason))) fail("CODEX_DESKTOP_RESPONSE_INVALID");
  for (const entry of value.sessions) {
    if (!closed(entry, ["session", "threadId", "homeIdentity"]) || typeof entry.threadId !== "string" || !UUID.test(entry.threadId)
      || typeof entry.homeIdentity !== "string" || !/^[a-f0-9]{24}$/u.test(entry.homeIdentity) || entry.session?.source !== "codex-desktop"
      || entry.session.runtimeSessionId !== entry.threadId) fail("CODEX_DESKTOP_RESPONSE_INVALID");
    validateChatServiceResult("chat.session.list", { sessions: [entry.session], nextCursor: null, hasMore: false });
  }
  return structuredClone(value);
}
module.exports = { METHODS, MESSAGES, validateParams, validateResult };
