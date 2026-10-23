"use strict";

const path = require("node:path");
const crypto = require("node:crypto");
const { openDatabase, transaction } = require("./inspiration-database");
const { preparePrivateParent, fsyncPrivateParent } = require("./private-file");
const { acquirePrivateWriterLease } = require("./private-writer-lease");
const { computeNextOccurrence } = require("./native-cron-store");
const { at, id, text, scratchText, exact, fail, digest, defaultConfig, monitorId, validateConfig, validateOccurrence, validateNotice, validateNote, validateTarget, validateMonitor, historyCursor, localParts, DAY_MS, IDEA_COOLDOWN_MS } = require("./proactive-service-protocol");

const SCHEMA = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE monitors(id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, profile_id TEXT, next_at INTEGER,
  data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX monitors_due ON monitors(enabled,next_at);
CREATE TABLE occurrences(id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, scheduled_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL, state TEXT NOT NULL, run_id TEXT UNIQUE, data TEXT NOT NULL CHECK(json_valid(data)),
  UNIQUE(monitor_id,scheduled_at));
CREATE INDEX occurrences_history ON occurrences(monitor_id,created_at DESC);
CREATE INDEX occurrences_pending ON occurrences(state,created_at);
CREATE TABLE notes(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE notices(id TEXT PRIMARY KEY, occurrence_id TEXT NOT NULL UNIQUE, profile_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, app_state TEXT NOT NULL, system_state TEXT NOT NULL, daily_key TEXT UNIQUE,
  data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX notices_outbox ON notices(app_state,system_state,created_at);
CREATE TABLE events(id TEXT PRIMARY KEY, reminded_at INTEGER NOT NULL, notice_id TEXT NOT NULL);
CREATE TABLE targets(profile_id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE operations(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, fingerprint TEXT NOT NULL,
  result TEXT NOT NULL CHECK(json_valid(result)));
PRAGMA user_version=1;
`;
const clone = value => value == null ? value : structuredClone(value);
const parse = row => row ? JSON.parse(row.data) : null;
const occurrenceId = (monitorId, scheduledAt) => `occ-${digest([monitorId, scheduledAt])}`;

class ProactiveStore {
  constructor({ paths, now = Date.now, randomUUID = crypto.randomUUID, database = openDatabase }) {
    this.paths = paths; this.now = now; this.randomUUID = randomUUID; this.openDatabase = database;
    this.filePath = path.join(paths.stateDir, "proactive.sqlite"); this.db = null; this.lease = null; this.poisoned = false;
  }
  open() {
    if (this.db) return this;
    preparePrivateParent(this.filePath, this.paths.trustedRoot);
    const lease = acquirePrivateWriterLease({ lockPath: path.join(this.paths.stateDir, "proactive.writer.lock"), trustedRoot: this.paths.trustedRoot });
    try {
      this.db = this.openDatabase(this.filePath);
      const version = this.db.prepare("PRAGMA user_version").get().user_version;
      if (version !== 0 && version !== 1) fail("PROACTIVE_STORE_CORRUPT");
      if (version === 0) {
        transaction(this.db, () => this.db.exec(SCHEMA));
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); fsyncPrivateParent(this.paths.stateDir);
      }
      if (this.db.prepare("PRAGMA quick_check").get().quick_check !== "ok") fail("PROACTIVE_STORE_CORRUPT");
      this.db.exec("CREATE INDEX IF NOT EXISTS occurrences_review_day ON occurrences(json_extract(data,'$.config.profileId'),created_at) WHERE run_id IS NOT NULL");
      for (const row of this.db.prepare("SELECT * FROM monitors").all()) {
        const monitor = validateMonitor(parse(row));
        if (monitor.revision < 1 || row.id !== monitor.config.id || row.enabled !== Number(monitor.config.enabled)
          || row.profile_id !== monitor.config.profileId || row.next_at !== monitor.nextRunAt) fail("PROACTIVE_STORE_CORRUPT");
      }
      for (const [table, validate] of [["occurrences", validateOccurrence], ["notices", validateNotice], ["notes", validateNote], ["targets", validateTarget]]) {
        let cursor = "";
        const key = table === "targets" ? "profile_id" : "id";
        for (;;) {
          const rows = this.db.prepare(`SELECT *,${key} AS key FROM ${table} WHERE ${key}>? ORDER BY ${key} LIMIT 100`).all(cursor);
          for (const row of rows) {
            const value = validate(parse(row));
            if (row.key !== (table === "targets" ? value.profileId : value.id)) fail("PROACTIVE_STORE_CORRUPT");
            if (table === "occurrences" && (row.monitor_id !== value.monitorId || row.scheduled_at !== value.scheduledAt
              || row.created_at !== value.createdAt || row.state !== value.state || row.run_id !== value.runId
              || value.response && value.response.runId !== value.runId)) fail("PROACTIVE_STORE_CORRUPT");
            if (table === "notices" && (row.occurrence_id !== value.occurrenceId || row.profile_id !== value.profileId
              || row.created_at !== value.createdAt || row.app_state !== value.appState || row.system_state !== value.systemState
              || row.daily_key !== value.dayKey)) fail("PROACTIVE_STORE_CORRUPT");
          }
          if (rows.length < 100) break; cursor = rows.at(-1).key;
        }
      }
      for (const row of this.db.prepare("SELECT * FROM meta").all()) this.#validateMeta(row.key, JSON.parse(row.value));
      let operationCursor = "";
      for (;;) {
        const rows = this.db.prepare("SELECT * FROM operations WHERE id>? ORDER BY id LIMIT 100").all(operationCursor);
        for (const row of rows) {
          if (!id(row.id) || !at(row.created_at) || !/^[a-f0-9]{64}$/u.test(row.fingerprint)) fail("PROACTIVE_STORE_CORRUPT");
          const result = JSON.parse(row.result); result.config ? validateMonitor(result) : validateNote(result);
        }
        if (rows.length < 100) break; operationCursor = rows.at(-1).id;
      }
      for (const row of this.db.prepare("SELECT * FROM events").all()) {
        if (!text(row.id, 512) || !at(row.reminded_at) || !id(row.notice_id)) fail("PROACTIVE_STORE_CORRUPT");
      }
      this.lease = lease; this.poisoned = false; return this;
    } catch (error) { this.db?.close(); this.db = null; lease.release(); throw error; }
  }
  close() {
    try { if (this.db) { try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { this.db.close(); } } }
    finally { this.db = null; this.lease?.release(); this.lease = null; }
  }
  #ready() { if (!this.db || !this.lease || this.poisoned) fail("PROACTIVE_UNAVAILABLE"); }
  #validateMeta(key, value) {
    let valid = false;
    if (/^cursor:inspiration:(seed|attention|sprouted)$/u.test(key)) valid = value === null || typeof value === "string" && /^\d{1,16}:[A-Za-z0-9._:-]{1,128}$/u.test(value);
    else if (key.startsWith("cursor:fingerprint:") && id(key.slice(19))) valid = value === null || typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
    else if (key.startsWith("cursor:capability:") && id(key.slice(18))) valid = value === null || exact(value, ["policy", "fingerprint", "verifiedAt"])
      && text(value.policy, 128) && /^[a-f0-9]{64}$/u.test(value.fingerprint) && at(value.verifiedAt);
    else if (key.startsWith("cursor:heartbeat-scratch:") && id(key.slice(25))) valid = exact(value, ["revision", "content", "updatedAt"])
      && at(value.revision) && scratchText(value.content) && at(value.updatedAt);
    else if (key.startsWith("cursor:heartbeat-defaults:") && id(key.slice(26))) valid = value === 1;
    else if (/^push:notice-[a-f0-9]{64}$/u.test(key)) valid = exact(value, ["profileId", "at"]) && id(value.profileId) && at(value.at);
    if (!valid) fail("PROACTIVE_STORE_CORRUPT");
  }
  getCursor(key) { this.#ready(); const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(`cursor:${key}`); return row ? JSON.parse(row.value) : null; }
  setCursor(key, value) { this.#validateMeta(`cursor:${key}`, value); return this.#write(() => this.db.prepare("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`cursor:${key}`, JSON.stringify(value))); }
  heartbeatScratch(profileId) {
    if (!id(profileId)) fail();
    return this.getCursor("heartbeat-scratch:" + profileId) ?? { revision: 0, content: "", updatedAt: 0 };
  }
  setHeartbeatScratch(profileId, content, expectedRevision) {
    if (!id(profileId) || !scratchText(content) || !at(expectedRevision)) fail();
    return this.#write(() => {
      const current = this.heartbeatScratch(profileId);
      if (current.revision !== expectedRevision) fail("PROACTIVE_REVISION_CONFLICT");
      const value = { revision: current.revision + 1, content, updatedAt: this.now() };
      const key = "cursor:heartbeat-scratch:" + profileId;
      this.#validateMeta(key, value);
      this.db.prepare("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
      return value;
    });
  }
  #write(action) {
    this.#ready();
    try { return transaction(this.db, action); }
    catch (error) { if (/^SQLITE_(IOERR|CORRUPT|NOTADB)/u.test(error.code || "")) this.poisoned = true; throw error; }
  }
  #operation(operationId, payload, action) {
    if (!id(operationId)) fail();
    const fingerprint = digest(payload);
    return this.#write(() => {
      const prior = this.db.prepare("SELECT fingerprint,result FROM operations WHERE id=?").get(operationId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail("PROACTIVE_OPERATION_CONFLICT");
        return JSON.parse(prior.result);
      }
      this.db.prepare("DELETE FROM operations WHERE created_at<?").run(this.now() - 30 * 86_400_000);
      if (this.db.prepare("SELECT count(*) AS n FROM operations").get().n >= 65_536) fail("PROACTIVE_UNAVAILABLE");
      const result = action();
      this.db.prepare("INSERT INTO operations VALUES(?,?,?,?)").run(operationId, this.now(), fingerprint, JSON.stringify(result));
      return clone(result);
    });
  }
  getMonitor(monitorId) { this.#ready(); return parse(this.db.prepare("SELECT data FROM monitors WHERE id=?").get(monitorId)); }
  monitors(profileId = null) {
    this.#ready();
    return this.db.prepare(profileId === null ? "SELECT data FROM monitors ORDER BY id LIMIT 4096"
      : "SELECT data FROM monitors WHERE profile_id=? ORDER BY id LIMIT 4096").all(...(profileId === null ? [] : [profileId])).map(parse);
  }
  ensureHeartbeatMonitor(profileId) {
    if (!id(profileId)) fail();
    return this.#write(() => {
      const prior = this.getMonitor(monitorId("heartbeat", profileId));
      const key = "heartbeat-defaults:" + profileId;
      if (prior && this.getCursor(key) === 1) return prior;
      if (!prior && this.db.prepare("SELECT count(*) AS n FROM monitors").get().n >= 4096) fail("PROACTIVE_UNAVAILABLE");
      const now = this.now(), defaults = defaultConfig("heartbeat", profileId, now);
      // Apply the requested baseline once, including saved monitors. Later user
      // choices survive restarts; user rules, delivery and scopes stay separate.
      const config = validateConfig(prior ? { ...prior.config, enabled: defaults.enabled,
        schedule: { ...defaults.schedule, anchorMs: prior.config.schedule.anchorMs }, timezone: defaults.timezone,
        activeHours: defaults.activeHours, budget: defaults.budget } : defaults);
      const monitor = { config, revision: (prior?.revision ?? 0) + 1, createdAt: prior?.createdAt ?? now, updatedAt: now,
        nextRunAt: computeNextOccurrence(config.schedule, now) };
      this.#putMonitor(monitor);
      this.db.prepare("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run("cursor:" + key, "1");
      return clone(monitor);
    });
  }
  setMonitor({ operationId, expectedRevision, config }) {
    config = validateConfig(config);
    return this.#operation(operationId, { kind: "monitor", expectedRevision, config }, () => {
      const prior = this.getMonitor(config.id);
      if ((prior?.revision ?? 0) !== expectedRevision) fail("PROACTIVE_REVISION_CONFLICT");
      if (!prior && this.db.prepare("SELECT count(*) AS n FROM monitors").get().n >= 4096) fail("PROACTIVE_UNAVAILABLE");
      const now = this.now();
      const scheduleUnchanged = prior && digest(prior.config.schedule) === digest(config.schedule);
      const monitor = { config, revision: expectedRevision + 1, createdAt: prior?.createdAt ?? now, updatedAt: now,
        nextRunAt: config.enabled ? scheduleUnchanged && prior.nextRunAt !== null && prior.config.enabled
          ? prior.nextRunAt : computeNextOccurrence(config.schedule, now) : null };
      this.#putMonitor(monitor); return monitor;
    });
  }
  #putMonitor(monitor) {
    this.db.prepare("INSERT INTO monitors VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,profile_id=excluded.profile_id,next_at=excluded.next_at,data=excluded.data")
      .run(monitor.config.id, Number(monitor.config.enabled), monitor.config.profileId, monitor.nextRunAt, JSON.stringify(monitor));
  }
  due(now) { this.#ready(); return this.db.prepare("SELECT data FROM monitors WHERE enabled=1 AND next_at<=? ORDER BY next_at,id LIMIT 32").all(now).map(parse); }
  claimOccurrence(monitorId, scheduledAt, now) {
    if (!at(scheduledAt) || !at(now)) fail();
    return this.#write(() => {
      const monitor = this.getMonitor(monitorId);
      if (!monitor?.config.enabled) return null;
      const prior = this.getOccurrence(occurrenceId(monitorId, scheduledAt));
      if (prior) return null;
      this.#putMonitor({ ...monitor, nextRunAt: computeNextOccurrence(monitor.config.schedule, Math.max(now, scheduledAt)) });
      const occurrence = { id: occurrenceId(monitorId, scheduledAt), monitorId, scheduledAt, createdAt: now,
        revision: monitor.revision, config: clone(monitor.config), state: "claimed", reason: null,
        runId: null, candidates: [], response: null, finishedAt: null, deferredUntil: null, expiresAt: now + 6 * 60 * 60_000 };
      this.db.prepare("INSERT INTO occurrences VALUES(?,?,?,?,?,?,?)")
        .run(occurrence.id, monitorId, scheduledAt, now, occurrence.state, null, JSON.stringify(occurrence));
      this.#trim(); return occurrence;
    });
  }
  getOccurrence(occurrenceIdValue) { this.#ready(); return parse(this.db.prepare("SELECT data FROM occurrences WHERE id=?").get(occurrenceIdValue)); }
  occurrenceForRun(runId) { this.#ready(); return parse(this.db.prepare("SELECT data FROM occurrences WHERE run_id=?").get(runId)); }
  pendingOccurrences() { this.#ready(); return this.db.prepare("SELECT data FROM occurrences WHERE state IN ('claimed','running','deferred') ORDER BY created_at LIMIT 64").all().map(parse); }
  updateOccurrence(occurrenceIdValue, patch) {
    if (Object.keys(patch).some(key => !["state", "reason", "runId", "candidates", "response", "finishedAt", "deferredUntil", "heartbeat"].includes(key))) fail();
    return this.#write(() => {
      const prior = this.getOccurrence(occurrenceIdValue); if (!prior) fail("PROACTIVE_NOT_FOUND");
      const value = validateOccurrence({ ...prior, ...clone(patch) });
      this.db.prepare("UPDATE occurrences SET state=?,run_id=?,data=? WHERE id=?").run(value.state, value.runId, JSON.stringify(value), value.id);
      return value;
    });
  }
  history(monitorId, cursor = null, limit = 20) {
    this.#ready();
    const boundary = cursor === null ? { createdAt: Number.MAX_SAFE_INTEGER, id: "" } : historyCursor(cursor);
    if (!boundary) fail();
    return this.db.prepare("SELECT data FROM occurrences WHERE monitor_id=? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?")
      .all(monitorId, boundary.createdAt, boundary.createdAt, boundary.id, limit).map(parse);
  }
  countReviewAttempts(profileId, now, timezone) {
    this.#ready(); const day = localParts(now, timezone).day;
    return this.db.prepare("SELECT created_at FROM occurrences WHERE run_id IS NOT NULL AND json_extract(data,'$.config.profileId')=? AND created_at>=? AND created_at<?")
      .all(profileId, Math.max(0, now - 2 * DAY_MS), now + 2 * DAY_MS).filter(row => localParts(row.created_at, timezone).day === day).length;
  }
  getNote(ideaId) {
    this.#ready();
    return parse(this.db.prepare("SELECT data FROM notes WHERE id=?").get(ideaId)) ?? {
      id: ideaId, revision: 0, lastRemindedAt: null, snoozedUntil: null, disabled: false, handled: false, noticeId: null };
  }
  setNote({ operationId, id: ideaId, expectedRevision, patch }) {
    return this.#operation(operationId, { kind: "note", id: ideaId, expectedRevision, patch }, () => {
      const prior = this.getNote(ideaId);
      if (prior.revision !== expectedRevision) fail("PROACTIVE_REVISION_CONFLICT");
      const value = { ...prior, ...clone(patch), revision: prior.revision + 1 };
      this.#putNote(value); return value;
    });
  }
  #putNote(value) { validateNote(value); this.db.prepare("INSERT INTO notes VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(value.id, JSON.stringify(value)); }
  ideaEligible(ideaId, now) {
    const note = this.getNote(ideaId);
    return !note.disabled && !note.handled && now >= Math.max(note.lastRemindedAt === null ? 0 : note.lastRemindedAt + IDEA_COOLDOWN_MS, note.snoozedUntil ?? 0);
  }
  eventEligible(key, now, interval = IDEA_COOLDOWN_MS) {
    const remindedAt = this.eventRemindedAt(key);
    return remindedAt === null || now >= remindedAt + interval;
  }
  eventRemindedAt(key) { this.#ready(); return this.db.prepare("SELECT reminded_at FROM events WHERE id=?").get(key)?.reminded_at ?? null; }
  reserveNotice(occurrence, { title, body, items, dayKey = null, timezone, now }, validate) {
    return this.#write(() => {
      const prior = this.noticeForOccurrence(occurrence.id); if (prior) return prior;
      const current = this.getMonitor(occurrence.monitorId);
      if (!current?.config.enabled || current.revision !== occurrence.revision || !validate()) return null;
      if (!items.length || items.some(item => item.ideaId && !this.ideaEligible(item.ideaId, now)
        || !this.eventEligible(item.eventKey, now, item.ideaId ? IDEA_COOLDOWN_MS : 60 * 60_000))) return null;
      if (dayKey && this.db.prepare("SELECT id FROM notices WHERE daily_key=?").get(dayKey)) return null;
      if (dayKey) {
        const latest = parse(this.db.prepare("SELECT data FROM notices WHERE daily_key IS NOT NULL ORDER BY created_at DESC LIMIT 1").get());
        if (latest && require("./proactive-service-protocol").localParts(latest.createdAt, timezone).day === dayKey) return null;
      }
      const notice = { id: `notice-${digest(occurrence.id)}`, occurrenceId: occurrence.id, monitorId: occurrence.monitorId,
        profileId: occurrence.config.profileId, revision: occurrence.revision, kind: occurrence.config.kind,
        createdAt: now, title, body, items: clone(items), target: clone(occurrence.config.target), push: occurrence.config.push,
        sessionKey: null, appState: "pending", systemState: occurrence.config.push ? "pending" : "suppressed",
        systemReason: occurrence.config.push ? null : "monitor_push_disabled", dayKey };
      this.#putNotice(notice);
      for (const item of items) {
        if (item.ideaId) { const note = this.getNote(item.ideaId); this.#putNote({ ...note, revision: note.revision + 1, lastRemindedAt: now, noticeId: notice.id }); }
        this.db.prepare("INSERT INTO events VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET reminded_at=excluded.reminded_at,notice_id=excluded.notice_id")
          .run(item.eventKey, now, notice.id);
      }
      return notice;
    });
  }
  #putNotice(notice) {
    validateNotice(notice);
    this.db.prepare("INSERT INTO notices VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET app_state=excluded.app_state,system_state=excluded.system_state,data=excluded.data")
      .run(notice.id, notice.occurrenceId, notice.profileId, notice.createdAt, notice.appState, notice.systemState, notice.dayKey, JSON.stringify(notice));
  }
  getNotice(noticeId) { this.#ready(); return parse(this.db.prepare("SELECT data FROM notices WHERE id=?").get(noticeId)); }
  noticeForOccurrence(occurrenceIdValue) { this.#ready(); return parse(this.db.prepare("SELECT data FROM notices WHERE occurrence_id=?").get(occurrenceIdValue)); }
  updateNotice(noticeId, patch) {
    if (Object.keys(patch).some(key => !["appState", "systemState", "systemReason", "sessionKey", "items", "body"].includes(key))) fail();
    return this.#write(() => { const prior = this.getNotice(noticeId); if (!prior) fail("PROACTIVE_NOT_FOUND");
      const notice = { ...prior, ...clone(patch) }; this.#putNotice(notice); return notice; });
  }
  beginSystemSubmission(noticeId, now) {
    if (!at(now)) fail();
    return this.#write(() => {
      const notice = this.getNotice(noticeId);
      if (!notice || notice.appState !== "published" || notice.systemState !== "pending") return null;
      this.db.prepare("DELETE FROM meta WHERE key LIKE 'push:%' AND json_extract(value,'$.at')<=?").run(now - 3_600_000);
      const recent = this.db.prepare("SELECT value FROM meta WHERE key LIKE 'push:%' LIMIT 32").all().map(row => JSON.parse(row.value));
      if (recent.length >= 8 || recent.filter(value => value.profileId === notice.profileId).length >= 4) {
        const deferred = { ...notice, systemReason: "frequency_limit" }; this.#putNotice(deferred); return null;
      }
      this.db.prepare("INSERT INTO meta VALUES(?,?)").run(`push:${notice.id}`, JSON.stringify({ profileId: notice.profileId, at: now }));
      const submitting = { ...notice, systemState: "submitting", systemReason: null }; this.#putNotice(submitting); return submitting;
    });
  }
  outbox() { this.#ready(); return this.db.prepare("SELECT data FROM notices WHERE app_state IN ('pending','publishing') OR system_state IN ('pending','submitting') ORDER BY created_at LIMIT 64").all().map(parse); }
  getTarget(profileId) { this.#ready(); return parse(this.db.prepare("SELECT data FROM targets WHERE profile_id=?").get(profileId)); }
  setTarget(profileId, value) {
    validateTarget(value); if (value.profileId !== profileId) fail();
    return this.#write(() => { this.db.prepare("INSERT INTO targets VALUES(?,?) ON CONFLICT(profile_id) DO UPDATE SET data=excluded.data")
      .run(profileId, JSON.stringify(value)); return clone(value); });
  }
  sessionOrigin(sessionKey) {
    this.#ready(); const target = this.db.prepare("SELECT profile_id FROM targets WHERE json_extract(data,'$.sessionKey')=?").get(sessionKey);
    return target ? { source: "proactive", proactiveTarget: true } : null;
  }
  lastNotice(monitorId) { this.#ready(); return parse(this.db.prepare("SELECT data FROM notices WHERE json_extract(data,'$.monitorId')=? ORDER BY created_at DESC LIMIT 1").get(monitorId)); }
  #trim() {
    // Keep unresolved publication and Runtime acceptance records. Only old,
    // settled checks without a Notice can be discarded.
    this.db.prepare("DELETE FROM occurrences WHERE id IN (SELECT id FROM occurrences WHERE state IN ('silent','skipped','failed','published') AND created_at<? AND id NOT IN (SELECT occurrence_id FROM notices) ORDER BY created_at LIMIT 128)")
      .run(this.now() - 30 * 86_400_000);
    // Settled delivery history is capped independently from the durable note
    // cooldown and deleted-target tombstones. Uncertain delivery is retained.
    this.db.prepare("DELETE FROM notices WHERE id IN (SELECT id FROM notices WHERE app_state IN ('published','failed','suppressed') AND system_state IN ('submitted','failed','suppressed') AND created_at<? ORDER BY created_at LIMIT 128)")
      .run(this.now() - 30 * 86_400_000);
    this.db.prepare("DELETE FROM events WHERE reminded_at<?").run(this.now() - 30 * 86_400_000);
    if (this.db.prepare("SELECT count(*) AS n FROM occurrences").get().n > 65_536) fail("PROACTIVE_UNAVAILABLE");
  }
  pauseProfile(profileId) {
    return this.#write(() => { for (const monitor of this.monitors(profileId)) this.#putMonitor({ ...monitor,
      config: { ...monitor.config, enabled: false }, revision: monitor.revision + 1, nextRunAt: null, updatedAt: this.now() }); });
  }
  purgeProfile(profileId) {
    this.#write(() => {
      const notices = this.db.prepare("SELECT id FROM notices WHERE profile_id=?").all(profileId);
      for (const notice of notices) this.db.prepare("DELETE FROM events WHERE notice_id=?").run(notice.id);
      this.db.prepare("DELETE FROM notices WHERE profile_id=?").run(profileId);
      this.db.prepare("DELETE FROM occurrences WHERE json_extract(data,'$.config.profileId')=?").run(profileId);
      this.db.prepare("DELETE FROM monitors WHERE profile_id=?").run(profileId);
      this.db.prepare("DELETE FROM targets WHERE profile_id=?").run(profileId);
      this.db.prepare("DELETE FROM meta WHERE key=?").run("cursor:heartbeat-scratch:" + profileId);
      this.db.prepare("DELETE FROM meta WHERE key=?").run("cursor:heartbeat-defaults:" + profileId);
      this.db.prepare("DELETE FROM operations WHERE json_extract(result,'$.config.profileId')=?").run(profileId);
      this.db.prepare("DELETE FROM meta WHERE key=?").run(`cursor:capability:${profileId}`);
      // Idea cooldown is global and survives deletion of a review Agent.
    });
  }
}
module.exports = { ProactiveStore, occurrenceId };
