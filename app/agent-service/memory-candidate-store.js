"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile,
  statIfExists, validatePrivateStat,
} = require("./private-file");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");

const SCHEMA_VERSION = 3;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_CANDIDATES = 4096;
const MAX_OPERATIONS = 512;
const MAX_DEFERRED_EVENTS_PER_SESSION = 8192;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const STATUSES = new Set(["pending", "accepted", "rejected"]);
const OPERATION_STATUSES = new Set(["started", "completed", "failed", "interrupted", "canceled"]);

function error(code, message) { return serviceError(code, message); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function checksum(value) {
  const copy = { ...value };
  delete copy.checksum;
  return crypto.createHash("sha256").update(stableJson(copy)).digest("hex");
}
function exact(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}
function validId(value) { return typeof value === "string" && ID.test(value); }
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function validSource(source) {
  return exact(source, ["sessionId", "eventId", "runId", "seq", "contentHash",
    "quoteHash", "quoteStart", "quoteLength", "workspace"])
    && [source.sessionId, source.eventId, source.runId].every(validId)
    && integer(source.seq) && source.seq > 0
    && HASH.test(source.contentHash) && HASH.test(source.quoteHash)
    && integer(source.quoteStart) && integer(source.quoteLength) && source.quoteLength > 0
    && (source.workspace === null || typeof source.workspace === "string"
      && source.workspace.length > 0 && source.workspace.length <= 4096
      && source.workspace.isWellFormed() && !source.workspace.includes("\0"));
}
function validCandidate(value, profileId) {
  return exact(value, ["id", "profileId", "content", "scope", "sensitivity", "source", "status",
    "createdAt", "updatedAt", "acceptedMemoryId"])
    && validId(value.id) && value.profileId === profileId
    && typeof value.content === "string" && value.content.trim()
    && value.content.isWellFormed() && !value.content.includes("\0")
    && Buffer.byteLength(value.content, "utf8") <= 2048
    && ["user", "project", "workspace"].includes(value.scope)
    && ["normal", "private"].includes(value.sensitivity)
    && validSource(value.source) && STATUSES.has(value.status)
    && integer(value.createdAt) && integer(value.updatedAt) && value.updatedAt >= value.createdAt
    && (value.status === "accepted" ? validId(value.acceptedMemoryId)
      : value.acceptedMemoryId === null);
}
function validOperation(value) {
  return exact(value, ["operationId", "sessionId", "day", "status", "startedAt", "finishedAt",
    "errorCode", "inputTokens", "outputTokens", "model", "runtime", "runtimeAccountId"])
    && validId(value.operationId) && validId(value.sessionId)
    && /^\d{4}-\d{2}-\d{2}$/u.test(value.day)
    && OPERATION_STATUSES.has(value.status) && integer(value.startedAt)
    && (value.status === "started" ? value.finishedAt === null : integer(value.finishedAt)
      && value.finishedAt >= value.startedAt)
    && (value.errorCode === null || validId(value.errorCode))
    && integer(value.inputTokens) && integer(value.outputTokens)
    && [value.model, value.runtime, value.runtimeAccountId].every((field) => field === null
      || typeof field === "string" && field.length <= 512 && field.isWellFormed()
        && !field.includes("\0"));
}
function validState(value, profileId, version = SCHEMA_VERSION) {
  if (!exact(value, ["schemaVersion", "profileId", "revision", "cursors", "candidates",
    "usage", ...(version === 1 ? [] : ["operations"]), "checksum"])
    || value.schemaVersion !== version || value.profileId !== profileId
    || !integer(value.revision) || !HASH.test(value.checksum)
    || !value.cursors || typeof value.cursors !== "object" || Array.isArray(value.cursors)
    || Object.getPrototypeOf(value.cursors) !== Object.prototype
    || !value.candidates || typeof value.candidates !== "object" || Array.isArray(value.candidates)
    || Object.getPrototypeOf(value.candidates) !== Object.prototype
    || Object.keys(value.candidates).length > MAX_CANDIDATES
    || !exact(value.usage, ["day", "calls", "inputTokens", "outputTokens"])
    || !(value.usage.day === null || /^\d{4}-\d{2}-\d{2}$/u.test(value.usage.day))
    || ![value.usage.calls, value.usage.inputTokens, value.usage.outputTokens].every(integer)
    || checksum(value) !== value.checksum
    || (version >= 2 && (!Array.isArray(value.operations) || value.operations.length > MAX_OPERATIONS
      || value.operations.some((operation) => !validOperation(operation))
      || new Set(value.operations.map((operation) => operation.operationId)).size !== value.operations.length))) return false;
  for (const [sessionId, cursor] of Object.entries(value.cursors)) {
    if (!validId(sessionId) || !exact(cursor, ["throughSeq", "transcriptRevision", "updatedAt",
      ...(version >= 3 ? ["deferredSeqs"] : [])])
      || ![cursor.throughSeq, cursor.transcriptRevision, cursor.updatedAt].every(integer)) return false;
    if (version >= 3 && (!Array.isArray(cursor.deferredSeqs)
      || cursor.deferredSeqs.length > MAX_DEFERRED_EVENTS_PER_SESSION
      || cursor.deferredSeqs.some((seq, index) => !integer(seq) || seq < 1
        || seq > cursor.throughSeq || (index > 0 && seq <= cursor.deferredSeqs[index - 1])))) return false;
  }
  for (const [id, candidate] of Object.entries(value.candidates)) {
    if (id !== candidate?.id || !validCandidate(candidate, profileId)) return false;
  }
  return true;
}

class MemoryCandidateStore {
  constructor({ paths, now = Date.now, fs: fileSystem = fs }) {
    if (!paths?.agentsDir || !paths?.trustedRoot) throw new TypeError("MemoryCandidateStore paths 无效");
    this.paths = paths;
    this.now = now;
    this.fs = fileSystem;
  }

  _file(profileId) {
    if (!validId(profileId)) throw error("MEMORY_CANDIDATE_INVALID", "Profile 无效");
    const dir = path.join(this.paths.agentsDir, profileId, "memory");
    ensurePrivateDirectoryTree(dir, this.paths.trustedRoot);
    return path.join(dir, "candidate-review.json");
  }

  _fresh(profileId) {
    const state = { schemaVersion: SCHEMA_VERSION, profileId, revision: 0,
      cursors: {}, candidates: {}, operations: [],
      usage: { day: null, calls: 0, inputTokens: 0, outputTokens: 0 } };
    state.checksum = checksum(state);
    return state;
  }

  _load(profileId) {
    const file = this._file(profileId);
    const recovery = recoverInterruptedPrivateFile(file, { fs: this.fs, trustedRoot: this.paths.trustedRoot });
    if (recovery === "uncertain") throw error("MEMORY_CANDIDATE_UNAVAILABLE", "候选队列写入状态不确定");
    const stat = statIfExists(this.fs, file);
    if (!stat) return { file, state: this._fresh(profileId), identity: null };
    validatePrivateStat(stat, file);
    let state;
    try { state = JSON.parse(readPrivateFile(file, { fs: this.fs, maxBytes: MAX_BYTES }).toString("utf8")); }
    catch (cause) { const failed = error("MEMORY_CANDIDATE_CORRUPT", "候选队列不可读取"); failed.cause = cause; throw failed; }
    if ([1, 2].includes(state?.schemaVersion) && validState(state, profileId, state.schemaVersion)) {
      state = { ...state, schemaVersion: SCHEMA_VERSION,
        operations: state.schemaVersion === 1 ? [] : state.operations,
        cursors: Object.fromEntries(Object.entries(state.cursors).map(([id, cursor]) =>
          [id, { ...cursor, transcriptRevision: cursor.throughSeq > 0 ? 0
            : cursor.transcriptRevision, deferredSeqs: [] }])) };
      state.checksum = checksum(state);
    }
    if (!validState(state, profileId)) throw error("MEMORY_CANDIDATE_CORRUPT", "候选队列校验失败");
    return { file, state, identity: {
      dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs,
    } };
  }

  get(profileId) { return structuredClone(this._load(profileId).state); }

  mutate(profileId, expectedRevision, mutate) {
    const loaded = this._load(profileId);
    if (expectedRevision !== null && loaded.state.revision !== expectedRevision) {
      throw error("MEMORY_CANDIDATE_REVISION_CONFLICT", "候选队列已变化，请重新读取");
    }
    const next = structuredClone(loaded.state);
    const result = mutate(next);
    if (stableJson({ ...next, checksum: null }) === stableJson({ ...loaded.state, checksum: null })) {
      return { state: structuredClone(loaded.state), result };
    }
    next.revision++;
    next.checksum = checksum(next);
    if (!validState(next, profileId)) throw error("MEMORY_CANDIDATE_INVALID", "候选队列更新无效");
    const encoded = `${stableJson(next)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > MAX_BYTES) {
      throw error("MEMORY_CANDIDATE_CAPACITY", "候选队列容量已满");
    }
    atomicWritePrivateFile(loaded.file, encoded, { fs: this.fs,
      trustedRoot: this.paths.trustedRoot,
      ...(loaded.identity ? { expectedIdentity: loaded.identity } : {}) });
    return { state: structuredClone(next), result };
  }
}

module.exports = { MemoryCandidateStore, MAX_CANDIDATES, MAX_OPERATIONS,
  MAX_DEFERRED_EVENTS_PER_SESSION, checksum, validCandidate };
