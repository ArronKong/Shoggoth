"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { sqliteNativeBinding } = require("./sqlite-native-binding");
const { validIdentity } = require("./external-plugin-lease");
const { assertPrivateRegularFile, ensurePrivateDirectoryTree, lstatIfExists,
  serviceError } = require("./security");

const SCHEMA_VERSION = 4;
const JOURNAL_VERSION = 1;
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TOOL_ID = /^plugin:[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[a-f0-9]{64}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[a-f0-9]{64}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const APPROVAL_OUTCOMES = new Set(["approved", "denied", "expired", "withdrawn"]);
const MAX_PAGE = 20;
const MAX_RETAINED = 10_000;
const MAX_PENDING = 256;
const RECONCILE_BATCH = 256;
const LIVE_RETRY_BATCH = 32;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const APPROVAL_CONFLICT = Symbol("approval-conflict");

function fail(code = "EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE") {
  throw serviceError(code, "外部插件调用来源记录不可用");
}
function approvalConflict() {
  const error = serviceError("EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE", "外部插件调用来源记录不可用");
  error[APPROVAL_CONFLICT] = true;
  throw error;
}
function boundedId(value, max = 128) {
  return typeof value === "string" && value.length > 0
    && Buffer.byteLength(value, "utf8") <= max && !value.includes("\0");
}
function publicRow(row) {
  return { callId: row.call_id, backendId: row.backend_id, instanceId: row.instance_id,
    agentId: row.agent_id, sessionId: row.session_id, runId: row.run_id,
    taskId: row.task_id, turnId: row.turn_id, toolCallId: row.tool_call_id,
    bindingId: row.binding_id, installationId: row.installation_id,
    componentId: row.component_id, connectionId: row.connection_id,
    toolIdentity: row.tool_identity, toolName: row.tool_name,
    status: row.status, cancelRequested: row.cancel_requested === 1,
    resultDigest: row.result_digest, resultBytes: row.result_bytes,
    errorCode: row.error_code, approvalRequestId: row.approval_request_id,
    approvalOutcome: row.approval_outcome,
    approvalUpdatedAt: row.approval_updated_at,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
function primaryStatus(primary, { recovering = false, canceled = false } = {}) {
  if (primary?.phase === "result_confirmed") return "confirmed";
  if (primary?.phase === "rejected_before_send") {
    return canceled ? "canceled_before_send" : "rejected_before_send";
  }
  if (primary?.phase === "outcome_unknown" || primary?.phase === "send_started") {
    return canceled ? "canceled_outcome_unknown" : "outcome_unknown";
  }
  // A live failure with no primary receipt happened before dispatch. At
  // restart, a missing receipt can also mean an incomplete restore; never
  // certify that no remote side effect occurred in that case.
  if (recovering) return canceled ? "canceled_outcome_unknown" : "outcome_unknown";
  return canceled ? "canceled_before_send" : "rejected_before_send";
}
function statusWithoutApproval(primary, { canceled = false, knownPreDispatch = false } = {}) {
  if (primary?.phase === "rejected_before_send" || (knownPreDispatch && !primary)) {
    return canceled ? "canceled_before_send" : "rejected_before_send";
  }
  // Even a confirmed primary receipt cannot certify approval if the exact
  // decision is missing. Preserve an unknown audit status and never replay.
  return canceled ? "canceled_outcome_unknown" : "outcome_unknown";
}

// This database is a derived, local audit projection. Only PluginStore's
// capability_calls can authorize or classify egress; no audit row is ever
// accepted as an execution receipt. Arguments, result bodies and credentials
// are intentionally absent.
class ExternalPluginProvenance {
  #paths;
  #store;
  #now;
  #maxDeferred;
  #maxJournal;
  #db = null;
  #journal = null;
  #recoveryPending = new Set();
  // Keep only bounded derived metadata when an audit update fails. Exact
  // approval events are also retained in the durable journal. No tool result
  // is retained or retried.
  #deferred = new Map();
  // If the in-memory queue is full, retain a fail-closed call-ID fence until
  // the durable journal event replays into the audit projection.
  #unrecordedApprovals = new Set();

  constructor({ paths, store, now = Date.now, maxDeferred = MAX_PENDING,
    maxJournal = MAX_PENDING } = {}) {
    if (!paths?.pluginsDir || !paths?.trustedRoot
      || typeof store?.getCapabilityCall !== "function" || typeof now !== "function"
      || !Number.isSafeInteger(maxDeferred) || maxDeferred < 1 || maxDeferred > MAX_PENDING
      || !Number.isSafeInteger(maxJournal) || maxJournal < 1 || maxJournal > MAX_PENDING) {
      throw new TypeError("ExternalPluginProvenance requires Service paths and PluginStore");
    }
    this.#paths = paths;
    this.#store = store;
    this.#now = now;
    this.#maxDeferred = maxDeferred;
    this.#maxJournal = maxJournal;
  }

  get path() { return path.join(this.#paths.pluginsDir, "external-provenance.sqlite"); }
  get journalPath() { return path.join(this.#paths.pluginsDir, "external-approval-journal.sqlite"); }

  open() {
    if (this.#db) return this;
    ensurePrivateDirectoryTree(this.#paths.pluginsDir, this.#paths.trustedRoot);
    const existing = lstatIfExists(this.path);
    if (existing) assertPrivateRegularFile(this.path);
    const nativeBinding = sqliteNativeBinding();
    const db = new Database(this.path, nativeBinding ? { nativeBinding } : undefined);
    this.#db = db;
    try {
      fs.chmodSync(this.path, 0o600);
      db.pragma("journal_mode = DELETE");
      db.pragma("synchronous = FULL");
      const version = db.pragma("user_version", { simple: true });
      // SQLite may have created an empty file before a first-run crash.
      // Recover only that exact empty schema, never an unknown existing DB.
      const emptySchema = version === 0 && !db.prepare(`SELECT 1 FROM sqlite_master
        WHERE type IN ('table', 'view', 'trigger', 'index') AND name NOT LIKE 'sqlite_%' LIMIT 1`).get();
      if (existing && ![1, 2, 3, SCHEMA_VERSION].includes(version) && !emptySchema) {
        fail("EXTERNAL_PLUGIN_AUDIT_UNSUPPORTED");
      }
      if (!existing || emptySchema) db.transaction(() => db.exec(`
        CREATE TABLE external_plugin_calls (
          call_id TEXT PRIMARY KEY,
          backend_id TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          run_id TEXT,
          task_id TEXT,
          turn_id TEXT,
          tool_call_id TEXT NOT NULL,
          binding_id TEXT NOT NULL,
          installation_id TEXT NOT NULL,
          component_id TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          tool_identity TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed',
            'rejected_before_send', 'canceled_before_send',
            'outcome_unknown', 'canceled_outcome_unknown')),
          cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0, 1)),
          result_digest TEXT,
          result_bytes INTEGER,
          error_code TEXT,
          approval_request_id TEXT,
          approval_outcome TEXT CHECK (approval_outcome IN
            ('approved', 'denied', 'expired', 'withdrawn')),
          approval_updated_at INTEGER,
          approval_required INTEGER NOT NULL CHECK (approval_required IN (0, 1)),
          approval_journal_gate INTEGER NOT NULL CHECK (approval_journal_gate IN (0, 1)),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX external_plugin_calls_order
          ON external_plugin_calls(created_at DESC, call_id DESC);
        PRAGMA user_version = 4;
      `))();
      else if (version === 1) db.transaction(() => db.exec(`
        ALTER TABLE external_plugin_calls ADD COLUMN approval_request_id TEXT;
        ALTER TABLE external_plugin_calls ADD COLUMN approval_outcome TEXT
          CHECK (approval_outcome IN ('approved', 'denied', 'expired', 'withdrawn'));
        ALTER TABLE external_plugin_calls ADD COLUMN approval_updated_at INTEGER;
        -- Legacy pending rows may have awaited approval. Keep them pending
        -- after restart rather than inferring an outcome we cannot recover.
        ALTER TABLE external_plugin_calls ADD COLUMN approval_required INTEGER
          NOT NULL DEFAULT 1 CHECK (approval_required IN (0, 1));
        ALTER TABLE external_plugin_calls ADD COLUMN approval_journal_gate INTEGER
          NOT NULL DEFAULT 0 CHECK (approval_journal_gate IN (0, 1));
        PRAGMA user_version = 4;
      `))();
      else if (version === 2) db.transaction(() => db.exec(`
        ALTER TABLE external_plugin_calls ADD COLUMN approval_required INTEGER
          NOT NULL DEFAULT 1 CHECK (approval_required IN (0, 1));
        ALTER TABLE external_plugin_calls ADD COLUMN approval_journal_gate INTEGER
          NOT NULL DEFAULT 0 CHECK (approval_journal_gate IN (0, 1));
        PRAGMA user_version = 4;
      `))();
      else if (version === 3) db.transaction(() => db.exec(`
        ALTER TABLE external_plugin_calls ADD COLUMN approval_journal_gate INTEGER
          NOT NULL DEFAULT 0 CHECK (approval_journal_gate IN (0, 1));
        PRAGMA user_version = 4;
      `))();
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'external_plugin_calls'").get()) {
        fail("EXTERNAL_PLUGIN_AUDIT_CORRUPT");
      }
      const journalExisting = lstatIfExists(this.journalPath);
      if (journalExisting) assertPrivateRegularFile(this.journalPath);
      const journal = new Database(this.journalPath, nativeBinding ? { nativeBinding } : undefined);
      this.#journal = journal;
      fs.chmodSync(this.journalPath, 0o600);
      journal.pragma("journal_mode = DELETE");
      journal.pragma("synchronous = FULL");
      const journalVersion = journal.pragma("user_version", { simple: true });
      const emptyJournal = journalVersion === 0 && !journal.prepare(`SELECT 1 FROM sqlite_master
        WHERE type IN ('table', 'view', 'trigger', 'index') AND name NOT LIKE 'sqlite_%' LIMIT 1`).get();
      if (journalExisting && journalVersion !== JOURNAL_VERSION && !emptyJournal) {
        fail("EXTERNAL_PLUGIN_AUDIT_UNSUPPORTED");
      }
      if (!journalExisting || emptyJournal) journal.transaction(() => journal.exec(`
        CREATE TABLE approval_events (
          call_id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK (outcome IN ('approved', 'denied', 'expired', 'withdrawn')),
          updated_at INTEGER NOT NULL
        );
        PRAGMA user_version = 1;
      `))();
      if (!journal.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'approval_events'").get()) {
        fail("EXTERNAL_PLUGIN_AUDIT_CORRUPT");
      }
      this.#recoveryPending = new Set(db.prepare(`SELECT call_id FROM external_plugin_calls
        WHERE status = 'pending'`).all().map(row => row.call_id));
      this.#retryJournal(MAX_PENDING);
      this.#retryDeferred();
      this.reconcile();
      return this;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  #database() { if (!this.#db) fail(); return this.#db; }
  #journalDatabase() { if (!this.#journal) fail(); return this.#journal; }
  #journalHasEvent(callId) {
    return Boolean(this.#journalDatabase().prepare(`SELECT 1 FROM approval_events
      WHERE call_id = ?`).get(callId));
  }

  begin({ callId, identity, bindingId, installationId, componentId,
    connectionId, toolIdentity, toolName, approvalRequired = false }) {
    if (!CALL_ID.test(callId) || !validIdentity(identity)
      || !BINDING_ID.test(bindingId) || !BINDING_ID.test(installationId)
      || !HASH.test(componentId) || !BINDING_ID.test(connectionId)
      || !TOOL_ID.test(toolIdentity) || !boundedId(toolName)
      || typeof approvalRequired !== "boolean") fail();
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) fail();
    try {
      if (this.#recoveryPending.size > 0) this.reconcile();
      if (this.#database().prepare(`SELECT COUNT(*) AS count FROM external_plugin_calls
        WHERE status = 'pending'`).get().count >= MAX_PENDING) fail();
      this.#database().prepare(`INSERT INTO external_plugin_calls
        (call_id, backend_id, instance_id, agent_id, session_id, run_id, task_id,
          turn_id, tool_call_id, binding_id, installation_id, component_id,
          connection_id, tool_identity, tool_name, status, cancel_requested,
          approval_required, approval_journal_gate, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`)
        .run(callId, identity.backendId, identity.instanceId, identity.agentId,
          identity.sessionId, identity.runId || null, identity.taskId || null,
          identity.turnId || null, identity.toolCallId, bindingId, installationId,
          componentId, connectionId, toolIdentity, toolName, approvalRequired ? 1 : 0,
          approvalRequired ? 1 : 0, now, now);
    } catch { fail(); }
  }

  requestCancel(callId) {
    if (!CALL_ID.test(callId)) fail();
    this.#database().prepare(`UPDATE external_plugin_calls SET cancel_requested = 1,
      updated_at = ? WHERE call_id = ? AND status = 'pending'`).run(this.#now(), callId);
  }

  #queueDeferred(callId, patch) {
    const current = this.#deferred.get(callId);
    if (!current && this.#deferred.size >= this.#maxDeferred) return false;
    this.#deferred.set(callId, { approval: current?.approval ?? null,
      settlement: current?.settlement ?? null, ...patch });
    return true;
  }

  #writeApproval(callId, { requestId, outcome, updatedAt }) {
    const db = this.#database();
    const row = db.prepare(`SELECT approval_request_id, approval_outcome, status, created_at
      FROM external_plugin_calls WHERE call_id = ?`).get(callId);
    if (!row) approvalConflict();
    if (row.approval_outcome !== null) {
      if (row.approval_request_id !== requestId || row.approval_outcome !== outcome) approvalConflict();
      return;
    }
    if (row.status !== "pending") approvalConflict();
    const decisionAt = Math.max(updatedAt, row.created_at);
    const written = db.prepare(`UPDATE external_plugin_calls SET
      approval_request_id = ?, approval_outcome = ?, approval_updated_at = ?,
      updated_at = MAX(updated_at, ?) WHERE call_id = ? AND status = 'pending'
      AND approval_outcome IS NULL`).run(requestId, outcome, decisionAt, decisionAt, callId);
    if (written.changes !== 1) fail();
  }

  // This tiny, separate SQLite database is a durable write-ahead record for
  // decisions when the derived audit table itself cannot be updated. It has
  // no credentials, arguments, result bodies or user-visible authority.
  // The broker commits the event before resolving/rejecting its promise, so
  // a crash cannot hide an already-delivered decision between those steps.
  journalApproval(callId, requestId, outcome) {
    if (!CALL_ID.test(callId) || !CALL_ID.test(requestId)
      || !APPROVAL_OUTCOMES.has(outcome)) fail();
    const updatedAt = this.#now();
    if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) fail();
    try {
      const row = this.#database().prepare(`SELECT status, approval_request_id,
        approval_outcome FROM external_plugin_calls WHERE call_id = ?`).get(callId);
      if (!row || (row.approval_outcome !== null
        && (row.approval_request_id !== requestId || row.approval_outcome !== outcome))
        || (row.status !== "pending" && row.approval_outcome === null)) approvalConflict();
      const journal = this.#journalDatabase();
      journal.transaction(() => {
        const current = journal.prepare(`SELECT request_id, outcome FROM approval_events
          WHERE call_id = ?`).get(callId);
        if (current) {
          if (current.request_id !== requestId || current.outcome !== outcome) approvalConflict();
          return;
        }
        if (journal.prepare("SELECT COUNT(*) AS count FROM approval_events").get().count >= this.#maxJournal) fail();
        journal.prepare(`INSERT INTO approval_events (call_id, request_id, outcome, updated_at)
          VALUES (?, ?, ?, ?)`).run(callId, requestId, outcome, updatedAt);
      })();
    } catch { fail(); }
  }

  #retryJournal(limit = LIVE_RETRY_BATCH) {
    const journal = this.#journalDatabase();
    const events = journal.prepare(`SELECT call_id, request_id, outcome, updated_at
      FROM approval_events ORDER BY rowid LIMIT ?`).all(limit);
    for (const event of events) {
      try {
        this.#writeApproval(event.call_id, { requestId: event.request_id,
          outcome: event.outcome, updatedAt: event.updated_at });
        journal.prepare("DELETE FROM approval_events WHERE call_id = ?").run(event.call_id);
        this.#unrecordedApprovals.delete(event.call_id);
      } catch (error) {
        if (error?.[APPROVAL_CONFLICT]) throw error;
        // A temporary SQLite write failure leaves this exact event intact;
        // other bounded events can still be retried independently.
      }
    }
  }

  recordApproval(callId, requestId, outcome) {
    if (!CALL_ID.test(callId) || !CALL_ID.test(requestId)
      || !APPROVAL_OUTCOMES.has(outcome)) fail();
    const updatedAt = this.#now();
    if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) fail();
    this.journalApproval(callId, requestId, outcome);
    const approval = Object.freeze({ requestId, outcome, updatedAt });
    try { this.#writeApproval(callId, approval); }
    catch (error) {
      // Retain the exact decision even when SQLite is closed. A semantic
      // conflict cannot pass settlement because the retry keeps failing.
      if (!error?.[APPROVAL_CONFLICT]
        && !this.#queueDeferred(callId, { approval })) this.#unrecordedApprovals.add(callId);
      fail();
    }
    this.#unrecordedApprovals.delete(callId);
    this.#retryJournal();
  }

  #settleRow(callId, { resultDigest, resultBytes, errorCode, canceled,
    approvalJournalUnavailable = false }) {
    const db = this.#database();
    const primary = this.#store.getCapabilityCall(callId);
    db.transaction(() => {
      const current = db.prepare(`SELECT status, cancel_requested, approval_required,
        approval_journal_gate, approval_outcome FROM external_plugin_calls WHERE call_id = ?`)
        .get(callId);
      if (current?.status !== "pending") fail();
      const missingApproval = current.approval_required === 1
        && current.approval_outcome === null;
      // A new gated call cannot reach dispatch until its exact decision is
      // durable. A still-journaled decision must replay before settlement;
      // an unjournaled broker failure may be closed without inventing one.
      if (missingApproval && (current.approval_journal_gate !== 1
        || this.#journalHasEvent(callId))) fail();
      const wasCanceled = canceled || current.cancel_requested === 1;
      const status = missingApproval
        ? statusWithoutApproval(primary, { canceled: wasCanceled,
          knownPreDispatch: approvalJournalUnavailable === true })
        : primaryStatus(primary, { canceled: wasCanceled });
      const updated = db.prepare(`UPDATE external_plugin_calls SET status = ?,
        cancel_requested = ?, result_digest = ?, result_bytes = ?, error_code = ?,
        updated_at = ? WHERE call_id = ? AND status = 'pending'`).run(status,
        canceled || current.cancel_requested === 1 ? 1 : 0,
        status === "confirmed" ? resultDigest : null,
        status === "confirmed" ? resultBytes : null,
        status === "confirmed" ? null : errorCode, this.#now(), callId);
      if (updated.changes !== 1) fail();
      this.#pruneSettled(db);
    })();
  }

  settle(callId, { result, error, canceled = false } = {}) {
    if (!CALL_ID.test(callId)) fail();
    this.#retryJournal();
    if (this.#unrecordedApprovals.has(callId)) fail();
    let resultDigest = null;
    let resultBytes = null;
    if (result !== undefined) {
      try {
        const json = JSON.stringify(result);
        if (typeof json === "string") {
          resultDigest = crypto.createHash("sha256").update(json).digest("hex");
          resultBytes = Buffer.byteLength(json, "utf8");
        }
      } catch { /* A confirmed primary call remains confirmed without a serializable digest. */ }
    }
    const projection = Object.freeze({ resultDigest, resultBytes,
      errorCode: ERROR_CODE.test(error?.code || "") ? error.code
        : error ? "UNCLASSIFIED" : null, canceled: canceled === true,
      approvalJournalUnavailable: error?.approvalJournalUnavailable === true });
    try {
      const deferred = this.#deferred.get(callId);
      if (deferred?.approval) this.#writeApproval(callId, deferred.approval);
      this.#settleRow(callId, projection);
    }
    catch (error) {
      // A derived-audit failure must not turn a confirmed remote write into an
      // apparent tool failure. Save only the digest/status inputs for a bounded
      // same-process retry; restart reconciliation uses the primary receipt.
      this.#queueDeferred(callId, { settlement: projection });
      throw error;
    }
    this.#deferred.delete(callId);
  }

  #retryDeferred() {
    if (this.#deferred.size === 0) return;
    const db = this.#database();
    for (const [callId, pending] of [...this.#deferred].slice(0, LIVE_RETRY_BATCH)) {
      try {
        const row = db.prepare("SELECT status FROM external_plugin_calls WHERE call_id = ?").get(callId);
        if (row?.status === "pending") {
          if (pending.approval) this.#writeApproval(callId, pending.approval);
          if (pending.settlement) this.#settleRow(callId, pending.settlement);
        }
        this.#deferred.delete(callId);
      } catch { break; /* Keep the read path available while audit storage is recovering. */ }
    }
  }

  reconcile() {
    this.#retryJournal(MAX_PENDING);
    const db = this.#database();
    const select = db.prepare(`SELECT call_id, cancel_requested, approval_required,
      approval_journal_gate, approval_outcome FROM external_plugin_calls
      WHERE status = 'pending' AND call_id > ? ORDER BY call_id LIMIT ?`);
    const update = db.prepare(`UPDATE external_plugin_calls SET status = ?, updated_at = ?
      WHERE call_id = ? AND status = 'pending'`);
    let after = "";
    for (;;) {
      const pending = select.all(after, RECONCILE_BATCH);
      if (pending.length === 0) break;
      const completed = [];
      db.transaction(() => {
        for (const row of pending) {
          if (!this.#recoveryPending.has(row.call_id)) continue;
          const missingApproval = row.approval_required === 1
            && row.approval_outcome === null;
          if ((missingApproval && (row.approval_journal_gate !== 1
            || this.#journalHasEvent(row.call_id)))
            || this.#unrecordedApprovals.has(row.call_id)
            || this.#deferred.get(row.call_id)?.approval) continue;
          const primary = this.#store.getCapabilityCall(row.call_id);
          const status = missingApproval
            ? statusWithoutApproval(primary, { canceled: row.cancel_requested === 1 })
            : primaryStatus(primary, { recovering: true,
              canceled: row.cancel_requested === 1 });
          update.run(status, this.#now(), row.call_id);
          completed.push(row.call_id);
        }
      })();
      for (const callId of completed) this.#recoveryPending.delete(callId);
      after = pending.at(-1).call_id;
    }
    const stillPending = db.prepare(`SELECT 1 FROM external_plugin_calls
      WHERE call_id = ? AND status = 'pending'`);
    for (const callId of this.#recoveryPending) {
      if (!stillPending.get(callId)) this.#recoveryPending.delete(callId);
    }
    db.transaction(() => this.#pruneSettled(db))();
  }

  #pruneSettled(db) {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) fail();
    db.prepare(`DELETE FROM external_plugin_calls WHERE status <> 'pending'
      AND updated_at < ?`).run(Math.max(0, now - RETENTION_MS));
    const count = db.prepare(`SELECT COUNT(*) AS count FROM external_plugin_calls
      WHERE status <> 'pending'`).get().count;
    if (count > MAX_RETAINED) db.prepare(`DELETE FROM external_plugin_calls WHERE call_id IN
      (SELECT call_id FROM external_plugin_calls WHERE status <> 'pending'
        ORDER BY created_at ASC, call_id ASC LIMIT ?)`).run(count - MAX_RETAINED);
  }

  list({ backendId = null, agentId = null, sessionId = null, toolCallId = null,
    cursor = null, limit = 10 } = {}) {
    if (backendId !== null && !["openclaw", "hermes"].includes(backendId)) fail("PLUGIN_REQUEST_INVALID");
    const scoped = agentId !== null || sessionId !== null || toolCallId !== null;
    if (scoped && (backendId === null || typeof agentId !== "string"
      || typeof sessionId !== "string" || typeof toolCallId !== "string"
      || !OPAQUE.test(agentId) || Buffer.byteLength(agentId, "utf8") > 128
      || !OPAQUE.test(sessionId) || Buffer.byteLength(sessionId, "utf8") > 256
      || !OPAQUE.test(toolCallId) || Buffer.byteLength(toolCallId, "utf8") > 256)) {
      fail("PLUGIN_REQUEST_INVALID");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE
      || (cursor !== null && (!cursor || Object.getPrototypeOf(cursor) !== Object.prototype
        || Object.keys(cursor).sort().join(",") !== "callId,createdAt"
        || !CALL_ID.test(cursor.callId) || !Number.isSafeInteger(cursor.createdAt)
        || cursor.createdAt < 0))) fail("PLUGIN_REQUEST_INVALID");
    this.#retryJournal();
    this.#retryDeferred();
    if (this.#recoveryPending.size > 0) this.reconcile();
    const rows = this.#database().prepare(`SELECT * FROM external_plugin_calls
      WHERE (? IS NULL OR backend_id = ?)
        AND (? IS NULL OR agent_id = ?)
        AND (? IS NULL OR session_id = ?)
        AND (? IS NULL OR tool_call_id = ?)
        AND (? IS NULL OR created_at < ? OR (created_at = ? AND call_id < ?))
      ORDER BY created_at DESC, call_id DESC LIMIT ?`).all(
        backendId, backendId, agentId, agentId, sessionId, sessionId,
        toolCallId, toolCallId, cursor?.createdAt ?? null, cursor?.createdAt ?? null,
        cursor?.createdAt ?? null, cursor?.callId ?? null, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { items: page.map(publicRow), nextCursor: rows.length > limit && last
      ? { createdAt: last.created_at, callId: last.call_id } : null };
  }

  close() {
    if (this.#journal) { this.#journal.close(); this.#journal = null; }
    if (this.#db) { this.#db.close(); this.#db = null; }
    this.#recoveryPending.clear();
  }
}

module.exports = { ExternalPluginProvenance, primaryStatus };
