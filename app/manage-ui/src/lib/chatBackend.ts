import { isNativeAgentId, nativeBackendCatalog } from "./nativeBackendIdentity";
export type ChatBackendId = string;

export interface BackendOwnedSession {
  key?: string;
  agentId?: string;
  backendId?: string;
}

type ChatCapabilitySummary = {
  attachments?: Record<string, unknown>;
  slash?: boolean;
};

/**
 * Reserve the native namespace during offline/startup discovery.
 * It must never become an OpenClaw write target.
 */
export function backendOfAgent(agentId: string): ChatBackendId {
  return isNativeAgentId(agentId) ? nativeBackendCatalog.id : "openclaw";
}

export function resolveBackendOwner(declaredBackendId: unknown, agentId = ""): ChatBackendId {
  return typeof declaredBackendId === "string" && declaredBackendId.trim()
    ? declaredBackendId.trim()
    : backendOfAgent(agentId);
}

export function backendOfSessionRows(
  sessions: readonly BackendOwnedSession[],
  key: string,
  agentId = "",
): ChatBackendId {
  const row = sessions.find((session) => session.key === key);
  return resolveBackendOwner(row?.backendId, row?.agentId || agentId);
}

export function backendOfAgentRows(
  sessions: readonly BackendOwnedSession[],
  agentId: string,
): ChatBackendId {
  const row = sessions.find((session) => session.agentId === agentId && session.backendId);
  return resolveBackendOwner(row?.backendId, agentId);
}

/**
 * Native media uploads require a ready Service capability. Keep their composer
 * closed during discovery; OpenClaw retains its historical image baseline.
 */
export function supportsBackendAttachments(
  backend: ChatBackendId,
  capabilities: ChatCapabilitySummary | undefined,
): boolean {
  if (!capabilities) return backend === "openclaw";
  return !!capabilities.attachments
    && Object.values(capabilities.attachments).some((value) => value !== undefined);
}

/** OpenClaw 保留客户端内置命令；其它后端只有明确声明服务端 slash 能力才开放。 */
export function supportsBackendSlash(
  backend: ChatBackendId,
  capabilities: ChatCapabilitySummary | undefined,
): boolean {
  if (backend === "openclaw") return true;
  return capabilities?.slash === true;
}

const LIVE_CHAT_STATES = new Set(["delta", "interim", "thinking", "plan", "status", "prompt"]);

/** 非终态事件可由重连后的 Service stream replay 首次到达，用它恢复本地运行态。 */
export function isLiveChatState(state: unknown): boolean {
  return typeof state === "string" && LIVE_CHAT_STATES.has(state);
}

/**
 * Live backends normally send the full accumulated text. Recovery can replay an
 * older prefix after the UI already rendered a newer one; that prefix is stale,
 * not a fresh token. Truly incremental chunks still append for compatibility.
 */
export function mergeLiveText(current: string, incoming: string): string {
  if (incoming.startsWith(current)) return incoming;
  if (current.startsWith(incoming)) return current;
  return current + incoming;
}

/**
 * Runtime chat events carry the accumulated text for the current output item.
 * After a steer the UI starts a new assistant bubble, so only the suffix written
 * after the accepted steer belongs in that bubble. Keep the raw accumulator
 * separate from the projected text so cumulative and incremental backends both
 * retain their existing streaming semantics.
 */
export function projectSteeredLiveText(
  accumulated: string,
  incoming: string,
  steerBaseline?: string,
): { accumulated: string; visible: string } {
  const next = mergeLiveText(accumulated, incoming);
  if (steerBaseline === undefined) return { accumulated: next, visible: next };
  if (next.startsWith(steerBaseline)) {
    return { accumulated: next, visible: next.slice(steerBaseline.length) };
  }
  // A backend may restart its item accumulator when it accepts steering. In
  // that case the incoming text is already the post-steer segment.
  return { accumulated: next, visible: incoming };
}

export function upsertPromptEntry<T extends { id: string; requestId?: string }>(
  entries: readonly T[],
  incoming: T,
): T[] {
  if (typeof incoming.requestId !== "string" || incoming.requestId.length === 0) {
    return [...entries, incoming];
  }
  const index = entries.findIndex((entry) => entry.requestId === incoming.requestId);
  if (index < 0) return [...entries, incoming];
  return entries.map((entry, itemIndex) => (
    itemIndex === index ? { ...incoming, id: entry.id } : entry
  ));
}
