"use strict";
const p = require("./web-settings-protocol");
const WEB_PREFERENCE_TOOL_NAMES = new Set(["web_settings_get", "web_settings_set", "web_defaults_set"]);
const WEB_PREFERENCE_CAPABILITIES = [
  { domain: "web", feature: "settings-read", tool: "web_settings_get", risk: "read", description: "Read this native Agent's web provider overrides, shared defaults, effective search/fetch choices and API-key configured status. No keys are returned. Read before changing settings; agent.revision guards own overrides and defaults.revision guards shared defaults. null overrides inherit the shared default per capability." },
  { domain: "web", feature: "settings-update", tool: "web_settings_set", risk: "write", description: "Persist this native Agent's own web provider preferences across chats and restarts. First web_settings_get; use agent.revision as expectedRevision. config is a partial patch: omitted fields stay unchanged, null restores inheritance. Applies to subsequent web_search/web_fetch and this Agent's HEARTBEAT. API keys stay shared and can only be configured in Settings UI. Never change another Agent's preferences. On conflict or unknown outcome, read back before a new call." },
  { domain: "web", feature: "defaults-update", tool: "web_defaults_set", risk: "confirm", description: "Change shared web provider defaults after user confirmation. First web_settings_get; use defaults.revision as expectedRevision. config is a partial patch; omitted fields stay unchanged. Affects all native Agents and HEARTBEAT checks that inherit each default; explicit Agent overrides remain unchanged. Search: Exa/Brave/Tavily/TinyFish; fetch: direct/Exa/Tavily/TinyFish. Does not change API keys. On conflict or unknown outcome, read back before a new call." },
];
const provider = values => ({ type: "string", enum: values });
const patchSchema = inherit => ({ type: "object", additionalProperties: false, minProperties: 1, maxProperties: 2,
  properties: Object.fromEntries([["searchProvider", p.PROVIDERS], ["fetchProvider", p.FETCH_PROVIDERS]]
    .map(([key, values]) => [key, inherit ? { anyOf: [provider(values), { type: "null" }] } : provider(values)])) });
const WEB_PREFERENCE_TOOL_DEFINITIONS = WEB_PREFERENCE_CAPABILITIES.map(({ tool: name }) => ({ name,
  inputSchema: name === "web_settings_get" ? { type: "object", additionalProperties: false, properties: {} }
    : { type: "object", additionalProperties: false, required: ["expectedRevision", "config"], properties: {
      expectedRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      config: patchSchema(name === "web_settings_set"),
    } },
}));
function validPatch(value, inherit) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const fields = Object.getOwnPropertyDescriptors(value), keys = Object.keys(fields);
  return keys.length > 0 && keys.length <= 2 && keys.every(key => {
    if (!Object.hasOwn(fields[key], "value")) return false;
    const providers = key === "searchProvider" ? p.PROVIDERS : key === "fetchProvider" ? p.FETCH_PROVIDERS : null;
    return providers !== null && (providers.includes(fields[key].value) || inherit && fields[key].value === null);
  });
}
function validateWebPreferenceArguments(name, args) {
  if (!WEB_PREFERENCE_TOOL_NAMES.has(name)) return false;
  if (name === "web_settings_get") return p.exact(args, []);
  return p.exact(args, ["expectedRevision", "config"]) && p.revision(args.expectedRevision)
    && validPatch(args.config, name === "web_settings_set");
}
function agentConfig(value) {
  if (!p.exact(value, ["searchProvider", "fetchProvider"]) || !validPatch(value, true)) p.fail();
  return { searchProvider: value.searchProvider, fetchProvider: value.fetchProvider };
}
module.exports = { WEB_PREFERENCE_TOOL_NAMES, WEB_PREFERENCE_TOOL_DEFINITIONS, WEB_PREFERENCE_CAPABILITIES,
  validateWebPreferenceArguments, agentConfig };
