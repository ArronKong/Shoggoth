import { useTranslation } from "react-i18next";
import type { CronSchedule } from "../../types";

export const CRON_SCHEDULE_TYPES = ["cron", "every", "at"] as const;
type CronScheduleTypeValue = (typeof CRON_SCHEDULE_TYPES)[number];

export function CronScheduleType({ value, onChange }: {
  value: CronSchedule["kind"];
  onChange: (value: CronScheduleTypeValue) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="cron-form-schedule-types" role="group" aria-label={t("cronForm.scheduleLabel")}>
      {CRON_SCHEDULE_TYPES.map((kind) => (
        <button key={kind} type="button" aria-pressed={value === kind} onClick={() => onChange(kind)}>
          {t(`cronForm.scheduleType_${kind}`)}
        </button>
      ))}
      {(value === "on-exit" || value === "stream") && (
        <span className="cron-form-custom-trigger">{t(value === "on-exit" ? "cronForm.openclawSchedOnExit" : "cronForm.openclawSchedStream")}</span>
      )}
    </div>
  );
}
