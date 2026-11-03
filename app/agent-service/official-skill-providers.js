"use strict";

const CATALOG = require("./data/official-skill-connectors.json");
const AUTHENTICATION = { doordash: "interactive", shop: "interactive", "quark-drive": "interactive", "rollinggo-hotel": "interactive", fliggy: "optional-api-key", weread: "api-key", "meituan-paotui": "interactive", alipay: "interactive", "netease-music": "interactive", "baidu-maps": "api-key" };
const VERIFICATION_HOSTS = {
  "baidu-maps": [],
  doordash: ["identity.doordash.com"],
  shop: ["accounts.shop.app", "shop.com"],
  "quark-drive": ["pan.quark.cn"],
  "rollinggo-hotel": ["api.rollinggo.store", "api.rollinggo.cn"],
  fliggy: ["open.fly.ai", "flyai.open.fliggy.com"],
  "meituan-paotui": ["dpurl.cn", "passport.meituan.com", "waimai.meituan.com", "i.meituan.com", "e.meituan.com"],
  weread: ["weread.qq.com"],
  alipay: ["u.alipay.cn", "u.alipay.com", "render.alipay.com", "aipay.alipay.com"],
  "netease-music": ["music.163.com", "interface.music.163.com", "developer.music.163.com", "163cn.tv"],
};

const PROVIDERS = Object.freeze(Object.fromEntries(CATALOG.map(entry => [entry.id, Object.freeze({
  ...entry,
  authentication: AUTHENTICATION[entry.id],
  requiredFields: Object.freeze(entry.fields.filter(field => field.required).map(field => `env:${field.name}`)),
  verificationHosts: Object.freeze(VERIFICATION_HOSTS[entry.id]),
})])));

function getOfficialSkillProvider(id) {
  return typeof id === "string" && Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : null;
}

module.exports = { PROVIDERS, CATALOG, getOfficialSkillProvider };
