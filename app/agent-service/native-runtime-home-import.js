"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { BUILTIN_CLI_AGENT_PROFILES } = require("./builtin-cli-profiles");
const { hasSecret } = require("./memory-engine");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const {
  ensurePrivateDirectoryTree,
  lstatIfExists,
  serviceError,
} = require("./security");
const codex = require("./codex-native-import");
const claudeCode = require("./claude-code-native-import");
const grokBuild = require("./grok-build-native-import");
const pi = require("./pi-native-import");
const antigravity = require("./antigravity-native-import");
const deepSeekHarness = require("./deepseek-harness-native-import");

const IMPORT_SCHEMA_VERSION = 2;
const MAX_FILES = 20_000;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_ACTIVE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_FILE_BYTES = 64 * 1024 * 1024;
const MAX_MARKER_BYTES = 1024 * 1024;
const ADAPTERS = Object.freeze([
  codex, claudeCode, grokBuild, pi, antigravity, deepSeekHarness,
]);
const ADAPTER_BY_RUNTIME = new Map(ADAPTERS.map((adapter) => [adapter.runtime, adapter]));
const BUILTIN_IDS = new Set(BUILTIN_CLI_AGENT_PROFILES.map((profile) => profile.id));
const EXCLUDED_SEGMENTS = new Set([
  "archived_sessions", "attachments", "backups", "brain", "browser", "cache", "caches",
  "chats", "computer", "conversation", "conversation_summaries", "conversations", "crashes",
  "debug", "dictation-history", "downloads", "history", "ide", "implicit", "knowledge",
  "log", "logs", "memories", "memory", "mcp-oauth-locks", "paste-cache", "projects",
  "session-env", "sessions", "shell_snapshots", "state", "storages", "telemetry", "tmp",
  "transcripts", "transcription-history.jsonl", "upload_queue", "worktrees", "worktrees.db",
]);
const EXCLUDED_BASENAME = /(?:^|[._-])(?:auth|oauth|credential|credentials|cookie|cookies|token|tokens|password|passwd)(?:$|[._-])/iu;
const DATABASE_EXTENSION = /(?:\.db|\.sqlite|\.sqlite3|\.db-(?:shm|wal)|\.sqlite-(?:shm|wal))$/iu;
const LOCK_OR_TEMP = /(?:\.lock|\.pid|\.sock|\.tmp|\.temp|-(?:shm|wal))$/iu;
const TEXT_EXTENSION = new Set([
  "", ".bash", ".cjs", ".css", ".env", ".html", ".js", ".json", ".jsonl", ".md",
  ".mjs", ".py", ".rules", ".sh", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml",
  ".yml", ".zsh",
]);
const STRUCTURED_LINE_EXTENSION = new Set([".env", ".toml", ".yaml", ".yml"]);
const SECRET_FIELD = /(?:api.?key|access.?key|private.?key|client.?secret|secret|password|passwd|authorization|cookie|oauth|refresh.?token|access.?token|credential)/iu;
const SECRET_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|[?&](?:api[_-]?key|access[_-]?token|token|secret)=|\bAIza[0-9A-Za-z_-]{30,}|\bya29\.[0-9A-Za-z_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,})/iu;
const AUTHORITY_FIELDS = new Set([
  "additionaldirectories", "allowedtools", "approvalpolicy", "command", "deniedtools",
  "enabledplugins", "env", "extension", "extensions", "hook", "hooks", "mcpserver",
  "mcpservers", "permission", "permissions", "plugin", "plugins", "sandbox", "sandboxmode",
  "shellenvironmentpolicy", "skill", "skills", "tool", "tools",
]);
const AUTHORITY_FIELD_PATTERN = /(?:additionaldirector|allow(?:ed)?tool|approval|autoapprove|baseurl|command|cwd|deniedtool|director|endpoint|extension|filesuggestion|filesystem|header|hook|login|mcp|network|permission|plugin|profile|provider|proxy|sandbox|shell|skill|statusline|tool|trustedfolder|workingdirectory|workspace)/u;
const OMIT = Symbol("omit");

function importError(code, message) { return serviceError(code, message); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

function assertOwned(stat, target) {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw importError("NATIVE_IMPORT_SOURCE_UNSAFE", `导入源不属于当前用户: ${target}`);
  }
}

function safeRelative(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")
    || path.posix.isAbsolute(value) || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw importError("NATIVE_IMPORT_PATH_UNSAFE", "导入路径无效");
  }
  return value;
}

function contained(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function excludedPath(relativePath) {
  const parts = relativePath.split("/");
  if (parts.some((part) => EXCLUDED_SEGMENTS.has(part.toLocaleLowerCase("en-US")))) return true;
  const basename = parts.at(-1);
  if (DATABASE_EXTENSION.test(basename) || LOCK_OR_TEMP.test(basename)) return true;
  return EXCLUDED_BASENAME.test(basename);
}

function authorityField(key) {
  const normalized = String(key).replace(/[^A-Za-z0-9]/gu, "").toLocaleLowerCase("en-US");
  return AUTHORITY_FIELDS.has(normalized) || AUTHORITY_FIELD_PATTERN.test(normalized);
}

function sanitizeValue(value, key = "", stripAuthority = false) {
  if (SECRET_FIELD.test(key)) return OMIT;
  if (stripAuthority && authorityField(key)) return OMIT;
  if (typeof value === "string") {
    return hasSecret(value) || SECRET_VALUE.test(value) ? OMIT : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, "", stripAuthority))
      .filter((entry) => entry !== OMIT);
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    return value;
  }
  const output = {};
  for (const [name, entry] of Object.entries(value)) {
    const sanitized = sanitizeValue(entry, name, stripAuthority);
    if (sanitized !== OMIT) output[name] = sanitized;
  }
  return output;
}

function sanitizeStructuredLines(text, stripAuthority = false) {
  let blockedTomlSection = false;
  let blockedTomlString = null;
  let blockedYamlIndent = null;
  let unsafeMultilineField = false;
  const kept = text.split(/\r?\n/u).filter((line) => {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;
    if (blockedTomlString !== null) {
      if (trimmed.includes(blockedTomlString)) blockedTomlString = null;
      return false;
    }
    if (blockedYamlIndent !== null && trimmed
      && !trimmed.startsWith("#") && indent <= blockedYamlIndent) {
      blockedYamlIndent = null;
    }
    if (blockedYamlIndent !== null) return false;
    if (!trimmed || trimmed.startsWith("#")) return true;
    const section = trimmed.match(/^\[{1,2}\s*([^\]]+?)\s*\]{1,2}(?:\s*#.*)?$/u);
    if (section) {
      blockedTomlSection = stripAuthority
        && section[1].split(".").some((part) => authorityField(part.replace(/["']/gu, "")));
      return !blockedTomlSection;
    }
    if (blockedTomlSection) return false;
    const separator = trimmed.search(/[:=]/u);
    if (separator < 0) return !(hasSecret(trimmed) || SECRET_VALUE.test(trimmed));
    const key = trimmed.slice(0, separator).replace(/^[-"']+|["']+$/gu, "").trim();
    const value = trimmed.slice(separator + 1).trim();
    if (SECRET_FIELD.test(key) || (stripAuthority && authorityField(key))) {
      if ((value.startsWith("[") && !value.includes("]"))
        || (value.startsWith("{") && !value.includes("}"))) {
        unsafeMultilineField = true;
      }
      if (trimmed[separator] === ":" && (value === "" || /^[|>](?:[+-]?\d*|\d*[+-]?)$/u.test(value))) {
        blockedYamlIndent = indent;
      }
      if (trimmed[separator] === "=") {
        const delimiter = value.startsWith('"""') ? '"""' : value.startsWith("'''") ? "'''" : null;
        if (delimiter && value.indexOf(delimiter, 3) < 0) blockedTomlString = delimiter;
      }
      return false;
    }
    return !hasSecret(trimmed) && !SECRET_VALUE.test(trimmed);
  });
  if (unsafeMultilineField) return null;
  const sanitized = kept.join("\n");
  return hasSecret(sanitized) || SECRET_VALUE.test(sanitized) ? null : Buffer.from(sanitized, "utf8");
}

function sanitizeFile(relativePath, kind, bytes) {
  const extension = path.posix.extname(relativePath).toLocaleLowerCase("en-US");
  // Unknown/binary payloads cannot be proven credential-free. They are excluded even from
  // quarantine; executable text is retained there as inert 0600 review material.
  if (!TEXT_EXTENSION.has(extension)) return null;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return null; }
  if (extension === ".json") {
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      return kind === "pending" && !hasSecret(text) && !SECRET_VALUE.test(text) ? bytes : null;
    }
    if (kind === "active" && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) {
      return null;
    }
    const sanitized = sanitizeValue(parsed, "", kind === "active");
    if (sanitized === OMIT) return null;
    return Buffer.from(`${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
  }
  if (STRUCTURED_LINE_EXTENSION.has(extension)) {
    return sanitizeStructuredLines(text, kind === "active");
  }
  return hasSecret(text) || SECRET_VALUE.test(text) ? null : bytes;
}

function readStableFile(target, maxBytes) {
  const before = fs.lstatSync(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw importError("NATIVE_IMPORT_SOURCE_UNSAFE", `导入源文件类型不安全: ${target}`);
  }
  assertOwned(before, target);
  if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxBytes) {
    throw importError("NATIVE_IMPORT_FILE_TOO_LARGE", `导入源文件超过上限: ${target}`);
  }
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) {
      throw importError("NATIVE_IMPORT_SOURCE_CHANGED", `导入源文件 identity 变化: ${target}`);
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.lstatSync(target);
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw importError("NATIVE_IMPORT_SOURCE_CHANGED", `导入期间源文件发生变化: ${target}`);
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function inspectSourceRoot(sourceRoot) {
  const stat = lstatIfExists(sourceRoot);
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw importError("NATIVE_IMPORT_SOURCE_UNSAFE", `导入源不是安全目录: ${sourceRoot}`);
  }
  assertOwned(stat, sourceRoot);
  return stat;
}

function planImport(adapter, sourceRoot) {
  const entries = [];
  const skillRoots = new Set();
  let activeFiles = 0;
  let pendingFiles = 0;
  let activeBytes = 0;
  let pendingBytes = 0;
  let pendingCapacityReached = false;
  let excluded = 0;
  let pending = 0;

  function visit(directory, relativeDirectory = "") {
    const names = fs.readdirSync(directory).sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      if (typeof name !== "string" || !name.isWellFormed() || !name || name === "." || name === ".."
        || name.includes("\0") || Buffer.byteLength(name, "utf8") > 255) {
        throw importError("NATIVE_IMPORT_PATH_UNSAFE", "导入源包含无效文件名");
      }
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      safeRelative(relative);
      if (excludedPath(relative)) { excluded += 1; continue; }
      const kind = adapter.classify(relative);
      if (kind === "exclude") { excluded += 1; continue; }
      const source = path.join(directory, name);
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())
        || (stat.isFile() && stat.nlink !== 1)) {
        if (kind !== "active") { excluded += 1; continue; }
        throw importError("NATIVE_IMPORT_SOURCE_UNSAFE", `导入源包含不安全对象: ${source}`);
      }
      assertOwned(stat, source);
      if (kind === "container") {
        if (stat.isDirectory()) visit(source, relative);
        else excluded += 1;
        continue;
      }
      if (kind === "skill") {
        const root = adapter.skillRoots.find((candidate) => (
          relative === candidate || relative.startsWith(`${candidate}/`)
        ));
        if (root) skillRoots.add(root);
        continue;
      }
      if (stat.isDirectory()) {
        if (kind === "pending" && pendingCapacityReached) excluded += 1;
        else visit(source, relative);
        continue;
      }
      if (kind === "pending" && (pendingCapacityReached || pendingFiles >= MAX_FILES)) {
        pendingCapacityReached = true;
        excluded += 1;
        continue;
      }
      if (kind === "active" && activeFiles >= MAX_FILES) {
        throw importError("NATIVE_IMPORT_TOO_LARGE", "导入文件数量超过上限");
      }
      const maxFileBytes = kind === "active" ? MAX_ACTIVE_FILE_BYTES : MAX_PENDING_FILE_BYTES;
      let original;
      try { original = readStableFile(source, maxFileBytes); } catch (error) {
        if (kind === "pending" && error?.code === "NATIVE_IMPORT_FILE_TOO_LARGE") {
          excluded += 1;
          continue;
        }
        throw error;
      }
      if (kind === "pending" && pendingBytes + original.length > MAX_TOTAL_BYTES) {
        pendingCapacityReached = true;
        excluded += 1;
        continue;
      }
      if (kind === "active" && activeBytes + original.length > MAX_TOTAL_BYTES) {
        throw importError("NATIVE_IMPORT_TOO_LARGE", "导入总大小超过上限");
      }
      if (kind === "active") { activeFiles += 1; activeBytes += original.length; }
      else { pendingFiles += 1; pendingBytes += original.length; }
      const sanitized = sanitizeFile(relative, kind, original);
      const review = kind === "active" ? sanitizeFile(relative, "pending", original) : null;
      if (sanitized === null) {
        if (review !== null) {
          const reviewDestination = path.posix.join(
            ".shoggoth-import-pending", "imported-source", relative,
          );
          entries.push(Object.freeze({
            source,
            sourceRelative: relative,
            destination: safeRelative(reviewDestination),
            kind: "pending",
            bytes: review,
            sha256: sha256(review),
          }));
          pending += 1;
        }
        excluded += 1;
        continue;
      }
      const destination = adapter.destination(relative, kind);
      entries.push(Object.freeze({
        source,
        sourceRelative: relative,
        destination: safeRelative(destination),
        kind,
        bytes: sanitized,
        sha256: sha256(sanitized),
      }));
      if (kind === "pending") pending += 1;
      if (review !== null) {
        const reviewDestination = path.posix.join(
          ".shoggoth-import-pending", "imported-source", relative,
        );
        entries.push(Object.freeze({
          source,
          sourceRelative: relative,
          destination: safeRelative(reviewDestination),
          kind: "pending",
          bytes: review,
          sha256: sha256(review),
        }));
        pending += 1;
      }
    }
  }

  visit(sourceRoot);
  entries.sort((left, right) => left.destination.localeCompare(right.destination));
  const fingerprint = sha256(JSON.stringify(entries.map((entry) => ({
    source: entry.sourceRelative, destination: entry.destination, sha256: entry.sha256,
  }))));
  return Object.freeze({
    entries: Object.freeze(entries),
    skillRoots: Object.freeze([...skillRoots].sort()),
    fingerprint,
    counts: Object.freeze({ files: entries.length, pending, excluded, skills: 0, conflicts: 0 }),
  });
}

function fsyncFile(target) {
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function fsyncDirectory(target) {
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function removeOwnedTree(target, root) {
  if (!lstatIfExists(target)) return;
  if (!contained(root, target)) throw importError("NATIVE_IMPORT_PATH_UNSAFE", "导入清理路径越界");
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw importError("NATIVE_IMPORT_PATH_UNSAFE", "导入清理遇到不安全对象");
  }
  assertOwned(stat, target);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) removeOwnedTree(path.join(target, name), root);
    fs.rmdirSync(target);
  } else {
    if (stat.nlink !== 1) throw importError("NATIVE_IMPORT_PATH_UNSAFE", "导入清理拒绝 hardlink");
    fs.unlinkSync(target);
  }
}

function stagePlan(paths, runtimeKey, plan) {
  ensurePrivateDirectoryTree(paths.nativeRuntimeImportStagingDir, paths.trustedRoot);
  const staging = path.join(
    paths.nativeRuntimeImportStagingDir,
    `${runtimeKey.replace(/[^A-Za-z0-9._-]/gu, "-")}-${crypto.randomUUID()}`,
  );
  ensurePrivateDirectoryTree(staging, paths.trustedRoot);
  const payload = path.join(staging, "payload");
  ensurePrivateDirectoryTree(payload, paths.trustedRoot);
  try {
    for (const entry of plan.entries) {
      const target = path.join(payload, ...entry.destination.split("/"));
      ensurePrivateDirectoryTree(path.dirname(target), paths.trustedRoot);
      const fd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL
        | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
      try { fs.writeFileSync(fd, entry.bytes); fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    }
    fsyncDirectory(payload);
    return { staging, payload };
  } catch (error) {
    removeOwnedTree(staging, paths.nativeRuntimeImportStagingDir);
    throw error;
  }
}

function commitPlan(paths, targetRoot, staged, plan) {
  if (!contained(paths.stateDir, targetRoot)) {
    throw importError("NATIVE_IMPORT_PATH_UNSAFE", "导入目标不在 stateDir 内");
  }
  ensurePrivateDirectoryTree(targetRoot, paths.trustedRoot);
  const createdFiles = [];
  const createdDirs = [];
  let conflicts = 0;
  try {
    for (const entry of plan.entries) {
      const relative = safeRelative(entry.destination);
      const source = path.join(staged.payload, ...relative.split("/"));
      const destination = path.join(targetRoot, ...relative.split("/"));
      if (!contained(targetRoot, destination)) {
        throw importError("NATIVE_IMPORT_PATH_UNSAFE", "导入目标文件越界");
      }
      const parts = relative.split("/").slice(0, -1);
      let cursor = targetRoot;
      for (const part of parts) {
        cursor = path.join(cursor, part);
        const existingDirectory = lstatIfExists(cursor);
        if (existingDirectory) {
          if (!existingDirectory.isDirectory() || existingDirectory.isSymbolicLink()) {
            conflicts += 1;
            cursor = null;
            break;
          }
          assertOwned(existingDirectory, cursor);
          continue;
        }
        fs.mkdirSync(cursor, { mode: 0o700 });
        fs.chmodSync(cursor, 0o700);
        createdDirs.push(cursor);
      }
      if (cursor === null) continue;
      const existing = lstatIfExists(destination);
      if (existing) {
        if (existing.isSymbolicLink() || (!existing.isFile() && !existing.isDirectory())) {
          throw importError("NATIVE_IMPORT_TARGET_UNSAFE", `导入目标包含不安全对象: ${destination}`);
        }
        assertOwned(existing, destination);
        conflicts += 1;
        continue;
      }
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(destination, 0o600);
      fsyncFile(destination);
      if (sha256(fs.readFileSync(destination)) !== entry.sha256) {
        throw importError("NATIVE_IMPORT_COPY_MISMATCH", `导入副本摘要不一致: ${destination}`);
      }
      createdFiles.push(destination);
    }
    fsyncDirectory(targetRoot);
    return conflicts;
  } catch (error) {
    for (const target of createdFiles.reverse()) {
      try { fs.unlinkSync(target); } catch { /* preserve primary error */ }
    }
    for (const target of createdDirs.reverse()) {
      try { if (fs.readdirSync(target).length === 0) fs.rmdirSync(target); } catch { /* preserve primary error */ }
    }
    throw error;
  }
}

function readMarker(paths) {
  const target = paths.nativeRuntimeImportPath;
  if (!lstatIfExists(target)) return { schemaVersion: IMPORT_SCHEMA_VERSION, updatedAt: 0, imports: {} };
  let parsed;
  try { parsed = JSON.parse(readPrivateFile(target, { maxBytes: MAX_MARKER_BYTES }).toString("utf8")); }
  catch (error) {
    if (error?.code) throw error;
    throw importError("NATIVE_IMPORT_MARKER_INVALID", "Runtime 导入 marker 无法解析");
  }
  if (!parsed || Object.keys(parsed).join(",") !== "schemaVersion,updatedAt,imports"
    || ![1, IMPORT_SCHEMA_VERSION].includes(parsed.schemaVersion)
    || !Number.isSafeInteger(parsed.updatedAt) || parsed.updatedAt < 0
    || !parsed.imports || typeof parsed.imports !== "object" || Array.isArray(parsed.imports)) {
    throw importError("NATIVE_IMPORT_MARKER_INVALID", "Runtime 导入 marker 无效");
  }
  const imports = {};
  for (const [key, value] of Object.entries(parsed.imports)) {
    const expectedProfile = BUILTIN_CLI_AGENT_PROFILES.find((profile) => (
      `${profile.runtime}:${profile.runtimeProfileId}` === key
    ));
    const expectedFields = parsed.schemaVersion === 1
      ? "status,runtime,profileId,runtimeProfileId,sourceFingerprint,completedAt,counts"
      : "status,runtime,profileId,runtimeProfileId,sourceFingerprint,skillImportRevision,completedAt,counts";
    const skillImportRevision = parsed.schemaVersion === 1 ? 1 : value?.skillImportRevision;
    if (!key || !value || Object.keys(value).join(",") !== expectedFields
      || value.status !== "imported" || !expectedProfile
      || value.runtime !== expectedProfile.runtime || value.profileId !== expectedProfile.id
      || value.runtimeProfileId !== expectedProfile.runtimeProfileId
      || typeof value.profileId !== "string" || typeof value.runtimeProfileId !== "string"
      || !/^[a-f0-9]{64}$/u.test(value.sourceFingerprint)
      || !Number.isSafeInteger(skillImportRevision) || skillImportRevision < 1
      || !Number.isSafeInteger(value.completedAt) || value.completedAt < 0
      || !value.counts || typeof value.counts !== "object" || Array.isArray(value.counts)
      || Object.keys(value.counts).join(",") !== "files,pending,excluded,skills,conflicts"
      || Object.values(value.counts).some((count) => !Number.isSafeInteger(count) || count < 0)) {
      throw importError("NATIVE_IMPORT_MARKER_INVALID", "Runtime 导入 marker entry 无效");
    }
    imports[key] = {
      status: value.status,
      runtime: value.runtime,
      profileId: value.profileId,
      runtimeProfileId: value.runtimeProfileId,
      sourceFingerprint: value.sourceFingerprint,
      skillImportRevision,
      completedAt: value.completedAt,
      counts: { ...value.counts },
    };
  }
  return { schemaVersion: IMPORT_SCHEMA_VERSION, updatedAt: parsed.updatedAt, imports };
}

function writeMarker(paths, marker) {
  atomicWritePrivateFile(paths.nativeRuntimeImportPath, `${JSON.stringify(marker)}\n`, {
    trustedRoot: paths.trustedRoot,
  });
}

function listSkillCandidates(adapter, sourceRoot, skillRoots, homeDir) {
  const candidates = [];
  const seen = new Set();
  let canonicalHome;
  try { canonicalHome = fs.realpathSync(homeDir); } catch { return candidates; }
  const roots = [
    ...skillRoots.map((root) => path.join(sourceRoot, ...root.split("/"))),
    ...adapter.additionalSkillRoots(homeDir),
  ];
  for (const configuredDirectory of roots) {
    const stat = lstatIfExists(configuredDirectory);
    if (!stat) continue;
    let directory;
    try { directory = fs.realpathSync(configuredDirectory); } catch { continue; }
    const directoryStat = lstatIfExists(directory);
    if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()
      || !contained(canonicalHome, directory)) continue;
    assertOwned(directoryStat, directory);
    for (const name of fs.readdirSync(directory).sort((left, right) => left.localeCompare(right))) {
      let candidate = path.join(directory, name);
      let candidateStat = fs.lstatSync(candidate);
      const linked = candidateStat.isSymbolicLink();
      if (linked) {
        assertOwned(candidateStat, candidate);
        try { candidate = fs.realpathSync(candidate); candidateStat = fs.lstatSync(candidate); }
        catch { continue; }
      }
      if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()
        || (!linked && !contained(canonicalHome, candidate)) || seen.has(candidate)) continue;
      assertOwned(candidateStat, candidate);
      seen.add(candidate);
      candidates.push({ runtime: adapter.runtime, sourcePath: candidate });
    }
  }
  return candidates;
}

function importSkills(skillStore, profile, adapter, sourceRoot, skillRoots, homeDir) {
  if (!skillStore || typeof skillStore.importLegacySkill !== "function") return 0;
  let imported = 0;
  let candidates;
  try { candidates = listSkillCandidates(adapter, sourceRoot, skillRoots, homeDir); }
  catch { return 0; }
  for (const candidate of candidates) {
    try {
      const result = skillStore.importLegacySkill({
        profileId: profile.id,
        runtime: candidate.runtime,
        sourcePath: candidate.sourcePath,
      });
      if (result?.enabled === true) imported += 1;
    } catch (error) {
      // One malformed or conflicting user Skill must not prevent the rest of the Runtime import.
      if (!["SKILL_IMPORT_INVALID", "SKILL_TEXT_INVALID", "SKILL_PACKAGE_TOO_LARGE",
        "SKILL_SECRET_REJECTED", "SKILL_PATH_INVALID", "SKILL_MANIFEST_INVALID",
        "SKILL_INSTRUCTIONS_INVALID", "SKILL_VERSION_CONFLICT", "UNSAFE_SYMLINK",
        "UNSAFE_HARDLINK", "UNSAFE_OWNER", "UNSAFE_PATH"].includes(error?.code)) throw error;
    }
  }
  return imported;
}

function validateOptions(options) {
  const paths = options?.paths;
  if (!paths?.stateDir || !paths.trustedRoot || !paths.nativeRuntimeImportPath
    || !paths.nativeRuntimeImportStagingDir || !Array.isArray(options.profiles)
    || typeof options.homeDir !== "string" || !path.isAbsolute(options.homeDir)) {
    throw new TypeError("Native Runtime home import options are invalid");
  }
  return paths;
}

function importNativeRuntimeHomes(options) {
  const paths = validateOptions(options);
  const now = options.now || Date.now;
  const marker = readMarker(paths);
  const results = [];
  ensurePrivateDirectoryTree(paths.nativeRuntimeImportStagingDir, paths.trustedRoot);
  for (const name of fs.readdirSync(paths.nativeRuntimeImportStagingDir)) {
    if (typeof name !== "string" || !name || name === "." || name === ".."
      || name.includes("\0") || name.includes(path.sep)) {
      throw importError("NATIVE_IMPORT_PATH_UNSAFE", "Runtime 导入 staging 包含无效路径");
    }
    removeOwnedTree(path.join(paths.nativeRuntimeImportStagingDir, name), paths.nativeRuntimeImportStagingDir);
  }
  for (const profile of options.profiles) {
    if (!profile || !BUILTIN_IDS.has(profile.id)) continue;
    const adapter = ADAPTER_BY_RUNTIME.get(profile.runtime);
    if (!adapter) continue;
    const key = `${adapter.runtime}:${profile.runtimeProfileId}`;
    const skillImportRevision = adapter.skillImportRevision ?? 1;
    const previous = marker.imports[key];
    if (previous?.status === "imported" && previous.skillImportRevision > skillImportRevision) {
      throw importError("NATIVE_IMPORT_MARKER_INVALID", "Runtime 导入 Skill revision 超前");
    }
    if (previous?.status === "imported" && previous.skillImportRevision === skillImportRevision) {
      results.push({ runtime: adapter.runtime, profileId: profile.id, status: "already_imported", counts: previous.counts });
      continue;
    }
    if (previous?.status === "imported") {
      try {
        const skills = importSkills(
          options.skillStore, profile, adapter, adapter.sourceRoot(options.homeDir), [], options.homeDir,
        );
        const completedAt = now();
        if (!Number.isSafeInteger(completedAt) || completedAt < 0) {
          throw importError("NATIVE_IMPORT_TIME_INVALID", "Runtime 导入时间无效");
        }
        const counts = { ...previous.counts, skills: previous.counts.skills + skills };
        marker.imports[key] = {
          ...previous,
          skillImportRevision,
          completedAt,
          counts,
        };
        marker.updatedAt = completedAt;
        writeMarker(paths, marker);
        results.push({ runtime: adapter.runtime, profileId: profile.id, status: "upgraded", counts });
      } catch (error) {
        results.push({
          runtime: adapter.runtime,
          profileId: profile.id,
          status: "failed",
          code: typeof error?.code === "string" ? error.code : "NATIVE_IMPORT_FAILED",
          counts: null,
        });
      }
      continue;
    }
    const sourceRoot = adapter.sourceRoot(options.homeDir);
    if (!inspectSourceRoot(sourceRoot)) {
      results.push({ runtime: adapter.runtime, profileId: profile.id, status: "not_found", counts: null });
      continue;
    }
    const targetRoot = adapter.targetRoot(paths, profile.runtimeProfileId);
    if (!contained(paths.stateDir, targetRoot) || contained(sourceRoot, targetRoot)
      || contained(targetRoot, sourceRoot)) {
      throw importError("NATIVE_IMPORT_PATH_UNSAFE", "Runtime 导入源与目标边界无效");
    }
    let staged = null;
    try {
      const plan = planImport(adapter, sourceRoot);
      staged = stagePlan(paths, key, plan);
      const conflicts = commitPlan(paths, targetRoot, staged, plan);
      if (adapter.runtime === "claude-code") {
        adapter.writeImportedUserSourceMarker({
          targetRoot,
          plan,
          trustedRoot: paths.trustedRoot,
        });
      }
      const skills = importSkills(
        options.skillStore, profile, adapter, sourceRoot, plan.skillRoots, options.homeDir,
      );
      const counts = { ...plan.counts, conflicts, skills };
      const completedAt = now();
      if (!Number.isSafeInteger(completedAt) || completedAt < 0) {
        throw importError("NATIVE_IMPORT_TIME_INVALID", "Runtime 导入时间无效");
      }
      marker.imports[key] = {
        status: "imported",
        runtime: adapter.runtime,
        profileId: profile.id,
        runtimeProfileId: profile.runtimeProfileId,
        sourceFingerprint: plan.fingerprint,
        skillImportRevision,
        completedAt,
        counts,
      };
      marker.updatedAt = completedAt;
      writeMarker(paths, marker);
      results.push({ runtime: adapter.runtime, profileId: profile.id, status: "imported", counts });
    } catch (error) {
      results.push({
        runtime: adapter.runtime,
        profileId: profile.id,
        status: "failed",
        code: typeof error?.code === "string" ? error.code : "NATIVE_IMPORT_FAILED",
        counts: null,
      });
    } finally {
      if (staged && lstatIfExists(staged.staging)) {
        removeOwnedTree(staged.staging, paths.nativeRuntimeImportStagingDir);
      }
    }
  }
  return Object.freeze({ schemaVersion: IMPORT_SCHEMA_VERSION, results: Object.freeze(results) });
}

module.exports = {
  ADAPTERS,
  IMPORT_SCHEMA_VERSION,
  importNativeRuntimeHomes,
  planImport,
  readMarker,
  sanitizeFile,
};
