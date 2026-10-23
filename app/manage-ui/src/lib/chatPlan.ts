export interface ChatPlanEntry {
  content: string;
  status: string;
  progressRevision?: number;
  progressUpdatedAt?: number;
  progressMarkdown?: string;
}

interface PlanPart {
  type: string;
  planEntries?: ChatPlanEntry[];
  steps?: { kind: string; planEntries?: { content: string; status?: string }[] }[];
}

interface PlanMessage {
  role: string;
  parts: PlanPart[];
  pending?: boolean;
  divider?: unknown;
  notice?: unknown;
  local?: boolean;
  ephemeral?: string;
  images?: unknown[];
  files?: unknown[];
}

/** Recover only this turn's latest snapshot, never an older turn's unfinished plan. */
export function latestChatPlan(messages: readonly PlanMessage[]): ChatPlanEntry[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.ephemeral === "progressCard") continue;
    if (message.role === "user" || message.divider || message.notice || message.local) break;
    if (message.role !== "assistant") continue;
    for (let j = message.parts.length - 1; j >= 0; j--) {
      const part = message.parts[j];
      // An explicit empty snapshot clears the plan; don't resurrect an earlier one.
      if (part.type === "plan") return part.planEntries ?? [];
      if (part.type === "timeline") {
        const plan = [...(part.steps ?? [])].reverse().find((step) => step.kind === "plan");
        if (plan) return (plan.planEntries ?? []).map((entry) => ({
          content: entry.content, status: entry.status ?? "pending",
        }));
      }
    }
  }
  return [];
}

export function withoutPlanSteps<T extends { kind: string }>(steps: readonly T[]): T[] {
  return steps.filter((step) => step.kind !== "plan");
}

/** Presentation only: canonical history and copy/search identities stay intact. */
export function chatMessagesWithoutPlans<T extends PlanMessage>(messages: readonly T[]): T[] {
  return messages.flatMap((message) => {
    if (message.ephemeral === "progressCard") return [];
    let changed = false;
    const parts = message.parts.flatMap((part) => {
      if (part.type === "plan") { changed = true; return []; }
      if (part.type === "timeline" && part.steps?.some((step) => step.kind === "plan")) {
        changed = true;
        const steps = withoutPlanSteps(part.steps);
        return steps.length ? [{ ...part, steps }] : [];
      }
      return [part];
    });
    if (!changed) return [message];
    if (!parts.length && !message.pending && !message.images?.length && !message.files?.length
      && !message.divider && !message.notice) return [];
    return [{ ...message, parts }];
  });
}
