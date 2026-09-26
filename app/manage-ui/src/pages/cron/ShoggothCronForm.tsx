import { useTranslation } from "react-i18next";
import { Field, TextArea, TextInput } from "../../components/Field";
import type { NativeCronJobInput, UnifiedCronJob } from "../../types";
import { CronExpressionPicker, DateTimePicker, IntervalPicker } from "./CronSchedulePicker";
import { CronScheduleType } from "./CronFormLayout";

type ScheduleKind = "cron" | "every" | "at";

export interface NativeCronDraft {
  backendId: string;
  agentId: string;
  name: string;
  prompt: string;
  workspace: string;
  enabled: boolean;
  schedKind: ScheduleKind;
  cronExpr: string;
  cronTz: string;
  everyMin: number;
  atLocal: string;
  misfirePolicy: "skip" | "latest" | "all-bounded";
  maxCatchUp: number;
  overlapPolicy: "skip" | "queue";
  threadPolicy: "new" | "continue";
  threadId: string;
}

function isoToLocalInput(iso?: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function emptyNativeCronDraft(backendId: string, agentId = ""): NativeCronDraft {
  return {
    backendId,
    agentId,
    name: "",
    prompt: "",
    workspace: "",
    enabled: true,
    schedKind: "cron",
    cronExpr: "0 9 * * *",
    cronTz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    everyMin: 60,
    atLocal: "",
    misfirePolicy: "latest",
    maxCatchUp: 1,
    overlapPolicy: "skip",
    threadPolicy: "new",
    threadId: "",
  };
}

export function nativeCronDraftFromJob(job: UnifiedCronJob): NativeCronDraft {
  const base = emptyNativeCronDraft(job.backendId, job.agentId || "");
  const raw = job.backendDetails?.raw;
  const schedule = job.schedule;
  const threadPolicy = raw?.threadPolicy === "continue" ? "continue" : "new";
  return {
    ...base,
    name: job.name || "",
    prompt: job.prompt || "",
    enabled: job.enabled,
    schedKind: schedule.kind === "cron" || schedule.kind === "every" || schedule.kind === "at"
      ? schedule.kind
      : base.schedKind,
    cronExpr: schedule.kind === "cron" ? schedule.expr : base.cronExpr,
    cronTz: schedule.kind === "cron" ? schedule.tz || base.cronTz : base.cronTz,
    everyMin: schedule.kind === "every" ? Math.max(1, schedule.everyMs / 60_000) : base.everyMin,
    atLocal: schedule.kind === "at" ? isoToLocalInput(schedule.at) : "",
    workspace: typeof raw?.workspace === "string" ? raw.workspace : "",
    misfirePolicy: raw?.misfirePolicy === "skip" || raw?.misfirePolicy === "all-bounded"
      ? raw.misfirePolicy : "latest",
    maxCatchUp: Number.isSafeInteger(raw?.maxCatchUp) ? Number(raw?.maxCatchUp) : 1,
    overlapPolicy: raw?.overlapPolicy === "queue" ? "queue" : "skip",
    threadPolicy,
    threadId: threadPolicy === "continue" && typeof raw?.threadId === "string" ? raw.threadId : "",
  };
}

export function validateNativeCronDraft(draft: NativeCronDraft): string | null {
  if (!draft.agentId.trim()) return "cronForm.nativeValidateAgent";
  if (!draft.name.trim()) return "cron.nameRequired";
  if (!draft.prompt.trim()) return "cronForm.nativeValidatePrompt";
  if (!Number.isSafeInteger(draft.maxCatchUp) || draft.maxCatchUp < 1 || draft.maxCatchUp > 100) {
    return "cronForm.shoggothValidateCatchUp";
  }
  if (draft.schedKind === "cron" && !draft.cronExpr.trim()) return "cronForm.shoggothValidateCron";
  if (draft.schedKind === "every" && (!Number.isFinite(draft.everyMin) || draft.everyMin < 1)) {
    return "cronForm.shoggothValidateEvery";
  }
  if (draft.schedKind === "at" && (!draft.atLocal || Number.isNaN(new Date(draft.atLocal).getTime()))) {
    return "cronForm.shoggothValidateAt";
  }
  return null;
}

export function nativeCronInputFromDraft(draft: NativeCronDraft): NativeCronJobInput {
  const schedule: NativeCronJobInput["schedule"] = draft.schedKind === "at"
    ? { kind: "at", at: new Date(draft.atLocal).toISOString() }
    : draft.schedKind === "every"
      ? { kind: "every", everyMs: Math.max(60_000, Math.round(draft.everyMin * 60_000)) }
      : {
          kind: "cron",
          expr: draft.cronExpr.trim(),
          ...(draft.cronTz.trim() ? { tz: draft.cronTz.trim() } : {}),
        };
  return {
    backendId: draft.backendId,
    agentId: draft.agentId.trim(),
    name: draft.name.trim(),
    prompt: draft.prompt,
    enabled: draft.enabled,
    workspace: draft.workspace.trim() || null,
    schedule,
    misfirePolicy: draft.misfirePolicy,
    maxCatchUp: draft.maxCatchUp,
    overlapPolicy: draft.overlapPolicy,
    threadPolicy: draft.threadPolicy,
    threadId: draft.threadPolicy === "continue" ? draft.threadId.trim() || null : null,
  };
}

export function nativeCronDraftWithThreadPolicy(
  draft: NativeCronDraft,
  threadPolicy: NativeCronDraft["threadPolicy"],
): NativeCronDraft {
  return { ...draft, threadPolicy, ...(threadPolicy === "new" ? { threadId: "" } : {}) };
}

export function nativeCronEditPlan(
  draft: NativeCronDraft,
  original: UnifiedCronJob,
): {
  patch: Partial<Omit<NativeCronJobInput, "backendId" | "agentId" | "enabled">>;
  enabled: boolean | null;
} {
  const input = nativeCronInputFromDraft(draft);
  const patch = {
    name: input.name,
    prompt: input.prompt,
    workspace: input.workspace,
    schedule: input.schedule,
    misfirePolicy: input.misfirePolicy,
    maxCatchUp: input.maxCatchUp,
    overlapPolicy: input.overlapPolicy,
    threadPolicy: input.threadPolicy,
    threadId: input.threadId,
  };
  return { patch, enabled: input.enabled === original.enabled ? null : input.enabled ?? null };
}

// Compatibility names for the original built-in facade. New callers should use
// the native names and preserve the descriptor-selected backend id.
export type ShoggothCronDraft = NativeCronDraft;
export const emptyShoggothDraft = (agentId = "") => emptyNativeCronDraft("shoggoth", agentId);
export const shoggothDraftFromJob = nativeCronDraftFromJob;
export const validateShoggothDraft = validateNativeCronDraft;
export const shoggothInputFromDraft = nativeCronInputFromDraft;
export const shoggothDraftWithThreadPolicy = nativeCronDraftWithThreadPolicy;
export const shoggothEditPlan = nativeCronEditPlan;

export default function NativeCronForm({ draft, setDraft }: {
  draft: NativeCronDraft;
  setDraft: (draft: NativeCronDraft) => void;
}) {
  const { t } = useTranslation();
  const set = <K extends keyof NativeCronDraft>(key: K, value: NativeCronDraft[K]) => setDraft({ ...draft, [key]: value });
  // Existing hidden options stay in the draft and continue through the original serializers.
  return <div className="cron-form">
    <Field label={t("cronForm.taskNameLabel")}>
      <TextInput value={draft.name} onChange={(event) => set("name", event.target.value)} placeholder={t("cronForm.taskNamePlaceholder")} />
    </Field>
    <Field label={t("cronForm.taskPromptLabel")}>
      <TextArea value={draft.prompt} onChange={(event) => set("prompt", event.target.value)} rows={4} placeholder={t("cronForm.taskPromptPlaceholder")} />
    </Field>
    <div className="field">
      <span className="field-label">{t("cronForm.scheduleLabel")}</span>
      <CronScheduleType value={draft.schedKind} onChange={(value) => set("schedKind", value)} />
      <div className="cron-schedule-row">
        {draft.schedKind === "cron" && <CronExpressionPicker value={draft.cronExpr} onChange={(value) => set("cronExpr", value)} />}
        {draft.schedKind === "every" && <IntervalPicker value={draft.everyMin} onChange={(value) => set("everyMin", value)} />}
        {draft.schedKind === "at" && <DateTimePicker value={draft.atLocal} onChange={(value) => set("atLocal", value)} />}
      </div>
    </div>
  </div>;
}
