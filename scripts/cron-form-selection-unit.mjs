#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const esbuild = path.join(root, "app/manage-ui/node_modules/.bin/esbuild");

function compile(relativePath, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shoggoth-cron-selection-${name}-`));
  const outfile = path.join(dir, `${name}.cjs`);
  execFileSync(esbuild, [
    path.join(root, relativePath),
    "--bundle",
    "--platform=node",
    "--format=cjs",
    `--outfile=${outfile}`,
  ], { stdio: "pipe" });
  return { mod: createRequire(outfile)(outfile), dir };
}

const compiled = [];
try {
  const schedule = compile("app/manage-ui/src/pages/cron/CronSchedulePicker.tsx", "schedule");
  compiled.push(schedule.dir);
  for (const expression of [
    "*/15 * * * *",
    "7 * * * *",
    "30 9 * * *",
    "30 9 * * 1-5",
    "30 9 * * 3",
    "30 9 15 * *",
  ]) {
    const parsed = schedule.mod.parseCronPattern(expression);
    assert.notEqual(parsed.mode, "custom", `${expression} 应可由结构化选择器表达`);
    assert.equal(schedule.mod.cronExpressionFromPattern(parsed), expression, `${expression} 应无损往返`);
  }
  assert.equal(schedule.mod.parseCronPattern("13 4 2 3 *").mode, "custom", "非常见 Cron 必须保留为旧自定义值");

  const model = compile("app/manage-ui/src/pages/cron/CronModelPicker.tsx", "model");
  compiled.push(model.dir);
  const catalog = [{ id: "openai/gpt-5", name: "GPT-5", provider: "openrouter", backendId: "openclaw" }];
  const qualified = model.mod.openClawModelReference("openai/gpt-5", "openrouter");
  assert.equal(qualified, "openrouter/openai/gpt-5", "模型 ID 内的斜杠不能被截断");
  assert.equal(model.mod.findOpenClawModel(catalog, qualified)?.id, "openai/gpt-5", "完整引用应命中目录身份");

  const openClaw = compile("app/manage-ui/src/pages/cron/OpenClawCronForm.tsx", "openclaw-form");
  compiled.push(openClaw.dir);
  const once = { ...openClaw.mod.emptyOpenClawDraft(), schedKind: "at" };
  for (const atLocal of ["", "   ", "not-a-date", "2026-02-30T09:00", "2026-09-15T25:00"]) {
    assert.equal(openClaw.mod.validateOpenClawDraft({ ...once, atLocal }), "cronForm.openclawValidateAt",
      "空或无效一次性时间必须在发送前给出字段提示");
  }
  const validOnce = { ...once, atLocal: "2026-09-15T09:00" };
  assert.equal(openClaw.mod.validateOpenClawDraft(validOnce), null);
  assert.deepEqual(openClaw.mod.openClawInputFromDraft(validOnce).schedule,
    { kind: "at", at: new Date(validOnce.atLocal).toISOString() }, "有效本地时间应按本地时区转换，不改日期");
  const customJob = {
    id: "custom",
    backendId: "openclaw",
    name: "custom",
    enabled: true,
    schedule: { kind: "cron", expr: "13 4 2 3 *", tz: "Asia/Shanghai" },
  };
  assert.deepEqual(openClaw.mod.openClawInputFromDraft(openClaw.mod.openClawDraftFromJob(customJob)).schedule,
    customJob.schedule, "旧自定义 Cron 编辑后应原样保存");
  const precisionJob = {
    id: "precision",
    backendId: "openclaw",
    name: "precision",
    enabled: true,
    schedule: { kind: "every", everyMs: 90_001, anchorMs: 1_800_000_123 },
  };
  assert.equal(
    openClaw.mod.openClawInputFromDraft(openClaw.mod.openClawDraftFromJob(precisionJob)).schedule.everyMs,
    90_001,
    "旧的非标准固定间隔应保持毫秒精度",
  );

  const formSources = [
    "app/manage-ui/src/pages/cron/OpenClawCronForm.tsx",
    "app/manage-ui/src/pages/cron/HermesCronForm.tsx",
    "app/manage-ui/src/pages/cron/ShoggothCronForm.tsx",
  ].map((file) => fs.readFileSync(path.join(root, file), "utf8"));
  assert.equal(formSources.every((source) => source.includes("CronExpressionPicker")), true,
    "三套 Cron 表单都应使用结构化 Cron 选择器");
  assert.equal(formSources.some((source) => /type="datetime-local"/.test(source)), false,
    "Cron 表单不应继续暴露可手填的 datetime-local");
  assert.equal(/<TextInput[^>]*value=\{draft\.model\}/s.test(formSources[0]), false,
    "OpenClaw 主模型不应继续使用文本输入");
  assert.equal(/<TextInput[^>]*value=\{draft\.model\}/s.test(formSources[1]), false,
    "Hermes 主模型不应继续使用文本输入");
  assert.equal(/<TextInput[^>]*value=\{draft\.staggerSec\}/s.test(formSources[0]), false,
    "OpenClaw Cron 错峰时间不应继续使用数字输入");
  assert.equal(formSources.some(source => source.includes("CronAdvancedSettings")), false,
    "高级设置整体隐藏后不再挂载入口");
  const page = fs.readFileSync(path.join(root, "app/manage-ui/src/pages/CronPage.tsx"), "utf8");
  assert.equal(page.includes("revalidateModelCatalog"), false,
    "隐藏模型设置后不再加载未使用的模型目录");
  console.log("PASS Cron 表单模型与时间选择回归");
} finally {
  for (const dir of compiled) fs.rmSync(dir, { recursive: true, force: true });
}
