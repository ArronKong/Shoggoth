import { useTranslation } from "react-i18next";
import type { BackgroundTask, BackgroundTaskStatus } from "../../types";
import styles from "./BackgroundTaskCard.module.css";

const ACTIVE: BackgroundTaskStatus[] = ["starting", "queued", "running", "stopping"];
const ATTENTION: BackgroundTaskStatus[] = ["waiting_approval", "waiting_input", "needs_verification"];

export function backgroundTaskTone(status: BackgroundTaskStatus) {
  if (ACTIVE.includes(status)) return "active";
  if (ATTENTION.includes(status)) return "attention";
  return status === "completed" ? "done" : status === "failed" || status === "interrupted" ? "error" : "idle";
}

/** One task the dispatching reply handed to the background; opens its details. */
export default function BackgroundTaskCard({ task, onOpen }: { task: BackgroundTask; onOpen: () => void }) {
  const { t } = useTranslation();
  const tone = backgroundTaskTone(task.status);
  const report = task.status === "completed" || task.report === "held" ? t(`backgroundTask.report.${task.report}`) : "";
  return <button type="button" className={styles.card} data-tone={tone} onClick={onOpen}
    aria-label={`${t("backgroundTask.label")} · ${task.title} · ${t(`backgroundTask.status.${task.status}`)}`}>
    <span className={styles.indicator} aria-hidden="true" />
    <span className={styles.body}>
      <span className={styles.label}>{t("backgroundTask.label")}</span>
      <span className={styles.title}>{task.title}</span>
    </span>
    <span className={styles.meta}>
      <span className={styles.status}>{t(`backgroundTask.status.${task.status}`)}</span>
      {report ? <span className={styles.report}>{report}</span> : null}
    </span>
  </button>;
}
