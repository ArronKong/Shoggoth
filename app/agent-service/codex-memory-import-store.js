"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { lstatIfExists, serviceError } = require("./security");

const LEDGER_VERSION = 2;
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
// abandoned: the system task and its one retry failed; no automatic restart.
const STATES = new Set(["idle", "no_source", "running", "deferred", "completed", "abandoned", "failed"]);
const CHUNK_STATES = new Set(["pending", "proposed", "done", "skipped"]);

function ledgerError(code, message) { return serviceError(code, message); }
function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function count(value) { return Number.isSafeInteger(value) && value >= 0; }

function emptyLedger(profileId) {
  return {
    version: LEDGER_VERSION, profileId, revision: 0, state: "idle", reason: null,
    sources: [], chunks: {}, evidence: {},
    totals: { modelCalls: 0, inputTokens: 0, outputTokens: 0 },
    updatedAt: null, completedAt: null,
  };
}

function validLedger(value, profileId) {
  return plain(value) && [1, LEDGER_VERSION].includes(value.version) && value.profileId === profileId
    && (value.version !== 1 || value.task === undefined)
    && count(value.revision) && STATES.has(value.state)
    && (value.reason === null || (typeof value.reason === "string" && ID.test(value.reason)))
    && Array.isArray(value.sources) && plain(value.chunks) && plain(value.evidence)
    && Object.values(value.chunks).every((chunk) => plain(chunk) && CHUNK_STATES.has(chunk.state)
      && count(chunk.attempts) && count(chunk.imported) && plain(chunk.skipped)
      && (chunk.facts === null || Array.isArray(chunk.facts)))
    && Object.values(value.evidence).every((entry) => plain(entry) && typeof entry.excerpt === "string")
    && plain(value.totals) && ["modelCalls", "inputTokens", "outputTokens"].every((key) => count(value.totals[key]))
    && (value.task === undefined || (plain(value.task) && plain(value.task.create)
      && typeof value.task.create.operationId === "string" && typeof value.task.create.prompt === "string"
      && (value.task.jobId === null || typeof value.task.jobId === "string")
      && (value.task.retry === null || (plain(value.task.retry)
        && typeof value.task.retry.operationId === "string" && typeof value.task.retry.retryOf === "string"
        && typeof value.task.retry.jobId === "string" && count(value.task.retry.createdAt)))))
    && (value.updatedAt === null || count(value.updatedAt))
    && (value.completedAt === null || count(value.completedAt));
}

// Progress of a one-time Codex memory import for one Agent. It also keeps the
// cited source excerpts, which provenance records reference only by hash.
class CodexMemoryImportStore {
  constructor({ paths, fs: fileSystem = fs, now = Date.now }) {
    this.paths = paths;
    this.fs = fileSystem;
    this.now = now;
  }
  _path(profileId) {
    if (typeof profileId !== "string" || !ID.test(profileId)) {
      throw ledgerError("CODEX_MEMORY_IMPORT_INVALID", "Profile ID 无效");
    }
    return path.join(this.paths.agentsDir, profileId, "memory", "codex-import.json");
  }
  get(profileId) {
    const target = this._path(profileId);
    if (!lstatIfExists(target)) return emptyLedger(profileId);
    let value;
    try { value = JSON.parse(readPrivateFile(target, { fs: this.fs, maxBytes: MAX_LEDGER_BYTES }).toString("utf8")); }
    catch { throw ledgerError("CODEX_MEMORY_IMPORT_LEDGER_CORRUPT", "Codex 记忆导入记录损坏"); }
    if (!validLedger(value, profileId)) {
      throw ledgerError("CODEX_MEMORY_IMPORT_LEDGER_CORRUPT", "Codex 记忆导入记录损坏");
    }
    return value;
  }
  mutate(profileId, change) {
    const current = this.get(profileId);
    const next = change(structuredClone(current));
    next.version = LEDGER_VERSION;
    next.revision = current.revision + 1;
    next.updatedAt = this.now();
    if (!validLedger(next, profileId)) {
      throw ledgerError("CODEX_MEMORY_IMPORT_INVALID", "Codex 记忆导入记录无效");
    }
    const encoded = `${JSON.stringify(next)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > MAX_LEDGER_BYTES) {
      throw ledgerError("CODEX_MEMORY_IMPORT_LEDGER_FULL", "Codex 记忆导入记录超过容量");
    }
    atomicWritePrivateFile(this._path(profileId), encoded, { fs: this.fs, trustedRoot: this.paths.trustedRoot });
    return next;
  }
  excerpt(profileId, sourceRef) {
    const entry = this.get(profileId).evidence[sourceRef];
    return typeof entry?.excerpt === "string" ? entry.excerpt : null;
  }
}

module.exports = { CodexMemoryImportStore, emptyLedger };
