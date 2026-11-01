"use strict";

const { runtimeModelProfile } = require("./agent-runtime-binding");

// Identity remains the Profile. These views are only for locating an execution
// resource, including a non-default Binding owned by that Profile.
function agentRuntimeProfileViews(productStore, profileId = null) {
  const profiles = profileId ? [productStore.getAgentProfile(profileId)].filter(Boolean)
    : productStore.listAgentProfiles();
  return profiles.flatMap((profile) => {
    if (typeof productStore.getAgentRuntimeBindings !== "function") return [runtimeModelProfile(profile)];
    return productStore.getAgentRuntimeBindings(profile.id).bindings.map((binding) => runtimeModelProfile({
      ...profile, runtime: binding.runtime, runtimeProfileId: binding.runtimeProfileId,
      runtimeAccountId: binding.runtimeAccountId, selectedBindingId: binding.id,
      enabled: profile.enabled && binding.enabled,
    }));
  });
}

module.exports = { agentRuntimeProfileViews };
