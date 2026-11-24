"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { validRuntimeProfileId } = require("./runtime-adapter");
const { serviceError } = require("./security");
const { resolveSystemCli } = require("./system-cli-discovery");

const OPENCODE_RUNTIME = "opencode";
const VALID_APPROVAL_POLICIES = new Set(["untrusted", "on-failure", "on-request", "never"]);
const VALID_SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);

function error(code, message) { return serviceError(code, message); }

function resolveOpenCodeBinary(options = {}) {
  return resolveSystemCli(OPENCODE_RUNTIME, options).binaryPath;
}

function parseOpenCodeVersion(value) {
  const match = typeof value === "string" && value.length <= 1024
    ? value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u) : null;
  return match ? match.slice(1).map(Number) : null;
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
  resolveOpenCodeBinary };
