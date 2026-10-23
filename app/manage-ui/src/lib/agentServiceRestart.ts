import type { ShoggothBackgroundStatus, ShoggothServiceProductStatus } from "../types";

export interface AgentServiceRestartState {
  startedAt: number | null;
  wasHealthy: boolean | null;
  hasBeenHealthy: boolean;
  recoveringNotified: boolean;
  notifyAt: number | null;
}

export type AgentServiceRestartNotice = "recovering" | "restarted" | null;

export const INITIAL_AGENT_SERVICE_RESTART_STATE: AgentServiceRestartState = {
  startedAt: null,
  wasHealthy: null,
  hasBeenHealthy: false,
  recoveringNotified: false,
  notifyAt: null,
};

// Match the LaunchAgent's startup budget; pending-command crypto gets a shorter grace.
const STARTUP_GRACE_MS = 45_000;
const DEGRADED_GRACE_MS = 10_000;

export function observeAgentService(
  previous: AgentServiceRestartState,
  service: ShoggothServiceProductStatus | null,
  background?: ShoggothBackgroundStatus,
  now = Date.now(),
): { state: AgentServiceRestartState; notice: AgentServiceRestartNotice } {
  // Disabled is authoritative user intent, including the disable → bootout gap.
  // An enabled but unloaded job can be a crash and must still report a fault.
  const intentionallyStopped = background?.supported === true
    && background.enabled === false && background.needsRepair === false;
  const unavailableHere = previous.wasHealthy === null && background?.supported === false
    && (background.reason === "unsupported-platform" || background.reason === "unstable-install-location");
  if (intentionallyStopped || unavailableHere) {
    return { state: INITIAL_AGENT_SERVICE_RESTART_STATE, notice: null };
  }

  // MCP credentials initialize on demand, independently of Service health.
  const ready = service?.healthy === true
    && !service.pendingCommandsLocked
    && service.domainAvailability?.kanban !== false && service.domainAvailability?.cron !== false;
  if (!ready) {
    // Failed HTTP/IPC reads also produce healthy:false conservative snapshots.
    // Confirm them on a later poll while launchd is loaded or unobservable;
    // an unloaded or repair-required job is authoritative and bypasses that wait.
    const confirmedFailure = background?.supported === true
      && (background.needsRepair === true || (background.enabled === true && background.loaded === false));
    const grace = !previous.hasBeenHealthy ? STARTUP_GRACE_MS
      : confirmedFailure ? 0 : DEGRADED_GRACE_MS;
    const notifyAt = confirmedFailure && previous.hasBeenHealthy ? now
      : previous.notifyAt ?? now + grace;
    const shouldNotify = !previous.recoveringNotified && now >= notifyAt;
    return {
      state: { ...previous, wasHealthy: false, notifyAt,
        recoveringNotified: previous.recoveringNotified || shouldNotify },
      notice: shouldNotify ? "recovering" : null,
    };
  }

  const startedAt = typeof service.startedAt === "number" && Number.isSafeInteger(service.startedAt)
    ? service.startedAt : null;
  const restarted = startedAt !== null && previous.startedAt !== null && previous.startedAt !== startedAt;
  return {
    state: { startedAt: startedAt ?? previous.startedAt, wasHealthy: true, hasBeenHealthy: true,
      recoveringNotified: false, notifyAt: null },
    notice: restarted ? "restarted" : null,
  };
}
