"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  atomicWritePrivateFile,
  preparePrivateParent,
  readPrivateFile,
  recoverInterruptedPrivateFile,
  statIfExists,
} = require("./private-file");
const { acquirePrivateWriterLease } = require("./private-writer-lease");
const { serviceError } = require("./security");
const { validModelSettings } = require("./chat-model-settings");

const CHAT_SESSION_STORE_VERSION = 6;
const MODEL_SETTINGS_SESSION_STORE_VERSION = 5;
const LEGACY_CHAT_SESSION_STORE_VERSION = 1;
const PREVIOUS_CHAT_SESSION_STORE_VERSION = 2;
const RUNTIME_SESSION_STORE_VERSION = 3;
const PERMISSION_SESSION_STORE_VERSION = 4;
const MAX_CHAT_SESSION_STORE_BYTES = 16 * 1024 * 1024;
// Transcript/Chat 管理面需要覆盖至少 5k 个持久会话；保留 2 的幂次硬上限，
// 同时继续受 16 MiB 容器字节门禁约束，避免把容量提升变成无界状态。
const MAX_CHAT_SESSIONS = 8192;
const MAX_ACTIVE_CREATE_OPERATIONS = MAX_CHAT_SESSIONS;
const MAX_DELETED_CREATE_OPERATIONS = 4096;
const MAX_TERMINAL_BINDING_OPERATIONS = 4096;
const MAX_COMPLETED_REMOTE_OPERATIONS = 256;
const MAX_CRON_SESSION_BINDINGS = 65_536;
const IDEMPOTENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_OPERATION_FUTURE_SKEW_MS = 5 * 60 * 1000;
const SESSION_FIELDS = Object.freeze([
  "id", "sessionKey", "profileId", "runtimeSessionId", "workspace",
  "title", "modelOverride", "permissionMode", "status", "createdAt", "updatedAt",
]);
const RUNTIME_SESSION_FIELDS = Object.freeze(
  SESSION_FIELDS.filter((field) => field !== "permissionMode"),
);
const PREVIOUS_SESSION_FIELDS = Object.freeze([
  "id", "sessionKey", "profileId", "codexThreadId", "workspace",
  "title", "modelOverride", "status", "createdAt", "updatedAt",
]);
const LEGACY_SESSION_FIELDS = Object.freeze(
  PREVIOUS_SESSION_FIELDS.filter((field) => field !== "modelOverride"),
);
const SESSION_STATUSES = new Set(["draft", "binding", "ready", "archived", "delete_pending"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BINDING_FIELDS = Object.freeze([
  "operationId", "sessionKey", "threadSource", "state", "runtimeSessionId",
  "createdAt", "updatedAt", "finishedAt",
]);
const LEGACY_BINDING_FIELDS = Object.freeze([
  "operationId", "sessionKey", "threadSource", "state", "codexThreadId",
  "createdAt", "updatedAt", "finishedAt",
]);
const REMOTE_OPERATION_FIELDS = Object.freeze([
  "operationId", "sessionKey", "kind", "title", "state", "createdAt", "updatedAt", "finishedAt",
]);
const CREATE_OPERATION_FIELDS = Object.freeze([
  "operationId", "profileId", "workspace", "sessionKey", "state", "createdAt", "finishedAt",
]);

function chatSessionError(code, message) {
  return serviceError(code, message);
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function clone(value) {
  if (value === null || value === undefined) return value;
  const cloned = structuredClone(value);
  if (Object.prototype.hasOwnProperty.call(cloned, "runtimeSessionId")) {
    const runtimeSessionId = cloned.runtimeSessionId;
    delete cloned.runtimeSessionId;
    Object.defineProperty(cloned, "runtimeSessionId", {
      configurable: false,
      enumerable: false,
      value: runtimeSessionId,
      writable: false,
    });
    Object.defineProperty(cloned, "codexThreadId", {
      configurable: false,
      enumerable: true,
      value: runtimeSessionId,
      writable: false,
    });
  }
  return cloned;
}

function validOpaqueId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function validBindingOperationId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 64
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

function threadSourceFor(sessionKey, operationId) {
  return `shoggoth:${sessionKey}:${operationId}`;
}

function validNullableText(value, maxLength) {
  return value === null || (typeof value === "string" && value.length > 0
    && value.length <= maxLength && !value.includes("\0"));
}

function normalizeSession(input, corrupt = false, version = CHAT_SESSION_STORE_VERSION) {
  const fail = () => {
    throw chatSessionError(
      corrupt ? "CHAT_SESSION_STORE_CORRUPT" : "CHAT_SESSION_INVALID",
      "ChatSession 数据无效",
    );
  };
  let fields = version === LEGACY_CHAT_SESSION_STORE_VERSION
    ? LEGACY_SESSION_FIELDS
    : version === PREVIOUS_CHAT_SESSION_STORE_VERSION
      ? PREVIOUS_SESSION_FIELDS
      : version === RUNTIME_SESSION_STORE_VERSION ? RUNTIME_SESSION_FIELDS : SESSION_FIELDS;
  const hasSettings = version >= MODEL_SETTINGS_SESSION_STORE_VERSION && Object.hasOwn(input || {}, "modelSettings");
  if (hasSettings) fields = [...fields, "modelSettings"];
  const runtimeSessionId = version >= RUNTIME_SESSION_STORE_VERSION
    ? input?.runtimeSessionId : input?.codexThreadId;
  if (!exactObject(input, fields) || (hasSettings && !validModelSettings(input.modelSettings))
    || !UUID_PATTERN.test(input.id) || !UUID_PATTERN.test(input.sessionKey)
    || !validOpaqueId(input.profileId)
    || !validNullableText(runtimeSessionId, 512)
    || !validNullableText(input.workspace, 4096)
    || !validNullableText(input.title, 512)
    || (version !== LEGACY_CHAT_SESSION_STORE_VERSION
      && !validNullableText(input.modelOverride, 512))
    || (version >= PERMISSION_SESSION_STORE_VERSION
      && !validNullableText(input.permissionMode, 64))
    || !SESSION_STATUSES.has(input.status)
    || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0
    || !Number.isSafeInteger(input.updatedAt) || input.updatedAt < input.createdAt) fail();
  return Object.fromEntries([...SESSION_FIELDS, ...(hasSettings ? ["modelSettings"] : [])].map((field) => [
    field,
    field === "runtimeSessionId"
      ? runtimeSessionId
      : field === "modelOverride" && version === LEGACY_CHAT_SESSION_STORE_VERSION
        ? null
        : field === "permissionMode" && version < PERMISSION_SESSION_STORE_VERSION
          ? null : input[field],
  ]));
}

function normalizeBindingOperation(
  input,
  corrupt = false,
  version = CHAT_SESSION_STORE_VERSION,
) {
  const code = corrupt ? "CHAT_SESSION_STORE_CORRUPT" : "CHAT_BINDING_INVALID";
  const fields = version >= RUNTIME_SESSION_STORE_VERSION ? BINDING_FIELDS : LEGACY_BINDING_FIELDS;
  const runtimeSessionId = version >= RUNTIME_SESSION_STORE_VERSION
    ? input?.runtimeSessionId : input?.codexThreadId;
  if (!exactObject(input, fields) || !validBindingOperationId(input.operationId)
    || !UUID_PATTERN.test(input.sessionKey) || !["pending", "bound"].includes(input.state)
    || input.threadSource !== threadSourceFor(input.sessionKey, input.operationId)
    || input.threadSource.length > 112
    || !validNullableText(runtimeSessionId, 512)
    || (input.state === "pending" && runtimeSessionId !== null)
    || (input.state === "bound" && runtimeSessionId === null)
    || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0
    || !Number.isSafeInteger(input.updatedAt) || input.updatedAt < input.createdAt
    || (input.state === "pending" && input.finishedAt !== null)
    || (input.state === "bound" && (!Number.isSafeInteger(input.finishedAt)
      || input.finishedAt < input.createdAt || input.updatedAt < input.finishedAt))) {
    throw chatSessionError(code, "ChatSession binding 数据无效");
  }
  return Object.fromEntries(BINDING_FIELDS.map((field) => [
    field,
    field === "runtimeSessionId" ? runtimeSessionId : input[field],
  ]));
}

function normalizeRemoteOperation(input, corrupt = false) {
  const code = corrupt ? "CHAT_SESSION_STORE_CORRUPT" : "CHAT_REMOTE_OPERATION_INVALID";
  if (!exactObject(input, REMOTE_OPERATION_FIELDS) || !validOpaqueId(input.operationId)
    || !UUID_PATTERN.test(input.sessionKey)
    || !["rename", "archive", "delete"].includes(input.kind)
    || !["pending", "completed"].includes(input.state)
    || (input.kind === "rename"
      ? !validNullableText(input.title, 512)
      : input.title !== null)
    || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0
    || !Number.isSafeInteger(input.updatedAt) || input.updatedAt < input.createdAt
    || (input.state === "pending" && input.finishedAt !== null)
    || (input.state === "completed" && (!Number.isSafeInteger(input.finishedAt)
      || input.finishedAt < input.createdAt || input.updatedAt < input.finishedAt))) {
    throw chatSessionError(code, "ChatSession remote operation 数据无效");
  }
  return Object.fromEntries(REMOTE_OPERATION_FIELDS.map((field) => [field, input[field]]));
}

function normalizeCreateOperation(input, corrupt = false) {
  const code = corrupt ? "CHAT_SESSION_STORE_CORRUPT" : "CHAT_SESSION_INVALID";
  if (!exactObject(input, CREATE_OPERATION_FIELDS) || !validOpaqueId(input.operationId)
    || !validOpaqueId(input.profileId) || !validNullableText(input.workspace, 4096)
    || !UUID_PATTERN.test(input.sessionKey) || !["active", "deleted"].includes(input.state)
    || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0
    || (input.state === "active" && input.finishedAt !== null)
    || (input.state === "deleted"
      && (!Number.isSafeInteger(input.finishedAt) || input.finishedAt < input.createdAt))) {
    throw chatSessionError(code, "ChatSession create operation 数据无效");
  }
  return Object.fromEntries(CREATE_OPERATION_FIELDS.map((field) => [field, input[field]]));
}

function validateContainer(value) {
  if (!exactObject(value, [
    "version", "revision", "idempotencyFloorMs", "sessions",
    "createOperations", "bindingOperations", "remoteOperations",
    ...(value?.version >= CHAT_SESSION_STORE_VERSION ? ["cronRuns"] : []),
  ])
    || ![
      LEGACY_CHAT_SESSION_STORE_VERSION,
      PREVIOUS_CHAT_SESSION_STORE_VERSION,
      RUNTIME_SESSION_STORE_VERSION,
      PERMISSION_SESSION_STORE_VERSION,
      MODEL_SETTINGS_SESSION_STORE_VERSION,
      CHAT_SESSION_STORE_VERSION,
    ].includes(value.version)
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Number.isSafeInteger(value.idempotencyFloorMs) || value.idempotencyFloorMs < 0
    || !value.sessions || typeof value.sessions !== "object" || Array.isArray(value.sessions)
    || Object.getPrototypeOf(value.sessions) !== Object.prototype
    || Object.keys(value.sessions).length > MAX_CHAT_SESSIONS
    || !value.createOperations || typeof value.createOperations !== "object"
    || Array.isArray(value.createOperations)
    || Object.getPrototypeOf(value.createOperations) !== Object.prototype
    || Object.keys(value.createOperations).length
      > MAX_ACTIVE_CREATE_OPERATIONS + MAX_DELETED_CREATE_OPERATIONS
    || !value.bindingOperations || typeof value.bindingOperations !== "object"
    || Array.isArray(value.bindingOperations)
    || Object.getPrototypeOf(value.bindingOperations) !== Object.prototype
    || Object.keys(value.bindingOperations).length
      > MAX_CHAT_SESSIONS + MAX_TERMINAL_BINDING_OPERATIONS
    || !value.remoteOperations || typeof value.remoteOperations !== "object"
    || Array.isArray(value.remoteOperations)
    || Object.getPrototypeOf(value.remoteOperations) !== Object.prototype
    || Object.keys(value.remoteOperations).length > MAX_CHAT_SESSIONS + MAX_COMPLETED_REMOTE_OPERATIONS) {
    throw chatSessionError("CHAT_SESSION_STORE_CORRUPT", "ChatSession 容器损坏");
  }
  const sessions = {};
  const ids = new Set();
  const threadIds = new Set();
  for (const [sessionKey, raw] of Object.entries(value.sessions)) {
    const session = normalizeSession(raw, true, value.version);
    if (session.sessionKey !== sessionKey || ids.has(session.id)
      || (session.runtimeSessionId !== null && threadIds.has(session.runtimeSessionId))) {
      throw chatSessionError("CHAT_SESSION_STORE_CORRUPT", "ChatSession 容器损坏");
    }
    ids.add(session.id);
    if (session.runtimeSessionId !== null) threadIds.add(session.runtimeSessionId);
    sessions[sessionKey] = session;
  }
  const createOperations = {};
  let activeCreateCount = 0;
  let deletedCreateCount = 0;
  const sessionCreateKeys = new Set();
  const operationIds = new Set();
  for (const [operationId, raw] of Object.entries(value.createOperations)) {
    const operation = normalizeCreateOperation(raw, true);
    const session = sessions[operation.sessionKey];
    if (operation.operationId !== operationId || operationIds.has(operationId)
      || sessionCreateKeys.has(operation.sessionKey)
      || (operation.state === "active" && (!session
        || session.profileId !== operation.profileId || session.workspace !== operation.workspace))
      || (operation.state === "deleted" && session)) {
      throw chatSessionError("CHAT_SESSION_STORE_CORRUPT", "ChatSession 容器损坏");
    }
    operationIds.add(operationId);
    sessionCreateKeys.add(operation.sessionKey);
    if (operation.state === "active") activeCreateCount += 1;
    else deletedCreateCount += 1;
    createOperations[operationId] = operation;
  }
  if (activeCreateCount > MAX_ACTIVE_CREATE_OPERATIONS
    || deletedCreateCount > MAX_DELETED_CREATE_OPERATIONS) {
    throw chatSessionError("CHAT_SESSION_STORE_CORRUPT", "ChatSession create operation 容量无效");
  }
  if (Object.keys(sessions).some((sessionKey) => !sessionCreateKeys.has(sessionKey))) {
    throw chatSessionError("CHAT_SESSION_STORE_CORRUPT", "ChatSession 缺少 create operation");
  }
  const bindingOperations = {};
  let pendingBindingCount = 0;
  let boundBindingCount = 0;
  for (const [sessionKey, raw] of Object.entries(value.bindingOperations)) {
    const operation = normalizeBindingOperation(raw, true, value.version);
    const session = sessions[sessionKey];
    const detachedSession = operation.state === "bound"
      && session?.runtimeSessionId === null
      && ["ready", "archived", "delete_pending"].includes(session.status);
    if (operation.sessionKey !== sessionKey || operationIds.has(operation.operationId)
      || (operation.state === "pending" && (!session || session.status !== "binding"))
      || (operation.state === "bound"
        && session && !detachedSession && (session.runtimeSessionId !== operation.runtimeSessionId
          || session.status === "binding"))) {
      throw chatSessionError("CHAT_SESSION_STORE_CORRUPT", "ChatSession 容器损坏");
    }
    operationIds.add(operation.operationId);
    if (operation.state === "pending") pendingBindingCount += 1;
    else boundBindingCount += 1;
    bindingOperations[sessionKey] = operation;
  }
  if (pendingBindingCount > MAX_CHAT_SESSIONS
    || boundBindingCount > MAX_TERMINAL_BINDING_OPERATIONS) {
    throw chatSessionError("CHAT_SESSION_STORE_CORRUPT", "ChatSession binding operation 容量无效");
  }
  for (const [sessionKey, session] of Object.entries(sessions)) {
    const binding = bindingOperations[sessionKey] || null;
    const draftInvariant = session.status === "draft"
      && session.runtimeSessionId === null && binding === null;
    const bindingInvariant = session.status === "binding"
      && session.runtimeSessionId === null && binding?.state === "pending";
    const boundInvariant = ["ready", "archived", "delete_pending"].includes(session.status)
      && session.runtimeSessionId !== null && binding?.state === "bound"
      && binding.runtimeSessionId === session.runtimeSessionId;
    // RuntimeAccount migration intentionally detaches the rebuildable Runtime
    // session while retaining the old bound operation as crash-recovery
    // evidence until the next semantic continuation replaces it.
    const detachedInvariant = ["ready", "archived", "delete_pending"].includes(session.status)
      && session.runtimeSessionId === null && binding?.state === "bound";
    if (!draftInvariant && !bindingInvariant && !boundInvariant && !detachedInvariant) {
      throw chatSessionError("CHAT_SESSION_STORE_CORRUPT", "ChatSession binding 反向不变量无效");
    }
  }
  const remoteOperations = {};
  let pendingRemoteCount = 0;
  let completedRemoteCount = 0;
  for (const [operationId, raw] of Object.entries(value.remoteOperations)) {
    const operation = normalizeRemoteOperation(raw, true);
    const session = sessions[operation.sessionKey];
    if (operation.operationId !== operationId || operationIds.has(operationId)
      || (operation.state === "pending" && !session)
      || (operation.state === "pending" && operation.kind === "rename"
        && session.title !== operation.title)
      || (operation.state === "pending" && operation.kind === "archive"
        && session.status !== "archived")
      || (operation.state === "pending" && operation.kind === "delete"
        && session.status !== "delete_pending")
      || (operation.state === "pending" && !session)) {
      throw chatSessionError("CHAT_SESSION_STORE_CORRUPT", "ChatSession 容器损坏");
    }
    operationIds.add(operationId);
    if (operation.state === "pending") pendingRemoteCount += 1;
    else completedRemoteCount += 1;
    remoteOperations[operationId] = operation;
  }
  if (pendingRemoteCount > MAX_CHAT_SESSIONS
    || completedRemoteCount > MAX_COMPLETED_REMOTE_OPERATIONS) {
    throw chatSessionError("CHAT_SESSION_STORE_CORRUPT", "ChatSession remote operation 容量无效");
  }
  const cronRuns = value.cronRuns ?? {};
  if (!cronRuns || typeof cronRuns !== "object" || Array.isArray(cronRuns)
    || Object.getPrototypeOf(cronRuns) !== Object.prototype
    || Object.keys(cronRuns).length > MAX_CRON_SESSION_BINDINGS) {
    throw chatSessionError("CHAT_SESSION_STORE_CORRUPT", "Cron session bindings 无效");
  }
  const cronOwners = new Map();
  for (const [runId, binding] of Object.entries(cronRuns)) {
    const session = sessions[binding?.sessionKey];
    if (!exactObject(binding, ["runId", "jobId", "profileId", "workspace", "sessionKey", "threadSource"])
      || binding.runId !== runId || !validOpaqueId(runId) || !validOpaqueId(binding.jobId)
      || !validOpaqueId(binding.profileId) || !UUID_PATTERN.test(binding.sessionKey)
      || !validNullableText(binding.workspace, 4096) || !validNullableText(binding.threadSource, 512)
      || (session && (session.profileId !== binding.profileId || session.workspace !== binding.workspace))
      || (cronOwners.has(binding.sessionKey) && cronOwners.get(binding.sessionKey) !== binding.jobId)) {
      throw chatSessionError("CHAT_SESSION_STORE_CORRUPT", "Cron session ownership 无效");
    }
    cronOwners.set(binding.sessionKey, binding.jobId);
  }
  return {
    version: CHAT_SESSION_STORE_VERSION,
    revision: value.revision,
    idempotencyFloorMs: value.idempotencyFloorMs,
    sessions,
    createOperations,
    bindingOperations,
    remoteOperations,
    cronRuns: structuredClone(cronRuns),
  };
}

class ChatSessionStore {
  constructor(options = {}) {
    if (!options.paths?.stateDir || !options.paths?.trustedRoot) {
      throw chatSessionError("CHAT_SESSION_PATHS_REQUIRED", "ChatSessionStore 需要 Service paths");
    }
    this.paths = options.paths;
    this.filePath = path.join(this.paths.stateDir, "chat-sessions.json");
    this.fs = options.fs || fs;
    this.atomicWrite = options.atomicWrite || atomicWritePrivateFile;
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.acquireWriterLease = options.acquireWriterLease || acquirePrivateWriterLease;
    this.writerLease = null;
    this.cleanupPending = false;
    this.maxCompletedRemoteOperations = options.maxCompletedRemoteOperations
      ?? MAX_COMPLETED_REMOTE_OPERATIONS;
    this.maxDeletedCreateOperations = options.maxDeletedCreateOperations
      ?? MAX_DELETED_CREATE_OPERATIONS;
    this.maxTerminalBindingOperations = options.maxTerminalBindingOperations
      ?? MAX_TERMINAL_BINDING_OPERATIONS;
    if (!Number.isSafeInteger(this.maxCompletedRemoteOperations)
      || this.maxCompletedRemoteOperations <= 0
      || this.maxCompletedRemoteOperations > MAX_COMPLETED_REMOTE_OPERATIONS) {
      throw chatSessionError("CHAT_SESSION_CAPACITY_INVALID", "remote operation 容量配置无效");
    }
    if (!Number.isSafeInteger(this.maxDeletedCreateOperations)
      || this.maxDeletedCreateOperations <= 0
      || this.maxDeletedCreateOperations > MAX_DELETED_CREATE_OPERATIONS) {
      throw chatSessionError("CHAT_SESSION_CAPACITY_INVALID", "deleted create operation 容量配置无效");
    }
    if (!Number.isSafeInteger(this.maxTerminalBindingOperations)
      || this.maxTerminalBindingOperations <= 0
      || this.maxTerminalBindingOperations > MAX_TERMINAL_BINDING_OPERATIONS) {
      throw chatSessionError("CHAT_SESSION_CAPACITY_INVALID", "terminal binding operation 容量配置无效");
    }
    this.opened = false;
    this.commitUncertain = false;
    this.container = this.#emptyContainer();
    this.cronOriginIndex = null;
  }

  open() {
    if (this.opened) return this;
    preparePrivateParent(this.filePath, this.paths.trustedRoot, this.fs);
    const lease = this.acquireWriterLease({
      lockPath: path.join(this.paths.stateDir, "chat-sessions.writer.lock"),
      trustedRoot: this.paths.trustedRoot,
      fs: this.fs,
    });
    try {
      const recovery = recoverInterruptedPrivateFile(this.filePath, {
        fs: this.fs,
        trustedRoot: this.paths.trustedRoot,
      });
      const stat = statIfExists(this.fs, this.filePath);
      this.container = stat ? this.#parse(readPrivateFile(this.filePath, {
        fs: this.fs,
        maxBytes: MAX_CHAT_SESSION_STORE_BYTES,
      })) : this.#emptyContainer();
      this.commitUncertain = recovery === "uncertain";
      if (!this.commitUncertain) this.#refreshWindow(this.#currentTime(), Boolean(stat));
      this.writerLease = lease;
      this.cleanupPending = false;
      this.opened = true;
      return this;
    } catch (openError) {
      try {
        lease.release();
      } catch (releaseError) {
        this.writerLease = lease;
        this.cleanupPending = true;
        this.opened = false;
        const cleanupError = chatSessionError(
          "LEASE_RELEASE_FAILED",
          "ChatSessionStore open 失败后的 writer lease 清理失败",
        );
        cleanupError.cause = releaseError;
        throw new AggregateError(
          [openError, cleanupError],
          "ChatSessionStore open 与 writer lease 清理均失败",
        );
      }
      this.writerLease = null;
      this.cleanupPending = false;
      throw openError;
    }
  }

  close() {
    const lease = this.writerLease;
    if (lease) {
      try {
        lease.release();
      } catch (error) {
        this.cleanupPending = true;
        throw error;
      }
    }
    this.writerLease = null;
    this.cleanupPending = false;
    this.opened = false;
  }

  createSession(input) {
    this.#assertOpen();
    if (!exactObject(input, ["operationId", "profileId", "workspace", "createdAt"])
      || !validOpaqueId(input.operationId) || !validOpaqueId(input.profileId)
      || !validNullableText(input.workspace, 4096)
      || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
      throw chatSessionError("CHAT_SESSION_INVALID", "createSession 输入无效");
    }
    const time = this.#prepareOperation(input.createdAt);
    const indexed = this.#findOperation(input.operationId);
    if (indexed) {
      if (indexed.kind !== "create") {
        throw chatSessionError("CHAT_OPERATION_ID_CONFLICT", "operationId 已用于其他操作");
      }
      const existingOperation = indexed.operation;
      if (existingOperation.profileId !== input.profileId
        || existingOperation.workspace !== input.workspace
        || existingOperation.createdAt !== input.createdAt) {
        throw chatSessionError("CHAT_OPERATION_ID_CONFLICT", "create operationId 已用于不同输入");
      }
      if (existingOperation.state === "deleted") {
        throw chatSessionError("CHAT_SESSION_DELETED", "幂等创建对应的 ChatSession 已删除");
      }
      return clone(this.container.sessions[existingOperation.sessionKey]);
    }
    this.#assertNotExpired(input.createdAt);
    if (Object.keys(this.container.sessions).length >= MAX_CHAT_SESSIONS) {
      throw chatSessionError("CHAT_SESSION_CAPACITY", "ChatSession 容量已满");
    }
    if (Object.values(this.container.createOperations)
      .filter((operation) => operation.state === "active").length
      >= MAX_ACTIVE_CREATE_OPERATIONS) {
      throw chatSessionError("CHAT_SESSION_CAPACITY", "ChatSession create operation 容量已满");
    }
    const session = normalizeSession({
      id: this.randomUUID(),
      sessionKey: this.randomUUID(),
      profileId: input.profileId,
      runtimeSessionId: null,
      workspace: input.workspace,
      title: null,
      modelOverride: null,
      permissionMode: null,
      status: "draft",
      createdAt: time,
      updatedAt: time,
    });
    const operation = normalizeCreateOperation({
      operationId: input.operationId,
      profileId: input.profileId,
      workspace: input.workspace,
      sessionKey: session.sessionKey,
      state: "active",
      createdAt: input.createdAt,
      finishedAt: null,
    });
    if (this.container.sessions[session.sessionKey]
      || Object.values(this.container.sessions).some((item) => item.id === session.id)) {
      throw chatSessionError("CHAT_SESSION_ID_CONFLICT", "ChatSession ID 冲突");
    }
    const candidate = {
      ...this.container,
      revision: this.container.revision + 1,
      sessions: { ...this.container.sessions, [session.sessionKey]: session },
      createOperations: {
        ...this.container.createOperations,
        [operation.operationId]: operation,
      },
    };
    this.container = this.#write(candidate);
    return clone(session);
  }

  getSession(sessionKey) {
    this.#assertOpen();
    if (!UUID_PATTERN.test(sessionKey)) {
      throw chatSessionError("CHAT_SESSION_INVALID", "sessionKey 无效");
    }
    return clone(this.container.sessions[sessionKey] || null);
  }

  getCronRunBinding(runId) {
    this.#assertOpen();
    return clone(this.container.cronRuns[runId] || null);
  }

  getCronSessionOrigin(sessionKey) {
    this.#assertOpen();
    if (!this.cronOriginIndex) {
      this.cronOriginIndex = new Map();
      for (const item of Object.values(this.container.cronRuns)) {
        if (!this.cronOriginIndex.has(item.sessionKey)) this.cronOriginIndex.set(item.sessionKey,
          { cronJobId: item.jobId, cronRunIds: [] });
        this.cronOriginIndex.get(item.sessionKey).cronRunIds.push(item.runId);
      }
    }
    return clone(this.cronOriginIndex.get(sessionKey) || null);
  }

  touchCronSession(runId, occurredAt) {
    this.#assertOpen();
    const binding = this.container.cronRuns[runId];
    const session = binding && this.container.sessions[binding.sessionKey];
    if (!session || !Number.isSafeInteger(occurredAt) || occurredAt <= session.updatedAt) return;
    this.container = this.#write({ ...this.container, revision: this.container.revision + 1,
      sessions: { ...this.container.sessions, [session.sessionKey]: { ...session, updatedAt: occurredAt } } });
  }

  // Keep the per-run association even after a user deletes a conversation:
  // history recovery must never resurrect it or replay the task.
  ensureCronSession(input) {
    this.#assertOpen();
    if (!exactObject(input, ["runId", "jobId", "profileId", "workspace", "threadSource", "runtimeSessionId"])
      || !validOpaqueId(input.runId) || !validOpaqueId(input.jobId) || !validOpaqueId(input.profileId)
      || !validNullableText(input.workspace, 4096) || !validNullableText(input.threadSource, 512)
      || !validNullableText(input.runtimeSessionId, 512)) {
      throw chatSessionError("CHAT_SESSION_INVALID", "Cron session 输入无效");
    }
    const previous = this.container.cronRuns[input.runId];
    if (previous && (["jobId", "profileId", "workspace"].some((field) => previous[field] !== input[field])
      || (previous.threadSource !== null && input.threadSource !== null && previous.threadSource !== input.threadSource))) {
      throw chatSessionError("CHAT_SESSION_BINDING_CONFLICT", "Cron run 已绑定其他会话归属");
    }
    let session = previous ? this.getSession(previous.sessionKey) : null;
    if (previous && !session) return null;
    if (!previous) {
      if (Object.keys(this.container.cronRuns).length >= MAX_CRON_SESSION_BINDINGS) {
        throw chatSessionError("CHAT_SESSION_CAPACITY", "Cron session bindings 容量已满");
      }
      const bindings = Object.values(this.container.cronRuns).filter((item) => item.jobId === input.jobId
        && item.profileId === input.profileId && item.workspace === input.workspace);
      session = bindings.map((item) => ({ item, session: this.getSession(item.sessionKey) }))
        .find(({ item, session: candidate }) => candidate && (
          (input.runtimeSessionId !== null && candidate.runtimeSessionId === input.runtimeSessionId)
          || (input.threadSource !== null && item.threadSource === input.threadSource)
        ))?.session || null;
      if (!session) {
        const operationId = `cron-session-${crypto.createHash("sha256").update(input.runId).digest("hex")}`;
        const operation = this.container.createOperations[operationId];
        if (operation?.state === "deleted") return null;
        session = this.createSession({ operationId, profileId: input.profileId, workspace: input.workspace,
          createdAt: operation?.createdAt ?? this.#currentTime() });
      }
      this.container = this.#write({ ...this.container, revision: this.container.revision + 1,
        cronRuns: { ...this.container.cronRuns, [input.runId]: {
          runId: input.runId, jobId: input.jobId, profileId: input.profileId,
          workspace: input.workspace, sessionKey: session.sessionKey, threadSource: input.threadSource,
        } } });
    }
    if (input.runtimeSessionId !== null) {
      if (!["draft", "binding", "ready"].includes(session.status)) return session;
      let binding = this.getBinding(session.sessionKey);
      if (!binding) binding = this.requestBinding(session.sessionKey,
        `cron-bind-${crypto.createHash("sha256").update(session.sessionKey).digest("hex").slice(0,40)}`,
        this.#currentTime());
      if (binding.state === "pending") this.completeBinding(session.sessionKey, binding.operationId, input.runtimeSessionId);
      else if (session.runtimeSessionId !== input.runtimeSessionId) this.replaceBoundRuntimeSession({
        sessionKey: session.sessionKey, operationId: binding.operationId,
        expectedRuntimeSessionId: session.runtimeSessionId, runtimeSessionId: input.runtimeSessionId,
      });
    }
    return this.getSession(session.sessionKey);
  }

  setModelOverride(sessionKey, model) {
    this.#assertOpen();
    if (!UUID_PATTERN.test(sessionKey) || !validNullableText(model, 512) || model === null) {
      throw chatSessionError("CHAT_SESSION_INVALID", "session model 输入无效");
    }
    const session = this.container.sessions[sessionKey];
    if (!session) throw chatSessionError("CHAT_SESSION_NOT_FOUND", "ChatSession 不存在");
    if (!["draft", "binding", "ready"].includes(session.status)) {
      throw chatSessionError("CHAT_SESSION_NOT_READY", "ChatSession 当前不允许切换模型");
    }
    if (session.modelOverride === model) return clone(session);
    const time = this.#currentTime();
    this.#refreshWindow(time);
    const updated = normalizeSession({
      ...session,
      modelOverride: model,
      ...(session.modelSettings ? { modelSettings: { thinkingLevel: null, serviceTier: null } } : {}),
      updatedAt: Math.max(time, session.updatedAt),
    });
    const candidate = {
      ...this.container,
      revision: this.container.revision + 1,
      sessions: { ...this.container.sessions, [sessionKey]: updated },
    };
    this.container = this.#write(candidate);
    return clone(updated);
  }

  setModelSettings(sessionKey, modelSettings) {
    this.#assertOpen();
    if (!UUID_PATTERN.test(sessionKey) || !validModelSettings(modelSettings)) {
      throw chatSessionError("CHAT_SESSION_INVALID", "session model settings 无效");
    }
    const session = this.container.sessions[sessionKey];
    if (!session) throw chatSessionError("CHAT_SESSION_NOT_FOUND", "ChatSession 不存在");
    if (!["draft", "binding", "ready"].includes(session.status)) {
      throw chatSessionError("CHAT_SESSION_NOT_READY", "ChatSession 当前不允许修改模型设置");
    }
    const time = this.#currentTime();
    this.#refreshWindow(time);
    const updated = normalizeSession({ ...session, modelSettings: structuredClone(modelSettings),
      updatedAt: Math.max(time, session.updatedAt) });
    this.container = this.#write({ ...this.container, revision: this.container.revision + 1,
      sessions: { ...this.container.sessions, [sessionKey]: updated } });
    return clone(updated);
  }

  setPermissionMode(sessionKey, mode) {
    this.#assertOpen();
    if (!UUID_PATTERN.test(sessionKey) || !validNullableText(mode, 64) || mode === null) {
      throw chatSessionError("CHAT_SESSION_INVALID", "session permission mode 输入无效");
    }
    const session = this.container.sessions[sessionKey];
    if (!session) throw chatSessionError("CHAT_SESSION_NOT_FOUND", "ChatSession 不存在");
    if (!["draft", "binding", "ready"].includes(session.status)) {
      throw chatSessionError("CHAT_SESSION_NOT_READY", "ChatSession 当前不允许切换权限模式");
    }
    if (session.permissionMode === mode) return clone(session);
    const time = this.#currentTime();
    this.#refreshWindow(time);
    const updated = normalizeSession({
      ...session,
      permissionMode: mode,
      updatedAt: Math.max(time, session.updatedAt),
    });
    const candidate = {
      ...this.container,
      revision: this.container.revision + 1,
      sessions: { ...this.container.sessions, [sessionKey]: updated },
    };
    this.container = this.#write(candidate);
    return clone(updated);
  }

  getBinding(sessionKey) {
    this.#assertOpen();
    if (!UUID_PATTERN.test(sessionKey)) {
      throw chatSessionError("CHAT_SESSION_INVALID", "sessionKey 无效");
    }
    return clone(this.container.bindingOperations[sessionKey] || null);
  }

  listSessions() {
    this.#assertOpen();
    return Object.values(this.container.sessions).map(clone);
  }

  requestBinding(sessionKey, operationId, createdAt) {
    this.#assertOpen();
    if (!UUID_PATTERN.test(sessionKey) || !validBindingOperationId(operationId)
      || !Number.isSafeInteger(createdAt) || createdAt < 0) {
      throw chatSessionError("CHAT_BINDING_INVALID", "binding 输入无效");
    }
    const time = this.#prepareOperation(createdAt);
    const indexed = this.#findOperation(operationId);
    if (indexed) {
      if (indexed.kind !== "binding"
        || indexed.operation.sessionKey !== sessionKey
        || indexed.operation.createdAt !== createdAt) {
        throw chatSessionError("CHAT_OPERATION_ID_CONFLICT", "binding operationId 已用于不同输入");
      }
      return clone(indexed.operation);
    }
    this.#assertNotExpired(createdAt);
    const session = this.container.sessions[sessionKey];
    if (!session) throw chatSessionError("CHAT_SESSION_NOT_FOUND", "ChatSession 不存在");
    const existing = this.container.bindingOperations[sessionKey];
    const detached = session.status === "ready" && session.runtimeSessionId === null
      && existing?.state === "bound";
    if (existing && !detached) {
      throw chatSessionError("CHAT_SESSION_BINDING_CONFLICT", "ChatSession 已有 binding operation");
    }
    if (session.status !== "draft" && !detached) {
      throw chatSessionError("CHAT_SESSION_BINDING_CONFLICT", "ChatSession 当前状态不可绑定");
    }
    const operation = normalizeBindingOperation({
      operationId,
      sessionKey,
      threadSource: threadSourceFor(sessionKey, operationId),
      state: "pending",
      runtimeSessionId: null,
      createdAt,
      updatedAt: Math.max(time, createdAt),
      finishedAt: null,
    });
    const candidate = {
      ...this.container,
      revision: this.container.revision + 1,
      sessions: {
        ...this.container.sessions,
        [sessionKey]: { ...session, status: "binding", updatedAt: Math.max(time, session.updatedAt) },
      },
      bindingOperations: { ...this.container.bindingOperations, [sessionKey]: operation },
    };
    this.container = this.#write(candidate);
    return clone(operation);
  }

  detachRuntimeSession(input) {
    this.#assertOpen();
    if (!exactObject(input, ["sessionKey", "expectedRuntimeSessionId"])
      || !UUID_PATTERN.test(input.sessionKey)
      || !validNullableText(input.expectedRuntimeSessionId, 512)
      || input.expectedRuntimeSessionId === null) {
      throw chatSessionError("CHAT_BINDING_INVALID", "runtime session detach 输入无效");
    }
    const session = this.container.sessions[input.sessionKey];
    const operation = this.container.bindingOperations[input.sessionKey];
    if (!session) throw chatSessionError("CHAT_SESSION_NOT_FOUND", "ChatSession 不存在");
    const legacyBound = operation?.state === "bound"
      && operation.runtimeSessionId === input.expectedRuntimeSessionId
      && (session.runtimeSessionId === input.expectedRuntimeSessionId
        || session.runtimeSessionId === null);
    if (!["ready", "archived"].includes(session.status)
      || !legacyBound) {
      throw chatSessionError("CHAT_SESSION_BINDING_CONFLICT", "runtime session detach 前置状态已变化");
    }
    if (session.runtimeSessionId === null) return clone(session);
    const time = this.#currentTime();
    this.#refreshWindow(time);
    const updated = normalizeSession({
      ...session,
      runtimeSessionId: null,
      updatedAt: Math.max(time, session.updatedAt),
    });
    const candidate = {
      ...this.container,
      revision: this.container.revision + 1,
      sessions: { ...this.container.sessions, [input.sessionKey]: updated },
    };
    this.container = this.#write(candidate);
    return clone(updated);
  }

  completeBinding(sessionKey, operationId, runtimeSessionId) {
    this.#assertOpen();
    if (!UUID_PATTERN.test(sessionKey) || !validBindingOperationId(operationId)
      || !validNullableText(runtimeSessionId, 512) || runtimeSessionId === null) {
      throw chatSessionError("CHAT_BINDING_INVALID", "binding 完成输入无效");
    }
    const time = this.#currentTime();
    this.#refreshWindow(time);
    const session = this.container.sessions[sessionKey];
    const operation = this.container.bindingOperations[sessionKey];
    if (!session) throw chatSessionError("CHAT_SESSION_NOT_FOUND", "ChatSession 不存在");
    if (!operation || operation.operationId !== operationId) {
      throw chatSessionError("CHAT_SESSION_BINDING_CONFLICT", "binding operation 不匹配");
    }
    if (operation.state === "bound") {
      if (operation.runtimeSessionId !== runtimeSessionId
        || session.runtimeSessionId !== runtimeSessionId) {
        throw chatSessionError("CHAT_SESSION_BINDING_CONFLICT", "binding 结果与既有结果冲突");
      }
      return clone(session);
    }
    const threadConflict = Object.values(this.container.sessions)
      .find((candidate) => candidate.sessionKey !== sessionKey
        && candidate.runtimeSessionId === runtimeSessionId);
    if (threadConflict) {
      throw chatSessionError("CHAT_THREAD_ID_CONFLICT", "Runtime session 已绑定其他 ChatSession");
    }
    if (Object.values(this.container.bindingOperations)
      .filter((candidate) => candidate.state === "bound").length
      >= this.maxTerminalBindingOperations) {
      throw chatSessionError("CHAT_SESSION_CAPACITY", "binding operation 幂等窗口容量已满");
    }
    const updated = {
      ...session,
      runtimeSessionId,
      status: "ready",
      updatedAt: Math.max(time, session.updatedAt),
    };
    const completed = {
      ...operation,
      state: "bound",
      runtimeSessionId,
      updatedAt: Math.max(time, operation.updatedAt),
      finishedAt: Math.max(time, operation.createdAt),
    };
    const candidate = {
      ...this.container,
      revision: this.container.revision + 1,
      sessions: { ...this.container.sessions, [sessionKey]: updated },
      bindingOperations: { ...this.container.bindingOperations, [sessionKey]: completed },
    };
    this.container = this.#write(candidate);
    return clone(updated);
  }

  replaceBoundRuntimeSession(input) {
    this.#assertOpen();
    if (!exactObject(input, [
      "sessionKey", "operationId", "expectedRuntimeSessionId", "runtimeSessionId",
    ])
      || !UUID_PATTERN.test(input.sessionKey)
      || !validBindingOperationId(input.operationId)
      || !validNullableText(input.expectedRuntimeSessionId, 512)
      || input.expectedRuntimeSessionId === null
      || !validNullableText(input.runtimeSessionId, 512)
      || input.runtimeSessionId === null) {
      throw chatSessionError("CHAT_BINDING_INVALID", "bound thread repair 输入无效");
    }
    const time = this.#currentTime();
    this.#refreshWindow(time);
    const session = this.container.sessions[input.sessionKey];
    const operation = this.container.bindingOperations[input.sessionKey];
    if (!session) throw chatSessionError("CHAT_SESSION_NOT_FOUND", "ChatSession 不存在");
    if (session.status !== "ready" || operation?.state !== "bound"
      || operation.operationId !== input.operationId
      || session.runtimeSessionId !== input.expectedRuntimeSessionId
      || operation.runtimeSessionId !== input.expectedRuntimeSessionId) {
      throw chatSessionError("CHAT_SESSION_BINDING_CONFLICT", "bound thread repair 前置状态已变化");
    }
    if (input.runtimeSessionId === input.expectedRuntimeSessionId) return clone(session);
    if (Object.values(this.container.sessions).some((candidate) => (
      candidate.sessionKey !== input.sessionKey
      && candidate.runtimeSessionId === input.runtimeSessionId
    ))) {
      throw chatSessionError("CHAT_THREAD_ID_CONFLICT", "Runtime session 已绑定其他 ChatSession");
    }
    const updatedSession = {
      ...session,
      runtimeSessionId: input.runtimeSessionId,
      updatedAt: Math.max(time, session.updatedAt),
    };
    const updatedOperation = {
      ...operation,
      runtimeSessionId: input.runtimeSessionId,
      updatedAt: Math.max(time, operation.updatedAt),
    };
    const candidate = {
      ...this.container,
      revision: this.container.revision + 1,
      sessions: { ...this.container.sessions, [input.sessionKey]: updatedSession },
      bindingOperations: {
        ...this.container.bindingOperations,
        [input.sessionKey]: updatedOperation,
      },
    };
    this.container = this.#write(candidate);
    return clone(updatedSession);
  }

  replaceBoundThread(input) {
    if (!exactObject(input, [
      "sessionKey", "operationId", "expectedCodexThreadId", "codexThreadId",
    ])) {
      throw chatSessionError("CHAT_BINDING_INVALID", "bound thread repair 输入无效");
    }
    return this.replaceBoundRuntimeSession({
      sessionKey: input.sessionKey,
      operationId: input.operationId,
      expectedRuntimeSessionId: input.expectedCodexThreadId,
      runtimeSessionId: input.codexThreadId,
    });
  }

  recoverBinding(input) {
    this.#assertOpen();
    const legacy = exactObject(input, ["threadSource", "codexThreadId"]);
    const current = exactObject(input, ["threadSource", "runtimeSessionId"]);
    const runtimeSessionId = current ? input.runtimeSessionId : input?.codexThreadId;
    if ((!legacy && !current)
      || typeof input.threadSource !== "string" || input.threadSource.length > 112
      || !validNullableText(runtimeSessionId, 512) || runtimeSessionId === null) {
      throw chatSessionError("CHAT_BINDING_INVALID", "binding recovery 输入无效");
    }
    const operation = Object.values(this.container.bindingOperations)
      .find((candidate) => candidate.threadSource === input.threadSource);
    if (!operation) {
      throw chatSessionError("CHAT_BINDING_RECOVERY_NOT_FOUND", "threadSource 无待恢复 binding");
    }
    return this.completeBinding(operation.sessionKey, operation.operationId, runtimeSessionId);
  }

  listPendingBindings() {
    this.#assertOpen();
    return Object.values(this.container.bindingOperations)
      .filter((operation) => operation.state === "pending")
      .map(clone);
  }

  requestRename(sessionKey, title, operationId, createdAt) {
    if (!validNullableText(title, 512)) {
      throw chatSessionError("CHAT_REMOTE_OPERATION_INVALID", "rename title 无效");
    }
    return this.#requestRemoteOperation(sessionKey, "rename", title, operationId, createdAt);
  }

  requestArchive(sessionKey, operationId, createdAt) {
    return this.#requestRemoteOperation(sessionKey, "archive", null, operationId, createdAt);
  }

  requestDelete(sessionKey, operationId, createdAt) {
    return this.#requestRemoteOperation(sessionKey, "delete", null, operationId, createdAt);
  }

  listPendingRemoteOperations() {
    this.#assertOpen();
    return Object.values(this.container.remoteOperations)
      .filter((operation) => operation.state === "pending")
      .map(clone);
  }

  completeRemoteOperation(operationId) {
    this.#assertOpen();
    if (!validOpaqueId(operationId)) {
      throw chatSessionError("CHAT_REMOTE_OPERATION_INVALID", "remote operationId 无效");
    }
    const time = this.#currentTime();
    this.#refreshWindow(time);
    const operation = this.container.remoteOperations[operationId];
    if (!operation) throw chatSessionError("CHAT_REMOTE_OPERATION_NOT_FOUND", "remote operation 不存在");
    const existingSession = this.container.sessions[operation.sessionKey] || null;
    if (operation.state === "completed") return clone(existingSession);
    if (!existingSession) {
      throw chatSessionError("CHAT_SESSION_NOT_FOUND", "ChatSession 不存在");
    }
    if (Object.values(this.container.remoteOperations)
      .filter((candidate) => candidate.state === "completed").length
      >= this.maxCompletedRemoteOperations) {
      throw chatSessionError("CHAT_SESSION_CAPACITY", "remote operation 幂等窗口容量已满");
    }
    if (operation.kind === "delete"
      && Object.values(this.container.createOperations)
        .filter((candidate) => candidate.state === "deleted").length
        >= this.maxDeletedCreateOperations) {
      throw chatSessionError("CHAT_SESSION_CAPACITY", "create operation 幂等窗口容量已满");
    }
    const completed = {
      ...operation,
      state: "completed",
      updatedAt: Math.max(time, operation.updatedAt),
      finishedAt: Math.max(time, operation.createdAt),
    };
    const sessions = { ...this.container.sessions };
    const createOperations = { ...this.container.createOperations };
    const bindingOperations = { ...this.container.bindingOperations };
    let remoteOperations = { ...this.container.remoteOperations, [operationId]: completed };
    let result = existingSession;
    if (operation.kind === "delete") {
      delete sessions[operation.sessionKey];
      const createEntry = Object.values(createOperations)
        .find((candidate) => candidate.sessionKey === operation.sessionKey);
      createOperations[createEntry.operationId] = {
        ...createEntry,
        state: "deleted",
        finishedAt: Math.max(time, createEntry.createdAt),
      };
      result = null;
    }
    const candidate = {
      ...this.container,
      revision: this.container.revision + 1,
      sessions,
      createOperations,
      bindingOperations,
      remoteOperations,
    };
    this.container = this.#write(candidate);
    return clone(result);
  }

  #requestRemoteOperation(sessionKey, kind, title, operationId, createdAt) {
    this.#assertOpen();
    if (!UUID_PATTERN.test(sessionKey) || !validOpaqueId(operationId)
      || !Number.isSafeInteger(createdAt) || createdAt < 0) {
      throw chatSessionError("CHAT_REMOTE_OPERATION_INVALID", "remote operation 输入无效");
    }
    const time = this.#prepareOperation(createdAt);
    const indexed = this.#findOperation(operationId);
    if (indexed) {
      if (indexed.kind !== "remote" || indexed.operation.sessionKey !== sessionKey
        || indexed.operation.kind !== kind || indexed.operation.title !== title
        || indexed.operation.createdAt !== createdAt) {
        throw chatSessionError("CHAT_OPERATION_ID_CONFLICT", "operationId 已用于不同操作");
      }
      return clone(indexed.operation);
    }
    this.#assertNotExpired(createdAt);
    const session = this.container.sessions[sessionKey];
    if (!session) throw chatSessionError("CHAT_SESSION_NOT_FOUND", "ChatSession 不存在");
    if (Object.values(this.container.remoteOperations)
      .some((operation) => operation.sessionKey === sessionKey && operation.state === "pending")) {
      throw chatSessionError("CHAT_REMOTE_OPERATION_CONFLICT", "ChatSession 已有待补偿远端操作");
    }
    if ((kind === "rename" || kind === "archive") && session.status !== "ready") {
      throw chatSessionError("CHAT_REMOTE_OPERATION_CONFLICT", "ChatSession 当前状态不允许该操作");
    }
    if (kind === "delete" && !["ready", "archived"].includes(session.status)) {
      throw chatSessionError("CHAT_REMOTE_OPERATION_CONFLICT", "ChatSession 当前状态不允许删除");
    }
    const operation = normalizeRemoteOperation({
      operationId,
      sessionKey,
      kind,
      title,
      state: "pending",
      createdAt,
      updatedAt: Math.max(time, createdAt),
      finishedAt: null,
    });
    const updatedSession = {
      ...session,
      title: kind === "rename" ? title : session.title,
      status: kind === "archive"
        ? "archived"
        : kind === "delete" ? "delete_pending" : session.status,
      updatedAt: Math.max(time, session.updatedAt),
    };
    const candidate = {
      ...this.container,
      revision: this.container.revision + 1,
      sessions: { ...this.container.sessions, [sessionKey]: updatedSession },
      remoteOperations: { ...this.container.remoteOperations, [operationId]: operation },
    };
    this.container = this.#write(candidate);
    return clone(operation);
  }

  #emptyContainer() {
    return {
      version: CHAT_SESSION_STORE_VERSION,
      revision: 0,
      idempotencyFloorMs: 0,
      sessions: {},
      createOperations: {},
      bindingOperations: {},
      remoteOperations: {},
      cronRuns: {},
    };
  }

  #currentTime() {
    const time = this.now();
    if (!Number.isSafeInteger(time) || time < 0
      || time > Number.MAX_SAFE_INTEGER - MAX_OPERATION_FUTURE_SKEW_MS) {
      throw chatSessionError("CHAT_OPERATION_TIMESTAMP_INVALID", "本地时钟无效");
    }
    return time;
  }

  #prepareOperation(createdAt) {
    const time = this.#currentTime();
    this.#refreshWindow(time);
    if (createdAt > time + MAX_OPERATION_FUTURE_SKEW_MS) {
      throw chatSessionError("CHAT_OPERATION_TIMESTAMP_INVALID", "operation createdAt 超出未来时钟偏差");
    }
    return time;
  }

  #assertNotExpired(createdAt) {
    if (createdAt <= this.container.idempotencyFloorMs) {
      throw chatSessionError("OPERATION_EXPIRED", "operation 已超出 30 天幂等窗口");
    }
  }

  #findOperation(operationId) {
    const create = this.container.createOperations[operationId];
    if (create) return { kind: "create", operation: create };
    const binding = Object.values(this.container.bindingOperations)
      .find((operation) => operation.operationId === operationId);
    if (binding) return { kind: "binding", operation: binding };
    const remote = this.container.remoteOperations[operationId];
    return remote ? { kind: "remote", operation: remote } : null;
  }

  #refreshWindow(time, persist = true) {
    const idempotencyFloorMs = Math.max(
      this.container.idempotencyFloorMs,
      Math.max(0, time - IDEMPOTENCY_WINDOW_MS),
    );
    const createOperations = Object.fromEntries(Object.entries(this.container.createOperations)
      .filter(([, operation]) => operation.state === "active"
        || operation.finishedAt >= idempotencyFloorMs));
    const bindingOperations = Object.fromEntries(Object.entries(this.container.bindingOperations)
      .filter(([sessionKey, operation]) => this.container.sessions[sessionKey]
        || operation.state === "pending" || operation.finishedAt >= idempotencyFloorMs));
    const remoteOperations = Object.fromEntries(Object.entries(this.container.remoteOperations)
      .filter(([, operation]) => operation.state === "pending"
        || operation.finishedAt >= idempotencyFloorMs));
    const changed = idempotencyFloorMs !== this.container.idempotencyFloorMs
      || Object.keys(createOperations).length !== Object.keys(this.container.createOperations).length
      || Object.keys(bindingOperations).length !== Object.keys(this.container.bindingOperations).length
      || Object.keys(remoteOperations).length !== Object.keys(this.container.remoteOperations).length;
    if (!changed) return;
    const candidate = {
      ...this.container,
      revision: persist ? this.container.revision + 1 : this.container.revision,
      idempotencyFloorMs,
      createOperations,
      bindingOperations,
      remoteOperations,
    };
    this.container = persist ? this.#write(candidate) : validateContainer(candidate);
  }

  #parse(bytes) {
    try {
      this.cronOriginIndex = null;
      return validateContainer(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      if (error?.code === "CHAT_SESSION_STORE_CORRUPT") throw error;
      throw chatSessionError("CHAT_SESSION_STORE_CORRUPT", "ChatSession 容器损坏");
    }
  }

  #write(candidate) {
    const validated = validateContainer(candidate);
    const serialized = `${JSON.stringify(validated)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_CHAT_SESSION_STORE_BYTES) {
      throw chatSessionError("CHAT_SESSION_CAPACITY", "ChatSession 容量已满");
    }
    try {
      this.atomicWrite(this.filePath, serialized, {
        fs: this.fs,
        trustedRoot: this.paths.trustedRoot,
      });
    } catch (error) {
      if (error?.committed === true) return validated;
      if (error?.committedUncertain === true) {
        this.commitUncertain = true;
        const uncertain = chatSessionError(
          "CHAT_SESSION_COMMIT_UNCERTAIN",
          "ChatSession 提交状态不确定，必须重新打开",
        );
        uncertain.committedUncertain = true;
        throw uncertain;
      }
      if (String(error?.code || "").startsWith("UNSAFE_")) throw error;
      throw chatSessionError("CHAT_SESSION_WRITE_FAILED", "ChatSession 写入失败");
    }
    this.cronOriginIndex = null;
    return validated;
  }

  #assertOpen() {
    if (this.commitUncertain) {
      throw chatSessionError(
        "CHAT_SESSION_COMMIT_UNCERTAIN",
        "ChatSession 提交状态不确定，必须重新打开",
      );
    }
    if (!this.opened) throw chatSessionError("CHAT_SESSION_STORE_CLOSED", "ChatSessionStore 未打开");
  }
}

module.exports = {
  BINDING_FIELDS,
  CHAT_SESSION_STORE_VERSION,
  CREATE_OPERATION_FIELDS,
  MAX_CHAT_SESSION_STORE_BYTES,
  MAX_CHAT_SESSIONS,
  MAX_ACTIVE_CREATE_OPERATIONS,
  MAX_COMPLETED_REMOTE_OPERATIONS,
  MAX_DELETED_CREATE_OPERATIONS,
  MAX_OPERATION_FUTURE_SKEW_MS,
  MAX_TERMINAL_BINDING_OPERATIONS,
  IDEMPOTENCY_WINDOW_MS,
  REMOTE_OPERATION_FIELDS,
  SESSION_FIELDS,
  SESSION_STATUSES,
  ChatSessionStore,
  normalizeSession,
  validateContainer,
};
