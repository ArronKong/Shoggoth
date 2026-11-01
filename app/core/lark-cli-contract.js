"use strict";

const LARK_CLI_METHODS = Object.freeze([
  "connector.lark.status", "connector.lark.install", "connector.lark.remove",
  "connector.lark.setup.status", "connector.lark.setup.start", "connector.lark.setup.cancel",
]);
const LARK_CLI_PUBLIC_MESSAGES = Object.freeze({
  LARK_CLI_INVALID_ARGUMENT: "飞书连接器参数无效",
  LARK_CLI_UNAVAILABLE: "飞书连接器服务暂不可用",
  LARK_CLI_UNSUPPORTED: "当前系统暂不支持安装飞书 CLI",
  LARK_CLI_ACCESS_DENIED: "飞书连接器操作未获授权",
  LARK_CLI_REVISION_CONFLICT: "飞书连接器状态已变化，请刷新后重试",
  LARK_CLI_BUSY: "飞书连接器正在处理，请稍后重试",
  LARK_CLI_DOWNLOAD_FAILED: "下载飞书组件失败，请检查网络后重试",
  LARK_CLI_INTEGRITY_FAILED: "飞书组件校验失败，请重新安装",
  LARK_CLI_INSTALL_FAILED: "飞书安装未完成，请重试",
  LARK_CLI_INTERRUPTED: "上次飞书安装或删除被中断，请重试",
  LARK_CLI_SKILL_CONFLICT: "存在同名技能，请先在技能页处理后再安装",
  LARK_CLI_OWNERSHIP_CONFLICT: "安装文件或技能已被修改，无法安全删除",
  LARK_CLI_STATE_UNAVAILABLE: "飞书安装记录暂不可读，请重启后重试",
  LARK_CLI_INCOMPLETE: "飞书 CLI 或配套技能不完整，请重新安装",
  LARK_CLI_REMOVE_FAILED: "飞书删除未完成，请重试",
  LARK_CLI_NOT_INSTALLED: "请先安装飞书连接器",
  LARK_CLI_SETUP_FAILED: "飞书应用配置未完成，请重试",
  LARK_CLI_CONFIG_EXISTS: "已有飞书应用配置，请刷新后使用现有配置登录",
  LARK_CLI_AUTH_FAILED: "飞书授权未完成，请重试",
  LARK_CLI_AUTH_EXPIRED: "飞书授权已过期，请重新发起",
  LARK_CLI_AUTH_CANCELLED: "飞书连接已取消",
  LARK_CLI_AUTH_STATUS_FAILED: "暂时无法读取飞书账号状态，请重试",
});
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const revision = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, max = 4096) => typeof value === "string" && value.length <= max
  && value.isWellFormed() && !/[\0\r\n]/u.test(value);
function invalid() { throw Object.assign(new Error(LARK_CLI_PUBLIC_MESSAGES.LARK_CLI_INVALID_ARGUMENT), { code: "LARK_CLI_INVALID_ARGUMENT" }); }
function validateLarkCliParams(method, input) {
  if (!LARK_CLI_METHODS.includes(method)) invalid();
  if (method === "connector.lark.setup.cancel") {
    if (!exact(input, ["requestId"]) || !uuid(input.requestId)) invalid();
  } else if (method === "connector.lark.setup.start") {
    const keys = ["expectedRevision", "mode", "brand"];
    if (input?.mode === "existing") keys.push("appId", "appSecret");
    if (!exact(input, keys) || !revision(input.expectedRevision) || !["auto", "existing", "reauthorize"].includes(input.mode)
      || !["feishu", "lark"].includes(input.brand)
      || input.mode === "existing" && (typeof input.appId !== "string" || !/^cli_[A-Za-z0-9_-]{4,128}$/u.test(input.appId)
        || !text(input.appSecret, 4096) || !input.appSecret.trim() || /[\u0000-\u0020\u007f]/u.test(input.appSecret))) invalid();
  } else if (["connector.lark.status", "connector.lark.setup.status"].includes(method) ? !exact(input, [])
    : !exact(input, ["expectedRevision"]) || !revision(input.expectedRevision)) invalid();
  return input;
}
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
function validLarkVerificationUrl(value) {
  if (!text(value, 8192)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      && ["open.feishu.cn", "accounts.feishu.cn", "open.larksuite.com", "accounts.larksuite.com"].includes(url.hostname);
  } catch { return false; }
}
function validateLarkCliResult(_method, value) {
  if (_method.startsWith("connector.lark.setup.")) return validateLarkSetupResult(value);
  if (!exact(value, ["id", "revision", "state", "stage", "version", "installedVersion", "skillCount", "cliPath", "canRemove", "errorCode"])
    || value.id !== "lark-cli" || !revision(value.revision)
    || !["notInstalled", "installing", "installed", "removing", "failed"].includes(value.state)
    || ![null, "downloadCli", "downloadSkills", "verify", "installSkills"].includes(value.stage)
    || !text(value.version, 64) || (value.installedVersion !== null && !text(value.installedVersion, 64))
    || !Number.isSafeInteger(value.skillCount) || value.skillCount < 0 || value.skillCount > 64
    || (value.cliPath !== null && (!text(value.cliPath) || !value.cliPath.startsWith("/")))
    || typeof value.canRemove !== "boolean"
    || (value.errorCode !== null && !Object.hasOwn(LARK_CLI_PUBLIC_MESSAGES, value.errorCode))) invalid();
  return value;
}
function validateLarkSetupResult(value) {
  if (!exact(value, ["state", "requestId", "configured", "appId", "brand", "userName", "verificationUrl", "userCode", "qrCode", "expiresAt", "warning", "errorCode"])
    || !["idle", "starting", "configuring", "authorizing", "ready", "cancelled", "failed"].includes(value.state)
    || (value.requestId !== null && !uuid(value.requestId)) || typeof value.configured !== "boolean"
    || (value.appId !== null && (!text(value.appId, 256) || !value.appId))
    || ![null, "feishu", "lark"].includes(value.brand)
    || (value.userName !== null && !text(value.userName, 256))
    || (value.verificationUrl !== null && !validLarkVerificationUrl(value.verificationUrl))
    || (value.userCode !== null && (!text(value.userCode, 128) || /[\u0000-\u001f\u007f]/u.test(value.userCode)))
    || (value.qrCode !== null && (typeof value.qrCode !== "string" || value.qrCode.length > 128 * 1024
      || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(value.qrCode)))
    || (value.expiresAt !== null && (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0))
    || ![null, "missingScopes"].includes(value.warning)
    || (value.errorCode !== null && !Object.hasOwn(LARK_CLI_PUBLIC_MESSAGES, value.errorCode))) invalid();
  return value;
}
function larkCliPublicError(error, fallback = "LARK_CLI_UNAVAILABLE") {
  const code = Object.hasOwn(LARK_CLI_PUBLIC_MESSAGES, error?.code || "") ? error.code : fallback;
  return { code, message: LARK_CLI_PUBLIC_MESSAGES[code] };
}
module.exports = { LARK_CLI_METHODS, LARK_CLI_PUBLIC_MESSAGES, validateLarkCliParams, validateLarkCliResult, larkCliPublicError, validLarkVerificationUrl };
