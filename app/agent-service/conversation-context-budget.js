"use strict";

// This is a product fallback, never a claim about an unidentified model.
const UNKNOWN_WINDOW_BUDGET = 1_000_000;
const validWindow = value => Number.isSafeInteger(value) && value > 0;

function conversationContextBudget(contextWindow, source = "runtime") {
  const known = validWindow(contextWindow);
  const tokens = known ? contextWindow : UNKNOWN_WINDOW_BUDGET;
  return Object.freeze({ tokens, source: known ? source : "fallback",
    triggerTokens: Math.max(1, Math.floor(tokens * 0.8)),
    retainedTokens: Math.max(1, Math.floor(tokens * 0.5)) });
}

// Local planning estimate only. CJK and other non-ASCII text must not be
// counted as English characters / 4. Native observations take precedence.
function estimateContextTokens(text) {
  let units = 0;
  for (const point of text) units += point.codePointAt(0) < 128 ? 1 : 8;
  return Math.ceil(units / 4);
}

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

module.exports = { UNKNOWN_WINDOW_BUDGET,
  validWindow, conversationContextBudget, estimateContextTokens, documentedModelWindow };
