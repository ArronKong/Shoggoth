#!/usr/bin/env node
// 从本机安装的 OpenClaw 插件清单抽 provider 目录快照 → app/core/data/openclaw-provider-catalog.json
// 用法：node scripts/generate-openclaw-provider-catalog.cjs [openclaw根目录]
// 幂等：同一源两次生成逐字节相同（时间戳取源版本派生，不取当前时间）。
// 手工字段（获取密钥 URL / label 覆盖）在旁边的 openclaw-provider-manual.json，本脚本永不触碰。
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2] || "/opt/homebrew/lib/node_modules/openclaw";
const extDir = path.join(root, "dist", "extensions");
if (!fs.existsSync(extDir)) {
  console.error(`extensions 目录不存在：${extDir}（机器未安装 openclaw？）`);
  process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

// OAuth/设备码/CLI 类 method 才进登录入口目录；纯 key/本地类不进。
const OAUTH_METHODS = new Set(["oauth", "oauth-cn", "device", "device-code", "cli", "setup-token", "entra-id"]);
// 「填 Key / 配端点」类 method：api-global/api-cn 是 MiniMax 的双区密钥，
// local/custom 是 Ollama/LM Studio/vLLM 这类只配端点、不需要 Key 的家。
const KEY_METHODS = new Set(["api-key", "api-global", "api-cn", "cloud-api-key", "local", "custom"]);

const providers = {};
// declared = 被 manifest 的 providers[]/modelCatalog 认作 provider（只出现在 setup.envVars
// 里的 deepgram/voyage 这类是「工具密钥」不是模型家）；aliasOf = providerAuthAliases 声明的
// 凭证归一父家（byteplus-plan→byteplus，网关查凭证时会归一，别名不该单独占一行）；
// scopes = onboardingScopes 用途（图像/音乐家不进模型 provider 列表，与上游 onboarding 同口径）。
const ensure = (id) => (providers[id] ||= {
  label: null, icon: null, baseUrl: null, api: null, envKeys: [], defaultModels: [],
  declared: false, aliasOf: null, scopes: [], keyMethods: [], oauth: [],
});

for (const name of fs.readdirSync(extDir).sort()) {
  const manifestPath = path.join(extDir, name, "openclaw.plugin.json");
  if (!fs.existsSync(manifestPath)) continue;
  let m;
  try { m = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { continue; }

  for (const id of Array.isArray(m.providers) ? m.providers : []) {
    const p = ensure(id);
    p.declared = true;
    if (!p.icon && typeof m.icon === "string") p.icon = m.icon;
  }
  const aliasMap = m.providerAuthAliases && typeof m.providerAuthAliases === "object" ? m.providerAuthAliases : {};
  for (const [id, canonical] of Object.entries(aliasMap)) {
    if (typeof canonical !== "string" || !canonical || canonical === id) continue;
    // 只给目录里真有的 id 打别名标记；minimax-cn 这类光在别名表里出现的影子 id 不建条目
    if (providers[id]) providers[id].aliasOf = canonical;
  }
  const catalog = m.modelCatalog && m.modelCatalog.providers;
  if (catalog && typeof catalog === "object") {
    for (const [id, entry] of Object.entries(catalog)) {
      if (!entry || typeof entry !== "object") continue;
      const p = ensure(id);
      p.declared = true;
      if (!p.icon && typeof m.icon === "string") p.icon = m.icon;
      if (!p.baseUrl && typeof entry.baseUrl === "string") p.baseUrl = entry.baseUrl;
      if (!p.api && typeof entry.api === "string") p.api = entry.api;
      if (!p.defaultModels.length && Array.isArray(entry.models)) {
        p.defaultModels = entry.models
          .filter((mm) => mm && typeof mm.id === "string")
          .map((mm) => ({ id: mm.id, name: typeof mm.name === "string" ? mm.name : mm.id }));
      }
    }
  }
  const setupProviders = m.setup && Array.isArray(m.setup.providers) ? m.setup.providers : [];
  for (const sp of setupProviders) {
    if (!sp || typeof sp.id !== "string") continue;
    const p = ensure(sp.id);
    for (const v of Array.isArray(sp.envVars) ? sp.envVars : []) {
      if (typeof v === "string" && !p.envKeys.includes(v)) p.envKeys.push(v);
    }
  }
  for (const c of Array.isArray(m.providerAuthChoices) ? m.providerAuthChoices : []) {
    if (!c || typeof c.provider !== "string") continue;
    const p = ensure(c.provider);
    if (!p.label && typeof c.groupLabel === "string") p.label = c.groupLabel;
    // onboardingScopes 缺省即 text-inference（上游 provider-flow.ts 同款默认）
    for (const s of Array.isArray(c.onboardingScopes) ? c.onboardingScopes : ["text-inference"]) {
      if (typeof s === "string" && !p.scopes.includes(s)) p.scopes.push(s);
    }
    if (KEY_METHODS.has(c.method) && !p.keyMethods.includes(c.method)) p.keyMethods.push(c.method);
    if (OAUTH_METHODS.has(c.method)) {
      p.oauth.push({
        choiceId: c.choiceId || "",
        method: c.method,
        label: c.choiceLabel || c.choiceId || c.method,
        hint: c.choiceHint || "",
      });
    }
  }
}
for (const p of Object.values(providers)) if (!p.label) p.label = null;
for (const [id, p] of Object.entries(providers)) if (!p.label) p.label = id;

const out = {
  sourceVersion: pkg.version,
  generatedBy: "node scripts/generate-openclaw-provider-catalog.cjs",
  generatedAt: `openclaw@${pkg.version}`,
  providers,
};
const dest = path.join(__dirname, "..", "app", "core", "data", "openclaw-provider-catalog.json");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
console.log(`✓ ${Object.keys(providers).length} providers → ${dest}（源 openclaw@${pkg.version}）`);
