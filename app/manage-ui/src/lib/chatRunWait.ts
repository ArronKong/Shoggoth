import type { TurnStep } from "./turnTimeline";

export type ChatStartupStage = "preparing" | "context" | "compacting" | "capabilities" | "connecting" | "restoring" | "opening" | "waiting";
export type ChatRunWaitState = { kind: "queued" | "retrying" | "starting"; reason: string | null; since: number; stage?: ChatStartupStage };
const STARTUP_STAGES = new Set(["preparing", "context", "compacting", "capabilities", "connecting", "restoring", "opening", "waiting"]);

export const CHAT_WAIT_REASONS: Record<string, string> = {
  RUNTIME_ACCOUNT_ACTIVE_LIMIT: "account",
  RUNTIME_ACCOUNT_BACKOFF: "cooldown",
  RUNTIME_ACCOUNT_MUTATION_BUSY: "accountUpdating",
  CHAT_SESSION_BUSY: "session",
  WORKSPACE_WRITE_BUSY: "workspace",
  PROFILE_ACTIVE_LIMIT: "agent",
  PROFILE_WORKSPACE_WRITE_LIMIT: "agentWorkspace",
  GLOBAL_CAPACITY: "global",
  STARTUP_BACKPRESSURE: "startup",
  HOST_CAPACITY: "host",
  RUNTIME_HOST_CAPACITY: "host",
  SERVICE_QUIESCED: "service",
  BACKEND_ACTIVE_LIMIT: "backend",
  BACKEND_BACKGROUND_ACTIVE_LIMIT: "backendBackground",
  // Persisted events from the previous shared-budget policy remain readable.
  GLOBAL_ACTIVE_LIMIT: "global",
  BACKGROUND_ACTIVE_LIMIT: "background",
};

export function chatRunWaitState(payload: { statusKind?: unknown; reason?: unknown; queuedAt?: unknown; stage?: unknown }, now = Date.now(), previous?: ChatRunWaitState): ChatRunWaitState | null {
  if (payload.statusKind === "retrying") {
    return { kind: "retrying", reason: payload.reason === "RUNTIME_RATE_LIMITED" || payload.reason === "RUNTIME_UPSTREAM_UNAVAILABLE" ? payload.reason : null, since: now };
  }
  if (payload.statusKind === "starting" || (payload.statusKind === "running"
    && (payload.stage === "waiting" || previous?.kind === "starting"))) {
    const stage = typeof payload.stage === "string" && STARTUP_STAGES.has(payload.stage)
      ? payload.stage as ChatStartupStage : payload.statusKind === "running" ? "waiting" : previous?.stage ?? "connecting";
    return { kind: "starting", stage, reason: null, since: previous?.kind === "starting" ? previous.since : now };
  }
  if (payload.statusKind !== "queued") return null;
  return { kind: "queued",
    reason: typeof payload.reason === "string" && Object.hasOwn(CHAT_WAIT_REASONS, payload.reason) ? payload.reason : null,
    since: typeof payload.queuedAt === "number" && Number.isSafeInteger(payload.queuedAt) && payload.queuedAt >= 0
      ? Math.min(now, payload.queuedAt) : now };
}

// Only confirmed content or a terminal/waiting state ends startup feedback.
// Empty chunks and accepted receipts do not prove the assistant has responded.
export function updateChatRunWait(previous: ChatRunWaitState | undefined,
  event: { state?: string; statusKind?: unknown; stage?: unknown; reason?: unknown; queuedAt?: unknown },
  hasOutput = false, now = Date.now()): ChatRunWaitState | undefined {
  if (["final", "error", "aborted", "prompt"].includes(event.state || "")
    || (event.state === "status" && ["idle", "needs_verification", "reconnecting", "waiting_approval", "waiting_input"].includes(String(event.statusKind)))) return undefined;
  if (event.state !== "status") return hasOutput ? undefined : previous;
  const next = chatRunWaitState(event, now, previous);
  if (!next) return hasOutput ? undefined : previous;
  if (next.kind === "starting" && hasOutput) return undefined;
  if (previous?.kind === next.kind && previous.reason === next.reason) {
    next.since = Math.min(previous.since, next.since);
    if (previous.stage === next.stage && previous.since === next.since) return previous;
  }
  return next;
}

// One live row changes with the confirmed phase. It does not manufacture
// completed steps or enter the saved transcript.
export function withStartupWait(steps: TurnStep[], wait?: ChatRunWaitState): TurnStep[] {
  if (wait?.kind !== "starting") return steps;
  return [{ id: `startup:${wait.since}`, kind: "status", status: "running",
    startTs: wait.since, statusKind: "starting", startupWait: wait }, ...steps];
}
