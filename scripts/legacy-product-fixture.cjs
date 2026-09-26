"use strict";
// Construct actual historical fields when a current snapshot is downgraded.
const { projectProfile, profileWithoutBindingState } = require("../app/agent-service/agent-runtime-binding");
function legacyProfile(profile) {
  return profileWithoutBindingState(profile.bindings ? projectProfile(profile) : profile);
}
function downgradeProfiles(snapshot) {
  snapshot.agentProfiles = (snapshot.agentProfiles || []).map(legacyProfile);
  return snapshot;
}
module.exports = { legacyProfile, downgradeProfiles };
