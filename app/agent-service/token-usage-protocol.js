"use strict";

const USAGE_RANGES = new Set(["today", "7d", "30d", "90d", "1y", "all"]);
const MAX_USAGE_RESULT_BYTES = 60 * 1024;
const PART_FIELDS = Object.freeze([
  "totalTokens", "totalCost", "inputTokens", "outputTokens",
  "cacheReadTokens", "cacheWriteTokens", "reasoningTokens",
]);
const BACKEND_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function boundedString(value, maxBytes = 512, nullable = false) {
  return (nullable && value === null) || (typeof value === "string" && value.length > 0
    && value.isWellFormed() && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= maxBytes);
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validCost(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

function validParts(value, extraFields = []) {
  const fields = [...extraFields, ...PART_FIELDS];
  if (!exactObject(value, fields) && !(extraFields.includes("missingCostEntries")
    && exactObject(value, [...fields, "estimatedCostEntries"]) && validCount(value.estimatedCostEntries))) return false;
  return validCount(value.totalTokens) && validCost(value.totalCost)
    && ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"]
      .every((field) => validCount(value[field]));
}

function validateUsageRange(value, fallback = "30d") {
  if (value === undefined || value === null || value === "") return fallback;
  if (!USAGE_RANGES.has(value)) {
    const error = new Error("Token usage range 无效");
    error.code = "INVALID_PARAMS";
    throw error;
  }
  return value;
}

function assertBounded(value, label) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw new TypeError(`invalid ${label}`); }
  if (Buffer.byteLength(serialized, "utf8") > MAX_USAGE_RESULT_BYTES) {
    throw new TypeError(`${label} too large`);
  }
}

function validateUsageSeries(series) {
  if ((!exactObject(series, ["daily", "totals"]) && !exactObject(series, ["daily", "totals", "availability"]))
    || (series.availability !== undefined && !["complete", "partial", "unavailable"].includes(series.availability))
    || !Array.isArray(series.daily)
    || !validParts(series.totals, ["missingCostEntries"])
    || !validCount(series.totals.missingCostEntries)) {
    throw new TypeError("invalid usage series");
  }
  for (const row of series.daily) {
    if (!validParts(row, ["date"]) || !validDate(row.date)) {
      throw new TypeError("invalid usage daily row");
    }
  }
  assertBounded(series, "usage series");
  return structuredClone(series);
}

function validateUsageBreakdown(breakdown) {
  const baseFields = [
    "byModel", "byAgent", "bySource", "totals", "modelDaily", "topSessions", "sourceKind",
  ];
  const activityFields = ["tools", "messages", "dailyActivity"];
  const hasActivity = exactObject(breakdown, [...baseFields, ...activityFields]);
  if ((!exactObject(breakdown, baseFields) && !hasActivity)
    || !Array.isArray(breakdown.byModel) || !Array.isArray(breakdown.byAgent)
    || !Array.isArray(breakdown.bySource) || !Array.isArray(breakdown.modelDaily)
    || !Array.isArray(breakdown.topSessions) || breakdown.sourceKind !== "agent"
    || !validParts(breakdown.totals, ["missingCostEntries"])
    || !validCount(breakdown.totals.missingCostEntries)) {
    throw new TypeError("invalid usage breakdown");
  }
  for (const row of breakdown.byModel) {
    if (!validParts(row, ["model", "provider", "count"])
      || !boundedString(row.model) || !boundedString(row.provider, 512, true)
      || !validCount(row.count)) throw new TypeError("invalid usage model row");
  }
  for (const row of breakdown.byAgent) {
    if (!validParts(row, ["agentId"]) || !boundedString(row.agentId, 128)) {
      throw new TypeError("invalid usage agent row");
    }
  }
  for (const row of breakdown.bySource) {
    if (!validParts(row, ["id", "label", "kind", "backendId", "profile", "model", "provider"])
      || !boundedString(row.id, 128) || !boundedString(row.label)
      || row.kind !== "agent" || !boundedString(row.backendId, 64)
      || !BACKEND_ID_PATTERN.test(row.backendId)
      || !boundedString(row.profile, 128) || !boundedString(row.model, 512, true)
      || !boundedString(row.provider, 512, true)) {
      throw new TypeError("invalid usage source row");
    }
  }
  for (const row of breakdown.modelDaily) {
    if (!exactObject(row, ["date", "model", "provider", "tokens", "cost"])
      || !validDate(row.date) || !boundedString(row.model)
      || !boundedString(row.provider, 512, true) || !validCount(row.tokens)
      || !validCost(row.cost)) throw new TypeError("invalid usage model daily row");
  }
  for (const row of breakdown.topSessions) {
    if (!exactObject(row, [
      "key", "label", "sessionId", "agentId", "model", "models",
      "totalTokens", "totalCost", "updatedAt",
    ]) || !boundedString(row.key, 512) || !boundedString(row.label)
      || !boundedString(row.sessionId, 512) || !boundedString(row.agentId, 128)
      || !boundedString(row.model, 512, true) || !Array.isArray(row.models)
      || !validCount(row.totalTokens) || !validCost(row.totalCost)
      || !validCount(row.updatedAt) || row.models.some((entry) => (
        !exactObject(entry, ["model", "tokens"]) || !boundedString(entry.model)
        || !validCount(entry.tokens)
      ))) throw new TypeError("invalid usage top session row");
  }
  if (hasActivity) {
    if (!exactObject(breakdown.tools, ["totalCalls", "uniqueTools", "tools"])
      || !validCount(breakdown.tools.totalCalls) || !validCount(breakdown.tools.uniqueTools)
      || !Array.isArray(breakdown.tools.tools)
      || breakdown.tools.uniqueTools < breakdown.tools.tools.length
      || breakdown.tools.tools.some((row) => !exactObject(row, ["name", "count"])
        || !boundedString(row.name) || !validCount(row.count))) {
      throw new TypeError("invalid usage tools");
    }
    const listedCalls = breakdown.tools.tools.reduce((sum, row) => sum + row.count, 0);
    if (listedCalls > breakdown.tools.totalCalls
      || !exactObject(breakdown.messages, ["total", "user", "assistant", "toolCalls", "errors"])
      || !Object.values(breakdown.messages).every(validCount)
      || breakdown.messages.toolCalls !== breakdown.tools.totalCalls
      || !Array.isArray(breakdown.dailyActivity)
      || breakdown.dailyActivity.some((row) => !exactObject(row, [
        "date", "messages", "toolCalls", "errors", "tokens", "cost",
      ]) || !validDate(row.date) || !validCount(row.messages) || !validCount(row.toolCalls)
        || !validCount(row.errors) || !validCount(row.tokens) || !validCost(row.cost))) {
      throw new TypeError("invalid usage activity");
    }
  }
  assertBounded(breakdown, "usage breakdown");
  return structuredClone(breakdown);
}

function validateTokenUsageSummary(value) {
  if (!exactObject(value, ["series", "breakdown"])) throw new TypeError("invalid usage summary");
  return {
    series: validateUsageSeries(value.series),
    breakdown: validateUsageBreakdown(value.breakdown),
  };
}

module.exports = {
  MAX_USAGE_RESULT_BYTES,
  PART_FIELDS,
  USAGE_RANGES,
  validateTokenUsageSummary,
  validateUsageBreakdown,
  validateUsageRange,
  validateUsageSeries,
};
