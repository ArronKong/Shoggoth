// Keep telemetry links separate so older builds can still read the send fence.
export const PENDING_CHAT_TELEMETRY_KEY = "shoggoth.chat.pending-send-telemetry.v1";

export function clearPendingChatTelemetry() {
  try { window.localStorage.removeItem(PENDING_CHAT_TELEMETRY_KEY); }
  catch { /* storage may be unavailable */ }
}
