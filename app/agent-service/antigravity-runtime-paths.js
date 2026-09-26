"use strict";

const crypto = require("node:crypto");
const { execFileSync: defaultExecFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  assertPrivateRegularFile,
  ensurePrivateDirectoryTree,
  lstatIfExists,
  serviceError,
} = require("./security");
const { validRuntimeAccountId, validRuntimeProfileId } = require("./runtime-adapter");

const ANTIGRAVITY_RUNTIME = "antigravity";
const MIN_ANTIGRAVITY_VERSION = Object.freeze([1, 1, 16]);
const DEFAULT_ANTIGRAVITY_PERMISSION_POLICY = Object.freeze({
  approvalPolicy: "on-request",
  sandbox: "danger-full-access",
});
const VALID_APPROVAL_POLICIES = new Set(["untrusted", "on-failure", "on-request", "never"]);
const VALID_SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const SECURITY_COMMAND = "/usr/bin/security";
const KEYCHAIN_COMMAND_TIMEOUT_MS = 5_000;
const MAX_KEYCHAIN_OUTPUT_BYTES = 64 * 1024;

function runtimeError(code, message) {
  return serviceError(code, message);
}

function prepareAntigravityHome(paths, runtimeProfileId) {
  if (!validRuntimeProfileId(runtimeProfileId)) {
    throw runtimeError("ANTIGRAVITY_RUNTIME_PROFILE_INVALID", "Antigravity runtime profile id is invalid");
  }
  const profileId = runtimeProfileId;
  if (!paths || typeof paths.stateDir !== "string" || !path.isAbsolute(paths.stateDir)
    || typeof paths.trustedRoot !== "string" || !path.isAbsolute(paths.trustedRoot)) {
    throw runtimeError("ANTIGRAVITY_PATHS_INVALID", "Antigravity runtime paths are invalid");
  }
  const base = path.join(paths.stateDir, ANTIGRAVITY_RUNTIME);
  const home = path.join(base, profileId);
  const relative = path.relative(base, home);
  if (relative !== profileId || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw runtimeError(
      "ANTIGRAVITY_RUNTIME_PROFILE_INVALID",
      "Antigravity runtime profile path escapes its root",
    );
  }
  ensurePrivateDirectoryTree(paths.stateDir, paths.trustedRoot);
  ensurePrivateDirectoryTree(base, paths.trustedRoot);
  ensurePrivateDirectoryTree(home, paths.trustedRoot);
  ensurePrivateDirectoryTree(path.join(home, ".gemini"), paths.trustedRoot);
  ensurePrivateDirectoryTree(path.join(home, ".gemini", "config"), paths.trustedRoot);
  ensurePrivateDirectoryTree(path.join(home, ".gemini", "antigravity-cli"), paths.trustedRoot);
  return home;
}

function prepareAntigravityRuntimeAccountHome(paths, runtimeAccountId) {
  if (!validRuntimeAccountId(runtimeAccountId)) {
    throw runtimeError("ANTIGRAVITY_RUNTIME_ACCOUNT_INVALID", "Antigravity runtime account id is invalid");
  }
  if (!paths || typeof paths.stateDir !== "string" || !path.isAbsolute(paths.stateDir)
    || typeof paths.trustedRoot !== "string" || !path.isAbsolute(paths.trustedRoot)) {
    throw runtimeError("ANTIGRAVITY_PATHS_INVALID", "Antigravity runtime paths are invalid");
  }
  const integrationRoot = paths.runtimeIntegrationDir
    || path.join(paths.stateDir, "runtime-integration");
  const runtimeRoot = path.join(integrationRoot, ANTIGRAVITY_RUNTIME);
  const accountRoot = path.join(runtimeRoot, runtimeAccountId);
  const home = path.join(accountRoot, "home");
  const relative = path.relative(runtimeRoot, accountRoot);
  if (relative !== runtimeAccountId || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw runtimeError(
      "ANTIGRAVITY_RUNTIME_ACCOUNT_INVALID",
      "Antigravity runtime account path escapes its root",
    );
  }
  ensurePrivateDirectoryTree(integrationRoot, paths.trustedRoot);
  ensurePrivateDirectoryTree(runtimeRoot, paths.trustedRoot);
  ensurePrivateDirectoryTree(accountRoot, paths.trustedRoot);
  ensurePrivateDirectoryTree(home, paths.trustedRoot);
  ensurePrivateDirectoryTree(path.join(home, ".gemini", "config"), paths.trustedRoot);
  ensurePrivateDirectoryTree(path.join(home, ".gemini", "antigravity-cli"), paths.trustedRoot);
  return home;
}

function tightenKeychainPreferences(target) {
  const before = lstatIfExists(target);
  if (!before) return false;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || (typeof process.getuid === "function" && before.uid !== process.getuid())) {
    throw runtimeError(
      "ANTIGRAVITY_KEYCHAIN_CONTEXT_UNAVAILABLE",
      "Antigravity keychain preferences are unsafe",
    );
  }
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.nlink !== 1
      || (typeof process.getuid === "function" && opened.uid !== process.getuid())) {
      throw runtimeError(
        "ANTIGRAVITY_KEYCHAIN_CONTEXT_UNAVAILABLE",
        "Antigravity keychain preferences changed during validation",
      );
    }
    fs.fchmodSync(fd, 0o600);
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw runtimeError(
        "ANTIGRAVITY_KEYCHAIN_CONTEXT_UNAVAILABLE",
        "Antigravity keychain preferences are unsafe",
      );
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  assertPrivateRegularFile(target);
  return true;
}

function canonicalKeychainPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || !value.isWellFormed() || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw runtimeError(
      "ANTIGRAVITY_KEYCHAIN_CONTEXT_UNAVAILABLE",
      "The default macOS keychain path is invalid",
    );
  }
  const resolved = fs.realpathSync(value);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw runtimeError(
      "ANTIGRAVITY_KEYCHAIN_CONTEXT_UNAVAILABLE",
      "The default macOS keychain is unsafe",
    );
  }
  return resolved;
}

function parseKeychainPaths(output) {
  if (typeof output !== "string"
    || Buffer.byteLength(output, "utf8") > MAX_KEYCHAIN_OUTPUT_BYTES) {
    throw runtimeError(
      "ANTIGRAVITY_KEYCHAIN_CONTEXT_UNAVAILABLE",
      "macOS returned an invalid keychain response",
    );
  }
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return lines.map((line) => {
    const match = line.match(/^"([^"\r\n]{1,4096})"$/u);
    if (!match) {
      throw runtimeError(
        "ANTIGRAVITY_KEYCHAIN_CONTEXT_UNAVAILABLE",
        "macOS returned an invalid keychain response",
      );
    }
    return canonicalKeychainPath(match[1]);
  });
}

function runKeychainCommand(execute, home, args, allowFailure = false) {
  try {
    return execute(SECURITY_COMMAND, args, {
      encoding: "utf8",
      env: { HOME: home, PATH: "/usr/bin:/bin", LANG: "C" },
      maxBuffer: MAX_KEYCHAIN_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: KEYCHAIN_COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    if (allowFailure) return null;
    throw runtimeError(
      "ANTIGRAVITY_KEYCHAIN_CONTEXT_UNAVAILABLE",
      "The macOS keychain context could not be prepared",
    );
  }
}

function readKeychainPaths(execute, home, args, allowFailure = false) {
  const output = runKeychainCommand(execute, home, args, allowFailure);
  if (output === null) return null;
  try { return parseKeychainPaths(output); } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function prepareAntigravityKeychainContext(options = {}) {
  if ((options.platform || process.platform) !== "darwin") return;
  const { home, userHome, trustedRoot } = options;
  const execute = options.execFileSync || defaultExecFileSync;
  if (typeof home !== "string" || !path.isAbsolute(home) || path.resolve(home) !== home
    || typeof userHome !== "string" || !path.isAbsolute(userHome)
    || path.resolve(userHome) !== userHome || typeof trustedRoot !== "string"
    || !path.isAbsolute(trustedRoot) || typeof execute !== "function") {
    throw runtimeError(
      "ANTIGRAVITY_KEYCHAIN_CONTEXT_UNAVAILABLE",
      "Antigravity keychain context parameters are invalid",
    );
  }
  try {
    const library = path.join(home, "Library");
    const preferences = path.join(library, "Preferences");
    const preferencesPath = path.join(preferences, "com.apple.security.plist");
    ensurePrivateDirectoryTree(library, trustedRoot);
    ensurePrivateDirectoryTree(preferences, trustedRoot);
    tightenKeychainPreferences(preferencesPath);

    const sourceDefault = readKeychainPaths(
      execute,
      userHome,
      ["default-keychain", "-d", "user"],
    );
    if (sourceDefault.length !== 1) {
      throw runtimeError(
        "ANTIGRAVITY_KEYCHAIN_CONTEXT_UNAVAILABLE",
        "The user default macOS keychain is unavailable",
      );
    }
    const expected = sourceDefault[0];
    const managedDefault = readKeychainPaths(
      execute,
      home,
      ["default-keychain", "-d", "user"],
      true,
    );
    const managedSearchList = readKeychainPaths(
      execute,
      home,
      ["list-keychains", "-d", "user"],
      true,
    );
    if (managedDefault?.length === 1 && managedDefault[0] === expected
      && managedSearchList?.length === 1 && managedSearchList[0] === expected
      && tightenKeychainPreferences(preferencesPath)) return;

    runKeychainCommand(
      execute,
      home,
      ["list-keychains", "-d", "user", "-s", expected],
    );
    runKeychainCommand(
      execute,
      home,
      ["default-keychain", "-d", "user", "-s", expected],
    );
    const verifiedDefault = readKeychainPaths(
      execute,
      home,
      ["default-keychain", "-d", "user"],
    );
    const verifiedSearchList = readKeychainPaths(
      execute,
      home,
      ["list-keychains", "-d", "user"],
    );
    if (verifiedDefault.length !== 1 || verifiedDefault[0] !== expected
      || verifiedSearchList.length !== 1 || verifiedSearchList[0] !== expected
      || !tightenKeychainPreferences(preferencesPath)) {
      throw runtimeError(
        "ANTIGRAVITY_KEYCHAIN_CONTEXT_UNAVAILABLE",
        "The managed macOS keychain context could not be verified",
      );
    }
  } catch (error) {
    if (error?.code === "ANTIGRAVITY_KEYCHAIN_CONTEXT_UNAVAILABLE") throw error;
    throw runtimeError(
      "ANTIGRAVITY_KEYCHAIN_CONTEXT_UNAVAILABLE",
      "The macOS keychain context could not be prepared",
    );
  }
}

function executableRealpath(candidate, fileSystem) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0")
    || !path.isAbsolute(candidate)) return null;
  try {
    const resolved = fileSystem.realpathSync(candidate);
    const stat = fileSystem.lstatSync(resolved);
    if (!path.isAbsolute(resolved) || !stat.isFile() || stat.isSymbolicLink()) {
      return null;
    }
    fileSystem.accessSync(resolved, fileSystem.constants.X_OK);
    return path.resolve(resolved);
  } catch {
    return null;
  }
}

function resolveAntigravityExecutable(candidate, options = {}) {
  const fileSystem = options.fs || fs;
  const resolved = executableRealpath(candidate, fileSystem);
  if (!resolved) {
    throw runtimeError(
      options.code || "ANTIGRAVITY_BINARY_INVALID",
      options.message || "Antigravity executable is unavailable or unsafe",
    );
  }
  return resolved;
}

function resolveAntigravityBinary(options = {}) {
  const fileSystem = options.fs || fs;
  if (options.binaryPath !== undefined) {
    return resolveAntigravityExecutable(options.binaryPath, {
      fs: fileSystem,
      code: "ANTIGRAVITY_BINARY_INVALID",
      message: "Antigravity binaryPath must be an absolute executable regular file",
    });
  }
  const parentEnv = options.parentEnv || process.env;
  const userHome = options.homedir || os.homedir();
  const candidates = [];
  for (const entry of String(parentEnv.PATH || "").split(path.delimiter)) {
    if (entry.length > 0 && path.isAbsolute(entry) && !entry.includes("\0")) {
      candidates.push(path.join(entry, "agy"));
    }
  }
  if (typeof userHome === "string" && path.isAbsolute(userHome) && !userHome.includes("\0")) {
    candidates.push(path.join(userHome, ".local", "bin", "agy"));
  }
  candidates.push("/opt/homebrew/bin/agy", "/usr/local/bin/agy");
  for (const candidate of [...new Set(candidates)]) {
    const resolved = executableRealpath(candidate, fileSystem);
    if (resolved) return resolved;
  }
  throw runtimeError("ANTIGRAVITY_BINARY_NOT_FOUND", "Antigravity CLI executable was not found");
}

function parseAntigravityVersion(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 1024) return null;
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => Number.isSafeInteger(part)) ? Object.freeze(parts) : null;
}

function supportsAntigravityVersion(value) {
  const version = Array.isArray(value) ? value : parseAntigravityVersion(value);
  if (!version || version.length !== 3) return false;
  for (let index = 0; index < MIN_ANTIGRAVITY_VERSION.length; index += 1) {
    if (version[index] > MIN_ANTIGRAVITY_VERSION[index]) return true;
    if (version[index] < MIN_ANTIGRAVITY_VERSION[index]) return false;
  }
  return true;
}

function normalizeAntigravityPermissionPolicy(value = DEFAULT_ANTIGRAVITY_PERMISSION_POLICY) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !VALID_APPROVAL_POLICIES.has(value.approvalPolicy)
    || !VALID_SANDBOXES.has(value.sandbox)) {
    throw runtimeError(
      "ANTIGRAVITY_PERMISSION_POLICY_INVALID",
      "Antigravity permission policy is invalid",
    );
  }
  return Object.freeze({ approvalPolicy: value.approvalPolicy, sandbox: value.sandbox });
}

function antigravityPermissionFingerprint(value) {
  const policy = normalizeAntigravityPermissionPolicy(value);
  return JSON.stringify([policy.approvalPolicy, policy.sandbox]);
}

function normalizeAntigravityWorkspace(value) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || !value.isWellFormed() || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw runtimeError(
      "ANTIGRAVITY_WORKSPACE_INVALID",
      "Antigravity workspace must be canonical and absolute",
    );
  }
  return value;
}

function antigravityWorkspaceShardId({ controlInstance = false, workspace = null } = {}) {
  if (typeof controlInstance !== "boolean") {
    throw runtimeError("ANTIGRAVITY_WORKSPACE_INVALID", "Antigravity control flag is invalid");
  }
  const normalized = controlInstance ? null : normalizeAntigravityWorkspace(workspace);
  return crypto.createHash("sha256").update(JSON.stringify([
    controlInstance ? "control" : "execution",
    normalized,
  ])).digest("hex");
}

function buildAntigravityTurnArgs({ permissionPolicy, permissionMode = null, model = null, conversationId = null, allowSlashCommands = false } = {}) {
  const policy = normalizeAntigravityPermissionPolicy(permissionPolicy);
  const mode = permissionMode || (policy.sandbox === "read-only" ? "plan"
    : policy.sandbox === "danger-full-access" && policy.approvalPolicy === "never"
      ? "full" : "accept-edits");
  if (!["plan", "accept-edits", "full"].includes(mode)) {
    throw runtimeError("ANTIGRAVITY_PERMISSION_POLICY_INVALID", "Antigravity permission mode is invalid");
  }
  if (model !== null && (typeof model !== "string" || model.length === 0
    || model.includes("\0") || Buffer.byteLength(model, "utf8") > 512)) {
    throw runtimeError("RUNTIME_MODEL_UNAVAILABLE", "Antigravity model is invalid");
  }
  if (conversationId !== null && (typeof conversationId !== "string" || conversationId.length === 0
    || conversationId.includes("\0") || Buffer.byteLength(conversationId, "utf8") > 512)) {
    throw runtimeError("RUNTIME_SESSION_NOT_FOUND", "Antigravity conversation id is invalid");
  }
  const args = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    ...(allowSlashCommands ? [] : ["--disable-slash-commands"]),
    "--print-timeout", "5m",
    "--mode", mode === "plan" ? "plan" : "accept-edits",
  ];
  if (mode === "full") args.push("--dangerously-skip-permissions");
  else args.push("--sandbox");
  if (model !== null) args.push("--model", model);
  if (conversationId === null) args.push("--new-project");
  else args.push("--conversation", conversationId);
  return Object.freeze(args);
}

module.exports = {
  ANTIGRAVITY_RUNTIME,
  DEFAULT_ANTIGRAVITY_PERMISSION_POLICY,
  MIN_ANTIGRAVITY_VERSION,
  antigravityPermissionFingerprint,
  antigravityWorkspaceShardId,
  buildAntigravityTurnArgs,
  normalizeAntigravityPermissionPolicy,
  normalizeAntigravityWorkspace,
  parseAntigravityVersion,
  prepareAntigravityHome,
  prepareAntigravityKeychainContext,
  prepareAntigravityRuntimeAccountHome,
  resolveAntigravityBinary,
  resolveAntigravityExecutable,
  supportsAntigravityVersion,
};
