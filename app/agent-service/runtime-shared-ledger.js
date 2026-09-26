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

module.exports = { poolLedgerSlot, openRuntimeLedger };
