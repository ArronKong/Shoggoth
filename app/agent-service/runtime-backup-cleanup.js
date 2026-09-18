"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const {
  BACKUP_ENTRY_ID_PATTERN,
  RUNTIME_BACKUP_CATEGORIES,
  backupEntryId,
} = require("./runtime-backup-store");
const {
  inspectRuntimeStorage,
  sameIdentity,
  validateCanonicalOwnedDirectory,
} = require("./runtime-storage-inspector");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");

const DEFAULT_BACKUP_CLEANUP_PLAN_TTL_MS = 5 * 60 * 1_000;
const MAX_BACKUP_CLEANUP_PLANS = 128;
const MAX_BACKUP_AUDIT_RECORDS = 1_000;
const MAX_BACKUP_AUDIT_BYTES = 8 * 1024 * 1024;
const PLAN_ID_PATTERN = /^[a-f0-9]{64}$/u;
const CATEGORY_SET = new Set(RUNTIME_BACKUP_CATEGORIES);

function cleanupError(code, message) {
  return serviceError(code, message);
}

function exactInput(input, field, code) {
  let descriptor;
  let keys;
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype) {
      throw cleanupError(code, "备份清理参数必须是 plain object");
    }
    keys = Reflect.ownKeys(input);
    descriptor = Object.getOwnPropertyDescriptor(input, field);
  } catch (error) {
    if (error?.code === code) throw error;
    throw cleanupError(code, "备份清理参数无法安全读取");
  }
  if (keys.length !== 1 || keys[0] !== field || !descriptor?.enumerable
    || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
    throw cleanupError(code, `备份清理参数只能包含 ${field}`);
  }
  return descriptor.value;
}

function snapshotIdentity(identity) {
  return Object.freeze({
    dev: identity.dev,
    ino: identity.ino,
    uid: identity.uid,
    mtimeMs: identity.mtimeMs,
  });
}

function snapshotStats(stats) {
  return Object.freeze({
    bytes: stats.bytes,
    files: stats.files,
    dirs: stats.dirs,
    symlinks: stats.symlinks,
  });
}

function sameStorageStats(left, right) {
  return left.bytes === right.bytes
    && left.files === right.files
    && left.dirs === right.dirs
    && left.symlinks === right.symlinks;
}

function assertBackupTarget(entry, paths, options = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)
    || typeof entry.id !== "string" || !BACKUP_ENTRY_ID_PATTERN.test(entry.id)
    || typeof entry.backupName !== "string" || entry.backupName.length === 0
    || entry.backupName.includes("\0") || entry.backupName.includes(path.sep)
    || !CATEGORY_SET.has(entry.category) || entry.role !== "reclaimable"
    || typeof entry.path !== "string") {
    throw cleanupError("RUNTIME_BACKUP_CANDIDATE_INVALID", "历史备份清理候选无效");
  }
  const backupsDir = path.resolve(paths.backupsDir);
  const target = path.resolve(entry.path);
  if (target !== path.join(backupsDir, entry.backupName)
    || path.dirname(target) !== backupsDir
    || entry.id !== backupEntryId(backupsDir, entry.backupName)) {
    throw cleanupError(
      "RUNTIME_BACKUP_CANDIDATE_OUTSIDE_ROOT",
      "历史备份清理候选不是 backupsDir 的直接子目录",
    );
  }
  return validateCanonicalOwnedDirectory(target, {
    fs: options.fs,
    trustedRoot: backupsDir,
  });
}

function inUseReasons(value) {
  if (value === false || value === null || value === undefined) return null;
  if (value === true) return ["in-use"];
  if (Array.isArray(value)) {
    if (value.some((reason) => typeof reason !== "string" || reason.length === 0)) {
      throw cleanupError("RUNTIME_BACKUP_IN_USE_CHECK_INVALID", "备份 isInUse reasons 无效");
    }
    return value.length > 0 ? [...new Set(value)] : null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const reasons = [];
    if (value.inUse === true) reasons.push("in-use");
    if (value.migrationActive === true) reasons.push("migration-active");
    if (value.backupActive === true) reasons.push("backup-active");
    if (Array.isArray(value.reasons)) reasons.push(...value.reasons);
    if (reasons.some((reason) => typeof reason !== "string" || reason.length === 0)) {
      throw cleanupError("RUNTIME_BACKUP_IN_USE_CHECK_INVALID", "备份 isInUse reasons 无效");
    }
    return reasons.length > 0 ? [...new Set(reasons)] : null;
  }
  throw cleanupError("RUNTIME_BACKUP_IN_USE_CHECK_INVALID", "备份 isInUse 返回值无效");
}

class RuntimeBackupCleanup {
  constructor(options = {}) {
    if (!options.paths?.trustedRoot || !options.paths?.stateDir || !options.paths?.backupsDir
      || !options.paths?.backupCleanupAuditPath
      || typeof options.inventory !== "function"
      || typeof options.readCleanupState !== "function"
      || typeof options.isInUse !== "function") {
      throw cleanupError("RUNTIME_BACKUP_CLEANUP_OPTIONS_INVALID", "RuntimeBackupCleanup 参数无效");
    }
    const stateDir = path.resolve(options.paths.stateDir);
    const backupsDir = path.resolve(options.paths.backupsDir);
    if (path.dirname(backupsDir) !== stateDir
      || path.resolve(options.paths.backupCleanupAuditPath)
        !== path.join(backupsDir, ".cleanup-audit.jsonl")) {
      throw cleanupError("RUNTIME_BACKUP_CLEANUP_OPTIONS_INVALID", "备份清理路径边界无效");
    }
    this.paths = options.paths;
    this.inventory = options.inventory;
    this.readCleanupState = options.readCleanupState;
    this.isInUse = options.isInUse;
    this.now = options.now || Date.now;
    this.randomBytes = options.randomBytes || crypto.randomBytes;
    this.fs = options.fs || fs;
    this.scanLimits = options.scanLimits || {};
    this.planTtlMs = options.planTtlMs ?? DEFAULT_BACKUP_CLEANUP_PLAN_TTL_MS;
    if (typeof this.now !== "function" || typeof this.randomBytes !== "function"
      || !Number.isSafeInteger(this.planTtlMs) || this.planTtlMs <= 0
      || this.planTtlMs > 60 * 60 * 1_000) {
      throw cleanupError("RUNTIME_BACKUP_CLEANUP_OPTIONS_INVALID", "备份清理时钟或 TTL 无效");
    }
    this.plans = new Map();
  }

  #timestamp() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw cleanupError("RUNTIME_BACKUP_CLEANUP_OPTIONS_INVALID", "备份清理时钟返回值无效");
    }
    return value;
  }

  #purgeExpired(now) {
    for (const [planId, plan] of this.plans) {
      if (plan.expiresAt <= now) this.plans.delete(planId);
    }
  }

  #allocatePlanId() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const bytes = this.randomBytes(32);
      if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
        throw cleanupError("RUNTIME_BACKUP_CLEANUP_OPTIONS_INVALID", "备份清理随机数无效");
      }
      const planId = bytes.toString("hex");
      if (!this.plans.has(planId)) return planId;
    }
    throw cleanupError("RUNTIME_BACKUP_PLAN_ID_FAILED", "无法分配备份 cleanup plan ID");
  }

  async #assertCleanupReady() {
    const state = await this.readCleanupState();
    if (!state || typeof state !== "object" || Array.isArray(state)
      || typeof state.serviceReady !== "boolean"
      || typeof state.cleanupEligible !== "boolean") {
      throw cleanupError("RUNTIME_BACKUP_CLEANUP_STATE_INVALID", "备份清理门禁状态无效");
    }
    if (!state.serviceReady || !state.cleanupEligible) {
      throw cleanupError(
        "RUNTIME_BACKUP_CLEANUP_NOT_READY",
        "Service 尚未 ready 或 RuntimeAccount migration 尚未 cleanup eligible",
      );
    }
  }

  async #freshCandidate(entryId) {
    const manifest = await this.inventory();
    if (!manifest || !Array.isArray(manifest.entries)) {
      throw cleanupError("RUNTIME_BACKUP_INVENTORY_INVALID", "历史备份 inventory 无效");
    }
    const entry = manifest.entries.find((candidate) => candidate?.id === entryId);
    if (!entry || entry.role !== "reclaimable" || entry.stats?.incomplete === true) {
      throw cleanupError(
        "RUNTIME_BACKUP_CANDIDATE_NOT_RECLAIMABLE",
        "历史备份已不存在、被保留或无法完整扫描",
      );
    }
    return entry;
  }

  #scan(entry) {
    assertBackupTarget(entry, this.paths, { fs: this.fs });
    return inspectRuntimeStorage(entry.path, {
      ...this.scanLimits,
      fs: this.fs,
      trustedRoot: path.resolve(this.paths.backupsDir),
    });
  }

  async #assertNotInUse(entry) {
    const reasons = inUseReasons(await this.isInUse(Object.freeze({
      entryId: entry.id,
      category: entry.category,
    })));
    if (reasons) {
      const error = cleanupError("RUNTIME_BACKUP_CANDIDATE_IN_USE", "历史备份仍在使用中");
      error.reasons = reasons;
      throw error;
    }
  }

  #readAuditRecords() {
    ensurePrivateDirectoryTree(this.paths.backupsDir, this.paths.trustedRoot);
    let stat;
    try { stat = this.fs.lstatSync(this.paths.backupCleanupAuditPath); } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw cleanupError("RUNTIME_BACKUP_AUDIT_CORRUPT", "备份 cleanup audit 类型无效");
    }
    const text = readPrivateFile(this.paths.backupCleanupAuditPath, {
      fs: this.fs,
      maxBytes: MAX_BACKUP_AUDIT_BYTES,
    }).toString("utf8");
    try {
      return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      throw cleanupError("RUNTIME_BACKUP_AUDIT_CORRUPT", "备份 cleanup audit 已损坏");
    }
  }

  #appendAudit(record) {
    const records = this.#readAuditRecords().slice(-(MAX_BACKUP_AUDIT_RECORDS - 1));
    records.push(record);
    atomicWritePrivateFile(
      this.paths.backupCleanupAuditPath,
      records.map((item) => `${JSON.stringify(item)}\n`).join(""),
      { fs: this.fs, trustedRoot: this.paths.trustedRoot },
    );
  }

  async prepare(input) {
    const entryId = exactInput(input, "entryId", "RUNTIME_BACKUP_PREPARE_INVALID");
    if (typeof entryId !== "string" || !BACKUP_ENTRY_ID_PATTERN.test(entryId)) {
      throw cleanupError("RUNTIME_BACKUP_PREPARE_INVALID", "backup cleanup entryId 无效");
    }
    const now = this.#timestamp();
    this.#purgeExpired(now);
    if (this.plans.size >= MAX_BACKUP_CLEANUP_PLANS) {
      throw cleanupError("RUNTIME_BACKUP_PLAN_LIMIT", "未完成的 backup cleanup plan 过多");
    }
    await this.#assertCleanupReady();
    const entry = await this.#freshCandidate(entryId);
    const scanned = this.#scan(entry);
    if (scanned.incomplete) {
      throw cleanupError("RUNTIME_BACKUP_SCAN_INCOMPLETE", "历史备份容量扫描未完成");
    }
    await this.#assertNotInUse(entry);

    const planId = this.#allocatePlanId();
    const expiresAt = now + this.planTtlMs;
    this.plans.set(planId, Object.freeze({
      planId,
      entryId,
      backupName: entry.backupName,
      path: entry.path,
      category: entry.category,
      identity: snapshotIdentity(scanned.identity),
      stats: snapshotStats(scanned),
      preparedAt: now,
      expiresAt,
    }));
    return Object.freeze({
      planId,
      entryId,
      category: entry.category,
      ...snapshotStats(scanned),
      expiresAt,
    });
  }

  close() {
    this.plans.clear();
  }

  async commit(input) {
    const planId = exactInput(input, "planId", "RUNTIME_BACKUP_COMMIT_INVALID");
    if (typeof planId !== "string" || !PLAN_ID_PATTERN.test(planId)) {
      throw cleanupError("RUNTIME_BACKUP_COMMIT_INVALID", "backup cleanup planId 无效");
    }
    const now = this.#timestamp();
    const plan = this.plans.get(planId);
    this.plans.delete(planId);
    if (!plan) throw cleanupError("RUNTIME_BACKUP_PLAN_NOT_FOUND", "backup cleanup plan 不存在");
    if (plan.expiresAt <= now) {
      throw cleanupError("RUNTIME_BACKUP_PLAN_EXPIRED", "backup cleanup plan 已过期");
    }

    await this.#assertCleanupReady();
    const entry = await this.#freshCandidate(plan.entryId);
    if (entry.backupName !== plan.backupName || entry.path !== plan.path
      || entry.category !== plan.category) {
      throw cleanupError("RUNTIME_BACKUP_CANDIDATE_CHANGED", "历史备份候选绑定已变化");
    }
    const scanned = this.#scan(entry);
    if (scanned.incomplete) {
      throw cleanupError("RUNTIME_BACKUP_SCAN_INCOMPLETE", "历史备份容量扫描未完成");
    }
    if (!sameIdentity(plan.identity, scanned.identity)
      || plan.identity.uid !== scanned.identity.uid
      || plan.identity.mtimeMs !== scanned.identity.mtimeMs
      || !sameStorageStats(plan.stats, scanned)) {
      throw cleanupError("RUNTIME_BACKUP_CANDIDATE_CHANGED", "历史备份 inode、owner 或容量已变化");
    }
    await this.#assertNotInUse(entry);
    const finalIdentity = assertBackupTarget(entry, this.paths, { fs: this.fs });
    if (!sameIdentity(plan.identity, finalIdentity)
      || plan.identity.uid !== finalIdentity.uid
      || plan.identity.mtimeMs !== finalIdentity.mtimeMs) {
      throw cleanupError("RUNTIME_BACKUP_CANDIDATE_CHANGED", "历史备份最终 identity 已变化");
    }

    // Audit 必须在破坏性 rename 前可读取；失败时目标仍留在原处。
    this.#readAuditRecords();
    const stagedPath = path.join(this.paths.backupsDir, `.cleanup-${planId}`);
    try {
      this.fs.lstatSync(stagedPath);
      throw cleanupError("RUNTIME_BACKUP_STAGING_CONFLICT", "backup cleanup staging 已存在");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.fs.renameSync(plan.path, stagedPath);

    let staged;
    try { staged = this.fs.lstatSync(stagedPath); } catch {
      throw cleanupError("RUNTIME_BACKUP_RENAME_UNCERTAIN", "历史备份 rename 后状态不确定");
    }
    if (!staged.isDirectory() || staged.isSymbolicLink()
      || !sameIdentity(plan.identity, staged)
      || plan.identity.uid !== staged.uid) {
      const error = cleanupError(
        "RUNTIME_BACKUP_RENAME_IDENTITY_MISMATCH",
        "历史备份 rename 后 identity 不匹配，已保留 staging 证据",
      );
      error.cleanupStaged = true;
      try {
        this.#appendAudit({
          version: 1,
          status: "identity-mismatch",
          entryId: plan.entryId,
          category: plan.category,
          planDigest: crypto.createHash("sha256").update(planId).digest("hex"),
          occurredAt: now,
        });
      } catch {}
      throw error;
    }

    try {
      this.fs.rmSync(stagedPath, { recursive: true, force: false, maxRetries: 2 });
    } catch (cause) {
      const error = cleanupError(
        "RUNTIME_BACKUP_DELETE_FAILED",
        "历史备份已移入私有 staging，但递归删除失败",
      );
      error.cause = cause;
      error.cleanupStaged = true;
      try {
        this.#appendAudit({
          version: 1,
          status: "delete-failed",
          entryId: plan.entryId,
          category: plan.category,
          planDigest: crypto.createHash("sha256").update(planId).digest("hex"),
          occurredAt: now,
        });
      } catch {}
      throw error;
    }

    const result = Object.freeze({
      entryId: plan.entryId,
      category: plan.category,
      bytesReleased: scanned.bytes,
      filesRemoved: scanned.files,
      dirsRemoved: scanned.dirs,
      symlinksRemoved: scanned.symlinks,
      deletedAt: now,
    });
    try {
      this.#appendAudit({
        version: 1,
        status: "deleted",
        ...result,
        planDigest: crypto.createHash("sha256").update(planId).digest("hex"),
      });
    } catch (cause) {
      const error = cleanupError(
        "RUNTIME_BACKUP_CLEANUP_COMMITTED_AUDIT_FAILED",
        "历史备份已删除，但 cleanup audit 写入失败",
      );
      error.cause = cause;
      error.committed = true;
      error.result = result;
      throw error;
    }

    try {
      await this.inventory();
    } catch (cause) {
      const error = cleanupError(
        "RUNTIME_BACKUP_CLEANUP_COMMITTED_REFRESH_FAILED",
        "历史备份已删除，但 inventory 刷新失败",
      );
      error.cause = cause;
      error.committed = true;
      error.result = result;
      throw error;
    }
    return result;
  }
}

module.exports = {
  DEFAULT_BACKUP_CLEANUP_PLAN_TTL_MS,
  RuntimeBackupCleanup,
  assertBackupTarget,
};
