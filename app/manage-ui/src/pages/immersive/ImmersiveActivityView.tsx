import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { getDashboardActivities } from "../../api/client";
import type { DashboardActivityEntry } from "../../types";
import { usePageCache } from "../../lib/usePageCache";
import styles from "./ImmersiveActivityView.module.css";

// 沉浸模式「今日动态」视图（Figma 6677:77 AgentTodolist）：聊天收起后，左列换成
// 按小时分组的当天活动时间轴。数据与 Dashboard 今日动态**完全同源**
// （getDashboardActivities：cron 运行 + 看板事件 + 系统健康，服务端默认今日零点起）
// ——零后端改动，只读呈现。合并/自动翻完所有页/45s+visibilitychange 轮询的口径照抄
// dashboard/ActivityFeed.tsx。设计偏差（已与设计稿核对）：稿里的「模型名」列在活动
// 数据里不存在 → 以 kind 徽标（定时/看板/系统）替代；勾选圆点是视觉样式不可交互。

function mergeEntries(base: DashboardActivityEntry[], incoming: DashboardActivityEntry[]): DashboardActivityEntry[] {
  const byId = new Map<string, DashboardActivityEntry>();
  for (const e of [...base, ...incoming]) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) =>
    a.occurredAt !== b.occurredAt ? b.occurredAt - a.occurredAt : a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
  );
}

// 首页 + 自动翻完剩余页（数据量今日级，最多 5 页护栏），返回合并列表。
async function fetchAllToday(): Promise<DashboardActivityEntry[]> {
  let page = await getDashboardActivities({});
  let items = mergeEntries([], page.items);
  let guard = 0;
  while (page.hasMore && page.nextCursor && guard < 5) {
    page = await getDashboardActivities({ cursor: page.nextCursor });
    items = mergeEntries(items, page.items);
    guard += 1;
  }
  return items;
}

const stripMdMarks = (s: string): string => s.replace(/[*_`#]{1,}/g, "").replace(/\s+/g, " ").trim();

function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function ImmersiveActivityView() {
  const { t } = useTranslation();
  const { data: entries, loading, error, refresh } = usePageCache<DashboardActivityEntry[]>("immersive:activity", fetchAllToday);
  // 视图打开期间 45s 轮询 + 标签页回前台立刻补一拍（Dashboard 同口径）。
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    const iv = setInterval(() => void refreshRef.current(), 45_000);
    const onVis = () => {
      if (!document.hidden) void refreshRef.current();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // 按小时分组（倒序：最新的小时在最上）。
  const hourGroups = useMemo(() => {
    const m = new Map<string, DashboardActivityEntry[]>();
    for (const e of entries ?? []) {
      const d = new Date(e.occurredAt);
      const key = `${String(d.getHours()).padStart(2, "0")}:00`;
      const arr = m.get(key);
      if (arr) arr.push(e);
      else m.set(key, [e]);
    }
    return [...m.entries()];
  }, [entries]);

  const kindLabel = (e: DashboardActivityEntry): string =>
    e.kind === "cron" ? t("dashboard.filterCron") : e.kind === "kanban" ? t("dashboard.filterKanban") : t("dashboard.filterSystem");

  const rowSubtitle = (e: DashboardActivityEntry): string => {
    if (e.kind === "kanban") {
      const move = e.kanban.fromStatus && e.kanban.toStatus ? ` ${e.kanban.fromStatus} → ${e.kanban.toStatus}` : "";
      return `${t(`dashboard.activityAction.${e.kanban.action}`, { defaultValue: e.kanban.action })}${move}`;
    }
    if (e.kind === "health") {
      return e.health.state === "connected" ? t("dashboard.activityHealthUp") : t("dashboard.activityHealthDown");
    }
    return e.summary ? stripMdMarks(e.summary) : "";
  };

  const count = entries?.length ?? 0;
  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <div className={styles.title}>{t("chat.activityTitle")}</div>
        <div className={styles.sub}>{t("chat.activityCount", { count })}</div>
      </div>
      <div className={styles.list} data-glass-clip>
        {(entries?.length ?? 0) === 0 && (
          <div className={styles.empty}>{loading ? t("common.loading") : error ? t("dashboard.activityFetchFailed") : t("dashboard.feedEmpty")}</div>
        )}
        {hourGroups.map(([hour, list]) => (
          <div key={hour} className={styles.hourGroup}>
            <div className={styles.hourLabel}>{hour}</div>
            <div className={styles.hourRows}>
              {list.map((e) => (
                <div key={e.id} className={styles.row}>
                  <span
                    className={
                      e.severity === "error"
                        ? `${styles.mark} ${styles.markError}`
                        : e.severity === "success"
                          ? `${styles.mark} ${styles.markDone}`
                          : styles.mark
                    }
                    aria-hidden="true"
                  >
                    {e.severity === "error" ? "✗" : e.severity === "success" ? "✓" : ""}
                  </span>
                  <div className={styles.rowMain}>
                    <div className={styles.rowMeta}>
                      {e.agentId && <span className={styles.agent}>{e.agentId}</span>}
                      <span className={styles.kind}>{kindLabel(e)}</span>
                      <span className={styles.time}>{fmtClock(e.occurredAt)}</span>
                    </div>
                    <div className={e.severity === "error" ? `${styles.rowTitle} ${styles.rowTitleError}` : styles.rowTitle}>
                      {e.title || e.id}
                    </div>
                    {rowSubtitle(e) && <div className={styles.rowSub}>{rowSubtitle(e)}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
