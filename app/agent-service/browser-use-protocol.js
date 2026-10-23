"use strict";

const BROWSER_SERVICE_METHODS = Object.freeze(["browser.status"]);
const BROWSER_PUBLIC_MESSAGES = Object.freeze({
  BROWSER_DISABLED: "Browser Use 已关闭，请在设置中开启",
  BROWSER_ENGINE_UNAVAILABLE: "Playwright MCP 组件不可用，请检查 Shoggoth 安装",
  BROWSER_EXECUTABLE_UNAVAILABLE: "未找到 Google Chrome，请安装 Chrome 后重新检测",
  BROWSER_SESSION_NOT_FOUND: "浏览器会话已结束，请重新打开",
  BROWSER_SESSION_FORBIDDEN: "当前任务无权访问此浏览器会话",
  BROWSER_SESSION_BUSY: "浏览器会话正在操作，请等待完成",
  BROWSER_SESSION_CAPACITY: "浏览器会话已达上限，请先关闭已有会话",
  BROWSER_SESSION_START_FAILED: "浏览器未能启动，请检查浏览器安装后重试",
  BROWSER_SESSION_CLOSE_FAILED: "浏览器退出尚未确认，请重新检测状态",
  BROWSER_USER_WAIT_UNAVAILABLE: "浏览器正在后台运行，无法人工接管。请在 Browser Use 设置中关闭后台运行后重新打开会话",
  BROWSER_USER_WAIT_FAILED: "浏览器人工接管等待未完成，会话已停止。请重新确认后打开浏览器",
  BROWSER_TOOL_FORBIDDEN: "此 Playwright 工具未开放给 Browser Use",
  BROWSER_ARGUMENTS_INVALID: "Browser Use 参数无效",
  BROWSER_CALL_OUTCOME_UNKNOWN: "浏览器请求已发送，但结果未能确认。请检查页面状态，勿自动重复操作",
  BROWSER_SERVICE_UNAVAILABLE: "Browser Use 后台服务暂不可用",
});

function browserError(code) {
  return Object.assign(new Error(BROWSER_PUBLIC_MESSAGES[code] || BROWSER_PUBLIC_MESSAGES.BROWSER_SERVICE_UNAVAILABLE), { code });
}

function validateBrowserState(value) {
  const exact = (record, keys) => record && Object.getPrototypeOf(record) === Object.prototype
    && Object.keys(record).length === keys.length && Object.keys(record).every(key => keys.includes(key));
  if (!exact(value, ["available", "reason", "engineVersion", "browser", "sessions"])
    || typeof value.available !== "boolean" || value.browser !== "chrome"
    || (value.reason !== null && !Object.hasOwn(BROWSER_PUBLIC_MESSAGES, value.reason))
    || (value.available && value.reason !== null) || (!value.available && value.reason === null)
    || (value.engineVersion !== null && (typeof value.engineVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(value.engineVersion)))
    || !Array.isArray(value.sessions) || value.sessions.length > 4) throw browserError("BROWSER_SERVICE_UNAVAILABLE");
  for (const entry of value.sessions) {
    if (!exact(entry, ["id", "profileId", "workRunId", "browser", "headless", "isolated", "status", "expiresAt"])
      || [entry.id, entry.profileId, entry.workRunId].some(id => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id))
      || entry.browser !== "chrome" || !["starting", "ready", "closing", "close_failed"].includes(entry.status)
      || typeof entry.headless !== "boolean" || typeof entry.isolated !== "boolean"
      || (entry.expiresAt !== null && (!Number.isSafeInteger(entry.expiresAt) || entry.expiresAt <= 0))) throw browserError("BROWSER_SERVICE_UNAVAILABLE");
  }
  return structuredClone(value);
}

module.exports = { BROWSER_SERVICE_METHODS, BROWSER_PUBLIC_MESSAGES, browserError, validateBrowserState };
