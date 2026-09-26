#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const UI_ROOT = resolve(ROOT, "app/manage-ui");

function read(relativePath) {
  const path = resolve(UI_ROOT, relativePath);
  if (!existsSync(path)) throw new Error(`missing:${relativePath}`);
  return readFileSync(path, "utf8");
}

function requireText(source, expected, id) {
  if (!source.includes(expected)) throw new Error(`missing:${id}`);
}

function forbidText(source, forbidden, id) {
  if (source.includes(forbidden)) throw new Error(`forbidden:${id}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractJsxBlock(source, marker, tagName) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) return "";

  const tagPattern = new RegExp(`<\\/?${escapeRegExp(tagName)}(?=[\\s>])`, "g");
  const openTags = [];
  let match = tagPattern.exec(source);
  while (match && match.index < markerIndex) {
    if (match[0].startsWith("</")) openTags.pop();
    else openTags.push(match.index);
    match = tagPattern.exec(source);
  }
  const start = openTags.at(-1);
  if (start === undefined) return "";

  let depth = 1;
  tagPattern.lastIndex = markerIndex;
  while ((match = tagPattern.exec(source))) {
    if (match[0].startsWith("</")) depth -= 1;
    else depth += 1;
    if (depth === 0) {
      const end = source.indexOf(">", match.index);
      return end === -1 ? "" : source.slice(start, end + 1);
    }
  }
  return "";
}

function extractBraceBlockAfter(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) return "";
  const openingBrace = source.indexOf("{", markerIndex + marker.length);
  if (openingBrace === -1) return "";

  let depth = 1;
  for (let index = openingBrace + 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }
  return "";
}

function maskCssCommentsAndStrings(source) {
  const masked = source.split("");
  let index = 0;
  while (index < source.length) {
    if (source[index] === "/" && source[index + 1] === "*") {
      const commentStart = index;
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index = Math.min(index + 2, source.length);
      for (let cursor = commentStart; cursor < index; cursor += 1) {
        if (masked[cursor] !== "\n") masked[cursor] = " ";
      }
      continue;
    }

    if (source[index] === '"' || source[index] === "'") {
      const quote = source[index];
      const stringStart = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index] === quote) {
          index += 1;
          break;
        } else index += 1;
      }
      for (let cursor = stringStart; cursor < index; cursor += 1) {
        if (masked[cursor] !== "\n") masked[cursor] = " ";
      }
      continue;
    }
    index += 1;
  }
  return masked.join("");
}

function cssPreludeMatches(prelude, selector) {
  const normalize = (value) => value.replace(/\s+/g, " ").trim();
  const expected = normalize(selector);
  if (selector.startsWith("@")) return normalize(prelude) === expected;
  return prelude.split(",").some((part) => normalize(part) === expected);
}

function extractCssBlock(source, selector) {
  const masked = maskCssCommentsAndStrings(source);
  for (let openingBrace = 0; openingBrace < masked.length; openingBrace += 1) {
    if (masked[openingBrace] !== "{") continue;

    let preludeStart = openingBrace - 1;
    while (preludeStart >= 0 && !"{};".includes(masked[preludeStart])) preludeStart -= 1;
    const prelude = masked.slice(preludeStart + 1, openingBrace).trim();
    if (!cssPreludeMatches(prelude, selector)) continue;

    let depth = 1;
    for (let index = openingBrace + 1; index < masked.length; index += 1) {
      if (masked[index] === "{") depth += 1;
      if (masked[index] === "}") depth -= 1;
      if (depth === 0) return source.slice(openingBrace + 1, index);
    }
    return "";
  }
  return "";
}

function requireCssDeclaration(source, property, value, id) {
  const pattern = new RegExp(`(?:^|;)\\s*${escapeRegExp(property)}\\s*:\\s*${escapeRegExp(value)}\\s*;`, "m");
  if (!pattern.test(maskCssCommentsAndStrings(source))) throw new Error(`missing:${id}`);
}

function forbidCssDeclaration(source, property, id) {
  const pattern = new RegExp(`(?:^|;)\\s*${escapeRegExp(property)}\\s*:`, "m");
  if (pattern.test(maskCssCommentsAndStrings(source))) throw new Error(`forbidden:${id}`);
}

function extractJsxObjectAttribute(source, attribute) {
  const attributePattern = new RegExp(`\\b${escapeRegExp(attribute)}\\s*=\\s*\\{\\s*\\{`);
  const match = attributePattern.exec(source);
  if (!match) return "";
  const expressionBrace = source.indexOf("{", match.index);
  const objectBrace = source.indexOf("{", expressionBrace + 1);
  let depth = 1;
  for (let index = objectBrace + 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(objectBrace + 1, index);
  }
  return "";
}

function requireExactObject(source, expected, id) {
  const entries = source.split(",").map((entry) => entry.trim()).filter(Boolean);
  const actual = new Map();
  for (const entry of entries) {
    const match = entry.match(/^([A-Za-z_$][\w$]*)\s*:\s*(.+)$/);
    if (!match || actual.has(match[1])) throw new Error(`missing:${id}`);
    actual.set(match[1], match[2].trim());
  }
  if (actual.size !== Object.keys(expected).length) throw new Error(`missing:${id}`);
  for (const [property, value] of Object.entries(expected)) {
    if (actual.get(property) !== value) throw new Error(`missing:${id}`);
  }
}

const packageJson = JSON.parse(read("package.json"));
if (packageJson.dependencies?.["liquid-gooey"] !== "^0.1.0") {
  throw new Error("missing:dependency-liquid-gooey");
}

const page = read("src/pages/ComponentsPage.tsx");
const demo = read("src/components/LiquidGooeyDemo.tsx");
const styles = read("src/components/LiquidGooeyDemo.module.css");
const zh = read("src/i18n/locales/zh-CN.ts");
const en = read("src/i18n/locales/en.ts");

requireText(page, 'import LiquidGooeyDemo from "../components/LiquidGooeyDemo";', "page-import");
requireText(page, '<LiquidGooeyDemo />', "page-render");
if ((page.match(/<LiquidGooeyDemo \/>/g) ?? []).length !== 1) throw new Error("invalid:page-render-count");

for (const [expected, id] of [
  ['import { Liquid } from "liquid-gooey";', "library-import"],
  ['import pillStyles from "./PillTabs.module.css";', "navigation-style-source"],
  ['const [menuOpen, setMenuOpen] = useState(false);', "menu-local-state"],
  ['const [activeTab, setActiveTab] = useState(0);', "tabs-local-state"],
  ['const [switchOn, setSwitchOn] = useState(false);', "switch-default-off"],
  ['const [buttonPressed, setButtonPressed] = useState(false);', "press-local-state"],
  ['data-gallery="liquid-gooey"', "gallery-root"],
  ['<Liquid.Item', "liquid-item"],
  ['pillStyles.tabs', "navigation-list-style"],
  ['pillStyles.tab', "navigation-tab-style"],
  ['pillStyles.tabOn', "navigation-selected-style"],
  ['const tabRect = tab.getBoundingClientRect();', "move-indicator-subpixel-measurement"],
  ['width: indicatorMetrics.width', "move-indicator-dynamic-width"],
  ['translate3d(${indicatorMetrics.left}px, ${indicatorMetrics.top}px, 0)', "move-indicator-dynamic-position"],
  ['role="tablist"', "tabs-role"],
  ['role="tab"', "tab-role"],
  ['aria-selected={activeTab === index}', "tab-selected-state"],
  ['onKeyDown={handleTabKeyDown}', "tabs-keyboard"],
] ) requireText(demo, expected, id);

const morphBlock = extractJsxBlock(demo, 'data-gallery="gooey-morph-toggle"', "article");
for (const [expected, id] of [
  ['data-gallery="gooey-morph-toggle"', "morph-trigger"],
  ['aria-expanded={menuOpen}', "morph-expanded-state"],
  ['transition="smooth"', "morph-transition"],
]) requireText(morphBlock, expected, id);

const tabsBlock = extractJsxBlock(demo, 'data-gallery="gooey-tabs"', "article");
for (const [expected, id] of [
  ['data-gallery="gooey-tabs"', "tabs-gallery-marker"],
  ['ref={tabListRef}', "tabs-list-measurement"],
  ['filterPadding={8}', "tabs-filter-padding"],
]) requireText(tabsBlock, expected, id);
requireExactObject(extractJsxObjectAttribute(tabsBlock, "move"), {
  springiness: "0.72",
  wobble: "0.16",
  stretch: "0.2",
  trail: "0.28",
}, "tabs-move-settings");

const switchBlock = extractJsxBlock(demo, 'data-gallery="gooey-switch-panel"', "article");
for (const [expected, id] of [
  ['data-gallery="gooey-switch-panel"', "switch-panel-marker"],
  ['type="button"', "switch-button-type"],
  ['role="switch"', "switch-role"],
  ['aria-checked={switchOn}', "switch-checked-state"],
  ['aria-label={t("componentsGallery.gooeySwitchLabel")}', "switch-stable-label"],
  ['aria-hidden="true"', "switch-visible-state-hidden"],
  ['effect="move"', "switch-move-effect"],
  ['transform: `translate3d(${switchOn ? 36 : 0}px, 0, 0)`', "switch-thumb-inline-transform"],
]) requireText(switchBlock, expected, id);
requireExactObject(extractJsxObjectAttribute(switchBlock, "move"), {
  springiness: "0.78",
  wobble: "0.12",
  stretch: "0.14",
  trail: "0.18",
}, "switch-move-settings");

const handlePressBlock = extractBraceBlockAfter(demo, "const handlePress = () =>");
requireText(handlePressBlock, "window.setTimeout(() => {", "press-release-timer");
requireText(handlePressBlock, "}, 360);", "press-release-duration");

const pressBlock = extractJsxBlock(demo, 'data-gallery="gooey-press-button"', "article");
for (const [expected, id] of [
  ['data-gallery="gooey-press-button"', "press-button"],
  ['onClick={handlePress}', "press-click"],
]) requireText(pressBlock, expected, id);
requireExactObject(extractJsxObjectAttribute(pressBlock, "morph"), {
  shape: "true",
  speed: "1.35",
  bounce: "0.22",
  contentBlur: "0",
}, "press-morph-settings");

for (const forbidden of ["fetch(", "XMLHttpRequest", "localStorage", "sessionStorage"]) {
  forbidText(demo, forbidden, forbidden);
}

const cssBlocks = new Map();
for (const [selector, id] of [
  [".root", "root"],
  [".demoGrid", "demo-grid"],
  [".stage", "stage"],
  [".morphGroup", "morph-group"],
  [".tabList", "tab-list"],
  [".tabIndicator", "tab-indicator"],
  [".pressPanel", "press-panel"],
  [".pressGroup", "press-group"],
  [".pressButton", "press-button"],
  [".pressButtonActive", "press-button-active"],
  [".switchButton", "switch-button"],
  [".switchButton:focus-visible", "switch-button-focus-visible"],
  [".switchThumb", "switch-thumb"],
  ["@media (max-width: 720px)", "responsive-720"],
  ["@media (prefers-reduced-motion: reduce)", "reduced-motion"],
]) {
  const block = extractCssBlock(styles, selector);
  if (!block) throw new Error(`missing:css-${id}`);
  cssBlocks.set(selector, block);
}

// Move 项的包装层是 display:contents，绝对定位必须落到真实指示器节点，否则 Grid 会把它排到下一行。
const tabIndicatorBlock = cssBlocks.get(".tabIndicator");
for (const [property, value, id] of [
  ["position", "absolute", "move-indicator-position"],
  ["top", "0", "move-indicator-top"],
  ["left", "0", "move-indicator-left"],
]) requireCssDeclaration(tabIndicatorBlock, property, value, id);

const pressButtonBlock = cssBlocks.get(".pressButton");
for (const [property, value, id] of [
  ["position", "absolute", "press-button-real-node-position"],
  ["top", "36px", "press-button-top"],
  ["left", "50px", "press-button-left"],
]) requireCssDeclaration(pressButtonBlock, property, value, id);

const tabListBlock = cssBlocks.get(".tabList");
for (const [property, value, id] of [
  ["border-radius", "24px", "tabs-clipping-radius"],
  ["overflow", "hidden", "tabs-clipping-overflow"],
]) requireCssDeclaration(tabListBlock, property, value, id);
for (const property of ["grid-template-columns", "width", "height", "padding", "font-size"]) {
  forbidCssDeclaration(tabListBlock, property, `move-does-not-override-navigation-${property}`);
}

const switchButtonBlock = cssBlocks.get(".switchButton");
for (const [property, value, id] of [
  ["width", "76px", "switch-button-width"],
  ["height", "40px", "switch-button-height"],
  ["padding", "4px", "switch-button-padding"],
  ["border-radius", "20px", "switch-button-radius"],
  ["overflow", "hidden", "switch-button-clipping"],
]) requireCssDeclaration(switchButtonBlock, property, value, id);

const switchFocusBlock = cssBlocks.get(".switchButton:focus-visible");
requireCssDeclaration(switchFocusBlock, "outline", "2px solid var(--ui-focus)", "switch-button-focus-outline");
requireCssDeclaration(switchFocusBlock, "outline-offset", "3px", "switch-button-focus-offset");

const switchThumbBlock = cssBlocks.get(".switchThumb");
for (const [property, value, id] of [
  ["width", "32px", "switch-thumb-width"],
  ["height", "32px", "switch-thumb-height"],
  ["transition", "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)", "switch-thumb-transform-transition"],
]) requireCssDeclaration(switchThumbBlock, property, value, id);
forbidText(switchThumbBlock, "transition: all", "switch-thumb-transition-all");

const pressButtonActiveBlock = cssBlocks.get(".pressButtonActive");
requireCssDeclaration(pressButtonActiveBlock, "transform", "scale3d(0.96, 0.9, 1)", "press-active-scale");

const reducedMotionBlock = cssBlocks.get("@media (prefers-reduced-motion: reduce)");
const reducedMotionPressBlock = extractCssBlock(reducedMotionBlock, ".pressButton");
requireCssDeclaration(reducedMotionPressBlock, "transition", "none", "reduced-motion-press-transition");
const reducedMotionSwitchThumbBlock = extractCssBlock(reducedMotionBlock, ".switchThumb");
requireCssDeclaration(reducedMotionSwitchThumbBlock, "transition", "none", "reduced-motion-switch-thumb-transition");

for (const key of [
  "gooeyTitle",
  "gooeyDescription",
  "gooeyKind",
  "gooeyMorphTitle",
  "gooeyMorphHint",
  "gooeyMorphToggle",
  "gooeyMoveTitle",
  "gooeyMoveHint",
  "gooeyTabOverview",
  "gooeyTabMotion",
  "gooeyTabPhysics",
  "gooeySwitchTitle",
  "gooeySwitchHint",
  "gooeySwitchLabel",
  "gooeySwitchOn",
  "gooeySwitchOff",
  "gooeyPressTitle",
  "gooeyPressHint",
  "gooeyPressButton",
]) {
  requireText(zh, `${key}:`, `locale-zh-${key}`);
  requireText(en, `${key}:`, `locale-en-${key}`);
}

requireText(zh, 'gooeySwitchLabel: "液态开关"', "locale-zh-switch-stable-label");
requireText(en, 'gooeySwitchLabel: "Liquid switch"', "locale-en-switch-stable-label");
requireText(
  zh,
  'gooeyPressHint: "点击按钮，观察按钮本体轻微压缩并回弹。"',
  "locale-zh-press-hint",
);
requireText(
  en,
  'gooeyPressHint: "Click the button to watch its surface compress gently and rebound."',
  "locale-en-press-hint",
);

forbidText(demo, "pressDrop", "tsx-press-drop");
forbidText(styles, "pressDrop", "css-press-drop");
forbidText(demo, "x={buttonPressed ? -72 : 0}", "press-left-droplet-offset");
forbidText(demo, "x={buttonPressed ? 72 : 0}", "press-right-droplet-offset");
forbidText(demo, "aria-pressed={buttonPressed}", "press-toggle-semantics");
forbidText(switchBlock, "x={switchOn ? 36 : 0}", "switch-component-driven-x");

console.log("[liquid-gooey-gallery] PASS");
