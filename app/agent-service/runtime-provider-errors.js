"use strict";

// Classifies a provider failure into a public code. Only provider/CLI error
// text is inspected, never model output; the text itself stays in the Host.
const MAX_TEXT_BYTES = 1024 * 1024;
const QUOTA_PATTERN = /\b(?:insufficient_quota|usage balance exhausted|free usage exceeded|FreeUsageLimitError|GoUsageLimitError|quota (?:exceeded|exhausted)|usage limit reached)\b|\b402 Payment Required\b/iu;
// A bare "429" also appears in log timestamps; accept it only as a status code.
const RATE_PATTERN = /\brate[\s_-]*limit(?:ed|s)?\b|\btoo[\s_-]many[\s_-]requests\b|\bRESOURCE_EXHAUSTED\b|\b(?:status|code|http|error)["'\s:=]{0,4}429\b/iu;

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

module.exports = { classifyProviderLimit };
