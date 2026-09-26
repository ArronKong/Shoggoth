import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const identityPath = path.join(root, "app/manage-ui/src/model-identity.ts");
const modelsPagePath = path.join(root, "app/manage-ui/src/pages/ModelsPage.tsx");
const settingsPanelPath = path.join(root, "app/manage-ui/src/pages/models/HermesModelSettings.tsx");
const clientPath = path.join(root, "app/manage-ui/src/api/client.ts");
const zhPath = path.join(root, "app/manage-ui/src/i18n/locales/zh-CN.ts");
const enPath = path.join(root, "app/manage-ui/src/i18n/locales/en.ts");
const typescriptPath = path.join(root, "app/manage-ui/node_modules/typescript/lib/typescript.js");

// 按稳定的起止锚点提取函数或 JSX 局部，避免全文件断言被无关位置的同名调用误满足。
function sourceSection(sourceText, startMarker, endMarker, label) {
  const start = sourceText.indexOf(startMarker);
  assert.notEqual(start, -1, `${label} 缺少起始锚点: ${startMarker}`);
  const end = sourceText.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${label} 缺少结束锚点: ${endMarker}`);
  return sourceText.slice(start, end);
}

// 使用项目自带 TypeScript 编译器加载真实纯函数，避免回归脚本复制实现细节。
const ts = await import(pathToFileURL(typescriptPath).href);
const source = fs.readFileSync(identityPath, "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2020,
  },
  fileName: identityPath,
});
const identity = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`
);

const {
  hasConfiguredModel,
  isValidHttpUrl,
  modelIdentity,
  modelMayMatchScopeForDeletion,
  modelMatchesScope,
} = identity;

const alpha = { provider: "alpha", id: "shared-model", name: "Shared Model" };
const beta = { provider: "beta", id: "shared-model", name: "Shared Model" };

// 新增前必须按 provider + 模型 id 精确识别重复，并兼容配置 id 与目录 catalogId。
const configuredProviders = [
  {
    key: "alpha",
    models: [
      { id: "config-id", catalogId: "catalog-id", name: "Configured Model" },
    ],
  },
];
assert.equal(typeof hasConfiguredModel, "function", "需要导出配置模型重复判断纯函数");
assert.equal(hasConfiguredModel(configuredProviders, "alpha", "config-id"), true);
assert.equal(hasConfiguredModel(configuredProviders, "alpha", "catalog-id"), true);
assert.equal(hasConfiguredModel(configuredProviders, "beta", "config-id"), false);
assert.equal(hasConfiguredModel(configuredProviders, "alpha", "Configured Model"), false);

// React key 必须纳入 provider，跨 provider 的同名 id 不得冲突。
assert.notEqual(modelIdentity(alpha), modelIdentity(beta));
assert.equal(modelIdentity(alpha), modelIdentity({ ...alpha }));

// OpenClaw 不返回 providerByScope 时，既兼容裸 id/name，也兼容 provider/id 引用。
assert.equal(modelMatchesScope(alpha, "shared-model"), true);
assert.equal(modelMatchesScope(alpha, "Shared Model"), true);
assert.equal(modelMatchesScope(alpha, "alpha/shared-model"), true);
assert.equal(modelMatchesScope(beta, "alpha/shared-model"), false);
assert.equal(
  modelMatchesScope(alpha, "shared-model", undefined, [alpha, beta]),
  false,
  "provider 缺失且裸 id 跨 provider 歧义时不得同时命中多个模型",
);
assert.equal(
  modelMatchesScope(beta, "shared-model", undefined, [alpha, beta]),
  false,
  "provider 缺失且裸 id 跨 provider 歧义时不得同时命中多个模型",
);
// 删除属于破坏性操作：旧 API 的裸 id 歧义必须保守视为“可能在用”。
assert.equal(typeof modelMayMatchScopeForDeletion, "function");
assert.equal(modelMayMatchScopeForDeletion(alpha, "shared-model"), true);
assert.equal(modelMayMatchScopeForDeletion(beta, "shared-model"), true);
assert.equal(modelMayMatchScopeForDeletion(alpha, "shared-model", "beta"), false);
assert.equal(modelMayMatchScopeForDeletion(alpha, "other-model"), false);
assert.equal(
  modelMatchesScope(alpha, "shared-model", undefined, [alpha]),
  true,
  "provider 缺失但目录内身份唯一时继续兼容裸 id",
);

// Hermes 返回 providerByScope 时必须先精确匹配 provider，再匹配模型引用。
assert.equal(modelMatchesScope(alpha, "shared-model", "alpha"), true);
assert.equal(modelMatchesScope(beta, "shared-model", "alpha"), false);
assert.equal(modelMatchesScope(alpha, "alpha/shared-model", "alpha"), true);
assert.equal(modelMatchesScope(alpha, "shared-model", "beta"), false);
assert.equal(
  modelMatchesScope({ provider: "alpha", id: "other-model", name: "Shared Model" }, "Shared Model", "alpha"),
  false,
  "provider 已知时不得用展示名误命中同 provider 的另一个模型",
);
assert.equal(
  modelMatchesScope({ provider: "alpha", id: "other-model", name: "Shared Model" }, "Shared Model"),
  true,
  "provider 缺失时继续兼容历史 name 值",
);

// URL 必须能被 URL 解析器接受，且协议严格限定为 HTTP(S)。
for (const valid of ["http://localhost:3000/v1", "https://api.example.com/v1?x=1"]) {
  assert.equal(isValidHttpUrl(valid), true, `应接受 HTTP(S) URL: ${valid}`);
}
for (const invalid of ["", "api.example.com", "ftp://api.example.com", "mailto:test@example.com", "https://", "http://?"]) {
  assert.equal(isValidHttpUrl(invalid), false, `应拒绝非法 URL: ${invalid}`);
}

// 页面断言逐段锁定具体数据流，防止无关位置存在调用却未真正接入目标逻辑。
const modelsPage = fs.readFileSync(modelsPagePath, "utf8");
const modelLoadSection = sourceSection(
  modelsPage,
  "const { data: modelsData",
  "// 目录 + 配置真值合并展示",
  "模型加载",
);
assert.match(modelLoadSection, /providerByScope:\s*active\.providerByScope\s*\|\|\s*\{\}/);
assert.match(modelLoadSection, /const providerByScope:\s*Record<string, string>\s*=\s*modelsData\?\.providerByScope\s*\?\?\s*\{\}/);

const usedBySection = sourceSection(modelsPage, "const usedBy =", "const openDetail =", "usedBy");
assert.match(
  usedBySection,
  /\.filter\(\(\[scopeId, v\]\)\s*=>\s*modelMatchesScope\(m,\s*v,\s*providerByScope\[scopeId\],\s*displayModels\),?\s*\)/,
  "usedBy 必须按 scope provider 调用精确 matcher",
);
assert.doesNotMatch(usedBySection, /v\s*===\s*m\.(?:id|name)/, "usedBy 不得退回裸 id/name 比较");

const activeCardSection = sourceSection(
  modelsPage,
  "const active = Object.entries(byScope)",
  "return (",
  "模型卡片 active",
);
assert.match(
  activeCardSection,
  /\.some\(\(\[scopeId, v\]\)\s*=>\s*modelMatchesScope\(m,\s*v,\s*providerByScope\[scopeId\],\s*displayModels\)/,
  "模型卡片 active 标签必须按 scope provider 调用精确 matcher",
);
const cardJsxSection = sourceSection(modelsPage, "const active = Object.entries(byScope)", "open={!!selected}", "模型卡片 JSX");
// key 必须以 modelIdentity 为基底；草稿卡再叠 kind+index，撞 provider+id 时不共用 key
assert.match(cardJsxSection, /key=\{[^}]*modelIdentity\(m\)/);
assert.match(cardJsxSection, /key=\{m\.__draft\s*\?[\s\S]*?__draftIndex/);
assert.match(cardJsxSection, /\{active\s*&&\s*<span className="tag tag-active">/);

// R286 起辅助模型整合进 HermesModelSettings：写入必须显式携带 provider+model+profile
// （官方双选形态，不再有编码下拉值），目录外旧值靠 withActive 保持可见可选。
const settingsSource = fs.readFileSync(settingsPanelPath, "utf8");
const writeAuxSection = sourceSection(settingsSource, "const writeAux =", "const beginAuxEdit =", "writeAux");
assert.match(
  writeAuxSection,
  /setAuxiliaryModel\(backend,\s*task,\s*provider,\s*model,\s*profile\)/,
  "auxiliary 写入必须显式传 provider/model 并带 profile 作用域",
);
const auxEditSection = sourceSection(settingsSource, "const beginAuxEdit =", "// ---- MoA ----", "auxiliary edit");
assert.match(
  auxEditSection,
  /current\?\.provider\s*&&\s*current\.provider\s*!==\s*"auto"\s*\?\s*current\.provider\s*:\s*main\.provider/,
  "auxiliary 编辑初值：auto 槽位回退主模型 provider",
);
const auxRowsSection = sourceSection(settingsSource, "aux.slots.map((s)", "Mixture of Agents", "auxiliary rows");
assert.match(auxRowsSection, /writeAux\(s\.task,\s*main\.provider,\s*main\.model/, "「设为主模型」必须写入主模型二元组");
assert.match(auxRowsSection, /writeAux\(s\.task,\s*auxDraft\.provider,\s*auxDraft\.model/, "应用草稿必须写入显式二元组");
assert.match(
  auxRowsSection,
  /withActive\(modelsForProvider\(auxDraft\.provider\),\s*auxDraft\.model\)/,
  "目录外旧值必须由 withActive 保持可选",
);
assert.match(settingsSource, /"__reset__"/, "全部重置必须走官方 __reset__ 语义");

const editorOpenSection = sourceSection(modelsPage, "const openModelEditor =", "// provider 端点编辑", "统一模型编辑入口");
assert.match(
  editorOpenSection,
  /customByCatalogId\.get\(customKey\(modelToEdit\.provider,\s*modelToEdit\.id\)\)/,
  "编辑模型必须按 provider + catalogId 精确定位配置条目",
);
assert.match(editorOpenSection, /id:\s*configured\.entry\.id/);
assert.match(editorOpenSection, /maxTokens:\s*configured\.entry\.maxTokens/);
assert.match(modelsPage, /onClick=\{\(\)\s*=>\s*setEditor\(\{\s*mode:\s*"create"\s*\}\)\}/);
assert.match(modelsPage, /<ModelEditorDrawer[\s\S]*?onApplied=\{handleCatalogApplied\}/);

const backendChangeSection = sourceSection(
  modelsPage,
  "const handleBackendChange =",
  "return (",
  "backend 切换 handler",
);
for (const closeState of ["setSelected(null)", "closeEditProvider()", "setEditor(null)", "setCredsOpen(false)"]) {
  assert.match(backendChangeSection, new RegExp(closeState.replace(/[()]/g, "\\$&")));
  assert.ok(
    backendChangeSection.indexOf(closeState) < backendChangeSection.indexOf("setBackend(nextBackend)"),
    `backend 切换必须先执行 ${closeState}`,
  );
}
assert.match(modelsPage, /<BackendTabs\s+value=\{backend\}\s+onChange=\{handleBackendChange\}\s*\/>/);
assert.match(backendChangeSection, /requestNavigation\(\(\)\s*=>\s*\{/);

// 删除语义（现行设计）：使用中不硬拦，但在确认文案里明示在用数量，用户知情确认。
const doRemoveSection = sourceSection(modelsPage, "const doRemove =", "const doSetActive =", "doRemove");
assert.match(
  doRemoveSection,
  /users\.length\s*>\s*0\s*\?\s*t\("models\.deleteInUseWarning",\s*\{\s*count:\s*users\.length\s*\}\)/,
  "在用数量必须并入删除确认文案",
);
assert.ok(
  doRemoveSection.indexOf("const users = usedBy(model)") < doRemoveSection.indexOf("await confirm("),
  "在用统计必须发生在删除确认之前",
);
assert.doesNotMatch(doRemoveSection, /deleteConfirmUsed/);
assert.match(
  doRemoveSection,
  /if\s*\(!\(await syncMutationResult\(r\)\)\)\s*\{[\s\S]*?modelDeleteOperationId\.current[\s\S]*?return;?[\s\S]*?\}[\s\S]*?toast\.success\([\s\S]*?setSelected\(null\)/,
  "删除只有 coordinator applied 且目录同步后才关闭详情",
);
const doRemoveProviderSection = sourceSection(
  modelsPage,
  "const doRemoveProvider =",
  "const doUpdateProvider =",
  "doRemoveProvider",
);
assert.match(
  doRemoveProviderSection,
  /providerModelsByIdentity[\s\S]*?displayModels\.filter[\s\S]*?configured\.id[\s\S]*?configured\.catalogId[\s\S]*?modelMayMatchScopeForDeletion/,
  "provider 使用方检查必须遍历 provider 内全部目录模型",
);
assert.match(
  doRemoveProviderSection,
  /const providerUsers\s*=\s*p\.source\s*===\s*"config"\s*\?\s*findProviderUsers\(byScope,\s*providerByScope\)\s*:\s*\[\]/,
  "config provider 删除前必须按当前 active 状态统计使用方",
);
assert.match(
  doRemoveProviderSection,
  /providerUsers\.length\s*>\s*0\s*\?\s*t\("models\.deleteProviderInUseWarning",\s*\{\s*count:\s*providerUsers\.length\s*\}\)/,
  "provider 在用数量必须并入删除确认文案",
);
assert.ok(
  doRemoveProviderSection.indexOf("await removeModelProvider(actionBackend, p.key, operationId, true)") !== -1,
  "provider 删除必须走带 force 语义的既有调用形状",
);
assert.match(
  doRemoveProviderSection,
  /if\s*\(!\(await syncMutationResult\(r\)\)\)\s*\{[\s\S]*?providerDeleteOperationId\.current[\s\S]*?return;?[\s\S]*?\}[\s\S]*?toast\.success\([\s\S]*?closeEditProvider\(\)/,
  "provider 删除只有 coordinator applied 且目录同步后才关闭",
);
assert.match(
  modelsPage,
  /<button[\s\S]*?type="button"[\s\S]*?className="model-card clickable model-card-button"/,
  "模型卡必须使用原生 button 支持键盘操作",
);

const zh = fs.readFileSync(zhPath, "utf8");
const en = fs.readFileSync(enPath, "utf8");
assert.match(zh, /baseUrlNewInvalid:\s*"请输入有效的 HTTP\(S\) URL。"/);
assert.match(en, /baseUrlNewInvalid:\s*"Enter a valid HTTP\(S\) URL for the new provider\."/);
assert.match(zh, /duplicateConfirm:\s*"同一 provider 下已存在模型 {{id}}。继续将覆盖原配置，确定继续吗？"/);
assert.match(en, /duplicateConfirm:\s*"Model {{id}} already exists under this provider\. Continue to overwrite its configuration\?"/);
assert.match(zh, /deleteInUseWarning:\s*"该模型正被 {{count}} 个 agent\/profile 用作当前模型，删除后它们将失去此模型。"/);
assert.match(en, /deleteInUseWarning:\s*"This model is the active model for {{count}} agent\(s\)\/profile\(s\); deleting it leaves them without it\."/);
assert.doesNotMatch(zh, /删除后它们将回退到其它模型/);
assert.doesNotMatch(en, /they will fall back to other models/);

// API client 断言限定到各自函数，锁定返回类型与既有请求 body 契约。
const client = fs.readFileSync(clientPath, "utf8");
const getActiveSection = sourceSection(client, "export async function getActiveModel(", "// Set the active model", "getActiveModel");
assert.match(getActiveSection, /providerByScope\?:\s*Record<string, string>/);
const setActiveSection = sourceSection(client, "export async function setActiveModel(", "// Auxiliary per-task", "setActiveModel");
assert.match(setActiveSection, /body:\s*JSON\.stringify\(\{\s*modelId,\s*\.\.\.opts\s*\}\)/);
const setAuxiliarySection = sourceSection(client, "export async function setAuxiliaryModel(", "// ---- Hermes 模型设置整合面", "setAuxiliaryModel");
assert.match(setAuxiliarySection, /body:\s*JSON\.stringify\(\{\s*task,\s*provider,\s*model,\s*profile\s*\}\)/);

console.log("model UI identity regression: PASS");
