"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validRuntimeProfileId } = require("./runtime-adapter");
const { serviceError } = require("./security");

const OPENCODE_RUNTIME = "opencode";
const MIN_OPENCODE_VERSION = Object.freeze([1, 18, 32]);
const VALID_APPROVAL_POLICIES = new Set(["untrusted", "on-failure", "on-request", "never"]);
const VALID_SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);

function error(code, message) { return serviceError(code, message); }

function resolveOpenCodeBinary(options = {}) {
  const fileSystem = options.fs || fs;
  const userHome = options.homedir || os.homedir();
  const parentEnv = options.parentEnv || process.env;
  const candidates = options.binaryPath !== undefined ? [options.binaryPath] : [
    ...String(parentEnv.PATH || "").split(path.delimiter).filter(path.isAbsolute)
      .map((entry) => path.join(entry, "opencode")),
    path.join(userHome, ".local", "bin", "opencode"),
    "/opt/homebrew/bin/opencode", "/usr/local/bin/opencode",
  ];
  for (const candidate of new Set(candidates)) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate) || candidate.includes("\0")) continue;
    try {
      const resolved = fileSystem.realpathSync(candidate);
      const stat = fileSystem.lstatSync(resolved);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      fileSystem.accessSync(resolved, fileSystem.constants.X_OK);
      return path.resolve(resolved);
    } catch {}
  }
  throw error(options.binaryPath === undefined ? "OPENCODE_BINARY_NOT_FOUND" : "OPENCODE_BINARY_INVALID",
    "OpenCode CLI executable is unavailable or unsafe");
}

function parseOpenCodeVersion(value) {
  const match = typeof value === "string" && value.length <= 1024
    ? value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u) : null;
  return match ? match.slice(1).map(Number) : null;
}

function supportsOpenCodeVersion(value) {
  const version = Array.isArray(value) ? value : parseOpenCodeVersion(value);
  if (!version || version.length !== 3 || !version.every(Number.isSafeInteger)) return false;
  if (version[0] !== MIN_OPENCODE_VERSION[0]) return false;
  for (let i = 0; i < 3; i += 1) {
    if (version[i] > MIN_OPENCODE_VERSION[i]) return true;
    if (version[i] < MIN_OPENCODE_VERSION[i]) return false;
  }
  return true;
}

function normalizeOpenCodeWorkspace(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.includes("\0") || !value.isWellFormed()
    || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw error("OPENCODE_WORKSPACE_INVALID", "OpenCode workspace must be canonical and absolute");
  }
  try {
    const real = fs.realpathSync(value);
    if (!fs.statSync(real).isDirectory()) throw new Error("not a directory");
    return real;
  } catch {
    throw error("OPENCODE_WORKSPACE_INVALID", "OpenCode workspace is unavailable or unsafe");
  }
}

function normalizeOpenCodePermissionPolicy(value = { approvalPolicy: "on-request", sandbox: "danger-full-access" }) {
  if (!value || !VALID_APPROVAL_POLICIES.has(value.approvalPolicy)
    || !VALID_SANDBOXES.has(value.sandbox)) {
    throw error("OPENCODE_PERMISSION_POLICY_INVALID", "OpenCode permission policy is invalid");
  }
  return Object.freeze({ approvalPolicy: value.approvalPolicy, sandbox: value.sandbox });
}

function openCodeWorkspaceShardId({ controlInstance = false, workspace = null } = {}) {
  return crypto.createHash("sha256").update(JSON.stringify([
    controlInstance ? "control" : "execution",
    controlInstance ? null : normalizeOpenCodeWorkspace(workspace),
  ])).digest("hex");
}

function assertOpenCodeProfileId(value) {
  if (!validRuntimeProfileId(value)) throw error("OPENCODE_RUNTIME_PROFILE_INVALID", "OpenCode profile id is invalid");
  return value;
}

module.exports = { OPENCODE_RUNTIME, assertOpenCodeProfileId, normalizeOpenCodePermissionPolicy,
  normalizeOpenCodeWorkspace, openCodeWorkspaceShardId, parseOpenCodeVersion,
  resolveOpenCodeBinary, supportsOpenCodeVersion };
