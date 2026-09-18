"use strict";

const { imageAttachments } = require("./chat-attachments");

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { statIfExists, atomicWritePrivateFile, validatePrivateStat } = require("./private-file");
const { serviceError } = require("./security");
const { runtimeBinding } = require("./runtime-adapter");
const { validateResolvedEnvironment } = require("./runtime-account-resolver");
const { safeSnapshot } = require("./codex-event-snapshot");
const { PiRpcProcess } = require("./pi-rpc-process");
const { PiRuntimeLedger, emptyPiUsage } = require("./pi-runtime-ledger");
const { normalizeRuntimeCommands, parseRuntimeCommand } = require("./runtime-commands");
const { mergeNativeCommands, requireRuntimeCommand } = require("./native-cli-commands");
const PI_RPC_COMMANDS = normalizeRuntimeCommands([
  { name: "compact", description: "Compact conversation context", args: "[instructions]" },
  { name: "thinking", description: "Show or set thinking level", args: "[level]" },
  { name: "session", description: "Show session information and statistics" },
]);
const PRODUCT_CONFIRMATION_SELECT_PREFIX = "[[shoggoth-product-confirmation]]";
const {
  PI_RUNTIME,
  assertPiExtensionPath,
  buildPiRpcArgs,
  normalizePiPermissionPolicy,
  normalizePiWorkspace,
  parsePiModelRef,
  parsePiVersion,
  piModelRef,
  piWorkspaceShardId,
  resolvePiLaunch,
  supportsPiVersion,
} = require("./pi-runtime-paths");

const PARENT_ENV_ALLOWLIST = Object.freeze([
  "LANG", "LC_ALL", "LC_CTYPE", "PATH", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN",
  "ANT_LING_API_KEY", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_RESOURCE_NAME", "AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
  "DEEPSEEK_API_KEY", "NVIDIA_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY",
  "XAI_API_KEY", "FIREWORKS_API_KEY", "TOGETHER_API_KEY", "BASETEN_API_KEY",
  "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "ZAI_API_KEY", "ZAI_CODING_CN_API_KEY",
  "MISTRAL_API_KEY", "MINIMAX_API_KEY", "MOONSHOT_API_KEY", "OPENCODE_API_KEY", "KIMI_API_KEY",
  "CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID",
  "QWEN_TOKEN_PLAN_API_KEY", "QWEN_TOKEN_PLAN_CN_API_KEY", "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY", "XIAOMI_TOKEN_PLAN_AMS_API_KEY", "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION",
]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "interrupted", "canceled"]);
const AUTH_ERROR_PATTERN = /(?:auth|credential|api[ -]?key|login|sign[ -]?in|unauthorized|forbidden)/iu;
const MAX_CONTROL_OUTPUT_BYTES = 1024 * 1024;
const MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024;
const MAX_ASSISTANT_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_MODELS = 512;
const PI_CREDENTIAL_ENV_KEYS = Object.freeze([
  "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN",
  "ANT_LING_API_KEY", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "DEEPSEEK_API_KEY",
  "NVIDIA_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY",
  "FIREWORKS_API_KEY", "TOGETHER_API_KEY", "BASETEN_API_KEY", "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY", "ZAI_API_KEY", "ZAI_CODING_CN_API_KEY", "MISTRAL_API_KEY",
  "MINIMAX_API_KEY", "MOONSHOT_API_KEY", "OPENCODE_API_KEY", "KIMI_API_KEY",
  "CLOUDFLARE_API_KEY", "QWEN_TOKEN_PLAN_API_KEY", "QWEN_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_API_KEY", "XIAOMI_TOKEN_PLAN_CN_API_KEY", "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_BEARER_TOKEN_BEDROCK",
]);

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
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
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
    ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
  })).digest("hex");
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

function messageText(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text).join("");
}

function piUsage(value) {
  const usage = value && typeof value === "object" ? value : {};
  const number = (input) => Number.isSafeInteger(input) && input >= 0 ? input : 0;
  return {
    inputTokens: number(usage.input),
    cachedInputTokens: number(usage.cacheRead),
    cacheWriteInputTokens: number(usage.cacheWrite),
    outputTokens: number(usage.output),
    reasoningOutputTokens: number(usage.reasoning),
    totalTokens: number(usage.totalTokens),
  };
}

function addUsage(left, right) {
  const result = {};
  for (const key of Object.keys(emptyPiUsage())) {
    const value = left[key] + right[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw hostError("PI_USAGE_INVALID", "Pi token usage exceeds its limit");
    }
    result[key] = value;
  }
  return result;
}

function responseIdFor(active, messages) {
  const remote = [...messages].reverse().find((message) => safeString(message?.responseId, 512));
  if (remote) return remote.responseId;
  return `pi-response-${crypto.createHash("sha256").update(JSON.stringify([
    active.sessionId, active.turnId, active.remoteSessionId, messages.length,
  ])).digest("hex")}`;
}

function securePiCredentialPresent(fileSystem, home) {
  const target = path.join(home, "auth.json");
  const stat = statIfExists(fileSystem, target);
  if (stat === null) return false;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0
    || stat.size > MAX_CREDENTIAL_FILE_BYTES
    || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw hostError("PI_CREDENTIAL_UNSAFE", "Pi credential file is unsafe");
  }
  try {
    const realHome = fileSystem.realpathSync(home);
    const realTarget = fileSystem.realpathSync(target);
    if (path.dirname(realTarget) !== realHome) throw new Error("escaped credential");
  } catch {
    throw hostError("PI_CREDENTIAL_UNSAFE", "Pi credential file is unsafe");
  }
  try {
    const credentials = JSON.parse(fileSystem.readFileSync(target, "utf8"));
    if (!plain(credentials)) throw new Error("invalid credential storage");
    return Object.keys(credentials).length > 0;
  } catch {
    throw hostError("PI_CREDENTIAL_UNSAFE", "Pi credential file is unsafe");
  }
}

function validateCatalog(state, payload) {
  if (!plain(state) || !safeString(state.sessionId, 128)
    || !plain(payload) || !Array.isArray(payload.models)
    || payload.models.length === 0 || payload.models.length > MAX_MODELS) {
    throw hostError("RUNTIME_MODEL_CATALOG_INVALID", "Pi model catalog is invalid");
  }
  const defaultRef = state.model && safeString(state.model.provider, 128)
    && safeString(state.model.id, 512) ? piModelRef(state.model.provider, state.model.id) : null;
  const seen = new Set();
  const models = payload.models.map((model) => {
    if (!plain(model) || !safeString(model.provider, 128) || !safeString(model.id, 512)
      || (model.name !== undefined && !safeString(model.name, 512))
      || !Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1
      || typeof model.reasoning !== "boolean") {
      throw hostError("RUNTIME_MODEL_CATALOG_INVALID", "Pi model catalog item is invalid");
    }
    const ref = piModelRef(model.provider, model.id);
    if (seen.has(ref)) throw hostError("RUNTIME_MODEL_CATALOG_INVALID", "Pi model catalog is duplicated");
    seen.add(ref);
    // Pi's getSupportedThinkingLevels uses the model's thinkingLevelMap.
    const thinkingOptions = model.reasoning ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
      .filter(level => model.thinkingLevelMap?.[level] !== null
        && (!["xhigh", "max"].includes(level) || model.thinkingLevelMap?.[level] !== undefined)) : [];
    return Object.freeze({
      model: ref,
      provider: model.provider,
      modelId: model.id,
      displayName: model.name || ref,
      description: `${model.provider} · ${model.contextWindow} context${model.reasoning ? " · reasoning" : ""}`,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
      capabilities: { thinkingOptions, thinkingDefault: ref === defaultRef && thinkingOptions.includes(state.thinkingLevel)
        ? state.thinkingLevel : null, fastTier: null },
      input: Array.isArray(model.input) ? Object.freeze([...model.input]) : Object.freeze(["text"]),
      isDefault: ref === defaultRef,
    });
  });
  if (defaultRef !== null && !seen.has(defaultRef)) {
    throw hostError("RUNTIME_MODEL_CATALOG_INVALID", "Pi default model is missing from its catalog");
  }
  if (!models.some((model) => model.isDefault)) models[0] = Object.freeze({ ...models[0], isDefault: true });
  return Object.freeze(models);
}

class PiRuntimeHost {
  constructor(options = {}) {
    this.paths = options.paths;
    if (!this.paths?.stateDir || !this.paths?.trustedRoot) {
      throw hostError("PI_HOST_OPTIONS_INVALID", "Pi host paths are invalid");
    }
    this.binding = runtimeBinding(options.runtimeBinding || {
      runtime: PI_RUNTIME,
      runtimeProfileId: options.runtimeProfileId,
      runtimeAccountId: options.runtimeAccountId,
    });
    this.runtimeProfileId = this.binding.runtimeProfileId;
    this.runtimeAccountId = this.binding.runtimeAccountId;
    this.runtimeEnvironment = validateResolvedEnvironment(options.runtimeEnvironment, this.binding);
    this.permissionPolicy = normalizePiPermissionPolicy(options.permissionPolicy);
    this.controlInstance = options.controlInstance === true;
    this.workspace = this.controlInstance ? null : normalizePiWorkspace(options.workspace);
    this.binaryCandidate = options.binaryPath;
    this.extensionCandidate = options.extensionPath;
    this.parentEnv = options.parentEnv || process.env;
    this.userHome = this.runtimeEnvironment.spawnEnv.HOME;
    this.fs = options.fs || fs;
    this.spawnProcess = options.spawnProcess || spawn;
    this.killProcessGroup = options.killProcessGroup || defaultKillProcessGroup;
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.onDiagnostic = typeof options.onDiagnostic === "function" ? options.onDiagnostic : null;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 10 * 60 * 1_000;
    this.acceptanceTimeoutMs = options.acceptanceTimeoutMs ?? 45_000;
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
      throw hostError("PI_HOST_OPTIONS_INVALID", "Pi MCP gate issuer is invalid");
    }
    for (const value of [this.requestTimeoutMs, this.promptTimeoutMs, this.acceptanceTimeoutMs,
      this.shutdownGraceMs, this.killGraceMs]) {
      if (!Number.isSafeInteger(value) || value < 100 || value > 10 * 60 * 1000) {
        throw hostError("PI_HOST_OPTIONS_INVALID", "Pi host timeout is invalid");
      }
    }
    this.state = "new";
    this.home = null;
    this.binaryPath = null;
    this.launch = null;
    this.extensionPath = null;
    this.ledger = null;
    this.sessionConfigs = new Map();
    this.commandCatalog = null;
    this.commandsExpiresAt = 0;
    this.activeTurns = new Map();
    this.turnProcesses = new Map();
    this.controlProcesses = new Map();
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
    if (this.state !== "new") throw hostError("PI_RUNTIME_STATE_INVALID", "Pi host state is invalid");
    this.state = "initializing";
    try {
      this.home = this.runtimeEnvironment.home;
      this.binaryPath = this.runtimeEnvironment.binaryPath;
      this.launch = resolvePiLaunch(this.binaryPath, {
        parentEnv: this.parentEnv,
        homedir: this.userHome,
        fs: this.fs,
      });
      this.extensionPath = assertPiExtensionPath(this.extensionCandidate, { fs: this.fs });
      const versionResult = await this._runControl(["--version"], { timeoutMs: 5_000 });
      if (this.state !== "initializing") {
        throw hostError("RUNTIME_HOST_TERMINATED", "Pi host stopped during initialization");
      }
      const version = parsePiVersion(versionResult.stdout);
      if (versionResult.code !== 0 || !supportsPiVersion(version)) {
        throw hostError("PI_VERSION_UNSUPPORTED", "Pi CLI 0.84.4 (0.84.x) is required");
      }
      this.ledger = new PiRuntimeLedger({
        fs: this.fs,
        stateRoot: path.join(this.paths.stateDir, "runtime-ledgers", PI_RUNTIME),
        trustedRoot: this.paths.trustedRoot,
        runtimeProfileId: this.runtimeProfileId,
        workspaceShardId: piWorkspaceShardId({
          controlInstance: this.controlInstance,
          workspace: this.workspace,
        }),
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

  beginAcquire() { this._assertReady(); }

  async authenticationState() {
    this._assertReady();
    const localCredentialPresent = securePiCredentialPresent(this.fs, this.home)
      || PI_CREDENTIAL_ENV_KEYS.some((key) => safeString(this.parentEnv[key], 64 * 1024));
    let catalog;
    try {
      catalog = await this._ensureModelCatalog();
    } catch {
      return Object.freeze({ authenticated: false, credentialPresent: localCredentialPresent });
    }
    const selected = catalog.find((model) => model.isDefault) || catalog[0];
    const now = this.now();
    if (this.profileState.auth && this.profileState.authExpiresAt > now
      && this.profileState.auth.model === selected.model) {
      return this.profileState.auth.state;
    }
    const result = await this._runControl([
      "auth", "check", "--model", selected.model, "--json", "--no-refresh",
    ], { timeoutMs: 15_000 });
    let payload = null;
    try { payload = JSON.parse(result.stdout); } catch {}
    const authenticated = result.code === 0 && payload?.status === "ready";
    const credentialPresent = authenticated || localCredentialPresent;
    const state = Object.freeze({ authenticated, credentialPresent });
    this.profileState.auth = { model: selected.model, state };
    this.profileState.authExpiresAt = now + 30_000;
    return state;
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw hostError("PI_SUBSCRIBER_INVALID", "Pi listener is invalid");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  registerServerRequestHandler(method, handler) {
    if (!safeString(method, 256) || typeof handler !== "function") {
      throw hostError("PI_HANDLER_INVALID", "Pi server request handler is invalid");
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
      throw hostError("RUNTIME_SESSION_PARAMS_INVALID", "Pi session input is invalid");
    }
    this._assertInputPermissionPolicy(input.permissionPolicy);
    const cwd = this._sessionCwd(input.cwd);
    const model = this._validateModel(input.model);
    const snapshot = this.ledger.snapshot();
    const existing = snapshot.sessions.find((session) => session.source === input.source);
    if (existing) {
      this.sessionConfigs.set(existing.id, {
        developerInstructions: typeof input.developerInstructions === "string"
          ? input.developerInstructions : "",
        model,
      });
      return { session: this._projectSession(existing) };
    }
    const createdAt = this.now();
    const remoteSessionId = this.randomUUID();
    const session = {
      id: `pi-session-${this.randomUUID()}`,
      remoteSessionId,
      sessionFile: null,
      source: input.source,
      cwd,
      title: null,
      archived: false,
      createdAt,
      updatedAt: createdAt,
      turns: [],
    };
    if (!safeString(session.id, 512) || !/^[0-9a-f-]{36}$/u.test(remoteSessionId)) {
      throw hostError("RUNTIME_SESSION_ID_INVALID", "Pi session id is invalid");
    }
    this.ledger.update((data) => data.sessions.push(session));
    this.sessionConfigs.set(session.id, {
      developerInstructions: typeof input.developerInstructions === "string"
        ? input.developerInstructions : "",
      model,
    });
    return { session: this._projectSession(session) };
  }

  async sessionResume(input) {
    this._assertExecutionInstance();
    await this._ensureModelCatalog();
    if (!plain(input) || !safeString(input.sessionId, 512)
      || (input.developerInstructions !== undefined
        && !safeString(input.developerInstructions, 1024 * 1024, { empty: true }))) {
      throw hostError("RUNTIME_SESSION_PARAMS_INVALID", "Pi resume input is invalid");
    }
    this._assertInputPermissionPolicy(input.permissionPolicy);
    const session = this._requireSession(input.sessionId);
    if (session.archived) throw hostError("RUNTIME_SESSION_NOT_FOUND", "Pi session is archived");
    if (this.activeTurns.has(session.id)) throw hostError("RUNTIME_SESSION_BUSY", "Pi session is active");
    if (this._sessionCwd(input.cwd) !== session.cwd) {
      throw hostError("RUNTIME_SESSION_NOT_FOUND", "Pi session workspace does not match");
    }
    this.sessionConfigs.set(session.id, {
      developerInstructions: typeof input.developerInstructions === "string"
        ? input.developerInstructions : "",
      model: this._validateModel(input.model),
    });
    return { session: this._projectSession(session) };
  }

  sessionRead(input) {
    this._assertReady();
    if (!plain(input) || !safeString(input.sessionId, 512)) {
      return Promise.reject(hostError("RUNTIME_SESSION_PARAMS_INVALID", "Pi read input is invalid"));
    }
    const session = sessionById(this.ledger.snapshot(), input.sessionId);
    if (!session) return Promise.reject(hostError("RUNTIME_SESSION_NOT_FOUND", "Pi session was not found"));
    if (session.turns.some((turn) => turn.acceptance === "unknown" && turn.executionEndedAt === null)) {
      return Promise.reject(hostError("RUNTIME_TURN_ACCEPTANCE_UNKNOWN", "Pi turn acceptance is unknown"));
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
      return Promise.reject(hostError("RUNTIME_SESSION_CURSOR_INVALID", "Pi cursor is invalid"));
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
      return Promise.reject(hostError("RUNTIME_SESSION_PARAMS_INVALID", "Pi rename input is invalid"));
    }
    this.ledger.update((data) => {
      const session = sessionById(data, input.sessionId);
      if (!session) throw hostError("RUNTIME_SESSION_NOT_FOUND", "Pi session was not found");
      session.title = input.name;
      session.updatedAt = Math.max(session.updatedAt, this.now());
    });
    return Promise.resolve({});
  }

  sessionArchive(input) {
    this._assertReady();
    const session = this._requireSession(input?.sessionId);
    if (this.activeTurns.has(session.id)) {
      return Promise.reject(hostError("RUNTIME_SESSION_BUSY", "Pi session is active"));
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

  sessionDelete(input) {
    this._assertReady();
    const session = this._requireSession(input?.sessionId);
    if (this.activeTurns.has(session.id)) {
      return Promise.reject(hostError("RUNTIME_SESSION_BUSY", "Pi session is active"));
    }
    if (session.sessionFile !== null) this._deleteSessionFile(session.sessionFile);
    this.ledger.update((data) => {
      const index = data.sessions.findIndex((candidate) => candidate.id === session.id);
      if (index < 0) throw hostError("RUNTIME_SESSION_NOT_FOUND", "Pi session was not found");
      data.sessions.splice(index, 1);
    });
    this.sessionConfigs.delete(session.id);
    return Promise.resolve({});
  }

  async turnStart(input) {
    this._assertExecutionInstance();
    await this._ensureModelCatalog();
    if (!plain(input) || !safeString(input.sessionId, 512)
      || !safeString(input.operationId, 512)
      || !safeString(input.prompt, 1024 * 1024, { empty: true })
      || (input.context !== undefined && input.context !== null
        && !safeString(input.context, 4 * 1024 * 1024, { empty: true }))) {
      throw hostError("RUNTIME_TURN_PARAMS_INVALID", "Pi turn input is invalid");
    }
    const permissionPolicy = this._assertInputPermissionPolicy(input.permissionPolicy);
    const session = this._requireSession(input.sessionId);
    if (session.archived) throw hostError("RUNTIME_SESSION_ARCHIVED", "Pi session is archived");
    if (this._sessionCwd(input.cwd) !== session.cwd) {
      throw hostError("RUNTIME_SESSION_NOT_FOUND", "Pi turn workspace does not match");
    }
    const model = this._validateModel(input.model ?? this.sessionConfigs.get(session.id)?.model);
    const fingerprint = inputFingerprint({ ...input, model });
    const existing = turnByOperation(session, input.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw hostError("RUNTIME_OPERATION_CONFLICT", "Pi operationId input changed");
      }
      const active = this.activeTurns.get(session.id);
      if (active?.turnId === existing.id) return active.acceptance.promise;
      if (existing.acceptance === "unknown") {
        throw hostError("RUNTIME_TURN_ACCEPTANCE_UNKNOWN", "Pi turn acceptance is unknown");
      }
      if (existing.acceptance === "failed") {
        throw hostError(existing.errorCode || "PI_TURN_FAILED", "Pi turn failed");
      }
      return { turn: { id: existing.id, status: existing.status, items: [] } };
    }
    if (session.turns.some((turn) => turn.acceptance === "unknown" && turn.executionEndedAt === null)) {
      throw hostError("RUNTIME_TURN_ACCEPTANCE_UNKNOWN", "A prior Pi turn is unresolved");
    }
    if (this.activeTurns.has(session.id) || [...this.turnProcesses.values()].some((marker) => (
      marker.active?.sessionId === session.id && marker.active.failed && !marker.active.process.closed
    ))) throw hostError("RUNTIME_SESSION_BUSY", "Pi session is active");
    const turnId = `pi-turn-${this.randomUUID()}`;
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
        provider: null,
        model: null,
        usage: emptyPiUsage(),
        createdAt,
        updatedAt: createdAt,
        executionEndedAt: null,
      });
      current.updatedAt = Math.max(current.updatedAt, createdAt);
    });
    const active = {
      sessionId: session.id,
      remoteSessionId: session.remoteSessionId,
      turnId,
      cwd: session.cwd,
      model,
      title: session.title,
      prompt: this._promptText(session.id, input),
      images: imageAttachments(input.attachments).map(image => ({ type: "image", ...image })),
      thinkingLevel: input.thinkingLevel,
      nativeCommand: parseRuntimeCommand(input.prompt, this.commandCatalog || PI_RPC_COMMANDS),
      commandContext: [this.sessionConfigs.get(session.id)?.developerInstructions, input.context]
        .filter(Boolean).join("\n\n"),
      commandContextFile: null,
      acceptance: makeDeferred(),
      terminal: makeDeferred(),
      accepted: false,
      settled: false,
      promptDispatched: false,
      agentSettled: false,
      interruptRequested: false,
      baselineMessageCount: 0,
      messageSequence: 0,
      currentMessageId: null,
      process: null,
      reservationId: null,
      acceptanceTimer: null,
      promptTimer: null,
      permissionPolicy,
      promptDeadlineAt: null,
      promptTimeoutRemainingMs: this.promptTimeoutMs,
      promptTimeoutPaused: false,
    };
    this.activeTurns.set(session.id, active);
    try { this._spawnTurn(active); } catch (error) {
      this._failActive(active, error, { definitelyRejected: true });
      return active.acceptance.promise;
    }
    void this._beginTurn(active).catch((error) => {
      const definitelyRejected = !active.promptDispatched
        || ["AUTH_REQUIRED", "PI_RPC_REQUEST_FAILED"].includes(error?.code);
      this._failActive(active, error, { definitelyRejected });
    });
    return active.acceptance.promise;
  }

  async turnSteer(input) {
    this._assertReady();
    if (!plain(input) || !safeString(input.sessionId, 512) || !safeString(input.turnId, 512)
      || !safeString(input.operationId, 512) || !safeString(input.message, 1024 * 1024)) {
      throw hostError("RUNTIME_TURN_PARAMS_INVALID", "Pi steer input is invalid");
    }
    const active = this.activeTurns.get(input.sessionId);
    if (!active || active.turnId !== input.turnId || !active.accepted || active.settled) {
      throw hostError("RUNTIME_TURN_NOT_ACTIVE", "Pi turn is not active");
    }
    await active.process.request("steer", { message: input.message }, { timeoutMs: this.requestTimeoutMs });
    return { turnId: active.turnId };
  }

  async turnInterrupt(input) {
    this._assertReady();
    if (!plain(input) || !safeString(input.sessionId, 512) || !safeString(input.turnId, 512)) {
      throw hostError("RUNTIME_TURN_PARAMS_INVALID", "Pi interrupt input is invalid");
    }
    const session = this._requireSession(input.sessionId);
    const turn = turnById(session, input.turnId);
    if (!turn) throw hostError("RUNTIME_TURN_STALE", "Pi turn is stale");
    const active = this.activeTurns.get(session.id);
    if (!active) {
      if (["canceled", "interrupted"].includes(turn.status)) return {};
      throw hostError("RUNTIME_TURN_NOT_ACTIVE", "Pi turn is no longer active");
    }
    if (active.turnId !== input.turnId) throw hostError("RUNTIME_TURN_STALE", "Pi turn is stale");
    active.interruptRequested = true;
    await active.process.request("clear_queue", {}, { timeoutMs: this.requestTimeoutMs }).catch(() => {});
    await active.process.request("abort", {}, { timeoutMs: this.requestTimeoutMs });
    const terminal = await Promise.race([
      active.terminal.promise,
      delay(this.requestTimeoutMs).then(() => null),
    ]);
    if (!terminal || !["canceled", "interrupted"].includes(terminal.status)) {
      this._killActiveProcess(active, "SIGKILL");
      throw hostError("RUNTIME_TURN_CANCEL_UNKNOWN", "Pi did not confirm interruption");
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
      throw hostError("RUNTIME_MODEL_CURSOR_INVALID", "Pi model cursor is invalid");
    }
    const page = models.slice(offset, offset + limit).map((model) => ({
      model: model.model,
      displayName: model.displayName,
      description: model.description,
      isDefault: model.isDefault,
      hidden: false,
      capabilities: model.capabilities,
    }));
    const next = offset + page.length;
    return { data: page, nextCursor: next < models.length ? String(next) : null };
  }

  async stop() {
    if (this.stopping) return this.stopping;
    if (this.state === "stopped") return undefined;
    this.state = "stopping";
    this.stopping = (async () => {
      const active = [...this.activeTurns.values()];
      const turnProcesses = [...this.turnProcesses.entries()];
      const controlProcesses = [...this.controlProcesses.entries()];
      for (const [rpc] of turnProcesses) this._killRpcProcess(rpc, "SIGTERM");
      for (const [child] of controlProcesses) {
        try { child.kill("SIGTERM"); } catch {}
      }
      if (active.length > 0 || turnProcesses.length > 0 || controlProcesses.length > 0) {
        await Promise.race([
          Promise.all([
            ...active.map((turn) => turn.terminal.promise),
            ...turnProcesses.map(([, marker]) => marker.promise),
            ...controlProcesses.map(([, marker]) => marker.promise),
          ]),
          delay(this.shutdownGraceMs),
        ]);
      }
      for (const rpc of this.turnProcesses.keys()) this._killRpcProcess(rpc, "SIGKILL");
      for (const [child] of this.controlProcesses) {
        try { child.kill("SIGKILL"); } catch {}
      }
      if (this.activeTurns.size > 0 || this.turnProcesses.size > 0
        || this.controlProcesses.size > 0) await delay(this.killGraceMs);
      for (const turn of [...this.activeTurns.values()]) {
        this.cleanupIncomplete = true;
        this._failActive(turn, hostError("PI_PROCESS_CLOSE_TIMEOUT", "Pi process did not terminate"));
      }
      if (this.turnProcesses.size > 0) this.cleanupIncomplete = true;
      if (this.controlProcesses.size > 0) this.cleanupIncomplete = true;
      this.state = "stopped";
      this.resolveTerminated();
      if (this.cleanupIncomplete) {
        const error = hostError("PI_PROCESS_CLOSE_TIMEOUT", "Pi process cleanup is incomplete");
        error.cleanupIncomplete = true;
        throw error;
      }
    })();
    return this.stopping;
  }

  _spawnTurn(active) {
    const reservation = this.mcpGateIssuer.reserveMcpServer({
      runtimeProfileId: this.runtimeProfileId,
      runtimeAccountId: this.runtimeAccountId,
      parentExecutable: this.launch.command,
    });
    active.reservationId = reservation.reservationId;
    const args = buildPiRpcArgs({
      permissionPolicy: active.permissionPolicy,
      sessionId: active.remoteSessionId,
      sessionDir: this.ledger.sessionDir,
      extensionPath: this.extensionPath,
      model: active.model,
      name: active.title,
    }).slice();
    if (active.nativeCommand && active.commandContext) {
      const target = path.join(this.ledger.sessionDir, `.shoggoth-command-${active.turnId}.md`);
      atomicWritePrivateFile(target, active.commandContext, { fs: this.fs, trustedRoot: this.paths.trustedRoot });
      const stat = validatePrivateStat(this.fs.lstatSync(target), target);
      active.commandContextFile = { target, dev: stat.dev, ino: stat.ino };
      args.push("--append-system-prompt", target);
    }
    const env = this._spawnEnvironment(reservation.env, {
      SHOGGOTH_PI_MCP_COMMAND: reservation.command,
      SHOGGOTH_PI_MCP_ARGS: JSON.stringify(reservation.args),
      SHOGGOTH_PI_PERMISSION_POLICY: JSON.stringify(active.permissionPolicy),
    });
    const launcherArgs = [
      "-c", "IFS= read -r _ <&3 || exit 125; exec \"$@\"",
      "shoggoth-pi-launcher", this.launch.command, ...this.launch.argsPrefix, ...args,
    ];
    let child;
    try {
      child = this.spawnProcess("/bin/sh", launcherArgs, {
        cwd: active.cwd,
        env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      });
    } catch {
      this.mcpGateIssuer.revokeMcpServer({ reservationId: reservation.reservationId });
      throw hostError("PI_PROCESS_SPAWN_FAILED", "Pi process could not start");
    }
    if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 1
      || !child.stdin || !child.stdout || !child.stderr || !child.stdio?.[3]) {
      try { child?.kill?.("SIGKILL"); } catch {}
      this.mcpGateIssuer.revokeMcpServer({ reservationId: reservation.reservationId });
      throw hostError("PI_PROCESS_SPAWN_FAILED", "Pi process pipes are invalid");
    }
    active.process = new PiRpcProcess({
      child,
      requestTimeoutMs: this.requestTimeoutMs,
      maxFrameBytes: this.maxFrameBytes,
      maxStreamBytes: this.maxStreamBytes,
      randomUUID: this.randomUUID,
      onEvent: (event) => this._onPiEvent(active, event),
      onExtensionRequest: (request) => this._onExtensionRequest(active, request),
      onFatal: (error) => {
        this._killActiveProcess(active, "SIGKILL");
        this._failActive(active, error);
      },
    });
    const processMarker = makeDeferred();
    processMarker.active = active;
    this.turnProcesses.set(active.process, processMarker);
    void active.process.closedPromise.then((result) => {
      this.turnProcesses.delete(active.process);
      processMarker.resolve(result);
      this._onProcessClosed(active, result);
    }).catch((error) => {
      this.turnProcesses.delete(active.process);
      processMarker.reject(error);
    });
    active.acceptanceTimer = setTimeout(() => {
      if (active.settled || active.accepted) return;
      this._killActiveProcess(active, "SIGKILL");
      this._failActive(active, hostError(
        active.promptDispatched ? "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" : "PI_RPC_STARTUP_TIMEOUT",
        active.promptDispatched ? "Pi did not prove prompt acceptance" : "Pi startup timed out before prompt dispatch",
      ));
    }, this.acceptanceTimeoutMs);
    active.acceptanceTimer.unref?.();
    this._armPromptTimeout(active, this.promptTimeoutMs);
    try {
      this.mcpGateIssuer.bindMcpServer({
        reservationId: reservation.reservationId,
        parentPid: child.pid,
      });
      child.stdio[3].end("go\n");
    } catch (error) {
      this._killActiveProcess(active, "SIGKILL");
      this.mcpGateIssuer.revokeMcpServer({ reservationId: reservation.reservationId });
      throw error;
    }
  }

  _armPromptTimeout(active, timeoutMs) {
    active.promptTimeoutRemainingMs = timeoutMs;
    active.promptDeadlineAt = this.now() + timeoutMs;
    active.promptTimer = setTimeout(() => {
      if (active.settled) return;
      this._killActiveProcess(active, "SIGKILL");
      this._failActive(active, hostError("PI_TURN_TIMEOUT", "Pi turn exceeded its timeout"));
    }, timeoutMs);
    active.promptTimer.unref?.();
  }

  _pausePromptTimeout(active) {
    if (active.settled || active.promptTimeoutPaused || active.promptTimer === null) return;
    active.promptTimeoutRemainingMs = Math.max(1, active.promptDeadlineAt - this.now());
    clearTimeout(active.promptTimer);
    active.promptTimer = null;
    active.promptDeadlineAt = null;
    active.promptTimeoutPaused = true;
  }

  _resumePromptTimeout(active) {
    if (!active.promptTimeoutPaused) return;
    active.promptTimeoutPaused = false;
    if (active.settled) return;
    this._armPromptTimeout(active, active.promptTimeoutRemainingMs);
  }

  _killActiveProcess(active, signal) {
    this._killRpcProcess(active?.process, signal);
  }

  _killRpcProcess(rpc, signal) {
    const pid = rpc?.child?.pid;
    if (Number.isSafeInteger(pid) && pid > 1) {
      try { this.killProcessGroup(pid, signal); } catch {
        try { this.onDiagnostic?.({ code: "PI_PROCESS_GROUP_KILL_FAILED", signal }); } catch {}
      }
    }
    rpc?.kill(signal);
  }

  async _beginTurn(active) {
    const state = await active.process.request("get_state", {}, { timeoutMs: this.acceptanceTimeoutMs });
    if (active.settled) return;
    if (!plain(state) || state.sessionId !== active.remoteSessionId
      || !Number.isSafeInteger(state.messageCount) || state.messageCount < 0) {
      throw hostError("PI_RPC_STATE_INVALID", "Pi RPC session state is invalid");
    }
    active.baselineMessageCount = state.messageCount;
    this._recordSessionFile(active.sessionId, state.sessionFile);
    if (active.thinkingLevel !== undefined) {
      let level = active.thinkingLevel;
      if (level === null) {
        // A fresh no-session process reads the runtime default without the
        // previous session override, including per-model configuration.
        const control = this._spawnControlRpc({ model: active.model });
        try { level = (await control.request("get_state", {})).thinkingLevel; }
        finally {
          control.endInput();
          await Promise.race([control.closedPromise, delay(this.killGraceMs)]);
          if (!control.closed) control.kill("SIGKILL");
        }
      }
      const available = await active.process.request("get_available_thinking_levels", {});
      if (!Array.isArray(available?.levels) || !available.levels.includes(level)) {
        throw hostError("RUNTIME_TURN_PARAMS_INVALID", "Pi thinking level is unavailable for this model");
      }
      await active.process.request("set_thinking_level", { level });
    }
    active.promptDispatched = true;
    const command = active.nativeCommand;
    if (command && PI_RPC_COMMANDS.some((entry) => entry.name === command.command.name)) {
      active.commandRpc = true;
      this._acceptActive(active);
      let text;
      if (command.command.name === "compact") {
        const result = await active.process.request("compact", {
          ...(command.args ? { customInstructions: command.args } : {}),
        }, { timeoutMs: this.promptTimeoutMs });
        text = `Pi context compacted${Number.isSafeInteger(result?.tokensBefore) ? ` (${result.tokensBefore} tokens before)` : ""}.`;
      } else if (command.command.name === "thinking") {
        if (command.args) {
          const available = await active.process.request("get_available_thinking_levels", {});
          if (!Array.isArray(available?.levels) || !available.levels.includes(command.args)) {
            throw hostError("RUNTIME_COMMAND_PARAMS_INVALID", "Pi thinking level is not available for this model");
          }
          await active.process.request("set_thinking_level", { level: command.args });
        }
        const current = await active.process.request("get_state", {});
        text = `Pi thinking level: ${current.thinkingLevel}`;
      } else {
        if (command.args) throw hostError("RUNTIME_COMMAND_PARAMS_INVALID", "Usage: /session");
        const stats = await active.process.request("get_session_stats", {});
        text = JSON.stringify(stats, null, 2);
      }
      const current = await active.process.request("get_state", {});
      if (current.sessionId !== active.remoteSessionId) throw hostError("PI_RPC_STATE_INVALID", "Pi command changed the session binding");
      this._recordSessionFile(active.sessionId, current.sessionFile);
      this._finishActive(active, {
        status: "completed", errorCode: null, texts: [text], usage: emptyPiUsage(),
        responseId: `pi-command-${active.turnId}`, provider: null, model: null,
      });
      return;
    }
    await active.process.request("prompt", { message: active.prompt,
      ...(active.images?.length ? { images: active.images } : {}) }, {
      timeoutMs: this.acceptanceTimeoutMs,
    });
    this._acceptActive(active);
    if (active.agentSettled) void this._finishSettled(active);
  }

  _onPiEvent(active, event) {
    if (active.settled || !plain(event) || !safeString(event.type, 128)) return;
    if (event.type === "message_start" && event.message?.role === "assistant") {
      active.messageSequence += 1;
      active.currentMessageId = `pi-message-${active.turnId}-${active.messageSequence}`;
      return;
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (!plain(update) || !active.currentMessageId) return;
      if (update.type === "text_delta" && safeString(update.delta, MAX_ASSISTANT_TEXT_BYTES, { empty: true })) {
        this._publish({
          known: true,
          method: "pi/message_update",
          type: "text_delta",
          sessionId: active.sessionId,
          turnId: active.turnId,
          itemId: active.currentMessageId,
          delta: update.delta,
        });
      } else if (update.type === "thinking_delta"
        && safeString(update.delta, MAX_ASSISTANT_TEXT_BYTES, { empty: true })) {
        this._publish({
          known: true,
          method: "pi/message_update",
          type: "reasoning_delta",
          sessionId: active.sessionId,
          turnId: active.turnId,
          itemId: `${active.currentMessageId}-reasoning`,
          delta: update.delta,
        });
      }
      return;
    }
    if (event.type === "tool_execution_start" && safeString(event.toolCallId, 512)
      && safeString(event.toolName, 256)) {
      const input = event.args === undefined ? undefined : safeSnapshot(event.args, {
        registeredSecrets: this.registeredSecrets,
        maxSnapshotBytes: 64 * 1024,
      });
      this._publish({
        known: true,
        method: "pi/tool_execution_start",
        type: "tool_start",
        sessionId: active.sessionId,
        turnId: active.turnId,
        itemId: `pi-tool-${event.toolCallId}`,
        toolCallId: event.toolCallId,
        tool: {
          kind: "other", name: event.toolName, status: "in_progress",
          ...(input === undefined ? {} : { input }),
        },
      });
      return;
    }
    if (event.type === "tool_execution_end" && safeString(event.toolCallId, 512)
      && safeString(event.toolName, 256)) {
      const output = event.result === undefined ? undefined : safeSnapshot(event.result, {
        registeredSecrets: this.registeredSecrets,
        maxSnapshotBytes: 64 * 1024,
      });
      this._publish({
        known: true,
        method: "pi/tool_execution_end",
        type: "tool_result",
        sessionId: active.sessionId,
        turnId: active.turnId,
        itemId: `pi-tool-${event.toolCallId}`,
        toolCallId: event.toolCallId,
        tool: {
          kind: "other",
          name: event.toolName,
          status: event.isError === true ? "failed" : "completed",
          success: event.isError !== true,
          ...(output === undefined ? {} : { output }),
        },
      });
      return;
    }
    if (event.type === "agent_settled" && !active.commandRpc) {
      active.agentSettled = true;
      if (active.accepted) void this._finishSettled(active);
    }
  }

  async _finishSettled(active) {
    if (active.settled || active.finishing) return;
    active.finishing = true;
    try {
      const [payload, state] = await Promise.all([
        active.process.request("get_messages", {}, { timeoutMs: this.requestTimeoutMs }),
        active.process.request("get_state", {}, { timeoutMs: this.requestTimeoutMs }),
      ]);
      if (!plain(payload) || !Array.isArray(payload.messages) || !plain(state)
        || state.sessionId !== active.remoteSessionId) {
        throw hostError("PI_RPC_STATE_INVALID", "Pi terminal state is invalid");
      }
      this._recordSessionFile(active.sessionId, state.sessionFile);
      const turnMessages = payload.messages.slice(active.baselineMessageCount);
      const assistants = turnMessages.filter((message) => message?.role === "assistant");
      let usage = emptyPiUsage();
      for (const message of assistants) usage = addUsage(usage, piUsage(message.usage));
      const last = assistants[assistants.length - 1] || null;
      const status = active.interruptRequested || last?.stopReason === "aborted"
        ? "interrupted" : last?.stopReason === "error" ? "failed" : "completed";
      const authenticationFailed = status === "failed"
        && typeof last?.errorMessage === "string" && AUTH_ERROR_PATTERN.test(last.errorMessage);
      const accountBlocked = authenticationFailed
        && /\b(?:user )?account (?:is )?(?:blocked|suspended|deactivated)\b/iu.test(last.errorMessage);
      if (authenticationFailed) {
        this.profileState.auth = null;
        this.profileState.authExpiresAt = 0;
      }
      const texts = assistants.map(messageText).filter((text) => text.length > 0);
      if (texts.some((text) => Buffer.byteLength(text, "utf8") > MAX_ASSISTANT_TEXT_BYTES)) {
        throw hostError("PI_TURN_OUTPUT_TOO_LARGE", "Pi response is too large");
      }
      this._finishActive(active, {
        status,
        errorCode: status === "failed" ? (accountBlocked ? "RUNTIME_ACCOUNT_BLOCKED"
          : authenticationFailed ? "AUTH_REQUIRED" : "PI_TURN_FAILED") : null,
        texts,
        usage,
        responseId: responseIdFor(active, assistants),
        provider: safeString(last?.provider, 128) ? last.provider : null,
        model: safeString(last?.model, 512) ? last.model : null,
      });
    } catch (error) {
      this._failActive(active, error);
    }
  }

  _acceptActive(active) {
    if (active.settled || active.accepted) return;
    const timestamp = this.now();
    this.ledger.update((data) => {
      const session = sessionById(data, active.sessionId);
      const turn = turnById(session, active.turnId);
      if (!turn || turn.acceptance !== "unknown") {
        throw hostError("RUNTIME_TURN_RECEIPT_CONFLICT", "Pi receipt is inconsistent");
      }
      turn.acceptance = "accepted";
      turn.updatedAt = Math.max(turn.updatedAt, timestamp);
      session.updatedAt = Math.max(session.updatedAt, timestamp);
    });
    active.accepted = true;
    clearTimeout(active.acceptanceTimer);
    active.acceptanceTimer = null;
    active.acceptance.resolve({ turn: { id: active.turnId, status: "inProgress", items: [] } });
  }

  _finishActive(active, result) {
    if (active.settled || !TERMINAL_STATUSES.has(result.status)) return;
    const timestamp = this.now();
    let messageSequence = 0;
    this.ledger.update((data) => {
      const session = sessionById(data, active.sessionId);
      const turn = turnById(session, active.turnId);
      turn.status = result.status;
      turn.errorCode = result.errorCode;
      turn.assistantMessages = result.texts.map((text) => ({
        id: `pi-message-${active.turnId}-final-${messageSequence += 1}`,
        text,
      }));
      turn.responseId = result.responseId;
      turn.provider = result.provider;
      turn.model = result.model;
      turn.usage = result.usage;
      turn.updatedAt = Math.max(turn.updatedAt, timestamp);
      session.updatedAt = Math.max(session.updatedAt, timestamp);
    });
    active.settled = true;
    this._clearActive(active);
    result.texts.forEach((text, index) => this._publish({
      known: true,
      method: "pi/agent_settled",
      type: "text",
      sessionId: active.sessionId,
      turnId: active.turnId,
      itemId: `pi-message-${active.turnId}-final-${index + 1}`,
      text,
      phase: index === result.texts.length - 1 ? "final_answer" : "commentary",
      delivery: "local",
    }));
    this._publish({
      known: true,
      method: "pi/agent_settled",
      type: "usage",
      sessionId: active.sessionId,
      turnId: active.turnId,
      responseId: result.responseId,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
    });
    this._publish({
      known: true,
      method: "pi/agent_settled",
      type: "complete",
      sessionId: active.sessionId,
      turnId: active.turnId,
      status: result.status,
    });
    active.terminal.resolve({ status: result.status });
    active.process.endInput();
  }

  _failActive(active, error, options = {}) {
    if (active.settled) return;
    const failure = error?.code ? error : hostError("PI_TURN_FAILED", "Pi turn failed");
    const timestamp = this.now();
    const definitelyRejected = options.definitelyRejected === true || !active.promptDispatched;
    const acceptance = active.accepted ? "accepted" : definitelyRejected ? "failed" : "unknown";
    const status = active.interruptRequested ? "interrupted"
      : active.accepted ? "interrupted" : "failed";
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
      this._killActiveProcess(active, "SIGKILL");
      active.acceptance.reject(ledgerFailure);
      active.terminal.resolve({ status: "interrupted" });
      active.settled = true;
      this._clearActive(active);
      active.process?.endInput();
      return;
    }
    if (failure.code === "AUTH_REQUIRED" || AUTH_ERROR_PATTERN.test(active.process?.stderr || "")) {
      this.profileState.auth = null;
      this.profileState.authExpiresAt = 0;
    }
    active.settled = true;
    active.failed = true;
    if (!active.process?.closed) this._killActiveProcess(active, "SIGKILL");
    this._clearActive(active);
    if (!active.accepted) active.acceptance.reject(failure);
    this._publish({
      known: true,
      method: "pi/error",
      type: "complete",
      sessionId: active.sessionId,
      turnId: active.turnId,
      status,
    });
    active.terminal.resolve({ status });
    active.process?.endInput();
  }

  _clearActive(active) {
    clearTimeout(active.acceptanceTimer);
    clearTimeout(active.promptTimer);
    active.acceptanceTimer = null;
    active.promptTimer = null;
    active.promptDeadlineAt = null;
    active.promptTimeoutPaused = false;
    if (active.commandContextFile) {
      const { target, dev, ino } = active.commandContextFile;
      try {
        const stat = validatePrivateStat(this.fs.lstatSync(target), target);
        if (stat.dev === dev && stat.ino === ino) this.fs.unlinkSync(target);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          try { this.onDiagnostic?.({ code: "PI_COMMAND_CONTEXT_CLEANUP_FAILED" }); } catch {}
        }
      }
      active.commandContextFile = null;
    }
    if (active.reservationId) {
      try { this.mcpGateIssuer.revokeMcpServer({ reservationId: active.reservationId }); } catch {}
      active.reservationId = null;
    }
    if (this.activeTurns.get(active.sessionId) === active) this.activeTurns.delete(active.sessionId);
  }

  _onProcessClosed(active, result) {
    if (!active.settled) {
      const auth = AUTH_ERROR_PATTERN.test(`${result?.stderr || ""}`);
      this._failActive(active, hostError(
        auth ? "AUTH_REQUIRED" : "PI_PROCESS_CLOSED",
        auth ? "Pi authentication is required" : "Pi process closed before settlement",
      ), { definitelyRejected: !active.promptDispatched });
    }
    const previous = turnById(sessionById(this.ledger.snapshot(), active.sessionId), active.turnId);
    if (previous?.acceptance !== "unknown" || !TERMINAL_STATUSES.has(previous.status)) return;
    // Preserve the unknown receipt for deduplication, but persist the actual
    // worker exit so a different operation can safely continue this session.
    const timestamp = this.now();
    this.ledger.update((data) => {
      const session = sessionById(data, active.sessionId);
      const turn = turnById(session, active.turnId);
      turn.executionEndedAt = Math.max(turn.createdAt, timestamp);
      turn.updatedAt = Math.max(turn.updatedAt, turn.executionEndedAt);
      session.updatedAt = Math.max(session.updatedAt, turn.updatedAt);
    });
  }

  async _onExtensionRequest(active, request) {
    const permissionMatch = request.method === "confirm" && request.timeout === undefined
      && /^Allow Pi ([a-z][a-z0-9_-]{0,63})\?$/u.exec(request.title || "");
    const toolName = permissionMatch?.[1] || null;
    const approvalMethod = ["edit", "write"].includes(toolName)
      ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval";
    const method = toolName === null ? "mcpServer/elicitation/request" : approvalMethod;
    const handler = this.serverRequestHandlers.get(method);
    if (!handler || active.settled) {
      return { type: "extension_ui_response", id: request.id, cancelled: true };
    }
    if (toolName !== null) {
      this._pausePromptTimeout(active);
      try {
        const params = method === "item/fileChange/requestApproval"
          ? {
            sessionId: active.sessionId,
            turnId: active.turnId,
            itemId: request.id,
            grantRoot: active.cwd,
            reason: request.message || request.title,
            sessionApprovalAvailable: false,
          }
          : {
            sessionId: active.sessionId,
            turnId: active.turnId,
            itemId: request.id,
            command: request.message || request.title,
            cwd: active.cwd,
            reason: request.title,
            sessionApprovalAvailable: false,
          };
        const response = await handler(params, { method, sourceMethod: "extension_ui_request" });
        return {
          type: "extension_ui_response",
          id: request.id,
          confirmed: ["accept", "acceptForSession"].includes(response?.decision),
        };
      } finally {
        this._resumePromptTimeout(active);
      }
    }
    const productConfirmation = request.method === "select" && request.timeout === undefined
      && typeof request.title === "string"
      && request.title.startsWith(PRODUCT_CONFIRMATION_SELECT_PREFIX)
      && Array.isArray(request.options) && request.options.length === 2
      && request.options[0] === "确认执行" && request.options[1] === "取消";
    const fieldId = productConfirmation ? "confirm_product_action" : "answer";
    const title = productConfirmation
      ? request.title.slice(PRODUCT_CONFIRMATION_SELECT_PREFIX.length) : request.title;
    let requestedSchema;
    if (request.method === "select") {
      if (!Array.isArray(request.options) || request.options.length === 0
        || request.options.length > 32 || !request.options.every((item) => safeString(item, 1024))) {
        return { type: "extension_ui_response", id: request.id, cancelled: true };
      }
      requestedSchema = {
        type: "object",
        properties: {
          [fieldId]: { type: "string", title: title || "Choose", enum: request.options },
        },
        required: [fieldId],
      };
    } else if (request.method === "confirm") {
      requestedSchema = {
        type: "object",
        properties: { answer: { type: "string", title: request.title || "Confirm", enum: ["Allow", "Deny"] } },
        required: ["answer"],
      };
    } else {
      requestedSchema = {
        type: "object",
        properties: { answer: { type: "string", title: request.title || "Input" } },
        required: ["answer"],
      };
    }
    if (productConfirmation) this._pausePromptTimeout(active);
    let response;
    try {
      response = await handler({
        sessionId: active.sessionId,
        turnId: active.turnId,
        serverName: "pi",
        mode: "form",
        message: request.message || title || "Pi requires input",
        requestedSchema,
        elicitationId: request.id,
      }, {});
    } finally {
      if (productConfirmation) this._resumePromptTimeout(active);
    }
    if (response?.action !== "accept") {
      return { type: "extension_ui_response", id: request.id, cancelled: true };
    }
    const answer = response.content?.[fieldId];
    if (request.method === "confirm") {
      return { type: "extension_ui_response", id: request.id, confirmed: answer === "Allow" };
    }
    if (!safeString(answer, 64 * 1024, { empty: true })) {
      return { type: "extension_ui_response", id: request.id, cancelled: true };
    }
    return { type: "extension_ui_response", id: request.id, value: answer };
  }

  _recordSessionFile(sessionId, value) {
    if (value === undefined) return;
    if (!safeString(value, 4096) || !path.isAbsolute(value)) {
      throw hostError("PI_SESSION_FILE_INVALID", "Pi session file is invalid");
    }
    const resolved = path.resolve(value);
    const relative = path.relative(this.ledger.sessionDir, resolved);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) {
      throw hostError("PI_SESSION_FILE_INVALID", "Pi session file escapes managed storage");
    }
    this.ledger.update((data) => {
      const session = sessionById(data, sessionId);
      if (!session) throw hostError("RUNTIME_SESSION_NOT_FOUND", "Pi session was not found");
      if (session.sessionFile !== null && session.sessionFile !== resolved) {
        throw hostError("PI_SESSION_FILE_INVALID", "Pi session file binding changed");
      }
      session.sessionFile = resolved;
    });
  }

  _deleteSessionFile(target) {
    const resolved = path.resolve(target);
    const relative = path.relative(this.ledger.sessionDir, resolved);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) {
      throw hostError("PI_SESSION_FILE_INVALID", "Pi session file escapes managed storage");
    }
    try {
      const stat = this.fs.lstatSync(resolved);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("unsafe file");
      const realRoot = this.fs.realpathSync(this.ledger.sessionDir);
      const realTarget = this.fs.realpathSync(resolved);
      const realRelative = path.relative(realRoot, realTarget);
      if (realRelative === "" || realRelative === ".." || realRelative.startsWith(`..${path.sep}`)
        || path.isAbsolute(realRelative)) throw new Error("escaped file");
      this.fs.unlinkSync(resolved);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw hostError("PI_SESSION_DELETE_FAILED", "Pi session file could not be deleted safely");
      }
    }
  }

  async _ensureModelCatalog() {
    const now = this.now();
    if (Array.isArray(this.profileState.models) && this.profileState.modelsExpiresAt > now) {
      return this.profileState.models;
    }
    const rpc = this._spawnControlRpc();
    try {
      const [state, payload] = await Promise.all([
        rpc.request("get_state", {}, { timeoutMs: 30_000 }),
        rpc.request("get_available_models", {}, { timeoutMs: 30_000 }),
      ]);
      const models = validateCatalog(state, payload);
      this.profileState.models = models;
      this.profileState.modelsExpiresAt = now + 5 * 60 * 1000;
      return models;
    } finally {
      rpc.endInput();
      await Promise.race([rpc.closedPromise, delay(this.killGraceMs)]);
      if (!rpc.closed) rpc.kill("SIGKILL");
    }
  }

  async commandsList(input = {}) {
    this._assertReady();
    if (input.sessionId != null) this._requireSession(input.sessionId);
    this._sessionCwd(input.cwd);
    if (this.commandCatalog && this.commandsExpiresAt > this.now()) {
      return { supported: true, reason: null, commands: mergeNativeCommands("pi", this.commandCatalog) };
    }
    const rpc = this._spawnControlRpc({ commands: true });
    try {
      const payload = await rpc.request("get_commands", {}, { timeoutMs: this.requestTimeoutMs });
      const dynamic = normalizeRuntimeCommands((payload?.commands || []).map((entry) => ({
        ...entry, description: entry.description || "", source: `Pi ${entry.source || "runtime"}`,
      })));
      this.commandCatalog = normalizeRuntimeCommands([
        ...PI_RPC_COMMANDS,
        ...dynamic.filter((entry) => !PI_RPC_COMMANDS.some((builtin) => builtin.name === entry.name)),
      ]);
      this.commandsExpiresAt = this.now() + 5_000;
      return { supported: true, reason: null, commands: mergeNativeCommands("pi", this.commandCatalog) };
    } finally {
      rpc.endInput();
      await Promise.race([rpc.closedPromise, delay(this.killGraceMs)]);
      if (!rpc.closed) rpc.kill("SIGKILL");
    }
  }

  async commandExecute(input) {
    this._assertExecutionInstance();
    const catalog = await this.commandsList(input);
    const parsed = requireRuntimeCommand(input?.text, catalog.commands, "pi");
    return { kind: "send", text: parsed.text, warning: null };
  }

  _spawnControlRpc(options = {}) {
    const args = [
      "--mode", "rpc", "--no-session", "--no-tools", "--no-extensions",
      ...(!options.commands ? ["--no-skills", "--no-prompt-templates"] : []),
      "--no-themes", "--no-context-files", "--no-approve", "--offline",
    ];
    if (options.model) {
      const model = parsePiModelRef(options.model);
      if (!model) throw hostError("RUNTIME_MODEL_UNAVAILABLE", "Pi model is unavailable");
      args.push("--provider", model.provider, "--model", model.modelId);
    }
    let child;
    try {
      child = this.spawnProcess(this.binaryPath, args, {
        cwd: options.commands ? (this.workspace || this.userHome) : this.userHome,
        env: this._spawnEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      throw hostError("PI_PROCESS_SPAWN_FAILED", "Pi control RPC could not start");
    }
    const rpc = new PiRpcProcess({
      child,
      requestTimeoutMs: this.requestTimeoutMs,
      maxFrameBytes: this.maxFrameBytes,
      maxStreamBytes: this.maxStreamBytes,
      randomUUID: this.randomUUID,
      onEvent: () => {},
      onFatal: (error) => {
        try { this.onDiagnostic?.({ code: error?.code || "PI_CONTROL_RPC_FAILED" }); } catch {}
      },
    });
    const marker = makeDeferred();
    this.controlProcesses.set(child, marker);
    void rpc.closedPromise.then(() => {
      this.controlProcesses.delete(child);
      marker.resolve();
    }).catch(() => {});
    return rpc;
  }

  _validateModel(model) {
    if (model === undefined || model === null) return null;
    if (!safeString(model, 640) || !parsePiModelRef(model)
      || !this.profileState.models?.some((candidate) => candidate.model === model)) {
      throw hostError("RUNTIME_MODEL_UNAVAILABLE", "Pi model is unavailable");
    }
    return model;
  }

  _sessionCwd(value) {
    const cwd = value === undefined || value === null ? (this.workspace || this.userHome)
      : normalizePiWorkspace(value);
    if (this.workspace !== null && cwd !== this.workspace) {
      throw hostError("PI_WORKSPACE_INVALID", "Pi workspace route changed");
    }
    try {
      const stat = this.fs.lstatSync(cwd);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe cwd");
    } catch {
      throw hostError("PI_WORKSPACE_INVALID", "Pi workspace is unavailable");
    }
    return cwd;
  }

  _assertInputPermissionPolicy(value) {
    return normalizePiPermissionPolicy(value);
  }

  _requireSession(sessionId) {
    if (!safeString(sessionId, 512)) {
      throw hostError("RUNTIME_SESSION_PARAMS_INVALID", "Pi session id is invalid");
    }
    const session = sessionById(this.ledger.snapshot(), sessionId);
    if (!session) throw hostError("RUNTIME_SESSION_NOT_FOUND", "Pi session was not found");
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
    if (parseRuntimeCommand(input.prompt, this.commandCatalog || PI_RPC_COMMANDS)) return input.prompt.trim();
    const config = this.sessionConfigs.get(sessionId);
    const blocks = [];
    if (config?.developerInstructions) {
      blocks.push(`SHOGGOTH DEVELOPER INSTRUCTIONS\n${config.developerInstructions}`);
    }
    if (typeof input.context === "string" && input.context.length > 0) blocks.push(input.context);
    blocks.push(`CURRENT USER REQUEST\n${input.prompt}`);
    return blocks.join("\n\n");
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
    env.PI_CODING_AGENT_DIR = this.runtimeEnvironment.spawnEnv.PI_CODING_AGENT_DIR;
    env.PI_CODING_AGENT_SESSION_DIR = this.ledger?.sessionDir || path.join(this.home, "sessions");
    env.PI_TELEMETRY = "0";
    env.PI_OFFLINE = "1";
    for (const entry of entries) {
      if (!plain(entry) || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(entry.name)
        || !safeString(entry.value, 4096, { empty: true })) {
        throw hostError("PI_MCP_CONFIG_INVALID", "Pi MCP environment is invalid");
      }
      env[entry.name] = entry.value;
    }
    for (const [name, value] of Object.entries(reserved)) {
      if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(name) || !safeString(value, 32 * 1024)) {
        throw hostError("PI_MCP_CONFIG_INVALID", "Pi MCP bridge environment is invalid");
      }
      env[name] = value;
    }
    return env;
  }

  _runControl(args, options = {}) {
    if (!Array.isArray(args) || args.length === 0 || args.some((arg) => !safeString(arg, 4096))) {
      return Promise.reject(hostError("PI_CONTROL_INVALID", "Pi control command is invalid"));
    }
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnProcess(this.binaryPath, args, {
          cwd: this.userHome,
          env: this._spawnEnvironment(),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        reject(hostError("PI_PROCESS_SPAWN_FAILED", "Pi control process failed"));
        return;
      }
      if (!child || typeof child.on !== "function" || !child.stdout || !child.stderr
        || typeof child.kill !== "function") {
        try { child?.kill?.("SIGKILL"); } catch {}
        reject(hostError("PI_PROCESS_SPAWN_FAILED", "Pi control process is invalid"));
        return;
      }
      const marker = makeDeferred();
      this.controlProcesses.set(child, marker);
      let stdout = "";
      let stderr = "";
      let settled = false;
      const append = (current, chunk) => {
        const next = `${current}${Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)}`;
        if (Buffer.byteLength(next, "utf8") > MAX_CONTROL_OUTPUT_BYTES) {
          throw hostError("PI_CONTROL_OUTPUT_TOO_LARGE", "Pi control output is too large");
        }
        return next;
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill("SIGKILL"); } catch {}
        reject(hostError("PI_CONTROL_TIMEOUT", "Pi control command timed out"));
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
      child.on("error", () => fail(hostError("PI_PROCESS_FAILED", "Pi control process failed")));
      child.on("close", (code, signal) => {
        this.controlProcesses.delete(child);
        marker.resolve();
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
    if (this.state !== "ready") throw hostError("PI_RUNTIME_NOT_READY", "Pi runtime is not ready");
  }

  _assertExecutionInstance() {
    this._assertReady();
    if (this.controlInstance) {
      throw hostError("RUNTIME_CAPABILITY_UNSUPPORTED", "Pi control hosts cannot run sessions");
    }
  }
}

module.exports = {
  PiRuntimeHost,
  addUsage,
  piUsage,
  securePiCredentialPresent,
  validateCatalog,
};
