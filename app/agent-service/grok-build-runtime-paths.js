"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");
const { validRuntimeProfileId } = require("./runtime-adapter");
const { executableRealpath, resolveSystemCli } = require("./system-cli-discovery");

const GROK_BUILD_RUNTIME = "grok-build";
const DEFAULT_GROK_BUILD_PERMISSION_POLICY = Object.freeze({
  approvalPolicy: "on-request",
  sandbox: "danger-full-access",
});
const SANDBOX_PROFILES = Object.freeze({
  "read-only": "read-only",
  "workspace-write": "workspace",
  "danger-full-access": "off",
});

function runtimeError(code, message) {
  return serviceError(code, message);
}

function prepareGrokBuildHome(paths, runtimeProfileId) {
  if (!validRuntimeProfileId(runtimeProfileId)) {
    throw runtimeError("GROK_BUILD_RUNTIME_PROFILE_INVALID", "Grok Build runtime profile id is invalid");
  }
  const profileId = runtimeProfileId;
  if (!paths || typeof paths.stateDir !== "string" || !path.isAbsolute(paths.stateDir)
    || typeof paths.trustedRoot !== "string" || !path.isAbsolute(paths.trustedRoot)) {
    throw runtimeError("GROK_BUILD_PATHS_INVALID", "Grok Build runtime paths are invalid");
  }
  const base = path.join(paths.stateDir, GROK_BUILD_RUNTIME);
  const grokHome = path.join(base, profileId);
  const relative = path.relative(base, grokHome);
  if (relative !== profileId || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw runtimeError(
      "GROK_BUILD_RUNTIME_PROFILE_INVALID",
      "Grok Build runtime profile path escapes its root",
    );
  }
  ensurePrivateDirectoryTree(paths.stateDir, paths.trustedRoot);
  ensurePrivateDirectoryTree(base, paths.trustedRoot);
  ensurePrivateDirectoryTree(grokHome, paths.trustedRoot);
  return grokHome;
}

function resolveGrokBuildExecutable(candidate, options = {}) {
  const fileSystem = options.fs || fs;
  if (typeof candidate !== "string" || !path.isAbsolute(candidate) || candidate.includes("\0")) {
    throw runtimeError(
      options.code || "GROK_BUILD_BINARY_INVALID",
      options.message || "Executable path must be absolute",
    );
  }
  const resolved = executableRealpath(candidate, fileSystem);
  if (!resolved) {
    throw runtimeError(
      options.code || "GROK_BUILD_BINARY_INVALID",
      options.message || "Executable is not an executable regular file",
    );
  }
  return resolved;
}

function resolveGrokBuildBinary(options = {}) {
  return resolveSystemCli(GROK_BUILD_RUNTIME, options).binaryPath;
}

function normalizeGrokBuildPermissionPolicy(value = DEFAULT_GROK_BUILD_PERMISSION_POLICY) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !new Set(["untrusted", "on-failure", "on-request", "never"]).has(value.approvalPolicy)
    || !Object.prototype.hasOwnProperty.call(SANDBOX_PROFILES, value.sandbox)) {
    throw runtimeError(
      "GROK_BUILD_PERMISSION_POLICY_INVALID",
      "Grok Build permission policy is invalid",
    );
  }
  return Object.freeze({
    approvalPolicy: value.approvalPolicy,
    sandbox: value.sandbox,
  });
}

function buildGrokBuildArgs(value, agentWorkspace = null) {
  const policy = normalizeGrokBuildPermissionPolicy(value);
  return Object.freeze([
    "--sandbox",
    SANDBOX_PROFILES[policy.sandbox],
    ...(agentWorkspace && policy.sandbox === "workspace-write" ? ["--add-dir", normalizeGrokBuildWorkspace(agentWorkspace)] : []),
    "agent",
    "--no-leader",
    "stdio",
  ]);
}

function grokBuildPermissionFingerprint(value) {
  const policy = normalizeGrokBuildPermissionPolicy(value);
  return JSON.stringify([policy.approvalPolicy, policy.sandbox]);
}

function normalizeGrokBuildWorkspace(value) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || !value.isWellFormed() || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw runtimeError("GROK_BUILD_WORKSPACE_INVALID", "Grok Build workspace must be canonical and absolute");
  }
  return value;
}

function grokBuildWorkspaceShardId({ controlInstance = false, workspace = null } = {}) {
  if (typeof controlInstance !== "boolean") {
    throw runtimeError("GROK_BUILD_WORKSPACE_INVALID", "Grok Build control instance flag is invalid");
  }
  const normalized = controlInstance ? null : normalizeGrokBuildWorkspace(workspace);
  return crypto.createHash("sha256").update(JSON.stringify([
    controlInstance ? "control" : "execution",
    normalized,
  ])).digest("hex");
}

module.exports = {
  DEFAULT_GROK_BUILD_PERMISSION_POLICY,
  GROK_BUILD_RUNTIME,
  buildGrokBuildArgs,
  grokBuildPermissionFingerprint,
  grokBuildWorkspaceShardId,
  normalizeGrokBuildPermissionPolicy,
  normalizeGrokBuildWorkspace,
  prepareGrokBuildHome,
  resolveGrokBuildBinary,
  resolveGrokBuildExecutable,
};
