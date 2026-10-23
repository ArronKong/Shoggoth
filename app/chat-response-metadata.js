"use strict";

// Public presentation facts only. Runtime/account/session identities never leave
// the owner-scoped lookup that produces this bounded snapshot.
const count = value => Number.isSafeInteger(value) && value >= 0;
const modelId = value => typeof value === "string" && value.length > 0 && value.isWellFormed()
  && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 512;
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const USAGE_KEYS = ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens", "totalTokens"];

function validResponseMetadata(value) {
  return plain(value) && Object.keys(value).every(key => ["models", "modelSource", "usage", "context"].includes(key))
    && Object.keys(value).length > 0
    && (!Object.hasOwn(value, "models") || Array.isArray(value.models) && value.models.length > 0
      && value.models.length <= 16 && value.models.every(modelId) && new Set(value.models).size === value.models.length)
    && (!Object.hasOwn(value, "modelSource") || value.models && ["reported", "selected"].includes(value.modelSource))
    && (!Object.hasOwn(value, "usage") || plain(value.usage)
      && Object.keys(value.usage).every(key => USAGE_KEYS.includes(key))
      && Object.keys(value.usage).length > 0 && Object.values(value.usage).every(count))
    && (!Object.hasOwn(value, "context") || plain(value.context)
      && Object.keys(value.context).sort().join(",") === "quality,usedTokens,windowTokens"
      && ["exact", "estimated"].includes(value.context.quality) && count(value.context.usedTokens)
      && count(value.context.windowTokens) && value.context.windowTokens > 0)
    && Buffer.byteLength(JSON.stringify(value), "utf8") <= 12 * 1024;
}

function nativeResponseMetadata({ records = [], selectedModel = null, context = null } = {}) {
  const result = {};
  const models = [...new Set(records.map(record => record.model).filter(modelId))].slice(0, 16);
  if (models.length) Object.assign(result, { models, modelSource: "reported" });
  else if (modelId(selectedModel)) Object.assign(result, { models: [selectedModel], modelSource: "selected" });
  if (records.length) {
    const usage = Object.fromEntries(USAGE_KEYS.map(key => [key, records.reduce((sum, record) => sum + record[key], 0)]));
    if (Object.values(usage).every(count)) result.usage = usage;
  }
  if (["exact", "estimated"].includes(context?.quality) && count(context.usedTokens)
    && count(context.contextWindow) && context.contextWindow > 0) {
    result.context = { usedTokens: context.usedTokens, windowTokens: context.contextWindow, quality: context.quality };
  }
  return validResponseMetadata(result) ? result : null;
}

// Gateway histories report response-local fields, with caches as their own
// components. Callers must first isolate the exact execution's final response.
function gatewayResponseMetadata(message) {
  if (!plain(message) || message.role !== "assistant") return null;
  const result = {};
  if (modelId(message.model)) Object.assign(result, { models: [message.model], modelSource: "reported" });
  const raw = message.usage;
  if (plain(raw)) {
    const fields = { inputTokens: raw.input ?? raw.inputTokens, outputTokens: raw.output ?? raw.outputTokens,
      cachedInputTokens: raw.cacheRead, cacheWriteInputTokens: raw.cacheWrite, totalTokens: raw.totalTokens };
    const usage = Object.fromEntries(Object.entries(fields).filter(([, value]) => count(value)));
    if (Object.keys(usage).length) result.usage = usage;
    if (count(raw.contextUsed) && count(raw.contextMax) && raw.contextMax > 0) {
      result.context = { usedTokens: raw.contextUsed, windowTokens: raw.contextMax, quality: "exact" };
    }
  }
  return validResponseMetadata(result) ? result : null;
}

module.exports = { validResponseMetadata, nativeResponseMetadata, gatewayResponseMetadata };
