"use strict";

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  preparePrivateParent,
  statIfExists,
  validateDirectoryStat,
  writeFully,
} = require("./private-file");
const { serviceError } = require("./security");

const WRITER_LEASE_VERSION = 1;
const MAX_WRITER_LEASE_BYTES = 4096;
const LEASE_FIELDS = Object.freeze([
  "version", "pid", "startIdentity", "nonce", "candidateBasename", "createdAt",
]);

function leaseError(code, message) {
  return serviceError(code, message);
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function sameFile(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function defaultProcessIdentity(pid) {
  try {
    return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 500,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function defaultProcessIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function candidatePattern(lockBasename) {
  return new RegExp(`^${escapeRegex(lockBasename)}\\.candidate-([1-9][0-9]*)-([a-f0-9]{64})$`, "u");
}

function releaseQuarantineBasename(record) {
  return `.quarantine-release-${record.candidateBasename}`;
}

function validateLeaseRecord(value, lockBasename) {
  const candidate = typeof value?.candidateBasename === "string" && lockBasename
    ? candidatePattern(lockBasename).exec(value.candidateBasename)
    : null;
  if (!exactObject(value, LEASE_FIELDS) || value.version !== WRITER_LEASE_VERSION
    || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || typeof value.startIdentity !== "string" || value.startIdentity.length === 0
    || value.startIdentity.length > 256 || value.startIdentity.includes("\0")
    || typeof value.nonce !== "string" || !/^[a-f0-9]{64}$/u.test(value.nonce)
    || !candidate || Number(candidate[1]) !== value.pid || candidate[2] !== value.nonce
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) {
    throw leaseError("WRITER_LEASE_CORRUPT", "writer lease 记录损坏");
  }
  return Object.fromEntries(LEASE_FIELDS.map((field) => [field, value[field]]));
}

function validateLeaseStat(stat, target, allowedLinks = [1, 2]) {
  if (stat?.isSymbolicLink?.()) throw leaseError("UNSAFE_SYMLINK", `拒绝符号链接 lease: ${target}`);
  if (!stat?.isFile?.()) throw leaseError("UNSAFE_PATH", `lease 不是普通文件: ${target}`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw leaseError("UNSAFE_OWNER", `lease 不属于当前用户: ${target}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw leaseError("UNSAFE_PERMISSIONS", `lease 权限过宽: ${target}`);
  }
  if (!allowedLinks.includes(stat.nlink)) {
    throw leaseError("UNSAFE_HARDLINK", `lease hardlink 数量无效: ${target}`);
  }
  return stat;
}

function fsyncParent(parent, fileSystem) {
  const noFollow = fileSystem.constants.O_NOFOLLOW || 0;
  const fd = fileSystem.openSync(parent, fileSystem.constants.O_RDONLY | noFollow);
  try {
    validateDirectoryStat(fileSystem.fstatSync(fd), parent);
    fileSystem.fsyncSync(fd);
  } finally {
    fileSystem.closeSync(fd);
  }
}

function readLeasePath(target, lockBasename, fileSystem, allowedLinks = [1, 2]) {
  const before = validateLeaseStat(fileSystem.lstatSync(target), target, allowedLinks);
  const noFollow = fileSystem.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = fileSystem.openSync(target, fileSystem.constants.O_RDONLY | noFollow);
    const opened = validateLeaseStat(fileSystem.fstatSync(fd), target, allowedLinks);
    if (!sameFile(before, opened)) {
      throw leaseError("WRITER_LEASE_CHANGED", "writer lease 在打开期间变化");
    }
    if (!Number.isSafeInteger(opened.size) || opened.size < 1
      || opened.size > MAX_WRITER_LEASE_BYTES) {
      throw leaseError("WRITER_LEASE_CORRUPT", "writer lease 记录损坏");
    }
    const bytes = fileSystem.readFileSync(fd);
    let record;
    try {
      record = validateLeaseRecord(JSON.parse(bytes.toString("utf8")), lockBasename);
    } catch (error) {
      if (error?.code === "WRITER_LEASE_CORRUPT") throw error;
      throw leaseError("WRITER_LEASE_CORRUPT", "writer lease 记录损坏");
    }
    const after = validateLeaseStat(fileSystem.lstatSync(target), target, allowedLinks);
    if (!sameFile(opened, after)) {
      throw leaseError("WRITER_LEASE_CHANGED", "writer lease 在读取期间变化");
    }
    return { record, bytes, identity: after };
  } finally {
    if (fd !== undefined) fileSystem.closeSync(fd);
  }
}

function uniqueEvidencePath(parent, lockBasename, kind, pid, randomBytes, fileSystem) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = path.join(
      parent,
      `${lockBasename}.${kind}-${pid}-${randomBytes(32).toString("hex")}`,
    );
    if (!statIfExists(fileSystem, result)) return result;
  }
  throw leaseError("WRITER_LEASE_RECOVERY_FAILED", "无法分配 writer lease 隔离路径");
}

function restoreQuarantinedReplacement(quarantinePath, target, identity, fileSystem) {
  try {
    fileSystem.linkSync(quarantinePath, target);
    const restored = validateLeaseStat(fileSystem.lstatSync(target), target, [2]);
    if (!sameFile(restored, identity)) {
      throw leaseError("WRITER_LEASE_RECOVERY_RACE", "writer lease replacement 恢复校验失败");
    }
    fileSystem.unlinkSync(quarantinePath);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

// 删除前先隔离并核对 inode；若路径在 rename 前被替换，绝不删除替换物。
function quarantineObservedPath(target, observed, context) {
  const {
    parent, lockBasename, pid, randomBytes, fileSystem, kind,
  } = context;
  const quarantinePath = uniqueEvidencePath(
    parent, lockBasename, `quarantine-${kind}`, pid, randomBytes, fileSystem,
  );
  fileSystem.renameSync(target, quarantinePath);
  const quarantined = validateLeaseStat(fileSystem.lstatSync(quarantinePath), quarantinePath, [1, 2]);
  if (!sameFile(quarantined, observed)) {
    const restored = restoreQuarantinedReplacement(
      quarantinePath, target, quarantined, fileSystem,
    );
    const error = leaseError(
      "WRITER_LEASE_RECOVERY_RACE",
      restored
        ? "writer lease replacement 已恢复，拒绝继续"
        : "writer lease replacement 已隔离保存，拒绝继续",
    );
    error.replacementRestored = restored;
    throw error;
  }
  return { quarantinePath, identity: quarantined };
}

function ownerIsActive(record, processIsAlive, getProcessIdentity) {
  if (!processIsAlive(record.pid)) return false;
  const currentIdentity = getProcessIdentity(record.pid);
  if (typeof currentIdentity !== "string" || currentIdentity.length === 0) {
    throw leaseError("WRITER_LEASE_INDETERMINATE", "活跃 writer 身份无法确认，拒绝夺锁");
  }
  return currentIdentity === record.startIdentity;
}

function acquirePrivateWriterLease(options = {}) {
  const lockPath = options.lockPath;
  const trustedRoot = options.trustedRoot;
  if (typeof lockPath !== "string" || typeof trustedRoot !== "string"
    || path.dirname(lockPath) === lockPath) {
    throw leaseError("WRITER_LEASE_PATH_REQUIRED", "writer lease 路径无效");
  }
  const fileSystem = options.fs || fs;
  const pid = options.pid ?? process.pid;
  const getProcessIdentity = options.getProcessIdentity || defaultProcessIdentity;
  const processIsAlive = options.processIsAlive || defaultProcessIsAlive;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const now = options.now || Date.now;
  const parent = preparePrivateParent(lockPath, trustedRoot, fileSystem);
  const lockBasename = path.basename(lockPath);
  const pattern = candidatePattern(lockBasename);
  const startIdentity = getProcessIdentity(pid);
  if (typeof startIdentity !== "string" || startIdentity.length === 0
    || startIdentity.length > 256 || startIdentity.includes("\0")) {
    throw leaseError("WRITER_LEASE_IDENTITY_UNAVAILABLE", "无法确认 writer 进程启动身份");
  }
  const context = { parent, lockBasename, pid, randomBytes, fileSystem };

  function removeQuarantined(target, observed, kind) {
    const moved = quarantineObservedPath(target, observed, { ...context, kind });
    try {
      fileSystem.unlinkSync(moved.quarantinePath);
      fsyncParent(parent, fileSystem);
    } catch (error) {
      error.quarantinePath = moved.quarantinePath;
      error.quarantineIdentity = moved.identity;
      throw error;
    }
  }

  function validateCandidateForRecord(record, expectedIdentity = null) {
    const candidatePath = path.join(parent, record.candidateBasename);
    const candidate = readLeasePath(candidatePath, lockBasename, fileSystem, [1, 2]);
    if (candidate.record.candidateBasename !== record.candidateBasename
      || !candidate.bytes.equals(Buffer.from(`${JSON.stringify(record)}\n`, "utf8"))
      || (expectedIdentity && !sameFile(candidate.identity, expectedIdentity))) {
      throw leaseError("WRITER_LEASE_CORRUPT", "writer lease candidate 不匹配");
    }
    return { ...candidate, path: candidatePath };
  }

  function validateReleaseEvidenceForRecord(record, expectedIdentity = null) {
    const evidencePath = path.join(parent, releaseQuarantineBasename(record));
    const evidence = readLeasePath(evidencePath, lockBasename, fileSystem, [1, 2]);
    if (evidence.record.candidateBasename !== record.candidateBasename
      || !evidence.bytes.equals(Buffer.from(`${JSON.stringify(record)}\n`, "utf8"))
      || (expectedIdentity && !sameFile(evidence.identity, expectedIdentity))) {
      throw leaseError("WRITER_LEASE_CORRUPT", "writer lease release evidence 不匹配");
    }
    return { ...evidence, path: evidencePath };
  }

  function inspectFixed() {
    const topology = validateLeaseStat(fileSystem.lstatSync(lockPath), lockPath, [1, 2]);
    if (topology.nlink === 2) {
      const releasePrefix = `.quarantine-release-${lockBasename}.candidate-`;
      const matching = fileSystem.readdirSync(parent)
        .filter((name) => pattern.test(name) || name.startsWith(releasePrefix))
        .map((name) => fileSystem.lstatSync(path.join(parent, name)))
        .filter((stat) => sameFile(stat, topology));
      if (matching.length !== 1) {
        throw leaseError("UNSAFE_HARDLINK", "writer lease hardlink 不属于唯一自有证据");
      }
    }
    const existing = readLeasePath(lockPath, lockBasename, fileSystem, [1, 2]);
    const candidatePath = path.join(parent, existing.record.candidateBasename);
    const releasePath = path.join(parent, releaseQuarantineBasename(existing.record));
    const candidateStat = statIfExists(fileSystem, candidatePath);
    const releaseStat = statIfExists(fileSystem, releasePath);
    if (candidateStat && releaseStat) {
      throw leaseError("WRITER_LEASE_CORRUPT", "writer lease 同时存在 candidate 与 release evidence");
    }
    let companion = null;
    if (candidateStat) companion = validateCandidateForRecord(existing.record, existing.identity);
    if (releaseStat) companion = validateReleaseEvidenceForRecord(existing.record, existing.identity);
    if (existing.identity.nlink === 2) {
      if (!companion || companion.identity.nlink !== 2) {
        throw leaseError("UNSAFE_HARDLINK", "writer lease 缺少自有 candidate/release evidence");
      }
    } else if (companion) {
      throw leaseError("WRITER_LEASE_CORRUPT", "writer lease release topology 无效");
    }
    return { ...existing, companion };
  }

  function recoverStaleFixed(existing) {
    const confirm = inspectFixed();
    if (!sameFile(existing.identity, confirm.identity) || !existing.bytes.equals(confirm.bytes)) {
      throw leaseError("WRITER_LEASE_CHANGED", "writer lease 在回收前变化");
    }
    const fixedMoved = quarantineObservedPath(lockPath, confirm.identity, {
      ...context, kind: "fixed",
    });
    try {
      const companionPath = confirm.companion?.path || null;
      const companionStat = companionPath ? statIfExists(fileSystem, companionPath) : null;
      if (companionStat) {
        validateLeaseStat(companionStat, companionPath, [1, 2]);
        if (!sameFile(companionStat, confirm.identity)) {
          throw leaseError("WRITER_LEASE_RECOVERY_RACE", "writer lease candidate 已被替换");
        }
        const candidateMoved = quarantineObservedPath(companionPath, companionStat, {
          ...context, kind: "candidate",
        });
        fileSystem.unlinkSync(candidateMoved.quarantinePath);
      } else if (confirm.identity.nlink === 2) {
        throw leaseError("WRITER_LEASE_RECOVERY_RACE", "writer lease candidate 在回收时丢失");
      }
      fileSystem.unlinkSync(fixedMoved.quarantinePath);
      fsyncParent(parent, fileSystem);
    } catch (error) {
      try {
        if (!statIfExists(fileSystem, lockPath)
          && statIfExists(fileSystem, fixedMoved.quarantinePath)) {
          restoreQuarantinedReplacement(
            fixedMoved.quarantinePath, lockPath, fixedMoved.identity, fileSystem,
          );
        }
      } catch {}
      throw error;
    }
  }

  function cleanupOrphanCandidates() {
    const names = fileSystem.readdirSync(parent).filter((name) => pattern.test(name));
    for (const name of names) {
      const candidatePath = path.join(parent, name);
      const candidate = readLeasePath(candidatePath, lockBasename, fileSystem, [1, 2]);
      if (candidate.record.candidateBasename !== name) {
        throw leaseError("WRITER_LEASE_CORRUPT", "writer lease candidate 名称不匹配");
      }
      const fixed = statIfExists(fileSystem, lockPath);
      if (fixed) {
        if (sameFile(fixed, candidate.identity)) continue;
        throw leaseError("WRITER_LEASE_RECOVERY_RACE", "writer lease candidate 与 fixed 不匹配");
      }
      if (candidate.identity.nlink !== 1) {
        throw leaseError("UNSAFE_HARDLINK", "孤立 writer lease candidate link 数量无效");
      }
      if (!ownerIsActive(candidate.record, processIsAlive, getProcessIdentity)) {
        removeQuarantined(candidatePath, candidate.identity, "orphan");
      }
    }
  }

  function cleanupInterruptedReleaseEvidence() {
    const prefix = `.quarantine-release-${lockBasename}.candidate-`;
    const names = fileSystem.readdirSync(parent).filter((name) => name.startsWith(prefix));
    for (const name of names) {
      const evidencePath = path.join(parent, name);
      const evidence = readLeasePath(evidencePath, lockBasename, fileSystem, [1, 2]);
      if (name !== releaseQuarantineBasename(evidence.record)) {
        throw leaseError("WRITER_LEASE_CORRUPT", "writer lease release evidence 名称无效");
      }
      const fixed = statIfExists(fileSystem, lockPath);
      if (fixed) {
        if (!sameFile(fixed, evidence.identity)) {
          throw leaseError("WRITER_LEASE_RECOVERY_RACE", "writer lease release evidence 与 fixed 不匹配");
        }
        continue;
      }
      if (evidence.identity.nlink !== 1) {
        throw leaseError("UNSAFE_HARDLINK", "孤立 writer lease release evidence link 数量无效");
      }
      if (ownerIsActive(evidence.record, processIsAlive, getProcessIdentity)) {
        throw leaseError("WRITER_LEASE_HELD", `writer release cleanup 仍活跃 (pid ${evidence.record.pid})`);
      }
      removeQuarantined(evidencePath, evidence.identity, "orphan-release");
    }
  }

  cleanupOrphanCandidates();
  cleanupInterruptedReleaseEvidence();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const fixedStat = statIfExists(fileSystem, lockPath);
    if (fixedStat) {
      const existing = inspectFixed();
      if (ownerIsActive(existing.record, processIsAlive, getProcessIdentity)) {
        throw leaseError("WRITER_LEASE_HELD", `writer lease 已持有 (pid ${existing.record.pid})`);
      }
      recoverStaleFixed(existing);
      continue;
    }

    const nonce = randomBytes(32).toString("hex");
    const candidateBasename = `${lockBasename}.candidate-${pid}-${nonce}`;
    const candidatePath = path.join(parent, candidateBasename);
    const ownRecord = validateLeaseRecord({
      version: WRITER_LEASE_VERSION,
      pid,
      startIdentity,
      nonce,
      candidateBasename,
      createdAt: now(),
    }, lockBasename);
    const serialized = `${JSON.stringify(ownRecord)}\n`;
    const noFollow = fileSystem.constants.O_NOFOLLOW || 0;
    let fd;
    let ownIdentity = null;
    let claimed = false;
    try {
      fd = fileSystem.openSync(
        candidatePath,
        fileSystem.constants.O_CREAT | fileSystem.constants.O_EXCL
          | fileSystem.constants.O_WRONLY | noFollow,
        0o600,
      );
      fileSystem.fchmodSync(fd, 0o600);
      ownIdentity = validateLeaseStat(fileSystem.fstatSync(fd), candidatePath, [1]);
      writeFully(fileSystem, fd, serialized, "WRITER_LEASE_WRITE_FAILED");
      fileSystem.fsyncSync(fd);
      fileSystem.closeSync(fd);
      fd = undefined;
      const ready = validateLeaseStat(fileSystem.lstatSync(candidatePath), candidatePath, [1]);
      if (!sameFile(ready, ownIdentity)) {
        throw leaseError("WRITER_LEASE_CHANGED", "writer lease candidate 在 claim 前变化");
      }
      fsyncParent(parent, fileSystem);
      try {
        fileSystem.linkSync(candidatePath, lockPath);
      } catch (error) {
        if (error?.code === "EEXIST") {
          removeQuarantined(candidatePath, ready, "loser");
          throw leaseError("WRITER_LEASE_HELD", "writer lease 已由其他进程取得");
        }
        throw error;
      }
      claimed = true;
      const fixed = validateLeaseStat(fileSystem.lstatSync(lockPath), lockPath, [2]);
      const linkedCandidate = validateLeaseStat(fileSystem.lstatSync(candidatePath), candidatePath, [2]);
      if (!sameFile(fixed, ownIdentity) || !sameFile(linkedCandidate, ownIdentity)) {
        throw leaseError("WRITER_LEASE_CHANGED", "writer lease claim identity 无效");
      }
      fsyncParent(parent, fileSystem);

      let released = false;
      let pendingCandidateQuarantine = null;
      let pendingFixedQuarantine = null;
      const releaseEvidencePath = path.join(parent, releaseQuarantineBasename(ownRecord));
      return Object.freeze({
        lockPath,
        candidatePath,
        record: Object.freeze({ ...ownRecord }),
        release() {
          if (released) return false;
          const retryQuarantine = (pending) => {
            if (!pending) return null;
            const current = statIfExists(fileSystem, pending.path);
            if (current) {
              validateLeaseStat(current, pending.path, [1, 2]);
              if (!sameFile(current, pending.identity)) {
                throw leaseError("WRITER_LEASE_REPLACED", "writer lease 隔离证据已被替换");
              }
              fileSystem.unlinkSync(pending.path);
              fsyncParent(parent, fileSystem);
            }
            return null;
          };
          pendingCandidateQuarantine = retryQuarantine(pendingCandidateQuarantine);
          pendingFixedQuarantine = retryQuarantine(pendingFixedQuarantine);
          const candidateCurrent = statIfExists(fileSystem, candidatePath);
          if (candidateCurrent && sameFile(candidateCurrent, ownIdentity)) {
            validateLeaseStat(candidateCurrent, candidatePath, [1, 2]);
            if (statIfExists(fileSystem, releaseEvidencePath)) {
              throw leaseError("WRITER_LEASE_CORRUPT", "writer lease release evidence 已存在");
            }
            try {
              fileSystem.renameSync(candidatePath, releaseEvidencePath);
              const evidence = validateReleaseEvidenceForRecord(ownRecord, ownIdentity);
              if (evidence.identity.nlink !== 2) {
                throw leaseError("WRITER_LEASE_REPLACED", "writer lease release evidence topology 无效");
              }
              fileSystem.unlinkSync(releaseEvidencePath);
              fsyncParent(parent, fileSystem);
            } catch (error) {
              const evidence = statIfExists(fileSystem, releaseEvidencePath);
              if (evidence && sameFile(evidence, ownIdentity)) {
                pendingCandidateQuarantine = {
                  path: releaseEvidencePath,
                  identity: evidence,
                };
              }
              throw error;
            }
          } else if (candidateCurrent) {
            validateLeaseStat(candidateCurrent, candidatePath, [1, 2]);
            throw leaseError("WRITER_LEASE_REPLACED", "writer lease candidate 已被替换");
          }

          const fixedCurrent = statIfExists(fileSystem, lockPath);
          if (!fixedCurrent || !sameFile(fixedCurrent, ownIdentity)) {
            if (fixedCurrent) validateLeaseStat(fixedCurrent, lockPath, [1, 2]);
            fsyncParent(parent, fileSystem);
            released = true;
            return true;
          }
          validateLeaseStat(fixedCurrent, lockPath, [1, 2]);
          try {
            removeQuarantined(lockPath, fixedCurrent, "release-fixed");
          } catch (error) {
            if (error?.code === "WRITER_LEASE_RECOVERY_RACE") {
              released = true;
              return true;
            }
            if (error.quarantinePath) {
              pendingFixedQuarantine = {
                path: error.quarantinePath,
                identity: error.quarantineIdentity,
              };
            }
            throw error;
          }
          released = true;
          return true;
        },
      });
    } catch (error) {
      if (fd !== undefined) {
        try { fileSystem.closeSync(fd); } catch {}
      }
      if (!claimed && ownIdentity) {
        try {
          const current = statIfExists(fileSystem, candidatePath);
          if (current && sameFile(current, ownIdentity)) {
            removeQuarantined(candidatePath, current, "failed-candidate");
          }
        } catch {}
      }
      throw error;
    }
  }
  throw leaseError("WRITER_LEASE_ACQUIRE_FAILED", "无法取得 writer lease");
}

module.exports = {
  MAX_WRITER_LEASE_BYTES,
  WRITER_LEASE_VERSION,
  acquirePrivateWriterLease,
  defaultProcessIdentity,
  defaultProcessIsAlive,
  validateLeaseRecord,
};
