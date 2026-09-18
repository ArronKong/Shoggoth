#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "../app/manage-ui/node_modules/typescript/lib/typescript.js";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const uiRequire = createRequire(path.join(root, "app/manage-ui/package.json"));
const React = uiRequire("react");
const { act, create } = uiRequire("react-test-renderer");
const { useTranslation } = uiRequire("react-i18next");
const { cliReferenceCommands } = require("../app/agent-service/native-cli-commands.js");
const modules = new Map();
const values = new Map([["openclaw.i18n.locale", "en"]]);
const browser = {
  navigator: { language: "en-US" }, document: { documentElement: { lang: "" } },
  localStorage: { getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
};
const compile = (source) => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
} }).outputText;
function load(file) {
  const absolute = path.resolve(root, file);
  if (modules.has(absolute)) return modules.get(absolute).exports;
  const module = { exports: {} };
  modules.set(absolute, module);
  vm.runInNewContext(compile(fs.readFileSync(absolute, "utf8")), {
    module, exports: module.exports, AbortSignal, Error, ...browser,
    require: (name) => name.startsWith(".")
      ? load(path.resolve(path.dirname(absolute), `${name}.ts`)) : uiRequire(name),
  }, { filename: absolute });
  return module.exports;
}
const { default: i18n, applyConfiguredLocale } = load("app/manage-ui/src/i18n/index.ts");
const { translateSlashDescription: describe } = load("app/manage-ui/src/lib/slashDescription.ts");
const policy = load("app/manage-ui/src/lib/slashCommands.ts");
const { SlashCatalogStore } = load("app/manage-ui/src/lib/slashCatalog.ts");
const tEn = i18n.getFixedT("en");
const tZh = i18n.getFixedT("zh-CN");
const runtimes = ["codex", "claude-code", "grok-build", "pi", "antigravity", "deepseek-harness"];
let checked = 0;
function assertLocalized(rows, scope) {
  assert.ok(rows.length > 0, `${scope}: nonempty catalog`);
  for (const row of rows) {
    const translated = describe(row.description, tZh);
    assert.match(translated, /\p{Script=Han}/u, `${scope} /${row.name}: ${row.description}`);
    assert.notEqual(translated, row.description, `${scope} /${row.name} needs an actual translation`);
    assert.equal(describe(row.description, tEn), row.description, `${scope} English retains upstream prose`);
    checked += 1;
  }
}
assertLocalized(policy.SLASH_COMMANDS, "OpenClaw/shared");
for (const runtime of runtimes) {
  assertLocalized(cliReferenceCommands(runtime), runtime);
  // The built-in Shoggoth Agent has the same bound runtime and explicit app extras.
  assertLocalized(policy.mergeNativeSlashCommands(cliReferenceCommands(runtime)), `Shoggoth:${runtime}`);
}
// Live Grok bootstrap wording overrides the CLI reference descriptions.
const grokHost = fs.readFileSync(path.join(root, "app/agent-service/grok-build-runtime-host.js"), "utf8");
const grokBootstrapSource = grokHost.match(/const GROK_BUILD_BOOTSTRAP_COMMANDS = normalizeRuntimeCommands\((\[[\s\S]*?\])\);/);
assert.ok(grokBootstrapSource, "Grok bootstrap command metadata");
const grokBootstrap = vm.runInNewContext(`(${grokBootstrapSource[1]})`);
assertLocalized(grokBootstrap, "grok-build bootstrap");
assertLocalized(policy.mergeNativeSlashCommands(grokBootstrap), "Shoggoth:grok-build bootstrap");

// The screenshot's Hermes command strings, including the nested parentheses and
// untranslated grammar. Also exercise the two semantically different /stop rows.
const hermes = [
  ["new", "Start a new session (fresh session ID + history) (usage: /new [name])", "开始新会话（使用新的会话 ID 和聊天记录） (用法：/new [name])"],
  ["clear", "Clear screen and start a new session", "清空屏幕并开始新会话"],
  ["redraw", "Force a full UI repaint (recovers from terminal drift)", "强制重绘整个界面（修复终端显示错位）"],
  ["history", "Show conversation history", "查看会话历史"],
  ["save", "Export the current conversation (bare /save shows usage) (usage: /save <json|md|html> [filename] [redact])", "导出当前会话（仅输入 /save 可查看用法） (用法：/save <json|md|html> [filename] [redact])"],
  ["retry", "Retry the last message (resend to agent)", "重试上一条消息（重新发送给 Agent）"],
  ["prompt", "Compose your next prompt in $EDITOR (markdown), then send it (usage: /prompt [initial text])", "在 $EDITOR 中用 Markdown 编写下一条提示词，然后发送 (用法：/prompt [initial text])"],
  ["undo", "Back up N user turns and re-prompt (default 1) (usage: /undo [N])", "回退 N 个用户轮次并重新提问（默认为 1） (用法：/undo [N])"],
  ["title", "Set a title for the current session (usage: /title [name])", "设置当前会话的标题 (用法：/title [name])"],
].map(([name, description, expected]) => ({ name, description, expected, category: "session", icon: "terminal" }));
assertLocalized(hermes, "Hermes screenshot");
for (const row of hermes) assert.equal(describe(row.description, tZh), row.expected);
assert.equal(describe("Stop background terminals", tZh), "停止后台终端");
assert.equal(describe("Stop the current run.", tZh), "停止当前运行。");
assert.equal(describe("Kill all running background processes", tZh), "终止所有运行中的后台进程");
assert.equal(describe("Clear screen and start a new session (alias for /clear)", tZh),
  "清空屏幕并开始新会话 (/clear 的别名)");
assert.equal(describe("exec: printf '{{name}}'", tZh), "执行：printf '{{name}}'");
assert.equal(describe("alias → /model provider/model", tZh), "别名 → /model provider/model");
assert.equal(describe("  Manage   hooks. ", tZh), "管理钩子");
assert.equal(describe("Project-specific /stop builds release assets", tZh),
  "Project-specific /stop builds release assets", "unknown extensions cannot acquire built-in semantics");
assert.equal(describe("", tZh), "");
assert.equal(describe("压缩较早的会话历史", tEn), "Compact older conversation history");
const skillDescription = "Systematic debugging with root cause investigation. Four phases: investigate, analyze, hypothesize, implement.";
assert.match(describe(skillDescription, tZh), /先确定根因，再修复/);
assert.equal(describe(skillDescription, tEn), skillDescription, "English keeps the full skill metadata");
const rows = policy.mergeNativeSlashCommands(cliReferenceCommands("codex"));
const before = JSON.stringify(rows);
assert.ok(policy.filterSlashCommands("后台终端", rows, (cmd) => describe(cmd.description, tZh))
  .some((cmd) => cmd.name === "stop"));
assert.ok(policy.filterSlashCommands("background", rows, (cmd) => describe(cmd.description, tZh))
  .some((cmd) => cmd.name === "stop"), "English search remains available in Chinese mode");
assert.equal(policy.parseSlashInput("/clean", rows).command.name, "stop");
assert.equal(policy.parseSlashInput("/shoggoth:stop", rows).command.source, "Shoggoth");
assert.equal(policy.parseSlashInput("/停止", rows), null, "command identifiers are never translated");
assert.equal(JSON.stringify(rows), before, "localization never mutates cached command metadata");

// Optional read-only coverage against installed public registries. No Python
// imports or gateway startup: extracting command prose cannot touch user state.
for (const [envKey, pattern] of [
  ["SHOGGOTH_HERMES_COMMANDS_SOURCE", /CommandDef\("([^"]+)",\s*"((?:\\.|[^"\\])*)"/gu],
  ["SHOGGOTH_OPENCLAW_COMMANDS_SOURCE", /defineBuiltinCommand\("([^"]+)",\s*"((?:\\.|[^"\\])*)"/gu],
]) {
  if (!process.env[envKey]) continue;
  const content = fs.readFileSync(process.env[envKey], "utf8");
  const commands = [...content.matchAll(pattern)].map((match) => ({
    name: match[1], description: JSON.parse(`"${match[2]}"`),
  }));
  assertLocalized(commands, envKey);
  console.log(`PASS ${envKey}: ${commands.length} installed command descriptions`);
}

// Render the actual shared JSX used by the normal AND immersive composers.
// React's languageChanged subscription must update cached rows without a refetch.
const page = fs.readFileSync(path.join(root, "app/manage-ui/src/pages/ChatPage.tsx"), "utf8");
const ast = ts.createSourceFile("ChatPage.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function expression(name, environment) {
  let value;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) value = node.initializer?.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(value, name);
  return vm.runInNewContext(compile(`const result = ${value}; result;`), {
    require: uiRequire, exports: {}, ...environment,
  });
}
let requests = 0;
const store = new SlashCatalogStore(async () => { requests += 1; return { supported: true, commands: hermes }; });
await store.load("hermes-main", "hermes", "session-hermes");
const cached = store.getSnapshot()[SlashCatalogStore.key("hermes-main", "hermes", "session-hermes")].commands;
const environment = {
  Fragment: React.Fragment, SlashIcon: () => null, CATEGORY_LABELS: policy.CATEGORY_LABELS,
  translateSlashDescription: describe, slashOpen: true, slashMode: "command", slashIndex: 0,
  slashItems: cached, activeSlashCatalog: null, activeNativeSlash: false,
  retrySlashCatalog: () => {}, setSlashIndex: () => {}, applySlashCommand: () => {}, applySlashArg: () => {},
  slashArgCmd: policy.SLASH_COMMANDS.find((cmd) => cmd.name === "verbose"), slashArgItems: ["on", "off"],
};
function Palette({ mode = "command" }) {
  const { t } = useTranslation();
  return expression("slashMenuNode", { ...environment, slashMode: mode, t });
}
let renderer;
await act(async () => { renderer = create(React.createElement(Palette)); });
const descriptions = () => renderer.root.findAll((node) => node.props.className === "slash-menu__desc")
  .map((node) => node.children.join(""));
assert.deepEqual(descriptions(), cached.map((cmd) => cmd.description));
await act(async () => { await applyConfiguredLocale("zh-CN"); });
assert.deepEqual(descriptions(), hermes.map((cmd) => cmd.expected));
assert.equal(values.get("openclaw.i18n.locale"), "zh-CN");
assert.deepEqual(renderer.root.findAll((node) => node.props.className === "slash-menu__name")
  .map((node) => node.children.join("")), hermes.map((cmd) => `/${cmd.name}`));
assert.equal(requests, 1, "language switching never reloads the runtime directory");
await act(async () => { renderer.update(React.createElement(Palette, { mode: "args" })); });
assert.match(JSON.stringify(renderer.toJSON()), /切换详细输出模式/);
assert.deepEqual(descriptions(), ["/verbose on", "/verbose off"], "argument values keep CLI syntax");
await act(async () => { await applyConfiguredLocale("en"); });
assert.match(JSON.stringify(renderer.toJSON()), /Toggle verbose mode/);
await act(async () => { renderer.update(React.createElement(Palette)); });
assert.deepEqual(descriptions(), cached.map((cmd) => cmd.description));
await act(async () => { await applyConfiguredLocale("zh-CN"); });
const help = expression("helpText", { t: i18n.t.bind(i18n), translateSlashDescription: describe });
assert.match(help(cached), /`\/save` — 导出当前会话/);
assert.match(help(cached), /用法：\/save <json\|md\|html> \[filename\] \[redact\]/);
await act(async () => { renderer.unmount(); });
console.log(`PASS slash description i18n: ${checked} catalog rows, Hermes usage, search, raw dispatch, live locale switch, args and help`);
