import AgentAvatarView from "../components/AgentAvatar";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { animate } from "animejs";
import {
  getCronLatestDelivery,
  getBackendRunDetail,
  getDashboardSummary,
  getUsageSeries,
  listAgents,
  revealCli,
} from "../api/client";
import type {
  CronDelivery,
  DashboardActivityKanban,
  DashboardApprovalItem,
  DashboardRunEntry,
  DashboardRunningItem,
  BackendRunDetail,
} from "../types";
import {
  readDashboardCache,
  resolveDashboardViewState,
  shouldWriteDashboardCache,
  writeDashboardCache,
} from "../lib/dashboardCache";
import { usePageCache } from "../lib/usePageCache";
import { useRegisterPageRefresh, useRegisterPageLoading } from "../lib/page-refresh";
import { PageHead } from "../components/PageHead";
import Modal, { DetailRow, ModalSection } from "../components/Modal";
import { useToast } from "../components/ui";
import { toSanitizedMarkdownHtml } from "../lib/markdown";
import { selectCronRunHandoffSource, writeCronChatHandoff } from "../lib/cronChatHandoff";
import { fmtCost, fmtTokens, fmtMs } from "./usage/charts";
import { cronDeliveryView, cronExecutionView } from "./cron/runPresentation";
import ActivityFeed, { isVisibleDashboardActivity } from "./dashboard/ActivityFeed";
import { useDashboardLiveWork } from "./dashboard/useDashboardLiveWork";
import { useBackendCatalog, useEnabledBackends } from "../lib/backends";
import { createAgentNameIndex, resolveAgentDisplayName } from "../lib/agentDisplay";
import iconTextDocuments from "../assets/artifact-icons/icon_textdocuments.png";
import iconImagesGraphics from "../assets/artifact-icons/icon_imagesgraphics.png";
import iconAudioVideo from "../assets/artifact-icons/icon_audiovideo.png";
import iconArchiveCompression from "../assets/artifact-icons/icon_archivecompression.png";
import iconExecutableSystem from "../assets/artifact-icons/icon_executablesystem.png";
import iconWebSourceCode from "../assets/artifact-icons/icon_websourcecode.png";
import "./dashboard/DashboardPage.css";

const InspirationDetail = lazy(() => import("./InspirationPage").then(module => ({ default: module.IdeaDetail })));

// —— CountUp/Kpi 复制自 UsagePage 的私有实现（那里的 .kpi 样式被 .usage-page
// 前缀锁死，抽共享要动 usage 页引用链）；出现第三个消费者时再抽到 components/。

// anime.js 数字滚动：挂载从 0 滚入，值变化从当前显示值滚到新值。
// fmt 必须传模块级稳定引用，否则 effect 每次渲染都重跑动画。
function CountUp({ value, fmt }: { value: number; fmt: (n: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
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
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  chart?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`kpi${className ? ` ${className}` : ""}`}>
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
  ok: number;
  fail: number;
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
          <span className="tb-badge tb-badge-ok" title={okLabel} aria-label={`${okLabel}: ${fmtCount(ok)}`}>
            {fmtCount(ok)}
          </span>
          <span className="tb-badge tb-badge-fail" title={failLabel} aria-label={`${failLabel}: ${fmtCount(fail)}`}>
            {fmtCount(fail)}
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

function runFailed(run: DashboardRunEntry): boolean {
  if (run.completionStatus) return run.completionStatus === "failed";
  return run.status === "error" || !!run.error;
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

// 产出文件按后缀归 6 大类（通用文件管理器口径，不特判本机数据）；未匹配 → 文本与文档兜底。
type ArtifactCategory =
  | "textdocuments" | "imagesgraphics" | "audiovideo"
  | "archivecompression" | "executablesystem" | "websourcecode";

const ARTIFACT_CATEGORY_ICONS: Record<ArtifactCategory, string> = {
  textdocuments: iconTextDocuments,
  imagesgraphics: iconImagesGraphics,
  audiovideo: iconAudioVideo,
  archivecompression: iconArchiveCompression,
  executablesystem: iconExecutableSystem,
  websourcecode: iconWebSourceCode,
};

// 后缀（小写、不含点）→ 类别。json/csv/yaml 归网页与代码（按用户口径）；.xlsx→文档、.dmg→执行、.iso→压缩。
const ARTIFACT_EXT_CATEGORY: Record<string, ArtifactCategory> = {
  md: "textdocuments", markdown: "textdocuments", txt: "textdocuments", pdf: "textdocuments",
  doc: "textdocuments", docx: "textdocuments", xls: "textdocuments", xlsx: "textdocuments",
  ppt: "textdocuments", pptx: "textdocuments", rtf: "textdocuments", odt: "textdocuments",
  pages: "textdocuments", key: "textdocuments", numbers: "textdocuments", epub: "textdocuments", tex: "textdocuments",
  jpg: "imagesgraphics", jpeg: "imagesgraphics", png: "imagesgraphics", gif: "imagesgraphics",
  svg: "imagesgraphics", psd: "imagesgraphics", webp: "imagesgraphics", heic: "imagesgraphics",
  bmp: "imagesgraphics", tiff: "imagesgraphics", tif: "imagesgraphics", ico: "imagesgraphics",
  ai: "imagesgraphics", sketch: "imagesgraphics", fig: "imagesgraphics", avif: "imagesgraphics",
  mp3: "audiovideo", wav: "audiovideo", flac: "audiovideo", aac: "audiovideo", ogg: "audiovideo",
  m4a: "audiovideo", mp4: "audiovideo", mkv: "audiovideo", mov: "audiovideo", avi: "audiovideo",
  webm: "audiovideo", wmv: "audiovideo", flv: "audiovideo", m4v: "audiovideo",
  zip: "archivecompression", rar: "archivecompression", "7z": "archivecompression", iso: "archivecompression",
  tar: "archivecompression", gz: "archivecompression", tgz: "archivecompression", bz2: "archivecompression", xz: "archivecompression",
  exe: "executablesystem", msi: "executablesystem", app: "executablesystem", dmg: "executablesystem",
  pkg: "executablesystem", dll: "executablesystem", deb: "executablesystem", rpm: "executablesystem",
  apk: "executablesystem", bin: "executablesystem", so: "executablesystem", sys: "executablesystem",
  html: "websourcecode", htm: "websourcecode", css: "websourcecode", py: "websourcecode",
  js: "websourcecode", ts: "websourcecode", tsx: "websourcecode", jsx: "websourcecode",
  java: "websourcecode", json: "websourcecode", csv: "websourcecode", yaml: "websourcecode",
  yml: "websourcecode", toml: "websourcecode", xml: "websourcecode", sh: "websourcecode",
  go: "websourcecode", rs: "websourcecode", c: "websourcecode", cpp: "websourcecode", h: "websourcecode",
  rb: "websourcecode", php: "websourcecode", sql: "websourcecode", ipynb: "websourcecode", vue: "websourcecode",
};

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0 || i >= name.length - 1) return "";
  return name.slice(i + 1).toLowerCase();
}
// 后缀标签（大写、最长 4 字符），叠加在图标上；隐藏文件 / 无后缀 → 空。
function extLabel(name: string): string {
  return extOf(name).slice(0, 4).toUpperCase();
}
function artifactCategory(name: string): ArtifactCategory {
  return ARTIFACT_EXT_CATEGORY[extOf(name)] || "textdocuments";
}

// 后缀文字颜色（叠在图标左下角，各类一色 @ 50% 透明度，随图标配色，用户指定）。
const ARTIFACT_CATEGORY_EXT_COLORS: Record<ArtifactCategory, string> = {
  textdocuments: "rgba(255, 196, 89, 0.5)", // FFC459
  websourcecode: "rgba(255, 196, 89, 0.5)", // FFC459
  imagesgraphics: "rgba(255, 128, 130, 0.5)", // FF8082
  audiovideo: "rgba(217, 108, 199, 0.5)", // D96CC7
  archivecompression: "rgba(238, 196, 119, 0.5)", // EEC477
  executablesystem: "rgba(81, 145, 255, 0.5)", // 5191FF
};

// 产出缩略图：一律按 6 大类文件夹图标（含图片，不走真实预览），
// 后缀印在左下角，颜色随类别。
function ArtifactThumb({ name }: { name: string }) {
  const ext = extLabel(name);
  const category = artifactCategory(name);
  return (
    <span className="dash-art-thumb">
      <img className="dash-art-icon" src={ARTIFACT_CATEGORY_ICONS[category]} alt="" aria-hidden="true" />
      {ext ? (
        <span className="dash-art-ext" style={{ color: ARTIFACT_CATEGORY_EXT_COLORS[category] }}>
          {ext}
        </span>
      ) : null}
    </span>
  );
}

export default function DashboardPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const backendCatalog = useBackendCatalog("dashboardRuns");
  const dashboardRunBackends = useMemo(
    () => new Set(backendCatalog.map((descriptor) => descriptor.id)),
    [backendCatalog],
  );
  const [persistedData] = useState(() => readDashboardCache());
  const cachedGeneratedAtRef = useRef(persistedData?.generatedAt);
  const { data: liveData, loading, error, refresh: refreshDashboard } = usePageCache("dashboard", getDashboardSummary);
  const { data, showLoading, blockingError, nonBlockingError } = resolveDashboardViewState(
    liveData,
    persistedData,
    loading,
    error,
  );
  const { work: liveWork, refresh: refreshLiveWork } = useDashboardLiveWork(data);
  const currentWork = liveWork || data;
  // Agent 目录与 Dashboard summary 并行加载，避免名称展示形成二次请求瀑布。
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
  const refresh = useCallback(
    () => Promise.all([refreshDashboard(), refreshAgentDirectory(), refreshLiveWork()]).then(() => undefined),
    [refreshAgentDirectory, refreshDashboard, refreshLiveWork],
  );
  useRegisterPageRefresh("/dashboard", refresh);
  useRegisterPageLoading("/dashboard", showLoading);

  // 只持久化服务端实时结果；缓存首帧本身不回写，避免延长陈旧数据寿命。
  useEffect(() => {
    if (!liveData || !shouldWriteDashboardCache(liveData, cachedGeneratedAtRef.current)) return;
    if (writeDashboardCache(liveData)) cachedGeneratedAtRef.current = liveData.generatedAt;
  }, [liveData]);

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
    const iv = window.setInterval(tick, 45_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(iv);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  // KPI 聚合：usage 跨后端求和；运行成败从今日 runs 数（注意 runs 被 runsLimit
  // 截断，极端多产日会低估——feed 同源，口径一致）。
  const usageAgg = useMemo(() => {
    const z = { todayCost: 0, todayTokens: 0, yCost: 0, yTokens: 0 };
    for (const u of data?.usage || []) {
      z.todayCost += u.today?.totalCost || 0;
      z.todayTokens += u.today?.totalTokens || 0;
      z.yCost += u.yesterday?.totalCost || 0;
      z.yTokens += u.yesterday?.totalTokens || 0;
    }
    return z;
  }, [data]);
  // KPI 成败口径：优先服务端 runStats（活动层当天全量，消除 runsLimit=50 截断
  // 低估）；老服务端无该字段时回退旧的 runs 计数。
  const runStats = useMemo(() => {
    // 与「今日动态」同口径：成败从今日活动流全量按 severity 归类（error→失败，其余含
    // kanban 看板操作→成功），使「成功 + 失败 = 今日动态」。今日活动 < 首屏页大小
    // (DEFAULT_PAGE_LIMIT=100) 时首屏即全量。
    const acts = data?.activityPage?.items;
    if (acts) {
      let okCount = 0;
      let failCount = 0;
      for (const a of acts) {
        if (!isVisibleDashboardActivity(a)) continue;
        if (a.severity === "error") failCount += 1;
        else okCount += 1;
      }
      return { okCount, failCount };
    }
    // 活动流缺失时回退：服务端 cron runStats → 旧 runs 计数。
    if (data?.runStats?.total) {
      const t0 = data.runStats.total;
      return { okCount: t0.ok, failCount: t0.error };
    }
    let okCount = 0;
    let failCount = 0;
    for (const r of data?.runs || []) {
      if (runFailed(r)) failCount += 1;
      else okCount += 1;
    }
    return { okCount, failCount };
  }, [data]);
  // Task Board 卡：各 agent「今日完成数」排行。口径与上面 runStats 的成功侧一致
  // （severity 非 error 记为完成），排除系统健康及 heartbeat 记录，只计有 agentId 归属的活动；
  // 降序取前 6 → 两列各 3 行（照设计 7071-364）。
  const agentRanking = useMemo(() => {
    const byAgent = new Map<string, { agentId: string; backendId: string; count: number }>();
    for (const a of data?.activityPage?.items || []) {
      if (!isVisibleDashboardActivity(a) || a.severity === "error" || !a.agentId) continue;
      const key = `${a.backendId}\u0000${a.agentId}`;
      const row = byAgent.get(key);
      byAgent.set(key, { agentId: a.agentId, backendId: a.backendId, count: (row?.count || 0) + 1 });
    }
    return [...byAgent.values()]
      .map((row) => ({ ...row, displayName: currentAgentName(row.agentId, row.backendId) }))
      .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.agentId < b.agentId ? -1 : 1))
      .slice(0, 6);
  }, [currentAgentName, data]);
  const costDelta = deltaPct(usageAgg.todayCost, usageAgg.yCost);
  const tokenDelta = deltaPct(usageAgg.todayTokens, usageAgg.yTokens);

  // Token 与成本曲线共用最近 7 天序列（双后端按日求和）。status 首次就绪后
  // 拉一次；单后端失败静默忽略（铁律 4），至少一个成功就渲染对应趋势。
  const [trendPoints, setTrendPoints] = useState<{ tokens: number[]; costs: number[] }>({ tokens: [], costs: [] });
  const sparkFetchedRef = useRef(false);
  const backendIds = (data?.status || []).map((b) => b.id).join(",");
  const usagePending = (data?.usage || []).some((entry) => entry.error === "pending");
  useEffect(() => {
    if (sparkFetchedRef.current || !backendIds) return;
    sparkFetchedRef.current = true;
    let cancelled = false;
    const ids = backendIds.split(",");
    void Promise.all(
      ids.map((id) => getUsageSeries(id, "7d").catch(() => null)),
    ).then((series) => {
      if (cancelled) return;
      const points = aggregateKpiTrendPoints(series);
      if (points.tokens.length > 0 || points.costs.length > 0) setTrendPoints(points);
      // 首屏 usage 因冷扫描超时只返回 pending 时，此处已复用/完成同一单飞扫描；
      // 立刻补刷 summary，让 KPI 获得权威 today/7d 口径，无需等 45s 轮询。
      if (usagePending) void refreshRef.current();
    });
    return () => { cancelled = true; };
  }, [backendIds, usagePending]);

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
      getCronLatestDelivery(run.jobId, run.startedAt ?? undefined)
        .then((nextDelivery) => {
          if (runDeliveryRequestRef.current === requestId) setDelivery(nextDelivery);
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
  const [backendRunDetail, setBackendRunDetail] = useState<BackendRunDetail | null>(null);
  const [backendRunOpen, setBackendRunOpen] = useState(false);
  const [backendRunLoading, setBackendRunLoading] = useState(false);
  const [backendRunError, setBackendRunError] = useState(false);
  const backendRunRequestRef = useRef(0);

  const openBackendRun = (item: DashboardRunningItem | DashboardApprovalItem) => {
    if (!item.backendId || !dashboardRunBackends.has(item.backendId) || !item.runId) return;
    const ticket = backendRunRequestRef.current + 1;
    backendRunRequestRef.current = ticket;
    setBackendRunOpen(true);
    setBackendRunDetail(null);
    setBackendRunError(false);
    setBackendRunLoading(true);
    void getBackendRunDetail(item.backendId, item.runId)
      .then((detail) => {
        if (backendRunRequestRef.current === ticket) setBackendRunDetail(detail);
      })
      .catch(() => {
        if (backendRunRequestRef.current === ticket) setBackendRunError(true);
      })
      .finally(() => {
        if (backendRunRequestRef.current === ticket) setBackendRunLoading(false);
      });
  };

  const revealArtifact = async (path: string) => {
    const ok = await revealCli(path);
    if (!ok) toast.info(t("dashboard.revealFailed"));
  };

  const statusRows = data?.status || [];
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
  // C 区：supported 后端出条目；reason:"remote" 显示降级说明行（不整块消失，
  // 免得像坏了）；unsupported（如 Hermes）不出现。
  const artifactSections = data?.artifacts || [];
  // 双后端合并 + 记住来源后端（徽标 + 预览路由都要它），mtime 倒序取前 20。
  const artifactItems = useMemo(
    () =>
      artifactSections
        .flatMap((s) => (s.supported ? s.items.map((x) => ({ ...x, backend: s.backend })) : []))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, 20),
    [artifactSections],
  );
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
      {showLoading && <div className="dash-empty">{t("common.loading")}</div>}

      {data && (
        <>
          {/* KPI 行（Figma 25:507 三卡等宽）：今日 Tokens / 今日成本共用 7 天折线，
              Task Board 使用纯白双列排行。 */}
          <div className="kpi-row">
            <Kpi
              label={t("dashboard.kpiTodayTokens")}
              value={<CountUp value={usageAgg.todayTokens} fmt={fmtTokens} />}
              sub={
                <>
                  {t("dashboard.vsYesterday", { value: fmtTokens(usageAgg.yTokens) })}
                  {tokenDelta && <span className={tokenDelta.up ? "delta-up" : "delta-down"}> {tokenDelta.text}</span>}
                </>
              }
              chart={<KpiSpark points={trendPoints.tokens} gradientId="kpi-token-spark-fill" />}
            />
            <Kpi
              className="kpi-cost"
              label={t("dashboard.kpiTodayCost")}
              value={<CountUp value={usageAgg.todayCost} fmt={fmtCost} />}
              sub={
                <>
                  {t("dashboard.vsYesterday", { value: fmtCost(usageAgg.yCost) })}
                  {costDelta && <span className={costDelta.up ? "delta-up" : "delta-down"}> {costDelta.text}</span>}
                </>
              }
              chart={<KpiSpark points={trendPoints.costs} gradientId="kpi-cost-spark-fill" />}
            />
            <TaskBoardCard
              label={t("dashboard.taskBoard")}
              ok={runStats.okCount}
              fail={runStats.failCount}
              okLabel={t("dashboard.kpiRunsOk")}
              failLabel={t("dashboard.kpiRunsFail")}
              ranking={agentRanking}
            />
          </div>

          {/* 主体两栏（照设计）：左「今日动态」活动面板 : 右「最近产出」≈ 2:1。 */}
          <div className="dash-columns">
            {/* 今日动态：统一活动流（cron/kanban/inspiration），独立组件承载筛选与分页。 */}
            <ActivityFeed
              status={statusRows}
              firstPage={data.activityPage}
              sinceMs={data.sinceMs}
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

            {/* 最近产出（右栏）：本机 workspace/media 的最近产出，点击 Finder 定位。 */}
            <section className="dash-section dash-artifacts">
              <h2 className="dash-section-title">
                {t("dashboard.artifactsTitle")}
                <span className="dash-section-count">{artifactItems.length}</span>
              </h2>
              {artifactRemotes.map((s) => (
                <div key={s.backend} className="dash-remote-note">
                  {t("dashboard.artifactsRemote", { backend: s.backend })}
                </div>
              ))}
              {artifactItems.length === 0 ? (
                <div className="dash-empty">{t("dashboard.artifactsEmpty")}</div>
              ) : (
                <div className="dash-art-list">
                  {artifactItems.map((a) => (
                    <button
                      key={a.path}
                      className="dash-art"
                      title={`${a.path}\n${t("dashboard.revealHint")}`}
                      onClick={() => void revealArtifact(a.path)}
                    >
                      <ArtifactThumb name={a.name} />
                      <span className="dash-art-body">
                        <span className="dash-art-name">{a.name}</span>
                        <span className="dash-art-sub">
                          {a.agentId ? `@${currentAgentName(a.agentId, a.backend)}` : a.area}
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

      <Modal
        open={runModalOpen}
        onClose={closeRunModal}
        onOpenChangeComplete={handleRunModalOpenChangeComplete}
        title={openRun?.jobName || openRun?.jobId || ""}
        subtitle={t("dashboard.runModalTitle")}
        footer={
          openRun && (
            <>
              {runSessionKey && visibleRunText && visibleRunText.trim() && (
                <button className="foot-left btn-secondary" onClick={() => askInChat(openRun.backendId, runSessionKey, visibleRunText)}>
                  {t("cron.askInChat")}
                </button>
              )}
              <button
                className="btn-primary"
                onClick={() => navigate(`/cron?job=${encodeURIComponent(openRun.jobId)}`)}
              >
                {t("dashboard.openInCron")}
              </button>
            </>
          )
        }
      >
        {openRun && (
          <>
            <ModalSection>
              <DetailRow label={t("cronForm.runExecutionResult")}>
                <span className={openRunExecution?.tone === "success"
                  ? "status-ok"
                  : openRunExecution?.tone === "error"
                    ? "status-error"
                    : "muted"}>
                  {openRunExecution?.value}
                </span>
              </DetailRow>
              {openRunExecution?.detail && (
                <DetailRow label={t("dashboard.errorLabel")}>
                  <span className="status-error">{openRunExecution.detail}</span>
                </DetailRow>
              )}
              <DetailRow label={t("dashboard.timeLabel")}>
                {openRun.startedAt ? new Date(openRun.startedAt).toLocaleString() : "—"}
              </DetailRow>
              {typeof openRun.durationMs === "number" && (
                <DetailRow label={t("dashboard.durationLabel")}>{fmtMs(openRun.durationMs)}</DetailRow>
              )}
              {openRun.agentId && (
                <DetailRow label={t("dashboard.agentLabel")}>
                  {currentAgentName(openRun.agentId, openRun.backendId)}
                </DetailRow>
              )}
              {openRun.model && <DetailRow label={t("dashboard.modelLabel")}>{openRun.model}</DetailRow>}
              {openRunDelivery && (
                <DetailRow label={t("cronForm.runDeliveryResult")}>
                  <span>
                    {openRunDelivery.value}
                    {openRunDelivery.detail ? ` · ${openRunDelivery.detail}` : ""}
                  </span>
                </DetailRow>
              )}
            </ModalSection>
            {/* 全文优先（本机 transcript），退回摘要；合成行（Hermes 末次状态）两者皆无。 */}
            {visibleRunText && (
              <ModalSection title={runHandoff.isFullText ? t("dashboard.fullTextTitle") : t("dashboard.summaryTitle")}>
                <div
                  className="chat-md cron-delivery-md"
                  dangerouslySetInnerHTML={{
                    __html: toSanitizedMarkdownHtml(visibleRunText),
                  }}
                />
              </ModalSection>
            )}
            {deliveryLoading && !visibleRunText && <ModalSection>{t("dashboard.fullTextLoading")}</ModalSection>}
            {!deliveryLoading && !visibleRunText && (
              <ModalSection>{t("dashboard.fullTextNone")}</ModalSection>
            )}
          </>
        )}
      </Modal>

      <Modal
        open={backendRunOpen}
        onClose={() => {
          backendRunRequestRef.current += 1;
          setBackendRunOpen(false);
        }}
        title={backendRunDetail?.id || t("dashboard.runModalTitle")}
        subtitle={t("dashboard.nativeRunSubtitle")}
      >
        {backendRunLoading && <ModalSection>{t("common.loading")}</ModalSection>}
        {backendRunError && <ModalSection><span className="status-error">{t("dashboard.shoggothRunFailed")}</span></ModalSection>}
        {backendRunDetail && (
          <>
            <ModalSection>
              <DetailRow label={t("dashboard.statusLabel")}>{backendRunDetail.status}</DetailRow>
              {backendRunDetail.agentId && (
                <DetailRow label={t("dashboard.agentLabel")}>
                  {currentAgentName(backendRunDetail.agentId, backendRunDetail.backendId)}
                </DetailRow>
              )}
              {typeof backendRunDetail.startedAt === "number" && (
                <DetailRow label={t("dashboard.timeLabel")}>{new Date(backendRunDetail.startedAt).toLocaleString()}</DetailRow>
              )}
              {backendRunDetail.error && (
                <DetailRow label={t("dashboard.errorLabel")}><span className="status-error">{backendRunDetail.error}</span></DetailRow>
              )}
            </ModalSection>
            {backendRunDetail.summary && (
              <ModalSection title={t("dashboard.summaryTitle")}><div className="chat-md"><pre>{backendRunDetail.summary}</pre></div></ModalSection>
            )}
            <ModalSection title={t("dashboard.runEventsTitle")}>
              {backendRunDetail.events.length === 0 ? (
                <span className="muted">{t("dashboard.runEventsEmpty")}</span>
              ) : backendRunDetail.events.map((event) => (
                <div key={`${event.seq}:${event.type}`} className="status-row">
                  <span className="status-label mono">#{event.seq} · {event.type}</span>
                  <span className={event.error ? "status-error" : "mono"}>
                    {event.text || event.message || event.summary || event.error || event.tool?.name || event.status || "—"}
                  </span>
                </div>
              ))}
            </ModalSection>
            {backendRunDetail.artifacts.length > 0 && (
              <ModalSection title={t("dashboard.runArtifactsTitle")}>
                {backendRunDetail.artifacts.map((artifact) => <div key={artifact.id}>{artifact.name}</div>)}
              </ModalSection>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}
