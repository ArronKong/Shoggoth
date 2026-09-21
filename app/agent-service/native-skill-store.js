"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { hasSecret } = require("./memory-engine");
const { extractSkillZip } = require("./native-skill-archive");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const {
  ensurePrivateDirectoryTree,
  lstatIfExists,
  serviceError,
} = require("./security");

const SKILL_REGISTRY_SCHEMA_VERSION = 2;
const SKILL_PROFILE_SCHEMA_VERSION = 1;
const MAX_PACKAGE_FILES = 256;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_DEPTH = 8;
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_INSTRUCTION_BYTES = 256 * 1024;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const COMPATIBILITY = new Set(["shoggoth", "codex", "openclaw", "hermes"]);
const MANIFEST_FIELDS = Object.freeze([
  "schemaVersion", "id", "name", "version", "description", "entry",
  "requiredTools", "requiredRuntimeCapabilities", "sourceCompatibility",
]);
const ROOT_ENTRIES = new Set(["SKILL.md", "skill.json", "scripts", "references", "assets"]);
const TEXT_EXTENSIONS = new Set([
  ".md", ".json", ".txt", ".js", ".cjs", ".mjs", ".ts", ".tsx", ".py", ".sh",
  ".bash", ".zsh", ".yaml", ".yml", ".toml", ".xml", ".html", ".css", ".csv",
]);

function skillError(code, message) { return serviceError(code, message); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function own(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).every((key) => typeof key === "string");
}
function exact(value, fields) {
  return own(value) && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}
function safeText(value, maxBytes, empty = false) {
  return typeof value === "string" && value.isWellFormed() && !value.includes("\0")
    && (empty || value.length > 0) && Buffer.byteLength(value, "utf8") <= maxBytes;
}
function uniqueStrings(value, predicate, maxItems = 128) {
  return Array.isArray(value) && value.length <= maxItems
    && value.every((item) => typeof item === "string" && predicate(item))
    && new Set(value).size === value.length;
}
function validateManifest(value) {
  if (!exact(value, MANIFEST_FIELDS) || value.schemaVersion !== 1
    || !ID_PATTERN.test(value.id) || !NAME_PATTERN.test(value.name)
    || !VERSION_PATTERN.test(value.version) || !safeText(value.description, 4096)
    || value.entry !== "SKILL.md"
    || !uniqueStrings(value.requiredTools, (item) => ID_PATTERN.test(item))
    || !uniqueStrings(value.requiredRuntimeCapabilities, (item) => ID_PATTERN.test(item))
    || !uniqueStrings(value.sourceCompatibility, (item) => COMPATIBILITY.has(item), 4)
    || !value.sourceCompatibility.includes("shoggoth")) {
    throw skillError("SKILL_MANIFEST_INVALID", "Skill manifest 无效");
  }
  return Object.freeze(structuredClone(value));
}
function decodeText(bytes, label, required = false) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch {
    if (!required) return null;
    throw skillError("SKILL_TEXT_INVALID", `${label} 不是有效 UTF-8`);
  }
}
function assertOwned(stat, target, enforceOwner) {
  if (enforceOwner && typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw skillError("UNSAFE_OWNER", `Skill 路径不属于当前用户: ${target}`);
  }
}
function assertSafeDirectory(stat, target, enforceOwner) {
  if (stat?.isSymbolicLink?.()) throw skillError("UNSAFE_SYMLINK", `Skill 拒绝 symlink: ${target}`);
  if (!stat?.isDirectory?.()) throw skillError("UNSAFE_PATH", `Skill 路径不是目录: ${target}`);
  assertOwned(stat, target, enforceOwner);
}
function assertSafeFile(stat, target, enforceOwner) {
  if (stat?.isSymbolicLink?.()) throw skillError("UNSAFE_SYMLINK", `Skill 拒绝 symlink: ${target}`);
  if (!stat?.isFile?.()) throw skillError("UNSAFE_PATH", `Skill 路径不是普通文件: ${target}`);
  assertOwned(stat, target, enforceOwner);
  if (stat.nlink !== 1) throw skillError("UNSAFE_HARDLINK", `Skill 拒绝 hardlink: ${target}`);
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_FILE_BYTES) {
    throw skillError("SKILL_PACKAGE_TOO_LARGE", "Skill 单文件超过容量上限");
  }
}
function validateRelativePath(relativePath) {
  if (!safeText(relativePath, 1024) || path.isAbsolute(relativePath)) {
    throw skillError("SKILL_PATH_INVALID", "Skill 包路径无效");
  }
  const parts = relativePath.split(path.sep);
  if (parts.some((part) => part === "" || part === "." || part === "..")
    || parts.length > MAX_PACKAGE_DEPTH || !ROOT_ENTRIES.has(parts[0])) {
    throw skillError("SKILL_PATH_INVALID", "Skill 包路径越界或包含未知根条目");
  }
  return parts;
}
function scanPackage(sourcePath, options = {}) {
  const root = path.resolve(sourcePath);
  let rootStat;
  try { rootStat = fs.lstatSync(root); } catch {
    throw skillError("SKILL_PACKAGE_NOT_FOUND", "Skill 包目录不存在");
  }
  assertSafeDirectory(rootStat, root, options.enforceOwner !== false);
  const entries = [];
  let totalBytes = 0;
  const walk = (directory, relativeDirectory = "") => {
    const names = fs.readdirSync(directory).sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      if (!safeText(name, 255) || name === "." || name === "..") {
        throw skillError("SKILL_PATH_INVALID", "Skill 包含无效文件名");
      }
      const relativePath = relativeDirectory ? path.join(relativeDirectory, name) : name;
      const parts = validateRelativePath(relativePath);
      const target = path.join(directory, name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw skillError("UNSAFE_SYMLINK", `Skill 拒绝 symlink: ${target}`);
      if (stat.isDirectory()) {
        assertSafeDirectory(stat, target, options.enforceOwner !== false);
        if (parts.length === 1 && !["scripts", "references", "assets"].includes(parts[0])) {
          throw skillError("SKILL_PATH_INVALID", "Skill 根目录结构无效");
        }
        walk(target, relativePath);
        continue;
      }
      assertSafeFile(stat, target, options.enforceOwner !== false);
      entries.push({ path: relativePath.split(path.sep).join("/"), sourcePath: target, size: stat.size });
      totalBytes += stat.size;
      if (entries.length > MAX_PACKAGE_FILES || totalBytes > MAX_PACKAGE_BYTES) {
        throw skillError("SKILL_PACKAGE_TOO_LARGE", "Skill 包超过容量上限");
      }
    }
  };
  walk(root);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  if (!byPath.has("skill.json") || !byPath.has("SKILL.md")) {
    throw skillError("SKILL_MANIFEST_INVALID", "Skill 包缺少 skill.json 或 SKILL.md");
  }
  for (const entry of entries) {
    const bytes = fs.readFileSync(entry.sourcePath);
    if (bytes.length !== entry.size) throw skillError("UNSAFE_PATH", "Skill 文件读取期间发生变化");
    entry.sha256 = sha256(bytes);
    const extension = path.extname(entry.path).toLowerCase();
    const requiredText = entry.path === "skill.json" || entry.path === "SKILL.md";
    const text = decodeText(bytes, entry.path, requiredText || TEXT_EXTENSIONS.has(extension));
    if (text !== null && hasSecret(text)) {
      throw skillError("SKILL_SECRET_REJECTED", `Skill 文件包含敏感信息: ${entry.path}`);
    }
    if (entry.path === "skill.json") entry.text = text;
    if (entry.path === "SKILL.md") {
      if (bytes.length > MAX_SKILL_INSTRUCTION_BYTES || !text.trim()) {
        throw skillError("SKILL_INSTRUCTIONS_INVALID", "SKILL.md 无效或超过容量");
      }
      entry.text = text;
    }
  }
  let parsed;
  try { parsed = JSON.parse(byPath.get("skill.json").text); } catch {
    throw skillError("SKILL_MANIFEST_INVALID", "Skill manifest 不是有效 JSON");
  }
  const manifest = validateManifest(parsed);
  const files = entries.map(({ path: relativePath, size, sha256: fileHash }) => ({
    path: relativePath, size, sha256: fileHash,
  }));
  const contentHash = sha256(stable({ manifest, files }));
  return Object.freeze({ root, manifest, files: Object.freeze(files), contentHash });
}
function fsyncDirectory(target) {
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function createPrivateFile(target, bytes) {
  const fd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL
    | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function readStableOwnedFile(target) {
  const before = fs.lstatSync(target);
  assertSafeFile(before, target, true);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.nlink !== 1) {
      throw skillError("SKILL_PACKAGE_CHANGED", "Skill 文件 identity 发生变化");
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.lstatSync(target);
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || bytes.length !== before.size) {
      throw skillError("SKILL_PACKAGE_CHANGED", "Skill 文件读取期间发生变化");
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}
function materializePackage(scan, stagingRoot) {
  fs.mkdirSync(stagingRoot, { mode: 0o700 });
  for (const file of scan.files) {
    const source = path.join(scan.root, ...file.path.split("/"));
    const target = path.join(stagingRoot, ...file.path.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(target), 0o700);
    const bytes = fs.readFileSync(source);
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256) {
      throw skillError("SKILL_PACKAGE_CHANGED", "Skill 包在安装期间发生变化");
    }
    createPrivateFile(target, bytes);
  }
  const directories = new Set([stagingRoot]);
  for (const file of scan.files) {
    let cursor = path.dirname(path.join(stagingRoot, ...file.path.split("/")));
    while (cursor.startsWith(stagingRoot)) {
      directories.add(cursor);
      if (cursor === stagingRoot) break;
      cursor = path.dirname(cursor);
    }
  }
  [...directories].sort((left, right) => right.length - left.length).forEach(fsyncDirectory);
}
function safeRemoveTree(target) {
  const stat = lstatIfExists(target);
  if (!stat) return;
  if (stat.isSymbolicLink()) throw skillError("UNSAFE_SYMLINK", `拒绝删除 symlink: ${target}`);
  if (stat.isFile()) {
    if (stat.nlink !== 1) throw skillError("UNSAFE_HARDLINK", `拒绝删除 hardlink: ${target}`);
    fs.unlinkSync(target);
    return;
  }
  if (!stat.isDirectory()) throw skillError("UNSAFE_PATH", `拒绝删除特殊文件: ${target}`);
  for (const name of fs.readdirSync(target)) safeRemoveTree(path.join(target, name));
  fs.rmdirSync(target);
}
function prepareInstallSource(sourcePath, stagingDirectory) {
  const source = path.resolve(String(sourcePath || ""));
  let stat;
  try { stat = fs.lstatSync(source); } catch {
    throw skillError("SKILL_PACKAGE_NOT_FOUND", "Skill 包不存在");
  }
  if (stat.isSymbolicLink()) throw skillError("UNSAFE_SYMLINK", "Skill 安装源不能是 symlink");
  assertOwned(stat, source, true);
  if (stat.isDirectory()) return { scan: scanPackage(source), extracted: null };
  if (!stat.isFile() || stat.nlink !== 1 || path.extname(source).toLowerCase() !== ".zip") {
    throw skillError("SKILL_INSTALL_INVALID", "Skill 安装源必须是目录或 ZIP");
  }
  const extracted = path.join(stagingDirectory, `archive-${crypto.randomBytes(8).toString("hex")}`);
  try {
    extractSkillZip(source, extracted);
    return { scan: scanPackage(extracted), extracted };
  } catch (error) {
    if (lstatIfExists(extracted)) safeRemoveTree(extracted);
    throw error;
  }
}

function legacySkillName(sourcePath, instructions) {
  const frontmatter = instructions.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1] || "";
  const declared = frontmatter.match(/^name\s*:\s*["']?([^\r\n"']+)["']?\s*$/imu)?.[1];
  const raw = (declared || path.basename(sourcePath)).normalize("NFKC").toLocaleLowerCase("en-US");
  const normalized = raw.replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64);
  if (!NAME_PATTERN.test(normalized)) throw skillError("SKILL_IMPORT_INVALID", "导入 Skill 名称无效");
  const description = frontmatter.match(/^description\s*:\s*["']?([^\r\n"']+)["']?\s*$/imu)?.[1]?.trim();
  return {
    name: normalized,
    description: description && safeText(description, 4096)
      ? description : "Imported local Skill: " + normalized,
  };
}

function legacySkillAlias(runtime, name) {
  const prefix = String(runtime).toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "-");
  const alias = `${prefix}-${name}`.slice(0, 64).replace(/-+$/gu, "");
  if (!NAME_PATTERN.test(alias)) throw skillError("SKILL_IMPORT_INVALID", "导入 Skill 别名无效");
  return alias;
}

function materializeLegacySkill(sourcePath, staging, runtime) {
  const sourceRoot = path.resolve(sourcePath);
  const sourceStat = fs.lstatSync(sourceRoot);
  assertSafeDirectory(sourceStat, sourceRoot, true);
  const instructionsPath = path.join(sourceRoot, "SKILL.md");
  const instructionsStat = lstatIfExists(instructionsPath);
  if (!instructionsStat) {
    throw skillError("SKILL_IMPORT_INVALID", "导入 Skill 缺少 SKILL.md");
  }
  assertSafeFile(instructionsStat, instructionsPath, true);
  const sourceFiles = [];
  let totalBytes = 0;
  const visit = (directory, relativeDirectory = "") => {
    for (const name of fs.readdirSync(directory).sort((left, right) => left.localeCompare(right))) {
      if (relativeDirectory === "" && name === "skill.json") continue;
      const relativePath = relativeDirectory ? path.join(relativeDirectory, name) : name;
      if (!["SKILL.md", "scripts", "references", "assets"]
        .includes(relativePath.split(path.sep)[0])) continue;
      validateRelativePath(relativePath);
      const source = path.join(directory, name);
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink()) throw skillError("UNSAFE_SYMLINK", "Skill 拒绝 symlink: " + source);
      if (stat.isDirectory()) {
        assertSafeDirectory(stat, source, true);
        visit(source, relativePath);
        continue;
      }
      assertSafeFile(stat, source, true);
      totalBytes += stat.size;
      const bytes = readStableOwnedFile(source);
      sourceFiles.push({ relativePath, source, size: stat.size, bytes, sha256: sha256(bytes) });
      if (sourceFiles.length > MAX_PACKAGE_FILES || totalBytes > MAX_PACKAGE_BYTES) {
        throw skillError("SKILL_PACKAGE_TOO_LARGE", "导入 Skill 超过容量上限");
      }
    }
  };
  visit(sourceRoot);
  const instructionsFile = sourceFiles.find((file) => file.relativePath === "SKILL.md");
  const instructions = decodeText(instructionsFile?.bytes, "SKILL.md", true);
  if (!instructions.trim() || Buffer.byteLength(instructions, "utf8") > MAX_SKILL_INSTRUCTION_BYTES
    || hasSecret(instructions)) {
    throw skillError("SKILL_IMPORT_INVALID", "导入 Skill 指令无效或包含敏感信息");
  }
  const metadata = legacySkillName(sourceRoot, instructions);
  const sourceDigest = sha256(stable(sourceFiles.map((file) => ({
    path: file.relativePath.split(path.sep).join("/"),
    sha256: file.sha256,
  }))));
  const manifest = {
    schemaVersion: 1,
    id: "imported:" + metadata.name,
    name: metadata.name,
    version: "0.0.0-imported." + sourceDigest.slice(0, 12),
    description: metadata.description,
    entry: "SKILL.md",
    requiredTools: [],
    requiredRuntimeCapabilities: [],
    sourceCompatibility: ["shoggoth"],
  };
  validateManifest(manifest);
  fs.mkdirSync(staging, { mode: 0o700 });
  for (const file of sourceFiles) {
    const target = path.join(staging, file.relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(target), 0o700);
    createPrivateFile(target, file.bytes);
  }
  fs.writeFileSync(path.join(staging, "skill.json"), JSON.stringify(manifest, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  return manifest;
}
function publicPackage(record, enabled = false, eligibility = null) {
  return Object.freeze({
    id: record.id,
    name: record.name,
    version: record.version,
    description: record.description,
    source: record.source,
    contentHash: record.contentHash,
    requiredTools: [...record.requiredTools],
    requiredRuntimeCapabilities: [...record.requiredRuntimeCapabilities],
    sourceCompatibility: [...record.sourceCompatibility],
    globalEnabled: record.globalEnabled === true,
    enabled,
    eligible: eligibility ? eligibility.eligible : true,
    ineligibleReason: eligibility?.reason || null,
  });
}

class NativeSkillStore {
  constructor(options = {}) {
    if (!options.paths?.skillsDir || !options.paths?.skillPackagesDir
      || !options.paths?.skillRegistryPath || !options.paths?.agentsDir
      || !options.paths?.trustedRoot) {
      throw new TypeError("NativeSkillStore 需要 Service skill paths");
    }
    if (options.profileExists !== undefined && typeof options.profileExists !== "function") {
      throw new TypeError("NativeSkillStore profileExists 必须是函数");
    }
    this.paths = options.paths;
    this.builtinRoot = options.builtinRoot ? path.resolve(options.builtinRoot) : null;
    this.profileExists = options.profileExists || (() => true);
    this.now = options.now || Date.now;
    this.opened = false;
    this.registry = null;
    this.builtins = [];
    this.profileManifests = new Map();
  }
  get revision() { this._assertOpen(); return this.registry.revision; }
  get registryRevision() {
    this._assertOpen();
    return sha256(stable({
      registryRevision: this.registry.revision,
      packages: this._allPackages().map((item) => ({
        id: item.id, version: item.version, source: item.source, contentHash: item.contentHash,
        globalEnabled: item.globalEnabled === true,
      })),
    }));
  }
  _assertOpen() {
    if (!this.opened) throw skillError("SKILL_STORE_CLOSED", "Skill Store 未打开");
  }
  _profilePath(profileId) {
    if (!ID_PATTERN.test(profileId)) throw skillError("SKILL_PROFILE_INVALID", "Skill Profile id 无效");
    return path.join(this.paths.agentsDir, profileId, "skills", "manifest.json");
  }
  _usagePath(profileId) {
    return path.join(path.dirname(this._profilePath(profileId)), "usage.json");
  }
  _recordFromScan(scan, source, globalEnabled = false) {
    return Object.freeze({
      id: scan.manifest.id,
      name: scan.manifest.name,
      version: scan.manifest.version,
      description: scan.manifest.description,
      entry: scan.manifest.entry,
      requiredTools: [...scan.manifest.requiredTools],
      requiredRuntimeCapabilities: [...scan.manifest.requiredRuntimeCapabilities],
      sourceCompatibility: [...scan.manifest.sourceCompatibility],
      source,
      contentHash: scan.contentHash,
      files: scan.files.map((file) => ({ ...file })),
      globalEnabled: source === "user" && globalEnabled === true,
    });
  }
  _scanBuiltins() {
    if (!this.builtinRoot || !lstatIfExists(this.builtinRoot)) return [];
    const rootStat = fs.lstatSync(this.builtinRoot);
    assertSafeDirectory(rootStat, this.builtinRoot, false);
    return fs.readdirSync(this.builtinRoot).sort((left, right) => left.localeCompare(right)).map((name) => {
      if (!NAME_PATTERN.test(name)) throw skillError("SKILL_BUILTIN_INVALID", "内置 Skill 目录名无效");
      const scan = scanPackage(path.join(this.builtinRoot, name), { enforceOwner: false });
      if (scan.manifest.name !== name) throw skillError("SKILL_BUILTIN_INVALID", "内置 Skill 名称与目录不一致");
      return this._recordFromScan(scan, "builtin");
    });
  }
  _validateRegistry(value) {
    if (!exact(value, ["schemaVersion", "revision", "updatedAt", "packages"])
      || value.schemaVersion !== SKILL_REGISTRY_SCHEMA_VERSION
      || !Number.isSafeInteger(value.revision) || value.revision < 1
      || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0
      || !Array.isArray(value.packages)) {
      throw skillError("SKILL_REGISTRY_CORRUPT", "Skill Registry 无效");
    }
    const packages = value.packages.map((record) => {
      if (!own(record) || record.source !== "user" || !ID_PATTERN.test(record.id)
        || !NAME_PATTERN.test(record.name) || !VERSION_PATTERN.test(record.version)
        || !safeText(record.description, 4096) || record.entry !== "SKILL.md"
        || !HASH_PATTERN.test(record.contentHash) || !Array.isArray(record.files)
        || !uniqueStrings(record.requiredTools, (item) => ID_PATTERN.test(item))
        || !uniqueStrings(record.requiredRuntimeCapabilities, (item) => ID_PATTERN.test(item))
        || !uniqueStrings(record.sourceCompatibility, (item) => COMPATIBILITY.has(item), 4)
        || typeof record.globalEnabled !== "boolean") {
        throw skillError("SKILL_REGISTRY_CORRUPT", "Skill Registry package 无效");
      }
      const packageRoot = path.join(this.paths.skillPackagesDir, record.id, record.version);
      const scan = scanPackage(packageRoot);
      const actual = this._recordFromScan(scan, "user", record.globalEnabled);
      if (stable(actual) !== stable(record)) {
        throw skillError("SKILL_REGISTRY_CORRUPT", "Skill Registry package hash 不一致");
      }
      return actual;
    });
    const keys = packages.map((item) => `${item.id}\0${item.version}`);
    if (new Set(keys).size !== keys.length) throw skillError("SKILL_REGISTRY_CORRUPT", "Skill Registry 包重复");
    const globalIds = packages.filter((item) => item.globalEnabled).map((item) => item.id);
    if (new Set(globalIds).size !== globalIds.length) {
      throw skillError("SKILL_REGISTRY_CORRUPT", "同一 Skill 存在多个全局版本");
    }
    return { ...value, packages };
  }
  _cleanupOrphanPackages() {
    const referenced = new Set(this.registry.packages.map((item) => `${item.id}\0${item.version}`));
    for (const id of fs.readdirSync(this.paths.skillPackagesDir)) {
      const idRoot = path.join(this.paths.skillPackagesDir, id);
      const idStat = fs.lstatSync(idRoot);
      assertSafeDirectory(idStat, idRoot, true);
      for (const version of fs.readdirSync(idRoot)) {
        if (!referenced.has(`${id}\0${version}`)) safeRemoveTree(path.join(idRoot, version));
      }
      if (fs.readdirSync(idRoot).length === 0) fs.rmdirSync(idRoot);
    }
    for (const name of fs.readdirSync(this.paths.skillStagingDir)) {
      safeRemoveTree(path.join(this.paths.skillStagingDir, name));
    }
  }
  _loadProfile(profileId) {
    if (!this.profileExists(profileId)) throw skillError("SKILL_PROFILE_NOT_FOUND", "Shoggoth Agent Profile 不存在");
    const target = this._profilePath(profileId);
    ensurePrivateDirectoryTree(path.dirname(target), this.paths.trustedRoot);
    if (!lstatIfExists(target)) {
      const selections = this.registry.packages.filter((item) => item.globalEnabled).map((item) => ({
        skillId: item.id, source: item.source, version: item.version, enabled: true,
      })).sort((left, right) => left.skillId.localeCompare(right.skillId));
      const created = { schemaVersion: SKILL_PROFILE_SCHEMA_VERSION, revision: 1,
        updatedAt: this.now(), selections };
      atomicWritePrivateFile(target, `${JSON.stringify(created)}\n`, { trustedRoot: this.paths.trustedRoot });
    }
    let value;
    try { value = JSON.parse(readPrivateFile(target, { maxBytes: MAX_REGISTRY_BYTES }).toString("utf8")); }
    catch { throw skillError("SKILL_PROFILE_CORRUPT", "Skill Profile manifest 无法读取"); }
    if (!exact(value, ["schemaVersion", "revision", "updatedAt", "selections"])
      || value.schemaVersion !== SKILL_PROFILE_SCHEMA_VERSION
      || !Number.isSafeInteger(value.revision) || value.revision < 1
      || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0
      || !Array.isArray(value.selections)
      || value.selections.some((selection) => !exact(selection, ["skillId", "source", "version", "enabled"])
        || !ID_PATTERN.test(selection.skillId) || !["builtin", "user"].includes(selection.source)
        || !VERSION_PATTERN.test(selection.version) || typeof selection.enabled !== "boolean")) {
      throw skillError("SKILL_PROFILE_CORRUPT", "Skill Profile manifest 无效");
    }
    const keys = value.selections.map((item) => item.skillId);
    if (new Set(keys).size !== keys.length) throw skillError("SKILL_PROFILE_CORRUPT", "Skill Profile 选择重复");
    for (const selection of value.selections) {
      if (!this._findPackage(selection.skillId, selection.source, selection.version)) {
        throw skillError("SKILL_PROFILE_CORRUPT", "Skill Profile 引用了不存在的包");
      }
    }
    this.profileManifests.set(profileId, structuredClone(value));
    return structuredClone(value);
  }
  open(profileIds = []) {
    ensurePrivateDirectoryTree(this.paths.skillsDir, this.paths.trustedRoot);
    ensurePrivateDirectoryTree(this.paths.skillPackagesDir, this.paths.trustedRoot);
    ensurePrivateDirectoryTree(this.paths.skillStagingDir, this.paths.trustedRoot);
    ensurePrivateDirectoryTree(this.paths.agentsDir, this.paths.trustedRoot);
    this.builtins = this._scanBuiltins();
    if (!lstatIfExists(this.paths.skillRegistryPath)) {
      const created = { schemaVersion: SKILL_REGISTRY_SCHEMA_VERSION, revision: 1, updatedAt: this.now(), packages: [] };
      atomicWritePrivateFile(this.paths.skillRegistryPath, `${JSON.stringify(created)}\n`, {
        trustedRoot: this.paths.trustedRoot,
      });
    }
    let parsed;
    try {
      parsed = JSON.parse(readPrivateFile(this.paths.skillRegistryPath, {
        maxBytes: MAX_REGISTRY_BYTES,
      }).toString("utf8"));
    } catch { throw skillError("SKILL_REGISTRY_CORRUPT", "Skill Registry 无法读取"); }
    if (parsed?.schemaVersion === 1
      && exact(parsed, ["schemaVersion", "revision", "updatedAt", "packages"])
      && Array.isArray(parsed.packages)) {
      parsed = {
        ...parsed,
        schemaVersion: SKILL_REGISTRY_SCHEMA_VERSION,
        revision: parsed.revision + 1,
        updatedAt: this.now(),
        packages: parsed.packages.map((record) => ({ ...record, globalEnabled: false })),
      };
      atomicWritePrivateFile(this.paths.skillRegistryPath, `${JSON.stringify(parsed)}\n`, {
        trustedRoot: this.paths.trustedRoot,
      });
    }
    this.registry = this._validateRegistry(parsed);
    this._cleanupOrphanPackages();
    this.opened = true;
    try {
      for (const profileId of profileIds) this._loadProfile(profileId);
    } catch (error) {
      this.close();
      throw error;
    }
    return this;
  }
  close() {
    this.opened = false;
    this.registry = null;
    this.builtins = [];
    this.profileManifests.clear();
  }
  ensureProfile(profileId) { this._assertOpen(); return this.profileManifests.get(profileId) || this._loadProfile(profileId); }
  _allPackages() {
    return [...this.builtins, ...this.registry.packages].sort((left, right) => (
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
        || left.source.localeCompare(right.source)
    ));
  }
  _findPackage(id, source, version) {
    return [...this.builtins, ...(this.registry?.packages || [])].find((item) => (
      item.id === id && item.source === source && item.version === version
    )) || null;
  }
  _packageRoot(record) {
    if (record.source === "builtin") return path.join(this.builtinRoot, record.name);
    return path.join(this.paths.skillPackagesDir, record.id, record.version);
  }
  _commitRegistry(packages) {
    const next = {
      schemaVersion: SKILL_REGISTRY_SCHEMA_VERSION,
      revision: this.registry.revision + 1,
      updatedAt: this.now(),
      packages: packages.map((item) => structuredClone(item)),
    };
    atomicWritePrivateFile(this.paths.skillRegistryPath, `${JSON.stringify(next)}\n`, {
      trustedRoot: this.paths.trustedRoot,
    });
    this.registry = this._validateRegistry(next);
    return this.registry.revision;
  }
  installFromDirectory(input) {
    this._assertOpen();
    if (!input || !safeText(input.operationId, 128) || !ID_PATTERN.test(input.operationId)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== this.registry.revision) {
      if (input?.expectedRevision !== this.registry.revision) {
        throw skillError("SKILL_REGISTRY_REVISION_CONFLICT", "Skill Registry revision 已变化");
      }
      throw skillError("SKILL_INSTALL_INVALID", "Skill 安装参数无效");
    }
    const prepared = prepareInstallSource(input.sourcePath, this.paths.skillStagingDir);
    try {
      const { scan } = prepared;
      const globalEnabled = input.globalEnabled === true;
      const record = this._recordFromScan(scan, "user", globalEnabled);
      const existing = this.registry.packages.find((item) => (
        item.id === record.id && item.version === record.version
      ));
      if (existing) {
        if (existing.contentHash !== record.contentHash) {
          throw skillError("SKILL_VERSION_CONFLICT", "同一 Skill 版本内容冲突");
        }
        if (globalEnabled && (!existing.globalEnabled || this.registry.packages.some((item) => (
          item.id === existing.id && item.version !== existing.version && item.globalEnabled
        )))) {
          const promoted = Object.freeze({ ...existing, globalEnabled: true });
          const revision = this._commitRegistry(this.registry.packages.map((item) => (
            item.id === promoted.id && item.version === promoted.version
              ? promoted
              : item.id === promoted.id && item.globalEnabled
                ? Object.freeze({ ...item, globalEnabled: false })
                : item
          )));
          return { revision, package: publicPackage(promoted) };
        }
        return { revision: this.registry.revision, package: publicPackage(existing) };
      }
      const idRoot = path.join(this.paths.skillPackagesDir, record.id);
      ensurePrivateDirectoryTree(idRoot, this.paths.trustedRoot);
      const destination = path.join(idRoot, record.version);
      const staging = path.join(this.paths.skillStagingDir, `${record.id}-${record.version}-${crypto.randomBytes(8).toString("hex")}`);
      if (lstatIfExists(destination)) {
        const recovered = this._recordFromScan(scanPackage(destination), "user", globalEnabled);
        if (recovered.contentHash !== record.contentHash) {
          throw skillError("SKILL_VERSION_CONFLICT", "Skill 目标版本目录已存在且内容不同");
        }
      } else {
        try {
          materializePackage(scan, staging);
          fs.renameSync(staging, destination);
          fsyncDirectory(idRoot);
        } finally {
          if (lstatIfExists(staging)) safeRemoveTree(staging);
        }
      }
      const existingPackages = globalEnabled ? this.registry.packages.map((item) => (
        item.id === record.id && item.globalEnabled
          ? Object.freeze({ ...item, globalEnabled: false }) : item
      )) : this.registry.packages;
      const revision = this._commitRegistry([...existingPackages, record].sort((left, right) => (
        left.id.localeCompare(right.id) || left.version.localeCompare(right.version)
      )));
      return { revision, package: publicPackage(record) };
    } finally {
      if (prepared.extracted && lstatIfExists(prepared.extracted)) safeRemoveTree(prepared.extracted);
    }
  }
  installGlobalFromDirectory(input) {
    this._assertOpen();
    if (!input || !Array.isArray(input.profileIds)
      || input.profileIds.some((profileId) => !ID_PATTERN.test(profileId))) {
      throw skillError("SKILL_INSTALL_INVALID", "全局 Skill 安装参数无效");
    }
    const installed = this.installFromDirectory({
      operationId: input.operationId,
      sourcePath: input.sourcePath,
      expectedRevision: input.expectedRevision,
      globalEnabled: true,
    });
    const enabledProfiles = [];
    const failedProfiles = [];
    for (const profileId of [...new Set(input.profileIds)].sort()) {
      try {
        const profile = this.list(profileId);
        const selected = profile.items.find((item) => item.id === installed.package.id
          && item.version === installed.package.version && item.source === "user");
        if (!selected) throw skillError("SKILL_NOT_FOUND", "Skill 未进入 Profile catalog");
        if (!selected.enabled) {
          this.setProfileSkill({
            profileId,
            skillId: selected.id,
            source: selected.source,
            version: selected.version,
            enabled: true,
            expectedRevision: profile.profileRevision,
          });
        }
        enabledProfiles.push(profileId);
      } catch {
        failedProfiles.push(profileId);
      }
    }
    return {
      revision: this.registry.revision,
      package: publicPackage(this._findPackage(
        installed.package.id, installed.package.source, installed.package.version,
      ), true),
      enabledProfiles,
      failedProfiles,
      availableToFutureProfiles: true,
      complete: failedProfiles.length === 0,
    };
  }
  importLegacySkill(input) {
    this._assertOpen();
    if (!input || !ID_PATTERN.test(input.profileId)
      || typeof input.runtime !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(input.runtime)
      || typeof input.sourcePath !== "string" || !path.isAbsolute(input.sourcePath)) {
      throw skillError("SKILL_IMPORT_INVALID", "旧 Skill 导入参数无效");
    }
    const staging = path.join(
      this.paths.skillStagingDir,
      ".legacy-" + crypto.randomBytes(12).toString("hex"),
    );
    try {
      const manifest = materializeLegacySkill(input.sourcePath, staging, input.runtime);
      const current = this.list(input.profileId);
      const nameConflict = current.items.find((item) => item.name === manifest.name
        && (item.id !== manifest.id || item.version !== manifest.version));
      if (nameConflict) {
        const alias = legacySkillAlias(input.runtime, manifest.name);
        const aliasConflict = current.items.find((item) => item.name === alias
          && (item.id !== `imported:${alias}` || item.version !== manifest.version));
        if (aliasConflict) {
          return { enabled: aliasConflict.enabled, conflict: true, package: aliasConflict };
        }
        manifest.id = `imported:${alias}`;
        manifest.name = alias;
        manifest.description = `Imported ${manifest.name} from ${input.runtime}`;
        validateManifest(manifest);
        fs.writeFileSync(path.join(staging, "skill.json"), JSON.stringify(manifest, null, 2) + "\n", {
          mode: 0o600,
          flag: "w",
        });
      }
      const installed = this.installFromDirectory({
        operationId: "native-import-" + crypto.randomBytes(12).toString("hex"),
        sourcePath: staging,
        expectedRevision: this.registry.revision,
      });
      const profile = this.list(input.profileId);
      const selected = profile.items.find((item) => item.id === installed.package.id
        && item.version === installed.package.version);
      if (!selected) throw skillError("SKILL_IMPORT_INVALID", "导入 Skill 未进入 Registry");
      if (selected.enabled) return { enabled: true, conflict: false, package: selected };
      const enabled = this.setProfileSkill({
        profileId: input.profileId,
        skillId: selected.id,
        source: selected.source,
        version: selected.version,
        enabled: true,
        expectedRevision: profile.profileRevision,
      });
      return { enabled: true, conflict: false, package: enabled.skill };
    } finally {
      if (lstatIfExists(staging)) safeRemoveTree(staging);
    }
  }
  uninstall(input) {
    this._assertOpen();
    if (!input || input.source !== "user" || !ID_PATTERN.test(input.skillId)
      || !VERSION_PATTERN.test(input.version)) {
      throw skillError("SKILL_UNINSTALL_INVALID", "Skill 卸载参数无效");
    }
    if (input.expectedRevision !== this.registry.revision) {
      throw skillError("SKILL_REGISTRY_REVISION_CONFLICT", "Skill Registry revision 已变化");
    }
    const record = this._findPackage(input.skillId, "user", input.version);
    if (!record) throw skillError("SKILL_NOT_FOUND", "Skill 包不存在");
    for (const [profileId, manifest] of this.profileManifests) {
      if (manifest.selections.some((selection) => selection.skillId === input.skillId
        && selection.source === "user" && selection.version === input.version)) {
        throw skillError("SKILL_PACKAGE_IN_USE", `Skill 仍被 Profile 引用: ${profileId}`);
      }
    }
    const revision = this._commitRegistry(this.registry.packages.filter((item) => !(
      item.id === input.skillId && item.version === input.version
    )));
    safeRemoveTree(this._packageRoot(record));
    const idRoot = path.dirname(this._packageRoot(record));
    if (lstatIfExists(idRoot) && fs.readdirSync(idRoot).length === 0) fs.rmdirSync(idRoot);
    return { revision, removed: publicPackage(record) };
  }
  _manifest(profileId) { return this.profileManifests.get(profileId) || this._loadProfile(profileId); }
  setProfileSkill(input) {
    this._assertOpen();
    const manifest = this._manifest(input.profileId);
    if (manifest.revision !== input.expectedRevision) {
      throw skillError("SKILL_PROFILE_REVISION_CONFLICT", "Skill Profile revision 已变化");
    }
    const selectedPackage = this._findPackage(input.skillId, input.source, input.version);
    if (!selectedPackage || typeof input.enabled !== "boolean") {
      throw skillError("SKILL_NOT_FOUND", "Skill 包不存在");
    }
    // Enabling replaces this Skill's version lock. Disabling only releases the
    // requested package, never a different version currently selected by the Profile.
    const selections = manifest.selections.filter((item) => item.skillId !== input.skillId
      || (!input.enabled && (item.source !== input.source || item.version !== input.version)));
    if (input.enabled) {
      selections.push({
        skillId: input.skillId, source: input.source, version: input.version, enabled: true,
      });
    }
    selections.sort((left, right) => left.skillId.localeCompare(right.skillId));
    const next = {
      schemaVersion: SKILL_PROFILE_SCHEMA_VERSION,
      revision: manifest.revision + 1,
      updatedAt: this.now(),
      selections,
    };
    atomicWritePrivateFile(this._profilePath(input.profileId), `${JSON.stringify(next)}\n`, {
      trustedRoot: this.paths.trustedRoot,
    });
    this.profileManifests.set(input.profileId, next);
    return { revision: next.revision, skill: publicPackage(selectedPackage, input.enabled) };
  }
  list(profileId) {
    this._assertOpen();
    const manifest = this._manifest(profileId);
    const selections = new Map(manifest.selections.map((item) => [item.skillId, item]));
    return {
      registryRevision: this.registryRevision,
      registryVersion: this.registry.revision,
      profileRevision: manifest.revision,
      items: this._allPackages().map((record) => {
        const selected = selections.get(record.id);
        const enabled = selected?.enabled === true && selected.source === record.source
          && selected.version === record.version;
        return publicPackage(record, enabled);
      }),
    };
  }
  _eligibility(record, options) {
    const available = new Set(options.availableTools || []);
    const allowed = new Set(options.allowedTools || []);
    const capabilities = new Set(options.runtimeCapabilities || []);
    const missingTool = record.requiredTools.find((tool) => !available.has(tool));
    if (missingTool) return { eligible: false, reason: "tool_missing", dependency: missingTool };
    const forbidden = record.requiredTools.find((tool) => !allowed.has(tool));
    if (forbidden) return { eligible: false, reason: "tool_forbidden", dependency: forbidden };
    const missingCapability = record.requiredRuntimeCapabilities.find((item) => !capabilities.has(item));
    if (missingCapability) return { eligible: false, reason: "runtime_capability_missing", dependency: missingCapability };
    return { eligible: true, reason: null, dependency: null };
  }
  _selected(profileId) {
    const manifest = this._manifest(profileId);
    return manifest.selections.filter((item) => item.enabled).map((selection) => {
      const record = this._findPackage(selection.skillId, selection.source, selection.version);
      if (!record) throw skillError("SKILL_PROFILE_CORRUPT", "Skill Profile 引用丢失");
      return record;
    });
  }
  catalog(profileId, options = {}) {
    this._assertOpen();
    const items = [];
    const ineligible = [];
    for (const record of this._selected(profileId)) {
      const eligibility = this._eligibility(record, options);
      const projected = publicPackage(record, true, eligibility);
      if (eligibility.eligible) items.push(projected);
      else ineligible.push({ ...projected, reason: eligibility.reason, dependency: eligibility.dependency });
    }
    return {
      registryRevision: this.registryRevision,
      profileRevision: this._manifest(profileId).revision,
      items,
      ineligible,
    };
  }
  select(profileId, query, options = {}) {
    this._assertOpen();
    const catalog = this.catalog(profileId, options);
    const mentions = [...String(query || "").matchAll(/\$([a-z0-9][a-z0-9-]{0,63})(?![a-z0-9-])/gu)]
      .map((match) => match[1]);
    if (new Set(mentions).size > 4) {
      throw skillError("SKILL_SELECTION_LIMIT", "单次 Run 最多显式选择四个 Skill");
    }
    const selected = [];
    for (const name of [...new Set(mentions)]) {
      const item = catalog.items.find((candidate) => candidate.name === name);
      if (item) { selected.push(item); continue; }
      if (catalog.ineligible.some((candidate) => candidate.name === name)) {
        throw skillError("SKILL_INELIGIBLE", `Skill 当前依赖不可用: ${name}`);
      }
      if (this._allPackages().some((candidate) => candidate.name === name)) {
        throw skillError("SKILL_NOT_ENABLED", `Skill 未为当前 Agent 启用: ${name}`);
      }
      throw skillError("SKILL_NOT_FOUND", `Skill 不存在: ${name}`);
    }
    return { ...catalog, selected };
  }
  read(input) {
    this._assertOpen();
    const record = this._selected(input.profileId).find((item) => item.name === input.name);
    if (!record) throw skillError("SKILL_NOT_ENABLED", "Skill 未为当前 Agent 启用");
    if (input.contentHash !== undefined && input.contentHash !== record.contentHash) {
      throw skillError("SKILL_REVISION_CHANGED", "Skill 内容版本已变化");
    }
    const target = path.join(this._packageRoot(record), "SKILL.md");
    const stat = fs.lstatSync(target);
    assertSafeFile(stat, target, record.source === "user");
    const bytes = fs.readFileSync(target);
    const content = decodeText(bytes, "SKILL.md", true);
    if (sha256(bytes) !== record.files.find((file) => file.path === "SKILL.md")?.sha256
      || hasSecret(content)) {
      throw skillError("SKILL_PACKAGE_CHANGED", "Skill 内容校验失败");
    }
    if (input.recordUsage === true) this._recordUsage(input.profileId, record.name);
    return { ...publicPackage(record, true), content };
  }
  preview(input) {
    this._assertOpen();
    const record = this._findPackage(input.skillId, input.source, input.version);
    if (!record) throw skillError("SKILL_NOT_FOUND", "Skill 包不存在");
    const target = path.join(this._packageRoot(record), "SKILL.md");
    const bytes = fs.readFileSync(target);
    const content = decodeText(bytes, "SKILL.md", true);
    if (sha256(bytes) !== record.files.find((file) => file.path === "SKILL.md")?.sha256
      || hasSecret(content)) throw skillError("SKILL_PACKAGE_CHANGED", "Skill 内容校验失败");
    return { ...publicPackage(record), content };
  }
  _recordUsage(profileId, name) {
    const target = this._usagePath(profileId);
    let usage = { schemaVersion: 1, revision: 0, updatedAt: 0, counts: {} };
    if (lstatIfExists(target)) {
      try { usage = JSON.parse(readPrivateFile(target, { maxBytes: MAX_REGISTRY_BYTES }).toString("utf8")); }
      catch { throw skillError("SKILL_USAGE_CORRUPT", "Skill 使用记录无法读取"); }
    }
    if (!exact(usage, ["schemaVersion", "revision", "updatedAt", "counts"])
      || usage.schemaVersion !== 1 || !Number.isSafeInteger(usage.revision) || usage.revision < 0
      || !own(usage.counts)) throw skillError("SKILL_USAGE_CORRUPT", "Skill 使用记录无效");
    usage.counts[name] = (usage.counts[name] || 0) + 1;
    usage.revision += 1;
    usage.updatedAt = this.now();
    atomicWritePrivateFile(target, `${JSON.stringify(usage)}\n`, { trustedRoot: this.paths.trustedRoot });
  }
  usage(profileId) {
    this._assertOpen();
    this._manifest(profileId);
    const target = this._usagePath(profileId);
    if (!lstatIfExists(target)) return { supported: true, skills: {} };
    let usage;
    try { usage = JSON.parse(readPrivateFile(target, { maxBytes: MAX_REGISTRY_BYTES }).toString("utf8")); }
    catch { throw skillError("SKILL_USAGE_CORRUPT", "Skill 使用记录无法读取"); }
    if (!own(usage.counts)) throw skillError("SKILL_USAGE_CORRUPT", "Skill 使用记录无效");
    return {
      supported: true,
      skills: Object.fromEntries(Object.entries(usage.counts).map(([name, count]) => (
        [name, { [profileId]: count }]
      ))),
    };
  }
  materialization(profileId) {
    this._assertOpen();
    return this._selected(profileId).map((record) => ({
      package: publicPackage(record, true),
      root: this._packageRoot(record),
      files: record.files.map((file) => ({ ...file })),
    }));
  }
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_PACKAGE_BYTES,
  MAX_PACKAGE_DEPTH,
  MAX_PACKAGE_FILES,
  NativeSkillStore,
  SKILL_PROFILE_SCHEMA_VERSION,
  SKILL_REGISTRY_SCHEMA_VERSION,
  scanPackage,
  validateManifest,
};
