"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  atomicWritePrivateFile,
  preparePrivateParent,
  readPrivateFile,
  recoverInterruptedPrivateFile,
  statIfExists,
} = require("./private-file");
const { runtimeBinding } = require("./runtime-adapter");
const { serviceError } = require("./security");
const { canonicalWorkspace } = require("./work-run");

const OWNERSHIP_VERSION = 2;
const MAX_OWNERSHIP_BYTES = 8 * 1024 * 1024;
const MAX_OWNERSHIP_RECORDS = 20_000;
const OWNERSHIP_STATUSES = new Set(["active", "archived", "deleted"]);
const RECORD_FIELDS = Object.freeze([
  "runtimeAccountId",
  "runtime",
  "runtimeProfileId",
  "sessionId",
  "profileId",
  "workspace",
  "status",
  "createdAt",
  "lastSeenAt",
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function ownershipError(code, message) {
  return serviceError(code, message);
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function clone(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function validOpaqueId(value, maxBytes = 512) {
  return typeof value === "string" && value.length > 0 && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function normalizeWorkspace(value) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || !value.isWellFormed() || !path.isAbsolute(value) || path.resolve(value) !== value
    || Buffer.byteLength(value, "utf8") > 4096) {
    throw ownershipError("RUNTIME_SESSION_OWNERSHIP_INVALID", "Runtime session workspace is invalid");
  }
  return value;
}

function normalizeRecord(input, corrupt = false) {
  const fail = (message = "Runtime session ownership record is invalid") => {
    throw ownershipError(
      corrupt ? "RUNTIME_SESSION_OWNERSHIP_CORRUPT" : "RUNTIME_SESSION_OWNERSHIP_INVALID",
      message,
    );
  };
  if (!exactObject(input, RECORD_FIELDS)) fail();
  let binding;
  try {
    binding = runtimeBinding({
      runtime: input.runtime,
      runtimeProfileId: input.runtimeProfileId,
      runtimeAccountId: input.runtimeAccountId,
    });
  } catch {
    fail();
  }
  if (!validOpaqueId(input.sessionId) || !validOpaqueId(input.profileId, 128)
    || !OWNERSHIP_STATUSES.has(input.status)
    || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0
    || !Number.isSafeInteger(input.lastSeenAt) || input.lastSeenAt < input.createdAt) {
    fail();
  }
  let workspace;
  try { workspace = normalizeWorkspace(input.workspace); } catch { fail(); }
  return {
    runtimeAccountId: binding.runtimeAccountId,
    runtime: binding.runtime,
    runtimeProfileId: binding.runtimeProfileId,
    sessionId: input.sessionId,
    profileId: input.profileId,
    workspace,
    status: input.status,
    createdAt: input.createdAt,
    lastSeenAt: input.lastSeenAt,
  };
}

function ownershipKey(runtimeAccountId, sessionId) {
  return crypto.createHash("sha256")
    .update(JSON.stringify([runtimeAccountId, sessionId]), "utf8")
    .digest("hex");
}

function matchesWorkspaceIdentity(stored, requested) {
  if (stored === requested) return true;
  if (stored === null || requested === null) return false;
  // WorkRun pins the canonical execution path, while older ChatSessions can
  // retain an alias (for example /var -> /private/var on macOS). Resolve only
  // the request: re-resolving stored authority could accept a retargeted link.
  try { return canonicalWorkspace(requested) === stored; } catch { return false; }
}

function sameIdentity(left, right) {
  return [
    "runtimeAccountId", "runtime", "runtimeProfileId", "sessionId", "profileId",
  ].every((field) => left[field] === right[field])
    && matchesWorkspaceIdentity(left.workspace, right.workspace);
}

function validateContainer(value) {
  if (!exactObject(value, ["version", "revision", "records"])
    || value.version !== OWNERSHIP_VERSION
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !value.records || typeof value.records !== "object" || Array.isArray(value.records)
    || Object.getPrototypeOf(value.records) !== Object.prototype
    || Object.keys(value.records).length > MAX_OWNERSHIP_RECORDS
  ) {
    throw ownershipError(
      "RUNTIME_SESSION_OWNERSHIP_CORRUPT",
      "Runtime session ownership store is corrupt",
    );
  }
  const records = {};
  for (const [key, raw] of Object.entries(value.records)) {
    const record = normalizeRecord(raw, true);
    if (key !== ownershipKey(record.runtimeAccountId, record.sessionId)) {
      throw ownershipError(
        "RUNTIME_SESSION_OWNERSHIP_CORRUPT",
        "Runtime session ownership key is corrupt",
      );
    }
    records[key] = record;
  }
  return {
    version: OWNERSHIP_VERSION,
    revision: value.revision,
    records,
  };
}

class RuntimeSessionOwnershipStore {
  constructor(options = {}) {
    const target = options.paths?.runtimeSessionOwnershipPath;
    const expectedParent = options.paths?.runtimeSessionOwnershipDir;
    if (typeof target !== "string" || typeof expectedParent !== "string"
      || path.dirname(target) !== expectedParent || path.basename(target) !== "ownership-v1.json"
      || typeof options.paths?.trustedRoot !== "string") {
      throw ownershipError(
        "RUNTIME_SESSION_OWNERSHIP_PATHS_REQUIRED",
        "Runtime session ownership requires fixed Service paths",
      );
    }
    this.paths = options.paths;
    this.fs = options.fs || fs;
    this.atomicWrite = options.atomicWrite || atomicWritePrivateFile;
    this.now = options.now || Date.now;
    this.opened = false;
    this.commitUncertain = false;
    this.container = {
      version: OWNERSHIP_VERSION,
      revision: 0,
      records: {},

    };
  }

  open() {
    if (this.opened) return this;
    preparePrivateParent(
      this.paths.runtimeSessionOwnershipPath,
      this.paths.trustedRoot,
      this.fs,
    );
    const recovery = recoverInterruptedPrivateFile(this.paths.runtimeSessionOwnershipPath, {
      fs: this.fs,
      trustedRoot: this.paths.trustedRoot,
    });
    const stat = statIfExists(this.fs, this.paths.runtimeSessionOwnershipPath);
    this.container = stat
      ? this.#parse(readPrivateFile(this.paths.runtimeSessionOwnershipPath, {
        fs: this.fs,
        maxBytes: MAX_OWNERSHIP_BYTES,
      }))
      : {
        version: OWNERSHIP_VERSION,
        revision: 0,
        records: {},

      };
    this.commitUncertain = recovery === "uncertain";
    this.opened = true;
    return this;
  }

  close() {
    this.#assertOpen();
    this.opened = false;
  }

  purgeProfile(profileId) {
    this.#assertOpen();
    if (!validOpaqueId(profileId, 128)) throw ownershipError("RUNTIME_SESSION_OWNERSHIP_INVALID", "Profile 无效");
    const records = Object.fromEntries(Object.entries(this.container.records)
      .filter(([, record]) => record.profileId !== profileId));
    this.#persist({ ...this.container, revision: this.container.revision + 1, records });
  }

  claim(input) {
    this.#assertOpen();
    const timestamp = this.#timestamp(input.lastSeenAt ?? this.now());
    const candidate = normalizeRecord({
      ...input,
      status: input.status ?? "active",
      createdAt: input.createdAt ?? timestamp,
      lastSeenAt: timestamp,
    });
    const key = ownershipKey(candidate.runtimeAccountId, candidate.sessionId);
    const existing = this.container.records[key] || null;
    if (existing && !sameIdentity(existing, candidate)) {
      throw ownershipError(
        "RUNTIME_SESSION_OWNERSHIP_CONFLICT",
        "Runtime session is already owned by another Agent",
      );
    }
    if (existing?.status === "deleted") {
      throw ownershipError(
        "RUNTIME_SESSION_OWNERSHIP_DELETED",
        "Deleted Runtime session ownership cannot be reclaimed",
      );
    }
    if (!existing && Object.keys(this.container.records).length >= MAX_OWNERSHIP_RECORDS) {
      throw ownershipError(
        "RUNTIME_SESSION_OWNERSHIP_CAPACITY",
        "Runtime session ownership capacity is exceeded",
      );
    }
    const saved = existing
      ? { ...existing, status: candidate.status, lastSeenAt: Math.max(existing.lastSeenAt, timestamp) }
      : candidate;
    this.#commit(key, saved);
    return clone(saved);
  }

  assertOwned(input) {
    this.#assertOpen();
    return clone(this.#ownedRecord(input));
  }

  readRecord(input) {
    this.#assertOpen();
    const binding = runtimeBinding(input.binding);
    if (!validOpaqueId(input.profileId, 128) || !validOpaqueId(input.sessionId)) {
      throw ownershipError(
        "RUNTIME_SESSION_OWNERSHIP_INVALID",
        "Runtime session ownership query is invalid",
      );
    }
    const record = this.container.records[
      ownershipKey(binding.runtimeAccountId, input.sessionId)
    ] || null;
    if (!record) return null;
    const workspace = input.workspace === undefined ? undefined : normalizeWorkspace(input.workspace);
    if (record.runtime !== binding.runtime
      || record.runtimeProfileId !== binding.runtimeProfileId
      || record.profileId !== input.profileId
      || (workspace !== undefined && !matchesWorkspaceIdentity(record.workspace, workspace))) {
      throw ownershipError(
        "RUNTIME_SESSION_OWNERSHIP_CONFLICT",
        "Runtime session ownership belongs to another Agent",
      );
    }
    return clone(record);
  }

  #ownedRecord(input, includeDeleted = false) {
    const binding = runtimeBinding(input.binding);
    if (!validOpaqueId(input.profileId, 128) || !validOpaqueId(input.sessionId)) {
      throw ownershipError(
        "RUNTIME_SESSION_OWNERSHIP_INVALID",
        "Runtime session ownership query is invalid",
      );
    }
    const record = this.container.records[
      ownershipKey(binding.runtimeAccountId, input.sessionId)
    ] || null;
    const workspace = input.workspace === undefined ? undefined : normalizeWorkspace(input.workspace);
    if (!record || (!includeDeleted && record.status === "deleted")
      || record.runtime !== binding.runtime
      || record.runtimeProfileId !== binding.runtimeProfileId
      || record.profileId !== input.profileId
      || (workspace !== undefined && !matchesWorkspaceIdentity(record.workspace, workspace))) {
      throw ownershipError(
        "RUNTIME_SESSION_NOT_OWNED",
        "Runtime session is not owned by this Agent",
      );
    }
    return record;
  }

  listOwned(input) {
    this.#assertOpen();
    const binding = runtimeBinding(input.binding);
    if (!validOpaqueId(input.profileId, 128)) {
      throw ownershipError(
        "RUNTIME_SESSION_OWNERSHIP_INVALID",
        "Runtime session ownership query is invalid",
      );
    }
    return Object.values(this.container.records).filter((record) => (
      record.runtimeAccountId === binding.runtimeAccountId
      && record.runtime === binding.runtime
      && record.runtimeProfileId === binding.runtimeProfileId
      && record.profileId === input.profileId
      && record.status !== "deleted"
    )).sort((left, right) => left.createdAt - right.createdAt
      || left.sessionId.localeCompare(right.sessionId)).map(clone);
  }

  touch(input) {
    const record = this.assertOwned(input);
    const timestamp = this.#timestamp(input.lastSeenAt ?? this.now());
    const saved = { ...record, lastSeenAt: Math.max(record.lastSeenAt, timestamp) };
    this.#commit(ownershipKey(record.runtimeAccountId, record.sessionId), saved);
    return clone(saved);
  }

  mark(input) {
    if (!OWNERSHIP_STATUSES.has(input.status)) {
      throw ownershipError(
        "RUNTIME_SESSION_OWNERSHIP_INVALID",
        "Runtime session ownership status is invalid",
      );
    }
    const record = this.#ownedRecord(input, input.status === "deleted");
    if (record.status === "deleted") return clone(record);
    const timestamp = this.#timestamp(input.lastSeenAt ?? this.now());
    const saved = {
      ...record,
      status: input.status,
      lastSeenAt: Math.max(record.lastSeenAt, timestamp),
    };
    this.#commit(ownershipKey(record.runtimeAccountId, record.sessionId), saved);
    return clone(saved);
  }

  #timestamp(value) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw ownershipError(
        "RUNTIME_SESSION_OWNERSHIP_INVALID",
        "Runtime session ownership timestamp is invalid",
      );
    }
    return value;
  }

  #commit(key, record) {
    const candidate = {
      version: OWNERSHIP_VERSION,
      revision: this.container.revision + 1,
      records: { ...this.container.records, [key]: record },

    };
    this.#persist(candidate);
  }

  #persist(candidate) {
    const serialized = `${JSON.stringify(candidate)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_OWNERSHIP_BYTES) {
      throw ownershipError(
        "RUNTIME_SESSION_OWNERSHIP_CAPACITY",
        "Runtime session ownership capacity is exceeded",
      );
    }
    try {
      this.atomicWrite(this.paths.runtimeSessionOwnershipPath, serialized, {
        fs: this.fs,
        trustedRoot: this.paths.trustedRoot,
      });
    } catch (error) {
      if (error?.committed === true || error?.committedUncertain === true) {
        this.commitUncertain = true;
        throw ownershipError(
          "RUNTIME_SESSION_OWNERSHIP_COMMIT_UNCERTAIN",
          "Runtime session ownership commit is uncertain; Service restart is required",
        );
      }
      if (String(error?.code || "").startsWith("UNSAFE_")) throw error;
      throw ownershipError(
        "RUNTIME_SESSION_OWNERSHIP_WRITE_FAILED",
        "Runtime session ownership could not be persisted",
      );
    }
    this.container = candidate;
  }

  #parse(bytes) {
    try { return validateContainer(JSON.parse(bytes.toString("utf8"))); }
    catch (error) {
      if (error?.code === "RUNTIME_SESSION_OWNERSHIP_CORRUPT") throw error;
      throw ownershipError(
        "RUNTIME_SESSION_OWNERSHIP_CORRUPT",
        "Runtime session ownership store is corrupt",
      );
    }
  }

  #assertOpen() {
    if (this.commitUncertain) {
      throw ownershipError(
        "RUNTIME_SESSION_OWNERSHIP_COMMIT_UNCERTAIN",
        "Runtime session ownership commit is uncertain; Service restart is required",
      );
    }
    if (!this.opened) {
      throw ownershipError(
        "RUNTIME_SESSION_OWNERSHIP_CLOSED",
        "Runtime session ownership store is closed",
      );
    }
  }
}

module.exports = {
  MAX_OWNERSHIP_BYTES,
  OWNERSHIP_STATUSES,
  OWNERSHIP_VERSION,
  RuntimeSessionOwnershipStore,
  normalizeRecord,
  ownershipKey,
  validateContainer,
};
