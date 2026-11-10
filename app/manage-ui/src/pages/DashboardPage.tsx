import AgentAvatarView from "../components/AgentAvatar";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { animate } from "animejs";
import {
  getCronLatestDelivery,
  getNativeCronRunDelivery,
  getDashboardSection,
  listAgents,
  revealCli,
  revealAttachment,
  revealManagedAgentFile,
} from "../api/client";
import type {
  CronDelivery,
  DashboardActivityKanban,
  DashboardApprovalItem,
  DashboardRunEntry,
  DashboardRunningItem,
} from "../types";
import {
  DASHBOARD_REFRESH_INTERVAL_MS,
  readDashboardCache,
  resolveDashboardViewState,
  shouldWriteDashboardCache,
  writeDashboardCache,
} from "../lib/dashboardCache";
import { usePageCache } from "../lib/usePageCache";
import { useRegisterPageRefresh, useRegisterPageLoading } from "../lib/page-refresh";
import { PageHead } from "../components/PageHead";
import Modal from "../components/Modal";
import { useToast } from "../components/ui";
import { toSanitizedMarkdownHtml } from "../lib/markdown";
import { selectCronRunHandoffSource, writeCronChatHandoff } from "../lib/cronChatHandoff";
import { fmtCost, fmtTokens } from "./usage/charts";
import { cronDeliveryView, cronExecutionView } from "./cron/runPresentation";
import ActivityFeed from "./dashboard/ActivityFeed";
import DashboardSkeleton, { DashboardArtifactSkeleton, DashboardKpiSubSkeleton,
  DashboardKpiValueSkeleton, DashboardTaskBoardSkeleton } from "./dashboard/DashboardSkeleton";
import { useDashboardLiveWork } from "./dashboard/useDashboardLiveWork";
import RunDetailModal from "./dashboard/RunDetailModal";
import CronRunReportModal, { ReportNote, runExecutionFailed } from "./cron/CronRunReportModal";
import { recentDashboardArtifacts } from "../lib/dashboardArtifacts";
import ArtifactThumb from "../components/ArtifactThumb";
import { inspirationMediaUrl } from "./inspiration-media";
import { useBackendCatalog, useEnabledBackends } from "../lib/backends";
import { createAgentNameIndex, resolveAgentDisplayName } from "../lib/agentDisplay";
import "./dashboard/DashboardPage.css";

const InspirationDetail = lazy(() => import("./InspirationPage").then(module => ({ default: module.IdeaDetail })));

// —— CountUp/Kpi 复制自 UsagePage 的私有实现（那里的 .kpi 样式被 .usage-page
// 前缀锁死，抽共享要动 usage 页引用链）；出现第三个消费者时再抽到 components/。

// 首次显示直接使用已加载的数值，后续变化从当前显示值滚到新值。
// fmt 必须传模块级稳定引用，否则 effect 每次渲染都重跑动画。
function CountUp({ value, fmt }: { value: number; fmt: (n: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  useEffect(() => {
    const el = ref.current;
    if (!el || shown.current === value) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      shown.current = value;
      el.textContent = fmt(value);
      return;
    }
    const counter = { v: shown.current };
    const anim = animate(counter, {
      v: value,
      duration: 900,
      ease: "out(3)",
      onUpdate: () => {
        shown.current = counter.v;
        el.textContent = fmt(counter.v);
      },
    });
    return () => {
      anim.pause();
    };
  }, [value, fmt]);
  return <span ref={ref}>{fmt(shown.current)}</span>;
}

// 卡内布局照设计（Figma 6941:441-463）：标签左上，数值贴底，副行与数值基线并排；
// chart 是装饰性背景（tokens 卡的金色折线），绝对定位铺满卡片。
function Kpi({
  label,
  value,
  sub,
  chart,
  className,
  loading = false,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  chart?: ReactNode;
  className?: string;
  loading?: boolean;
}) {
  return (
    <div className={`kpi${className ? ` ${className}` : ""}`} aria-busy={loading || undefined}>
      {chart}
      {chart && <div className="kpi-scrim" aria-hidden="true" />}
      <div className="kpi-label">{label}</div>
      <div className="kpi-bottom">
        <div className="kpi-val">{value}</div>
        {sub != null && <div className="kpi-sub">{sub}</div>}
      </div>
    </div>
  );
}

// Token / Cost 卡曲线：最近 7 天真实用量（双后端按日求和）。曲线走 Catmull-Rom
// 平滑，金色描边 + 渐变垫底；数据不足 2 天时不绘制装饰曲线。
const SPARK_X0 = 0; // 曲线铺满卡片全宽（7 天点从卡片最左排到最右）
const SPARK_X1 = 405;
const SPARK_Y_MIN = 40; // 最大值落点（y 越小越高）
const SPARK_Y_MAX = 112; // 最小值落点

function sparkPath(points: number[]): string {
  const n = points.length;
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const xy = points.map((v, i) => {
    const x = SPARK_X0 + ((SPARK_X1 - SPARK_X0) * i) / (n - 1);
    const y = hi === lo ? (SPARK_Y_MIN + SPARK_Y_MAX) / 2 : SPARK_Y_MAX - ((v - lo) / (hi - lo)) * (SPARK_Y_MAX - SPARK_Y_MIN);
    return [x, y] as const;
  });
  let d = `M ${xy[0][0]} ${xy[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = xy[i - 1] ?? xy[i];
    const p1 = xy[i];
    const p2 = xy[i + 1];
    const p3 = xy[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

function KpiSpark({ points, gradientId }: { points: number[] | null; gradientId: string }) {
  const line = points && points.length >= 2 ? sparkPath(points) : null;
  return (
    <svg className="kpi-spark" viewBox="0 0 405 140" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f2cf2f" stopOpacity="0.28" />
          <stop offset="1" stopColor="#f2cf2f" stopOpacity="0" />
        </linearGradient>
      </defs>
      {line && (
        <>
          <path d={`${line} L ${SPARK_X1} 140 L ${SPARK_X0} 140 Z`} fill={`url(#${gradientId})`} />
          <path d={line} fill="none" stroke="#eec93a" strokeWidth="2.5" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

type KpiUsageSeries = {
  daily?: Array<{ date: string; totalTokens?: number; totalCost?: number }>;
};

// Token 与成本曲线必须共用同一个 7 天窗口：先按自然日跨后端求和，
// 再统一截取最近 7 天，避免两张并列卡片出现时间口径漂移。
export function aggregateKpiTrendPoints(series: Array<KpiUsageSeries | null>, limit = 7) {
  const byDate = new Map<string, { tokens: number; costs: number }>();
  for (const item of series) {
    for (const point of item?.daily || []) {
      const current = byDate.get(point.date) || { tokens: 0, costs: 0 };
      current.tokens += Number(point.totalTokens) || 0;
      current.costs += Number(point.totalCost) || 0;
      byDate.set(point.date, current);
    }
  }
  const recent = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(-limit)
    .map(([, point]) => point);
  return {
    tokens: recent.map((point) => point.tokens),
    costs: recent.map((point) => point.costs),
  };
}

const fmtCount = (n: number): string => String(Math.round(n));

// Task Board keeps its 16px geometry while sharing avatar loading/fallback behavior.
function TaskBoardAvatar({ agentId, displayName }: { agentId: string; displayName: string }) {
  return <AgentAvatarView agentId={agentId} name={displayName} className="tb-avatar" loading="lazy" />;
}

// Task Board 卡（Figma 25:666）：纯白背景、标题左上、成/失总数徽标右上，
// 卡内两列 agent「今日完成数」排行。ranking 已降序，前 3 落左列、次 3 落右列。
function TaskBoardCard({
  label,
  ok,
  fail,
  okLabel,
  failLabel,
  ranking,
}: {
  label: string;
  ok: number | null;
  fail: number | null;
  okLabel: string;
  failLabel: string;
  ranking: { agentId: string; backendId: string; displayName: string; count: number }[];
}) {
  const cols = [ranking.slice(0, 3), ranking.slice(3, 6)];
  return (
    <div className="kpi kpi-taskboard">
      <div className="tb-head">
        <span className="kpi-label">{label}</span>
        <span className="tb-badges">
          <span className="tb-badge tb-badge-ok" title={okLabel} aria-label={`${okLabel}: ${ok === null ? "—" : fmtCount(ok)}`}>
            {ok === null ? "—" : fmtCount(ok)}
          </span>
          <span className="tb-badge tb-badge-fail" title={failLabel} aria-label={`${failLabel}: ${fail === null ? "—" : fmtCount(fail)}`}>
            {fail === null ? "—" : fmtCount(fail)}
          </span>
        </span>
      </div>
      <div className="tb-cols">
        {cols.map((col, i) => (
          <div className="tb-col" key={i}>
            {col.map((r) => (
              <div className="tb-row" key={`${r.backendId}:${r.agentId}`}>
                <TaskBoardAvatar agentId={r.agentId} displayName={r.displayName} />
                <span className="tb-name">{r.displayName}</span>
                <span className="tb-count">{fmtCount(r.count)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// 昨日环比：昨日为 0 时无意义（返回 null 不渲染百分比）。
function deltaPct(today: number, yesterday: number): { text: string; up: boolean } | null {
  if (!(yesterday > 0)) return null;
  const pct = ((today - yesterday) / yesterday) * 100;
  return { text: `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`, up: pct >= 0 };
}


const fmtSize = (n?: number): string => {
  if (typeof n !== "number") return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

// artifact 用的相对时间（t 就地传入，避免组件外用 hook）。
function fmtRelative(ms: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return t("dashboard.justNow");
  if (diff < 3_600_000) return t("dashboard.minutesAgo", { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("dashboard.hoursAgo", { count: Math.floor(diff / 3_600_000) });
  if (diff < 7 * 86_400_000) return t("dashboard.daysAgo", { count: Math.floor(diff / 86_400_000) });
  return new Date(ms).toLocaleDateString();
}

export default function DashboardPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const enabledBackendIds = useEnabledBackends();
  const backendScopeKey = [...enabledBackendIds].sort().join(",");
  const backendCatalog = useBackendCatalog("dashboardRuns");
  const dashboardRunBackends = useMemo(
    () => new Set(backendCatalog.map((descriptor) => descriptor.id)),
    [backendCatalog],
  );
  const [persistedData] = useState(() => readDashboardCache());
  const cachedGeneratedAtRef = useRef(persistedData?.generatedAt);
  const [openedAt, setOpenedAt] = useState(Date.now);
  const activity = usePageCache(`dashboard:activity:${backendScopeKey}`, () => getDashboardSection("activity"));
  const usage = usePageCache(`dashboard:usage:${backendScopeKey}`, () => getDashboardSection("usage"));
  const artifacts = usePageCache(`dashboard:artifacts:${backendScopeKey}`, () => getDashboardSection("artifacts"));
  const freshness = { openedAt, now: Date.now() };
  const activityView = resolveDashboardViewState(
    activity.data, persistedData, activity.loading, activity.error, enabledBackendIds, freshness,
  );
  const usageView = resolveDashboardViewState(
    usage.data, persistedData, usage.loading, usage.error, enabledBackendIds, freshness,
  );
  const artifactView = resolveDashboardViewState(
    artifacts.data, persistedData, artifacts.loading, artifacts.error, enabledBackendIds, freshness,
  );
  const { data: activityData } = activityView;
  const { data: usageData } = usageView;
  const { data: artifactData } = artifactView;
  const visibleSnapshot = activityData ?? usageData ?? artifactData;
  const initialLoading = !visibleSnapshot && (activityView.showLoading || usageView.showLoading || artifactView.showLoading);
  const error = activity.error || usage.error || artifacts.error;
  const blockingError = !visibleSnapshot && !initialLoading ? error : null;
  const nonBlockingError = visibleSnapshot ? error : null;
  const { work: currentWork, refresh: refreshLiveWork } = useDashboardLiveWork(
    activityData === persistedData ? persistedData : undefined, backendScopeKey,
  );
  // Agent 目录并行加载，避免名称展示形成二次请求瀑布。
  const agentBackendIds = useEnabledBackends("agents");
  const agentDirectoryKey = agentBackendIds.join(",");
  const { data: agentDirectory, refresh: refreshAgentDirectory } = usePageCache(
    `dashboard:agent-names:${agentDirectoryKey}`,
    async () => {
      const results = await Promise.allSettled(agentBackendIds.map(async (backendId) => (
        (await listAgents(backendId)).map((agent) => ({ ...agent, backendId }))
      )));
      return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    },
  );
  const agentNames = useMemo(() => createAgentNameIndex(agentDirectory || []), [agentDirectory]);
  const currentAgentName = useCallback(
    (agentId: string, backendId?: string, fallback?: string) => (
      resolveAgentDisplayName(agentNames, agentId, backendId, fallback)
    ),
    [agentNames],
  );
  const { refresh: refreshActivity } = activity;
  const { refresh: refreshUsage } = usage;
  const { refresh: refreshArtifacts } = artifacts;
  const refresh = useCallback(async () => {
    await Promise.all([refreshActivity(), refreshUsage(), refreshArtifacts(), refreshAgentDirectory(), refreshLiveWork()]);
  }, [refreshActivity, refreshUsage, refreshArtifacts, refreshAgentDirectory, refreshLiveWork]);
  useRegisterPageRefresh("/dashboard", refresh);
  useRegisterPageLoading("/dashboard", initialLoading);

  // 持久化同日、同范围的完整快照。最早完成的分区决定首帧缓存年龄。
  useEffect(() => {
    if (!activityData || !usageData || !artifactData
      || activityData !== activity.data || usageData !== usage.data || artifactData !== artifacts.data) return;
    const snapshot = {
      ...activityData,
      usage: usageData.usage,
      artifacts: artifactData.artifacts,
      groupArtifacts: artifactData.groupArtifacts,
      running: [],
      approvals: [],
      generatedAt: Math.min(activityData.generatedAt, usageData.generatedAt, artifactData.generatedAt),
    };
    if (shouldWriteDashboardCache(snapshot, cachedGeneratedAtRef.current) && writeDashboardCache(snapshot)) {
      cachedGeneratedAtRef.current = snapshot.generatedAt;
    }
  }, [activity.data, activityData, usage.data, usageData, artifacts.data, artifactData]);

  // 页面可见时 45s 轮询 + 切回标签页立刻补一拍。refreshRef 防闭包过期
  // （TasksPage 的既有手法）；refresh() 写穿缓存、不进 loading，无闪烁。
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refreshRef.current();
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      setOpenedAt(Date.now());
      tick();
    };
    const iv = window.setInterval(tick, DASHBOARD_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const usageAgg = useMemo(() => {
    const z = { todayCost: 0, todayTokens: 0, yCost: 0, yTokens: 0, missing: 0, incomplete: false,
      ready: 0, yesterdayReady: false };
    for (const u of usageData?.usage || []) {
      z.todayCost += u.today?.totalCost || 0;
      z.todayTokens += u.today?.totalTokens || 0;
      z.yCost += u.yesterday?.totalCost || 0;
      z.yTokens += u.yesterday?.totalTokens || 0;
      z.missing += u.today?.missingCostEntries || 0;
      if (!u.today || u.availability === "partial" || u.availability === "unavailable") z.incomplete = true;
      if (u.today && u.availability !== "unavailable") z.ready++;
      if (u.yesterday || u.yesterdayComplete) z.yesterdayReady = true;
    }
    return z;
  }, [usageData]);
  // Authoritative totals/rankings are computed before activity pagination.
  const runStats = activityData?.taskStats?.total;
  const agentRanking = useMemo(() => (activityData?.taskStats?.byAgent || [])
    .filter(row => row.ok > 0)
    .map(row => ({ ...row, count: row.ok, displayName: currentAgentName(row.agentId, row.backendId) }))
    .sort((a, b) => b.count - a.count || a.agentId.localeCompare(b.agentId))
    .slice(0, 6), [currentAgentName, activityData?.taskStats]);
  const costReady = usageAgg.ready > 0 && !(usageAgg.missing > 0 && usageAgg.todayCost === 0);
  const costDelta = costReady && usageAgg.yesterdayReady && !usageAgg.incomplete && !usageAgg.missing ? deltaPct(usageAgg.todayCost, usageAgg.yCost) : null;
  const tokenDelta = usageAgg.ready && usageAgg.yesterdayReady && !usageAgg.incomplete ? deltaPct(usageAgg.todayTokens, usageAgg.yTokens) : null;

  // Today, yesterday and the chart reuse the same usage section response.
  const trendPoints = useMemo(() => aggregateKpiTrendPoints(usageData?.trends || []), [usageData?.trends]);
  const usageLoading = usageView.showLoading
    || (!usage.error && usageAgg.ready === 0 && !!usageData?.usage.some(entry => entry.error === "pending"));

  const [openInspirationId, setOpenInspirationId] = useState<string | null>(null);
  const [inspirationModalOpen, setInspirationModalOpen] = useState(false);
  const closeInspirationModal = () => setInspirationModalOpen(false);
  const handleInspirationModalOpenChangeComplete = (open: boolean) => {
    if (!open) setOpenInspirationId(null);
  };

  // Run 弹窗：打开时对非合成行懒拉投递全文（现成 delivery 端点，本机 transcript）。
  const [openRun, setOpenRun] = useState<DashboardRunEntry | null>(null);
  const [runModalOpen, setRunModalOpen] = useState(false);
  const [delivery, setDelivery] = useState<CronDelivery | null>(null);
  const [deliveryLoading, setDeliveryLoading] = useState(false);
  const runDeliveryRequestRef = useRef(0);
  const openRunModal = (run: DashboardRunEntry) => {
    runDeliveryRequestRef.current += 1;
    setOpenRun(run);
    setDelivery(null);
    setDeliveryLoading(!run.synthesized);
    setRunModalOpen(true);
  };
  const closeRunModal = () => {
    // 立即作废进行中的 transcript 请求，但保留现有内容给退场动画使用。
    runDeliveryRequestRef.current += 1;
    setRunModalOpen(false);
  };
  const handleRunModalOpenChangeComplete = (open: boolean) => {
    if (open) {
      const run = openRun;
      if (!run || run.synthesized) {
        setDeliveryLoading(false);
        return;
      }

      // 等入场过渡完成后再读 transcript；已有摘要先稳定占位，不在动画中途换全文。
      const requestId = runDeliveryRequestRef.current;
      // 原生 Cron 的实际启动时间可能晚于计划时刻，运行 ID 可以直接定位这次结果。
      const runId = run.backendId === "shoggoth" ? run.runId : undefined;
      const request = runId
        ? getNativeCronRunDelivery(run.jobId, runId)
        : getCronLatestDelivery(run.jobId, run.startedAt ?? undefined);
      request
        .then((nextDelivery) => {
          if (runDeliveryRequestRef.current === requestId && (!runId || nextDelivery.runId === runId)) {
            setDelivery(nextDelivery);
          }
        })
        .catch(() => {
          if (runDeliveryRequestRef.current === requestId) setDelivery(null);
        })
        .finally(() => {
          if (runDeliveryRequestRef.current === requestId) setDeliveryLoading(false);
        });
      return;
    }

    // 退场期间保留完整 DOM，避免正文先消失导致面板高度瞬间坍缩。
    setOpenRun(null);
    setDelivery(null);
    setDeliveryLoading(false);
  };

  const toast = useToast();
  const [backendRun, setBackendRun] = useState<DashboardRunningItem | DashboardApprovalItem | null>(null);
  const [backendRunOpen, setBackendRunOpen] = useState(false);

  const openBackendRun = (item: DashboardRunningItem | DashboardApprovalItem) => {
    if (!item.backendId || !dashboardRunBackends.has(item.backendId) || !item.runId) return;
    setBackendRun(item);
    setBackendRunOpen(true);
  };

  const revealArtifact = async (item: ReturnType<typeof recentDashboardArtifacts>[number]) => {
    if (item.attachment) {
      try { await revealAttachment(item.name, inspirationMediaUrl(item.attachment.id)); }
      catch { toast.error(t("dashboard.artifactRevealFailed")); }
    } else if (item.fileId && item.agentId) {
      try { await revealManagedAgentFile(item.backend, item.agentId, item.fileId); }
      catch { toast.error(t("dashboard.artifactRevealFailed")); }
    } else if (item.path) {
      const ok = await revealCli(item.path);
      if (!ok) toast.info(t("dashboard.revealFailed"));
    }
  };

  const statusRows = visibleSnapshot?.status || [];
  // delivery 端点可能只能给“最新一次”结果；只有 startedAt 精确一致时才允许覆盖
  // 用户点开的历史 run，否则正文与 session 始终一起回退 openRun。
  const runHandoff = selectCronRunHandoffSource(openRun, delivery);
  const openRunExecution = openRun ? cronExecutionView(openRun) : null;
  const openRunDelivery = openRun ? cronDeliveryView(openRun) : null;
  const visibleRunText = runHandoff.report;
  const runSessionKey = runHandoff.sessionKey;
  const askInChat = (backendId: string, sessionKey: string, report: string) => {
    writeCronChatHandoff(backendId, sessionKey, report);
    navigate(`/chat?backend=${encodeURIComponent(backendId)}&session=${encodeURIComponent(sessionKey)}`);
  };
  const runningItems = useMemo(
    () => (currentWork?.running || []).flatMap((s) => (
      s.supported ? s.items.map((item) => ({ ...item, backendId: item.backendId || s.backend })) : []
    )),
    [currentWork],
  );
  const approvalItems = useMemo(
    () => (currentWork?.approvals || []).flatMap((s) => (
      s.supported ? s.items.map((item) => ({ ...item, backendId: item.backendId || s.backend })) : []
    )),
    [currentWork],
  );
  // 文件目录与群聊已发布附件共用最近 20 条；远程目录保持原有降级提示。
  const artifactSections = artifactData?.artifacts || [];
  const artifactItems = useMemo(() => recentDashboardArtifacts(artifactData), [artifactData]);
  const artifactRemotes = artifactSections.filter((s) => !s.supported && s.reason === "remote");

  return (
    <div className="page management-page dashboard-page">
      <PageHead title={t("dashboard.title")} subtitle={t("dashboard.subtitle")} />

      {blockingError && (
        <div className="dash-error" role="alert">
          {blockingError}
          <button className="btn-primary" onClick={() => void refresh()}>
            {t("dashboard.refresh")}
          </button>
        </div>
      )}
      {nonBlockingError && (
        <div className="dash-error" role="status">
          {nonBlockingError}
          <button className="btn-primary" onClick={() => void refresh()}>
            {t("dashboard.refresh")}
          </button>
        </div>
      )}
      {initialLoading && <DashboardSkeleton backendCount={enabledBackendIds.length} />}

      {visibleSnapshot && (
        <>
          {/* KPI 行（Figma 25:507 三卡等宽）：今日 Tokens / 今日成本共用 7 天折线，
              Task Board 使用纯白双列排行。 */}
          <div className="kpi-row">
            <Kpi
              label={t("dashboard.kpiTodayTokens")}
              loading={usageLoading}
              value={usageLoading ? <DashboardKpiValueSkeleton /> : usageAgg.ready ? <CountUp value={usageAgg.todayTokens} fmt={fmtTokens} /> : "—"}
              sub={usageLoading ? <DashboardKpiSubSkeleton /> : (
                <Trans
                  i18nKey="dashboard.vsYesterday"
                  values={{ value: tokenDelta?.text ?? "—" }}
                  components={{ percent: <span className={tokenDelta ? (tokenDelta.up ? "delta-up" : "delta-down") : undefined} /> }}
                />
              )}
              chart={<KpiSpark points={trendPoints.tokens} gradientId="kpi-token-spark-fill" />}
            />
            <Kpi
              className="kpi-cost"
              label={t("dashboard.kpiTodayCost")}
              loading={usageLoading}
              value={usageLoading ? <DashboardKpiValueSkeleton /> : costReady ? <CountUp value={usageAgg.todayCost} fmt={fmtCost} /> : "—"}
              sub={usageLoading ? <DashboardKpiSubSkeleton /> : (
                <Trans
                  i18nKey="dashboard.vsYesterday"
                  values={{ value: costDelta?.text ?? "—" }}
                  components={{ percent: <span className={costDelta ? (costDelta.up ? "delta-up" : "delta-down") : undefined} /> }}
                />
              )}
              chart={<KpiSpark points={trendPoints.costs} gradientId="kpi-cost-spark-fill" />}
            />
            {activityView.showLoading ? <DashboardTaskBoardSkeleton /> : <TaskBoardCard
              label={t("dashboard.taskBoard")}
              ok={runStats?.ok ?? null}
              fail={runStats?.error ?? null}
              okLabel={t("dashboard.kpiRunsOk")}
              failLabel={t("dashboard.kpiRunsFail")}
              ranking={agentRanking}
            />}
          </div>

          {/* 主体两栏（照设计）：左「今日动态」活动面板 : 右「最近产出」≈ 2:1。 */}
          <div className="dash-columns">
            {/* 今日动态：统一活动流（cron/kanban/inspiration），独立组件承载筛选与分页。 */}
            <ActivityFeed
              status={statusRows}
              firstPage={activityData?.activityPage}
              sinceMs={visibleSnapshot.sinceMs}
              loading={activityView.showLoading}
              unavailable={!!activity.error && !activityData}
              running={runningItems}
              approvals={approvalItems}
              canRespondToApproval={(item) => !!item.backendId && dashboardRunBackends.has(item.backendId)}
              onApprovalResponded={refresh}
              onOpenApprovalRun={openBackendRun}
              onOpenRun={(e) => openRunModal(e.run)}
              onOpenRunning={openBackendRun}
              canOpenRunning={(item) => !!item.backendId && dashboardRunBackends.has(item.backendId)}
              getAgentDisplayName={currentAgentName}
              onOpenTask={(e: DashboardActivityKanban) => {
                const q = new URLSearchParams({ backend: e.backendId, task: e.kanban.taskId });
                if (e.kanban.board) q.set("board", e.kanban.board);
                navigate(`/tasks?${q.toString()}`);
              }}
              onOpenInspiration={(e) => {
                setOpenInspirationId(e.inspiration.ideaId);
                setInspirationModalOpen(true);
              }}
            />

            {/* 最近产出（右栏）：本机文件与群成员发送的文件，点击 Finder 定位。 */}
            <section className="dash-section dash-artifacts" aria-busy={artifactView.showLoading || undefined}>
              <h2 className="dash-section-title">
                {t("dashboard.artifactsTitle")}
                {artifactData && <span className="dash-section-count" title={t("dashboard.artifactsCountHint")}>{artifactItems.length}</span>}
              </h2>
              {artifactRemotes.map((s) => (
                <div key={s.backend} className="dash-remote-note">
                  {t("dashboard.artifactsRemote", { backend: s.backend })}
                </div>
              ))}
              {(artifactData?.groupArtifacts?.reason === "unavailable" || artifactData?.groupArtifacts?.partial) && (
                <div className="dash-remote-note">{t("dashboard.artifactsGroupUnavailable")}</div>
              )}
              {artifactSections.filter(s => s.partial || (!s.supported && s.reason !== "unsupported" && s.reason !== "remote")).map(s => (
                <div key={s.backend} className="dash-remote-note">
                  {t("dashboard.artifactsUnavailable", { backend: statusRows.find(row => row.id === s.backend)?.name || s.backend })}
                </div>
              ))}
              {artifactView.showLoading ? <DashboardArtifactSkeleton /> : artifactItems.length === 0 ? (
                artifactData && <div className="dash-empty">{t("dashboard.artifactsEmpty")}</div>
              ) : (
                <div className="dash-art-list">
                  {artifactItems.map((a) => (
                    <button
                      key={a.key}
                      className="dash-art"
                      title={`${a.groupName || a.path}\n${t("dashboard.revealHint")}`}
                      onClick={() => void revealArtifact(a)}
                    >
                      <ArtifactThumb name={a.name} />
                      <span className="dash-art-body">
                        <span className="dash-art-name">{a.name}</span>
                        <span className="dash-art-sub">
                          {a.groupName ? t("dashboard.artifactGroupSource", { group: a.groupName,
                            agent: currentAgentName(a.agentId!, a.backend, a.agentName || undefined) })
                            : a.agentId ? `@${currentAgentName(a.agentId, a.backend, a.agentName || undefined)}` : a.area}
                        </span>
                        <span className="dash-art-foot">
                          <span>{a.size != null ? fmtSize(a.size) : ""}</span>
                          <span className="dash-art-time">{fmtRelative(a.mtimeMs, t)}</span>
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>
        </>
      )}

      {openInspirationId && (
        <Suspense fallback={
          <Modal open title={t("inspiration.title")} onClose={() => setOpenInspirationId(null)}>
            <p role="status">{t("common.loading")}</p>
          </Modal>
        }>
          <InspirationDetail key={openInspirationId} id={openInspirationId} open={inspirationModalOpen}
            onClose={closeInspirationModal} onOpenChangeComplete={handleInspirationModalOpenChangeComplete}
            onChange={refresh} />
        </Suspense>
      )}

      <CronRunReportModal
        open={runModalOpen}
        onClose={closeRunModal}
        onOpenChangeComplete={handleRunModalOpenChangeComplete}
        title={openRun?.jobName || openRun?.jobId || ""}
        failed={runExecutionFailed(openRun?.status, openRun?.completionStatus)}
        agentId={openRun?.agentId}
        backendId={openRun?.backendId}
        runId={openRun?.runId}
        agentName={openRun?.agentId ? currentAgentName(openRun.agentId, openRun.backendId) : undefined}
        startedAt={openRun?.startedAt}
        durationMs={openRun?.durationMs}
        model={openRun?.model}
        bodyLabel={visibleRunText
          ? (runHandoff.isFullText ? t("dashboard.fullTextTitle") : t("dashboard.summaryTitle"))
          : undefined}
        onAskInChat={openRun && runSessionKey && visibleRunText && visibleRunText.trim()
          ? () => askInChat(openRun.backendId, runSessionKey, visibleRunText)
          : undefined}
        // 与 Cron 页同一个编辑：跳过去直接打开该任务的编辑表单。
        onEdit={() => {
          if (openRun) navigate(`/cron?job=${encodeURIComponent(openRun.jobId)}&edit=1`);
        }}
      >
        {openRunExecution?.detail && <ReportNote error>{openRunExecution.detail}</ReportNote>}
        {openRunDelivery && openRunDelivery.tone !== "success" && (
          <ReportNote>
            {t("cronForm.runDeliveryResult")} · {openRunDelivery.value === "silent" ? t("cron.silentComplete") : openRunDelivery.value}
            {openRunDelivery.detail ? ` · ${openRunDelivery.detail}` : ""}
          </ReportNote>
        )}
        {/* 全文优先（本机 transcript），退回摘要；合成行（Hermes 末次状态）两者皆无。 */}
        {visibleRunText && (
          <div
            className="chat-md cron-delivery-md"
            dangerouslySetInnerHTML={{
              __html: toSanitizedMarkdownHtml(visibleRunText, true),
            }}
          />
        )}
        {deliveryLoading && !visibleRunText && <ReportNote>{t("dashboard.fullTextLoading")}</ReportNote>}
        {!deliveryLoading && !visibleRunText && <ReportNote>{t("dashboard.fullTextNone")}</ReportNote>}
      </CronRunReportModal>

      {backendRun && enabledBackendIds.includes(backendRun.backendId!) && <Suspense fallback={null}>
        <RunDetailModal key={JSON.stringify([backendScopeKey, backendRun.backendId, backendRun.runId])}
          item={backendRun} agentName={currentAgentName(backendRun.agentId || "", backendRun.backendId)}
          onFinished={refresh}
          open={backendRunOpen} onClose={() => setBackendRunOpen(false)} onClosed={() => setBackendRun(null)} />
      </Suspense>}
    </div>
  );
}
