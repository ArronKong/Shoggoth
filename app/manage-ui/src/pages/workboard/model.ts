// OpenClaw 工作板纯函数层 — 官方 control-ui workboard 运行时（openclaw 2026.8.1）
// 的 1:1 TypeScript 移植。每个函数注明官方压缩名（Ff/Rf/Vp→lifecycle 已在服务端、
// St/Ct/Bf/Vf/Hf/Pe/He/We/Ge/Ke/Np/Fe/Ie/je…），方便对着上游 diff。

import type { TFunction } from "i18next";
import type {
  TaskEvent,
  UnifiedTask,
  WbAgents,
  WbLifecycleView,
  WbSession,
  WorkboardCard,
  WorkboardPriority,
} from "../../types";

export type WbHealthKind = "running" | "blocked" | "stale" | "readyUnassigned" | "missingProof" | "failedAttempts";
export type WbViewPreset =
  | "all" | "default_agent" | "ready" | "running" | "blocked"
  | "review" | "stale" | "missing_proof" | "recently_done";
export type WbLayout = "compact" | "comfortable";
export type WbLifecycleTone = "live" | "done" | "blocked" | "idle";

// 官方 Kd：最近完成 = done 且 7 天内。
const RECENT_DONE_MS = 10080 * 60 * 1000;

// 看板项 = UnifiedTask + 它携带的官方原始卡（wb 必在——由调用方过滤）。
export interface WbItem {
  tk: UnifiedTask;
  card: WorkboardCard;
}

export function toWbItems(columns: { tasks: UnifiedTask[] }[]): WbItem[] {
  const out: WbItem[] = [];
  for (const col of columns) {
    for (const tk of col.tasks) if (tk.wb) out.push({ tk, card: tk.wb });
  }
  return out;
}

export function cardSessionKey(card: WorkboardCard): string | undefined {   // 官方 Y
  return card.sessionKey ?? card.execution?.sessionKey ?? undefined;
}
export function cardRunId(card: WorkboardCard): string | undefined {        // 官方 Bp
  return card.runId ?? card.execution?.runId ?? undefined;
}

export function hasProof(card: WorkboardCard): boolean {                    // 官方 Ff
  const md = card.metadata;
  return !!(md?.proof?.length || md?.artifacts?.length || md?.attachments?.length);
}

export function failureCount(card: WorkboardCard): number {                 // 官方 Rf
  const md = card.metadata;
  if (md?.failureCount !== undefined) return md.failureCount;
  return (md?.attempts ?? []).filter((a) => a.status === "failed" || a.status === "blocked" || a.status === "stopped").length;
}

type WbTaskView = NonNullable<WbLifecycleView["task"]>;

export function taskFailed(task: WbTaskView | null | undefined): boolean {  // 官方 If
  return task?.status === "failed" || task?.status === "cancelled" || task?.status === "timed_out";
}

// 官方 ap：任务侧 session key 与卡片 subagent key 的后缀匹配。
function sessionKeyMatches(taskKey: string | undefined, cardKey: string): boolean {
  if (!taskKey) return false;
  if (taskKey === cardKey) return true;
  return cardKey.startsWith("subagent:workboard-") && taskKey.endsWith(`:${cardKey}`);
}

// 官方 Lf：失败的 gateway 任务是否已被卡片 attempts 记账（避免健康计数重复 +1）。
export function attemptsCoverFailedTask(card: WorkboardCard, task: WbTaskView | null | undefined): boolean {
  if (!task || !taskFailed(task)) return false;
  const keys = [task.sessionKey, task.childSessionKey, task.ownerKey];
  return !!card.metadata?.attempts?.some((a) => {
    if (a.status !== "failed" && a.status !== "blocked" && a.status !== "stopped") return false;
    if (task.runId && a.runId) return a.runId === task.runId;
    return !!(a.sessionKey && keys.some((k) => sessionKeyMatches(k, a.sessionKey ?? "")));
  });
}

export function recentlyDone(card: WorkboardCard): boolean {                // 官方 zf
  if (card.status !== "done") return false;
  const at = card.completedAt ?? card.updatedAt;
  return Date.now() - at <= RECENT_DONE_MS;
}

export function lifecycleOf(card: WorkboardCard): WbLifecycleView {
  // 服务端每次刷新都会附上 lifecycle；缺席（sessions 拉取失败等）按未关联/已关联降级。
  return card.lifecycle ?? { state: cardSessionKey(card) ? "idle" : "unlinked", session: null, task: null };
}

// 官方 Tt/Ot/lt.live：卡片是否有活动运行（live 徽标 + 健康/预设的 running 口径）。
export function taskActive(task: WbTaskView | null | undefined): boolean {  // 官方 Tt
  return task?.status === "queued" || task?.status === "running";
}
export function cardRunning(card: WorkboardCard): boolean {                 // 官方 Ot
  return card.status === "running" && !!(cardSessionKey(card) && cardRunId(card));
}
export function isLive(card: WorkboardCard): boolean {                      // 官方 lt.live
  const lc = lifecycleOf(card);
  return (
    taskActive(lc.task) ||
    cardRunning(card) ||
    lc.session?.hasActiveRun === true ||
    (lc.session?.hasActiveRun !== false && lc.session?.status === "running")
  );
}

// 官方 kt：何时展示「开始/Run/Open」控件 —— 无活动任务、非 running-with-run，
// 且（未关联会话 或 关联的会话已不存在）。
export function showStartControls(card: WorkboardCard): boolean {
  const lc = lifecycleOf(card);
  if (taskActive(lc.task) || cardRunning(card)) return false;
  const key = cardSessionKey(card);
  return !key || !lc.session;
}

// 官方 St：lifecycle 徽标（文案 key + 色调）。
export function lifecycleTone(state: WbLifecycleView["state"]): { labelKey: string; detailKey: string; tone: WbLifecycleTone } {
  switch (state) {
    case "running": return { labelKey: "lifecycleRunning", detailKey: "lifecycleRunningDetail", tone: "live" };
    case "succeeded": return { labelKey: "lifecycleDone", detailKey: "lifecycleDoneDetail", tone: "done" };
    case "failed": return { labelKey: "lifecycleNeedsReview", detailKey: "lifecycleNeedsReviewDetail", tone: "blocked" };
    case "stale": return { labelKey: "lifecycleStale", detailKey: "lifecycleStaleDetail", tone: "blocked" };
    case "idle": return { labelKey: "lifecycleLinked", detailKey: "lifecycleIdleDetail", tone: "idle" };
    case "missing": return { labelKey: "lifecycleMissing", detailKey: "lifecycleMissingDetail", tone: "blocked" };
    case "unlinked": return { labelKey: "lifecycleUnlinked", detailKey: "lifecycleUnlinkedDetail", tone: "idle" };
  }
}

// 官方 wt：gateway 任务状态与 lifecycle 状态一致时才用任务文案替换徽标。
export function taskConsistent(task: WbTaskView, state: WbLifecycleView["state"]): boolean {
  switch (task.status) {
    case "queued":
    case "running": return state === "running";
    case "completed": return task.terminalOutcome === "blocked" ? state === "failed" : state === "succeeded";
    case "failed":
    case "cancelled":
    case "timed_out": return state === "failed";
  }
  return false;
}

export function taskStatusKey(task: WbTaskView): string {
  return task.status === "completed" && task.terminalOutcome === "blocked"
    ? "taskOutcome_blocked"
    : `taskStatus_${task.status}`;
}

export function taskResultNotDelivered(task: WbTaskView | null | undefined): boolean {
  return task?.deliveryStatus === "failed";
}

// 官方 Ct：卡片 lifecycle 行的任务摘要。
export function taskSummary(task: WbTaskView): string {
  if (task.status === "queued" || task.status === "running") {
    return task.progressSummary ?? task.title ?? task.taskId;
  }
  return task.terminalSummary ?? task.error ?? task.progressSummary ?? task.title ?? task.taskId;
}

// 官方 Vf：健康项与单卡的匹配（点击高亮用同一口径）。
export function matchesHealth(card: WorkboardCard, kind: WbHealthKind): boolean {
  const lc = lifecycleOf(card);
  switch (kind) {
    case "running": return card.status === "running" || lc.state === "running";
    case "blocked": return card.status === "blocked";
    case "stale": return !!(card.metadata?.stale || lc.state === "stale");
    case "readyUnassigned": return card.status === "ready" && !card.agentId?.trim() && !card.metadata?.claim;
    case "missingProof": return card.status === "done" && !hasProof(card);
    case "failedAttempts": return failureCount(card) > 0 || taskFailed(lc.task);
  }
}

// 官方 Bf：健康条六项计数。
export function healthCounts(items: WbItem[]): Record<WbHealthKind, number> {
  const c: Record<WbHealthKind, number> = {
    running: 0, blocked: 0, stale: 0, readyUnassigned: 0, missingProof: 0, failedAttempts: 0,
  };
  for (const { card } of items) {
    const lc = lifecycleOf(card);
    if (matchesHealth(card, "running")) c.running += 1;
    if (matchesHealth(card, "blocked")) c.blocked += 1;
    if (matchesHealth(card, "stale")) c.stale += 1;
    if (matchesHealth(card, "readyUnassigned")) c.readyUnassigned += 1;
    if (matchesHealth(card, "missingProof")) c.missingProof += 1;
    c.failedAttempts += failureCount(card);
    if (taskFailed(lc.task) && !attemptsCoverFailedTask(card, lc.task)) c.failedAttempts += 1;
  }
  return c;
}

// 官方 Hf：视图预设过滤。
export function matchesPreset(card: WorkboardCard, preset: WbViewPreset, defaultAgentId?: string): boolean {
  const lc = lifecycleOf(card);
  switch (preset) {
    case "all": return true;
    case "default_agent": {
      const d = defaultAgentId?.trim();
      return d ? card.agentId === d || !card.agentId?.trim() : !card.agentId;
    }
    case "ready": return card.status === "ready";
    case "running": return card.status === "running" || lc.state === "running";
    case "blocked": return card.status === "blocked";
    case "review": return card.status === "review";
    case "stale": return !!(card.metadata?.stale || lc.state === "stale");
    case "missing_proof": return card.status === "done" && !hasProof(card);
    case "recently_done": return recentlyDone(card);
  }
}

// 官方 Pe：搜索 + 优先级过滤（搜索覆盖官方同一份字段清单）。
export function matchesFilters(card: WorkboardCard, filters: { query: string; priority: WorkboardPriority | "all" }): boolean {
  if (filters.priority !== "all" && card.priority !== filters.priority) return false;
  const q = filters.query.trim().toLowerCase();
  if (!q) return true;
  const md = card.metadata;
  const hay: Array<string | undefined> = [
    card.title, card.notes, card.agentId, card.sessionKey,
    card.execution?.engine, card.execution?.mode, card.execution?.model, card.execution?.sessionKey,
    md?.templateId, md?.automation?.tenant, md?.automation?.idempotencyKey,
    md?.automation?.workspace?.kind, md?.automation?.workspace?.path, md?.automation?.workspace?.branch,
    ...(md?.automation?.skills ?? []),
    ...(md?.automation?.createdCardIds ?? []),
    ...(md?.comments ?? []).map((c) => c.body),
    ...(md?.links ?? []).flatMap((l) => [l.title, l.url, l.targetCardId]),
    ...(md?.proof ?? []).flatMap((p) => [p.label, p.command, p.url, p.note]),
    ...(md?.artifacts ?? []).flatMap((a) => [a.label, a.url, a.path, a.mimeType]),
    ...(md?.attachments ?? []).flatMap((a) => [a.fileName, a.mimeType, a.note]),
    ...(md?.workerLogs ?? []).map((l) => l.message),
    md?.workerProtocol?.state, md?.workerProtocol?.detail,
    md?.claim?.ownerId,
    ...(md?.diagnostics ?? []).flatMap((d) => [d.kind, d.severity, d.title, d.detail]),
    ...(md?.notifications ?? []).map((n) => n.message),
    ...card.labels,
  ];
  return hay.some((v) => typeof v === "string" && v.toLowerCase().includes(q));
}

// 官方 Fe：目标列末尾 position。
export function nextPosition(items: WbItem[], status: string): number {
  let max = 0;
  for (const { card } of items) if (card.status === status && card.position > max) max = card.position;
  return max + 1000;
}

// 官方 Ie：会话下拉的候选（排除归档 / global / heartbeat 会话）。
export function sessionOptionOk(s: WbSession): boolean {
  if (s.archived || s.kind === "global") return false;
  const hay = [s.key, s.label, s.displayName].filter((v): v is string => typeof v === "string").join(":").toLowerCase();
  return !/(^|:)heartbeat(:|$)/.test(hay);
}
export function sessionDisplay(s: WbSession): string {
  return s.displayName ?? s.label ?? s.key;
}

// ---- agent 选项（官方 He/Ue/We/Ge/Ke） ----

export interface WbAgentOption { id: string; label: string; description?: string; disabled?: boolean }

function configuredAgents(agents: WbAgents | undefined): Array<{ id: string; label: string; isDefault: boolean }> { // 官方 He
  const seen = new Set<string>();
  const out: Array<{ id: string; label: string; isDefault: boolean }> = [];
  const def = agents?.defaultId?.trim() ?? "";
  for (const a of agents?.agents ?? []) {
    const id = a.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: a.name || id, isDefault: !!def && id === def });
  }
  return out;
}
function defaultAgentLabel(list: Array<{ label: string; isDefault: boolean }>, t: TFunction): string { // 官方 Ue
  return list.find((a) => a.isDefault)?.label ?? t("tasks.wb.defaultAgent");
}

// 筛选下拉（含 all / 未分配 / 未配置的 agent id）。官方 We。
export function agentFilterOptions(agents: WbAgents | undefined, items: WbItem[], t: TFunction): WbAgentOption[] {
  const configured = configuredAgents(agents);
  const ids = new Set(configured.map((a) => a.id));
  const unconfigured = [...new Set(
    items.map(({ card }) => card.agentId?.trim() ?? "").filter((id) => id && !ids.has(id)),
  )].sort((a, b) => a.localeCompare(b));
  const out: WbAgentOption[] = [
    { id: "all", label: t("tasks.wb.allAgents") },
    {
      id: "default",
      label: t("tasks.wb.agentFilterUnassigned", { agent: defaultAgentLabel(configured, t) }),
      description: t("tasks.wb.agentFilterUnassignedHelp"),
    },
  ];
  for (const a of configured) {
    out.push({
      id: a.id,
      label: a.isDefault ? t("tasks.wb.agentFilterConfiguredDefault", { agent: a.label }) : a.label,
      ...(a.isDefault ? { description: t("tasks.wb.agentFilterConfiguredDefaultHelp") } : {}),
    });
  }
  for (const id of unconfigured) out.push({ id, label: t("tasks.wb.agentCurrentUnconfigured", { agent: id }) });
  return out;
}

// 新建/编辑表单的 agent 下拉。官方 Ge。
export function agentDraftOptions(agents: WbAgents | undefined, current: string, t: TFunction): WbAgentOption[] {
  const configured = configuredAgents(agents);
  const cur = current.trim();
  const known = !cur || configured.some((a) => a.id === cur);
  return [
    { id: "", label: t("tasks.wb.agentFilterUnassigned", { agent: defaultAgentLabel(configured, t) }) },
    ...configured.map((a) => ({
      id: a.id,
      label: a.isDefault ? t("tasks.wb.agentFilterConfiguredDefault", { agent: a.label }) : a.label,
    })),
    ...(known ? [] : [{ id: cur, label: t("tasks.wb.agentCurrentUnconfigured", { agent: cur }) }]),
  ];
}

export function sanitizeAgentFilter(options: WbAgentOption[], value: string): string { // 官方 Ke
  return options.some((o) => o.id === value) ? value : "all";
}

// 官方 Ve：agent 筛选是否命中。
export function matchesAgentFilter(card: WorkboardCard, filter: string): boolean {
  if (filter === "all") return true;
  const id = card.agentId?.trim();
  return filter === "default" ? !id : id === filter;
}

// 官方 it：非 openclaw/pi ACP runtime 的 agent 禁用 codex/claude 引擎按钮。
export function engineDisabledReason(card: WorkboardCard, agents: WbAgents | undefined, t: TFunction): string | null {
  const id = (card.agentId?.trim() || agents?.defaultId?.trim()) ?? "";
  const agent = id ? agents?.agents.find((a) => a.id === id) : undefined;
  const runtime = agent?.runtimeId?.trim();
  if (!runtime) return null;
  const lc = runtime.toLowerCase();
  if (lc === "openclaw" || lc === "pi") return null;
  return t("tasks.wb.engineDisabledRuntime", {
    agent: agent?.name || card.agentId || t("tasks.wb.defaultAgent"),
    runtime,
  });
}

export function agentChipLabel(card: WorkboardCard, agents: WbAgents | undefined, t: TFunction): string { // 官方 Be
  const id = card.agentId?.trim();
  const target = id || agents?.defaultId?.trim() || "";
  const agent = target ? agents?.agents.find((a) => a.id === target) : undefined;
  return agent?.name || id || t("tasks.wb.defaultAgent");
}

// ---- 依赖（官方 Mp/Np/C） ----

export interface WbDependency { id: string; title: string; status?: string; done: boolean; missing: boolean }
export interface WbDependencies { parents: WbDependency[]; blockedParents: WbDependency[] }

export function dependenciesOf(card: WorkboardCard, all: WbItem[]): WbDependencies {
  const ids: string[] = [];
  for (const l of card.metadata?.links ?? []) {
    const id = l.type === "parent" ? l.targetCardId?.trim() : "";
    if (id && !ids.includes(id)) ids.push(id);
  }
  const byId = new Map(all.map(({ card: c }) => [c.id, c]));
  const parents = ids.map((id) => {
    const parent = byId.get(id);
    return {
      id,
      title: parent?.title ?? id,
      status: parent?.status,
      done: parent?.status === "done",
      missing: !parent,
    };
  });
  return { parents, blockedParents: parents.filter((p) => !p.done) };
}

// ---- 文案与时间 ----

export function statusLabel(s: string, t: TFunction): string {                       // 官方 N
  return t(`tasks.wb.status_${s}`, { defaultValue: s });
}
export function priorityLabel(p: string, t: TFunction): string {                     // 官方 P
  return t(`tasks.wb.priority_${p}`, { defaultValue: p.charAt(0).toUpperCase() + p.slice(1) });
}

export function eventLabel(ev: TaskEvent, t: TFunction): string {                    // 官方 je
  if (ev.kind === "moved" && ev.toStatus) return t("tasks.wb.eventMovedTo", { status: statusLabel(ev.toStatus, t) });
  return t(`tasks.wb.event_${ev.kind}`, { defaultValue: ev.kind });
}

export function fmtDateShort(ms?: number): string {                                  // 官方 ye
  return ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
}
export function fmtTime(ms: number): string {                                        // 官方 be
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}
export function fmtDateTime(ms?: number): string {                                   // 官方 F
  return ms
    ? new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "";
}
export function taskDateTime(value?: string | number): string {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? fmtDateTime(ms) : "";
}
export function ageText(ms: number | undefined, t: TFunction): string {              // 官方 xe（心跳徽标）
  if (!ms) return "";
  const delta = Math.max(0, Date.now() - ms);
  const mins = Math.floor(delta / 60000);
  if (mins < 1) return `${Math.floor(delta / 1000)}s`;
  if (mins < 60) return `${mins}m`;
  return t("tasks.wb.ageHours", { count: Math.floor(mins / 60) });
}

export function truncate(text: string, max = 64): string {                           // 官方 Se
  const v = text.trim();
  return v.length <= max ? v : `${v.slice(0, Math.max(0, max - 1))}…`;
}

// 官方 Ip：labels 输入解析（逗号分隔，去重，≤12 个）。
export function parseLabels(input: string): string[] {
  const out: string[] = [];
  for (const part of input.split(",")) {
    const v = part.trim();
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= 12) break;
  }
  return out;
}

// 官方 ve：新建卡模板。
export const WB_TEMPLATES: Array<{ id: string; title: string; notes: string; labels: string; priority: WorkboardPriority }> = [
  { id: "bugfix", title: "Fix: ", notes: "Symptom:\nCause:\nAcceptance:\nProof:", labels: "fix, test", priority: "high" },
  { id: "docs", title: "Docs: ", notes: "Page:\nChange:\nSource proof:", labels: "docs", priority: "normal" },
  { id: "release", title: "Release: ", notes: "Scope:\nVerification:\nCloseout:", labels: "release", priority: "urgent" },
  { id: "pr_review", title: "Review PR ", notes: "Surface:\nRisks:\nProof:", labels: "review", priority: "normal" },
  { id: "plugin", title: "Plugin: ", notes: "Boundary:\nConfig/docs:\nTests:", labels: "plugin", priority: "normal" },
];

// 官方 Vt / Ht：自动刷新档位与视图预设清单。
export const WB_AUTO_REFRESH: Array<{ value: number; labelKey: string }> = [
  { value: 0, labelKey: "autoRefreshOff" },
  { value: 5000, labelKey: "autoRefresh5s" },
  { value: 15000, labelKey: "autoRefresh15s" },
  { value: 30000, labelKey: "autoRefresh30s" },
  { value: 60000, labelKey: "autoRefresh60s" },
];
export const WB_VIEW_PRESETS: Array<{ value: WbViewPreset; labelKey: string }> = [
  { value: "all", labelKey: "viewAll" },
  { value: "default_agent", labelKey: "viewDefaultAgent" },
  { value: "ready", labelKey: "viewReady" },
  { value: "running", labelKey: "viewRunning" },
  { value: "blocked", labelKey: "viewBlocked" },
  { value: "review", labelKey: "viewReview" },
  { value: "stale", labelKey: "viewStale" },
  { value: "missing_proof", labelKey: "viewMissingProof" },
  { value: "recently_done", labelKey: "viewRecentlyDone" },
];

// 卡片顶部徽标行（官方 Ne 的数据部分；渲染在视图层）。
export interface WbBadge { text: string; warning?: boolean; title?: string }
export function cardBadges(card: WorkboardCard, t: TFunction): WbBadge[] {
  const md = card.metadata;
  const task = lifecycleOf(card).task;
  const out: WbBadge[] = [];
  const diag = md?.diagnostics?.slice().sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))[0];
  const blockedReason = card.status === "blocked"
    ? md?.notifications?.at(-1)?.message ?? md?.workerProtocol?.detail ?? diag?.detail
    : undefined;
  if (md?.templateId) out.push({ text: t(`tasks.wb.template_${md.templateId}`, { defaultValue: md.templateId }) });
  if (card.taskId || task) out.push({ text: t("tasks.wb.badgeTaskLinked") });
  if (taskResultNotDelivered(task)) out.push({ text: t("tasks.wb.taskResultNotDelivered"), warning: true });
  if (md?.attempts?.length) out.push({ text: t("tasks.wb.badgeAttempts", { count: md.attempts.length }) });
  if (md?.failureCount) out.push({ text: t("tasks.wb.badgeFailures", { count: md.failureCount }), warning: true });
  if (md?.comments?.length) out.push({ text: t("tasks.wb.badgeComments", { count: md.comments.length }) });
  if (md?.proof?.length) out.push({ text: t("tasks.wb.badgeProof", { count: md.proof.length }) });
  if (md?.claim) {
    out.push({ text: t("tasks.wb.badgeClaimed", { owner: md.claim.ownerId }) });
    const age = ageText(md.claim.lastHeartbeatAt, t);
    if (age) out.push({ text: t("tasks.wb.badgeHeartbeat", { age }) });
  }
  if (diag) out.push({ text: truncate(diag.title), warning: true, title: diag.detail });
  if (blockedReason) out.push({ text: truncate(blockedReason), warning: true, title: blockedReason });
  if (md?.stale) out.push({ text: t("tasks.wb.badgeStale"), warning: true });
  return out;
}
