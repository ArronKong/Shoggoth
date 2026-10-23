"use strict";

// Pure MCP contracts: the helper must not load Service stores or schedulers.
const HEARTBEAT_SETTINGS_TOOL_NAMES = new Set(["heartbeat_settings_get", "heartbeat_settings_set"]);
const HEARTBEAT_SETTINGS_CAPABILITIES = [
  { domain: "proactive", feature: "settings-read", tool: "heartbeat_settings_get", risk: "read",
    description: "Read this native Agent's saved heartbeat settings, revision, resolved time zone, next check and current Runtime capability. Read before a change. Settings are shared with the Agent settings page and persist across chats and restarts. A saved enabled setting does not prove Runtime readiness or that a check has executed." },
  { domain: "proactive", feature: "settings-update", tool: "heartbeat_settings_set", risk: "write",
    description: "Apply the user's requested change to this native Agent's heartbeat settings. First heartbeat_settings_get; supply its revision as expectedRevision. config is a partial patch; omitted fields stay unchanged. Supports enabled, intervalMinutes, maxRunsPerDay (1..48), maxTokensPerDay (1024..10000000), timezone (system follows the computer, or an IANA zone), activeHours ({start,end} HH:mm, or null to disable) and push (system notifications). Saves to the same configuration as the settings page without changing HEARTBEAT.md rules, working notes, scopes, delivery targets, other Agents or defaults for new Agents. Runtime readiness still gates execution. On a conflict or unknown outcome, read back before another mutation; never edit internal storage files." },
];
const MINUTE_MS = 60_000;
const MAX_INTERVAL_MINUTES = Math.floor(Number.MAX_SAFE_INTEGER / MINUTE_MS);
const timeSchema = { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" };
const configSchema = { type: "object", additionalProperties: false, minProperties: 1, properties: {
  enabled: { type: "boolean" },
  intervalMinutes: { type: "integer", minimum: 1, maximum: MAX_INTERVAL_MINUTES },
  maxRunsPerDay: { type: "integer", minimum: 1, maximum: 48 },
  maxTokensPerDay: { type: "integer", minimum: 1024, maximum: 10_000_000 },
  timezone: { type: "string", minLength: 1, maxLength: 128, description: "system follows the computer; otherwise a valid IANA time zone." },
  activeHours: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false,
    required: ["start", "end"], properties: { start: timeSchema, end: timeSchema } }] },
  push: { type: "boolean" },
} };
const HEARTBEAT_SETTINGS_TOOL_DEFINITIONS = HEARTBEAT_SETTINGS_CAPABILITIES.map(({ tool: name }) => ({ name,
  inputSchema: name === "heartbeat_settings_get" ? { type: "object", additionalProperties: false, properties: {} }
    : { type: "object", additionalProperties: false, required: ["expectedRevision", "config"], properties: {
      expectedRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, config: configSchema,
    } },
}));
function dataObject(value) {
  return !!value && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).every(key => typeof key === "string" && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"));
}
const exact = (value, keys) => dataObject(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
function validTimezone(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !value.isWellFormed()) return false;
  if (value === "system") return true;
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}
const validators = {
  enabled: value => typeof value === "boolean",
  intervalMinutes: value => integer(value, 1, MAX_INTERVAL_MINUTES),
  maxRunsPerDay: value => integer(value, 1, 48),
  maxTokensPerDay: value => integer(value, 1024, 10_000_000),
  timezone: validTimezone,
  activeHours: value => value === null || exact(value, ["start", "end"])
    && [value.start, value.end].every(time => typeof time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time))
    && value.start !== value.end,
  push: value => typeof value === "boolean",
};
function validateHeartbeatSettingsArguments(name, args) {
  if (!HEARTBEAT_SETTINGS_TOOL_NAMES.has(name)) return false;
  if (name === "heartbeat_settings_get") return exact(args, []);
  return exact(args, ["expectedRevision", "config"]) && integer(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER)
    && dataObject(args.config) && Object.keys(args.config).length > 0
    && Object.keys(args.config).every(key => Object.hasOwn(validators, key) && validators[key](args.config[key]));
}
module.exports = { HEARTBEAT_SETTINGS_TOOL_NAMES, HEARTBEAT_SETTINGS_CAPABILITIES,
  HEARTBEAT_SETTINGS_TOOL_DEFINITIONS, validateHeartbeatSettingsArguments };
