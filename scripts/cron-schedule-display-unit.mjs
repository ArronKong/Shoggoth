import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const require = createRequire(path.join(uiRoot, "package.json"));
const ts = require("typescript");
const i18next = require("i18next");
process.env.TZ = "Asia/Shanghai";

function load(relative) {
  const file = path.join(uiRoot, "src", relative);
  const mod = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, Intl, Date,
    require: name => name.endsWith("/Field") || name === "react-i18next" ? {} : require(name),
  });
  return mod.exports;
}

const { scheduleText, formatCronTime } = load("pages/cron/cronPresets.tsx");
const i18n = i18next.createInstance();
await i18n.init({
  lng: "zh-CN", fallbackLng: "zh-CN", interpolation: { escapeValue: false },
  resources: {
    "zh-CN": { translation: load("i18n/locales/zh-CN.ts").default },
    en: { translation: load("i18n/locales/en.ts").default },
  },
});
const describe = (schedule, locale = "zh-CN", extras = {}) =>
  scheduleText({ schedule, ...extras }, i18n.getFixedT(locale), locale);
const cron = (expr, options = {}) => describe({ kind: "cron", expr, ...options });

test("common schedules read as times rather than backend expressions", () => {
  assert.equal(cron("0 9 * * *"), "每天 09:00");
  assert.equal(cron("0 9 * * 1-5"), "周一至周五 09:00");
  assert.equal(cron("30 8 * * 1"), "每周一 08:30");
  assert.equal(cron("0 9 * * 7"), "每周日 09:00");
  assert.equal(cron("0 10 15 * *"), "每月 15 号 10:00");
  assert.equal(cron("5 * * * *"), "每小时第 05 分");
  assert.equal(cron("* * * * *"), "每 1 分钟");
  assert.equal(cron("*/15 * * * *"), "每 15 分钟");
  assert.equal(describe({ kind: "cron", expr: "0 9 * * *" }, "zh-CN", {
    scheduleDisplay: "cron 0 9 * * * · Asia/Shanghai",
  }), "每天 09:00");
});

test("custom, invalid, and stepped schedules never gain an inaccurate simple cadence", () => {
  assert.equal(cron("*/7 * * * *"), "每小时从 0 分开始，每 7 分钟");
  for (const expression of ["0 9 1 * 1", "*/0 * * * *", "60 25 * * *", "0 9 0 * *", "invalid"]) {
    assert.equal(cron(expression), "自定义重复计划");
  }
});

test("single runs convert UTC to local date and preserve meaningful seconds", () => {
  assert.equal(describe({ kind: "at", at: "2026-09-18T01:46:00.000Z" }), "2026年9月18日 09:46 · 仅一次");
  assert.equal(describe({ kind: "at", at: "2026-09-17T17:46:07.000Z" }), "2026年9月18日 01:46:07 · 仅一次");
  assert.equal(formatCronTime(null, "zh-CN"), "—");
  assert.equal(formatCronTime(NaN, "zh-CN"), "—");
  assert.equal(formatCronTime("invalid", "zh-CN"), "—");
  assert.equal(formatCronTime(0, "zh-CN"), "1970年1月1日 08:00");
  assert.equal(describe({ kind: "at", at: null }), "一次性");
});

test("intervals use suitable units without rounding seconds into zero minutes", () => {
  for (const [ms, label] of [[30000, "每 30 秒"], [1800000, "每 30 分钟"], [7200000, "每 2 小时"], [86400000, "每 1 天"], [604800000, "每 1 周"]]) {
    assert.equal(describe({ kind: "every", everyMs: ms }), label);
  }
  assert.equal(describe({ kind: "every", everyMs: 0 }), "—");
  assert.equal(describe({ kind: "every", everyMs: 1800000, anchorMs: Date.parse("2026-09-18T01:00:00Z") }),
    "每 30 分钟 · 从 2026年9月18日 09:00 开始");
});

test("explicit remote time zones and stagger remain visible without raw code", () => {
  assert.equal(cron("0 9 * * *", { tz: "Asia/Shanghai" }), "每天 09:00");
  const remote = cron("0 9 * * *", { tz: "America/New_York", staggerMs: 30000 });
  assert.match(remote, /每天 09:00 · .+ · 最多错开 30 秒/);
  assert.doesNotMatch(remote, /America\/New_York|stagger|cron /);
  assert.equal(cron("0 9 * * *", { tz: "invalid/zone" }), "每天 09:00 · 时区不可用");
});

test("English UI uses the selected locale for both schedules and dates", () => {
  assert.equal(describe({ kind: "cron", expr: "0 9 * * *" }, "en"), "Every day at 09:00");
  assert.equal(describe({ kind: "every", everyMs: 1800000 }, "en"), "Every 30 minutes");
  const once = describe({ kind: "at", at: "2026-09-18T01:46:00Z" }, "en");
  assert.match(once, /Sep 18, 2026/);
  assert.match(once, /09:46 · Once$/);
});
