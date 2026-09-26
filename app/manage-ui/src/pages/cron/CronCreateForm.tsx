import { useTranslation } from "react-i18next";
import { Field, TextArea, TextInput } from "../../components/Field";
import type { BackendDescriptor, UnifiedAgent } from "../../types";
import CronAgentPicker from "./CronAgentPicker";
import { CronScheduleType } from "./CronFormLayout";
import { CronExpressionPicker, DateTimePicker, IntervalPicker } from "./CronSchedulePicker";
import type { CronCreateDraft } from "./cronCreateDraft";

export default function CronCreateForm({ draft, setDraft, backends, agents, loading, failedBackends, onRetry, disabled }: {
  draft: CronCreateDraft;
  setDraft: (value: CronCreateDraft) => void;
  backends: BackendDescriptor[];
  agents: Record<string, UnifiedAgent[]>;
  loading: boolean;
  failedBackends: string[];
  onRetry: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const set = <K extends keyof CronCreateDraft>(key: K, value: CronCreateDraft[K]) => setDraft({ ...draft, [key]: value });
  const minInterval = backends.find((backend) => backend.id === draft.backendId)?.surfaces.cron?.kind === "openclaw" ? 1 / 60 : 1;
  return <div className="cron-form">
    <div className="field-row">
      <Field label={t("cronForm.taskNameLabel")}>
        <TextInput value={draft.name} onChange={(event) => set("name", event.target.value)} placeholder={t("cronForm.taskNamePlaceholder")} required />
      </Field>
      <CronAgentPicker value={draft} onChange={(assistant) => setDraft({ ...draft, ...assistant })}
        backends={backends} agents={agents} loading={loading} failedBackends={failedBackends} onRetry={onRetry} disabled={disabled} />
    </div>
    <Field label={t("cronForm.taskPromptLabel")}>
      <TextArea value={draft.prompt} onChange={(event) => set("prompt", event.target.value)} rows={4}
        placeholder={t("cronForm.taskPromptPlaceholder")} required />
    </Field>
    <div className="field">
      <span className="field-label">{t("cronForm.scheduleLabel")}</span>
      <CronScheduleType value={draft.schedKind} onChange={(value) => set("schedKind", value)} />
      <div className="cron-schedule-row">
        {draft.schedKind === "cron" && <CronExpressionPicker value={draft.cronExpr} onChange={(value) => set("cronExpr", value)} />}
        {draft.schedKind === "every" && <IntervalPicker value={draft.everyMin} onChange={(value) => set("everyMin", value)} minMinutes={minInterval} />}
        {draft.schedKind === "at" && <DateTimePicker value={draft.atLocal} onChange={(value) => set("atLocal", value)} />}
      </div>
    </div>
  </div>;
}
