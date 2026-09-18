"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { statIfExists } = require("./private-file");
const { serviceError } = require("./security");
const { mergeNativeCommands, requireRuntimeCommand } = require("./native-cli-commands");
const { runtimeBinding } = require("./runtime-adapter");
const { validateResolvedEnvironment } = require("./runtime-account-resolver");
const { DeepSeekHarnessProcess } = require("./deepseek-harness-process");
const { DEFAULT_MCP_TOOL_TIMEOUT_MS } = require("./interactive-timeouts");
const {
  DeepSeekHarnessRuntimeLedger,
  emptyDeepSeekHarnessUsage,
} = require("./deepseek-harness-runtime-ledger");
const {
  DEEPSEEK_HARNESS_RUNTIME,
  assertDeepSeekHarnessBridgePath,
  normalizeDeepSeekHarnessPermissionPolicy,
  normalizeDeepSeekHarnessWorkspace,
  parseDeepSeekHarnessVersion,
  prepareDeepSeekHarnessRuntimeAccountIntegration,
  resolveDeepSeekHarnessLaunch,
  supportsDeepSeekHarnessVersion,
} = require("./deepseek-harness-runtime-paths");

const PARENT_ENV_ALLOWLIST = Object.freeze([
  "LANG", "LC_ALL", "LC_CTYPE", "PATH", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_RESOURCE_NAME", "AZURE_OPENAI_API_VERSION", "DEEPSEEK_API_KEY",
  "NVIDIA_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY",
  "FIREWORKS_API_KEY", "TOGETHER_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY",
  "MINIMAX_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION",
]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "interrupted", "canceled"]);
const MAX_CONTROL_OUTPUT_BYTES = 1024 * 1024;
const MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024;
const MAX_MODELS = 512;

function hostError(code, message) {
  return serviceError(code, message);
}

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function safeString(value, maxBytes = 1024, { empty = false } = {}) {
  return typeof value === "string" && (empty || value.length > 0) && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function defined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runtimePath(parentPath, userHome) {
  const entries = String(parentPath || "").split(path.delimiter)
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry) && !entry.includes("\0"));
  if (typeof userHome === "string" && path.isAbsolute(userHome) && !userHome.includes("\0")) {
    entries.unshift(path.join(userHome, ".local", "bin"));
  }
  entries.unshift("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin");
  return [...new Set(entries)].join(path.delimiter);
}

function defaultKillProcessGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
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
  })).digest("hex");
}

function workspaceShardId(controlInstance, workspace) {
  return crypto.createHash("sha256").update(JSON.stringify([
    controlInstance ? "control" : "execution",
    controlInstance ? null : workspace,
  ])).digest("hex");
}

function parseModelRef(value) {
  if (!safeString(value, 640)) return null;
  const separator = value.indexOf("/");
  if (separator < 1 || separator === value.length - 1) return null;
  return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

function addUsage(left, right) {
  const output = {};
  for (const key of Object.keys(emptyDeepSeekHarnessUsage())) {
    const candidate = left[key] + right[key];
    if (!Number.isSafeInteger(candidate) || candidate < 0) {
      throw hostError(
        "DEEPSEEK_HARNESS_USAGE_INVALID",
        "DeepSeek Harness token usage exceeds its limit",
      );
    }
    output[key] = candidate;
  }
  return output;
}

function validateUsage(value) {
  const keys = Object.keys(emptyDeepSeekHarnessUsage());
  return plain(value) && keys.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0);
}

function validateCatalog(payload) {
  if (!plain(payload) || !Array.isArray(payload.models)
    || payload.models.length === 0 || payload.models.length > MAX_MODELS) {
    throw hostError(
      "RUNTIME_MODEL_CATALOG_INVALID",
      "DeepSeek Harness model catalog is invalid",
    );
  }
  const seen = new Set();
  const models = payload.models.map((model) => {
    if (!plain(model) || !safeString(model.model, 640) || !parseModelRef(model.model)
      || !safeString(model.displayName, 512)
      || (model.description !== undefined && !safeString(model.description, 2048, { empty: true }))
      || typeof model.isDefault !== "boolean" || seen.has(model.model)) {
      throw hostError(
        "RUNTIME_MODEL_CATALOG_INVALID",
        "DeepSeek Harness model catalog item is invalid",
      );
    }
    seen.add(model.model);
    return Object.freeze({
      model: model.model,
      displayName: model.displayName,
      description: model.description || model.model,
      isDefault: model.isDefault,
      input: Array.isArray(model.input) ? Object.freeze([...model.input]) : Object.freeze(["text"]),
    });
  });
  if (!models.some((model) => model.isDefault)) {
    models[0] = Object.freeze({ ...models[0], isDefault: true });
  }
  return Object.freeze(models);
}

function secureCredentialPresent(fileSystem, home) {
  const target = path.join(home, ".credentials.yaml");
  const stat = statIfExists(fileSystem, target);
  if (stat === null) return false;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0
    || stat.size > MAX_CREDENTIAL_FILE_BYTES || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw hostError(
      "DEEPSEEK_HARNESS_CREDENTIAL_UNSAFE",
      "DeepSeek Harness credential file is unsafe",
    );
  }
  return true;
}

class DeepSeekHarnessRuntimeHost {
  constructor(options = {}) {
    this.paths = options.paths;
    if (!this.paths?.stateDir || !this.paths?.trustedRoot) {
      throw hostError(
        "DEEPSEEK_HARNESS_HOST_OPTIONS_INVALID",
        "DeepSeek Harness host paths are invalid",
      );
    }
    this.binding = runtimeBinding(options.runtimeBinding || {
      runtime: DEEPSEEK_HARNESS_RUNTIME,
      runtimeProfileId: options.runtimeProfileId,
      runtimeAccountId: options.runtimeAccountId,
    });
    this.runtimeProfileId = this.binding.runtimeProfileId;
    this.runtimeAccountId = this.binding.runtimeAccountId;
    this.runtimeEnvironment = validateResolvedEnvironment(options.runtimeEnvironment, this.binding);
    this.permissionPolicy = normalizeDeepSeekHarnessPermissionPolicy(options.permissionPolicy);
    this.controlInstance = options.controlInstance === true;
    this.workspace = this.controlInstance ? null : normalizeDeepSeekHarnessWorkspace(options.workspace);
    this.binaryCandidate = options.binaryPath;
    this.bridgeCandidate = options.bridgePath;
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
    this.startupTimeoutMs = options.startupTimeoutMs ?? 45_000;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 2_000;
    this.killGraceMs = options.killGraceMs ?? 2_000;
    this.maxFrameBytes = options.maxFrameBytes;
    this.maxStreamBytes = options.maxStreamBytes;
    this.profileState = options.profileState || {
      models: null,
      modelsExpiresAt: 0,
      auth: null,
      authExpiresAt: 0,
    };
    this.mcpGateIssuer = options.mcpGateIssuer;
    if (!this.mcpGateIssuer || ["reserveMcpServer", "bindMcpServer", "revokeMcpServer"]
      .some((method) => typeof this.mcpGateIssuer[method] !== "function")) {
      throw hostError(
        "DEEPSEEK_HARNESS_HOST_OPTIONS_INVALID",
        "DeepSeek Harness MCP gate issuer is invalid",
      );
    }
    for (const value of [this.requestTimeoutMs, this.serverRequestTimeoutMs, this.startupTimeoutMs,
      this.shutdownGraceMs, this.killGraceMs]) {
      if (!Number.isSafeInteger(value) || value < 100 || value > 10 * 60 * 1000) {
        throw hostError(
          "DEEPSEEK_HARNESS_HOST_OPTIONS_INVALID",
          "DeepSeek Harness host timeout is invalid",
        );
      }
    }
    this.state = "new";
    this.home = null;
    this.binaryPath = null;
    this.launch = null;
    this.integration = null;
    this.bridgePath = null;
    this.ledger = null;
    this.process = null;
    this.reservationId = null;
    this.sessionConfigs = new Map();
    this.activeTurns = new Map();
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
      throw hostError("DEEPSEEK_HARNESS_STATE_INVALID", "DeepSeek Harness host state is invalid");
    }
    this.state = "initializing";
    try {
      this.bridgePath = assertDeepSeekHarnessBridgePath(this.bridgeCandidate, { fs: this.fs });
      this.home = this.runtimeEnvironment.home;
      this.integration = prepareDeepSeekHarnessRuntimeAccountIntegration(
        this.paths,
        this.runtimeAccountId,
        { fs: this.fs, bridgePath: this.bridgePath },
      );
      this.binaryPath = this.runtimeEnvironment.binaryPath;
      this.launch = resolveDeepSeekHarnessLaunch(this.binaryPath, {
        parentEnv: this.parentEnv,
        homedir: this.userHome,
        fs: this.fs,
      });
      const versionResult = await this._runControl(["--version"], { timeoutMs: 5_000 });
      const version = parseDeepSeekHarnessVersion(versionResult.stdout);
      if (versionResult.code !== 0 || !supportsDeepSeekHarnessVersion(version)) {
        throw hostError(
          "DEEPSEEK_HARNESS_VERSION_UNSUPPORTED",
          "DeepSeek Harness CLI 0.1.1 or newer is required",
        );
      }
      this.ledger = new DeepSeekHarnessRuntimeLedger({
        fs: this.fs,
        stateRoot: path.join(this.paths.stateDir, "runtime-ledgers", DEEPSEEK_HARNESS_RUNTIME),
        trustedRoot: this.paths.trustedRoot,
        runtimeProfileId: this.runtimeProfileId,
        workspaceShardId: workspaceShardId(this.controlInstance, this.workspace),
      }).open();
      this._spawnBridge();
      let startupTimer;
      try {
        await Promise.race([
          this.process.ready,
          new Promise((_, reject) => {
            startupTimer = setTimeout(() => reject(hostError(
              "DEEPSEEK_HARNESS_STARTUP_TIMEOUT",
              "DeepSeek Harness Bridge did not become ready",
            )), this.startupTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(startupTimer);
      }
      if (this.state !== "initializing") {
        throw hostError("RUNTIME_HOST_TERMINATED", "DeepSeek Harness stopped during initialization");
      }
      this.state = "ready";
      return this;
    } catch (error) {
      if (!['stopping', 'stopped'].includes(this.state)) {
        this.state = "failed";
        this.rejectTerminated(error);
      }
      this._killProcess("SIGKILL");
      this._revokeMcp();
      throw error;
    }
  }

  beginAcquire() { this._assertReady(); }

  async authenticationState() {
    this._assertReady();
    const now = this.now();
    if (this.profileState.auth && this.profileState.authExpiresAt > now) {
      return this.profileState.auth;
    }
    const state = await this.process.request("auth/read", {}, { timeoutMs: this.requestTimeoutMs });
    if (!plain(state) || typeof state.authenticated !== "boolean"
      || typeof state.credentialPresent !== "boolean") {
      throw hostError(
        "DEEPSEEK_HARNESS_AUTH_STATE_INVALID",
        "DeepSeek Harness authentication state is invalid",
      );
    }
    const local = secureCredentialPresent(this.fs, this.home);
    const result = Object.freeze({
      authenticated: state.authenticated,
      credentialPresent: state.credentialPresent || local,
    });
    this.profileState.auth = result;
    this.profileState.authExpiresAt = now + 30_000;
    return result;
  }

  subscribe(listener) {
    if (typeof listener !== "function") {
      throw hostError(
        "DEEPSEEK_HARNESS_SUBSCRIBER_INVALID",
        "DeepSeek Harness listener is invalid",
      );
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  registerServerRequestHandler(method, handler) {
    if (!safeString(method, 256) || typeof handler !== "function") {
      throw hostError(
        "DEEPSEEK_HARNESS_HANDLER_INVALID",
        "DeepSeek Harness request handler is invalid",
      );
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
      throw hostError(
        "RUNTIME_SESSION_PARAMS_INVALID",
        "DeepSeek Harness session input is invalid",
      );
    }
    this._assertInputPermissionPolicy(input.permissionPolicy);
    const permissionMode = input.permissionMode || "workspace-write";
    if (!["workspace-write", "danger-full-access"].includes(permissionMode)) {
      throw hostError("RUNTIME_PERMISSION_POLICY_INVALID", "DeepSeek Harness permission mode is invalid");
    }
    const cwd = this._sessionCwd(input.cwd);
    const model = this._validateModel(input.model);
    const snapshot = this.ledger.snapshot();
    const existing = snapshot.sessions.find((session) => session.source === input.source);
    if (existing) {
      this.sessionConfigs.set(existing.id, {
        developerInstructions: input.developerInstructions || "",
        model,
        permissionMode,
      });
      await this._bridgeSession("session/start", existing);
      return { session: this._projectSession(existing) };
    }
    const createdAt = this.now();
    const session = {
      id: `deepseek-harness-session-${this.randomUUID()}`,
      remoteSessionId: this.randomUUID(),
      source: input.source,
      cwd,
      title: null,
      archived: false,
      createdAt,
      updatedAt: createdAt,
      turns: [],
    };
    if (!safeString(session.id, 512) || !safeString(session.remoteSessionId, 256)) {
      throw hostError(
        "RUNTIME_SESSION_ID_INVALID",
        "DeepSeek Harness session id is invalid",
      );
    }
    this.ledger.update((data) => data.sessions.push(session));
    this.sessionConfigs.set(session.id, {
      developerInstructions: input.developerInstructions || "",
      model,
      permissionMode,
    });
    await this._bridgeSession("session/start", session);
    return { session: this._projectSession(session) };
  }

  async sessionResume(input) {
    this._assertExecutionInstance();
    await this._ensureModelCatalog();
    if (!plain(input) || !safeString(input.sessionId, 512)
      || (input.developerInstructions !== undefined
        && !safeString(input.developerInstructions, 1024 * 1024, { empty: true }))) {
      throw hostError(
        "RUNTIME_SESSION_PARAMS_INVALID",
        "DeepSeek Harness resume input is invalid",
      );
    }
    this._assertInputPermissionPolicy(input.permissionPolicy);
    const permissionMode = input.permissionMode || "workspace-write";
    if (!["workspace-write", "danger-full-access"].includes(permissionMode)) {
      throw hostError("RUNTIME_PERMISSION_POLICY_INVALID", "DeepSeek Harness permission mode is invalid");
    }
    const session = this._requireSession(input.sessionId);
    if (session.archived) {
      throw hostError("RUNTIME_SESSION_NOT_FOUND", "DeepSeek Harness session is archived");
    }
    if (this.activeTurns.has(session.id)) {
      throw hostError("RUNTIME_SESSION_BUSY", "DeepSeek Harness session is active");
    }
    if (this._sessionCwd(input.cwd) !== session.cwd) {
      throw hostError(
        "RUNTIME_SESSION_NOT_FOUND",
        "DeepSeek Harness session workspace does not match",
      );
    }
    this.sessionConfigs.set(session.id, {
      developerInstructions: input.developerInstructions || "",
      model: this._validateModel(input.model),
      permissionMode,
    });
    await this._bridgeSession("session/resume", session);
    return { session: this._projectSession(session) };
  }

  sessionRead(input) {
    this._assertReady();
    if (!plain(input) || !safeString(input.sessionId, 512)) {
      return Promise.reject(hostError(
        "RUNTIME_SESSION_PARAMS_INVALID",
        "DeepSeek Harness read input is invalid",
      ));
    }
    const session = sessionById(this.ledger.snapshot(), input.sessionId);
    if (!session) {
      return Promise.reject(hostError(
        "RUNTIME_SESSION_NOT_FOUND",
        "DeepSeek Harness session was not found",
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
      return Promise.reject(hostError(
        "RUNTIME_SESSION_CURSOR_INVALID",
        "DeepSeek Harness cursor is invalid",
      ));
    }
    const sessions = this.ledger.snapshot().sessions.filter((session) => session.archived === archived)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    const page = sessions.slice(offset, offset + limit).map((session) => this._projectSession(session));
    const next = offset + page.length;
    return Promise.resolve({ data: page, nextCursor: next < sessions.length ? String(next) : null });
  }

  sessionRename(input) {
    this._assertReady();
    if (!plain(input) || !safeString(input.sessionId, 512) || !safeString(input.name, 1024)) {
      return Promise.reject(hostError(
        "RUNTIME_SESSION_PARAMS_INVALID",
        "DeepSeek Harness rename input is invalid",
      ));
    }
    this.ledger.update((data) => {
      const session = sessionById(data, input.sessionId);
      if (!session) {
        throw hostError("RUNTIME_SESSION_NOT_FOUND", "DeepSeek Harness session was not found");
      }
      session.title = input.name;
      session.updatedAt = Math.max(session.updatedAt, this.now());
    });
    return Promise.resolve({});
  }

  sessionArchive(input) {
    this._assertReady();
    const session = this._requireSession(input?.sessionId);
    if (this.activeTurns.has(session.id)) {
      return Promise.reject(hostError("RUNTIME_SESSION_BUSY", "DeepSeek Harness session is active"));
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
      throw hostError("RUNTIME_SESSION_BUSY", "DeepSeek Harness session is active");
    }
    await this.process.request("session/delete", { remoteSessionId: session.remoteSessionId });
    this.ledger.update((data) => {
      const index = data.sessions.findIndex((candidate) => candidate.id === session.id);
      if (index < 0) {
        throw hostError("RUNTIME_SESSION_NOT_FOUND", "DeepSeek Harness session was not found");
      }
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
      throw hostError(
        "RUNTIME_TURN_PARAMS_INVALID",
        "DeepSeek Harness turn input is invalid",
      );
    }
    this._assertInputPermissionPolicy(input.permissionPolicy);
    const session = this._requireSession(input.sessionId);
    if (session.archived) {
      throw hostError("RUNTIME_SESSION_ARCHIVED", "DeepSeek Harness session is archived");
    }
    if (this._sessionCwd(input.cwd) !== session.cwd) {
      throw hostError(
        "RUNTIME_SESSION_NOT_FOUND",
        "DeepSeek Harness turn workspace does not match",
      );
    }
    const model = this._validateModel(input.model ?? this.sessionConfigs.get(session.id)?.model);
    const fingerprint = inputFingerprint({ ...input, model });
    const existing = turnByOperation(session, input.operationId);
    if (existing && existing.fingerprint !== fingerprint) {
      throw hostError(
        "RUNTIME_OPERATION_CONFLICT",
        "DeepSeek Harness operationId input changed",
      );
    }
    const currentActive = this.activeTurns.get(session.id);
    if (currentActive) {
      if (existing && currentActive.turnId === existing.id) return currentActive.acceptance.promise;
      throw hostError("RUNTIME_SESSION_BUSY", "DeepSeek Harness session is active");
    }
    if (existing?.acceptance === "failed") {
      throw hostError(existing.errorCode || "DEEPSEEK_HARNESS_TURN_FAILED", "DeepSeek Harness turn failed");
    }
    if (existing && existing.acceptance === "accepted" && TERMINAL_STATUSES.has(existing.status)) {
      return { turn: { id: existing.id, status: existing.status, items: [] } };
    }
    // Native commands can mutate state without creating a model user/message.
    // Never replay an ambiguous dispatch against a restarted bridge.
    if (existing && input.prompt.trimStart().startsWith("/")) {
      throw hostError("RUNTIME_TURN_ACCEPTANCE_UNKNOWN", "DeepSeek Harness command acceptance is unknown; it will not be repeated");
    }
    let turnId = existing?.id;
    if (!existing) {
      turnId = `deepseek-harness-turn-${this.randomUUID()}`;
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
          usageResponseIds: [],
          responseId: null,
          provider: null,
          model: null,
          usage: emptyDeepSeekHarnessUsage(),
          createdAt,
          updatedAt: createdAt,
        });
        current.updatedAt = Math.max(current.updatedAt, createdAt);
      });
    }
    const active = {
      sessionId: session.id,
      remoteSessionId: session.remoteSessionId,
      turnId,
      operationId: input.operationId,
      model,
      acceptance: makeDeferred(),
      terminal: makeDeferred(),
      accepted: false,
      settled: false,
      interruptRequested: false,
      bufferedEvents: [],
    };
    this.activeTurns.set(session.id, active);
    void this._beginTurn(active, input).catch((error) => {
      this._failActive(active, error, {
        definitelyRejected: !["DEEPSEEK_HARNESS_REQUEST_TIMEOUT", "DEEPSEEK_HARNESS_PROCESS_CLOSED"]
          .includes(error?.code),
      });
    });
    return active.acceptance.promise;
  }

  async turnSteer(input) {
    this._assertReady();
    if (!plain(input) || !safeString(input.sessionId, 512) || !safeString(input.turnId, 512)
      || !safeString(input.operationId, 512) || !safeString(input.message, 1024 * 1024)) {
      throw hostError(
        "RUNTIME_TURN_PARAMS_INVALID",
        "DeepSeek Harness steer input is invalid",
      );
    }
    const active = this.activeTurns.get(input.sessionId);
    if (!active || active.turnId !== input.turnId || !active.accepted || active.settled) {
      throw hostError("RUNTIME_TURN_NOT_ACTIVE", "DeepSeek Harness turn is not active");
    }
    await this.process.request("turn/steer", {
      remoteSessionId: active.remoteSessionId,
      turnId: active.turnId,
      operationId: input.operationId,
      message: input.message,
    });
    return { turnId: active.turnId };
  }

  async turnInterrupt(input) {
    this._assertReady();
    if (!plain(input) || !safeString(input.sessionId, 512) || !safeString(input.turnId, 512)) {
      throw hostError(
        "RUNTIME_TURN_PARAMS_INVALID",
        "DeepSeek Harness interrupt input is invalid",
      );
    }
    const session = this._requireSession(input.sessionId);
    const turn = turnById(session, input.turnId);
    if (!turn) throw hostError("RUNTIME_TURN_STALE", "DeepSeek Harness turn is stale");
    const active = this.activeTurns.get(session.id);
    if (!active) {
      if (["canceled", "interrupted"].includes(turn.status)) return {};
      throw hostError("RUNTIME_TURN_NOT_ACTIVE", "DeepSeek Harness turn is no longer active");
    }
    if (active.turnId !== input.turnId) {
      throw hostError("RUNTIME_TURN_STALE", "DeepSeek Harness turn is stale");
    }
    active.interruptRequested = true;
    await this.process.request("turn/interrupt", {
      remoteSessionId: active.remoteSessionId,
      turnId: active.turnId,
    });
    let terminalTimer;
    let terminal;
    try {
      terminal = await Promise.race([
        active.terminal.promise,
        new Promise((resolve) => {
          terminalTimer = setTimeout(() => resolve(null), this.requestTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(terminalTimer);
    }
    if (!terminal || !["canceled", "interrupted"].includes(terminal.status)) {
      throw hostError(
        "RUNTIME_TURN_CANCEL_UNKNOWN",
        "DeepSeek Harness did not confirm interruption",
      );
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
      throw hostError(
        "RUNTIME_MODEL_CURSOR_INVALID",
        "DeepSeek Harness model cursor is invalid",
      );
    }
    const page = models.slice(offset, offset + limit).map((model) => ({
      model: model.model,
      displayName: model.displayName,
      description: model.description,
      isDefault: model.isDefault,
      hidden: false,
    }));
    const next = offset + page.length;
    return { data: page, nextCursor: next < models.length ? String(next) : null };
  }

  async stop() {
    if (this.stopping) return this.stopping;
    if (this.state === "stopped") return undefined;
    this.state = "stopping";
    this.stopping = (async () => {
      try {
        await this.process?.request("shutdown", {}, { timeoutMs: this.shutdownGraceMs });
      } catch {}
      this.process?.endInput();
      if (this.process && !this.process.closed) {
        await Promise.race([this.process.closedPromise, delay(this.shutdownGraceMs)]);
      }
      if (this.process && !this.process.closed) this._killProcess("SIGTERM");
      if (this.process && !this.process.closed) {
        await Promise.race([this.process.closedPromise, delay(this.killGraceMs)]);
      }
      if (this.process && !this.process.closed) {
        this._killProcess("SIGKILL");
        await delay(this.killGraceMs);
      }
      if (this.process && !this.process.closed) this.cleanupIncomplete = true;
      for (const active of [...this.activeTurns.values()]) {
        this._failActive(active, hostError(
          "DEEPSEEK_HARNESS_PROCESS_CLOSE_TIMEOUT",
          "DeepSeek Harness process did not terminate",
        ));
      }
      this._revokeMcp();
      this.state = "stopped";
      this.resolveTerminated();
      if (this.cleanupIncomplete) {
        const error = hostError(
          "DEEPSEEK_HARNESS_PROCESS_CLOSE_TIMEOUT",
          "DeepSeek Harness process cleanup is incomplete",
        );
        error.cleanupIncomplete = true;
        throw error;
      }
    })();
    return this.stopping;
  }

  async _bridgeSession(command, session) {
    const config = this.sessionConfigs.get(session.id) || { developerInstructions: "", model: null };
    await this.process.request(command, {
      remoteSessionId: session.remoteSessionId,
      cwd: session.cwd,
      developerInstructions: config.developerInstructions,
      model: config.model,
      permissionMode: config.permissionMode || "workspace-write",
    });
  }

  async _beginTurn(active, input) {
    await this.process.request("turn/start", {
      remoteSessionId: active.remoteSessionId,
      sessionId: active.sessionId,
      turnId: active.turnId,
      operationId: active.operationId,
      prompt: input.prompt,
      context: input.context || "",
    }, { timeoutMs: this.startupTimeoutMs });
    this._acceptActive(active);
  }

  _acceptActive(active) {
    if (active.settled || active.accepted) return;
    const timestamp = this.now();
    this.ledger.update((data) => {
      const session = sessionById(data, active.sessionId);
      const turn = turnById(session, active.turnId);
      if (!turn || !["unknown", "accepted"].includes(turn.acceptance)) {
        throw hostError(
          "RUNTIME_TURN_RECEIPT_CONFLICT",
          "DeepSeek Harness receipt is inconsistent",
        );
      }
      turn.acceptance = "accepted";
      turn.status = "inProgress";
      turn.errorCode = null;
      turn.updatedAt = Math.max(turn.updatedAt, timestamp);
      session.updatedAt = Math.max(session.updatedAt, timestamp);
    });
    active.accepted = true;
    active.acceptance.resolve({ turn: { id: active.turnId, status: "inProgress", items: [] } });
    for (const event of active.bufferedEvents.splice(0)) this._handleEvent(active, event);
  }

  _onEvent(event) {
    if (!plain(event) || event.known !== true || !safeString(event.sessionId, 512)
      || !safeString(event.turnId, 512) || !safeString(event.type, 128)) return;
    const active = this.activeTurns.get(event.sessionId);
    if (!active || active.turnId !== event.turnId || active.settled) return;
    if (!active.accepted) {
      active.bufferedEvents.push(event);
      return;
    }
    this._handleEvent(active, event);
  }

  _handleEvent(active, event) {
    if (active.settled) return;
    if (event.type === "text" && safeString(event.itemId, 512)
      && safeString(event.text, 8 * 1024 * 1024, { empty: true })) {
      const timestamp = this.now();
      this.ledger.update((data) => {
        const session = sessionById(data, active.sessionId);
        const turn = turnById(session, active.turnId);
        if (!turn.assistantMessages.some((message) => message.id === event.itemId)) {
          turn.assistantMessages.push({ id: event.itemId, text: event.text });
        }
        turn.updatedAt = Math.max(turn.updatedAt, timestamp);
        session.updatedAt = Math.max(session.updatedAt, timestamp);
      });
    } else if (event.type === "usage" && safeString(event.responseId, 512)
      && validateUsage(event.usage)) {
      const selected = parseModelRef(active.model || "");
      const provider = safeString(event.provider, 128) ? event.provider : selected?.provider || null;
      const model = safeString(event.model, 512) ? event.model : selected?.modelId || null;
      const timestamp = this.now();
      this.ledger.update((data) => {
        const session = sessionById(data, active.sessionId);
        const turn = turnById(session, active.turnId);
        if (!turn.usageResponseIds.includes(event.responseId)) {
          turn.usageResponseIds.push(event.responseId);
          turn.usage = addUsage(turn.usage, event.usage);
        }
        turn.responseId = event.responseId;
        turn.provider = provider;
        turn.model = model;
        turn.updatedAt = Math.max(turn.updatedAt, timestamp);
        session.updatedAt = Math.max(session.updatedAt, timestamp);
      });
      event = { ...event, provider, model };
    }
    this._publish(event);
    if (event.type === "complete" && TERMINAL_STATUSES.has(event.status)) {
      this._finishActive(active, event.status, event.errorCode || null);
    }
  }

  _finishActive(active, status, errorCode) {
    if (active.settled) return;
    const timestamp = this.now();
    this.ledger.update((data) => {
      const session = sessionById(data, active.sessionId);
      const turn = turnById(session, active.turnId);
      turn.acceptance = "accepted";
      turn.status = status;
      turn.errorCode = errorCode;
      turn.updatedAt = Math.max(turn.updatedAt, timestamp);
      session.updatedAt = Math.max(session.updatedAt, timestamp);
    });
    active.settled = true;
    if (this.activeTurns.get(active.sessionId) === active) this.activeTurns.delete(active.sessionId);
    active.terminal.resolve({ status });
  }

  _failActive(active, error, options = {}) {
    if (!active || active.settled) return;
    const failure = error?.code ? error : hostError(
      "DEEPSEEK_HARNESS_TURN_FAILED",
      "DeepSeek Harness turn failed",
    );
    const definitelyRejected = options.definitelyRejected === true;
    const timestamp = this.now();
    const acceptance = active.accepted ? "accepted" : definitelyRejected ? "failed" : "unknown";
    const status = active.interruptRequested || active.accepted ? "interrupted" : "failed";
    this.ledger.update((data) => {
      const session = sessionById(data, active.sessionId);
      const turn = turnById(session, active.turnId);
      turn.acceptance = acceptance;
      turn.status = status;
      turn.errorCode = failure.code;
      turn.updatedAt = Math.max(turn.updatedAt, timestamp);
      session.updatedAt = Math.max(session.updatedAt, timestamp);
    });
    active.settled = true;
    if (this.activeTurns.get(active.sessionId) === active) this.activeTurns.delete(active.sessionId);
    if (!active.accepted) active.acceptance.reject(failure);
    else this._publish({
      known: true,
      method: "deepseek-harness/error",
      type: "complete",
      sessionId: active.sessionId,
      turnId: active.turnId,
      status,
      errorCode: failure.code,
    });
    active.terminal.resolve({ status });
  }

  _onServerRequest(method, params) {
    const handler = this.serverRequestHandlers.get(method);
    if (!handler) {
      throw hostError(
        "RUNTIME_SERVER_REQUEST_UNAVAILABLE",
        "DeepSeek Harness request handler is unavailable",
      );
    }
    return handler(params);
  }

  _spawnBridge() {
    const reservation = this.mcpGateIssuer.reserveMcpServer({
      runtimeProfileId: this.runtimeProfileId,
      runtimeAccountId: this.runtimeAccountId,
      parentExecutable: this.launch.command,
    });
    this.reservationId = reservation.reservationId;
    const mcpEnv = Object.fromEntries(reservation.env.map((entry) => [entry.name, entry.value]));
    const mcpConfig = {
      transport: "stdio",
      serverName: reservation.name,
      command: reservation.command,
      args: [...reservation.args],
      env: mcpEnv,
      cwd: this.workspace || this.userHome,
      toolCallTimeoutMs: DEFAULT_MCP_TOOL_TIMEOUT_MS,
      failOnStartupError: true,
    };
    const env = this._spawnEnvironment(reservation.env, {
      DSH_HOME: this.runtimeEnvironment.spawnEnv.DSH_HOME,
      DSH_PERMISSION_MODE: this.permissionPolicy.sandbox,
      SHOGGOTH_DSH_APPROVAL_POLICY: this.permissionPolicy.approvalPolicy === "never"
        ? "never" : "ask",
      SHOGGOTH_DSH_MCP_CONFIG: JSON.stringify(mcpConfig),
      DSH_TELEMETRY_DISABLED: "1",
      DO_NOT_TRACK: "1",
    });
    const launcherArgs = [
      "-c", "IFS= read -r _ <&3 || exit 125; exec \"$@\"",
      "shoggoth-deepseek-harness-launcher",
      this.launch.command,
      ...this.launch.argsPrefix,
      "--profile",
      this.integration.profile,
      "--patch",
      this.integration.patchPath,
    ];
    let child;
    try {
      child = this.spawnProcess("/bin/sh", launcherArgs, {
        cwd: this.workspace || this.userHome,
        env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      });
    } catch {
      this._revokeMcp();
      throw hostError(
        "DEEPSEEK_HARNESS_PROCESS_SPAWN_FAILED",
        "DeepSeek Harness process could not start",
      );
    }
    if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 1
      || !child.stdin || !child.stdout || !child.stderr || !child.stdio?.[3]) {
      try { child?.kill?.("SIGKILL"); } catch {}
      this._revokeMcp();
      throw hostError(
        "DEEPSEEK_HARNESS_PROCESS_SPAWN_FAILED",
        "DeepSeek Harness process pipes are invalid",
      );
    }
    this.process = new DeepSeekHarnessProcess({
      child,
      requestTimeoutMs: this.requestTimeoutMs,
      serverRequestTimeoutMs: this.serverRequestTimeoutMs,
      maxFrameBytes: this.maxFrameBytes,
      maxStreamBytes: this.maxStreamBytes,
      randomUUID: this.randomUUID,
      onEvent: (event) => this._onEvent(event),
      onServerRequest: (method, params) => this._onServerRequest(method, params),
      onFatal: (error) => {
        try { this.onDiagnostic?.({ code: error?.code || "DEEPSEEK_HARNESS_PROCESS_FAILED" }); } catch {}
      },
    });
    void this.process.closedPromise.then((result) => this._onProcessClosed(result)).catch(() => {});
    try {
      this.mcpGateIssuer.bindMcpServer({
        reservationId: reservation.reservationId,
        parentPid: child.pid,
      });
      child.stdio[3].end("go\n");
    } catch (error) {
      this._killProcess("SIGKILL");
      this._revokeMcp();
      throw error;
    }
  }

  _onProcessClosed(result) {
    this._revokeMcp();
    if (["stopping", "stopped"].includes(this.state)) return;
    const error = hostError(
      /auth|credential|api[ -]?key|unauthorized/iu.test(result?.stderr || "")
        ? "AUTH_REQUIRED" : "DEEPSEEK_HARNESS_PROCESS_CLOSED",
      "DeepSeek Harness process closed unexpectedly",
    );
    for (const active of [...this.activeTurns.values()]) this._failActive(active, error);
    this.state = "failed";
    this.rejectTerminated(error);
  }

  _killProcess(signal) {
    const pid = this.process?.child?.pid;
    if (Number.isSafeInteger(pid) && pid > 1) {
      try { this.killProcessGroup(pid, signal); } catch {
        try { this.onDiagnostic?.({ code: "DEEPSEEK_HARNESS_PROCESS_GROUP_KILL_FAILED", signal }); } catch {}
      }
    }
    this.process?.kill(signal);
  }

  _revokeMcp() {
    if (!this.reservationId) return;
    try { this.mcpGateIssuer.revokeMcpServer({ reservationId: this.reservationId }); } catch {}
    this.reservationId = null;
  }

  async _ensureModelCatalog() {
    const now = this.now();
    if (Array.isArray(this.profileState.models) && this.profileState.modelsExpiresAt > now) {
      return this.profileState.models;
    }
    const payload = await this.process.request("models/list", {}, { timeoutMs: this.requestTimeoutMs });
    const models = validateCatalog(payload);
    this.profileState.models = models;
    this.profileState.modelsExpiresAt = now + 5 * 60 * 1000;
    return models;
  }

  async commandsList(input = {}) {
    this._assertReady();
    const session = input.sessionId == null ? null : this._requireSession(input.sessionId);
    this._sessionCwd(input.cwd);
    const payload = await this.process.request("commands/list", {
      remoteSessionId: session?.remoteSessionId || null,
    }, { timeoutMs: this.requestTimeoutMs });
    const commands = mergeNativeCommands("deepseek-harness", (payload?.commands || []).map((entry) => ({
      ...entry, source: "DeepSeek Harness registry",
      // Permissions must update the application’s durable session policy too.
      execution: entry.name === "permission" ? "client" : "runtime",
    })));
    return { supported: true, reason: null, commands };
  }

  async commandExecute(input) {
    this._assertExecutionInstance();
    const catalog = await this.commandsList(input);
    const parsed = requireRuntimeCommand(input?.text, catalog.commands, "deepseek-harness");
    return { kind: "send", text: parsed.text, warning: null };
  }

  _validateModel(model) {
    if (model === undefined || model === null) return null;
    if (!safeString(model, 640) || !parseModelRef(model)
      || !this.profileState.models?.some((candidate) => candidate.model === model)) {
      throw hostError("RUNTIME_MODEL_UNAVAILABLE", "DeepSeek Harness model is unavailable");
    }
    return model;
  }

  _sessionCwd(value) {
    const cwd = value === undefined || value === null ? (this.workspace || this.userHome)
      : normalizeDeepSeekHarnessWorkspace(value);
    if (this.workspace !== null && cwd !== this.workspace) {
      throw hostError(
        "DEEPSEEK_HARNESS_WORKSPACE_INVALID",
        "DeepSeek Harness workspace route changed",
      );
    }
    try {
      const stat = this.fs.lstatSync(cwd);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe cwd");
    } catch {
      throw hostError(
        "DEEPSEEK_HARNESS_WORKSPACE_INVALID",
        "DeepSeek Harness workspace is unavailable",
      );
    }
    return cwd;
  }

  _assertInputPermissionPolicy(value) {
    return normalizeDeepSeekHarnessPermissionPolicy(value);
  }

  _requireSession(sessionId) {
    if (!safeString(sessionId, 512)) {
      throw hostError(
        "RUNTIME_SESSION_PARAMS_INVALID",
        "DeepSeek Harness session id is invalid",
      );
    }
    const session = sessionById(this.ledger.snapshot(), sessionId);
    if (!session) {
      throw hostError("RUNTIME_SESSION_NOT_FOUND", "DeepSeek Harness session was not found");
    }
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
          errorCode: turn.errorCode || undefined,
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

  _spawnEnvironment(entries = [], reserved = {}) {
    const env = Object.create(null);
    for (const key of PARENT_ENV_ALLOWLIST) {
      const value = this.parentEnv[key];
      if (typeof value === "string" && value.isWellFormed() && !value.includes("\0")
        && Buffer.byteLength(value, "utf8") <= 64 * 1024) env[key] = value;
    }
    env.PATH = runtimePath(env.PATH, this.userHome);
    env.HOME = this.runtimeEnvironment.spawnEnv.HOME;
    for (const entry of entries) {
      if (!plain(entry) || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(entry.name)
        || !safeString(entry.value, 4096, { empty: true })) {
        throw hostError(
          "DEEPSEEK_HARNESS_MCP_CONFIG_INVALID",
          "DeepSeek Harness MCP environment is invalid",
        );
      }
      env[entry.name] = entry.value;
    }
    for (const [key, value] of Object.entries(reserved)) {
      if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(key) || !safeString(value, 128 * 1024)) {
        throw hostError(
          "DEEPSEEK_HARNESS_CONFIG_INVALID",
          "DeepSeek Harness Bridge environment is invalid",
        );
      }
      env[key] = value;
    }
    return env;
  }

  _runControl(args, options = {}) {
    if (!Array.isArray(args) || args.length === 0 || args.some((arg) => !safeString(arg, 4096))) {
      return Promise.reject(hostError(
        "DEEPSEEK_HARNESS_CONTROL_INVALID",
        "DeepSeek Harness control command is invalid",
      ));
    }
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnProcess(this.launch.command, [...this.launch.argsPrefix, ...args], {
          cwd: this.userHome,
          env: this._spawnEnvironment([], {
            DSH_HOME: this.runtimeEnvironment.spawnEnv.DSH_HOME,
          }),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        reject(hostError(
          "DEEPSEEK_HARNESS_PROCESS_SPAWN_FAILED",
          "DeepSeek Harness control process failed",
        ));
        return;
      }
      let stdout = "";
      let stderr = "";
      let settled = false;
      const append = (current, chunk) => {
        const next = `${current}${Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)}`;
        if (Buffer.byteLength(next, "utf8") > MAX_CONTROL_OUTPUT_BYTES) {
          throw hostError(
            "DEEPSEEK_HARNESS_CONTROL_OUTPUT_TOO_LARGE",
            "DeepSeek Harness control output is too large",
          );
        }
        return next;
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill("SIGKILL"); } catch {}
        reject(hostError(
          "DEEPSEEK_HARNESS_CONTROL_TIMEOUT",
          "DeepSeek Harness control command timed out",
        ));
      }, timeoutMs);
      timer.unref?.();
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill("SIGKILL"); } catch {}
        reject(error);
      };
      child.stdout.on("data", (chunk) => { try { stdout = append(stdout, chunk); } catch (error) { fail(error); } });
      child.stderr.on("data", (chunk) => { try { stderr = append(stderr, chunk); } catch (error) { fail(error); } });
      child.on("error", () => fail(hostError(
        "DEEPSEEK_HARNESS_PROCESS_FAILED",
        "DeepSeek Harness control process failed",
      )));
      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr });
      });
    });
  }

  _publish(event) {
    for (const listener of [...this.listeners]) {
      try { listener(Object.freeze(event)); } catch {}
    }
  }

  _assertReady() {
    if (this.state !== "ready") {
      throw hostError("DEEPSEEK_HARNESS_NOT_READY", "DeepSeek Harness runtime is not ready");
    }
  }

  _assertExecutionInstance() {
    this._assertReady();
    if (this.controlInstance) {
      throw hostError(
        "RUNTIME_CAPABILITY_UNSUPPORTED",
        "DeepSeek Harness control hosts cannot run sessions",
      );
    }
  }
}

module.exports = {
  DeepSeekHarnessRuntimeHost,
  addUsage,
  secureCredentialPresent,
  validateCatalog,
};
