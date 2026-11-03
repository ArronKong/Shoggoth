import type { DashboardLiveWork } from "../types";

type PromptIdentity = { backendId: string; runId?: string; requestId: string };

// Receipts contain identities only. They bridge Chat and Dashboard while an
// older poll or summary is in flight; they never grant or replay an action.
const responded = new Set<string>();
const listeners = new Set<() => void>();
const MAX_RESPONDED_PROMPTS = 8_192;
let revision = 0;
const keyOf = ({ backendId, runId, requestId }: PromptIdentity) =>
  JSON.stringify([backendId, runId || "", requestId]);

export function acknowledgeDashboardPrompt(identity: PromptIdentity): void {
  if (!identity.backendId || !identity.requestId || responded.has(keyOf(identity))) return;
  responded.add(keyOf(identity));
  if (responded.size > MAX_RESPONDED_PROMPTS) responded.delete(responded.values().next().value!);
  revision++;
  for (const listener of listeners) listener();
}

export const dashboardPromptResponseRevision = () => revision;
export function subscribeDashboardPromptResponses(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function withoutRespondedDashboardPrompts(work: DashboardLiveWork): DashboardLiveWork {
  const approvals = work.approvals.map(section => ({ ...section, items: section.items.filter(item =>
    !responded.has(keyOf({ backendId: item.backendId || section.backend,
      runId: item.runId, requestId: item.requestId || item.id }))) }));
  const running = work.running.map(section => ({ ...section, items: section.items.map(item =>
    item.waitingRequestId && ["waiting_approval", "waiting_input"].includes(item.status || "")
      && responded.has(keyOf({ backendId: item.backendId || section.backend,
        runId: item.runId, requestId: item.waitingRequestId }))
      ? { ...item, status: "running", waitingRequestId: undefined } : item) }));
  return { ...work, approvals, running };
}
