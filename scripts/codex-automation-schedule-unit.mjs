import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
if (!process.env.CODEX_SCHEDULE_FIXTURE_CHILD) {
  for (const zone of ["UTC", "Asia/Shanghai", "America/New_York"]) process.stdout.write(execFileSync(process.execPath, [process.argv[1]], {
    env: { ...process.env, TZ: zone, CODEX_SCHEDULE_FIXTURE_CHILD: "1" }, encoding: "utf8" }));
  process.exit(0);
}
const root = path.resolve(import.meta.dirname, ".."), require = createRequire(import.meta.url);
const { recurrence } = require("../app/agent-service/codex-automation-schedule");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-schedule-parity-"));
try {
  const output = path.join(directory, "schedule.mjs");
  execFileSync(path.join(root, "app/manage-ui/node_modules/.bin/esbuild"), [path.join(root, "app/manage-ui/src/lib/codexAutomationSchedule.ts"),
    "--bundle", "--format=esm", `--outfile=${output}`], { stdio: "pipe" });
  const { codexScheduleTimes } = await import(pathToFileURL(output).href);
  const cases = [
    ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=30;BYSECOND=0", "Asia/Shanghai", "2026-09-28T00:00:00Z", "2026-10-05T00:00:00Z"],
    ["RRULE:FREQ=WEEKLY;BYDAY=SU;BYHOUR=2;BYMINUTE=30;BYSECOND=0", "America/New_York", "2026-03-07T00:00:00Z", "2026-03-16T00:00:00Z"],
    ["RRULE:FREQ=WEEKLY;BYDAY=SU;BYHOUR=1;BYMINUTE=30;BYSECOND=0", "America/New_York", "2026-11-01T00:00:00Z", "2026-11-09T00:00:00Z"],
    ["RRULE:FREQ=HOURLY;INTERVAL=3;BYMINUTE=0;BYSECOND=0", "America/New_York", "2026-11-01T00:00:00Z", "2026-11-03T00:00:00Z"],
  ];
  for (const [rrule, tz, from, until] of cases) {
    const anchorMs = Date.parse("2026-01-01T00:00:00Z"), fromMs = Date.parse(from), endMs = Date.parse(until);
    const rule = recurrence(rrule, anchorMs, tz), expected = [];
    let next = rule.after(new Date(fromMs), true);
    while (next && next.getTime() < endMs) { expected.push(next.getTime()); next = rule.after(next, false); }
    const actual = codexScheduleTimes({ kind: "rrule", rrule, tz, anchorMs }, fromMs, endMs);
    assert.deepEqual(actual, expected, `${process.env.TZ}: ${rrule}`);
    if (rrule.includes("BYHOUR=2")) assert.deepEqual(actual, [Date.parse("2026-03-15T06:30:00Z")], "nonexistent DST wall time is skipped");
    if (rrule.includes("BYHOUR=1")) assert.equal(actual[0], Date.parse("2026-11-01T05:30:00Z"), "first repeated DST wall time wins");
  }
  console.log(`PASS Codex weekly/hourly wall clock and DST Service/renderer parity in process TZ=${process.env.TZ}`);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
