"use strict";

// Ordinary chat.send has no plugin-selection receipt. Observe the original
// operation through the same authenticated Host, without ever resending it.
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const unresolved = () => ({ status: "unresolved", run: null, canReconcile: false });
const found = (sessionKey, runId, status) => ({
  status: "found", stateAuthority: "openclaw", admissionAccepted: true,
  run: { id: runId, sessionKey, status, admissionAccepted: true },
});

function belongsToRun(message, runId) {
  return message?.__openclaw?.runId === runId || message?.runId === runId
    || (message?.role === "user" && [message.idempotencyKey, message.__openclaw?.idempotencyKey]
      .includes(`${runId}:user`));
}

async function getOpenClawChatOperation(sessionKey, runId, { requestHost }) {
  if (typeof sessionKey !== "string" || !sessionKey.startsWith("agent:") || sessionKey.length > 256
    || typeof runId !== "string" || !ID.test(runId)) return unresolved();
  let offset, source, activity, lastRunMessage, linked = false;
  // A bounded backwards scan finds old pending records without downloading full
  // conversation bodies. Exhaustion is uncertainty, never proof of non-admission.
  for (let page = 0; page < 6; page += 1) {
    const history = await requestHost("chat.history", {
      sessionKey, limit: 100, maxChars: 128, maxBytes: 65536, ...(offset === undefined ? {} : { offset }),
    });
    if (history?.sessionKey !== sessionKey || !Array.isArray(history.messages)) return unresolved();
    if (page > 0 && (!source || history.sessionId !== source)) return unresolved();
    if (page === 0) {
      source = history.sessionId;
      const info = history.sessionInfo;
      const ids = Array.isArray(info?.activeRunIds) && info.activeRunIds.every(id => typeof id === "string")
        ? info.activeRunIds : null;
      const active = ids?.includes(runId) || history.inFlightRun?.runId === runId;
      activity = active ? "active" : info?.hasActiveRun === false && (!ids || ids.length === 0)
        && !history.inFlightRun ? "inactive" : "unknown";
      linked = !!active;
    }
    const matches = history.messages.filter(message => belongsToRun(message, runId));
    if (matches.length) {
      linked = true;
      lastRunMessage = matches.at(-1);
      break;
    }
    if (linked || history.hasMore !== true || !Number.isSafeInteger(history.nextOffset)
      || history.nextOffset <= (offset ?? 0)) break;
    offset = history.nextOffset;
  }
  // agent.wait does not include a session key. Corroborate membership first so
  // a same-id result from another session cannot release this pending record.
  if (!linked) return unresolved();
  const wait = await requestHost("agent.wait", { runId, timeoutMs: 0 });
  if (wait?.runId !== runId) return unresolved();
  const ended = Number.isFinite(wait.endedAt) && wait.endedAt > 0;
  const terminal = ended && ["ok", "error", "timeout"].includes(wait.status);
  if (activity === "active") {
    if (terminal) return unresolved(); // Conflicting Host evidence must converge.
    return found(sessionKey, runId, wait.status === "pending" ? "queued" : "running");
  }
  if (terminal) return found(sessionKey, runId, wait.status === "ok" ? "completed"
    : wait.stopReason === "aborted" ? "canceled" : "failed");
  // An immediate wait timeout also means its short-lived terminal cache expired.
  // Only a final assistant record for THIS run plus an idle Host proves finish.
  if (activity === "inactive" && wait.status === "timeout" && !ended && lastRunMessage?.role === "assistant") {
    const status = { stop: "completed", error: "failed", aborted: "canceled" }[lastRunMessage.stopReason];
    if (typeof status === "string") return found(sessionKey, runId, status);
  }
  return unresolved();
}

module.exports = { getOpenClawChatOperation };
