"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { ensurePrivateDirectoryTree, lstatIfExists, serviceError } = require("./security");

// Native context fields currently accept 4 MiB. Snapshots contain both blocks
// and their joined projection; JSON escaping also consumes space.
const MAX_CONTEXT_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const SNAPSHOT_ID_PATTERN = /^ctx-[a-f0-9]{64}$/u;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function snapshotError(code, message) { return serviceError(code, message); }
function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}
function digest(value) { return crypto.createHash("sha256").update(stable(value)).digest("hex"); }
function profileId(value) {
  if (typeof value !== "string" || !PROFILE_ID_PATTERN.test(value)) {
    throw snapshotError("CONTEXT_SNAPSHOT_INVALID", "Context Snapshot profileId 无效");
  }
  return value;
}

class ContextSnapshotStore {
  constructor(options = {}) {
    if (!options.paths?.agentsDir || !options.paths?.trustedRoot) {
      throw new TypeError("ContextSnapshotStore 需要 Service paths");
    }
    this.paths = options.paths;
    this.fs = options.fs || fs;
    this.opened = false;
  }
  open() { ensurePrivateDirectoryTree(this.paths.agentsDir, this.paths.trustedRoot); this.opened = true; }
  close() { this.opened = false; }
  _assertOpen() { if (!this.opened) throw snapshotError("CONTEXT_SNAPSHOT_CLOSED", "Context Snapshot Store 未打开"); }
  _directory(profile) {
    return path.join(this.paths.agentsDir, profileId(profile), "context-snapshots");
  }
  create(material) {
    this._assertOpen();
    const canonical = structuredClone(material);
    if (!canonical || canonical.schemaVersion !== 1 || typeof canonical.runId !== "string"
      || canonical.runId.length === 0 || profileId(canonical.profileId) !== canonical.profileId
      || !Number.isSafeInteger(canonical.createdAt) || canonical.createdAt < 0
      || !canonical.revisions || !Array.isArray(canonical.blocks)
      || typeof canonical.developerInstructions !== "string"
      || typeof canonical.dynamicContext !== "string") {
      throw snapshotError("CONTEXT_SNAPSHOT_INVALID", "Context Snapshot 内容无效");
    }
    const contentHash = digest(canonical);
    const snapshot = { id: `ctx-${contentHash}`, contentHash, ...canonical };
    const serialized = `${stable(snapshot)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_CONTEXT_SNAPSHOT_BYTES) {
      throw snapshotError("CONTEXT_SNAPSHOT_TOO_LARGE", "Context Snapshot 超过容量");
    }
    const directory = this._directory(snapshot.profileId);
    ensurePrivateDirectoryTree(directory, this.paths.trustedRoot);
    const target = path.join(directory, `${snapshot.id}.json`);
    if (lstatIfExists(target)) {
      const existing = this.get(snapshot.profileId, snapshot.id);
      if (stable(existing) !== stable(snapshot)) {
        throw snapshotError("CONTEXT_SNAPSHOT_CONFLICT", "Context Snapshot hash 冲突");
      }
      return existing;
    }
    atomicWritePrivateFile(target, serialized, { fs: this.fs, trustedRoot: this.paths.trustedRoot });
    return structuredClone(snapshot);
  }
  get(profile, id) {
    this._assertOpen();
    if (!SNAPSHOT_ID_PATTERN.test(id)) throw snapshotError("CONTEXT_SNAPSHOT_INVALID", "Context Snapshot id 无效");
    const target = path.join(this._directory(profile), `${id}.json`);
    if (!lstatIfExists(target)) return null;
    let snapshot;
    try { snapshot = JSON.parse(readPrivateFile(target, { fs: this.fs, maxBytes: MAX_CONTEXT_SNAPSHOT_BYTES }).toString("utf8")); }
    catch { throw snapshotError("CONTEXT_SNAPSHOT_CORRUPT", "Context Snapshot 无法读取"); }
    const { id: storedId, contentHash, ...material } = snapshot || {};
    if (storedId !== id || contentHash !== id.slice(4) || digest(material) !== contentHash
      || material.profileId !== profile) {
      throw snapshotError("CONTEXT_SNAPSHOT_CORRUPT", "Context Snapshot hash 无效");
    }
    return structuredClone(snapshot);
  }
}

module.exports = { ContextSnapshotStore, MAX_CONTEXT_SNAPSHOT_BYTES, SNAPSHOT_ID_PATTERN };
