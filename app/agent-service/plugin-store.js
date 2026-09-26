"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { sqliteNativeBinding } = require("./sqlite-native-binding");
const { assertPrivateDirectory, assertPrivateRegularFile, ensurePrivateDirectoryTree,
  lstatIfExists, serviceError } = require("./security");
const { componentId } = require("./plugin-component-catalog");

const SCHEMA_VERSION = 8;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const REQUIRED_TABLES = Object.freeze(["releases", "installations", "operations", "connections",
  "operation_intents", "bindings", "grants", "capability_epoch", "capability_calls", "authority_state"]);
// Cache only these compiled, parameterized statements, never their rows. Runtime
// catalog checks perform many reads in one event-loop turn; repeatedly preparing
// them retains native SQLite allocations until the JS wrappers are collected.
const READ_SQL = Object.freeze({
  authority: "SELECT * FROM authority_state WHERE id = 1",
  installation: "SELECT * FROM installations WHERE id = ?",
  connection: "SELECT * FROM connections WHERE id = ?",
  binding: "SELECT * FROM bindings WHERE id = ?",
  grant: "SELECT * FROM grants WHERE binding_id = ? AND tool_identity = ?",
  release: "SELECT * FROM releases WHERE source_identity = ? AND content_digest = ?",
  profileBindings: "SELECT * FROM bindings WHERE subject_kind = 'native-profile' AND subject_id = ? ORDER BY id",
});

function error(code, message) { return serviceError(code, message); }
function openPluginDatabase(file, options = {}) {
  const nativeBinding = sqliteNativeBinding();
  return new Database(file, { ...options, ...(nativeBinding ? { nativeBinding } : {}) });
}
function readJson(value) { return value === null ? null : JSON.parse(value); }
function authorityState(db) {
  return publicAuthorityState(db.prepare(READ_SQL.authority).get());
}
function publicAuthorityState(row) {
  if (!row || typeof row.incarnation !== "string" || !HASH_PATTERN.test(row.incarnation)
    || ![0, 1].includes(row.receipt_gap)
    || (row.restored_at !== null && (!Number.isSafeInteger(row.restored_at) || row.restored_at < 0))
    || (row.restored_from !== null && (typeof row.restored_from !== "string" || !ID_PATTERN.test(row.restored_from)))) {
    throw error("PLUGIN_STORE_CORRUPT", "插件权限代次无效");
  }
  return { incarnation: row.incarnation, restoredAt: row.restored_at,
    restoredFrom: row.restored_from, receiptGap: row.receipt_gap === 1 };
}
function assertOperationKnown(record) {
  if (record?.phase === "outcome_unknown") {
    throw error("PLUGIN_OPERATION_OUTCOME_UNKNOWN", "恢复前的插件操作尚未对账，禁止重新执行");
  }
}
function publicOperation(record) {
  if (!record) return null;
  return {
    operationId: record.id,
    kind: record.kind,
    phase: record.phase,
    result: readJson(record.result_json),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}
function publicInstallation(record) {
  if (!record) return null;
  return {
    installationId: record.id,
    sourceIdentity: record.source_identity,
    releaseDigest: record.release_digest,
    desiredState: record.desired_state,
    revision: record.revision,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}
function publicConnection(record) {
  if (!record) return null;
  return { connectionId: record.id, installationId: record.installation_id,
    componentId: record.component_id, endpointIdentity: record.endpoint_identity,
    principalIdentity: record.principal_identity, state: record.state,
    authRevision: record.auth_revision, revision: record.revision };
}
function publicBinding(record) {
  if (!record) return null;
  return { bindingId: record.id, subjectKind: record.subject_kind,
    subjectId: record.subject_id, installationId: record.installation_id,
    componentId: record.component_id, componentKind: record.component_kind,
    connectionId: record.connection_id,
    enabled: record.enabled === 1, revision: record.revision };
}
function publicGrant(record) {
  if (!record) return null;
  return { grantId: record.id, bindingId: record.binding_id,
    connectionId: record.connection_id, principalIdentity: record.principal_identity,
    toolIdentity: record.tool_identity, contractDigest: record.contract_digest,
    effect: record.effect, approvalMode: record.approval_mode,
    argumentScope: null, expiresAt: record.expires_at,
    epoch: record.epoch, revision: record.revision };
}
function publicCapabilityCall(record) {
  if (!record) return null;
  return { callId: record.id, runRef: record.run_ref,
    bindingId: record.binding_id, connectionId: record.connection_id,
    principalIdentity: record.principal_identity, toolIdentity: record.tool_identity,
    contractDigest: record.contract_digest, argumentDigest: record.argument_digest,
    phase: record.phase, createdAt: record.created_at, updatedAt: record.updated_at };
}

// Read-only startup gate. The Product15 Service calls this under its instance
// lock before opening any credential or Product writer. PluginStore.open still
// repeats its own checks because a local path may change between the two calls.
function assertPluginCatalogBaseline(paths) {
  const directory = lstatIfExists(paths.pluginsDir);
  if (directory) assertPrivateDirectory(paths.pluginsDir);
  const catalog = lstatIfExists(paths.pluginCatalogPath);
  if (!catalog) return;
  assertPrivateRegularFile(paths.pluginCatalogPath);
  let db;
  try {
    db = openPluginDatabase(paths.pluginCatalogPath, { readonly: true, fileMustExist: true });
    if (db.pragma("user_version", { simple: true }) !== SCHEMA_VERSION) {
      throw error("PLUGIN_STORE_UNSUPPORTED", "插件账本版本不受支持");
    }
    for (const table of REQUIRED_TABLES) {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table)) throw error("PLUGIN_STORE_CORRUPT", "插件账本缺少必要表");
    }
    authorityState(db);
  } catch (failure) {
    if (failure?.code === "PLUGIN_STORE_UNSUPPORTED" || failure?.code === "PLUGIN_STORE_CORRUPT") {
      throw failure;
    }
    throw error("PLUGIN_STORE_CORRUPT", "插件账本无法只读校验");
  } finally { db?.close(); }
}

// Offline restore reads only replay-prevention evidence from the current
// source. The backup owner must hold the stopped-Service boundary around this.
function readPluginRestoreBarrier(paths) {
  if (!lstatIfExists(paths.pluginCatalogPath)) return null;
  assertPluginCatalogBaseline(paths);
  const db = openPluginDatabase(paths.pluginCatalogPath, { readonly: true, fileMustExist: true });
  try {
    return db.transaction(() => ({ authority: authorityState(db),
      operations: db.prepare("SELECT * FROM operations").all(),
      calls: db.prepare("SELECT * FROM capability_calls").all() }))();
  } finally { db.close(); }
}

class PluginStore {
  #readStatements = new Map();
  #capabilityToolsReader = null;
  constructor({ paths, now = Date.now } = {}) {
    if (!paths?.trustedRoot || !paths?.pluginCatalogPath || !paths?.pluginPackagesDir
      || !paths?.pluginStagingDir || path.dirname(paths.pluginCatalogPath) !== paths.pluginsDir) {
      throw new TypeError("PluginStore requires Service plugin paths");
    }
    this.paths = paths;
    this.now = now;
    this.db = null;
  }

  open() {
    if (this.db) return this;
    for (const directory of [this.paths.pluginsDir, this.paths.pluginPackagesDir,
      this.paths.pluginStagingDir, this.paths.pluginDataDir]) {
      ensurePrivateDirectoryTree(directory, this.paths.trustedRoot);
    }
    let catalogStat = null;
    try { catalogStat = fs.lstatSync(this.paths.pluginCatalogPath); }
    catch (failure) { if (failure?.code !== "ENOENT") throw failure; }
    const existing = catalogStat !== null;
    if (existing) {
      const stat = catalogStat;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
        throw error("PLUGIN_STORE_UNSAFE", "插件账本路径不安全");
      }
    }
    this.db = openPluginDatabase(this.paths.pluginCatalogPath);
    try {
      const version = this.db.pragma("user_version", { simple: true });
      if (existing && version !== SCHEMA_VERSION) {
        throw error("PLUGIN_STORE_UNSUPPORTED", "插件账本版本不受支持");
      }
      fs.chmodSync(this.paths.pluginCatalogPath, 0o600);
      this.db.pragma("journal_mode = DELETE");
      this.db.pragma("synchronous = FULL");
      this.db.pragma("foreign_keys = ON");
      if (!existing) {
        this.db.transaction(() => this.db.exec(`
          CREATE TABLE releases (
            source_identity TEXT NOT NULL,
            content_digest TEXT NOT NULL,
            name TEXT NOT NULL,
            declared_version TEXT,
            manifest_json TEXT NOT NULL,
            components_json TEXT NOT NULL,
            diagnostics_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (source_identity, content_digest)
          );
          CREATE TABLE installations (
            id TEXT PRIMARY KEY,
            source_identity TEXT NOT NULL UNIQUE,
            release_digest TEXT NOT NULL,
            desired_state TEXT NOT NULL CHECK (desired_state IN ('disabled', 'enabled', 'uninstalled')),
            revision INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (source_identity, release_digest)
              REFERENCES releases(source_identity, content_digest)
          );
          CREATE TABLE operations (
            id TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            kind TEXT NOT NULL,
            phase TEXT NOT NULL,
            result_json TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE operation_intents (
            operation_id TEXT PRIMARY KEY REFERENCES operations(id),
            installation_id TEXT NOT NULL REFERENCES installations(id),
            desired_state TEXT NOT NULL CHECK (desired_state IN ('disabled', 'uninstalled')),
            expected_revision INTEGER NOT NULL
          );
          CREATE INDEX operation_intents_installation ON operation_intents(installation_id);
          CREATE TABLE connections (
            id TEXT PRIMARY KEY,
            installation_id TEXT NOT NULL REFERENCES installations(id),
            component_id TEXT NOT NULL,
            endpoint_identity TEXT NOT NULL,
            principal_identity TEXT,
            credential_ref TEXT,
            state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'disconnected')),
            auth_revision INTEGER NOT NULL,
            revision INTEGER NOT NULL
          );
          CREATE TABLE bindings (
            id TEXT PRIMARY KEY,
            subject_kind TEXT NOT NULL CHECK (subject_kind = 'native-profile'),
            subject_id TEXT NOT NULL,
            installation_id TEXT NOT NULL REFERENCES installations(id),
            component_id TEXT NOT NULL,
            component_kind TEXT NOT NULL CHECK (component_kind IN ('skill', 'mcp-server')),
            connection_id TEXT REFERENCES connections(id),
            enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
            revision INTEGER NOT NULL,
            CHECK ((component_kind = 'skill' AND connection_id IS NULL)
              OR (component_kind = 'mcp-server' AND connection_id IS NOT NULL)),
            UNIQUE (subject_kind, subject_id, installation_id, component_id)
          );
          CREATE TABLE grants (
            id TEXT PRIMARY KEY,
            binding_id TEXT NOT NULL REFERENCES bindings(id),
            connection_id TEXT NOT NULL REFERENCES connections(id),
            principal_identity TEXT NOT NULL,
            tool_identity TEXT NOT NULL,
            contract_digest TEXT NOT NULL,
            effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
            approval_mode TEXT NOT NULL CHECK (approval_mode IN ('always', 'each-call')),
            expires_at INTEGER,
            epoch INTEGER NOT NULL,
            revision INTEGER NOT NULL,
            UNIQUE (binding_id, tool_identity)
          );
          CREATE TABLE capability_epoch (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
          INSERT INTO capability_epoch (id, value) VALUES (1, 0);
          CREATE TABLE authority_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            incarnation TEXT NOT NULL,
            restored_at INTEGER,
            restored_from TEXT,
            receipt_gap INTEGER NOT NULL CHECK (receipt_gap IN (0, 1))
          );
          INSERT INTO authority_state (id, incarnation, restored_at, restored_from, receipt_gap)
            VALUES (1, lower(hex(randomblob(32))), NULL, NULL, 0);
          CREATE TABLE capability_calls (
            id TEXT PRIMARY KEY,
            run_ref TEXT NOT NULL,
            binding_id TEXT NOT NULL,
            connection_id TEXT NOT NULL,
            principal_identity TEXT NOT NULL,
            tool_identity TEXT NOT NULL,
            contract_digest TEXT NOT NULL,
            argument_digest TEXT NOT NULL,
            phase TEXT NOT NULL CHECK (phase IN
              ('prepared', 'send_started', 'result_confirmed', 'outcome_unknown', 'rejected_before_send')),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          PRAGMA user_version = 8;
        `))();
      }
      for (const table of REQUIRED_TABLES) {
        if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
          throw error("PLUGIN_STORE_CORRUPT", "插件账本缺少必要表");
        }
      }
      authorityState(this.db);
      // A send may have reached a remote server before this process died. A
      // restarted Service must never turn that attempt into a fresh call.
      this.db.transaction(() => {
        const now = this.now();
        this.db.prepare(`UPDATE capability_calls SET phase = 'rejected_before_send', updated_at = ?
          WHERE phase = 'prepared'`).run(now);
        this.db.prepare(`UPDATE capability_calls SET phase = 'outcome_unknown', updated_at = ?
          WHERE phase = 'send_started'`).run(now);
      })();
      return this;
    } catch (failure) {
      this.close();
      throw failure;
    }
  }

  close() {
    if (this.db) { this.db.close(); this.db = null; }
    this.#readStatements.clear(); this.#capabilityToolsReader = null;
  }
  _db() {
    if (!this.db) throw error("PLUGIN_STORE_CLOSED", "插件账本未打开");
    return this.db;
  }
  _readStatement(name) {
    const db = this._db();
    if (!Object.hasOwn(READ_SQL, name)) throw new TypeError("Unknown plugin read statement");
    let statement = this.#readStatements.get(name);
    if (!statement) { statement = db.prepare(READ_SQL[name]); this.#readStatements.set(name, statement); }
    return statement;
  }
  getAuthorityState() { return publicAuthorityState(this._readStatement("authority").get()); }
  getAuthorityIncarnation() { return this.getAuthorityState().incarnation; }

  // Called only on an isolated, unpublished restore staging tree. The caller
  // closes the Store and fsyncs it before the target directory becomes visible.
  rotateAuthorityForRestore({ backupId, replayBarrier = null } = {}) {
    if (typeof backupId !== "string" || !ID_PATTERN.test(backupId)
      || (replayBarrier !== null && (!Array.isArray(replayBarrier.operations)
        || !Array.isArray(replayBarrier.calls)))) {
      throw error("PLUGIN_RESTORE_INVALID", "插件恢复屏障参数无效");
    }
    const db = this._db();
    return db.transaction(() => {
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0) throw error("PLUGIN_RESTORE_INVALID", "恢复时间无效");
      const previous = authorityState(db);
      const incarnation = crypto.randomBytes(32).toString("hex");
      let importedOperations = 0; let importedCalls = 0;
      // Evidence absent from the older snapshot reserves its IDs forever. It
      // conveys no configuration, account, Grant or executable authority.
      const insertOperation = db.prepare(`INSERT OR IGNORE INTO operations
        (id, fingerprint, kind, phase, result_json, created_at, updated_at)
        VALUES (?, ?, ?, 'outcome_unknown', ?, ?, ?)`);
      for (const operation of replayBarrier?.operations || []) {
        importedOperations += insertOperation.run(operation.id, operation.fingerprint, operation.kind,
          JSON.stringify({ code: "PLUGIN_RESTORE_RECONCILIATION_REQUIRED" }), operation.created_at, now).changes;
      }
      const insertCall = db.prepare(`INSERT OR IGNORE INTO capability_calls
        (id, run_ref, binding_id, connection_id, principal_identity, tool_identity,
          contract_digest, argument_digest, phase, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'outcome_unknown', ?, ?)`);
      for (const call of replayBarrier?.calls || []) {
        importedCalls += insertCall.run(call.id, call.run_ref, call.binding_id, call.connection_id,
          call.principal_identity, call.tool_identity, call.contract_digest, call.argument_digest,
          call.created_at, now).changes;
      }
      const epoch = db.prepare("UPDATE capability_epoch SET value = value + 1 WHERE id = 1 RETURNING value").get().value;
      const grants = db.prepare("UPDATE grants SET effect = 'deny', epoch = ?, revision = revision + 1").run(epoch).changes;
      const connections = db.prepare(`UPDATE connections SET state = 'disconnected',
        auth_revision = auth_revision + 1, revision = revision + 1`).run().changes;
      const bindings = db.prepare("UPDATE bindings SET enabled = 0, revision = revision + 1").run().changes;
      const installations = db.prepare(`UPDATE installations SET desired_state = 'disabled',
        revision = revision + 1, updated_at = ? WHERE desired_state != 'uninstalled'`).run(now).changes;
      const operations = db.prepare(`UPDATE operations SET phase = 'outcome_unknown', result_json = ?, updated_at = ?
        WHERE phase != 'completed'`).run(JSON.stringify({ code: "PLUGIN_RESTORE_RECONCILIATION_REQUIRED" }), now).changes;
      // open() may have already normalized prepared to rejected_before_send;
      // either state in an old snapshot is uncertain relative to later sends.
      const calls = db.prepare(`UPDATE capability_calls SET phase = 'outcome_unknown', updated_at = ?
        WHERE phase != 'result_confirmed'`).run(now).changes;
      const receiptGap = replayBarrier === null || replayBarrier.authority?.receiptGap === true;
      db.prepare(`UPDATE authority_state SET incarnation = ?, restored_at = ?, restored_from = ?,
        receipt_gap = ? WHERE id = 1`).run(incarnation, now, backupId, receiptGap ? 1 : 0);
      return { authorityIncarnation: incarnation, previousIncarnation: previous.incarnation,
        restoredFrom: backupId, restoredAt: now, receiptGap, grantsRequireConfirmation: grants,
        disconnectedConnections: connections, disabledBindings: bindings, disabledInstallations: installations,
        unknownOperations: operations, unknownCalls: calls, importedOperations, importedCalls };
    })();
  }
  getOperation(operationId) {
    if (!ID_PATTERN.test(operationId)) throw error("PLUGIN_OPERATION_INVALID", "operationId 无效");
    return publicOperation(this._db().prepare("SELECT * FROM operations WHERE id = ?").get(operationId));
  }
  listInstallations() {
    return this._db().prepare("SELECT * FROM installations WHERE desired_state != 'uninstalled' ORDER BY created_at, id")
      .all().map(publicInstallation);
  }
  getInstallation(installationId) {
    if (!ID_PATTERN.test(installationId)) throw error("PLUGIN_INSTALLATION_INVALID", "installationId 无效");
    return publicInstallation(this._readStatement("installation").get(installationId));
  }
  getBySource(sourceIdentity) {
    return publicInstallation(this._db().prepare("SELECT * FROM installations WHERE source_identity = ?")
      .get(sourceIdentity));
  }
  getRelease(sourceIdentity, digest) {
    if (typeof sourceIdentity !== "string" || !HASH_PATTERN.test(digest)) {
      throw error("PLUGIN_RELEASE_INVALID", "release identity 无效");
    }
    const record = this._readStatement("release")
      .get(sourceIdentity, digest);
    return record && {
      contentDigest: record.content_digest,
      sourceIdentity: record.source_identity,
      name: record.name,
      declaredVersion: record.declared_version,
      manifest: readJson(record.manifest_json),
      components: readJson(record.components_json),
      diagnostics: readJson(record.diagnostics_json),
      createdAt: record.created_at,
    };
  }
  listReleasesForInstallation(installationId) {
    const installation = this.getInstallation(installationId);
    if (!installation) throw error("PLUGIN_INSTALLATION_INVALID", "插件安装不存在");
    return this._db().prepare(`SELECT content_digest AS digest, name, declared_version AS version
      FROM releases WHERE source_identity = ? ORDER BY created_at DESC, content_digest LIMIT 65`)
      .all(installation.sourceIdentity);
  }
  beginInstall({ operationId, fingerprint }) {
    if (!ID_PATTERN.test(operationId) || !HASH_PATTERN.test(fingerprint)) {
      throw error("PLUGIN_OPERATION_INVALID", "安装操作标识无效");
    }
    const db = this._db();
    return db.transaction(() => {
      const existing = db.prepare("SELECT * FROM operations WHERE id = ?").get(operationId);
      if (existing) {
        if (existing.kind !== "install" || existing.fingerprint !== fingerprint) {
          throw error("REVISION_CONFLICT", "operationId 已用于其他参数");
        }
        assertOperationKnown(existing);
        return publicOperation(existing);
      }
      const now = this.now();
      db.prepare("INSERT INTO operations (id, fingerprint, kind, phase, result_json, created_at, updated_at) VALUES (?, ?, 'install', 'created', NULL, ?, ?)")
        .run(operationId, fingerprint, now, now);
      return this.getOperation(operationId);
    })();
  }
  commitInstall({ operationId, fingerprint, installationId, sourceIdentity,
    expectedRevision, preview, activateOnInstall = false }) {
    if (!ID_PATTERN.test(operationId) || !ID_PATTERN.test(installationId)
      || !HASH_PATTERN.test(fingerprint) || !HASH_PATTERN.test(preview?.contentDigest)
      || typeof sourceIdentity !== "string" || sourceIdentity.length > 4096
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || typeof activateOnInstall !== "boolean") {
      throw error("PLUGIN_OPERATION_INVALID", "安装提交参数无效");
    }
    const db = this._db();
    return db.transaction(() => {
      const operation = db.prepare("SELECT * FROM operations WHERE id = ?").get(operationId);
      if (!operation || operation.fingerprint !== fingerprint || operation.kind !== "install") {
        throw error("REVISION_CONFLICT", "安装操作不存在或参数变化");
      }
      assertOperationKnown(operation);
      if (operation.phase === "completed") return readJson(operation.result_json);
      const existing = db.prepare("SELECT * FROM installations WHERE source_identity = ?").get(sourceIdentity);
      if (existing && existing.id !== installationId) {
        throw error("REVISION_CONFLICT", "安装来源已被其他安装占用");
      }
      if ((existing?.revision || 0) !== expectedRevision) {
        throw error("REVISION_CONFLICT", "安装版本已变化，请重新预览");
      }
      if (existing && this.hasPendingInstallationDisable(existing.id)) {
        throw error("ACTIVATION_DEFERRED", "安装正等待停用连接排空");
      }
      if (existing && existing.release_digest !== preview.contentDigest
        && existing.desired_state === "enabled") {
        throw error("PLUGIN_UPDATE_REQUIRES_DISABLE", "更新前必须先停用并排空旧连接");
      }
      if (existing && existing.release_digest !== preview.contentDigest
        && this.getRelease(sourceIdentity, preview.contentDigest)) {
        throw error("PLUGIN_ROLLBACK_REQUIRES_PREVIEW", "恢复已使用的代码版本须先核对数据回退预览");
      }
      const now = this.now();
      db.prepare(`INSERT OR IGNORE INTO releases
        (content_digest, source_identity, name, declared_version, manifest_json,
          components_json, diagnostics_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        preview.contentDigest, sourceIdentity, preview.name, preview.declaredVersion,
        JSON.stringify({ name: preview.name, version: preview.declaredVersion, specVersion: preview.specVersion }),
        JSON.stringify({ skills: preview.skills, mcpServers: preview.mcpServers }),
        JSON.stringify(preview.diagnostics), now,
      );
      if (existing && (existing.release_digest !== preview.contentDigest
        || existing.desired_state === "uninstalled")) {
        db.prepare("UPDATE installations SET release_digest = ?, desired_state = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
          .run(preview.contentDigest, activateOnInstall ? "enabled" : "disabled", now, installationId);
        // A new package generation must not silently reactivate the previous
        // Skill text or MCP contract when the installation is enabled again.
        db.prepare("UPDATE bindings SET enabled = 0, revision = revision + 1 WHERE installation_id = ?")
          .run(installationId);
        const epoch = db.prepare("UPDATE capability_epoch SET value = value + 1 WHERE id = 1 RETURNING value")
          .get().value;
        db.prepare(`UPDATE grants SET effect = 'deny', epoch = ?, revision = revision + 1
          WHERE binding_id IN (SELECT id FROM bindings WHERE installation_id = ?)`).run(
          epoch, installationId);
      } else if (!existing) {
        db.prepare(`INSERT INTO installations
          (id, source_identity, release_digest, desired_state, revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, ?)`).run(
          installationId, sourceIdentity, preview.contentDigest,
          activateOnInstall ? "enabled" : "disabled", now, now,
        );
      } else if (activateOnInstall && existing.desired_state === "disabled") {
        db.prepare("UPDATE installations SET desired_state = 'enabled', revision = revision + 1, updated_at = ? WHERE id = ?")
          .run(now, installationId);
      }
      const result = this.getInstallation(installationId);
      db.prepare("UPDATE operations SET phase = 'completed', result_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(result), now, operationId);
      return result;
    })();
  }
  markFailed(operationId, failureCode) {
    if (!ID_PATTERN.test(operationId) || typeof failureCode !== "string") return;
    this._db().prepare(`UPDATE operations SET phase = 'failed', result_json = ?, updated_at = ? WHERE id = ?
      AND phase NOT IN ('completed', 'outcome_unknown') AND kind NOT IN ('data-snapshot', 'code-rollback', 'data-restore')`)
      .run(JSON.stringify({ code: failureCode }), this.now(), operationId);
  }

  beginInstallationDisable({ operationId, fingerprint, installationId,
    expectedRevision }) {
    if (!ID_PATTERN.test(operationId) || !HASH_PATTERN.test(fingerprint)
      || !ID_PATTERN.test(installationId)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw error("PLUGIN_OPERATION_INVALID", "停用操作参数无效");
    }
    return this._db().transaction(() => {
      const db = this._db();
      const previous = db.prepare("SELECT * FROM operations WHERE id = ?").get(operationId);
      if (previous) {
        if (previous.kind !== "installation-state" || previous.fingerprint !== fingerprint) {
          throw error("REVISION_CONFLICT", "operationId 已用于其他参数");
        }
        assertOperationKnown(previous);
        if (previous.phase === "created") {
          const intent = db.prepare("SELECT * FROM operation_intents WHERE operation_id = ?")
            .get(operationId);
          if (!intent || intent.installation_id !== installationId
            || intent.desired_state !== "disabled"
            || intent.expected_revision !== expectedRevision) {
            throw error("PLUGIN_STORE_CORRUPT", "停用意图与操作不一致");
          }
          const current = this.getInstallation(installationId);
          if (!current || current.revision !== expectedRevision) {
            db.prepare(`UPDATE operations SET phase = 'failed', result_json = ?,
              updated_at = ? WHERE id = ?`).run(
              JSON.stringify({ code: "REVISION_CONFLICT" }), this.now(), operationId);
          }
        }
        return this.getOperation(operationId);
      }
      const current = this.getInstallation(installationId);
      if (!current || current.revision !== expectedRevision) {
        throw error("REVISION_CONFLICT", "安装状态已变化");
      }
      if (current.desiredState === "uninstalled") {
        throw error("PLUGIN_INSTALLATION_INVALID", "插件已卸载");
      }
      const competing = db.prepare(`SELECT operations.id FROM operation_intents
        JOIN operations ON operations.id = operation_intents.operation_id
        WHERE operation_intents.installation_id = ? AND operations.phase IN ('created', 'committed')
        LIMIT 1`).get(installationId);
      if (competing) throw error("REVISION_CONFLICT", "该安装已有待完成的停用操作");
      const now = this.now();
      db.prepare(`INSERT INTO operations
        (id, fingerprint, kind, phase, result_json, created_at, updated_at)
        VALUES (?, ?, 'installation-state', 'created', NULL, ?, ?)`).run(
        operationId, fingerprint, now, now);
      db.prepare(`INSERT INTO operation_intents
        (operation_id, installation_id, desired_state, expected_revision)
        VALUES (?, ?, 'disabled', ?)`).run(operationId, installationId, expectedRevision);
      return this.getOperation(operationId);
    })();
  }

  hasPendingInstallationDisable(installationId) {
    if (!ID_PATTERN.test(installationId)) {
      throw error("PLUGIN_INSTALLATION_INVALID", "安装标识无效");
    }
    return Boolean(this._db().prepare(`SELECT 1 FROM operation_intents
      JOIN operations ON operations.id = operation_intents.operation_id
      WHERE operation_intents.installation_id = ? AND operations.phase IN ('created', 'committed', 'outcome_unknown')
      LIMIT 1`).get(installationId));
  }

  listInstallationMaintenance(installationId) {
    if (typeof installationId !== "string" || !ID_PATTERN.test(installationId)) {
      throw error("PLUGIN_INSTALLATION_INVALID", "安装标识无效");
    }
    return this._db().prepare(`SELECT operations.* FROM operation_intents
      JOIN operations ON operations.id = operation_intents.operation_id
      WHERE operation_intents.installation_id = ?
        AND operations.phase IN ('created', 'committed', 'outcome_unknown')
      ORDER BY operations.created_at, operations.id`).all(installationId).map(publicOperation);
  }

  assertInstallationMaintenance(request, allowedOperationIds = []) {
    if (!request || typeof request.installationId !== "string" || !ID_PATTERN.test(request.installationId)
      || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1
      || typeof request.authorityIncarnation !== "string" || !HASH_PATTERN.test(request.authorityIncarnation)
      || typeof request.sourceIdentity !== "string" || typeof request.fromDigest !== "string"
      || !HASH_PATTERN.test(request.fromDigest)) throw error("PLUGIN_OPERATION_INVALID", "数据维护参数无效");
    const installation = this.getInstallation(request.installationId);
    if (!installation || installation.revision !== request.expectedRevision
      || installation.sourceIdentity !== request.sourceIdentity || installation.releaseDigest !== request.fromDigest
      || this.getAuthorityIncarnation() !== request.authorityIncarnation) {
      throw error("REVISION_CONFLICT", "插件或权限代次已变化，请重新预览");
    }
    if (installation.desiredState !== "disabled") {
      throw error("PLUGIN_MAINTENANCE_REQUIRES_DISABLE", "代码和数据维护前必须先停用插件");
    }
    if (this.listInstallationMaintenance(request.installationId)
      .some(operation => !allowedOperationIds.includes(operation.operationId))) {
      throw error("ACTIVATION_DEFERRED", "安装仍有待核对的操作");
    }
    if (this._db().prepare(`SELECT 1 FROM capability_calls WHERE connection_id IN
      (SELECT id FROM connections WHERE installation_id = ?) AND phase = 'send_started' LIMIT 1`)
      .get(request.installationId)) throw error("ACTIVATION_DEFERRED", "已发出的工具调用尚未核对");
    return installation;
  }

  beginInstallationMaintenance({ operationId, fingerprint, kind, request }) {
    if (typeof operationId !== "string" || !ID_PATTERN.test(operationId)
      || typeof fingerprint !== "string" || !HASH_PATTERN.test(fingerprint)
      || !["data-snapshot", "code-rollback", "data-restore"].includes(kind)
      || Buffer.byteLength(JSON.stringify(request || null)) > 16 * 1024) {
      throw error("PLUGIN_OPERATION_INVALID", "插件维护操作无效");
    }
    return this._db().transaction(() => {
      const previous = this._db().prepare("SELECT * FROM operations WHERE id = ?").get(operationId);
      if (previous) {
        if (previous.kind !== kind || previous.fingerprint !== fingerprint) {
          throw error("REVISION_CONFLICT", "operationId 已用于其他参数");
        }
        assertOperationKnown(previous);
        return publicOperation(previous);
      }
      const allowed = [];
      if (request.rollbackOperationId !== null && request.rollbackOperationId !== undefined) {
        const rollback = this.getOperation(request.rollbackOperationId);
        if (kind !== "data-restore" || rollback?.kind !== "code-rollback" || rollback.phase !== "committed"
          || rollback.result?.receipt?.installationId !== request.installationId
          || rollback.result?.receipt?.targetDigest !== request.fromDigest
          || rollback.result?.receipt?.dataState !== "rollback_requires_data_restore"
          || rollback.result?.request?.authorityIncarnation !== request.authorityIncarnation) {
          throw error("REVISION_CONFLICT", "代码回退屏障与数据恢复不匹配");
        }
        allowed.push(request.rollbackOperationId);
      }
      this.assertInstallationMaintenance(request, allowed);
      const now = this.now();
      this._db().prepare(`INSERT INTO operations
        (id, fingerprint, kind, phase, result_json, created_at, updated_at)
        VALUES (?, ?, ?, 'created', ?, ?, ?)`).run(operationId, fingerprint, kind,
        JSON.stringify({ request, progress: null, receipt: null }), now, now);
      this._db().prepare(`INSERT INTO operation_intents
        (operation_id, installation_id, desired_state, expected_revision)
        VALUES (?, ?, 'disabled', ?)`).run(operationId, request.installationId, request.expectedRevision);
      return this.getOperation(operationId);
    })();
  }

  setInstallationMaintenanceProgress({ operationId, fingerprint, progress }) {
    return this._db().transaction(() => {
      const operation = this._db().prepare("SELECT * FROM operations WHERE id = ?").get(operationId);
      if (!operation || operation.fingerprint !== fingerprint || operation.kind !== "data-restore") {
        throw error("REVISION_CONFLICT", "数据恢复操作不存在或参数已变化");
      }
      assertOperationKnown(operation);
      if (operation.phase === "completed") return publicOperation(operation);
      const result = readJson(operation.result_json);
      const allowed = [operationId, ...(result.request.rollbackOperationId ? [result.request.rollbackOperationId] : [])];
      this.assertInstallationMaintenance(result.request, allowed);
      if (!["restore-staged", "restore-swapping"].includes(progress)) {
        throw error("PLUGIN_OPERATION_INVALID", "数据恢复进度无效");
      }
      this._db().prepare("UPDATE operations SET phase = 'committed', result_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify({ ...result, progress }), this.now(), operationId);
      return this.getOperation(operationId);
    })();
  }

  finishInstallationMaintenance({ operationId, fingerprint, receipt }) {
    return this._db().transaction(() => {
      const db = this._db();
      const operation = db.prepare("SELECT * FROM operations WHERE id = ?").get(operationId);
      if (!operation || operation.fingerprint !== fingerprint
        || !["data-snapshot", "code-rollback", "data-restore"].includes(operation.kind)) {
        throw error("REVISION_CONFLICT", "插件维护操作不存在或参数变化");
      }
      assertOperationKnown(operation);
      const value = readJson(operation.result_json);
      if (value.receipt) return value.receipt;
      const request = value.request;
      const allowed = [operationId, ...(request.rollbackOperationId ? [request.rollbackOperationId] : [])];
      this.assertInstallationMaintenance(request, allowed);
      if (operation.kind === "code-rollback" && (!this.getRelease(request.sourceIdentity, request.targetDigest)
        || request.targetDigest === request.fromDigest)) throw error("PLUGIN_RELEASE_INVALID", "目标代码版本无效");
      if (operation.kind === "data-restore" && request.snapshotReleaseDigest !== request.fromDigest) {
        throw error("PLUGIN_RELEASE_INVALID", "数据快照不属于当前代码版本");
      }
      const now = this.now();
      if (operation.kind !== "data-snapshot") {
        db.prepare(`UPDATE installations SET release_digest = ?, revision = revision + 1,
          updated_at = ? WHERE id = ?`).run(operation.kind === "code-rollback" ? request.targetDigest
          : request.fromDigest, now, request.installationId);
        db.prepare("UPDATE bindings SET enabled = 0, revision = revision + 1 WHERE installation_id = ?")
          .run(request.installationId);
        const epoch = db.prepare("UPDATE capability_epoch SET value = value + 1 WHERE id = 1 RETURNING value").get().value;
        db.prepare(`UPDATE grants SET effect = 'deny', epoch = ?, revision = revision + 1
          WHERE binding_id IN (SELECT id FROM bindings WHERE installation_id = ?)`).run(epoch, request.installationId);
        db.prepare(`UPDATE connections SET state = 'disconnected', auth_revision = auth_revision + 1,
          revision = revision + 1 WHERE installation_id = ?`).run(request.installationId);
      }
      const result = { ...receipt, operationId, installationId: request.installationId,
        installationRevision: this.getInstallation(request.installationId).revision,
        ...(operation.kind === "code-rollback" ? { dataState: "rollback_requires_data_restore" } : {}) };
      db.prepare("UPDATE operations SET phase = ?, result_json = ?, updated_at = ? WHERE id = ?")
        .run(operation.kind === "code-rollback" ? "committed" : "completed",
          JSON.stringify({ request, progress: value.progress, receipt: result }), now, operationId);
      if (operation.kind === "data-restore" && request.rollbackOperationId) {
        const rollback = this.getOperation(request.rollbackOperationId);
        if (rollback?.kind !== "code-rollback" || rollback.phase !== "committed"
          || rollback.result?.receipt?.targetDigest !== request.fromDigest
          || rollback.result?.request?.installationId !== request.installationId) {
          throw error("REVISION_CONFLICT", "代码回退屏障发生变化");
        }
        const rollbackResult = { ...rollback.result, receipt: { ...rollback.result.receipt,
          dataState: "restored_from_snapshot", dataRestoreOperationId: operationId } };
        db.prepare("UPDATE operations SET phase = 'completed', result_json = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(rollbackResult), now, request.rollbackOperationId);
      }
      return result;
    })();
  }

  previewInstallationUninstall({ installationId, expectedRevision }) {
    if (!ID_PATTERN.test(installationId) || !Number.isSafeInteger(expectedRevision)
      || expectedRevision < 1) throw error("PLUGIN_OPERATION_INVALID", "卸载参数无效");
    const installation = this.getInstallation(installationId);
    if (!installation || installation.revision !== expectedRevision) {
      throw error("REVISION_CONFLICT", "安装状态已变化，请重新预览");
    }
    if (installation.desiredState === "uninstalled") {
      throw error("PLUGIN_INSTALLATION_INVALID", "插件已卸载");
    }
    const db = this._db();
    const counts = db.prepare(`SELECT COUNT(*) AS bindingCount,
      COUNT(DISTINCT subject_id) AS affectedAgentCount FROM bindings
      WHERE installation_id = ?`).get(installationId);
    return { installationId, expectedRevision, releaseDigest: installation.releaseDigest,
      requiresDisable: installation.desiredState !== "disabled", ...counts,
      connectionCount: db.prepare("SELECT COUNT(*) AS count FROM connections WHERE installation_id = ?")
        .get(installationId).count,
      activeCallCount: db.prepare(`SELECT COUNT(*) AS count FROM capability_calls
        WHERE connection_id IN (SELECT id FROM connections WHERE installation_id = ?)
          AND phase = 'send_started'`).get(installationId).count,
      dataRetained: true, credentialsRetained: true };
  }

  beginInstallationUninstall({ operationId, fingerprint, installationId, expectedRevision }) {
    if (!ID_PATTERN.test(operationId) || !HASH_PATTERN.test(fingerprint)
      || !ID_PATTERN.test(installationId) || !Number.isSafeInteger(expectedRevision)
      || expectedRevision < 1) throw error("PLUGIN_OPERATION_INVALID", "卸载参数无效");
    return this._db().transaction(() => {
      const db = this._db();
      const previous = db.prepare("SELECT * FROM operations WHERE id = ?").get(operationId);
      if (previous) {
        if (previous.kind !== "uninstall" || previous.fingerprint !== fingerprint) {
          throw error("REVISION_CONFLICT", "operationId 已用于其他参数");
        }
        assertOperationKnown(previous);
        return publicOperation(previous);
      }
      const preview = this.previewInstallationUninstall({ installationId, expectedRevision });
      if (preview.requiresDisable) {
        throw error("PLUGIN_UNINSTALL_REQUIRES_DISABLE", "卸载前必须先停用并排空连接");
      }
      if (this.hasPendingInstallationDisable(installationId)) {
        throw error("ACTIVATION_DEFERRED", "安装已有待完成的停用或卸载操作");
      }
      const now = this.now();
      db.prepare(`INSERT INTO operations
        (id, fingerprint, kind, phase, result_json, created_at, updated_at)
        VALUES (?, ?, 'uninstall', 'created', NULL, ?, ?)`).run(operationId, fingerprint, now, now);
      db.prepare(`INSERT INTO operation_intents
        (operation_id, installation_id, desired_state, expected_revision)
        VALUES (?, ?, 'uninstalled', ?)`).run(operationId, installationId, expectedRevision);
      // Revoke before any asynchronous drain. The intent also fences re-enable,
      // account verification and new Grants through a Service restart.
      const epoch = db.prepare("UPDATE capability_epoch SET value = value + 1 WHERE id = 1 RETURNING value")
        .get().value;
      db.prepare(`UPDATE grants SET effect = 'deny', epoch = ?, revision = revision + 1
        WHERE binding_id IN (SELECT id FROM bindings WHERE installation_id = ?)`)
        .run(epoch, installationId);
      db.prepare(`UPDATE bindings SET enabled = 0, revision = revision + 1
        WHERE installation_id = ? AND enabled = 1`).run(installationId);
      db.prepare(`UPDATE capability_calls SET phase = 'rejected_before_send', updated_at = ?
        WHERE connection_id IN (SELECT id FROM connections WHERE installation_id = ?)
          AND phase = 'prepared'`).run(now, installationId);
      return this.getOperation(operationId);
    })();
  }

  commitInstallationUninstall({ operationId, fingerprint }) {
    if (!ID_PATTERN.test(operationId) || !HASH_PATTERN.test(fingerprint)) {
      throw error("PLUGIN_OPERATION_INVALID", "卸载提交参数无效");
    }
    return this._db().transaction(() => {
      const db = this._db();
      const operation = db.prepare("SELECT * FROM operations WHERE id = ?").get(operationId);
      if (!operation || operation.kind !== "uninstall" || operation.fingerprint !== fingerprint) {
        throw error("REVISION_CONFLICT", "卸载操作不存在或参数变化");
      }
      assertOperationKnown(operation);
      if (["committed", "completed"].includes(operation.phase)) return publicOperation(operation);
      if (operation.phase !== "created") throw error("PLUGIN_OPERATION_FAILED", "卸载操作已失败");
      const intent = db.prepare("SELECT * FROM operation_intents WHERE operation_id = ?").get(operationId);
      if (!intent || intent.desired_state !== "uninstalled") {
        throw error("PLUGIN_STORE_CORRUPT", "卸载意图不存在");
      }
      const preview = this.previewInstallationUninstall({ installationId: intent.installation_id,
        expectedRevision: intent.expected_revision });
      if (preview.requiresDisable) throw error("PLUGIN_UNINSTALL_REQUIRES_DISABLE", "卸载前必须先停用");
      if (preview.activeCallCount > 0) throw error("ACTIVATION_DEFERRED", "插件调用仍在发送中");
      const now = this.now();
      db.prepare(`UPDATE connections SET state = 'disconnected', auth_revision = auth_revision + 1,
        revision = revision + 1 WHERE installation_id = ?`).run(intent.installation_id);
      db.prepare(`UPDATE installations SET desired_state = 'uninstalled', revision = revision + 1,
        updated_at = ? WHERE id = ?`).run(now, intent.installation_id);
      const result = { installationId: intent.installation_id,
        releaseDigest: preview.releaseDigest, revision: intent.expected_revision + 1,
        revokedBindings: preview.bindingCount, retainedConnections: preview.connectionCount,
        dataRetained: true, credentialsRetained: true, packageRemoved: false };
      // Logical removal commits before deleting files. A crash leaves a
      // resumable receipt and never restores executable authority.
      db.prepare(`UPDATE operations SET phase = 'committed', result_json = ?, updated_at = ?
        WHERE id = ?`).run(JSON.stringify(result), now, operationId);
      return this.getOperation(operationId);
    })();
  }

  isPackageReferenced(digest) {
    if (!HASH_PATTERN.test(digest)) throw error("PLUGIN_RELEASE_INVALID", "包摘要无效");
    return Boolean(this._db().prepare(`SELECT 1 FROM installations
      WHERE release_digest = ? AND desired_state != 'uninstalled' LIMIT 1`).get(digest));
  }

  finishInstallationUninstall({ operationId, fingerprint, packageRemoved }) {
    if (!ID_PATTERN.test(operationId) || !HASH_PATTERN.test(fingerprint)
      || typeof packageRemoved !== "boolean") throw error("PLUGIN_OPERATION_INVALID", "卸载结果无效");
    return this._db().transaction(() => {
      const db = this._db();
      const operation = db.prepare("SELECT * FROM operations WHERE id = ?").get(operationId);
      if (!operation || operation.kind !== "uninstall" || operation.fingerprint !== fingerprint) {
        throw error("REVISION_CONFLICT", "卸载操作不存在或参数变化");
      }
      assertOperationKnown(operation);
      if (operation.phase === "completed") return readJson(operation.result_json);
      if (operation.phase !== "committed") throw error("PLUGIN_OPERATION_FAILED", "卸载尚未提交");
      const result = { ...readJson(operation.result_json), packageRemoved };
      db.prepare(`UPDATE operations SET phase = 'completed', result_json = ?, updated_at = ?
        WHERE id = ?`).run(JSON.stringify(result), this.now(), operationId);
      return result;
    })();
  }

  performManagementOperation({ operationId, kind, fingerprint, apply }) {
    if (!ID_PATTERN.test(operationId)
      || !["installation-state", "skill-binding-set", "grant-revoke",
        "grants-revoke-all", "mcp-connect", "mcp-disconnect", "grant-allow"].includes(kind)
      || !HASH_PATTERN.test(fingerprint) || typeof apply !== "function") {
      throw error("PLUGIN_OPERATION_INVALID", "插件管理操作参数无效");
    }
    return this._db().transaction(() => {
      const previous = this._db().prepare("SELECT * FROM operations WHERE id = ?")
        .get(operationId);
      if (previous) {
        if (previous.kind !== kind || previous.fingerprint !== fingerprint) {
          throw error("REVISION_CONFLICT", "operationId 已用于其他参数");
        }
        assertOperationKnown(previous);
        if (previous.phase === "created" && kind === "installation-state") {
          if (!this._db().prepare("SELECT 1 FROM operation_intents WHERE operation_id = ?")
            .get(operationId)) throw error("PLUGIN_STORE_CORRUPT", "停用意图不存在");
          const result = apply();
          this._db().prepare(`UPDATE operations SET phase = 'completed',
            result_json = ?, updated_at = ? WHERE id = ?`).run(
              JSON.stringify(result), this.now(), operationId);
          return { result, operation: this.getOperation(operationId) };
        }
        if (previous.phase !== "completed") {
          throw error("PLUGIN_OPERATION_FAILED", "插件管理操作尚无确定结果");
        }
        return { result: readJson(previous.result_json), operation: publicOperation(previous) };
      }
      const result = apply();
      const now = this.now();
      this._db().prepare(`INSERT INTO operations
        (id, fingerprint, kind, phase, result_json, created_at, updated_at)
        VALUES (?, ?, ?, 'completed', ?, ?, ?)`).run(
        operationId, fingerprint, kind, JSON.stringify(result), now, now);
      return { result, operation: this.getOperation(operationId) };
    })();
  }

  setInstallationDesiredState({ installationId, desiredState, expectedRevision }) {
    if (!ID_PATTERN.test(installationId) || !["disabled", "enabled"].includes(desiredState)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw error("PLUGIN_OPERATION_INVALID", "安装状态参数无效");
    }
    return this._db().transaction(() => {
      const record = this.getInstallation(installationId);
      if (!record || record.revision !== expectedRevision) throw error("REVISION_CONFLICT", "安装状态已变化");
      if (record.desiredState === "uninstalled") {
        throw error("PLUGIN_INSTALLATION_INVALID", "插件已卸载，请重新安装");
      }
      if (desiredState === "enabled" && this.hasPendingInstallationDisable(installationId)) {
        throw error("ACTIVATION_DEFERRED", "安装存在待完成的停用或卸载操作");
      }
      if (record.desiredState === desiredState) return record;
      this._db().prepare("UPDATE installations SET desired_state = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(desiredState, this.now(), installationId);
      if (desiredState === "disabled") {
        const epoch = this._db().prepare("UPDATE capability_epoch SET value = value + 1 WHERE id = 1 RETURNING value")
          .get().value;
        this._db().prepare(`UPDATE grants SET epoch = ?, revision = revision + 1
          WHERE binding_id IN (SELECT id FROM bindings WHERE installation_id = ?)`).run(
          epoch, installationId);
      }
      return this.getInstallation(installationId);
    })();
  }

  createConnection({ connectionId, installationId, componentId: selectedComponentId,
    endpointIdentity, credentialRef = null }) {
    if (!ID_PATTERN.test(connectionId) || !ID_PATTERN.test(installationId)
      || !HASH_PATTERN.test(selectedComponentId) || typeof endpointIdentity !== "string"
      || !endpointIdentity || endpointIdentity.length > 2048
      || (credentialRef !== null && (!ID_PATTERN.test(credentialRef)))) {
      throw error("PLUGIN_CONNECTION_INVALID", "连接参数无效");
    }
    return this._db().transaction(() => {
      const installation = this.getInstallation(installationId);
      if (!installation || installation.desiredState === "uninstalled"
        || this.hasPendingInstallationDisable(installationId)) {
        throw error("PLUGIN_INSTALLATION_INVALID", "安装不存在或正在停用");
      }
      if (credentialRef && this._db().prepare(
        "SELECT id FROM connections WHERE credential_ref = ?",
      ).get(credentialRef)) {
        throw error("PLUGIN_CONNECTION_INVALID", "凭据引用已属于其他连接");
      }
      const release = this.getRelease(installation.sourceIdentity, installation.releaseDigest);
      if (!release.components.mcpServers.some((server) =>
        componentId(installationId, "mcp-server", server.name) === selectedComponentId)) {
        throw error("PLUGIN_CONNECTION_INVALID", "连接组件不存在");
      }
      this._db().prepare(`INSERT INTO connections (id, installation_id, component_id,
        endpoint_identity, principal_identity, credential_ref, state, auth_revision, revision)
        VALUES (?, ?, ?, ?, NULL, ?, 'pending', 0, 1)`).run(
        connectionId, installationId, selectedComponentId, endpointIdentity, credentialRef);
      return this.getConnection(connectionId);
    })();
  }
  getConnection(connectionId) {
    if (!ID_PATTERN.test(connectionId)) throw error("PLUGIN_CONNECTION_INVALID", "connectionId 无效");
    return publicConnection(this._readStatement("connection").get(connectionId));
  }
  getConnectionCountsForComponent(installationId, selectedComponentId) {
    if (!ID_PATTERN.test(installationId) || !HASH_PATTERN.test(selectedComponentId)) {
      throw error("PLUGIN_CONNECTION_INVALID", "连接组件参数无效");
    }
    const counts = { pending: 0, verified: 0, disconnected: 0 };
    for (const row of this._db().prepare(`SELECT state, COUNT(*) AS count FROM connections
      WHERE installation_id = ? AND component_id = ? GROUP BY state`).all(
      installationId, selectedComponentId)) {
      counts[row.state === "ready" ? "verified" : row.state] = row.count;
    }
    return counts;
  }
  // Trusted Service code may resolve the opaque secret reference. Management
  // DTOs continue to use getConnection(), which never exposes this field.
  getConnectionAuth(connectionId) {
    if (!ID_PATTERN.test(connectionId)) throw error("PLUGIN_CONNECTION_INVALID", "connectionId 无效");
    const record = this._db().prepare("SELECT * FROM connections WHERE id = ?").get(connectionId);
    return record ? { ...publicConnection(record), credentialRef: record.credential_ref } : null;
  }
  setConnectionIdentity({ connectionId, principalIdentity, state, expectedRevision }) {
    if (!ID_PATTERN.test(connectionId) || typeof principalIdentity !== "string"
      || !principalIdentity || principalIdentity.length > 1024
      || !["ready", "disconnected"].includes(state)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw error("PLUGIN_CONNECTION_INVALID", "连接身份参数无效");
    }
    return this._db().transaction(() => {
      const record = this.getConnection(connectionId);
      if (!record || record.revision !== expectedRevision) throw error("REVISION_CONFLICT", "连接状态已变化");
      if (state === "ready" && (this.getInstallation(record.installationId)?.desiredState === "uninstalled"
        || this.hasPendingInstallationDisable(record.installationId))) {
        throw error("ACTIVATION_DEFERRED", "安装正在停用或已卸载");
      }
      this._db().prepare(`UPDATE connections SET principal_identity = ?, state = ?,
        auth_revision = auth_revision + 1, revision = revision + 1 WHERE id = ?`).run(
        principalIdentity, state, connectionId);
      if (state === "disconnected"
        || (record.principalIdentity && record.principalIdentity !== principalIdentity)) {
        const epoch = this._db().prepare("UPDATE capability_epoch SET value = value + 1 WHERE id = 1 RETURNING value")
          .get().value;
        this._db().prepare(`UPDATE grants SET effect = 'deny', epoch = ?, revision = revision + 1
          WHERE connection_id = ?`).run(epoch, connectionId);
      }
      return this.getConnection(connectionId);
    })();
  }

  disconnectMcpConnection({ connectionId, expectedRevision }) {
    if (typeof connectionId !== "string" || !ID_PATTERN.test(connectionId)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw error("PLUGIN_CONNECTION_INVALID", "断开连接参数无效");
    }
    return this._db().transaction(() => {
      const current = this.getConnection(connectionId);
      if (!current || current.revision !== expectedRevision) throw error("REVISION_CONFLICT", "连接状态已变化");
      const connection = this.setConnectionIdentity({ connectionId, expectedRevision,
        state: "disconnected", principalIdentity: current.principalIdentity || `unverified:${connectionId}` });
      this._db().prepare("UPDATE bindings SET enabled = 0, revision = revision + 1 WHERE connection_id = ?")
        .run(connectionId);
      return { connection, bindings: this.listBindingsForConnection(connectionId) };
    })();
  }

  createBinding({ bindingId, profileId, installationId, componentId: selectedComponentId,
    connectionId }) {
    if (!ID_PATTERN.test(bindingId) || !ID_PATTERN.test(profileId)
      || !ID_PATTERN.test(installationId) || !HASH_PATTERN.test(selectedComponentId)
      || !ID_PATTERN.test(connectionId)) throw error("PLUGIN_BINDING_INVALID", "绑定参数无效");
    return this._db().transaction(() => {
      const connection = this.getConnection(connectionId);
      if (!connection || connection.installationId !== installationId
        || connection.componentId !== selectedComponentId
        || this.getInstallation(installationId)?.desiredState === "uninstalled"
        || this.hasPendingInstallationDisable(installationId)) {
        throw error("PLUGIN_BINDING_INVALID", "绑定连接不属于该组件");
      }
      if (this._db().prepare(`SELECT id FROM bindings WHERE subject_kind = 'native-profile'
        AND subject_id = ? AND installation_id = ? AND component_id = ?`).get(
        profileId, installationId, selectedComponentId)) {
        throw error("PLUGIN_BINDING_EXISTS", "该 Agent 已绑定此组件");
      }
      this._db().prepare(`INSERT INTO bindings (id, subject_kind, subject_id,
        installation_id, component_id, component_kind, connection_id, enabled, revision)
        VALUES (?, 'native-profile', ?, ?, ?, 'mcp-server', ?, 0, 1)`).run(
        bindingId, profileId, installationId, selectedComponentId, connectionId);
      return this.getBinding(bindingId);
    })();
  }
  createSkillBinding({ bindingId, profileId, installationId, componentId: selectedComponentId }) {
    if (!ID_PATTERN.test(bindingId) || !ID_PATTERN.test(profileId)
      || !ID_PATTERN.test(installationId) || !HASH_PATTERN.test(selectedComponentId)) {
      throw error("PLUGIN_BINDING_INVALID", "Skill 绑定参数无效");
    }
    return this._db().transaction(() => {
      const installation = this.getInstallation(installationId);
      const release = installation && this.getRelease(installation.sourceIdentity, installation.releaseDigest);
      if (installation?.desiredState === "uninstalled"
        || this.hasPendingInstallationDisable(installationId)
        || !release?.components.skills.some((skill) =>
        componentId(installationId, "skill", skill.name) === selectedComponentId)) {
        throw error("PLUGIN_BINDING_INVALID", "Skill 组件不属于当前安装");
      }
      if (this._db().prepare(`SELECT id FROM bindings WHERE subject_kind = 'native-profile'
        AND subject_id = ? AND installation_id = ? AND component_id = ?`).get(
        profileId, installationId, selectedComponentId)) {
        throw error("PLUGIN_BINDING_EXISTS", "该 Agent 已绑定此组件");
      }
      this._db().prepare(`INSERT INTO bindings (id, subject_kind, subject_id,
        installation_id, component_id, component_kind, connection_id, enabled, revision)
        VALUES (?, 'native-profile', ?, ?, ?, 'skill', NULL, 0, 1)`).run(
        bindingId, profileId, installationId, selectedComponentId);
      return this.getBinding(bindingId);
    })();
  }
  getBinding(bindingId) {
    if (!ID_PATTERN.test(bindingId)) throw error("PLUGIN_BINDING_INVALID", "bindingId 无效");
    return publicBinding(this._readStatement("binding").get(bindingId));
  }
  listBindingsForConnection(connectionId) {
    if (typeof connectionId !== "string" || !ID_PATTERN.test(connectionId)) {
      throw error("PLUGIN_CONNECTION_INVALID", "连接标识无效");
    }
    return this._db().prepare("SELECT * FROM bindings WHERE connection_id = ? ORDER BY id")
      .all(connectionId).map(publicBinding);
  }
  listBindingsForProfile(profileId) {
    if (!ID_PATTERN.test(profileId)) throw error("PLUGIN_BINDING_INVALID", "Agent ID 无效");
    return this._readStatement("profileBindings")
      .all(profileId).map(publicBinding);
  }
  setBindingEnabled({ bindingId, enabled, expectedRevision }) {
    if (!ID_PATTERN.test(bindingId) || typeof enabled !== "boolean"
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw error("PLUGIN_BINDING_INVALID", "绑定状态参数无效");
    }
    return this._db().transaction(() => {
      const record = this.getBinding(bindingId);
      if (!record || record.revision !== expectedRevision) throw error("REVISION_CONFLICT", "绑定状态已变化");
      if (record.enabled === enabled) return record;
      if (enabled) {
        const installation = this.getInstallation(record.installationId);
        if (!installation || installation.desiredState !== "enabled"
          || this.hasPendingInstallationDisable(installation.installationId)) {
          throw error("PLUGIN_COMPONENT_INACTIVE", "插件安装未启用");
        }
        const release = this.getRelease(installation.sourceIdentity, installation.releaseDigest);
        const group = record.componentKind === "skill"
          ? release?.components?.skills : release?.components?.mcpServers;
        if (!group?.some((item) => componentId(record.installationId,
          record.componentKind, item.name) === record.componentId)) {
          throw error("PLUGIN_COMPONENT_REVISION_CHANGED", "绑定组件已从当前版本移除");
        }
        if (record.componentKind === "mcp-server") {
          const connection = this.getConnection(record.connectionId);
          if (!connection || connection.state !== "ready" || !connection.principalIdentity) {
            throw error("CONNECTION_AUTH_REQUIRED", "插件账号尚未验证");
          }
        }
      }
      this._db().prepare("UPDATE bindings SET enabled = ?, revision = revision + 1 WHERE id = ?")
        .run(enabled ? 1 : 0, bindingId);
      if (!enabled) {
        // A ticket issued before a rapid off/on transition must not regain its
        // former Grant merely because the binding is enabled at final send.
        const epoch = this._db().prepare("UPDATE capability_epoch SET value = value + 1 WHERE id = 1 RETURNING value")
          .get().value;
        this._db().prepare("UPDATE grants SET epoch = ?, revision = revision + 1 WHERE binding_id = ?")
          .run(epoch, bindingId);
      }
      return this.getBinding(bindingId);
    })();
  }

  setMcpBindingConnection({ bindingId, connectionId, expectedRevision }) {
    if (!ID_PATTERN.test(bindingId) || !ID_PATTERN.test(connectionId)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw error("PLUGIN_BINDING_INVALID", "MCP 账号绑定参数无效");
    }
    return this._db().transaction(() => {
      const binding = this.getBinding(bindingId);
      if (!binding || binding.componentKind !== "mcp-server") {
        throw error("PLUGIN_BINDING_INVALID", "MCP 能力绑定不存在");
      }
      if (binding.revision !== expectedRevision) {
        throw error("REVISION_CONFLICT", "MCP 能力绑定已变化");
      }
      if (binding.connectionId === connectionId) return binding;
      const connection = this.getConnection(connectionId);
      if (!connection || connection.installationId !== binding.installationId
        || connection.componentId !== binding.componentId) {
        throw error("PLUGIN_BINDING_INVALID", "账号连接不属于该 MCP 组件");
      }
      if (connection.state !== "ready" || !connection.principalIdentity) {
        throw error("CONNECTION_AUTH_REQUIRED", "目标账号尚未验证");
      }
      const installation = this.getInstallation(binding.installationId);
      const release = installation && this.getRelease(installation.sourceIdentity,
        installation.releaseDigest);
      if (!release?.components.mcpServers.some((server) =>
        componentId(binding.installationId, "mcp-server", server.name)
          === binding.componentId)) {
        throw error("PLUGIN_COMPONENT_REVISION_CHANGED", "MCP 组件已从当前版本移除");
      }
      this._db().prepare(`UPDATE bindings SET connection_id = ?, enabled = 0,
        revision = revision + 1 WHERE id = ?`).run(connectionId, bindingId);
      const epoch = this._db().prepare("UPDATE capability_epoch SET value = value + 1 WHERE id = 1 RETURNING value")
        .get().value;
      this._db().prepare(`UPDATE grants SET effect = 'deny', epoch = ?,
        revision = revision + 1 WHERE binding_id = ?`).run(epoch, bindingId);
      return this.getBinding(bindingId);
    })();
  }

  setGrant({ grantId, bindingId, toolIdentity, contractDigest, effect,
    approvalMode, argumentScope = null, expiresAt = null, expectedRevision }) {
    if (!ID_PATTERN.test(grantId) || !ID_PATTERN.test(bindingId)
      || typeof toolIdentity !== "string" || !toolIdentity || toolIdentity.length > 512
      || !HASH_PATTERN.test(contractDigest) || !["allow", "deny"].includes(effect)
      || !["always", "each-call"].includes(approvalMode)
      || argumentScope !== null
      || (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt < 0))
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw error("PLUGIN_GRANT_INVALID", "授权参数无效");
    }
    return this._db().transaction(() => {
      const binding = this.getBinding(bindingId);
      if (binding?.componentKind === "skill") {
        throw error("PLUGIN_GRANT_INVALID", "Skill 不接受 MCP 工具 Grant");
      }
      const connection = binding && this.getConnection(binding.connectionId);
      if (effect === "allow" && binding && (this.getInstallation(binding.installationId)?.desiredState === "uninstalled"
        || this.hasPendingInstallationDisable(binding.installationId))) {
        throw error("ACTIVATION_DEFERRED", "安装正在停用或已卸载");
      }
      if (!binding || !connection || connection.state !== "ready" || !connection.principalIdentity) {
        throw error("CONNECTION_AUTH_REQUIRED", "连接身份尚未验证");
      }
      const previous = this._db().prepare("SELECT * FROM grants WHERE binding_id = ? AND tool_identity = ?")
        .get(bindingId, toolIdentity);
      if ((previous?.revision || 0) !== expectedRevision
        || (previous && previous.id !== grantId)) throw error("REVISION_CONFLICT", "授权状态已变化");
      const epoch = this._db().prepare("UPDATE capability_epoch SET value = value + 1 WHERE id = 1 RETURNING value")
        .get().value;
      if (previous) {
        this._db().prepare(`UPDATE grants SET connection_id = ?, principal_identity = ?,
          contract_digest = ?, effect = ?, approval_mode = ?, expires_at = ?, epoch = ?,
          revision = revision + 1 WHERE id = ?`).run(connection.connectionId,
          connection.principalIdentity, contractDigest, effect, approvalMode, expiresAt,
          epoch, grantId);
      } else {
        this._db().prepare(`INSERT INTO grants (id, binding_id, connection_id,
          principal_identity, tool_identity, contract_digest, effect,
          approval_mode, expires_at, epoch, revision)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(grantId, bindingId,
          connection.connectionId, connection.principalIdentity, toolIdentity,
          contractDigest, effect, approvalMode, expiresAt, epoch);
      }
      return this.getGrant(bindingId, toolIdentity);
    })();
  }
  getGrant(bindingId, toolIdentity) {
    if (!ID_PATTERN.test(bindingId) || typeof toolIdentity !== "string" || !toolIdentity) {
      throw error("PLUGIN_GRANT_INVALID", "授权查询参数无效");
    }
    return publicGrant(this._readStatement("grant")
      .get(bindingId, toolIdentity));
  }
  revokeGrant({ bindingId, toolIdentity, expectedRevision }) {
    if (!ID_PATTERN.test(bindingId) || typeof toolIdentity !== "string"
      || !toolIdentity || toolIdentity.length > 512
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw error("PLUGIN_GRANT_INVALID", "撤权参数无效");
    }
    return this._db().transaction(() => {
      const grant = this.getGrant(bindingId, toolIdentity);
      if (!grant) throw error("PLUGIN_GRANT_INVALID", "工具授权不存在");
      if (grant.revision !== expectedRevision) {
        throw error("REVISION_CONFLICT", "工具授权已变化");
      }
      if (grant.effect === "deny") return grant;
      const epoch = this._db().prepare("UPDATE capability_epoch SET value = value + 1 WHERE id = 1 RETURNING value")
        .get().value;
      this._db().prepare(`UPDATE grants SET effect = 'deny', epoch = ?,
        revision = revision + 1 WHERE id = ?`).run(epoch, grant.grantId);
      return this.getGrant(bindingId, toolIdentity);
    })();
  }
  revokeAllGrants({ bindingId, expectedRevision }) {
    if (!ID_PATTERN.test(bindingId) || !Number.isSafeInteger(expectedRevision)
      || expectedRevision < 1) throw error("PLUGIN_GRANT_INVALID", "批量撤权参数无效");
    return this._db().transaction(() => {
      const binding = this.getBinding(bindingId);
      if (!binding || binding.componentKind !== "mcp-server") {
        throw error("PLUGIN_BINDING_INVALID", "MCP 绑定不存在");
      }
      if (binding.revision !== expectedRevision) {
        throw error("REVISION_CONFLICT", "MCP 绑定已变化");
      }
      const count = this._db().prepare(`SELECT COUNT(*) AS count FROM grants
        WHERE binding_id = ? AND effect = 'allow'`).get(bindingId).count;
      const epoch = count > 0
        ? this._db().prepare("UPDATE capability_epoch SET value = value + 1 WHERE id = 1 RETURNING value")
          .get().value
        : this._db().prepare("SELECT value FROM capability_epoch WHERE id = 1")
          .get().value;
      if (count > 0) {
        const changed = this._db().prepare(`UPDATE grants SET effect = 'deny',
          epoch = ?, revision = revision + 1
          WHERE binding_id = ? AND effect = 'allow'`).run(epoch, bindingId);
        if (changed.changes !== count) throw error("PLUGIN_STORE_CORRUPT", "工具授权计数不一致");
      }
      return { bindingId, revokedCount: count, bindingRevision: binding.revision, epoch };
    })();
  }
  revokeProfileBindings(profileId) {
    if (!ID_PATTERN.test(profileId)) throw error("PLUGIN_BINDING_INVALID", "Agent ID 无效");
    return this._db().transaction(() => {
      const disabledBindings = this._db().prepare(`SELECT COUNT(*) AS count FROM bindings
        WHERE subject_kind = 'native-profile' AND subject_id = ? AND enabled = 1`)
        .get(profileId).count;
      const revokedGrants = this._db().prepare(`SELECT COUNT(*) AS count FROM grants
        JOIN bindings ON bindings.id = grants.binding_id
        WHERE bindings.subject_kind = 'native-profile' AND bindings.subject_id = ?
          AND grants.effect = 'allow'`).get(profileId).count;
      const changed = disabledBindings > 0 || revokedGrants > 0;
      const epoch = changed
        ? this._db().prepare("UPDATE capability_epoch SET value = value + 1 WHERE id = 1 RETURNING value")
          .get().value
        : this._db().prepare("SELECT value FROM capability_epoch WHERE id = 1")
          .get().value;
      if (revokedGrants > 0) {
        const result = this._db().prepare(`UPDATE grants SET effect = 'deny',
          epoch = ?, revision = revision + 1 WHERE effect = 'allow'
          AND binding_id IN (SELECT id FROM bindings
            WHERE subject_kind = 'native-profile' AND subject_id = ?)`)
          .run(epoch, profileId);
        if (result.changes !== revokedGrants) {
          throw error("PLUGIN_STORE_CORRUPT", "Agent 工具授权计数不一致");
        }
      }
      if (disabledBindings > 0) {
        const result = this._db().prepare(`UPDATE bindings SET enabled = 0,
          revision = revision + 1 WHERE subject_kind = 'native-profile'
          AND subject_id = ? AND enabled = 1`).run(profileId);
        if (result.changes !== disabledBindings) {
          throw error("PLUGIN_STORE_CORRUPT", "Agent 插件绑定计数不一致");
        }
      }
      return { profileId, disabledBindings, revokedGrants, epoch };
    })();
  }
  assertProfilePurgeReady(profileId) {
    if (!ID_PATTERN.test(profileId)) throw error("PLUGIN_BINDING_INVALID", "Agent ID 无效");
    const activeSends = this._db().prepare(`SELECT COUNT(*) AS count FROM capability_calls
      WHERE binding_id IN (SELECT id FROM bindings
        WHERE subject_kind = 'native-profile' AND subject_id = ?)
        AND phase = 'send_started'`).get(profileId).count;
    if (activeSends > 0) {
      throw error("ACTIVATION_DEFERRED", "Agent 插件调用仍在发送中，请稍后重试清理");
    }
  }
  purgeProfileBindings(profileId) {
    if (!ID_PATTERN.test(profileId)) throw error("PLUGIN_BINDING_INVALID", "Agent ID 无效");
    return this._db().transaction(() => {
      const db = this._db();
      const where = `binding_id IN (SELECT id FROM bindings
        WHERE subject_kind = 'native-profile' AND subject_id = ?)`;
      const bindings = db.prepare(`SELECT COUNT(*) AS count FROM bindings
        WHERE subject_kind = 'native-profile' AND subject_id = ?`).get(profileId).count;
      const grants = db.prepare(`SELECT COUNT(*) AS count FROM grants WHERE ${where}`)
        .get(profileId).count;
      this.assertProfilePurgeReady(profileId);
      const calls = db.prepare(`SELECT COUNT(*) AS count FROM capability_calls WHERE ${where}`)
        .get(profileId).count;
      const epoch = bindings > 0
        ? db.prepare("UPDATE capability_epoch SET value = value + 1 WHERE id = 1 RETURNING value")
          .get().value
        : db.prepare("SELECT value FROM capability_epoch WHERE id = 1").get().value;
      // The call ID and outcome survive as a replay-prevention tombstone. All
      // Agent, account, tool and argument references are removed after expiry.
      if (calls > 0) {
        const result = db.prepare(`UPDATE capability_calls SET
          phase = CASE WHEN phase = 'prepared' THEN 'rejected_before_send' ELSE phase END,
          run_ref = '', binding_id = '', connection_id = '', principal_identity = '',
          tool_identity = '', contract_digest = '', argument_digest = '', updated_at = ?
          WHERE ${where}`).run(this.now(), profileId);
        if (result.changes !== calls) {
          throw error("PLUGIN_STORE_CORRUPT", "Agent 插件调用收据计数不一致");
        }
      }
      if (grants > 0) {
        const result = db.prepare(`DELETE FROM grants WHERE ${where}`).run(profileId);
        if (result.changes !== grants) {
          throw error("PLUGIN_STORE_CORRUPT", "Agent 工具授权清理计数不一致");
        }
      }
      if (bindings > 0) {
        const result = db.prepare(`DELETE FROM bindings
          WHERE subject_kind = 'native-profile' AND subject_id = ?`).run(profileId);
        if (result.changes !== bindings) {
          throw error("PLUGIN_STORE_CORRUPT", "Agent 插件绑定清理计数不一致");
        }
      }
      return { profileId, removedBindings: bindings, removedGrants: grants,
        scrubbedCalls: calls, epoch };
    })();
  }
  getGrantCountsForBinding(bindingId) {
    if (!ID_PATTERN.test(bindingId)) throw error("PLUGIN_BINDING_INVALID", "bindingId 无效");
    const counts = { allow: 0, deny: 0 };
    for (const row of this._db().prepare(`SELECT effect, COUNT(*) AS count FROM grants
      WHERE binding_id = ? GROUP BY effect`).all(bindingId)) counts[row.effect] = row.count;
    return counts;
  }
  getCapabilityRecords(bindingId, toolIdentity) {
    const binding = this.getBinding(bindingId);
    if (!binding) return null;
    const installation = this.getInstallation(binding.installationId);
    return { authorityIncarnation: this.getAuthorityIncarnation(), binding, installation: installation && { ...installation,
      activeReleaseDigest: installation.releaseDigest },
    connection: binding.connectionId ? this.getConnection(binding.connectionId) : null,
    grant: this.getGrant(bindingId, toolIdentity) };
  }

  // One bounded, synchronous read transaction. Callers must discard this view
  // before awaiting transport/user input and read again afterwards. It is not an
  // authorization cache; every requested Grant is queried on every invocation.
  getCapabilityRecordsForTools(bindingId, toolIdentities) {
    if (typeof bindingId !== "string" || !ID_PATTERN.test(bindingId)
      || !Array.isArray(toolIdentities) || toolIdentities.length > 256
      || toolIdentities.some(value => typeof value !== "string" || !value || value.length > 512)
      || new Set(toolIdentities).size !== toolIdentities.length) {
      throw error("PLUGIN_GRANT_INVALID", "授权批量查询参数无效");
    }
    if (!this.#capabilityToolsReader) this.#capabilityToolsReader = this._db().transaction((id, identities) => {
      const records = this.getCapabilityRecords(id, "__projection__");
      if (!records) return null;
      return { records, grants: new Map(identities.map(identity => [identity, this.getGrant(id, identity)])) };
    });
    return this.#capabilityToolsReader(bindingId, toolIdentities);
  }

  getCapabilityCall(callId) {
    if (!ID_PATTERN.test(callId)) throw error("CAPABILITY_CALL_INVALID", "callId 无效");
    return publicCapabilityCall(this._db().prepare("SELECT * FROM capability_calls WHERE id = ?")
      .get(callId));
  }
  beginCapabilityCall({ callId, runRef, bindingId, connectionId, principalIdentity,
    toolIdentity, contractDigest, argumentDigest }) {
    if (!ID_PATTERN.test(callId) || !ID_PATTERN.test(runRef) || !ID_PATTERN.test(bindingId)
      || !ID_PATTERN.test(connectionId) || typeof principalIdentity !== "string"
      || !principalIdentity || principalIdentity.length > 1024
      || typeof toolIdentity !== "string" || !toolIdentity || toolIdentity.length > 512
      || !HASH_PATTERN.test(contractDigest) || !HASH_PATTERN.test(argumentDigest)) {
      throw error("CAPABILITY_CALL_INVALID", "能力调用收据参数无效");
    }
    return this._db().transaction(() => {
      if (this.getCapabilityCall(callId)) {
        throw error("CALL_ALREADY_RECORDED", "调用标识已使用，禁止重复派发");
      }
      const now = this.now();
      this._db().prepare(`INSERT INTO capability_calls
        (id, run_ref, binding_id, connection_id, principal_identity, tool_identity,
          contract_digest, argument_digest, phase, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`).run(callId, runRef,
        bindingId, connectionId, principalIdentity, toolIdentity, contractDigest,
        argumentDigest, now, now);
      return this.getCapabilityCall(callId);
    })();
  }
  markCapabilityCallSendStarted(callId) {
    if (!ID_PATTERN.test(callId)) throw error("CAPABILITY_CALL_INVALID", "callId 无效");
    const result = this._db().prepare(`UPDATE capability_calls SET phase = 'send_started', updated_at = ?
      WHERE id = ? AND phase = 'prepared'`).run(this.now(), callId);
    if (result.changes !== 1) throw error("CALL_STATE_CONFLICT", "调用已派发或状态不明");
    return this.getCapabilityCall(callId);
  }
  finishCapabilityCall(callId, { resultConfirmed = false } = {}) {
    if (!ID_PATTERN.test(callId) || typeof resultConfirmed !== "boolean") {
      throw error("CAPABILITY_CALL_INVALID", "调用结果参数无效");
    }
    const expected = resultConfirmed ? "send_started" : null;
    const next = resultConfirmed ? "result_confirmed" : null;
    return this._db().transaction(() => {
      const record = this.getCapabilityCall(callId);
      if (!record || (expected && record.phase !== expected)
        || (!expected && !["prepared", "send_started"].includes(record.phase))) {
        throw error("CALL_STATE_CONFLICT", "调用结果已记录或状态不明");
      }
      this._db().prepare("UPDATE capability_calls SET phase = ?, updated_at = ? WHERE id = ?")
        .run(next || (record.phase === "prepared" ? "rejected_before_send" : "outcome_unknown"),
          this.now(), callId);
      return this.getCapabilityCall(callId);
    })();
  }
}

module.exports = { PluginStore, PLUGIN_STORE_SCHEMA_VERSION: SCHEMA_VERSION,
  assertPluginCatalogBaseline, readPluginRestoreBarrier };
