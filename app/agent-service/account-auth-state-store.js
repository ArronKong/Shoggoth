"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  atomicWritePrivateFile,
  preparePrivateParent,
  readPrivateFile,
  recoverInterruptedPrivateFile,
  statIfExists,
} = require("./private-file");
const { assertRuntimeProfileId } = require("./codex-runtime-paths");
const { serviceError } = require("./security");

const AUTH_STATE_VERSION = 2;
const LEGACY_AUTH_STATE_VERSION = 1;
const MAX_AUTH_STATE_BYTES = 1024 * 1024;
const MAX_AUTH_SESSIONS = 128;
const ACTIVE_AUTH_STATUSES = new Set(["starting", "waiting", "canceling"]);
const AUTH_STATUSES = new Set([
  ...ACTIVE_AUTH_STATUSES,
  "succeeded", "failed", "canceled", "timed_out", "interrupted", "unknown",
]);
const AUTH_MODES = new Set(["browser", "deviceCode"]);
const SESSION_FIELDS = Object.freeze([
  "requestId", "runtimeAccountId", "mode", "status",
  "createdAt", "updatedAt", "errorCode",
]);
const LEGACY_SESSION_FIELDS = Object.freeze([
  "requestId", "runtimeProfileId", "mode", "status",
  "createdAt", "updatedAt", "errorCode",
]);
const RUNTIME_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function authStateError(code, message) {
  return serviceError(code, message);
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function clone(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function validRuntimeAccountId(value) {
  return typeof value === "string" && RUNTIME_ACCOUNT_ID_PATTERN.test(value);
}

function validateSessionFields(input, fields, corrupt) {
  const fail = () => {
    throw authStateError(corrupt ? "AUTH_STATE_CORRUPT" : "AUTH_STATE_INVALID", "Account auth state is invalid");
  };
  if (!exactObject(input, fields)) fail();
  if (typeof input.requestId !== "string" || input.requestId.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(input.requestId)
    || !AUTH_MODES.has(input.mode) || !AUTH_STATUSES.has(input.status)
    || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0
    || !Number.isSafeInteger(input.updatedAt) || input.updatedAt < input.createdAt
    || (input.errorCode !== null
      && (typeof input.errorCode !== "string" || input.errorCode.length > 64
        || !/^[A-Z][A-Z0-9_]*$/u.test(input.errorCode)))) fail();
  return fail;
}

function normalizeSession(input, corrupt = false) {
  const fail = validateSessionFields(input, SESSION_FIELDS, corrupt);
  if (!validRuntimeAccountId(input.runtimeAccountId)) fail();
  return Object.fromEntries(SESSION_FIELDS.map((field) => [field, input[field]]));
}

function normalizeLegacySession(input) {
  const fail = validateSessionFields(input, LEGACY_SESSION_FIELDS, true);
  try { assertRuntimeProfileId(input.runtimeProfileId); } catch { fail(); }
  return Object.fromEntries(LEGACY_SESSION_FIELDS.map((field) => [field, input[field]]));
}

function validateContainer(value) {
  if (!exactObject(value, ["version", "revision", "sessions"])
    || value.version !== AUTH_STATE_VERSION
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !value.sessions || typeof value.sessions !== "object" || Array.isArray(value.sessions)
    || Object.getPrototypeOf(value.sessions) !== Object.prototype
    || Object.keys(value.sessions).length > MAX_AUTH_SESSIONS) {
    throw authStateError("AUTH_STATE_CORRUPT", "Account auth state is corrupt");
  }
  const sessions = {};
  for (const [runtimeAccountId, raw] of Object.entries(value.sessions)) {
    const session = normalizeSession(raw, true);
    if (session.runtimeAccountId !== runtimeAccountId) {
      throw authStateError("AUTH_STATE_CORRUPT", "Account auth state is corrupt");
    }
    sessions[runtimeAccountId] = session;
  }
  return { version: AUTH_STATE_VERSION, revision: value.revision, sessions };
}

function validateLegacyContainer(value) {
  if (!exactObject(value, ["version", "revision", "sessions"])
    || value.version !== LEGACY_AUTH_STATE_VERSION
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !value.sessions || typeof value.sessions !== "object" || Array.isArray(value.sessions)
    || Object.getPrototypeOf(value.sessions) !== Object.prototype
    || Object.keys(value.sessions).length > MAX_AUTH_SESSIONS) {
    throw authStateError("AUTH_STATE_CORRUPT", "Account auth state is corrupt");
  }
  const sessions = {};
  for (const [runtimeProfileId, raw] of Object.entries(value.sessions)) {
    const session = normalizeLegacySession(raw);
    if (session.runtimeProfileId !== runtimeProfileId) {
      throw authStateError("AUTH_STATE_CORRUPT", "Account auth state is corrupt");
    }
    sessions[runtimeProfileId] = session;
  }
  return { version: LEGACY_AUTH_STATE_VERSION, revision: value.revision, sessions };
}

function newerLegacySession(left, right) {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt > right.updatedAt;
  if (left.createdAt !== right.createdAt) return left.createdAt > right.createdAt;
  if (left.requestId !== right.requestId) return left.requestId > right.requestId;
  return left.runtimeProfileId > right.runtimeProfileId;
}

class AccountAuthStateStore {
  constructor(options = {}) {
    if (!options.paths?.stateDir || !options.paths?.trustedRoot || !options.paths?.accountAuthStatePath
      || !options.paths?.accountAuthStateV2Path
      || path.dirname(options.paths.accountAuthStatePath) !== options.paths.stateDir
      || path.basename(options.paths.accountAuthStatePath) !== "account-auth-state.json"
      || path.dirname(options.paths.accountAuthStateV2Path) !== options.paths.stateDir
      || path.basename(options.paths.accountAuthStateV2Path) !== "account-auth-state-v2.json") {
      throw authStateError("AUTH_STATE_PATHS_REQUIRED", "Account auth state requires fixed Service paths");
    }
    this.paths = options.paths;
    this.fs = options.fs || fs;
    this.atomicWrite = options.atomicWrite || atomicWritePrivateFile;
    this.now = options.now || Date.now;
    this.resolveRuntimeAccountId = options.resolveRuntimeAccountId || null;
    if (this.resolveRuntimeAccountId !== null
      && typeof this.resolveRuntimeAccountId !== "function") {
      throw authStateError("AUTH_STATE_OPTIONS_INVALID", "Account auth state options are invalid");
    }
    this.opened = false;
    this.commitUncertain = false;
    this.container = { version: AUTH_STATE_VERSION, revision: 0, sessions: {} };
  }

  open() {
    if (this.opened) return this;
    preparePrivateParent(this.paths.accountAuthStateV2Path, this.paths.trustedRoot, this.fs);
    const recovery = recoverInterruptedPrivateFile(this.paths.accountAuthStateV2Path, {
      fs: this.fs,
      trustedRoot: this.paths.trustedRoot,
    });
    const stat = statIfExists(this.fs, this.paths.accountAuthStateV2Path);
    if (stat) {
      this.container = this.#parse(readPrivateFile(this.paths.accountAuthStateV2Path, {
        fs: this.fs,
        maxBytes: MAX_AUTH_STATE_BYTES,
      }));
    } else {
      this.container = this.#migrateLegacy();
    }
    this.commitUncertain = recovery === "uncertain";
    this.opened = true;
    if (!this.commitUncertain) this.#interruptActive("SERVICE_RESTARTED");
    return this;
  }

  async close() {
    this.#assertOpen();
    this.#interruptActive("SERVICE_STOPPED");
    this.opened = false;
  }

  get(runtimeAccountId) {
    this.#assertOpen();
    if (!validRuntimeAccountId(runtimeAccountId)) {
      throw authStateError("AUTH_STATE_INVALID", "Account auth state query is invalid");
    }
    return clone(this.container.sessions[runtimeAccountId] || null);
  }

  list() {
    this.#assertOpen();
    return Object.values(this.container.sessions).map(clone);
  }

  put(input) {
    this.#assertOpen();
    const session = normalizeSession(input);
    if (!Object.prototype.hasOwnProperty.call(this.container.sessions, session.runtimeAccountId)
      && Object.keys(this.container.sessions).length >= MAX_AUTH_SESSIONS) {
      throw authStateError("AUTH_STATE_CAPACITY", "Account auth state capacity exceeded");
    }
    const candidate = {
      version: AUTH_STATE_VERSION,
      revision: this.container.revision + 1,
      sessions: { ...this.container.sessions, [session.runtimeAccountId]: session },
    };
    this.#write(candidate);
    this.container = candidate;
    return clone(session);
  }

  #interruptActive(errorCode) {
    const now = this.now();
    let changed = false;
    const sessions = {};
    for (const [runtimeAccountId, session] of Object.entries(this.container.sessions)) {
      if (ACTIVE_AUTH_STATUSES.has(session.status)) {
        changed = true;
        sessions[runtimeAccountId] = {
          ...session,
          status: "interrupted",
          updatedAt: Math.max(now, session.updatedAt),
          errorCode,
        };
      } else sessions[runtimeAccountId] = session;
    }
    if (!changed) return false;
    const candidate = {
      version: AUTH_STATE_VERSION,
      revision: this.container.revision + 1,
      sessions,
    };
    this.#write(candidate);
    this.container = candidate;
    return true;
  }

  #parse(bytes) {
    try {
      return validateContainer(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      if (error?.code === "AUTH_STATE_CORRUPT") throw error;
      throw authStateError("AUTH_STATE_CORRUPT", "Account auth state is corrupt");
    }
  }

  #migrateLegacy() {
    const legacyStat = statIfExists(this.fs, this.paths.accountAuthStatePath);
    if (!legacyStat) return { version: AUTH_STATE_VERSION, revision: 0, sessions: {} };
    let legacy;
    try {
      legacy = validateLegacyContainer(JSON.parse(readPrivateFile(this.paths.accountAuthStatePath, {
        fs: this.fs,
        maxBytes: MAX_AUTH_STATE_BYTES,
      }).toString("utf8")));
    } catch (error) {
      if (error?.code === "AUTH_STATE_CORRUPT" || String(error?.code || "").startsWith("UNSAFE_")) {
        throw error;
      }
      throw authStateError("AUTH_STATE_CORRUPT", "Account auth state is corrupt");
    }
    if (!this.resolveRuntimeAccountId) {
      throw authStateError(
        "AUTH_STATE_MIGRATION_RESOLVER_REQUIRED",
        "Account auth state migration requires a RuntimeAccount resolver",
      );
    }
    const selected = new Map();
    for (const session of Object.values(legacy.sessions)) {
      let runtimeAccountId;
      try {
        runtimeAccountId = this.resolveRuntimeAccountId(session.runtimeProfileId);
      } catch {
        throw authStateError(
          "AUTH_STATE_MIGRATION_FAILED",
          "Account auth state migration could not resolve a RuntimeAccount",
        );
      }
      if (!validRuntimeAccountId(runtimeAccountId)) {
        throw authStateError(
          "AUTH_STATE_MIGRATION_FAILED",
          "Account auth state migration could not resolve a RuntimeAccount",
        );
      }
      const current = selected.get(runtimeAccountId);
      if (!current || newerLegacySession(session, current)) selected.set(runtimeAccountId, session);
    }
    const timestamp = this.now();
    const sessions = {};
    for (const runtimeAccountId of [...selected.keys()].sort()) {
      const legacySession = selected.get(runtimeAccountId);
      const active = ACTIVE_AUTH_STATUSES.has(legacySession.status);
      sessions[runtimeAccountId] = {
        requestId: legacySession.requestId,
        runtimeAccountId,
        mode: legacySession.mode,
        status: active ? "interrupted" : legacySession.status,
        createdAt: legacySession.createdAt,
        updatedAt: active ? Math.max(timestamp, legacySession.updatedAt) : legacySession.updatedAt,
        errorCode: active ? "SERVICE_RESTARTED" : legacySession.errorCode,
      };
    }
    const migrated = {
      version: AUTH_STATE_VERSION,
      revision: legacy.revision + 1,
      sessions,
    };
    this.#write(migrated);
    return migrated;
  }

  #write(candidate) {
    const serialized = `${JSON.stringify(candidate)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_AUTH_STATE_BYTES) {
      throw authStateError("AUTH_STATE_CAPACITY", "Account auth state capacity exceeded");
    }
    try {
      this.atomicWrite(this.paths.accountAuthStateV2Path, serialized, {
        fs: this.fs,
        trustedRoot: this.paths.trustedRoot,
      });
    } catch (error) {
      if (error?.committedUncertain === true || error?.committed === true) {
        this.commitUncertain = true;
        const uncertain = authStateError(
          "AUTH_STATE_COMMIT_UNCERTAIN",
          "Account auth state commit is uncertain; reopen is required",
        );
        uncertain.committedUncertain = true;
        throw uncertain;
      }
      if (String(error?.code || "").startsWith("UNSAFE_")) throw error;
      throw authStateError("AUTH_STATE_WRITE_FAILED", "Account auth state write failed");
    }
  }

  #assertOpen() {
    if (this.commitUncertain) {
      throw authStateError("AUTH_STATE_COMMIT_UNCERTAIN", "Account auth state commit is uncertain; reopen is required");
    }
    if (!this.opened) throw authStateError("AUTH_STATE_CLOSED", "Account auth state is closed");
  }
}

module.exports = {
  ACTIVE_AUTH_STATUSES,
  AUTH_MODES,
  AUTH_STATE_VERSION,
  AUTH_STATUSES,
  AccountAuthStateStore,
  LEGACY_AUTH_STATE_VERSION,
  MAX_AUTH_STATE_BYTES,
  normalizeSession,
  validateContainer,
};
