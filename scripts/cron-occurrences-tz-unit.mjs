#!/usr/bin/env node
// CRON-006: cron wall-clock 按 job 的 schedule.tz 解释，再换算到浏览器时区显示。
// 浏览器 Asia/Shanghai + schedule tz=UTC 的 "0 9 * * *" → 本地 17:00，不是 09:00。
// 运行：node scripts/cron-occurrences-tz-unit.mjs

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (!process.env.CRON_TZ_CHILD) {
  let out = "";
  let failed = false;
  try {
    out = execFileSync(process.execPath, [process.argv[1]], {
      env: { ...process.env, TZ: "Asia/Shanghai", CRON_TZ_CHILD: "1" },
      encoding: "utf8",
    });
  } catch (err) {
    out = `${err.stdout || ""}${err.stderr || ""}`;
    failed = true;
  }
  process.stdout.write(out);
  process.exit(failed || /FAIL/.test(out) ? 1 : 0);
}

const root = process.cwd();
const src = path.join(root, "app/manage-ui/src/lib/cronOccurrences.ts");
const esbuild = path.join(root, "app/manage-ui/node_modules/.bin/esbuild");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "cronocc-tz-"));
const out = path.join(outDir, "cronOccurrences.mjs");
execFileSync(esbuild, [src, "--format=esm", "--loader:.ts=ts", `--outfile=${out}`], { stdio: "pipe" });
const { occurrencesOnDay, hourlyOccurrencesOnDay } = await import(pathToFileURL(out).href);

const results = [];
const check = (name, cond) => { results.push({ name, ok: !!cond }); };
const DAY = new Date(2026, 6, 15); // 本地(上海) 2026-07-15 周三
const tzJob = (expr, tz) => ({ id: "j", name: "j", schedule: { kind: "cron", expr, tz } });

// UTC 09:00 = 上海 17:00
{
  const occ = occurrencesOnDay(tzJob("0 9 * * *", "UTC"), DAY);
  check("UTC 0 9 → 当天 1 次", occ.count === 1);
  check("UTC 0 9 → 本地 17:00", occ.count === 1 && new Date(occ.times[0]).getHours() === 17);
  const hourly = hourlyOccurrencesOnDay(tzJob("0 9 * * *", "UTC"), DAY);
  check("hourly 桶在 17 点", hourly.has(17) && !hourly.has(9));
}
// UTC 周二 23:30 = 上海周三 07:30 —— dow 按 schedule tz 判定
{
  const occ = occurrencesOnDay(tzJob("30 23 * * 2", "UTC"), DAY); // dow=2 = UTC 的周二
  check("跨日 dow 按 tz 判定：本地周三 07:30 出现", occ.count === 1 && new Date(occ.times[0]).getHours() === 7 && new Date(occ.times[0]).getMinutes() === 30);
}
// 同 tz（Asia/Shanghai 显式声明）与无 tz 行为一致
{
  const withTz = occurrencesOnDay(tzJob("0 9 * * *", "Asia/Shanghai"), DAY);
  const noTz = occurrencesOnDay({ id: "j", name: "j", schedule: { kind: "cron", expr: "0 9 * * *" } }, DAY);
  check("同 tz 声明与本地一致", withTz.count === noTz.count && withTz.times[0] === noTz.times[0]);
}
// 非法 tz 回退本地解释（fail-soft，不抛）
{
  const occ = occurrencesOnDay(tzJob("0 9 * * *", "Not/AZone"), DAY);
  check("非法 tz fail-soft 回退本地", occ.count === 1 && new Date(occ.times[0]).getHours() === 9);
}
// 高频表达式计数守恒：*/30 全天 48 次（tz 只平移不增减）
check("UTC */30 全天仍 48 次", occurrencesOnDay(tzJob("*/30 * * * *", "UTC"), DAY).count === 48);
// hourly 视图跨 tz 计数守恒
{
  const hourly = hourlyOccurrencesOnDay(tzJob("*/30 * * * *", "UTC"), DAY);
  check("hourly UTC */30 全天 48 次", [...hourly.values()].reduce((a, h) => a + h.count, 0) === 48);
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`RESULT ${results.length - failed}/${results.length} pass (TZ=${process.env.TZ})`);
process.exit(failed ? 1 : 0);
