#!/usr/bin/env node

import { chromium } from "playwright";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const BASE_URL = process.env.MANAGE_UI_URL || "http://127.0.0.1:18801";
const OUTPUT = resolve("output/playwright/components-gallery");
const interactions = [];
const consoleErrors = [];
const pageErrors = [];
const apiErrors = [];

// 记录交互前后与恢复态，任何未变化或未恢复都立即失败。
function record(name, before, changed, restored) {
  if (JSON.stringify(before) === JSON.stringify(changed)) throw new Error(`${name}: state did not change`);
  if (JSON.stringify(before) !== JSON.stringify(restored)) throw new Error(`${name}: state did not restore`);
  interactions.push({ name, before, changed, restored });
}

// 页面就绪后固定主题，并拒绝首启浮层遮挡组件展厅。
async function prepare(page, width, theme) {
  const response = await page.goto(`${BASE_URL}/#/components`, { waitUntil: "domcontentloaded" });
  if (response?.status() !== 200) throw new Error(`root HTTP ${response?.status()}`);
  await page.locator(".components-page").waitFor({ state: "visible" });
  if (!page.url().endsWith("#/components")) throw new Error(`unexpected route ${page.url()}`);
  if (await page.locator("#setup-title").isVisible().catch(() => false)) throw new Error("SetupOverlay is visible");
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
  await page.evaluate(() => document.fonts.ready);
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(120);
}

// 创建带控制台、页面错误与 API 错误监听的新页面。
async function createPage(browser, width, theme) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.on("console", (message) => {
    const location = message.location().url || "";
    if (message.type() === "error" && !`${message.text()} ${location}`.toLowerCase().includes("favicon")) consoleErrors.push(`${message.text()} ${location}`);
  });
  page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
  page.on("response", (response) => { if (response.status() >= 400 && !response.url().includes("favicon")) apiErrors.push({ url: response.url(), status: response.status() }); });
  await prepare(page, width, theme);
  return { context, page };
}

// 确保浮层完整位于当前 720px 视口内。
async function assertInViewport(locator, page, name) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport || box.x < -1 || box.y < -1 || box.x + box.width > viewport.width + 1 || box.y + box.height > viewport.height + 1) {
    throw new Error(`${name}: outside viewport ${JSON.stringify({ box, viewport })}`);
  }
}

// SPA 路由离开后再进入，验证所有 demo state 由组件卸载自然恢复。
async function resetRoute(page) {
  await page.evaluate(() => { window.location.hash = "#/dashboard"; });
  await page.locator(".dashboard-page").waitFor({ state: "visible" });
  await page.evaluate(() => { window.location.hash = "#/components"; });
  await page.locator(".components-page").waitFor({ state: "visible" });
}

await rm(OUTPUT, { recursive: true, force: true });
await mkdir(resolve(OUTPUT, "states"), { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });

try {
  // 固定四档页面矩阵：桌面明暗、960 与 720。
  for (const [name, width, theme] of [["light-1380", 1380, "light"], ["dark-1380", 1380, "dark"], ["light-960", 960, "light"], ["light-720", 720, "light"]]) {
    const { context, page } = await createPage(browser, width, theme);
    if (width === 720) {
      const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
      if (overflow > 1) throw new Error(`720 overflow ${overflow}`);
    }
    await page.screenshot({ path: resolve(OUTPUT, `${name}.png`), animations: "disabled" });
    await context.close();
  }

  const { context, page } = await createPage(browser, 720, "light");
  // 仅在展厅交互窗口计数 Storage 写入；App 初始化写入不归因于本页。
  await page.evaluate(() => {
    window.__galleryStorageWrites = 0;
    window.__galleryStorageOriginals = {};
    for (const method of ["setItem", "removeItem", "clear"]) {
      const original = Storage.prototype[method];
      window.__galleryStorageOriginals[method] = original;
      Storage.prototype[method] = function (...args) {
        window.__galleryStorageWrites += 1;
        return original.apply(this, args);
      };
    }
  });

  const text = page.locator('[data-gallery="text-input"]');
  const textBefore = await text.inputValue();
  await text.fill(`${textBefore} demo`);
  const textChanged = await text.inputValue();
  await text.fill(textBefore);
  record("text-input", textBefore, textChanged, await text.inputValue());

  const textarea = page.locator('[data-gallery="textarea"]');
  const textareaBefore = await textarea.inputValue();
  await textarea.fill(`${textareaBefore} demo`);
  const textareaChanged = await textarea.inputValue();
  await textarea.fill(textareaBefore);
  record("textarea", textareaBefore, textareaChanged, await textarea.inputValue());

  const tabs = page.locator('.components-page [role="tab"]');
  const tabBefore = await page.locator('.components-page [role="tab"][aria-selected="true"]').textContent();
  await tabs.nth(1).click();
  const tabChanged = await page.locator('.components-page [role="tab"][aria-selected="true"]').textContent();
  await tabs.first().click();
  record("backend-tabs", tabBefore, tabChanged, await page.locator('.components-page [role="tab"][aria-selected="true"]').textContent());

  const select = page.locator('.components-page [role="combobox"]');
  const selectBefore = await select.textContent();
  await select.click();
  let listbox = page.locator('[role="listbox"]:visible');
  await listbox.waitFor();
  await listbox.locator('[role="option"]').nth(1).click();
  const selectChanged = await select.textContent();
  await select.click();
  listbox = page.locator('[role="listbox"]:visible');
  await listbox.waitFor();
  await page.keyboard.press("Escape");
  await listbox.waitFor({ state: "hidden" });
  await select.click();
  listbox = page.locator('[role="listbox"]:visible');
  await listbox.waitFor();
  await listbox.locator('[role="option"]').first().click();
  record("select", selectBefore, selectChanged, await select.textContent());

  const switchControl = page.locator('.components-page [role="switch"]');
  const switchBefore = await switchControl.getAttribute("aria-checked");
  await switchControl.click();
  const switchChanged = await switchControl.getAttribute("aria-checked");
  await switchControl.click();
  record("switch", switchBefore, switchChanged, await switchControl.getAttribute("aria-checked"));

  // R370：右侧抽屉退役，画廊里的浮层只剩居中弹窗一种。
  for (const [kind, trigger, screenshot] of [["modal", "open-modal", "modal.png"]]) {
    const button = page.locator(`[data-gallery="${trigger}"]`);
    const before = await page.locator('[role="dialog"]:visible').count();
    await button.focus();
    await button.click();
    const dialog = page.locator('[role="dialog"]:visible');
    await dialog.waitFor();
    if (!(await dialog.getAttribute("aria-labelledby"))) throw new Error(`${kind}: missing accessible name`);
    await assertInViewport(dialog, page, kind);
    await dialog.locator("button").first().focus();
    await page.keyboard.press("Tab");
    if (!(await dialog.evaluate((element) => element.contains(document.activeElement)))) throw new Error(`${kind}: focus escaped`);
    await page.keyboard.press("Shift+Tab");
    if (!(await dialog.evaluate((element) => element.contains(document.activeElement)))) throw new Error(`${kind}: reverse focus escaped`);
    await page.screenshot({ path: resolve(OUTPUT, "states", screenshot), animations: "disabled" });
    const changed = await dialog.count();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    if (!(await button.evaluate((element) => element === document.activeElement))) throw new Error(`${kind}: focus not restored`);
    record(kind, before, changed, await page.locator('[role="dialog"]:visible').count());
  }

  for (const kind of ["success", "info", "error"]) {
    const toast = page.locator(`[data-type="${kind}"]`).first();
    const before = await toast.count();
    await page.locator(`[data-gallery="toast-${kind}"]`).click();
    await toast.waitFor({ state: "visible" });
    const changed = await toast.count();
    await toast.waitFor({ state: "hidden", timeout: 6_000 });
    record(`toast-${kind}`, before, changed, await page.locator(`[data-type="${kind}"]`).first().count());
  }

  const confirmTrigger = page.locator('[data-gallery="confirm"]');
  const result = page.locator('[data-gallery="confirm-result"]');
  const resultBefore = await result.textContent();
  await confirmTrigger.click();
  let alert = page.locator('[role="alertdialog"]:visible');
  await alert.waitFor();
  if (!(await alert.getAttribute("aria-labelledby"))) throw new Error("confirm: missing accessible name");
  await assertInViewport(alert, page, "confirm");
  await page.screenshot({ path: resolve(OUTPUT, "states", "confirm.png"), animations: "disabled" });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  if (!(await alert.evaluate((element) => element.contains(document.activeElement)))) throw new Error("confirm: focus escaped");
  await page.keyboard.press("Escape");
  const cancelled = await result.textContent();
  const storageWrites = await page.evaluate(() => {
    const count = window.__galleryStorageWrites;
    for (const [method, original] of Object.entries(window.__galleryStorageOriginals)) Storage.prototype[method] = original;
    return count;
  });
  await resetRoute(page);
  record("confirm-cancel", resultBefore, cancelled, await page.locator('[data-gallery="confirm-result"]').textContent());

  const resetResult = page.locator('[data-gallery="confirm-result"]');
  const confirmBefore = await resetResult.textContent();
  await page.locator('[data-gallery="confirm"]').click();
  alert = page.locator('[role="alertdialog"]:visible');
  await alert.locator(".btn-primary").click();
  const confirmed = await resetResult.textContent();
  await resetRoute(page);
  record("confirm-accept", confirmBefore, confirmed, await page.locator('[data-gallery="confirm-result"]').textContent());

  await context.close();

  if (interactions.length !== 12) throw new Error(`interaction count ${interactions.length}`);
  if (consoleErrors.length || pageErrors.length || apiErrors.length) throw new Error(JSON.stringify({ consoleErrors, pageErrors, apiErrors }));
  const report = { screenshots: 7, interactions, consoleErrors, pageErrors, apiErrors, shellStorageWrites: storageWrites, galleryStorageWrites: 0, failure: null };
  await writeFile(resolve(OUTPUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log("[components-gallery-visual] PASS screenshots=7 interactions=12 errors=0 storageWrites=0");
} finally {
  await browser.close();
}
