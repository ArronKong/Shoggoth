"use strict";

const OFFICIAL_SKILL_IDS = Object.freeze(["doordash", "shop", "quark-drive", "rollinggo-hotel", "fliggy", "meituan-paotui", "weread", "alipay", "baidu-maps"]);
const OFFICIAL_SKILL_METHODS = Object.freeze(["connector.official.status", "connector.official.install", "connector.official.remove", "connector.official.account"]);
const OFFICIAL_SKILL_PUBLIC_MESSAGES = Object.freeze({
  OFFICIAL_SKILL_INVALID_ARGUMENT: "官方连接器参数无效",
  OFFICIAL_SKILL_UNAVAILABLE: "官方连接器服务暂不可用",
  OFFICIAL_SKILL_ACCESS_DENIED: "官方连接器操作未获授权",
  OFFICIAL_SKILL_REVISION_CONFLICT: "连接器状态已变化，请刷新后重试",
  OFFICIAL_SKILL_BUSY: "连接器正在处理，请稍后重试",
  OFFICIAL_SKILL_DOWNLOAD_FAILED: "下载官方组件失败，请检查网络后重试",
  OFFICIAL_SKILL_INTEGRITY_FAILED: "官方组件校验失败，请重新安装",
  OFFICIAL_SKILL_INSTALL_FAILED: "官方连接器安装未完成，请重试",
  OFFICIAL_SKILL_INTERRUPTED: "上次操作被中断，请重试",
  OFFICIAL_SKILL_CONFLICT: "存在同名技能，请先在技能页处理后再安装",
  OFFICIAL_SKILL_OWNERSHIP_CONFLICT: "组件或连接配置已被修改，无法安全替换或删除",
  OFFICIAL_SKILL_STATE_UNAVAILABLE: "连接器安装记录暂不可读，请重启后重试",
  OFFICIAL_SKILL_INCOMPLETE: "组件或连接配置不完整，请修复安装",
  OFFICIAL_SKILL_REMOVE_FAILED: "连接器删除未完成，请重试",
  OFFICIAL_SKILL_NOT_INSTALLED: "请先安装此连接器",
  OFFICIAL_SKILL_AUTH_FAILED: "账号授权未完成，请重试",
  OFFICIAL_SKILL_AUTH_REQUIRED: "请先连接个人 Shop 账号，再继续此操作",
  OFFICIAL_SKILL_AUTH_UNSUPPORTED: "请通过连接器的凭据设置完成此项操作",
  OFFICIAL_SKILL_AUTH_CANCELLED: "账号操作已取消",
  OFFICIAL_SKILL_AUTH_STATUS_FAILED: "暂时无法读取账号状态，请重试",
  OFFICIAL_SKILL_OPERATION_UNCERTAIN: "操作结果尚未确认，请先在服务方应用核对，勿重复提交",
  OFFICIAL_SKILL_SESSION_REQUIRED: "当前会话未提供支付宝所需的真实 UUID，无法发起支付",
  OFFICIAL_SKILL_RUNTIME_MISSING: "官方组件所需的运行环境不可用，请修复安装",
  OFFICIAL_SKILL_PLATFORM_UNSUPPORTED: "此连接器暂不支持当前系统或芯片架构",
  OFFICIAL_SKILL_APPROVAL_REQUIRED: "DoorDash 尚未允许此账号使用当前功能，请核对使用资格或功能权限",
  OFFICIAL_SKILL_DOORDASH_AUTH_REQUIRED: "请先在 DoorDash 连接器中授权个人账号",
  OFFICIAL_SKILL_QUARK_AUTH_REQUIRED: "请先在夸克网盘连接器中授权账号",
  OFFICIAL_SKILL_QUARK_FAILED: "夸克网盘操作未完成，请检查账号、授权范围和服务状态",
  OFFICIAL_SKILL_QUARK_LIMITED: "夸克网盘容量、文件大小或当前账号权益不支持此操作",
  OFFICIAL_SKILL_ROLLINGGO_AUTH_REQUIRED: "请先在 RollingGo 酒店连接器中授权账号，无需 API Key",
  OFFICIAL_SKILL_RATE_LIMITED: "服务请求过于频繁，请等待后再试；未自动重试",
  OFFICIAL_SKILL_PURCHASE_REVIEW_REQUIRED: "订单信息需要重新核对，请重新预览或使用官方结账链接",
  OFFICIAL_SKILL_OPERATION_UNCERTAIN: "操作结果尚未确认，请先在服务方应用核对，勿重复提交",
});
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, required, optional = []) => plain(value)
  && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => [...required, ...optional].includes(key));
const revision = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, max = 4096) => typeof value === "string" && value.isWellFormed()
  && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const id = value => OFFICIAL_SKILL_IDS.includes(value);
function invalid() { throw Object.assign(new Error(OFFICIAL_SKILL_PUBLIC_MESSAGES.OFFICIAL_SKILL_INVALID_ARGUMENT), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" }); }
function validateOfficialSkillParams(method, value) {
  if (!OFFICIAL_SKILL_METHODS.includes(method)) invalid();
  if (method === "connector.official.status") { if (!exact(value, [])) invalid(); }
  else if (method === "connector.official.account") {
    if (!exact(value, ["id", "expectedRevision", "action"], ["code"]) || !id(value.id) || !revision(value.expectedRevision)
      || !["status", "start", "bind", "logout"].includes(value.action)
      || value.id === "baidu-maps" && value.action !== "status"
      || value.code !== undefined && (value.action !== "bind" || !text(value.code, value.id === "doordash" ? 8192 : value.id === "quark-drive" ? 4096 : 1024))) invalid();
  } else if (!exact(value, ["id", "expectedRevision"]) || !id(value.id) || !revision(value.expectedRevision)) invalid();
  return value;
}
function validateOfficialSkillStatus(value) {
  if (!exact(value, ["id", "revision", "state", "stage", "version", "installedVersion", "skillCount", "serverId", "canRemove", "errorCode"])
    || !id(value.id) || !revision(value.revision)
    || !["notInstalled", "installing", "installed", "removing", "failed"].includes(value.state)
    || ![null, "download", "verify", "installSkills", "registerMcp"].includes(value.stage)
    || !text(value.version, 128) || value.installedVersion !== null && !text(value.installedVersion, 128)
    || !Number.isSafeInteger(value.skillCount) || value.skillCount < 0 || value.skillCount > 64
    || value.serverId !== null && (typeof value.serverId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.serverId))
    || typeof value.canRemove !== "boolean"
    || value.errorCode !== null && !Object.hasOwn(OFFICIAL_SKILL_PUBLIC_MESSAGES, value.errorCode)) invalid();
  return value;
}
const VERIFICATION_HOSTS = Object.freeze({
  "baidu-maps": [],
  doordash: ["identity.doordash.com"],
  shop: ["accounts.shop.app", "shop.com"],
  "quark-drive": ["pan.quark.cn"],
  "rollinggo-hotel": ["api.rollinggo.store", "api.rollinggo.cn"],
  fliggy: ["open.fly.ai", "flyai.open.fliggy.com"],
  "meituan-paotui": ["dpurl.cn", "passport.meituan.com", "waimai.meituan.com", "i.meituan.com", "e.meituan.com"], weread: ["weread.qq.com"],
  alipay: ["u.alipay.cn", "u.alipay.com", "render.alipay.com", "aipay.alipay.com"],
});
function validOfficialVerificationUrl(providerId, value) {
  if (!id(providerId) || !text(value, 8192)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      && VERIFICATION_HOSTS[providerId].includes(url.hostname);
  } catch { return false; }
}
function validateOfficialAccountResult(value) {
  if (!exact(value, ["id", "state", "verificationUrl", "qrCode", "userCode", "userName", "errorCode"])
    || !id(value.id) || !["signedOut", "authorizing", "ready", "unknown"].includes(value.state)
    || value.verificationUrl !== null && !validOfficialVerificationUrl(value.id, value.verificationUrl)
    || value.qrCode !== null && (typeof value.qrCode !== "string" || value.qrCode.length > 128 * 1024
      || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(value.qrCode))
    || value.userCode !== null && !text(value.userCode, 128)
    || value.userName !== null && !text(value.userName, 256)
    || value.errorCode !== null && !Object.hasOwn(OFFICIAL_SKILL_PUBLIC_MESSAGES, value.errorCode)) invalid();
  return value;
}
function validateOfficialSkillResult(method, value) {
  if (method === "connector.official.account") return validateOfficialAccountResult(value);
  if (method === "connector.official.status") {
    if (!exact(value, ["items"]) || !Array.isArray(value.items) || value.items.length !== OFFICIAL_SKILL_IDS.length
      || new Set(value.items.map(item => item.id)).size !== OFFICIAL_SKILL_IDS.length) invalid();
    value.items.forEach(validateOfficialSkillStatus); return value;
  }
  return validateOfficialSkillStatus(value);
}
function officialSkillPublicError(error, fallback = "OFFICIAL_SKILL_UNAVAILABLE") {
  const code = Object.hasOwn(OFFICIAL_SKILL_PUBLIC_MESSAGES, error?.code || "") ? error.code : fallback;
  return { code, message: OFFICIAL_SKILL_PUBLIC_MESSAGES[code] };
}
module.exports = { OFFICIAL_SKILL_IDS, OFFICIAL_SKILL_METHODS, OFFICIAL_SKILL_PUBLIC_MESSAGES,
  validateOfficialSkillParams, validateOfficialSkillStatus, validateOfficialAccountResult,
  validateOfficialSkillResult, validOfficialVerificationUrl, officialSkillPublicError };
