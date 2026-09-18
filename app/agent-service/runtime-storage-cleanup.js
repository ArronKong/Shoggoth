"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { RUNTIME_ACCOUNT_RUNTIMES } = require("./runtime-account");
const { ensurePrivateDirectoryTree, lstatIfExists, serviceError } = require("./security");
const { legacyHomeId, legacyHomePathMatches } = require("./legacy-runtime-home-store");
const {
  inspectRuntimeStorage,
  sameIdentity,
  validateCanonicalOwnedDirectory,
} = require("./runtime-storage-inspector");

const DEFAULT_CLEANUP_PLAN_TTL_MS = 5 * 60 * 1_000;
const MAX_CLEANUP_PLANS = 128;
const MAX_AUDIT_RECORDS = 1_000;
const MAX_AUDIT_BYTES = 8 * 1024 * 1024;
const PLAN_ID_PATTERN = /^[a-f0-9]{64}$/u;
const ENTRY_ID_PATTERN = /^legacy-home-[a-f0-9]{64}-v1$/u;
const RUNTIME_PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const KNOWN_RUNTIME_SET = new Set(RUNTIME_ACCOUNT_RUNTIMES);

function cleanupError(code, message) {
  return serviceError(code, message);
}

function exactInput(input, field, code) {
  let descriptor;
  let keys;
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype) {
      throw cleanupError(code, "清理参数必须是 plain object");
    }
    keys = Reflect.ownKeys(input);
    descriptor = Object.getOwnPropertyDescriptor(input, field);
  } catch (error) {
    if (error?.code === code) throw error;
    throw cleanupError(code, "清理参数无法安全读取");
  }
  if (keys.length !== 1 || keys[0] !== field || !descriptor?.enumerable
    || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
    throw cleanupError(code, `清理参数只能包含 ${field}`);
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

function sameStorageStats(left, right) {
  return left.bytes === right.bytes
    && left.files === right.files
    && left.dirs === right.dirs
    && left.symlinks === right.symlinks;
}

function assertLegacyTarget(entry, stateDir, options = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)
    || !ENTRY_ID_PATTERN.test(entry.id)
    || !KNOWN_RUNTIME_SET.has(entry.runtime)
    || !RUNTIME_PROFILE_ID_PATTERN.test(entry.runtimeProfileId)
    || typeof entry.runtimeAccountId !== "string" || entry.runtimeAccountId.length === 0
    || entry.role !== "reclaimable" || typeof entry.path !== "string") {
    throw cleanupError("RUNTIME_STORAGE_CANDIDATE_INVALID", "legacy Home 清理候选无效");
  }
  const resolvedStateDir = path.resolve(stateDir);
  const resolvedTarget = path.resolve(entry.path);
  if (!legacyHomePathMatches(entry, resolvedStateDir)
    || entry.id !== legacyHomeId(entry.runtime, entry.runtimeProfileId, entry.runtimeAccountId)) {
    throw cleanupError(
      "RUNTIME_STORAGE_CANDIDATE_OUTSIDE_LEGACY_ROOTS",
      "清理候选不是已知的 legacy Runtime Home",
    );
  }
  return validateCanonicalOwnedDirectory(resolvedTarget, {
    fs: options.fs,
    trustedRoot: resolvedStateDir,
  });
}

function inUseResult(value) {
  if (value === false || value === null || value === undefined) return null;
  if (value === true) return ["in-use"];
  if (Array.isArray(value)) {
    if (value.some((reason) => typeof reason !== "string" || reason.length === 0)) {
      throw cleanupError("RUNTIME_STORAGE_IN_USE_CHECK_INVALID", "isInUse reasons 无效");
    }
    return value.length > 0 ? [...value] : null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const reasons = [];
    if (value.inUse === true) reasons.push("in-use");
    if (value.activeRun === true) reasons.push("active-run");
    if (value.activeHost === true) reasons.push("active-host");
    if (value.activeLogin === true) reasons.push("active-login");
    if (Array.isArray(value.reasons)) {
      if (value.reasons.some((reason) => typeof reason !== "string" || reason.length === 0)) {
        throw cleanupError("RUNTIME_STORAGE_IN_USE_CHECK_INVALID", "isInUse reasons 无效");
      }
      reasons.push(...value.reasons);
    }
    return reasons.length > 0 ? [...new Set(reasons)] : null;
  }
  throw cleanupError("RUNTIME_STORAGE_IN_USE_CHECK_INVALID", "isInUse 返回值无效");
}

function auditRecord(record) {
  return `${JSON.stringify(record)}\n`;
}

class RuntimeStorageCleanup {
  constructor(options = {}) {
    if (!options.paths?.stateDir || !options.paths?.trustedRoot
      || !options.paths?.legacyRuntimeHomesDir || !options.paths?.runtimeCleanupAuditPath
      || typeof options.inventory !== "function"
      || typeof options.readCleanupState !== "function"
      || typeof options.isInUse !== "function") {
      throw cleanupError("RUNTIME_STORAGE_CLEANUP_OPTIONS_INVALID", "RuntimeStorageCleanup 参数无效");
    }
    this.paths = options.paths;
    this.inventory = options.inventory;
    this.readCleanupState = options.readCleanupState;
    this.isInUse = options.isInUse;
    this.now = options.now || Date.now;
    this.randomBytes = options.randomBytes || crypto.randomBytes;
    this.fs = options.fs || fs;
    this.scanLimits = options.scanLimits || {};
    this.planTtlMs = options.planTtlMs ?? DEFAULT_CLEANUP_PLAN_TTL_MS;
    if (typeof this.now !== "function" || typeof this.randomBytes !== "function"
      || !Number.isSafeInteger(this.planTtlMs) || this.planTtlMs <= 0
      || this.planTtlMs > 60 * 60 * 1_000) {
      throw cleanupError("RUNTIME_STORAGE_CLEANUP_OPTIONS_INVALID", "RuntimeStorageCleanup 时钟或 TTL 无效");
    }
    this.plans = new Map();
  }

  #timestamp() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw cleanupError("RUNTIME_STORAGE_CLEANUP_OPTIONS_INVALID", "清理时钟返回值无效");
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
        throw cleanupError(
          "RUNTIME_STORAGE_CLEANUP_OPTIONS_INVALID",
          "清理随机数生成器返回值无效",
        );
      }
      const planId = bytes.toString("hex");
      if (!this.plans.has(planId)) return planId;
    }
    throw cleanupError("RUNTIME_STORAGE_PLAN_ID_FAILED", "无法分配 cleanup plan ID");
  }

  async #assertCleanupReady() {
    const state = await this.readCleanupState();
    if (!state || typeof state !== "object" || Array.isArray(state)
      || typeof state.serviceReady !== "boolean"
      || typeof state.cleanupEligible !== "boolean") {
      throw cleanupError("RUNTIME_STORAGE_CLEANUP_STATE_INVALID", "legacy Home 清理门禁状态无效");
    }
    if (!state.serviceReady || !state.cleanupEligible) {
      throw cleanupError(
        "RUNTIME_STORAGE_CLEANUP_NOT_READY",
        "Service 尚未 ready 或 RuntimeAccount migration 尚未 cleanup eligible",
      );
    }
  }

  async #freshCandidate(entryId) {
    const manifest = await this.inventory();
    if (!manifest || !Array.isArray(manifest.entries)) {
      throw cleanupError("RUNTIME_STORAGE_INVENTORY_INVALID", "legacy Home inventory 无效");
    }
    const entry = manifest.entries.find((candidate) => candidate?.id === entryId);
    if (!entry || entry.role !== "reclaimable") {
      throw cleanupError(
        "RUNTIME_STORAGE_CANDIDATE_NOT_RECLAIMABLE",
        "legacy Home 已不存在或不再可回收",
      );
    }
    return entry;
  }

  async #assertNotInUse(entry) {
    const reasons = inUseResult(await this.isInUse(Object.freeze({
      id: entry.id,
      runtime: entry.runtime,
      runtimeProfileId: entry.runtimeProfileId,
      runtimeAccountId: entry.runtimeAccountId,
      profileIds: Object.freeze([...(entry.profileIds || [])]),
    })));
    if (reasons) {
      const error = cleanupError(
        "RUNTIME_STORAGE_CANDIDATE_IN_USE",
        "legacy Home 仍有持久会话引用或被 active run、host、login 使用",
      );
      error.reasons = reasons;
      throw error;
    }
  }

  #scan(entry) {
    assertLegacyTarget(entry, this.paths.stateDir, { fs: this.fs });
    return inspectRuntimeStorage(entry.path, {
      ...this.scanLimits,
      fs: this.fs,
      trustedRoot: path.resolve(this.paths.stateDir),
    });
  }

  #readAuditRecords() {
    ensurePrivateDirectoryTree(
      path.dirname(this.paths.runtimeCleanupAuditPath),
      this.paths.trustedRoot,
    );
    if (!lstatIfExists(this.paths.runtimeCleanupAuditPath)) return [];
    const text = readPrivateFile(this.paths.runtimeCleanupAuditPath, {
      fs: this.fs,
      maxBytes: MAX_AUDIT_BYTES,
    }).toString("utf8");
    const lines = text.split("\n").filter(Boolean);
    try {
      return lines.map((line) => JSON.parse(line));
    } catch {
      throw cleanupError("RUNTIME_STORAGE_AUDIT_CORRUPT", "runtime cleanup audit 已损坏");
    }
  }

  #appendAudit(record) {
    let records = this.#readAuditRecords();
    records = records.slice(-(MAX_AUDIT_RECORDS - 1));
    records.push(record);
    atomicWritePrivateFile(
      this.paths.runtimeCleanupAuditPath,
      records.map(auditRecord).join(""),
      { fs: this.fs, trustedRoot: this.paths.trustedRoot },
    );
  }

  async prepare(input) {
    const entryId = exactInput(input, "entryId", "RUNTIME_STORAGE_PREPARE_INVALID");
    if (typeof entryId !== "string" || !ENTRY_ID_PATTERN.test(entryId)) {
      throw cleanupError("RUNTIME_STORAGE_PREPARE_INVALID", "cleanup entryId 无效");
    }
    const now = this.#timestamp();
    this.#purgeExpired(now);
    if (this.plans.size >= MAX_CLEANUP_PLANS) {
      throw cleanupError("RUNTIME_STORAGE_PLAN_LIMIT", "未完成的 cleanup plan 过多");
    }
    await this.#assertCleanupReady();
    const entry = await this.#freshCandidate(entryId);
    const stats = this.#scan(entry);
    if (stats.incomplete) {
      throw cleanupError("RUNTIME_STORAGE_SCAN_INCOMPLETE", "legacy Home 容量扫描未完成");
    }
    await this.#assertNotInUse(entry);

    const planId = this.#allocatePlanId();
    const expiresAt = now + this.planTtlMs;
    const plan = Object.freeze({
      planId,
      entryId,
      runtime: entry.runtime,
      runtimeProfileId: entry.runtimeProfileId,
      runtimeAccountId: entry.runtimeAccountId,
      path: entry.path,
      identity: snapshotIdentity(stats.identity),
      stats: Object.freeze({
        bytes: stats.bytes,
        files: stats.files,
        dirs: stats.dirs,
        symlinks: stats.symlinks,
      }),
      preparedAt: now,
      expiresAt,
    });
    this.plans.set(planId, plan);
    return Object.freeze({
      planId,
      entryId,
      runtime: entry.runtime,
      runtimeAccountId: entry.runtimeAccountId,
      affectedAgentCount: entry.profileIds.length,
      bytes: stats.bytes,
      files: stats.files,
      dirs: stats.dirs,
      symlinks: stats.symlinks,
      expiresAt,
    });
  }

  close() {
    this.plans.clear();
  }

  async commit(input) {
    const planId = exactInput(input, "planId", "RUNTIME_STORAGE_COMMIT_INVALID");
    if (typeof planId !== "string" || !PLAN_ID_PATTERN.test(planId)) {
      throw cleanupError("RUNTIME_STORAGE_COMMIT_INVALID", "cleanup planId 无效");
    }
    const now = this.#timestamp();
    const plan = this.plans.get(planId);
    this.plans.delete(planId);
    if (!plan) throw cleanupError("RUNTIME_STORAGE_PLAN_NOT_FOUND", "cleanup plan 不存在");
    if (plan.expiresAt <= now) {
      throw cleanupError("RUNTIME_STORAGE_PLAN_EXPIRED", "cleanup plan 已过期");
    }

    await this.#assertCleanupReady();
    const entry = await this.#freshCandidate(plan.entryId);
    if (entry.runtime !== plan.runtime || entry.runtimeProfileId !== plan.runtimeProfileId
      || entry.runtimeAccountId !== plan.runtimeAccountId || entry.path !== plan.path) {
      throw cleanupError("RUNTIME_STORAGE_CANDIDATE_CHANGED", "legacy Home 候选绑定已变化");
    }
    const scanned = this.#scan(entry);
    if (scanned.incomplete) {
      throw cleanupError("RUNTIME_STORAGE_SCAN_INCOMPLETE", "legacy Home 容量扫描未完成");
    }
    if (!sameIdentity(plan.identity, scanned.identity)
      || plan.identity.uid !== scanned.identity.uid
      || plan.identity.mtimeMs !== scanned.identity.mtimeMs
      || !sameStorageStats(plan.stats, scanned)) {
      throw cleanupError(
        "RUNTIME_STORAGE_CANDIDATE_CHANGED",
        "legacy Home inode、owner、mtime 或容量已变化",
      );
    }
    await this.#assertNotInUse(entry);
    const finalIdentity = assertLegacyTarget(entry, this.paths.stateDir, { fs: this.fs });
    if (!sameIdentity(plan.identity, finalIdentity)
      || plan.identity.uid !== finalIdentity.uid
      || plan.identity.mtimeMs !== finalIdentity.mtimeMs) {
      throw cleanupError(
        "RUNTIME_STORAGE_CANDIDATE_CHANGED",
        "legacy Home 最终 inode、owner 或 mtime 已变化",
      );
    }

    const stagingRoot = path.join(this.paths.legacyRuntimeHomesDir, "staging");
    ensurePrivateDirectoryTree(stagingRoot, this.paths.trustedRoot);
    // Refuse the destructive rename if an existing audit cannot be read safely.
    this.#readAuditRecords();
    const stagedPath = path.join(stagingRoot, `.cleanup-${planId}`);
    if (lstatIfExists(stagedPath)) {
      throw cleanupError("RUNTIME_STORAGE_STAGING_CONFLICT", "cleanup staging 已存在");
    }
    this.fs.renameSync(plan.path, stagedPath);

    let staged;
    try {
      staged = this.fs.lstatSync(stagedPath);
    } catch {
      throw cleanupError("RUNTIME_STORAGE_RENAME_UNCERTAIN", "legacy Home rename 后状态不确定");
    }
    if (staged.isSymbolicLink() || !staged.isDirectory()
      || !sameIdentity(plan.identity, staged)
      || (typeof process.getuid === "function" && staged.uid !== process.getuid())) {
      const error = cleanupError(
        "RUNTIME_STORAGE_RENAME_IDENTITY_MISMATCH",
        "legacy Home rename 后 identity 不匹配，已保留 staging 证据",
      );
      error.cleanupStaged = true;
      try {
        this.#appendAudit({
          version: 1,
          status: "identity-mismatch",
          entryId: plan.entryId,
          runtime: plan.runtime,
          runtimeAccountId: plan.runtimeAccountId,
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
        "RUNTIME_STORAGE_DELETE_FAILED",
        "legacy Home 已移入私有 staging，但递归删除失败",
      );
      error.cause = cause;
      error.cleanupStaged = true;
      try {
        this.#appendAudit({
          version: 1,
          status: "delete-failed",
          entryId: plan.entryId,
          runtime: plan.runtime,
          runtimeAccountId: plan.runtimeAccountId,
          planDigest: crypto.createHash("sha256").update(planId).digest("hex"),
          occurredAt: now,
        });
      } catch {}
      throw error;
    }

    const result = Object.freeze({
      entryId: plan.entryId,
      runtime: plan.runtime,
      runtimeAccountId: plan.runtimeAccountId,
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
        "RUNTIME_STORAGE_CLEANUP_COMMITTED_AUDIT_FAILED",
        "legacy Home 已删除，但 cleanup audit 写入失败",
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
        "RUNTIME_STORAGE_CLEANUP_COMMITTED_REFRESH_FAILED",
        "legacy Home 已删除，但 inventory 刷新失败",
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
  DEFAULT_CLEANUP_PLAN_TTL_MS,
  RuntimeStorageCleanup,
  assertLegacyRuntimeCleanupTarget: assertLegacyTarget,
};
