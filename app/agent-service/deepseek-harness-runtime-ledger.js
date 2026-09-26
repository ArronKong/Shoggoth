"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, statIfExists } = require("./private-file");
const { validRuntimeProfileId } = require("./runtime-adapter");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");
const { DEEPSEEK_HARNESS_RUNTIME } = require("./deepseek-harness-runtime-paths");

const SCHEMA_VERSION = 1;
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

function safeString(value, maxBytes, { empty = false, absolute = false } = {}) {
  return typeof value === "string" && (empty || value.length > 0) && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes
    && (!absolute || path.isAbsolute(value));
}

function validateUsage(value) {
  return plain(value) && Object.keys(value).length === USAGE_KEYS.length
    && USAGE_KEYS.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0);
}

function validateTurn(value) {
  return plain(value) && safeString(value.id, 512) && safeString(value.operationId, 512)
    && /^[a-f0-9]{64}$/u.test(value.fingerprint)
    && ACCEPTANCE_STATES.has(value.acceptance) && TURN_STATUSES.has(value.status)
    && (value.errorCode === null || safeString(value.errorCode, 128))
    && Array.isArray(value.assistantMessages) && value.assistantMessages.length <= 1024
    && value.assistantMessages.every((message) => plain(message)
      && safeString(message.id, 512) && safeString(message.text, 8 * 1024 * 1024, { empty: true }))
    && Array.isArray(value.usageResponseIds) && value.usageResponseIds.length <= 1024
    && value.usageResponseIds.every((id) => safeString(id, 512))
    && (value.responseId === null || safeString(value.responseId, 512))
    && (value.provider === null || safeString(value.provider, 128))
    && (value.model === null || safeString(value.model, 512))
    && validateUsage(value.usage)
    && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0
    && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= value.createdAt;
}

function validateSession(value) {
  return plain(value) && safeString(value.id, 512) && safeString(value.remoteSessionId, 256)
    && safeString(value.source, 256) && safeString(value.cwd, 4096, { absolute: true })
    && (value.title === null || safeString(value.title, 1024))
    && typeof value.archived === "boolean"
    && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0
    && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= value.createdAt
    && Array.isArray(value.turns) && value.turns.length <= 8192
    && value.turns.every(validateTurn);
}

function validateLedger(value, runtimeProfileId, workspaceShardId) {
  if (!plain(value) || value.schemaVersion !== SCHEMA_VERSION
    || value.runtime !== DEEPSEEK_HARNESS_RUNTIME
    || value.runtimeProfileId !== runtimeProfileId || value.workspaceShardId !== workspaceShardId
    || !Array.isArray(value.sessions) || value.sessions.length > 4096
    || !value.sessions.every(validateSession)) {
    throw ledgerError(
      "DEEPSEEK_HARNESS_LEDGER_INVALID",
      "DeepSeek runtime ledger is invalid",
    );
  }
  const ids = new Set();
  const remoteIds = new Set();
  const sources = new Set();
  const turns = new Set();
  for (const session of value.sessions) {
    if (ids.has(session.id) || remoteIds.has(session.remoteSessionId) || sources.has(session.source)) {
      throw ledgerError(
        "DEEPSEEK_HARNESS_LEDGER_INVALID",
        "DeepSeek ledger contains duplicate sessions",
      );
    }
    ids.add(session.id);
    remoteIds.add(session.remoteSessionId);
    sources.add(session.source);
    const operations = new Set();
    for (const turn of session.turns) {
      if (turns.has(turn.id) || operations.has(turn.operationId)) {
        throw ledgerError(
          "DEEPSEEK_HARNESS_LEDGER_INVALID",
          "DeepSeek ledger contains duplicate turns",
        );
      }
      turns.add(turn.id);
      operations.add(turn.operationId);
    }
  }
  return value;
}

class DeepSeekHarnessRuntimeLedger {
  constructor(options = {}) {
    this.fs = options.fs || fs;
    if (!validRuntimeProfileId(options.runtimeProfileId)) {
      throw ledgerError(
        "DEEPSEEK_HARNESS_LEDGER_OPTIONS_INVALID",
        "DeepSeek runtime profile id is invalid",
      );
    }
    this.runtimeProfileId = options.runtimeProfileId;
    if (typeof options.stateRoot !== "string" || !path.isAbsolute(options.stateRoot)
      || typeof options.trustedRoot !== "string" || !path.isAbsolute(options.trustedRoot)
      || typeof options.workspaceShardId !== "string" || !/^[a-f0-9]{64}$/u.test(options.workspaceShardId)) {
      throw ledgerError(
        "DEEPSEEK_HARNESS_LEDGER_OPTIONS_INVALID",
        "DeepSeek ledger paths are invalid",
      );
    }
    this.stateRoot = path.resolve(options.stateRoot);
    this.trustedRoot = path.resolve(options.trustedRoot);
    this.workspaceShardId = options.workspaceShardId;
    this.profileRoot = path.join(this.stateRoot, this.runtimeProfileId);
    this.runtimeRoot = path.join(this.profileRoot, this.workspaceShardId);
    const relative = path.relative(this.stateRoot, this.runtimeRoot);
    if (relative !== path.join(this.runtimeProfileId, this.workspaceShardId)
      || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw ledgerError(
        "DEEPSEEK_HARNESS_LEDGER_OPTIONS_INVALID",
        "DeepSeek ledger escapes its root",
      );
    }
    this.ledgerPath = path.join(this.runtimeRoot, "runtime-ledger.json");
    this.data = null;
  }

  open() {
    if (this.data) return this;
    ensurePrivateDirectoryTree(this.stateRoot, this.trustedRoot);
    ensurePrivateDirectoryTree(this.profileRoot, this.trustedRoot);
    ensurePrivateDirectoryTree(this.runtimeRoot, this.trustedRoot);
    if (!statIfExists(this.fs, this.ledgerPath)) {
      this.data = {
        schemaVersion: SCHEMA_VERSION,
        runtime: DEEPSEEK_HARNESS_RUNTIME,
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
      throw ledgerError(
        "DEEPSEEK_HARNESS_LEDGER_INVALID",
        "DeepSeek ledger is malformed",
      );
    }
    this.data = validateLedger(parsed, this.runtimeProfileId, this.workspaceShardId);
    return this;
  }

  snapshot() {
    if (!this.data) {
      throw ledgerError("DEEPSEEK_HARNESS_LEDGER_CLOSED", "DeepSeek ledger is closed");
    }
    return structuredClone(this.data);
  }

  update(mutator) {
    if (!this.data || typeof mutator !== "function") {
      throw ledgerError("DEEPSEEK_HARNESS_LEDGER_CLOSED", "DeepSeek ledger is closed");
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
      throw ledgerError(
        "DEEPSEEK_HARNESS_LEDGER_TOO_LARGE",
        "DeepSeek ledger exceeds its limit",
      );
    }
    atomicWritePrivateFile(this.ledgerPath, serialized, {
      fs: this.fs,
      trustedRoot: this.trustedRoot,
    });
  }
}

function emptyDeepSeekHarnessUsage() {
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
  DeepSeekHarnessRuntimeLedger,
  SCHEMA_VERSION,
  emptyDeepSeekHarnessUsage,
  validateLedger,
};
