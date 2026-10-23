"use strict";

// Execution processes are per Run, while the durable session catalog remains
// per workspace. Share its single writer for as long as any matching host lives.
function poolLedgerSlot(pool, ledgerKey) {
  const existing = [...pool.entries.values()].find(entry => entry.ledgerKey === ledgerKey);
  return existing?.ledgerSlot || { promise: null };
}

function openRuntimeLedger(slot, create) {
  if (!slot.promise) slot.promise = Promise.resolve().then(create);
  return slot.promise;
}

// A dead execution process must not hide an already committed terminal. This
// is observation only: never open a ledger, resume work, or contact the CLI.
// Uncertain writes leave the old in-progress snapshot, which cannot pass here.
function settledRuntimeSession(host, sessionId) {
  if (!["failed", "stopping", "stopped"].includes(host.state) || !host.ledger
    || typeof sessionId !== "string") return null;
  const session = host.ledger.snapshot().sessions.find(item => item.id === sessionId);
  if (!session || !session.turns.every(turn => (
    ["accepted", "failed"].includes(turn.acceptance)
    && ["completed", "failed", "interrupted", "canceled"].includes(turn.status)
    && !["RUNTIME_TURN_ACCEPTANCE_UNKNOWN", "RUNTIME_TURN_OUTCOME_UNKNOWN"].includes(turn.errorCode)
  ))) return null;
  return session;
}

module.exports = { poolLedgerSlot, openRuntimeLedger, settledRuntimeSession };
