"use strict";

const crypto = require("node:crypto");
const { execFile: defaultExecFile, execFileSync: defaultExecFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  assertPrivateRegularFile,
  ensurePrivateDirectoryTree,
  lstatIfExists,
  serviceError,
} = require("./security");
const { validRuntimeAccountId } = require("./runtime-adapter");
const { resolveAntigravityAcpServer } = require("./antigravity-acp-distribution");

const ANTIGRAVITY_RUNTIME = "antigravity";
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

function* keychainContextSteps(options, execute) {
  if ((options.platform || process.platform) !== "darwin") return;
  const { home, userHome, trustedRoot } = options;
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

    const sourceDefault = yield { read: true, home: userHome, args: ["default-keychain", "-d", "user"] };
    if (sourceDefault.length !== 1) {
      throw runtimeError(
        "ANTIGRAVITY_KEYCHAIN_CONTEXT_UNAVAILABLE",
        "The user default macOS keychain is unavailable",
      );
    }
    const expected = sourceDefault[0];
    const managedDefault = yield { read: true, home, args: ["default-keychain", "-d", "user"], allowFailure: true };
    const managedSearchList = yield { read: true, home, args: ["list-keychains", "-d", "user"], allowFailure: true };
    if (managedDefault?.length === 1 && managedDefault[0] === expected
      && managedSearchList?.length === 1 && managedSearchList[0] === expected
      && tightenKeychainPreferences(preferencesPath)) return;

    yield { home, args: ["list-keychains", "-d", "user", "-s", expected] };
    yield { home, args: ["default-keychain", "-d", "user", "-s", expected] };
    const verifiedDefault = yield { read: true, home, args: ["default-keychain", "-d", "user"] };
    const verifiedSearchList = yield { read: true, home, args: ["list-keychains", "-d", "user"] };
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

function prepareAntigravityKeychainContext(options = {}) {
  const execute = options.execFileSync || defaultExecFileSync;
  const steps = keychainContextSteps(options, execute);
  let step = steps.next();
  while (!step.done) {
    const { read, home, args, allowFailure } = step.value;
    try {
      step = steps.next((read ? readKeychainPaths : runKeychainCommand)(execute, home, args, allowFailure));
    } catch (error) { step = steps.throw(error); }
  }
}

// Runtime discovery shares the Service event loop with health, chat and group
// reads. Waiting for macOS must yield without weakening the same context checks.
async function prepareAntigravityKeychainContextAsync(options = {}) {
  const execute = options.execFile || (options.execFileSync
    ? (command, args, config, callback) => {
      try { callback(null, options.execFileSync(command, args, config)); }
      catch (error) { callback(error); }
    } : defaultExecFile);
  const steps = keychainContextSteps(options, execute);
  let step = steps.next();
  while (!step.done) {
    const { read, home, args, allowFailure } = step.value;
    try {
      if (options.signal?.aborted) throw runtimeError("ANTIGRAVITY_KEYCHAIN_CONTEXT_UNAVAILABLE",
        "The macOS keychain context could not be prepared");
      const output = await new Promise((resolve, reject) => {
        let child, returned = false, closed = false, result;
        const finish = () => {
          if (!returned || !result || child?.once && !closed) return;
          const [error, stdout] = result;
          if (error && !allowFailure) reject(runtimeError("ANTIGRAVITY_KEYCHAIN_CONTEXT_UNAVAILABLE",
            "The macOS keychain context could not be prepared"));
          else resolve(error ? null : stdout);
        };
        child = execute(SECURITY_COMMAND, args, {
          encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin", LANG: "C" },
          maxBuffer: MAX_KEYCHAIN_OUTPUT_BYTES, stdio: ["ignore", "pipe", "pipe"],
          timeout: KEYCHAIN_COMMAND_TIMEOUT_MS, signal: options.signal,
        }, (error, stdout) => {
          result = [error, stdout]; finish();
        });
        returned = true;
        // Abort may report an error before the process exits. Do not release a
        // stopping host while its keychain command can still change the context.
        child?.once?.("close", () => { closed = true; finish(); });
        finish();
      });
      let result = output;
      if (read && output !== null) {
        try { result = parseKeychainPaths(output); }
        catch (error) { if (!allowFailure) throw error; result = null; }
      }
      step = steps.next(result);
    } catch (error) { step = steps.throw(error); }
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

// The ACP server is installed by the Antigravity sign-in. Models offers that
// sign-in once this Mac already uses Antigravity, shown by its `agy` command or
// its app; neither is executed. Its built-in Agent waits for the server.
function antigravityUsedOnThisMac(options = {}) {
  const fileSystem = options.fs || fs;
  const home = typeof options.homedir === "string" && path.isAbsolute(options.homedir) ? options.homedir : null;
  const pathValue = options.parentEnv?.PATH;
  const commands = [
    ...(typeof pathValue === "string" ? pathValue.split(path.delimiter).filter((entry) => path.isAbsolute(entry)) : []),
    ...(home ? [path.join(home, ".local", "bin")] : []),
    "/opt/homebrew/bin", "/usr/local/bin",
  ].map((directory) => path.join(directory, "agy"));
  if (commands.some((candidate) => executableRealpath(candidate, fileSystem))) return true;
  return ["/Applications", ...(home ? [path.join(home, "Applications")] : [])].some((directory) => {
    try { return fileSystem.statSync(path.join(directory, "Antigravity.app")).isDirectory(); } catch { return false; }
  });
}

// The Antigravity runtime executes Google's official ACP server installed by
// Shoggoth (see antigravity-acp-distribution.js); the agy CLI is not used.
function resolveAntigravityBinary(options = {}) {
  const fileSystem = options.fs || fs;
  if (options.binaryPath !== undefined) {
    return resolveAntigravityExecutable(options.binaryPath, {
      fs: fileSystem,
      code: "ANTIGRAVITY_BINARY_INVALID",
      message: "Antigravity binaryPath must be an absolute executable regular file",
    });
  }
  return resolveAntigravityAcpServer({ paths: options.paths, fs: fileSystem }).serverPath;
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

module.exports = {
  antigravityUsedOnThisMac,
  ANTIGRAVITY_RUNTIME,
  DEFAULT_ANTIGRAVITY_PERMISSION_POLICY,
  antigravityPermissionFingerprint,
  antigravityWorkspaceShardId,
  normalizeAntigravityPermissionPolicy,
  normalizeAntigravityWorkspace,
  prepareAntigravityKeychainContext,
  prepareAntigravityKeychainContextAsync,
  prepareAntigravityRuntimeAccountHome,
  resolveAntigravityBinary,
  resolveAntigravityExecutable,
};
