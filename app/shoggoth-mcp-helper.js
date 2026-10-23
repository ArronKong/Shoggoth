"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { requestService: defaultRequestService } = require("./agent-service/client");
const { assertRuntimeProfileId } = require("./agent-service/codex-runtime-paths");
const { McpAuthSecretStore } = require("./agent-service/mcp-auth-secret-store");
const { McpCryptoBroker } = require("./agent-service/mcp-crypto-broker");
const { PackagedMcpCryptoBroker } = require("./agent-service/packaged-mcp-crypto-broker");
const { createMcpChallengeProof } = require("./agent-service/mcp-session-manager");
const {
  FEDERATION_MCP_CLIENTS,
  federationMcpAuthPath,
  loadFederationMcpCredential,
} = require("./agent-service/federation-mcp-auth");
const {
  MCP_PRODUCT_TOOL_DEFINITIONS,
  PUBLIC_MESSAGES: MCP_PRODUCT_PUBLIC_MESSAGES,
  explainMcpProductToolArguments,
  isNativeOnlyMcpTool,
  validateMcpProductToolArguments,
} = require("./agent-service/mcp-product-tool-controller");
const { MESSAGES: CHAT_UI_PUBLIC_MESSAGES } = require("./agent-service/chat-ui-messages");
const { groupManagementRequest } = require("./agent-service/group-chat-agent-tools");
const { PRODUCT_CONFIRMATION_META, productConfirmationIdentity } = require("./agent-service/cron-approval-policy");
const {
  SHOGGOTH_PRODUCT_DEVELOPER_INSTRUCTIONS,
  SHOGGOTH_EXTERNAL_PRODUCT_DEVELOPER_INSTRUCTIONS,
  productToolRisk,
} = require("./agent-service/product-capability-manifest");
const {
  DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  serverRequestUsesApprovalWait,
} = require("./agent-service/interactive-timeouts");
const {
  resolveCanonicalServicePaths,
} = require("./agent-service/paths");
const { serviceError } = require("./agent-service/security");
const {
  SERVICE_PROTOCOL_VERSION: MCP_SERVICE_PROTOCOL_VERSION,
} = require("./agent-service/service-protocol-version");
const {
  hideBackgroundDock,
  prohibitBackgroundActivation,
} = require("./background-role-activation");

const MCP_STDIO_PROTOCOL_VERSION = "2025-06-18";
const MCP_RUNTIME_PROFILE_PREFIX = "--shoggoth-runtime-profile=";
const MCP_RUNTIME_ACCOUNT_PREFIX = "--shoggoth-runtime-account=";
// Set by the runtime MCP gate for Runtimes that load every tool definition up front.
const MCP_RESIDENT_TOOL_EXPOSURE_ARG = "--shoggoth-tool-exposure=resident";
const productToolExposure = require("./agent-service/product-tool-exposure");
const productToolResults = require("./agent-service/product-tool-results");
const { withActivityTitle, splitActivityArguments } = require("./agent-service/tool-activity");
const FEDERATION_MCP_CLIENT_ENV = "SHOGGOTH_FEDERATION_MCP_CLIENT";
const FEDERATION_MCP_AUTH_FILE_ENV = "SHOGGOTH_FEDERATION_MCP_AUTH_FILE";
const MCP_MAX_FRAME_BYTES = 64 * 1024;
// Some Runtime MCP clients only consume the first tools/list page. Keep the
// complete product catalog in one bounded response without widening tool-call
// input/result limits.
const MCP_MAX_CATALOG_FRAME_BYTES = 256 * 1024;
const MCP_INITIALIZE_CAPABILITIES_MAX_BYTES = 4 * 1024;
const MCP_INITIALIZE_TEXT_MAX_BYTES = 128;
const MCP_SESSION_REFRESH_SKEW_MS = 5_000;
// Refresh can include two authentication requests (10s each) and credential access.
// Its outer deadline must not cut off an otherwise valid authentication exchange.
const MCP_SESSION_REFRESH_TIMEOUT_MS = 30_000;
// ACP startup can pause its MCP reader while loading the local harness. Allow
// that bounded pause, including a full catalog response, before closing it.
const MCP_OUTPUT_TIMEOUT_MS = 10_000;
const MCP_CLIENT_REQUEST_TIMEOUT_MS = DEFAULT_SERVER_REQUEST_TIMEOUT_MS;
const MCP_AUTH_SERVICE_TIMEOUT_MS = 10_000;
const MCP_TOOL_SERVICE_TIMEOUT_MS = 45_000;
// Tools that keep the call open while the user answers a Service-raised card.
const USER_WAIT_TOOL_NAMES = new Set(["browser_session_wait_for_user", "plugin_secret_request", "workspace_execute"]);
const MCP_PACKAGED_CRYPTO_TIMEOUT_MS = 30_000;
const MCP_MAX_QUESTIONS = 3;
const MCP_MAX_QUESTION_OPTIONS = 3;
const PUBLIC_PROFILE_FIELDS = Object.freeze([
  "id", "agentId", "name", "runtimeProfileId", "runtimeAccountId", "defaultModel", "defaultCwd",
  "permissionPolicy", "concurrency", "isDefault", "enabled",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PUBLIC_SERVICE_ERROR_PREFIXES = Object.freeze([
  "AGENT_", "BROWSER_", "COMPUTER_", "CRON_", "FEDERATION_", "KANBAN_",
  "MCP_", "MEMORY_", "MODEL_", "PROFILE_", "RUNTIME_", "SERVICE_",
  "SKILL_", "SYSTEM_", "TOOL_", "TRANSCRIPT_", "USAGE_", "WORKSPACE_",
]);
const EXTERNAL_FEDERATION_MCP_TOOL_DEFINITIONS = Object.freeze(
  MCP_PRODUCT_TOOL_DEFINITIONS.filter((definition) => !isNativeOnlyMcpTool(definition.name)),
);
const EXTERNAL_FEDERATION_MCP_INSTRUCTIONS = [
  "You are an external Agent connected to Shoggoth through its local federated MCP server.",
  "Your own Agent name, persona, memory and current model remain owned by your external backend. profile_get describes the Shoggoth native Profile authorized for product operations, not your external Agent identity. Connecting to this MCP server does not rename you or replace your own definitions or memory.",
  "Shoggoth exposes its product tools here except Computer Use and native Agent definition/memory tools. Call federation_agent_list with no arguments for the native, OpenClaw, and Hermes directory. For connected/available Agent counts, count only agents with connected=true; distinguish configured directory totals and unavailableBackends. Use federation_agent_get for one target; use federation_agent_run, federation_task_get, federation_agent_message, and federation_task_cancel for owner-bound collaboration.",
  "Never invent or alter a federation task handle, never answer a waiting target Agent prompt on the user's behalf, and report waitingFor plainly.",
  SHOGGOTH_EXTERNAL_PRODUCT_DEVELOPER_INSTRUCTIONS,
].join("\n");

function helperError(code, message) {
  return serviceError(code, message);
}

// A stopped/recovering Service cannot authenticate a helper. Keep that distinct
// from rejected credentials, without carrying transport messages or private paths.
function authenticationError(error, fromService = false) {
  let code;
  try { code = Object.getOwnPropertyDescriptor(error, "code")?.value; } catch {}
  if (code === "MCP_HELPER_SERVICE_RECOVERY_REQUIRED" || fromService && code === "SERVICE_RECOVERY_REQUIRED") {
    return helperError("MCP_HELPER_SERVICE_RECOVERY_REQUIRED", "mcp_helper_service_recovery_required");
  }
  if (code === "MCP_HELPER_SERVICE_UNAVAILABLE" || fromService && [
    "SERVICE_UNAVAILABLE", "SERVICE_QUIESCED", "SERVICE_DISCONNECTED", "REQUEST_TIMEOUT",
    "ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE",
  ].includes(code)) {
    return helperError("MCP_HELPER_SERVICE_UNAVAILABLE", "mcp_helper_service_unavailable");
  }
  return helperError("MCP_HELPER_AUTH_FAILED", "mcp_helper_auth_failed");
}

async function requestAuthentication(requestService, paths, request) {
  try {
    return await requestService(paths, request, { timeoutMs: MCP_AUTH_SERVICE_TIMEOUT_MS });
  } catch (error) {
    throw authenticationError(error, true);
  }
}

function resolveMcpCryptoRequestTimeout({ explicitTimeoutMs, isPackaged, defaultApp }) {
  if (explicitTimeoutMs !== undefined) return explicitTimeoutMs;
  // Packaged helper 的首次认证需要校验 App 与内置 Codex 的签名身份。冷启动时该过程
  // 可能明显超过 broker 的通用 8 秒默认值，但仍须受 MCP 启动总预算约束。
  if (isPackaged === true && defaultApp !== true) return MCP_PACKAGED_CRYPTO_TIMEOUT_MS;
  return undefined;
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function isCanonicalBase64Url(value, bytes) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  try {
    return decoded.length === bytes && decoded.toString("base64url") === value;
  } finally {
    decoded.fill(0);
  }
}

function validRuntimeProfileId(value) {
  try {
    assertRuntimeProfileId(value);
    return true;
  } catch {
    return false;
  }
}

function validRuntimeAccountId(value) {
  return typeof value === "string" && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function parseMcpRuntimeBinding(argv = process.argv.slice(1)) {
  if (!Array.isArray(argv)) throw helperError("MCP_HELPER_ARGUMENTS_INVALID", "mcp_helper_arguments_invalid");
  const profiles = argv.filter((arg) => typeof arg === "string"
    && arg.startsWith(MCP_RUNTIME_PROFILE_PREFIX));
  const accounts = argv.filter((arg) => typeof arg === "string"
    && arg.startsWith(MCP_RUNTIME_ACCOUNT_PREFIX));
  const residentExposure = argv.filter((arg) => arg === MCP_RESIDENT_TOOL_EXPOSURE_ARG);
  const forbidden = argv.some((arg) => typeof arg === "string" && arg.startsWith("--shoggoth-")
    && !arg.startsWith(MCP_RUNTIME_PROFILE_PREFIX)
    && !arg.startsWith(MCP_RUNTIME_ACCOUNT_PREFIX)
    && arg !== MCP_RESIDENT_TOOL_EXPOSURE_ARG
    && arg !== "--shoggoth-internal-role=mcp");
  if (forbidden || profiles.length !== 1 || accounts.length !== 1 || residentExposure.length > 1) {
    throw helperError("MCP_HELPER_ARGUMENTS_INVALID", "mcp_helper_arguments_invalid");
  }
  const runtimeProfileId = profiles[0].slice(MCP_RUNTIME_PROFILE_PREFIX.length);
  const runtimeAccountId = accounts[0].slice(MCP_RUNTIME_ACCOUNT_PREFIX.length);
  if (!validRuntimeProfileId(runtimeProfileId) || !validRuntimeAccountId(runtimeAccountId)) {
    throw helperError("MCP_HELPER_ARGUMENTS_INVALID", "mcp_helper_arguments_invalid");
  }
  return Object.freeze({ runtimeProfileId, runtimeAccountId,
    toolExposure: residentExposure.length === 1 ? "resident" : "all" });
}

function parseMcpRuntimeProfileId(argv = process.argv.slice(1)) {
  return parseMcpRuntimeBinding(argv).runtimeProfileId;
}

function runtimeMcpPaths(defaultPaths, context, binding, canonicalPaths = defaultPaths) {
  if (context === null || context === undefined) return defaultPaths;
  if (!exactObject(binding, ["runtimeProfileId", "runtimeAccountId"])
    || !exactObject(context, ["runtimeProfileId", "runtimeAccountId", "servicePaths"])
    || context.runtimeProfileId !== binding.runtimeProfileId
    || context.runtimeAccountId !== binding.runtimeAccountId
    || !exactObject(context.servicePaths, [
      "trustedRoot", "stateDir", "mcpAuthPath", "runtimeDir", "socketPath",
    ])) {
    throw helperError("MCP_HELPER_AUTH_FAILED", "mcp_helper_auth_failed");
  }
  const servicePaths = context.servicePaths;
  if (!Object.values(servicePaths).every((value) => typeof value === "string"
    && path.isAbsolute(value) && !value.includes("\0"))
    || !Object.keys(servicePaths).every((field) => servicePaths[field] === canonicalPaths?.[field])
    || path.dirname(servicePaths.mcpAuthPath) !== servicePaths.stateDir
    || path.basename(servicePaths.mcpAuthPath) !== "mcp-auth.json"
    || path.dirname(servicePaths.socketPath) !== servicePaths.runtimeDir
    || path.basename(servicePaths.socketPath) !== "service.sock") {
    throw helperError("MCP_HELPER_AUTH_FAILED", "mcp_helper_auth_failed");
  }
  return Object.freeze({
    ...defaultPaths,
    trustedRoot: canonicalPaths.trustedRoot,
    stateDir: canonicalPaths.stateDir,
    mcpAuthPath: canonicalPaths.mcpAuthPath,
    runtimeDir: canonicalPaths.runtimeDir,
    socketPath: canonicalPaths.socketPath,
    // Electron/crypto worker 的临时 profile 仍写进受管 HOME；Service 状态只读。
    profileDir: defaultPaths.profileDir,
    cacheDir: defaultPaths.cacheDir,
  });
}

function validateChallenge(challenge, expected) {
  return exactObject(challenge, [
    "challengeId", "protocolVersion", "runtimeProfileId", "runtimeAccountId",
    "clientNonce", "serverNonce", "expiresAt",
  ]) && isCanonicalBase64Url(challenge.challengeId, 16)
    && challenge.protocolVersion === MCP_SERVICE_PROTOCOL_VERSION
    && challenge.runtimeProfileId === expected.runtimeProfileId
    && challenge.runtimeAccountId === expected.runtimeAccountId
    && challenge.clientNonce === expected.clientNonce
    && isCanonicalBase64Url(challenge.serverNonce, 32)
    && Number.isSafeInteger(challenge.expiresAt) && challenge.expiresAt >= 0;
}

function validateSession(session, binding) {
  return exactObject(session, [
    "token", "protocolVersion", "runtimeProfileId", "runtimeAccountId", "profileId", "expiresAt",
  ])
    && isCanonicalBase64Url(session.token, 32)
    && session.protocolVersion === MCP_SERVICE_PROTOCOL_VERSION
    && session.runtimeProfileId === binding.runtimeProfileId
    && session.runtimeAccountId === binding.runtimeAccountId
    && typeof session.profileId === "string" && session.profileId.length > 0
    && Buffer.byteLength(session.profileId, "utf8") <= 128
    && Number.isSafeInteger(session.expiresAt) && session.expiresAt >= 0;
}

async function authenticateMcpSession(options = {}) {
  const paths = options.paths || resolveCanonicalServicePaths();
  const runtimeProfileId = options.runtimeProfileId;
  const runtimeAccountId = options.runtimeAccountId;
  if (!validRuntimeProfileId(runtimeProfileId) || !validRuntimeAccountId(runtimeAccountId)) {
    throw helperError("MCP_HELPER_AUTH_FAILED", "mcp_helper_auth_failed");
  }
  const requestService = options.requestService || defaultRequestService;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const cryptoBroker = options.mcpCryptoBroker || null;
  const authStore = cryptoBroker ? null : new McpAuthSecretStore({
    paths, access: "helper", safeStorage: options.safeStorage, fs: options.mcpAuthFs,
  });
  let secret = null;
  let clientNonceBytes = null;
  try {
    try {
      clientNonceBytes = randomBytes(32);
    } catch {
      throw helperError("MCP_HELPER_AUTH_FAILED", "mcp_helper_auth_failed");
    }
    if (!Buffer.isBuffer(clientNonceBytes) || clientNonceBytes.length !== 32) {
      throw helperError("MCP_HELPER_AUTH_FAILED", "mcp_helper_auth_failed");
    }
    const clientNonce = clientNonceBytes.toString("base64url");
    clientNonceBytes.fill(0);
    clientNonceBytes = null;
    const challenge = await requestAuthentication(requestService, paths, {
      version: MCP_SERVICE_PROTOCOL_VERSION,
      method: "mcp.auth.challenge",
      params: {
        protocolVersion: MCP_SERVICE_PROTOCOL_VERSION,
        runtimeProfileId,
        runtimeAccountId,
        clientNonce,
      },
    });
    if (!validateChallenge(challenge, { runtimeProfileId, runtimeAccountId, clientNonce })) {
      throw helperError("MCP_HELPER_AUTH_FAILED", "mcp_helper_auth_failed");
    }
    // 首次 challenge 允许 Service 惰性创建长期 secret；Helper 随后只读打开，
    // 始终不承担目录、容器或 secret 的创建权。
    if (cryptoBroker) {
      secret = await cryptoBroker.readForHelper({ generation: options.cryptoGeneration || 1 });
    } else {
      authStore.open();
      secret = authStore.readForHelper();
    }
    const proof = createMcpChallengeProof(secret, challenge);
    const session = await requestAuthentication(requestService, paths, {
      version: MCP_SERVICE_PROTOCOL_VERSION,
      method: "mcp.auth.exchange",
      params: {
        challengeId: challenge.challengeId,
        protocolVersion: challenge.protocolVersion,
        runtimeProfileId,
        runtimeAccountId,
        clientNonce,
        serverNonce: challenge.serverNonce,
        proof,
      },
    });
    if (!validateSession(session, { runtimeProfileId, runtimeAccountId })) {
      throw helperError("MCP_HELPER_AUTH_FAILED", "mcp_helper_auth_failed");
    }
    return { ...session };
  } catch (error) {
    throw authenticationError(error);
  } finally {
    if (clientNonceBytes) clientNonceBytes.fill(0);
    if (secret) secret.fill(0);
    try { authStore?.close(); } catch {}
  }
}

async function authenticateFederationMcpSession(options = {}) {
  const paths = options.paths || resolveCanonicalServicePaths();
  const runtimeProfileId = options.runtimeProfileId;
  const runtimeAccountId = options.runtimeAccountId;
  const client = options.client;
  if (!validRuntimeProfileId(runtimeProfileId) || !validRuntimeAccountId(runtimeAccountId)
    || !FEDERATION_MCP_CLIENTS.has(client)
    || path.resolve(options.authFile || "") !== federationMcpAuthPath(paths)) {
    throw helperError("MCP_HELPER_AUTH_FAILED", "mcp_helper_auth_failed");
  }
  const requestService = options.requestService || defaultRequestService;
  let credential;
  try {
    credential = loadFederationMcpCredential(paths);
    const session = await requestAuthentication(requestService, paths, {
      version: MCP_SERVICE_PROTOCOL_VERSION,
      method: "mcp.federation.open",
      params: { runtimeProfileId, runtimeAccountId, credentialToken: credential.token, client },
    });
    if (!validateSession(session, { runtimeProfileId, runtimeAccountId })) {
      throw helperError("MCP_HELPER_AUTH_FAILED", "mcp_helper_auth_failed");
    }
    return { ...session };
  } catch (error) {
    throw authenticationError(error);
  } finally {
    credential = null;
  }
}

function validJsonRpcId(value) {
  return (typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 256)
    || (typeof value === "number" && Number.isSafeInteger(value));
}

function boundedNonEmptyString(value, maxBytes) {
  return typeof value === "string" && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function boundedJsonObject(value, maxBytes) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > maxBytes) return false;
    const stack = [{ value, depth: 0 }];
    let entries = 0;
    while (stack.length > 0) {
      const current = stack.pop();
      if (current.depth > 6) return false;
      if (current.value === null || typeof current.value === "boolean"
        || typeof current.value === "string") continue;
      if (typeof current.value === "number") {
        if (!Number.isFinite(current.value)) return false;
        continue;
      }
      if (typeof current.value !== "object") return false;
      const prototype = Object.getPrototypeOf(current.value);
      if (!Array.isArray(current.value) && prototype !== Object.prototype) return false;
      const values = Array.isArray(current.value)
        ? current.value
        : Object.keys(current.value).map((key) => current.value[key]);
      entries += values.length;
      if (entries > 128) return false;
      for (const item of values) stack.push({ value: item, depth: current.depth + 1 });
    }
    return true;
  } catch {
    return false;
  }
}

function dataErrorCode(error) {
  try {
    if ((typeof error !== "object" && typeof error !== "function") || error === null) return "";
    let current = error;
    const seen = new Set();
    for (let depth = 0; depth < 16 && current !== null; depth += 1) {
      if (seen.has(current)) return "";
      seen.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, "code");
      if (descriptor) {
        return Object.prototype.hasOwnProperty.call(descriptor, "value")
          && typeof descriptor.value === "string" ? descriptor.value : "";
      }
      current = Object.getPrototypeOf(current);
    }
  } catch {}
  return "";
}

function publicServiceErrorCode(error) {
  const code = dataErrorCode(error);
  return /^[A-Z][A-Z0-9_]{2,63}$/u.test(code)
    && (PUBLIC_SERVICE_ERROR_PREFIXES.some((prefix) => code.startsWith(prefix))
      || Object.hasOwn(CHAT_UI_PUBLIC_MESSAGES, code)
      || code.startsWith("WEB_") && Object.hasOwn(MCP_PRODUCT_PUBLIC_MESSAGES, code)
      || code.startsWith("PROACTIVE_") && Object.hasOwn(MCP_PRODUCT_PUBLIC_MESSAGES, code)
      || require("./agent-service/hook-contract").HOOK_PUBLIC_ERROR_CODES.includes(code))
    ? code
    : "SERVICE_REQUEST_FAILED";
}

function toolFailureResponse(id, error) {
  const code = publicServiceErrorCode(error);
  const message = MCP_PRODUCT_PUBLIC_MESSAGES[code] || "Shoggoth Service request failed";
  return jsonRpcResult(id, {
    content: [{ type: "text", text: `${message} (${code})` }],
    structuredContent: { error: { code } },
    isError: true,
  });
}

// A tool result rather than a JSON-RPC error, so every runtime shows the model
// which fields to fix (Pi, for one, reduces protocol errors to a fixed string).
function invalidToolArgumentsResponse(id, name, args) {
  const code = "MCP_TOOL_INVALID_ARGUMENTS";
  const { problems, hints } = explainMcpProductToolArguments(name, args);
  const details = [...problems, ...hints];
  const reason = details.length > 0 ? details.join("；") : "参数组合不满足该工具的要求，请对照工具说明";
  return jsonRpcResult(id, {
    content: [{ type: "text", text: `${MCP_PRODUCT_PUBLIC_MESSAGES[code]}（${name}）：${reason} (${code})` }],
    structuredContent: { error: { code, problems } },
    isError: true,
  });
}

function cloneMcpServiceResult(value, state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > 16_384 || depth > 32) {
    throw helperError("MCP_HELPER_RESPONSE_INVALID", "mcp_helper_response_invalid");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!value.isWellFormed()) {
      throw helperError("MCP_HELPER_RESPONSE_INVALID", "mcp_helper_response_invalid");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw helperError("MCP_HELPER_RESPONSE_INVALID", "mcp_helper_response_invalid");
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
      throw helperError("MCP_HELPER_RESPONSE_INVALID", "mcp_helper_response_invalid");
    }
    const length = lengthDescriptor && Object.prototype.hasOwnProperty.call(lengthDescriptor, "value")
      ? lengthDescriptor.value : -1;
    if (keys.some((key) => key !== "length"
      && !(typeof key === "string" && /^(?:0|[1-9][0-9]*)$/u.test(key)))
      || !Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) {
      throw helperError("MCP_HELPER_RESPONSE_INVALID", "mcp_helper_response_invalid");
    }
    const result = [];
    for (let index = 0; index < length; index += 1) {
      let descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); } catch {
        throw helperError("MCP_HELPER_RESPONSE_INVALID", "mcp_helper_response_invalid");
      }
      if (!descriptor || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        throw helperError("MCP_HELPER_RESPONSE_INVALID", "mcp_helper_response_invalid");
      }
      result.push(cloneMcpServiceResult(descriptor.value, state, depth + 1));
    }
    return result;
  }
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw helperError("MCP_HELPER_RESPONSE_INVALID", "mcp_helper_response_invalid");
  }
  if (prototype !== Object.prototype || keys.some((key) => typeof key !== "string")) {
    throw helperError("MCP_HELPER_RESPONSE_INVALID", "mcp_helper_response_invalid");
  }
  const result = {};
  for (const key of keys) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch {
      throw helperError("MCP_HELPER_RESPONSE_INVALID", "mcp_helper_response_invalid");
    }
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")
      || descriptor.enumerable !== true) {
      throw helperError("MCP_HELPER_RESPONSE_INVALID", "mcp_helper_response_invalid");
    }
    Object.defineProperty(result, key, {
      value: cloneMcpServiceResult(descriptor.value, state, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function validateInitializeParams(params) {
  const hasMeta = params && Object.prototype.hasOwnProperty.call(params, "_meta");
  const clientInfoKeys = params?.clientInfo && typeof params.clientInfo === "object"
    ? Object.keys(params.clientInfo)
    : [];
  const validClientInfoShape = exactObject(params?.clientInfo, ["name", "version"])
    || exactObject(params?.clientInfo, ["name", "title", "version"]);
  const capabilities = params?.capabilities;
  const capabilityKeys = capabilities && typeof capabilities === "object" ? Object.keys(capabilities) : [];
  const knownCapabilities = new Set(["experimental", "roots", "sampling", "elicitation"]);
  const extensionCapabilitiesValid = capabilityKeys
    .filter((key) => !knownCapabilities.has(key))
    .every((key) => boundedJsonObject(capabilities[key], MCP_INITIALIZE_CAPABILITIES_MAX_BYTES));
  const experimentalValid = !Object.prototype.hasOwnProperty.call(capabilities || {}, "experimental")
    || (boundedJsonObject(capabilities.experimental, MCP_INITIALIZE_CAPABILITIES_MAX_BYTES)
      && Object.values(capabilities.experimental).every(
        (value) => boundedJsonObject(value, MCP_INITIALIZE_CAPABILITIES_MAX_BYTES),
      ));
  const capabilitiesShapeValid = boundedJsonObject(
    capabilities, MCP_INITIALIZE_CAPABILITIES_MAX_BYTES,
  ) && extensionCapabilitiesValid
    && experimentalValid
    && (!Object.prototype.hasOwnProperty.call(capabilities, "roots")
      || exactObject(capabilities.roots,
        Object.prototype.hasOwnProperty.call(capabilities.roots || {}, "listChanged")
          ? ["listChanged"] : [])
      && (capabilities.roots.listChanged === undefined
        || typeof capabilities.roots.listChanged === "boolean"))
    && (!Object.prototype.hasOwnProperty.call(capabilities, "sampling")
      || boundedJsonObject(capabilities.sampling, MCP_INITIALIZE_CAPABILITIES_MAX_BYTES))
    && (!Object.prototype.hasOwnProperty.call(capabilities, "elicitation")
      || boundedJsonObject(capabilities.elicitation, MCP_INITIALIZE_CAPABILITIES_MAX_BYTES));
  return exactObject(params, hasMeta
    ? ["protocolVersion", "capabilities", "clientInfo", "_meta"]
    : ["protocolVersion", "capabilities", "clientInfo"])
    && (!hasMeta || boundedJsonObject(params._meta, 4 * 1024))
    && boundedNonEmptyString(params.protocolVersion, 32)
    && capabilitiesShapeValid
    && validClientInfoShape
    && boundedNonEmptyString(params.clientInfo.name, MCP_INITIALIZE_TEXT_MAX_BYTES)
    && boundedNonEmptyString(params.clientInfo.version, MCP_INITIALIZE_TEXT_MAX_BYTES)
    && (!clientInfoKeys.includes("title")
      || boundedNonEmptyString(params.clientInfo.title, MCP_INITIALIZE_TEXT_MAX_BYTES));
}

function validateRequestUserInputArguments(value) {
  if (!exactObject(value, ["questions"]) || !Array.isArray(value.questions)
    || value.questions.length < 1 || value.questions.length > MCP_MAX_QUESTIONS
    || !boundedJsonObject(value, 16 * 1024)) return null;
  const ids = new Set();
  const questions = [];
  for (const question of value.questions) {
    if (!exactObject(question, ["header", "id", "question", "options"])
      || !boundedNonEmptyString(question.header, 64)
      || !boundedNonEmptyString(question.id, 64)
      || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(question.id)
      || ids.has(question.id)
      || !boundedNonEmptyString(question.question, 1024)
      || !Array.isArray(question.options) || question.options.length < 2
      || question.options.length > MCP_MAX_QUESTION_OPTIONS) return null;
    const labels = new Set();
    const options = [];
    for (const option of question.options) {
      if (!exactObject(option, ["label", "description"])
        || !boundedNonEmptyString(option.label, 128)
        || !boundedNonEmptyString(option.description, 512)
        || labels.has(option.label)) return null;
      labels.add(option.label);
      options.push({ label: option.label, description: option.description });
    }
    ids.add(question.id);
    questions.push({
      header: question.header,
      id: question.id,
      question: question.question,
      options,
    });
  }
  return questions;
}

function elicitationParamsFor(questions) {
  const properties = {};
  for (const question of questions) {
    properties[question.id] = {
      type: "string",
      title: question.header,
      description: [
        // Product details live once in message, where the confirmation card
        // renders them in full. Duplicating a large roster here exceeds the
        // bounded transport and the field-description limit.
        question.id === "confirm_product_action" ? question.header : question.question,
        ...question.options.map((option) => `${option.label}: ${option.description}`),
      ].join("\n"),
      enum: question.options.map((option) => option.label),
      enumNames: question.options.map((option) => option.label),
    };
  }
  return {
    message: questions.map((question) => question.question).join("\n"),
    requestedSchema: {
      type: "object",
      properties,
      required: questions.map((question) => question.id),
    },
  };
}

function normalizeElicitationResult(value, questions) {
  const allowedKeys = new Set(["action", "content", "_meta"]);
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some((key) => !allowedKeys.has(key))
    || !["accept", "decline", "cancel"].includes(value.action)
    || (Object.prototype.hasOwnProperty.call(value, "_meta")
      && !boundedJsonObject(value._meta, 4 * 1024))) {
    throw helperError("MCP_HELPER_ELICITATION_INVALID", "mcp_helper_elicitation_invalid");
  }
  if (value.action !== "accept") {
    if (Object.prototype.hasOwnProperty.call(value, "content")) {
      throw helperError("MCP_HELPER_ELICITATION_INVALID", "mcp_helper_elicitation_invalid");
    }
    return { answers: {} };
  }
  if (!value.content || typeof value.content !== "object" || Array.isArray(value.content)
    || Object.getPrototypeOf(value.content) !== Object.prototype
    || Object.keys(value.content).length !== questions.length) {
    throw helperError("MCP_HELPER_ELICITATION_INVALID", "mcp_helper_elicitation_invalid");
  }
  const answers = {};
  for (const question of questions) {
    const answer = value.content[question.id];
    if (typeof answer !== "string"
      || !question.options.some((option) => option.label === answer)) {
      throw helperError("MCP_HELPER_ELICITATION_INVALID", "mcp_helper_elicitation_invalid");
    }
    answers[question.id] = { answers: [answer] };
  }
  return { answers };
}

function listPreview(names, limit = 8) {
  const shown = names.slice(0, limit).map(value => JSON.stringify(String(value).slice(0, 64)));
  return `${shown.join("、")}${names.length > limit ? ` 等 ${names.length} 项` : ""}`;
}

function endpointLabel(target) {
  try { return new URL(target).origin; } catch { return String(target).slice(0, 128); }
}

function pluginConfirmationQuestion(name, args, plugin) {
  if (name === "plugin_install") {
    const skills = plugin.previewComponents.skills.map(item => item.name);
    const servers = plugin.previewComponents.mcpServers.map(item => item.name);
    const contents = [`${skills.length} 个技能${skills.length ? `（${listPreview(skills)}）` : ""}`,
      `${servers.length} 个 MCP 服务${servers.length ? `（${listPreview(servers)}）` : ""}`].join("、");
    const version = plugin.declaredVersion || "未标注";
    const installed = plugin.installation;
    const update = Boolean(installed) && installed.releaseDigest !== plugin.previewDigest;
    const verb = update ? "更新" : "安装";
    const head = update
      ? `Shoggoth 将把插件 ${JSON.stringify(plugin.name)} 从版本 ${installed.declaredVersion || "未标注"} 更新为 ${version}：${contents}。${installed.desiredState === "enabled"
        ? "更新前会先停用旧版本，并等待进行中的调用结束。" : ""}`
      : `Shoggoth 将安装插件 ${JSON.stringify(plugin.name)}（版本 ${version}）：${contents}。`;
    return `${head}${args.enable
      ? `${verb}后立即为所有助理启用其技能；MCP 服务的连接与工具授权${update ? "需要重新" : "仍需单独"}确认。`
      : `${verb}后保持停用。`}是否继续？`;
  }
  const active = plugin.components.filter(item => !["unsupported", "secret_required"].includes(item.state));
  const skipped = plugin.components.filter(item => ["unsupported", "secret_required"].includes(item.state));
  const lines = active.map(item => `${JSON.stringify(item.name)}（${item.transport === "stdio"
    ? `运行 ${JSON.stringify(item.target)}` : `连接 ${endpointLabel(item.target)}`}${item.interpreter && !item.interpreterReady
    ? `，使用本机已安装的 ${item.interpreter === "node" ? "Node.js" : "Python"}` : ""}）`);
  return `Shoggoth 将启用插件 ${JSON.stringify(plugin.packageName)}${lines.length
    ? `，并连接 MCP 服务 ${lines.join("；")}。所有助理将可使用这些服务提供的全部工具；标注为破坏性的工具每次调用前仍会询问你，可随时在插件页撤销`
    : ""}。${skipped.length ? `${listPreview(skipped.map(item => item.name))} 尚需凭据或在插件页连接账号，本次不处理。` : ""}是否继续？`;
}

function confirmationQuestionFor(name, args, nativeAgent = null, hookGrant = null, plugin = null, group = null, management = null) {
  if (["group_chat_create", "group_chat_members_add"].includes(name)) {
    if (!management || management.ok !== true || management.state !== "prepared" || !Array.isArray(management.members)
      || management.ownerScope !== args.ownerScope || management.previewDigest !== args.previewDigest) {
      throw helperError("MCP_TOOL_STATE_CONFLICT", "group_management_preflight_failed");
    }
    const members = management.members.map(member => `${JSON.stringify(member.displayName)}（${member.backendId} / ${member.agentId}）`).join("、");
    const question = name === "group_chat_create"
      ? `创建群 ${JSON.stringify(management.name)}，成员为 ${members}。${management.purpose ? `\n\n群用途：${management.purpose}` : ""}\n\n确认创建？`
      : `将 ${members} 加入群 ${JSON.stringify(management.group?.name)}（${args.groupId}）。\n\n确认添加？`;
    if (Buffer.byteLength(question) > 12 * 1024) throw helperError("MCP_TOOL_CAPACITY", "group_management_preflight_failed");
    return [{ header: name === "group_chat_create" ? "确认建群" : "确认添加成员", id: "confirm_product_action", question,
      options: [{ label: "确认执行", description: "按上述群名和名单完成这一次操作。" }, { label: "取消", description: "不修改群或成员。" }] }];
  }
  if (name === "group_chat_dispatch") {
    if (!group || group.ok !== true || group.group?.id !== args.groupId || !Array.isArray(group.members)) {
      throw helperError("MCP_TOOL_RESPONSE_INVALID", "group_dispatch_preflight_failed");
    }
    const targets = args.targetMemberIds.map(id => group.members.find(member => member.id === id && member.state === "active"));
    if (targets.some(member => !member) || group.ownerScope !== args.ownerScope
      || group.group.status !== "active" || group.group.rosterRevision !== args.expectedRosterRevision
      || group.group.policyVersion !== args.expectedPolicyVersion) throw helperError("MCP_TOOL_STATE_CONFLICT", "group_dispatch_preflight_failed");
    const question = `将下列安排发送到群 ${JSON.stringify(group.group.name)}（${args.groupId}），交给 ${targets.map(member => `${JSON.stringify(member.displayName)}（${member.id}）`).join("、")}。${args.requestMode === "append" ? `追加到请求 ${args.discussionId}` : "新建一项群内请求"}，可能启动成员执行。\n\n${args.instruction}\n\n确认发送？`;
    if (Buffer.byteLength(question) > 12 * 1024) throw helperError("MCP_TOOL_CAPACITY", "group_dispatch_preflight_failed");
    return [{ header: "确认群内安排", id: "confirm_product_action", question,
      options: [{ label: "确认执行", description: "仅向上述群和成员提交这一次安排。" }, { label: "取消", description: "不发送群消息，不启动执行。" }] }];
  }
  if (name === "plugin_install" || name === "plugin_activate") {
    const question = pluginConfirmationQuestion(name, args, plugin);
    if (Buffer.byteLength(question, "utf8") > 4096) throw helperError("MCP_TOOL_CAPACITY", "plugin_preflight_failed");
    return [{ header: name === "plugin_install" ? "确认安装" : "确认启用", id: "confirm_product_action", question,
      options: [{ label: "确认执行", description: "仅执行上述已列出的插件操作。" },
        { label: "取消", description: "不修改插件状态。" }] }];
  }
  if (name === "hook_grant") {
    if (!hookGrant || hookGrant.hookId !== args.hookId || hookGrant.version !== args.version) {
      throw helperError("MCP_TOOL_RESPONSE_INVALID", "hook_grant_preflight_failed");
    }
    const definition = hookGrant.definition;
    const handler = definition.handler;
    const name = handler.name;
    const payload = handler.type === "script" || ["guard.condition", "arguments.patch", "result.redact"].includes(name);
    const write = definition.kind === "action";
    const read = write || ["context.file", "workspace.copy"].includes(name) || handler.access?.workspaceRead === true;
    const question = `授权持续规则 ${JSON.stringify(definition.name)}（${hookGrant.hookId}，版本 ${hookGrant.version}，内容摘要 ${hookGrant.contentDigest}）。事件：${definition.event}；处理器：${handler.type === "script" ? handler.language + " 脚本" : name}；匹配：${JSON.stringify(definition.matcher)}；设置：${handler.type === "script" ? "脚本源摘要 " + handler.sourceDigest : JSON.stringify(handler.config)}；业务事件内容：${payload ? "可读取" : "仅元数据"}；工作目录读取：${read ? "允许" : "禁止"}；工作目录写入：${write ? "允许" : "禁止"}；目录：${hookGrant.boundWorkspace === null ? "当前助理的所有工作目录" : JSON.stringify(hookGrant.boundWorkspace)}。网络和子进程禁止。授权仅对这个不可变版本有效，启用后会在匹配事件中持续生效。是否授权？`;
    if (Buffer.byteLength(question, "utf8") > 4096) throw helperError("MCP_TOOL_CAPACITY", "hook_grant_preflight_failed");
    return [{ header: "确认授权", id: "confirm_product_action", question,
      options: [{ label: "确认执行", description: "仅授权上述版本、数据和目录范围。" },
        { label: "取消", description: "不授权此版本。" }] }];
  }
  if (name === "native_agent_archive" || name === "native_agent_update") {
    const target = `${JSON.stringify(nativeAgent.name)}（${args.backendId}/${args.agentId}）`;
    const changes = [
      ...(Object.hasOwn(args, "name") ? [`名称改为 ${JSON.stringify(args.name)}`] : []),
      ...(Object.hasOwn(args, "workspace") ? [`工作目录改为 ${args.workspace === null ? "默认目录" : JSON.stringify(args.workspace)}`] : []),
    ].join("；");
    return [{ header: name === "native_agent_archive" ? "确认归档" : "确认修改",
      id: "confirm_product_action",
      question: name === "native_agent_archive"
        ? `Shoggoth 将归档并隐藏本地助理 ${target}。配置、记忆和历史保留 7 天，到期后自动删除；工作区文件和共享账号保留。是否继续？`
        : `Shoggoth 将修改本地助理 ${target}：${changes}。是否继续？`,
      options: [{ label: "确认执行", description: "执行这一次已明确列出的操作。" },
        { label: "取消", description: "不修改任何产品状态。" }],
    }];
  }
  if (name === "app_manage") {
    const input = args.arguments;
    const target = input.jobId || input.cardId || input.boardId || input.agentId || args.targetProfileId;
    const details = JSON.stringify(input);
    const preview = [...details].slice(0, 900).join("");
    return [{ header: "确认管理", id: "confirm_product_action",
      question: `Shoggoth 将执行 ${args.operation}。后端：${args.backendId}；目标：${target}；归属：${args.targetProfileId || "按目标核对"}；版本：${args.expectedRevision || "新建"}。参数：${preview}${details.length > preview.length ? "…（参数较长）" : ""}。是否执行这一次操作？`,
      options: [{ label: "确认执行", description: "授权这一次列出的目标与操作。" }, { label: "取消", description: "不修改 App 数据。" }],
    }];
  }
  const targetFactories = {
    cron_delete: () => `Cron Job ${args.jobId}`,
    inspiration_delete: () => `灵感 ${args.id}（版本 ${args.expectedRevision}）`,
    web_defaults_set: () => `统一联网默认设置（${Object.entries(args.config).map(([key, value]) => `${key === "searchProvider" ? "搜索" : "网页读取"}：${value}`).join("；")}；未列出的选项不变；影响所有跟随默认的原生 Agent 和 HEARTBEAT，保留独立选择；设置版本 ${args.expectedRevision}）`,
    inspiration_growth_set: () => `灵感自动执行设置（${args.enabled
      ? "开启后将自动分派已保存的便签"
      : "暂停新的自动分派；正在执行的任务会继续"}；执行者：${args.executors.map(value => `${value.backendId}/${value.agentId}`).join(", ") || "无"}；设置版本 ${args.expectedRevision}）`,
    external_agent_update: () => `${args.backendId} Agent ${args.agentId}`,
    external_agent_delete: () => `${args.backendId} Agent ${args.agentId}`,
    external_agent_file_write: () => `${args.backendId} Agent ${args.agentId} 的 ${args.file}`,
    computer_session_open: () => `Computer Use 会话（${args.allowedApplications.join(", ")}；随当前任务结束）`,
    computer_session_resume: () => `Computer Use 会话 ${args.sessionId}`,
    browser_session_open: () => `Browser Use 会话（随当前任务结束；使用本机 Chrome，运行与登录状态模式遵循设置）`,
    skill_install_global: () => `全局 Skill 包 ${JSON.stringify(args.sourcePath)}`,
    mcp_server_register: () => `共享 MCP Server ${JSON.stringify(args.name)}（${args.id}；${JSON.stringify(args.command)}）`,
    mcp_server_remove: () => `共享 MCP Server ${args.id}（仅移除注册，不删除安装文件）`,
  };
  const risk = productToolRisk(name);
  if (!targetFactories[name] || !["confirm", "destructive"].includes(risk)) return null;
  const target = targetFactories[name]();
  const verb = risk === "destructive" ? "删除" : "操作";
  return [{
    header: risk === "destructive" ? "确认删除" : "确认修改",
    id: "confirm_product_action",
    question: `Shoggoth 将${verb}${target}。是否继续？`,
    options: [
      { label: "确认执行", description: "执行这一次已明确列出的操作。" },
      { label: "取消", description: "不修改任何产品状态。" },
    ],
  }];
}

function withTimeout(promise, timeoutMs, errorFactory) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(errorFactory()), timeoutMs);
    Promise.resolve(promise).then(
      (value) => finish(null, value),
      (error) => finish(error),
    );
  });
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: validJsonRpcId(id) ? id : null, error: { code, message } };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function toolSuccessResponse(id, result, toolName) {
  const content = [{ type: "text", text: JSON.stringify(result) }];
  // Browser calls and workspace commands return an execution outcome inside a
  // successful Service RPC. Preserve their real failure in the MCP envelope.
  const isError = (toolName === "browser_tool_call" && result?.isError === true)
    || (toolName === "workspace_execute" && Number.isInteger(result?.exitCode) && result.exitCode !== 0);
  let response = jsonRpcResult(id, { content, structuredContent: result, isError });
  if (Buffer.byteLength(JSON.stringify(response), "utf8") <= MCP_MAX_FRAME_BYTES) return response;
  response = jsonRpcResult(id, { content, isError });
  if (Buffer.byteLength(JSON.stringify(response), "utf8") <= MCP_MAX_FRAME_BYTES) return response;
  throw helperError("MCP_HELPER_RESPONSE_TOO_LARGE", "mcp_helper_response_too_large");
}

function toolListPages(definitions) {
  const revision = crypto.createHash("sha256").update(JSON.stringify(definitions)).digest("base64url");
  const pages = new Map();
  let start = 0;
  while (start < definitions.length) {
    const tools = [];
    let end = start;
    let bytes = 0;
    // Reserve room for the JSON-RPC envelope, escaped request ID and cursor.
    while (end < definitions.length) {
      const size = Buffer.byteLength(JSON.stringify(definitions[end]), "utf8") + 1;
      if (bytes + size > MCP_MAX_CATALOG_FRAME_BYTES - 2048) break;
      tools.push(structuredClone(definitions[end++]));
      bytes += size;
    }
    if (end === start) throw helperError("MCP_HELPER_RESPONSE_TOO_LARGE", "mcp_tool_definition_too_large");
    pages.set(start === 0 ? "" : `${revision}.${start}`, {
      tools, ...(end < definitions.length ? { nextCursor: `${revision}.${end}` } : {}),
    });
    start = end;
  }
  return pages;
}

// Pi, OpenCode and DeepSeek give the model only the text content, and several
// models have no image input, so the text repeats the revision and element refs
// the action tools need. One line per element keeps the 64 KiB frame budget;
// the full values stay in structuredContent.
function computerSnapshotText(snapshot, includeImage, includeFrames) {
  const lines = [
    includeImage ? "Shoggoth Computer Use snapshot captured"
      : "Shoggoth Computer Use snapshot captured without an inline image",
    `sessionId=${snapshot.sessionId} snapshotRevision=${snapshot.snapshotRevision}`
      + ` pid=${snapshot.pid} windowId=${snapshot.windowId}`,
    "Action tools take this snapshotRevision, pid and windowId with one ref from the list below."
      + " Take a new snapshot after every action.",
  ];
  const truncated = snapshot.outputTruncated;
  if (truncated && truncated.returnedElementCount < truncated.originalElementCount) {
    lines.push(`Only the first ${truncated.returnedElementCount} of ${truncated.originalElementCount} elements are listed.`);
  }
  lines.push(`Elements (ref role "label" value${includeFrames ? " x,y,width,height" : ""}):`);
  for (const element of snapshot.elements) {
    const frame = element?.frame && typeof element.frame === "object" ? element.frame : {};
    const box = [frame.x, frame.y, frame.w ?? frame.width, frame.h ?? frame.height];
    const value = typeof element?.value === "string" ? element.value : "";
    lines.push([
      element?.ref,
      element?.role || "unknown",
      JSON.stringify(typeof element?.label === "string" ? element.label : ""),
      ...(value ? [`value=${JSON.stringify(value.length > 200 ? `${value.slice(0, 200)}…` : value)}`] : []),
      ...(element?.secure === true ? ["secure"] : []),
      ...(includeFrames && box.every(Number.isFinite) ? [box.join(",")] : []),
    ].join(" "));
  }
  return lines.join("\n");
}

function computerSnapshotResponse(id, result, thumbnail, mimeType) {
  if (!Array.isArray(result?.elements) || typeof result.tree !== "string") {
    throw helperError("MCP_HELPER_RESPONSE_INVALID", "mcp_helper_response_invalid");
  }
  const structuredContent = structuredClone(result);
  delete structuredContent.image.thumbnail;
  const originalElementCount = structuredContent.elements.length;
  let includeImage = true;
  let includeFrames = true;
  const build = () => jsonRpcResult(id, {
    content: [
      ...(includeImage ? [{ type: "image", data: thumbnail, mimeType }] : []),
      { type: "text", text: computerSnapshotText(structuredContent, includeImage, includeFrames) },
    ],
    structuredContent,
    isError: false,
  });
  const fits = (response) => Buffer.byteLength(JSON.stringify(response), "utf8") <= MCP_MAX_FRAME_BYTES;
  let response = build();
  if (fits(response)) return response;

  structuredContent.tree = "";
  structuredContent.degraded = true;
  structuredContent.outputTruncated = {
    tree: true,
    inlineImage: false,
    originalElementCount,
    returnedElementCount: originalElementCount,
  };
  response = build();
  if (fits(response)) return response;

  // Frames are also in structuredContent; drop them from the text before the image.
  includeFrames = false;
  response = build();
  if (fits(response)) return response;

  includeImage = false;
  structuredContent.outputTruncated.inlineImage = true;
  response = build();
  if (fits(response)) return response;

  let low = 0;
  let high = originalElementCount;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    structuredContent.elements = result.elements.slice(0, middle);
    structuredContent.outputTruncated.returnedElementCount = middle;
    if (fits(build())) low = middle;
    else high = middle - 1;
  }
  structuredContent.elements = result.elements.slice(0, low);
  structuredContent.outputTruncated.returnedElementCount = low;
  response = build();
  if (!fits(response)) {
    throw helperError("MCP_HELPER_RESPONSE_TOO_LARGE", "mcp_helper_response_too_large");
  }
  return response;
}

function validatePublicProfile(value, binding) {
  if (!exactObject(value, PUBLIC_PROFILE_FIELDS)
    || value.runtimeProfileId !== binding.runtimeProfileId
    || value.runtimeAccountId !== binding.runtimeAccountId
    || typeof value.id !== "string" || typeof value.agentId !== "string"
    || typeof value.name !== "string" || value.name.length === 0
    || (value.defaultModel !== null && typeof value.defaultModel !== "string")
    || (value.defaultCwd !== null && typeof value.defaultCwd !== "string")
    || typeof value.isDefault !== "boolean" || value.enabled !== true
    || !value.permissionPolicy || typeof value.permissionPolicy !== "object"
    || !value.concurrency || typeof value.concurrency !== "object") {
    throw helperError("MCP_HELPER_RESPONSE_INVALID", "mcp_helper_response_invalid");
  }
  return Object.fromEntries(PUBLIC_PROFILE_FIELDS.map((field) => [field, structuredClone(value[field])]));
}

function createMcpStdioHandler(options = {}) {
  const runtimeProfileId = options.runtimeProfileId;
  const runtimeAccountId = options.runtimeAccountId;
  if (!validRuntimeProfileId(runtimeProfileId) || !validRuntimeAccountId(runtimeAccountId)
    || !isCanonicalBase64Url(options.sessionToken, 32)
    || typeof options.requestService !== "function"
    || (options.sessionExpiresAt !== undefined
      && (!Number.isSafeInteger(options.sessionExpiresAt) || options.sessionExpiresAt < 0))
    || (options.refreshSession !== undefined && typeof options.refreshSession !== "function")
    || (options.interactionClient !== undefined && typeof options.interactionClient !== "function")
    || (options.now !== undefined && typeof options.now !== "function")
    || (options.randomUUID !== undefined && typeof options.randomUUID !== "function")
    || (options.setInterval !== undefined && typeof options.setInterval !== "function")
    || (options.clearInterval !== undefined && typeof options.clearInterval !== "function")) {
    throw helperError("MCP_HELPER_OPTIONS_INVALID", "mcp_helper_options_invalid");
  }
  const requestService = options.requestService;
  const toolDefinitions = options.toolDefinitions || MCP_PRODUCT_TOOL_DEFINITIONS;
  const instructions = options.instructions || SHOGGOTH_PRODUCT_DEVELOPER_INSTRUCTIONS;
  const knownTools = new Set(MCP_PRODUCT_TOOL_DEFINITIONS.map((definition) => definition.name));
  if (!Array.isArray(toolDefinitions) || toolDefinitions.length === 0
    || new Set(toolDefinitions.map((definition) => definition?.name)).size !== toolDefinitions.length
    || toolDefinitions.some((definition) => !knownTools.has(definition?.name))
    || typeof instructions !== "string" || !instructions) {
    throw helperError("MCP_HELPER_OPTIONS_INVALID", "mcp_helper_options_invalid");
  }
  const toolExposure = options.toolExposure ?? "all";
  if (!["all", "resident"].includes(toolExposure)) {
    throw helperError("MCP_HELPER_OPTIONS_INVALID", "mcp_helper_options_invalid");
  }
  // Every defined tool stays callable; "resident" only shortens tools/list.
  const allowedTools = new Set(toolDefinitions.map((definition) => definition.name));
  const toolPages = toolListPages([...(toolExposure === "resident"
    ? productToolExposure.residentToolDefinitions(toolDefinitions) : toolDefinitions),
  productToolResults.PRODUCT_RESULT_READ_DEFINITION].map(withActivityTitle));
  // Full text of large results returned as previews; see product-tool-results.js.
  const resultCache = new productToolResults.ProductResultCache();
  const paths = options.paths || resolveCanonicalServicePaths();
  const serviceVersion = typeof options.serviceVersion === "string" ? options.serviceVersion : "0.0.0";
  const refreshSession = options.refreshSession || null;
  const now = options.now || Date.now;
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const bindRuntimeCalls = options.bindRuntimeCalls === true;
  const sessionRefreshSkewMs = options.sessionRefreshSkewMs ?? MCP_SESSION_REFRESH_SKEW_MS;
  const refreshTimeoutMs = options.refreshTimeoutMs ?? MCP_SESSION_REFRESH_TIMEOUT_MS;
  if (!Number.isSafeInteger(sessionRefreshSkewMs) || sessionRefreshSkewMs < 0
    || sessionRefreshSkewMs > 60_000
    || !Number.isSafeInteger(refreshTimeoutMs) || refreshTimeoutMs < 1
    || refreshTimeoutMs > 30_000) {
    throw helperError("MCP_HELPER_OPTIONS_INVALID", "mcp_helper_options_invalid");
  }
  let sessionToken = options.sessionToken;
  let sessionExpiresAt = options.sessionExpiresAt ?? Number.MAX_SAFE_INTEGER;
  let initialized = false;
  let closed = false;
  let groupExposureTimer = null;
  let refreshPromise = null;
  let generation = 0;
  let supportsElicitation = false;
  const exposureInstanceId = randomUUID();
  const exposedGroupTools = new Set();
  const reportGroupExposure = async (tools = [...exposedGroupTools]) => {
    if (options.reportGroupExposure !== true || !sessionToken || !tools.length && !closed) return;
    try {
      await requestService(paths, { version: MCP_SERVICE_PROTOCOL_VERSION, method: "mcp.group.exposure", params: {
        runtimeProfileId, runtimeAccountId, sessionToken, instanceId: exposureInstanceId,
        protocolVersion: 2, tools,
      } }, { timeoutMs: 1000 });
    } catch { /* Capability observation cannot break the existing MCP session. */ }
  };
  // A Service-hosted session asks its user through the Service itself, so a product
  // confirmation never depends on whether (or how) a Runtime forwards MCP elicitation.
  const interactionClient = options.interactionClient || null;
  const canAskUser = context => interactionClient !== null
    || (supportsElicitation && typeof context.requestClient === "function");
  const askUser = (context, method, params) => (interactionClient || context.requestClient)(method, params);

  const refresh = async () => {
    if (!refreshSession || closed) {
      throw helperError("MCP_HELPER_AUTH_FAILED", "mcp_helper_auth_failed");
    }
    if (!refreshPromise) {
      const refreshGeneration = generation;
      const pending = withTimeout(
        Promise.resolve().then(() => refreshSession()),
        refreshTimeoutMs,
        () => helperError("MCP_HELPER_SERVICE_UNAVAILABLE", "mcp_helper_service_unavailable"),
      ).then(async (nextSession) => {
        if (closed || generation !== refreshGeneration
          || !validateSession(nextSession, { runtimeProfileId, runtimeAccountId })) {
          throw helperError("MCP_HELPER_AUTH_FAILED", "mcp_helper_auth_failed");
        }
        sessionToken = nextSession.token;
        sessionExpiresAt = nextSession.expiresAt;
        await reportGroupExposure();
      }).catch(error => {
        throw authenticationError(error);
      });
      const tracked = pending.finally(() => {
        if (refreshPromise === tracked) refreshPromise = null;
      });
      refreshPromise = tracked;
    }
    await refreshPromise;
  };

  const refreshIfExpiring = async () => {
    if (!refreshSession || sessionExpiresAt - now() > sessionRefreshSkewMs) return false;
    await refresh();
    return true;
  };

  const requestTool = (name, args, callId, confirmed = false) => requestService(paths, {
    version: MCP_SERVICE_PROTOCOL_VERSION,
    method: "mcp.tool.call",
    params: {
      runtimeProfileId,
      runtimeAccountId,
      sessionToken,
      callId,
      name,
      arguments: args,
      ...(confirmed ? { confirmation: true } : {}),
    },
  // Plugin calls can first await per-use approval, then execute with their own
  // bounded tool/input window. The envelope must cover both sequential phases.
  }, { timeoutMs: name === "workspace_execute" ? DEFAULT_MCP_TOOL_TIMEOUT_MS
    : name === "mcp_server_call" ? 2 * DEFAULT_SERVER_REQUEST_TIMEOUT_MS + MCP_TOOL_SERVICE_TIMEOUT_MS
    : name === "external_agent_run" ? DEFAULT_SERVER_REQUEST_TIMEOUT_MS + MCP_TOOL_SERVICE_TIMEOUT_MS : USER_WAIT_TOOL_NAMES.has(name)
    ? DEFAULT_SERVER_REQUEST_TIMEOUT_MS + MCP_TOOL_SERVICE_TIMEOUT_MS : MCP_TOOL_SERVICE_TIMEOUT_MS });

  const invokeTool = async (name, args, confirmed = false, context = {}) => {
    let callId;
    try { callId = randomUUID(); } catch {
      throw helperError("MCP_HELPER_CALL_ID_FAILED", "mcp_helper_call_id_failed");
    }
    if (!UUID_PATTERN.test(callId)) throw helperError("MCP_HELPER_CALL_ID_FAILED", "mcp_helper_call_id_failed");
    const refreshed = await refreshIfExpiring();
    const bind = async () => { if (bindRuntimeCalls) {
      if (!supportsElicitation || typeof context.requestClient !== "function") {
        throw helperError("MCP_SESSION_INVALID", "mcp_session_invalid");
      }
      const response = await context.requestClient("elicitation/create",
        require("./agent-service/runtime-mcp-call-binding").bindingElicitation({
          callId, name, arguments: args, confirmation: confirmed, sessionToken,
        }));
      if (response?.action !== "accept" || !exactObject(response.content, [])) {
        throw helperError("MCP_SESSION_INVALID", "mcp_session_invalid");
      }
    } };
    await bind();
    try { return await requestTool(name, args, callId, confirmed); }
    catch (error) {
      if (dataErrorCode(error) !== "MCP_SESSION_INVALID" || refreshed || !refreshSession) throw error;
      await refresh();
      await bind();
      return requestTool(name, args, callId, confirmed);
    }
  };

  const handler = async (message, context = {}) => {
    if (!message || typeof message !== "object" || Array.isArray(message)
      || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return jsonRpcError(message?.id, -32600, "Invalid Request");
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    if (hasId && !validJsonRpcId(message.id)) return jsonRpcError(null, -32600, "Invalid Request");

    if (message.method === "initialize") {
      if (!hasId || initialized || !validateInitializeParams(message.params)) {
        return jsonRpcError(message.id, -32602, "Invalid params");
      }
      initialized = true;
      supportsElicitation = Object.prototype.hasOwnProperty.call(
        message.params.capabilities, "elicitation",
      );
      return jsonRpcResult(message.id, {
        protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "shoggoth", version: serviceVersion },
        instructions,
      });
    }
    if (message.method === "notifications/initialized" && !hasId) return null;
    if (!initialized) return hasId ? jsonRpcError(message.id, -32002, "Server not initialized") : null;
    if (message.method === "ping" && hasId) return jsonRpcResult(message.id, {});
    if (message.method === "tools/list" && hasId) {
      const params = message.params === undefined ? {} : message.params;
      const fields = ["cursor", "_meta"].filter(field => Object.hasOwn(params || {}, field));
      if (!exactObject(params, fields)
        || (Object.hasOwn(params, "_meta") && !boundedJsonObject(params._meta, 4 * 1024))
        || (Object.hasOwn(params, "cursor") && (typeof params.cursor !== "string" || !params.cursor))) {
        return jsonRpcError(message.id, -32602, "Invalid params");
      }
      const page = toolPages.get(params.cursor ?? "");
      if (page && options.reportGroupExposure === true) {
        for (const tool of page.tools) if (require("./agent-service/group-mcp-tools").isGroupMcpTool(tool.name)) exposedGroupTools.add(tool.name);
        await reportGroupExposure();
        if (refreshSession && groupExposureTimer === null && exposedGroupTools.size) {
          groupExposureTimer = (options.setInterval || setInterval)(() => {
            void handler.maintainGroupExposure().catch(() => {});
          }, 60_000);
          groupExposureTimer.unref?.();
        }
      }
      return page ? jsonRpcResult(message.id, structuredClone(page))
        : jsonRpcError(message.id, -32602, "Invalid params");
    }
    // Strip only bounded display metadata before dispatch, validation, confirmation
    // and Hook handling. Runtime events retain the original per-call arguments.
    if (message.method === "tools/call" && hasId && Object.hasOwn(message.params || {}, "arguments")) {
      const activity = splitActivityArguments(message.params.arguments);
      if (!activity.valid) return jsonRpcError(message.id, -32602, "Invalid activityTitle");
      if (activity.arguments !== message.params.arguments) message = { ...message, params: { ...message.params, arguments: activity.arguments } };
    }
    if (message.method === "tools/call" && hasId && message.params?.name === productToolResults.PRODUCT_RESULT_READ) {
      const params = message.params;
      if (!(exactObject(params, ["name", "arguments"]) || exactObject(params, ["name", "arguments", "_meta"]))
        || (Object.hasOwn(params, "_meta") && !boundedJsonObject(params._meta, 4 * 1024))) {
        return jsonRpcError(message.id, -32602, "Invalid params");
      }
      const page = productToolResults.validReadArguments(params.arguments)
        ? resultCache.read(params.arguments.resultRef, params.arguments.offset, params.arguments.length) : null;
      if (!page) {
        return jsonRpcResult(message.id, { content: [{ type: "text", text: "product_result_read needs a current resultRef and offset; the result may have expired, so call the original tool again." }],
          structuredContent: { error: { code: "MCP_TOOL_INVALID_ARGUMENTS" } }, isError: true });
      }
      return jsonRpcResult(message.id, { content: [{ type: "text", text: JSON.stringify(page) }], structuredContent: page, isError: false });
    }
    if (message.method === "tools/call" && hasId && toolExposure === "resident"
      && productToolExposure.ENTRY_TOOL_NAMES.has(message.params?.name)) {
      const params = message.params;
      if (!(exactObject(params, ["name", "arguments"]) || exactObject(params, ["name", "arguments", "_meta"]))
        || (Object.hasOwn(params, "_meta") && !boundedJsonObject(params._meta, 4 * 1024))) {
        return jsonRpcError(message.id, -32602, "Invalid params");
      }
      const entryError = text => jsonRpcResult(message.id, { content: [{ type: "text", text }],
        structuredContent: { error: { code: "MCP_TOOL_INVALID_ARGUMENTS" } }, isError: true });
      if (params.name === productToolExposure.PRODUCT_TOOL_SEARCH) {
        if (!productToolExposure.validSearchArguments(params.arguments)) {
          return entryError("product_tool_search needs { query: string (≤200), limit?: 1-10 }.");
        }
        const found = productToolExposure.searchProductTools(toolDefinitions, params.arguments);
        return jsonRpcResult(message.id, { content: [{ type: "text", text: JSON.stringify(found) }],
          structuredContent: found, isError: false });
      }
      if (!productToolExposure.validCallArguments(params.arguments) || !allowedTools.has(params.arguments.name)) {
        return entryError("product_tool_call needs { name, arguments } with the exact name of a Shoggoth product tool from product_tool_search.");
      }
      // Route as an ordinary call so confirmations and permissions are the named tool's own.
      return handler({ ...message, params: { name: params.arguments.name, arguments: params.arguments.arguments,
        ...(Object.hasOwn(params, "_meta") ? { _meta: params._meta } : {}) } }, context);
    }
    if (message.method === "tools/call" && hasId) {
      const hasArguments = exactObject(message.params, ["name", "arguments"])
        || exactObject(message.params, ["name", "arguments", "_meta"]);
      const omittedArguments = exactObject(message.params, ["name"])
        || exactObject(message.params, ["name", "_meta"]);
      const hasMeta = message.params && Object.prototype.hasOwnProperty.call(message.params, "_meta");
      if ((!hasArguments && !omittedArguments)
        || (hasMeta && !boundedJsonObject(message.params._meta, 4 * 1024))
        || !allowedTools.has(message.params?.name)) {
        return jsonRpcError(message.id, -32602, "Invalid params");
      }
      // MCP 的 CallToolRequest 允许省略 arguments，并继承可选的请求 _meta。
      // _meta 只做有界协议校验且绝不下传；需要参数的工具仍由 strict schema 拒绝。
      const toolArguments = hasArguments ? message.params.arguments : {};
      if (message.params.name === "request_user_input") {
        const questions = validateRequestUserInputArguments(toolArguments);
        if (!questions || !canAskUser(context)) {
          return jsonRpcError(message.id, -32602, "Invalid params");
        }
        try {
          const elicitation = await askUser(
            context, "elicitation/create", elicitationParamsFor(questions),
          );
          const result = normalizeElicitationResult(elicitation, questions);
          return jsonRpcResult(message.id, {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
            isError: false,
          });
        } catch {
          return jsonRpcResult(message.id, {
            content: [{ type: "text", text: "Shoggoth user input request failed" }],
            isError: true,
          });
        }
      }
      if (!validateMcpProductToolArguments(message.params.name, toolArguments)) {
        return invalidToolArgumentsResponse(message.id, message.params.name, toolArguments);
      }
      let nativeAgent = null;
      let hookGrant = null;
      let plugin = null;
      let group = null;
      let management = null;
      try {
        // The confirmation text is built from the Service's own current view of
        // the draft or installation, never from model-supplied descriptions.
        if (message.params.name === "group_chat_dispatch") {
          group = cloneMcpServiceResult(await invokeTool("group_chat_get", { groupId: toolArguments.groupId }, false, context));
        }
        if (["group_chat_create", "group_chat_members_add"].includes(message.params.name)) {
          management = cloneMcpServiceResult(await invokeTool("group_chat_prepare",
            groupManagementRequest(message.params.name, toolArguments), false, context));
          if (management?.ok !== true) return jsonRpcResult(message.id, { content: [{ type: "text",
            text: management?.message || "群或成员当前不可用，请重新读取。" }], structuredContent: management, isError: true });
          if (management.ownerScope !== toolArguments.ownerScope) throw helperError("MCP_TOOL_STATE_CONFLICT", "group_management_preflight_failed");
          if (management.state === "completed") {
            if (management.receipt?.previewDigest !== toolArguments.previewDigest) throw helperError("MCP_TOOL_STATE_CONFLICT", "group_management_preflight_failed");
            return jsonRpcResult(message.id, { content: [{ type: "text", text: JSON.stringify(management.receipt) }],
              structuredContent: management.receipt, isError: false });
          }
        }
        if (message.params.name === "plugin_install") {
          plugin = cloneMcpServiceResult(await invokeTool("plugin_status", {
            draftId: toolArguments.draftId }, false, context));
          if (plugin?.draftId !== toolArguments.draftId || plugin.installable !== true
            || plugin.previewDigest !== toolArguments.previewDigest
            || !Array.isArray(plugin.previewComponents?.skills)
            || !Array.isArray(plugin.previewComponents?.mcpServers)) {
            throw helperError("MCP_TOOL_STATE_CONFLICT", "plugin_install_preflight_failed");
          }
        }
        if (message.params.name === "plugin_activate") {
          plugin = cloneMcpServiceResult(await invokeTool("plugin_setup_get", {
            installationId: toolArguments.installationId }, false, context));
          if (plugin?.installationId !== toolArguments.installationId
            || plugin.releaseDigest !== toolArguments.releaseDigest || !Array.isArray(plugin.components)) {
            throw helperError("MCP_TOOL_STATE_CONFLICT", "plugin_activate_preflight_failed");
          }
        }
        if (message.params.name === "hook_grant") {
          hookGrant = cloneMcpServiceResult(await invokeTool("hook_get", {
            hookId: toolArguments.hookId, version: toolArguments.version,
          }, false, context));
          if (!hookGrant?.definition || typeof hookGrant.contentDigest !== "string"
            || !/^[a-f0-9]{64}$/u.test(hookGrant.contentDigest)) throw helperError("MCP_TOOL_RESPONSE_INVALID", "hook_grant_preflight_failed");
        }
        if (message.params.name === "browser_session_open") {
          const state = cloneMcpServiceResult(await invokeTool("browser_status", {}, false, context));
          if (state?.available !== true) {
            const reason = Object.hasOwn(MCP_PRODUCT_PUBLIC_MESSAGES, state?.reason || "")
              ? state.reason : "BROWSER_SERVICE_UNAVAILABLE";
            throw helperError(reason, "browser_preflight_failed");
          }
        }
        if (["computer_session_open", "computer_session_resume"].includes(message.params.name)) {
          const state = cloneMcpServiceResult(await invokeTool("computer_status", {}, false, context));
          if (state?.available !== true) {
            const reason = Object.hasOwn(MCP_PRODUCT_PUBLIC_MESSAGES, state?.reason || "")
              ? state.reason : "COMPUTER_DRIVER_UNAVAILABLE";
            throw helperError(reason, "computer_preflight_failed");
          }
          if (typeof state.permissions?.accessibility !== "boolean"
            || typeof state.permissions?.screenRecording !== "boolean") {
            throw helperError("COMPUTER_PERMISSION_STATUS_FAILED", "computer_preflight_failed");
          }
          if (!state.permissions.accessibility || !state.permissions.screenRecording) {
            throw helperError("COMPUTER_PERMISSION_REQUIRED", "computer_preflight_failed");
          }
        }
        if (["native_agent_update", "native_agent_archive"].includes(message.params.name)) {
          const result = cloneMcpServiceResult(await invokeTool("native_agent_get", {
            backendId: toolArguments.backendId, agentId: toolArguments.agentId,
          }, false, context));
          nativeAgent = result?.agent;
          if (!nativeAgent || nativeAgent.backendId !== toolArguments.backendId
            || nativeAgent.agentId !== toolArguments.agentId || typeof nativeAgent.name !== "string") {
            throw helperError("MCP_TOOL_RESPONSE_INVALID", "native_agent_preflight_failed");
          }
          if (nativeAgent.updatedAt !== toolArguments.expectedUpdatedAt) {
            throw helperError("AGENT_PROFILE_CONFLICT", "native_agent_preflight_failed");
          }
          if (nativeAgent.state !== "active") throw helperError("AGENT_OPERATION_BUSY", "native_agent_preflight_failed");
          if (message.params.name === "native_agent_archive" && nativeAgent.isDefault) {
            throw helperError("AGENT_PROTECTED", "native_agent_preflight_failed");
          }
        }
      } catch (error) { return toolFailureResponse(message.id, error); }
      let confirmation;
      try { confirmation = confirmationQuestionFor(message.params.name, toolArguments, nativeAgent, hookGrant, plugin, group, management); }
      catch (error) { return toolFailureResponse(message.id, error); }
      let confirmed = false;
      if (confirmation) {
        if (!canAskUser(context)) {
          return jsonRpcResult(message.id, {
            content: [{ type: "text", text: "该操作需要用户确认，但当前客户端不支持确认。" }],
            isError: true,
          });
        }
        try {
          const params = elicitationParamsFor(confirmation);
          params._meta = { [PRODUCT_CONFIRMATION_META]: productConfirmationIdentity(message.params.name, toolArguments) };
          const elicitation = await askUser(context, "elicitation/create", params);
          const normalized = normalizeElicitationResult(elicitation, confirmation);
          if (normalized.answers.confirm_product_action?.answers?.[0] !== "确认执行") {
            return jsonRpcResult(message.id, {
              content: [{ type: "text", text: "操作未获确认，未执行。" }],
              structuredContent: { canceled: true },
              isError: false,
            });
          }
          confirmed = true;
        } catch {
          return jsonRpcResult(message.id, {
            content: [{ type: "text", text: "用户确认失败，未执行操作。" }],
            isError: true,
          });
        }
      }
      try {
        const rawResult = await invokeTool(message.params.name, toolArguments, confirmed, context);
        const result = cloneMcpServiceResult(rawResult);
        if (message.params.name === "computer_snapshot" && result?.image?.thumbnail) {
          const thumbnail = result.image.thumbnail;
          const mimeType = result.image.thumbnailMimeType;
          const data = Buffer.from(thumbnail, "base64");
          if (mimeType !== "image/jpeg" || data.length === 0 || data.length > 36 * 1024
            || data.toString("base64") !== thumbnail) {
            throw helperError("MCP_HELPER_RESPONSE_INVALID", "mcp_helper_response_invalid");
          }
          return computerSnapshotResponse(message.id, result, thumbnail, mimeType);
        }
        const paged = productToolResults.pagedResult(resultCache, message.params.name, result);
        return toolSuccessResponse(message.id, paged ?? result, message.params.name);
      } catch (error) {
        return toolFailureResponse(message.id, error);
      }
    }
    return hasId ? jsonRpcError(message.id, -32601, "Method not found") : null;
  };
  handler.maintainGroupExposure = async () => {
    // A configured but unused helper must never initiate periodic authentication.
    // Renew only an inventory this current Runtime actually consumed; no tool
    // action, group grant or model turn is issued by this heartbeat.
    if (closed || !initialized || options.reportGroupExposure !== true || !exposedGroupTools.size || !refreshSession) return false;
    if (sessionExpiresAt - now() <= Math.max(sessionRefreshSkewMs, 60_000)) await refresh();
    else await reportGroupExposure();
    return !closed;
  };
  handler.close = () => {
    if (groupExposureTimer !== null) {
      (options.clearInterval || clearInterval)(groupExposureTimer); groupExposureTimer = null;
    }
    initialized = false;
    supportsElicitation = false;
    closed = true;
    void reportGroupExposure([]);
    generation += 1;
    sessionToken = null;
    sessionExpiresAt = 0;
  };
  return handler;
}

async function writeJsonLine(output, payload, maxFrameBytes, outputTimeoutMs) {
  let serialized = `${JSON.stringify(payload)}\n`;
  let frame = Buffer.from(serialized, "utf8");
  serialized = null;
  if (frame.length > maxFrameBytes) {
    frame.fill(0);
    serialized = `${JSON.stringify(jsonRpcError(payload?.id, -32603, "Internal error"))}\n`;
    frame = Buffer.from(serialized, "utf8");
    serialized = null;
  }
  payload = null;
  await new Promise((resolve, reject) => {
    let timer = null;
    let settled = false;
    let writeCompleted = false;
    let drainCompleted = false;
    const releaseFrame = () => {
      if (frame) frame.fill(0);
      frame = null;
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      output.off("drain", onDrain);
      output.off("error", onError);
      output.off("close", onClose);
    };
    const settle = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const maybeResolve = () => {
      if (writeCompleted && drainCompleted) settle();
    };
    const onDrain = () => { drainCompleted = true; maybeResolve(); };
    const onError = () => settle(helperError("MCP_HELPER_OUTPUT_FAILED", "mcp_helper_output_failed"));
    const onClose = () => settle(helperError("MCP_HELPER_OUTPUT_CLOSED", "mcp_helper_output_closed"));
    const onTimeout = () => settle(helperError("MCP_HELPER_OUTPUT_TIMEOUT", "mcp_helper_output_timeout"));
    const onWrite = (error) => {
      // A timeout/error does not release a pending write's buffer. Wiping it
      // before this callback can put literal NUL bytes onto the MCP wire.
      // Keep this callback alive even after the session has failed/closed.
      releaseFrame();
      if (error) { onError(); return; }
      writeCompleted = true;
      maybeResolve();
    };
    output.once("drain", onDrain);
    output.once("error", onError);
    output.once("close", onClose);
    timer = setTimeout(onTimeout, outputTimeoutMs);
    try {
      const accepted = output.write(frame, onWrite);
      drainCompleted ||= accepted === true;
      if (output.destroyed || output.closed || output.writableEnded) onClose();
      else maybeResolve();
    } catch {
      releaseFrame();
      onError();
    }
  });
}

async function runMcpStdioSession(options = {}) {
  const input = options.input;
  const output = options.output;
  const handler = options.handler;
  const maxFrameBytes = options.maxFrameBytes ?? MCP_MAX_FRAME_BYTES;
  const outputTimeoutMs = options.outputTimeoutMs ?? MCP_OUTPUT_TIMEOUT_MS;
  const clientRequestTimeoutMs = options.clientRequestTimeoutMs
    ?? MCP_CLIENT_REQUEST_TIMEOUT_MS;
  if (!input || typeof input[Symbol.asyncIterator] !== "function"
    || !output || typeof output.write !== "function"
    || typeof output.on !== "function" || typeof output.once !== "function"
    || typeof output.off !== "function"
    || typeof handler !== "function"
    || !Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1024
    || maxFrameBytes > 1024 * 1024
    || !Number.isSafeInteger(outputTimeoutMs) || outputTimeoutMs < 1
    || outputTimeoutMs > 30_000
    || !Number.isSafeInteger(clientRequestTimeoutMs) || clientRequestTimeoutMs < 10
    || clientRequestTimeoutMs > DEFAULT_SERVER_REQUEST_TIMEOUT_MS) {
    throw helperError("MCP_HELPER_OPTIONS_INVALID", "mcp_helper_options_invalid");
  }
  let buffered = Buffer.alloc(0);
  let requestSequence = 0;
  let outputTail = Promise.resolve();
  let sessionError = null;
  let signalFailure;
  const failed = new Promise(resolve => { signalFailure = resolve; });
  const pendingClientRequests = new Map();
  const handlerTasks = new Set();
  const emit = (payload, frameLimit = maxFrameBytes) => {
    const current = outputTail.then(() => {
      if (sessionError) throw sessionError;
      return writeJsonLine(output, payload, frameLimit, outputTimeoutMs);
    });
    // Output failure is fatal to this connection. Do not send later responses
    // after a truncated frame or leave the input loop waiting for another request.
    current.catch(failSession);
    outputTail = current;
    return current;
  };
  const rejectPendingClientRequests = () => {
    for (const pending of pendingClientRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(helperError("MCP_HELPER_CLIENT_REQUEST_FAILED", "mcp_helper_client_request_failed"));
    }
    pendingClientRequests.clear();
  };
  const failSession = (error) => {
    if (sessionError) return;
    sessionError = error;
    signalFailure();
    rejectPendingClientRequests();
    handler.close?.();
    output.destroy?.();
    if (input !== output) input.destroy?.();
  };
  const onOutputError = () => failSession(helperError("MCP_HELPER_OUTPUT_FAILED", "mcp_helper_output_failed"));
  const cleanupOutput = () => {
    output.off("error", onOutputError);
    output.off("close", onOutputClose);
  };
  const onOutputClose = () => {
    failSession(helperError("MCP_HELPER_OUTPUT_CLOSED", "mcp_helper_output_closed"));
    cleanupOutput();
  };
  output.on("error", onOutputError);
  output.once("close", onOutputClose);
  const requestClient = async (method, params) => {
    if (sessionError || method !== "elicitation/create" || !boundedJsonObject(params, 16 * 1024)
      // Binding proofs must accommodate a parallel roster read batch while
      // retaining a bounded number of client requests.
      || pendingClientRequests.size >= 128) {
      throw helperError("MCP_HELPER_CLIENT_REQUEST_FAILED", "mcp_helper_client_request_failed");
    }
    requestSequence += 1;
    const id = `shoggoth-elicitation-${requestSequence}`;
    // Match the Service card's approval lifetime. Binding proofs and ordinary
    // input retain a finite transport deadline; EOF/error still rejects every
    // pending request. A short helper timer must not leave a live, unusable card.
    const approvalWait = Object.hasOwn(params.requestedSchema?.properties ?? {}, "confirm_product_action")
      && serverRequestUsesApprovalWait("mcpServer/elicitation/request", { ...params, serverName: "shoggoth", mode: "form" });
    let timer;
    const response = new Promise((resolve, reject) => {
      if (!approvalWait) timer = setTimeout(() => {
        pendingClientRequests.delete(id);
        reject(helperError("MCP_HELPER_CLIENT_REQUEST_FAILED", "mcp_helper_client_request_failed"));
      }, clientRequestTimeoutMs);
      pendingClientRequests.set(id, { resolve, reject, timer });
    });
    // A transport failure may reject the response while emit is still pending.
    response.catch(() => {});
    try {
      await emit({ jsonrpc: "2.0", id, method, params });
    } catch {
      const pending = pendingClientRequests.get(id);
      if (pending) {
        pendingClientRequests.delete(id);
        clearTimeout(pending.timer);
        pending.reject(helperError("MCP_HELPER_CLIENT_REQUEST_FAILED", "mcp_helper_client_request_failed"));
      }
    }
    return response;
  };
  const consumeClientResponse = (message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)
      || message.jsonrpc !== "2.0" || !validJsonRpcId(message.id)) return false;
    const pending = pendingClientRequests.get(message.id);
    if (!pending) return false;
    pendingClientRequests.delete(message.id);
    clearTimeout(pending.timer);
    const isResult = exactObject(message, ["jsonrpc", "id", "result"]);
    const isError = exactObject(message, ["jsonrpc", "id", "error"]);
    if (isResult && boundedJsonObject(message.result, 16 * 1024)) {
      pending.resolve(message.result);
    } else {
      // Client errors and malformed responses are intentionally indistinguishable to the tool.
      pending.reject(helperError("MCP_HELPER_CLIENT_REQUEST_FAILED", "mcp_helper_client_request_failed"));
    }
    return true;
  };
  const dispatch = (message) => {
    let task;
    task = Promise.resolve().then(async () => {
      if (sessionError) return;
      let response;
      try {
        response = await handler(message, { requestClient });
      } catch {
        response = jsonRpcError(message?.id, -32603, "Internal error");
      }
      if (response) await emit(response, message.method === "tools/list"
        ? Math.max(maxFrameBytes, MCP_MAX_CATALOG_FRAME_BYTES) : maxFrameBytes);
    }).catch(failSession).finally(() => handlerTasks.delete(task));
    handlerTasks.add(task);
  };
  const readInput = async () => {
    for await (const chunk of input) {
      if (sessionError) {
        if (Buffer.isBuffer(chunk)) chunk.fill(0);
        break;
      }
      const previous = buffered;
      let incoming = null;
      let next = null;
      try {
        incoming = Buffer.from(chunk);
        next = Buffer.concat([previous, incoming]);
        buffered = next;
        next = null;
      } finally {
        previous.fill(0);
        if (incoming) incoming.fill(0);
        if (Buffer.isBuffer(chunk)) chunk.fill(0);
        if (next) next.fill(0);
      }
      while (!sessionError) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) {
          if (buffered.length > maxFrameBytes) {
            throw helperError("MCP_HELPER_FRAME_TOO_LARGE", "mcp_helper_frame_too_large");
          }
          break;
        }
        const frame = Buffer.from(buffered.subarray(0, newline));
        const rest = Buffer.from(buffered.subarray(newline + 1));
        buffered.fill(0);
        buffered = rest;
        if (frame.length > maxFrameBytes) {
          frame.fill(0);
          throw helperError("MCP_HELPER_FRAME_TOO_LARGE", "mcp_helper_frame_too_large");
        }
        let message;
        let parseFailed = false;
        try {
          message = JSON.parse(frame.toString("utf8"));
        } catch {
          parseFailed = true;
        } finally {
          frame.fill(0);
        }
        if (parseFailed) {
          await emit(jsonRpcError(null, -32700, "Parse error"));
          continue;
        }
        if (!consumeClientResponse(message)) dispatch(message);
      }
    }
    if (!sessionError && buffered.length > 0) await emit(jsonRpcError(null, -32700, "Parse error"));
  };
  try {
    await Promise.race([readInput(), failed]);
    rejectPendingClientRequests();
    // Successful EOF drains in-flight handlers. A broken transport must not wait
    // for a tool or a user confirmation that can no longer deliver its result.
    await Promise.race([Promise.allSettled([...handlerTasks]), failed]);
    if (!sessionError) await outputTail;
  } catch (error) {
    failSession(error);
  } finally {
    buffered.fill(0);
    rejectPendingClientRequests();
    // Keep the error listener through asynchronous destroy/write callbacks.
    if (!sessionError || output.closed) cleanupOutput();
  }
  if (sessionError) throw sessionError;
}

async function startShoggothMcpHelper(options = {}) {
  const safeStorageWasInjected = Boolean(options.safeStorage);
  let electronApp = options.electronApp || null;
  let safeStorage = options.safeStorage || null;
  let handler = null;
  let mcpCryptoBroker = options.mcpCryptoBroker || null;
  try {
    const binding = options.runtimeProfileId !== undefined
      || options.runtimeAccountId !== undefined
      ? { runtimeProfileId: options.runtimeProfileId, runtimeAccountId: options.runtimeAccountId,
        toolExposure: options.toolExposure ?? "all" }
      : parseMcpRuntimeBinding(options.argv || process.argv.slice(1));
    if (!validRuntimeProfileId(binding.runtimeProfileId)
      || !validRuntimeAccountId(binding.runtimeAccountId)) {
      throw helperError("MCP_HELPER_ARGUMENTS_INVALID", "mcp_helper_arguments_invalid");
    }
    const { runtimeProfileId, runtimeAccountId } = binding;
    const federationClient = options.federationClient
      || process.env[FEDERATION_MCP_CLIENT_ENV] || null;
    if (federationClient !== null) {
      const paths = options.paths || resolveCanonicalServicePaths();
      const authFile = options.federationAuthFile
        || process.env[FEDERATION_MCP_AUTH_FILE_ENV];
      const loadSession = () => authenticateFederationMcpSession({
        paths,
        runtimeProfileId,
        runtimeAccountId,
        client: federationClient,
        authFile,
        requestService: options.requestService,
      });
      const session = await loadSession();
      const serviceVersion = options.serviceVersion || JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
      ).version;
      handler = createMcpStdioHandler({
        paths,
        runtimeProfileId,
        runtimeAccountId,
        sessionToken: session.token,
        sessionExpiresAt: session.expiresAt,
        serviceVersion,
        requestService: options.requestService || defaultRequestService,
        refreshSession: loadSession,
        toolDefinitions: EXTERNAL_FEDERATION_MCP_TOOL_DEFINITIONS,
        instructions: EXTERNAL_FEDERATION_MCP_INSTRUCTIONS,
        now: options.now,
        randomUUID: options.randomUUID,
        sessionRefreshSkewMs: options.sessionRefreshSkewMs,
        refreshTimeoutMs: options.refreshTimeoutMs,
      });
      await runMcpStdioSession({
        input: options.input || process.stdin,
        output: options.output || process.stdout,
        handler,
        maxFrameBytes: options.maxFrameBytes,
        outputTimeoutMs: options.outputTimeoutMs,
        clientRequestTimeoutMs: options.clientRequestTimeoutMs,
      });
      return;
    }
    const defaultPaths = options.paths || resolveCanonicalServicePaths();
    const canonicalPaths = options.runtimeMcpContext
      ? resolveCanonicalServicePaths()
      : defaultPaths;
    const paths = runtimeMcpPaths(
      defaultPaths,
      options.runtimeMcpContext,
      binding,
      canonicalPaths,
    );
    if (!electronApp) {
      const electron = require("electron");
      electronApp ||= electron.app;
    }
    prohibitBackgroundActivation(electronApp, options.platform);
    if (typeof electronApp.setPath === "function") {
      const helperProfileDir = path.join(paths.profileDir, "mcp-helper");
      const helperSessionDir = path.join(helperProfileDir, "session");
      const helperCacheDir = path.join(paths.cacheDir, "mcp-helper");
      const cryptoProfileDir = path.join(paths.profileDir, "mcp-crypto-worker");
      const cryptoSessionDir = path.join(cryptoProfileDir, "session");
      const cryptoCacheDir = path.join(paths.cacheDir, "mcp-crypto-worker");
      const { ensurePrivateDirectoryTree } = require("./agent-service/security");
      ensurePrivateDirectoryTree(helperProfileDir, defaultPaths.trustedRoot);
      ensurePrivateDirectoryTree(helperSessionDir, defaultPaths.trustedRoot);
      ensurePrivateDirectoryTree(helperCacheDir, defaultPaths.trustedRoot);
      ensurePrivateDirectoryTree(cryptoProfileDir, defaultPaths.trustedRoot);
      ensurePrivateDirectoryTree(cryptoSessionDir, defaultPaths.trustedRoot);
      ensurePrivateDirectoryTree(cryptoCacheDir, defaultPaths.trustedRoot);
      electronApp.setPath("userData", helperProfileDir);
      electronApp.setPath("sessionData", helperSessionDir);
      electronApp.setPath("cache", helperCacheDir);
    }
    await electronApp.whenReady();
    hideBackgroundDock(electronApp, options.platform);
    const usePackagedSelector = !options.paths
      && electronApp?.isPackaged === true
      && process.defaultApp !== true
      && process.env.NODE_ENV !== "test";
    if (!mcpCryptoBroker && !safeStorageWasInjected && !options.authenticateSession
      && typeof electronApp.getAppPath === "function") {
      const cryptoOptions = {
        paths,
        callerRole: "mcp",
        executablePath: process.execPath,
        appRoot: electronApp.getAppPath(),
        defaultApp: process.defaultApp === true,
        parentEnv: process.env,
        requestTimeoutMs: resolveMcpCryptoRequestTimeout({
          explicitTimeoutMs: options.mcpCryptoRequestTimeoutMs,
          isPackaged: electronApp.isPackaged,
          defaultApp: process.defaultApp === true,
        }),
        termGraceMs: options.mcpCryptoTermGraceMs,
        killConfirmMs: options.mcpCryptoKillConfirmMs,
      };
      mcpCryptoBroker = usePackagedSelector
        ? new PackagedMcpCryptoBroker({
          ...cryptoOptions,
          resourcesPath: options.resourcesPath || process.resourcesPath,
          applicationsRoot: options.applicationsRoot || "/Applications",
        })
        : new McpCryptoBroker(cryptoOptions);
    }
    if (mcpCryptoBroker) await mcpCryptoBroker.open({ generation: options.cryptoGeneration || 1 });
    const authenticateSession = options.authenticateSession || authenticateMcpSession;
    const authenticationOptions = {
      paths,
      runtimeProfileId,
      runtimeAccountId,
      safeStorage,
      requestService: options.requestService,
      randomBytes: options.randomBytes,
      mcpAuthFs: options.mcpAuthFs,
      mcpCryptoBroker,
      cryptoGeneration: options.cryptoGeneration || 1,
    };
    const loadSession = async () => {
      const nextSession = await authenticateSession(authenticationOptions);
      if (!validateSession(nextSession, binding)) {
        throw helperError("MCP_HELPER_AUTH_FAILED", "mcp_helper_auth_failed");
      }
      return nextSession;
    };
    const session = await loadSession();
    const serviceVersion = options.serviceVersion || JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
    ).version;
    handler = createMcpStdioHandler({
      reportGroupExposure: true,
      paths,
      runtimeProfileId,
      runtimeAccountId,
      sessionToken: session.token,
      sessionExpiresAt: session.expiresAt,
      serviceVersion,
      bindRuntimeCalls: true,
      toolDefinitions: options.toolDefinitions,
      toolExposure: binding.toolExposure,
      requestService: options.requestService || defaultRequestService,
      refreshSession: loadSession,
      now: options.now,
      randomUUID: options.randomUUID,
      sessionRefreshSkewMs: options.sessionRefreshSkewMs,
      refreshTimeoutMs: options.refreshTimeoutMs,
    });
    await runMcpStdioSession({
      input: options.input || process.stdin,
      output: options.output || process.stdout,
      handler,
      maxFrameBytes: options.maxFrameBytes,
      outputTimeoutMs: options.outputTimeoutMs,
      clientRequestTimeoutMs: options.clientRequestTimeoutMs,
    });
  } catch (error) {
    if (String(error?.code || "").startsWith("MCP_HELPER_")) throw error;
    throw helperError("MCP_HELPER_FAILED", "mcp_helper_failed");
  } finally {
    if (handler?.close) handler.close();
    if (mcpCryptoBroker) {
      try { await mcpCryptoBroker.close(); } catch { /* helper exits with fixed outer error */ }
    }
    if (electronApp && typeof electronApp.quit === "function") electronApp.quit();
  }
}

module.exports = {
  MCP_MAX_FRAME_BYTES,
  MCP_MAX_CATALOG_FRAME_BYTES,
  MCP_CLIENT_REQUEST_TIMEOUT_MS,
  MCP_RUNTIME_ACCOUNT_PREFIX,
  MCP_RUNTIME_PROFILE_PREFIX,
  MCP_SERVICE_PROTOCOL_VERSION,
  MCP_STDIO_PROTOCOL_VERSION,
  EXTERNAL_FEDERATION_MCP_INSTRUCTIONS,
  EXTERNAL_FEDERATION_MCP_TOOL_DEFINITIONS,
  FEDERATION_MCP_AUTH_FILE_ENV,
  FEDERATION_MCP_CLIENT_ENV,
  authenticateFederationMcpSession,
  authenticateMcpSession,
  createMcpStdioHandler,
  parseMcpRuntimeBinding,
  parseMcpRuntimeProfileId,
  resolveMcpCryptoRequestTimeout,
  runtimeMcpPaths,
  runMcpStdioSession,
  startShoggothMcpHelper,
};
