"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");

const MAX_RECORDS = 32;
const MAX_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const METHODS = new Set(["session/new", "session/resume", "session/set_config_option"]);
const LOCAL_CODES = new Set(["ANTIGRAVITY_ACP_REMOTE_ERROR", "ANTIGRAVITY_ACP_REQUEST_TIMEOUT",
  "ANTIGRAVITY_ACP_TERMINATED", "ANTIGRAVITY_ACP_STDIN_ERROR", "ANTIGRAVITY_ACP_STDIN_CLOSED",
  "AUTH_REQUIRED", "UNKNOWN_LOCAL_ERROR"]);
const REMOTE_CLASSES = new Set(["AUTHENTICATION_FAILED", "REGION_UNSUPPORTED", "MCP_INITIALIZE_FAILED",
  "QUOTA_EXHAUSTED", "STORAGE_FULL", "STORAGE_READ_ONLY", "STORAGE_PERMISSION_DENIED",
  "HISTORY_READ_FAILED", "SESSION_NOT_FOUND", "REQUEST_INVALID",
  "CERTIFICATE_INVALID", "TLS_EOF", "PROXY_CONNECTION_FAILED", "CONNECTION_FAILED", "DNS_FAILED",
  "CONNECT_TIMEOUT", "NETWORK_UNAVAILABLE", "UNKNOWN_REMOTE_ERROR"]);
const TRANSIENT_CLASSES = new Set(["TLS_EOF", "PROXY_CONNECTION_FAILED", "CONNECTION_FAILED", "DNS_FAILED",
  "CONNECT_TIMEOUT", "NETWORK_UNAVAILABLE"]);

// Inspect remote text only in memory. The persisted vocabulary is deliberately
// closed: URLs, prompts, credentials, workspaces and traceback text are dropped.
function classifyAntigravitySessionRemoteError(value) {
  const text = typeof value === "string" ? value.slice(0, 8192) : "";
  if (/authentication required|not authenticated|login required|credentials missing|invalid_grant|UNAUTHENTICATED|unauthorized/iu.test(text)) return "AUTHENTICATION_FAILED";
  if (/User location is not supported/iu.test(text)) return "REGION_UNSUPPORTED";
  if (/MCP load failed|BOOTSTRAP_[A-Z_]+|MCP_HELPER_[A-Z_]+/iu.test(text)) return "MCP_INITIALIZE_FAILED";
  if (/RESOURCE_EXHAUSTED|quota exhausted|rate.limit|spending.limit|\b429\b/iu.test(text)) return "QUOTA_EXHAUSTED";
  if (/no space left on device|disk (?:is )?full|\bENOSPC\b/iu.test(text)) return "STORAGE_FULL";
  if (/read.only file system|\bEROFS\b/iu.test(text)) return "STORAGE_READ_ONLY";
  if (/permission denied|operation not permitted|\bEACCES\b|\bEPERM\b/iu.test(text)) return "STORAGE_PERMISSION_DENIED";
  if (/(?:failed|unable) to (?:read|load|parse).{0,64}(?:history|conversation)|(?:history|conversation).{0,64}(?:corrupt|invalid)/iu.test(text)) return "HISTORY_READ_FAILED";
  if (/(?:session|conversation).{0,64}(?:not found|does not exist)/iu.test(text)) return "SESSION_NOT_FOUND";
  if (/invalid (?:params|parameters|request|configuration|config)|unknown (?:model|field|variant)|\bmodel\b.{0,40}(?:unavailable|unsupported|invalid|not found)/iu.test(text)) return "REQUEST_INVALID";
  if (/CERTIFICATE_VERIFY_FAILED|certificate verify failed|certificate.{0,40}(?:expired|invalid)|hostname mismatch/iu.test(text)) return "CERTIFICATE_INVALID";
  if (/SSLEOFError|EOF occurred in violation of protocol|SSL_ERROR_SYSCALL|TLS.{0,40}(?:EOF|closed)/iu.test(text)) return "TLS_EOF";
  if (/ProxyError|unable to connect to proxy/iu.test(text)) return "PROXY_CONNECTION_FAILED";
  if (/connection (?:reset|refused|closed)|ECONNRESET|ECONNREFUSED|ConnectionError/iu.test(text)) return "CONNECTION_FAILED";
  if (/no such host|Name or service not known|ENOTFOUND|EAI_AGAIN/iu.test(text)) return "DNS_FAILED";
  if (/connect(?:ion)? (?:timed out|timeout)|ConnectTimeout|TLS handshake.{0,40}(?:timed out|timeout)/iu.test(text)) return "CONNECT_TIMEOUT";
  if (/network issue|\bUNAVAILABLE\b/iu.test(text)) return "NETWORK_UNAVAILABLE";
  return "UNKNOWN_REMOTE_ERROR";
}

function isTransientAntigravitySessionError(classification) {
  return TRANSIENT_CLASSES.has(classification);
}

function normalizeRecord(value) {
  if (!value || !METHODS.has(value.method) || !["error", "resumed"].includes(value.outcome)
    || !Number.isSafeInteger(value.timeMs) || value.timeMs < 0
    || !Number.isSafeInteger(value.attempt) || value.attempt < 1 || value.attempt > 255) return null;
  const record = { timeMs: value.timeMs, method: value.method, outcome: value.outcome, attempt: value.attempt };
  if (typeof value.bindingHash === "string" && /^[a-f0-9]{64}$/u.test(value.bindingHash)) record.bindingHash = value.bindingHash;
  for (const key of ["sessionId", "executionRunId"]) if (typeof value[key] === "string" && UUID.test(value[key])) record[key] = value[key].toLowerCase();
  if (value.outcome === "error") {
    record.errorCode = LOCAL_CODES.has(value.errorCode) ? value.errorCode : "UNKNOWN_LOCAL_ERROR";
    record.remoteClassification = REMOTE_CLASSES.has(value.remoteClassification) ? value.remoteClassification : "UNKNOWN_REMOTE_ERROR";
    record.retryEligible = value.retryEligible === true;
    if (Number.isSafeInteger(value.rpcCode)) record.rpcCode = value.rpcCode;
  }
  return record;
}

function recordAntigravitySessionDiagnostic({ paths, binding, method, sessionId, executionRunId,
  attempt = 1, outcome = "error", error, remoteClassification, retryEligible = false }) {
  try {
    if (!path.isAbsolute(paths?.runtimeDir || "") || !path.isAbsolute(paths?.trustedRoot || "")) return false;
    const bindingHash = binding?.runtime === "antigravity"
      && [binding.runtimeProfileId, binding.runtimeAccountId].every(v => typeof v === "string" && v.length <= 256)
      ? crypto.createHash("sha256").update(JSON.stringify([binding.runtime, binding.runtimeProfileId, binding.runtimeAccountId])).digest("hex") : undefined;
    const record = normalizeRecord({ timeMs: Date.now(), bindingHash, method, sessionId, executionRunId, attempt,
      outcome, errorCode: error?.code, rpcCode: error?.rpcCode, remoteClassification, retryEligible });
    if (!record) return false;
    const target = path.join(paths.runtimeDir, "antigravity-session-diagnostics.json");
    let records = [];
    try {
      const previous = JSON.parse(readPrivateFile(target, { maxBytes: MAX_BYTES }).toString("utf8"));
      if (previous?.version !== 1 || !Array.isArray(previous.records)) return false;
      records = previous.records.slice(-(MAX_RECORDS - 1)).map(normalizeRecord).filter(Boolean);
    } catch (readError) { if (readError?.code !== "ENOENT") return false; }
    records.push(record);
    atomicWritePrivateFile(target, `${JSON.stringify({ version: 1, records })}\n`, { trustedRoot: paths.trustedRoot });
    return true;
  } catch { return false; } // Diagnostics must never change dispatch or cleanup.
}

module.exports = { classifyAntigravitySessionRemoteError, isTransientAntigravitySessionError, recordAntigravitySessionDiagnostic };
