const CRON_CHAT_HANDOFF_KEY = "shoggoth.chat.handoff";
let suppressedHandoffKey: string | null = null;

interface CronRunHandoffInput {
  agentId?: string;
  startedAt?: number | null;
  sessionKey?: string;
  summary?: string;
}

interface CronDeliveryHandoffInput {
  startedAt?: number | null;
  sessionKey?: string;
  summary?: string;
  fullText?: string | null;
}

export interface CronRunHandoffSource {
  sessionKey: string | null;
  report: string | null;
  isFullText: boolean;
}

export interface CronChatHandoff {
  backendId?: string;
  sessionKey: string;
  report: string;
}

export function firstNonBlankText(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export function canonicalCronSessionKey(
  agentId: string | undefined,
  sessionKey: string | undefined,
): string | null {
  const normalizedSessionKey = sessionKey?.trim();
  if (!normalizedSessionKey) return null;

  if (normalizedSessionKey.startsWith("agent:")) {
    const match = normalizedSessionKey.match(/^agent:([^:]+):(.+)$/);
    if (!match) return null;
    const keyAgentId = match[1].trim();
    const keyTail = match[2].trim();
    if (!keyAgentId || !keyTail) return null;
    return `agent:${keyAgentId}:${keyTail}`;
  }

  const normalizedAgentId = agentId?.trim();
  if (!normalizedAgentId) return null;
  return `agent:${normalizedAgentId}:${normalizedSessionKey}`;
}

function handoffKey(backendId: string, sessionKey: string): string {
  return `${backendId}\u0000${sessionKey}`;
}

export function writeCronChatHandoff(backendId: string, sessionKey: string, report: string): void;
/** @deprecated Pass backendId as the first argument. */
export function writeCronChatHandoff(sessionKey: string, report: string): void;
export function writeCronChatHandoff(
  backendIdOrSessionKey: string,
  sessionKeyOrReport: string,
  maybeReport?: string,
): void {
  const backendId = maybeReport === undefined ? "" : backendIdOrSessionKey;
  const sessionKey = maybeReport === undefined ? backendIdOrSessionKey : sessionKeyOrReport;
  const report = maybeReport === undefined ? sessionKeyOrReport : maybeReport;
  // 先在同一 JS 上下文中封锁本次目标；只有新 payload 确认写入后才解锁。
  // 这样 remove/set 的瞬态失败恢复后，consume 也不会误取旧同-session 正文。
  suppressedHandoffKey = handoffKey(backendId, sessionKey);
  try {
    // 必须先清理旧值；后续写失败时只能降级为无引用，不能复用旧报告。
    sessionStorage.removeItem(CRON_CHAT_HANDOFF_KEY);
  } catch {
    return;
  }
  if (!sessionKey.trim() || !report.trim()) return;
  try {
    sessionStorage.setItem(
      CRON_CHAT_HANDOFF_KEY,
      JSON.stringify({ ...(backendId ? { backendId } : {}), sessionKey, report }),
    );
    suppressedHandoffKey = null;
  } catch {
    try { sessionStorage.removeItem(CRON_CHAT_HANDOFF_KEY); } catch { /* ignore */ }
  }
}

export function consumeCronChatHandoff(backendId: string, expectedSessionKey: string): CronChatHandoff | null;
/** @deprecated Pass backendId as the first argument. */
export function consumeCronChatHandoff(expectedSessionKey: string): CronChatHandoff | null;
export function consumeCronChatHandoff(
  backendIdOrSessionKey: string,
  maybeSessionKey?: string,
): CronChatHandoff | null {
  const backendId = maybeSessionKey === undefined ? "" : backendIdOrSessionKey;
  const expectedSessionKey = maybeSessionKey === undefined ? backendIdOrSessionKey : maybeSessionKey;
  if (suppressedHandoffKey === handoffKey(backendId, expectedSessionKey)) {
    try {
      sessionStorage.removeItem(CRON_CHAT_HANDOFF_KEY);
      suppressedHandoffKey = null;
    } catch {
      // 保持封锁，后续导航仍不得消费无法确认新旧的 payload。
    }
    return null;
  }

  let raw: string | null;
  try {
    raw = sessionStorage.getItem(CRON_CHAT_HANDOFF_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  // remove 成功是应用 payload 的前置条件，保证 StrictMode 重放也无法重复消费。
  try {
    sessionStorage.removeItem(CRON_CHAT_HANDOFF_KEY);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const payload = parsed as Record<string, unknown>;
  if (typeof payload.sessionKey !== "string" || typeof payload.report !== "string") return null;
  if (!payload.sessionKey.trim() || !payload.report.trim()) return null;
  const payloadBackendId = typeof payload.backendId === "string" ? payload.backendId : "";
  if (payloadBackendId !== backendId) return null;
  if (payload.sessionKey !== expectedSessionKey) return null;
  return { ...(payloadBackendId ? { backendId: payloadBackendId } : {}), sessionKey: payload.sessionKey, report: payload.report };
}

export function selectCronRunHandoffSource(
  openRun: CronRunHandoffInput | null,
  delivery: CronDeliveryHandoffInput | null,
): CronRunHandoffSource {
  if (!openRun) return { sessionKey: null, report: null, isFullText: false };
  const exactDelivery =
    typeof openRun.startedAt === "number" &&
    typeof delivery?.startedAt === "number" &&
    openRun.startedAt === delivery.startedAt
      ? delivery
      : null;
  const fullText = firstNonBlankText(exactDelivery?.fullText);
  return {
    sessionKey: canonicalCronSessionKey(
      openRun.agentId,
      exactDelivery?.sessionKey || openRun.sessionKey,
    ),
    report: fullText ?? firstNonBlankText(exactDelivery?.summary, openRun.summary),
    isFullText: fullText !== null,
  };
}
