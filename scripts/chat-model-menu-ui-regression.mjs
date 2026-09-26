import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const menuPath = path.join(root, "app/manage-ui/src/pages/ChatModelMenu.tsx");
const cssPath = path.join(root, "app/manage-ui/src/pages/ChatPage.css");

// 读取文本文件，统一以 UTF-8 解析，保证脚本在任意当前目录下都能运行。
function readText(file) {
  return fs.readFileSync(file, "utf8");
}

// 从 CSS 中按选择器提取声明块；支持逗号组合选择器，避免依赖完整 CSS 解析器。
function findRule(css, selector) {
  const cleanCss = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rulePattern = /([^{}]+)\{([^{}]+)\}/g;
  for (const match of cleanCss.matchAll(rulePattern)) {
    const selectors = match[1].split(",").map((s) => s.trim());
    if (selectors.includes(selector)) return match[2];
  }
  return "";
}

// 将 CSS 声明块转成键值表，便于检查 padding-left 等具体视觉契约。
function parseDeclarations(rule) {
  const declarations = new Map();
  for (const part of rule.split(";")) {
    const [rawName, ...rawValue] = part.split(":");
    const name = rawName?.trim();
    const value = rawValue.join(":").trim();
    if (name && value) declarations.set(name, value);
  }
  return declarations;
}

// 解析 px 数值；当前菜单缩进契约只接受稳定 px，避免 rem 随字体变化造成断言含糊。
function parsePx(value) {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(String(value || "").trim());
  return match ? Number(match[1]) : null;
}

// 从 padding 简写或 padding-left 中计算左侧缩进，覆盖常见 1/2/3/4 值写法。
function leftPaddingPx(declarations) {
  const explicit = parsePx(declarations.get("padding-left"));
  if (explicit !== null) return explicit;
  const padding = declarations.get("padding");
  if (!padding) return 0;
  const parts = padding.split(/\s+/).filter(Boolean);
  const left = parts.length === 1 ? parts[0] : parts.length === 2 ? parts[1] : parts.length === 3 ? parts[1] : parts[3];
  return parsePx(left) ?? 0;
}

const menuSource = readText(menuPath);
const chatCss = readText(cssPath);

assert.equal(menuSource.includes("showAll"), false, "模型菜单不应再维护 showAll 状态");
assert.equal(menuSource.includes("setShowAll"), false, "模型菜单不应再渲染 show-all 切换按钮");
assert.equal(menuSource.includes("model-menu__toggle"), false, "模型菜单 DOM 不应包含 show-all 按钮 class");
assert.equal(menuSource.includes("VIS_DEFAULT_PER_PROVIDER"), false, "模型菜单不应按 provider 截断默认显示数量");
assert.equal(menuSource.includes("hiddenTotal"), false, "模型菜单默认全展开后不应再计算隐藏数量");
assert.match(
  menuSource,
  /model-menu__provisional[^>]+role="status"/,
  "目录后台校验期间必须用可读状态文本提示用户",
);

const labelRule = findRule(chatCss, ".model-menu__label");
const itemRule = findRule(chatCss, ".model-menu__item");
const provisionalRule = findRule(chatCss, ".model-menu__provisional");
assert.notEqual(labelRule, "", "聊天页 CSS 需要定义模型分类标题样式");
assert.notEqual(itemRule, "", "聊天页 CSS 需要定义模型项样式");
assert.notEqual(provisionalRule, "", "目录后台校验提示需要独立样式");
const provisionalDeclarations = parseDeclarations(provisionalRule);
assert.ok(
  provisionalDeclarations.has("color") && provisionalDeclarations.has("padding"),
  "目录后台校验提示不能只靠颜色表达，且需要与模型列表保持清晰间距",
);

const labelLeft = leftPaddingPx(parseDeclarations(labelRule));
const itemLeft = leftPaddingPx(parseDeclarations(itemRule));
assert.ok(
  itemLeft >= labelLeft + 12,
  `模型项左缩进应至少比分类标题多 12px，当前分类=${labelLeft}px，模型项=${itemLeft}px`,
);

console.log("chat model menu UI regression: PASS");
