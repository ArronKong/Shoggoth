"use strict";

const crypto = require("node:crypto");
const {
  containsRegisteredSecret,
  redactDiagnostic,
  validateRegisteredSecrets,
} = require("./codex-rpc-safety");
const { safeSnapshot } = require("./codex-event-snapshot");

const TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
  "sleep",
]);

const TOOL_UPDATE_METHODS = new Set([
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/dynamicToolCall/progress",
]);

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
]);

const PROMPT_METHODS = new Set([
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

const ACCOUNT_AUTH_MODES = new Set([
  "apikey", "chatgpt", "chatgptAuthTokens", "headers", "agentIdentity",
  "personalAccessToken", "bedrockApiKey",
]);
const ACCOUNT_PLAN_TYPES = new Set([
  "free", "go", "plus", "pro", "prolite", "team",
  "self_serve_business_prolite", "self_serve_business_usage_based", "business", "ent26",
  "enterprise_cbp_automation", "enterprise_cbp_usage_based", "enterprise",
  "edu", "edu_plus", "edu_pro", "unknown",
]);
const TOKEN_USAGE_FIELDS = Object.freeze([
  "totalTokens", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens",
  "outputTokens", "reasoningOutputTokens",
]);
const RATE_LIMIT_REACHED_TYPES = new Set([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);
const MAX_ACCOUNT_BACKOFF_MS = 366 * 24 * 60 * 60 * 1_000;

function safeId(value, options) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  return redactDiagnostic(value, options.registeredSecrets).slice(0, 96);
}

function safeDisplayId(value, options, maxBytes = 96) {
  if (typeof value !== "string") return undefined;
  const redacted = redactDiagnostic(value, options.registeredSecrets);
  let bytes = 0;
  let result = "";
  for (const codePoint of redacted) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (bytes + size > maxBytes) break;
    result += codePoint;
    bytes += size;
  }
  return result;
}

function base(message, options) {
  const params = message?.params && typeof message.params === "object" ? message.params : {};
  const item = params.item && typeof params.item === "object" ? params.item : {};
  return {
    method: typeof message?.method === "string"
      ? redactDiagnostic(message.method, options.registeredSecrets).slice(0, 96)
      : "<invalid>",
    threadId: safeId(params.threadId ?? params.thread?.id, options),
    turnId: safeId(params.turnId ?? params.turn?.id, options),
    itemId: safeId(params.itemId ?? item.id, options),
    toolCallId: safeId(params.toolCallId ?? params.itemId ?? item.id, options),
    requestId: safeId(message?.id ?? params.requestId, options),
  };
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function tokenUsage(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized = {};
  for (const field of TOKEN_USAGE_FIELDS) {
    const candidate = field === "cacheWriteInputTokens" && value[field] === undefined
      ? 0 : value[field];
    if (!Number.isSafeInteger(candidate) || candidate < 0) return null;
    normalized[field] = candidate;
  }
  return normalized;
}

function safeFutureResetAt(value, now) {
  if (!Number.isSafeInteger(value) || value < 0
    || value > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) return null;
  const retryAt = value * 1_000;
  return retryAt > now && retryAt - now <= MAX_ACCOUNT_BACKOFF_MS ? retryAt : null;
}

function accountRateLimitRetryAt(value, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Number.isSafeInteger(now) || now < 0) return null;
  const windows = [value.primary, value.secondary].filter(
    (window) => window && typeof window === "object" && !Array.isArray(window),
  );
  const exhaustedResets = windows.filter(
    (window) => typeof window.usedPercent === "number"
      && Number.isFinite(window.usedPercent) && window.usedPercent >= 100,
  ).map((window) => safeFutureResetAt(window.resetsAt, now)).filter(Number.isSafeInteger);
  if (value.spendControlReached === true
    && value.individualLimit && typeof value.individualLimit === "object"
    && !Array.isArray(value.individualLimit)) {
    const spendReset = safeFutureResetAt(value.individualLimit.resetsAt, now);
    if (spendReset !== null) exhaustedResets.push(spendReset);
  }
  if (exhaustedResets.length > 0) return Math.max(...exhaustedResets);
  if (!RATE_LIMIT_REACHED_TYPES.has(value.rateLimitReachedType)) return null;
  const knownResets = [
    ...windows.map((window) => safeFutureResetAt(window.resetsAt, now)),
    safeFutureResetAt(value.individualLimit?.resetsAt, now),
  ].filter(Number.isSafeInteger);
  // Sparse notifications may identify the reached state without identifying
  // which window caused it. Use the nearest protocol-provided reset rather
  // than manufacturing a delay or pessimistically blocking on an unrelated window.
  return knownResets.length > 0 ? Math.min(...knownResets) : null;
}

function threadUsageResponseId(identifiers, totalUsage) {
  if (typeof identifiers.threadId !== "string" || typeof identifiers.turnId !== "string"
    || totalUsage === null) return undefined;
  const fingerprint = JSON.stringify([
    identifiers.threadId,
    identifiers.turnId,
    ...TOKEN_USAGE_FIELDS.map((field) => totalUsage[field]),
  ]);
  return `thread-usage-${crypto.createHash("sha256").update(fingerprint).digest("hex")}`;
}

function toolDescriptor(item) {
  const tool = { kind: item.type, status: item.status };
  if (item.type === "commandExecution") {
    tool.name = "command";
    tool.input = item.command;
    tool.output = item.aggregatedOutput;
    tool.exitCode = item.exitCode;
  } else if (item.type === "fileChange") {
    tool.name = "fileChange";
    tool.input = item.changes;
  } else if (item.type === "mcpToolCall") {
    tool.name = `${item.server}/${item.tool}`;
    tool.input = item.arguments;
    tool.output = item.result ?? item.error;
    tool.error = item.error;
  } else if (item.type === "dynamicToolCall") {
    tool.name = item.namespace ? `${item.namespace}/${item.tool}` : item.tool;
    tool.input = item.arguments;
    tool.output = item.contentItems;
    tool.success = item.success;
  } else if (item.type === "webSearch") {
    tool.name = "webSearch";
    tool.input = item.query;
    tool.output = item.results;
  } else {
    tool.name = item.tool ?? item.type;
  }
  return compact(tool);
}

function unknownDiagnostic(message, options, identifiers) {
  const maxBytes = Math.max(128, options.maxDiagnosticBytes ?? 512);
  const diagnostic = compact({
    known: false,
    type: "diagnostic",
    method: identifiers.method.slice(0, 96),
    threadId: identifiers.threadId,
    turnId: identifiers.turnId,
    itemId: identifiers.itemId,
    toolCallId: identifiers.toolCallId,
    requestId: identifiers.requestId,
  });
  if (Buffer.byteLength(JSON.stringify(diagnostic)) <= maxBytes) return diagnostic;
  for (const field of ["toolCallId", "itemId", "turnId", "threadId", "requestId"]) {
    delete diagnostic[field];
    if (Buffer.byteLength(JSON.stringify(diagnostic)) <= maxBytes) break;
  }
  if (Buffer.byteLength(JSON.stringify(diagnostic)) > maxBytes) {
    const methodCharacters = Array.from(diagnostic.method);
    while (methodCharacters.length > 0) {
      methodCharacters.pop();
      diagnostic.method = methodCharacters.join("");
      if (Buffer.byteLength(JSON.stringify(diagnostic)) <= maxBytes) break;
    }
  }
  return diagnostic;
}

function normalizeCodexEvent(message, rawOptions = {}) {
  const options = {
    registeredSecrets: validateRegisteredSecrets(rawOptions.registeredSecrets || []),
    maxDiagnosticBytes: rawOptions.maxDiagnosticBytes,
    maxSnapshotArrayItems: rawOptions.maxSnapshotArrayItems,
    maxSnapshotBytes: rawOptions.maxSnapshotBytes,
    maxSnapshotDepth: rawOptions.maxSnapshotDepth,
    maxSnapshotKeys: rawOptions.maxSnapshotKeys,
    maxSnapshotStringBytes: rawOptions.maxSnapshotStringBytes,
  };
  const identifiers = base(message, options);
  const params = message?.params && typeof message.params === "object" ? message.params : {};
  const method = identifiers.method;
  const known = (type, extra = {}) => safeSnapshot(
    compact({ known: true, type, ...identifiers, ...extra }),
    options,
  );

  if (method === "item/agentMessage/delta") {
    return known("text_delta", { delta: typeof params.delta === "string" ? params.delta : "" });
  }
  if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
    return known("reasoning_delta", { delta: typeof params.delta === "string" ? params.delta : "" });
  }
  if (method === "item/reasoning/summaryPartAdded") {
    return known("reasoning", { summaryIndex: params.summaryIndex });
  }
  if (method === "turn/plan/updated") {
    return known("plan", { plan: params.plan ?? params.steps ?? [] });
  }
  if (method === "item/plan/delta") {
    return known("plan", { delta: typeof params.delta === "string" ? params.delta : "" });
  }
  if (method === "item/started" || method === "item/completed") {
    const item = params.item && typeof params.item === "object" ? params.item : null;
    if (item?.type === "reasoning") {
      return known("reasoning", { itemId: safeId(item.id, options), reasoning: item.summary ?? item.content ?? [] });
    }
    if (item?.type === "plan") {
      return known("plan", { itemId: safeId(item.id, options), text: item.text ?? "" });
    }
    if (item?.type === "agentMessage") {
      return known("text", { itemId: safeId(item.id, options), text: item.text ?? "" });
    }
    if (item && TOOL_ITEM_TYPES.has(item.type)) {
      return known(method === "item/started" ? "tool_start" : "tool_result", {
        itemId: safeId(item.id, options),
        toolCallId: safeId(item.id, options),
        tool: toolDescriptor(item),
      });
    }
  }
  if (TOOL_UPDATE_METHODS.has(method)) {
    return known("tool_update", {
      delta: typeof params.delta === "string" ? params.delta : undefined,
      patch: params.patch,
      progress: params.progress,
    });
  }
  if (method === "thread/started") {
    return known("status", { status: "started" });
  }
  if (method === "turn/started") {
    return known("status", {
      turnId: safeId(params.turn?.id ?? params.turnId, options),
      status: params.turn?.status ?? "inProgress",
    });
  }
  if (method === "thread/status/changed" || method === "thread/status/changed") {
    return known("status", { status: params.status });
  }
  if (APPROVAL_METHODS.has(method)) {
    return known("approval", {
      command: params.command,
      commandActions: params.commandActions ?? params.parsedCmd,
      cwd: params.cwd,
      reason: params.reason,
      permissions: params.permissions,
      fileChanges: params.fileChanges,
      grantRoot: params.grantRoot,
      proposedExecpolicyAmendment: params.proposedExecpolicyAmendment,
      proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments,
    });
  }
  if (PROMPT_METHODS.has(method)) {
    return known("prompt", {
      questions: params.questions,
      isBlocking: params.isBlocking,
      autoResolutionMs: params.autoResolutionMs,
      message: params.message,
      requestedSchema: params.requestedSchema,
      serverName: params.serverName,
      mode: params.mode,
      url: params.url,
      elicitationId: params.elicitationId,
    });
  }
  if (method === "turn/completed") {
    return known("complete", {
      turnId: safeId(params.turn?.id ?? params.turnId, options),
      status: params.turn?.status ?? "completed",
    });
  }
  if (method === "thread/tokenUsage/updated") {
    const usage = tokenUsage(params.tokenUsage?.last);
    const totalUsage = tokenUsage(params.tokenUsage?.total);
    const responseId = usage === null ? undefined : threadUsageResponseId(identifiers, totalUsage);
    return known("usage", {
      responseId,
      usage: responseId === undefined ? null : usage,
    });
  }
  if (method === "rawResponse/completed") {
    // 该通知在 Codex 协议中明确标记为 internal-only。保留安全诊断摘要，
    // 但只用公开的 thread/tokenUsage/updated 写入统计，避免两种事件重复计量。
    return known("raw_usage", {
      responseId: safeId(params.responseId, options),
      usage: tokenUsage(params.usage),
    });
  }
  if (method === "account/login/completed") {
    return known("account_login", {
      loginIdDisplay: safeDisplayId(params.loginId, options),
      status: params.success === true ? "succeeded" : "failed",
      errorCode: params.success === true ? undefined : "ACCOUNT_LOGIN_FAILED",
    });
  }
  if (method === "account/updated") {
    return known("account_updated", {
      authMode: ACCOUNT_AUTH_MODES.has(params.authMode) ? params.authMode : undefined,
      planType: ACCOUNT_PLAN_TYPES.has(params.planType) ? params.planType : undefined,
    });
  }
  if (method === "account/rateLimits/updated") {
    const retryAt = accountRateLimitRetryAt(params.rateLimits);
    return retryAt === null
      ? known("account_rate_limits")
      : known("account_backoff", { retryAt });
  }
  if (method === "error") {
    return known("error", {
      errorCode: safeId(params.error?.code ?? params.code ?? "CODEX_ERROR", options),
      error: params.error ?? params,
    });
  }
  if (method === "warning" || method === "guardianWarning" || method === "configWarning") {
    return known("error", { severity: "warning", errorCode: "CODEX_WARNING" });
  }
  const diagnostic = unknownDiagnostic(message, options, identifiers);
  return containsRegisteredSecret(JSON.stringify(diagnostic), options.registeredSecrets) ? {} : diagnostic;
}

module.exports = {
  APPROVAL_METHODS,
  PROMPT_METHODS,
  TOOL_ITEM_TYPES,
  TOOL_UPDATE_METHODS,
  accountRateLimitRetryAt,
  normalizeCodexEvent,
};
