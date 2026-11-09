import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Field, TextInput } from "../../components/Field";
import type { CronSchedule } from "../../types";

export function CronTaskNameRow({ name, onChange, assistant, disabled }: {
  name: string;
  onChange: (name: string) => void;
  assistant: ReactNode;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return <div className="field-row">
    <Field label={t("cronForm.taskNameLabel")}>
      <TextInput value={name} onChange={(event) => onChange(event.target.value)}
        placeholder={t("cronForm.taskNamePlaceholder")} disabled={disabled} required />
    </Field>
    {assistant}
  </div>;
}

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
