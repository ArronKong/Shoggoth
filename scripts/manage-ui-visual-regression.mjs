#!/usr/bin/env node

import { chromium } from "playwright";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_ROOT = resolve(ROOT, "output/playwright/figma-ui-final");
const BASE_URL = process.env.MANAGE_UI_URL || "http://127.0.0.1:18801";
const VIEWPORT_HEIGHT = 900;
const CASE_TIMEOUT = 12_000;

const TARGET_PAGES = [
  ["tasks", "/tasks"],
  ["cron", "/cron"],
  ["token", "/token"],
  ["models", "/models"],
  ["skills", "/skills"],
  ["agents", "/agents"],
  ["glass", "/glass"],
  ["settings", "/settings"],
];
const ALL_PAGES = [...TARGET_PAGES, ["chat", "/chat"], ["cli", "/cli"]];
const MEDIUM_PAGES = TARGET_PAGES.filter(([name]) => ["tasks", "cron", "agents", "glass", "settings"].includes(name));

const interactionRecords = [];
const caseRecords = [];
const consoleErrors = [];
const pageErrors = [];

// 保证失败时仍能留下足够的 case 语境，同时只豁免浏览器自动请求的 favicon。
function isFaviconError(text, url = "") {
  return `${text} ${url}`.toLowerCase().includes("favicon");
}

// DOM 文本只用于验证状态变化，不用于定位易变文案。
async function normalizedText(locator) {
  return locator.evaluate((element) => (element.textContent || "").replace(/\s+/g, " ").trim());
}

// 记录每个交互的前态、变更态与恢复态；状态未变化或未恢复都属于硬失败。
function recordInteraction(name, before, changed, restored) {
  const beforeJson = JSON.stringify(before);
  const changedJson = JSON.stringify(changed);
  const restoredJson = JSON.stringify(restored);
  if (beforeJson === changedJson) throw new Error(`[${name}] 交互未产生可观测状态变化`);
  if (beforeJson !== restoredJson) throw new Error(`[${name}] 状态未恢复：${beforeJson} -> ${restoredJson}`);
  interactionRecords.push({ name, before, changed, restored });
}

// 所有截图都固定为当前 viewport，确保 1380×900 基线不会因页面高度而漂移。
async function screenshot(page, relativePath) {
  const absolutePath = resolve(OUTPUT_ROOT, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await page.screenshot({ path: absolutePath, fullPage: false, animations: "disabled" });
}

// 等待应用壳、页面数据与字体稳定，再强制落到本 case 的明暗主题。
async function preparePage(page, path, theme) {
  // 生产入口使用 HashRouter；直接访问 /tasks 会落回默认 #/chat。
  await page.goto(`${BASE_URL}/#${path}`, { waitUntil: "domcontentloaded" });
  await page.locator(".app").waitFor({ state: "visible" });
  await page.waitForTimeout(450);
  if (await page.locator("#setup-title").isVisible().catch(() => false)) {
    throw new Error("首次设置浮层遮挡了视觉回归；拒绝通过持久化操作自动关闭");
  }
  await page.evaluate((nextTheme) => {
    document.documentElement.dataset.theme = nextTheme;
  }, theme);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(80);
}

// 每个 case 都使用全新的 context/page；监听器必须在导航前注册。
async function runCase(name, { path, width, theme = "light" }, action) {
  const context = await browser.newContext({
    viewport: { width, height: VIEWPORT_HEIGHT },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  await context.addInitScript((initialTheme) => {
    try {
      localStorage.setItem("openclaw.theme", initialTheme);
    } catch {
      // 无 localStorage 时仍会在 preparePage 直接设置 data-theme。
    }
  }, theme);
  const page = await context.newPage();
  page.setDefaultTimeout(CASE_TIMEOUT);
  const localConsoleErrors = [];
  const localPageErrors = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location();
    if (isFaviconError(message.text(), location.url)) return;
    localConsoleErrors.push({ text: message.text(), location });
  });
  page.on("pageerror", (error) => localPageErrors.push(error.stack || error.message));

  try {
    await preparePage(page, path, theme);
    await action(page);
    await page.waitForTimeout(120);
    if (localConsoleErrors.length > 0) {
      throw new Error(`[${name}] console error: ${localConsoleErrors.map((entry) => entry.text).join(" | ")}`);
    }
    if (localPageErrors.length > 0) {
      throw new Error(`[${name}] pageerror: ${localPageErrors.join(" | ")}`);
    }
    caseRecords.push({ name, path, width, height: VIEWPORT_HEIGHT, theme, status: "passed" });
  } finally {
    consoleErrors.push(...localConsoleErrors.map((entry) => ({ case: name, ...entry })));
    pageErrors.push(...localPageErrors.map((error) => ({ case: name, error })));
    await context.close();
  }
}

// 截取一张页面矩阵图，并在 720 宽度执行文档级横向溢出门禁。
async function capturePageCase(directory, pageName, path, width, theme) {
  await runCase(`${directory}/${pageName}`, { path, width, theme }, async (page) => {
    if (width === 720) {
      const overflow = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
      }));
      if (Math.max(overflow.documentWidth, overflow.bodyWidth) > overflow.viewportWidth + 1) {
        throw new Error(`[${pageName}] 720px 页面横向溢出：${JSON.stringify(overflow)}`);
      }
    }
    await screenshot(page, `${directory}/${pageName}.png`);
  });
}

// 在 Base UI 后端 tabs 上切换一次并恢复原 tab。
async function backendInteraction(page, pageSelector, name) {
  const tabs = page.locator(`${pageSelector} [role="tab"]`);
  if ((await tabs.count()) < 2) throw new Error(`[${name}] 缺少两个后端 tab`);
  const active = page.locator(`${pageSelector} [role="tab"][aria-selected="true"]`);
  await active.waitFor();
  const before = await normalizedText(active);
  const target = tabs.filter({ hasNotText: before }).first();
  await target.click();
  await target.waitFor({ state: "visible" });
  await page.waitForFunction(
    ({ selector, previous }) => [...document.querySelectorAll(selector)].some((tab) => tab.getAttribute("aria-selected") === "true" && tab.textContent?.trim() !== previous),
    { selector: `${pageSelector} [role="tab"]`, previous: before },
  );
  const changed = await normalizedText(page.locator(`${pageSelector} [role="tab"][aria-selected="true"]`));
  await tabs.filter({ hasText: before }).first().click();
  await page.locator(`${pageSelector} [role="tab"][aria-selected="true"]`).filter({ hasText: before }).waitFor();
  const restored = await normalizedText(page.locator(`${pageSelector} [role="tab"][aria-selected="true"]`));
  recordInteraction(name, before, changed, restored);
}

// 打开首个数据卡片对应的 Drawer，必要时截图，然后用 Escape 无副作用关闭。
async function drawerInteraction(page, cardSelector, name, statePath) {
  const card = page.locator(cardSelector).first();
  await card.waitFor({ state: "visible" });
  const dialog = page.locator('[role="dialog"]:visible');
  const before = await dialog.count() > 0;
  await card.click();
  await dialog.waitFor({ state: "visible" });
  const changed = await dialog.isVisible();
  if (statePath) await screenshot(page, statePath);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  const restored = await dialog.isVisible().catch(() => false);
  recordInteraction(name, before, changed, restored);
}

// 切换分段按钮并恢复，适用于 Cron 视图与 Token 时间范围。
async function segmentedInteraction(page, selector, name) {
  const buttons = page.locator(selector);
  if ((await buttons.count()) < 2) throw new Error(`[${name}] 缺少可切换分段按钮`);
  const active = page.locator(`${selector}.seg-on`);
  await active.waitFor();
  const before = await normalizedText(active);
  const target = buttons.filter({ hasNotText: before }).first();
  await target.click();
  await target.waitFor({ state: "visible" });
  await page.waitForFunction(
    ({ query, previous }) => [...document.querySelectorAll(query)].some((button) => button.classList.contains("seg-on") && button.textContent?.trim() !== previous),
    { query: selector, previous: before },
  );
  const changed = await normalizedText(page.locator(`${selector}.seg-on`));
  await buttons.filter({ hasText: before }).first().click();
  await page.locator(`${selector}.seg-on`).filter({ hasText: before }).waitFor();
  const restored = await normalizedText(page.locator(`${selector}.seg-on`));
  recordInteraction(name, before, changed, restored);
}

// Cron 列表行打开的是居中 Modal；只读查看后立即关闭。
async function cronModalInteraction(page) {
  const row = page.locator(".cron-page tbody tr.clickable").first();
  const modal = page.locator('[role="dialog"]:visible');
  const before = await modal.count() > 0;
  if (await row.isVisible().catch(() => false)) {
    await row.click();
  } else {
    // 空列表同样验证生产 Modal：打开新建表单但不保存，随后 Escape 恢复。
    const create = page.locator(".cron-page .toolbar .btn-primary").first();
    await create.waitFor({ state: "visible" });
    await create.click();
  }
  await modal.waitFor({ state: "visible" });
  const changed = await modal.isVisible();
  await screenshot(page, "states/cron-modal-light.png");
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "hidden" });
  const restored = await modal.isVisible().catch(() => false);
  recordInteraction("cron-modal", before, changed, restored);
}

// Skills 过滤器只改变页面内存态；第二次点击恢复原值。
async function skillsFilterInteraction(page) {
  const checkbox = page.locator('.skills-page .toolbar input[type="checkbox"]').first();
  await checkbox.waitFor();
  const before = await checkbox.isChecked();
  await checkbox.click();
  const changed = await checkbox.isChecked();
  await checkbox.click();
  const restored = await checkbox.isChecked();
  recordInteraction("skills-enabled-filter", before, changed, restored);
}

// Agent 选择只在当前页面切换详情，随后重新选择最初项。
async function agentSelectionInteraction(page) {
  const items = page.locator(".agents-page .agent-item");
  if ((await items.count()) < 2) throw new Error("[agents-selection] 缺少第二个 Agent");
  const active = page.locator(".agents-page .agent-item.agent-item-on");
  await active.waitFor({ state: "visible" });
  const before = await normalizedText(active);
  const target = items.filter({ hasNotText: before }).first();
  await target.click();
  await target.locator(".agent-item-label").waitFor();
  await page.waitForFunction((selector) => document.querySelector(selector)?.classList.contains("agent-item-on"), ".agents-page .agent-item:nth-child(2)")
    .catch(() => undefined);
  const changed = await normalizedText(page.locator(".agents-page .agent-item.agent-item-on"));
  await items.filter({ hasText: before }).first().click();
  await page.locator(".agents-page .agent-item.agent-item-on").filter({ hasText: before }).waitFor();
  const restored = await normalizedText(page.locator(".agents-page .agent-item.agent-item-on"));
  recordInteraction("agents-selection", before, changed, restored);
}

// Agent 子页签切换期间额外打开删除确认框取图，随后点击取消并恢复页签。
async function agentSubtabInteraction(page) {
  const tabs = page.locator(".agents-page .subtab");
  if ((await tabs.count()) < 2) throw new Error("[agents-subtab] 缺少第二个子页签");
  const active = page.locator(".agents-page .subtab.subtab-on");
  await active.waitFor({ state: "visible" });
  const before = await normalizedText(active);
  const target = tabs.filter({ hasNotText: before }).first();
  await target.click();
  await target.waitFor();
  const changed = await normalizedText(page.locator(".agents-page .subtab.subtab-on"));

  const deleteButton = page.locator(".agents-detail-head .btn-danger");
  await deleteButton.waitFor({ state: "visible" });
  await deleteButton.click();
  const confirm = page.locator('[role="alertdialog"]:visible');
  await confirm.waitFor({ state: "visible" });
  await screenshot(page, "states/agents-confirm-light.png");
  await confirm.locator("button").first().click();
  await confirm.waitFor({ state: "hidden" });

  await tabs.filter({ hasText: before }).first().click();
  await page.locator(".agents-page .subtab.subtab-on").filter({ hasText: before }).waitFor();
  const restored = await normalizedText(page.locator(".agents-page .subtab.subtab-on"));
  recordInteraction("agents-subtab", before, changed, restored);
}

// Glass range 的 input 事件只更新 React 内存态；精确写回原始字符串值。
async function glassSliderInteraction(page) {
  const slider = page.locator('.management-page input[type="range"]').first();
  await slider.waitFor({ state: "visible" });
  const before = await slider.inputValue();
  const { min, max, step } = await slider.evaluate((element) => ({
    min: Number(element.min),
    max: Number(element.max),
    step: Number(element.step),
  }));
  const current = Number(before);
  const next = current + step <= max ? current + step : Math.max(min, current - step);
  await slider.evaluate((element, value) => {
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, String(next));
  const changed = await slider.inputValue();
  await slider.evaluate((element, value) => {
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, before);
  const restored = await slider.inputValue();
  recordInteraction("glass-slider", before, changed, restored);
}

// Settings 的 Base UI Select 只展开/收起，不选择选项，因此不会写配置或改语言。
async function settingsSelectInteraction(page, statePath, record = true) {
  const trigger = page.locator('.settings-page .settings-prefs-row .settings-section').first().locator('[role="combobox"]');
  await trigger.waitFor({ state: "visible" });
  const before = await trigger.getAttribute("aria-expanded");
  await trigger.click();
  await page.locator('[role="listbox"]:visible').waitFor({ state: "visible" });
  const changed = await trigger.getAttribute("aria-expanded");
  await screenshot(page, statePath);
  await page.keyboard.press("Escape");
  await page.locator('[role="listbox"]:visible').waitFor({ state: "hidden" });
  const restored = await trigger.getAttribute("aria-expanded");
  if (record) recordInteraction("settings-select", before, changed, restored);
}

// 生成固定的 20 + 5 + 8 页面矩阵。
async function captureMatrix() {
  for (const theme of ["light", "dark"]) {
    for (const [name, path] of ALL_PAGES) {
      await capturePageCase(`${theme}-1380`, name, path, 1380, theme);
    }
  }
  for (const [name, path] of MEDIUM_PAGES) {
    await capturePageCase("light-960", name, path, 960, "light");
  }
  for (const [name, path] of TARGET_PAGES) {
    await capturePageCase("light-720", name, path, 720, "light");
  }
}

// 13 个主交互逐个使用新 context；其中五个产出状态截图，第六张为 dark Select。
async function runInteractions() {
  await runCase("interaction/tasks-backend", { path: "/tasks", width: 1380 }, (page) => backendInteraction(page, ".tasks-page", "tasks-backend"));
  await runCase("interaction/tasks-drawer", { path: "/tasks", width: 1380 }, (page) => drawerInteraction(page, ".tasks-page .kanban-card", "tasks-drawer", "states/tasks-drawer-light.png"));
  await runCase("interaction/cron-view", { path: "/cron", width: 1380 }, (page) => segmentedInteraction(page, ".cron-page .toolbar .seg button", "cron-view"));
  await runCase("interaction/cron-modal", { path: "/cron", width: 1380 }, cronModalInteraction);
  await runCase("interaction/token-range", { path: "/token", width: 1380 }, (page) => segmentedInteraction(page, ".usage-page > .toolbar .seg button", "token-range"));
  await runCase("interaction/models-backend", { path: "/models", width: 1380 }, (page) => backendInteraction(page, ".models-page", "models-backend"));
  await runCase("interaction/models-drawer", { path: "/models", width: 1380, theme: "dark" }, (page) => drawerInteraction(page, ".models-page .model-card", "models-drawer", "states/models-drawer-dark.png"));
  await runCase("interaction/skills-filter", { path: "/skills", width: 1380 }, skillsFilterInteraction);
  await runCase("interaction/skills-drawer", { path: "/skills", width: 1380 }, (page) => drawerInteraction(page, ".skills-page .skill-row", "skills-drawer"));
  await runCase("interaction/agents-selection", { path: "/agents", width: 1380 }, agentSelectionInteraction);
  await runCase("interaction/agents-subtab", { path: "/agents", width: 1380 }, agentSubtabInteraction);
  await runCase("interaction/glass-slider", { path: "/glass", width: 1380 }, glassSliderInteraction);
  await runCase("interaction/settings-select", { path: "/settings", width: 1380 }, (page) => settingsSelectInteraction(page, "states/settings-select-light.png"));
  await runCase("state/settings-select-dark", { path: "/settings", width: 1380, theme: "dark" }, (page) => settingsSelectInteraction(page, "states/settings-select-dark.png", false));
}

// 递归统计 PNG，防止旧图或漏图让 39 张门禁失真。
async function countPng(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    count += entry.isDirectory() ? await countPng(path) : entry.name.endsWith(".png") ? 1 : 0;
  }
  return count;
}

let browser;
let failure;
await rm(OUTPUT_ROOT, { recursive: true, force: true });
await mkdir(resolve(OUTPUT_ROOT, "logs"), { recursive: true });

try {
  // 计划明确要求系统 Chrome；不得回退到 Playwright 自带 Chromium。
  browser = await chromium.launch({ channel: "chrome" });
  await captureMatrix();
  await runInteractions();
  const pngCount = await countPng(OUTPUT_ROOT);
  if (pngCount !== 39) throw new Error(`截图数量错误：期望 39，实际 ${pngCount}`);
  if (interactionRecords.length !== 13) throw new Error(`交互数量错误：期望 13，实际 ${interactionRecords.length}`);
} catch (error) {
  failure = error;
} finally {
  await browser?.close();
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    browser: { engine: "chromium", channel: "chrome" },
    expectedScreenshots: 39,
    actualScreenshots: await countPng(OUTPUT_ROOT).catch(() => 0),
    expectedInteractions: 13,
    actualInteractions: interactionRecords.length,
    cases: caseRecords,
    interactions: interactionRecords,
    consoleErrors,
    pageErrors,
    failure: failure instanceof Error ? failure.stack || failure.message : failure ? String(failure) : null,
  };
  // 其他并行验证可能会清理空目录；写报告前再次确保日志目录存在。
  await mkdir(resolve(OUTPUT_ROOT, "logs"), { recursive: true });
  await writeFile(resolve(OUTPUT_ROOT, "logs/report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

if (failure) throw failure;
console.log(`[manage-ui-visual] PASS screenshots=39 interactions=13 consoleErrors=0 pageErrors=0`);
