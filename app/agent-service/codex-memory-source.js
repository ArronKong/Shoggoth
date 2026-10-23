"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { serviceError } = require("./security");

// Scheduling only checks the authorized primary file; the Agent reads the
// entire file and follows references through its own native channel.
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function sourceError(code, message) { return serviceError(code, message); }

// Resolve the host OS account, independently of Runtime homes and environment.
// Returns null when Codex has no memories directory.
function locateCodexMemoryDirectory({ fs: fileSystem = fs, hostHome = os.userInfo().homedir } = {}) {
  // OS account identity, never the Runtime's isolated HOME or CODEX_HOME.
  // A custom connection directory needs a verified App connection contract;
  // arbitrary environment variables are not such a contract.
  if (typeof hostHome !== "string" || !path.isAbsolute(hostHome)) {
    throw sourceError("CODEX_MEMORY_SOURCE_UNSAFE", "宿主用户目录无效");
  }
  const home = path.join(hostHome, ".codex");
  try {
    const stat = fileSystem.lstatSync(home);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw sourceError("CODEX_MEMORY_SOURCE_UNSAFE", "Codex 数据目录不安全");
    }
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const directory = path.join(home, "memories");
  let stat;
  try { stat = fileSystem.lstatSync(directory); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw sourceError("CODEX_MEMORY_SOURCE_UNREADABLE", "Codex 记忆目录无法读取");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw sourceError("CODEX_MEMORY_SOURCE_UNSAFE", "Codex 记忆目录不安全");
  }
  return directory;
}

function decodeUtf8(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return null; }
}

// Read one source file without following links. Returns null when it is absent.
function readCodexMemoryFile(directory, file, { fs: fileSystem = fs, maxBytes = MAX_SOURCE_BYTES } = {}) {
  if (typeof file?.name !== "string" || path.isAbsolute(file.name)
    || file.name.split(/[\\/]/u).some((part) => !part || part === "." || part === "..")) {
    throw sourceError("CODEX_MEMORY_SOURCE_UNSAFE", "Codex 记忆路径无效");
  }
  const target = path.join(directory, file.name);
  // Check each intermediate directory, not just the final file's O_NOFOLLOW.
  let parent = directory;
  for (const part of file.name.split("/").slice(0, -1)) {
    parent = path.join(parent, part);
    const stat = fileSystem.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw sourceError("CODEX_MEMORY_SOURCE_UNSAFE", "Codex 记忆路径不安全");
    }
  }
  let before;
  try { before = fileSystem.lstatSync(target); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw sourceError("CODEX_MEMORY_SOURCE_UNREADABLE", "Codex 记忆文件无法读取");
  }
  const owned = (stat) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
    && (typeof process.getuid !== "function" || stat.uid === process.getuid());
  if (!owned(before)) throw sourceError("CODEX_MEMORY_SOURCE_UNSAFE", "Codex 记忆文件不安全");
  if (before.size > maxBytes) throw sourceError("CODEX_MEMORY_SOURCE_TOO_LARGE", "Codex 记忆文件过大");
  let fd;
  try { fd = fileSystem.openSync(target, fileSystem.constants.O_RDONLY | (fileSystem.constants.O_NOFOLLOW || 0)); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw sourceError("CODEX_MEMORY_SOURCE_UNREADABLE", "Codex 记忆文件无法读取");
  }
  let bytes;
  try {
    const stat = fileSystem.fstatSync(fd);
    if (!owned(stat) || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw sourceError("CODEX_MEMORY_SOURCE_UNSAFE", "Codex 记忆文件在读取时发生变化");
    }
    if (stat.size > maxBytes) throw sourceError("CODEX_MEMORY_SOURCE_TOO_LARGE", "Codex 记忆文件过大");
    bytes = fileSystem.readFileSync(fd);
  } finally { fileSystem.closeSync(fd); }
  if (bytes.length > maxBytes) throw sourceError("CODEX_MEMORY_SOURCE_TOO_LARGE", "Codex 记忆文件过大");
  const text = decodeUtf8(bytes);
  if (text === null || text.includes("\0")) {
    throw sourceError("CODEX_MEMORY_SOURCE_INVALID", "Codex 记忆文件不是有效的 UTF-8 文本");
  }
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return { kind: file.kind, name: file.name, path: target, sha256: sha256(bytes), lines };
}

function readCodexMemorySource(name = "MEMORY.md", options = {}) {
  if (name !== "MEMORY.md") throw sourceError("CODEX_MEMORY_SOURCE_UNSAFE", "只检测主 MEMORY.md");
  const directory = locateCodexMemoryDirectory(options);
  return directory ? readCodexMemoryFile(directory, { name, kind: "memory" }, options) : null;
}

module.exports = { MAX_SOURCE_BYTES, locateCodexMemoryDirectory, readCodexMemoryFile, readCodexMemorySource };
