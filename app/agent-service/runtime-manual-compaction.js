"use strict";

// A compact RPC acknowledgement is only acceptance. Observe the same session's
// post-dispatch notification before claiming that native compaction completed.
function startManualCompaction({ host, sessionId, signal, timeoutMs, dispatch, onAccepted }) {
  let resolve;
  let settled = false;
  let acknowledged = false;
  let observed = false;
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
  const onAbort = () => finish("closing");
  unsubscribe = host.subscribe(event => {
    if (!issued || event?.known !== true || event.sessionId !== sessionId
      || !["context_compacted", "context_usage"].includes(event.type)) return;
    observed = true;
    if (acknowledged) finish("completed");
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
    if (observed) finish("completed");
  }, () => finish("unknown"));
  return { promise, cancel: () => finish("canceled") };
}

module.exports = { startManualCompaction };
