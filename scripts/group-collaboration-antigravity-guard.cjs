"use strict";

// Task-owned official AGY PreToolUse guard. This module does not start an SDK,
// read an account credential, invoke a tool, or authorize a real model request.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const MAX_INPUT = 64 * 1024;
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const failure = code => Object.assign(new Error(code), { code });
const plain = value => value && typeof value === "object" && !Array.isArray(value)
  && [null, Object.prototype].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length
  && Object.keys(value).every(key => keys.includes(key));
const text = (value, max = 4096) => typeof value === "string" && value.length > 0 && value.isWellFormed()
  && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= max;
const within = (file, root) => file === root || file.startsWith(root + path.sep);
// Exact public path construction in the pinned ACP 1.2.1 server.py:1292-1305,
// paths.py:152-182 and session_store.py:32,52-55. These declared hook metadata
// paths do not add file-read authority; fileTarget uses only frozen readRoots.
function officialWorkspacePaths(geminiHome, workspace) {
  return [workspace, path.join(geminiHome, "config/skills"), path.join(workspace, ".gemini/skills"),
    path.join(geminiHome, "antigravity-cli/skills"), path.join(workspace, ".agents/skills")];
}
function officialAppDataDir(geminiHome) { return path.join(geminiHome, "antigravity-acp"); }
function officialArtifactDirectory(geminiHome) { return path.join(geminiHome, "artifacts"); }
function officialTranscript(geminiHome, sessionId) { return path.join(geminiHome, "antigravity-acp/conversations", sessionId + ".db"); }

// JSON.parse silently accepts duplicate keys. Reject them before they can alter
// a policy decision, including duplicates expressed with Unicode escapes.
function parseStrictJson(raw, { maxBytes = MAX_INPUT } = {}) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > maxBytes) throw failure("AGY_GUARD_INPUT_TOO_LARGE");
  let at = 0, nodes = 0;
  const space = () => { while (/[ \t\r\n]/u.test(raw[at] || "x")) at += 1; };
  const string = () => {
    const start = at++;
    while (at < raw.length) {
      if (raw[at] === "\\") { at += 2; continue; }
      if (raw[at++] === '"') {
        const value = JSON.parse(raw.slice(start, at));
        if (!value.isWellFormed() || value.includes("\0")) throw failure("AGY_GUARD_INVALID_STRING");
        return value;
      }
    }
    throw failure("AGY_GUARD_INVALID_JSON");
  };
  const value = depth => {
    if (depth > 16 || ++nodes > 4096) throw failure("AGY_GUARD_INPUT_COMPLEXITY");
    space(); const token = raw[at];
    if (token === '"') return string();
    if (token === "{" || token === "[") {
      at += 1; space(); const object = token === "{", result = object ? {} : [], seen = new Set(), end = object ? "}" : "]";
      if (raw[at] === end) { at += 1; return result; }
      for (;;) {
        let key;
        if (object) {
          if (raw[at] !== '"') throw failure("AGY_GUARD_INVALID_JSON");
          key = string();
          if (seen.has(key)) throw failure("AGY_GUARD_DUPLICATE_JSON_KEY");
          if (["__proto__", "prototype", "constructor"].includes(key)) throw failure("AGY_GUARD_UNSAFE_JSON_KEY");
          seen.add(key); space(); if (raw[at++] !== ":") throw failure("AGY_GUARD_INVALID_JSON");
        }
        const item = value(depth + 1);
        if (object) Object.defineProperty(result, key, { value: item, enumerable: true, writable: true, configurable: true }); else result.push(item);
        space(); if (raw[at] === end) { at += 1; return result; }
        if (raw[at++] !== ",") throw failure("AGY_GUARD_INVALID_JSON"); space();
      }
    }
    const matched = raw.slice(at).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u);
    if (!matched) throw failure("AGY_GUARD_INVALID_JSON");
    at += matched[0].length; const parsed = JSON.parse(matched[0]);
    if (typeof parsed === "number" && !Number.isFinite(parsed)) throw failure("AGY_GUARD_NONFINITE_NUMBER");
    return parsed;
  };
  const result = value(0); space(); if (at !== raw.length) throw failure("AGY_GUARD_INVALID_JSON"); return result;
}

function statIdentity(stat) {
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, size: stat.size, mode: stat.mode & 0o777,
    nlink: stat.nlink, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}
function noLinks(file, root) {
  if (!path.isAbsolute(file) || path.normalize(file) !== file || !within(file, root)) throw failure("AGY_GUARD_PATH_OUTSIDE_ROOT");
  const base = fs.lstatSync(root);
  if (!base.isDirectory() || base.isSymbolicLink() || base.uid !== process.getuid() || (base.mode & 0o022) || fs.realpathSync(root) !== root) throw failure("AGY_GUARD_ROOT_UNSAFE");
  let current = root;
  for (const part of path.relative(root, file).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.isDirectory() && (stat.mode & 0o022))) throw failure("AGY_GUARD_PATH_LINK_OR_OWNER");
  }
}
function readStable(file, { root, mode, maxBytes = 256 * 1024, expectedSha256, identity } = {}) {
  noLinks(file, root); const before = fs.lstatSync(file);
  if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes || (mode !== undefined && (before.mode & 0o777) !== mode)) throw failure("AGY_GUARD_FILE_UNSAFE");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    if (JSON.stringify(statIdentity(before)) !== JSON.stringify(statIdentity(opened))
      || JSON.stringify(statIdentity(opened)) !== JSON.stringify(statIdentity(after))
      || (identity && JSON.stringify(statIdentity(opened)) !== JSON.stringify(identity))
      || (expectedSha256 && sha(bytes) !== expectedSha256)) throw failure("AGY_GUARD_FILE_CHANGED");
    return { bytes, identity: statIdentity(opened), sha256: sha(bytes) };
  } finally { fs.closeSync(fd); }
}
function sameRoot(file, expected) {
  noLinks(file, file); const stat = fs.lstatSync(file);
  if (stat.dev !== expected.dev || stat.ino !== expected.ino || stat.uid !== expected.uid || !stat.isDirectory()) throw failure("AGY_GUARD_ROOT_CHANGED");
}
function policyCommand(manifest, manifestPath, digest) {
  const quote = value => "'" + value.replace(/'/gu, "'\"'\"'") + "'";
  return ["/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "HOME=" + manifest.guardHome, "TMPDIR=" + manifest.guardTmp,
    manifest.nodePath, manifest.guardPath, "--manifest", manifestPath, "--digest", digest, "--nonce", manifest.nonce].map(quote).join(" ");
}
function hookConfig(manifest, manifestPath, digest) {
  return { "frozen-role-parameter-policy": { enabled: true, PreToolUse: [{ matcher: "^.*$", hooks: [{
    type: "command", command: policyCommand(manifest, manifestPath, digest), timeout: 3 }] }] } };
}
function startupFiles(home) {
  return [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".bashrc", ".bash_profile", ".bash_login", ".profile",
    ".config/fish/config.fish"].map(relative => path.join(home, relative));
}
function validateParentEnvironment(env, manifest) {
  const allowed = ["PATH", "HOME", "GEMINI_HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "BROWSER", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "AGY_ACP_CCPA_BASE_URL"];
  if (!plain(env) || Object.keys(env).some(key => !allowed.includes(key) || !text(env[key]))) throw failure("AGY_GUARD_PARENT_ENV_UNSAFE");
  if (env.HOME !== manifest.sdkHome || env.GEMINI_HOME !== manifest.geminiHome || env.TMPDIR !== manifest.sdkTmp) throw failure("AGY_GUARD_PARENT_HOME_UNBOUND");
  for (const [key, item] of Object.entries(env)) if (/proxy|URL$/iu.test(key) && key.toLowerCase() !== "no_proxy") {
    let url; try { url = new URL(item); } catch { throw failure("AGY_GUARD_PARENT_ENV_UNSAFE"); }
    if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw failure("AGY_GUARD_PARENT_ENV_UNSAFE");
  }
}
function pathExists(file) {
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function verifyFrozenFiles(manifest, file, digest) {
  for (const fact of manifest.rootIdentities) { noLinks(fact.path, manifest.root); sameRoot(fact.path, fact.identity); }
  for (const fact of manifest.protectedFiles) readStable(fact.path, { root: manifest.root, mode: 0o400, expectedSha256: fact.sha256, identity: fact.identity });
  const expectedConfig = Buffer.from(JSON.stringify(hookConfig(manifest, file, digest), null, 2) + "\n");
  const config = readStable(manifest.hooksConfigPath, { root: manifest.root, mode: 0o400 });
  if (!config.bytes.equals(expectedConfig)) throw failure("AGY_GUARD_HOOK_CONFIG_CHANGED");
  validateParentEnvironment(manifest.parentEnvironment, manifest);
  if (startupFiles(manifest.sdkHome).some(pathExists)) throw failure("AGY_GUARD_STARTUP_FILE_PRESENT");
  for (const role of manifest.roles || []) if ([".agents", ".agent", "_agents", "_agent"].some(dot => pathExists(path.join(role.workspace, dot, "hooks.json")))) throw failure("AGY_GUARD_WORKSPACE_HOOK_PRESENT");
}
function admissionMac(manifest, payload) {
  return crypto.createHmac("sha256", Buffer.from(manifest.admissionKey, "hex")).update(JSON.stringify(payload)).digest("hex");
}
function validateRouter(manifest) {
  if (!exact(manifest.binding, ["runtimeAccountId"]) || !text(manifest.binding.runtimeAccountId, 512)
    || !/^[a-f0-9]{64}$/u.test(manifest.admissionKey || "") || !Array.isArray(manifest.roles) || !manifest.roles.length || manifest.roles.length > 8) throw failure("AGY_GUARD_ROUTER_INVALID");
  const roles = new Set(), workspaces = new Set(), paths = new Set();
  const privateRoots = [path.dirname(manifest.guardPath), manifest.sdkHome, manifest.geminiHome, manifest.appDataDir];
  const overlapsPrivate = candidate => privateRoots.some(root => within(candidate, root) || within(root, candidate));
  for (const role of manifest.roles) {
    if (!plain(role) || !text(role.roleId, 128) || !text(role.caseId, 128) || roles.has(role.roleId) || workspaces.has(role.workspace)
      || !exact(role.binding, ["runtimeProfileId", "runtimeAccountId", "runId", "requestId", "source"])
      || Object.values(role.binding).some(value => !text(value, 512)) || role.binding.runtimeAccountId !== manifest.binding.runtimeAccountId
      || !Array.isArray(role.readRoots) || !role.readRoots.length || !plain(role.builtinSchemas) || !Array.isArray(role.groupTools)
      || !Array.isArray(role.groupSources) || !Array.isArray(role.groupTokenDigests) || !within(role.workspace, manifest.root)
      || !within(role.admissionPath, manifest.admissionsDirectory) || paths.has(role.admissionPath)) throw failure("AGY_GUARD_ROUTER_INVALID");
    if (manifest.appDataDir !== officialAppDataDir(manifest.geminiHome)
      || JSON.stringify(role.workspacePaths) !== JSON.stringify(officialWorkspacePaths(manifest.geminiHome, role.workspace))) throw failure("AGY_GUARD_OFFICIAL_METADATA_UNBOUND");
    if (role.workspace === manifest.root || overlapsPrivate(role.workspace)
      || role.readRoots.some(root => !within(root, manifest.root) || overlapsPrivate(root))) throw failure("AGY_GUARD_ROUTER_SCOPE_UNSAFE");
    roles.add(role.roleId); workspaces.add(role.workspace); paths.add(role.admissionPath);
  }
  for (const left of manifest.roles) for (const right of manifest.roles) if (left !== right
    && (within(left.workspace, right.workspace) || left.readRoots.some(root => within(root, right.workspace) || within(right.workspace, root)))) throw failure("AGY_GUARD_ROUTER_SCOPE_OVERLAP");
}
function routeSession(loaded, input, cwd) {
  const router = loaded.manifest;
  if (router.version !== 2) return loaded;
  const role = router.roles.find(item => item.workspace === cwd);
  if (!role) throw failure("AGY_GUARD_ACTUAL_CWD_UNBOUND");
  // Hook input may select an existing host-published session; it never creates
  // an admission. All roles begin with no admission and therefore deny.
  if (!pathExists(role.admissionPath)) throw failure("AGY_GUARD_SESSION_NOT_ADMITTED");
  const loadedAdmission = readStable(role.admissionPath, { root: router.root, mode: 0o400 });
  const record = parseStrictJson(loadedAdmission.bytes.toString("utf8"), { maxBytes: 256 * 1024 });
  if (!exact(record, ["payload", "mac"]) || !plain(record.payload) || !/^[a-f0-9]{64}$/u.test(record.mac || "")
    || !crypto.timingSafeEqual(Buffer.from(record.mac, "hex"), Buffer.from(admissionMac(router, record.payload), "hex"))) throw failure("AGY_GUARD_ADMISSION_CHANGED");
  const admission = record.payload;
  if (!exact(admission, ["version", "routerDigest", "roleId", "roleDigest", "binding", "sessionSource", "sessionCwd", "transcriptPath", "artifactDirectoryPath", "cachedSchemas", "authority", "fileIdentity"])
    || admission.version !== 1 || admission.routerDigest !== loaded.digest || admission.roleId !== role.roleId || admission.roleDigest !== sha(JSON.stringify(role))
    || !exact(admission.binding, ["sessionId", "runtimeProfileId", "runtimeAccountId", "runId", "requestId"])
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(admission.binding.sessionId || "")
    || ["runtimeProfileId", "runtimeAccountId", "runId", "requestId"].some(key => admission.binding[key] !== role.binding[key])
    || admission.sessionSource !== role.binding.source || admission.sessionCwd !== role.workspace || !Array.isArray(admission.cachedSchemas)
    || admission.authority !== "original-SourceHost.sessionStart-return-and-ledger"
    || !exact(admission.fileIdentity, ["dev", "ino", "uid"])
    || ["dev", "ino", "uid"].some(key => admission.fileIdentity[key] !== loadedAdmission.identity[key])) throw failure("AGY_GUARD_ADMISSION_UNBOUND");
  const transcript = officialTranscript(router.geminiHome, admission.binding.sessionId);
  const artifactDirectory = officialArtifactDirectory(router.geminiHome);
  if (admission.transcriptPath !== transcript || admission.artifactDirectoryPath !== artifactDirectory) throw failure("AGY_GUARD_ADMISSION_UNBOUND");
  if (input?.conversationId !== admission.binding.sessionId) throw failure("AGY_GUARD_SESSION_OR_WORKSPACE_UNBOUND");
  return { ...loaded, router, admissionPath: role.admissionPath, manifest: { ...router, ...role, binding: admission.binding,
    workspacePaths: role.workspacePaths, transcriptPath: admission.transcriptPath, artifactDirectoryPath: admission.artifactDirectoryPath,
    cachedSchemas: admission.cachedSchemas } };
}
function loadManifest(file, digest, nonce) {
  if (!/^[a-f0-9]{64}$/u.test(digest || "") || !/^[a-f0-9]{64}$/u.test(nonce || "") || !path.isAbsolute(file)) throw failure("AGY_GUARD_LAUNCH_BINDING_INVALID");
  const root = path.dirname(path.dirname(file));
  if (!root.startsWith("/private/tmp/sggroup-")) throw failure("AGY_GUARD_MANIFEST_OUTSIDE_OWNED_ROOT");
  const loaded = readStable(file, { root, mode: 0o400, expectedSha256: digest });
  const manifest = parseStrictJson(loaded.bytes.toString("utf8"), { maxBytes: 256 * 1024 });
  if (manifest.version === 2) {
    if (manifest.runtime !== "antigravity" || manifest.root !== root || manifest.nonce !== nonce
      || !Array.isArray(manifest.rootIdentities) || !Array.isArray(manifest.protectedFiles)) throw failure("AGY_GUARD_MANIFEST_INVALID");
    validateRouter(manifest); verifyFrozenFiles(manifest, file, digest);
    return { manifest, digest, manifestPath: file };
  }
  if (manifest.version !== 1 || manifest.runtime !== "antigravity" || manifest.root !== root || manifest.nonce !== nonce
    || !text(manifest.caseId, 128) || !text(manifest.roleId, 128) || !plain(manifest.binding)
    || !["sessionId", "runtimeProfileId", "runtimeAccountId", "runId", "requestId"].every(key => text(manifest.binding[key], 512))
    || !Array.isArray(manifest.readRoots) || !manifest.readRoots.length || !Array.isArray(manifest.rootIdentities)
    || !Array.isArray(manifest.protectedFiles) || !Array.isArray(manifest.cachedSchemas) || !plain(manifest.builtinSchemas)) throw failure("AGY_GUARD_MANIFEST_INVALID");
  verifyFrozenFiles(manifest, file, digest);
  return { manifest, digest, manifestPath: file };
}
function validateSchema(value, rule, depth = 0) {
  if (!plain(rule) || depth > 12) return false;
  const known = ["type", "properties", "required", "additionalProperties", "items", "enum", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "pattern", "description", "title", "default", "propertyOrdering"];
  if (Object.keys(rule).some(key => !known.includes(key))) return false;
  if (rule.enum && (!Array.isArray(rule.enum) || !rule.enum.some(item => JSON.stringify(item) === JSON.stringify(value)))) return false;
  const type = typeof rule.type === "string" ? rule.type.toLowerCase() : null;
  if (type === "object") return plain(value) && plain(rule.properties) && Array.isArray(rule.required || [])
    && (rule.required || []).every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => Object.hasOwn(rule.properties, key) && validateSchema(value[key], rule.properties[key], depth + 1));
  if (type === "array") return Array.isArray(value) && value.length >= (rule.minItems ?? 0) && value.length <= (rule.maxItems ?? 4096)
    && value.every(item => validateSchema(item, rule.items, depth + 1));
  if (type === "string") {
    if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0") || Buffer.byteLength(value, "utf8") > (rule.maxLength ?? MAX_INPUT)
      || value.length < (rule.minLength ?? 0)) return false;
    try { return !rule.pattern || typeof rule.pattern === "string" && new RegExp(rule.pattern, "u").test(value); } catch { return false; }
  }
  if (type === "integer" || type === "number") return typeof value === "number" && Number.isFinite(value)
    && (type !== "integer" || Number.isSafeInteger(value)) && value >= (rule.minimum ?? -Infinity) && value <= (rule.maximum ?? Infinity);
  if (type === "boolean") return typeof value === "boolean";
  return type === "null" && value === null;
}
function fileTarget(raw, manifest, { write = false } = {}) {
  if (!text(raw) || !path.isAbsolute(raw) || path.normalize(raw) !== raw || /[\\\r\n]/u.test(raw) || raw.split("/").includes("..")) return null;
  const root = (write ? [manifest.workspace] : manifest.readRoots).find(candidate => within(raw, candidate));
  if (!root) return null;
  if (write && raw !== manifest.artifactPath) return null;
  try {
    noLinks(path.dirname(raw), manifest.root);
    if (pathExists(raw)) { noLinks(raw, manifest.root); const stat = fs.lstatSync(raw); if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_INPUT) return null; }
    else if (!write) return null;
    return raw;
  } catch { return null; }
}
function cachedSchema(raw, manifest) {
  const record = manifest.cachedSchemas.find(item => item.path === raw);
  if (!record) return false;
  const expected = path.join(manifest.appDataDir, "brain", manifest.binding.sessionId, "mcp", "shoggoth", record.toolName + ".json");
  if (raw !== expected || !manifest.groupTools.includes(record.toolName)) return false;
  try { readStable(raw, { root: manifest.root, expectedSha256: record.sha256, identity: record.identity, maxBytes: MAX_INPUT }); return true; } catch { return false; }
}
function unsafeNativeFields(value) {
  if (Array.isArray(value)) return value.some(unsafeNativeFields);
  if (!plain(value)) return false;
  return Object.entries(value).some(([key, child]) => /env|daemon|background|async|safetoautorun|proxy|startup|authorization|bearer|apikey|credential/iu.test(key.replace(/_/gu, "")) || unsafeNativeFields(child));
}
function decide(manifest, input) {
  if (!exact(input, ["toolCall", "stepIdx", "conversationId", "workspacePaths", "transcriptPath", "artifactDirectoryPath"])
    || !exact(input.toolCall, ["name", "args"]) || !text(input.toolCall.name, 128) || !plain(input.toolCall.args)
    || !Number.isSafeInteger(input.stepIdx) || input.stepIdx < 1) return "AGY_GUARD_HOOK_INPUT_INVALID";
  if (input.conversationId !== manifest.binding.sessionId || JSON.stringify(input.workspacePaths) !== JSON.stringify(manifest.workspacePaths)
    || input.transcriptPath !== manifest.transcriptPath || input.artifactDirectoryPath !== manifest.artifactDirectoryPath) return "AGY_GUARD_SESSION_OR_WORKSPACE_UNBOUND";
  const { name, args } = input.toolCall;
  if (name === "call_mcp_tool") {
    if (!exact(args, ["ServerName", "ToolName", "Arguments"]) || args.ServerName !== "shoggoth"
      || !manifest.groupTools.includes(args.ToolName) || !plain(args.Arguments)) return "AGY_GUARD_MCP_OUTSIDE_FROZEN_SCOPE";
    const validator = require(manifest.groupValidatorPath).validateGroupMcpArguments;
    if (!validator(args.ToolName, args.Arguments)) return "AGY_GUARD_MCP_ARGUMENTS_INVALID";
    if (Object.hasOwn(args.Arguments, "groupToken")) {
      if (!manifest.groupTokenDigests.includes(sha(args.Arguments.groupToken))) return "AGY_GUARD_GROUP_AUTHORITY_UNBOUND";
    } else if (!manifest.groupSources.some(source => source.source === args.Arguments.source && source.sourceId === args.Arguments.sourceId)) return "AGY_GUARD_GROUP_AUTHORITY_UNBOUND";
    return undefined;
  }
  if (name === "view_file") {
    const lower = ["absolute_path", "start_line", "end_line"], upper = ["AbsolutePath", "StartLine", "EndLine"];
    const fields = Object.keys(args), keys = Object.hasOwn(args, "absolute_path") ? lower : upper;
    if (!fields.every(key => keys.includes(key)) || !text(args[keys[0]]) || fields.slice().some(key => key !== keys[0]
      && (!Number.isSafeInteger(args[key]) || args[key] < 1 || args[key] > 65536))) return "AGY_GUARD_FILE_ARGUMENTS_INVALID";
    if (args[keys[1]] !== undefined && args[keys[2]] !== undefined && args[keys[2]] < args[keys[1]]) return "AGY_GUARD_FILE_ARGUMENTS_INVALID";
    if (cachedSchema(args[keys[0]], manifest)) return undefined;
    if (manifest.caseId !== "implementation-review") return "AGY_GUARD_FILE_CASE_UNBOUND";
    return fileTarget(args[keys[0]], manifest) ? undefined : "AGY_GUARD_FILE_OUTSIDE_FROZEN_SCOPE";
  }
  const schema = manifest.builtinSchemas[name];
  if (!schema) return "AGY_GUARD_TOOL_OR_SCHEMA_UNKNOWN";
  if (!validateSchema(args, schema.parameters)) return "AGY_GUARD_UNKNOWN_FIELD_OR_ARGUMENT";
  if (unsafeNativeFields(args)) return "AGY_GUARD_FORBIDDEN_TOOL_ARGUMENT_FIELD";
  if (name === "run_command") {
    // A declared schema field proves its name/type, not a safe shell effect.
    // Background/env/auto-run and any extra command controls remain denied.
    if (!exact(args, ["CommandLine", "Cwd"])) return "AGY_GUARD_COMMAND_ARGUMENTS_UNPROVEN";
    if (manifest.caseId !== "approval-wait" || args.Cwd !== manifest.workspace || !text(args.CommandLine, 2048)) return "AGY_GUARD_COMMAND_CONTEXT_UNBOUND";
    const shared = require(manifest.sharedPolicyPath);
    if (!shared.exactApprovalCommand(args.CommandLine, manifest.workspace)) return "AGY_GUARD_COMMAND_OUTSIDE_EXACT_DESCRIPTOR";
    const target = path.join(manifest.workspace, "approval-proof.txt");
    try { noLinks(manifest.workspace, manifest.root); if (pathExists(target)) return "AGY_GUARD_APPROVAL_TARGET_ALREADY_EXISTS"; } catch { return "AGY_GUARD_APPROVAL_PATH_UNSAFE"; }
    return undefined;
  }
  if (!["create_file", "edit_file"].includes(name) || manifest.caseId !== "implementation-review") return "AGY_GUARD_TOOL_CASE_UNBOUND";
  const pathFields = ["TargetFile", "target_file", "path", "file_path", "AbsolutePath", "absolute_path", "FilePath"].filter(key => Object.hasOwn(args, key));
  if (pathFields.length !== 1 || !fileTarget(args[pathFields[0]], manifest, { write: true })) return "AGY_GUARD_FILE_OUTSIDE_FROZEN_SCOPE";
  if (name === "edit_file" && !fs.existsSync(manifest.artifactPath)) return "AGY_GUARD_EDIT_TARGET_MISSING";
  return undefined;
}
function evaluate(loaded, input) {
  try { const reason = decide(loaded.manifest, input); return reason ? { allowTool: false, denyReason: reason } : { allowTool: true }; }
  catch { return { allowTool: false, denyReason: "AGY_GUARD_POLICY_EVALUATION_FAILED" }; }
}
function readStdin() {
  const pieces = []; let size = 0;
  for (;;) { const bytes = Buffer.alloc(4096), count = fs.readSync(0, bytes, 0, bytes.length, null); if (!count) break;
    size += count; if (size > MAX_INPUT) throw failure("AGY_GUARD_INPUT_TOO_LARGE"); pieces.push(bytes.subarray(0, count)); }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pieces)); } catch { throw failure("AGY_GUARD_INVALID_UTF8"); }
}
function recordDecision(loaded, raw, input, answer) {
  const { manifest, digest } = loaded, file = manifest.decisionLogPath;
  noLinks(path.dirname(file), manifest.root);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 1024 * 1024) throw failure("AGY_GUARD_DECISION_LOG_UNSAFE");
    const record = { version: 1, at: new Date().toISOString(), pid: process.pid, ppid: process.ppid, uid: process.getuid(),
      executable: fs.realpathSync(process.execPath), cwd: process.cwd(), policyDigest: digest, nonceDigest: sha(manifest.nonce),
      sessionId: manifest.binding.sessionId ?? null, runId: manifest.binding.runId ?? null, requestId: manifest.binding.requestId ?? null,
      caseId: manifest.caseId ?? null, roleId: manifest.roleId ?? null, stepIdx: Number.isSafeInteger(input?.stepIdx) ? input.stepIdx : null,
      toolName: text(input?.toolCall?.name, 128) ? input.toolCall.name : null, argumentFields: plain(input?.toolCall?.args) ? Object.keys(input.toolCall.args).sort() : [],
      inputDigest: sha(raw), allowTool: answer.allowTool, denyReason: answer.denyReason ?? null,
      toolBodyExecutedByGuard: false, realSdkHookExecutionProven: false };
    fs.writeFileSync(fd, JSON.stringify(record) + "\n");
  } finally { fs.closeSync(fd); }
}
function main(args) {
  let answer, loaded, raw = "", input;
  try {
    const flags = new Map();
    for (let index = 0; index < args.length; index += 2) {
      if (!["--manifest", "--digest", "--nonce"].includes(args[index]) || !args[index + 1] || flags.has(args[index])) throw failure("AGY_GUARD_LAUNCH_BINDING_INVALID");
      flags.set(args[index], args[index + 1]);
    }
    loaded = loadManifest(flags.get("--manifest"), flags.get("--digest"), flags.get("--nonce"));
    const cwd = fs.realpathSync(process.cwd());
    if (loaded.manifest.version !== 2 && cwd !== loaded.manifest.workspace) throw failure("AGY_GUARD_ACTUAL_CWD_UNBOUND");
    if (fs.realpathSync(process.execPath) !== loaded.manifest.nodePath || process.env.HOME !== loaded.manifest.guardHome || process.env.TMPDIR !== loaded.manifest.guardTmp
      || Object.keys(process.env).some(key => !["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "__CF_USER_TEXT_ENCODING"].includes(key))) throw failure("AGY_GUARD_LAUNCH_ENV_UNSAFE");
    raw = readStdin(); input = parseStrictJson(raw); loaded = routeSession(loaded, input, cwd); answer = evaluate(loaded, input);
  } catch (error) { answer = { allowTool: false, denyReason: /^AGY_GUARD_[A-Z_]+$/u.test(error?.code || "") ? error.code : "AGY_GUARD_UNAVAILABLE" }; }
  if (loaded) try { recordDecision(loaded, raw, input, answer); } catch { answer = { allowTool: false, denyReason: "AGY_GUARD_DECISION_LOG_UNAVAILABLE" }; }
  process.stdout.write(JSON.stringify(answer) + "\n");
}
module.exports = { MAX_INPUT, sha, failure, plain, exact, text, within, parseStrictJson, statIdentity, noLinks, readStable, policyCommand, hookConfig,
  officialWorkspacePaths, officialAppDataDir, officialArtifactDirectory, officialTranscript, startupFiles, validateParentEnvironment,
  pathExists, admissionMac, validateRouter, routeSession, loadManifest, validateSchema, fileTarget, cachedSchema, decide, evaluate, recordDecision, main };
if (require.main === module) main(process.argv.slice(2));
