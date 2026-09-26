"use strict";

const fs = require("node:fs");
const path = require("node:path");

function serviceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function lstatIfExists(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function rejectSymlink(target) {
  const stat = lstatIfExists(target);
  if (stat?.isSymbolicLink()) throw serviceError("UNSAFE_SYMLINK", `拒绝符号链接路径: ${target}`);
  return stat;
}

function assertOwned(stat, target) {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw serviceError("UNSAFE_OWNER", `路径不属于当前用户: ${target}`);
  }
}

function rejectHardlink(stat, target) {
  if (stat?.isFile() && stat.nlink !== 1) {
    throw serviceError("UNSAFE_HARDLINK", `拒绝 hardlink 文件: ${target}`);
  }
}

function validatePrivateFileStat(stat, target) {
  if (!stat?.isFile()) throw serviceError("UNSAFE_PATH", `路径不是普通文件: ${target}`);
  assertOwned(stat, target);
  rejectHardlink(stat, target);
  if ((stat.mode & 0o077) !== 0) throw serviceError("UNSAFE_PERMISSIONS", `文件权限过宽: ${target}`);
  return stat;
}

function assertPrivateDirectory(target) {
  const stat = rejectSymlink(target);
  if (!stat?.isDirectory()) throw serviceError("UNSAFE_PATH", `路径不是目录: ${target}`);
  assertOwned(stat, target);
  if ((stat.mode & 0o077) !== 0) throw serviceError("UNSAFE_PERMISSIONS", `目录权限过宽: ${target}`);
  return stat;
}

function ensurePrivateDirectory(target) {
  const existing = rejectSymlink(target);
  if (existing && !existing.isDirectory()) {
    throw serviceError("UNSAFE_PATH", `路径不是目录: ${target}`);
  }
  if (existing) assertOwned(existing, target);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.chmodSync(target, 0o700);
  assertPrivateDirectory(target);
}

function tightenPrivateDirectory(target, before) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const directoryOnly = fs.constants.O_DIRECTORY || 0;
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow | directoryOnly);
    const opened = fs.fstatSync(fd);
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw serviceError("UNSAFE_PATH", `目录 inode 在打开时变化: ${target}`);
    }
    assertOwned(opened, target);
    fs.fchmodSync(fd, 0o700);
    const secured = fs.fstatSync(fd);
    if ((secured.mode & 0o077) !== 0) {
      throw serviceError("UNSAFE_PERMISSIONS", `目录权限过宽: ${target}`);
    }
  } catch (error) {
    if (error.code === "ELOOP") {
      throw serviceError("UNSAFE_SYMLINK", `拒绝符号链接路径: ${target}`);
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function ensurePrivateDirectoryTree(target, trustedRoot) {
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(trustedRoot);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw serviceError("UNSAFE_PATH", `安全目录不在 trusted root 内: ${resolvedTarget}`);
  }
  const rootStat = rejectSymlink(resolvedRoot);
  if (!rootStat?.isDirectory()) {
    throw serviceError("UNSAFE_PATH", `trusted root 不是目录: ${resolvedRoot}`);
  }
  assertOwned(rootStat, resolvedRoot);

  let cursor = resolvedRoot;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    let existing = rejectSymlink(cursor);
    if (existing && !existing.isDirectory()) {
      throw serviceError("UNSAFE_PATH", `安全路径中间项不是目录: ${cursor}`);
    }
    if (existing) {
      assertOwned(existing, cursor);
    } else {
      fs.mkdirSync(cursor, { mode: 0o700 });
      existing = rejectSymlink(cursor);
      if (!existing?.isDirectory()) {
        throw serviceError("UNSAFE_PATH", `安全路径中间项不是目录: ${cursor}`);
      }
    }
    tightenPrivateDirectory(cursor, existing);
  }
  assertPrivateDirectory(resolvedTarget);
}

function assertPrivateRegularFile(target) {
  const stat = rejectSymlink(target);
  return validatePrivateFileStat(stat, target);
}

module.exports = {
  assertPrivateRegularFile,
  assertPrivateDirectory,
  ensurePrivateDirectory,
  ensurePrivateDirectoryTree,
  lstatIfExists,
  rejectSymlink,
  rejectHardlink,
  serviceError,
  validatePrivateFileStat,
};
