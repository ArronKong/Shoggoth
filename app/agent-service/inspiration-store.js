"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { preparePrivateParent, readPrivateFile, fsyncPrivateParent,
  recoverInterruptedPrivateFile, statIfExists } = require("./private-file");
const { openDatabase, SCHEMA, GROWTH_SCHEMA, transaction } = require("./inspiration-database");
const { validGrowthSettings, validGrowthJob } = require("./inspiration-growth");
const { acquirePrivateWriterLease } = require("./private-writer-lease");
const { serviceError } = require("./security");
const { normalizeInteractiveRequestV1 } = require("../core/shoggoth-interaction-contract");
const { validInspirationAttention, validInspirationPaperTone } = require("./inspiration-service-protocol");
const { MEDIA_SCHEMA, InspirationMediaStore, validAttachments, attachmentFields, CHUNK_BYTES, ARCHIVE_MIME } = require("./inspiration-media");
const { readInspirationArchive } = require("./inspiration-archive");
const { EXTERNAL_BACKENDS, EXTERNAL_STATUSES, EXTERNAL_TERMINAL,
  validExternalSnapshot, validateExternalInspirationResult } = require("../external-inspiration-protocol");

const INSPIRATION_STORE_VERSION = 3;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_LEGACY_JSON_BYTES = 64 * 1024 * 1024;
const IDEA_FIELDS = Object.freeze([
  "id", "body", "title", "revision", "favorite", "archivedAt", "acceptedAt", "createdAt", "updatedAt", "deletedAt",
]);
const EXECUTION_FIELDS = Object.freeze([
  "id", "ideaId", "operationId", "ideaRevision", "body", "title", "instruction", "agentId",
  "backendId", "profileId", "workspace", "sessionKey", "runId", "retryOf", "createdAt", "attention", "preparationFailure",
  "external",
]);
const LEGACY_EXECUTION_FIELDS = EXECUTION_FIELDS.filter((field) => field !== "external");
const EXTERNAL_FIELDS = Object.freeze(["phase", "hostId", "mode", "status", "sequence",
  "resultSummary", "errorCode", "finishedAt", "attention", "cancelOperationId", "reconcileFingerprint"]);
const OBSERVATION_FIELDS = Object.freeze(["status", "sequence", "resultSummary", "errorCode", "finishedAt", "attention"]);
const OPERATION_FIELDS = Object.freeze(["fingerprint", "type", "id"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const clone = (value) => value == null ? value : structuredClone(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const validId = (value) => typeof value === "string" && ID.test(value);
const time = (value) => Number.isSafeInteger(value) && value >= 0;
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === fields.length
  && fields.every((field) => own(value, field));
const textValue = (value, max, empty = false) => typeof value === "string"
  && (empty || value.trim().length > 0) && value.isWellFormed() && !value.includes("\0")
  && Buffer.byteLength(JSON.stringify(value), "utf8") <= max;
const fail = (code, message) => { throw serviceError(code, message); };

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function fingerprint(kind, input) {
  return crypto.createHash("sha256").update(canonicalJson({ kind, input })).digest("hex");
}

function externalObservation(value) {
  return Object.fromEntries(OBSERVATION_FIELDS.map((field) => [field, value[field]]));
}

function validIdea(value) {
  const hasTone = value && own(value, "paperTone");
  return exact(value, attachmentFields(value, hasTone ? [...IDEA_FIELDS, "paperTone"] : IDEA_FIELDS))
    && (!own(value, "attachments") || validAttachments(value.attachments))
    && (!hasTone || validInspirationPaperTone(value.paperTone))
    && UUID.test(value.id) && textValue(value.body, MAX_BODY_BYTES, value.deletedAt !== null || Boolean(value.attachments?.length))
    && (value.title === null || textValue(value.title, 512))
    && Number.isSafeInteger(value.revision) && value.revision >= 1
    && typeof value.favorite === "boolean" && time(value.createdAt) && time(value.updatedAt)
    && value.updatedAt >= value.createdAt
    && [value.archivedAt, value.acceptedAt, value.deletedAt].every((at) => at === null || time(at))
    && (value.deletedAt === null || (value.body === "" && value.title === null && !value.favorite
      && value.archivedAt === null && value.acceptedAt === null && value.deletedAt === value.updatedAt));
}

function migrateContainer(value) {
  if (value?.version === 1) {
    validateContainer(value, 1);
    value = { ...value, version: 2, ideas: Object.fromEntries(Object.entries(value.ideas)
      .map(([id, idea]) => [id, { ...idea, deletedAt: null }])) };
  }
  if (value?.version === 2) {
    // Validate the entire old shape before adding fields. Unknown legacy fields
    // must never be erased or blessed by a migration.
    validateContainer(value, 2);
    value = { ...value, version: 3, executions: Object.fromEntries(Object.entries(value.executions)
      .map(([id, execution]) => [id, { ...execution, external: null }])) };
  }
  return value;
}

function validExternalState(execution) {
  const value = execution.external;
  const bound = value?.phase !== "preparing";
  return exact(value, EXTERNAL_FIELDS) && ["preparing", "prepared", "dispatched"].includes(value.phase)
    && EXTERNAL_BACKENDS.has(execution.backendId) && execution.profileId === null && execution.attention === null
    && (execution.workspace === null || (textValue(execution.workspace, 4096) && path.isAbsolute(execution.workspace)))
    && (execution.sessionKey === null || textValue(execution.sessionKey, 512))
    && EXTERNAL_STATUSES.has(value.status) && time(value.sequence)
    && (value.resultSummary === null || textValue(value.resultSummary, 16 * 1024, true))
    && (value.errorCode === null || (typeof value.errorCode === "string" && /^[A-Z][A-Z0-9_]{0,127}$/u.test(value.errorCode)))
    && (EXTERNAL_TERMINAL.has(value.status) ? time(value.finishedAt) : value.finishedAt === null)
    && (value.cancelOperationId === null || validId(value.cancelOperationId))
    && (value.reconcileFingerprint === null || (typeof value.reconcileFingerprint === "string"
      && /^[a-f0-9]{64}$/u.test(value.reconcileFingerprint) && value.status === "unknown" && value.hostId !== null))
    && validInspirationAttention(value.attention, execution.runId)
    && (!(EXTERNAL_TERMINAL.has(value.status) || value.status === "unknown") || value.attention?.active !== true)
    && (bound
      ? UUID.test(value.hostId) && ["openclaw", "gateway", "acp"].includes(value.mode)
        && (execution.backendId === "openclaw") === (value.mode === "openclaw")
        && execution.workspace !== null && execution.sessionKey !== null
      : value.hostId === null && value.mode === null && value.sequence === 0
        && ["queued", "unknown", "failed", "canceled"].includes(value.status) && value.attention === null);
}

function validExecution(value, version = INSPIRATION_STORE_VERSION) {
  const external = version === 3 && value?.external !== null;
  const fields = [...attachmentFields(value, version < 3 ? LEGACY_EXECUTION_FIELDS : EXECUTION_FIELDS)];
  if (version === 3 && own(value, "turnAttachments")) fields.push("turnAttachments");
  if (version === 3 && own(value, "inputSource")) fields.push("inputSource");
  return exact(value, fields) && UUID.test(value.id) && UUID.test(value.ideaId)
    && (!own(value, "inputSource") || (value.inputSource === "chat" && value.sessionKey !== null))
    && (!own(value, "attachments") || validAttachments(value.attachments))
    && (!own(value, "turnAttachments") || validAttachments(value.turnAttachments))
    && UUID.test(value.runId) && validId(value.operationId)
    && Number.isSafeInteger(value.ideaRevision) && value.ideaRevision >= 1
    && textValue(value.body, MAX_BODY_BYTES, Boolean(value.attachments?.length)) && textValue(value.instruction, MAX_BODY_BYTES, true)
    && (value.title === null || textValue(value.title, 512))
    && [value.agentId, value.backendId].every(validId)
    && (external ? validExternalState(value) : validId(value.profileId)
      && textValue(value.workspace, 4096) && path.isAbsolute(value.workspace)
      && (value.sessionKey === null || UUID.test(value.sessionKey)))
    && (value.retryOf === null || UUID.test(value.retryOf)) && time(value.createdAt)
    && (value.preparationFailure === null || (exact(value.preparationFailure, ["code", "occurredAt"])
      && /^[A-Z][A-Z0-9_]{0,127}$/u.test(value.preparationFailure.code) && time(value.preparationFailure.occurredAt)))
    && (value.attention === null || (exact(value.attention, ["type", "payload", "occurredAt"])
      && ["prompt", "approval"].includes(value.attention.type)
      && value.attention.payload && typeof value.attention.payload === "object"
      && !Array.isArray(value.attention.payload) && validId(value.attention.payload.requestId)
      && time(value.attention.occurredAt)
      && Buffer.byteLength(JSON.stringify(value.attention), "utf8") <= 48 * 1024));
}

function validateContainer(value, version = INSPIRATION_STORE_VERSION) {
  if (!exact(value, ["version", "revision", "ideas", "executions", "operations"])
    || value.version !== version || !time(value.revision)
    || [value.ideas, value.executions, value.operations].some((map) => !map
      || typeof map !== "object" || Array.isArray(map) || Object.getPrototypeOf(map) !== Object.prototype)) {
    fail("INSPIRATION_STORE_CORRUPT", "灵感存储格式无效");
  }
  for (const [id, idea] of Object.entries(value.ideas)) {
    const valid = version === 1 ? exact(idea, IDEA_FIELDS.filter((field) => field !== "deletedAt"))
      && validIdea({ ...idea, deletedAt: null }) : validIdea(idea);
    if (!valid || idea.id !== id) fail("INSPIRATION_STORE_CORRUPT", "灵感记录无效");
  }
  const runIds = new Set();
  for (const [id, execution] of Object.entries(value.executions)) {
    if (!validExecution(execution, version) || execution.id !== id || !value.ideas[execution.ideaId]
      || execution.ideaRevision > value.ideas[execution.ideaId].revision || runIds.has(execution.runId)) {
      fail("INSPIRATION_STORE_CORRUPT", "灵感执行关联无效");
    }
    runIds.add(execution.runId);
    if (execution.attention) normalizeInteractiveRequestV1({ runId: execution.runId,
      eventType: execution.attention.type, payload: execution.attention.payload,
      expiresAt: execution.attention.payload.expiresAt ?? null });
  }
  for (const [key, operation] of Object.entries(value.operations)) {
    if (!validId(key) || !exact(operation, OPERATION_FIELDS)
      || !/^[a-f0-9]{64}$/u.test(operation.fingerprint)
      || !["ideas", "executions"].includes(operation.type)
      || !own(value[operation.type], operation.id)) {
      fail("INSPIRATION_STORE_CORRUPT", "灵感操作记录无效");
    }
  }
  return value;
}

/** Native runs belong to the Coordinator; external run identities and observations are durable here. */
class InspirationStore extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.paths?.stateDir || !options.paths?.trustedRoot) throw new TypeError("InspirationStore 需要 paths");
    this.paths = options.paths;
    this.filePath = path.join(this.paths.stateDir, "inspirations.sqlite");
    this.legacyPath = path.join(this.paths.stateDir, "inspirations.json");
    this.migratedPath = path.join(this.paths.stateDir, "inspirations.migrated.json");
    this.fs = options.fs || fs;
    this.openDatabase = options.openDatabase || openDatabase;
    this.commitTransaction = options.commitTransaction || transaction;
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.assertSecretSafe = options.assertSecretSafe || (() => true);
    this.lease = null;
    this.poisoned = false;
    this.db = null;
    this.revision = 0;
    this.statements = new Map();
  }

  open() {
    if (this.lease) return this;
    preparePrivateParent(this.filePath, this.paths.trustedRoot, this.fs);
    const lease = acquirePrivateWriterLease({
      lockPath: path.join(this.paths.stateDir, "inspirations.writer.lock"),
      trustedRoot: this.paths.trustedRoot, fs: this.fs,
    });
    try {
      if (recoverInterruptedPrivateFile(this.legacyPath, { trustedRoot: this.paths.trustedRoot, fs: this.fs }) === "uncertain") {
        fail("INSPIRATION_COMMIT_UNCERTAIN", "灵感保存状态需要恢复核对");
      }
      if (!statIfExists(this.fs, this.filePath) && statIfExists(this.fs, this.migratedPath)) {
        fail("INSPIRATION_STORE_CORRUPT", "灵感数据库缺失，请从完整备份恢复");
      }
      this.db = this.openDatabase(this.filePath);
      const version = this.db.prepare("PRAGMA user_version").get().user_version;
      if (![0, 1, 2, 3].includes(version)) fail("INSPIRATION_STORE_CORRUPT", "灵感数据库版本无法识别");
      const legacy = statIfExists(this.fs, this.legacyPath)
        ? readPrivateFile(this.legacyPath, { fs: this.fs, maxBytes: MAX_LEGACY_JSON_BYTES }) : null;
      const digest = legacy ? crypto.createHash("sha256").update(legacy).digest("hex") : "none";
      if (version === 0) {
        if (statIfExists(this.fs, this.migratedPath)) fail("INSPIRATION_STORE_CORRUPT", "灵感数据库未完成初始化");
        const value = legacy ? validateContainer(migrateContainer(JSON.parse(legacy)))
          : { version: INSPIRATION_STORE_VERSION, revision: 0, ideas: {}, executions: {}, operations: {} };
        transaction(this.db, () => {
          this.db.exec(SCHEMA);
          this.#statement("INSERT INTO meta VALUES ('revision', ?)").run(String(value.revision));
          this.#statement("INSERT INTO meta VALUES ('legacy_sha256', ?)").run(digest);
          this.#writeRecords(value);
        });
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        fsyncPrivateParent(this.paths.stateDir, this.fs);
      } else if (legacy && this.#statement("SELECT value FROM meta WHERE key='legacy_sha256'").get()?.value !== digest) {
        fail("INSPIRATION_STORE_CORRUPT", "旧版灵感文件在迁移后发生变化，请核对数据");
      }
      if (version < 2) transaction(this.db, () => this.db.exec(GROWTH_SCHEMA));
      if (version < 3) transaction(this.db, () => this.db.exec(MEDIA_SCHEMA));
      // Repair the derived stage index from versions that returned stopped work
      // to seeds. Preserve the execution's canceled status and all user data.
      this.db.prepare(`UPDATE ideas SET bucket='active' WHERE bucket='saved'
        AND latest_id IN (SELECT id FROM executions WHERE status='canceled')`).run();
      this.media = new InspirationMediaStore(this.db, this.paths);
      // The transaction is the authority switch. A crash before this rename
      // resumes cleanup by checking its fingerprint, never imports twice.
      if (legacy) {
        if (statIfExists(this.fs, this.migratedPath)) fail("INSPIRATION_STORE_CORRUPT", "灵感迁移备份已存在，请核对数据");
        this.fs.renameSync(this.legacyPath, this.migratedPath);
        fsyncPrivateParent(this.paths.stateDir, this.fs);
      }
      this.revision = Number(this.#statement("SELECT value FROM meta WHERE key='revision'").get()?.value);
      if (!time(this.revision)) fail("INSPIRATION_STORE_CORRUPT", "灵感数据库修订号无效");
      this.poisoned = false;
      this.lease = lease;
      return this;
    } catch (error) {
      this.db?.close(); this.db = null; this.statements.clear();
      lease.release();
      throw error;
    }
  }

  close() {
    try {
      if (this.db) { try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { this.db.close(); } }
    } finally {
      this.db = null; this.statements.clear();
      this.lease?.release(); this.lease = null;
    }
  }

  #assertOpen() {
    if (!this.lease || !this.db) fail("INSPIRATION_UNAVAILABLE", "灵感服务暂不可用");
    if (this.poisoned) fail("INSPIRATION_COMMIT_UNCERTAIN", "灵感保存状态需要恢复核对");
  }

  #statement(sql) {
    if (!this.statements.has(sql)) this.statements.set(sql, this.db.prepare(sql));
    return this.statements.get(sql);
  }

  #record(type, id) {
    if (!["ideas", "executions"].includes(type)) fail("INSPIRATION_STORE_CORRUPT", "灵感记录类型无效");
    const row = this.#statement(`SELECT data FROM ${type} WHERE id=?`).get(id);
    if (!row) return null;
    const value = JSON.parse(row.data);
    if (!(type === "ideas" ? validIdea(value) : validExecution(value)) || value.id !== id) {
      fail("INSPIRATION_STORE_CORRUPT", "灵感记录无效");
    }
    return value;
  }

  #operation(id) {
    const row = this.#statement("SELECT fingerprint, type, target_id AS id FROM operations WHERE id=?").get(id);
    if (row && (!/^[a-f0-9]{64}$/u.test(row.fingerprint) || !["ideas", "executions"].includes(row.type) || !UUID.test(row.id))) {
      fail("INSPIRATION_STORE_CORRUPT", "灵感操作记录无效");
    }
    return row || null;
  }

  #decode(type, row) {
    if (!row) return null;
    const value = JSON.parse(row.data);
    if (!(type === "ideas" ? validIdea(value) : validExecution(value))) fail("INSPIRATION_STORE_CORRUPT", "灵感记录无效");
    return value;
  }

  #draft(ideaId = null, executionId = null) {
    const candidate = { revision: this.revision, ideas: {}, executions: {}, operations: {} };
    if (ideaId) { const idea = this.#record("ideas", ideaId); if (idea) candidate.ideas[ideaId] = idea; }
    if (executionId) { const execution = this.#record("executions", executionId); if (execution) candidate.executions[executionId] = execution; }
    return candidate;
  }

  #writeRecords(candidate) {
    for (const idea of Object.values(candidate.ideas)) {
      if (!validIdea(idea)) fail("INSPIRATION_STORE_CORRUPT", "灵感记录无效");
      this.#statement(`INSERT INTO ideas(id,sort_at,archived,favorite,deleted,bucket,search,data)
        VALUES (?,?,?,?,?,'saved',?,?) ON CONFLICT(id) DO UPDATE SET
        sort_at=excluded.sort_at,archived=excluded.archived,favorite=excluded.favorite,
        deleted=excluded.deleted,search=excluded.search,data=excluded.data`).run(
        idea.id, -idea.updatedAt, Number(idea.archivedAt !== null), Number(idea.favorite), Number(idea.deletedAt !== null),
        `${idea.title ?? ""}\n${idea.body}${idea.attachments?.length ? `\n${idea.attachments.map(item => item.name).join("\n")}` : ""}`.toLocaleLowerCase(), JSON.stringify(idea));
    }
    const affected = new Set();
    for (const execution of Object.values(candidate.executions)) {
      const idea = candidate.ideas[execution.ideaId] || this.#record("ideas", execution.ideaId);
      if (!validExecution(execution) || !idea || execution.ideaRevision > idea.revision) {
        fail("INSPIRATION_STORE_CORRUPT", "灵感执行关联无效");
      }
      if (execution.attention) normalizeInteractiveRequestV1({ runId: execution.runId, eventType: execution.attention.type,
        payload: execution.attention.payload, expiresAt: execution.attention.payload.expiresAt ?? null });
      const status = execution.preparationFailure ? "failed" : execution.external?.status
        ?? this.#statement("SELECT status FROM executions WHERE id=?").get(execution.id)?.status ?? "queued";
      this.#statement(`INSERT INTO executions(id,idea_id,run_id,operation_id,session_key,backend_id,agent_id,created_at,external,status,data)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET session_key=excluded.session_key,status=excluded.status,data=excluded.data`).run(
        execution.id, execution.ideaId, execution.runId, execution.operationId, execution.sessionKey, execution.backendId,
        execution.agentId, execution.createdAt, Number(execution.external !== null), status, JSON.stringify(execution));
      affected.add(execution.ideaId);
    }
    for (const ideaId of affected) this.#projectLatest(ideaId);
    for (const [id, operation] of Object.entries(candidate.operations)) {
      if (!validId(id) || !exact(operation, OPERATION_FIELDS) || !/^[a-f0-9]{64}$/u.test(operation.fingerprint)
        || !["ideas", "executions"].includes(operation.type) || !this.#record(operation.type, operation.id)) {
        fail("INSPIRATION_STORE_CORRUPT", "灵感操作记录无效");
      }
      this.#statement("INSERT INTO operations(id,fingerprint,type,target_id) VALUES (?,?,?,?)")
        .run(id, operation.fingerprint, operation.type, operation.id);
    }
  }

  #projectLatest(ideaId) {
    const latest = this.#statement("SELECT id,status FROM executions WHERE idea_id=? ORDER BY created_at DESC,id DESC LIMIT 1").get(ideaId);
    const bucket = latest?.status === "completed" ? "result" : [undefined, "skipped"].includes(latest?.status) ? "saved" : "active";
    this.#statement("UPDATE ideas SET latest_id=?,bucket=? WHERE id=?").run(latest?.id ?? null, bucket, ideaId);
  }

  #commit(candidate, beforeWrite) {
    this.#assertOpen();
    if (candidate.revision !== this.revision + 1) fail("INSPIRATION_OPERATION_CONFLICT", "灵感操作期间数据已变化");
    try {
      this.commitTransaction(this.db, () => {
        if (Number(this.#statement("SELECT value FROM meta WHERE key='revision'").get()?.value) !== this.revision) {
          fail("INSPIRATION_OPERATION_CONFLICT", "灵感操作期间数据已变化");
        }
        beforeWrite?.();
        this.#writeRecords(candidate);
        this.#statement("UPDATE meta SET value=? WHERE key='revision'").run(String(candidate.revision));
      });
    } catch (error) {
      if (error.committedUncertain || /^SQLITE_(IOERR|CORRUPT|NOTADB)/u.test(error.code || "")) {
        this.poisoned = true;
        fail("INSPIRATION_COMMIT_UNCERTAIN", "灵感保存状态需要恢复核对");
      }
      throw error;
    }
    this.revision = candidate.revision;
    this.emit("changed");
  }

  purgeProfile(profileId) {
    this.#assertOpen();
    if (!validId(profileId)) fail("INSPIRATION_INVALID", "Profile 无效");
    const executions = this.#statement("SELECT id,idea_id,run_id FROM executions WHERE json_extract(data,'$.profileId')=?")
      .all(profileId);
    if (executions.length === 0) return;
    this.db.exec("PRAGMA secure_delete=ON");
    this.#commit({ revision: this.revision + 1, ideas: {}, executions: {}, operations: {} }, () => {
      for (const execution of executions) {
        this.#statement("DELETE FROM operations WHERE type='executions' AND target_id=?").run(execution.id);
        this.#statement("DELETE FROM growth_jobs WHERE json_extract(data,'$.runId')=?").run(execution.run_id);
        this.#statement("DELETE FROM executions WHERE id=?").run(execution.id);
      }
      for (const ideaId of new Set(executions.map((execution) => execution.idea_id))) this.#projectLatest(ideaId);
    });
    // Ideas are shared user objects and survive deletion of an executor.
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  growthSettings() {
    this.#assertOpen();
    const row = this.#statement("SELECT value FROM meta WHERE key='growth_settings'").get();
    const value = row ? JSON.parse(row.value) : { revision: 1, enabled: false, executors: [] };
    if (!validGrowthSettings(value)) fail("INSPIRATION_STORE_CORRUPT", "自动生长设置无效");
    return value;
  }

  #commitGrowth(write) {
    this.#assertOpen();
    try { this.commitTransaction(this.db, write); }
    catch (error) {
      if (error.committedUncertain || /^SQLITE_(IOERR|CORRUPT|NOTADB)/u.test(error.code || "")) {
        this.poisoned = true;
        fail("INSPIRATION_COMMIT_UNCERTAIN", "自动生长保存状态需要恢复核对");
      }
      throw error;
    }
    this.emit("changed");
  }

  updateGrowthSettings(input) {
    const previous = this.growthSettings();
    if (previous.revision !== input.expectedRevision) fail("INSPIRATION_REVISION_CONFLICT", "自动生长设置已更新，请重新查看");
    const value = { revision: previous.revision + 1, enabled: input.enabled, executors: input.executors };
    if (!validGrowthSettings(value)) fail("INSPIRATION_INVALID", "请选择自动生长执行者");
    this.#commitGrowth(() => this.#statement("INSERT INTO meta(key,value) VALUES ('growth_settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify(value)));
    return clone(value);
  }

  growthJobs(states) {
    this.#assertOpen();
    return this.#statement(`SELECT data FROM growth_jobs WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY rowid`)
      .all(...states).map(row => {
        const value = JSON.parse(row.data);
        if (!validGrowthJob(value)) fail("INSPIRATION_STORE_CORRUPT", "自动生长执行记录无效");
        return value;
      });
  }

  saveGrowthJob(value) {
    if (!validGrowthJob(value)) fail("INSPIRATION_INVALID", "自动生长执行记录无效");
    this.#commitGrowth(() => this.#statement("INSERT INTO growth_jobs(idea_id,state,data) VALUES (?,?,?) ON CONFLICT(idea_id) DO UPDATE SET state=excluded.state,data=excluded.data")
      .run(value.ideaId, value.state, JSON.stringify(value)));
    return clone(value);
  }

  nextGrowthSeed() {
    this.#assertOpen();
    return this.#decode("ideas", this.#statement(`SELECT data FROM ideas
      WHERE deleted=0 AND archived=0 AND bucket='saved'
      AND NOT EXISTS (SELECT 1 FROM growth_jobs WHERE idea_id=ideas.id)
      ORDER BY rowid LIMIT 1`).get());
  }

  growthFailures() {
    this.#assertOpen();
    return this.#statement(`SELECT g.data,i.data AS idea,e.status FROM ideas i
      LEFT JOIN growth_jobs g ON g.idea_id=i.id LEFT JOIN executions e ON e.id=i.latest_id
      WHERE (g.state='blocked' OR e.status='canceled') AND i.deleted=0 AND i.archived=0
      ORDER BY i.sort_at,i.id LIMIT 20`).all()
      .flatMap(row => {
        const job = row.data ? JSON.parse(row.data) : null, idea = JSON.parse(row.idea);
        if ((job && !validGrowthJob(job)) || !validIdea(idea)) fail("INSPIRATION_STORE_CORRUPT", "自动生长执行记录无效");
        const latest = this.latestExecution(idea.id);
        const matchingJob = job && (latest?.runId ?? null) === job.runId ? job : null;
        // A manual stop needs a decision even when auto growth never owned it.
        if (row.status !== "canceled" && !matchingJob) return [];
        return [{ ideaId: idea.id, title: (idea.title || idea.body.trim().split('\n')[0] || idea.attachments?.[0]?.name || '').slice(0, 80),
          runId: latest?.runId ?? null, attempts: matchingJob?.attempt ?? 1,
          errorCode: row.status === "canceled" ? "INSPIRATION_CANCELED" : matchingJob.errorCode || "INSPIRATION_START_FAILED" }];
      });
  }

  #operate(kind, input, create) {
    this.#assertOpen();
    if (!validId(input.operationId)) fail("INSPIRATION_INVALID", "operationId 无效");
    const digest = fingerprint(kind, input);
    const previous = this.#operation(input.operationId);
    if (previous) {
      if (previous.fingerprint !== digest) fail("INSPIRATION_OPERATION_CONFLICT", "同一次操作不能更换内容");
      return this.#record(previous.type, previous.id);
    }
    const candidate = this.#draft(input.id, input.executionId);
    const result = create(candidate);
    candidate.operations[input.operationId] = { fingerprint: digest, type: result.type, id: result.id };
    candidate.revision += 1;
    this.#commit(candidate, result.beforeWrite);
    return this.#record(result.type, result.id);
  }

  #at() {
    const at = this.now();
    if (!time(at)) fail("INSPIRATION_INVALID", "时间无效");
    return at;
  }

  #safe(value) {
    if (this.assertSecretSafe(value, Object.freeze({ kind: "inspiration" })) !== true) {
      fail("INSPIRATION_SENSITIVE_CONTENT", "请移除凭据后保存灵感");
    }
  }

  get(id) {
    this.#assertOpen();
    const idea = this.#record("ideas", id);
    return idea?.deletedAt === null ? idea : null;
  }

  list() {
    this.#assertOpen();
    return this.#statement("SELECT data FROM ideas WHERE deleted=0 ORDER BY sort_at,id").all().map(row => this.#decode("ideas", row));
  }

  agentExecutionStats(agents) {
    this.#assertOpen();
    if (!agents.length) return [];
    // Count durable rounds, including retries and archived/deleted ideas. Reading
    // indexed columns avoids decoding note bodies or walking paginated UI data.
    const rows = this.#statement(`SELECT backend_id,agent_id,COUNT(*) AS execution_count FROM executions
      WHERE (backend_id,agent_id) IN (${agents.map(() => "(?,?)").join(",")})
      GROUP BY backend_id,agent_id`).all(...agents.flatMap(agent => [agent.backendId, agent.agentId]));
    const counts = new Map(rows.map(row => [`${row.backend_id}/${row.agent_id}`, row.execution_count]));
    return agents.map(agent => ({ ...agent, executionCount: counts.get(`${agent.backendId}/${agent.agentId}`) || 0 }));
  }

  executions(ideaId = null) {
    this.#assertOpen();
    return (ideaId === null
      ? this.#statement("SELECT data FROM executions ORDER BY created_at DESC,id DESC").all()
      : this.#statement("SELECT data FROM executions WHERE idea_id=? ORDER BY created_at DESC,id DESC").all(ideaId))
      .map(row => this.#decode("executions", row));
  }

  executionForRun(runId) {
    this.#assertOpen();
    const row = this.#statement("SELECT data FROM executions WHERE run_id=?").get(runId);
    return this.#decode("executions", row);
  }

  executionsForSession(sessionKey, backendId = null, agentId = null) {
    this.#assertOpen();
    return this.#statement(`SELECT data FROM executions WHERE session_key=?
      ${backendId === null ? "" : "AND backend_id=?"} ${agentId === null ? "" : "AND agent_id=?"}
      ORDER BY created_at DESC,id DESC`).all(sessionKey, ...[backendId, agentId].filter(value => value !== null))
      .map(row => this.#decode("executions", row));
  }

  executionForSession(sessionKey, backendId = null, agentId = null) {
    this.#assertOpen();
    const row = this.#statement(`SELECT data FROM executions WHERE session_key=?
      ${backendId === null ? "" : "AND backend_id=?"} ${agentId === null ? "" : "AND agent_id=?"}
      ORDER BY created_at DESC,id DESC LIMIT 1`).get(sessionKey, ...[backendId, agentId].filter(value => value !== null));
    return this.#decode("executions", row);
  }

  executionForOperation(operationId) {
    this.#assertOpen();
    const row = this.#statement("SELECT data FROM executions WHERE operation_id=?").get(operationId);
    return this.#decode("executions", row);
  }

  latestExecution(ideaId) {
    this.#assertOpen();
    const row = this.#statement("SELECT data FROM executions WHERE idea_id=? ORDER BY created_at DESC,id DESC LIMIT 1").get(ideaId);
    return this.#decode("executions", row);
  }

  pendingExecutions(external) {
    this.#assertOpen();
    return this.#statement(`SELECT data FROM executions WHERE external=?
      AND status IN ('queued','starting','running','waiting_input','waiting_approval','unknown')`)
      .all(Number(external)).map(row => this.#decode("executions", row));
  }

  projectNativeStatuses(values) {
    this.#assertOpen();
    if (!values.length) return;
    transaction(this.db, () => {
      for (const { runId, status } of values) {
        if (!["queued","starting","running","waiting_input","waiting_approval","unknown","completed","failed","canceled","interrupted","skipped"].includes(status)) {
          fail("INSPIRATION_RESPONSE_INVALID", "运行状态无效");
        }
        const row = this.#statement("SELECT idea_id,status FROM executions WHERE run_id=? AND external=0").get(runId);
        if (!row || row.status === status) continue;
        this.#statement("UPDATE executions SET status=? WHERE run_id=?").run(status, runId);
        this.#projectLatest(row.idea_id);
      }
    });
  }

  #cursor(cursor) {
    if (cursor === null) return null;
    const match = /^(\d+):([0-9a-f-]{36})$/u.exec(cursor);
    if (!match || !time(Number(match[1])) || !UUID.test(match[2])) fail("INSPIRATION_INVALID", "列表游标无效");
    return { at: Number(match[1]), id: match[2] };
  }

  listPage({ filter, query, cursor, limit, backendId, agentId }) {
    this.#assertOpen();
    const where = ["deleted=0"];
    const args = [];
    if (filter !== "favorite") { where.push("archived=?"); args.push(Number(filter === "archived")); }
    if (["saved", "active", "result"].includes(filter)) { where.push("bucket=?"); args.push(filter); }
    if (filter === "favorite") where.push("favorite=1");
    if (backendId && agentId) {
      // Match participation across all rounds, before counting or paginating.
      where.push("EXISTS (SELECT 1 FROM executions WHERE idea_id=ideas.id AND backend_id=? AND agent_id=?)");
      args.push(backendId, agentId);
    }
    const search = query.toLocaleLowerCase();
    if (search) {
      if ([...search].length >= 3) {
        where.push("rowid IN (SELECT rowid FROM ideas_search WHERE ideas_search MATCH ?)");
        args.push(`"${search.replaceAll('"', '""')}"`);
      }
      where.push("instr(search,?)>0"); args.push(search);
    }
    const total = this.#statement(`SELECT COUNT(*) AS count FROM ideas WHERE ${where.join(" AND ")}`).get(...args).count;
    const after = this.#cursor(cursor);
    if (after) { where.push("(sort_at,id)>(?,?)"); args.push(-after.at, after.id); }
    const rows = this.#statement(`SELECT data FROM ideas WHERE ${where.join(" AND ")} ORDER BY sort_at,id LIMIT ?`)
      .all(...args, limit + 1).map(row => this.#decode("ideas", row));
    return { rows: rows.slice(0, limit), total, hasMore: rows.length > limit };
  }

  executionsPage({ id, cursor, limit }) {
    this.#assertOpen();
    const after = this.#cursor(cursor);
    const total = this.#statement("SELECT COUNT(*) AS count FROM executions WHERE idea_id=?").get(id).count;
    const rows = this.#statement(`SELECT data FROM executions WHERE idea_id=?
      ${after ? "AND (created_at,id)<(?,?)" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(id, ...(after ? [after.at, after.id] : []), limit + 1).map(row => this.#decode("executions", row));
    return { rows: rows.slice(0, limit), total, hasMore: rows.length > limit };
  }

  sessionExecutionsPage({ sessionKey, backendId, agentId, cursor, limit }) {
    this.#assertOpen();
    const after = this.#cursor(cursor);
    const where = "session_key=? AND backend_id=? AND agent_id=?";
    const args = [sessionKey, backendId, agentId];
    const total = this.#statement(`SELECT COUNT(*) AS count FROM executions WHERE ${where}`).get(...args).count;
    const rows = this.#statement(`SELECT data FROM executions WHERE ${where}
      ${after ? "AND (created_at,id)<(?,?)" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(...args, ...(after ? [after.at, after.id] : []), limit + 1).map(row => this.#decode("executions", row));
    return { rows: rows.slice(0, limit), total, hasMore: rows.length > limit };
  }

  dashboardExecutionsPage({ sinceMs, cursor, limit, finishedRunIds = [] }) {
    this.#assertOpen();
    const after = this.#cursor(cursor);
    // Include executions crossing midnight. Native completion times live in the
    // dispatcher; external times are part of the durable execution envelope.
    const where = `(created_at>=? OR json_extract(data,'$.external.finishedAt')>=?
      OR json_extract(data,'$.preparationFailure.occurredAt')>=?
      OR run_id IN (SELECT value FROM json_each(?)))
      AND idea_id IN (SELECT id FROM ideas WHERE deleted=0)`;
    const args = [sinceMs, sinceMs, sinceMs, JSON.stringify(finishedRunIds)];
    const total = this.#statement(`SELECT COUNT(*) AS count FROM executions WHERE ${where}`).get(...args).count;
    const rows = this.#statement(`SELECT data FROM executions WHERE ${where}
      ${after ? "AND (created_at,id)<(?,?)" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(...args, ...(after ? [after.at, after.id] : []), limit + 1).map(row => this.#decode("executions", row));
    return { rows: rows.slice(0, limit), total, hasMore: rows.length > limit };
  }

  // Explicit export for migrations and diagnostics; never used by ordinary reads or writes.
  exportSnapshot() {
    this.#assertOpen();
    const records = table => Object.fromEntries(this.#statement(`SELECT id,data FROM ${table}`).all().map(row => [row.id, JSON.parse(row.data)]));
    return { version: INSPIRATION_STORE_VERSION, revision: this.revision, ideas: records("ideas"), executions: records("executions"),
      operations: Object.fromEntries(this.#statement("SELECT id,fingerprint,type,target_id FROM operations").all()
        .map(row => [row.id, { fingerprint: row.fingerprint, type: row.type, id: row.target_id }])) };
  }

  importArchive(input) {
    if (!exact(input, ["operationId", "archiveId"]) || !UUID.test(input.archiveId)) fail("INSPIRATION_INVALID", "便签包无效");
    return this.#operate("import", input, candidate => {
      const attachment = this.media.descriptor(input.archiveId);
      if (attachment.mimeType !== ARCHIVE_MIME) fail("INSPIRATION_ARCHIVE_INVALID", "请选择便签包");
      const bytes = Buffer.concat(this.#statement("SELECT data FROM inspiration_media_chunks WHERE media_id=? ORDER BY offset")
        .all(input.archiveId).map(row => Buffer.from(row.data)));
      if (bytes.length !== attachment.size) fail("INSPIRATION_ARCHIVE_INVALID", "便签包不完整");
      const archive = readInspirationArchive(bytes);
      const media = new Map(), mediaIds = new Set();
      for (const [sourceId, file] of archive.files) {
        const id = this.randomUUID();
        if (this.#statement("SELECT id FROM inspiration_media WHERE id=?").get(id)
          || mediaIds.has(id)) fail("INSPIRATION_OPERATION_CONFLICT", "附件 ID 冲突");
        mediaIds.add(id);
        media.set(sourceId, { ...file, attachment: { ...file.attachment, id } });
      }
      let firstId;
      for (const source of archive.notes) {
        this.#safe({ body: source.body, title: source.title });
        const id = this.randomUUID();
        if (this.#record("ideas", id) || candidate.ideas[id]) fail("INSPIRATION_OPERATION_CONFLICT", "灵感 ID 冲突");
        const idea = { ...source, id, revision: 1, deletedAt: null,
          attachments: source.attachments.map(item => ({ ...item, id: media.get(item.id).attachment.id })) };
        if (!validIdea(idea)) fail("INSPIRATION_ARCHIVE_INVALID", "便签格式无效");
        candidate.ideas[id] = idea;
        firstId ??= id;
      }
      return { type: "ideas", id: firstId, beforeWrite: () => {
        for (const { attachment: saved, data } of media.values()) {
          this.#statement("INSERT INTO inspiration_media VALUES (?,?,?)").run(saved.id, JSON.stringify(saved), saved.size);
          for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
            this.#statement("INSERT INTO inspiration_media_chunks VALUES (?,?,?)").run(saved.id, offset, data.subarray(offset, offset + CHUNK_BYTES));
          }
        }
        this.#statement("DELETE FROM inspiration_media_chunks WHERE media_id=?").run(input.archiveId);
        this.#statement("DELETE FROM inspiration_media WHERE id=?").run(input.archiveId);
      } };
    });
  }

  create(input) {
    const hasTone = input && own(input, "paperTone");
    if (!exact(input, attachmentFields(input, hasTone ? ["operationId", "body", "paperTone"] : ["operationId", "body"]))
      || (own(input, "attachments") && !validAttachments(input.attachments))
      || (hasTone && !validInspirationPaperTone(input.paperTone)) || !textValue(input.body, MAX_BODY_BYTES, Boolean(input.attachments?.length))) {
      fail("INSPIRATION_INVALID", "请填写有效的灵感正文（最多 16 KiB）");
    }
    return this.#operate("create", input, (candidate) => {
      this.#safe({ body: input.body });
      if (input.attachments) this.media.assertAvailable(input.attachments);
      const id = this.randomUUID();
      const at = this.#at();
      if (this.#record("ideas", id)) fail("INSPIRATION_OPERATION_CONFLICT", "灵感 ID 冲突");
      candidate.ideas[id] = { id, body: input.body, title: null, revision: 1, favorite: false,
        archivedAt: null, acceptedAt: null, createdAt: at, updatedAt: at, deletedAt: null,
        ...(hasTone ? { paperTone: input.paperTone } : {}),
        ...(input.attachments ? { attachments: clone(input.attachments) } : {}) };
      return { type: "ideas", id };
    });
  }

  update(input, canUpdate = () => true) {
    if (!exact(input, ["operationId", "id", "expectedRevision", "patch"])
      || !UUID.test(input.id) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
      || !input.patch || typeof input.patch !== "object" || Array.isArray(input.patch)
      || Object.keys(input.patch).length === 0
      || Object.keys(input.patch).some((key) => !["body", "title", "favorite", "archived", "accepted", "attachments"].includes(key))
      || (own(input.patch, "body") && !textValue(input.patch.body, MAX_BODY_BYTES, true))
      || (own(input.patch, "attachments") && !validAttachments(input.patch.attachments))
      || (own(input.patch, "title") && input.patch.title !== null && !textValue(input.patch.title, 512))
      || ["favorite", "archived", "accepted"].some((key) => own(input.patch, key) && typeof input.patch[key] !== "boolean")) {
      fail("INSPIRATION_INVALID", "灵感修改内容无效");
    }
    return this.#operate("update", input, (candidate) => {
      const idea = candidate.ideas[input.id];
      if (!idea || idea.deletedAt !== null) fail("INSPIRATION_NOT_FOUND", "灵感不存在");
      if (idea.revision !== input.expectedRevision) fail("INSPIRATION_REVISION_CONFLICT", "灵感已在另一处更新，请先查看最新内容");
      canUpdate(clone(idea));
      this.#safe(input.patch);
      if (input.patch.attachments) this.media.assertAvailable(input.patch.attachments);
      if (!(input.patch.body ?? idea.body).trim() && !(input.patch.attachments ?? idea.attachments)?.length) {
        fail("INSPIRATION_INVALID", "请添加文字、图片或语音");
      }
      const at = Math.max(this.#at(), idea.updatedAt);
      for (const key of ["body", "title", "favorite", "attachments"]) if (own(input.patch, key)) idea[key] = clone(input.patch[key]);
      if (own(input.patch, "archived")) idea.archivedAt = input.patch.archived ? at : null;
      if (own(input.patch, "accepted")) idea.acceptedAt = input.patch.accepted ? at : null;
      if (own(input.patch, "body") || own(input.patch, "attachments")) idea.acceptedAt = null;
      // Favorites are a bookmark, not a content or growth update. Keep cursor
      // ordering stable when this is the only changed field.
      if (Object.keys(input.patch).some((key) => key !== "favorite")) idea.updatedAt = at;
      idea.revision += 1;
      return { type: "ideas", id: idea.id };
    });
  }

  delete(input, canDelete) {
    if (!exact(input, ["id", "operationId", "expectedRevision"]) || !UUID.test(input.id)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      fail("INSPIRATION_INVALID", "灵感删除参数无效");
    }
    return this.#operate("delete", input, (candidate) => {
      const idea = candidate.ideas[input.id];
      if (!idea || idea.deletedAt !== null) fail("INSPIRATION_NOT_FOUND", "灵感不存在");
      if (idea.revision !== input.expectedRevision) fail("INSPIRATION_REVISION_CONFLICT", "灵感已在另一处更新，请先查看最新内容");
      if (this.executions(idea.id).some((execution) => !canDelete(execution))) {
        fail("INSPIRATION_BUSY", "请先停止这条灵感的执行，再删除");
      }
      // Keep the identity and immutable execution snapshots for Session history
      // and durable operation replay. Deleted ideas can never execute again.
      const at = Math.max(this.#at(), idea.updatedAt);
      Object.assign(idea, { body: "", title: null, favorite: false, archivedAt: null,
        acceptedAt: null, deletedAt: at, updatedAt: at, revision: idea.revision + 1 });
      if (own(idea, "attachments")) idea.attachments = [];
      return { type: "ideas", id: idea.id };
    });
  }

  prepareExecution(input, canStart, sessionKey = null) {
    const fields = ["operationId", "id", "expectedRevision", "instruction", "agentId", "backendId", "profileId", "workspace"];
    if (own(input, "turnAttachments")) fields.push("turnAttachments");
    if (own(input, "inputSource")) fields.push("inputSource");
    if (!exact(input, fields)
      || (own(input, "inputSource") && (input.inputSource !== "chat" || sessionKey === null))
      || (own(input, "turnAttachments") && !validAttachments(input.turnAttachments))
      || !UUID.test(input.id) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
      || (sessionKey !== null && !UUID.test(sessionKey))
      || !textValue(input.instruction, MAX_BODY_BYTES, true)
      || ![input.agentId, input.backendId, input.profileId].every(validId)
      || !textValue(input.workspace, 4096) || !path.isAbsolute(input.workspace)) {
      fail("INSPIRATION_INVALID", "灵感执行参数无效");
    }
    return this.#operate("start", { ...input, sessionKey }, (candidate) => {
      if (input.turnAttachments?.length) this.media.assertAvailable(input.turnAttachments);
      const idea = candidate.ideas[input.id];
      if (!idea || idea.deletedAt !== null) fail("INSPIRATION_NOT_FOUND", "灵感不存在");
      if (idea.revision !== input.expectedRevision) fail("INSPIRATION_REVISION_CONFLICT", "灵感已更新，请重新查看后开始");
      if (idea.archivedAt !== null) fail("INSPIRATION_ARCHIVED", "请先恢复这条灵感");
      const previous = this.executions(idea.id);
      if (previous.some((execution) => (execution.external && !EXTERNAL_TERMINAL.has(execution.external.status))
        || !canStart(execution))) fail("INSPIRATION_BUSY", "这条灵感已有未结束的执行");
      this.#safe({ body: idea.body, instruction: input.instruction });
      const id = this.randomUUID();
      if (this.#record("executions", id)) fail("INSPIRATION_OPERATION_CONFLICT", "灵感执行 ID 冲突");
      const at = Math.max(this.#at(), idea.updatedAt, (previous[0]?.createdAt ?? -1) + 1);
      candidate.executions[id] = { id, ideaId: idea.id, operationId: input.operationId,
        ideaRevision: idea.revision, body: idea.body, title: idea.title, instruction: input.instruction,
        ...(input.inputSource ? { inputSource: input.inputSource } : {}),
        ...(idea.attachments ? { attachments: clone(idea.attachments) } : {}),
        ...(input.turnAttachments?.length ? { turnAttachments: clone(input.turnAttachments) } : {}),
        agentId: input.agentId, backendId: input.backendId, profileId: input.profileId,
        workspace: input.workspace, sessionKey, runId: this.randomUUID(),
        retryOf: previous.find((entry) => entry.preparationFailure === null)?.runId || null,
        createdAt: at, attention: null, preparationFailure: null, external: null };
      idea.acceptedAt = null;
      idea.updatedAt = at;
      idea.revision += 1;
      return { type: "executions", id };
    });
  }

  bindSession(executionId, sessionKey) {
    this.#assertOpen();
    const execution = this.#record("executions", executionId);
    if (!execution || execution.external !== null || !UUID.test(sessionKey)) fail("INSPIRATION_BINDING_INVALID", "灵感会话关联无效");
    if (execution.sessionKey === sessionKey) return clone(execution);
    if (execution.sessionKey !== null) fail("INSPIRATION_BINDING_INVALID", "灵感执行已关联其他会话");
    const candidate = this.#draft(null, executionId);
    candidate.executions[executionId].sessionKey = sessionKey;
    candidate.revision += 1;
    this.#commit(candidate);
    return clone(candidate.executions[executionId]);
  }

  prepareExternalExecution(input, canStart, sessionKey = null) {
    const fields = ["operationId", "id", "expectedRevision", "instruction", "agentId", "backendId", "workspace"];
    if (own(input, "inputSource")) fields.push("inputSource");
    if (!exact(input, fields)
      || (own(input, "inputSource") && (input.inputSource !== "chat" || sessionKey === null))
      || !UUID.test(input.id) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
      || (sessionKey !== null && !textValue(sessionKey, 512)) || typeof canStart !== "function"
      || !textValue(input.instruction, MAX_BODY_BYTES, true) || !validId(input.agentId)
      || !EXTERNAL_BACKENDS.has(input.backendId)
      || (input.workspace !== null && (!textValue(input.workspace, 4096) || !path.isAbsolute(input.workspace)))) {
      fail("INSPIRATION_INVALID", "外部灵感执行参数无效");
    }
    // sessionKey is derived from current compatible history; the validated
    // input fields identify a retry of the original reserve operation.
    return this.#operate("start-external", input, (candidate) => {
      const idea = candidate.ideas[input.id];
      if (!idea || idea.deletedAt !== null) fail("INSPIRATION_NOT_FOUND", "灵感不存在");
      if (idea.revision !== input.expectedRevision) fail("INSPIRATION_REVISION_CONFLICT", "灵感已更新，请重新查看后开始");
      if (idea.archivedAt !== null) fail("INSPIRATION_ARCHIVED", "请先恢复这条灵感");
      const previous = this.executions(idea.id);
      if (previous.some((execution) => (execution.external && !EXTERNAL_TERMINAL.has(execution.external.status))
        || !canStart(execution))) fail("INSPIRATION_BUSY", "这条灵感已有未结束的执行");
      this.#safe({ body: idea.body, instruction: input.instruction });
      const id = this.randomUUID();
      if (this.#record("executions", id)) fail("INSPIRATION_OPERATION_CONFLICT", "灵感执行 ID 冲突");
      const at = Math.max(this.#at(), idea.updatedAt, (previous[0]?.createdAt ?? -1) + 1);
      const execution = { id, ideaId: idea.id, operationId: input.operationId,
        ideaRevision: idea.revision, body: idea.body, title: idea.title, instruction: input.instruction,
        ...(input.inputSource ? { inputSource: input.inputSource } : {}),
        ...(idea.attachments ? { attachments: clone(idea.attachments) } : {}),
        agentId: input.agentId, backendId: input.backendId, profileId: null,
        workspace: input.workspace, sessionKey, runId: this.randomUUID(),
        retryOf: previous.find((entry) => entry.preparationFailure === null)?.runId || null,
        createdAt: at, attention: null, preparationFailure: null,
        external: { phase: "preparing", hostId: null, mode: null, status: "queued", sequence: 0,
          resultSummary: null, errorCode: null, finishedAt: null, attention: null,
          cancelOperationId: null, reconcileFingerprint: null } };
      this.#assertExternalSessionOwner(execution, sessionKey, input.workspace);
      candidate.executions[id] = execution;
      idea.acceptedAt = null;
      idea.updatedAt = at;
      idea.revision += 1;
      return { type: "executions", id };
    });
  }

  #externalExecution(executionId) {
    this.#assertOpen();
    const execution = this.#record("executions", executionId);
    if (!execution?.external) fail("INSPIRATION_BINDING_INVALID", "外部灵感执行不存在");
    return execution;
  }

  #assertExternalSessionOwner(execution, sessionKey, workspace) {
    if (sessionKey === null) return;
    for (const other of this.executionsForSession(sessionKey, execution.backendId)) {
      if (other.id === execution.id || other.backendId !== execution.backendId || other.sessionKey !== sessionKey) continue;
      if (other.ideaId !== execution.ideaId || other.agentId !== execution.agentId
        || (other.workspace !== null && workspace !== null && other.workspace !== workspace)) {
        fail("INSPIRATION_BINDING_INVALID", "外部会话已关联其他灵感、Agent 或目录");
      }
    }
  }

  #changeExternal(executionId, change) {
    const execution = this.#externalExecution(executionId);
    const candidate = this.#draft(null, executionId);
    change(candidate.executions[executionId]);
    if (canonicalJson(candidate.executions[executionId]) === canonicalJson(execution)) return clone(execution);
    candidate.revision += 1;
    this.#commit(candidate);
    return clone(candidate.executions[executionId]);
  }

  bindExternalSession(executionId, result) {
    const execution = this.#externalExecution(executionId);
    if (!validateExternalInspirationResult("inspiration.external.prepare", result)
      || (execution.backendId === "openclaw") !== (result.binding.mode === "openclaw")
      || (execution.sessionKey !== null && execution.sessionKey !== result.binding.sessionKey)
      || (execution.workspace !== null && execution.workspace !== result.binding.workspace)) {
      fail("INSPIRATION_BINDING_INVALID", "外部灵感会话关联不匹配");
    }
    if (EXTERNAL_TERMINAL.has(execution.external.status)) return clone(execution);
    if (execution.external.phase !== "preparing") {
      if (execution.external.hostId !== result.hostId || execution.external.mode !== result.binding.mode) {
        fail("INSPIRATION_BINDING_INVALID", "外部灵感执行已绑定其他主机或模式");
      }
      return clone(execution);
    }
    this.#assertExternalSessionOwner(execution, result.binding.sessionKey, result.binding.workspace);
    return this.#changeExternal(executionId, (next) => {
      next.sessionKey = result.binding.sessionKey;
      next.workspace = result.binding.workspace;
      Object.assign(next.external, { phase: "prepared", hostId: result.hostId, mode: result.binding.mode,
        status: "queued", errorCode: null, attention: null, reconcileFingerprint: null });
    });
  }

  markExternalDispatched(executionId) {
    const execution = this.#externalExecution(executionId);
    if (EXTERNAL_TERMINAL.has(execution.external.status) || execution.external.cancelOperationId !== null) {
      fail("INSPIRATION_BUSY", "外部灵感已结束或正在取消");
    }
    if (execution.external.phase === "dispatched") return clone(execution);
    if (execution.external.phase !== "prepared") fail("INSPIRATION_BINDING_INVALID", "外部灵感尚未绑定会话");
    return this.#changeExternal(executionId, (next) => {
      next.external.phase = "dispatched";
      next.external.status = "starting";
      next.external.errorCode = null;
      next.external.reconcileFingerprint = null;
    });
  }

  updateExternalSnapshot(executionId, result) {
    const execution = this.#externalExecution(executionId);
    if (!exact(result, ["hostId", "snapshot"]) || !UUID.test(result.hostId) || !validExternalSnapshot(result.snapshot)) {
      fail("INSPIRATION_RESPONSE_INVALID", "外部灵感执行状态无效");
    }
    const { snapshot } = result;
    if (execution.external.phase === "preparing"
      || snapshot.executionId !== execution.id || snapshot.runId !== execution.runId
      || ["backendId", "agentId", "sessionKey", "workspace"].some((field) => snapshot[field] !== execution[field])
      || snapshot.mode !== execution.external.mode
      || ((EXTERNAL_TERMINAL.has(snapshot.status) || snapshot.status === "unknown") && snapshot.attention?.active === true)) {
      fail("INSPIRATION_BINDING_INVALID", "外部灵感执行状态不属于已冻结的执行");
    }
    const external = execution.external;
    // Outcomes survive transport replacement and delayed observations.
    if (EXTERNAL_TERMINAL.has(external.status)) return clone(execution);
    const observation = externalObservation(snapshot);
    if (result.hostId === external.hostId) {
      if (snapshot.sequence < external.sequence) return clone(execution);
      if (snapshot.sequence === external.sequence) {
        const current = externalObservation(external);
        if (external.reconcileFingerprint !== null) {
          if (external.reconcileFingerprint !== fingerprint("external-observation", observation)) {
            fail("INSPIRATION_BINDING_INVALID", "同一外部执行序号出现不同内容");
          }
        } else if (canonicalJson(current) !== canonicalJson(observation)) {
          fail("INSPIRATION_BINDING_INVALID", "同一外部执行序号出现不同内容");
        } else {
          return clone(execution);
        }
      }
    }
    this.#safe({ resultSummary: observation.resultSummary, attention: observation.attention });
    return this.#changeExternal(executionId, (next) => {
      Object.assign(next.external, clone(observation), { hostId: result.hostId, reconcileFingerprint: null });
    });
  }

  setExternalCancel(executionId, operationId) {
    this.#externalExecution(executionId);
    if (!validId(operationId)) fail("INSPIRATION_INVALID", "取消操作标识无效");
    return this.#operate("cancel-external", { executionId, operationId }, (candidate) => {
      const execution = candidate.executions[executionId];
      // A new user click may retry an unconfirmed cancellation. Replaying an old
      // operation returns current state through #operate without restoring its ID.
      execution.external.cancelOperationId = operationId;
      return { type: "executions", id: executionId };
    });
  }

  markExternalUnknown(executionId, code) {
    const execution = this.#externalExecution(executionId);
    if (EXTERNAL_TERMINAL.has(execution.external.status)) return clone(execution);
    if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(code)) code = "EXTERNAL_EXECUTION_UNCONFIRMED";
    return this.#changeExternal(executionId, (next) => {
      if (next.external.hostId !== null && next.external.reconcileFingerprint === null) {
        next.external.reconcileFingerprint = fingerprint("external-observation", externalObservation(next.external));
      }
      next.external.status = "unknown";
      next.external.errorCode = code;
      next.external.finishedAt = null;
      if (next.external.attention) next.external.attention.active = false;
    });
  }

  finishExternalBeforeStart(executionId, { status, errorCode = null } = {}) {
    const execution = this.#externalExecution(executionId);
    if (!["canceled", "failed"].includes(status)
      || (errorCode !== null && (typeof errorCode !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(errorCode)))) {
      fail("INSPIRATION_INVALID", "外部灵感准备结果无效");
    }
    if (EXTERNAL_TERMINAL.has(execution.external.status)) return clone(execution);
    if (!["preparing", "prepared"].includes(execution.external.phase)) {
      fail("INSPIRATION_BINDING_INVALID", "已发送的外部执行必须向后端核对结果");
    }
    return this.#changeExternal(executionId, (next) => {
      Object.assign(next.external, { status, errorCode, finishedAt: this.#at(), attention: null, reconcileFingerprint: null });
    });
  }

  replayResponse(input) {
    this.#assertOpen();
    const operation = this.#operation(input.operationId);
    if (!operation) return false;
    if (operation.fingerprint !== fingerprint("respond", input)) {
      fail("INSPIRATION_OPERATION_CONFLICT", "同一次操作不能更换内容");
    }
    return true;
  }

  recordResponse(input) {
    return this.#operate("respond", input, () => {
      const execution = this.executionForRun(input.runId);
      if (!execution || execution.ideaId !== input.id) fail("INSPIRATION_BINDING_INVALID", "响应不属于这条灵感");
      return { type: "ideas", id: input.id };
    });
  }

  failPreparation(executionId, code) {
    this.#assertOpen();
    if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(code)) code = "INSPIRATION_START_FAILED";
    const execution = this.#record("executions", executionId);
    if (!execution) fail("INSPIRATION_BINDING_INVALID", "灵感执行不存在");
    if (execution.external && EXTERNAL_TERMINAL.has(execution.external.status)) return clone(execution);
    if (execution.external?.phase === "dispatched") {
      fail("INSPIRATION_BINDING_INVALID", "已发送的外部执行必须向后端核对结果");
    }
    if (execution.preparationFailure) return clone(execution);
    const candidate = this.#draft(null, executionId);
    const occurredAt = this.#at();
    candidate.executions[executionId].preparationFailure = { code, occurredAt };
    if (execution.external) Object.assign(candidate.executions[executionId].external, {
      status: "failed", errorCode: code, finishedAt: occurredAt, attention: null, reconcileFingerprint: null,
    });
    candidate.revision += 1;
    this.#commit(candidate);
    return clone(candidate.executions[executionId]);
  }

  recordAttention(runId, attention) {
    const execution = this.executionForRun(runId);
    if (!execution || execution.external !== null) fail("INSPIRATION_BINDING_INVALID", "原生灵感执行不存在");
    if (canonicalJson(execution.attention) === canonicalJson(attention)) return;
    this.#safe(attention);
    const candidate = this.#draft(null, execution.id);
    candidate.executions[execution.id].attention = clone(attention);
    candidate.revision += 1;
    this.#commit(candidate);
  }
}

module.exports = { InspirationStore, INSPIRATION_STORE_VERSION, IDEA_FIELDS, EXECUTION_FIELDS, OPERATION_FIELDS,
  MAX_BODY_BYTES, canonicalJson };
