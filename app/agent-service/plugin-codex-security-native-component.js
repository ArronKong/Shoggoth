"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { BundledPluginCatalog } = require("../core/bundled-plugin-catalog");
const { identifyLegacySource, scanLegacySource, materializeLegacySource,
  assertLegacySourceCurrent } = require("./plugin-legacy-source");
const { CODEX_SECURITY_NATIVE_ENV_INVENTORY, CODEX_SECURITY_NATIVE_ENV_NAMES,
  CODEX_SECURITY_NATIVE_SPEC_FIELDS } = require("./codex-security-native-host-plan");
const { assertPrivateDirectory, serviceError } = require("./security");

const PACKAGE_ID = "codex-security";
const SOURCE_IDENTITY = "bundled:codex-security";
const COMPONENT_NAME = "codex-security";
const VERSION = "0.1.24";
const TRANSPORT = "shoggoth-codex-security-native";
const ORIGINAL_ROOT = "codex-original";
const PROVENANCE_FILE = "codex-security-native-provenance.json";
const SOURCE_DIGEST = "8d32d2544f37f8cc8f43df98216b2a505e6f71d9628c555086039daf1062e9fb";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const SOURCE_FILES = Object.freeze({
  ".mcp.json": "c714ccf9fd0d3b2de55c5e8f587ba622bf55b0a98e2937b01ddb2c5b499d3a6c",
  ".codex-plugin/plugin.json": "9467e3d36f30f3f521d4fe169ff524611262ee14f375dfae7ce6ae346dbcb4b7",
  "scripts/launch_codex_security_mcp": "d2b5ee51eceaa5c1b619ea263157a5de7319443c32921a8bcdfb8b1955acf8b9",
  "mcp/server.mjs": "c58624aa4c4bd3efbb67601c9c2e98759f167f608320a6cd342814b2f2e6a636",
});
const fail = code => { throw serviceError(`CODEX_SECURITY_COMPONENT_${code}`,
  "Codex Security 原组件材料无效、变化或缺少正式宿主准入"); };
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const freeze = value => { if (value && typeof value === "object") {
  Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function exact(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
      const field = Object.getOwnPropertyDescriptor(value, key);
      return field?.enumerable && Object.hasOwn(field, "value");
    });
}
function safeArray(value, expected) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Reflect.ownKeys(value).length !== expected.length + 1 || value.length !== expected.length) return false;
  return expected.every((item, index) => {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    return field?.enumerable && Object.hasOwn(field, "value") && field.value === item;
  });
}
function originalSpecValid(value) {
  return exact(value, CODEX_SECURITY_NATIVE_SPEC_FIELDS)
    && value.command === "./scripts/launch_codex_security_mcp"
    && safeArray(value.args, ["--stdio"]) && value.cwd === "."
    && safeArray(value.env_vars, CODEX_SECURITY_NATIVE_ENV_NAMES)
    && value.startup_timeout_sec === 120 && value.tool_timeout_sec === 349200;
}
function isCodexSecurityNativeRecord(record) {
  return exact(record, ["type", "sourceDigest", "originalRoot", "originalSpec"])
    && record.type === TRANSPORT && record.sourceDigest === SOURCE_DIGEST
    && record.originalRoot === ORIGINAL_ROOT && originalSpecValid(record.originalSpec);
}
function metadata(files) {
  return files.map(file => ({ path: file.path, bytes: file.content.length,
    sha256: hash(file.content), executable: file.executable }));
}
function originalManifest(files) {
  const map = new Map(files.map(file => [file.path, file]));
  for (const [name, expected] of Object.entries(SOURCE_FILES)) {
    if (!map.has(name) || hash(map.get(name).content) !== expected) fail("SOURCE_CHANGED");
  }
  let manifest;
  try { manifest = JSON.parse(map.get(".mcp.json").content.toString("utf8")); }
  catch { fail("CONFIG_INVALID"); }
  if (!exact(manifest, ["mcpServers"]) || !exact(manifest.mcpServers, [COMPONENT_NAME])
    || !originalSpecValid(manifest.mcpServers[COMPONENT_NAME])) fail("CONFIG_INVALID");
  if (hash(JSON.stringify(metadata(files))) !== SOURCE_DIGEST) fail("SOURCE_CHANGED");
  return manifest.mcpServers[COMPONENT_NAME];
}
function recordFor(spec) {
  return { type: TRANSPORT, sourceDigest: SOURCE_DIGEST, originalRoot: ORIGINAL_ROOT,
    originalSpec: structuredClone(spec) };
}
function provenanceFor(record, fileCount) {
  return { version: 1, kind: "original-plugin-native-transport-candidate",
    sourceIdentity: SOURCE_IDENTITY, sourceVersion: VERSION, sourceDigest: SOURCE_DIGEST,
    originalRoot: ORIGINAL_ROOT, descriptorDigest: hash(canonical(record)),
    originalFileCount: fileCount, intendedToolCount: 45, appToolCount: 25, modelToolCount: 20,
    rightsReview: "pending", fullPluginUsable: false };
}
function writeFile(target, content, executable = false) {
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(fd, content); fs.fchmodSync(fd, executable ? 0o700 : 0o600); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function syncDirectory(directory) {
  assertPrivateDirectory(directory);
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function statIdentity(stat) {
  return Object.fromEntries(["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"].map(key => [key, stat[key]]));
}
function capturePrivateTree(root) {
  const files = [], nodes = new Map(); let total = 0, entries = 0;
  const same = (left, right) => canonical(left) === canonical(right);
  const walk = (directory, prefix = "", depth = 0) => {
    if (depth > 13 || ++entries > 1024) fail("PATH_INVALID");
    assertPrivateDirectory(directory);
    const before = statIdentity(fs.lstatSync(directory)); nodes.set(directory, before);
    for (const name of fs.readdirSync(directory).sort()) {
      if (!name || [".", ".."].includes(name) || !name.isWellFormed()
        || /[\\\u0000-\u001f\u007f]/u.test(name) || Buffer.byteLength(name) > 255 || ++entries > 1024) fail("PATH_INVALID");
      const relative = prefix ? `${prefix}/${name}` : name, target = path.join(directory, name), stat = fs.lstatSync(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) { walk(target, relative, depth + 1); continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()
        || (stat.mode & 0o077) !== 0 || stat.size > 4 * 1024 * 1024
        || (total += stat.size) > 32 * 1024 * 1024 || files.length >= 1024) fail("PATH_INVALID");
      const identity = statIdentity(stat), fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let content;
      try {
        if (!same(identity, statIdentity(fs.fstatSync(fd)))) fail("SOURCE_CHANGED");
        content = fs.readFileSync(fd);
        if (content.length !== stat.size || !same(identity, statIdentity(fs.fstatSync(fd)))
          || !same(identity, statIdentity(fs.lstatSync(target)))) fail("SOURCE_CHANGED");
      } finally { fs.closeSync(fd); }
      nodes.set(target, identity); files.push({ path: relative, content, executable: (stat.mode & 0o111) !== 0 });
    }
    if (!same(before, statIdentity(fs.lstatSync(directory)))) fail("SOURCE_CHANGED");
  };
  walk(root);
  return { files, assertCurrent() {
    for (const [target, identity] of nodes) {
      if (!same(identity, statIdentity(fs.lstatSync(target)))) fail("SOURCE_CHANGED");
    }
  } };
}

// A full original-plugin artifact for a dedicated internal transport. It is
// deliberately not accepted by the public generic stdio schema, does not make
// a Connection/Binding/Grant, and never starts a process or reads credentials.
function materializeCodexSecurityNativeComponent(destination, { bundledCatalog } = {}) {
  if (!(bundledCatalog instanceof BundledPluginCatalog) || typeof destination !== "string"
    || !path.isAbsolute(destination) || path.normalize(destination) !== destination) fail("INVALID");
  assertPrivateDirectory(path.dirname(destination));
  if (fs.existsSync(destination)) fail("DESTINATION_EXISTS");
  const entry = bundledCatalog.assertCurrent(PACKAGE_ID);
  if (entry.version !== VERSION || entry.sourceDigest !== SOURCE_DIGEST) fail("SOURCE_CHANGED");
  const source = identifyLegacySource({ sourcePath: bundledCatalog.packagePath(PACKAGE_ID),
    format: "codex-plugin", components: ["skills", "mcp-servers"], trustedBundled: true });
  const snapshot = scanLegacySource(source), spec = originalManifest(snapshot.files);
  if (snapshot.conversion.skills.length !== 15 || snapshot.conversion.mcpServers.length !== 0
    || !snapshot.conversion.installable) fail("CONVERSION_CHANGED");
  const materialized = materializeLegacySource(snapshot, destination);
  const root = materialized.root, originalRoot = path.join(root, ORIGINAL_ROOT);
  fs.mkdirSync(originalRoot, { mode: 0o700 });
  const directories = new Set([root, originalRoot]);
  for (const file of snapshot.files) {
    const target = path.join(originalRoot, file.path), parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    let cursor = parent;
    while (cursor !== originalRoot) { directories.add(cursor); cursor = path.dirname(cursor); }
    writeFile(target, file.content, file.executable);
  }
  const record = recordFor(spec), provenance = provenanceFor(record, snapshot.files.length);
  writeFile(path.join(root, "mcp.json"), `${JSON.stringify({ $schema: MCP_SCHEMA,
    mcpServers: { [COMPONENT_NAME]: record } }, null, 2)}\n`);
  writeFile(path.join(root, PROVENANCE_FILE), `${JSON.stringify(provenance, null, 2)}\n`);
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) syncDirectory(directory);
  assertLegacySourceCurrent(snapshot); bundledCatalog.assertCurrent(PACKAGE_ID);
  const component = readCodexSecurityNativeComponent(root);
  return freeze({ root, sourceIdentity: SOURCE_IDENTITY, sourceDigest: SOURCE_DIGEST,
    originalFileCount: snapshot.files.length, component, registered: false, fullPluginUsable: false });
}

function readCodexSecurityNativeComponent(root) {
  if (typeof root !== "string" || !path.isAbsolute(root) || fs.realpathSync(root) !== root) fail("PATH_INVALID");
  assertPrivateDirectory(root);
  const whole = capturePrivateTree(root);
  const map = new Map(whole.files.map(file => [file.path, file]));
  let manifest, provenance;
  try { manifest = JSON.parse(map.get("mcp.json")?.content.toString("utf8"));
    provenance = JSON.parse(map.get(PROVENANCE_FILE)?.content.toString("utf8")); }
  catch { fail("CONFIG_INVALID"); }
  if (!exact(manifest, ["$schema", "mcpServers"]) || manifest.$schema !== MCP_SCHEMA
    || !exact(manifest.mcpServers, [COMPONENT_NAME])
    || !isCodexSecurityNativeRecord(manifest.mcpServers[COMPONENT_NAME])) fail("CONFIG_INVALID");
  const originalRoot = path.join(root, ORIGINAL_ROOT); assertPrivateDirectory(originalRoot);
  const original = capturePrivateTree(originalRoot);
  const spec = originalManifest(original.files), record = recordFor(spec);
  if (canonical(manifest.mcpServers[COMPONENT_NAME]) !== canonical(record)
    || canonical(provenance) !== canonical(provenanceFor(record, original.files.length))) fail("CONFIG_INVALID");
  // Both file trees are captured again after all parsing. A substitute path or
  // same-byte inode swap during inspection cannot become a signed descriptor.
  original.assertCurrent(); whole.assertCurrent();
  return freeze({ name: COMPONENT_NAME, type: TRANSPORT, descriptorDigest: hash(canonical(record)),
    spec: record, oauthResource: null, sourceClosure: { sourceIdentity: SOURCE_IDENTITY,
      sourceVersion: VERSION, sourceDigest: SOURCE_DIGEST, sourceFiles: { ...SOURCE_FILES },
      originalFileCount: original.files.length, intendedToolCount: 45,
      environmentSelectorCount: CODEX_SECURITY_NATIVE_ENV_NAMES.length,
      originalFieldCount: CODEX_SECURITY_NATIVE_SPEC_FIELDS.length,
      startupTimeoutSec: 120, toolTimeoutSec: 349200 }, fullPluginUsable: false });
}
function nativeEndpointIdentity(descriptorDigest) {
  if (typeof descriptorDigest !== "string" || !/^[a-f0-9]{64}$/u.test(descriptorDigest)) fail("INVALID");
  return `${TRANSPORT}:${descriptorDigest}`;
}
function nativePrincipalIdentity(runtimeAccountId) {
  if (typeof runtimeAccountId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(runtimeAccountId)) fail("INVALID");
  return `${TRANSPORT}:${hash(JSON.stringify(["codex-security-native-account", runtimeAccountId]))}`;
}
const NATIVE_ENVIRONMENT_SELECTORS = freeze(CODEX_SECURITY_NATIVE_ENV_INVENTORY.map(({ name, kind }) => ({
  name, kind, source: "original-.mcp.json-env_vars", consumer: "service-owned-native-host-factory",
  acceptsRendererValue: false, ambientInheritance: false,
})));
module.exports = { PACKAGE_ID, SOURCE_IDENTITY, COMPONENT_NAME, VERSION, TRANSPORT, ORIGINAL_ROOT,
  SOURCE_DIGEST, SOURCE_FILES, PROVENANCE_FILE, NATIVE_ENVIRONMENT_SELECTORS,
  isCodexSecurityNativeRecord, materializeCodexSecurityNativeComponent,
  readCodexSecurityNativeComponent, nativeEndpointIdentity, nativePrincipalIdentity };
