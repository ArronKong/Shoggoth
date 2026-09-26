"use strict";

const { createHash } = require("node:crypto");
const { TextDecoder } = require("node:util");
const http = require("node:http");
const net = require("node:net");
const yaml = require("js-yaml");
const Ajv2020 = require("ajv/dist/2020");
const manifestSchema = require("../../schemas/agent-plugins/1.0.0/plugin.schema.json");
const mcpSchema = require("../../schemas/agent-plugins/1.0.0/mcp.schema.json");

// Deliberately pure: the caller supplies an already safely scanned immutable
// file inventory. This module never opens a path, resolves env, or executes code.
// The conversion is selective, not a claim that native host plugins are portable.
const ADAPTER_VERSION = "legacy-content-v1";
const FORMATS = Object.freeze({ "claude-plugin": ".claude-plugin/plugin.json",
  "codex-plugin": ".codex-plugin/plugin.json" });
const METADATA = ["name", "version", "description", "author", "homepage", "repository", "license", "keywords"];
const SKILL_NAME = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const STANDARD_SKILL_FIELDS = new Set(["name", "description", "license", "compatibility", "metadata"]);
const LEGACY_CONTROL_FILES = new Set([".mcp.json", ".app.json", ".lsp.json", "settings.json",
  ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]);
const ajv = new Ajv2020({ strict: true });
const validateManifest = ajv.compile(manifestSchema);
const validateMcp = ajv.compile(mcpSchema);
const decoder = new TextDecoder("utf-8", { fatal: true });

function fail(code) { throw Object.assign(new Error(code), { code }); }
function own(value) { return value !== null && typeof value === "object"
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (own(value)) return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function byPath(left, right) { return left.path < right.path ? -1 : left.path > right.path ? 1 : 0; }
function safePath(value) {
  return typeof value === "string" && value.length > 0 && value.isWellFormed()
    && Buffer.byteLength(value) <= 1024 && !/[\\\u0000-\u001f\u007f]/u.test(value)
    && value.split("/").every((part) => part && part !== "." && part !== ".."
      && Buffer.byteLength(part) <= 255) && !/^[A-Za-z]:/u.test(value);
}
function readJson(bytes) {
  if (!bytes || bytes.length > 256 * 1024) fail("LEGACY_MANIFEST_INVALID");
  try { const value = JSON.parse(decoder.decode(bytes)); if (own(value)) return value; }
  catch { /* report only a stable code, never source values */ }
  fail("LEGACY_MANIFEST_INVALID");
}
function inventory(input, bundledCodex = false) {
  if (!Array.isArray(input) || input.length === 0
    || input.length > (bundledCodex ? 1_024 : 256)) fail("LEGACY_INVENTORY_INVALID");
  const files = new Map();
  const names = new Set();
  let total = 0;
  for (const item of input) {
    if (!own(item) || Object.keys(item).some((key) => !["path", "content", "executable"].includes(key))
      || !safePath(item.path) || item.path.split("/").length > (bundledCodex ? 14 : 9)
      || !(typeof item.content === "string" || Buffer.isBuffer(item.content))
      || (typeof item.content === "string" && !item.content.isWellFormed())
      || (item.executable !== undefined && typeof item.executable !== "boolean")) fail("LEGACY_INVENTORY_INVALID");
    const bytes = Buffer.from(item.content);
    total += bytes.length;
    if (bytes.length > 4 * 1024 * 1024 || total > (bundledCodex ? 32 : 16) * 1024 * 1024
      || names.has(item.path.normalize("NFC").toLowerCase())) fail("LEGACY_INVENTORY_INVALID");
    names.add(item.path.normalize("NFC").toLowerCase());
    files.set(item.path, { bytes, executable: item.executable === true });
  }
  for (const filePath of files.keys()) {
    const segments = filePath.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      if (names.has(segments.slice(0, length).join("/").normalize("NFC").toLowerCase())) {
        fail("LEGACY_INVENTORY_INVALID");
      }
    }
  }
  return files;
}
function validSkill(file, name) {
  try {
    const text = decoder.decode(file.bytes);
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
    if (!match || /\$\{(?:CLAUDE_|CODEX_|user_config\.)|\$CLAUDE_|\$CODEX_/u.test(text)) return false;
    const metadata = yaml.load(match[1], { schema: yaml.JSON_SCHEMA });
    return own(metadata) && Object.keys(metadata).every((key) => STANDARD_SKILL_FIELDS.has(key))
      && SKILL_NAME.test(name) && name.length <= 64 && metadata.name === name
      && typeof metadata.description === "string" && metadata.description.length > 0
      && metadata.description.length <= 1024
      && (metadata.compatibility === undefined || (typeof metadata.compatibility === "string"
        && metadata.compatibility.length > 0 && metadata.compatibility.length <= 500))
      && (metadata.metadata === undefined || (own(metadata.metadata)
        && Object.values(metadata.metadata).every((value) => typeof value === "string")));
  } catch { return false; }
}
function normalizedBundledSkill(file, directoryName, diagnostics) {
  try {
    const source = decoder.decode(file.bytes);
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
    if (!match || !SKILL_NAME.test(directoryName) || directoryName.length > 64) return null;
    const metadata = yaml.load(match[1], { schema: yaml.JSON_SCHEMA });
    if (!own(metadata) || typeof metadata.description !== "string"
      || metadata.description.trim().length === 0) return null;
    const description = metadata.description.slice(0, 1024).toWellFormed();
    const originalName = typeof metadata.name === "string" ? metadata.name : "";
    if (originalName !== directoryName || metadata.description.length > 1024
      || Object.keys(metadata).some(key => !STANDARD_SKILL_FIELDS.has(key))) {
      diagnostics.push({ scope: "skill", name: directoryName,
        reasonCode: "CODEX_SKILL_METADATA_NORMALIZED" });
    }
    const normalized = { name: directoryName, description };
    if (typeof metadata.license === "string") normalized.license = metadata.license;
    if (typeof metadata.compatibility === "string" && metadata.compatibility.length <= 500) {
      normalized.compatibility = metadata.compatibility;
    }
    if (own(metadata.metadata) && Object.values(metadata.metadata).every(value => typeof value === "string")) {
      normalized.metadata = metadata.metadata;
    }
    const frontmatter = Object.entries(normalized).map(([key, value]) =>
      `${key}: ${typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value)}`).join("\n");
    const originalDescription = metadata.description.length > 1024
      ? `\n\n## Original description\n\n${metadata.description}\n` : "";
    const content = `---\n${frontmatter}\n---\n${source.slice(match[0].length)}${originalDescription}`;
    return { content: Buffer.from(content, "utf8"), changed: content !== source };
  } catch { return null; }
}
function normalizedValue(value, format) {
  if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0")
    || Buffer.byteLength(value) > 8192) fail("LEGACY_MCP_ENTRY_INVALID");
  const withoutSupportedVariables = format === "claude-plugin"
    ? value.replaceAll("${CLAUDE_PLUGIN_ROOT}", "") : value;
  // Host project/data/secret variables have different authority or lifetime.
  // Do not expand them from the importing process's environment.
  if (withoutSupportedVariables.includes("$")) fail("LEGACY_VARIABLE_UNSUPPORTED");
  return format === "claude-plugin"
    ? value.replaceAll("${CLAUDE_PLUGIN_ROOT}", "${PLUGIN_ROOT}") : value;
}
function stringMap(value, format, type) {
  if (!own(value) || Object.keys(value).length > 64) fail("LEGACY_MCP_ENTRY_INVALID");
  const result = {};
  const names = new Set();
  for (const [key, raw] of Object.entries(value)) {
    if (!key || key.length > 128 || ["__proto__", "constructor", "prototype"].includes(key)) {
      fail("LEGACY_MCP_ENTRY_INVALID");
    }
    const lower = key.toLowerCase();
    if (names.has(lower)) fail("LEGACY_MCP_ENTRY_INVALID");
    names.add(lower);
    if (type === "headers" && ["authorization", "cookie", "proxy-authorization"].includes(lower)) {
      fail("LEGACY_CREDENTIAL_UNSUPPORTED");
    }
    if (type === "env" && (/[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/iu.test(key)
      || ["PLUGIN_ROOT", "PLUGIN_DATA", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA"].includes(key))) {
      fail("LEGACY_CREDENTIAL_UNSUPPORTED");
    }
    const item = normalizedValue(raw, format);
    if (type === "headers") {
      if (item.includes("${")) fail("LEGACY_VARIABLE_UNSUPPORTED");
      try { http.validateHeaderName(key); http.validateHeaderValue(key, item); }
      catch { fail("LEGACY_MCP_ENTRY_INVALID"); }
    } else if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) fail("LEGACY_MCP_ENTRY_INVALID");
    result[key] = item;
  }
  return result;
}
function mcpEntry(value, format, files, diagnostics, name) {
  if (!own(value)) fail("LEGACY_MCP_ENTRY_INVALID");
  const type = value.type === undefined && typeof value.command === "string" ? "stdio" : value.type;
  const presentation = format === "codex-plugin" ? ["note", "title", "description", "icons"] : [];
  const fields = type === "stdio" ? ["type", "command", "args", "env", "cwd"]
    : type === "http" ? ["type", "url", "headers", "_meta"] : null;
  if (!fields) fail("LEGACY_TRANSPORT_UNSUPPORTED");
  if (Object.keys(value).some((field) => !fields.includes(field) && !presentation.includes(field))) {
    fail("LEGACY_MCP_FIELD_UNSUPPORTED");
  }
  if (presentation.some(field => Object.hasOwn(value, field))) {
    if (["note", "title", "description"].some(field => Object.hasOwn(value, field)
      && (typeof value[field] !== "string" || Buffer.byteLength(value[field], "utf8") > 4096))
      || (Object.hasOwn(value, "icons") && (!Array.isArray(value.icons)
        || Buffer.byteLength(JSON.stringify(value.icons), "utf8") > 32 * 1024))) {
      fail("LEGACY_MCP_ENTRY_INVALID");
    }
    diagnostics.push({ scope: "mcp-server", name,
      reasonCode: "LEGACY_PRESENTATION_METADATA_OMITTED" });
  }
  let result;
  if (type === "stdio") {
    let command = normalizedValue(value.command, format);
    if (command.startsWith("${PLUGIN_ROOT}/")) command = `./${command.slice(15)}`;
    if (command.startsWith("./")) {
      if (!safePath(command.slice(2)) || !files.has(command.slice(2))) fail("LEGACY_MCP_ENTRY_INVALID");
    } else if (!/^[^./\\\s$][^/\\\s$]*$/u.test(command)) fail("LEGACY_MCP_ENTRY_INVALID");
    result = { type: "stdio", command };
    if (value.args !== undefined) {
      if (!Array.isArray(value.args) || value.args.length > 64) fail("LEGACY_MCP_ENTRY_INVALID");
      result.args = value.args.map((arg) => normalizedValue(arg, format));
    }
    if (value.env !== undefined) result.env = stringMap(value.env, format, "env");
    // Preserve only the source host's proven package-root environment alias.
    // Its data directory, project and user-config authorities are not imported.
    if (format === "claude-plugin") {
      result.env = { ...result.env, CLAUDE_PLUGIN_ROOT: "${PLUGIN_ROOT}" };
    }
    if (value.cwd !== undefined) {
      const originalCwd = normalizedValue(value.cwd, format);
      const cwd = format === "codex-plugin" && originalCwd === "."
        ? "${PLUGIN_ROOT}" : originalCwd;
      const relative = cwd === "${PLUGIN_ROOT}" ? "" : cwd.startsWith("${PLUGIN_ROOT}/")
        ? cwd.slice(15) : cwd.startsWith("./") ? cwd.slice(2) : null;
      if (relative === null || (relative && !safePath(relative))) fail("LEGACY_MCP_ENTRY_INVALID");
      result.cwd = cwd;
    }
  } else {
    const rawUrl = normalizedValue(value.url, format);
    let url;
    try { url = new URL(rawUrl); } catch { fail("LEGACY_MCP_ENTRY_INVALID"); }
    const hostname = url.hostname.replace(/^\[|\]$/gu, "");
    const loopback = hostname === "localhost" || hostname === "::1"
      || (net.isIP(hostname) === 4 && hostname.startsWith("127."));
    if (!["http:", "https:"].includes(url.protocol) || (url.protocol === "http:" && !loopback)
      || url.username || url.password || url.hash || rawUrl.includes("${")) fail("LEGACY_MCP_ENTRY_INVALID");
    result = { type: "streamable-http", url: rawUrl };
    if (value.headers !== undefined) result.headers = stringMap(value.headers, format, "headers");
    if (Object.hasOwn(value, "_meta")) diagnostics.push({ scope: "mcp-server", name,
      reasonCode: "LEGACY_PRESENTATION_METADATA_OMITTED" });
  }
  if (!validateMcp({ $schema: mcpSchema.$id, mcpServers: { [name]: result } })) fail("LEGACY_MCP_ENTRY_INVALID");
  return result;
}

function convertLegacyPluginContents(input) {
  if (!own(input) || Object.keys(input).some((key) => !["format", "files", "components", "bundledCodex"].includes(key))
    || !Object.hasOwn(FORMATS, input.format) || !Array.isArray(input.components)
    || input.components.length === 0 || input.components.length > 2
    || new Set(input.components).size !== input.components.length
    || input.components.some((kind) => !["skills", "mcp-servers"].includes(kind))
    || (input.bundledCodex !== undefined && typeof input.bundledCodex !== "boolean")
    || (input.bundledCodex === true && input.format !== "codex-plugin")) fail("LEGACY_SELECTION_INVALID");
  const bundledCodex = input.bundledCodex === true;
  const files = inventory(input.files, bundledCodex);
  const manifestPath = FORMATS[input.format];
  if (files.has("plugin.json") || files.has("mcp.json") || !files.has(manifestPath)) fail("LEGACY_FORMAT_AMBIGUOUS");
  const source = readJson(files.get(manifestPath).bytes);
  const diagnostics = [];
  const manifest = { $schema: manifestSchema.$id };
  for (const field of METADATA) if (Object.hasOwn(source, field)) manifest[field] = source[field];
  if (!validateManifest(manifest)) fail("LEGACY_MANIFEST_UNREPRESENTABLE");
  for (const key of Object.keys(source)) {
    if (!METADATA.includes(key) && !["skills", "mcpServers"].includes(key)) {
      diagnostics.push({ scope: "manifest", name: key, reasonCode: "LEGACY_FIELD_NOT_IMPORTED" });
    }
  }
  for (const [name, prefixes] of Object.entries({ hooks: ["hooks/"], commands: ["commands/"],
    agents: ["agents/"], apps: [".app.json"], lspServers: [".lsp.json"],
    outputStyles: ["output-styles/"], workflows: ["workflows/"], monitors: ["monitors/"] })) {
    if ([...files.keys()].some((filePath) => prefixes.some((prefix) =>
      prefix.endsWith("/") ? filePath.startsWith(prefix) : filePath === prefix))) {
      diagnostics.push({ scope: "component", name, reasonCode: "LEGACY_COMPONENT_NOT_IMPORTED" });
    }
  }
  const selected = new Set(input.components);
  const skills = [];
  const normalizedSkillFiles = [];
  const defaultSkills = source.skills === undefined || source.skills === "./skills" || source.skills === "./skills/"
    || (input.format === "claude-plugin" && Array.isArray(source.skills)
      && source.skills.every((entry) => entry === "./skills" || entry === "./skills/"));
  if (selected.has("skills")) {
    if (!defaultSkills) diagnostics.push({ scope: "skills", reasonCode: "LEGACY_CUSTOM_PATH_UNSUPPORTED" });
    for (const [filePath, file] of files) {
      const match = /^skills\/([^/]+)\/SKILL\.md$/u.exec(filePath);
      if (!match) continue;
      if (bundledCodex) {
        const normalized = normalizedBundledSkill(file, match[1], diagnostics);
        if (normalized) {
          skills.push({ name: match[1], path: filePath });
          if (normalized.changed) normalizedSkillFiles.push({ path: filePath,
            content: normalized.content, executable: false });
        } else diagnostics.push({ scope: "skill", name: match[1],
          reasonCode: "CODEX_SKILL_UNREPRESENTABLE" });
      }
      else if (validSkill(file, match[1])) skills.push({ name: match[1], path: filePath });
      else diagnostics.push({ scope: "skill", name: match[1], reasonCode: "LEGACY_SKILL_UNREPRESENTABLE" });
    }
  }
  const mcpServers = {};
  if (selected.has("mcp-servers")) {
    const sources = [];
    if (files.has(".mcp.json")) {
      try {
        const config = readJson(files.get(".mcp.json").bytes);
        if (Object.keys(config).some((key) => key !== "mcpServers") || !own(config.mcpServers)) fail("LEGACY_MCP_ENTRY_INVALID");
        sources.push(config.mcpServers);
      } catch { diagnostics.push({ scope: "mcp", reasonCode: "LEGACY_MCP_CONFIG_INVALID" }); }
    }
    if (own(source.mcpServers)) sources.push(source.mcpServers);
    else if (source.mcpServers !== undefined && source.mcpServers !== "./.mcp.json") {
      diagnostics.push({ scope: "mcp", reasonCode: "LEGACY_CUSTOM_PATH_UNSUPPORTED" });
    } else if (source.mcpServers === "./.mcp.json" && !files.has(".mcp.json")) {
      diagnostics.push({ scope: "mcp", reasonCode: "LEGACY_MCP_CONFIG_MISSING" });
    }
    const merged = new Map();
    for (const config of sources) {
      if (Object.keys(config).length > 256) fail("LEGACY_MCP_CONFIG_INVALID");
      for (const [name, value] of Object.entries(config)) merged.set(name, value);
    }
    if (merged.size > 256) fail("LEGACY_MCP_CONFIG_INVALID");
    for (const [name, value] of merged) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)
        || ["constructor", "prototype"].includes(name)) {
        diagnostics.push({ scope: "mcp-server", reasonCode: "LEGACY_MCP_NAME_UNREPRESENTABLE" });
        continue;
      }
      try { mcpServers[name] = mcpEntry(value, input.format, files, diagnostics, name); }
      catch (error) { diagnostics.push({ scope: "mcp-server", name, reasonCode: error.code || "LEGACY_MCP_ENTRY_INVALID" }); }
    }
  }
  skills.sort(byPath);
  // Source control manifests may contain credentials or host-specific hooks.
  // Keep their hashes as provenance, not their bodies in the imported package.
  const normalizedPaths = new Set(normalizedSkillFiles.map(file => file.path));
  const retainedPaths = [...files.keys()].filter((filePath) => !LEGACY_CONTROL_FILES.has(filePath)
    && !normalizedPaths.has(filePath)
    && (!filePath.startsWith("skills/")
      || skills.some((skill) => filePath.startsWith(`skills/${skill.name}/`)))).sort();
  for (const [name, spec] of Object.entries(mcpServers)) {
    if (spec.type === "stdio" && spec.command.startsWith("./")
      && !retainedPaths.includes(spec.command.slice(2))) {
      delete mcpServers[name];
      diagnostics.push({ scope: "mcp-server", name, reasonCode: "LEGACY_MCP_DEPENDENCY_NOT_IMPORTED" });
    }
  }
  const generatedFiles = [{ path: "plugin.json", content: `${JSON.stringify(manifest, null, 2)}\n`, executable: false },
    ...normalizedSkillFiles];
  if (Object.keys(mcpServers).length) generatedFiles.push({ path: "mcp.json",
    content: `${JSON.stringify({ $schema: mcpSchema.$id, mcpServers }, null, 2)}\n`, executable: false });
  const inputDigest = digest(canonical([...files].map(([filePath, file]) => ({ path: filePath,
    sha256: digest(file.bytes), executable: file.executable })).sort(byPath)));
  const adapterVersion = bundledCodex ? "bundled-codex-v1" : ADAPTER_VERSION;
  const provenance = { adapterVersion,
    format: input.format, manifestPath,
    manifestDigest: digest(files.get(manifestPath).bytes), inputDigest,
    conversionDigest: digest(canonical({ adapterVersion, inputDigest,
      components: [...selected].sort(), retainedPaths, generatedFiles })) };
  return { provenance, name: manifest.name, generatedFiles, retainedPaths, skills,
    mcpServers: Object.keys(mcpServers).sort().map((name) => ({ name, type: mcpServers[name].type })),
    diagnostics, installable: skills.length > 0 || Object.keys(mcpServers).length > 0 };
}

module.exports = { ADAPTER_VERSION, convertLegacyPluginContents };
