"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { convertLegacyPluginContents } = require("../core/legacy-plugin-content-adapter");
const { assertPrivateDirectory, serviceError } = require("./security");

const PROVENANCE_FILE = "legacy-provenance.json";
const MAX_FILES = 256;
const MAX_ENTRIES = 512;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const BUNDLED_LIMITS = Object.freeze({ files: 1_024, entries: 2_048,
  totalBytes: 32 * 1024 * 1024, depth: 13 });
const LEGACY_LIMITS = Object.freeze({ files: MAX_FILES, entries: MAX_ENTRIES,
  totalBytes: MAX_TOTAL_BYTES, depth: 8 });

function fail(code) { throw serviceError(code, "历史插件来源无效、变化或超出容量"); }
function owned(stat) { return typeof process.getuid !== "function" || stat.uid === process.getuid(); }
function sameStat(left, right) {
  return ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeMs", "ctimeMs"]
    .every((field) => left[field] === right[field]);
}
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function identifyLegacySource({ sourcePath, format, components, trustedBundled = false } = {}) {
  if (typeof sourcePath !== "string" || !sourcePath || !sourcePath.isWellFormed()
    || sourcePath.includes("\0") || Buffer.byteLength(sourcePath) > 4096
    || !["claude-plugin", "codex-plugin"].includes(format) || !Array.isArray(components)
    || components.length === 0 || components.length > 2 || new Set(components).size !== components.length
    || components.some((item) => !["skills", "mcp-servers"].includes(item))) fail("LEGACY_SOURCE_INVALID");
  const requested = path.resolve(sourcePath);
  let root;
  try {
    const initial = fs.lstatSync(requested);
    if (!initial.isDirectory() || initial.isSymbolicLink()
      || (!trustedBundled && !owned(initial))) fail("LEGACY_SOURCE_INVALID");
    root = fs.realpathSync(requested);
    if (!sameStat(initial, fs.lstatSync(root))) fail("PACKAGE_CHANGED");
  } catch (error) { if (error?.code === "PACKAGE_CHANGED") throw error; fail("LEGACY_SOURCE_INVALID"); }
  const selected = [...components].sort();
  const sourceIdentity = `legacy:${JSON.stringify({ format, path: root, components: selected })}`;
  if (sourceIdentity.length > 4096) fail("LEGACY_SOURCE_INVALID");
  return Object.freeze({ root, format, components: Object.freeze(selected), sourceIdentity,
    ...(trustedBundled ? { trustedBundled: true } : {}) });
}
function readFilePinned(target, root, before, trustedBundled = false) {
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || (!trustedBundled && !owned(before))
    || before.size < 0 || before.size > MAX_FILE_BYTES || !inside(root, fs.realpathSync(target))) {
    fail("LEGACY_SOURCE_INVALID");
  }
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!sameStat(before, opened)) fail("PACKAGE_CHANGED");
    // A growing file must never turn a bounded preview into an unbounded read.
    const buffer = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    const after = fs.lstatSync(target);
    if (size !== before.size || !sameStat(before, after) || !sameStat(before, fs.fstatSync(fd))
      || !inside(root, fs.realpathSync(target))) fail("PACKAGE_CHANGED");
    return buffer.subarray(0, size);
  } finally { fs.closeSync(fd); }
}
function scanLegacySource(source) {
  const limits = source.trustedBundled ? BUNDLED_LIMITS : LEGACY_LIMITS;
  const files = [];
  let count = 0;
  let bytes = 0;
  const walk = (directory, prefix, depth) => {
    if (depth > limits.depth) fail("PACKAGE_TOO_LARGE");
    const before = fs.lstatSync(directory);
    if (!before.isDirectory() || before.isSymbolicLink()
      || (!source.trustedBundled && !owned(before))
      || !inside(source.root, fs.realpathSync(directory))) fail("LEGACY_SOURCE_INVALID");
    const names = [];
    const reader = fs.opendirSync(directory);
    try {
      let entry;
      while ((entry = reader.readSync())) {
        if (++count > limits.entries) fail("PACKAGE_TOO_LARGE");
        names.push(entry.name);
      }
    } finally { reader.closeSync(); }
    names.sort();
    for (const name of names) {
      if (!name || name === "." || name === ".." || !name.isWellFormed()
        || /[\\\u0000-\u001f\u007f]/u.test(name) || Buffer.byteLength(name) > 255) fail("LEGACY_SOURCE_INVALID");
      const relative = prefix ? `${prefix}/${name}` : name;
      if (relative === PROVENANCE_FILE) fail("LEGACY_FORMAT_AMBIGUOUS");
      const target = path.join(directory, name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || (!source.trustedBundled && !owned(stat))) fail("LEGACY_SOURCE_INVALID");
      if (stat.isDirectory()) { walk(target, relative, depth + 1); continue; }
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) fail("LEGACY_SOURCE_INVALID");
      if (files.length + 1 > limits.files || (bytes += stat.size) > limits.totalBytes) fail("PACKAGE_TOO_LARGE");
      files.push({ path: relative, content: readFilePinned(target, source.root, stat,
        source.trustedBundled),
        executable: (stat.mode & 0o111) !== 0 });
    }
    if (!sameStat(before, fs.lstatSync(directory)) || !inside(source.root, fs.realpathSync(directory))) {
      fail("PACKAGE_CHANGED");
    }
  };
  try { walk(source.root, "", 0); }
  catch (error) {
    if (["LEGACY_SOURCE_INVALID", "LEGACY_FORMAT_AMBIGUOUS", "PACKAGE_TOO_LARGE", "PACKAGE_CHANGED"].includes(error?.code)) throw error;
    fail("PACKAGE_CHANGED");
  }
  const conversion = convertLegacyPluginContents({ format: source.format, files,
    components: source.components, ...(source.trustedBundled ? { bundledCodex: true } : {}) });
  return { source, files, conversion };
}
function assertLegacySourceCurrent(snapshot) {
  const current = scanLegacySource(snapshot.source);
  if (current.conversion.provenance.inputDigest !== snapshot.conversion.provenance.inputDigest
    || current.conversion.provenance.conversionDigest !== snapshot.conversion.provenance.conversionDigest) {
    fail("PACKAGE_CHANGED");
  }
}
function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function materializeLegacySource(snapshot, destination) {
  const limits = snapshot.source.trustedBundled ? BUNDLED_LIMITS : LEGACY_LIMITS;
  assertPrivateDirectory(path.dirname(destination));
  const root = path.join(fs.realpathSync(path.dirname(destination)), path.basename(destination));
  const originals = new Map(snapshot.files.map((file) => [file.path, file]));
  const provenance = { version: 1, ...snapshot.conversion.provenance,
    components: [...snapshot.source.components] };
  const output = [...snapshot.conversion.retainedPaths.map((name) => originals.get(name)),
    ...snapshot.conversion.generatedFiles, { path: PROVENANCE_FILE,
      content: `${JSON.stringify(provenance, null, 2)}\n`, executable: false }];
  if (output.length > limits.files
    || output.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > limits.totalBytes) {
    fail("PACKAGE_TOO_LARGE");
  }
  fs.mkdirSync(root, { mode: 0o700 });
  const directories = new Set([root]);
  for (const file of output) {
    const target = path.join(root, ...file.path.split("/"));
    if (!inside(root, target)) fail("LEGACY_SOURCE_INVALID");
    fs.mkdirSync(path.dirname(target), { mode: 0o700, recursive: true });
    let parent = path.dirname(target);
    while (parent !== root) { directories.add(parent); parent = path.dirname(parent); }
    const fd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL
      | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try {
      fs.writeFileSync(fd, file.content);
      fs.fchmodSync(fd, file.executable ? 0o700 : 0o600);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    assertPrivateDirectory(directory);
    fsyncDirectory(directory);
  }
  assertLegacySourceCurrent(snapshot);
  return { root, provenance, provenanceDigest: hash(JSON.stringify(provenance)) };
}

module.exports = { identifyLegacySource, scanLegacySource, materializeLegacySource,
  assertLegacySourceCurrent, PROVENANCE_FILE };
