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
const {
  ensurePrivateDirectoryTree,
  lstatIfExists,
  serviceError,
} = require("./security");
const { deriveSessionTitleFromEvents } = require("./session-display-projection");

const TRANSCRIPT_SCHEMA_VERSION = 1;
const TRANSCRIPT_KINDS = Object.freeze([
  "user", "assistant", "tool_call", "tool_result", "approval", "input",
  "status", "artifact", "error",
]);
const TRANSCRIPT_KIND_SET = new Set(TRANSCRIPT_KINDS);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const RUNTIME_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RUNTIME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_LOG_BYTES = 256 * 1024 * 1024;

function transcriptError(code, message) {
  return serviceError(code, message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function cloneJson(value, code = "TRANSCRIPT_EVENT_INVALID") {
  let encoded;
  let parsed;
  try {
    encoded = JSON.stringify(value);
    parsed = JSON.parse(encoded);
  } catch {
    throw transcriptError(code, "Transcript value 不是稳定 JSON");
  }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_EVENT_BYTES) {
    throw transcriptError("TRANSCRIPT_EVENT_TOO_LARGE", "Transcript event 超过容量限制");
  }
  return parsed;
}

function assertId(value, field) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw transcriptError("TRANSCRIPT_EVENT_INVALID", `${field} 无效`);
  }
  return value;
}

function exactKeys(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function validateRuntimeRef(value, allowLegacy = false) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw transcriptError("TRANSCRIPT_EVENT_INVALID", "runtimeRef 无效");
  }
  const turn = value.turnId !== undefined;
  const fields = turn
    ? ["runtime", "runtimeProfileId", "runtimeAccountId", "sessionId", "turnId"]
    : ["runtime", "runtimeProfileId", "runtimeAccountId", "sessionId"];
  const legacyFields = turn
    ? ["runtime", "runtimeProfileId", "sessionId", "turnId"]
    : ["runtime", "runtimeProfileId", "sessionId"];
  const legacy = allowLegacy && exactKeys(value, legacyFields);
  if ((!legacy && !exactKeys(value, fields)) || !RUNTIME_PATTERN.test(value.runtime)
    || !ID_PATTERN.test(value.runtimeProfileId)
    || (!legacy && (typeof value.runtimeAccountId !== "string"
      || !RUNTIME_ACCOUNT_ID_PATTERN.test(value.runtimeAccountId)))
    || typeof value.sessionId !== "string" || value.sessionId.length === 0
    || value.sessionId.length > 512 || !value.sessionId.isWellFormed()
    || (turn && (typeof value.turnId !== "string" || value.turnId.length === 0
      || value.turnId.length > 512 || !value.turnId.isWellFormed()))) {
    throw transcriptError("TRANSCRIPT_EVENT_INVALID", "runtimeRef 无效");
  }
  return cloneJson(value);
}

function validateEvent(input, expectedSessionId = null, options = {}) {
  const fields = [
    "id", "sessionId", "runId", "seq", "kind", "content", "runtimeRef",
    "contextExcluded", "occurredAt",
  ];
  if (!exactKeys(input, fields)) {
    throw transcriptError("TRANSCRIPT_EVENT_INVALID", "Transcript event 字段无效");
  }
  assertId(input.id, "event.id");
  assertId(input.sessionId, "event.sessionId");
  if (expectedSessionId !== null && input.sessionId !== expectedSessionId) {
    throw transcriptError("TRANSCRIPT_EVENT_INVALID", "Transcript sessionId 不匹配");
  }
  if (input.runId !== null) assertId(input.runId, "event.runId");
  if (!Number.isSafeInteger(input.seq) || input.seq < 1 || !TRANSCRIPT_KIND_SET.has(input.kind)
    || typeof input.contextExcluded !== "boolean"
    || !Number.isSafeInteger(input.occurredAt) || input.occurredAt < 0) {
    throw transcriptError("TRANSCRIPT_EVENT_INVALID", "Transcript event 值无效");
  }
  const event = {
    ...input,
    content: cloneJson(input.content),
    runtimeRef: validateRuntimeRef(input.runtimeRef, options.allowLegacyRuntimeRef === true),
  };
  cloneJson(event);
  return event;
}

function recordChecksum(record) {
  const copy = { ...record };
  delete copy.checksum;
  return sha256(stableJson(copy));
}

function manifestChecksum(manifest) {
  const copy = { ...manifest };
  delete copy.checksum;
  return sha256(stableJson(copy));
}

function transcriptEventId(...parts) {
  return `tr-${sha256(stableJson(parts)).slice(0, 48)}`;
}

class TranscriptStore {
  constructor(options) {
    this.paths = options.paths;
    this.fs = options.fs || fs;
    this.now = options.now || Date.now;
    this.assertSecretSafe = options.assertSecretSafe || (() => true);
    this.maxLogBytes = options.maxLogBytes ?? MAX_LOG_BYTES;
    this.opened = false;
    this.sessions = new Map();
    this.poisonError = null;
  }

  _assertOpen(write = false) {
    if (!this.opened) throw transcriptError("TRANSCRIPT_STORE_CLOSED", "Transcript Store 未打开");
    if (write && this.poisonError) throw this.poisonError;
  }

  _sessionKey(profileId, sessionId) {
    return `${assertId(profileId, "profileId")}\0${assertId(sessionId, "sessionId")}`;
  }

  _sessionDir(profileId, sessionId) {
    return path.join(this.paths.agentsDir, assertId(profileId, "profileId"), "transcripts", assertId(sessionId, "sessionId"));
  }

  _paths(profileId, sessionId) {
    const dir = this._sessionDir(profileId, sessionId);
    return { dir, log: path.join(dir, "events.jsonl"), manifest: path.join(dir, "manifest.json") };
  }

  open() {
    if (this.opened) return;
    ensurePrivateDirectoryTree(this.paths.agentsDir, this.paths.trustedRoot);
    this.sessions.clear();
    this.poisonError = null;
    this.opened = true;
  }

  close() {
    this.sessions.clear();
    this.poisonError = null;
    this.opened = false;
  }

  _emptyState(profileId, sessionId) {
    return {
      profileId,
      sessionId,
      revision: 0,
      lastEventSeq: 0,
      events: [],
      byId: new Map(),
    };
  }

  _manifest(state) {
    const manifest = {
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      profileId: state.profileId,
      sessionId: state.sessionId,
      revision: state.revision,
      lastEventSeq: state.lastEventSeq,
      eventCount: state.events.length,
      updatedAt: state.events.at(-1)?.occurredAt ?? 0,
    };
    manifest.checksum = manifestChecksum(manifest);
    return manifest;
  }

  _writeManifest(state) {
    const targets = this._paths(state.profileId, state.sessionId);
    atomicWritePrivateFile(targets.manifest, `${stableJson(this._manifest(state))}\n`, {
      fs: this.fs,
      trustedRoot: this.paths.trustedRoot,
    });
  }

  _validateRecord(record, expectedSeq, state, options = {}) {
    if (!exactKeys(record, ["schemaVersion", "seq", "type", "payload", "checksum"])
      || record.schemaVersion !== TRANSCRIPT_SCHEMA_VERSION || record.seq !== expectedSeq
      || !["event.append", "event.context.set"].includes(record.type)
      || typeof record.checksum !== "string" || !HASH_PATTERN.test(record.checksum)
      || recordChecksum(record) !== record.checksum) {
      throw transcriptError("TRANSCRIPT_LOG_CORRUPT", "Transcript journal record 无效");
    }
    if (record.type === "event.append") {
      const event = validateEvent(record.payload, state.sessionId, options);
      if (event.seq !== state.lastEventSeq + 1 || state.byId.has(event.id)) {
        throw transcriptError("TRANSCRIPT_LOG_CORRUPT", "Transcript event seq/id 冲突");
      }
      state.events.push(event);
      state.byId.set(event.id, event);
      state.lastEventSeq = event.seq;
    } else {
      if (!exactKeys(record.payload, ["eventId", "contextExcluded"])
        || !ID_PATTERN.test(record.payload.eventId)
        || typeof record.payload.contextExcluded !== "boolean") {
        throw transcriptError("TRANSCRIPT_LOG_CORRUPT", "Transcript context operation 无效");
      }
      const event = state.byId.get(record.payload.eventId);
      if (!event) throw transcriptError("TRANSCRIPT_LOG_CORRUPT", "Transcript context event 不存在");
      event.contextExcluded = record.payload.contextExcluded;
    }
    state.revision = record.seq;
  }

  _repairPartialTail(target) {
    const stat = lstatIfExists(target);
    if (!stat) return Buffer.alloc(0);
    validatePrivateStat(stat, target);
    if (stat.size > this.maxLogBytes) {
      throw transcriptError("TRANSCRIPT_LOG_TOO_LARGE", "Transcript journal 超过容量限制");
    }
    const buffer = readPrivateFile(target, { fs: this.fs, maxBytes: this.maxLogBytes });
    if (buffer.length === 0 || buffer.at(-1) === 0x0a) return buffer;
    const lastNewline = buffer.lastIndexOf(0x0a);
    const committedBytes = lastNewline < 0 ? 0 : lastNewline + 1;
    const noFollow = this.fs.constants.O_NOFOLLOW || 0;
    const fd = this.fs.openSync(target, this.fs.constants.O_RDWR | noFollow);
    try {
      validatePrivateStat(this.fs.fstatSync(fd), target);
      this.fs.ftruncateSync(fd, committedBytes);
      this.fs.fsyncSync(fd);
    } finally { this.fs.closeSync(fd); }
    return buffer.subarray(0, committedBytes);
  }

  _validateManifest(value, state) {
    const fields = [
      "schemaVersion", "profileId", "sessionId", "revision", "lastEventSeq",
      "eventCount", "updatedAt", "checksum",
    ];
    if (!exactKeys(value, fields) || value.schemaVersion !== TRANSCRIPT_SCHEMA_VERSION
      || value.profileId !== state.profileId || value.sessionId !== state.sessionId
      || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !Number.isSafeInteger(value.lastEventSeq) || value.lastEventSeq < 0
      || !Number.isSafeInteger(value.eventCount) || value.eventCount < 0
      || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0
      || !HASH_PATTERN.test(value.checksum) || manifestChecksum(value) !== value.checksum) {
      throw transcriptError("TRANSCRIPT_MANIFEST_CORRUPT", "Transcript manifest 无效");
    }
    if (value.revision > state.revision) {
      throw transcriptError("TRANSCRIPT_MANIFEST_CORRUPT", "Transcript manifest 超前于 journal");
    }
    if (value.revision === state.revision) {
      const expected = this._manifest(state);
      if (stableJson(value) !== stableJson(expected)) {
        throw transcriptError("TRANSCRIPT_MANIFEST_CORRUPT", "Transcript manifest 与 journal 不一致");
      }
      return true;
    }
    return false;
  }

  _load(profileId, sessionId) {
    this._assertOpen();
    const key = this._sessionKey(profileId, sessionId);
    if (this.sessions.has(key)) return this.sessions.get(key);
    const targets = this._paths(profileId, sessionId);
    ensurePrivateDirectoryTree(targets.dir, this.paths.trustedRoot);
    const state = this._emptyState(profileId, sessionId);
    const buffer = this._repairPartialTail(targets.log);
    const text = buffer.toString("utf8");
    const lines = text.length === 0 ? [] : text.slice(0, -1).split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      let record;
      try { record = JSON.parse(lines[index]); } catch {
        throw transcriptError("TRANSCRIPT_LOG_CORRUPT", "Transcript journal 中间记录损坏");
      }
      this._validateRecord(record, index + 1, state, { allowLegacyRuntimeRef: true });
    }
    const manifestStat = lstatIfExists(targets.manifest);
    let manifestCurrent = state.revision === 0 && !manifestStat;
    if (manifestStat) {
      let value;
      try {
        value = JSON.parse(readPrivateFile(targets.manifest, {
          fs: this.fs, maxBytes: 16 * 1024,
        }).toString("utf8"));
      } catch (error) {
        if (error?.code) throw error;
        throw transcriptError("TRANSCRIPT_MANIFEST_CORRUPT", "Transcript manifest JSON 无效");
      }
      manifestCurrent = this._validateManifest(value, state);
    }
    if (!manifestCurrent) this._writeManifest(state);
    this.sessions.set(key, state);
    return state;
  }

  ensureSession(input) {
    this._assertOpen(true);
    const state = this._load(input.profileId, input.sessionId);
    return this._manifest(state);
  }

  _appendRecord(state, type, payload) {
    this._assertOpen(true);
    const targets = this._paths(state.profileId, state.sessionId);
    const record = {
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      seq: state.revision + 1,
      type,
      payload,
    };
    record.checksum = recordChecksum(record);
    const line = `${stableJson(record)}\n`;
    const currentSize = lstatIfExists(targets.log)?.size || 0;
    if (currentSize + Buffer.byteLength(line, "utf8") > this.maxLogBytes) {
      throw transcriptError("TRANSCRIPT_LOG_TOO_LARGE", "Transcript journal 超过容量限制");
    }
    const noFollow = this.fs.constants.O_NOFOLLOW || 0;
    const flags = this.fs.constants.O_CREAT | this.fs.constants.O_APPEND
      | this.fs.constants.O_WRONLY | noFollow;
    let fd;
    try {
      fd = this.fs.openSync(targets.log, flags, 0o600);
      const stat = validatePrivateStat(this.fs.fstatSync(fd), targets.log);
      if ((stat.mode & 0o077) !== 0) this.fs.fchmodSync(fd, 0o600);
      writeFully(this.fs, fd, line, "TRANSCRIPT_WRITE_FAILED");
      this.fs.fsyncSync(fd);
    } catch (error) {
      if (error?.code === "ELOOP") {
        throw transcriptError("UNSAFE_SYMLINK", "拒绝 Transcript journal symlink");
      }
      throw error;
    } finally { if (fd !== undefined) this.fs.closeSync(fd); }
    this._validateRecord(record, state.revision + 1, state);
    try {
      this._writeManifest(state);
    } catch (cause) {
      const error = transcriptError(
        "TRANSCRIPT_COMMIT_UNCERTAIN",
        "Transcript journal 已同步但 manifest 提交不确定",
      );
      error.cause = cause;
      error.committedUncertain = true;
      this.poisonError = error;
      throw error;
    }
    return record;
  }

  appendEvent(input) {
    this._assertOpen(true);
    const state = this._load(input.profileId, input.sessionId);
    const existing = state.byId.get(input.id);
    const candidate = {
      id: input.id,
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      seq: existing?.seq ?? state.lastEventSeq + 1,
      kind: input.kind,
      content: input.content,
      runtimeRef: input.runtimeRef ?? null,
      contextExcluded: input.contextExcluded === true,
      occurredAt: input.occurredAt ?? existing?.occurredAt ?? this.now(),
    };
    const event = validateEvent(candidate, input.sessionId, {
      allowLegacyRuntimeRef: existing !== undefined,
    });
    const safe = this.assertSecretSafe(event, Object.freeze({
      profileId: input.profileId,
      sessionId: input.sessionId,
      eventId: event.id,
    }));
    if (safe === false || safe?.then) {
      throw transcriptError("TRANSCRIPT_SECRET_REJECTED", "Transcript event 含敏感信息");
    }
    if (existing) {
      if (stableJson(existing) !== stableJson(event)) {
        throw transcriptError("TRANSCRIPT_EVENT_CONFLICT", "Transcript event id 输入冲突");
      }
      return structuredClone(existing);
    }
    this._appendRecord(state, "event.append", event);
    return structuredClone(state.byId.get(event.id));
  }

  setContextExcluded(input) {
    this._assertOpen(true);
    const state = this._load(input.profileId, input.sessionId);
    const event = state.byId.get(input.eventId);
    if (!event) throw transcriptError("TRANSCRIPT_EVENT_NOT_FOUND", "Transcript event 不存在");
    if (typeof input.contextExcluded !== "boolean") {
      throw transcriptError("TRANSCRIPT_EVENT_INVALID", "contextExcluded 无效");
    }
    if (event.contextExcluded === input.contextExcluded) return structuredClone(event);
    this._appendRecord(state, "event.context.set", {
      eventId: input.eventId,
      contextExcluded: input.contextExcluded,
    });
    return structuredClone(state.byId.get(input.eventId));
  }

  listEvents(profileId, sessionId, options = {}) {
    this._assertOpen();
    const state = this._load(profileId, sessionId);
    const includeExcluded = options.includeContextExcluded !== false;
    return state.events
      .filter((event) => includeExcluded || !event.contextExcluded)
      .map((event) => structuredClone(event));
  }

  getSessionDerivedTitle(profileId, sessionId) {
    this._assertOpen();
    return deriveSessionTitleFromEvents(this._load(profileId, sessionId).events);
  }

  getRevision(profileId, sessionId) {
    return this._load(profileId, sessionId).revision;
  }

  importHistoryItems(input) {
    this._assertOpen(true);
    if (!Array.isArray(input.items)) {
      throw transcriptError("TRANSCRIPT_IMPORT_INVALID", "Transcript import items 无效");
    }
    const imported = [];
    for (const item of input.items) {
      const canonical = cloneJson(item, "TRANSCRIPT_IMPORT_INVALID");
      if (!canonical || typeof canonical.id !== "string" || !ID_PATTERN.test(canonical.id)
        || !["user", "assistant", "toolResult", "system"].includes(canonical.role)
        || !["text", "thinking", "plan", "tool", "status", "prompt", "error"].includes(canonical.type)) {
        throw transcriptError("TRANSCRIPT_IMPORT_INVALID", "Codex history item 无效");
      }
      const kind = canonical.role === "user" ? "user"
        : canonical.role === "assistant" ? "assistant"
          : canonical.role === "toolResult" ? "tool_result"
            : canonical.type === "prompt" ? "input"
              : canonical.type === "error" ? "error" : "status";
      imported.push(this.appendEvent({
        profileId: input.profileId,
        sessionId: input.sessionId,
        id: transcriptEventId("codex-import", canonical.id),
        runId: canonical.runId ?? null,
        kind,
        content: { historyItem: canonical, importedFrom: "codex" },
        runtimeRef: input.runtimeRef ?? null,
        contextExcluded: false,
        occurredAt: canonical.createdAt ?? this.now(),
      }));
    }
    return imported;
  }

  exportSession(profileId, sessionId) {
    const state = this._load(profileId, sessionId);
    return {
      format: "shoggoth-transcript-v1",
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      profileId,
      sessionId,
      revision: state.revision,
      events: state.events.map((event) => structuredClone(event)),
    };
  }
}

module.exports = {
  TRANSCRIPT_KINDS,
  TRANSCRIPT_SCHEMA_VERSION,
  TranscriptStore,
  transcriptEventId,
  validateEvent,
};
