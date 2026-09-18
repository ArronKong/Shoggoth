import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PageHead } from "../components/PageHead";
import type { TFunction } from "i18next";
import type { CronDelivery, CronRun, CronRunTrajectory, UnifiedAgent, UnifiedCronJob } from "../types";
import {
  createCronJob,
  deleteCronJob,
  getCronJobDetail,
  getCronLatestDelivery,
  getCronRunTrajectory,
  getCronRuns,
  listAgents,
  listCronJobs,
  runCronJob,
  setCronEnabled,
  updateCronJob,
  type CronListFilters,
  type CronRunsFilters,
} from "../api/client";
import BackendBadge from "../components/BackendBadge";
import BackendTabIcon from "../components/BackendTabIcon";
import PillTabs from "../components/PillTabs";
import Modal, { DetailRow, ModalSection } from "../components/Modal";
import { Switch } from "../components/Field";
import { useConfirm, useToast } from "../components/ui";
import { toSanitizedMarkdownHtml } from "../lib/markdown";
import TurnProcess from "../components/TurnTimeline/TurnProcess";
import { stepsFromParts } from "../lib/turnTimeline";
import { cronForceRunResumesPaused, useBackendCatalog, useEnabledBackends } from "../lib/backends";
import { usePageCache } from "../lib/usePageCache";
import { isVisibleCronJob } from "../lib/cronVisibility";
import { useRegisterPageRefresh, useRegisterPageLoading } from "../lib/page-refresh";
import { useStickyState } from "../lib/useStickyState";
import { createAsyncRequestController, createCronSelectionController, type AsyncRequestTicket } from "../lib/lowUiLifecycle";
import { canonicalCronSessionKey, firstNonBlankText, writeCronChatHandoff } from "../lib/cronChatHandoff";
import CronCalendar, {
  calendarRangeTitle,
  shiftCalendarCursor,
  startOfMonth,
  type CalendarMode,
} from "./CronCalendar";
import CronFiltersBar from "./cron/CronFiltersBar";
import CronCreateForm from "./cron/CronCreateForm";
import { cronAgentAvailable, cronCreateInputFromDraft, emptyCronCreateDraft } from "./cron/cronCreateDraft";
import { IconPlus, IconSearch } from "./cron/cronIcons";
import CronRunHistoryPanel from "./cron/CronRunHistoryPanel";
import { formatCronTime, scheduleText } from "./cron/cronPresets";
import HermesCronForm, {
  emptyHermesDraft,
  hermesDraftFromJob,
  hermesInputFromDraft,
  validateHermesDraft,
  type HermesCronDraft,
} from "./cron/HermesCronForm";
import OpenClawCronForm, {
  emptyOpenClawDraft,
  openClawDraftFromJob,
  openClawInputFromDraft,
  validateOpenClawDraft,
  type OpenClawCronDraft,
} from "./cron/OpenClawCronForm";
import NativeCronForm, {
  emptyNativeCronDraft,
  nativeCronDraftFromJob,
  nativeCronEditPlan,
  validateNativeCronDraft,
  type NativeCronDraft,
} from "./cron/ShoggothCronForm";

type ModalMode = "view" | "create"
  | "edit-openclaw" | "edit-hermes" | "edit-native" | null;
type CronSaveOperation = { ticket: AsyncRequestTicket; scope: string };

// 工具栏只暴露 agent/状态/计划三个筛选，排序保持固定的「下次运行升序」。
const DEFAULT_FILTERS: CronListFilters = {
  enabled: "all",
  scheduleKind: "all",
  sortBy: "nextRunAt",
  sortDir: "asc",
};

const DEFAULT_RUN_FILTERS: CronRunsFilters = {
  sortDir: "desc",
  limit: 25,
};

// 状态空值使用更明确的中文文案，减少列表里裸露的 undefined。
function stateLabel(job: UnifiedCronJob, t: TFunction): string {
  if (!job.enabled) return t("cron.disabled");
  if (job.stateLabel && !["ok", "error", "skipped", "scheduled", "disabled"].includes(job.stateLabel)) return job.stateLabel;
  return t("cron.enabled");
}

// 能力标签来自后端归一化，也兼容 rawCapabilities 的旧字段。
function capabilityTags(job: UnifiedCronJob): string[] {
  const tags = job.backendDetails?.capabilityTags || job.rawCapabilities || [];
  return Array.from(new Set(tags.filter(Boolean)));
}

// 投递信息优先显示高级 delivery，再回落到老字段 deliver。
function deliveryText(job: UnifiedCronJob): string {
  if (job.delivery?.mode) return job.delivery.mode;
  if (job.deliver) return job.deliver;
  return "none";
}

// 详情里展示结构化字段时限制长度，避免抽屉被大对象撑爆。
function jsonPreview(value: unknown): string {
  if (value === undefined || value === null) return "—";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// 页头统计基于当前服务端结果（含筛选），不额外猜测后端全量数据。
function countJobs(jobs: UnifiedCronJob[]): { total: number; enabled: number; error: number } {
  let enabled = 0;
  let error = 0;
  for (const job of jobs) {
    if (job.enabled) enabled += 1;
    if (job.lastStatus === "error") error += 1;
  }
  return { total: jobs.length, enabled, error };
}


// 表单保存前做最小校验，深层合法性交给各后端返回准确错误。
function requireName(name: string | undefined, t: TFunction): void {
  if (!name?.trim()) throw new Error(t("cron.nameRequired"));
}

export default function CronPage() {
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  // ref 负责同步互斥，避免同一 job 在 React 下一次渲染前被连续触发。
  const busyIdsRef = useRef<Set<string>>(new Set());
  const [view, setView] = useStickyState<"list" | "calendar">("cron.view", "calendar");
  // 日历的日期游标与视图粒度上提到页面：设计稿把它们和筛选并成同一排工具栏。
  // 游标故意不持久化——重开 App 停在上周比回到今天更让人以为任务丢了。
  const [calCursor, setCalCursor] = useState<Date>(() => new Date());
  const [calMode, setCalMode] = useStickyState<CalendarMode>("cron.calMode", "week");
  const [filters, setFilters] = useStickyState<CronListFilters>("cron.filters", DEFAULT_FILTERS);
  const [debouncedQuery, setDebouncedQuery] = useState(filters.query || "");
  // 搜索输入即时回显，但服务端查询短防抖，避免每个按键制造请求与缓存键。
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(filters.query || ""), 250);
    return () => window.clearTimeout(timer);
  }, [filters.query]);
  const requestFilters = useMemo(
    () => ({ ...filters, query: debouncedQuery || undefined }),
    [filters, debouncedQuery],
  );
  // 键含全部筛选项：换筛选=换键（未命中才进加载态），同筛选切回=秒开。
  const pageScope = `cron:${JSON.stringify(requestFilters)}`;
  const pageScopeRef = useRef(pageScope);
  pageScopeRef.current = pageScope;
  const { data: jobsData, loading, error, setError, refresh } = usePageCache(
    pageScope,
    () => listCronJobs(requestFilters),
  );
  // 缓存首帧也遵循同一规则，列表、日历、统计及下次运行共用可见任务。
  const jobs = useMemo(() => (jobsData ?? []).filter(isVisibleCronJob), [jobsData]);
  useRegisterPageRefresh("/cron", refresh);
  useRegisterPageLoading("/cron", loading);

  const [mode, setMode] = useState<ModalMode>(null);
  const [selected, setSelected] = useState<UnifiedCronJob | null>(null);
  const selectionControllerRef = useRef<ReturnType<typeof createCronSelectionController<UnifiedCronJob, CronRunsFilters>> | null>(null);
  if (!selectionControllerRef.current) {
    selectionControllerRef.current = createCronSelectionController<UnifiedCronJob, CronRunsFilters>(DEFAULT_RUN_FILTERS);
  }
  const selectionController = selectionControllerRef.current;
  const detailIntentControllerRef = useRef<ReturnType<typeof createAsyncRequestController> | null>(null);
  if (!detailIntentControllerRef.current) {
    detailIntentControllerRef.current = createAsyncRequestController();
  }
  const detailIntentController = detailIntentControllerRef.current;
  const agentsRequestControllerRef = useRef<ReturnType<typeof createAsyncRequestController> | null>(null);
  if (!agentsRequestControllerRef.current) {
    agentsRequestControllerRef.current = createAsyncRequestController();
  }
  const agentsRequestController = agentsRequestControllerRef.current;
  const [openClawDraft, setOpenClawDraft] = useState<OpenClawCronDraft>(emptyOpenClawDraft());
  const [hermesDraft, setHermesDraft] = useState<HermesCronDraft>(emptyHermesDraft());
  const [nativeDraft, setNativeDraft] = useState<NativeCronDraft>(emptyNativeCronDraft("shoggoth"));
  const [createDraft, setCreateDraft] = useState(emptyCronCreateDraft);
  const [agents, setAgents] = useState<Record<string, UnifiedAgent[]>>({});
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [failedAgentBackends, setFailedAgentBackends] = useState<string[]>([]);
  const [saveOperation, setSaveOperation] = useState<CronSaveOperation | null>(null);
  const saveOperationRef = useRef<CronSaveOperation | null>(null);
  const isCurrentSave = (operation: CronSaveOperation) =>
    pageScopeRef.current === operation.scope
    && detailIntentController.isCurrent(operation.ticket, operation.ticket.context);
  const saving = Boolean(saveOperation && isCurrentSave(saveOperation));
  const [runs, setRuns] = useState<CronRun[] | null>(null);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsFilters, setRunsFilters] = useState<CronRunsFilters>(DEFAULT_RUN_FILTERS);
  const [deliveryJob, setDeliveryJob] = useState<UnifiedCronJob | null>(null);
  const [delivery, setDelivery] = useState<CronDelivery | null>(null);
  // R342:该次运行的 Agent Trajectory(仅本机 OpenClaw 转录可及;其余 supported=false 隐藏)
  const [trajectory, setTrajectory] = useState<CronRunTrajectory | null>(null);

  const toast = useToast();
  const confirm = useConfirm();
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language;
  const fmtTime = (value?: number | null) => formatCronTime(value, locale);
  const backendCatalog = useBackendCatalog("cron");
  const enabledBackends = useEnabledBackends("cron");
  const backendDescriptors = useMemo(
    () => new Map(backendCatalog.map((descriptor) => [descriptor.id, descriptor])),
    [backendCatalog],
  );
  const cronKindFor = useCallback((backendId: string) => {
    return backendDescriptors.get(backendId)?.surfaces.cron?.kind ?? "native";
  }, [backendDescriptors]);
  const runWillResumePaused = useCallback((job: UnifiedCronJob) => {
    return cronForceRunResumesPaused(backendDescriptors.get(job.backendId), job);
  }, [backendDescriptors]);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // 仅由 Cron 桌面通知写入；普通访问不会携带该参数。
  const notificationJobId = searchParams.get("job");
  const notificationBackendId = searchParams.get("backend");
  // 打开后保留消费标记，用户手动关闭详情时不应因同一深链再次自动弹出。
  const openedNotificationJobId = useRef<string | null>(null);
  const stats = useMemo(() => countJobs(jobs), [jobs]);

  // 全场下一个要触发的任务：nextRunAt 已在未来且最小的那条（停用的不排队）。
  // 日历据此把对应那一格高亮成纯黑，回答"接下来跑的是谁"。
  const nextUp = useMemo(() => {
    const now = Date.now();
    let best: UnifiedCronJob | null = null;
    for (const job of jobs) {
      if (!job.enabled || !job.nextRunAt || job.nextRunAt <= now) continue;
      if (!best || job.nextRunAt < best.nextRunAt!) best = job;
    }
    return best ? { id: best.id, at: best.nextRunAt as number } : null;
  }, [jobs]);

  const loadAgents = useCallback(async () => {
    const ticket = agentsRequestController.begin("agents", "all");
    setAgentsLoading(true);
    const failures: string[] = [];
    const rows = await Promise.all(enabledBackends.map(async (backendId) => [
      backendId,
      await listAgents(backendId).catch(() => { failures.push(backendId); return []; }),
    ] as const));
    const next = Object.fromEntries(rows) as Record<string, UnifiedAgent[]>;
    if (agentsRequestController.isCurrent(ticket, "all")) {
      setAgents(next);
      setFailedAgentBackends(failures);
      setAgentsLoading(false);
    }
    return next;
  }, [agentsRequestController, enabledBackends]);

  const ensureAgents = useCallback(async () => {
    if (enabledBackends.every((backendId) => agents[backendId])) return agents;
    return loadAgents();
  }, [agents, enabledBackends, loadAgents]);

  // Agent 筛选要在进页面时就能列出候选，不能等到点「新建」才懒加载。
  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  const filterAgents = useMemo(
    () => enabledBackends.flatMap((backendId) => agents[backendId] || []),
    [agents, enabledBackends],
  );

  // 搜索框与「月|周|日」等宽。两者在不同 DOM 子树（页头 vs 工具栏），纯 CSS 绑不了，
  // 而这组标签的宽度会随中英文文案变——实测它的边框盒宽度，写进页面级 CSS 变量。
  // 切到列表视图时这组标签不存在，保留上一次的值，搜索框宽度不跳。
  const calTabsRef = useRef<HTMLDivElement>(null);
  const [calTabsWidth, setCalTabsWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = calTabsRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.borderBoxSize?.[0]?.inlineSize ?? el.getBoundingClientRect().width;
      if (width > 0) setCalTabsWidth(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [view]);

  // 每次拉取领一个序号；只有最新一次的响应可以写状态。OpenClaw(本地 WS) 与
  // Hermes(HTTP，可能是远端) 延迟差很大，先点开的慢任务如果后返回，会把已经渲染好的
  // 另一个任务的运行历史覆盖掉。
  const runsReqRef = useRef(0);
  const deliveryReqRef = useRef(0);
  useEffect(() => {
    detailIntentController.mount();
    agentsRequestController.mount();
    return () => {
      detailIntentController.unmount();
      agentsRequestController.unmount();
      runsReqRef.current += 1;
      deliveryReqRef.current += 1;
    };
  }, [agentsRequestController, detailIntentController]);

  const authoritativeJob = useCallback(async (
    job: UnifiedCronJob,
    ticket: ReturnType<typeof detailIntentController.begin>,
  ): Promise<UnifiedCronJob | null> => {
    if (cronKindFor(job.backendId) !== "native") {
      return detailIntentController.isCurrent(ticket, ticket.context) ? job : null;
    }
    try {
      const detail = await getCronJobDetail(job.id);
      return detailIntentController.isCurrent(ticket, ticket.context) ? detail : null;
    } catch (error) {
      if (detailIntentController.isCurrent(ticket, ticket.context)) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
      return null;
    }
  }, [cronKindFor, detailIntentController, toast]);

  const loadRunsFor = useCallback(async (job: UnifiedCronJob, nextFilters: CronRunsFilters) => {
    const seq = ++runsReqRef.current;
    setRunsLoading(true);
    try {
      const rows = await getCronRuns(job.id, nextFilters);
      if (seq !== runsReqRef.current) return; // 已被更新的请求取代
      setRuns(rows);
    } catch {
      if (seq !== runsReqRef.current) return;
      setRuns([]);
    } finally {
      if (seq === runsReqRef.current) setRunsLoading(false);
    }
  }, []);

  const refreshRuns = useCallback(async () => {
    const current = selectionController.current();
    if (!current) return;
    await loadRunsFor(current.job, current.filters);
  }, [loadRunsFor, selectionController]);

  // 通用任务动作封装 busy/error/toast，并在动作后刷新当前列表。
  const act = async (id: string, fn: () => Promise<void>, reloadRuns = false) => {
    if (busyIdsRef.current.has(id)) return;
    busyIdsRef.current.add(id);
    setBusyIds(new Set(busyIdsRef.current));
    setError(null);
    try {
      await fn();
      await refresh();
      if (reloadRuns) {
        const current = selectionController.currentForAction(id);
        if (current) await loadRunsFor(current.job, current.filters);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error(message);
    } finally {
      busyIdsRef.current.delete(id);
      setBusyIds(new Set(busyIdsRef.current));
    }
  };

  const runCronFromUi = async (job: UnifiedCronJob, reloadRuns = false) => {
    if (job.actions?.run === false) return;
    if (runWillResumePaused(job)) {
      const okToRun = await confirm({
        title: t("cron.runAndEnableTitle"),
        message: t("cron.runAndEnableConfirm", { name: job.name }),
        confirmLabel: t("cron.runAndEnable"),
      });
      if (!okToRun) return;
    }
    await act(job.id, () => runCronJob(job.id, "force"), reloadRuns);
  };

  // 统一复用列表行和通知深链的详情打开行为，确保运行历史也会同步加载。
  const openView = useCallback(async (job: UnifiedCronJob) => {
    const intent = `view:${job.backendId}:${job.id}`;
    const ticket = detailIntentController.begin("detail", intent);
    const target = await authoritativeJob(job, ticket);
    if (!target || !detailIntentController.isCurrent(ticket, intent)) return;
    selectionController.select(target);
    setSelected(target);
    setMode("view");
    setRuns(null);
    selectionController.setFilters(DEFAULT_RUN_FILTERS);
    setRunsFilters(DEFAULT_RUN_FILTERS);
    await loadRunsFor(target, DEFAULT_RUN_FILTERS);
    if (!detailIntentController.isCurrent(ticket, intent)) return;
  }, [authoritativeJob, detailIntentController, loadRunsFor, selectionController]);

  // Cron 列表加载完成后，根据通知深链定位任务并打开现有详情弹窗；找不到任务时保留列表页。
  useEffect(() => {
    if (!notificationJobId || loading || openedNotificationJobId.current === notificationJobId) return;
    const notificationJob = jobs.find((job) =>
      job.id === notificationJobId && (!notificationBackendId || job.backendId === notificationBackendId));
    if (!notificationJob) return;
    openedNotificationJobId.current = notificationJobId;
    void openView(notificationJob);
  }, [jobs, loading, notificationBackendId, notificationJobId, openView]);

  const openEdit = async (job: UnifiedCronJob) => {
    const intent = `edit:${job.backendId}:${job.id}`;
    const ticket = detailIntentController.begin("detail", intent);
    const target = await authoritativeJob(job, ticket);
    if (!target || !detailIntentController.isCurrent(ticket, intent)) return;
    if (target.actions?.edit === false) {
      await openView(target);
      return;
    }
    await ensureAgents();
    if (!detailIntentController.isCurrent(ticket, intent)) return;
    selectionController.select(target);
    setSelected(target);
    const kind = cronKindFor(target.backendId);
    if (kind === "openclaw") {
      setOpenClawDraft(openClawDraftFromJob(target));
      setMode("edit-openclaw");
    } else if (kind === "hermes") {
      setHermesDraft(hermesDraftFromJob(target));
      setMode("edit-hermes");
    } else {
      setNativeDraft(nativeCronDraftFromJob(target));
      setMode("edit-native");
    }
  };

  // Calendar chip click: a PAST occurrence that has already run → show THAT
  // occurrence's delivered content (resolved server-side from occurrenceMs, so
  // yesterday's slot shows yesterday's run, not the latest) in a centered modal;
  // a FUTURE occurrence (the clicked slot's time hasn't arrived yet) or a job
  // that never ran → jump to edit. Gating on the clicked occurrence time — not
  // just job.lastRunAt — keeps a recurring job's not-yet-due slot from showing
  // an earlier run's report.
  const openJobFromCalendar = async (job: UnifiedCronJob, occurrenceMs?: number) => {
    const isFutureSlot = typeof occurrenceMs === "number" && occurrenceMs > Date.now();
    if (isFutureSlot || !job.lastRunAt) {
      await openEdit(job);
      return;
    }
    const intent = `delivery:${job.backendId}:${job.id}:${occurrenceMs ?? "latest"}`;
    const detailTicket = detailIntentController.begin("detail", intent);
    const seq = ++deliveryReqRef.current;
    // 没有可复用的稳定摘要时不要先打开一行 loading 的矮弹窗；先关闭旧详情，
    // 等正文与可用轨迹完整就绪后再一次提交，保证首帧就是最终详情几何。
    setDeliveryJob(null);
    setDelivery(null);
    setTrajectory(null);
    try {
      const latest = await getCronLatestDelivery(job.id, occurrenceMs);
      if (seq !== deliveryReqRef.current) return;
      if (!detailIntentController.isCurrent(detailTicket, intent)) return;
      let nextTrajectory: CronRunTrajectory | null = null;
      // R342:拿到 run 的 sessionKey 后同步准备过程轨迹；失败静默（区块隐藏）。
      if (latest.sessionKey) {
        try {
          nextTrajectory = await getCronRunTrajectory(job.id, latest.sessionKey, latest.runId);
        } catch {
          nextTrajectory = null;
        }
      }
      if (seq !== deliveryReqRef.current) return;
      if (!detailIntentController.isCurrent(detailTicket, intent)) return;
      setDelivery(latest);
      setTrajectory(nextTrajectory);
      setDeliveryJob(job);
    } catch (err) {
      // 迟到的失败不能关掉用户当前正在看的那个弹窗。
      if (seq !== deliveryReqRef.current) return;
      if (!detailIntentController.isCurrent(detailTicket, intent)) return;
      toast.error(err instanceof Error ? err.message : String(err));
      setDeliveryJob(null);
    }
  };

  const closeDelivery = () => {
    detailIntentController.invalidate();
    deliveryReqRef.current += 1; // 关闭后，在途响应不得再写回弹窗
    setDeliveryJob(null);
    setDelivery(null);
    setTrajectory(null);
  };

  // R342:轨迹 parts → 时间线步骤;toolCallId 精确配对,用转录消息级 ms 时间戳
  // 推真实耗时(与聊天历史的降级「—」不同,cron 转录有可信时刻)。
  const trajectorySteps = useMemo(() => {
    if (!trajectory?.supported || !trajectory.parts.length) return [];
    const callTs = new Map<string, number>();
    const parts = trajectory.parts.map((p) => ({ ...p } as typeof p & { durationS?: number }));
    for (const p of parts) {
      if (p.type === "toolCall" && p.toolCallId && typeof p.ts === "number") {
        callTs.set(p.toolCallId, p.ts);
      } else if (p.type === "toolResult" && p.toolCallId && typeof p.ts === "number") {
        const t0 = callTs.get(p.toolCallId);
        if (typeof t0 === "number" && p.ts > t0) p.durationS = (p.ts - t0) / 1000;
      }
    }
    return stepsFromParts(parts);
  }, [trajectory]);

  // 报告正文走 sessionStorage，路由只携带短 session key；ChatPage 会把正文作为
  // 引用草稿放入该次运行的真实会话，不会自动发送。
  const askInChat = (backendId: string, sessionKey: string, report: string) => {
    writeCronChatHandoff(backendId, sessionKey, report);
    navigate(`/chat?backend=${encodeURIComponent(backendId)}&session=${encodeURIComponent(sessionKey)}`);
  };

  const deliveryReport = firstNonBlankText(delivery?.fullText, delivery?.summary);
  const deliverySessionKey = canonicalCronSessionKey(deliveryJob?.agentId, delivery?.sessionKey);

  const openCreate = () => {
    detailIntentController.begin("detail", "create");
    selectionController.clear();
    setSelected(null);
    setCreateDraft(emptyCronCreateDraft());
    setMode("create");
    void ensureAgents();
  };

  const closeModal = () => {
    detailIntentController.invalidate();
    runsReqRef.current += 1;
    selectionController.clear();
    setMode(null);
    setSelected(null);
    setRuns(null);
    setRunsLoading(false);
  };
  const dismissForm = () => {
    if (saveOperationRef.current && isCurrentSave(saveOperationRef.current)) return;
    closeModal();
  };

  const saveForm = async () => {
    if (!mode || mode === "view" || (saveOperationRef.current && isCurrentSave(saveOperationRef.current))) return;
    const operation = {
      ticket: detailIntentController.begin("detail", `save:${mode}:${selected?.backendId ?? ""}:${selected?.id ?? "new"}`),
      scope: pageScope,
    };
    saveOperationRef.current = operation;
    setSaveOperation(operation);
    try {
      let successMessage = "";
      if (mode === "create") {
        if (!selectedCreateAgent) throw new Error(t("cronForm.nativeValidateAgent"));
        const kind = backendDescriptors.get(createDraft.backendId)?.surfaces.cron?.kind;
        if (!kind) throw new Error(t("cronForm.nativeValidateAgent"));
        await createCronJob(cronCreateInputFromDraft(createDraft, kind, t));
        successMessage = t("cron.createdTask");
      } else if (mode === "edit-openclaw" && selected) {
        const validation = validateOpenClawDraft(openClawDraft);
        if (validation) throw new Error(t(validation));
        const input = openClawInputFromDraft(openClawDraft);
        requireName(input.name, t);
        await updateCronJob(selected.id, input);
        successMessage = t("cron.savedOpenClaw");
      } else if (mode === "edit-hermes" && selected) {
        const validation = validateHermesDraft(hermesDraft);
        if (validation) throw new Error(validation);
        const input = hermesInputFromDraft(hermesDraft);
        requireName(input.name, t);
        await updateCronJob(selected.id, input);
        successMessage = t("cron.savedHermes");
      } else if (mode === "edit-native" && selected) {
        const validation = validateNativeCronDraft(nativeDraft);
        if (validation) throw new Error(t(validation));
        const plan = nativeCronEditPlan(nativeDraft, selected);
        await updateCronJob(selected.id, plan.patch);
        if (plan.enabled !== null) await setCronEnabled(selected.id, plan.enabled);
        successMessage = t("cron.savedNative", { backend: backendDescriptors.get(nativeDraft.backendId)?.name || nativeDraft.backendId });
      }
      // A newer notification/selection, filter scope, or page unmount owns the
      // UI now. Finish the captured mutation but do not close or refresh its UI.
      if (!isCurrentSave(operation)) return;
      if (successMessage) toast.success(successMessage);
      setSaveOperation(null);
      closeModal();
      await refresh();
    } catch (err) {
      if (isCurrentSave(operation)) toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (saveOperationRef.current === operation) saveOperationRef.current = null;
      if (isCurrentSave(operation)) setSaveOperation(null);
    }
  };

  const doDelete = async (job: UnifiedCronJob) => {
    if (job.actions?.delete === false) return;
    const okToDelete = await confirm({
      title: t("cron.deleteTitle"),
      message: t("cron.deleteConfirm", { name: job.name }),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!okToDelete) return;
    try {
      await deleteCronJob(job.id);
      toast.success(t("cron.deleted"));
      closeModal();
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const formOpen = mode === "create"
    || mode === "edit-openclaw" || mode === "edit-hermes" || mode === "edit-native";
  const formTitle =
    mode === "create"
      ? t("cron.createTitle")
      : mode === "edit-openclaw"
        ? t("cron.editOpenClawTitle", { name: selected?.name ?? "" })
        : mode === "edit-hermes"
          ? t("cron.editHermesTitle", { name: selected?.name ?? "" })
          : t("cron.editNativeTitle", {
              backend: backendDescriptors.get(selected?.backendId || "")?.name || selected?.backendId || "",
              name: selected?.name ?? "",
            });

  // 搜索框每敲一个字都会换 usePageCache 的键 → 未命中即 loading=true。整页早退会把
  // 筛选条连同搜索框一起卸载，焦点和后续按键全丢；只让内容区进加载态（同 TasksPage）。
  const showLoading = loading && jobs.length === 0;

  const createBackends = backendCatalog.filter((descriptor) => enabledBackends.includes(descriptor.id));
  const selectedCreateAgent = createBackends.some((descriptor) => descriptor.id === createDraft.backendId)
    ? agents[createDraft.backendId]?.find((agent) => agent.id === createDraft.agentId && cronAgentAvailable(agent))
    : undefined;

  return (
    <div
      className="cron-page management-page"
      style={calTabsWidth ? ({ "--cron-search-w": `${Math.round(calTabsWidth)}px` } as CSSProperties) : undefined}
    >
      <PageHead
        title={t("cron.pageTitle")}
        subtitle={
          <span className="cron-stats">
            <span>{t("cron.statTotal", { n: stats.total })}</span>
            <span>{t("cron.statEnabled", { n: stats.enabled })}</span>
            <span>{t("cron.statError", { n: stats.error })}</span>
          </span>
        }
        actions={
          // 宽度跟着「月|周|日」走，放不下长文案：占位符用设计稿的短词，
          // 「搜什么」的完整说明退到 title / aria-label 里。
          <label className="cron-search-box" title={t("cronForm.filtersSearchPlaceholder")}>
            <IconSearch />
            <input
              className="cron-search-input"
              value={filters.query || ""}
              onChange={(event) => setFilters({ ...filters, query: event.target.value })}
              placeholder={t("cron.searchPlaceholder")}
              aria-label={t("cronForm.filtersSearchPlaceholder")}
            />
          </label>
        }
      />
      <div className="toolbar cron-toolbar">
        <PillTabs
          value={view}
          onChange={(next) => setView(next as "list" | "calendar")}
          items={[
            { value: "calendar", label: t("cron.viewCalendar") },
            { value: "list", label: t("cron.viewList") },
          ]}
          ariaLabel={t("cron.viewToggle")}
        />

        <CronFiltersBar filters={filters} agents={filterAgents} onChange={setFilters} />

        {createBackends.length > 0 && (
          <button className="btn-primary cron-new" onClick={openCreate}>
            <IconPlus />
            {t("cron.newTask")}
          </button>
        )}

        {/* 日期导航只在日历视图有意义，列表视图下整组隐藏。 */}
        {view === "calendar" && (
          <div className="cron-cal-nav">
            <button
              className="cron-cal-arrow"
              onClick={() => setCalCursor(shiftCalendarCursor(calCursor, calMode, -1))}
              aria-label={t("cron.calPrev")}
            >
              ‹
            </button>
            <span className="cron-cal-title">{calendarRangeTitle(calCursor, calMode, t)}</span>
            <button
              className="cron-cal-arrow"
              onClick={() => setCalCursor(shiftCalendarCursor(calCursor, calMode, 1))}
              aria-label={t("cron.calNext")}
            >
              ›
            </button>
            <button
              className="cron-cal-today"
              onClick={() => setCalCursor(calMode === "month" ? startOfMonth(new Date()) : new Date())}
            >
              {t("cron.calToday")}
            </button>
            <PillTabs
              value={calMode}
              onChange={(next) => {
                const mode = next as CalendarMode;
                setCalMode(mode);
                // 切到「月」时把游标吸到月初，否则第 31 天会落进没有该日的月份。
                if (mode === "month") setCalCursor(startOfMonth(calCursor));
              }}
              items={[
                { value: "month", label: t("cron.calMonth") },
                { value: "week", label: t("cron.calWeek") },
                { value: "day", label: t("cron.calDay") },
              ]}
              ariaLabel={t("cron.calModeToggle")}
              listRef={calTabsRef}
            />
          </div>
        )}
      </div>

      {error && <div className="error">{t("settings.error", { msg: error })}</div>}

      {showLoading ? (
        <p className="muted">{t("common.loading")}</p>
      ) : view === "calendar" ? (
        <CronCalendar
          jobs={jobs}
          cursor={calCursor}
          mode={calMode}
          nextUp={nextUp}
          onCursorChange={setCalCursor}
          onModeChange={setCalMode}
          onJobClick={openJobFromCalendar}
        />
      ) : jobs.length === 0 ? (
        <p className="empty-hint">{t("cron.emptyHint")}</p>
      ) : (
        <div className="table-wrap">
          <table className="cron-table cron-table-rich">
            <thead>
              <tr>
                <th>{t("cron.colTask")}</th>
                <th>{t("cron.colBackend")}</th>
                <th>{t("cron.colSchedule")}</th>
                <th>{t("cron.colLastStatus")}</th>
                <th>{t("cron.colState")}</th>
                <th>{t("cron.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const backendLabel = backendDescriptors.get(job.backendId)?.name || job.backendId;
                return (
                  <tr key={job.id} className={`clickable ${job.enabled ? "" : "row-disabled"}`} onClick={() => openView(job)}>
                    <td>
                      <div className="job-name">{job.name}</div>
                      {(job.description || job.prompt) && <div className="job-prompt">{job.description || job.prompt}</div>}
                    </td>
                    <td>
                      <span className="cron-backend-icon" role="img" aria-label={backendLabel} title={backendLabel}>
                        <BackendTabIcon backend={job.backendId} label={backendLabel} />
                      </span>
                    </td>
                    <td>{scheduleText(job, t, locale)}</td>
                    <td>
                      {job.lastStatus ? <span className={`status status-${job.lastStatus}`}>{job.lastStatus}</span> : "—"}
                      {job.lastError && <div className="status-error job-error">{job.lastError}</div>}
                    </td>
                    <td>{stateLabel(job, t)}</td>
                    <td className="actions" onClick={(event) => event.stopPropagation()}>
                      <button onClick={() => void runCronFromUi(job)} disabled={busyIds.has(job.id) || job.actions?.run === false}>
                        {t(runWillResumePaused(job) ? "cron.runAndEnable" : "cron.run")}
                      </button>
                      <button onClick={() => openEdit(job)} disabled={job.actions?.edit === false} title={job.actions?.reason === "system-managed" ? t("cron.systemManaged") : undefined}>{t("common.edit")}</button>
                      <button onClick={() => act(job.id, () => setCronEnabled(job.id, !job.enabled))} disabled={busyIds.has(job.id) || job.actions?.toggle === false} title={job.actions?.reason === "system-managed" ? t("cron.systemManaged") : undefined}>
                        {job.enabled ? t("cron.disable") : t("cron.enable")}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={mode === "view" && !!selected}
        onClose={closeModal}
        title={selected?.name}
        subtitle={selected && cronKindFor(selected.backendId) === "native" ? undefined : selected?.id}
        width={680}
        footer={selected && (
          <>
            <button className="foot-left btn-danger" disabled={selected.actions?.delete === false} onClick={() => doDelete(selected)}>{t("common.delete")}</button>
            {cronKindFor(selected.backendId) === "openclaw" && (
              <button className="btn-secondary" disabled={busyIds.has(selected.id) || selected.actions?.run === false} onClick={() => act(selected.id, () => runCronJob(selected.id, "due"), true)}>{t("cron.dueRun")}</button>
            )}
            <button className="btn-secondary" disabled={busyIds.has(selected.id) || selected.actions?.run === false} onClick={() => void runCronFromUi(selected, true)}>
              {t(runWillResumePaused(selected) ? "cron.runAndEnable" : "cron.runNow")}
            </button>
            <button className="btn-primary" disabled={selected.actions?.edit === false} onClick={() => openEdit(selected)}>{t("common.edit")}</button>
          </>
        )}
      >
        {selected && (
          <>
            <ModalSection title={t("cron.overview")}>
              {selected.actions?.reason === "system-managed" && <p className="muted">{t("cron.systemManaged")}</p>}
              <DetailRow label={t("cron.colBackend")}><BackendBadge backendId={selected.backendId} /></DetailRow>
              {selected.agentId && (
                <DetailRow label={t("cron.agentLabel")}>{selected.agentId}</DetailRow>
              )}
              <DetailRow label={t("cron.colSchedule")}>{scheduleText(selected, t, locale)}</DetailRow>
              <DetailRow label={t("cron.colState")}>{stateLabel(selected, t)}</DetailRow>
              <DetailRow label={t("cron.fieldEnabled")}>{selected.enabled ? t("cron.yes") : t("cron.no")}</DetailRow>
              <DetailRow label={t("cron.colNextRun")}>{fmtTime(selected.nextRunAt)}</DetailRow>
              <DetailRow label={t("cron.lastRun")}>{fmtTime(selected.lastRunAt)}</DetailRow>
              <DetailRow label={t("cron.colDelivery")}>{selected.deliver === "chat" ? t("nav.chat") : deliveryText(selected)}</DetailRow>
              {capabilityTags(selected).length > 0 && (
                <DetailRow label={t("cron.capabilities")}>
                  <span className="tag-list">
                    {capabilityTags(selected).map((tag) => <span key={tag} className="tag">{tag}</span>)}
                  </span>
                </DetailRow>
              )}
              {selected.lastStatus && <DetailRow label={t("cron.colLastStatus")}><span className={`status status-${selected.lastStatus}`}>{selected.lastStatus}</span></DetailRow>}
              {selected.lastError && <DetailRow label={t("cron.lastError")}><span className="status-error">{selected.lastError}</span></DetailRow>}
            </ModalSection>

            {selected.prompt && (
              <ModalSection title={t("cron.promptMessage")}>
                <pre className="detail-pre">{selected.prompt}</pre>
              </ModalSection>
            )}

            {cronKindFor(selected.backendId) === "openclaw" ? (
              <ModalSection title={t("cron.openClawConfig")}>
                <DetailRow label={t("cron.payload")}>{selected.payload?.kind || "—"}</DetailRow>
                <DetailRow label={t("cron.runTarget")}>{selected.sessionTarget || "—"}</DetailRow>
                <DetailRow label={t("cron.wake")}>{selected.wakeMode || "—"}</DetailRow>
                <DetailRow label={t("cron.deleteAfterRun")}>{selected.deleteAfterRun ? t("cron.yes") : t("cron.no")}</DetailRow>
                <DetailRow label={t("cron.colDelivery")}><pre className="detail-pre detail-pre-compact">{jsonPreview(selected.delivery)}</pre></DetailRow>
                <DetailRow label={t("cron.failureAlert")}><pre className="detail-pre detail-pre-compact">{jsonPreview(selected.failureAlert)}</pre></DetailRow>
              </ModalSection>
            ) : cronKindFor(selected.backendId) === "hermes" ? (
              <ModalSection title={t("cron.hermesConfig")}>
                <DetailRow label={t("cron.mode")}>{selected.noAgent ? t("cron.scriptTask") : t("cron.agentTask")}</DetailRow>
                {selected.script && <DetailRow label={t("common.script")}>{selected.script}</DetailRow>}
                {selected.workdir && <DetailRow label={t("common.workdir")}>{selected.workdir}</DetailRow>}
                {selected.profile && <DetailRow label={t("common.profile")}>{selected.profile}</DetailRow>}
                {selected.model && <DetailRow label={t("cron.model")}>{selected.model}</DetailRow>}
                {selected.provider && <DetailRow label={t("models.providerField")}>{selected.provider}</DetailRow>}
                {selected.baseUrl && <DetailRow label={t("models.baseUrl")}>{selected.baseUrl}</DetailRow>}
                {selected.skills?.length ? <DetailRow label={t("common.skills")}>{selected.skills.join(", ")}</DetailRow> : null}
                {selected.contextFrom?.length ? <DetailRow label={t("common.contextFrom")}>{selected.contextFrom.join(", ")}</DetailRow> : null}
                {selected.enabledToolsets?.length ? <DetailRow label={t("common.toolsets")}>{selected.enabledToolsets.join(", ")}</DetailRow> : null}
                {selected.repeat && <DetailRow label={t("cronForm.hermesRepeat")}>{jsonPreview(selected.repeat)}</DetailRow>}
              </ModalSection>
            ) : (
              <ModalSection title={t("cron.nativeConfig", { backend: backendDescriptors.get(selected.backendId)?.name || selected.backendId })}>
                <DetailRow label={t("cronForm.shoggothWorkspace")}>
                  {typeof selected.backendDetails?.raw?.workspace === "string" ? selected.backendDetails.raw.workspace : "—"}
                </DetailRow>
                <DetailRow label={t("cronForm.shoggothMisfire")}>{String(selected.backendDetails?.raw?.misfirePolicy || "—")}</DetailRow>
                <DetailRow label={t("cronForm.shoggothMaxCatchUp")}>{String(selected.backendDetails?.raw?.maxCatchUp || "—")}</DetailRow>
                <DetailRow label={t("cronForm.shoggothOverlap")}>{String(selected.backendDetails?.raw?.overlapPolicy || "—")}</DetailRow>
                <DetailRow label={t("cronForm.shoggothThreadPolicy")}>{String(selected.backendDetails?.raw?.threadPolicy || "—")}</DetailRow>
              </ModalSection>
            )}

            <ModalSection title={t("cron.runHistory")}>
              <CronRunHistoryPanel
                kind={cronKindFor(selected.backendId)}
                runs={runs}
                loading={runsLoading}
                filters={runsFilters}
                setFilters={(nextFilters) => {
                  selectionController.setFilters(nextFilters);
                  setRunsFilters(nextFilters);
                  loadRunsFor(selected, nextFilters);
                }}
                onRefresh={refreshRuns}
                onOpenChat={(sessionKey) => navigate(`/chat?backend=${encodeURIComponent(selected.backendId)}&session=${encodeURIComponent(sessionKey)}`)}
              />
            </ModalSection>
          </>
        )}
      </Modal>

      <Modal
        open={formOpen}
        onClose={dismissForm}
        dismissible={!saving}
        title={formTitle}
        width={720}
        className="cron-form-modal"
        footer={
          <>
            <div className="foot-left">
              <Switch
                checked={mode === "create" ? createDraft.enabled : mode === "edit-openclaw" ? openClawDraft.enabled : mode === "edit-hermes" ? hermesDraft.enabled : nativeDraft.enabled}
                onChange={(enabled) => {
                  if (mode === "create") setCreateDraft({ ...createDraft, enabled });
                  else if (mode === "edit-openclaw") setOpenClawDraft({ ...openClawDraft, enabled });
                  else if (mode === "edit-hermes") setHermesDraft({ ...hermesDraft, enabled });
                  else setNativeDraft({ ...nativeDraft, enabled });
                }}
                disabled={saving}
                label={t("cronForm.taskEnabled")}
              />
            </div>
            <button className="btn-secondary" onClick={dismissForm} disabled={saving}>{t("common.cancel")}</button>
            <button className="btn-primary" onClick={saveForm} disabled={saving || (mode === "create" && !selectedCreateAgent)}>{saving ? t("common.saving") : mode === "create" ? t("cronForm.createAction") : t("common.save")}</button>
          </>
        }
      >
        {mode === "create" && <CronCreateForm draft={createDraft} setDraft={setCreateDraft}
          backends={createBackends} agents={agents} loading={agentsLoading} failedBackends={failedAgentBackends}
          onRetry={() => { void loadAgents(); }} disabled={saving} />}
        {mode === "edit-openclaw" && (
          <OpenClawCronForm
            key={`${mode}:${selected?.id || "new"}`}
            draft={openClawDraft}
            setDraft={setOpenClawDraft}
          />
        )}
        {mode === "edit-hermes" && (
          <HermesCronForm
            key={`${mode}:${selected?.id || "new"}`}
            draft={hermesDraft}
            setDraft={setHermesDraft}
          />
        )}
        {mode === "edit-native" && (
          <NativeCronForm
            key={`${mode}:${selected?.id || "new"}`}
            draft={nativeDraft}
            setDraft={setNativeDraft}
          />
        )}
      </Modal>

      <Modal
        open={!!deliveryJob && !!delivery}
        onClose={closeDelivery}
        title={deliveryJob?.name}
        subtitle={deliveryJob && cronKindFor(deliveryJob.backendId) === "native" ? undefined : deliveryJob?.id}
        width={680}
        footer={
          deliveryJob && (
            <>
              {deliverySessionKey && deliveryReport && (
                <button className="foot-left btn-secondary" onClick={() => askInChat(deliveryJob.backendId, deliverySessionKey, deliveryReport)}>
                  {t("cron.askInChat")}
                </button>
              )}
              <button
                className="btn-primary"
                disabled={deliveryJob.actions?.edit === false}
                onClick={() => {
                  const job = deliveryJob;
                  closeDelivery();
                  openEdit(job);
                }}
              >
                {t("common.edit")}
              </button>
            </>
          )
        }
      >
        {delivery ? (
          <>
            <div className="cron-delivery-meta">
              {deliveryJob && <BackendBadge backendId={deliveryJob.backendId} />}
              {delivery.status && <span className={`status status-${delivery.status}`}>{delivery.status}</span>}
              <span className="mono muted">{fmtTime(delivery.startedAt)}</span>
              {typeof delivery.durationMs === "number" && (
                <span className="muted">{Math.round(delivery.durationMs / 100) / 10}s</span>
              )}
              {delivery.model && (
                <span className="muted">{delivery.provider ? `${delivery.provider}/` : ""}{delivery.model}</span>
              )}
            </div>
            {delivery.error && <div className="error">{delivery.error}</div>}
            {trajectorySteps.length > 0 && (
              <div style={{ margin: "10px 0 4px" }}>
                <TurnProcess steps={trajectorySteps} />
              </div>
            )}
            {delivery.source === "summary" && (
              <p className="muted cron-delivery-note">{t("cron.deliverySummaryNote")}</p>
            )}
            {delivery.fullText ? (
              <div className="chat-md cron-delivery-md" dangerouslySetInnerHTML={{ __html: toSanitizedMarkdownHtml(delivery.fullText) }} />
            ) : delivery.summary ? (
              <div className="chat-md cron-delivery-md" dangerouslySetInnerHTML={{ __html: toSanitizedMarkdownHtml(delivery.summary) }} />
            ) : (
              <p className="muted">{t("cron.deliveryNone")}</p>
            )}
          </>
        ) : (
          <p className="muted">{t("cron.deliveryNone")}</p>
        )}
      </Modal>
    </div>
  );
}
