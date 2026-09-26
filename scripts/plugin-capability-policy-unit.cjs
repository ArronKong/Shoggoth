"use strict";

const assert = require("node:assert/strict");
const { PermissionEngine } = require("../app/agent-service/permission-engine");

const digest = "a".repeat(64);
const argumentDigest = "b".repeat(64);
const registry = {
  revision: "fixture-tools-v1",
  get(name) { return name === "mcp_server_call"
    ? { tool: name, enabled: true, risk: "write" } : null; },
  list() { return [this.get("mcp_server_call")]; },
};
const policy = new PermissionEngine({ toolRegistry: registry });
const baseline = {
  authorityIncarnation: "e".repeat(64),
  authority: { kind: "native-profile", profileId: "agent-a",
    profile: { id: "agent-a", enabled: true }, confirmed: false },
  execution: { kind: "native-run", profileId: "agent-a", workspace: "/tmp/work",
    run: { id: "run-a", profileId: "agent-a", workspace: "/tmp/work" } },
  installation: { installationId: "install-a", desiredState: "enabled",
    activeReleaseDigest: "release-a" },
  binding: { bindingId: "binding-a", subjectKind: "native-profile", subjectId: "agent-a",
    installationId: "install-a", componentId: "component-a",
    connectionId: "connection-a", enabled: true, revision: 2 },
  connection: { connectionId: "connection-a", principalIdentity: "account-a",
    state: "ready", authRevision: 3 },
  grant: { bindingId: "binding-a", connectionId: "connection-a",
    principalIdentity: "account-a", toolIdentity: "issues:create_issue",
    contractDigest: digest, effect: "allow", approvalMode: "always",
    argumentScope: null, epoch: 8, expiresAt: null },
  envelope: { runId: "run-a", authorityIncarnation: "e".repeat(64), bindingId: "binding-a", installationId: "install-a",
    releaseDigest: "release-a", componentId: "component-a",
    connectionId: "connection-a", principalIdentity: "account-a",
    bindingRevision: 2, grantEpoch: 8, connectionAuthRevision: 3,
    toolIdentity: "issues:create_issue", contractDigest: digest },
  toolIdentity: "issues:create_issue", contractDigest: digest, argumentDigest, now: 1000,
};
function denied(mutator, code) {
  const input = structuredClone(baseline);
  mutator(input);
  assert.throws(() => policy.authorizeCapability(input),
    (failure) => failure.code === code);
}

assert.equal(policy.authorizeCapability(baseline).grantEpoch, 8);
denied((input) => { input.authorityIncarnation = "f".repeat(64); }, "TOOL_CONTRACT_CHANGED");
denied((input) => { delete input.envelope.authorityIncarnation; }, "TOOL_CONTRACT_CHANGED");
denied((input) => { input.authority.profile.enabled = false; }, "CAPABILITY_FORBIDDEN");
denied((input) => { input.execution.profileId = "agent-b"; }, "CAPABILITY_FORBIDDEN");
denied((input) => { input.connection.principalIdentity = "account-b"; }, "GRANT_REVOKED");
denied((input) => { input.installation.desiredState = "disabled"; }, "GRANT_REVOKED");
denied((input) => { input.grant.effect = "deny"; }, "GRANT_REVOKED");
denied((input) => { input.grant.contractDigest = "c".repeat(64); }, "GRANT_REVOKED");
denied((input) => { input.envelope.contractDigest = "c".repeat(64); }, "TOOL_CONTRACT_CHANGED");
denied((input) => { input.envelope.runId = "run-old"; }, "CAPABILITY_FORBIDDEN");
denied((input) => { input.grant.expiresAt = 999; }, "GRANT_REVOKED");
denied((input) => { input.grant.argumentScope = { owner: "test" }; }, "GRANT_REVOKED");
denied((input) => { input.grant.approvalMode = "each-call"; }, "CAPABILITY_FORBIDDEN");

const approved = structuredClone(baseline);
approved.grant.approvalMode = "each-call";
approved.execution.approval = { bindingId: "binding-a", connectionId: "connection-a", runId: baseline.execution.run.id,
  principalIdentity: "account-a", toolIdentity: "issues:create_issue",
  contractDigest: digest, argumentDigest, expiresAt: 2000, consumed: false };
assert.equal(policy.authorizeCapability(approved).grantEpoch, 8);
approved.execution.approval.argumentDigest = "c".repeat(64);
assert.throws(() => policy.authorizeCapability(approved), (failure) => failure.code === "CAPABILITY_FORBIDDEN");

const interaction = structuredClone(baseline);
interaction.execution = { kind: "user-interaction", profileId: "agent-a",
  workspace: "/tmp/work", managementTicket: "ticket-a" };
interaction.authority.managementTicket = "ticket-a";
interaction.authority.managementTicketVerified = true;
assert.equal(policy.authorizeCapability(interaction).grantEpoch, 8);
interaction.authority.managementTicketVerified = false;
assert.throws(() => policy.authorizeCapability(interaction),
  (failure) => failure.code === "CAPABILITY_FORBIDDEN");

policy.setProfileOverride("agent-a", "mcp_server_call", "deny");
assert.throws(() => policy.authorizeCapability(baseline),
  (failure) => failure.code === "MCP_TOOL_FORBIDDEN");
console.log("plugin capability policy: PASS");
