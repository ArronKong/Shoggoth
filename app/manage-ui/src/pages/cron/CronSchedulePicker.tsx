import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Option, Select, TextInput } from "../../components/Field";
import { intervalLabel } from "./cronPresets";

type CronPatternMode = "minutes" | "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";

export interface CronPattern {
  mode: CronPatternMode;
  minute: number;
  hour: number;
  interval: number;
  weekday: number;
  monthDay: number;
}

const HOURS = Array.from({ length: 24 }, (_, value) => value);
const MINUTES = Array.from({ length: 60 }, (_, value) => value);
const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);
const MINUTE_INTERVALS = Array.from({ length: 59 }, (_, index) => index + 1);
const COMMON_INTERVAL_MINUTES = [
  1 / 60, 5 / 60, 10 / 60, 30 / 60,
  1, 5, 10, 15, 30, 60, 120, 240, 360, 720, 1440, 10080,
];
const COMMON_SECONDS = [0, 5, 10, 15, 30, 60, 120, 300, 600];

const WEEKDAY_KEYS = [
  "cron.weekdaySun",
  "cron.weekdayMon",
  "cron.weekdayTue",
  "cron.weekdayWed",
  "cron.weekdayThu",
  "cron.weekdayFri",
  "cron.weekdaySat",
];

function inRange(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : null;
}

// 只识别结构化选择器可以无损表达的常见五段 Cron；其它表达式作为只读旧值保留。
export function parseCronPattern(expression: string): CronPattern {
  const parts = expression.trim().split(/\s+/);
  const custom: CronPattern = { mode: "custom", minute: 0, hour: 9, interval: 15, weekday: 1, monthDay: 1 };
  if (parts.length !== 5) return custom;
  const [minutePart, hourPart, monthDayPart, monthPart, weekdayPart] = parts;
  if (monthPart !== "*") return custom;
  const intervalMatch = /^\*\/(\d+)$/.exec(minutePart);
  if (intervalMatch && hourPart === "*" && monthDayPart === "*" && weekdayPart === "*") {
    const interval = inRange(intervalMatch[1], 1, 59);
    return interval === null ? custom : { ...custom, mode: "minutes", interval };
  }
  const minute = inRange(minutePart, 0, 59);
  if (minute === null) return custom;
  if (hourPart === "*" && monthDayPart === "*" && weekdayPart === "*") {
    return { ...custom, mode: "hourly", minute };
  }
  const hour = inRange(hourPart, 0, 23);
  if (hour === null) return custom;
  if (monthDayPart === "*" && weekdayPart === "*") return { ...custom, mode: "daily", minute, hour };
  if (monthDayPart === "*" && weekdayPart === "1-5") return { ...custom, mode: "weekdays", minute, hour };
  const weekday = inRange(weekdayPart, 0, 6);
  if (monthDayPart === "*" && weekday !== null) {
    return { ...custom, mode: "weekly", minute, hour, weekday };
  }
  const monthDay = inRange(monthDayPart, 1, 31);
  if (monthDay !== null && weekdayPart === "*") {
    return { ...custom, mode: "monthly", minute, hour, monthDay };
  }
  return custom;
}

export function cronExpressionFromPattern(pattern: CronPattern): string {
  if (pattern.mode === "minutes") return `*/${pattern.interval} * * * *`;
  if (pattern.mode === "hourly") return `${pattern.minute} * * * *`;
  if (pattern.mode === "weekdays") return `${pattern.minute} ${pattern.hour} * * 1-5`;
  if (pattern.mode === "weekly") return `${pattern.minute} ${pattern.hour} * * ${pattern.weekday}`;
  if (pattern.mode === "monthly") return `${pattern.minute} ${pattern.hour} ${pattern.monthDay} * *`;
  return `${pattern.minute} ${pattern.hour} * * *`;
}

function nextPattern(mode: Exclude<CronPatternMode, "custom">, current: CronPattern): CronPattern {
  return {
    ...current,
    mode,
    interval: current.interval >= 1 && current.interval <= 59 ? current.interval : 15,
    minute: current.minute >= 0 && current.minute <= 59 ? current.minute : 0,
    hour: current.hour >= 0 && current.hour <= 23 ? current.hour : 9,
    weekday: current.weekday >= 0 && current.weekday <= 6 ? current.weekday : 1,
    monthDay: current.monthDay >= 1 && current.monthDay <= 31 ? current.monthDay : 1,
  };
}

function NumberSelect({ values, value, onChange, pad = false, className = "cron-number-select" }: {
  values: number[];
  value: number;
  onChange: (value: number) => void;
  pad?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <Select value={String(value)} onChange={(next) => onChange(Number(next))}>
        {values.map((option) => (
          <Option key={option} value={String(option)}>{pad ? String(option).padStart(2, "0") : option}</Option>
        ))}
      </Select>
    </div>
  );
}

export function CronExpressionPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  const pattern = useMemo(() => parseCronPattern(value), [value]);
  const update = (patch: Partial<CronPattern>) => {
    const updated = { ...pattern, ...patch };
    if (updated.mode !== "custom") onChange(cronExpressionFromPattern(updated));
  };
  return (
    <div className="cron-time-controls">
      <div className="cron-pattern-select">
        <Select
          value={pattern.mode}
          onChange={(mode) => {
            if (mode === "custom") return;
            onChange(cronExpressionFromPattern(nextPattern(mode as Exclude<CronPatternMode, "custom">, pattern)));
          }}
        >
          {pattern.mode === "custom" && (
            <Option value="custom">{t("cronForm.scheduleCurrentCustom", { value })}</Option>
          )}
          <Option value="minutes">{t("cronForm.scheduleEveryMinutes")}</Option>
          <Option value="hourly">{t("cronForm.scheduleHourly")}</Option>
          <Option value="daily">{t("cronForm.scheduleDaily")}</Option>
          <Option value="weekdays">{t("cronForm.scheduleWeekdays")}</Option>
          <Option value="weekly">{t("cronForm.scheduleWeekly")}</Option>
          <Option value="monthly">{t("cronForm.scheduleMonthly")}</Option>
        </Select>
      </div>
      {pattern.mode === "minutes" && (
        <NumberSelect values={MINUTE_INTERVALS} value={pattern.interval} onChange={(interval) => update({ interval })} />
      )}
      {pattern.mode === "hourly" && (
        <>
          <span className="cron-time-separator">:</span>
          <NumberSelect values={MINUTES} value={pattern.minute} onChange={(minute) => update({ minute })} pad />
        </>
      )}
      {(["daily", "weekdays", "weekly", "monthly"] as CronPatternMode[]).includes(pattern.mode) && (
        <>
          {pattern.mode === "weekly" && (
            <div className="cron-weekday-select">
              <Select value={String(pattern.weekday)} onChange={(weekday) => update({ weekday: Number(weekday) })}>
                {WEEKDAY_KEYS.map((key, weekday) => <Option key={key} value={String(weekday)}>{t(key)}</Option>)}
              </Select>
            </div>
          )}
          {pattern.mode === "monthly" && (
            <NumberSelect values={MONTH_DAYS} value={pattern.monthDay} onChange={(monthDay) => update({ monthDay })} />
          )}
          <NumberSelect values={HOURS} value={pattern.hour} onChange={(hour) => update({ hour })} pad />
          <span className="cron-time-separator">:</span>
          <NumberSelect values={MINUTES} value={pattern.minute} onChange={(minute) => update({ minute })} pad />
        </>
      )}
    </div>
  );
}

export function IntervalPicker({ value, onChange, minMinutes = 1 }: {
  value: number;
  onChange: (value: number) => void;
  minMinutes?: number;
}) {
  const { t } = useTranslation();
  const standard = COMMON_INTERVAL_MINUTES.filter((option) => option >= minMinutes);
  const known = standard.some((option) => option === value);
  return (
    <div className="cron-interval-select">
      <Select value={String(value)} onChange={(next) => onChange(Number(next))}>
        {!known && Number.isFinite(value) && value > 0 && (
          <Option value={String(value)}>{t("cronForm.intervalCurrentCustom", { value: intervalLabel(value, t) })}</Option>
        )}
        {standard.map((option) => (
          <Option key={option} value={String(option)}>{intervalLabel(option, t)}</Option>
        ))}
      </Select>
    </div>
  );
}

export function SecondsPicker({ value, onChange, label }: {
  value: number;
  onChange: (value: number) => void;
  label?: string;
}) {
  const { t } = useTranslation();
  const known = COMMON_SECONDS.includes(value);
  const optionLabel = (seconds: number) => {
    const duration = t("cronForm.durationSeconds", { count: seconds });
    return label ? `${label} · ${duration}` : duration;
  };
  return (
    <div className="cron-seconds-select">
      <Select value={String(value)} onChange={(next) => onChange(Number(next))}>
        {!known && Number.isFinite(value) && value >= 0 && (
          <Option value={String(value)}>{t("cronForm.intervalCurrentCustom", { value: optionLabel(value) })}</Option>
        )}
        {COMMON_SECONDS.map((seconds) => (
          <Option key={seconds} value={String(seconds)}>{optionLabel(seconds)}</Option>
        ))}
      </Select>
    </div>
  );
}

function localParts(value: string): { date: string; hour: number; minute: number } {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(value);
  return match
    ? { date: match[1], hour: Number(match[2]), minute: Number(match[3]) }
    : { date: "", hour: 9, minute: 0 };
}

export function DateTimePicker({ value, onChange, optional = false, label }: {
  value: string;
  onChange: (value: string) => void;
  optional?: boolean;
  label?: string;
}) {
  const { t } = useTranslation();
  const parts = localParts(value);
  const compose = (date: string, hour: number, minute: number) => {
    onChange(date ? `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` : "");
  };
  return (
    <div className="cron-time-controls">
      {label && <span className="cron-time-inline-label">{label}</span>}
      <TextInput
        type="date"
        value={parts.date}
        onChange={(event) => compose(event.target.value, parts.hour, parts.minute)}
      />
      <NumberSelect values={HOURS} value={parts.hour} onChange={(hour) => compose(parts.date, hour, parts.minute)} pad />
      <span className="cron-time-separator">:</span>
      <NumberSelect values={MINUTES} value={parts.minute} onChange={(minute) => compose(parts.date, parts.hour, minute)} pad />
      {optional && value && (
        <button type="button" className="cron-time-clear" onClick={() => onChange("")}>{t("common.clear")}</button>
      )}
    </div>
  );
}

function availableTimeZones(): string[] {
  const reader = (Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf;
  if (!reader) return ["UTC", "Asia/Shanghai", "Asia/Tokyo", "Europe/London", "America/New_York"];
  try {
    return reader("timeZone");
  } catch {
    return ["UTC", "Asia/Shanghai", "Asia/Tokyo", "Europe/London", "America/New_York"];
  }
}

const TIME_ZONES = availableTimeZones();

export function TimeZonePicker({ value, onChange, allowDefault = false }: {
  value: string;
  onChange: (value: string) => void;
  allowDefault?: boolean;
}) {
  const { t } = useTranslation();
  const options = TIME_ZONES.includes(value) || !value ? TIME_ZONES : [value, ...TIME_ZONES];
  return (
    <div className="cron-timezone-select">
      <Select value={value} onChange={onChange}>
        {allowDefault && <Option value="">{t("cronForm.timeZoneDefault")}</Option>}
        {options.map((zone) => <Option key={zone} value={zone}>{zone}</Option>)}
      </Select>
    </div>
  );
}
