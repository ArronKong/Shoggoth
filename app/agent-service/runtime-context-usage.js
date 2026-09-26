"use strict";

const CONTEXT_CAPABILITY_KEYS = Object.freeze([
  "context.usage.exact", "context.usage.estimated", "context.compact.native", "context.compact.auto",
]);
const usageFields = ["runtimeSessionId", "usedTokens", "contextWindow", "quality", "source", "observedAt"];
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
function invalid() { throw Object.assign(new Error("Runtime context projection is invalid"), { code: "RUNTIME_CONTEXT_INVALID" }); }
function dataObject(value, fields) {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== fields.length
    || fields.some((field) => !descriptors[field] || !Object.hasOwn(descriptors[field], "value"))) invalid();
  return Object.fromEntries(fields.map((field) => [field, descriptors[field].value]));
}
function validateRuntimeContextUsage(value) {
  const item = dataObject(value, usageFields);
  if (typeof item.runtimeSessionId !== "string" || item.runtimeSessionId.length === 0
    || item.runtimeSessionId.length > 512 || !item.runtimeSessionId.isWellFormed() || item.runtimeSessionId.includes("\0")
    || (item.usedTokens !== null && !integer(item.usedTokens))
    || (item.contextWindow !== null && !integer(item.contextWindow, 1))
    || !["exact", "estimated", "unknown"].includes(item.quality)
    || !["runtime_event", "session_stats", "estimate"].includes(item.source)
    || !integer(item.observedAt) || (item.quality === "unknown") !== (item.usedTokens === null)) invalid();
  return Object.freeze(item);
}
function validateRuntimeContextCapabilities(value) {
  const item = dataObject(value, CONTEXT_CAPABILITY_KEYS);
  if (Object.values(item).some((value) => typeof value !== "boolean")) invalid();
  return Object.freeze(item);
}
function runtimeContextCapabilities(runtime) {
  return validateRuntimeContextCapabilities({
    "context.usage.exact": runtime === "codex" || runtime === "grok-build",
    "context.usage.estimated": ["pi", "claude-code", "deepseek-harness"].includes(runtime),
    "context.compact.native": runtime === "codex" || runtime === "pi",
    // Capability describes what the CLI supports, not a guarantee that the
    // user's CLI configuration currently enables automatic compaction.
    "context.compact.auto": runtime === "codex" || runtime === "pi",
  });
}
function unknownRuntimeContextUsage(runtimeSessionId, { contextWindow = null, observedAt = Date.now(), source = "runtime_event" } = {}) {
  return validateRuntimeContextUsage({ runtimeSessionId, usedTokens: null,
    contextWindow: integer(contextWindow, 1) ? contextWindow : null, quality: "unknown", source, observedAt });
}
function codexRuntimeContextUsage(sessionId, event, observedAt = Date.now()) {
  const usedTokens = integer(event.contextUsedTokens) ? event.contextUsedTokens : null;
  return validateRuntimeContextUsage({ runtimeSessionId: sessionId, usedTokens,
    contextWindow: integer(event.modelContextWindow, 1) ? event.modelContextWindow : null,
    quality: usedTokens === null ? "unknown" : "exact", source: "runtime_event", observedAt });
}
function piRuntimeContextUsage(sessionId, stats, contextWindow, observedAt = Date.now(), messages = null) {
  // stats.tokens is cumulative billing usage in both supported Pi generations.
  // Only newer versions expose current contextUsage; older versions stay unknown.
  const current = stats?.contextUsage;
  const usedTokens = integer(current?.tokens) ? current.tokens : Array.isArray(messages)
    ? Math.ceil(Buffer.byteLength(JSON.stringify(messages), "utf8") / 3) : null;
  return validateRuntimeContextUsage({ runtimeSessionId: sessionId, usedTokens,
    contextWindow: integer(contextWindow, 1) ? contextWindow : null,
    quality: usedTokens === null ? "unknown" : "estimated",
    source: !integer(current?.tokens) && Array.isArray(messages) ? "estimate" : "session_stats", observedAt });
}

function claudeRuntimeContextUsage(sessionId, usage, contextWindow, observedAt = Date.now()) {
  const keys = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"];
  // One assistant response describes one model request. modelUsage on the
  // terminal result aggregates the whole run and must never be its numerator.
  const values = keys.map(key => usage?.[key] ?? (key.startsWith("cache_") ? 0 : null));
  const sum = values.every(value => integer(value)) ? values.reduce((total, value) => total + value, 0) : null;
  const usedTokens = integer(sum) ? sum : null;
  return validateRuntimeContextUsage({ runtimeSessionId: sessionId, usedTokens,
    contextWindow: integer(contextWindow, 1) ? contextWindow : null,
    quality: usedTokens === null ? "unknown" : "estimated", source: "runtime_event", observedAt });
}

module.exports = { CONTEXT_CAPABILITY_KEYS, validateRuntimeContextUsage, validateRuntimeContextCapabilities,
  runtimeContextCapabilities, unknownRuntimeContextUsage, codexRuntimeContextUsage, piRuntimeContextUsage,
  claudeRuntimeContextUsage };
