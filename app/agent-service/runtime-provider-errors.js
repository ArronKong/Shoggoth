"use strict";

// Classifies a provider failure into a public code. Only provider/CLI error
// text is inspected, never model output; the text itself stays in the Host.
const MAX_TEXT_BYTES = 1024 * 1024;
const QUOTA_PATTERN = /\b(?:insufficient_quota|usage balance exhausted|free usage exceeded|FreeUsageLimitError|GoUsageLimitError|quota (?:exceeded|exhausted)|usage limit reached)\b|\b402 Payment Required\b/iu;
// A bare "429" also appears in log timestamps; accept it only as a status code.
const RATE_PATTERN = /\brate[\s_-]*limit(?:ed|s)?\b|\btoo[\s_-]many[\s_-]requests\b|\bRESOURCE_EXHAUSTED\b|\b(?:status|code|http|error)["'\s:=]{0,4}429\b/iu;
const SETTINGS_PATTERN = /\b(?:unsupported(?:_value)?|invalid|not supported)\b[^\r\n]{0,512}\b(?:reasoning[._ -]effort|model_reasoning_effort|service_tier)\b|\b(?:reasoning[._ -]effort|model_reasoning_effort|service_tier)\b[^\r\n]{0,256}\b(?:unsupported|invalid|not supported)\b/iu;
const MODEL_PATTERN = /\b(?:model_not_found|unsupported_model)\b|\bmodel\b[^\r\n]{0,256}\b(?:not supported|does not exist|not found|not available|unavailable)\b/iu;
const CAPACITY_PATTERN = /\bserver[_ -]?overloaded\b|\bselected model\b[^\r\n]{0,128}\bat capacity\b|\b(?:service|server)\b[^\r\n]{0,80}\b(?:overloaded|temporarily unavailable)\b/iu;

function classifyProviderLimit(...texts) {
  let rateLimited = false;
  for (const text of texts) {
    if (typeof text !== "string" || text.length === 0
      || Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) continue;
    if (QUOTA_PATTERN.test(text)) return "RUNTIME_QUOTA_EXHAUSTED";
    if (RATE_PATTERN.test(text)) rateLimited = true;
  }
  return rateLimited ? "RUNTIME_RATE_LIMITED" : null;
}

function classifyProviderFailure(...texts) {
  const limit = classifyProviderLimit(...texts);
  if (limit) return limit;
  const bounded = texts.filter(text => typeof text === "string" && text.length > 0
    && Buffer.byteLength(text, "utf8") <= MAX_TEXT_BYTES);
  // Settings errors can mention the model as well; preserve the actionable cause.
  if (bounded.some(text => SETTINGS_PATTERN.test(text))) return "RUNTIME_MODEL_SETTINGS_INVALID";
  if (bounded.some(text => MODEL_PATTERN.test(text))) return "RUNTIME_MODEL_UNAVAILABLE";
  if (bounded.some(text => CAPACITY_PATTERN.test(text))) return "RUNTIME_UPSTREAM_UNAVAILABLE";
  return null;
}

module.exports = { classifyProviderFailure, classifyProviderLimit };
