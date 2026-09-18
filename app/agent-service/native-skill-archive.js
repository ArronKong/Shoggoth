"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { TextDecoder } = require("node:util");
const { lstatIfExists, serviceError } = require("./security");

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_FILES = 256;
const MAX_PACKAGE_DEPTH = 8;
const ROOT_ENTRIES = new Set(["SKILL.md", "skill.json", "scripts", "references", "assets"]);
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function archiveError(code, message) { return serviceError(code, message); }
function fsyncDirectory(target) {
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function removePartialTree(target) {
  const stat = lstatIfExists(target);
  if (!stat) return;
  if (stat.isSymbolicLink()) throw archiveError("UNSAFE_SYMLINK", "ZIP 暂存路径被替换为 symlink");
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) removePartialTree(path.join(target, name));
    fs.rmdirSync(target);
    return;
  }
  if (!stat.isFile() || stat.nlink !== 1) throw archiveError("UNSAFE_PATH", "ZIP 暂存路径类型无效");
  fs.unlinkSync(target);
}
function decodeName(bytes, utf8) {
  if (!utf8 && bytes.some((value) => value > 0x7f)) {
    throw archiveError("SKILL_PATH_INVALID", "ZIP 非 ASCII 文件名必须声明 UTF-8");
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw archiveError("SKILL_PATH_INVALID", "ZIP 文件名不是有效 UTF-8"); }
}
function canonicalName(name) {
  if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/")
    || /^[A-Za-z]:/u.test(name)) {
    throw archiveError("SKILL_PATH_INVALID", "ZIP 包含绝对路径或无效路径");
  }
  const directory = name.endsWith("/");
  const trimmed = directory ? name.slice(0, -1) : name;
  const parts = trimmed.split("/");
  if (!trimmed || parts.some((part) => !part || part === "." || part === "..")) {
    throw archiveError("SKILL_PATH_INVALID", "ZIP 包含路径穿越或空路径段");
  }
  return { name: trimmed, parts, directory };
}
function packagePath(parts) {
  if (parts.length === 0 || parts.length > MAX_PACKAGE_DEPTH || !ROOT_ENTRIES.has(parts[0])) {
    throw archiveError("SKILL_PATH_INVALID", "ZIP 包含未知根条目或嵌套过深");
  }
  if (parts.length === 1 && !["SKILL.md", "skill.json", "scripts", "references", "assets"].includes(parts[0])) {
    throw archiveError("SKILL_PATH_INVALID", "ZIP 根目录结构无效");
  }
  return parts.join("/");
}
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}
function findEndOfCentralDirectory(bytes) {
  const minimum = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  throw archiveError("SKILL_INSTALL_INVALID", "ZIP 中央目录不存在或尾部无效");
}
function parseEntries(bytes) {
  const eocd = findEndOfCentralDirectory(bytes);
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8);
  const totalEntries = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries
    || totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff
    || totalEntries > MAX_PACKAGE_FILES * 2 || centralOffset + centralSize !== eocd) {
    throw archiveError("SKILL_INSTALL_INVALID", "不支持多卷、ZIP64 或异常中央目录");
  }
  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw archiveError("SKILL_INSTALL_INVALID", "ZIP 中央目录条目无效");
    }
    const madeBy = bytes.readUInt16LE(cursor + 4);
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const startDisk = bytes.readUInt16LE(cursor + 34);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > eocd || startDisk !== 0 || compressedSize === 0xffffffff || size === 0xffffffff
      || (flags & ~0x080e) !== 0 || ![0, 8].includes(method)) {
      throw archiveError("SKILL_INSTALL_INVALID", "ZIP 条目使用了不支持的加密、压缩或扩展格式");
    }
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const canonical = canonicalName(decodeName(rawName, Boolean(flags & 0x0800)));
    const host = madeBy >>> 8;
    const unixType = host === 3 ? ((externalAttributes >>> 16) & 0o170000) : 0;
    if (unixType && unixType !== 0o100000 && unixType !== 0o040000) {
      throw archiveError("UNSAFE_SYMLINK", "ZIP 包含 symlink 或特殊文件");
    }
    if ((unixType === 0o040000) !== canonical.directory && unixType !== 0) {
      throw archiveError("SKILL_PATH_INVALID", "ZIP 文件类型与路径不一致");
    }
    if (canonical.directory && (size !== 0 || compressedSize !== 0)) {
      throw archiveError("SKILL_INSTALL_INVALID", "ZIP 目录条目包含数据");
    }
    entries.push({
      ...canonical, rawName: Buffer.from(rawName), flags, method, crc,
      compressedSize, size, localOffset,
    });
    cursor = end;
  }
  if (cursor !== eocd) throw archiveError("SKILL_INSTALL_INVALID", "ZIP 中央目录大小不一致");
  return { entries, centralOffset };
}
function stripPackageRoot(entries) {
  const fileNames = new Set(entries.filter((entry) => !entry.directory).map((entry) => entry.name));
  let prefix = "";
  if (!fileNames.has("skill.json") || !fileNames.has("SKILL.md")) {
    const roots = new Set(entries.map((entry) => entry.parts[0]));
    if (roots.size !== 1) throw archiveError("SKILL_MANIFEST_INVALID", "ZIP 缺少根级 Skill 清单");
    prefix = `${[...roots][0]}/`;
    if (!fileNames.has(`${prefix}skill.json`) || !fileNames.has(`${prefix}SKILL.md`)) {
      throw archiveError("SKILL_MANIFEST_INVALID", "ZIP 缺少 skill.json 或 SKILL.md");
    }
  }
  const normalized = [];
  const seen = new Set();
  for (const entry of entries) {
    if (prefix && entry.name === prefix.slice(0, -1) && entry.directory) continue;
    if (prefix && !entry.name.startsWith(prefix)) {
      throw archiveError("SKILL_PATH_INVALID", "ZIP 包含 Skill 根目录外的条目");
    }
    const relative = prefix ? entry.name.slice(prefix.length) : entry.name;
    if (!relative) continue;
    const relativeParts = relative.split("/");
    packagePath(relativeParts);
    if (seen.has(relative)) throw archiveError("SKILL_PATH_INVALID", "ZIP 包含重复路径");
    seen.add(relative);
    normalized.push({ ...entry, relative, relativeParts });
  }
  return normalized;
}
function inflateEntries(bytes, entries, centralOffset) {
  const ranges = [];
  let totalBytes = 0;
  let fileCount = 0;
  for (const entry of entries) {
    if (entry.localOffset + 30 > centralOffset || bytes.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) {
      throw archiveError("SKILL_INSTALL_INVALID", "ZIP 本地文件头无效");
    }
    const flags = bytes.readUInt16LE(entry.localOffset + 6);
    const method = bytes.readUInt16LE(entry.localOffset + 8);
    const nameLength = bytes.readUInt16LE(entry.localOffset + 26);
    const extraLength = bytes.readUInt16LE(entry.localOffset + 28);
    const nameStart = entry.localOffset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (flags !== entry.flags || method !== entry.method || dataEnd > centralOffset
      || !bytes.subarray(nameStart, nameStart + nameLength).equals(entry.rawName)) {
      throw archiveError("SKILL_INSTALL_INVALID", "ZIP 本地头与中央目录不一致");
    }
    ranges.push([entry.localOffset, dataEnd]);
    if (entry.directory) { entry.bytes = Buffer.alloc(0); continue; }
    fileCount += 1;
    totalBytes += entry.size;
    if (fileCount > MAX_PACKAGE_FILES || entry.size > MAX_FILE_BYTES || totalBytes > MAX_PACKAGE_BYTES) {
      throw archiveError("SKILL_PACKAGE_TOO_LARGE", "ZIP 解压后超过 Skill 容量上限");
    }
    const compressed = bytes.subarray(dataStart, dataEnd);
    let output;
    try {
      output = entry.method === 0 ? Buffer.from(compressed)
        : zlib.inflateRawSync(compressed, { maxOutputLength: Math.min(entry.size + 1, MAX_FILE_BYTES + 1) });
    } catch { throw archiveError("SKILL_INSTALL_INVALID", "ZIP 条目解压失败"); }
    if (output.length !== entry.size || crc32(output) !== entry.crc) {
      throw archiveError("SKILL_INSTALL_INVALID", "ZIP 条目大小或 CRC 校验失败");
    }
    entry.bytes = output;
  }
  ranges.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index][0] < ranges[index - 1][1]) {
      throw archiveError("SKILL_INSTALL_INVALID", "ZIP 条目数据范围重叠");
    }
  }
}
function readArchive(target) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(target, flags);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_ARCHIVE_BYTES
      || (typeof process.getuid === "function" && before.uid !== process.getuid())) {
      throw archiveError("SKILL_INSTALL_INVALID", "ZIP 文件类型、owner 或大小无效");
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || bytes.length !== before.size) {
      throw archiveError("SKILL_PACKAGE_CHANGED", "ZIP 在读取期间发生变化");
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}
function extractSkillZip(archivePath, destination) {
  if (path.extname(archivePath).toLowerCase() !== ".zip" || lstatIfExists(destination)) {
    throw archiveError("SKILL_INSTALL_INVALID", "ZIP 安装路径无效");
  }
  const bytes = readArchive(archivePath);
  const parsed = parseEntries(bytes);
  const entries = stripPackageRoot(parsed.entries);
  inflateEntries(bytes, entries, parsed.centralOffset);
  try {
    fs.mkdirSync(destination, { mode: 0o700 });
    const directories = new Set([destination]);
    for (const entry of entries) {
      const target = path.join(destination, ...entry.relativeParts);
      if (entry.directory) {
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
        directories.add(target);
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      directories.add(path.dirname(target));
      const fd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL
        | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
      try { fs.writeFileSync(fd, entry.bytes); fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    }
    [...directories].sort((left, right) => right.length - left.length).forEach(fsyncDirectory);
    return destination;
  } catch (error) {
    removePartialTree(destination);
    throw error;
  } finally {
    bytes.fill(0);
    for (const entry of entries) entry.bytes?.fill(0);
  }
}

module.exports = { MAX_ARCHIVE_BYTES, extractSkillZip };
