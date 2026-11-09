import { useTranslation } from "react-i18next";
import Modal from "../components/Modal";
import TurnTimeline from "../components/TurnTimeline/TurnTimeline";
import { getTurnProcessStats, TurnProcessSummary } from "../components/TurnTimeline/TurnProcess";
import { canonicalToolName, capText, categorizeTool, type TurnStep } from "../lib/turnTimeline";
import type { GroupActivity, GroupActivityTool } from "../types";

type GroupActivityBinding = { groupId: string; memberId: string; opportunityId: string };
const TERMINAL_PHASES = new Set(["completed", "failed", "cancelled"]);
const PHASES = new Set(["preparing", "queued", "running", "retrying", "tool", "text", "waiting_approval", "waiting_input", "compacting", "compacted", "stopping", "reconciling", ...TERMINAL_PHASES]);

export function groupActivityEnded(phase: GroupActivity["phase"]) {
  return TERMINAL_PHASES.has(phase);
}

/** Only a snapshot for this member's discussion turn may appear in its bubble. */
export function boundGroupActivity(activity: GroupActivity | null | undefined, binding: GroupActivityBinding): GroupActivity | null {
  if (!activity || activity.groupId !== binding.groupId || activity.memberId !== binding.memberId || !PHASES.has(activity.phase)
    || !Number.isSafeInteger(activity.eventSeq) || activity.eventSeq < 0 || !Array.isArray(activity.recentTools)
    || activity.opportunityId !== binding.opportunityId || activity.taskId !== null || activity.attemptId !== null) return null;
  return activity;
}

/** Group detail already carries bounded, redacted snapshots. Text and prompts have their own bubbles. */
export function groupActivitySteps(activity: GroupActivity): TurnStep[] {
  const tools = new Map<string, GroupActivityTool>();
  for (const tool of activity.recentTools) {
    if (typeof tool?.id === "string") tools.set(tool.id, tool);
  }
  if (typeof activity.tool?.id === "string") tools.set(activity.tool.id, activity.tool);
  const steps = Array.from(tools.values(), (tool): TurnStep => {
    const name = tool.name || undefined;
    const output = capText(tool.error ?? tool.output ?? tool.progress);
    return {
      id: `tool:${tool.id}`,
      toolCallId: tool.id,
      kind: "tool",
      status: tool.status === "failed" ? "error" : tool.status === "completed" ? "ok" : "running",
      startTs: tool.startedAt ?? tool.updatedAt ?? 0,
      endTs: tool.finishedAt ?? undefined,
      durationS: tool.durationMs == null ? undefined : tool.durationMs / 1000,
      toolName: name,
      canonicalName: name ? canonicalToolName(name) : undefined,
      category: name ? categorizeTool(name) : undefined,
      args: tool.input ?? undefined,
      output: output.text,
      outputTruncated: output.truncated,
    };
  });
  if (activity.compaction) {
    const { status, observedAt } = activity.compaction;
    steps.push({ id: "context-compaction", kind: "status", statusKind: status,
      startTs: observedAt ?? 0, status: status === "compacted" ? "ok" : "running" });
  }
  if (activity.phase === "retrying") {
    const since = activity.lastProgressAt ?? activity.observedAt;
    if (since != null) steps.push({ id: "provider-retry", kind: "status", status: "running", startTs: since,
      startupWait: { kind: "retrying", reason: null, since } });
  }
  return steps.sort((a, b) => a.startTs - b.startTs);
}

export default function GroupChatActivityDialog({ activity, memberName, startedAt, onClose }: {
  activity: GroupActivity | null; memberName?: string; startedAt?: number | null; onClose(): void;
}) {
  const { t } = useTranslation();
  const steps = activity ? groupActivitySteps(activity) : [];
  const title = t("turnLab.processLabel");
  return <Modal open={steps.length > 0} width={640} variant="activity"
    title={memberName ? `${title} · ${memberName}` : title}
    subtitle={steps.length > 0 && <TurnProcessSummary stats={getTurnProcessStats(steps)}
      timing={startedAt == null ? undefined : { startedAt }} live />}
    onClose={onClose} onOpenChangeComplete={open => { if (!open) onClose(); }}>
    {steps.length > 0 && <TurnTimeline steps={steps} status="running" detail />}
  </Modal>;
}
