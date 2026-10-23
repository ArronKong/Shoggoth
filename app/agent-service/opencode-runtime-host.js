"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");
const { runtimeBinding } = require("./runtime-adapter");
const { validateResolvedEnvironment } = require("./runtime-account-resolver");
const { openRuntimeLedger, settledRuntimeSession } = require("./runtime-shared-ledger");
const { OpenCodeRuntimeLedger } = require("./opencode-runtime-ledger");
const { OpenCodeHttpClient } = require("./opencode-http-client");
const { IMAGE_TYPES, nativeAttachmentParts, legacyAttachmentText } = require("./opencode-attachments");
const { validateRegisteredSecrets } = require("./codex-rpc-safety");
const { contextToolContent } = require("./context-tool-content");
const { classifyProviderFailure, classifyProviderLimit } = require("./runtime-provider-errors");
const { normalizeRuntimeCommands, parseRuntimeCommand } = require("./runtime-commands");
const { unknownRuntimeContextUsage } = require("./runtime-context-usage");
const { DEFAULT_MCP_TOOL_TIMEOUT_MS } = require("./interactive-timeouts");
const {
  OPENCODE_RUNTIME, normalizeOpenCodePermissionPolicy, normalizeOpenCodeWorkspace,
  openCodeWorkspaceShardId, parseOpenCodeVersion, supportsOpenCodeVersion,
} = require("./opencode-runtime-paths");

const error = (code, message) => serviceError(code, message);
const sleep = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
const safe = (value, max = 512, empty = false) => typeof value === "string"
  && (empty || value.length > 0) && value.isWellFormed() && !value.includes("\0")
  && Buffer.byteLength(value, "utf8") <= max;
const sessionById = (ledger, id) => ledger.sessions.find(session => session.id === id);
const turnById = (session, id) => session?.turns.find(turn => turn.id === id);
const turnByOperation = (session, id) => session?.turns.find(turn => turn.operationId === id);
const MAX_CONTROL_BYTES = 64 * 1024;
const MODEL_LIMIT = 2048;
const OPENCODE_COMMANDS = normalizeRuntimeCommands([{ name: "compact", description: "Compact conversation history",
  source: "OpenCode runtime", execution: "runtime" }]);
const unsupportedFilePart = part => part?.type === "file" && !IMAGE_TYPES.has(part.mime);
const copiedMessageContent = messages => JSON.stringify(messages.map(message => ({
  role: message.info.role, error: message.info.error ?? null,
  parts: message.parts.map(({ id, sessionID, messageID, ...content }) => content),
})));
// Settings sign-in into model providers (OpenCode's own provider auth API).
const LOGIN_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const LOGIN_PROMPT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const LOGIN_PROVIDER_LIMIT = 600;
const LOGIN_CALLBACK_TIMEOUT_MS = 15 * 60_000;

function loginProvider(value) {
  if (typeof value !== "string" || !LOGIN_PROVIDER_ID.test(value)) {
    throw error("RUNTIME_LOGIN_PARAMS_INVALID", "OpenCode provider id is invalid");
  }
  return value;
}

function loginPrompt(value) {
  if (!value || !["text", "select"].includes(value.type) || typeof value.key !== "string"
    || !LOGIN_PROMPT_KEY.test(value.key) || !safe(value.message, 512)) return null;
  const when = value.when && typeof value.when.key === "string" && LOGIN_PROMPT_KEY.test(value.when.key)
    && ["eq", "neq"].includes(value.when.op) && safe(value.when.value, 256, true)
    ? { key: value.when.key, op: value.when.op, value: value.when.value } : null;
  const options = value.type === "select" && Array.isArray(value.options)
    ? value.options.filter(option => safe(option?.label, 256) && safe(option?.value, 256, true)).slice(0, 32)
      .map(option => ({ label: option.label, value: option.value, hint: safe(option.hint, 256) ? option.hint : null }))
    : [];
  if (value.type === "select" && options.length === 0) return null;
  return { type: value.type, key: value.key, message: value.message,
    placeholder: safe(value.placeholder, 256) ? value.placeholder : null, options, when };
}

// A provider without its own methods signs in with an API key. `index` stays
// the position OpenCode expects back.
function loginMethods(raw) {
  const methods = Array.isArray(raw) ? raw : [{ type: "api", label: "API Key" }];
  return methods.slice(0, 8).flatMap((method, index) => (
    !method || !["oauth", "api"].includes(method.type) || !safe(method.label, 256) ? []
      : [{ index, type: method.type, label: method.label,
        prompts: Array.isArray(method.prompts) ? method.prompts.slice(0, 8).map(loginPrompt).filter(Boolean) : [] }]));
}
const OUTCOME_UNKNOWN = "RUNTIME_TURN_OUTCOME_UNKNOWN";
// OpenCode honors provider retry-after for up to days; a retry this far away
// is a limit, not a hiccup, so the turn is stopped instead of held.
const LONG_RETRY_MS = 2 * 60_000;
const STOP_CODES = new Set(["RUNTIME_RATE_LIMITED", "RUNTIME_QUOTA_EXHAUSTED",
  "RUNTIME_UPSTREAM_UNAVAILABLE", "OPENCODE_TURN_TIMEOUT"]);
// Only the private server that accepted a turn can still execute it. The shared
// workspace ledger is reopened only after every host of the previous generation
// stopped, so this liveness is kept per ledger instance and never persisted.
const LIVE_TURNS = new WeakMap();

function fingerprint(input) {
  return crypto.createHash("sha256").update(JSON.stringify({
    prompt: input.prompt, context: input.context ?? null, model: input.model ?? null,
    ...require("./native-instruction-delivery").turnInstructionFingerprint(input),
    cwd: input.cwd ?? null, permissionPolicy: input.permissionPolicy ?? null,
    permissionMode: input.permissionMode ?? null,
    attachments: input.attachments?.map(item => ({ id: item.id, name: item.name,
      mimeType: item.mimeType, size: item.size })) ?? [],
  })).digest("hex");
}

function modelRef(value) {
  if (value === null || value === undefined) return null;
  if (!safe(value, 512) || !value.includes("/")) throw error("RUNTIME_MODEL_UNAVAILABLE", "OpenCode model must be provider/model");
  const slash = value.indexOf("/");
  const providerID = value.slice(0, slash), id = value.slice(slash + 1);
  if (!safe(providerID, 128) || !safe(id, 384)) throw error("RUNTIME_MODEL_UNAVAILABLE", "OpenCode model reference is invalid");
  return { providerID, id };
}

function usageFromTokens(tokens) {
  if (!tokens || typeof tokens !== "object") return null;
  const number = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const inputTokens = number(tokens.input), outputTokens = number(tokens.output);
  const reasoningOutputTokens = number(tokens.reasoning);
  const cachedInputTokens = number(tokens.cache?.read);
  const cacheWriteInputTokens = number(tokens.cache?.write);
  return { inputTokens, outputTokens, reasoningOutputTokens, cachedInputTokens,
    cacheWriteInputTokens, totalTokens: Number.isSafeInteger(tokens.total) && tokens.total >= 0
      ? tokens.total : inputTokens + outputTokens + reasoningOutputTokens };
}

function openCodeRateLimited(value) {
  if (value && typeof value === "object"
    && (value.statusCode === 429 || value.data?.statusCode === 429)) return true;
  const message = typeof value === "string" ? value
    : value?.data?.message ?? value?.message;
  return typeof message === "string" && message.length <= 4096
    && /\brate[\s_-]*limit(?:ed)?\b|\btoo many requests\b/iu.test(message);
}

function openCodeFailureCode(nativeError) {
  if (classifyProviderLimit(nativeError?.data?.responseBody, nativeError?.data?.message,
    nativeError?.message) === "RUNTIME_QUOTA_EXHAUSTED") return "RUNTIME_QUOTA_EXHAUSTED";
  if (openCodeRateLimited(nativeError)) return "RUNTIME_RATE_LIMITED";
  const statusCode = nativeError?.data?.statusCode ?? nativeError?.statusCode;
  if (Number.isInteger(statusCode) && statusCode >= 500 && statusCode <= 599) {
    return "RUNTIME_UPSTREAM_UNAVAILABLE";
  }
  if (classifyProviderFailure(nativeError?.data?.message, nativeError?.message) === "RUNTIME_ATTACHMENT_UNSUPPORTED") {
    return "RUNTIME_ATTACHMENT_UNSUPPORTED";
  }
  return "OPENCODE_TURN_FAILED";
}

function openCodeRetryLimit(status, now, deadline) {
  // OpenCode rewrites free-tier/Go limits to messages without "rate limit" and
  // marks them with action.reason; waiting for those resets cannot help the turn.
  const code = ["free_tier_limit", "account_rate_limit"].includes(status?.action?.reason)
    ? "RUNTIME_QUOTA_EXHAUSTED" : classifyProviderLimit(status?.message);
  const next = Number.isSafeInteger(status?.next) ? status.next : null;
  return { code, giveUp: code === "RUNTIME_QUOTA_EXHAUSTED"
    || (next !== null && (next - now > LONG_RETRY_MS || next >= deadline)) };
}

function aborted(nativeError) { return nativeError?.name === "MessageAbortedError"; }

function projectedSession(session, includeTurns = false) {
  return { id: session.id, source: session.source, cwd: session.cwd, name: session.title,
    archived: session.archived, createdAt: session.createdAt, updatedAt: session.updatedAt,
    ...(includeTurns ? { turns: session.turns.map(turn => ({
      id: turn.id, status: turn.status,
      ...(turn.errorCode ? { errorCode: turn.errorCode } : {}),
      itemsView: "full",
      items: turn.acceptance !== "accepted" ? [] : [
        { type: "userMessage", clientId: turn.operationId },
        ...turn.assistantMessages.map(message => ({ id: message.id, type: "agentMessage",
          text: message.text, phase: "final_answer", delivery: "local" })),
      ],
    })) } : {}) };
}

function nativePermissionRules(policy, workspaceExecutionVersion = null) {
  if (workspaceExecutionVersion === 1) return [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "shoggoth_*", pattern: "*", action: "ask" },
  ];
  const rules = [{ permission: "*", pattern: "*", action: policy.approvalPolicy === "never" ? "deny" : "ask" }];
  if (policy.sandbox === "read-only") rules.push(
    { permission: "edit", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "deny" });
  if (policy.sandbox !== "danger-full-access") rules.push(
    { permission: "external_directory", pattern: "*", action: "deny" });
  return rules;
}

function commandEnvironment(parentEnv, runtimeEnvironment, privateConfig, password, policy, gate, workspaceExecutionVersion = null) {
  const env = Object.create(null);
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "PATH", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy",
    "all_proxy", "no_proxy", "NODE_USE_ENV_PROXY"]) {
    const value = parentEnv[key];
    if (safe(value, 64 * 1024, true)) env[key] = value;
  }
  env.PATH = [...new Set(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
    ...String(env.PATH || "").split(path.delimiter).filter(path.isAbsolute)])].join(path.delimiter);
  env.HOME = runtimeEnvironment.spawnEnv.HOME;
  env.XDG_DATA_HOME = runtimeEnvironment.spawnEnv.XDG_DATA_HOME;
  env.XDG_CONFIG_HOME = path.join(privateConfig, "config");
  env.XDG_CACHE_HOME = path.join(privateConfig, "cache");
  env.XDG_STATE_HOME = path.join(privateConfig, "state");
  env.OPENCODE_SERVER_PASSWORD = password;
  env.OPENCODE_DISABLE_AUTOUPDATE = "1";
  // HOME is the user's real home, so OpenCode would otherwise load the user's
  // Claude Code ~/.claude/CLAUDE.md as global Agent instructions. Grok's Claude
  // rules compatibility is disabled for the same reason.
  env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = "1";
  if (workspaceExecutionVersion === 1) {
    env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
    env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1";
    env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1";
    env.OPENCODE_DISABLE_LSP_DOWNLOAD = "1";
  }
  const permission = { "*": workspaceExecutionVersion === 1 ? "deny"
    : policy.approvalPolicy === "never" ? "deny" : "ask" };
  if (policy.sandbox === "read-only") {
    permission.edit = "deny";
    permission.bash = "deny";
  }
  if (policy.sandbox !== "danger-full-access") permission.external_directory = "deny";
  if (workspaceExecutionVersion === 1) permission["shoggoth_*"] = "ask";
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ autoupdate: false, permission,
    ...(gate ? { mcp: { shoggoth: { type: "local",
      timeout: DEFAULT_MCP_TOOL_TIMEOUT_MS,
      command: [gate.command, ...gate.args],
      environment: Object.fromEntries(gate.env.map(entry => [entry.name, entry.value])),
    } } } : {}),
  });
  return env;
}

// OpenCode names MCP tools `<server>_<tool>`. Only when Shoggoth's injected
// server is the one server whose name starts with "shoggoth" can no other MCP
// server produce a `shoggoth_` tool name.
function answersShoggothToolPrompts(configuration) {
  const servers = configuration?.mcp && typeof configuration.mcp === "object" ? Object.keys(configuration.mcp) : [];
  return servers.includes("shoggoth") && servers.every((name) => name === "shoggoth" || !/^shoggoth/iu.test(name));
}

function modelConnectionConfig(content) {
  // OpenCode accepts JSON with comments and trailing commas. Preserve string
  // bytes (URLs, escaped quotes and credential placeholders included) while
  // removing only JSONC syntax, then retain the model connection fields. Native
  // MCP, hooks/plugins, shell commands and file-based instructions are not part
  // of the model connection and must not execute before the tool guard exists.
  const text = content.toString("utf8").replace(/^\uFEFF/u, "");
  let json = "", quoted = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index], next = text[index + 1];
    if (quoted) {
      json += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; json += char; }
    else if (char === "/" && next === "/") {
      index += 2; while (index < text.length && !/[\r\n]/u.test(text[index])) index++;
      json += "\n";
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) throw error("OPENCODE_NATIVE_CONFIG_INVALID", "Native OpenCode config has an unterminated comment");
      index = end + 1; json += " ";
    } else json += char;
  }
  let prepared = ""; quoted = false; escaped = false;
  for (let index = 0; index < json.length; index++) {
    const char = json[index];
    if (!quoted && char === "," && /^[\s]*[}\]]/u.test(json.slice(index + 1))) continue;
    prepared += char;
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
  }
  let parsed;
  try { parsed = JSON.parse(prepared); } catch { throw error("OPENCODE_NATIVE_CONFIG_INVALID", "Native OpenCode config is malformed"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw error("OPENCODE_NATIVE_CONFIG_INVALID", "Native OpenCode config must be an object");
  return JSON.stringify(Object.fromEntries(["provider", "model", "small_model", "enabled_providers", "disabled_providers"]
    .filter(key => Object.hasOwn(parsed, key)).map(key => [key, parsed[key]]))) + "\n";
}

function preparePrivateOpenCodeConfig(fileSystem, sourceHome, privateConfig, trustedRoot, workspaceExecutionVersion = null) {
  const destination = path.join(privateConfig, "config", "opencode");
  ensurePrivateDirectoryTree(destination, trustedRoot);
  const source = path.join(sourceHome, "opencode");
  let sourceStat;
  try { sourceStat = fileSystem.lstatSync(source); } catch (cause) {
    if (cause?.code !== "ENOENT") throw error("OPENCODE_NATIVE_CONFIG_INVALID", "Native OpenCode config is unavailable");
  }
  if (sourceStat && (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()
    || (typeof process.getuid === "function" && sourceStat.uid !== process.getuid()))) {
    throw error("OPENCODE_NATIVE_CONFIG_INVALID", "Native OpenCode config directory is unsafe");
  }
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const target = path.join(destination, name);
    const original = path.join(source, name);
    let file;
    try { file = fileSystem.openSync(original, fileSystem.constants.O_RDONLY | fileSystem.constants.O_NOFOLLOW); }
    catch (cause) {
      if (cause?.code !== "ENOENT") throw error("OPENCODE_NATIVE_CONFIG_INVALID", "Native OpenCode config file is unsafe");
    }
    if (file === undefined) {
      try { fileSystem.unlinkSync(target); } catch (cause) {
        if (cause?.code !== "ENOENT") throw error("OPENCODE_PRIVATE_CONFIG_INVALID", "Private OpenCode config cannot be updated");
      }
      continue;
    }
    let content;
    try {
      const stat = fileSystem.fstatSync(file);
      if (!stat.isFile() || (typeof process.getuid === "function" && stat.uid !== process.getuid())
        || stat.size > 1024 * 1024) {
        throw error("OPENCODE_NATIVE_CONFIG_INVALID", "Native OpenCode config file is unsafe or too large");
      }
      content = fileSystem.readFileSync(file);
    } finally { fileSystem.closeSync(file); }
    if (workspaceExecutionVersion === 1) content = modelConnectionConfig(content);
    const temporary = path.join(destination, `.${name}.${crypto.randomBytes(8).toString("hex")}.tmp`);
    try {
      fileSystem.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
      fileSystem.renameSync(temporary, target);
    } finally {
      try { fileSystem.unlinkSync(temporary); } catch (cause) { if (cause?.code !== "ENOENT") throw cause; }
    }
  }
}

class OpenCodeRuntimeHost {
  constructor(options = {}) {
    this.paths = options.paths;
    if (!this.paths?.stateDir || !this.paths?.trustedRoot) throw error("OPENCODE_HOST_OPTIONS_INVALID", "OpenCode paths are invalid");
    this.binding = runtimeBinding(options.runtimeBinding);
    if (this.binding.runtime !== OPENCODE_RUNTIME) throw error("RUNTIME_UNSUPPORTED", "OpenCode binding is invalid");
    this.runtimeProfileId = this.binding.runtimeProfileId;
    this.runtimeAccountId = this.binding.runtimeAccountId;
    this.runtimeEnvironment = validateResolvedEnvironment(options.runtimeEnvironment, this.binding);
    this.permissionPolicy = normalizeOpenCodePermissionPolicy(options.permissionPolicy);
    this.workspaceExecutionVersion = options.workspaceExecutionVersion === 1 ? 1 : null;
    this.controlInstance = options.controlInstance === true;
    this.workspace = this.controlInstance ? null : normalizeOpenCodeWorkspace(options.workspace);
    this.mcpExecutionRunId = options.mcpExecutionRunId ?? null;
    this.mcpGateIssuer = options.mcpGateIssuer || null;
    this.ledgerSlot = options.ledgerSlot || { promise: null };
    this.parentEnv = options.parentEnv || process.env;
    this.fs = options.fs || fs;
    this.spawnProcess = options.spawnProcess || spawn;
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.listeners = new Set();
    this.serverRequestHandlers = new Map();
    this.activeTurns = new Map();
    this.compactions = new Set();
    this.sessionConfigs = new Map();
    this.state = "new";
    this.child = null;
    this.childClosed = false;
    this.client = null;
    this.ledger = null;
    this.reservationId = null;
    this.stopPromise = null;
    this.registeredSecrets = [];
    this.terminated = new Promise((resolve, reject) => { this.resolveTerminated = resolve; this.rejectTerminated = reject; });
    this.terminated.catch(() => {});
  }

  async initialize() {
    if (this.state === "ready") return this;
    if (this.state !== "new") throw error("OPENCODE_HOST_STATE_INVALID", "OpenCode host state is invalid");
    this.state = "initializing";
    try {
      const version = await this.#controlVersion();
      if (!supportsOpenCodeVersion(parseOpenCodeVersion(version))) {
        throw error("OPENCODE_VERSION_UNSUPPORTED", "OpenCode 1.18.32 or newer is required");
      }
      const shard = openCodeWorkspaceShardId({ controlInstance: this.controlInstance, workspace: this.workspace });
      this.ledger = await openRuntimeLedger(this.ledgerSlot, () => new OpenCodeRuntimeLedger({
        fs: this.fs, runtimeProfileId: this.runtimeProfileId, runtimeAccountId: this.runtimeAccountId,
        workspaceShardId: shard, stateRoot: path.join(this.paths.stateDir, "runtime-ledgers", "opencode"),
        trustedRoot: this.paths.trustedRoot,
      }).open());
      await this.#startServer(shard);
      this.state = "ready";
      return this;
    } catch (cause) {
      await this.stop().catch(() => {});
      throw cause;
    }
  }

  beginAcquire() { this.#assertReady(); }
  canRetireIdle() {
    return this.state === "ready" && this.activeTurns.size === 0 && this.compactions.size === 0 && this.childClosed === false;
  }
  subscribe(listener) {
    if (typeof listener !== "function") throw error("RUNTIME_EVENT_LISTENER_INVALID", "OpenCode listener is invalid");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  registerServerRequestHandler(method, handler) {
    if (!safe(method, 128) || typeof handler !== "function") throw error("RUNTIME_SERVER_REQUEST_HANDLER_INVALID", "OpenCode handler is invalid");
    this.serverRequestHandlers.set(method, handler);
    return () => { if (this.serverRequestHandlers.get(method) === handler) this.serverRequestHandlers.delete(method); };
  }
  pauseManagedToolTimeout({ sessionId, turnId }) {
    const active = this.activeTurns.get(sessionId);
    if (!active || active.turnId !== turnId || active.done) throw error("RUNTIME_SESSION_BUSY", "OpenCode turn is not active");
    active.managedToolWaitDepth = (active.managedToolWaitDepth || 0) + 1;
    if (active.managedToolWaitDepth === 1) active.managedToolWaitStarted = this.now();
    let released = false;
    return () => {
      if (released) return;
      released = true; active.managedToolWaitDepth--;
      if (active.managedToolWaitDepth === 0) {
        active.managedToolWaitMs = (active.managedToolWaitMs || 0) + Math.max(0, this.now() - active.managedToolWaitStarted);
        active.managedToolWaitStarted = null;
      }
    };
  }
  #publish(event) { for (const listener of this.listeners) { try { listener(event); } catch {} } }
  #assertReady() { if (this.state !== "ready") throw error("RUNTIME_HOST_TERMINATED", "OpenCode host is unavailable"); }
  #assertExecution() { this.#assertReady(); if (this.controlInstance) throw error("RUNTIME_EXECUTION_INSTANCE_REQUIRED", "OpenCode execution host is required"); }
  #cwd(value) {
    const cwd = normalizeOpenCodeWorkspace(value);
    if (cwd !== this.workspace) throw error("RUNTIME_SESSION_NOT_FOUND", "OpenCode workspace does not match");
    return cwd;
  }
  #assertInputPermissionPolicy(value) {
    const policy = normalizeOpenCodePermissionPolicy(value);
    if (policy.approvalPolicy !== this.permissionPolicy.approvalPolicy
      || policy.sandbox !== this.permissionPolicy.sandbox) {
      throw error("RUNTIME_PERMISSION_POLICY_CONFLICT", "OpenCode turn policy changed");
    }
  }
  #requireSession(id) {
    const session = sessionById(this.ledger.snapshot(), id);
    if (!session) throw error("RUNTIME_SESSION_NOT_FOUND", "OpenCode session was not found");
    return session;
  }
  #markLive(turnId) {
    let live = LIVE_TURNS.get(this.ledger);
    if (!live) { live = new Map(); LIVE_TURNS.set(this.ledger, live); }
    live.set(turnId, this);
  }
  // An unresolved receipt stays the fence for its own operation forever, but
  // blocks other operations only while its accepting server may still run it.
  #mayStillRun(turn) { return LIVE_TURNS.get(this.ledger)?.has(turn.id) === true; }
  #markStopped(turnId) {
    const live = LIVE_TURNS.get(this.ledger);
    if (live?.get(turnId) === this) live.delete(turnId);
  }
  #releaseLiveTurns() {
    const live = LIVE_TURNS.get(this.ledger);
    for (const [turnId, owner] of live || []) if (owner === this) live.delete(turnId);
  }

  async authenticationState() {
    this.#assertReady();
    const provider = (await this.client.request("GET", "/provider")).data;
    if (!Array.isArray(provider?.connected) || provider.connected.some(id => typeof id !== "string")) {
      throw error("OPENCODE_PROTOCOL_UNSUPPORTED", "OpenCode provider status protocol is unavailable");
    }
    const configured = provider.connected.length > 0;
    return { authenticated: configured, credentialPresent: configured };
  }

  async modelsList(input = {}) {
    this.#assertReady();
    const [result, configuration] = await Promise.all([
      this.client.request("GET", "/provider").then(response => response.data),
      this.client.request("GET", "/config").then(response => response.data),
    ]);
    if (!Array.isArray(result?.all) || !Array.isArray(result.connected)) {
      throw error("RUNTIME_MODEL_CATALOG_INVALID", "OpenCode provider catalog is invalid");
    }
    const connected = new Set(result.connected);
    const models = [];
    for (const provider of result.all) {
      if (!safe(provider?.id, 128) || !connected.has(provider.id)) continue;
      for (const [id, model] of Object.entries(provider.models || {})) {
        if (!safe(id, 384) || models.length >= MODEL_LIMIT) continue;
        models.push({ model: `${provider.id}/${id}`, displayName: model?.name || `${provider.id}/${id}`,
          description: provider.name || provider.id, isDefault: false,
          hidden: false, contextWindow: Number.isSafeInteger(model?.limit?.context)
            ? model.limit.context : null,
          capabilities: { thinkingOptions: [], thinkingDefault: null, fastTier: null },
        });
      }
    }
    const configured = typeof configuration?.model === "string" ? configuration.model : null;
    const providerDefault = result.connected.map(provider => result.default?.[provider]
      ? `${provider}/${result.default[provider]}` : null).find(Boolean);
    const chosen = models.find(item => item.model === configured)
      || models.find(item => item.model === providerDefault) || models[0];
    if (chosen) { chosen.isDefault = true; models.splice(models.indexOf(chosen), 1); models.unshift(chosen); }
    const offset = input.cursor == null ? 0 : Number(input.cursor), limit = input.limit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || String(offset) !== String(input.cursor ?? offset)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw error("RUNTIME_MODEL_CURSOR_INVALID", "OpenCode model cursor is invalid");
    return { data: models.slice(offset, offset + limit),
      nextCursor: offset + limit < models.length ? String(offset + limit) : null };
  }

  // ---- Settings sign-in into model providers ----
  async providerLoginOptions() {
    this.#assertReady();
    const [catalog, methods] = await Promise.all([
      this.client.request("GET", "/provider").then(response => response.data),
      this.client.request("GET", "/provider/auth").then(response => response.data),
    ]);
    if (!Array.isArray(catalog?.all) || !Array.isArray(catalog.connected)) {
      throw error("RUNTIME_LOGIN_OPTIONS_INVALID", "OpenCode provider catalog is invalid");
    }
    const connected = new Set(catalog.connected);
    return { providers: catalog.all
      .filter(provider => typeof provider?.id === "string" && LOGIN_PROVIDER_ID.test(provider.id))
      .slice(0, LOGIN_PROVIDER_LIMIT)
      .map(provider => ({ id: provider.id, name: safe(provider.name, 256) ? provider.name : provider.id,
        connected: connected.has(provider.id), methods: loginMethods(methods?.[provider.id]) })) };
  }

  async providerLoginAuthorize({ providerId, method, inputs }) {
    this.#assertReady();
    const result = (await this.client.request("POST",
      `/provider/${encodeURIComponent(loginProvider(providerId))}/oauth/authorize`, { method, inputs })).data;
    if (!safe(result?.url, 4096) || !["auto", "code"].includes(result.method)) {
      throw error("RUNTIME_LOGIN_FAILED", "OpenCode returned an invalid authorization");
    }
    return { url: result.url, mode: result.method,
      instructions: safe(result.instructions, 2048, true) ? result.instructions : "" };
  }

  // "auto" waits here until the browser finishes; "code" sends the pasted code.
  async providerLoginCallback({ providerId, method, code, signal }) {
    this.#assertReady();
    const result = (await this.client.request("POST",
      `/provider/${encodeURIComponent(loginProvider(providerId))}/oauth/callback`,
      code === undefined ? { method } : { method, code },
      { signal, timeoutMs: LOGIN_CALLBACK_TIMEOUT_MS })).data;
    return result === true;
  }

  async providerLoginApiKey({ providerId, key, metadata }) {
    this.#assertReady();
    const body = { type: "api", key, ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}) };
    return (await this.client.request("PUT", `/auth/${encodeURIComponent(loginProvider(providerId))}`, body))
      .data === true;
  }

  async sessionStart(input) {
    this.#assertExecution();
    if (!input || !safe(input.source, 256) || !safe(input.developerInstructions ?? "", 1024 * 1024, true)) {
      throw error("RUNTIME_SESSION_PARAMS_INVALID", "OpenCode session input is invalid");
    }
    this.#assertInputPermissionPolicy(input.permissionPolicy);
    this.#cwd(input.cwd);
    const model = modelRef(input.model);
    await this.#assertModelAvailable(input.model);
    const existing = this.ledger.snapshot().sessions.find(session => session.source === input.source);
    if (existing) {
      await this.#ensureNativeSession(existing);
      this.sessionConfigs.set(existing.id, { model: input.model ?? null,
        developerInstructions: input.developerInstructions ?? "" });
      return { session: projectedSession(existing) };
    }
    const now = this.now();
    const response = await this.client.request("POST", "/session", {
      ...(model ? { model } : {}),
      permission: this.#sessionPermissionRules(),
    });
    const id = response.data?.id;
    if (!/^ses_[A-Za-z0-9_-]{8,128}$/u.test(id)
      || response.data?.directory !== this.workspace
      || JSON.stringify(response.data?.permission) !== JSON.stringify(this.#sessionPermissionRules())) {
      throw error("OPENCODE_SESSION_IDENTITY_MISMATCH", "OpenCode created an invalid session");
    }
    const session = { id, source: input.source, cwd: this.workspace, title: null, archived: false,
      created: true, createdAt: now, updatedAt: now, turns: [] };
    this.ledger.update(data => data.sessions.push(session));
    this.sessionConfigs.set(id, { model: input.model ?? null,
      developerInstructions: input.developerInstructions ?? "" });
    return { session: projectedSession(this.#requireSession(id)) };
  }

  #sessionPermissionRules() {
    return nativePermissionRules(this.permissionPolicy, this.workspaceExecutionVersion);
  }

  async #assertModelAvailable(value) {
    const reference = modelRef(value);
    if (!reference) return;
    const provider = (await this.client.request("GET", "/provider")).data;
    const entry = Array.isArray(provider?.all) ? provider.all.find(item => item?.id === reference.providerID) : null;
    if (!Array.isArray(provider?.connected) || !provider.connected.includes(reference.providerID)
      || !entry || !Object.hasOwn(entry.models || {}, reference.id)) {
      throw error("RUNTIME_MODEL_UNAVAILABLE", "OpenCode model is not available from a connected provider");
    }
  }

  async #ensureNativeSession(session) {
    const found = await this.client.request("GET", this.#sessionRoute(session.id));
    const native = found.data;
    if (native?.id !== this.#nativeSessionId(session.id) || native.directory !== session.cwd) {
      throw error("OPENCODE_SESSION_IDENTITY_MISMATCH", "OpenCode session identity changed");
    }
    const desired = this.#sessionPermissionRules(), actual = JSON.stringify(native.permission);
    if (actual !== JSON.stringify(desired)) {
      const guarded = JSON.stringify(nativePermissionRules(this.permissionPolicy, 1));
      const known = ["read-only", "workspace-write", "danger-full-access"].flatMap(sandbox =>
        ["never", "on-request"].map(approvalPolicy => JSON.stringify(nativePermissionRules({ sandbox, approvalPolicy }))));
      // A new Run may enter or leave managed workspace execution. Change only
      // our exact known rules on an idle session; an unknown native policy is
      // still an identity error, and no in-flight native operation is replayed.
      if (!((this.workspaceExecutionVersion === 1 && known.includes(actual)) || actual === guarded)) {
        throw error("OPENCODE_SESSION_IDENTITY_MISMATCH", "OpenCode effective session permissions changed");
      }
      const status = (await this.client.request("GET", "/session/status")).data?.[native.id];
      if (status && status.type !== "idle") throw error("RUNTIME_SESSION_BUSY", "OpenCode session is active");
      const updated = (await this.client.request("PATCH", this.#sessionRoute(session.id), { permission: desired })).data;
      if (updated?.id !== native.id || updated.directory !== session.cwd
        || JSON.stringify(updated.permission) !== JSON.stringify(desired)) {
        throw error("OPENCODE_SESSION_IDENTITY_MISMATCH", "OpenCode did not confirm the managed tool boundary");
      }
      return updated;
    }
    return native;
  }

  #nativeSessionId(sessionId) {
    return this.#requireSession(sessionId).attachmentSessionId ?? sessionId;
  }

  #sessionRoute(sessionId, suffix = "") {
    return `/session/${encodeURIComponent(this.#nativeSessionId(sessionId))}${suffix}`;
  }

  // Older Hosts sent ordinary files as native multimodal parts. OpenCode then
  // carries those parts into every later prompt, even after a failed turn. Only
  // a new, explicit operation may continue: fork the idle session, keep the
  // original history intact and normalize file references in the copy. No model
  // request, tool execution or retry is made while preparing that copy.
  async #prepareAttachmentContinuation(sessionId) {
    const session = this.#requireSession(sessionId);
    if (!session.turns.some(turn => turn.status === "failed"
      && ["OPENCODE_TURN_FAILED", "RUNTIME_ATTACHMENT_UNSUPPORTED"].includes(turn.errorCode))) return;
    await this.#ensureNativeSession(session);
    const nativeId = this.#nativeSessionId(sessionId);
    const statuses = (await this.client.request("GET", "/session/status")).data;
    if (!statuses || typeof statuses !== "object" || Array.isArray(statuses)) {
      throw error("RUNTIME_PROTOCOL_INVALID", "OpenCode session status is invalid");
    }
    if (statuses[nativeId] && statuses[nativeId].type !== "idle") {
      throw error("RUNTIME_SESSION_BUSY", "OpenCode attachment history is still active");
    }
    let messages;
    const hasFiles = () => messages.some(message => message.info.role === "user" && message.parts.some(unsupportedFilePart));
    try {
      messages = await this.#messages(sessionId, null, true);
      if (!hasFiles()) return;
      if (!session.attachmentSessionId) {
        const fork = (await this.client.request("POST", this.#sessionRoute(sessionId, "/fork"), {})).data;
        if (!/^ses_[A-Za-z0-9_-]{8,128}$/u.test(fork?.id) || fork.id === sessionId
          || fork.directory !== session.cwd || this.ledger.snapshot().sessions.some(item =>
            item.id === fork.id || item.attachmentSessionId === fork.id)) {
          throw error("OPENCODE_SESSION_IDENTITY_MISMATCH", "OpenCode attachment copy is invalid");
        }
        const permission = this.#sessionPermissionRules();
        const configured = (await this.client.request("PATCH", `/session/${fork.id}`, { permission })).data;
        if (configured?.id !== fork.id || configured.directory !== session.cwd
          || JSON.stringify(configured.permission) !== JSON.stringify(permission)) {
          throw error("OPENCODE_SESSION_IDENTITY_MISMATCH", "OpenCode attachment copy permissions differ");
        }
        const copied = await this.#messages(sessionId, null, true, fork.id);
        if (copiedMessageContent(copied) !== copiedMessageContent(messages)) {
          throw error("RUNTIME_PROTOCOL_INVALID", "OpenCode attachment copy lost history");
        }
        // Persist before normalizing: an interrupted preparation resumes on the
        // same copy, and cannot execute the unmodified original by accident.
        this.ledger.update(data => { sessionById(data, sessionId).attachmentSessionId = fork.id; });
        messages = copied;
      }
      for (const message of messages.filter(item => item.info.role === "user")) {
        for (const part of message.parts.filter(unsupportedFilePart)) {
          if (!/^prt_[A-Za-z0-9_-]{8,128}$/u.test(part.id)
            || part.messageID !== message.info.id || part.sessionID !== this.#nativeSessionId(sessionId)) {
            throw error("RUNTIME_PROTOCOL_INVALID", "OpenCode attachment part identity differs");
          }
          const text = legacyAttachmentText({ ...part,
            filename: safe(part.filename, 1024) ? part.filename : "attachment",
            mime: safe(part.mime, 256) ? part.mime : "application/octet-stream" });
          const replacement = { id: part.id, sessionID: part.sessionID, messageID: part.messageID, type: "text", text };
          const updated = (await this.client.request("PATCH", this.#sessionRoute(sessionId,
            `/message/${encodeURIComponent(message.info.id)}/part/${encodeURIComponent(part.id)}`), replacement)).data;
          if (updated?.id !== part.id || updated.sessionID !== part.sessionID
            || updated.messageID !== part.messageID || updated.type !== "text" || updated.text !== text) {
            throw error("RUNTIME_PROTOCOL_INVALID", "OpenCode attachment update was not confirmed");
          }
        }
      }
      messages = await this.#messages(sessionId, null, true);
      if (hasFiles()) throw error("RUNTIME_PROTOCOL_INVALID", "OpenCode attachment history is still incompatible");
    } catch {
      throw error("RUNTIME_ATTACHMENT_RECOVERY_REQUIRED", "OpenCode attachment history could not be safely prepared");
    }
  }

  async sessionResume(input) {
    this.#assertExecution();
    this.#assertInputPermissionPolicy(input?.permissionPolicy);
    this.#cwd(input?.cwd);
    const session = this.#requireSession(input?.sessionId);
    if (session.archived) throw error("RUNTIME_SESSION_NOT_FOUND", "OpenCode session is archived");
    await this.#assertModelAvailable(input.model);
    await this.#ensureNativeSession(session);
    this.sessionConfigs.set(session.id, { model: input.model ?? null,
      developerInstructions: input.developerInstructions ?? "" });
    await this.#reconcileSession(session.id);
    const reconciled = this.#requireSession(session.id);
    if (reconciled.turns.some(turn => turn.acceptance === "unknown" && this.#mayStillRun(turn))) {
      throw error("RUNTIME_TURN_ACCEPTANCE_UNKNOWN", "OpenCode turn receipt is unknown");
    }
    if (reconciled.turns.some(turn => turn.errorCode === OUTCOME_UNKNOWN && this.#mayStillRun(turn))) {
      throw error("RUNTIME_TURN_OUTCOME_UNKNOWN", "OpenCode turn outcome is unknown");
    }
    this.#resumePending(session.id);
    return { session: projectedSession(reconciled) };
  }

  async sessionRead(input) {
    const settled = settledRuntimeSession(this, input?.sessionId);
    if (settled) return { session: projectedSession(settled, input?.includeTurns === true) };
    this.#assertReady();
    const session = this.#requireSession(input?.sessionId);
    await this.#reconcileSession(session.id);
    if (!this.controlInstance) this.#resumePending(session.id);
    const updated = this.#requireSession(session.id);
    if (updated.turns.some(turn => turn.acceptance === "unknown" && this.#mayStillRun(turn))) {
      throw error("RUNTIME_TURN_ACCEPTANCE_UNKNOWN", "OpenCode turn receipt is unknown");
    }
    if (updated.turns.some(turn => turn.errorCode === OUTCOME_UNKNOWN && this.#mayStillRun(turn))) {
      throw error("RUNTIME_TURN_OUTCOME_UNKNOWN", "OpenCode turn outcome is unknown");
    }
    return { session: projectedSession(updated, input?.includeTurns === true) };
  }

  sessionList(input = {}) {
    this.#assertReady();
    const offset = input.cursor == null ? 0 : Number(input.cursor), limit = input.limit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || String(offset) !== String(input.cursor ?? offset)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw error("RUNTIME_SESSION_CURSOR_INVALID", "OpenCode session cursor is invalid");
    }
    const sessions = this.ledger.snapshot().sessions.filter(item => item.archived === (input.archived === true))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return { data: sessions.slice(offset, offset + limit).map(projectedSession),
      nextCursor: offset + limit < sessions.length ? String(offset + limit) : null };
  }

  async sessionRename(input) {
    this.#assertReady();
    if (!safe(input?.name, 1024)) throw error("RUNTIME_SESSION_PARAMS_INVALID", "OpenCode title is invalid");
    const session = this.#requireSession(input.sessionId);
    const response = await this.client.request("PATCH", this.#sessionRoute(session.id), { title: input.name });
    if (response.data?.id !== this.#nativeSessionId(session.id)) throw error("OPENCODE_SESSION_IDENTITY_MISMATCH", "OpenCode rename returned another session");
    this.ledger.update(data => { const current = sessionById(data, session.id);
      current.title = input.name; current.updatedAt = Math.max(current.updatedAt, this.now()); });
    return {};
  }
  sessionArchive(input) { return this.#setArchived(input?.sessionId, true); }
  sessionUnarchive(input) { return this.#setArchived(input?.sessionId, false); }
  #setArchived(id, archived) {
    this.#assertReady();
    const session = this.#requireSession(id);
    if (this.activeTurns.has(id)) throw error("RUNTIME_SESSION_BUSY", "OpenCode session is active");
    this.ledger.update(data => { const current = sessionById(data, id);
      current.archived = archived; current.updatedAt = Math.max(current.updatedAt, this.now()); });
    return {};
  }
  async sessionDelete(input) {
    this.#assertReady();
    const session = this.#requireSession(input?.sessionId);
    if (this.activeTurns.has(session.id)) throw error("RUNTIME_SESSION_BUSY", "OpenCode session is active");
    for (const nativeId of new Set([session.attachmentSessionId, session.id].filter(Boolean))) {
      const result = await this.client.request("DELETE", `/session/${encodeURIComponent(nativeId)}`, undefined, { accept: [404] });
      if (result.status !== 404 && result.data !== true) throw error("OPENCODE_SESSION_DELETE_UNCONFIRMED", "OpenCode did not confirm deletion");
    }
    this.ledger.update(data => { data.sessions.splice(data.sessions.findIndex(item => item.id === session.id), 1); });
    this.sessionConfigs.delete(session.id);
    return {};
  }

  commandsList(input = {}) {
    this.#assertReady();
    if (!input || typeof input !== "object" || (input.sessionId !== undefined && input.sessionId !== null && !safe(input.sessionId))) {
      return Promise.reject(error("RUNTIME_COMMAND_PARAMS_INVALID", "OpenCode command catalog input is invalid"));
    }
    if (input.sessionId) this.#requireSession(input.sessionId);
    return Promise.resolve({ supported: true, reason: null, commands: OPENCODE_COMMANDS });
  }

  // `/compact` runs OpenCode's own session summarize outside any turn. The
  // request returns after the compaction finishes; the compacted notice is the
  // completion fact the coordinator waits for.
  async commandExecute(input) {
    this.#assertExecution();
    if (!input || typeof input !== "object" || (input.sessionId !== null && !safe(input.sessionId))
      || !safe(input.text, 64 * 1024)) {
      throw error("RUNTIME_COMMAND_PARAMS_INVALID", "OpenCode command input is invalid");
    }
    const parsed = parseRuntimeCommand(input.text, OPENCODE_COMMANDS);
    if (!parsed) throw error("RUNTIME_COMMAND_NOT_FOUND", "OpenCode command is not available");
    if (parsed.args) throw error("RUNTIME_COMMAND_PARAMS_INVALID", "Usage: /compact");
    if (!input.sessionId) throw error("RUNTIME_COMMAND_SESSION_REQUIRED", "Start the OpenCode conversation before using this command");
    this.#cwd(input.cwd);
    const session = this.#requireSession(input.sessionId);
    if (session.archived) throw error("RUNTIME_SESSION_ARCHIVED", "OpenCode session is archived");
    if (this.activeTurns.has(session.id) || this.compactions.has(session.id)
      || session.turns.some(turn => turn.status === "inProgress")) {
      throw error("RUNTIME_SESSION_BUSY", "OpenCode session is active");
    }
    this.compactions.add(session.id);
    try {
      let model = modelRef(this.sessionConfigs.get(session.id)?.model ?? null);
      if (!model) {
        const last = (await this.#messages(session.id, null)).findLast(message => message.info.role === "assistant"
          && safe(message.info.providerID, 128) && safe(message.info.modelID, 384));
        if (last) model = { providerID: last.info.providerID, id: last.info.modelID };
      }
      if (!model) throw error("RUNTIME_MODEL_UNAVAILABLE", "OpenCode compaction requires a model");
      const response = await this.client.request("POST", this.#sessionRoute(session.id, "/summarize"),
        { providerID: model.providerID, modelID: model.id }, { timeoutMs: 10 * 60_000 });
      if (response.data !== true) throw error("RUNTIME_PROTOCOL_INVALID", "OpenCode summarize response is invalid");
      this.#publish({ known: true, method: "opencode/session.summarize", type: "context_compacted",
        sessionId: session.id, turnId: null,
        contextUsage: unknownRuntimeContextUsage(session.id, { observedAt: this.now(), source: "runtime_event" }) });
      return { kind: "output", text: "OpenCode conversation compacted.", warning: null };
    } finally { this.compactions.delete(session.id); }
  }

  async turnStart(input) {
    this.#assertExecution();
    if (!safe(input?.sessionId) || !safe(input.operationId) || !safe(input.prompt, 1024 * 1024, true)
      || !safe(input.context ?? "", 4 * 1024 * 1024, true)) {
      throw error("RUNTIME_TURN_PARAMS_INVALID", "OpenCode turn input is invalid");
    }
    this.#assertInputPermissionPolicy(input.permissionPolicy);
    this.#cwd(input.cwd);
    const session = this.#requireSession(input.sessionId);
    if (session.archived) throw error("RUNTIME_SESSION_ARCHIVED", "OpenCode session is archived");
    if (this.activeTurns.has(session.id) || this.compactions.has(session.id)) {
      throw error("RUNTIME_SESSION_BUSY", "OpenCode session is active");
    }
    const model = input.model ?? this.sessionConfigs.get(session.id)?.model ?? null;
    await this.#assertModelAvailable(model);
    const hash = fingerprint({ ...input, model });
    await this.#reconcileSession(session.id);
    const currentSession = this.#requireSession(session.id);
    const previous = turnByOperation(currentSession, input.operationId);
    if (previous) {
      if (previous.fingerprint !== hash) throw error("RUNTIME_OPERATION_CONFLICT", "OpenCode operation changed");
      if (previous.acceptance === "unknown") throw error("RUNTIME_TURN_ACCEPTANCE_UNKNOWN", "OpenCode receipt is unknown");
      if (previous.errorCode === "RUNTIME_TURN_OUTCOME_UNKNOWN") {
        throw error("RUNTIME_TURN_OUTCOME_UNKNOWN", "OpenCode turn outcome is unknown");
      }
      if (previous.acceptance === "failed") throw error(previous.errorCode || "OPENCODE_TURN_FAILED", "OpenCode turn failed");
      this.#resumePending(session.id);
      return { turn: { id: previous.id, status: previous.status, items: [] } };
    }
    if (currentSession.turns.some(turn => turn.acceptance === "unknown" && this.#mayStillRun(turn))) {
      throw error("RUNTIME_TURN_ACCEPTANCE_UNKNOWN", "A prior OpenCode turn is unresolved");
    }
    if (currentSession.turns.some(turn => turn.errorCode === OUTCOME_UNKNOWN && this.#mayStillRun(turn))) {
      throw error("RUNTIME_TURN_OUTCOME_UNKNOWN", "A prior OpenCode turn outcome is unresolved");
    }
    if (currentSession.turns.some(turn => turn.status === "inProgress")) {
      throw error("RUNTIME_SESSION_BUSY", "A prior OpenCode turn is still running");
    }
    for (const item of input.attachments || []) {
      if (!safe(item.path, 4096) || !path.isAbsolute(item.path) || !safe(item.name, 1024) || !safe(item.mimeType, 256)) {
        throw error("RUNTIME_ATTACHMENT_INVALID", "OpenCode attachment is invalid");
      }
    }
    // Submitted UTF-8 text can be read even when its private saved copy is
    // outside a restricted workspace. Other files keep scoped references;
    // ordinary MIME types never become native multimodal file inputs.
    const files = nativeAttachmentParts(input.attachments || []);
    await this.#prepareAttachmentContinuation(session.id);
    const now = this.now(), id = `opencode-turn-${this.randomUUID()}`;
    const messageId = `msg_${crypto.randomBytes(16).toString("hex")}`;
    this.ledger.update(data => { const current = sessionById(data, session.id);
      current.turns.push({ id, operationId: input.operationId, fingerprint: hash, messageId,
        acceptance: "unknown", status: "inProgress", errorCode: null, assistantMessages: [],
        createdAt: now, updatedAt: now }); current.updatedAt = Math.max(current.updatedAt, now); });
    const active = { sessionId: session.id, turnId: id, messageId, accepted: false,
      done: false, idle: false, cursor: 0, pending: new Set(), responded: new Set(), usage: null,
      model, abort: new AbortController() };
    this.activeTurns.set(session.id, active);
    try {
      // The per-turn Run ID goes with the user message so the system prompt
      // stays identical across turns unless rules or memory actually change.
      const turn = require("./native-instruction-delivery").splitTurnInstructions(
        require("./native-instruction-delivery").turnInstructions(input));
      const system = [this.sessionConfigs.get(session.id)?.developerInstructions,
        turn.rules, input.context].filter(Boolean).join("\n\n");
      active.dispatched = true;
      this.#markLive(id);
      const response = await this.client.request("POST", this.#sessionRoute(session.id, "/prompt_async"), {
        messageID: messageId,
        ...(model ? { model: { providerID: modelRef(model).providerID,
          modelID: modelRef(model).id } } : {}),
        ...(system ? { system } : {}),
        parts: [{ type: "text", text: input.prompt }, ...(turn.run ? [{ type: "text", text: turn.run }] : []), ...files],
      }, { timeoutMs: 30_000 });
      if (response.status !== 204) {
        throw error("RUNTIME_TURN_ACCEPTANCE_UNKNOWN", "OpenCode prompt receipt is invalid");
      }
      active.accepted = true;
      this.ledger.update(data => { const turn = turnById(sessionById(data, session.id), id);
        turn.acceptance = "accepted"; turn.updatedAt = Math.max(turn.updatedAt, this.now()); });
      void this.#pump(active).catch(cause => this.#failActive(active, cause));
      return { turn: { id, status: "inProgress", items: [] } };
    } catch (cause) {
      if (active.accepted) throw cause;
      const accepted = await this.#reconcileAcceptance(active).catch(() => false);
      if (accepted) {
        active.accepted = true;
        void this.#pump(active).catch(failure => this.#failActive(active, failure));
        return { turn: { id, status: "inProgress", items: [] } };
      }
      this.activeTurns.delete(session.id);
      const definitelyRejected = ["RUNTIME_ATTACHMENT_INVALID", "RUNTIME_ATTACHMENT_UNSUPPORTED",
        "RUNTIME_MODEL_UNAVAILABLE"].includes(cause?.code);
      if (definitelyRejected) this.#markStopped(id);
      this.ledger.update(data => { const turn = turnById(sessionById(data, session.id), id);
        turn.acceptance = definitelyRejected ? "failed" : "unknown";
        turn.status = "failed"; turn.errorCode = definitelyRejected ? cause.code : "RUNTIME_TURN_ACCEPTANCE_UNKNOWN";
        turn.updatedAt = Math.max(turn.updatedAt, this.now()); });
      throw definitelyRejected ? cause : error("RUNTIME_TURN_ACCEPTANCE_UNKNOWN", "OpenCode prompt receipt could not be confirmed");
    }
  }

  async #reconcileAcceptance(active) {
    const route = this.#sessionRoute(active.sessionId, `/message/${active.messageId}`);
    const found = await this.client.request("GET", route, undefined, { accept: [404] });
    if (found.status !== 200 || found.data?.info?.id !== active.messageId) return false;
    this.ledger.update(data => { turnById(sessionById(data, active.sessionId), active.turnId).acceptance = "accepted"; });
    return true;
  }

  async #pump(active) {
    active.textSeen = new Map();
    active.reasoningSeen = new Map();
    active.toolSeen = new Map();
    const deadline = this.now() + 30 * 60_000;
    while (!active.done && this.state === "ready") {
      const messages = await this.#messages(active.sessionId, active.messageId);
      this.#projectMessageParts(active, messages);
      await this.#pollInteractions(active);
      const statuses = (await this.client.request("GET", "/session/status")).data;
      if (!statuses || typeof statuses !== "object" || Array.isArray(statuses)) {
        throw error("RUNTIME_PROTOCOL_INVALID", "OpenCode session status is invalid");
      }
      const nativeStatus = statuses[this.#nativeSessionId(active.sessionId)];
      const status = nativeStatus?.type ?? "idle";
      const currentDeadline = deadline + (active.managedToolWaitMs || 0)
        + (active.managedToolWaitDepth > 0 ? Math.max(0, this.now() - active.managedToolWaitStarted) : 0);
      if (status === "retry") {
        // OpenCode can retry a provider error for a long time without writing
        // a completed assistant message. A short retry keeps the turn with a
        // safe reason; a quota or a far-away retry stops and settles it.
        // Provider text never leaves the host.
        const limit = openCodeRetryLimit(nativeStatus, this.now(), currentDeadline);
        if (limit.giveUp) {
          throw error(limit.code || "RUNTIME_UPSTREAM_UNAVAILABLE", "OpenCode provider retry cannot settle this turn");
        }
        const reason = limit.code === "RUNTIME_RATE_LIMITED" ? limit.code : null;
        if (active.retryReason !== (reason || "retry")) {
          active.retryReason = reason || "retry";
          this.#publish({ known: true, method: "opencode/session.status", type: "status",
            sessionId: active.sessionId, turnId: active.turnId,
            status: "retrying", ...(reason ? { reason } : {}) });
        }
      } else if (active.retryReason) {
        active.retryReason = null;
        this.#publish({ known: true, method: "opencode/session.status", type: "status",
          sessionId: active.sessionId, turnId: active.turnId, status: "running" });
      }
      if (status === "idle" && !(active.managedToolWaitDepth > 0)) {
        await this.#finishFromMessages(active, messages);
        active.idleSince ??= this.now();
        if (!active.done && this.now() - active.idleSince >= 60_000) {
          throw error("RUNTIME_TURN_OUTCOME_UNKNOWN", "OpenCode became idle without a completed assistant message");
        }
      } else active.idleSince = null;
      if (this.now() >= currentDeadline) throw error("OPENCODE_TURN_TIMEOUT", "OpenCode turn did not settle");
      await sleep(250);
    }
  }

  #projectMessageParts(active, messages) {
    const base = { known: true, method: "opencode/session.message", sessionId: active.sessionId,
      turnId: active.turnId };
    for (const message of messages) {
      if (message?.info?.role !== "assistant" || message.info.parentID !== active.messageId) continue;
      if (!Array.isArray(message.parts)) throw error("RUNTIME_PROTOCOL_INVALID", "OpenCode message parts are invalid");
      for (const part of message.parts) {
        if (part?.type === "text" || part?.type === "reasoning") {
          if (!safe(part.id) || !safe(part.text, 8 * 1024 * 1024, true)) continue;
          const cache = part.type === "text" ? active.textSeen : active.reasoningSeen;
          const prior = cache.get(part.id) || "";
          if (!part.text.startsWith(prior)) throw error("RUNTIME_PROTOCOL_INVALID", "OpenCode text part changed non-monotonically");
          const delta = part.text.slice(prior.length);
          cache.set(part.id, part.text);
          if (delta) this.#publish({ ...base, type: part.type === "text" ? "text_delta" : "reasoning_delta",
            itemId: part.id, delta });
        } else if (part?.type === "tool" && safe(part.id) && safe(part.callID)) {
          const previous = active.toolSeen.get(part.id);
          const input = part.state?.input ?? {};
          const inputSignature = JSON.stringify(input);
          const status = part.state?.status;
          const activityTitle = safe(part.state?.title, 256) ? part.state.title : undefined;
          if (!previous) this.#publish({ ...base, type: "tool_start", itemId: part.id,
            toolCallId: part.callID, tool: { name: part.tool, kind: part.tool, input, activityTitle },
            input,
            ...contextToolContent({ input }, this.registeredSecrets) });
          else if ((previous.inputSignature !== inputSignature || previous.activityTitle !== activityTitle)
            && !["completed", "error"].includes(status)) {
            this.#publish({ ...base, type: "tool_update", itemId: part.id, toolCallId: part.callID,
              tool: { name: part.tool, kind: part.tool, input, activityTitle },
              ...contextToolContent({ input }, this.registeredSecrets) });
          }
          if (status !== previous?.status && ["completed", "error"].includes(status)) {
            this.#publish({ ...base, type: "tool_result", itemId: part.id, toolCallId: part.callID,
              tool: { name: part.tool, kind: part.tool, status: status === "error" ? "failed" : "completed",
                input, activityTitle, output: part.state?.output ?? part.state?.error ?? "" },
              output: part.state?.output ?? part.state?.error ?? "",
              ...contextToolContent({ output: part.state?.output ?? part.state?.error ?? "" }, this.registeredSecrets) });
          }
          active.toolSeen.set(part.id, { status, inputSignature, activityTitle });
        }
      }
    }
  }

  async #pollInteractions(active) {
    for (const [kind, method] of [["permission", "item/commandExecution/requestApproval"],
      ["question", "mcpServer/elicitation/request"]]) {
      const result = (await this.client.request("GET", `/${kind}`)).data;
      if (!Array.isArray(result)) throw error("RUNTIME_PROTOCOL_INVALID", "OpenCode interaction list is invalid");
      for (const request of result.filter(item => item?.sessionID === this.#nativeSessionId(active.sessionId))) {
        if (!safe(request?.id) || active.pending.has(request.id) || active.responded.has(request.id)) continue;
        active.pending.add(request.id);
        void this.#replyInteraction(active, kind, method, request).catch(cause => {
          this.#failActive(active, cause);
        }).finally(() => active.pending.delete(request.id));
      }
    }
  }

  async #replyInteraction(active, kind, method, request) {
    if (kind === "permission") {
      // Shoggoth's own product tools are admitted by their per-run lease and
      // approval flow; the runtime prompt would only duplicate that decision.
      // "once" only: OpenCode saves an "always" reply for the whole project.
      if (!active.done && this.answersShoggothToolPrompts
        && typeof request.permission === "string" && request.permission.startsWith("shoggoth_")) {
        await this.client.request("POST", `/permission/${request.id}/reply`, { reply: "once" });
        active.responded.add(request.id);
        return;
      }
      const action = safe(request.permission, 128) ? request.permission : "tool";
      const resource = Array.isArray(request.patterns) ? request.patterns.join("\n").slice(0, 16 * 1024) : "";
      const fileChange = action === "edit";
      const routedMethod = fileChange ? "item/fileChange/requestApproval" : method;
      const handler = this.serverRequestHandlers.get(routedMethod);
      // The permission names the tool; its patterns are the command, URL or path.
      const argument = { bash: "command", webfetch: "url", edit: "path", external_directory: "path" }[action] || "pattern";
      const toolInput = resource ? { [argument]: resource } : undefined;
      let decision = "reject";
      if (handler && !active.done) {
        try {
          const reply = await handler(fileChange ? {
            sessionId: active.sessionId, turnId: active.turnId, itemId: request.id,
            grantRoot: this.workspace, toolName: action, ...(toolInput ? { toolInput } : {}),
            sessionApprovalAvailable: false,
          } : {
            sessionId: active.sessionId, turnId: active.turnId, itemId: request.id,
            ...(action === "bash" && resource ? { command: resource } : {}), cwd: this.workspace,
            toolName: action, ...(toolInput ? { toolInput } : {}), sessionApprovalAvailable: false,
          }, { method: routedMethod, sourceMethod: "opencode.permission" });
          if (["accept", "acceptForSession"].includes(reply?.decision)) decision = "once";
        } catch {}
      }
      await this.client.request("POST", `/permission/${request.id}/reply`,
        { reply: decision });
      active.responded.add(request.id);
      return;
    }
    const questions = Array.isArray(request.questions) ? request.questions : [];
    const properties = {}, required = [];
    for (let index = 0; index < Math.min(questions.length, 16); index += 1) {
      const question = questions[index];
      const key = `answer${index}`;
      const options = Array.isArray(question.options)
        ? question.options.map(option => option?.label).filter(label => safe(label, 1024)) : [];
      properties[key] = { type: "string", title: question.question || question.header || "Answer",
        ...(options.length && question.custom !== true ? { enum: options } : {}) };
      required.push(key);
    }
    const handler = this.serverRequestHandlers.get(method);
    let response = null;
    if (handler && required.length) try {
      response = await handler({ sessionId: active.sessionId, turnId: active.turnId,
        serverName: "opencode", mode: "form", message: "OpenCode requires input",
        requestedSchema: { type: "object", properties, required }, elicitationId: request.id }, {});
    } catch {}
    if (response?.action !== "accept") {
      await this.client.request("POST", `/question/${request.id}/reject`, {});
      active.responded.add(request.id);
      return;
    }
    const answers = required.map(key => [String(response.content?.[key] ?? "")]);
    await this.client.request("POST", `/question/${request.id}/reply`,
      { answers });
    active.responded.add(request.id);
  }

  async #messages(sessionId, targetMessageId, all = false, nativeId = this.#nativeSessionId(sessionId)) {
    const messages = [];
    let before = null;
    for (let page = 0; page < 20; page += 1) {
      const route = `/session/${encodeURIComponent(nativeId)}/message?limit=100${before ? `&before=${encodeURIComponent(before)}` : ""}`;
      const batch = (await this.client.request("GET", route)).data;
      if (!Array.isArray(batch) || batch.length > 100
        || batch.some(message => message?.info?.sessionID !== nativeId
          || !safe(message.info.id) || !Array.isArray(message.parts))) {
        throw error("RUNTIME_PROTOCOL_INVALID", "OpenCode messages are invalid");
      }
      if (!batch.length) return messages;
      messages.unshift(...batch);
      if (!all && (!targetMessageId || batch.some(message => message.info.id === targetMessageId))) return messages;
      const next = batch[0].info.id;
      if (next === before) throw error("RUNTIME_PROTOCOL_INVALID", "OpenCode message cursor did not advance");
      before = next;
      if (batch.length < 100) return messages;
    }
    throw error("OPENCODE_MESSAGE_HISTORY_LIMIT", "OpenCode turn history exceeds reconciliation limit");
  }

  async #finishFromMessages(active, messages) {
    const userIndex = messages.findIndex(message => message.info.id === active.messageId
      && message.info.role === "user");
    if (userIndex < 0) return;
    const subsequent = messages.slice(userIndex + 1).filter(message => message.info.role === "assistant"
      && message.info.parentID === active.messageId);
    const last = subsequent.at(-1);
    if (!last || !Number.isSafeInteger(last.info.time?.completed)) return;
    const texts = subsequent.flatMap(message => (message.parts || []).filter(item => item.type === "text"
      && typeof item.text === "string").map(item => ({ id: item.id || message.info.id, text: item.text })));
    const status = aborted(last.info.error) ? "interrupted" : last.info.error ? "failed" : "completed";
    const timestamp = this.now();
    this.ledger.update(data => { const session = sessionById(data, active.sessionId);
      const turn = turnById(session, active.turnId);
      turn.acceptance = "accepted"; turn.status = status;
      turn.errorCode = status === "failed" ? openCodeFailureCode(last.info.error) : null;
      turn.assistantMessages = texts;
      turn.updatedAt = Math.max(turn.updatedAt, timestamp);
      session.updatedAt = Math.max(session.updatedAt, timestamp); });
    active.done = true;
    this.#markStopped(active.turnId);
    this.activeTurns.delete(active.sessionId);
    for (const message of texts) this.#publish({ known: true, method: "opencode/session.message",
      type: "text", sessionId: active.sessionId, turnId: active.turnId,
      itemId: message.id, text: message.text, phase: "final_answer", delivery: "local" });
    const usage = usageFromTokens(last.info.tokens) || active.usage;
    if (usage) this.#publish({ known: true, method: "opencode/session.message", type: "usage",
      sessionId: active.sessionId, turnId: active.turnId,
      responseId: last.info.id, provider: last.info.providerID, model: last.info.modelID,
      usage, ...(typeof last.info.cost === "number" ? { costUsd: last.info.cost } : {}) });
    this.#publish({ known: true, method: "opencode/session.message", type: "complete",
      sessionId: active.sessionId, turnId: active.turnId, status });
  }

  async #reconcileSession(sessionId) {
    const session = this.#requireSession(sessionId);
    if (!session.turns.some(turn => turn.status === "inProgress" || turn.acceptance === "unknown"
      || turn.errorCode === "RUNTIME_TURN_OUTCOME_UNKNOWN")) return;
    const unresolved = session.turns.find(turn => turn.status === "inProgress" || turn.acceptance === "unknown"
      || turn.errorCode === "RUNTIME_TURN_OUTCOME_UNKNOWN");
    const messages = await this.#messages(sessionId, unresolved.messageId);
    for (const turn of session.turns.filter(item => item.status === "inProgress" || item.acceptance === "unknown"
      || item.errorCode === "RUNTIME_TURN_OUTCOME_UNKNOWN")) {
      const index = messages.findIndex(message => message.info.id === turn.messageId && message.info.role === "user");
      if (index < 0) continue;
      const end = messages.findIndex((message, offset) => offset > index && message.info.role === "user");
      const slice = messages.slice(index + 1, end < 0 ? undefined : end);
      const assistants = slice.filter(message => message.info.role === "assistant"
        && message.info.parentID === turn.messageId);
      const last = assistants.at(-1);
      const completed = last && Number.isSafeInteger(last.info.time?.completed);
      if (completed) this.#markStopped(turn.id);
      this.ledger.update(data => { const current = turnById(sessionById(data, sessionId), turn.id);
        current.acceptance = "accepted";
        if (completed) {
          current.status = aborted(last.info.error) ? "interrupted" : last.info.error ? "failed" : "completed";
          current.errorCode = current.status === "failed" ? openCodeFailureCode(last.info.error) : null;
          current.assistantMessages = assistants.flatMap(message => (message.parts || [])
            .filter(item => item.type === "text" && typeof item.text === "string")
            .map(item => ({ id: item.id || message.info.id, text: item.text })));
        }
        current.updatedAt = Math.max(current.updatedAt, this.now()); });
    }
  }

  #resumePending(sessionId) {
    if (this.activeTurns.has(sessionId)) return;
    const session = this.#requireSession(sessionId);
    const pending = session.turns.find(turn => turn.acceptance === "accepted" && turn.status === "inProgress");
    if (!pending) return;
    const active = { sessionId, turnId: pending.id, messageId: pending.messageId,
      accepted: true, done: false, pending: new Set(), responded: new Set(),
      usage: null, abort: new AbortController() };
    this.activeTurns.set(sessionId, active);
    void this.#pump(active).catch(cause => this.#failActive(active, cause));
  }

  #failActive(active, cause) {
    if (active.done) return;
    active.done = true;
    active.abort.abort();
    // A turn this server accepted is stopped natively first, so its own history
    // proves how it ended and later operations need not wait for it.
    if (active.dispatched && active.accepted && this.state === "ready") {
      void this.#stopAndSettle(active, cause);
      return;
    }
    this.#settleUnknown(active);
  }

  async #stopAndSettle(active, cause) {
    try {
      const response = await this.client.request("POST", this.#sessionRoute(active.sessionId, "/abort"), {},
        { timeoutMs: 5000 });
      if (response.data === true && await this.#waitIdle(active.sessionId)
        && await this.#settleStopped(active, cause)) return;
    } catch {}
    this.#settleUnknown(active);
  }

  async #waitIdle(sessionId) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const statuses = (await this.client.request("GET", "/session/status")).data;
      const nativeId = this.#nativeSessionId(sessionId);
      if (!statuses?.[nativeId] || statuses[nativeId].type === "idle") return true;
      await sleep(100);
    }
    return false;
  }

  async #settleStopped(active, cause) {
    const messages = await this.#messages(active.sessionId, active.messageId);
    const userIndex = messages.findIndex(message => message.info.id === active.messageId
      && message.info.role === "user");
    if (userIndex < 0) return false;
    const subsequent = messages.slice(userIndex + 1).filter(message => message.info.role === "assistant"
      && message.info.parentID === active.messageId);
    const last = subsequent.at(-1);
    const nativeError = last?.info.error ?? null;
    if (last && Number.isSafeInteger(last.info.time?.completed) && !nativeError) {
      await this.#finishFromMessages(active, messages);
      return true;
    }
    const errorCode = STOP_CODES.has(cause?.code) ? cause.code
      : nativeError && !aborted(nativeError) ? openCodeFailureCode(nativeError) : null;
    const status = errorCode && errorCode !== "OPENCODE_TURN_TIMEOUT" ? "failed" : "interrupted";
    const texts = subsequent.flatMap(message => (message.parts || []).filter(item => item.type === "text"
      && typeof item.text === "string").map(item => ({ id: item.id || message.info.id, text: item.text })));
    const timestamp = this.now();
    this.ledger.update(data => { const session = sessionById(data, active.sessionId);
      const turn = turnById(session, active.turnId);
      turn.acceptance = "accepted"; turn.status = status; turn.errorCode = errorCode;
      turn.assistantMessages = texts;
      turn.updatedAt = Math.max(turn.updatedAt, timestamp);
      session.updatedAt = Math.max(session.updatedAt, timestamp); });
    this.#markStopped(active.turnId);
    this.activeTurns.delete(active.sessionId);
    for (const message of texts) this.#publish({ known: true, method: "opencode/session.message",
      type: "text", sessionId: active.sessionId, turnId: active.turnId,
      itemId: message.id, text: message.text, phase: "final_answer", delivery: "local" });
    const usage = usageFromTokens(last?.info.tokens) || active.usage;
    if (usage && last) this.#publish({ known: true, method: "opencode/session.message", type: "usage",
      sessionId: active.sessionId, turnId: active.turnId,
      responseId: last.info.id, provider: last.info.providerID, model: last.info.modelID,
      usage, ...(typeof last.info.cost === "number" ? { costUsd: last.info.cost } : {}) });
    this.#publish({ known: true, method: "opencode/session.message", type: "complete",
      sessionId: active.sessionId, turnId: active.turnId, status, ...(errorCode ? { errorCode } : {}) });
    return true;
  }

  #settleUnknown(active) {
    this.activeTurns.delete(active.sessionId);
    // A transport failure cannot prove acceptance or completion. Only native
    // message reconciliation may clear this state; never send this turn again.
    const code = active.accepted ? OUTCOME_UNKNOWN : "RUNTIME_TURN_ACCEPTANCE_UNKNOWN";
    try { this.ledger.update(data => { const turn = turnById(sessionById(data, active.sessionId), active.turnId);
      turn.status = "failed"; turn.acceptance = active.accepted ? "accepted" : "unknown";
      turn.errorCode = code; turn.updatedAt = Math.max(turn.updatedAt, this.now()); }); }
    catch { /* The failure event still releases Service waiters; ledger recovery remains conservative. */ }
    this.#publish({ known: true, type: "complete", method: "opencode/failed",
      sessionId: active.sessionId, turnId: active.turnId, status: "failed", errorCode: code });
  }

  async turnSteer(input) {
    throw error("RUNTIME_CAPABILITY_UNSUPPORTED", "OpenCode V1 turn steering is unavailable");
  }

  async turnInterrupt(input) {
    this.#assertReady();
    const session = this.#requireSession(input?.sessionId);
    const turn = turnById(session, input?.turnId);
    if (!turn) throw error("RUNTIME_TURN_STALE", "OpenCode turn is stale");
    const active = this.activeTurns.get(session.id);
    if (!active || active.turnId !== turn.id) {
      if (["interrupted", "canceled"].includes(turn.status)) return {};
      throw error("RUNTIME_TURN_NOT_ACTIVE", "OpenCode turn is not active");
    }
    // A failing turn is already being stopped natively and settles on its own.
    if (active.done) return {};
    const response = await this.client.request("POST", this.#sessionRoute(session.id, "/abort"), {});
    if (response.data !== true) throw error("RUNTIME_TURN_CANCEL_UNKNOWN", "OpenCode did not accept interruption");
    if (!await this.#waitIdle(session.id)) throw error("RUNTIME_TURN_CANCEL_UNKNOWN", "OpenCode did not become idle");
    active.done = true;
    active.abort.abort();
    this.#markStopped(turn.id);
    this.activeTurns.delete(session.id);
    this.ledger.update(data => { const current = turnById(sessionById(data, session.id), turn.id);
      current.status = "interrupted"; current.updatedAt = Math.max(current.updatedAt, this.now()); });
    this.#publish({ known: true, type: "complete", method: "opencode/interrupt", sessionId: session.id,
      turnId: turn.id, status: "interrupted" });
    return {};
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      if (this.state === "stopped") return;
      this.state = "stopping";
      for (const active of this.activeTurns.values()) { active.abort.abort(); this.#failActive(active,
        error("RUNTIME_HOST_TERMINATED", "OpenCode host stopped")); }
      if (this.reservationId) try { this.mcpGateIssuer.revokeMcpServer({ reservationId: this.reservationId }); } catch {}
      if (this.child && !this.childClosed) {
        try { process.kill(-this.child.pid, "SIGTERM"); } catch {}
        await Promise.race([this.terminated.catch(() => {}), sleep(3000)]);
        if (!this.childClosed) {
          try { process.kill(-this.child.pid, "SIGKILL"); } catch {}
          await Promise.race([this.terminated.catch(() => {}), sleep(2000)]);
        }
        if (!this.childClosed) throw error("OPENCODE_PROCESS_CLOSE_TIMEOUT", "OpenCode process did not terminate");
      }
      this.#releaseLiveTurns();
      this.state = "stopped";
      if (!this.child) this.resolveTerminated();
    })();
    return this.stopPromise;
  }

  async #controlVersion() {
    const binary = this.runtimeEnvironment.binaryPath;
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(binary, ["--version"], { cwd: this.runtimeEnvironment.spawnEnv.HOME,
        env: { HOME: this.runtimeEnvironment.spawnEnv.HOME, PATH: this.parentEnv.PATH || "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
      timer.unref?.();
      child.stdout.on("data", chunk => { output += chunk;
        if (Buffer.byteLength(output) > MAX_CONTROL_BYTES) child.kill("SIGKILL"); });
      child.once("error", cause => { clearTimeout(timer); reject(error("OPENCODE_VERSION_PROBE_FAILED", String(cause?.code || "OpenCode version probe failed"))); });
      child.once("close", code => { clearTimeout(timer);
        if (code === 0) resolve(output.trim());
        else reject(error("OPENCODE_VERSION_PROBE_FAILED", "OpenCode version probe failed")); });
    });
  }

  async #startServer(shard) {
    const privateConfig = path.join(this.paths.stateDir, "runtime-integration", "opencode",
      this.runtimeAccountId, this.runtimeProfileId, shard);
    ensurePrivateDirectoryTree(privateConfig, this.paths.trustedRoot);
    for (const name of ["cache", "state"]) {
      ensurePrivateDirectoryTree(path.join(privateConfig, name), this.paths.trustedRoot);
    }
    preparePrivateOpenCodeConfig(this.fs, this.runtimeEnvironment.configSourceHome,
      privateConfig, this.paths.trustedRoot, this.workspaceExecutionVersion);
    const password = crypto.randomBytes(32).toString("hex");
    let gate = null;
    if (!this.controlInstance && this.mcpGateIssuer) {
      gate = this.mcpGateIssuer.reserveMcpServer({ runtimeProfileId: this.runtimeProfileId,
        runtimeAccountId: this.runtimeAccountId, executionRunId: this.mcpExecutionRunId,
        parentExecutable: this.runtimeEnvironment.binaryPath,
        toolExposure: require("./product-tool-exposure").toolExposureFor("opencode") });
      this.reservationId = gate.reservationId;
    }
    const env = commandEnvironment(this.parentEnv, this.runtimeEnvironment, privateConfig, password,
      this.permissionPolicy, gate, this.workspaceExecutionVersion);
    this.registeredSecrets = validateRegisteredSecrets([password,
      ...(gate?.env || []).filter(entry => /(?:authorization|credential|nonce|password|secret|token|api[_-]?key)/iu
        .test(entry.name) && typeof entry.value === "string" && Buffer.byteLength(entry.value, "utf8") >= 4)
        .map(entry => entry.value)]);
    const cwd = this.workspace || this.runtimeEnvironment.spawnEnv.HOME;
    const child = this.spawnProcess(this.runtimeEnvironment.binaryPath,
      ["serve", "--hostname", "127.0.0.1", "--port", "0", "--pure"],
      { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    let spawnError = null;
    child.once("error", cause => { spawnError = cause; });
    if (gate && Number.isSafeInteger(child.pid)) {
      this.mcpGateIssuer.bindMcpServer({ reservationId: gate.reservationId, parentPid: child.pid });
    }
    let output = "";
    child.stdout.on("data", chunk => { output = (output + chunk).slice(-MAX_CONTROL_BYTES); });
    child.stderr.on("data", () => {});
    child.once("close", () => {
      this.childClosed = true;
      this.resolveTerminated();
      if (this.state === "ready") {
        this.state = "stopped";
        for (const active of this.activeTurns.values()) this.#failActive(active,
          error("RUNTIME_CONNECTION_LOST", "OpenCode process closed"));
      }
      // Nothing this server accepted can run any more; unresolved receipts
      // remain fences for their own operations only.
      this.#releaseLiveTurns();
    });
    const deadline = this.now() + 20_000;
    while (this.now() < deadline && child.exitCode === null && child.signalCode === null) {
      if (spawnError) throw error("OPENCODE_SERVER_START_FAILED", "OpenCode process could not spawn");
      const address = output.match(/http:\/\/127\.0\.0\.1:\d+/u)?.[0];
      if (address) {
        const invalidAuthorization = Buffer.from(`opencode:${crypto.randomBytes(32).toString("hex")}`).toString("base64");
        const unauthenticated = await fetch(`${address}/config`, { redirect: "error",
          headers: { Authorization: `Basic ${invalidAuthorization}` } });
        try {
          if (unauthenticated.status !== 401) {
            throw error("OPENCODE_HANDSHAKE_FAILED", "OpenCode private server did not require its password");
          }
        } finally { try { await unauthenticated.body?.cancel(); } catch {} }
        const client = new OpenCodeHttpClient({ url: address, password });
        const health = await client.request("GET", "/global/health");
        if (health.status !== 200) throw error("OPENCODE_HANDSHAKE_FAILED", "OpenCode health check failed");
        const doc = await client.request("GET", "/doc");
        if (!doc.data?.paths?.["/session/{sessionID}/prompt_async"]
          || !doc.data?.paths?.["/session/{sessionID}/message"]
          || !doc.data?.paths?.["/permission/{requestID}/reply"]) {
          throw error("OPENCODE_PROTOCOL_UNSUPPORTED", "OpenCode V1 session protocol is unavailable");
        }
        const configuration = (await client.request("GET", "/config")).data;
        if (configuration?.permission?.["*"] !== (this.workspaceExecutionVersion === 1
          || this.permissionPolicy.approvalPolicy === "never" ? "deny" : "ask")
          || (this.workspaceExecutionVersion === 1 && configuration.permission["shoggoth_*"] !== "ask")) {
          throw error("OPENCODE_PERMISSION_UNSAFE", "OpenCode effective tool permissions differ from Shoggoth policy");
        }
        if (this.workspaceExecutionVersion === 1 && Object.keys(configuration?.mcp || {}).some(name => name !== "shoggoth")) {
          throw error("WORKSPACE_RUNTIME_GUARD_UNSAFE", "OpenCode loaded an unmanaged native MCP server");
        }
        this.answersShoggothToolPrompts = answersShoggothToolPrompts(configuration);
        this.client = client;
        return;
      }
      await sleep(100);
    }
    throw error("OPENCODE_SERVER_START_FAILED", "OpenCode private server did not start");
  }
}

module.exports = { OpenCodeRuntimeHost, answersShoggothToolPrompts, commandEnvironment, modelRef,
  usageFromTokens, preparePrivateOpenCodeConfig, nativePermissionRules, modelConnectionConfig };
