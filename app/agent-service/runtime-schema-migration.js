"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  RUNTIME_SCHEMA_METADATA_FILES,
  acquireRuntimeSchemaMetadataWriterFence,
  createRuntimeSchemaMetadataBackup,
  verifyRuntimeSchemaMetadataBackup,
} = require("./authority-backup");
const { CHAT_SESSION_STORE_VERSION } = require("./chat-session-store");
const { STORE_SCHEMA_VERSION } = require("./product-store");
const { lstatIfExists, serviceError } = require("./security");

const PRE_RUNTIME_SCHEMA_BACKUP_ID = `pre-runtime-schema-v${STORE_SCHEMA_VERSION}`;
const MAX_SCHEMA_PROBE_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_PREFIX_BYTES = 64 * 1024;

function migrationError(code, message) {
  return serviceError(code, message);
}

function safeFileStat(target) {
  const stat = lstatIfExists(target);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw migrationError("MIGRATION_SOURCE_UNSAFE", "迁移探测遇到不安全状态文件");
  }
  return stat;
}

function sameFileVersion(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
    && left.nlink === right.nlink && left.mode === right.mode && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function readPinnedPrefix(target, maxBytes) {
  const before = safeFileStat(target);
  if (!before) return null;
  let fd;
  try {
    try {
      fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    } catch (error) {
      if (error?.code === "ELOOP") {
        throw migrationError("MIGRATION_SOURCE_UNSAFE", "迁移探测遇到 symlink 状态文件");
      }
      throw error;
    }
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !sameFileVersion(before, opened)) {
      throw migrationError("MIGRATION_SOURCE_UNSAFE", "迁移探测期间状态文件发生变化");
    }
    const length = Math.min(before.size, maxBytes);
    const bytes = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const read = fs.readSync(fd, bytes, offset, length - offset, offset);
      if (!Number.isSafeInteger(read) || read <= 0) {
        throw migrationError("MIGRATION_SOURCE_UNSAFE", "迁移探测期间状态文件读取不完整");
      }
      offset += read;
    }
    const after = fs.fstatSync(fd);
    let pathAfter;
    try { pathAfter = fs.lstatSync(target); } catch {
      throw migrationError("MIGRATION_SOURCE_UNSAFE", "迁移探测期间状态文件发生变化");
    }
    if (!after.isFile() || !pathAfter.isFile() || pathAfter.isSymbolicLink()
      || after.nlink !== 1 || pathAfter.nlink !== 1
      || !sameFileVersion(before, after) || !sameFileVersion(before, pathAfter)) {
      throw migrationError("MIGRATION_SOURCE_UNSAFE", "迁移探测期间状态文件发生变化");
    }
    return { bytes, size: before.size };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function jsonSchemaVersion(target) {
  const pinned = readPinnedPrefix(target, MAX_SCHEMA_PROBE_BYTES);
  if (!pinned) return null;
  if (pinned.size > MAX_SCHEMA_PROBE_BYTES) return "unknown";
  try {
    return JSON.parse(pinned.bytes.toString("utf8")).schemaVersion ?? "unknown";
  } catch {
    return "unknown";
  }
}

function chatSchemaVersion(target) {
  const pinned = readPinnedPrefix(target, MAX_SCHEMA_PROBE_BYTES);
  if (!pinned) return null;
  if (pinned.size > MAX_SCHEMA_PROBE_BYTES) return "unknown";
  try {
    return JSON.parse(pinned.bytes.toString("utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function firstEventSchemaVersion(target) {
  const pinned = readPinnedPrefix(target, MAX_EVENT_PREFIX_BYTES);
  if (!pinned || pinned.size === 0) return null;
  const end = pinned.bytes.indexOf(0x0a);
  if (end < 0) return "unknown";
  try {
    return JSON.parse(pinned.bytes.subarray(0, end).toString("utf8")).schemaVersion ?? "unknown";
  } catch {
    return "unknown";
  }
}

function runtimeSchemaMigrationState(paths) {
  const productVersion = jsonSchemaVersion(paths.stateSnapshotPath);
  const productSnapshotNeedsMigration = productVersion !== null
    && productVersion !== STORE_SCHEMA_VERSION;
  const inspectEvents = productVersion === null || productSnapshotNeedsMigration;
  const eventVersion = inspectEvents ? firstEventSchemaVersion(paths.eventLogPath) : null;
  const eventLogNeedsMigration = productVersion === null && eventVersion !== null
    && eventVersion !== STORE_SCHEMA_VERSION;
  const chatVersion = chatSchemaVersion(path.join(paths.stateDir, "chat-sessions.json"));
  const chatNeedsMigration = chatVersion !== null && chatVersion !== CHAT_SESSION_STORE_VERSION;
  const sourceRequirements = [];
  if (productSnapshotNeedsMigration) {
    sourceRequirements.push({ path: "state.snapshot.json", match: "exact" });
  }
  if (inspectEvents && eventVersion !== null && eventVersion !== STORE_SCHEMA_VERSION) {
    sourceRequirements.push({
      path: "events.jsonl",
      match: "event-log-continuation",
      targetSchemaVersion: STORE_SCHEMA_VERSION,
    });
  }
  if (chatNeedsMigration) {
    sourceRequirements.push({ path: "chat-sessions.json", match: "exact" });
  }
  sourceRequirements.sort((left, right) => (
    RUNTIME_SCHEMA_METADATA_FILES.indexOf(left.path)
      - RUNTIME_SCHEMA_METADATA_FILES.indexOf(right.path)
  ));
  return {
    needsMigration: productSnapshotNeedsMigration || eventLogNeedsMigration || chatNeedsMigration,
    sourceRequirements,
  };
}

function needsRuntimeSchemaMigration(paths) {
  return runtimeSchemaMigrationState(paths).needsMigration;
}

function ensureRuntimeSchemaMigrationBackup(options = {}) {
  const { paths, activeServiceLock } = options;
  if (!paths?.backupsDir || !activeServiceLock) {
    throw migrationError("MIGRATION_BACKUP_OPTIONS_INVALID", "迁移备份参数无效");
  }
  const fence = acquireRuntimeSchemaMetadataWriterFence({
    paths,
    acquireWriterLease: options.acquireWriterLease,
  });
  let operationError = null;
  let result;
  try {
    const state = runtimeSchemaMigrationState(paths);
    if (!state.needsMigration) return null;
    const backupPath = path.join(paths.backupsDir, PRE_RUNTIME_SCHEMA_BACKUP_ID);
    if (lstatIfExists(backupPath)) {
      try {
        result = verifyRuntimeSchemaMetadataBackup({
          paths,
          backupId: PRE_RUNTIME_SCHEMA_BACKUP_ID,
          activeServiceLock,
          activeWriterLocks: fence.activeWriterLocks,
          sourceRequirements: state.sourceRequirements,
        });
      } catch (error) {
        if (error?.code !== "BACKUP_SOURCE_MISMATCH") throw error;
        throw migrationError(
          "MIGRATION_BACKUP_STALE",
          "现有迁移备份不属于当前 legacy metadata generation",
        );
      }
    } else {
      result = createRuntimeSchemaMetadataBackup({
        paths,
        backupId: PRE_RUNTIME_SCHEMA_BACKUP_ID,
        now: options.now,
        activeServiceLock,
        activeWriterLocks: fence.activeWriterLocks,
      });
    }
  } catch (error) {
    operationError = error;
  } finally {
    try {
      fence.release();
    } catch (releaseError) {
      if (!operationError) throw releaseError;
      const aggregate = new AggregateError(
        [operationError, releaseError],
        "Runtime schema migration writer fence 释放失败",
      );
      aggregate.code = "MIGRATION_WRITER_FENCE_RELEASE_FAILED";
      throw aggregate;
    }
  }
  if (operationError) throw operationError;
  return result;
}

module.exports = {
  PRE_RUNTIME_SCHEMA_BACKUP_ID,
  ensureRuntimeSchemaMigrationBackup,
  needsRuntimeSchemaMigration,
};
