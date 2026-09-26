"use strict";

const assert = require("node:assert/strict");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { validateAgentHarnessParams } = require(
  "../app/agent-service/agent-harness-service-protocol");

const profile = { id: "profile-a", agentId: "agent-a" };
const skill = (source, name) => ({ id: name, name, version: "1.0.0", source,
  enabled: true, globalEnabled: source === "user" });
const backend = new ShoggothBackend();
backend._profileForSkills = () => profile;
backend._nativeSkills = async () => ({ items: [skill("user", "shared-review"),
  skill("builtin", "builtin-help")], registryVersion: 7, profileRevision: 4 });
const calls = [];
backend._call = async (method, params) => {
  validateAgentHarnessParams(method, params);
  calls.push({ method, params });
  const result = method === "harness.skills.global.set"
    ? { registryRevision: 8, skill: { ...skill("user", "shared-review"), enabled: params.enabled } }
    : method === "harness.skills.enable"
      ? { profileRevision: 5, skill: { ...skill("builtin", "builtin-help"), enabled: params.enabled } }
      : { registryRevision: 8, skill: skill("user", "shared-review") };
  // The production Service validates the complete Skill metadata; this test
  // only checks the Backend's scope, identity and revision routing.
  return result;
};

(async () => {
  const updated = await backend.updateSkill("shared-review", { enabled: false },
    { agentId: "agent-a" });
  assert.equal(updated.enabled, false);
  assert.equal(updated.registryVersion, 8);
  assert.deepEqual(calls[0], { method: "harness.skills.global.set", params: {
    profileId: profile.id, skillId: "shared-review", source: "user",
    version: "1.0.0", enabled: false, expectedRevision: 7 } });
  const builtin = await backend.updateSkill("builtin-help", { enabled: false },
    { agentId: "agent-a" });
  assert.equal(builtin.profileRevision, 5);
  assert.deepEqual(calls[1], { method: "harness.skills.enable", params: {
    profileId: profile.id, skillId: "builtin-help", source: "builtin",
    version: "1.0.0", enabled: false, expectedRevision: 4 } });
  await backend.installSkill("/trusted/skill-package", { agentId: "agent-a",
    operationId: "skill-install-global" });
  assert.equal(calls[2].method, "harness.skills.install");
  assert.equal(calls[2].params.expectedRevision, 7);
  assert.equal(calls[2].params.sourcePath, "/trusted/skill-package");
  assert.throws(() => validateAgentHarnessParams("harness.skills.global.set", {
    ...calls[0].params, source: "builtin" }), { code: "INVALID_PARAMS" });
  console.log("Shoggoth Skill Backend routes user Skill state globally: PASS");
})().catch(error => { console.error(error); process.exitCode = 1; });
