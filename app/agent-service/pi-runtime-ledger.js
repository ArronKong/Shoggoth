"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, statIfExists } = require("./private-file");
const { validRuntimeProfileId } = require("./runtime-adapter");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");
const { PI_RUNTIME } = require("./pi-runtime-paths");

const SCHEMA_VERSION = 2;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const TURN_STATUSES = new Set(["inProgress", "completed", "failed", "interrupted", "canceled"]);
const ACCEPTANCE_STATES = new Set(["unknown", "accepted", "failed"]);
const USAGE_KEYS = Object.freeze([
  "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens",
  "reasoningOutputTokens", "totalTokens",
]);

function ledgerError(code, message) {
  return serviceError(code, message);
}

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, keys) {
  return plain(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function safeString(value, maxBytes, { empty = false, absolute = false } = {}) {
  return typeof value === "string" && (empty || value.length > 0) && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes
    && (!absolute || path.isAbsolute(value));
}

function validateUsage(value) {
  return exact(value, USAGE_KEYS)
    && USAGE_KEYS.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0);
}

function validateMessage(value) {
  return exact(value, ["id", "text"])
    && safeString(value.id, 512) && safeString(value.text, 8 * 1024 * 1024, { empty: true });
}

function validateTurn(value) {
  return exact(value, [
    "id", "operationId", "fingerprint", "acceptance", "status", "errorCode",
    "assistantMessages", "responseId", "provider", "model", "usage", "createdAt", "updatedAt",
    "executionEndedAt",
  ])
    && safeString(value.id, 512) && safeString(value.operationId, 512)
    && /^[a-f0-9]{64}$/u.test(value.fingerprint)
    && ACCEPTANCE_STATES.has(value.acceptance) && TURN_STATUSES.has(value.status)
    && (value.errorCode === null || safeString(value.errorCode, 128))
    && Array.isArray(value.assistantMessages) && value.assistantMessages.length <= 1024
    && value.assistantMessages.every(validateMessage)
    && (value.responseId === null || safeString(value.responseId, 512))
    && (value.provider === null || safeString(value.provider, 128))
    && (value.model === null || safeString(value.model, 512))
    && validateUsage(value.usage)
    && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0
    && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= value.createdAt
    && (value.executionEndedAt === null
      || (Number.isSafeInteger(value.executionEndedAt)
        && value.executionEndedAt >= value.createdAt && value.executionEndedAt <= value.updatedAt
        && value.status !== "inProgress"));
}

function validateSession(value) {
  return exact(value, [
    "id", "remoteSessionId", "sessionFile", "source", "cwd", "title", "archived",
    "createdAt", "updatedAt", "turns",
  ])
    && safeString(value.id, 512) && safeString(value.remoteSessionId, 128)
    && (value.sessionFile === null || safeString(value.sessionFile, 4096, { absolute: true }))
    && safeString(value.source, 256) && safeString(value.cwd, 4096, { absolute: true })
    && (value.title === null || safeString(value.title, 1024))
    && typeof value.archived === "boolean"
    && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0
    && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= value.createdAt
    && Array.isArray(value.turns) && value.turns.length <= 8192
    && value.turns.every(validateTurn);
}

function validateLedger(value, runtimeProfileId, workspaceShardId) {
  if (!exact(value, ["schemaVersion", "runtime", "runtimeProfileId", "workspaceShardId", "sessions"])
    || value.schemaVersion !== SCHEMA_VERSION || value.runtime !== PI_RUNTIME
    || value.runtimeProfileId !== runtimeProfileId || value.workspaceShardId !== workspaceShardId
    || !Array.isArray(value.sessions) || value.sessions.length > 4096
    || !value.sessions.every(validateSession)) {
    throw ledgerError("PI_LEDGER_INVALID", "Pi runtime ledger is invalid");
  }
  const sessionIds = new Set();
  const sources = new Set();
  const remoteIds = new Set();
  const turnIds = new Set();
  for (const session of value.sessions) {
    if (sessionIds.has(session.id) || sources.has(session.source)
      || remoteIds.has(session.remoteSessionId)) {
      throw ledgerError("PI_LEDGER_INVALID", "Pi ledger contains duplicate sessions");
    }
    sessionIds.add(session.id);
    sources.add(session.source);
    remoteIds.add(session.remoteSessionId);
    const operations = new Set();
    for (const turn of session.turns) {
      if (turnIds.has(turn.id) || operations.has(turn.operationId)) {
        throw ledgerError("PI_LEDGER_INVALID", "Pi ledger contains duplicate turns");
      }
      turnIds.add(turn.id);
      operations.add(turn.operationId);
    }
  }
  return value;
}

class PiRuntimeLedger {
  constructor(options = {}) {
    this.fs = options.fs || fs;
    if (!validRuntimeProfileId(options.runtimeProfileId)) {
      throw ledgerError("PI_LEDGER_OPTIONS_INVALID", "Pi runtime profile id is invalid");
    }
    this.runtimeProfileId = options.runtimeProfileId;
    if (typeof options.stateRoot !== "string" || !path.isAbsolute(options.stateRoot)
      || typeof options.trustedRoot !== "string" || !path.isAbsolute(options.trustedRoot)
      || typeof options.workspaceShardId !== "string"
      || !/^[a-f0-9]{64}$/u.test(options.workspaceShardId)) {
      throw ledgerError("PI_LEDGER_OPTIONS_INVALID", "Pi ledger paths are invalid");
    }
    this.stateRoot = path.resolve(options.stateRoot);
    this.trustedRoot = path.resolve(options.trustedRoot);
    this.workspaceShardId = options.workspaceShardId;
    this.profileRoot = path.join(this.stateRoot, this.runtimeProfileId);
    this.runtimeRoot = path.join(this.profileRoot, this.workspaceShardId);
    const relative = path.relative(this.stateRoot, this.runtimeRoot);
    if (relative !== path.join(this.runtimeProfileId, this.workspaceShardId)
      || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw ledgerError("PI_LEDGER_OPTIONS_INVALID", "Pi ledger escapes its root");
    }
    const stateRelative = path.relative(this.trustedRoot, this.stateRoot);
    if (stateRelative === "" || stateRelative === ".." || stateRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(stateRelative)) {
      throw ledgerError("PI_LEDGER_OPTIONS_INVALID", "Pi state root is untrusted");
    }
    this.ledgerPath = path.join(this.runtimeRoot, "runtime-ledger.json");
    this.sessionDir = path.join(this.runtimeRoot, "sessions");
    this.data = null;
    this.now = options.now || Date.now;
  }

  open() {
    if (this.data) return this;
    ensurePrivateDirectoryTree(this.stateRoot, this.trustedRoot);
    ensurePrivateDirectoryTree(this.profileRoot, this.trustedRoot);
    ensurePrivateDirectoryTree(this.runtimeRoot, this.trustedRoot);
    ensurePrivateDirectoryTree(this.sessionDir, this.trustedRoot);
    if (!statIfExists(this.fs, this.ledgerPath)) {
      this.data = {
        schemaVersion: SCHEMA_VERSION,
        runtime: PI_RUNTIME,
        runtimeProfileId: this.runtimeProfileId,
        workspaceShardId: this.workspaceShardId,
        sessions: [],
      };
      this._write(this.data);
      return this;
    }
    let parsed;
    try {
      parsed = JSON.parse(readPrivateFile(this.ledgerPath, {
        fs: this.fs,
        maxBytes: MAX_LEDGER_BYTES,
      }).toString("utf8"));
    } catch (error) {
      if (error?.code?.startsWith?.("PRIVATE_FILE_") || error?.code?.startsWith?.("UNSAFE_")) {
        throw error;
      }
      throw ledgerError("PI_LEDGER_INVALID", "Pi ledger is malformed");
    }
    const migrated = parsed?.schemaVersion === 1;
    if (migrated) {
      parsed.schemaVersion = SCHEMA_VERSION;
      for (const session of Array.isArray(parsed.sessions) ? parsed.sessions : []) {
        for (const turn of Array.isArray(session?.turns) ? session.turns : []) {
          if (!plain(turn)) continue;
          if (Object.prototype.hasOwnProperty.call(turn, "executionEndedAt")) {
            throw ledgerError("PI_LEDGER_INVALID", "Legacy Pi turn contains unsupported exit evidence");
          }
          // Old records contain no proof that a dispatched worker stopped.
          turn.executionEndedAt = null;
        }
      }
    }
    this.data = validateLedger(parsed, this.runtimeProfileId, this.workspaceShardId);
    let changed = migrated;
    for (const session of this.data.sessions) {
      for (const turn of session.turns) {
        if (turn.acceptance === "unknown" && session.sessionFile === null) {
          turn.acceptance = "failed";
          turn.status = "failed";
          turn.errorCode ||= "RUNTIME_HOST_RESTARTED";
          turn.updatedAt = Math.max(turn.updatedAt, this.now());
          session.updatedAt = Math.max(session.updatedAt, turn.updatedAt);
          changed = true;
        } else if (turn.acceptance === "accepted" && turn.status === "inProgress") {
          turn.status = "interrupted";
          turn.errorCode = "RUNTIME_HOST_RESTARTED";
          turn.updatedAt = Math.max(turn.updatedAt, this.now());
          session.updatedAt = Math.max(session.updatedAt, turn.updatedAt);
          changed = true;
        }
      }
    }
    if (changed) this._write(this.data);
    return this;
  }

  snapshot() {
    if (!this.data) throw ledgerError("PI_LEDGER_CLOSED", "Pi ledger is closed");
    return structuredClone(this.data);
  }

  update(mutator) {
    if (!this.data || typeof mutator !== "function") {
      throw ledgerError("PI_LEDGER_CLOSED", "Pi ledger is closed");
    }
    const next = structuredClone(this.data);
    const result = mutator(next);
    validateLedger(next, this.runtimeProfileId, this.workspaceShardId);
    this._write(next);
    this.data = next;
    return result;
  }

  _write(value) {
    const serialized = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_LEDGER_BYTES) {
      throw ledgerError("PI_LEDGER_TOO_LARGE", "Pi ledger exceeds its limit");
    }
    atomicWritePrivateFile(this.ledgerPath, serialized, {
      fs: this.fs,
      trustedRoot: this.trustedRoot,
    });
  }
}

function emptyPiUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    totalTokens: 0,
  };
}

module.exports = {
  PiRuntimeLedger,
  SCHEMA_VERSION,
  emptyPiUsage,
  validateLedger,
};
