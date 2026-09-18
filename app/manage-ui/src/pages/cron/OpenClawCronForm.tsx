import type {
  CronSchedule,
  OpenClawCronDelivery,
  OpenClawCronFailureAlert,
  OpenClawCronJobInput,
  OpenClawCronPayload,
  OpenClawCronSessionTarget,
  OpenClawCronWakeMode,
  UnifiedCronJob,
} from "../../types";
import { useTranslation } from "react-i18next";
import { Field, TextArea, TextInput } from "../../components/Field";
import { CronExpressionPicker, DateTimePicker, IntervalPicker } from "./CronSchedulePicker";
import { CronScheduleType } from "./CronFormLayout";

type SchedKind = CronSchedule["kind"];
type PayloadKind = "agentTurn" | "systemEvent";

export interface OpenClawCronDraft {
  backendId: "openclaw";
  agentId: string;
  name: string;
  description: string;
  enabled: boolean;
  deleteAfterRun: boolean;
  schedKind: SchedKind;
  cronExpr: string;
  cronTz: string;
  staggerSec: number;
  everyMin: number;
  anchorLocal: string;
  atLocal: string;
  onExitCommand: string;
  scheduleCwd: string;
  streamCommand: string;
  streamMode: "line" | "match";
  streamMatch: string;
  streamBatchMs: number;
  streamMaxBatchBytes: number;
  payloadKind: PayloadKind;
  prompt: string;
  systemText: string;
  model: string;
  fallbacks: string;
  thinking: string;
  timeoutSeconds: number;
  lightContext: boolean;
  toolsAllow: string;
  sessionTarget: OpenClawCronSessionTarget;
  wakeMode: OpenClawCronWakeMode;
  deliveryMode: OpenClawCronDelivery["mode"];
  deliveryChannel: string;
  deliveryTo: string;
  webhookUrl: string;
  failureEnabled: boolean;
  failureAfter: number;
  failureCooldownMin: number;
  failureMode: NonNullable<OpenClawCronFailureAlert["mode"]>;
  failureChannel: string;
  failureTo: string;
  failureIncludeSkipped: boolean;
}

// 把后端 ISO 时间转为 datetime-local 可接受的本地时间字符串。
function isoToLocalInput(iso?: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// anchorMs 以毫秒存储，表单里使用本地时间输入。
function msToLocalInput(ms?: number): string {
  return typeof ms === "number" ? isoToLocalInput(new Date(ms).toISOString()) : "";
}

// 逗号分隔文本统一清洗为空数组或 undefined，避免提交空字符串项。
function listFromText(text: string): string[] | undefined {
  const values = text.split(",").map((value) => value.trim()).filter(Boolean);
  return values.length ? values : undefined;
}

// 后端数组字段回填为逗号分隔文本，便于在单行输入框编辑。
function textFromList(values?: string[]): string {
  return Array.isArray(values) ? values.join(", ") : "";
}

// 根据表单中的计划类型生成 OpenClaw 支持的 schedule superset。
function scheduleFromDraft(draft: OpenClawCronDraft): CronSchedule {
  if (draft.schedKind === "every") {
    const anchorMs = draft.anchorLocal ? new Date(draft.anchorLocal).getTime() : undefined;
    return {
      kind: "every",
      // 草稿以分钟展示，但提交时只做毫秒取整，保留原有非整分钟间隔。
      everyMs: Math.max(1, Math.round(draft.everyMin * 60000)),
      ...(Number.isFinite(anchorMs) ? { anchorMs } : {}),
    };
  }
  if (draft.schedKind === "at") {
    return { kind: "at", at: draft.atLocal ? new Date(draft.atLocal).toISOString() : null };
  }
  if (draft.schedKind === "on-exit") {
    return {
      kind: "on-exit",
      command: draft.onExitCommand.trim(),
      ...(draft.scheduleCwd.trim() ? { cwd: draft.scheduleCwd.trim() } : {}),
    };
  }
  if (draft.schedKind === "stream") {
    const command = draft.streamCommand.split(/\r?\n/).map((part) => part.trim()).filter(Boolean);
    return {
      kind: "stream",
      command,
      ...(draft.scheduleCwd.trim() ? { cwd: draft.scheduleCwd.trim() } : {}),
      mode: draft.streamMode,
      ...(draft.streamMode === "match" && draft.streamMatch.trim() ? { match: draft.streamMatch.trim() } : {}),
      ...(draft.streamBatchMs > 0 ? { batchMs: Math.round(draft.streamBatchMs) } : {}),
      ...(draft.streamMaxBatchBytes > 0 ? { maxBatchBytes: Math.round(draft.streamMaxBatchBytes) } : {}),
    };
  }
  return {
    kind: "cron",
    expr: draft.cronExpr.trim(),
    ...(draft.cronTz.trim() ? { tz: draft.cronTz.trim() } : {}),
    ...(draft.staggerSec > 0 ? { staggerMs: draft.staggerSec * 1000 } : {}),
  };
}

// payload 是 OpenClaw 的核心控制面，agentTurn/systemEvent 分开构建。
function payloadFromDraft(draft: OpenClawCronDraft): OpenClawCronPayload {
  if (draft.payloadKind === "systemEvent") return { kind: "systemEvent", text: draft.systemText };
  const fallbacks = listFromText(draft.fallbacks);
  const toolsAllow = listFromText(draft.toolsAllow);
  return {
    kind: "agentTurn",
    message: draft.prompt,
    ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
    ...(fallbacks ? { fallbacks } : {}),
    ...(draft.thinking ? { thinking: draft.thinking } : {}),
    ...(draft.timeoutSeconds > 0 ? { timeoutSeconds: draft.timeoutSeconds } : {}),
    ...(draft.lightContext ? { lightContext: true } : {}),
    ...(toolsAllow ? { toolsAllow } : {}),
  };
}

// delivery 只提交当前模式需要的字段，减少后端歧义。
function deliveryFromDraft(draft: OpenClawCronDraft): OpenClawCronDelivery {
  if (draft.deliveryMode === "webhook") {
    return {
      mode: "webhook",
      ...(draft.webhookUrl.trim()
        ? { completionDestination: { kind: "webhook", url: draft.webhookUrl.trim() } }
        : {}),
    };
  }
  if (draft.deliveryMode === "announce") {
    return {
      mode: "announce",
      ...(draft.deliveryChannel.trim() ? { channel: draft.deliveryChannel.trim() } : {}),
      ...(draft.deliveryTo.trim() ? { to: draft.deliveryTo.trim() } : {}),
    };
  }
  return { mode: "none" };
}

// 失败告警关闭时显式传 null，让后端能清除已有配置。
function failureAlertFromDraft(draft: OpenClawCronDraft): OpenClawCronFailureAlert | null {
  if (!draft.failureEnabled) return null;
  return {
    after: Math.max(1, draft.failureAfter),
    cooldownMs: Math.max(0, draft.failureCooldownMin) * 60000,
    includeSkipped: draft.failureIncludeSkipped,
    mode: draft.failureMode,
    ...(draft.failureChannel.trim() ? { channel: draft.failureChannel.trim() } : {}),
    ...(draft.failureTo.trim() ? { to: draft.failureTo.trim() } : {}),
  };
}

// 新建 OpenClaw 任务的默认值偏保守：启用但不投递、不失败告警。
export function emptyOpenClawDraft(): OpenClawCronDraft {
  return {
    backendId: "openclaw",
    agentId: "",
    name: "",
    description: "",
    enabled: true,
    deleteAfterRun: false,
    schedKind: "cron",
    cronExpr: "0 9 * * *",
    cronTz: "",
    staggerSec: 0,
    everyMin: 60,
    anchorLocal: "",
    atLocal: "",
    onExitCommand: "",
    scheduleCwd: "",
    streamCommand: "",
    streamMode: "line",
    streamMatch: "",
    streamBatchMs: 0,
    streamMaxBatchBytes: 0,
    payloadKind: "agentTurn",
    prompt: "",
    systemText: "",
    model: "",
    fallbacks: "",
    thinking: "",
    timeoutSeconds: 0,
    lightContext: false,
    toolsAllow: "",
    sessionTarget: "isolated",
    wakeMode: "now",
    deliveryMode: "none",
    deliveryChannel: "",
    deliveryTo: "",
    webhookUrl: "",
    failureEnabled: false,
    failureAfter: 3,
    failureCooldownMin: 60,
    failureMode: "announce",
    failureChannel: "",
    failureTo: "",
    failureIncludeSkipped: false,
  };
}

// 把 UnifiedCronJob 的高级字段完整回填到 OpenClaw 独立表单。
export function openClawDraftFromJob(job: UnifiedCronJob): OpenClawCronDraft {
  const base = emptyOpenClawDraft();
  const schedule = job.schedule;
  const payload = job.payload;
  const delivery = job.delivery;
  const failure = job.failureAlert;
  return {
    ...base,
    agentId: job.agentId || "",
    name: job.name || "",
    description: job.description || "",
    enabled: job.enabled,
    deleteAfterRun: job.deleteAfterRun === true,
    schedKind: schedule.kind,
    cronExpr: schedule.kind === "cron" ? schedule.expr : base.cronExpr,
    cronTz: schedule.kind === "cron" ? schedule.tz || "" : "",
    staggerSec: schedule.kind === "cron" ? Math.round((schedule.staggerMs || 0) / 1000) : 0,
    everyMin: schedule.kind === "every" ? Math.max(1 / 60000, schedule.everyMs / 60000) : base.everyMin,
    anchorLocal: schedule.kind === "every" ? msToLocalInput(schedule.anchorMs) : "",
    atLocal: schedule.kind === "at" ? isoToLocalInput(schedule.at) : "",
    onExitCommand: schedule.kind === "on-exit" ? schedule.command : "",
    scheduleCwd: schedule.kind === "on-exit" || schedule.kind === "stream" ? schedule.cwd || "" : "",
    streamCommand: schedule.kind === "stream" ? schedule.command.join("\n") : "",
    streamMode: schedule.kind === "stream" ? schedule.mode || "line" : "line",
    streamMatch: schedule.kind === "stream" ? schedule.match || "" : "",
    streamBatchMs: schedule.kind === "stream" ? schedule.batchMs || 0 : 0,
    streamMaxBatchBytes: schedule.kind === "stream" ? schedule.maxBatchBytes || 0 : 0,
    payloadKind: payload?.kind === "systemEvent" ? "systemEvent" : "agentTurn",
    prompt: payload?.kind === "agentTurn" ? payload.message || "" : job.prompt || "",
    systemText: payload?.kind === "systemEvent" ? payload.text || "" : "",
    model: payload?.kind === "agentTurn" ? payload.model || "" : job.model || "",
    fallbacks: payload?.kind === "agentTurn" ? textFromList(payload.fallbacks) : "",
    thinking: payload?.kind === "agentTurn" ? payload.thinking || "" : "",
    timeoutSeconds: payload?.kind === "agentTurn" ? payload.timeoutSeconds || 0 : 0,
    lightContext: payload?.kind === "agentTurn" ? payload.lightContext === true : false,
    toolsAllow: payload?.kind === "agentTurn" ? textFromList(payload.toolsAllow) : "",
    sessionTarget: job.sessionTarget || base.sessionTarget,
    wakeMode: job.wakeMode || base.wakeMode,
    deliveryMode: delivery?.mode || (job.deliver === "announce" || job.deliver === "webhook" ? job.deliver : "none"),
    deliveryChannel: delivery?.channel || "",
    deliveryTo: delivery?.to || "",
    webhookUrl: typeof delivery?.completionDestination?.url === "string" ? delivery.completionDestination.url : "",
    failureEnabled: !!failure,
    failureAfter: failure?.after || base.failureAfter,
    failureCooldownMin: Math.round((failure?.cooldownMs || base.failureCooldownMin * 60000) / 60000),
    failureMode: failure?.mode || base.failureMode,
    failureChannel: failure?.channel || "",
    failureTo: failure?.to || "",
    failureIncludeSkipped: failure?.includeSkipped === true,
  };
}

// 表单草稿转为 REST 输入，兼容旧 prompt/model 字段和新 payload 字段。
export function openClawInputFromDraft(draft: OpenClawCronDraft): OpenClawCronJobInput {
  return {
    backendId: "openclaw",
    agentId: draft.agentId || undefined,
    name: draft.name,
    description: draft.description,
    enabled: draft.enabled,
    deleteAfterRun: draft.deleteAfterRun,
    schedule: scheduleFromDraft(draft),
    payload: payloadFromDraft(draft),
    prompt: draft.payloadKind === "agentTurn" ? draft.prompt : draft.systemText,
    model: draft.model || undefined,
    sessionTarget: draft.sessionTarget,
    wakeMode: draft.wakeMode,
    delivery: deliveryFromDraft(draft),
    deliver: draft.deliveryMode,
    failureAlert: failureAlertFromDraft(draft),
  };
}

// 2026.8.1 的 on-exit/stream schema 都要求非空命令。提前在表单层拦截，
// 避免把空字符串/空 argv 交给网关后才得到难以定位的 schema 错误。
export function validateOpenClawDraft(draft: OpenClawCronDraft): string | null {
  if (draft.schedKind === "at") {
    const date = new Date(draft.atLocal);
    if (!Number.isFinite(date.getTime()) || isoToLocalInput(date.toISOString()) !== draft.atLocal) {
      return "cronForm.openclawValidateAt";
    }
  }
  if (draft.schedKind === "on-exit" && !draft.onExitCommand.trim()) {
    return "cronForm.openclawValidateOnExitCommand";
  }
  if (
    draft.schedKind === "stream"
    && !draft.streamCommand.split(/\r?\n/).some((part) => part.trim())
  ) {
    return "cronForm.openclawValidateStreamCommand";
  }
  return null;
}

// OpenClaw 表单只表达 OpenClaw 控制面，避免和 Hermes 字段混在一起。
export default function OpenClawCronForm({ draft, setDraft }: {
  draft: OpenClawCronDraft;
  setDraft: (draft: OpenClawCronDraft) => void;
}) {
  const { t } = useTranslation();
  const set = <K extends keyof OpenClawCronDraft>(key: K, value: OpenClawCronDraft[K]) => setDraft({ ...draft, [key]: value });
  // Existing hidden options stay in the draft and continue through the original serializers.
  return <div className="cron-form">
    <Field label={t("cronForm.taskNameLabel")}>
      <TextInput value={draft.name} onChange={(event) => set("name", event.target.value)} placeholder={t("cronForm.taskNamePlaceholder")} />
    </Field>
    <Field label={draft.payloadKind === "agentTurn" ? t("cronForm.taskPromptLabel") : t("cronForm.openclawSystemEventText")}>
      <TextArea value={draft.payloadKind === "agentTurn" ? draft.prompt : draft.systemText} onChange={(event) => set(draft.payloadKind === "agentTurn" ? "prompt" : "systemText", event.target.value)} rows={4} placeholder={t("cronForm.taskPromptPlaceholder")} />
    </Field>
    <div className="field">
      <span className="field-label">{t("cronForm.scheduleLabel")}</span>
      <CronScheduleType value={draft.schedKind} onChange={(value) => set("schedKind", value)} />
      <div className="cron-schedule-row">
        {draft.schedKind === "cron" && <CronExpressionPicker value={draft.cronExpr} onChange={(value) => set("cronExpr", value)} />}
        {draft.schedKind === "every" && <IntervalPicker value={draft.everyMin} onChange={(value) => set("everyMin", value)} minMinutes={1 / 60} />}
        {draft.schedKind === "at" && <DateTimePicker value={draft.atLocal} onChange={(value) => set("atLocal", value)} />}
      </div>
    </div>
  </div>;
}
