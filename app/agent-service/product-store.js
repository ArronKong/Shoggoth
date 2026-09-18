"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { BUILTIN_CLI_AGENT_PROFILES } = require("./builtin-cli-profiles");
const {
  runtimeBinding,
  runtimeSessionRef,
  runtimeTurnRef,
} = require("./runtime-adapter");
const { runtimeAccountForLegacyProfile } = require("./runtime-account-migration");
const {
  DEFAULT_RUNTIME_ACCOUNTS,
  DEFAULT_RUNTIME_ACCOUNT_ID_BY_BACKEND,
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  normalizeLegacyRuntimeAccount,
  validateRuntimeAccount,
} = require("./runtime-account");

const STORE_SCHEMA_VERSION = 9;
const PROFILE_PROVIDER_AUTHORITY_SCHEMA_VERSION = 8;
const LEGACY_STORE_SCHEMA_VERSION = 1;
const PREVIOUS_STORE_SCHEMA_VERSION = 2;
const RICH_STORE_SCHEMA_VERSION = 3;
const GENERIC_RUNTIME_STORE_SCHEMA_VERSION = 4;
const PROFILE_BACKEND_MIGRATION_SOURCE_SCHEMA_VERSION = 5;
const RUNTIME_ACCOUNT_MIGRATION_SOURCE_SCHEMA_VERSION = 6;
const RUNTIME_ACCOUNT_STORE_SCHEMA_VERSION = 7;
const DEFAULT_AGENT_PROFILE_UUID = "f8a76c25-bd49-4c12-9d63-7b7d1eb1d0a4";
const DEFAULT_AGENT_PROFILE_ID = DEFAULT_AGENT_PROFILE_UUID;
const DEFAULT_AGENT_BACKEND_ID = "shoggoth";
const DEFAULT_AGENT_RUNTIME = "codex";
const DEFAULT_AGENT_ID = `shoggoth-${DEFAULT_AGENT_PROFILE_UUID}`;
const DEFAULT_RUNTIME_PROFILE_ID = DEFAULT_AGENT_ID;
const MAX_REGISTERED_SENSITIVE_VALUES = 1024;
const MAX_REGISTERED_SENSITIVE_VALUE_BYTES = 64 * 1024;
const MIN_REGISTERED_SENSITIVE_VALUE_BYTES = 8;
const APPROVAL_POLICIES = new Set(["untrusted", "on-failure", "on-request", "never"]);
const SANDBOX_POLICIES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const LEGACY_SNAPSHOT_FIELDS = Object.freeze([
  "schemaVersion", "lastSeq", "agentProfiles", "workRuns", "checksum",
]);
const PREVIOUS_SNAPSHOT_FIELDS = Object.freeze([
  "schemaVersion", "lastSeq", "modelProviders", "agentProfiles", "workRuns", "checksum",
]);
const PRE_RUNTIME_ACCOUNT_SNAPSHOT_FIELDS = Object.freeze([
  "schemaVersion", "lastSeq", "modelProviders", "agentProfiles", "workRuns", "runNotes",
  "mcpToolCalls", "checksum",
]);
const SNAPSHOT_FIELDS = Object.freeze([
  "schemaVersion", "lastSeq", "modelProviders", "runtimeAccounts", "runtimeAccountTombstones",
  "agentProfiles", "workRuns", "runNotes", "mcpToolCalls", "checksum",
]);
const LEGACY_AGENT_PROFILE_FIELDS = Object.freeze([
  "id", "backendId", "agentId", "name", "runtime", "runtimeProfileId",
  "providerRef", "defaultModel", "defaultCwd", "permissionPolicy", "concurrency",
  "isDefault", "enabled", "createdAt", "updatedAt",
]);
const AGENT_PROFILE_FIELDS = Object.freeze([
  "id", "backendId", "agentId", "name", "runtime", "runtimeProfileId",
  "runtimeAccountId", "providerRef", "defaultModel", "defaultCwd", "permissionPolicy", "concurrency",
  "isDefault", "enabled", "createdAt", "updatedAt",
]);
const WORK_RUN_FIELDS = Object.freeze([
  "id", "source", "sourceId", "idempotencyKey", "profileId", "workspace", "status",
  "contextSnapshotId", "runtimeSessionRef", "runtimeTurnRef", "eventSeq", "waitingRequestId", "startedAt",
  "finishedAt", "resultSummary", "errorCode", "retryOf",
]);
const GENERIC_RUNTIME_WORK_RUN_FIELDS = Object.freeze([
  "id", "source", "sourceId", "idempotencyKey", "profileId", "workspace", "status",
  "runtimeSessionRef", "runtimeTurnRef", "eventSeq", "waitingRequestId", "startedAt",
  "finishedAt", "resultSummary", "errorCode", "retryOf",
]);
const LEGACY_WORK_RUN_FIELDS = Object.freeze([
  "id", "source", "sourceId", "idempotencyKey", "profileId", "workspace", "status",
  "codexThreadId", "codexTurnId", "eventSeq", "waitingRequestId", "startedAt",
  "finishedAt", "resultSummary", "errorCode", "retryOf",
]);
const RUN_NOTE_FIELDS = Object.freeze([
  "id", "runId", "profileId", "kind", "cardId", "body", "percent", "createdAt",
]);
const MCP_TOOL_CALL_FIELDS = Object.freeze([
  "id", "profileId", "callId", "name", "fingerprint", "operationId", "binding", "createdAt",
  "status", "result",
]);
const RUN_NOTE_KINDS = new Set(["note", "progress"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const RUNTIME_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DEFAULT_RUNTIME_ACCOUNT_IDS = new Set(
  DEFAULT_RUNTIME_ACCOUNTS.map((account) => account.id),
);
const DEFAULT_RUNTIME_ACCOUNT_BY_ID = new Map(
  DEFAULT_RUNTIME_ACCOUNTS.map((account) => [account.id, account]),
);
const BACKEND_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const DEFAULT_MAX_RUN_NOTES = 10_000;
const DEFAULT_MAX_RUN_NOTES_PER_RUN = 1_000;
const MAX_RUN_NOTE_BODY_BYTES = 4096;
const DEFAULT_MAX_MCP_TOOL_CALLS = 4096;
const MAX_MCP_TOOL_CALL_RESULT_BYTES = 48 * 1024;
const DEFAULT_MAX_MCP_TOOL_RESULT_BYTES_TOTAL = 16 * 1024 * 1024;
const AGENT_LIFECYCLE_LEDGER_RETENTION_MS = 24 * 60 * 60 * 1000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MODEL_PROVIDER_FIELDS = Object.freeze([
  "id", "kind", "name", "baseUrl", "model", "credentialRef", "headers", "awsRegion",
  "awsProfile", "validationStatus",
]);
const LEGACY_MODEL_PROVIDER_FIELDS = Object.freeze([
  "id", "kind", "name", "baseUrl", "model", "credentialRef", "headers", "validationStatus",
]);
const MODEL_PROVIDER_KINDS = new Set([
  "chatgpt", "openai-api-key", "openrouter", "ollama", "lmstudio", "custom-responses",
  "amazon-bedrock",
]);
const MODEL_PROVIDER_VALIDATION_STATUSES = new Set([
  "unverified", "protocol_valid", "agent_compatible", "invalid",
]);
const CODEX_OWNED_CREDENTIAL_KINDS = new Set(["chatgpt", "amazon-bedrock"]);
const CUSTOM_ENDPOINT_PROVIDER_KINDS = new Set([
  "openrouter", "ollama", "lmstudio", "custom-responses",
]);
const FORBIDDEN_HEADER_NAMES = new Set([
  "authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key",
]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const WORK_RUN_SOURCES = new Set(["chat", "kanban", "cron", "inspiration"]);
const WORK_RUN_STATUSES = new Set([
  "queued", "starting", "running", "waiting_approval", "waiting_input",
  "completed", "failed", "canceled", "interrupted", "skipped",
]);
const ACTIVE_WORK_RUN_STATUSES = new Set([
  "starting", "running", "waiting_approval", "waiting_input",
]);
const HIGH_CONFIDENCE_SECRET_PATTERNS = Object.freeze([
  ["bearer", /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i],
  ["openai-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ["private-key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  [
    "secret-assignment",
    /\b(?:[a-z0-9]+[_-])*(?:token|api[_-]?key|secret(?:[_-]access[_-]key)?|authorization)\s*[:=]\s*["']?[^\s"']{8,}/i,
  ],
]);

function storeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function writeFully(fileSystem, fd, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = fileSystem.writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw storeError("STORE_WRITE_FAILED", "ProductStore 文件写入未取得进展");
    }
    offset += written;
  }
}

function normalizedKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function assertNoSensitiveFields(
  value,
  location = "payload",
  seen = new Set(),
  isRegisteredSensitiveValue = null,
) {
  if (typeof value === "string") {
    const match = HIGH_CONFIDENCE_SECRET_PATTERNS.find(([, pattern]) => pattern.test(value));
    if (match) throw storeError("STORE_SENSITIVE_VALUE", `拒绝持久化高置信 ${match[0]}: ${location}`);
    if (isRegisteredSensitiveValue?.(value)) {
      throw storeError("STORE_SENSITIVE_VALUE", `拒绝持久化已登记敏感值: ${location}`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw storeError("STORE_INVALID_VALUE", `${location} 不能包含循环引用`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveFields(
      item,
      `${location}[${index}]`,
      seen,
      isRegisteredSensitiveValue,
    ));
  } else {
    for (const [key, item] of Object.entries(value)) {
      const normalized = normalizedKey(key);
      // Durable onboarding binds only a one-way SHA-256 digest so a retry can prove
      // it supplied the same secret without persisting the secret itself. A
      // profile.bind call has no secret, but keeps the same durable binding
      // shape with an explicit null digest.
      const allowedSecretDigest = normalized === "secretdigest"
        && (item === null || (typeof item === "string" && SHA256_PATTERN.test(item)))
        && location.endsWith(".binding");
      if (!allowedSecretDigest && (normalized.includes("token") || normalized.includes("apikey")
        || normalized.includes("authorization") || normalized.includes("secret"))) {
        throw storeError("STORE_SENSITIVE_FIELD", `拒绝持久化敏感字段: ${location}.${key}`);
      }
      assertNoSensitiveFields(item, `${location}.${key}`, seen, isRegisteredSensitiveValue);
    }
  }
  seen.delete(value);
}

function requireString(value, field, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.length === 0) {
    throw storeError("STORE_INVALID_RECORD", `${field} 必须是非空字符串${nullable ? "或 null" : ""}`);
  }
}

function requireNullableTimestamp(value, field) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw storeError("STORE_INVALID_RECORD", `${field} 必须是非负安全整数或 null`);
  }
}

function assertJsonRoundTripStable(value, location = "payload", seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw storeError("STORE_INVALID_JSON", `${location} 必须是有限 JSON number`);
    return;
  }
  if (typeof value !== "object") {
    throw storeError("STORE_INVALID_JSON", `${location} 含不可持久化 JSON 值`);
  }
  if (seen.has(value)) throw storeError("STORE_INVALID_JSON", `${location} 含循环引用`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw storeError("STORE_INVALID_JSON", `${location} 不能包含 sparse array`);
      }
      assertJsonRoundTripStable(value[index], `${location}[${index}]`, seen);
    }
    if (Reflect.ownKeys(value).some((key) => key !== "length"
      && !(typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)))) {
      throw storeError("STORE_INVALID_JSON", `${location} 数组含非索引字段`);
    }
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw storeError("STORE_INVALID_JSON", `${location} 必须是 plain object`);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) {
      throw storeError("STORE_INVALID_JSON", `${location} 不能包含 symbol key`);
    }
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw storeError("STORE_INVALID_JSON", `${location}.${key} 必须是 enumerable data property`);
      }
      assertJsonRoundTripStable(descriptor.value, `${location}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function pickExact(record, fields, kind) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw storeError("STORE_INVALID_RECORD", `${kind} 必须是对象`);
  }
  const unknown = Object.keys(record).filter((key) => !fields.includes(key));
  if (unknown.length > 0) {
    throw storeError("STORE_INVALID_RECORD", `${kind} 含未知字段: ${unknown.join(", ")}`);
  }
  return Object.fromEntries(fields.map((field) => [field, clone(record[field] ?? null)]));
}

function validateAgentProfileShape(record, fields) {
  const profile = pickExact(record, fields, "AgentProfile");
  for (const field of ["id", "backendId", "agentId", "name", "runtime", "runtimeProfileId"]) {
    requireString(profile[field], `AgentProfile.${field}`);
  }
  if (fields.includes("runtimeAccountId")) {
    requireString(profile.runtimeAccountId, "AgentProfile.runtimeAccountId");
    if (!RUNTIME_ACCOUNT_ID_PATTERN.test(profile.runtimeAccountId)) {
      throw storeError("STORE_INVALID_RECORD", "AgentProfile.runtimeAccountId 无效");
    }
  }
  if (!BACKEND_ID_PATTERN.test(profile.backendId)) {
    throw storeError("STORE_INVALID_RECORD", "AgentProfile.backendId 无效");
  }
  if (fields.includes("runtimeAccountId")) {
    try {
      runtimeBinding({
        runtime: profile.runtime,
        runtimeProfileId: profile.runtimeProfileId,
        runtimeAccountId: profile.runtimeAccountId,
      });
    } catch {
      throw storeError("STORE_INVALID_RECORD", "AgentProfile Runtime binding 无效");
    }
  } else if (!/^[a-z][a-z0-9-]{0,63}$/u.test(profile.runtime)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(profile.runtimeProfileId)) {
    throw storeError("STORE_INVALID_RECORD", "AgentProfile Runtime binding 无效");
  }
  for (const field of ["providerRef", "defaultModel", "defaultCwd"]) {
    requireString(profile[field], `AgentProfile.${field}`, true);
  }
  if (!profile.permissionPolicy || typeof profile.permissionPolicy !== "object"
    || Array.isArray(profile.permissionPolicy)
    || Object.getPrototypeOf(profile.permissionPolicy) !== Object.prototype
    || Object.keys(profile.permissionPolicy).length !== 2
    || !Object.prototype.hasOwnProperty.call(profile.permissionPolicy, "approvalPolicy")
    || !Object.prototype.hasOwnProperty.call(profile.permissionPolicy, "sandbox")
    || !APPROVAL_POLICIES.has(profile.permissionPolicy.approvalPolicy)
    || !SANDBOX_POLICIES.has(profile.permissionPolicy.sandbox)) {
    throw storeError("STORE_INVALID_RECORD", "AgentProfile.permissionPolicy 无效");
  }
  if (!profile.concurrency || typeof profile.concurrency !== "object"
    || !Number.isSafeInteger(profile.concurrency.maxActive) || profile.concurrency.maxActive < 1
    || !Number.isSafeInteger(profile.concurrency.maxWorkspaceWrites)
    || profile.concurrency.maxWorkspaceWrites < 0) {
    throw storeError("STORE_INVALID_RECORD", "AgentProfile.concurrency 无效");
  }
  if (typeof profile.isDefault !== "boolean" || typeof profile.enabled !== "boolean") {
    throw storeError("STORE_INVALID_RECORD", "AgentProfile flags 必须是 boolean");
  }
  requireNullableTimestamp(profile.createdAt, "AgentProfile.createdAt");
  requireNullableTimestamp(profile.updatedAt, "AgentProfile.updatedAt");
  assertNoSensitiveFields(profile);
  return profile;
}

function validateAgentProfile(record) {
  return validateAgentProfileShape(record, AGENT_PROFILE_FIELDS);
}

function validateLegacyAgentProfile(record) {
  return validateAgentProfileShape(record, LEGACY_AGENT_PROFILE_FIELDS);
}

function builtinRuntimeAccountIdMatches(profile, spec) {
  if (!Object.prototype.hasOwnProperty.call(profile, "runtimeAccountId")) return true;
  return profile.runtimeAccountId === DEFAULT_RUNTIME_ACCOUNT_ID_BY_BACKEND[spec.backendId];
}

function builtinIdentityMatches(profile, spec, backendId = spec.backendId) {
  return profile.id === spec.id
    && profile.backendId === backendId
    && profile.agentId === spec.agentId
    && profile.runtime === spec.runtime
    && profile.runtimeProfileId === spec.runtimeProfileId
    && builtinRuntimeAccountIdMatches(profile, spec)
    && profile.isDefault === false;
}

function builtinRuntimeAccountBindingMatches(profile, account) {
  const backendAccountId = DEFAULT_RUNTIME_ACCOUNT_ID_BY_BACKEND[profile.backendId];
  const backendAccount = DEFAULT_RUNTIME_ACCOUNT_BY_ID.get(backendAccountId);
  if (backendAccount && backendAccount.runtime === profile.runtime) {
    return account.id === backendAccount.id
      && account.kind === backendAccount.kind
      && account.isDefault === true;
  }
  if (profile.runtime === "codex" && account.kind === "shoggoth-managed") {
    return account.id === SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID
      && account.isDefault === true;
  }
  const spec = BUILTIN_CLI_AGENT_PROFILES.find((candidate) => candidate.id === profile.id);
  if (!spec) return true;
  return account.id === DEFAULT_RUNTIME_ACCOUNT_ID_BY_BACKEND[spec.backendId]
    && account.kind === "native-user"
    && account.isDefault === true;
}

function runtimeAccountFromDisk(record, code, location, schemaVersion = STORE_SCHEMA_VERSION) {
  try {
    return schemaVersion < PROFILE_PROVIDER_AUTHORITY_SCHEMA_VERSION
      ? normalizeLegacyRuntimeAccount(record)
      : validateRuntimeAccount(record);
  } catch (error) {
    if (error?.code !== "RUNTIME_ACCOUNT_INVALID") throw error;
    throw storeError(code, `${location} 的 RuntimeAccount 无效: ${error.message}`);
  }
}

function canonicalLegacyRuntimeAccountId(profile, account) {
  const backendAccountId = DEFAULT_RUNTIME_ACCOUNT_ID_BY_BACKEND[profile.backendId];
  const backendAccount = DEFAULT_RUNTIME_ACCOUNT_BY_ID.get(backendAccountId);
  if (backendAccount && backendAccount.runtime === profile.runtime) return backendAccount.id;
  if (profile.runtime === "codex" && account?.kind === "shoggoth-managed") {
    return SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID;
  }
  return profile.runtimeAccountId;
}

function agentProfileFromDisk(record, schemaVersion) {
  if (schemaVersion >= RUNTIME_ACCOUNT_STORE_SCHEMA_VERSION) {
    return { profile: validateAgentProfile(record), runtimeAccount: null };
  }
  let profile = validateLegacyAgentProfile(record);
  if (schemaVersion === PROFILE_BACKEND_MIGRATION_SOURCE_SCHEMA_VERSION) {
    const spec = BUILTIN_CLI_AGENT_PROFILES.find((candidate) => candidate.id === profile.id);
    // schema v5 only predates the Codex/Grok backend split. Later built-ins must
    // not be reinterpreted as legacy Shoggoth-owned profiles when reading a v5 fixture.
    if (spec && ["codex", "grok-build"].includes(spec.runtime)) {
      if (!builtinIdentityMatches(profile, spec, "shoggoth")) {
        throw storeError(
          "STORE_PROFILE_MIGRATION_CONFLICT",
          `schema v5 内置 AgentProfile 身份冲突: ${spec.name}`,
        );
      }
      profile = validateLegacyAgentProfile({ ...profile, backendId: spec.backendId });
    }
  }
  const migrated = runtimeAccountForLegacyProfile(profile);
  return {
    profile: validateAgentProfile({ ...profile, runtimeAccountId: migrated.runtimeAccountId }),
    runtimeAccount: migrated.account,
  };
}

function byteLengthWithin(value, max) {
  return Buffer.byteLength(value, "utf8") <= max;
}

function isWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validateModelProvider(record) {
  const provider = pickExact(record, MODEL_PROVIDER_FIELDS, "ModelProvider");
  for (const field of ["id", "kind", "name", "validationStatus"]) {
    requireString(provider[field], `ModelProvider.${field}`);
  }
  requireString(provider.model, "ModelProvider.model", true);
  if (provider.id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider.id)) {
    throw storeError("STORE_INVALID_RECORD", "ModelProvider.id 必须是有界稳定 ID");
  }
  if (!MODEL_PROVIDER_KINDS.has(provider.kind)) {
    throw storeError("STORE_INVALID_RECORD", "ModelProvider.kind 不受支持");
  }
  if (!MODEL_PROVIDER_VALIDATION_STATUSES.has(provider.validationStatus)) {
    throw storeError("STORE_INVALID_RECORD", "ModelProvider.validationStatus 不受支持");
  }
  if (!byteLengthWithin(provider.name, 512) || !isWellFormedUnicode(provider.name)
    || (provider.model !== null
      && (!byteLengthWithin(provider.model, 1024) || !isWellFormedUnicode(provider.model)))) {
    throw storeError("STORE_INVALID_RECORD", "ModelProvider name/model 超出长度限制");
  }
  requireString(provider.baseUrl, "ModelProvider.baseUrl", true);
  if (CUSTOM_ENDPOINT_PROVIDER_KINDS.has(provider.kind)) {
    if (provider.baseUrl === null || !byteLengthWithin(provider.baseUrl, 4096)
      || !isWellFormedUnicode(provider.baseUrl)
      || /[\u0000-\u001f\u007f]/u.test(provider.baseUrl)) {
      throw storeError("STORE_INVALID_RECORD", "custom ModelProvider.baseUrl 无效");
    }
    let parsed;
    try { parsed = new URL(provider.baseUrl); } catch {
      throw storeError("STORE_INVALID_RECORD", "custom ModelProvider.baseUrl 无效");
    }
    if (!new Set(["http:", "https:"]).has(parsed.protocol) || !parsed.hostname
      || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw storeError("STORE_INVALID_RECORD", "custom ModelProvider.baseUrl 无效");
    }
  } else if (provider.baseUrl !== null) {
    throw storeError("STORE_INVALID_RECORD", "authority ModelProvider.baseUrl 必须为 null");
  }
  requireString(provider.credentialRef, "ModelProvider.credentialRef", true);
  if (provider.credentialRef !== null
    && (provider.credentialRef.length > 128
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(provider.credentialRef))) {
    throw storeError("STORE_INVALID_RECORD", "ModelProvider.credentialRef 必须是 opaque ID");
  }
  if (CODEX_OWNED_CREDENTIAL_KINDS.has(provider.kind) && provider.credentialRef !== null) {
    throw storeError("STORE_INVALID_RECORD", "该 ModelProvider kind 的凭据只能由 Codex/AWS authority 管理");
  }
  requireString(provider.awsRegion, "ModelProvider.awsRegion", true);
  requireString(provider.awsProfile, "ModelProvider.awsProfile", true);
  if (provider.kind === "amazon-bedrock") {
    if (provider.awsRegion === null || provider.awsRegion.length > 64
      || !/^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/u.test(provider.awsRegion)) {
      throw storeError("STORE_INVALID_RECORD", "Amazon Bedrock awsRegion 无效");
    }
    if (provider.awsProfile !== null && (provider.awsProfile.length > 128
      || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(provider.awsProfile))) {
      throw storeError("STORE_INVALID_RECORD", "Amazon Bedrock awsProfile 无效");
    }
  } else if (provider.awsRegion !== null || provider.awsProfile !== null) {
    throw storeError("STORE_INVALID_RECORD", "非 Bedrock ModelProvider 不允许 AWS 字段");
  }
  if (provider.headers !== null) {
    if (typeof provider.headers !== "object" || Array.isArray(provider.headers)
      || Object.getPrototypeOf(provider.headers) !== Object.prototype
      || Object.keys(provider.headers).length > 32) {
      throw storeError("STORE_INVALID_RECORD", "ModelProvider.headers 必须是最多 32 项的 plain object");
    }
    for (const [name, value] of Object.entries(provider.headers)) {
      const normalized = normalizedKey(name);
      if (!HEADER_NAME_PATTERN.test(name) || !byteLengthWithin(name, 128)
        || !isWellFormedUnicode(name)
        || FORBIDDEN_HEADER_NAMES.has(name.toLowerCase())
        || normalized.includes("apikey") || normalized.includes("token")
        || normalized.includes("secret") || normalized.includes("credential")
        || typeof value !== "string" || !byteLengthWithin(value, 4096)
        || !isWellFormedUnicode(value)
        || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw storeError("STORE_INVALID_RECORD", "ModelProvider.headers 含非法或敏感 header");
      }
    }
  }
  assertNoSensitiveFields(provider);
  return provider;
}

function migrateLegacyModelProvider(record) {
  const legacy = pickExact(record, LEGACY_MODEL_PROVIDER_FIELDS, "legacy ModelProvider");
  if (!["unverified", "valid", "invalid"].includes(legacy.validationStatus)) {
    throw storeError("STORE_INVALID_RECORD", "legacy ModelProvider.validationStatus 不受支持");
  }
  return validateModelProvider({
    ...legacy,
    credentialRef: legacy.kind === "ollama" || legacy.kind === "lmstudio"
      ? null : legacy.credentialRef,
    awsRegion: legacy.kind === "amazon-bedrock" ? "us-east-1" : null,
    awsProfile: null,
    validationStatus: legacy.validationStatus === "invalid" ? "invalid" : "unverified",
  });
}

function modelProviderFromDisk(record, schemaVersion) {
  return schemaVersion === LEGACY_STORE_SCHEMA_VERSION
    ? migrateLegacyModelProvider(record)
    : validateModelProvider(record);
}

function validateWorkRun(record) {
  const run = pickExact(record, WORK_RUN_FIELDS, "WorkRun");
  for (const field of ["id", "source", "sourceId", "idempotencyKey", "profileId", "status"]) {
    requireString(run[field], `WorkRun.${field}`);
  }
  requireString(run.contextSnapshotId, "WorkRun.contextSnapshotId", true);
  if (run.contextSnapshotId !== null && !/^ctx-[a-f0-9]{64}$/u.test(run.contextSnapshotId)) {
    throw storeError("STORE_INVALID_RECORD", "WorkRun.contextSnapshotId 无效");
  }
  if (!WORK_RUN_SOURCES.has(run.source) || !WORK_RUN_STATUSES.has(run.status)) {
    throw storeError("STORE_INVALID_RECORD", "WorkRun.source/status 不受支持");
  }
  if (run.workspace !== null
    && (typeof run.workspace !== "string" || run.workspace.trim().length === 0)) {
    throw storeError("STORE_INVALID_RECORD", "WorkRun.workspace 必须是非空路径字符串或 null");
  }
  for (const field of [
    "waitingRequestId", "resultSummary", "errorCode", "retryOf",
  ]) requireString(run[field], `WorkRun.${field}`, true);
  try {
    if (run.runtimeSessionRef !== null) run.runtimeSessionRef = runtimeSessionRef(
      {
        runtime: run.runtimeSessionRef.runtime,
        runtimeProfileId: run.runtimeSessionRef.runtimeProfileId,
        runtimeAccountId: run.runtimeSessionRef.runtimeAccountId,
      },
      run.runtimeSessionRef.sessionId,
    );
    if (run.runtimeTurnRef !== null) run.runtimeTurnRef = runtimeTurnRef(
      {
        runtime: run.runtimeTurnRef.runtime,
        runtimeProfileId: run.runtimeTurnRef.runtimeProfileId,
        runtimeAccountId: run.runtimeTurnRef.runtimeAccountId,
      },
      run.runtimeTurnRef.sessionId,
      run.runtimeTurnRef.turnId,
    );
  } catch {
    throw storeError("STORE_INVALID_RECORD", "WorkRun Runtime ref 无效");
  }
  if (run.runtimeTurnRef !== null && (run.runtimeSessionRef === null
    || run.runtimeTurnRef.runtime !== run.runtimeSessionRef.runtime
    || run.runtimeTurnRef.runtimeProfileId !== run.runtimeSessionRef.runtimeProfileId
    || run.runtimeTurnRef.runtimeAccountId !== run.runtimeSessionRef.runtimeAccountId
    || run.runtimeTurnRef.sessionId !== run.runtimeSessionRef.sessionId)) {
    throw storeError("STORE_INVALID_RECORD", "WorkRun.runtimeTurnRef 需要匹配 runtimeSessionRef");
  }
  if (!Number.isSafeInteger(run.eventSeq) || run.eventSeq < 1) {
    throw storeError("STORE_INVALID_RECORD", "WorkRun.eventSeq 必须是正安全整数");
  }
  requireNullableTimestamp(run.startedAt, "WorkRun.startedAt");
  requireNullableTimestamp(run.finishedAt, "WorkRun.finishedAt");
  const terminal = !ACTIVE_WORK_RUN_STATUSES.has(run.status) && run.status !== "queued";
  const waiting = run.status === "waiting_approval" || run.status === "waiting_input";
  if (run.status === "queued"
    && (run.startedAt !== null || run.finishedAt !== null || run.waitingRequestId !== null)) {
    throw storeError("STORE_INVALID_RECORD", "queued WorkRun 时间/等待字段无效");
  }
  if (ACTIVE_WORK_RUN_STATUSES.has(run.status)
    && (run.startedAt === null || run.finishedAt !== null)) {
    throw storeError("STORE_INVALID_RECORD", "active WorkRun 时间字段无效");
  }
  if ((waiting && run.waitingRequestId === null) || (!waiting && run.waitingRequestId !== null)) {
    throw storeError("STORE_INVALID_RECORD", "WorkRun.waitingRequestId 与 status 不匹配");
  }
  if (terminal && (run.finishedAt === null
    || (run.startedAt !== null && run.finishedAt < run.startedAt))) {
    throw storeError("STORE_INVALID_RECORD", "terminal WorkRun 时间字段无效");
  }
  const needsError = run.status === "failed" || run.status === "interrupted";
  if ((needsError && run.errorCode === null) || (!needsError && run.errorCode !== null)) {
    throw storeError("STORE_INVALID_RECORD", "WorkRun.errorCode 与 status 不匹配");
  }
  assertNoSensitiveFields(run);
  return run;
}

function migrateLegacyWorkRun(record, profile) {
  const legacy = pickExact(record, LEGACY_WORK_RUN_FIELDS, "legacy WorkRun");
  if (!profile || profile.id !== legacy.profileId) {
    throw storeError("STORE_INVALID_RECORD", "legacy WorkRun 缺少 Runtime profile");
  }
  const binding = runtimeBinding({
    runtime: profile.runtime,
    runtimeProfileId: profile.runtimeProfileId,
    runtimeAccountId: profile.runtimeAccountId,
  });
  const current = Object.fromEntries(WORK_RUN_FIELDS.map((field) => [field, legacy[field] ?? null]));
  current.runtimeSessionRef = legacy.codexThreadId === null
    ? null : runtimeSessionRef(binding, legacy.codexThreadId);
  current.runtimeTurnRef = legacy.codexTurnId === null
    ? null : runtimeTurnRef(binding, legacy.codexThreadId, legacy.codexTurnId);
  return validateWorkRun(current);
}

function migrateRuntimeRefs(record, profile) {
  if (!profile || profile.id !== record.profileId) {
    throw storeError("STORE_INVALID_RECORD", "WorkRun 缺少 Runtime profile");
  }
  let binding;
  try {
    binding = runtimeBinding({
      runtime: profile.runtime,
      runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId,
    });
  } catch {
    throw storeError("STORE_INVALID_RECORD", "WorkRun Runtime profile 无效");
  }
  const migrateRef = (ref, turn = false) => {
    if (ref === null) return null;
    const fields = turn
      ? ["runtime", "runtimeProfileId", "sessionId", "turnId"]
      : ["runtime", "runtimeProfileId", "sessionId"];
    const legacy = pickExact(ref, fields, turn ? "RuntimeTurnRef v1" : "RuntimeSessionRef v1");
    if (legacy.runtime !== binding.runtime
      || legacy.runtimeProfileId !== binding.runtimeProfileId) {
      throw storeError("STORE_INVALID_RECORD", "WorkRun Runtime ref 与 Profile 不匹配");
    }
    try {
      return turn
        ? runtimeTurnRef(binding, legacy.sessionId, legacy.turnId)
        : runtimeSessionRef(binding, legacy.sessionId);
    } catch {
      throw storeError("STORE_INVALID_RECORD", "WorkRun Runtime ref 无效");
    }
  };
  return {
    ...record,
    runtimeSessionRef: migrateRef(record.runtimeSessionRef),
    runtimeTurnRef: migrateRef(record.runtimeTurnRef, true),
  };
}

function migrateGenericRuntimeWorkRun(record, profile) {
  const previous = pickExact(record, GENERIC_RUNTIME_WORK_RUN_FIELDS, "schema v4 WorkRun");
  return validateWorkRun(migrateRuntimeRefs({ ...previous, contextSnapshotId: null }, profile));
}

function migrateRuntimeAccountWorkRun(record, profile) {
  const previous = pickExact(record, WORK_RUN_FIELDS, "schema v5-v7 WorkRun");
  return validateWorkRun(migrateRuntimeRefs(previous, profile));
}

function workRunFromDisk(record, schemaVersion, profile) {
  if (schemaVersion < GENERIC_RUNTIME_STORE_SCHEMA_VERSION) {
    return migrateLegacyWorkRun(record, profile);
  }
  if (schemaVersion === GENERIC_RUNTIME_STORE_SCHEMA_VERSION) {
    return migrateGenericRuntimeWorkRun(record, profile);
  }
  if (schemaVersion < PROFILE_PROVIDER_AUTHORITY_SCHEMA_VERSION) {
    return migrateRuntimeAccountWorkRun(record, profile);
  }
  return validateWorkRun(record);
}

function sameRuntimeRef(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function withLegacyWorkRunProjection(run) {
  if (run === null) return null;
  Object.defineProperties(run, {
    codexThreadId: {
      configurable: false,
      enumerable: false,
      get: () => run.runtimeSessionRef?.sessionId ?? null,
    },
    codexTurnId: {
      configurable: false,
      enumerable: false,
      get: () => run.runtimeTurnRef?.turnId ?? null,
    },
  });
  return run;
}

function workRunView(run) {
  return run === null || run === undefined ? null : withLegacyWorkRunProjection(clone(run));
}

function validateRunNote(record) {
  const note = pickExact(record, RUN_NOTE_FIELDS, "RunNote");
  for (const field of ["id", "runId", "profileId", "kind", "body"]) {
    requireString(note[field], `RunNote.${field}`);
  }
  if (note.id.length > 128 || !OPAQUE_ID_PATTERN.test(note.id)
    || note.runId.length > 256 || !OPAQUE_ID_PATTERN.test(note.runId)
    || note.profileId.length > 128 || !OPAQUE_ID_PATTERN.test(note.profileId)
    || !RUN_NOTE_KINDS.has(note.kind)
    || !isWellFormedUnicode(note.body) || note.body.includes("\0")
    || !byteLengthWithin(note.body, MAX_RUN_NOTE_BODY_BYTES)
    || !Number.isSafeInteger(note.createdAt) || note.createdAt < 0) {
    throw storeError("STORE_INVALID_RECORD", "RunNote 字段无效");
  }
  if (note.kind === "note") {
    if (note.cardId !== null || note.percent !== null) {
      throw storeError("STORE_INVALID_RECORD", "note RunNote 不允许 cardId/percent");
    }
  } else if (!UUID_PATTERN.test(note.cardId)
    || !(note.percent === null
      || (Number.isSafeInteger(note.percent) && note.percent >= 0 && note.percent <= 100))) {
    throw storeError("STORE_INVALID_RECORD", "progress RunNote cardId/percent 无效");
  }
  assertNoSensitiveFields(note);
  return note;
}

function mcpToolCallIdentity(profileId, callId) {
  return `mcp-call-${crypto.createHash("sha256")
    .update(profileId).update("\0").update(callId).digest("hex").slice(0, 48)}`;
}

function mcpToolOperationId(profileId, callId, name, fingerprint) {
  return `mcp-v1-${crypto.createHash("sha256")
    .update(profileId).update("\0").update(callId).update("\0").update(name)
    .update("\0").update(fingerprint).digest("hex").slice(0, 48)}`;
}

function validateMcpToolCall(record) {
  const call = pickExact(record, MCP_TOOL_CALL_FIELDS, "McpToolCall");
  for (const field of ["id", "profileId", "callId", "name", "fingerprint", "operationId", "status"]) {
    requireString(call[field], `McpToolCall.${field}`);
  }
  if (call.profileId.length > 128 || !OPAQUE_ID_PATTERN.test(call.profileId)
    || !UUID_PATTERN.test(call.callId) || call.name.length > 64
    || !OPAQUE_ID_PATTERN.test(call.name) || !SHA256_PATTERN.test(call.fingerprint)
    || call.id !== mcpToolCallIdentity(call.profileId, call.callId)
    || call.operationId !== mcpToolOperationId(
      call.profileId, call.callId, call.name, call.fingerprint,
    )
    || !(call.binding === null || (call.binding && typeof call.binding === "object"
      && !Array.isArray(call.binding) && Object.getPrototypeOf(call.binding) === Object.prototype))
    || !Number.isSafeInteger(call.createdAt) || call.createdAt < 0
    || (call.status !== "pending" && call.status !== "completed")) {
    throw storeError("STORE_INVALID_RECORD", "McpToolCall 字段无效");
  }
  if (call.binding !== null) {
    assertJsonRoundTripStable(call.binding, "McpToolCall.binding");
    if (Buffer.byteLength(JSON.stringify(call.binding), "utf8") > 4096) {
      throw storeError("STORE_INVALID_RECORD", "McpToolCall binding 超过容量");
    }
  }
  if (call.status === "pending") {
    if (call.result !== null) throw storeError("STORE_INVALID_RECORD", "pending McpToolCall result 必须为空");
  } else {
    if (!call.result || typeof call.result !== "object" || Array.isArray(call.result)
      || Object.getPrototypeOf(call.result) !== Object.prototype
      || !["ok", call.result.ok === true ? "result" : "publicCode"]
        .every((field) => Object.prototype.hasOwnProperty.call(call.result, field))
      || Object.keys(call.result).length !== 2 || typeof call.result.ok !== "boolean"
      || (call.result.ok === true
        ? !call.result.result || typeof call.result.result !== "object"
          || Array.isArray(call.result.result)
          || Object.getPrototypeOf(call.result.result) !== Object.prototype
        : typeof call.result.publicCode !== "string"
          || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(call.result.publicCode))) {
      throw storeError("STORE_INVALID_RECORD", "completed McpToolCall result 无效");
    }
    assertJsonRoundTripStable(call.result, "McpToolCall.result");
    if (Buffer.byteLength(JSON.stringify(call.result), "utf8") > MAX_MCP_TOOL_CALL_RESULT_BYTES) {
      throw storeError("STORE_INVALID_RECORD", "McpToolCall result 超过容量");
    }
  }
  assertNoSensitiveFields(call);
  return call;
}

function envelopeBody(event) {
  return {
    schemaVersion: event.schemaVersion,
    seq: event.seq,
    aggregateId: event.aggregateId,
    type: event.type,
    time: event.time,
    payload: event.payload,
  };
}

function eventChecksum(event) {
  return crypto.createHash("sha256").update(JSON.stringify(envelopeBody(event))).digest("hex");
}

function snapshotBody(snapshot) {
  if (Object.prototype.hasOwnProperty.call(snapshot, "runtimeAccounts")) {
    return {
      schemaVersion: snapshot.schemaVersion,
      lastSeq: snapshot.lastSeq,
      modelProviders: snapshot.modelProviders,
      runtimeAccounts: snapshot.runtimeAccounts,
      runtimeAccountTombstones: snapshot.runtimeAccountTombstones,
      agentProfiles: snapshot.agentProfiles,
      workRuns: snapshot.workRuns,
      runNotes: snapshot.runNotes,
      mcpToolCalls: snapshot.mcpToolCalls,
    };
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, "mcpToolCalls")) {
    return {
      schemaVersion: snapshot.schemaVersion,
      lastSeq: snapshot.lastSeq,
      modelProviders: snapshot.modelProviders,
      agentProfiles: snapshot.agentProfiles,
      workRuns: snapshot.workRuns,
      runNotes: snapshot.runNotes,
      mcpToolCalls: snapshot.mcpToolCalls,
    };
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, "runNotes")) {
    return {
      schemaVersion: snapshot.schemaVersion,
      lastSeq: snapshot.lastSeq,
      modelProviders: snapshot.modelProviders,
      agentProfiles: snapshot.agentProfiles,
      workRuns: snapshot.workRuns,
      runNotes: snapshot.runNotes,
    };
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, "modelProviders")) {
    return {
      schemaVersion: snapshot.schemaVersion,
      lastSeq: snapshot.lastSeq,
      modelProviders: snapshot.modelProviders,
      agentProfiles: snapshot.agentProfiles,
      workRuns: snapshot.workRuns,
    };
  }
  return {
    schemaVersion: snapshot.schemaVersion,
    lastSeq: snapshot.lastSeq,
    agentProfiles: snapshot.agentProfiles,
    workRuns: snapshot.workRuns,
  };
}

function snapshotChecksum(snapshot) {
  return crypto.createHash("sha256").update(JSON.stringify(snapshotBody(snapshot))).digest("hex");
}

function defaultAgentProfileIdentityMatches(profile) {
  return profile.id === DEFAULT_AGENT_PROFILE_ID
    && profile.backendId === DEFAULT_AGENT_BACKEND_ID
    && profile.agentId === DEFAULT_AGENT_ID
    && profile.runtime === DEFAULT_AGENT_RUNTIME
    && profile.runtimeProfileId === DEFAULT_RUNTIME_PROFILE_ID
    && profile.runtimeAccountId === SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID
    && profile.isDefault === true;
}

function defaultAgentProfile(now) {
  return {
    id: DEFAULT_AGENT_PROFILE_ID,
    backendId: DEFAULT_AGENT_BACKEND_ID,
    agentId: DEFAULT_AGENT_ID,
    name: "Shoggoth",
    runtime: DEFAULT_AGENT_RUNTIME,
    runtimeProfileId: DEFAULT_RUNTIME_PROFILE_ID,
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    providerRef: null,
    defaultModel: null,
    defaultCwd: null,
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "danger-full-access" },
    concurrency: { maxActive: 1, maxWorkspaceWrites: 1 },
    isDefault: true,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

class ProductStore {
  open() { throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.open 未实现"); }
  close() { throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.close 未实现"); }
  setSensitiveValueMatcher() {
    throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.setSensitiveValueMatcher 未实现");
  }
  setSensitiveValueMatcherSessionFactory() {
    throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.setSensitiveValueMatcherSessionFactory 未实现");
  }
  listAgentProfiles() { throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.listAgentProfiles 未实现"); }
  getAgentProfile() { throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.getAgentProfile 未实现"); }
  putAgentProfile() { throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.putAgentProfile 未实现"); }
  listRuntimeAccounts() { throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.listRuntimeAccounts 未实现"); }
  getRuntimeAccount() { throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.getRuntimeAccount 未实现"); }
  putRuntimeAccount() { throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.putRuntimeAccount 未实现"); }
  deleteRuntimeAccount() { throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.deleteRuntimeAccount 未实现"); }
  listModelProviders() { throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.listModelProviders 未实现"); }
  getModelProvider() { throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.getModelProvider 未实现"); }
  putModelProvider() { throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.putModelProvider 未实现"); }
  deleteModelProvider() { throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.deleteModelProvider 未实现"); }
  listWorkRuns() { throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.listWorkRuns 未实现"); }
  getWorkRun() { throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.getWorkRun 未实现"); }
  getWorkRunByIdempotencyKey() {
    throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.getWorkRunByIdempotencyKey 未实现");
  }
  putWorkRun() { throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.putWorkRun 未实现"); }
  listRunNotes() { throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.listRunNotes 未实现"); }
  getRunNote() { throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.getRunNote 未实现"); }
  addRunNote() { throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.addRunNote 未实现"); }
  listMcpToolCalls() {
    throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.listMcpToolCalls 未实现");
  }
  getMcpToolCall() {
    throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.getMcpToolCall 未实现");
  }
  lookupMcpToolCall() {
    throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.lookupMcpToolCall 未实现");
  }
  beginMcpToolCall() {
    throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.beginMcpToolCall 未实现");
  }
  completeMcpToolCall() {
    throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.completeMcpToolCall 未实现");
  }
  recoverActiveRunAfterServiceRestart() {
    throw storeError("STORE_NOT_IMPLEMENTED", "ProductStore.recoverActiveRunAfterServiceRestart 未实现");
  }
}

class JsonlProductStore extends ProductStore {
  constructor(options = {}) {
    super();
    if (!options.paths?.stateDir || !options.paths?.stateSnapshotPath || !options.paths?.eventLogPath) {
      throw storeError("STORE_PATHS_REQUIRED", "ProductStore 需要完整 Service paths");
    }
    this.paths = options.paths;
    this.fs = options.fs || fs;
    this.now = options.now || Date.now;
    this.maxRunNotes = options.maxRunNotes ?? DEFAULT_MAX_RUN_NOTES;
    this.maxRunNotesPerRun = options.maxRunNotesPerRun ?? DEFAULT_MAX_RUN_NOTES_PER_RUN;
    this.maxMcpToolCalls = options.maxMcpToolCalls ?? DEFAULT_MAX_MCP_TOOL_CALLS;
    this.maxMcpToolResultBytesTotal = options.maxMcpToolResultBytesTotal
      ?? DEFAULT_MAX_MCP_TOOL_RESULT_BYTES_TOTAL;
    if (!Number.isSafeInteger(this.maxRunNotes) || this.maxRunNotes < 1
      || this.maxRunNotes > DEFAULT_MAX_RUN_NOTES
      || !Number.isSafeInteger(this.maxRunNotesPerRun) || this.maxRunNotesPerRun < 1
      || this.maxRunNotesPerRun > DEFAULT_MAX_RUN_NOTES_PER_RUN
      || this.maxRunNotesPerRun > this.maxRunNotes
      || !Number.isSafeInteger(this.maxMcpToolCalls) || this.maxMcpToolCalls < 1
      || this.maxMcpToolCalls > DEFAULT_MAX_MCP_TOOL_CALLS
      || !Number.isSafeInteger(this.maxMcpToolResultBytesTotal)
      || this.maxMcpToolResultBytesTotal < 1
      || this.maxMcpToolResultBytesTotal > DEFAULT_MAX_MCP_TOOL_RESULT_BYTES_TOTAL) {
      throw storeError("STORE_INVALID_OPTIONS", "RunNote 容量配置无效");
    }
    if (options.isSensitiveValue !== undefined && typeof options.isSensitiveValue !== "function") {
      throw storeError("STORE_INVALID_OPTIONS", "isSensitiveValue 必须是函数");
    }
    this.sensitiveValueBuffers = [];
    if (options.sensitiveValues !== undefined) {
      if (typeof options.sensitiveValues === "string"
        || options.sensitiveValues === null
        || typeof options.sensitiveValues[Symbol.iterator] !== "function") {
        throw storeError("STORE_INVALID_OPTIONS", "sensitiveValues 必须是字符串集合");
      }
      for (const value of options.sensitiveValues) {
        if (typeof value !== "string") {
          throw storeError("STORE_INVALID_OPTIONS", "sensitiveValues 只能包含字符串");
        }
        const bytes = Buffer.from(value, "utf8");
        if (bytes.length < MIN_REGISTERED_SENSITIVE_VALUE_BYTES
          || bytes.length > MAX_REGISTERED_SENSITIVE_VALUE_BYTES
          || this.sensitiveValueBuffers.length >= MAX_REGISTERED_SENSITIVE_VALUES) {
          throw storeError("STORE_INVALID_OPTIONS", "sensitiveValues 超出安全容量限制");
        }
        this.sensitiveValueBuffers.push(bytes);
      }
    }
    this.isSensitiveValue = options.isSensitiveValue || null;
    this.requiredSensitiveValueMatcher = null;
    this.sensitiveValueMatcherSessionFactory = null;
    this.activeSensitiveValueMatcher = null;
    this.opened = false;
    this.commitUncertain = false;
    this.lastEventSeq = 0;
    this.loadedLegacySnapshot = false;
    this.sawProviderEvent = false;
    this.pendingLegacyRuntimeAccountCanonicalization = false;
    this.legacyRuntimeAccountSource = null;
    this.legacyRuntimeAccountIds = new Set();
    this.legacyRuntimeAccountIdsToReclaim = new Set();
    this.legacyRuntimeAccountAliases = new Map();
    this.runtimeAccountAuthorityStarted = false;
    this.currentSchemaAuthorityStarted = false;
    this.profileProviderAuthorityStarted = false;
    this.modelProviders = new Map();
    this.runtimeAccounts = new Map();
    this.runtimeAccountTombstones = new Map();
    this.agentProfiles = new Map();
    this.workRuns = new Map();
    this.workRunIdempotency = new Map();
    this.runNotes = new Map();
    this.mcpToolCalls = new Map();
  }

  open() {
    if (this.opened) return this;
    this.fs.mkdirSync(this.paths.stateDir, { recursive: true, mode: 0o700 });
    this.agentProfiles.clear();
    this.modelProviders.clear();
    this.runtimeAccounts.clear();
    this.runtimeAccountTombstones.clear();
    this.workRuns.clear();
    this.workRunIdempotency.clear();
    this.runNotes.clear();
    this.mcpToolCalls.clear();
    this.lastEventSeq = 0;
    this.commitUncertain = false;
    this.loadedLegacySnapshot = false;
    this.sawProviderEvent = false;
    this.pendingLegacyRuntimeAccountCanonicalization = false;
    this.legacyRuntimeAccountSource = null;
    this.legacyRuntimeAccountIds.clear();
    this.legacyRuntimeAccountIdsToReclaim.clear();
    this.legacyRuntimeAccountAliases.clear();
    this.runtimeAccountAuthorityStarted = false;
    this.currentSchemaAuthorityStarted = false;
    this.profileProviderAuthorityStarted = false;
    this.#readSnapshot();
    this.#ensureDefaultRuntimeAccounts();
    this.#replayEventLog();
    this.#finishLegacyRuntimeAccountCanonicalization();
    this.legacyRuntimeAccountAliases.clear();
    this.#assertAllReferences();
    this.opened = true;
    if (!this.agentProfiles.has(DEFAULT_AGENT_PROFILE_ID)) {
      this.putAgentProfile(defaultAgentProfile(this.now()));
    }
    return this;
  }

  close() {
    if (!this.opened) return;
    if (this.commitUncertain) {
      this.opened = false;
      return;
    }
    this.#writeSnapshot();
    this.opened = false;
  }

  setSensitiveValueMatcher(matcher) {
    if (typeof matcher !== "function") {
      throw storeError("STORE_INVALID_OPTIONS", "敏感值 matcher 必须是函数");
    }
    this.requiredSensitiveValueMatcher = matcher;
    return this;
  }

  setSensitiveValueMatcherSessionFactory(factory) {
    if (typeof factory !== "function") {
      throw storeError("STORE_INVALID_OPTIONS", "敏感值 matcher session factory 必须是函数");
    }
    this.sensitiveValueMatcherSessionFactory = factory;
    return this;
  }

  listRuntimeAccounts() {
    this.#assertOpen();
    return [...this.runtimeAccounts.values()].map(clone);
  }

  getRuntimeAccount(id) {
    this.#assertOpen();
    return clone(this.runtimeAccounts.get(id) || null);
  }

  putRuntimeAccount(input) {
    return this.#withSensitiveValueMatcher(() => this.#putRuntimeAccount(input));
  }

  #putRuntimeAccount(input) {
    this.#assertOpen();
    this.#assertNoSensitiveFields(input);
    assertJsonRoundTripStable(input);
    const existing = typeof input?.id === "string" ? this.runtimeAccounts.get(input.id) : null;
    const tombstone = existing || typeof input?.id !== "string"
      ? null
      : this.runtimeAccountTombstones.get(input.id) || null;
    const time = this.now();
    const candidate = validateRuntimeAccount({
      ...input,
      createdAt: existing
        ? existing.createdAt
        : tombstone
          ? tombstone.createdAt
          : (input.createdAt ?? time),
      updatedAt: existing
        ? Math.max(time, (existing.updatedAt ?? -1) + 1)
        : tombstone
          ? Math.max(time, (tombstone.updatedAt ?? -1) + 1)
          : (input.updatedAt ?? time),
    });
    this.#assertRuntimeAccountIdentityImmutable(
      existing || tombstone,
      candidate,
      "RUNTIME_ACCOUNT_IDENTITY_IMMUTABLE",
    );
    this.#append("runtime_account.put", candidate.id, { account: candidate });
    this.runtimeAccounts.set(candidate.id, candidate);
    this.runtimeAccountTombstones.delete(candidate.id);
    return clone(candidate);
  }

  deleteRuntimeAccount(id) {
    return this.#withSensitiveValueMatcher(() => this.#deleteRuntimeAccount(id));
  }

  #deleteRuntimeAccount(id) {
    this.#assertOpen();
    this.#assertNoSensitiveFields(id);
    requireString(id, "RuntimeAccount.id");
    const existing = this.runtimeAccounts.get(id);
    if (!existing) return null;
    if (existing.isDefault) {
      throw storeError("RUNTIME_ACCOUNT_DEFAULT", "默认 RuntimeAccount 不可删除");
    }
    if ([...this.agentProfiles.values()].some((profile) => profile.runtimeAccountId === id)) {
      throw storeError("RUNTIME_ACCOUNT_IN_USE", "RuntimeAccount 仍被 AgentProfile 引用");
    }
    this.#append("runtime_account.delete", id, {});
    this.runtimeAccounts.delete(id);
    this.runtimeAccountTombstones.set(id, existing);
    return clone(existing);
  }

  listAgentProfiles() {
    this.#assertOpen();
    return [...this.agentProfiles.values()].map(clone);
  }

  getAgentProfile(id) {
    this.#assertOpen();
    return clone(this.agentProfiles.get(id) || null);
  }

  putAgentProfile(input) {
    return this.#withSensitiveValueMatcher(() => this.#putAgentProfile(input));
  }

  #putAgentProfile(input) {
    this.#assertOpen();
    this.#assertNoSensitiveFields(input);
    assertJsonRoundTripStable(input);
    const existing = typeof input?.id === "string" ? this.agentProfiles.get(input.id) : null;
    const time = this.now();
    const candidate = {
      ...input,
      createdAt: existing?.createdAt ?? input.createdAt ?? time,
      updatedAt: existing ? Math.max(time, existing.updatedAt + 1) : (input.updatedAt ?? time),
    };
    let migratedAccount = null;
    const runtimeAccountOmitted = !Object.prototype.hasOwnProperty.call(input, "runtimeAccountId");
    if (runtimeAccountOmitted && existing) candidate.runtimeAccountId = existing.runtimeAccountId;
    if (existing && candidate.id === DEFAULT_AGENT_PROFILE_ID
      && !defaultAgentProfileIdentityMatches(candidate)) {
      throw storeError(
        "DEFAULT_AGENT_PROFILE_IDENTITY_IMMUTABLE",
        "保留的 Shoggoth profile 稳定身份不可变更",
      );
    }
    const runtimeChanged = existing && candidate.runtime !== existing.runtime;
    const staleRuntimeSwitchAccount = runtimeChanged
      && candidate.runtimeAccountId === existing.runtimeAccountId;
    const builtinSpec = BUILTIN_CLI_AGENT_PROFILES.find((spec) => spec.id === candidate.id);
    const staleBuiltinAccount = existing && builtinSpec
      && candidate.runtimeAccountId === existing.runtimeAccountId
      && !builtinRuntimeAccountIdMatches(candidate, builtinSpec);
    if ((runtimeAccountOmitted && (!existing || runtimeChanged))
      || staleRuntimeSwitchAccount || staleBuiltinAccount) {
      const legacyCandidate = { ...candidate };
      delete legacyCandidate.runtimeAccountId;
      const migrated = runtimeAccountForLegacyProfile(validateLegacyAgentProfile(legacyCandidate));
      candidate.runtimeAccountId = migrated.runtimeAccountId;
      migratedAccount = migrated.account;
    }
    if (candidate.id === DEFAULT_AGENT_PROFILE_ID && !defaultAgentProfileIdentityMatches(candidate)) {
      throw storeError(
        "DEFAULT_AGENT_PROFILE_IDENTITY_IMMUTABLE",
        "保留的 Shoggoth profile 稳定身份不可变更",
      );
    }
    if (existing && candidate.backendId !== existing.backendId) {
      throw storeError(
        "AGENT_PROFILE_BACKEND_IMMUTABLE",
        "AgentProfile.backendId 持久化后不可更改",
      );
    }
    const profile = validateAgentProfile(candidate);
    this.#assertBuiltinProfileIdentity(profile, "AGENT_PROFILE_IDENTITY_CONFLICT");
    this.#assertAgentProfileIdentityUnique(profile, "AGENT_PROFILE_IDENTITY_CONFLICT");
    if (profile.providerRef !== null && !this.modelProviders.has(profile.providerRef)) {
      throw storeError("UNKNOWN_MODEL_PROVIDER", "AgentProfile.providerRef 不存在");
    }
    if (profile.isDefault) {
      const conflict = [...this.agentProfiles.values()]
        .find((candidate) => candidate.isDefault && candidate.id !== profile.id);
      if (conflict) throw storeError("DEFAULT_AGENT_PROFILE_CONFLICT", "只允许一个默认 AgentProfile");
    }
    const account = this.#runtimeAccountForProfileWrite(profile, migratedAccount, time);
    const reclaimedAccount = this.#legacyRuntimeAccountToReclaim(existing, profile);
    const accountChanged = !this.runtimeAccounts.has(account.id)
      || JSON.stringify(this.runtimeAccounts.get(account.id)) !== JSON.stringify(account);
    this.#append("agent_profile.put", profile.id, accountChanged
      ? { profile, runtimeAccount: account }
      : { profile });
    if (accountChanged) {
      this.runtimeAccounts.set(account.id, account);
      this.runtimeAccountTombstones.delete(account.id);
    }
    this.agentProfiles.set(profile.id, profile);
    this.#commitRuntimeAccountReclamation(reclaimedAccount);
    return clone(profile);
  }

  listModelProviders() {
    this.#assertOpen();
    return [...this.modelProviders.values()].map(clone);
  }

  getModelProvider(id) {
    this.#assertOpen();
    return clone(this.modelProviders.get(id) || null);
  }

  putModelProvider(input) {
    return this.#withSensitiveValueMatcher(() => this.#putModelProvider(input));
  }

  #putModelProvider(input) {
    this.#assertOpen();
    this.#assertNoSensitiveFields(input);
    assertJsonRoundTripStable(input);
    const provider = validateModelProvider(input);
    this.#assertCredentialRefUnique(provider, "MODEL_PROVIDER_CREDENTIAL_CONFLICT");
    this.#append("model_provider.put", provider.id, { provider });
    this.modelProviders.set(provider.id, provider);
    return clone(provider);
  }

  deleteModelProvider(id) {
    return this.#withSensitiveValueMatcher(() => this.#deleteModelProvider(id));
  }

  #deleteModelProvider(id) {
    this.#assertOpen();
    this.#assertNoSensitiveFields(id);
    requireString(id, "ModelProvider.id");
    const existing = this.modelProviders.get(id);
    if (!existing) return null;
    if ([...this.agentProfiles.values()].some((profile) => profile.providerRef === id)) {
      throw storeError("MODEL_PROVIDER_IN_USE", "ModelProvider 仍被 AgentProfile 引用");
    }
    this.#append("model_provider.delete", id, {});
    this.modelProviders.delete(id);
    return clone(existing);
  }

  listWorkRuns(query = {}) {
    this.#assertOpen();
    let runs = [...this.workRuns.values()];
    for (const field of ["source", "sourceId", "profileId", "workspace", "status", "retryOf"]) {
      if (query[field] !== undefined) runs = runs.filter((run) => run[field] === query[field]);
    }
    if (query.runtimeSessionId !== undefined) {
      runs = runs.filter((run) => run.runtimeSessionRef?.sessionId === query.runtimeSessionId);
    }
    return runs.map(workRunView);
  }

  getWorkRun(id) {
    this.#assertOpen();
    return workRunView(this.workRuns.get(id) || null);
  }

  getWorkRunByIdempotencyKey(idempotencyKey) {
    this.#assertOpen();
    const id = this.workRunIdempotency.get(idempotencyKey);
    return id ? this.getWorkRun(id) : null;
  }

  listRunNotes(query = {}) {
    this.#assertOpen();
    if (!query || typeof query !== "object" || Array.isArray(query)
      || Object.getPrototypeOf(query) !== Object.prototype
      || Object.keys(query).some((field) => !["runId", "profileId", "kind"].includes(field))
      || (query.runId !== undefined
        && (typeof query.runId !== "string" || !OPAQUE_ID_PATTERN.test(query.runId)))
      || (query.profileId !== undefined
        && (typeof query.profileId !== "string" || !OPAQUE_ID_PATTERN.test(query.profileId)))
      || (query.kind !== undefined && !RUN_NOTE_KINDS.has(query.kind))) {
      throw storeError("RUN_NOTE_INVALID", "RunNote 查询无效");
    }
    let notes = [...this.runNotes.values()];
    for (const field of ["runId", "profileId", "kind"]) {
      if (query[field] !== undefined) notes = notes.filter((note) => note[field] === query[field]);
    }
    notes.sort((left, right) => left.createdAt - right.createdAt
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    return notes.map(clone);
  }

  getRunNote(id) {
    this.#assertOpen();
    if (typeof id !== "string" || id.length > 128 || !OPAQUE_ID_PATTERN.test(id)) {
      throw storeError("RUN_NOTE_INVALID", "RunNote.id 无效");
    }
    return clone(this.runNotes.get(id) || null);
  }

  addRunNote(input) {
    return this.#withSensitiveValueMatcher(() => this.#addRunNote(input));
  }

  #addRunNote(input) {
    this.#assertOpen();
    this.#assertNoSensitiveFields(input);
    assertJsonRoundTripStable(input);
    const note = validateRunNote(input);
    const existing = this.runNotes.get(note.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(note)) {
        throw storeError("RUN_NOTE_ID_CONFLICT", "RunNote.id 已用于其他内容");
      }
      return clone(existing);
    }
    const run = this.workRuns.get(note.runId);
    if (!run || !this.agentProfiles.has(note.profileId) || run.profileId !== note.profileId
      || (note.kind === "progress"
        && (run.source !== "kanban" || run.sourceId !== note.cardId))) {
      throw storeError("RUN_NOTE_REFERENCE_INVALID", "RunNote 的 Profile/Run/Card 引用无效");
    }
    if (this.runNotes.size >= this.maxRunNotes
      || [...this.runNotes.values()].filter((candidate) => candidate.runId === note.runId).length
        >= this.maxRunNotesPerRun) {
      throw storeError("RUN_NOTE_CAPACITY", "RunNote 容量已满");
    }
    this.#append("run_note.add", note.id, { note });
    this.runNotes.set(note.id, note);
    return clone(note);
  }

  listMcpToolCalls(query = {}) {
    this.#assertOpen();
    if (!query || typeof query !== "object" || Array.isArray(query)
      || Object.getPrototypeOf(query) !== Object.prototype
      || Object.keys(query).some((field) => !["profileId", "name", "status"].includes(field))
      || (query.profileId !== undefined
        && (typeof query.profileId !== "string" || query.profileId.length > 128
          || !OPAQUE_ID_PATTERN.test(query.profileId)))
      || (query.name !== undefined
        && (typeof query.name !== "string" || query.name.length > 64
          || !OPAQUE_ID_PATTERN.test(query.name)))
      || (query.status !== undefined
        && query.status !== "pending" && query.status !== "completed")) {
      throw storeError("MCP_TOOL_CALL_INVALID", "McpToolCall 查询无效");
    }
    let calls = [...this.mcpToolCalls.values()];
    for (const field of ["profileId", "name", "status"]) {
      if (query[field] !== undefined) calls = calls.filter((call) => call[field] === query[field]);
    }
    calls.sort((left, right) => left.createdAt - right.createdAt
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    return calls.map(clone);
  }

  getMcpToolCall(id) {
    this.#assertOpen();
    if (typeof id !== "string" || !/^mcp-call-[a-f0-9]{48}$/u.test(id)) {
      throw storeError("MCP_TOOL_CALL_INVALID", "McpToolCall.id 无效");
    }
    return clone(this.mcpToolCalls.get(id) || null);
  }

  lookupMcpToolCall(input) {
    this.#assertOpen();
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype
      || Object.keys(input).length !== 4
      || !["profileId", "callId", "name", "fingerprint"]
        .every((field) => Object.prototype.hasOwnProperty.call(input, field))
      || typeof input.profileId !== "string" || input.profileId.length > 128
      || !OPAQUE_ID_PATTERN.test(input.profileId) || !UUID_PATTERN.test(input.callId)
      || typeof input.name !== "string" || input.name.length > 64
      || !OPAQUE_ID_PATTERN.test(input.name) || !SHA256_PATTERN.test(input.fingerprint)) {
      throw storeError("MCP_TOOL_CALL_INVALID", "McpToolCall lookup 无效");
    }
    const existing = this.mcpToolCalls.get(mcpToolCallIdentity(input.profileId, input.callId));
    if (!existing) return null;
    if (existing.profileId !== input.profileId || existing.callId !== input.callId
      || existing.name !== input.name || existing.fingerprint !== input.fingerprint) {
      throw storeError("MCP_TOOL_CALL_CONFLICT", "callId 已用于其他 MCP 工具调用");
    }
    return clone(existing);
  }

  beginMcpToolCall(input) {
    return this.#withSensitiveValueMatcher(() => this.#beginMcpToolCall(input));
  }

  #beginMcpToolCall(input) {
    this.#assertOpen();
    this.#assertNoSensitiveFields(input);
    assertJsonRoundTripStable(input);
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).length !== 6
      || !["profileId", "callId", "name", "fingerprint", "binding", "createdAt"]
        .every((field) => Object.prototype.hasOwnProperty.call(input, field))) {
      throw storeError("MCP_TOOL_CALL_INVALID", "beginMcpToolCall 输入无效");
    }
    const found = this.lookupMcpToolCall({
      profileId: input.profileId,
      callId: input.callId,
      name: input.name,
      fingerprint: input.fingerprint,
    });
    if (found) return found;
    if (!this.agentProfiles.has(input.profileId)) {
      throw storeError("UNKNOWN_AGENT_PROFILE", "McpToolCall profileId 不存在");
    }
    const call = validateMcpToolCall({
      id: mcpToolCallIdentity(input.profileId, input.callId),
      profileId: input.profileId,
      callId: input.callId,
      name: input.name,
      fingerprint: input.fingerprint,
      operationId: mcpToolOperationId(
        input.profileId, input.callId, input.name, input.fingerprint,
      ),
      binding: input.binding,
      createdAt: input.createdAt,
      status: "pending",
      result: null,
    });
    const evictedIds = this.#mcpToolCallEvictions({ additionalCalls: 1 });
    this.#append("mcp_tool_call.put", call.id, { call, evictedIds });
    for (const id of evictedIds) this.mcpToolCalls.delete(id);
    this.mcpToolCalls.set(call.id, call);
    return clone(call);
  }

  completeMcpToolCall(input) {
    return this.#withSensitiveValueMatcher(() => this.#completeMcpToolCall(input));
  }

  #completeMcpToolCall(input) {
    this.#assertOpen();
    this.#assertNoSensitiveFields(input);
    assertJsonRoundTripStable(input);
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).length !== 2
      || !Object.prototype.hasOwnProperty.call(input, "id")
      || !Object.prototype.hasOwnProperty.call(input, "outcome")) {
      throw storeError("MCP_TOOL_CALL_INVALID", "completeMcpToolCall 输入无效");
    }
    const existing = this.getMcpToolCall(input.id);
    if (!existing) throw storeError("MCP_TOOL_CALL_NOT_FOUND", "McpToolCall 不存在");
    if (existing.status === "completed") {
      if (JSON.stringify(existing.result) !== JSON.stringify(input.outcome)) {
        throw storeError("MCP_TOOL_CALL_CONFLICT", "McpToolCall outcome 冲突");
      }
      return existing;
    }
    const call = validateMcpToolCall({ ...existing, status: "completed", result: input.outcome });
    const resultBytes = Buffer.byteLength(JSON.stringify(call.result), "utf8");
    const evictedIds = this.#mcpToolCallEvictions({ resultBytes, excludeId: call.id });
    this.#append("mcp_tool_call.put", call.id, { call, evictedIds });
    for (const id of evictedIds) this.mcpToolCalls.delete(id);
    this.mcpToolCalls.set(call.id, call);
    return clone(call);
  }

  #mcpToolCallEvictions(options = {}) {
    const evictedIds = [];
    let callCount = this.mcpToolCalls.size + (options.additionalCalls || 0);
    let resultBytes = [...this.mcpToolCalls.values()].reduce((total, call) => (
      total + (call.status === "completed"
        ? Buffer.byteLength(JSON.stringify(call.result), "utf8") : 0)
    ), 0) + (options.resultBytes || 0);
    const lifecycleRetentionCutoff = this.now() - AGENT_LIFECYCLE_LEDGER_RETENTION_MS;
    const candidates = [...this.mcpToolCalls.values()]
      .filter((call) => call.status === "completed" && call.id !== options.excludeId
        && (!call.name.startsWith("agent.") || call.createdAt < lifecycleRetentionCutoff))
      .sort((left, right) => left.createdAt - right.createdAt
        || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    while (callCount > this.maxMcpToolCalls
      || resultBytes > this.maxMcpToolResultBytesTotal) {
      const candidate = candidates.shift();
      if (!candidate) throw storeError("MCP_TOOL_CALL_CAPACITY", "McpToolCall 容量已满");
      evictedIds.push(candidate.id);
      callCount -= 1;
      resultBytes -= Buffer.byteLength(JSON.stringify(candidate.result), "utf8");
    }
    return evictedIds;
  }

  putWorkRun(input) {
    return this.#withSensitiveValueMatcher(() => this.#putWorkRun(input));
  }

  #putWorkRun(input) {
    this.#assertOpen();
    this.#assertNoSensitiveFields(input);
    assertJsonRoundTripStable(input);
    const existingInput = typeof input?.id === "string" ? this.workRuns.get(input.id) : null;
    this.#assertBindingImmutable(existingInput, input, "WORK_RUN_BINDING_IMMUTABLE");
    this.#assertWorkRunIdentityImmutable(existingInput, input, "WORK_RUN_IDENTITY_IMMUTABLE");
    const run = validateWorkRun(input);
    const existing = this.workRuns.get(run.id);
    const runProfile = this.agentProfiles.get(run.profileId);
    if (runProfile) {
      this.#assertWorkRunRuntimeBinding(run, runProfile, "WORK_RUN_BINDING_INVALID");
    }
    const disabledTargetAudit = runProfile && runProfile.enabled !== true
      && run.status === "skipped"
      && ((run.source === "cron" && run.resultSummary === "CRON_TARGET_DISABLED")
        || (run.source === "kanban" && run.resultSummary === "KANBAN_TARGET_DISABLED"));
    if (!existing && (!runProfile || (runProfile.enabled !== true && !disabledTargetAudit))) {
      throw storeError(
        runProfile ? "AGENT_PROFILE_DISABLED" : "UNKNOWN_AGENT_PROFILE",
        runProfile ? "WorkRun profileId 已停用" : "WorkRun profileId 不存在",
      );
    }
    if (!existing && run.retryOf !== null && !this.workRuns.has(run.retryOf)) {
      throw storeError("UNKNOWN_RETRY_WORK_RUN", "WorkRun retryOf 不存在");
    }
    const expectedEventSeq = existing ? existing.eventSeq + 1 : 1;
    if (run.eventSeq !== expectedEventSeq) {
      throw storeError(
        "WORK_RUN_EVENT_SEQ_CONFLICT",
        `WorkRun.eventSeq 必须单调递增: expected ${expectedEventSeq}, got ${run.eventSeq}`,
      );
    }
    const idempotentId = this.workRunIdempotency.get(run.idempotencyKey);
    if (idempotentId && idempotentId !== run.id) {
      throw storeError("WORK_RUN_IDEMPOTENCY_CONFLICT", "idempotencyKey 已属于另一个 WorkRun");
    }
    this.#assertActiveThreadUnique(run, "THREAD_ACTIVE_TURN_CONFLICT");
    this.#append("work_run.put", run.id, { run });
    this.workRuns.set(run.id, run);
    this.workRunIdempotency.set(run.idempotencyKey, run.id);
    return workRunView(run);
  }

  recoverActiveRunAfterServiceRestart(id) {
    this.#assertOpen();
    requireString(id, "WorkRun.id");
    const existing = this.workRuns.get(id);
    if (!existing) throw storeError("WORK_RUN_NOT_FOUND", `WorkRun 不存在: ${id}`);
    if (!ACTIVE_WORK_RUN_STATUSES.has(existing.status)) {
      throw storeError("WORK_RUN_NOT_ACTIVE", `WorkRun 不是 active 状态: ${id}`);
    }
    const controlledNow = this.now();
    const finishedAt = existing.startedAt === null
      ? controlledNow
      : Math.max(controlledNow, existing.startedAt);
    const candidate = {
      ...clone(existing),
      status: "interrupted",
      eventSeq: existing.eventSeq + 1,
      waitingRequestId: null,
      finishedAt,
      errorCode: "SERVICE_RESTARTED",
    };
    this.#assertNoSensitiveFields(candidate, false);
    assertJsonRoundTripStable(candidate);
    const run = validateWorkRun(candidate);
    for (const field of WORK_RUN_FIELDS) {
      let expected = existing[field];
      if (field === "status") expected = "interrupted";
      else if (field === "eventSeq") expected = existing.eventSeq + 1;
      else if (field === "waitingRequestId") expected = null;
      else if (field === "finishedAt") expected = finishedAt;
      else if (field === "errorCode") expected = "SERVICE_RESTARTED";
      const unchanged = field === "runtimeSessionRef" || field === "runtimeTurnRef"
        ? sameRuntimeRef(run[field], expected)
        : run[field] === expected;
      if (!unchanged) {
        throw storeError("WORK_RUN_RECOVERY_DIFF_INVALID", `WorkRun recovery 非法修改字段: ${field}`);
      }
    }
    this.#assertBindingImmutable(existing, run, "WORK_RUN_BINDING_IMMUTABLE");
    this.#assertWorkRunIdentityImmutable(existing, run, "WORK_RUN_IDENTITY_IMMUTABLE");
    if (!this.agentProfiles.has(run.profileId)
      || (run.retryOf !== null && !this.workRuns.has(run.retryOf))) {
      throw storeError("WORK_RUN_RECOVERY_REFERENCE_INVALID", "WorkRun recovery 引用无效");
    }
    const idempotentId = this.workRunIdempotency.get(run.idempotencyKey);
    if (idempotentId !== run.id) {
      throw storeError("WORK_RUN_IDEMPOTENCY_CONFLICT", "WorkRun recovery idempotencyKey 无效");
    }
    this.#assertActiveThreadUnique(run, "THREAD_ACTIVE_TURN_CONFLICT");
    this.#append("work_run.put", run.id, { run }, false);
    this.workRuns.set(run.id, run);
    return workRunView(run);
  }

  #assertOpen() {
    if (this.commitUncertain) {
      throw storeError("STORE_COMMIT_UNCERTAIN", "ProductStore 提交状态不确定，必须重新打开");
    }
    if (!this.opened) throw storeError("STORE_NOT_OPEN", "ProductStore 尚未打开");
  }

  #withSensitiveValueMatcher(action) {
    if (!this.sensitiveValueMatcherSessionFactory) return action();
    if (this.activeSensitiveValueMatcher) {
      throw storeError("STORE_REENTRANT_WRITE", "ProductStore 不允许重入写入");
    }
    let actionError = null;
    try {
      return this.sensitiveValueMatcherSessionFactory((matcher) => {
        if (typeof matcher !== "function") {
          throw storeError("STORE_SENSITIVE_VALUE_CHECK_FAILED", "敏感值 matcher session 无效");
        }
        this.activeSensitiveValueMatcher = matcher;
        try {
          return action();
        } catch (error) {
          actionError = error;
          throw error;
        } finally {
          this.activeSensitiveValueMatcher = null;
        }
      });
    } catch {
      if (actionError) throw actionError;
      throw storeError("STORE_SENSITIVE_VALUE_CHECK_FAILED", "敏感值判定器执行失败");
    }
  }

  #readSnapshot() {
    if (!this.#lstatIfExists(this.paths.stateSnapshotPath)) return;
    let snapshot;
    const fd = this.#openExistingSafe(this.paths.stateSnapshotPath, this.fs.constants.O_RDONLY);
    try {
      snapshot = JSON.parse(this.fs.readFileSync(fd, "utf8"));
    } catch (error) {
      throw storeError("STORE_CORRUPT_SNAPSHOT", `无法读取 ProductStore snapshot: ${error.message}`);
    } finally { this.fs.closeSync(fd); }
    if (![LEGACY_STORE_SCHEMA_VERSION, PREVIOUS_STORE_SCHEMA_VERSION,
      RICH_STORE_SCHEMA_VERSION, GENERIC_RUNTIME_STORE_SCHEMA_VERSION,
      PROFILE_BACKEND_MIGRATION_SOURCE_SCHEMA_VERSION,
      RUNTIME_ACCOUNT_MIGRATION_SOURCE_SCHEMA_VERSION,
      RUNTIME_ACCOUNT_STORE_SCHEMA_VERSION, PROFILE_PROVIDER_AUTHORITY_SCHEMA_VERSION, STORE_SCHEMA_VERSION]
      .includes(snapshot?.schemaVersion)) {
      throw storeError(
        "STORE_SCHEMA_UNSUPPORTED",
        `不支持 ProductStore snapshot schemaVersion: ${String(snapshot?.schemaVersion)}`,
      );
    }
    const snapshotKeys = Object.keys(snapshot);
    const currentShape = snapshotKeys.length === SNAPSHOT_FIELDS.length
      && snapshotKeys.every((key, index) => key === SNAPSHOT_FIELDS[index]);
    const preRuntimeAccountShape = snapshotKeys.length === PRE_RUNTIME_ACCOUNT_SNAPSHOT_FIELDS.length
      && snapshotKeys.every((key, index) => key === PRE_RUNTIME_ACCOUNT_SNAPSHOT_FIELDS[index]);
    const previousShape = snapshotKeys.length === PREVIOUS_SNAPSHOT_FIELDS.length
      && snapshotKeys.every((key, index) => key === PREVIOUS_SNAPSHOT_FIELDS[index]);
    const legacyShape = snapshotKeys.length === LEGACY_SNAPSHOT_FIELDS.length
      && snapshotKeys.every((key, index) => key === LEGACY_SNAPSHOT_FIELDS[index]);
    const validVersionShape = snapshot.schemaVersion >= RUNTIME_ACCOUNT_STORE_SCHEMA_VERSION
      ? currentShape
      : snapshot.schemaVersion >= RICH_STORE_SCHEMA_VERSION
        ? preRuntimeAccountShape
      : snapshot.schemaVersion === PREVIOUS_STORE_SCHEMA_VERSION
        ? previousShape
        : (previousShape || legacyShape);
    if (!validVersionShape
      || !Number.isSafeInteger(snapshot.lastSeq) || snapshot.lastSeq < 0
      || !Array.isArray(snapshot.agentProfiles) || !Array.isArray(snapshot.workRuns)
      || ((currentShape || preRuntimeAccountShape || previousShape)
        && !Array.isArray(snapshot.modelProviders))
      || (currentShape && !Array.isArray(snapshot.runtimeAccounts))
      || (currentShape && !Array.isArray(snapshot.runtimeAccountTombstones))
      || ((currentShape || preRuntimeAccountShape) && !Array.isArray(snapshot.runNotes))
      || ((currentShape || preRuntimeAccountShape) && !Array.isArray(snapshot.mcpToolCalls))
      || typeof snapshot.checksum !== "string"
      || snapshot.checksum !== snapshotChecksum(snapshot)) {
      throw storeError("STORE_CORRUPT_SNAPSHOT", "ProductStore snapshot 结构无效");
    }
    this.#assertNoSensitiveFields(snapshot, false);
    this.runtimeAccountAuthorityStarted = snapshot.schemaVersion
      >= RUNTIME_ACCOUNT_STORE_SCHEMA_VERSION;
    this.currentSchemaAuthorityStarted = snapshot.schemaVersion === STORE_SCHEMA_VERSION;
    this.profileProviderAuthorityStarted = snapshot.schemaVersion >= PROFILE_PROVIDER_AUTHORITY_SCHEMA_VERSION;
    this.loadedLegacySnapshot = legacyShape || snapshot.schemaVersion === LEGACY_STORE_SCHEMA_VERSION;
    for (const raw of snapshot.modelProviders || []) {
      const provider = modelProviderFromDisk(raw, snapshot.schemaVersion);
      if (this.modelProviders.has(provider.id)) {
        throw storeError("STORE_CORRUPT_SNAPSHOT", `重复 ModelProvider: ${provider.id}`);
      }
      this.#assertCredentialRefUnique(provider, "STORE_CORRUPT_SNAPSHOT");
      this.modelProviders.set(provider.id, provider);
    }
    for (const raw of snapshot.runtimeAccounts || []) {
      const account = runtimeAccountFromDisk(
        raw,
        "STORE_CORRUPT_SNAPSHOT",
        "snapshot",
        snapshot.schemaVersion,
      );
      if (this.runtimeAccounts.has(account.id)) {
        throw storeError("STORE_CORRUPT_SNAPSHOT", `重复 RuntimeAccount: ${account.id}`);
      }
      this.runtimeAccounts.set(account.id, account);
    }
    for (const raw of snapshot.runtimeAccountTombstones || []) {
      const tombstone = runtimeAccountFromDisk(
        raw,
        "STORE_CORRUPT_SNAPSHOT",
        "snapshot",
        snapshot.schemaVersion,
      );
      if (tombstone.isDefault || this.runtimeAccounts.has(tombstone.id)
        || this.runtimeAccountTombstones.has(tombstone.id)) {
        throw storeError("STORE_CORRUPT_SNAPSHOT", `RuntimeAccount tombstone 身份冲突: ${tombstone.id}`);
      }
      this.runtimeAccountTombstones.set(tombstone.id, tombstone);
    }
    this.#ensureDefaultRuntimeAccounts();
    for (const raw of snapshot.agentProfiles) {
      this.#applyAgentProfileFromDisk(
        agentProfileFromDisk(raw, snapshot.schemaVersion),
        "snapshot",
        snapshot.schemaVersion,
      );
    }
    for (const raw of snapshot.workRuns) {
      const profile = this.agentProfiles.get(raw?.profileId);
      this.#applyWorkRunFromDisk(
        workRunFromDisk(raw, snapshot.schemaVersion, profile),
        "snapshot",
      );
    }
    for (const raw of snapshot.runNotes || []) {
      this.#applyRunNoteFromDisk(validateRunNote(raw), "snapshot");
    }
    for (const raw of snapshot.mcpToolCalls || []) {
      this.#applyMcpToolCallFromDisk(validateMcpToolCall(raw), "snapshot");
    }
    this.lastEventSeq = snapshot.lastSeq;
  }

  #replayEventLog() {
    const target = this.paths.eventLogPath;
    if (!this.#lstatIfExists(target)) {
      const fd = this.#openNewSafe(
        target,
        this.fs.constants.O_CREAT | this.fs.constants.O_EXCL | this.fs.constants.O_RDWR,
      );
      try { this.fs.fsyncSync(fd); } finally { this.fs.closeSync(fd); }
      this.#fsyncStateDirectory();
      return;
    }
    const fd = this.#openExistingSafe(target, this.fs.constants.O_RDWR);
    try {
      const bytes = this.fs.readFileSync(fd);
      const lastNewline = bytes.lastIndexOf(0x0a);
      const completeLength = lastNewline < 0 ? 0 : lastNewline + 1;
      const complete = bytes.subarray(0, completeLength).toString("utf8");
      const lines = complete.length === 0 ? [] : complete.slice(0, -1).split("\n");
      let expectedSeq = this.lastEventSeq + 1;
      let previousLogSeq = null;
      for (let index = 0; index < lines.length; index += 1) {
        let event;
        try { event = JSON.parse(lines[index]); } catch {
          throw storeError("STORE_CORRUPT_EVENT_LOG", `events.jsonl 第 ${index + 1} 行不是有效 JSON`);
        }
        this.#validateEnvelope(event, index + 1);
        if (previousLogSeq !== null && event.seq !== previousLogSeq + 1) {
          throw storeError("STORE_CORRUPT_EVENT_LOG", `events.jsonl 物理 seq 不连续: ${event.seq}`);
        }
        previousLogSeq = event.seq;
        if (event.seq <= this.lastEventSeq) continue;
        if (event.seq !== expectedSeq) {
          throw storeError("STORE_CORRUPT_EVENT_LOG", `events.jsonl seq 不连续: ${event.seq}`);
        }
        this.#applyEvent(event);
        this.lastEventSeq = event.seq;
        expectedSeq += 1;
      }
      if (completeLength !== bytes.length) {
        // 只有完整前缀已经全部验证后才截掉崩溃尾部；使用已 pin inode 的 fd 截断。
        this.fs.ftruncateSync(fd, completeLength);
        this.fs.fsyncSync(fd);
      }
    } finally { this.fs.closeSync(fd); }
  }

  #validateEnvelope(event, line) {
    if (![LEGACY_STORE_SCHEMA_VERSION, PREVIOUS_STORE_SCHEMA_VERSION,
      RICH_STORE_SCHEMA_VERSION, GENERIC_RUNTIME_STORE_SCHEMA_VERSION,
      PROFILE_BACKEND_MIGRATION_SOURCE_SCHEMA_VERSION,
      RUNTIME_ACCOUNT_MIGRATION_SOURCE_SCHEMA_VERSION,
      RUNTIME_ACCOUNT_STORE_SCHEMA_VERSION, PROFILE_PROVIDER_AUTHORITY_SCHEMA_VERSION, STORE_SCHEMA_VERSION]
      .includes(event?.schemaVersion)) {
      throw storeError(
        "STORE_SCHEMA_UNSUPPORTED",
        `不支持 events.jsonl 第 ${line} 行 schemaVersion: ${String(event?.schemaVersion)}`,
      );
    }
    if (!Number.isSafeInteger(event.seq) || event.seq < 1 || typeof event.aggregateId !== "string"
      || !event.aggregateId || typeof event.type !== "string" || !event.type
      || !Number.isSafeInteger(event.time) || event.time < 0
      || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)
      || typeof event.checksum !== "string" || event.checksum !== eventChecksum(event)) {
      throw storeError("STORE_CORRUPT_EVENT_LOG", `events.jsonl 第 ${line} 行 envelope/校验和无效`);
    }
    this.#assertNoSensitiveFields(event.payload, false);
  }

  #applyEvent(event) {
    if (event.schemaVersion >= PROFILE_PROVIDER_AUTHORITY_SCHEMA_VERSION) {
      this.profileProviderAuthorityStarted = true;
    } else if (this.profileProviderAuthorityStarted) {
      throw storeError("STORE_CORRUPT_EVENT_LOG", "events.jsonl 在 Profile Provider authority 后回退到旧 schema");
    }
    if (event.schemaVersion === STORE_SCHEMA_VERSION) {
      this.#finishLegacyRuntimeAccountCanonicalization();
      this.runtimeAccountAuthorityStarted = true;
      this.currentSchemaAuthorityStarted = true;
    } else if (this.currentSchemaAuthorityStarted) {
      throw storeError(
        "STORE_CORRUPT_EVENT_LOG",
        "events.jsonl 在当前 schema authority 后回退到旧 schema",
      );
    } else if (event.schemaVersion >= RUNTIME_ACCOUNT_STORE_SCHEMA_VERSION) {
      this.#finishLegacyRuntimeAccountCanonicalization();
      this.runtimeAccountAuthorityStarted = true;
    } else if (this.runtimeAccountAuthorityStarted) {
      throw storeError(
        "STORE_CORRUPT_EVENT_LOG",
        "events.jsonl 在 RuntimeAccount authority 后回退到旧 schema",
      );
    }
    if (event.schemaVersion >= RUNTIME_ACCOUNT_STORE_SCHEMA_VERSION
      && event.type === "runtime_account.put" && event.payload?.account
      && Object.keys(event.payload).length === 1) {
      const account = runtimeAccountFromDisk(
        event.payload.account,
        "STORE_CORRUPT_EVENT_LOG",
        "events.jsonl",
        event.schemaVersion,
      );
      if (account.id !== event.aggregateId) {
        throw storeError("STORE_CORRUPT_EVENT_LOG", "RuntimeAccount aggregateId 不匹配");
      }
      const existing = this.runtimeAccounts.get(account.id);
      const tombstone = existing ? null : this.runtimeAccountTombstones.get(account.id) || null;
      this.#assertRuntimeAccountIdentityImmutable(
        existing || tombstone,
        account,
        "STORE_CORRUPT_EVENT_LOG",
      );
      this.runtimeAccounts.set(account.id, account);
      this.runtimeAccountTombstones.delete(account.id);
      return;
    }
    if (event.schemaVersion >= RUNTIME_ACCOUNT_STORE_SCHEMA_VERSION
      && event.type === "runtime_account.delete"
      && event.payload && Object.keys(event.payload).length === 0) {
      const account = this.runtimeAccounts.get(event.aggregateId);
      if (!account || account.isDefault
        || [...this.agentProfiles.values()]
          .some((profile) => profile.runtimeAccountId === event.aggregateId)) {
        throw storeError("STORE_CORRUPT_EVENT_LOG", "events.jsonl 删除了受保护的 RuntimeAccount");
      }
      this.runtimeAccounts.delete(event.aggregateId);
      this.runtimeAccountTombstones.set(event.aggregateId, account);
      return;
    }
    if (event.type === "model_provider.put" && event.payload?.provider) {
      const provider = modelProviderFromDisk(event.payload.provider, event.schemaVersion);
      if (provider.id !== event.aggregateId) {
        throw storeError("STORE_CORRUPT_EVENT_LOG", "ModelProvider aggregateId 不匹配");
      }
      this.#assertCredentialRefUnique(provider, "STORE_CORRUPT_EVENT_LOG");
      this.sawProviderEvent = true;
      this.modelProviders.set(provider.id, provider);
      return;
    }
    if (event.type === "model_provider.delete"
      && event.payload && Object.keys(event.payload).length === 0) {
      this.sawProviderEvent = true;
      if (!this.modelProviders.has(event.aggregateId)) {
        throw storeError("STORE_CORRUPT_EVENT_LOG", "删除的 ModelProvider 不存在");
      }
      if ([...this.agentProfiles.values()]
        .some((profile) => profile.providerRef === event.aggregateId)) {
        throw storeError("STORE_CORRUPT_EVENT_LOG", "events.jsonl 删除了仍被引用的 ModelProvider");
      }
      this.modelProviders.delete(event.aggregateId);
      return;
    }
    if (event.type === "agent_profile.put" && event.payload?.profile) {
      const payloadKeys = Object.keys(event.payload);
      const validPayload = (payloadKeys.length === 1 && payloadKeys[0] === "profile")
        || (event.schemaVersion >= RUNTIME_ACCOUNT_STORE_SCHEMA_VERSION
          && payloadKeys.length === 2
          && payloadKeys[0] === "profile" && payloadKeys[1] === "runtimeAccount");
      if (!validPayload) {
        throw storeError("STORE_CORRUPT_EVENT_LOG", "AgentProfile event payload 无效");
      }
      const decoded = agentProfileFromDisk(event.payload.profile, event.schemaVersion);
      if (event.payload.runtimeAccount) {
        decoded.runtimeAccount = runtimeAccountFromDisk(
          event.payload.runtimeAccount,
          "STORE_CORRUPT_EVENT_LOG",
          "events.jsonl",
          event.schemaVersion,
        );
      }
      if (decoded.profile.id !== event.aggregateId) {
        throw storeError("STORE_CORRUPT_EVENT_LOG", "AgentProfile aggregateId 不匹配");
      }
      this.#applyAgentProfileFromDisk(decoded, "events.jsonl", event.schemaVersion, event.time);
      return;
    }
    if (event.type === "work_run.put" && event.payload?.run) {
      const run = workRunFromDisk(
        event.payload.run,
        event.schemaVersion,
        this.agentProfiles.get(event.payload.run?.profileId),
      );
      if (run.id !== event.aggregateId) {
        throw storeError("STORE_CORRUPT_EVENT_LOG", "WorkRun aggregateId 不匹配");
      }
      this.#applyWorkRunFromDisk(run, "events.jsonl");
      return;
    }
    if (event.schemaVersion >= RICH_STORE_SCHEMA_VERSION
      && event.type === "run_note.add" && event.payload?.note
      && Object.keys(event.payload).length === 1
      && Object.prototype.hasOwnProperty.call(event.payload, "note")) {
      const note = validateRunNote(event.payload.note);
      if (note.id !== event.aggregateId) {
        throw storeError("STORE_CORRUPT_EVENT_LOG", "RunNote aggregateId 不匹配");
      }
      this.#applyRunNoteFromDisk(note, "events.jsonl");
      return;
    }
    if (event.schemaVersion >= RICH_STORE_SCHEMA_VERSION
      && event.type === "mcp_tool_call.put" && event.payload?.call
      && Array.isArray(event.payload?.evictedIds)
      && Object.keys(event.payload).length === 2
      && Object.prototype.hasOwnProperty.call(event.payload, "call")
      && Object.prototype.hasOwnProperty.call(event.payload, "evictedIds")) {
      const call = validateMcpToolCall(event.payload.call);
      if (call.id !== event.aggregateId
        || event.payload.evictedIds.some((id) => typeof id !== "string"
          || !/^mcp-call-[a-f0-9]{48}$/u.test(id))) {
        throw storeError("STORE_CORRUPT_EVENT_LOG", "McpToolCall envelope 无效");
      }
      const evictedIds = new Set(event.payload.evictedIds);
      if (evictedIds.size !== event.payload.evictedIds.length || evictedIds.has(call.id)) {
        throw storeError("STORE_CORRUPT_EVENT_LOG", "McpToolCall eviction 无效");
      }
      for (const id of evictedIds) {
        const evicted = this.mcpToolCalls.get(id);
        if (!evicted || evicted.status !== "completed") {
          throw storeError("STORE_CORRUPT_EVENT_LOG", "McpToolCall eviction 引用无效");
        }
      }
      for (const id of evictedIds) this.mcpToolCalls.delete(id);
      this.#applyMcpToolCallFromDisk(call, "events.jsonl");
      return;
    }
    throw storeError("STORE_CORRUPT_EVENT_LOG", `未知 ProductStore event type: ${event.type}`);
  }

  #applyWorkRunFromDisk(run, source) {
    const existing = this.workRuns.get(run.id);
    const corruptCode = source === "snapshot" ? "STORE_CORRUPT_SNAPSHOT" : "STORE_CORRUPT_EVENT_LOG";
    const profile = this.agentProfiles.get(run.profileId);
    if (profile) this.#assertWorkRunRuntimeBinding(run, profile, corruptCode);
    this.#assertBindingImmutable(existing, run, corruptCode);
    this.#assertWorkRunIdentityImmutable(existing, run, corruptCode);
    if (!this.agentProfiles.has(run.profileId)
      || (run.retryOf !== null && !this.workRuns.has(run.retryOf))) {
      throw storeError(corruptCode, `${source} 的 WorkRun 引用无效`);
    }
    if (existing && run.eventSeq !== existing.eventSeq + 1) {
      throw storeError("STORE_CORRUPT_EVENT_LOG", `${source} 的 WorkRun eventSeq/idempotencyKey 无效`);
    }
    const previousId = this.workRunIdempotency.get(run.idempotencyKey);
    if (previousId && previousId !== run.id) {
      throw storeError("STORE_CORRUPT_EVENT_LOG", `${source} 含冲突 idempotencyKey`);
    }
    this.#assertActiveThreadUnique(run, corruptCode);
    this.workRuns.set(run.id, run);
    this.workRunIdempotency.set(run.idempotencyKey, run.id);
  }

  #applyRunNoteFromDisk(note, source) {
    const corruptCode = source === "snapshot" ? "STORE_CORRUPT_SNAPSHOT" : "STORE_CORRUPT_EVENT_LOG";
    const run = this.workRuns.get(note.runId);
    if (this.runNotes.has(note.id) || !run || !this.agentProfiles.has(note.profileId)
      || run.profileId !== note.profileId
      || (note.kind === "progress"
        && (run.source !== "kanban" || run.sourceId !== note.cardId))) {
      throw storeError(corruptCode, `${source} 的 RunNote 引用或身份无效`);
    }
    if (this.runNotes.size >= this.maxRunNotes
      || [...this.runNotes.values()].filter((candidate) => candidate.runId === note.runId).length
        >= this.maxRunNotesPerRun) {
      throw storeError(corruptCode, `${source} 的 RunNote 超过容量`);
    }
    this.runNotes.set(note.id, note);
  }

  #applyMcpToolCallFromDisk(call, source) {
    const corruptCode = source === "snapshot" ? "STORE_CORRUPT_SNAPSHOT" : "STORE_CORRUPT_EVENT_LOG";
    const existing = this.mcpToolCalls.get(call.id);
    if (!this.agentProfiles.has(call.profileId)) {
      throw storeError(corruptCode, `${source} 的 McpToolCall Profile 引用无效`);
    }
    if (source === "snapshot") {
      if (existing || this.mcpToolCalls.size >= this.maxMcpToolCalls) {
        throw storeError(corruptCode, `${source} 的 McpToolCall 身份或容量无效`);
      }
    } else if (!existing) {
      if (call.status !== "pending" || this.mcpToolCalls.size >= this.maxMcpToolCalls) {
        throw storeError(corruptCode, `${source} 的 McpToolCall begin 无效`);
      }
    } else if (existing.status !== "pending" || call.status !== "completed"
      || ["id", "profileId", "callId", "name", "fingerprint", "operationId", "createdAt"]
        .some((field) => existing[field] !== call[field])
      || JSON.stringify(existing.binding) !== JSON.stringify(call.binding)) {
      throw storeError(corruptCode, `${source} 的 McpToolCall transition 无效`);
    }
    const totalBytes = [...this.mcpToolCalls.values()]
      .filter((candidate) => candidate.status === "completed" && candidate.id !== call.id)
      .reduce((total, candidate) => total + Buffer.byteLength(
        JSON.stringify(candidate.result), "utf8",
      ), call.status === "completed" ? Buffer.byteLength(JSON.stringify(call.result), "utf8") : 0);
    if (totalBytes > this.maxMcpToolResultBytesTotal) {
      throw storeError(corruptCode, `${source} 的 McpToolCall result 总容量无效`);
    }
    this.mcpToolCalls.set(call.id, call);
  }

  #ensureDefaultRuntimeAccounts() {
    for (const template of DEFAULT_RUNTIME_ACCOUNTS) {
      const existing = this.runtimeAccounts.get(template.id);
      if (!existing) {
        this.runtimeAccounts.set(template.id, clone(template));
        continue;
      }
      this.#assertRuntimeAccountFixedIdentity(
        template,
        existing,
        "STORE_RUNTIME_ACCOUNT_DEFAULT_CONFLICT",
      );
    }
  }

  #assertRuntimeAccountIdentityImmutable(existing, candidate, code) {
    if (!existing) return;
    this.#assertRuntimeAccountFixedIdentity(existing, candidate, code);
    if (existing.updatedAt !== null
      && (candidate.updatedAt === null || candidate.updatedAt < existing.updatedAt)) {
      throw storeError(code, "RuntimeAccount.updatedAt 不可倒退");
    }
  }

  #assertRuntimeAccountFixedIdentity(existing, candidate, code) {
    for (const field of [
      "runtime", "kind", "installationKind", "homeKind", "isDefault", "createdAt",
    ]) {
      if (candidate[field] !== existing[field]) {
        throw storeError(code, `RuntimeAccount.${field} 创建后不可变更`);
      }
    }
  }

  #legacyRuntimeAccountToReclaim(existingProfile, nextProfile) {
    if (!existingProfile || existingProfile.runtimeAccountId === nextProfile.runtimeAccountId) {
      return null;
    }
    const account = this.runtimeAccounts.get(existingProfile.runtimeAccountId);
    if (!account || account.kind !== "shoggoth-managed" || account.isDefault) return null;
    let derivedAccountId;
    try {
      derivedAccountId = runtimeAccountForLegacyProfile(existingProfile).runtimeAccountId;
    } catch {
      return null;
    }
    if (account.id !== derivedAccountId
      || [...this.agentProfiles.values()].some((profile) => (
        profile.id !== existingProfile.id && profile.runtimeAccountId === account.id
      ))) {
      return null;
    }
    return account;
  }

  #commitRuntimeAccountReclamation(account) {
    if (!account) return;
    this.runtimeAccounts.delete(account.id);
    this.runtimeAccountTombstones.set(account.id, account);
  }

  #runtimeAccountForProfileWrite(profile, migratedAccount, time) {
    let account = this.runtimeAccounts.get(profile.runtimeAccountId) || null;
    if (!account) {
      if (!migratedAccount || migratedAccount.id !== profile.runtimeAccountId) {
        throw storeError("UNKNOWN_RUNTIME_ACCOUNT", "AgentProfile.runtimeAccountId 不存在");
      }
      account = validateRuntimeAccount(migratedAccount);
      const tombstone = this.runtimeAccountTombstones.get(account.id) || null;
      if (tombstone) {
        account = validateRuntimeAccount({
          ...account,
          createdAt: tombstone.createdAt,
          updatedAt: Math.max(time, (tombstone.updatedAt ?? -1) + 1),
        });
        this.#assertRuntimeAccountIdentityImmutable(
          tombstone,
          account,
          "RUNTIME_ACCOUNT_IDENTITY_CONFLICT",
        );
      } else if (!account.isDefault && account.createdAt === null && account.updatedAt === null) {
        account = validateRuntimeAccount({ ...account, createdAt: time, updatedAt: time });
      }
    } else if (migratedAccount) {
      this.#assertRuntimeAccountIdentityImmutable(
        account,
        { ...migratedAccount, createdAt: account.createdAt, updatedAt: account.updatedAt },
        "RUNTIME_ACCOUNT_IDENTITY_CONFLICT",
      );
    }
    if (account.runtime !== profile.runtime) {
      throw storeError(
        "RUNTIME_ACCOUNT_PROFILE_MISMATCH",
        "AgentProfile runtime 与 RuntimeAccount runtime 不一致",
      );
    }
    this.#assertBuiltinRuntimeAccountBinding(
      profile,
      account,
      "AGENT_PROFILE_IDENTITY_CONFLICT",
    );
    return account;
  }

  #applyAgentProfileFromDisk(decoded, source, schemaVersion, eventTime = null) {
    let profile = decoded.profile;
    const corruptCode = source === "snapshot" ? "STORE_CORRUPT_SNAPSHOT" : "STORE_CORRUPT_EVENT_LOG";
    if (schemaVersion === RUNTIME_ACCOUNT_STORE_SCHEMA_VERSION) {
      const persistedAccountId = profile.runtimeAccountId;
      if (decoded.runtimeAccount) {
        const candidate = runtimeAccountFromDisk(
          decoded.runtimeAccount,
          corruptCode,
          source,
          schemaVersion,
        );
        if (candidate.id !== persistedAccountId) {
          throw storeError(corruptCode, "AgentProfile event 的 RuntimeAccount binding 无效");
        }
        const existing = this.runtimeAccounts.get(candidate.id);
        const tombstone = existing ? null : this.runtimeAccountTombstones.get(candidate.id) || null;
        this.#assertRuntimeAccountIdentityImmutable(existing || tombstone, candidate, corruptCode);
        this.runtimeAccounts.set(candidate.id, candidate);
        this.runtimeAccountTombstones.delete(candidate.id);
        decoded.runtimeAccount = null;
      }
      const persistedAccount = this.runtimeAccounts.get(persistedAccountId) || null;
      const aliasedAccountId = this.legacyRuntimeAccountAliases.get(persistedAccountId);
      const canonicalAccountId = aliasedAccountId
        || canonicalLegacyRuntimeAccountId(profile, persistedAccount);
      if (canonicalAccountId !== persistedAccountId) {
        this.legacyRuntimeAccountAliases.set(persistedAccountId, canonicalAccountId);
        this.legacyRuntimeAccountIdsToReclaim.add(persistedAccountId);
        profile = validateAgentProfile({ ...profile, runtimeAccountId: canonicalAccountId });
      }
    }
    if (source === "snapshot" && this.agentProfiles.has(profile.id)) {
      throw storeError(corruptCode, `重复 AgentProfile: ${profile.id}`);
    }
    if (profile.id === DEFAULT_AGENT_PROFILE_ID && !defaultAgentProfileIdentityMatches(profile)) {
      throw storeError(corruptCode, "保留的 Shoggoth profile 稳定身份无效");
    }
    const existingProfile = this.agentProfiles.get(profile.id);
    if (existingProfile && profile.backendId !== existingProfile.backendId) {
      throw storeError(corruptCode, `${source} 静默改变了 AgentProfile.backendId`);
    }
    this.#assertBuiltinProfileIdentity(profile, corruptCode);
    this.#assertAgentProfileIdentityUnique(profile, corruptCode);
    if (profile.isDefault && [...this.agentProfiles.values()]
      .some((candidate) => candidate.isDefault && candidate.id !== profile.id)) {
      throw storeError(corruptCode, `${source} 产生多个默认 AgentProfile`);
    }

    let account = this.runtimeAccounts.get(profile.runtimeAccountId) || null;
    if (decoded.runtimeAccount) {
      let candidate = runtimeAccountFromDisk(
        decoded.runtimeAccount,
        corruptCode,
        source,
        schemaVersion,
      );
      if (candidate.id !== profile.runtimeAccountId) {
        throw storeError(corruptCode, "AgentProfile event 的 RuntimeAccount binding 无效");
      }
      const tombstone = account ? null : this.runtimeAccountTombstones.get(candidate.id) || null;
      const prior = account || tombstone;
      if (schemaVersion < RUNTIME_ACCOUNT_STORE_SCHEMA_VERSION) {
        const revisionTime = eventTime ?? profile.updatedAt ?? profile.createdAt ?? 0;
        const createdAt = prior
          ? prior.createdAt
          : candidate.isDefault
            ? candidate.createdAt
            : (profile.createdAt ?? revisionTime);
        const updatedAt = prior
          ? prior.updatedAt
          : candidate.isDefault
            ? candidate.updatedAt
            : Math.max(revisionTime, createdAt ?? 0);
        candidate = validateRuntimeAccount({ ...candidate, createdAt, updatedAt });
      }
      if (prior) {
        this.#assertRuntimeAccountIdentityImmutable(prior, candidate, corruptCode);
      }
      account = candidate;
      if (schemaVersion < RUNTIME_ACCOUNT_STORE_SCHEMA_VERSION) {
        this.pendingLegacyRuntimeAccountCanonicalization = true;
        this.legacyRuntimeAccountSource = source;
        this.legacyRuntimeAccountIds.add(account.id);
      }
      this.runtimeAccounts.set(account.id, account);
      this.runtimeAccountTombstones.delete(account.id);
    }
    if (!account || account.runtime !== profile.runtime) {
      throw storeError(corruptCode, "AgentProfile RuntimeAccount 引用无效");
    }
    this.#assertBuiltinRuntimeAccountBinding(profile, account, corruptCode);
    const reclaimedAccount = this.#legacyRuntimeAccountToReclaim(existingProfile, profile);
    this.agentProfiles.set(profile.id, profile);
    if (schemaVersion >= RUNTIME_ACCOUNT_STORE_SCHEMA_VERSION) {
      this.#commitRuntimeAccountReclamation(reclaimedAccount);
    } else if (reclaimedAccount) {
      // pre-v7 Profile history never owned RuntimeAccount lifecycle. An
      // intermediate binding is migration scratch, not a real deleted account.
      this.runtimeAccounts.delete(reclaimedAccount.id);
      this.runtimeAccountTombstones.delete(reclaimedAccount.id);
    }
  }

  #finishLegacyRuntimeAccountCanonicalization() {
    if (this.pendingLegacyRuntimeAccountCanonicalization) {
      const corruptCode = this.legacyRuntimeAccountSource === "snapshot"
        ? "STORE_CORRUPT_SNAPSHOT" : "STORE_CORRUPT_EVENT_LOG";
      const expected = new Map();
      for (const profile of this.agentProfiles.values()) {
        const migrated = runtimeAccountForLegacyProfile(profile);
        if (migrated.runtimeAccountId !== profile.runtimeAccountId) {
          throw storeError(corruptCode, "Legacy AgentProfile RuntimeAccount 派生结果不一致");
        }
        const account = migrated.account.isDefault
          ? migrated.account
          : validateRuntimeAccount({
            ...migrated.account,
            createdAt: profile.createdAt,
            updatedAt: profile.createdAt !== null && profile.updatedAt !== null
              ? Math.max(profile.createdAt, profile.updatedAt)
              : profile.updatedAt,
          });
        const prior = expected.get(account.id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(account)) {
          throw storeError(corruptCode, "Legacy AgentProfile 无法合成为唯一 RuntimeAccount");
        }
        expected.set(account.id, account);
      }
      for (const id of this.legacyRuntimeAccountIds) {
        const account = expected.get(id);
        if (account) {
          this.runtimeAccounts.set(id, clone(account));
        } else if (DEFAULT_RUNTIME_ACCOUNT_IDS.has(id)) {
          const template = DEFAULT_RUNTIME_ACCOUNTS.find((candidate) => candidate.id === id);
          this.runtimeAccounts.set(id, clone(template));
        } else {
          this.runtimeAccounts.delete(id);
        }
        this.runtimeAccountTombstones.delete(id);
      }
      this.pendingLegacyRuntimeAccountCanonicalization = false;
      this.legacyRuntimeAccountSource = null;
      this.legacyRuntimeAccountIds.clear();
    }
    for (const id of this.legacyRuntimeAccountIdsToReclaim) {
      if (![...this.agentProfiles.values()].some((profile) => profile.runtimeAccountId === id)) {
        this.runtimeAccounts.delete(id);
        this.runtimeAccountTombstones.delete(id);
      }
    }
    this.legacyRuntimeAccountIdsToReclaim.clear();
  }

  #assertAllReferences() {
    const danglingProfileProvider = [...this.agentProfiles.values()]
      .find((profile) => profile.providerRef !== null && !this.modelProviders.has(profile.providerRef));
    const invalidProfile = [...this.agentProfiles.values()].find((profile) => {
      const account = this.runtimeAccounts.get(profile.runtimeAccountId);
      return !account || account.runtime !== profile.runtime
        || !builtinRuntimeAccountBindingMatches(profile, account);
    });
    if (!danglingProfileProvider && !invalidProfile) return;
    const legacy = this.loadedLegacySnapshot === true || this.sawProviderEvent !== true;
    throw storeError(
      legacy ? "STORE_LEGACY_PROVIDER_REFERENCE_UNRESOLVED" : "STORE_CORRUPT_EVENT_LOG",
      "ProductStore RuntimeAccount/Profile 引用无效",
    );
  }

  #assertCredentialRefUnique(candidate, code) {
    if (candidate.credentialRef === null) return;
    const owner = [...this.modelProviders.values()].find((provider) => provider.id !== candidate.id
      && provider.credentialRef === candidate.credentialRef);
    if (owner) throw storeError(code, "ModelProvider.credentialRef 已属于另一个 Provider");
  }

  #assertBuiltinProfileIdentity(candidate, code) {
    for (const spec of BUILTIN_CLI_AGENT_PROFILES) {
      if (candidate.id === spec.id && !builtinIdentityMatches(candidate, spec)) {
        throw storeError(code, `内置 AgentProfile 稳定身份冲突: ${spec.name}`);
      }
      if (candidate.id !== spec.id && (candidate.agentId === spec.agentId
        || (candidate.runtime === spec.runtime
          && candidate.runtimeProfileId === spec.runtimeProfileId))) {
        throw storeError(code, `内置 AgentProfile 命名空间已被占用: ${spec.name}`);
      }
      const occupied = [...this.agentProfiles.values()].find((profile) => profile.id !== candidate.id
        && (profile.agentId === spec.agentId
          || (profile.runtime === spec.runtime
            && profile.runtimeProfileId === spec.runtimeProfileId)));
      if (candidate.id === spec.id && occupied) {
        throw storeError(code, `内置 AgentProfile 命名空间已被占用: ${spec.name}`);
      }
    }
  }

  #assertBuiltinRuntimeAccountBinding(profile, account, code) {
    if (!builtinRuntimeAccountBindingMatches(profile, account)) {
      throw storeError(code, "AgentProfile RuntimeAccount binding 无效");
    }
  }

  #assertAgentProfileIdentityUnique(candidate, code) {
    const conflict = [...this.agentProfiles.values()].find((profile) => profile.id !== candidate.id
      && (profile.agentId === candidate.agentId
        || (profile.runtime === candidate.runtime
          && profile.runtimeProfileId === candidate.runtimeProfileId)));
    if (conflict) {
      throw storeError(code, "AgentProfile agentId/runtimeProfileId 必须全局唯一");
    }
  }

  #assertBindingImmutable(existing, candidate, code) {
    if (!existing) return;
    for (const field of ["runtimeSessionRef", "runtimeTurnRef"]) {
      if (existing[field] !== null && !sameRuntimeRef(candidate[field], existing[field])) {
        throw storeError(code, `WorkRun.${field} 非空后不可清空或更换`);
      }
    }
    if (existing.contextSnapshotId !== null
      && candidate.contextSnapshotId !== existing.contextSnapshotId) {
      throw storeError(code, "WorkRun.contextSnapshotId 非空后不可清空或更换");
    }
  }

  #assertWorkRunRuntimeBinding(run, profile, code) {
    for (const ref of [run.runtimeSessionRef, run.runtimeTurnRef]) {
      if (ref === null) continue;
      if (ref.runtime !== profile.runtime
        || ref.runtimeProfileId !== profile.runtimeProfileId
        || ref.runtimeAccountId !== profile.runtimeAccountId) {
        throw storeError(code, "WorkRun Runtime ref 与 AgentProfile binding 不匹配");
      }
    }
  }

  #assertWorkRunIdentityImmutable(existing, candidate, code) {
    if (!existing) return;
    for (const field of ["source", "sourceId", "idempotencyKey", "profileId", "workspace", "retryOf"]) {
      if (candidate[field] !== existing[field]) {
        throw storeError(code, `WorkRun.${field} 创建后不可变更`);
      }
    }
  }

  #assertActiveThreadUnique(candidate, code) {
    if (!ACTIVE_WORK_RUN_STATUSES.has(candidate.status)
      || candidate.runtimeSessionRef === null) return;
    const conflict = [...this.workRuns.values()].find((run) => run.id !== candidate.id
      && ACTIVE_WORK_RUN_STATUSES.has(run.status)
      && sameRuntimeRef(run.runtimeSessionRef, candidate.runtimeSessionRef));
    if (conflict) {
      throw storeError(
        code,
        `Runtime session ${candidate.runtimeSessionRef.sessionId} 已绑定 active Run ${conflict.id}`,
      );
    }
  }

  #append(type, aggregateId, payload, includeRequiredMatcher = true) {
    this.#assertNoSensitiveFields(payload, includeRequiredMatcher);
    const event = {
      schemaVersion: STORE_SCHEMA_VERSION,
      seq: this.lastEventSeq + 1,
      aggregateId,
      type,
      time: this.now(),
      payload: clone(payload),
    };
    event.checksum = eventChecksum(event);
    const fd = this.#openExistingSafe(
      this.paths.eventLogPath,
      this.fs.constants.O_WRONLY | this.fs.constants.O_APPEND,
    );
    let writeAttempted = false;
    let operationError = null;
    let closeError = null;
    try {
      this.fs.fchmodSync(fd, 0o600);
      writeAttempted = true;
      writeFully(this.fs, fd, `${JSON.stringify(event)}\n`);
      this.fs.fsyncSync(fd);
    } catch (error) {
      operationError = error;
    }
    try { this.fs.closeSync(fd); } catch (error) { closeError = error; }
    if (operationError || closeError) {
      if (writeAttempted) {
        this.commitUncertain = true;
        throw storeError("STORE_COMMIT_UNCERTAIN", "ProductStore event 提交状态不确定，必须重新打开");
      }
      throw operationError || closeError;
    }
    this.lastEventSeq = event.seq;
    return clone(event);
  }

  #writeSnapshot() {
    const snapshot = {
      schemaVersion: STORE_SCHEMA_VERSION,
      lastSeq: this.lastEventSeq,
      modelProviders: [...this.modelProviders.values()].map(clone),
      runtimeAccounts: [...this.runtimeAccounts.values()].map(clone),
      runtimeAccountTombstones: [...this.runtimeAccountTombstones.values()].map(clone),
      agentProfiles: [...this.agentProfiles.values()].map(clone),
      workRuns: [...this.workRuns.values()].map(clone),
      runNotes: [...this.runNotes.values()].map(clone),
      mcpToolCalls: [...this.mcpToolCalls.values()].map(clone),
    };
    snapshot.checksum = snapshotChecksum(snapshot);
    for (const run of this.workRuns.values()) {
      this.#assertActiveThreadUnique(run, "STORE_CORRUPT_SNAPSHOT");
    }
    this.#assertNoSensitiveFields(snapshot, false);
    const tempPath = `${this.paths.stateSnapshotPath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    const logTempPath = `${this.paths.eventLogPath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    let fd;
    let logFd;
    try {
      fd = this.#openNewSafe(
        tempPath,
        this.fs.constants.O_CREAT | this.fs.constants.O_EXCL | this.fs.constants.O_WRONLY,
      );
      writeFully(this.fs, fd, `${JSON.stringify(snapshot)}\n`);
      this.fs.fchmodSync(fd, 0o600);
      this.fs.fsyncSync(fd);
      this.fs.closeSync(fd);
      fd = undefined;
      this.#assertSafeExistingPath(this.paths.stateSnapshotPath, true);
      this.fs.renameSync(tempPath, this.paths.stateSnapshotPath);
      this.#fsyncStateDirectory();
      logFd = this.#openNewSafe(
        logTempPath,
        this.fs.constants.O_CREAT | this.fs.constants.O_EXCL | this.fs.constants.O_WRONLY,
      );
      this.fs.fsyncSync(logFd);
      this.fs.closeSync(logFd);
      logFd = undefined;
      this.#assertSafeExistingPath(this.paths.eventLogPath);
      this.fs.renameSync(logTempPath, this.paths.eventLogPath);
      this.#fsyncStateDirectory();
    } finally {
      if (fd !== undefined) this.fs.closeSync(fd);
      if (logFd !== undefined) this.fs.closeSync(logFd);
      try { this.fs.unlinkSync(tempPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
      try { this.fs.unlinkSync(logTempPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }

  #lstatIfExists(target) {
    try { return this.fs.lstatSync(target); } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  #validateSafeFileStat(stat, target) {
    if (stat.isSymbolicLink?.()) throw storeError("UNSAFE_SYMLINK", `拒绝状态文件 symlink: ${target}`);
    if (!stat.isFile?.()) throw storeError("UNSAFE_PATH", `状态路径不是普通文件: ${target}`);
    if (stat.nlink !== 1) throw storeError("UNSAFE_HARDLINK", `拒绝状态文件 hardlink: ${target}`);
    return stat;
  }

  #openExistingSafe(target, flags) {
    const before = this.#validateSafeFileStat(this.fs.lstatSync(target), target);
    const noFollow = this.fs.constants.O_NOFOLLOW || 0;
    let fd;
    try {
      fd = this.fs.openSync(target, flags | noFollow);
      const opened = this.#validateSafeFileStat(this.fs.fstatSync(fd), target);
      if (before.dev !== opened.dev || before.ino !== opened.ino) {
        throw storeError("UNSAFE_PATH", `状态文件 inode 在打开时变化: ${target}`);
      }
      return fd;
    } catch (error) {
      if (fd !== undefined) this.fs.closeSync(fd);
      if (error.code === "ELOOP") throw storeError("UNSAFE_SYMLINK", `拒绝状态文件 symlink: ${target}`);
      throw error;
    }
  }

  #openNewSafe(target, flags) {
    const noFollow = this.fs.constants.O_NOFOLLOW || 0;
    let fd;
    try {
      fd = this.fs.openSync(target, flags | noFollow, 0o600);
      this.#validateSafeFileStat(this.fs.fstatSync(fd), target);
      this.fs.fchmodSync(fd, 0o600);
      return fd;
    } catch (error) {
      if (fd !== undefined) this.fs.closeSync(fd);
      if (error.code === "ELOOP") throw storeError("UNSAFE_SYMLINK", `拒绝状态文件 symlink: ${target}`);
      throw error;
    }
  }

  #assertSafeExistingPath(target, allowMissing = false) {
    const stat = this.#lstatIfExists(target);
    if (!stat) {
      if (allowMissing) return;
      throw storeError("UNSAFE_PATH", `状态文件不存在: ${target}`);
    }
    const fd = this.#openExistingSafe(target, this.fs.constants.O_RDONLY);
    this.fs.closeSync(fd);
  }

  #fsyncStateDirectory() {
    const dirFd = this.fs.openSync(path.dirname(this.paths.stateSnapshotPath), this.fs.constants.O_RDONLY);
    try { this.fs.fsyncSync(dirFd); } finally { this.fs.closeSync(dirFd); }
  }

  #assertNoSensitiveFields(value, includeRequiredMatcher = true) {
    assertNoSensitiveFields(value, "payload", new Set(), (candidate) => {
      const candidateBytes = Buffer.from(candidate, "utf8");
      let matched = false;
      for (const registered of this.sensitiveValueBuffers) {
        if (candidateBytes.length < registered.length) continue;
        for (let offset = 0; offset <= candidateBytes.length - registered.length; offset += 1) {
          matched = crypto.timingSafeEqual(
            candidateBytes.subarray(offset, offset + registered.length),
            registered,
          ) || matched;
        }
      }
      if (matched) return true;
      const matchers = includeRequiredMatcher
        ? [this.isSensitiveValue, this.activeSensitiveValueMatcher || this.requiredSensitiveValueMatcher]
        : [this.isSensitiveValue];
      for (const matcher of matchers) {
        if (!matcher) continue;
        try {
          if (matcher(candidate) === true) return true;
        } catch {
          throw storeError("STORE_SENSITIVE_VALUE_CHECK_FAILED", "敏感值判定器执行失败");
        }
      }
      return false;
    });
  }
}

module.exports = {
  AGENT_PROFILE_FIELDS,
  BACKEND_ID_PATTERN,
  DEFAULT_AGENT_PROFILE_ID,
  DEFAULT_AGENT_PROFILE_UUID,
  DEFAULT_RUNTIME_PROFILE_ID,
  JsonlProductStore,
  MCP_TOOL_CALL_FIELDS,
  MODEL_PROVIDER_FIELDS,
  MODEL_PROVIDER_KINDS,
  MODEL_PROVIDER_VALIDATION_STATUSES,
  ProductStore,
  PROFILE_BACKEND_MIGRATION_SOURCE_SCHEMA_VERSION,
  PROFILE_PROVIDER_AUTHORITY_SCHEMA_VERSION,
  RUNTIME_ACCOUNT_MIGRATION_SOURCE_SCHEMA_VERSION,
  RUNTIME_ACCOUNT_STORE_SCHEMA_VERSION,
  RUN_NOTE_FIELDS,
  STORE_SCHEMA_VERSION,
  WORK_RUN_FIELDS,
  assertNoSensitiveFields,
  defaultAgentProfile,
  eventChecksum,
  snapshotChecksum,
  storeError,
  validateModelProvider,
  validateMcpToolCall,
  validateRunNote,
  validateWorkRun,
};
