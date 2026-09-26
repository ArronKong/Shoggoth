"use strict";

const crypto = require("node:crypto");
const { TextDecoder } = require("node:util");
const { inspirationUserText, inspirationUserAttachments } = require("../core/inspiration-chat-history");
const { validAttachments, attachmentFields } = require("./inspiration-media");
const { prepareChatAttachments, chatAttachmentDirectory, attachmentPrompt } = require("./chat-attachments");
const { createRunEventStream } = require("./run-event-stream");
const { domainOperationId, domainThreadSource } = require("./domain-work-run-executor");
const {
  shoggothProductDeveloperInstructions,
} = require("./product-capability-manifest");
const {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_PROMPT_TIMEOUT_MS,
  serverRequestUsesApprovalWait,
} = require("./interactive-timeouts");
const { CodexRuntimeAdapter } = require("./codex-runtime-adapter");
const { RuntimeMcpCallBindings, parseBindingElicitation } = require("./runtime-mcp-call-binding");
const { runtimeCommandUsesReservedHostCapability } = require("./runtime-host-command-policy");
const { startManualCompaction } = require("./runtime-manual-compaction");
const {
  STARTUP_STAGES,
  isRetryablePreTurnStageError,
  runtimeAccountRetryAt,
  runtimeOperationalError,
  runtimeStageCode,
  runtimeStageError,
  runtimeStageFromError,
} = require("./runtime-stage-error");
const { transcriptEventId } = require("./transcript-store");
const { SESSION_RUNTIME_PUBLIC_MESSAGES } = require("./session-runtime-protocol");
const { resolveRuntimePermissionMode } = require("./runtime-permission-modes");
const {
  validInteractiveApprovalChoice,
  validInteractiveApprovalOptions,
} = require("../core/shoggoth-interaction-contract");
const {
  canonicalFederationResultToolName,
  federationTaskResultFromOutput,
  serializeFederationTaskResult,
} = require("./federation-tool-identity");
const {
  assertRuntimeAdapter,
  readRuntimeAuthenticationState,
  runtimeBinding,
  runtimeSessionRef,
  runtimeTurnRef,
} = require("./runtime-adapter");

const ACTIVE_COMMAND_STATES = new Set(["pending", "dispatching"]);
const { validateRuntimeContextUsage, runtimeContextCapabilities,
  unknownRuntimeContextUsage } = require("./runtime-context-usage");
const ACTIVE_RUN_STATES = new Set(["starting", "running", "waiting_approval", "waiting_input"]);
const TERMINAL_RUN_STATES = new Set(["completed", "failed", "canceled", "interrupted", "skipped"]);
const MAX_THREAD_LIST_PAGES = 1_000;
const DEFAULT_MAX_RESULT_SUMMARY_BYTES = 4 * 1024;
const MAX_RESULT_SUMMARY_BYTES = 16 * 1024;
const DEFAULT_TERMINAL_RETRY_DELAYS_MS = Object.freeze([50, 100, 250, 500, 1_000]);
const MAX_TERMINAL_RETRIES = 8;
const MAX_TERMINAL_RETRY_DELAY_MS = 30_000;
const DEFAULT_MAX_TERMINAL_STREAMS = 128;
const MAX_TERMINAL_STREAMS = 2_048;
const DEFAULT_TERMINAL_STREAM_TTL_MS = 15 * 60 * 1_000;
const MAX_TERMINAL_STREAM_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_CONTROL_OPERATIONS = 1_024;
const MAX_CONTROL_MESSAGE_BYTES = 64 * 1024;
const MAX_PROMPT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_PENDING_REQUESTS = 100;
const MAX_SESSION_APPROVAL_SCOPES = 256;
const MAX_DOMAIN_EXECUTIONS = 8_192;
const MAX_DOMAIN_PROMPT_BYTES = 1024 * 1024;
const MAX_THREAD_SOURCE_BYTES = 256;
const MAX_TRUSTED_ACCOUNT_BACKOFF_MS = 366 * 24 * 60 * 60 * 1_000;
const MAX_TOOL_DISPLAY_ARGUMENT_BYTES = 768;
const MAX_TOOL_DISPLAY_RESULT_BYTES = 2 * 1024;
const MAX_TOOL_DISPLAY_SCAN_BYTES = 16 * 1024;
const MAX_FEDERATION_DISPLAY_RESULT_BYTES = 44 * 1024;
// A Run snapshot adds durable run metadata around the current interaction, and
// the Service federation ring adds profile/session routing around it again.
// Reserve headroom so a request that fits the RunEvent can still be recovered
// and projected after either stream resets.
const MAX_PUBLIC_INTERACTION_PAYLOAD_BYTES = 32 * 1024;
const TOOL_DISPLAY_ARGUMENT_KEYS = Object.freeze([
  "command", "cwd", "path", "file", "file_path", "filePath", "url", "query",
  "TargetFile", "target_file", "AbsolutePath", "CommandLine", "output_path", "output_file",
  "pattern", "name", "message", "title", "action", "operation", "id", "agentId",
  "sessionKey", "jobId", "cardId", "boardId", "skill", "tool", "limit", "count",
]);
const AUTHORITATIVE_RESET_STREAM_IDS = Object.freeze([
  "00000000-0000-4000-8000-000000000000",
  "00000000-0000-4000-8000-000000000001",
]);
const STABLE_SERVER_REQUEST_METHODS = Object.freeze([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "mcpServer/elicitation/request",
]);
const RUNTIME_AUTH_REQUIRED_CODE = "RUNTIME_AUTH_REQUIRED";
const CODEX_SETUP_ERROR_CODES = new Set([
  "CODEX_SYSTEM_BINARY_NOT_FOUND",
  "CODEX_RUNTIME_VERSION_MISMATCH",
  "CODEX_RUNTIME_VERSION_PROBE_FAILED",
  "CODEX_SCHEMA_ERROR",
]);
const PUBLIC_RUNTIME_OPERATIONAL_ERROR_CODES = new Set([
  "EXECUTION_CONTRACT_STALE",
  "RUNTIME_PROTOCOL_ERROR", "RUNTIME_CONNECTION_LOST",
  "RUNTIME_PERMISSION_REQUIRED",
  "RUNTIME_APPROVAL_UNAVAILABLE",
  "ANTIGRAVITY_ONBOARDING_REQUIRED",
  "ANTIGRAVITY_APPROVAL_FORMAT_UNSUPPORTED",
  "ANTIGRAVITY_APPROVAL_CHANGED",
  "ANTIGRAVITY_APPROVAL_TIMEOUT",
  "ANTIGRAVITY_APPROVAL_RESPONSE_UNCONFIRMED",
  "ANTIGRAVITY_NETWORK_UNAVAILABLE", "ANTIGRAVITY_REGION_UNSUPPORTED", "ANTIGRAVITY_ELIGIBILITY_FAILED", "ANTIGRAVITY_STARTUP_TIMEOUT",
  "RUNTIME_QUOTA_EXHAUSTED",
  "RUNTIME_RATE_LIMITED",
  "RUNTIME_SPENDING_LIMIT_REACHED",
  "RUNTIME_ACCOUNT_BLOCKED",
  "RUNTIME_UPSTREAM_UNAVAILABLE",
  "RUNTIME_SESSION_BUSY",
  "RUNTIME_SESSION_ACCEPTANCE_UNKNOWN",
  "RUNTIME_TURN_ACCEPTANCE_UNKNOWN",
  "RUNTIME_TURN_OUTCOME_UNKNOWN",
  "RUNTIME_SESSION_RECOVERY_HISTORY_REQUIRED",
  "RUNTIME_MODEL_CATALOG_UNAVAILABLE",
  "RUNTIME_MODEL_CATALOG_INVALID",
  "RUNTIME_MODEL_UNAVAILABLE",
  "GROK_ACP_OUTBOUND_FRAME_TOO_LARGE",
  "GROK_ACP_REQUEST_TIMEOUT",
  "GROK_ACP_WRITE_FAILED",
  "GROK_ACP_STDIN_CLOSED",
  "RUNTIME_REQUEST_NOT_SENT",
  "PI_TURN_TIMEOUT",
  "PI_PROCESS_CLOSED",
  "PI_RPC_STARTUP_TIMEOUT",
  "DEEPSEEK_HARNESS_REQUEST_TIMEOUT",
  "DEEPSEEK_HARNESS_STARTUP_TIMEOUT",
  "DEEPSEEK_HARNESS_PROCESS_CLOSED",
  "ANTIGRAVITY_TURN_TIMEOUT",
  "ANTIGRAVITY_PROCESS_EXIT_INVALID",
  "OPENCODE_TURN_TIMEOUT",
  "EXECUTION_BINDING_UNAVAILABLE",
  "RUNTIME_RECOVERY_UNAVAILABLE",
  ...CODEX_SETUP_ERROR_CODES,
]);
const SAFE_RUNTIME_CAUSE_CODES = new Map([
  ...["DEEPSEEK_HARNESS_PROTOCOL_UNSUPPORTED", "DEEPSEEK_HARNESS_RESPONSE_INVALID",
    "DEEPSEEK_HARNESS_MESSAGE_INVALID", "DEEPSEEK_HARNESS_FRAME_INVALID",
    "DEEPSEEK_HARNESS_FRAME_TRUNCATED", "DEEPSEEK_HARNESS_FRAME_TOO_LARGE",
    "DEEPSEEK_HARNESS_STREAM_TOO_LARGE", "PI_RPC_RESPONSE_INVALID", "PI_RPC_FRAME_INVALID",
    "PI_RPC_FRAME_TRUNCATED", "PI_RPC_FRAME_TOO_LARGE", "PI_RPC_STREAM_TOO_LARGE",
    "GROK_ACP_FRAME_TOO_LARGE", "GROK_ACP_INVALID_MESSAGE", "GROK_ACP_MALFORMED_JSONL",
    "GROK_ACP_MALFORMED_TAIL", "GROK_ACP_RESPONSE_INVALID", "ANTIGRAVITY_STREAM_EVENT_INVALID",
    "ANTIGRAVITY_TRANSCRIPT_INVALID", "RUNTIME_APPROVAL_RESPONSE_INVALID"].map((code) => [code, "RUNTIME_PROTOCOL_ERROR"]),
  ...["RUNTIME_MODEL_CATALOG_CHANGED", "RUNTIME_MODEL_CATALOG_IDENTITY_UNAVAILABLE"]
    .map((code) => [code, "RUNTIME_MODEL_CATALOG_UNAVAILABLE"]),
  ...["DEEPSEEK_HARNESS_WRITE_FAILED", "DEEPSEEK_HARNESS_TRANSPORT_FAILED",
    "DEEPSEEK_HARNESS_PROCESS_FAILED", "DEEPSEEK_HARNESS_RPC_CLOSED", "PI_RPC_WRITE_FAILED",
    "PI_RPC_FAILED", "PI_RPC_CLOSED", "PI_PROCESS_FAILED", "GROK_ACP_PROCESS_ERROR",
    "GROK_ACP_PROCESS_EXITED"].map((code) => [code, "RUNTIME_CONNECTION_LOST"]),
]);
const START_OPERATIONAL_ERROR_CODES = new Set([
  "EXECUTION_CONTRACT_STALE",
  "EXECUTION_BINDING_UNAVAILABLE",
  "AUTH_REQUIRED",
  RUNTIME_AUTH_REQUIRED_CODE,
  "RUNTIME_SESSION_RECOVERY_HISTORY_REQUIRED",
  "CODEX_RUNTIME_START_FAILED",
  "RPC_PROCESS_ERROR",
  "RPC_PROCESS_EXITED",
  "RPC_REMOTE_ERROR",
  "RPC_REQUEST_TIMEOUT",
  "RPC_STDIN_CLOSED",
  "RPC_STDOUT_ENDED",
  "RPC_TERMINATED",
  "RPC_WRITE_TIMEOUT",
  ...STARTUP_STAGES.filter((stage) => stage !== "running").map(runtimeStageCode),
  ...STARTUP_STAGES.filter((stage) => stage !== "running")
    .map((stage) => `CODEX_START_${stage.toUpperCase()}_FAILED`),
]);

function coordinatorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function ownDataErrorCode(error) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
      && typeof descriptor.value === "string" ? descriptor.value : null;
  } catch {
    return null;
  }
}

function publicRuntimeOperationalErrorCode(error) {
  let current = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const code = ownDataErrorCode(current);
    if (PUBLIC_RUNTIME_OPERATIONAL_ERROR_CODES.has(code)) return code;
    if (SAFE_RUNTIME_CAUSE_CODES.has(code)) return SAFE_RUNTIME_CAUSE_CODES.get(code);
    try {
      current = Object.getOwnPropertyDescriptor(current, "cause")?.value ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

function isRuntimeAuthRequired(error) {
  return ["AUTH_REQUIRED", RUNTIME_AUTH_REQUIRED_CODE].includes(ownDataErrorCode(error));
}

function isRuntimeSessionOwnershipError(error) {
  return String(ownDataErrorCode(error) || "").startsWith("RUNTIME_SESSION_");
}

function runtimeAuthRequiredError() {
  return runtimeOperationalError(
    coordinatorError("AUTH_REQUIRED", "Agent Runtime authentication is required"),
  );
}

function publicStartErrorCode(error) {
  if (isRuntimeAuthRequired(error)) return RUNTIME_AUTH_REQUIRED_CODE;
  const operationalCode = publicRuntimeOperationalErrorCode(error);
  if (operationalCode) return operationalCode;
  const code = ownDataErrorCode(error);
  return runtimeStageFromError(error) ? code : "RUNTIME_START_FAILED";
}

function failedTurnErrorCode(turn, fallback = "RUNTIME_TURN_FAILED") {
  if (["AUTH_REQUIRED", RUNTIME_AUTH_REQUIRED_CODE].includes(turn?.errorCode)
    || turn?.error?.codexErrorInfo === "unauthorized") {
    return RUNTIME_AUTH_REQUIRED_CODE;
  }
  if (turn?.error?.codexErrorInfo === "usageLimitExceeded") return "RUNTIME_QUOTA_EXHAUSTED";
  if (PUBLIC_RUNTIME_OPERATIONAL_ERROR_CODES.has(turn?.errorCode)) return turn.errorCode;
  if (SAFE_RUNTIME_CAUSE_CODES.has(turn?.errorCode)) return SAFE_RUNTIME_CAUSE_CODES.get(turn.errorCode);
  return fallback;
}

function requireMethods(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw coordinatorError(
      "WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED",
      `WorkRunCoordinator 需要 ${name}`,
    );
  }
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function runtimeSessionIdOf(value) {
  return value?.runtimeSessionRef?.sessionId
    ?? value?.runtimeSessionId
    ?? null;
}

function runtimeTurnIdOf(value) {
  return value?.runtimeTurnRef?.turnId ?? null;
}

function appSessionCommandRule(method, params) {
  if (method !== "item/commandExecution/requestApproval"
    || typeof params?.command !== "string") return null;
  const actionCommand = Array.isArray(params.commandActions)
    && params.commandActions.length === 1
    && typeof params.commandActions[0]?.command === "string"
    ? params.commandActions[0].command
    : params.command;
  const command = actionCommand.replace(
    /^export[ \t]+PATH=(?:"\$HOME\/\.local\/bin:(?:\/usr\/local\/bin:)?\$PATH"|'\$HOME\/\.local\/bin:(?:\/usr\/local\/bin:)?\$PATH')[ \t]*(?:;[ \t]*|\r?\n[ \t]*)/u,
    "",
  );
  return /^(?:ego-browser|\/Users\/[A-Za-z0-9._-]+\/\.local\/bin\/ego-browser)[ \t]+nodejs(?:[ \t\r\n]|$)/u
    .test(command) ? "ego-browser nodejs" : null;
}

function runtimeApprovalSupportsSession(method, params) {
  if (params?.sessionApprovalAvailable === false) return false;
  if (method === "item/permissions/requestApproval") return true;
  if (params?.sessionApprovalAvailable === true) return true;
  if (appSessionCommandRule(method, params)) return true;
  if (method === "item/commandExecution/requestApproval") {
    return params?.proposedExecpolicyAmendment !== null
      && params?.proposedExecpolicyAmendment !== undefined;
  }
  return method === "item/fileChange/requestApproval"
    && typeof params?.grantRoot === "string"
    && params.grantRoot.length > 0;
}

function methodIsPluginApproval(method) {
  return method === "shoggoth/pluginTool/requestApproval";
}

function validOpaqueId(value, maxLength = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function validControlMessage(value) {
  return typeof value === "string" && value.length > 0 && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= MAX_CONTROL_MESSAGE_BYTES;
}

function controlFingerprint(kind, input) {
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  };
  return crypto.createHash("sha256").update(JSON.stringify([kind, stable(input)])).digest("hex");
}

function bindingOperationId(operationId) {
  return `bind-${crypto.createHash("sha256").update(operationId).digest("hex").slice(0, 48)}`;
}

function runIdempotencyKey(operationId) {
  return `shoggoth:chat-send:${operationId}`;
}

function sendableSession(session) {
  return session && ["draft", "binding", "ready"].includes(session.status);
}

function definedProperties(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}

function plainRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function safeToolDisplayText(value, options, maxBytes, singleLine) {
  if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0")) return null;
  const scanValue = utf8Prefix(value, MAX_TOOL_DISPLAY_SCAN_BYTES);
  let sanitized;
  try {
    sanitized = options.sanitizeSummary(scanValue, Object.freeze({
      kind: "toolDisplay", runId: options.runId,
    }));
  } catch {
    return null;
  }
  if (consumeThenable(sanitized) || typeof sanitized !== "string") return null;
  const normalized = singleLine ? sanitized.replace(/\s+/gu, " ").trim() : sanitized.trim();
  if (!normalized) return null;
  try {
    const accepted = options.assertSecretSafe(
      { toolDisplay: normalized },
      Object.freeze({ kind: "toolDisplay", runId: options.runId }),
    );
    if (accepted === false || consumeThenable(accepted)) return null;
  } catch {
    return null;
  }
  return utf8Prefix(normalized, maxBytes);
}

function projectedFileChanges(value, options) {
  const source = Array.isArray(value) ? value : (plainRecord(value) && Array.isArray(value.changes) ? value.changes : null);
  if (!source) return null;
  const changes = source.slice(0, 8).map((change) => {
    if (!plainRecord(change)) return null;
    const path = safeToolDisplayText(
      change.path ?? change.file_path ?? change.filePath,
      options,
      MAX_TOOL_DISPLAY_ARGUMENT_BYTES,
      true,
    );
    const kind = safeToolDisplayText(change.kind, options, 64, true);
    return path ? definedProperties({ path, kind }) : null;
  }).filter(Boolean);
  if (!changes.length) return null;
  return {
    path: changes[0].path,
    changeCount: source.length,
    changes,
  };
}

function projectToolDisplayArgs(tool, options) {
  let input = tool.input;
  const identity = `${tool.name ?? ""} ${tool.kind ?? ""}`.toLowerCase();
  if (typeof input === "string" && /^[\s\r\n]*\{/u.test(input)) {
    try {
      const parsed = JSON.parse(input);
      if (plainRecord(parsed)) input = parsed;
    } catch {}
  }
  const fileChanges = identity.includes("filechange") ? projectedFileChanges(input, options) : null;
  if (fileChanges) return fileChanges;
  if (typeof input === "string") {
    const value = safeToolDisplayText(input, options, MAX_TOOL_DISPLAY_ARGUMENT_BYTES, true);
    if (!value) return undefined;
    const key = identity.includes("search") ? "query"
      : identity.includes("command") || identity.includes("exec") ? "command" : "summary";
    return { [key]: value };
  }
  if (Array.isArray(input)) return input.length > 0 ? { itemCount: input.length } : undefined;
  if (!plainRecord(input)) return undefined;
  const projected = {};
  if (identity.includes("search") && Array.isArray(input.queries)) {
    const queries = input.queries.filter((value) => typeof value === "string" && value.trim());
    if (queries.length > 0) {
      const query = safeToolDisplayText(
        queries.join(" · "), options, MAX_TOOL_DISPLAY_ARGUMENT_BYTES, true,
      );
      if (query) projected.query = query;
    }
  }
  for (const key of options.argumentKeys || TOOL_DISPLAY_ARGUMENT_KEYS) {
    const value = input[key];
    if (typeof value === "string") {
      const text = safeToolDisplayText(value, options, MAX_TOOL_DISPLAY_ARGUMENT_BYTES, true);
      if (text) projected[key] = text;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      projected[key] = value;
    } else if (typeof value === "boolean") {
      projected[key] = value;
    }
  }
  const nestedChanges = projectedFileChanges(input, options);
  if (nestedChanges) Object.assign(projected, nestedChanges);
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function toolOutputText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value.map((item) => {
      if (typeof item === "string") return item;
      if (!plainRecord(item)) return "";
      return typeof item.text === "string" ? item.text
        : typeof item.content === "string" ? item.content : toolOutputText(item.content);
    }).filter(Boolean).join("\n");
    return text || (value.length > 0 ? JSON.stringify({ itemCount: value.length }) : "");
  }
  if (!plainRecord(value)) return value === null || value === undefined ? "" : String(value);
  for (const key of ["summary", "message", "text", "output", "result", "error"]) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) {
    const content = toolOutputText(value.content);
    if (content) return content;
  }
  if (plainRecord(value.content)) {
    const content = toolOutputText(value.content);
    if (content) return content;
  }
  const summary = {};
  for (const key of ["title", "path", "url", "count"]) {
    if (["string", "number", "boolean"].includes(typeof value[key])) summary[key] = value[key];
  }
  return Object.keys(summary).length > 0 ? JSON.stringify(summary) : "";
}

function sanitizedFederationTaskResult(value, options) {
  const sanitize = (text) => {
    if (text === null) return null;
    // The production summary sanitizer intentionally rejects inputs above its
    // small scan budget. Federation task text is already bounded and the full
    // projected object is checked by assertSecretSafe below, so preserve long
    // text here instead of turning a successful peer reply into no message.
    if (Buffer.byteLength(text, "utf8") > MAX_TOOL_DISPLAY_SCAN_BYTES) return text;
    let sanitized;
    try {
      sanitized = options.sanitizeSummary(text, Object.freeze({
        kind: "toolDisplay", runId: options.runId,
      }));
    } catch {
      return undefined;
    }
    return typeof sanitized === "string" && sanitized.isWellFormed()
      && !sanitized.includes("\0") ? sanitized : undefined;
  };
  const backendId = sanitize(value.agent.backendId);
  const agentId = sanitize(value.agent.agentId);
  const name = sanitize(value.agent.name);
  const taskId = sanitize(value.task.taskId);
  const result = sanitize(value.task.result);
  const errorCode = sanitize(value.task.errorCode);
  if ([backendId, agentId, name, taskId, result, errorCode].includes(undefined)) return null;
  const projected = {
    agent: { backendId, agentId, name },
    task: { ...value.task, taskId, result, errorCode },
  };
  try {
    const accepted = options.assertSecretSafe(
      projected,
      Object.freeze({ kind: "toolDisplay", runId: options.runId }),
    );
    return accepted === false || consumeThenable(accepted) ? null : projected;
  } catch {
    return null;
  }
}

function publicToolDescriptor(tool, options) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return undefined;
  const displayArgs = projectToolDisplayArgs(tool, options);
  const name = options.toolNameOverride ?? tool.name;
  const outputText = toolOutputText(tool.output);
  const federationToolName = canonicalFederationResultToolName({ name });
  let resultSummary = null;
  if (federationToolName) {
    const parsed = federationTaskResultFromOutput(federationToolName, tool.output);
    const projected = parsed ? sanitizedFederationTaskResult(parsed, options) : null;
    resultSummary = projected
      ? serializeFederationTaskResult(projected, MAX_FEDERATION_DISPLAY_RESULT_BYTES) : null;
  } else if (outputText && !federationToolName) {
    resultSummary = safeToolDisplayText(
      outputText, options, MAX_TOOL_DISPLAY_RESULT_BYTES, false,
    );
  }
  return definedProperties({
    kind: tool.kind,
    name,
    status: tool.status,
    success: tool.success,
    exitCode: tool.exitCode,
    errorCode: tool.errorCode,
    displayArgs,
    resultSummary,
    pluginAppCallId: options.pluginAppCallId || undefined,
    durationMs: Number.isSafeInteger(options.durationMs) && options.durationMs > 0
      ? options.durationMs : undefined,
  });
}

function consumeThenable(value) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  const then = value.then;
  if (typeof then !== "function") return false;
  Promise.resolve(value).catch(() => {});
  return true;
}

function utf8Prefix(value, maxBytes) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return value;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 3); end -= 1) {
    try {
      return decoder.decode(encoded.subarray(0, end));
    } catch {}
  }
  return "";
}

function userMessageTurnIds(thread, operationId) {
  if (!thread || !Array.isArray(thread.turns)) {
    throw coordinatorError(
      "CODEX_THREAD_HISTORY_INCOMPLETE",
      "thread/read 未返回可对账的完整 turns",
    );
  }
  const ids = [];
  for (const turn of thread.turns) {
    if (!turn || typeof turn !== "object" || !Array.isArray(turn.items)) {
      throw coordinatorError(
        "CODEX_THREAD_HISTORY_INCOMPLETE",
        "thread/read 含不可对账的 turn",
      );
    }
    const matchingItems = turn.items.filter(
      (item) => item?.type === "userMessage" && item.clientId === operationId,
    );
    for (const _item of matchingItems) {
      if (typeof turn.id !== "string" || turn.id.length === 0) {
        throw coordinatorError("CODEX_THREAD_HISTORY_INCOMPLETE", "匹配的 turn 缺少 id");
      }
      ids.push(turn.id);
    }
  }
  if (ids.length > 1) {
    throw coordinatorError(
      "CODEX_CLIENT_MESSAGE_ID_CONFLICT",
      `clientUserMessageId ${operationId} 对应多个 turn`,
    );
  }
  return ids;
}

function assertHistoryCanProveAbsence(thread) {
  if (!thread || !Array.isArray(thread.turns)
    || thread.turns.some((turn) => (turn?.itemsView ?? "full") !== "full"
      || !Array.isArray(turn?.items))) {
    throw coordinatorError(
      "CODEX_THREAD_HISTORY_INCOMPLETE",
      "thread/read 不是 full history，禁止推断消息尚未发送",
    );
  }
}

class WorkRunCoordinator {
  constructor(options = {}) {
    requireMethods(options.dispatcher, [
      "enqueue", "admit", "transition", "getRun", "listRuns",
      "recoverActiveRunAfterServiceRestart",
    ], "WorkDispatcher");
    requireMethods(options.productStore, ["getAgentProfile"], "ProductStore");
    if (options.usageStore !== undefined) {
      requireMethods(options.usageStore, ["record"], "TokenUsageStore");
    }
    if (options.transcriptStore !== undefined) {
      requireMethods(options.transcriptStore, ["appendEvent"], "TranscriptStore");
    }
    if (options.onTranscriptCommitted !== undefined && typeof options.onTranscriptCommitted !== "function") {
      throw coordinatorError("WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED", "onTranscriptCommitted 必须是函数");
    }
    if (options.onRunTerminal !== undefined && typeof options.onRunTerminal !== "function") {
      throw coordinatorError("WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED", "onRunTerminal 必须是函数");
    }
    if (options.onRunInteraction !== undefined && typeof options.onRunInteraction !== "function") {
      throw coordinatorError(
        "WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED",
        "onRunInteraction 必须是函数",
      );
    }
    requireMethods(options.chatSessionStore, [
      "getSession", "requestBinding", "completeBinding", "recoverBinding", "listPendingBindings",
    ], "ChatSessionStore");
    requireMethods(options.inbox, ["enqueue", "get", "list", "transition"], "PendingCommandInbox");
    if (options.runtimeManager === undefined) {
      requireMethods(options.runtimePool, ["get"], "CodexRuntimePool");
    } else {
      assertRuntimeAdapter(options.runtimeManager);
    }
    if (options.runtimeAccountAdmission !== undefined) {
      requireMethods(
        options.runtimeAccountAdmission,
        ["admit", "release", "assertGeneration", "noteBackoff", "noteRateLimitBackoff"],
        "RuntimeAccountAdmission",
      );
    }
    if (options.runtimeSessionOwnershipStore !== undefined) {
      requireMethods(
        options.runtimeSessionOwnershipStore,
        ["claim", "assertOwned"],
        "RuntimeSessionOwnershipStore",
      );
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw coordinatorError("WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED", "now 必须是函数");
    }
    if (options.randomUUID !== undefined && typeof options.randomUUID !== "function") {
      throw coordinatorError("WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED", "randomUUID 必须是函数");
    }
    if (typeof options.assertSecretSafe !== "function"
      || typeof options.sanitizeSummary !== "function") {
      throw coordinatorError(
        "WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED",
        "WorkRunCoordinator 需要 secret-safe 与 summary sanitizer callback",
      );
    }
    if (options.contextCompiler !== undefined
      && (!options.contextCompiler || typeof options.contextCompiler.compile !== "function")) {
      throw coordinatorError(
        "WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED",
        "contextCompiler 必须提供 compile",
      );
    }
    if (options.productMcpApprovalPolicy !== undefined
      && (!options.productMcpApprovalPolicy
        || typeof options.productMcpApprovalPolicy.evaluate !== "function")) {
      throw coordinatorError(
        "WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED",
        "productMcpApprovalPolicy 必须提供 evaluate",
      );
    }
    if (options.maxResultSummaryBytes !== undefined
      && (!Number.isSafeInteger(options.maxResultSummaryBytes)
        || options.maxResultSummaryBytes <= 0
        || options.maxResultSummaryBytes > MAX_RESULT_SUMMARY_BYTES)) {
      throw coordinatorError(
        "WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED",
        `maxResultSummaryBytes 必须是 1..${MAX_RESULT_SUMMARY_BYTES} 的安全整数`,
      );
    }
    if (options.terminalRetryDelaysMs !== undefined
      && (!Array.isArray(options.terminalRetryDelaysMs)
        || options.terminalRetryDelaysMs.length > MAX_TERMINAL_RETRIES
        || options.terminalRetryDelaysMs.some((delay) => !Number.isSafeInteger(delay)
          || delay < 0 || delay > MAX_TERMINAL_RETRY_DELAY_MS))) {
      throw coordinatorError(
        "WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED",
        "terminalRetryDelaysMs 配置无效",
      );
    }
    if (options.terminalRetryScheduler !== undefined
      && (!options.terminalRetryScheduler
        || typeof options.terminalRetryScheduler !== "object"
        || typeof options.terminalRetryScheduler.set !== "function"
        || typeof options.terminalRetryScheduler.clear !== "function")) {
      throw coordinatorError(
        "WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED",
        "terminalRetryScheduler 配置无效",
      );
    }
    if (options.maxTerminalStreams !== undefined
      && (!Number.isSafeInteger(options.maxTerminalStreams)
        || options.maxTerminalStreams <= 0
        || options.maxTerminalStreams > MAX_TERMINAL_STREAMS)) {
      throw coordinatorError(
        "WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED",
        `maxTerminalStreams 必须是 1..${MAX_TERMINAL_STREAMS} 的安全整数`,
      );
    }
    if (options.terminalStreamTtlMs !== undefined
      && (!Number.isSafeInteger(options.terminalStreamTtlMs)
        || options.terminalStreamTtlMs <= 0
        || options.terminalStreamTtlMs > MAX_TERMINAL_STREAM_TTL_MS)) {
      throw coordinatorError(
        "WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED",
        `terminalStreamTtlMs 必须是 1..${MAX_TERMINAL_STREAM_TTL_MS} 的安全整数`,
      );
    }
    if (options.promptTimeoutMs !== undefined
      && (!Number.isSafeInteger(options.promptTimeoutMs)
        || options.promptTimeoutMs <= 0 || options.promptTimeoutMs > MAX_PROMPT_TIMEOUT_MS)) {
      throw coordinatorError(
        "WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED",
        `promptTimeoutMs 必须是 1..${MAX_PROMPT_TIMEOUT_MS} 的安全整数`,
      );
    }
    if (options.approvalTimeoutMs !== undefined && options.approvalTimeoutMs !== null
      && (!Number.isSafeInteger(options.approvalTimeoutMs)
        || options.approvalTimeoutMs <= 0 || options.approvalTimeoutMs > MAX_PROMPT_TIMEOUT_MS)) {
      throw coordinatorError(
        "WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED",
        `approvalTimeoutMs 必须是 null 或 1..${MAX_PROMPT_TIMEOUT_MS} 的安全整数`,
      );
    }
    if (options.promptScheduler !== undefined
      && (!options.promptScheduler || typeof options.promptScheduler !== "object"
        || typeof options.promptScheduler.set !== "function"
        || typeof options.promptScheduler.clear !== "function")) {
      throw coordinatorError(
        "WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED",
        "promptScheduler 配置无效",
      );
    }
    if (options.maxDomainExecutions !== undefined
      && (!Number.isSafeInteger(options.maxDomainExecutions)
        || options.maxDomainExecutions <= 0
        || options.maxDomainExecutions > MAX_DOMAIN_EXECUTIONS)) {
      throw coordinatorError(
        "WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED",
        `maxDomainExecutions 必须是 1..${MAX_DOMAIN_EXECUTIONS} 的安全整数`,
      );
    }
    if (options.recoverOrphanedDomainRuns !== undefined
      && typeof options.recoverOrphanedDomainRuns !== "boolean") {
      throw coordinatorError(
        "WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED",
        "recoverOrphanedDomainRuns 必须是布尔值",
      );
    }
    this.dispatcher = options.dispatcher;
    this.productStore = options.productStore;
    this.usageStore = options.usageStore || null;
    this.transcriptStore = options.transcriptStore || null;
    this.contextCompiler = options.contextCompiler || null;
    this.conversationCheckpointStore = options.conversationCheckpointStore || null;
    this.sourceConversationStore = options.sourceConversationStore || null;
    this.runtimeSelectionPolicyStore = options.runtimeSelectionPolicyStore || null;
    this.getCapabilityPolicyRevision = options.getCapabilityPolicyRevision || (() => null);
    this.sessionSendTails = new Map();
    this.onConversationRenewed = options.onConversationRenewed || (() => {});
    this.runExecutionStore = options.runExecutionStore || null;
    this.captureExecutionProviderRoute = options.captureExecutionProviderRoute || null;
    this.pluginRuntimeToolService = options.pluginRuntimeToolService || null;
    this.runtimeMcpCallBindings = new RuntimeMcpCallBindings({ now: options.now || Date.now });
    this.assertExecutionProviderRouteCurrent = options.assertExecutionProviderRouteCurrent || null;
    this.productMcpApprovalPolicy = options.productMcpApprovalPolicy || null;
    this.onTranscriptCommitted = options.onTranscriptCommitted || null;
    this.onRunTerminal = options.onRunTerminal || null;
    this.onRunInteraction = options.onRunInteraction || null;
    this.chatSessionStore = options.chatSessionStore;
    this.getMediaStore = options.getMediaStore;
    this.resolveRunSession = options.resolveRunSession || (() => null);
    this.inbox = options.inbox;
    this.runtimeManager = options.runtimeManager
      || new CodexRuntimeAdapter({ runtimePool: options.runtimePool });
    this.runtimeAccountAdmission = options.runtimeAccountAdmission || null;
    this.getNativeRuntimeConfig = options.getNativeRuntimeConfig || (() => null);
    this.startupGate = options.startupGate || null;
    this.startupControllers = new Map();
    this.pendingSessionSends = new Map();
    this.beforeSessionSend = options.beforeSessionSend || (() => {});
    this.onRuntimeMcpRequest = options.onRuntimeMcpRequest || null;
    this.followDefaultSessionBinding = options.followDefaultSessionBinding || null;
    this.manualCompactions = new Map();
    this.manualCompactionTimeoutMs = options.manualCompactionTimeoutMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.manualCompactionTimeoutMs)
      || this.manualCompactionTimeoutMs < 1 || this.manualCompactionTimeoutMs > 10 * 60_000) {
      throw coordinatorError("WORK_RUN_COORDINATOR_OPTIONS_INVALID", "Compaction timeout is invalid");
    }
    this.runtimeContextUsage = new Map();
    this.runtimeContextCache = options.runtimeContextCache || null;
    this.runtimeContextWindows = new Map();
    this.getRuntimeModelContextWindow = options.getRuntimeModelContextWindow || (() => null);
    this.getRuntimeModelContextLimits = options.getRuntimeModelContextLimits || (() => ({}));
    this.compactionTargets = new Map();
    this.contextRecoveryLimits = new Map();
    this.contextHandoffs = new Map();
    this.onRuntimeContextChanged = options.onRuntimeContextChanged || (() => {});
    this.startupReconcileTimeoutMs = options.startupReconcileTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.startupReconcileTimeoutMs)
      || this.startupReconcileTimeoutMs < 1 || this.startupReconcileTimeoutMs > 30_000) {
      throw coordinatorError("WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED", "启动对账超时配置无效");
    }
    this.runtimeSessionOwnershipStore = options.runtimeSessionOwnershipStore || null;
    this.now = options.now || Date.now;
    this.hostCapabilityIssuer = new (require("./host-capability-issuer").HostCapabilityIssuer)({ now: this.now });
    this.runCapabilityLeases = new Map();
    this.fairQueue = new (require("./runtime-fair-queue").RuntimeFairQueue)({ now: this.now });
    this.queueArrivalTimes = options.queueClock || new Map();
    this.telemetry = options.telemetry || new (require("./runtime-telemetry").RuntimeTelemetry)({ now: this.now });
    this.compactionBarriers = new Map();
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.assertSecretSafe = options.assertSecretSafe;
    this.sanitizeSummary = options.sanitizeSummary;
    this.maxResultSummaryBytes = options.maxResultSummaryBytes ?? DEFAULT_MAX_RESULT_SUMMARY_BYTES;
    this.terminalRetryDelaysMs = Object.freeze([
      ...(options.terminalRetryDelaysMs ?? DEFAULT_TERMINAL_RETRY_DELAYS_MS),
    ]);
    this.terminalRetryScheduler = options.terminalRetryScheduler || Object.freeze({
      set: (callback, delay) => setTimeout(callback, delay),
      clear: (handle) => clearTimeout(handle),
    });
    this.maxTerminalStreams = options.maxTerminalStreams ?? DEFAULT_MAX_TERMINAL_STREAMS;
    this.terminalStreamTtlMs = options.terminalStreamTtlMs ?? DEFAULT_TERMINAL_STREAM_TTL_MS;
    this.promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    this.approvalTimeoutMs = options.approvalTimeoutMs === undefined
      ? DEFAULT_APPROVAL_TIMEOUT_MS : options.approvalTimeoutMs;
    this.promptScheduler = options.promptScheduler || Object.freeze({
      set: (callback, delay) => setTimeout(callback, delay),
      clear: (handle) => clearTimeout(handle),
    });
    this.maxDomainExecutions = options.maxDomainExecutions ?? MAX_DOMAIN_EXECUTIONS;
    this.recoverOrphanedDomainRuns = options.recoverOrphanedDomainRuns === true;
    this.terminalRetentionClock = 0;
    this.state = "closed";
    this.admissionsQuiesced = false;
    this.everOpened = false;
    this.lifecycleGeneration = 0;
    this.runGenerations = new Map();
    this.runTails = new Map();
    this.lastErrors = new Map();
    this.runStreams = new Map();
    this.runQueueStates = new Map();
    this.admissionRetryTimer = null;
    this.terminalStreams = new Map();
    this.rehydratedTerminalStreams = new Set();
    this.terminalizingRuns = new Set();
    this.runContexts = new Map();
    this.runExecutionContracts = new Map();
    this.recoveringRuns = new Set();
    this.runAccountAdmissions = new Map();
    this.domainCommands = new Map();
    this.runHostAssignments = new Map();
    this.runPerformance = new Map();
    this.hostObservers = new Map();
    this.controlOperations = new Map();
    this.pendingRequests = new Map();
    this.terminalWaiters = new Map();
    this.terminalRetryWaiters = new Set();
    this.poisonError = null;
    this.openPromise = null;
    this.closePromise = null;
  }

  async open() {
    if (this.state === "open") return this;
    if (this.state === "opening") return this.openPromise;
    if (this.state === "closing" || this.everOpened) {
      throw coordinatorError("WORK_RUN_COORDINATOR_CLOSED", "WorkRunCoordinator 已关闭");
    }
    this.state = "opening";
    this.lifecycleGeneration += 1;
    this.everOpened = true;
    const generation = this.lifecycleGeneration;
    const opening = Promise.resolve().then(async () => {
      try {
        if (this.state !== "opening" || this.lifecycleGeneration !== generation) this.#assertOpen();
        const recoveries = this.inbox.isLocked?.() === true ? [] : await this.#recoverCommands();
        await Promise.allSettled(recoveries);
        if (this.poisonError) throw this.poisonError;
        if (this.state !== "opening" || this.lifecycleGeneration !== generation) this.#assertOpen();
        this.state = "open";
        if (this.openPromise === opening) this.openPromise = null;
        return this;
      } catch (error) {
        if (this.state !== "closed") {
          this.state = "closed";
          this.lifecycleGeneration += 1;
        }
        this.runContexts.clear();
        this.#releaseAllRuntimeAccountAdmissions();
        this.runExecutionContracts.clear();
        this.recoveringRuns.clear();
        this.domainCommands.clear();
        this.runHostAssignments.clear();
        this.runPerformance.clear();
        this.#cancelTerminalRetryWaiters();
        for (const observer of this.hostObservers.values()) {
          try { observer.unsubscribe(); } catch {}
          for (const unregister of observer.unregisterHandlers || []) {
            try { unregister(); } catch {}
          }
        }
        this.hostObservers.clear();
        this.controlOperations.clear();
        this.#cancelAllPendingRequests();
        this.#rejectTerminalWaiters(coordinatorError(
          "WORK_RUN_COORDINATOR_CLOSED",
          "WorkRunCoordinator open 失败",
        ));
        for (const stream of this.runStreams.values()) stream.close();
        this.runStreams.clear();
        this.runQueueStates.clear();
        clearTimeout(this.admissionRetryTimer);
        this.admissionRetryTimer = null;
        this.terminalStreams.clear();
        this.rehydratedTerminalStreams.clear();
        this.terminalizingRuns.clear();
        if (this.openPromise === opening) this.openPromise = null;
        throw error;
      }
    });
    this.openPromise = opening;
    return opening;
  }

  async close() {
    if (this.state === "closed") return;
    if (this.closePromise) return this.closePromise;
    this.state = "closing";
    this.runtimeMcpCallBindings.clear();
    this.runtimeContextUsage.clear();
    this.runtimeContextWindows.clear();
    this.compactionTargets.clear();
    this.contextRecoveryLimits.clear();
    this.contextHandoffs.clear();
    for (const controller of this.startupControllers.values()) controller.abort();
    this.lifecycleGeneration += 1;
    this.#cancelTerminalRetryWaiters();
    this.#cancelAllPendingRequests();
    this.#rejectTerminalWaiters(coordinatorError(
      "WORK_RUN_COORDINATOR_CLOSING",
      "WorkRunCoordinator 正在关闭",
    ));
    this.closePromise = (async () => {
      while (this.runTails.size > 0) {
        const tails = [...this.runTails.values()];
        await Promise.allSettled(tails);
      }
      const admissionReleaseErrors = this.#releaseAllRuntimeAccountAdmissions();
      this.state = "closed";
      this.runTails.clear();
      this.runGenerations.clear();
      this.lastErrors.clear();
      this.runContexts.clear();
      this.runExecutionContracts.clear();
      this.recoveringRuns.clear();
      this.domainCommands.clear();
      this.runHostAssignments.clear();
      this.runPerformance.clear();
      for (const observer of this.hostObservers.values()) {
        try { observer.unsubscribe(); } catch {}
        for (const unregister of observer.unregisterHandlers || []) {
          try { unregister(); } catch {}
        }
      }
      this.hostObservers.clear();
      this.controlOperations.clear();
      this.pendingRequests.clear();
      this.terminalWaiters.clear();
      for (const stream of this.runStreams.values()) stream.close();
      this.runStreams.clear();
      this.runQueueStates.clear();
      clearTimeout(this.admissionRetryTimer);
      this.admissionRetryTimer = null;
      this.terminalStreams.clear();
      this.rehydratedTerminalStreams.clear();
      this.terminalizingRuns.clear();
      if (admissionReleaseErrors.length > 0) {
        const error = new AggregateError(
          admissionReleaseErrors,
          "Runtime account admission release failed during Coordinator close",
        );
        error.code = "RUNTIME_ACCOUNT_ADMISSION_RELEASE_FAILED";
        throw error;
      }
    })();
    return this.closePromise;
  }

  async recover() {
    this.#assertOpen();
    this.#assertInboxAvailable();
    return this.#recoverCommands();
  }

  getRun(runId) {
    this.#assertOpen(true);
    return this.dispatcher.getRun(runId);
  }

  listRuns(query = {}) {
    this.#assertOpen(true);
    return this.dispatcher.listRuns(query);
  }

  nativeCapacitySnapshot() {
    const config = this.getNativeRuntimeConfig();
    const runs = this.dispatcher.listRuns();
    const queued = runs.filter((run) => run.status === "queued");
    const reasons = new Map();
    for (const run of queued) {
      const reason = this.runQueueStates.get(run.id)?.reason || "PENDING";
      reasons.set(reason, (reasons.get(reason) || 0) + 1);
    }
    return { revision: config.revision, maxActive: config.maxActive,
      startupConcurrency: config.startupConcurrency, enabled: config.flags.runtimeAdmissionV1,
      active: runs.filter((run) => ACTIVE_RUN_STATES.has(run.status)).length,
      queued: queued.length, byReason: [...reasons].map(([reason, count]) => ({ reason, count })) };
  }

  capacityChanged() {
    this.startupGate?.drain();
    if (!["opening", "open"].includes(this.state)) return;
    return this.#drainQueuedRuns(this.lifecycleGeneration);
  }

  getRuntimeContext(session) {
    const enabled = this.getNativeRuntimeConfig()?.flags?.runtimeContextLifecycleV1 === true;
    if (!enabled && !this.getNativeRuntimeConfig()?.flags?.runtimeConversationHandoff) return null;
    const profile = this.productStore.resolveAgentRuntimeProfile?.(session.profileId, session.runtimeBindingId ?? undefined)
      || this.productStore.getAgentProfile(session.profileId);
    if (!profile) return null;
    const sessionId = runtimeSessionIdOf(session);
    const cached = sessionId && this.runtimeContextUsage.get(this.#runtimeContextKey(session, profile));
    const restored = !cached && sessionId ? this.runtimeContextCache?.get(this.#runtimeContextKey(session, profile)) : null;
    const usage = sessionId ? cached?.usage || restored || unknownRuntimeContextUsage(sessionId, { observedAt: this.now() }) : null;
    const capabilities = runtimeContextCapabilities(profile.runtime);
    const summaryProfile = this.#summaryProfile(session);
    const checkpoint = this.conversationCheckpointStore?.compatible(session.profileId, session.id);
    const runs = this.listSessionRuns(session.sessionKey).filter(run => run.source === "compaction");
    const pending = runs.find(run => !TERMINAL_RUN_STATES.has(run.status));
    const last = runs.at(-1);
    return { contextCapabilities: capabilities, contextUsage: usage,
      ...(this.conversationCheckpointStore ? { productContext: {
        automatic: !enabled ? "disabled" : summaryProfile ? "enabled" : "unavailable",
        reason: !enabled ? "FEATURE_DISABLED" : summaryProfile ? null : "NO_TOOL_FREE_BINDING",
        summaryBindingId: summaryProfile?.selectedBindingId ?? summaryProfile?.defaultBindingId ?? null,
        summaryRuntime: summaryProfile?.runtime ?? null,
        summaryModel: summaryProfile?.selectedBindingId === session.runtimeBindingId
          ? session.modelOverride ?? summaryProfile.defaultModel : null,
        checkpointId: checkpoint?.id ?? null, coveredThroughSeq: checkpoint?.coveredThroughSeq ?? 0,
        pendingRunId: pending?.id ?? null, lastError: last?.status === "failed" || last?.status === "interrupted" ? last.errorCode ?? "COMPACTION_FAILED" : null,
        measurement: !capabilities["context.usage.exact"] && !capabilities["context.usage.estimated"] ? "unsupported"
          : !usage || usage.quality === "unknown" ? "missing" : this.now() - usage.observedAt > 5 * 60_000 ? "stale" : restored ? "restored" : "live",
        // A static capability is not evidence that the CLI's setting is enabled.
        nativeAuto: "unknown",
        budget: this.#conversationContextState(session, profile).budget,
        transfer: this.transcriptStore ? require("./context-transfer").readContextTransfer(this.transcriptStore,
          session, this.contextHandoffs.has(session.sessionKey)) : null,
      } } : {}) };
  }

  #contextConfigurationKey(session, profile) {
    const binding = this.productStore.getAgentRuntimeBinding?.(session.profileId, session.runtimeBindingId);
    const route = this.captureExecutionProviderRoute?.(profile, session.modelOverride ?? profile.defaultModel) ?? null;
    return crypto.createHash("sha256").update(JSON.stringify([binding?.revision ?? null,
      this.runtimeAccountAdmission?.read?.(profile.runtimeAccountId)?.generation ?? 0,
      profile.runtimeProfileId, session.modelSettings ?? null, route])).digest("hex");
  }

  #contextAttachmentReferences(attachments, sessionKey) {
    return attachments.map(attachment => {
      const media = this.getMediaStore?.();
      if (!media) return { ...attachment, unavailable: true };
      try { return prepareChatAttachments(media, [attachment], sessionKey)[0]; }
      catch (error) {
        if (/^UNSAFE_/u.test(error?.code || "")) throw error;
        return { ...attachment, unavailable: true };
      }
    });
  }

  #modelContextKey(session, profile) {
    const binding = this.productStore.getAgentRuntimeBinding?.(session.profileId, session.runtimeBindingId);
    return JSON.stringify(["model-window", session.profileId, session.id, session.runtimeBindingId,
      binding?.revision ?? null, profile.runtime, profile.runtimeAccountId, profile.runtimeProfileId,
      this.runtimeAccountAdmission?.read?.(profile.runtimeAccountId)?.generation ?? 0,
      session.modelOverride ?? profile.defaultModel ?? null, this.#contextConfigurationKey(session, profile)]);
  }

  #conversationContextState(session, resolvedProfile = null) {
    const { conversationContextBudget, validWindow, documentedModelWindow } = require("./conversation-context-budget");
    const profile = resolvedProfile || this.productStore.resolveAgentRuntimeProfile?.(session.profileId, session.runtimeBindingId)
      || this.productStore.getAgentProfile(session.profileId);
    const key = this.#runtimeContextKey(session, profile);
    const usage = runtimeSessionIdOf(session) ? this.runtimeContextUsage.get(key)?.usage || this.runtimeContextCache?.get(key) : null;
    const freshUsage = usage && usage.observedAt <= this.now() && this.now() - usage.observedAt <= 5 * 60_000 ? usage : null;
    const catalogWindow = this.getRuntimeModelContextWindow(session, profile);
    let window = freshUsage?.contextWindow, source = "runtime";
    if (validWindow(window) && validWindow(catalogWindow) && catalogWindow < window) {
      window = catalogWindow; source = "catalog";
    }
    if (!validWindow(window)) {
      window = catalogWindow; source = "catalog";
    }
    if (!validWindow(window)) {
      const modelKey = this.#modelContextKey(session, profile);
      const previous = this.runtimeContextWindows.get(modelKey) || this.runtimeContextCache?.get(modelKey);
      if (previous && ((session.modelOverride ?? profile.defaultModel)
        || previous.runtimeSessionId === runtimeSessionIdOf(session))
        && previous.observedAt <= this.now() && this.now() - previous.observedAt < 7 * 24 * 60 * 60_000) {
        window = previous.contextWindow; source = "last_observed";
      }
    }
    if (!validWindow(window)) {
      window = documentedModelWindow(profile.runtime, session.modelOverride ?? profile.defaultModel);
      source = "model_spec";
    }
    const recoveryKey = `rejected-window:${this.#modelContextKey(session, profile)}`;
    const recovery = this.contextRecoveryLimits.get(recoveryKey) || this.runtimeContextCache?.get(recoveryKey);
    if (recovery && recovery.observedAt <= this.now() && this.now() - recovery.observedAt < 7 * 24 * 60 * 60_000
      && validWindow(recovery.contextWindow) && (!validWindow(window) || recovery.contextWindow < window)) {
      window = recovery.contextWindow; source = recovery.source === "estimate" ? "fallback" : "last_observed";
    }
    return { budget: conversationContextBudget(window, source), limits: this.getRuntimeModelContextLimits(session, profile),
      // Only recent observations drive admission; older values remain display evidence.
      usage: freshUsage };
  }

  #planConversationCompaction(session, { force = false, requestPlan = null, currentOperationId = null } = {}) {
    const { budget, usage } = this.#conversationContextState(session);
    const profile = this.productStore.resolveAgentRuntimeProfile?.(session.profileId, session.runtimeBindingId)
      || this.productStore.getAgentProfile(session.profileId);
    const key = `${this.#modelContextKey(session, profile)}:${budget.tokens}`;
    const target = this.compactionTargets.get(session.sessionKey);
    const summaryProfile = this.#summaryProfile(session);
    const summarySession = summaryProfile && summaryProfile.selectedBindingId !== session.runtimeBindingId
      ? { ...session, runtimeSessionId: null, codexThreadId: null, modelOverride: null,
        runtimeBindingId: summaryProfile.selectedBindingId ?? summaryProfile.defaultBindingId } : session;
    const summaryState = summaryProfile ? this.#conversationContextState(summarySession, summaryProfile) : { budget, limits: {} };
    const previous = this.conversationCheckpointStore?.compatible(session.profileId, session.id);
    const summaryOverhead = 2048 + require("./conversation-context-budget").estimateContextTokens(JSON.stringify(previous?.summary ?? {}));
    const plan = require("./conversation-compaction").planConversationCompaction({ profileId: session.profileId,
      sessionId: session.id, transcriptStore: this.transcriptStore, checkpointStore: this.conversationCheckpointStore,
      budget, usage, force, freshSession: runtimeSessionIdOf(session) === null,
      targetThroughSeq: target?.key === key ? target.throughSeq : null, requestPlan, currentOperationId,
      maxSourceBytes: require("./context-request-budget").contextTransportLimits(summaryProfile?.runtime).summaryPromptBytes - 32 * 1024,
      maxSourceTokens: Math.max(0, require("./context-request-budget").inputTokenLimit(summaryState.budget, summaryState.limits) - summaryOverhead) });
    if (plan) {
      this.compactionTargets.set(session.sessionKey, { key, throughSeq: plan.targetThroughSeq });
      while (this.compactionTargets.size > 512) this.compactionTargets.delete(this.compactionTargets.keys().next().value);
    }
    else this.compactionTargets.delete(session.sessionKey);
    return plan;
  }

  #summaryProfile(session) {
    let profile = this.productStore.resolveAgentRuntimeProfile
      ? this.productStore.resolveAgentRuntimeProfile(session.profileId, session.runtimeBindingId)
      : this.productStore.getAgentProfile(session.profileId);
    const policy = this.runtimeSelectionPolicyStore?.get(session.profileId);
    const bindings = this.productStore.getAgentRuntimeBindings?.(session.profileId)?.bindings || [];
    const eligible = binding => binding.enabled && this.runtimeManager.canGenerateModelOnly?.(binding.runtime);
    const selected = policy?.compactionBindingId ? bindings.find(binding => binding.id === policy.compactionBindingId && eligible(binding))
      : bindings.find(binding => binding.id === session.runtimeBindingId && eligible(binding)) || bindings.find(eligible);
    if (selected) profile = this.productStore.resolveAgentRuntimeProfile(session.profileId, selected.id);
    return (!policy?.compactionBindingId || selected) && this.runtimeManager.canGenerateModelOnly?.(profile.runtime) ? profile : null;
  }

  #renewFromCheckpoint(session, checkpoint, excludingRunId = null) {
    if (checkpoint?.partial) return session;
    const provenance = checkpoint?.provenance;
    if (!provenance?.sourceNativeSessionId || runtimeSessionIdOf(session) !== provenance.sourceNativeSessionId
      || session.runtimeBindingId !== provenance.sourceBindingId || !this.chatSessionStore.switchRuntime
      || this.listSessionRuns(session.sessionKey).some(run => run.id !== excludingRunId && ACTIVE_RUN_STATES.has(run.status))) return session;
    const renewed = this.chatSessionStore.switchRuntime(session.sessionKey, { bindingId: session.runtimeBindingId,
      revision: session.revision, clearModelOverride: false, permissionMode: session.permissionMode ?? null });
    this.onConversationRenewed({ profileId: session.profileId, sessionKey: session.sessionKey });
    return renewed;
  }

  #refreshCheckpointSession(session) {
    const invalidation = this.conversationCheckpointStore.invalidation?.(session.profileId, session.id,
      runtimeSessionIdOf(session), session.runtimeBindingId);
    if (invalidation && invalidation.nativeSessionId === runtimeSessionIdOf(session)
      && invalidation.bindingId === session.runtimeBindingId
      && !this.listSessionRuns(session.sessionKey).some(run => ACTIVE_RUN_STATES.has(run.status))) {
      session = this.chatSessionStore.switchRuntime(session.sessionKey, { bindingId: session.runtimeBindingId,
        revision: session.revision, clearModelOverride: false, permissionMode: session.permissionMode ?? null });
      this.onConversationRenewed({ profileId: session.profileId, sessionKey: session.sessionKey });
    }
    return this.#renewFromCheckpoint(session, this.conversationCheckpointStore.compatible(session.profileId, session.id));
  }

  async compactConversation({ sessionKey, operationId }) {
    this.#assertOpen();
    const session = this.chatSessionStore.getSession(sessionKey);
    if (!session) throw coordinatorError("CHAT_SESSION_NOT_FOUND", "会话不存在");
    if (this.isSessionBusy(sessionKey)) throw coordinatorError("SESSION_BUSY", "会话仍有任务");
    if (!this.getNativeRuntimeConfig()?.flags?.runtimeContextLifecycleV1) throw coordinatorError("PRODUCT_CONTEXT_DISABLED", "产品级上下文管理未启用");
    if (!this.#summaryProfile(session)) throw coordinatorError("PRODUCT_CONTEXT_UNAVAILABLE", "未配置可生成摘要的 Runtime");
    const run = await this.#prepareConversationCompaction(session, { force: true, operationId });
    return { runId: run?.id ?? null, status: !run ? "unchanged" : run.status === "starting" ? "running"
      : ["queued", "running", "completed"].includes(run.status) ? run.status : "failed" };
  }

  #runtimeContextKey(session, resolvedProfile = null) {
    if (!session) return null;
    const profile = resolvedProfile
      || this.productStore.resolveAgentRuntimeProfile?.(session.profileId, session.runtimeBindingId ?? undefined)
      || this.productStore.getAgentProfile(session.profileId);
    if (!profile) return null;
    return JSON.stringify([session.profileId, session.runtimeBindingId ?? null,
      profile.runtime || "codex", profile.runtimeAccountId ?? null, runtimeSessionIdOf(session),
      session.modelOverride ?? profile.defaultModel ?? null, this.#contextConfigurationKey(session, profile)]);
  }

  hasActiveRuntimeWork(runtimeProfileId, runtimeAccountId, runId) {
    if (!runId || this.poisonError || !["opening", "open"].includes(this.state)) return false;
    const run = this.dispatcher.getRun(runId);
    const contract = this.runExecutionContracts.get(runId);
    try { this.hostCapabilityIssuer.assert(this.runCapabilityLeases.get(runId), { kind: "mcp" }); }
    catch { return false; }
    return !!run && ACTIVE_RUN_STATES.has(run.status) && !!contract
      && contract.runtimeProfileId === runtimeProfileId && contract.runtimeAccountId === runtimeAccountId;
  }

  async invokeRuntimeCapability({ runtimeProfileId, runtimeAccountId, runId, kind = "mcp" }, action) {
    if (!this.hasActiveRuntimeWork(runtimeProfileId, runtimeAccountId, runId)) {
      throw coordinatorError("HOST_CAPABILITY_REVOKED", "执行权限租约已失效");
    }
    const lease = this.runCapabilityLeases.get(runId);
    const scope = { kind, identity: { runId, runtimeAccountId } };
    return this.hostCapabilityIssuer.invoke(lease, scope, signal => action({ signal, runId,
      assertCurrent: () => this.hostCapabilityIssuer.assert(lease, scope) }));
  }

  // Legacy Codex MCP helpers have an authenticated Profile, but no trusted Run
  // in their tool arguments. Consume the separately routed app-server proof.
  async invokeBoundRuntimeMcpCall(input, action) {
    this.#assertOpen();
    const bound = this.runtimeMcpCallBindings.consume(input);
    return this.invokeRuntimeCapability({ runtimeProfileId: input.runtimeProfileId,
      runtimeAccountId: input.runtimeAccountId, runId: bound.runId,
      kind: input.name === "artifact_publish" ? "artifact" : "mcp" }, scope => {
      bound.assertCurrent();
      return action({ ...scope, assertCurrent() { bound.assertCurrent(); return scope.assertCurrent(); } });
    });
  }

  // Service-only entry point: never registered as a Runtime method or IPC call.
  // The Runtime supplies tool arguments, but cannot create this approval record.
  async requestPluginToolApproval(input) {
    this.#assertOpen();
    if (!input || typeof input.assertCurrent !== "function"
      || !validOpaqueId(input.runId) || !validOpaqueId(input.profileId)
      || typeof input.toolName !== "string" || !input.toolName || input.toolName.length > 128
      || typeof input.packageName !== "string" || !input.packageName || input.packageName.length > 256
      || !input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments)) {
      throw coordinatorError("CAPABILITY_FORBIDDEN", "插件调用审批参数无效");
    }
    input.assertCurrent();
    const run = this.dispatcher.getRun(input.runId);
    const assignment = this.runHostAssignments.get(input.runId);
    const context = this.runContexts.get(input.runId);
    if (!run || run.profileId !== input.profileId || run.status !== "running"
      || !assignment || !context || assignment.host !== context.host
      || assignment.generation !== context.generation
      || assignment.lifecycle !== this.lifecycleGeneration) {
      throw coordinatorError("HOST_CAPABILITY_REVOKED", "插件调用执行已失效");
    }
    let serialized;
    try { serialized = JSON.stringify(input.arguments); } catch {}
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 12 * 1024) {
      throw coordinatorError("MCP_TOOL_CAPACITY", "逐次审批参数超过完整展示上限");
    }
    this.hostCapabilityIssuer.assert(this.runCapabilityLeases.get(run.id), {
      kind: "approval", sessionId: context.threadId, turnId: context.turnId,
    });
    const result = await this.#requestInteraction({ host: assignment.host,
      method: "shoggoth/pluginTool/requestApproval", runId: run.id, context, assignment,
      requestContext: { signal: input.signal },
      approvalTimeoutMs: this.approvalTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
      params: { toolName: `插件工具 · ${input.toolName}`, toolInput: structuredClone(input.arguments),
        // Existing approval cards render this preformatted field in full;
        // their selected argument summary alone is insufficient for consent.
        command: serialized,
        reason: `${input.packageName} 请求调用插件工具 ${input.toolName}。仅允许以下参数执行一次。`,
        sessionApprovalAvailable: false,
        approvalOptions: [{ choice: "once", label: "允许一次", kind: "allow_once" },
          { choice: "deny", label: "拒绝", kind: "reject_once" }] },
    });
    input.assertCurrent();
    if (this.runHostAssignments.get(run.id) !== assignment
      || this.runContexts.get(run.id) !== context) {
      throw coordinatorError("HOST_CAPABILITY_REVOKED", "插件调用审批所属执行已变化");
    }
    return Object.freeze({ approved: result?.decision === "accept" });
  }

  isRuntimeHostIdle(binding, host, excludingRunId = null) {
    if (this.state !== "open" || this.poisonError) return false;
    for (const run of this.dispatcher.listRuns()) {
      if (run.id === excludingRunId) continue;
      if (!ACTIVE_RUN_STATES.has(run.status)) continue;
      const assignment = this.runHostAssignments.get(run.id);
      if (assignment?.host === host) return false;
      if (assignment) continue;
      const contract = this.runExecutionContracts.get(run.id);
      // Missing execution ownership cannot prove an entry idle.
      if (!contract || (contract.runtime === binding.runtime
        && contract.runtimeProfileId === binding.runtimeProfileId)) return false;
    }
    return true;
  }

  getRuntimeContextForSource(profileId, source, sourceId) {
    this.#assertOpen();
    if (!validOpaqueId(profileId) || !["chat", "kanban", "cron", "inspiration"].includes(source)
      || typeof sourceId !== "string" || sourceId.length === 0 || sourceId.length > 512
      || !sourceId.isWellFormed() || sourceId.includes("\0")) return null;
    const matches = this.dispatcher.listRuns({ source, sourceId }).filter(
      (candidate) => candidate.profileId === profileId && ACTIVE_RUN_STATES.has(candidate.status),
    );
    if (matches.length !== 1) return null;
    return this.#runtimeContextForRun(matches[0]);
  }

  #runtimeContextForRun(run) {
    const execution = this.runExecutionContracts.get(run.id);
    if (!execution || execution.runId !== run.id || execution.profileId !== run.profileId) return null;
    return Object.freeze({
      runId: run.id,
      profileId: run.profileId,
      source: run.source,
      sourceId: run.sourceId,
      profileDefaultModel: execution.profileDefaultModel,
      sessionModelOverride: execution.sessionModelOverride,
      effectiveModel: execution.defaultModel,
    });
  }

  getMemoryStats() {
    this.#assertOpen();
    this.#pruneTerminalStreams();
    return Object.freeze({
      runStreams: this.runStreams.size,
      terminalStreams: this.terminalStreams.size,
      rehydratedTerminalStreams: this.rehydratedTerminalStreams.size,
      runGenerations: this.runGenerations.size,
      runContexts: this.runContexts.size,
      runExecutionContracts: this.runExecutionContracts.size,
      runHostAssignments: this.runHostAssignments.size,
      controlOperations: this.controlOperations.size,
      pendingRequests: this.pendingRequests.size,
      domainCommands: this.domainCommands.size,
      terminalWaiters: this.terminalWaiters.size,
    });
  }

  steer(input) {
    this.#assertOpen();
    this.#assertInboxAvailable();
    if (!exactObject(input, ["operationId", "sessionKey", "runId", "message"])
      || !validOpaqueId(input.operationId) || !validOpaqueId(input.sessionKey)
      || (input.runId !== null && !validOpaqueId(input.runId))
      || !validControlMessage(input.message)) {
      throw coordinatorError("WORK_RUN_STEER_INVALID", "steer 输入无效");
    }
    const fingerprint = controlFingerprint("steer", input);
    return this.#idempotentControl(input.operationId, fingerprint, async () => {
      const initial = this.#selectChatRun(input.sessionKey, input.runId);
      return this.#chainRunTask(initial.id, async () => {
        const { run, assignment, context, token } = this.#activeAssignment(
          initial.id,
          input.sessionKey,
          "running",
        );
        requireMethods(assignment.host, ["turnSteer"], "RuntimeHandle turn steer");
        const response = await assignment.host.turnSteer({
          sessionId: context.threadId,
          turnId: context.turnId,
          operationId: input.operationId,
          message: input.message,
        });
        this.#fence(token);
        if (this.runHostAssignments.get(run.id) !== assignment
          || !this.hostObservers.has(assignment.host)
          || response?.turnId !== context.turnId) {
          throw coordinatorError("WORK_RUN_CONTROL_STALE", "turn/steer 返回后 Run binding 已变化");
        }
        // Steering is a real user message inside the active turn. Persist it only
        // after the Runtime accepts the control request so chat.history can retain
        // every instruction without recording rejected steering attempts.
        this.#appendTranscript(run.id, {
          id: transcriptEventId("chat-steer-user", input.operationId),
          kind: "user",
          content: { text: input.message, operationId: input.operationId, transcriptType: "steer" },
          runtimeRef: context.turnRef || null,
          contextExcluded: false,
          occurredAt: this.now(),
        });
        return Object.freeze({ accepted: true, runId: run.id, turnId: context.turnId });
      });
    });
  }

  abort(input) {
    this.#assertOpen();
    this.#assertInboxAvailable();
    if (!exactObject(input, ["operationId", "sessionKey", "runId"])
      || !validOpaqueId(input.operationId) || !validOpaqueId(input.sessionKey)
      || (input.runId !== null && !validOpaqueId(input.runId))) {
      throw coordinatorError("WORK_RUN_ABORT_INVALID", "abort 输入无效");
    }
    const fingerprint = controlFingerprint("abort", input);
    return this.#idempotentControl(input.operationId, fingerprint, async () => {
      const initial = this.#selectChatRun(input.sessionKey, input.runId, true);
      const compact = this.manualCompactions.get(initial.id);
      compact?.cancel();
      return this.#chainRunTask(initial.id, async () => {
        if (compact) this.#assertOpen();
        const current = this.dispatcher.getRun(initial.id);
        if (compact && TERMINAL_RUN_STATES.has(current?.status)) return current;
        if (current?.status === "queued") return this.#cancelQueuedChatRun(current);
        const { run, assignment, context, token } = this.#activeAssignment(
          initial.id,
          input.sessionKey,
        );
        requireMethods(assignment.host, ["turnInterrupt"], "RuntimeHandle turn interrupt");
        if (this.#settlePendingForAbort(run.id, assignment) > 0) {
          this.#fence(token);
          this.#interactiveTransition(run.id, "running", {});
          this.#fence(token);
        }
        await assignment.host.turnInterrupt({
          sessionId: context.threadId,
          turnId: context.turnId,
        });
        this.#fence(token);
        if (this.runHostAssignments.get(run.id) !== assignment
          || !this.hostObservers.has(assignment.host)) {
          throw coordinatorError("WORK_RUN_CONTROL_STALE", "turn/interrupt 返回后 Run binding 已变化");
        }
        return this.#cancelRunAfterInterrupt(run.id, token);
      });
    });
  }

  respondApproval(input) {
    this.#assertOpen();
    this.#assertInboxAvailable();
    if (!exactObject(input, ["operationId", "runId", "requestId", "choice"])
      || !validOpaqueId(input.operationId) || !validOpaqueId(input.runId)
      || !validOpaqueId(input.requestId)
      || !validInteractiveApprovalChoice(input.choice)) {
      throw coordinatorError("WORK_RUN_APPROVAL_RESPONSE_INVALID", "approval response 输入无效");
    }
    return this.#idempotentControl(
      input.operationId,
      controlFingerprint("approval", input),
      () => this.#chainRunTask(input.runId, () => this.#respondApproval(input)),
    );
  }

  respondInput(input) {
    this.#assertOpen();
    this.#assertInboxAvailable();
    const answersValid = input?.answers && typeof input.answers === "object"
      && !Array.isArray(input.answers) && Object.getPrototypeOf(input.answers) === Object.prototype
      && Object.keys(input.answers).length <= 32
      && Object.entries(input.answers).every(([key, value]) => validOpaqueId(key)
        && typeof value === "string" && value.isWellFormed() && !value.includes("\0")
        && Buffer.byteLength(value, "utf8") <= 16 * 1024);
    if (!exactObject(input, ["operationId", "runId", "requestId", "action", "answers"])
      || !validOpaqueId(input.operationId) || !validOpaqueId(input.runId)
      || !validOpaqueId(input.requestId) || !["submit", "cancel"].includes(input.action)
      || !answersValid || (input.action === "cancel" && Object.keys(input.answers).length !== 0)) {
      throw coordinatorError("WORK_RUN_INPUT_RESPONSE_INVALID", "input response 输入无效");
    }
    return this.#idempotentControl(
      input.operationId,
      controlFingerprint("input", input),
      () => this.#chainRunTask(input.runId, () => this.#respondInput(input)),
    );
  }

  subscribeRun(runId, cursor, listener) {
    this.#assertOpen();
    const run = this.dispatcher.getRun(runId);
    if (!run) {
      throw coordinatorError("WORK_RUN_NOT_FOUND", `WorkRun 不存在: ${runId}`);
    }
    const previousStream = this.runStreams.get(runId) || null;
    const stream = this.#streamFor(runId);
    if (TERMINAL_RUN_STATES.has(run.status) && previousStream !== stream) {
      this.rehydratedTerminalStreams.add(runId);
    }
    if (this.rehydratedTerminalStreams.has(runId)
      && exactObject(cursor, ["streamId", "afterSeq"])
      && cursor.streamId === null) {
      const resetStreamId = AUTHORITATIVE_RESET_STREAM_IDS.find(
        (candidate) => candidate !== stream.streamId,
      );
      const subscription = stream.subscribe({
        streamId: resetStreamId,
        afterSeq: cursor.afterSeq,
      }, listener);
      return Object.freeze({
        ...subscription,
        gap: Object.freeze({ ...subscription.gap, requestedStreamId: null }),
      });
    }
    return stream.subscribe(cursor, listener);
  }

  async #recoverCommands() {
    const lifecycle = this.lifecycleGeneration;
    // A model-only request has no resumable native turn. Never replay it after
    // a restart; a committed checkpoint is the only proof of completion.
    for (const run of this.dispatcher.listRuns().filter(item => item.source === "compaction"
      && !TERMINAL_RUN_STATES.has(item.status) && !this.runTails.has(item.id) && !this.domainCommands.has(item.id))) {
      const session = this.chatSessionStore.getSession(run.sourceId);
      const checkpoint = session && this.conversationCheckpointStore?.get(run.profileId, session.id);
      const completed = checkpoint?.provenance.runId === run.id;
      if (completed && run.status === "starting") this.dispatcher.transition(run.id, "running");
      const status = completed ? "completed" : run.status === "queued" ? "failed" : "interrupted";
      const errorCode = completed ? null : "COMPACTION_RECOVERY_UNAVAILABLE";
      this.dispatcher.transition(run.id, status, { errorCode });
      this.#appendTerminal(run.id, { status, resultSummary: null, errorCode, recovered: true });
      this.#releaseTerminalRun(run.id);
    }
    const terminalizingAtEntry = this.terminalizingRuns.size > 0;
    const commands = this.inbox.list().filter((command) => ACTIVE_COMMAND_STATES.has(command.state));
    const commandedRunIds = new Set(commands.map((command) => command.runId));
    const restoredDomains = [];
    if (this.runExecutionStore) {
      for (const run of this.dispatcher.listRuns()) {
        if (!ACTIVE_RUN_STATES.has(run.status)
          || this.runExecutionContracts.has(run.id) || this.runHostAssignments.has(run.id)
          || this.runTails.has(run.id)
          || (run.source === "chat" && !commandedRunIds.has(run.id))) continue;
        if (!["chat", "cron", "kanban", "inspiration"].includes(run.source)) continue;
        if (run.source !== "chat" && !this.recoverOrphanedDomainRuns) continue;
        try {
          if (await this.#restoreExecution(run, lifecycle) && run.source !== "chat") {
            restoredDomains.push(run.id);
          }
        } catch (error) {
          this.#fenceLifecycle(lifecycle);
          if (ACTIVE_RUN_STATES.has(this.dispatcher.getRun(run.id)?.status)
            && !this.terminalizingRuns.has(run.id) && !this.runHostAssignments.has(run.id)) {
            await this.#interruptForLostExecutionContract(run.id, lifecycle,
              error?.code === "EXECUTION_CONTRACT_STALE" ? "EXECUTION_CONTRACT_STALE" : "RUNTIME_RECOVERY_UNAVAILABLE");
          }
        }
      }
    }
    // Inbox 已成功解锁但找不到 active 命令时，starting Chat Run 无法证明 prompt、
    // operation 与远端绑定，继续保留只会永久占用 Profile 准入槽。
    for (const run of this.dispatcher.listRuns({ source: "chat" })) {
      if ((run.status === "starting" || (this.runExecutionStore && ACTIVE_RUN_STATES.has(run.status)))
        && !commandedRunIds.has(run.id) && !this.runExecutionContracts.has(run.id)) {
        await this.#interruptForLostExecutionContract(run.id, lifecycle);
      }
    }
    // Domain execution payload 与 execution contract 都是当前 Service lifecycle 的
    // 内存所有权；重启后无法证明旧 starting Run 对应的 prompt/thread 绑定。
    if (this.recoverOrphanedDomainRuns) {
      for (const run of this.dispatcher.listRuns()) {
        if ((run.status === "starting" || (this.runExecutionStore && ACTIVE_RUN_STATES.has(run.status)))
          && ["cron", "kanban", "inspiration"].includes(run.source)
          && !this.runExecutionContracts.has(run.id)) {
          await this.#interruptForLostExecutionContract(run.id, lifecycle);
        }
      }
    }
    const records = [];
    const recoveries = restoredDomains.map((runId) => this.#schedule(runId));
    for (const command of commands) {
      const session = this.chatSessionStore.getSession(command.sessionKey);
      if (!session) {
        throw coordinatorError(
          "CHAT_SESSION_NOT_FOUND",
          `PendingCommand 对应的 ChatSession 不存在: ${command.sessionKey}`,
        );
      }
      let run = this.dispatcher.getRun(command.runId)
        || this.#findRunByIdempotencyKey(runIdempotencyKey(command.operationId));
      if (!run) {
        run = this.dispatcher.enqueue(this.#runInput(command.runId, command.operationId, session));
      } else if (run.id !== command.runId) {
        throw coordinatorError(
          "WORK_RUN_COMMAND_ID_CONFLICT",
          `PendingCommand ${command.operationId} 的 runId 与幂等 WorkRun 不一致`,
        );
      }
      if (run.source !== "chat"
        || run.sourceId !== command.sessionKey
        || run.profileId !== session.profileId
        || run.idempotencyKey !== runIdempotencyKey(command.operationId)) {
        throw coordinatorError(
          "WORK_RUN_COMMAND_SOURCE_CONFLICT",
          `PendingCommand ${command.operationId} 与 chat WorkRun 身份不一致`,
        );
      }
      this.#streamFor(run.id);
      records.push({ command, run, session });
    }
    // 先收敛已持久化 terminal 的 crash cut，避免 queued run 越过 Inbox tombstone 提前准入。
    for (const record of records.filter(({ run }) => TERMINAL_RUN_STATES.has(run.status))) {
      const { command, run } = record;
      if (this.terminalizingRuns.has(run.id)) continue;
      await this.#withTerminalizing(run.id, async () => {
        try {
          this.#fenceLifecycle(lifecycle);
          this.#appendTerminal(run.id, {
            status: run.status,
            resultSummary: run.resultSummary ?? null,
            errorCode: run.errorCode ?? null,
            recovered: true,
          });
          this.#fenceLifecycle(lifecycle);
          await this.#completeActiveCommand(
            command.operationId,
            command,
            () => this.#fenceLifecycle(lifecycle),
          );
          this.#releaseTerminalRun(run.id);
        } catch (error) {
          if (!["WORK_RUN_COORDINATOR_CLOSING"].includes(error?.code)) this.#poison(error);
          throw error;
        }
      });
    }
    if (terminalizingAtEntry) return recoveries;
    for (const record of records.filter(({ run }) => !TERMINAL_RUN_STATES.has(run.status))) {
      const { command, session } = record;
      let { run } = record;
      if (run.status === "queued") {
        if (!sendableSession(session)) continue;
        if (command.state === "dispatching") {
          await this.inbox.transition(command.operationId, "pending");
        }
        const admission = this.#admit(run.id, session.profileId);
        if (admission.disposition === "rejected") {
          await this.#rejectAccountAdmission(run, admission.reason, lifecycle);
          continue;
        }
        run = admission.run;
        if (admission.disposition === "queued") continue;
      }
      if (ACTIVE_RUN_STATES.has(run.status) && !this.runExecutionContracts.has(run.id)
        && (run.status === "starting" || this.runExecutionStore)) {
        await this.#interruptForLostExecutionContract(run.id, lifecycle);
        continue;
      }
      if (run.status === "starting" || this.recoveringRuns.has(run.id)) recoveries.push(this.#schedule(run.id));
    }
    return recoveries;
  }

  async #restoreExecution(run, lifecycle) {
    const stored = await this.runExecutionStore.get(run);
    this.#fenceLifecycle(lifecycle);
    const current = this.dispatcher.getRun(run.id);
    if (!current || !ACTIVE_RUN_STATES.has(current.status) || this.terminalizingRuns.has(run.id)
      || this.runExecutionContracts.has(run.id) || this.runHostAssignments.has(run.id)
      || this.runTails.has(run.id)) return false;
    if (!stored) return false;
    const contract = stored.contract;
    const profile = this.productStore.resolveAgentRuntimeProfile
      ? this.productStore.resolveAgentRuntimeProfile(run.profileId, contract.bindingId)
      : this.productStore.getAgentProfile(run.profileId);
    if (this.assertExecutionProviderRouteCurrent) {
      if (stored.version !== 2) throw coordinatorError("EXECUTION_CONTRACT_STALE", "旧执行契约缺少可验证的 Provider 版本");
      this.assertExecutionProviderRouteCurrent(contract);
    }
    if (!profile || profile.enabled === false || (profile.runtime || "codex") !== contract.runtime
      || profile.runtimeProfileId !== contract.runtimeProfileId
      || profile.runtimeAccountId !== contract.runtimeAccountId
      || profile.permissionPolicy?.approvalPolicy !== contract.runtimeHostPermissionPolicy.approvalPolicy
      || profile.permissionPolicy?.sandbox !== contract.runtimeHostPermissionPolicy.sandbox) {
      throw coordinatorError("EXECUTION_BINDING_INVALID", "Runtime binding changed during restart");
    }
    if ((current.contextSnapshotId ?? null) !== (contract.contextSnapshotId ?? null)) {
      throw coordinatorError("EXECUTION_BINDING_INVALID", "Execution context changed during restart");
    }
    const sessionKey = this.getRunSessionKey(current);
    if (sessionKey) {
      const session = this.chatSessionStore.getSession(sessionKey);
      if (!session || session.profileId !== run.profileId) {
        throw coordinatorError("EXECUTION_BINDING_INVALID", "Execution session changed during restart");
      }
      const permission = resolveRuntimePermissionMode(contract.runtime, session.permissionMode, profile.permissionPolicy);
      if (permission.mode !== contract.permissionMode || permission.nativeMode !== contract.nativePermissionMode
        || permission.permissionPolicy.approvalPolicy !== contract.permissionPolicy.approvalPolicy
        || permission.permissionPolicy.sandbox !== contract.permissionPolicy.sandbox) {
        throw coordinatorError("EXECUTION_BINDING_INVALID", "Session permission changed during restart");
      }
    }
    const command = stored.command;
    if (run.source === "chat") {
      const active = this.#commandForRun(run);
      if (!active || active.operationId !== command.operationId
        || active.command.runId !== command.runId || active.command.sessionKey !== command.sessionKey
        || active.command.prompt !== command.prompt
        || JSON.stringify(active.command.attachments || []) !== JSON.stringify(command.attachments || [])) {
        throw coordinatorError("EXECUTION_BINDING_INVALID", "Chat command binding changed");
      }
    } else {
      const input = Object.fromEntries(["runId", "operationId", "prompt", "threadSource", "threadId"]
        .map((key) => [key, command[key]]));
      if (input.operationId !== domainOperationId(run)
        || ![domainThreadSource(run, "new"), ...(run.source === "cron" ? [domainThreadSource(run, "continue")] : [])]
          .includes(input.threadSource)
        || (input.threadId !== null && (run.source !== "cron"
          || input.threadSource !== domainThreadSource(run, "continue")))
        || command.fingerprint !== controlFingerprint("domain-execution", input)) {
        throw coordinatorError("EXECUTION_BINDING_INVALID", "Domain command binding changed");
      }
      if (command.conversationPolicy) {
        const { sourceConversationPolicy, sourcePolicyForRun } = require("./source-conversation-policy");
        const expected = run.source === "kanban" ? this.sourceConversationStore?.get(run.id)?.policy
          : sourcePolicyForRun(run, { threadPolicy: input.threadSource === domainThreadSource(run, "continue") ? "continue" : "new",
            sessionKey: run.source === "inspiration" ? this.getRunSessionKey(run) : null });
        if (!expected || JSON.stringify(sourceConversationPolicy(command.conversationPolicy)) !== JSON.stringify(expected)) {
          throw coordinatorError("EXECUTION_BINDING_INVALID", "Source conversation policy changed during restart");
        }
      }
      this.domainCommands.set(run.id, Object.freeze(structuredClone(command)));
    }
    const admission = this.runtimeAccountAdmission?.admit({ runtimeAccountId: contract.runtimeAccountId, runId: run.id, recovering: true });
    if (admission && admission.disposition !== "started") {
      throw coordinatorError("RUNTIME_RECOVERY_UNAVAILABLE", "Runtime account cannot be reacquired");
    }
    if (admission) this.runAccountAdmissions.set(run.id, Object.freeze({
      runtimeAccountId: contract.runtimeAccountId, generation: admission.generation,
    }));
    this.runExecutionContracts.set(run.id, Object.freeze({ ...contract, runtimeAccountGeneration: admission?.generation ?? null }));
    this.recoveringRuns.add(run.id);
    return true;
  }

  isSessionBusy(sessionKey, excludingRunId = null) {
    return (this.pendingSessionSends.get(sessionKey) || 0) > 0
      || this.listSessionRuns(sessionKey).some(run => run.id !== excludingRunId
        && (run.status === "queued" || ACTIVE_RUN_STATES.has(run.status)));
  }

  canSelectSessionBeforeSend(sessionKey) {
    return (this.pendingSessionSends.get(sessionKey) || 0) > 0
      && !this.listSessionRuns(sessionKey).some(run => run.status === "queued" || ACTIVE_RUN_STATES.has(run.status));
  }

  async prepareRuntimeHandoff(session, target, { model, clearModelOverride = false,
    permissionMode = null, excludingRunId = null, beforeSend = false } = {}) {
    if (!this.contextCompiler || !this.transcriptStore) return null;
    const key = session.sessionKey;
    if (!beforeSend && this.isSessionBusy(key, excludingRunId)) throw coordinatorError("SESSION_BUSY", "会话仍有任务");
    const reservation = this.pendingSessionSends.get(key) || 0;
    this.pendingSessionSends.set(key, reservation + 1);
    let receipt = { state: "preparing", targetBindingId: target.id, model: model ?? (clearModelOverride ? null : session.modelOverride ?? null),
      sourceRevision: this.transcriptStore.getRevision(session.profileId, session.id), snapshotId: null,
      sourceSessionRevision: session.revision,
      mode: "original", errorCode: null, updatedAt: this.now() };
    const record = value => {
      receipt = { ...receipt, ...value, updatedAt: this.now() };
      require("./context-transfer").recordContextTransfer(this.transcriptStore, session, receipt);
      this.onRuntimeContextChanged({ profileId: session.profileId, sessionKey: key });
    };
    this.contextHandoffs.set(key, receipt);
    try {
      record({});
      const shadow = { ...session, runtimeBindingId: target.id, runtimeSessionId: null, codexThreadId: null,
        status: "draft", permissionMode, modelOverride: model ?? (clearModelOverride ? null : session.modelOverride),
        retiredRuntimeSessions: [...(session.retiredRuntimeSessions || []), {
          runtime: this.productStore.resolveAgentRuntimeProfile(session.profileId, session.runtimeBindingId).runtime,
          runtimeSessionId: runtimeSessionIdOf(session), bindingId: session.runtimeBindingId,
        }] };
      const profile = this.productStore.resolveAgentRuntimeProfile(session.profileId, target.id);
      const targetConfiguration = this.#contextConfigurationKey(shadow, profile);
      const operationId = `handoff-preview-${session.revision}`;
      let previousCoverage = null;
      let transportLimited = false;
      for (let step = 0; step < 512; step++) {
        this.#assertOpen();
        if (this.chatSessionStore.getSession(key)?.revision !== session.revision) {
          throw coordinatorError("CHAT_SESSION_REVISION_CONFLICT", "准备期间会话已变化");
        }
        if (this.#contextConfigurationKey(shadow, profile) !== targetConfiguration) {
          throw coordinatorError("RUNTIME_SELECTION_POLICY_STALE", "准备期间目标 Runtime 配置已变化");
        }
        const state = this.#conversationContextState(shadow, profile);
        const snapshot = this.contextCompiler.compile({ profile,
          run: { id: operationId, source: "chat", sourceId: key, workspace: session.workspace },
          transcriptSessionId: session.id, query: "", contextLifecycleV1: true,
          currentOperationId: operationId, currentPrompt: "", currentAttachments: [],
          requestBudget: state.budget, contextLimits: state.limits, transcriptTokenBudget: state.budget.triggerTokens,
          freshSession: true, preview: true,
          resolveAttachments: attachments => this.#contextAttachmentReferences(attachments, key),
          handoffSeed: require("./runtime-handoff-seed").runtimeHandoffSeed(shadow, profile) });
        const request = snapshot.report.request;
        transportLimited ||= request.transportLimited || request.transportExceeded;
        if (request.fixedTokens > request.limitTokens || request.fixedTransportExceeded) throw coordinatorError("CONTEXT_INPUT_TOO_LARGE", "目标窗口无法容纳必需的指令与摘要");
        const canSummarize = this.getNativeRuntimeConfig()?.flags?.runtimeContextLifecycleV1 && this.#summaryProfile(shadow);
        const remaining = canSummarize ? this.#planConversationCompaction(shadow, { requestPlan: request, currentOperationId: operationId }) : null;
        if (!request.historyTruncated && !request.exceedsBudget && !request.transportExceeded && !remaining) {
          require("./context-request-budget").assertContextTransport({ runtime: profile.runtime, context: snapshot.dynamicContext });
          // Persist prepared material before the controller's revision-checked
          // binding commit. A crash before that commit leaves the old binding.
          const saved = this.contextCompiler.snapshotStore.create(snapshot);
          record({ state: "ready", snapshotId: saved.id, mode: request.completeness === "partial" ? "partial"
            : request.coverage > 0 ? transportLimited ? "transport_summary" : "summary" : "original" });
          return saved;
        }
        if (!canSummarize) {
          throw coordinatorError("CONTEXT_COMPACTION_REQUIRED", "目标窗口需要先摘要，但自动摘要不可用");
        }
        const coverage = this.conversationCheckpointStore?.compatible(session.profileId, session.id)?.id ?? "empty";
        if (coverage === previousCoverage) throw coordinatorError("PRODUCT_COMPACTION_FAILED", "摘要未能缩小目标输入，原会话已保留");
        previousCoverage = coverage;
        const summary = await this.#prepareConversationCompaction(shadow, { requestPlan: request, currentOperationId: operationId });
        if (!summary) throw coordinatorError("CONTEXT_COMPACTION_REQUIRED", "无法生成足够的迁移摘要");
        await this.waitForIdle(summary.id);
        const completed = this.dispatcher.getRun(summary.id);
        if (completed?.status !== "completed") throw coordinatorError(completed?.errorCode || "PRODUCT_COMPACTION_FAILED", "迁移摘要未完成，原会话已保留");
      }
      throw coordinatorError("PRODUCT_COMPACTION_FAILED", "迁移摘要未完成，原会话已保留");
    } catch (error) {
      if (this.state === "open") record({ state: "failed", errorCode: /^[A-Z][A-Z0-9_]+$/u.test(error?.code || "")
        ? error.code : "CONTEXT_HANDOFF_FAILED" });
      throw error;
    } finally {
      this.contextHandoffs.delete(key);
      const pending = (this.pendingSessionSends.get(key) || 1) - 1;
      if (pending) this.pendingSessionSends.set(key, pending); else this.pendingSessionSends.delete(key);
    }
  }

  async send(input) {
    const key = input?.sessionKey;
    this.pendingSessionSends.set(key, (this.pendingSessionSends.get(key) || 0) + 1);
    const previous = this.sessionSendTails.get(key) || Promise.resolve();
    const sending = previous.catch(() => {}).then(() => this.#send(input));
    this.sessionSendTails.set(key, sending);
    try {
      return await sending;
    } finally {
      if (this.sessionSendTails.get(key) === sending) this.sessionSendTails.delete(key);
      const left = this.pendingSessionSends.get(key) - 1;
      if (left) this.pendingSessionSends.set(key, left); else this.pendingSessionSends.delete(key);
    }
  }

  async #prepareConversationCompaction(session, { force = false, operationId = null, requestPlan = null, currentOperationId = null } = {}) {
    if (!this.conversationCheckpointStore || !this.transcriptStore
      || !this.getNativeRuntimeConfig()?.flags?.runtimeContextLifecycleV1 || !sendableSession(session)) return null;
    session = this.#refreshCheckpointSession(session);
    const profile = this.#summaryProfile(session);
    if (!profile) return null;
    const pending = this.listSessionRuns(session.sessionKey).find(run => run.source === "compaction"
      && !TERMINAL_RUN_STATES.has(run.status));
    if (pending) return pending;
    const lastSummary = this.listSessionRuns(session.sessionKey).filter(run => run.source === "compaction").at(-1);
    if (!operationId && lastSummary && ["MODEL_ONLY_ACCEPTANCE_UNKNOWN", "COMPACTION_RECOVERY_UNAVAILABLE"].includes(lastSummary.errorCode)) return lastSummary;
    const plan = this.#planConversationCompaction(session, { force, requestPlan, currentOperationId });
    if (!plan) return null;
    const id = `compaction-${crypto.createHash("sha256").update(JSON.stringify([profile.id, session.id,
      plan.previousId, plan.throughSeq, plan.coveredHash, operationId])).digest("hex")}`;
    const existing = this.dispatcher.getRun(id);
    // Failed/unknown attempts need an explicit retry with a new operation. A
    // repeated send must not bill another request for an unchanged prefix.
    if (existing) return existing;
    this.telemetry.record("runtime.compaction.requested", { sessionKey: session.sessionKey, runId: id });
    const run = this.dispatcher.enqueue({ id, source: "compaction", sourceId: session.sessionKey,
      idempotencyKey: id, profileId: profile.id, workspace: session.workspace });
    const command = Object.freeze({ kind: "domain", runId: id, operationId: id, prompt: plan.prompt,
      sessionKey: session.sessionKey, bindingId: profile.selectedBindingId ?? session.runtimeBindingId,
      summaryModel: profile.selectedBindingId === session.runtimeBindingId ? session.modelOverride ?? profile.defaultModel ?? null : profile.defaultModel ?? null,
      sourceNativeSessionId: runtimeSessionIdOf(session), sourceBindingId: session.runtimeBindingId,
      createdAt: this.now(), plan });
    this.domainCommands.set(id, command);
    this.#streamFor(id);
    const admission = this.#admit(id, profile.id);
    if (admission.disposition === "started") this.#schedule(id);
    else if (admission.disposition === "rejected") await this.#rejectAccountAdmission(run, admission.reason, this.lifecycleGeneration);
    return this.dispatcher.getRun(id);
  }

  async #send(input) {
    this.#assertOpen();
    this.#assertInboxAvailable();
    if (this.contextHandoffs.has(input?.sessionKey)) throw coordinatorError("SESSION_BUSY", "正在准备会话上下文");
    if (!exactObject(input, attachmentFields(input, ["operationId", "sessionKey", "prompt"]))
      || (input.attachments !== undefined && !validAttachments(input.attachments))) {
      throw coordinatorError("WORK_RUN_SEND_INVALID", "send 需要 operationId/sessionKey/prompt，可附带有效的附件描述");
    }
    let session = this.chatSessionStore.getSession(input.sessionKey);
    if (!session) {
      throw coordinatorError("CHAT_SESSION_NOT_FOUND", `ChatSession 不存在: ${input.sessionKey}`);
    }
    if (input.attachments?.length) {
      const media = this.getMediaStore?.();
      if (!media) throw coordinatorError("BACKEND_NOT_READY", "附件存储尚未就绪");
      media.assertAvailable(input.attachments);
    }
    const key = runIdempotencyKey(input.operationId);
    let run = this.#findRunByIdempotencyKey(key);
    const existingCommand = this.inbox.get(input.operationId);
    if (run && !existingCommand) {
      throw coordinatorError(
        "WORK_RUN_IDEMPOTENCY_RECORD_MISSING",
        `operation ${input.operationId} 的 PendingCommand 幂等记录已不可恢复`,
      );
    }
    if (existingCommand && !run && !ACTIVE_COMMAND_STATES.has(existingCommand.state)) {
      throw coordinatorError(
        "WORK_RUN_IDEMPOTENCY_RECORD_MISSING",
        `operation ${input.operationId} 的 WorkRun 已不可恢复`,
      );
    }
    const terminalReplay = Boolean(existingCommand && run
      && !ACTIVE_COMMAND_STATES.has(existingCommand.state));
    if (!sendableSession(session) && !terminalReplay) {
      throw coordinatorError("CHAT_SESSION_NOT_READY", `ChatSession 当前不可发送: ${session.status}`);
    }
    if (!existingCommand && !run) {
      await this.beforeSessionSend(input);
      session = this.chatSessionStore.getSession(input.sessionKey);
    }
    const runId = existingCommand?.runId || run?.id || this.randomUUID();
    const createdAt = existingCommand?.createdAt ?? this.now();
    const runInput = run ? null : this.#runInput(runId, input.operationId, session);
    const command = await this.inbox.enqueue({
      operationId: input.operationId,
      runId,
      sessionKey: input.sessionKey,
      prompt: input.prompt,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      createdAt,
    });
    if (!run) run = this.dispatcher.enqueue(runInput);
    this.#streamFor(run.id);
    if (run.id !== runId) {
      throw coordinatorError(
        "WORK_RUN_COMMAND_ID_CONFLICT",
        `operation ${input.operationId} 的 runId 与 WorkRun 不一致`,
      );
    }
    if (run.source !== "chat" || run.sourceId !== input.sessionKey
      || run.profileId !== session.profileId || run.idempotencyKey !== key) {
      throw coordinatorError(
        "WORK_RUN_COMMAND_SOURCE_CONFLICT",
        `operation ${input.operationId} 与 chat WorkRun 身份不一致`,
      );
    }
    this.#appendTranscript(run.id, {
      id: transcriptEventId("chat-user", input.operationId),
      kind: "user",
      content: { text: input.prompt, operationId: input.operationId,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}) },
      runtimeRef: null,
      contextExcluded: false,
      occurredAt: command.createdAt,
    });
    if (!ACTIVE_COMMAND_STATES.has(command.state)) {
      return { disposition: "completed", reason: null, run };
    }

    if (this.getNativeRuntimeConfig()?.flags?.runtimeAdmissionV1) {
      await this.#drainQueuedRuns(this.lifecycleGeneration);
      run = this.dispatcher.getRun(run.id);
    }

    let disposition = run.status === "queued" ? "queued" : "started";
    let reason = null;
    if (run.status === "queued") {
      const admission = this.#admit(run.id, session.profileId);
      if (admission.disposition === "rejected") {
        return this.#rejectAccountAdmission(run, admission.reason, this.lifecycleGeneration);
      }
      run = admission.run;
      disposition = admission.disposition;
      reason = admission.reason;
    }
    if (run.status === "starting") this.#schedule(run.id);
    return { disposition, reason, run };
  }

  async executeDomainRun(input) {
    this.#assertOpen();
    if (!exactObject(input, ["runId", "operationId", "prompt", "threadSource", "threadId"])
      || !validOpaqueId(input.runId) || !validOpaqueId(input.operationId)
      || typeof input.prompt !== "string" || input.prompt.length === 0
      || !input.prompt.isWellFormed() || input.prompt.includes("\0")
      || Buffer.byteLength(input.prompt, "utf8") > MAX_DOMAIN_PROMPT_BYTES
      || typeof input.threadSource !== "string" || input.threadSource.length === 0
      || !input.threadSource.isWellFormed() || input.threadSource.includes("\0")
      || Buffer.byteLength(input.threadSource, "utf8") > MAX_THREAD_SOURCE_BYTES
      || (input.threadId !== null && !validOpaqueId(input.threadId, 256))) {
      throw coordinatorError("DOMAIN_WORK_RUN_EXECUTION_INVALID", "Domain WorkRun execution 输入无效");
    }
    let run = this.dispatcher.getRun(input.runId);
    if (!run) throw coordinatorError("WORK_RUN_NOT_FOUND", `WorkRun 不存在: ${input.runId}`);
    if (!new Set(["kanban", "cron", "inspiration"]).has(run.source)) {
      throw coordinatorError("DOMAIN_WORK_RUN_SOURCE_INVALID", "只有领域 WorkRun 可走 domain executor");
    }
    const validThreadSources = new Set([domainThreadSource(run, "new")]);
    if (run.source === "cron") validThreadSources.add(domainThreadSource(run, "continue"));
    if (input.operationId !== domainOperationId(run)
      || !validThreadSources.has(input.threadSource)
      || (input.threadId !== null
        && (run.source !== "cron" || input.threadSource !== domainThreadSource(run, "continue")))) {
      throw coordinatorError(
        "DOMAIN_WORK_RUN_BINDING_INVALID",
        `WorkRun ${run.id} 的 domain operation/thread binding 无效`,
      );
    }
    if (TERMINAL_RUN_STATES.has(run.status)) {
      return { disposition: "completed", reason: null, run };
    }
    if (run.source === "kanban" && this.sourceConversationStore) {
      const session = this.sourceConversationStore.ensure(run);
      if (!session) throw coordinatorError("CHAT_SESSION_DELETED", "任务对应的会话已删除");
      this.transcriptStore?.ensureSession?.({ profileId: run.profileId, sessionId: session.id });
      this.#appendTranscript(run.id, { id: transcriptEventId("kanban-user", input.operationId), kind: "user",
        content: { text: input.prompt, operationId: input.operationId }, runtimeRef: null, contextExcluded: false });
    }
    if (run.status === "queued" && run.source === "cron") {
      // The durable conversation owns the execution Binding even when new
      // handoffs are disabled. Resolve it before freezing admission authority.
      const session = this.#ensureCronTranscript(run, input);
      // A job's legacy native ID has no Runtime namespace. It may seed only a
      // pristine conversation, never replace the ID selected by a handoff.
      if (input.threadId !== null && session?.status === "draft" && session.revision === 1
        && runtimeSessionIdOf(session) === null && session.retiredRuntimeSessions.length === 0) {
        this.#ensureCronTranscript(run, input, input.threadId);
      }
    }
    if (run.status === "queued" && this.followDefaultSessionBinding
      && this.getNativeRuntimeConfig()?.flags?.runtimeConversationHandoff
      && (run.source === "kanban" || run.source === "cron" || (run.source === "inspiration"
        && this.resolveRunSession(run)?.inputSource !== "chat"))) {
      // Inspiration keeps its domain ownership when continued from Chat, but
      // an explicit chat send must honor that conversation's selected Binding.
      const sessionKey = this.getRunSessionKey(run);
      if (sessionKey) {
        await this.followDefaultSessionBinding(sessionKey, run.id);
      }
    }
    const fingerprint = controlFingerprint("domain-execution", input);
    const existing = this.domainCommands.get(run.id);
    if (existing && existing.fingerprint !== fingerprint) {
      throw coordinatorError(
        "DOMAIN_WORK_RUN_EXECUTION_CONFLICT",
        `WorkRun ${run.id} 已绑定不同的 domain execution`,
      );
    }
    if (ACTIVE_RUN_STATES.has(run.status) && !existing) {
      run = await this.#interruptForLostExecutionContract(run.id, this.lifecycleGeneration);
      return { disposition: "completed", reason: null, run };
    }
    if (!existing) {
      if (this.domainCommands.size >= this.maxDomainExecutions) {
        throw coordinatorError(
          "DOMAIN_WORK_RUN_EXECUTOR_BUSY",
          "Domain WorkRun executor 已达到容量上限",
        );
      }
      this.domainCommands.set(run.id, Object.freeze({
        kind: "domain",
        ...structuredClone(input),
        createdAt: this.sourceConversationStore?.get(run.id)?.createdAt ?? this.now(),
        conversationPolicy: require("./source-conversation-policy").sourcePolicyForRun(run, {
          threadPolicy: input.threadSource === domainThreadSource(run, "continue") ? "continue" : "new",
          sessionKey: run.source === "inspiration" ? this.getRunSessionKey(run) : null,
        }),
        fingerprint,
      }));
    }
    this.#streamFor(run.id);
    if (run.source === "inspiration") {
      const binding = this.resolveRunSession(run);
      const attachments = inspirationUserAttachments(binding);
      this.#appendTranscript(run.id, {
        id: transcriptEventId("inspiration-user", input.operationId),
        kind: "user", content: { text: inspirationUserText(binding),
        operationId: input.operationId,
        ...(attachments.length ? { attachments } : {}) },
        runtimeRef: null, contextExcluded: false, occurredAt: binding?.createdAt ?? this.now(),
      });
    }
    let disposition = run.status === "queued" ? "queued" : "started";
    let reason = null;
    if (run.status === "queued") {
      const admission = this.#admit(run.id, run.profileId);
      if (admission.disposition === "rejected") {
        return this.#rejectAccountAdmission(run, admission.reason, this.lifecycleGeneration);
      }
      run = admission.run;
      disposition = admission.disposition;
      reason = admission.reason;
    }
    if (run.status === "starting") this.#schedule(run.id);
    return { disposition, reason, run };
  }

  async waitForIdle(runId) {
    this.#assertOpen();
    while (this.runTails.has(runId)) {
      const tail = this.runTails.get(runId);
      try {
        await tail;
      } catch {
        // 具体错误由 lastErrors 保留；tail 自身已挂 rejection handler，避免后台未处理异常。
      }
      if (this.runTails.get(runId) === tail) break;
    }
    this.#assertOpen();
    const error = this.lastErrors.get(runId);
    if (error) throw error;
    return this.dispatcher.getRun(runId);
  }

  waitForTerminal(runId) {
    this.#assertOpen();
    if (!validOpaqueId(runId)) {
      throw coordinatorError("WORK_RUN_NOT_FOUND", "WorkRun id 无效");
    }
    const run = this.dispatcher.getRun(runId);
    if (!run) throw coordinatorError("WORK_RUN_NOT_FOUND", `WorkRun 不存在: ${runId}`);
    if (TERMINAL_RUN_STATES.has(run.status)) return Promise.resolve(run);
    const existing = this.terminalWaiters.get(runId);
    if (existing) return existing.promise;
    if (this.terminalWaiters.size >= this.maxDomainExecutions) {
      throw coordinatorError("WORK_RUN_TERMINAL_WAITER_BUSY", "terminal waiter 已达到容量上限");
    }
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {});
    const subscription = this.subscribeRun(
      runId,
      { streamId: null, afterSeq: 0 },
      (event) => {
        if (event.type === "terminal") this.#resolveTerminalWaiter(runId);
      },
    );
    const record = { promise, resolve, reject, unsubscribe: subscription.unsubscribe };
    this.terminalWaiters.set(runId, record);
    const current = this.dispatcher.getRun(runId);
    if (TERMINAL_RUN_STATES.has(current?.status)) this.#resolveTerminalWaiter(runId);
    return promise;
  }

  // The check and fence must remain synchronous: timers and internal cron
  // admission share this coordinator with the local RPC server.
  quiesceIfIdle() {
    this.#assertOpen();
    if (this.listRuns().some(run => ACTIVE_RUN_STATES.has(run.status))
      || this.pendingSessionSends.size || this.startupControllers.size
      || this.manualCompactions.size) {
      throw coordinatorError("SERVICE_MAINTENANCE_BUSY", "正在执行任务，暂时无法切换数据目录");
    }
    this.admissionsQuiesced = true;
    return { quiesced: true };
  }

  #assertOpen(allowQuiesced = false) {
    if (this.poisonError) throw this.poisonError;
    if (this.admissionsQuiesced && !allowQuiesced) {
      throw coordinatorError("SERVICE_QUIESCED", "Service 已暂停接收任务，等待重新启动");
    }
    if (this.state !== "open") {
      throw coordinatorError(
        this.state === "opening"
          ? "WORK_RUN_COORDINATOR_OPENING"
          : this.state === "closing" ? "WORK_RUN_COORDINATOR_CLOSING" : "WORK_RUN_COORDINATOR_CLOSED",
        this.state === "opening"
          ? "WorkRunCoordinator 正在打开"
          : this.state === "closing" ? "WorkRunCoordinator 正在关闭" : "WorkRunCoordinator 未打开或已关闭",
      );
    }
  }

  #resolveTerminalWaiter(runId) {
    const record = this.terminalWaiters.get(runId);
    if (!record) return false;
    this.terminalWaiters.delete(runId);
    try { record.unsubscribe(); } catch {}
    try {
      record.resolve(this.dispatcher.getRun(runId));
    } catch (error) {
      record.reject(error);
    }
    return true;
  }

  #rejectTerminalWaiters(error) {
    for (const [runId, record] of [...this.terminalWaiters]) {
      this.terminalWaiters.delete(runId);
      try { record.unsubscribe(); } catch {}
      record.reject(error);
    }
  }

  #assertInboxAvailable() {
    if (this.inbox.isLocked?.() === true) {
      throw coordinatorError("pending_commands_locked", "pending_commands_locked");
    }
  }

  #selectChatRun(sessionKey, runId, includeQueued = false) {
    const session = this.chatSessionStore.getSession(sessionKey);
    if (!session) throw coordinatorError("CHAT_SESSION_NOT_FOUND", `ChatSession 不存在: ${sessionKey}`);
    if (runId !== null) {
      const run = this.dispatcher.getRun(runId);
      if (!run) throw coordinatorError("WORK_RUN_NOT_FOUND", `WorkRun 不存在: ${runId}`);
      if (this.getRunSessionKey(run) !== sessionKey) {
        throw coordinatorError("WORK_RUN_CONTROL_MISMATCH", "WorkRun 不属于指定 ChatSession");
      }
      return run;
    }
    let matches = this.listSessionRuns(sessionKey)
      .filter((run) => ACTIVE_RUN_STATES.has(run.status));
    if (matches.length === 0 && includeQueued) {
      matches = this.listSessionRuns(sessionKey).filter((run) => run.status === "queued");
    }
    if (matches.length !== 1) {
      throw coordinatorError(
        matches.length === 0 ? "WORK_RUN_NOT_FOUND" : "CHAT_SESSION_BUSY",
        "ChatSession 无法唯一定位 active WorkRun",
      );
    }
    return matches[0];
  }

  #activeAssignment(runId, sessionKey, requiredStatus = null) {
    const run = this.dispatcher.getRun(runId);
    if (!run) throw coordinatorError("WORK_RUN_NOT_FOUND", `WorkRun 不存在: ${runId}`);
    if (this.getRunSessionKey(run) !== sessionKey) {
      throw coordinatorError("WORK_RUN_CONTROL_MISMATCH", "WorkRun 不属于指定 ChatSession");
    }
    if (!ACTIVE_RUN_STATES.has(run.status) || (requiredStatus !== null && run.status !== requiredStatus)) {
      throw coordinatorError("WORK_RUN_NOT_CONTROLLABLE", `WorkRun ${runId} 当前不可控制: ${run.status}`);
    }
    const assignment = this.runHostAssignments.get(runId);
    const context = this.runContexts.get(runId);
    if (!assignment || !context || assignment.host !== context.host
      || assignment.generation !== context.generation
      || assignment.lifecycle !== this.lifecycleGeneration
      || !this.hostObservers.has(assignment.host)
      || runtimeSessionIdOf(run) !== context.threadId
      || runtimeTurnIdOf(run) !== context.turnId) {
      throw coordinatorError("WORK_RUN_CONTROL_UNASSIGNED", `WorkRun ${runId} 缺少当前 Host binding`);
    }
    const token = { lifecycle: assignment.lifecycle, run: assignment.generation, runId };
    this.#fence(token);
    if (this.runHostAssignments.get(runId) !== assignment) {
      throw coordinatorError("WORK_RUN_CONTROL_STALE", `WorkRun ${runId} Host assignment 已变化`);
    }
    return { run, assignment, context, token };
  }

  #idempotentControl(operationId, fingerprint, work) {
    const existing = this.controlOperations.get(operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw coordinatorError("WORK_RUN_OPERATION_CONFLICT", `operationId ${operationId} 输入冲突`);
      }
      return existing.promise;
    }
    while (this.controlOperations.size >= MAX_CONTROL_OPERATIONS) {
      const completedKey = [...this.controlOperations.entries()]
        .find(([, record]) => record.pending === false)?.[0];
      if (!completedKey) {
        throw coordinatorError("WORK_RUN_CONTROL_BUSY", "交互控制操作已达到容量上限");
      }
      this.controlOperations.delete(completedKey);
    }
    const record = { fingerprint, pending: true, promise: null };
    const promise = Promise.resolve().then(work).finally(() => {
      record.pending = false;
      this.controlOperations.delete(operationId);
      this.controlOperations.set(operationId, record);
    });
    promise.catch(() => {});
    record.promise = promise;
    this.controlOperations.set(operationId, record);
    return promise;
  }

  #runInput(runId, operationId, session) {
    const profile = this.productStore.getAgentProfile(session.profileId);
    if (!profile) {
      throw coordinatorError("UNKNOWN_AGENT_PROFILE", `AgentProfile 不存在: ${session.profileId}`);
    }
    const workspace = session.workspace ?? profile.defaultCwd ?? null;
    if (workspace === null && profile.permissionPolicy?.sandbox !== "read-only") {
      throw coordinatorError(
        "WORKSPACE_REQUIRED_FOR_WRITABLE_RUN",
        "writable WorkRun 必须绑定显式 execution workspace",
      );
    }
    return {
      id: runId,
      source: "chat",
      sourceId: session.sessionKey,
      idempotencyKey: runIdempotencyKey(operationId),
      profileId: session.profileId,
      workspace,
      retryOf: null,
    };
  }

  #findRunByIdempotencyKey(key) {
    return this.dispatcher.listRuns().find((run) => run.idempotencyKey === key) || null;
  }

  #streamFor(runId) {
    this.#pruneTerminalStreams();
    let stream = this.runStreams.get(runId);
    if (stream) {
      if (this.terminalStreams.has(runId)) this.#retainTerminalStream(runId);
      return stream;
    }
    stream = createRunEventStream({
      runId,
      getSnapshot: () => this.#runStreamSnapshot(runId),
      assertSecretSafe: this.assertSecretSafe,
      randomUUID: this.randomUUID,
    });
    this.runStreams.set(runId, stream);
    if (TERMINAL_RUN_STATES.has(this.dispatcher.getRun(runId)?.status)) {
      this.#retainTerminalStream(runId);
    }
    return stream;
  }

  #performanceFor(runId) {
    let state = this.runPerformance.get(runId);
    if (state) return state;
    state = {
      turnStartedAt: null,
      firstRuntimeEventSeen: false,
      toolStartedAt: new Map(),
      federationToolNames: new Map(),
    };
    this.runPerformance.set(runId, state);
    return state;
  }

  #appendPerformanceStage(runId, stage, startedAt, outcome, extra = {}) {
    const finishedAt = this.now();
    this.telemetry.record("runtime.stage", { runId, stage, outcome, durationMs: Math.max(0, finishedAt - startedAt) });
    if (outcome === "error" && ["runtime_acquire", "runtime_authentication", "session_start_or_resume"].includes(stage))
      this.telemetry.record("runtime.preflight.failed", { runId, reason: stage });
    if (!Number.isSafeInteger(startedAt) || startedAt < 0
      || !Number.isSafeInteger(finishedAt) || finishedAt < 0) return null;
    try {
      return this.#streamFor(runId).append("performance.stage", definedProperties({
        stage,
        durationMs: Math.max(0, finishedAt - startedAt),
        outcome,
        ...extra,
      }));
    } catch {
      // 性能观测是旁路数据，不能反向中断已经获准的 WorkRun。
      return null;
    }
  }

  async #timedPerformanceStage(runId, stage, task) {
    const startedAt = this.now();
    try {
      const result = await task();
      this.#appendPerformanceStage(runId, stage, startedAt, "success");
      return result;
    } catch (error) {
      this.#appendPerformanceStage(runId, stage, startedAt, "error");
      throw error;
    }
  }

  #runStreamSnapshot(runId) {
    const run = this.dispatcher.getRun(runId);
    if (run?.status === "queued" && this.runQueueStates.has(runId)) {
      return { run, queue: this.runQueueStates.get(runId) };
    }
    const record = run?.waitingRequestId
      ? this.pendingRequests.get(run.waitingRequestId) : null;
    if (!record || record.runId !== runId || !record.publicPayload) return { run };
    return {
      run,
      interaction: {
        type: record.kind === "input" ? "prompt" : "approval",
        payload: record.publicPayload,
      },
    };
  }

  getRuntimeObservability() {
    const runs = this.dispatcher.listRuns(), config = this.getNativeRuntimeConfig();
    const policy = require("./execution-policy").resolveAdmissionPolicy(config);
    const queue = {};
    for (const run of runs.filter(item => item.status === "queued")) {
      const state = this.runQueueStates.get(run.id), reason = state?.reason || "RECOVERING";
      const group = queue[reason] ||= { count: 0, longestWaitMs: 0 }; group.count++;
      group.longestWaitMs = Math.max(group.longestWaitMs, this.now() - (this.queueArrivalTimes.get(run.id) ?? state?.queuedAt ?? this.now()));
    }
    const quality = {};
    for (const entry of this.runtimeContextUsage.values()) { const key = entry.usage.quality || "unknown"; quality[key] = (quality[key] || 0) + 1; }
    return { ...this.telemetry.snapshot(), active: runs.filter(run => ACTIVE_RUN_STATES.has(run.status)).length,
      maxActive: policy.maxActive, limitSource: policy.enabled ? "native-runtime-config" : "legacy-admission",
      queue, startup: { active: this.startupGate?.active?.size || 0, waiting: this.startupGate?.waiters?.size || 0,
        limit: config.startupConcurrency || null }, hosts: this.runtimeManager.statistics?.() || null,
      pendingInteractions: this.pendingRequests.size, contextQuality: quality };
  }

  getRunSessionKey(runOrId) {
    const run = typeof runOrId === "string" ? this.dispatcher.getRun(runOrId) : runOrId;
    if (!run) return null;
    if (run.source === "chat" || run.source === "compaction") return run.sourceId;
    if (run.source === "kanban") {
      const binding = this.sourceConversationStore?.get(run.id);
      if (!binding) return null;
      if (["source", "sourceId", "profileId", "workspace"].some(key => binding[key] !== run[key])) {
        throw coordinatorError("TRANSCRIPT_SESSION_INVALID", "任务执行与会话的归属不匹配");
      }
      const session = this.chatSessionStore.getSession(binding.sessionKey);
      if (session && (session.profileId !== run.profileId || session.workspace !== run.workspace)) {
        throw coordinatorError("TRANSCRIPT_SESSION_INVALID", "任务执行与会话的归属不匹配");
      }
      return session ? binding.sessionKey : null;
    }
    if (run.source === "cron") {
      const binding = this.chatSessionStore.getCronRunBinding?.(run.id);
      if (!binding) return null;
      const session = this.chatSessionStore.getSession(binding.sessionKey);
      if (binding.jobId !== run.sourceId || binding.profileId !== run.profileId
        || binding.workspace !== run.workspace || (session && (
          session.profileId !== run.profileId || session.workspace !== run.workspace))) {
        throw coordinatorError("TRANSCRIPT_SESSION_INVALID", "Cron 执行与 Session 的归属不匹配");
      }
      return session ? binding.sessionKey : null;
    }
    if (run.source !== "inspiration") return null;
    const binding = this.resolveRunSession(run);
    const session = binding?.sessionKey ? this.chatSessionStore.getSession(binding.sessionKey) : null;
    if (!binding?.sessionKey || binding.ideaId !== run.sourceId || binding.runId !== run.id
      || binding.profileId !== run.profileId || binding.workspace !== run.workspace
      || (session && (session.profileId !== run.profileId || session.workspace !== run.workspace))
      || (!session && !TERMINAL_RUN_STATES.has(run.status))) {
      throw coordinatorError("TRANSCRIPT_SESSION_INVALID", "灵感执行与 Session 的归属不匹配");
    }
    return binding.sessionKey;
  }

  listSessionRuns(sessionKey, query = {}) {
    return this.dispatcher.listRuns(query).filter((run) => this.getRunSessionKey(run) === sessionKey);
  }

  recoverCronChatSessions() {
    if (typeof this.chatSessionStore.ensureCronSession !== "function" || !this.runtimeSessionOwnershipStore) return;
    const runs = this.dispatcher.listRuns({ source: "cron" })
      .sort((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0));
    for (const run of runs) {
      if (!TERMINAL_RUN_STATES.has(run.status) || run.runtimeSessionRef?.runtime !== "codex"
        || this.chatSessionStore.getCronRunBinding(run.id)) continue;
      const profile = this.productStore.getAgentProfile(run.profileId);
      const ref = run.runtimeSessionRef;
      if (!profile || ref.runtime !== profile.runtime || ref.runtimeProfileId !== profile.runtimeProfileId
        || ref.runtimeAccountId !== profile.runtimeAccountId) continue;
      if (this.runtimeSessionOwnershipStore) {
        try {
          this.runtimeSessionOwnershipStore.assertOwned({ binding: runtimeBinding({ runtime: ref.runtime,
            runtimeProfileId: ref.runtimeProfileId, runtimeAccountId: ref.runtimeAccountId }),
            profileId: run.profileId, sessionId: ref.sessionId, workspace: run.workspace });
        } catch { continue; }
      }
      let session;
      try {
        session = this.chatSessionStore.ensureCronSession({ runId: run.id, jobId: run.sourceId,
          profileId: run.profileId, workspace: run.workspace, threadSource: null, runtimeSessionId: ref.sessionId });
      } catch (error) {
        // A full history store must not prevent the application from starting.
        // Preserve unbound runs for a later recovery after space is made.
        if (error?.code === "CHAT_SESSION_CAPACITY") return;
        throw error;
      }
      if (session) this.transcriptStore?.ensureSession?.({ profileId: run.profileId, sessionId: session.id });
      // Leave legacy transcripts empty for the existing, ownership-checked native
      // history importer. Never fabricate a conversation from a result summary.
    }
  }

  #ensureCronTranscript(run, command, runtimeSessionId = null) {
    if (typeof this.chatSessionStore.ensureCronSession !== "function") return null;
    const session = this.chatSessionStore.ensureCronSession({ runId: run.id, jobId: run.sourceId,
      profileId: run.profileId, workspace: run.workspace, threadSource: command.threadSource, runtimeSessionId });
    if (!session) throw coordinatorError("CHAT_SESSION_DELETED", "Cron 对应的聊天已删除");
    if (!sendableSession(session)) throw coordinatorError("CHAT_SESSION_NOT_READY", "Cron 对应的聊天不可运行");
    this.transcriptStore?.ensureSession?.({ profileId: run.profileId, sessionId: session.id });
    const event = { id: transcriptEventId("cron-user", command.operationId), kind: "user",
      content: { text: command.prompt, operationId: command.operationId },
      // TranscriptStore preserves the first timestamp on an idempotent append;
      // admission can happen later than the initial queued conversation write.
      runtimeRef: null, contextExcluded: false };
    try { this.#appendTranscript(run.id, event); }
    catch (error) {
      if (!["TRANSCRIPT_SECRET_REJECTED", "TRANSCRIPT_EVENT_TOO_LARGE"].includes(error?.code)) throw error;
      this.#appendTranscript(run.id, { ...event, content: { ...event.content, text: "[REDACTED]" } });
    }
    return session;
  }

  getRunSnapshot(runId) {
    this.#assertOpen();
    return structuredClone(this.#runStreamSnapshot(runId));
  }

  cancelQueuedDomainRun(runId, errorCode = null) {
    this.#assertOpen();
    const run = this.dispatcher.getRun(runId);
    if (run?.source !== "inspiration" || run.status !== "queued") {
      throw coordinatorError("WORK_RUN_NOT_CONTROLLABLE", "灵感执行已开始，不能按未启动任务取消");
    }
    const safeCode = errorCode ? Object.hasOwn(SESSION_RUNTIME_PUBLIC_MESSAGES, errorCode)
      ? errorCode : publicStartErrorCode({ code: errorCode }) : null;
    const canceled = this.dispatcher.transition(runId, safeCode ? "failed" : "canceled", {
      resultSummary: safeCode ? `Execution could not start (${safeCode}).` : null,
      errorCode: safeCode,
    });
    this.#appendTerminal(runId, { status: canceled.status, resultSummary: canceled.resultSummary, errorCode: canceled.errorCode });
    this.#releaseTerminalRun(runId);
    return canceled;
  }

  #appendTranscript(runId, event) {
    if (!this.transcriptStore) return null;
    const run = this.dispatcher.getRun(runId);
    const sessionKey = this.getRunSessionKey(run);
    if (!sessionKey) return null;
    const session = this.chatSessionStore.getSession(sessionKey);
    if (!session || session.profileId !== run.profileId) {
      throw coordinatorError("TRANSCRIPT_SESSION_INVALID", "WorkRun Transcript session binding 无效");
    }
    const committed = this.transcriptStore.appendEvent({
      profileId: run.profileId,
      sessionId: session.id,
      id: event.id,
      runId: run.id,
      kind: event.kind,
      content: event.content,
      ...(event.contextContent !== undefined ? { contextContent: event.contextContent } : {}),
      runtimeRef: event.runtimeRef,
      contextExcluded: event.contextExcluded,
      occurredAt: event.occurredAt,
    });
    if (this.onTranscriptCommitted) {
      try {
        const result = this.onTranscriptCommitted(structuredClone(committed), structuredClone(run));
        if (result?.then) Promise.resolve(result).catch(() => {});
      } catch {}
    }
    return committed;
  }

  #appendTerminal(runId, payload) {
    const run = this.dispatcher.getRun(runId);
    if (run?.source === "cron" && !this.getRunSessionKey(run)) {
      const command = this.domainCommands.get(runId);
      if (command && !this.chatSessionStore.getCronRunBinding?.(runId)) this.#ensureCronTranscript(run, command);
    }
    if (run?.source === "cron") this.chatSessionStore.touchCronSession?.(runId, run.finishedAt ?? this.now());
    if (this.getRunSessionKey(run)) {
      this.#appendTranscript(runId, {
        id: transcriptEventId("chat-terminal", runId, payload.status),
        kind: payload.errorCode ? "error" : "status",
        content: { transcriptType: "terminal", ...payload },
        runtimeRef: run.runtimeTurnRef || run.runtimeSessionRef || null,
        contextExcluded: false,
        occurredAt: run.finishedAt ?? this.now(),
      });
    }
    const appended = this.#streamFor(runId).append("terminal", payload);
    if (run && this.onRunTerminal) {
      try {
        const result = this.onRunTerminal(structuredClone(run), structuredClone(payload));
        if (result?.then) Promise.resolve(result).catch(() => {});
      } catch {}
    }
    return appended;
  }

  #retentionNow() {
    const current = this.now();
    if (!Number.isSafeInteger(current) || current < 0) {
      throw coordinatorError("WORK_RUN_COORDINATOR_CLOCK_INVALID", "now 必须返回非负安全整数");
    }
    this.terminalRetentionClock = Math.max(this.terminalRetentionClock, current);
    return this.terminalRetentionClock;
  }

  #evictTerminalStream(runId) {
    this.terminalStreams.delete(runId);
    this.rehydratedTerminalStreams.delete(runId);
    const stream = this.runStreams.get(runId);
    if (!stream) return;
    stream.close();
    this.runStreams.delete(runId);
  }

  #pruneTerminalStreams(current = this.#retentionNow()) {
    for (const [runId, retainedAt] of this.terminalStreams) {
      if (current - retainedAt < this.terminalStreamTtlMs) continue;
      this.#evictTerminalStream(runId);
    }
    while (this.terminalStreams.size > this.maxTerminalStreams) {
      const oldestRunId = this.terminalStreams.keys().next().value;
      this.#evictTerminalStream(oldestRunId);
    }
  }

  #retainTerminalStream(runId) {
    if (!this.runStreams.has(runId)) return;
    const current = this.#retentionNow();
    this.terminalStreams.delete(runId);
    this.terminalStreams.set(runId, current);
    this.#pruneTerminalStreams(current);
  }

  #releaseTerminalRun(runId) {
    this.runtimeMcpCallBindings.releaseRun(runId);
    const completed = this.dispatcher.getRun(runId);
    const sessionKey = completed && this.getRunSessionKey(completed);
    this.hostCapabilityIssuer.revoke(this.runCapabilityLeases.get(runId));
    this.runCapabilityLeases.delete(runId);
    if (this.runExecutionStore) {
      try { this.runExecutionStore.remove(this.dispatcher.getRun(runId)); } catch (error) { this.#poison(error); }
    }
    this.recoveringRuns.delete(runId);
    this.runQueueStates.delete(runId);
    this.startupControllers.get(runId)?.abort();
    this.startupGate?.release(runId);
    this.#releaseRuntimeAccountAdmission(runId);
    this.#settlePendingForAbort(runId);
    this.#resolveTerminalWaiter(runId);
    this.runContexts.delete(runId);
    this.runExecutionContracts.delete(runId);
    this.pluginRuntimeToolService?.releaseRun(runId);
    this.domainCommands.delete(runId);
    this.runHostAssignments.delete(runId);
    this.runPerformance.delete(runId);
    this.runGenerations.delete(runId);
    this.lastErrors.delete(runId);
    this.rehydratedTerminalStreams.delete(runId);
    this.#retainTerminalStream(runId);
    this.queueArrivalTimes.delete(runId);
    if (completed.source === "compaction") this.telemetry.record("runtime.compaction.completed", { runId, outcome: completed.status === "completed" ? "success" : "error" });
    if (sessionKey && completed.source !== "compaction") {
      this.telemetry.recordSwitchFirstTurn?.({ sessionKey, runId,
        outcome: completed.status === "completed" ? "success" : "error" });
    }
    if (sessionKey && completed.status === "completed" && this.conversationCheckpointStore) {
      const generation = this.lifecycleGeneration;
      setImmediate(() => {
        if (generation !== this.lifecycleGeneration || this.state !== "open") return;
        const session = this.chatSessionStore.getSession(sessionKey);
        if (session) this.#prepareConversationCompaction(session).catch(error => {
          this.lastErrors.set(runId, error);
        });
      });
    }
  }

  #releaseRuntimeAccountAdmission(runId) {
    const admission = this.runAccountAdmissions.get(runId);
    if (!admission) return false;
    try {
      return this.runtimeAccountAdmission.release({
        runtimeAccountId: admission.runtimeAccountId,
        runId,
      });
    } finally {
      this.runAccountAdmissions.delete(runId);
    }
  }

  #releaseAllRuntimeAccountAdmissions() {
    this.hostCapabilityIssuer.close();
    this.runCapabilityLeases.clear();
    for (const controller of this.startupControllers.values()) controller.abort();
    this.startupGate?.clear();
    const errors = [];
    for (const runId of [...this.runAccountAdmissions.keys()]) {
      try {
        this.#releaseRuntimeAccountAdmission(runId);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  async #withTerminalizing(runId, callback) {
    if (this.terminalizingRuns.has(runId)) {
      throw coordinatorError(
        "WORK_RUN_TERMINAL_REENTRANT",
        `WorkRun ${runId} 正在按 durable terminal 顺序收敛`,
      );
    }
    this.terminalizingRuns.add(runId);
    try {
      return await callback();
    } finally {
      this.terminalizingRuns.delete(runId);
    }
  }

  async #completeActiveCommand(operationId, command, fence) {
    let current = command;
    if (current?.state === "pending") {
      fence();
      current = await this.inbox.transition(operationId, "dispatching");
      fence();
    }
    if (current?.state === "dispatching") {
      fence();
      current = await this.inbox.transition(operationId, "completed");
      fence();
    }
    return current;
  }

  async #cancelActiveCommand(operationId, command, fence) {
    if (!command || !ACTIVE_COMMAND_STATES.has(command.state)) return command;
    fence();
    const current = await this.inbox.transition(operationId, "canceled");
    fence();
    return current;
  }

  #commandForRun(run) {
    if (run?.source === "chat") {
      const operationId = this.#operationIdForRun(run);
      const command = this.inbox.get(operationId);
      return command ? { kind: "chat", operationId, command } : null;
    }
    const command = this.domainCommands.get(run?.id);
    return command ? { kind: "domain", operationId: command.operationId, command } : null;
  }

  async #completeCommandForRun(run, fence) {
    const record = this.#commandForRun(run);
    if (!record || record.kind === "domain") return record?.command || null;
    if (!ACTIVE_COMMAND_STATES.has(record.command.state)) return record.command;
    return this.#completeActiveCommand(record.operationId, record.command, fence);
  }

  async #cancelCommandForRun(run, fence) {
    const record = this.#commandForRun(run);
    if (!record || record.kind === "domain") return record?.command || null;
    return this.#cancelActiveCommand(record.operationId, record.command, fence);
  }

  async #cancelQueuedChatRun(run) {
    const lifecycle = this.lifecycleGeneration;
    return this.#withTerminalizing(run.id, async () => {
      try {
        this.#fenceLifecycle(lifecycle);
        const terminal = this.dispatcher.transition(run.id, "canceled", {});
        this.#appendTerminal(run.id, { status: "canceled", resultSummary: null, errorCode: null });
        await this.#cancelCommandForRun(terminal, () => this.#fenceLifecycle(lifecycle));
        this.#fenceLifecycle(lifecycle);
        this.#releaseTerminalRun(run.id);
        await this.#drainQueuedRuns(lifecycle);
        return terminal;
      } catch (error) {
        if (error?.code !== "WORK_RUN_COORDINATOR_CLOSING") this.#poison(error);
        throw error;
      }
    });
  }

  async #cancelRunAfterInterrupt(runId, token) {
    this.#fence(token);
    return this.#withTerminalizing(runId, async () => {
      let terminal;
      try {
        this.#fence(token);
        terminal = this.dispatcher.transition(runId, "canceled", {});
      } catch (error) {
        if (error?.code === "STORE_COMMIT_UNCERTAIN") this.#poison(error);
        throw error;
      }
      this.#fence(token);
      try {
        this.#appendTerminal(runId, {
          status: "canceled",
          resultSummary: null,
          errorCode: null,
        });
      } catch (error) {
        this.#poison(error);
        throw error;
      }
      this.#fence(token);
      try {
        await this.#cancelCommandForRun(terminal, () => this.#fence(token));
      } catch (error) {
        this.#poison(error);
        throw error;
      }
      this.#fence(token);
      this.#releaseTerminalRun(runId);
      await this.#drainQueuedRuns(token.lifecycle);
      return terminal;
    });
  }

  #observeHost(host, runtimeProfileId, accountAdmission) {
    if (this.hostObservers.has(host)) {
      this.hostObservers.get(host).runtimeAccountAdmission = accountAdmission;
      return;
    }
    requireMethods(
      host,
      ["subscribe", ...(host.capabilities?.serverRequests === false ? [] : ["registerServerRequestHandler"])],
      "RuntimeHandle event/server request subscription",
    );
    const unsubscribe = host.subscribe((event) => this.#routeHostEvent(host, event));
    if (typeof unsubscribe !== "function") {
      throw coordinatorError("WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED", "RuntimeHandle subscribe 必须返回 unsubscribe");
    }
    if (!host.terminated || typeof host.terminated.then !== "function") {
      unsubscribe();
      throw coordinatorError("WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED", "RuntimeHandle 需要 terminated Promise");
    }
    const observer = {
      runtimeProfileId,
      unsubscribe,
      pendingEvents: [],
      unregisterHandlers: [],
      sessionApprovalRules: new Map(),
      runtimeAccountAdmission: accountAdmission,
    };
    this.hostObservers.set(host, observer);
    try {
      for (const method of host.capabilities?.serverRequests === false ? [] : [...STABLE_SERVER_REQUEST_METHODS,
        ...(host.runtime?.startsWith("ext-") ? ["shoggoth/mcp.call"] : [])]) {
        const unregister = host.registerServerRequestHandler(
          method,
          (params, context) => this.#handleServerRequest(host, method, params, context),
        );
        if (typeof unregister !== "function") {
          throw coordinatorError(
            "WORK_RUN_COORDINATOR_DEPENDENCY_REQUIRED",
            "RuntimeHandle server request 注册必须返回 unregister",
          );
        }
        observer.unregisterHandlers.push(unregister);
      }
    } catch (error) {
      this.hostObservers.delete(host);
      try { unsubscribe(); } catch {}
      for (const unregister of observer.unregisterHandlers) {
        try { unregister(); } catch {}
      }
      throw error;
    }
    Promise.resolve(host.terminated).then(
      () => this.#hostTerminated(host, observer),
      (error) => this.#hostTerminated(host, observer, error),
    ).catch(() => {});
  }

  #hostTerminated(host, observer, error = null) {
    if (this.hostObservers.get(host) !== observer) return;
    this.hostObservers.delete(host);
    try { observer.unsubscribe(); } catch {}
    for (const unregister of observer.unregisterHandlers) {
      try { unregister(); } catch {}
    }
    if (this.poisonError || !["opening", "open"].includes(this.state)) return;
    const lifecycle = this.lifecycleGeneration;
    const assignments = [...this.runHostAssignments.entries()]
      .filter(([, assignment]) => assignment.host === host);
    for (const [runId, assignment] of assignments) {
      this.hostCapabilityIssuer.revoke(this.runCapabilityLeases.get(runId));
      this.runCapabilityLeases.delete(runId);
      const run = this.dispatcher.getRun(runId);
      if (!ACTIVE_RUN_STATES.has(run.status)) continue;
      this.#settlePendingForAbort(runId, assignment);
      this.#chainRunTask(run.id, async () => {
        if (!["opening", "open"].includes(this.state)
          || this.lifecycleGeneration !== lifecycle
          || this.runGenerations.get(run.id) !== assignment.generation
          || this.runHostAssignments.get(run.id) !== assignment) return;
        try {
          this.lastErrors.delete(run.id);
          const code = publicRuntimeOperationalErrorCode(error)
            || (isRuntimeAuthRequired(error) ? RUNTIME_AUTH_REQUIRED_CODE : null)
            || (assignment.runtime === "codex" ? "CODEX_HOST_TERMINATED" : "RUNTIME_CONNECTION_LOST");
          await this.#interruptForHostTermination(run.id, {
            lifecycle,
            run: assignment.generation,
            runId: run.id,
          }, code);
        } catch (error) {
          this.lastErrors.set(run.id, error);
          throw error;
        }
      });
    }
  }

  #handleServerRequest(host, method, params, requestContext = {}) {
    this.#assertOpen();
    if (requestContext.signal?.aborted) {
      throw coordinatorError("WORK_RUN_REQUEST_UNROUTABLE", "Runtime request is no longer active");
    }
    const requestSessionId = params?.sessionId ?? params?.threadId;
    const match = [...this.runContexts.entries()].find(([runId, context]) => {
      const assignment = this.runHostAssignments.get(runId);
      return assignment?.host === host
        && assignment.generation === context.generation
        && assignment.lifecycle === this.lifecycleGeneration
        && context.host === host
        && requestSessionId === context.threadId
        && params?.turnId === context.turnId;
    });
    if (!match) {
      throw coordinatorError("WORK_RUN_REQUEST_UNROUTABLE", "Codex server request 不属于当前 assigned turn");
    }
    const [runId, context] = match;
    const run = this.dispatcher.getRun(runId);
    const assignment = this.runHostAssignments.get(runId);
    if (!run || run.status !== "running" || runtimeSessionIdOf(run) !== context.threadId
      || runtimeTurnIdOf(run) !== context.turnId || !assignment) {
      throw coordinatorError("WORK_RUN_REQUEST_UNROUTABLE", "Codex server request 的 Run 不可等待");
    }
    if (method === "mcpServer/elicitation/request") {
      const proof = parseBindingElicitation(params);
      if (proof) {
        const contract = this.runExecutionContracts.get(runId);
        if (assignment.runtime !== "codex" || !contract) {
          throw coordinatorError("WORK_RUN_REQUEST_UNROUTABLE", "Runtime call binding requires assigned Codex execution");
        }
        const lease = this.runCapabilityLeases.get(runId);
        const kind = proof.name === "artifact_publish" ? "artifact" : "mcp";
        const assertCurrent = () => {
          this.#assertOpen();
          if (this.runContexts.get(runId) !== context || this.runHostAssignments.get(runId) !== assignment
            || assignment.lifecycle !== this.lifecycleGeneration
            || !ACTIVE_RUN_STATES.has(this.dispatcher.getRun(runId)?.status)) {
            throw coordinatorError("HOST_CAPABILITY_REVOKED", "Runtime call execution has changed");
          }
          this.hostCapabilityIssuer.assert(lease, { kind, sessionId: context.threadId, turnId: context.turnId });
        };
        this.runtimeMcpCallBindings.register({ proof, runId, profileId: run.profileId,
          runtimeProfileId: contract.runtimeProfileId, runtimeAccountId: contract.runtimeAccountId, assertCurrent });
        return Object.freeze({ action: "accept", content: Object.freeze({}) });
      }
    }
    if (method === "shoggoth/mcp.call") {
      if (!this.onRuntimeMcpRequest || !exactObject(params, ["sessionId", "turnId", "callId", "name", "arguments",
        ...(Object.hasOwn(params, "confirmation") ? ["confirmation"] : [])])
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(params.callId)
        || typeof params.name !== "string" || params.name.length > 64 || (params.confirmation !== undefined && params.confirmation !== true)) {
        throw coordinatorError("WORK_RUN_REQUEST_UNROUTABLE", "Runtime MCP request is invalid");
      }
      const contract = this.runExecutionContracts.get(runId);
      const kind = params.name === "artifact_publish" ? "artifact" : "mcp";
      this.hostCapabilityIssuer.assert(this.runCapabilityLeases.get(runId), { kind,
        sessionId: context.threadId, turnId: context.turnId });
      return this.invokeRuntimeCapability({ runId, runtimeProfileId: contract.runtimeProfileId,
        runtimeAccountId: contract.runtimeAccountId, kind }, scope => this.onRuntimeMcpRequest(contract.profileId, params, scope));
    }
    this.hostCapabilityIssuer.assert(this.runCapabilityLeases.get(runId), {
      kind: method === "mcpServer/elicitation/request" ? "input" : "approval",
      sessionId: context.threadId, turnId: context.turnId,
    });
    if (method === "item/commandExecution/requestApproval"
      && runtimeCommandUsesReservedHostCapability(params)) {
      return Object.freeze({ decision: "decline" });
    }
    const sessionApprovalRule = runtimeApprovalSupportsSession(method, params)
      ? appSessionCommandRule(method, params) : null;
    const approvedRules = this.hostObservers.get(host)?.sessionApprovalRules.get(context.threadId);
    if (sessionApprovalRule && approvedRules?.has(sessionApprovalRule)) {
      return Object.freeze({ decision: "accept" });
    }
    if (method === "mcpServer/elicitation/request" && this.productMcpApprovalPolicy) {
      const decision = this.productMcpApprovalPolicy.evaluate({
        method,
        params,
        run,
        context,
        executionContract: this.runExecutionContracts.get(runId) || null,
      });
      if (decision !== null) return decision;
    }
    return this.#requestInteraction({ host, method, params, requestContext,
      runId, context, assignment, sessionApprovalRule });
  }

  #requestInteraction({ host, method, params, requestContext, runId, context,
    assignment, sessionApprovalRule = null, approvalTimeoutMs }) {
    if (requestContext.signal?.aborted) {
      throw coordinatorError("HOST_CAPABILITY_REVOKED", "交互请求的执行已失效");
    }
    if (this.pendingRequests.size >= MAX_PENDING_REQUESTS) {
      throw coordinatorError("WORK_RUN_REQUEST_BUSY", "等待用户响应的请求已达到容量上限");
    }
    if ([...this.pendingRequests.values()].some((request) => request.runId === runId)) {
      throw coordinatorError("WORK_RUN_REQUEST_BUSY", "WorkRun 已有等待中的用户请求");
    }
    const requestId = this.randomUUID();
    if (!validOpaqueId(requestId) || this.pendingRequests.has(requestId)) {
      throw coordinatorError("WORK_RUN_REQUEST_ID_INVALID", "无法生成安全公开 requestId");
    }
    const kind = method === "mcpServer/elicitation/request" ? "input" : "approval";
    const timeoutMs = approvalTimeoutMs !== undefined ? approvalTimeoutMs
      : serverRequestUsesApprovalWait(method, params) ? this.approvalTimeoutMs : this.promptTimeoutMs;
    let resolveResponse;
    const responsePromise = new Promise((resolve) => { resolveResponse = resolve; });
    const token = {
      lifecycle: assignment.lifecycle,
      run: assignment.generation,
      runId,
    };
    const record = {
      requestId,
      runId,
      method,
      kind,
      params,
      host,
      assignment,
      context,
      token,
      resolveResponse,
      responsePromise,
      sessionApprovalRule,
      waitingStartedAt: this.now(),
      expiresAt: timeoutMs === null ? null : this.now() + timeoutMs,
      timer: null,
      settled: false,
      abortSignal: requestContext.signal || null,
      abortHandler: null,
    };
    this.#fence(token);
    this.pendingRequests.set(requestId, record);
    try {
      this.#interactiveTransition(
        runId,
        kind === "approval" ? "waiting_approval" : "waiting_input",
        { waitingRequestId: requestId },
      );
      this.#fence(token);
      this.#appendRequestEvent(record);
      if (record.abortSignal) {
        record.abortHandler = () => {
          if (!this.#settlePendingRequest(record, this.#cancellationResponse(record))) return;
          try {
            if (this.runHostAssignments.get(runId) !== record.assignment) return;
            this.#fence(record.token);
            const current = this.dispatcher.getRun(runId);
            if (["waiting_approval", "waiting_input"].includes(current?.status)
              && current.waitingRequestId === record.requestId) {
              this.#interactiveTransition(runId, "running", { waitingRequestId: null });
              this.#streamFor(runId).append("status", { status: "running" });
            }
          } catch (error) {
            if (!["WORK_RUN_COORDINATOR_CLOSING", "WORK_RUN_COORDINATOR_STALE_RUN"].includes(error?.code)) {
              this.lastErrors.set(runId, error);
              this.#poison(error);
            }
          }
        };
        record.abortSignal.addEventListener("abort", record.abortHandler, { once: true });
        if (record.abortSignal.aborted) record.abortHandler();
      }
      if (timeoutMs !== null) {
        const timer = this.promptScheduler.set(
          () => this.#timeoutPendingRequest(requestId),
          timeoutMs,
        );
        if (record.settled) {
          try { this.promptScheduler.clear(timer); } catch {}
        } else {
          record.timer = timer;
        }
      }
    } catch (error) {
      this.pendingRequests.delete(requestId);
      record.abortSignal?.removeEventListener("abort", record.abortHandler);
      if (record.timer !== null) {
        try { this.promptScheduler.clear(record.timer); } catch {}
      }
      if (record.publicPayload && !record.settled) {
        record.settled = true;
        this.#notifyRunInteraction(record, "resolved");
      }
      if (error?.code === "STORE_COMMIT_UNCERTAIN") {
        record.params = null;
        throw error;
      }
      const current = this.dispatcher.getRun(runId);
      if (current && ["waiting_approval", "waiting_input"].includes(current.status)
        && current.waitingRequestId === requestId
        && ["opening", "open"].includes(this.state)
        && this.lifecycleGeneration === token.lifecycle) {
        try {
          this.#interactiveTransition(runId, "running", {});
          this.#streamFor(runId).append("status", {
            status: "running",
            requestId,
            errorCode: "CODEX_PROMPT_SETUP_FAILED",
          });
        } catch (rollbackError) {
          this.#poison(rollbackError);
        }
      }
      throw error;
    }
    return responsePromise;
  }

  #appendRequestEvent(record) {
    const params = record.params;
    const payload = record.kind === "approval"
      ? definedProperties({
        requestId: record.requestId,
        method: record.method,
        kind: record.method === "item/commandExecution/requestApproval"
          ? "command"
          : record.method === "item/fileChange/requestApproval" ? "file_change" : "permissions",
        itemId: params.itemId,
        command: params.command,
        toolName: params.toolName,
        toolInput: methodIsPluginApproval(record.method) ? params.toolInput
          : params.toolInput === undefined ? undefined : projectToolDisplayArgs({
          name: params.toolName,
          input: params.toolInput,
        }, {
          runId: record.runId,
          sanitizeSummary: this.sanitizeSummary,
          assertSecretSafe: this.assertSecretSafe,
          argumentKeys: [...TOOL_DISPLAY_ARGUMENT_KEYS, "boardName", "body"],
        }),
        commandActions: params.commandActions,
        cwd: params.cwd,
        reason: params.reason,
        permissions: params.permissions,
        grantRoot: params.grantRoot,
        sessionApprovalAvailable: runtimeApprovalSupportsSession(record.method, params),
        approvalOptions: params.approvalOptions,
        expiresAt: record.expiresAt,
      })
      : definedProperties({
        requestId: record.requestId,
        method: record.method,
        kind: "mcp_elicitation",
        serverName: params.serverName,
        mode: params.mode,
        message: params.message,
        requestedSchema: params.requestedSchema,
        url: params.url,
        elicitationId: params.elicitationId,
        expiresAt: record.expiresAt,
      });
    const eventType = record.kind === "input" ? "prompt" : "approval";
    const redacted = definedProperties({
      requestId: record.requestId,
      method: record.method,
      kind: payload.kind,
      redacted: true,
      expiresAt: record.expiresAt,
    });
    let publicPayload = payload;
    if (record.kind === "approval") {
      try {
        if (Buffer.byteLength(JSON.stringify(payload), "utf8")
          > MAX_PUBLIC_INTERACTION_PAYLOAD_BYTES) {
          publicPayload = redacted;
        }
      } catch {
        publicPayload = redacted;
      }
    }
    try {
      this.#appendTranscript(record.runId, {
        id: transcriptEventId("chat-request", record.requestId),
        kind: record.kind,
        content: { transcriptType: eventType, ...payload },
        runtimeRef: record.context.turnRef || null,
        contextExcluded: false,
        occurredAt: this.now(),
      });
    } catch (error) {
      if (!["TRANSCRIPT_SECRET_REJECTED", "TRANSCRIPT_EVENT_TOO_LARGE"].includes(error?.code)) {
        throw error;
      }
      publicPayload = redacted;
      this.#appendTranscript(record.runId, {
        id: transcriptEventId("chat-request", record.requestId),
        kind: record.kind,
        content: { transcriptType: eventType, ...redacted },
        runtimeRef: record.context.turnRef || null,
        contextExcluded: false,
        occurredAt: this.now(),
      });
    }
    try {
      this.#streamFor(record.runId).append(eventType, publicPayload);
    } catch (error) {
      if (!["RUN_EVENT_SECRET_REJECTED", "RUN_EVENT_TOO_LARGE"].includes(error?.code)) throw error;
      this.#streamFor(record.runId).append(eventType, redacted);
      publicPayload = redacted;
    }
    record.publicPayload = structuredClone(publicPayload);
    this.#notifyRunInteraction(record, "requested");
  }

  #notifyRunInteraction(record, phase) {
    if (!this.onRunInteraction) return;
    try {
      const run = this.dispatcher.getRun(record.runId);
      if (!run) return;
      const eventType = record.kind === "approval" ? "approval" : "prompt";
      const interaction = {
        phase,
        eventType,
        requestId: record.requestId,
        payload: phase === "requested" ? structuredClone(record.publicPayload) : null,
      };
      const result = this.onRunInteraction(structuredClone(run), interaction);
      if (result?.then) Promise.resolve(result).catch(() => {});
    } catch {}
  }

  async #respondApproval(input) {
    const record = this.#pendingRequest(input.runId, input.requestId, "approval");
    const run = this.dispatcher.getRun(input.runId);
    if (run.status !== "waiting_approval" || run.waitingRequestId !== input.requestId) {
      throw coordinatorError("WORK_RUN_REQUEST_MISMATCH", "WorkRun waiting approval 已变化");
    }
    if (input.choice === "session" && !runtimeApprovalSupportsSession(record.method, record.params)) {
      throw coordinatorError("WORK_RUN_APPROVAL_RESPONSE_INVALID", "当前请求不支持本会话授权");
    }
    const nativeOptions = record.params.approvalOptions;
    const nativeOption = validInteractiveApprovalOptions(nativeOptions)
      ? nativeOptions.find((option) => option.choice === input.choice) : undefined;
    if ((nativeOptions !== undefined || input.choice.startsWith("runtime:"))
      && !nativeOption && !["deny", "cancel"].includes(input.choice)) {
      throw coordinatorError("WORK_RUN_APPROVAL_RESPONSE_INVALID", "必须选择运行时实际提供的授权选项");
    }
    if (record.publicPayload?.redacted === true && !["deny", "cancel"].includes(input.choice)) {
      throw coordinatorError("WORK_RUN_APPROVAL_RESPONSE_INVALID", "授权详情不可用");
    }
    this.hostCapabilityIssuer.consumeReply(this.runCapabilityLeases.get(input.runId), input.requestId,
      { kind: "approval", sessionId: record.context.threadId, turnId: record.context.turnId });
    this.#recordInteractiveResponse(record, input);
    let response;
    if (nativeOption) {
      response = {
        decision: nativeOption.kind.startsWith("allow_") ? "accept" : "decline",
        approvalChoice: nativeOption.choice,
      };
    } else if (record.method === "item/permissions/requestApproval") {
      response = input.choice === "once" || input.choice === "session"
        ? {
          permissions: structuredClone(record.params.permissions),
          scope: input.choice === "session" ? "session" : "turn",
        }
        : { permissions: {}, scope: "turn" };
    } else {
      response = {
        decision: {
          once: "accept",
          session: "acceptForSession",
          deny: "decline",
          cancel: "cancel",
        }[input.choice],
      };
    }
    this.#fence(record.token);
    const resumed = this.#interactiveTransition(input.runId, "running", {});
    this.#fence(record.token);
    this.#streamFor(input.runId).append("status", {
      status: "running",
      requestId: input.requestId,
    });
    this.#fence(record.token);
    if (input.choice === "session" && record.sessionApprovalRule) {
      const scopes = this.hostObservers.get(record.host)?.sessionApprovalRules;
      if (scopes) {
        let rules = scopes.get(record.context.threadId);
        if (!rules) {
          if (scopes.size >= MAX_SESSION_APPROVAL_SCOPES) {
            scopes.delete(scopes.keys().next().value);
          }
          rules = new Set();
          scopes.set(record.context.threadId, rules);
        }
        rules.add(record.sessionApprovalRule);
      }
    }
    this.#settlePendingRequest(record, response);
    if (input.choice === "cancel") {
      requireMethods(record.host, ["turnInterrupt"], "RuntimeHandle turn interrupt");
      await record.host.turnInterrupt({
        sessionId: record.context.threadId,
        turnId: record.context.turnId,
      });
      this.#fence(record.token);
    }
    return Object.freeze({ requestId: input.requestId, state: "responded", run: resumed });
  }

  #respondInput(input) {
    const record = this.#pendingRequest(input.runId, input.requestId, "input");
    const run = this.dispatcher.getRun(input.runId);
    if (run.status !== "waiting_input" || run.waitingRequestId !== input.requestId) {
      throw coordinatorError("WORK_RUN_REQUEST_MISMATCH", "WorkRun waiting input 已变化");
    }
    this.hostCapabilityIssuer.consumeReply(this.runCapabilityLeases.get(input.runId), input.requestId,
      { kind: "input", sessionId: record.context.threadId, turnId: record.context.turnId });
    this.#recordInteractiveResponse(record, input);
    const response = input.action === "submit"
      ? { action: "accept", content: structuredClone(input.answers) }
      : { action: "cancel" };
    this.#fence(record.token);
    const resumed = this.#interactiveTransition(input.runId, "running", {});
    this.#fence(record.token);
    this.#streamFor(input.runId).append("status", {
      status: "running",
      requestId: input.requestId,
    });
    this.#fence(record.token);
    this.#settlePendingRequest(record, response);
    return Object.freeze({ requestId: input.requestId, state: "responded", run: resumed });
  }

  #recordInteractiveResponse(record, input) {
    const nativeLabel = validInteractiveApprovalOptions(record.params?.approvalOptions)
      ? record.params.approvalOptions.find((option) => option.choice === input.choice)?.label : undefined;
    const label = record.kind === "approval"
      ? nativeLabel ?? { once: "仅本次允许", session: "允许本次会话", deny: "拒绝", cancel: "取消" }[input.choice]
      : input.action === "cancel" ? "取消补充" : Object.entries(input.answers)
        .map(([key, value]) => {
          const field = record.params?.requestedSchema?.properties?.[key];
          return `${key}: ${field?.writeOnly === true || field?.format === "password" ? "[隐藏]" : value}`;
        }).join("\n");
    const event = {
      id: transcriptEventId("interactive-response", record.requestId), kind: "user",
      content: { transcriptType: "interaction.response", requestId: record.requestId,
        operationId: input.operationId, text: record.kind === "approval" ? `授权：${label}` : `补充：${label}` },
      runtimeRef: record.context.turnRef || null, contextExcluded: record.kind === "approval", occurredAt: this.now(),
    };
    try { this.#appendTranscript(record.runId, event); } catch (error) {
      if (!["TRANSCRIPT_SECRET_REJECTED", "TRANSCRIPT_EVENT_TOO_LARGE"].includes(error?.code)) throw error;
      this.#appendTranscript(record.runId, { ...event, content: { ...event.content,
        text: "已提交补充信息（内容未保存在会话记录中）" }, contextExcluded: true });
    }
  }

  #pendingRequest(runId, requestId, kind) {
    const record = this.pendingRequests.get(requestId);
    if (!record || record.settled || record.runId !== runId || record.kind !== kind) {
      throw coordinatorError("WORK_RUN_REQUEST_MISMATCH", "用户响应与 pending request 不匹配");
    }
    if (record.expiresAt !== null && this.now() >= record.expiresAt) {
      throw coordinatorError("WORK_RUN_REQUEST_MISMATCH", "交互请求已过期");
    }
    const assignment = this.runHostAssignments.get(runId);
    if (assignment !== record.assignment) {
      throw coordinatorError("WORK_RUN_REQUEST_MISMATCH", "pending request Host assignment 已变化");
    }
    return record;
  }

  #settlePendingRequest(record, response) {
    if (record.settled) return false;
    record.settled = true;
    if (record.abortHandler) record.abortSignal?.removeEventListener("abort", record.abortHandler);
    if (record.timer !== null) {
      try { this.promptScheduler.clear(record.timer); } catch {}
      record.timer = null;
    }
    this.pendingRequests.delete(record.requestId);
    this.#notifyRunInteraction(record, "resolved");
    let outcome = "canceled";
    if (record.kind === "input" && response?.action === "accept") outcome = "accepted";
    if (record.kind === "approval") {
      if (["accept", "acceptForSession"].includes(response?.decision)) outcome = "accepted";
      else if (response?.decision === "decline") outcome = "denied";
      else if (response?.permissions && Object.keys(response.permissions).length > 0) outcome = "accepted";
    }
    this.#appendPerformanceStage(
      record.runId,
      record.kind === "approval" ? "approval_wait" : "input_wait",
      record.waitingStartedAt,
      outcome,
    );
    record.params = null;
    record.resolveResponse(response);
    return true;
  }

  #cancellationResponse(record) {
    return record.kind === "input"
      ? { action: "cancel" }
      : record.method === "item/permissions/requestApproval"
        ? { permissions: {}, scope: "turn" }
        : { decision: "cancel" };
  }

  #settlePendingForAbort(runId, assignment = null) {
    let settled = 0;
    for (const record of [...this.pendingRequests.values()]) {
      if (record.runId !== runId || (assignment !== null && record.assignment !== assignment)) continue;
      if (this.#settlePendingRequest(record, this.#cancellationResponse(record))) settled += 1;
    }
    return settled;
  }

  #cancelAllPendingRequests() {
    for (const record of [...this.pendingRequests.values()]) {
      this.#settlePendingRequest(record, this.#cancellationResponse(record));
    }
  }

  #timeoutPendingRequest(requestId) {
    const record = this.pendingRequests.get(requestId);
    if (!record || record.settled) return;
    this.#settlePendingRequest(record, this.#cancellationResponse(record));
    this.#chainRunTask(record.runId, async () => {
      this.lastErrors.delete(record.runId);
      try {
        const assignment = this.runHostAssignments.get(record.runId);
        if (assignment !== record.assignment) return;
        this.#fence(record.token);
        const run = this.dispatcher.getRun(record.runId);
        if (!run || !["waiting_approval", "waiting_input"].includes(run.status)
          || run.waitingRequestId !== record.requestId) return;
        try {
          requireMethods(record.host, ["turnInterrupt"], "RuntimeHandle turn interrupt");
          await record.host.turnInterrupt({
            sessionId: record.context.threadId,
            turnId: record.context.turnId,
          });
        } catch {
          // timeout 是本地 durable 决策；Host 已终止或 interrupt 失败也必须释放等待状态。
        }
        this.#fence(record.token);
        return this.#interruptForPromptTimeout(record.runId, record.token);
      } catch (error) {
        this.lastErrors.set(record.runId, error);
        throw error;
      }
    });
  }

  async #interruptForPromptTimeout(runId, token) {
    this.#fence(token);
    return this.#withTerminalizing(runId, async () => {
      let terminal;
      try {
        this.#fence(token);
        terminal = this.dispatcher.transition(runId, "interrupted", {
          errorCode: "CODEX_PROMPT_TIMEOUT",
        });
      } catch (error) {
        if (error?.code === "STORE_COMMIT_UNCERTAIN") this.#poison(error);
        throw error;
      }
      this.#fence(token);
      try {
        this.#appendTerminal(runId, {
          status: "interrupted",
          resultSummary: null,
          errorCode: "CODEX_PROMPT_TIMEOUT",
        });
      } catch (error) {
        this.#poison(error);
        throw error;
      }
      this.#fence(token);
      try {
        await this.#completeCommandForRun(terminal, () => this.#fence(token));
      } catch (error) {
        this.#poison(error);
        throw error;
      }
      this.#fence(token);
      this.#releaseTerminalRun(runId);
      await this.#drainQueuedRuns(token.lifecycle);
      return terminal;
    });
  }

  async #interruptForHostTermination(runId, token, errorCode = "CODEX_HOST_TERMINATED") {
    this.#fence(token);
    const run = this.dispatcher.getRun(runId);
    if (!run || !ACTIVE_RUN_STATES.has(run.status)) return run;
    return this.#withTerminalizing(runId, async () => {
      let terminal;
      try {
        this.#fence(token);
        terminal = this.dispatcher.transition(runId, "interrupted", {
          errorCode,
        });
      } catch (error) {
        if (error?.code === "STORE_COMMIT_UNCERTAIN") this.#poison(error);
        throw error;
      }
      this.#fence(token);
      try {
        this.#appendTerminal(runId, {
          status: "interrupted",
          resultSummary: null,
          errorCode,
        });
      } catch (error) {
        this.#poison(error);
        throw error;
      }
      this.#fence(token);
      try {
        await this.#completeCommandForRun(terminal, () => this.#fence(token));
      } catch (error) {
        this.#poison(error);
        throw error;
      }
      this.#fence(token);
      this.#releaseTerminalRun(runId);
      await this.#drainQueuedRuns(token.lifecycle);
      return terminal;
    });
  }

  async #interruptForLostExecutionContract(runId, lifecycle, errorCode = "EXECUTION_CONTRACT_LOST") {
    this.#fenceLifecycle(lifecycle);
    return this.#withTerminalizing(runId, async () => {
      let terminal;
      try {
        this.#fenceLifecycle(lifecycle);
        terminal = this.dispatcher.transition(runId, "interrupted", {
          errorCode,
        });
      } catch (error) {
        if (error?.code === "STORE_COMMIT_UNCERTAIN") this.#poison(error);
        throw error;
      }
      this.#fenceLifecycle(lifecycle);
      try {
        this.#appendTerminal(runId, {
          status: "interrupted",
          resultSummary: null,
          errorCode,
        });
      } catch (error) {
        this.#poison(error);
        throw error;
      }
      this.#fenceLifecycle(lifecycle);
      try {
        await this.#completeCommandForRun(
          terminal,
          () => this.#fenceLifecycle(lifecycle),
        );
      } catch (error) {
        this.#poison(error);
        throw error;
      }
      this.#fenceLifecycle(lifecycle);
      this.#releaseTerminalRun(runId);
      return terminal;
    });
  }

  #recordRuntimePerformanceEvent(runId, event) {
    const state = this.runPerformance.get(runId);
    const federationToolName = canonicalFederationResultToolName(event.tool);
    if (!state) return federationToolName
      ? { durationMs: null, federationToolName } : null;
    if (!state.firstRuntimeEventSeen && state.turnStartedAt !== null
      && [
        "text_delta", "text", "reasoning_delta", "reasoning", "plan", "tool_start",
      ].includes(event.type)) {
      state.firstRuntimeEventSeen = true;
      this.#appendPerformanceStage(
        runId,
        "first_runtime_event",
        state.turnStartedAt,
        "success",
      );
    }
    const toolCallId = event.toolCallId ?? event.itemId;
    if (typeof toolCallId !== "string" || toolCallId.length === 0) return federationToolName
      ? { durationMs: null, federationToolName } : null;
    if (event.type === "tool_start") {
      state.toolStartedAt.set(toolCallId, this.now());
      if (federationToolName) state.federationToolNames.set(toolCallId, federationToolName);
      else state.federationToolNames.delete(toolCallId);
      return { durationMs: null, federationToolName };
    }
    if (event.type !== "tool_result") return null;
    const correlatedFederationToolName = federationToolName
      ?? state.federationToolNames.get(toolCallId) ?? null;
    state.federationToolNames.delete(toolCallId);
    const startedAt = state.toolStartedAt.get(toolCallId);
    if (startedAt === undefined) return correlatedFederationToolName
      ? { durationMs: null, federationToolName: correlatedFederationToolName } : null;
    state.toolStartedAt.delete(toolCallId);
    const performanceEvent = this.#appendPerformanceStage(
      runId,
      "tool_execution",
      startedAt,
      event.tool?.status === "failed" ? "error" : "success",
      { toolKind: event.tool?.kind },
    );
    return {
      durationMs: Number.isSafeInteger(performanceEvent?.payload?.durationMs)
        ? performanceEvent.payload.durationMs : null,
      federationToolName: correlatedFederationToolName,
    };
  }

  #routeRuntimeAccountBackoff(host, event) {
    if (!["account_backoff", "account_available", "account_unavailable"].includes(event.type)) return false;
    if (!this.runtimeAccountAdmission || host?.runtime !== "codex"
      || typeof host.runtimeAccountId !== "string") return true;
    const observer = this.hostObservers.get(host);
    if (!observer) return true;
    if (event.type === "account_available") {
      // The run that observed exhaustion may already have finished. A bound
      // host (including a peer Agent on the same account) may report recovery,
      // but a host from before logout/account changes must not clear it.
      const admission = observer.runtimeAccountAdmission;
      if (!admission || admission.runtimeAccountId !== host.runtimeAccountId) return true;
      try {
        this.runtimeAccountAdmission.noteRateLimitBackoff({ ...admission, retryAt: 0 });
      } catch (error) {
        if (ownDataErrorCode(error) !== "RUNTIME_ACCOUNT_GENERATION_STALE") throw error;
      }
      return true;
    }
    const errorCode = event.type === "account_unavailable" ? event.errorCode : null;
    if (errorCode !== null
      && !["RUNTIME_QUOTA_EXHAUSTED", "RUNTIME_SPENDING_LIMIT_REACHED"].includes(errorCode)) return true;
    const current = this.now();
    if (!Number.isSafeInteger(current) || current < 0
      || (!(errorCode !== null && event.retryAt === null)
        && (!Number.isSafeInteger(event.retryAt) || event.retryAt <= current
          || event.retryAt - current > MAX_TRUSTED_ACCOUNT_BACKOFF_MS))) return true;
    const accounts = new Set();
    for (const [runId, assignment] of this.runHostAssignments) {
      const run = this.dispatcher.getRun(runId);
      const admission = this.runAccountAdmissions.get(runId);
      if (!run || !ACTIVE_RUN_STATES.has(run.status) || !admission
        || assignment.host !== host || assignment.runtime !== "codex"
        || assignment.runtimeAccountId !== host.runtimeAccountId
        || assignment.runtimeAccountId !== admission.runtimeAccountId
        || assignment.lifecycle !== this.lifecycleGeneration
        || assignment.generation !== this.runGenerations.get(runId)
        || accounts.has(admission.runtimeAccountId)) continue;
      try {
        this.runtimeAccountAdmission.assertGeneration(admission);
      } catch (error) {
        if (ownDataErrorCode(error) === "RUNTIME_ACCOUNT_GENERATION_STALE") continue;
        throw error;
      }
      this.runtimeAccountAdmission.noteRateLimitBackoff({
        ...admission,
        retryAt: event.retryAt,
        ...(errorCode === null ? {} : { errorCode }),
      });
      accounts.add(admission.runtimeAccountId);
    }
    return true;
  }

  #publishRuntimeContext(profileId, sessionKey, host, rawUsage) {
    try {
      const usage = validateRuntimeContextUsage(rawUsage);
      const session = sessionKey && this.chatSessionStore.getSession(sessionKey);
      if (!session || session.profileId !== profileId || runtimeSessionIdOf(session) !== usage.runtimeSessionId) return;
      const key = this.#runtimeContextKey(session);
      if (key === null) return;
      const previous = this.runtimeContextUsage.get(key);
      if (previous && previous.usage.observedAt > usage.observedAt) return;
      this.runtimeContextUsage.delete(key);
      this.runtimeContextUsage.set(key, { usage, host, profileId, sessionKey, key });
      if (Number.isSafeInteger(usage.contextWindow) && usage.contextWindow > 0) {
        const profile = this.productStore.resolveAgentRuntimeProfile?.(profileId, session.runtimeBindingId)
          || this.productStore.getAgentProfile(profileId);
        const modelKey = this.#modelContextKey(session, profile);
        this.runtimeContextWindows.delete(modelKey); this.runtimeContextWindows.set(modelKey, usage);
        while (this.runtimeContextWindows.size > 512) this.runtimeContextWindows.delete(this.runtimeContextWindows.keys().next().value);
        try { this.runtimeContextCache?.put(modelKey, usage); } catch {}
      }
      this.telemetry.record("runtime.context.usage_updated", { sessionKey, quality: usage.quality || "unknown" });
      try { this.runtimeContextCache?.put(key, usage); } catch {}
      while (this.runtimeContextUsage.size > 512) this.runtimeContextUsage.delete(this.runtimeContextUsage.keys().next().value);
      if (sessionKey) Promise.resolve(this.onRuntimeContextChanged({ profileId, sessionKey })).catch(() => {});
    } catch { /* Observational projections cannot change execution outcomes. */ }
  }

  invalidateRuntimeContext(sessionKey, host = null) {
    const session = this.chatSessionStore.getSession(sessionKey);
    const sessionId = runtimeSessionIdOf(session);
    if (!sessionId) return;
    const key = this.#runtimeContextKey(session);
    const cached = this.runtimeContextUsage.get(key);
    this.#publishRuntimeContext(session.profileId, sessionKey, host ?? cached?.host ?? null,
      unknownRuntimeContextUsage(sessionId, { observedAt: this.now() }));
  }

  #routeHostEvent(host, event, allowBuffer = true) {
    if (this.poisonError || !["opening", "open"].includes(this.state) || event?.known !== true) return;
    if (this.#routeRuntimeAccountBackoff(host, event)) return;
    const eventSessionId = event.sessionId ?? event.threadId;
    const contextEvent = ["context_usage", "context_compacted"].includes(event.type);
    const match = [...this.runContexts.entries()].find(([runId, context]) => (
      context.host === host
      && context.generation === this.runGenerations.get(runId)
      && eventSessionId === context.threadId
      && (event.turnId === context.turnId || (contextEvent && event.turnId == null))
    ));
    if (!match) {
      if (contextEvent && this.getNativeRuntimeConfig()?.flags?.runtimeContextLifecycleV1) {
        for (const cached of this.runtimeContextUsage.values()) {
          if (cached.host !== host || cached.usage.runtimeSessionId !== eventSessionId) continue;
          const session = cached.sessionKey && this.chatSessionStore.getSession(cached.sessionKey);
          if (session && session.profileId === cached.profileId && runtimeSessionIdOf(session) === eventSessionId
            && this.#runtimeContextKey(session) === cached.key) {
            this.#publishRuntimeContext(cached.profileId, cached.sessionKey, host, event.contextUsage);
            if (event.type === "context_compacted" && event.contextUsage?.runtimeSessionId === eventSessionId) {
              this.transcriptStore?.appendEvent({ profileId: session.profileId, sessionId: session.id,
                id: transcriptEventId("native-context-compacted", eventSessionId, event.contextUsage.observedAt),
                kind: "status", contextExcluded: true,
                content: { transcriptType: "context.native.compacted", runtimeSessionId: eventSessionId }, occurredAt: this.now() });
            }
            return;
          }
        }
      }
      const observer = this.hostObservers.get(host);
      if (allowBuffer && observer
        && typeof eventSessionId === "string" && eventSessionId.length > 0
        && ((typeof event.turnId === "string" && event.turnId.length > 0) || contextEvent)
        && [
          "text_delta", "text", "reasoning_delta", "reasoning", "plan",
          "tool_start", "tool_update", "tool_result", "status", "complete", "usage", "context_usage", "context_compacted",
        ].includes(event.type)) {
        observer.pendingEvents.push(event);
        if (observer.pendingEvents.length > 256) observer.pendingEvents.shift();
      }
      return;
    }
    const [runId, context] = match;
    const run = this.dispatcher.getRun(runId);
    if (!run || !ACTIVE_RUN_STATES.has(run.status)
      || runtimeSessionIdOf(run) !== context.threadId
      || runtimeTurnIdOf(run) !== context.turnId) return;
    if (contextEvent) {
      if (!this.getNativeRuntimeConfig()?.flags?.runtimeContextLifecycleV1) return;
      if (event.contextUsage?.runtimeSessionId === context.threadId) {
        this.#publishRuntimeContext(run.profileId, this.getRunSessionKey(run), host, event.contextUsage);
        if (event.type === "context_compacted") this.#appendTranscript(runId, {
          id: transcriptEventId("native-context-compacted", runId, event.contextUsage.observedAt), kind: "status", contextExcluded: true,
          content: { transcriptType: "context.native.compacted", runtimeSessionId: context.threadId }, occurredAt: this.now(),
        });
      }
      return;
    }
    const toolObservation = this.#recordRuntimePerformanceEvent(runId, event);
    const toolDurationMs = toolObservation?.durationMs ?? null;
    const federationToolName = toolObservation?.federationToolName ?? null;
    if (event.type === "usage") {
      if (!this.usageStore || event.usage === null || typeof event.responseId !== "string") return;
      const profile = this.productStore.getAgentProfile(run.profileId);
      if (!profile) return;
      const execution = this.runExecutionContracts.get(runId);
      const runtimeModel = typeof event.model === "string" && event.model.length > 0
        && event.model.isWellFormed() && !event.model.includes("\0")
        && Buffer.byteLength(event.model, "utf8") <= 512 ? event.model : null;
      const runtimeProvider = typeof event.provider === "string" && event.provider.length > 0
        && event.provider.isWellFormed() && !event.provider.includes("\0")
        && Buffer.byteLength(event.provider, "utf8") <= 512 ? event.provider : null;
      try {
        this.usageStore.record({
          profileId: run.profileId,
          runId: run.id,
          runtime: execution?.runtime ?? context.runtimeBinding?.runtime,
          runtimeAccountId: execution?.runtimeAccountId ?? context.runtimeAccountId,
          agentId: profile.agentId || profile.id,
          agentName: profile.name || profile.agentId || profile.id,
          source: run.source,
          sourceId: run.sourceId,
          threadId: context.threadId,
          turnId: context.turnId,
          responseId: event.responseId,
          model: runtimeModel ?? execution?.defaultModel ?? profile.defaultModel ?? null,
          provider: runtimeProvider ?? execution?.provider?.providerRef ?? profile.providerRef ?? null,
          usage: event.usage,
          ...(typeof event.costUsd === "number" && Number.isFinite(event.costUsd) && event.costUsd >= 0
            ? { costUsd: event.costUsd } : {}),
          createdAt: Number.isSafeInteger(event.createdAt) && event.createdAt >= (run.startedAt ?? run.createdAt)
            && event.createdAt <= this.now() ? event.createdAt : this.now(),
        });
      } catch {
        // 用量统计是旁路观测，落盘故障不得反向中断已被模型接受的对话。
        // TokenUsageStore 对 commit-uncertain 会自行 fail closed，管理页不会伪报零值。
      }
      return;
    }
    if (event.type === "complete") {
      this.#chainRunTask(runId, async () => {
        this.lastErrors.delete(runId);
        try {
          await this.#reconcileTerminalAfterSignal(runId, context);
        } catch (error) {
          this.lastErrors.set(runId, error);
          throw error;
        }
      });
      return;
    }
    const type = {
      text_delta: "text.delta",
      text: "text",
      reasoning_delta: "reasoning.delta",
      reasoning: "reasoning",
      plan: "plan",
      tool_start: "tool.start",
      tool_update: "tool.update",
      tool_result: "tool.result",
      status: "status",
    }[event.type];
    if (!type) return;
    const common = { method: event.method, itemId: event.itemId, toolCallId: event.toolCallId };
    const payload = {
      "text.delta": () => ({ ...common, delta: event.delta }),
      text: () => ({ ...common, text: event.text, phase: event.phase, delivery: event.delivery }),
      "reasoning.delta": () => ({
        ...common,
        delta: event.delta,
        summaryIndex: event.summaryIndex,
        contentIndex: event.contentIndex,
      }),
      reasoning: () => ({ ...common, reasoning: event.reasoning, summaryIndex: event.summaryIndex }),
      plan: () => ({
        ...common,
        explanation: event.explanation,
        plan: event.plan,
        text: event.text,
        delta: event.delta,
      }),
      "tool.start": () => ({
        ...common,
        tool: publicToolDescriptor(event.tool, {
          runId,
          toolNameOverride: federationToolName,
          sanitizeSummary: this.sanitizeSummary,
          assertSecretSafe: this.assertSecretSafe,
        }),
      }),
      "tool.update": () => ({
        ...common,
        delta: event.delta,
        patch: event.patch,
        progress: event.progress,
        changes: event.changes,
        message: event.message,
      }),
      "tool.result": () => ({
        ...common,
        tool: publicToolDescriptor(event.tool, {
          runId,
          toolNameOverride: federationToolName,
          sanitizeSummary: this.sanitizeSummary,
          assertSecretSafe: this.assertSecretSafe,
          durationMs: toolDurationMs,
          pluginAppCallId: require("../core/plugin-app-call-reference").extractPluginAppCallId(
            event.contextTool?.output ?? event.tool?.output ?? event.output),
        }),
      }),
      status: () => ({ method: event.method, status: event.status,
        ...(event.status === "retrying" && event.reason === "RUNTIME_RATE_LIMITED"
          ? { reason: event.reason } : {}) }),
    }[type]();
    let publicPayload = definedProperties(payload);
    if (!["text.delta", "reasoning.delta", "tool.update"].includes(type)) {
      const transcriptKind = type === "text" ? "assistant"
        : type === "tool.start" ? "tool_call"
          : type === "tool.result" ? "tool_result" : "status";
      const eventId = transcriptEventId(
        "runtime-event", runId, type, event.itemId ?? null, event.toolCallId ?? null, publicPayload,
      );
      try {
        this.#appendTranscript(runId, {
          id: eventId,
          kind: transcriptKind,
          content: { transcriptType: type, ...publicPayload },
          ...(type === "text" && (event.contextText !== undefined || event.contextIncomplete) ? {
            contextContent: { transcriptType: type, ...publicPayload, text: event.contextText ?? publicPayload.text,
              contextComplete: event.contextIncomplete !== true },
          } : {}),
          ...(["tool.start", "tool.result"].includes(type) && event.tool ? {
            contextContent: { transcriptType: type, ...common, contextComplete: event.contextTool !== undefined,
              tool: definedProperties({
              name: event.tool.name, kind: event.tool.kind, status: event.tool.status,
              arguments: event.contextTool?.input ?? event.tool.arguments ?? event.tool.input,
              output: event.contextTool?.output ?? event.tool.output, success: event.tool.success,
              exitCode: event.tool.exitCode,
            }) },
          } : {}),
          runtimeRef: context.turnRef || null,
          contextExcluded: false,
          occurredAt: this.now(),
        });
      } catch (error) {
        if (!["TRANSCRIPT_SECRET_REJECTED", "TRANSCRIPT_EVENT_TOO_LARGE"].includes(error?.code)) {
          throw error;
        }
        publicPayload = definedProperties({
          method: event.method,
          itemId: event.itemId,
          toolCallId: event.toolCallId,
          redacted: true,
          ...(type === "text" ? { text: "[REDACTED]", phase: event.phase } : {}),
        });
        this.#appendTranscript(runId, {
          id: eventId,
          kind: transcriptKind,
          content: { transcriptType: type, ...publicPayload },
          runtimeRef: context.turnRef || null,
          contextExcluded: false,
          occurredAt: this.now(),
        });
      }
    }
    this.#streamFor(runId).append(type, publicPayload);
  }

  #flushPendingHostEvents(host, context) {
    const observer = this.hostObservers.get(host);
    if (!observer || observer.pendingEvents.length === 0) return;
    const matching = [];
    observer.pendingEvents = observer.pendingEvents.filter((event) => {
      const eventSessionId = event.sessionId ?? event.threadId;
      if (eventSessionId !== context.threadId || (event.turnId !== context.turnId
        && !(["context_usage", "context_compacted"].includes(event.type) && event.turnId == null))) return true;
      matching.push(event);
      return false;
    });
    for (const event of matching) this.#routeHostEvent(host, event, false);
  }

  #queuedAdmission(run, reason, retryAt = null) {
    const previous = this.runQueueStates.get(run.id);
    const queuedAt = previous?.queuedAt ?? this.queueArrivalTimes.get(run.id) ?? this.#commandForRun(run)?.command?.createdAt ?? this.now();
    this.queueArrivalTimes.set(run.id, queuedAt);
    if (previous?.reason !== reason) {
      this.telemetry.record("runtime.admission.queued", { runId: run.id, source: run.source, reason });
      if (reason === "STARTUP_BACKPRESSURE") this.telemetry.record("runtime.startup.waiting", { runId: run.id });
    }
    const payload = { status: "queued", reason, queuedAt };
    this.runQueueStates.set(run.id, payload);
    if (previous?.reason !== reason) this.#streamFor(run.id).append("status", payload);
    // Terminals drain immediately. This bounded retry also wakes a queue when
    // an account cooldown/login ends without another running turn to wake it.
    if (this.admissionRetryTimer === null) {
      const lifecycle = this.lifecycleGeneration;
      const delay = retryAt === null ? 1_000 : Math.max(25, Math.min(1_000, retryAt - this.now()));
      this.admissionRetryTimer = setTimeout(() => {
        this.admissionRetryTimer = null;
        if (this.lifecycleGeneration !== lifecycle || !["opening", "open"].includes(this.state)) return;
        this.#drainQueuedRuns(lifecycle).catch((error) => {
          if (error?.code !== "WORK_RUN_COORDINATOR_CLOSING") this.#poison(error);
        });
      }, delay);
      this.admissionRetryTimer.unref?.();
    }
    return { disposition: "queued", reason, run };
  }

  async #rejectAccountAdmission(run, errorCode, lifecycle) {
    // Quota exhaustion is terminal, not a scheduled future send. Preserve the
    // same durable terminal -> event -> Inbox tombstone order as runtime failure.
    return this.#withTerminalizing(run.id, async () => {
      try {
        this.#fenceLifecycle(lifecycle);
        const terminal = this.dispatcher.transition(run.id, "failed", { errorCode });
        this.runQueueStates.delete(run.id);
        this.#appendTerminal(run.id, { status: "failed", resultSummary: null, errorCode });
        this.#fenceLifecycle(lifecycle);
        await this.#completeCommandForRun(terminal, () => this.#fenceLifecycle(lifecycle));
        this.#fenceLifecycle(lifecycle);
        this.#releaseTerminalRun(run.id);
        return { disposition: "completed", reason: null, run: terminal };
      } catch (error) {
        if (error?.code !== "WORK_RUN_COORDINATOR_CLOSING") this.#poison(error);
        throw error;
      }
    });
  }

  #admit(runId, profileId, lifecycle = null) {
    if (this.admissionsQuiesced) {
      return this.#queuedAdmission(this.dispatcher.getRun(runId), "SERVICE_QUIESCED");
    }
    const profile = this.productStore.getAgentProfile(profileId);
    if (!profile) {
      throw coordinatorError("UNKNOWN_AGENT_PROFILE", `AgentProfile 不存在: ${profileId}`);
    }
    const run = this.dispatcher.getRun(runId);
    const sessionKey = this.getRunSessionKey(run);
    const sessionRuns = sessionKey ? this.listSessionRuns(sessionKey) : [];
    // A native turn may be compacting its own history. Wait for its terminal
    // observation before planning a product summary for the next queued turn.
    if (sessionRuns.some(candidate => candidate.id !== run.id && ACTIVE_RUN_STATES.has(candidate.status))) {
      return this.#queuedAdmission(run, "CHAT_SESSION_BUSY");
    }
    if (run.source !== "compaction" && sessionKey && this.conversationCheckpointStore
      && this.getNativeRuntimeConfig()?.flags?.runtimeContextLifecycleV1) {
      const session = this.chatSessionStore.getSession(sessionKey);
      if (session) this.#refreshCheckpointSession(session);
    }
    let executionContract;
    try { executionContract = this.#executionContract(profile, run); }
    catch (error) {
      if (/^CONTEXT_/u.test(error?.code || "")) return { disposition: "rejected", reason: error.code, run };
      throw error;
    }
    const requestPlan = executionContract.contextRequest;
    if (requestPlan && (requestPlan.fixedTokens > requestPlan.limitTokens || requestPlan.fixedTransportExceeded)) {
      return { disposition: "rejected", reason: "CONTEXT_INPUT_TOO_LARGE", run };
    }
    if (run.source !== "compaction" && sessionKey && this.conversationCheckpointStore
      && this.getNativeRuntimeConfig()?.flags?.runtimeContextLifecycleV1) {
      const storedSession = this.chatSessionStore.getSession(sessionKey);
      const session = storedSession && this.#refreshCheckpointSession(storedSession);
      if (session && this.#summaryProfile(session)) {
        const currentOperationId = this.#commandForRun(run)?.command?.operationId ?? null;
        let plan;
        try { plan = this.#planConversationCompaction(session, { requestPlan, currentOperationId }); }
        catch (error) {
          if (/^CONTEXT_/u.test(error?.code || "")) return { disposition: "rejected", reason: error.code, run };
          throw error;
        }
        if (plan) {
          const identity = `${plan.previousId}:${plan.throughSeq}:${plan.coveredHash}`;
          let barrier = this.compactionBarriers.get(sessionKey);
          if (!barrier || barrier.identity !== identity) {
            barrier = { identity, error: null, waiting: false }; this.compactionBarriers.set(sessionKey, barrier);
          }
          if (barrier.error) return { disposition: "rejected", reason: barrier.error, run };
          if (!barrier.waiting) {
            barrier.waiting = true;
            void this.#prepareConversationCompaction(session, { requestPlan, currentOperationId }).then(summary => {
              if (summary && ["failed", "interrupted", "canceled"].includes(summary.status)) barrier.error = "PRODUCT_COMPACTION_FAILED";
            }).catch(() => { barrier.error = "PRODUCT_COMPACTION_FAILED"; }).finally(() => { barrier.waiting = false; });
          }
          return this.#queuedAdmission(run, "CHAT_SESSION_BUSY");
        }
        this.compactionBarriers.delete(sessionKey);
      }
    }
    if (requestPlan && (requestPlan.exceedsBudget || requestPlan.transportExceeded || (executionContract.contextFresh && requestPlan.historyTruncated))) {
      return { disposition: "rejected", reason: "CONTEXT_COMPACTION_REQUIRED", run };
    }
    const sessionBusy = sessionRuns.some((candidate) => candidate.id !== run.id
      && ACTIVE_RUN_STATES.has(candidate.status))
      || (run.source !== "compaction" && this.getNativeRuntimeConfig()?.flags?.runtimeAdmissionV1
        && sessionRuns.slice(0, sessionRuns.findIndex((candidate) => candidate.id === runId))
          .some((candidate) => candidate.status === "queued" && this.#commandForRun(candidate)));
    // execution contract 必须在 durable 状态进入 starting 前完整可构建；否则
    // 准入写入成功、随后校验失败会留下永远占槽的 starting Run。
    if (lifecycle !== null) this.#fenceLifecycle(lifecycle);
    const accountAdmission = this.runtimeAccountAdmission?.admit({
      runtimeAccountId: executionContract.runtimeAccountId,
      runId,
    }) || null;
    if (accountAdmission?.disposition === "rejected") {
      return { disposition: "rejected", reason: accountAdmission.reason, run };
    }
    if (sessionBusy) {
      if (accountAdmission?.disposition === "started") {
        this.runtimeAccountAdmission.release({ runtimeAccountId: executionContract.runtimeAccountId, runId });
      }
      return this.#queuedAdmission(run, "CHAT_SESSION_BUSY");
    }
    const nativePolicy = require("./execution-policy").resolveAdmissionPolicy(this.getNativeRuntimeConfig());
    const globalFull = nativePolicy.enabled && this.dispatcher.listRuns()
      .filter((candidate) => ACTIVE_RUN_STATES.has(candidate.status)).length >= nativePolicy.maxActive;
    if (accountAdmission?.disposition === "queued") {
      return this.#queuedAdmission(run, globalFull && accountAdmission.reason === "RUNTIME_ACCOUNT_ACTIVE_LIMIT"
        ? "GLOBAL_CAPACITY" : accountAdmission.reason, accountAdmission.retryAt);
    }
    if (globalFull || (this.startupGate && !this.startupGate.acquire(runId))) {
      if (accountAdmission) this.runtimeAccountAdmission.release({ runtimeAccountId: executionContract.runtimeAccountId, runId });
      return this.#queuedAdmission(run, globalFull ? "GLOBAL_CAPACITY" : "STARTUP_BACKPRESSURE");
    }
    let admission;
    try {
      if (lifecycle !== null) this.#fenceLifecycle(lifecycle);
      this.pluginRuntimeToolService?.captureRun({ ...run, status: "starting" });
      admission = this.dispatcher.admit(runId, {
        onBusy: "queue",
        writable: executionContract.permissionPolicy.sandbox !== "read-only",
        ...(executionContract.contextSnapshotId === null
          ? {} : { contextSnapshotId: executionContract.contextSnapshotId }),
      });
    } catch (error) {
      this.pluginRuntimeToolService?.releaseRun(runId);
      this.startupGate?.release(runId);
      if (accountAdmission) {
        this.runtimeAccountAdmission.release({
          runtimeAccountId: executionContract.runtimeAccountId,
          runId,
        });
      }
      throw error;
    }
    if (admission.disposition === "started") {
      this.telemetry.record("runtime.admission.admitted", { runId, source: run.source });
      this.telemetry.record("runtime.startup.started", { runId });
      this.fairQueue.admitted(run, this.dispatcher.listRuns()
        .filter(candidate => candidate.status === "queued").map(candidate => candidate.source));
      this.queueArrivalTimes.delete(runId);
      this.runQueueStates.delete(runId);
      const admittedContract = Object.freeze({
        ...executionContract,
        runtimeAccountGeneration: accountAdmission?.generation ?? null,
      });
      this.runExecutionContracts.set(runId, admittedContract);
      if (accountAdmission) {
        this.runAccountAdmissions.set(runId, Object.freeze({
          runtimeAccountId: executionContract.runtimeAccountId,
          generation: accountAdmission.generation,
        }));
      }
      try {
        this.#streamFor(runId).append("status", { status: "starting" });
      } catch (error) {
        this.#poison(error);
        throw error;
      }
    } else if (accountAdmission) {
      this.runtimeAccountAdmission.release({
        runtimeAccountId: executionContract.runtimeAccountId,
        runId,
      });
    }
    if (admission.disposition !== "started") {
      this.pluginRuntimeToolService?.releaseRun(runId);
      this.startupGate?.release(runId);
    }
    return admission.disposition === "queued" ? this.#queuedAdmission(run, admission.reason) : admission;
  }

  #executionContract(profile, run) {
    const boundSessionKey = this.getRunSessionKey(run);
    const boundSession = boundSessionKey ? this.chatSessionStore.getSession(boundSessionKey) : null;
    if (this.productStore.resolveAgentRuntimeProfile) {
      const summaryBindingId = run.source === "compaction" ? this.domainCommands.get(run.id)?.bindingId : null;
      profile = this.productStore.resolveAgentRuntimeProfile(profile.id, summaryBindingId ?? boundSession?.runtimeBindingId ?? undefined);
    }
    let defaultModel = profile.defaultModel;
    let sessionModelOverride = null;
    let sessionPermissionMode = null;
    let modelSettings;
    let transcriptSessionId = null;
    const sessionKey = this.getRunSessionKey(run);
    if (sessionKey) {
      const session = this.chatSessionStore.getSession(sessionKey);
      if (!session || session.profileId !== run.profileId) {
        throw coordinatorError("CHAT_SESSION_NOT_FOUND", "WorkRun 的 ChatSession binding 无效");
      }
      sessionModelOverride = session.modelOverride ?? null;
      sessionPermissionMode = session.permissionMode ?? null;
      modelSettings = session.modelSettings;
      transcriptSessionId = session.id;
      defaultModel = sessionModelOverride ?? defaultModel;
    }
    if (run.source === "compaction") {
      // A model identifier from the chatting Runtime is not a route on the
      // separately authorized summary Runtime. Use that Runtime's default.
      defaultModel = this.domainCommands.get(run.id)?.summaryModel ?? null;
      sessionModelOverride = null; modelSettings = undefined;
    }
    const resolvedPermission = run.source === "compaction"
      ? { mode: null, nativeMode: null, permissionPolicy: Object.freeze({ approvalPolicy: "never", sandbox: "read-only" }) }
      : resolveRuntimePermissionMode(
      profile.runtime || "codex",
      sessionPermissionMode,
      profile.permissionPolicy,
    );
    if (run.workspace === null && resolvedPermission.permissionPolicy.sandbox !== "read-only") {
      throw coordinatorError(
        "WORKSPACE_REQUIRED_FOR_WRITABLE_RUN",
        "writable WorkRun 必须绑定显式 execution workspace",
      );
    }
    const command = this.#commandForRun(run)?.command || null;
    const handoff = !!boundSession && runtimeSessionIdOf(boundSession) === null
      && boundSession.retiredRuntimeSessions?.length > 0;
    const contextLifecycleV1 = handoff || this.getNativeRuntimeConfig()?.flags?.runtimeContextLifecycleV1 === true;
    const handoffSeed = handoff ? require("./runtime-handoff-seed").runtimeHandoffSeed(boundSession, profile) : null;
    const budgetSession = boundSession ?? { id: run.id, profileId: profile.id, runtimeSessionId: null,
      runtimeBindingId: profile.selectedBindingId ?? profile.defaultBindingId ?? null, modelOverride: defaultModel,
      modelSettings };
    const contextState = this.#conversationContextState(budgetSession, profile);
    // Use the same saved-copy paths and prompt wrapper as turnStart. Their
    // metadata and instructions also consume input and transport capacity.
    const currentAttachments = command?.attachments?.length && boundSessionKey
      ? prepareChatAttachments(this.getMediaStore(), command.attachments, boundSessionKey) : command?.attachments ?? [];
    const currentPrompt = attachmentPrompt(command?.prompt ?? "", currentAttachments);
    const snapshot = this.contextCompiler && run.source !== "compaction" ? this.contextCompiler.compile({
      profile,
      run,
      transcriptSessionId,
      query: command?.prompt || run.sourceId,
      contextLifecycleV1,
      currentOperationId: command?.operationId ?? null,
      nativeSessionId: runtimeSessionIdOf(boundSession),
      ...(boundSession ? { resolveAttachments: attachments => this.#contextAttachmentReferences(attachments, boundSession.sessionKey) } : {}),
      ...(contextState ? { requestBudget: contextState.budget, contextLimits: contextState.limits, nativeUsage: contextState.usage,
        currentPrompt, currentAttachments,
        freshSession: !boundSession || runtimeSessionIdOf(boundSession) === null } : {}),
      ...(contextLifecycleV1 && boundSession && runtimeSessionIdOf(boundSession) === null ? {
        // A handoff below the trigger keeps all unsummarized history that fits.
        // The 50% target applies after compaction, not to every new session.
        transcriptTokenBudget: this.#conversationContextState(boundSession, profile).budget.triggerTokens,
      } : {}),
      ...(handoff ? { handoffSeed } : {}),
    }) : null;
    return Object.freeze({
      runId: run.id,
      profileId: run.profileId,
      source: run.source,
      sourceId: run.sourceId,
      transcriptSessionId,
      runtime: profile.runtime || "codex",
      runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId,
      profileDefaultModel: profile.defaultModel,
      sessionModelOverride,
      defaultModel,
      effectiveModel: defaultModel,
      ...(this.captureExecutionProviderRoute ? this.captureExecutionProviderRoute(profile, defaultModel) : {}),
      bindingId: profile.selectedBindingId ?? profile.defaultBindingId ?? null,
      ...(modelSettings ? { modelSettings: Object.freeze({ ...modelSettings }) } : {}),
      workspace: run.workspace,
      contextSnapshotId: snapshot?.id ?? null,
      contextRequest: snapshot?.report?.request ?? null,
      contextFresh: boundSession ? runtimeSessionIdOf(boundSession) === null : true,
      toolRegistryRevision: snapshot?.revisions?.tools ?? null,
      toolPermissionRevision: snapshot?.revisions?.permission ?? null,
      developerInstructions: snapshot?.developerInstructions
        ?? (run.source === "compaction" ? "Summarize conversation data without tools or side effects." : shoggothProductDeveloperInstructions({
          source: run.source,
          sourceId: run.sourceId,
          profileName: profile.name,
          backendId: profile.backendId,
          runtime: profile.runtime || "codex",
        })),
      dynamicContext: snapshot?.dynamicContext ?? handoffSeed ?? null,
      dynamicContextWithoutTranscript: snapshot?.dynamicContextWithoutTranscript ?? null,
      contextLifecycleV1,
      permissionMode: resolvedPermission.mode,
      nativePermissionMode: resolvedPermission.nativeMode,
      permissionPolicy: resolvedPermission.permissionPolicy,
      runtimeHostPermissionPolicy: Object.freeze({
        approvalPolicy: profile.permissionPolicy?.approvalPolicy,
        sandbox: profile.permissionPolicy?.sandbox,
      }),
    });
  }

  #schedule(runId) {
    if (this.state !== "open" && this.state !== "opening") this.#assertOpen();
    const active = this.runTails.get(runId);
    if (active) return active;
    return this.#chainRunTask(runId, () => this.#runAttempt(runId));
  }

  #chainRunTask(runId, task) {
    const previous = this.runTails.get(runId) || Promise.resolve();
    const scheduled = previous.catch(() => {}).then(task);
    this.runTails.set(runId, scheduled);
    scheduled.catch(() => {});
    scheduled.finally(() => {
      if (this.runTails.get(runId) === scheduled) this.runTails.delete(runId);
    }).catch(() => {});
    return scheduled;
  }

  async #runAttempt(runId) {
    this.hostCapabilityIssuer.revoke(this.runCapabilityLeases.get(runId));
    this.runCapabilityLeases.delete(runId);
    const runGeneration = (this.runGenerations.get(runId) || 0) + 1;
    this.runGenerations.set(runId, runGeneration);
    const token = {
      lifecycle: this.lifecycleGeneration,
      run: runGeneration,
      runId,
      startupRetryUsed: false,
      controller: new AbortController(),
      hostCapacity: false,
    };
    this.startupControllers.set(runId, token.controller);
    this.lastErrors.delete(runId);
    try {
      await this.#drive(runId, token);
    } catch (error) {
      if (await this.#recoverRejectedContext(runId, token, error)) return;
      if (token.hostCapacity && !this.recoveringRuns.has(runId)) {
        this.#fence(token);
        const run = this.dispatcher.requeueBeforeDispatch(runId);
        this.#releaseRuntimeAccountAdmission(runId);
        this.runExecutionContracts.delete(runId);
    this.pluginRuntimeToolService?.releaseRun(runId);
        this.runExecutionStore?.remove(run);
        const record = this.#commandForRun(run);
        if (record?.kind === "chat" && record.command.state === "dispatching") {
          await this.inbox.transition(record.operationId, "pending");
          this.#fence(token);
        }
        this.#queuedAdmission(run, "HOST_CAPACITY");
        return;
      }
      if (await this.#quiesceUncertainStart(runId, token, error)) return;
      if (await this.#failRunStart(runId, token, error)) return;
      if (this.recoveringRuns.has(runId) && !this.poisonError) {
        this.#fence(token);
        await this.#interruptForLostExecutionContract(runId, token.lifecycle,
          publicRuntimeOperationalErrorCode(error) || (isRuntimeAuthRequired(error)
            ? RUNTIME_AUTH_REQUIRED_CODE : "RUNTIME_RECOVERY_UNAVAILABLE"));
        return;
      }
      this.lastErrors.set(runId, error);
      throw error;
    } finally {
      if (this.startupControllers.get(runId) === token.controller) this.startupControllers.delete(runId);
      const released = this.startupGate?.release(runId);
      if (released && !token.hostCapacity && token.lifecycle === this.lifecycleGeneration
        && ["opening", "open"].includes(this.state)) {
        setImmediate(() => {
          if (token.lifecycle !== this.lifecycleGeneration || !["opening", "open"].includes(this.state)) return;
          this.#drainQueuedRuns(token.lifecycle).catch((error) => this.#poison(error));
        });
      }
    }
  }

  async #recoverRejectedContext(runId, token, error) {
    const rejected = require("./context-request-budget").rejectedContextCapacity(error);
    const run = this.dispatcher.getRun(runId), contract = this.runExecutionContracts.get(runId);
    if (!rejected || !this.transcriptStore || !contract || run?.status !== "starting"
      || runtimeSessionIdOf(run) || runtimeTurnIdOf(run) || this.recoveringRuns.has(runId)
      || this.#performanceFor(runId).firstRuntimeEventSeen) return false;
    const host = this.runHostAssignments.get(runId)?.host;
    if (this.hostObservers.get(host)?.pendingEvents.some(event => (event.sessionId ?? event.threadId) === token.contextAttemptSessionId
      && ["tool_start", "tool_result", "text", "text_delta", "complete"].includes(event.type))) return false;
    const sessionKey = this.getRunSessionKey(run), session = sessionKey && this.chatSessionStore.getSession(sessionKey);
    if (!session) return false;
    const marker = transcriptEventId("context-capacity-retry", runId);
    if (this.transcriptStore.listEvents(session.profileId, session.id).some(event => event.id === marker)) return false;
    const profile = this.productStore.resolveAgentRuntimeProfile?.(session.profileId, session.runtimeBindingId)
      || this.productStore.getAgentProfile(session.profileId);
    const previous = this.#conversationContextState(session, profile).budget.tokens;
    const tokens = rejected.tokens ?? Math.max(1024, Math.floor(previous / 2));
    if (tokens >= previous) return false;
    const key = `rejected-window:${this.#modelContextKey(session, profile)}`;
    const observation = unknownRuntimeContextUsage(runtimeSessionIdOf(session) || `rejected:${runId}`, {
      contextWindow: tokens, observedAt: this.now(), source: rejected.tokens === null ? "estimate" : "runtime_event" });
    this.#appendTranscript(runId, { id: marker, kind: "status", contextExcluded: true,
      content: { transcriptType: "context.capacity.rejected", limit: tokens, confirmed: rejected.tokens !== null,
        previousSnapshotId: contract.contextSnapshotId } });
    this.contextRecoveryLimits.set(key, observation);
    while (this.contextRecoveryLimits.size > 512) this.contextRecoveryLimits.delete(this.contextRecoveryLimits.keys().next().value);
    if (rejected.tokens !== null) this.runtimeContextCache?.put(key, observation);
    this.hostCapabilityIssuer.revoke(this.runCapabilityLeases.get(runId));
    this.runCapabilityLeases.delete(runId);
    const queued = this.dispatcher.requeueBeforeDispatch(runId);
    this.#releaseRuntimeAccountAdmission(runId);
    this.runExecutionContracts.delete(runId);
    this.pluginRuntimeToolService?.releaseRun(runId);
    this.runExecutionStore?.remove(queued);
    const record = this.#commandForRun(queued);
    if (record?.kind === "chat" && record.command.state === "dispatching") await this.inbox.transition(record.operationId, "pending");
    this.#queuedAdmission(queued, "CHAT_SESSION_BUSY");
    setImmediate(() => {
      if (token.lifecycle === this.lifecycleGeneration && this.state === "open") {
        this.#drainQueuedRuns(token.lifecycle).catch(failure => this.#poison(failure));
      }
    });
    return true;
  }

  async #quiesceUncertainStart(runId, token, error) {
    if (!this.getNativeRuntimeConfig()?.flags?.runtimeAdmissionV1) return false;
    let current = error;
    let code = null;
    for (let depth = 0; depth < 8 && current; depth++) {
      if (["RUNTIME_SESSION_ACCEPTANCE_UNKNOWN", "RUNTIME_TURN_ACCEPTANCE_UNKNOWN"]
        .includes(ownDataErrorCode(current))) { code = ownDataErrorCode(current); break; }
      current = Object.getOwnPropertyDescriptor(current, "cause")?.value;
    }
    if (!code) return false;
    this.#finishContextTransfer(runId, "unknown", code);
    const contract = this.runExecutionContracts.get(runId);
    this.#fence(token);
    let timer;
    try {
      // A failed acknowledgement is not proof that the remote worker stopped.
      // Retire its profile host before returning the global reservation. The
      // adapter's bounded stop also resolves its other assigned Run observers.
      await Promise.race([
        Promise.resolve().then(() => this.runtimeManager.stop(runtimeBinding({ runtime: contract.runtime,
          runtimeProfileId: contract.runtimeProfileId, runtimeAccountId: contract.runtimeAccountId }))),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(coordinatorError("RUNTIME_STOP_UNCONFIRMED", "运行时停止结果未确认")), 5_000);
        }),
      ]);
    } catch {
      const failure = coordinatorError("RUNTIME_STOP_UNCONFIRMED", "运行时停止结果未确认");
      // Preserve the durable active reservation and stop further dispatch if
      // termination cannot be proved; never overcommit a still-running worker.
      this.#poison(failure);
      throw failure;
    } finally { clearTimeout(timer); }
    if (TERMINAL_RUN_STATES.has(this.dispatcher.getRun(runId)?.status)) return true;
    this.#fence(token);
    await this.#interruptForLostExecutionContract(runId, token.lifecycle, code);
    await this.#drainQueuedRuns(token.lifecycle);
    return true;
  }

  async #failRunStart(runId, token, error) {
    // 只收敛已准入、但尚未取得远端 thread/turn binding 的可操作启动错误。
    // lifecycle/stale/持久化失败仍保留原错误，由既有恢复或 poison 边界处理。
    const errorCode = ownDataErrorCode(error);
    if (!START_OPERATIONAL_ERROR_CODES.has(errorCode)) return false;
    try {
      this.#fence(token);
    } catch {
      return false;
    }
    let run;
    let record;
    try {
      run = this.dispatcher.getRun(runId);
      record = this.#commandForRun(run);
    } catch {
      return false;
    }
    const chatStart = run?.source === "chat" && record?.kind === "chat"
      && record.command?.state === "dispatching";
    const domainStart = ["cron", "kanban", "inspiration", "compaction"].includes(run?.source)
      && record?.kind === "domain";
    if (run?.status !== "starting" || (!chatStart && !domainStart)) return false;

    await this.#withTerminalizing(runId, async () => {
      this.#fence(token);
      const publicErrorCode = publicStartErrorCode(error);
      let terminal;
      try {
        terminal = this.dispatcher.transition(runId, "failed", {
          errorCode: publicErrorCode,
        });
      } catch (error) {
        if (error?.code === "STORE_COMMIT_UNCERTAIN") this.#poison(error);
        throw error;
      }
      this.#fence(token);
      try {
        this.#appendTerminal(runId, {
          status: "failed",
          resultSummary: null,
          errorCode: publicErrorCode,
        });
      } catch (error) {
        this.#poison(error);
        throw error;
      }
      this.#fence(token);
      try {
        await this.#completeCommandForRun(terminal, () => this.#fence(token));
      } catch (error) {
        this.#poison(error);
        throw error;
      }
      this.#fence(token);
      this.#releaseTerminalRun(runId);
      await this.#drainQueuedRuns(token.lifecycle);
    });
    return true;
  }

  #fenceLifecycle(lifecycle) {
    if (this.poisonError) throw this.poisonError;
    if (!["opening", "open"].includes(this.state)
      || lifecycle !== this.lifecycleGeneration) {
      throw coordinatorError("WORK_RUN_COORDINATOR_CLOSING", "WorkRunCoordinator lifecycle 已变化");
    }
  }

  #fence(token) {
    this.#fenceLifecycle(token.lifecycle);
    if (this.runGenerations.get(token.runId) !== token.run) {
      throw coordinatorError("WORK_RUN_COORDINATOR_STALE_RUN", `WorkRun ${token.runId} generation 已变化`);
    }
  }

  #issueRunCapability(token, contract) {
    this.hostCapabilityIssuer.revoke(this.runCapabilityLeases.get(token.runId));
    const policyRevision = this.getCapabilityPolicyRevision(contract.profileId);
    const lease = this.hostCapabilityIssuer.issue({ identity: {
      runId: token.runId, profileId: contract.profileId, bindingId: contract.bindingId || contract.runtimeProfileId,
      runtime: contract.runtime, runtimeAccountId: contract.runtimeAccountId,
      attemptId: `${token.lifecycle}:${token.run}`, workspace: contract.workspace,
      toolRevision: contract.toolRegistryRevision, permissionRevision: contract.toolPermissionRevision,
      accountGeneration: contract.runtimeAccountGeneration,
    }, grants: contract.source === "compaction" ? [] : undefined, signal: token.controller.signal,
    validate: () => {
      if (token.lifecycle !== this.lifecycleGeneration || this.runGenerations.get(token.runId) !== token.run) return false;
      const profile = this.productStore.resolveAgentRuntimeProfile
        ? this.productStore.resolveAgentRuntimeProfile(contract.profileId, contract.bindingId)
        : this.productStore.getAgentProfile(contract.profileId);
      if (!profile?.enabled || profile.runtimeAccountId !== contract.runtimeAccountId
        || profile.runtimeProfileId !== contract.runtimeProfileId) return false;
      if (this.getCapabilityPolicyRevision(contract.profileId) !== policyRevision) return false;
      const admission = this.runAccountAdmissions.get(token.runId);
      if (this.runtimeAccountAdmission) this.runtimeAccountAdmission.assertGeneration(admission);
      return true;
    } });
    this.runCapabilityLeases.set(token.runId, lease);
    return lease;
  }

  #fenceRuntimeAccount(token) {
    this.#fence(token);
    if (this.runtimeAccountAdmission) {
      const admission = this.runAccountAdmissions.get(token.runId);
      if (!admission) {
        throw coordinatorError("RUNTIME_ACCOUNT_ADMISSION_LOST", `WorkRun ${token.runId} 缺少 RuntimeAccount 准入所有权`);
      }
      this.runtimeAccountAdmission.assertGeneration(admission);
    }
    const lease = this.runCapabilityLeases.get(token.runId);
    if (lease) this.hostCapabilityIssuer.assert(lease);
  }

  async #stopManualCompactionHost(host) {
    let timer;
    try {
      // Codex exposes no session-scoped compact cancellation receipt. Stop the
      // concrete app-server and let its existing observer settle sibling Runs.
      const native = host.host;
      if (!native || typeof native.stop !== "function") {
        throw coordinatorError("RUNTIME_STOP_UNCONFIRMED", "运行时停止结果未确认");
      }
      await Promise.race([
        Promise.resolve().then(() => native.stop()),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(coordinatorError("RUNTIME_STOP_UNCONFIRMED", "运行时停止结果未确认")), 5_000);
        }),
      ]);
    } catch {
      const failure = coordinatorError("RUNTIME_STOP_UNCONFIRMED", "运行时停止结果未确认");
      this.#poison(failure);
      throw failure;
    } finally { clearTimeout(timer); }
  }

  async #driveManualCompaction(runId, token, host, threadId, binding, command, session, productSessionKey) {
    this.#fence(token);
    requireMethods(host, ["commandExecute", "subscribe"], "RuntimeHandle native compaction");
    if (productSessionKey) {
      this.#commitChatThreadBinding(productSessionKey, threadId);
      this.invalidateRuntimeContext(productSessionKey, host);
    }
    // Persist the dispatched state before touching the CLI. A crash after this
    // boundary is acceptance-unknown and must never replay /compact.
    this.dispatcher.transition(runId, "running", {
      runtimeSessionRef: runtimeSessionRef(binding, threadId),
    });
    this.#streamFor(runId).append("status", { status: "running" });
    const wait = startManualCompaction({ host, sessionId: threadId,
      signal: token.controller.signal, timeoutMs: this.manualCompactionTimeoutMs,
      dispatch: () => host.commandExecute({ text: "/compact", sessionId: threadId, cwd: session.workspace }),
      onAccepted: () => {
        const released = this.startupGate?.release(runId);
        if (released) setImmediate(() => {
          if (token.lifecycle !== this.lifecycleGeneration || !["opening", "open"].includes(this.state)) return;
          this.#drainQueuedRuns(token.lifecycle).catch(error => this.#poison(error));
        });
      },
    });
    this.manualCompactions.set(runId, wait);
    let outcome;
    try {
      outcome = await wait.promise;
      if (outcome !== "completed") await this.#stopManualCompactionHost(host);
      this.#fence(token);
      const status = outcome === "completed" ? "completed" : outcome === "canceled" ? "canceled" : "interrupted";
      const errorCode = ["completed", "canceled"].includes(outcome) ? null
        : outcome === "timeout" ? "RUNTIME_COMPACTION_TIMEOUT" : "RUNTIME_COMPACTION_ACCEPTANCE_UNKNOWN";
      const resultSummary = outcome === "completed" ? "Conversation context compacted." : null;
      return await this.#withTerminalizing(runId, async () => {
        this.#fence(token);
        const terminal = this.dispatcher.transition(runId, status, { resultSummary, errorCode });
        this.#appendTerminal(runId, { status, resultSummary, errorCode });
        if (status === "canceled") await this.#cancelCommandForRun(terminal, () => this.#fence(token));
        else await this.#completeCommandForRun(terminal, () => this.#fence(token));
        this.#fence(token);
        this.#releaseTerminalRun(runId);
        await this.#drainQueuedRuns(token.lifecycle);
        return terminal;
      });
    } catch (error) {
      if (error?.code === "STORE_COMMIT_UNCERTAIN") this.#poison(error);
      throw error;
    } finally { this.manualCompactions.delete(runId); }
  }

  async #driveProductCompaction(run, command, host, contract, token) {
    if (host.capabilities?.["model.generate.toolFree"] !== true || typeof host.generateModelOnly !== "function") {
      throw coordinatorError("MODEL_ONLY_UNSUPPORTED", "当前运行环境没有经过验证的无工具摘要能力");
    }
    this.#fenceRuntimeAccount(token);
    this.dispatcher.transition(run.id, "running");
    this.startupGate?.release(run.id);
    this.#streamFor(run.id).append("status", { status: "running" });
    let errorCode = null, summary = null;
    try {
      const output = await host.generateModelOnly({ prompt: command.prompt, model: contract.defaultModel,
        operationId: command.operationId, signal: token.controller.signal });
      this.#fenceRuntimeAccount(token);
      const profile = this.productStore.getAgentProfile(run.profileId);
      if (output.usage && this.usageStore) this.usageStore.record({ profileId: run.profileId,
        agentId: profile.agentId || profile.id, agentName: profile.name || profile.id,
        runId: run.id, source: "compaction", sourceId: run.sourceId,
        runtime: contract.runtime, runtimeAccountId: contract.runtimeAccountId,
        threadId: `model-only:${run.id}`, turnId: run.id, responseId: command.operationId,
        model: output.model || contract.defaultModel, provider: output.provider || null,
        usage: output.usage, createdAt: this.now() });
      summary = require("./conversation-compaction").parseConversationSummary(output.text);
      const { prompt: _prompt, targetThroughSeq: _target, windowTokens, ...coverage } = command.plan;
      const checkpoint = this.conversationCheckpointStore.commit({ ...coverage, summary, provenance: {
        runId: run.id, bindingId: contract.bindingId, runtime: contract.runtime,
        model: output.model || contract.defaultModel, method: "model",
        ...(windowTokens ? { contextWindow: windowTokens } : {}),
        ...(command.sourceBindingId ? { sourceNativeSessionId: command.sourceNativeSessionId, sourceBindingId: command.sourceBindingId } : {}),
      } });
      this.#renewFromCheckpoint(this.chatSessionStore.getSession(command.sessionKey), checkpoint, run.id);
      this.onRuntimeContextChanged({ profileId: run.profileId, sessionKey: command.sessionKey });
    } catch (error) {
      this.#fence(token);
      if (error?.code === "RUNTIME_STOP_UNCONFIRMED") { this.#poison(error); throw error; }
      errorCode = ["CHECKPOINT_STALE", "CHECKPOINT_INVALID", "CHECKPOINT_SUMMARY_TOO_LARGE", "MODEL_ONLY_CANCELED", "MODEL_ONLY_ACCEPTANCE_UNKNOWN"]
        .includes(error?.code) ? error.code : "COMPACTION_FAILED";
    }
    this.#fence(token);
    const status = errorCode ? "failed" : "completed";
    this.dispatcher.transition(run.id, status, { errorCode });
    this.#appendTerminal(run.id, { status, resultSummary: null, errorCode });
    this.#releaseTerminalRun(run.id);
    await this.#drainQueuedRuns(token.lifecycle);
  }

  async #drive(runId, token) {
    this.#fence(token);
    let run = this.dispatcher.getRun(runId);
    if (!run) throw coordinatorError("WORK_RUN_NOT_FOUND", `WorkRun 不存在: ${runId}`);
    if (TERMINAL_RUN_STATES.has(run.status)) return;
    const commandRecord = this.#commandForRun(run);
    if (!commandRecord) return;
    const operationId = commandRecord.operationId;
    let { command } = commandRecord;
    const manualCompact = commandRecord.kind === "chat" && command.prompt === "/compact"
      && (!command.attachments || command.attachments.length === 0);
    if (manualCompact && this.recoveringRuns.has(runId) && run.status === "running"
      && !runtimeTurnIdOf(run)) {
      await this.#interruptForLostExecutionContract(runId, token.lifecycle, "RUNTIME_COMPACTION_ACCEPTANCE_UNKNOWN");
      return;
    }
    if (commandRecord.kind === "chat" && !ACTIVE_COMMAND_STATES.has(command.state)) return;
    if (run.status === "queued") {
      if (commandRecord.kind === "chat" && command.state === "dispatching") {
        command = await this.inbox.transition(operationId, "pending");
      }
      const admission = this.#admit(run.id, run.profileId);
      if (admission.disposition === "rejected") {
        await this.#rejectAccountAdmission(run, admission.reason, token.lifecycle);
        return;
      }
      run = admission.run;
      if (admission.disposition === "queued") return;
    }
    const recoveringActive = this.recoveringRuns.has(runId) && ACTIVE_RUN_STATES.has(run.status)
      && run.status !== "starting";
    if (run.status === "running" && !recoveringActive) {
      return;
    }
    if (run.status !== "starting" && !recoveringActive) {
      if (TERMINAL_RUN_STATES.has(run.status)) return;
      throw coordinatorError("WORK_RUN_NOT_STARTABLE", `WorkRun ${run.id} 当前不可发送: ${run.status}`);
    }
    let executionSession;
    let productSessionKey = this.getRunSessionKey(run);
    if (productSessionKey) {
      if (run.source === "inspiration") {
        const execution = this.resolveRunSession(run);
        command = { ...command, sessionKey: productSessionKey, createdAt: execution.createdAt,
          attachments: execution.inputSource === "chat" ? execution.turnAttachments || []
            : [...(execution.attachments || []), ...(execution.turnAttachments || [])] };
      } else if (run.source === "cron") {
        command = { ...command, sessionKey: productSessionKey, createdAt: run.startedAt };
      }
      const session = this.chatSessionStore.getSession(productSessionKey);
      if (!session) {
        throw coordinatorError("CHAT_SESSION_NOT_FOUND", `ChatSession 不存在: ${command.sessionKey}`);
      }
      if (!sendableSession(session)) {
        throw coordinatorError("CHAT_SESSION_NOT_READY", `ChatSession 当前不可发送: ${session.status}`);
      }
      executionSession = { ...session, workspace: run.workspace };
    } else {
      executionSession = Object.freeze({ workspace: run.workspace });
    }
    const executionContract = this.runExecutionContracts.get(runId);
    if (!executionContract) {
      throw coordinatorError(
        "EXECUTION_CONTRACT_LOST",
        `WorkRun ${runId} 缺少当前 Coordinator 准入时冻结的 execution contract`,
      );
    }
    if (commandRecord.kind === "chat" && command.state === "pending") {
      command = await this.inbox.transition(operationId, "dispatching");
    }
    if (this.runExecutionStore && !this.recoveringRuns.has(runId)) {
      try {
        await this.runExecutionStore.put(run, executionContract,
          { ...command, kind: commandRecord.kind, operationId }, () => this.#fence(token), {
            waitForCapacity: true, signal: token.controller.signal,
          });
      } catch (error) {
        this.#fence(token);
        if (error?.code === "STORE_COMMIT_UNCERTAIN") { this.#poison(error); throw error; }
        throw coordinatorError("EXECUTION_BINDING_UNAVAILABLE", "Cannot persist execution binding");
      }
    }
    const binding = runtimeBinding({
      runtime: executionContract.runtime,
      runtimeProfileId: executionContract.runtimeProfileId,
      runtimeAccountId: executionContract.runtimeAccountId,
    });
    if (this.recoveringRuns.has(runId) && this.startupGate) {
      await this.startupGate.wait(runId, token.controller.signal);
      this.#fence(token);
    }
    const host = await this.#timedPerformanceStage(
      runId,
      "runtime_acquire",
      () => this.#retryablePreTurnCall(
        "runtime_acquire",
        token,
        async () => {
          try {
            return await this.runtimeManager.acquire(binding, {
              permissionPolicy: executionContract.runtimeHostPermissionPolicy,
              workspace: executionContract.workspace,
              executionContract,
            });
          } catch (error) {
            if (ownDataErrorCode(error) === "RUNTIME_HOST_CAPACITY") token.hostCapacity = true;
            throw error;
          }
        },
      ),
    );
    this.#fence(token);
    if (run.source === "compaction") {
      this.#issueRunCapability(token, executionContract);
      await this.#driveProductCompaction(run, command, host, executionContract, token);
      return;
    }
    requireMethods(
      host,
      ["sessionList", "sessionStart", "sessionResume", "sessionRead", "turnStart"],
      "RuntimeHandle",
    );
    const authState = await this.#timedPerformanceStage(
      runId,
      "runtime_authentication",
      () => this.#retryablePreTurnCall(
        "runtime_acquire",
        token,
        () => readRuntimeAuthenticationState(host, { allowDeferred: true }),
      ),
    );
    this.#fence(token);
    if (authState.status === "unauthenticated") throw runtimeAuthRequiredError();
    this.#fenceRuntimeAccount(token);
    this.#issueRunCapability(token, executionContract);
    this.runHostAssignments.set(runId, Object.freeze({
      host,
      runtime: executionContract.runtime,
      runtimeBinding: binding,
      runtimeProfileId: executionContract.runtimeProfileId,
      runtimeAccountId: executionContract.runtimeAccountId,
      generation: token.run,
      lifecycle: token.lifecycle,
    }));
    this.#observeHost(host, executionContract.runtimeProfileId, this.runAccountAdmissions.get(runId));

    if (recoveringActive) {
      // A durable remote turn is never sent again. Resume only its session and
      // reconcile the exact operation/turn from complete native history.
      const threadId = runtimeSessionIdOf(run);
      const turnId = runtimeTurnIdOf(run);
      if (!threadId || !turnId) throw coordinatorError("RUNTIME_RECOVERY_UNAVAILABLE", "Missing native binding");
      await this.#resumeRecoveredThread(host, threadId, executionContract, executionSession, token);
      this.#fence(token);
      const context = { host, runtimeBinding: binding, sessionRef: runtimeSessionRef(binding, threadId),
        turnRef: runtimeTurnRef(binding, threadId, turnId), runtimeProfileId: executionContract.runtimeProfileId,
        runtimeAccountId: executionContract.runtimeAccountId, generation: token.run, threadId, turnId,
        profileId: run.profileId };
      this.runContexts.set(runId, context);
      this.hostCapabilityIssuer.bind(this.runCapabilityLeases.get(runId), { sessionId: threadId, turnId });
      const terminal = await this.#reconcileTerminal(runId, context);
      if (!TERMINAL_RUN_STATES.has(terminal?.status)) {
        // History alone cannot prove that a new CLI process owns the old live
        // worker or approval callback. Keep an explicit unknown terminal.
        await this.#interruptForLostExecutionContract(runId, token.lifecycle, "RUNTIME_RECOVERY_UNAVAILABLE");
      }
      return;
    }

    // A feature rollback cannot replace an existing native session or resume a
    // retired one through the legacy Cron threadSource. Fresh, untouched Cron
    // conversations still retain the original domain thread discovery path.
    const cronHasSessionAuthority = executionSession.runtimeBindingId
      && (runtimeSessionIdOf(executionSession) !== null || executionSession.status === "binding"
        || executionSession.retiredRuntimeSessions?.length > 0
        || this.getNativeRuntimeConfig()?.flags?.runtimeConversationHandoff);
    const threadBinding = productSessionKey && (run.source !== "cron" || cronHasSessionAuthority)
      ? await this.#ensureThread(
        host,
        executionSession,
        executionContract,
        command,
        token,
      )
      : await this.#ensureDomainThread(
        host,
        executionSession,
        executionContract,
        command,
        token,
      );
    const { threadId, fresh } = threadBinding;
    this.#fence(token);
    if (manualCompact && host.capabilities?.["context.compact.native"] === true) {
      if (binding.runtime === "codex") {
        await this.#driveManualCompaction(runId, token, host, threadId, binding, command, executionSession, productSessionKey);
        return;
      }
      // Pi returns a native command turn; its RPC compact + post-RPC stats and
      // existing acceptance/recovery/cancellation path remain authoritative.
      if (binding.runtime === "pi") {
        if (productSessionKey) this.invalidateRuntimeContext(productSessionKey);
        const nativeCommand = await host.commandExecute({ text: "/compact", sessionId: threadId,
          cwd: executionSession.workspace });
        this.#fence(token);
        if (nativeCommand?.kind !== "send" || nativeCommand.text !== "/compact") {
          throw coordinatorError("RUNTIME_COMMAND_PARAMS_INVALID", "Native compact command is unavailable");
        }
      }
    }
    if (commandRecord.kind === "domain") {
      this.#assertDomainPromptSecretSafe(run, command);
    }
    if (run.source === "cron") {
      const session = this.#ensureCronTranscript(run, command, threadId);
      if (session) {
        productSessionKey = session.sessionKey;
        executionSession = { ...session, workspace: run.workspace };
      }
    }
    const turnId = await this.#ensureTurn(
      host,
      threadId,
      executionContract,
      executionSession,
      command,
      token,
      fresh,
    );
    this.#fence(token);
    if (productSessionKey) {
      this.#commitChatThreadBinding(productSessionKey, threadId);
      this.#finishContextTransfer(runId, "accepted");
    }
    this.#fence(token);
    run = this.dispatcher.getRun(runId);
    if (run?.status === "starting") {
      this.dispatcher.transition(runId, "running", {
        runtimeSessionRef: runtimeSessionRef(binding, threadId),
        runtimeTurnRef: runtimeTurnRef(binding, threadId, turnId),
      });
    } else if (run?.status !== "running"
      || runtimeSessionIdOf(run) !== threadId || runtimeTurnIdOf(run) !== turnId) {
      throw coordinatorError("WORK_RUN_BINDING_CONFLICT", `WorkRun ${runId} 的远端 binding 冲突`);
    }
    this.#fence(token);
    this.recoveringRuns.delete(runId);
    this.hostCapabilityIssuer.bind(this.runCapabilityLeases.get(runId), { sessionId: threadId, turnId });
    this.runContexts.set(runId, {
      host,
      runtimeBinding: binding,
      sessionRef: runtimeSessionRef(binding, threadId),
      turnRef: runtimeTurnRef(binding, threadId, turnId),
      runtimeProfileId: executionContract.runtimeProfileId,
      runtimeAccountId: executionContract.runtimeAccountId,
      generation: token.run,
      threadId,
      turnId,
      profileId: run.profileId,
    });
    this.#flushPendingHostEvents(host, this.runContexts.get(runId));
    this.#streamFor(runId).append("status", { status: "running" });
    await this.#reconcileTerminal(runId, this.runContexts.get(runId));
  }

  async #runtimeStageCall(stage, token, task) {
    this.#fenceRuntimeAccount(token);
    if (!this.recoveringRuns.has(token.runId)
      && this.dispatcher.getRun(token.runId)?.status === "starting") {
      this.assertExecutionProviderRouteCurrent?.(this.runExecutionContracts.get(token.runId));
      this.runHostAssignments.get(token.runId)?.host.assertExecutionProviderCurrent?.();
    }
    try {
      const result = await task();
      this.#fenceRuntimeAccount(token);
      return result;
    } catch (error) {
      this.#fenceRuntimeAccount(token);
      const operational = runtimeOperationalError(error);
      if (isRuntimeAuthRequired(operational)) throw operational;
      const staged = runtimeStageError(stage, operational);
      const retryAt = runtimeAccountRetryAt(staged);
      if (retryAt !== null && this.runtimeAccountAdmission) {
        const admission = this.runAccountAdmissions.get(token.runId);
        if (!admission) {
          throw coordinatorError(
            "RUNTIME_ACCOUNT_ADMISSION_LOST",
            `WorkRun ${token.runId} 缺少 RuntimeAccount 准入所有权`,
          );
        }
        this.runtimeAccountAdmission.noteBackoff({
          runtimeAccountId: admission.runtimeAccountId,
          retryAt,
        });
      }
      throw staged;
    }
  }

  #claimPreTurnRetry(token, error) {
    if (token.hostCapacity || token.startupRetryUsed || runtimeAccountRetryAt(error) !== null
      || CODEX_SETUP_ERROR_CODES.has(publicRuntimeOperationalErrorCode(error))
      || !isRetryablePreTurnStageError(error)) return false;
    token.startupRetryUsed = true;
    return true;
  }

  async #retryablePreTurnCall(stage, token, task) {
    try {
      return await this.#runtimeStageCall(stage, token, task);
    } catch (error) {
      if (!this.#claimPreTurnRetry(token, error)) throw error;
      this.#fenceRuntimeAccount(token);
      return this.#runtimeStageCall(stage, token, task);
    }
  }

  async #reconcileTerminal(runId, context) {
    const token = {
      lifecycle: this.lifecycleGeneration,
      run: context.generation,
      runId,
    };
    const existing = this.dispatcher.getRun(runId);
    if (!existing || TERMINAL_RUN_STATES.has(existing.status)) return existing;
    this.#fence(token);
    const run = this.dispatcher.getRun(runId);
    if (!run || TERMINAL_RUN_STATES.has(run.status)) return run;
    if (!ACTIVE_RUN_STATES.has(run.status)
      || runtimeSessionIdOf(run) !== context.threadId
      || runtimeTurnIdOf(run) !== context.turnId) return run;
    const thread = await this.#readThread(context.host, context.threadId, token);
    const turns = thread?.turns;
    if (!Array.isArray(turns)) {
      throw coordinatorError("CODEX_THREAD_HISTORY_INCOMPLETE", "terminal thread/read 缺少 turns");
    }
    const matches = turns.filter((turn) => turn?.id === context.turnId);
    if (matches.length !== 1) {
      throw coordinatorError(
        matches.length === 0 ? "CODEX_TERMINAL_TURN_NOT_FOUND" : "CODEX_TERMINAL_TURN_CONFLICT",
        `terminal thread/read 无法唯一定位 turn ${context.turnId}`,
      );
    }
    const turn = matches[0];
    if ((turn.itemsView ?? "full") !== "full" || !Array.isArray(turn.items)) {
      throw coordinatorError("CODEX_THREAD_HISTORY_INCOMPLETE", "terminal thread/read 不是 full history");
    }
    assertHistoryCanProveAbsence(thread);
    const operationId = this.#operationIdForRun(run);
    let operationTurns;
    try {
      operationTurns = userMessageTurnIds(thread, operationId);
    } catch (error) {
      if (error?.code !== "CODEX_CLIENT_MESSAGE_ID_CONFLICT") throw error;
      throw coordinatorError(
        "CODEX_TERMINAL_OPERATION_MISMATCH",
        `terminal turn ${context.turnId} 的 operation binding 不唯一`,
      );
    }
    if (operationTurns.length !== 1 || operationTurns[0] !== context.turnId) {
      throw coordinatorError(
        "CODEX_TERMINAL_OPERATION_MISMATCH",
        `terminal turn ${context.turnId} 不属于当前 operation`,
      );
    }
    const mapping = {
      completed: { status: "completed", errorCode: null },
      failed: { status: "failed", errorCode: failedTurnErrorCode(turn) },
      interrupted: { status: "interrupted", errorCode: failedTurnErrorCode(turn, "RUNTIME_TURN_INTERRUPTED") },
      canceled: { status: "canceled", errorCode: null },
    }[turn.status];
    if (!mapping) return run;
    const resultSummary = mapping.status === "completed" ? this.#resultSummary(turn, runId) : null;
    const patch = definedProperties({ resultSummary, errorCode: mapping.errorCode });
    return this.#withTerminalizing(runId, async () => {
      let terminal;
      try {
        this.#fence(token);
        terminal = this.dispatcher.transition(runId, mapping.status, patch);
      } catch (error) {
        if (error?.code === "STORE_COMMIT_UNCERTAIN") this.#poison(error);
        throw error;
      }
      this.#fence(token);
      try {
        this.#appendTerminal(runId, {
          status: mapping.status,
          resultSummary,
          errorCode: mapping.errorCode,
        });
      } catch (error) {
        this.#poison(error);
        throw error;
      }
      this.#fence(token);
      try {
        await this.#completeCommandForRun(terminal, () => this.#fence(token));
      } catch (error) {
        this.#poison(error);
        throw error;
      }
      this.#fence(token);
      this.#releaseTerminalRun(runId);
      await this.#drainQueuedRuns(token.lifecycle);
      return terminal;
    });
  }

  async #reconcileTerminalAfterSignal(runId, context) {
    const token = {
      lifecycle: this.lifecycleGeneration,
      run: context.generation,
      runId,
    };
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await this.#reconcileTerminal(runId, context);
        if (!result || TERMINAL_RUN_STATES.has(result.status)) return result;
        if (attempt >= this.terminalRetryDelaysMs.length) {
          this.#fence(token);
          return this.#interruptForTerminalReconciliation(runId, token);
        }
      } catch (error) {
        if (!this.#retryableTerminalError(error)) throw error;
        if (attempt >= this.terminalRetryDelaysMs.length) {
          this.#fence(token);
          return this.#interruptForTerminalReconciliation(runId, token);
        }
      }
      this.#fence(token);
      await this.#waitForTerminalRetry(this.terminalRetryDelaysMs[attempt]);
      this.#fence(token);
    }
  }

  #waitForTerminalRetry(delay) {
    return new Promise((resolve, reject) => {
      const waiter = {
        handle: null,
        settled: false,
        finish: () => {
          if (waiter.settled) return;
          waiter.settled = true;
          this.terminalRetryWaiters.delete(waiter);
          resolve();
        },
      };
      this.terminalRetryWaiters.add(waiter);
      try {
        waiter.handle = this.terminalRetryScheduler.set(waiter.finish, delay);
      } catch (error) {
        waiter.settled = true;
        this.terminalRetryWaiters.delete(waiter);
        reject(error);
      }
    });
  }

  #cancelTerminalRetryWaiters() {
    for (const waiter of [...this.terminalRetryWaiters]) {
      try { this.terminalRetryScheduler.clear(waiter.handle); } catch {}
      waiter.finish();
    }
  }

  async #interruptForTerminalReconciliation(runId, token) {
    this.#fence(token);
    return this.#withTerminalizing(runId, async () => {
      let terminal;
      try {
        this.#fence(token);
        terminal = this.dispatcher.transition(runId, "interrupted", {
          errorCode: "CODEX_TERMINAL_RECONCILIATION_FAILED",
        });
      } catch (error) {
        if (error?.code === "STORE_COMMIT_UNCERTAIN") this.#poison(error);
        throw error;
      }
      this.#fence(token);
      try {
        this.#appendTerminal(runId, {
          status: "interrupted",
          resultSummary: null,
          errorCode: "CODEX_TERMINAL_RECONCILIATION_FAILED",
        });
      } catch (error) {
        this.#poison(error);
        throw error;
      }
      this.#fence(token);
      try {
        await this.#completeCommandForRun(terminal, () => this.#fence(token));
      } catch (error) {
        this.#poison(error);
        throw error;
      }
      this.#fence(token);
      this.#releaseTerminalRun(runId);
      await this.#drainQueuedRuns(token.lifecycle);
      return terminal;
    });
  }

  #retryableTerminalError(error) {
    return ![
      "STORE_COMMIT_UNCERTAIN",
      "PENDING_COMMAND_COMMIT_UNCERTAIN",
      "WORK_RUN_COORDINATOR_CLOSING",
      "WORK_RUN_COORDINATOR_STALE_RUN",
      "CODEX_TERMINAL_OPERATION_MISMATCH",
      "CODEX_TERMINAL_TURN_CONFLICT",
      "CODEX_THREAD_HISTORY_INCOMPLETE",
      "CODEX_THREAD_READ_MISMATCH",
    ].includes(error?.code);
  }

  async #drainQueuedRuns(lifecycle) {
    this.#fenceLifecycle(lifecycle);
    let candidates = this.dispatcher.listRuns().filter((run) => run.status === "queued");
    for (const run of candidates) if (!this.queueArrivalTimes.has(run.id)) this.queueArrivalTimes.set(run.id,
      this.#commandForRun(run)?.command?.createdAt ?? this.now());
    while (candidates.length) {
      if (this.getNativeRuntimeConfig()?.flags?.runtimeAdmissionV1) candidates = this.fairQueue.order(candidates,
        run => this.queueArrivalTimes.get(run.id));
      const candidate = candidates.shift();
      this.#fenceLifecycle(lifecycle);
      const record = this.#commandForRun(candidate);
      if (!record) continue;
      if (record.kind === "chat") {
        if (!ACTIVE_COMMAND_STATES.has(record.command.state)) continue;
        const session = this.chatSessionStore.getSession(candidate.sourceId);
        if (!sendableSession(session)) continue;
        if (record.command.state === "dispatching") {
          this.#fenceLifecycle(lifecycle);
          await this.inbox.transition(record.operationId, "pending");
        }
      }
      this.#fenceLifecycle(lifecycle);
      // Another terminal or the retry timer can drain while inbox I/O yields.
      if (this.dispatcher.getRun(candidate.id)?.status !== "queued") continue;
      const admission = this.#admit(candidate.id, candidate.profileId, lifecycle);
      if (admission.disposition === "rejected") {
        await this.#rejectAccountAdmission(candidate, admission.reason, lifecycle);
        continue;
      }
      this.#fenceLifecycle(lifecycle);
      if (admission.disposition === "started") this.#schedule(candidate.id);
    }
  }

  #resultSummary(turn, runId) {
    const messages = turn.items.filter((item) => item?.type === "agentMessage"
      && item.delivery !== "async"
      && typeof item.text === "string"
      && item.text.length > 0);
    const selected = [...messages].reverse().find((item) => item.phase === "final_answer")
      || [...messages].reverse().find((item) => item.phase === null || item.phase === undefined);
    if (!selected) return null;
    try {
      const sanitized = this.sanitizeSummary(selected.text, Object.freeze({ runId }));
      if (consumeThenable(sanitized)) return null;
      if (sanitized !== null && typeof sanitized !== "string") return null;
      if (sanitized === null || sanitized.length === 0) return null;
      const bounded = utf8Prefix(sanitized, this.maxResultSummaryBytes);
      if (bounded.length === 0) return null;
      const safe = this.assertSecretSafe(
        { resultSummary: bounded },
        Object.freeze({ kind: "resultSummary", runId }),
      );
      if (safe === false || consumeThenable(safe)) return null;
      return bounded;
    } catch {
      return null;
    }
  }

  #poison(error) {
    if (!this.poisonError) {
      this.poisonError = error;
      this.#rejectTerminalWaiters(error);
    }
  }

  #interactiveTransition(runId, status, patch) {
    try {
      return this.dispatcher.transition(runId, status, patch);
    } catch (error) {
      if (error?.code === "STORE_COMMIT_UNCERTAIN") this.#poison(error);
      throw error;
    }
  }

  #operationIdForRun(run) {
    const prefix = "shoggoth:chat-send:";
    if (run.source === "chat") {
      if (typeof run.idempotencyKey !== "string"
        || !run.idempotencyKey.startsWith(prefix) || run.idempotencyKey.length === prefix.length) {
        throw coordinatorError("WORK_RUN_IDEMPOTENCY_INVALID", `WorkRun ${run.id} 缺少 chat operationId`);
      }
      return run.idempotencyKey.slice(prefix.length);
    }
    const command = this.domainCommands.get(run.id);
    if (!command || command.runId !== run.id) {
      throw coordinatorError(
        "EXECUTION_CONTRACT_LOST",
        `WorkRun ${run.id} 缺少当前 lifecycle 的 domain operation binding`,
      );
    }
    return command.operationId;
  }

  #assertDomainPromptSecretSafe(run, command) {
    try {
      const safe = this.assertSecretSafe(
        { prompt: command.prompt },
        Object.freeze({ kind: "domainPrompt", runId: run.id }),
      );
      if (consumeThenable(safe)) throw new Error("async secret matcher unsupported");
      if (safe === true) return;
    } catch {
      // matcher 的原始错误可能含敏感上下文，统一在领域边界脱敏。
    }
    throw coordinatorError(
      "DOMAIN_WORK_RUN_PROMPT_SECRET_REJECTED",
      "Domain WorkRun prompt 未通过敏感信息检查",
    );
  }

  #runtimeSessionOwnershipIdentity(token, sessionId) {
    const execution = this.runExecutionContracts.get(token.runId);
    if (!execution) {
      throw coordinatorError(
        "EXECUTION_CONTRACT_LOST",
        `WorkRun ${token.runId} 缺少 Runtime session ownership binding`,
      );
    }
    return {
      binding: runtimeBinding({
        runtime: execution.runtime,
        runtimeProfileId: execution.runtimeProfileId,
        runtimeAccountId: execution.runtimeAccountId,
      }),
      profileId: execution.profileId,
      sessionId,
      workspace: execution.workspace,
    };
  }

  #claimRuntimeSessionOwnership(token, sessionId) {
    if (!this.runtimeSessionOwnershipStore) return null;
    this.#fenceRuntimeAccount(token);
    const identity = this.#runtimeSessionOwnershipIdentity(token, sessionId);
    const claimed = this.runtimeSessionOwnershipStore.claim({
      ...identity.binding,
      sessionId: identity.sessionId,
      profileId: identity.profileId,
      workspace: identity.workspace,
    });
    this.#fenceRuntimeAccount(token);
    return claimed;
  }

  #assertRuntimeSessionOwned(token, sessionId) {
    if (!this.runtimeSessionOwnershipStore) return null;
    this.#fenceRuntimeAccount(token);
    const owned = this.runtimeSessionOwnershipStore.assertOwned(
      this.#runtimeSessionOwnershipIdentity(token, sessionId),
    );
    this.#fenceRuntimeAccount(token);
    return owned;
  }

  #claimStartedRuntimeSession(response, threadSource, token) {
    const runtimeSession = response?.session;
    if (!runtimeSession || typeof runtimeSession.id !== "string" || runtimeSession.id.length === 0
      || runtimeSession.source !== threadSource) {
      throw coordinatorError("CODEX_THREAD_START_INVALID_RESPONSE", "thread/start 返回无效 binding");
    }
    this.#claimRuntimeSessionOwnership(token, runtimeSession.id);
    return runtimeSession.id;
  }

  async #retrySessionStartAfterProvenAbsent(
    host, threadSource, profile, session, token, firstError,
  ) {
    if (!this.#claimPreTurnRetry(token, firstError)) throw firstError;
    this.#fence(token);
    try {
      const response = await this.#runtimeStageCall(
        "session_start_or_resume",
        token,
        () => host.sessionStart(this.#sessionStartParams(threadSource, profile, session)),
      );
      this.#fence(token);
      return {
        threadId: this.#claimStartedRuntimeSession(response, threadSource, token),
        fresh: true,
      };
    } catch (error) {
      if (isRuntimeAuthRequired(error) || isRuntimeSessionOwnershipError(error)
        || runtimeAccountRetryAt(error) !== null) throw error;
      this.#fence(token);
      const matches = await this.#findThreadsBySource(host, threadSource, token);
      this.#fence(token);
      if (matches.length > 1) this.#throwThreadSourceConflict(threadSource);
      if (matches.length === 0) throw error;
      this.#assertThreadMatchActive(matches[0]);
      return {
        threadId: await this.#resumeRecoveredThread(
          host, matches[0].id, profile, session, token, threadSource,
        ),
        fresh: false,
      };
    }
  }

  async #ensureDomainThread(host, session, profile, command, token) {
    if (command.threadId !== null) {
      return {
        threadId: await this.#resumeRecoveredThread(
          host,
          command.threadId,
          profile,
          session,
          token,
          command.threadSource,
        ),
        fresh: false,
      };
    }
    let matches = await this.#findThreadsBySource(host, command.threadSource, token);
    this.#fence(token);
    if (matches.length === 1) {
      this.#assertThreadMatchActive(matches[0]);
      return {
        threadId: await this.#resumeRecoveredThread(
          host,
          matches[0].id,
          profile,
          session,
          token,
          command.threadSource,
        ),
        fresh: false,
      };
    }
    if (matches.length > 1) this.#throwThreadSourceConflict(command.threadSource);
    try {
      const response = await this.#runtimeStageCall(
        "session_start_or_resume",
        token,
        () => host.sessionStart(this.#sessionStartParams(command.threadSource, profile, session)),
      );
      this.#fence(token);
      return {
        threadId: this.#claimStartedRuntimeSession(response, command.threadSource, token),
        fresh: true,
      };
    } catch (error) {
      if (isRuntimeAuthRequired(error) || isRuntimeSessionOwnershipError(error)
        || runtimeAccountRetryAt(error) !== null) throw error;
      this.#fence(token);
      matches = await this.#findThreadsBySource(host, command.threadSource, token);
      this.#fence(token);
      if (matches.length === 0) return this.#retrySessionStartAfterProvenAbsent(
        host, command.threadSource, profile, session, token, error,
      );
      if (matches.length > 1) this.#throwThreadSourceConflict(command.threadSource);
      this.#assertThreadMatchActive(matches[0]);
      return {
        threadId: await this.#resumeRecoveredThread(
          host,
          matches[0].id,
          profile,
          session,
          token,
          command.threadSource,
        ),
        fresh: false,
      };
    }
  }

  async #ensureThread(host, session, profile, command, token) {
    if (!sendableSession(session)) {
      throw coordinatorError("CHAT_SESSION_NOT_READY", `ChatSession 当前不可发送: ${session.status}`);
    }
    const existingRuntimeSessionId = runtimeSessionIdOf(session);
    if (existingRuntimeSessionId) {
      try {
        return {
          threadId: await this.#resumeRecoveredThread(
            host,
            existingRuntimeSessionId,
            profile,
            session,
            token,
          ),
          fresh: false,
        };
      } catch (error) {
        if (isRuntimeAuthRequired(error) || isRuntimeSessionOwnershipError(error)
          || runtimeAccountRetryAt(error) !== null) throw error;
        this.#fence(token);
        this.#assertSemanticRecoveryAvailable(session, token);
        return this.#recoverBoundThread(host, session, profile, token, error);
      }
    }
    const detached = session.status === "ready" && existingRuntimeSessionId === null;
    if (session.status !== "draft" && session.status !== "binding" && !detached) {
      throw coordinatorError("CHAT_SESSION_NOT_READY", `ChatSession 当前不可绑定: ${session.status}`);
    }
    if (detached) this.#assertSemanticRecoveryAvailable(session, token);
    let binding;
    if (session.status === "draft" || detached) {
      binding = this.chatSessionStore.requestBinding(
        session.sessionKey,
        bindingOperationId(command.operationId),
        command.createdAt,
      );
    } else {
      binding = this.chatSessionStore.listPendingBindings()
        .find((candidate) => candidate.sessionKey === session.sessionKey);
      if (!binding) {
        const refreshed = this.chatSessionStore.getSession(session.sessionKey);
        const refreshedRuntimeSessionId = runtimeSessionIdOf(refreshed);
        if (refreshedRuntimeSessionId) {
          return {
            threadId: await this.#resumeRecoveredThread(host, refreshedRuntimeSessionId, profile, {
              ...refreshed,
              workspace: session.workspace,
            }, token),
            fresh: false,
          };
        }
        throw coordinatorError("CHAT_BINDING_RECOVERY_NOT_FOUND", "binding session 缺少 pending operation");
      }
    }

    let matches = await this.#findThreadsBySource(host, binding.threadSource, token);
    this.#fence(token);
    if (matches.length === 1) {
      this.#assertThreadMatchActive(matches[0]);
      const resumedThreadId = await this.#resumeRecoveredThread(
        host,
        matches[0].id,
        profile,
        session,
        token,
        binding.threadSource,
      );
      return { threadId: resumedThreadId, fresh: false };
    }
    if (matches.length > 1) this.#throwThreadSourceConflict(binding.threadSource);

    let response;
    try {
      response = await this.#runtimeStageCall(
        "session_start_or_resume",
        token,
        () => host.sessionStart(this.#sessionStartParams(binding.threadSource, profile, session)),
      );
      this.#fence(token);
    } catch (error) {
      if (isRuntimeAuthRequired(error) || isRuntimeSessionOwnershipError(error)
        || runtimeAccountRetryAt(error) !== null) throw error;
      this.#fence(token);
      matches = await this.#findThreadsBySource(host, binding.threadSource, token);
      this.#fence(token);
      if (matches.length === 0) return this.#retrySessionStartAfterProvenAbsent(
        host, binding.threadSource, profile, session, token, error,
      );
      if (matches.length > 1) this.#throwThreadSourceConflict(binding.threadSource);
      this.#assertThreadMatchActive(matches[0]);
      const resumedThreadId = await this.#resumeRecoveredThread(
        host,
        matches[0].id,
        profile,
        session,
        token,
        binding.threadSource,
      );
      return { threadId: resumedThreadId, fresh: false };
    }
    return {
      threadId: this.#claimStartedRuntimeSession(response, binding.threadSource, token),
      fresh: true,
    };
  }

  #assertSemanticRecoveryAvailable(session, token) {
    if (!this.transcriptStore || typeof this.transcriptStore.listEvents !== "function") {
      throw coordinatorError(
        "RUNTIME_SESSION_RECOVERY_HISTORY_REQUIRED",
        "旧 Runtime session 无法恢复，且 Shoggoth Transcript 尚未具备可验证的语义续接历史",
      );
    }
    const events = this.transcriptStore.listEvents(session.profileId, session.id);
    if (events.some((event) => event.runId !== token.runId
      && (event.kind === "user" || event.kind === "assistant"))) return;
    throw coordinatorError(
      "RUNTIME_SESSION_RECOVERY_HISTORY_REQUIRED",
      "旧 Runtime session 无法恢复，且 Shoggoth Transcript 尚未具备可验证的语义续接历史",
    );
  }

  async #recoverBoundThread(host, session, profile, token, resumeError) {
    const binding = this.chatSessionStore.getBinding(session.sessionKey);
    const sessionRuntimeId = runtimeSessionIdOf(session);
    if (!binding || binding.state !== "bound"
      || runtimeSessionIdOf(binding) !== sessionRuntimeId) {
      throw coordinatorError(
        "CHAT_BINDING_RECOVERY_NOT_FOUND",
        "ready session 缺少可核验的 bound operation",
      );
    }
    let matches = await this.#findThreadsBySource(host, binding.threadSource, token);
    this.#fence(token);
    if (matches.length > 1) this.#throwThreadSourceConflict(binding.threadSource);
    if (matches.length === 1) {
      this.#assertThreadMatchActive(matches[0]);
      if (matches[0].id === sessionRuntimeId) throw resumeError;
      return {
        threadId: await this.#resumeRecoveredThread(
          host,
          matches[0].id,
          profile,
          session,
          token,
          binding.threadSource,
        ),
        fresh: false,
      };
    }

    try {
      const response = await this.#runtimeStageCall(
        "session_start_or_resume",
        token,
        () => host.sessionStart(this.#sessionStartParams(binding.threadSource, profile, session)),
      );
      this.#fence(token);
      return {
        threadId: this.#claimStartedRuntimeSession(response, binding.threadSource, token),
        fresh: true,
      };
    } catch (error) {
      if (isRuntimeAuthRequired(error) || isRuntimeSessionOwnershipError(error)
        || runtimeAccountRetryAt(error) !== null) throw error;
      this.#fence(token);
      matches = await this.#findThreadsBySource(host, binding.threadSource, token);
      this.#fence(token);
      if (matches.length === 0) return this.#retrySessionStartAfterProvenAbsent(
        host, binding.threadSource, profile, session, token, error,
      );
      if (matches.length > 1) this.#throwThreadSourceConflict(binding.threadSource);
      this.#assertThreadMatchActive(matches[0]);
      return {
        threadId: await this.#resumeRecoveredThread(
          host,
          matches[0].id,
          profile,
          session,
          token,
          binding.threadSource,
        ),
        fresh: false,
      };
    }
  }

  #finishContextTransfer(runId, state, errorCode = null) {
    if (!this.transcriptStore) return;
    const run = this.dispatcher.getRun(runId), contract = this.runExecutionContracts.get(runId);
    const key = run && this.getRunSessionKey(run), session = key && this.chatSessionStore.getSession(key);
    if (!session || !contract?.contextFresh || run.source === "compaction") return;
    const receipt = require("./context-transfer").readContextTransfer(this.transcriptStore, session);
    if (!receipt || !["ready", "unknown"].includes(receipt.state) || receipt.targetBindingId !== contract.bindingId) return;
    const request = contract.contextRequest;
    require("./context-transfer").recordContextTransfer(this.transcriptStore, session, { ...receipt,
      state, errorCode, snapshotId: contract.contextSnapshotId ?? receipt.snapshotId,
      mode: request?.completeness === "partial" ? "partial" : request?.coverage > 0
        ? receipt.mode === "transport_summary" ? "transport_summary" : "summary" : "original",
      updatedAt: this.now() });
    this.onRuntimeContextChanged({ profileId: session.profileId, sessionKey: key });
  }

  #commitChatThreadBinding(sessionKey, threadId) {
    const session = this.chatSessionStore.getSession(sessionKey);
    if (!session) {
      throw coordinatorError("CHAT_SESSION_NOT_FOUND", `ChatSession 不存在: ${sessionKey}`);
    }
    const binding = this.chatSessionStore.getBinding(sessionKey);
    if (!binding) {
      throw coordinatorError("CHAT_BINDING_RECOVERY_NOT_FOUND", "ChatSession 缺少 binding operation");
    }
    const sessionRuntimeId = runtimeSessionIdOf(session);
    const bindingRuntimeId = runtimeSessionIdOf(binding);
    if (session.status === "binding" && sessionRuntimeId === null
      && binding.state === "pending") {
      this.chatSessionStore.completeBinding(sessionKey, binding.operationId, threadId);
      return;
    }
    if (session.status === "ready" && sessionRuntimeId === threadId
      && binding.state === "bound" && bindingRuntimeId === threadId) return;
    if (session.status === "ready" && sessionRuntimeId !== null
      && binding.state === "bound" && bindingRuntimeId === sessionRuntimeId) {
      this.chatSessionStore.replaceBoundRuntimeSession({ sessionKey, operationId: binding.operationId,
        expectedRuntimeSessionId: sessionRuntimeId, runtimeSessionId: threadId });
      return;
    }
    throw coordinatorError("CHAT_SESSION_BINDING_CONFLICT", "ChatSession binding 在执行期间发生变化");
  }

  async #resumeRecoveredThread(
    host, threadId, profile, session, token, expectedThreadSource = null,
  ) {
    this.#claimRuntimeSessionOwnership(token, threadId);
    return this.#resumeThread(
      host,
      threadId,
      profile,
      session,
      token,
      expectedThreadSource,
    );
  }

  async #resumeThread(host, threadId, profile, session, token, expectedThreadSource = null) {
    this.#assertRuntimeSessionOwned(token, threadId);
    const response = await this.#timedPerformanceStage(
      token.runId,
      "session_resume",
      () => this.#retryablePreTurnCall(
        "session_start_or_resume",
        token,
        () => host.sessionResume(this.#sessionResumeParams(threadId, profile, session)),
      ),
    );
    this.#fence(token);
    if (response?.session?.id !== threadId) {
      throw coordinatorError("CODEX_THREAD_RESUME_MISMATCH", "thread/resume 返回了错误的 thread id");
    }
    if (expectedThreadSource !== null && response.session.source !== expectedThreadSource) {
      throw coordinatorError(
        "CODEX_THREAD_RESUME_SOURCE_MISMATCH",
        "thread/resume 返回了错误的 threadSource",
      );
    }
    return threadId;
  }

  async #findThreadsBySource(host, threadSource, token) {
    const matches = [];
    const seenIds = new Map();
    for (const archived of [false, true]) {
      const seenCursors = new Set();
      let cursor;
      let exhausted = false;
      for (let page = 0; page < MAX_THREAD_LIST_PAGES; page += 1) {
        const params = {
          limit: 100,
          archived,
        };
        if (cursor !== undefined) params.cursor = cursor;
        const response = await this.#retryablePreTurnCall(
          "session_start_or_resume",
          token,
          () => host.sessionList(params),
        );
        this.#fence(token);
        if (!response || !Array.isArray(response.data)) {
          throw coordinatorError("CODEX_THREAD_LIST_INVALID_RESPONSE", "thread/list 返回无效 data");
        }
        for (const runtimeSession of response.data) {
          if (runtimeSession?.source !== threadSource) continue;
          if (typeof runtimeSession.id !== "string" || runtimeSession.id.length === 0) {
            throw coordinatorError("CODEX_THREAD_LIST_INVALID_RESPONSE", "thread/list 返回无 id thread");
          }
          const previousPartition = seenIds.get(runtimeSession.id);
          if (previousPartition !== undefined && previousPartition !== archived) {
            throw coordinatorError(
              "CODEX_THREAD_STATE_CONFLICT",
              `Codex thread ${runtimeSession.id} 同时出现在 active 与 archived 分区`,
            );
          }
          if (previousPartition === undefined) {
            seenIds.set(runtimeSession.id, archived);
            matches.push({ id: runtimeSession.id, archived });
          }
        }
        const nextCursor = response.nextCursor;
        if (nextCursor === null || nextCursor === undefined) {
          exhausted = true;
          break;
        }
        if (typeof nextCursor !== "string" || nextCursor.length === 0 || seenCursors.has(nextCursor)) {
          throw coordinatorError("CODEX_THREAD_LIST_CURSOR_INVALID", "thread/list cursor 无法安全推进");
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      if (!exhausted) {
        throw coordinatorError("CODEX_THREAD_LIST_PAGE_LIMIT", "thread/list 分页超过安全上限");
      }
    }
    return matches;
  }

  #assertThreadMatchActive(match) {
    if (match.archived) {
      throw coordinatorError(
        "CODEX_THREAD_ARCHIVED",
        `已归档的 Codex thread ${match.id} 只能作为防重复证据，不能绑定或继续执行`,
      );
    }
  }

  #throwThreadSourceConflict(threadSource) {
    throw coordinatorError(
      "CODEX_THREAD_SOURCE_CONFLICT",
      `threadSource ${threadSource} 对应多个 Codex thread`,
    );
  }

  async #ensureTurn(host, threadId, profile, session, command, token, fresh = false) {
    token.contextAttemptSessionId = threadId;
    let thread;
    let matches;
    if (!fresh) {
      thread = await this.#readThread(host, threadId, token);
      matches = userMessageTurnIds(thread, command.operationId);
      if (matches.length === 1) return matches[0];
      assertHistoryCanProveAbsence(thread);
    }

    let response;
    const turnStartedAt = this.now();
    const performance = this.#performanceFor(token.runId);
    performance.turnStartedAt = turnStartedAt;
    performance.firstRuntimeEventSeen = false;
    performance.toolStartedAt.clear();
    performance.federationToolNames.clear();
    try {
      response = await this.#runtimeStageCall(
        "turn_start",
        token,
        () => host.turnStart(this.#turnStartParams(threadId, profile, session, command, fresh)),
      );
      this.#appendPerformanceStage(token.runId, "turn_start", turnStartedAt, "success");
      this.#fence(token);
    } catch (error) {
      this.#appendPerformanceStage(token.runId, "turn_start", turnStartedAt, "error");
      if (isRuntimeAuthRequired(error) || runtimeAccountRetryAt(error) !== null) throw error;
      this.#fence(token);
      let reconciliationTimer;
      try {
        thread = await (this.getNativeRuntimeConfig()?.flags?.runtimeAdmissionV1
          ? Promise.race([
            this.#readThread(host, threadId, token),
            new Promise((_, reject) => {
              reconciliationTimer = setTimeout(() => reject(error), this.startupReconcileTimeoutMs);
            }),
          ]) : this.#readThread(host, threadId, token));
      } catch (reconciliationError) {
        if (isRuntimeAuthRequired(reconciliationError)
          || ownDataErrorCode(reconciliationError) === "CODEX_RPC_TERMINATED") {
          throw reconciliationError;
        }
        throw error;
      } finally { clearTimeout(reconciliationTimer); }
      matches = userMessageTurnIds(thread, command.operationId);
      if (matches.length === 1) return matches[0];
      assertHistoryCanProveAbsence(thread);
      throw error;
    }
    const turnId = response?.turn?.id;
    if (typeof turnId !== "string" || turnId.length === 0) {
      throw coordinatorError("CODEX_TURN_START_INVALID_RESPONSE", "turn/start 返回无效 turn id");
    }
    return turnId;
  }

  async #readThread(host, threadId, token) {
    this.#assertRuntimeSessionOwned(token, threadId);
    const response = await this.#timedPerformanceStage(
      token.runId,
      "session_read",
      () => this.#runtimeStageCall(
        "session_start_or_resume",
        token,
        () => host.sessionRead({ sessionId: threadId, includeTurns: true }),
      ),
    );
    this.#fence(token);
    if (response?.session?.id !== threadId) {
      throw coordinatorError("CODEX_THREAD_READ_MISMATCH", "thread/read 返回了错误的 thread id");
    }
    return response.session;
  }

  #sessionStartParams(threadSource, profile, session) {
    return definedProperties({
      source: threadSource,
      persistent: true,
      developerInstructions: profile.developerInstructions,
      model: profile.defaultModel,
      cwd: session.workspace,
      permissionPolicy: profile.permissionPolicy,
      permissionMode: profile.permissionMode,
    });
  }

  #sessionResumeParams(threadId, profile, session) {
    return definedProperties({
      sessionId: threadId,
      developerInstructions: profile.developerInstructions,
      model: profile.defaultModel,
      cwd: session.workspace,
      permissionPolicy: profile.permissionPolicy,
      permissionMode: profile.permissionMode,
    });
  }

  #turnStartParams(threadId, profile, session, command, fresh = false) {
    const attachments = command.attachments?.length
      ? prepareChatAttachments(this.getMediaStore(), command.attachments, session.sessionKey) : [];
    const params = { ...definedProperties({
      sessionId: threadId,
      operationId: command.operationId,
      prompt: attachmentPrompt(command.prompt, attachments),
      ...(attachments.length ? { attachments } : {}),
      attachmentDirectory: chatAttachmentDirectory(this.getMediaStore?.(), session.sessionKey),
      context: profile.contextLifecycleV1 && !fresh && !profile.contextFresh
        ? profile.dynamicContextWithoutTranscript : profile.dynamicContext,
      observeContextUsage: profile.contextLifecycleV1 === true,
      model: profile.defaultModel,
      cwd: session.workspace,
      permissionPolicy: profile.permissionPolicy,
      permissionMode: profile.permissionMode,
    }), ...(profile.modelSettings ? { thinkingLevel: profile.modelSettings.thinkingLevel,
      serviceTier: profile.modelSettings.serviceTier } : {}) };
    require("./context-request-budget").assertContextTransport({ runtime: profile.runtime,
      prompt: params.prompt, context: params.context ?? "", attachments });
    return params;
  }
}

function createWorkRunCoordinator(options) {
  return new WorkRunCoordinator(options);
}

module.exports = {
  WorkRunCoordinator,
  bindingOperationId,
  createWorkRunCoordinator,
  runIdempotencyKey,
};
