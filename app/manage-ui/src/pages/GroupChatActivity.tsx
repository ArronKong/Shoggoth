import { useTranslation } from "react-i18next";
import { formatDuration, toolActivityTitle } from "../lib/turnTimeline";
import type { GroupActivity, GroupActivityTool } from "../types";
import styles from "./GroupChatPanel.module.css";

export type GroupActivityBinding = { groupId: string; memberId: string; opportunityId?: string; taskId?: string; attemptId?: string };
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const PHASES = new Set(["preparing", "queued", "running", "tool", "text", "waiting_approval", "waiting_input", "compacting", "compacted", "stopping", "reconciling", ...TERMINAL]);
/** Presentation never transfers a previous execution's activity to a new opportunity or task attempt. */
export function boundGroupActivity(activity: GroupActivity | null | undefined, binding: GroupActivityBinding): GroupActivity | null {
  if (!activity || activity.groupId !== binding.groupId || activity.memberId !== binding.memberId || !PHASES.has(activity.phase)
    || !Number.isSafeInteger(activity.eventSeq) || activity.eventSeq < 0 || !Array.isArray(activity.recentTools)
    || binding.opportunityId !== undefined && (activity.opportunityId !== binding.opportunityId || activity.taskId !== null || activity.attemptId !== null)
    || binding.taskId !== undefined && (activity.taskId !== binding.taskId || activity.attemptId !== binding.attemptId || activity.opportunityId !== null)) return null;
  return activity;
}
function detailText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try { return (typeof value === "string" ? value : JSON.stringify(value, null, 2)).slice(0, 4096); }
  catch { return null; }
}
export default function GroupChatActivity({ activity: provided, binding, fallbackPhase = "running", context }: {
  activity?: GroupActivity | null; binding: GroupActivityBinding; fallbackPhase?: "running" | "preparing" | "queued" | "stopping" | "reconciling";
  context?: string;
}) {
  const { t } = useTranslation();
  const activity = boundGroupActivity(provided, binding);
  const phase = activity?.phase ?? fallbackPhase;
  const tools = new Map<string, GroupActivityTool>();
  for (const tool of activity?.recentTools ?? []) if (tool && typeof tool.id === "string") tools.set(tool.id, tool);
  if (activity?.tool) tools.set(activity.tool.id, activity.tool);
  const currentTitle = activity?.phase === "tool" && activity.tool
    ? toolActivityTitle(activity.tool.name || undefined, activity.tool.input, t) : t(`groupChat.activity.phase.${phase}`);
  return <div className={styles.executionActivity} data-group-activity={binding.opportunityId ?? binding.attemptId}
    data-activity-kind={binding.opportunityId ? "turn" : "task"} data-activity-phase={phase}>
    <div className={styles.executionActivityHead}>
      {context && <span className={styles.executionContext}>{context}</span>}
      <span className={styles.executionTitle}>{currentTitle}</span>
      {phase === "tool" && <span className={styles.muted}>{t("groupChat.activity.phase.tool")}</span>}
      {activity?.lastProgressAt != null && <time className={styles.executionProgress} dateTime={new Date(activity.lastProgressAt).toISOString()}>
        {t("groupChat.activity.lastProgress", { time: new Date(activity.lastProgressAt).toLocaleTimeString() })}</time>}
    </div>
    {!activity && <p className={styles.executionFallback}>{t("groupChat.activity.detailUnavailable")}</p>}
    {activity?.compaction && <details className={styles.executionDetails} data-group-compaction={activity.compaction.status}>
      <summary>{t("groupChat.activity.compactionDetails")}</summary>
      <p>{t(TERMINAL.has(phase) && activity.compaction.status === "compacting"
        ? "groupChat.activity.lastCompacting" : `groupChat.activity.phase.${activity.compaction.status}`)}</p>
    </details>}
    {tools.size > 0 && <details className={styles.executionDetails}>
      <summary>{t("groupChat.activity.details", { count: tools.size })}</summary>
      <div className={styles.executionToolList}>
        {[...tools.values()].slice(-8).map(tool => <details key={tool.id} className={styles.executionTool} data-tool-status={tool.status}>
          <summary><span>{toolActivityTitle(tool.name || undefined, tool.input, t)}</span>
            <span className={styles.taskStatus}>{t(TERMINAL.has(phase) && tool.status === "running"
              ? "groupChat.activity.lastRunning" : `groupChat.activity.toolStatus.${tool.status}`)}</span>
            {tool.durationMs !== null && <span className={styles.muted}>{tool.durationMs === 0 ? "0ms" : formatDuration(tool.durationMs / 1000)}</span>}
          </summary>
          {tool.name && <p className={styles.muted}>{t("groupChat.activity.toolName", { name: tool.name })}</p>}
          {(["input", "progress", "output", "error"] as const).map(field => {
            const text = detailText(tool[field]);
            return text === null ? null : <div key={field} className={styles.executionToolDetail}>
              <strong>{t(`groupChat.activity.${field}`)}</strong><pre>{text}</pre>
            </div>;
          })}
        </details>)}
      </div>
    </details>}
  </div>;
}
