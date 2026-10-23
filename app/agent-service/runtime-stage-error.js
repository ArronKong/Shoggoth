"use strict";
const { isRuntimeIncompatible } = require("./runtime-compatibility");

const STARTUP_STAGES = Object.freeze([
  "runtime_acquire",
  "runtime_authentication",
  "process_spawn",
  "bootstrap_role",
  "rpc_initialize",
  "mcp_initialize",
  "session_start_or_resume",
  "turn_start",
  "running",
]);
const FAILURE_STAGES = new Set(STARTUP_STAGES.filter((stage) => stage !== "running"));
const CODE_BY_STAGE = new Map([...FAILURE_STAGES].map((stage) => (
  [stage, `RUNTIME_START_${stage.toUpperCase()}_FAILED`]
)));
const STAGE_BY_CODE = new Map([...CODE_BY_STAGE].flatMap(([stage, code]) => [
  [code, stage],
  [`CODEX_START_${stage.toUpperCase()}_FAILED`, stage],
]));
STAGE_BY_CODE.set("RUNTIME_SESSION_WRITER_BUSY", "session_start_or_resume");
const RETRYABLE_PRE_TURN_STAGES = new Set([
  "runtime_acquire",
  "runtime_authentication",
  "process_spawn",
  "bootstrap_role",
  "rpc_initialize",
  "mcp_initialize",
  "session_start_or_resume",
]);
// A stage describes where a failure happened, not whether replay is safe.
// In particular, an unknown remote outcome must retain its deduplication fence.
const NON_RETRYABLE_START_CODES = new Set([
  "RUNTIME_INCOMPATIBLE",
  "PROACTIVE_RUNTIME_UNVERIFIED", "PROACTIVE_SCOPE_INVALID",
  "EXECUTION_CONTRACT_STALE",
  "AUTH_REQUIRED", "RUNTIME_AUTH_REQUIRED", "RUNTIME_ACCOUNT_BLOCKED",
  "RUNTIME_QUOTA_EXHAUSTED", "RUNTIME_SPENDING_LIMIT_REACHED",
  "RUNTIME_PERMISSION_REQUIRED", "RUNTIME_APPROVAL_UNAVAILABLE",
  "RUNTIME_SESSION_BUSY", "RUNTIME_SESSION_WRITER_BUSY", "RUNTIME_SESSION_ACCEPTANCE_UNKNOWN",
  "RUNTIME_TURN_ACCEPTANCE_UNKNOWN", "RUNTIME_TURN_OUTCOME_UNKNOWN",
  "RUNTIME_SESSION_RECOVERY_HISTORY_REQUIRED",
  "RUNTIME_MODEL_UNAVAILABLE", "RUNTIME_MODEL_SETTINGS_INVALID", "RUNTIME_MODEL_CATALOG_INVALID",
  "CODEX_ACCOUNT_PROTOCOL_INVALID", "CODEX_SCHEMA_ERROR", "RUNTIME_PROTOCOL_ERROR", "RUNTIME_OUTPUT_LIMIT_EXCEEDED",
  "GROK_ACP_OUTBOUND_FRAME_TOO_LARGE", "ANTIGRAVITY_ACP_OUTBOUND_FRAME_TOO_LARGE",
  "ANTIGRAVITY_NETWORK_UNAVAILABLE", "ANTIGRAVITY_REGION_UNSUPPORTED",
  "ANTIGRAVITY_ACP_NOT_INSTALLED", "ANTIGRAVITY_ACP_INTEGRITY_FAILED", "ANTIGRAVITY_ACP_PLATFORM_UNSUPPORTED",
]);
// A process-local WeakMap makes this a trusted adapter contract: remote JSON,
// stderr text, and arbitrary Error properties cannot forge account backoff.
const RUNTIME_ACCOUNT_RETRY_AT = new WeakMap();
// Only the native adapter can attest that a failed resume did not dispatch a
// turn. Never infer that from a remote error's fields or its stage alone.
const SESSION_RESUME_RETRY = new WeakMap();

function runtimeSessionResumeError(error, { retryable = false, preserveSession = true } = {}) {
  if (!error || (typeof error !== "object" && typeof error !== "function")
    || typeof retryable !== "boolean" || typeof preserveSession !== "boolean"
    || (retryable && error.code !== "ANTIGRAVITY_NETWORK_UNAVAILABLE")) {
    throw new TypeError("Runtime session resume retry metadata is invalid");
  }
  SESSION_RESUME_RETRY.set(error, { retryable, preserveSession });
  return error;
}

function runtimeSessionResumePreservesSession(error) {
  let current = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    try {
      if (SESSION_RESUME_RETRY.get(current)?.preserveSession === true) return true;
      current = Object.getOwnPropertyDescriptor(current, "cause")?.value ?? null;
    } catch { return false; }
  }
  return false;
}

function runtimeAccountBackoffError(error, retryAt) {
  if ((!error || (typeof error !== "object" && typeof error !== "function"))
    || !Number.isSafeInteger(retryAt) || retryAt < 0) {
    throw new TypeError("Runtime account backoff metadata is invalid");
  }
  RUNTIME_ACCOUNT_RETRY_AT.set(error, retryAt);
  return error;
}

function runtimeAccountRetryAt(error) {
  let current = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current !== "object" && typeof current !== "function") return null;
    const retryAt = RUNTIME_ACCOUNT_RETRY_AT.get(current);
    if (retryAt !== undefined) return retryAt;
    try {
      current = Object.getOwnPropertyDescriptor(current, "cause")?.value ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

function runtimeStageCode(stage) {
  const code = CODE_BY_STAGE.get(stage);
  if (!code) throw new TypeError(`Unknown Runtime startup stage: ${stage}`);
  return code;
}

function runtimeStageFromError(error) {
  if (error?.code === "RUNTIME_INCOMPATIBLE") {
    const stage = Object.getOwnPropertyDescriptor(error, "stage")?.value;
    return FAILURE_STAGES.has(stage) ? stage : null;
  }
  return STAGE_BY_CODE.get(error?.code) || null;
}

function runtimeOperationalError(error) {
  if (error?.code !== "AUTH_REQUIRED") return error;
  const normalized = new Error("RUNTIME_AUTH_REQUIRED");
  Object.defineProperty(normalized, "code", {
    value: "RUNTIME_AUTH_REQUIRED",
    enumerable: true,
  });
  return normalized;
}

function runtimeStageError(stage, cause = null) {
  const code = runtimeStageCode(stage);
  if (isRuntimeIncompatible(cause)) return Object.assign(new Error("RUNTIME_INCOMPATIBLE"), {
    code: "RUNTIME_INCOMPATIBLE", stage: runtimeStageFromError(cause) || stage,
  });
  const operational = runtimeOperationalError(cause);
  if (operational?.code === "RUNTIME_AUTH_REQUIRED" || operational?.code === "RUNTIME_SESSION_WRITER_BUSY" || runtimeStageFromError(operational)) {
    return operational;
  }
  // assigned Host 的终止通知拥有 durable 收敛权；不能把它改写成普通启动失败，
  // 否则正在排队的 Host-terminated handler 会被 starting→failed 抢先覆盖。
  if (cause?.code === "CODEX_RPC_TERMINATED") return cause;
  const error = new Error(code);
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  Object.defineProperty(error, "stage", { value: stage, enumerable: true });
  if (cause && (typeof cause === "object" || typeof cause === "function")) {
    Object.defineProperty(error, "cause", { value: cause });
  }
  return error;
}

function isRetryablePreTurnStageError(error) {
  if (isRuntimeIncompatible(error)) return false;
  if (!RETRYABLE_PRE_TURN_STAGES.has(runtimeStageFromError(error))
    || runtimeAccountRetryAt(error) !== null) return false;
  let current = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    try {
      const code = Object.getOwnPropertyDescriptor(current, "code")?.value;
      const resumeRetry = SESSION_RESUME_RETRY.get(current)?.retryable;
      if (resumeRetry === false) return false;
      const safeNetworkResume = resumeRetry === true
        && runtimeStageFromError(error) === "session_start_or_resume"
        && code === "ANTIGRAVITY_NETWORK_UNAVAILABLE";
      if (NON_RETRYABLE_START_CODES.has(code) && !safeNetworkResume) return false;
      current = Object.getOwnPropertyDescriptor(current, "cause")?.value ?? null;
    } catch {
      return false;
    }
  }
  return true;
}

module.exports = {
  STARTUP_STAGES,
  isRetryablePreTurnStageError,
  runtimeAccountBackoffError,
  runtimeAccountRetryAt,
  runtimeOperationalError,
  runtimeSessionResumeError,
  runtimeSessionResumePreservesSession,
  runtimeStageCode,
  runtimeStageError,
  runtimeStageFromError,
};
