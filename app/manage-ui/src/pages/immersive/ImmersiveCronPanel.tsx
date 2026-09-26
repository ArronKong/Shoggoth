import { useTranslation } from "react-i18next";
import { listCronJobs } from "../../api/client";
import { usePageCache } from "../../lib/usePageCache";
import styles from "./ImmersivePanels.module.css";

// 当前 agent 的定时任务面板（只读 v1）：listCronJobs 的服务端 agentIds 过滤
// （static-server filterCronJobs 已支持），照 AgentsPage cron tab 的口径但走服务端。
// 启停/立跑等写操作留在定时任务页（YAGNI，见 plan §七）。

function fmtWhen(ts: number): string {
  return new Date(ts).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function ImmersiveCronPanel({ backendId, agentId }: { backendId: string; agentId: string }) {
  const { t } = useTranslation();
  const { data: jobs, loading } = usePageCache(
    `immersive:cron:${backendId}:${agentId}`,
    async () => (await listCronJobs({ agentIds: [agentId] })).filter((job) => job.backendId === backendId),
  );
  if (!jobs?.length) {
    return <div className={styles.empty}>{loading ? t("common.loading") : t("chat.panelCronEmpty")}</div>;
  }
  return (
    <div className={styles.list}>
      {jobs.map((j) => (
        <div key={j.id} className={styles.item}>
          <div className={styles.itemHead}>
            <span
              className={
                j.lastStatus === "error" || j.lastError
                  ? `${styles.dot} ${styles.dotErr}`
                  : j.enabled
                    ? `${styles.dot} ${styles.dotOn}`
                    : styles.dot
              }
              title={j.enabled ? t("cron.enabled", { defaultValue: "enabled" }) : t("cron.disabled", { defaultValue: "disabled" })}
            />
            <span className={styles.itemName}>{j.name || j.id}</span>
          </div>
          <div className={styles.itemMeta}>
            {j.scheduleDisplay && <span>{j.scheduleDisplay}</span>}
            {j.lastRunAt != null && <span>{t("chat.panelLastRun", { time: fmtWhen(j.lastRunAt) })}{j.lastStatus ? ` · ${j.lastStatus}` : ""}</span>}
            {j.nextRunAt != null && <span>{t("chat.panelNextRun", { time: fmtWhen(j.nextRunAt) })}</span>}
          </div>
          {j.lastError && <div className={`${styles.itemSub} ${styles.errText}`}>{j.lastError}</div>}
          {!j.lastError && (j.description || j.prompt) && <div className={styles.itemSub}>{j.description || j.prompt}</div>}
        </div>
      ))}
    </div>
  );
}
