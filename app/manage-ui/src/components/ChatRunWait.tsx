import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "./ChatRunWait.css";

import type { ChatRunWaitState } from "../lib/chatRunWait";
export { chatRunWaitState, updateChatRunWait, type ChatRunWaitState } from "../lib/chatRunWait";

export function ChatRunWait({ state, compact = false }: { state: ChatRunWaitState; compact?: boolean }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (state.kind === "queued") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state.kind]);
  if (state.kind === "queued") return null;
  const elapsed = Math.max(0, Math.floor((now - state.since) / 1000));
  const duration = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  const label = t(`chat.runWait.${state.kind === "starting" ? "thinking" : state.kind}`);
  const reason = state.kind === "starting" ? ""
    : t(`chat.runWait.${state.reason === "RUNTIME_RATE_LIMITED" ? "rateLimited" : state.reason === "RUNTIME_UPSTREAM_UNAVAILABLE" ? "upstreamUnavailable" : "upstreamRetry"}`);
  const description = [label, reason].filter(Boolean).join(" · ");
  const showElapsed = state.kind !== "starting" || elapsed >= 3;
  const elapsedLabel = state.kind === "starting" ? t(`chat.runWait.${elapsed < 60 ? "seconds" : "minutes"}`, { count: elapsed < 60 ? elapsed : Math.floor(elapsed / 60) }) : duration;
  const details = [description, showElapsed ? elapsedLabel : ""].filter(Boolean).join(" · ");
  return <span className={`chat-run-wait${compact ? " is-compact" : ""}`} data-testid="chat-run-wait" role="status"
    data-kind={state.kind} data-stage={state.stage} title={details}>
    {compact ? label : description}{showElapsed && <span aria-hidden="true"> · {elapsedLabel}</span>}
  </span>;
}
