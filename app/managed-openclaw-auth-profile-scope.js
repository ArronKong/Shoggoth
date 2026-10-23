"use strict";

const { createHash } = require("node:crypto");
const { readCanonicalAgentEntries } = require("./core/openclaw-agent-config");
const constants = require("./managed-openclaw-auth-profile-constants");
const { NATIVE_AUTH_API } = constants;

function nativeAuthAgentIds(config) {
  const ids = readCanonicalAgentEntries(config).map(agent => agent.id);
  if (!ids.length) return ["main"];
  return ids.includes("main") ? ["main", ...ids.filter(id => id !== "main")] : ids;
}

function resolveNativeAuthAgent(spec, config) {
  const ids = readCanonicalAgentEntries(config).map(agent => agent.id);
  const selected = spec.agentId || (ids.includes("main") ? "main" : ids[0]) || "main";
  const canonical = ids.find(id => id.toLowerCase() === selected.toLowerCase());
  if (ids.length && !canonical) throw Object.assign(new Error("auth_agent_not_found"), { code: "auth_agent_not_found" });
  return canonical || selected;
}

/** Ciphertext identity follows official auth scope, independently of endpoints. */
function nativeAuthProviderScope(spec, config) {
  const provider = spec.patch?.renameTo || spec.providerKey;
  const createsConnection = spec.kind === "save-provider" || spec.kind === "create" && spec.providerMode === "new";
  const shared = Object.keys(config.models?.providers || {}).some(key => key.toLowerCase() === spec.providerKey.toLowerCase()) || createsConnection;
  const identity = spec.credentialScope === "provider" ? [provider.toLowerCase(), "provider"]
    : shared ? [provider.toLowerCase(), "shared"] : [provider.toLowerCase(), "agent", resolveNativeAuthAgent(spec, config).toLowerCase()];
  const providerKey = "@auth." + createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return Object.freeze({ backendId: "openclaw", providerKey, baseUrl: null, api: NATIVE_AUTH_API });
}

module.exports = { ...constants, resolveNativeAuthAgent, nativeAuthAgentIds, nativeAuthProviderScope };
