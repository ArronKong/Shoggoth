#!/usr/bin/env node
// CRON-007: 日历"天"必须按本地时区的真实午夜切边界——DST 春季跳时日 23 小时、
// 秋季回拨日 25 小时，固定 dayStart+86_400_000 会漏/多一小时。
// 运行：node scripts/cron-occurrences-dst-unit.mjs（父进程自我 spawn 到目标 TZ）

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (!process.env.CRON_DST_CHILD) {
  // 父进程：按 TZ 跑子进程，透传输出与退出码（TZ 需在进程启动前设定才可靠）。
  let failed = false;
  for (const tz of ["America/New_York"]) {
    let out = "";
    try {
      out = execFileSync(process.execPath, [process.argv[1]], {
        env: { ...process.env, TZ: tz, CRON_DST_CHILD: "1" },
        encoding: "utf8",
      });
    } catch (err) {
      out = `${err.stdout || ""}${err.stderr || ""}`;
      failed = true;
    }
    process.stdout.write(out);
    if (/FAIL/.test(out)) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

const root = process.cwd();
const src = path.join(root, "app/manage-ui/src/lib/cronOccurrences.ts");
const esbuild = path.join(root, "app/manage-ui/node_modules/.bin/esbuild");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "cronocc-dst-"));
const out = path.join(outDir, "cronOccurrences.mjs");
execFileSync(esbuild, [src, "--format=esm", "--loader:.ts=ts", `--outfile=${out}`], { stdio: "pipe" });
const { occurrencesOnDay, hourlyOccurrencesOnDay } = await import(pathToFileURL(out).href);

const results = [];
const check = (name, cond) => { results.push({ name, ok: !!cond }); };

// America/New_York：2026-03-08 春季跳时（23h）、2026-11-01 秋季回拨（25h）
const SPRING = new Date(2026, 2, 8);
const FALL = new Date(2026, 10, 1);
const NORMAL = new Date(2026, 6, 15);
const hourlyEvery = (day) => ({
  id: "e", name: "e",
  schedule: { kind: "every", everyMs: 3600_000, anchorMs: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0).getTime() },
});

check("every-1h 普通日 = 24 次", occurrencesOnDay(hourlyEvery(NORMAL), NORMAL).count === 24);
check("every-1h 春季跳时日 = 23 次", occurrencesOnDay(hourlyEvery(SPRING), SPRING).count === 23);
check("every-1h 秋季回拨日 = 25 次", occurrencesOnDay(hourlyEvery(FALL), FALL).count === 25);

// 边界互斥：秋季日的第 25 枚不得吞掉次日 00:00
{
  const nextDay = new Date(2026, 10, 2);
  const dayOcc = occurrencesOnDay(hourlyEvery(FALL), FALL);
  const nextOcc = occurrencesOnDay(hourlyEvery(FALL), nextDay);
  const nextMidnight = new Date(2026, 10, 2, 0, 0, 0, 0).getTime();
  check("回拨日不吞次日 00:00", nextOcc.count > 0 && nextOcc.times[0] === nextMidnight);
  check("回拨日 25 枚全部 < 次日午夜", dayOcc.count === 25 && dayOcc.times.every((t) => t < nextMidnight));
}

// cron 墙钟任务：跳时日 2:30 不存在 → `30 2 * * *` 当天 0 次（不虚报）
check("跳时日 30 2 * * * = 0 次", occurrencesOnDay({ id: "c", name: "c", schedule: { kind: "cron", expr: "30 2 * * *" } }, SPRING).count === 0);
// cron 每小时：跳时日 = 23 次（2 点档缺席）
check("跳时日 0 * * * * = 23 次", occurrencesOnDay({ id: "c", name: "c", schedule: { kind: "cron", expr: "0 * * * *" } }, SPRING).count === 23);
// hourly 视图跳时日无 2 点桶
{
  const m = hourlyOccurrencesOnDay({ id: "c", name: "c", schedule: { kind: "cron", expr: "0 * * * *" } }, SPRING);
  check("hourly 跳时日无 2 点桶", !m.has(2) && m.size === 23);
}
// 回拨日 cron 每小时 = 每个墙钟小时一次（vixie：重复小时只跑一次）
check("回拨日 0 * * * * = 24 次", occurrencesOnDay({ id: "c", name: "c", schedule: { kind: "cron", expr: "0 * * * *" } }, FALL).count === 24);
// 普通日 cron 快路径不回归
check("普通日 */15 = 96 次", occurrencesOnDay({ id: "c", name: "c", schedule: { kind: "cron", expr: "*/15 * * * *" } }, NORMAL).count === 96);

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`RESULT ${results.length - failed}/${results.length} pass (TZ=${process.env.TZ})`);
process.exit(failed ? 1 : 0);
