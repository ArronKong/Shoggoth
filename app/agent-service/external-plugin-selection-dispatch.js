"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { sqliteNativeBinding } = require("./sqlite-native-binding");
const { assertPrivateRegularFile, ensurePrivateDirectoryTree, lstatIfExists,
  serviceError } = require("./security");
const { normalizePluginSelection, resolvePluginSelection } = require("./plugin-chat-selection");
const { validIdentity, validToken } = require("./external-plugin-lease");

const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const PREPARED_TTL_MS = 15 * 60_000;
const MAX_ACTIVE = 128;
const ACTIVE = new Set(["prepared", "bound"]);

function fail(code = "EXTERNAL_PLUGIN_SELECTION_INVALID") {
  throw serviceError(code, "外部插件选择派发无效、已失效或结果尚待核实");
}
function plain(value, fields) {
  return value && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === fields.length
    && fields.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    });
}
function id(value, max = 256) {
  return typeof value === "string" && OPAQUE.test(value)
    && Buffer.byteLength(value, "utf8") <= max;
}
function validSubject(value) {
  return plain(value, ["backendId", "instanceId", "agentId", "sessionId"])
    && ["openclaw", "hermes"].includes(value.backendId)
    && id(value.instanceId, 128) && id(value.agentId, 128) && id(value.sessionId);
}
function validExecutionIdentity(value) {
  if (!value || typeof value !== "object") return false;
  const backend = Object.getOwnPropertyDescriptor(value, "backendId")?.value;
  return plain(value, backend === "openclaw"
    ? ["backendId", "instanceId", "agentId", "sessionId", "runId"]
    : ["backendId", "instanceId", "agentId", "sessionId", "taskId", "turnId"])
    && validIdentity({ ...value, toolCallId: "selection-gate" });
}
function validEnvelope(value) {
  return plain(value, ["version", "operationId", "dispatchRef", "selectionDigest",
    "requiredAdapterId", "adapterGeneration"])
    && value.version === 1 && id(value.operationId, 128) && id(value.dispatchRef, 128)
    && typeof value.selectionDigest === "string" && HASH.test(value.selectionDigest)
    && id(value.requiredAdapterId, 128) && id(value.adapterGeneration, 128);
}
function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function canonicalSubject(value) {
  return { backendId: value.backendId, instanceId: value.instanceId,
    agentId: value.agentId, sessionId: value.sessionId };
}
function canonicalIdentity(value) {
  return { ...canonicalSubject(value), ...(value.backendId === "openclaw"
    ? { runId: value.runId } : { taskId: value.taskId, turnId: value.turnId }) };
}
function sameIdentity(left, right) {
  return validExecutionIdentity(left) && validExecutionIdentity(right)
    && Object.keys(left).every(key => left[key] === right[key]);
}
function operationKey(subject, operationId) {
  return hash([subject.backendId, subject.instanceId, subject.agentId, subject.sessionId, operationId]);
}
function publicReceipt(row) {
  return { version: 1, operationId: row.operation_id, dispatchRef: row.dispatch_ref,
    selectionDigest: row.selection_digest, requiredAdapterId: row.adapter_id,
    adapterGeneration: row.adapter_generation, state: row.state,
    subject: JSON.parse(row.subject_json), identity: JSON.parse(row.identity_json),
    createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at };
}
function envelopeOf(row) {
  const receipt = publicReceipt(row);
  return { version: 1, operationId: receipt.operationId, dispatchRef: receipt.dispatchRef,
    selectionDigest: receipt.selectionDigest, requiredAdapterId: receipt.requiredAdapterId,
    adapterGeneration: receipt.adapterGeneration };
}

// Service authority for one immutable selection operation. This does not
// authorize tools or prove that a Host has dispatched a model turn. The Host
// must enforce its mandatory gate and persist its own accepted/runnable receipt.
class ExternalPluginSelectionDispatch {
  #paths;
  #store;
  #catalog;
  #authorize;
  #now;
  #onRevoke;
  #db = null;
  #incarnation;

  constructor({ paths, store, toolCatalogRegistry = null, authorizeAdapter,
    now = Date.now, onRevokeExecution = null } = {}) {
    if (!paths?.pluginsDir || !path.isAbsolute(paths.pluginsDir)
      || !paths?.trustedRoot || !path.isAbsolute(paths.trustedRoot)
      || typeof store?.getAuthorityIncarnation !== "function"
      || typeof store?.getInstallation !== "function"
      || typeof store?.getRelease !== "function"
      || typeof authorizeAdapter !== "function" || typeof now !== "function"
      || (onRevokeExecution !== null && typeof onRevokeExecution !== "function")) {
      throw new TypeError("ExternalPluginSelectionDispatch requires Service authorities");
    }
    this.#paths = paths;
    this.#store = store;
    this.#catalog = toolCatalogRegistry;
    this.#authorize = authorizeAdapter;
    this.#now = now;
    this.#onRevoke = onRevokeExecution;
  }

  get path() { return path.join(this.#paths.pluginsDir, "external-selection-dispatch.sqlite"); }

  open() {
    if (this.#db) return this;
    ensurePrivateDirectoryTree(this.#paths.pluginsDir, this.#paths.trustedRoot);
    const existing = lstatIfExists(this.path);
    if (existing) assertPrivateRegularFile(this.path);
    const nativeBinding = sqliteNativeBinding();
    const db = new Database(this.path, nativeBinding ? { nativeBinding } : undefined);
    try {
      fs.chmodSync(this.path, 0o600);
      db.pragma("journal_mode = DELETE");
      db.pragma("synchronous = FULL");
      const version = db.pragma("user_version", { simple: true });
      const empty = version === 0 && !db.prepare(`SELECT 1 FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%' LIMIT 1`).get();
      if (version !== 1 && !empty) fail("EXTERNAL_PLUGIN_SELECTION_STORE_INVALID");
      if (empty) db.transaction(() => db.exec(`
        CREATE TABLE external_selection_dispatches (
          operation_key TEXT PRIMARY KEY, operation_id TEXT NOT NULL,
          dispatch_ref TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
          subject_json TEXT NOT NULL, selection_json TEXT NOT NULL,
          resolved_json TEXT NOT NULL, selection_digest TEXT NOT NULL,
          adapter_id TEXT NOT NULL, adapter_generation TEXT NOT NULL,
          authority_incarnation TEXT NOT NULL, service_incarnation TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('prepared','bound','completed',
            'canceled','expired','outcome_unknown')),
          identity_json TEXT NOT NULL, created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
        );
        PRAGMA user_version = 1;
      `))();
      // An actual Host execution can consume only one selection operation,
      // including after completion or unknown recovery. Retain the fence.
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS external_selection_execution
        ON external_selection_dispatches(identity_json) WHERE identity_json != 'null'`);
      // Restart never revives an old binding or silently reruns a dispatched
      // operation. Keep its fingerprint and identity for lost-ack observation.
      db.prepare(`UPDATE external_selection_dispatches SET state = 'outcome_unknown',
        updated_at = ? WHERE state IN ('prepared','bound')`).run(this.#time());
      this.#incarnation = crypto.randomUUID();
      this.#db = db;
      return this;
    } catch (error) { db.close(); throw error; }
  }

  #database() {
    if (!this.#db) fail("EXTERNAL_PLUGIN_SELECTION_UNAVAILABLE");
    return this.#db;
  }
  #time() {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0
      || now > Number.MAX_SAFE_INTEGER - PREPARED_TTL_MS) fail();
    return now;
  }
  #row(ref) {
    if (!id(ref, 128)) fail();
    const row = this.#database().prepare("SELECT * FROM external_selection_dispatches WHERE dispatch_ref = ?").get(ref);
    if (!row) fail();
    return row;
  }
  #validateCurrent(row) {
    if (!ACTIVE.has(row.state) || row.service_incarnation !== this.#incarnation
      || row.authority_incarnation !== this.#store.getAuthorityIncarnation()) fail();
    if (row.state === "prepared" && row.expires_at <= this.#time()) {
      this.#database().prepare(`UPDATE external_selection_dispatches SET state = 'expired',
        updated_at = ? WHERE dispatch_ref = ? AND state = 'prepared'`).run(this.#time(), row.dispatch_ref);
      fail();
    }
    const resolved = resolvePluginSelection(this.#store, JSON.parse(row.selection_json), this.#catalog);
    if (hash(resolved) !== row.selection_digest) fail("PLUGIN_SELECTION_STALE");
    return resolved;
  }

  prepare({ subject, operationId, requiredAdapterId, adapterGeneration, pluginSelection }) {
    if (!validSubject(subject) || !id(operationId, 128) || !id(requiredAdapterId, 128)
      || !id(adapterGeneration, 128)) fail();
    const selection = normalizePluginSelection(pluginSelection);
    if (!selection) fail();
    const key = operationKey(subject, operationId);
    const fingerprint = hash([canonicalSubject(subject), operationId,
      requiredAdapterId, adapterGeneration, selection]);
    const db = this.#database();
    return db.transaction(() => {
      const previous = db.prepare("SELECT * FROM external_selection_dispatches WHERE operation_key = ?").get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail("EXTERNAL_PLUGIN_SELECTION_CONFLICT");
        return { envelope: envelopeOf(previous), receipt: publicReceipt(previous) };
      }
      const now = this.#time();
      db.prepare(`UPDATE external_selection_dispatches SET state = 'expired', updated_at = ?
        WHERE state = 'prepared' AND expires_at <= ?`).run(now, now);
      if (db.prepare(`SELECT count(*) AS count FROM external_selection_dispatches
        WHERE state IN ('prepared','bound')`).get().count >= MAX_ACTIVE) {
        fail("EXTERNAL_PLUGIN_SELECTION_BUSY");
      }
      const resolved = resolvePluginSelection(this.#store, selection, this.#catalog);
      const ref = crypto.randomUUID();
      db.prepare(`INSERT INTO external_selection_dispatches VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 'null', ?, ?, ?)`).run(
        key, operationId, ref, fingerprint, JSON.stringify(canonicalSubject(subject)), JSON.stringify(selection),
        JSON.stringify(resolved), hash(resolved), requiredAdapterId, adapterGeneration,
        this.#store.getAuthorityIncarnation(), this.#incarnation, now, now, now + PREPARED_TTL_MS);
      const row = this.#row(ref);
      return { envelope: envelopeOf(row), receipt: publicReceipt(row) };
    })();
  }

  get({ subject, operationId }) {
    if (!validSubject(subject) || !id(operationId, 128)) fail();
    const row = this.#database().prepare("SELECT * FROM external_selection_dispatches WHERE operation_key = ?")
      .get(operationKey(subject, operationId));
    return row ? publicReceipt(row) : null;
  }

  async bind({ credentialToken, envelope, identity }) {
    if (!validToken(credentialToken) || !validEnvelope(envelope)
      || !validExecutionIdentity(identity)) fail();
    // Authorization may await a Host lookup. Never let its caller replace the
    // validated session/run or envelope while that lookup is in flight.
    envelope = Object.freeze({ ...envelope });
    identity = Object.freeze(canonicalIdentity(identity));
    const initial = this.#row(envelope.dispatchRef);
    const subject = JSON.parse(initial.subject_json);
    if (Object.keys(subject).some(key => subject[key] !== identity[key])
      || Object.keys(envelope).some(key => envelopeOf(initial)[key] !== envelope[key])) fail();
    if (await this.#authorize(identity.backendId, credentialToken, identity) !== true) fail();
    // Persist a known expiry outside the binding transaction; throwing from
    // inside that transaction would roll the expiry marker back as well.
    this.#validateCurrent(this.#row(envelope.dispatchRef));
    return this.#database().transaction(() => {
      const row = this.#row(envelope.dispatchRef);
      const resolved = this.#validateCurrent(row);
      if (row.state === "bound") {
        if (!sameIdentity(JSON.parse(row.identity_json), identity)) fail();
      } else {
        if (this.#database().prepare(`SELECT dispatch_ref FROM external_selection_dispatches
          WHERE identity_json = ? AND dispatch_ref != ? LIMIT 1`)
          .get(JSON.stringify(identity), row.dispatch_ref)) fail("EXTERNAL_PLUGIN_SELECTION_CONFLICT");
        this.#database().prepare(`UPDATE external_selection_dispatches SET state = 'bound',
          identity_json = ?, updated_at = ? WHERE dispatch_ref = ? AND state = 'prepared'`)
          .run(JSON.stringify(canonicalIdentity(identity)), this.#time(), row.dispatch_ref);
      }
      const bound = this.#row(row.dispatch_ref);
      return { envelope: envelopeOf(bound), receipt: publicReceipt(bound),
        selectedPlugins: copy(resolved) };
    })();
  }

  assertBound({ envelope, identity }) {
    if (!validEnvelope(envelope) || !validExecutionIdentity(identity)) fail();
    const row = this.#row(envelope.dispatchRef);
    if (row.state !== "bound"
      || Object.keys(envelope).some(key => envelopeOf(row)[key] !== envelope[key])
      || !sameIdentity(JSON.parse(row.identity_json), identity)) fail();
    return copy(this.#validateCurrent(row));
  }

  getExecutionSelection({ envelope, identity }) {
    if (!validExecutionIdentity(identity)) fail();
    // A scoped plugin facade must not silently downgrade the selected Host
    // run just because it accidentally created another adapter instance ID.
    // Exact instance equality is still enforced by assertBound below.
    const fields = Object.keys(canonicalIdentity(identity)).filter(field => field !== "instanceId");
    const row = this.#database().prepare(`SELECT * FROM external_selection_dispatches
      WHERE ${fields.map(field => `json_extract(identity_json, '$.${field}') = ?`).join(" AND ")}
      ORDER BY CASE WHEN json_extract(identity_json, '$.instanceId') = ? THEN 0 ELSE 1 END LIMIT 1`)
      .get(...fields.map(field => identity[field]), identity.instanceId);
    if (!row) {
      if (envelope !== undefined) fail();
      return null;
    }
    // A known selected execution cannot omit the envelope and fall back to
    // an ordinary lease after Stop, finish or Service restart.
    if (envelope === undefined) fail();
    return { envelope: copy(envelopeOf(row)), selectedPlugins: this.assertBound({ envelope, identity }) };
  }

  #revoke(row) {
    const identity = JSON.parse(row.identity_json);
    if (!identity || !this.#onRevoke) return;
    try { this.#onRevoke(identity); }
    catch { console.error("[agent-service] external selection lease cancellation deferred"); }
  }

  cancel({ subject, operationId }) {
    const receipt = this.get({ subject, operationId });
    if (!receipt) return null;
    const changed = this.#database().prepare(`UPDATE external_selection_dispatches SET state = 'canceled',
      updated_at = ? WHERE dispatch_ref = ? AND state IN ('prepared','bound')`)
      .run(this.#time(), receipt.dispatchRef);
    if (changed.changes === 1) this.#revoke(this.#row(receipt.dispatchRef));
    return this.get({ subject, operationId });
  }

  cancelSession({ subject }) {
    if (!validSubject(subject)) fail();
    const rows = this.#database().transaction(() => {
      const active = this.#database().prepare(`SELECT * FROM external_selection_dispatches
        WHERE subject_json = ? AND state IN ('prepared','bound') ORDER BY operation_key`)
        .all(JSON.stringify(canonicalSubject(subject)));
      const update = this.#database().prepare(`UPDATE external_selection_dispatches
        SET state = 'canceled', updated_at = ? WHERE dispatch_ref = ? AND state IN ('prepared','bound')`);
      const now = this.#time();
      for (const row of active) update.run(now, row.dispatch_ref);
      return active.map(row => this.#row(row.dispatch_ref));
    })();
    for (const row of rows) this.#revoke(row);
    return rows.map(publicReceipt);
  }

  async finish({ credentialToken, envelope, identity }) {
    if (!validToken(credentialToken) || !validEnvelope(envelope)
      || !validExecutionIdentity(identity)) fail();
    envelope = Object.freeze({ ...envelope });
    identity = Object.freeze(canonicalIdentity(identity));
    if (await this.#authorize(identity.backendId, credentialToken, identity) !== true) fail();
    const row = this.#row(envelope.dispatchRef);
    if (!["bound", "completed", "canceled"].includes(row.state)
      || (row.state === "bound" && row.service_incarnation !== this.#incarnation)
      || Object.keys(envelope).some(key => envelopeOf(row)[key] !== envelope[key])
      || !sameIdentity(JSON.parse(row.identity_json), identity)) fail();
    // Termination is not authority to run or send a tool. Permit a matching
    // already-bound Host to close its receipt even after installation revocation.
    // Completed/canceled records are durable observation, including a lost completion
    // acknowledgment followed by Service restart; it never restores a binding.
    const changed = this.#database().prepare(`UPDATE external_selection_dispatches SET state = 'completed',
      updated_at = ? WHERE dispatch_ref = ? AND state = 'bound'`)
      .run(this.#time(), envelope.dispatchRef);
    if (changed.changes === 1) this.#revoke(this.#row(envelope.dispatchRef));
    return publicReceipt(this.#row(envelope.dispatchRef));
  }

  close() {
    this.#db?.close();
    this.#db = null;
    this.#incarnation = null;
  }
}

module.exports = { ExternalPluginSelectionDispatch, validSubject,
  validEnvelope, validExecutionIdentity, MAX_ACTIVE, PREPARED_TTL_MS };
