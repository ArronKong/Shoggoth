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
const { runtimeCommandUsesReservedHostCapability } = require("./runtime-host-command-policy");
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
const MAX_PENDING_REQUESTS = 64;
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
  "RUNTIME_PERMISSION_REQUIRED",
  "RUNTIME_APPROVAL_UNAVAILABLE",
  "ANTIGRAVITY_ONBOARDING_REQUIRED",
  "ANTIGRAVITY_APPROVAL_FORMAT_UNSUPPORTED",
  "ANTIGRAVITY_APPROVAL_CHANGED",
  "RUNTIME_QUOTA_EXHAUSTED",
  "RUNTIME_ACCOUNT_BLOCKED",
  "RUNTIME_UPSTREAM_UNAVAILABLE",
  ...CODEX_SETUP_ERROR_CODES,
]);
const START_OPERATIONAL_ERROR_CODES = new Set([
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

function failedTurnErrorCode(turn) {
  if (["AUTH_REQUIRED", RUNTIME_AUTH_REQUIRED_CODE].includes(turn?.errorCode)
    || turn?.error?.codexErrorInfo === "unauthorized") {
    return RUNTIME_AUTH_REQUIRED_CODE;
  }
  if (PUBLIC_RUNTIME_OPERATIONAL_ERROR_CODES.has(turn?.errorCode)) return turn.errorCode;
  return "RUNTIME_TURN_FAILED";
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
    ?? value?.codexThreadId
    ?? null;
}

function runtimeTurnIdOf(value) {
  return value?.runtimeTurnRef?.turnId ?? value?.codexTurnId ?? null;
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
        ["admit", "release", "assertGeneration", "noteBackoff"],
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
    this.runtimeSessionOwnershipStore = options.runtimeSessionOwnershipStore || null;
    this.now = options.now || Date.now;
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
    this.everOpened = false;
    this.lifecycleGeneration = 0;
    this.runGenerations = new Map();
    this.runTails = new Map();
    this.lastErrors = new Map();
    this.runStreams = new Map();
    this.terminalStreams = new Map();
    this.rehydratedTerminalStreams = new Set();
    this.terminalizingRuns = new Set();
    this.runContexts = new Map();
    this.runExecutionContracts = new Map();
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
    this.#assertOpen();
    return this.dispatcher.getRun(runId);
  }

  listRuns(query = {}) {
    this.#assertOpen();
    return this.dispatcher.listRuns(query);
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

  getRuntimeContextForLegacyRun(profileId, runId) {
    this.#assertOpen();
    if (!validOpaqueId(profileId) || !validOpaqueId(runId)) return null;
    const requested = this.dispatcher.getRun(runId);
    if (requested?.profileId === profileId && ACTIVE_RUN_STATES.has(requested.status)) {
      return this.#runtimeContextForRun(requested);
    }
    const matches = this.dispatcher.listRuns({}).filter(
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
      const initial = this.#selectChatRun(input.sessionKey, input.runId);
      return this.#chainRunTask(initial.id, async () => {
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
    const terminalizingAtEntry = this.terminalizingRuns.size > 0;
    const commands = this.inbox.list().filter((command) => ACTIVE_COMMAND_STATES.has(command.state));
    const commandedRunIds = new Set(commands.map((command) => command.runId));
    // Inbox 已成功解锁但找不到 active 命令时，starting Chat Run 无法证明 prompt、
    // operation 与远端绑定，继续保留只会永久占用 Profile 准入槽。
    for (const run of this.dispatcher.listRuns({ source: "chat" })) {
      if (run.status === "starting" && !commandedRunIds.has(run.id)) {
        await this.#interruptForLostExecutionContract(run.id, lifecycle);
      }
    }
    // Domain execution payload 与 execution contract 都是当前 Service lifecycle 的
    // 内存所有权；重启后无法证明旧 starting Run 对应的 prompt/thread 绑定。
    if (this.recoverOrphanedDomainRuns) {
      for (const run of this.dispatcher.listRuns()) {
        if (run.status === "starting" && ["cron", "kanban", "inspiration"].includes(run.source)) {
          await this.#interruptForLostExecutionContract(run.id, lifecycle);
        }
      }
    }
    const records = [];
    const recoveries = [];
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
        run = admission.run;
        if (admission.disposition === "queued") continue;
      }
      if (run.status === "starting" && !this.runExecutionContracts.has(run.id)) {
        await this.#interruptForLostExecutionContract(run.id, lifecycle);
        continue;
      }
      if (run.status === "starting") recoveries.push(this.#schedule(run.id));
    }
    return recoveries;
  }

  async send(input) {
    this.#assertOpen();
    this.#assertInboxAvailable();
    if (!exactObject(input, attachmentFields(input, ["operationId", "sessionKey", "prompt"]))
      || (input.attachments !== undefined && !validAttachments(input.attachments))) {
      throw coordinatorError("WORK_RUN_SEND_INVALID", "send 需要 operationId/sessionKey/prompt，可附带有效的附件描述");
    }
    const session = this.chatSessionStore.getSession(input.sessionKey);
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

    let disposition = run.status === "queued" ? "queued" : "started";
    let reason = null;
    if (run.status === "queued") {
      const admission = this.#admit(run.id, session.profileId);
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

  #assertOpen() {
    if (this.poisonError) throw this.poisonError;
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

  #selectChatRun(sessionKey, runId) {
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
    const matches = this.listSessionRuns(sessionKey)
      .filter((run) => ACTIVE_RUN_STATES.has(run.status));
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

  getRunSessionKey(runOrId) {
    const run = typeof runOrId === "string" ? this.dispatcher.getRun(runOrId) : runOrId;
    if (!run) return null;
    if (run.source === "chat") return run.sourceId;
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
      runtimeRef: null, contextExcluded: false, occurredAt: run.startedAt ?? this.now() };
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
    const canceled = this.dispatcher.transition(runId, errorCode ? "skipped" : "canceled", {
      resultSummary: errorCode ? `Execution could not start (${errorCode}).` : null,
    });
    this.#appendTerminal(runId, { status: canceled.status, resultSummary: canceled.resultSummary, errorCode: null });
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
    this.#releaseRuntimeAccountAdmission(runId);
    this.#settlePendingForAbort(runId);
    this.#resolveTerminalWaiter(runId);
    this.runContexts.delete(runId);
    this.runExecutionContracts.delete(runId);
    this.domainCommands.delete(runId);
    this.runHostAssignments.delete(runId);
    this.runPerformance.delete(runId);
    this.runGenerations.delete(runId);
    this.lastErrors.delete(runId);
    this.rehydratedTerminalStreams.delete(runId);
    this.#retainTerminalStream(runId);
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

  #observeHost(host, runtimeProfileId) {
    if (this.hostObservers.has(host)) return;
    requireMethods(
      host,
      ["subscribe", "registerServerRequestHandler"],
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
    };
    this.hostObservers.set(host, observer);
    try {
      for (const method of STABLE_SERVER_REQUEST_METHODS) {
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
      () => this.#hostTerminated(host, observer),
    ).catch(() => {});
  }

  #hostTerminated(host, observer) {
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
          await this.#interruptForHostTermination(run.id, {
            lifecycle,
            run: assignment.generation,
            runId: run.id,
          });
        } catch (error) {
          this.lastErrors.set(run.id, error);
          throw error;
        }
      });
    }
  }

  #handleServerRequest(host, method, params) {
    this.#assertOpen();
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
    const timeoutMs = serverRequestUsesApprovalWait(method, params)
      ? this.approvalTimeoutMs : this.promptTimeoutMs;
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
        toolInput: params.toolInput === undefined ? undefined : projectToolDisplayArgs({
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

  async #interruptForHostTermination(runId, token) {
    this.#fence(token);
    const run = this.dispatcher.getRun(runId);
    if (!run || !ACTIVE_RUN_STATES.has(run.status)) return run;
    return this.#withTerminalizing(runId, async () => {
      let terminal;
      try {
        this.#fence(token);
        terminal = this.dispatcher.transition(runId, "interrupted", {
          errorCode: "CODEX_HOST_TERMINATED",
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
          errorCode: "CODEX_HOST_TERMINATED",
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

  async #interruptForLostExecutionContract(runId, lifecycle) {
    this.#fenceLifecycle(lifecycle);
    return this.#withTerminalizing(runId, async () => {
      let terminal;
      try {
        this.#fenceLifecycle(lifecycle);
        terminal = this.dispatcher.transition(runId, "interrupted", {
          errorCode: "EXECUTION_CONTRACT_LOST",
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
          errorCode: "EXECUTION_CONTRACT_LOST",
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
    if (event.type !== "account_backoff") return false;
    if (!this.runtimeAccountAdmission || host?.runtime !== "codex"
      || typeof host.runtimeAccountId !== "string") return true;
    const current = this.now();
    if (!Number.isSafeInteger(current) || current < 0
      || !Number.isSafeInteger(event.retryAt) || event.retryAt <= current
      || event.retryAt - current > MAX_TRUSTED_ACCOUNT_BACKOFF_MS) return true;
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
      this.runtimeAccountAdmission.noteBackoff({
        runtimeAccountId: admission.runtimeAccountId,
        retryAt: event.retryAt,
      });
      accounts.add(admission.runtimeAccountId);
    }
    return true;
  }

  #routeHostEvent(host, event, allowBuffer = true) {
    if (this.poisonError || !["opening", "open"].includes(this.state) || event?.known !== true) return;
    if (this.#routeRuntimeAccountBackoff(host, event)) return;
    const eventSessionId = event.sessionId ?? event.threadId;
    const match = [...this.runContexts.entries()].find(([runId, context]) => (
      context.host === host
      && context.generation === this.runGenerations.get(runId)
      && eventSessionId === context.threadId
      && event.turnId === context.turnId
    ));
    if (!match) {
      const observer = this.hostObservers.get(host);
      if (allowBuffer && observer
        && typeof eventSessionId === "string" && eventSessionId.length > 0
        && typeof event.turnId === "string" && event.turnId.length > 0
        && [
          "text_delta", "text", "reasoning_delta", "reasoning", "plan",
          "tool_start", "tool_update", "tool_result", "status", "complete", "usage",
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
          agentId: profile.agentId || profile.id,
          agentName: profile.name || profile.agentId || profile.id,
          source: run.source,
          sourceId: run.sourceId,
          threadId: context.threadId,
          turnId: context.turnId,
          responseId: event.responseId,
          model: runtimeModel ?? execution?.defaultModel ?? profile.defaultModel ?? null,
          provider: runtimeProvider ?? profile.providerRef ?? null,
          usage: event.usage,
          createdAt: this.now(),
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
        }),
      }),
      status: () => ({ method: event.method, status: event.status }),
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
      if (eventSessionId !== context.threadId || event.turnId !== context.turnId) return true;
      matching.push(event);
      return false;
    });
    for (const event of matching) this.#routeHostEvent(host, event, false);
  }

  #admit(runId, profileId, lifecycle = null) {
    const profile = this.productStore.getAgentProfile(profileId);
    if (!profile) {
      throw coordinatorError("UNKNOWN_AGENT_PROFILE", `AgentProfile 不存在: ${profileId}`);
    }
    const run = this.dispatcher.getRun(runId);
    const sessionKey = this.getRunSessionKey(run);
    if (sessionKey && this.listSessionRuns(sessionKey)
      .some((candidate) => candidate.id !== run.id && ACTIVE_RUN_STATES.has(candidate.status))) {
      return { disposition: "queued", reason: "CHAT_SESSION_BUSY", run };
    }
    // execution contract 必须在 durable 状态进入 starting 前完整可构建；否则
    // 准入写入成功、随后校验失败会留下永远占槽的 starting Run。
    const executionContract = this.#executionContract(profile, run);
    if (lifecycle !== null) this.#fenceLifecycle(lifecycle);
    const accountAdmission = this.runtimeAccountAdmission?.admit({
      runtimeAccountId: executionContract.runtimeAccountId,
      runId,
    }) || null;
    if (accountAdmission?.disposition === "queued") {
      return { ...accountAdmission, run };
    }
    let admission;
    try {
      if (lifecycle !== null) this.#fenceLifecycle(lifecycle);
      admission = this.dispatcher.admit(runId, {
        onBusy: "queue",
        writable: executionContract.permissionPolicy.sandbox !== "read-only",
        ...(executionContract.contextSnapshotId === null
          ? {} : { contextSnapshotId: executionContract.contextSnapshotId }),
      });
    } catch (error) {
      if (accountAdmission) {
        this.runtimeAccountAdmission.release({
          runtimeAccountId: executionContract.runtimeAccountId,
          runId,
        });
      }
      throw error;
    }
    if (admission.disposition === "started") {
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
    } else if (accountAdmission) {
      this.runtimeAccountAdmission.release({
        runtimeAccountId: executionContract.runtimeAccountId,
        runId,
      });
    }
    return admission;
  }

  #executionContract(profile, run) {
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
    const resolvedPermission = resolveRuntimePermissionMode(
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
    const snapshot = this.contextCompiler ? this.contextCompiler.compile({
      profile,
      run,
      transcriptSessionId,
      query: command?.prompt || run.sourceId,
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
      ...(modelSettings ? { modelSettings: Object.freeze({ ...modelSettings }) } : {}),
      workspace: run.workspace,
      contextSnapshotId: snapshot?.id ?? null,
      toolRegistryRevision: snapshot?.revisions?.tools ?? null,
      toolPermissionRevision: snapshot?.revisions?.permission ?? null,
      developerInstructions: snapshot?.developerInstructions
        ?? shoggothProductDeveloperInstructions({
          source: run.source,
          sourceId: run.sourceId,
          profileName: profile.name,
          runtime: profile.runtime || "codex",
        }),
      dynamicContext: snapshot?.dynamicContext ?? null,
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
    const runGeneration = (this.runGenerations.get(runId) || 0) + 1;
    this.runGenerations.set(runId, runGeneration);
    const token = {
      lifecycle: this.lifecycleGeneration,
      run: runGeneration,
      runId,
      startupRetryUsed: false,
    };
    this.lastErrors.delete(runId);
    try {
      await this.#drive(runId, token);
    } catch (error) {
      if (await this.#failRunStart(runId, token, error)) return;
      this.lastErrors.set(runId, error);
      throw error;
    }
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
    const domainStart = ["cron", "kanban", "inspiration"].includes(run?.source)
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

  #fenceRuntimeAccount(token) {
    this.#fence(token);
    if (!this.runtimeAccountAdmission) return;
    const admission = this.runAccountAdmissions.get(token.runId);
    if (!admission) {
      throw coordinatorError(
        "RUNTIME_ACCOUNT_ADMISSION_LOST",
        `WorkRun ${token.runId} 缺少 RuntimeAccount 准入所有权`,
      );
    }
    this.runtimeAccountAdmission.assertGeneration(admission);
  }

  async #drive(runId, token) {
    this.#fence(token);
    let run = this.dispatcher.getRun(runId);
    if (!run) throw coordinatorError("WORK_RUN_NOT_FOUND", `WorkRun 不存在: ${runId}`);
    const commandRecord = this.#commandForRun(run);
    if (!commandRecord) return;
    const operationId = commandRecord.operationId;
    let { command } = commandRecord;
    if (commandRecord.kind === "chat" && !ACTIVE_COMMAND_STATES.has(command.state)) return;
    if (run.status === "queued") {
      if (commandRecord.kind === "chat" && command.state === "dispatching") {
        command = await this.inbox.transition(operationId, "pending");
      }
      const admission = this.#admit(run.id, run.profileId);
      run = admission.run;
      if (admission.disposition === "queued") return;
    }
    if (run.status === "running") {
      return;
    }
    if (run.status !== "starting") {
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
    const binding = runtimeBinding({
      runtime: executionContract.runtime,
      runtimeProfileId: executionContract.runtimeProfileId,
      runtimeAccountId: executionContract.runtimeAccountId,
    });
    const host = await this.#timedPerformanceStage(
      runId,
      "runtime_acquire",
      () => this.#retryablePreTurnCall(
        "runtime_acquire",
        token,
        () => this.runtimeManager.acquire(binding, {
          permissionPolicy: executionContract.runtimeHostPermissionPolicy,
          workspace: executionContract.workspace,
        }),
      ),
    );
    this.#fence(token);
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
        () => readRuntimeAuthenticationState(host),
      ),
    );
    this.#fence(token);
    if (authState.status === "unauthenticated") throw runtimeAuthRequiredError();
    this.runHostAssignments.set(runId, Object.freeze({
      host,
      runtime: executionContract.runtime,
      runtimeBinding: binding,
      runtimeProfileId: executionContract.runtimeProfileId,
      runtimeAccountId: executionContract.runtimeAccountId,
      generation: token.run,
      lifecycle: token.lifecycle,
    }));
    this.#observeHost(host, executionContract.runtimeProfileId);

    const threadBinding = productSessionKey && run.source !== "cron"
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
    if (token.startupRetryUsed || runtimeAccountRetryAt(error) !== null
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
      interrupted: { status: "interrupted", errorCode: "RUNTIME_TURN_INTERRUPTED" },
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
    for (const candidate of this.dispatcher.listRuns()) {
      this.#fenceLifecycle(lifecycle);
      if (candidate.status !== "queued") continue;
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
      const admission = this.#admit(candidate.id, candidate.profileId, lifecycle);
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
      if (typeof this.chatSessionStore.replaceBoundRuntimeSession === "function") {
        this.chatSessionStore.replaceBoundRuntimeSession({
          sessionKey,
          operationId: binding.operationId,
          expectedRuntimeSessionId: sessionRuntimeId,
          runtimeSessionId: threadId,
        });
      } else {
        this.chatSessionStore.replaceBoundThread({
          sessionKey,
          operationId: binding.operationId,
          expectedCodexThreadId: sessionRuntimeId,
          codexThreadId: threadId,
        });
      }
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
        () => host.turnStart(this.#turnStartParams(threadId, profile, session, command)),
      );
      this.#appendPerformanceStage(token.runId, "turn_start", turnStartedAt, "success");
      this.#fence(token);
    } catch (error) {
      this.#appendPerformanceStage(token.runId, "turn_start", turnStartedAt, "error");
      if (isRuntimeAuthRequired(error) || runtimeAccountRetryAt(error) !== null) throw error;
      this.#fence(token);
      try {
        thread = await this.#readThread(host, threadId, token);
      } catch (reconciliationError) {
        if (isRuntimeAuthRequired(reconciliationError)
          || ownDataErrorCode(reconciliationError) === "CODEX_RPC_TERMINATED") {
          throw reconciliationError;
        }
        throw error;
      }
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

  #turnStartParams(threadId, profile, session, command) {
    const attachments = command.attachments?.length
      ? prepareChatAttachments(this.getMediaStore(), command.attachments, session.sessionKey) : [];
    return { ...definedProperties({
      sessionId: threadId,
      operationId: command.operationId,
      prompt: attachmentPrompt(command.prompt, attachments),
      ...(attachments.length ? { attachments } : {}),
      attachmentDirectory: chatAttachmentDirectory(this.getMediaStore?.(), session.sessionKey),
      context: profile.dynamicContext,
      model: profile.defaultModel,
      cwd: session.workspace,
      permissionPolicy: profile.permissionPolicy,
      permissionMode: profile.permissionMode,
    }), ...(profile.modelSettings ? { thinkingLevel: profile.modelSettings.thinkingLevel,
      serviceTier: profile.modelSettings.serviceTier } : {}) };
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
