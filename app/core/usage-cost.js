"use strict";

// Public standard API rates, USD / 1M tokens, checked 2026-09-19.
// https://developers.openai.com/api/docs/pricing
// Estimates are never presented as a provider invoice or subscription charge.
const RATES = {
  "gpt-6-astra": [10, 1, 12.5, 50],
  "gpt-5.6-sol": [4, 0.4, 5, 20],
  "gpt-5.6-terra": [2, 0.2, 2.5, 12],
  "gpt-5.6-luna": [0.2, 0.02, 0.25, 1.2],
};

function validUsd(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function estimateUsageCost(model, parts, rates = RATES) {
  const key = typeof model === "string" ? model.toLowerCase().replace(/^openai\//u, "").replace(/-\d{4}-\d{2}-\d{2}$/u, "") : "";
  const rate = rates[key];
  if (!rate) return null;
  const fields = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"];
  if (fields.some(field => !Number.isFinite(parts[field] ?? 0) || (parts[field] ?? 0) < 0)) return null;
  // input/output here are exclusive of caches/reasoning respectively.
  const total = fields.reduce((sum, field, index) => sum + (parts[field] || 0) * rate[index], 0)
    + (parts.reasoningTokens || 0) * rate[3];
  return total / 1_000_000;
}

function resolveUsageCost(record, parts) {
  if (validUsd(record.costUsd)) return { cost: record.costUsd, estimated: false };
  const estimate = estimateUsageCost(record.model, parts);
  return { cost: estimate, estimated: estimate !== null };
}

module.exports = { estimateUsageCost, resolveUsageCost, validUsd };
