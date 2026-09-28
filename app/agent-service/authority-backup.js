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
const { validateCanonicalOwnedDirectory } = require("./runtime-storage-inspector");
const { readPrivateFile, validatePrivateStat } = require("./private-file");

const BACKUP_SCHEMA_VERSION = 1;
const MAX_BACKUP_MANIFEST_BYTES = 16 * 1024 * 1024;
const BACKUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const AUTHORITY_BACKUP_RUNTIME_HOME_MODES = Object.freeze([
  "minimal",
]);
const RETIRED_RUNTIME_HOME_ROOTS = new Set([
  "codex",
  "grok-build",
  "antigravity",
  "pi",
  "claude-code",
  "opencode",
  "deepseek-harness",
]);
const MANAGED_CODEX_BACKUP_FILES = new Set(["auth.json", "config.toml", ".shoggoth-native-auth.json"]);
const OPAQUE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RECALL_PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

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

function minimalAuthorityPathDisposition(relativePath) {
  const parts = relativePath.split(path.sep);
  const [root] = parts;
  if (root === "agents" && parts.length === 3
    && /^native-memory-semantic\.sqlite(?:-(?:wal|shm|journal))?$/u.test(parts[2])) return "exclude";
  if ((root === "plugins" || root === "skills") && parts[1] === "staging") return "exclude";
  if (root === "runtime-integration") return "exclude";
  if (["legacy-runtime-homes", "native-runtime-imports"].includes(root)
    || RETIRED_RUNTIME_HOME_ROOTS.has(root)) return "exclude";
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
  return minimalAuthorityPathDisposition(relativePath);
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

function assertServiceStopped(paths, activeServiceLock = null) {
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
  if (fs.readdirSync(paths.stateDir).some(name => name.endsWith(".writer.lock"))) {
    throw backupError("BACKUP_SERVICE_ACTIVE", "持久化 writer 未关闭，不能建立一致备份");
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
  },
  copyPayload,
) {
  assertBackupPaths(paths);
  assertPrivateDirectory(paths.stateDir);
  assertServiceStopped(paths, activeServiceLock);
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
    assertServiceStopped(paths, activeServiceLock);
    const manifest = { schemaVersion: BACKUP_SCHEMA_VERSION, backupId, createdAt,
      sourceRoot: "stateDir", entries, rootDigest: rootDigest(entries) };
    writeManifest(path.join(stagingPath, "manifest.json"), manifest);
    fsyncDirectoryTree(payloadPath);
    fsyncDirectory(stagingPath);
    fs.renameSync(stagingPath, backupPath);
    fsyncDirectory(paths.backupsDir);
    assertServiceStopped(paths, activeServiceLock);
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
    options,
    (sourceRoot, payloadRoot) => copyAuthorityTree(sourceRoot, payloadRoot, runtimeHomeMode),
  );
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

function readManifest(backupPath, backupId, backupDirectoryStat = null) {
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
  const expectedKeys = "schemaVersion,backupId,createdAt,sourceRoot,entries,rootDigest";
  const expectedVersion = BACKUP_SCHEMA_VERSION;
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

function verifyBackup({ paths, backupId }) {
  assertBackupPaths(paths);
  const backupPath = backupPathFor(paths, backupId);
  const backupStat = fs.lstatSync(backupPath);
  if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) {
    throw backupError("BACKUP_CORRUPT", "备份目录无效");
  }
  assertOwned(backupStat, backupPath);
  const manifest = readManifest(backupPath, backupId, backupStat);
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

function recallPolicyProfileIds(stateRoot, trustedRoot) {
  const agentsDir = path.join(stateRoot, "agents");
  if (!lstatIfExists(agentsDir)) return new Set();
  validateCanonicalOwnedDirectory(agentsDir, { trustedRoot });
  const ids = new Set();
  const installationDir = path.join(agentsDir, ".recall-policy-installations");
  if (lstatIfExists(installationDir)) {
    validateCanonicalOwnedDirectory(installationDir, { trustedRoot });
    for (const name of fs.readdirSync(installationDir)) {
      if (!name.endsWith(".json") || !RECALL_PROFILE_ID_PATTERN.test(name.slice(0, -5))) {
        throw backupError("BACKUP_RECALL_POLICY_UNSAFE", "撤回账本安装目录包含未识别的文件");
      }
      ids.add(name.slice(0, -5));
    }
  }
  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!RECALL_PROFILE_ID_PATTERN.test(entry.name)) continue;
    const profileDir = path.join(agentsDir, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw backupError("BACKUP_RECALL_POLICY_UNSAFE", "撤回账本 Profile 目录不安全");
    }
    const memoryDir = path.join(profileDir, "memory");
    if (lstatIfExists(path.join(profileDir, "recall-policy-installed.json"))
      || lstatIfExists(path.join(memoryDir, "recall-policy.jsonl"))
      || lstatIfExists(path.join(memoryDir, "recall-policy.seal.json"))) ids.add(entry.name);
  }
  return ids;
}

function readRecallPolicyForRestore(stateRoot, trustedRoot, profileId) {
  const { RecallPolicyStore } = require("./recall-policy-store");
  const store = new RecallPolicyStore({ paths: { agentsDir: path.join(stateRoot, "agents"), trustedRoot },
    memoryStore: null });
  const targets = store._paths(profileId);
  const state = store._read(profileId, targets);
  return { targets, state, checksums: state.records.map((record) => record.checksum),
    identities: [state.identity, state.sealIdentity, state.markerIdentity, state.installationIdentity] };
}

function stableMemoryJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableMemoryJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableMemoryJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function readMemoryJournalForRestore(stateRoot, profileId) {
  const target = path.join(stateRoot, "agents", profileId, "memory", "events.jsonl");
  const stat = lstatIfExists(target);
  if (!stat) return null;
  validatePrivateStat(stat, target);
  const bytes = readPrivateFile(target, { maxBytes: 256 * 1024 * 1024 });
  if (bytes.length && bytes.at(-1) !== 0x0a) {
    throw backupError("BACKUP_MEMORY_UNSAFE", "主记忆 journal 尾部不完整");
  }
  const { validateMemoryItem } = require("./memory-store");
  const items = new Map();
  const proofs = new Map();
  const lines = bytes.length ? bytes.toString("utf8").slice(0, -1).split("\n") : [];
  for (let index = 0; index < lines.length; index += 1) {
    let record;
    try { record = JSON.parse(lines[index]); }
    catch { throw backupError("BACKUP_MEMORY_UNSAFE", "主记忆 journal 无效"); }
    const { checksum, ...body } = record || {};
    if (record?.schemaVersion !== 1 || record.seq !== index + 1 || record.type !== "memory.batch"
      || Object.keys(record).length !== 5 || !Array.isArray(record.items)
      || record.items.length < 1 || record.items.length > 128
      || !SHA256_PATTERN.test(checksum)
      || crypto.createHash("sha256").update(stableMemoryJson(body)).digest("hex") !== checksum) {
      throw backupError("BACKUP_MEMORY_UNSAFE", "主记忆 journal 校验失败");
    }
    for (const raw of record.items) {
      let item;
      try { item = validateMemoryItem(raw, profileId); }
      catch { throw backupError("BACKUP_MEMORY_UNSAFE", "主记忆 journal item 无效"); }
      items.set(item.id, item);
      proofs.set(item.id, { seq: record.seq, checksum });
    }
  }
  return { target, digest: crypto.createHash("sha256").update(bytes).digest("hex"), items, proofs };
}

function originalSourceRefs(item) {
  return item.sourceRefs.filter((ref) => !/^(?:workspace:|user-edit:|codex-memory:)/u.test(ref));
}

function assertRestoredActiveMemoryDoesNotWiden(sourceItem, backupItem) {
  const sensitivityRank = { normal: 0, private: 1, restricted: 2 };
  const sourceRefs = [...sourceItem.sourceRefs].sort();
  const backupRefs = [...backupItem.sourceRefs].sort();
  if (sourceItem.content !== backupItem.content || sourceItem.scope !== backupItem.scope
    || sourceItem.type !== backupItem.type || JSON.stringify(sourceRefs) !== JSON.stringify(backupRefs)
    || backupItem.validFrom < sourceItem.validFrom
    || (sourceItem.validUntil !== null
      && (backupItem.validUntil === null || backupItem.validUntil > sourceItem.validUntil))
    || sensitivityRank[backupItem.sensitivity] < sensitivityRank[sourceItem.sensitivity]) {
    throw backupError("BACKUP_MEMORY_DIVERGED", "备份将放宽当前记忆的来源、有效期或敏感度");
  }
}

function assertRestoredMemoryDoesNotReviveSource(stateRoot, stagingRoot, sourcePolicies, trustedRoot) {
  const agentsDir = path.join(stateRoot, "agents");
  if (!lstatIfExists(agentsDir)) return [];
  validateCanonicalOwnedDirectory(agentsDir, { trustedRoot });
  const checked = [];
  const { hashContent } = require("./recall-policy-store");
  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!RECALL_PROFILE_ID_PATTERN.test(entry.name) || !entry.isDirectory()) continue;
    const profileId = entry.name;
    const source = readMemoryJournalForRestore(stateRoot, profileId);
    const backup = readMemoryJournalForRestore(stagingRoot, profileId);
    if (!source) {
      if (backup?.items.size) {
        throw backupError("BACKUP_MEMORY_DIVERGED", "备份将恢复当前源没有的主记忆 journal");
      }
      continue;
    }
    checked.push({ profileId, target: source.target, digest: source.digest });
    if (!backup || source.digest === backup.digest) continue;
    const policy = sourcePolicies.get(profileId)?.state;
    for (const [id, backupItem] of backup.items) {
      const sourceItem = source.items.get(id);
      if (!sourceItem) {
        if (backupItem.status === "active") {
          throw backupError("BACKUP_MEMORY_DIVERGED", "备份将复活当前源不存在的 active 记忆");
        }
        continue;
      }
      if (!["active", "deleted"].includes(sourceItem.status) && backupItem.status === "active") {
        throw backupError("BACKUP_MEMORY_DIVERGED", "备份将恢复当前未激活的旧记忆");
      }
      if (sourceItem.status === "active" && backupItem.status === "active") {
        assertRestoredActiveMemoryDoesNotWiden(sourceItem, backupItem);
      }
      if (sourceItem.status !== "deleted") continue;
      const sourceProof = source.proofs.get(id);
      const backupProof = backup.proofs.get(id);
      if (backupItem.status === "deleted"
        && sourceProof.seq === backupProof.seq && sourceProof.checksum === backupProof.checksum) continue;
      const sourceHash = hashContent(sourceItem.content);
      const matching = (policy?.byMemory.get(id) || []).filter((record) => (
        record.memoryId === id && record.contentHash === sourceHash
        || record.related?.some((related) => related.memoryId === id && related.contentHash === sourceHash)));
      const suppressed = matching.some((record) => ["forgotten", "user_deleted", "legacy_unknown"].includes(record.reason));
      if (suppressed && originalSourceRefs(backupItem).some((ref) => !policy.suppressedRefs.has(ref))) {
        throw backupError("BACKUP_RECALL_POLICY_UNCOVERED_SOURCE",
          "备份含当前撤回账本未覆盖的原话来源，不能恢复旧快照");
      }
      const expired = matching.some((record) => {
        if (record.reason !== "expired") return false;
        const proof = policy.expiryCommits.get(record.operationId);
        return proof?.primarySeq === sourceProof.seq && proof.primaryChecksum === sourceProof.checksum;
      });
      if (!suppressed && expired && backupItem.status === "active") {
        assertRestoredActiveMemoryDoesNotWiden(sourceItem, backupItem);
      }
      if (!suppressed && !expired) {
        throw backupError("BACKUP_RECALL_POLICY_UNCOVERED_DELETION",
          "当前源存在未纳入撤回账本的删除，不能恢复旧快照");
      }
    }
  }
  return checked;
}

function reconcileRestoredMemory(stagingRoot, trustedRoot) {
  // Make revocations durable in the primary journal before publication. An
  // older App ignores the policy ledger and would otherwise read old active
  // items until the newer App first opened the restored state.
  const { resolveServicePaths } = require("./paths");
  const { MemoryStore } = require("./memory-store");
  const { RecallPolicyStore, normalizeContent } = require("./recall-policy-store");
  const canonicalRoot = fs.realpathSync(trustedRoot);
  const canonicalStaging = path.join(canonicalRoot, path.relative(trustedRoot, stagingRoot));
  const paths = resolveServicePaths({ stateRoot: canonicalStaging, trustedRoot: canonicalRoot });
  const profileIds = recallPolicyProfileIds(canonicalStaging, canonicalRoot);
  const agentsDir = path.join(canonicalStaging, "agents");
  if (lstatIfExists(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (RECALL_PROFILE_ID_PATTERN.test(entry.name)
        && lstatIfExists(path.join(agentsDir, entry.name, "memory", "events.jsonl"))) {
        profileIds.add(entry.name);
      }
    }
  }
  const memoryStore = new MemoryStore({ paths });
  const policyStore = new RecallPolicyStore({ paths, memoryStore });
  memoryStore.open();
  try {
    policyStore.open();
    const orderedProfiles = [...profileIds].sort();
    for (const profileId of orderedProfiles) policyStore.assertReady(profileId);
    let deleted = 0;
    for (const profileId of orderedProfiles) {
      const state = policyStore.assertReady(profileId);
      const hidden = [];
      for (const item of memoryStore.list(profileId, { status: "active" })) {
        const visible = policyStore.isMemoryVisible(profileId, item);
        if (visible && state.contentCutoffs.has(normalizeContent(item.content))) {
          // The staging reconciliation has no verified live user source with
          // which to prove an apparent reauthorization. Refuse the restore.
          throw backupError("BACKUP_RECALL_POLICY_UNVERIFIED_SOURCE",
            "恢复副本的同内容新来源不可验证");
        }
        if (!visible) hidden.push({ ...item, status: "deleted",
          updatedAt: Math.max(item.updatedAt, Date.now()) });
      }
      for (let offset = 0; offset < hidden.length; offset += 128) {
        memoryStore.upsertMany(hidden.slice(offset, offset + 128));
      }
      deleted += hidden.length;
    }
    if (deleted > 0) {
      // The newly deleted siblings gain conservative legacy reasons. Their
      // source refs can hide further memories; never publish such an active
      // item without another complete policy reconciliation.
      policyStore.close();
      policyStore.open();
      for (const profileId of orderedProfiles) {
        const state = policyStore.assertReady(profileId);
        for (const item of memoryStore.list(profileId, { status: "active" })) {
          if (!policyStore.isMemoryVisible(profileId, item)
            || state.contentCutoffs.has(normalizeContent(item.content))) {
            throw backupError("BACKUP_RECALL_POLICY_RECONCILE_UNSAFE",
              "恢复副本仍含撤回策略隐藏的 active 记忆");
          }
        }
      }
    }
  } finally {
    policyStore.close();
    memoryStore.close();
  }
}

function sameRecallPolicy(left, right) {
  return JSON.stringify(left.checksums) === JSON.stringify(right.checksums)
    && JSON.stringify(left.identities) === JSON.stringify(right.identities);
}

function restoreRecallPolicyHighWater(paths, staging) {
  // The old snapshot may predate a forget. A second copy of the current
  // verified ledger in the staging directory retains the later suppression.
  // Divergent journals cannot be safely merged and therefore abort restore.
  const trustedRoot = fs.realpathSync(paths.trustedRoot);
  const sourceRoot = path.join(trustedRoot, path.relative(paths.trustedRoot, paths.stateDir));
  const stagingRoot = path.join(trustedRoot, path.relative(paths.trustedRoot, staging));
  const sourceIds = recallPolicyProfileIds(sourceRoot, trustedRoot);
  const backupIds = recallPolicyProfileIds(stagingRoot, trustedRoot);
  const sourceInstallationDirectory = lstatIfExists(path.join(sourceRoot, "agents",
    ".recall-policy-installations"));
  const sourceBefore = new Map();
  const restored = [];
  for (const profileId of [...new Set([...sourceIds, ...backupIds])].sort()) {
    let source = null;
    let backup = null;
    try {
      if (sourceIds.has(profileId)) source = readRecallPolicyForRestore(sourceRoot,
        trustedRoot, profileId);
      if (backupIds.has(profileId)) backup = readRecallPolicyForRestore(stagingRoot,
        trustedRoot, profileId);
    } catch (cause) {
      const error = backupError("BACKUP_RECALL_POLICY_UNSAFE", "源或备份的撤回账本不可验证");
      error.cause = cause;
      throw error;
    }
    if (backup && !source && sourceInstallationDirectory) {
      // A Profile removed after this backup may have had its installation
      // anchor deliberately purged. Restoring its old ledger would recreate
      // revoked data with no current Profile to reconcile against.
      throw backupError("BACKUP_RECALL_POLICY_MISSING", "备份中的 Profile 不在当前撤回账本中");
    }
    if (source) sourceBefore.set(profileId, source);
    if (source && backup) {
      const common = Math.min(source.checksums.length, backup.checksums.length);
      if (source.checksums.slice(0, common).some((hash, index) => hash !== backup.checksums[index])) {
        throw backupError("BACKUP_RECALL_POLICY_DIVERGED", "源与备份的撤回账本已分叉");
      }
    }
    if (!source || (backup && backup.checksums.length >= source.checksums.length)) continue;
    const targets = {
      dir: path.join(stagingRoot, "agents", profileId, "memory"),
      installationDir: path.join(stagingRoot, "agents", ".recall-policy-installations"),
      log: path.join(stagingRoot, "agents", profileId, "memory", "recall-policy.jsonl"),
      seal: path.join(stagingRoot, "agents", profileId, "memory", "recall-policy.seal.json"),
      marker: path.join(stagingRoot, "agents", profileId, "recall-policy-installed.json"),
      installation: path.join(stagingRoot, "agents", ".recall-policy-installations", `${profileId}.json`),
    };
    ensurePrivateDirectoryTree(targets.dir, trustedRoot);
    ensurePrivateDirectoryTree(targets.installationDir, trustedRoot);
    for (const key of ["log", "seal", "marker", "installation"]) {
      if (lstatIfExists(targets[key])) fs.unlinkSync(targets[key]);
      copyAuthorityFile(source.targets[key], targets[key], path.relative(sourceRoot, source.targets[key]),
        fs.lstatSync(source.targets[key]));
    }
    let copied;
    try { copied = readRecallPolicyForRestore(stagingRoot, trustedRoot, profileId); }
    catch (cause) {
      const error = backupError("BACKUP_RECALL_POLICY_UNSAFE", "恢复后的撤回账本不可验证");
      error.cause = cause;
      throw error;
    }
    if (JSON.stringify(copied.checksums) !== JSON.stringify(source.checksums)) {
      throw backupError("BACKUP_RECALL_POLICY_UNSAFE", "恢复后的撤回账本与当前源不一致");
    }
    restored.push({ profileId, headSeq: source.checksums.length,
      headChecksum: source.checksums.at(-1) });
  }
  const sourceMemoryBefore = assertRestoredMemoryDoesNotReviveSource(sourceRoot, stagingRoot,
    sourceBefore, trustedRoot);
  const verifySourceUnchanged = () => {
    for (const [profileId, before] of sourceBefore) {
      let after;
      try { after = readRecallPolicyForRestore(sourceRoot, trustedRoot, profileId); }
      catch { throw backupError("BACKUP_SOURCE_CHANGED", "恢复期间当前撤回账本不可读取"); }
      if (!sameRecallPolicy(before, after)) {
        throw backupError("BACKUP_SOURCE_CHANGED", "恢复期间当前撤回账本发生变化");
      }
    }
    for (const source of sourceMemoryBefore) {
      if (!lstatIfExists(source.target) || sha256File(source.target) !== source.digest) {
        throw backupError("BACKUP_SOURCE_CHANGED", "恢复期间当前主记忆 journal 发生变化");
      }
    }
  };
  return { restored, verifySourceUnchanged };
}

function invalidateRestoredNativeMemoryAnchors(staging, trustedRoot) {
  const canonicalRoot = fs.realpathSync(trustedRoot);
  const stagingRoot = path.join(canonicalRoot, path.relative(trustedRoot, staging));
  const agentsDir = path.join(stagingRoot, "agents");
  if (!lstatIfExists(agentsDir)) return 0;
  validateCanonicalOwnedDirectory(agentsDir, { trustedRoot: canonicalRoot });
  let removed = 0;
  for (const profile of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!RECALL_PROFILE_ID_PATTERN.test(profile.name)) continue;
    if (!profile.isDirectory() || profile.isSymbolicLink()) {
      throw backupError("BACKUP_RESTORE_UNSAFE", "恢复副本中的 Profile 目录不安全");
    }
    const checkpointDir = path.join(agentsDir, profile.name, "conversation-checkpoints");
    if (!lstatIfExists(checkpointDir)) continue;
    validateCanonicalOwnedDirectory(checkpointDir, { trustedRoot: canonicalRoot });
    for (const name of fs.readdirSync(checkpointDir)) {
      if (!name.endsWith(".native-memory-anchor.json")) continue;
      const target = path.join(checkpointDir, name);
      validatePrivateStat(fs.lstatSync(target), target);
      fs.unlinkSync(target);
      removed += 1;
    }
    fsyncDirectory(checkpointDir);
  }
  return removed;
}

function restoreAuthorityBackup({ paths, backupId, destinationStateDir }) {
  const verified = verifyAuthorityBackup({ paths, backupId });
  assertServiceStopped(paths);
  const hasPluginCatalog = verified.manifest.entries.some(entry => entry.type === "file"
    && entry.path === "plugins/catalog.sqlite");
  let pluginBarrier = null;
  let sourceCatalogStat = null;
  // An old snapshot can predate a completed external write or a revocation.
  // Merge only no-replay evidence from a stopped source; never copy its grants.
  if (hasPluginCatalog) {
    assertServiceStopped(paths);
    sourceCatalogStat = lstatIfExists(paths.pluginCatalogPath);
    const { readPluginRestoreBarrier } = require("./plugin-store");
    pluginBarrier = readPluginRestoreBarrier(paths);
  }
  const assertPluginSourceUnchanged = () => {
    if (!hasPluginCatalog) return;
    assertServiceStopped(paths);
    const current = lstatIfExists(paths.pluginCatalogPath);
    if ((sourceCatalogStat === null) !== (current === null)
      || (sourceCatalogStat && !sameFileVersion(sourceCatalogStat, current))) {
      throw backupError("BACKUP_SOURCE_CHANGED", "插件恢复期间源调用账本发生变化");
    }
  };
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
    const recallRestore = restoreRecallPolicyHighWater(paths, staging);
    reconcileRestoredMemory(staging, paths.trustedRoot);
    // Runtime Home is not rolled back with authority snapshots. An old anchor
    // can match old MemoryStore/Policy bytes while its native session has since
    // seen newer content. Missing anchors force a fresh native session.
    const nativeMemoryAnchorsInvalidated = invalidateRestoredNativeMemoryAnchors(staging,
      paths.trustedRoot);
    let pluginRestore = null;
    let nativeMcpRestore = null;
    if (hasPluginCatalog) {
      assertPluginSourceUnchanged();
      const { resolveServicePaths } = require("./paths");
      const { PluginStore } = require("./plugin-store");
      const restoredPaths = resolveServicePaths({ stateRoot: staging, trustedRoot: paths.trustedRoot });
      const store = new PluginStore({ paths: restoredPaths }).open();
      try {
        pluginRestore = store.rotateAuthorityForRestore({ backupId, replayBarrier: pluginBarrier });
      } finally { store.close(); }
      fsyncFile(restoredPaths.pluginCatalogPath);
      pluginRestore.catalogDigest = sha256File(restoredPaths.pluginCatalogPath);
    }
    if (verified.manifest.entries.some(entry => entry.type === "file"
      && entry.path === "mcp-servers/registry.json")) {
      const { resolveServicePaths } = require("./paths");
      const { quarantineNativeMcpRegistryForRestore } = require("./native-mcp-store");
      const restoredPaths = resolveServicePaths({ stateRoot: staging, trustedRoot: paths.trustedRoot });
      nativeMcpRestore = quarantineNativeMcpRegistryForRestore({ paths: restoredPaths });
      fsyncFile(restoredPaths.nativeMcpRegistryPath);
    }
    fsyncDirectoryTree(staging);
    for (const [target, mode] of directoryModes.reverse()) fs.chmodSync(target, mode);
    fsyncDirectory(staging);
    assertPluginSourceUnchanged();
    assertServiceStopped(paths);
    recallRestore.verifySourceUnchanged();
    fs.renameSync(staging, destination);
    fsyncDirectory(parent);
    return Object.freeze({
      destinationStateDir: destination,
      backupId,
      rootDigest: verified.manifest.rootDigest,
      recallRestore: Object.freeze({ overlaidProfiles: recallRestore.restored,
        digest: crypto.createHash("sha256").update(JSON.stringify(recallRestore.restored)).digest("hex") }),
      nativeMemoryAnchorsInvalidated,
      ...(pluginRestore ? { pluginRestore } : {}),
      ...(nativeMcpRestore ? { nativeMcpRestore } : {}),
    });
  } catch (error) {
    cleanupStaging(staging);
    throw error;
  }
}

module.exports = {
  BACKUP_SCHEMA_VERSION,
  createAuthorityBackup,
  restoreAuthorityBackup,
  verifyAuthorityBackup,
};
