"use strict";

const path = require("node:path");
const crypto = require("node:crypto");
const { openDatabase, transaction } = require("../inspiration-database");
const { preparePrivateParent } = require("../private-file");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_state (
  namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT, created_at INTEGER NOT NULL,
  expires_at INTEGER, version INTEGER NOT NULL, PRIMARY KEY(namespace,key)
) STRICT;
CREATE TABLE IF NOT EXISTS memory_clock (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL) STRICT;
INSERT OR IGNORE INTO memory_clock VALUES (1,0);
CREATE TABLE IF NOT EXISTS memory_entry_origins (
  entry_key TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, session_key TEXT,
  origin_class TEXT NOT NULL CHECK(origin_class IN ('owner','agent','untrusted','system')),
  observed_at INTEGER NOT NULL, PRIMARY KEY(entry_key,agent_id,session_id)
) STRICT;
CREATE TABLE IF NOT EXISTS memory_session_tombstones (
  session_id TEXT NOT NULL, agent_id TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(session_id)
) STRICT;
CREATE TABLE IF NOT EXISTS memory_host_events (
  sequence INTEGER PRIMARY KEY, workspace TEXT NOT NULL, time INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
) STRICT;
CREATE TABLE IF NOT EXISTS memory_promotion_sources (
  state_key TEXT PRIMARY KEY, path TEXT NOT NULL, start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL, source_hash TEXT NOT NULL
) STRICT;
`;

const MAX_VALUE_BYTES = 4 * 1024 * 1024;
function validateKey(value) {
  if (typeof value !== "string" || !value || !value.isWellFormed() || value.includes("\0") || Buffer.byteLength(value) > 4096) {
    throw new TypeError("Invalid memory state key");
  }
  return value;
}

class MemoryDatabase {
  constructor({ paths, now = Date.now, databasePath } = {}) {
    this.paths = paths;
    this.path = databasePath || path.join(paths.stateDir, "shoggoth-memory.sqlite");
    this.now = now;
    this.db = null;
    this.identity = crypto.randomUUID();
  }

  open() {
    if (this.db) return;
    preparePrivateParent(this.path, this.paths.trustedRoot);
    const db = openDatabase(this.path);
    try { db.exec(SCHEMA); this.db = db; }
    catch (error) { db.close(); throw error; }
  }

  assertOpen() { if (!this.db) throw new Error("Memory database is closed"); }
  close() { if (this.db) { this.db.close(); this.db = null; } }
  transact(action, assertCurrent = () => {}) {
    this.assertOpen();
    return transaction(this.db, () => {
      assertCurrent();
      const result = action();
      if (result && typeof result.then === "function") throw new TypeError("Memory transaction must be synchronous");
      assertCurrent();
      return result;
    });
  }

  openKeyedStore({ namespace, maxEntries, defaultTtlMs, overflowPolicy = "evict-oldest" }, assertCurrent = () => {}, onValueSet = null) {
    validateKey(namespace);
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError("Memory state requires a bounded namespace");
    const owner = this;
    const check = key => { owner.assertOpen(); assertCurrent(); if (key !== undefined) validateKey(key); };
    const rowFor = key => owner.db.prepare("SELECT * FROM memory_state WHERE namespace=? AND key=?").get(namespace, key);
    const live = row => row?.value !== null && row?.value !== undefined && (row.expires_at === null || row.expires_at > owner.now());
    const valueFor = row => live(row) ? JSON.parse(row.value) : undefined;
    const observe = key => {
      const row = rowFor(key);
      return { value: valueFor(row), comparison: JSON.stringify([owner.identity, namespace, key, row?.version ?? 0, live(row)]) };
    };
    const version = () => Number(owner.db.prepare("UPDATE memory_clock SET version=version+1 WHERE id=1 RETURNING version").get().version);
    const remove = key => {
      const row = rowFor(key);
      if (!live(row)) return false;
      owner.db.prepare("UPDATE memory_state SET value=NULL,expires_at=NULL,version=? WHERE namespace=? AND key=?")
        .run(version(), namespace, key);
      return true;
    };
    const set = (key, value, opts = {}) => {
      const encoded = JSON.stringify(value);
      if (encoded === undefined || Buffer.byteLength(encoded) > MAX_VALUE_BYTES) throw new TypeError("Memory state value is missing or too large");
      const now = owner.now();
      const ttl = opts.ttlMs ?? defaultTtlMs;
      if (ttl !== undefined && (!Number.isSafeInteger(ttl) || ttl < 0 || !Number.isSafeInteger(now + ttl))) throw new TypeError("Invalid memory state TTL");
      const existing = rowFor(key);
      if (!live(existing)) {
        const count = Number(owner.db.prepare("SELECT count(*) AS count FROM memory_state WHERE namespace=? AND value IS NOT NULL AND (expires_at IS NULL OR expires_at>?)").get(namespace, now).count);
        if (count >= maxEntries) {
          if (overflowPolicy === "reject-new") throw new Error("Memory state namespace capacity exceeded");
          const victims = owner.db.prepare("SELECT key FROM memory_state WHERE namespace=? AND value IS NOT NULL AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at,key LIMIT ?")
            .all(namespace, now, count - maxEntries + 1);
          for (const victim of victims) remove(victim.key);
        }
      }
      owner.db.prepare(`INSERT INTO memory_state VALUES (?,?,?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET
        value=excluded.value,created_at=excluded.created_at,expires_at=excluded.expires_at,version=excluded.version`)
        .run(namespace, key, encoded, live(existing) ? existing.created_at : now, ttl === undefined ? null : now + ttl, version());
      onValueSet?.(key, value);
    };
    const entries = range => {
      check();
      const values = [namespace, owner.now()];
      let where = "namespace=? AND value IS NOT NULL AND (expires_at IS NULL OR expires_at>?)";
      if (range) {
        validateKey(range.keyStartInclusive); validateKey(range.keyEndExclusive);
        if (!Number.isSafeInteger(range.limit) || range.limit < 0) throw new TypeError("Invalid memory state range limit");
        where += " AND key>=? AND key<?"; values.push(range.keyStartInclusive, range.keyEndExclusive);
      }
      const order = range ? `key ${range.order === "desc" ? "DESC" : "ASC"}` : "created_at,key";
      const rows = owner.db.prepare(`SELECT * FROM memory_state WHERE ${where} ORDER BY ${order}${range ? " LIMIT ?" : ""}`).all(...values, ...(range ? [range.limit] : []));
      assertCurrent();
      return rows.map(row => ({ key: row.key, value: JSON.parse(row.value), createdAt: row.created_at, ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }) }));
    };
    const store = {
      async observe(key) { check(key); return observe(key); },
      async compareAndApply(key, comparison, intent) {
        check(key);
        if (!(intent?.operation === "update" && ["set", "keep"].includes(intent.action)) && !(intent?.operation === "delete" && ["delete", "keep"].includes(intent.action))) throw new TypeError("Invalid memory comparison intent");
        return owner.transact(() => {
          const current = observe(key);
          if (current.comparison !== comparison) return { status: "conflict", current };
          if (intent.action === "keep") return { status: "unchanged" };
          if (intent.action === "set") set(key, intent.value, intent);
          else if (!remove(key)) return { status: "unchanged" };
          return { status: "applied" };
        }, assertCurrent);
      },
      async register(key, value, opts = {}) { check(key); owner.transact(() => { opts.assertCurrent?.(); set(key, value, opts); opts.assertCurrent?.(); }, assertCurrent); },
      async registerIfAbsent(key, value, opts) { check(key); return owner.transact(() => { if (live(rowFor(key))) return false; set(key, value, opts); return true; }, assertCurrent); },
      async lookup(key) { check(key); return valueFor(rowFor(key)); },
      async lookupMany(keys) { return Promise.all(keys.map(async key => ({ ok: true, value: await store.lookup(key) }))); },
      async consume(key) { check(key); return owner.transact(() => { const value = valueFor(rowFor(key)); remove(key); return value; }, assertCurrent); },
      async delete(key, opts = {}) { check(key); return owner.transact(() => { opts.assertCurrent?.(); const result = remove(key); opts.assertCurrent?.(); return result; }, assertCurrent); },
      async update(key, update, opts) { check(key); return owner.transact(() => { const value = update(valueFor(rowFor(key))); if (value === undefined) return false; set(key, value, opts); return true; }, assertCurrent); },
      async deleteIf(key, predicate) { check(key); return owner.transact(() => { const value = valueFor(rowFor(key)); return value !== undefined && predicate(value) ? remove(key) : false; }, assertCurrent); },
      async deleteIfEqual(key, expected) { return store.deleteIf(key, value => value === expected); },
      async entries() { return entries(); },
      async entriesInKeyRange(range) { return entries(range); },
      async count() { return entries().length; },
      async clear() { check(); owner.transact(() => { for (const row of entries()) remove(row.key); }, assertCurrent); },
      withCurrent({ assertCurrent: bound }) { return owner.openKeyedStore({ namespace, maxEntries, defaultTtlMs, overflowPolicy }, () => { assertCurrent(); bound(); }, onValueSet); },
    };
    return store;
  }

  origins(agentId, { entryKeys, sessionIds } = {}) {
    this.assertOpen();
    const rows = this.db.prepare("SELECT * FROM memory_entry_origins WHERE agent_id=? ORDER BY entry_key,session_id").all(agentId);
    const keys = entryKeys && new Set(entryKeys), sessions = sessionIds && new Set(sessionIds);
    return rows.filter(row => (!keys || keys.has(row.entry_key)) && (!sessions || sessions.has(row.session_id)))
      .map(row => ({ entryKey: row.entry_key, agentId: row.agent_id, sessionId: row.session_id, sessionKey: row.session_key, originClass: row.origin_class, observedAt: row.observed_at }));
  }

  originCommand(command, assertCurrent) {
    return this.transact(() => {
      const input = command.input;
      if (command.type === "record") {
        const added = [];
        for (const origin of input.origins) {
          if (origin.agentId !== input.agentId) throw new Error("Memory origin belongs to another Profile");
          const value = { ...origin, entryKey: input.entryKey ?? origin.entryKey, sessionKey: origin.sessionKey ?? null };
          const result = this.db.prepare("INSERT OR IGNORE INTO memory_entry_origins VALUES (?,?,?,?,?,?)")
            .run(value.entryKey, value.agentId, value.sessionId, value.sessionKey, value.originClass, value.observedAt);
          if (result.changes) added.push(value);
        }
        return added;
      }
      if (command.type === "delete") {
        const origins = this.origins(input.agentId, input);
        const statement = this.db.prepare("DELETE FROM memory_entry_origins WHERE entry_key=? AND agent_id=? AND session_id=?");
        for (const origin of origins) statement.run(origin.entryKey, origin.agentId, origin.sessionId);
        return origins.length;
      }
      throw new Error(`Unsupported memory origin command: ${command.type}`);
    }, assertCurrent);
  }

  tombstones(agentId, sessionIds) {
    this.assertOpen();
    const allowed = sessionIds && new Set(sessionIds);
    return this.db.prepare("SELECT * FROM memory_session_tombstones WHERE agent_id=? ORDER BY session_id").all(agentId)
      .filter(row => !allowed || allowed.has(row.session_id))
      .map(row => ({ agentId: row.agent_id, sessionId: row.session_id, reason: row.reason, createdAt: row.created_at }));
  }
}

module.exports = { MemoryDatabase };
