import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const chatPagePath = path.join(root, "app/manage-ui/src/pages/ChatPage.tsx");
const menuPath = path.join(root, "app/manage-ui/src/pages/ChatModelMenu.tsx");
const zhPath = path.join(root, "app/manage-ui/src/i18n/locales/zh-CN.ts");
const enPath = path.join(root, "app/manage-ui/src/i18n/locales/en.ts");

const chatPage = fs.readFileSync(chatPagePath, "utf8");
const menu = fs.readFileSync(menuPath, "utf8");
const zh = fs.readFileSync(zhPath, "utf8");
const en = fs.readFileSync(enPath, "utf8");

// 简短断言，避免失败时把整份源码输出到终端。
function has(haystack, needle, message) {
  assert.ok(haystack.includes(needle), message);
}

// Chat 必须只消费共享 revision store，不能继续维护第二套 v1 TTL 缓存。
assert.equal(chatPage.includes("MODEL_CACHE_KEY_PREFIX"), false, "ChatPage 不得保留私有 v1 模型缓存");
assert.equal(chatPage.includes("function readModelCache("), false, "ChatPage 不得复制缓存解析逻辑");
assert.equal(chatPage.includes("function writeModelCache("), false, "ChatPage 不得直接写模型 localStorage");
has(chatPage, 'backend === "openclaw"', "OpenClaw 聊天模型必须走 agent-scoped 分支");
has(chatPage, "const activeModelsAgentId = activeKey", "切换同后端的原生 Agent 也必须重新加载模型目录");
has(chatPage, 'send("models.list", { view: "configured", agentId })', "OpenClaw 聊天必须读取当前 agent 的 configured 模型");
has(chatPage, "openClawModelCacheRef.current.get(agentId)", "OpenClaw 聊天模型缓存必须按 agentId 读取");
has(chatPage, "openClawModelCacheRef.current.set(agentId", "OpenClaw 聊天模型缓存必须按 agentId 写入");
assert.equal(/send\("models\.list",\s*\{[^}]*view:\s*"all"/s.test(chatPage), false,
  "ChatPage 不得请求管理面使用的全量 all 模型目录");

// 其它后端继续消费共享 revision store，保留 revision 与 backend 隔离。
has(chatPage, "const cached = readModelCatalog(backend)", "backend 变化时需要同步读取共享快照");
has(chatPage, "subscribeModelCatalog(backend", "Chat 常驻期间需要订阅 apply 目录事件");
has(chatPage, "revalidateModelCatalog(", "Chat 需要通过共享 store 做 CAS revalidate");
has(chatPage, "getModelCatalog(backend, knownRevision)", "Chat revalidate 必须携带 known revision");
has(chatPage, "snapshot.legacyPlaceholder", "legacy placeholder 不能被认证为 verified 目录");
has(chatPage, "snapshot.backendId !== backend", "事件必须校验当前 backend，防止目录串台");

// 请求还没返回且没有缓存时，菜单应显示 loading，而不是误报“无匹配模型”。
has(chatPage, "modelsLoading", "ChatPage 需要维护模型加载状态");
has(chatPage, "loading={modelsLoading}", "ChatPage 需要把 provisional 加载态传给模型菜单");
has(menu, "loading?: boolean", "ChatModelMenu 需要接收 loading 属性");
has(menu, 't("chat.loadingModels")', "ChatModelMenu 需要使用 loading 文案");
has(menu, "model-menu__provisional", "已有 placeholder 模型时也要显示 provisional 状态");
assert.match(zh, /loadingModels:\s*"加载模型/, "中文文案需要包含加载模型状态");
assert.match(en, /loadingModels:\s*"Loading models/, "英文文案需要包含加载模型状态");

console.log("chat model cache regression: PASS");
