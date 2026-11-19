import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Field, TextArea, TextInput } from "../../components/Field";
import type { CronSchedule } from "../../types";
import { CronExpressionPicker, DateTimePicker, IntervalPicker } from "./CronSchedulePicker";
import styles from "./CronFormLayout.module.css";

export function CronTaskNameRow({ name, onChange, assistant, disabled }: {
  name: string;
  onChange: (name: string) => void;
  assistant?: ReactNode;
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

export function CronTaskPromptField({ value, onChange, label, required }: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  required?: boolean;
}) {
  const { t } = useTranslation();
  return <Field label={label ?? t("cronForm.taskPromptLabel")}>
    <TextArea className={`field-textarea ${styles.prompt}`} value={value} rows={4}
      placeholder={t("cronForm.taskPromptPlaceholder")} required={required}
      onChange={(event) => onChange(event.target.value)} />
  </Field>;
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

type CronScheduleDraft = {
  schedKind: CronScheduleTypeValue;
  cronExpr: string;
  everyMin: number;
  atLocal: string;
};

export function CronScheduleField({ draft, onChange, minInterval }: {
  draft: Omit<CronScheduleDraft, "schedKind"> & { schedKind: CronSchedule["kind"] };
  onChange: (patch: Partial<CronScheduleDraft>) => void;
  minInterval?: number;
}) {
  const { t } = useTranslation();
  return <div className="field">
    <span className="field-label">{t("cronForm.scheduleLabel")}</span>
    <CronScheduleType value={draft.schedKind} onChange={(schedKind) => onChange({ schedKind })} />
    <div className="cron-schedule-row">
      {draft.schedKind === "cron" && <CronExpressionPicker value={draft.cronExpr} onChange={(cronExpr) => onChange({ cronExpr })} />}
      {draft.schedKind === "every" && <IntervalPicker value={draft.everyMin} onChange={(everyMin) => onChange({ everyMin })} minMinutes={minInterval} />}
      {draft.schedKind === "at" && <DateTimePicker value={draft.atLocal} onChange={(atLocal) => onChange({ atLocal })} />}
    </div>
  </div>;
}
