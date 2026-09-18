"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PRE_RUNTIME_SCHEMA_BACKUP_ID } = require("./runtime-schema-migration");
const { STORE_SCHEMA_VERSION } = require("./product-store");
const {
  inspectRuntimeStorage,
  sameIdentity,
  validateCanonicalOwnedDirectory,
} = require("./runtime-storage-inspector");
const { serviceError } = require("./security");

const BACKUP_INVENTORY_VERSION = 1;
const DEFAULT_MAX_BACKUP_DIRECTORIES = 256;
const DEFAULT_BACKUP_INVENTORY_DURATION_MS = 10_000;
const DEFAULT_STAGING_STALE_MS = 24 * 60 * 60 * 1_000;
const BACKUP_ENTRY_ID_PATTERN = /^runtime-backup-[a-f0-9]{64}-v1$/u;

const RUNTIME_BACKUP_CATEGORIES = Object.freeze([
  "native-runtime-import",
  "runtime-schema-history",
  "runtime-schema-current",
  "native-capabilities",
  "memory-migration",
  "permission-policy",
  "staging",
  "unknown",
]);

function backupError(code, message) {
  return serviceError(code, message);
}

function positiveInteger(value, fallback, label) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw backupError("RUNTIME_BACKUP_OPTIONS_INVALID", `${label} 必须是正整数`);
  }
  return selected;
}

function timestamp(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw backupError("RUNTIME_BACKUP_OPTIONS_INVALID", "备份清单时钟返回值无效");
  }
  return value;
}

function assertOwned(stat, target) {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw backupError("RUNTIME_BACKUP_OWNER_INVALID", `备份目录不属于当前用户: ${target}`);
  }
}

function backupEntryId(backupsDir, name) {
  return `runtime-backup-${crypto.createHash("sha256")
    .update("shoggoth-runtime-backup-entry-v1\0", "utf8")
    .update(JSON.stringify([path.resolve(backupsDir), name]), "utf8")
    .digest("hex")}-v1`;
}

function classifyBackup(name, lastModifiedAt, now, stagingStaleMs) {
  if (name === PRE_RUNTIME_SCHEMA_BACKUP_ID) {
    return Object.freeze({ category: "runtime-schema-current", role: "retained" });
  }
  const schema = /^pre-runtime-schema-v([1-9][0-9]*)$/u.exec(name);
  if (schema && Number(schema[1]) < STORE_SCHEMA_VERSION) {
    return Object.freeze({ category: "runtime-schema-history", role: "reclaimable" });
  }
  if (name === "pre-native-runtime-import-v1") {
    return Object.freeze({ category: "native-runtime-import", role: "reclaimable" });
  }
  if (/^pre-native-capabilities-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) {
    return Object.freeze({ category: "native-capabilities", role: "reclaimable" });
  }
  if (/^pre-shoggoth-memory-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) {
    return Object.freeze({ category: "memory-migration", role: "reclaimable" });
  }
  if (/^permission-policy-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) {
    return Object.freeze({ category: "permission-policy", role: "reclaimable" });
  }
  if (/^\.staging-[A-Za-z0-9][A-Za-z0-9._-]{0,220}$/u.test(name)) {
    return Object.freeze({
      category: "staging",
      role: now - lastModifiedAt >= stagingStaleMs ? "reclaimable" : "retained",
    });
  }
  return Object.freeze({ category: "unknown", role: "retained" });
}

function directoryStat(fileSystem, target) {
  let stat;
  try {
    stat = fileSystem.lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return stat;
}

function assertDirectoryUnchanged(fileSystem, target, expected) {
  const stat = directoryStat(fileSystem, target);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()
    || !sameIdentity(expected, stat)
    || expected.uid !== stat.uid || expected.mtimeMs !== stat.mtimeMs) {
    throw backupError("RUNTIME_BACKUP_CHANGED", "备份目录在清单扫描期间发生变化");
  }
  assertOwned(stat, target);
}

class RuntimeBackupStore {
  constructor(options = {}) {
    if (!options.paths?.stateDir || !options.paths?.backupsDir) {
      throw backupError("RUNTIME_BACKUP_OPTIONS_INVALID", "RuntimeBackupStore paths 无效");
    }
    this.paths = options.paths;
    this.fs = options.fs || fs;
    this.now = options.now || Date.now;
    this.scanLimits = options.scanLimits || {};
    this.maxDirectories = positiveInteger(
      options.maxDirectories,
      DEFAULT_MAX_BACKUP_DIRECTORIES,
      "maxDirectories",
    );
    this.maxDurationMs = positiveInteger(
      options.maxDurationMs,
      DEFAULT_BACKUP_INVENTORY_DURATION_MS,
      "maxDurationMs",
    );
    this.stagingStaleMs = positiveInteger(
      options.stagingStaleMs,
      DEFAULT_STAGING_STALE_MS,
      "stagingStaleMs",
    );
    if (typeof this.now !== "function") {
      throw backupError("RUNTIME_BACKUP_OPTIONS_INVALID", "RuntimeBackupStore 时钟无效");
    }
    const stateDir = path.resolve(this.paths.stateDir);
    const backupsDir = path.resolve(this.paths.backupsDir);
    if (path.dirname(backupsDir) !== stateDir) {
      throw backupError("RUNTIME_BACKUP_ROOT_INVALID", "backupsDir 必须是 stateDir 的直接子目录");
    }
    this.stateDir = stateDir;
    this.backupsDir = backupsDir;
  }

  refresh() {
    const generatedAt = timestamp(this.now);
    const rootStat = directoryStat(this.fs, this.backupsDir);
    if (rootStat === null) {
      return Object.freeze({
        version: BACKUP_INVENTORY_VERSION,
        generatedAt,
        entries: Object.freeze([]),
      });
    }
    const rootIdentity = validateCanonicalOwnedDirectory(this.backupsDir, {
      fs: this.fs,
      trustedRoot: this.stateDir,
    });
    const names = [];
    let handle;
    try {
      handle = this.fs.opendirSync(this.backupsDir);
      let dirent;
      while ((dirent = handle.readSync()) !== null) {
        if (names.length >= this.maxDirectories) {
          throw backupError("RUNTIME_BACKUP_INVENTORY_LIMIT", "备份目录项数量超过安全上限");
        }
        if (timestamp(this.now) - generatedAt >= this.maxDurationMs) {
          throw backupError("RUNTIME_BACKUP_INVENTORY_LIMIT", "备份清单扫描超时");
        }
        names.push(dirent.name);
      }
    } finally {
      handle?.closeSync();
    }
    assertDirectoryUnchanged(this.fs, this.backupsDir, rootIdentity);

    const entries = [];
    for (const name of names.sort((left, right) => left.localeCompare(right, "en"))) {
      if (timestamp(this.now) - generatedAt >= this.maxDurationMs) {
        throw backupError("RUNTIME_BACKUP_INVENTORY_LIMIT", "备份清单扫描超时");
      }
      const target = path.join(this.backupsDir, name);
      const relative = path.relative(this.backupsDir, target);
      if (relative !== name || path.isAbsolute(relative) || relative.includes(path.sep)) {
        throw backupError("RUNTIME_BACKUP_CANDIDATE_INVALID", "备份清单包含越界目录");
      }
      const stat = this.fs.lstatSync(target);
      assertOwned(stat, target);
      // backupsDir 还包含审计和 Finder 元数据。清单只盘点直接子目录，且绝不跟随链接。
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      const remainingDurationMs = Math.max(
        1,
        this.maxDurationMs - (timestamp(this.now) - generatedAt),
      );
      const stats = inspectRuntimeStorage(target, {
        ...this.scanLimits,
        maxDurationMs: Math.min(
          this.scanLimits.maxDurationMs ?? remainingDurationMs,
          remainingDurationMs,
        ),
        fs: this.fs,
        now: this.now,
        trustedRoot: this.backupsDir,
      });
      if (!sameIdentity(stat, stats.identity) || stat.uid !== stats.identity.uid
        || stat.mtimeMs !== stats.identity.mtimeMs) {
        throw backupError("RUNTIME_BACKUP_CHANGED", "备份候选在清单扫描期间发生变化");
      }
      const lastModifiedAt = Math.max(0, Math.trunc(stats.identity.mtimeMs));
      const classification = classifyBackup(
        name,
        lastModifiedAt,
        generatedAt,
        this.stagingStaleMs,
      );
      entries.push(Object.freeze({
        id: backupEntryId(this.backupsDir, name),
        backupName: name,
        path: target,
        ...classification,
        stats,
        lastModifiedAt,
      }));
    }
    assertDirectoryUnchanged(this.fs, this.backupsDir, rootIdentity);
    return Object.freeze({
      version: BACKUP_INVENTORY_VERSION,
      generatedAt,
      entries: Object.freeze(entries),
    });
  }
}

module.exports = {
  BACKUP_ENTRY_ID_PATTERN,
  BACKUP_INVENTORY_VERSION,
  DEFAULT_BACKUP_INVENTORY_DURATION_MS,
  DEFAULT_MAX_BACKUP_DIRECTORIES,
  DEFAULT_STAGING_STALE_MS,
  RUNTIME_BACKUP_CATEGORIES,
  RuntimeBackupStore,
  backupEntryId,
  classifyBackup,
};
