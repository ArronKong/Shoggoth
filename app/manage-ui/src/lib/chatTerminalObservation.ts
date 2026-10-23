type Frame = { type?: string; event?: string; payload?: Record<string, any> };

// Native gateways can publish a persisted terminal snapshot without a chat
// final/error (for example an abort before a final answer). Only the observed
// run may end this session's generation UI; a retryable lifecycle error is not
// terminal proof, and an abort request/ACK is not execution proof.
export function observedChatTerminal(frame: Frame, observedRunId: string | undefined) {
  const p = frame.payload;
  if (frame.type !== "event" || !p || typeof p.sessionKey !== "string"
    || !observedRunId || typeof p.runId !== "string"
    || ![p.runId, p.clientRunId].includes(observedRunId)) return null;
  let state: "aborted" | "error" | "idle";
  if (frame.event === "agent" && p.stream === "lifecycle") {
    if (!["end", "error"].includes(p.data?.phase)
      || !(p.data?.aborted === true || p.data?.stopReason === "aborted")) return null;
    state = "aborted";
  } else if (frame.event === "sessions.changed") {
    const session = p.session;
    if (!["end", "error"].includes(p.phase) || session?.hasActiveRun !== false
      || ![p.runId, p.clientRunId].includes(session?.lastRunId)) return null;
    if (["killed", "canceled", "cancelled", "interrupted"].includes(session.status)) state = "aborted";
    else if (["failed", "timeout"].includes(session.status)) state = "error";
    else if (["idle", "completed", "ok"].includes(session.status)) state = "idle";
    else return null;
  } else return null;
  return { type: "event", event: "chat", payload: {
    sessionKey: p.sessionKey,
    runId: typeof p.clientRunId === "string" ? p.clientRunId : p.runId,
    state: state === "idle" ? "status" : state,
    ...(state === "idle" ? { statusKind: "idle" } : {}),
    ...(typeof p.agentId === "string" ? { agentId: p.agentId } : {}),
    ...(typeof p.backendId === "string" ? { backendId: p.backendId } : {}),
    ...(typeof p.data?.error === "string" ? { errorMessage: p.data.error }
      : typeof p.session?.lastRunError === "string" ? { errorMessage: p.session.lastRunError } : {}),
  } };
}
