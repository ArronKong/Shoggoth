"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { readPrivateFile, validatePrivateStat, writeFully } = require("./private-file");
const { ensurePrivateDirectoryTree, lstatIfExists, serviceError } = require("./security");

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const CODEX_SOURCE_REF = /^codex-memory:[a-f0-9]{32}$/u;
const SAFE_IMPORT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,127}\.(?:md|txt|json)$/iu;
const ORIGINS = new Set(["conversation", "ui_create", "ui_edit", "import"]);
const MAX_LOG_BYTES = 64 * 1024 * 1024;

function error(code, message) { return serviceError(code, message); }
function hash(value) { return crypto.createHash("sha256").update(value, "utf8").digest("hex"); }
function fileIdentity(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function same(a, b) { return stableJson(a) === stableJson(b); }
function optionalId(value) { return value === null || (typeof value === "string" && ID.test(value)); }
function optionalHash(value) { return value === null || (typeof value === "string" && HASH.test(value)); }
function validImportFile(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 3
    && ["name", "fileHash", "sourceRef"].every((key) => Object.hasOwn(value, key))
    && (value.name === null || (typeof value.name === "string"
      && Buffer.byteLength(value.name, "utf8") <= 255
      && SAFE_IMPORT_NAME.test(value.name) && !value.name.includes("..")))
    && typeof value.fileHash === "string" && HASH.test(value.fileHash)
    && typeof value.sourceRef === "string" && CODEX_SOURCE_REF.test(value.sourceRef);
}

function validateEntry(value, profileId, schemaVersion = 1) {
  const keys = ["operationId", "profileId", "memoryId", "memoryRevision", "contentHash", "origin",
    "runId", "sessionId", "eventId", "eventTextHash", "quoteHash", "quoteStartUtf16",
    "quoteEndUtf16", "observedAt"];
  if (schemaVersion === 2) keys.push("importFile");
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))
    || !ID.test(value.operationId) || !ID.test(value.profileId) || value.profileId !== profileId
    || !ID.test(value.memoryId) || !Number.isSafeInteger(value.memoryRevision)
    || value.memoryRevision < 1 || !HASH.test(value.contentHash)
    || !ORIGINS.has(value.origin) || !optionalId(value.runId) || !optionalId(value.sessionId)
    || !optionalId(value.eventId) || !optionalHash(value.eventTextHash)
    || !optionalHash(value.quoteHash) || !Number.isSafeInteger(value.observedAt)
    || value.observedAt < 0 || ![1, 2].includes(schemaVersion)
    || (schemaVersion === 2 && (value.origin !== "import" || !validImportFile(value.importFile)))) {
    throw error("MEMORY_PROVENANCE_INVALID", "来源记录无效");
  }
  const hasRange = value.quoteStartUtf16 !== null || value.quoteEndUtf16 !== null;
  if ((value.origin === "conversation") !== (value.runId !== null && value.sessionId !== null
    && value.eventId !== null && value.eventTextHash !== null)
    || (value.origin !== "conversation" && (value.runId !== null || value.sessionId !== null
      || value.eventId !== null || value.eventTextHash !== null || value.quoteHash !== null || hasRange))
    || (hasRange && (!Number.isSafeInteger(value.quoteStartUtf16)
      || !Number.isSafeInteger(value.quoteEndUtf16) || value.quoteStartUtf16 < 0
      || value.quoteEndUtf16 <= value.quoteStartUtf16 || value.quoteHash === null))
    || (!hasRange && value.quoteHash !== null)) {
    throw error("MEMORY_PROVENANCE_INVALID", "来源记录范围无效");
  }
  return structuredClone(value);
}

class MemoryProvenanceStore {
  constructor({ paths, fs: fileSystem = fs, now = Date.now, maxLogBytes = MAX_LOG_BYTES }) {
    this.paths = paths;
    this.fs = fileSystem;
    this.now = now;
    this.maxLogBytes = maxLogBytes;
    this.opened = false;
    this.profiles = new Map();
    this.poisonError = null;
  }
  open() {
    if (this.opened) return;
    ensurePrivateDirectoryTree(this.paths.agentsDir, this.paths.trustedRoot);
    this.profiles.clear(); this.poisonError = null; this.opened = true;
  }
  close() { this.profiles.clear(); this.poisonError = null; this.opened = false; }
  forgetProfile(profileId) { this.profiles.delete(profileId); }
  _assertOpen(write = false) {
    if (!this.opened) throw error("MEMORY_PROVENANCE_CLOSED", "来源记录未打开");
    if (write && this.poisonError) throw this.poisonError;
  }
  _path(profileId) {
    if (typeof profileId !== "string" || !ID.test(profileId)) {
      throw error("MEMORY_PROVENANCE_INVALID", "Profile ID 无效");
    }
    return path.join(this.paths.agentsDir, profileId, "memory", "provenance.jsonl");
  }
  _load(profileId) {
    this._assertOpen();
    const target = this._path(profileId);
    const cached = this.profiles.get(profileId);
    if (cached) {
      const current = lstatIfExists(target);
      if (!current) {
        if (cached.identity === null) return cached;
        throw error("MEMORY_PROVENANCE_UNAVAILABLE", "来源日志在运行中丢失");
      }
      const identity = fileIdentity(validatePrivateStat(current, target));
      if (identity === cached.identity) return cached;
      this.profiles.delete(profileId);
    }
    ensurePrivateDirectoryTree(path.dirname(target), this.paths.trustedRoot);
    const state = { entries: [], byOperation: new Map(), identity: null };
    const stat = lstatIfExists(target);
    if (stat) {
      validatePrivateStat(stat, target);
      let expectedIdentity = fileIdentity(stat);
      if (stat.size > this.maxLogBytes) throw error("MEMORY_PROVENANCE_CORRUPT", "来源日志超限");
      let data = readPrivateFile(target, { fs: this.fs, maxBytes: this.maxLogBytes });
      if (data.length && data.at(-1) !== 0x0a) {
        const newline = data.lastIndexOf(0x0a);
        const size = newline < 0 ? 0 : newline + 1;
        const fd = this.fs.openSync(target, this.fs.constants.O_RDWR | (this.fs.constants.O_NOFOLLOW || 0));
        try { validatePrivateStat(this.fs.fstatSync(fd), target); this.fs.ftruncateSync(fd, size); this.fs.fsyncSync(fd); }
        finally { this.fs.closeSync(fd); }
        data = data.subarray(0, size);
        expectedIdentity = fileIdentity(validatePrivateStat(this.fs.lstatSync(target), target));
      }
      if (data.length) {
        const lines = data.toString("utf8").slice(0, -1).split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          let record;
          try { record = JSON.parse(lines[index]); }
          catch { throw error("MEMORY_PROVENANCE_CORRUPT", "来源日志 JSON 损坏"); }
          const expected = { schemaVersion: record?.schemaVersion, seq: index + 1,
            type: "provenance.add", payload: record?.payload };
          if (!record || Object.keys(record).length !== 5 || ![1, 2].includes(record.schemaVersion)
            || record.seq !== index + 1 || record.type !== "provenance.add"
            || typeof record.checksum !== "string" || !HASH.test(record.checksum)
            || record.checksum !== hash(stableJson(expected))) {
            throw error("MEMORY_PROVENANCE_CORRUPT", "来源日志校验失败");
          }
          let entry;
          try { entry = validateEntry(record.payload, profileId, record.schemaVersion); }
          catch { throw error("MEMORY_PROVENANCE_CORRUPT", "来源日志记录无效"); }
          const prior = state.byOperation.get(entry.operationId);
          if (prior && !same(prior, entry)) throw error("MEMORY_PROVENANCE_CORRUPT", "来源操作冲突");
          state.entries.push(entry); state.byOperation.set(entry.operationId, entry);
        }
      }
      const after = lstatIfExists(target);
      if (!after || fileIdentity(validatePrivateStat(after, target)) !== expectedIdentity) {
        throw error("MEMORY_PROVENANCE_UNAVAILABLE", "来源日志读取期间发生变化");
      }
      state.identity = expectedIdentity;
    }
    this.profiles.set(profileId, state);
    return state;
  }
  append(input) {
    this._assertOpen(true);
    const schemaVersion = Object.hasOwn(input, "importFile") ? 2 : 1;
    const entry = validateEntry({ ...input, observedAt: input.observedAt ?? this.now() },
      input.profileId, schemaVersion);
    const state = this._load(entry.profileId);
    const prior = state.byOperation.get(entry.operationId);
    if (prior) {
      if (!same({ ...prior, observedAt: entry.observedAt }, entry)) {
        throw error("MEMORY_PROVENANCE_CONFLICT", "operationId 来源不一致");
      }
      return structuredClone(prior);
    }
    const record = { schemaVersion, seq: state.entries.length + 1,
      type: "provenance.add", payload: entry };
    record.checksum = hash(stableJson(record));
    const line = `${stableJson(record)}\n`;
    const target = this._path(entry.profileId);
    if ((lstatIfExists(target)?.size || 0) + Buffer.byteLength(line, "utf8") > this.maxLogBytes) {
      throw error("MEMORY_PROVENANCE_FULL", "来源日志已满");
    }
    let fd;
    try {
      fd = this.fs.openSync(target, this.fs.constants.O_CREAT | this.fs.constants.O_APPEND
        | this.fs.constants.O_WRONLY | (this.fs.constants.O_NOFOLLOW || 0), 0o600);
      validatePrivateStat(this.fs.fstatSync(fd), target);
      this.fs.fchmodSync(fd, 0o600);
      writeFully(this.fs, fd, line, "MEMORY_PROVENANCE_WRITE_FAILED"); this.fs.fsyncSync(fd);
    } catch (cause) {
      this.poisonError = error("MEMORY_PROVENANCE_COMMIT_UNCERTAIN", "来源日志写入结果不确定");
      this.poisonError.cause = cause;
      throw this.poisonError;
    } finally { if (fd !== undefined) this.fs.closeSync(fd); }
    state.identity = fileIdentity(validatePrivateStat(this.fs.lstatSync(target), target));
    state.entries.push(entry); state.byOperation.set(entry.operationId, entry);
    return structuredClone(entry);
  }
  getByOperation(profileId, operationId) {
    return structuredClone(this._load(profileId).byOperation.get(operationId) || null);
  }
  findForItem(profileId, item, contentRevision = null) {
    const expectedHash = hash(item.content);
    const entries = this._load(profileId).entries;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.memoryId === item.id && entry.contentHash === expectedHash
        && (contentRevision === null || entry.memoryRevision === contentRevision)) return structuredClone(entry);
    }
    return null;
  }
}

module.exports = { MemoryProvenanceStore, validateEntry };
