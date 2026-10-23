"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { resolveCanonicalServicePaths } = require("./agent-service/paths");
const { atomicWritePrivateFile, readPrivateFile } = require("./agent-service/private-file");

const MAX_BYTES = 16 * 1024;
const ROLES = new Set(["ui", "agent-service", "mcp", "mcp-crypto"]);
const NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AggregateError"]);
const CODES = new Set([
  "ENOENT", "EACCES", "EPERM", "ENOSPC", "EROFS", "EIO", "EEXIST", "ELOOP",
  "EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED", "ERR_UNHANDLED_REJECTION",
  "EADDRINUSE", "SQLITE_BUSY", "SQLITE_CORRUPT", "SQLITE_FULL", "SQLITE_READONLY",
  "SHOGGOTH_DATA_RESET_REQUIRED", "SERVICE_START_FAILED", "SERVICE_START_CANCELED",
  "STORE_CORRUPT_SNAPSHOT", "STORE_CORRUPT_EVENT_LOG", "STORE_COMMIT_UNCERTAIN",
  "MEMORY_NATIVE_OWNER_INVALID", "MEMORY_FRESH_HOME_REQUIRED", "MEMORY_TRANSACTION_UNSETTLED",
  "BOOTSTRAP_ROLE_REJECTED", "BOOTSTRAP_CODE_IDENTITY_TIMEOUT", "BOOTSTRAP_CODE_IDENTITY_INVALID",
  "BOOTSTRAP_MCP_START_FAILED", "MCP_HELPER_ARGUMENTS_INVALID", "MCP_HELPER_AUTH_FAILED", "MCP_HELPER_FAILED",
  "MCP_HELPER_SERVICE_UNAVAILABLE", "MCP_HELPER_SERVICE_RECOVERY_REQUIRED",
  // Why a runtime MCP gate or its Service bridge refused a helper (the cause of BOOTSTRAP_ROLE_REJECTED).
  "RUNTIME_MCP_GATE_ARGUMENTS_INVALID", "RUNTIME_MCP_GATE_PATHS_INVALID", "RUNTIME_MCP_GATE_MISSING",
  "RUNTIME_MCP_GATE_UNSAFE", "RUNTIME_MCP_GATE_INVALID", "RUNTIME_MCP_GATE_EXPIRED",
  "RUNTIME_MCP_GATE_PARENT_MISMATCH", "RUNTIME_MCP_GATE_REPLACED",
  "MCP_RELAY_CONTEXT_INVALID", "MCP_RELAY_OPTIONS_INVALID", "MCP_RELAY_SOCKET_INVALID",
  "MCP_RELAY_SOCKET_CHANGED", "MCP_RELAY_BRIDGE_FAILED", "MCP_RELAY_BRIDGE_TIMEOUT", "MCP_RELAY_ACK_INVALID",
]);

function validLocation(value) {
  return value && typeof value.file === "string"
    && /^[a-zA-Z0-9_./-]+\.(?:js|cjs)$/u.test(value.file)
    && !value.file.startsWith("/") && !value.file.split("/").includes("..")
    && value.file.length <= 256
    && Number.isSafeInteger(value.line) && value.line > 0 && value.line < 1_000_000
    && Number.isSafeInteger(value.column) && value.column > 0 && value.column < 1_000_000;
}

function summarizeBootstrapError(error, sourceRoot = __dirname) {
  const summaries = [];
  const seen = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object" || seen.has(value) || summaries.length >= 8) return;
    seen.add(value);
    const summary = {
      name: NAMES.has(value.name) ? value.name : "Error",
      code: CODES.has(value.code) ? value.code : "UNKNOWN_STARTUP_ERROR",
      locations: [],
    };
    // Persist trusted application source coordinates, never the message,
    // function arguments, absolute paths, or frames outside this application.
    for (const line of (typeof value.stack === "string" ? value.stack.slice(0, MAX_BYTES) : "").split("\n")) {
      if (!/^\s+at /u.test(line)) continue;
      const offset = line.lastIndexOf(`${sourceRoot}${path.sep}`);
      if (offset < 0) continue;
      const match = line.slice(offset + sourceRoot.length + 1).match(/^([a-zA-Z0-9_./-]+\.(?:js|cjs)):(\d+):(\d+)\)?$/u);
      if (!match) continue;
      const location = { file: match[1], line: Number(match[2]), column: Number(match[3]) };
      if (validLocation(location) && fs.existsSync(path.join(sourceRoot, location.file))) summary.locations.push(location);
      if (summary.locations.length >= 6) break;
    }
    summaries.push(summary);
    visit(value.cause);
    if (Array.isArray(value.errors)) for (const child of value.errors.slice(0, 8)) visit(child);
  };
  visit(error);
  return summaries;
}

function normalizeRecord(value, runtimeFailure = false) {
  if (!value || !ROLES.has(value.role) || !Number.isSafeInteger(value.timeMs) || value.timeMs < 0
    || !Array.isArray(value.errors) || value.errors.length > 8) return null;
  if (runtimeFailure && !["uncaughtException", "unhandledRejection"].includes(value.origin)) return null;
  return { timeMs: value.timeMs, role: value.role,
    ...(runtimeFailure ? { origin: value.origin } : {}), errors: value.errors.map((entry) => ({
    name: NAMES.has(entry?.name) ? entry.name : "Error",
    code: CODES.has(entry?.code) ? entry.code : runtimeFailure ? "UNKNOWN_RUNTIME_ERROR" : "UNKNOWN_STARTUP_ERROR",
    locations: Array.isArray(entry?.locations) ? entry.locations.filter(validLocation).slice(0, 6)
      .map(({ file, line, column }) => ({ file, line, column })) : [],
  })) };
}

function recordFailure(error, options, runtimeFailure = false) {
  try {
    const paths = options.paths || resolveCanonicalServicePaths();
    if (!path.isAbsolute(paths.runtimeDir || "") || !path.isAbsolute(paths.trustedRoot || "")) return false;
    const roleArgs = (options.argv || process.argv).filter((value) => typeof value === "string"
      && value.startsWith("--shoggoth-internal-role="));
    const role = runtimeFailure ? "agent-service"
      : roleArgs.length === 0 ? "ui" : roleArgs.length === 1 ? roleArgs[0].split("=")[1] : null;
    if (!ROLES.has(role)) return false;
    if (runtimeFailure && !["uncaughtException", "unhandledRejection"].includes(options.origin)) return false;
    const errors = summarizeBootstrapError(error, options.sourceRoot || __dirname).map((entry) => ({
      ...entry, code: runtimeFailure && entry.code === "UNKNOWN_STARTUP_ERROR" ? "UNKNOWN_RUNTIME_ERROR" : entry.code,
    }));
    if (!errors.length) return false;
    const target = path.join(paths.runtimeDir, runtimeFailure ? "service-process-failures.json" : "bootstrap-diagnostics.json");
    let records = [];
    try {
      const previous = JSON.parse(readPrivateFile(target, { maxBytes: MAX_BYTES }).toString("utf8"));
      if (previous?.version !== 1 || !Array.isArray(previous.records)) return false;
      records = previous.records.slice(-7).map((record) => normalizeRecord(record, runtimeFailure)).filter(Boolean);
    } catch (readError) {
      if (readError?.code !== "ENOENT") return false;
    }
    records.push({ timeMs: Date.now(), role, ...(runtimeFailure ? { origin: options.origin } : {}), errors });
    const body = `${JSON.stringify({ version: 1, records })}\n`;
    if (Buffer.byteLength(body) > MAX_BYTES) return false;
    atomicWritePrivateFile(target, body, { trustedRoot: paths.trustedRoot });
    return true;
  } catch {
    return false;
  }
}

function recordBootstrapFailure(error, options = {}) {
  return recordFailure(error, options);
}

function recordServiceProcessFailure(error, options = {}) {
  return recordFailure(error && typeof error === "object" ? error : new Error("Service process failure"), options, true);
}

module.exports = { recordBootstrapFailure, recordServiceProcessFailure, summarizeBootstrapError };
