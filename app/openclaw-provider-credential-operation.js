"use strict";

// A Provider is one UI operation. Every mutation still belongs to an official
// auth handler. This function is also embedded in the owned, pinned SDK child;
// keep it self-contained and never include credential material in its result.
async function applyProviderCredentialOperation({ request, provider, agentIds, configuredConnection, clear, apiKey }) {
  const targets = !clear && configuredConnection ? agentIds.slice(0, 1) : agentIds;
  const applied = [], profileIds = new Set(), removedProfiles = new Set();
  let warned = false;
  const result = complete => ({ provider, credentialScope: "provider", complete, agentIds: applied,
    ...(clear ? { removedProfiles: [...removedProfiles] } : { profileId: [...profileIds][0], profileIds: [...profileIds] }),
    ...(warned ? { warning: "Saved; runtime refresh requires verification" } : {}) });
  if (!targets.length) return result(false);
  for (const agentId of targets) {
    let receipt;
    try {
      receipt = await request(clear ? "models.authLogout" : "models.authSetApiKey", {
        provider, agentId, ...(clear ? { credentialType: "api_key" } : { apiKey }),
      });
    } catch { return result(false); }
    if (receipt?.provider?.toLowerCase() !== provider.toLowerCase()
      || (clear ? !Array.isArray(receipt.removedProfiles)
        : typeof receipt.profileId !== "string" || !receipt.profileId)) return result(false);
    if (clear) {
      if (receipt.removedProfiles.some(id => typeof id !== "string" || !id)) return result(false);
      for (const id of receipt.removedProfiles) removedProfiles.add(id);
    } else profileIds.add(receipt.profileId);
    warned ||= typeof receipt.warning === "string" && Boolean(receipt.warning.trim());
    applied.push(agentId);
  }
  return result(true);
}

module.exports = { applyProviderCredentialOperation };
