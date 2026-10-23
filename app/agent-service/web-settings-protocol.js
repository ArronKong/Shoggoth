"use strict";
const { serviceError } = require("./security");
const PROVIDERS = Object.freeze(["exa", "brave", "tavily", "tinyfish"]);
const FETCH_PROVIDERS = Object.freeze(["direct", "exa", "tavily", "tinyfish"]);
const METHODS = Object.freeze(["web.settings.get", "web.settings.set", "web.credentials.set", "web.credentials.clear"]);
const PUBLIC_MESSAGES = Object.freeze({
  WEB_SETTINGS_INVALID: "联网设置无效，请检查服务选择和密钥格式",
  WEB_SETTINGS_CONFLICT: "联网设置或密钥已变化，请重新读取后再保存",
  WEB_SETTINGS_UNAVAILABLE: "无法读取联网设置，请检查本机 Service 后重试",
  WEB_SETTINGS_UNCERTAIN: "联网设置保存结果尚未确认，请重启 Service 后重新读取",
  WEB_CREDENTIALS_LOCKED: "密钥存储暂不可用，请解锁系统钥匙串并重试",
});
function fail(code = "WEB_SETTINGS_INVALID") { throw serviceError(code, PUBLIC_MESSAGES[code]); }
function exact(value, keys) {
  return !!value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}
function revision(value) { return Number.isSafeInteger(value) && value >= 0; }
function config(value, code = "WEB_SETTINGS_INVALID") {
  if (!exact(value, ["searchProvider", "fetchProvider"]) || !PROVIDERS.includes(value.searchProvider)
    || !FETCH_PROVIDERS.includes(value.fetchProvider)) fail(code);
  return { searchProvider: value.searchProvider, fetchProvider: value.fetchProvider };
}
function validateParams(method, value) {
  if (method === "web.settings.get" && exact(value, [])) return {};
  if (method === "web.settings.set" && exact(value, ["expectedRevision", "config"]) && revision(value.expectedRevision))
    return { expectedRevision: value.expectedRevision, config: config(value.config) };
  const setting = method === "web.credentials.set";
  if (["web.credentials.set", "web.credentials.clear"].includes(method)
    && exact(value, ["provider", "expectedRevision", ...(setting ? ["apiKey"] : [])]) && PROVIDERS.includes(value.provider)
    && (value.expectedRevision === null || revision(value.expectedRevision))) {
    if (setting && (typeof value.apiKey !== "string" || !/^[\x21-\x7e]{8,4096}$/u.test(value.apiKey))) fail();
    return { provider: value.provider, expectedRevision: value.expectedRevision, ...(setting ? { apiKey: value.apiKey } : {}) };
  }
  fail();
}
function validateResult(value) {
  if (!exact(value, ["revision", "config", "credentials"]) || !revision(value.revision)
    || !exact(value.credentials, PROVIDERS)) fail("WEB_SETTINGS_UNAVAILABLE");
  const credentials = {};
  for (const provider of PROVIDERS) {
    const item = value.credentials[provider];
    if (!exact(item, ["configured", "revision"]) || typeof item.configured !== "boolean"
      || (item.revision !== null && !revision(item.revision)) || item.configured !== (item.revision !== null)) fail("WEB_SETTINGS_UNAVAILABLE");
    credentials[provider] = { configured: item.configured, revision: item.revision };
  }
  return { revision: value.revision, config: config(value.config, "WEB_SETTINGS_UNAVAILABLE"), credentials };
}
function publicError(error) {
  const code = Object.hasOwn(PUBLIC_MESSAGES, error?.code || "") ? error.code
    : error?.code === "SECRET_REVISION_CONFLICT" ? "WEB_SETTINGS_CONFLICT"
    : error?.code === "credentials_locked" ? "WEB_CREDENTIALS_LOCKED"
    : error?.code === "SECRET_COMMIT_UNCERTAIN" ? "WEB_SETTINGS_UNCERTAIN" : "WEB_SETTINGS_UNAVAILABLE";
  return { code, message: PUBLIC_MESSAGES[code] };
}
module.exports = { PROVIDERS, FETCH_PROVIDERS, METHODS, PUBLIC_MESSAGES, exact, revision, config, fail, validateParams, validateResult, publicError };
