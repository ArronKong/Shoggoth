"use strict";

const { rrulestr } = require("rrule");
const { serviceError } = require("./security");
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const weekdays = new Set(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);

// Current desktop cron schedules are local wall-clock weekly/hourly rules.
// Preserve advanced source values for display, but never silently rewrite them.
function validateSchedule(rrule, kind = "cron") {
  if (typeof rrule !== "string" || !rrule.startsWith("RRULE:") || rrule.length > 2048 || /[\r\n]/u.test(rrule)) throw serviceError("CODEX_AUTOMATION_SCHEDULE_UNSUPPORTED", "Unsupported schedule");
  const body = rrule.replace(/^RRULE:/u, "");
  const parts = body.split(";");
  if (parts.some(part => !/^[A-Z]+=[A-Z0-9,]+$/u.test(part))) throw serviceError("CODEX_AUTOMATION_SCHEDULE_UNSUPPORTED", "Unsupported schedule");
  const values = Object.fromEntries(parts.map(part => part.split("=")));
  if (Object.keys(values).length !== body.split(";").length
    || Object.keys(values).some(key => !["FREQ", "INTERVAL", "BYDAY", "BYHOUR", "BYMINUTE", "BYSECOND"].includes(key))
    || !(kind === "cron" ? ["WEEKLY", "HOURLY"] : ["WEEKLY", "HOURLY", "DAILY", "MINUTELY"]).includes(values.FREQ)
    || (values.INTERVAL !== undefined && (!/^\d+$/u.test(values.INTERVAL) || Number(values.INTERVAL) < 1 || Number(values.INTERVAL) > 10080))
    || (values.BYDAY !== undefined && values.BYDAY.split(",").some(day => !weekdays.has(day)))) {
    throw serviceError("CODEX_AUTOMATION_SCHEDULE_UNSUPPORTED", "Unsupported schedule");
  }
  for (const [key, max] of [["BYHOUR", 23], ["BYMINUTE", 59], ["BYSECOND", 59]]) {
    if (values[key] !== undefined && values[key].split(",").some(value => !/^\d+$/u.test(value) || Number(value) > max)) {
      throw serviceError("CODEX_AUTOMATION_SCHEDULE_UNSUPPORTED", "Unsupported schedule");
    }
  }
  try { rrulestr(`RRULE:${body}`); }
  catch { throw serviceError("CODEX_AUTOMATION_SCHEDULE_UNSUPPORTED", "Unsupported schedule"); }
  return rrule;
}
function recurrence(rrule, anchorMs, tz = TIMEZONE) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const wall = ms => {
    const p = Object.fromEntries(formatter.formatToParts(ms).map(part => [part.type, Number(part.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  };
  // Expand floating wall-clock dates in UTC, then resolve the IANA offset.
  // rrule's TZID path depends on the process timezone, which is unsuitable
  // for a Service and renderer that can run with different local settings.
  const rule = rrulestr(rrule, { dtstart: new Date(wall(anchorMs)), tzid: "UTC", cache: false });
  const instant = value => {
    const offsets = new Set([-86400000, 0, 86400000].map(delta => wall(value + delta) - (value + delta)));
    const matches = [...offsets].map(offset => value - offset).filter(ms => wall(ms) === value).sort((a, b) => a - b);
    // RFC 5545: ignore nonexistent times and choose the first repeated time.
    return matches[0] ?? null;
  };
  return { after(date, inclusive = false) {
    let next = rule.after(new Date(wall(date.getTime())), true);
    for (let attempt = 0; next && attempt < 128; attempt += 1) {
      const ms = instant(next.getTime());
      if (ms !== null && (ms > date.getTime() || (inclusive && ms === date.getTime()))) return new Date(ms);
      next = rule.after(next, false);
    }
    return null;
  } };
}
function nextOccurrence(rrule, anchorMs, afterMs, kind = "cron") {
  try { validateSchedule(rrule, kind); return recurrence(rrule, anchorMs).after(new Date(afterMs), false)?.getTime() ?? null; }
  catch { return null; }
}
module.exports = { TIMEZONE, validateSchedule, recurrence, nextOccurrence };
