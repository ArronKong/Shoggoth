import { measureTelemetry } from "../lib/productTelemetry";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PageHead } from "../components/PageHead";
import type { TFunction } from "i18next";
import type { CronDelivery, UnifiedAgent, UnifiedCronJob } from "../types";
import {
  createCronJob,
  deleteCronJob,
  getCronJobDetail,
  getCronLatestDelivery,
  listAgents,
  listCronJobs,
  runCronJob,
  setCronEnabled,
  updateCronJob,
  type CronListFilters,
} from "../api/client";
import BackendTabIcon from "../components/BackendTabIcon";
import PillTabs from "../components/PillTabs";
import SearchCapsule from "../components/SearchCapsule";
import Modal from "../components/Modal";
import { Switch } from "../components/Field";
import { useConfirm, useToast } from "../components/ui";
import { toSanitizedMarkdownHtml } from "../lib/markdown";
import { cronForceRunResumesPaused, useBackendCatalog, useEnabledBackends } from "../lib/backends";
import { usePageCache } from "../lib/usePageCache";
import { isVisibleCronJob } from "../lib/cronVisibility";
import { useRegisterPageRefresh, useRegisterPageLoading } from "../lib/page-refresh";
import { useStickyState } from "../lib/useStickyState";
import { createAsyncRequestController, type AsyncRequestTicket } from "../lib/lowUiLifecycle";
import { canonicalCronSessionKey, firstNonBlankText, writeCronChatHandoff } from "../lib/cronChatHandoff";
import CronCalendar, {
  calendarRangeTitle,
  shiftCalendarCursor,
  startOfMonth,
  type CalendarMode,
} from "./CronCalendar";
import CronFiltersBar from "./cron/CronFiltersBar";
import CodexCronForm, { codexDraftFromJob, codexPatchFromDraft, emptyCodexCronDraft } from "./cron/CodexCronForm";
import { CronAssignedAgent } from "./cron/CronAgentPicker";
import CronCreateForm from "./cron/CronCreateForm";
import { cronAgentAvailable, cronCreateInputFromDraft, emptyCronCreateDraft } from "./cron/cronCreateDraft";
import { CRON_SCHEDULE_TYPES } from "./cron/CronFormLayout";
import { IconCalendarChevron, IconPlus } from "./cron/cronIcons";
import CronRunReportModal, { ReportNote, runExecutionFailed } from "./cron/CronRunReportModal";
import { scheduleText } from "./cron/cronPresets";
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

type ModalMode = "create"
  | "edit-openclaw" | "edit-hermes" | "edit-native" | "edit-codex" | null;
type CronFormOperation = { action: "save" | "delete"; ticket: AsyncRequestTicket; scope: string };
type CronJobDialogProps = {
  job: Pick<UnifiedCronJob, "id" | "backendId">;
  onClose: () => void;
  onChange: () => Promise<void>;
};

// Chat uses the same report, editor and mutation lifecycle without mounting the task page.
export function CronJobDialog(props: CronJobDialogProps) {
  return <CronPage dialog={props} />;
}

function CronPageRegistration({ refresh, loading }: { refresh: () => Promise<void>; loading: boolean }) {
  useRegisterPageRefresh("/cron", refresh);
  useRegisterPageLoading("/cron", loading);
  return null;
}

// 工具栏只暴露 agent/状态/计划三个筛选，排序保持固定的「下次运行升序」。
const DEFAULT_FILTERS: CronListFilters = {
  enabled: "all",
  scheduleKind: "all",
  sortBy: "nextRunAt",
  sortDir: "asc",
};

// 状态空值使用更明确的中文文案，减少列表里裸露的 undefined。
function stateLabel(job: UnifiedCronJob, t: TFunction): string {
  if (job.connectorMigrationRequired) return t("connectors.cronMigrationRequired");
  if (!job.enabled) return t("cron.disabled");
  if (job.stateLabel && !["ok", "error", "skipped", "scheduled", "disabled"].includes(job.stateLabel)) return job.stateLabel;
  return t("cron.enabled");
}

function lastRunResult(status: string | undefined, t: TFunction) {
  const label = status?.trim();
  const value = label?.toLowerCase();
  if (runExecutionFailed(value)) return { tone: "error", label: t("cron.resultError") };
  if (value === "ok" || value === "succeeded") return { tone: "success", label: t("cron.resultSuccess") };
  if (value === "skipped") return { tone: "skipped", label: t("cron.resultSkipped") };
  return { tone: "neutral", label: label || t("cron.resultNone") };
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

export default function CronPage({ dialog }: { dialog?: CronJobDialogProps } = {}) {
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  // ref 负责同步互斥，避免同一 job 在 React 下一次渲染前被连续触发。
  const busyIdsRef = useRef<Set<string>>(new Set());
  const [view, setView] = useStickyState<"list" | "calendar">("cron.view", "calendar");
  // 日历的日期游标与视图粒度上提到页面：设计稿把它们和筛选并成同一排工具栏。
  // 游标故意不持久化——重开 App 停在上周比回到今天更让人以为任务丢了。
  const [calCursor, setCalCursor] = useState<Date>(() => new Date());
  const [calMode, setCalMode] = useStickyState<CalendarMode>("cron.calMode", "week");
  const [savedFilters, setFilters] = useStickyState<CronListFilters>("cron.filters", DEFAULT_FILTERS);
  // 兼容旧版保存的计划筛选，界面和查询从首帧起都回退到「全部计划」。
  const filters = useMemo<CronListFilters>(() => ({
    ...savedFilters,
    scheduleKind: CRON_SCHEDULE_TYPES.find((kind) => kind === savedFilters.scheduleKind) ?? "all",
  }), [savedFilters]);
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
  const pageScope = dialog ? `cron-dialog:${JSON.stringify([dialog.job.backendId, dialog.job.id])}`
    : `cron:${JSON.stringify(requestFilters)}`;
  const pageScopeRef = useRef(pageScope);
  pageScopeRef.current = pageScope;
  const { data: jobsData, loading: pageLoading, error, setError, refresh: refreshPage } = usePageCache(
    pageScope,
    () => listCronJobs(requestFilters),
    { enabled: !dialog },
  );
  const loading = !dialog && pageLoading;
  const refresh = dialog?.onChange ?? refreshPage;
  // 缓存首帧也遵循同一规则，列表、日历、统计及下次运行共用可见任务。
  const jobs = useMemo(() => (jobsData ?? []).filter(isVisibleCronJob), [jobsData]);

  const [mode, setMode] = useState<ModalMode>(null);
  const [selected, setSelected] = useState<UnifiedCronJob | null>(null);
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
  const [formOperation, setFormOperation] = useState<CronFormOperation | null>(null);
  const formOperationRef = useRef<CronFormOperation | null>(null);
  const isCurrentFormOperation = (operation: CronFormOperation) =>
    pageScopeRef.current === operation.scope
    && detailIntentController.isCurrent(operation.ticket, operation.ticket.context);
  const isFormBusy = () => Boolean(formOperationRef.current && isCurrentFormOperation(formOperationRef.current));
  const formBusy = Boolean(formOperation && isCurrentFormOperation(formOperation));
  const saving = formBusy && formOperation?.action === "save";
  const [codexDraft, setCodexDraft] = useState(emptyCodexCronDraft);
  const [deliveryJob, setDeliveryJob] = useState<UnifiedCronJob | null>(null);
  const [delivery, setDelivery] = useState<CronDelivery | null>(null);

  const toast = useToast();
  const confirm = useConfirm();
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language;
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
  const linkedJobId = dialog?.job.id ?? searchParams.get("job");
  const linkedBackendId = dialog?.job.backendId ?? searchParams.get("backend");
  const linkedLatestRun = Boolean(dialog) || searchParams.get("run") === "latest" && searchParams.get("edit") !== "1";
  const notificationRequest = dialog ? null : searchParams.get("notification");
  const onDialogClose = dialog?.onClose;
  const openedJobLink = useRef<string | null>(null);
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

  const cronBackends = useMemo(
    () => backendCatalog.filter((descriptor) => enabledBackends.includes(descriptor.id)),
    [backendCatalog, enabledBackends],
  );

  const deliveryReqRef = useRef(0);
  useEffect(() => {
    detailIntentController.mount();
    agentsRequestController.mount();
    return () => {
      detailIntentController.unmount();
      agentsRequestController.unmount();
      deliveryReqRef.current += 1;
    };
  }, [agentsRequestController, detailIntentController]);

  // 通用任务动作封装 busy/error/toast，并在动作后刷新当前列表。
  const act = async (id: string, fn: () => Promise<void>) => {
    if (busyIdsRef.current.has(id)) return;
    busyIdsRef.current.add(id);
    setBusyIds(new Set(busyIdsRef.current));
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error(message);
    } finally {
      busyIdsRef.current.delete(id);
      setBusyIds(new Set(busyIdsRef.current));
    }
  };

  const runCronFromUi = async (job: UnifiedCronJob) => {
    if (job.actions?.run === false) return;
    if (runWillResumePaused(job)) {
      const okToRun = await confirm({
        title: t("cron.runAndEnableTitle"),
        message: t("cron.runAndEnableConfirm", { name: job.name }),
        confirmLabel: t("cron.runAndEnable"),
      });
      if (!okToRun) return;
    }
    await act(job.id, () => measureTelemetry("cron_run", job.backendId, () => runCronJob(job.id, "force")));
  };

  const openEdit = useCallback(async (job: UnifiedCronJob) => {
    if (!isVisibleCronJob(job)) return false;
    const ticket = detailIntentController.begin("detail", `edit:${job.backendId}:${job.id}`);
    const kind = cronKindFor(job.backendId);
    try {
      // Native list rows can carry only a prompt preview. Edit with the full definition.
      const target = kind === "native" ? await getCronJobDetail(job.id) : job;
      if (!detailIntentController.isCurrent(ticket, ticket.context)) return;
      if (!target || target.id !== job.id || target.backendId !== job.backendId || !isVisibleCronJob(target)) {
        toast.info(t("notif.cronUnavailable"));
        return false;
      }
      if (target.actions?.edit === false) {
        toast.info(t(target.actions.reason === "system-managed" ? "cron.systemManaged" : "cron.editUnavailable"));
        return false;
      }
      await ensureAgents();
      if (!detailIntentController.isCurrent(ticket, ticket.context)) return;
      setDeliveryJob(null);
      setDelivery(null);
      setSelected(target);
      if (target.origin === "codex-desktop") {
        setCodexDraft(codexDraftFromJob(target));
        setMode("edit-codex");
      } else if (kind === "openclaw") {
        setOpenClawDraft(openClawDraftFromJob(target));
        setMode("edit-openclaw");
      } else if (kind === "hermes") {
        setHermesDraft(hermesDraftFromJob(target));
        setMode("edit-hermes");
      } else {
        setNativeDraft(nativeCronDraftFromJob(target));
        setMode("edit-native");
      }
      return true;
    } catch (error) {
      if (detailIntentController.isCurrent(ticket, ticket.context)) {
        toast.error(error instanceof Error ? error.message : String(error));
        return false;
      }
    }
  }, [cronKindFor, detailIntentController, ensureAgents, t, toast]);

  const openRunReport = useCallback(async (job: UnifiedCronJob, occurrenceMs?: number) => {
    if (!isVisibleCronJob(job)) return false;
    const intent = `delivery:${job.backendId}:${job.id}:${occurrenceMs ?? "latest"}`;
    const ticket = detailIntentController.begin("detail", intent);
    const seq = ++deliveryReqRef.current;
    setDeliveryJob(null);
    setDelivery(null);
    try {
      const latest = await getCronLatestDelivery(job.id, occurrenceMs);
      if (seq !== deliveryReqRef.current || !detailIntentController.isCurrent(ticket, intent)) return;
      setMode(null);
      setSelected(null);
      setDelivery(latest);
      setDeliveryJob(job);
      return true;
    } catch (error) {
      if (seq !== deliveryReqRef.current || !detailIntentController.isCurrent(ticket, intent)) return;
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [detailIntentController, toast]);

  // 通知和任务链接可定位当前筛选之外的任务。通知序号让同一任务能再次打开。
  useEffect(() => {
    if (!linkedJobId || loading) return;
    const identity = JSON.stringify([linkedBackendId, linkedJobId, linkedLatestRun, notificationRequest]);
    if (openedJobLink.current === identity) return;
    openedJobLink.current = identity;
    const matchesLink = (job: UnifiedCronJob) =>
      job.id === linkedJobId && (!linkedBackendId || job.backendId === linkedBackendId);
    const linkedJob = jobs.find(matchesLink);
    if (linkedJob && !linkedLatestRun) {
      void openEdit(linkedJob);
      return;
    }
    // A cached list row can predate the first run. Check the current task before choosing a report or editor.
    const ticket = detailIntentController.begin("detail", `link:${identity}`);
    void listCronJobs(linkedBackendId ? { backend: linkedBackendId } : {}).then(async allJobs => {
      if (!detailIntentController.isCurrent(ticket, ticket.context)) return;
      const job = allJobs.find(item => isVisibleCronJob(item) && matchesLink(item));
      if (!job) {
        toast.info(t("notif.cronUnavailable"));
        onDialogClose?.();
      } else {
        const opened = linkedLatestRun && job.lastRunAt ? await openRunReport(job) : await openEdit(job);
        if (opened === false) onDialogClose?.();
      }
    }).catch(error => {
      if (detailIntentController.isCurrent(ticket, ticket.context)) {
        toast.error(error instanceof Error ? error.message : String(error));
        onDialogClose?.();
      }
    });
  }, [jobs, loading, linkedBackendId, linkedJobId, linkedLatestRun, notificationRequest, openEdit, openRunReport, detailIntentController, onDialogClose, t, toast]);

  // Calendar chip click: a PAST occurrence that has already run → show THAT
  // occurrence's delivered content (resolved server-side from occurrenceMs, so
  // yesterday's slot shows yesterday's run, not the latest) in a centered modal;
  // a FUTURE occurrence (the clicked slot's time hasn't arrived yet) or a job
  // that never ran → jump to edit. Gating on the clicked occurrence time — not
  // just job.lastRunAt — keeps a recurring job's not-yet-due slot from showing
  // an earlier run's report.
  const openJobFromCalendar = async (job: UnifiedCronJob, occurrenceMs?: number) => {
    if (!isVisibleCronJob(job)) return;
    const isFutureSlot = typeof occurrenceMs === "number" && occurrenceMs > Date.now();
    if (isFutureSlot || !job.lastRunAt) {
      await openEdit(job);
      return;
    }
    await openRunReport(job, occurrenceMs);
  };

  const closeDelivery = () => {
    detailIntentController.invalidate();
    deliveryReqRef.current += 1; // 关闭后，在途响应不得再写回弹窗
    setDeliveryJob(null);
    setDelivery(null);
  };

  // 报告正文走 sessionStorage，路由只携带短 session key；ChatPage 会把正文作为
  // 引用草稿放入该次运行的真实会话，不会自动发送。
  const askInChat = (backendId: string, sessionKey: string, report: string) => {
    writeCronChatHandoff(backendId, sessionKey, report);
    if (dialog) closeDelivery();
    navigate(`/chat?backend=${encodeURIComponent(backendId)}&session=${encodeURIComponent(sessionKey)}`);
  };

  const deliveryReport = firstNonBlankText(delivery?.fullText, delivery?.summary);
  const deliverySessionKey = canonicalCronSessionKey(deliveryJob?.agentId, delivery?.sessionKey);
  const deliveryAgent = deliveryJob?.agentId
    ? agents[deliveryJob.backendId]?.find((agent) => agent.id === deliveryJob.agentId)
    : undefined;

  const openCreate = () => {
    detailIntentController.begin("detail", "create");
    setSelected(null);
    setCreateDraft(emptyCronCreateDraft());
    setMode("create");
    void ensureAgents();
  };

  const closeModal = () => {
    detailIntentController.invalidate();
    setMode(null);
    setSelected(null);
  };
  const dismissModal = () => {
    if (isFormBusy()) return;
    closeModal();
  };

  const mutateForm = async (
    action: CronFormOperation["action"],
    target: string,
    submit: (operation: CronFormOperation) => Promise<string | undefined>,
  ) => {
    if (isFormBusy()) return;
    const operation: CronFormOperation = {
      action,
      ticket: detailIntentController.begin("detail", `${action}:${target}`),
      scope: pageScope,
    };
    formOperationRef.current = operation;
    setFormOperation(operation);
    try {
      const message = await submit(operation);
      // A newer notification, filter, or unmount owns the UI now.
      if (!message || !isCurrentFormOperation(operation)) return;
      toast.success(message);
      setFormOperation(null);
      closeModal();
      await refresh();
    } catch (err) {
      if (isCurrentFormOperation(operation)) toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (formOperationRef.current === operation) formOperationRef.current = null;
      if (isCurrentFormOperation(operation)) setFormOperation(null);
    }
  };

  const saveForm = async () => {
    if (!mode) return;
    await mutateForm("save", `${mode}:${selected?.backendId ?? ""}:${selected?.id ?? "new"}`, async () => {
      if (mode === "create") {
        if (!selectedCreateAgent) throw new Error(t("cronForm.nativeValidateAgent"));
        const kind = backendDescriptors.get(createDraft.backendId)?.surfaces.cron?.kind;
        if (!kind) throw new Error(t("cronForm.nativeValidateAgent"));
        const input = cronCreateInputFromDraft(createDraft, kind, t);
        await measureTelemetry("cron_create", createDraft.backendId, () => createCronJob(input));
        return t("cron.createdTask");
      }
      if (!selected) return;
      if (mode === "edit-openclaw") {
        const validation = validateOpenClawDraft(openClawDraft);
        if (validation) throw new Error(t(validation));
        const input = openClawInputFromDraft(openClawDraft);
        requireName(input.name, t);
        await updateCronJob(selected.id, input);
        return t("cron.savedOpenClaw");
      }
      if (mode === "edit-hermes") {
        const validation = validateHermesDraft(hermesDraft);
        if (validation) throw new Error(validation);
        const input = hermesInputFromDraft(hermesDraft);
        requireName(input.name, t);
        await updateCronJob(selected.id, input);
        return t("cron.savedHermes");
      }
      if (mode === "edit-codex") {
        await updateCronJob(selected.id, codexPatchFromDraft(codexDraft, selected));
        return t("codexAutomation.saved");
      }
      const validation = validateNativeCronDraft(nativeDraft);
      if (validation) throw new Error(t(validation));
      const plan = nativeCronEditPlan(nativeDraft, selected);
      await updateCronJob(selected.id, plan.patch);
      if (plan.enabled !== null) await setCronEnabled(selected.id, plan.enabled);
      return t("cron.savedNative", { backend: backendDescriptors.get(nativeDraft.backendId)?.name || nativeDraft.backendId });
    });
  };

  const doDelete = async (job: UnifiedCronJob) => {
    if (job.actions?.delete === false || busyIdsRef.current.has(job.id)) return;
    await mutateForm("delete", `${job.backendId}:${job.id}`, async (operation) => {
      const okToDelete = await confirm({
        title: t("cron.deleteTitle"),
        message: t("cron.deleteConfirm", { name: job.name }),
        confirmLabel: t("common.delete"),
        danger: true,
        focusCancel: true,
      });
      if (!okToDelete || !isCurrentFormOperation(operation)) return;
      await deleteCronJob(job.id);
      return t("cron.deleted");
    });
  };

  const formOpen = mode !== null;
  const handleDialogOpenChangeComplete = (open: boolean) => {
    if (!open && !mode && !deliveryJob) onDialogClose?.();
  };
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

  const selectedCreateAgent = cronBackends.some((descriptor) => descriptor.id === createDraft.backendId)
    ? agents[createDraft.backendId]?.find((agent) => agent.id === createDraft.agentId && cronAgentAvailable(agent))
    : undefined;
  const assignedAgent = formOpen && selected && <CronAssignedAgent
    agentId={selected.agentId}
    agentName={agents[selected.backendId]?.find((agent) => agent.id === selected.agentId)?.name}
    backendName={backendDescriptors.get(selected.backendId)?.name || selected.backendId}
    noAgent={selected.noAgent}
  />;

  return (
    <>
    {!dialog && <div className="cron-page management-page">
      <CronPageRegistration refresh={refresh} loading={loading} />
      <PageHead
        title={t("cron.pageTitle")}
        subtitle={
          <span className="cron-stats">
            <span>{t("cron.statTotal", { n: stats.total })}</span>
            <span>{t("cron.statEnabled", { n: stats.enabled })}</span>
            <span>{t("cron.statError", { n: stats.error })}</span>
          </span>
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

        <CronFiltersBar filters={filters} agents={agents} backends={cronBackends} onChange={setFilters} />

        <div className="cron-actions">
          <SearchCapsule
            value={filters.query || ""}
            onChange={(query) => setFilters((previous) => ({ ...previous, query }))}
            placeholder={t("cron.searchPlaceholder")}
            ariaLabel={t("cronForm.filtersSearchPlaceholder")}
            collapsible
          />
          {cronBackends.length > 0 && (
            <button
              className="btn-primary cron-new"
              onMouseDown={(event) => {
                // 等点击打开表单再转移焦点，避免空搜索框先收起而移走按钮。
                if (event.button === 0 && !filters.query
                  && event.currentTarget.parentElement?.querySelector('input[type="search"]:focus')) {
                  event.preventDefault();
                }
              }}
              onClick={openCreate}
            >
              <IconPlus />
              {t("cron.newTask")}
            </button>
          )}
        </div>

        {/* 日期导航只在日历视图有意义，列表视图下整组隐藏。 */}
        {view === "calendar" && (
          <div className="cron-cal-nav">
            <button
              className="cron-cal-arrow"
              onClick={() => setCalCursor(shiftCalendarCursor(calCursor, calMode, -1))}
              aria-label={t("cron.calPrev")}
            >
              <IconCalendarChevron direction="left" />
            </button>
            <span className="cron-cal-title">{calendarRangeTitle(calCursor, calMode, t)}</span>
            <button
              className="cron-cal-arrow"
              onClick={() => setCalCursor(shiftCalendarCursor(calCursor, calMode, 1))}
              aria-label={t("cron.calNext")}
            >
              <IconCalendarChevron direction="right" />
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
      ) : (
        <div className="table-wrap">
          {jobs.length === 0 ? (
            <p className="empty-hint">{t("cron.emptyHint")}</p>
          ) : (
            <table className="cron-table">
              <colgroup>
                <col />
                <col className="cron-col-backend" />
                <col className="cron-col-schedule" />
                <col className="cron-col-result" />
                <col className="cron-col-state" />
                <col className="cron-col-actions" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">{t("cron.colTask")}</th>
                  <th scope="col">{t("cron.colBackend")}</th>
                  <th scope="col">{t("cron.colSchedule")}</th>
                  <th scope="col">{t("cron.colLastStatus")}</th>
                  <th scope="col">{t("cron.colState")}</th>
                  <th scope="col">{t("cron.colActions")}</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  const backendLabel = backendDescriptors.get(job.backendId)?.name || job.backendId;
                  const canEdit = job.actions?.edit !== false;
                  const schedule = scheduleText(job, t, locale);
                  const result = lastRunResult(job.lastStatus, t);
                  const state = stateLabel(job, t);
                  return (
                    <tr key={job.id} className={canEdit ? "clickable" : undefined}
                      onClick={canEdit ? () => void openEdit(job) : undefined}>
                      <td>
                        <div className="job-name" title={job.name}>{job.name}{job.origin === "codex-desktop" && <span className="codex-origin">{t("codexAutomation.source")}</span>}</div>
                        {(job.description || job.prompt) && <div className="job-prompt">{job.description || job.prompt}</div>}
                      </td>
                      <td>
                        <span className="cron-backend" title={backendLabel}>
                          <span className="cron-backend-icon" aria-hidden="true">
                            <BackendTabIcon backend={job.backendId} label={backendLabel} />
                          </span>
                          <span className="cron-cell-text">{backendLabel}</span>
                        </span>
                      </td>
                      <td><span className="cron-schedule cron-cell-text" title={schedule}>{schedule}</span></td>
                      <td>
                        <span className="cron-result" data-tone={result.tone}>
                          <span className="cron-cell-text">{result.label}</span>
                        </span>
                        {job.lastError && <div className="job-error" title={job.lastError}>{job.lastError}</div>}
                      </td>
                      <td>
                        <span className="cron-schedule-state" data-state={job.connectorMigrationRequired ? "attention" : job.enabled ? "enabled" : "disabled"} title={state}>
                          <span className="cron-cell-text">{state}</span>
                        </span>
                      </td>
                      <td onClick={(event) => event.stopPropagation()}>
                        <div className="cron-row-actions">
                          <button type="button" className="btn-subtle btn-sm" onClick={() => void runCronFromUi(job)} disabled={busyIds.has(job.id) || job.actions?.run === false}>
                            {t(runWillResumePaused(job) ? "cron.runAndEnable" : "cron.run")}
                          </button>
                          <button type="button" className="btn-subtle btn-sm cron-quiet-action" onClick={() => void openEdit(job)} disabled={!canEdit} title={job.actions?.reason === "system-managed" ? t("cron.systemManaged") : undefined}>{t("common.edit")}</button>
                          <button type="button" className="btn-subtle btn-sm cron-quiet-action" onClick={() => act(job.id, () => measureTelemetry("cron_toggle", job.backendId, () => setCronEnabled(job.id, !job.enabled, job.revision)))} disabled={busyIds.has(job.id) || job.actions?.toggle === false} title={job.actions?.reason === "system-managed" ? t("cron.systemManaged") : undefined}>
                            {job.enabled ? t("cron.disable") : t("cron.enable")}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

    </div>}

      <Modal
        open={formOpen}
        onClose={dismissModal}
        onOpenChangeComplete={dialog ? handleDialogOpenChangeComplete : undefined}
        dismissible={!formBusy}
        title={formTitle}
        width={720}
        className="cron-form-modal"
        footer={
          <>
            <div className="foot-left">
              <Switch
                checked={mode === "create" ? createDraft.enabled : mode === "edit-openclaw" ? openClawDraft.enabled : mode === "edit-hermes" ? hermesDraft.enabled : mode === "edit-codex" ? codexDraft.enabled : nativeDraft.enabled}
                onChange={(enabled) => {
                  if (mode === "edit-codex") setCodexDraft({ ...codexDraft, enabled });
                  else if (mode === "create") setCreateDraft({ ...createDraft, enabled });
                  else if (mode === "edit-openclaw") setOpenClawDraft({ ...openClawDraft, enabled });
                  else if (mode === "edit-hermes") setHermesDraft({ ...hermesDraft, enabled });
                  else setNativeDraft({ ...nativeDraft, enabled });
                }}
                disabled={formBusy}
                label={t("cronForm.taskEnabled")}
              />
            </div>
            {mode === "create"
              ? <button className="btn-secondary" onClick={dismissModal} disabled={formBusy}>{t("common.cancel")}</button>
              : selected && <button className="btn-danger" onClick={() => doDelete(selected)}
                disabled={formBusy || busyIds.has(selected.id) || selected.actions?.delete === false}>{t("common.delete")}</button>}
            <button className="btn-primary" onClick={saveForm} disabled={formBusy || (mode === "create" && !selectedCreateAgent)}>{saving ? t("common.saving") : mode === "create" ? t("cronForm.createAction") : t("common.save")}</button>
          </>
        }
      >
        {mode === "create" && <CronCreateForm draft={createDraft} setDraft={setCreateDraft}
          backends={cronBackends} agents={agents} loading={agentsLoading} failedBackends={failedAgentBackends}
          onRetry={() => { void loadAgents(); }} disabled={formBusy} />}
        {mode === "edit-openclaw" && (
          <OpenClawCronForm
            key={`${mode}:${selected?.id || "new"}`}
            draft={openClawDraft}
            setDraft={setOpenClawDraft}
            assistant={assignedAgent}
          />
        )}
        {mode === "edit-hermes" && (
          <HermesCronForm
            key={`${mode}:${selected?.id || "new"}`}
            draft={hermesDraft}
            setDraft={setHermesDraft}
            assistant={assignedAgent}
          />
        )}
        {mode === "edit-codex" && selected && <CodexCronForm key={selected.id} draft={codexDraft} setDraft={setCodexDraft} assistant={assignedAgent} backendId={selected.backendId}
          timeZone={selected.schedule.kind === "rrule" ? selected.schedule.tz : undefined}
          targetEditable={!!selected.codex?.cwd && selected.codex?.target?.type === "projectless"} disabled={formBusy} />}
        {mode === "edit-native" && (
          <NativeCronForm
            key={`${mode}:${selected?.id || "new"}`}
            draft={nativeDraft}
            setDraft={setNativeDraft}
            assistant={assignedAgent}
          />
        )}
      </Modal>

      <CronRunReportModal
        open={!!deliveryJob && !!delivery}
        onClose={closeDelivery}
        onOpenChangeComplete={dialog ? handleDialogOpenChangeComplete : undefined}
        title={deliveryJob?.name}
        failed={runExecutionFailed(delivery?.status)}
        agentId={deliveryJob?.agentId}
        backendId={deliveryJob?.backendId}
        runId={delivery?.runId}
        agentName={deliveryAgent?.name}
        startedAt={delivery?.startedAt}
        durationMs={delivery?.durationMs}
        model={delivery?.model
          ? `${delivery.provider ? `${delivery.provider}/` : ""}${delivery.model}`
          : deliveryJob?.model || t("cronForm.modelDefault")}
        bodyLabel={delivery && delivery.outputDisposition !== "silent" && delivery.outputDisposition !== "pending"
          ? (delivery.fullText ? t("dashboard.fullTextTitle") : delivery.summary ? t("dashboard.summaryTitle") : undefined)
          : undefined}
        onAskInChat={deliveryJob && deliverySessionKey && deliveryReport
          ? () => askInChat(deliveryJob.backendId, deliverySessionKey, deliveryReport)
          : undefined}
        editDisabled={deliveryJob?.actions?.edit === false}
        onEdit={() => {
          const job = deliveryJob;
          if (!job) return;
          void openEdit(job);
        }}
      >
        {delivery?.error && <ReportNote error>{delivery.error}</ReportNote>}
        {delivery?.source === "summary" && <ReportNote>{t("cron.deliverySummaryNote")}</ReportNote>}
        {delivery?.outputDisposition === "silent" ? (
          <ReportNote>{t("cron.silentDelivery")}</ReportNote>
        ) : delivery?.outputDisposition === "pending" ? (
          <ReportNote>{t("cron.pendingDelivery")}</ReportNote>
        ) : delivery?.fullText ? (
          <div className="chat-md cron-delivery-md" dangerouslySetInnerHTML={{ __html: toSanitizedMarkdownHtml(delivery.fullText, true) }} />
        ) : delivery?.summary ? (
          <div className="chat-md cron-delivery-md" dangerouslySetInnerHTML={{ __html: toSanitizedMarkdownHtml(delivery.summary, true) }} />
        ) : (
          <ReportNote>{t("cron.deliveryNone")}</ReportNote>
        )}
      </CronRunReportModal>
    </>
  );
}
