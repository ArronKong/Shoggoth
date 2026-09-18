"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");
const { validRuntimeProfileId } = require("./runtime-adapter");

const CLAUDE_CODE_RUNTIME = "claude-code";
const MIN_CLAUDE_CODE_VERSION = Object.freeze([2, 1, 220]);
const DEFAULT_CLAUDE_CODE_PERMISSION_POLICY = Object.freeze({
  approvalPolicy: "on-request",
  sandbox: "danger-full-access",
});
const VALID_APPROVAL_POLICIES = new Set(["untrusted", "on-failure", "on-request", "never"]);
const VALID_SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);

function runtimeError(code, message) {
  return serviceError(code, message);
}

function prepareClaudeCodeHome(paths, runtimeProfileId) {
  if (!validRuntimeProfileId(runtimeProfileId)) {
    throw runtimeError("CLAUDE_CODE_RUNTIME_PROFILE_INVALID", "Claude Code runtime profile id is invalid");
  }
  const profileId = runtimeProfileId;
  if (!paths || typeof paths.stateDir !== "string" || !path.isAbsolute(paths.stateDir)
    || typeof paths.trustedRoot !== "string" || !path.isAbsolute(paths.trustedRoot)) {
    throw runtimeError("CLAUDE_CODE_PATHS_INVALID", "Claude Code runtime paths are invalid");
  }
  const base = path.join(paths.stateDir, CLAUDE_CODE_RUNTIME);
  const home = path.join(base, profileId);
  const relative = path.relative(base, home);
  if (relative !== profileId || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw runtimeError(
      "CLAUDE_CODE_RUNTIME_PROFILE_INVALID",
      "Claude Code runtime profile path escapes its root",
    );
  }
  ensurePrivateDirectoryTree(paths.stateDir, paths.trustedRoot);
  ensurePrivateDirectoryTree(base, paths.trustedRoot);
  ensurePrivateDirectoryTree(home, paths.trustedRoot);
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

function resolveClaudeCodeExecutable(candidate, options = {}) {
  const fileSystem = options.fs || fs;
  const resolved = executableRealpath(candidate, fileSystem);
  if (!resolved) {
    throw runtimeError(
      options.code || "CLAUDE_CODE_BINARY_INVALID",
      options.message || "Claude Code executable is unavailable or unsafe",
    );
  }
  return resolved;
}

function resolveClaudeCodeBinary(options = {}) {
  const fileSystem = options.fs || fs;
  if (options.binaryPath !== undefined) {
    return resolveClaudeCodeExecutable(options.binaryPath, {
      fs: fileSystem,
      code: "CLAUDE_CODE_BINARY_INVALID",
      message: "Claude Code binaryPath must be an absolute executable regular file",
    });
  }
  const parentEnv = options.parentEnv || process.env;
  const userHome = options.homedir || os.homedir();
  const candidates = [];
  for (const entry of String(parentEnv.PATH || "").split(path.delimiter)) {
    if (entry.length > 0 && path.isAbsolute(entry) && !entry.includes("\0")) {
      candidates.push(path.join(entry, "claude"));
    }
  }
  if (typeof userHome === "string" && path.isAbsolute(userHome) && !userHome.includes("\0")) {
    candidates.push(path.join(userHome, ".local", "bin", "claude"));
  }
  candidates.push("/opt/homebrew/bin/claude", "/usr/local/bin/claude");
  for (const candidate of [...new Set(candidates)]) {
    const resolved = executableRealpath(candidate, fileSystem);
    if (resolved) return resolved;
  }
  throw runtimeError("CLAUDE_CODE_BINARY_NOT_FOUND", "Claude Code CLI executable was not found");
}

function parseClaudeCodeVersion(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 1024) return null;
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?(?:\s+\(Claude Code\))?$/u);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => Number.isSafeInteger(part)) ? Object.freeze(parts) : null;
}

function supportsClaudeCodeVersion(value) {
  const version = Array.isArray(value) ? value : parseClaudeCodeVersion(value);
  if (!version || version.length !== 3) return false;
  for (let index = 0; index < MIN_CLAUDE_CODE_VERSION.length; index += 1) {
    if (version[index] > MIN_CLAUDE_CODE_VERSION[index]) return true;
    if (version[index] < MIN_CLAUDE_CODE_VERSION[index]) return false;
  }
  return true;
}

function normalizeClaudeCodePermissionPolicy(value = DEFAULT_CLAUDE_CODE_PERMISSION_POLICY) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !VALID_APPROVAL_POLICIES.has(value.approvalPolicy)
    || !VALID_SANDBOXES.has(value.sandbox)) {
    throw runtimeError(
      "CLAUDE_CODE_PERMISSION_POLICY_INVALID",
      "Claude Code permission policy is invalid",
    );
  }
  return Object.freeze({ approvalPolicy: value.approvalPolicy, sandbox: value.sandbox });
}

function claudeCodePermissionFingerprint(value) {
  const policy = normalizeClaudeCodePermissionPolicy(value);
  return JSON.stringify([policy.approvalPolicy, policy.sandbox]);
}

function normalizeClaudeCodeWorkspace(value) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || !value.isWellFormed() || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw runtimeError(
      "CLAUDE_CODE_WORKSPACE_INVALID",
      "Claude Code workspace must be canonical and absolute",
    );
  }
  return value;
}

function claudeCodeWorkspaceShardId({ controlInstance = false, workspace = null } = {}) {
  if (typeof controlInstance !== "boolean") {
    throw runtimeError("CLAUDE_CODE_WORKSPACE_INVALID", "Claude Code control flag is invalid");
  }
  const normalized = controlInstance ? null : normalizeClaudeCodeWorkspace(workspace);
  return crypto.createHash("sha256").update(JSON.stringify([
    controlInstance ? "control" : "execution",
    normalized,
  ])).digest("hex");
}

function claudeCodePermissionOptions(value, cwd, requestedMode = null) {
  const policy = normalizeClaudeCodePermissionPolicy(value);
  const workspace = normalizeClaudeCodeWorkspace(cwd);
  const mode = requestedMode || (policy.sandbox === "read-only" ? "plan"
    : policy.sandbox === "danger-full-access" && policy.approvalPolicy === "never"
      ? "bypassPermissions" : policy.approvalPolicy === "never" ? "acceptEdits" : "default");
  if (!["default", "acceptEdits", "auto", "dontAsk", "plan", "bypassPermissions"].includes(mode)) {
    throw runtimeError("CLAUDE_CODE_PERMISSION_POLICY_INVALID", "Claude Code permission mode is invalid");
  }
  if (mode === "plan") {
    return Object.freeze({
      permissionMode: "plan",
      allowDangerouslySkipPermissions: false,
      sandbox: undefined,
      settings: Object.freeze({
        permissions: Object.freeze({ blockReadsOutsideWorkingDirectories: true }),
      }),
    });
  }
  if (mode === "bypassPermissions") {
    return Object.freeze({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      sandbox: undefined,
      settings: Object.freeze({}),
    });
  }
  if (policy.sandbox === "danger-full-access") {
    return Object.freeze({
      permissionMode: mode,
      allowDangerouslySkipPermissions: false,
      sandbox: undefined,
      settings: Object.freeze({}),
    });
  }
  return Object.freeze({
    permissionMode: mode,
    allowDangerouslySkipPermissions: false,
    sandbox: Object.freeze({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: requestedMode === null && policy.approvalPolicy === "never",
      allowUnsandboxedCommands: false,
      filesystem: Object.freeze({ allowWrite: Object.freeze([workspace]) }),
    }),
    settings: Object.freeze({
      permissions: Object.freeze({ blockReadsOutsideWorkingDirectories: true }),
    }),
  });
}

module.exports = {
  CLAUDE_CODE_RUNTIME,
  DEFAULT_CLAUDE_CODE_PERMISSION_POLICY,
  MIN_CLAUDE_CODE_VERSION,
  claudeCodePermissionFingerprint,
  claudeCodePermissionOptions,
  claudeCodeWorkspaceShardId,
  normalizeClaudeCodePermissionPolicy,
  normalizeClaudeCodeWorkspace,
  parseClaudeCodeVersion,
  prepareClaudeCodeHome,
  resolveClaudeCodeBinary,
  resolveClaudeCodeExecutable,
  supportsClaudeCodeVersion,
};
