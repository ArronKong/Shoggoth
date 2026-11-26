"use strict";

const { storageIssueCode } = require("../system-issue");

const AUTHENTICATION_MESSAGES = Object.freeze({
  MCP_HELPER_AUTH_FAILED: "Shoggoth MCP authentication was rejected",
  MCP_HELPER_CACHE_UNAVAILABLE: "The private MCP Helper cache could not be prepared",
  MCP_HELPER_STORAGE_FULL: "Local storage is full",
  MCP_HELPER_STORAGE_UNAVAILABLE: "MCP Helper cannot access its private local files",
  MCP_HELPER_CRYPTO_UNAVAILABLE: "The local MCP credential encryption service is unavailable",
  MCP_HELPER_SERVICE_UNAVAILABLE: "Shoggoth Service is unavailable",
  MCP_HELPER_SERVICE_RECOVERY_REQUIRED: "Shoggoth Service requires local recovery",
  MCP_HELPER_RESPONSE_INVALID: "Shoggoth Service returned an invalid MCP authentication response",
});

const MCP_HELPER_STARTUP_CODES = Object.freeze([
  "MCP_HELPER_ARGUMENTS_INVALID", "MCP_HELPER_FAILED", ...Object.keys(AUTHENTICATION_MESSAGES),
]);

// Order fixes the typed error status bytes (2–4) in the nonce-bound crypto worker response.
const MCP_AUTH_STORAGE_CODES = Object.freeze([
  "MCP_HELPER_STORAGE_UNAVAILABLE", "MCP_HELPER_STORAGE_FULL", "MCP_HELPER_CACHE_UNAVAILABLE",
]);
const MCP_DIAGNOSTIC_STAGES = Object.freeze({
  service: "mcp.service_request",
  credential: "mcp.credential_read",
  storage: "mcp.storage_setup",
  cache: "mcp.cache_setup",
  crypto: "mcp.crypto",
  bridge: "mcp.service_bridge",
});
// Keep the observed stage across sanitized error wrappers without adding it to
// the public error object or forwarding a raw exception across IPC.
const failureStages = new WeakMap();
function mcpFailureStage(error) { return failureStages.get(error); }
function markMcpFailureStage(error, cause, stage) {
  const observed = mcpFailureStage(cause) ?? (Object.hasOwn(MCP_DIAGNOSTIC_STAGES, stage) ? MCP_DIAGNOSTIC_STAGES[stage] : undefined);
  if (observed) failureStages.set(error, observed);
  return error;
}

const FILE_FAILURES = new Set([
  "EACCES", "EPERM", "EIO", "EROFS", "ENOTDIR", "EISDIR", "ELOOP", "EMFILE", "ENFILE",
  "UNSAFE_PATH", "UNSAFE_SYMLINK", "UNSAFE_OWNER", "UNSAFE_PERMISSIONS", "UNSAFE_HARDLINK", "UNSAFE_FILE_CHANGED",
  "MCP_AUTH_STORE_CORRUPT", "MCP_AUTH_NOT_INITIALIZED", "MCP_AUTH_COMMIT_UNCERTAIN",
  "MCP_AUTH_WRITE_FAILED", "MCP_AUTH_STORE_CAPACITY",
  "FEDERATION_MCP_AUTH_INVALID", "PRIVATE_FILE_TOO_LARGE",
]);

function ownErrorField(error, key) {
  try { return Object.getOwnPropertyDescriptor(error, key)?.value; } catch { return undefined; }
}

function mcpAuthStorageFailure(error, { missingIsStorage = false } = {}) {
  if (storageIssueCode(error) === "STORAGE_FULL") return "MCP_HELPER_STORAGE_FULL";
  for (let cause = error, depth = 0; cause && depth < 4; cause = ownErrorField(cause, "cause"), depth += 1) {
    const code = ownErrorField(cause, "code");
    if (MCP_AUTH_STORAGE_CODES.includes(code)) return code;
    if (FILE_FAILURES.has(code) || missingIsStorage && code === "ENOENT") return "MCP_HELPER_STORAGE_UNAVAILABLE";
  }
  return null;
}

module.exports = { AUTHENTICATION_MESSAGES, MCP_HELPER_STARTUP_CODES, MCP_AUTH_STORAGE_CODES, mcpAuthStorageFailure,
  MCP_DIAGNOSTIC_STAGES, mcpFailureStage, markMcpFailureStage };
