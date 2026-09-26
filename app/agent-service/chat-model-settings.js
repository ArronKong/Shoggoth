"use strict";

const own = (value, key) => Object.getOwnPropertyDescriptor(value || {}, key)?.value;
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const level = value => typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/u.test(value);
const tier = value => value === null || ["fast", "priority"].includes(value);

function validModelSettings(value) {
  return plain(value) && Object.keys(value).length === 2
    && Object.hasOwn(value, "thinkingLevel") && Object.hasOwn(value, "serviceTier")
    && (value.thinkingLevel === null || level(value.thinkingLevel)) && tier(value.serviceTier);
}

function validModelSettingsPatch(value) {
  return plain(value) && Object.keys(value).length > 0
    && Object.keys(value).every(key => key === "thinkingLevel" || key === "fastMode")
    && (!Object.hasOwn(value, "thinkingLevel") || value.thinkingLevel === null || level(value.thinkingLevel))
    && (!Object.hasOwn(value, "fastMode") || typeof value.fastMode === "boolean");
}

function validModelCapabilities(value) {
  return plain(value) && Object.keys(value).length === 3
    && Array.isArray(value.thinkingOptions) && value.thinkingOptions.length <= 16
    && value.thinkingOptions.every(level) && new Set(value.thinkingOptions).size === value.thinkingOptions.length
    && (value.thinkingDefault === null || value.thinkingOptions.includes(value.thinkingDefault))
    && tier(value.fastTier);
}

// Preserve only capabilities advertised by the runtime; never infer speed or
// effort support from a model name. Hosts may supply the normalized shape.
function modelCapabilities(model) {
  const supplied = own(model, "capabilities");
  if (validModelCapabilities(supplied)) return structuredClone(supplied);
  const efforts = own(model, "supportedReasoningEfforts");
  const thinkingOptions = Array.isArray(efforts)
    ? [...new Set(efforts.map(option => own(option, "reasoningEffort")).filter(level))] : [];
  const advertisedDefault = own(model, "defaultReasoningEffort");
  const tiers = own(model, "serviceTiers");
  const legacyTiers = own(model, "additionalSpeedTiers");
  const ids = Array.isArray(tiers) && tiers.length > 0
    ? tiers.map(item => own(item, "id")) : Array.isArray(legacyTiers) ? legacyTiers : [];
  return { thinkingOptions,
    thinkingDefault: thinkingOptions.includes(advertisedDefault) ? advertisedDefault : null,
    fastTier: ids.includes("fast") ? "fast" : ids.includes("priority") ? "priority" : null };
}

module.exports = { modelCapabilities, validModelCapabilities, validModelSettings, validModelSettingsPatch };
