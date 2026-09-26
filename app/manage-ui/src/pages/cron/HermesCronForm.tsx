import { useTranslation } from "react-i18next";
import type { CronSchedule, HermesCronJobInput, UnifiedCronJob } from "../../types";
import { Field, TextArea, TextInput } from "../../components/Field";
import i18n from "../../i18n";
import { CronExpressionPicker, DateTimePicker, IntervalPicker } from "./CronSchedulePicker";
import { CronScheduleType } from "./CronFormLayout";

type SchedKind = "cron" | "every" | "at";
type HermesMode = "agent" | "script";

export interface HermesCronDraft {
  backendId: "hermes";
  agentId: string;
  name: string;
  enabled: boolean;
  schedKind: SchedKind;
  cronExpr: string;
  everyMin: number;
  atLocal: string;
  prompt: string;
  mode: HermesMode;
  script: string;
  repeat: string;
  deliver: string;
  skills: string;
  contextFrom: string;
  enabledToolsets: string;
  workdir: string;
  profile: string;
  model: string;
  provider: string;
  baseUrl: string;
}

// 把后端 ISO 时间转为 datetime-local 可接受的本地时间字符串。
function isoToLocalInput(iso?: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 逗号分隔文本清洗为数组；空文本 = []。创建路径后端会跳过空数组，编辑路径
// 空数组 = 显式清空——省略键会被静默丢弃（CRON-003，同下方 :125 注释的教训）。
function listFromText(text: string): string[] {
  return text.split(",").map((value) => value.trim()).filter(Boolean);
}

// 后端数组字段回填为逗号分隔文本，便于在单行输入框编辑。
function textFromList(values?: string[]): string {
  return Array.isArray(values) ? values.join(", ") : "";
}

// Hermes 表单计划映射到统一 schedule，再由 backend 转为 Hermes 字符串。
function scheduleFromDraft(draft: HermesCronDraft): CronSchedule {
  if (draft.schedKind === "every") return { kind: "every", everyMs: Math.max(1, draft.everyMin) * 60000 };
  if (draft.schedKind === "at") return { kind: "at", at: draft.atLocal ? new Date(draft.atLocal).toISOString() : null };
  return { kind: "cron", expr: draft.cronExpr.trim() };
}

// repeat 只接受正整数；清空 = 显式 null（后端据此清除），而不是省略键。
function repeatFromText(text: string): number | null {
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// 新建 Hermes 任务默认使用 agent 模式，script/no-agent 需要显式切换。
export function emptyHermesDraft(agentId = ""): HermesCronDraft {
  return {
    backendId: "hermes",
    agentId,
    name: "",
    enabled: true,
    schedKind: "cron",
    cronExpr: "0 9 * * *",
    everyMin: 60,
    atLocal: "",
    prompt: "",
    mode: "agent",
    script: "",
    repeat: "",
    deliver: "local",
    skills: "",
    contextFrom: "",
    enabledToolsets: "",
    workdir: "",
    profile: "",
    model: "",
    provider: "",
    baseUrl: "",
  };
}

// 把 Hermes 自动化字段完整回填，便于编辑 script/profile/workdir 等能力。
export function hermesDraftFromJob(job: UnifiedCronJob): HermesCronDraft {
  const base = emptyHermesDraft(job.agentId || "");
  const schedule = job.schedule;
  return {
    ...base,
    agentId: job.agentId || "",
    name: job.name || "",
    enabled: job.enabled,
    schedKind: schedule.kind === "cron" || schedule.kind === "every" || schedule.kind === "at"
      ? schedule.kind
      : base.schedKind,
    cronExpr: schedule.kind === "cron" ? schedule.expr : base.cronExpr,
    everyMin: schedule.kind === "every" ? Math.max(1, Math.round(schedule.everyMs / 60000)) : base.everyMin,
    atLocal: schedule.kind === "at" ? isoToLocalInput(schedule.at) : "",
    prompt: job.prompt || "",
    mode: job.noAgent ? "script" : "agent",
    script: job.script || "",
    repeat: job.repeat?.times ? String(job.repeat.times) : "",
    deliver: job.deliver || base.deliver,
    skills: textFromList(job.skills),
    contextFrom: textFromList(job.contextFrom),
    enabledToolsets: textFromList(job.enabledToolsets),
    workdir: job.workdir || "",
    profile: job.profile || "",
    model: job.model || "",
    provider: job.provider || "",
    baseUrl: job.baseUrl || "",
  };
}

// 表单草稿转为 Hermes REST 输入，script 模式会自动设置 noAgent。
//
// 下面这些字段一律**原样传空串**，不要写成 `draft.x || undefined`：后端
// buildHermesCronUpdates 按 `typeof x === "string"` 判断，并把 "" 映射为 null（清除）。
// 一旦省略键，用户在编辑里清空 model/profile/script 等字段就会被静默丢弃——保存提示成功，
// 重新打开值还在，任务继续用旧配置跑。
export function hermesInputFromDraft(draft: HermesCronDraft): HermesCronJobInput {
  return {
    backendId: "hermes",
    agentId: draft.agentId,
    name: draft.name,
    enabled: draft.enabled,
    schedule: scheduleFromDraft(draft),
    prompt: draft.prompt,
    deliver: draft.deliver || "local",
    model: draft.model,
    provider: draft.provider,
    baseUrl: draft.baseUrl,
    repeat: repeatFromText(draft.repeat),
    skills: listFromText(draft.skills),
    script: draft.script,
    noAgent: draft.mode === "script",
    contextFrom: listFromText(draft.contextFrom),
    enabledToolsets: listFromText(draft.enabledToolsets),
    workdir: draft.workdir,
    profile: draft.profile,
  };
}

// 前端只做模式级校验，远端路径和脚本可执行性由 Hermes 返回。
export function validateHermesDraft(draft: HermesCronDraft): string | null {
  if (!draft.agentId) return i18n.t("cronForm.hermesValidateAgent");
  if (draft.mode === "script" && !draft.script.trim()) return i18n.t("cronForm.hermesValidateScript");
  if (draft.mode === "agent" && !draft.prompt.trim() && !draft.skills.trim()) return i18n.t("cronForm.hermesValidatePromptOrSkills");
  return null;
}

// Hermes 表单突出自动化任务形态，尤其是 script/no-agent 配置。
export default function HermesCronForm({ draft, setDraft }: {
  draft: HermesCronDraft;
  setDraft: (draft: HermesCronDraft) => void;
}) {
  const { t } = useTranslation();
  const set = <K extends keyof HermesCronDraft>(key: K, value: HermesCronDraft[K]) => setDraft({ ...draft, [key]: value });
  // Existing hidden options stay in the draft and continue through the original serializers.
  return <div className="cron-form">
    <Field label={t("cronForm.taskNameLabel")}>
      <TextInput value={draft.name} onChange={(event) => set("name", event.target.value)} placeholder={t("cronForm.taskNamePlaceholder")} />
    </Field>
      {draft.mode === "script" && <Field label={t("common.script")} hint={t("cronForm.hermesScriptHint")}>
        <TextInput value={draft.script} onChange={(event) => set("script", event.target.value)} placeholder="watchdog.sh" />
      </Field>}
    <Field label={draft.mode === "script" ? t("cronForm.hermesPromptOptionalLabel") : t("cronForm.taskPromptLabel")}>
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
