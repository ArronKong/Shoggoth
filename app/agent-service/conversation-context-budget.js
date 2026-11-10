"use strict";

// This is a product fallback, never a claim about an unidentified model.
// The user set it to 500K on 2026-10-22 (previously 1M).
const UNKNOWN_WINDOW_BUDGET = 500_000;
// A product summary keeps at most this much recent original text; older text
// stays reachable through conversation_search/conversation_get (2026-10-22,
// previously half the window).
const RETAINED_TAIL_TOKENS = 24_000;
const validWindow = value => Number.isSafeInteger(value) && value > 0;

function conversationContextBudget(contextWindow, source = "runtime") {
  const known = validWindow(contextWindow);
  const tokens = known ? contextWindow : UNKNOWN_WINDOW_BUDGET;
  return Object.freeze({ tokens, source: known ? source : "fallback",
    triggerTokens: Math.max(1, Math.floor(tokens * 0.8)),
    retainedTokens: Math.max(1, Math.min(Math.floor(tokens * 0.5), RETAINED_TAIL_TOKENS)) });
}

// Local planning estimate only. CJK and other non-ASCII text must not be
// counted as English characters / 4. Native observations take precedence.
// A non-ASCII code point counts as 1.5 tokens (2 until 2026-11-10): current
// tokenizers produce about one token per Chinese character, so 2 compacted
// Chinese conversations at roughly half of the window they could use.
const TOKEN_UNITS = 4, WIDE_CODE_POINT_UNITS = 6;
const codePointUnits = point => point.codePointAt(0) < 128 ? 1 : WIDE_CODE_POINT_UNITS;
function estimateContextTokens(text) {
  let units = 0;
  for (const point of text) units += codePointUnits(point);
  return Math.ceil(units / TOKEN_UNITS);
}
// The same estimate for one code point, for a caller that fills a budget
// character by character.
function estimateCodePointTokens(point) { return codePointUnits(point) / TOKEN_UNITS; }

function documentedModelWindow(runtime, model) {
  // Verified 2026-09-24: https://developers.openai.com/api/docs/models/compare
  const gptModels = ["gpt-6-sol", "gpt-6-luna", "gpt-6-astra"];
  if ((runtime === "codex" && gptModels.includes(model)) || (runtime === "pi"
    && gptModels.some(id => model === `openai/${id}` || model === `openai-codex/${id}`))) return 1_050_000;
  // Verified 2026-09-24: https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash
  // Input 1,048,576; output 65,536. This is a labeled planning fallback,
  // not evidence of the CLI's active window. Match exact supported routes.
  return runtime === "antigravity" && ["gemini-3.8-flash", "gemini-3.8-flash-high",
    "gemini-3.8-flash-medium", "gemini-3.8-flash-low"].includes(model) ? 1_048_576 : null;
}

module.exports = { UNKNOWN_WINDOW_BUDGET, RETAINED_TAIL_TOKENS,
  validWindow, conversationContextBudget, estimateContextTokens, estimateCodePointTokens, documentedModelWindow };
