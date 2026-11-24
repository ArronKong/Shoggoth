"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { serviceError } = require("./security");

const SYSTEM_CLI_DISCOVERY_METHOD = "runtime.cli.discover";
const SYSTEM_CLIS = Object.freeze({
  codex: {
    command: "codex",
    missing: ["CODEX_SYSTEM_BINARY_NOT_FOUND", "Codex is not installed or executable"],
    invalid: ["CODEX_RUNTIME_INVALID", "Codex binaryPath must be an absolute executable regular file"],
  },
  "grok-build": {
    command: "grok",
    missing: ["GROK_BUILD_BINARY_NOT_FOUND", "Grok Build executable was not found"],
    invalid: ["GROK_BUILD_BINARY_INVALID", "Grok Build binaryPath must be an absolute executable regular file"],
  },
  pi: {
    command: "pi",
    missing: ["PI_BINARY_NOT_FOUND", "Pi CLI executable was not found"],
    invalid: ["PI_BINARY_INVALID", "Pi binaryPath must be an absolute executable regular file"],
  },
  "claude-code": {
    command: "claude",
    missing: ["CLAUDE_CODE_BINARY_NOT_FOUND", "Claude Code CLI executable was not found"],
    invalid: ["CLAUDE_CODE_BINARY_INVALID", "Claude Code binaryPath must be an absolute executable regular file"],
  },
  opencode: {
    command: "opencode",
    vendorBin: [".opencode", "bin"],
    missing: ["OPENCODE_BINARY_NOT_FOUND", "OpenCode CLI executable is unavailable or unsafe"],
    invalid: ["OPENCODE_BINARY_INVALID", "OpenCode CLI executable is unavailable or unsafe"],
  },
  "deepseek-harness": {
    command: "dsh",
    missing: ["DEEPSEEK_HARNESS_BINARY_NOT_FOUND", "DeepSeek CLI executable was not found"],
    invalid: ["DEEPSEEK_HARNESS_BINARY_INVALID", "DeepSeek binaryPath must be an absolute executable regular file"],
  },
});
const SYSTEM_CLI_RUNTIMES = Object.freeze(Object.keys(SYSTEM_CLIS));
const SYSTEM_CLI_SOURCES = Object.freeze(["path", "user-bin", "system-bin", "vendor-bin", "explicit"]);

function isAbsoluteFilePath(value) {
  return typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");
}

function executableRealpath(candidate, fileSystem = fs) {
  if (!isAbsoluteFilePath(candidate)) return null;
  try {
    const resolved = fileSystem.realpathSync(candidate);
    if (!isAbsoluteFilePath(resolved)) return null;
    const stat = fileSystem.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    fileSystem.accessSync(resolved, fileSystem.constants.X_OK);
    return path.resolve(resolved);
  } catch {
    return null;
  }
}

function resolveSystemCli(runtime, options = {}) {
  if (!Object.hasOwn(SYSTEM_CLIS, runtime)) {
    throw serviceError("RUNTIME_ACCOUNT_UNSUPPORTED", "Runtime has no system CLI");
  }
  const { command, vendorBin, missing, invalid } = SYSTEM_CLIS[runtime];
  const fileSystem = options.fs || fs;
  const explicit = options.binaryPath;
  if (explicit !== undefined) {
    const binaryPath = executableRealpath(explicit, fileSystem);
    if (!binaryPath) throw serviceError(...invalid);
    return { binaryPath, candidatePath: path.resolve(explicit), source: "explicit" };
  }

  const parentEnv = options.parentEnv || process.env;
  const userHome = options.homedir || os.homedir();
  const directories = String(parentEnv.PATH || "").split(path.delimiter).filter(isAbsoluteFilePath)
    .map(directory => [directory, "path"]);
  if (isAbsoluteFilePath(userHome)) directories.push([path.join(userHome, ".local", "bin"), "user-bin"]);
  directories.push(["/opt/homebrew/bin", "system-bin"], ["/usr/local/bin", "system-bin"]);
  // New fallbacks follow existing candidates so discovery cannot switch a
  // working installation to another copy merely because of an app upgrade.
  if (vendorBin && isAbsoluteFilePath(userHome)) {
    directories.push([path.join(userHome, ...vendorBin), "vendor-bin"]);
  }
  const seen = new Set();
  for (const [directory, source] of directories) {
    const candidatePath = path.join(directory, command);
    if (seen.has(candidatePath)) continue;
    seen.add(candidatePath);
    const binaryPath = executableRealpath(candidatePath, fileSystem);
    if (binaryPath) return { binaryPath, candidatePath, source };
  }
  throw serviceError(...missing);
}

module.exports = {
  SYSTEM_CLI_DISCOVERY_METHOD, SYSTEM_CLI_RUNTIMES, SYSTEM_CLI_SOURCES,
  executableRealpath, resolveSystemCli,
};
