"use strict";
const { openRuntimeLedger } = require("./runtime-shared-ledger");

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { serviceError } = require("./security");
const { classifyProviderLimit } = require("./runtime-provider-errors");
const { runtimeBinding } = require("./runtime-adapter");
const { validateResolvedEnvironment } = require("./runtime-account-resolver");
const { safeSnapshot } = require("./codex-event-snapshot");
const { getModelCatalogCache, modelCatalogIdentity } = require("./model-catalog-cache");
const {
  ANTIGRAVITY_RUNTIME,
  antigravityWorkspaceShardId,
  buildAntigravityTurnArgs,
  normalizeAntigravityPermissionPolicy,
  normalizeAntigravityWorkspace,
  parseAntigravityVersion,
  prepareAntigravityKeychainContext,
  supportsAntigravityVersion,
} = require("./antigravity-runtime-paths");
const {
  AntigravityStreamJsonDecoder,
  encodeAntigravityUserMessage,
} = require("./antigravity-stream-json");
const {
  AntigravityRuntimeLedger,
  emptyAntigravityUsage,
} = require("./antigravity-runtime-ledger");
const { writeAntigravityManagedConfig, prepareAntigravityNativeOnboarding } = require("./antigravity-runtime-config");
const { normalizeRuntimeCommands, parseRuntimeCommand } = require("./runtime-commands");
const { cliReferenceCommands, mergeNativeCommands, requireRuntimeCommand } = require("./native-cli-commands");
const ANTIGRAVITY_READ_COMMANDS = new Set(["credits", "usage", "hooks", "skills", "changelog"]);

function parseAntigravityCommands(text, skills = false) {
  const reference = cliReferenceCommands("antigravity");
  const rows = text.split(/\r?\n/u).filter((line) => line.trim()).map((line) => {
    const match = /^\/?([a-z0-9][a-z0-9._:-]*)(?:\s+\(([^)]+)\))?\t(.+)$/u.exec(line.trim());
    if (!match) throw hostError("RUNTIME_COMMAND_CATALOG_INVALID", "Antigravity command catalog format changed");
    const [, name, aliases, description] = match;
    const builtin = reference.find((command) => command.name === name);
    return {
      ...builtin, name, description,
      aliases: aliases ? aliases.split(/[,\s]+/u) : builtin?.aliases || [],
      source: skills ? "Antigravity skill" : "Antigravity runtime",
      execution: skills || ANTIGRAVITY_READ_COMMANDS.has(name) ? "runtime" : builtin?.execution || "cli",
    };
  });
  return normalizeRuntimeCommands(rows);
}

const PARENT_ENV_ALLOWLIST = Object.freeze([
  "LANG", "LC_ALL", "LC_CTYPE", "PATH", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
]);
const AUTH_ERROR_PATTERN = /(?:please sign in|sign-in required|not signed in|not logged in(?:to)?|authentication required|unauthenticated)/iu;
const TOOL_PERMISSION_ERROR_PATTERN = /(?:\bpermission denied\b|\buser denied permission\b|\bapproval required\b|\bnot approved\b|soft-denying tool confirmation)/iu;
const UPSTREAM_UNAVAILABLE_PATTERN = /(?:UNAVAILABLE\s*\(code 503\)|"code"\s*:\s*503|"status"\s*:\s*"UNAVAILABLE")/iu;
const PROVIDER_LIMIT_PATTERN = /(?:RESOURCE_EXHAUSTED\s*\(code 429\)|"code"\s*:\s*429|"status"\s*:\s*"RESOURCE_EXHAUSTED")/iu;
const MAX_CONTROL_OUTPUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_TURN_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_MODELS = 256;
const TERMINAL_STATUSES = new Set(["completed", "failed", "interrupted", "canceled"]);

function hostError(code, message) {
  return serviceError(code, message);
}

function diagnosticFailure(active, extra = "", { auth = false } = {}) {
  const diagnostics = `${extra}\n${active.stderr}`;
  // Startup may log a transient "not logged in" before silent auth succeeds;
  // concrete terminal tool/upstream failures therefore take precedence.
  if (active.permissionRequired || TOOL_PERMISSION_ERROR_PATTERN.test(diagnostics)) {
    return hostError(
      "RUNTIME_APPROVAL_UNAVAILABLE",
      "Antigravity requires permission that headless mode cannot request",
    );
  }
  if (UPSTREAM_UNAVAILABLE_PATTERN.test(diagnostics)) {
    return hostError(
      "RUNTIME_UPSTREAM_UNAVAILABLE",
      "Antigravity upstream service is temporarily unavailable",
    );
  }
  // Google reports both per-minute limits and exhausted quota as 429; the
  // accompanying text decides which public reason applies.
  const limit = classifyProviderLimit(extra) ?? (PROVIDER_LIMIT_PATTERN.test(diagnostics)
    ? classifyProviderLimit(diagnostics) ?? "RUNTIME_RATE_LIMITED" : null);
  if (limit) return hostError(limit, "Antigravity provider limit reached");
  if (auth && AUTH_ERROR_PATTERN.test(diagnostics)) {
    return hostError("AUTH_REQUIRED", "Antigravity authentication is required");
  }
  return null;
}

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function toolErrorText(value) {
  if (typeof value === "string") return value;
  return plain(value) && typeof value.message === "string" ? value.message : "";
}

function hasDeniedActions(value) {
  return Array.isArray(value) && value.some((action) => (
    plain(action) && typeof action.action === "string" && action.action.length > 0
  ));
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
  if (value == null) return null;
  if (!["plan", "accept-edits", "full"].includes(value)) {
    throw hostError("RUNTIME_PERMISSION_POLICY_INVALID", "Antigravity permission mode is invalid");
  }
  return value;
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

function rawUsage(value) {
  return {
    inputTokens: value.input_tokens,
    cachedInputTokens: value.cache_read_tokens,
    cacheWriteInputTokens: 0,
    outputTokens: value.output_tokens,
    reasoningOutputTokens: value.thinking_tokens,
    totalTokens: value.total_tokens,
  };
}

function usageDelta(previous, current) {
  const keys = Object.keys(emptyAntigravityUsage());
  if (keys.some((key) => current[key] < previous[key])) return null;
  return Object.fromEntries(keys.map((key) => [key, current[key] - previous[key]]));
}

function responseIdFor(active, result) {
  const digest = crypto.createHash("sha256").update(JSON.stringify([
    active.sessionId,
    active.turnId,
    result.conversation_id,
    result.num_turns,
    result.usage,
  ])).digest("hex");
  return `antigravity-response-${digest}`;
}

function parseModelCatalog(stdout) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > MAX_CONTROL_OUTPUT_BYTES) {
    throw hostError("RUNTIME_MODEL_CATALOG_INVALID", "Antigravity model catalog is invalid");
  }
  const models = [];
  const seen = new Set();
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.length === 0 || line === "Fetching available models...") continue;
    const match = line.match(/^([a-z0-9][a-z0-9._-]{0,127})\t([^\t\r\n]{1,512})$/u);
    if (!match || seen.has(match[1]) || models.length >= MAX_MODELS) {
      throw hostError("RUNTIME_MODEL_CATALOG_INVALID", "Antigravity model catalog format changed");
    }
    seen.add(match[1]);
    models.push(Object.freeze({ model: match[1], displayName: match[2], description: "" }));
  }
  if (models.length === 0) {
    throw hostError("RUNTIME_MODEL_CATALOG_INVALID", "Antigravity returned no models");
  }
  return Object.freeze(models);
}

class AntigravityRuntimeHost {
  constructor(options = {}) {
    this.paths = options.paths;
    if (!this.paths?.stateDir || !this.paths?.trustedRoot) {
      throw hostError("ANTIGRAVITY_HOST_OPTIONS_INVALID", "Antigravity host paths are invalid");
    }
    this.binding = runtimeBinding(options.runtimeBinding || {
      runtime: ANTIGRAVITY_RUNTIME,
      runtimeProfileId: options.runtimeProfileId,
      runtimeAccountId: options.runtimeAccountId,
    });
    this.runtimeProfileId = this.binding.runtimeProfileId;
    this.runtimeAccountId = this.binding.runtimeAccountId;
    this.mcpExecutionRunId = options.mcpExecutionRunId ?? null;
    this.ledgerSlot = options.ledgerSlot || { promise: null };
    this.runtimeEnvironment = validateResolvedEnvironment(options.runtimeEnvironment, this.binding);
    this.permissionPolicy = normalizeAntigravityPermissionPolicy(options.permissionPolicy);
    this.controlInstance = options.controlInstance === true;
    this.workspace = this.controlInstance ? null : normalizeAntigravityWorkspace(options.workspace);
    this.binaryCandidate = options.binaryPath;
    this.parentEnv = options.parentEnv || process.env;
    this.userHome = path.dirname(this.runtimeEnvironment.nativeHome);
    this.platform = options.platform || process.platform;
    this.securityExecFileSync = options.securityExecFileSync;
    this.fs = options.fs || fs;
    this.spawnProcess = options.spawnProcess || spawn;
    this.nativeTerminalFactory = options.nativeTerminalFactory;
    this.killProcessGroup = options.killProcessGroup || defaultKillProcessGroup;
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.onDiagnostic = typeof options.onDiagnostic === "function" ? options.onDiagnostic : null;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 310_000;
    this.acceptanceTimeoutMs = options.acceptanceTimeoutMs ?? 30_000;
    this.nativeStartupTimeoutMs = options.nativeStartupTimeoutMs ?? 60_000;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 2_000;
    this.killGraceMs = options.killGraceMs ?? 2_000;
    this.maxFrameBytes = options.maxFrameBytes;
    this.profileState = options.profileState || {
      authenticated: false,
      authCheckedAt: 0,
      models: null,
      modelsExpiresAt: 0,
    };
    this.modelCatalogCache = getModelCatalogCache(this.profileState);
    this.mcpGateIssuer = options.mcpGateIssuer;
    if (!this.mcpGateIssuer || ["reserveMcpServer", "bindMcpServer", "revokeMcpServer"]
      .some((method) => typeof this.mcpGateIssuer[method] !== "function")) {
      throw hostError("ANTIGRAVITY_HOST_OPTIONS_INVALID", "Antigravity MCP gate issuer is invalid");
    }
    for (const value of [this.requestTimeoutMs, this.promptTimeoutMs, this.acceptanceTimeoutMs, this.nativeStartupTimeoutMs,
      this.shutdownGraceMs, this.killGraceMs]) {
      if (!Number.isSafeInteger(value) || value < 100 || value > 10 * 60 * 1_000) {
        throw hostError("ANTIGRAVITY_HOST_OPTIONS_INVALID", "Antigravity host timeout is invalid");
      }
    }
    this.state = "new";
    this.home = null;
    this.binaryPath = null;
    this.ledger = null;
    this.sessionConfigs = new Map();
    this.commandCatalog = null;
    this.skillCommands = [];
    this.commandsExpiresAt = 0;
    this.activeTurns = new Map();
    this.controlProcesses = new Map();
    this.controlRequests = new Map();
    this.listeners = new Set();
    this.serverRequestHandlers = new Map();
    this.nativeApprovalsAvailable = false;
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
      throw hostError("ANTIGRAVITY_RUNTIME_STATE_INVALID", "Antigravity host state is invalid");
    }
    this.state = "initializing";
    try {
      this.home = this.runtimeEnvironment.home;
      prepareAntigravityKeychainContext({
        home: this.home,
        userHome: this.userHome,
        trustedRoot: this.paths.trustedRoot,
        platform: this.platform,
        execFileSync: this.securityExecFileSync,
      });
      this.binaryPath = this.runtimeEnvironment.binaryPath;
      const versionResult = await this._runControl(["--version"], { timeoutMs: 5_000 });
      if (this.state !== "initializing") {
        throw hostError("RUNTIME_HOST_TERMINATED", "Antigravity host stopped during initialization");
      }
      const version = parseAntigravityVersion(versionResult.stdout);
      if (versionResult.code !== 0 || !supportsAntigravityVersion(version)) {
        throw hostError(
          "ANTIGRAVITY_VERSION_UNSUPPORTED",
          "Antigravity CLI 1.1.16 or newer is required",
        );
      }
      this.cliVersion = version.join(".");
      this.nativeApprovalsAvailable = this.platform === "darwin"
        && (version[0] > 1 || (version[0] === 1 && (version[1] > 2 || (version[1] === 2 && version[2] >= 5))));
      const workspaceShardId = antigravityWorkspaceShardId({
        controlInstance: this.controlInstance,
        workspace: this.workspace,
      });
      this.ledger = await openRuntimeLedger(this.ledgerSlot, () => new AntigravityRuntimeLedger({
        fs: this.fs,
        stateRoot: path.join(this.paths.stateDir, "runtime-ledgers", ANTIGRAVITY_RUNTIME),
        trustedRoot: this.paths.trustedRoot,
        runtimeProfileId: this.runtimeProfileId,
        workspaceShardId,
        now: this.now,
      }).open());
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

  canRetireIdle() {
    return this.state === "ready" && !this.cleanupIncomplete && !this.stopping
      && this.activeTurns.size === 0 && this.controlProcesses.size === 0 && this.controlRequests.size === 0;
  }

  beginAcquire() {
    this._assertReady();
  }

  async authenticationState({ allowDeferred = false } = {}) {
    this._assertReady();
    // agy authenticates and checks eligibility before forwarding any message.
    // A separate `models` process duplicates those network requests and can
    // fail on profile/avatar fetching before the actual CLI is even started.
    if (allowDeferred) return Object.freeze({ verificationDeferred: true });
    try {
      await this._ensureModelCatalog();
      return Object.freeze({ authenticated: true, credentialPresent: true });
    } catch (error) {
      if (error?.code === "AUTH_REQUIRED") {
        return Object.freeze({ authenticated: false, credentialPresent: false });
      }
      throw error;
    }
  }

  subscribe(listener) {
    if (typeof listener !== "function") {
      throw hostError("RUNTIME_EVENT_LISTENER_INVALID", "Antigravity listener is invalid");
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  registerServerRequestHandler(method, handler) {
    if (typeof method !== "string" || typeof handler !== "function") {
      throw hostError("RUNTIME_REQUEST_HANDLER_INVALID", "Antigravity request handler is invalid");
    }
    this.serverRequestHandlers.set(method, handler);
    return () => { if (this.serverRequestHandlers.get(method) === handler) this.serverRequestHandlers.delete(method); };
  }

  async sessionStart(input) {
    this._assertExecutionInstance();
    if (!plain(input) || !safeString(input.source, 256)
      || (input.developerInstructions !== undefined
        && !safeString(input.developerInstructions, 1024 * 1024, { empty: true }))) {
      throw hostError("RUNTIME_SESSION_PARAMS_INVALID", "Antigravity session input is invalid");
    }
    const models = input.model == null ? null : await this._ensureModelCatalog({ model: input.model });
    this._assertInputPermissionPolicy(input.permissionPolicy);
    const permissionMode = normalizePermissionMode(input.permissionMode);
    const cwd = this._sessionCwd(input.cwd);
    const model = this._validateModel(input.model, models);
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
    const createdAt = this.now();
    const session = {
      id: `antigravity-session-${this.randomUUID()}`,
      remoteConversationId: null,
      source: input.source,
      cwd,
      title: null,
      archived: false,
      lastUsage: emptyAntigravityUsage(),
      createdAt,
      updatedAt: createdAt,
      turns: [],
    };
    if (!safeString(session.id, 512)) {
      throw hostError("RUNTIME_SESSION_ID_INVALID", "Antigravity session id is invalid");
    }
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
    if (!plain(input) || !safeString(input.sessionId, 512)
      || (input.developerInstructions !== undefined
        && !safeString(input.developerInstructions, 1024 * 1024, { empty: true }))) {
      throw hostError("RUNTIME_SESSION_PARAMS_INVALID", "Antigravity resume input is invalid");
    }
    const models = input.model == null ? null : await this._ensureModelCatalog({ model: input.model });
    this._assertInputPermissionPolicy(input.permissionPolicy);
    const permissionMode = normalizePermissionMode(input.permissionMode);
    const session = this._requireSession(input.sessionId);
    if (session.archived) {
      throw hostError("RUNTIME_SESSION_NOT_FOUND", "Antigravity session is archived");
    }
    if (this.activeTurns.has(session.id)) {
      throw hostError("RUNTIME_SESSION_BUSY", "Antigravity session has an active turn");
    }
    const cwd = this._sessionCwd(input.cwd);
    if (cwd !== session.cwd) {
      throw hostError("RUNTIME_SESSION_NOT_FOUND", "Antigravity session workspace does not match");
    }
    const model = this._validateModel(input.model, models);
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
      return Promise.reject(hostError("RUNTIME_SESSION_PARAMS_INVALID", "Antigravity read input is invalid"));
    }
    const session = sessionById(this.ledger.snapshot(), input.sessionId);
    if (!session) {
      return Promise.reject(hostError("RUNTIME_SESSION_NOT_FOUND", "Antigravity session was not found"));
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
      return Promise.reject(hostError("RUNTIME_SESSION_CURSOR_INVALID", "Antigravity cursor is invalid"));
    }
    const sessions = this.ledger.snapshot().sessions
      .filter((session) => session.archived === archived)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    const page = sessions.slice(offset, offset + limit).map((session) => this._projectSession(session));
    const next = offset + page.length;
    return Promise.resolve({ data: page, nextCursor: next < sessions.length ? String(next) : null });
  }

  sessionRename(input) {
    this._assertReady();
    if (!plain(input) || !safeString(input.sessionId, 512) || !safeString(input.name, 1024)) {
      return Promise.reject(hostError("RUNTIME_SESSION_PARAMS_INVALID", "Antigravity rename input is invalid"));
    }
    this.ledger.update((data) => {
      const session = sessionById(data, input.sessionId);
      if (!session) throw hostError("RUNTIME_SESSION_NOT_FOUND", "Antigravity session was not found");
      session.title = input.name;
      session.updatedAt = Math.max(session.updatedAt, this.now());
    });
    return Promise.resolve({});
  }

  sessionArchive(input) {
    this._assertReady();
    const session = this._requireSession(input?.sessionId);
    if (this.activeTurns.has(session.id)) {
      return Promise.reject(hostError("RUNTIME_SESSION_BUSY", "Antigravity session has an active turn"));
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

  sessionDelete() {
    return Promise.reject(hostError(
      "RUNTIME_CAPABILITY_UNSUPPORTED",
      "Antigravity conversation deletion is not exposed through headless mode",
    ));
  }

  async turnStart(input) {
    this._assertExecutionInstance();
    if (!plain(input) || !safeString(input.sessionId, 512)
      || !safeString(input.operationId, 512)
      || !safeString(input.prompt, 1024 * 1024, { empty: true })
      || (input.context !== undefined && input.context !== null
        && !safeString(input.context, 4 * 1024 * 1024, { empty: true }))) {
      throw hostError("RUNTIME_TURN_PARAMS_INVALID", "Antigravity turn input is invalid");
    }
    const requestedModel = input.model ?? this.sessionConfigs.get(input.sessionId)?.model;
    // The CLI owns its default model and performs authentication itself. An
    // unrelated network catalog fetch must not block default-model sessions.
    const models = requestedModel == null ? null : await this._ensureModelCatalog({ model: requestedModel });
    const permissionPolicy = this._assertInputPermissionPolicy(input.permissionPolicy);
    const permissionMode = normalizePermissionMode(input.permissionMode
      ?? this.sessionConfigs.get(input.sessionId)?.permissionMode);
    const session = this._requireSession(input.sessionId);
    if (session.archived) {
      throw hostError("RUNTIME_SESSION_ARCHIVED", "Antigravity session is archived");
    }
    if (this._sessionCwd(input.cwd) !== session.cwd) {
      throw hostError("RUNTIME_SESSION_NOT_FOUND", "Antigravity turn workspace does not match");
    }
    const model = this._validateModel(requestedModel, models);
    const encodedInput = encodeAntigravityUserMessage(this._promptText(session.id, input));
    const fingerprint = inputFingerprint({ ...input, model });
    const existing = turnByOperation(session, input.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw hostError("RUNTIME_OPERATION_CONFLICT", "Antigravity operationId input changed");
      }
      const active = this.activeTurns.get(session.id);
      if (active?.turnId === existing.id) return active.acceptance.promise;
      if (existing.acceptance === "unknown") {
        throw hostError("RUNTIME_TURN_ACCEPTANCE_UNKNOWN", "Antigravity turn acceptance is unknown");
      }
      if (existing.acceptance === "failed") {
        throw hostError(existing.errorCode || "ANTIGRAVITY_TURN_FAILED", "Antigravity turn failed");
      }
      return { turn: { id: existing.id, status: existing.status, items: [] } };
    }
    if (this.activeTurns.has(session.id)) {
      throw hostError("RUNTIME_SESSION_BUSY", "Antigravity session already has an active turn");
    }
    const turnId = `antigravity-turn-${this.randomUUID()}`;
    if (!safeString(turnId, 512)) {
      throw hostError("RUNTIME_TURN_ID_INVALID", "Antigravity turn id is invalid");
    }
    const createdAt = this.now();
    this.ledger.update((data) => {
      const current = sessionById(data, session.id);
      current.turns.push({
        id: turnId,
        operationId: input.operationId,
        fingerprint,
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
      acceptance: makeDeferred(),
      terminal: makeDeferred(),
      inputReleased: false,
      accepted: false,
      settled: false,
      interruptRequested: false,
      seenInit: false,
      result: null,
      deferredFailure: null,
      child: null,
      reservationId: null,
      decoder: new AntigravityStreamJsonDecoder({ maxFrameBytes: this.maxFrameBytes }),
      responseText: "",
      toolSteps: new Set(),
      permissionRequired: false,
      stderr: "",
      acceptanceTimer: null,
      promptTimer: null,
      cwd: session.cwd,
      remoteConversationId: session.remoteConversationId,
      model,
      encodedInput,
      permissionPolicy,
      permissionMode,
    };
    this.activeTurns.set(session.id, active);
    try {
      await this._spawnTurn(active, input);
    } catch (error) {
      this._failActive(active, error, { definitelyRejected: !active.inputReleased });
    }
    return active.acceptance.promise;
  }

  turnSteer() {
    return Promise.reject(hostError(
      "RUNTIME_CAPABILITY_UNSUPPORTED",
      "Antigravity headless mode does not support in-turn steering",
    ));
  }

  async turnInterrupt(input) {
    this._assertReady();
    if (!plain(input) || !safeString(input.sessionId, 512) || !safeString(input.turnId, 512)) {
      throw hostError("RUNTIME_TURN_PARAMS_INVALID", "Antigravity interrupt input is invalid");
    }
    const session = this._requireSession(input.sessionId);
    const turn = turnById(session, input.turnId);
    if (!turn) throw hostError("RUNTIME_TURN_STALE", "Antigravity turn is stale");
    const active = this.activeTurns.get(session.id);
    if (!active) {
      if (["canceled", "interrupted"].includes(turn.status)) return {};
      throw hostError("RUNTIME_TURN_NOT_ACTIVE", "Antigravity turn is no longer active");
    }
    if (active.turnId !== input.turnId) {
      throw hostError("RUNTIME_TURN_STALE", "Antigravity turn is stale");
    }
    active.interruptRequested = true;
    this._signal(active, "SIGINT");
    const terminal = await Promise.race([
      active.terminal.promise,
      delay(this.requestTimeoutMs).then(() => null),
    ]);
    if (!terminal || !["canceled", "interrupted"].includes(terminal.status)) {
      this._signal(active, "SIGKILL");
      throw hostError("RUNTIME_TURN_CANCEL_UNKNOWN", "Antigravity did not confirm interruption");
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
      throw hostError("RUNTIME_MODEL_CURSOR_INVALID", "Antigravity model cursor is invalid");
    }
    const page = models.slice(offset, offset + limit).map((model, index) => ({
      ...model,
      isDefault: offset + index === 0,
      hidden: false,
      capabilities: { thinkingOptions: ["low", "medium", "high"], thinkingDefault: null, fastTier: null },
    }));
    const next = offset + page.length;
    return { data: page, nextCursor: next < models.length ? String(next) : null };
  }

  async commandsList(input = {}) {
    this._assertReady();
    if (input.sessionId != null) this._requireSession(input.sessionId);
    const cwd = this._sessionCwd(input.cwd);
    if (this.commandCatalog && this.commandsExpiresAt > this.now()) {
      return { supported: true, reason: null, commands: this.commandCatalog };
    }
    try {
      const [help, skills] = await Promise.all([
        this._runControl(["--print", "/help"], { cwd }),
        this._runControl(["--print", "/skills"], { cwd }),
      ]);
      if (help.code !== 0 || skills.code !== 0) throw hostError("RUNTIME_COMMAND_CATALOG_UNAVAILABLE", "Antigravity command discovery failed");
      const builtins = parseAntigravityCommands(help.stdout);
      if (builtins.length === 0) throw hostError("RUNTIME_COMMAND_CATALOG_INVALID", "Antigravity returned no built-in commands");
      const claimed = new Set(builtins.flatMap((command) => [command.name, ...command.aliases]));
      this.skillCommands = parseAntigravityCommands(skills.stdout, true).filter((command) => !claimed.has(command.name));
      this.commandCatalog = mergeNativeCommands("antigravity", [...builtins, ...this.skillCommands]);
      this.commandsExpiresAt = this.now() + 5_000;
      return { supported: true, reason: null, commands: this.commandCatalog };
    } catch (error) {
      return {
        supported: true,
        reason: `Antigravity live commands unavailable (${error?.code || "RUNTIME_COMMAND_CATALOG_UNAVAILABLE"}); showing the CLI reference. Refresh after the runtime is ready.`,
        commands: mergeNativeCommands("antigravity"),
      };
    }
  }

  async commandExecute(input) {
    this._assertExecutionInstance();
    const catalog = await this.commandsList(input);
    const parsed = requireRuntimeCommand(input?.text, catalog.commands, "antigravity");
    if (ANTIGRAVITY_READ_COMMANDS.has(parsed.command.name)) {
      if (parsed.args) throw hostError("RUNTIME_COMMAND_PARAMS_INVALID", `Usage: /${parsed.command.name}`);
      const result = await this._runControl(["--print", `/${parsed.command.name}`], { cwd: this._sessionCwd(input.cwd) });
      if (result.code !== 0) throw hostError("RUNTIME_COMMAND_FAILED", "Antigravity command failed");
      return { kind: "output", text: result.stdout.trim() || "No results.", warning: null };
    }
    return { kind: "send", text: parsed.text, warning: null };
  }

  async stop() {
    if (this.stopping) return this.stopping;
    if (this.state === "stopped") return undefined;
    this.state = "stopping";
    this.modelCatalogCache.invalidate();
    this.stopping = (async () => {
      const active = [...this.activeTurns.values()];
      for (const turn of active) this._signal(turn, "SIGTERM");
      const controls = [...this.controlProcesses.entries()];
      for (const [child] of controls) {
        try { child.kill("SIGKILL"); } catch {}
      }
      if (active.length > 0) {
        await Promise.race([
          Promise.all(active.map((turn) => turn.terminal.promise)),
          delay(this.shutdownGraceMs),
        ]);
      }
      const remaining = [...this.activeTurns.values()];
      for (const turn of remaining) this._signal(turn, "SIGKILL");
      if (remaining.length > 0) await delay(this.killGraceMs);
      if (controls.length > 0) {
        await Promise.race([
          Promise.all(controls.map(([, done]) => done.promise)),
          delay(this.killGraceMs),
        ]);
      }
      for (const turn of [...this.activeTurns.values()]) {
        this.cleanupIncomplete = true;
        this._failActive(turn, hostError(
          "ANTIGRAVITY_PROCESS_CLOSE_TIMEOUT",
          "Antigravity process did not terminate",
        ));
      }
      if (this.controlProcesses.size > 0) this.cleanupIncomplete = true;
      this.state = "stopped";
      this.resolveTerminated();
      if (this.cleanupIncomplete) {
        const error = hostError(
          "ANTIGRAVITY_PROCESS_CLOSE_TIMEOUT",
          "Antigravity process cleanup is incomplete",
        );
        error.cleanupIncomplete = true;
        throw error;
      }
    })();
    return this.stopping;
  }

  async _spawnTurn(active, input) {
    const full = active.permissionMode === "full" || (active.permissionMode === null
      && active.permissionPolicy.sandbox === "danger-full-access" && active.permissionPolicy.approvalPolicy === "never");
    const native = this.nativeApprovalsAvailable && !full;
    const nativeModule = native ? require("./antigravity-native-terminal") : null;
    if (native) prepareAntigravityNativeOnboarding({
      fs: this.fs, home: this.home, nativeHome: this.runtimeEnvironment.nativeHome, trustedRoot: this.paths.trustedRoot,
    });
    const reservation = this.mcpGateIssuer.reserveMcpServer({
      runtimeProfileId: this.runtimeProfileId,
      runtimeAccountId: this.runtimeAccountId,
      executionRunId: this.mcpExecutionRunId,
      parentExecutable: this.binaryPath,
    });
    active.reservationId = reservation.reservationId;
    writeAntigravityManagedConfig({
      fs: this.fs,
      home: this.home,
      trustedRoot: this.paths.trustedRoot,
      mcpServer: reservation,
      ...(native ? { statusCommand: nativeModule.STATUS_COMMAND } : {}),
    });
    const args = [...buildAntigravityTurnArgs({
      permissionPolicy: active.permissionPolicy,
      permissionMode: active.permissionMode,
      model: active.model,
      conversationId: active.remoteConversationId,
      allowSlashCommands: !!parseRuntimeCommand(input.prompt, this.skillCommands),
    })];
    // Only the current session's submitted files enter the CLI workspace. Its
    // permission engine continues to govern every other file and tool action.
    if (input.attachmentDirectory) args.push("--add-dir", input.attachmentDirectory);
    if (input.thinkingLevel != null) {
      if (!["low", "medium", "high"].includes(input.thinkingLevel)) {
        throw hostError("RUNTIME_TURN_PARAMS_INVALID", "Antigravity thinking level is invalid");
      }
      args.push("--effort", input.thinkingLevel);
    }
    const env = this._spawnEnvironment(reservation.env);
    const launcher = "/bin/sh";
    const launcherArgs = [
      "-c",
      "IFS= read -r _ <&3 || exit 125; exec \"$@\"",
      "shoggoth-antigravity-launcher",
      this.binaryPath,
      ...args,
    ];
    let child;
    try {
      child = native ? await (this.nativeTerminalFactory || nativeModule.AntigravityNativeTerminal.launch)({
        home: this.home, cwd: active.cwd, trustedRoot: this.paths.trustedRoot,
        stateRoot: path.join(this.paths.stateDir, "antigravity-terminals"),
        env, binaryPath: this.binaryPath, args, conversationId: active.remoteConversationId,
        requestApproval: async (params, context = {}) => {
          // Let the coordinator commit turn acceptance before routing a request.
          await active.acceptance.promise;
          await new Promise((resolve) => setImmediate(resolve));
          if (active.settled || active.interruptRequested || context.signal?.aborted) return { decision: "cancel" };
          const handler = this.serverRequestHandlers.get("item/commandExecution/requestApproval");
          if (!handler) throw hostError("RUNTIME_APPROVAL_UNAVAILABLE", "No Antigravity approval handler is attached");
          return handler({ ...params, sessionId: active.sessionId, threadId: active.sessionId, turnId: active.turnId }, {
            method: "item/commandExecution/requestApproval", sourceMethod: "native/approval", signal: context.signal,
          });
        },
        onApprovalWaiting: (waiting) => this._setApprovalWaiting(active, waiting),
        onInputSubmitted: () => {
          if (active.settled || active.accepted) return;
          clearTimeout(active.acceptanceTimer);
          active.acceptanceTimer = setTimeout(() => this._acceptanceTimedOut(active), this.acceptanceTimeoutMs);
          active.acceptanceTimer.unref?.();
        },
        onDiagnostic: (diagnostic) => {
          try { this.onDiagnostic?.(diagnostic); } catch {}
        },
      }) : this.spawnProcess(launcher, launcherArgs, {
        cwd: active.cwd,
        env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.mcpGateIssuer.revokeMcpServer({ reservationId: reservation.reservationId });
      throw error?.code ? error : hostError("ANTIGRAVITY_PROCESS_SPAWN_FAILED", "Antigravity process could not start");
    }
    if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 1
      || !child.stdin || !child.stdout || !child.stderr || !child.stdio?.[3]) {
      try { child?.kill?.("SIGKILL"); } catch {}
      this.mcpGateIssuer.revokeMcpServer({ reservationId: reservation.reservationId });
      throw hostError("ANTIGRAVITY_PROCESS_SPAWN_FAILED", "Antigravity process pipes are invalid");
    }
    active.child = child;
    active.nativeTerminal = native;
    if (active.settled || this.state !== "ready") { child.kill("SIGKILL"); return; }
    child.stdout.on("data", (chunk) => this._onStdout(active, chunk));
    child.stderr.on("data", (chunk) => this._onStderr(active, chunk));
    child.stdin.once("error", () => this._deferActiveFailure(
      active,
      hostError("ANTIGRAVITY_PROCESS_FAILED", "Antigravity input pipe failed"),
    ));
    child.stdio[3].once("error", () => this._deferActiveFailure(
      active,
      hostError("ANTIGRAVITY_PROCESS_FAILED", "Antigravity launch pipe failed"),
      { definitelyRejected: true },
    ));
    child.on("error", (error) => this._deferActiveFailure(
      active,
      native && error?.code ? error : hostError("ANTIGRAVITY_PROCESS_FAILED", "Antigravity process failed"),
      { definitelyRejected: error?.code === "ENOENT" || (native && child.inputRejected === true) },
    ));
    child.on("close", (code, signal) => {
      try { this._onClose(active, code, signal); } catch (error) {
        this._failActive(active, error);
      }
    });
    active.acceptanceTimer = setTimeout(
      () => this._acceptanceTimedOut(active),
      native ? this.nativeStartupTimeoutMs : this.acceptanceTimeoutMs,
    );
    active.acceptanceTimer.unref?.();
    active.promptRemainingMs = this.promptTimeoutMs;
    this._setApprovalWaiting(active, false);
    try {
      this.mcpGateIssuer.bindMcpServer({
        reservationId: reservation.reservationId,
        parentPid: child.pid,
      });
      child.stdio[3].end("go\n");
      active.inputReleased = true;
      child.stdin.end(active.encodedInput);
    } catch (error) {
      this._signal(active, "SIGKILL");
      this.mcpGateIssuer.revokeMcpServer({ reservationId: reservation.reservationId });
      throw error;
    }
  }

  _setApprovalWaiting(active, waiting) {
    if (active.settled) return;
    if (active.promptTimer) {
      clearTimeout(active.promptTimer);
      active.promptRemainingMs = Math.max(1, active.promptRemainingMs - (this.now() - active.promptStartedAt));
      active.promptTimer = null;
    }
    if (!waiting) {
      active.promptStartedAt = this.now();
      active.promptTimer = setTimeout(() => this._promptTimedOut(active), active.promptRemainingMs);
      active.promptTimer.unref?.();
    }
  }

  _onStdout(active, chunk) {
    if (active.settled || active.deferredFailure) return;
    try {
      for (const message of active.decoder.push(chunk)) this._onMessage(active, message);
    } catch (error) {
      this._deferActiveFailure(active, error);
    }
  }

  _onStderr(active, chunk) {
    if (active.settled) return;
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    active.stderr = `${active.stderr}${text}`;
    const bytes = Buffer.byteLength(active.stderr, "utf8");
    if (bytes > MAX_STDERR_BYTES) {
      active.stderr = Buffer.from(active.stderr, "utf8").subarray(bytes - MAX_STDERR_BYTES).toString("utf8");
    }
  }

  _onMessage(active, message) {
    if (!message.known) {
      try { this.onDiagnostic?.({ code: "ANTIGRAVITY_STREAM_EVENT_UNKNOWN" }); } catch {}
      return;
    }
    const { event } = message.value;
    if (event === "init") {
      if (active.seenInit) {
        throw hostError("ANTIGRAVITY_STREAM_SEQUENCE_INVALID", "Antigravity emitted duplicate init");
      }
      const remoteId = message.value.conversation_id;
      if (active.remoteConversationId !== null && active.remoteConversationId !== remoteId) {
        throw hostError("RUNTIME_SESSION_CONFLICT", "Antigravity resumed the wrong conversation");
      }
      if (path.resolve(message.value.init.cwd) !== active.cwd) {
        throw hostError("ANTIGRAVITY_STREAM_CWD_MISMATCH", "Antigravity started in the wrong workspace");
      }
      active.seenInit = true;
      active.remoteConversationId = remoteId;
      this.ledger.update((data) => {
        const session = sessionById(data, active.sessionId);
        if (session.remoteConversationId !== null && session.remoteConversationId !== remoteId) {
          throw hostError("RUNTIME_SESSION_CONFLICT", "Antigravity conversation binding changed");
        }
        session.remoteConversationId = remoteId;
        session.updatedAt = Math.max(session.updatedAt, this.now());
      });
      return;
    }
    if (!active.seenInit) {
      throw hostError("ANTIGRAVITY_STREAM_SEQUENCE_INVALID", "Antigravity emitted data before init");
    }
    const payload = event === "step_update" ? message.value.step_update : message.value.result;
    if (payload.conversation_id !== active.remoteConversationId) {
      throw hostError("RUNTIME_SESSION_CONFLICT", "Antigravity event conversation changed");
    }
    if (event === "result") {
      if (active.result) {
        throw hostError("ANTIGRAVITY_STREAM_SEQUENCE_INVALID", "Antigravity emitted duplicate result");
      }
      if (hasDeniedActions(payload.denied_actions)) active.permissionRequired = true;
      active.result = payload;
      return;
    }
    if (payload.step_type === "user_input" && payload.state === "DONE") {
      this._acceptActive(active);
      return;
    }
    const common = {
      known: true,
      method: "antigravity/step_update",
      sessionId: active.sessionId,
      turnId: active.turnId,
      itemId: `antigravity-step-${active.turnId}-${payload.step_index}`,
    };
    if (payload.step_type === "agent_response" && typeof payload.text_delta === "string") {
      const combined = `${active.responseText}${payload.text_delta}`;
      if (Buffer.byteLength(combined, "utf8") > MAX_TURN_OUTPUT_BYTES) {
        throw hostError("ANTIGRAVITY_TURN_OUTPUT_TOO_LARGE", "Antigravity response is too large");
      }
      active.responseText = combined;
      this._publish({ ...common, type: "text_delta", delta: payload.text_delta });
      return;
    }
    if (payload.step_type === "tool") {
      const toolCallId = common.itemId;
      const name = safeString(payload.tool_name, 256)
        ? payload.tool_name : (safeString(payload.tool_info?.name, 256) ? payload.tool_info.name : "tool");
      if (!active.toolSteps.has(payload.step_index)) {
        active.toolSteps.add(payload.step_index);
        const input = payload.tool_info?.parameters === undefined ? undefined
          : safeSnapshot(payload.tool_info.parameters, {
            registeredSecrets: this.registeredSecrets,
            maxSnapshotBytes: 64 * 1024,
          });
        this._publish({
          ...common,
          type: "tool_start",
          ...require("./context-tool-content").contextToolContent({ input: payload.tool_info?.parameters }, this.registeredSecrets),
          toolCallId,
          tool: {
            kind: "other", name, status: "in_progress",
            ...(input === undefined ? {} : { input }),
          },
        });
      }
      if (payload.state === "DONE" || payload.state === "ERROR") {
        const success = payload.state !== "ERROR" && !payload.tool_info?.error;
        if (!success && TOOL_PERMISSION_ERROR_PATTERN.test(toolErrorText(payload.tool_info?.error))) {
          active.permissionRequired = true;
        }
        const rawOutput = payload.tool_info?.result
          ?? payload.tool_info?.output
          ?? payload.tool_info?.response
          ?? payload.tool_info?.error;
        const output = rawOutput === undefined ? undefined : safeSnapshot(rawOutput, {
          registeredSecrets: this.registeredSecrets,
          maxSnapshotBytes: 64 * 1024,
        });
        this._publish({
          ...common,
          type: "tool_result",
          ...require("./context-tool-content").contextToolContent({ output: rawOutput }, this.registeredSecrets),
          toolCallId,
          tool: {
            kind: "other",
            name,
            status: success ? "completed" : "failed",
            success,
            ...(output === undefined ? {} : { output }),
          },
        });
      }
    }
  }

  _onClose(active, code, signal) {
    if (active.settled) return;
    if (active.deferredFailure) {
      this._failDeferredActive(active);
      return;
    }
    try {
      for (const message of active.decoder.finish()) this._onMessage(active, message);
    } catch (error) {
      this._failDeferredActive(active, { error, definitelyRejected: false });
      return;
    }
    if (!active.result) {
      const diagnosed = diagnosticFailure(active, "", { auth: true });
      this._failActive(active, diagnosed || hostError(
        "ANTIGRAVITY_STREAM_RESULT_MISSING",
        "Antigravity result event is missing",
      ), {
        definitelyRejected: diagnosed?.code === "AUTH_REQUIRED",
        terminalStatus: diagnosed && active.accepted ? "failed" : undefined,
      });
      return;
    }
    const result = active.result;
    if (result.status === "SUCCESS" && code === 0) {
      this._acceptActive(active);
      const response = result.response.trim().length > 0 ? result.response : active.responseText;
      if (response.trim().length === 0) {
        this._failActive(active, diagnosticFailure(active) || hostError(
          "ANTIGRAVITY_EMPTY_RESPONSE",
          "Antigravity reported success without a final response",
        ), { terminalStatus: "failed" });
        return;
      }
      this._finishActive(active, "completed", null, { ...result, response });
      return;
    }
    if (result.status === "SUCCESS") {
      this._failActive(active, diagnosticFailure(active) || hostError(
        "ANTIGRAVITY_PROCESS_EXIT_INVALID",
        "Antigravity reported success with a failing process exit",
      ), { terminalStatus: active.accepted ? "failed" : undefined });
      return;
    }
    if (["CANCELED", "INTERRUPTED"].includes(result.status)) {
      if (active.accepted) {
        this._finishActive(
          active,
          result.status === "CANCELED" ? "canceled" : "interrupted",
          null,
          result,
        );
      } else {
        this._failActive(active, hostError(
          "RUNTIME_TURN_ACCEPTANCE_UNKNOWN",
          "Antigravity ended before proving turn acceptance",
        ));
      }
      return;
    }
    const diagnosed = diagnosticFailure(active, result.error || "", { auth: true });
    this._failActive(active, diagnosed || hostError(
      "ANTIGRAVITY_TURN_FAILED",
      "Antigravity turn failed",
    ), {
      definitelyRejected: diagnosed?.code === "AUTH_REQUIRED"
        || (!active.accepted && result.num_turns === 0),
      terminalStatus: "failed",
    });
    void signal;
  }

  _deferActiveFailure(active, error, options = {}) {
    if (active.settled || active.deferredFailure) return;
    active.deferredFailure = {
      error,
      definitelyRejected: options.definitelyRejected === true,
    };
    this._signal(active, "SIGKILL");
  }

  _failDeferredActive(active, deferred = active.deferredFailure) {
    const diagnosed = diagnosticFailure(active, "", { auth: !active.seenInit });
    this._failActive(active, diagnosed || deferred.error, {
      definitelyRejected: diagnosed?.code === "AUTH_REQUIRED" || deferred.definitelyRejected,
      terminalStatus: diagnosed && active.accepted ? "failed" : undefined,
    });
  }

  _acceptActive(active) {
    if (active.settled || active.accepted) return;
    const timestamp = this.now();
    this.ledger.update((data) => {
      const session = sessionById(data, active.sessionId);
      const turn = turnById(session, active.turnId);
      if (!turn || turn.acceptance !== "unknown") {
        throw hostError("RUNTIME_TURN_RECEIPT_CONFLICT", "Antigravity receipt is inconsistent");
      }
      turn.acceptance = "accepted";
      turn.updatedAt = Math.max(turn.updatedAt, timestamp);
      session.updatedAt = Math.max(session.updatedAt, timestamp);
    });
    active.accepted = true;
    this.profileState.authenticated = true;
    this.profileState.authCheckedAt = timestamp;
    clearTimeout(active.acceptanceTimer);
    active.acceptanceTimer = null;
    active.acceptance.resolve({ turn: { id: active.turnId, status: "inProgress", items: [] } });
  }

  _finishActive(active, status, errorCode, result) {
    if (active.settled || !TERMINAL_STATUSES.has(status)) return;
    const timestamp = this.now();
    const responseId = responseIdFor(active, result);
    let delta = null;
    const response = result.response;
    this.ledger.update((data) => {
      const session = sessionById(data, active.sessionId);
      const turn = turnById(session, active.turnId);
      if (!(active.nativeTerminal && result.usage_available === false)) {
        const currentUsage = rawUsage(result.usage);
        delta = usageDelta(session.lastUsage, currentUsage);
        if (delta !== null) session.lastUsage = currentUsage;
      }
      turn.status = status;
      turn.errorCode = errorCode;
      turn.assistantMessages = response.length > 0
        ? [{ id: `antigravity-message-${active.turnId}`, text: response }] : [];
      turn.responseId = responseId;
      turn.updatedAt = Math.max(turn.updatedAt, timestamp);
      session.updatedAt = Math.max(session.updatedAt, timestamp);
    });
    active.settled = true;
    this._clearActive(active);
    const common = {
      known: true,
      method: "antigravity/result",
      sessionId: active.sessionId,
      turnId: active.turnId,
    };
    if (response.length > 0) {
      this._publish({
        ...common,
        type: "text",
        itemId: `antigravity-message-${active.turnId}`,
        text: response,
        phase: "final_answer",
        delivery: "local",
      });
    }
    if (delta !== null) this._publish({ ...common, type: "usage", responseId, usage: delta });
    this._publish({ ...common, type: "complete", status });
    active.terminal.resolve({ status });
  }

  _failActive(active, error, options = {}) {
    if (active.settled) return;
    const failure = error?.code ? error
      : hostError("ANTIGRAVITY_TURN_FAILED", "Antigravity turn failed");
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
      this._invalidateAuthentication();
    }
    active.settled = true;
    this._clearActive(active);
    if (!active.accepted) active.acceptance.reject(failure);
    this._publish({
      known: true,
      method: "antigravity/result",
      type: "complete",
      sessionId: active.sessionId,
      turnId: active.turnId,
      status,
    });
    active.terminal.resolve({ status });
  }

  _acceptanceTimedOut(active) {
    if (active.settled || active.accepted) return;
    const notSubmitted = active.nativeTerminal && active.child?.sent === false;
    this._signal(active, "SIGKILL");
    this._failActive(active, hostError(
      notSubmitted ? "ANTIGRAVITY_STARTUP_TIMEOUT" : "RUNTIME_TURN_ACCEPTANCE_UNKNOWN",
      notSubmitted ? "Antigravity did not become ready; no prompt was submitted" : "Antigravity did not prove turn acceptance",
    ), { definitelyRejected: notSubmitted });
  }

  _promptTimedOut(active) {
    if (active.settled) return;
    this._signal(active, "SIGKILL");
    this._failActive(active, hostError(
      "ANTIGRAVITY_TURN_TIMEOUT",
      "Antigravity turn exceeded its timeout",
    ));
  }

  _clearActive(active) {
    clearTimeout(active.acceptanceTimer);
    clearTimeout(active.promptTimer);
    active.acceptanceTimer = null;
    active.promptTimer = null;
    if (active.reservationId) {
      try { this.mcpGateIssuer.revokeMcpServer({ reservationId: active.reservationId }); } catch {}
      active.reservationId = null;
    }
    if (this.activeTurns.get(active.sessionId) === active) this.activeTurns.delete(active.sessionId);
  }

  _signal(active, signal) {
    if (!active.child || !Number.isSafeInteger(active.child.pid)) return;
    try {
      if (active.nativeTerminal) active.child.kill(signal);
      else this.killProcessGroup(active.child.pid, signal);
    } catch {}
  }

  _publish(event) {
    for (const listener of [...this.listeners]) {
      try { listener(Object.freeze(event)); } catch {}
    }
  }

  _modelCatalogIdentity() {
    return modelCatalogIdentity({
      fs: this.fs,
      values: [this.runtimeEnvironment, this.cliVersion, this.permissionPolicy, this.profileState.authGeneration || 0,
        PARENT_ENV_ALLOWLIST.map((key) => [key, this.parentEnv[key] ?? null])],
      files: [this.binaryPath,
        path.join(this.home, ".gemini", "antigravity-cli", "settings.json"),
        path.join(this.runtimeEnvironment.nativeHome, "antigravity-cli", "settings.json"),
        path.join(this.home, ".gemini", "oauth_creds.json"),
        path.join(this.runtimeEnvironment.nativeHome, "oauth_creds.json"),
        path.join(this.userHome, "Library", "Keychains", "login.keychain-db")],
    });
  }

  _invalidateAuthentication() {
    this.profileState.authenticated = false;
    this.profileState.authCheckedAt = this.now();
    this.profileState.models = null;
    this.profileState.modelsExpiresAt = 0;
    this.profileState.authGeneration = (this.profileState.authGeneration || 0) + 1;
    this.modelCatalogCache.invalidate();
  }

  async _ensureModelCatalog({ model } = {}) {
    try { return await this._readModelCatalog(model); }
    catch (error) {
      // Account-shared cache invalidation (for example a sibling host stopping)
      // can fence a read-only probe. Retry that identity race once; never retry
      // auth failures, timeouts, session creation, or any accepted turn.
      if (error?.code !== "RUNTIME_MODEL_CATALOG_CHANGED" || this.state !== "ready") throw error;
      return this._readModelCatalog(model);
    }
  }

  async _readModelCatalog(model) {
    const key = this._modelCatalogIdentity();
    const models = await this.modelCatalogCache.read({
      key, now: this.now,
      isCurrent: () => this.state === "ready" && key === this._modelCatalogIdentity(),
      allowStale: (catalog) => typeof model === "string" && catalog.some((candidate) => candidate.model === model),
      onRefreshError: (error) => {
        if (error?.code === "AUTH_REQUIRED") this._invalidateAuthentication();
        try { this.onDiagnostic?.({ code: error?.code || "RUNTIME_MODEL_CATALOG_UNAVAILABLE" }); } catch {}
      },
      load: async () => {
        const result = await this._runControl(["models"], { timeoutMs: 15_000, identity: key });
        this._assertReady();
        if (result.code !== 0) {
          if (AUTH_ERROR_PATTERN.test(`${result.stdout}\n${result.stderr}`)) {
            throw hostError("AUTH_REQUIRED", "Antigravity authentication is required");
          }
          throw hostError("RUNTIME_MODEL_CATALOG_UNAVAILABLE", "Antigravity models command failed");
        }
        return parseModelCatalog(result.stdout);
      },
    });
    this._assertReady();
    if (key !== this._modelCatalogIdentity()) throw hostError("RUNTIME_MODEL_CATALOG_CHANGED", "Antigravity model catalog identity changed");
    this.profileState.models = models;
    this.profileState.authenticated = true;
    this.profileState.authCheckedAt = this.now();
    return models;
  }

  _validateModel(model, models) {
    if (model === undefined || model === null) return null;
    if (!safeString(model, 512)
      || !models?.some((candidate) => candidate.model === model)) {
      throw hostError("RUNTIME_MODEL_UNAVAILABLE", "Antigravity model is unavailable");
    }
    return model;
  }

  _sessionCwd(value) {
    const cwd = value === undefined || value === null ? (this.workspace || this.home)
      : normalizeAntigravityWorkspace(value);
    if (this.workspace !== null && cwd !== this.workspace) {
      throw hostError("ANTIGRAVITY_WORKSPACE_INVALID", "Antigravity workspace route changed");
    }
    try {
      const stat = this.fs.lstatSync(cwd);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe cwd");
    } catch {
      throw hostError("ANTIGRAVITY_WORKSPACE_INVALID", "Antigravity workspace is unavailable");
    }
    return cwd;
  }

  _assertInputPermissionPolicy(value) {
    return normalizeAntigravityPermissionPolicy(value);
  }

  _requireSession(sessionId) {
    if (!safeString(sessionId, 512)) {
      throw hostError("RUNTIME_SESSION_PARAMS_INVALID", "Antigravity session id is invalid");
    }
    const session = sessionById(this.ledger.snapshot(), sessionId);
    if (!session) throw hostError("RUNTIME_SESSION_NOT_FOUND", "Antigravity session was not found");
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
          ...(turn.errorCode ? { errorCode: turn.errorCode } : {}),
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

  _promptText(sessionId, input) {
    const config = this.sessionConfigs.get(sessionId);
    const blocks = [];
    if (config?.developerInstructions) {
      blocks.push(`SHOGGOTH DEVELOPER INSTRUCTIONS\n${config.developerInstructions}`);
    }
    if (typeof input.context === "string" && input.context.length > 0) blocks.push(input.context);
    if (parseRuntimeCommand(input.prompt, this.skillCommands)) {
      // Skills expand only at the start of the prompt. Keep the bound profile’s
      // context present after the invocation instead of silently dropping it.
      return [input.prompt.trim(), ...blocks].join("\n\n");
    }
    blocks.push(`CURRENT USER REQUEST\n${input.prompt}`);
    return blocks.join("\n\n");
  }

  _spawnEnvironment(entries = []) {
    const env = Object.create(null);
    for (const key of PARENT_ENV_ALLOWLIST) {
      const value = this.parentEnv[key];
      if (typeof value === "string" && value.isWellFormed() && !value.includes("\0")
        && Buffer.byteLength(value, "utf8") <= 4096) env[key] = value;
    }
    env.PATH = runtimePath(env.PATH, this.userHome);
    env.HOME = this.runtimeEnvironment.spawnEnv.HOME;
    env.AGY_CLI_HIDE_LOGO = "1";
    env.AGY_CLI_HIDE_ACCOUNT_INFO = "1";
    for (const entry of entries) {
      if (!plain(entry) || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(entry.name)
        || !safeString(entry.value, 4096, { empty: true })) {
        throw hostError("ANTIGRAVITY_MCP_CONFIG_INVALID", "Antigravity MCP environment is invalid");
      }
      env[entry.name] = entry.value;
    }
    return env;
  }

  _runControl(args, options = {}) {
    if (!Array.isArray(args) || args.length === 0
      || args.some((arg) => !safeString(arg, 4096))) {
      return Promise.reject(hostError("ANTIGRAVITY_CONTROL_INVALID", "Antigravity control command is invalid"));
    }
    const key = JSON.stringify([args, options.cwd || this.home, options.timeoutMs ?? this.requestTimeoutMs, options.identity ?? null]);
    const existing = this.controlRequests.get(key);
    if (existing) return existing;
    const pending = this._spawnControl(args, options).finally(() => {
      this.controlRequests.delete(key);
    });
    this.controlRequests.set(key, pending);
    return pending;
  }

  _spawnControl(args, options) {
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnProcess(this.binaryPath, args, {
          cwd: options.cwd || this.home,
          // Read-only commands also load the saved MCP config. Old configs may
          // lack env, so ensure their helper cannot launch a GUI Electron app.
          // No MCP gate is issued: these probes retain no tool access.
          env: { ...this._spawnEnvironment(), ELECTRON_RUN_AS_NODE: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        reject(hostError("ANTIGRAVITY_PROCESS_SPAWN_FAILED", "Antigravity control process failed"));
        return;
      }
      if (!child || typeof child.on !== "function" || !child.stdout || !child.stderr
        || typeof child.kill !== "function") {
        try { child?.kill?.("SIGKILL"); } catch {}
        reject(hostError("ANTIGRAVITY_PROCESS_SPAWN_FAILED", "Antigravity control process is invalid"));
        return;
      }
      const done = makeDeferred();
      this.controlProcesses.set(child, done);
      let stdout = "";
      let stderr = "";
      let settled = false;
      const append = (current, chunk) => {
        const next = `${current}${Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)}`;
        if (Buffer.byteLength(next, "utf8") > MAX_CONTROL_OUTPUT_BYTES) {
          throw hostError("ANTIGRAVITY_CONTROL_OUTPUT_TOO_LARGE", "Antigravity control output is too large");
        }
        return next;
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill("SIGKILL"); } catch {}
        reject(hostError("ANTIGRAVITY_CONTROL_TIMEOUT", "Antigravity control command timed out"));
      }, timeoutMs);
      timer.unref?.();
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill("SIGKILL"); } catch {}
        reject(error);
      };
      child.stdout?.on("data", (chunk) => {
        try { stdout = append(stdout, chunk); } catch (error) { fail(error); }
      });
      child.stderr?.on("data", (chunk) => {
        try { stderr = append(stderr, chunk); } catch (error) { fail(error); }
      });
      child.on("error", () => fail(hostError(
        "ANTIGRAVITY_PROCESS_FAILED",
        "Antigravity control process failed",
      )));
      child.on("close", (code, signal) => {
        this.controlProcesses.delete(child);
        done.resolve();
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr });
      });
    });
  }

  _assertReady() {
    if (this.state !== "ready") {
      throw hostError("ANTIGRAVITY_RUNTIME_NOT_READY", "Antigravity runtime is not ready");
    }
  }

  _assertExecutionInstance() {
    this._assertReady();
    if (this.controlInstance) {
      throw hostError("RUNTIME_CAPABILITY_UNSUPPORTED", "Antigravity control hosts cannot run sessions");
    }
  }
}

module.exports = {
  AntigravityRuntimeHost,
  parseModelCatalog,
  usageDelta,
  parseAntigravityCommands,
};
