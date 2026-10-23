"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("../security");

const NAMESPACE = "active-memory-runtime";
const STATUS_NAMESPACE = "active-memory-status";
const RECOVERY_NAMESPACE = "active-memory-recovery";
const MAX_TRANSCRIPT_BYTES = 96 * 1024;
const MAX_RECOVERY_ROWS = 10_000;
const lifetimes = new WeakMap();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const object = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const pending = () => serviceError("MEMORY_ACTIVE_RECOVERY_PENDING", "自动召回临时记录未完成归属核验");

function isOwnedScratch(row, profileId, databasePath) {
  if (typeof row.value !== "string") return false;
  let record;
  try { record = JSON.parse(row.value); } catch { return false; }
  if (!object(record, ["owner", "sessionKey", "entry", "events"]) || !uuid.test(record.owner)
    || typeof record.sessionKey !== "string" || record.sessionKey.includes("\0") || !record.sessionKey.isWellFormed()
    || !/^.{1,4096}:active-memory:[a-f0-9]{12}$/u.test(record.sessionKey)
    || crypto.createHash("sha256").update(record.sessionKey).digest("hex") !== row.key
    || !object(record.entry, ["pluginOwnerId", "sessionId", "sessionFile", "updatedAt"])
    || record.entry.pluginOwnerId !== "active-memory"
    || !/^active-memory-[a-z0-9]+-[a-f0-9]{8}$/u.test(record.entry.sessionId)
    || !Number.isSafeInteger(record.entry.updatedAt) || record.entry.updatedAt < 0
    || record.entry.sessionFile !== `sqlite:${profileId}:${record.entry.sessionId}:${databasePath}`
    || !Array.isArray(record.events) || record.events.some(event => !object(event, ["type", "runId", "message"])
      || event.type !== "message" || event.runId !== record.entry.sessionId
      || !["assistant", "toolResult"].includes(event.message?.role))) return false;
  const parent = record.sessionKey.slice(0, record.sessionKey.lastIndexOf(":active-memory:"));
  return parent.startsWith(`agent:${profileId}:`) || uuid.test(parent);
}

// Called only while opening a Profile database under the Service's exclusive
// owner lock, before publishing its host. This is Product scratch recovery,
// not an alternative implementation of upstream recall cleanup or a replay.
function recoverActiveMemorySessions(database, profileId) {
  database.assertOpen();
  const lifetime = lifetimes.get(database);
  if (lifetime?.recovery) {
    if (lifetime.recovery.profileId !== profileId) throw pending();
    return lifetime.recovery;
  }
  if (lifetime?.active) throw pending();
  const result = database.transact(() => {
    let scanned = 0, recovered = 0, lastKey = null;
    const nextVersion = () => Number(database.db.prepare("UPDATE memory_clock SET version=version+1 WHERE id=1 RETURNING version").get().version);
    while (scanned < MAX_RECOVERY_ROWS) {
      // Do not deserialize oversized or corrupt records. Preserve them for
      // inspection; a bounded scan must never become permission to delete.
      const rows = database.db.prepare(`SELECT key,version,
        CASE WHEN length(CAST(value AS BLOB))<=? THEN value ELSE NULL END AS value
        FROM memory_state WHERE namespace=? AND value IS NOT NULL AND (? IS NULL OR key>?)
        ORDER BY key LIMIT ?`).all(MAX_TRANSCRIPT_BYTES, NAMESPACE, lastKey, lastKey, Math.min(64, MAX_RECOVERY_ROWS - scanned));
      if (!rows.length) break;
      for (const row of rows) {
        lastKey = row.key; scanned++;
        if (!isOwnedScratch(row, profileId, database.path)) continue;
        const changed = database.db.prepare("UPDATE memory_state SET value=NULL,expires_at=NULL,version=? WHERE namespace=? AND key=? AND version=?")
          .run(nextVersion(), NAMESPACE, row.key, row.version);
        if (changed.changes !== 1) throw pending();
        recovered++;
      }
    }
    const unresolved = Number(database.db.prepare("SELECT count(*) AS n FROM memory_state WHERE namespace=? AND value IS NOT NULL").get(NAMESPACE).n);
    // No prior lifetime can still hold a valid comparison token. Bound empty
    // scratch keys as well, without touching any other keyed namespace.
    const pruned = Number(database.db.prepare("DELETE FROM memory_state WHERE namespace=? AND value IS NULL").run(NAMESPACE).changes);
    const receipt = { version: 1, profileId, recovered, unresolved, scanned, pruned, at: database.now() };
    database.db.prepare(`INSERT INTO memory_state VALUES (?,?,?,?,NULL,?) ON CONFLICT(namespace,key) DO UPDATE SET
      value=excluded.value,created_at=excluded.created_at,expires_at=NULL,version=excluded.version`)
      .run(RECOVERY_NAMESPACE, "latest", JSON.stringify(receipt), receipt.at, nextVersion());
    return Object.freeze(receipt);
  });
  lifetimes.set(database, { recovery: result });
  return result;
}

function beginActiveMemoryRuntime(database) {
  const lifetime = lifetimes.get(database) || {};
  if (lifetime.recovery?.unresolved > 0) throw pending();
  lifetime.active = true; lifetimes.set(database, lifetime);
}

module.exports = { NAMESPACE, STATUS_NAMESPACE, RECOVERY_NAMESPACE, MAX_TRANSCRIPT_BYTES,
  recoverActiveMemorySessions, beginActiveMemoryRuntime };
