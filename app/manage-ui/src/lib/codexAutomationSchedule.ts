import { rrulestr } from "rrule";
import type { CronSchedule } from "../types";
export function codexScheduleTimes(schedule: Extract<CronSchedule, { kind: "rrule" }>, fromMs: number, endMs: number): number[] | null {
  try {
    if (!/^RRULE:FREQ=(WEEKLY|HOURLY|DAILY|MINUTELY)(;|$)/.test(schedule.rrule) || /[\r\n]/.test(schedule.rrule)) return null;
    const anchor = schedule.anchorMs ?? fromMs;
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: schedule.tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    const wall = (ms: number) => {
      const p = Object.fromEntries(formatter.formatToParts(ms).map(part => [part.type, Number(part.value)]));
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    };
    const rule = rrulestr(schedule.rrule, { dtstart: new Date(wall(anchor)), tzid: "UTC", cache: false });
    const times: number[] = [];
    let next = rule.after(new Date(wall(Math.max(fromMs, anchor))), true);
    // Resolve wall-clock dates independently of the browser's own timezone,
    // using the same RFC 5545 DST policy as the Service preview.
    while (next && next.getTime() <= wall(endMs) + 86400000) {
      if (times.length >= 1600) return null;
      const value = next.getTime();
      const offsets = new Set([-86400000, 0, 86400000].map(delta => wall(value + delta) - (value + delta)));
      const matches = [...offsets].map(offset => value - offset).filter(ms => wall(ms) === value).sort((a, b) => a - b);
      const ms = matches[0];
      if (ms !== undefined && ms >= fromMs && ms >= anchor && ms < endMs) times.push(ms);
      if (ms !== undefined && ms >= endMs) break;
      next = rule.after(next, false);
    }
    return times;
  } catch { return null; }
}
export function codexScheduleLabel(schedule: Extract<CronSchedule, { kind: "rrule" }>, t: (key: string, options?: Record<string, unknown>) => string): string {
  const values = Object.fromEntries(schedule.rrule.replace(/^RRULE:/, "").split(";").map(part => part.split("=")));
  if (values.FREQ === "WEEKLY" && values.BYDAY && /^\d+$/.test(values.BYHOUR || "") && /^\d+$/.test(values.BYMINUTE || "")) {
    return `${values.BYDAY.split(",").map((day: string) => t(`codexAutomation.days.${day}`)).join(", ")} ${String(values.BYHOUR).padStart(2, "0")}:${String(values.BYMINUTE).padStart(2, "0")} · ${schedule.tz || ""}`;
  }
  if (["HOURLY", "MINUTELY"].includes(values.FREQ)) return t("codexAutomation.every", { count: Number(values.INTERVAL) || 1, unit: t(values.FREQ === "HOURLY" ? "codexAutomation.hours" : "codexAutomation.minutes") });
  return schedule.rrule;
}
