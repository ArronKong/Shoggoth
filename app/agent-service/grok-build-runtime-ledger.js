"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, statIfExists } = require("./private-file");
const { validRuntimeProfileId } = require("./runtime-adapter");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");
const { GROK_BUILD_RUNTIME } = require("./grok-build-runtime-paths");

const SCHEMA_VERSION = 2;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const TURN_STATUSES = new Set(["inProgress", "completed", "failed", "interrupted", "canceled"]);
const ACCEPTANCE_STATES = new Set(["unknown", "accepted", "failed"]);

function ledgerError(code, message) {
  return serviceError(code, message);
}

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function safeString(value, maxBytes, { empty = false, absolute = false } = {}) {
  return typeof value === "string" && (empty || value.length > 0) && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes
    && (!absolute || path.isAbsolute(value));
}

function exact(value, keys) {
  return plain(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function validateMessage(value) {
  return exact(value, ["id", "text"])
    && safeString(value.id, 512)
    && safeString(value.text, 1024 * 1024, { empty: true });
}

function validateTurn(value) {
  return exact(value, [
    "id", "operationId", "fingerprint", "acceptance", "status", "errorCode",
    "assistantMessages", "createdAt", "updatedAt",
  ])
    && safeString(value.id, 512)
    && safeString(value.operationId, 512)
    && /^[a-f0-9]{64}$/u.test(value.fingerprint)
    && ACCEPTANCE_STATES.has(value.acceptance)
    && TURN_STATUSES.has(value.status)
    && (value.errorCode === null || safeString(value.errorCode, 128))
    && Array.isArray(value.assistantMessages) && value.assistantMessages.length <= 1024
    && value.assistantMessages.every(validateMessage)
    && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0
    && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= value.createdAt;
}

function validateSession(value) {
  return exact(value, [
    "id", "source", "cwd", "title", "archived", "createdAt", "updatedAt", "turns",
  ])
    && safeString(value.id, 512)
    && safeString(value.source, 256)
    && safeString(value.cwd, 4096, { absolute: true })
    && (value.title === null || safeString(value.title, 1024))
    && typeof value.archived === "boolean"
    && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0
    && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= value.createdAt
    && Array.isArray(value.turns) && value.turns.length <= 8192
    && value.turns.every(validateTurn);
}

function validatePendingSession(value) {
  return exact(value, ["source", "cwd", "createdAt"])
    && safeString(value.source, 256)
    && safeString(value.cwd, 4096, { absolute: true })
    && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0;
}

function validateLedger(value, runtimeProfileId, workspaceShardId) {
  if (!exact(value, [
    "schemaVersion", "runtime", "runtimeProfileId", "workspaceShardId", "pendingSessions", "sessions",
  ])
    || value.schemaVersion !== SCHEMA_VERSION || value.runtime !== GROK_BUILD_RUNTIME
    || value.runtimeProfileId !== runtimeProfileId
    || value.workspaceShardId !== workspaceShardId
    || !Array.isArray(value.pendingSessions) || value.pendingSessions.length > 64
    || !value.pendingSessions.every(validatePendingSession)
    || !Array.isArray(value.sessions) || value.sessions.length > 4096
    || !value.sessions.every(validateSession)) {
    throw ledgerError("GROK_BUILD_LEDGER_INVALID", "Grok Build runtime ledger is invalid");
  }
  const sessionIds = new Set();
  const sources = new Set(value.pendingSessions.map((item) => item.source));
  const turnIds = new Set();
  for (const session of value.sessions) {
    if (sessionIds.has(session.id) || sources.has(session.source)) {
      throw ledgerError("GROK_BUILD_LEDGER_INVALID", "Grok Build runtime ledger contains duplicate bindings");
    }
    sessionIds.add(session.id);
    sources.add(session.source);
    const operations = new Set();
    for (const turn of session.turns) {
      if (operations.has(turn.operationId) || turnIds.has(turn.id)) {
        throw ledgerError("GROK_BUILD_LEDGER_INVALID", "Grok Build runtime ledger contains duplicate receipts");
      }
      operations.add(turn.operationId);
      turnIds.add(turn.id);
    }
  }
  return value;
}

class GrokBuildRuntimeLedger {
  constructor(options = {}) {
    this.fs = options.fs || fs;
    if (!validRuntimeProfileId(options.runtimeProfileId)) {
      throw ledgerError("GROK_BUILD_LEDGER_OPTIONS_INVALID", "Grok Build runtime profile id is invalid");
    }
    this.runtimeProfileId = options.runtimeProfileId;
    if (typeof options.stateRoot !== "string" || !path.isAbsolute(options.stateRoot)
      || typeof options.trustedRoot !== "string" || !path.isAbsolute(options.trustedRoot)
      || typeof options.workspaceShardId !== "string"
      || !/^[a-f0-9]{64}$/u.test(options.workspaceShardId)) {
      throw ledgerError("GROK_BUILD_LEDGER_OPTIONS_INVALID", "Grok Build ledger paths are invalid");
    }
    this.stateRoot = path.resolve(options.stateRoot);
    this.trustedRoot = path.resolve(options.trustedRoot);
    this.workspaceShardId = options.workspaceShardId;
    this.profileRoot = path.join(this.stateRoot, this.runtimeProfileId);
    this.runtimeRoot = path.join(this.profileRoot, this.workspaceShardId);
    const relative = path.relative(this.stateRoot, this.runtimeRoot);
    if (relative !== path.join(this.runtimeProfileId, this.workspaceShardId)
      || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw ledgerError("GROK_BUILD_LEDGER_OPTIONS_INVALID", "Grok Build runtime path escapes its root");
    }
    const stateRelative = path.relative(this.trustedRoot, this.stateRoot);
    if (stateRelative === "" || stateRelative === ".." || stateRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(stateRelative)) {
      throw ledgerError("GROK_BUILD_LEDGER_OPTIONS_INVALID", "Grok Build stateRoot escapes trustedRoot");
    }
    this.ledgerPath = path.join(this.runtimeRoot, "runtime-ledger.json");
    this.data = null;
  }

  open() {
    if (this.data) return this;
    ensurePrivateDirectoryTree(this.stateRoot, this.trustedRoot);
    ensurePrivateDirectoryTree(this.profileRoot, this.trustedRoot);
    ensurePrivateDirectoryTree(this.runtimeRoot, this.trustedRoot);
    const existing = statIfExists(this.fs, this.ledgerPath);
    if (!existing) {
      this.data = {
        schemaVersion: SCHEMA_VERSION,
        runtime: GROK_BUILD_RUNTIME,
        runtimeProfileId: this.runtimeProfileId,
        workspaceShardId: this.workspaceShardId,
        pendingSessions: [],
        sessions: [],
      };
      this._write(this.data);
      return this;
    }
    let parsed;
    try {
      const bytes = readPrivateFile(this.ledgerPath, { fs: this.fs, maxBytes: MAX_LEDGER_BYTES });
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (error?.code?.startsWith?.("PRIVATE_FILE_") || error?.code?.startsWith?.("UNSAFE_")) throw error;
      throw ledgerError("GROK_BUILD_LEDGER_INVALID", "Grok Build runtime ledger is malformed");
    }
    this.data = validateLedger(parsed, this.runtimeProfileId, this.workspaceShardId);
    let changed = false;
    for (const session of this.data.sessions) {
      for (const turn of session.turns) {
        if (turn.acceptance === "accepted" && turn.status === "inProgress") {
          turn.status = "interrupted";
          turn.errorCode = "RUNTIME_HOST_RESTARTED";
          turn.updatedAt = Math.max(turn.updatedAt, Date.now());
          session.updatedAt = Math.max(session.updatedAt, turn.updatedAt);
          changed = true;
        }
      }
    }
    if (changed) this._write(this.data);
    return this;
  }

  snapshot() {
    if (!this.data) throw ledgerError("GROK_BUILD_LEDGER_CLOSED", "Grok Build runtime ledger is closed");
    return structuredClone(this.data);
  }

  update(mutator) {
    if (!this.data || typeof mutator !== "function") {
      throw ledgerError("GROK_BUILD_LEDGER_CLOSED", "Grok Build runtime ledger is closed");
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
      throw ledgerError("GROK_BUILD_LEDGER_TOO_LARGE", "Grok Build runtime ledger exceeds its limit");
    }
    atomicWritePrivateFile(this.ledgerPath, serialized, {
      fs: this.fs,
      trustedRoot: this.trustedRoot,
    });
  }
}

module.exports = {
  GrokBuildRuntimeLedger,
  SCHEMA_VERSION,
  validateLedger,
};
