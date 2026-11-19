import React, { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Option, Select } from "../../app/manage-ui/src/components/Field";
import { IconPlus } from "../../app/manage-ui/src/pages/cron/cronIcons";
import {
  CronExpressionPicker as SingleTimePicker,
  parseCronPattern,
} from "../../app/manage-ui/src/pages/cron/CronSchedulePicker";
import styles from "./CronMultipleTimesPreview.module.css";

export { DateTimePicker, IntervalPicker } from "../../app/manage-ui/src/pages/cron/CronSchedulePicker";

const HOURS = Array.from({ length: 24 }, (_, value) => value);
const MINUTES = Array.from({ length: 60 }, (_, value) => value);
const CLOCK_MODES = new Set(["daily", "weekdays", "weekly", "monthly"]);

type PreviewTime = { id: number; hour: number; minute: number };

function PreviewNumber({ values, value, label, onChange }: {
  values: number[];
  value: number;
  label: string;
  onChange: (value: number) => void;
}) {
  return <div className="cron-number-select">
    <Select value={String(value)} onChange={(next) => onChange(Number(next))} title={label} popupClassName="cron-time-select-popup">
      {values.map((number) => <Option key={number} value={String(number)}>{String(number).padStart(2, "0")}</Option>)}
    </Select>
  </div>;
}

export function CronExpressionPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { i18n } = useTranslation();
  const chinese = i18n.language.startsWith("zh");
  const pattern = parseCronPattern(value);
  const hourly = pattern.mode === "hourly";
  const [clockTimes, setClockTimes] = useState<PreviewTime[]>([]);
  const [hourlyTimes, setHourlyTimes] = useState<PreviewTime[]>([]);
  const nextId = useRef(1);
  if (!hourly && !CLOCK_MODES.has(pattern.mode)) return <SingleTimePicker value={value} onChange={onChange} />;

  const rows = hourly ? hourlyTimes : clockTimes;
  const setRows = hourly ? setHourlyTimes : setClockTimes;
  const addLabel = hourly ? (chinese ? "添加分钟" : "Add minute") : (chinese ? "添加时间" : "Add time");
  const add = () => {
    const id = nextId.current++;
    setRows((current) => {
      const last = current.at(-1) ?? pattern;
      return [...current, {
        id,
        hour: hourly ? 0 : (last.hour + 1) % 24,
        minute: hourly ? (last.minute + 15) % 60 : last.minute,
      }];
    });
  };
  const change = (id: number, patch: Partial<Pick<PreviewTime, "hour" | "minute">>) => {
    setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  };

  return <div className={styles.schedule} data-time-points={hourly ? "minute" : "clock"}>
    <SingleTimePicker value={value} onChange={onChange} />
    <button type="button" className={styles.add} onClick={add} aria-label={addLabel} title={addLabel}><IconPlus /></button>
    {rows.length > 0 && <div className={styles.extras}>
      {rows.map((row, index) => {
        const position = index + 2;
        return <div className={styles.row} key={row.id}>
          {!hourly && <PreviewNumber values={HOURS} value={row.hour} onChange={(hour) => change(row.id, { hour })}
            label={chinese ? `第 ${position} 个时间点的小时` : `Time ${position} hour`} />}
          <span className="cron-time-separator" aria-hidden="true">:</span>
          <PreviewNumber values={MINUTES} value={row.minute} onChange={(minute) => change(row.id, { minute })}
            label={chinese ? `第 ${position} 个时间点的分钟` : `Time ${position} minute`} />
          <button type="button" className={styles.remove} onClick={() => setRows((current) => current.filter(({ id }) => id !== row.id))}
            aria-label={chinese ? `移除第 ${position} 个时间点` : `Remove time ${position}`}>×</button>
        </div>;
      })}
    </div>}
  </div>;
}
