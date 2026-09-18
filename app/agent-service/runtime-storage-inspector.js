"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { serviceError } = require("./security");

const DEFAULT_STORAGE_SCAN_LIMITS = Object.freeze({
  maxBytes: 128 * 1024 * 1024 * 1024,
  maxDepth: 64,
  maxEntries: 250_000,
  maxDurationMs: 5_000,
});

function storageError(code, message) {
  return serviceError(code, message);
}

function assertAbsolutePath(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw storageError("RUNTIME_STORAGE_PATH_INVALID", `${name} 必须是绝对路径`);
  }
  return path.resolve(value);
}

function assertOwned(stat, target) {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw storageError("RUNTIME_STORAGE_OWNER_INVALID", `路径不属于当前用户: ${target}`);
  }
}

function isContained(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function validateCanonicalOwnedDirectory(target, options = {}) {
  const fileSystem = options.fs || fs;
  const resolved = assertAbsolutePath(target, "root");
  const trustedRoot = assertAbsolutePath(options.trustedRoot, "trustedRoot");

  let trustedStat;
  let rootStat;
  try {
    trustedStat = fileSystem.lstatSync(trustedRoot);
    rootStat = fileSystem.lstatSync(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw storageError("RUNTIME_STORAGE_ROOT_MISSING", "存储扫描目录不存在");
    }
    throw error;
  }
  if (trustedStat.isSymbolicLink() || !trustedStat.isDirectory()) {
    throw storageError("RUNTIME_STORAGE_TRUSTED_ROOT_INVALID", "存储 trusted root 不是普通目录");
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw storageError("RUNTIME_STORAGE_ROOT_INVALID", "存储扫描 root 不是普通目录");
  }
  assertOwned(trustedStat, trustedRoot);
  assertOwned(rootStat, resolved);

  let canonicalTrusted;
  let canonicalRoot;
  try {
    canonicalTrusted = fileSystem.realpathSync(trustedRoot);
    canonicalRoot = fileSystem.realpathSync(resolved);
  } catch {
    throw storageError("RUNTIME_STORAGE_ROOT_NOT_CANONICAL", "存储扫描 root 无法规范化");
  }
  if (canonicalTrusted !== trustedRoot || canonicalRoot !== resolved) {
    throw storageError("RUNTIME_STORAGE_ROOT_NOT_CANONICAL", "存储扫描 root 必须使用规范路径");
  }
  if (!isContained(canonicalTrusted, canonicalRoot)) {
    throw storageError("RUNTIME_STORAGE_ROOT_OUTSIDE_TRUST", "存储扫描 root 不在 trusted root 内");
  }
  return Object.freeze({
    path: canonicalRoot,
    dev: rootStat.dev,
    ino: rootStat.ino,
    uid: rootStat.uid,
    mtimeMs: rootStat.mtimeMs,
  });
}

function positiveLimit(value, fallback, name) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw storageError("RUNTIME_STORAGE_LIMIT_INVALID", `${name} 必须是正整数`);
  }
  return selected;
}

function inspectRuntimeStorage(root, options = {}) {
  const fileSystem = options.fs || fs;
  const now = options.now || Date.now;
  if (typeof now !== "function") {
    throw storageError("RUNTIME_STORAGE_OPTIONS_INVALID", "存储扫描时钟无效");
  }
  const limits = Object.freeze({
    maxBytes: positiveLimit(options.maxBytes, DEFAULT_STORAGE_SCAN_LIMITS.maxBytes, "maxBytes"),
    maxDepth: positiveLimit(options.maxDepth, DEFAULT_STORAGE_SCAN_LIMITS.maxDepth, "maxDepth"),
    maxEntries: positiveLimit(
      options.maxEntries,
      DEFAULT_STORAGE_SCAN_LIMITS.maxEntries,
      "maxEntries",
    ),
    maxDurationMs: positiveLimit(
      options.maxDurationMs,
      DEFAULT_STORAGE_SCAN_LIMITS.maxDurationMs,
      "maxDurationMs",
    ),
  });
  const identity = validateCanonicalOwnedDirectory(root, {
    fs: fileSystem,
    trustedRoot: options.trustedRoot,
  });
  const startedAt = now();
  if (!Number.isFinite(startedAt)) {
    throw storageError("RUNTIME_STORAGE_OPTIONS_INVALID", "存储扫描时钟返回值无效");
  }

  let bytes = 0;
  let files = 0;
  let dirs = 0;
  let symlinks = 0;
  let entries = 0;
  let incomplete = false;
  let limitReason = null;
  const pending = [{ target: identity.path, depth: 0 }];

  const stop = (reason) => {
    incomplete = true;
    limitReason = limitReason || reason;
  };
  const addBytes = (size) => {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw storageError("RUNTIME_STORAGE_ENTRY_SIZE_INVALID", "存储目录包含无效文件大小");
    }
    if (size > limits.maxBytes - bytes) {
      bytes = limits.maxBytes;
      stop("bytes");
      return;
    }
    bytes += size;
  };

  while (pending.length > 0 && !incomplete) {
    if (now() - startedAt >= limits.maxDurationMs) {
      stop("duration");
      break;
    }
    const current = pending.pop();
    let stat;
    try {
      stat = fileSystem.lstatSync(current.target);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw storageError("RUNTIME_STORAGE_CHANGED", "存储扫描期间目录内容发生变化");
      }
      throw error;
    }
    assertOwned(stat, current.target);
    entries += 1;

    if (stat.isSymbolicLink()) {
      symlinks += 1;
      addBytes(stat.size);
    } else if (stat.isDirectory()) {
      dirs += 1;
      if (current.depth >= limits.maxDepth) {
        let handle;
        try {
          handle = fileSystem.opendirSync(current.target);
          if (handle.readSync() !== null) stop("depth");
        } finally {
          handle?.closeSync();
        }
      } else {
        let handle;
        try {
          handle = fileSystem.opendirSync(current.target);
          let dirent;
          while (!incomplete && (dirent = handle.readSync()) !== null) {
            if (now() - startedAt >= limits.maxDurationMs) {
              stop("duration");
              break;
            }
            if (entries + pending.length >= limits.maxEntries) {
              stop("entries");
              break;
            }
            pending.push({
              target: path.join(current.target, dirent.name),
              depth: current.depth + 1,
            });
          }
        } finally {
          handle?.closeSync();
        }
      }
    } else if (stat.isFile()) {
      files += 1;
      addBytes(stat.size);
    } else if (options.ignoreIpcEntries === true && (stat.isSocket() || stat.isFIFO())) {
      // Live CLI Homes contain IPC endpoints, which have no stored file payload.
      // Opt in only for read-only usage stats; cleanup scans remain strict.
      continue;
    } else {
      throw storageError("RUNTIME_STORAGE_ENTRY_TYPE_INVALID", "存储目录包含不支持的特殊文件");
    }
  }

  let after;
  try {
    after = fileSystem.lstatSync(identity.path);
  } catch {
    throw storageError("RUNTIME_STORAGE_CHANGED", "存储扫描期间 root 发生变化");
  }
  if (after.isSymbolicLink() || !after.isDirectory() || !sameIdentity(identity, after)) {
    throw storageError("RUNTIME_STORAGE_CHANGED", "存储扫描期间 root identity 发生变化");
  }
  assertOwned(after, identity.path);

  return Object.freeze({
    bytes,
    files,
    dirs,
    symlinks,
    entries,
    incomplete,
    limitReason,
    identity,
  });
}

module.exports = {
  DEFAULT_STORAGE_SCAN_LIMITS,
  inspectRuntimeStorage,
  isContained,
  sameIdentity,
  validateCanonicalOwnedDirectory,
};
