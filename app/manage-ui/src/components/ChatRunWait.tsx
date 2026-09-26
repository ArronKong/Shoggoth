import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "./ChatRunWait.css";

export type ChatRunWaitState = { kind: "queued" | "retrying"; reason: string | null; since: number };

const REASONS: Record<string, string> = {
  RUNTIME_ACCOUNT_ACTIVE_LIMIT: "account",
  RUNTIME_ACCOUNT_BACKOFF: "cooldown",
  RUNTIME_ACCOUNT_MUTATION_BUSY: "accountUpdating",
  CHAT_SESSION_BUSY: "session",
  WORKSPACE_WRITE_BUSY: "workspace",
  PROFILE_ACTIVE_LIMIT: "agent",
  PROFILE_WORKSPACE_WRITE_LIMIT: "agent",
  BACKEND_ACTIVE_LIMIT: "backend",
  BACKEND_BACKGROUND_ACTIVE_LIMIT: "backendBackground",
  // Persisted events from the previous shared-budget policy remain readable.
  GLOBAL_ACTIVE_LIMIT: "global",
  BACKGROUND_ACTIVE_LIMIT: "background",
};

export function chatRunWaitState(payload: { statusKind?: unknown; reason?: unknown; queuedAt?: unknown }, now = Date.now()): ChatRunWaitState | null {
  if (payload.statusKind === "retrying") {
    return { kind: "retrying", reason: payload.reason === "RUNTIME_RATE_LIMITED" ? payload.reason : null, since: now };
  }
  // 连接阶段沿用聊天等待动画，状态行只展示排队原因和时长。
  if (payload.statusKind !== "queued") return null;
  return { kind: "queued",
    reason: typeof payload.reason === "string" && Object.hasOwn(REASONS, payload.reason) ? payload.reason : null,
    since: typeof payload.queuedAt === "number" && Number.isSafeInteger(payload.queuedAt) && payload.queuedAt >= 0
      ? Math.min(now, payload.queuedAt) : now };
}

export function ChatRunWait({ state, compact = false }: { state: ChatRunWaitState; compact?: boolean }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - state.since) / 1000));
  const duration = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  const label = t(`chat.runWait.${state.kind}`);
  const reason = state.kind === "retrying"
    ? t(`chat.runWait.${state.reason === "RUNTIME_RATE_LIMITED" ? "rateLimited" : "upstreamRetry"}`)
    : t(`chat.runWait.${state.reason ? REASONS[state.reason] : "capacity"}`);
  const details = [label, reason, duration].filter(Boolean).join(" · ");
  return <span className={`chat-run-wait${compact ? " is-compact" : ""}`} data-testid="chat-run-wait" role="status"
    data-kind={state.kind} title={details}>
    {compact ? `${label} · ${duration}` : details}
  </span>;
}
