import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "app/manage-ui/package.json"));
const { build } = require("esbuild");
const temp = await mkdtemp(path.join(tmpdir(), "shoggoth-session-display-"));
const outfile = path.join(temp, "session-display.mjs");

try {
  await build({
    entryPoints: [path.join(root, "app/manage-ui/src/lib/sessionDisplay.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
  });
  const { sessionDisplayPreview, sessionDisplayTitle } = await import(pathToFileURL(outfile).href);
  const t = (key, opts = {}) => ({
    "chat.sessionKindMain": "主会话",
    "chat.sessionKindWeb": "App",
    "chat.sessionKindTgDirect": `TG 私聊 ${opts.id ?? ""}`,
    "chat.sessionKindTgGroup": `TG 群 ${opts.id ?? ""}`,
    "chat.sessionKindTopic": `话题 ${opts.topic ?? ""}`,
    "chat.sessionKindDiscord": `Discord …${opts.id ?? ""}`,
    "chat.sessionKindFallback": `兜底 · ${opts.id ?? ""}`,
    "chat.sessionKindModelRun": `模型试跑 · ${opts.id ?? ""}`,
  }[key] ?? key);

  const app = {
    key: "agent:main:dashboard:0c86d0fb-cbdf-4cb3-b299-fab31041b8e0",
    derivedTitle: "优化 session 的名称显示",
    lastMessagePreview: "我会把会话名称改成可识别的内容",
  };
  const appTitle = sessionDisplayTitle(app, t);
  assert.equal(appTitle, "优化 session 的名称显示");
  assert.equal(sessionDisplayPreview(app, appTitle), "我会把会话名称改成可识别的内容");

  assert.equal(sessionDisplayTitle({ ...app, label: "会话命名优化" }, t), "会话命名优化", "手动重命名优先");
  assert.equal(sessionDisplayTitle({ key: app.key }, t), "App", "空 App 会话不显示 UUID");
  assert.equal(sessionDisplayTitle({ key: app.key, label: "dashboard:0c86d0fb-cbdf-4cb3-b299-fab31041b8e0" }, t), "App", "机器 id 不冒充标题");
  assert.equal(sessionDisplayTitle({
    key: "agent:shoggoth-codex:11111111-1111-4111-8111-111111111111",
    derivedTitle: "原生 Agent 第一条消息",
  }, t), "原生 Agent 第一条消息", "原生 Agent 使用 Service 派生标题");
  assert.equal(sessionDisplayPreview({ ...app, lastMessagePreview: appTitle }, appTitle), "", "副标题不重复主标题");
  assert.equal(sessionDisplayTitle({ key: "agent:main:main" }, t), "主会话");

  const chatPage = await readFile(path.join(root, "app/manage-ui/src/pages/ChatPage.tsx"), "utf8");
  const sessionMenu = await readFile(path.join(root, "app/manage-ui/src/pages/ChatSessionMenu.tsx"), "utf8");
  const zhCN = await readFile(path.join(root, "app/manage-ui/src/i18n/locales/zh-CN.ts"), "utf8");
  const en = await readFile(path.join(root, "app/manage-ui/src/i18n/locales/en.ts"), "utf8");
  assert.match(chatPage, /includeDerivedTitles:\s*true,\s*includeLastMessage:\s*true/, "会话列表必须请求内容标题和最近消息");
  assert.match(chatPage, /sub:\s*sessionDisplayPreview\(s, title\)/, "会话菜单必须接入内容副标题");
  assert.match(sessionMenu, /\$\{s\.title\} \$\{s\.sub\} \$\{s\.key\}/, "隐藏的原始 key 仍须可搜索");
  assert.match(zhCN, /sessionKindWeb:\s*"App"/);
  assert.match(en, /sessionKindWeb:\s*"App"/);

  console.log("chat session display unit: PASS");
} finally {
  await rm(temp, { recursive: true, force: true });
}
