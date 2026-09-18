"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const {
  createMcpStdioHandler,
  runMcpStdioSession,
} = require("../shoggoth-mcp-helper");
const { createEventBuffer, jsonlBytes } = require("./event-buffer");
const {
  BACKEND_ID_PATTERN,
  DEFAULT_AGENT_PROFILE_ID,
  JsonlProductStore,
  validateModelProvider,
} = require("./product-store");
const { ACTIVE_WORK_RUN_STATUSES, createWorkDispatcher } = require("./work-run");
const { CodexRuntimePool } = require("./codex-runtime-pool");
const { CodexRuntimeAdapter } = require("./codex-runtime-adapter");
const { GrokBuildRuntimePool } = require("./grok-build-runtime-pool");
const { GrokBuildRuntimeAdapter } = require("./grok-build-runtime-adapter");
const { AntigravityRuntimePool } = require("./antigravity-runtime-pool");
const { AntigravityRuntimeAdapter } = require("./antigravity-runtime-adapter");
const { PiRuntimePool } = require("./pi-runtime-pool");
const { PiRuntimeAdapter } = require("./pi-runtime-adapter");
const { ClaudeCodeRuntimePool } = require("./claude-code-runtime-pool");
const { ClaudeCodeRuntimeAdapter } = require("./claude-code-runtime-adapter");
const { DeepSeekHarnessRuntimePool } = require("./deepseek-harness-runtime-pool");
const { DeepSeekHarnessRuntimeAdapter } = require("./deepseek-harness-runtime-adapter");
const { RuntimeAdapterRegistry } = require("./runtime-adapter-registry");
const { validRuntimeAccountId } = require("./runtime-adapter");
const { RuntimeMcpGateIssuer } = require("./runtime-mcp-gate");
const { ensureBuiltinCliAgentProfiles } = require("./builtin-cli-profiles");
const { CodexRuntimeConfigWriter } = require("./codex-runtime-config");
const { EncryptedSecretStore } = require("./encrypted-secret-store");
const { McpAuthSecretStore } = require("./mcp-auth-secret-store");
const { InProcessMcpCryptoBroker } = require("./mcp-crypto-broker");
const { McpSessionManager } = require("./mcp-session-manager");
const { ProviderRuntimeBridge } = require("./provider-runtime-bridge");
const { ProviderService } = require("./codex-provider-service");
const { migrateLegacySharedCodexApiKey } = require("./legacy-codex-api-key-migration");
const { reconcileProviderCredentialSecrets } = require("./provider-secret-reconciliation");
const { AccountAuthStateStore } = require("./account-auth-state-store");
const { AccountAuthManager } = require("./account-auth-manager");
const { NativeCodexAuth } = require("./codex-native-auth");
const { RuntimeAccountAdmission } = require("./runtime-account-admission");
const { LegacyRuntimeHomeStore } = require("./legacy-runtime-home-store");
const { RuntimeStorageCleanup } = require("./runtime-storage-cleanup");
const { RuntimeBackupStore } = require("./runtime-backup-store");
const { RuntimeBackupCleanup } = require("./runtime-backup-cleanup");
const {
  createRuntimeAccountServiceController,
} = require("./runtime-account-service-controller");
const { RuntimeSessionOwnershipStore } = require("./runtime-session-ownership-store");
const { ChatSessionStore } = require("./chat-session-store");
const { createStopImpact } = require("./stop-impact");
const { InspirationStore } = require("./inspiration-store");
const { InspirationService } = require("./inspiration-service");
const { ExternalInspirationExecutor } = require("./external-inspiration-executor");
const { INSPIRATION_SERVICE_METHODS, PUBLIC_MESSAGES: INSPIRATION_PUBLIC_MESSAGES,
  validateInspirationServiceParams, validateInspirationServiceResult } = require("./inspiration-service-protocol");
const { AgentDefinitionStore } = require("./agent-definition-store");
const { TranscriptStore } = require("./transcript-store");
const { MemoryStore } = require("./memory-store");
const { MemoryEngine } = require("./memory-engine");
const { ContextSnapshotStore } = require("./context-snapshot-store");
const { ContextCompiler } = require("./context-compiler");
const { NativeSkillStore } = require("./native-skill-store");
const { SystemHostController } = require("./system-host-controller");
const { ComputerUseController } = require("./computer-use-controller");
const { PermissionEngine } = require("./permission-engine");
const {
  completeMemoryMigration,
} = require("./memory-migration");
const { ensureRuntimeSchemaMigrationBackup } = require("./runtime-schema-migration");
const {
  RuntimeAccountMigrationOrchestrator,
} = require("./runtime-account-migration-orchestrator");
const { importNativeRuntimeHomes } = require("./native-runtime-home-import");
const { ensureNativeRuntimeImportBackup } = require("./native-runtime-import-migration");
const { PendingCommandInbox } = require("./pending-command-inbox");
const { TokenUsageStore } = require("./token-usage-store");
const { FederationHostClient } = require("./federation-host-client");
const { FederationCoordinator } = require("./federation-coordinator");
const {
  FederationMcpSessionManager,
  ensureFederationMcpCredential,
} = require("./federation-mcp-auth");
const {
  validateUsageBreakdown,
  validateUsageRange,
  validateUsageSeries,
} = require("./token-usage-protocol");
const { createWorkRunCoordinator } = require("./work-run-coordinator");
const { ProductMcpApprovalPolicy } = require("./product-mcp-approval-policy");
const { NativeKanbanStore } = require("./native-kanban-store");
const { KanbanRunService } = require("./kanban-run-service");
const { ensureAgentBoard, ensureDefaultAgentBoards } = require("./default-agent-boards");
const { NativeCronStore } = require("./native-cron-store");
const { NativeCronScheduler, describeCronRun } = require("./native-cron-scheduler");
const { DomainWorkRunExecutor } = require("./domain-work-run-executor");
const { NativeDomainServiceController } = require("./native-domain-service-controller");
const {
  DEFAULT_TOOL_REGISTRY,
  McpProductToolController,
  PUBLIC_MESSAGES: MCP_TOOL_PUBLIC_MESSAGES,
} = require("./mcp-product-tool-controller");
const {
  createChatServiceController,
  resolveProfileWorkspace,
} = require("./chat-service-controller");
const { createProfileServiceController } = require("./profile-service-controller");
const {
  createAgentLifecycleServiceController,
} = require("./agent-lifecycle-service-controller");
const { AgentHarnessServiceController } = require("./agent-harness-service-controller");
const { CodexSchemaContract } = require("./codex-schema-contract");
const {
  CHAT_SERVICE_METHODS,
  mapChatServiceError,
  validateChatServiceRequest,
  validateChatServiceResult,
} = require("./chat-service-protocol");
const {
  DOMAIN_SERVICE_METHODS,
  mapDomainServiceError,
  validateDomainServiceRequest,
  validateDomainServiceResult,
} = require("./domain-service-protocol");
const {
  PROFILE_SERVICE_METHODS,
  mapProfileServiceError,
  validateProfileServiceParams,
  validateProfileServiceResult,
} = require("./profile-service-protocol");
const {
  RUNTIME_ACCOUNT_SERVICE_METHODS,
  mapRuntimeAccountServiceError,
  validateRuntimeAccountServiceParams,
  validateRuntimeAccountServiceResult,
} = require("./runtime-account-service-protocol");
const {
  AGENT_LIFECYCLE_METHODS,
  mapAgentLifecycleError,
  validateAgentLifecycleParams,
  validateAgentLifecycleResult,
} = require("./agent-lifecycle-service-protocol");
const {
  AGENT_HARNESS_METHODS,
  mapAgentHarnessError,
  validateAgentHarnessParams,
  validateAgentHarnessResult,
} = require("./agent-harness-service-protocol");
const { assertRuntimeProfileId } = require("./codex-runtime-paths");
const {
  acquireInstanceLock,
  defaultProcessIdentity,
  writePrivateToken,
} = require("./instance-state");
const { acquirePrivateWriterLease } = require("./private-writer-lease");
const {
  ensurePrivateDirectoryTree,
  lstatIfExists,
  rejectSymlink,
  serviceError,
} = require("./security");
const { SERVICE_PROTOCOL_VERSION: PROTOCOL_VERSION } = require("./service-protocol-version");

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_SECRET_SCAN_BYTES = 64 * 1024;
const MAX_SUMMARY_SCAN_BYTES = 16 * 1024;
const MAX_STARTUP_ERROR_PROTOTYPE_DEPTH = 16;
const DEFAULT_MCP_AUTH_INIT_TIMEOUT_MS = 9_000;
const PERSISTENT_WRITER_LOCK_BASENAMES = Object.freeze([
  "chat-sessions.writer.lock",
  "inspirations.writer.lock",
  "native-cron.writer.lock",
  "native-kanban.writer.lock",
  "pending-commands.writer.lock",
]);
const CHAT_SERVICE_METHOD_SET = new Set(CHAT_SERVICE_METHODS);
const INSPIRATION_SERVICE_METHOD_SET = new Set(INSPIRATION_SERVICE_METHODS);
const DOMAIN_SERVICE_METHOD_SET = new Set(DOMAIN_SERVICE_METHODS);
const PROFILE_SERVICE_METHOD_SET = new Set(PROFILE_SERVICE_METHODS);
const RUNTIME_ACCOUNT_SERVICE_METHOD_SET = new Set(RUNTIME_ACCOUNT_SERVICE_METHODS);
const AGENT_LIFECYCLE_METHOD_SET = new Set(AGENT_LIFECYCLE_METHODS);
const AGENT_HARNESS_METHOD_SET = new Set(AGENT_HARNESS_METHODS);
const DOMAIN_RUNTIME_FATAL_REASON = "runtime_fatal";
const MCP_SERVICE_METHODS = new Set([
  "mcp.runtime.bridge.open", "mcp.runtime.gate.consume", "mcp.auth.challenge", "mcp.auth.exchange",
  "mcp.federation.open", "mcp.profile.get", "mcp.tool.call",
]);

function recoverStalePersistentWriterLeases(paths) {
  for (const lockBasename of PERSISTENT_WRITER_LOCK_BASENAMES) {
    const lease = acquirePrivateWriterLease({
      lockPath: path.join(paths.stateDir, lockBasename),
      trustedRoot: paths.trustedRoot,
    });
    lease.release();
  }
}
const MCP_PUBLIC_ERROR_CODES = new Set([
  "MCP_AUTH_BUSY",
  "MCP_AUTH_FAILED",
  "MCP_AUTH_REQUEST_INVALID",
  "MCP_SESSION_INVALID",
  ...Object.keys(MCP_TOOL_PUBLIC_MESSAGES),
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const AUTH_PUBLIC_ERROR_CODES = new Set([
  "AUTH_ACCOUNT_RESPONSE_INVALID",
  "AUTH_CANCEL_FAILED",
  "AUTH_LOGIN_CANCELED",
  "AUTH_LOGIN_IN_PROGRESS",
  "AUTH_LOGIN_NOT_ACTIVE",
  "AUTH_LOGIN_NOT_FOUND",
  "AUTH_LOGIN_TIMEOUT",
]);
const PROVIDER_PUBLIC_ERROR_CODES = new Set([
  "MODEL_PROVIDER_IN_USE",
  "PROVIDER_AGENT_VALIDATION_NOT_RUN",
  "PROVIDER_AGENT_VALIDATION_OPT_IN_REQUIRED",
  "PROVIDER_AUTH_HOST_INVALID",
  "PROVIDER_AUTH_RESPONSE_INVALID",
  "PROVIDER_BASE_URL_ENDPOINT_FORBIDDEN",
  "PROVIDER_BASE_URL_INVALID",
  "PROVIDER_BASE_URL_REQUIRED",
  "PROVIDER_COMMIT_UNCERTAIN",
  "PROVIDER_CREDENTIAL_REQUIRED",
  "PROVIDER_KIND_IMMUTABLE",
  "PROVIDER_CREDENTIAL_INVALID",
  "PROVIDER_MODEL_REQUIRED",
  "PROVIDER_NOT_FOUND",
  "PROVIDER_OPERATION_STALE",
  "PROVIDER_PRESET_INVALID",
  "PROVIDER_PRESET_OVERRIDE_FORBIDDEN",
  "PROVIDER_PROTOCOL_CONFIG_INVALID",
  "PROVIDER_PUBLIC_PRODUCT_URL_REQUIRED",
  "PROVIDER_RUNTIME_PROFILE_MISMATCH",
  "PROVIDER_SECRET_AUTHORITY_FORBIDDEN",
  "PROVIDER_SECRET_CAPACITY_EXCEEDED",
  "PROVIDER_SECRET_PARAMS_INVALID",
  "PROVIDER_SERVICE_CLOSING",
  "PROVIDER_VALIDATION_PARAMS_INVALID",
  "PROVIDER_VALIDATION_STALE",
]);

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function cloneMcpToolResult(value, state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > 16_384 || depth > 32) {
    throw serviceError("MCP_TOOL_RESPONSE_INVALID", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_INVALID);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!value.isWellFormed()) {
      throw serviceError("MCP_TOOL_RESPONSE_INVALID", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_INVALID);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw serviceError("MCP_TOOL_RESPONSE_INVALID", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_INVALID);
    }
    return value;
  }
  if (Array.isArray(value)) {
    let keys;
    let lengthDescriptor;
    try {
      keys = Reflect.ownKeys(value);
      lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    } catch {
      throw serviceError("MCP_TOOL_RESPONSE_INVALID", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_INVALID);
    }
    const length = lengthDescriptor && Object.prototype.hasOwnProperty.call(lengthDescriptor, "value")
      ? lengthDescriptor.value : -1;
    if (keys.some((key) => key !== "length"
      && !(typeof key === "string" && /^(?:0|[1-9][0-9]*)$/u.test(key)))
      || !Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) {
      throw serviceError("MCP_TOOL_RESPONSE_INVALID", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_INVALID);
    }
    const result = [];
    for (let index = 0; index < length; index += 1) {
      let descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); } catch {
        throw serviceError("MCP_TOOL_RESPONSE_INVALID", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_INVALID);
      }
      if (!descriptor || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        throw serviceError("MCP_TOOL_RESPONSE_INVALID", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_INVALID);
      }
      result.push(cloneMcpToolResult(descriptor.value, state, depth + 1));
    }
    return result;
  }
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw serviceError("MCP_TOOL_RESPONSE_INVALID", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_INVALID);
  }
  if (prototype !== Object.prototype
    || keys.some((key) => typeof key !== "string")) {
    throw serviceError("MCP_TOOL_RESPONSE_INVALID", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_INVALID);
  }
  const result = {};
  for (const key of keys) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch {
      throw serviceError("MCP_TOOL_RESPONSE_INVALID", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_INVALID);
    }
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")
      || descriptor.enumerable !== true) {
      throw serviceError("MCP_TOOL_RESPONSE_INVALID", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_INVALID);
    }
    Object.defineProperty(result, key, {
      value: cloneMcpToolResult(descriptor.value, state, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function probeDataProperty(target, property) {
  try {
    if ((typeof target !== "object" && typeof target !== "function") || target === null) {
      return { ok: true, found: false, value: undefined };
    }
    const seen = new Set();
    let cursor = target;
    for (let depth = 0; depth < MAX_STARTUP_ERROR_PROTOTYPE_DEPTH; depth += 1) {
      if (seen.has(cursor)) return { ok: false, found: false, value: undefined };
      seen.add(cursor);
      const descriptor = Object.getOwnPropertyDescriptor(cursor, property);
      if (descriptor) {
        if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          return { ok: false, found: true, value: undefined };
        }
        return { ok: true, found: true, value: descriptor.value };
      }
      cursor = Object.getPrototypeOf(cursor);
      if (cursor === null) return { ok: true, found: false, value: undefined };
    }
    return { ok: false, found: false, value: undefined };
  } catch {
    return { ok: false, found: false, value: undefined };
  }
}

function sanitizedDomainStartupHealthError(domain, error) {
  const upper = domain.toUpperCase();
  const label = domain === "kanban" ? "Kanban" : "Cron";
  const codeProbe = probeDataProperty(error, "code");
  if (codeProbe.ok && codeProbe.value === `${upper}_SENSITIVE_CHECK_FAILED`) return null;
  let code = `${upper}_UNAVAILABLE`;
  let message = `${label} Service 暂时不可用`;
  if (codeProbe.ok && codeProbe.value === `${upper}_COMMIT_UNCERTAIN`) {
    code = codeProbe.value;
    message = `${label} 持久化状态不确定，必须重启 Service`;
  } else if (codeProbe.ok && codeProbe.value === `${upper}_STORE_CORRUPT`) {
    code = codeProbe.value;
    message = `${label} 持久化存储损坏，必须重启 Service`;
  }
  return Object.freeze(serviceError(code, message));
}

function validRuntimeProfileId(value) {
  try { assertRuntimeProfileId(value); return true; } catch { return false; }
}

function authParamsValid(method, params) {
  if (method === "auth.read" || method === "auth.logout") {
    return exactObject(params, ["runtimeProfileId"])
      && validRuntimeProfileId(params.runtimeProfileId);
  }
  if (method === "auth.login.start") {
    return exactObject(params, ["runtimeProfileId", "mode"])
      && validRuntimeProfileId(params.runtimeProfileId)
      && (params.mode === "browser" || params.mode === "deviceCode");
  }
  if (method === "auth.login.cancel") {
    return exactObject(params, ["runtimeProfileId", "requestId"])
      && validRuntimeProfileId(params.runtimeProfileId)
      && typeof params.requestId === "string"
      && params.requestId.length > 0 && params.requestId.length <= 128
      && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(params.requestId);
  }
  return false;
}

function providerParamsValid(method, params) {
  if (method === "provider.list") return exactObject(params, []);
  if (method === "provider.save") {
    return exactObject(params, ["provider"])
      && params.provider && typeof params.provider === "object" && !Array.isArray(params.provider)
      && Object.getPrototypeOf(params.provider) === Object.prototype;
  }
  if (method === "provider.delete") {
    return exactObject(params, ["providerId"]) && validBoundedString(params.providerId, 128);
  }
  if (method === "provider.secret.set") {
    return (exactObject(params, ["providerId", "secret"])
      || exactObject(params, ["providerId", "runtimeProfileId", "secret"]))
      && validBoundedString(params.providerId, 128)
      && validBoundedString(params.secret, 64 * 1024)
      && (!Object.prototype.hasOwnProperty.call(params, "runtimeProfileId")
        || validRuntimeProfileId(params.runtimeProfileId));
  }
  if (method === "provider.secret.clear") {
    return (exactObject(params, ["providerId"])
      || exactObject(params, ["providerId", "runtimeProfileId"]))
      && validBoundedString(params.providerId, 128)
      && (!Object.prototype.hasOwnProperty.call(params, "runtimeProfileId")
        || validRuntimeProfileId(params.runtimeProfileId));
  }
  if (method === "provider.validate") {
    return (exactObject(params, ["providerId", "level"])
      || exactObject(params, ["providerId", "level", "allowPaidModelRequest"]))
      && validBoundedString(params.providerId, 128)
      && (params.level === "protocol" || params.level === "agent")
      && (!Object.prototype.hasOwnProperty.call(params, "allowPaidModelRequest")
        || typeof params.allowPaidModelRequest === "boolean");
  }
  return false;
}

function validatedProviderResult(method, result) {
  try {
    if (method === "provider.list") {
      if (!Array.isArray(result)) throw new Error("invalid provider list");
      return result.map((provider) => validateModelProvider(provider));
    }
    if (method === "provider.validate") {
      if (!exactObject(result, ["providerId", "validationStatus", "parsedBy"])
        || !validBoundedString(result.providerId, 128)
        || result.validationStatus !== "protocol_valid"
        || result.parsedBy !== "codex-0.149.0") throw new Error("invalid validation result");
      return { ...result };
    }
    if (method === "provider.delete" && result === null) return null;
    return validateModelProvider(result);
  } catch {
    throw serviceError("PROVIDER_RESPONSE_INVALID", "Provider operation response is invalid");
  }
}

function validBoundedString(value, maxBytes) {
  return typeof value === "string" && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes && value.isWellFormed();
}

function validAuthDisplayString(value, maxBytes) {
  return validBoundedString(value, maxBytes) && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validAuthUrl(value) {
  if (!validAuthDisplayString(value, 4096)) return false;
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  return (parsed.protocol === "http:" || parsed.protocol === "https:")
    && Boolean(parsed.hostname) && !parsed.username && !parsed.password;
}

function validateAuthResult(method, result) {
  if (method === "auth.read") {
    if (!exactObject(result, ["account", "requiresOpenaiAuth", "login",
      ...(result?.authSource === undefined ? [] : ["authSource"])])
      || (result.authSource !== undefined
        && (result.authSource !== "native-codex" || result.account?.type !== "chatgpt"))
      || typeof result.requiresOpenaiAuth !== "boolean") return false;
    if (result.account !== null) {
      if (!result.account || typeof result.account !== "object" || Array.isArray(result.account)) return false;
      if (result.account.type === "chatgpt") {
        if (!exactObject(result.account,
          result.account.planType === undefined ? ["type"] : ["type", "planType"])) return false;
        if (result.account.planType !== undefined && !validBoundedString(result.account.planType, 64)) return false;
      } else if (result.account.type === "apiKey") {
        if (!exactObject(result.account, ["type"])) return false;
      } else if (result.account.type === "amazonBedrock") {
        if (!exactObject(result.account, ["type", "usesCodexManagedCredentials"])
          || typeof result.account.usesCodexManagedCredentials !== "boolean") return false;
      } else return false;
    }
    if (result.login !== null) {
      if (!exactObject(result.login, ["requestId", "mode", "status", "updatedAt", "errorCode"])
        || !validBoundedString(result.login.requestId, 128)
        || !["browser", "deviceCode"].includes(result.login.mode)
        || !["starting", "waiting", "succeeded", "failed", "canceling", "canceled",
          "timed_out", "interrupted", "unknown"].includes(result.login.status)
        || !Number.isSafeInteger(result.login.updatedAt) || result.login.updatedAt < 0
        || (result.login.errorCode !== null
          && (!validBoundedString(result.login.errorCode, 64)
            || !/^[A-Z][A-Z0-9_]*$/u.test(result.login.errorCode)))) return false;
    }
    return true;
  }
  if (method === "auth.login.start") {
    if (!result || typeof result !== "object" || Array.isArray(result)
      || !validBoundedString(result.requestId, 128)
      || !["browser", "deviceCode"].includes(result.mode)
      || !["waiting", "succeeded", "failed"].includes(result.status)
      || !validBoundedString(result.loginId, 256)) return false;
    if (result.mode === "browser") {
      return exactObject(result, ["requestId", "mode", "status", "loginId", "authUrl"])
        && validAuthUrl(result.authUrl);
    }
    return exactObject(result, [
      "requestId", "mode", "status", "loginId", "verificationUrl", "userCode",
    ]) && validAuthUrl(result.verificationUrl)
      && validAuthDisplayString(result.userCode, 256);
  }
  if (method === "auth.login.cancel") {
    return exactObject(result, ["requestId", "status"])
      && validBoundedString(result.requestId, 128)
      && ["succeeded", "failed", "canceled", "timed_out", "interrupted", "unknown"]
        .includes(result.status);
  }
  return method === "auth.logout" && exactObject(result, ["loggedOut"])
    && result.loggedOut === true;
}

function tokensEqual(left, right) {
  const a = Buffer.from(typeof left === "string" ? left : "");
  const b = Buffer.from(typeof right === "string" ? right : "");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sanitizeMcpProfile(profile) {
  return {
    id: profile.id,
    agentId: profile.agentId,
    name: profile.name,
    runtimeProfileId: profile.runtimeProfileId,
    runtimeAccountId: profile.runtimeAccountId,
    defaultModel: profile.defaultModel,
    defaultCwd: profile.defaultCwd,
    permissionPolicy: profile.permissionPolicy,
    concurrency: profile.concurrency,
    isDefault: profile.isDefault,
    enabled: profile.enabled,
  };
}

function attachAcceptedSocketErrorGuard(socket, cleanup) {
  socket.on("error", () => {
    cleanup();
    socket.destroy();
  });
}

function stableJsonForSecretScan(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch {
    throw serviceError("RUN_EVENT_SECRET_REJECTED", "敏感信息检查输入不是稳定 JSON");
  }
  if (typeof serialized !== "string"
    || Buffer.byteLength(serialized, "utf8") > MAX_SECRET_SCAN_BYTES) {
    throw serviceError("RUN_EVENT_SECRET_REJECTED", "敏感信息检查输入超过上限");
  }
  let parsed;
  try { parsed = JSON.parse(serialized); } catch {
    throw serviceError("RUN_EVENT_SECRET_REJECTED", "敏感信息检查输入不是稳定 JSON");
  }
  if (JSON.stringify(parsed) !== serialized) {
    throw serviceError("RUN_EVENT_SECRET_REJECTED", "敏感信息检查输入不是稳定 JSON");
  }
  return { serialized, parsed };
}

function stableJsonContainsMatchedString(value, matches) {
  const stack = [value];
  let visited = 0;
  while (stack.length > 0) {
    visited += 1;
    if (visited > 8192) return true;
    const current = stack.pop();
    if (typeof current === "string") {
      if (matches(current)) return true;
    } else if (current && typeof current === "object") {
      for (const [key, child] of Object.entries(current)) {
        if (matches(key)) return true;
        stack.push(child);
      }
    }
  }
  return false;
}

function createAgentService(options) {
  const { paths } = options;
  const repoRoot = options.repoRoot || path.join(__dirname, "..", "..");
  const nativeRuntimeImportHome = options.nativeRuntimeImportHome ?? null;
  if (nativeRuntimeImportHome !== null && (typeof nativeRuntimeImportHome !== "string"
    || !path.isAbsolute(nativeRuntimeImportHome)
    || path.resolve(nativeRuntimeImportHome) !== nativeRuntimeImportHome
    || nativeRuntimeImportHome.includes("\0"))) {
    throw new TypeError("Native Runtime import home must be a canonical absolute path");
  }
  const nativeRuntimeImportEnabled = options.builtinCliProfiles === true
    && nativeRuntimeImportHome !== null;
  const serviceVersion = String(options.version || "0.0.0");
  const frameTimeoutMs = options.frameTimeoutMs ?? 2000;
  const mcpAuthInitTimeoutMs = options.mcpAuthInitTimeoutMs ?? DEFAULT_MCP_AUTH_INIT_TIMEOUT_MS;
  if (!Number.isSafeInteger(mcpAuthInitTimeoutMs) || mcpAuthInitTimeoutMs <= 0
    || mcpAuthInitTimeoutMs > 90_000) {
    throw serviceError("MCP_AUTH_TIMEOUT_INVALID", "mcp_auth_timeout_invalid");
  }
  const lockProbeTimeoutMs = options.lockProbeTimeoutMs ?? 750;
  const closeTimeoutMs = options.closeTimeoutMs ?? 1000;
  const getProcessIdentity = options.getProcessIdentity || defaultProcessIdentity;
  const cleanupFs = options.cleanupFs || fs;
  const cleanupLstatIfExists = cleanupFs.lstatIfExists || lstatIfExists;
  const instanceNonce = crypto.randomBytes(24).toString("hex");
  let server = null;
  let lockFd = null;
  let ownedLockIdentity = null;
  let ownedSocketIdentity = null;
  let ownedTokenIdentity = null;
  let token = null;
  let startedAt = null;
  let stopping = null;
  let startPromise = null;
  let lifecycleState = "stopped";
  let lifecycleGeneration = 0;
  let mcpTransportReady = false;
  const externalCryptoBroker = options.cryptoBroker || options.mcpCryptoBroker || null;
  const mcpAuthSecretStore = options.mcpAuthSecretStore || (externalCryptoBroker ? null
    : new McpAuthSecretStore({
      paths,
      access: "service",
      safeStorage: options.safeStorage,
      fs: options.mcpAuthFs,
    }));
  const mcpCryptoBroker = externalCryptoBroker || new InProcessMcpCryptoBroker({
    paths,
    safeStorage: options.safeStorage,
    fs: options.mcpAuthFs,
    store: mcpAuthSecretStore,
  });
  const secretStore = options.secretStore || new EncryptedSecretStore({
    paths,
    cryptoBroker: mcpCryptoBroker,
    fs: options.secretFs,
  });
  const productStore = options.productStore || new JsonlProductStore({ paths });
  const runtimeAccountLookup = (runtimeAccountId) => (
    productStore.getRuntimeAccount(runtimeAccountId)
  );
  let nativeSkillStore = null;
  let nativeRuntimeImportSummary = null;
  if (typeof secretStore.withPlaintextMatcher !== "function") {
    throw serviceError("SECRET_STORE_MATCHER_REQUIRED", "SecretStore 必须提供有界敏感值 matcher session");
  }
  if (typeof productStore.setSensitiveValueMatcherSessionFactory !== "function") {
    throw serviceError(
      "PRODUCT_STORE_SECRET_MATCHER_REQUIRED",
      "ProductStore 必须接受 Service 的敏感值 matcher",
    );
  }
  productStore.setSensitiveValueMatcherSessionFactory(
    (action) => secretStore.withPlaintextMatcher(action),
  );
  const federationMcpSessionManager = options.federationMcpSessionManager
    || new FederationMcpSessionManager({
      productStore,
      paths,
      defaultProfileId: DEFAULT_AGENT_PROFILE_ID,
      now: options.now,
      randomBytes: options.federationMcpRandomBytes,
      ttlMs: options.federationMcpSessionTtlMs,
      maxSessions: options.federationMcpMaxSessions,
    });
  const mcpHelperLaunch = options.mcpHelperLaunch || {
    command: process.execPath,
    argsPrefix: [],
  };
  const runtimeConfigWriter = options.runtimeConfigWriter || new CodexRuntimeConfigWriter({
    paths,
    fs: options.runtimeConfigFs,
    mcpHelperLaunch,
  });
  const providerRuntimeBridge = options.providerRuntimeBridge || new ProviderRuntimeBridge({
    productStore,
    secretStore,
    configWriter: runtimeConfigWriter,
    parentEnv: options.parentEnv,
  });
  const runtimePool = options.runtimePool || new CodexRuntimePool({
    paths,
    nativeAuth: new NativeCodexAuth({
      paths, repoRoot, packageVersion: serviceVersion,
      packaged: options.packaged, resourcesPath: options.resourcesPath,
      parentEnv: options.parentEnv, homedir: options.runtimeStorageHomedir,
    }),
    runtimeAccountLookup,
    parentEnv: options.parentEnv,
    homedir: options.runtimeStorageHomedir,
    hostOptions: {
      repoRoot,
      packageVersion: serviceVersion,
      packaged: options.packaged,
      resourcesPath: options.resourcesPath,
      prepareRuntime: async (runtimeInput) => {
        const prepare = options.prepareRuntime
          || providerRuntimeBridge.prepareRuntime.bind(providerRuntimeBridge);
        return prepare(runtimeInput);
      },
    },
  });
  const runtimeMcpGateIssuer = options.runtimeMcpGateIssuer || new RuntimeMcpGateIssuer({
    paths,
    mcpHelperLaunch,
    now: options.now,
  });
  const codexRuntimeAdapter = options.codexRuntimeAdapter
    || new CodexRuntimeAdapter({ runtimePool });
  const grokBuildRuntimePool = options.grokBuildRuntimePool || new GrokBuildRuntimePool({
    paths,
    runtimeAccountLookup,
    binaryPath: options.grokBuildBinaryPath,
    resolveProxy: options.grokBuildResolveProxy,
    parentEnv: options.parentEnv,
    homedir: options.runtimeStorageHomedir,
    packageVersion: serviceVersion,
    createMcpServer: (input) => runtimeMcpGateIssuer.createMcpServer(input),
    now: options.now,
    randomUUID: options.randomUUID,
  });
  const grokBuildRuntimeAdapter = options.grokBuildRuntimeAdapter
    || new GrokBuildRuntimeAdapter({ runtimePool: grokBuildRuntimePool });
  const antigravityRuntimePool = options.antigravityRuntimePool || new AntigravityRuntimePool({
    paths,
    runtimeAccountLookup,
    binaryPath: options.antigravityBinaryPath,
    parentEnv: options.parentEnv,
    homedir: options.runtimeStorageHomedir,
    mcpGateIssuer: runtimeMcpGateIssuer,
    now: options.now,
    randomUUID: options.randomUUID,
  });
  const antigravityRuntimeAdapter = options.antigravityRuntimeAdapter
    || new AntigravityRuntimeAdapter({ runtimePool: antigravityRuntimePool });
  const piResourcesPath = options.resourcesPath || process.resourcesPath;
  const piExtensionPath = options.piExtensionPath || (options.packaged && piResourcesPath
    ? path.join(piResourcesPath, "pi", "shoggoth-pi-extension.mjs")
    : path.join(repoRoot, "resources", "pi", "shoggoth-pi-extension.mjs"));
  const piRuntimePool = options.piRuntimePool || new PiRuntimePool({
    paths,
    runtimeAccountLookup,
    binaryPath: options.piBinaryPath,
    extensionPath: piExtensionPath,
    parentEnv: options.parentEnv,
    homedir: options.runtimeStorageHomedir,
    mcpGateIssuer: runtimeMcpGateIssuer,
    now: options.now,
    randomUUID: options.randomUUID,
  });
  const piRuntimeAdapter = options.piRuntimeAdapter
    || new PiRuntimeAdapter({ runtimePool: piRuntimePool });
  const claudeCodeRuntimePool = options.claudeCodeRuntimePool || new ClaudeCodeRuntimePool({
    paths,
    runtimeAccountLookup,
    binaryPath: options.claudeCodeBinaryPath,
    parentEnv: options.parentEnv,
    homedir: options.runtimeStorageHomedir,
    mcpGateIssuer: runtimeMcpGateIssuer,
    sdk: options.claudeCodeSdk,
    now: options.now,
    randomUUID: options.randomUUID,
  });
  const claudeCodeRuntimeAdapter = options.claudeCodeRuntimeAdapter
    || new ClaudeCodeRuntimeAdapter({ runtimePool: claudeCodeRuntimePool });
  const deepSeekHarnessResourcesPath = options.resourcesPath || process.resourcesPath;
  const deepSeekHarnessBridgePath = options.deepSeekHarnessBridgePath
    || (options.packaged && deepSeekHarnessResourcesPath
      ? path.join(deepSeekHarnessResourcesPath, "deepseek-harness", "shoggoth-dsh-bridge.mjs")
      : path.join(repoRoot, "resources", "deepseek-harness", "shoggoth-dsh-bridge.mjs"));
  const deepSeekHarnessRuntimePool = options.deepSeekHarnessRuntimePool
    || new DeepSeekHarnessRuntimePool({
      paths,
      runtimeAccountLookup,
      binaryPath: options.deepSeekHarnessBinaryPath,
      bridgePath: deepSeekHarnessBridgePath,
      parentEnv: options.parentEnv,
      homedir: options.runtimeStorageHomedir,
      mcpGateIssuer: runtimeMcpGateIssuer,
      now: options.now,
      randomUUID: options.randomUUID,
    });
  const deepSeekHarnessRuntimeAdapter = options.deepSeekHarnessRuntimeAdapter
    || new DeepSeekHarnessRuntimeAdapter({ runtimePool: deepSeekHarnessRuntimePool });
  const runtimeManager = options.runtimeManager || (() => {
    const registry = new RuntimeAdapterRegistry();
    registry.register("codex", codexRuntimeAdapter);
    registry.register("grok-build", grokBuildRuntimeAdapter);
    registry.register("antigravity", antigravityRuntimeAdapter);
    registry.register("pi", piRuntimeAdapter);
    if (require("../runtime-availability").isRuntimeAvailable("claude-code")) {
      registry.register("claude-code", claudeCodeRuntimeAdapter);
    }
    registry.register("deepseek-harness", deepSeekHarnessRuntimeAdapter);
    return registry;
  })();
  const providerService = options.providerService || new ProviderService({
    productStore,
    secretStore,
    // Provider CRUD is a Codex-specific compatibility surface. Agent execution
    // routes through the generic registry below.
    runtimePool: codexRuntimeAdapter,
    publicProductUrl: options.publicProductUrl,
    repoRoot,
    packaged: options.packaged,
    resourcesPath: options.resourcesPath,
  });
  const runtimeAccountAdmission = options.runtimeAccountAdmission || new RuntimeAccountAdmission({
    runtimeAccountLookup,
    now: options.now,
  });
  const resolveProfileAuthBinding = (runtimeProfileId) => {
    const matches = productStore.listAgentProfiles()
      .filter((profile) => profile.runtimeProfileId === runtimeProfileId);
    if (matches.length !== 1) {
      throw serviceError("AUTH_PROFILE_BINDING_INVALID", "Account auth Profile binding is invalid");
    }
    const [profile] = matches;
    return {
      runtime: profile.runtime,
      runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId,
    };
  };
  const resolveRuntimeAccountBinding = (runtimeAccountId) => {
    const account = productStore.getRuntimeAccount(runtimeAccountId);
    if (!account) {
      throw serviceError("AUTH_ACCOUNT_BINDING_INVALID", "Account auth RuntimeAccount is invalid");
    }
    const profiles = productStore.listAgentProfiles()
      .filter((profile) => profile.runtimeAccountId === runtimeAccountId)
      .sort((left, right) => Number(right.enabled) - Number(left.enabled)
        || Number(right.isDefault) - Number(left.isDefault)
        || left.id.localeCompare(right.id));
    if (profiles.length === 0 || profiles[0].runtime !== account.runtime) {
      throw serviceError("AUTH_ACCOUNT_BINDING_INVALID", "Account auth RuntimeAccount is unused");
    }
    return {
      runtime: account.runtime,
      runtimeProfileId: profiles[0].runtimeProfileId,
      runtimeAccountId,
    };
  };
  const accountAuthStateStore = options.accountAuthStateStore || new AccountAuthStateStore({
    paths,
    fs: options.accountAuthFs,
    now: options.now,
    resolveRuntimeAccountId(runtimeProfileId) {
      return resolveProfileAuthBinding(runtimeProfileId).runtimeAccountId;
    },
  });
  const invalidateRuntimeAccount = async ({ runtimeAccountId, binding }) => {
    const profiles = productStore.listAgentProfiles()
      .filter((profile) => profile.runtimeAccountId === runtimeAccountId)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (profiles.length === 0 || profiles.some((profile) => profile.runtime !== binding.runtime)) {
      throw serviceError(
        "AUTH_RUNTIME_INVALIDATION_FAILED",
        "Account auth RuntimeAccount references are invalid",
      );
    }
    const failures = [];
    for (const profile of profiles) {
      try {
        await runtimeManager.stop({
          runtime: profile.runtime,
          runtimeProfileId: profile.runtimeProfileId,
          runtimeAccountId: profile.runtimeAccountId,
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      const aggregate = new AggregateError(failures, "Account auth RuntimeAccount invalidation failed");
      aggregate.code = "AUTH_RUNTIME_INVALIDATION_FAILED";
      throw aggregate;
    }
  };
  const accountAuthManager = options.accountAuthManager || new AccountAuthManager({
    stateStore: accountAuthStateStore,
    runtimeManager,
    runtimeAccountAdmission,
    resolveProfileAuthBinding,
    resolveRuntimeAccountBinding,
    invalidateRuntimeAccount,
    now: options.now,
    randomUUID: options.randomUUID,
    loginTimeoutMs: options.accountLoginTimeoutMs,
    onEvent: (event) => eventBuffer.append(event.type, event),
  });
  const runtimeAccountStoreMethods = [
    "listRuntimeAccounts", "getRuntimeAccount", "listAgentProfiles",
  ];
  const runtimeAccountStoreAvailable = runtimeAccountStoreMethods.every(
    (method) => typeof productStore[method] === "function",
  );
  const runtimeAccountAuthAvailable = ["read", "loginStart", "loginCancel", "logout"]
    .every((method) => typeof accountAuthManager[method] === "function");
  const runtimeStoragePathsAvailable = [
    "stateDir", "trustedRoot", "runtimeAccountsDir", "legacyRuntimeHomesDir",
    "legacyRuntimeHomesPath", "runtimeCleanupAuditPath", "backupsDir", "backupCleanupAuditPath",
  ].every((field) => typeof paths[field] === "string");
  if (options.runtimeStorageInUse !== undefined
    && typeof options.runtimeStorageInUse !== "function") {
    throw serviceError(
      "RUNTIME_ACCOUNT_SERVICE_OPTIONS_INVALID",
      "Runtime storage in-use resolver is invalid",
    );
  }
  if (options.runtimeBackupInUse !== undefined
    && typeof options.runtimeBackupInUse !== "function") {
    throw serviceError(
      "RUNTIME_ACCOUNT_SERVICE_OPTIONS_INVALID",
      "Runtime backup in-use resolver is invalid",
    );
  }
  const runtimePoolByName = new Map([
    ["codex", runtimePool],
    ["grok-build", grokBuildRuntimePool],
    ["antigravity", antigravityRuntimePool],
    ["pi", piRuntimePool],
    ["claude-code", claudeCodeRuntimePool],
    ["deepseek-harness", deepSeekHarnessRuntimePool],
  ]);
  const readRuntimeCleanupState = options.readRuntimeCleanupState
    || options.readRuntimeBackupCleanupState
    || (() => {
      const migration = runtimeAccountMigrationOrchestrator.status();
      return Object.freeze({
        serviceReady: lifecycleState === "started",
        cleanupEligible: migration.active === false || migration.stage === "cleanup_eligible",
      });
    });
  if (typeof readRuntimeCleanupState !== "function") {
    throw serviceError(
      "RUNTIME_ACCOUNT_SERVICE_OPTIONS_INVALID",
      "Runtime cleanup state resolver is invalid",
    );
  }
  const legacyRuntimeHomeStore = options.legacyRuntimeHomeStore
    || (runtimeStoragePathsAvailable ? new LegacyRuntimeHomeStore({
      paths,
      now: options.now,
      scanLimits: options.runtimeStorageScanLimits,
      parentEnv: options.parentEnv,
      homedir: options.runtimeStorageHomedir,
    }) : null);
  const runtimeStorageInventory = () => legacyRuntimeHomeStore.refresh({
    accounts: productStore.listRuntimeAccounts(),
    profiles: productStore.listAgentProfiles(),
  });
  const runtimeStorageCleanup = options.runtimeStorageCleanup
    || (legacyRuntimeHomeStore && runtimeAccountStoreAvailable
      ? new RuntimeStorageCleanup({
        paths,
        inventory: runtimeStorageInventory,
        readCleanupState: readRuntimeCleanupState,
        isInUse: async (entry) => {
          const persistentReferences = typeof runtimeAccountMigrationOrchestrator
            .legacyHomePersistentReferences === "function"
            ? runtimeAccountMigrationOrchestrator.legacyHomePersistentReferences(entry, {
              productStore,
              chatSessionStore,
              ownershipStore: runtimeSessionOwnershipStore,
            })
            : ["legacy-session-lineage-unavailable"];
          if (persistentReferences.length > 0) {
            return { reasons: persistentReferences };
          }
          const admission = runtimeAccountAdmission.read(entry.runtimeAccountId);
          const pool = runtimePoolByName.get(entry.runtime);
          const activeHost = pool?.entries instanceof Map
            && [...pool.entries.values()].some(
              (candidate) => candidate?.runtimeAccountId === entry.runtimeAccountId,
            );
          const inUse = {
            activeRun: admission.active > 0,
            activeHost,
            activeLogin: admission.mutationActive,
          };
          if (inUse.activeRun || inUse.activeHost || inUse.activeLogin) return inUse;
          return options.runtimeStorageInUse
            ? options.runtimeStorageInUse(entry) : false;
        },
        now: options.now,
        randomBytes: options.runtimeStorageRandomBytes,
        fs: options.runtimeStorageFs,
        scanLimits: options.runtimeStorageScanLimits,
        planTtlMs: options.runtimeStorageCleanupPlanTtlMs,
      }) : null);
  const runtimeBackupStore = options.runtimeBackupStore
    || (runtimeStoragePathsAvailable ? new RuntimeBackupStore({
      paths,
      fs: options.runtimeStorageFs,
      now: options.now,
      scanLimits: options.runtimeStorageScanLimits,
      maxDirectories: options.runtimeBackupInventoryMaxDirectories,
      maxDurationMs: options.runtimeBackupInventoryMaxDurationMs,
      stagingStaleMs: options.runtimeBackupStagingStaleMs,
    }) : null);
  const runtimeBackupInventory = () => runtimeBackupStore.refresh();
  const runtimeBackupCleanup = options.runtimeBackupCleanup
    || (runtimeBackupStore ? new RuntimeBackupCleanup({
      paths,
      inventory: runtimeBackupInventory,
      readCleanupState: readRuntimeCleanupState,
      isInUse: options.runtimeBackupInUse || (async () => false),
      now: options.now,
      randomBytes: options.runtimeBackupRandomBytes,
      fs: options.runtimeStorageFs,
      scanLimits: options.runtimeStorageScanLimits,
      planTtlMs: options.runtimeBackupCleanupPlanTtlMs,
    }) : null);
  const unavailableRuntimeAccountServiceController = Object.freeze({
    open() {},
    close() {},
    handle() {
      throw serviceError(
        "RUNTIME_ACCOUNT_SERVICE_CLOSED",
        "RuntimeAccount Service is unavailable",
      );
    },
  });
  const runtimeAccountServiceController = options.runtimeAccountServiceController
    || (runtimeAccountStoreAvailable && runtimeAccountAuthAvailable
      && legacyRuntimeHomeStore && runtimeStorageCleanup && runtimeBackupStore && runtimeBackupCleanup
      ? createRuntimeAccountServiceController({
        productStore,
        runtimeAccountAdmission,
        accountAuthManager,
        legacyRuntimeHomeStore,
        runtimeStorageCleanup,
        runtimeBackupStore,
        runtimeBackupCleanup,
        paths,
        fs: options.runtimeStorageFs,
        parentEnv: options.parentEnv,
        homedir: options.runtimeStorageHomedir,
        scanLimits: options.runtimeStorageScanLimits,
        now: options.now,
        inventoryCacheMs: options.runtimeStorageInventoryCacheMs,
        readAccountStorage: options.readAccountStorage,
      }) : unavailableRuntimeAccountServiceController);
  const profileStoreMethods = [
    "getAgentProfile", "getModelProvider", "putAgentProfile", "getRuntimeAccount",
    "listAgentProfiles", "lookupMcpToolCall", "beginMcpToolCall", "completeMcpToolCall",
  ];
  const profileStoreAvailable = profileStoreMethods.every(
    (method) => typeof productStore[method] === "function",
  );
  const unavailableProfileServiceController = Object.freeze({
    open() {},
    close() {},
    handle() {
      throw serviceError("PROFILE_SERVICE_CLOSED", "Profile configuration is unavailable");
    },
  });
  const profileServiceController = options.profileServiceController
    || (profileStoreAvailable ? createProfileServiceController({
      productStore,
      runtimeManager: {
        acquire(binding, acquireOptions) {
          if (typeof runtimeManager.acquire === "function") {
            return runtimeManager.acquire(binding, acquireOptions);
          }
          if (typeof runtimeManager.get !== "function") {
            throw serviceError("PROFILE_SERVICE_CLOSED", "RuntimePool lookup is unavailable");
          }
          return runtimeManager.get(binding.runtimeProfileId);
        },
        stop(binding) {
          if (typeof runtimeManager.stop !== "function") {
            throw serviceError("PROFILE_SERVICE_CLOSED", "RuntimePool targeted stop is unavailable");
          }
          return runtimeManager.stop(binding);
        },
      },
      accountAuthManager: {
        read(params) {
          if (typeof accountAuthManager.read !== "function") {
            throw serviceError("PROFILE_SERVICE_CLOSED", "Account authority is unavailable");
          }
          return accountAuthManager.read(params);
        },
      },
      providerBootstrap: providerService.profileBootstrapCapability || {
        configureOpenAiApiKey() {
          throw serviceError("PROFILE_SERVICE_CLOSED", "Provider bootstrap is unavailable");
        },
        clearUnreferencedOpenAiApiKey() {
          throw serviceError("PROFILE_SERVICE_CLOSED", "Provider bootstrap is unavailable");
        },
      },
      now: options.now,
    }) : unavailableProfileServiceController);
  const chatSessionStore = options.chatSessionStore || new ChatSessionStore({
    paths,
    fs: options.chatSessionFs,
    now: options.now,
    randomUUID: options.randomUUID,
  });
  const agentDefinitionStore = options.agentDefinitionStore || new AgentDefinitionStore({
    paths,
    fs: options.agentDefinitionFs,
    now: options.now,
    randomUUID: options.randomUUID,
  });
  const pendingCommandInbox = options.pendingCommandInbox || new PendingCommandInbox({
    paths,
    fs: options.pendingCommandFs,
    cryptoBroker: mcpCryptoBroker,
    now: options.now,
    decryptStartupBudgetMs: options.pendingCommandDecryptStartupBudgetMs,
    onUnlocked: () => handlePendingCommandInboxUnlocked(),
  });
  const workDispatcher = options.workDispatcher || createWorkDispatcher({
    store: productStore,
    now: options.now || productStore.now,
  });
  const runtimeSessionOwnershipStore = options.runtimeSessionOwnershipStore
    || new RuntimeSessionOwnershipStore({
      paths,
      fs: options.runtimeSessionOwnershipFs,
      now: options.now,
    });
  const runtimeAccountMigrationOrchestrator = options.runtimeAccountMigrationOrchestrator
    || new RuntimeAccountMigrationOrchestrator({
      paths,
      fs: options.runtimeAccountMigrationFs,
      now: options.now,
    });
  const isSensitiveValue = options.isSensitiveValue || ((value) => (
    secretStore.withPlaintextMatcher((matches) => matches(value))
  ));
  const tokenUsageStore = options.tokenUsageStore || new TokenUsageStore({
    paths,
    fs: options.tokenUsageFs,
    now: options.now,
    isSensitiveValue,
  });
  const federationHostClient = options.federationHostClient || new FederationHostClient({ paths });
  const nativeKanbanStore = options.nativeKanbanStore || new NativeKanbanStore({
    paths,
    fs: options.nativeKanbanFs,
    now: options.now,
    randomUUID: options.randomUUID,
    profileExists: (profileId) => productStore.getAgentProfile(profileId) !== null,
    getRun: (runId) => workDispatcher.getRun(runId),
    isSensitiveValue,
  });
  const nativeCronStore = options.nativeCronStore || new NativeCronStore({
    paths,
    fs: options.nativeCronFs,
    now: options.now,
    randomUUID: options.randomUUID,
    profileExists: (profileId) => productStore.getAgentProfile(profileId) !== null,
    isSensitiveValue,
  });
  const assertSecretSafe = options.assertSecretSafe || ((value) => {
    const stable = stableJsonForSecretScan(value);
    const safe = secretStore.withPlaintextMatcher((matches) => (
      !matches(stable.serialized) && !stableJsonContainsMatchedString(stable.parsed, matches)
    ));
    if (safe !== true) {
      throw serviceError("RUN_EVENT_SECRET_REJECTED", "Run event 含敏感信息");
    }
    return true;
  });
  const sanitizeSummary = options.sanitizeSummary || ((value) => {
    if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0")
      || Buffer.byteLength(value, "utf8") > MAX_SUMMARY_SCAN_BYTES) return null;
    try {
      return secretStore.withPlaintextMatcher((matches) => (matches(value) ? null : value));
    } catch {
      return null;
    }
  });
  const inspirationStore = options.inspirationStore || new InspirationStore({
    paths, now: options.now, randomUUID: options.randomUUID, assertSecretSafe,
  });
  const transcriptStore = options.transcriptStore || new TranscriptStore({
    paths,
    fs: options.transcriptFs,
    now: options.now,
    assertSecretSafe,
  });
  const memoryStore = options.memoryStore || new MemoryStore({
    paths,
    fs: options.memoryFs,
  });
  const memoryEngine = options.memoryEngine || new MemoryEngine({
    store: memoryStore,
    definitionStore: agentDefinitionStore,
    now: options.now,
    randomUUID: options.randomUUID,
  });
  const toolRegistry = options.toolRegistry || DEFAULT_TOOL_REGISTRY;
  const permissionEngine = options.permissionEngine || new PermissionEngine({
    toolRegistry,
    paths,
  });
  const productMcpApprovalPolicy = options.productMcpApprovalPolicy
    || new ProductMcpApprovalPolicy({ toolRegistry, permissionEngine, productStore });
  const serviceResourcesPath = options.resourcesPath || process.resourcesPath;
  const builtinSkillRoot = path.resolve(options.skillBuiltinRoot || (
    options.packaged && serviceResourcesPath
      ? path.join(serviceResourcesPath, "shoggoth-skills")
      : path.join(repoRoot, "resources", "shoggoth-skills")
  ));
  nativeSkillStore = options.nativeSkillStore || new NativeSkillStore({
    paths,
    builtinRoot: builtinSkillRoot,
    profileExists: (profileId) => productStore.getAgentProfile(profileId) !== null,
    now: options.now,
  });
  const systemHostController = options.systemHostController || (options.systemHostAdapter
    ? new SystemHostController({
      host: options.systemHostAdapter,
      platform: options.platform,
      homeDirectory: options.homeDirectory,
      applicationRoots: options.applicationRoots,
      folderRoots: options.folderRoots,
      allowedUrlProtocols: options.allowedUrlProtocols,
      readPlist: options.readApplicationPlist,
      fs: options.systemHostFs,
    })
    : null);
  const computerUseController = options.computerUseController || (options.computerDriverPath
    ? new ComputerUseController({
      paths,
      binaryPath: options.computerDriverPath,
      binaryManifest: options.computerDriverManifest,
      hostBundleId: options.computerHostBundleId,
      sdkLoader: options.computerSdkLoader,
      permissionStatus: options.computerPermissionStatus,
      getSystemIdleTime: options.computerGetSystemIdleTime,
      isScreenLocked: options.computerIsScreenLocked,
      imageTransformer: options.computerImageTransformer,
      now: options.now,
      randomUUID: options.randomUUID,
      maxSessions: options.computerMaxSessions,
      verifyBinary: options.computerVerifyBinary,
    })
    : null);
  const contextSnapshotStore = options.contextSnapshotStore || new ContextSnapshotStore({
    paths,
    fs: options.contextSnapshotFs,
  });
  const contextCompiler = options.contextCompiler || new ContextCompiler({
    definitionStore: agentDefinitionStore,
    memoryEngine,
    memoryStore,
    transcriptStore,
    toolRegistry,
    permissionEngine,
    skillStore: nativeSkillStore,
    runtimeCapabilitiesForProfile: (profile) => {
      if (profile.runtime === "codex" || profile.runtime === undefined) {
        return ["mcp", "filesystem", "shell"];
      }
      return ["grok-build", "antigravity", "pi", "claude-code", "deepseek-harness"]
        .includes(profile.runtime)
        ? ["mcp", "filesystem", "shell"] : [];
    },
    snapshotStore: contextSnapshotStore,
    now: options.now,
    budgets: options.contextBudgets,
  });
  const harnessDependencies = [
    [productStore, ["getAgentProfile"]],
    [agentDefinitionStore, ["get", "history", "readRevision", "update", "restore", "previewImport", "import", "readGeneratedView"]],
    [memoryStore, ["getRevision", "list"]],
    [memoryEngine, ["confirm", "update", "delete"]],
    [chatSessionStore, ["listSessions"]],
    [transcriptStore, ["listEvents", "getRevision", "setContextExcluded"]],
    [toolRegistry, ["list"]],
    [permissionEngine, ["profileProjection", "setProfileOverride"]],
    [nativeSkillStore, ["list", "setProfileSkill", "installFromDirectory", "uninstall", "preview", "usage"]],
  ];
  const agentHarnessServiceController = options.agentHarnessServiceController
    || (harnessDependencies.every(([value, methods]) => value
      && methods.every((method) => typeof value[method] === "function"))
      ? new AgentHarnessServiceController({
        productStore,
        definitionStore: agentDefinitionStore,
        memoryStore,
        memoryEngine,
        chatSessionStore,
        transcriptStore,
        toolRegistry,
        permissionEngine,
        skillStore: nativeSkillStore,
        computerUseController,
        now: options.now,
      })
      : Object.freeze({
        handle() { throw serviceError("HARNESS_SERVICE_CLOSED", "Agent management is unavailable"); },
      }));
  if (!agentHarnessServiceController || typeof agentHarnessServiceController.handle !== "function") {
    throw new TypeError("Agent Harness Service Controller 必须提供 handle");
  }
  const lifecycleDependencies = [
    [productStore, [
      "listAgentProfiles", "getAgentProfile", "putAgentProfile", "listWorkRuns",
      "listMcpToolCalls", "lookupMcpToolCall", "beginMcpToolCall", "completeMcpToolCall",
    ]],
    [agentDefinitionStore, ["ensureProfile", "writeGeneratedView"]],
    [memoryStore, ["ensureProfile"]],
    [memoryEngine, ["rebuildViews"]],
    [nativeSkillStore, ["ensureProfile"]],
  ];
  const unavailableAgentLifecycleServiceController = Object.freeze({
    open() {},
    close() {},
    handle() { throw serviceError("AGENT_SERVICE_CLOSED", "Agent lifecycle is unavailable"); },
  });
  const agentLifecycleServiceController = options.agentLifecycleServiceController
    || (lifecycleDependencies.every(([value, methods]) => value
      && methods.every((method) => typeof value[method] === "function"))
      ? createAgentLifecycleServiceController({
        productStore,
        runtimeManager: {
          stop(binding) {
            if (typeof runtimeManager.stop !== "function") {
              throw serviceError("AGENT_SERVICE_CLOSED", "Runtime targeted stop is unavailable");
            }
            return runtimeManager.stop(binding);
          },
        },
        async initializeProfile(profile) {
          nativeSkillStore.ensureProfile(profile.id);
          agentDefinitionStore.ensureProfile({ profileId: profile.id });
          if (typeof toolRegistry.toolsMarkdown === "function"
            && typeof toolRegistry.revision === "string") {
            agentDefinitionStore.writeGeneratedView({
              profileId: profile.id,
              kind: "TOOLS",
              revision: toolRegistry.revision,
              content: toolRegistry.toolsMarkdown(),
            });
          }
          memoryStore.ensureProfile(profile.id);
          memoryEngine.rebuildViews(profile.id);
        },
        async activateProfile(profile) {
          if (nativeKanbanStoreOpened && domainAvailability.kanban.available) {
            ensureAgentBoard(productStore, nativeKanbanStore, profile.id, { includeDisabled: true });
          }
        },
        now: options.now,
      })
      : unavailableAgentLifecycleServiceController);
  if (!agentLifecycleServiceController
    || ["open", "close", "handle"].some((method) => (
      typeof agentLifecycleServiceController[method] !== "function"
    ))) {
    throw new TypeError("Agent Lifecycle Service Controller 必须提供 open/close/handle");
  }
  const queueMemoryExtraction = (event, run) => {
    if (event?.kind !== "user" || run?.source !== "chat") return;
    setImmediate(() => {
      try { memoryEngine.extractTranscript({ profileId: run.profileId, events: [event] }); } catch {}
    });
  };
  const queueMemoryConsolidation = (run, payload) => {
    if (run?.source !== "chat" || payload?.status !== "completed") return;
    setImmediate(() => {
      try {
        const session = chatSessionStore.getSession(run.sourceId);
        if (!session) return;
        const events = transcriptStore.listEvents(run.profileId, session.id)
          .filter((event) => event.runId === run.id);
        memoryEngine.extractTranscript({ profileId: run.profileId, events });
        memoryEngine.consolidate(run.profileId);
      } catch {}
    });
  };
  const isNativeFederationChatRun = (run) => run?.source === "chat"
    && typeof run.idempotencyKey === "string"
    && /^shoggoth:chat-send:federation-(?:send|message)-/u.test(run.idempotencyKey);
  const synchronizedSessionKey = (run) => run?.source === "inspiration"
    ? inspirationStore.executionForRun(run.id)?.sessionKey ?? null
    : run?.source === "cron" ? workRunCoordinator.getRunSessionKey(run)
    : isNativeFederationChatRun(run) ? run.sourceId : null;
  const handleRunInteraction = (run, interaction) => {
    if (run?.source === "inspiration") inspirationService.onInteraction(run, interaction);
    const sessionKey = synchronizedSessionKey(run);
    if (!sessionKey) return;
    try {
      eventBuffer.append("federation.chat.interaction", {
        runId: run.id,
        profileId: run.profileId,
        sessionKey,
        interaction,
      });
    } catch (error) {
      if (error?.code === "EVENT_TOO_LARGE" && interaction?.phase === "requested"
        && interaction.eventType === "approval") {
        try {
          eventBuffer.append("federation.chat.interaction", {
            runId: run.id,
            profileId: run.profileId,
            sessionKey,
            interaction: {
              phase: "requested",
              eventType: "approval",
              requestId: interaction.requestId,
              payload: {
                requestId: interaction.requestId,
                method: "redacted",
                kind: "permissions",
                reason: "审批详情无法安全完整显示，只能拒绝或取消",
                sessionApprovalAvailable: false,
                expiresAt: Number.isSafeInteger(interaction.payload?.expiresAt)
                  ? interaction.payload.expiresAt : null,
                redacted: true,
              },
            },
          });
        } catch {
          // Even the bounded deny-only fallback is observer-only and must fail open.
        }
      }
      // UI 同步是旁路通知；持久化的交互请求不能被观察端故障反向改写。
    }
  };
  const publishFederationTerminal = (run, payload) => {
    const sessionKey = synchronizedSessionKey(run);
    if (!sessionKey) return;
    try {
      eventBuffer.append("federation.chat.terminal", {
        runId: run.id,
        profileId: run.profileId,
        sessionKey,
        status: payload?.status,
        result: payload?.resultSummary ?? null,
        errorCode: payload?.errorCode ?? null,
        finishedAt: run.finishedAt ?? (options.now || Date.now)(),
      });
    } catch {
      // UI 同步是旁路通知；持久化终态的 WorkRun 不能被观察端故障反向改写。
    }
  };
  const handleRunTerminal = (run, payload) => {
    queueMemoryConsolidation(run, payload);
    publishFederationTerminal(run, payload);
    if (run?.source === "inspiration") inspirationService.onRunTerminal(run);
    setImmediate(() => {
      if (!computerUseController || typeof computerUseController.closeForWorkRun !== "function") return;
      try { Promise.resolve(computerUseController.closeForWorkRun(run.profileId, run.id)).catch(() => {}); } catch {}
    });
  };
  const createDefaultWorkRunCoordinator = () => createWorkRunCoordinator({
    dispatcher: workDispatcher,
    productStore,
    usageStore: tokenUsageStore,
    chatSessionStore,
    getMediaStore: () => inspirationStore.media,
    transcriptStore,
    contextCompiler,
    resolveRunSession: (run) => inspirationStore.executionForRun(run.id),
    productMcpApprovalPolicy,
    onTranscriptCommitted: queueMemoryExtraction,
    onRunInteraction: handleRunInteraction,
    onRunTerminal: handleRunTerminal,
    inbox: pendingCommandInbox,
    runtimeManager,
    runtimeAccountAdmission,
    runtimeSessionOwnershipStore,
    now: options.now,
    randomUUID: options.randomUUID,
    assertSecretSafe,
    sanitizeSummary,
    // 默认 DomainWorkRunExecutor 的 execution contract 只存在于当前 lifecycle；
    // 自定义 executor 保留自己的 crash recovery ownership，不由 Coordinator 抢占。
    recoverOrphanedDomainRuns: options.domainWorkRunExecutor === undefined,
  });
  const codexSchemaContract = options.codexSchemaContract || new CodexSchemaContract({
    repoRoot: options.repoRoot || path.join(__dirname, "..", ".."),
  });
  const createDefaultChatServiceController = (coordinator) => createChatServiceController({
    paths,
    productStore,
    chatSessionStore,
    transcriptStore,
    coordinator,
    getInspirationService: () => inspirationService,
    getCronJobName: (jobId) => nativeCronStore.getJob(jobId)?.name,
    runtimePool: runtimeManager,
    runtimeSessionOwnershipStore,
    schemaContract: codexSchemaContract,
    cursorSecret: options.chatCursorSecret || crypto.randomBytes(32),
    now: options.now,
    randomUUID: options.randomUUID,
    listProfileModels: (params) => profileServiceController.handle("profile.models.list", params),
  });
  let workRunCoordinator = options.workRunCoordinator || createDefaultWorkRunCoordinator();
  let chatServiceController = options.chatServiceController
    || createDefaultChatServiceController(workRunCoordinator);
  const federationCoordinator = options.federationCoordinator || new FederationCoordinator({
    productStore,
    federationClient: federationHostClient,
    getChatServiceController: () => chatServiceController,
    getWorkRunCoordinator: () => workRunCoordinator,
    handleSecret: options.federationHandleSecret,
    getHandleSecret: options.federationHandleSecret ? undefined : () => crypto.createHash("sha256")
      .update("shoggoth-federation-task-handle-v1\0")
      .update(ensureFederationMcpCredential(paths).token)
      .digest(),
    now: options.now,
    randomUUID: options.randomUUID,
  });
  const domainWorkRunExecutor = options.domainWorkRunExecutor || new DomainWorkRunExecutor({
    getCoordinator: () => workRunCoordinator,
  });
  const inspirationService = new InspirationService({
    store: inspirationStore, productStore, chatSessionStore, transcriptStore, paths,
    dispatcher: workDispatcher, getCoordinator: () => workRunCoordinator,
    executor: domainWorkRunExecutor, now: options.now,
    externalExecutor: new ExternalInspirationExecutor({ store: inspirationStore,
      client: federationHostClient, sanitizeSummary, now: options.now,
      prompt: execution => inspirationService.buildPrompt(execution, true) }),
  });
  const kanbanRunService = options.kanbanRunService || new KanbanRunService({
    dispatcher: workDispatcher,
    kanbanStore: nativeKanbanStore,
    executor: domainWorkRunExecutor,
    resolveTargetState(profileId) {
      const profile = productStore.getAgentProfile(profileId);
      if (!profile) {
        throw serviceError("KANBAN_RUN_CORRUPT", "Kanban Card 绑定的 AgentProfile 不存在");
      }
      return profile.enabled && require("../runtime-availability").isRuntimeAvailable(profile.runtime)
        ? "enabled" : "disabled";
    },
    resolveWorkspace(profileId, requested) {
      const profile = productStore.getAgentProfile(profileId);
      if (!profile) {
        throw serviceError("KANBAN_RUN_CORRUPT", "Kanban Card 绑定的 AgentProfile 不存在");
      }
      return resolveProfileWorkspace({
        paths,
        profile,
        requested,
        errorCode: "KANBAN_RUN_CORRUPT",
      });
    },
    now: options.now,
    randomUUID: options.randomUUID,
    onFatalError: (error) => reportDomainFatal("kanban", error),
  });
  const nativeCronScheduler = options.nativeCronScheduler || new NativeCronScheduler({
    cronStore: nativeCronStore,
    dispatcher: workDispatcher,
    executor: domainWorkRunExecutor,
    now: options.now,
    monotonicNow: options.monotonicNow,
    setTimer: options.setCronTimer,
    clearTimer: options.clearCronTimer,
    randomUUID: options.randomUUID,
    resolveTargetState(profileId) {
      const profile = productStore.getAgentProfile(profileId);
      if (!profile) {
        throw serviceError("CRON_RUN_CORRUPT", "Cron Job 绑定的 AgentProfile 不存在");
      }
      return profile.enabled && require("../runtime-availability").isRuntimeAvailable(profile.runtime)
        ? "enabled" : "disabled";
    },
    resolveWorkspace(profileId, requested) {
      const profile = productStore.getAgentProfile(profileId);
      if (!profile) {
        throw serviceError("CRON_RUN_CORRUPT", "Cron Job 绑定的 AgentProfile 不存在");
      }
      return resolveProfileWorkspace({
        paths,
        profile,
        requested,
        errorCode: "CRON_RUN_CORRUPT",
      });
    },
    onFatalError: (error) => reportDomainFatal("cron", error),
  });
  let defaultCoordinatorRetired = false;
  let defaultControllerRetired = false;
  let defaultDomainControllerRetired = false;
  let defaultMcpProductToolControllerRetired = false;
  let mcpSessionManager = null;
  let mcpAuthInitAttempt = null;
  let mcpAuthFailureGeneration = null;
  let storeOpened = false;
  let tokenUsageStoreOpened = false;
  let secretStoreOpened = false;
  let mcpCryptoBrokerOpened = false;
  let runtimeMcpGateIssuerOpened = false;
  let providerRuntimeOpened = false;
  let providerServiceOpened = false;
  let accountAuthStateOpened = false;
  let accountAuthManagerOpened = false;
  let runtimeAccountMigrationOrchestratorOpened = false;
  let runtimeSessionOwnershipStoreOpened = false;
  let runtimeAccountServiceControllerOpened = false;
  let profileServiceControllerOpened = false;
  let agentLifecycleServiceControllerOpened = false;
  let chatSessionStoreOpened = false;
  let inspirationStoreOpened = false;
  let agentDefinitionStoreOpened = false;
  let transcriptStoreOpened = false;
  let memoryStoreOpened = false;
  let memoryEngineOpened = false;
  let permissionEngineOpened = false;
  let nativeSkillStoreOpened = false;
  let computerUseControllerOpened = false;
  let contextSnapshotStoreOpened = false;
  let pendingCommandInboxOpened = false;
  let chatServiceControllerOpened = false;
  let workRunCoordinatorOpened = false;
  let workRunCoordinatorReady = false;
  let pendingInboxRecoveryNeeded = false;
  let pendingInboxRecovery = null;
  let nativeKanbanStoreOpened = false;
  let kanbanRunServiceOpened = false;
  let nativeCronStoreOpened = false;
  let nativeCronSchedulerOpened = false;
  const domainAvailability = {
    kanban: { available: true, reason: null },
    cron: { available: true, reason: null },
  };
  const createDefaultNativeDomainServiceController = () => {
    const ownerToken = Object.freeze({});
    const controller = new NativeDomainServiceController({
      kanbanStore: nativeKanbanStore,
      kanbanRunService,
      cronStore: nativeCronStore,
      cronScheduler: nativeCronScheduler,
      workDispatcher,
      usageStore: tokenUsageStore,
      federationClient: federationHostClient,
      getServiceStatus: async () => ({
        healthy: lifecycleState === "started",
        serviceVersion,
        startedAt,
        domainAvailability: domainAvailabilitySnapshot(),
        pendingCommandsLocked: typeof pendingCommandInbox.isLocked === "function"
          ? pendingCommandInbox.isLocked() : true,
        mcpCredentialsLocked: mcpSessionManager === null,
      }),
      getDomainAvailability: domainAvailabilitySnapshot,
      onFatalDomainError: (domain, error) => reportDomainFatal(domain, error, ownerToken),
      describeCronRun,
      getRunSessionKey: (run) => workRunCoordinator.getRunSessionKey?.(run) ?? null,
      cursorSecret: options.domainCursorSecret || crypto.randomBytes(32),
      now: options.now,
      randomUUID: options.randomUUID,
    });
    return { controller, ownerToken };
  };
  const initialDomainController = options.nativeDomainServiceController
    ? null : createDefaultNativeDomainServiceController();
  let nativeDomainServiceController = options.nativeDomainServiceController
    || initialDomainController.controller;
  let nativeDomainServiceControllerOwnerToken = initialDomainController?.ownerToken || null;
  let activeDomainControllerOwnerToken = null;
  if (!nativeDomainServiceController
    || typeof nativeDomainServiceController.handle !== "function") {
    throw new TypeError("Native Domain Service Controller 必须提供 handle");
  }
  const createDefaultMcpProductToolController = () => {
    const ownerToken = Object.freeze({});
    const requiredDependencies = [
      [productStore, ["getAgentProfile", "addRunNote", "lookupMcpToolCall",
        "beginMcpToolCall", "completeMcpToolCall"]],
      [nativeDomainServiceController, ["handle"]],
      [nativeKanbanStore, ["getBoard", "getCard", "listCardRunLinks",
        "getCardRunLinkByRunId", "addComment", "addArtifact", "listArtifacts"]],
      [kanbanRunService, ["requestCompletionFromAgent"]],
      [nativeCronStore, ["getJob"]],
      [workDispatcher, ["getRun"]],
      [workRunCoordinator, ["getRuntimeContextForSource", "getRuntimeContextForLegacyRun"]],
      [tokenUsageStore, ["summarize"]],
      [federationHostClient, ["request"]],
      [federationCoordinator, ["list", "get", "run", "message", "taskGet", "cancel"]],
    ];
    // 旧有生命周期/故障注入测试会显式替换某个 domain dependency 的最小表面。
    // 该组合不能被 Product 工具误当成可用；固定 unavailable stub 让普通 Service
    // 仍可验证自身域，同时 MCP 调用严格 fail closed。正式默认依赖始终走完整 Controller。
    if (requiredDependencies.some(([value, methods]) => (
      !value || methods.some((method) => typeof value[method] !== "function")
    ))) {
      return {
        controller: Object.freeze({
          async handle() {
            throw serviceError(
              "MCP_TOOL_UNAVAILABLE", MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_UNAVAILABLE,
            );
          },
        }),
        ownerToken,
      };
    }
    const controller = new McpProductToolController({
      productStore,
      domainController: nativeDomainServiceController,
      kanbanStore: nativeKanbanStore,
      kanbanRunService,
      cronStore: nativeCronStore,
      workDispatcher,
      getRuntimeContext: (profileId, selector) => selector.runId === undefined
        ? workRunCoordinator.getRuntimeContextForSource(
          profileId, selector.source, selector.sourceId,
        )
        : workRunCoordinator.getRuntimeContextForLegacyRun(profileId, selector.runId),
      usageStore: tokenUsageStore,
      federationClient: federationHostClient,
      federationCoordinator,
      skillStore: nativeSkillStore,
      inspirationService,
      systemHostController,
      computerUseController,
      getServiceStatus: async () => ({
        healthy: lifecycleState === "started",
        serviceVersion,
        startedAt,
        domainAvailability: domainAvailabilitySnapshot(),
        pendingCommandsLocked: typeof pendingCommandInbox.isLocked === "function"
          ? pendingCommandInbox.isLocked() : true,
        mcpCredentialsLocked: mcpSessionManager === null,
      }),
      notificationSender: options.notificationSender || (async () => {
        throw serviceError("NOTIFICATION_FAILED", MCP_TOOL_PUBLIC_MESSAGES.NOTIFICATION_FAILED);
      }),
      isSensitiveValue,
      onFatalError: (error) => reportMcpProductFatal(error, ownerToken),
      artifactRoot: options.artifactRoot || path.join(paths.stateDir, "artifacts"),
      toolRegistry,
      permissionEngine,
      fs: options.artifactFs,
      now: options.now,
      randomUUID: options.randomUUID,
    });
    return { controller, ownerToken };
  };
  const initialMcpProductToolController = options.mcpProductToolController
    ? null : createDefaultMcpProductToolController();
  let mcpProductToolController = options.mcpProductToolController
    || initialMcpProductToolController.controller;
  let mcpProductToolControllerOwnerToken = initialMcpProductToolController?.ownerToken || null;
  let activeMcpProductToolControllerOwnerToken = null;
  if (!mcpProductToolController || typeof mcpProductToolController.handle !== "function") {
    throw new TypeError("MCP Product Tool Controller 必须提供 handle");
  }
  const domainFatalReports = { kanban: null, cron: null };
  let mcpProductFatalReport = null;
  let startupFatal = null;
  const eventBuffer = options.eventBuffer || createEventBuffer(MAX_FRAME_BYTES);
  const sockets = new Set();
  const inFlightSockets = new Set();
  const bridgeSockets = new Map();

  function mcpAuthGenerationIsActive(generation) {
    return lifecycleGeneration === generation
      && (lifecycleState === "started"
        || (lifecycleState === "starting" && mcpTransportReady))
      && mcpCryptoBrokerOpened;
  }

  async function closeUnpublishedMcpManager(manager) {
    if (!manager || typeof manager.close !== "function") return;
    try { await manager.close(); } catch { /* 未发布对象只做 best-effort 销毁 */ }
  }

  function ensureMcpSessionManager() {
    if (mcpSessionManager) return mcpSessionManager;
    const generation = lifecycleGeneration;
    if (!mcpAuthGenerationIsActive(generation)) {
      throw serviceError("SERVICE_UNAVAILABLE", "mcp_auth_unavailable");
    }
    // 一次 Keychain/safeStorage 失败后，本代保持 MCP locked。否则每个新的
    // challenge 都会再启动一次 Electron crypto worker，反复弹系统钥匙串窗口。
    // 用户解锁后通过重启 Service 进入新 generation，再允许一次受控重试。
    if (mcpAuthFailureGeneration === generation) {
      throw serviceError("SERVICE_UNAVAILABLE", "mcp_auth_unavailable");
    }
    if (mcpAuthInitAttempt?.generation === generation) return mcpAuthInitAttempt.result;

    // safeStorage 属于 MCP 的可选凭据边界：放到请求期 singleflight，避免 Service
    // start/socket 健康依赖系统密钥库。Promise 形态也让测试与可替换实现具备超时边界。
    let resultSettled = false;
    let secretConsumed = false;
    const loadPromise = Promise.resolve().then(() => {
      if (!mcpAuthGenerationIsActive(generation)) {
        throw serviceError("SERVICE_UNAVAILABLE", "mcp_auth_unavailable");
      }
      return mcpCryptoBroker.loadOrCreateForService({ generation });
    });
    const guardedLoad = loadPromise.then((secret) => {
      // 超时/stop 后底层调用仍可能迟到；它不得发布 manager，明文也必须立即清零。
      if (resultSettled && !secretConsumed && Buffer.isBuffer(secret)) secret.fill(0);
      return secret;
    });
    let timeout = null;
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        reject(serviceError("SERVICE_UNAVAILABLE", "mcp_auth_unavailable"));
      }, mcpAuthInitTimeoutMs);
    });
    const result = Promise.race([guardedLoad, deadline]).then(async (handshakeSecret) => {
      secretConsumed = true;
      let manager = null;
      try {
        if (!Buffer.isBuffer(handshakeSecret) || handshakeSecret.length !== 32
          || !mcpAuthGenerationIsActive(generation)) {
          throw serviceError("SERVICE_UNAVAILABLE", "mcp_auth_unavailable");
        }
        const factory = options.mcpSessionManagerFactory || ((managerOptions) => (
          new McpSessionManager(managerOptions)
        ));
        manager = factory({
          handshakeSecret,
          profileStore: productStore,
          protocolVersion: PROTOCOL_VERSION,
          now: options.now,
          randomBytes: options.mcpRandomBytes,
          challengeTtlMs: options.mcpChallengeTtlMs,
          sessionTtlMs: options.mcpSessionTtlMs,
          maxChallenges: options.mcpMaxChallenges,
          maxSessions: options.mcpMaxSessions,
        });
        if (!manager || typeof manager.issueChallenge !== "function"
          || typeof manager.exchangeChallenge !== "function"
          || typeof manager.issueBridgeSession !== "function"
          || typeof manager.authorizeSession !== "function"
          || typeof manager.revokeSession !== "function"
          || typeof manager.close !== "function") {
          throw serviceError("MCP_SESSION_MANAGER_INVALID", "mcp_session_manager_invalid");
        }
        if (!mcpAuthGenerationIsActive(generation)) {
          await closeUnpublishedMcpManager(manager);
          manager = null;
          throw serviceError("SERVICE_UNAVAILABLE", "mcp_auth_unavailable");
        }
        mcpSessionManager = manager;
        return manager;
      } catch (error) {
        if (manager && manager !== mcpSessionManager) await closeUnpublishedMcpManager(manager);
        throw error;
      } finally {
        if (Buffer.isBuffer(handshakeSecret)) handshakeSecret.fill(0);
      }
    }).catch((error) => {
      if (lifecycleGeneration === generation) mcpAuthFailureGeneration = generation;
      throw error;
    }).finally(() => {
      resultSettled = true;
      if (timeout) clearTimeout(timeout);
    });
    const attempt = { generation, result };
    mcpAuthInitAttempt = attempt;
    void Promise.allSettled([loadPromise, result]).then(() => {
      if (mcpAuthInitAttempt === attempt) mcpAuthInitAttempt = null;
    });
    return result;
  }

  function writeResponse(socket, payload, close = true) {
    if (socket.destroyed) return;
    let frame = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
      const safeId = jsonlBytes(payload?.id) <= 256 ? payload?.id ?? null : null;
      frame = `${JSON.stringify({
        id: safeId,
        ok: false,
        error: { code: "RESPONSE_TOO_LARGE", message: "响应超过本地协议上限" },
      })}\n`;
      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
    }
    socket.write(frame, (error) => {
      if (error) {
        socket.destroy();
        return;
      }
      if (close && !socket.destroyed) socket.end();
    });
  }

  function errorResponse(socket, id, code, message, close = true) {
    writeResponse(socket, { id: id ?? null, ok: false, error: { code, message } }, close);
  }

  function handleInternalError(socket, request) {
    const rawId = request && typeof request === "object" ? request.id : null;
    const safeId = (typeof rawId === "string" && Buffer.byteLength(rawId) <= 256)
      || (typeof rawId === "number" && Number.isFinite(rawId))
      ? rawId
      : null;
    try {
      // 内部异常只返回固定文案，既不泄漏 stack/message，也不让 rejection 逃到进程级。
      errorResponse(socket, safeId, "INTERNAL_ERROR", "Service 内部请求处理失败", true);
    } catch {
      socket.destroy();
    }
  }

  function domainAvailabilitySnapshot() {
    return Object.freeze({
      kanban: Object.freeze({ ...domainAvailability.kanban }),
      cron: Object.freeze({ ...domainAvailability.cron }),
    });
  }

  function latchStartupFatal(generation, error) {
    if (!startupFatal || startupFatal.generation !== generation) {
      startupFatal = { generation, error };
    }
    return startupFatal.error;
  }

  function reportDomainFatal(domain, error, controllerOwnerToken = null) {
    if (controllerOwnerToken !== null
      && controllerOwnerToken !== activeDomainControllerOwnerToken) return Promise.resolve();
    if ((domain !== "kanban" && domain !== "cron")
      || (lifecycleState !== "starting" && lifecycleState !== "started")) {
      return Promise.resolve();
    }
    domainAvailability[domain] = {
      available: false,
      reason: DOMAIN_RUNTIME_FATAL_REASON,
    };
    // startup 本身已有保留主错的 cleanup 边界；只有已发布的 generation 才走
    // runtime reporter，避免 open 失败与 stop 重入互相覆盖。
    const generation = lifecycleGeneration;
    if (lifecycleState !== "started") {
      latchStartupFatal(generation, error);
      return Promise.resolve();
    }
    if (domainFatalReports[domain]?.generation === generation) {
      return domainFatalReports[domain].promise;
    }
    // Controller fatal 可能由当前 IPC 请求触发；让本轮 JSONL 公共错误先完成 flush，
    // 下一轮再关闭对应领域的 scheduler/service/store，避免本轮正确的
    // commit-uncertain 被生命周期清理覆盖。核心 IPC、聊天与另一领域保持在线。
    const promise = new Promise((resolve) => setImmediate(resolve))
      .then(async () => {
        if (lifecycleState !== "started" || lifecycleGeneration !== generation) return;
        const cleanupError = await quarantineNativeDomain(domain);
        if (lifecycleState !== "started" || lifecycleGeneration !== generation) return;
        try {
          if (typeof options.onDomainRuntimeError === "function") {
            await options.onDomainRuntimeError(domain, error, cleanupError);
          } else {
            console.error(`[agent-service] ${domain} domain isolated: DOMAIN_RUNTIME_FATAL`);
          }
        } catch {
          console.error("[agent-service] domain runtime failure reporter failed");
        }
      });
    domainFatalReports[domain] = { generation, promise };
    void promise.catch(() => {});
    return promise;
  }

  async function quarantineNativeDomain(domain) {
    const errors = [];
    if (domain === "cron") {
      if (nativeCronSchedulerOpened) {
        nativeCronSchedulerOpened = false;
        try { await nativeCronScheduler.close(); } catch (error) { errors.push(error); }
      }
      if (nativeCronStoreOpened) {
        nativeCronStoreOpened = false;
        try { await nativeCronStore.close(); } catch (error) { errors.push(error); }
      }
    } else {
      if (kanbanRunServiceOpened) {
        kanbanRunServiceOpened = false;
        try { await kanbanRunService.close(); } catch (error) { errors.push(error); }
      }
      if (nativeKanbanStoreOpened) {
        nativeKanbanStoreOpened = false;
        try { await nativeKanbanStore.close(); } catch (error) { errors.push(error); }
      }
    }
    if (errors.length === 0) return null;
    const cleanupError = new AggregateError(errors, "Native domain isolation cleanup failed");
    cleanupError.code = "DOMAIN_ISOLATION_CLEANUP_FAILED";
    return cleanupError;
  }

  function reportMcpProductFatal(error, controllerOwnerToken = null) {
    if (controllerOwnerToken !== null
      && controllerOwnerToken !== activeMcpProductToolControllerOwnerToken) {
      return Promise.resolve();
    }
    if (lifecycleState === "starting") {
      latchStartupFatal(lifecycleGeneration, error);
      return Promise.resolve();
    }
    if (lifecycleState !== "started") return Promise.resolve();
    const generation = lifecycleGeneration;
    if (mcpProductFatalReport?.generation === generation) {
      return mcpProductFatalReport.promise;
    }
    // Product Controller fatal 仅由本轮 MCP IPC 触发；下一轮再停止 Service，保证
    // commit-uncertain 的固定公开错误先完成 socket flush。
    const promise = new Promise((resolve) => setImmediate(resolve))
      .then(() => {
        if (lifecycleState !== "started" || lifecycleGeneration !== generation) return;
        return reportRuntimeServerError(error);
      });
    mcpProductFatalReport = { generation, promise };
    void promise.catch(() => {});
    return promise;
  }

  async function reportRuntimeServerError(error) {
    let cleanupError = null;
    try {
      await api.stop({ notify: false });
    } catch (failure) {
      cleanupError = failure;
    }
    try {
      if (typeof options.onRuntimeError === "function") {
        await options.onRuntimeError(error, cleanupError);
      } else {
        // Runtime errors can originate from EventEmitter boundaries. Never read
        // attacker-controlled accessors or forward a raw code/message to logs.
        console.error("[agent-service] runtime server failure: SERVER_ERROR");
      }
    } catch {
      console.error("[agent-service] runtime failure reporter failed");
    }
  }

  async function recoverUnlockedPendingCommands(generation) {
    if (lifecycleGeneration !== generation || !workRunCoordinatorReady
      || !["starting", "started"].includes(lifecycleState)) return;
    if (pendingInboxRecovery?.generation === generation) return pendingInboxRecovery.promise;
    pendingInboxRecoveryNeeded = false;
    const promise = (async () => {
      const recoveries = await workRunCoordinator.recover();
      const outcomes = await Promise.allSettled(recoveries);
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      if (failure) throw failure.reason;
    })();
    const record = { generation, promise };
    pendingInboxRecovery = record;
    try {
      await promise;
    } finally {
      if (pendingInboxRecovery === record) pendingInboxRecovery = null;
    }
  }

  function handlePendingCommandInboxUnlocked() {
    const generation = lifecycleGeneration;
    if (!["starting", "started"].includes(lifecycleState)) return;
    pendingInboxRecoveryNeeded = true;
    if (!workRunCoordinatorReady || lifecycleState === "starting") return;
    void recoverUnlockedPendingCommands(generation).catch((error) => (
      reportRuntimeServerError(error)
    ));
  }

  async function reportStopFailure(error) {
    try {
      if (typeof options.onStopError === "function") await options.onStopError(error);
      else console.error(`[agent-service] stop failure: ${error?.code || "SERVICE_STOP_FAILED"}`);
    } catch {
      console.error("[agent-service] stop failure reporter failed");
    }
  }

  function handleMcpError(socket, id, error) {
    const codeProbe = probeDataProperty(error, "code");
    const rawCode = codeProbe.ok && codeProbe.found && typeof codeProbe.value === "string"
      ? codeProbe.value : "";
    if (["credentials_locked", "MCP_AUTH_NOT_INITIALIZED", "MCP_CRYPTO_UNAVAILABLE", "SERVICE_UNAVAILABLE"]
      .includes(rawCode)) {
      errorResponse(socket, id, "SERVICE_UNAVAILABLE", "mcp_auth_unavailable");
      return;
    }
    const code = MCP_PUBLIC_ERROR_CODES.has(rawCode) ? rawCode : "MCP_AUTH_FAILED";
    const messages = {
      MCP_AUTH_BUSY: "mcp_auth_busy",
      MCP_AUTH_FAILED: "mcp_auth_failed",
      MCP_AUTH_REQUEST_INVALID: "mcp_auth_request_invalid",
      MCP_SESSION_INVALID: "mcp_session_invalid",
      ...MCP_TOOL_PUBLIC_MESSAGES,
    };
    errorResponse(socket, id, code, messages[code] || "mcp_auth_failed");
  }

  async function executeAuthorizedMcpRequest(method, params) {
    const toolCall = method === "mcp.tool.call";
    const expectedFields = toolCall
      ? ["runtimeProfileId", "runtimeAccountId", "sessionToken", "callId", "name", "arguments",
        ...(Object.hasOwn(params, "confirmation") ? ["confirmation"] : [])]
      : ["runtimeProfileId", "runtimeAccountId", "sessionToken"];
    if (!exactObject(params, expectedFields)
      || !validRuntimeProfileId(params.runtimeProfileId)
      || !validRuntimeAccountId(params.runtimeAccountId)
      || (toolCall && (!UUID_PATTERN.test(params.callId)
        || !validBoundedString(params.name, 64)
        || !params.arguments
        || typeof params.arguments !== "object"
        || Array.isArray(params.arguments)
        || Object.getPrototypeOf(params.arguments) !== Object.prototype
        || (Object.hasOwn(params, "confirmation") && params.confirmation !== true)))) {
      if (toolCall) throw serviceError("MCP_AUTH_REQUEST_INVALID", "mcp_auth_request_invalid");
      throw serviceError("MCP_SESSION_INVALID", "mcp_session_invalid");
    }
    let authorized = federationMcpSessionManager.authorize({
      runtimeProfileId: params.runtimeProfileId,
      runtimeAccountId: params.runtimeAccountId,
      token: params.sessionToken,
    });
    if (!authorized) {
      const manager = await ensureMcpSessionManager();
      authorized = manager.authorizeSession({
        runtimeProfileId: params.runtimeProfileId,
        runtimeAccountId: params.runtimeAccountId,
        token: params.sessionToken,
      });
    }
    const profile = productStore.getAgentProfile(authorized.profileId);
    if (!profile || profile.enabled !== true
      || profile.runtimeProfileId !== authorized.runtimeProfileId
      || profile.runtimeAccountId !== authorized.runtimeAccountId) {
      throw serviceError("MCP_SESSION_INVALID", "mcp_session_invalid");
    }
    if (!toolCall) return sanitizeMcpProfile(profile);
    const result = cloneMcpToolResult(await mcpProductToolController.handle(
      params.name,
      params.arguments,
      Object.freeze({
        profileId: authorized.profileId,
        callId: params.callId,
        ...(params.confirmation === true ? { confirmation: true } : {}),
        ...(authorized.federationClient
          ? { federationClient: authorized.federationClient } : {}),
      }),
    ));
    const worstFrame = `${JSON.stringify({
      id: "\0".repeat(256), ok: true, result,
    })}\n`;
    if (Buffer.byteLength(worstFrame, "utf8") > MAX_FRAME_BYTES) {
      throw serviceError(
        "MCP_TOOL_RESPONSE_TOO_LARGE",
        MCP_TOOL_PUBLIC_MESSAGES.MCP_TOOL_RESPONSE_TOO_LARGE,
      );
    }
    return result;
  }

  async function handleMcpRequest(socket, request) {
    const id = request.id;
    if (!exactObject(request, ["id", "version", "method", "params"])) {
      errorResponse(socket, id, "MCP_AUTH_REQUEST_INVALID", "mcp_auth_request_invalid");
      return;
    }
    let result;
    try {
      if (request.method === "mcp.runtime.gate.consume") {
        if (!exactObject(request.params, [
          "runtimeProfileId", "runtimeAccountId", "gatePath", "nonce", "parentPid",
        ])) {
          throw serviceError("MCP_AUTH_REQUEST_INVALID", "mcp_auth_request_invalid");
        }
        const profiles = productStore.listAgentProfiles().filter((profile) => (
          profile.enabled === true
          && profile.runtimeProfileId === request.params.runtimeProfileId
          && profile.runtimeAccountId === request.params.runtimeAccountId
        ));
        if (profiles.length !== 1) {
          throw serviceError("MCP_AUTH_FAILED", "mcp_auth_failed");
        }
        result = runtimeMcpGateIssuer.consume(request.params);
      } else if (request.method === "mcp.federation.open") {
        if (!exactObject(request.params,
          ["runtimeProfileId", "runtimeAccountId", "credentialToken", "client"])) {
          throw serviceError("MCP_AUTH_REQUEST_INVALID", "mcp_auth_request_invalid");
        }
        result = federationMcpSessionManager.issue(request.params);
      } else if (request.method === "mcp.auth.challenge") {
        const manager = await ensureMcpSessionManager();
        result = manager.issueChallenge(request.params);
      } else if (request.method === "mcp.auth.exchange") {
        const manager = await ensureMcpSessionManager();
        result = manager.exchangeChallenge(request.params);
      } else {
        result = await executeAuthorizedMcpRequest(request.method, request.params);
      }
    } catch (error) {
      handleMcpError(socket, id, error);
      return;
    }
    writeResponse(socket, { id, ok: true, result });
  }

  function writeMcpBridgeAck(socket) {
    const frame = `${JSON.stringify({ ok: true, result: { bridged: true } })}\n`;
    return new Promise((resolve, reject) => {
      if (socket.destroyed) {
        reject(serviceError("MCP_AUTH_FAILED", "mcp_auth_failed"));
        return;
      }
      try {
        socket.write(frame, (error) => {
          if (error || socket.destroyed) {
            reject(serviceError("MCP_AUTH_FAILED", "mcp_auth_failed"));
          } else {
            resolve();
          }
        });
      } catch {
        reject(serviceError("MCP_AUTH_FAILED", "mcp_auth_failed"));
      }
    });
  }

  async function openMcpRuntimeBridge(socket, request) {
    if (!exactObject(request, ["version", "method", "params"])
      || request.version !== PROTOCOL_VERSION
      || request.method !== "mcp.runtime.bridge.open"
      || !exactObject(request.params, [
        "runtimeProfileId", "runtimeAccountId", "gatePath", "nonce", "parentPid",
      ])
      || !validRuntimeProfileId(request.params.runtimeProfileId)
      || !validRuntimeAccountId(request.params.runtimeAccountId)) {
      throw serviceError("MCP_AUTH_REQUEST_INVALID", "mcp_auth_request_invalid");
    }
    if (!(lifecycleState === "started"
      || (lifecycleState === "starting" && mcpTransportReady))) {
      throw serviceError("SERVICE_UNAVAILABLE", "mcp_auth_unavailable");
    }

    const generation = lifecycleGeneration;
    const runtimeProfileId = request.params.runtimeProfileId;
    const runtimeAccountId = request.params.runtimeAccountId;
    const boundProfiles = productStore.listAgentProfiles().filter((profile) => (
      profile.enabled === true
      && profile.runtimeProfileId === runtimeProfileId
      && profile.runtimeAccountId === runtimeAccountId
    ));
    if (boundProfiles.length !== 1) {
      throw serviceError("MCP_AUTH_FAILED", "mcp_auth_failed");
    }
    await runtimeMcpGateIssuer.consume(request.params);
    const manager = await ensureMcpSessionManager();
    if (!mcpAuthGenerationIsActive(generation) || manager !== mcpSessionManager) {
      throw serviceError("SERVICE_UNAVAILABLE", "mcp_auth_unavailable");
    }

    let activeToken = null;
    let handler = null;
    let closed = false;
    const revokeActiveSession = () => {
      const tokenToRevoke = activeToken;
      activeToken = null;
      if (!tokenToRevoke) return;
      try {
        manager.revokeSession({ runtimeProfileId, runtimeAccountId, token: tokenToRevoke });
      } catch { /* manager close/revoke is best-effort during socket teardown */ }
    };
    const closeBridge = () => {
      if (closed) return;
      closed = true;
      bridgeSockets.delete(socket);
      if (handler?.close) handler.close();
      revokeActiveSession();
    };

    try {
      const session = manager.issueBridgeSession({ runtimeProfileId, runtimeAccountId });
      activeToken = session.token;
      const refreshSession = async () => {
        const refreshedManager = await ensureMcpSessionManager();
        if (closed || socket.destroyed || lifecycleGeneration !== generation
          || !mcpAuthGenerationIsActive(generation) || refreshedManager !== manager) {
          throw serviceError("MCP_SESSION_INVALID", "mcp_session_invalid");
        }
        const refreshed = manager.issueBridgeSession({ runtimeProfileId, runtimeAccountId });
        activeToken = refreshed.token;
        return refreshed;
      };
      const requestBridgeService = async (_paths, serviceRequest) => {
        if (closed || socket.destroyed || lifecycleGeneration !== generation
          || !mcpAuthGenerationIsActive(generation) || manager !== mcpSessionManager
          || !exactObject(serviceRequest, ["version", "method", "params"])
          || serviceRequest.version !== PROTOCOL_VERSION
          || !["mcp.profile.get", "mcp.tool.call"].includes(serviceRequest.method)
          || serviceRequest.params.runtimeProfileId !== runtimeProfileId
          || serviceRequest.params.runtimeAccountId !== runtimeAccountId) {
          throw serviceError("MCP_SESSION_INVALID", "mcp_session_invalid");
        }
        return executeAuthorizedMcpRequest(serviceRequest.method, serviceRequest.params);
      };
      handler = createMcpStdioHandler({
        paths,
        runtimeProfileId,
        runtimeAccountId,
        sessionToken: session.token,
        sessionExpiresAt: session.expiresAt,
        serviceVersion,
        requestService: requestBridgeService,
        refreshSession,
        now: options.now,
        randomUUID: options.randomUUID,
      });
      bridgeSockets.set(socket, { close: closeBridge });
      sockets.delete(socket);
      socket.once("close", closeBridge);
      await writeMcpBridgeAck(socket);
      if (closed || socket.destroyed || lifecycleGeneration !== generation) {
        throw serviceError("MCP_SESSION_INVALID", "mcp_session_invalid");
      }
      const sessionRun = runMcpStdioSession({ input: socket, output: socket, handler });
      socket.resume();
      void sessionRun.then(
        () => { if (!socket.destroyed) socket.end(); },
        () => { if (!socket.destroyed) socket.destroy(); },
      ).finally(closeBridge);
    } catch (error) {
      closeBridge();
      throw error;
    }
  }

  async function handleRequest(socket, request) {
    const id = request && typeof request === "object" ? request.id : null;
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      errorResponse(socket, id, "INVALID_REQUEST", "请求必须是 JSON 对象");
      return;
    }
    const isMcpRequest = MCP_SERVICE_METHODS.has(request.method);
    // Startup 期提前 bind 仅供 Runtime MCP helper 完成 one-shot gate + HMAC。
    // 普通客户端即使读到了本代 token，也必须等所有恢复入口完成后才能观察 Service。
    if (!isMcpRequest && lifecycleState !== "started") {
      errorResponse(socket, id, "SERVICE_UNAVAILABLE", "Service 尚未就绪");
      return;
    }
    if (request.version !== PROTOCOL_VERSION) {
      errorResponse(socket, id, "PROTOCOL_VERSION_MISMATCH", "协议版本不匹配");
      return;
    }
    if (isMcpRequest) {
      if (!(lifecycleState === "started"
        || (lifecycleState === "starting" && mcpTransportReady))) {
        errorResponse(socket, id, "SERVICE_UNAVAILABLE", "mcp_auth_unavailable");
        return;
      }
      await handleMcpRequest(socket, request);
      return;
    }
    if (!tokensEqual(request.token, token)) {
      errorResponse(socket, id, "AUTH_FAILED", "本地认证失败");
      return;
    }

    const baseFields = ["id", "token", "version", "method"];
    if (["service.hello", "service.status", "service.stopImpact", "service.stop"].includes(request.method)) {
      const validEnvelope = exactObject(request, baseFields)
        || (exactObject(request, [...baseFields, "params"])
          && exactObject(request.params, []));
      if (!validEnvelope) {
        errorResponse(socket, id, "INVALID_PARAMS", "Service 参数无效");
        return;
      }
    } else if (request.method === "events.subscribe") {
      const validEnvelope = exactObject(request, baseFields)
        || (exactObject(request, [...baseFields, "params"])
          && (exactObject(request.params, []) || exactObject(request.params, ["afterSeq"])));
      if (!validEnvelope) {
        errorResponse(socket, id, "INVALID_PARAMS", "events.subscribe 参数无效");
        return;
      }
    }

    let result;
    if (request.method === "service.hello") {
      result = { protocolVersion: PROTOCOL_VERSION, serviceVersion };
    } else if (request.method === "service.status") {
      result = {
        healthy: true,
        pid: process.pid,
        ppid: process.ppid,
        protocolVersion: PROTOCOL_VERSION,
        serviceVersion,
        startedAt,
        instanceNonce,
        domainAvailability: domainAvailabilitySnapshot(),
        pendingCommandsLocked: typeof pendingCommandInbox.isLocked === "function"
          ? pendingCommandInbox.isLocked() : true,
        // MCP authority is lazily unlocked on the first authenticated helper handshake.
        mcpCredentialsLocked: mcpSessionManager === null,
      };
    } else if (request.method === "service.stopImpact") {
      result = createStopImpact({
        runs: workRunCoordinator.listRuns(),
        instanceNonce: `${instanceNonce}:${lifecycleGeneration}`,
        profileFor: (id) => productStore.getAgentProfile(id),
        titleFor: (run) => {
          if (run.source === "inspiration") return inspirationStore.get(run.sourceId)?.title;
          if (run.source === "cron") return nativeCronStore.getJob(run.sourceId)?.name;
          if (run.source === "kanban") return nativeKanbanStore.getCard(run.sourceId)?.title;
          const session = chatSessionStore.getSession(run.sourceId);
          return session?.title || (session
            ? transcriptStore.getSessionDerivedTitle(session.profileId, session.id) : null);
        },
      });
    } else if (request.method === "events.subscribe") {
      const hasCursor = request.params != null
        && Object.prototype.hasOwnProperty.call(request.params, "afterSeq");
      const rawCursor = request.params?.afterSeq;
      if (hasCursor && (!Number.isSafeInteger(rawCursor) || rawCursor < 0)) {
        errorResponse(socket, id, "INVALID_PARAMS", "afterSeq 必须是非负安全整数");
        return;
      }
      const afterSeq = hasCursor ? rawCursor : 0;
      result = eventBuffer.page(afterSeq, id);
    } else if ([
      "provider.list", "provider.save", "provider.delete", "provider.secret.set",
      "provider.secret.clear", "provider.validate",
    ].includes(request.method)) {
      if (!exactObject(request, ["id", "token", "version", "method", "params"])
        || !providerParamsValid(request.method, request.params)) {
        errorResponse(socket, id, "INVALID_PARAMS", "Provider 参数无效");
        return;
      }
      try {
        if (request.method === "provider.list") result = providerService.list();
        else if (request.method === "provider.save") result = await providerService.save(request.params.provider);
        else if (request.method === "provider.delete") result = await providerService.delete(request.params);
        else if (request.method === "provider.secret.set") {
          result = await providerService.setSecret(request.params);
        } else if (request.method === "provider.secret.clear") {
          result = await providerService.clearSecret(request.params);
        } else result = await providerService.validate(request.params);
        result = validatedProviderResult(request.method, result);
      } catch (error) {
        const code = PROVIDER_PUBLIC_ERROR_CODES.has(error?.code)
          ? error.code : "PROVIDER_OPERATION_FAILED";
        errorResponse(socket, id, code, "Provider 操作失败");
        return;
      }
    } else if (["auth.read", "auth.login.start", "auth.login.cancel", "auth.logout"]
      .includes(request.method)) {
      if (!exactObject(request, ["id", "token", "version", "method", "params"])
        || !authParamsValid(request.method, request.params)) {
        errorResponse(socket, id, "INVALID_PARAMS", "账户认证参数无效");
        return;
      }
      try {
        if (request.method === "auth.read") result = await accountAuthManager.read(request.params);
        else if (request.method === "auth.login.start") {
          result = await accountAuthManager.loginStart(request.params);
        } else if (request.method === "auth.login.cancel") {
          result = await accountAuthManager.loginCancel(request.params);
        } else result = await accountAuthManager.logout(request.params);
      } catch (error) {
        const code = AUTH_PUBLIC_ERROR_CODES.has(error?.code) ? error.code : "AUTH_OPERATION_FAILED";
        errorResponse(socket, id, code, "账户认证操作失败");
        return;
      }
      if (!validateAuthResult(request.method, result)) {
        errorResponse(socket, id, "AUTH_RESPONSE_INVALID", "账户认证响应无效");
        return;
      }
    } else if (RUNTIME_ACCOUNT_SERVICE_METHOD_SET.has(request.method)) {
      try {
        if (!exactObject(request, ["id", "token", "version", "method", "params"])) {
          throw serviceError("INVALID_PARAMS", "RuntimeAccount request envelope is invalid");
        }
        const params = validateRuntimeAccountServiceParams(request.method, request.params);
        result = await runtimeAccountServiceController.handle(request.method, params);
        result = validateRuntimeAccountServiceResult(request.method, result);
      } catch (error) {
        const mapped = mapRuntimeAccountServiceError(error);
        errorResponse(socket, id, mapped.code, mapped.message);
        return;
      }
    } else if (request.method === "usage.series" || request.method === "usage.breakdown") {
      try {
        if (!exactObject(request, ["id", "token", "version", "method", "params"])
          || !exactObject(request.params, ["range", "backendId"])
          || typeof request.params.backendId !== "string"
          || !BACKEND_ID_PATTERN.test(request.params.backendId)) {
          throw serviceError("INVALID_PARAMS", "Token usage 参数无效");
        }
        const range = validateUsageRange(request.params.range);
        const profileIds = new Set(productStore.listAgentProfiles()
          .filter((profile) => profile.backendId === request.params.backendId)
          .map((profile) => profile.id));
        const summary = tokenUsageStore.summarize(range, {
          backendId: request.params.backendId,
          profileIds,
        });
        result = request.method === "usage.series"
          ? validateUsageSeries(summary.series)
          : validateUsageBreakdown(summary.breakdown);
      } catch (error) {
        if (error?.code === "INVALID_PARAMS") {
          errorResponse(socket, id, "INVALID_PARAMS", "Token usage 参数无效");
        } else if (error instanceof TypeError) {
          errorResponse(socket, id, "USAGE_RESPONSE_INVALID", "Token usage 响应无效");
        } else {
          errorResponse(socket, id, "SERVICE_UNAVAILABLE", "Token usage 暂时不可用");
        }
        return;
      }
    } else if (AGENT_LIFECYCLE_METHOD_SET.has(request.method)) {
      try {
        if (!exactObject(request, ["id", "token", "version", "method", "params"])) {
          throw serviceError("INVALID_PARAMS", "Agent lifecycle request envelope is invalid");
        }
        const params = validateAgentLifecycleParams(request.method, request.params);
        result = await agentLifecycleServiceController.handle(request.method, params);
        result = validateAgentLifecycleResult(request.method, result);
      } catch (error) {
        const mapped = mapAgentLifecycleError(error);
        errorResponse(socket, id, mapped.code, mapped.message);
        return;
      }
    } else if (AGENT_HARNESS_METHOD_SET.has(request.method)) {
      try {
        if (!exactObject(request, ["id", "token", "version", "method", "params"])) {
          throw serviceError("INVALID_PARAMS", "Agent Harness request envelope is invalid");
        }
        const params = validateAgentHarnessParams(request.method, request.params);
        result = await agentHarnessServiceController.handle(request.method, params);
        result = validateAgentHarnessResult(request.method, result);
      } catch (error) {
        const mapped = mapAgentHarnessError(error);
        errorResponse(socket, id, mapped.code, mapped.message);
        return;
      }
    } else if (PROFILE_SERVICE_METHOD_SET.has(request.method)) {
      try {
        if (!exactObject(request, ["id", "token", "version", "method", "params"])) {
          throw serviceError("INVALID_PARAMS", "Profile request envelope is invalid");
        }
        const params = validateProfileServiceParams(request.method, request.params);
        result = await profileServiceController.handle(request.method, params);
        result = validateProfileServiceResult(request.method, result);
      } catch (error) {
        const mapped = mapProfileServiceError(error);
        errorResponse(socket, id, mapped.code, mapped.message);
        return;
      }
    } else if (INSPIRATION_SERVICE_METHOD_SET.has(request.method)) {
      try {
        const params = validateInspirationServiceParams(request.method, request.params);
        result = validateInspirationServiceResult(request.method, await inspirationService.handle(request.method, params));
      } catch (error) {
        const code = Object.hasOwn(INSPIRATION_PUBLIC_MESSAGES, error?.code) ? error.code : "INSPIRATION_UNAVAILABLE";
        errorResponse(socket, id, code, INSPIRATION_PUBLIC_MESSAGES[code]);
        return;
      }
    } else if (CHAT_SERVICE_METHOD_SET.has(request.method)) {
      try {
        const canonical = validateChatServiceRequest(request);
        result = await chatServiceController.handle(
          canonical.method,
          canonical.params,
          canonical.id,
        );
        result = validateChatServiceResult(canonical.method, result);
      } catch (error) {
        if (error?.code === "UNKNOWN_METHOD") {
          errorResponse(socket, id, "UNKNOWN_METHOD", "Chat Service 方法尚未接线");
          return;
        }
        if (["credentials_locked", "pending_commands_locked"].includes(error?.code)) {
          errorResponse(socket, id, "SERVICE_UNAVAILABLE", "Shoggoth Service 暂时不可用");
          return;
        }
        const mapped = mapChatServiceError(error);
        errorResponse(socket, id, mapped.code, mapped.message);
        return;
      }
    } else if (DOMAIN_SERVICE_METHOD_SET.has(request.method)) {
      try {
        const canonical = validateDomainServiceRequest(request);
        result = await nativeDomainServiceController.handle(
          canonical.method,
          canonical.params,
        );
        result = validateDomainServiceResult(canonical.method, result, canonical.params);
      } catch (error) {
        const mapped = mapDomainServiceError(error, { method: request.method });
        errorResponse(socket, id, mapped.code, mapped.message);
        return;
      }
    } else if (request.method === "service.stop") {
      result = { stopping: true };
    } else {
      errorResponse(socket, id, "UNKNOWN_METHOD", `未知方法: ${String(request.method)}`);
      return;
    }

    writeResponse(socket, { id, ok: true, result });
    if (request.method === "service.stop") {
      setImmediate(() => { void api.stop().catch(reportStopFailure); });
    }
  }

  function acceptSocket(socket) {
    sockets.add(socket);
    let buffered = Buffer.alloc(0);
    let terminal = false;
    let frameTimer = null;
    const clearFrameTimer = () => {
      if (frameTimer) clearTimeout(frameTimer);
      frameTimer = null;
    };
    const armFrameTimer = () => {
      clearFrameTimer();
      frameTimer = setTimeout(() => {
        if (terminal || socket.destroyed) return;
        terminal = true;
        buffered = Buffer.alloc(0);
        errorResponse(socket, null, "FRAME_TIMEOUT", "请求帧接收超时", true);
      }, frameTimeoutMs);
    };
    armFrameTimer();
    attachAcceptedSocketErrorGuard(socket, () => {
      // 对端 reset/EPIPE 是连接级失败，不能升级成 Service 未捕获异常。
      terminal = true;
      clearFrameTimer();
    });
    const onClose = () => {
      terminal = true;
      clearFrameTimer();
      sockets.delete(socket);
      inFlightSockets.delete(socket);
    };
    const onEnd = () => {
      clearFrameTimer();
      if (terminal || socket.destroyed) return;
      terminal = true;
      if (buffered.length > 0) {
        buffered = Buffer.alloc(0);
        errorResponse(socket, null, "INCOMPLETE_FRAME", "连接在 JSONL 帧完成前结束", true);
      } else {
        socket.end();
      }
    };
    const onData = (chunk) => {
      if (terminal) return;
      clearFrameTimer();
      buffered = Buffer.concat([buffered, chunk]);
      while (true) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) {
          if (buffered.length > MAX_FRAME_BYTES) {
            terminal = true;
            buffered = Buffer.alloc(0);
            errorResponse(socket, null, "FRAME_TOO_LARGE", "请求帧超过上限", true);
          } else {
            armFrameTimer();
          }
          return;
        }
        const frame = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        if (frame.length > MAX_FRAME_BYTES) {
          terminal = true;
          errorResponse(socket, null, "FRAME_TOO_LARGE", "请求帧超过上限", true);
          return;
        }
        let request;
        try {
          request = JSON.parse(frame.toString("utf8"));
        } catch {
          terminal = true;
          errorResponse(socket, null, "MALFORMED_JSON", "请求不是有效 JSON", true);
          return;
        }
        if (buffered.length > 0) {
          terminal = true;
          buffered = Buffer.alloc(0);
          errorResponse(socket, null, "MULTIPLE_REQUESTS", "单连接只允许一个 JSONL 请求", true);
          return;
        }
        terminal = true;
        clearFrameTimer();
        if (request && request.method === "mcp.runtime.bridge.open") {
          socket.pause();
          socket.off("data", onData);
          socket.off("end", onEnd);
          void Promise.resolve()
            .then(() => openMcpRuntimeBridge(socket, request))
            .catch((error) => handleMcpError(socket, null, error));
          return;
        }
        const inFlight = Promise.resolve()
          .then(() => handleRequest(socket, request))
          .catch(() => handleInternalError(socket, request))
          // A normal response remains in-flight until the socket close confirms
          // write callback + EOF. An already-disconnected peer has no response
          // left to drain, and its close event may have preceded this microtask.
          .finally(() => {
            if (socket.destroyed) inFlightSockets.delete(socket);
          });
        inFlightSockets.add(socket);
        void inFlight;
        return;
      }
    };
    socket.on("close", onClose);
    socket.on("end", onEnd);
    socket.on("data", onData);
  }

  const api = {
    productStore,
    secretStore,
    mcpCryptoBroker,
    runtimeConfigWriter,
    providerRuntimeBridge,
    providerService,
    runtimePool,
    codexRuntimeAdapter,
    grokBuildRuntimePool,
    grokBuildRuntimeAdapter,
    antigravityRuntimePool,
    antigravityRuntimeAdapter,
    piRuntimePool,
    piRuntimeAdapter,
    claudeCodeRuntimePool,
    claudeCodeRuntimeAdapter,
    deepSeekHarnessRuntimePool,
    deepSeekHarnessRuntimeAdapter,
    runtimeManager,
    runtimeAccountAdmission,
    runtimeAccountMigrationOrchestrator,
    legacyRuntimeHomeStore,
    runtimeStorageCleanup,
    runtimeBackupStore,
    runtimeBackupCleanup,
    runtimeAccountServiceController,
    runtimeSessionOwnershipStore,
    runtimeMcpGateIssuer,
    accountAuthStateStore,
    accountAuthManager,
    profileServiceController,
    agentLifecycleServiceController,
    chatSessionStore,
    agentDefinitionStore,
    transcriptStore,
    memoryStore,
    memoryEngine,
    nativeSkillStore,
    systemHostController,
    computerUseController,
    toolRegistry,
    permissionEngine,
    federationCoordinator,
    federationMcpSessionManager,
    contextSnapshotStore,
    contextCompiler,
    agentHarnessServiceController,
    tokenUsageStore,
    pendingCommandInbox,
    workDispatcher,
    nativeKanbanStore,
    inspirationStore,
    inspirationService,
    kanbanRunService,
    nativeCronStore,
    nativeCronScheduler,
    domainWorkRunExecutor,
    get nativeDomainServiceController() { return nativeDomainServiceController; },
    get mcpProductToolController() { return mcpProductToolController; },
    get workRunCoordinator() { return workRunCoordinator; },
    get chatServiceController() { return chatServiceController; },

    getNativeRuntimeImportSummary() {
      return nativeRuntimeImportSummary === null
        ? null : structuredClone(nativeRuntimeImportSummary);
    },

    getDomainAvailability() {
      return domainAvailabilitySnapshot();
    },

    appendEvent(type, payload) {
      return eventBuffer.append(type, payload);
    },

    start() {
      if (lifecycleState === "started") return Promise.resolve(api);
      if (lifecycleState === "starting") return startPromise;
      if (lifecycleState === "stopping") {
        return Promise.reject(serviceError("SERVICE_STOPPING", "Service 正在停止"));
      }
      if (lifecycleState === "stop_failed") return stopping;

      lifecycleState = "starting";
      const generation = ++lifecycleGeneration;
      // 先发布 singleflight promise，再在下一个 microtask 进入 startup；这样即使
      // 注入的底层实现同步重入 stop，也一定能等待并 fence 这一代启动。
      const currentStart = Promise.resolve().then(async () => {
        let acquiredLock;
        try {
          assertStartGeneration(generation);
          if (defaultCoordinatorRetired && !options.workRunCoordinator) {
            workRunCoordinator = createDefaultWorkRunCoordinator();
            defaultCoordinatorRetired = false;
          }
          if (defaultControllerRetired && !options.chatServiceController) {
            chatServiceController = createDefaultChatServiceController(workRunCoordinator);
            defaultControllerRetired = false;
          }
          if (defaultDomainControllerRetired && !options.nativeDomainServiceController) {
            const replacement = createDefaultNativeDomainServiceController();
            nativeDomainServiceController = replacement.controller;
            nativeDomainServiceControllerOwnerToken = replacement.ownerToken;
            defaultDomainControllerRetired = false;
          }
          if (defaultMcpProductToolControllerRetired && !options.mcpProductToolController) {
            const replacement = createDefaultMcpProductToolController();
            mcpProductToolController = replacement.controller;
            mcpProductToolControllerOwnerToken = replacement.ownerToken;
            defaultMcpProductToolControllerRetired = false;
          }
          activeDomainControllerOwnerToken = nativeDomainServiceControllerOwnerToken;
          activeMcpProductToolControllerOwnerToken = mcpProductToolControllerOwnerToken;
          domainFatalReports.kanban = null;
          domainFatalReports.cron = null;
          mcpProductFatalReport = null;
          startupFatal = null;
          // cache 必须先逐段拒绝 symlink，再允许创建其下 runtime；否则递归 mkdir
          // 会先穿透攻击者链接并污染链接目标。
          ensurePrivateDirectoryTree(paths.cacheDir, paths.trustedRoot);
          ensurePrivateDirectoryTree(paths.stateDir, paths.trustedRoot);
          ensurePrivateDirectoryTree(paths.profileDir, paths.trustedRoot);
          ensurePrivateDirectoryTree(paths.runtimeDir, paths.trustedRoot);
          acquiredLock = await acquireInstanceLock(paths.lockPath, {
            paths,
            instanceNonce,
            getProcessIdentity,
            lockProbeTimeoutMs,
            protocolVersion: PROTOCOL_VERSION,
            fs: options.lockFs,
          });
          lockFd = acquiredLock.fd;
          ownedLockIdentity = {
            dev: acquiredLock.identity.dev,
            ino: acquiredLock.identity.ino,
          };
          // stop 可能在 lock acquisition 挂起期间到达；先登记刚取得的所有权，
          // 再过 generation fence，确保取消路径能关闭 fd 并只删除自己的 inode。
          assertStartGeneration(generation);
          // 独占 lock 已证明没有合法 Service 持有这个 endpoint。崩溃可能遗留
          // service.sock；schema backup 仍应把运行期 socket 当作 active 证据，
          // 所以必须在进入迁移备份前先按原有 no-symlink 规则清掉 stale path。
          const staleSocketStat = rejectSymlink(paths.socketPath);
          if (staleSocketStat) fs.unlinkSync(paths.socketPath);
          let runtimeSchemaMigrationBackup = null;
          if (!options.productStore && !options.chatSessionStore) {
            recoverStalePersistentWriterLeases(paths);
            runtimeSchemaMigrationBackup = ensureRuntimeSchemaMigrationBackup({
              paths,
              activeServiceLock: ownedLockIdentity,
              now: options.now,
            });
            if (nativeRuntimeImportEnabled) {
              ensureNativeRuntimeImportBackup({
                paths,
                activeServiceLock: ownedLockIdentity,
                now: options.now,
              });
            }
          }
          runtimeAccountMigrationOrchestratorOpened = true;
          runtimeAccountMigrationOrchestrator.prepare({
            metadataBackup: runtimeSchemaMigrationBackup,
            activeServiceLock: ownedLockIdentity,
          });
          assertStartGeneration(generation);
          // 单实例锁取得后才打开 Store，确保整个产品状态只有 Service 这一位 writer。
          runtimeMcpGateIssuerOpened = true;
          await runtimeMcpGateIssuer.open();
          assertStartGeneration(generation);
          mcpCryptoBrokerOpened = true;
          await mcpCryptoBroker.open({ generation });
          assertStartGeneration(generation);
          secretStoreOpened = true;
          await secretStore.open();
          assertStartGeneration(generation);
          storeOpened = true;
          productStore.open();
          assertStartGeneration(generation);
          if (options.builtinCliProfiles === true) {
            ensureBuiltinCliAgentProfiles(productStore);
          }
          runtimeAccountMigrationOrchestrator.reconcileAccountsAndProfiles(productStore);
          await migrateLegacySharedCodexApiKey({
            paths,
            productStore,
            secretStore,
            now: options.now,
            parentEnv: options.parentEnv,
            homedir: options.runtimeStorageHomedir,
          });
          assertStartGeneration(generation);
          // API-key migration must resume before generic orphan GC: a crash after
          // encrypted put but before Provider binding leaves a deterministic,
          // journal-owned ref that is not an orphan.
          await reconcileProviderCredentialSecrets({ productStore, secretStore });
          assertStartGeneration(generation);
          runtimeSessionOwnershipStoreOpened = true;
          runtimeSessionOwnershipStore.open();
          if (typeof permissionEngine.open === "function") {
            permissionEngine.open(
              productStore.listAgentProfiles().map((profile) => profile.id),
            );
            permissionEngineOpened = true;
          }
          nativeSkillStoreOpened = true;
          await nativeSkillStore.open(
            productStore.listAgentProfiles().map((profile) => profile.id),
          );
          if (nativeRuntimeImportEnabled) {
            nativeRuntimeImportSummary = importNativeRuntimeHomes({
              paths,
              profiles: productStore.listAgentProfiles(),
              homeDir: nativeRuntimeImportHome,
              skillStore: nativeSkillStore,
              now: options.now,
            });
            if (typeof options.onNativeRuntimeImport === "function") {
              try { options.onNativeRuntimeImport(nativeRuntimeImportSummary); } catch { /* diagnostic only */ }
            }
          }
          if (computerUseController) {
            computerUseControllerOpened = true;
            await computerUseController.open();
          }
          assertStartGeneration(generation);
          agentDefinitionStoreOpened = true;
          await agentDefinitionStore.open();
          if (typeof productStore.listAgentProfiles === "function") {
            for (const profile of productStore.listAgentProfiles()) {
              agentDefinitionStore.ensureProfile({ profileId: profile.id });
            }
          }
          if (typeof toolRegistry.toolsMarkdown === "function"
            && typeof toolRegistry.revision === "string") {
            const toolsContent = toolRegistry.toolsMarkdown();
            for (const profile of productStore.listAgentProfiles()) {
              agentDefinitionStore.writeGeneratedView({
                profileId: profile.id,
                kind: "TOOLS",
                revision: toolRegistry.revision,
                content: toolsContent,
              });
            }
          }
          assertStartGeneration(generation);
          memoryStoreOpened = true;
          await memoryStore.open();
          memoryEngineOpened = true;
          const memoryProfiles = productStore.listAgentProfiles();
          await memoryEngine.open(memoryProfiles.map((profile) => profile.id));
          if (!options.memoryStore && !options.memoryEngine) {
            completeMemoryMigration({ paths, memoryEngine, profiles: memoryProfiles, now: options.now });
          }
          contextSnapshotStoreOpened = true;
          await contextSnapshotStore.open();
          assertStartGeneration(generation);
          tokenUsageStoreOpened = true;
          await tokenUsageStore.open();
          assertStartGeneration(generation);
          domainAvailability.kanban = { available: true, reason: null };
          domainAvailability.cron = { available: true, reason: null };
          try {
            nativeKanbanStoreOpened = true;
            await nativeKanbanStore.open();
            // 每个启用 Agent 都需要稳定的原生任务入口；已有任意用户 Board 时保持原样。
            if (!options.nativeKanbanStore) {
              ensureDefaultAgentBoards(productStore, nativeKanbanStore);
            } else {
              // 注入 Store 仍要执行启动健康探针，不能因跳过默认 Board bootstrap
              // 而漏掉 commit-uncertain / corruption。
              nativeKanbanStore.listBoards();
            }
          } catch (error) {
            const healthFailure = sanitizedDomainStartupHealthError("kanban", error);
            if (healthFailure) throw latchStartupFatal(generation, healthFailure);
            nativeKanbanStoreOpened = false;
            try { await nativeKanbanStore.close(); } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                "NativeKanbanStore matcher 不可用且清理失败",
              );
            }
            domainAvailability.kanban = {
              available: false,
              reason: "sensitive_check_unavailable",
            };
          }
          assertStartGeneration(generation);
          try {
            nativeCronStoreOpened = true;
            await nativeCronStore.open();
            nativeCronStore.listJobs();
          } catch (error) {
            const healthFailure = sanitizedDomainStartupHealthError("cron", error);
            if (healthFailure) throw latchStartupFatal(generation, healthFailure);
            nativeCronStoreOpened = false;
            try { await nativeCronStore.close(); } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                "NativeCronStore matcher 不可用且清理失败",
              );
            }
            domainAvailability.cron = {
              available: false,
              reason: "sensitive_check_unavailable",
            };
          }
          assertStartGeneration(generation);
          providerRuntimeOpened = true;
          await providerRuntimeBridge.open();
          assertStartGeneration(generation);
          if (typeof providerService.open === "function") {
            providerServiceOpened = true;
            await providerService.open();
            assertStartGeneration(generation);
          }
          accountAuthStateOpened = true;
          await accountAuthStateStore.open();
          assertStartGeneration(generation);
          accountAuthManagerOpened = true;
          await accountAuthManager.open();
          assertStartGeneration(generation);
          runtimeAccountServiceControllerOpened = true;
          await runtimeAccountServiceController.open();
          assertStartGeneration(generation);
          profileServiceControllerOpened = true;
          await profileServiceController.open();
          assertStartGeneration(generation);
          agentLifecycleServiceControllerOpened = true;
          await agentLifecycleServiceController.open();
          assertStartGeneration(generation);
          chatSessionStoreOpened = true;
          await chatSessionStore.open();
          inspirationStoreOpened = true;
          inspirationStore.open();
          runtimeAccountMigrationOrchestrator.backfillOwnership({
            productStore,
            chatSessionStore,
            ownershipStore: runtimeSessionOwnershipStore,
          });
          assertStartGeneration(generation);
          transcriptStoreOpened = true;
          await transcriptStore.open();
          for (const session of chatSessionStore.listSessions()) {
            transcriptStore.ensureSession({ profileId: session.profileId, sessionId: session.id });
          }
          runtimeAccountMigrationOrchestrator.reconcileLegacyRuntimeSessions({
            productStore,
            chatSessionStore,
            transcriptStore,
            ownershipStore: runtimeSessionOwnershipStore,
          });
          runtimeAccountMigrationOrchestrator.reconcileRuntimeRefs(productStore);
          assertStartGeneration(generation);
          pendingCommandInboxOpened = true;
          await pendingCommandInbox.open();
          assertStartGeneration(generation);
          // Kanban/Cron active run 先保留给 domain owner：默认 Coordinator 会收敛
          // 丢失内存 execution contract 的 starting Run；自定义 executor 则保有自己的
          // recover ownership。chat running/waiting 不能在 crash 后继续，starting 留给
          // Coordinator 对账。
          for (const run of productStore.listWorkRuns()) {
            if (!ACTIVE_WORK_RUN_STATUSES.has(run.status)) continue;
            if (["kanban", "cron", "inspiration"].includes(run.source)) continue;
            if (run.source === "chat" && run.status === "starting") continue;
            const recovered = workDispatcher.recoverActiveRunAfterServiceRestart(run.id);
            publishFederationTerminal(recovered, {
              status: recovered.status,
              resultSummary: recovered.resultSummary,
              errorCode: recovered.errorCode,
            });
          }
          assertStartGeneration(generation);
          if (typeof options.onWorkDispatcherReady === "function") {
            options.onWorkDispatcherReady(workDispatcher);
          }
          assertStartGeneration(generation);
          chatServiceControllerOpened = true;
          await chatServiceController.open();
          assertStartGeneration(generation);
          // Runtime recovery may immediately spawn the packaged MCP helper. Publish the
          // private transport first, while ordinary token APIs remain gated by `started`.
          token = writePrivateToken(paths.tokenPath);
          const tokenStat = fs.lstatSync(paths.tokenPath);
          ownedTokenIdentity = { dev: tokenStat.dev, ino: tokenStat.ino };
          const socketStat = rejectSymlink(paths.socketPath);
          if (socketStat) fs.unlinkSync(paths.socketPath);
          server = net.createServer({ allowHalfOpen: true }, acceptSocket);
          await new Promise((resolve, reject) => {
            const onError = (error) => reject(error);
            server.once("error", onError);
            server.listen(paths.socketPath, () => {
              server.off("error", onError);
              // listen 后必须常驻 error listener；否则运行期 accept/socket 错误会升级
              // 为 EventEmitter 的未捕获 "error" 并终止整个 Service 进程。
              server.on("error", (error) => { void reportRuntimeServerError(error); });
              resolve();
            });
          });
          assertStartGeneration(generation);
          fs.chmodSync(paths.socketPath, 0o600);
          const socketStatAfterListen = fs.lstatSync(paths.socketPath);
          ownedSocketIdentity = { dev: socketStatAfterListen.dev, ino: socketStatAfterListen.ino };
          mcpTransportReady = true;
          assertStartGeneration(generation);
          workRunCoordinatorOpened = true;
          await workRunCoordinator.open();
          workRunCoordinator.recoverCronChatSessions?.();
          workRunCoordinatorReady = true;
          inspirationService.open();
          if (pendingInboxRecoveryNeeded) {
            await recoverUnlockedPendingCommands(generation);
          }
          assertStartGeneration(generation);
          if (domainAvailability.kanban.available) {
            kanbanRunServiceOpened = true;
            await kanbanRunService.open();
            // open 可同步返回但在同一 event-loop turn 发布 background fatal；ready 发布前
            // 留出一个有界观察点，让本代 latch 成为 startup 主错。
            await new Promise((resolve) => setImmediate(resolve));
          }
          assertStartGeneration(generation);
          if (domainAvailability.cron.available) {
            nativeCronSchedulerOpened = true;
            await nativeCronScheduler.open();
            await new Promise((resolve) => setImmediate(resolve));
          }
          assertStartGeneration(generation);
          runtimeAccountMigrationOrchestrator.markServiceReady();
          assertStartGeneration(generation);
          startedAt = Date.now();
          assertStartGeneration(generation);
          if (typeof options.onServerReady === "function") options.onServerReady(server);
          assertStartGeneration(generation);
          lifecycleState = "started";
          // Unlock can land after the earlier startup recovery check but before
          // this state transition. Once `started` is visible, check the durable
          // flag again; later unlocks are handled directly by the callback.
          if (pendingInboxRecoveryNeeded) {
            void recoverUnlockedPendingCommands(generation).catch((error) => (
              reportRuntimeServerError(error)
            ));
          }
          if (options.prewarmMcpAuth === true) {
            // 正式 App 首次打开后异步初始化后台凭据。crypto worker 与 Service
            // 事件循环隔离，因此系统钥匙串等待不会阻断 status/只读页面；失败
            // 仍由本 generation 的 sticky latch 保证只弹一次。
            setImmediate(() => {
              if (mcpAuthGenerationIsActive(generation)) {
                void Promise.resolve(ensureMcpSessionManager()).catch(() => {});
              }
            });
          }
          return api;
        } catch (error) {
          if (lifecycleGeneration !== generation || lifecycleState !== "starting") {
            throw serviceError("SERVICE_START_CANCELED", "Service 启动已被停止请求取消");
          }
          const latchedStartupFatal = startupFatal?.generation === generation
            && startupFatal.error === error;
          lifecycleState = "stopping";
          lifecycleGeneration += 1;
          const cleanupPromise = cleanupService({ notify: false });
          stopping = cleanupPromise;
          try {
            await cleanupPromise;
            if (stopping === cleanupPromise) {
              stopping = null;
              lifecycleState = "stopped";
            }
          } catch (cleanupError) {
            lifecycleState = "stop_failed";
            // Startup background fatal 已是冻结、脱敏的本代主错。cleanup 仍完整执行，
            // 但其任意失败不得把 commit-uncertain/corrupt 语义或私密细节覆盖掉。
            if (latchedStartupFatal) throw error;
            const combined = new AggregateError(
              [error, ...(cleanupError.errors || [cleanupError])],
              "Service 启动失败且清理不完整",
            );
            combined.code = "SERVICE_START_FAILED";
            throw combined;
          }
          throw error;
        }
      });
      startPromise = currentStart;
      void currentStart.then(
        () => { if (startPromise === currentStart) startPromise = null; },
        () => { if (startPromise === currentStart) startPromise = null; },
      );
      return currentStart;
    },

    stop(stopOptions = {}) {
      if (lifecycleState === "stopping" || lifecycleState === "stop_failed") return stopping;
      const ownsInstance = server !== null || lockFd !== null
        || ownedSocketIdentity !== null || ownedLockIdentity !== null || storeOpened
        || bridgeSockets.size > 0
        || secretStoreOpened || mcpCryptoBrokerOpened || mcpSessionManager
        || providerRuntimeOpened || providerServiceOpened || accountAuthStateOpened
        || accountAuthManagerOpened || runtimeAccountMigrationOrchestratorOpened
        || runtimeAccountServiceControllerOpened || profileServiceControllerOpened
        || agentLifecycleServiceControllerOpened
        || chatSessionStoreOpened || inspirationStoreOpened || agentDefinitionStoreOpened || transcriptStoreOpened
        || memoryStoreOpened || memoryEngineOpened || permissionEngineOpened
        || nativeSkillStoreOpened
        || computerUseControllerOpened
        || contextSnapshotStoreOpened
        || pendingCommandInboxOpened
        || chatServiceControllerOpened || workRunCoordinatorOpened
        || nativeKanbanStoreOpened || kanbanRunServiceOpened
        || nativeCronStoreOpened || nativeCronSchedulerOpened;
      if (lifecycleState === "stopped" && !ownsInstance) return Promise.resolve();
      const pendingStart = lifecycleState === "starting" ? startPromise : null;
      lifecycleState = "stopping";
      lifecycleGeneration += 1;
      activeDomainControllerOwnerToken = null;
      activeMcpProductToolControllerOwnerToken = null;
      const currentStop = (async () => {
        if (pendingStart) await pendingStart.catch(() => {});
        await cleanupService(stopOptions);
      })();
      stopping = currentStop;
      void currentStop.then(
        () => {
          if (stopping !== currentStop) return;
          stopping = null;
          lifecycleState = "stopped";
        },
        () => {
          if (stopping === currentStop) lifecycleState = "stop_failed";
        },
      );
      return currentStop;
    },
  };

  function assertStartGeneration(generation) {
    if (lifecycleState !== "starting" || lifecycleGeneration !== generation) {
      throw serviceError("SERVICE_START_CANCELED", "Service 启动已被停止请求取消");
    }
    if (startupFatal?.generation === generation) throw startupFatal.error;
  }

  async function cleanupService(stopOptions = {}) {
    const errors = [];
    mcpTransportReady = false;
    token = null;
    const activeServer = server;
    server = null;
    let closePromise = Promise.resolve();
    if (activeServer) {
      closePromise = new Promise((resolve) => {
        try {
          activeServer.close((error) => {
            if (error) errors.push(error);
            resolve();
          });
        } catch (error) {
          errors.push(error);
          resolve();
        }
      });
    }
    // MCP bridge 是长连接，不进入普通 one-request drain。先撤销其内存 session
    // 并断开 socket，避免 server.close 等到 MCP client 自行 EOF。
    for (const [socket, bridge] of bridgeSockets) {
      try { bridge.close(); } catch (error) { errors.push(error); }
      try { socket.destroy(); } catch (error) { errors.push(error); }
    }
    bridgeSockets.clear();
    // Connections without a dispatched request have nothing to drain and must
    // not hold shutdown open until their frame timer expires.
    for (const socket of sockets) {
      if (inFlightSockets.has(socket)) continue;
      try { socket.destroy(); } catch (error) { errors.push(error); }
    }
    // Stop accepting first, then give already-dispatched requests one bounded
    // drain window to flush their single JSONL response. Idle/blocked clients
    // are still force-closed when the same close deadline expires.
    let closeTimer = null;
    try {
      await Promise.race([
        closePromise,
        new Promise((_, reject) => {
          closeTimer = setTimeout(() => {
            reject(serviceError("SERVICE_CLOSE_TIMEOUT", "Service server.close 超时"));
          }, closeTimeoutMs);
        }),
      ]);
    } catch (error) {
      errors.push(error);
    } finally {
      if (closeTimer) clearTimeout(closeTimer);
    }
    for (const socket of sockets) {
      try { socket.destroy(); } catch (error) { errors.push(error); }
    }
    sockets.clear();
    inFlightSockets.clear();
    // 先封住周期触发与 Kanban 接管，再关闭 Coordinator；否则 stop 期间可能把新 Run
    // 送进已开始拆除的 Host 生命周期。
    if (nativeCronSchedulerOpened) {
      nativeCronSchedulerOpened = false;
      try { await nativeCronScheduler.close(); } catch (error) { errors.push(error); }
    }
    if (kanbanRunServiceOpened) {
      kanbanRunServiceOpened = false;
      try { await kanbanRunService.close(); } catch (error) { errors.push(error); }
    }
    inspirationService.close();
    if (!options.nativeDomainServiceController) defaultDomainControllerRetired = true;
    activeDomainControllerOwnerToken = null;
    if (!options.mcpProductToolController) defaultMcpProductToolControllerRetired = true;
    activeMcpProductToolControllerOwnerToken = null;
    if (runtimeAccountServiceControllerOpened) {
      runtimeAccountServiceControllerOpened = false;
      try { await runtimeAccountServiceController.close(); } catch (error) { errors.push(error); }
    }
    if (profileServiceControllerOpened) {
      profileServiceControllerOpened = false;
      try { await profileServiceController.close(); } catch (error) { errors.push(error); }
    }
    if (agentLifecycleServiceControllerOpened) {
      agentLifecycleServiceControllerOpened = false;
      try { await agentLifecycleServiceController.close(); } catch (error) { errors.push(error); }
    }
    if (accountAuthManagerOpened) {
      accountAuthManagerOpened = false;
      try { await accountAuthManager.close(); } catch (error) { errors.push(error); }
    }
    if (providerServiceOpened) {
      providerServiceOpened = false;
      try { await providerService.close(); } catch (error) { errors.push(error); }
    }
    if (chatServiceControllerOpened) {
      chatServiceControllerOpened = false;
      try { await chatServiceController.close(); } catch (error) { errors.push(error); }
      if (!options.chatServiceController) defaultControllerRetired = true;
    }
    if (workRunCoordinatorOpened) {
      workRunCoordinatorReady = false;
      pendingInboxRecoveryNeeded = false;
      pendingInboxRecovery = null;
      workRunCoordinatorOpened = false;
      try { await workRunCoordinator.close(); } catch (error) { errors.push(error); }
      if (!options.workRunCoordinator) defaultCoordinatorRetired = true;
    }
    if (mcpSessionManager) {
      const activeMcpSessionManager = mcpSessionManager;
      mcpSessionManager = null;
      try { await activeMcpSessionManager.close(); } catch (error) { errors.push(error); }
    }
    federationMcpSessionManager.reset();
    // 正在进行的密钥库调用不能跨 lifecycle generation 发布 manager；不在 stop
    // 中等待它，避免 MCP 密钥库卡住拖死普通 Service 关闭/重启。
    mcpAuthInitAttempt = null;
    mcpAuthFailureGeneration = null;
    if (mcpCryptoBrokerOpened) {
      mcpCryptoBrokerOpened = false;
      try { await mcpCryptoBroker.close(); } catch (error) { errors.push(error); }
    }
    try {
      await runtimeManager.stopAll();
    } catch (error) {
      if (error?.code === "RUNTIME_ADAPTER_REGISTRY_STOP_FAILED" && Array.isArray(error.errors)) {
        errors.push(...error.errors);
      } else {
        errors.push(error);
      }
    }
    if (runtimeMcpGateIssuerOpened) {
      runtimeMcpGateIssuerOpened = false;
      try { await runtimeMcpGateIssuer.close(); } catch (error) { errors.push(error); }
    }
    if (accountAuthStateOpened) {
      accountAuthStateOpened = false;
      try { await accountAuthStateStore.close(); } catch (error) { errors.push(error); }
    }
    if (runtimeAccountMigrationOrchestratorOpened) {
      runtimeAccountMigrationOrchestratorOpened = false;
      try { runtimeAccountMigrationOrchestrator.close(); } catch (error) { errors.push(error); }
    }
    if (runtimeSessionOwnershipStoreOpened) {
      runtimeSessionOwnershipStoreOpened = false;
      try { await runtimeSessionOwnershipStore.close(); } catch (error) { errors.push(error); }
    }
    if (providerRuntimeOpened) {
      providerRuntimeOpened = false;
      try { await providerRuntimeBridge.close(); } catch (error) { errors.push(error); }
    }
    if (pendingCommandInboxOpened) {
      pendingCommandInboxOpened = false;
      try { await pendingCommandInbox.close(); } catch (error) { errors.push(error); }
    }
    if (inspirationStoreOpened) {
      inspirationStoreOpened = false;
      try { inspirationStore.close(); } catch (error) { errors.push(error); }
    }
    if (chatSessionStoreOpened) {
      if (transcriptStoreOpened) {
        transcriptStoreOpened = false;
        try { await transcriptStore.close(); } catch (error) { errors.push(error); }
      }
      chatSessionStoreOpened = false;
      try { await chatSessionStore.close(); } catch (error) { errors.push(error); }
    }
    if (transcriptStoreOpened) {
      transcriptStoreOpened = false;
      try { await transcriptStore.close(); } catch (error) { errors.push(error); }
    }
    if (agentDefinitionStoreOpened) {
      if (memoryEngineOpened) {
        memoryEngineOpened = false;
        try { await memoryEngine.close(); } catch (error) { errors.push(error); }
      }
      if (memoryStoreOpened) {
        memoryStoreOpened = false;
        try { await memoryStore.close(); } catch (error) { errors.push(error); }
      }
      agentDefinitionStoreOpened = false;
      try { await agentDefinitionStore.close(); } catch (error) { errors.push(error); }
    }
    if (memoryEngineOpened) {
      memoryEngineOpened = false;
      try { await memoryEngine.close(); } catch (error) { errors.push(error); }
    }
    if (memoryStoreOpened) {
      memoryStoreOpened = false;
      try { await memoryStore.close(); } catch (error) { errors.push(error); }
    }
    if (contextSnapshotStoreOpened) {
      contextSnapshotStoreOpened = false;
      try { await contextSnapshotStore.close(); } catch (error) { errors.push(error); }
    }
    if (nativeCronStoreOpened) {
      nativeCronStoreOpened = false;
      try { await nativeCronStore.close(); } catch (error) { errors.push(error); }
    }
    if (nativeKanbanStoreOpened) {
      nativeKanbanStoreOpened = false;
      try { await nativeKanbanStore.close(); } catch (error) { errors.push(error); }
    }
    if (permissionEngineOpened) {
      permissionEngineOpened = false;
      try { await permissionEngine.close(); } catch (error) {
        errors.push(error);
      }
    }
    if (nativeSkillStoreOpened) {
      nativeSkillStoreOpened = false;
      try { await nativeSkillStore.close(); } catch (error) { errors.push(error); }
    }
    if (computerUseControllerOpened) {
      computerUseControllerOpened = false;
      try { await computerUseController.close(); } catch (error) { errors.push(error); }
    }
    if (storeOpened) {
      if (tokenUsageStoreOpened) {
        tokenUsageStoreOpened = false;
        try { await tokenUsageStore.close(); } catch (error) { errors.push(error); }
      }
      storeOpened = false;
      try { productStore.close(); } catch (error) { errors.push(error); }
    }
    if (secretStoreOpened) {
      secretStoreOpened = false;
      try { await secretStore.close(); } catch (error) { errors.push(error); }
    }
    try {
      const tokenStat = cleanupLstatIfExists(paths.tokenPath);
      if (tokenStat && ownedTokenIdentity
        && tokenStat.dev === ownedTokenIdentity.dev && tokenStat.ino === ownedTokenIdentity.ino) {
        cleanupFs.unlinkSync(paths.tokenPath);
      }
    } catch (error) {
      errors.push(error);
    }
    ownedTokenIdentity = null;
    try {
      const socketStat = cleanupLstatIfExists(paths.socketPath);
      if (socketStat && ownedSocketIdentity
        && socketStat.dev === ownedSocketIdentity.dev && socketStat.ino === ownedSocketIdentity.ino) {
        cleanupFs.unlinkSync(paths.socketPath);
      }
    } catch (error) {
      errors.push(error);
    }
    ownedSocketIdentity = null;
    if (lockFd !== null) {
      const ownedFd = lockFd;
      lockFd = null;
      try { cleanupFs.closeSync(ownedFd); } catch (error) { errors.push(error); }
      try {
        const lockStat = cleanupLstatIfExists(paths.lockPath);
        if (lockStat && ownedLockIdentity
          && lockStat.dev === ownedLockIdentity.dev && lockStat.ino === ownedLockIdentity.ino) {
          cleanupFs.unlinkSync(paths.lockPath);
        }
      } catch (error) {
        errors.push(error);
      }
    }
    ownedLockIdentity = null;
    if (stopOptions.notify !== false && typeof options.onStop === "function") {
      try { await options.onStop(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) {
      const aggregate = new AggregateError(errors, "Service stop 未能完整清理");
      aggregate.code = "SERVICE_STOP_FAILED";
      throw aggregate;
    }
  }

  return api;
}

module.exports = {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  attachAcceptedSocketErrorGuard,
  createAgentService,
};
