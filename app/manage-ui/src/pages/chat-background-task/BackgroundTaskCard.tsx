import { useTranslation } from "react-i18next";
import completedIcon from "../../assets/figma/background-task/completed.svg";
import failedIcon from "../../assets/figma/background-task/failed.svg";
import FusionLoader from "../../components/FusionLoader";
import type { BackgroundTask, BackgroundTaskStatus } from "../../types";
import { recordCompletedBackgroundTaskOpened } from "../../lib/productTelemetry";
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
  const label = t("backgroundTask.label");
  const status = t(`backgroundTask.status.${task.status}`);
  const showReport = task.report === "held" || (task.status === "completed" && task.report !== "none" && task.report !== "delivered");
  const icon = tone === "done" ? completedIcon : tone === "error" ? failedIcon : null;
  return <button type="button" className={styles.card} data-tone={tone} onClick={event => {
    if (event.isTrusted && task.status === "completed") recordCompletedBackgroundTaskOpened();
    onOpen();
  }}
    aria-label={`${label} · ${task.title} · ${status}`}>
    <span className={styles.meta}>
      <span className={styles.status}>
        {tone === "active" || tone === "attention"
          ? <FusionLoader size="sm" className={styles.loader} preserveBallEdges />
          : icon ? <img className={styles.icon} src={icon} alt="" /> : <span className={styles.dot} aria-hidden="true" />}
        <span>{status}</span>
      </span>
      <span className={styles.label}>{label}</span>
    </span>
    <span className={styles.title}>{task.title}</span>
    {showReport && <span className={styles.report}>{t(`backgroundTask.report.${task.report}`)}</span>}
  </button>;
}
