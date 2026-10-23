import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import Modal from "../../components/Modal";
import AgentAvatar from "../../components/AgentAvatar";
import TurnTimeline from "../../components/TurnTimeline/TurnTimeline";
import type { DashboardApprovalItem, DashboardRunningItem } from "../../types";
import { fmtMs } from "../usage/charts";
import { dashboardRunPresentation, isTerminalRun } from "./runPresentation";
import { useDashboardRunDetail } from "./useDashboardRunDetail";
import "./runDetailResources";
import styles from "./RunDetailModal.module.css";

const statuses = new Set(["queued", "starting", "running", "waiting_approval", "waiting_input", "completed", "failed", "canceled", "interrupted", "skipped"]);

export default function RunDetailModal({ item, agentName, open, onClose, onClosed, onFinished }: {
  item: DashboardRunningItem | DashboardApprovalItem;
  agentName: string;
  open: boolean;
  onClose: () => void;
  onClosed: () => void;
  onFinished: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const { detail, error, now, refresh } = useDashboardRunDetail(item.backendId!, item.runId!, open);
  const view = useMemo(() => detail ? dashboardRunPresentation(detail) : null, [detail]);
  const finished = detail != null && isTerminalRun(detail.status);
  useEffect(() => {
    // Results belong to the existing activity card. Refresh it only after the
    // Run snapshot confirms completion, never just because reply text arrived.
    if (open && finished) void onFinished();
  }, [open, finished, onFinished]);
  const running = item as DashboardRunningItem;
  const source = detail?.source || (item as DashboardApprovalItem).source || running.kind;
  const kind = t(source === "cron" ? "dashboard.kindCron" : source === "kanban" ? "dashboard.kindKanban"
    : source === "inspiration" ? "dashboard.kindInspiration" : "dashboard.kindTask");
  const title = detail?.title || (running.title && !["Cron", "Kanban", "Inspiration", item.id].includes(running.title) ? running.title : "")
    || t("dashboardRun.task");
  const status = view?.status || running.status || "unknown";
  const startedAt = detail?.startedAt ?? running.startedAt;
  const endedAt = detail?.finishedAt ?? (view?.live === false ? undefined : now);
  const duration = startedAt != null && endedAt != null ? fmtMs(Math.max(0, endedAt - startedAt)) : "—";

  return <Modal open={open} onClose={onClose} onOpenChangeComplete={value => { if (!value) onClosed(); }}
    title={title} subtitle={t("dashboardRun.subtitle")} className={styles.modal}>
    <div className={styles.overview}>
      <div className={styles.agent}>
        <AgentAvatar agentId={item.agentId} name={agentName} className={styles.avatar} />
        <div><div className={styles.agentName}>{agentName}</div>
          <div className={styles.context}>{kind}{detail?.runtime ? ` · ${detail.runtime}` : ""}</div>
        </div>
      </div>
      <span className={styles.status} data-status={status} role="status">{t(`dashboardRun.status.${statuses.has(status) ? status : "unknown"}`)}</span>
    </div>
    <dl className={styles.facts}>
      <div><dt>{t("dashboardRun.started")}</dt><dd>{startedAt != null ? new Date(startedAt).toLocaleString(i18n.language, { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}</dd></div>
      <div><dt>{t(view?.live === false ? "dashboardRun.duration" : "dashboardRun.elapsed")}</dt><dd>{duration}</dd></div>
    </dl>
    {error && <div className={styles.notice} role="status">
      <span>{t(detail ? "dashboardRun.stale" : "dashboard.shoggothRunFailed")}</span>
      <button type="button" className="btn-subtle btn-sm" onClick={refresh}>{t("dashboardRun.retry")}</button>
    </div>}
    {detail?.error && <p className={styles.failure} role="alert">{detail.error}</p>}
    {(detail || !error) && <section className={styles.activity} aria-label={t("turnLab.processLabel")}>
      <div className={styles.activityHead}>
        <h3>{t("turnLab.processLabel")}</h3>
        {view && <span className={styles.update} data-live={view.live && !error ? "true" : undefined}>
          {t(error ? "dashboardRun.paused" : view.live ? "dashboardRun.live" : "dashboardRun.finished")}
        </span>}
      </div>
      {view?.steps.length ? <TurnTimeline steps={view.steps} status={view.timelineStatus} showDurations={false} autoFollow={false} className={styles.timeline} />
        : <p className={styles.empty}>{t(!detail ? "dashboardRun.loading" : view?.live ? "dashboardRun.empty" : "dashboardRun.emptyFinished")}</p>}
    </section>}
  </Modal>;
}
