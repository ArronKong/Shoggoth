"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  assertPrivateDirectory,
  ensurePrivateDirectoryTree,
  lstatIfExists,
  serviceError,
} = require("./security");
const { acquirePrivateWriterLease } = require("./private-writer-lease");

const BACKUP_SCHEMA_VERSION = 1;
const RUNTIME_SCHEMA_METADATA_BACKUP_SCHEMA_VERSION = 2;
const RUNTIME_SCHEMA_METADATA_BACKUP_SCOPE = "runtime-schema-metadata";
const MAX_BACKUP_MANIFEST_BYTES = 16 * 1024 * 1024;
const BACKUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RUNTIME_SCHEMA_METADATA_FILES = Object.freeze([
  "chat-sessions.json",
  "events.jsonl",
  "state.snapshot.json",
]);
const RUNTIME_SCHEMA_METADATA_WRITER_LOCKS = Object.freeze([
  "chat-sessions.writer.lock",
]);
const RUNTIME_SCHEMA_SOURCE_MATCHES = new Set(["exact", "event-log-continuation"]);
const MAX_RUNTIME_SCHEMA_EVENT_LINE_BYTES = 16 * 1024 * 1024;
const ACTIVE_RUNTIME_SCHEMA_WRITER_FENCES = new WeakSet();
const AUTHORITY_BACKUP_RUNTIME_HOME_MODES = Object.freeze([
  "minimal",
  "legacy-full",
]);
const LEGACY_RUNTIME_HOME_ROOTS = new Set([
  "codex",
  "grok-build",
  "antigravity",
  "pi",
  "claude-code",
  "deepseek-harness",
]);
const MANAGED_CODEX_BACKUP_FILES = new Set(["auth.json", "config.toml", ".shoggoth-native-auth.json"]);
const OPAQUE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function backupError(code, message) {
  return serviceError(code, message);
}

function assertContained(root, target, code = "BACKUP_UNSAFE_PATH") {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw backupError(code, "备份路径不在受信任目录内");
  }
  return path.resolve(target);
}

function assertBackupPaths(paths) {
  if (!paths?.trustedRoot || !paths.stateDir || !paths.backupsDir
    || !paths.runtimeDir || !paths.lockPath || !paths.socketPath
    || path.dirname(paths.backupsDir) !== paths.stateDir) {
    throw backupError("BACKUP_PATHS_REQUIRED", "备份需要完整 Service paths");
  }
  assertContained(paths.trustedRoot, paths.stateDir);
  assertContained(paths.trustedRoot, paths.backupsDir);
}

function backupPathFor(paths, backupId) {
  if (typeof backupId !== "string" || !BACKUP_ID_PATTERN.test(backupId)) {
    throw backupError("BACKUP_ID_INVALID", "backupId 无效");
  }
  return assertContained(paths.backupsDir, path.join(paths.backupsDir, backupId));
}

function assertOwned(stat, target) {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw backupError("BACKUP_UNSAFE_SOURCE", `备份源不属于当前用户: ${target}`);
  }
}

function assertSafeSourceStat(stat, target) {
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw backupError("BACKUP_UNSAFE_SOURCE", `备份源类型不安全: ${target}`);
  }
  assertOwned(stat, target);
  if (stat.isFile() && stat.nlink !== 1) {
    throw backupError("BACKUP_UNSAFE_SOURCE", `备份源不允许 hardlink: ${target}`);
  }
}

function fsyncDirectory(target) {
  const fd = fs.openSync(target, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function fsyncFile(target) {
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function fsyncDirectoryTree(target) {
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory()) fsyncDirectoryTree(path.join(target, entry.name));
  }
  fsyncDirectory(target);
}

function sha256File(target) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function portablePath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function isExcludedRuntimeCache(relativePath) {
  const parts = relativePath.split(path.sep);
  return (parts.length === 3 && parts[0] === "codex" && parts[2] === "tmp")
    || (parts.length === 5 && parts[0] === "grok-build"
      && parts[2] === "Library" && parts[3] === "pnpm" && parts[4] === "store")
    || (parts.length === 5 && parts[0] === "antigravity"
      && parts[2] === ".gemini" && parts[3] === "antigravity-cli"
      && (parts[4] === "cli.log" || parts[4] === "log"))
    || (parts.length === 4 && parts[0] === "deepseek-harness"
      && parts[2] === "profiles" && parts[3] === "node_modules")
    || (parts[0] === "native-runtime-imports" && parts[1] === "staging");
}

function minimalAuthorityPathDisposition(relativePath) {
  const parts = relativePath.split(path.sep);
  const [root] = parts;
  if (root === "runtime-integration") return "exclude";
  if (root === "legacy-runtime-homes") {
    if (parts.length === 1) return "traverse";
    return parts.length === 2
      && ["manifest.json", "cleanup-audit.jsonl"].includes(parts[1])
      ? "file" : "exclude";
  }
  if (root === "native-runtime-imports") {
    if (parts.length === 1) return "traverse";
    return parts.length === 2 && parts[1] === "native-runtime-import-v1.json"
      ? "file" : "exclude";
  }
  if (LEGACY_RUNTIME_HOME_ROOTS.has(root)) {
    if (root !== "codex") return "exclude";
    if (parts.length === 1) return "traverse";
    if (!OPAQUE_PATH_SEGMENT_PATTERN.test(parts[1])) return "exclude";
    if (parts.length === 2) return "traverse";
    return parts.length === 3 && MANAGED_CODEX_BACKUP_FILES.has(parts[2])
      ? "file" : "exclude";
  }
  if (root === "runtime-accounts") {
    if (parts.length === 1) return "traverse";
    if (parts[1] !== "codex") return "exclude";
    if (parts.length === 2) return "traverse";
    if (!OPAQUE_PATH_SEGMENT_PATTERN.test(parts[2])) return "exclude";
    if (parts.length === 3) return "traverse";
    if (parts[3] !== "home") return "exclude";
    if (parts.length === 4) return "traverse";
    return parts.length === 5 && MANAGED_CODEX_BACKUP_FILES.has(parts[4])
      ? "file" : "exclude";
  }
  return "include";
}

function authorityPathDisposition(relativePath, runtimeHomeMode) {
  if (isExcludedRuntimeCache(relativePath)) return "exclude";
  return runtimeHomeMode === "legacy-full"
    ? "include" : minimalAuthorityPathDisposition(relativePath);
}

function copyAuthorityFile(source, destination, relative, before) {
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
  fsyncFile(destination);
  const sourceDigest = sha256File(source);
  const copiedDigest = sha256File(destination);
  const after = fs.lstatSync(source);
  if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw backupError("BACKUP_SOURCE_CHANGED", `备份期间源文件发生变化: ${source}`);
  }
  if (sourceDigest !== copiedDigest) {
    throw backupError("BACKUP_COPY_MISMATCH", `备份副本摘要不一致: ${source}`);
  }
  return {
    path: portablePath(relative),
    type: "file",
    mode: before.mode & 0o777,
    size: before.size,
    sha256: sourceDigest,
  };
}

function sameFileVersion(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
    && left.nlink === right.nlink && left.mode === right.mode && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function withPinnedRegularFile(target, options, action) {
  const code = options.code;
  const message = options.message;
  let before;
  try {
    before = options.before || fs.lstatSync(target);
  } catch {
    throw backupError(code, message);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw backupError(code, message);
  }
  assertOwned(before, target);
  let fd;
  try {
    try {
      fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    } catch (error) {
      if (error?.code === "ELOOP") throw backupError(code, message);
      throw error;
    }
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !sameFileVersion(before, opened)) {
      throw backupError(code, message);
    }
    assertOwned(opened, target);
    const result = action(fd, opened);
    const after = fs.fstatSync(fd);
    let pathAfter;
    try {
      pathAfter = fs.lstatSync(target);
    } catch {
      throw backupError(code, message);
    }
    if (!after.isFile() || !pathAfter.isFile() || pathAfter.isSymbolicLink()
      || after.nlink !== 1 || pathAfter.nlink !== 1
      || !sameFileVersion(before, after) || !sameFileVersion(before, pathAfter)) {
      throw backupError(code, message);
    }
    assertOwned(after, target);
    assertOwned(pathAfter, target);
    return result;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readPinnedFileBytes(target, before, maxBytes, code, message) {
  if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxBytes) {
    throw backupError(code, message);
  }
  return withPinnedRegularFile(target, { before, code, message }, (fd) => {
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(read) || read <= 0) throw backupError(code, message);
      offset += read;
    }
    const overflow = Buffer.allocUnsafe(1);
    if (fs.readSync(fd, overflow, 0, 1, offset) !== 0) throw backupError(code, message);
    return bytes;
  });
}

function copyPinnedAuthorityFile(source, destination, relative, before) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let sourceFd;
  let destinationFd;
  try {
    try {
      sourceFd = fs.openSync(source, fs.constants.O_RDONLY | noFollow);
    } catch (error) {
      if (error?.code === "ELOOP") {
        throw backupError("BACKUP_UNSAFE_SOURCE", `备份源不允许 symlink: ${source}`);
      }
      throw error;
    }
    const opened = fs.fstatSync(sourceFd);
    assertSafeSourceStat(opened, source);
    if (!sameFileVersion(before, opened)) {
      throw backupError("BACKUP_SOURCE_CHANGED", `备份期间源文件发生变化: ${source}`);
    }

    destinationFd = fs.openSync(
      destination,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    const sourceHash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let copiedBytes = 0;
    for (;;) {
      const bytes = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      sourceHash.update(buffer.subarray(0, bytes));
      let offset = 0;
      while (offset < bytes) {
        const written = fs.writeSync(destinationFd, buffer, offset, bytes - offset, null);
        if (!Number.isSafeInteger(written) || written <= 0) {
          throw backupError("BACKUP_COPY_MISMATCH", `备份副本写入不完整: ${source}`);
        }
        offset += written;
      }
      copiedBytes += bytes;
    }
    fs.fchmodSync(destinationFd, 0o600);
    fs.fsyncSync(destinationFd);

    const copiedHash = crypto.createHash("sha256");
    let position = 0;
    for (;;) {
      const bytes = fs.readSync(destinationFd, buffer, 0, buffer.length, position);
      if (bytes === 0) break;
      copiedHash.update(buffer.subarray(0, bytes));
      position += bytes;
    }
    const sourceDigest = sourceHash.digest("hex");
    const copiedDigest = copiedHash.digest("hex");
    const destinationStat = fs.fstatSync(destinationFd);
    const after = fs.fstatSync(sourceFd);
    let pathAfter;
    try {
      pathAfter = fs.lstatSync(source);
    } catch {
      throw backupError("BACKUP_SOURCE_CHANGED", `备份期间源文件发生变化: ${source}`);
    }
    assertSafeSourceStat(after, source);
    assertSafeSourceStat(pathAfter, source);
    assertSafeSourceStat(destinationStat, destination);
    if (!sameFileVersion(before, after) || !sameFileVersion(before, pathAfter)
      || copiedBytes !== before.size || destinationStat.size !== before.size) {
      throw backupError("BACKUP_SOURCE_CHANGED", `备份期间源文件发生变化: ${source}`);
    }
    if (sourceDigest !== copiedDigest) {
      throw backupError("BACKUP_COPY_MISMATCH", `备份副本摘要不一致: ${source}`);
    }
    return {
      path: portablePath(relative),
      type: "file",
      mode: before.mode & 0o777,
      size: before.size,
      sha256: sourceDigest,
    };
  } finally {
    if (destinationFd !== undefined) fs.closeSync(destinationFd);
    if (sourceFd !== undefined) fs.closeSync(sourceFd);
  }
}

function copyAuthorityTree(sourceRoot, payloadRoot, runtimeHomeMode) {
  const entries = [];

  function visit(sourceDirectory, relativeDirectory) {
    const names = fs.readdirSync(sourceDirectory).sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      if (relativeDirectory === "" && name === "backups") continue;
      const relative = relativeDirectory ? path.join(relativeDirectory, name) : name;
      const disposition = authorityPathDisposition(relative, runtimeHomeMode);
      if (disposition === "exclude") continue;
      const source = path.join(sourceDirectory, name);
      const destination = path.join(payloadRoot, relative);
      const before = fs.lstatSync(source);
      assertSafeSourceStat(before, source);
      if (before.isDirectory()) {
        if (disposition === "file") {
          throw backupError("BACKUP_UNSAFE_SOURCE", `备份白名单文件不是普通文件: ${source}`);
        }
        entries.push({ path: portablePath(relative), type: "directory", mode: before.mode & 0o777 });
        fs.mkdirSync(destination, { mode: 0o700 });
        fs.chmodSync(destination, 0o700);
        visit(source, relative);
        continue;
      }
      if (disposition === "traverse") {
        throw backupError("BACKUP_UNSAFE_SOURCE", `备份白名单目录不是普通目录: ${source}`);
      }
      entries.push(copyAuthorityFile(source, destination, relative, before));
    }
  }

  visit(sourceRoot, "");
  return entries;
}

function runtimeSchemaMetadataSources(sourceRoot) {
  const sources = [];
  for (const name of RUNTIME_SCHEMA_METADATA_FILES) {
    const source = path.join(sourceRoot, name);
    const before = lstatIfExists(source);
    if (!before) continue;
    assertSafeSourceStat(before, source);
    if (!before.isFile()) {
      throw backupError("BACKUP_UNSAFE_SOURCE", `Runtime schema metadata 不是普通文件: ${source}`);
    }
    sources.push({ name, source, before });
  }
  if (sources.length === 0) {
    throw backupError("BACKUP_SOURCE_CHANGED", "Runtime schema metadata 在备份前消失");
  }
  return sources;
}

function copyRuntimeSchemaMetadata(sourceRoot, payloadRoot) {
  const entries = [];
  for (const { name, source, before } of runtimeSchemaMetadataSources(sourceRoot)) {
    entries.push(copyPinnedAuthorityFile(source, path.join(payloadRoot, name), name, before));
  }
  return entries;
}

function rootDigest(entries) {
  return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function writeManifest(target, manifest) {
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_BACKUP_MANIFEST_BYTES) {
    throw backupError("BACKUP_MANIFEST_TOO_LARGE", "备份清单超过上限");
  }
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeFileSync(fd, serialized, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function assertRuntimeSchemaMetadataWriterLocks(paths, activeWriterLocks) {
  if (!Array.isArray(activeWriterLocks)
    || !ACTIVE_RUNTIME_SCHEMA_WRITER_FENCES.has(activeWriterLocks)
    || activeWriterLocks.length !== RUNTIME_SCHEMA_METADATA_WRITER_LOCKS.length) {
    throw backupError("BACKUP_SERVICE_ACTIVE", "Runtime schema metadata writer fence 无效");
  }
  const identities = new Map();
  for (const identity of activeWriterLocks) {
    if (!identity || typeof identity.lockPath !== "string"
      || !Number.isSafeInteger(identity.dev) || !Number.isSafeInteger(identity.ino)
      || identities.has(identity.lockPath)) {
      throw backupError("BACKUP_SERVICE_ACTIVE", "Runtime schema metadata writer fence 无效");
    }
    identities.set(identity.lockPath, identity);
  }
  for (const basename of RUNTIME_SCHEMA_METADATA_WRITER_LOCKS) {
    const lockPath = path.join(paths.stateDir, basename);
    const identity = identities.get(lockPath);
    const stat = identity ? lstatIfExists(lockPath) : null;
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 2
      || stat.dev !== identity.dev || stat.ino !== identity.ino) {
      throw backupError("BACKUP_SERVICE_ACTIVE", "Runtime schema metadata writer fence 已失效");
    }
    assertOwned(stat, lockPath);
  }
}

function acquireRuntimeSchemaMetadataWriterFence(options = {}) {
  const { paths } = options;
  assertBackupPaths(paths);
  assertPrivateDirectory(paths.stateDir);
  const acquireWriterLease = options.acquireWriterLease || acquirePrivateWriterLease;
  const leases = [];
  const activeWriterLocks = [];
  let ownedWriterLocks = null;
  try {
    for (const basename of RUNTIME_SCHEMA_METADATA_WRITER_LOCKS) {
      const lockPath = path.join(paths.stateDir, basename);
      const lease = acquireWriterLease({
        lockPath,
        trustedRoot: paths.trustedRoot,
      });
      leases.push(lease);
      const stat = fs.lstatSync(lockPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 2) {
        throw backupError("BACKUP_SERVICE_ACTIVE", "Runtime schema metadata writer fence 无效");
      }
      assertOwned(stat, lockPath);
      activeWriterLocks.push(Object.freeze({ lockPath, dev: stat.dev, ino: stat.ino }));
    }
    ownedWriterLocks = Object.freeze(activeWriterLocks);
    ACTIVE_RUNTIME_SCHEMA_WRITER_FENCES.add(ownedWriterLocks);
    assertRuntimeSchemaMetadataWriterLocks(paths, ownedWriterLocks);
  } catch (error) {
    if (ownedWriterLocks) ACTIVE_RUNTIME_SCHEMA_WRITER_FENCES.delete(ownedWriterLocks);
    for (const lease of leases.reverse()) {
      try { lease.release(); } catch { /* 保留 acquire 主错误 */ }
    }
    throw error;
  }

  let released = false;
  return Object.freeze({
    activeWriterLocks: ownedWriterLocks,
    release() {
      if (released) return false;
      ACTIVE_RUNTIME_SCHEMA_WRITER_FENCES.delete(ownedWriterLocks);
      for (const lease of leases.slice().reverse()) lease.release();
      released = true;
      return true;
    },
  });
}

function withRuntimeSchemaMetadataWriterFence(options, action) {
  if (options.activeWriterLocks !== undefined) {
    assertRuntimeSchemaMetadataWriterLocks(options.paths, options.activeWriterLocks);
    return action(options.activeWriterLocks);
  }
  const fence = acquireRuntimeSchemaMetadataWriterFence(options);
  let actionError = null;
  let result;
  try {
    result = action(fence.activeWriterLocks);
  } catch (error) {
    actionError = error;
  }
  try {
    fence.release();
  } catch (releaseError) {
    if (!actionError) throw releaseError;
    const aggregate = new AggregateError(
      [actionError, releaseError],
      "Runtime schema metadata writer fence 释放失败",
    );
    aggregate.code = "BACKUP_WRITER_FENCE_RELEASE_FAILED";
    throw aggregate;
  }
  if (actionError) throw actionError;
  return result;
}

function assertServiceStopped(paths, activeServiceLock = null, activeWriterLocks = []) {
  const lock = lstatIfExists(paths.lockPath);
  const allowedOwnedLock = lock && activeServiceLock
    && Number.isSafeInteger(activeServiceLock.dev)
    && Number.isSafeInteger(activeServiceLock.ino)
    && lock.isFile() && !lock.isSymbolicLink() && lock.nlink === 1
    && lock.dev === activeServiceLock.dev && lock.ino === activeServiceLock.ino;
  if (activeServiceLock !== null && !allowedOwnedLock) {
    throw backupError("BACKUP_SERVICE_ACTIVE", "备份需要当前 Service lock 的精确所有权");
  }
  if (allowedOwnedLock) assertOwned(lock, paths.lockPath);
  if ((activeServiceLock === null && lock) || lstatIfExists(paths.socketPath)) {
    throw backupError("BACKUP_SERVICE_ACTIVE", "Agent Service 运行时不能建立一致备份");
  }
  const allowedWriterLocks = new Map(activeWriterLocks.map((identity) => [
    path.basename(identity.lockPath), identity,
  ]));
  const writerLocks = fs.readdirSync(paths.stateDir).filter((name) => name.endsWith(".writer.lock"));
  for (const name of writerLocks) {
    const identity = allowedWriterLocks.get(name);
    const target = path.join(paths.stateDir, name);
    const stat = identity ? fs.lstatSync(target) : null;
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 2
      || stat.dev !== identity.dev || stat.ino !== identity.ino) {
      throw backupError("BACKUP_SERVICE_ACTIVE", "持久化 writer 未关闭，不能建立一致备份");
    }
    assertOwned(stat, target);
  }
  if (activeWriterLocks.length > 0) {
    assertRuntimeSchemaMetadataWriterLocks(paths, activeWriterLocks);
  }
}

function cleanupStaging(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* 保留主错误 */ }
}

function createBackup(
  {
    paths,
    backupId,
    now = Date.now,
    activeServiceLock = null,
    activeWriterLocks = [],
  },
  copyPayload,
  scope = null,
) {
  assertBackupPaths(paths);
  assertPrivateDirectory(paths.stateDir);
  assertServiceStopped(paths, activeServiceLock, activeWriterLocks);
  const createdAt = now();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw backupError("BACKUP_TIME_INVALID", "备份时间无效");
  }
  ensurePrivateDirectoryTree(paths.backupsDir, paths.trustedRoot);
  const backupPath = backupPathFor(paths, backupId);
  if (lstatIfExists(backupPath)) throw backupError("BACKUP_ALREADY_EXISTS", "同名备份已存在");
  const stagingPath = assertContained(
    paths.backupsDir,
    path.join(paths.backupsDir, `.staging-${backupId}-${crypto.randomUUID()}`),
  );
  try {
    ensurePrivateDirectoryTree(stagingPath, paths.trustedRoot);
    const payloadPath = path.join(stagingPath, "payload");
    ensurePrivateDirectoryTree(payloadPath, paths.trustedRoot);
    const entries = copyPayload(paths.stateDir, payloadPath);
    assertServiceStopped(paths, activeServiceLock, activeWriterLocks);
    const manifest = scope === RUNTIME_SCHEMA_METADATA_BACKUP_SCOPE
      ? {
        schemaVersion: RUNTIME_SCHEMA_METADATA_BACKUP_SCHEMA_VERSION,
        backupId,
        createdAt,
        sourceRoot: "stateDir",
        scope,
        entries,
        rootDigest: rootDigest(entries),
      }
      : {
        schemaVersion: BACKUP_SCHEMA_VERSION,
        backupId,
        createdAt,
        sourceRoot: "stateDir",
        entries,
        rootDigest: rootDigest(entries),
      };
    writeManifest(path.join(stagingPath, "manifest.json"), manifest);
    fsyncDirectoryTree(payloadPath);
    fsyncDirectory(stagingPath);
    fs.renameSync(stagingPath, backupPath);
    fsyncDirectory(paths.backupsDir);
    assertServiceStopped(paths, activeServiceLock, activeWriterLocks);
    return Object.freeze({ backupPath, manifest: structuredClone(manifest) });
  } catch (error) {
    cleanupStaging(stagingPath);
    throw error;
  }
}

function createAuthorityBackup(options) {
  const runtimeHomeMode = options.runtimeHomeMode ?? "minimal";
  if (!AUTHORITY_BACKUP_RUNTIME_HOME_MODES.includes(runtimeHomeMode)) {
    throw backupError("BACKUP_OPTIONS_INVALID", "Runtime Home 备份模式无效");
  }
  return createBackup(
    { ...options, activeWriterLocks: [] },
    (sourceRoot, payloadRoot) => copyAuthorityTree(sourceRoot, payloadRoot, runtimeHomeMode),
  );
}

function createRuntimeSchemaMetadataBackup(options) {
  if (!options?.activeServiceLock) {
    throw backupError("BACKUP_SERVICE_ACTIVE", "Runtime schema metadata 备份需要当前 Service lock");
  }
  return withRuntimeSchemaMetadataWriterFence(options, (activeWriterLocks) => createBackup(
    { ...options, activeWriterLocks },
    copyRuntimeSchemaMetadata,
    RUNTIME_SCHEMA_METADATA_BACKUP_SCOPE,
  ));
}

function safeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")
    || value.includes("\0") || path.posix.isAbsolute(value)
    || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw backupError("BACKUP_CORRUPT", "备份清单含不安全路径");
  }
  return value;
}

function assertUnchangedBackupDirectory(target, expected, label) {
  let current;
  try {
    current = fs.lstatSync(target);
  } catch {
    throw backupError("BACKUP_CORRUPT", `${label} 发生变化`);
  }
  if (!current.isDirectory() || current.isSymbolicLink()
    || !sameFileVersion(expected, current)) {
    throw backupError("BACKUP_CORRUPT", `${label} 发生变化`);
  }
  assertOwned(current, target);
}

function readManifest(backupPath, backupId, expectedScope = null, backupDirectoryStat = null) {
  if (backupDirectoryStat) {
    assertUnchangedBackupDirectory(backupPath, backupDirectoryStat, "备份目录");
  }
  const target = path.join(backupPath, "manifest.json");
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.size > MAX_BACKUP_MANIFEST_BYTES) {
    throw backupError("BACKUP_CORRUPT", "备份清单类型或大小无效");
  }
  assertOwned(stat, target);
  let manifest;
  try {
    manifest = JSON.parse(readPinnedFileBytes(
      target,
      stat,
      MAX_BACKUP_MANIFEST_BYTES,
      "BACKUP_CORRUPT",
      "备份清单读取期间发生变化",
    ).toString("utf8"));
  } catch (error) {
    if (error?.code === "BACKUP_CORRUPT" || error?.code === "BACKUP_UNSAFE_SOURCE") throw error;
    throw backupError("BACKUP_CORRUPT", "备份清单无法解析");
  }
  if (backupDirectoryStat) {
    assertUnchangedBackupDirectory(backupPath, backupDirectoryStat, "备份目录");
  }
  const metadataScope = manifest?.scope === RUNTIME_SCHEMA_METADATA_BACKUP_SCOPE
    && manifest?.schemaVersion === RUNTIME_SCHEMA_METADATA_BACKUP_SCHEMA_VERSION;
  if ((expectedScope === RUNTIME_SCHEMA_METADATA_BACKUP_SCOPE && !metadataScope)
    || (expectedScope === null && (manifest?.scope !== undefined
      || manifest?.schemaVersion === RUNTIME_SCHEMA_METADATA_BACKUP_SCHEMA_VERSION))) {
    throw backupError("BACKUP_SCOPE_MISMATCH", "备份范围与验证器不匹配");
  }
  const expectedKeys = expectedScope === RUNTIME_SCHEMA_METADATA_BACKUP_SCOPE
    ? "schemaVersion,backupId,createdAt,sourceRoot,scope,entries,rootDigest"
    : "schemaVersion,backupId,createdAt,sourceRoot,entries,rootDigest";
  const expectedVersion = expectedScope === RUNTIME_SCHEMA_METADATA_BACKUP_SCOPE
    ? RUNTIME_SCHEMA_METADATA_BACKUP_SCHEMA_VERSION : BACKUP_SCHEMA_VERSION;
  if (!manifest || Object.keys(manifest).join(",") !== expectedKeys
    || manifest.schemaVersion !== expectedVersion || manifest.backupId !== backupId
    || !Number.isSafeInteger(manifest.createdAt) || manifest.createdAt < 0
    || manifest.sourceRoot !== "stateDir" || !Array.isArray(manifest.entries)
    || !SHA256_PATTERN.test(manifest.rootDigest)) {
    throw backupError("BACKUP_CORRUPT", "备份清单结构无效");
  }
  const seen = new Set();
  for (const entry of manifest.entries) {
    const keys = Object.keys(entry).join(",");
    const expectedKeys = entry?.type === "file" ? "path,type,mode,size,sha256" : "path,type,mode";
    safeRelativePath(entry?.path);
    if (keys !== expectedKeys || seen.has(entry.path)
      || !["file", "directory"].includes(entry.type)
      || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777
      || (entry.type === "file" && (!Number.isSafeInteger(entry.size) || entry.size < 0
        || !SHA256_PATTERN.test(entry.sha256)))) {
      throw backupError("BACKUP_CORRUPT", "备份清单 entry 无效");
    }
    seen.add(entry.path);
  }
  if (rootDigest(manifest.entries) !== manifest.rootDigest) {
    throw backupError("BACKUP_CORRUPT", "备份根摘要不一致");
  }
  return manifest;
}

function scanPayload(payloadPath) {
  const entries = [];
  function visit(directory, relativeDirectory) {
    for (const name of fs.readdirSync(directory).sort((left, right) => left.localeCompare(right))) {
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const target = path.join(directory, name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())
        || (stat.isFile() && stat.nlink !== 1)) {
        throw backupError("BACKUP_CORRUPT", "备份 payload 含不安全对象");
      }
      assertOwned(stat, target);
      entries.push({ path: relative, type: stat.isDirectory() ? "directory" : "file", stat });
      if (stat.isDirectory()) visit(target, relative);
    }
  }
  visit(payloadPath, "");
  return entries;
}

function verifyBackup({ paths, backupId }, expectedScope = null) {
  assertBackupPaths(paths);
  const backupPath = backupPathFor(paths, backupId);
  const backupStat = fs.lstatSync(backupPath);
  if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) {
    throw backupError("BACKUP_CORRUPT", "备份目录无效");
  }
  assertOwned(backupStat, backupPath);
  const manifest = readManifest(backupPath, backupId, expectedScope, backupStat);
  assertUnchangedBackupDirectory(backupPath, backupStat, "备份目录");
  const payloadPath = path.join(backupPath, "payload");
  const payloadStat = fs.lstatSync(payloadPath);
  if (!payloadStat.isDirectory() || payloadStat.isSymbolicLink()) {
    throw backupError("BACKUP_CORRUPT", "备份 payload 无效");
  }
  assertOwned(payloadStat, payloadPath);
  assertUnchangedBackupDirectory(backupPath, backupStat, "备份目录");
  const actualEntries = scanPayload(payloadPath);
  assertUnchangedBackupDirectory(payloadPath, payloadStat, "备份 payload");
  assertUnchangedBackupDirectory(backupPath, backupStat, "备份目录");
  if (actualEntries.length !== manifest.entries.length) {
    throw backupError("BACKUP_CORRUPT", "备份 payload 与清单数量不一致");
  }
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const expected = manifest.entries[index];
    const actual = actualEntries[index];
    if (actual.path !== expected.path || actual.type !== expected.type) {
      throw backupError("BACKUP_CORRUPT", "备份 payload 与清单路径不一致");
    }
    if (expected.type === "directory") {
      if ((actual.stat.mode & 0o077) !== 0) {
        throw backupError("BACKUP_CORRUPT", "备份目录权限过宽");
      }
    } else if ((actual.stat.mode & 0o077) !== 0 || actual.stat.size !== expected.size
      || sha256File(path.join(payloadPath, expected.path)) !== expected.sha256) {
      throw backupError("BACKUP_CORRUPT", "备份文件摘要、大小或权限无效");
    }
  }
  assertUnchangedBackupDirectory(payloadPath, payloadStat, "备份 payload");
  assertUnchangedBackupDirectory(backupPath, backupStat, "备份目录");
  return Object.freeze({ backupPath, manifest: structuredClone(manifest) });
}

function verifyAuthorityBackup(options) {
  return verifyBackup(options);
}

function assertUnchangedMetadataPayloadDirectory(payloadPath, expected) {
  const current = fs.lstatSync(payloadPath);
  if (!current.isDirectory() || current.isSymbolicLink()
    || !sameFileVersion(expected, current)) {
    throw backupError("BACKUP_CORRUPT", "Runtime schema metadata payload 目录发生变化");
  }
  assertOwned(current, payloadPath);
}

function verifyPinnedMetadataPayloadFile(payloadPath, entry, payloadDirectoryStat) {
  const target = path.join(payloadPath, entry.path);
  assertUnchangedMetadataPayloadDirectory(payloadPath, payloadDirectoryStat);
  const before = fs.lstatSync(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw backupError("BACKUP_CORRUPT", "Runtime schema metadata payload 含不安全文件");
  }
  assertOwned(before, target);
  if ((before.mode & 0o077) !== 0 || before.size !== entry.size) {
    throw backupError("BACKUP_CORRUPT", "Runtime schema metadata payload 文件大小或权限无效");
  }

  let fd;
  try {
    try {
      fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    } catch (error) {
      if (error?.code === "ELOOP") {
        throw backupError("BACKUP_CORRUPT", "Runtime schema metadata payload 不允许 symlink");
      }
      throw error;
    }
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !sameFileVersion(before, opened)) {
      throw backupError("BACKUP_CORRUPT", "Runtime schema metadata payload 文件发生变化");
    }
    assertOwned(opened, target);
    assertUnchangedMetadataPayloadDirectory(payloadPath, payloadDirectoryStat);

    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytesRead = 0;
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      bytesRead += bytes;
      if (bytesRead > entry.size) {
        throw backupError("BACKUP_CORRUPT", "Runtime schema metadata payload 文件大小无效");
      }
      hash.update(buffer.subarray(0, bytes));
    }
    const after = fs.fstatSync(fd);
    const pathAfter = fs.lstatSync(target);
    if (!after.isFile() || !pathAfter.isFile() || pathAfter.isSymbolicLink()
      || after.nlink !== 1 || pathAfter.nlink !== 1
      || !sameFileVersion(before, after) || !sameFileVersion(before, pathAfter)
      || bytesRead !== entry.size || hash.digest("hex") !== entry.sha256) {
      throw backupError("BACKUP_CORRUPT", "Runtime schema metadata payload 摘要或版本无效");
    }
    assertOwned(after, target);
    assertOwned(pathAfter, target);
    assertUnchangedMetadataPayloadDirectory(payloadPath, payloadDirectoryStat);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function verifyRuntimeSchemaMetadataPayload(
  backupPath,
  backupDirectoryStat,
  manifest,
  expectedPaths,
) {
  assertUnchangedBackupDirectory(backupPath, backupDirectoryStat, "Runtime schema metadata 备份目录");
  const payloadPath = path.join(backupPath, "payload");
  const payloadDirectoryStat = fs.lstatSync(payloadPath);
  if (!payloadDirectoryStat.isDirectory() || payloadDirectoryStat.isSymbolicLink()) {
    throw backupError("BACKUP_CORRUPT", "Runtime schema metadata payload 无效");
  }
  assertOwned(payloadDirectoryStat, payloadPath);
  assertUnchangedMetadataPayloadDirectory(payloadPath, payloadDirectoryStat);
  assertUnchangedBackupDirectory(backupPath, backupDirectoryStat, "Runtime schema metadata 备份目录");

  let directory;
  const names = [];
  try {
    directory = fs.opendirSync(payloadPath);
    assertUnchangedMetadataPayloadDirectory(payloadPath, payloadDirectoryStat);
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      names.push(entry.name);
    }
  } finally {
    directory?.closeSync();
  }
  names.sort((left, right) => left.localeCompare(right));
  assertUnchangedMetadataPayloadDirectory(payloadPath, payloadDirectoryStat);
  assertUnchangedBackupDirectory(backupPath, backupDirectoryStat, "Runtime schema metadata 备份目录");
  if (JSON.stringify(names) !== JSON.stringify(expectedPaths)) {
    throw backupError("BACKUP_SCOPE_MISMATCH", "Runtime schema metadata payload 含缺失或额外条目");
  }
  for (const entry of manifest.entries) {
    assertUnchangedBackupDirectory(backupPath, backupDirectoryStat, "Runtime schema metadata 备份目录");
    verifyPinnedMetadataPayloadFile(payloadPath, entry, payloadDirectoryStat);
  }
  assertUnchangedMetadataPayloadDirectory(payloadPath, payloadDirectoryStat);
  assertUnchangedBackupDirectory(backupPath, backupDirectoryStat, "Runtime schema metadata 备份目录");
}

function sha256FileDescriptor(fd) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  for (;;) {
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (bytes === 0) break;
    hash.update(buffer.subarray(0, bytes));
    position += bytes;
  }
  return hash.digest("hex");
}

function completeEventPrefixLength(fd, size) {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - buffer.length);
    const length = end - start;
    const bytes = fs.readSync(fd, buffer, 0, length, start);
    if (bytes !== length) {
      throw backupError("BACKUP_CORRUPT", "Runtime schema metadata event log 读取不完整");
    }
    const newline = buffer.subarray(0, bytes).lastIndexOf(0x0a);
    if (newline >= 0) return start + newline + 1;
    end = start;
  }
  return 0;
}

function filePrefixMatches(leftFd, rightFd, length) {
  const left = Buffer.allocUnsafe(64 * 1024);
  const right = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < length) {
    const expected = Math.min(left.length, length - position);
    const leftBytes = fs.readSync(leftFd, left, 0, expected, position);
    const rightBytes = fs.readSync(rightFd, right, 0, expected, position);
    if (leftBytes !== expected || rightBytes !== expected
      || !left.subarray(0, expected).equals(right.subarray(0, expected))) {
      return false;
    }
    position += expected;
  }
  return true;
}

function eventSuffixUsesSchema(fd, start, size, targetSchemaVersion) {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let pending = Buffer.alloc(0);
  let position = start;
  while (position < size) {
    const expected = Math.min(buffer.length, size - position);
    const bytes = fs.readSync(fd, buffer, 0, expected, position);
    if (bytes !== expected) return false;
    position += bytes;
    const combined = pending.length === 0
      ? Buffer.from(buffer.subarray(0, bytes))
      : Buffer.concat([pending, buffer.subarray(0, bytes)]);
    let cursor = 0;
    for (;;) {
      const newline = combined.indexOf(0x0a, cursor);
      if (newline < 0) break;
      const line = combined.subarray(cursor, newline);
      if (line.length === 0 || line.length > MAX_RUNTIME_SCHEMA_EVENT_LINE_BYTES) return false;
      let event;
      try { event = JSON.parse(line.toString("utf8")); } catch { return false; }
      if (event?.schemaVersion !== targetSchemaVersion) return false;
      cursor = newline + 1;
    }
    pending = Buffer.from(combined.subarray(cursor));
    if (pending.length > MAX_RUNTIME_SCHEMA_EVENT_LINE_BYTES) return false;
  }
  // ProductStore 会在 open 时丢弃没有换行的崩溃残尾；它不属于已提交事件。
  return true;
}

function currentEventLogContinuesBackup(
  currentTarget,
  backupTarget,
  targetSchemaVersion,
) {
  return withPinnedRegularFile(
    backupTarget,
    { code: "BACKUP_CORRUPT", message: "Runtime schema metadata event backup 发生变化" },
    (backupFd, backupStat) => withPinnedRegularFile(
      currentTarget,
      { code: "BACKUP_SOURCE_MISMATCH", message: "Runtime schema migration 输入已变化" },
      (currentFd, currentStat) => {
        const prefixLength = completeEventPrefixLength(backupFd, backupStat.size);
        return currentStat.size >= prefixLength
          && filePrefixMatches(backupFd, currentFd, prefixLength)
          && eventSuffixUsesSchema(
            currentFd,
            prefixLength,
            currentStat.size,
            targetSchemaVersion,
          );
      },
    ),
  );
}

function verifyRuntimeSchemaMetadataSources(options, verified) {
  const requirements = options.sourceRequirements;
  if (requirements === undefined) return;
  if (!Array.isArray(requirements)) {
    throw backupError("BACKUP_SOURCE_MISMATCH", "Runtime schema migration 输入约束无效");
  }
  const seen = new Set();
  const entries = new Map(verified.manifest.entries.map((entry) => [entry.path, entry]));
  for (const requirement of requirements) {
    if (!requirement || typeof requirement.path !== "string"
      || !RUNTIME_SCHEMA_METADATA_FILES.includes(requirement.path)
      || !RUNTIME_SCHEMA_SOURCE_MATCHES.has(requirement.match)
      || seen.has(requirement.path)
      || (requirement.match === "event-log-continuation"
        && (!Number.isSafeInteger(requirement.targetSchemaVersion)
          || requirement.targetSchemaVersion < 1))) {
      throw backupError("BACKUP_SOURCE_MISMATCH", "Runtime schema migration 输入约束无效");
    }
    seen.add(requirement.path);
    const entry = entries.get(requirement.path);
    if (!entry) {
      throw backupError("BACKUP_SOURCE_MISMATCH", `备份缺少仍待迁移的 metadata: ${requirement.path}`);
    }
    const currentTarget = path.join(options.paths.stateDir, requirement.path);
    if (requirement.match === "exact") {
      let stat;
      try { stat = fs.lstatSync(currentTarget); } catch {
        throw backupError("BACKUP_SOURCE_MISMATCH", "Runtime schema migration 输入已变化");
      }
      const digest = withPinnedRegularFile(
        currentTarget,
        {
          before: stat,
          code: "BACKUP_SOURCE_MISMATCH",
          message: "Runtime schema migration 输入已变化",
        },
        sha256FileDescriptor,
      );
      if (stat.size !== entry.size || digest !== entry.sha256) {
        throw backupError("BACKUP_SOURCE_MISMATCH", "Runtime schema migration 输入已变化");
      }
      continue;
    }
    const backupTarget = path.join(verified.backupPath, "payload", requirement.path);
    if (!currentEventLogContinuesBackup(
      currentTarget,
      backupTarget,
      requirement.targetSchemaVersion,
    )) {
      throw backupError("BACKUP_SOURCE_MISMATCH", "Runtime schema migration event 输入已变化");
    }
  }
}

function verifyRuntimeSchemaMetadataBackupWithFence(options, activeWriterLocks) {
  if (!options?.activeServiceLock) {
    throw backupError("BACKUP_SERVICE_ACTIVE", "Runtime schema metadata 验证需要当前 Service lock");
  }
  assertBackupPaths(options.paths);
  assertServiceStopped(options.paths, options.activeServiceLock, activeWriterLocks);
  const backupPath = backupPathFor(options.paths, options.backupId);
  const backupStat = fs.lstatSync(backupPath);
  if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) {
    throw backupError("BACKUP_CORRUPT", "Runtime schema metadata 备份目录无效");
  }
  assertOwned(backupStat, backupPath);
  const manifest = readManifest(
    backupPath,
    options.backupId,
    RUNTIME_SCHEMA_METADATA_BACKUP_SCOPE,
    backupStat,
  );
  assertUnchangedBackupDirectory(backupPath, backupStat, "Runtime schema metadata 备份目录");
  const actual = manifest.entries.map((entry) => entry.path);
  const expected = RUNTIME_SCHEMA_METADATA_FILES.filter((name) => actual.includes(name));
  if (manifest.entries.some((entry) => entry.type !== "file")
    || actual.length === 0
    || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw backupError("BACKUP_SCOPE_MISMATCH", "Runtime schema metadata 备份范围无效");
  }
  verifyRuntimeSchemaMetadataPayload(backupPath, backupStat, manifest, actual);
  const verified = Object.freeze({ backupPath, manifest: structuredClone(manifest) });
  verifyRuntimeSchemaMetadataSources(options, verified);
  assertUnchangedBackupDirectory(backupPath, backupStat, "Runtime schema metadata 备份目录");
  assertServiceStopped(options.paths, options.activeServiceLock, activeWriterLocks);
  return verified;
}

function verifyRuntimeSchemaMetadataBackup(options) {
  if (!options?.activeServiceLock) {
    throw backupError("BACKUP_SERVICE_ACTIVE", "Runtime schema metadata 验证需要当前 Service lock");
  }
  return withRuntimeSchemaMetadataWriterFence(
    options,
    (activeWriterLocks) => verifyRuntimeSchemaMetadataBackupWithFence(
      options,
      activeWriterLocks,
    ),
  );
}

function restoreAuthorityBackup({ paths, backupId, destinationStateDir }) {
  const verified = verifyAuthorityBackup({ paths, backupId });
  const destination = assertContained(paths.trustedRoot, destinationStateDir, "BACKUP_RESTORE_PATH_INVALID");
  if (destination === path.resolve(paths.stateDir)
    || destination.startsWith(`${path.resolve(paths.backupsDir)}${path.sep}`)) {
    throw backupError("BACKUP_RESTORE_PATH_INVALID", "恢复目标不能覆盖当前 state 或备份目录");
  }
  if (lstatIfExists(destination)) {
    throw backupError("BACKUP_RESTORE_TARGET_EXISTS", "恢复目标必须不存在");
  }
  const parent = path.dirname(destination);
  if (parent === path.resolve(paths.trustedRoot)) assertPrivateDirectory(parent);
  else ensurePrivateDirectoryTree(parent, paths.trustedRoot);
  const staging = assertContained(
    paths.trustedRoot,
    path.join(parent, `.${path.basename(destination)}.restore-${crypto.randomUUID()}`),
    "BACKUP_RESTORE_PATH_INVALID",
  );
  const payloadPath = path.join(verified.backupPath, "payload");
  try {
    ensurePrivateDirectoryTree(staging, paths.trustedRoot);
    const directoryModes = [];
    for (const entry of verified.manifest.entries) {
      const source = path.join(payloadPath, entry.path);
      const target = path.join(staging, ...entry.path.split("/"));
      if (entry.type === "directory") {
        fs.mkdirSync(target, { mode: 0o700 });
        fs.chmodSync(target, 0o700);
        directoryModes.push([target, entry.mode]);
      } else {
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(target, entry.mode);
        fsyncFile(target);
        if (fs.lstatSync(target).size !== entry.size || sha256File(target) !== entry.sha256) {
          throw backupError("BACKUP_RESTORE_MISMATCH", "恢复文件摘要不一致");
        }
      }
    }
    fsyncDirectoryTree(staging);
    for (const [target, mode] of directoryModes.reverse()) fs.chmodSync(target, mode);
    fsyncDirectory(staging);
    fs.renameSync(staging, destination);
    fsyncDirectory(parent);
    return Object.freeze({
      destinationStateDir: destination,
      backupId,
      rootDigest: verified.manifest.rootDigest,
    });
  } catch (error) {
    cleanupStaging(staging);
    throw error;
  }
}

module.exports = {
  BACKUP_SCHEMA_VERSION,
  RUNTIME_SCHEMA_METADATA_FILES,
  RUNTIME_SCHEMA_METADATA_BACKUP_SCHEMA_VERSION,
  RUNTIME_SCHEMA_METADATA_BACKUP_SCOPE,
  acquireRuntimeSchemaMetadataWriterFence,
  createAuthorityBackup,
  createRuntimeSchemaMetadataBackup,
  restoreAuthorityBackup,
  verifyAuthorityBackup,
  verifyRuntimeSchemaMetadataBackup,
};
