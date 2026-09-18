"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, statIfExists } = require("./private-file");
const { validRuntimeProfileId } = require("./runtime-adapter");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");
const { ANTIGRAVITY_RUNTIME } = require("./antigravity-runtime-paths");

const LEGACY_SCHEMA_VERSION = 1;
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
    "assistantMessages", "responseId", "createdAt", "updatedAt",
  ])
    && safeString(value.id, 512) && safeString(value.operationId, 512)
    && /^[a-f0-9]{64}$/u.test(value.fingerprint)
    && ACCEPTANCE_STATES.has(value.acceptance) && TURN_STATUSES.has(value.status)
    && (value.errorCode === null || safeString(value.errorCode, 128))
    && Array.isArray(value.assistantMessages) && value.assistantMessages.length <= 1024
    && value.assistantMessages.every(validateMessage)
    && (value.responseId === null || safeString(value.responseId, 512))
    && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0
    && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= value.createdAt;
}

function validateSession(value) {
  return exact(value, [
    "id", "remoteConversationId", "source", "cwd", "title", "archived",
    "lastUsage", "createdAt", "updatedAt", "turns",
  ])
    && safeString(value.id, 512)
    && (value.remoteConversationId === null || safeString(value.remoteConversationId, 512))
    && safeString(value.source, 256) && safeString(value.cwd, 4096, { absolute: true })
    && (value.title === null || safeString(value.title, 1024))
    && typeof value.archived === "boolean" && validateUsage(value.lastUsage)
    && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0
    && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= value.createdAt
    && Array.isArray(value.turns) && value.turns.length <= 8192
    && value.turns.every(validateTurn);
}

function validateLedger(value, runtimeProfileId, workspaceShardId) {
  if (!exact(value, ["schemaVersion", "runtime", "runtimeProfileId", "workspaceShardId", "sessions"])
    || value.schemaVersion !== SCHEMA_VERSION || value.runtime !== ANTIGRAVITY_RUNTIME
    || value.runtimeProfileId !== runtimeProfileId || value.workspaceShardId !== workspaceShardId
    || !Array.isArray(value.sessions) || value.sessions.length > 4096
    || !value.sessions.every(validateSession)) {
    throw ledgerError("ANTIGRAVITY_LEDGER_INVALID", "Antigravity runtime ledger is invalid");
  }
  const sessionIds = new Set();
  const sources = new Set();
  const remoteIds = new Set();
  const turnIds = new Set();
  for (const session of value.sessions) {
    if (sessionIds.has(session.id) || sources.has(session.source)
      || (session.remoteConversationId !== null && remoteIds.has(session.remoteConversationId))) {
      throw ledgerError("ANTIGRAVITY_LEDGER_INVALID", "Antigravity ledger contains duplicate sessions");
    }
    sessionIds.add(session.id);
    sources.add(session.source);
    if (session.remoteConversationId !== null) remoteIds.add(session.remoteConversationId);
    const operations = new Set();
    for (const turn of session.turns) {
      if (turnIds.has(turn.id) || operations.has(turn.operationId)) {
        throw ledgerError("ANTIGRAVITY_LEDGER_INVALID", "Antigravity ledger contains duplicate turns");
      }
      turnIds.add(turn.id);
      operations.add(turn.operationId);
    }
  }
  return value;
}

function migrateLegacyLedger(value, runtimeProfileId, workspaceShardId) {
  if (!plain(value) || value.schemaVersion !== LEGACY_SCHEMA_VERSION) return null;
  const migrated = structuredClone(value);
  migrated.schemaVersion = SCHEMA_VERSION;
  validateLedger(migrated, runtimeProfileId, workspaceShardId);
  for (const session of migrated.sessions) {
    session.remoteConversationId = null;
    session.lastUsage = emptyAntigravityUsage();
  }
  return migrated;
}

class AntigravityRuntimeLedger {
  constructor(options = {}) {
    this.fs = options.fs || fs;
    if (!validRuntimeProfileId(options.runtimeProfileId)) {
      throw ledgerError("ANTIGRAVITY_LEDGER_OPTIONS_INVALID", "Antigravity runtime profile id is invalid");
    }
    this.runtimeProfileId = options.runtimeProfileId;
    if (typeof options.stateRoot !== "string" || !path.isAbsolute(options.stateRoot)
      || typeof options.trustedRoot !== "string" || !path.isAbsolute(options.trustedRoot)
      || typeof options.workspaceShardId !== "string"
      || !/^[a-f0-9]{64}$/u.test(options.workspaceShardId)) {
      throw ledgerError("ANTIGRAVITY_LEDGER_OPTIONS_INVALID", "Antigravity ledger paths are invalid");
    }
    this.stateRoot = path.resolve(options.stateRoot);
    this.trustedRoot = path.resolve(options.trustedRoot);
    this.workspaceShardId = options.workspaceShardId;
    this.profileRoot = path.join(this.stateRoot, this.runtimeProfileId);
    this.runtimeRoot = path.join(this.profileRoot, this.workspaceShardId);
    const relative = path.relative(this.stateRoot, this.runtimeRoot);
    if (relative !== path.join(this.runtimeProfileId, this.workspaceShardId)
      || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw ledgerError("ANTIGRAVITY_LEDGER_OPTIONS_INVALID", "Antigravity ledger escapes its root");
    }
    const stateRelative = path.relative(this.trustedRoot, this.stateRoot);
    if (stateRelative === "" || stateRelative === ".." || stateRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(stateRelative)) {
      throw ledgerError("ANTIGRAVITY_LEDGER_OPTIONS_INVALID", "Antigravity state root is untrusted");
    }
    this.ledgerPath = path.join(this.runtimeRoot, "runtime-ledger.json");
    this.data = null;
    this.now = options.now || Date.now;
  }

  open() {
    if (this.data) return this;
    ensurePrivateDirectoryTree(this.stateRoot, this.trustedRoot);
    ensurePrivateDirectoryTree(this.profileRoot, this.trustedRoot);
    ensurePrivateDirectoryTree(this.runtimeRoot, this.trustedRoot);
    if (!statIfExists(this.fs, this.ledgerPath)) {
      this.data = {
        schemaVersion: SCHEMA_VERSION,
        runtime: ANTIGRAVITY_RUNTIME,
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
      throw ledgerError("ANTIGRAVITY_LEDGER_INVALID", "Antigravity ledger is malformed");
    }
    const migrated = migrateLegacyLedger(parsed, this.runtimeProfileId, this.workspaceShardId);
    this.data = validateLedger(
      migrated || parsed,
      this.runtimeProfileId,
      this.workspaceShardId,
    );
    let changed = migrated !== null;
    for (const session of this.data.sessions) {
      for (const turn of session.turns) {
        if (turn.acceptance === "accepted" && turn.status === "inProgress") {
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
    if (!this.data) {
      throw ledgerError("ANTIGRAVITY_LEDGER_CLOSED", "Antigravity ledger is closed");
    }
    return structuredClone(this.data);
  }

  update(mutator) {
    if (!this.data || typeof mutator !== "function") {
      throw ledgerError("ANTIGRAVITY_LEDGER_CLOSED", "Antigravity ledger is closed");
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
      throw ledgerError("ANTIGRAVITY_LEDGER_TOO_LARGE", "Antigravity ledger exceeds its limit");
    }
    atomicWritePrivateFile(this.ledgerPath, serialized, {
      fs: this.fs,
      trustedRoot: this.trustedRoot,
    });
  }
}

function emptyAntigravityUsage() {
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
  AntigravityRuntimeLedger,
  SCHEMA_VERSION,
  emptyAntigravityUsage,
  validateLedger,
};
