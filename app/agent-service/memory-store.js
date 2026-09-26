"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  atomicWritePrivateFile,
  readPrivateFile,
  validatePrivateStat,
  writeFully,
} = require("./private-file");
const { ensurePrivateDirectoryTree, lstatIfExists, serviceError } = require("./security");

const MEMORY_SCHEMA_VERSION = 1;
const MEMORY_SCOPES = Object.freeze(["user", "agent", "project", "workspace"]);
const MEMORY_TYPES = Object.freeze(["semantic", "episodic", "procedural", "project", "temporary"]);
const MEMORY_SENSITIVITIES = Object.freeze(["normal", "private", "restricted"]);
const MEMORY_STATUSES = Object.freeze(["candidate", "active", "superseded", "deleted"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_CONTENT_BYTES = 8 * 1024;
const MAX_SOURCE_REFS = 64;
const MAX_ITEMS = 100_000;
const MAX_LOG_BYTES = 256 * 1024 * 1024;

function memoryError(code, message) { return serviceError(code, message); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function exactKeys(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}
function assertId(value, field) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw memoryError("MEMORY_INVALID", `${field} 无效`);
  }
  return value;
}
function validateMemoryItem(input, expectedProfileId = null) {
  const fields = [
    "id", "profileId", "scope", "type", "content", "sourceRefs", "confidence",
    "sensitivity", "status", "validFrom", "validUntil", "supersedes", "createdAt", "updatedAt",
  ];
  if (!exactKeys(input, fields)) throw memoryError("MEMORY_INVALID", "MemoryItem 字段无效");
  assertId(input.id, "memory.id");
  assertId(input.profileId, "memory.profileId");
  if (expectedProfileId !== null && input.profileId !== expectedProfileId) {
    throw memoryError("MEMORY_INVALID", "MemoryItem profileId 不匹配");
  }
  if (!MEMORY_SCOPES.includes(input.scope) || !MEMORY_TYPES.includes(input.type)
    || typeof input.content !== "string" || !input.content.isWellFormed() || input.content.includes("\0")
    || Buffer.byteLength(input.content, "utf8") === 0
    || Buffer.byteLength(input.content, "utf8") > MAX_CONTENT_BYTES
    || !Array.isArray(input.sourceRefs) || input.sourceRefs.length === 0
    || input.sourceRefs.length > MAX_SOURCE_REFS
    || input.sourceRefs.some((ref) => typeof ref !== "string" || !ID_PATTERN.test(ref))
    || new Set(input.sourceRefs).size !== input.sourceRefs.length
    || typeof input.confidence !== "number" || !Number.isFinite(input.confidence)
    || input.confidence < 0 || input.confidence > 1
    || !MEMORY_SENSITIVITIES.includes(input.sensitivity)
    || !MEMORY_STATUSES.includes(input.status)
    || !Number.isSafeInteger(input.validFrom) || input.validFrom < 0
    || (input.validUntil !== null && (!Number.isSafeInteger(input.validUntil)
      || input.validUntil < input.validFrom))
    || (input.supersedes !== null && !ID_PATTERN.test(input.supersedes))
    || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0
    || !Number.isSafeInteger(input.updatedAt) || input.updatedAt < input.createdAt) {
    throw memoryError("MEMORY_INVALID", "MemoryItem 值无效");
  }
  return structuredClone(input);
}
function recordChecksum(record) {
  const copy = { ...record }; delete copy.checksum; return sha256(stableJson(copy));
}
function snapshotChecksum(snapshot) {
  const copy = { ...snapshot }; delete copy.checksum; return sha256(stableJson(copy));
}

class MemoryStore {
  constructor(options) {
    this.paths = options.paths;
    this.fs = options.fs || fs;
    this.maxLogBytes = options.maxLogBytes ?? MAX_LOG_BYTES;
    this.opened = false;
    this.profiles = new Map();
    this.poisonError = null;
  }

  _assertOpen(write = false) {
    if (!this.opened) throw memoryError("MEMORY_STORE_CLOSED", "Memory Store 未打开");
    if (write && this.poisonError) throw this.poisonError;
  }
  _dir(profileId) { return path.join(this.paths.agentsDir, assertId(profileId, "profileId"), "memory"); }
  _paths(profileId) {
    const dir = this._dir(profileId);
    return { dir, log: path.join(dir, "events.jsonl"), snapshot: path.join(dir, "snapshot.json") };
  }
  open() {
    if (this.opened) return;
    ensurePrivateDirectoryTree(this.paths.agentsDir, this.paths.trustedRoot);
    this.profiles.clear(); this.poisonError = null; this.opened = true;
  }
  close() { this.profiles.clear(); this.poisonError = null; this.opened = false; }
  forgetProfile(profileId) { this._assertOpen(); this.profiles.delete(profileId); }
  _empty(profileId) { return { profileId, revision: 0, items: new Map() }; }
  _snapshot(state) {
    const snapshot = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      profileId: state.profileId,
      revision: state.revision,
      items: [...state.items.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
    snapshot.checksum = snapshotChecksum(snapshot);
    return snapshot;
  }
  _writeSnapshot(state) {
    const target = this._paths(state.profileId).snapshot;
    atomicWritePrivateFile(target, `${stableJson(this._snapshot(state))}\n`, {
      fs: this.fs, trustedRoot: this.paths.trustedRoot,
    });
  }
  _repairTail(target) {
    const stat = lstatIfExists(target);
    if (!stat) return Buffer.alloc(0);
    validatePrivateStat(stat, target);
    if (stat.size > this.maxLogBytes) throw memoryError("MEMORY_LOG_TOO_LARGE", "Memory journal 超限");
    const buffer = readPrivateFile(target, { fs: this.fs, maxBytes: this.maxLogBytes });
    if (buffer.length === 0 || buffer.at(-1) === 0x0a) return buffer;
    const newline = buffer.lastIndexOf(0x0a);
    const size = newline < 0 ? 0 : newline + 1;
    const fd = this.fs.openSync(target, this.fs.constants.O_RDWR | (this.fs.constants.O_NOFOLLOW || 0));
    try { validatePrivateStat(this.fs.fstatSync(fd), target); this.fs.ftruncateSync(fd, size); this.fs.fsyncSync(fd); }
    finally { this.fs.closeSync(fd); }
    return buffer.subarray(0, size);
  }
  _load(profileId) {
    this._assertOpen();
    assertId(profileId, "profileId");
    if (this.profiles.has(profileId)) return this.profiles.get(profileId);
    const targets = this._paths(profileId);
    ensurePrivateDirectoryTree(targets.dir, this.paths.trustedRoot);
    const state = this._empty(profileId);
    const buffer = this._repairTail(targets.log);
    const lines = buffer.length === 0 ? [] : buffer.toString("utf8").slice(0, -1).split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      let record;
      try { record = JSON.parse(lines[index]); } catch { throw memoryError("MEMORY_LOG_CORRUPT", "Memory journal 中间损坏"); }
      if (record?.type !== "memory.batch"
        || !exactKeys(record, ["schemaVersion", "seq", "type", "items", "checksum"])
        || record.schemaVersion !== MEMORY_SCHEMA_VERSION || record.seq !== index + 1
        || !HASH_PATTERN.test(record.checksum) || recordChecksum(record) !== record.checksum) {
        throw memoryError("MEMORY_LOG_CORRUPT", "Memory journal record 无效");
      }
      const items = record.items;
      if (!Array.isArray(items) || items.length === 0 || items.length > 128) {
        throw memoryError("MEMORY_LOG_CORRUPT", "Memory journal batch 无效");
      }
      const seen = new Set();
      for (const raw of items) {
        const item = validateMemoryItem(raw, profileId);
        if (seen.has(item.id)) throw memoryError("MEMORY_LOG_CORRUPT", "Memory journal batch id 重复");
        seen.add(item.id);
        state.items.set(item.id, item);
      }
      state.revision = record.seq;
    }
    const snapshotStat = lstatIfExists(targets.snapshot);
    let current = state.revision === 0 && !snapshotStat;
    if (snapshotStat) {
      let snapshot;
      try { snapshot = JSON.parse(readPrivateFile(targets.snapshot, { fs: this.fs, maxBytes: 64 * 1024 * 1024 }).toString("utf8")); }
      catch (error) { if (error?.code) throw error; throw memoryError("MEMORY_SNAPSHOT_CORRUPT", "Memory snapshot JSON 无效"); }
      if (!exactKeys(snapshot, ["schemaVersion", "profileId", "revision", "items", "checksum"])
        || snapshot.schemaVersion !== MEMORY_SCHEMA_VERSION || snapshot.profileId !== profileId
        || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
        || !Array.isArray(snapshot.items) || !HASH_PATTERN.test(snapshot.checksum)
        || snapshotChecksum(snapshot) !== snapshot.checksum || snapshot.revision > state.revision) {
        throw memoryError("MEMORY_SNAPSHOT_CORRUPT", "Memory snapshot 无效");
      }
      current = snapshot.revision === state.revision
        && stableJson(snapshot) === stableJson(this._snapshot(state));
      if (snapshot.revision === state.revision && !current) {
        throw memoryError("MEMORY_SNAPSHOT_CORRUPT", "Memory snapshot 与 journal 不一致");
      }
    }
    if (!current) this._writeSnapshot(state);
    this.profiles.set(profileId, state);
    return state;
  }
  ensureProfile(profileId) { return this.getRevision(profileId); }
  getRevision(profileId) { return this._load(profileId).revision; }
  get(profileId, id) {
    const item = this._load(profileId).items.get(assertId(id, "memory.id"));
    return item ? structuredClone(item) : null;
  }
  list(profileId, filter = {}) {
    return [...this._load(profileId).items.values()]
      .filter((item) => !filter.status || item.status === filter.status)
      .filter((item) => !filter.scope || item.scope === filter.scope)
      .filter((item) => !filter.type || item.type === filter.type)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .map((item) => structuredClone(item));
  }
  upsert(item) {
    return this.upsertMany([item])[0];
  }
  upsertMany(items) {
    this._assertOpen(true);
    if (!Array.isArray(items) || items.length === 0 || items.length > 128) {
      throw memoryError("MEMORY_INVALID", "Memory batch 无效");
    }
    const canonical = items.map((item) => validateMemoryItem(item, item.profileId));
    const profileId = canonical[0].profileId;
    if (canonical.some((item) => item.profileId !== profileId)
      || new Set(canonical.map((item) => item.id)).size !== canonical.length) {
      throw memoryError("MEMORY_INVALID", "Memory batch profile/id 冲突");
    }
    const state = this._load(profileId);
    const changed = canonical.filter((item) => stableJson(state.items.get(item.id)) !== stableJson(item));
    if (changed.length === 0) return canonical.map((item) => structuredClone(item));
    const additions = changed.filter((item) => !state.items.has(item.id)).length;
    if (state.items.size + additions > MAX_ITEMS) throw memoryError("MEMORY_CAPACITY_EXCEEDED", "Memory 已达容量上限");
    const record = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      seq: state.revision + 1,
      type: "memory.batch",
      items: changed,
    };
    record.checksum = recordChecksum(record);
    const line = `${stableJson(record)}\n`;
    const targets = this._paths(profileId);
    const size = lstatIfExists(targets.log)?.size || 0;
    if (size + Buffer.byteLength(line, "utf8") > this.maxLogBytes) throw memoryError("MEMORY_LOG_TOO_LARGE", "Memory journal 超限");
    let fd;
    try {
      fd = this.fs.openSync(targets.log, this.fs.constants.O_CREAT | this.fs.constants.O_APPEND
        | this.fs.constants.O_WRONLY | (this.fs.constants.O_NOFOLLOW || 0), 0o600);
      validatePrivateStat(this.fs.fstatSync(fd), targets.log);
      this.fs.fchmodSync(fd, 0o600);
      writeFully(this.fs, fd, line, "MEMORY_WRITE_FAILED"); this.fs.fsyncSync(fd);
    } finally { if (fd !== undefined) this.fs.closeSync(fd); }
    for (const item of changed) state.items.set(item.id, item);
    state.revision = record.seq;
    try { this._writeSnapshot(state); } catch (cause) {
      const error = memoryError("MEMORY_COMMIT_UNCERTAIN", "Memory journal 已同步但 snapshot 提交不确定");
      error.cause = cause; error.committedUncertain = true; this.poisonError = error; throw error;
    }
    return canonical.map((item) => structuredClone(item));
  }
  exportProfile(profileId) {
    const state = this._load(profileId);
    return { format: "shoggoth-memory-v1", schemaVersion: 1, profileId, revision: state.revision,
      items: [...state.items.values()].map((item) => structuredClone(item)) };
  }
}

module.exports = {
  MAX_CONTENT_BYTES,
  MEMORY_SCHEMA_VERSION,
  MEMORY_SCOPES,
  MEMORY_SENSITIVITIES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  MemoryStore,
  validateMemoryItem,
};
