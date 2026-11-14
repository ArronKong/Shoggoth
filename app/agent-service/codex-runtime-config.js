"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  assertRuntimeProfileId,
  prepareCodexHome,
  prepareCodexRuntimeAccountHome,
  runtimeError,
} = require("./codex-runtime-paths");
const { validateModelProvider } = require("./product-store");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { DEFAULT_MCP_TOOL_TIMEOUT_SEC } = require("./interactive-timeouts");
const { CODEX_MCP_STARTUP_TIMEOUT_SEC } = require("./codex-startup-timeouts");
const { validRuntimeAccountId } = require("./runtime-adapter");
const { NATIVE_CODEX_RUNTIME_ACCOUNT_ID, SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("./runtime-account");

const PROVIDER_ENV_PATTERN = /^SHOGGOTH_PROVIDER_[A-F0-9]{16}_API_KEY$/;
const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
const OPENAI_RESPONSES_BASE_URL = "https://api.openai.com/v1";
const MIMO_RESPONSES_HOSTS = new Set([
  "api.xiaomimimo.com", "token-plan-cn.xiaomimimo.com", "token-plan-sgp.xiaomimimo.com", "token-plan-ams.xiaomimimo.com",
]);
// Xiaomi's Codex integration documents a 1,048,576-token context for these models.
// https://mimo.mi.com/docs/en-US/tokenplan/integration/codex-configuration
// Keep Codex's direct tools and apply only local metadata on the provider's own host.
const MIMO_MODELS = [
  "mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed",
];
const CUSTOM_PROVIDER_KINDS = new Set([
  "openai-api-key", "openrouter", "ollama", "lmstudio", "custom-responses",
]);
const MCP_INTERNAL_LAUNCH_MARKER = "launch-agent-v1";
const MCP_ROLE_ARGUMENT = "--shoggoth-internal-role=mcp";
const MCP_RUNTIME_PROFILE_ARGUMENT_PREFIX = "--shoggoth-runtime-profile=";
const MCP_RUNTIME_ACCOUNT_ARGUMENT_PREFIX = "--shoggoth-runtime-account=";
const IMPORTED_CONFIG_RELATIVE_PATH = path.join(".shoggoth-imported", "config.toml");
const IMPORTED_PREFERENCE_KEYS = new Set([
  "hide_agent_reasoning",
  "model",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "personality",
  "project_doc_max_bytes",
  "show_raw_agent_reasoning",
]);
const SAFE_IMPORTED_TOML_VALUE = /^(?:"(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9A-Fa-f]{4})*"|'[^'\r\n]*'|true|false|[-+]?\d+(?:\.\d+)?)$/u;
const MANAGED_CONFIG = Object.freeze([
  "# Managed by Shoggoth. Provider credentials must never be written to this file.",
  'forced_login_method = "chatgpt"',
  'model_provider = "openai"',
  "check_for_update_on_startup = false",
  "",
  "[shell_environment_policy]",
  'inherit = "core"',
  "ignore_default_excludes = false",
  "exclude = [",
  '  "SHOGGOTH_*_API_KEY",',
  '  "*_API_KEY",',
  '  "*_KEY",',
  '  "*_SECRET",',
  '  "*_TOKEN",',
  '  "AWS_ACCESS_KEY_ID",',
  '  "AWS_SECRET_ACCESS_KEY",',
  '  "AWS_SESSION_TOKEN",',
  '  "AWS_SECURITY_TOKEN",',
  '  "AWS_*",',
  "]",
  "",
  "[features]",
  "memories = false",
  "",
  "[memories]",
  "generate_memories = false",
  "use_memories = false",
  // Shoggoth Memory Store 是产品记忆的唯一真源。
  "disable_on_external_context = false",
  "",
].join("\n"));

function tomlString(value) {
  return JSON.stringify(value);
}

function providerConfigAlias(provider) {
  if (!provider || typeof provider.id !== "string" || typeof provider.kind !== "string") {
    throw runtimeError("CODEX_RUNTIME_CONFIG_INVALID", "Codex runtime provider identity is invalid");
  }
  const digest = crypto.createHash("sha256")
    .update(provider.kind).update("\0").update(provider.id).digest("hex").slice(0, 16);
  return `shoggoth_${digest}`;
}

function runtimeProviderBaseUrl(provider) {
  return provider.kind === "openai-api-key" ? OPENAI_RESPONSES_BASE_URL : provider.baseUrl;
}

function usesMiMoResponses(provider) {
  if (provider?.kind !== "custom-responses") return false;
  let url;
  try { url = new URL(provider.baseUrl); } catch { return false; }
  return url.protocol === "https:" && !url.port && !url.username && !url.password
    && !url.search && !url.hash && url.pathname.replace(/\/+$/u, "") === "/v1"
    && MIMO_RESPONSES_HOSTS.has(url.hostname);
}

function mimoModelCatalog() {
  // This is the Apache-licensed fallback prompt from the bundled Codex tag
  // (codex-rs/models-manager/prompt.md). An explicit catalog requires it.
  const baseInstructions = fs.readFileSync(path.join(__dirname, "prompts", "codex-0.167.1-model-fallback.md"), "utf8");
  return JSON.stringify({
    models: MIMO_MODELS.map(slug => ({
      slug,
      display_name: slug,
      base_instructions: baseInstructions,
      context_window: 1_048_576,
      max_context_window: 1_048_576,
      shell_type: "unified_exec",
      supported_reasoning_levels: [],
      default_reasoning_summary: "auto",
      supported_in_api: true,
      visibility: "none",
      priority: 99,
      support_verbosity: false,
      include_apps_usage_instructions: false,
      truncation_policy: { mode: "bytes", limit: 10_000 },
      experimental_supported_tools: [],
    })),
  }) + "\n";
}

function modelSecretProviderConfig(providerKind, baseUrl) {
  const provider = "shoggoth_local_projection";
  const prefix = `model_providers.${provider}`;
  return {
    model_provider: provider,
    [`${prefix}.name`]: "OpenAI",
    [`${prefix}.base_url`]: baseUrl,
    [`${prefix}.wire_api`]: "responses",
    [`${prefix}.supports_websockets`]: false,
    // The gateway reports local rejections as permanent. Let Codex own the
    // single retry budget for the current sampling request.
    [`${prefix}.request_max_retries`]: 0,
    [`${prefix}.stream_max_retries`]: 5,
    [`${prefix}.requires_openai_auth`]: providerKind === "chatgpt",
    ...(providerKind === "openai-api-key" ? { [`${prefix}.env_key`]: OPENAI_API_KEY_ENV } : {}),
    "features.enable_request_compression": false,
    "features.responses_websockets": false,
    "features.responses_websockets_v2": false,
  };
}

// Config table of one extra source. Custom kinds use the same keys the
// process-default custom provider writes; Bedrock is Codex's built-in
// provider and only takes its AWS location.
function extraProviderTable(provider) {
  if (provider.kind === "amazon-bedrock") {
    const entries = [["region", tomlString(provider.awsRegion)]];
    if (provider.awsProfile !== null) entries.push(["profile", tomlString(provider.awsProfile)]);
    return { table: "model_providers.amazon-bedrock.aws", entries };
  }
  const entries = [
    ["name", tomlString(provider.name)],
    ["base_url", tomlString(runtimeProviderBaseUrl(provider))],
    ["wire_api", '"responses"'],
  ];
  if (provider.credentialEnv !== null) entries.push(["env_key", tomlString(provider.credentialEnv)]);
  if (provider.kind === "openai-api-key") entries.push(["requires_openai_auth", "false"]);
  if (provider.headers !== null && Object.keys(provider.headers).length > 0) {
    entries.push(["http_headers", `{ ${Object.entries(provider.headers)
      .map(([name, value]) => `${tomlString(name)} = ${tomlString(value)}`).join(", ")} }`]);
  }
  return { table: `model_providers.${providerConfigAlias(provider)}`, entries };
}

function normalizeMcpHelperLaunch(value) {
  if (!exactPlainObject(value, ["command", "argsPrefix"])
    || typeof value.command !== "string" || !path.isAbsolute(value.command)
    || value.command.includes("\0") || Buffer.byteLength(value.command, "utf8") > 4096
    || !Array.isArray(value.argsPrefix) || value.argsPrefix.length > 1
    || value.argsPrefix.some((argument) => typeof argument !== "string"
      || !path.isAbsolute(argument) || argument.includes("\0")
      || Buffer.byteLength(argument, "utf8") > 4096)) {
    throw runtimeError("CODEX_RUNTIME_CONFIG_INVALID", "Codex MCP helper launch is invalid");
  }
  return Object.freeze({ command: value.command, argsPrefix: Object.freeze([...value.argsPrefix]) });
}

function appendMcpServer(lines, runtimeProfileId, runtimeAccountId, launch) {
  assertRuntimeProfileId(runtimeProfileId);
  if (!validRuntimeAccountId(runtimeAccountId)) {
    throw runtimeError("CODEX_RUNTIME_CONFIG_INVALID", "Codex MCP runtime account is invalid");
  }
  const argumentsValue = [
    ...launch.argsPrefix,
    MCP_ROLE_ARGUMENT,
    `${MCP_RUNTIME_PROFILE_ARGUMENT_PREFIX}${runtimeProfileId}`,
    `${MCP_RUNTIME_ACCOUNT_ARGUMENT_PREFIX}${runtimeAccountId}`,
  ];
  lines.push(
    "",
    "[mcp_servers.shoggoth]",
    `command = ${tomlString(launch.command)}`,
    `args = [${argumentsValue.map(tomlString).join(", ")}]`,
    `env = { SHOGGOTH_INTERNAL_LAUNCH = ${tomlString(MCP_INTERNAL_LAUNCH_MARKER)} }`,
    // MCP budget covers cold parent/App verification and service authentication.
    `startup_timeout_sec = ${CODEX_MCP_STARTUP_TIMEOUT_SEC}`,
    // Codex 当前要求 MCP tool timeout 为有限正数，使用跨 Runtime 的最大安全
    // timer 窗口，避免外层工具调用把持续等待的产品确认提前终止。
    `tool_timeout_sec = ${DEFAULT_MCP_TOOL_TIMEOUT_SEC}`,
    "required = true",
  );
}

function managedConfigFor(runtimeConfig, mcp = null, importedPreferences = []) {
  if (runtimeConfig === null && mcp === null && importedPreferences.length === 0) return MANAGED_CONFIG;
  const provider = runtimeConfig?.provider || null;
  const lines = [
    "# Managed by Shoggoth. Provider credentials must never be written to this file.",
    ...importedPreferences,
  ];
  if (provider?.model !== null && provider?.model !== undefined) {
    lines.push(`model = ${tomlString(provider.model)}`);
  }
  if (provider === null || provider.kind === "chatgpt") {
    lines.push(
      'forced_login_method = "chatgpt"',
      'model_provider = "openai"',
    );
  }
  const custom = provider ? CUSTOM_PROVIDER_KINDS.has(provider.kind) : false;
  const alias = custom ? providerConfigAlias(provider) : null;
  const builtIn = provider?.kind === "amazon-bedrock" ? "amazon-bedrock" : null;
  if (alias || builtIn) lines.push(`model_provider = ${tomlString(alias || builtIn)}`);
  lines.push(
    "check_for_update_on_startup = false",
    "",
    "[shell_environment_policy]",
    'inherit = "core"',
    "ignore_default_excludes = false",
    "exclude = [",
    '  "SHOGGOTH_*_API_KEY",',
    '  "*_API_KEY",',
    '  "*_KEY",',
    '  "*_SECRET",',
    '  "*_TOKEN",',
    '  "AWS_ACCESS_KEY_ID",',
    '  "AWS_SECRET_ACCESS_KEY",',
    '  "AWS_SESSION_TOKEN",',
    '  "AWS_SECURITY_TOKEN",',
    '  "AWS_*",',
    "]",
    "",
    "[features]",
    "memories = false",
    "",
    "[memories]",
    "generate_memories = false",
    "use_memories = false",
    // Shoggoth Context Compiler 按需注入已检索 Memory，Codex 不再维护第二份真源。
    "disable_on_external_context = false",
  );
  if (alias) {
    lines.push(
      "",
      `[model_providers.${alias}]`,
      `name = ${tomlString(provider.name)}`,
      `base_url = ${tomlString(runtimeProviderBaseUrl(provider))}`,
      'wire_api = "responses"',
    );
    if (provider.credentialEnv !== null) lines.push(`env_key = ${tomlString(provider.credentialEnv)}`);
    if (provider.kind === "openai-api-key") lines.push("requires_openai_auth = false");
    if (provider.headers !== null && Object.keys(provider.headers).length > 0) {
      const headers = Object.entries(provider.headers)
        .map(([name, value]) => `${tomlString(name)} = ${tomlString(value)}`).join(", ");
      lines.push(`http_headers = { ${headers} }`);
    }
  } else if (provider?.kind === "amazon-bedrock") {
    lines.push(
      "",
      "[model_providers.amazon-bedrock.aws]",
      `region = ${tomlString(provider.awsRegion)}`,
    );
    if (provider.awsProfile !== null) lines.push(`profile = ${tomlString(provider.awsProfile)}`);
  }
  for (const extra of runtimeConfig?.extraProviders || []) {
    const { table, entries } = extraProviderTable(extra);
    lines.push("", `[${table}]`, ...entries.map(([key, value]) => `${key} = ${value}`));
  }
  if (mcp !== null) {
    appendMcpServer(lines, mcp.runtimeProfileId, mcp.runtimeAccountId, mcp.launch);
  }
  lines.push("");
  return lines.join("\n");
}

function configOverridesFor(runtimeConfig, mcp = null) {
  const normalized = validateRuntimeConfig(runtimeConfig);
  const nativeCodex = mcp?.runtimeAccountId === NATIVE_CODEX_RUNTIME_ACCOUNT_ID;
  if (nativeCodex && normalized !== null) {
    throw runtimeError("CODEX_RUNTIME_CONFIG_INVALID", "Native Codex uses its own model provider configuration");
  }
  const provider = normalized?.provider || null;
  const custom = provider ? CUSTOM_PROVIDER_KINDS.has(provider.kind) : false;
  const alias = custom ? providerConfigAlias(provider) : null;
  const builtIn = provider?.kind === "amazon-bedrock" ? "amazon-bedrock" : null;
  const overrides = [
    "check_for_update_on_startup=false",
    'shell_environment_policy.inherit="core"',
    "shell_environment_policy.ignore_default_excludes=false",
    `shell_environment_policy.exclude=[${[
      "SHOGGOTH_*_API_KEY", "*_API_KEY", "*_KEY", "*_SECRET", "*_TOKEN",
      "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
      "AWS_SECURITY_TOKEN", "AWS_*",
    ].map(tomlString).join(", ")}]`,
    "features.memories=false",
    "memories.generate_memories=false",
    "memories.use_memories=false",
    "memories.disable_on_external_context=false",
  ];
  if (!nativeCodex && (provider === null || provider.kind === "chatgpt")) {
    overrides.push(
      'forced_login_method="chatgpt"',
      'model_provider="openai"',
    );
  }
  if (provider?.model !== null && provider?.model !== undefined) {
    overrides.push(`model=${tomlString(provider.model)}`);
  }
  if (alias || builtIn) overrides.push(`model_provider=${tomlString(alias || builtIn)}`);
  if (alias) {
    const prefix = `model_providers.${alias}`;
    overrides.push(
      `${prefix}.name=${tomlString(provider.name)}`,
      `${prefix}.base_url=${tomlString(runtimeProviderBaseUrl(provider))}`,
      `${prefix}.wire_api="responses"`,
    );
    if (provider.credentialEnv !== null) {
      overrides.push(`${prefix}.env_key=${tomlString(provider.credentialEnv)}`);
    }
    if (provider.kind === "openai-api-key") {
      overrides.push(`${prefix}.requires_openai_auth=false`);
    }
    if (provider.headers !== null && Object.keys(provider.headers).length > 0) {
      const headers = Object.entries(provider.headers)
        .map(([name, value]) => `${tomlString(name)} = ${tomlString(value)}`).join(", ");
      overrides.push(`${prefix}.http_headers={ ${headers} }`);
    }
  } else if (provider?.kind === "amazon-bedrock") {
    overrides.push(`model_providers.amazon-bedrock.aws.region=${tomlString(provider.awsRegion)}`);
    if (provider.awsProfile !== null) {
      overrides.push(`model_providers.amazon-bedrock.aws.profile=${tomlString(provider.awsProfile)}`);
    }
  }
  for (const extra of normalized?.extraProviders || []) {
    const { table, entries } = extraProviderTable(extra);
    overrides.push(...entries.map(([key, value]) => `${table}.${key}=${value}`));
  }
  if (mcp !== null) {
    const launch = normalizeMcpHelperLaunch(mcp.launch);
    assertRuntimeProfileId(mcp.runtimeProfileId);
    if (!validRuntimeAccountId(mcp.runtimeAccountId)) {
      throw runtimeError("CODEX_RUNTIME_CONFIG_INVALID", "Codex MCP runtime account is invalid");
    }
    const args = [
      ...launch.argsPrefix,
      MCP_ROLE_ARGUMENT,
      `${MCP_RUNTIME_PROFILE_ARGUMENT_PREFIX}${mcp.runtimeProfileId}`,
      `${MCP_RUNTIME_ACCOUNT_ARGUMENT_PREFIX}${mcp.runtimeAccountId}`,
    ];
    overrides.push(
      `mcp_servers.shoggoth.command=${tomlString(launch.command)}`,
      `mcp_servers.shoggoth.args=[${args.map(tomlString).join(", ")}]`,
      `mcp_servers.shoggoth.env={ SHOGGOTH_INTERNAL_LAUNCH = ${tomlString(MCP_INTERNAL_LAUNCH_MARKER)} }`,
      `mcp_servers.shoggoth.startup_timeout_sec=${CODEX_MCP_STARTUP_TIMEOUT_SEC}`,
      `mcp_servers.shoggoth.tool_timeout_sec=${DEFAULT_MCP_TOOL_TIMEOUT_SEC}`,
      "mcp_servers.shoggoth.required=true",
    );
  }
  return Object.freeze(overrides);
}

// This receipt contains only the helper configuration applied to one Binding.
// Provider configuration and credentials never enter capability observations.
const MCP_BOOTSTRAP_RECEIPTS = new WeakSet();
function mcpBootstrapReceipt({ runtimeProfileId, runtimeAccountId, launch }) {
  const helperLaunch = normalizeMcpHelperLaunch(launch);
  const overrides = configOverridesFor(null, { runtimeProfileId, runtimeAccountId, launch: helperLaunch })
    .filter(value => value.startsWith("mcp_servers.shoggoth."));
  const receipt = Object.freeze({ version: 1, runtimeProfileId, runtimeAccountId, helperLaunch,
    overrides: Object.freeze(overrides) });
  MCP_BOOTSTRAP_RECEIPTS.add(receipt);
  return receipt;
}
function validMcpBootstrapReceipt(receipt, { binding, configArgs = null, launch = null } = {}) {
  try {
    if (!receipt || !MCP_BOOTSTRAP_RECEIPTS.has(receipt) || receipt.version !== 1 || receipt.runtimeProfileId !== binding?.runtimeProfileId
      || receipt.runtimeAccountId !== binding?.runtimeAccountId) return false;
    const expected = mcpBootstrapReceipt({ ...binding, launch: launch ?? receipt.helperLaunch });
    if (JSON.stringify(receipt.helperLaunch) !== JSON.stringify(expected.helperLaunch)
      || JSON.stringify(receipt.overrides) !== JSON.stringify(expected.overrides)) return false;
    if (configArgs !== null) {
      if (!Array.isArray(configArgs) || configArgs.length % 2 !== 0) return false;
      const actual = new Map();
      for (let index = 0; index < configArgs.length; index += 2) {
        if (configArgs[index] !== "-c" || typeof configArgs[index + 1] !== "string") return false;
        const value = configArgs[index + 1];
        if (value.startsWith("mcp_servers.shoggoth.")) actual.set(value.split("=", 1)[0], value);
      }
      const allowed = new Set(expected.overrides.map(value => value.split("=", 1)[0]));
      if (actual.has("mcp_servers.shoggoth.enabled") && actual.get("mcp_servers.shoggoth.enabled") !== "mcp_servers.shoggoth.enabled=true") return false;
      allowed.add("mcp_servers.shoggoth.enabled");
      if ([...actual.keys()].some(key => !allowed.has(key))
        || expected.overrides.some(value => actual.get(value.split("=", 1)[0]) !== value)) return false;
    }
    return true;
  } catch { return false; }
}

function importedCodexPreferences(fileSystem, codexHome, runtimeConfig) {
  const target = path.join(codexHome, IMPORTED_CONFIG_RELATIVE_PATH);
  let stat;
  try { stat = fileSystem.lstatSync(target); } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw runtimeError("CODEX_RUNTIME_CONFIG_INVALID", "Imported Codex config is unsafe");
  }
  const text = fileSystem.readFileSync(target, "utf8");
  if (typeof text !== "string" || !text.isWellFormed()) {
    throw runtimeError("CODEX_RUNTIME_CONFIG_INVALID", "Imported Codex config is invalid UTF-8");
  }
  const selected = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) break;
    const match = trimmed.match(/^([a-z][a-z0-9_]*)\s*=\s*(.+)$/u);
    if (!match || !IMPORTED_PREFERENCE_KEYS.has(match[1]) || match[2].includes("#")
      || !SAFE_IMPORTED_TOML_VALUE.test(match[2])) continue;
    if (match[1] === "model" && runtimeConfig?.provider?.model) continue;
    if (!selected.has(match[1])) selected.set(match[1], `${match[1]} = ${match[2]}`);
  }
  return [...selected.values()];
}

function exactPlainObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function rawUrlPathname(raw) {
  const authorityStart = raw.indexOf("://") + 3;
  if (authorityStart < 3) throw new URIError("URL is missing an authority");
  const queryStart = raw.indexOf("?", authorityStart);
  const hashStart = raw.indexOf("#", authorityStart);
  const pathnameEnd = Math.min(
    queryStart === -1 ? raw.length : queryStart,
    hashStart === -1 ? raw.length : hashStart,
  );
  const pathnameStart = raw.indexOf("/", authorityStart);
  return pathnameStart === -1 || pathnameStart >= pathnameEnd
    ? "/"
    : raw.slice(pathnameStart, pathnameEnd);
}

function assertSafeUrlPathLayer(pathname) {
  if (/%2f/iu.test(pathname)) {
    throw new URIError("URL pathname contains an encoded slash");
  }
  const hasDotSegment = pathname.split("/").some((segment) => {
    const withEncodedDots = segment.replace(/%2e/giu, ".");
    return withEncodedDots === "." || withEncodedDots === "..";
  });
  if (hasDotSegment) throw new URIError("URL pathname contains a dot segment");
}

function safelyDecodeUrlPathname(value) {
  // 保守展开嵌套编码，防止下游 URL 归一化后才变成请求 endpoint。
  const raw = value instanceof URL ? value.toString() : value;
  if (typeof raw !== "string" || /[\u0000-\u001f\u007f\\]/u.test(raw)) {
    throw new URIError("URL pathname contains unsafe characters");
  }
  // WHATWG URL 会在暴露 pathname 前消除 literal/encoded dot segment；先检查原始层，
  // 否则 `/responses/%2e` 会在安全校验前被规范化为 `/responses/`。
  assertSafeUrlPathLayer(rawUrlPathname(raw));
  let pathname = new URL(raw).pathname;
  let stabilized = false;
  for (let pass = 0; pass < 8; pass += 1) {
    // 原始 `/` 是 API root 的正常分隔符；但任意层的 `%2f` 会使下游
    // decode/normalize 凭空产生新 path segment，因此无论是否最终指向 endpoint 都拒绝。
    assertSafeUrlPathLayer(pathname);
    const decoded = decodeURIComponent(pathname);
    // WHATWG 会把 special-scheme pathname 中的反斜杠再归一化成斜杠；
    // 必须在把 decoded pathname 赋回 URL 之前拒绝它与 ASCII control。
    if (/[\u0000-\u001f\u007f\\]/u.test(decoded)) {
      throw new URIError("URL pathname contains unsafe characters");
    }
    assertSafeUrlPathLayer(decoded);
    if (decoded === pathname) {
      stabilized = true;
      break;
    }
    pathname = decoded;
  }
  if (!stabilized) throw new URIError("URL pathname encoding is too deeply nested");

  // 调用方必须基于 WHATWG 最终形态检查 request endpoint，不能检查完再让 URL setter 改写。
  const normalized = new URL(raw);
  normalized.pathname = pathname;
  const finalPathname = normalized.pathname;
  assertSafeUrlPathLayer(finalPathname);
  return finalPathname;
}

function assertPresetRuntime(provider, credentialEnv) {
  if (provider.kind === "openrouter") {
    const headerKeys = provider.headers === null ? [] : Object.keys(provider.headers);
    let referer;
    try { referer = new URL(provider.headers?.["HTTP-Referer"]); } catch { throw new Error("invalid OpenRouter attribution"); }
    if (provider.baseUrl !== "https://openrouter.ai/api/v1" || credentialEnv === null
      || provider.awsRegion !== null || provider.awsProfile !== null
      || headerKeys.length !== 2 || !headerKeys.includes("HTTP-Referer")
      || !headerKeys.includes("X-OpenRouter-Title")
      || provider.headers["X-OpenRouter-Title"] !== "Shoggoth"
      || referer.protocol !== "https:" || !referer.hostname || referer.username || referer.password
      || referer.search || referer.hash
      || referer.hostname.toLowerCase().split(".").at(-1) === "example") {
      throw new Error("invalid OpenRouter preset");
    }
    return;
  }
  if (provider.kind === "ollama" || provider.kind === "lmstudio") {
    const expected = provider.kind === "ollama"
      ? "http://127.0.0.1:11434/v1" : "http://127.0.0.1:1234/v1";
    if (provider.baseUrl !== expected || provider.headers !== null || credentialEnv !== null
      || provider.awsRegion !== null || provider.awsProfile !== null) {
      throw new Error("invalid local provider preset");
    }
    return;
  }
  if (provider.kind === "custom-responses") {
    let decodedPathname;
    try { decodedPathname = safelyDecodeUrlPathname(provider.baseUrl); } catch {
      throw new Error("invalid custom Responses API root");
    }
    const pathname = decodedPathname.replace(/\/+$/u, "") || "/";
    if (/(?:^|\/)responses$/iu.test(pathname) || /(?:^|\/)chat\/completions$/iu.test(pathname)
      || provider.awsRegion !== null || provider.awsProfile !== null) {
      throw new Error("invalid custom Responses API root");
    }
    return;
  }
  if (provider.kind === "openai-api-key") {
    if (provider.baseUrl !== null || provider.headers !== null
      || (credentialEnv !== null && credentialEnv !== OPENAI_API_KEY_ENV)
      || provider.awsRegion !== null || provider.awsProfile !== null) {
      throw new Error("invalid OpenAI API key provider preset");
    }
    return;
  }
  if (provider.kind === "chatgpt") {
    if (provider.baseUrl !== null || provider.headers !== null || credentialEnv !== null
      || provider.awsRegion !== null || provider.awsProfile !== null) {
      throw new Error("invalid ChatGPT authority provider preset");
    }
    return;
  }
  if (provider.kind === "amazon-bedrock"
    && (provider.baseUrl !== null || provider.headers !== null || credentialEnv !== null)) {
    throw new Error("invalid Bedrock provider preset");
  }
}

function validateRuntimeProvider(input) {
  if (!exactPlainObject(input, [
    "id", "kind", "name", "baseUrl", "model", "headers", "awsRegion", "awsProfile",
    "credentialEnv",
  ])) {
    throw new Error("invalid runtime config");
  }
  const provider = validateModelProvider({
    id: input.id,
    kind: input.kind,
    name: input.name,
    baseUrl: input.baseUrl,
    model: input.model,
    credentialRef: null,
    headers: input.headers,
    awsRegion: input.awsRegion,
    awsProfile: input.awsProfile,
    validationStatus: "unverified",
  });
  if (input.credentialEnv !== null
    && (typeof input.credentialEnv !== "string"
      || (input.kind === "openai-api-key"
        ? input.credentialEnv !== OPENAI_API_KEY_ENV
        : !PROVIDER_ENV_PATTERN.test(input.credentialEnv)))) {
    throw new Error("invalid credential env");
  }
  if (!CUSTOM_PROVIDER_KINDS.has(provider.kind)
    && provider.kind !== "openai-api-key"
    && input.credentialEnv !== null) {
    throw new Error("authority provider cannot use custom credential env");
  }
  assertPresetRuntime(provider, input.credentialEnv);
  return {
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    baseUrl: provider.baseUrl,
    model: provider.model,
    headers: provider.headers,
    awsRegion: provider.awsRegion,
    awsProfile: provider.awsProfile,
    credentialEnv: input.credentialEnv,
  };
}

// `extraProviders` are supplemental declarations alongside the app-server's
// default source (`provider`, null = ChatGPT).
function validateRuntimeConfig(input) {
  if (input === null) return null;
  try {
    const hasExtra = Object.hasOwn(input || {}, "extraProviders");
    if (!exactPlainObject(input, hasExtra ? ["provider", "extraProviders"] : ["provider"])
      || (input.provider === null && !hasExtra)) {
      throw new Error("invalid runtime config");
    }
    const provider = input.provider === null ? null : validateRuntimeProvider(input.provider);
    if (!hasExtra) return { provider };
    if (!Array.isArray(input.extraProviders) || input.extraProviders.length > 64) {
      throw new Error("invalid extra providers");
    }
    const extraProviders = input.extraProviders.map(validateRuntimeProvider);
    const aliases = extraProviders.map(providerConfigAlias);
    if (extraProviders.some((entry) => (!CUSTOM_PROVIDER_KINDS.has(entry.kind) && entry.kind !== "amazon-bedrock")
      || entry.id === provider?.id)
      // Bedrock has one built-in config table; OpenAI keys share OPENAI_API_KEY.
      || ["amazon-bedrock", "openai-api-key"].some((kind) => extraProviders
        .filter((entry) => entry.kind === kind).length + (provider?.kind === kind ? 1 : 0) > 1)
      || new Set(aliases).size !== aliases.length) {
      throw new Error("invalid extra providers");
    }
    return { provider, extraProviders };
  } catch {
    throw runtimeError("CODEX_RUNTIME_CONFIG_INVALID", "Codex runtime config is invalid");
  }
}

class CodexRuntimeConfigWriter {
  constructor(options = {}) {
    if (!options.paths?.stateDir || !options.paths?.trustedRoot) {
      throw runtimeError("CODEX_RUNTIME_CONFIG_PATH_INVALID", "Codex runtime config paths are invalid");
    }
    this.paths = options.paths;
    this.fs = options.fs || fs;
    this.mcpHelperLaunch = normalizeMcpHelperLaunch(options.mcpHelperLaunch || {
      command: process.execPath,
      argsPrefix: [],
    });
  }

  write({ runtimeProfileId, runtimeAccountId, codexHome, runtimeConfig }) {
    assertRuntimeProfileId(runtimeProfileId);
    if (!validRuntimeAccountId(runtimeAccountId)) {
      throw runtimeError("CODEX_RUNTIME_CONFIG_INVALID", "Codex MCP runtime account is invalid");
    }
    const expectedHome = prepareCodexHome(this.paths, runtimeProfileId);
    if (path.resolve(codexHome) !== expectedHome) {
      throw runtimeError("CODEX_RUNTIME_CONFIG_PATH_INVALID", "Codex runtime config path is invalid");
    }
    const normalized = validateRuntimeConfig(runtimeConfig);
    const configPath = path.join(expectedHome, "config.toml");
    const importedPreferences = importedCodexPreferences(this.fs, expectedHome, normalized);
    atomicWritePrivateFile(configPath, managedConfigFor(normalized, {
      runtimeProfileId,
      runtimeAccountId,
      launch: this.mcpHelperLaunch,
    }, importedPreferences), {
      fs: this.fs,
      trustedRoot: this.paths.trustedRoot,
    });
    return Object.freeze({ configPath, runtimeConfig: normalized });
  }

  overlay({ runtimeProfileId, runtimeAccountId, runtimeConfig }) {
    assertRuntimeProfileId(runtimeProfileId);
    if (!validRuntimeAccountId(runtimeAccountId)) {
      throw runtimeError("CODEX_RUNTIME_CONFIG_INVALID", "Codex MCP runtime account is invalid");
    }
    const normalized = validateRuntimeConfig(runtimeConfig);
    const overrides = [...configOverridesFor(normalized, {
      runtimeProfileId,
      runtimeAccountId,
      launch: this.mcpHelperLaunch,
    })];
    // This Responses API rejects Guardian's JSON Schema output. The adapter
    // sends approval requests to the user with the same sandbox and policy.
    const requiresUserApproval = runtimeAccountId === SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID
      && usesMiMoResponses(normalized?.provider);
    if (requiresUserApproval) {
      // Codex reads model_catalog_json on app-server startup. A thread override
      // cannot replace the synthetic descriptor, which caps window overrides at 272K.
      const home = prepareCodexRuntimeAccountHome(this.paths, runtimeAccountId);
      const catalog = mimoModelCatalog();
      const digest = crypto.createHash("sha256").update(catalog).digest("hex");
      // A changed catalog gets its own path so active processes can still read
      // the startup file they were given, including during app updates.
      const catalogPath = path.join(home, `shoggoth-mimo-model-catalog-${digest}.json`);
      try {
        if (readPrivateFile(catalogPath, { fs: this.fs, maxBytes: 256 * 1024 }).toString("utf8") !== catalog) {
          throw runtimeError("CODEX_RUNTIME_CONFIG_INVALID", "Generated MiMo model catalog does not match its expected contents");
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        atomicWritePrivateFile(catalogPath, catalog, { fs: this.fs, trustedRoot: this.paths.trustedRoot });
      }
      overrides.push(`model_catalog_json=${tomlString(catalogPath)}`);
    }
    return Object.freeze({
      args: Object.freeze(overrides.flatMap((value) => ["-c", value])),
      runtimeConfig: normalized,
      ...(requiresUserApproval ? { requiresUserApproval } : {}),
      mcpBootstrap: mcpBootstrapReceipt({ runtimeProfileId, runtimeAccountId, launch: this.mcpHelperLaunch }),
    });
  }
}

module.exports = {
  CodexRuntimeConfigWriter,
  IMPORTED_CONFIG_RELATIVE_PATH,
  MANAGED_CONFIG,
  OPENAI_API_KEY_ENV,
  OPENAI_RESPONSES_BASE_URL,
  PROVIDER_ENV_PATTERN,
  configOverridesFor,
  mcpBootstrapReceipt,
  validMcpBootstrapReceipt,
  managedConfigFor,
  importedCodexPreferences,
  modelSecretProviderConfig,
  providerConfigAlias,
  normalizeMcpHelperLaunch,
  safelyDecodeUrlPathname,
  validateRuntimeConfig,
};
