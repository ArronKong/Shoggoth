#!/usr/bin/env node

// 全局滚动条专项回归：先锁定 Provider 生命周期与唯一全局 CSS，再保护迁移后的业务滚动语义。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const srcRoot = path.join(uiRoot, "src");
const requireFromUi = createRequire(path.join(uiRoot, "package.json"));
const ts = requireFromUi("typescript");

const providerPath = path.join(srcRoot, "components/ScrollbarProvider.tsx");
const providerCssPath = path.join(srcRoot, "components/ScrollbarProvider.css");
const appPath = path.join(srcRoot, "App.tsx");
const oldHookPath = path.join(srcRoot, "lib/useAutoHideScrollbars.ts");
const filterTabsPath = path.join(srcRoot, "components/FilterTabs.tsx");
const filterTabsCssPath = path.join(srcRoot, "components/FilterTabs.module.css");
const immersivePath = path.join(srcRoot, "pages/immersive/ImmersiveChat.tsx");
const htmlArtifactsPath = path.join(srcRoot, "lib/htmlArtifacts.ts");
const dashboardCssPath = path.join(srcRoot, "pages/dashboard/DashboardPage.css");

const requestedMode = process.argv[2] ?? "full";
const validModes = new Set(["--provider-only", "--migration-only", "full"]);
if (process.argv.length > 3 || !validModes.has(requestedMode)) {
  console.error("Usage: node scripts/global-scrollbar-regression.mjs [--provider-only|--migration-only]");
  process.exit(2);
}
const mode = requestedMode === "--provider-only"
  ? "provider"
  : requestedMode === "--migration-only"
    ? "migration"
    : "full";

const results = [];

function check(name, condition, detail = "") {
  const ok = Boolean(condition);
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function safeRead(filePath) {
  try {
    return { exists: true, source: fs.readFileSync(filePath, "utf8") };
  } catch (error) {
    if (error && error.code === "ENOENT") return { exists: false, source: "" };
    throw error;
  }
}

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n\r]*/g, "$1");
}

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function listFiles(directory, predicate) {
  const files = [];
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(fullPath, predicate));
    else if (entry.isFile() && predicate(fullPath)) files.push(fullPath);
  }
  return files;
}

function relative(filePath) {
  return path.relative(root, filePath);
}

function parseCssRules(source) {
  const rules = [];
  const clean = withoutComments(source);
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]
      .split(",")
      .map((selector) => selector.trim())
      .filter(Boolean);
    const declarations = new Map();
    const declarationValues = new Map();
    for (const declaration of match[2].split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim();
      declarations.set(property, value);
      const values = declarationValues.get(property) ?? [];
      values.push(value);
      declarationValues.set(property, values);
    }
    rules.push({ selectors, declarations, declarationValues });
  }
  return rules;
}

// parseCssRules 本身只解析平坦规则；先把 reduced-motion 媒体块剥离，避免其中的
// transition:none 被误并入普通 thumb 合同。
function splitReducedMotionCss(source) {
  const clean = withoutComments(source);
  const header = /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/g;
  const blocks = [];
  let outside = "";
  let cursor = 0;
  let match;
  while ((match = header.exec(clean)) !== null) {
    const open = clean.indexOf("{", match.index + match[0].length);
    if (open < 0) break;
    let depth = 1;
    let close = open + 1;
    while (close < clean.length && depth > 0) {
      if (clean[close] === "{") depth += 1;
      else if (clean[close] === "}") depth -= 1;
      close += 1;
    }
    if (depth !== 0) break;
    outside += clean.slice(cursor, match.index);
    blocks.push(clean.slice(open + 1, close - 1));
    cursor = close;
    header.lastIndex = close;
  }
  outside += clean.slice(cursor);
  return { outside, blocks };
}

function rulesForSelector(rules, selector) {
  return rules.filter((rule) => rule.selectors.includes(selector));
}

function declarationValuesForRules(rules, property) {
  return rules.flatMap((rule) => rule.declarationValues.get(property) ?? []);
}

function declarationsSatisfy(rules, property, predicate) {
  const values = declarationValuesForRules(rules, property);
  return values.length > 0 && values.every(predicate);
}

function rulesDeclarationIs(rules, property, expected) {
  return declarationsSatisfy(rules, property, (value) => compact(value) === compact(expected));
}

function selectorDeclarationIs(rules, selector, property, expected) {
  return rulesDeclarationIs(rulesForSelector(rules, selector), property, expected);
}

function selectorDeclarationSummary(rules, selector, property) {
  const values = declarationValuesForRules(rulesForSelector(rules, selector), property);
  return values.length ? values.join(" | ") : "missing";
}

function scrollbarSelectorKind(selector) {
  if (selector === "*") return "global";
  if (selector === "*::-webkit-scrollbar") return "base";
  if (selector === "*::-webkit-scrollbar-track") return "track";
  if (selector === "*::-webkit-scrollbar-corner") return "corner";
  if (selector === "*::-webkit-scrollbar-thumb") return "thumb";
  if (selector === "*::-webkit-scrollbar-thumb:vertical") return "vertical";
  if (selector === "*::-webkit-scrollbar-thumb:horizontal") return "horizontal";
  if (/^(?:\*)?\.scrolling::-webkit-scrollbar-thumb$/.test(selector)) return "scrolling";
  if (selector === "*:hover::-webkit-scrollbar-thumb") return "hover";
  if (/^(?:\*)?\[data-scrollbar=(["'])hidden\1\]$/.test(selector)) return "hidden";
  if (/^(?:\*)?\[data-scrollbar=(["'])hidden\1\]::-webkit-scrollbar$/.test(selector)) return "hidden-webkit";
  return null;
}

function scrollbarRuleAllowlistIssues(rules, { reducedMotion = false } = {}) {
  const allowedProperties = {
    global: new Set(["--ui-scrollbar-thumb-color", "scrollbar-color", "scrollbar-width"]),
    base: new Set(["width", "height"]),
    track: new Set(["background-color"]),
    corner: new Set(["background-color"]),
    thumb: new Set(["background-color"]),
    vertical: new Set([
      "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
      "border-style", "border-color", "background-clip", "border-radius",
    ]),
    horizontal: new Set([
      "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
      "border-style", "border-color", "background-clip", "border-radius",
    ]),
    scrolling: new Set(["background-color"]),
    hover: new Set(["background-color"]),
    hidden: new Set(["scrollbar-width"]),
    "hidden-webkit": new Set(["width", "height", "display"]),
  };
  const issues = [];
  for (const rule of rules) {
    const hasScrollbarDeclaration = rule.declarations.has("scrollbar-color")
      || rule.declarations.has("scrollbar-width");
    const relatedSelectors = rule.selectors.filter((selector) => (
      selector.includes("::-webkit-scrollbar") || selector.includes("[data-scrollbar=")
    ));
    if (!relatedSelectors.length && !hasScrollbarDeclaration) continue;
    for (const selector of rule.selectors) {
      const kind = scrollbarSelectorKind(selector);
      if (!kind) {
        issues.push(`selector not allowed: ${selector}`);
        continue;
      }
      const expectedProperties = reducedMotion
        ? (kind === "global" ? new Set(["--ui-scrollbar-thumb-color"]) : null)
        : allowedProperties[kind];
      if (!expectedProperties) {
        issues.push(`${reducedMotion ? "reduced-motion " : ""}selector not allowed: ${selector}`);
        continue;
      }
      for (const property of rule.declarations.keys()) {
        if (!expectedProperties.has(property)) issues.push(`${selector} property not allowed: ${property}`);
      }
    }
  }
  return issues;
}

function compact(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

function variableFunctionBlock(source, filePath, variableName) {
  const ast = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let block = "";
  function visit(node) {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === variableName
      && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      && ts.isBlock(node.initializer.body)
    ) {
      block = node.initializer.body.getText(ast);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return block;
}

function effectWithLocalFunction(source, filePath, localName) {
  const ast = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let result = { effectBlock: "", functionBlock: "" };
  function visit(node) {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "useEffect"
      && node.arguments[0]
      && (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]))
      && ts.isBlock(node.arguments[0].body)
    ) {
      let localBlock = "";
      function findLocal(child) {
        if (
          ts.isVariableDeclaration(child)
          && ts.isIdentifier(child.name)
          && child.name.text === localName
          && child.initializer
          && (ts.isArrowFunction(child.initializer) || ts.isFunctionExpression(child.initializer))
          && ts.isBlock(child.initializer.body)
        ) {
          localBlock = child.initializer.body.getText(ast);
          return;
        }
        ts.forEachChild(child, findLocal);
      }
      findLocal(node.arguments[0].body);
      if (localBlock) {
        result = {
          effectBlock: node.arguments[0].body.getText(ast),
          functionBlock: localBlock,
        };
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return result;
}

function appProviderContract(appSource) {
  const ast = ts.createSourceFile(appPath, appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let importCount = 0;
  let jsxCount = 0;
  let directAppChild = false;
  let defaultAppFound = false;
  let appRootFound = false;

  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (statement.moduleSpecifier.text !== "./components/ScrollbarProvider") continue;
    if (statement.importClause?.name?.text === "ScrollbarProvider") importCount += 1;
  }

  function tagName(node) {
    return node.tagName?.getText(ast) ?? "";
  }

  function hasAppClass(opening) {
    return opening.attributes.properties.some((attribute) => (
      ts.isJsxAttribute(attribute)
      && attribute.name.getText(ast) === "className"
      && ts.isStringLiteral(attribute.initializer)
      && attribute.initializer.text.split(/\s+/).includes("app")
    ));
  }

  const appFunction = ast.statements.find((statement) => (
    ts.isFunctionDeclaration(statement)
    && statement.name?.text === "App"
    && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  ));
  defaultAppFound = Boolean(appFunction);
  const appReturn = appFunction?.body?.statements.find((statement) => ts.isReturnStatement(statement));
  let appRoot = appReturn?.expression;
  while (appRoot && ts.isParenthesizedExpression(appRoot)) appRoot = appRoot.expression;
  if (appRoot && ts.isJsxElement(appRoot) && tagName(appRoot.openingElement) === "div" && hasAppClass(appRoot.openingElement)) {
    appRootFound = true;
  } else {
    appRoot = undefined;
  }

  function visitAppTree(node) {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxElement(node)) && tagName(
      ts.isJsxElement(node) ? node.openingElement : node,
    ) === "ScrollbarProvider") jsxCount += 1;
    ts.forEachChild(node, visitAppTree);
  }
  if (appRoot) {
    directAppChild = appRoot.children.some((child) => (
      ts.isJsxSelfClosingElement(child) && tagName(child) === "ScrollbarProvider"
    ));
    visitAppTree(appRoot);
  }
  return { importCount, jsxCount, directAppChild, defaultAppFound, appRootFound };
}

function fullError(error) {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

async function buildProviderCss() {
  const esbuild = requireFromUi("esbuild");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-scrollbar-css-"));
  try {
    await esbuild.build({
      entryPoints: [providerCssPath],
      outfile: path.join(tempDir, "ScrollbarProvider.css"),
      bundle: true,
      loader: { ".css": "css" },
      logLevel: "silent",
    });
    return { ok: true, detail: "" };
  } catch (error) {
    return { ok: false, detail: fullError(error) };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runProviderSourceContracts() {
  console.log("\n[Provider / App / CSS contracts]");
  const provider = safeRead(providerPath);
  const css = safeRead(providerCssPath);
  const app = safeRead(appPath);
  const artifacts = safeRead(htmlArtifactsPath);
  const providerSource = withoutComments(provider.source);
  const cssSource = withoutComments(css.source);
  const separatedCss = splitReducedMotionCss(css.source);
  const cssRules = parseCssRules(separatedCss.outside);
  const reducedMotionRules = parseCssRules(separatedCss.blocks.join("\n"));
  const scrollbarAllowlistIssues = [
    ...scrollbarRuleAllowlistIssues(cssRules),
    ...scrollbarRuleAllowlistIssues(reducedMotionRules, { reducedMotion: true }),
  ];

  check("ScrollbarProvider.tsx exists", provider.exists);
  check("ScrollbarProvider.css exists", css.exists);
  const cssBuild = css.exists
    ? await buildProviderCss()
    : { ok: false, detail: "ScrollbarProvider.css is missing" };
  check("ScrollbarProvider.css parses with the real esbuild CSS loader", cssBuild.ok, cssBuild.detail);
  check(
    "Scrollbar CSS selectors and declarations match the global allowlist",
    css.exists && scrollbarAllowlistIssues.length === 0,
    scrollbarAllowlistIssues.join("; "),
  );
  check("Provider imports its global CSS", /import\s+["']\.\/ScrollbarProvider\.css["']\s*;?/.test(providerSource));
  check(
    "Provider config is centralized at 4 / 8 / 1200 / 400",
    /thumbSizePx\s*:\s*4\b/.test(providerSource)
      && /edgeInsetPx\s*:\s*8\b/.test(providerSource)
      && /hideDelayMs\s*:\s*1200\b/.test(providerSource)
      && /fadeMs\s*:\s*400\b/.test(providerSource),
  );

  const appContract = appProviderContract(app.source);
  check("App imports ScrollbarProvider exactly once", appContract.importCount === 1, `count=${appContract.importCount}`);
  check(
    "Default-exported App return renders one ScrollbarProvider as a direct .app child",
    appContract.defaultAppFound
      && appContract.appRootFound
      && appContract.jsxCount === 1
      && appContract.directAppChild,
    `defaultApp=${appContract.defaultAppFound} appRoot=${appContract.appRootFound} jsx=${appContract.jsxCount}`,
  );
  const oldHookReferences = countMatches(withoutComments(app.source), /\buseAutoHideScrollbars\b/g);
  check("App has no old auto-hide Hook import or call", oldHookReferences === 0, `references=${oldHookReferences}`);

  const sandboxValues = [...artifacts.source.matchAll(/\.setAttribute\(\s*["']sandbox["']\s*,\s*["']([^"']*)["']\s*\)/g)]
    .map((match) => match[1]);
  check(
    "HTML Artifact sandbox remains allow-scripts only",
    artifacts.exists && sandboxValues.length === 1 && sandboxValues[0] === "allow-scripts",
    `values=${JSON.stringify(sandboxValues)}`,
  );

  check("Global CSS has no .app or .management-page scope", css.exists && !/\.(?:app|management-page)\b/.test(cssSource));
  check(
    "CSS fallbacks define the 4px + 8px = 12px track and 400ms fade",
    selectorDeclarationIs(cssRules, ":root", "--ui-scrollbar-thumb-size", "4px")
      && selectorDeclarationIs(cssRules, ":root", "--ui-scrollbar-edge-inset", "8px")
      && selectorDeclarationIs(cssRules, ":root", "--ui-scrollbar-track-size", "calc(var(--ui-scrollbar-thumb-size) + var(--ui-scrollbar-edge-inset))")
      && selectorDeclarationIs(cssRules, ":root", "--ui-scrollbar-radius", "2px")
      && selectorDeclarationIs(cssRules, ":root", "--ui-scrollbar-fade-duration", "400ms"),
  );
  check(
    "Scrollbar track uses the shared 12px variable in both directions",
    selectorDeclarationIs(cssRules, "*::-webkit-scrollbar", "width", "var(--ui-scrollbar-track-size)")
      && selectorDeclarationIs(cssRules, "*::-webkit-scrollbar", "height", "var(--ui-scrollbar-track-size)"),
  );
  check(
    "Native scrollbar-color is reset to auto globally",
    selectorDeclarationIs(cssRules, "*", "scrollbar-color", "auto"),
  );
  check(
    "Native scrollbar-width is reset to auto globally",
    selectorDeclarationIs(cssRules, "*", "scrollbar-width", "auto"),
  );
  const registeredColor = rulesForSelector(cssRules, "@property --ui-scrollbar-thumb-color");
  check(
    "Thumb color is a registered inheriting color property",
    rulesDeclarationIs(registeredColor, "syntax", '"<color>"')
      && rulesDeclarationIs(registeredColor, "inherits", "true")
      && rulesDeclarationIs(registeredColor, "initial-value", "transparent"),
  );
  check(
    "Every element seeds an independent transparent thumb color",
    selectorDeclarationIs(cssRules, "*", "--ui-scrollbar-thumb-color", "transparent"),
  );

  const vertical = rulesForSelector(cssRules, "*::-webkit-scrollbar-thumb:vertical");
  const horizontal = rulesForSelector(cssRules, "*::-webkit-scrollbar-thumb:horizontal");
  check(
    "Vertical thumb has complete transparent right inset borders and content clipping",
    rulesDeclarationIs(vertical, "border-top-width", "0")
      && rulesDeclarationIs(vertical, "border-right-width", "var(--ui-scrollbar-edge-inset)")
      && rulesDeclarationIs(vertical, "border-bottom-width", "0")
      && rulesDeclarationIs(vertical, "border-left-width", "0")
      && rulesDeclarationIs(vertical, "border-style", "solid")
      && rulesDeclarationIs(vertical, "border-color", "transparent")
      && rulesDeclarationIs(vertical, "background-clip", "content-box"),
  );
  check(
    "Vertical thumb has the directional radius contract",
    rulesDeclarationIs(
      vertical,
      "border-radius",
      "var(--ui-scrollbar-radius) calc(var(--ui-scrollbar-edge-inset) + var(--ui-scrollbar-radius)) calc(var(--ui-scrollbar-edge-inset) + var(--ui-scrollbar-radius)) var(--ui-scrollbar-radius) / var(--ui-scrollbar-radius)",
    ),
  );
  check(
    "Horizontal thumb has complete transparent bottom inset borders and content clipping",
    rulesDeclarationIs(horizontal, "border-top-width", "0")
      && rulesDeclarationIs(horizontal, "border-right-width", "0")
      && rulesDeclarationIs(horizontal, "border-bottom-width", "var(--ui-scrollbar-edge-inset)")
      && rulesDeclarationIs(horizontal, "border-left-width", "0")
      && rulesDeclarationIs(horizontal, "border-style", "solid")
      && rulesDeclarationIs(horizontal, "border-color", "transparent")
      && rulesDeclarationIs(horizontal, "background-clip", "content-box"),
  );
  check(
    "Horizontal thumb has the directional radius contract",
    rulesDeclarationIs(
      horizontal,
      "border-radius",
      "var(--ui-scrollbar-radius) / var(--ui-scrollbar-radius) var(--ui-scrollbar-radius) calc(var(--ui-scrollbar-edge-inset) + var(--ui-scrollbar-radius)) calc(var(--ui-scrollbar-edge-inset) + var(--ui-scrollbar-radius))",
    ),
  );

  const transparentTrack = ["*::-webkit-scrollbar-track", "*::-webkit-scrollbar-corner"].every((selector) => {
    const selectorRules = rulesForSelector(cssRules, selector);
    const values = [
      ...declarationValuesForRules(selectorRules, "background-color"),
      ...declarationValuesForRules(selectorRules, "background"),
    ];
    return values.length > 0 && values.every((value) => compact(value) === "transparent");
  });
  check("Track and corner are transparent", transparentTrack);

  const thumbRules = cssRules.filter((rule) => rule.selectors.some((selector) => selector.includes("::-webkit-scrollbar-thumb")));
  const baseThumb = thumbRules.filter((rule) => rule.selectors.includes("*::-webkit-scrollbar-thumb"));
  const scrollingThumb = thumbRules.filter((rule) => rule.selectors.some(
    (selector) => selector.includes(".scrolling::-webkit-scrollbar-thumb"),
  ));
  const hoverThumb = thumbRules.filter((rule) => rule.selectors.some(
    (selector) => selector.includes(":hover::-webkit-scrollbar-thumb"),
  ));
  check(
    "Thumb reads the registered host color without pseudo transitions",
    rulesDeclarationIs(baseThumb, "background-color", "var(--ui-scrollbar-thumb-color)")
      && declarationValuesForRules(thumbRules, "background").length === 0
      && declarationValuesForRules([...cssRules, ...reducedMotionRules], "transition").length === 0
      && declarationValuesForRules([...cssRules, ...reducedMotionRules], "animation").length === 0,
  );
  check(
    "Scrolling reveals the shared visible color",
    rulesDeclarationIs(scrollingThumb, "background-color", "var(--ui-scrollbar-thumb-visible)"),
  );
  check(
    "Hover reveals the shared visible color",
    rulesDeclarationIs(hoverThumb, "background-color", "var(--ui-scrollbar-thumb-visible)"),
  );
  const darkRules = cssRules.filter((rule) => rule.selectors.some(
    (selector) => /^:root\[data-theme=(["'])dark\1\]$/.test(selector),
  ));
  const immersiveRules = cssRules.filter((rule) => rule.selectors.includes("body[data-immersive]"));
  check("Light theme thumb color is defined", selectorDeclarationIs(cssRules, ":root", "--ui-scrollbar-thumb-visible", "rgba(0, 0, 0, 0.1)"));
  check("Dark theme thumb color is defined independently", rulesDeclarationIs(darkRules, "--ui-scrollbar-thumb-visible", "rgba(255, 255, 255, 0.16)"));
  check("Immersive thumb color is defined independently", rulesDeclarationIs(immersiveRules, "--ui-scrollbar-thumb-visible", "rgba(255, 255, 255, 0.16)"));

  const hiddenRules = cssRules.filter((rule) => rule.selectors.some(
    (selector) => /\[data-scrollbar=["']hidden["']\]$/.test(selector),
  ));
  const hiddenWebkitRules = cssRules.filter((rule) => rule.selectors.some(
    (selector) => /\[data-scrollbar=["']hidden["']\]::\-webkit-scrollbar$/.test(selector),
  ));
  const hiddenRule = rulesDeclarationIs(hiddenRules, "scrollbar-width", "none");
  const hiddenWebkitRule = rulesDeclarationIs(hiddenWebkitRules, "width", "0")
    && rulesDeclarationIs(hiddenWebkitRules, "height", "0")
    && rulesDeclarationIs(hiddenWebkitRules, "display", "none");
  check("Shared hidden attribute overrides native scrollbars", hiddenRule && hiddenWebkitRule);
  check(
    "Provider CSS never overrides business transition or animation properties",
    declarationValuesForRules([...cssRules, ...reducedMotionRules], "transition").length === 0
      && declarationValuesForRules([...cssRules, ...reducedMotionRules], "animation").length === 0,
  );

  return { providerExists: provider.exists, cssExists: css.exists };
}

class FakeClock {
  now = 0;
  nextId = 1;
  timers = new Map();

  setTimeout(callback, delay = 0) {
    const id = this.nextId++;
    this.timers.set(id, { callback, due: this.now + Number(delay) });
    return id;
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }

  advanceTo(target) {
    if (target < this.now) throw new Error(`fake clock cannot move backwards (${this.now} -> ${target})`);
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!due) break;
      const [id, timer] = due;
      this.timers.delete(id);
      this.now = timer.due;
      timer.callback();
    }
    this.now = target;
  }
}

class FakeClassList {
  names = new Set();
  removals = new Map();

  add(name) {
    this.names.add(name);
  }

  remove(name) {
    this.names.delete(name);
    this.removals.set(name, (this.removals.get(name) ?? 0) + 1);
  }

  contains(name) {
    return this.names.has(name);
  }

  removeCount(name) {
    return this.removals.get(name) ?? 0;
  }
}

class FakeStyle {
  values;
  priorities;
  removed = [];

  constructor(initial = {}) {
    this.values = new Map();
    this.priorities = new Map();
    for (const [name, initialValue] of Object.entries(initial)) {
      const { value, priority = "" } = initialValue && typeof initialValue === "object"
        ? initialValue
        : { value: initialValue };
      this.setProperty(name, value, priority);
    }
  }

  getPropertyValue(name) {
    return this.values.get(name) ?? "";
  }

  getPropertyPriority(name) {
    return this.priorities.get(name) ?? "";
  }

  setProperty(name, value, priority = "") {
    this.values.set(name, String(value));
    this.priorities.set(name, String(priority));
  }

  removeProperty(name) {
    const previous = this.getPropertyValue(name);
    this.values.delete(name);
    this.priorities.delete(name);
    this.removed.push(name);
    return previous;
  }
}

async function compileProvider() {
  const esbuild = requireFromUi("esbuild");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-scrollbar-provider-"));
  let handedOff = false;
  try {
    const outfile = path.join(tempDir, "ScrollbarProvider.cjs");
    const reactPath = requireFromUi.resolve("react");
    await esbuild.build({
      entryPoints: [providerPath],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      logLevel: "silent",
      plugins: [{
        name: "global-scrollbar-regression-stubs",
        setup(build) {
          build.onResolve({ filter: /^react$/ }, () => ({ path: reactPath, external: true }));
          build.onResolve({ filter: /ScrollbarProvider\.css$/ }, () => ({ path: "scrollbar.css", namespace: "scrollbar-stub" }));
          build.onLoad({ filter: /.*/, namespace: "scrollbar-stub" }, () => ({ contents: "", loader: "js" }));
        },
      }],
    });
    const module = requireFromUi(outfile);
    handedOff = true;
    return { module, cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }) };
  } finally {
    if (!handedOff) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function saveGlobals(names) {
  return new Map(names.map((name) => [name, {
    existed: Object.prototype.hasOwnProperty.call(globalThis, name),
    value: globalThis[name],
  }]));
}

function restoreGlobals(saved) {
  for (const [name, state] of saved) {
    if (state.existed) globalThis[name] = state.value;
    else delete globalThis[name];
  }
}

async function runProviderLifecycle() {
  console.log("\n[Provider real TSX lifecycle]");
  let compiled;
  let renderer;
  let act;
  let saved;
  let stage = "compile";
  try {
    compiled = await compileProvider();
    check("Provider real TSX compiles with only CSS stubbed", true);
    stage = "bootstrap";
    const React = requireFromUi("react");
    const TestRenderer = requireFromUi("react-test-renderer");
    ({ act } = TestRenderer);
    saved = saveGlobals([
      "Element", "HTMLElement", "SVGElement", "Document", "Window", "document", "window",
      "setTimeout", "clearTimeout", "IS_REACT_ACT_ENVIRONMENT",
    ]);
    const clock = new FakeClock();
    let geometryReads = 0;

    class FakeAnimation {
      constructor(keyframes, options) {
        this.keyframes = keyframes;
        this.options = options;
        this.cancelCalls = 0;
        this.onfinish = null;
        this.oncancel = null;
      }
      cancel() {
        this.cancelCalls += 1;
        this.oncancel?.();
      }
      finish() {
        this.onfinish?.();
      }
    }
    class FakeElement {
      constructor(name, parentElement = null) {
        this.name = name;
        this.parentElement = parentElement;
      }
    }
    class FakeHTMLElement extends FakeElement {
      constructor(name, parentElement = null) {
        super(name, parentElement);
        for (const property of ["scrollHeight", "clientHeight", "scrollWidth", "clientWidth"]) {
          let value = 0;
          Object.defineProperty(this, property, {
            get: () => { geometryReads += 1; return value; },
            set: (next) => { value = next; },
          });
        }
        this.classList = new FakeClassList();
        this.style = new FakeStyle();
        this.animations = [];
        this.attributes = new Map();
      }
      animate(keyframes, options) {
        const animation = new FakeAnimation(keyframes, options);
        this.animations.push(animation);
        return animation;
      }
      getAttribute(name) {
        return this.attributes.get(name) ?? null;
      }
      setAttribute(name, value) {
        this.attributes.set(name, String(value));
      }
    }
    class FakeSVGElement extends FakeElement {}
    class FakeDocument {
      constructor(documentElement, scrollingElement) {
        this.documentElement = documentElement;
        this.scrollingElement = scrollingElement;
        this.listeners = new Map();
        this.listenerCaptures = new Map();
        this.removeCaptures = new Map();
      }
      addEventListener(type, listener, capture) {
        this.listeners.set(type, listener);
        this.listenerCaptures.set(type, capture);
      }
      removeEventListener(type, listener, capture) {
        if (listener === this.listeners.get(type)) {
          this.listeners.delete(type);
          this.removeCaptures.set(type, capture);
        }
      }
      dispatchScroll(target) {
        const listener = this.listeners.get("scroll");
        if (!listener) throw new Error("scroll listener is not installed");
        listener({ type: "scroll", target });
      }
      dispatchPointer(type, target, relatedTarget) {
        const listener = this.listeners.get(type);
        if (!listener) return;
        listener({ type, target, relatedTarget });
      }
    }
    class FakeWindow {
      constructor(document) {
        this.document = document;
        this.reducedMotion = false;
        this.setTimeout = clock.setTimeout.bind(clock);
        this.clearTimeout = clock.clearTimeout.bind(clock);
      }
      matchMedia(query) {
        return { matches: query === "(prefers-reduced-motion: reduce)" && this.reducedMotion };
      }
      getComputedStyle() {
        return {
          getPropertyValue(name) {
            return name === "--ui-scrollbar-thumb-visible" ? "rgba(0, 0, 0, 0.1)" : "";
          },
        };
      }
    }

    const variableNames = [
      "--ui-scrollbar-thumb-size",
      "--ui-scrollbar-edge-inset",
      "--ui-scrollbar-track-size",
      "--ui-scrollbar-radius",
      "--ui-scrollbar-fade-duration",
    ];
    const rootElement = new FakeHTMLElement("documentElement");
    rootElement.style = new FakeStyle({
      "--ui-scrollbar-thumb-size": { value: "91px", priority: "important" },
      "--ui-scrollbar-track-size": "legacy-track",
    });
    const documentScroll = new FakeHTMLElement("documentScroll");
    const mainDocument = new FakeDocument(rootElement, documentScroll);
    const windowRoot = new FakeHTMLElement("windowRoot");
    windowRoot.style = new FakeStyle();
    const windowScroll = new FakeHTMLElement("windowScroll");
    const windowDocument = new FakeDocument(windowRoot, windowScroll);
    const fakeWindow = new FakeWindow(windowDocument);

    Object.assign(globalThis, {
      Element: FakeElement,
      HTMLElement: FakeHTMLElement,
      SVGElement: FakeSVGElement,
      Document: FakeDocument,
      Window: FakeWindow,
      document: mainDocument,
      window: fakeWindow,
      setTimeout: clock.setTimeout.bind(clock),
      clearTimeout: clock.clearTimeout.bind(clock),
      IS_REACT_ACT_ENVIRONMENT: true,
    });

    stage = "lifecycle";
    const Provider = compiled.module.default;
    check("Provider exports the fixed runtime config", compiled.module.SCROLLBAR_CONFIG?.thumbSizePx === 4
      && compiled.module.SCROLLBAR_CONFIG?.edgeInsetPx === 8
      && compiled.module.SCROLLBAR_CONFIG?.hideDelayMs === 1200
      && compiled.module.SCROLLBAR_CONFIG?.fadeMs === 400);
    check("Provider has a default component export", typeof Provider === "function");
    if (typeof Provider !== "function") return;

    act(() => {
      renderer = TestRenderer.create(React.createElement(Provider));
    });
    check("Provider renders no visual DOM", renderer.toJSON() === null);
    check(
      "Provider installs scroll and pointer boundary listeners in capture phase",
      ["scroll", "pointerover", "pointerout"].every((type) => (
        mainDocument.listeners.has(type) && mainDocument.listenerCaptures.get(type) === true
      )),
    );
    const expectedVariables = new Map([
      ["--ui-scrollbar-thumb-size", "4px"],
      ["--ui-scrollbar-edge-inset", "8px"],
      ["--ui-scrollbar-track-size", "calc(var(--ui-scrollbar-thumb-size) + var(--ui-scrollbar-edge-inset))"],
      ["--ui-scrollbar-radius", "2px"],
      ["--ui-scrollbar-fade-duration", "400ms"],
    ]);
    check(
      "Provider writes all five CSS variables",
      [...expectedVariables].every(([name, value]) => rootElement.style.getPropertyValue(name) === value),
      variableNames.map((name) => `${name}=${rootElement.style.getPropertyValue(name)}`).join(", "),
    );

    const boundary = new FakeHTMLElement("boundary");
    mainDocument.dispatchScroll(boundary);
    check("HTMLElement starts scrolling immediately", boundary.classList.contains("scrolling"));
    clock.advanceTo(1199);
    check("Scrolling class remains at 1199ms", boundary.classList.contains("scrolling"));
    clock.advanceTo(1200);
    const boundaryFade = boundary.animations[0];
    check(
      "1200ms hide starts the real 400ms registered-color fade",
      !boundary.classList.contains("scrolling")
        && boundaryFade?.keyframes?.[0]?.["--ui-scrollbar-thumb-color"] === "rgba(0, 0, 0, 0.1)"
        && boundaryFade?.keyframes?.[1]?.["--ui-scrollbar-thumb-color"] === "transparent"
        && boundaryFade?.options?.duration === 400
        && boundaryFade?.options?.easing === "ease"
        && boundaryFade?.options?.fill !== "forwards",
    );

    mainDocument.dispatchScroll(boundary);
    check(
      "New scroll cancels the previous fade before revealing",
      boundaryFade?.cancelCalls === 1 && boundary.classList.contains("scrolling"),
    );

    const reset = new FakeHTMLElement("reset");
    mainDocument.dispatchScroll(reset);
    clock.advanceTo(1800);
    mainDocument.dispatchScroll(reset);
    clock.advanceTo(2999);
    check("Repeated scroll resets that element's full delay", reset.classList.contains("scrolling"));
    clock.advanceTo(3000);
    check("Reset timer removes at 1200ms after the latest event", !reset.classList.contains("scrolling"));

    const first = new FakeHTMLElement("first");
    const second = new FakeHTMLElement("second");
    mainDocument.dispatchScroll(first);
    clock.advanceTo(3100);
    mainDocument.dispatchScroll(second);
    clock.advanceTo(4200);
    check(
      "Two elements have independent hide timers and fade animations",
      !first.classList.contains("scrolling")
        && first.animations.length === 1
        && second.classList.contains("scrolling")
        && second.animations.length === 0,
    );
    clock.advanceTo(4300);
    check(
      "Second element keeps its own complete delay and fade",
      !second.classList.contains("scrolling") && second.animations.length === 1,
    );

    const finishedFade = first.animations[0];
    finishedFade?.finish();
    check("Finished fade cancels its effect exactly once", finishedFade?.cancelCalls === 1);

    const hoverHost = new FakeHTMLElement("hoverHost");
    hoverHost.scrollHeight = 500;
    hoverHost.clientHeight = 100;
    const hoverChildA = new FakeHTMLElement("hoverChildA", hoverHost);
    const hoverChildB = new FakeHTMLElement("hoverChildB", hoverHost);
    const outside = new FakeHTMLElement("outside");
    mainDocument.dispatchScroll(hoverHost);
    mainDocument.dispatchPointer("pointerover", hoverChildA, outside);
    clock.advanceTo(5500);
    check(
      "Hovered scroll target stays visible without starting a hide fade",
      !hoverHost.classList.contains("scrolling") && hoverHost.animations.length === 0,
    );
    mainDocument.dispatchPointer("pointerout", hoverChildA, hoverChildB);
    check("Moving inside one scroll ancestor does not start a fade", hoverHost.animations.length === 0);
    const beforeSiblingMove = geometryReads;
    for (let move = 0; move < 100; move += 1) {
      mainDocument.dispatchPointer("pointerout", hoverChildA, hoverChildB);
      mainDocument.dispatchPointer("pointerover", hoverChildB, hoverChildA);
    }
    const siblingMoveReads = geometryReads - beforeSiblingMove;
    check("Sibling pointer movement only measures the entered/exited elements", siblingMoveReads === 800,
      `100 moves: ${siblingMoveReads} geometry reads`);
    const beforeParentMove = geometryReads;
    mainDocument.dispatchPointer("pointerover", hoverHost, hoverChildA);
    check("Moving from a child to its parent never measures their shared subtree", geometryReads === beforeParentMove);
    mainDocument.dispatchPointer("pointerout", hoverChildB, outside);
    check("Leaving the hovered scroll ancestor starts its 400ms fade", hoverHost.animations.length === 1);

    const hoverOnlyHost = new FakeHTMLElement("hoverOnlyHost");
    hoverOnlyHost.scrollHeight = 500;
    hoverOnlyHost.clientHeight = 100;
    const hoverOnlyChild = new FakeHTMLElement("hoverOnlyChild", hoverOnlyHost);
    mainDocument.dispatchPointer("pointerover", hoverOnlyChild, outside);
    mainDocument.dispatchPointer("pointerout", hoverOnlyChild, outside);
    check(
      "Leaving a never-scrolled overflow ancestor starts its 400ms fade",
      hoverOnlyHost.animations.length === 1
        && hoverOnlyHost.animations[0]?.options?.duration === 400,
    );

    const svgHoverHost = new FakeHTMLElement("svgHoverHost");
    svgHoverHost.scrollHeight = 500;
    svgHoverHost.clientHeight = 100;
    const svgChildA = new FakeSVGElement("svgChildA", svgHoverHost);
    const svgChildB = new FakeSVGElement("svgChildB", svgHoverHost);
    mainDocument.dispatchPointer("pointerover", svgChildA, outside);
    mainDocument.dispatchPointer("pointerout", svgChildA, svgChildB);
    check("Moving between SVG descendants in one scroll ancestor does not start a fade", svgHoverHost.animations.length === 0);
    mainDocument.dispatchPointer("pointerout", svgChildB, outside);
    check(
      "Leaving a scroll ancestor through an SVG descendant starts its 400ms fade",
      svgHoverHost.animations.length === 1
        && svgHoverHost.animations[0]?.options?.duration === 400,
    );

    const nestedHost = new FakeHTMLElement("nestedHost", hoverOnlyHost);
    nestedHost.scrollWidth = 500;
    nestedHost.clientWidth = 100;
    const nestedChild = new FakeHTMLElement("nestedChild", nestedHost);
    mainDocument.dispatchPointer("pointerover", nestedChild, hoverOnlyChild);
    mainDocument.dispatchPointer("pointerout", nestedChild, hoverOnlyChild);
    check("Leaving a nested horizontal scroller fades it without fading the shared parent",
      nestedHost.animations.length === 1 && hoverOnlyHost.animations.length === 1);

    const plainHost = new FakeHTMLElement("plainHost");
    const plainChild = new FakeHTMLElement("plainChild", plainHost);
    mainDocument.dispatchPointer("pointerover", plainChild, outside);
    mainDocument.dispatchPointer("pointerout", plainChild, outside);
    check("Pointer boundaries never animate ordinary DOM ancestors", plainHost.animations.length === 0);

    const hiddenHoverHost = new FakeHTMLElement("hiddenHoverHost");
    hiddenHoverHost.scrollHeight = 500;
    hiddenHoverHost.clientHeight = 100;
    hiddenHoverHost.setAttribute("data-scrollbar", "hidden");
    const hiddenHoverChild = new FakeHTMLElement("hiddenHoverChild", hiddenHoverHost);
    mainDocument.dispatchPointer("pointerover", hiddenHoverChild, outside);
    mainDocument.dispatchPointer("pointerout", hiddenHoverChild, outside);
    check("Pointer boundaries never animate hidden scrollbar ancestors", hiddenHoverHost.animations.length === 0);

    fakeWindow.reducedMotion = true;
    const reduced = new FakeHTMLElement("reduced");
    mainDocument.dispatchScroll(reduced);
    clock.advanceTo(6700);
    check(
      "Reduced motion removes scrolling immediately without calling animate",
      !reduced.classList.contains("scrolling") && reduced.animations.length === 0,
    );
    fakeWindow.reducedMotion = false;

    const hidden = new FakeHTMLElement("hidden");
    hidden.setAttribute("data-scrollbar", "hidden");
    mainDocument.dispatchScroll(hidden);
    clock.advanceTo(7900);
    check("Hidden scrollbar targets never animate", hidden.animations.length === 0);

    const unsupported = new FakeHTMLElement("unsupported");
    unsupported.animate = undefined;
    mainDocument.dispatchScroll(unsupported);
    clock.advanceTo(9100);
    check("Missing HTMLElement.animate safely degrades to immediate transparency", !unsupported.classList.contains("scrolling"));

    mainDocument.dispatchScroll(mainDocument);
    mainDocument.dispatchScroll(fakeWindow);
    check("Document scroll maps to document.scrollingElement", documentScroll.classList.contains("scrolling"));
    check("Window scroll maps to its independent document.scrollingElement", windowScroll.classList.contains("scrolling") && windowScroll !== documentScroll);
    clock.advanceTo(10300);

    const fired = new FakeHTMLElement("fired");
    mainDocument.dispatchScroll(fired);
    clock.advanceTo(11500);
    check("Timer callback removes the scrolling class once", fired.classList.removeCount("scrolling") === 1);
    const pending = new FakeHTMLElement("pending");
    mainDocument.dispatchScroll(pending);
    const unmountFade = second.animations[0];
    const unmountFadeCancelCalls = unmountFade?.cancelCalls ?? 0;

    act(() => renderer.unmount());
    renderer = null;
    check(
      "Finished animations are deleted and not canceled again on unmount",
      finishedFade?.cancelCalls === 1,
    );
    check(
      "Unmount cancels pending animations once",
      unmountFade?.cancelCalls === unmountFadeCancelCalls + 1,
    );
    check("Unmount clears pending timers and scrolling classes", clock.timers.size === 0 && !pending.classList.contains("scrolling") && pending.classList.removeCount("scrolling") === 1);
    check(
      "Unmount removes all three capture listeners",
      ["scroll", "pointerover", "pointerout"].every((type) => (
        !mainDocument.listeners.has(type) && mainDocument.removeCaptures.get(type) === true
      )),
    );
    check(
      "Unmount restores existing inline CSS variable values and priorities",
      rootElement.style.getPropertyValue("--ui-scrollbar-thumb-size") === "91px"
        && rootElement.style.getPropertyPriority("--ui-scrollbar-thumb-size") === "important"
        && rootElement.style.getPropertyValue("--ui-scrollbar-track-size") === "legacy-track",
    );
    const originallyMissing = [
      "--ui-scrollbar-edge-inset",
      "--ui-scrollbar-radius",
      "--ui-scrollbar-fade-duration",
    ];
    check(
      "Unmount removes CSS variables that were originally absent",
      originallyMissing.every((name) => rootElement.style.getPropertyValue(name) === "" && rootElement.style.removed.includes(name)),
    );
  } catch (error) {
    check(
      stage === "compile" ? "Provider real TSX compiles with only CSS stubbed" : "Provider lifecycle harness completes",
      false,
      fullError(error),
    );
  } finally {
    if (renderer && act) {
      try {
        act(() => renderer.unmount());
      } catch (error) {
        check("Provider renderer cleanup completes", false, fullError(error));
      }
    }
    if (saved) {
      try {
        restoreGlobals(saved);
      } catch (error) {
        check("Provider global cleanup completes", false, fullError(error));
      }
    }
    if (compiled) {
      try {
        compiled.cleanup();
      } catch (error) {
        check("Provider compiled artifact cleanup completes", false, fullError(error));
      }
    }
  }
}

function runMigrationContracts() {
  console.log("\n[Migration contracts]");
  const filterTabs = safeRead(filterTabsPath);
  const filterTabsCss = safeRead(filterTabsCssPath);
  const immersive = safeRead(immersivePath);
  const oldHook = safeRead(oldHookPath);
  const filterCssRules = parseCssRules(filterTabsCss.source);

  const cssFiles = listFiles(srcRoot, (file) => file.endsWith(".css"));
  const scrollbarCssFiles = cssFiles.filter((file) => {
    const source = withoutComments(safeRead(file).source);
    return /scrollbar-(?:color|width)\s*:|::\-webkit-scrollbar(?:\b|[-:])/m.test(source);
  });
  const unexpectedScrollbarCss = scrollbarCssFiles.filter((file) => file !== providerCssPath);
  check(
    "Scrollbar CSS exists only in ScrollbarProvider.css",
    scrollbarCssFiles.includes(providerCssPath) && unexpectedScrollbarCss.length === 0,
    `unexpected=${unexpectedScrollbarCss.map(relative).join(", ") || "none"}`,
  );

  const tsxFiles = listFiles(srcRoot, (file) => file.endsWith(".tsx"));
  const hiddenOutputFiles = tsxFiles.filter((file) => /\bdata-scrollbar\s*=/.test(withoutComments(safeRead(file).source)));
  check(
    "FilterTabs is the only data-scrollbar output",
    hiddenOutputFiles.length === 1 && hiddenOutputFiles[0] === filterTabsPath,
    `files=${hiddenOutputFiles.map(relative).join(", ") || "none"}`,
  );
  check(
    "FilterTabs emits hidden only when scrollable",
    /data-scrollbar\s*=\s*\{\s*scrollable\s*\?\s*["']hidden["']\s*:\s*undefined\s*\}/.test(filterTabs.source),
  );
  check(
    "FilterTabs retains horizontal overflow and blocks vertical overflow",
    selectorDeclarationIs(filterCssRules, ".scrollable", "overflow-x", "auto")
      && selectorDeclarationIs(filterCssRules, ".scrollable", "overflow-y", "hidden"),
  );
  const filterWheel = effectWithLocalFunction(filterTabs.source, filterTabsPath, "onWheel");
  const filterWheelEffect = withoutComments(filterWheel.effectBlock);
  const filterWheelFunction = withoutComments(filterWheel.functionBlock);
  check(
    "FilterTabs useEffect onWheel retains non-passive wheel-to-horizontal behavior",
    filterWheelEffect.length > 0
      && /addEventListener\(\s*["']wheel["']\s*,\s*onWheel\s*,\s*\{\s*passive\s*:\s*false\s*\}\s*\)/.test(filterWheelEffect)
      && /e\.preventDefault\(\s*\)/.test(filterWheelFunction)
      && /el\.scrollLeft\s*\+=\s*e\.deltaY/.test(filterWheelFunction),
    filterWheelFunction ? "onWheel function block found" : "onWheel function block missing",
  );

  const sourceFiles = listFiles(srcRoot, (file) => /\.(?:ts|tsx|css)$/.test(file));
  const sourceWithoutProviderVariables = sourceFiles.map((file) => ({
    file,
    source: withoutComments(safeRead(file).source),
  }));
  const oldHookRefs = sourceWithoutProviderVariables.filter(({ source }) => /\buseAutoHideScrollbars\b/.test(source));
  check("Old auto-hide Hook file and references are removed", !oldHook.exists && oldHookRefs.length === 0, `references=${oldHookRefs.map(({ file }) => relative(file)).join(", ") || "none"}`);
  // Provider 的五个 --ui-scrollbar-* 变量是新系统本身；除此之外，对 TSX/CSS 原文（含注释）
  // 做词边界扫描，保证旧 class 字符串无论位于模板字符串什么位置都无法漏过。
  const uiScrollbarFiles = sourceFiles
    .filter((file) => file !== providerPath && file !== providerCssPath)
    .filter((file) => /\bui-scrollbar\b/.test(safeRead(file).source));
  check("Legacy ui-scrollbar text is removed outside Provider (including comments)", uiScrollbarFiles.length === 0, `files=${uiScrollbarFiles.map(relative).join(", ") || "none"}`);
  check(
    "Immersive chat has no local scrollbar state or timer",
    !/\bscrollHideTimer\b|\bsetScrolling\b|\bstyles\.scrolling\b/.test(immersive.source),
  );
  const onThreadScrollBlock = withoutComments(variableFunctionBlock(immersive.source, immersivePath, "onThreadScroll"));
  const anchorBranch = /if\s*\(\s*nearBottom\s*&&\s*anchoredRef\.current\s*\)\s*\{([\s\S]*?)\}\s*else\s*\{([\s\S]*?)\}/.exec(onThreadScrollBlock);
  check(
    "Immersive onThreadScroll retains the exact near-bottom anchoring branch",
    /onScroll\s*=\s*\{onThreadScroll\}/.test(immersive.source)
      && /const\s+nearBottom\s*=\s*el\.scrollHeight\s*-\s*el\.scrollTop\s*-\s*el\.clientHeight\s*<\s*80\s*;/.test(onThreadScrollBlock)
      && compact(anchorBranch?.[1]) === "clearAnchor();stickRef.current=true;"
      && compact(anchorBranch?.[2]) === "stickRef.current=nearBottom&&!anchoredRef.current;",
    onThreadScrollBlock ? "function block found" : "onThreadScroll block missing",
  );
  const onThreadWheelBlock = withoutComments(variableFunctionBlock(immersive.source, immersivePath, "onThreadWheel"));
  check(
    "Immersive chat retains near-top wheel history loading",
    /onWheel\s*=\s*\{onThreadWheel\}/.test(immersive.source)
      && /e\.deltaY\s*<\s*0/.test(onThreadWheelBlock)
      && /el\.scrollTop\s*<\s*400/.test(onThreadWheelBlock)
      && /onNearTop\(\s*\)/.test(onThreadWheelBlock),
    onThreadWheelBlock ? "function block found" : "onThreadWheel block missing",
  );
}

function runDashboardContracts() {
  console.log("\n[Dashboard geometry contracts]");
  const dashboardCss = safeRead(dashboardCssPath);
  const rules = parseCssRules(dashboardCss.source);
  const expected = [
    ["Artifacts section leaves scrollbar geometry to the global slot", ".management-page.dashboard-page .dash-columns > .dash-section.dash-artifacts", "0"],
    ["Non-artifacts section leaves scrollbar geometry to the global slot", ".management-page.dashboard-page .dash-columns > .dash-section:not(.dash-artifacts)", "0"],
    ["Artifact row retains 24px content padding", ".management-page.dashboard-page .dash-artifacts .dash-art", "24px"],
    ["Feed head retains 24px content padding", ".management-page.dashboard-page .dash-feed-head", "24px"],
    ["Feed run retains 24px content padding", ".management-page.dashboard-page .dash-columns .dash-feed .dash-run", "24px"],
  ];
  for (const [name, selector, value] of expected) {
    check(
      name,
      selectorDeclarationIs(rules, selector, "padding-right", value),
      `actual=${selectorDeclarationSummary(rules, selector, "padding-right")}`,
    );
  }
}

const providerState = await runProviderSourceContracts();
if (providerState.providerExists) {
  await runProviderLifecycle();
} else {
  console.log("\nSKIP Provider real TSX lifecycle — ScrollbarProvider.tsx is not implemented yet (expected RED baseline). ");
}
if (mode !== "provider") runMigrationContracts();
if (mode === "full") runDashboardContracts();

const failed = results.filter((result) => !result.ok);
console.log(`\nSUMMARY mode=${mode} passed=${results.length - failed.length} failed=${failed.length} total=${results.length}`);
if (failed.length) {
  console.log("FAILED CONTRACTS:");
  for (const result of failed) console.log(`- ${result.name}${result.detail ? ` (${result.detail})` : ""}`);
}
process.exitCode = failed.length ? 1 : 0;
