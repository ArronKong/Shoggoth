"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { assertRuntimeProfileId, prepareCodexHome, runtimeError } = require("./codex-runtime-paths");
const { validateModelProvider } = require("./product-store");
const { atomicWritePrivateFile } = require("./private-file");
const { DEFAULT_MCP_TOOL_TIMEOUT_SEC } = require("./interactive-timeouts");
const { CODEX_MCP_STARTUP_TIMEOUT_SEC } = require("./codex-startup-timeouts");
const { validRuntimeAccountId } = require("./runtime-adapter");

const PROVIDER_ENV_PATTERN = /^SHOGGOTH_PROVIDER_[A-F0-9]{16}_API_KEY$/;
const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
const OPENAI_RESPONSES_BASE_URL = "https://api.openai.com/v1";
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
  // Shoggoth Memory Store 是唯一真源；Codex native memory 仅由显式迁移器只读导入。
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
  if (mcp !== null) {
    appendMcpServer(lines, mcp.runtimeProfileId, mcp.runtimeAccountId, mcp.launch);
  }
  lines.push("");
  return lines.join("\n");
}

function configOverridesFor(runtimeConfig, mcp = null) {
  const normalized = validateRuntimeConfig(runtimeConfig);
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
  if (provider === null || provider.kind === "chatgpt") {
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

function validateRuntimeConfig(input) {
  if (input === null) return null;
  try {
    if (!exactPlainObject(input, ["provider"]) || input.provider === null
      || !exactPlainObject(input.provider, [
        "id", "kind", "name", "baseUrl", "model", "headers", "awsRegion", "awsProfile",
        "credentialEnv",
      ])) {
      throw new Error("invalid runtime config");
    }
    const provider = validateModelProvider({
      id: input.provider.id,
      kind: input.provider.kind,
      name: input.provider.name,
      baseUrl: input.provider.baseUrl,
      model: input.provider.model,
      credentialRef: null,
      headers: input.provider.headers,
      awsRegion: input.provider.awsRegion,
      awsProfile: input.provider.awsProfile,
      validationStatus: "unverified",
    });
    if (input.provider.credentialEnv !== null
      && (typeof input.provider.credentialEnv !== "string"
        || (input.provider.kind === "openai-api-key"
          ? input.provider.credentialEnv !== OPENAI_API_KEY_ENV
          : !PROVIDER_ENV_PATTERN.test(input.provider.credentialEnv)))) {
      throw new Error("invalid credential env");
    }
    if (!CUSTOM_PROVIDER_KINDS.has(provider.kind)
      && provider.kind !== "openai-api-key"
      && input.provider.credentialEnv !== null) {
      throw new Error("authority provider cannot use custom credential env");
    }
    assertPresetRuntime(provider, input.provider.credentialEnv);
    return {
      provider: {
        id: provider.id,
        kind: provider.kind,
        name: provider.name,
        baseUrl: provider.baseUrl,
        model: provider.model,
        headers: provider.headers,
        awsRegion: provider.awsRegion,
        awsProfile: provider.awsProfile,
        credentialEnv: input.provider.credentialEnv,
      },
    };
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
    const overrides = configOverridesFor(normalized, {
      runtimeProfileId,
      runtimeAccountId,
      launch: this.mcpHelperLaunch,
    });
    return Object.freeze({
      args: Object.freeze(overrides.flatMap((value) => ["-c", value])),
      runtimeConfig: normalized,
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
  managedConfigFor,
  importedCodexPreferences,
  providerConfigAlias,
  normalizeMcpHelperLaunch,
  safelyDecodeUrlPathname,
  validateRuntimeConfig,
};
