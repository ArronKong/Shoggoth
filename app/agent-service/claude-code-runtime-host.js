"use strict";

const { imageAttachments } = require("./chat-attachments");

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { safeSnapshot } = require("./codex-event-snapshot");
const { trustedImportedSettingSources } = require("./claude-code-native-import");
const {
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  serverRequestUsesApprovalWait,
} = require("./interactive-timeouts");
const { serviceError } = require("./security");
const { runtimeBinding } = require("./runtime-adapter");
const {
  normalizeRuntimeCommands,
  parseRuntimeCommand,
} = require("./runtime-commands");
const { mergeNativeCommands, requireRuntimeCommand } = require("./native-cli-commands");
const { validateResolvedEnvironment } = require("./runtime-account-resolver");
const {
  CLAUDE_CODE_RUNTIME,
  claudeCodePermissionOptions,
  claudeCodeWorkspaceShardId,
  normalizeClaudeCodePermissionPolicy,
  normalizeClaudeCodeWorkspace,
  parseClaudeCodeVersion,
  supportsClaudeCodeVersion,
} = require("./claude-code-runtime-paths");
const { ClaudeCodeRuntimeLedger } = require("./claude-code-runtime-ledger");
const { loadClaudeAgentSdk, withClaudeConfigDir } = require("./claude-code-sdk");

const PARENT_ENV_ALLOWLIST = Object.freeze([
  "LANG", "LC_ALL", "LC_CTYPE", "PATH", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
]);
const SDK_ENV_ALLOWLIST = Object.freeze([
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_ENTRYPOINT",
]);
const AUTH_ERROR_PATTERN = /(?:authentication|not logged in|please log in|login required|oauth|api key|unauthorized|401)/iu;
const MAX_CONTROL_OUTPUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_TURN_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_MODELS = 256;
const AUTH_CACHE_MS = 30_000;
const MODEL_CACHE_MS = 5 * 60 * 1_000;
const COMMAND_CACHE_MS = 60_000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "interrupted", "canceled"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

function hostError(code, message) {
  return serviceError(code, message);
}

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function safeString(value, maxBytes, { empty = false } = {}) {
  return typeof value === "string" && (empty || value.length > 0) && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function defined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unrefDelay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function sessionById(data, sessionId) {
  return data.sessions.find((session) => session.id === sessionId) || null;
}

function turnById(session, turnId) {
  return session?.turns.find((turn) => turn.id === turnId) || null;
}

function turnByOperation(session, operationId) {
  return session?.turns.find((turn) => turn.operationId === operationId) || null;
}

function inputFingerprint(input) {
  return crypto.createHash("sha256").update(JSON.stringify({
    prompt: input.prompt,
    context: input.context ?? null,
    model: input.model ?? null,
    cwd: input.cwd ?? null,
    permissionPolicy: input.permissionPolicy ?? null,
    permissionMode: input.permissionMode ?? null,
    ...(input.thinkingLevel != null ? { thinkingLevel: input.thinkingLevel } : {}),
  })).digest("hex");
}

function normalizePermissionMode(value) {
  const mode = value || "default";
  if (!["default", "acceptEdits", "auto", "dontAsk", "plan", "bypassPermissions"].includes(mode)) {
    throw hostError("RUNTIME_PERMISSION_POLICY_INVALID", "Claude Code permission mode is invalid");
  }
  return mode;
}

function runtimePath(parentPath, userHome) {
  const entries = String(parentPath || "").split(path.delimiter)
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry) && !entry.includes("\0"));
  if (typeof userHome === "string" && path.isAbsolute(userHome) && !userHome.includes("\0")) {
    entries.unshift(path.join(userHome, ".local", "bin"));
  }
  entries.unshift(
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  );
  return [...new Set(entries)].join(path.delimiter);
}

function defaultKillProcessGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function isUuid(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function responseIdFor(active, result) {
  const digest = crypto.createHash("sha256").update(JSON.stringify([
    active.sessionId,
    active.turnId,
    result.uuid,
    result.user_message_uuid ?? null,
    result.modelUsage ?? {},
  ])).digest("hex");
  return `claude-code-response-${digest}`;
}

function usageFromResult(result) {
  const totals = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
  if (!plain(result?.modelUsage)) return totals;
  for (const usage of Object.values(result.modelUsage)) {
    if (!usage || typeof usage !== "object") continue;
    const input = Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0
      ? usage.inputTokens : 0;
    const cached = Number.isSafeInteger(usage.cacheReadInputTokens)
      && usage.cacheReadInputTokens >= 0 ? usage.cacheReadInputTokens : 0;
    const cacheWrite = Number.isSafeInteger(usage.cacheCreationInputTokens)
      && usage.cacheCreationInputTokens >= 0 ? usage.cacheCreationInputTokens : 0;
    const output = Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0
      ? usage.outputTokens : 0;
    const reasoning = Number.isSafeInteger(usage.thinkingTokens) && usage.thinkingTokens >= 0
      ? Math.min(output, usage.thinkingTokens) : 0;
    totals.inputTokens += input + cached + cacheWrite;
    totals.cachedInputTokens += cached;
    totals.cacheWriteInputTokens += cacheWrite;
    totals.outputTokens += output;
    totals.reasoningOutputTokens += reasoning;
  }
  for (const key of Object.keys(totals)) {
    if (!Number.isSafeInteger(totals[key])) {
      throw hostError("CLAUDE_CODE_USAGE_INVALID", "Claude Code token usage exceeds its limit");
    }
  }
  totals.totalTokens = totals.inputTokens + totals.outputTokens;
  if (!Number.isSafeInteger(totals.totalTokens)) {
    throw hostError("CLAUDE_CODE_USAGE_INVALID", "Claude Code token total exceeds its limit");
  }
  return totals;
}

function usageIdentity(result, requestedModel) {
  const entries = plain(result?.modelUsage) ? Object.entries(result.modelUsage) : [];
  const model = entries.length === 1 && safeString(entries[0][0], 512)
    ? entries[0][0] : safeString(requestedModel, 512) ? requestedModel : undefined;
  const providers = [...new Set(entries.map(([, usage]) => usage?.provider)
    .filter((value) => safeString(value, 512)))];
  return defined({ model, provider: providers.length === 1 ? providers[0] : undefined });
}

function parseAuthStatus(stdout) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > MAX_CONTROL_OUTPUT_BYTES) {
    throw hostError("CLAUDE_CODE_AUTH_STATUS_INVALID", "Claude Code auth status is invalid");
  }
  let value;
  try { value = JSON.parse(stdout); } catch {
    throw hostError("CLAUDE_CODE_AUTH_STATUS_INVALID", "Claude Code auth status is malformed");
  }
  if (!plain(value) || typeof value.loggedIn !== "boolean"
    || (value.authMethod !== undefined && !safeString(value.authMethod, 128, { empty: true }))) {
    throw hostError("CLAUDE_CODE_AUTH_STATUS_INVALID", "Claude Code auth status format changed");
  }
  return Object.freeze({
    authenticated: value.loggedIn,
    credentialPresent: value.loggedIn,
  });
}

function normalizeModels(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MODELS) {
    throw hostError("RUNTIME_MODEL_CATALOG_INVALID", "Claude Code returned no usable models");
  }
  const seen = new Set();
  const models = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || !safeString(entry.value, 512)
      || !safeString(entry.displayName, 512) || seen.has(entry.value)) {
      throw hostError("RUNTIME_MODEL_CATALOG_INVALID", "Claude Code model catalog format changed");
    }
    seen.add(entry.value);
    models.push(Object.freeze(defined({
      model: entry.value,
      displayName: entry.displayName,
      description: safeString(entry.description, 2048, { empty: true })
        ? entry.description : undefined,
      ...(entry.supportsEffort === true && Array.isArray(entry.supportedEffortLevels)
        ? { capabilities: { thinkingOptions: [...new Set(entry.supportedEffortLevels)]
          .filter(level => ["low", "medium", "high", "xhigh", "max"].includes(level)),
        thinkingDefault: null, fastTier: null } } : {}),
    })));
  }
  return Object.freeze(models);
}

function sdkUserMessage(text, uuid, sessionId, priority, attachments) {
  return defined({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }, ...imageAttachments(attachments)
      .map(image => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } }))] },
    parent_tool_use_id: null,
    uuid,
    session_id: sessionId,
    priority,
  });
}

function toolKind(name) {
  if (name === "Bash") return "commandExecution";
  if (WRITE_TOOLS.has(name)) return "fileChange";
  if (name.startsWith("mcp__")) return "mcpToolCall";
  if (name === "WebSearch" || name === "WebFetch") return "webSearch";
  if (name === "Agent" || name === "Task") return "collabAgentToolCall";
  return "other";
}

function messageTextContent(message) {
  const content = message?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join("");
}

function resultFailureCode(result) {
  const text = `${Array.isArray(result?.errors) ? result.errors.join("\n") : ""}\n${result?.result || ""}`;
  return AUTH_ERROR_PATTERN.test(text) ? "AUTH_REQUIRED" : "CLAUDE_CODE_TURN_FAILED";
}

function questionSchema(input) {
  const questions = input?.questions;
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) return null;
  const properties = {};
  const required = [];
  const mappings = [];
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    if (!plain(question) || !safeString(question.question, 2048)
      || !safeString(question.header, 512)
      || !Array.isArray(question.options) || question.options.length < 2
      || question.options.length > 32) return null;
    const labels = [];
    for (const option of question.options) {
      if (!plain(option) || !safeString(option.label, 512)
        || !safeString(option.description, 2048, { empty: true })
        || labels.includes(option.label)) return null;
      labels.push(option.label);
    }
    const id = `question_${index + 1}`;
    required.push(id);
    mappings.push({ id, question: question.question });
    if (question.multiSelect === true) {
      properties[id] = {
        type: "string",
        title: question.question,
        description: `${question.header}（可多选，请用逗号分隔：${labels.join("、")}）`,
      };
    } else {
      properties[id] = {
        type: "string",
        title: question.question,
        description: question.header,
        enum: labels,
        enumNames: labels,
      };
    }
  }
  return { schema: { type: "object", properties, required, additionalProperties: false }, mappings };
}

class AsyncMessageQueue {
  constructor() {
    this.values = [];
    this.waiters = [];
    this.closed = false;
  }

  push(value) {
    if (this.closed) throw hostError("RUNTIME_TURN_NOT_ACTIVE", "Claude Code input is closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  next() {
    if (this.values.length > 0) return Promise.resolve({ value: this.values.shift(), done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  return() {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() { return this; }
}

class ClaudeCodeRuntimeHost {
  constructor(options = {}) {
    this.paths = options.paths;
    if (!this.paths?.stateDir || !this.paths?.trustedRoot) {
      throw hostError("CLAUDE_CODE_HOST_OPTIONS_INVALID", "Claude Code host paths are invalid");
    }
    this.binding = runtimeBinding(options.runtimeBinding || {
      runtime: CLAUDE_CODE_RUNTIME,
      runtimeProfileId: options.runtimeProfileId,
      runtimeAccountId: options.runtimeAccountId,
    });
    this.runtimeProfileId = this.binding.runtimeProfileId;
    this.runtimeAccountId = this.binding.runtimeAccountId;
    this.runtimeEnvironment = validateResolvedEnvironment(options.runtimeEnvironment, this.binding);
    this.permissionPolicy = normalizeClaudeCodePermissionPolicy(options.permissionPolicy);
    this.controlInstance = options.controlInstance === true;
    this.workspace = this.controlInstance ? null : normalizeClaudeCodeWorkspace(options.workspace);
    this.binaryCandidate = options.binaryPath;
    this.parentEnv = options.parentEnv || process.env;
    this.userHome = this.runtimeEnvironment.spawnEnv.HOME;
    this.fs = options.fs || fs;
    this.spawnProcess = options.spawnProcess || spawn;
    this.killProcessGroup = options.killProcessGroup || defaultKillProcessGroup;
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.onDiagnostic = typeof options.onDiagnostic === "function" ? options.onDiagnostic : null;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.serverRequestTimeoutMs = options.serverRequestTimeoutMs ?? 310_000;
    this.acceptanceTimeoutMs = options.acceptanceTimeoutMs ?? 30_000;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 3_000;
    this.killGraceMs = options.killGraceMs ?? 2_000;
    this.profileState = options.profileState || {
      authenticated: false,
      credentialPresent: false,
      authCheckedAt: 0,
      models: null,
      modelsExpiresAt: 0,
    };
    this.injectedSdk = options.sdk;
    this.sdk = null;
    this.mcpGateIssuer = options.mcpGateIssuer;
    if (!this.mcpGateIssuer || ["reserveMcpServer", "bindMcpServer", "revokeMcpServer"]
      .some((method) => typeof this.mcpGateIssuer[method] !== "function")) {
      throw hostError("CLAUDE_CODE_HOST_OPTIONS_INVALID", "Claude Code MCP gate issuer is invalid");
    }
    for (const value of [this.requestTimeoutMs, this.serverRequestTimeoutMs, this.acceptanceTimeoutMs,
      this.shutdownGraceMs, this.killGraceMs]) {
      if (!Number.isSafeInteger(value) || value < 100 || value > 10 * 60 * 1_000) {
        throw hostError("CLAUDE_CODE_HOST_OPTIONS_INVALID", "Claude Code host timeout is invalid");
      }
    }
    this.state = "new";
    this.home = null;
    this.binaryPath = null;
    this.ledger = null;
    this.sessionConfigs = new Map();
    this.commandCatalog = null;
    this.commandsExpiresAt = 0;
    this.activeTurns = new Map();
    this.controlProcesses = new Map();
    this.controlProcessGroups = new WeakSet();
    this.controlQueries = new Set();
    this.listeners = new Set();
    this.serverRequestHandlers = new Map();
    this.cleanupIncomplete = false;
    this.stopping = null;
    const terminated = makeDeferred();
    this.terminated = terminated.promise;
    this.resolveTerminated = terminated.resolve;
    this.rejectTerminated = terminated.reject;
    this.registeredSecrets = [];
  }

  async initialize() {
    if (this.state === "ready") return this;
    if (this.state !== "new") {
      throw hostError("CLAUDE_CODE_RUNTIME_STATE_INVALID", "Claude Code host state is invalid");
    }
    this.state = "initializing";
    try {
      this.home = this.runtimeEnvironment.home;
      this.binaryPath = this.runtimeEnvironment.binaryPath;
      const versionResult = await this._runControl(["--version"], { timeoutMs: 5_000 });
      if (this.state !== "initializing") {
        throw hostError("RUNTIME_HOST_TERMINATED", "Claude Code host stopped during initialization");
      }
      const version = parseClaudeCodeVersion(versionResult.stdout);
      if (versionResult.code !== 0 || !supportsClaudeCodeVersion(version)) {
        throw hostError(
          "CLAUDE_CODE_VERSION_UNSUPPORTED",
          "Claude Code CLI 2.1.220 or newer is required",
        );
      }
      this.sdk = await loadClaudeAgentSdk(this.injectedSdk);
      const workspaceShardId = claudeCodeWorkspaceShardId({
        controlInstance: this.controlInstance,
        workspace: this.workspace,
      });
      this.ledger = new ClaudeCodeRuntimeLedger({
        fs: this.fs,
        stateRoot: path.join(this.paths.stateDir, "runtime-ledgers", CLAUDE_CODE_RUNTIME),
        trustedRoot: this.paths.trustedRoot,
        runtimeProfileId: this.runtimeProfileId,
        workspaceShardId,
        now: this.now,
      }).open();
      this.state = "ready";
      return this;
    } catch (error) {
      if (!["stopping", "stopped"].includes(this.state)) {
        this.state = "failed";
        this.rejectTerminated(error);
      }
      throw error;
    }
  }

  beginAcquire() {
    this._assertReady();
  }

  async authenticationState() {
    return this._readAuthenticationState(false);
  }

  async _readAuthenticationState(allowCache) {
    this._assertReady();
    const now = this.now();
    if (allowCache && this.profileState.authCheckedAt + AUTH_CACHE_MS > now) {
      return Object.freeze({
        authenticated: this.profileState.authenticated === true,
        credentialPresent: this.profileState.credentialPresent === true,
      });
    }
    const result = await this._runControl(["auth", "status", "--json"], { timeoutMs: 10_000 });
    this._assertReady();
    const status = parseAuthStatus(result.stdout);
    this.profileState.authenticated = status.authenticated;
    this.profileState.credentialPresent = status.credentialPresent;
    this.profileState.authCheckedAt = now;
    if (!status.authenticated) {
      this.profileState.models = null;
      this.profileState.modelsExpiresAt = 0;
      this.commandCatalog = null;
      this.commandsExpiresAt = 0;
    }
    return status;
  }

  subscribe(listener) {
    if (typeof listener !== "function") {
      throw hostError("RUNTIME_EVENT_LISTENER_INVALID", "Claude Code listener is invalid");
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  registerServerRequestHandler(method, handler) {
    if (!safeString(method, 128) || typeof handler !== "function") {
      throw hostError("RUNTIME_SERVER_REQUEST_HANDLER_INVALID", "Claude Code request handler is invalid");
    }
    this.serverRequestHandlers.set(method, handler);
    return () => {
      if (this.serverRequestHandlers.get(method) === handler) this.serverRequestHandlers.delete(method);
    };
  }

  async sessionStart(input) {
    this._assertExecutionInstance();
    await this._ensureModelCatalog();
    if (!plain(input) || !safeString(input.source, 256)
      || (input.developerInstructions !== undefined
        && !safeString(input.developerInstructions, 1024 * 1024, { empty: true }))) {
      throw hostError("RUNTIME_SESSION_PARAMS_INVALID", "Claude Code session input is invalid");
    }
    this._assertInputPermissionPolicy(input.permissionPolicy);
    const permissionMode = normalizePermissionMode(input.permissionMode);
    const cwd = this._sessionCwd(input.cwd);
    const model = this._validateModel(input.model);
    const snapshot = this.ledger.snapshot();
    const existing = snapshot.sessions.find((session) => session.source === input.source);
    if (existing) {
      this.sessionConfigs.set(existing.id, {
        developerInstructions: typeof input.developerInstructions === "string"
          ? input.developerInstructions : "",
        model,
        permissionMode,
      });
      return { session: this._projectSession(existing) };
    }
    const sessionId = this.randomUUID();
    if (!isUuid(sessionId)) {
      throw hostError("RUNTIME_SESSION_ID_INVALID", "Claude Code session id is invalid");
    }
    const createdAt = this.now();
    const session = {
      id: sessionId,
      remoteSessionId: sessionId,
      source: input.source,
      cwd,
      title: null,
      archived: false,
      createdAt,
      updatedAt: createdAt,
      turns: [],
    };
    this.ledger.update((data) => data.sessions.push(session));
    this.sessionConfigs.set(session.id, {
      developerInstructions: typeof input.developerInstructions === "string"
        ? input.developerInstructions : "",
      model,
      permissionMode,
    });
    return { session: this._projectSession(session) };
  }

  async sessionResume(input) {
    this._assertExecutionInstance();
    await this._ensureModelCatalog();
    if (!plain(input) || !safeString(input.sessionId, 512)
      || (input.developerInstructions !== undefined
        && !safeString(input.developerInstructions, 1024 * 1024, { empty: true }))) {
      throw hostError("RUNTIME_SESSION_PARAMS_INVALID", "Claude Code resume input is invalid");
    }
    this._assertInputPermissionPolicy(input.permissionPolicy);
    const permissionMode = normalizePermissionMode(input.permissionMode);
    const session = this._requireSession(input.sessionId);
    if (session.archived) throw hostError("RUNTIME_SESSION_NOT_FOUND", "Claude Code session is archived");
    if (this.activeTurns.has(session.id)) {
      throw hostError("RUNTIME_SESSION_BUSY", "Claude Code session has an active turn");
    }
    const cwd = this._sessionCwd(input.cwd);
    if (cwd !== session.cwd) {
      throw hostError("RUNTIME_SESSION_NOT_FOUND", "Claude Code session workspace does not match");
    }
    const model = this._validateModel(input.model);
    this.sessionConfigs.set(session.id, {
      developerInstructions: typeof input.developerInstructions === "string"
        ? input.developerInstructions : "",
      model,
      permissionMode,
    });
    return { session: this._projectSession(session) };
  }

  sessionRead(input) {
    this._assertReady();
    if (!plain(input) || !safeString(input.sessionId, 512)) {
      return Promise.reject(hostError("RUNTIME_SESSION_PARAMS_INVALID", "Claude Code read input is invalid"));
    }
    const session = sessionById(this.ledger.snapshot(), input.sessionId);
    if (!session) {
      return Promise.reject(hostError("RUNTIME_SESSION_NOT_FOUND", "Claude Code session was not found"));
    }
    if (session.turns.some((turn) => turn.acceptance === "unknown")) {
      return Promise.reject(hostError(
        "RUNTIME_TURN_ACCEPTANCE_UNKNOWN",
        "Claude Code turn acceptance is unknown",
      ));
    }
    return Promise.resolve({ session: this._projectSession(session, input.includeTurns === true) });
  }

  sessionList(input = {}) {
    this._assertReady();
    const archived = input.archived === true;
    const offset = input.cursor === undefined || input.cursor === null ? 0 : Number(input.cursor);
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || String(offset) !== String(input.cursor ?? offset)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return Promise.reject(hostError("RUNTIME_SESSION_CURSOR_INVALID", "Claude Code cursor is invalid"));
    }
    const sessions = this.ledger.snapshot().sessions
      .filter((session) => session.archived === archived)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    const page = sessions.slice(offset, offset + limit).map((session) => this._projectSession(session));
    const next = offset + page.length;
    return Promise.resolve({ data: page, nextCursor: next < sessions.length ? String(next) : null });
  }

  async sessionRename(input) {
    this._assertReady();
    if (!plain(input) || !safeString(input.sessionId, 512) || !safeString(input.name, 1024)) {
      throw hostError("RUNTIME_SESSION_PARAMS_INVALID", "Claude Code rename input is invalid");
    }
    const session = this._requireSession(input.sessionId);
    if (session.turns.some((turn) => turn.acceptance === "accepted")) {
      try {
        await withClaudeConfigDir(this.home, () => (
          this.sdk.renameSession(session.remoteSessionId, input.name, { dir: session.cwd })
        ));
      } catch (error) {
        throw hostError("CLAUDE_CODE_SESSION_RENAME_FAILED", "Claude Code session could not be renamed");
      }
    }
    this.ledger.update((data) => {
      const current = sessionById(data, session.id);
      if (!current) throw hostError("RUNTIME_SESSION_NOT_FOUND", "Claude Code session was not found");
      current.title = input.name;
      current.updatedAt = Math.max(current.updatedAt, this.now());
    });
    return {};
  }

  sessionArchive(input) {
    this._assertReady();
    const session = this._requireSession(input?.sessionId);
    if (this.activeTurns.has(session.id)) {
      return Promise.reject(hostError("RUNTIME_SESSION_BUSY", "Claude Code session has an active turn"));
    }
    this.ledger.update((data) => {
      const current = sessionById(data, session.id);
      current.archived = true;
      current.updatedAt = Math.max(current.updatedAt, this.now());
    });
    return Promise.resolve({});
  }

  sessionUnarchive(input) {
    this._assertReady();
    const session = this._requireSession(input?.sessionId);
    this.ledger.update((data) => {
      const current = sessionById(data, session.id);
      current.archived = false;
      current.updatedAt = Math.max(current.updatedAt, this.now());
    });
    return Promise.resolve({});
  }

  async sessionDelete(input) {
    this._assertReady();
    const session = this._requireSession(input?.sessionId);
    if (this.activeTurns.has(session.id)) {
      throw hostError("RUNTIME_SESSION_BUSY", "Claude Code session has an active turn");
    }
    if (session.turns.some((turn) => turn.acceptance === "accepted")) {
      try {
        await withClaudeConfigDir(this.home, () => (
          this.sdk.deleteSession(session.remoteSessionId, { dir: session.cwd })
        ));
      } catch (error) {
        if (!/not found|enoent/iu.test(String(error?.message || ""))) {
          throw hostError("CLAUDE_CODE_SESSION_DELETE_FAILED", "Claude Code session could not be deleted");
        }
      }
    }
    this.ledger.update((data) => {
      const index = data.sessions.findIndex((candidate) => candidate.id === session.id);
      if (index < 0) throw hostError("RUNTIME_SESSION_NOT_FOUND", "Claude Code session was not found");
      data.sessions.splice(index, 1);
    });
    this.sessionConfigs.delete(session.id);
    return {};
  }

  async turnStart(input) {
    this._assertExecutionInstance();
    await this._ensureModelCatalog();
    if (!plain(input) || !safeString(input.sessionId, 512)
      || !safeString(input.operationId, 512)
      || !safeString(input.prompt, 1024 * 1024, { empty: true })
      || (input.context !== undefined && input.context !== null
        && !safeString(input.context, 4 * 1024 * 1024, { empty: true }))) {
      throw hostError("RUNTIME_TURN_PARAMS_INVALID", "Claude Code turn input is invalid");
    }
    const permissionPolicy = this._assertInputPermissionPolicy(input.permissionPolicy);
    const permissionMode = normalizePermissionMode(input.permissionMode
      ?? this.sessionConfigs.get(input.sessionId)?.permissionMode);
    const session = this._requireSession(input.sessionId);
    if (session.archived) throw hostError("RUNTIME_SESSION_ARCHIVED", "Claude Code session is archived");
    if (this._sessionCwd(input.cwd) !== session.cwd) {
      throw hostError("RUNTIME_SESSION_NOT_FOUND", "Claude Code turn workspace does not match");
    }
    const model = this._validateModel(input.model ?? this.sessionConfigs.get(session.id)?.model);
    const fingerprint = inputFingerprint({ ...input, model });
    const existing = turnByOperation(session, input.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw hostError("RUNTIME_OPERATION_CONFLICT", "Claude Code operationId input changed");
      }
      const active = this.activeTurns.get(session.id);
      if (active?.turnId === existing.id) return active.acceptance.promise;
      if (existing.acceptance === "unknown") {
        throw hostError("RUNTIME_TURN_ACCEPTANCE_UNKNOWN", "Claude Code turn acceptance is unknown");
      }
      if (existing.acceptance === "failed") {
        throw hostError(existing.errorCode || "CLAUDE_CODE_TURN_FAILED", "Claude Code turn failed");
      }
      return { turn: { id: existing.id, status: existing.status, items: [] } };
    }
    if (session.turns.some((turn) => turn.acceptance === "unknown")) {
      throw hostError("RUNTIME_TURN_ACCEPTANCE_UNKNOWN", "A prior Claude Code turn is unresolved");
    }
    if (this.activeTurns.has(session.id)) {
      throw hostError("RUNTIME_SESSION_BUSY", "Claude Code session already has an active turn");
    }
    const turnId = `claude-code-turn-${this.randomUUID()}`;
    const userMessageUuid = this.randomUUID();
    if (!safeString(turnId, 512) || !isUuid(userMessageUuid)) {
      throw hostError("RUNTIME_TURN_ID_INVALID", "Claude Code turn id is invalid");
    }
    const createdAt = this.now();
    this.ledger.update((data) => {
      const current = sessionById(data, session.id);
      current.turns.push({
        id: turnId,
        operationId: input.operationId,
        fingerprint,
        userMessageUuid,
        acceptance: "unknown",
        status: "inProgress",
        errorCode: null,
        assistantMessages: [],
        responseId: null,
        createdAt,
        updatedAt: createdAt,
      });
      current.updatedAt = Math.max(current.updatedAt, createdAt);
    });
    const active = {
      sessionId: session.id,
      turnId,
      userMessageUuid,
      acceptance: makeDeferred(),
      terminal: makeDeferred(),
      accepted: false,
      settled: false,
      interruptRequested: false,
      inputReleased: false,
      seenInit: false,
      result: null,
      child: null,
      reservationId: null,
      query: null,
      inputQueue: new AsyncMessageQueue(),
      toolNames: new Map(),
      toolStarts: new Set(),
      localCommandOutputs: [],
      outputBytes: 0,
      acceptanceTimer: null,
      cwd: session.cwd,
      remoteSessionId: session.remoteSessionId,
      model,
      permissionPolicy,
      permissionMode,
    };
    this.activeTurns.set(session.id, active);
    active.acceptanceTimer = setTimeout(
      () => this._acceptanceTimedOut(active),
      this.acceptanceTimeoutMs,
    );
    active.acceptanceTimer.unref?.();
    try {
      this._startSdkTurn(active, session, input);
    } catch (error) {
      this._failActive(active, error, { definitelyRejected: !active.inputReleased });
    }
    return active.acceptance.promise;
  }

  turnSteer(input) {
    this._assertReady();
    if (!plain(input) || !safeString(input.sessionId, 512) || !safeString(input.turnId, 512)
      || !safeString(input.operationId, 512) || !safeString(input.message, 64 * 1024)) {
      return Promise.reject(hostError("RUNTIME_TURN_PARAMS_INVALID", "Claude Code steer input is invalid"));
    }
    const active = this.activeTurns.get(input.sessionId);
    if (!active || active.turnId !== input.turnId || active.settled) {
      return Promise.reject(hostError("RUNTIME_TURN_NOT_ACTIVE", "Claude Code turn is no longer active"));
    }
    const uuid = this.randomUUID();
    if (!isUuid(uuid)) {
      return Promise.reject(hostError("RUNTIME_TURN_ID_INVALID", "Claude Code steer id is invalid"));
    }
    active.inputQueue.push(sdkUserMessage(input.message, uuid, active.remoteSessionId, "now"));
    return Promise.resolve({ turnId: active.turnId });
  }

  async turnInterrupt(input) {
    this._assertReady();
    if (!plain(input) || !safeString(input.sessionId, 512) || !safeString(input.turnId, 512)) {
      throw hostError("RUNTIME_TURN_PARAMS_INVALID", "Claude Code interrupt input is invalid");
    }
    const session = this._requireSession(input.sessionId);
    const turn = turnById(session, input.turnId);
    if (!turn) throw hostError("RUNTIME_TURN_STALE", "Claude Code turn is stale");
    const active = this.activeTurns.get(session.id);
    if (!active) {
      if (["canceled", "interrupted"].includes(turn.status)) return {};
      throw hostError("RUNTIME_TURN_NOT_ACTIVE", "Claude Code turn is no longer active");
    }
    if (active.turnId !== input.turnId) {
      throw hostError("RUNTIME_TURN_STALE", "Claude Code turn is stale");
    }
    active.interruptRequested = true;
    active.inputQueue.close();
    try { await active.query?.interrupt?.(); } catch {}
    let terminal = await Promise.race([
      active.terminal.promise,
      unrefDelay(this.requestTimeoutMs).then(() => null),
    ]);
    if (!terminal) {
      try { active.query?.close?.(); } catch {}
      this._signal(active, "SIGKILL");
      this._failActive(active, hostError(
        "CLAUDE_CODE_TURN_INTERRUPTED",
        "Claude Code turn was forcefully interrupted",
      ), { terminalStatus: "interrupted" });
      terminal = await active.terminal.promise;
    }
    if (!["canceled", "interrupted"].includes(terminal.status)) {
      throw hostError("RUNTIME_TURN_CANCEL_UNKNOWN", "Claude Code did not confirm interruption");
    }
    return {};
  }

  async modelsList(input = {}) {
    this._assertReady();
    const models = await this._ensureModelCatalog();
    const offset = input.cursor === undefined || input.cursor === null ? 0 : Number(input.cursor);
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || String(offset) !== String(input.cursor ?? offset)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw hostError("RUNTIME_MODEL_CURSOR_INVALID", "Claude Code model cursor is invalid");
    }
    const page = models.slice(offset, offset + limit).map((model, index) => ({
      ...model,
      isDefault: offset + index === 0,
      hidden: false,
    }));
    const next = offset + page.length;
    return { data: page, nextCursor: next < models.length ? String(next) : null };
  }

  async commandsList() {
    this._assertReady();
    try {
      return { supported: true, reason: null, commands: mergeNativeCommands("claude-code", await this._ensureCommandCatalog()) };
    } catch (error) {
      // Built-in TUI discovery does not require login. Preserve that reference
      // while making the missing live skills/commands explicit and retryable.
      return {
        supported: true,
        reason: `Claude Code live commands unavailable (${error?.code || "RUNTIME_COMMAND_CATALOG_UNAVAILABLE"}); showing the CLI reference. Refresh after the runtime is ready.`,
        commands: mergeNativeCommands("claude-code"),
      };
    }
  }

  async commandExecute(input) {
    this._assertExecutionInstance();
    if (!plain(input) || !safeString(input.text, 64 * 1024)) {
      throw hostError("RUNTIME_COMMAND_PARAMS_INVALID", "Claude Code command input is invalid");
    }
    const { commands } = await this.commandsList();
    const parsed = requireRuntimeCommand(input.text, commands, "claude-code");
    return { kind: "send", text: parsed.text, warning: null };
  }

  async stop() {
    if (this.stopping) return this.stopping;
    if (this.state === "stopped") return undefined;
    this.state = "stopping";
    this.stopping = (async () => {
      const active = [...this.activeTurns.values()];
      for (const turn of active) {
        turn.interruptRequested = true;
        turn.inputQueue.close();
        try { turn.query?.close?.(); } catch {}
        this._signal(turn, "SIGTERM");
      }
      for (const record of [...this.controlQueries]) {
        try { record.query.close(); } catch {}
      }
      for (const child of this.controlProcesses.keys()) {
        this._signalControlProcess(child, "SIGTERM");
      }
      if (active.length > 0) {
        await Promise.race([
          Promise.all(active.map((turn) => turn.terminal.promise)),
          delay(this.shutdownGraceMs),
        ]);
      }
      for (const turn of [...this.activeTurns.values()]) this._signal(turn, "SIGKILL");
      if (this.activeTurns.size > 0) await delay(this.killGraceMs);
      for (const turn of [...this.activeTurns.values()]) {
        this.cleanupIncomplete = true;
        this._failActive(turn, hostError(
          "CLAUDE_CODE_PROCESS_CLOSE_TIMEOUT",
          "Claude Code process did not terminate",
        ), { terminalStatus: "interrupted" });
      }
      if (this.controlProcesses.size > 0) {
        await Promise.race([
          Promise.all([...this.controlProcesses.values()].map((done) => done.promise)),
          delay(this.killGraceMs),
        ]);
      }
      for (const child of this.controlProcesses.keys()) {
        this._signalControlProcess(child, "SIGKILL");
      }
      if (this.controlProcesses.size > 0) {
        await Promise.race([
          Promise.all([...this.controlProcesses.values()].map((done) => done.promise)),
          delay(this.killGraceMs),
        ]);
      }
      if (this.controlProcesses.size > 0) this.cleanupIncomplete = true;
      this.state = "stopped";
      this.resolveTerminated();
      if (this.cleanupIncomplete) {
        const error = hostError(
          "CLAUDE_CODE_PROCESS_CLOSE_TIMEOUT",
          "Claude Code process cleanup is incomplete",
        );
        error.cleanupIncomplete = true;
        throw error;
      }
    })();
    return this.stopping;
  }

  _startSdkTurn(active, session, input) {
    const reservation = this.mcpGateIssuer.reserveMcpServer({
      runtimeProfileId: this.runtimeProfileId,
      runtimeAccountId: this.runtimeAccountId,
      parentExecutable: this.binaryPath,
    });
    active.reservationId = reservation.reservationId;
    const permission = claudeCodePermissionOptions(active.permissionPolicy, active.cwd, active.permissionMode);
    const mcpEnvironment = Object.fromEntries(reservation.env.map((entry) => [entry.name, entry.value]));
    const hasAcceptedTurn = session.turns.some((turn) => turn.acceptance === "accepted");
    const options = {
      cwd: active.cwd,
      pathToClaudeCodeExecutable: this.binaryPath,
      env: this._spawnEnvironment(),
      settingSources: this.runtimeEnvironment.configurationMode === "persistent"
        ? trustedImportedSettingSources(this.home) : [],
      strictMcpConfig: true,
      mcpServers: {
        shoggoth: {
          type: "stdio",
          command: reservation.command,
          args: [...reservation.args],
          env: mcpEnvironment,
          timeout: DEFAULT_MCP_TOOL_TIMEOUT_MS,
        },
      },
      tools: { type: "preset", preset: "claude_code" },
      includePartialMessages: true,
      forwardSubagentText: true,
      promptSuggestions: false,
      persistSession: true,
      permissionMode: permission.permissionMode,
      allowDangerouslySkipPermissions: permission.allowDangerouslySkipPermissions,
      settings: permission.settings,
      canUseTool: (toolName, toolInput, toolOptions) => (
        this._canUseTool(active, toolName, toolInput, toolOptions)
      ),
      onElicitation: (request, requestOptions) => (
        this._onElicitation(active, request, requestOptions)
      ),
      systemPrompt: defined({
        type: "preset",
        preset: "claude_code",
        append: this.sessionConfigs.get(session.id)?.developerInstructions || undefined,
      }),
      spawnClaudeCodeProcess: (spawnOptions) => this._spawnSdkTurnProcess(active, spawnOptions),
      ...(permission.sandbox ? { sandbox: permission.sandbox } : {}),
      ...(active.model ? { model: active.model } : {}),
      ...(input.thinkingLevel != null ? { effort: input.thinkingLevel } : {}),
      ...(hasAcceptedTurn
        ? { resume: active.remoteSessionId }
        : { sessionId: active.remoteSessionId, ...(session.title ? { title: session.title } : {}) }),
    };
    const prompt = this._promptText(input);
    active.inputQueue.push(sdkUserMessage(
      prompt,
      active.userMessageUuid,
      active.remoteSessionId,
      undefined,
      input.attachments,
    ));
    try {
      active.query = this.sdk.query({ prompt: active.inputQueue, options });
    } catch (error) {
      this.mcpGateIssuer.revokeMcpServer({ reservationId: reservation.reservationId });
      active.reservationId = null;
      throw hostError("CLAUDE_CODE_PROCESS_SPAWN_FAILED", "Claude Code query could not start");
    }
    Promise.resolve().then(() => this._consumeQuery(active)).catch((error) => {
      this._failActive(active, this._sdkFailure(error), {
        definitelyRejected: !active.inputReleased,
      });
    });
  }

  _spawnSdkTurnProcess(active, options) {
    if (active.settled || active.child) {
      throw hostError("CLAUDE_CODE_PROCESS_SPAWN_FAILED", "Claude Code spawned an unexpected process");
    }
    let resolvedCommand;
    try { resolvedCommand = this.fs.realpathSync(options.command); } catch {
      throw hostError("CLAUDE_CODE_PROCESS_SPAWN_FAILED", "Claude Code executable changed");
    }
    if (resolvedCommand !== this.binaryPath || !Array.isArray(options.args)) {
      throw hostError("CLAUDE_CODE_PROCESS_SPAWN_FAILED", "Claude Code SDK requested an unsafe process");
    }
    const env = this._sdkEnvironment(options.env);
    const launcher = "/bin/sh";
    const launcherArgs = [
      "-c",
      "IFS= read -r _ <&3 || exit 125; exec 3<&-; exec \"$@\"",
      "shoggoth-claude-code-launcher",
      resolvedCommand,
      ...options.args,
    ];
    let child;
    try {
      child = this.spawnProcess(launcher, launcherArgs, {
        cwd: active.cwd,
        env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        signal: options.signal,
      });
    } catch {
      throw hostError("CLAUDE_CODE_PROCESS_SPAWN_FAILED", "Claude Code process could not start");
    }
    if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 1
      || !child.stdin || !child.stdout || !child.stderr || !child.stdio?.[3]) {
      try { child?.kill?.("SIGKILL"); } catch {}
      throw hostError("CLAUDE_CODE_PROCESS_SPAWN_FAILED", "Claude Code process pipes are invalid");
    }
    active.child = child;
    child.once("error", () => {});
    child.stdio[3].once("error", () => {});
    try {
      this.mcpGateIssuer.bindMcpServer({
        reservationId: active.reservationId,
        parentPid: child.pid,
      });
      child.stdio[3].end("go\n");
      active.inputReleased = true;
    } catch (error) {
      try { child.kill("SIGKILL"); } catch {}
      throw error;
    }
    return child;
  }

  async _consumeQuery(active) {
    try {
      for await (const message of active.query) {
        if (active.settled) break;
        const terminal = await this._onSdkMessage(active, message);
        if (terminal) break;
      }
      if (!active.settled) {
        this._failActive(active, hostError(
          "CLAUDE_CODE_STREAM_RESULT_MISSING",
          "Claude Code result event is missing",
        ));
      }
    } catch (error) {
      if (!active.settled) {
        this._failActive(active, this._sdkFailure(error), {
          definitelyRejected: !active.inputReleased,
        });
      }
    } finally {
      active.inputQueue.close();
      try { active.query?.close?.(); } catch {}
    }
  }

  async _onSdkMessage(active, message) {
    if (!message || typeof message !== "object") {
      throw hostError("CLAUDE_CODE_STREAM_EVENT_INVALID", "Claude Code emitted an invalid event");
    }
    if (typeof message.session_id === "string" && message.session_id !== active.remoteSessionId) {
      throw hostError("RUNTIME_SESSION_CONFLICT", "Claude Code event session changed");
    }
    if (message.type === "system" && message.subtype === "init") {
      if (active.seenInit || message.session_id !== active.remoteSessionId
        || path.resolve(message.cwd) !== active.cwd) {
        throw hostError("CLAUDE_CODE_STREAM_SEQUENCE_INVALID", "Claude Code init event is inconsistent");
      }
      active.seenInit = true;
      this._publish({
        known: true,
        method: "claude-code/system/init",
        type: "status",
        sessionId: active.sessionId,
        turnId: active.turnId,
        status: "started",
      });
      return false;
    }
    if (!active.seenInit) {
      throw hostError("CLAUDE_CODE_STREAM_SEQUENCE_INVALID", "Claude Code emitted data before init");
    }
    if (message.type === "stream_event") {
      this._acceptActive(active);
      this._onStreamEvent(active, message.event);
      return false;
    }
    if (message.type === "assistant") {
      this._acceptActive(active);
      this._onAssistantMessage(active, message);
      return false;
    }
    if (message.type === "user") {
      if (this._onUserMessage(active, message)) this._acceptActive(active);
      return false;
    }
    if (message.type === "tool_use_summary" && safeString(message.summary, 16 * 1024)) {
      this._acceptActive(active);
      this._publish({
        known: true,
        method: "claude-code/tool_use_summary",
        type: "reasoning",
        sessionId: active.sessionId,
        turnId: active.turnId,
        reasoning: message.summary,
      });
      return false;
    }
    if (message.type === "system" && message.subtype === "status") {
      this._publish({
        known: true,
        method: "claude-code/system/status",
        type: "status",
        sessionId: active.sessionId,
        turnId: active.turnId,
        status: message.status || "running",
      });
      return false;
    }
    if (message.type === "system" && message.subtype === "commands_changed") {
      this.commandCatalog = normalizeRuntimeCommands(message.commands, {
        errorCode: "RUNTIME_COMMAND_CATALOG_INVALID",
        errorMessage: "Claude Code command catalog format changed",
      });
      this.commandsExpiresAt = this.now() + COMMAND_CACHE_MS;
      return false;
    }
    if (message.type === "system" && message.subtype === "local_command_output") {
      if (!safeString(message.content, MAX_TURN_OUTPUT_BYTES, { empty: true })) {
        throw hostError("CLAUDE_CODE_STREAM_EVENT_INVALID", "Claude Code command output is invalid");
      }
      this._acceptActive(active);
      this._appendOutput(active, message.content);
      if (message.content.length === 0) return false;
      if (active.localCommandOutputs.length >= 1023) {
        throw hostError("CLAUDE_CODE_TURN_OUTPUT_TOO_LARGE", "Claude Code emitted too many command outputs");
      }
      const outputIndex = active.localCommandOutputs.length;
      active.localCommandOutputs.push(message.content);
      this._publish({
        known: true,
        method: "claude-code/system/local_command_output",
        type: "text",
        sessionId: active.sessionId,
        turnId: active.turnId,
        itemId: `claude-code-command-${active.turnId}-${outputIndex}`,
        text: message.content,
        phase: "final_answer",
        delivery: "local",
      });
      return false;
    }
    if (message.type === "result") {
      active.result = message;
      if (message.user_message_uuid === active.userMessageUuid || message.num_turns > 0) {
        this._acceptActive(active);
      }
      if (!active.accepted) {
        this._failActive(active, hostError(
          resultFailureCode(message),
          "Claude Code rejected the turn before acceptance",
        ), { definitelyRejected: message.num_turns === 0 });
        return true;
      }
      const failed = message.subtype !== "success" || message.is_error === true;
      const status = active.interruptRequested
        ? "interrupted" : failed ? "failed" : "completed";
      this._finishActive(active, status, failed ? resultFailureCode(message) : null, message);
      return true;
    }
    try { this.onDiagnostic?.({ code: "CLAUDE_CODE_STREAM_EVENT_UNKNOWN" }); } catch {}
    return false;
  }

  _onStreamEvent(active, event) {
    if (!event || typeof event !== "object") return;
    if (event.type === "content_block_delta") {
      const delta = event.delta;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        this._appendOutput(active, delta.text);
        this._publish({
          known: true,
          method: "claude-code/content_block_delta",
          type: "text_delta",
          sessionId: active.sessionId,
          turnId: active.turnId,
          delta: delta.text,
        });
      } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
        const text = delta.thinking;
        this._appendOutput(active, text);
        this._publish({
          known: true,
          method: "claude-code/thinking_delta",
          type: "reasoning_delta",
          sessionId: active.sessionId,
          turnId: active.turnId,
          delta: text,
        });
      }
      // signature_delta is an opaque integrity value for extended thinking.
      // It is neither user-visible reasoning nor text output.
      return;
    }
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      this._publishToolStart(active, event.content_block);
    }
  }

  _onAssistantMessage(active, message) {
    const content = message.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type === "tool_use") this._publishToolStart(active, block);
    }
  }

  _onUserMessage(active, message) {
    const content = message.message?.content;
    if (!Array.isArray(content)) return false;
    let sawToolResult = false;
    for (const block of content) {
      if (block?.type !== "tool_result" || !safeString(block.tool_use_id, 512)) continue;
      sawToolResult = true;
      const name = active.toolNames.get(block.tool_use_id) || "tool";
      const output = block.content === undefined ? undefined : safeSnapshot(block.content, {
        registeredSecrets: this.registeredSecrets,
        maxSnapshotBytes: 64 * 1024,
      });
      this._publish({
        known: true,
        method: "claude-code/tool_result",
        type: "tool_result",
        sessionId: active.sessionId,
        turnId: active.turnId,
        itemId: block.tool_use_id,
        toolCallId: block.tool_use_id,
        tool: {
          kind: toolKind(name),
          name,
          status: block.is_error === true ? "failed" : "completed",
          success: block.is_error !== true,
          ...(output === undefined ? {} : { output }),
        },
      });
    }
    return sawToolResult;
  }

  _publishToolStart(active, block) {
    if (!safeString(block?.id, 512) || !safeString(block?.name, 256)
      || active.toolStarts.has(block.id)) return;
    active.toolStarts.add(block.id);
    active.toolNames.set(block.id, block.name);
    this._publish({
      known: true,
      method: "claude-code/tool_start",
      type: "tool_start",
      sessionId: active.sessionId,
      turnId: active.turnId,
      itemId: block.id,
      toolCallId: block.id,
      tool: {
        kind: toolKind(block.name),
        name: block.name,
        status: "in_progress",
        input: safeSnapshot(block.input ?? {}, { maxSnapshotBytes: 64 * 1024 }),
      },
    });
  }

  async _canUseTool(active, toolName, input, options = {}) {
    if (active.settled || options.signal?.aborted) {
      return { behavior: "deny", message: "The turn is no longer active", interrupt: true };
    }
    this._acceptActive(active);
    if (toolName === "AskUserQuestion") return this._askUserQuestion(active, input, options);
    if (this._toolEscapesWorkspace(active, toolName, input)) {
      return { behavior: "deny", message: "The requested path is outside the assigned workspace" };
    }
    if (active.permissionPolicy.sandbox === "read-only" && (WRITE_TOOLS.has(toolName) || toolName === "Bash")) {
      return { behavior: "deny", message: "This runtime is read-only" };
    }
    if (active.permissionMode === "dontAsk") {
      return { behavior: "deny", message: "This permission mode does not ask for approval" };
    }
    if (active.permissionPolicy.approvalPolicy === "never") {
      return { behavior: "allow", updatedInput: plain(input) ? input : {} };
    }
    const method = WRITE_TOOLS.has(toolName)
      ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval";
    const sessionPermissions = Array.isArray(options.suggestions)
      ? options.suggestions.filter((suggestion) => suggestion?.destination === "session") : [];
    const params = method === "item/fileChange/requestApproval"
      ? {
        sessionId: active.sessionId,
        turnId: active.turnId,
        itemId: options.toolUseID,
        grantRoot: active.cwd,
        reason: options.title || options.decisionReason || `${toolName} requires approval`,
        sessionApprovalAvailable: sessionPermissions.length > 0,
      }
      : {
        sessionId: active.sessionId,
        turnId: active.turnId,
        itemId: options.toolUseID,
        command: toolName === "Bash" && typeof input?.command === "string"
          ? input.command : `${toolName}(${JSON.stringify(safeSnapshot(input ?? {}, {
            maxSnapshotBytes: 8 * 1024,
          }))})`,
        cwd: active.cwd,
        reason: options.title || options.decisionReason || `${toolName} requires approval`,
        sessionApprovalAvailable: sessionPermissions.length > 0,
      };
    params.toolName = toolName;
    params.toolInput = safeSnapshot(input ?? {}, { maxSnapshotBytes: 16 * 1024 });
    try {
      const response = await this._requestServer(active, method, params, options.signal);
      if (["accept", "acceptForSession"].includes(response?.decision)) {
        return defined({
          behavior: "allow",
          updatedInput: plain(input) ? input : {},
          updatedPermissions: response.decision === "acceptForSession"
            && sessionPermissions.length > 0 ? sessionPermissions : undefined,
        });
      }
      return {
        behavior: "deny",
        message: response?.decision === "cancel" ? "User canceled the turn" : "User denied the tool",
        interrupt: response?.decision === "cancel",
      };
    } catch {
      return { behavior: "deny", message: "Tool approval was unavailable" };
    }
  }

  async _askUserQuestion(active, input, options) {
    const normalized = questionSchema(input);
    if (!normalized) {
      return { behavior: "deny", message: "Claude Code emitted an invalid question" };
    }
    try {
      const response = await this._requestServer(active, "mcpServer/elicitation/request", {
        sessionId: active.sessionId,
        turnId: active.turnId,
        serverName: "claude-code",
        mode: "form",
        message: options.title || "Claude Code 需要补充信息",
        requestedSchema: normalized.schema,
        elicitationId: options.toolUseID,
      }, options.signal);
      if (response?.action !== "accept" || !plain(response.content)) {
        return { behavior: "deny", message: "User canceled the question" };
      }
      const answers = {};
      for (const mapping of normalized.mappings) {
        if (typeof response.content[mapping.id] === "string") {
          answers[mapping.question] = response.content[mapping.id];
        }
      }
      return { behavior: "allow", updatedInput: { ...input, answers } };
    } catch {
      return { behavior: "deny", message: "User input was unavailable" };
    }
  }

  async _onElicitation(active, request, options = {}) {
    if (active.settled || options.signal?.aborted || !request || typeof request !== "object") {
      return { action: "cancel" };
    }
    this._acceptActive(active);
    if (request.mode === "url") return { action: "cancel" };
    const requestedSchema = plain(request.requestedSchema)
      ? request.requestedSchema : { type: "object", properties: {} };
    try {
      const response = await this._requestServer(active, "mcpServer/elicitation/request", defined({
        sessionId: active.sessionId,
        turnId: active.turnId,
        serverName: safeString(request.serverName, 128) ? request.serverName : "shoggoth",
        mode: "form",
        message: safeString(request.message, 4096) ? request.message : "需要补充信息",
        requestedSchema,
        url: safeString(request.url, 4096) ? request.url : undefined,
        elicitationId: safeString(request.elicitationId, 512)
          ? request.elicitationId : options.requestId,
      }), options.signal);
      return response?.action === "accept"
        ? { action: "accept", content: plain(response.content) ? response.content : {} }
        : { action: "cancel" };
    } catch {
      return { action: "cancel" };
    }
  }

  async _requestServer(active, method, params, signal) {
    const handler = this.serverRequestHandlers.get(method);
    if (typeof handler !== "function") {
      throw hostError("RUNTIME_SERVER_REQUEST_UNAVAILABLE", "Claude Code request handler is unavailable");
    }
    const timeoutMs = serverRequestUsesApprovalWait(method, params)
      ? null : this.serverRequestTimeoutMs;
    let timer = null;
    let abortListener;
    const timeout = timeoutMs === null ? null : new Promise((_, reject) => {
      timer = setTimeout(() => reject(hostError(
        "RUNTIME_SERVER_REQUEST_TIMEOUT",
        "Claude Code request timed out",
      )), timeoutMs);
      timer.unref?.();
    });
    const aborted = new Promise((_, reject) => {
      if (!signal) return;
      abortListener = () => reject(hostError(
        "RUNTIME_SERVER_REQUEST_ABORTED",
        "Claude Code request was aborted",
      ));
      if (signal.aborted) abortListener();
      else signal.addEventListener("abort", abortListener, { once: true });
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => handler(params)),
        ...(timeout === null ? [] : [timeout]),
        aborted,
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    }
  }

  _toolEscapesWorkspace(active, toolName, input) {
    if (active.permissionPolicy.sandbox === "danger-full-access" || !WRITE_TOOLS.has(toolName)) {
      return false;
    }
    const candidates = [input?.file_path, input?.path, input?.notebook_path]
      .filter((value) => typeof value === "string" && value.length > 0);
    return candidates.some((candidate) => {
      const resolved = path.resolve(this.workspace, candidate);
      const relative = path.relative(this.workspace, resolved);
      return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    });
  }

  _acceptActive(active) {
    if (active.settled || active.accepted) return;
    const timestamp = this.now();
    this.ledger.update((data) => {
      const session = sessionById(data, active.sessionId);
      const turn = turnById(session, active.turnId);
      if (!turn || turn.acceptance !== "unknown") {
        throw hostError("RUNTIME_TURN_RECEIPT_CONFLICT", "Claude Code receipt is inconsistent");
      }
      turn.acceptance = "accepted";
      turn.updatedAt = Math.max(turn.updatedAt, timestamp);
      session.updatedAt = Math.max(session.updatedAt, timestamp);
    });
    active.accepted = true;
    this.profileState.authenticated = true;
    this.profileState.credentialPresent = true;
    this.profileState.authCheckedAt = timestamp;
    clearTimeout(active.acceptanceTimer);
    active.acceptanceTimer = null;
    active.acceptance.resolve({ turn: { id: active.turnId, status: "inProgress", items: [] } });
  }

  _finishActive(active, status, errorCode, result) {
    if (active.settled || !TERMINAL_STATUSES.has(status)) return;
    const timestamp = this.now();
    const responseId = responseIdFor(active, result);
    const response = typeof result.result === "string" ? result.result : "";
    if (Buffer.byteLength(response, "utf8") > MAX_TURN_OUTPUT_BYTES) {
      this._failActive(active, hostError(
        "CLAUDE_CODE_TURN_OUTPUT_TOO_LARGE",
        "Claude Code response is too large",
      ), { terminalStatus: "failed" });
      return;
    }
    const usage = usageFromResult(result);
    const assistantMessages = active.localCommandOutputs.map((text, index) => ({
      id: `claude-code-command-${active.turnId}-${index}`,
      text,
    }));
    const duplicateLocalOutput = active.localCommandOutputs.includes(response);
    if (response.length > 0 && !duplicateLocalOutput) {
      assistantMessages.push({ id: `claude-code-message-${active.turnId}`, text: response });
    }
    this.ledger.update((data) => {
      const session = sessionById(data, active.sessionId);
      const turn = turnById(session, active.turnId);
      turn.status = status;
      turn.errorCode = errorCode;
      turn.assistantMessages = assistantMessages;
      turn.responseId = responseId;
      turn.updatedAt = Math.max(turn.updatedAt, timestamp);
      session.updatedAt = Math.max(session.updatedAt, timestamp);
    });
    active.settled = true;
    this._clearActive(active);
    const common = {
      known: true,
      method: "claude-code/result",
      sessionId: active.sessionId,
      turnId: active.turnId,
    };
    if (response.length > 0 && !duplicateLocalOutput) {
      this._publish({
        ...common,
        type: "text",
        itemId: `claude-code-message-${active.turnId}`,
        text: response,
        phase: "final_answer",
        delivery: "local",
      });
    }
    this._publish({
      ...common,
      type: "usage",
      responseId,
      usage,
      ...usageIdentity(result, active.model),
    });
    this._publish({ ...common, type: "complete", status });
    active.terminal.resolve({ status });
  }

  _failActive(active, error, options = {}) {
    if (active.settled) return;
    const failure = error?.code ? error
      : hostError("CLAUDE_CODE_TURN_FAILED", "Claude Code turn failed");
    const timestamp = this.now();
    const definitelyRejected = options.definitelyRejected === true;
    const acceptance = active.accepted ? "accepted" : definitelyRejected ? "failed" : "unknown";
    const requestedStatus = options.terminalStatus;
    const status = TERMINAL_STATUSES.has(requestedStatus)
      ? requestedStatus : active.accepted ? "interrupted" : definitelyRejected ? "failed" : "interrupted";
    try {
      this.ledger.update((data) => {
        const session = sessionById(data, active.sessionId);
        const turn = turnById(session, active.turnId);
        turn.acceptance = acceptance;
        turn.status = status;
        turn.errorCode = failure.code;
        turn.updatedAt = Math.max(turn.updatedAt, timestamp);
        session.updatedAt = Math.max(session.updatedAt, timestamp);
      });
    } catch (ledgerFailure) {
      active.acceptance.reject(ledgerFailure);
      active.terminal.resolve({ status: "interrupted" });
      active.settled = true;
      this._clearActive(active);
      return;
    }
    if (failure.code === "AUTH_REQUIRED") {
      this.profileState.authenticated = false;
      this.profileState.credentialPresent = false;
      this.profileState.authCheckedAt = timestamp;
      this.profileState.models = null;
      this.profileState.modelsExpiresAt = 0;
      this.commandCatalog = null;
      this.commandsExpiresAt = 0;
    }
    active.settled = true;
    active.inputQueue.close();
    try { active.query?.close?.(); } catch {}
    this._clearActive(active);
    if (!active.accepted) active.acceptance.reject(failure);
    this._publish({
      known: true,
      method: "claude-code/result",
      type: "complete",
      sessionId: active.sessionId,
      turnId: active.turnId,
      status,
    });
    active.terminal.resolve({ status });
  }

  _acceptanceTimedOut(active) {
    if (active.settled || active.accepted) return;
    try { active.query?.close?.(); } catch {}
    this._signal(active, "SIGKILL");
    this._failActive(active, hostError(
      "RUNTIME_TURN_ACCEPTANCE_UNKNOWN",
      "Claude Code did not prove turn acceptance",
    ));
  }

  _clearActive(active) {
    clearTimeout(active.acceptanceTimer);
    active.acceptanceTimer = null;
    if (active.reservationId) {
      try { this.mcpGateIssuer.revokeMcpServer({ reservationId: active.reservationId }); } catch {}
      active.reservationId = null;
    }
    if (this.activeTurns.get(active.sessionId) === active) this.activeTurns.delete(active.sessionId);
  }

  _signal(active, signal) {
    if (!active.child || !Number.isSafeInteger(active.child.pid)) return;
    try { this.killProcessGroup(active.child.pid, signal); } catch {}
  }

  _signalControlProcess(child, signal) {
    try {
      if (this.controlProcessGroups.has(child) && Number.isSafeInteger(child.pid) && child.pid > 1) {
        this.killProcessGroup(child.pid, signal);
      } else child.kill(signal);
    } catch {}
  }

  _publish(event) {
    for (const listener of [...this.listeners]) {
      try { listener(Object.freeze(event)); } catch {}
    }
  }

  _appendOutput(active, text) {
    active.outputBytes += Buffer.byteLength(text, "utf8");
    if (active.outputBytes > MAX_TURN_OUTPUT_BYTES) {
      throw hostError("CLAUDE_CODE_TURN_OUTPUT_TOO_LARGE", "Claude Code response is too large");
    }
  }

  async _ensureModelCatalog() {
    const now = this.now();
    if (Array.isArray(this.profileState.models) && this.profileState.modelsExpiresAt > now) {
      return this.profileState.models;
    }
    const auth = await this._readAuthenticationState(true);
    if (!auth.authenticated) throw hostError("AUTH_REQUIRED", "Claude Code authentication is required");
    const input = new AsyncMessageQueue();
    let query;
    const record = { query: null };
    try {
      query = this.sdk.query({
        prompt: input,
        options: {
          cwd: this.workspace || this.userHome,
          pathToClaudeCodeExecutable: this.binaryPath,
          env: this._spawnEnvironment(),
          settingSources: this.runtimeEnvironment.configurationMode === "persistent"
            ? trustedImportedSettingSources(this.home) : [],
          strictMcpConfig: true,
          mcpServers: {},
          skills: [],
          tools: [],
          persistSession: false,
          permissionMode: "dontAsk",
          spawnClaudeCodeProcess: (options) => this._spawnSdkControlProcess(options),
        },
      });
      record.query = query;
      this.controlQueries.add(record);
      const models = normalizeModels(await Promise.race([
        query.supportedModels(),
        unrefDelay(this.requestTimeoutMs).then(() => {
          throw hostError("RUNTIME_MODEL_CATALOG_UNAVAILABLE", "Claude Code model catalog timed out");
        }),
      ]));
      this._assertReady();
      this.profileState.models = models;
      this.profileState.modelsExpiresAt = now + MODEL_CACHE_MS;
      return models;
    } catch (error) {
      if (error?.code === "RUNTIME_MODEL_CATALOG_UNAVAILABLE"
        || error?.code === "RUNTIME_MODEL_CATALOG_INVALID") throw error;
      if (AUTH_ERROR_PATTERN.test(String(error?.message || ""))) {
        this.profileState.authenticated = false;
        this.profileState.credentialPresent = false;
        this.profileState.authCheckedAt = now;
        throw hostError("AUTH_REQUIRED", "Claude Code authentication is required");
      }
      throw hostError("RUNTIME_MODEL_CATALOG_UNAVAILABLE", "Claude Code model catalog is unavailable");
    } finally {
      input.close();
      try { query?.close?.(); } catch {}
      this.controlQueries.delete(record);
    }
  }

  async _ensureCommandCatalog() {
    const now = this.now();
    if (Array.isArray(this.commandCatalog) && this.commandsExpiresAt > now) {
      return this.commandCatalog;
    }
    const input = new AsyncMessageQueue();
    let query;
    const record = { query: null };
    try {
      query = this.sdk.query({
        prompt: input,
        options: {
          cwd: this.workspace || this.userHome,
          pathToClaudeCodeExecutable: this.binaryPath,
          env: this._spawnEnvironment(),
          settingSources: this.runtimeEnvironment.configurationMode === "persistent"
            ? trustedImportedSettingSources(this.home) : [],
          strictMcpConfig: true,
          mcpServers: {},
          tools: [],
          persistSession: false,
          permissionMode: "dontAsk",
          spawnClaudeCodeProcess: (options) => this._spawnSdkControlProcess(options),
        },
      });
      record.query = query;
      this.controlQueries.add(record);
      if (typeof query.supportedCommands !== "function") {
        throw hostError(
          "RUNTIME_COMMAND_CATALOG_UNAVAILABLE",
          "Claude Code SDK does not expose a command catalog",
        );
      }
      const commands = normalizeRuntimeCommands(await Promise.race([
        query.supportedCommands(),
        unrefDelay(this.requestTimeoutMs).then(() => {
          throw hostError(
            "RUNTIME_COMMAND_CATALOG_UNAVAILABLE",
            "Claude Code command catalog timed out",
          );
        }),
      ]), {
        errorCode: "RUNTIME_COMMAND_CATALOG_INVALID",
        errorMessage: "Claude Code command catalog format changed",
      });
      this._assertReady();
      this.commandCatalog = commands;
      this.commandsExpiresAt = now + COMMAND_CACHE_MS;
      return commands;
    } catch (error) {
      if (error?.code === "RUNTIME_COMMAND_CATALOG_UNAVAILABLE"
        || error?.code === "RUNTIME_COMMAND_CATALOG_INVALID") throw error;
      if (AUTH_ERROR_PATTERN.test(String(error?.message || ""))) {
        this.profileState.authenticated = false;
        this.profileState.credentialPresent = false;
        this.profileState.authCheckedAt = now;
        throw hostError("AUTH_REQUIRED", "Claude Code authentication is required");
      }
      throw hostError(
        "RUNTIME_COMMAND_CATALOG_UNAVAILABLE",
        "Claude Code command catalog is unavailable",
      );
    } finally {
      input.close();
      try { query?.close?.(); } catch {}
      this.controlQueries.delete(record);
    }
  }

  _spawnSdkControlProcess(options) {
    if (!Array.isArray(options.args)) {
      throw hostError("CLAUDE_CODE_PROCESS_SPAWN_FAILED", "Claude Code SDK control process is invalid");
    }
    let command;
    try { command = this.fs.realpathSync(options.command); } catch {
      throw hostError("CLAUDE_CODE_PROCESS_SPAWN_FAILED", "Claude Code executable changed");
    }
    if (command !== this.binaryPath) {
      throw hostError("CLAUDE_CODE_PROCESS_SPAWN_FAILED", "Claude Code SDK requested an unsafe process");
    }
    let child;
    try {
      child = this.spawnProcess(command, options.args, {
        cwd: options.cwd || this.workspace || this.userHome,
        env: this._sdkEnvironment(options.env),
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        signal: options.signal,
      });
    } catch {
      throw hostError("CLAUDE_CODE_PROCESS_SPAWN_FAILED", "Claude Code control process could not start");
    }
    if (!child?.stdin || !child?.stdout || !child?.stderr) {
      try { child?.kill?.("SIGKILL"); } catch {}
      throw hostError("CLAUDE_CODE_PROCESS_SPAWN_FAILED", "Claude Code control pipes are invalid");
    }
    this.controlProcessGroups.add(child);
    this._trackControlProcess(child);
    return child;
  }

  _trackControlProcess(child) {
    const done = makeDeferred();
    this.controlProcesses.set(child, done);
    const finish = () => {
      if (this.controlProcesses.delete(child)) done.resolve();
    };
    child.once("exit", finish);
    child.once("error", finish);
    return done.promise;
  }

  _validateModel(model) {
    if (model === undefined || model === null) return null;
    if (!safeString(model, 512)
      || !this.profileState.models?.some((candidate) => candidate.model === model)) {
      throw hostError("RUNTIME_MODEL_UNAVAILABLE", "Claude Code model is unavailable");
    }
    return model;
  }

  _sessionCwd(value) {
    const cwd = value === undefined || value === null ? (this.workspace || this.userHome)
      : normalizeClaudeCodeWorkspace(value);
    if (this.workspace !== null && cwd !== this.workspace) {
      throw hostError("CLAUDE_CODE_WORKSPACE_INVALID", "Claude Code workspace route changed");
    }
    try {
      const stat = this.fs.lstatSync(cwd);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe cwd");
    } catch {
      throw hostError("CLAUDE_CODE_WORKSPACE_INVALID", "Claude Code workspace is unavailable");
    }
    return cwd;
  }

  _assertInputPermissionPolicy(value) {
    return normalizeClaudeCodePermissionPolicy(value);
  }

  _requireSession(sessionId) {
    if (!safeString(sessionId, 512)) {
      throw hostError("RUNTIME_SESSION_PARAMS_INVALID", "Claude Code session id is invalid");
    }
    const session = sessionById(this.ledger.snapshot(), sessionId);
    if (!session) throw hostError("RUNTIME_SESSION_NOT_FOUND", "Claude Code session was not found");
    return session;
  }

  _projectSession(session, includeTurns = false) {
    return defined({
      id: session.id,
      source: session.source,
      cwd: session.cwd,
      name: session.title,
      archived: session.archived,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(includeTurns ? {
        turns: session.turns.map((turn) => ({
          id: turn.id,
          status: turn.status,
          itemsView: "full",
          items: turn.acceptance !== "accepted" ? [] : [
            { type: "userMessage", clientId: turn.operationId },
            ...turn.assistantMessages.map((message) => ({
              id: message.id,
              type: "agentMessage",
              text: message.text,
              phase: "final_answer",
              delivery: "local",
            })),
          ],
        })),
      } : {}),
    });
  }

  _promptText(input) {
    if (Array.isArray(this.commandCatalog)
      && parseRuntimeCommand(input.prompt, this.commandCatalog)) return input.prompt.trim();
    const blocks = [];
    if (typeof input.context === "string" && input.context.length > 0) blocks.push(input.context);
    blocks.push(`CURRENT USER REQUEST\n${input.prompt}`);
    return blocks.join("\n\n");
  }

  _spawnEnvironment() {
    const env = Object.create(null);
    for (const key of PARENT_ENV_ALLOWLIST) {
      const value = this.parentEnv[key];
      if (typeof value === "string" && value.isWellFormed() && !value.includes("\0")
        && Buffer.byteLength(value, "utf8") <= 4096) env[key] = value;
    }
    env.PATH = runtimePath(env.PATH, this.userHome);
    env.HOME = this.runtimeEnvironment.spawnEnv.HOME;
    env.CLAUDE_CONFIG_DIR = this.runtimeEnvironment.spawnEnv.CLAUDE_CONFIG_DIR;
    env.CLAUDE_AGENT_SDK_CLIENT_APP = "shoggoth-desktop";
    env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
    env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = "false";
    env.DISABLE_AUTOUPDATER = "1";
    return env;
  }

  _sdkEnvironment(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw hostError("CLAUDE_CODE_PROCESS_SPAWN_FAILED", "Claude Code SDK environment is invalid");
    }
    const env = this._spawnEnvironment();
    for (const key of SDK_ENV_ALLOWLIST) {
      const entry = value[key];
      if (entry === undefined) continue;
      if (!safeString(entry, 16 * 1024, { empty: true })) {
        throw hostError("CLAUDE_CODE_PROCESS_SPAWN_FAILED", "Claude Code SDK environment is unsafe");
      }
      env[key] = entry;
    }
    return env;
  }

  _runControl(args, options = {}) {
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnProcess(this.binaryPath, args, {
          cwd: this.workspace || this.userHome,
          env: this._spawnEnvironment(),
          detached: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        reject(hostError("CLAUDE_CODE_CONTROL_FAILED", "Claude Code control command could not start"));
        return;
      }
      if (!child?.stdout || !child?.stderr) {
        try { child?.kill?.("SIGKILL"); } catch {}
        reject(hostError("CLAUDE_CODE_CONTROL_FAILED", "Claude Code control pipes are invalid"));
        return;
      }
      this._trackControlProcess(child);
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const append = (current, chunk, maxBytes) => {
        const next = `${current}${Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)}`;
        if (Buffer.byteLength(next, "utf8") > maxBytes) {
          try { child.kill("SIGKILL"); } catch {}
          finish(() => reject(hostError(
            "CLAUDE_CODE_CONTROL_OUTPUT_TOO_LARGE",
            "Claude Code control output is too large",
          )));
          return current;
        }
        return next;
      };
      child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk, MAX_CONTROL_OUTPUT_BYTES); });
      child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk, MAX_STDERR_BYTES); });
      child.once("error", () => finish(() => reject(hostError(
        "CLAUDE_CODE_CONTROL_FAILED",
        "Claude Code control command failed",
      ))));
      child.once("close", (code, signal) => finish(() => resolve({ code, signal, stdout, stderr })));
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        finish(() => reject(hostError(
          "CLAUDE_CODE_CONTROL_TIMEOUT",
          "Claude Code control command timed out",
        )));
      }, timeoutMs);
      timer.unref?.();
    });
  }

  _sdkFailure(error) {
    if (error?.code) return error;
    return hostError(
      AUTH_ERROR_PATTERN.test(String(error?.message || "")) ? "AUTH_REQUIRED" : "CLAUDE_CODE_TURN_FAILED",
      AUTH_ERROR_PATTERN.test(String(error?.message || ""))
        ? "Claude Code authentication is required" : "Claude Code turn failed",
    );
  }

  _assertReady() {
    if (this.state !== "ready") {
      throw hostError("RUNTIME_HOST_TERMINATED", "Claude Code host is not available");
    }
  }

  _assertExecutionInstance() {
    this._assertReady();
    if (this.controlInstance) {
      throw hostError("RUNTIME_EXECUTION_INSTANCE_REQUIRED", "Claude Code execution host is required");
    }
  }
}

module.exports = {
  AsyncMessageQueue,
  ClaudeCodeRuntimeHost,
  normalizeModels,
  parseAuthStatus,
  questionSchema,
  usageFromResult,
};
