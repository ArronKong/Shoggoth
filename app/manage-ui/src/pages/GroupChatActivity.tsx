import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { readGroupChatMessageActivity } from "../api/groupReads";
import Modal from "../components/Modal";
import TurnTimeline from "../components/TurnTimeline/TurnTimeline";
import { getTurnProcessStats, TurnProcessSummary } from "../components/TurnTimeline/TurnProcess";
import { canonicalToolName, capText, categorizeTool, type TurnStep } from "../lib/turnTimeline";
import type { GroupActivity, GroupActivityTool } from "../types";

type GroupActivityBinding = { groupId: string; memberId: string; opportunityId: string };
export type GroupMessageActivitySource = GroupActivityBinding & {
  ownerScope: string; messageId: string; seq: number; runId: string; discussionId: string;
};
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

export default function GroupChatActivityDialog({ activity, memberName, startedAt, finishedAt, history = false, notice, onClose }: {
  activity: GroupActivity | null; memberName?: string; startedAt?: number | null; finishedAt?: number | null;
  history?: boolean; notice?: ReactNode; onClose(): void;
}) {
  const { t } = useTranslation();
  const steps = activity ? groupActivitySteps(activity) : [];
  const title = t("turnLab.processLabel");
  return <Modal open={history || steps.length > 0} width={640} variant="activity"
    title={memberName ? `${title} · ${memberName}` : title}
    subtitle={steps.length > 0 && <TurnProcessSummary stats={getTurnProcessStats(steps)}
      timing={startedAt == null ? undefined : { startedAt, finishedAt: finishedAt ?? undefined }} live={!history} />}
    onClose={onClose} onOpenChangeComplete={open => { if (!open) onClose(); }}>
    {steps.length > 0 ? <TurnTimeline steps={steps} status={history ? "done" : "running"} autoFollow={!history} detail /> : notice}
  </Modal>;
}

export function GroupChatMessageActivityDialog({ source, memberName, onClose }: {
  source: GroupMessageActivitySource; memberName?: string; onClose(): void;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<Awaited<ReturnType<typeof readGroupChatMessageActivity>> | "error" | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void readGroupChatMessageActivity(source.groupId, source, controller.signal).then(reply => {
      if (controller.signal.aborted) return;
      if (reply !== "unsupported") {
        const { activity } = reply;
        if (activity !== null && (!boundGroupActivity(activity, source) || activity.runId !== source.runId
          || activity.discussionId !== source.discussionId || activity.phase !== "completed")) throw new Error("Mismatched saved activity");
      }
      setResult(reply);
    }).catch(() => { if (!controller.signal.aborted) setResult("error"); });
    return () => controller.abort();
  }, [source, attempt]);
  const saved = typeof result === "string" ? null : result;
  return <GroupChatActivityDialog activity={saved?.activity ?? null} memberName={memberName} history
    startedAt={saved?.startedAt} finishedAt={saved?.finishedAt} onClose={onClose}
    notice={result === "error" ? <div>
      <p role="alert">{t("groupChat.activity.error")}</p>
      <button type="button" className="btn-sm" onClick={() => { setResult(null); setAttempt(value => value + 1); }}>{t("common.retry")}</button>
    </div> : <p role="status">{t(result === "unsupported" ? "groupChat.activity.updateRequired"
      : result ? "groupChat.activity.empty" : "groupChat.activity.loading")}</p>} />;
}
