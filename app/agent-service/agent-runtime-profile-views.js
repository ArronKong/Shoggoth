"use strict";

// Identity remains the Profile. These views are only for locating an execution
// resource, including a non-default Binding owned by that Profile.
function agentRuntimeProfileViews(productStore, profileId = null) {
  const profiles = profileId ? [productStore.getAgentProfile(profileId)].filter(Boolean)
    : productStore.listAgentProfiles();
  return profiles.flatMap((profile) => {
    if (typeof productStore.getAgentRuntimeBindings !== "function") return [profile];
    return productStore.getAgentRuntimeBindings(profile.id).bindings.map((binding) => ({
      ...profile, runtime: binding.runtime, runtimeProfileId: binding.runtimeProfileId,
      runtimeAccountId: binding.runtimeAccountId, selectedBindingId: binding.id,
      enabled: profile.enabled && binding.enabled,
    }));
  });
}

module.exports = { agentRuntimeProfileViews };
