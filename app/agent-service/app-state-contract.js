"use strict";

// One public read tool, shared by every runtime. Do not import stores here:
// MCP helpers load this contract only to advertise and validate the schema.
const APP_STATE_SECTIONS = Object.freeze([
  "overview", "service", "backends", "agents", "cron", "inspiration", "kanban",
  "runs", "sessions", "runtime_accounts", "models", "skills", "mcp", "plugins",
  "usage", "settings", "computer", "browser",
]);
const APP_STATE_HOST_SECTIONS = Object.freeze([
  "agents", "cron", "kanban", "runs", "sessions", "runtime_accounts", "models", "skills", "usage",
]);
const APP_STATE_MAX_LIMIT = 50;
const APP_STATE_PAGE_BYTES = 16 * 1024;
const APP_STATE_SOURCE_CODES = Object.freeze([
  "APP_HOST_UNAVAILABLE", "BACKEND_DISABLED", "BACKEND_DISCONNECTED",
  "APP_STATE_SOURCE_UNAVAILABLE", "APP_STATE_SOURCE_INCOMPLETE", "APP_STATE_HISTORY_WINDOW",
]);

function validAppStateArguments(value, sections = APP_STATE_SECTIONS) {
  return value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === 3
    && sections.includes(value.section)
    && (value.cursor === null || typeof value.cursor === "string"
      && /^[a-f0-9]{32}:[0-9]{1,8}$/u.test(value.cursor))
    && Number.isSafeInteger(value.limit) && value.limit >= 1 && value.limit <= APP_STATE_MAX_LIMIT
    && (value.section !== "overview" || value.cursor === null);
}

const HOST_ITEM_FIELDS = Object.freeze({
  agents: ["backendId", "agentId", "name", "kind", "connected", "enabled", "isDefault", "model", "provider"],
  cron: ["revision", "id", "backendId", "agentId", "name", "enabled", "status", "stateLabel", "schedule", "model", "provider", "createdAt", "lastRunAt", "nextRunAt", "lastStatus", "hasError"],
  kanban: ["revision", "type", "id", "boardId", "backendId", "name", "title", "agentId", "status", "priority", "archived", "createdAt", "updatedAt", "runId", "runStatus"],
  sessions: ["id", "backendId", "agentId", "title", "model", "status", "createdAt", "updatedAt"],
  runs: ["id", "backendId", "kind", "agentId", "sessionKey", "jobId", "status", "runtime", "title", "createdAt", "startedAt", "finishedAt"],
  runtime_accounts: ["type", "id", "backendId", "version", "connected", "runtime", "name", "runtimeAccountId", "installation", "releaseEnabled", "enabled", "serviceConnected"],
  models: ["type", "id", "backendId", "name", "provider", "source", "contextWindow", "maxTokens"],
  skills: ["id", "backendId", "name", "source", "version", "enabled", "eligible"],
  usage: ["backendId", "range", "availability", "totalTokens", "totalCost", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "missingCostEntries", "estimatedCostEntries"],
});
function validateAppStateHostResult(result, args) {
  const expected = ["section", "sampledAt", "scope", "available", "complete", "total", "knownTotal", "summary", "unavailableSources", "items", "nextCursor", "hasMore"];
  if (!result || Object.getPrototypeOf(result) !== Object.prototype || Object.keys(result).length !== expected.length
    || expected.some(key => !Object.hasOwn(result, key)) || !APP_STATE_HOST_SECTIONS.includes(result.section)
    || args && result.section !== args.section || result.scope !== "app"
    || !Number.isSafeInteger(result.sampledAt) || result.sampledAt < 0
    || typeof result.available !== "boolean" || typeof result.complete !== "boolean"
    || !Number.isSafeInteger(result.knownTotal) || result.knownTotal < 0
    || result.total !== (result.complete ? result.knownTotal : null)
    || !Array.isArray(result.items) || result.items.length > (args?.limit ?? APP_STATE_MAX_LIMIT)
    || result.items.length > result.knownTotal || typeof result.hasMore !== "boolean"
    || result.hasMore !== (result.nextCursor !== null)
    || !validAppStateArguments({ section: result.section, cursor: result.nextCursor, limit: 1 }, APP_STATE_HOST_SECTIONS)
    || !result.summary || Object.getPrototypeOf(result.summary) !== Object.prototype
    || !Array.isArray(result.unavailableSources) || result.unavailableSources.length > 128
    || result.complete !== (result.unavailableSources.length === 0)) return false;
  if (!result.unavailableSources.every(row => row && Object.keys(row).length === 2
    && typeof row.source === "string" && row.source.length <= 128 && APP_STATE_SOURCE_CODES.includes(row.code))) return false;
  const summaryFields = { agents: ["configured", "connected", "connectionUnknown", "native", "external"],
    cron: ["enabled", "disabled", "byStatus"], kanban: ["boards", "cards", "archived", "byStatus"],
    sessions: ["byStatus"], runs: ["byStatus", "externalHistory", "historyLimitPerBackend"],
    runtime_accounts: [], models: ["models", "providers"], skills: ["enabled", "globalEnabled"], usage: ["range"] };
  if (Object.keys(result.summary).some(key => !summaryFields[result.section].includes(key))) return false;
  if (!Object.entries(result.summary).every(([key, value]) => key === "byStatus" ? value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length <= 33 && Object.entries(value).every(([status, count]) => Buffer.byteLength(status) <= 128 && Number.isSafeInteger(count) && count >= 0)
    : key === "range" ? value === "30d" : key === "externalHistory" ? value === "recent_cron_and_live_work" : Number.isSafeInteger(value) && value >= 0)) return false;
  return result.items.every(row => row && Object.getPrototypeOf(row) === Object.prototype
    && Object.keys(row).every(key => HOST_ITEM_FIELDS[result.section].includes(key))
    && typeof row.backendId === "string" && row.backendId.length <= 128
    && (result.section === "usage" || typeof (result.section === "agents" ? row.agentId : row.id) === "string")
    && Object.values(row).every(value => value === null || typeof value === "boolean"
      || typeof value === "number" && Number.isFinite(value)
      || typeof value === "string" && Buffer.byteLength(value) <= 512));
}

module.exports = {
  APP_STATE_SECTIONS, APP_STATE_HOST_SECTIONS, APP_STATE_MAX_LIMIT, APP_STATE_PAGE_BYTES,
  APP_STATE_SOURCE_CODES, validAppStateArguments, validateAppStateHostResult,
};
