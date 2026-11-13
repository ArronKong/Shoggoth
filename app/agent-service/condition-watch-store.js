"use strict";

const path = require("node:path");
const { openDatabase, transaction } = require("./inspiration-database");
const { preparePrivateParent, fsyncPrivateParent } = require("./private-file");
const { acquirePrivateWriterLease } = require("./private-writer-lease");
const { fail, digest, normalizeDefinition, fields, isWatchId, at, watchUrl } = require("./condition-watch-protocol");

const WATCH_DB = "condition-watches.sqlite";
const WATCH_LOCK = "condition-watches.writer.lock";
const RETAIN_MS = 30 * 86_400_000;
const MAX_HISTORY = 2000;
const MAX_PENDING = 32;
const MAX_OPERATIONS = 32_768;
const DAY_MS = 86_400_000;
const REVIEW_LIMITS = Object.freeze({ perWatch: 10, perProfile: 30, timeoutMs: 60_000, maxEvidenceBytes: 8192 });
const REVIEW_RETRYABLE = ["review_failed", "review_uncertain"];
const PENDING_STATES = "'pending','writing','needs_verification','blocked','review_queued','reviewing'";
const PENDING = `(${PENDING_STATES})`;
const REVOCABLE = `(${PENDING_STATES},'review_failed','review_uncertain')`;
const REVIEW_SCHEMA = `
CREATE TABLE review_attempts(
  operation_id TEXT PRIMARY KEY, watch_id TEXT NOT NULL, profile_id TEXT NOT NULL,
  started_at INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER
);
CREATE INDEX review_attempts_day ON review_attempts(profile_id,started_at,watch_id);
CREATE INDEX review_attempts_age ON review_attempts(started_at);
PRAGMA user_version=2;`;
const SCHEMA = `
CREATE TABLE watches(
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, destination_key TEXT NOT NULL, spec_key TEXT NOT NULL,
  state TEXT NOT NULL, next_at INTEGER, data TEXT NOT NULL CHECK(json_valid(data)),
  CHECK(id=json_extract(data,'$.id') AND state=json_extract(data,'$.state')
    AND profile_id=json_extract(data,'$.target.profileId') AND next_at IS json_extract(data,'$.nextDueAt'))
);
CREATE INDEX watches_due ON watches(state,next_at);
CREATE INDEX watches_scope ON watches(profile_id,destination_key,id);
CREATE INDEX watches_spec ON watches(destination_key,spec_key);
CREATE TABLE checks(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE, epoch INTEGER NOT NULL,
  slot_at INTEGER, created_at INTEGER NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
  UNIQUE(watch_id,epoch,slot_at),
  CHECK(id=json_extract(data,'$.id') AND watch_id=json_extract(data,'$.watchId')
    AND epoch=json_extract(data,'$.epoch') AND state=json_extract(data,'$.outcome'))
);
CREATE UNIQUE INDEX checks_inflight ON checks(watch_id) WHERE state='reading';
CREATE INDEX checks_history ON checks(watch_id,seq DESC);
CREATE TABLE events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
  state TEXT NOT NULL, next_at INTEGER, data TEXT NOT NULL CHECK(json_valid(data)),
  CHECK(id=json_extract(data,'$.id') AND watch_id=json_extract(data,'$.watchId')
    AND state=json_extract(data,'$.state') AND next_at IS json_extract(data,'$.nextAt'))
);
CREATE INDEX events_due ON events(state,next_at);
CREATE INDEX events_history ON events(watch_id,seq DESC);
CREATE TABLE operations(id TEXT PRIMARY KEY, watch_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX operations_age ON operations(created_at);
CREATE INDEX operations_watch ON operations(watch_id);
${REVIEW_SCHEMA}`;

const parse = row => row ? JSON.parse(row.data) : null;
function destinationKey(target) {
  return digest(target.kind === "group" ? [target.kind, target.ownerScope, target.groupId, target.memberId, target.profileId]
    : [target.kind, target.profileId, target.sessionKey]);
}
function definitionKey(definition) {
  const { name, intervalMs, ...condition } = definition;
  return digest(condition);
}

function validBinding(definition, binding) {
  if (binding === null) return true;
  const localKey = definition.source.kind === "log_file" ? "parent" : definition.source.kind === "directory" ? "directory" : null;
  if (localKey) return fields(binding, ["workspace", localKey])
    && [binding.workspace, binding[localKey]].every(identity => Array.isArray(identity) && identity.length === 2
      && identity.every(part => typeof part === "string" && /^\d+$/u.test(part)));
  if (!fields(binding, ["url"]) || typeof binding.url !== "string") return false;
  return watchUrl(binding.url).origin === watchUrl(definition.source.url).origin;
}

function validLogCursor(cursor) {
  return fields(cursor, ["file", "offset", "anchor", "discard"]) && Array.isArray(cursor.file) && cursor.file.length === 3
    && cursor.file.every(part => typeof part === "string" && /^-?\d+$/u.test(part))
    && Number.isSafeInteger(cursor.offset) && cursor.offset >= 0 && /^[a-f0-9]{64}$/u.test(cursor.anchor)
    && typeof cursor.discard === "boolean";
}

function nextSlot(watch, now) {
  const interval = watch.definition.intervalMs;
  const nextAt = now < watch.anchorAt ? watch.anchorAt : now + interval - ((now - watch.anchorAt) % interval);
  return Math.min(nextAt, watch.definition.deadlineAt ?? Infinity);
}

function verifyWatchRows(db) {
  for (const row of db.prepare("SELECT * FROM watches LIMIT 129").all()) {
    const watch = parse(row);
    const { target, definition } = watch;
    const group = target?.kind === "group";
    const scopeFields = group ? ["kind", "profileId", "ownerScope", "groupId", "memberId", "messageId"]
      : ["kind", "profileId", "sessionKey", "sessionId", "messageId"];
    if (!isWatchId(watch.id) || !fields(target, scopeFields) || !["group", "chat"].includes(target.kind)
      || scopeFields.some(key => key !== "messageId" && (typeof target[key] !== "string" || !target[key].length))
      || target.messageId !== null && (typeof target.messageId !== "string" || !target.messageId.length)
      || row.destination_key !== destinationKey(target) || row.spec_key !== definitionKey(normalizeDefinition(definition))
      || !["draft", "enabled", "paused", "finishing", "completed", "blocked"].includes(watch.state)
      || [watch.revision, watch.version, watch.epoch].some(value => !Number.isSafeInteger(value) || value < 1)
      || !validBinding(definition, watch.binding)
      || definition.source.kind === "log_file" && (watch.checkpoint && !validLogCursor(watch.checkpoint.logCursor)
        || watch.test?.ok && !validLogCursor(watch.test.logCursor))
      || watch.state === "enabled" && (!at(watch.anchorAt) || !at(watch.nextDueAt) || !watch.binding)) fail("WATCH_UNAVAILABLE");
  }
}

class ConditionWatchStore {
  constructor({ paths, now = Date.now }) {
    this.paths = paths;
    this.now = now;
    this.filePath = path.join(paths.stateDir, WATCH_DB);
    this.db = null;
    this.poisoned = false;
  }

  open() {
    if (this.db) return this;
    preparePrivateParent(this.filePath, this.paths.trustedRoot);
    const lease = acquirePrivateWriterLease({ lockPath: path.join(this.paths.stateDir, WATCH_LOCK), trustedRoot: this.paths.trustedRoot });
    try {
      this.db = openDatabase(this.filePath);
      const { user_version: version } = this.db.prepare("PRAGMA user_version").get();
      if (version === 0) {
        transaction(this.db, () => this.db.exec(SCHEMA));
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        fsyncPrivateParent(this.paths.stateDir);
      }
      if (version === 1) transaction(this.db, () => this.db.exec(REVIEW_SCHEMA));
      if (![0, 1, 2].includes(version) || this.db.prepare("PRAGMA quick_check").get().quick_check !== "ok") fail("WATCH_UNAVAILABLE");
      if (this.db.prepare("SELECT count(*) AS count FROM watches").get().count > 128) fail("WATCH_UNAVAILABLE");
      verifyWatchRows(this.db);
      this.lease = lease;
      this.poisoned = false;
      return this;
    } catch (error) {
      this.db?.close();
      this.db = null;
      lease.release();
      throw error;
    }
  }

  close() {
    try {
      if (this.db) {
        try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { this.db.close(); }
      }
    } finally {
      this.db = null;
      this.lease?.release();
      this.lease = null;
    }
  }

  #ready() { if (!this.db || this.poisoned) fail("WATCH_UNAVAILABLE"); }
  #write(action) {
    this.#ready();
    try { return transaction(this.db, action); }
    catch (error) {
      if (/^SQLITE_(?:IOERR|CORRUPT|NOTADB|FULL)/u.test(error.code || "")) this.poisoned = true;
      throw error;
    }
  }

  get(id) {
    this.#ready();
    return parse(this.db.prepare("SELECT data FROM watches WHERE id=?").get(id));
  }

  require(id, scope = null, expectedRevision = null) {
    const watch = this.get(id);
    if (!watch || scope && destinationKey(scope) !== destinationKey(watch.target)) fail("WATCH_NOT_FOUND");
    if (expectedRevision !== null && expectedRevision !== watch.revision) fail("WATCH_CONFLICT");
    return watch;
  }

  list({ scope = null, profileId = null, cursor = null, limit = 15 } = {}) {
    this.#ready();
    const key = scope ? destinationKey(scope) : null;
    const rows = this.db.prepare(`SELECT data FROM watches WHERE id>? AND (? IS NULL OR profile_id=?)
      AND (? IS NULL OR destination_key=?) ORDER BY id LIMIT ?`)
      .all(cursor ?? "", profileId, profileId, key, key, limit + 1).map(parse);
    return { watches: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
  }

  #put(watch) {
    this.db.prepare(`INSERT INTO watches(id,profile_id,destination_key,spec_key,state,next_at,data) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET spec_key=excluded.spec_key,state=excluded.state,next_at=excluded.next_at,data=excluded.data`)
      .run(watch.id, watch.target.profileId, destinationKey(watch.target), definitionKey(watch.definition),
        watch.state, watch.nextDueAt, JSON.stringify(watch));
    return watch;
  }

  operation(id, watchId, input, apply) {
    const fingerprint = digest(input);
    return this.#write(() => {
      const prior = this.db.prepare("SELECT fingerprint,data FROM operations WHERE id=?").get(id);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail("WATCH_CONFLICT");
        return parse(prior);
      }
      const now = this.now();
      this.#pruneOperations(now);
      const result = apply();
      this.db.prepare("INSERT INTO operations VALUES(?,?,?,?,?)")
        .run(id, result.watchId ?? watchId, fingerprint, now, JSON.stringify(result));
      return result;
    });
  }

  #pruneOperations(now) {
    this.db.prepare("DELETE FROM operations WHERE created_at<?").run(now - RETAIN_MS);
    if (this.db.prepare("SELECT count(*) AS count FROM operations").get().count >= MAX_OPERATIONS) fail("WATCH_CAPACITY");
  }

  create(id, definition, target) {
    const existing = this.db.prepare(`SELECT data FROM watches WHERE destination_key=? AND spec_key=?
      AND state IN ('draft','enabled','paused','blocked','finishing') ORDER BY id`)
      .all(destinationKey(target), definitionKey(definition)).map(parse);
    const prior = existing.find(item => item.definition.intervalMs === definition.intervalMs);
    if (prior) return prior;
    const total = this.db.prepare("SELECT count(*) AS count FROM watches").get().count;
    const owned = this.db.prepare("SELECT count(*) AS count FROM watches WHERE profile_id=?").get(target.profileId).count;
    if (total >= 128 || owned >= 32) fail("WATCH_CAPACITY");
    return this.#put({ id, target, definition, state: "draft", revision: 1, version: 1, epoch: 1,
      nextDueAt: null, anchorAt: null, test: null, binding: null, checkpoint: null, failure: null,
      reason: null, createdAt: this.now(), updatedAt: this.now() });
  }

  saveTest(id, expectedRevision, epoch, result) {
    return this.#write(() => {
      const watch = this.require(id, null, expectedRevision);
      if (watch.epoch !== epoch) fail("WATCH_CONFLICT");
      return this.#put({ ...watch, test: result, revision: watch.revision + 1, updatedAt: this.now() });
    });
  }

  update(watch, definition) {
    const changed = definitionKey(definition) !== definitionKey(watch.definition);
    const intervalChanged = definition.intervalMs !== watch.definition.intervalMs;
    const now = this.now();
    const patch = { definition, revision: watch.revision + 1, updatedAt: now };
    if (changed) {
      this.#revoke(watch, "definition_changed");
      Object.assign(patch, { state: "draft", version: watch.version + 1, epoch: watch.epoch + 1,
        nextDueAt: null, anchorAt: null, checkpoint: null, test: null, binding: null, failure: null, reason: null });
    } else if (intervalChanged && watch.state === "enabled") {
      Object.assign(patch, { anchorAt: now, nextDueAt: Math.max(now + definition.intervalMs, watch.failure?.until ?? 0) });
    }
    return this.#put({ ...watch, ...patch });
  }

  setEnabled(watch, enabled) {
    const now = this.now();
    if (enabled) {
      if (watch.state === "enabled" || watch.state === "finishing") return watch;
      if (watch.state === "completed" || (watch.definition.deadlineAt ?? Infinity) <= now) fail("WATCH_CONFLICT");
      const reusable = watch.binding && watch.state === "paused";
      if (!reusable && (watch.test?.ok !== true || watch.test.expiresAt <= now
        || watch.test.version !== watch.version || watch.test.epoch !== watch.epoch)) fail("WATCH_TEST_REQUIRED");
      const binding = reusable ? watch.binding : watch.test.binding;
      const checkpoint = watch.definition.source.kind === "log_file" && !reusable
        ? { logCursor: watch.test.logCursor, observedAt: null }
        : reusable || digest(watch.binding) === digest(binding) ? watch.checkpoint : null;
      return this.#put({ ...watch, state: "enabled", epoch: watch.epoch + 1, revision: watch.revision + 1,
        nextDueAt: now, anchorAt: now, binding, checkpoint, failure: null, reason: null, updatedAt: now });
    }
    if (watch.state === "paused" || watch.state === "completed") return watch;
    this.#revoke(watch, "paused");
    return this.#put({ ...watch, state: "paused", epoch: watch.epoch + 1, revision: watch.revision + 1,
      nextDueAt: null, checkpoint: watch.checkpoint ? { ...watch.checkpoint, pending: null } : null, reason: "paused", updatedAt: now });
  }

  delete(watch) {
    // Keep the bounded idempotency receipts. A delayed replay must not recreate this ID.
    this.db.prepare("DELETE FROM operations WHERE watch_id=?").run(watch.id);
    this.db.prepare("INSERT INTO operations VALUES(?,?,?,?,?)")
      .run(`tombstone:${watch.id}`, watch.id, watch.id, this.now(), '{"deleted":true}');
    this.db.prepare("DELETE FROM watches WHERE id=?").run(watch.id);
    return { watchId: watch.id, deleted: true };
  }

  isDeleted(id) {
    this.#ready();
    return Boolean(this.db.prepare("SELECT 1 FROM operations WHERE id=?").get(`tombstone:${id}`));
  }

  #revoke(watch, reason) {
    const now = this.now();
    const checks = this.db.prepare("SELECT data FROM checks WHERE watch_id=? AND state='reading'").all(watch.id);
    for (const row of checks) this.#settleCheck(parse(row), "canceled", reason, now);
    const events = this.db.prepare(`SELECT data FROM events WHERE watch_id=? AND state IN ${REVOCABLE}`).all(watch.id);
    for (const row of events) {
      const event = parse(row);
      const reconcile = ["writing", "needs_verification"].includes(event.state);
      this.#putEvent({ ...event, state: reconcile ? "needs_verification" : "canceled",
        reason, nextAt: reconcile ? now : null, reconcileOnly: reconcile,
        ...(event.state === "reviewing" ? { review: { ...event.review, finishedAt: now } } : {}) });
    }
  }

  pauseProfile(profileId) {
    this.#write(() => {
      for (const row of this.db.prepare("SELECT data FROM watches WHERE profile_id=? AND state IN ('enabled','finishing','completed')").all(profileId)) {
        const watch = parse(row);
        if (watch.state === "completed") this.#revoke(watch, "paused");
        else this.setEnabled(watch, false);
      }
    });
  }

  purgeProfile(profileId) {
    this.#write(() => {
      this.db.prepare("DELETE FROM operations WHERE watch_id IN (SELECT id FROM watches WHERE profile_id=?)").run(profileId);
      this.db.prepare("DELETE FROM watches WHERE profile_id=?").run(profileId);
      this.db.prepare("DELETE FROM review_attempts WHERE profile_id=?").run(profileId);
    });
  }

  recover({ restore = false } = {}) {
    this.#write(() => {
      const now = this.now();
      for (const row of this.db.prepare(`SELECT data FROM events WHERE state='published'
        AND json_extract(data,'$.systemState')='submitting'`).all()) {
        this.#putEvent({ ...parse(row), systemState: "needs_verification" });
      }
      for (const row of this.db.prepare("SELECT data FROM events WHERE state='reviewing'").all()) {
        const event = parse(row);
        this.#putEvent({ ...event, state: "review_uncertain", reason: "WATCH_REVIEW_UNCERTAIN", nextAt: null,
          review: { ...event.review, finishedAt: now } });
      }
      for (const row of this.db.prepare("SELECT data FROM checks WHERE state='reading'").all()) {
        const check = parse(row);
        this.#settleCheck(check, "interrupted", "service_restarted", now);
        const watch = this.get(check.watchId);
        if (!restore && watch?.epoch === check.epoch && watch.state === "enabled") {
          this.#put({ ...watch, nextDueAt: Math.max(now, check.scheduledAt + 1) });
        }
      }
      if (!restore) return;
      for (const row of this.db.prepare("SELECT data FROM watches").all()) {
        const watch = parse(row);
        this.#revoke(watch, "authority_restored");
        this.#put({ ...watch, state: watch.state === "completed" ? "completed" : "paused", nextDueAt: null,
          epoch: watch.epoch + 1, revision: watch.revision + 1, binding: null, test: null, checkpoint: null,
          failure: null, reason: "authority_restored", updatedAt: now });
      }
      for (const row of this.db.prepare("SELECT data FROM events WHERE state='needs_verification'").all()) {
        this.#putEvent({ ...parse(row), reconcileOnly: true, reason: "authority_restored", nextAt: now });
      }
      this.db.prepare("DELETE FROM operations").run();
    });
  }

  due(now, limit = 16) {
    this.#ready();
    return this.db.prepare("SELECT data FROM watches WHERE state='enabled' AND next_at<=? ORDER BY next_at,id LIMIT ?")
      .all(now, limit).map(parse);
  }

  nextWake() {
    this.#ready();
    return this.db.prepare(`SELECT min(next_at) AS due FROM (
      SELECT min(next_at) AS next_at FROM watches WHERE state='enabled'
      UNION ALL SELECT min(next_at) FROM events WHERE state IN ('pending','writing','needs_verification','review_queued')
    )`).get().due;
  }

  defer(watch, nextDueAt, reason) {
    return this.#write(() => {
      const current = this.get(watch.id);
      if (current?.epoch === watch.epoch && current.state === "enabled") this.#put({
        ...current, nextDueAt: Math.min(nextDueAt, current.definition.deadlineAt ?? Infinity), reason,
      });
    });
  }

  block(id, reason) {
    return this.#write(() => {
      const watch = this.require(id);
      if (!["enabled", "finishing"].includes(watch.state)) return watch;
      this.#revoke(watch, reason);
      return this.#put({ ...watch, state: "blocked", nextDueAt: null, reason, test: null,
        epoch: watch.epoch + 1, revision: watch.revision + 1, updatedAt: this.now() });
    });
  }

  expire(watch, now) {
    return this.#write(() => {
      const current = this.get(watch.id);
      if (current?.epoch !== watch.epoch || current.state !== "enabled") return;
      this.#put({ ...current, state: "completed", nextDueAt: null, reason: "deadline",
        revision: current.revision + 1, updatedAt: now });
    });
  }

  #backlog(watchId) {
    return this.db.prepare(`SELECT count(*) AS count FROM events WHERE watch_id=? AND state IN ${PENDING}`).get(watchId).count;
  }

  claim(id, now, manualId = null, operationId = null) {
    return this.#write(() => {
      const watch = this.require(id);
      const previous = manualId ? this.manualCheck(watch.id, operationId) : null;
      if (previous) return { check: previous, start: false };
      if (watch.state !== "enabled" || (watch.definition.deadlineAt ?? Infinity) <= now
        || !manualId && (watch.nextDueAt === null || watch.nextDueAt > now)) return null;
      const inflight = parse(this.db.prepare("SELECT data FROM checks WHERE watch_id=? AND state='reading'").get(id));
      if (inflight) {
        if (operationId) this.#recordCheckAlias(watch.id, operationId, inflight.id);
        return { check: inflight, start: false };
      }
      if (this.#backlog(id) >= MAX_PENDING) {
        this.#put({ ...watch, nextDueAt: now + 60_000, reason: "delivery_backlog" });
        return null;
      }
      const slotAt = manualId ? null : watch.nextDueAt;
      const existing = slotAt === null ? null : this.db.prepare("SELECT id FROM checks WHERE watch_id=? AND epoch=? AND slot_at=?")
        .get(watch.id, watch.epoch, slotAt);
      if (!manualId) this.#put({ ...watch, nextDueAt: nextSlot(watch, now), reason: null });
      if (existing) return null;
      const check = { id: manualId ?? digest([watch.id, watch.epoch, slotAt]), watchId: watch.id, version: watch.version,
        epoch: watch.epoch, scheduledAt: slotAt ?? now, startedAt: now, finishedAt: null,
        outcome: "reading", reason: null, eventId: null, coverageGap: slotAt !== null && now - slotAt >= watch.definition.intervalMs };
      this.db.prepare("INSERT INTO checks(id,watch_id,epoch,slot_at,created_at,state,data) VALUES(?,?,?,?,?,?,?)")
        .run(check.id, watch.id, watch.epoch, slotAt, now, "reading", JSON.stringify(check));
      if (operationId) this.#recordCheckAlias(watch.id, operationId, check.id);
      this.#trim(watch.id, now);
      return { check, watch, start: true };
    });
  }

  #settleCheck(check, outcome, reason, now, eventId = null) {
    this.db.prepare("UPDATE checks SET state=?,data=? WHERE id=?")
      .run(outcome, JSON.stringify({ ...check, outcome, reason, finishedAt: now, eventId }), check.id);
  }

  getCheck(id) {
    this.#ready();
    return parse(this.db.prepare("SELECT data FROM checks WHERE id=?").get(id));
  }

  #checkAliasId(watchId, operationId) {
    return `check:${digest([watchId, operationId])}`;
  }

  manualCheck(watchId, operationId) {
    this.#ready();
    return parse(this.db.prepare("SELECT data FROM operations WHERE id=?").get(this.#checkAliasId(watchId, operationId)));
  }

  #recordCheckAlias(watchId, operationId, checkId) {
    const key = this.#checkAliasId(watchId, operationId);
    const now = this.now();
    this.#pruneOperations(now);
    this.db.prepare("INSERT INTO operations VALUES(?,?,?,?,?)")
      .run(key, watchId, checkId, now, JSON.stringify({ id: checkId }));
  }

  rememberCheck(watchId, operationId, checkId) {
    return this.#write(() => {
      const previous = this.manualCheck(watchId, operationId);
      if (previous) return previous.id;
      if (this.getCheck(checkId)?.watchId !== watchId) fail("WATCH_CONFLICT");
      this.#recordCheckAlias(watchId, operationId, checkId);
      return checkId;
    });
  }

  #trim(id, now) {
    this.db.prepare(`DELETE FROM checks WHERE watch_id=? AND state!='reading' AND
      NOT EXISTS (SELECT 1 FROM events WHERE events.id=json_extract(checks.data,'$.eventId') AND events.state IN ${PENDING}) AND
      (created_at<? OR seq <= (SELECT coalesce(max(seq),0) FROM (
        SELECT seq FROM checks WHERE watch_id=? ORDER BY seq DESC LIMIT 1 OFFSET ${MAX_HISTORY})))`)
      .run(id, now - RETAIN_MS, id);
    this.db.prepare(`DELETE FROM events WHERE watch_id=? AND state NOT IN ${PENDING} AND
      (created_at<? OR seq <= (SELECT coalesce(max(seq),0) FROM (
        SELECT seq FROM events WHERE watch_id=? ORDER BY seq DESC LIMIT 1 OFFSET ${MAX_HISTORY})))`)
      .run(id, now - RETAIN_MS, id);
  }

  settle(check, evaluation, { error = null, retryAt = null } = {}) {
    return this.#write(() => {
      const watch = this.get(check.watchId);
      if (watch?.state !== "enabled" || watch.epoch !== check.epoch || watch.version !== check.version
        || this.db.prepare("SELECT state FROM checks WHERE id=?").get(check.id)?.state !== "reading") return null;
      const now = this.now();
      if ((watch.definition.deadlineAt ?? Infinity) <= now) {
        this.#settleCheck(check, "canceled", "deadline", now);
        this.#put({ ...watch, state: "completed", nextDueAt: null, reason: "deadline", revision: watch.revision + 1, updatedAt: now });
        return null;
      }
      if (error) {
        const count = (watch.failure?.count ?? 0) + 1;
        const sameCode = watch.failure?.code === error ? (watch.failure.sameCode ?? 1) + 1 : 1;
        const blocked = ["WATCH_SOURCE_DENIED", "WATCH_TARGET_INVALID"].includes(error) || error === "WATCH_SOURCE_INVALID" && sameCode >= 3;
        const until = Math.max(retryAt ?? 0, now + Math.min(3_600_000, 60_000 * (2 ** Math.min(6, count - 1))));
        this.#settleCheck(check, "error", error, now);
        if (error === "WATCH_TARGET_INVALID") this.#revoke(watch, error);
        this.#put({ ...watch, state: blocked ? "blocked" : "enabled", nextDueAt: blocked ? null
          : Math.min(watch.definition.deadlineAt ?? Infinity, Math.max(watch.nextDueAt ?? 0, until)),
        test: blocked ? null : watch.test, revision: watch.revision + Number(blocked),
        epoch: watch.epoch + Number(error === "WATCH_TARGET_INVALID"), reason: error,
        checkpoint: watch.checkpoint ? { ...watch.checkpoint, pending: null, validator: null } : null,
        failure: { count, sameCode, code: error, until } });
        return null;
      }
      const eventId = evaluation.outcome === "hit" ? digest([watch.id, check.id]) : null;
      const finishing = eventId && watch.definition.stopAfterDelivery;
      this.#settleCheck(check, evaluation.outcome, evaluation.reason, now, eventId);
      this.#put({ ...watch, checkpoint: evaluation.checkpoint, failure: null, reason: evaluation.reason,
        state: finishing ? "finishing" : watch.state, nextDueAt: finishing ? null : watch.nextDueAt,
        revision: watch.revision + Number(Boolean(finishing)), updatedAt: finishing ? now : watch.updatedAt });
      if (!eventId) return null;
      const event = { id: eventId, watchId: watch.id, epoch: watch.epoch, version: watch.version,
        state: watch.definition.action === "agent_review" ? "review_queued" : "pending",
        reason: null, attempts: 0, nextAt: now, createdAt: now, evidence: evaluation.evidence,
        receipt: null, target: watch.target };
      this.db.prepare("INSERT INTO events(id,watch_id,created_at,state,next_at,data) VALUES(?,?,?,?,?,?)")
        .run(event.id, watch.id, now, event.state, event.nextAt, JSON.stringify(event));
      return event;
    });
  }

  #putEvent(event) {
    this.db.prepare("UPDATE events SET state=?,next_at=?,data=? WHERE id=?")
      .run(event.state, event.nextAt, JSON.stringify(event), event.id);
    return event;
  }

  event(id) {
    this.#ready();
    return parse(this.db.prepare("SELECT data FROM events WHERE id=?").get(id));
  }

  pendingReviews(now, limit) {
    this.#ready();
    return this.db.prepare("SELECT data FROM events WHERE state='review_queued' AND next_at<=? ORDER BY next_at,seq LIMIT ?")
      .all(now, limit).map(parse);
  }

  claimReview(eventId, route, unavailable = null) {
    return this.#write(() => {
      const event = this.event(eventId);
      if (event?.state !== "review_queued") return null;
      const watch = this.get(event.watchId);
      if (!watch || watch.epoch !== event.epoch || watch.version !== event.version
        || watch.definition.action !== "agent_review" || !["enabled", "finishing", "completed"].includes(watch.state)) {
        this.#putEvent({ ...event, state: "canceled", reason: "WATCH_CANCELED", nextAt: null });
        return null;
      }
      const now = this.now();
      const day = now - now % DAY_MS;
      const profileId = watch.target.profileId;
      const usage = this.db.prepare(`SELECT count(*) AS profile, count(CASE WHEN watch_id=? THEN 1 END) AS watch
        FROM review_attempts WHERE profile_id=? AND started_at>=? AND started_at<?`).get(watch.id, profileId, day, day + DAY_MS);
      const reason = unavailable ?? (!route ? "WATCH_REVIEW_UNAVAILABLE"
        : usage.profile >= REVIEW_LIMITS.perProfile || usage.watch >= REVIEW_LIMITS.perWatch ? "WATCH_REVIEW_LIMITED" : null);
      if (reason) {
        this.#putEvent({ ...event, state: "review_failed", reason, nextAt: null });
        return null;
      }
      const attempts = (event.review?.attempts ?? 0) + 1;
      const operationId = `watch-review-${event.id}-${attempts}`;
      this.db.prepare("DELETE FROM review_attempts WHERE started_at<?").run(now - RETAIN_MS);
      this.db.prepare("INSERT INTO review_attempts(operation_id,watch_id,profile_id,started_at) VALUES(?,?,?,?)")
        .run(operationId, watch.id, profileId, now);
      return this.#putEvent({ ...event, state: "reviewing", reason: null, nextAt: null,
        review: { operationId, fingerprint: route.fingerprint, bindingId: route.bindingId, runtime: route.runtime,
          requestedModel: route.model, model: null, attempts, startedAt: now, finishedAt: null, usage: null, decision: null, note: null } });
    });
  }

  recordReviewModel(eventId, operationId, model) {
    return this.#write(() => {
      const event = this.event(eventId);
      if (event?.state !== "reviewing" || event.review.operationId !== operationId) fail("WATCH_CANCELED");
      this.#putEvent({ ...event, review: { ...event.review, requestedModel: model } });
    });
  }

  settleReview(eventId, operationId, { decision = null, note = null, model = null, usage = null, reason = null, uncertain = false }) {
    return this.#write(() => {
      if (usage) this.db.prepare("UPDATE review_attempts SET input_tokens=?,output_tokens=? WHERE operation_id=?")
        .run(usage.inputTokens, usage.outputTokens, operationId);
      const event = this.event(eventId);
      if (event?.state !== "reviewing" || event.review.operationId !== operationId) return null;
      const now = this.now();
      const state = decision === "report" ? "pending" : decision === "dismiss" ? "dismissed" : uncertain ? "review_uncertain" : "review_failed";
      const result = this.#putEvent({ ...event, state, reason, nextAt: state === "pending" ? now : null,
        review: { ...event.review, decision, note, model, usage, finishedAt: now } });
      if (state === "dismissed") {
        const watch = this.get(event.watchId);
        if (watch?.state === "finishing" && watch.epoch === event.epoch) {
          const expired = (watch.definition.deadlineAt ?? Infinity) <= now;
          this.#put({ ...watch, state: expired ? "completed" : "enabled", reason: expired ? "deadline" : null,
            nextDueAt: expired ? null : nextSlot(watch, now), revision: watch.revision + 1, updatedAt: now });
        }
      }
      return result;
    });
  }

  pending(now, limit = 16) {
    this.#ready();
    return this.db.prepare("SELECT data FROM events WHERE state IN ('pending','writing','needs_verification') AND next_at<=? ORDER BY next_at,seq LIMIT ?")
      .all(now, limit).map(parse);
  }

  markWriting(event) { return this.#write(() => this.#putEvent({ ...event, state: "writing" })); }

  settleDelivery(event, { receipt = null, reason = null, uncertain = false, canceled = false } = {}) {
    return this.#write(() => {
      const current = this.event(event.id);
      if (!current || current.state === "published" || current.state === "canceled" && !receipt) return current;
      const now = this.now();
      const attempts = current.attempts + 1;
      const delay = [30_000, 120_000, 600_000][attempts - 1];
      const state = receipt ? "published" : canceled ? "canceled" : uncertain ? "needs_verification" : delay ? "pending" : "blocked";
      const result = this.#putEvent({ ...current, state, reason, attempts, receipt,
        nextAt: receipt || canceled || !delay ? null : now + delay });
      const watch = this.get(event.watchId);
      if (receipt && watch?.state === "finishing" && watch.epoch === event.epoch) {
        this.#put({ ...watch, state: "completed", nextDueAt: null, reason: "delivered", revision: watch.revision + 1, updatedAt: now });
      }
      return result;
    });
  }

  retry(watch, eventId) {
    const event = this.event(eventId);
    if (!event || event.watchId !== watch.id) fail("WATCH_NOT_FOUND");
    if (REVIEW_RETRYABLE.includes(event.state)) {
      if (event.epoch !== watch.epoch || event.version !== watch.version || watch.definition.action !== "agent_review"
        || !["enabled", "finishing", "completed"].includes(watch.state)) fail("WATCH_CONFLICT");
      if (this.#backlog(watch.id) >= MAX_PENDING) fail("WATCH_CAPACITY");
      return this.#putEvent({ ...event, state: "review_queued", nextAt: this.now(), reason: null });
    }
    if ((!event.reconcileOnly && event.epoch !== watch.epoch) || !["blocked", "needs_verification", "pending"].includes(event.state)) fail("WATCH_CONFLICT");
    return this.#putEvent({ ...event, state: event.reconcileOnly ? "needs_verification" : "pending",
      nextAt: this.now(), attempts: 0, reason: null });
  }

  claimSystemNotice(eventId) {
    return this.#write(() => {
      const event = this.event(eventId);
      if (!event || event.state !== "published" || event.systemState) return null;
      return this.#putEvent({ ...event, systemState: "submitting" });
    });
  }

  settleSystemNotice(eventId, systemState) {
    return this.#write(() => {
      const event = this.event(eventId);
      if (event?.systemState === "submitting") this.#putEvent({ ...event, systemState });
    });
  }

  history(id, { cursor = null, limit = 10 } = {}) {
    this.#ready();
    const rows = this.db.prepare("SELECT seq,data FROM checks WHERE watch_id=? AND seq<? ORDER BY seq DESC LIMIT ?")
      .all(id, cursor ?? Number.MAX_SAFE_INTEGER, limit + 1);
    const checks = rows.slice(0, limit).map(parse);
    return { checks: checks.map(check => ({ ...check, event: check.eventId ? this.event(check.eventId) : null })),
      nextCursor: rows.length > limit ? rows[limit - 1].seq : null };
  }
}

module.exports = { ConditionWatchStore, WATCH_DB, WATCH_LOCK, REVIEW_LIMITS, destinationKey };
