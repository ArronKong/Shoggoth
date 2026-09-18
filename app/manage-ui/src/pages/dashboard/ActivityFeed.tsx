import AgentAvatarView from "../../components/AgentAvatar";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getDashboardActivities } from "../../api/client";
import type {
  BackendStatus,
  DashboardActivityEntry,
  DashboardActivityPage,
  DashboardApprovalItem,
  DashboardRunningItem,
} from "../../types";
import BackendBadge from "../../components/BackendBadge";
import BackendTabIcon, { sortBackendTabs } from "../../components/BackendTabIcon";
import FilterTabs from "../../components/FilterTabs";
import FusionLoader from "../../components/FusionLoader";
import { useStickyState } from "../../lib/useStickyState";
import ApprovalRow from "./ApprovalRow";
import { activityStatusRows } from "./activityStatusRows";

// 统一活动流（今日动态）：cron / kanban / inspiration，隐藏系统健康及 heartbeat 记录。
// - 首屏来自 summary.activityPage（默认筛选第一页）；筛选/加载更多走
//   /__api/dashboard/activities（服务端筛选 + opaque cursor）。
// - 45s 轮询到的新首屏按 id 合并进已加载列表，不清空「加载更多」的旧记录；
//   summary.sinceMs 变化（跨本地午夜）时整体重置。
// - 点击：cron → 运行弹窗（父组件既有逻辑）；kanban → Tasks 深链；
//   inspiration → 当前页面的灵感详情弹窗。

const KIND_FILTERS = ["", "cron", "inspiration"] as const;

// 服务端已过滤 heartbeat；旧缓存和尚未升级的服务端也要遵循同一显示规则。
// 与 core/dashboard-activity.js 保持一致，仅匹配系统结果，不按任务名过滤。
export function isVisibleDashboardActivity(entry: DashboardActivityEntry): entry is Exclude<DashboardActivityEntry, { kind: "health" }> {
  if (entry.kind === "health") return false;
  return !(entry.kind === "cron" && entry.backendId === "openclaw"
    && [entry.summary, entry.run.summary, entry.run.error].some((message) =>
      typeof message === "string" && /^heartbeat (?:(?:wake requested|(?:task )?completed)$|(?:failed|skipped):)/.test(message),
    ));
}

function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const stripMdMarks = (s: string): string => s.replace(/[*_`#]{1,}/g, "").replace(/\s+/g, " ").trim();

function mergeEntries(base: DashboardActivityEntry[], incoming: DashboardActivityEntry[]): DashboardActivityEntry[] {
  const byId = new Map<string, DashboardActivityEntry>();
  for (const e of [...base, ...incoming]) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) =>
    a.occurredAt !== b.occurredAt ? b.occurredAt - a.occurredAt : a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
  );
}

// Keep stable avatar identity separate from its current display name.
function ActivityAgentAvatar({ agentId, displayName }: { agentId: string; displayName?: string }) {
  return <AgentAvatarView agentId={agentId} name={displayName} className="dash-run-agent-avatar" loading="lazy" />;
}

export default function ActivityFeed({
  status,
  firstPage,
  sinceMs,
  running,
  approvals = [],
  canRespondToApproval,
  onApprovalResponded,
  onOpenApprovalRun,
  onOpenRun,
  onOpenRunning,
  canOpenRunning,
  getAgentDisplayName,
  onOpenTask,
  onOpenInspiration,
}: {
  status: BackendStatus[];
  firstPage?: DashboardActivityPage;
  sinceMs: number;
  running: DashboardRunningItem[];
  approvals?: DashboardApprovalItem[];
  canRespondToApproval?: (entry: DashboardApprovalItem) => boolean;
  onApprovalResponded?: () => Promise<void>;
  onOpenApprovalRun?: (entry: DashboardApprovalItem) => void;
  onOpenRun: (entry: Extract<DashboardActivityEntry, { kind: "cron" }>) => void;
  onOpenRunning?: (entry: DashboardRunningItem) => void;
  canOpenRunning?: (entry: DashboardRunningItem) => boolean;
  getAgentDisplayName: (agentId: string, backendId?: string, fallback?: string) => string;
  onOpenTask: (entry: Extract<DashboardActivityEntry, { kind: "kanban" }>) => void;
  onOpenInspiration: (entry: Extract<DashboardActivityEntry, { kind: "inspiration" }>) => void;
}) {
  const { t } = useTranslation();
  const [backendFilter, setBackendFilter] = useStickyState("dashboard.backendFilter", "");
  const [savedKindFilter, setKindFilter] = useStickyState<typeof KIND_FILTERS[number]>("dashboard.kindFilter", "");
  // 旧版本保存的「系统」或「看板」筛选回到「全部」，首帧就使用有效分类。
  const kindFilter = KIND_FILTERS.includes(savedKindFilter) ? savedKindFilter : "";
  useEffect(() => {
    if (savedKindFilter !== kindFilter) setKindFilter(kindFilter);
  }, [savedKindFilter, kindFilter, setKindFilter]);
  // 「断开连接」的后端不进筛选按钮组（status 全量返回，含 disabled 卡片行）。
  const visibleBackends = sortBackendTabs(status.filter((b) => !b.disabled));
  const filtered = backendFilter !== "" || kindFilter !== "";
  const filteredFirstPage = filtered ? firstPage : undefined;

  // 无筛选时以 summary 首屏为基底；有筛选时以服务端筛选页为基底。
  const [entries, setEntries] = useState<DashboardActivityEntry[]>(firstPage?.items || []);
  const visibleEntries = useMemo(() => entries.filter(isVisibleDashboardActivity), [entries]);
  const [hasMore, setHasMore] = useState(!!firstPage?.hasMore);
  const [nextCursor, setNextCursor] = useState<string | undefined>(firstPage?.nextCursor);
  const [busy, setBusy] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const requestGeneration = useRef(0);
  const statusOrder = useRef<string[]>([]);
  const liveRows = useMemo(() => activityStatusRows(running, approvals, statusOrder.current), [running, approvals]);
  useEffect(() => { statusOrder.current = liveRows.map(row => row.key); }, [liveRows]);

  // 跨本地午夜：sinceMs 变化 → 重置筛选与缓存（旧一天的列表不该延续）。
  const dayRef = useRef(sinceMs);
  useEffect(() => {
    if (dayRef.current !== sinceMs) {
      dayRef.current = sinceMs;
      setBackendFilter("");
      setKindFilter("");
      setEntries(firstPage?.items || []);
      setHasMore(!!firstPage?.hasMore);
      setNextCursor(firstPage?.nextCursor);
    }
    // firstPage 由下面的合并 effect 消费；这里只处理换日。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sinceMs]);

  // 45s 轮询带来的新首屏：无筛选时按 id 合并（不清空已加载旧记录）。
  useEffect(() => {
    if (!firstPage || filtered) return;
    setEntries((prev) => mergeEntries(prev, firstPage.items));
    // 只有未点过「加载更多」时才采信首屏的 hasMore/cursor（否则保留更深的游标）。
    setNextCursor((prev) => prev ?? firstPage.nextCursor);
    setHasMore((prev) => prev || !!firstPage.hasMore);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstPage]);

  // 筛选变化或 summary 刷新：重新取筛选页，运行状态随轮询更新。
  useEffect(() => {
    const generation = ++requestGeneration.current;
    if (!filtered) {
      setBusy(false);
      setFetchError(false);
      setEntries(firstPage?.items || []);
      setHasMore(!!firstPage?.hasMore);
      setNextCursor(firstPage?.nextCursor);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setFetchError(false);
    getDashboardActivities({ backend: backendFilter || undefined, kind: kindFilter || undefined })
      .then((page) => {
        if (cancelled) return;
        setEntries(page.items);
        setHasMore(page.hasMore);
        setNextCursor(page.nextCursor);
      })
      .catch(() => { if (!cancelled) setFetchError(true); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; if (requestGeneration.current === generation) requestGeneration.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendFilter, kindFilter, filteredFirstPage]);

  const loadMore = async () => {
    if (!nextCursor || busy) return;
    const generation = requestGeneration.current;
    setBusy(true);
    setFetchError(false);
    try {
      const page = await getDashboardActivities({
        cursor: nextCursor,
        backend: backendFilter || undefined,
        kind: kindFilter || undefined,
      });
      if (generation !== requestGeneration.current) return;
      setEntries((prev) => mergeEntries(prev, page.items));
      setHasMore(page.hasMore);
      setNextCursor(page.nextCursor);
    } catch {
      if (generation === requestGeneration.current) setFetchError(true);
    } finally {
      if (generation === requestGeneration.current) setBusy(false);
    }
  };

  // 加载全部：数据量不大，首屏后若还有剩余就自动把后续页逐页拉完（去掉手动「加载更多」按钮）。
  useEffect(() => {
    if (hasMore && nextCursor && !busy && !fetchError) void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore, nextCursor, busy, fetchError]);

  const kanbanActionLabel = (action: string): string =>
    t(`dashboard.activityAction.${action}`, { defaultValue: action });

  const rowSubtitle = (e: DashboardActivityEntry): string => {
    if (e.kind === "inspiration") {
      const state = t(`inspiration.status.${e.inspiration.status}`);
      return e.summary ? `${state} · ${stripMdMarks(e.summary)}` : state;
    }
    if (e.kind === "kanban") {
      const move = e.kanban.fromStatus && e.kanban.toStatus ? ` ${e.kanban.fromStatus} → ${e.kanban.toStatus}` : "";
      return `${kanbanActionLabel(e.kanban.action)}${move}`;
    }
    return e.summary ? stripMdMarks(e.summary) : "";
  };

  const onRowClick = (e: DashboardActivityEntry) => {
    if (e.kind === "cron") onOpenRun(e);
    else if (e.kind === "kanban") onOpenTask(e);
    else if (e.kind === "inspiration") onOpenInspiration(e);
  };

  const kindLabel = (k: typeof KIND_FILTERS[number] | "kanban"): string =>
    k === "" ? t("dashboard.filterAll")
      : k === "cron" ? t("dashboard.filterCron")
        : k === "kanban" ? t("dashboard.filterKanban")
          : t("dashboard.filterInspiration");

  return (
    <section className="dash-section">
      <div className="dash-feed-head">
        <h2 className="dash-section-title">
          {t("dashboard.feedTitle")}
          <span className="dash-section-count">{visibleEntries.length}</span>
        </h2>
        <div className="dash-feed-filters" role="group" aria-label={t("dashboard.filterAria")}>
          <FilterTabs
            scrollable
            className="dash-kind-tabs"
            ariaLabel={t("dashboard.filterAria")}
            value={kindFilter}
            onChange={(v) => setKindFilter(v as typeof kindFilter)}
            items={KIND_FILTERS.map((k) => ({ value: k, label: kindLabel(k) }))}
          />
          {/* 只剩一个已连接后端时整组隐藏（数据本来就只含它，ALL 即它）。 */}
          {visibleBackends.length > 1 && (
            <FilterTabs
              scrollable
              showTooltips
              className="dash-backend-tabs"
              ariaLabel={t("a11y.switchBackend")}
              value={backendFilter}
              onChange={setBackendFilter}
              items={[
                { value: "", label: t("dashboard.filterAll") },
                ...visibleBackends.map((b) => ({
                  value: b.id,
                  label: b.name || b.id,
                  icon: <BackendTabIcon backend={b.id} label={b.name || b.id} />,
                })),
              ]}
            />
          )}
        </div>
      </div>

      <div className="dash-activity-scroll">
        {/* 同一运行只占一行；审批到来/结束保留组件与位置，原位切换颜色。 */}
        {liveRows.length > 0 && (
          <div className="dash-status-list" role="group" aria-label={t("dashboard.liveTasksTitle")}>
            {liveRows.map(({ key, running: run, approval: item }) => {
              const agentId = run?.agentId || item?.agentId;
              const backendId = run?.backendId || item?.backendId;
              return <ApprovalRow
                key={key}
                running={run}
                item={item}
                agentName={agentId ? getAgentDisplayName(agentId, backendId) : t("dashboard.agentLabel")}
                canRespond={!!item && !!onApprovalResponded && !!canRespondToApproval?.(item)}
                onResponded={onApprovalResponded || (async () => {})}
                onOpenRun={run && onOpenRunning && run.runId && (!canOpenRunning || canOpenRunning(run))
                  ? () => onOpenRunning(run)
                  : item && onOpenApprovalRun && item.runId && canRespondToApproval?.(item)
                    ? () => onOpenApprovalRun(item) : undefined}
              />;
            })}
          </div>
        )}

        {fetchError && <div className="dash-degraded-note">{t("dashboard.activityFetchFailed")}</div>}

        {visibleEntries.length === 0 ? (
          <div className="dash-empty">{busy ? t("common.loading") : t("dashboard.feedEmpty")}</div>
        ) : (
          <div className="dash-feed">
            {visibleEntries.map((e) => (
              <button key={e.id} className="dash-run" onClick={() => onRowClick(e)}>
                {/* 无 agent 的行：用后端 id 当占位头像。 */}
                <ActivityAgentAvatar
                  agentId={e.agentId || e.backendId}
                  displayName={e.agentId ? getAgentDisplayName(e.agentId, e.backendId) : undefined}
                />
                <span className="dash-run-main">
                  <span className="dash-run-head">
                    {e.agentId && (
                      <span className="dash-run-agent">{getAgentDisplayName(e.agentId, e.backendId)}</span>
                    )}
                    <span className="dash-run-name">
                      {e.title || (e.kind === "kanban" ? t("dashboard.deletedTask") : e.id)}
                    </span>
                    <span className={`dash-kind-chip dash-kind-${e.kind}${e.severity === "error" ? " is-error" : ""}`}>
                      {kindLabel(e.kind)}
                    </span>
                    <BackendBadge backendId={e.backendId} />
                    <span className="dash-run-meta">{fmtClock(e.occurredAt)}</span>
                  </span>
                  {rowSubtitle(e) && (
                    <span className={`dash-run-summary${e.severity === "error" ? " is-error" : ""}`}>
                      {rowSubtitle(e)}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}

        {busy && hasMore && (
          <div className="dash-load-more"><FusionLoader size="sm" label={t("common.loading")} /></div>
        )}
      </div>
    </section>
  );
}
