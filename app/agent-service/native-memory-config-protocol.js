"use strict";

const { serviceError } = require("./security");

const NATIVE_MEMORY_CONFIG_METHODS = Object.freeze(["memory.config.apply", "memory.config.read", "memory.config.context"]);
const NATIVE_MEMORY_CONFIG_PUBLIC_MESSAGES = Object.freeze({
  NATIVE_MEMORY_CONFIG_INVALID: "记忆配置无效或包含尚未支持的设置",
  NATIVE_MEMORY_CONFIG_STALE: "记忆配置已更新，请刷新后重试",
  NATIVE_MEMORY_CONFIG_CONFLICT: "记忆配置版本冲突",
  NATIVE_MEMORY_CONFIG_UNAVAILABLE: "暂时无法读取记忆配置",
  NATIVE_MEMORY_CONFIG_UNCERTAIN: "记忆配置写入结果尚未确认",
  NATIVE_MEMORY_CONFIG_APPLY_FAILED: "未能应用记忆配置，已恢复原设置",
  NATIVE_MEMORY_CONFIG_ROLLBACK_PENDING: "记忆配置未确认恢复，请刷新并检查服务状态",
});
const error = code => serviceError(code, NATIVE_MEMORY_CONFIG_PUBLIC_MESSAGES[code]);
const invalid = () => { throw error("NATIVE_MEMORY_CONFIG_INVALID"); };
const bool = value => typeof value === "boolean" ? value : invalid();
const num = (min, max, integer = true) => value => typeof value === "number" && Number.isFinite(value)
  && (!integer || Number.isSafeInteger(value)) && value >= min && value <= max ? value : invalid();
const text = (max = 256) => value => typeof value === "string" && value.length <= max
  && value.isWellFormed() && !value.includes("\0") ? value : invalid();
const choice = (...values) => value => values.includes(value) ? value : invalid();
const list = (item, max = 256) => value => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  return Object.freeze(Array.from({ length: value.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !Object.hasOwn(field, "value")) invalid();
    return item(field.value);
  }));
};
function record(value, shape, required = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string" || !Object.hasOwn(shape, key))
    || required.some(key => !Object.hasOwn(value, key))) invalid();
  const out = {};
  // Canonical order makes equal revisions independent of JSON property order.
  for (const key of Object.keys(shape)) if (Object.hasOwn(value, key)) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) invalid();
    out[key] = shape[key](field.value);
  }
  return Object.freeze(out);
}
const object = shape => value => record(value, shape);
const fraction = num(0, 1, false), positive = num(1, 1_000_000), nonnegative = num(0, 1_000_000);
const timezone = value => {
  text(100)(value);
  try { new Intl.DateTimeFormat("en", { timeZone: value }); } catch { invalid(); }
  return value;
};
const cron = value => {
  text(100)(value);
  try { require("cron-parser").CronExpressionParser.parse(value); } catch { invalid(); }
  return value;
};
const bytes = value => {
  if (typeof value === "number") return num(0, 1024 * 1024 * 1024)(value);
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?\s*(?:b|kb|mb|gb)$/iu.test(value)) invalid();
  const number = Number.parseFloat(value), unit = value.trim().replace(/^[\d.]+\s*/u, "").toLowerCase();
  if (number * ({ b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[unit]) > 1024 ** 3) invalid();
  return value;
};

// Public model sources can be local paths, hf: references or public downloads.
// They do not authorize provider credentials or remote inference endpoints.
const localText = (max = 4096, required = false) => value => {
  text(max)(value);
  if (/[\u0000-\u001f\u007f]/u.test(value) || required && !value.trim()) invalid();
  return value;
};
const credentialName = /(?:^|[-_])(?:api[-_]?key|access[-_]?token|token|auth|authorization|password|secret|credential|signature|sig)(?:$|[-_])/iu;
const modelSource = value => {
  localText()(value);
  const source = value.trim();
  if (/^(?:https?:\/\/|hf:)/iu.test(source)) {
    let url; try { url = new URL(source); } catch { invalid(); }
    if (url.username || url.password || [...url.searchParams.keys()].some(key => credentialName.test(key))
      || [...new URLSearchParams(url.hash.slice(1)).keys()].some(key => credentialName.test(key))) invalid();
    if (/^hf:/iu.test(source) && !source.slice(3).trim()) invalid();
  } else if (/^[a-z][a-z0-9+.-]*:/iu.test(source)) invalid();
  return value;
};
const localPath = value => {
  localText(4096, true)(value);
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value.trim())) invalid();
  return value;
};
const loopbackUrl = value => {
  localText(4096, true)(value);
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}(?:\/[^?#]*)?$/iu.test(value)) invalid();
  let url; try { url = new URL(value); } catch { invalid(); }
  if (!url.port || Number(url.port) < 1 || Number(url.port) > 65535 || url.username || url.password
    || url.search || url.hash) invalid();
  return value;
};
const localArgs = value => {
  const args = list(localText(), 256)(value);
  for (let index = 0; index < args.length; index++) {
    const option = args[index].split("=", 1)[0];
    if (/^--(?:api[-_]?keys?(?:[-_]file)?|auth(?:orization)?|token|bearer|password|secret|credentials?|headers?|env)(?:$|[-_])/iu.test(option)
      || option === "-H") invalid();
    if (option === "--host") {
      const host = args[index].includes("=") ? args[index].slice(args[index].indexOf("=") + 1) : args[index + 1];
      if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) invalid();
    }
  }
  return args;
};
const localService = value => record(value, {
  command: localPath, args: localArgs, cwd: localPath, healthUrl: loopbackUrl,
  readyTimeoutMs: num(1, Number.MAX_SAFE_INTEGER), idleStopMs: num(0, Number.MAX_SAFE_INTEGER),
}, ["command"]);
const localModel = value => record(value, { id: localText(512, true), name: localText(512, true),
  params: object({ modelPath: modelSource }) }, ["id", "name"]);
const llamaCpp = value => record(value, { baseUrl: loopbackUrl, models: list(localModel, 256),
  params: object({ modelCacheDir: localPath }), localService }, ["baseUrl", "models", "localService"]);
const localModels = object({ providers: object({ "llama-cpp": llamaCpp }) });

// Product references are opaque owners, never credential handles. Provider
// and fallback owners are independently scoped to their requested provider key.
const publicId = value => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
    || ["__proto__", "prototype", "constructor"].includes(value)) invalid();
  return value;
};
const providerRefs = value => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length > 128) invalid();
  const shape = Object.create(null);
  for (const key of Reflect.ownKeys(value)) { publicId(key); shape[key] = publicId; }
  return record(value, Object.fromEntries(Object.entries(shape).sort(([a], [b]) => a.localeCompare(b))));
};
const transportHeaderNames = new Set(["host", "connection", "proxy-connection", "keep-alive", "transfer-encoding", "content-length", "te", "trailer", "upgrade"]);
const sensitiveHeaderName = /auth|cookie|token|api[-_]?key|password|secret|credential|signature|session|bearer|jwt/iu;
const sensitiveHeaderValue = /(?:^|\s)(?:bearer|basic|digest|token)\s+|(?:^|\b)(?:sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{12,})/iu;
const remoteHeaders = value => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length > 128) invalid();
  const shape = Object.create(null), normalized = new Set();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u.test(key)
      || sensitiveHeaderName.test(key) || transportHeaderNames.has(key.toLowerCase()) || ["__proto__", "prototype", "constructor"].includes(key)
      || normalized.has(key.toLowerCase())) invalid();
    normalized.add(key.toLowerCase());
    shape[key] = entry => { localText(4096)(entry); if (sensitiveHeaderValue.test(entry)) invalid(); return entry; };
  }
  return record(value, Object.fromEntries(Object.entries(shape).sort(([a], [b]) => a.localeCompare(b))));
};
const remoteBaseUrl = value => {
  localText(4096, true)(value);
  let url; try { url = new URL(value); } catch { invalid(); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password
    || url.search || url.hash || value !== value.trim()) invalid();
  return value;
};
// Only upstream public search fields are transported. Authentication remains
// in the Product's private provider-resource bridge.
const search = object({ enabled: bool, rememberAcrossConversations: bool,
  sources: list(choice("memory", "sessions"), 2), experimental: object({ sessionMemory: bool }),
  extraPaths: list(value => typeof value === "string" ? text(4096)(value)
    : record(value, { path: text(4096), pattern: text(512) }, ["path"]), 64),
  provider: publicId, model: localText(512), fallback: publicId,
  inputType: localText(256, true), queryInputType: localText(256, true), documentInputType: localText(256, true),
  remote: object({ baseUrl: remoteBaseUrl, headers: remoteHeaders, batch: object({ enabled: bool }) }),
  multimodal: object({ enabled: bool, modalities: list(choice("image", "audio", "all"), 256), maxFileBytes: num(1, Number.MAX_SAFE_INTEGER) }),
  providerRefs,
  local: object({ modelPath: modelSource }), outputDimensionality: num(1, Number.MAX_SAFE_INTEGER),
  cache: object({ enabled: bool }),
  store: object({ fts: object({ tokenizer: choice("unicode61", "trigram") }) }),
  query: object({ maxResults: num(1, 200), minScore: fraction }) });
const memory = object({ search });
// Alias collisions use upstream's insertion order (last wins). Unlike Profile
// maps, sorting these keys would change the user's model selection semantics.
const models = value => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length > 256) invalid();
  const shape = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !key.trim() || key.length > 512 || !key.isWellFormed()
      || /[\u0000-\u001f\u007f]/u.test(key) || ["__proto__", "prototype", "constructor"].includes(key)) invalid();
    shape[key] = object({ alias: value => {
      text(256)(value);
      return /[\u0000-\u001f\u007f]/u.test(value) ? invalid() : value;
    } });
  }
  return record(value, shape);
};
function validateNativeMemoryModelAliases(value) {
  try {
    const result = record(value, { defaults: models, agent: models });
    if (Buffer.byteLength(JSON.stringify(result)) > 48 * 1024) invalid();
    return result;
  } catch { throw error("NATIVE_MEMORY_CONFIG_INVALID"); }
}
// The pinned plugin's public schema only exposes model here. Internal resolved
// fields such as phase cron/sources and execution speed are not user settings.
const execution = object({ model: text() });
const dreaming = object({ enabled: bool, frequency: cron, timezone, verboseLogging: bool,
  model: text(), storage: object({ mode: choice("inline", "separate", "both"), separateReports: bool }),
  execution: object({ defaults: execution }), phases: object({
    light: object({ enabled: bool, lookbackDays: nonnegative, limit: nonnegative, dedupeSimilarity: fraction, execution }),
    deep: object({ enabled: bool, limit: nonnegative, minScore: fraction, minRecallCount: nonnegative,
      minUniqueQueries: nonnegative, recencyHalfLifeDays: nonnegative, maxAgeDays: positive,
      maxPromotedSnippetTokens: positive, maxPriorEntryLossFraction: fraction,
      execution }),
    rem: object({ enabled: bool, lookbackDays: nonnegative, limit: nonnegative, minPatternStrength: fraction, execution }),
  }) });
const active = object({ enabled: bool, mode: choice("always", "off", "escalate"), agents: list(text(128)), excludedAgents: list(text(128)),
  model: text(), modelFallback: text(), allowedChatTypes: list(choice("direct"), 1),
  thinking: choice("off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"),
  fastMode: choice(true, false, "auto"),
  persistTranscripts: bool, transcriptDir: text(1024),
  toolsAllow: list(choice("memory_search", "memory_get"), 2),
  promptStyle: choice("balanced", "strict", "contextual", "recall-heavy", "precision-heavy", "preference-only"),
  promptOverride: text(8192), promptAppend: text(8192), timeoutMs: num(1_000, 600_000),
  setupGraceTimeoutMs: num(0, 120_000), maxSummaryChars: num(40, 1000), cacheTtlMs: num(1_000, 120_000),
  circuitBreakerMaxTimeouts: num(1, 20), circuitBreakerCooldownMs: num(5_000, 600_000) });
const entries = value => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length > 256) invalid();
  const shape = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(key)
      || ["__proto__", "prototype", "constructor"].includes(key)) invalid();
    shape[key] = object({ memory, models });
  }
  return record(value, Object.fromEntries(Object.entries(shape).sort(([a], [b]) => a.localeCompare(b))));
};
const config = object({ memory, models: localModels, agents: object({ entries, defaults: object({ userTimezone: timezone, models,
  compaction: object({ memoryFlush: object({ enabled: bool, model: text(), softThresholdTokens: nonnegative,
    forceFlushTranscriptBytes: bytes }) }) }) }),
  plugins: object({ entries: object({ "memory-core": object({ config: object({ dreaming }) }),
    "active-memory": object({ enabled: bool, config: active }) }) }) });

// A local embedding host can validate the resources alone without passing
// private runtime fields (workspace, route stamps or credentials) here.
function validateNativeMemoryLocalModels(value) {
  try {
    const result = localModels(value);
    if (Buffer.byteLength(JSON.stringify(result)) > 48 * 1024) invalid();
    return result;
  } catch { throw error("NATIVE_MEMORY_CONFIG_INVALID"); }
}
function validateSearchPolicy(value) {
  const global = value.memory?.search || {};
  for (const override of [undefined, ...Object.values(value.agents?.entries || {}).map(entry => entry.memory?.search)]) {
    const media = { ...global.multimodal, ...override?.multimodal };
    if (media.enabled !== true || media.modalities?.length === 0) continue;
    const fallback = override?.fallback ?? global.fallback ?? "none";
    if (fallback !== "none") invalid();
    const provider = override?.provider ?? global.provider;
    if (!provider || ["none", "shoggoth-e5", "local"].includes(provider.toLowerCase())) invalid();
    const model = (override?.model ?? global.model ?? "").trim().replace(/^(?:models\/(?:gemini\/|google\/)?|gemini\/|google\/)/u, "");
    if (!["gemini-embedding-2", "gemini-embedding-2-preview"].includes(model)) invalid();
  }
}
function validateNativeMemoryRemoteHeaders(value) {
  try { return remoteHeaders(value); } catch { throw error("NATIVE_MEMORY_CONFIG_INVALID"); }
}
function validateNativeMemoryProviderRefs(value) {
  try { return providerRefs(value); } catch { throw error("NATIVE_MEMORY_CONFIG_INVALID"); }
}
function validateNativeMemoryConfigProjection(value) {
  try {
    const result = record(value, { revision: num(0, Number.MAX_SAFE_INTEGER), config }, ["revision", "config"]);
    if (Buffer.byteLength(JSON.stringify(result)) > 48 * 1024) invalid();
    validateSearchPolicy(result.config);
    return result;
  } catch { throw error("NATIVE_MEMORY_CONFIG_INVALID"); }
}
function validateNativeMemoryConfigParams(method, value) {
  if (method === "memory.config.apply") return validateNativeMemoryConfigProjection(value);
  if (["memory.config.read", "memory.config.context"].includes(method)) return record(value, {});
  invalid();
}
function validateNativeMemoryConfigResult(method, value) {
  if (method !== "memory.config.context") return validateNativeMemoryConfigProjection(value);
  try {
    const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)
      && !["__proto__", "prototype", "constructor"].includes(value) ? value : invalid();
    const result = record(value, { owner: choice("shoggoth-memory-core", "legacy"),
      agents: list(value => record(value, { profileId: id, agentId: text(128), name: text(512) },
        ["profileId", "agentId", "name"]), 256) }, ["owner", "agents"]);
    if (new Set(result.agents.map(agent => agent.profileId)).size !== result.agents.length) invalid();
    return result;
  } catch { throw error("NATIVE_MEMORY_CONFIG_UNAVAILABLE"); }
}
module.exports = { NATIVE_MEMORY_CONFIG_METHODS, NATIVE_MEMORY_CONFIG_PUBLIC_MESSAGES,
  validateNativeMemoryConfigProjection, validateNativeMemoryConfigParams, validateNativeMemoryConfigResult,
  validateNativeMemoryModelAliases, validateNativeMemoryLocalModels, validateNativeMemoryRemoteHeaders, validateNativeMemoryProviderRefs,
  nativeMemoryConfigError: error };
