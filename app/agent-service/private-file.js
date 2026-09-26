"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  ensurePrivateDirectoryTree,
  lstatIfExists,
  serviceError,
  validatePrivateFileStat,
} = require("./security");

function writeFully(fileSystem, fd, value, code = "PRIVATE_FILE_WRITE_FAILED") {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = fileSystem.writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw serviceError(code, "私有文件写入未取得进展");
    }
    offset += written;
  }
}

function statIfExists(fileSystem, target) {
  if (fileSystem === fs) return lstatIfExists(target);
  try {
    return fileSystem.lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function validateDirectoryStat(stat, target) {
  if (stat?.isSymbolicLink?.()) throw serviceError("UNSAFE_SYMLINK", `拒绝符号链接目录: ${target}`);
  if (!stat?.isDirectory?.()) throw serviceError("UNSAFE_PATH", `路径不是目录: ${target}`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw serviceError("UNSAFE_OWNER", `目录不属于当前用户: ${target}`);
  }
  if ((stat.mode & 0o077) !== 0) throw serviceError("UNSAFE_PERMISSIONS", `目录权限过宽: ${target}`);
  return stat;
}

function validatePrivateStat(stat, target) {
  if (stat?.isSymbolicLink?.()) throw serviceError("UNSAFE_SYMLINK", `拒绝符号链接文件: ${target}`);
  return validatePrivateFileStat(stat, target);
}

function preparePrivateParent(target, trustedRoot, fileSystem = fs) {
  const parent = path.dirname(target);
  ensurePrivateDirectoryTree(parent, trustedRoot);
  validateDirectoryStat(fileSystem.lstatSync(parent), parent);
  return parent;
}

function openExistingPrivateFile(target, flags, fileSystem = fs) {
  const before = validatePrivateStat(fileSystem.lstatSync(target), target);
  const noFollow = fileSystem.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = fileSystem.openSync(target, flags | noFollow);
    const opened = validatePrivateStat(fileSystem.fstatSync(fd), target);
    if (before.dev !== opened.dev || before.ino !== opened.ino) {
      throw serviceError("UNSAFE_PATH", `私有文件 inode 在打开时变化: ${target}`);
    }
    return fd;
  } catch (error) {
    if (fd !== undefined) fileSystem.closeSync(fd);
    if (error?.code === "ELOOP") throw serviceError("UNSAFE_SYMLINK", `拒绝符号链接文件: ${target}`);
    throw error;
  }
}

function readPrivateFile(target, options = {}) {
  const fileSystem = options.fs || fs;
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const fd = openExistingPrivateFile(target, fileSystem.constants.O_RDONLY, fileSystem);
  try {
    const stat = validatePrivateStat(fileSystem.fstatSync(fd), target);
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) {
      throw serviceError("PRIVATE_FILE_TOO_LARGE", "私有文件超过容量限制");
    }
    return fileSystem.readFileSync(fd);
  } finally {
    fileSystem.closeSync(fd);
  }
}

function fsyncPrivateParent(parent, fileSystem = fs) {
  const noFollow = fileSystem.constants.O_NOFOLLOW || 0;
  const dirFd = fileSystem.openSync(parent, fileSystem.constants.O_RDONLY | noFollow);
  try {
    validateDirectoryStat(fileSystem.fstatSync(dirFd), parent);
    fileSystem.fsyncSync(dirFd);
  } finally {
    fileSystem.closeSync(dirFd);
  }
}

function recoverInterruptedPrivateFile(target, options = {}) {
  const fileSystem = options.fs || fs;
  const parent = preparePrivateParent(target, options.trustedRoot, fileSystem);
  const basename = path.basename(target);
  const prefix = `${basename}.backup-`;
  const names = fileSystem.readdirSync(parent).filter((name) => name.startsWith(prefix));
  const pattern = new RegExp(`^${basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.backup-[1-9][0-9]*-[a-f0-9]{16}$`);
  if (names.length > 1 || (names.length === 1 && !pattern.test(names[0]))) {
    throw serviceError("PRIVATE_FILE_RECOVERY_AMBIGUOUS", "私有文件 backup 恢复证据不唯一");
  }
  const tempPath = `${target}.tmp`;
  const tempStat = statIfExists(fileSystem, tempPath);
  if (names.length === 0) {
    if (!tempStat) return "none";
    // 固定 temp 从未成为公开 target；只有私有单 link 普通文件才可判定为未提交事务。
    validatePrivateStat(tempStat, tempPath);
    fileSystem.unlinkSync(tempPath);
    fsyncPrivateParent(parent, fileSystem);
    return "discarded";
  }
  const backupPath = path.join(parent, names[0]);
  const targetStat = statIfExists(fileSystem, target);
  const backupStat = statIfExists(fileSystem, backupPath);
  const safeRecoveryStat = (stat) => stat && !stat.isSymbolicLink?.() && stat.isFile?.()
    && (typeof process.getuid !== "function" || stat.uid === process.getuid())
    && (stat.mode & 0o077) === 0;
  if (!safeRecoveryStat(targetStat) || !safeRecoveryStat(backupStat)) {
    throw serviceError("PRIVATE_FILE_RECOVERY_UNSAFE", "私有文件 backup 恢复证据不安全");
  }
  if (targetStat.dev !== backupStat.dev || targetStat.ino !== backupStat.ino
    || targetStat.nlink !== 2 || backupStat.nlink !== 2) {
    return "uncertain";
  }
  if (tempStat) validatePrivateStat(tempStat, tempPath);
  fileSystem.unlinkSync(backupPath);
  if (tempStat) fileSystem.unlinkSync(tempPath);
  const restored = validatePrivateStat(fileSystem.lstatSync(target), target);
  if (restored.dev !== targetStat.dev || restored.ino !== targetStat.ino) {
    throw serviceError("PRIVATE_FILE_RECOVERY_UNSAFE", "私有文件 recovery 后 identity 变化");
  }
  fsyncPrivateParent(parent, fileSystem);
  return "recovered";
}

function atomicWritePrivateFile(target, value, options = {}) {
  const fileSystem = options.fs || fs;
  const trustedRoot = options.trustedRoot;
  const tempPath = options.tempPath || `${target}.tmp`;
  const parent = preparePrivateParent(target, trustedRoot, fileSystem);
  const recovery = recoverInterruptedPrivateFile(target, { fs: fileSystem, trustedRoot });
  if (recovery === "uncertain") {
    const uncertain = serviceError(
      "PRIVATE_FILE_COMMIT_UNCERTAIN",
      "私有文件上次提交状态不确定，拒绝继续写入",
    );
    uncertain.committedUncertain = true;
    throw uncertain;
  }
  const existing = statIfExists(fileSystem, target);
  if (existing) validatePrivateStat(existing, target);
  // Optional CAS for a caller that read and validated an encrypted container
  // before a slow external operation. The subsequent backup pins this inode.
  const assertExpectedIdentity = (stat) => {
    if (options.expectedIdentity && (!stat
      || ["dev", "ino", "size", "mtimeMs"].some((field) => (
        stat[field] !== options.expectedIdentity[field]
      )))) {
      throw serviceError("PRIVATE_FILE_COMPARE_FAILED", "私有文件在提交前已变化");
    }
  };
  assertExpectedIdentity(existing);
  const existingTemp = statIfExists(fileSystem, tempPath);
  if (existingTemp) {
    validatePrivateStat(existingTemp, tempPath);
    throw serviceError("UNSAFE_PATH", `私有文件 temp 已存在: ${tempPath}`);
  }

  const noFollow = fileSystem.constants.O_NOFOLLOW || 0;
  const flags = fileSystem.constants.O_CREAT | fileSystem.constants.O_EXCL
    | fileSystem.constants.O_WRONLY | noFollow;
  let fd;
  let createdIdentity = null;
  let renamed = false;
  let backupPath = null;
  let backupIdentity = null;
  let preserveEvidence = false;

  const fsyncParent = () => {
    fsyncPrivateParent(parent, fileSystem);
  };
  const validateBackup = (stat, expectedLinks) => {
    if (stat?.isSymbolicLink?.()) throw serviceError("UNSAFE_SYMLINK", `拒绝符号链接 backup: ${backupPath}`);
    if (!stat?.isFile?.()) throw serviceError("UNSAFE_PATH", `backup 不是普通文件: ${backupPath}`);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw serviceError("UNSAFE_OWNER", `backup 不属于当前用户: ${backupPath}`);
    }
    if ((stat.mode & 0o077) !== 0 || stat.dev !== backupIdentity.dev
      || stat.ino !== backupIdentity.ino || stat.nlink !== expectedLinks) {
      throw serviceError("UNSAFE_PATH", `backup identity 无效: ${backupPath}`);
    }
    return stat;
  };
  try {
    try {
      fd = fileSystem.openSync(tempPath, flags, 0o600);
    } catch (error) {
      if (error?.code === "ELOOP") throw serviceError("UNSAFE_SYMLINK", `拒绝符号链接 temp: ${tempPath}`);
      throw error;
    }
    const opened = validatePrivateStat(fileSystem.fstatSync(fd), tempPath);
    createdIdentity = { dev: opened.dev, ino: opened.ino };
    fileSystem.fchmodSync(fd, 0o600);
    writeFully(fileSystem, fd, value);
    fileSystem.fsyncSync(fd);
    fileSystem.closeSync(fd);
    fd = undefined;
    const ready = validatePrivateStat(fileSystem.lstatSync(tempPath), tempPath);
    if (ready.dev !== createdIdentity.dev || ready.ino !== createdIdentity.ino) {
      throw serviceError("UNSAFE_PATH", `私有文件 temp inode 已变化: ${tempPath}`);
    }
    if (existing) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = `${target}.backup-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
        if (!statIfExists(fileSystem, candidate)) {
          backupPath = candidate;
          break;
        }
      }
      if (!backupPath) throw serviceError("PRIVATE_FILE_BACKUP_FAILED", "无法分配私有文件 backup");
      backupIdentity = { dev: existing.dev, ino: existing.ino };
      fileSystem.linkSync(target, backupPath);
      validateBackup(fileSystem.lstatSync(backupPath), 2);
      const linkedTarget = fileSystem.lstatSync(target);
      if (linkedTarget.dev !== backupIdentity.dev || linkedTarget.ino !== backupIdentity.ino
        || linkedTarget.nlink !== 2) {
        throw serviceError("UNSAFE_PATH", `私有文件 backup 建立时 identity 变化: ${target}`);
      }
      assertExpectedIdentity(linkedTarget);
    }
    fileSystem.renameSync(tempPath, target);
    renamed = true;
    const installed = validatePrivateStat(fileSystem.lstatSync(target), target);
    if (installed.dev !== createdIdentity.dev || installed.ino !== createdIdentity.ino) {
      throw serviceError("UNSAFE_PATH", `私有文件提交后的 identity 无效: ${target}`);
    }
    if (backupPath) validateBackup(fileSystem.lstatSync(backupPath), 1);
    try {
      fsyncParent();
    } catch {
      try {
        const current = validatePrivateStat(fileSystem.lstatSync(target), target);
        if (current.dev !== createdIdentity.dev || current.ino !== createdIdentity.ino) {
          throw serviceError("UNSAFE_PATH", `私有文件 rollback 前 identity 变化: ${target}`);
        }
        if (backupPath) {
          validateBackup(fileSystem.lstatSync(backupPath), 1);
          fileSystem.renameSync(backupPath, target);
          backupPath = null;
          const restored = validatePrivateStat(fileSystem.lstatSync(target), target);
          if (restored.dev !== backupIdentity.dev || restored.ino !== backupIdentity.ino) {
            throw serviceError("PRIVATE_FILE_ROLLBACK_FAILED", "私有文件旧 inode 未恢复");
          }
        } else {
          fileSystem.unlinkSync(target);
        }
        fsyncParent();
      } catch {
        preserveEvidence = true;
        const uncertain = new AggregateError([
          serviceError("PRIVATE_FILE_COMMIT_FAILED", "私有文件目录提交失败"),
          serviceError("PRIVATE_FILE_ROLLBACK_FAILED", "私有文件回滚失败"),
        ], "私有文件提交状态不确定");
        uncertain.code = "PRIVATE_FILE_COMMIT_UNCERTAIN";
        uncertain.committedUncertain = true;
        throw uncertain;
      }
      throw serviceError("PRIVATE_FILE_COMMIT_FAILED", "私有文件目录提交失败");
    }
    if (backupPath) {
      try {
        validateBackup(fileSystem.lstatSync(backupPath), 1);
        fileSystem.unlinkSync(backupPath);
        backupPath = null;
        fsyncParent();
      } catch {
        preserveEvidence = true;
        const committed = new AggregateError([
          serviceError("PRIVATE_FILE_BACKUP_CLEANUP_FAILED", "已提交文件的 backup 清理失败"),
        ], "私有文件已提交但清理不完整");
        committed.code = "PRIVATE_FILE_COMMITTED_WITH_CLEANUP_FAILURE";
        committed.committed = true;
        throw committed;
      }
    }
  } finally {
    if (fd !== undefined) fileSystem.closeSync(fd);
    if (!renamed && createdIdentity) {
      try {
        const temp = statIfExists(fileSystem, tempPath);
        if (temp && temp.dev === createdIdentity.dev && temp.ino === createdIdentity.ino
          && temp.isFile() && temp.nlink === 1
          && (typeof process.getuid !== "function" || temp.uid === process.getuid())) {
          fileSystem.unlinkSync(tempPath);
        }
      } catch {}
    }
    if (backupPath && !preserveEvidence && backupIdentity) {
      try {
        const backup = statIfExists(fileSystem, backupPath);
        if (backup && backup.dev === backupIdentity.dev && backup.ino === backupIdentity.ino
          && backup.isFile() && (backup.nlink === 1 || backup.nlink === 2)
          && (typeof process.getuid !== "function" || backup.uid === process.getuid())) {
          fileSystem.unlinkSync(backupPath);
        }
      } catch {}
    }
  }
}

module.exports = {
  atomicWritePrivateFile,
  fsyncPrivateParent,
  openExistingPrivateFile,
  preparePrivateParent,
  readPrivateFile,
  recoverInterruptedPrivateFile,
  statIfExists,
  validateDirectoryStat,
  validatePrivateStat,
  writeFully,
};
