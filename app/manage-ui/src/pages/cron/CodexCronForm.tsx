import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCodexAutomationModels } from "../../api/client";
import { Field, Option, Select, TextArea, TextInput } from "../../components/Field";
import type { CodexAutomationModel } from "../../types";
import "./CodexAutomation.css";

import { type CodexCronDraft } from "./codexCronDraft";
export * from "./codexCronDraft";
const DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
function fields(rrule: string): Record<string, string> { return Object.fromEntries(rrule.replace(/^RRULE:/, "").split(";").map(value => value.split("="))); }
function scheduleMode(rrule: string): "weekly" | "interval" | "advanced" {
  const value = fields(rrule);
  if (value.FREQ === "WEEKLY" && Object.keys(value).every(key => ["FREQ", "BYDAY", "BYHOUR", "BYMINUTE", "BYSECOND"].includes(key))
    && /^\d+$/.test(value.BYHOUR || "") && /^\d+$/.test(value.BYMINUTE || "")) return "weekly";
  if (["HOURLY", "MINUTELY"].includes(value.FREQ) && Object.keys(value).every(key => ["FREQ", "INTERVAL", "BYMINUTE", "BYSECOND"].includes(key))) return "interval";
  return "advanced";
}
export function CodexCronOptions({ draft, setDraft, backendId, timeZone, editing = false, targetEditable = true, disabled = false }: {
  draft: CodexCronDraft; setDraft: (value: CodexCronDraft) => void; backendId: string; timeZone?: string;
  editing?: boolean; targetEditable?: boolean; disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [models, setModels] = useState<CodexAutomationModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [mode, setMode] = useState(() => scheduleMode(draft.rrule));
  useEffect(() => {
    let current = true;
    if (draft.kind !== "cron") return;
    setModelsLoading(true); setModelError(null);
    getCodexAutomationModels(backendId).then(value => { if (current) setModels(value.models); })
      .catch(error => { if (current) { setModels([]); setModelError(String(error.message || error)); } })
      .finally(() => { if (current) setModelsLoading(false); });
    return () => { current = false; };
  }, [backendId, draft.kind, retry]);
  const set = <K extends keyof CodexCronDraft>(key: K, value: CodexCronDraft[K]) => setDraft({ ...draft, [key]: value });
  const value = fields(draft.rrule);
  const model = models.find(item => item.id === draft.model) || (!draft.model ? models.find(item => item.isDefault) : undefined);
  const efforts = model?.thinkingOptions || [];
  const weekly = (days: string[], time: string) => {
    const [hour, minute] = time.split(":").map(Number);
    set("rrule", `RRULE:FREQ=WEEKLY;BYDAY=${days.join(",")};BYHOUR=${hour};BYMINUTE=${minute};BYSECOND=0`);
  };
  const time = `${String(value.BYHOUR || 9).padStart(2, "0")}:${String(value.BYMINUTE || 0).padStart(2, "0")}`;
  const interval = (count: number, frequency = value.FREQ === "MINUTELY" ? "MINUTELY" : "HOURLY") => set("rrule", `RRULE:FREQ=${frequency};INTERVAL=${count};${frequency === "HOURLY" ? "BYMINUTE=0;" : ""}BYSECOND=0`);
  return <div className="codex-cron-options">
    <p className="codex-source-note">{t("codexAutomation.definitionNote")}</p>
    {!editing && <Field label={t("codexAutomation.kind")}><Select value={draft.kind} onChange={choice => set("kind", choice as CodexCronDraft["kind"])} disabled={disabled}>
      <Option value="cron">{t("codexAutomation.independent")}</Option><Option value="heartbeat">{t("codexAutomation.heartbeat")}</Option>
    </Select></Field>}
    <Field label={t("cronForm.scheduleLabel")}>
      <div className="field-row"><Select value={mode} disabled={disabled} onChange={choice => {
        const next = choice as typeof mode; setMode(next);
        if (next === "weekly") weekly(["MO", "TU", "WE", "TH", "FR"], "09:00");
        else if (next === "interval") interval(1, "HOURLY");
      }}><Option value="weekly">{t("codexAutomation.weekly")}</Option><Option value="interval">{t("codexAutomation.interval")}</Option><Option value="advanced">{t("codexAutomation.advanced")}</Option></Select>
        {mode === "weekly" && <TextInput type="time" value={time} disabled={disabled} aria-label={t("codexAutomation.time")} onChange={event => weekly((value.BYDAY || "MO,TU,WE,TH,FR").split(","), event.target.value)} />}
        {mode === "interval" && <><TextInput type="number" min={1} max={10080} value={Number(value.INTERVAL) || 1} disabled={disabled} aria-label={t("codexAutomation.interval")} onChange={event => interval(Number(event.target.value))} />
          {draft.kind === "heartbeat" ? <Select value={value.FREQ} disabled={disabled} onChange={choice => interval(Number(value.INTERVAL) || 1, choice)}><Option value="HOURLY">{t("codexAutomation.hours")}</Option><Option value="MINUTELY">{t("codexAutomation.minutes")}</Option></Select> : <span>{t("codexAutomation.hours")}</span>}</>}
      </div>
      {mode === "weekly" && <div className="codex-weekdays">{DAYS.map(day => <label key={day}><input type="checkbox" disabled={disabled} checked={(value.BYDAY || "").split(",").includes(day)} onChange={event => {
        const selected = new Set((value.BYDAY || "").split(",")); if (event.target.checked) selected.add(day); else selected.delete(day); weekly(DAYS.filter(item => selected.has(item)), time);
      }} />{t(`codexAutomation.days.${day}`)}</label>)}</div>}
      {mode === "advanced" && <TextInput value={draft.rrule} disabled={disabled} aria-label="RRULE" onChange={event => set("rrule", event.target.value)} />}
      <span className="muted">{t("codexAutomation.timeZone", { zone: timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone })}</span>
    </Field>
    {draft.kind === "cron" ? <>
      <div className="field-row">
        <Field label={t("cron.model")}><Select value={draft.model} disabled={disabled || modelsLoading} onChange={choice => setDraft({ ...draft, model: choice, reasoningEffort: "" })}>
          <Option value="">{t("codexAutomation.modelDefault")}</Option>
          {draft.model && !models.some(item => item.id === draft.model) && <Option value={draft.model}>{draft.model} · {t("codexAutomation.unavailableModel")}</Option>}
          {models.map(item => <Option key={item.id} value={item.id}>{item.name}</Option>)}
        </Select></Field>
        <Field label={t("codexAutomation.reasoning")}><Select value={draft.reasoningEffort} disabled={disabled || modelsLoading || !model} onChange={choice => set("reasoningEffort", choice)}>
          <Option value="">{t("codexAutomation.reasoningDefault")}</Option>
          {draft.reasoningEffort && !efforts.includes(draft.reasoningEffort) && <Option value={draft.reasoningEffort}>{draft.reasoningEffort} · {t("codexAutomation.unavailableModel")}</Option>}
          {efforts.map(effort => <Option value={effort} key={effort}>{t(`codexAutomation.efforts.${effort}`, { defaultValue: effort })}</Option>)}
        </Select></Field>
      </div>
      {modelError && <p className="codex-source-error" role="alert">{modelError} <button type="button" onClick={() => setRetry(value => value + 1)}>{t("common.retry")}</button></p>}
      <div className="field-row"><Field label={t("cronForm.shoggothWorkspace")}><TextInput value={draft.cwd} disabled={disabled || !targetEditable} placeholder="~" onChange={event => set("cwd", event.target.value)} /></Field>
        <Field label={t("codexAutomation.environment")}><Select value={draft.executionEnvironment} disabled={disabled || !targetEditable} onChange={choice => set("executionEnvironment", choice as CodexCronDraft["executionEnvironment"])}>
          <Option value="local">{t("codexAutomation.local")}</Option><Option value="worktree">{t("codexAutomation.worktree")}</Option>
        </Select></Field></div>
    </> : <><Field label={t("codexAutomation.targetThread")}><TextInput value={draft.targetThreadId} disabled={disabled} onChange={event => set("targetThreadId", event.target.value)} /></Field><p className="codex-source-note">{t("codexAutomation.heartbeatRunUnavailable")}</p></>}
  </div>;
}
export default function CodexCronForm({ draft, setDraft, backendId, timeZone, targetEditable, disabled }: {
  draft: CodexCronDraft; setDraft: (value: CodexCronDraft) => void; backendId: string; timeZone?: string; targetEditable?: boolean; disabled?: boolean;
}) {
  const { t } = useTranslation();
  return <div className="cron-form"><Field label={t("cronForm.taskNameLabel")}><TextInput value={draft.name} disabled={disabled} onChange={event => setDraft({ ...draft, name: event.target.value })} /></Field>
    <Field label={t("cronForm.taskPromptLabel")}><TextArea value={draft.prompt} disabled={disabled} rows={4} onChange={event => setDraft({ ...draft, prompt: event.target.value })} /></Field>
    <CodexCronOptions draft={draft} setDraft={setDraft} backendId={backendId} timeZone={timeZone} editing targetEditable={targetEditable} disabled={disabled} />
  </div>;
}
