// Shared cron-schedule helpers for the Hermes/OpenClaw cron forms: a best-effort
// cron→human summary and a deliver-target preset picker.
import { useTranslation } from "react-i18next";
import { Option, Select } from "../../components/Field";
import type { UnifiedCronJob } from "../../types";

type Translate = (key: string, opts?: Record<string, unknown>) => string;

// cron dow index (0=Sun..6=Sat) → existing weekday i18n keys (reused, not redefined).
const WEEKDAY_KEYS = [
  "cron.weekdaySun",
  "cron.weekdayMon",
  "cron.weekdayTue",
  "cron.weekdayWed",
  "cron.weekdayThu",
  "cron.weekdayFri",
  "cron.weekdaySat",
];

// Best-effort human summary for the common 5-field cron shapes the presets
// produce (and typical hand-written ones). Returns "" for shapes we don't
// recognize, so the UI just shows the raw expression with no (possibly wrong)
// gloss.
export function cronToHuman(expr: string, t: Translate): string {
  const parts = (expr || "").trim().split(/\s+/);
  if (parts.length !== 5) return "";
  const [min, hour, dom, mon, dow] = parts;
  const inRange = (s: string, max: number, min = 0) => /^\d+$/.test(s) && Number(s) >= min && Number(s) <= max;
  const hhmm = `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  if (hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    if (min === "*") return t("cronForm.humanEveryNMin", { n: 1 });
    if (/^\*\/\d+$/.test(min) && inRange(min.slice(2), 59, 1)) {
      const step = Number(min.slice(2));
      // Cron steps restart each hour, so */7 is not a fixed seven-minute interval.
      return 60 % step === 0
        ? t("cronForm.humanEveryNMin", { n: step })
        : t("cronForm.humanMinuteSteps", { n: step });
    }
    if (inRange(min, 59)) return t("cronForm.humanHourlyAt", { m: min.padStart(2, "0") });
  }
  if (inRange(min, 59) && inRange(hour, 23) && dom === "*" && mon === "*") {
    if (dow === "*") return t("cronForm.humanDaily", { time: hhmm });
    if (dow === "1-5") return t("cronForm.humanWeekdays", { time: hhmm });
    if (/^[0-7]$/.test(dow)) return t("cronForm.humanWeekly", { day: t(WEEKDAY_KEYS[Number(dow) % 7]), time: hhmm });
  }
  if (inRange(min, 59) && inRange(hour, 23) && inRange(dom, 31, 1) && mon === "*" && dow === "*")
    return t("cronForm.humanMonthly", { day: dom, time: hhmm });
  return "";
}

export function intervalLabel(minutes: number, t: Translate): string {
  const seconds = minutes * 60;
  if (minutes < 1 && Number.isInteger(seconds)) return t("cronForm.intervalSeconds", { count: seconds });
  if (minutes < 60) return t("cronForm.intervalMinutes", { count: minutes });
  if (minutes % 10080 === 0) return t("cronForm.intervalWeeks", { count: minutes / 10080 });
  if (minutes % 1440 === 0) return t("cronForm.intervalDays", { count: minutes / 1440 });
  if (minutes % 60 === 0) return t("cronForm.intervalHours", { count: minutes / 60 });
  return t("cronForm.intervalMinutes", { count: minutes });
}

export function formatCronTime(value: number | string | null | undefined, locale: string): string {
  if (value == null || value === "") return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    ...(date.getSeconds() ? { second: "2-digit" as const } : {}),
  }).format(date);
}

// Keep raw schedule expressions in the editor; the overview describes when it runs.
export function scheduleText(job: UnifiedCronJob, t: Translate, locale: string): string {
  const schedule = job.schedule;
  if (schedule.kind === "every") {
    if (!Number.isFinite(schedule.everyMs) || schedule.everyMs <= 0) return "—";
    const interval = intervalLabel(schedule.everyMs / 60000, t);
    const anchor = formatCronTime(schedule.anchorMs, locale);
    return anchor === "—" ? interval : `${interval} · ${t("cron.startsAt", { time: anchor })}`;
  }
  if (schedule.kind === "at") {
    const time = formatCronTime(schedule.at, locale);
    return time === "—" ? t("cron.oneTime") : t("cron.singleRunAt", { time });
  }
  if (schedule.kind === "on-exit") return t("cron.onExit", { command: schedule.command });
  if (schedule.kind === "stream") return t("cron.stream", { command: schedule.command.join(" ") });
  if (schedule.kind !== "cron") return "—";
  let text = cronToHuman(schedule.expr, t) || t("cron.customSchedule");
  if (schedule.tz) {
    try {
      const zone = new Intl.DateTimeFormat(locale, { timeZone: schedule.tz, timeZoneName: "longGeneric" });
      if (zone.resolvedOptions().timeZone !== new Intl.DateTimeFormat().resolvedOptions().timeZone) {
        text += ` · ${zone.formatToParts().find((part) => part.type === "timeZoneName")?.value || schedule.tz}`;
      }
    } catch {
      text += ` · ${t("cron.invalidTimeZone")}`;
    }
  }
  if (schedule.staggerMs && schedule.staggerMs > 0) {
    text += ` · ${t("cron.staggerUpTo", { seconds: schedule.staggerMs / 1000 })}`;
  }
  return text;
}

export const DELIVER_PRESETS = ["local", "origin", "all", "telegram", "discord", "slack", "email"];

// Quick-pick for the Hermes deliver target — fills the free-text field so the
// user can still append a specifier (e.g. "telegram:<chat-id>") afterwards.
export function DeliverPresetSelect({ onPick }: { onPick: (value: string) => void }) {
  const { t } = useTranslation();
  return (
    <Select
      value=""
      onChange={(v) => {
        if (v) onPick(v);
      }}
    >
      <Option value="">{t("cronForm.deliverPreset")}</Option>
      {DELIVER_PRESETS.map((d) => (
        <Option key={d} value={d}>
          {d}
        </Option>
      ))}
    </Select>
  );
}
