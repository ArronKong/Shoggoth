"use strict";

// A compact RPC acknowledgement is only acceptance. Observe the same session's
// post-dispatch notification before claiming that native compaction completed.
function startManualCompaction({ host, sessionId, signal, timeoutMs, dispatch, onAccepted }) {
  let resolve;
  let settled = false;
  let acknowledged = false;
  let observed = false;
  let observedTurnId = null;
  const terminalTurns = new Map();
  let issued = false;
  let unsubscribe = () => {};
  let timer;
  const promise = new Promise(done => { resolve = done; });
  const finish = outcome => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    unsubscribe();
    signal?.removeEventListener("abort", onAbort);
    resolve(outcome);
  };
  const settleObserved = () => {
    if (!acknowledged || !observed) return;
    // New Codex compaction items finish before their native turn releases its
    // execution slot. Keep the session reserved through that same turn's end.
    if (observedTurnId === null) { finish("completed"); return; }
    const terminal = terminalTurns.get(observedTurnId);
    if (terminal) finish(terminal === "completed" ? "completed" : "unknown");
  };
  const onAbort = () => finish("closing");
  unsubscribe = host.subscribe(event => {
    if (!issued || event?.known !== true || event.sessionId !== sessionId) return;
    if (event.type === "context_compacted") {
      observed = true;
      if (observedTurnId === null && typeof event.turnId === "string" && event.turnId.length > 0) {
        observedTurnId = event.turnId;
      }
    } else if (event.type === "complete" && typeof event.turnId === "string"
      && ["completed", "failed", "interrupted", "canceled"].includes(event.status)) {
      terminalTurns.set(event.turnId, event.status);
      if (terminalTurns.size > 64) terminalTurns.delete(terminalTurns.keys().next().value);
    } else return;
    settleObserved();
  });
  timer = setTimeout(() => finish("timeout"), timeoutMs);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  if (host.terminated && typeof host.terminated.then === "function") {
    host.terminated.then(() => finish("unknown"), () => finish("unknown"));
  }
  Promise.resolve().then(() => {
    if (settled) return;
    issued = true;
    return dispatch();
  }).then(() => {
    if (settled) return;
    acknowledged = true;
    try { onAccepted(); } catch { finish("unknown"); return; }
    settleObserved();
  }, () => finish("unknown"));
  return { promise, cancel: () => finish("canceled") };
}

module.exports = { startManualCompaction };
