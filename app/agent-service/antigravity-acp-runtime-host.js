"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { AcpJsonlClient } = require("./acp-jsonl-client");
const { imageAttachments } = require("./chat-attachments");
const { safeSnapshot } = require("./codex-event-snapshot");
const { contextToolContent } = require("./context-tool-content");
const { getModelCatalogCache, modelCatalogIdentity } = require("./model-catalog-cache");
const { mergeNativeCommands, requireRuntimeCommand } = require("./native-cli-commands");
const { runtimeBinding } = require("./runtime-adapter");
const { validateResolvedEnvironment } = require("./runtime-account-resolver");
const { normalizeRuntimeCommands, parseRuntimeCommand } = require("./runtime-commands");
const { classifyProviderLimit } = require("./runtime-provider-errors");
const { runtimeSessionResumeError } = require("./runtime-stage-error");
const { classifyAntigravitySessionRemoteError, isTransientAntigravitySessionError,
  recordAntigravitySessionDiagnostic } = require("./antigravity-session-diagnostics");
const { openRuntimeLedger, settledRuntimeSession } = require("./runtime-shared-ledger");
const { serviceError } = require("./security");
const {
  ANTIGRAVITY_RUNTIME,
  antigravityWorkspaceShardId,
  normalizeAntigravityPermissionPolicy,
  normalizeAntigravityWorkspace,
  prepareAntigravityKeychainContextAsync,
} = require("./antigravity-runtime-paths");
const { verifyAntigravityAcpServer } = require("./antigravity-acp-distribution");
const { antigravityAcpAuthType, prepareAntigravityAcpHome } = require("./antigravity-runtime-config");
const { AntigravityAcpRuntimeLedger } = require("./antigravity-acp-runtime-ledger");
const { AntigravityNativeToolResults, nativeToolCall } = require("./antigravity-native-tool-results");
const { prepareAntigravityWorkspaceExecution, antigravityWorkspaceSessionMeta } = require("./antigravity-workspace-execution");

const ACP_NAMING = Object.freeze({
  codePrefix: "ANTIGRAVITY_ACP",
  protocolLabel: "Antigravity ACP",
  runtimeName: "Antigravity",
});
const PARENT_ENV_ALLOWLIST = Object.freeze([
  "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
]);
const STOP_REASONS = new Set(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]);
const TURN_ACCEPTANCE_UPDATE_KINDS = new Set([
  "user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan",
]);
const PERMISSION_KINDS = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);
// The server titles tool calls as sentences ("Run view_file?", "Running view_file");
// MCP tools arrive as "<server>_<tool>" with the parts in _meta.mcp.
const ACP_TOOL_TITLE = /^(?:Run|Running|Ran)\s+([A-Za-z][A-Za-z0-9_.-]{0,127})\??$/u;
const MCP_NAME_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
// PascalCase inputs with a well-known meaning, renamed to the keys the UI reads.
const ACP_ARGUMENT_KEYS = Object.freeze({
  Url: "url", Uri: "url", AbsolutePath: "path", TargetFile: "path", FilePath: "path", File: "path",
  Path: "path", DirectoryPath: "path", SearchPath: "path", SearchDirectory: "path",
  CommandLine: "command", Command: "command", Cwd: "cwd", Query: "query", SearchQuery: "query",
  Pattern: "pattern", ServerName: "server",
});
const WRITE_TOOL_KINDS = new Set(["edit", "delete", "move", "execute"]);
const ACP_MODES = Object.freeze({ ask: "default", "auto-review": "default", plan: "default", "accept-edits": "auto_edit", full: "yolo" });
const CANCELLED_NOTICE = "The request was cancelled by the client.";
const HIDDEN_COMMANDS = new Set(["logout"]);
const CATALOG_SOURCE = "shoggoth-model-catalog";
const MAX_ASSISTANT_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_TOOL_RESULT_BYTES = 8 * 1024 * 1024;
const STDERR_TAIL_LINES = 40;
const STDERR_SETTLE_MS = 100;
// Server log markers. Only in-process classification reads them; the raw text
// never reaches product events, the ledger or the UI.
const LOGIN_FLOW_PATTERN = /Credentials missing or invalid|Launching browser login flow|Open the following link to authenticate/u;
const PROMPT_ERROR_PATTERN = /Antigravity SDK error processing prompt for session ([0-9A-Za-z-]{1,128})/u;
const LIVE_UNKNOWN_TURNS = new WeakMap();

function hostError(code, message) {
  return serviceError(code, message);
}

function delay(ms) {
  return new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
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

function sessionById(data, sessionId) {
  return data.sessions.find((session) => session.id === sessionId) || null;
}

function turnById(session, turnId) {
  return session?.turns.find((turn) => turn.id === turnId) || null;
}

function turnByOperation(session, operationId) {
  return session?.turns.find((turn) => turn.operationId === operationId) || null;
}

// Maps server/log failure text to a safe public code. Order matters: an MCP
// load failure is reported by the server as a generic "network issue". Keep
// that concrete cause ahead of incidental quota/rate wording in its wrapper.
function classifyAntigravityFailure(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  if (/authentication required|not authenticated|login required|credentials missing|invalid_grant|UNAUTHENTICATED/iu.test(text)) {
    return "RUNTIME_AUTH_REQUIRED";
  }
  if (/User location is not supported/iu.test(text)) return "ANTIGRAVITY_REGION_UNSUPPORTED";
  if (/MCP load failed/iu.test(text)) return "ANTIGRAVITY_MCP_UNAVAILABLE";
  const limit = classifyProviderLimit(text);
  if (limit) return limit;
  if (/ProxyError|ConnectionError|Max retries exceeded|TLS handshake|timed out|timeout|deadline exceeded|connection (?:reset|refused|closed)|no such host|Name or service not known|\bEOF\b|network issue|UNAVAILABLE/iu.test(text)) {
    return "ANTIGRAVITY_NETWORK_UNAVAILABLE";
  }
  return null;
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

function acpToolName(call) {
  const mcp = call?._meta?.mcp;
  if (plain(mcp) && MCP_NAME_PART.test(String(mcp.server)) && MCP_NAME_PART.test(String(mcp.tool))) {
    return `mcp__${mcp.server}__${mcp.tool}`;
  }
  const title = typeof call?.title === "string" ? call.title.trim() : "";
  return ACP_TOOL_TITLE.exec(title)?.[1] || (safeString(title, 256) && title ? title : "tool");
}

// Tool arguments under the common keys; the path and URL may only be in
// `locations` / `content`. MCP calls carry their own arguments object.
function acpToolArguments(call) {
  const raw = plain(call?.rawInput) ? call.rawInput : null;
  const source = plain(call?._meta?.mcp) && plain(raw?.arguments) ? raw.arguments : raw;
  const args = {};
  for (const [key, value] of Object.entries(source || {})) {
    const name = source === raw ? ACP_ARGUMENT_KEYS[key] || key : key;
    if (!Object.hasOwn(args, name)) args[name] = value;
  }
  const location = Array.isArray(call?.locations)
    ? call.locations.find((item) => plain(item) && safeString(item.path, 4096)) : null;
  if (args.path === undefined && location) args.path = location.path;
  if (args.url === undefined && call?.kind === "fetch" && Array.isArray(call.content)) {
    const url = call.content.map((item) => item?.content?.text)
      .find((text) => typeof text === "string" && /^https?:\/\/\S+$/u.test(text.trim()));
    if (url) args.url = url.trim();
  }
  return raw === null && Object.keys(args).length === 0 ? undefined : args;
}

// Native command results carry their exit code inside the ACP output object.
// MCP/business data and unrecognized result shapes must keep their own outcome.
function nativeCommandExitCode(update, output, call) {
  const command = update.kind === "execute"
    || (update.kind === undefined && call?.name === "run_command");
  if (!command || update._meta?.mcp !== undefined || call?.server != null
    || !plain(output) || !safeString(output.commandLine, 16 * 1024) || !output.commandLine.trim()
    || !safeString(output.workingDir, 4096) || !path.isAbsolute(output.workingDir)
    || !["combinedOutput", "formatted_output"].some(key => typeof output[key] === "string")) return undefined;
  const keys = ["exitCode", "exit_code"].filter(key => Object.hasOwn(output, key));
  if (!keys.length || keys.some(key => !Number.isSafeInteger(output[key]))) return undefined;
  const code = output[keys[0]];
  return keys.every(key => output[key] === code) ? code : undefined;
}

// Only the Settings sign-in lets the server open a browser window.
function antigravityAcpSpawnEnvironment({ parentEnv, userHome, home, geminiHome, openBrowser }) {
  const env = Object.create(null);
  for (const key of PARENT_ENV_ALLOWLIST) {
    const value = parentEnv[key];
    if (typeof value === "string" && value.isWellFormed() && !value.includes("\0")
      && Buffer.byteLength(value, "utf8") <= 4096) env[key] = value;
  }
  env.PATH = runtimePath(parentEnv.PATH, userHome);
  env.HOME = home;
  env.GEMINI_HOME = geminiHome;
  if (openBrowser !== true) env.BROWSER = "/usr/bin/true";
  return env;
}

function defaultKillProcessGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch (error) { if (error?.code !== "ESRCH") throw error; }
}

function defaultProcessGroupExists(pid) {
  try { process.kill(-pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function modelCatalogFromConfig(configOptions) {
  if (!Array.isArray(configOptions)) return null;
  const option = configOptions.find((entry) => plain(entry) && entry.id === "model" && Array.isArray(entry.options));
  if (!option) return null;
  const models = [];
  const seen = new Set();
  for (const entry of option.options.slice(0, 256)) {
    if (!plain(entry) || !safeString(entry.value, 512) || seen.has(entry.value)) continue;
    seen.add(entry.value);
    models.push(Object.freeze({
      model: entry.value,
      displayName: safeString(entry.name, 512) ? entry.name : entry.value,
      description: safeString(entry.description, 4096, { empty: true }) ? entry.description : "",
    }));
  }
  if (models.length === 0) return null;
  const current = safeString(option.currentValue, 512) && seen.has(option.currentValue) ? option.currentValue : models[0].model;
  return Object.freeze({ current, models: Object.freeze(models) });
}

function configValue(configOptions, id) {
  const option = Array.isArray(configOptions) ? configOptions.find((entry) => plain(entry) && entry.id === id) : null;
  return safeString(option?.currentValue, 512) ? option.currentValue : null;
}

class AntigravityAcpRuntimeHost {
  constructor(options = {}) {
    this.options = options;
    this.paths = options.paths;
    this.promptLedger = new (require("./native-instruction-delivery").PromptBlockLedger)();
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
    this.workspaceExecutionVersion = options.workspaceExecutionVersion === 1 ? 1 : null;
    this.workspaceExecutionHome = null;
    this.controlInstance = options.controlInstance === true;
    this.workspace = this.controlInstance ? null : normalizeAntigravityWorkspace(options.workspace);
    this.home = this.runtimeEnvironment.home;
    this.userHome = path.dirname(this.runtimeEnvironment.nativeHome);
    this.parentEnv = options.parentEnv || process.env;
    this.platform = options.platform || process.platform;
    this.fs = options.fs || fs;
    this.spawnProcess = options.spawnProcess || spawn;
    this.killProcessGroup = options.killProcessGroup || defaultKillProcessGroup;
    this.processGroupExists = options.processGroupExists || defaultProcessGroupExists;
    this.verifyServer = options.verifyServer || verifyAntigravityAcpServer;
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.onDiagnostic = typeof options.onDiagnostic === "function" ? options.onDiagnostic : null;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? 60_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 90_000;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 30 * 60 * 1_000;
    this.acceptanceTimeoutMs = options.acceptanceTimeoutMs ?? 90_000;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 2_000;
    this.killGraceMs = options.killGraceMs ?? 1_000;
    for (const value of [this.initializeTimeoutMs, this.requestTimeoutMs, this.promptTimeoutMs,
      this.acceptanceTimeoutMs, this.shutdownGraceMs, this.killGraceMs]) {
      if (!Number.isSafeInteger(value) || value < 10 || value > 2 * 60 * 60 * 1_000) {
        throw hostError("ANTIGRAVITY_HOST_OPTIONS_INVALID", "Antigravity host timeout is invalid");
      }
    }
    this.mcpGateIssuer = options.mcpGateIssuer;
    if (typeof this.mcpGateIssuer?.createMcpServer !== "function") {
      throw hostError("ANTIGRAVITY_HOST_OPTIONS_INVALID", "Antigravity MCP gate issuer is invalid");
    }
    this.profileState = options.profileState || {};
    this.modelCatalogCache = getModelCatalogCache(this.profileState);
    this.state = "idle";
    this.startupStage = "process_spawn";
    this.child = null;
    this.childClosed = false;
    this.rpc = null;
    this.server = null;
    this.nativeToolResults = null;
    this.acpHome = null;
    this.agentCapabilities = {};
    this.authVerified = false;
    this.sessionConfigs = new Map();
    this.sessionResumeAttempts = new Map();
    this.mcpReservations = new Map();
    this.ownedMcpReservations = new Set();
    this.commandCatalogs = new Map();
    this.activeTurns = new Map();
    this.subscribers = new Set();
    this.serverRequestHandlers = new Map();
    this.stderrBuffer = "";
    this.stderrTail = [];
    this.loginFlowSeen = false;
    this.starting = null;
    this.stopping = null;
    this.fatalError = null;
    this.cleanupIncomplete = false;
    this.registeredSecrets = [];
    this.ledger = null;
    this.terminated = new Promise((resolve, reject) => {
      this.resolveTerminated = resolve;
      this.rejectTerminated = reject;
    });
    this.terminated.catch(() => {});
  }

  get nativeApprovalsAvailable() { return true; }

  initialize() {
    if (this.state === "ready") return Promise.resolve(this);
    if (this.starting) return this.starting;
    if (this.state !== "idle") {
      return Promise.reject(hostError("ANTIGRAVITY_RUNTIME_STATE_INVALID", "Antigravity host cannot start"));
    }
    this.state = "starting";
    this.starting = this._start().then(() => this).catch(async (error) => {
      if (this.state !== "stopping" && this.state !== "stopped") await this._fatal(error);
      throw error;
    });
    return this.starting;
  }

  async _start() {
    const workspaceShardId = antigravityWorkspaceShardId({ controlInstance: this.controlInstance, workspace: this.workspace });
    this.ledger = await openRuntimeLedger(this.ledgerSlot, () => new AntigravityAcpRuntimeLedger({
      fs: this.fs,
      stateDir: this.paths.stateDir,
      trustedRoot: this.paths.trustedRoot,
      runtimeProfileId: this.runtimeProfileId,
      workspaceShardId,
    }).open());
    this.server = await this.verifyServer({ paths: this.paths, fs: this.fs });
    if (this.workspaceExecutionVersion === 1 && this.server.version !== "1.2.1") {
      throw hostError("WORKSPACE_RUNTIME_GUARD_UNAVAILABLE", "This Antigravity ACP version has no verified managed tool boundary");
    }
    if (path.resolve(this.runtimeEnvironment.binaryPath) !== path.resolve(this.server.serverPath)) {
      throw hostError("ANTIGRAVITY_ACP_INTEGRITY_FAILED", "Antigravity runtime binary does not match the verified ACP server");
    }
    if (this.state !== "starting") throw hostError("RUNTIME_HOST_TERMINATED", "Antigravity host stopped before keychain preparation");
    this.keychainAbort = new AbortController();
    this.keychainPreparation = prepareAntigravityKeychainContextAsync({
      home: this.home,
      userHome: this.userHome,
      trustedRoot: this.paths.trustedRoot,
      platform: this.platform,
      execFileSync: this.options.securityExecFileSync,
      execFile: this.options.securityExecFile,
      signal: this.keychainAbort.signal,
    });
    try { await this.keychainPreparation; }
    finally { this.keychainPreparation = null; this.keychainAbort = null; }
    if (this.state !== "starting") throw hostError("RUNTIME_HOST_TERMINATED", "Antigravity host stopped before spawn");
    this.acpHome = prepareAntigravityAcpHome({ fs: this.fs, home: this.home, trustedRoot: this.paths.trustedRoot });
    if (this.workspaceExecutionVersion === 1) {
      this.workspaceExecutionHome = prepareAntigravityWorkspaceExecution({ fs: this.fs,
        paths: this.paths, acpHome: this.acpHome });
    }
    if (this.server.version === "1.2.1") this.nativeToolResults = new AntigravityNativeToolResults({ home: this.home });
    if (this.state !== "starting") throw hostError("RUNTIME_HOST_TERMINATED", "Antigravity host stopped before spawn");
    const child = this.spawnProcess(this.server.serverPath, [], {
      cwd: this.workspaceExecutionHome?.cwd || this.workspace || this.home,
      env: this._spawnEnvironment(),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!Number.isSafeInteger(child?.pid) || child.pid <= 1) {
      require("./failed-spawn").retireFailedSpawn(child);
      throw hostError("ANTIGRAVITY_ACP_PROCESS_INVALID", "Antigravity ACP server pid is invalid");
    }
    this.child = child;
    this.childClose = new Promise((resolve) => child.once("close", () => { this.childClosed = true; resolve(); }));
    child.stderr?.on?.("data", (chunk) => this._onStderr(chunk));
    this.rpc = new AcpJsonlClient(child, {
      naming: ACP_NAMING,
      stderrAuthHints: false,
      requestTimeoutMs: this.requestTimeoutMs,
      maxFrameBytes: this.options.maxFrameBytes,
      onDiagnostic: this.onDiagnostic,
    });
    this.rpc.subscribe((message) => {
      try { this._onNotification(message); } catch (error) { void this._fatal(error); }
    });
    this.rpc.registerServerRequestHandler("session/request_permission",
      (params) => this._handlePermissionRequest(params), { timeoutMs: null });
    this.rpc.terminated.catch((error) => {
      if (!new Set(["stopping", "stopped", "failed"]).has(this.state)) void this._fatal(error);
    });
    this.startupStage = "rpc_initialize";
    const response = await this.rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "shoggoth", version: String(this.options.packageVersion || "0.0.0") },
    }, { timeoutMs: this.initializeTimeoutMs });
    if (!plain(response) || response.protocolVersion !== 1 || response.agentInfo?.name !== "antigravity-acp") {
      throw hostError("ANTIGRAVITY_ACP_INITIALIZE_INVALID", "Antigravity ACP initialize response is invalid");
    }
    this.agentCapabilities = plain(response.agentCapabilities) ? structuredClone(response.agentCapabilities) : {};
    this.startupStage = "running";
    this.state = "ready";
  }

  _spawnEnvironment() {
    // The server may start a browser OAuth flow when credentials are missing.
    // Background runs must never open a window; login happens only from Settings.
    return antigravityAcpSpawnEnvironment({
      parentEnv: this.parentEnv,
      userHome: this.userHome,
      home: this.runtimeEnvironment.spawnEnv.HOME,
      geminiHome: this.workspaceExecutionHome?.geminiHome || this.acpHome.geminiHome,
      openBrowser: false,
    });
  }

  _onStderr(chunk) {
    this.stderrBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    let newline;
    while ((newline = this.stderrBuffer.indexOf("\n")) >= 0) {
      const line = this.stderrBuffer.slice(0, newline).slice(0, 4096);
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      this._onStderrLine(line);
    }
    if (this.stderrBuffer.length > 64 * 1024) this.stderrBuffer = this.stderrBuffer.slice(-4096);
  }

  _onStderrLine(line) {
    if (!this.loginFlowSeen && LOGIN_FLOW_PATTERN.test(line)) {
      this.loginFlowSeen = true;
      this._diagnostic("ANTIGRAVITY_ACP_LOGIN_REQUIRED");
      // Never leave an OAuth loopback flow running behind a background request.
      // The server waits for login before running anything, so nothing was sent.
      const error = hostError("AUTH_REQUIRED", "Antigravity authentication is required");
      error.remote = true;
      this.authVerified = false;
      void this._fatal(error);
      return;
    }
    // The pinned server's INFO onboarding response includes subscription copy
    // such as "receive higher rate limits". It is not a provider error. Check
    // login hints above first, since those also arrive at INFO severity.
    if (/^[ID]\d{4}\s/u.test(line)) return;
    this.stderrTail.push(line);
    if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
    const match = PROMPT_ERROR_PATTERN.exec(line);
    if (match) {
      const active = this.activeTurns.get(match[1]);
      if (active && !active.failureCode) {
        active.failureCode = classifyAntigravityFailure(this.stderrTail.join("\n")) || "ANTIGRAVITY_TURN_FAILED";
      }
      // This diagnostic batch belongs to the prompt named by the SDK marker.
      // A later prompt must not inherit an earlier MCP/quota/network failure.
      this.stderrTail = [];
    }
  }

  _diagnostic(code, extra = {}) {
    try { this.onDiagnostic?.({ code, runtime: ANTIGRAVITY_RUNTIME, ...extra }); } catch {}
  }

  async authenticationState({ allowDeferred = false } = {}) {
    this._assertReady();
    const authType = antigravityAcpAuthType({
      fs: this.fs,
      settingsPath: this.acpHome.settingsPath,
      trustedRoot: this.paths.trustedRoot,
    });
    if (authType === null) return Object.freeze({ authenticated: false, credentialPresent: false });
    if (this.authVerified) return Object.freeze({ authenticated: true, credentialPresent: true });
    // The executing request authenticates for real; Settings verifies actively.
    if (allowDeferred) return Object.freeze({ verificationDeferred: true });
    try {
      await this.rpc.request("authenticate", { methodId: authType }, { timeoutMs: this.requestTimeoutMs });
      if (this.loginFlowSeen) return Object.freeze({ authenticated: false, credentialPresent: false });
      this.authVerified = true;
      this.profileState.authenticated = true;
      return Object.freeze({ authenticated: true, credentialPresent: true });
    } catch (error) {
      if (this.loginFlowSeen || error?.code === "AUTH_REQUIRED") {
        return Object.freeze({ authenticated: false, credentialPresent: false });
      }
      throw error;
    }
  }

  canRetireIdle() {
    return this.state === "ready" && !this.cleanupIncomplete && !this.stopping
      && this.activeTurns.size === 0 && this.rpc?.pending.size === 0
      && this.rpc.activeServerRequestIds.size === 0 && !this.rpc.ended
      && this.child?.stdin?.writableLength === 0;
  }

  beginAcquire() {
    this._assertReady();
  }

  subscribe(listener) {
    if (typeof listener !== "function") {
      throw hostError("RUNTIME_EVENT_LISTENER_INVALID", "Antigravity listener is invalid");
    }
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  registerServerRequestHandler(method, handler) {
    if (typeof method !== "string" || typeof handler !== "function") {
      throw hostError("RUNTIME_REQUEST_HANDLER_INVALID", "Antigravity request handler is invalid");
    }
    this.serverRequestHandlers.set(method, handler);
    return () => { if (this.serverRequestHandlers.get(method) === handler) this.serverRequestHandlers.delete(method); };
  }

  pauseManagedToolTimeout({ sessionId, turnId }) {
    const active = this.activeTurns.get(sessionId);
    if (!active || active.turnId !== turnId || !this.rpc) throw hostError("RUNTIME_SESSION_BUSY", "Antigravity turn is not active");
    return this.rpc.pauseRequestTimeout("session/prompt", params => params?.sessionId === sessionId);
  }

  _publish(event) {
    const frozen = Object.freeze(defined(event));
    for (const listener of [...this.subscribers]) {
      try { listener(frozen); } catch { this._diagnostic("ANTIGRAVITY_SUBSCRIBER_FAILED"); }
    }
  }

  _assertReady() {
    if (this.state !== "ready" || !this.rpc) {
      throw hostError("ANTIGRAVITY_RUNTIME_NOT_READY", "Antigravity runtime is not ready");
    }
  }

  _assertExecutionInstance() {
    this._assertReady();
    if (this.controlInstance) {
      throw hostError("RUNTIME_CAPABILITY_UNSUPPORTED", "Antigravity control hosts cannot run sessions");
    }
  }

  _hostCwd() {
    return this.workspace || this.home;
  }

  _nativeSessionArguments(cwd) {
    return { cwd: this.workspaceExecutionHome?.cwd || cwd,
      _meta: antigravityWorkspaceSessionMeta(this.workspaceExecutionVersion) };
  }

  _assertCwd(value) {
    const expected = this._hostCwd();
    if (value !== undefined && value !== null && normalizeAntigravityWorkspace(value) !== expected) {
      throw hostError("ANTIGRAVITY_WORKSPACE_INVALID", "Antigravity workspace route changed");
    }
    return expected;
  }

  _markLive(turnId) {
    let live = LIVE_UNKNOWN_TURNS.get(this.ledger);
    if (!live) { live = new Map(); LIVE_UNKNOWN_TURNS.set(this.ledger, live); }
    live.set(turnId, this);
  }

  // An unknown receipt fences its own operation forever, but blocks other
  // operations only while the process that received it may still run it.
  _mayStillRun(turn) {
    return LIVE_UNKNOWN_TURNS.get(this.ledger)?.has(turn.id) === true;
  }

  _clearLive(turnId) {
    const live = LIVE_UNKNOWN_TURNS.get(this.ledger);
    if (live?.get(turnId) === this) live.delete(turnId);
  }

  _releaseLiveTurns() {
    const live = LIVE_UNKNOWN_TURNS.get(this.ledger);
    for (const [turnId, owner] of live || []) if (owner === this) live.delete(turnId);
  }

  _acpMode(permissionMode) {
    if (permissionMode !== undefined && permissionMode !== null) {
      if (!Object.prototype.hasOwnProperty.call(ACP_MODES, permissionMode)) {
        throw hostError("RUNTIME_PERMISSION_POLICY_INVALID", "Antigravity permission mode is invalid");
      }
      return ACP_MODES[permissionMode];
    }
    if (this.permissionPolicy.sandbox === "read-only") return ACP_MODES.plan;
    return this.permissionPolicy.sandbox === "danger-full-access" && this.permissionPolicy.approvalPolicy === "never"
      ? ACP_MODES.full : ACP_MODES["accept-edits"];
  }

  _readOnly(permissionMode) {
    return permissionMode === "plan"
      || ((permissionMode === undefined || permissionMode === null) && this.permissionPolicy.sandbox === "read-only");
  }

  _validateModel(model) {
    if (model === undefined || model === null) return null;
    if (!safeString(model, 512)) throw hostError("RUNTIME_MODEL_UNAVAILABLE", "Antigravity model is invalid");
    const catalog = this.profileState.acpModelCatalog;
    if (catalog && !catalog.models.some((candidate) => candidate.model === model)) {
      throw hostError("RUNTIME_MODEL_UNAVAILABLE", "Antigravity model is unavailable");
    }
    return model;
  }

  _rememberConfig(sessionId, configOptions) {
    const catalog = modelCatalogFromConfig(configOptions);
    if (catalog) this.profileState.acpModelCatalog = catalog;
    const config = this.sessionConfigs.get(sessionId) || {};
    this.sessionConfigs.set(sessionId, {
      ...config,
      currentModel: configValue(configOptions, "model") ?? config.currentModel ?? null,
      currentMode: configValue(configOptions, "mode") ?? config.currentMode ?? null,
    });
  }

  async _applyConfig(sessionId, { model, mode }) {
    const config = this.sessionConfigs.get(sessionId) || {};
    for (const [configId, value, current] of [["model", model, config.currentModel], ["mode", mode, config.currentMode]]) {
      if (value === null || value === undefined || value === current) continue;
      let result;
      try {
        result = await this.rpc.request("session/set_config_option", { sessionId, configId, value },
          { timeoutMs: this.requestTimeoutMs });
      } catch (error) {
        recordAntigravitySessionDiagnostic({ paths: this.paths, binding: this.binding,
          method: "session/set_config_option", sessionId, executionRunId: this.mcpExecutionRunId,
          error, remoteClassification: classifyAntigravitySessionRemoteError(error?.rpcDetail) });
        throw this._requestFailure(error, configId === "model" ? "RUNTIME_MODEL_UNAVAILABLE" : "ANTIGRAVITY_ACP_CONFIG_FAILED");
      }
      this._rememberConfig(sessionId, result?.configOptions);
    }
  }

  // `remote` marks an explicit JSON-RPC error reply: the server answered and did
  // not run the request, unlike a timeout or a lost connection.
  _requestFailure(error, fallbackCode) {
    if (this.loginFlowSeen || error?.code === "AUTH_REQUIRED") {
      const failure = hostError("AUTH_REQUIRED", "Antigravity authentication is required");
      failure.dispatchState = error?.dispatchState || "not_sent";
      failure.remote = true;
      return failure;
    }
    if (error?.code === "ANTIGRAVITY_ACP_REMOTE_ERROR") {
      const code = classifyAntigravityFailure(error.rpcDetail) || fallbackCode;
      const failure = hostError(code === "RUNTIME_AUTH_REQUIRED" ? "AUTH_REQUIRED" : code, "Antigravity request failed");
      failure.dispatchState = error.dispatchState;
      failure.remote = true;
      return failure;
    }
    return error;
  }

  async _mcpServers() {
    const descriptor = await this.mcpGateIssuer.createMcpServer({
      runtimeProfileId: this.runtimeProfileId,
      runtimeAccountId: this.runtimeAccountId,
      executionRunId: this.mcpExecutionRunId,
      // The ACP server launches MCP servers from its signed harness child.
      parentExecutable: this.server.harnessPath,
      ancestorExecutable: this.server.serverPath,
      ancestorPid: this.child.pid,
    });
    if (typeof descriptor.reservationId === "string") this.ownedMcpReservations.add(descriptor.reservationId);
    if (this.state !== "ready") {
      this._revokeMcpTicket(descriptor.reservationId);
      throw hostError("RUNTIME_HOST_TERMINATED", "Antigravity host stopped while preparing MCP");
    }
    return {
      reservationId: typeof descriptor.reservationId === "string" ? descriptor.reservationId : null,
      mcpServers: [{
        name: descriptor.name,
        command: descriptor.command,
        args: [...descriptor.args],
        env: descriptor.env.map((entry) => ({ name: entry.name, value: entry.value })),
      }],
    };
  }

  // The harness starts the helper when a prompt runs, not at session/new|resume,
  // which can take longer than the ticket TTL. Start the ticket's TTL from here.
  _renewMcpTicket(sessionId) {
    const reservationId = this.mcpReservations.get(sessionId);
    if (!reservationId) return;
    try {
      const result = this.mcpGateIssuer.renewMcpServer({ reservationId });
      if (result?.renewed !== true && result?.consumed !== true) {
        throw hostError("RUNTIME_MCP_GATE_INVALID", "Antigravity MCP reservation is unavailable");
      }
    } catch (error) {
      this._revokeMcpTicket(reservationId);
      // Keep the failed handle until this host stops: a later operation must
      // not bypass MCP preparation just because the first renewal failed.
      const reasons = new Set(["RUNTIME_MCP_GATE_INVALID", "RUNTIME_MCP_GATE_EXPIRED",
        "RUNTIME_MCP_GATE_PARENT_MISMATCH", "RUNTIME_MCP_GATE_REPLACED"]);
      this._diagnostic(reasons.has(error?.code) ? error.code : "RUNTIME_MCP_GATE_INVALID");
      throw hostError("ANTIGRAVITY_MCP_UNAVAILABLE", "Antigravity MCP could not be prepared before dispatch");
    }
  }

  _revokeMcpTicket(reservationId) {
    if (!reservationId) return;
    try { this.mcpGateIssuer.revokeMcpServer({ reservationId }); }
    catch { this._diagnostic("RUNTIME_MCP_GATE_CLEANUP_FAILED"); }
    this.ownedMcpReservations.delete(reservationId);
  }

  async sessionStart(input) {
    this._assertExecutionInstance();
    if (!plain(input) || !safeString(input.source, 256)
      || (input.developerInstructions !== undefined
        && !safeString(input.developerInstructions, 1024 * 1024, { empty: true }))) {
      throw hostError("RUNTIME_SESSION_PARAMS_INVALID", "Antigravity session input is invalid");
    }
    normalizeAntigravityPermissionPolicy(input.permissionPolicy ?? this.permissionPolicy);
    const cwd = this._assertCwd(input.cwd);
    const model = this._validateModel(input.model);
    const mode = this._acpMode(input.permissionMode);
    const snapshot = this.ledger.snapshot();
    const existing = snapshot.sessions.find((session) => session.source === input.source);
    if (existing) {
      this.sessionConfigs.set(existing.id, { ...(this.sessionConfigs.get(existing.id) || {}),
        developerInstructions: input.developerInstructions || "", permissionMode: input.permissionMode ?? null });
      return { session: this._projectSession(existing) };
    }
    if (snapshot.pendingSessions.some((pending) => pending.source === input.source)) {
      throw hostError("RUNTIME_SESSION_ACCEPTANCE_UNKNOWN", "Antigravity session acceptance is unknown");
    }
    const mcp = await this._mcpServers();
    const params = { ...this._nativeSessionArguments(cwd), mcpServers: mcp.mcpServers };
    this.rpc.preflightRequest("session/new", params);
    const createdAt = this.now();
    this.ledger.update((data) => {
      if (data.pendingSessions.some((pending) => pending.source === input.source)
        || data.sessions.some((session) => session.source === input.source)) {
        throw hostError("RUNTIME_SESSION_ACCEPTANCE_UNKNOWN", "Antigravity session acceptance is unknown");
      }
      data.pendingSessions.push({ source: input.source, cwd, createdAt, dispatchState: "not_sent" });
    });
    let response;
    try {
      response = await this.rpc.request("session/new", params, {
        timeoutMs: this.requestTimeoutMs,
        onWriteAttempt: () => this.ledger.update((data) => {
          const pending = data.pendingSessions.find((item) => item.source === input.source);
          if (!pending) throw hostError("RUNTIME_SESSION_CONFLICT", "Antigravity pending session is missing");
          pending.dispatchState = "write_attempted";
        }),
      });
    } catch (error) {
      const failure = this._requestFailure(error, "ANTIGRAVITY_ACP_REMOTE_ERROR");
      this._revokeMcpTicket(mcp.reservationId);
      // An explicit server rejection or an unsent frame proves no conversation exists.
      if (error?.dispatchState === "not_sent" || error?.code === "ANTIGRAVITY_ACP_REMOTE_ERROR"
        || failure.code === "AUTH_REQUIRED") {
        this.ledger.update((data) => {
          data.pendingSessions = data.pendingSessions.filter((item) => item.source !== input.source);
        });
      }
      throw failure;
    }
    if (!plain(response) || !safeString(response.sessionId, 512)) {
      throw hostError("ANTIGRAVITY_ACP_SESSION_RESPONSE_INVALID", "Antigravity session/new response is invalid");
    }
    this.authVerified = true;
    const session = {
      id: response.sessionId, source: input.source, cwd, title: null, archived: false,
      createdAt, updatedAt: createdAt, turns: [],
    };
    this.ledger.update((data) => {
      if (data.sessions.some((candidate) => candidate.id === session.id)) {
        throw hostError("RUNTIME_SESSION_CONFLICT", "Antigravity returned a duplicate session id");
      }
      data.pendingSessions = data.pendingSessions.filter((item) => item.source !== input.source);
      data.sessions.push(session);
    });
    if (mcp.reservationId) this.mcpReservations.set(session.id, mcp.reservationId);
    this.sessionConfigs.set(session.id, {
      developerInstructions: input.developerInstructions || "",
      permissionMode: input.permissionMode ?? null,
    });
    this._rememberConfig(session.id, response.configOptions);
    await this._applyConfig(session.id, { model, mode });
    return { session: this._projectSession(session) };
  }

  async sessionResume(input) {
    this._assertExecutionInstance();
    if (!plain(input) || !safeString(input.sessionId, 512)
      || (input.developerInstructions !== undefined
        && !safeString(input.developerInstructions, 1024 * 1024, { empty: true }))) {
      throw hostError("RUNTIME_SESSION_PARAMS_INVALID", "Antigravity resume input is invalid");
    }
    const session = this._requireSession(input.sessionId);
    if (session.archived) throw hostError("RUNTIME_SESSION_NOT_FOUND", "Antigravity session is archived");
    if (this.activeTurns.has(session.id)) throw hostError("RUNTIME_SESSION_BUSY", "Antigravity session has an active turn");
    const cwd = this._assertCwd(input.cwd);
    if (session.cwd !== cwd) throw hostError("RUNTIME_SESSION_NOT_FOUND", "Antigravity session workspace does not match");
    const model = this._validateModel(input.model);
    const mode = this._acpMode(input.permissionMode);
    const alreadyLoaded = this.sessionConfigs.has(session.id) && this.sessionConfigs.get(session.id).loaded === true;
    if (!alreadyLoaded) {
      if (!plain(this.agentCapabilities.sessionCapabilities?.resume)) {
        throw hostError("RUNTIME_CAPABILITY_UNSUPPORTED", "Antigravity cannot resume sessions");
      }
      let response;
      let mcp;
      const attempt = Math.min(255, (this.sessionResumeAttempts.get(session.id) || 0) + 1);
      this.sessionResumeAttempts.set(session.id, attempt);
      try {
        mcp = await this._mcpServers();
        response = await this.rpc.request("session/resume", { sessionId: session.id,
          ...this._nativeSessionArguments(cwd), mcpServers: mcp.mcpServers },
          { timeoutMs: this.requestTimeoutMs });
      } catch (error) {
        this._revokeMcpTicket(mcp?.reservationId);
        const failure = this._requestFailure(error, "RUNTIME_SESSION_NOT_FOUND");
        const remoteClassification = classifyAntigravitySessionRemoteError(error?.rpcDetail);
        const retryEligible = error?.code === "ANTIGRAVITY_ACP_REMOTE_ERROR"
          && failure.code === "ANTIGRAVITY_NETWORK_UNAVAILABLE"
          && isTransientAntigravitySessionError(remoteClassification)
          && this.state === "ready" && !this.loginFlowSeen && input.preserveRunningContext !== true
          && !this.activeTurns.has(session.id)
          && !session.turns.some(turn => turn.acceptance === "unknown" && this._mayStillRun(turn));
        recordAntigravitySessionDiagnostic({ paths: this.paths, binding: this.binding,
          method: "session/resume", sessionId: session.id, executionRunId: this.mcpExecutionRunId,
          attempt, error, remoteClassification, retryEligible });
        const historyUnavailable = error?.code === "ANTIGRAVITY_ACP_REMOTE_ERROR"
          && ["SESSION_NOT_FOUND", "HISTORY_READ_FAILED"].includes(remoteClassification);
        throw runtimeSessionResumeError(failure, { retryable: retryEligible, preserveSession: !historyUnavailable });
      }
      if (attempt > 1) recordAntigravitySessionDiagnostic({ paths: this.paths, binding: this.binding,
        method: "session/resume", sessionId: session.id, executionRunId: this.mcpExecutionRunId,
        attempt, outcome: "resumed" });
      this.sessionResumeAttempts.delete(session.id);
      if (mcp.reservationId) this.mcpReservations.set(session.id, mcp.reservationId);
      this.authVerified = true;
      // The server restores the mode but not the model after a restart.
      this.sessionConfigs.set(session.id, { loaded: true });
      this._rememberConfig(session.id, response?.configOptions);
    }
    this.sessionConfigs.set(session.id, {
      ...(this.sessionConfigs.get(session.id) || {}),
      loaded: true,
      developerInstructions: input.developerInstructions || "",
      permissionMode: input.permissionMode ?? null,
    });
    try { await this._applyConfig(session.id, { model, mode }); }
    catch (error) { throw runtimeSessionResumeError(error); }
    return { session: this._projectSession(session) };
  }

  sessionRead(input) {
    const settled = settledRuntimeSession(this, input?.sessionId);
    if (!settled) this._assertReady();
    if (!plain(input) || !safeString(input.sessionId, 512)) {
      return Promise.reject(hostError("RUNTIME_SESSION_PARAMS_INVALID", "Antigravity read input is invalid"));
    }
    const session = settled || sessionById(this.ledger.snapshot(), input.sessionId);
    if (!session) return Promise.reject(hostError("RUNTIME_SESSION_NOT_FOUND", "Antigravity session was not found"));
    if (session.turns.some((turn) => turn.acceptance === "unknown" && this._mayStillRun(turn))) {
      return Promise.reject(hostError("RUNTIME_TURN_ACCEPTANCE_UNKNOWN", "Antigravity turn acceptance is unknown"));
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
    return Promise.reject(hostError("RUNTIME_CAPABILITY_UNSUPPORTED",
      "Antigravity ACP does not advertise session deletion"));
  }

  _requireSession(sessionId) {
    if (!safeString(sessionId, 512)) {
      throw hostError("RUNTIME_SESSION_PARAMS_INVALID", "Antigravity session id is invalid");
    }
    const session = sessionById(this.ledger.snapshot(), sessionId);
    if (!session) throw hostError("RUNTIME_SESSION_NOT_FOUND", "Antigravity session was not found");
    return session;
  }

  _promptText(sessionId, input) { return this._promptParts(sessionId, input, null).text; }

  // Antigravity has no system channel: the full policy used to repeat in every
  // user message. Unchanged blocks are now sent again only when PromptBlockLedger
  // cannot rule out that the CLI's own compaction dropped them.
  _promptParts(sessionId, input, ledger = this.promptLedger) {
    const config = this.sessionConfigs.get(sessionId);
    const delivery = require("./native-instruction-delivery");
    const turn = delivery.splitTurnInstructions(delivery.turnInstructions(input));
    const { blocks, commit } = delivery.promptBlocks(ledger, sessionId, {
      stable: config?.developerInstructions ? `SHOGGOTH DEVELOPER INSTRUCTIONS\n${config.developerInstructions}` : "",
      rules: turn.rules,
      context: typeof input.context === "string" ? input.context : "",
      run: turn.run,
    });
    const commands = this.commandCatalogs.get(sessionId) || [];
    if (parseRuntimeCommand(input.prompt, commands)) {
      // ACP commands expand only at the start of the prompt; keep the bound
      // profile's context after the invocation instead of dropping it.
      return { text: [input.prompt.trim(), ...blocks].join("\n\n"), commit };
    }
    blocks.push(`CURRENT USER REQUEST\n${input.prompt}`);
    return { text: blocks.join("\n\n"), commit };
  }

  async turnStart(input) {
    this._assertExecutionInstance();
    if (!plain(input) || !safeString(input.sessionId, 512) || !safeString(input.operationId, 512)
      || !safeString(input.prompt, 1024 * 1024, { empty: true })
      || (input.context !== undefined && input.context !== null
        && !safeString(input.context, 4 * 1024 * 1024, { empty: true }))) {
      throw hostError("RUNTIME_TURN_PARAMS_INVALID", "Antigravity turn input is invalid");
    }
    normalizeAntigravityPermissionPolicy(input.permissionPolicy ?? this.permissionPolicy);
    const config = this.sessionConfigs.get(input.sessionId) || {};
    const permissionMode = input.permissionMode ?? config.permissionMode ?? null;
    const mode = this._acpMode(permissionMode);
    const model = this._validateModel(input.model);
    const session = this._requireSession(input.sessionId);
    if (session.archived) throw hostError("RUNTIME_SESSION_ARCHIVED", "Antigravity session is archived");
    if (this._assertCwd(input.cwd) !== session.cwd) {
      throw hostError("RUNTIME_SESSION_NOT_FOUND", "Antigravity turn workspace does not match");
    }
    const images = imageAttachments(input.attachments);
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify([
      input.sessionId, input.operationId, input.prompt, input.context ?? null, model, input.cwd ?? null,
      input.permissionPolicy ?? null, permissionMode, (input.attachments || []).map((item) => [item.id ?? null, item.name ?? null]),
      ...(input.turnDeveloperInstructions == null ? [] : [require("./native-instruction-delivery").turnInstructionFingerprint(input)]),
    ])).digest("hex");
    const existing = turnByOperation(session, input.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw hostError("RUNTIME_OPERATION_CONFLICT", "Antigravity operationId was reused with different input");
      }
      const active = this.activeTurns.get(session.id);
      if (active?.turnId === existing.id) return active.acceptance.promise;
      if (existing.acceptance === "unknown") {
        throw hostError("RUNTIME_TURN_ACCEPTANCE_UNKNOWN", "Antigravity turn acceptance is unknown");
      }
      if (existing.acceptance === "failed") {
        throw hostError(existing.errorCode || "ANTIGRAVITY_TURN_FAILED", "Antigravity turn was rejected");
      }
      return { turn: { id: existing.id, status: existing.status, items: [] } };
    }
    if (session.turns.some((turn) => turn.acceptance === "unknown" && this._mayStillRun(turn))) {
      throw hostError("RUNTIME_TURN_ACCEPTANCE_UNKNOWN", "A previous Antigravity turn is unresolved");
    }
    if (this.activeTurns.has(session.id)) {
      throw hostError("RUNTIME_SESSION_BUSY", "Antigravity session already has an active turn");
    }
    // Configuration is applied before any receipt exists: its failure is not a send.
    await this._applyConfig(session.id, { model, mode });
    const promptParts = this._promptParts(session.id, input);
    const params = {
      sessionId: session.id,
      prompt: [{ type: "text", text: promptParts.text },
        ...images.map((image) => ({ type: "image", mimeType: image.mimeType, data: image.data }))],
    };
    this.rpc.preflightRequest("session/prompt", params);
    const turnId = `antigravity-turn-${this.randomUUID()}`;
    const createdAt = this.now();
    const nativeToolCursor = this.nativeToolResults?.cursor(session.id, { fresh: session.turns.length === 0 }) ?? null;
    this.ledger.update((data) => {
      const current = sessionById(data, session.id);
      current.turns.push({
        id: turnId, operationId: input.operationId, fingerprint, acceptance: "unknown",
        dispatchState: "not_sent", status: "inProgress", errorCode: null, assistantMessages: [],
        createdAt, updatedAt: createdAt,
      });
      current.updatedAt = Math.max(current.updatedAt, createdAt);
    });
    const active = {
      sessionId: session.id, turnId, operationId: input.operationId, createdAt, promptCommit: promptParts.commit,
      acceptance: makeDeferred(), terminal: makeDeferred(),
      accepted: false, dispatchState: "not_sent", timedOut: false, timer: null,
      text: "", failureCode: null, permissionMode, readOnly: this._readOnly(permissionMode), acpMode: mode,
      nativeToolCursor, toolCalls: new Map(), ambiguousMcpCalls: false,
      pendingToolResults: new Map(), pendingToolResultBytes: 0, completedToolCalls: new Set(),
    };
    if (this.activeTurns.size === 0) this.stderrTail = [];
    this.activeTurns.set(session.id, active);
    const request = this.rpc.request("session/prompt", params, {
      timeoutMs: this.promptTimeoutMs,
      // The server sends nothing while the model thinks (no thought or echo
      // updates), so waiting for a first update would block Stop for the whole
      // thinking time and cancel healthy long turns. A prompt fully delivered to
      // the live server's stdin has been received; its outcome still settles
      // through the response, stderr failures or process loss.
      onWritten: () => {
        // A failed receipt write leaves the descriptor unused and renewable.
        // Only a delivered prompt transfers helper startup to the harness.
        this.mcpReservations.delete(session.id);
        this._acceptTurn(active);
      },
      onWriteAttempt: () => {
        // Refresh at the actual write boundary, after any queued ACP writes.
        // A failed refresh leaves both the request and receipt definitely unsent.
        this._renewMcpTicket(session.id);
        this.ledger.update((data) => {
          const turn = turnById(sessionById(data, session.id), turnId);
          if (!turn) throw hostError("RUNTIME_TURN_RECEIPT_CONFLICT", "Antigravity turn receipt is missing");
          turn.dispatchState = "write_attempted";
        });
        this._markLive(turnId);
        active.dispatchState = "write_attempted";
        active.timer = setTimeout(() => this._markAcceptanceUnknown(active), this.acceptanceTimeoutMs);
        active.timer.unref?.();
      },
    });
    void request.then(
      (response) => this._finishPrompt(active, response),
      (error) => this._failPrompt(active, this._requestFailure(error, "ANTIGRAVITY_TURN_FAILED")),
    ).catch((error) => this._fatal(error));
    return active.acceptance.promise;
  }

  turnSteer() {
    return Promise.reject(hostError("RUNTIME_CAPABILITY_UNSUPPORTED", "Antigravity does not support in-turn steering"));
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
    if (active.turnId !== input.turnId) throw hostError("RUNTIME_TURN_STALE", "Antigravity turn is stale");
    await this.rpc.notify("session/cancel", { sessionId: session.id });
    let timer;
    let terminal;
    try {
      terminal = await Promise.race([active.terminal.promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(hostError("RUNTIME_TURN_CANCEL_UNKNOWN",
          "Antigravity did not confirm turn cancellation")), this.requestTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
    if (terminal?.status !== "canceled") {
      throw hostError("RUNTIME_TURN_CANCEL_NOT_CONFIRMED", "Antigravity completed the turn without cancelling");
    }
    return {};
  }

  _catalogIdentity() {
    return modelCatalogIdentity({
      fs: this.fs,
      values: [this.runtimeEnvironment, this.server?.version, this.profileState.authGeneration || 0],
      files: [this.acpHome.settingsPath],
    });
  }

  async _loadModelCatalog() {
    // A server process reports one catalog for its lifetime; hosts are retired
    // when idle, so a later refresh comes from a fresh process.
    if (this.processCatalog) return this.processCatalog;
    // The server only reports models alongside a session. Keep one catalog
    // session per control ledger and resume it instead of creating new ones.
    const cwd = this._hostCwd();
    const mcpServers = [];
    const catalogSessionId = this.ledger.snapshot().catalogSessionId;
    let response = null;
    try {
      if (catalogSessionId && plain(this.agentCapabilities.sessionCapabilities?.resume)) {
        try {
          response = await this.rpc.request("session/resume", { sessionId: catalogSessionId,
            ...this._nativeSessionArguments(cwd), mcpServers },
            { timeoutMs: this.requestTimeoutMs });
        } catch (error) {
          if (error?.code !== "ANTIGRAVITY_ACP_REMOTE_ERROR") throw error;
        }
      }
      if (!response) {
        response = await this.rpc.request("session/new", { ...this._nativeSessionArguments(cwd), mcpServers }, { timeoutMs: this.requestTimeoutMs });
        if (safeString(response?.sessionId, 512)) {
          this.ledger.update((data) => { data.catalogSessionId = response.sessionId; });
        }
      }
    } catch (error) {
      const failure = this._requestFailure(error, "RUNTIME_MODEL_CATALOG_UNAVAILABLE");
      throw failure.code === "AUTH_REQUIRED" ? failure
        : hostError(failure.code === "ANTIGRAVITY_NETWORK_UNAVAILABLE" ? failure.code : "RUNTIME_MODEL_CATALOG_UNAVAILABLE",
          "Antigravity model catalog is unavailable");
    }
    this.authVerified = true;
    const catalog = modelCatalogFromConfig(response?.configOptions);
    if (!catalog) throw hostError("RUNTIME_MODEL_CATALOG_INVALID", "Antigravity model catalog is invalid");
    this.profileState.acpModelCatalog = catalog;
    this.processCatalog = catalog;
    return catalog;
  }

  async modelsList(input = {}) {
    this._assertReady();
    const offset = input.cursor === undefined || input.cursor === null ? 0 : Number(input.cursor);
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || String(offset) !== String(input.cursor ?? offset)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw hostError("RUNTIME_MODEL_CURSOR_INVALID", "Antigravity model cursor is invalid");
    }
    const key = this._catalogIdentity();
    const catalog = await this.modelCatalogCache.read({
      key,
      now: this.now,
      isCurrent: () => this.state === "ready",
      allowStale: () => false,
      onRefreshError: (error) => this._diagnostic(error?.code || "RUNTIME_MODEL_CATALOG_UNAVAILABLE"),
      load: () => this._loadModelCatalog(),
    });
    const page = catalog.models.slice(offset, offset + limit).map((model) => ({
      ...model,
      isDefault: model.model === catalog.current,
      hidden: false,
      // Reasoning effort is part of the model id (for example *-high / *-low).
      capabilities: { thinkingOptions: [], thinkingDefault: null, fastTier: null },
    }));
    const next = offset + page.length;
    return { data: page, nextCursor: next < catalog.models.length ? String(next) : null };
  }

  _commandCatalog(sessionId) {
    return mergeNativeCommands("antigravity", this.commandCatalogs.get(sessionId) || []);
  }

  commandsList(input = {}) {
    this._assertReady();
    if (!plain(input) || (input.sessionId !== undefined && input.sessionId !== null && !safeString(input.sessionId, 512))) {
      return Promise.reject(hostError("RUNTIME_COMMAND_PARAMS_INVALID", "Antigravity command input is invalid"));
    }
    if (input.sessionId !== undefined && input.sessionId !== null) this._requireSession(input.sessionId);
    return Promise.resolve({ supported: true, reason: null, commands: this._commandCatalog(input.sessionId) });
  }

  commandExecute(input) {
    this._assertExecutionInstance();
    if (!plain(input) || (input.sessionId !== null && input.sessionId !== undefined && !safeString(input.sessionId, 512))
      || !safeString(input.text, 64 * 1024)) {
      return Promise.reject(hostError("RUNTIME_COMMAND_PARAMS_INVALID", "Antigravity command input is invalid"));
    }
    if (input.sessionId) this._requireSession(input.sessionId);
    const parsed = requireRuntimeCommand(input.text, this._commandCatalog(input.sessionId), "antigravity");
    return Promise.resolve({ kind: "send", text: parsed.text, warning: null });
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
              id: message.id, type: "agentMessage", text: message.text, phase: "final_answer", delivery: "local",
            })),
          ],
        })),
      } : {}),
    });
  }

  _onNotification(message) {
    if (message.method !== "session/update") return;
    const params = message.params;
    if (!plain(params) || !safeString(params.sessionId, 512) || !plain(params.update)
      || !safeString(params.update.sessionUpdate, 128)) {
      this._diagnostic("ANTIGRAVITY_ACP_UPDATE_INVALID");
      return;
    }
    const { sessionId, update } = params;
    if (update.sessionUpdate === "available_commands_update") {
      if (!Array.isArray(update.availableCommands)) return;
      try {
        const commands = normalizeRuntimeCommands(update.availableCommands
          .filter((command) => plain(command) && !HIDDEN_COMMANDS.has(command.name))
          .map((command) => ({ name: command.name, description: command.description || "" })), {
          errorCode: "RUNTIME_COMMAND_CATALOG_INVALID",
          errorMessage: "Antigravity command catalog format changed",
        });
        this.commandCatalogs.set(sessionId, commands);
      } catch { this._diagnostic("RUNTIME_COMMAND_CATALOG_INVALID"); }
      return;
    }
    if (update.sessionUpdate === "config_option_update") {
      this._rememberConfig(sessionId, update.configOptions);
      return;
    }
    const active = this.activeTurns.get(sessionId);
    if (!active || active.timedOut || active.dispatchState !== "write_attempted") return;
    if (TURN_ACCEPTANCE_UPDATE_KINDS.has(update.sessionUpdate)) {
      this.authVerified = true;
      this._acceptTurn(active);
    } else if (!active.accepted) return;
    const common = { known: true, method: "session/update", sessionId, turnId: active.turnId };
    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk") {
      const text = update.content?.type === "text" && typeof update.content.text === "string" ? update.content.text : "";
      const combined = `${active.text}${text}`;
      if (Buffer.byteLength(combined, "utf8") > MAX_ASSISTANT_TEXT_BYTES) {
        throw hostError("ANTIGRAVITY_TURN_OUTPUT_TOO_LARGE", "Antigravity response is too large");
      }
      active.text = combined;
      this._publish({ ...common, type: "text_delta", itemId: `antigravity-message-${active.turnId}`, delta: text });
      return;
    }
    if (kind === "agent_thought_chunk") {
      const delta = update.content?.type === "text" && typeof update.content.text === "string" ? update.content.text : "";
      this._publish({ ...common, type: "reasoning_delta", delta });
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      if (!safeString(update.toolCallId, 512)) return;
      const completed = update.status === "completed" || update.status === "failed";
      const rawOutput = update.rawOutput ?? update.content;
      if (kind === "tool_call") {
        const mcp = plain(update._meta?.mcp) ? update._meta.mcp : null;
        const call = nativeToolCall({ id: update.toolCallId, name: mcp ? mcp.tool : acpToolName(update),
          server: mcp ? mcp.server : null, input: mcp ? update.rawInput?.arguments : update.rawInput });
        if (active.toolCalls.size < 2048) {
          const previous = active.toolCalls.get(update.toolCallId);
          active.toolCalls.set(update.toolCallId, active.toolCalls.has(update.toolCallId)
            && JSON.stringify(previous) !== JSON.stringify(call) ? null : call);
          if (mcp && !active.toolCalls.get(update.toolCallId)) active.ambiguousMcpCalls = true;
        } else active.nativeToolCursor = null;
        const args = acpToolArguments(update);
        const input = args === undefined ? undefined
          : safeSnapshot(args, { registeredSecrets: this.registeredSecrets, maxSnapshotBytes: 64 * 1024 });
        this._publish({
          ...common, type: "tool_start", itemId: update.toolCallId, toolCallId: update.toolCallId,
          ...contextToolContent({ input: args }, this.registeredSecrets),
          tool: { kind: update.kind || "other", name: acpToolName(update), status: update.status || "pending",
            ...(safeString(update.title, 256) && !ACP_TOOL_TITLE.test(update.title) ? { activityTitle: update.title } : {}),
            ...(input === undefined ? {} : { input }) },
        });
        return;
      }
      if (active.completedToolCalls.has(update.toolCallId)) return;
      const call = active.toolCalls.get(update.toolCallId);
      // ACP 1.2.1 broadcasts every ERROR step to all open call IDs. Even a
      // concrete error body can belong to a different tool. Verify every failure.
      const lossy = update.status === "failed"
        // Successful MCP rawOutput is a model-written summary, with no stable
        // wording ("Call ping tool", "Call shoggoth ping", ...). Prefer the
        // uniquely matched native response rather than guessing its phrasing.
        || (update.status === "completed" && Boolean(call?.server));
      if (lossy && active.nativeToolCursor !== null && call) {
        // The native write can lag the ACP frame. Publish as soon as the
        // matching native result commits, without replaying execution.
        const bytes = Buffer.byteLength(JSON.stringify({ rawOutput, rawInput: update.rawInput,
          locations: update.locations, _meta: update._meta }));
        const previousBytes = active.pendingToolResults.get(update.toolCallId)?.pendingBytes || 0;
        if (active.pendingToolResultBytes - previousBytes + bytes <= MAX_PENDING_TOOL_RESULT_BYTES) {
          active.pendingToolResultBytes += bytes - previousBytes;
          if (!active.pendingToolResults.size) active.nativeResultAttempts = 0;
          active.pendingToolResults.set(update.toolCallId, {
            toolCallId: update.toolCallId, status: update.status, rawOutput, pendingBytes: bytes,
            observedAt: this.now(),
            ...(update.rawInput === undefined ? {} : { rawInput: update.rawInput }),
            ...(update.locations === undefined ? {} : { locations: update.locations }),
            ...(update._meta === undefined ? {} : { _meta: update._meta }),
            ...(safeString(update.kind, 128) ? { kind: update.kind } : {}),
            ...(safeString(update.title, 256) ? { title: update.title } : {}),
          });
          this._flushToolResults(active, { final: false });
          return;
        }
      }
      if (completed) {
        active.pendingToolResultBytes -= active.pendingToolResults.get(update.toolCallId)?.pendingBytes || 0;
        active.pendingToolResults.delete(update.toolCallId);
      }
      if (update.status === "failed" && this.server.version === "1.2.1") {
        this._publishUnverifiedToolResult(active, update, this.now());
      } else this._publishToolUpdate(active, update);
      return;
    }
    if (kind === "plan") {
      this._publish({ ...common, type: "plan", plan: Array.isArray(update.entries) ? update.entries : [] });
      return;
    }
    // Tolerant reader: new update kinds carry no content we render.
    if (!TURN_ACCEPTANCE_UPDATE_KINDS.has(kind)) this._diagnostic("ANTIGRAVITY_ACP_UPDATE_UNKNOWN");
  }

  _publishToolUpdate(active, update, metadata = {}) {
    const completed = update.status === "completed" || update.status === "failed";
    const rawOutput = update.rawOutput ?? update.content;
    const output = completed && rawOutput !== undefined
      ? safeSnapshot(rawOutput, { registeredSecrets: this.registeredSecrets, maxSnapshotBytes: 64 * 1024 }) : undefined;
    // ACP updates are partial: MCP metadata may appear only on the start.
    // Reuse it only to unwrap display arguments for this exact call.
    const call = active.toolCalls.get(update.toolCallId);
    const exitCode = completed ? nativeCommandExitCode(update, rawOutput, call) : undefined;
    const status = completed && exitCode !== undefined && exitCode !== 0 ? "failed" : update.status;
    const argumentUpdate = call?.server && !update._meta?.mcp
      ? { ...update, _meta: { mcp: { server: call.server, tool: call.name } } } : update;
    const args = acpToolArguments(argumentUpdate);
    const input = args === undefined ? undefined
      : safeSnapshot(args, { registeredSecrets: this.registeredSecrets, maxSnapshotBytes: 64 * 1024 });
    if (completed && active.completedToolCalls.size < 2048) active.completedToolCalls.add(update.toolCallId);
    this._publish({
      known: true, method: "session/update", sessionId: active.sessionId, turnId: active.turnId,
      type: completed ? "tool_result" : "tool_update", itemId: update.toolCallId, toolCallId: update.toolCallId,
      ...contextToolContent({ input: args, ...(completed ? { output: metadata.contextOutput ?? rawOutput } : {}) }, this.registeredSecrets),
      tool: { ...(update.kind ? { kind: update.kind } : {}),
        ...(update.title || update._meta?.mcp ? { name: acpToolName(update) } : {}),
        ...(safeString(update.title, 256) && !ACP_TOOL_TITLE.test(update.title) ? { activityTitle: update.title } : {}),
        ...(status ? { status } : {}),
        ...(completed ? { success: status === "completed" } : {}),
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(metadata.unverified ? { errorCode: "ANTIGRAVITY_NATIVE_TOOL_RESULT_UNAVAILABLE" } : {}),
        ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }) },
      ...(completed && metadata.nativeTiming && metadata.nativeTiming.startedAt >= active.createdAt - 1000
        && metadata.nativeTiming.completedAt <= this.now() + 1000 ? { toolTiming: metadata.nativeTiming }
        : completed && Number.isSafeInteger(metadata.observedAt) ? {
          toolTiming: { source: "antigravity-observed", completedAt: metadata.observedAt } } : {}),
      ...(completed ? {} : { progress: update.status, message: update.title }),
    });
  }

  _publishUnverifiedToolResult(active, update, observedAt) {
    this._diagnostic("ANTIGRAVITY_NATIVE_TOOL_RESULT_UNAVAILABLE");
    this._publishToolUpdate(active, { ...update,
      rawOutput: "未能核实此工具的执行结果；上游错误可能属于其他工具 (ANTIGRAVITY_NATIVE_TOOL_RESULT_UNAVAILABLE)" },
      { observedAt, unverified: true, contextOutput: { resultVerified: false,
        errorCode: "ANTIGRAVITY_NATIVE_TOOL_RESULT_UNAVAILABLE", unverifiedUpstreamOutput: update.rawOutput ?? update.content } });
  }

  _flushToolResults(active, { recover = true, final = true } = {}) {
    clearTimeout(active.nativeResultTimer);
    active.nativeResultTimer = null;
    if (active.timedOut) return;
    const evidence = recover && active.nativeToolCursor !== null && this.nativeToolResults
      ? this.nativeToolResults.reconcile(active.sessionId, active.nativeToolCursor,
        [...active.toolCalls.values()].filter((call) => call && (!active.ambiguousMcpCalls || call.server === null)))
      : { results: new Map(), failures: [] };
    for (const [id, update] of active.pendingToolResults) {
      const native = evidence.results.get(id);
      if (!native && !final) continue;
      if (!native && update.status === "failed") this._publishUnverifiedToolResult(active, update, update.observedAt);
      else {
        if (!native) this._diagnostic("ANTIGRAVITY_NATIVE_TOOL_RESULT_UNAVAILABLE");
        this._publishToolUpdate(active, native ? { ...update, status: native.status, rawOutput: native.output } : update,
          { nativeTiming: native?.timing, observedAt: update.observedAt });
      }
      active.pendingToolResults.delete(id);
      active.pendingToolResultBytes -= update.pendingBytes;
    }
    // A pre-tool hook denial may never have an ACP start. Its own native step
    // proves the attempted tool identity; do not attach it to another open call.
    for (const failure of evidence.failures) {
      if (active.toolCalls.has(failure.id) || active.completedToolCalls.has(failure.id)
        || active.toolCalls.size >= 2048) continue;
      active.toolCalls.set(failure.id, failure);
      const input = safeSnapshot(failure.input, { registeredSecrets: this.registeredSecrets, maxSnapshotBytes: 64 * 1024 });
      this._publish({ known: true, method: "session/update", sessionId: active.sessionId, turnId: active.turnId,
        type: "tool_start", itemId: failure.id, toolCallId: failure.id,
        ...contextToolContent({ input: failure.input }, this.registeredSecrets),
        tool: { kind: "other", name: failure.name, status: "in_progress", input } });
      this._publishToolUpdate(active, { toolCallId: failure.id, title: failure.name, kind: "other",
        status: "failed", rawInput: failure.input, rawOutput: failure.result.output }, { nativeTiming: failure.result.timing });
    }
    if (!final && active.pendingToolResults.size && (active.nativeResultAttempts || 0) < 20) {
      // Native SQLite commits can follow the ACP frame. Retry bounded reads
      // without holding a completed tool open for the rest of the model turn.
      active.nativeResultAttempts = (active.nativeResultAttempts || 0) + 1;
      active.nativeResultTimer = setTimeout(() => {
        if (this.activeTurns.get(active.sessionId) === active) this._flushToolResults(active, { final: false });
      }, Math.min(2000, 250 * active.nativeResultAttempts));
      active.nativeResultTimer.unref?.();
    }
  }

  async _handlePermissionRequest(params) {
    const cancelled = { outcome: { outcome: "cancelled" } };
    const active = this.activeTurns.get(params?.sessionId);
    if (!active || active.timedOut || active.dispatchState !== "write_attempted") return cancelled;
    const options = Array.isArray(params.options) ? params.options.slice(0, 32).filter((option) => plain(option)
      && safeString(option.optionId, 512) && safeString(option.name, 1024) && PERMISSION_KINDS.has(option.kind)) : [];
    const tool = plain(params.toolCall) ? params.toolCall : {};
    if (options.length === 0 || new Set(options.map((option) => option.optionId)).size !== options.length) return cancelled;
    this.authVerified = true;
    this._acceptTurn(active);
    const select = (kinds) => {
      const chosen = kinds.flatMap((kind) => options.filter((option) => option.kind === kind))[0];
      return chosen ? { outcome: { outcome: "selected", optionId: chosen.optionId } } : cancelled;
    };
    // Shoggoth's own product tools are admitted by their per-run lease and
    // approval flow; the runtime prompt would only duplicate that decision.
    if (tool._meta?.mcp?.server === "shoggoth") return select(["allow_once"]);
    if (this.workspaceExecutionVersion === 1) return select(["reject_once", "reject_always"]);
    if (active.readOnly && WRITE_TOOL_KINDS.has(tool.kind)) return select(["reject_once", "reject_always"]);
    if (active.acpMode === ACP_MODES.full) return select(["allow_once", "allow_always"]);
    const method = ["edit", "delete", "move"].includes(tool.kind)
      ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval";
    const handler = this.serverRequestHandlers.get(method);
    if (!handler) return cancelled;
    const resume = this.rpc.pauseRequestTimeout("session/prompt", (promptParams) => promptParams?.sessionId === active.sessionId);
    try {
      const approvalOptions = options.map((option, index) => {
        const firstOfKind = options.findIndex((candidate) => candidate.kind === option.kind) === index;
        const warning = option._meta?.["agy.security.warning"]?.title;
        return {
          choice: firstOfKind && option.kind === "allow_once" ? "once"
            : firstOfKind && option.kind === "reject_once" ? "deny" : `runtime:${index}`,
          label: safeString(warning, 256) ? `${option.name} — ${warning}` : option.name,
          kind: option.kind,
        };
      });
      // The server gives no explanation of its own: the title only restates the
      // tool, so it is neither a reason nor a command.
      const args = acpToolArguments(tool);
      // Never ask the user to approve an empty/truncated command. The shared
      // approval envelope supports 24 KiB with headroom for identity/options.
      if (args?.command !== undefined && !safeString(args.command, 24 * 1024)) {
        throw hostError("ANTIGRAVITY_APPROVAL_COMMAND_TOO_LARGE", "Command cannot be displayed completely; write it to a workspace script before requesting approval");
      }
      const displayArgs = args && { ...args };
      if (displayArgs) delete displayArgs.command;
      const response = await handler({
        sessionId: active.sessionId,
        threadId: active.sessionId,
        turnId: active.turnId,
        itemId: safeString(tool.toolCallId, 512) ? tool.toolCallId : `antigravity-permission-${active.turnId}`,
        ...(args?.command ? { command: args.command } : {}),
        cwd: safeString(args?.cwd, 4096) && path.isAbsolute(args.cwd) ? args.cwd : this._hostCwd(),
        toolName: acpToolName(tool),
        toolInput: displayArgs === undefined ? undefined
          : safeSnapshot(displayArgs, { registeredSecrets: this.registeredSecrets, maxSnapshotBytes: 16 * 1024 }),
        sessionApprovalAvailable: false,
        ...(options.some(option => option._meta?.["agy.security.warning"]) ? { automaticReviewBlocked: true } : {}),
        approvalOptions,
      }, { method, sourceMethod: "session/request_permission" });
      if (response?.decision === "cancel") return cancelled;
      if (response?.approvalChoice !== undefined) {
        const index = approvalOptions.findIndex((option) => option.choice === response.approvalChoice);
        const expected = approvalOptions[index]?.kind.startsWith("allow_") ? "accept" : "decline";
        return index >= 0 && response.decision === expected
          ? { outcome: { outcome: "selected", optionId: options[index].optionId } } : cancelled;
      }
      if (response?.decision === "accept") return select(["allow_once"]);
      if (response?.decision === "decline") return select(["reject_once"]);
      return cancelled;
    } finally {
      resume();
    }
  }

  _acceptTurn(active) {
    if (active.accepted || active.timedOut || active.dispatchState !== "write_attempted") return;
    const timestamp = this.now();
    this.ledger.update((data) => {
      const session = sessionById(data, active.sessionId);
      const turn = turnById(session, active.turnId);
      if (!turn || turn.acceptance !== "unknown") {
        throw hostError("RUNTIME_TURN_RECEIPT_CONFLICT", "Antigravity turn receipt is inconsistent");
      }
      turn.acceptance = "accepted";
      turn.updatedAt = Math.max(turn.updatedAt, timestamp);
      session.updatedAt = Math.max(session.updatedAt, timestamp);
    });
    active.accepted = true;
    active.promptCommit?.();
    this._clearLive(active.turnId);
    clearTimeout(active.timer);
    active.timer = null;
    active.acceptance.resolve({ turn: { id: active.turnId, status: "inProgress", items: [] } });
  }

  _markAcceptanceUnknown(active, cause = null) {
    if (active.accepted || active.timedOut || this.activeTurns.get(active.sessionId) !== active) return;
    if (active.dispatchState === "not_sent") {
      this._failPrompt(active, cause || hostError("RUNTIME_REQUEST_NOT_SENT", "Antigravity request was not sent"));
      return;
    }
    active.timedOut = true;
    const error = hostError("RUNTIME_TURN_ACCEPTANCE_UNKNOWN", "Antigravity did not prove turn acceptance");
    error.dispatchState = active.dispatchState;
    const timestamp = this.now();
    try {
      this.ledger.update((data) => {
        const session = sessionById(data, active.sessionId);
        const turn = turnById(session, active.turnId);
        turn.status = "interrupted";
        turn.errorCode = cause?.code || error.code;
        turn.updatedAt = Math.max(turn.updatedAt, timestamp);
        session.updatedAt = Math.max(session.updatedAt, timestamp);
      });
    } catch (ledgerFailure) {
      active.acceptance.reject(ledgerFailure);
      active.terminal.reject(ledgerFailure);
      void this._fatal(ledgerFailure);
      return;
    }
    active.acceptance.reject(error);
    active.terminal.reject(error);
    this.rpc?.notify("session/cancel", { sessionId: active.sessionId }).catch(() => {});
  }

  async _finishPrompt(active, response) {
    if (this.activeTurns.get(active.sessionId) !== active) return;
    if (!plain(response) || !STOP_REASONS.has(response.stopReason)) {
      throw hostError("ANTIGRAVITY_ACP_PROMPT_RESPONSE_INVALID", "Antigravity prompt response is invalid");
    }
    // In-band failures are only visible on stderr, which races stdout.
    if (!active.failureCode && response.stopReason !== "cancelled") await delay(STDERR_SETTLE_MS);
    if (this.activeTurns.get(active.sessionId) !== active) return;
    if (!active.timedOut) this._acceptTurn(active);
    this._flushToolResults(active);
    const failureCode = active.failureCode;
    if (!failureCode && response.stopReason === "end_turn") this.authVerified = true;
    const status = failureCode ? "failed"
      : response.stopReason === "end_turn" ? "completed"
        : response.stopReason === "cancelled" ? "canceled" : "failed";
    const errorCode = status === "failed" ? (failureCode || `ANTIGRAVITY_STOP_${response.stopReason.toUpperCase()}`) : null;
    let text = active.text;
    if (status === "canceled" && text.endsWith(CANCELLED_NOTICE)) text = text.slice(0, -CANCELLED_NOTICE.length).trimEnd();
    // The server's own error explanation is not an answer to the user.
    if (failureCode) text = "";
    const itemId = `antigravity-message-${active.turnId}`;
    const timestamp = this.now();
    this.ledger.update((data) => {
      const session = sessionById(data, active.sessionId);
      const turn = turnById(session, active.turnId);
      turn.acceptance = "accepted";
      turn.status = status;
      turn.errorCode = errorCode;
      turn.assistantMessages = text.length > 0 ? [{ id: itemId, text }] : [];
      turn.updatedAt = Math.max(turn.updatedAt, timestamp);
      session.updatedAt = Math.max(session.updatedAt, timestamp);
    });
    this._clearLive(active.turnId);
    clearTimeout(active.timer);
    this.activeTurns.delete(active.sessionId);
    if (active.timedOut) return;
    const common = { known: true, method: "session/update", sessionId: active.sessionId, turnId: active.turnId };
    if (text.length > 0) {
      this._publish({ ...common, type: "text", itemId, text, phase: "final_answer", delivery: "local" });
    }
    this._publish({ ...common, method: "session/prompt", type: "complete", status, ...(errorCode ? { errorCode } : {}) });
    active.terminal.resolve({ status });
  }

  _failPrompt(active, error) {
    if (this.activeTurns.get(active.sessionId) !== active) return;
    this._flushToolResults(active, { recover: false });
    if (!error?.dispatchState) {
      const original = error;
      error = hostError(original?.code || "ANTIGRAVITY_TURN_FAILED", "Antigravity prompt failed");
      error.dispatchState = active.dispatchState;
      if (original?.remote === true) error.remote = true;
    }
    clearTimeout(active.timer);
    active.timer = null;
    // Only an unsent frame or an explicit error reply proves the turn did not run;
    // timeouts and lost connections leave the outcome unknown.
    const explicit = active.dispatchState === "not_sent" || error.dispatchState === "not_sent"
      || error.remote === true;
    if (active.timedOut && !explicit) {
      this.activeTurns.delete(active.sessionId);
      active.terminal.reject(error);
      return;
    }
    if (!active.accepted && !explicit) {
      this._markAcceptanceUnknown(active, error);
      return;
    }
    const timestamp = this.now();
    const status = !active.accepted || explicit ? "failed" : "interrupted";
    this.ledger.update((data) => {
      const session = sessionById(data, active.sessionId);
      const turn = turnById(session, active.turnId);
      if (!active.accepted) turn.acceptance = "failed";
      turn.status = status;
      turn.errorCode = error.code;
      turn.updatedAt = Math.max(turn.updatedAt, timestamp);
      session.updatedAt = Math.max(session.updatedAt, timestamp);
    });
    this._clearLive(active.turnId);
    if (status === "interrupted") {
      try { this.rpc?.notify("session/cancel", { sessionId: active.sessionId })?.catch?.(() => {}); } catch {}
    }
    this.activeTurns.delete(active.sessionId);
    if (!active.accepted) active.acceptance.reject(error);
    active.terminal.reject(error);
    this._publish({
      known: true, method: "session/prompt", type: "complete", sessionId: active.sessionId,
      turnId: active.turnId, status, errorCode: error.code,
    });
  }

  async _fatal(error) {
    if (this.state === "failed" || this.state === "stopped") return;
    this.fatalError = error?.code ? error : hostError("ANTIGRAVITY_RUNTIME_FAILED", "Antigravity runtime failed");
    this.state = "failed";
    for (const active of [...this.activeTurns.values()]) {
      try { this._failPrompt(active, this.fatalError); } catch { active.terminal.reject(this.fatalError); }
    }
    try { await this._stopProcess(true); } catch { this.cleanupIncomplete = true; }
    this.rejectTerminated(this.fatalError);
  }

  stop() {
    if (this.stopping) return this.stopping;
    if (this.state === "stopped") return Promise.resolve();
    this.state = "stopping";
    this.stopping = this._stopProcess(false).then(() => {
      this.state = "stopped";
      this.resolveTerminated();
    }, (error) => {
      this.state = "failed";
      this.rejectTerminated(error);
      throw error;
    });
    return this.stopping;
  }

  async _stopProcess(fromFatal) {
    this.sessionResumeAttempts.clear();
    for (const reservationId of [...this.ownedMcpReservations]) this._revokeMcpTicket(reservationId);
    this.mcpReservations.clear();
    this.keychainAbort?.abort();
    await this.keychainPreparation?.catch(() => {});
    const termination = hostError("RUNTIME_HOST_TERMINATED", "Antigravity host stopped");
    for (const active of [...this.activeTurns.values()]) {
      clearTimeout(active.timer);
      if (!active.timedOut) this._failPrompt(active, termination);
    }
    this.activeTurns.clear();
    try { await this.rpc?.terminate(); } catch {}
    const child = this.child;
    if (!child) { this.workspaceExecutionHome?.dispose(); this.workspaceExecutionHome = null; return; }
    let exists = !this.childClosed;
    if (!exists) { try { exists = this.processGroupExists(child.pid); } catch { exists = true; } }
    if (exists) {
      try { this.killProcessGroup(child.pid, "SIGTERM"); } catch {}
      if (this.childClosed) await delay(this.shutdownGraceMs);
      else await Promise.race([this.childClose, delay(this.shutdownGraceMs)]);
    }
    try { exists = this.processGroupExists(child.pid); } catch { exists = true; }
    if (exists) {
      try { this.killProcessGroup(child.pid, "SIGKILL"); } catch {}
      await delay(this.killGraceMs);
    }
    try { exists = this.processGroupExists(child.pid); } catch { exists = true; }
    if (exists) {
      this.cleanupIncomplete = true;
      const cleanup = hostError("ANTIGRAVITY_PROCESS_CLOSE_TIMEOUT", "Antigravity process cleanup is incomplete");
      cleanup.cleanupIncomplete = true;
      if (!fromFatal) throw cleanup;
      return;
    }
    // Nothing this process received can run any more; unknown receipts remain
    // fences for their own operations only.
    this._releaseLiveTurns();
    this.workspaceExecutionHome?.dispose();
    this.workspaceExecutionHome = null;
  }
}

module.exports = {
  ACP_MODES,
  ACP_NAMING,
  AntigravityAcpRuntimeHost,
  acpToolArguments,
  acpToolName,
  antigravityAcpSpawnEnvironment,
  classifyAntigravityFailure,
  modelCatalogFromConfig,
};
