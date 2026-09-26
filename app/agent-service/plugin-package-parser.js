"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const Ajv2020 = require("ajv/dist/2020");
const yaml = require("js-yaml");
const manifestSchema = require("../../schemas/agent-plugins/1.0.0/plugin.schema.json");
const mcpSchema = require("../../schemas/agent-plugins/1.0.0/mcp.schema.json");
const { serviceError } = require("./security");

const MAX_FILES = 256;
const MAX_ENTRIES = 512;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 8;
const BUNDLED_LIMITS = Object.freeze({ files: 1_024, entries: 2_048,
  totalBytes: 32 * 1024 * 1024, depth: 13 });
const DEFAULT_LIMITS = Object.freeze({ files: MAX_FILES, entries: MAX_ENTRIES,
  totalBytes: MAX_TOTAL_BYTES, depth: MAX_DEPTH });
const MAX_MANIFEST_BYTES = 256 * 1024;
const SKILL_NAME = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const BARE_COMMAND = /^[^./\\\s][^/\\\s]*$/u;
const SCHEMA_VERSION = "1.0.0";

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateManifestSchema = ajv.compile(manifestSchema);
const validateMcpTop = ajv.compile({
  $schema: mcpSchema.$schema,
  type: "object",
  properties: {
    $schema: mcpSchema.properties.$schema,
    mcpServers: { type: "object" },
  },
  required: ["$schema", "mcpServers"],
  additionalProperties: false,
});
const validateMcpEntry = ajv.compile({
  $schema: mcpSchema.$schema,
  $defs: mcpSchema.$defs,
  $ref: "#/$defs/server",
});

function fail(code, message) { throw serviceError(code, message); }
function own(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function within(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}
function hash(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function bytesOf(target, maxBytes) {
  const before = fs.lstatSync(target);
  if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes || before.size < 0) {
    fail("PACKAGE_INVALID", `插件文件无效或超出容量: ${target}`);
  }
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      fail("PACKAGE_CHANGED", `插件文件读取期间被替换: ${target}`);
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.lstatSync(target);
    if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino
      || after.mtimeMs !== before.mtimeMs || after.size !== before.size
      || after.mode !== before.mode) {
      fail("PACKAGE_CHANGED", `插件文件读取期间变化: ${target}`);
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}
function parseJsonFile(target, maxBytes = MAX_MANIFEST_BYTES) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytesOf(target, maxBytes));
    return JSON.parse(text);
  } catch (error) {
    if (error?.code) throw error;
    fail("PACKAGE_INVALID", `插件 JSON 无法读取: ${target}`);
  }
}
function scanFiles(root, limits = DEFAULT_LIMITS) {
  const files = [];
  const unsafe = [];
  let totalBytes = 0;
  let entryCount = 0;
  const walk = (directory, prefix = "", depth = 0) => {
    if (depth > limits.depth) fail("PACKAGE_TOO_LARGE", "插件目录过深");
    const names = [];
    const reader = fs.opendirSync(directory);
    try {
      let entry;
      while ((entry = reader.readSync())) {
        if (++entryCount > limits.entries) fail("PACKAGE_TOO_LARGE", "插件目录条目过多");
        names.push(entry.name);
      }
    } finally { reader.closeSync(); }
    names.sort();
    for (const name of names) {
      if (!name || Buffer.byteLength(name, "utf8") > 255
        || name === "." || name === ".." || name.includes("\0")) {
        fail("PACKAGE_INVALID", "插件文件名无效");
      }
      const relative = prefix ? `${prefix}/${name}` : name;
      const target = path.join(directory, name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        unsafe.push(relative);
        continue;
      }
      if (stat.isDirectory()) {
        walk(target, relative, depth + 1);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 0 || stat.size > MAX_FILE_BYTES) {
        fail("PACKAGE_INVALID", `插件包含特殊文件或超大文件: ${relative}`);
      }
      totalBytes += stat.size;
      if (files.length + 1 > limits.files || totalBytes > limits.totalBytes) {
        fail("PACKAGE_TOO_LARGE", "插件超过容量上限");
      }
      const bytes = bytesOf(target, MAX_FILE_BYTES);
      if (fs.lstatSync(target).mode !== stat.mode) {
        fail("PACKAGE_CHANGED", `插件文件模式在读取期间变化: ${relative}`);
      }
      files.push({ path: relative, size: bytes.length, sha256: hash(bytes),
        executable: (stat.mode & 0o111) !== 0 });
    }
  };
  walk(root);
  return { files, unsafe };
}
function fixedPath(root, relative, kind) {
  const target = path.join(root, relative);
  let stat;
  try { stat = fs.lstatSync(target); }
  catch (error) {
    if (error?.code === "ENOENT") return { status: "missing" };
    return { status: "invalid", reasonCode: "PACKAGE_PATH_INVALID" };
  }
  if (stat.isSymbolicLink()) return { status: "invalid", reasonCode: "PACKAGE_PATH_INVALID" };
  if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) {
    return { status: "invalid", reasonCode: "PACKAGE_PATH_INVALID" };
  }
  const real = fs.realpathSync(target);
  if (!within(root, real)) return { status: "invalid", reasonCode: "PACKAGE_PATH_INVALID" };
  return { status: "valid", path: target };
}
function validateManifest(root, diagnostics) {
  const file = fixedPath(root, "plugin.json", "file");
  if (file.status !== "valid") fail("PACKAGE_INVALID", "插件根目录缺少有效 plugin.json");
  const source = parseJsonFile(file.path);
  if (!own(source)) fail("PACKAGE_INVALID", "plugin.json 必须是对象");
  if (source.$schema !== manifestSchema.$id) fail("FORMAT_UNSUPPORTED", "插件标准版本不受支持");
  const normalized = { ...source };
  const allowed = new Set(Object.keys(manifestSchema.properties));
  for (const key of Object.keys(normalized)) {
    if (!allowed.has(key)) {
      diagnostics.push({ scope: "manifest", name: key, reasonCode: "UNKNOWN_FIELD_IGNORED" });
      delete normalized[key];
    }
  }
  if (Object.hasOwn(normalized, "extensions")) {
    if (!own(normalized.extensions)) {
      diagnostics.push({ scope: "manifest", name: "extensions", reasonCode: "INVALID_EXTENSION_IGNORED" });
    }
    // No Shoggoth extension namespace is implemented yet. Other namespaces are opaque.
    delete normalized.extensions;
  }
  if (!validateManifestSchema(normalized)) {
    fail("PACKAGE_INVALID", `plugin.json 字段无效: ${validateManifestSchema.errors[0]?.instancePath || "root"}`);
  }
  return normalized;
}
function parseSkill(target, directoryName) {
  const bytes = bytesOf(target, MAX_FILE_BYTES);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!match) return null;
  const frontmatter = yaml.load(match[1], { schema: yaml.JSON_SCHEMA });
  if (!own(frontmatter) || !SKILL_NAME.test(frontmatter.name)
    || frontmatter.name.length > 64 || frontmatter.name !== directoryName
    || typeof frontmatter.description !== "string"
    || frontmatter.description.length < 1 || frontmatter.description.length > 1024
    || (Object.hasOwn(frontmatter, "compatibility")
      && (typeof frontmatter.compatibility !== "string" || frontmatter.compatibility.length < 1
        || frontmatter.compatibility.length > 500))
    || (Object.hasOwn(frontmatter, "metadata") && (!own(frontmatter.metadata)
      || Object.values(frontmatter.metadata).some((value) => typeof value !== "string")))) return null;
  return { name: frontmatter.name, description: frontmatter.description,
    descriptorDigest: hash(bytes) };
}
function discoverSkills(root, diagnostics) {
  const base = fixedPath(root, "skills", "directory");
  if (base.status === "missing") return [];
  if (base.status !== "valid") {
    diagnostics.push({ scope: "skills", reasonCode: "COMPONENT_INVALID" });
    return [];
  }
  const skills = [];
  for (const name of fs.readdirSync(base.path).sort()) {
    const directory = fixedPath(root, `skills/${name}`, "directory");
    if (directory.status !== "valid") continue;
    const skillFile = fixedPath(root, `skills/${name}/SKILL.md`, "file");
    if (skillFile.status === "missing") continue;
    if (skillFile.status !== "valid") {
      diagnostics.push({ scope: "skill", name, reasonCode: "COMPONENT_INVALID" });
      continue;
    }
    try {
      const skill = parseSkill(skillFile.path, name);
      if (!skill) throw new Error("skill invalid");
      skills.push({ ...skill, path: `skills/${name}/SKILL.md` });
    } catch {
      diagnostics.push({ scope: "skill", name, reasonCode: "COMPONENT_INVALID" });
    }
  }
  return skills;
}
function validatePackageRelative(root, value) {
  if (!value.startsWith("./") || value.includes("\0")) return false;
  const resolved = path.resolve(root, value);
  if (!within(root, resolved)) return false;
  try { return within(root, fs.realpathSync(resolved)); }
  catch (error) { return error?.code === "ENOENT"; }
}
function validateCwd(root, value) {
  if (value.startsWith("./")) return validatePackageRelative(root, value);
  for (const token of ["${PLUGIN_ROOT}", "${PLUGIN_DATA}"]) {
    if (value === token) return true;
    if (value.startsWith(`${token}/`)) {
      const tail = value.slice(token.length + 1);
      if (!tail || tail.includes("\0")) return false;
      if (token === "${PLUGIN_ROOT}") return validatePackageRelative(root, `./${tail}`);
      const dataRoot = path.resolve(path.sep, "PLUGIN_DATA_SENTINEL");
      return within(dataRoot, path.resolve(dataRoot, tail));
    }
  }
  return false;
}
function validateHttp(record) {
  let url;
  try { url = new URL(record.url); } catch { return false; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) return false;
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  const loopback = host === "localhost" || host === "::1"
    || (net.isIP(host) === 4 && host.startsWith("127."));
  if (url.protocol === "http:" && !loopback) return false;
  const headers = record.headers || {};
  const seen = new Set();
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (seen.has(key) || ["authorization", "cookie", "proxy-authorization"].includes(key)) return false;
    seen.add(key);
    try { http.validateHeaderName(name); http.validateHeaderValue(name, value); }
    catch { return false; }
  }
  return true;
}
function discoverMcp(root, diagnostics) {
  const file = fixedPath(root, "mcp.json", "file");
  if (file.status === "missing") return [];
  if (file.status !== "valid") {
    diagnostics.push({ scope: "mcp", reasonCode: "COMPONENT_INVALID" });
    return [];
  }
  let config;
  try { config = parseJsonFile(file.path); }
  catch {
    diagnostics.push({ scope: "mcp", reasonCode: "COMPONENT_INVALID" });
    return [];
  }
  if (config?.$schema !== mcpSchema.$id) {
    diagnostics.push({ scope: "mcp", reasonCode: "FORMAT_UNSUPPORTED" });
    return [];
  }
  if (!validateMcpTop(config)) {
    diagnostics.push({ scope: "mcp", reasonCode: "COMPONENT_INVALID" });
    return [];
  }
  const servers = [];
  for (const [name, record] of Object.entries(config.mcpServers)) {
    let reasonCode = null;
    if (!validateMcpEntry(record)) reasonCode = "COMPONENT_INVALID";
    else if (record.type === "sse") reasonCode = "COMPONENT_UNSUPPORTED";
    else if (record.type === "stdio") {
      const command = record.command;
      if (!(BARE_COMMAND.test(command) || validatePackageRelative(root, command))
        || (record.cwd !== undefined && !validateCwd(root, record.cwd))) {
        reasonCode = "COMPONENT_INVALID";
      }
    } else if (!validateHttp(record)) reasonCode = "COMPONENT_INVALID";
    if (reasonCode) {
      diagnostics.push({ scope: "mcp-server", name, reasonCode });
      continue;
    }
    servers.push({ name, type: record.type, descriptorDigest: hash(canonical(record)) });
  }
  return servers;
}
function readPluginMcpServer(root, name) {
  const file = fixedPath(root, "mcp.json", "file");
  if (file.status !== "valid") fail("PACKAGE_CHANGED", "插件 MCP 配置已消失或变为不安全路径");
  const config = parseJsonFile(file.path);
  const server = discoverMcp(root, []).find((item) => item.name === name);
  const record = config?.mcpServers?.[name];
  if (!server || !own(record) || server.descriptorDigest !== hash(canonical(record))) {
    fail("PACKAGE_CHANGED", "插件 MCP 组件内容已变化");
  }
  return { ...server, spec: structuredClone(record) };
}
function previewPluginDirectory(directory, { trustedBundled = false } = {}) {
  const root = path.resolve(directory);
  let stat;
  try { stat = fs.lstatSync(root); }
  catch { fail("PACKAGE_NOT_FOUND", "插件目录不存在"); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("PACKAGE_INVALID", "插件根目录无效");
  const resolvedRoot = fs.realpathSync(root);
  const diagnostics = [];
  const manifest = validateManifest(resolvedRoot, diagnostics);
  const { files, unsafe } = scanFiles(resolvedRoot,
    trustedBundled ? BUNDLED_LIMITS : DEFAULT_LIMITS);
  for (const relative of unsafe) {
    diagnostics.push({ scope: "path", name: relative, reasonCode: "PACKAGE_PATH_INVALID" });
  }
  const skills = discoverSkills(resolvedRoot, diagnostics);
  const mcpServers = discoverMcp(resolvedRoot, diagnostics);
  const contentDigest = hash(canonical(files));
  return Object.freeze({
    specVersion: SCHEMA_VERSION,
    name: manifest.name,
    declaredVersion: manifest.version || null,
    contentDigest,
    root: resolvedRoot,
    files,
    skills,
    mcpServers,
    diagnostics,
    installable: unsafe.length === 0,
  });
}

module.exports = { previewPluginDirectory, readPluginMcpServer, validatePackageRelative };
