#!/usr/bin/env node
// CRON-008: 非法 cron 字段（越界值、*/0、倒序 range、空集合）必须解析失败（null），
// 不得回退成 "*" 把错误放大成每分钟 1440 次的幽灵日程。
// 运行：node scripts/cron-occurrences-edge-unit.mjs

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const src = path.join(root, "app/manage-ui/src/lib/cronOccurrences.ts");
const esbuild = path.join(root, "app/manage-ui/node_modules/.bin/esbuild");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "cronocc-edge-"));
const out = path.join(outDir, "cronOccurrences.mjs");
execFileSync(esbuild, [src, "--format=esm", "--loader:.ts=ts", `--outfile=${out}`], { stdio: "pipe" });
const { occurrencesOnDay, hourlyOccurrencesOnDay, parseCronExpr } = await import(pathToFileURL(out).href);

const results = [];
const check = (name, cond) => { results.push({ name, ok: !!cond }); if (!cond) process.exitCode = 1; };
const DAY = new Date(2026, 6, 15);
const job = (expr) => ({ id: "j", name: "j", schedule: { kind: "cron", expr } });

for (const expr of ["61 * * * *", "* 24 * * *", "*/0 * * * *", "9-5x * * * *", "30-10 * * * *"]) {
  check(`parseCronExpr("${expr}") → null`, parseCronExpr(expr) === null);
  check(`"${expr}" 不产生 occurrence`, occurrencesOnDay(job(expr), DAY).count === 0);
  check(`"${expr}" hourly 为空`, hourlyOccurrencesOnDay(job(expr), DAY).size === 0);
}
// 合法表达式不回归
check("合法 0 9 * * * 仍 1 次", occurrencesOnDay(job("0 9 * * *"), DAY).count === 1);
check("合法 */15 仍 96 次", occurrencesOnDay(job("*/15 * * * *"), DAY).count === 96);
check("合法 range 0 9-17 * * * 仍 9 次", occurrencesOnDay(job("0 9-17 * * *"), DAY).count === 9);
check("合法 dow=7（周日别名）可解析", parseCronExpr("0 9 * * 7") !== null);
check("合法 dow range 5-7 可解析", parseCronExpr("0 9 * * 5-7") !== null);
// 无效 schedule 但后端给了 nextRunAt → 仍显示那一枚兜底 occurrence（既有行为）
{
  const withNext = { ...job("61 * * * *"), nextRunAt: new Date(2026, 6, 15, 10, 0).getTime() };
  check("无效表达式 + nextRunAt → 只显示兜底 1 次", occurrencesOnDay(withNext, DAY).count === 1);
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`RESULT ${results.length - failed}/${results.length} pass`);
process.exit(failed ? 1 : 0);
