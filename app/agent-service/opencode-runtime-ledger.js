"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, statIfExists } = require("./private-file");
const { validRuntimeAccountId, validRuntimeProfileId } = require("./runtime-adapter");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");

const SCHEMA_VERSION = 1;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const STATUS = new Set(["inProgress", "completed", "failed", "interrupted", "canceled"]);
const ACCEPTANCE = new Set(["unknown", "accepted", "failed"]);
const safe = (value, max = 512) => typeof value === "string" && value.length > 0 && value.isWellFormed()
  && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= max;
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const fail = () => serviceError("OPENCODE_LEDGER_INVALID", "OpenCode runtime ledger is invalid");

function validateLedger(value, profileId, accountId, shardId) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION || value.runtime !== "opencode"
    || value.runtimeProfileId !== profileId || value.runtimeAccountId !== accountId
    || value.workspaceShardId !== shardId || !Array.isArray(value.sessions)
    || value.sessions.length > 4096) throw fail();
  const sessionIds = new Set(), sources = new Set();
  for (const session of value.sessions) {
    if (!session || !/^ses_[A-Za-z0-9_-]{8,128}$/u.test(session.id)
      || !safe(session.source, 256) || !safe(session.cwd, 4096)
      || !path.isAbsolute(session.cwd) || !validTime(session.createdAt)
      || !validTime(session.updatedAt) || session.updatedAt < session.createdAt
      || typeof session.created !== "boolean" || typeof session.archived !== "boolean"
      || (session.title !== null && !safe(session.title, 1024))
      || !Array.isArray(session.turns) || session.turns.length > 8192
      || sessionIds.has(session.id) || sources.has(session.source)) throw fail();
    sessionIds.add(session.id); sources.add(session.source);
    const operationIds = new Set(), turnIds = new Set(), messageIds = new Set();
    for (const turn of session.turns) {
      if (!turn || !safe(turn.id) || !safe(turn.operationId)
        || !/^msg_[A-Za-z0-9_-]{8,128}$/u.test(turn.messageId)
        || !/^[a-f0-9]{64}$/u.test(turn.fingerprint)
        || !ACCEPTANCE.has(turn.acceptance) || !STATUS.has(turn.status)
        || (turn.errorCode !== null && !safe(turn.errorCode, 128))
        || !validTime(turn.createdAt) || !validTime(turn.updatedAt)
        || turn.updatedAt < turn.createdAt
        || !Array.isArray(turn.assistantMessages) || turn.assistantMessages.length > 1024
        || !turn.assistantMessages.every(message => message && safe(message.id)
          && typeof message.text === "string" && Buffer.byteLength(message.text, "utf8") <= 8 * 1024 * 1024)
        || operationIds.has(turn.operationId) || turnIds.has(turn.id) || messageIds.has(turn.messageId)) throw fail();
      operationIds.add(turn.operationId); turnIds.add(turn.id); messageIds.add(turn.messageId);
    }
  }
  return value;
}

class OpenCodeRuntimeLedger {
  constructor(options = {}) {
    this.fs = options.fs || fs;
    const { runtimeProfileId, runtimeAccountId, workspaceShardId, stateRoot, trustedRoot } = options;
    if (!validRuntimeProfileId(runtimeProfileId) || !validRuntimeAccountId(runtimeAccountId)
      || typeof workspaceShardId !== "string" || !/^[a-f0-9]{64}$/u.test(workspaceShardId)
      || typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)
      || typeof trustedRoot !== "string" || !path.isAbsolute(trustedRoot)) throw fail();
    this.runtimeProfileId = runtimeProfileId;
    this.runtimeAccountId = runtimeAccountId;
    this.workspaceShardId = workspaceShardId;
    this.stateRoot = path.resolve(stateRoot);
    this.trustedRoot = path.resolve(trustedRoot);
    const relative = path.relative(this.trustedRoot, this.stateRoot);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw fail();
    this.directory = path.join(this.stateRoot, runtimeProfileId, runtimeAccountId, workspaceShardId);
    this.file = path.join(this.directory, "runtime-ledger.json");
    this.data = null;
  }

  open() {
    if (this.data) return this;
    ensurePrivateDirectoryTree(this.directory, this.trustedRoot);
    if (statIfExists(this.fs, this.file)) {
      let loaded;
      try { loaded = JSON.parse(readPrivateFile(this.file, { fs: this.fs, maxBytes: MAX_LEDGER_BYTES }).toString("utf8")); }
      catch (error) {
        if (error?.code?.startsWith?.("PRIVATE_FILE_") || error?.code?.startsWith?.("UNSAFE_")) throw error;
        throw fail();
      }
      this.data = validateLedger(loaded, this.runtimeProfileId, this.runtimeAccountId, this.workspaceShardId);
    } else {
      this.data = { schemaVersion: SCHEMA_VERSION, runtime: "opencode", runtimeProfileId: this.runtimeProfileId,
        runtimeAccountId: this.runtimeAccountId, workspaceShardId: this.workspaceShardId, sessions: [] };
      this.#write(this.data);
    }
    return this;
  }

  snapshot() { if (!this.data) throw fail(); return structuredClone(this.data); }
  update(mutator) {
    if (!this.data || typeof mutator !== "function") throw fail();
    const next = structuredClone(this.data);
    const result = mutator(next);
    validateLedger(next, this.runtimeProfileId, this.runtimeAccountId, this.workspaceShardId);
    this.#write(next);
    this.data = next;
    return result;
  }

  #write(data) {
    const serialized = `${JSON.stringify(data)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_LEDGER_BYTES) throw fail();
    atomicWritePrivateFile(this.file, serialized, { fs: this.fs, trustedRoot: this.trustedRoot });
  }
}

module.exports = { OpenCodeRuntimeLedger, validateLedger };
