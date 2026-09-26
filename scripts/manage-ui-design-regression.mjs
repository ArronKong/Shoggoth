#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANAGE_SRC = resolve(ROOT, "app/manage-ui/src");
// 从管理前端自身依赖加载 TypeScript，确保合同使用与项目编译一致的 AST 语义。
const ts = createRequire(resolve(ROOT, "app/manage-ui/package.json"))("typescript");
const DESIGN_PATH = resolve(ROOT, "app/manage-ui/openclawdesign.md");
const DESIGN_HASH = "a88ec42ad20f0fb5924552c308d1377f0f889bb535234652ea24293e65142009";
// Private design notes stay in the working repository, outside public exports.
// Their absence does not skip any source, component, token or style checks.
const HAS_LOCAL_DESIGN_DOCUMENT = existsSync(DESIGN_PATH);

const PHASES = [
  "tokens",
  "components-fields",
  "components-overlays",
  "pages-core",
  "pages-catalog",
  "pages-shell",
  "components-gallery",
  "all",
];

// 设计 token 按批准方案排序；顺序也是 RED 的诊断优先级。
const TOKEN_REQUIREMENTS = [
  ["ui-canvas", "--ui-canvas: light-dark(#f4f4f4, #18181b);"],
  ["ui-surface-1", "--ui-surface-1: light-dark(#ffffff, #1f1f23);"],
  ["ui-surface-2", "--ui-surface-2: light-dark(#f3f3f3, #28282e);"],
  ["ui-surface-glass", "--ui-surface-glass: light-dark(rgba(255, 255, 255, 0.55), rgba(40, 40, 46, 0.55));"],
  ["ui-text-1", "--ui-text-1: light-dark(#1a1a1a, #e4e4e7);"],
  ["ui-text-2", "--ui-text-2: light-dark(rgba(0, 0, 0, 0.5), rgba(255, 255, 255, 0.62));"],
  ["ui-text-3", "--ui-text-3: light-dark(#7d8796, #a1a1aa);"],
  ["ui-hairline", "--ui-hairline: light-dark(rgba(20, 24, 31, 0.08), rgba(228, 230, 235, 0.1));"],
  ["ui-control-border", "--ui-control-border: light-dark(rgba(20, 24, 31, 0.12), rgba(228, 230, 235, 0.16));"],
  ["ui-focus", "--ui-focus: light-dark(#2563eb, #60a5fa);"],
  ["ui-success", "--ui-success: light-dark(#047857, #34d399);"],
  ["ui-warning", "--ui-warning: light-dark(#b45309, #f59e0b);"],
  ["ui-error", "--ui-error: light-dark(#b91c1c, #f87171);"],
  ["ui-info", "--ui-info: light-dark(#0369a1, #38bdf8);"],
  ["ui-primary", "--ui-primary: #ffef84;"],
  ["ui-primary-hover", "--ui-primary-hover: #ffe96a;"],
  ["ui-primary-active", "--ui-primary-active: #f7de37;"],
  ["ui-primary-ink", "--ui-primary-ink: #171717;"],
  ["ui-radius-control", "--ui-radius-control: 20px;"],
  ["ui-radius-compact", "--ui-radius-compact: 16px;"],
  ["ui-radius-card", "--ui-radius-card: 24px;"],
  ["ui-shadow-card", "--ui-shadow-card: 0 8px 10px rgba(0, 0, 0, 0.02);"],
  ["ui-shadow-hover", "--ui-shadow-hover: 0 16px 32px -12px rgba(0, 0, 0, 0.08);"],
  ["ui-motion-state", "--ui-motion-state: 140ms;"],
  ["ui-motion-popover", "--ui-motion-popover: 200ms;"],
  ["ui-motion-overlay", "--ui-motion-overlay: 280ms;"],
];

// 旧 --u-* 仅作为兼容别名存在，不能继续复制一套独立的值。
const ALIAS_REQUIREMENTS = [
  ["u-bg-alias", "--u-bg: var(--ui-canvas);"],
  ["u-card-alias", "--u-card: var(--ui-surface-1);"],
  ["u-hairline-alias", "--u-hairline: var(--ui-hairline);"],
  ["u-shadow-card-alias", "--u-shadow-card: var(--ui-shadow-card);"],
  ["u-shadow-hover-alias", "--u-shadow-hover: var(--ui-shadow-hover);"],
  ["u-glass-pill-alias", "--u-glass-pill: var(--ui-surface-glass);"],
  ["u-hi-alias", "--u-hi: var(--ui-primary);"],
  ["u-hi-ink-alias", "--u-hi-ink: var(--ui-primary-ink);"],
];

// alias 归一化必须逐字恢复成改造前的八个原值，不能吞掉根块中的其他变量。
const MANAGE_SKIN_ALIAS_REVERSALS = [
  ["--u-bg: var(--ui-canvas);", "--u-bg: light-dark(#f4f4f4, #18181b);"],
  ["--u-card: var(--ui-surface-1);", "--u-card: light-dark(#ffffff, #1f1f23);"],
  ["--u-hairline: var(--ui-hairline);", "--u-hairline: light-dark(rgba(20, 24, 31, 0.08), rgba(228, 230, 235, 0.1));"],
  ["--u-shadow-card: var(--ui-shadow-card);", "--u-shadow-card: 0px 8px 10px 0px rgba(0, 0, 0, 0.02);"],
  ["--u-shadow-hover: var(--ui-shadow-hover);", "--u-shadow-hover: 0px 16px 32px -12px rgba(0, 0, 0, 0.08);"],
  ["--u-glass-pill: var(--ui-surface-glass);", "--u-glass-pill: light-dark(rgba(255, 255, 255, 0.55), rgba(40, 40, 46, 0.55));"],
  ["--u-hi: var(--ui-primary);", "--u-hi: #ffef84;"],
  ["--u-hi-ink: var(--ui-primary-ink);", "--u-hi-ink: #171717;"],
];

const MANAGE_SKIN_ORIGINAL_ROOT = `:root {
  /* R67 表面 token（自 UsagePage.css 上移；R107 再上移 :root——抽屉在
     Dialog.Portal（.page 之外），页面作用域取不到）。应用仍留页面作用域。 */
  --u-bg: light-dark(#f4f4f4, #18181b);
  --u-card: light-dark(#ffffff, #1f1f23);
  --u-hairline: light-dark(rgba(20, 24, 31, 0.08), rgba(228, 230, 235, 0.1));
  --u-shadow-card: 0px 8px 10px 0px rgba(0, 0, 0, 0.02);
  --u-shadow-hover: 0px 16px 32px -12px rgba(0, 0, 0, 0.08);
  --u-glass-pill: light-dark(rgba(255, 255, 255, 0.55), rgba(40, 40, 46, 0.55));
  --u-hi: #ffef84;
  --u-hi-ink: #171717;
  --u-gold: #f2c94c;
  --u-amber: #c99014;
  --u-tint-hover: light-dark(#fbf8ec, #2a2917);
  --u-tint-banner: light-dark(#fff9db, #32301a);
}`;

// styles.css 的既有基础变量不属于本轮 token 迁移，必须逐字保留。
const LEGACY_TOKEN_REQUIREMENTS = [
  ["legacy-bg", "--bg: light-dark(#ffffff, #18181b);"],
  ["legacy-fg", "--fg: light-dark(#1a1a1a, #e4e4e7);"],
  ["legacy-muted", "--muted: light-dark(#6b7280, #a1a1aa);"],
  ["legacy-border", "--border: light-dark(#e5e7eb, #2e2e33);"],
  ["legacy-accent", "--accent: light-dark(#2563eb, #3b82f6);"],
  ["legacy-row-hover", "--row-hover: light-dark(#f9fafb, #232327);"],
  ["legacy-nav-bg", "--nav-bg: light-dark(#f4f4f4, #202024);"],
  ["legacy-nav-hover", "--nav-hover: light-dark(#e8e8e8, #2c2c31);"],
  ["legacy-nav-active", "--nav-active: #ffef84;"],
];

// 四个没有语义等价新 token 的 --u-* 值不得借 alias 改写。
const MANAGE_SKIN_FIXED_REQUIREMENTS = [
  ["u-gold-fixed", "--u-gold: #f2c94c;"],
  ["u-amber-fixed", "--u-amber: #c99014;"],
  ["u-tint-hover-fixed", "--u-tint-hover: light-dark(#fbf8ec, #2a2917);"],
  ["u-tint-banner-fixed", "--u-tint-banner: light-dark(#fff9db, #32301a);"],
];

// frontmatter 采用逐行精确 key/value 合同，避免正文碰巧出现同名词而误通过。
const DESIGN_FRONTMATTER_REQUIREMENTS = [
  ["version", "version: 1.0.0"],
  ["name", "name: OpenClaw Management UI"],
  ["description", "description: Figma-derived light and dark design system for Shoggoth management pages."],
  ["scope-key", "scope:"],
  ["scope-include", "  include: [tasks, cron, token, models, skills, agents, glass, settings]"],
  ["scope-exclude", "  exclude: [chat, cli]"],
  ["sources-key", "sources:"],
  ["figma-file", "  figmaFile: 5F4ifCxAU3fAhIDsGGBLXA"],
  ["figma-nodes", '  nodes: ["6377:264", "6379:530", "6458:476", "6458:121", "6851:480"]'],
  ["colors-key", "colors:"],
  ["canvas", '  canvas: "light-dark(#f4f4f4, #18181b)"'],
  ["surface-1", '  surface-1: "light-dark(#ffffff, #1f1f23)"'],
  ["surface-2", '  surface-2: "light-dark(#f3f3f3, #28282e)"'],
  ["surface-glass", '  surface-glass: "light-dark(rgba(255, 255, 255, 0.55), rgba(40, 40, 46, 0.55))"'],
  ["text-1", '  text-1: "light-dark(#1a1a1a, #e4e4e7)"'],
  ["text-2", '  text-2: "light-dark(rgba(0, 0, 0, 0.5), rgba(255, 255, 255, 0.62))"'],
  ["text-3", '  text-3: "light-dark(#7d8796, #a1a1aa)"'],
  ["hairline", '  hairline: "light-dark(rgba(20, 24, 31, 0.08), rgba(228, 230, 235, 0.1))"'],
  ["control-border", '  control-border: "light-dark(rgba(20, 24, 31, 0.12), rgba(228, 230, 235, 0.16))"'],
  ["focus", '  focus: "light-dark(#2563eb, #60a5fa)"'],
  ["success", '  success: "light-dark(#047857, #34d399)"'],
  ["warning", '  warning: "light-dark(#b45309, #f59e0b)"'],
  ["error", '  error: "light-dark(#b91c1c, #f87171)"'],
  ["info", '  info: "light-dark(#0369a1, #38bdf8)"'],
  ["primary", '  primary: "#ffef84"'],
  ["primary-hover", '  primary-hover: "#ffe96a"'],
  ["primary-active", '  primary-active: "#f7de37"'],
  ["primary-ink", '  primary-ink: "#171717"'],
  ["typography-key", "typography:"],
  ["typography-family", `  family: '"SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif'`],
  ["typography-page-title", "  page-title: { size: 32px, lineHeight: 32px, weight: 300, letterSpacing: -0.025em }"],
  ["typography-section-title", "  section-title: { size: 18px, lineHeight: 24px, weight: 500 }"],
  ["typography-control", "  control: { size: 16px, lineHeight: 20px, weight: 400 }"],
  ["typography-body", "  body: { size: 14px, lineHeight: 20px, weight: 400 }"],
  ["typography-metadata", "  metadata: { size: 12px, lineHeight: 16px, weight: 400 }"],
  ["spacing-key", "spacing:"],
  ["spacing-unit", "  unit: 4px"],
  ["spacing-page-desktop", "  pageDesktop: 40px"],
  ["spacing-page-tablet", "  pageTablet: 24px"],
  ["spacing-page-narrow", "  pageNarrow: 20px"],
  ["spacing-title-toolbar", "  titleToToolbar: 32px"],
  ["spacing-toolbar-gap", "  toolbarGap: 16px"],
  ["spacing-card-gap", "  cardGap: 24px"],
  ["layout-key", "layout:"],
  ["desktop-canvas", "  desktopCanvas: 1380x900"],
  ["navigation-rail", "  navigationRail: 64px"],
  ["page-breakpoints", "  pageBreakpoints: [960px, 720px]"],
  ["toolbar-height", "  toolbarHeight: 48px"],
  ["active-segment-height", "  activeSegmentHeight: 32px"],
  ["rounded-key", "rounded:"],
  ["radius-control", "  control: 20px"],
  ["radius-compact", "  compact: 16px"],
  ["radius-card", "  card: 24px"],
  ["radius-calendar-event", "  calendarEvent: 20px"],
  ["elevation-key", "elevation:"],
  ["elevation-card", '  card: "0 8px 10px rgba(0, 0, 0, 0.02)"'],
  ["elevation-hover", '  hover: "0 16px 32px -12px rgba(0, 0, 0, 0.08)"'],
  ["motion-key", "motion:"],
  ["motion-state", "  state: 140ms"],
  ["motion-popover", "  popover: 200ms"],
  ["motion-overlay", "  overlay: 280ms"],
  ["motion-reduced", "  reducedMotion: remove transform and opacity animation while preserving content"],
  ["components-key", "components:"],
  ["component-primary-button", "  primaryButton: { height: 48px, radius: 999px, background: primary, ink: primary-ink }"],
  ["component-field", "  field: { minHeight: 40px, radius: 12px }"],
  ["component-segmented", "  segmentedControl: { shellHeight: 48px, activeHeight: 32px }"],
  ["component-card", "  card: { radius: 24px, border: hairline }"],
  ["component-calendar-event", "  calendarEvent: { height: 40px, radius: 20px }"],
];

// 正文章节标题同样逐行验证，确保规范的结构与语义没有漂移。
const DESIGN_BODY_HEADINGS = [
  "# OpenClaw Management UI Design System",
  "## Foundations",
  "## Semantic Tokens",
  "## Typography",
  "## Layout and Spacing",
  "## Components",
  "### Buttons",
  "### Segmented Controls",
  "### Fields",
  "### Cards, Tables, and Calendar",
  "### Drawer, Modal, Confirm, Toast",
  "## Page Patterns",
  "## Accessibility",
  "## Responsive",
  "## Motion",
  "## Do's and Don'ts",
  "## Verification Checklist",
];

const USAGE_REDUCED_MOTION_BLOCK = `    // 减少动态效果时直接显示最终值，数据口径保持不变。
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      shown.current = value;
      el.textContent = fmt(value);
      return;
    }
`;

const GLASS_OLD_HEADER = `      <header className={styles.head}>
        <h2 className={styles.title}>{t("glassLab.title")}</h2>
        <p className={styles.sub}>{t("glassLab.subtitle")}</p>
      </header>`;
const GLASS_PAGE_HEAD = '      <PageHead title={t("glassLab.title")} subtitle={t("glassLab.subtitle")} />';
const FIELD_TRIGGER_BASELINE = "      <BaseSelect.Trigger className={styles.trigger}>";
const FIELD_TRIGGER_INVALID_SNIPPET = `      {/* 仅转发校验语义与视觉状态，不改变选值行为。 */}
      <BaseSelect.Trigger
        className={styles.trigger}
        aria-invalid={invalid || undefined}
      >`;

// 七个普通管理页必须取得唯一、精确的页面作用域类。
const ROOT_CLASS_REQUIREMENTS = [
  ["pages/TasksPage.tsx", "tasks-root", 'className="page management-page tasks-page"'],
  ["pages/CronPage.tsx", "cron-root", 'className="cron-page management-page"'],
  ["pages/UsagePage.tsx", "usage-root", 'className="page management-page usage-page"'],
  ["pages/ModelsPage.tsx", "models-root", 'className="page management-page models-page"'],
  ["pages/SkillsPage.tsx", "skills-root", 'className="page management-page skills-page"'],
  ["pages/AgentsPage.tsx", "agents-root", 'className={`page management-page agents-page ${s.root}`}'],
  ["pages/SettingsPage.tsx", "settings-root", 'className="page management-page settings-page"'],
];

// 新的统一页面 CSS 必须完整包在唯一批准的 marker 中，并覆盖批准的响应断点。
const STYLE_MARKER_REQUIREMENTS = [
  ["management-marker-start", "/* management-page:start */"],
  ["management-marker-end", "/* management-page:end */"],
];

const STYLE_RULE_REQUIREMENTS = [
  ["management-page-head-title", "manage-skin.css", ".management-page .page-head-title", []],
  [
    "management-page-head-subtitle",
    "manage-skin.css",
    ".page-head .page-head-subtitle",
    ["color: light-dark(rgba(0, 0, 0, 0.5), rgba(255, 255, 255, 0.5));"],
  ],
  [
    "management-tasks-kb-pill-focus",
    "manage-skin.css",
    ".management-page.tasks-page .kb-pill:focus-within",
    [
      "outline: none;",
      "box-shadow: 0 0 0 2px var(--ui-surface-1), 0 0 0 4px var(--ui-focus);",
    ],
  ],
  ["management-breakpoint-wide", "manage-skin.css", "@media (max-width: 960px)", []],
  ["management-breakpoint-narrow", "manage-skin.css", "@media (max-width: 720px)", []],
  ["management-reduced-motion", "manage-skin.css", "@media (prefers-reduced-motion: reduce)", []],
];

// 组件 CSS 合同把声明绑定到 selector block，杜绝同文件其他规则误命中。
const FIELD_CSS_REQUIREMENTS = [
  ["backend-tabs-height", "components/PillTabs.module.css", ".tabs", ["height: 48px;"]],
  ["backend-tabs-radius", "components/PillTabs.module.css", ".tabs", ["border-radius: 24px;"]],
  ["backend-tab-height", "components/PillTabs.module.css", ".tab", ["height: 32px;"]],
  ["backend-tab-color", "components/PillTabs.module.css", ".tab", ["color: light-dark(#000000, #ffffff);"]],
  ["backend-tabs-focus", "components/PillTabs.module.css", ".tab:focus-visible", ["box-shadow: 0 0 0 2px var(--ui-focus);"]],
  ["backend-tabs-reduced", "components/PillTabs.module.css", "@media (prefers-reduced-motion: reduce)", ["transition: none;"]],
  ["field-trigger-height", "components/Field.module.css", ".trigger", ["min-height: 40px;"]],
  ["field-trigger-surface", "components/Field.module.css", ".trigger", ["background: var(--ui-surface-1);"]],
  ["field-trigger-border", "components/Field.module.css", ".trigger", ["border: 1px solid light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.14));"]],
  ["field-popup-radius", "components/Field.module.css", ".popup", ["border-radius: var(--ui-radius-compact);"]],
  ["field-switch-border", "components/Field.module.css", ".switchRoot", ["border: 0;"]],
  ["field-switch-off-background", "components/Field.module.css", ".switchRoot", ["background: light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.16));"]],
  ["field-switch-thumb", "components/Field.module.css", ".switchThumb", ["background: light-dark(#ffffff, #171717);"]],
  ["field-switch-checked", "components/Field.module.css", ".switchRoot[data-checked]", ["background: var(--ui-switch-on);"]],
  ["field-switch-disabled-track", "components/Field.module.css", ".switchRoot[data-disabled]", ["background: var(--ui-surface-2);", "opacity: 1;"]],
  ["field-switch-disabled-thumb", "components/Field.module.css", ".switchRoot[data-disabled] .switchThumb", [], ["background"]],
  ["field-switch-focused", "components/Field.module.css", ".switchRoot[data-focused]", ["box-shadow: 0 0 0 2px var(--ui-surface-1), 0 0 0 4px var(--ui-focus);"]],
  ["field-switch-motion", "components/Field.module.css", ".switchRoot", ["transition: background-color var(--ui-motion-state) ease;"]],
  ["field-switch-disabled", "components/Field.module.css", ".switchDisabled", ["cursor: not-allowed;", "opacity: 1;"]],
  ["field-switch-disabled-label", "components/Field.module.css", ".switchDisabled .switchLabel", ["color: color-mix(in srgb, var(--ui-text-1) 68%, var(--ui-surface-2));"]],
  ["field-trigger-focus", "components/Field.module.css", ".trigger:focus-visible,\n.trigger[data-popup-open]", ["border-color: light-dark(#000000, #ffffff);"]],
  ["field-trigger-disabled", "components/Field.module.css", ".trigger[data-disabled]", ["color: color-mix(in srgb, var(--ui-text-1) 68%, var(--ui-surface-2));", "cursor: not-allowed;", "opacity: 1;"]],
  ["field-item-disabled", "components/Field.module.css", ".item[data-disabled]", ["color: color-mix(in srgb, var(--ui-text-1) 68%, var(--ui-surface-2));", "cursor: not-allowed;", "opacity: 1;"]],
  ["field-invalid", "components/Field.module.css", '.trigger[aria-invalid="true"]', ["border-color: var(--ui-error);"]],
  ["field-reduced", "components/Field.module.css", "@media (prefers-reduced-motion: reduce)", ["transition: none;"]],
  ["management-switch-checked", "manage-skin.css", '.management-page [role="switch"][data-checked]:not([data-disabled])', ["background: var(--ui-switch-on);"]],
  ["management-switch-disabled", "manage-skin.css", '.management-page [role="switch"][data-disabled]', ["background: var(--ui-surface-2);", "opacity: 1;"]],
];

// TSX 与全局原生字段 selector 仍使用精确字符串合同。
const FIELD_FILE_REQUIREMENTS = [
  ["field-select-invalid-parameter", "components/Field.tsx", "  invalid,\n}: {"],
  ["field-select-invalid-prop", "components/Field.tsx", "invalid?: boolean;"],
  ["field-select-invalid-forward", "components/Field.tsx", FIELD_TRIGGER_INVALID_SNIPPET],
];

const NATIVE_FIELD_CSS_REQUIREMENTS = [
  ["native-field-border", "styles.css", ".field-input,\n.field-textarea", ["border: 1px solid light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.14));"], []],
  ["native-field-focus", "styles.css", ".field-input:focus-visible,\n.field-textarea:focus-visible", ["border-color: light-dark(#000000, #ffffff);"], ["box-shadow"]],
  ["native-field-disabled", "styles.css", ".field-input:disabled,\n.field-textarea:disabled", ["color: color-mix(in srgb, var(--ui-text-1) 68%, var(--ui-surface-2));", "cursor: not-allowed;", "opacity: 1;"], []],
  ["native-field-invalid", "styles.css", '.field-input[aria-invalid="true"],\n.field-textarea[aria-invalid="true"]', ["border-color: var(--ui-error);"], []],
];

// 浮层关键声明全部绑定到 panel/head/close/status/reduced 对应块。
const OVERLAY_CSS_REQUIREMENTS = [
  // R370：右侧抽屉全站退役，浮层只剩居中弹窗，Drawer.module.css 已删除。
  ["modal-overlay-stable", "components/Modal.module.css", ".overlay", ["opacity: 1;", "transition: opacity var(--ui-motion-modal-enter) var(--ui-motion-modal-ease);"], [], ["animation"]],
  ["modal-overlay-lifecycle", "components/Modal.module.css", ".overlay[data-starting-style],\n.overlay[data-ending-style]", ["opacity: 0;"]],
  ["modal-overlay-exit-duration", "components/Modal.module.css", ".overlay[data-ending-style]", ["transition-duration: var(--ui-motion-modal-exit);"]],
  // 圆角/内距/无描边是设计稿 7108:896「内容大弹窗」的取值（R317-R320 重做，合同 R370 补齐）。
  ["modal-radius", "components/Modal.module.css", ".panel", ["border-radius: 40px;", "background: var(--ui-surface-1);", "opacity: 1;", "transform: translate(-50%, -50%);"], ["transition"], ["animation"]],
  ["modal-panel-lifecycle", "components/Modal.module.css", ".panel[data-starting-style],\n.panel[data-ending-style]", ["opacity: 0;", "transform: translate(-50%, -48%);"]],
  ["modal-panel-exit-duration", "components/Modal.module.css", ".panel[data-ending-style]", ["transition-duration: var(--ui-motion-modal-exit);"]],
  // 标题行靠留白分区，设计稿没有分隔线。
  ["modal-head-hairless", "components/Modal.module.css", ".head", ["padding: 0;"], [], ["border-bottom"]],
  ["modal-close-size", "components/Modal.module.css", ".close", ["width: 32px;", "height: 32px;"]],
  ["modal-close-hover", "components/Modal.module.css", ".panel .close:hover:not(:disabled)", ["color: var(--ui-text-1);", "background: var(--ui-surface-2);"]],
  ["modal-close-focus", "components/Modal.module.css", ".panel .close:focus-visible", ["outline: none;", "box-shadow: 0 0 0 2px var(--ui-surface-1), 0 0 0 4px var(--ui-focus);"]],
  ["modal-subtitle-color", "components/Modal.module.css", ".subtitle", ["color: color-mix(in srgb, var(--ui-text-1) 68%, var(--ui-surface-1));"]],
  ["modal-section-title-color", "components/Modal.module.css", ".sectionTitle", ["color: color-mix(in srgb, var(--ui-text-1) 68%, var(--ui-surface-1));"]],
  ["modal-detail-label-color", "components/Modal.module.css", ".detailLabel", ["color: color-mix(in srgb, var(--ui-text-1) 68%, var(--ui-surface-1));"]],
  ["modal-reduced", "components/Modal.module.css", "@media (prefers-reduced-motion: reduce)", ["transition: none;", "opacity: 1;", "transform: translate(-50%, -50%);"]],
  ["confirm-viewport", "components/ui.module.css", ".modalPanel", ["border-radius: 40px;", "max-height: calc(100vh - 80px);", "display: flex;", "flex-direction: column;", "overflow: hidden;"]],
  ["confirm-body", "components/ui.module.css", ".modalBody", ["color: light-dark(rgba(0, 0, 0, 0.8), rgba(255, 255, 255, 0.8));", "min-height: 0;", "overflow-y: auto;"]],
  ["confirm-foot", "components/ui.module.css", ".modalFoot", ["flex-shrink: 0;"]],
  ["toast-foreground", "components/ui.module.css", ".toast", ["color: #ffffff;"]],
  ["toast-success-background", "components/ui.module.css", ".success", ["background: #5CD757;"]],
  ["toast-error-background", "components/ui.module.css", ".error", ["background: #FA5B5B;"]],
  ["toast-info-background", "components/ui.module.css", ".info", ["background: light-dark(#000000, #ffffff);"]],
  ["confirm-toast-reduced", "components/ui.module.css", "@media (prefers-reduced-motion: reduce)", ["animation: none;"]],
];

// 核心工作流页要求保持固定顺序，以便失败直接指向第一处视觉缺口。
const CORE_PAGE_REQUIREMENTS = [
  {
    kind: "css-rule",
    id: "tasks-card-title",
    path: "manage-skin.css",
    selector: ".management-page.tasks-page .kanban-card-title",
    declarations: ["color: var(--ui-text-1);", "font-size: 18px;", "line-height: 24px;", "font-weight: 500;"],
  },
  {
    kind: "css-rule",
    id: "tasks-card-surface",
    path: "manage-skin.css",
    selector: ".management-page.tasks-page .kanban-card",
    declarations: ["background: var(--ui-surface-1);", "border: 1px solid var(--ui-hairline);", "border-radius: 24px;", "padding: 20px;", "box-shadow: var(--ui-shadow-card);"],
  },
  {
    kind: "css-rule",
    id: "tasks-kanban-gap",
    path: "manage-skin.css",
    selector: ".management-page.tasks-page .kanban",
    declarations: ["gap: 32px;"],
  },
  {
    kind: "css-rule",
    id: "tasks-unassigned-warning",
    path: "manage-skin.css",
    selector: ".management-page.tasks-page .kanban-assignee.hk-unassigned",
    declarations: ["color: var(--ui-warning);"],
  },
  {
    kind: "css-rule",
    id: "tasks-live-stale-combination",
    path: "manage-skin.css",
    selector: ".management-page.tasks-page .kanban-card.is-live.hk-stale-amber",
    declarations: ["box-shadow: inset 3px 0 0 var(--accent, #e5484d), inset 0 0 0 1px light-dark(#b78103, #eab308), var(--ui-shadow-card);"],
  },
  {
    kind: "css-rule",
    id: "cron-calendar-chip",
    path: "manage-skin.css",
    selector: ".management-page.cron-page .cal-chip",
    declarations: ["min-height: 40px;", "max-height: 40px;", "border-radius: 20px;", "padding: 0 12px;"],
  },
  {
    kind: "css-rule",
    id: "cron-calendar-event",
    path: "manage-skin.css",
    selector: ".management-page.cron-page .cal-ev",
    declarations: ["min-height: 40px;", "max-height: 40px;", "border-radius: 20px;", "padding: 0 14px;"],
  },
  {
    kind: "css-rule",
    id: "cron-table-surface",
    path: "manage-skin.css",
    selector: ".management-page.cron-page .table-wrap",
    declarations: ["background: var(--ui-surface-1);", "border: 1px solid var(--ui-hairline);", "border-radius: 24px;", "box-shadow: var(--ui-shadow-card);", "overflow-x: auto;"],
  },
  {
    kind: "css-rule",
    id: "cron-month-surface",
    path: "manage-skin.css",
    selector: ".management-page.cron-page .cal-grid",
    declarations: ["background: var(--ui-surface-1);", "border: 0;", "border-radius: 24px;", "box-shadow: var(--ui-shadow-card);"],
  },
  {
    kind: "css-rule",
    id: "cron-time-surface",
    path: "manage-skin.css",
    selector: ".management-page.cron-page .cal-tg",
    declarations: ["background: var(--ui-surface-1);", "border: 0;", "border-radius: 24px;", "box-shadow: var(--ui-shadow-card);"],
  },
  {
    kind: "css-rule",
    id: "usage-section",
    path: "pages/usage/UsagePage.css",
    selector: ".management-page.usage-page .usage-section",
    declarations: ["max-width: 100%;", "background: var(--ui-surface-1);", "border-radius: 24px;", "box-shadow: var(--ui-shadow-card);"],
  },
  {
    kind: "css-rule",
    id: "usage-table-containment",
    path: "pages/usage/UsagePage.css",
    selector: ".management-page.usage-page .usage-table",
    declarations: ["min-width: 720px;"],
  },
  { kind: "text", id: "usage-reduced-motion", path: "pages/UsagePage.tsx", expected: USAGE_REDUCED_MOTION_BLOCK },
];

// 目录型页面按 Models → Skills → Agents 的真实结构校验；
// 每条 CSS 合同都绑定精确 selector 与声明，避免相似文本误命中。
const CATALOG_PAGE_REQUIREMENTS = [
  {
    kind: "css-rule",
    id: "models-group-surface",
    path: "manage-skin.css",
    selector: ".management-page.models-page .model-group",
    declarations: ["min-width: 0;", "margin-bottom: 32px;"],
  },
  {
    kind: "css-rule",
    id: "models-grid-layout",
    path: "manage-skin.css",
    selector: ".management-page.models-page .model-grid",
    declarations: ["display: grid;", "gap: 16px;", "min-width: 0;"],
  },
  {
    kind: "css-rule",
    id: "models-card-boundary",
    path: "manage-skin.css",
    selector: ".management-page.models-page .model-card",
    declarations: ["background: var(--ui-surface-1);", "border: 1px solid var(--ui-hairline);", "border-radius: 16px;"],
  },
  {
    kind: "css-rule",
    id: "models-meta-type",
    path: "manage-skin.css",
    selector: ".management-page.models-page .model-meta",
    declarations: ["font-size: 12px;", "line-height: 16px;", "font-weight: 300;"],
  },
  {
    kind: "css-rule",
    id: "models-group-spacing",
    path: "manage-skin.css",
    selector: ".management-page.models-page .model-group",
    declarations: ["margin-bottom: 32px;"],
  },
  {
    kind: "css-rule",
    id: "models-group-head",
    path: "manage-skin.css",
    selector: ".management-page.models-page .model-provider",
    declarations: ["letter-spacing: 0.2px;"],
  },
  {
    kind: "css-rule",
    id: "models-grid",
    path: "manage-skin.css",
    selector: ".management-page.models-page .model-grid",
    declarations: ["grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));", "gap: 16px;"],
  },
  {
    kind: "css-rule",
    id: "models-card-surface",
    path: "manage-skin.css",
    selector: ".management-page.models-page .model-card",
    declarations: ["background: var(--ui-surface-1);", "border: 1px solid var(--ui-hairline);", "border-radius: 16px;", "padding: 16px;", "box-shadow: var(--ui-shadow-card);"],
  },
  {
    kind: "css-rule",
    id: "models-card-hover",
    path: "manage-skin.css",
    selector: ".management-page.models-page .model-card:hover",
    declarations: ["box-shadow: var(--ui-shadow-hover);"],
  },
  {
    kind: "css-rule",
    id: "models-name",
    path: "manage-skin.css",
    selector: ".management-page.models-page .model-name",
    declarations: ["color: var(--ui-text-1);", "font-size: 16px;", "line-height: 24px;", "font-weight: 400;"],
  },
  {
    kind: "css-rule",
    id: "models-meta",
    path: "manage-skin.css",
    selector: ".management-page.models-page .model-meta",
    declarations: ["font-size: 12px;", "line-height: 16px;"],
  },
  {
    kind: "css-rule",
    id: "models-active-semantic",
    path: "manage-skin.css",
    selector: ".management-page.models-page .tag-active",
    declarations: ["color: var(--ui-success);"],
  },
  {
    kind: "css-rule",
    id: "models-reasoning-semantic",
    path: "manage-skin.css",
    selector: ".management-page.models-page .tag-reason",
    declarations: ["color: var(--ui-warning);"],
  },
  {
    kind: "css-rule",
    id: "skills-group-head",
    path: "manage-skin.css",
    selector: ".management-page.skills-page .skill-body",
    declarations: ["display: flex;", "gap: 16px;", "min-height: 0;", "min-width: 0;"],
  },
  { kind: "text", id: "skills-grid-class", path: "pages/SkillsPage.tsx", expected: 'className="skill-grid"' },
  { kind: "text", id: "skills-card-class", path: "pages/SkillsPage.tsx", expected: 'className={`skill-card${isSel ? " skill-card-selected" : ""}${s.enabled ? "" : " skill-off"}`}' },
  {
    kind: "css-rule",
    id: "skills-list",
    path: "manage-skin.css",
    selector: ".management-page.skills-page .skill-grid",
    declarations: ["grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));", "gap: 16px;", "min-width: 0;"],
  },
  {
    kind: "css-rule",
    id: "skills-row-surface",
    path: "manage-skin.css",
    selector: ".management-page.skills-page .skill-card",
    declarations: ["display: flex;", "background: var(--ui-surface-1);", "border: 1px solid var(--ui-hairline);", "border-radius: 24px;", "padding: 14px 24px;"],
  },
  {
    kind: "css-rule",
    id: "skills-name",
    path: "manage-skin.css",
    selector: ".management-page.skills-page .skill-name",
    declarations: ["color: var(--ui-text-1);", "font-size: 16px;", "line-height: 20px;", "font-weight: 400;"],
  },
  {
    kind: "css-rule",
    id: "skills-description",
    path: "manage-skin.css",
    selector: ".management-page.skills-page .skill-desc",
    declarations: ["font-size: 12px;", "line-height: 18px;", "font-weight: 300;"],
  },
  {
    kind: "css-rule",
    id: "skills-disabled-readable",
    path: "manage-skin.css",
    selector: ".management-page.skills-page .skill-off",
    declarations: ["background: var(--ui-surface-2);", "opacity: 1;"],
  },
  {
    kind: "css-rule",
    id: "agents-history-layout",
    path: "pages/AgentsPage.module.css",
    selector: ".historyLayout",
    declarations: ["display: flex;", "min-height: 0;", "gap: 24px;"],
  },
  {
    kind: "css-rule",
    id: "agents-history-sessions",
    path: "pages/AgentsPage.module.css",
    selector: ".historySessions",
    declarations: ["display: flex;", "width: 220px;", "flex: 0 0 220px;", "overflow-y: auto;"],
  },
  {
    kind: "css-rule",
    id: "agents-row",
    path: "pages/AgentsPage.module.css",
    selector: ".row",
    declarations: ["display: flex;", "width: 100%;", "background: none;"],
  },
  {
    kind: "css-rule",
    id: "agents-chip-selected",
    path: "pages/AgentsPage.module.css",
    selector: ".chipOn",
    declarations: ["background: light-dark(#e8f7ec, #1d3323);", "color: light-dark(#1f7a37, #7ed695);"],
  },
  {
    kind: "css-rule",
    id: "agents-harness-card",
    path: "pages/AgentsPage.module.css",
    selector: ".harnessCard",
    declarations: ["background: var(--ui-surface-1);", "border: 1px solid var(--ui-hairline);", "border-radius: 16px;", "padding: 16px;", "box-shadow: var(--ui-shadow-card);"],
  },
  {
    kind: "css-rule",
    id: "agents-harness-actions",
    path: "pages/AgentsPage.module.css",
    selector: ".harnessActions",
    declarations: ["padding: 0 4px 16px;"],
  },
  {
    kind: "css-rule",
    id: "agents-primary-action",
    path: "pages/AgentsPage.module.css",
    selector: ".pillBtn",
    declarations: ["padding: 4px 14px;", "border-radius: 30px;", "cursor: pointer;"],
  },
  {
    kind: "css-rule",
    id: "agents-secondary-action",
    path: "pages/AgentsPage.module.css",
    selector: ".pillBtnGhost",
    declarations: ["padding: 3px 14px;", "background: transparent;", "cursor: pointer;"],
  },
  {
    kind: "css-rule",
    id: "agents-harness-list",
    path: "pages/AgentsPage.module.css",
    selector: ".harnessList",
    declarations: ["display: flex;", "min-width: 0;", "flex: 1;", "overflow-y: auto;"],
  },
  {
    kind: "css-rule",
    id: "agents-harness-editor",
    path: "pages/AgentsPage.module.css",
    selector: ".harnessEditor",
    declarations: ["width: 100%;", "min-height: 88px;", "resize: vertical;"],
  },
  {
    kind: "css-rule",
    id: "agents-harness-pre",
    path: "pages/AgentsPage.module.css",
    selector: ".harnessPre",
    declarations: ["max-height: 240px;", "overflow: auto;", "white-space: pre-wrap;"],
  },
  {
    kind: "css-rule",
    id: "agents-narrow-single-column",
    path: "pages/AgentsPage.module.css",
    selector: "@media (max-width: 900px)",
    declarations: ["flex-direction: column;", "width: 100%;"],
  },
];

// 壳层页面单独验证 Glass / Settings 的页面结构、关键视觉 token 与窄屏收敛。
const SHELL_PAGE_REQUIREMENTS = [
  { kind: "text", id: "glass-management-root", path: "pages/GlassLab.tsx", expected: 'className={`page management-page ${styles.lab}`}' },
  { kind: "text", id: "glass-page-head-import", path: "pages/GlassLab.tsx", expected: 'import { PageHead } from "../components/PageHead";' },
  { kind: "text", id: "glass-page-head", path: "pages/GlassLab.tsx", expected: '<PageHead title={t("glassLab.title")} subtitle={t("glassLab.subtitle")} />' },
  {
    kind: "css-rule",
    id: "glass-canvas",
    path: "pages/GlassLab.module.css",
    selector: ".lab",
    declarations: ["padding: 0;", "min-width: 0;", "background: var(--ui-canvas);"],
  },
  {
    kind: "css-rule",
    id: "glass-body",
    path: "pages/GlassLab.module.css",
    selector: ".body",
    declarations: ["display: grid;", "grid-template-columns: minmax(0, 1fr) minmax(260px, 280px);", "min-width: 0;"],
  },
  {
    kind: "css-rule",
    id: "glass-stage",
    path: "pages/GlassLab.module.css",
    selector: ".stage",
    declarations: ["min-width: 0;", "border: 1px solid var(--ui-hairline);", "border-radius: 24px;", "box-shadow: var(--ui-shadow-card);"],
  },
  {
    kind: "css-rule",
    id: "glass-panel",
    path: "pages/GlassLab.module.css",
    selector: ".panel",
    declarations: ["min-width: 0;", "background: var(--ui-surface-1);", "border: 1px solid var(--ui-hairline);", "border-radius: 24px;", "box-shadow: var(--ui-shadow-card);"],
  },
  {
    kind: "css-rule",
    id: "glass-number-control",
    path: "pages/GlassLab.module.css",
    selector: ".num",
    declarations: ["min-height: 40px;", "border: 1px solid color-mix(in srgb, var(--ui-text-1) 50%, var(--ui-surface-1));"],
  },
  {
    kind: "css-rule",
    id: "glass-save-primary",
    path: "pages/GlassLab.module.css",
    selector: ".saveBtn",
    declarations: ["min-height: 48px;", "background: var(--ui-primary);", "color: var(--ui-primary-ink);"],
  },
  {
    kind: "css-rule",
    id: "glass-reset-neutral",
    path: "pages/GlassLab.module.css",
    selector: ".resetBtn",
    declarations: ["min-height: 40px;", "background: var(--ui-surface-1);"],
  },
  {
    kind: "css-rule",
    id: "glass-focus-visible",
    path: "pages/GlassLab.module.css",
    selector: ".saveBtn:focus-visible,\n.resetBtn:focus-visible,\n.presetLoad:focus-visible,\n.presetDel:focus-visible,\n.num:focus-visible,\n.range:focus-visible",
    declarations: ["outline: none;", "box-shadow: 0 0 0 2px var(--ui-surface-1), 0 0 0 4px var(--ui-focus);"],
  },
  {
    kind: "css-rule",
    id: "glass-hint-contrast",
    path: "pages/GlassLab.module.css",
    selector: ".hint",
    declarations: ["color: color-mix(in srgb, var(--ui-text-1) 68%, var(--ui-surface-1));"],
  },
  { kind: "css-rule", id: "glass-responsive", path: "pages/GlassLab.module.css", selector: "@media (max-width: 720px)" },
  {
    kind: "css-rule",
    id: "glass-responsive-stack",
    path: "pages/GlassLab.module.css",
    selector: ".lab .body",
    declarations: ["grid-template-columns: minmax(0, 1fr);", "overflow: visible;"],
  },
  {
    kind: "css-rule",
    id: "glass-responsive-stage",
    path: "pages/GlassLab.module.css",
    selector: ".lab .stage",
    declarations: ["min-height: 360px;"],
  },
  {
    kind: "css-rule",
    id: "glass-responsive-panel",
    path: "pages/GlassLab.module.css",
    selector: ".lab .panel",
    declarations: ["width: 100%;", "max-height: none;", "overflow: visible;"],
  },
  {
    kind: "css-rule",
    id: "settings-local-muted-tokens",
    path: "pages/SettingsPage.css",
    selector: ".management-page.settings-page",
    declarations: [
      "--settings-muted-surface-1: color-mix(in srgb, var(--ui-text-1) 68%, var(--ui-surface-1));",
      "--settings-muted-surface-2: color-mix(in srgb, var(--ui-text-1) 68%, var(--ui-surface-2));",
    ],
  },
  {
    kind: "css-rule",
    id: "settings-muted-copy-surface-1",
    path: "pages/SettingsPage.css",
    selector: ".management-page.settings-page .status-label,\n.management-page.settings-page .settings-card .field-label,\n.management-page.settings-page .settings-card .field-hint,\n.management-page.settings-page .creds-desc",
    declarations: ["color: var(--settings-muted-surface-1);"],
  },
  {
    kind: "css-rule",
    id: "settings-muted-copy-surface-2",
    path: "pages/SettingsPage.css",
    selector: ".management-page.settings-page .status-conn.off,\n.management-page.settings-page .creds-status",
    declarations: ["color: var(--settings-muted-surface-2);"],
  },
  {
    kind: "css-rule",
    id: "settings-card",
    path: "pages/SettingsPage.css",
    selector: ".management-page.settings-page .settings-card",
    declarations: ["background: var(--ui-surface-1);", "border: 1px solid var(--ui-hairline);", "border-radius: 24px;", "box-shadow: var(--ui-shadow-card);"],
  },
  {
    kind: "css-rule",
    id: "settings-page-head-actions",
    path: "pages/SettingsPage.css",
    selector: ".management-page.settings-page .page-head-actions",
    declarations: ["gap: 8px;"],
  },
  {
    kind: "css-rule",
    id: "settings-field-containment",
    path: "pages/SettingsPage.css",
    selector: ".management-page.settings-page .settings-card :is(.field-input, .field-textarea)",
    declarations: ["min-width: 0;"],
  },
  {
    kind: "css-rule",
    id: "settings-field-layout",
    path: "pages/SettingsPage.css",
    selector: ".management-page.settings-page .settings-card > .field",
    declarations: ["min-width: 0;"],
  },
  {
    kind: "css-rule",
    id: "settings-disabled-readable",
    path: "pages/SettingsPage.css",
    selector: ".management-page.settings-page button:disabled:not(.ui-cbtn)",
    declarations: [
      "opacity: 1;",
      "cursor: not-allowed;",
      "color: var(--settings-muted-surface-2);",
      "background: var(--ui-surface-2);",
    ],
    properties: ["border-color"],
  },
  { kind: "css-rule", id: "settings-responsive", path: "pages/SettingsPage.css", selector: "@media (max-width: 720px)" },
  {
    kind: "css-rule",
    id: "settings-responsive-stack",
    path: "pages/SettingsPage.css",
    selector: ".management-page.settings-page .settings-prefs-row,\n  .management-page.settings-page .remote-row .field-row,\n  .management-page.settings-page .settings-actions,\n  .management-page.settings-page .creds-actions",
    declarations: ["grid-template-columns: minmax(0, 1fr);", "width: 100%;"],
  },
];

// Components Gallery 对 App 只批准四个精确片段；同一片段也供保护哈希归一化复用。
const COMPONENTS_GALLERY_APP_REQUIREMENTS = [
  ["app-components-icon-import", "App.tsx", 'import componentsIcon from "./assets/nav-icons/components.svg";'],
  ["app-components-page-import", "App.tsx", 'import ComponentsPage from "./pages/ComponentsPage";'],
  ["app-components-nav-entry", "App.tsx", '{ to: "/components", labelKey: "nav.components", iconSrc: componentsIcon },'],
  ["app-components-route", "App.tsx", '<Route path="/components" element={<ComponentsPage />} />'],
];

// 归一化只删除带换行的完整 App 片段，禁止把相似 import、导航或路由一并吞掉。
const COMPONENTS_GALLERY_APP_NORMALIZATIONS = [
  ["components-icon-import", 'import componentsIcon from "./assets/nav-icons/components.svg";\n'],
  ["components-page-import", 'import ComponentsPage from "./pages/ComponentsPage";\n'],
  ["components-nav-entry", '  { to: "/components", labelKey: "nav.components", iconSrc: componentsIcon },\n'],
  ["components-route", '          <Route path="/components" element={<ComponentsPage />} />\n'],
];

// 生产组件 import 的模块、默认导出与具名导出均按 AST 精确核验。
const COMPONENTS_GALLERY_IMPORTS = [
  ["page-head", "../components/PageHead", null, ["PageHead"]],
  ["backend-tabs", "../components/BackendTabs", "BackendTabs", ["BackendId"]],
  ["backend-badge", "../components/BackendBadge", "BackendBadge", []],
  ["field-components", "../components/Field", null, ["Field", "TextInput", "TextArea", "Select", "Option", "Switch"]],
  ["modal", "../components/Modal", "Modal", ["ModalSection", "DetailRow"]],
  ["ui-hooks", "../components/ui", null, ["useToast", "useConfirm"]],
];

// return JSX 树必须真实包含这些组件；模板、注释和不可达分支都不属于该树。
const COMPONENTS_GALLERY_RENDER_COMPONENTS = [
  "PageHead",
  "Field",
  "TextInput",
  "TextArea",
  "Select",
  "Option",
  "Switch",
  "BackendTabs",
  "BackendBadge",
  "Modal",
  "ModalSection",
  "DetailRow",
];

// 受控组件的 value/checked 与 onChange 必须绑定到批准的本地状态表达式。
const COMPONENTS_GALLERY_CONTROLLED_PROPS = [
  ["text", "TextInput", [["value", "textValue"], ["onChange", "(event) => setTextValue(event.target.value)"]]],
  ["textarea", "TextArea", [["value", "textareaValue"], ["onChange", "(event) => setTextareaValue(event.target.value)"]]],
  ["select", "Select", [["value", "selectValue"], ["onChange", "setSelectValue"]]],
  ["switch", "Switch", [["checked", "switchChecked"], ["onChange", "setSwitchChecked"]]],
  ["backend", "BackendTabs", [["value", "backend"], ["onChange", "setBackend"]]],
  ["modal", "Modal", [["open", "modalOpen"], ["onClose", "() => setModalOpen(false)"]]],
];

// 页面用户可见文案必须来自这一组稳定 key；中英文 locale 的 key 集与顺序完全一致。
const COMPONENTS_GALLERY_TRANSLATION_KEYS = [
  "title",
  "subtitle",
  "buttonsTitle",
  "buttonsDescription",
  "buttonVariants",
  "primaryButton",
  "darkButton",
  "secondaryButton",
  "subtleButton",
  "dangerButton",
  "disabledButton",
  "buttonStates",
  "stateDefault",
  "stateHover",
  "statePressed",
  "buttonSizes",
  "sizeLarge",
  "sizeMedium",
  "sizeSmall",
  "sharedStyle",
  "fieldsTitle",
  "fieldsDescription",
  "textLabel",
  "textHint",
  "textDefault",
  "textareaLabel",
  "textareaHint",
  "textareaDefault",
  "selectLabel",
  "optionOpenClaw",
  "optionHermes",
  "switchLabel",
  "navigationTitle",
  "navigationDescription",
  "badgeLabel",
  "filterTabsTitle",
  "filterTabsDescription",
  "filterAll",
  "filterKanban",
  "filterCron",
  "filterSystem",
  "filterTabsScrollable",
  "filterTabsNote",
  "feedbackTitle",
  "feedbackDescription",
  "toastSuccessAction",
  "toastInfoAction",
  "toastErrorAction",
  "toastSuccessMessage",
  "toastInfoMessage",
  "toastErrorMessage",
  "confirmAction",
  "confirmTitle",
  "confirmMessage",
  "confirmAccept",
  "confirmCancel",
  "confirmIdle",
  "confirmConfirmed",
  "confirmCancelled",
  "overlaysTitle",
  "overlaysDescription",
  "openModal",
  "modalTitle",
  "modalSubtitle",
  "modalBody",
  "detailSectionTitle",
  "detailBackendLabel",
  "closeOverlay",
  "loaderTitle",
  "loaderDescription",
  "fusionLoaderName",
  "fusionLoaderLabel",
  "pingfangTitle",
  "pingfangDescription",
  "pingfangKind",
  "pingfangShared",
  "pingfangClamped",
  "pingfangVariantsTitle",
  "pingfangVariantsDescription",
  "pingfangVariantsCaveat",
  "sfTitle",
  "sfDescription",
  "sfKind",
  "unreachableTitle",
  "unreachableDescription",
  "unreachableWhy",
  "unreachableNote",
];

// LiquidGooeyDemo 是展厅内的独立生产组件，文案由它自己消费；locale 仍需与页面
// 文案一起做 exact-key 校验，但不能反向要求 ComponentsPage 直接调用这些 key。
const COMPONENTS_GALLERY_CHILD_TRANSLATION_KEYS = [
  "gooeyTitle",
  "gooeyDescription",
  "gooeyKind",
  "gooeyMorphTitle",
  "gooeyMorphHint",
  "gooeyMorphToggle",
  "gooeyMorphCreate",
  "gooeyMorphSearch",
  "gooeyMorphShare",
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
];
const COMPONENTS_GALLERY_LOCALE_KEYS = [
  ...COMPONENTS_GALLERY_TRANSLATION_KEYS,
  ...COMPONENTS_GALLERY_CHILD_TRANSLATION_KEYS,
];

// nav 与 componentsGallery 都按完整 AST property 列表校验，拒绝额外、quoted、spread 或嵌套属性。
const COMPONENTS_GALLERY_NAV_KEYS = ["clickToRefresh", "dashboard", "chat", "tasks", "cron", "token", "models", "skills", "cli", "agents", "glass", "components", "settings"];

// 分区标题在真实 return JSX 树中的源码位置固定为 Buttons → Fields → Navigation → Feedback → Overlays。
const COMPONENTS_GALLERY_SECTION_ORDER = [
  ["buttons", "buttonsTitle"],
  ["fields", "fieldsTitle"],
  ["navigation", "navigationTitle"],
  ["feedback", "feedbackTitle"],
  ["overlays", "overlaysTitle"],
];

// 展厅自身 CSS 只校验专属布局块；共享组件内部视觉仍由原 phase 保护。
const COMPONENTS_GALLERY_CSS_REQUIREMENTS = [
  ["grid", "pages/ComponentsPage.module.css", ".grid", ["display: grid;", "grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));", "gap: 24px;"]],
  ["card", "pages/ComponentsPage.module.css", ".card", ["min-width: 0;", "background: var(--ui-surface-1);", "border: 1px solid var(--ui-hairline);", "border-radius: var(--ui-radius-card);", "box-shadow: var(--ui-shadow-card);"]],
  ["sample", "pages/ComponentsPage.module.css", ".sample", ["display: flex;", "flex-wrap: wrap;", "min-width: 0;"]],
  ["actions", "pages/ComponentsPage.module.css", ".actions", ["display: flex;", "flex-wrap: wrap;"]],
  ["result", "pages/ComponentsPage.module.css", ".result", ["min-height: 20px;", "color: var(--ui-text-2);"]],
];

// SVG 必须遵循现有导航图标的 40×40 画布，并保持装饰性图标无可聚焦节点。
const COMPONENTS_GALLERY_ICON_REQUIREMENTS = [
  ["icon-svg", "assets/nav-icons/components.svg", "<svg"],
  ["icon-width", "assets/nav-icons/components.svg", 'width="40"'],
  ["icon-height", "assets/nav-icons/components.svg", 'height="40"'],
  ["icon-view-box", "assets/nav-icons/components.svg", 'viewBox="0 0 40 40"'],
  ["icon-not-focusable", "assets/nav-icons/components.svg", 'focusable="false"'],
];

// 这些文件不在批准改造范围内，任何字节变化都必须让合同失败。
const PROTECTED_HASHES = [
  // App 含外部已确认的 SetupOverlay 与菜单导航功能，以当前内容作为保护基线。
  ["protected-app", "App.tsx", "d7829968d8cd603b509f2ed4e5a63bc874895b87772599c1850cf68b68fe0eab"],
  ["protected-page-head", "components/PageHead.tsx", "dc4060e3911f8b85dc58086d470969673dbfce543db1e511ddd4c7ecc85c141d"],
  ["protected-page-head-css", "components/PageHead.module.css", "9058fa081a9cacacf222170b865a00fa15b7c083eaa3a68562039cd4ee52021d"],
  ["protected-chat", "pages/ChatPage.tsx", "dac2f51094ae223d02c2c15c34a0324a55cf3b462a3c42e0117dac08a5ae8f25"],
  ["protected-chat-css", "pages/ChatPage.css", "d61ae02e3c6dfcece97103432c0a4979a0d91937e93155c798f0824e1cba2deb"],
  ["protected-cli", "pages/CliPage.tsx", "0623b589c65f046732df60afcc8e421d24a089100be3bafa0627eea1d1e604f7"],
];

// 可改目标必须先撤销批准的机械改动，再与原始内容哈希比对。
const TARGET_HASHES = [
  ["target-field", "components/Field.tsx", "9d71508ef04fd74d4de2a24c14a4586b65d91fb54ec57625a6c880fec4064120"],
  ["target-tasks", "pages/TasksPage.tsx", "b3babbc9aba8637c4eb3a9a307ccad8308d92d05808209c5b238846dc6d1cc81"],
  ["target-cron", "pages/CronPage.tsx", "ef35f84792bee7216aa5bfdbc37c6c95a6b90df791dae6912407cf5445cad5db"],
  ["target-usage", "pages/UsagePage.tsx", "e8148baa4f0cbc4982b63f5c1fbd7b09657e14a0c4ebbaf5b808cdcfdfef84e2"],
  ["target-models", "pages/ModelsPage.tsx", "c77269bca790b3e8fa3f839efa9ce5896763144d431d78d98f64d9de6ba92027"],
  ["target-skills", "pages/SkillsPage.tsx", "4275572235cea8361763c8cd419482dbe4263ac8bb3bdc9c38e54ef2d553c605"],
  ["target-agents", "pages/AgentsPage.tsx", "a5730ccfef2ede2164e90c62888fcb8b403f3123d853f12a76123e76c1dad153"],
  ["target-settings", "pages/SettingsPage.tsx", "cd45f7cb5851a41d1b1e0b02e0772a6db7cce5810cadee85037aa8411f410ea0"],
  ["target-glass", "pages/GlassLab.tsx", "ed1c320974ea74c2f44778e6968bf586fc56fd2f2b2d7231a3404f588e26d3fd"],
];

const MANAGE_SKIN_HASH = "dd625d60d4bad4d11fc18ed7f2bb13ea1dcb2213bd2df4ce0a5231f4ae269a8e";
const KNOWN_DIRTY_HASH_ENVS = new Map([
  ["protected-chat", "MANAGE_UI_KNOWN_PROTECTED_CHAT_RAW_SHA256"],
  ["target-cron", "MANAGE_UI_KNOWN_TARGET_CRON_RAW_SHA256"],
  ["target-usage", "MANAGE_UI_KNOWN_TARGET_USAGE_RAW_SHA256"],
]);
const FAILURE = Symbol("manage-ui-design-contract-failure");

// 所有文本先规范为 LF，使 Windows checkout 与既有 LF 哈希使用同一口径。
function canonicalizeNewlines(source) {
  return source.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

// 读取任意 UTF-8 文件并统一换行；不可读时转换为稳定合同失败。
function readUtf8(filePath, id) {
  try {
    return canonicalizeNewlines(readFileSync(filePath, "utf8"));
  } catch {
    assertContract(false, id);
  }
}

// 读取管理 UI 内的相对路径，统一复用 canonical UTF-8 入口。
function readContractFile(relativePath, id) {
  return readUtf8(resolve(MANAGE_SRC, relativePath), id);
}

// 所有断言只抛内部哨兵，由入口统一输出一行稳定的失败消息。
function assertContract(condition, id) {
  if (condition) return;
  const error = new Error(id);
  error.contractFailure = FAILURE;
  throw error;
}

// 计算文本的 SHA256，避免平台命令与输出格式差异。
function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// 按批准顺序检查单文件合同；数组表示 selector 二选一，正则只用于限定同一 CSS 块内的声明。
function assertOrderedFileRequirements(prefix, requirements) {
  const cache = new Map();
  for (const [id, relativePath, expected] of requirements) {
    if (!cache.has(relativePath)) cache.set(relativePath, readContractFile(relativePath, `${prefix}:${id}:file`));
    const source = cache.get(relativePath);
    const present = Array.isArray(expected)
      ? expected.some((item) => source.includes(item))
      : expected instanceof RegExp
        ? expected.test(source)
        : source.includes(expected);
    assertContract(present, `${prefix}:${id}`);
  }
}

// 使用 TypeScript 编译器生成 AST，语法错误统一转为稳定合同 ID。
function parseTypeScript(source, fileName, id, scriptKind = ts.ScriptKind.TSX) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  assertContract(sourceFile.parseDiagnostics.length === 0, `${id}:syntax`);
  return sourceFile;
}

// 只接受未加引号的普通标识符属性，从结构上拒绝 quoted/method/spread 伪造。
function readPlainPropertyName(property) {
  return ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)
    ? property.name.text
    : null;
}

// 解开不改变值语义的括号、as 与 satisfies，便于检查真实对象或 JSX 根。
function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) current = current.expression;
  return current;
}

// 定位顶层 default export 指向的实际字典变量，不在全文搜索偶然同名文本。
function readDefaultDictionary(sourceFile, prefix) {
  const exportDefault = sourceFile.statements.find(
    (statement) => ts.isExportAssignment(statement) && !statement.isExportEquals,
  );
  assertContract(exportDefault && ts.isIdentifier(exportDefault.expression), `${prefix}:default-export`);
  const dictionaryName = exportDefault.expression.text;
  let declaration;
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    declaration = statement.declarationList.declarations.find(
      (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === dictionaryName,
    ) ?? declaration;
  }
  const initializer = declaration?.initializer && unwrapExpression(declaration.initializer);
  assertContract(initializer && ts.isObjectLiteralExpression(initializer), `${prefix}:dictionary`);
  return initializer;
}

// 核对扁平字符串对象的完整 key 顺序，额外项、展开、方法与空文案均失败。
function assertExactStringObject(object, expectedKeys, prefix) {
  const keys = object.properties.map(readPlainPropertyName);
  const expected = new Set(expectedKeys);
  assertContract(
    keys.length === expected.size && keys.every((key) => expected.has(key)),
    `${prefix}:keys`,
  );
  for (const property of object.properties) {
    assertContract(
      ts.isPropertyAssignment(property)
        && ts.isIdentifier(property.name)
        && ts.isStringLiteral(property.initializer)
        && property.initializer.text.trim().length > 0,
      `${prefix}:non-empty-copy`,
    );
  }
}

// 从实际字典对象取指定未加引号 PropertyAssignment，禁止属性形状退化。
function readDictionaryGroup(dictionary, groupName, prefix) {
  const matches = dictionary.properties.filter((property) => readPlainPropertyName(property) === groupName);
  assertContract(matches.length === 1, `${prefix}:${groupName}`);
  const initializer = matches[0]?.initializer && unwrapExpression(matches[0].initializer);
  assertContract(initializer && ts.isObjectLiteralExpression(initializer), `${prefix}:${groupName}`);
  return initializer;
}

// 统计不重叠精确片段，供 App 白名单拒绝重复 import、导航项或 Route。
function countExactOccurrences(source, fragment) {
  let count = 0;
  let cursor = 0;
  while (true) {
    const foundAt = source.indexOf(fragment, cursor);
    if (foundAt < 0) return count;
    count += 1;
    cursor = foundAt + fragment.length;
  }
}

// locale 文案组基于真实 default-export 字典 AST 校验，不会被 quoted 或 spread 属性绕过。
function validateComponentsGalleryLocaleSource(source, fileName, prefix, navValue) {
  const sourceFile = parseTypeScript(source, fileName, prefix, ts.ScriptKind.TS);
  const dictionary = readDefaultDictionary(sourceFile, prefix);
  const nav = readDictionaryGroup(dictionary, "nav", prefix);
  assertExactStringObject(nav, COMPONENTS_GALLERY_NAV_KEYS, `${prefix}:nav`);
  const navComponents = nav.properties.find((property) => readPlainPropertyName(property) === "components");
  assertContract(navComponents?.initializer?.text === navValue, `${prefix}:nav-components`);
  const gallery = readDictionaryGroup(dictionary, "componentsGallery", prefix);
  assertExactStringObject(gallery, COMPONENTS_GALLERY_LOCALE_KEYS, `${prefix}:componentsGallery`);
}

// 读取生产 locale 后复用纯 AST 入口，便于内置回归 fixture 不依赖文件状态。
function validateComponentsGalleryLocale(relativePath, navValue) {
  const prefix = `components-gallery:locale-${relativePath.endsWith("en.ts") ? "en" : "zh-CN"}`;
  const source = readContractFile(relativePath, `${prefix}:file`);
  validateComponentsGalleryLocaleSource(source, relativePath, prefix, navValue);
}

// 删除真实 CSS 注释，同时保留 quoted string 内形似注释的普通文本。
function stripCssComments(source) {
  let result = "";
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      result += char;
      if (char === "\\") {
        result += next ?? "";
        index += 1;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      result += char;
    } else if (char === "/" && next === "*") {
      const endAt = source.indexOf("*/", index + 2);
      assertContract(endAt >= 0, "css-parser:unclosed-comment");
      index = endAt + 1;
    } else {
      result += char;
    }
  }
  return result;
}

// 扫描真实规则头：每层只取上一个同层花括号之后到当前左括号前的 trim header。
function scanCssRuleBlocks(source) {
  const clean = stripCssComments(source);
  const rules = [];
  const stack = [];
  const headerStarts = [0];
  let quote = "";
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "{") {
      const depth = stack.length;
      const header = clean.slice(headerStarts[depth] ?? 0, index).trim();
      stack.push({ header, bodyAt: index + 1 });
      headerStarts[depth + 1] = index + 1;
    } else if (char === "}") {
      const frame = stack.pop();
      assertContract(!!frame, "css-parser:unexpected-close");
      rules.push({ header: frame.header, body: clean.slice(frame.bodyAt, index) });
      headerStarts[stack.length] = index + 1;
    }
  }
  assertContract(stack.length === 0, "css-parser:unclosed-block");
  return rules;
}

// 结构化查找精确 selector，供负向自测验证注释伪规则不会被识别。
function findCssBlock(source, selector) {
  return scanCssRuleBlocks(source).find((rule) => rule.header === selector)?.body ?? null;
}

// 读取精确 selector 的 brace body；selector 存在性与声明检查分离。
function readCssBlock(source, selector, id) {
  const block = findCssBlock(source, selector);
  assertContract(block !== null, id);
  return block;
}

// 从 brace body 中解析真实 property:value；引号和括号内的分号不结束声明。
function readCssDeclarations(blockBody) {
  const source = stripCssComments(blockBody);
  const declarations = new Set();
  let segmentAt = 0;
  let quote = "";
  let parenDepth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(") {
      parenDepth += 1;
    } else if (char === ")" && parenDepth > 0) {
      parenDepth -= 1;
    } else if (parenDepth === 0 && (char === "{" || char === "}")) {
      segmentAt = index + 1;
    } else if (parenDepth === 0 && char === ";") {
      const raw = source.slice(segmentAt, index).trim();
      const colonAt = raw.indexOf(":");
      if (colonAt > 0) {
        const property = raw.slice(0, colonAt).trim();
        const value = raw.slice(colonAt + 1).trim();
        if (/^(?:--)?[a-zA-Z][a-zA-Z0-9-]*$/.test(property) && value) {
          declarations.add(`${property}: ${value};`);
        }
      }
      segmentAt = index + 1;
    }
  }
  return declarations;
}

// 逐项读取 selector block，只用真实声明核对批准 needle，并支持禁止退回无条件动效。
function assertOrderedCssRequirements(prefix, requirements) {
  const cache = new Map();
  for (const [id, relativePath, selector, declarations, properties = [], forbiddenProperties = []] of requirements) {
    if (!cache.has(relativePath)) cache.set(relativePath, readContractFile(relativePath, `${prefix}:${id}:file`));
    const block = readCssBlock(cache.get(relativePath), selector, `${prefix}:${id}`);
    const parsed = readCssDeclarations(block);
    for (const needle of declarations) assertContract(parsed.has(needle), `${prefix}:${id}`);
    for (const property of properties) {
      assertContract([...parsed].some((declaration) => declaration.startsWith(`${property}: `)), `${prefix}:${id}`);
    }
    for (const property of forbiddenProperties) {
      assertContract(![...parsed].some((declaration) => declaration.startsWith(`${property}: `)), `${prefix}:${id}`);
    }
  }
}

// 统一分派页面合同：CSS 只能走结构化规则，raw includes 只允许非 CSS 文本。
function assertOrderedRequirements(prefix, requirements) {
  const cache = new Map();
  for (const requirement of requirements) {
    if (!cache.has(requirement.path)) {
      cache.set(requirement.path, readContractFile(requirement.path, `${prefix}:${requirement.id}:file`));
    }
    const source = cache.get(requirement.path);
    if (requirement.kind === "text") {
      assertContract(!requirement.path.endsWith(".css") && source.includes(requirement.expected), `${prefix}:${requirement.id}`);
      continue;
    }
    if (requirement.kind === "css-rule-any") {
      assertContract(requirement.selectors.some((selector) => findCssBlock(source, selector) !== null), `${prefix}:${requirement.id}`);
      continue;
    }
    assertContract(requirement.kind === "css-rule", `${prefix}:${requirement.id}:kind`);
    const block = readCssBlock(source, requirement.selector, `${prefix}:${requirement.id}`);
    const parsed = readCssDeclarations(block);
    for (const declaration of requirement.declarations ?? []) {
      assertContract(parsed.has(declaration), `${prefix}:${requirement.id}`);
    }
  }
}

// 内建解析器回归：注释伪声明不能命中，引号和函数括号内分号必须保留。
function validateCssDeclarationParser() {
  const fakeSelector = '/* .tabs { height: 48px; } */ .real { height: 48px; }';
  assertContract(findCssBlock(fakeSelector, ".tabs") === null, "css-parser:comment-selector-false-positive");
  const source = '.tabs { /* height: 48px; */ min-height: 48px; content: "height: 48px; x;y"; background: fn("a;b"); width: 1px; }';
  const parsed = readCssDeclarations(readCssBlock(source, ".tabs", "css-parser:self-test"));
  assertContract(!parsed.has("height: 48px;"), "css-parser:comment-false-positive");
  assertContract(parsed.has("min-height: 48px;"), "css-parser:min-height-real");
  assertContract(parsed.has('content: "height: 48px; x;y";'), "css-parser:quoted-semicolon");
  assertContract(parsed.has('background: fn("a;b");'), "css-parser:paren-semicolon");
  assertContract(parsed.has("width: 1px;"), "css-parser:real-declaration");
}

// 每个 phase 都重检 styles 旧变量与 manage-skin 四个不可 alias 的固定值。
function validateLegacyAndFixedDeclarations() {
  const styles = readContractFile("styles.css", "tokens:styles-file");
  const stylesRoot = readCssDeclarations(readCssBlock(styles, ":root", "tokens:styles-root"));
  for (const [id, declaration] of LEGACY_TOKEN_REQUIREMENTS) assertContract(stylesRoot.has(declaration), `tokens:${id}`);
  const skin = readContractFile("manage-skin.css", "tokens:manage-skin-file");
  const root = readCssDeclarations(readCssBlock(skin, ":root", "tokens:manage-skin-root"));
  for (const [id, declaration] of MANAGE_SKIN_FIXED_REQUIREMENTS) assertContract(root.has(declaration), `tokens:${id}`);
}

// 检查新 token、兼容 alias 与页面结构锚点。
function validateTokens() {
  const styles = readContractFile("styles.css", "tokens:styles-file");
  const stylesRoot = readCssDeclarations(readCssBlock(styles, ":root", "tokens:styles-root"));
  for (const [id, declaration] of TOKEN_REQUIREMENTS) assertContract(stylesRoot.has(declaration), `tokens:${id}`);

  const skin = readContractFile("manage-skin.css", "tokens:manage-skin-file");
  const root = readCssDeclarations(readCssBlock(skin, ":root", "tokens:manage-skin-root"));
  for (const [id, declaration] of ALIAS_REQUIREMENTS) assertContract(root.has(declaration), `tokens:${id}`);
  for (const [id, marker] of STYLE_MARKER_REQUIREMENTS) assertContract(skin.includes(marker), `tokens:${id}`);
  assertOrderedCssRequirements("tokens", STYLE_RULE_REQUIREMENTS);
  validateLegacyAndFixedDeclarations();
}

// 验证七个普通页面的精确根 class；Glass 由 pages-shell 独立验证。
function validateRootClasses() {
  for (const [relativePath, id, expected] of ROOT_CLASS_REQUIREMENTS) {
    const source = readContractFile(relativePath, `roots:${id}:file`);
    assertContract(source.includes(expected), `roots:${id}`);
  }
}

// 把 Markdown 严格拆成 frontmatter 与正文，禁止跨区域的偶然文本命中合同。
function splitDesignDocument(document) {
  assertContract(document.startsWith("---\n"), "design-doc:frontmatter-open");
  const closingAt = document.indexOf("\n---\n", 4);
  assertContract(closingAt >= 0, "design-doc:frontmatter-close");
  return {
    frontmatter: document.slice(4, closingAt),
    body: document.slice(closingAt + 5),
  };
}

// 设计文档是规格真相；frontmatter key/value、章节标题与 CSS block 均逐字验证。
function validateDesignDocument() {
  if (!HAS_LOCAL_DESIGN_DOCUMENT) return;
  const document = readUtf8(DESIGN_PATH, "design-doc:file");
  const { frontmatter, body } = splitDesignDocument(document);
  const frontmatterLines = new Set(frontmatter.split("\n"));
  const bodyLines = new Set(body.split("\n"));
  for (const [id, exactLine] of DESIGN_FRONTMATTER_REQUIREMENTS) {
    assertContract(frontmatterLines.has(exactLine), `design-doc:frontmatter-${id}`);
  }
  for (const heading of DESIGN_BODY_HEADINGS) {
    const id = heading.replace(/^#+\s*/, "").toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    assertContract(bodyLines.has(heading), `design-doc:heading-${id}`);
  }
  for (const [, declaration] of TOKEN_REQUIREMENTS) {
    const tokenName = declaration.slice(0, declaration.indexOf(":"));
    assertContract(body.includes(declaration), `design-doc:css-${tokenName.slice(2)}`);
  }
}

// 返回 import 的默认/具名绑定，合同只读取真实 ImportDeclaration，不扫描注释或模板文本。
function readImportBindings(sourceFile, modulePath) {
  const imports = sourceFile.statements.filter(
    (statement) => ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === modulePath,
  );
  assertContract(imports.length === 1, `components-gallery:import-module-${modulePath}`);
  const clause = imports[0].importClause;
  const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
    ? clause.namedBindings.elements.map((element) => element.name.text)
    : [];
  return { defaultName: clause?.name?.text ?? null, named };
}

// 只接受顶层 `export default function ComponentsPage`，避免未调用函数中的伪 JSX 通过合同。
function readComponentsPageFunction(sourceFile) {
  const matches = sourceFile.statements.filter(
    (statement) => ts.isFunctionDeclaration(statement)
      && statement.name?.text === "ComponentsPage"
      && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
      && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
  assertContract(matches.length === 1 && matches[0].body, "components-gallery:default-component");
  return matches[0];
}

// 页面只允许一个直接 return；只遍历该 JSX 树，不把嵌套 helper 或不可达分支当作实现。
function readComponentsPageReturn(component) {
  const returns = component.body.statements.filter(ts.isReturnStatement);
  assertContract(returns.length === 1 && returns[0].expression, "components-gallery:direct-return");
  return unwrapExpression(returns[0].expression);
}

// 深度遍历一个 AST 子树并保留源码顺序，供 JSX、翻译 key 与禁止调用共用。
function walkTypeScript(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walkTypeScript(child, visit));
}

// 对常见编译期常量求真假；未知返回 null，调用方才保守遍历两侧。
function readStaticTruthiness(node) {
  const current = unwrapExpression(node);
  if (current.kind === ts.SyntaxKind.FalseKeyword || current.kind === ts.SyntaxKind.NullKeyword) return false;
  if (current.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (ts.isIdentifier(current) && current.text === "undefined") return false;
  if (ts.isNumericLiteral(current)) return Number(current.text) !== 0;
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) return current.text.length > 0;
  if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = readStaticTruthiness(current.operand);
    return operand === null ? null : !operand;
  }
  return null;
}

// null/undefined 的 ?? 左值可静态确定；其他已知字面量都属于非 nullish。
function readStaticNullish(node) {
  const current = unwrapExpression(node);
  if (current.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(current) && current.text === "undefined") return true;
  if (
    current.kind === ts.SyntaxKind.TrueKeyword
    || current.kind === ts.SyntaxKind.FalseKeyword
    || ts.isNumericLiteral(current)
    || ts.isStringLiteral(current)
    || ts.isNoSubstitutionTemplateLiteral(current)
  ) return false;
  return null;
}

// 遍历可达 JSX：处理 &&、||、?? 与常量条件，拒绝用编译期不可达组件伪造展厅。
function walkReachableJsx(node, visit) {
  visit(node);
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken) {
      walkReachableJsx(node.left, visit);
      const left = readStaticTruthiness(node.left);
      if ((operator === ts.SyntaxKind.AmpersandAmpersandToken && left !== false)
        || (operator === ts.SyntaxKind.BarBarToken && left !== true)) walkReachableJsx(node.right, visit);
      return;
    }
    if (operator === ts.SyntaxKind.QuestionQuestionToken) {
      walkReachableJsx(node.left, visit);
      if (readStaticNullish(node.left) !== false) walkReachableJsx(node.right, visit);
      return;
    }
  }
  if (ts.isConditionalExpression(node)) {
    walkReachableJsx(node.condition, visit);
    const condition = readStaticTruthiness(node.condition);
    if (condition === true) walkReachableJsx(node.whenTrue, visit);
    else if (condition === false) walkReachableJsx(node.whenFalse, visit);
    else {
      walkReachableJsx(node.whenTrue, visit);
      walkReachableJsx(node.whenFalse, visit);
    }
    return;
  }
  ts.forEachChild(node, (child) => walkReachableJsx(child, visit));
}

// 读取 JSX 标签名与属性；属性表达式折叠空白后做精确受控绑定比较。
function collectJsxElements(root, sourceFile) {
  const elements = [];
  walkReachableJsx(root, (node) => {
    const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    if (!opening) return;
    const attributes = new Map();
    for (const property of opening.attributes.properties) {
      if (!ts.isJsxAttribute(property) || !ts.isIdentifier(property.name)) continue;
      const initializer = property.initializer;
      const value = initializer && ts.isJsxExpression(initializer) && initializer.expression
        ? initializer.expression.getText(sourceFile).replace(/\s+/g, " ").trim()
        : initializer && ts.isStringLiteral(initializer) ? initializer.text : initializer ? initializer.getText(sourceFile) : "true";
      attributes.set(property.name.text, value);
    }
    elements.push({ name: opening.tagName.getText(sourceFile), attributes, node: opening });
  });
  return elements;
}

// 目标组件的 useState/hooks/handler 必须位于函数直接 body，而不是不可达嵌套函数。
function validateComponentsGalleryLocalState(component, sourceFile) {
  const bodyText = component.body.statements.map((statement) => statement.getText(sourceFile).replace(/\s+/g, " ").trim());
  const requirements = [
    ["text-default", 'const [textValue, setTextValue] = useState(() => t("componentsGallery.textDefault"));'],
    ["textarea-default", 'const [textareaValue, setTextareaValue] = useState(() => t("componentsGallery.textareaDefault"));'],
    ["select-default", 'const [selectValue, setSelectValue] = useState("openclaw");'],
    ["switch-default", "const [switchChecked, setSwitchChecked] = useState(true);"],
    ["backend-default", 'const [backend, setBackend] = useState<BackendId>("openclaw");'],
    ["modal-state", "const [modalOpen, setModalOpen] = useState(false);"],
    ["confirm-state", 'const [confirmResult, setConfirmResult] = useState<"confirmed" | "cancelled" | null>(null);'],
    ["toast-hook", "const toast = useToast();"],
    ["confirm-hook", "const confirm = useConfirm();"],
  ];
  for (const [id, expected] of requirements) {
    assertContract(bodyText.includes(expected), `components-gallery:state-${id}`);
  }
  const confirmHandler = bodyText.find((text) => text.startsWith("const handleConfirm = async")) ?? "";
  assertContract(confirmHandler.includes("const confirmed = await confirm({"), "components-gallery:confirm-awaited");
  assertContract(confirmHandler.includes('setConfirmResult(confirmed ? "confirmed" : "cancelled");'), "components-gallery:confirm-result");
  let handlerNode;
  for (const statement of component.body.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declaration = statement.declarationList.declarations.find(
      (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === "handleConfirm",
    );
    if (declaration?.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
      handlerNode = declaration.initializer;
    }
  }
  assertContract(handlerNode, "components-gallery:confirm-handler-node");
  return handlerNode;
}

// 所有生产共享组件必须位于真实 return JSX，并绑定批准的受控 state/handler。
function validateComponentsGalleryJsx(root, sourceFile) {
  const elements = collectJsxElements(root, sourceFile);
  const names = new Set(elements.map((element) => element.name));
  for (const name of COMPONENTS_GALLERY_RENDER_COMPONENTS) {
    assertContract(names.has(name), `components-gallery:render-${name}`);
  }
  const rootElement = elements[0];
  assertContract(
    rootElement?.name === "div"
      && rootElement.attributes.get("className") === "`page management-page components-page ${styles.pageRoot}`",
    "components-gallery:root",
  );
  for (const [id, componentName, props] of COMPONENTS_GALLERY_CONTROLLED_PROPS) {
    const candidates = elements.filter((element) => element.name === componentName);
    const matched = candidates.some((element) => props.every(([name, value]) => element.attributes.get(name) === value));
    assertContract(matched, `components-gallery:controlled-${id}`);
  }
  const confirmTrigger = elements.some(
    (element) => element.name === "button" && element.attributes.get("onClick") === "handleConfirm",
  );
  assertContract(confirmTrigger, "components-gallery:confirm-trigger");
}

// 可见表达式允许完整 t(...)；其他表达式中的字符串、模板片段与拼接文本都视为硬编码。
function expressionContainsVisibleText(node) {
  let current = node;
  if (ts.isJsxExpression(current)) current = current.expression;
  if (!current) return false;
  current = unwrapExpression(current);
  if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === "t") return false;
  // map 回调里的 JSX 会由 walkReachableJsx 自己逐节点检查；这里若递归整个回调，
  // style.fontFamily 等非文案字符串会被误判为可见硬编码。
  if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)
    && current.expression.name.text === "map") return false;
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    if (
      ts.isBinaryExpression(current.parent)
      && [
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ].includes(current.parent.operatorToken.kind)
    ) return false;
    return /[A-Za-z\u3400-\u9fff]/.test(current.text);
  }
  if (ts.isTemplateExpression(current)) {
    if (/[A-Za-z\u3400-\u9fff]/.test(current.head.text)) return true;
    if (current.templateSpans.some((span) => /[A-Za-z\u3400-\u9fff]/.test(span.literal.text))) return true;
  }
  let found = false;
  ts.forEachChild(current, (child) => {
    if (!found && expressionContainsVisibleText(child)) found = true;
  });
  return found;
}

// 检测真实 return JSX 中的文本、表达式 children、可见属性与对话框 option 字面量。
function hasHardcodedVisibleCopy(root) {
  const visibleAttributes = new Set(["aria-label", "title", "subtitle", "label", "hint", "placeholder", "message", "confirmLabel", "cancelLabel"]);
  let found = false;
  walkReachableJsx(root, (node) => {
    if (ts.isJsxText(node) && /[A-Za-z\u3400-\u9fff]/.test(node.text.trim())) found = true;
    if (
      ts.isJsxExpression(node)
      && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
      && expressionContainsVisibleText(node)
    ) found = true;
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && visibleAttributes.has(node.name.text)) {
      if (node.initializer && expressionContainsVisibleText(node.initializer)) found = true;
    }
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && visibleAttributes.has(node.name.text)) {
      if (expressionContainsVisibleText(node.initializer)) found = true;
    }
  });
  return found;
}

// 页面翻译、分区顺序、可见文案与纯本地边界只读取真实 return 与已绑定 Confirm handler。
function validateComponentsGalleryFunction(component, root, confirmHandler) {
  const usedKeys = [];
  const sectionKeys = [];
  const forbiddenIdentifiers = new Set(["fetch", "XMLHttpRequest", "localStorage", "sessionStorage"]);
  const collectBehavior = (node, collectSections) => {
    if (ts.isIdentifier(node)) {
      assertContract(!forbiddenIdentifiers.has(node.text), `components-gallery:forbidden-${node.text}`);
    }
    if (ts.isStringLiteral(node)) assertContract(!node.text.includes("api/"), "components-gallery:forbidden-api-slash");
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t") {
      const argument = node.arguments[0];
      if (argument) walkTypeScript(argument, (candidate) => {
        if (!ts.isStringLiteral(candidate) || !candidate.text.startsWith("componentsGallery.")) return;
        const key = candidate.text.slice("componentsGallery.".length);
        usedKeys.push(key);
        if (collectSections && key.endsWith("Title")) sectionKeys.push(key);
      });
    }
  };
  walkReachableJsx(root, (node) => collectBehavior(node, true));
  walkTypeScript(confirmHandler, (node) => collectBehavior(node, false));
  // 固定 demo 文案位于直接 useState 初值，同样属于组件挂载时的可达数据流。
  for (const statement of component.body.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (
        initializer
        && ts.isCallExpression(initializer)
        && ts.isIdentifier(initializer.expression)
        && initializer.expression.text === "useState"
      ) walkTypeScript(initializer, (node) => collectBehavior(node, false));
    }
  }
  // 函数级禁用项仍全量扫描，连不可达网络/Storage 代码也不能进入纯本地展厅。
  walkTypeScript(component, (node) => {
    if (ts.isIdentifier(node)) {
      assertContract(!forbiddenIdentifiers.has(node.text), `components-gallery:forbidden-${node.text}`);
    }
    if (ts.isStringLiteral(node)) assertContract(!node.text.includes("api/"), "components-gallery:forbidden-api-slash");
  });
  const usedKeySet = new Set(usedKeys);
  for (const key of COMPONENTS_GALLERY_TRANSLATION_KEYS) {
    assertContract(usedKeySet.has(key), `components-gallery:page-i18n-${key}`);
  }
  for (const key of usedKeySet) {
    assertContract(COMPONENTS_GALLERY_TRANSLATION_KEYS.includes(key), `components-gallery:page-i18n-unapproved-${key}`);
  }
  const expectedSections = COMPONENTS_GALLERY_SECTION_ORDER.map(([, key]) => key);
  const actualSections = sectionKeys.filter((key) => expectedSections.includes(key));
  assertContract(
    actualSections.length === expectedSections.length && actualSections.every((key, index) => key === expectedSections[index]),
    "components-gallery:section-order",
  );
  assertContract(
    !hasHardcodedVisibleCopy(root) && !hasHardcodedVisibleCopy(confirmHandler),
    "components-gallery:hardcoded-visible-copy",
  );
}

// 解析生产页面并把 import、直接 state、return JSX 与本地边界串成一个 AST 合同。
function validateComponentsGalleryPage(source) {
  const sourceFile = parseTypeScript(source, "ComponentsPage.tsx", "components-gallery:page");
  for (const [id, modulePath, defaultName, namedNames] of COMPONENTS_GALLERY_IMPORTS) {
    const bindings = readImportBindings(sourceFile, modulePath);
    assertContract(bindings.defaultName === defaultName, `components-gallery:import-${id}-default`);
    assertContract(
      bindings.named.length === namedNames.length && bindings.named.every((name, index) => name === namedNames[index]),
      `components-gallery:import-${id}-named`,
    );
  }
  const component = readComponentsPageFunction(sourceFile);
  const root = readComponentsPageReturn(component);
  const confirmHandler = validateComponentsGalleryLocalState(component, sourceFile);
  validateComponentsGalleryJsx(root, sourceFile);
  validateComponentsGalleryFunction(component, root, confirmHandler);
}

// 内置负例锁住三类已发现绕过：模板注释、不可达 JSX 与 locale 额外属性。
function validateComponentsGalleryAstFixtures() {
  const template = parseTypeScript('const fake = `${/* import PageHead */ ""}`; export default function ComponentsPage(){ return <div />; }', "template.tsx", "fixture:template");
  assertContract(
    !template.statements.some((statement) => ts.isImportDeclaration(statement)),
    "fixture:template-comment-import",
  );
  const unreachable = parseTypeScript('function decoy(){ return <PageHead />; } export default function ComponentsPage(){ return <div>{false && <PageHead />}{0 && <Modal />}{true || <Drawer />}{0 ? <Field /> : null}</div>; }', "unreachable.tsx", "fixture:unreachable");
  const unreachableRoot = readComponentsPageReturn(readComponentsPageFunction(unreachable));
  assertContract(
    !collectJsxElements(unreachableRoot, unreachable).some((element) => ["PageHead", "Modal", "Drawer", "Field"].includes(element.name)),
    "fixture:unreachable-jsx",
  );
  const hardcoded = parseTypeScript('export default function ComponentsPage(){ return <div>{"Hardcoded"}<span aria-label={"Hardcoded"} /></div>; }', "hardcoded.tsx", "fixture:hardcoded");
  const hardcodedRoot = readComponentsPageReturn(readComponentsPageFunction(hardcoded));
  assertContract(hasHardcodedVisibleCopy(hardcodedRoot), "fixture:hardcoded-not-detected");
  const hardcodedDynamic = parseTypeScript('export default function ComponentsPage(){ const name="x"; return <div>{`Hardcoded ${name}`}<span aria-label={"Hard" + "coded"} /></div>; }', "hardcoded-dynamic.tsx", "fixture:hardcoded-dynamic");
  const hardcodedDynamicRoot = readComponentsPageReturn(readComponentsPageFunction(hardcodedDynamic));
  assertContract(hasHardcodedVisibleCopy(hardcodedDynamicRoot), "fixture:hardcoded-dynamic-not-detected");
  const locale = parseTypeScript('const dict = { nav: { a: "A", extra: "X" } }; export default dict;', "locale.ts", "fixture:locale", ts.ScriptKind.TS);
  const nav = readDictionaryGroup(readDefaultDictionary(locale, "fixture:locale"), "nav", "fixture:locale");
  let rejected = false;
  try {
    assertExactStringObject(nav, ["a"], "fixture:locale-extra");
  } catch (error) {
    rejected = error?.contractFailure === FAILURE;
  }
  assertContract(rejected, "fixture:locale-extra-not-rejected");
}

// Components Gallery 合同覆盖 App 接线、真实共享组件、本地交互、i18n、响应式 CSS 与 40×40 图标。
function validateComponentsGallery() {
  assertOrderedFileRequirements("components-gallery", COMPONENTS_GALLERY_APP_REQUIREMENTS);
  validateComponentsGalleryPage(readContractFile("pages/ComponentsPage.tsx", "components-gallery:page-file"));
  validateComponentsGalleryLocale("i18n/locales/zh-CN.ts", "组件");
  validateComponentsGalleryLocale("i18n/locales/en.ts", "Components");

  assertOrderedCssRequirements("components-gallery", COMPONENTS_GALLERY_CSS_REQUIREMENTS);
  const css = readContractFile("pages/ComponentsPage.module.css", "components-gallery:css-file");
  const responsive = readCssBlock(css, "@media (max-width: 720px)", "components-gallery:css-responsive-720");
  const responsiveGrid = readCssDeclarations(readCssBlock(responsive, ".grid", "components-gallery:css-responsive-grid"));
  assertContract(responsiveGrid.has("grid-template-columns: minmax(0, 1fr);"), "components-gallery:css-responsive-grid");
  assertContract(responsiveGrid.has("width: 100%;"), "components-gallery:css-responsive-grid");
  const reduced = readCssBlock(css, "@media (prefers-reduced-motion: reduce)", "components-gallery:css-reduced-motion");
  const reducedCard = readCssDeclarations(readCssBlock(reduced, ".card", "components-gallery:css-reduced-card"));
  assertContract(reducedCard.has("transition: none;"), "components-gallery:css-reduced-card");
  assertOrderedFileRequirements("components-gallery", COMPONENTS_GALLERY_ICON_REQUIREMENTS);
}

// 返回指定位置恰好一个换行符的长度，兼容 LF/CRLF 且绝不吞额外空白。
function lineEndingLengthAt(source, index) {
  if (source.startsWith("\r\n", index)) return 2;
  if (source.startsWith("\n", index)) return 1;
  return 0;
}

// 删除批准 marker 及 end 后一个换行，逐字反转 alias，并核对完整根块基线。
function normalizeManageSkin(source) {
  const start = "/* management-page:start */";
  const end = "/* management-page:end */";
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end);
  if (startAt >= 0 || endAt >= 0) {
    assertContract(startAt >= 0 && endAt > startAt, "normalize:manage-skin-markers");
    const afterEnd = endAt + end.length;
    const lineEndingLength = lineEndingLengthAt(source, afterEnd);
    source = `${source.slice(0, startAt)}${source.slice(afterEnd + lineEndingLength)}`;
  }
  for (const [alias, original] of MANAGE_SKIN_ALIAS_REVERSALS) source = source.replace(alias, original);
  const firstRoot = source.match(/:root\s*\{[^}]*\}/)?.[0];
  assertContract(firstRoot === MANAGE_SKIN_ORIGINAL_ROOT, "normalize:manage-skin-root");
  return source.replace(MANAGE_SKIN_ORIGINAL_ROOT, "/* ROOT */");
}

// 只撤销批准的精确 root class，拒绝模糊替换扩大改动白名单。
function normalizeRootClass(source, relativePath) {
  const replacements = new Map([
    ["pages/TasksPage.tsx", ['className="page management-page tasks-page"', 'className="page tasks-page"']],
    ["pages/CronPage.tsx", ['className="cron-page management-page"', 'className="cron-page"']],
    ["pages/UsagePage.tsx", ['className="page management-page usage-page"', 'className="page usage-page"']],
    ["pages/ModelsPage.tsx", ['className="page management-page models-page"', 'className="page"']],
    ["pages/SkillsPage.tsx", ['className="page management-page skills-page"', 'className="page"']],
    ["pages/AgentsPage.tsx", ['className="page management-page agents-page"', 'className="page agents-page"']],
    ["pages/SettingsPage.tsx", ['className="page management-page settings-page"', 'className="page settings-page"']],
  ]);
  const replacement = replacements.get(relativePath);
  return replacement && source.includes(replacement[0]) ? source.replace(replacement[0], replacement[1]) : source;
}

// Usage 只删除批准的 exact 注释与 matchMedia 分支，不接受任意 marker 范围。
function normalizeUsageMotion(source) {
  return source.replace(USAGE_REDUCED_MOTION_BLOCK, "");
}

// Skills 只允许把复用的 model class 改成页面专属 class。
function normalizeSkillsClasses(source) {
  return source
    .replaceAll('className="skill-group-head"', 'className="model-group-head"')
    .replaceAll('className="skill-category"', 'className="model-provider"');
}

// Field 只反转 invalid 参数、类型与 Trigger 语义；批准中文注释也按整行精确删除。
function normalizeField(source) {
  source = source.replace(
    "  children,\n  disabled,\n  invalid,\n}: {",
    "  children,\n  disabled,\n}: {",
  );
  source = source.replace("  disabled?: boolean;\n  invalid?: boolean;", "  disabled?: boolean;");
  return source.replace(FIELD_TRIGGER_INVALID_SNIPPET, FIELD_TRIGGER_BASELINE);
}

// Glass 只允许共享 PageHead import、精确根 class 与旧 header 替换。
function normalizeGlass(source) {
  source = source.replace('import { PageHead } from "../components/PageHead";\n', "");
  source = source.replace('className={`page management-page ${styles.lab}`}', "className={styles.lab}");
  return source.replace(GLASS_PAGE_HEAD, GLASS_OLD_HEADER);
}

// App 仍以原 protected hash 为真相：全无 Gallery 片段时允许旧基线；一旦出现则四项都须各命中一次。
// 这里只删除两个 import、一个导航项和一个 Route，任何变形、重复或其他 App 字节变化都会继续触发保护失败。
function normalizeAppComponentsGallery(source) {
  const counts = COMPONENTS_GALLERY_APP_NORMALIZATIONS.map(([, fragment]) => countExactOccurrences(source, fragment));
  if (counts.every((count) => count === 0)) return source;
  for (let index = 0; index < counts.length; index += 1) {
    const [id] = COMPONENTS_GALLERY_APP_NORMALIZATIONS[index];
    assertContract(counts[index] === 1, `normalize:app-components-gallery:${id}`);
  }
  for (const [, fragment] of COMPONENTS_GALLERY_APP_NORMALIZATIONS) source = source.replace(fragment, "");
  return source;
}

// 按文件应用最窄的批准归一化规则，未列出的变化会保留并触发哈希失败。
function normalizeTarget(source, relativePath) {
  source = normalizeRootClass(source, relativePath);
  if (relativePath === "components/Field.tsx") source = normalizeField(source);
  if (relativePath === "pages/UsagePage.tsx") source = normalizeUsageMotion(source);
  if (relativePath === "pages/SkillsPage.tsx") source = normalizeSkillsClasses(source);
  if (relativePath === "pages/GlassLab.tsx") source = normalizeGlass(source);
  return source;
}

function normalizeProtected(source, id) {
  return id === "protected-app" ? normalizeAppComponentsGallery(source) : source;
}

// hash-only 是脏工作区诊断入口：每个文件延迟读取与归一化，单项失败不会截断后续哈希。
function hashOnlyEntries() {
  return [
    ...(HAS_LOCAL_DESIGN_DOCUMENT ? [{
      id: "design-doc",
      filePath: DESIGN_PATH,
      expectedHash: DESIGN_HASH,
      normalize: (source) => source,
    }] : []),
    ...PROTECTED_HASHES.map(([id, relativePath, expectedHash]) => ({
      id,
      filePath: resolve(MANAGE_SRC, relativePath),
      expectedHash,
      normalize: (source) => normalizeProtected(source, id),
    })),
    ...TARGET_HASHES.map(([id, relativePath, expectedHash]) => ({
      id,
      filePath: resolve(MANAGE_SRC, relativePath),
      expectedHash,
      normalize: (source) => normalizeTarget(source, relativePath),
    })),
    {
      id: "manage-skin",
      filePath: resolve(MANAGE_SRC, "manage-skin.css"),
      expectedHash: MANAGE_SKIN_HASH,
      normalize: normalizeManageSkin,
    },
  ];
}

// 仅供 hash-only 识别“官方常量已滞后，但当前 tracked 文件自 HEAD 起没有改动”。
// 参数化调用 git，不经 shell 拼接路径；HEAD/index 缺失、untracked 或 git 错误均不会降级为 PASS。
function readGitBlob(ref, filePath) {
  const repoPath = relative(ROOT, filePath);
  const objectName = ref === ":" ? `:${repoPath}` : `${ref}:${repoPath}`;
  const result = spawnSync("git", ["show", objectName], {
    cwd: ROOT,
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) return null;
  return result.stdout;
}

function runHashOnly() {
  const acceptedEnvNames = new Set(KNOWN_DIRTY_HASH_ENVS.values());
  const unknownEnvNames = Object.keys(process.env)
    .filter((name) => name.startsWith("MANAGE_UI_KNOWN_") && !acceptedEnvNames.has(name))
    .sort();
  let failed = unknownEnvNames.length;
  let passed = 0;
  let knownDirty = 0;

  for (const name of unknownEnvNames) {
    console.log(`[manage-ui-design] FAIL env:${name} — unsupported known-dirty override`);
  }

  for (const entry of hashOnlyEntries()) {
    try {
      const rawSource = readFileSync(entry.filePath);
      const source = canonicalizeNewlines(rawSource.toString("utf8"));
      const rawHash = sha256(rawSource);
      const normalizedHash = sha256(entry.normalize(source));
      if (normalizedHash === entry.expectedHash) {
        passed += 1;
        console.log(`[manage-ui-design] PASS hash:${entry.id} sha256=${normalizedHash}`);
        continue;
      }

      const envName = KNOWN_DIRTY_HASH_ENVS.get(entry.id);
      if (envName && process.env[envName] === rawHash) {
        knownDirty += 1;
        console.log(
          `[manage-ui-design] KNOWN DIRTY hash:${entry.id} raw=${rawHash} normalized=${normalizedHash} expected=${entry.expectedHash}`,
        );
        continue;
      }

      // 两个本轮更新的保护基线必须命中官方常量，不允许借 index 回退。
      const requiresOfficialHash = entry.id === "protected-app" || entry.id === "protected-chat-css";
      // 三个既有脏文件只能由对应 env 精确授权，同样不走 Git 回退。
      if (!requiresOfficialHash && !envName) {
        const indexSource = readGitBlob(":", entry.filePath);
        const headSource = readGitBlob("HEAD", entry.filePath);
        if (
          indexSource
          && headSource
          && rawSource.equals(indexSource)
          && indexSource.equals(headSource)
        ) {
          passed += 1;
          console.log(
            `[manage-ui-design] PASS hash:${entry.id} (unchanged from index and HEAD; stale official baseline) raw=${rawHash} normalized=${normalizedHash} expected=${entry.expectedHash}`,
          );
          continue;
        }
      }

      failed += 1;
      console.log(
        `[manage-ui-design] FAIL hash:${entry.id} raw=${rawHash} normalized=${normalizedHash} expected=${entry.expectedHash}`,
      );
    } catch (error) {
      failed += 1;
      const detail = error?.contractFailure === FAILURE ? error.message : "unreadable-or-invalid";
      console.log(`[manage-ui-design] FAIL hash:${entry.id} — ${detail}`);
    }
  }

  console.log(`[manage-ui-design] HASH SUMMARY pass=${passed} known-dirty=${knownDirty} fail=${failed}`);
  if (failed > 0) {
    const error = new Error("hash-only");
    error.contractFailure = FAILURE;
    throw error;
  }
}

// 校验保护文件、目标文件白名单以及 manage-skin 的归一化基线。
function validateHashes() {
  validateLegacyAndFixedDeclarations();
  if (HAS_LOCAL_DESIGN_DOCUMENT) {
    assertContract(sha256(readUtf8(DESIGN_PATH, "hash:design-doc:file")) === DESIGN_HASH, "hash:design-doc");
  }
  for (const [id, relativePath, expectedHash] of PROTECTED_HASHES) {
    const source = readContractFile(relativePath, `${id}:file`);
    // 只有 protected-app 应用 Components Gallery 四片段白名单，其余保护文件仍逐字哈希。
    const normalized = normalizeProtected(source, id);
    assertContract(sha256(normalized) === expectedHash, `hash:${id}`);
  }
  for (const [id, relativePath, expectedHash] of TARGET_HASHES) {
    const source = readContractFile(relativePath, `${id}:file`);
    assertContract(sha256(normalizeTarget(source, relativePath)) === expectedHash, `hash:${id}`);
  }
  const skin = readContractFile("manage-skin.css", "hash:manage-skin:file");
  assertContract(sha256(normalizeManageSkin(skin)) === MANAGE_SKIN_HASH, "hash:manage-skin");
}

// 执行单个 phase 的视觉合同，哈希边界由外层在视觉断言之后统一执行。
function runVisualPhase(phase) {
  if (phase === "tokens") {
    validateTokens();
    validateRootClasses();
    validateDesignDocument();
    return;
  }
  if (phase === "components-fields") {
    assertOrderedCssRequirements("components-fields", FIELD_CSS_REQUIREMENTS);
    assertOrderedCssRequirements("components-fields", NATIVE_FIELD_CSS_REQUIREMENTS);
    assertOrderedFileRequirements("components-fields", FIELD_FILE_REQUIREMENTS);
    return;
  }
  if (phase === "components-overlays") {
    assertOrderedCssRequirements("components-overlays", OVERLAY_CSS_REQUIREMENTS);
    return;
  }
  if (phase === "pages-core") {
    assertOrderedRequirements("pages-core", CORE_PAGE_REQUIREMENTS);
    return;
  }
  if (phase === "pages-catalog") {
    assertOrderedRequirements("pages-catalog", CATALOG_PAGE_REQUIREMENTS);
    return;
  }
  if (phase === "pages-shell") {
    assertOrderedRequirements("pages-shell", SHELL_PAGE_REQUIREMENTS);
    return;
  }
  if (phase === "components-gallery") {
    validateComponentsGallery();
  }
}

// 每个 phase 都在自身视觉断言后检查不可越界哈希，防止单跑绕过范围保护。
function runPhase(phase) {
  runVisualPhase(phase);
  validateHashes();
}

// all 顺序复用全部单 phase，保持失败优先级和哈希边界完全一致。
function runAll() {
  for (const phase of PHASES.slice(0, -1)) runPhase(phase);
}

// CLI 入口只接受一个已声明 phase，成功和失败均输出稳定、可供 CI 匹配的一行。
function main() {
  const phase = process.argv[2] ?? "all";
  assertContract(process.argv.length <= 3, "phase:extra-arguments");
  if (phase === "--hash-only") {
    runHashOnly();
    console.log("[manage-ui-design] PASS --hash-only");
    return;
  }
  assertContract(PHASES.includes(phase), `phase:${phase}`);
  validateComponentsGalleryAstFixtures();
  validateCssDeclarationParser();
  if (phase === "all") {
    runAll();
  } else {
    runPhase(phase);
  }
  console.log(`[manage-ui-design] PASS ${phase}`);
}

try {
  main();
} catch (error) {
  if (error?.contractFailure === FAILURE) {
    console.error(`[manage-ui-design] FAIL ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
