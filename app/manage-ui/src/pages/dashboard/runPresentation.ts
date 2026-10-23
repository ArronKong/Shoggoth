import type { BackendRunDetail } from "../../types";
import { createTimeline, reduceTimeline, type TurnEvent } from "../../lib/turnTimeline";

export const isTerminalRun = (status: string) =>
  ["completed", "failed", "canceled", "interrupted", "skipped"].includes(status);

// Native deltas are incremental. The shared chat timeline consumes cumulative
// segments; sealed segment IDs prevent snapshots/replays duplicating commentary.
export function dashboardRunPresentation(detail: BackendRunDetail) {
  let timeline = createTimeline({ deriveDurations: false });
  let answer = "", reasoning = "";
  const sealed = new Set<string>();
  const answerSteps = new Set<string>();
  const seen = new Set<number>();
  const apply = (event: TurnEvent, seq: number) => { timeline = reduceTimeline(timeline, event, seq); };
  let status = detail.status;
  for (const event of detail.events) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    if (event.type === "text.delta" || event.type === "text") {
      if (event.segmentId && sealed.has(event.segmentId)) continue;
      if (event.type === "text.delta") answer += event.delta || "";
      else if (event.text) {
        if (!answer || event.text.startsWith(answer)) answer = event.text;
        else if (!answer.endsWith(event.text)) answer += event.text;
      }
      if (answer) {
        apply({ kind: "delta", text: answer }, event.seq);
        const pending = [...timeline.steps].reverse().find(step => step.kind === "final" && step.status === "running");
        if (pending) answerSteps.add(pending.id);
      }
      if (event.type === "text" && event.phase === "commentary") {
        // The final snapshot identifies this segment as public progress. Move
        // its provisional answer steps into one activity, retaining tool steps.
        timeline = { ...timeline, steps: timeline.steps.filter(step => !answerSteps.has(step.id)), answerSealed: "" };
        apply({ kind: "interim", text: answer, activity: true, activityId: event.segmentId || String(event.seq) }, event.seq);
        answer = "";
        answerSteps.clear();
      }
      if (event.type === "text" && event.phase && event.segmentId) sealed.add(event.segmentId);
    } else if (event.type === "reasoning.delta" || event.type === "reasoning") {
      reasoning = event.type === "reasoning.delta" ? reasoning + (event.delta || "") : event.text || reasoning;
      if (reasoning) apply({ kind: "thinking", text: reasoning }, event.seq);
    } else if (event.type === "plan" && event.plan?.length) {
      apply({ kind: "plan", entries: event.plan }, event.seq);
    } else if (["tool.start", "tool.update", "tool.result"].includes(event.type) && event.tool) {
      const tool = event.tool;
      const failed = tool.isError === true || tool.status === "failed" || tool.success === false
        || (typeof tool.exitCode === "number" && tool.exitCode !== 0);
      apply({ kind: "tool", toolCallId: event.toolCallId || `legacy-${event.seq}`,
        name: tool.name || tool.kind, args: tool.displayArgs,
        phase: event.type === "tool.start" ? "start" : event.type === "tool.result" ? "result" : "update",
        result: tool.resultSummary || tool.errorCode, partialResult: event.message, isError: failed,
        durationS: typeof tool.durationMs === "number" ? tool.durationMs / 1000 : undefined,
      }, event.seq);
    } else if (event.type === "approval" || event.type === "prompt") {
      apply({ kind: "prompt", prompt: { kind: event.type === "approval" ? "approval" : "input",
        requestId: event.requestId, question: event.message } }, event.seq);
    } else if (event.type === "status") {
      if (event.requestId) apply({ kind: "promptExpire", requestId: event.requestId }, event.seq);
      if (event.status) apply({ kind: "status", status: { kind: event.status, text: event.message } }, event.seq);
    } else if (event.type === "terminal" && event.status && isTerminalRun(event.status)) {
      status = event.status;
    }
  }
  const lastSeq = detail.events.at(-1)?.seq || 0;
  if (isTerminalRun(status)) {
    if (["canceled", "interrupted", "skipped"].includes(status)) apply({ kind: "aborted" }, lastSeq);
    else apply({ kind: "final", text: answer || detail.summary || "", errored: status === "failed" }, lastSeq);
  }
  const steps = timeline.steps.filter(step => step.kind !== "final" && (step.kind !== "text" || step.activity));
  return { steps, status, live: !isTerminalRun(status), timelineStatus: timeline.status };
}
