#!/usr/bin/env node
// Regression: the cron calendar's week/day views must show high-frequency jobs
// across the WHOLE day.
//
// occurrencesOnDay materializes at most TIME_CAP(8) run-times per day — enough for
// the month view's tooltip. The week/day views used to bucket those 8 times into
// hour cells, so `*/15 * * * *` (96 runs) only ever appeared at 00:00–01:45 and
// looked like it stopped running at 2am. hourlyOccurrencesOnDay is exact per hour.
//
// The lib is TypeScript; transpile it with the UI's own esbuild and import the
// real function rather than asserting on source text.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const src = path.join(root, "app/manage-ui/src/lib/cronOccurrences.ts");
const esbuild = path.join(root, "app/manage-ui/node_modules/.bin/esbuild");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "cronocc-"));
const out = path.join(outDir, "cronOccurrences.mjs");
execFileSync(esbuild, [src, "--format=esm", "--loader:.ts=ts", `--outfile=${out}`], { stdio: "pipe" });

const { hourlyOccurrencesOnDay, occurrencesOnDay } = await import(pathToFileURL(out).href);

const results = [];
const check = (name, cond) => results.push({ name, ok: !!cond });

const DAY = new Date(2026, 6, 15); // Wed 2026-07-15, local
const cronJob = (expr) => ({ id: "j", name: "j", schedule: { kind: "cron", expr } });
const everyJob = (everyMs, anchorMs) => ({ id: "e", name: "e", schedule: { kind: "every", everyMs, anchorMs } });

// --- the reported bug -------------------------------------------------------
{
  const hourly = hourlyOccurrencesOnDay(cronJob("*/15 * * * *"), DAY);
  check("*/15 → all 24 hours present", hourly.size === 24);
  check("*/15 → 4 runs every hour", [...hourly.values()].every((h) => h.count === 4));
  check("*/15 → 96 runs total", [...hourly.values()].reduce((a, h) => a + h.count, 0) === 96);
  check("*/15 → afternoon hour 14 is present (was empty before)", hourly.has(14));
  check("*/15 → hour 14 first run is 14:00", new Date(hourly.get(14).first).getHours() === 14 &&
    new Date(hourly.get(14).first).getMinutes() === 0);

  // The month view keeps its bounded sample — that behavior is intentional.
  const day = occurrencesOnDay(cronJob("*/15 * * * *"), DAY);
  check("month view still caps materialized times at 8", day.times.length === 8);
  check("month view count stays exact (96)", day.count === 96);
  check("month view flags capped", day.capped === true);
}

// --- other schedules --------------------------------------------------------
{
  const hourly = hourlyOccurrencesOnDay(cronJob("*/5 * * * *"), DAY);
  check("*/5 → 24 hours, 12 runs each", hourly.size === 24 && [...hourly.values()].every((h) => h.count === 12));
}
{
  const hourly = hourlyOccurrencesOnDay(cronJob("30 9 * * *"), DAY);
  check("daily 09:30 → exactly one hour bucket", hourly.size === 1 && hourly.has(9));
  check("daily 09:30 → one run", hourly.get(9).count === 1);
  check("daily 09:30 → at 09:30", new Date(hourly.get(9).first).getMinutes() === 30);
}
{
  const hourly = hourlyOccurrencesOnDay(cronJob("0 9,17 * * *"), DAY);
  check("09:00 & 17:00 → two buckets", hourly.size === 2 && hourly.has(9) && hourly.has(17));
}
{
  // every 30 minutes, anchored to midnight of that day
  const anchor = new Date(2026, 6, 15, 0, 0, 0, 0).getTime();
  const hourly = hourlyOccurrencesOnDay(everyJob(30 * 60_000, anchor), DAY);
  check("every 30m → 24 hours × 2 runs", hourly.size === 24 && [...hourly.values()].every((h) => h.count === 2));
  check("every 30m → hour 20 present", hourly.has(20));
}
{
  // A job created midday must not show morning runs.
  const createdAt = new Date(2026, 6, 15, 12, 0, 0, 0).getTime();
  const job = { ...cronJob("0 * * * *"), createdAt };
  const hourly = hourlyOccurrencesOnDay(job, DAY);
  check("createdAt clipping → no runs before noon", ![...hourly.keys()].some((h) => h < 12));
  check("createdAt clipping → runs from noon on", hourly.has(12) && hourly.has(23) && hourly.size === 12);
}
{
  // Unexpandable schedule falls back to the backend's nextRunAt.
  const nextRunAt = new Date(2026, 6, 15, 3, 7, 0, 0).getTime();
  const hourly = hourlyOccurrencesOnDay({ id: "x", name: "x", schedule: { kind: "weird" }, nextRunAt }, DAY);
  check("fallback → single bucket at nextRunAt's hour", hourly.size === 1 && hourly.has(3));
}
{
  // A day the cron doesn't match yields nothing.
  const hourly = hourlyOccurrencesOnDay(cronJob("0 9 * * 0"), DAY); // Sundays only; DAY is a Wed
  check("non-matching weekday → no buckets", hourly.size === 0);
}

// --- staggerMs: the backend's nextRunAt overrides the expanded base time ------
// OpenClaw 的 cron 可以配 stagger 错峰，实际触发比表达式基准晚最多 staggerMs。
// 展开器看不到这个偏移，格内排序会把 `0 */8`(基准 16:00，实到 16:03:05) 误排在
// 无 stagger 的 `2 */4`(16:02) 之前——日历上"下一个要跑的"高亮就跳到了第三行。
{
  const staggered = new Date(2026, 6, 15, 16, 3, 5, 0).getTime();
  const hourly = hourlyOccurrencesOnDay({ ...cronJob("0 */8 * * *"), nextRunAt: staggered }, DAY);
  check("stagger → next-run hour bucket uses nextRunAt", hourly.get(16)?.first === staggered);
  check("stagger → other hours keep the expanded base time", hourly.get(8)?.first === new Date(2026, 6, 15, 8, 0, 0, 0).getTime());
  check("stagger → run count per hour unchanged", hourly.get(16)?.count === 1);
  // 真实顺序：无 stagger 的 2 */4 (16:02) 先于带 stagger 的 0 */8 (16:03:05)。
  const plain = hourlyOccurrencesOnDay(
    { ...cronJob("2 */4 * * *"), nextRunAt: new Date(2026, 6, 15, 16, 2, 0, 0).getTime() },
    DAY,
  );
  check("stagger → ordering now matches real fire order", plain.get(16).first < hourly.get(16).first);
}
{
  // 权威值只许把时间往后修：早于展开基准的 nextRunAt（陈旧快照）不得改写桶。
  const stale = new Date(2026, 6, 15, 16, 0, 0, 0).getTime();
  const hourly = hourlyOccurrencesOnDay({ ...cronJob("30 16 * * *"), nextRunAt: stale }, DAY);
  check("stale nextRunAt → bucket keeps the expanded time", hourly.get(16)?.first === new Date(2026, 6, 15, 16, 30, 0, 0).getTime());
}

fs.rmSync(outDir, { recursive: true, force: true });

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
