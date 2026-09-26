"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");
const { validRuntimeProfileId } = require("./runtime-adapter");

const PI_RUNTIME = "pi";
const MIN_PI_VERSION = Object.freeze([0, 84, 4]);
const MAX_PI_VERSION_EXCLUSIVE = Object.freeze([0, 85, 0]);
const DEFAULT_PI_PERMISSION_POLICY = Object.freeze({
  approvalPolicy: "on-request",
  sandbox: "danger-full-access",
});
const VALID_APPROVAL_POLICIES = new Set(["untrusted", "on-failure", "on-request", "never"]);
const VALID_SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);

function runtimeError(code, message) {
  return serviceError(code, message);
}

function preparePiHome(paths, runtimeProfileId) {
  if (!validRuntimeProfileId(runtimeProfileId)) {
    throw runtimeError("PI_RUNTIME_PROFILE_INVALID", "Pi runtime profile id is invalid");
  }
  const profileId = runtimeProfileId;
  if (!paths || typeof paths.stateDir !== "string" || !path.isAbsolute(paths.stateDir)
    || typeof paths.trustedRoot !== "string" || !path.isAbsolute(paths.trustedRoot)) {
    throw runtimeError("PI_PATHS_INVALID", "Pi runtime paths are invalid");
  }
  const base = path.join(paths.stateDir, PI_RUNTIME);
  const home = path.join(base, profileId);
  const relative = path.relative(base, home);
  if (relative !== profileId || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw runtimeError("PI_RUNTIME_PROFILE_INVALID", "Pi runtime profile path escapes its root");
  }
  ensurePrivateDirectoryTree(paths.stateDir, paths.trustedRoot);
  ensurePrivateDirectoryTree(base, paths.trustedRoot);
  ensurePrivateDirectoryTree(home, paths.trustedRoot);
  ensurePrivateDirectoryTree(path.join(home, "sessions"), paths.trustedRoot);
  return home;
}

function executableRealpath(candidate, fileSystem) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0")
    || !path.isAbsolute(candidate)) return null;
  try {
    const resolved = fileSystem.realpathSync(candidate);
    const stat = fileSystem.lstatSync(resolved);
    if (!path.isAbsolute(resolved) || !stat.isFile() || stat.isSymbolicLink()) return null;
    fileSystem.accessSync(resolved, fileSystem.constants.X_OK);
    return path.resolve(resolved);
  } catch {
    return null;
  }
}

function resolvePiExecutable(candidate, options = {}) {
  const resolved = executableRealpath(candidate, options.fs || fs);
  if (!resolved) {
    throw runtimeError(
      options.code || "PI_BINARY_INVALID",
      options.message || "Pi executable is unavailable or unsafe",
    );
  }
  return resolved;
}

function resolvePiBinary(options = {}) {
  const fileSystem = options.fs || fs;
  if (options.binaryPath !== undefined) {
    return resolvePiExecutable(options.binaryPath, {
      fs: fileSystem,
      code: "PI_BINARY_INVALID",
      message: "Pi binaryPath must be an absolute executable regular file",
    });
  }
  const parentEnv = options.parentEnv || process.env;
  const userHome = options.homedir || os.homedir();
  const candidates = [];
  for (const entry of String(parentEnv.PATH || "").split(path.delimiter)) {
    if (entry.length > 0 && path.isAbsolute(entry) && !entry.includes("\0")) {
      candidates.push(path.join(entry, "pi"));
    }
  }
  if (typeof userHome === "string" && path.isAbsolute(userHome) && !userHome.includes("\0")) {
    candidates.push(path.join(userHome, ".local", "bin", "pi"));
  }
  candidates.push("/opt/homebrew/bin/pi", "/usr/local/bin/pi");
  for (const candidate of [...new Set(candidates)]) {
    const resolved = executableRealpath(candidate, fileSystem);
    if (resolved) return resolved;
  }
  throw runtimeError("PI_BINARY_NOT_FOUND", "Pi CLI executable was not found");
}

function resolvePiLaunch(binaryPath, options = {}) {
  const fileSystem = options.fs || fs;
  const resolvedBinary = resolvePiExecutable(binaryPath, { fs: fileSystem });
  const header = Buffer.alloc(256);
  let descriptor;
  try {
    const file = fileSystem.openSync(resolvedBinary, "r");
    try {
      const bytesRead = fileSystem.readSync(file, header, 0, header.length, 0);
      const newline = header.indexOf(0x0a, 0);
      descriptor = header.subarray(0, newline >= 0 && newline < bytesRead ? newline : bytesRead)
        .toString("utf8").replace(/\r$/u, "");
    } finally {
      fileSystem.closeSync(file);
    }
  } catch {
    throw runtimeError("PI_BINARY_INVALID", "Pi executable could not be inspected safely");
  }
  if (!descriptor.startsWith("#!")) {
    return Object.freeze({ command: resolvedBinary, argsPrefix: Object.freeze([]) });
  }
  if (descriptor !== "#!/usr/bin/env node") {
    throw runtimeError("PI_BINARY_INVALID", "Pi executable uses an unsupported interpreter");
  }
  const parentEnv = options.parentEnv || process.env;
  const userHome = options.homedir || os.homedir();
  const candidates = [];
  for (const entry of String(parentEnv.PATH || "").split(path.delimiter)) {
    if (entry.length > 0 && path.isAbsolute(entry) && !entry.includes("\0")) {
      candidates.push(path.join(entry, "node"));
    }
  }
  if (typeof userHome === "string" && path.isAbsolute(userHome) && !userHome.includes("\0")) {
    candidates.push(path.join(userHome, ".local", "bin", "node"));
  }
  candidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node");
  for (const candidate of [...new Set(candidates)]) {
    const resolvedNode = executableRealpath(candidate, fileSystem);
    if (resolvedNode) {
      return Object.freeze({
        command: resolvedNode,
        argsPrefix: Object.freeze([resolvedBinary]),
      });
    }
  }
  throw runtimeError("PI_NODE_NOT_FOUND", "Node.js executable for Pi CLI was not found");
}

function parsePiVersion(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 1024) return null;
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => Number.isSafeInteger(part)) ? Object.freeze(parts) : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function supportsPiVersion(value) {
  const version = Array.isArray(value) ? value : parsePiVersion(value);
  return Boolean(version && version.length === 3
    && compareVersions(version, MIN_PI_VERSION) >= 0
    && compareVersions(version, MAX_PI_VERSION_EXCLUSIVE) < 0);
}

function normalizePiPermissionPolicy(value = DEFAULT_PI_PERMISSION_POLICY) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !VALID_APPROVAL_POLICIES.has(value.approvalPolicy)
    || !VALID_SANDBOXES.has(value.sandbox)) {
    throw runtimeError("PI_PERMISSION_POLICY_INVALID", "Pi permission policy is invalid");
  }
  return Object.freeze({ approvalPolicy: value.approvalPolicy, sandbox: value.sandbox });
}

function piPermissionFingerprint(value) {
  const policy = normalizePiPermissionPolicy(value);
  return JSON.stringify([policy.approvalPolicy, policy.sandbox]);
}

function normalizePiWorkspace(value) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || !value.isWellFormed() || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw runtimeError("PI_WORKSPACE_INVALID", "Pi workspace must be canonical and absolute");
  }
  return value;
}

function piWorkspaceShardId({ controlInstance = false, workspace = null } = {}) {
  if (typeof controlInstance !== "boolean") {
    throw runtimeError("PI_WORKSPACE_INVALID", "Pi control flag is invalid");
  }
  const normalized = controlInstance ? null : normalizePiWorkspace(workspace);
  return crypto.createHash("sha256").update(JSON.stringify([
    controlInstance ? "control" : "execution",
    normalized,
  ])).digest("hex");
}

function safeModelPart(value, maxBytes = 512) {
  return typeof value === "string" && value.length > 0 && value.isWellFormed()
    && !value.includes("\0") && !/[\r\n]/u.test(value)
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function piModelRef(provider, modelId) {
  if (!safeModelPart(provider, 128) || provider.includes("/") || !safeModelPart(modelId)) {
    throw runtimeError("RUNTIME_MODEL_UNAVAILABLE", "Pi model reference is invalid");
  }
  return `${provider}/${modelId}`;
}

function parsePiModelRef(value) {
  if (!safeModelPart(value, 640)) return null;
  const separator = value.indexOf("/");
  if (separator < 1 || separator === value.length - 1) return null;
  const provider = value.slice(0, separator);
  const modelId = value.slice(separator + 1);
  if (!safeModelPart(provider, 128) || provider.includes("/") || !safeModelPart(modelId)) return null;
  return Object.freeze({ provider, modelId });
}

function assertPiExtensionPath(value, options = {}) {
  const fileSystem = options.fs || fs;
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw runtimeError("PI_EXTENSION_INVALID", "Pi trusted extension path is invalid");
  }
  try {
    const stat = fileSystem.lstatSync(value);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe extension");
  } catch {
    throw runtimeError("PI_EXTENSION_INVALID", "Pi trusted extension is unavailable or unsafe");
  }
  return path.resolve(value);
}

function buildPiRpcArgs(options = {}) {
  const policy = normalizePiPermissionPolicy(options.permissionPolicy);
  const sessionId = options.sessionId;
  const sessionDir = options.sessionDir;
  const extensionPath = options.extensionPath;
  if (typeof sessionId !== "string" || !/^[0-9a-f-]{36}$/u.test(sessionId)
    || typeof sessionDir !== "string" || !path.isAbsolute(sessionDir)
    || typeof extensionPath !== "string" || !path.isAbsolute(extensionPath)) {
    throw runtimeError("PI_SESSION_PARAMS_INVALID", "Pi RPC session arguments are invalid");
  }
  const args = [
    "--mode", "rpc",
    "--session-id", sessionId,
    "--session-dir", sessionDir,
    "--no-extensions",
    "--extension", extensionPath,
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--offline",
  ];
  const excluded = policy.sandbox === "read-only"
    ? "bash,powershell,edit,write"
    : policy.sandbox === "workspace-write" ? "bash,powershell" : "powershell";
  args.push("--exclude-tools", excluded);
  if (options.model !== null && options.model !== undefined) {
    const model = parsePiModelRef(options.model);
    if (!model) throw runtimeError("RUNTIME_MODEL_UNAVAILABLE", "Pi model is invalid");
    args.push("--provider", model.provider, "--model", model.modelId);
  }
  if (options.name !== null && options.name !== undefined) {
    if (!safeModelPart(options.name, 1024)) {
      throw runtimeError("PI_SESSION_PARAMS_INVALID", "Pi session name is invalid");
    }
    args.push("--name", options.name);
  }
  return Object.freeze(args);
}

module.exports = {
  DEFAULT_PI_PERMISSION_POLICY,
  MAX_PI_VERSION_EXCLUSIVE,
  MIN_PI_VERSION,
  PI_RUNTIME,
  assertPiExtensionPath,
  buildPiRpcArgs,
  normalizePiPermissionPolicy,
  normalizePiWorkspace,
  parsePiModelRef,
  parsePiVersion,
  piModelRef,
  piPermissionFingerprint,
  piWorkspaceShardId,
  preparePiHome,
  resolvePiBinary,
  resolvePiExecutable,
  resolvePiLaunch,
  supportsPiVersion,
};
