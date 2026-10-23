"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");

const MAX_RECORDS = 32;
const MAX_BYTES = 64 * 1024;
const OPERATIONS = new Set(["threadStart", "threadResume"]);
const PHASES = new Set(["request_schema", "rpc", "response_schema", "handle_request", "handle_response"]);
const LOCAL_CODES = new Set([
  "RUNTIME_PROTOCOL_INVALID", "RUNTIME_HANDLE_TERMINATED", "CODEX_SCHEMA_ERROR", "RPC_REMOTE_ERROR", "RPC_REQUEST_TIMEOUT", "RPC_REQUEST_ABORTED",
  "RPC_REQUEST_RETIRED", "RPC_TERMINATED", "RPC_PROCESS_EXITED", "RPC_PROCESS_ERROR",
  "RPC_STDIN_ERROR", "RPC_STDOUT_ERROR", "RPC_STDERR_ERROR", "RPC_STDOUT_ENDED",
  "RPC_STDIN_CLOSED", "RPC_WRITE_TIMEOUT", "RPC_WRITE_QUEUE_OVERFLOW",
  "RPC_PENDING_REQUEST_LIMIT", "RPC_SERIALIZE_FAILED", "RPC_OUTBOUND_FRAME_TOO_LARGE",
  "RPC_FRAME_TOO_LARGE", "RPC_MALFORMED_JSONL", "RPC_MALFORMED_UTF8", "RPC_MALFORMED_TAIL",
  "RPC_INVALID_MESSAGE", "RPC_INVALID_RESPONSE", "RPC_INVALID_RESPONSE_ID",
  "RPC_UNKNOWN_RESPONSE_ID", "RPC_DUPLICATE_RESPONSE", "RPC_NOTIFICATION_REJECTED",
  "RPC_SERVER_REQUEST_REJECTED", "UNKNOWN_LOCAL_ERROR",
]);
const REMOTE_CODES = new Set([
  "MCP_INITIALIZE_FAILED", "SESSION_NOT_FOUND", "SESSION_BUSY", "SESSION_WRITER_BUSY", "SESSION_ARCHIVED",
  "STORAGE_FULL", "STORAGE_READ_ONLY", "STORAGE_PERMISSION_DENIED", "HISTORY_READ_FAILED",
  "AUTHENTICATION_FAILED", "CONFIGURATION_INVALID", "REQUEST_INVALID", "UNKNOWN_REMOTE_ERROR",
]);
const STARTUP_CODES = new Set([
  "BOOTSTRAP_ROLE_REJECTED", "BOOTSTRAP_CODE_IDENTITY_TIMEOUT", "BOOTSTRAP_CODE_IDENTITY_INVALID",
  "BOOTSTRAP_MCP_START_FAILED", "MCP_HELPER_ARGUMENTS_INVALID", "MCP_HELPER_AUTH_FAILED",
  "MCP_HELPER_SERVICE_UNAVAILABLE", "MCP_HELPER_SERVICE_RECOVERY_REQUIRED",
  "MCP_HELPER_FAILED", "MCP_INITIALIZE_FAILED",
]);
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// Remote errors may include context, paths or credentials. Retain only a closed
// vocabulary; never persist the remote message or arbitrary error properties.
function classifyCodexSessionRemoteError(value) {
  const text = typeof value === "string" ? value.slice(0, 8192) : "";
  if (/required MCP servers failed to initialize|handshaking with MCP server failed|\b(?:BOOTSTRAP_[A-Z_]+|MCP_HELPER_[A-Z_]+)\b/iu.test(text)) return "MCP_INITIALIZE_FAILED";
  if (/no space left on device|disk (?:is )?full|\bENOSPC\b/iu.test(text)) return "STORAGE_FULL";
  if (/read.only file system|\bEROFS\b/iu.test(text)) return "STORAGE_READ_ONLY";
  if (/permission denied|operation not permitted|\b(?:EACCES|EPERM)\b/iu.test(text)) return "STORAGE_PERMISSION_DENIED";
  if (/no rollout found|(?:thread|session|rollout).{0,64}(?:not found|does not exist)/iu.test(text)) return "SESSION_NOT_FOUND";
  if (/\bthread\b.{0,80}\balready has an active writer\b/iu.test(text)) return "SESSION_WRITER_BUSY";
  if (/(?:thread|session).{0,64}(?:already running|is busy|active turn)/iu.test(text)) return "SESSION_BUSY";
  if (/(?:thread|session).{0,64}archived/iu.test(text)) return "SESSION_ARCHIVED";
  if (/(?:failed|unable) to (?:read|load|parse).{0,64}(?:history|rollout)|(?:history|rollout).{0,64}(?:corrupt|invalid)/iu.test(text)) return "HISTORY_READ_FAILED";
  if (/unauthorized|authentication failed|invalid (?:access )?token|login required/iu.test(text)) return "AUTHENTICATION_FAILED";
  if (/invalid (?:configuration|config)|(?:model provider|model_provider).{0,64}(?:invalid|not found|unknown)/iu.test(text)) return "CONFIGURATION_INVALID";
  if (/invalid (?:params|parameters|request)|unknown (?:field|variant)/iu.test(text)) return "REQUEST_INVALID";
  return "UNKNOWN_REMOTE_ERROR";
}

function normalizeRecord(value) {
  if (!value || !OPERATIONS.has(value.operation) || !PHASES.has(value.phase)
    || !Number.isSafeInteger(value.timeMs) || value.timeMs < 0
    || !LOCAL_CODES.has(value.errorCode)) return null;
  const record = { timeMs: value.timeMs, operation: value.operation, phase: value.phase, errorCode: value.errorCode };
  if (typeof value.bindingHash === "string" && /^[0-9a-f]{64}$/u.test(value.bindingHash)) record.bindingHash = value.bindingHash;
  if (typeof value.threadId === "string" && THREAD_ID.test(value.threadId)) record.threadId = value.threadId.toLowerCase();
  if (Number.isSafeInteger(value.instructionBytes) && value.instructionBytes >= 0 && value.instructionBytes <= 64 * 1024 * 1024) record.instructionBytes = value.instructionBytes;
  if (Number.isSafeInteger(value.rpcCode)) record.rpcCode = value.rpcCode;
  if (REMOTE_CODES.has(value.remoteClassification)) record.remoteClassification = value.remoteClassification;
  if (STARTUP_CODES.has(value.startupDiagnostic)) record.startupDiagnostic = value.startupDiagnostic;
  return record;
}

function bindingHash(binding) {
  if (!binding || binding.runtime !== "codex"
    || [binding.runtimeProfileId, binding.runtimeAccountId].some((value) => typeof value !== "string" || value.length > 256)) return undefined;
  return crypto.createHash("sha256").update(JSON.stringify([
    binding.runtime, binding.runtimeProfileId, binding.runtimeAccountId,
  ])).digest("hex");
}

function recordCodexSessionFailure({ paths, binding, operationName, params, phase, error }) {
  try {
    if (!paths || !path.isAbsolute(paths.runtimeDir || "") || !path.isAbsolute(paths.trustedRoot || "")) return false;
    const record = normalizeRecord({
      timeMs: Date.now(), operation: operationName, phase,
      errorCode: LOCAL_CODES.has(error?.code) ? error.code : "UNKNOWN_LOCAL_ERROR",
      bindingHash: bindingHash(binding), threadId: params?.threadId,
      instructionBytes: typeof params?.developerInstructions === "string"
        ? Buffer.byteLength(params.developerInstructions, "utf8") : undefined,
      rpcCode: error?.rpcCode, remoteClassification: error?.remoteClassification,
      startupDiagnostic: error?.startupDiagnostic,
    });
    if (!record) return false;
    const target = path.join(paths.runtimeDir, "codex-session-diagnostics.json");
    let records = [];
    try {
      const previous = JSON.parse(readPrivateFile(target, { maxBytes: MAX_BYTES }).toString("utf8"));
      if (previous?.version !== 1 || !Array.isArray(previous.records)) return false;
      records = previous.records.slice(-(MAX_RECORDS - 1)).map(normalizeRecord).filter(Boolean);
    } catch (readError) {
      if (readError?.code !== "ENOENT") return false;
    }
    records.push(record);
    atomicWritePrivateFile(target, `${JSON.stringify({ version: 1, records })}\n`, { trustedRoot: paths.trustedRoot });
    return true;
  } catch {
    // Diagnostics must not change the failure, cleanup, or retry semantics.
    return false;
  }
}

module.exports = { classifyCodexSessionRemoteError, recordCodexSessionFailure };
