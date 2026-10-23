"use strict";

// Ownership and tamper checks re-read private files on every call. Active
// Memory reaches them thousands of times in one synchronous stretch, which
// blocked the shared Service loop for seconds (2026-10-20). Another process can
// only be observed between event-loop turns, so a turn reuses one result.
// Callers put every in-process state the check depends on into the key; their
// own writes change the key (or clear the memo) and rerun the check.
let turn = 0, scheduled = false;
function currentTurn() {
  if (!scheduled) {
    scheduled = true;
    setImmediate(() => { turn += 1; scheduled = false; }).unref();
  }
  return turn;
}

class TurnMemo {
  constructor() { this.turn = -1; this.entries = new Map(); }
  // A failed check is never reused: the next call checks again.
  get(key, compute) {
    const current = currentTurn();
    if (this.turn !== current) { this.turn = current; this.entries.clear(); }
    if (this.entries.has(key)) return this.entries.get(key);
    const value = compute();
    this.entries.set(key, value);
    return value;
  }
  clear() { this.entries.clear(); }
}

const statements = new WeakMap();
// Commits by other connections (data_version), rows changed by this connection
// (total_changes) and schema changes. Equal stamps mean an unchanged database.
function databaseChangeStamp(db) {
  let prepared = statements.get(db);
  if (!prepared) {
    prepared = [db.prepare("PRAGMA data_version"), db.prepare("PRAGMA schema_version"),
      db.prepare("SELECT total_changes() AS changes")];
    statements.set(db, prepared);
  }
  return prepared.map(statement => Object.values(statement.get()).join()).join(":");
}

module.exports = { TurnMemo, databaseChangeStamp };
