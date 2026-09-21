"use strict";

const { imageAttachments } = require("./chat-attachments");

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { GrokBuildAcpJsonlClient } = require("./grok-build-acp-jsonl");
const { safeSnapshot } = require("./codex-event-snapshot");
const { GrokBuildRuntimeLedger } = require("./grok-build-runtime-ledger");
const { readGrokUsage } = require("./grok-build-usage");
const {
  GROK_BUILD_RUNTIME,
  buildGrokBuildArgs,
  grokBuildWorkspaceShardId,
  normalizeGrokBuildPermissionPolicy,
  normalizeGrokBuildWorkspace,
  resolveGrokBuildBinary,
  resolveGrokBuildExecutable,
} = require("./grok-build-runtime-paths");
const { validateRegisteredSecrets } = require("./codex-rpc-safety");
const { runtimeBinding, validRuntimeProfileId } = require("./runtime-adapter");
const {
  normalizeRuntimeCommands,
  parseRuntimeCommand,
} = require("./runtime-commands");
const { mergeNativeCommands, requireRuntimeCommand } = require("./native-cli-commands");
const { validateResolvedEnvironment } = require("./runtime-account-resolver");
const { serviceError } = require("./security");

const PARENT_ENV_ALLOWLIST = Object.freeze([
  "HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "USER", "LOGNAME", "SHELL",
]);
const PROXY_ENV_KEYS = Object.freeze([
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
]);
const PROXY_URL_ENV_KEYS = new Set([
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
]);
const FIXED_NO_PROXY = Object.freeze(["localhost", "127.0.0.1", "::1", ".local"]);
const GROK_BUILD_PROXY_TARGET_URL = "https://cli-chat-proxy.grok.com/v1/responses";
const MAX_PROXY_RESOLUTION_BYTES = 16 * 1024;
const MAX_PROXY_URL_BYTES = 4096;
const GROK_COMPAT_DISABLE_ENV = Object.freeze(
  ["CLAUDE", "CURSOR", "CODEX"].flatMap((agent) => (
    ["SKILLS", "RULES", "AGENTS", "MCPS", "HOOKS", "SESSIONS"]
      .map((surface) => `GROK_${agent}_${surface}_ENABLED`)
  )),
);
const RESERVED_ENV = new Set([
  "GROK_HOME", "HOME", "PATH", "TMPDIR", ...PROXY_ENV_KEYS, ...GROK_COMPAT_DISABLE_ENV,
]);
const STOP_REASONS = new Set(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]);
const PERMISSION_KINDS = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);
const TOOL_KINDS = new Set([
  "read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other",
]);
const TOOL_STATUSES = new Set(["pending", "in_progress", "completed", "failed"]);
const PLAN_PRIORITIES = new Set(["high", "medium", "low"]);
const PLAN_STATUSES = new Set(["pending", "in_progress", "completed"]);
const MAX_ASSISTANT_MESSAGE_BYTES = 1024 * 1024;
const MAX_TURN_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_TURN_MESSAGES = 1024;
const SESSION_UPDATE_KINDS = new Set([
  "user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call",
  "tool_call_update", "plan", "available_commands_update", "current_mode_update",
  "config_option_update", "session_info_update", "usage_update",
]);
const TURN_ACCEPTANCE_UPDATE_KINDS = new Set([
  "user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "plan",
]);
// ACP auth methods are interaction-capable unless a specific protocol method has been
// verified non-interactive. Grok 1.0.13's `grok.com` method starts OAuth/device auth.
const EAGER_HEADLESS_AUTH_METHOD_IDS = new Set();
const GROK_BUILD_BOOTSTRAP_COMMANDS = normalizeRuntimeCommands([
  { name: "compact", description: "Compact conversation history", args: "[instructions]" },
  { name: "context", description: "Show current context usage" },
  { name: "review", description: "Review the current code changes", args: "[instructions]" },
  { name: "skills", description: "List or invoke available skills", args: "[skill]" },
]);

function hostError(code, message) {
  return serviceError(code, message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeString(value, maxBytes, { empty = false, absolute = false } = {}) {
  return typeof value === "string" && (empty || value.length > 0) && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes
    && (!absolute || path.isAbsolute(value));
}

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function defined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function namedSecretValues(entries) {
  const candidates = [];
  for (const [name, value] of Object.entries(entries)) {
    if (/(?:authorization|cookie|credential|nonce|password|secret|token|api[_-]?key)/iu.test(name)
      && typeof value === "string" && Buffer.byteLength(value, "utf8") >= 4) {
      candidates.push(value);
    }
  }
  return candidates;
}

function sessionById(data, sessionId) {
  return data.sessions.find((session) => session.id === sessionId) || null;
}

function turnByOperation(session, operationId) {
  return session?.turns.find((turn) => turn.operationId === operationId) || null;
}

function turnById(session, turnId) {
  return session?.turns.find((turn) => turn.id === turnId) || null;
}

function inputFingerprint(input) {
  return crypto.createHash("sha256").update(JSON.stringify([
    input.sessionId,
    input.operationId,
    input.prompt,
    input.context ?? null,
    input.model ?? null,
    input.cwd ?? null,
    input.permissionPolicy ?? null,
    input.permissionMode ?? null,
  ])).digest("hex");
}

function normalizePermissionMode(value) {
  const mode = value || "ask";
  if (!["ask", "auto", "always-approve"].includes(mode)) {
    throw hostError("RUNTIME_PERMISSION_POLICY_INVALID", "Grok Build permission mode is invalid");
  }
  return mode;
}

function permissionMeta(mode) {
  return { yoloMode: mode === "always-approve", autoMode: mode === "auto" };
}

function makeDeferred() {
  const deferred = { settled: false, resolve: null, reject: null, promise: null };
  deferred.promise = new Promise((resolve, reject) => {
    deferred.resolve = (value) => {
      if (deferred.settled) return false;
      deferred.settled = true;
      resolve(value);
      return true;
    };
    deferred.reject = (error) => {
      if (deferred.settled) return false;
      deferred.settled = true;
      reject(error);
      return true;
    };
  });
  deferred.promise.catch(() => {});
  return deferred;
}

function validateHeaderEntry(value, label) {
  if (!plain(value) || Object.keys(value).some((key) => !["name", "value"].includes(key))
    || !safeString(value.name, 256) || !safeString(value.value, 16 * 1024, { empty: true })) {
    throw hostError("GROK_BUILD_MCP_INVALID", `Grok Build ${label} is invalid`);
  }
  return { name: value.name, value: value.value };
}

function validateHttpHeaderEntry(value) {
  const entry = validateHeaderEntry(value, "MCP header");
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(entry.name)
    || /[\r\n]/u.test(entry.value)) {
    throw hostError("GROK_BUILD_MCP_INVALID", "Grok Build MCP header is unsafe");
  }
  return entry;
}

function validateEnvEntry(value) {
  const entry = validateHeaderEntry(value, "MCP environment entry");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry.name)) {
    throw hostError("GROK_BUILD_MCP_INVALID", "Grok Build MCP environment name is invalid");
  }
  return entry;
}

function optionalSafeString(value, maxBytes) {
  return value === undefined || value === null || safeString(value, maxBytes, { empty: true });
}

function validContentChunk(update) {
  if (!plain(update.content) || update.content.type !== "text"
    || !optionalSafeString(update.messageId, 512)) return false;
  return safeString(update.content.text, MAX_ASSISTANT_MESSAGE_BYTES, { empty: true });
}

function validToolUpdate(update, creation) {
  return safeString(update.toolCallId, 512)
    && (!creation || safeString(update.title, 16 * 1024))
    && optionalSafeString(update.title, 16 * 1024)
    && (update.kind === undefined || update.kind === null || TOOL_KINDS.has(update.kind))
    && (update.status === undefined || update.status === null || TOOL_STATUSES.has(update.status));
}

function validPlan(update) {
  return Array.isArray(update.entries) && update.entries.length <= 256
    && update.entries.every((entry) => plain(entry)
      && safeString(entry.content, 16 * 1024)
      && PLAN_PRIORITIES.has(entry.priority)
      && PLAN_STATUSES.has(entry.status));
}

function validAuxiliaryUpdate(update) {
  if (update.sessionUpdate === "available_commands_update") {
    return Array.isArray(update.availableCommands) && update.availableCommands.length <= 256
      && update.availableCommands.every((command) => plain(command)
        && safeString(command.name, 512) && safeString(command.description, 16 * 1024));
  }
  if (update.sessionUpdate === "current_mode_update") {
    return safeString(update.currentModeId, 512);
  }
  if (update.sessionUpdate === "config_option_update") {
    return Array.isArray(update.configOptions) && update.configOptions.length <= 256
      && update.configOptions.every(plain);
  }
  if (update.sessionUpdate === "session_info_update") {
    return optionalSafeString(update.title, 16 * 1024)
      && optionalSafeString(update.updatedAt, 256);
  }
  if (update.sessionUpdate === "usage_update") {
    return Number.isSafeInteger(update.used) && update.used >= 0
      && Number.isSafeInteger(update.size) && update.size >= 0;
  }
  return false;
}

function validSessionUpdate(update) {
  if (!plain(update) || !SESSION_UPDATE_KINDS.has(update.sessionUpdate)) return false;
  if (["user_message_chunk", "agent_message_chunk", "agent_thought_chunk"]
    .includes(update.sessionUpdate)) return validContentChunk(update);
  if (update.sessionUpdate === "tool_call") return validToolUpdate(update, true);
  if (update.sessionUpdate === "tool_call_update") return validToolUpdate(update, false);
  if (update.sessionUpdate === "plan") return validPlan(update);
  return validAuxiliaryUpdate(update);
}

function validateMcpServer(value, fileSystem = fs) {
  if (!plain(value) || !safeString(value.name, 256)) {
    throw hostError("GROK_BUILD_MCP_INVALID", "Grok Build MCP descriptor is invalid");
  }
  if (value.type === "http" || value.type === "sse") {
    if (Object.keys(value).some((key) => !["type", "name", "url", "headers", "_meta"].includes(key))
      || !safeString(value.url, 4096) || !Array.isArray(value.headers)
      || value.headers.length > 128) {
      throw hostError("GROK_BUILD_MCP_INVALID", "Grok Build MCP network descriptor is invalid");
    }
    let parsed;
    try { parsed = new URL(value.url); } catch {
      throw hostError("GROK_BUILD_MCP_INVALID", "Grok Build MCP URL is invalid");
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw hostError("GROK_BUILD_MCP_INVALID", "Grok Build MCP URL is unsafe");
    }
    return defined({
      type: value.type,
      name: value.name,
      url: value.url,
      headers: value.headers.map(validateHttpHeaderEntry),
      _meta: value._meta === undefined ? undefined : structuredClone(value._meta),
    });
  }
  if (value.type !== undefined && value.type !== "stdio") {
    throw hostError("GROK_BUILD_MCP_INVALID", "Grok Build MCP transport is invalid");
  }
  if (Object.keys(value).some((key) => !["type", "name", "command", "args", "env", "_meta"].includes(key))
    || !safeString(value.command, 4096, { absolute: true })
    || !Array.isArray(value.args) || value.args.length > 256
    || value.args.some((item) => !safeString(item, 16 * 1024, { empty: true }))
    || !Array.isArray(value.env) || value.env.length > 256) {
    throw hostError("GROK_BUILD_MCP_INVALID", "Grok Build MCP stdio descriptor is invalid");
  }
  return defined({
    type: value.type,
    name: value.name,
    command: resolveGrokBuildExecutable(value.command, {
      fs: fileSystem,
      code: "GROK_BUILD_MCP_INVALID",
      message: "Grok Build MCP command must be an absolute executable regular file",
    }),
    args: [...value.args],
    env: value.env.map(validateEnvEntry),
    _meta: value._meta === undefined ? undefined : structuredClone(value._meta),
  });
}

function modelCatalogFromInitialize(response) {
  const state = response?._meta?.modelState;
  if (!plain(state) || !Array.isArray(state.availableModels)) return Object.freeze({ current: null, models: [] });
  const models = [];
  const seen = new Set();
  for (const item of state.availableModels) {
    const model = item?.modelId;
    if (!safeString(model, 512) || seen.has(model)) continue;
    const displayName = safeString(item.name, 512) ? item.name : model;
    const description = typeof item.description === "string" && item.description.isWellFormed()
      && !item.description.includes("\0") && Buffer.byteLength(item.description, "utf8") <= 4096
      ? item.description : "";
    seen.add(model);
    models.push(Object.freeze({ model, displayName, description }));
  }
  const current = safeString(state.currentModelId, 512) && seen.has(state.currentModelId)
    ? state.currentModelId : null;
  return Object.freeze({ current, models: Object.freeze(models) });
}

function validProxyHost(value) {
  if (!safeString(value, 253) || !/^[0-9A-Za-z.-]+$/u.test(value)) return false;
  if (net.isIP(value) === 4 || value.toLowerCase() === "localhost") return true;
  if (/^\d+(?:\.\d+){3}$/u.test(value)) return false;
  return value.split(".").every((label) => label.length > 0 && label.length <= 63
    && /^[0-9A-Za-z](?:[0-9A-Za-z-]*[0-9A-Za-z])?$/u.test(label));
}

function parseProxyAuthority(value) {
  if (!safeString(value, 1024) || /[\r\n\0\s/@?#]/u.test(value)) return null;
  const ipv6 = /^\[([^\]]+)\]:(\d{1,5})$/u.exec(value);
  if (ipv6) {
    const port = Number(ipv6[2]);
    if (net.isIP(ipv6[1]) !== 6 || port < 1 || port > 65_535) return null;
    return `[${ipv6[1].toLowerCase()}]:${port}`;
  }
  const hostAndPort = /^([^:]+):(\d{1,5})$/u.exec(value);
  if (!hostAndPort || !validProxyHost(hostAndPort[1])) return null;
  const port = Number(hostAndPort[2]);
  if (port < 1 || port > 65_535) return null;
  return `${hostAndPort[1].toLowerCase()}:${port}`;
}

function parseResolvedProxy(value) {
  if (!safeString(value, MAX_PROXY_RESOLUTION_BYTES)
    || /[\r\n\0]/u.test(value)) return null;
  for (const rawCandidate of value.split(";")) {
    const candidate = rawCandidate.trim();
    if (/^DIRECT$/iu.test(candidate)) return Object.freeze({ kind: "direct" });
    const match = /^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(\S+)$/iu.exec(candidate);
    if (!match) continue;
    const authority = parseProxyAuthority(match[2]);
    if (!authority) continue;
    const kind = match[1].toUpperCase();
    const scheme = kind === "PROXY" ? "http"
      : kind === "HTTPS" ? "https"
        : kind === "SOCKS4" ? "socks4" : "socks5";
    return Object.freeze({ kind: "proxy", family: kind, url: `${scheme}://${authority}` });
  }
  return null;
}

function baseNoProxyEnvironment() {
  const value = FIXED_NO_PROXY.join(",");
  return { NO_PROXY: value, no_proxy: value };
}

function resolvedProxyEnvironment(candidate) {
  const env = baseNoProxyEnvironment();
  if (candidate.kind === "direct") return env;
  if (["PROXY", "HTTPS"].includes(candidate.family)) {
    env.HTTP_PROXY = candidate.url;
    env.HTTPS_PROXY = candidate.url;
    env.http_proxy = candidate.url;
    env.https_proxy = candidate.url;
  } else {
    env.ALL_PROXY = candidate.url;
    env.all_proxy = candidate.url;
  }
  return env;
}

function validExplicitProxyPort(value) {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd < 1) return false;
  const remainder = value.slice(schemeEnd + 3);
  const boundary = remainder.search(/[/?#]/u);
  const authority = boundary < 0 ? remainder : remainder.slice(0, boundary);
  const match = authority.startsWith("[")
    ? /^\[[^\]]+\](?::(\d+))?$/u.exec(authority)
    : /^[^:]+(?::(\d+))?$/u.exec(authority);
  if (!match) return false;
  if (match[1] === undefined) return true;
  const port = Number(match[1]);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535;
}

function validProxyUrl(value, name) {
  if (!safeString(value, MAX_PROXY_URL_BYTES) || value !== value.trim()
    || /[\r\n\0]/u.test(value) || !validExplicitProxyPort(value)) return false;
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  const allowed = name.toUpperCase() === "ALL_PROXY"
    ? new Set(["http:", "https:", "socks:", "socks4:", "socks5:", "socks5h:"])
    : new Set(["http:", "https:"]);
  if (!allowed.has(parsed.protocol) || parsed.username || parsed.password
    || (parsed.pathname !== "" && parsed.pathname !== "/")
    || parsed.search || parsed.hash) return false;
  const hostname = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
    ? parsed.hostname.slice(1, -1) : parsed.hostname;
  return net.isIP(hostname) !== 0 || validProxyHost(hostname);
}

function normalizeNoProxyToken(value) {
  if (!safeString(value, 512) || /[\r\n\0@?#]/u.test(value)) return null;
  if (value === "*" || value.toLowerCase() === "<local>") return value.toLowerCase();
  const cidr = /^(.+)\/(\d{1,3})$/u.exec(value);
  if (cidr) {
    const family = net.isIP(cidr[1]);
    const prefix = Number(cidr[2]);
    if ((family === 4 && prefix <= 32) || (family === 6 && prefix <= 128)) {
      return `${cidr[1].toLowerCase()}/${prefix}`;
    }
    return null;
  }
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/u.exec(value);
  if (bracketed) {
    const port = bracketed[2] === undefined ? null : Number(bracketed[2]);
    if (net.isIP(bracketed[1]) !== 6 || (port !== null && (port < 1 || port > 65_535))) {
      return null;
    }
    return `[${bracketed[1].toLowerCase()}]${port === null ? "" : `:${port}`}`;
  }
  if (net.isIP(value) !== 0) return value.toLowerCase();
  let host = value;
  let port = null;
  const hostPort = /^(.+):(\d{1,5})$/u.exec(value);
  if (hostPort && !hostPort[1].includes(":")) {
    host = hostPort[1];
    port = Number(hostPort[2]);
    if (port < 1 || port > 65_535) return null;
  }
  const prefix = host.startsWith("*.") ? "*." : host.startsWith(".") ? "." : "";
  const bareHost = prefix === "*." ? host.slice(2) : prefix === "." ? host.slice(1) : host;
  if (!validProxyHost(bareHost)) return null;
  return `${prefix}${bareHost.toLowerCase()}${port === null ? "" : `:${port}`}`;
}

function normalizeNoProxy(value) {
  if (value === undefined) return [];
  if (!safeString(value, MAX_PROXY_RESOLUTION_BYTES, { empty: true })
    || /[\r\n\0]/u.test(value)) return [];
  const values = value.split(",");
  if (values.length > 256) return [];
  const normalized = [];
  for (const item of values) {
    const token = normalizeNoProxyToken(item.trim());
    if (!token) return [];
    normalized.push(token);
  }
  return normalized;
}

function fallbackProxyEnvironment(parentEnv) {
  const env = {};
  for (const name of PROXY_URL_ENV_KEYS) {
    const value = parentEnv[name];
    if (validProxyUrl(value, name)) env[name] = value;
  }
  for (const name of ["NO_PROXY", "no_proxy"]) {
    const entries = [...FIXED_NO_PROXY, ...normalizeNoProxy(parentEnv[name])];
    env[name] = [...new Set(entries)].join(",");
  }
  return env;
}

function runtimePath(parentPath, home) {
  const entries = typeof parentPath === "string"
    ? parentPath.split(path.delimiter).filter((entry) => entry.length > 0)
    : ["/usr/bin", "/bin"];
  const safeHome = safeString(home, 4096, { absolute: true }) ? home : null;
  const localBin = safeHome ? path.join(safeHome, ".local", "bin") : null;
  if (localBin && !entries.includes(localBin)) entries.push(localBin);
  return entries.join(path.delimiter);
}

async function resolveSpawnProxyEnvironment(options) {
  const parentEnv = options.parentEnv || process.env;
  if (options.resolveProxy === undefined) return fallbackProxyEnvironment(parentEnv);
  let resolved;
  let timeout;
  try {
    const configuredTimeout = options.initializeTimeoutMs;
    const timeoutMs = Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0
      ? Math.min(configuredTimeout, 5_000) : 5_000;
    resolved = await Promise.race([
      Promise.resolve().then(() => options.resolveProxy(GROK_BUILD_PROXY_TARGET_URL)),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("proxy resolver timed out")), timeoutMs);
      }),
    ]);
  } catch {
    try { options.onDiagnostic?.({ code: "GROK_BUILD_PROXY_RESOLVE_FAILED" }); } catch {}
    return fallbackProxyEnvironment(parentEnv);
  } finally {
    clearTimeout(timeout);
  }
  const candidate = parseResolvedProxy(resolved);
  if (candidate) return resolvedProxyEnvironment(candidate);
  try { options.onDiagnostic?.({ code: "GROK_BUILD_PROXY_RESOLVE_INVALID" }); } catch {}
  return fallbackProxyEnvironment(parentEnv);
}

async function buildSpawnEnv(runtimeEnvironment, options) {
  const parentEnv = options.parentEnv || process.env;
  const env = {};
  for (const key of PARENT_ENV_ALLOWLIST) {
    if (safeString(parentEnv[key], 64 * 1024, { empty: true })) env[key] = parentEnv[key];
  }
  env.PATH = runtimePath(env.PATH, options.homedir || os.homedir());
  env.TMPDIR ||= os.tmpdir();
  Object.assign(env, await resolveSpawnProxyEnvironment(options));
  for (const [key, value] of Object.entries(options.spawnEnv || {})) {
    if (RESERVED_ENV.has(key) || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
      || !safeString(value, 64 * 1024, { empty: true })) {
      throw hostError("GROK_BUILD_SPAWN_ENV_INVALID", "Grok Build spawn environment is invalid");
    }
    env[key] = value;
  }
  env.HOME = runtimeEnvironment.spawnEnv.HOME;
  env.GROK_HOME = runtimeEnvironment.spawnEnv.GROK_HOME;
  for (const key of GROK_COMPAT_DISABLE_ENV) env[key] = "false";
  return Object.freeze(env);
}

function defaultKillProcessGroup(pid, signal) {
  try { process.kill(process.platform === "win32" ? pid : -pid, signal); } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function defaultProcessGroupExists(pid) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

class GrokBuildRuntimeHost {
  constructor(options = {}) {
    this.options = { ...options, spawnEnv: { ...(options.spawnEnv || {}) } };
    this.fs = options.fs || fs;
    if (options.resolveProxy !== undefined && typeof options.resolveProxy !== "function") {
      throw hostError("GROK_BUILD_PROXY_RESOLVER_INVALID", "Grok Build proxy resolver is invalid");
    }
    if (options.authProof !== undefined && (!options.authProof
      || typeof options.authProof.read !== "function"
      || typeof options.authProof.verify !== "function"
      || typeof options.authProof.invalidate !== "function"
      || typeof options.authProof.clear !== "function")) {
      throw hostError("GROK_BUILD_AUTH_PROOF_INVALID", "Grok Build auth proof store is invalid");
    }
    this.authProof = options.authProof || null;
    if (!validRuntimeProfileId(options.runtimeProfileId)) {
      throw hostError("GROK_BUILD_RUNTIME_PROFILE_INVALID", "Grok Build runtime profile id is invalid");
    }
    this.binding = runtimeBinding(options.runtimeBinding || {
      runtime: GROK_BUILD_RUNTIME,
      runtimeProfileId: options.runtimeProfileId,
      runtimeAccountId: options.runtimeAccountId,
    });
    this.runtimeProfileId = this.binding.runtimeProfileId;
    this.runtimeAccountId = this.binding.runtimeAccountId;
    this.runtimeEnvironment = validateResolvedEnvironment(options.runtimeEnvironment, this.binding);
    this.permissionPolicy = normalizeGrokBuildPermissionPolicy(options.permissionPolicy);
    if (options.controlInstance !== undefined && typeof options.controlInstance !== "boolean") {
      throw hostError("GROK_BUILD_WORKSPACE_INVALID", "Grok Build control instance flag is invalid");
    }
    this.controlInstance = options.controlInstance ?? (options.workspace === undefined);
    if (this.controlInstance && options.workspace !== undefined && options.workspace !== null) {
      throw hostError("GROK_BUILD_WORKSPACE_INVALID", "Grok Build control instance cannot own a workspace");
    }
    this.workspace = this.controlInstance ? null : normalizeGrokBuildWorkspace(options.workspace);
    if (!this.controlInstance && this.workspace === null
      && this.permissionPolicy.sandbox !== "read-only") {
      throw hostError(
        "WORKSPACE_REQUIRED_FOR_WRITABLE_RUN",
        "Writable Grok Build execution requires an explicit workspace",
      );
    }
    this.workspaceShardId = grokBuildWorkspaceShardId({
      controlInstance: this.controlInstance,
      workspace: this.workspace,
    });
    this.spawnProcess = options.spawnProcess || spawn;
    this.killProcessGroup = options.killProcessGroup || defaultKillProcessGroup;
    this.processGroupExists = options.processGroupExists || defaultProcessGroupExists;
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? 30_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 90_000;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 30 * 60 * 1_000;
    // Grok can wait on initial inference before emitting a turn update.
    this.acceptanceTimeoutMs = options.acceptanceTimeoutMs ?? 90_000;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 2_000;
    this.killGraceMs = options.killGraceMs ?? 1_000;
    this.packageVersion = String(options.packageVersion || "0.0.0");
    this.state = "idle";
    this.startupStage = "process_spawn";
    this.child = null;
    this.binaryPath = null;
    this.runtimeHome = null;
    this.childClosed = false;
    this.rpc = null;
    this.initializedResponse = null;
    this.authenticated = false;
    this.authMethods = [];
    this.headlessAuthMethodIds = new Set();
    this.authMethodId = null;
    this.authAttemptFingerprint = null;
    this.authenticatedFingerprint = null;
    this.authRejectedFingerprint = null;
    this.authRefresh = null;
    this.modelCatalog = Object.freeze({ current: null, models: [] });
    this.agentCapabilities = {};
    this.sessionConfigs = new Map();
    this.commandCatalogs = new Map();
    this.lastNativePromptIds = new Map();
    this.activeTurns = new Map();
    this.subscribers = new Set();
    this.serverRequestHandlers = new Map();
    this.starting = null;
    this.stopping = null;
    this.fatalError = null;
    this.cleanupIncomplete = false;
    this.baseRegisteredSecrets = validateRegisteredSecrets([
      ...(options.registeredSecrets || []),
      ...namedSecretValues(options.spawnEnv || {}),
    ]);
    this.registeredSecrets = [...this.baseRegisteredSecrets];
    const paths = options.paths || {
      stateDir: options.stateRoot ? path.dirname(path.dirname(options.stateRoot)) : "",
      trustedRoot: options.trustedRoot,
    };
    const expectedStateRoot = path.join(
      paths.stateDir || "", "runtime-ledgers", GROK_BUILD_RUNTIME,
    );
    if (options.stateRoot !== undefined && path.resolve(options.stateRoot) !== path.resolve(expectedStateRoot)) {
      throw hostError(
        "GROK_BUILD_PATHS_INVALID",
        "Grok Build stateRoot must be <stateDir>/runtime-ledgers/grok-build",
      );
    }
    this.paths = Object.freeze({ stateDir: paths.stateDir, trustedRoot: paths.trustedRoot });
    this.ledger = options.ledger || new GrokBuildRuntimeLedger({
      fs: this.fs,
      runtimeProfileId: this.runtimeProfileId,
      workspaceShardId: this.workspaceShardId,
      stateRoot: expectedStateRoot,
      trustedRoot: paths.trustedRoot,
    });
    if (this.ledger.workspaceShardId !== this.workspaceShardId) {
      throw hostError("GROK_BUILD_PATHS_INVALID", "Grok Build ledger workspace shard is invalid");
    }
    this.terminated = new Promise((resolve, reject) => {
      this.resolveTerminated = resolve;
      this.rejectTerminated = reject;
    });
    this.terminated.catch(() => {});
  }

  initialize() {
    if (this.state === "ready") return Promise.resolve(this.initializedResponse);
    if (this.starting) return this.starting;
    if (this.state !== "idle") {
      return Promise.reject(hostError("GROK_BUILD_HOST_NOT_STARTABLE", "Grok Build host cannot start"));
    }
    this.state = "starting";
    this.starting = this._start().catch(async (error) => {
      await this._fatal(error);
      throw error;
    });
    return this.starting;
  }

  async _start() {
    this.ledger.open();
    const runtimeHome = this.runtimeEnvironment.home;
    const ledgerRelative = path.relative(runtimeHome, this.ledger.ledgerPath);
    if (ledgerRelative === "" || (!ledgerRelative.startsWith(`..${path.sep}`)
      && ledgerRelative !== ".." && !path.isAbsolute(ledgerRelative))) {
      throw hostError("GROK_BUILD_PATHS_INVALID", "Grok Build ledger must be outside GROK_HOME");
    }
    this.runtimeHome = runtimeHome;
    const binaryPath = this.runtimeEnvironment.binaryPath;
    this.binaryPath = binaryPath;
    const args = buildGrokBuildArgs(this.permissionPolicy);
    const env = await buildSpawnEnv(this.runtimeEnvironment, this.options);
    this.usageEnv = env;
    if (this.state !== "starting") {
      throw hostError("RUNTIME_HOST_TERMINATED", "Grok Build host stopped before process spawn");
    }
    const child = this.spawnProcess(binaryPath, [...args], {
      shell: false,
      cwd: this.controlInstance ? this.runtimeEnvironment.spawnEnv.HOME : this.workspace,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    if (!Number.isSafeInteger(child?.pid) || child.pid <= 1) {
      throw hostError("GROK_BUILD_PROCESS_INVALID", "Grok Build child pid is invalid");
    }
    this.child = child;
    this.childClose = new Promise((resolve) => child.once("close", () => {
      this.childClosed = true;
      resolve();
    }));
    this.rpc = new GrokBuildAcpJsonlClient(child, {
      requestTimeoutMs: this.requestTimeoutMs,
      serverRequestTimeoutMs: this.options.serverRequestTimeoutMs,
      maxFrameBytes: this.options.maxFrameBytes,
      notificationGuard: (message) => this._validateNotification(message),
      serverRequestGuard: (message) => this._validateServerRequest(message),
      onDiagnostic: this.options.onDiagnostic,
    });
    this.rpc.subscribe((message) => {
      try { this._onNotification(message); } catch (error) {
        void this._fatal(error);
      }
    });
    this.rpc.registerServerRequestHandler(
      "session/request_permission",
      (params) => this._handlePermissionRequest(params),
      { timeoutMs: null },
    );
    this.rpc.terminated.catch((error) => {
      if (!new Set(["stopping", "stopped", "failed"]).has(this.state)) void this._fatal(error);
    });
    this.startupStage = "rpc_initialize";
    const response = await this.rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        auth: { terminal: false },
      },
      clientInfo: { name: "shoggoth", version: this.packageVersion },
    }, { timeoutMs: this.initializeTimeoutMs });
    this._acceptInitialize(response);
    await this._refreshAuthenticationIfChanged();
    this.initializedResponse = response;
    this.startupStage = "running";
    this.state = "ready";
    return response;
  }

  _acceptInitialize(response) {
    if (!plain(response) || response.protocolVersion !== 1
      || !plain(response.agentCapabilities ?? {})) {
      throw hostError("GROK_ACP_INITIALIZE_INVALID", "Grok ACP initialize response is invalid");
    }
    const methods = Array.isArray(response.authMethods) ? response.authMethods : [];
    this.authMethods = methods.flatMap((method) => {
      if (!plain(method) || !safeString(method.id, 256) || !safeString(method.name, 512)) return [];
      if (EAGER_HEADLESS_AUTH_METHOD_IDS.has(method.id)) this.headlessAuthMethodIds.add(method.id);
      return [{ id: method.id, name: method.name, type: method.type === "terminal" ? "terminal" : "agent" }];
    });
    const defaultMethod = response._meta?.defaultAuthMethodId;
    this.authMethodId = safeString(defaultMethod, 256)
      && this.authMethods.some((method) => method.id === defaultMethod) ? defaultMethod : null;
    this.authenticated = this.authMethods.length === 0;
    this.agentCapabilities = structuredClone(response.agentCapabilities);
    this.modelCatalog = modelCatalogFromInitialize(response);
  }

  async _authenticateCachedAuth(fingerprint) {
    this.authAttemptFingerprint = fingerprint;
    this.authenticated = false;
    this.authenticatedFingerprint = null;
    const available = this.authMethods.filter((method) => this.headlessAuthMethodIds.has(method.id));
    const preferred = available.find((method) => method.id === this.authMethodId);
    const candidates = preferred
      ? [preferred, ...available.filter((method) => method !== preferred)]
      : available;
    for (const method of candidates) {
      const requestFingerprint = this._captureRuntimeAuthFingerprint();
      if (requestFingerprint !== fingerprint) return false;
      try {
        await this.rpc.request("authenticate", {
          methodId: method.id,
          _meta: { headless: true },
        }, { timeoutMs: this.initializeTimeoutMs });
        if (!this._markRuntimeAuthenticated(requestFingerprint)) return false;
        this.authMethodId = method.id;
        return true;
      } catch (error) {
        if (error?.code === "AUTH_REQUIRED") {
          this._markRuntimeAuthFailure(requestFingerprint);
          continue;
        }
        if (error?.code === "GROK_ACP_REMOTE_ERROR") break;
        throw error;
      }
    }
    this.authenticated = false;
    this.authRejectedFingerprint = fingerprint;
    return false;
  }

  _secureCachedAuth() {
    if (!safeString(this.runtimeHome, 4096, { absolute: true })) return null;
    try {
      const stat = this.fs.lstatSync(path.join(this.runtimeHome, "auth.json"));
      if (!(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0
        && (stat.mode & 0o777) === 0o600
        && (typeof process.getuid !== "function" || stat.uid === process.getuid()))) return null;
      return Object.freeze({
        fingerprint: JSON.stringify([
          String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeMs),
          String(stat.ctimeMs), String(stat.uid), String(stat.mode),
        ]),
      });
    } catch {
      return null;
    }
  }

  _captureRuntimeAuthFingerprint() {
    if (this.authMethods.length === 0) return null;
    return this._secureCachedAuth()?.fingerprint ?? null;
  }

  async _refreshAuthenticationIfChanged() {
    if (this.authMethods.length === 0) {
      this.authenticated = true;
      return true;
    }
    const cached = this._secureCachedAuth();
    if (!cached) {
      const sharedFingerprint = this._readSharedAuthProof();
      if (sharedFingerprint !== null) this._clearSharedAuthProof(sharedFingerprint);
      this.authenticated = false;
      this.authenticatedFingerprint = null;
      this.authAttemptFingerprint = null;
      this.authRejectedFingerprint = null;
      return false;
    }
    const sharedFingerprint = this._readSharedAuthProof();
    if (sharedFingerprint === cached.fingerprint) {
      this.authenticated = true;
      this.authenticatedFingerprint = cached.fingerprint;
      this.authRejectedFingerprint = null;
      return true;
    }
    if (sharedFingerprint !== null) this._clearSharedAuthProof(sharedFingerprint);
    if (!this.authProof && this.authenticated
      && this.authenticatedFingerprint === cached.fingerprint) {
      return true;
    }
    if (this.authRejectedFingerprint === cached.fingerprint) return false;
    if (this.headlessAuthMethodIds.size === 0) {
      this.authenticated = false;
      this.authenticatedFingerprint = null;
      return false;
    }
    if (!this.authenticated && this.authAttemptFingerprint === cached.fingerprint) return false;
    if (this.authRefresh) {
      await this.authRefresh.promise;
      return this._refreshAuthenticationIfChanged();
    }
    const refresh = { fingerprint: cached.fingerprint, promise: null };
    refresh.promise = this._authenticateCachedAuth(cached.fingerprint).finally(() => {
      if (this.authRefresh === refresh) this.authRefresh = null;
    });
    this.authRefresh = refresh;
    return refresh.promise;
  }

  _markRuntimeAuthenticated(fingerprint) {
    if (this.authMethods.length === 0) {
      this.authenticated = true;
      this.authenticatedFingerprint = null;
      this.authAttemptFingerprint = null;
      this.authRejectedFingerprint = null;
      return true;
    }
    if (!safeString(fingerprint, 1024)) return false;
    const cached = this._secureCachedAuth();
    if (!cached || cached.fingerprint !== fingerprint) return false;
    this.authenticated = true;
    this.authenticatedFingerprint = fingerprint;
    this.authAttemptFingerprint = null;
    this.authRejectedFingerprint = null;
    this._verifySharedAuthProof(fingerprint);
    return true;
  }

  _markRuntimeAuthFailure(fingerprint) {
    if (!safeString(fingerprint, 1024)) return false;
    this._invalidateSharedAuthProof(fingerprint);
    const cached = this._secureCachedAuth();
    if (this.authenticatedFingerprint === fingerprint) {
      this.authenticated = false;
      this.authenticatedFingerprint = null;
    }
    if (this.authAttemptFingerprint === fingerprint) this.authAttemptFingerprint = null;
    if (cached?.fingerprint !== fingerprint) return false;
    this.authenticated = false;
    this.authenticatedFingerprint = null;
    this.authRejectedFingerprint = fingerprint;
    return true;
  }

  _readSharedAuthProof() {
    if (!this.authProof) return null;
    const fingerprint = this.authProof.read();
    if (fingerprint !== null && !safeString(fingerprint, 1024)) {
      throw hostError("GROK_BUILD_AUTH_PROOF_INVALID", "Grok Build shared auth proof is invalid");
    }
    return fingerprint;
  }

  _verifySharedAuthProof(fingerprint) {
    if (this.authProof) this.authProof.verify(fingerprint);
  }

  _invalidateSharedAuthProof(fingerprint) {
    if (this.authProof) this.authProof.invalidate(fingerprint);
  }

  _clearSharedAuthProof(fingerprint) {
    if (this.authProof) this.authProof.clear(fingerprint);
  }

  _syncAuthenticationFromProof() {
    const cached = this._secureCachedAuth();
    if (this.authMethods.length === 0) {
      this.authenticated = true;
      return cached;
    }
    if (!cached) {
      const sharedFingerprint = this._readSharedAuthProof();
      if (sharedFingerprint !== null) this._clearSharedAuthProof(sharedFingerprint);
      this.authenticated = false;
      this.authenticatedFingerprint = null;
      this.authRejectedFingerprint = null;
      return null;
    }
    const sharedFingerprint = this._readSharedAuthProof();
    if (sharedFingerprint === cached.fingerprint) {
      this.authenticated = true;
      this.authenticatedFingerprint = cached.fingerprint;
      this.authRejectedFingerprint = null;
      return cached;
    }
    if (sharedFingerprint !== null) this._clearSharedAuthProof(sharedFingerprint);
    if (!this.authProof && this.authenticated
      && this.authenticatedFingerprint === cached.fingerprint) {
      this.authRejectedFingerprint = null;
      return cached;
    }
    this.authenticated = false;
    this.authenticatedFingerprint = null;
    return cached;
  }

  authenticationState() {
    const cached = this._syncAuthenticationFromProof();
    return Object.freeze({
      authenticated: this.authenticated,
      credentialPresent: cached !== null,
      methodId: this.authMethodId,
      methods: Object.freeze(this.authMethods.map((method) => Object.freeze({ ...method }))),
    });
  }

  beginAcquire() {
    this.authAttemptFingerprint = null;
    this.authRejectedFingerprint = null;
  }

  _registerMcpSecrets(servers) {
    const candidates = [];
    for (const server of servers) {
      for (const entry of [...(server.env || []), ...(server.headers || [])]) {
        candidates.push(...namedSecretValues({ [entry.name]: entry.value }));
      }
    }
    // Gate nonce/path values are per-descriptor one-shot credentials. Keep the
    // immutable process/base secrets, but replace the previous descriptor's
    // ephemeral set so a long-lived host cannot exhaust the redaction budget.
    this.registeredSecrets = validateRegisteredSecrets([
      ...this.baseRegisteredSecrets,
      ...candidates,
    ]);
  }

  _assertInputPermissionPolicy(value) {
    return normalizeGrokBuildPermissionPolicy(value);
  }

  _assertExecutionInstance() {
    if (this.controlInstance) {
      throw hostError(
        "RUNTIME_CAPABILITY_UNSUPPORTED",
        "Grok Build control instances cannot create or run sessions",
      );
    }
  }

  _startCwd(value) {
    if (this.workspace !== null) {
      if (value === undefined || value === null || value === this.workspace) return this.workspace;
      throw hostError("RUNTIME_WORKSPACE_MISMATCH", "Grok Build session cwd differs from its host workspace");
    }
    if ((value === undefined || value === null) && this.permissionPolicy.sandbox === "read-only") {
      return this.runtimeHome;
    }
    throw hostError("RUNTIME_SESSION_PARAMS_INVALID", "Grok Build session cwd is invalid");
  }

  _resumeCwd(value, session) {
    const expected = this.workspace || this.runtimeHome;
    if (session.cwd !== expected) {
      throw hostError("RUNTIME_WORKSPACE_MISMATCH", "Grok Build session belongs to another workspace");
    }
    if (value === undefined || value === null || value === expected) return expected;
    throw hostError("RUNTIME_WORKSPACE_MISMATCH", "Grok Build resume cwd differs from its host workspace");
  }

  _assertTurnCwd(value, session) {
    const expected = this.workspace || this.runtimeHome;
    if (session.cwd !== expected || (value !== undefined && value !== null && value !== expected)) {
      throw hostError("RUNTIME_WORKSPACE_MISMATCH", "Grok Build turn differs from its host workspace");
    }
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw hostError("GROK_BUILD_SUBSCRIBER_INVALID", "Subscriber is invalid");
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  registerServerRequestHandler(method, handler) {
    if (typeof method !== "string" || typeof handler !== "function") {
      throw hostError("GROK_BUILD_HANDLER_INVALID", "Server request handler is invalid");
    }
    this.serverRequestHandlers.set(method, handler);
    return () => {
      if (this.serverRequestHandlers.get(method) === handler) this.serverRequestHandlers.delete(method);
    };
  }

  _publish(event) {
    const frozen = Object.freeze(defined(event));
    for (const listener of this.subscribers) {
      try { listener(frozen); } catch {
        try { this.options.onDiagnostic?.({ code: "GROK_BUILD_SUBSCRIBER_FAILED" }); } catch {}
      }
    }
  }

  _assertReady() {
    if (this.state !== "ready" || !this.rpc) {
      throw hostError("GROK_BUILD_HOST_NOT_READY", "Grok Build host is not ready");
    }
  }

  async _prepareAuthentication() {
    this._assertReady();
    if (await this._refreshAuthenticationIfChanged()) return;
    const cached = this._secureCachedAuth();
    if (cached && cached.fingerprint !== this.authRejectedFingerprint) return;
    throw hostError("AUTH_REQUIRED", "Grok Build authentication is required");
  }

  _startAuthBoundRequest(method, params, options) {
    const authFingerprint = this._captureRuntimeAuthFingerprint();
    const handleFailure = (error) => {
      if (error?.code === "AUTH_REQUIRED") this._markRuntimeAuthFailure(authFingerprint);
      throw error;
    };
    let request;
    try {
      request = this.rpc.request(method, params, options);
    } catch (error) {
      return { authFingerprint, promise: Promise.reject(error).catch(handleFailure) };
    }
    return { authFingerprint, promise: Promise.resolve(request).catch(handleFailure) };
  }

  async _mcpServers(context) {
    const factory = this.options.mcpServersFactory;
    const createMcpServer = this.options.createMcpServer;
    if (factory !== undefined && createMcpServer !== undefined) {
      throw hostError(
        "GROK_BUILD_MCP_INVALID",
        "Grok Build MCP descriptor sources are ambiguous",
      );
    }
    const factoryContext = Object.freeze({
      ...context,
      runtime: GROK_BUILD_RUNTIME,
      runtimeProfileId: this.runtimeProfileId,
      runtimeAccountId: this.runtimeAccountId,
      parentPid: this.child?.pid,
      parentExecutable: this.binaryPath,
    });
    let value;
    if (createMcpServer !== undefined) {
      if (typeof createMcpServer !== "function") {
        throw hostError("GROK_BUILD_MCP_INVALID", "Grok Build MCP creator is invalid");
      }
      value = [await createMcpServer(factoryContext)];
    } else if (factory !== undefined) {
      if (typeof factory !== "function") {
        throw hostError("GROK_BUILD_MCP_INVALID", "Grok Build MCP factory is invalid");
      }
      value = await factory(factoryContext);
    } else {
      value = this.options.mcpServers || [];
    }
    if (!Array.isArray(value) || value.length > 64) {
      throw hostError("GROK_BUILD_MCP_INVALID", "Grok Build MCP descriptor list is invalid");
    }
    const servers = value.map((server) => validateMcpServer(server, this.fs));
    if (new Set(servers.map((server) => server.name)).size !== servers.length) {
      throw hostError("GROK_BUILD_MCP_INVALID", "Grok Build MCP server names must be unique");
    }
    this._registerMcpSecrets(servers);
    return servers;
  }

  _validateModel(model) {
    if (model === undefined || model === null) return null;
    if (!safeString(model, 512)
      || !this.modelCatalog.models.some((candidate) => candidate.model === model)) {
      throw hostError("RUNTIME_MODEL_UNAVAILABLE", "Grok Build model is unavailable");
    }
    return model;
  }

  async sessionStart(input) {
    this._assertExecutionInstance();
    await this._prepareAuthentication();
    if (!plain(input) || !safeString(input.source, 256)) {
      throw hostError("RUNTIME_SESSION_PARAMS_INVALID", "Grok Build session start input is invalid");
    }
    this._assertInputPermissionPolicy(input.permissionPolicy);
    const permissionMode = normalizePermissionMode(input.permissionMode);
    const cwd = this._startCwd(input.cwd);
    const model = this._validateModel(input.model);
    const current = this.ledger.snapshot();
    const existing = current.sessions.find((session) => session.source === input.source);
    if (existing) {
      this.sessionConfigs.set(existing.id, {
        cwd: existing.cwd,
        developerInstructions: typeof input.developerInstructions === "string"
          ? input.developerInstructions : "",
        model,
        permissionMode,
      });
      return { session: this._projectSession(existing) };
    }
    if (current.pendingSessions.some((pending) => pending.source === input.source)) {
      throw hostError("RUNTIME_SESSION_ACCEPTANCE_UNKNOWN", "Grok Build session acceptance is unknown");
    }
    const mcpServers = await this._mcpServers({ operation: "session.start", cwd });
    const createdAt = this.now();
    this.ledger.update((data) => {
      data.pendingSessions.push({ source: input.source, cwd, createdAt });
    });
    let response;
    let request;
    try {
      request = this._startAuthBoundRequest("session/new", defined({
        cwd,
        mcpServers,
        _meta: model === null && input.permissionMode == null
          ? undefined
          : { ...(model === null ? {} : { modelId: model }), ...(input.permissionMode == null ? {} : permissionMeta(permissionMode)) },
      }), { timeoutMs: this.requestTimeoutMs });
      response = await request.promise;
    } catch (error) {
      if (["AUTH_REQUIRED", "GROK_ACP_REMOTE_ERROR"].includes(error?.code)) {
        this.ledger.update((data) => {
          data.pendingSessions = data.pendingSessions.filter((item) => item.source !== input.source);
        });
      }
      throw error;
    }
    if (!plain(response) || !safeString(response.sessionId, 512)) {
      throw hostError("GROK_ACP_SESSION_RESPONSE_INVALID", "Grok ACP session/new response is invalid");
    }
    this._markRuntimeAuthenticated(request.authFingerprint);
    const session = {
      id: response.sessionId,
      source: input.source,
      cwd,
      title: null,
      archived: false,
      createdAt,
      updatedAt: createdAt,
      turns: [],
    };
    this.ledger.update((data) => {
      if (data.sessions.some((candidate) => candidate.id === session.id)) {
        throw hostError("RUNTIME_SESSION_CONFLICT", "Grok Build returned a duplicate session id");
      }
      data.pendingSessions = data.pendingSessions.filter((item) => item.source !== input.source);
      data.sessions.push(session);
    });
    this.sessionConfigs.set(session.id, {
      cwd,
      developerInstructions: typeof input.developerInstructions === "string"
        ? input.developerInstructions : "",
      model,
      permissionMode,
    });
    return { session: this._projectSession(session) };
  }

  async sessionResume(input) {
    this._assertExecutionInstance();
    await this._prepareAuthentication();
    if (!plain(input) || !safeString(input.sessionId, 512)) {
      throw hostError("RUNTIME_SESSION_PARAMS_INVALID", "Grok Build session resume input is invalid");
    }
    this._assertInputPermissionPolicy(input.permissionPolicy);
    const permissionMode = normalizePermissionMode(input.permissionMode);
    const model = this._validateModel(input.model);
    const snapshot = this.ledger.snapshot();
    const session = sessionById(snapshot, input.sessionId);
    if (!session || session.archived) {
      throw hostError("RUNTIME_SESSION_NOT_FOUND", "Grok Build session is unavailable");
    }
    if (this.activeTurns.has(session.id)) {
      throw hostError("RUNTIME_SESSION_BUSY", "Grok Build session has an active turn");
    }
    const cwd = this._resumeCwd(input.cwd, session);
    if (session.cwd !== cwd) {
      throw hostError("RUNTIME_SESSION_NOT_FOUND", "Grok Build session cwd does not match");
    }
    const mcpServers = await this._mcpServers({
      operation: "session.resume",
      cwd,
      sessionId: input.sessionId,
    });
    const capabilities = this.agentCapabilities?.sessionCapabilities || {};
    try {
      let request;
      if (plain(capabilities.resume)) {
        request = this._startAuthBoundRequest("session/resume", {
          sessionId: input.sessionId,
          cwd,
          mcpServers,
        }, { timeoutMs: this.requestTimeoutMs });
      } else if (this.agentCapabilities?.loadSession === true) {
        request = this._startAuthBoundRequest("session/load", {
          sessionId: input.sessionId,
          cwd,
          mcpServers,
        }, { timeoutMs: this.requestTimeoutMs });
      } else {
        throw hostError("RUNTIME_CAPABILITY_UNSUPPORTED", "Grok Build cannot resume sessions");
      }
      await request.promise;
      this._markRuntimeAuthenticated(request.authFingerprint);
      if (model !== null) {
        const modelRequest = this._startAuthBoundRequest("session/set_model", {
          sessionId: input.sessionId,
          modelId: model,
        }, { timeoutMs: this.requestTimeoutMs });
        await modelRequest.promise;
        this._markRuntimeAuthenticated(modelRequest.authFingerprint);
      }
      if (input.permissionMode != null) {
        const modeRequest = this._startAuthBoundRequest("session/set_mode", {
          sessionId: input.sessionId,
          modeId: permissionMode === "always-approve" ? "bypassPermissions"
            : permissionMode === "auto" ? "auto" : "default",
        }, { timeoutMs: this.requestTimeoutMs });
        await modeRequest.promise;
        this._markRuntimeAuthenticated(modeRequest.authFingerprint);
      }
    } catch (error) {
      throw error;
    }
    this.sessionConfigs.set(session.id, {
      cwd,
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
      return Promise.reject(hostError("RUNTIME_SESSION_PARAMS_INVALID", "Grok Build session read input is invalid"));
    }
    const session = sessionById(this.ledger.snapshot(), input.sessionId);
    if (!session) return Promise.reject(hostError("RUNTIME_SESSION_NOT_FOUND", "Grok Build session was not found"));
    if (session.turns.some((turn) => turn.acceptance === "unknown")) {
      return Promise.reject(hostError(
        "RUNTIME_TURN_ACCEPTANCE_UNKNOWN",
        "Grok Build turn acceptance is unknown",
      ));
    }
    return Promise.resolve({ session: this._projectSession(session, input.includeTurns === true) });
  }

  sessionList(input = {}) {
    this._assertReady();
    const snapshot = this.ledger.snapshot();
    // A pending session is a per-source fail-closed tombstone: sessionStart keeps
    // rejecting that source, but confirmed sessions and unrelated sources remain usable.
    const archived = input.archived === true;
    const offset = input.cursor === undefined || input.cursor === null ? 0 : Number(input.cursor);
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || String(offset) !== String(input.cursor ?? offset)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return Promise.reject(hostError("RUNTIME_SESSION_CURSOR_INVALID", "Grok Build session cursor is invalid"));
    }
    const sessions = snapshot.sessions
      .filter((session) => session.archived === archived)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    const page = sessions.slice(offset, offset + limit).map((session) => this._projectSession(session));
    const next = offset + page.length;
    return Promise.resolve({ data: page, nextCursor: next < sessions.length ? String(next) : null });
  }

  sessionRename(input) {
    this._assertReady();
    if (!plain(input) || !safeString(input.sessionId, 512) || !safeString(input.name, 1024)) {
      return Promise.reject(hostError("RUNTIME_SESSION_PARAMS_INVALID", "Grok Build session rename input is invalid"));
    }
    this.ledger.update((data) => {
      const session = sessionById(data, input.sessionId);
      if (!session) throw hostError("RUNTIME_SESSION_NOT_FOUND", "Grok Build session was not found");
      session.title = input.name;
      session.updatedAt = Math.max(session.updatedAt, this.now());
    });
    return Promise.resolve({});
  }

  async sessionArchive(input) {
    this._assertReady();
    const session = this._requireSession(input?.sessionId);
    if (this.activeTurns.has(session.id)) {
      throw hostError("RUNTIME_SESSION_BUSY", "Grok Build session has an active turn");
    }
    if (this.agentCapabilities?.sessionCapabilities?.close
      && plain(this.agentCapabilities.sessionCapabilities.close)) {
      const request = this._startAuthBoundRequest(
        "session/close",
        { sessionId: session.id },
        { timeoutMs: this.requestTimeoutMs },
      );
      await request.promise;
      this._markRuntimeAuthenticated(request.authFingerprint);
    } else {
      await this.rpc.notify("session/cancel", { sessionId: session.id });
    }
    this.ledger.update((data) => {
      const current = sessionById(data, session.id);
      current.archived = true;
      current.updatedAt = Math.max(current.updatedAt, this.now());
    });
    return {};
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
      throw hostError("RUNTIME_SESSION_BUSY", "Grok Build session has an active turn");
    }
    const capabilities = this.agentCapabilities?.sessionCapabilities || {};
    if (plain(capabilities.delete)) {
      const request = this._startAuthBoundRequest(
        "session/delete",
        { sessionId: session.id },
        { timeoutMs: this.requestTimeoutMs },
      );
      await request.promise;
      this._markRuntimeAuthenticated(request.authFingerprint);
    } else {
      throw hostError(
        "RUNTIME_CAPABILITY_UNSUPPORTED",
        "Grok Build does not advertise physical session deletion",
      );
    }
    this.ledger.update((data) => {
      data.sessions = data.sessions.filter((candidate) => candidate.id !== session.id);
    });
    this.sessionConfigs.delete(session.id);
    this.commandCatalogs.delete(session.id);
    this.lastNativePromptIds.delete(session.id);
    return {};
  }

  _requireSession(sessionId) {
    if (!safeString(sessionId, 512)) {
      throw hostError("RUNTIME_SESSION_PARAMS_INVALID", "Grok Build session id is invalid");
    }
    const session = sessionById(this.ledger.snapshot(), sessionId);
    if (!session) throw hostError("RUNTIME_SESSION_NOT_FOUND", "Grok Build session was not found");
    return session;
  }

  async turnStart(input) {
    this._assertExecutionInstance();
    await this._prepareAuthentication();
    if (!plain(input) || !safeString(input.sessionId, 512)
      || !safeString(input.operationId, 512) || !safeString(input.prompt, 1024 * 1024, { empty: true })) {
      throw hostError("RUNTIME_TURN_PARAMS_INVALID", "Grok Build turn input is invalid");
    }
    const permissionPolicy = this._assertInputPermissionPolicy(input.permissionPolicy);
    const permissionMode = normalizePermissionMode(input.permissionMode
      ?? this.sessionConfigs.get(input.sessionId)?.permissionMode);
    const session = this._requireSession(input.sessionId);
    this._assertTurnCwd(input.cwd, session);
    if (session.archived) throw hostError("RUNTIME_SESSION_ARCHIVED", "Grok Build session is archived");
    const fingerprint = inputFingerprint(input);
    const existing = turnByOperation(session, input.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw hostError("RUNTIME_OPERATION_CONFLICT", "Grok Build operationId was reused with different input");
      }
      const active = this.activeTurns.get(session.id);
      if (active?.turnId === existing.id) return active.acceptance.promise;
      if (existing.acceptance === "unknown") {
        throw hostError("RUNTIME_TURN_ACCEPTANCE_UNKNOWN", "Grok Build turn acceptance is unknown");
      }
      if (existing.acceptance === "failed") {
        throw hostError(existing.errorCode || "GROK_ACP_REMOTE_ERROR", "Grok Build turn was rejected");
      }
      return { turn: { id: existing.id, status: existing.status, items: [] } };
    }
    if (session.turns.some((turn) => turn.acceptance === "unknown")) {
      throw hostError("RUNTIME_TURN_ACCEPTANCE_UNKNOWN", "A previous Grok Build turn is unresolved");
    }
    if (this.activeTurns.has(session.id)) {
      throw hostError("RUNTIME_SESSION_BUSY", "Grok Build session already has an active turn");
    }
    const turnId = `grok-turn-${this.randomUUID()}`;
    if (!safeString(turnId, 512)) throw hostError("RUNTIME_TURN_ID_INVALID", "Grok Build turn id is invalid");
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
        createdAt,
        updatedAt: createdAt,
      });
      current.updatedAt = Math.max(current.updatedAt, createdAt);
    });
    const prompt = this._promptText(session.id, input);
    const acceptance = makeDeferred();
    const active = {
      sessionId: session.id,
      createdAt,
      cwd: session.cwd,
      turnId,
      operationId: input.operationId,
      promptText: prompt,
      acceptance,
      terminal: makeDeferred(),
      accepted: false,
      timedOut: false,
      messages: new Map(),
      messageOrder: [],
      messageBytes: 0,
      authFingerprint: null,
      nativePromptId: null,
      failureCode: null,
      timer: null,
      permissionPolicy,
      permissionMode,
    };
    this.activeTurns.set(session.id, active);
    active.timer = setTimeout(() => this._markAcceptanceUnknown(active), this.acceptanceTimeoutMs);
    active.timer.unref?.();
    const promptRequest = this._startAuthBoundRequest("session/prompt", {
      sessionId: session.id,
      prompt: [{ type: "text", text: prompt }, ...imageAttachments(input.attachments)
        .map(image => ({ type: "image", ...image }))],
    }, { timeoutMs: this.promptTimeoutMs });
    active.authFingerprint = promptRequest.authFingerprint;
    void promptRequest.promise.then(
      (response) => this._finishPrompt(active, response),
      (error) => this._failPrompt(active, error),
    ).catch((error) => this._fatal(error));
    return acceptance.promise;
  }

  _promptText(sessionId, input) {
    const commands = this.commandCatalogs.get(sessionId) || GROK_BUILD_BOOTSTRAP_COMMANDS;
    if (parseRuntimeCommand(input.prompt, commands)) return input.prompt.trim();
    const config = this.sessionConfigs.get(sessionId);
    const blocks = [];
    if (config?.developerInstructions) {
      blocks.push(`SHOGGOTH DEVELOPER INSTRUCTIONS\n${config.developerInstructions}`);
    }
    if (typeof input.context === "string" && input.context.length > 0) {
      blocks.push(input.context);
    }
    blocks.push(`CURRENT USER REQUEST\n${input.prompt}`);
    return blocks.join("\n\n");
  }

  turnSteer() {
    return Promise.reject(hostError(
      "RUNTIME_CAPABILITY_UNSUPPORTED",
      "Grok ACP does not provide safe in-turn steering",
    ));
  }

  async turnInterrupt(input) {
    this._assertReady();
    if (!plain(input) || !safeString(input.sessionId, 512) || !safeString(input.turnId, 512)) {
      throw hostError("RUNTIME_TURN_PARAMS_INVALID", "Grok Build interrupt input is invalid");
    }
    const session = this._requireSession(input.sessionId);
    const turn = turnById(session, input.turnId);
    if (!turn) throw hostError("RUNTIME_TURN_STALE", "Grok Build interrupt turn is stale");
    const active = this.activeTurns.get(input.sessionId);
    if (!active) {
      if (turn.status === "canceled") return {};
      throw hostError("RUNTIME_TURN_NOT_ACTIVE", "Grok Build turn is no longer active");
    }
    if (active.turnId !== input.turnId) {
      throw hostError("RUNTIME_TURN_STALE", "Grok Build interrupt turn is stale");
    }
    await this.rpc.notify("session/cancel", { sessionId: input.sessionId });
    let timer;
    let terminal;
    try {
      terminal = await Promise.race([
        active.terminal.promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(hostError(
            "RUNTIME_TURN_CANCEL_UNKNOWN",
            "Grok Build did not confirm turn cancellation",
          )), this.requestTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (terminal?.status !== "canceled") {
      throw hostError(
        "RUNTIME_TURN_CANCEL_NOT_CONFIRMED",
        "Grok Build completed the turn without confirming cancellation",
      );
    }
    return {};
  }

  modelsList(input = {}) {
    this._assertReady();
    const offset = input.cursor === undefined || input.cursor === null ? 0 : Number(input.cursor);
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || String(offset) !== String(input.cursor ?? offset)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return Promise.reject(hostError("RUNTIME_MODEL_CURSOR_INVALID", "Grok Build model cursor is invalid"));
    }
    const page = this.modelCatalog.models.slice(offset, offset + limit).map((model) => ({
      ...model,
      isDefault: model.model === this.modelCatalog.current,
      hidden: false,
    }));
    const next = offset + page.length;
    return Promise.resolve({
      data: page,
      nextCursor: next < this.modelCatalog.models.length ? String(next) : null,
    });
  }

  commandsList(input = {}) {
    this._assertReady();
    if (!plain(input)
      || (input.sessionId !== undefined && input.sessionId !== null
        && !safeString(input.sessionId, 512))) {
      return Promise.reject(hostError(
        "RUNTIME_COMMAND_PARAMS_INVALID",
        "Grok Build command catalog input is invalid",
      ));
    }
    if (input.sessionId !== undefined && input.sessionId !== null) {
      this._requireSession(input.sessionId);
    }
    return Promise.resolve({
      supported: true,
      reason: null,
      commands: mergeNativeCommands("grok-build", this.commandCatalogs.get(input.sessionId) || GROK_BUILD_BOOTSTRAP_COMMANDS),
    });
  }

  async commandExecute(input) {
    this._assertExecutionInstance();
    if (!plain(input)
      || (input.sessionId !== null && !safeString(input.sessionId, 512))
      || !safeString(input.text, 64 * 1024)) {
      return Promise.reject(hostError(
        "RUNTIME_COMMAND_PARAMS_INVALID",
        "Grok Build command input is invalid",
      ));
    }
    if (input.sessionId !== null) this._requireSession(input.sessionId);
    const commands = mergeNativeCommands("grok-build", this.commandCatalogs.get(input.sessionId) || GROK_BUILD_BOOTSTRAP_COMMANDS);
    const parsed = requireRuntimeCommand(input.text, commands, "grok-build");
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

  _validateNotification(message) {
    if (message.method !== "session/update") return;
    const params = message.params;
    if (!plain(params) || !safeString(params.sessionId, 512)
      || !validSessionUpdate(params.update)) {
      throw hostError("GROK_ACP_NOTIFICATION_INVALID", "Grok ACP session update is invalid");
    }
  }

  _validateServerRequest(message) {
    if (message.method !== "session/request_permission") return;
    const params = message.params;
    if (!plain(params) || !safeString(params.sessionId, 512) || !plain(params.toolCall)
      || !safeString(params.toolCall.toolCallId, 512) || !Array.isArray(params.options)
      || params.options.length < 1 || params.options.length > 32
      || params.options.some((option) => !plain(option) || !safeString(option.optionId, 512)
        || !safeString(option.name, 1024) || !PERMISSION_KINDS.has(option.kind))
      || new Set(params.options.map((option) => option.optionId)).size !== params.options.length
      || !optionalSafeString(params.toolCall.title, 16 * 1024)
      || (params.toolCall.kind !== undefined && params.toolCall.kind !== null
        && !TOOL_KINDS.has(params.toolCall.kind))) {
      throw hostError("GROK_ACP_PERMISSION_INVALID", "Grok ACP permission request is invalid");
    }
  }

  _onNotification(message) {
    if (message.method === "_x.ai/models/update") {
      const catalog = modelCatalogFromInitialize({ _meta: { modelState: message.params } });
      if (catalog.models.length > 0) this.modelCatalog = catalog;
      return;
    }
    if (message.method === "_x.ai/queue/changed") {
      this._onQueueChanged(message.params);
      return;
    }
    if (message.method === "_x.ai/session/update") {
      const params = message.params;
      const active = this.activeTurns.get(params?.sessionId);
      const update = params?.update;
      // Only the receipt for this exact prompt can supply a failure category.
      // Never interpret assistant text or a stale session notification as an error.
      if (active?.nativePromptId && update?.sessionUpdate === "turn_completed"
        && update.prompt_id === active.nativePromptId && update.stop_reason === "error"
        && typeof update.agent_result === "string" && update.agent_result.length <= 16 * 1024) {
        if (/\b(?:usage balance exhausted|insufficient_quota)\b|\b402 Payment Required\b/iu.test(update.agent_result)) {
          active.failureCode = "RUNTIME_QUOTA_EXHAUSTED";
        } else if (/\b(?:user )?account (?:is )?(?:blocked|suspended|deactivated)\b/iu.test(update.agent_result)) {
          active.failureCode = "RUNTIME_ACCOUNT_BLOCKED";
        }
      }
      return;
    }
    if (message.method !== "session/update") return;
    const { sessionId, update } = message.params;
    if (update.sessionUpdate === "available_commands_update") {
      const commands = normalizeRuntimeCommands(update.availableCommands, {
        errorCode: "RUNTIME_COMMAND_CATALOG_INVALID",
        errorMessage: "Grok Build command catalog format changed",
      });
      this.commandCatalogs.set(sessionId, commands);
      return;
    }
    const active = this.activeTurns.get(sessionId);
    if (!active || active.timedOut) return;
    if (TURN_ACCEPTANCE_UPDATE_KINDS.has(update.sessionUpdate)) this._acceptTurn(active);
    else if (!active.accepted) return;
    const common = {
      known: true,
      method: "session/update",
      sessionId,
      turnId: active.turnId,
    };
    if (update.sessionUpdate === "agent_message_chunk") {
      const text = update.content.type === "text" ? update.content.text : "";
      const itemId = safeString(update.messageId, 512)
        ? update.messageId : `grok-message-${active.turnId}`;
      const previous = active.messages.get(itemId) || "";
      const combined = `${previous}${text}`;
      const combinedBytes = Buffer.byteLength(combined, "utf8");
      const nextTotal = active.messageBytes - Buffer.byteLength(previous, "utf8") + combinedBytes;
      if (combinedBytes > MAX_ASSISTANT_MESSAGE_BYTES || nextTotal > MAX_TURN_TRANSCRIPT_BYTES
        || (!active.messages.has(itemId) && active.messageOrder.length >= MAX_TURN_MESSAGES)) {
        throw hostError("GROK_ACP_TURN_OUTPUT_TOO_LARGE", "Grok ACP turn output exceeded its limit");
      }
      if (!active.messages.has(itemId)) active.messageOrder.push(itemId);
      active.messages.set(itemId, combined);
      active.messageBytes = nextTotal;
      this._publish({ ...common, type: "text_delta", itemId, delta: text });
      return;
    }
    if (update.sessionUpdate === "agent_thought_chunk") {
      const delta = update.content?.type === "text" && typeof update.content.text === "string"
        ? update.content.text : "";
      this._publish({ ...common, type: "reasoning_delta", delta });
      return;
    }
    if (update.sessionUpdate === "tool_call") {
      const input = update.rawInput === undefined ? undefined : safeSnapshot(update.rawInput, {
        registeredSecrets: this.registeredSecrets,
        maxSnapshotBytes: 64 * 1024,
      });
      this._publish({
        ...common,
        type: "tool_start",
        itemId: update.toolCallId,
        toolCallId: update.toolCallId,
        tool: {
          kind: update.kind || "other",
          name: update.title || "tool",
          status: update.status || "pending",
          ...(input === undefined ? {} : { input }),
        },
      });
      return;
    }
    if (update.sessionUpdate === "tool_call_update") {
      const completed = update.status === "completed" || update.status === "failed";
      const rawOutput = update.rawOutput ?? update.content;
      const output = rawOutput === undefined ? undefined : safeSnapshot(rawOutput, {
        registeredSecrets: this.registeredSecrets,
        maxSnapshotBytes: 64 * 1024,
      });
      const completionInput = plain(rawOutput?.action)
        && typeof rawOutput.action.query === "string" && rawOutput.action.query
        ? safeSnapshot({ query: rawOutput.action.query }, {
          registeredSecrets: this.registeredSecrets,
          maxSnapshotBytes: 64 * 1024,
        })
        : undefined;
      this._publish({
        ...common,
        type: completed ? "tool_result" : "tool_update",
        itemId: update.toolCallId,
        toolCallId: update.toolCallId,
        ...(completed ? {
          tool: {
            ...(update.kind ? { kind: update.kind } : {}),
            ...(update.title ? { name: update.title } : {}),
            status: update.status,
            success: update.status === "completed",
            ...(completionInput === undefined ? {} : { input: completionInput }),
            ...(output === undefined ? {} : { output }),
          },
        } : { progress: update.status, message: update.title }),
      });
      return;
    }
    if (update.sessionUpdate === "plan") {
      this._publish({ ...common, type: "plan", plan: Array.isArray(update.entries) ? update.entries : [] });
    }
  }

  async _handlePermissionRequest(params) {
    const active = this.activeTurns.get(params.sessionId);
    if (!active || active.timedOut) return { outcome: { outcome: "cancelled" } };
    this._acceptTurn(active);
    if (active.permissionMode === "always-approve") {
      const allowed = ["allow_always", "allow_once"]
        .flatMap((kind) => params.options.filter((option) => option.kind === kind))[0];
      return allowed
        ? { outcome: { outcome: "selected", optionId: allowed.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }
    if (active.permissionPolicy.approvalPolicy === "never") {
      const rejected = ["reject_always", "reject_once"]
        .flatMap((kind) => params.options.filter((option) => option.kind === kind))[0];
      return rejected
        ? { outcome: { outcome: "selected", optionId: rejected.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }
    const resumePromptTimeout = this.rpc.pauseRequestTimeout(
      "session/prompt",
      (promptParams) => promptParams?.sessionId === params.sessionId,
    );
    try {
      await new Promise((resolve) => setImmediate(resolve));
      const tool = params.toolCall;
      const method = ["edit", "delete", "move"].includes(tool.kind)
        ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval";
      const handler = this.serverRequestHandlers.get(method);
      if (!handler) return { outcome: { outcome: "cancelled" } };
      const command = typeof tool.rawInput?.command === "string"
        ? tool.rawInput.command : (typeof tool.title === "string" ? tool.title : "Grok Build tool");
      // ACP kinds describe persistence, not its scope. Keep every offered option:
      // remembering one MCP tool and trusting its server may both be allow_always.
      const approvalOptions = params.options.map((option, index) => {
        const firstOfKind = params.options.findIndex((candidate) => candidate.kind === option.kind) === index;
        const scope = option.kind === "allow_always" ? new Map([
          ["allow_always_mcp_tool", "tool"],
          ["allow_always_mcp_server", "server"],
          ["allow_edits_for_session", "session_files"],
          ["enable-always-approve", "all_operations"],
        ]).get(option.optionId) : undefined;
        return {
          choice: firstOfKind && option.kind === "allow_once" ? "once"
            : firstOfKind && option.kind === "reject_once" ? "deny" : `runtime:${index}`,
          label: option.name,
          kind: option.kind,
          ...(scope ? { scope } : {}),
        };
      });
      const response = await handler({
        sessionId: params.sessionId,
        turnId: active.turnId,
        itemId: tool.toolCallId,
        command,
        toolName: typeof tool.title === "string" && /^[A-Za-z0-9_.:-]+$/u.test(tool.title)
          ? tool.title : undefined,
        toolInput: tool.rawInput === undefined ? undefined : safeSnapshot(tool.rawInput, {
          registeredSecrets: this.registeredSecrets,
          maxSnapshotBytes: 16 * 1024,
        }),
        reason: typeof tool.title === "string" ? tool.title : undefined,
        sessionApprovalAvailable: false,
        approvalOptions,
      }, { method, sourceMethod: "session/request_permission" });
      const decision = response?.decision;
      if (decision === "cancel") return { outcome: { outcome: "cancelled" } };
      if (response?.approvalChoice !== undefined) {
        const index = approvalOptions.findIndex((option) => option.choice === response.approvalChoice);
        const expectedDecision = approvalOptions[index]?.kind.startsWith("allow_") ? "accept" : "decline";
        return index >= 0 && decision === expectedDecision
          ? { outcome: { outcome: "selected", optionId: params.options[index].optionId } }
          : { outcome: { outcome: "cancelled" } };
      }
      let desired;
      if (decision === "accept") desired = ["allow_once"];
      else if (decision === "decline") desired = ["reject_once"];
      else return { outcome: { outcome: "cancelled" } };
      const selected = desired.flatMap((kind) => params.options.filter((option) => option.kind === kind))[0];
      return selected
        ? { outcome: { outcome: "selected", optionId: selected.optionId } }
        : { outcome: { outcome: "cancelled" } };
    } finally {
      resumePromptTimeout();
    }
  }

  _onQueueChanged(params) {
    // Grok acknowledges receipt here before inference produces ACP output.
    // This optional extension must never make unrelated or malformed updates
    // count as acceptance of the current operation.
    if (!plain(params) || !safeString(params.sessionId, 512)
      || !Array.isArray(params.entries) || params.entries.length > 256) return;
    const active = this.activeTurns.get(params.sessionId);
    if (!active || active.timedOut) return;
    const candidates = [...params.entries, {
      id: params.runningPromptId,
      kind: params.runningKind,
      text: params.runningText,
    }];
    const matchingIds = new Set(candidates.filter((entry) => plain(entry)
      && entry.kind === "prompt" && safeString(entry.id, 512)
      && entry.text === active.promptText).map((entry) => entry.id));
    if (matchingIds.size !== 1) return;
    const [nativePromptId] = matchingIds;
    if (nativePromptId === this.lastNativePromptIds.get(active.sessionId)) return;
    this.lastNativePromptIds.set(active.sessionId, nativePromptId);
    active.nativePromptId = nativePromptId;
    this._acceptTurn(active);
  }

  _acceptTurn(active) {
    if (active.accepted || active.timedOut) return;
    const timestamp = this.now();
    this.ledger.update((data) => {
      const session = sessionById(data, active.sessionId);
      const turn = turnById(session, active.turnId);
      if (!turn || turn.acceptance !== "unknown") {
        throw hostError("RUNTIME_TURN_RECEIPT_CONFLICT", "Grok Build turn receipt is inconsistent");
      }
      turn.acceptance = "accepted";
      turn.updatedAt = Math.max(turn.updatedAt, timestamp);
      session.updatedAt = Math.max(session.updatedAt, timestamp);
    });
    active.accepted = true;
    this._markRuntimeAuthenticated(active.authFingerprint);
    clearTimeout(active.timer);
    active.timer = null;
    active.acceptance.resolve({ turn: { id: active.turnId, status: "inProgress", items: [] } });
  }

  _markAcceptanceUnknown(active) {
    if (active.accepted || active.timedOut || this.activeTurns.get(active.sessionId) !== active) return;
    active.timedOut = true;
    const error = hostError(
      "RUNTIME_TURN_ACCEPTANCE_UNKNOWN",
      "Grok Build did not prove turn acceptance",
    );
    const timestamp = this.now();
    try {
      this.ledger.update((data) => {
        const session = sessionById(data, active.sessionId);
        const turn = turnById(session, active.turnId);
        turn.status = "interrupted";
        turn.errorCode = error.code;
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
      throw hostError("GROK_ACP_PROMPT_RESPONSE_INVALID", "Grok ACP prompt response is invalid");
    }
    if (!active.timedOut) this._acceptTurn(active);
    const status = response.stopReason === "end_turn" ? "completed"
      : response.stopReason === "cancelled" ? "canceled" : "failed";
    const timestamp = this.now();
    let usage = [];
    try {
      usage = await (this.options.readUsage || readGrokUsage)({ binaryPath: this.binaryPath,
        env: this.usageEnv, cwd: active.cwd, sessionId: active.sessionId,
        sinceMs: active.createdAt, untilMs: timestamp });
    } catch { /* Unavailable metering must not change the outcome of the work. */ }
    if (this.activeTurns.get(active.sessionId) !== active) return;
    const assistantMessages = active.messageOrder.map((id) => ({ id, text: active.messages.get(id) || "" }));
    this.ledger.update((data) => {
      const session = sessionById(data, active.sessionId);
      const turn = turnById(session, active.turnId);
      // A response to this exact prompt proves its terminal state even after
      // the caller timed out. Keep its receipt so future operations can proceed.
      turn.acceptance = "accepted";
      turn.status = status;
      turn.errorCode = status === "failed" ? (active.failureCode || "GROK_BUILD_TURN_FAILED") : null;
      turn.assistantMessages = assistantMessages;
      turn.updatedAt = Math.max(turn.updatedAt, timestamp);
      session.updatedAt = Math.max(session.updatedAt, timestamp);
    });
    clearTimeout(active.timer);
    this.activeTurns.delete(active.sessionId);
    // The caller already received the timeout; never replay or complete it twice.
    if (active.timedOut) return;
    const common = {
      known: true,
      method: "session/update",
      sessionId: active.sessionId,
      turnId: active.turnId,
    };
    for (const record of usage) this._publish({ ...common, ...record, type: "usage" });
    for (const message of assistantMessages) {
      if (message.text.length > 0) {
        this._publish({ ...common, type: "text", itemId: message.id, text: message.text, phase: "final_answer" });
      }
    }
    this._publish({ ...common, method: "session/prompt", type: "complete", status });
    active.terminal.resolve({ status });
  }

  _failPrompt(active, error) {
    if (this.activeTurns.get(active.sessionId) !== active) return;
    clearTimeout(active.timer);
    active.timer = null;
    const explicit = ["AUTH_REQUIRED", "GROK_ACP_REMOTE_ERROR"].includes(error?.code);
    if (active.timedOut && !explicit) {
      this.activeTurns.delete(active.sessionId);
      active.terminal.reject(error);
      return;
    }
    if (!active.accepted && !explicit) {
      this._markAcceptanceUnknown(active);
      return;
    }
    const timestamp = this.now();
    if (!active.accepted) {
      this.ledger.update((data) => {
        const session = sessionById(data, active.sessionId);
        const turn = turnById(session, active.turnId);
        turn.acceptance = "failed";
        turn.status = "failed";
        turn.errorCode = error?.code || "GROK_ACP_REMOTE_ERROR";
        turn.updatedAt = Math.max(turn.updatedAt, timestamp);
        session.updatedAt = Math.max(session.updatedAt, timestamp);
      });
      active.acceptance.reject(error);
      this.activeTurns.delete(active.sessionId);
      active.terminal.reject(error);
      return;
    }
    const status = ["AUTH_REQUIRED", "GROK_ACP_REMOTE_ERROR"].includes(error?.code)
      ? "failed" : "interrupted";
    this.ledger.update((data) => {
      const session = sessionById(data, active.sessionId);
      const turn = turnById(session, active.turnId);
      turn.status = status;
      turn.errorCode = error?.code || "GROK_BUILD_TURN_FAILED";
      turn.updatedAt = Math.max(turn.updatedAt, timestamp);
      session.updatedAt = Math.max(session.updatedAt, timestamp);
    });
    this.activeTurns.delete(active.sessionId);
    active.terminal.reject(error);
    this._publish({
      known: true,
      method: "session/prompt",
      type: "complete",
      sessionId: active.sessionId,
      turnId: active.turnId,
      status,
    });
  }

  async _fatal(error) {
    if (this.state === "failed" || this.state === "stopped") return;
    this.fatalError = error?.code ? error : hostError("GROK_BUILD_RUNTIME_FAILED", "Grok Build runtime failed");
    this.state = "failed";
    for (const active of [...this.activeTurns.values()]) {
      try {
        if (!active.accepted) this._markAcceptanceUnknown(active);
        else this._failPrompt(active, this.fatalError);
      } catch {
        active.terminal.reject(this.fatalError);
      }
    }
    try { await this._stopProcess(true); } catch { this.cleanupIncomplete = true; }
    this.rejectTerminated(this.fatalError);
  }

  stop() {
    if (this.stopping) return this.stopping;
    if (this.state === "stopped") return Promise.resolve();
    this.state = "stopping";
    this.stopping = this._stopProcess(false).then(
      () => {
        this.state = "stopped";
        this.resolveTerminated();
      },
      (error) => {
        this.state = "failed";
        this.rejectTerminated(error);
        throw error;
      },
    );
    return this.stopping;
  }

  async _stopProcess(fromFatal) {
    const termination = hostError("RUNTIME_HOST_TERMINATED", "Grok Build host stopped");
    for (const active of [...this.activeTurns.values()]) {
      clearTimeout(active.timer);
      if (!active.accepted && !active.timedOut) this._markAcceptanceUnknown(active);
      else if (active.accepted && !active.timedOut) this._failPrompt(active, termination);
    }
    this.activeTurns.clear();
    try { await this.rpc?.terminate(); } catch {}
    const child = this.child;
    if (!child) return;
    let exists = !this.childClosed;
    if (!exists) {
      try { exists = this.processGroupExists(child.pid); } catch { exists = true; }
    }
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
      const cleanup = hostError("GROK_BUILD_PROCESS_CLOSE_TIMEOUT", "Grok Build process cleanup is incomplete");
      cleanup.cleanupIncomplete = true;
      if (!fromFatal) throw cleanup;
    }
  }
}

module.exports = {
  GROK_COMPAT_DISABLE_ENV,
  buildGrokSpawnEnv: buildSpawnEnv,
  GrokBuildRuntimeHost,
  PARENT_ENV_ALLOWLIST,
  modelCatalogFromInitialize,
  validateMcpServer,
};
