"use strict";

const { sha256 } = require("./migration.cjs");

const NAMESPACE = "active-memory-diagnostics";
const MAX_ENTRIES = 50;
const CODE = /^[A-Z][A-Z0-9_]{0,95}$/u;
const NAME = /^[a-z][a-z0-9-]{0,31}$/u;

function diagnosticCode(error) {
  if (typeof error?.code === "string" && CODE.test(error.code)) return error.code;
  // Deadlines and cancellation arrive as DOMExceptions without a string code.
  if (error?.name === "TimeoutError") return "TIMEOUT";
  if (error?.name === "AbortError") return "ABORTED";
  return "UNCLASSIFIED";
}

// Why one automatic recall did not deliver memory. Only enumerated stage and
// outcome names, error codes and timings are kept, never queries, snippets or
// provider messages. Recording is best effort: a failed write cannot change
// the recall result or delay its cleanup.
function recallDiagnostics({ host, runId, now }) {
  const started = now(), runKey = sha256(String(runId)).slice(0, 16);
  let sequence = 0, store = null;
  return ({ stage, outcome, code = null }) => {
    try {
      if (!NAME.test(stage) || !NAME.test(outcome) || code !== null && !CODE.test(code)) return;
      store ||= host.database.openKeyedStore({ namespace: NAMESPACE, maxEntries: MAX_ENTRIES });
      const at = now();
      store.register(`${runKey}:${++sequence}`, { at, runKey, stage, outcome, code, elapsedMs: Math.max(0, at - started) }).catch(() => {});
    } catch { /* best effort */ }
  };
}

module.exports = { recallDiagnostics, diagnosticCode, ACTIVE_MEMORY_DIAGNOSTICS_NAMESPACE: NAMESPACE };
