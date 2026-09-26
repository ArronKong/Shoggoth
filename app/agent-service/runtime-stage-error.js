"use strict";

const STARTUP_STAGES = Object.freeze([
  "runtime_acquire",
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
const RETRYABLE_PRE_TURN_STAGES = new Set([
  "runtime_acquire",
  "process_spawn",
  "bootstrap_role",
  "rpc_initialize",
  "mcp_initialize",
  "session_start_or_resume",
]);
// A stage describes where a failure happened, not whether replay is safe.
// In particular, an unknown remote outcome must retain its deduplication fence.
const NON_RETRYABLE_START_CODES = new Set([
  "EXECUTION_CONTRACT_STALE",
  "AUTH_REQUIRED", "RUNTIME_AUTH_REQUIRED", "RUNTIME_ACCOUNT_BLOCKED",
  "RUNTIME_QUOTA_EXHAUSTED", "RUNTIME_SPENDING_LIMIT_REACHED",
  "RUNTIME_PERMISSION_REQUIRED", "RUNTIME_APPROVAL_UNAVAILABLE",
  "RUNTIME_SESSION_BUSY", "RUNTIME_SESSION_ACCEPTANCE_UNKNOWN",
  "RUNTIME_TURN_ACCEPTANCE_UNKNOWN", "RUNTIME_TURN_OUTCOME_UNKNOWN",
  "RUNTIME_SESSION_RECOVERY_HISTORY_REQUIRED",
  "RUNTIME_MODEL_UNAVAILABLE", "RUNTIME_MODEL_CATALOG_INVALID",
  "GROK_ACP_OUTBOUND_FRAME_TOO_LARGE",
  "ANTIGRAVITY_ONBOARDING_REQUIRED", "ANTIGRAVITY_APPROVAL_FORMAT_UNSUPPORTED",
  "ANTIGRAVITY_APPROVAL_CHANGED",
  "ANTIGRAVITY_APPROVAL_TIMEOUT", "ANTIGRAVITY_APPROVAL_RESPONSE_UNCONFIRMED",
  "ANTIGRAVITY_NETWORK_UNAVAILABLE", "ANTIGRAVITY_REGION_UNSUPPORTED", "ANTIGRAVITY_ELIGIBILITY_FAILED",
]);
// A process-local WeakMap makes this a trusted adapter contract: remote JSON,
// stderr text, and arbitrary Error properties cannot forge account backoff.
const RUNTIME_ACCOUNT_RETRY_AT = new WeakMap();

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
  const operational = runtimeOperationalError(cause);
  if (operational?.code === "RUNTIME_AUTH_REQUIRED" || runtimeStageFromError(operational)) {
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
  if (!RETRYABLE_PRE_TURN_STAGES.has(runtimeStageFromError(error))
    || runtimeAccountRetryAt(error) !== null) return false;
  let current = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    try {
      const code = Object.getOwnPropertyDescriptor(current, "code")?.value;
      if (NON_RETRYABLE_START_CODES.has(code)) return false;
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
  runtimeStageCode,
  runtimeStageError,
  runtimeStageFromError,
};
