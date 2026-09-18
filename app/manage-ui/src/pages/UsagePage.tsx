import AgentAvatarView from "../components/AgentAvatar";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageHead } from "../components/PageHead";
import { animate } from "animejs";
import "./usage/UsagePage.css";
import type { SessionPreview, SessionPreviewMessage, UsageBreakdown, UsageDailyPoint, UsageSeries, UsageTopSession } from "../types";
import { getSessionPreview, getUsageBreakdown, getUsageSeries, listAgents } from "../api/client";
import BackendTabs from "../components/BackendTabs";
import Modal from "../components/Modal";
import { toSanitizedMarkdownHtml } from "../lib/markdown";
import PillTabs from "../components/PillTabs";
import { useBackendState } from "../lib/backends";
import { useStickyState } from "../lib/useStickyState";
import { useRegisterPageRefresh, useRegisterPageLoading } from "../lib/page-refresh";
import { createAgentNameIndex, resolveAgentDisplayName, type AgentNameIndex } from "../lib/agentDisplay";
import {
  fmtCost,
  fmtTokens,
  MultiLine,
  RankBars,
  SERIES_COLORS,
  StackedBars,
  useGrow,
  type ChartSeries,
  type StackBucket,
} from "./usage/charts";

type Gran = "day" | "week" | "month";
type RangeKey = "today" | "7d" | "30d" | "90d" | "1y" | "all";

// 长区间自动聚合（设计稿 6994-135 的 hero 卡无粒度切换控件）：1 年按周、全部按月。
const granOf = (r: RangeKey): Gran => (r === "1y" ? "week" : r === "all" ? "month" : "day");

interface Bucket {
  key: string;
  label: string;
  tokens: number;
  input: number;
  output: number;
  cache: number;
  reasoning: number;
}

function bucketSeries(daily: UsageDailyPoint[], gran: Gran): Bucket[] {
  const mk = (key: string, label: string): Bucket => ({
    key,
    label,
    tokens: 0,
    input: 0,
    output: 0,
    cache: 0,
    reasoning: 0,
  });
  const add = (b: Bucket, d: UsageDailyPoint) => {
    b.tokens += d.totalTokens;
    b.input += d.inputTokens ?? 0;
    b.output += d.outputTokens ?? 0;
    // 缓存读+写合并为一个「缓存」口径（设计稿拍板），图表与 KPI 一致。
    b.cache += (d.cacheReadTokens ?? 0) + (d.cacheWriteTokens ?? 0);
    b.reasoning += d.reasoningTokens ?? 0;
  };
  if (gran === "day") {
    return daily.map((d) => {
      const b = mk(d.date, d.date.slice(5));
      add(b, d);
      return b;
    });
  }
  const map = new Map<string, Bucket>();
  for (const d of daily) {
    let key: string;
    let label: string;
    if (gran === "month") {
      key = d.date.slice(0, 7);
      label = key;
    } else {
      const dt = new Date(`${d.date}T00:00:00`);
      dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7)); // back up to Monday
      key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
      label = key.slice(5);
    }
    const cur = map.get(key) || mk(key, label);
    add(cur, d);
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

const RANGE_KEY: Record<RangeKey, string> = {
  today: "usage.rangeToday",
  "7d": "usage.rank7d",
  "30d": "usage.rank30d",
  "90d": "usage.range90d",
  "1y": "usage.range1y",
  all: "usage.rankAll",
};

// 模型占比环图的六段配色（设计稿：品牌黄领衔 + 黑 + 灰阶递减；值在 UsagePage.css）
const DONUT_COLORS = [
  "var(--uc-d0)",
  "var(--uc-d1)",
  "var(--uc-d2)",
  "var(--uc-d3)",
  "var(--uc-d4)",
  "var(--uc-d5)",
];

// 模型占比环图（Figma 6994-135 左槽）：top5 + 其他，中心是第一名占比。
// 纯 SVG stroke-dasharray 弧段，从 12 点顺时针；段上带原生 title 提示。
function ModelDonut({ slices, centerPct }: { slices: { label: string; frac: number }[]; centerPct: number }) {
  const R = 40;
  const C = 2 * Math.PI * R;
  const svgRef = useRef<SVGSVGElement>(null);
  const growCls = useGrow(svgRef, slices.map((s) => `${s.label}:${s.frac.toFixed(4)}`).join(","));
  let acc = 0;
  return (
    <svg ref={svgRef} className="usage-donut-svg" viewBox="0 0 100 100" role="img">
      {slices.map((s, i) => {
        const deg = acc * 360;
        const before = acc; // 本段之前的累积占比 = 它该等多久才轮到自己
        acc += s.frac;
        if (s.frac <= 0) return null;
        return (
          <circle
            key={`${s.label}-${i}`}
            className={growCls("arc")}
            cx="50"
            cy="50"
            r={R}
            fill="none"
            stroke={DONUT_COLORS[i % DONUT_COLORS.length]}
            strokeWidth="17"
            strokeDasharray={`${(s.frac * C).toFixed(2)} ${C.toFixed(2)}`}
            transform={`rotate(${(deg - 90).toFixed(2)} 50 50)`}
            // 每段延迟/时长都按占比分摊总时长 → 各段接力扫成连续一圈（故用 linear，
            // 逐段 easeOut 会一顿一顿）。
            style={
              {
                "--len": (s.frac * C).toFixed(2),
                "--c": C.toFixed(2),
                "--d": before.toFixed(4),
                "--f": s.frac.toFixed(4),
              } as CSSProperties
            }
          >
            <title>{`${s.label} · ${(s.frac * 100).toFixed(1)}%`}</title>
          </circle>
        );
      })}
      <text x="50" y="57" textAnchor="middle" className="usage-donut-num">
        {Math.round(centerPct)}%
      </text>
    </svg>
  );
}

const seriesCache: Record<string, UsageSeries> = {};
const breakdownCache: Record<string, UsageBreakdown> = {};

const fmtPct = (n: number): string => `${n.toFixed(1)}%`;

// anime.js 数字滚动：挂载从 0 滚入，值变化（切范围/后端命中缓存）从当前显示值滚到新值。
// fmt 必须传模块级稳定引用，否则 effect 每次渲染都重跑动画。
function CountUp({ value, fmt }: { value: number; fmt: (n: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 减少动态效果时直接显示最终值，数据口径保持不变。
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

// hero 卡左列的小统计格（设计稿：10px 半透明标签 + 16px 值）
function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="usage-stat">
      <div className="usage-stat-label">{label}</div>
      <div className="usage-stat-val">{value}</div>
    </div>
  );
}

// 会话主文案：语义标题（后端提供）> 显式 label > key 尾段（旧行为兜底）。
const sessionKeyTail = (s: UsageTopSession): string => s.key.replace(/^agent:[^:]*:/, "");
const sessionLabel = (s: UsageTopSession): string => s.title || s.label || sessionKeyTail(s);
const fmtWhen = (ts?: number): string =>
  ts ? new Date(ts).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

export default function UsagePage() {
  const { t } = useTranslation();
  const [backend, setBackend] = useBackendState("usage", undefined, { surface: "usage" });
  const [range, setRange] = useStickyState<RangeKey>("usage.range", "30d");
  const [series, setSeries] = useState<UsageSeries | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(true);
  const [breakdown, setBreakdown] = useState<UsageBreakdown | null>(null);
  const [bdLoading, setBdLoading] = useState(true);
  const [agentNames, setAgentNames] = useState<AgentNameIndex>({});
  const [err, setErr] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  // Top 会话行点击的 transcript 预览抽屉（offset 分页，滑动逐步加载）
  const [previewFor, setPreviewFor] = useState<UsageTopSession | null>(null);
  const [preview, setPreview] = useState<SessionPreview | null>(null);
  const [previewMsgs, setPreviewMsgs] = useState<SessionPreviewMessage[]>([]);
  const [previewHasMore, setPreviewHasMore] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewLoadingMore, setPreviewLoadingMore] = useState(false);
  const previewSentinel = useRef<HTMLDivElement>(null);
  // 换会话/关抽屉时 +1 作废在飞请求。不能用 effect 的 alive-flag：loadingMore
  // 翻转会重跑 effect、旧 cleanup 把 alive 置 false，飞行中的追加会被丢弃且
  // loading 态永远收不回（实测卡死在「加载更多…」）。
  const previewToken = useRef(0);

  // 切后端/区间时关掉抽屉（行数据已换代，key 不再指向同一会话）
  useEffect(() => {
    setPreviewFor(null);
  }, [backend, range]);

  useEffect(() => {
    if (!previewFor) return;
    const token = ++previewToken.current;
    setPreview(null);
    setPreviewMsgs([]);
    setPreviewHasMore(false);
    setPreviewLoadingMore(false);
    setPreviewLoading(true);
    getSessionPreview(backend, previewFor.agentId || "", previewFor.key, { sessionId: previewFor.sessionId })
      .then((p) => {
        if (previewToken.current !== token) return; // 已换会话/关抽屉
        setPreview(p);
        setPreviewMsgs(p.messages || []);
        setPreviewHasMore(!!p.truncated);
      })
      .catch(() => {
        if (previewToken.current === token) setPreview({ supported: false, reason: "error", messages: [] });
      })
      .finally(() => {
        if (previewToken.current === token) setPreviewLoading(false);
      });
    return () => {
      previewToken.current += 1; // 关抽屉也作废在飞请求
    };
    // backend 变化由上面的 effect 先清 previewFor，这里只跟行走
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewFor]);

  // markdown.ts 产出的代码块复制按钮（.code-block-copy）委托处理器——与
  // ChatPage 同款；仅弹窗打开期间挂载，避免与聊天页的全局监听重复触发。
  useEffect(() => {
    if (!previewFor) return;
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement)?.closest?.(".usage-preview .code-block-copy") as HTMLElement | null;
      if (!btn) return;
      const ta = document.createElement("textarea"); // un-escape the HTML-escaped data-code
      ta.innerHTML = btn.getAttribute("data-code") || "";
      navigator.clipboard?.writeText(ta.value).catch(() => {});
      btn.classList.add("copied");
      setTimeout(() => btn.classList.remove("copied"), 1500);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [previewFor]);

  // 滑到底自动续拉：底部哨兵进视口即以已载条数为 offset 追加下一页。
  useEffect(() => {
    if (!previewFor || !previewHasMore || previewLoading || previewLoadingMore) return;
    const el = previewSentinel.current;
    if (!el) return;
    const token = previewToken.current; // 与当前会话绑定；换会话即失配丢弃
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      setPreviewLoadingMore(true);
      getSessionPreview(backend, previewFor.agentId || "", previewFor.key, {
        sessionId: previewFor.sessionId,
        offset: previewMsgs.length,
      })
        .then((p) => {
          if (previewToken.current !== token) return; // 抽屉已关/换行：丢弃过期页
          setPreviewMsgs((prev) => [...prev, ...(p.messages || [])]);
          setPreviewHasMore(!!p.truncated);
        })
        .catch(() => {
          if (previewToken.current === token) setPreviewHasMore(false);
        })
        .finally(() => {
          if (previewToken.current === token) setPreviewLoadingMore(false);
        });
    });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewFor, previewHasMore, previewLoading, previewLoadingMore, previewMsgs.length]);

  // 拉当前 backend/range 的两份数据。首载 effect 与导航栏刷新共用同一份加载体，
  // 差别只在存活判定：effect 传自己的 alive 标志（切后端/区间后要丢弃回写），
  // 手动刷新只需组件还挂着。两份都落地才 resolve —— 导航栏靠这个 promise 决定
  // 什么时候弹「已刷新」（本页没走 usePageCache，拿不到现成的 refresh）。
  const loadUsage = useCallback(async (isAlive: () => boolean) => {
    const key = `${backend}:${range}`;
    await Promise.all([
      getUsageSeries(backend, range)
        .then((s) => {
          if (!isAlive()) return;
          if (s) {
            seriesCache[key] = s;
            setSeries(s);
          }
        })
        .catch((e) => isAlive() && setErr(e instanceof Error ? e.message : String(e)))
        .finally(() => {
          if (isAlive()) setSeriesLoading(false);
        }),
      getUsageBreakdown(backend, range)
        .then((b) => {
          if (!isAlive()) return;
          if (b) {
            breakdownCache[key] = b;
            setBreakdown(b);
          }
        })
        .catch((e) => isAlive() && setErr((prev) => prev || (e instanceof Error ? e.message : String(e))))
        .finally(() => {
          if (isAlive()) setBdLoading(false);
        }),
      listAgents(backend)
        .then((agents) => {
          if (isAlive()) setAgentNames(createAgentNameIndex(
            agents.map((agent) => ({ ...agent, backendId: backend })),
          ));
        })
        // 名称是辅助展示数据：失败时保留已有名称/按 agentId 回退，不拖垮用量页。
        .catch(() => {}),
    ]);
  }, [backend, range]);

  // 导航栏刷新：先清掉本 key 的内存缓存，否则切走再回来会拿到刚被替换掉的旧值。
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useRegisterPageRefresh("/token", async () => {
    const key = `${backend}:${range}`;
    delete seriesCache[key];
    delete breakdownCache[key];
    setErr(null);
    await loadUsage(() => mountedRef.current);
  });
  useRegisterPageLoading("/token", seriesLoading || bdLoading);

  useEffect(() => {
    let alive = true;
    setErr(null);
    const key = `${backend}:${range}`;

    if (seriesCache[key]) {
      setSeries(seriesCache[key]);
      setSeriesLoading(false);
    } else {
      setSeries(null);
      setSeriesLoading(true);
    }
    if (breakdownCache[key]) {
      setBreakdown(breakdownCache[key]);
      setBdLoading(false);
    } else {
      setBreakdown(null);
      setBdLoading(true);
    }

    void loadUsage(() => alive);

    return () => {
      alive = false;
    };
  }, [backend, range, reloadTick, loadUsage]);

  // 网关冷扫描(refreshing)返回全零快照：提示 + 15s 后自动重拉
  //（openclaw-backend 已对 refreshing 结果跳过缓存，重拉能拿到新数据）。
  const refreshing = series?.cacheStatus === "refreshing" || breakdown?.cacheStatus === "refreshing";
  useEffect(() => {
    if (!refreshing) return;
    const key = `${backend}:${range}`;
    const timer = window.setTimeout(() => {
      delete seriesCache[key];
      delete breakdownCache[key];
      setReloadTick((v) => v + 1);
    }, 15_000);
    return () => window.clearTimeout(timer);
  }, [refreshing, backend, range]);

  const buckets = useMemo(() => bucketSeries(series?.daily ?? [], granOf(range)), [series, range]);

  // —— 用量趋势：in/out/cache(/reasoning) 堆叠，配色黑/品牌黄/灰（Figma 6994-135）——
  const trend = useMemo(() => {
    const hasParts = buckets.some((b) => b.input > 0 || b.output > 0 || b.cache > 0);
    const hasReason = buckets.some((b) => b.reasoning > 0);
    const cols: ChartSeries[] = hasParts
      ? [
          { label: t("usage.input"), color: "var(--uc-in)" },
          { label: t("usage.output"), color: "var(--uc-out)" },
          { label: t("usage.cache"), color: "var(--uc-cache)" },
          ...(hasReason ? [{ label: t("usage.reasoning"), color: "var(--uc-reason)" }] : []),
        ]
      : [{ label: t("usage.totalTokens"), color: "var(--uc-in)" }];
    const rows: StackBucket[] = buckets.map((b) => ({
      key: b.key,
      label: b.label,
      parts: hasParts ? [b.input, b.output, b.cache, ...(hasReason ? [b.reasoning] : [])] : [b.tokens],
    }));
    return { cols, rows };
  }, [buckets, t]);

  // —— 按模型堆叠（modelDaily → top6 + 其他）——
  const modelStack = useMemo(() => {
    const md = breakdown?.modelDaily ?? [];
    if (md.length === 0) return null;
    const totals = new Map<string, number>();
    for (const p of md) totals.set(p.model, (totals.get(p.model) ?? 0) + p.tokens);
    const top = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([m]) => m);
    const labels = [...top, t("usage.otherModels")];
    const byDate = new Map<string, number[]>();
    for (const p of md) {
      const arr = byDate.get(p.date) ?? labels.map(() => 0);
      const idx = top.indexOf(p.model);
      arr[idx >= 0 ? idx : labels.length - 1] += p.tokens;
      byDate.set(p.date, arr);
    }
    const rows: StackBucket[] = [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, parts]) => ({
        key: date,
        label: date.slice(5),
        parts,
      }));
    if (!rows.some((r) => r.parts.some((v) => v > 0))) return null;
    const cols: ChartSeries[] = labels.map((label, i) => ({ label, color: SERIES_COLORS[i % SERIES_COLORS.length] }));
    return { cols, rows };
  }, [breakdown, t]);

  // —— hero 统计（缓存=读+写合并，设计稿口径）——
  const tot = series?.totals;
  const usageUnavailable = series?.availability === "unavailable";
  const usagePartial = series?.availability === "partial" || breakdown?.availability === "partial";
  const cacheTotal = (tot?.cacheReadTokens ?? 0) + (tot?.cacheWriteTokens ?? 0);
  const cacheDen = (tot?.inputTokens ?? 0) + (tot?.cacheReadTokens ?? 0);
  const cacheHit = cacheDen > 0 ? (tot?.cacheReadTokens ?? 0) / cacheDen : null;

  // —— 排行 / 活动 / 会话 ——
  const modelRows = (breakdown?.byModel ?? []).slice(0, 10).map((m) => {
    // hover 浮层：输入/输出/缓存/命中率，口径与 hero 一致
    // （缓存 = read + write；命中率 = read / (input + read)）。
    const cacheRead = m.cacheReadTokens ?? 0;
    const hitDen = (m.inputTokens ?? 0) + cacheRead;
    return {
      label: m.model,
      value: m.totalTokens,
      tipRows: [
        { label: t("usage.input"), value: fmtTokens(m.inputTokens ?? 0) },
        { label: t("usage.output"), value: fmtTokens(m.outputTokens ?? 0) },
        { label: t("usage.cache"), value: fmtTokens(cacheRead + (m.cacheWriteTokens ?? 0)) },
        { label: t("usage.cacheHitRate"), value: hitDen > 0 ? `${((cacheRead / hitDen) * 100).toFixed(1)}%` : "–" },
      ],
    };
  });
  const toolRows = (breakdown?.tools?.tools ?? []).slice(0, 10).map((x) => ({ label: x.name, value: x.count }));
  // 排行可以只展示 top N，但百分比必须以未截断原始集合为分母。
  const modelTotal = (breakdown?.byModel ?? []).reduce((sum, item) => sum + item.totalTokens, 0);
  const toolTotal = breakdown?.tools?.totalCalls ?? (breakdown?.tools?.tools ?? []).reduce((sum, item) => sum + item.count, 0);
  const sources = (breakdown?.bySource ?? []).map((source) => ({
    ...source,
    displayName: resolveAgentDisplayName(agentNames, source.id, source.backendId || backend, source.label),
  }));
  const sourceTotal = sources.reduce((sum, item) => sum + item.totalTokens, 0) || 1;
  const sourceMax = Math.max(1, ...sources.map((s) => s.totalTokens));
  // Agent 用量条自己实现（.arank-*，没走 RankBars），生长得单独挂一份（R238）。
  const arankRef = useRef<HTMLDivElement>(null);
  const arankGrow = useGrow(arankRef, sources.map((s) => `${s.backendId}:${s.id}`).join(","));
  // 环图切片：完整 byModel 的 top5 + 其他（分母=全量，与排行占比同口径）
  const donut = useMemo(() => {
    const all = breakdown?.byModel ?? [];
    const total = all.reduce((s, m) => s + m.totalTokens, 0);
    if (total <= 0) return null;
    const top = all.slice(0, 5).map((m) => ({ label: m.model, frac: m.totalTokens / total }));
    const rest = 1 - top.reduce((s, x) => s + x.frac, 0);
    const slices = rest > 0.0005 ? [...top, { label: t("usage.otherModels"), frac: rest }] : top;
    return { slices, centerPct: (top[0]?.frac ?? 0) * 100 };
  }, [breakdown, t]);
  // 任一行带 errors 字段才画错误线：无错误信号的后端（Hermes）契约上省略该
  // 字段，整条线（图例/tooltip 同步）删除，不画恒 0 贴地线（R211 用户拍板）。
  const hasErrorLine = (breakdown?.dailyActivity ?? []).some((d) => d.errors != null);
  const activityLine = (breakdown?.dailyActivity ?? [])
    .filter((d) => d.messages > 0 || d.toolCalls > 0 || (d.errors ?? 0) > 0)
    .map((d) => ({
      label: d.date.slice(5),
      full: d.date,
      values: (hasErrorLine
        ? [d.messages, d.toolCalls, d.errors ?? 0]
        : [d.messages, d.toolCalls]) as (number | null)[],
    }));
  const sessions = breakdown?.topSessions ?? [];

  return (
    <div className="page management-page usage-page">
      <PageHead title={t("usage.pageTitle")} subtitle={t("usage.pageSubtitle")} />
      <div className="toolbar">
        <BackendTabs value={backend} onChange={setBackend} surface="usage" />
        {/* 区间切换与后端切换同一个 PillTabs 组件（R206,用户拍板都用组件） */}
        <PillTabs
          value={range}
          onChange={(v) => setRange(v as RangeKey)}
          items={(["today", "7d", "30d", "90d", "1y", "all"] as RangeKey[]).map((r) => ({
            value: r,
            label: t(RANGE_KEY[r]),
          }))}
          ariaLabel={t("usage.rangeAria")}
        />
      </div>

      {backend === "hermes" && range === "today" && <div className="usage-hint">{t("usage.hermesTodayHint")}</div>}
      {err && <div className="error">{t("usage.error", { msg: err })}</div>}
      {usageUnavailable && <div className="error" role="alert">{t(series?.availabilityReason === "unsupported-range" ? "usage.rangeUnavailable" : "usage.dataUnavailable")}</div>}
      {!usageUnavailable && usagePartial && <div className="usage-hint" role="status">{t("usage.dataPartial")}</div>}
      {refreshing && <div className="usage-hint">{t("usage.refreshing")}</div>}

      {!usageUnavailable && <>
      <div className="usage-row usage-row--hero">
        <section className="usage-section usage-hero">
          <div className="usage-hero-stats">
            <div className="usage-stat-label">{t("usage.totalTokens")}</div>
            <div className="usage-stat-big">
              {seriesLoading ? "…" : <CountUp value={tot?.totalTokens ?? 0} fmt={fmtTokens} />}
            </div>
            <div className="usage-cost-summary">
              <div className="usage-stat-label">{t("usage.totalCost")}</div>
              <div className="usage-cost-value">
                {seriesLoading ? "…" : <CountUp value={tot?.totalCost ?? 0} fmt={fmtCost} />}
              </div>
            </div>
            {!seriesLoading && (
              <div className="usage-stat-grid">
                <Stat label={t("usage.input")} value={<CountUp value={tot?.inputTokens ?? 0} fmt={fmtTokens} />} />
                <Stat label={t("usage.output")} value={<CountUp value={tot?.outputTokens ?? 0} fmt={fmtTokens} />} />
                {cacheTotal > 0 && <Stat label={t("usage.cache")} value={<CountUp value={cacheTotal} fmt={fmtTokens} />} />}
                {cacheHit != null && cacheTotal > 0 && (
                  <Stat label={t("usage.cacheHitRate")} value={<CountUp value={cacheHit * 100} fmt={fmtPct} />} />
                )}
              </div>
            )}
          </div>
          <div className="usage-hero-chart">
            {seriesLoading ? (
              <p className="muted">{t("usage.loadingChart")}</p>
            ) : (
              <StackedBars buckets={trend.rows} series={trend.cols} w={600} h={280} minSeg={4} contentShiftY={14} />
            )}
          </div>
        </section>

        <section className="usage-section usage-agents">
          <div className="usage-section-head">
            <h3>{t("usage.agentRankTitle")}</h3>
          </div>
          {bdLoading ? (
            <p className="muted">{t("usage.counting")}</p>
          ) : sources.length === 0 ? (
            <p className="muted">{t("usage.noData")}</p>
          ) : (
            <div className="arank" ref={arankRef}>
              {sources.map((s, i) => (
                <div className="arank-row" key={`${s.backendId}:${s.id}`}>
                  <div className="arank-head">
                    <AgentAvatarView agentId={s.id} name={s.displayName} className="arank-ava" loading="lazy" />
                    <span className="arank-name" title={s.displayName}>
                      {s.displayName}
                    </span>
                    <span className="arank-val">
                      {fmtTokens(s.totalTokens)} · {((s.totalTokens / sourceTotal) * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="arank-bar">
                    <span
                      className={`arank-fill ${arankGrow("rank")}`}
                      style={{ width: `${(s.totalTokens / sourceMax) * 100}%`, "--i": i } as CSSProperties}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {modelStack && (
        <section className="usage-section">
          <div className="usage-section-head">
            <h3>{t("usage.modelDailyTitle")}</h3>
          </div>
          <MultiLine
            points={modelStack.rows.map((r) => ({ label: r.label, full: r.key, values: r.parts as (number | null)[] }))}
            series={modelStack.cols}
            yFmt={fmtTokens}
            w={1188}
            h={246}
            legend
          />
        </section>
      )}

      <div className="usage-row usage-row--split">
        <section className="usage-section">
          <div className="usage-section-head">
            <h3>{t("usage.modelRankTitle")}</h3>
          </div>
          {bdLoading ? (
            <p className="muted">{t("usage.scanning")}</p>
          ) : (
            // 设计稿：左环图（top5+其他占比）+ 右排行列表
            <div className="usage-rank-split">
              {donut && (
                <div className="usage-donut">
                  <ModelDonut slices={donut.slices} centerPct={donut.centerPct} />
                </div>
              )}
              <div className="usage-rank-list">
                <RankBars rows={modelRows} totalValue={modelTotal} />
              </div>
            </div>
          )}
        </section>
        <section className="usage-section">
          <div className="usage-section-head">
            <h3>{t("usage.toolsTitle")}</h3>
          </div>
          {bdLoading ? (
            <p className="muted">{t("usage.counting")}</p>
          ) : (
            <RankBars rows={toolRows} totalValue={toolTotal} fmt={(n) => t("usage.toolCallsFmt", { count: Math.round(n) })} />
          )}
        </section>
      </div>

      {(bdLoading || breakdown?.dailyActivity !== undefined) && (
        <section className="usage-section">
          <div className="usage-section-head">
            <h3>{t("usage.activityTitle")}</h3>
          </div>
          {bdLoading ? (
            <p className="muted">{t("usage.scanning")}</p>
          ) : (
            <MultiLine
              points={activityLine}
              series={[
                { label: t("usage.activityMsgs"), color: "var(--uc-act-msg)" },
                { label: t("usage.activityToolCalls"), color: "var(--uc-act-tool)" },
                ...(hasErrorLine ? [{ label: t("usage.activityErrors"), color: "var(--uc-act-err)" }] : []),
              ]}
              yFmt={(n) => String(Math.round(n))}
              w={1188}
              h={246}
            />
          )}
        </section>
      )}

      {sessions.length > 0 && (
        <section className="usage-section">
          <div className="usage-section-head">
            <h3>{t("usage.sessionsTitle")}</h3>
          </div>
          {/* 表格自带横滚容器：卡片本体不再是滚动容器（防卡内上下滑动） */}
          <div className="usage-table-scroll">
          <table className="usage-table">
            <thead>
              <tr>
                <th>{t("usage.thSession")}</th>
                <th>{t("usage.thModel")}</th>
                <th className="num">{t("usage.thTokens")}</th>
                <th>{t("usage.thTime")}</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr
                  key={`${s.key}:${s.sessionId ?? ""}`}
                  className="usage-row-click"
                  onClick={() => setPreviewFor(s)}
                >
                  <td className="usage-table-key" title={s.key}>
                    <button
                      type="button"
                      className="usage-session-open"
                      aria-label={`${sessionLabel(s)} · ${fmtWhen(s.updatedAt)}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setPreviewFor(s);
                      }}
                    >
                      <span className="usage-session-title">{sessionLabel(s)}</span>
                      {sessionLabel(s) !== sessionKeyTail(s) && (
                        <span className="usage-session-sub">{sessionKeyTail(s)}</span>
                      )}
                    </button>
                  </td>
                  <td>
                    {s.models?.length ? (
                      <div className="usage-session-models">
                        {s.models.map((m) => (
                          <div key={m.model} className="usage-session-model">
                            <span>{m.model}</span>
                            <span className="usage-session-model-tk">{fmtTokens(m.tokens)}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      s.model ?? "—"
                    )}
                  </td>
                  <td className="num mono">{fmtTokens(s.totalTokens)}</td>
                  <td>{fmtWhen(s.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </section>
      )}

      </>}
      <Modal
        open={!!previewFor}
        onClose={() => setPreviewFor(null)}
        title={previewFor ? sessionLabel(previewFor) : ""}
        subtitle={
          previewFor
            ? preview?.totalMessages != null
              ? `${previewFor.key} · ${t("usage.previewTotal", { total: preview.totalMessages })}`
              : previewFor.key
            : undefined
        }
        width={760}
      >
        {previewLoading ? (
          <p className="muted">{t("usage.previewLoading")}</p>
        ) : !preview || !preview.supported ? (
          <p className="muted">{t("usage.previewUnsupported")}</p>
        ) : previewMsgs.length === 0 ? (
          <p className="muted">{t("usage.previewEmpty")}</p>
        ) : (
          <div className="usage-preview">
            {previewMsgs.map((m, i) => (
              <div key={i} className={m.role === "user" ? "usage-chatmsg usage-chatmsg--user" : "usage-chatmsg"}>
                <div className="usage-chatmsg-bubble">
                  {/* chat-md = 聊天页 markdown 显示规则（全局类）；本地类只供变量包+排版 */}
                  <div
                    className="chat-md usage-chatmsg-md"
                    dangerouslySetInnerHTML={{ __html: toSanitizedMarkdownHtml(m.text) }}
                  />
                  {m.timestamp ? <div className="usage-chatmsg-ts">{fmtWhen(m.timestamp)}</div> : null}
                </div>
              </div>
            ))}
            {previewHasMore && (
              <div ref={previewSentinel} className="usage-preview-note">
                {previewLoadingMore
                  ? t("usage.previewLoadingMore")
                  : t("usage.previewProgress", { shown: previewMsgs.length, total: preview.totalMessages ?? previewMsgs.length })}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
