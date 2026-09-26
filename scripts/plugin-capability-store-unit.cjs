"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginComponentCatalog } = require("../app/agent-service/plugin-component-catalog");
const { PermissionEngine } = require("../app/agent-service/permission-engine");
const { CapabilityDispatcher } = require("../app/agent-service/capability-dispatcher");
const { PluginMcpClient } = require("../app/agent-service/plugin-mcp-client");
const { PluginDataScopeLeaseManager } = require("../app/agent-service/plugin-data-scope-lease");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-capability-"));
const paths = resolveServicePaths({ stateRoot: path.join(temp, "state"), userDataRoot: temp,
  profileRoot: path.join(temp, "profile"), cacheRoot: path.join(temp, "cache"), trustedRoot: temp });
const store = new PluginStore({ paths }).open();
const registry = { revision: "fixture", get(name) {
  return name === "mcp_server_call" ? { tool: name, enabled: true, risk: "write" } : null;
}, list() { return [this.get("mcp_server_call")]; } };
const policy = new PermissionEngine({ toolRegistry: registry });
const digest = crypto.createHash("sha256").update("echo:input-v1").digest("hex");
const argumentDigest = crypto.createHash("sha256").update('{"value":"hello"}').digest("hex");

(async () => {
try {
  const installer = new PluginPackageInstaller({ store });
  const sourcePath = path.join(temp, "source");
  fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), sourcePath,
    { recursive: true });
  const preview = installer.preview(sourcePath);
  const installed = installer.install({ sourcePath, previewDigest: preview.contentDigest,
    operationId: "capability-install", expectedRevision: 0 });
  const component = new PluginComponentCatalog({ store }).list()[0].components
    .find((entry) => entry.localName === "local-issues");
  const pending = store.createConnection({ connectionId: "connection-a",
    installationId: installed.installationId, componentId: component.componentId,
    endpointIdentity: "fixture://local-issues" });
  assert.equal(pending.state, "pending");
  const binding = store.createBinding({ bindingId: "binding-a", profileId: "agent-a",
    installationId: installed.installationId, componentId: component.componentId,
    connectionId: pending.connectionId });
  assert.equal(binding.enabled, false);
  assert.throws(() => store.setGrant({ grantId: "grant-a", bindingId: binding.bindingId,
    toolIdentity: "echo", contractDigest: digest, effect: "allow",
    approvalMode: "always", expectedRevision: 0 }),
  (failure) => failure.code === "CONNECTION_AUTH_REQUIRED");
  const ready = store.setConnectionIdentity({ connectionId: pending.connectionId,
    principalIdentity: "account-a", state: "ready", expectedRevision: 1 });
  assert.equal(ready.authRevision, 1);
  assert.throws(() => store.setGrant({ grantId: "grant-a", bindingId: binding.bindingId,
    toolIdentity: "echo", contractDigest: digest, effect: "allow",
    approvalMode: "always", argumentScope: { value: "hello" }, expectedRevision: 0 }),
  (failure) => failure.code === "PLUGIN_GRANT_INVALID");
  const grant = store.setGrant({ grantId: "grant-a", bindingId: binding.bindingId,
    toolIdentity: "echo", contractDigest: digest, effect: "allow",
    approvalMode: "always", expectedRevision: 0 });
  assert.equal(grant.epoch, 1);
  const run = { id: "run-a", profileId: "agent-a", workspace: "/tmp/work" };
  const authority = { kind: "native-profile", profileId: "agent-a",
    profile: { id: "agent-a", enabled: true }, confirmed: false };
  const execution = { kind: "native-run", profileId: "agent-a", workspace: run.workspace, run };
  const envelope = { runId: run.id, authorityIncarnation: store.getAuthorityIncarnation(), bindingId: binding.bindingId,
    installationId: installed.installationId, releaseDigest: installed.releaseDigest,
    componentId: component.componentId, connectionId: pending.connectionId,
    principalIdentity: "account-a", bindingRevision: 2, grantEpoch: 1,
    connectionAuthRevision: 1,
    toolIdentity: "echo", contractDigest: digest };
  const evaluate = (overrides = {}) => policy.authorizeCapability({ authority, execution,
    ...store.getCapabilityRecords(binding.bindingId, "echo"), envelope,
    toolIdentity: "echo", contractDigest: digest, argumentDigest, now: 1000, ...overrides });
  assert.throws(() => evaluate(), (failure) => failure.code === "GRANT_REVOKED");
  const enabledInstallation = store.setInstallationDesiredState({ installationId: installed.installationId,
    desiredState: "enabled", expectedRevision: installed.revision });
  assert.equal(enabledInstallation.desiredState, "enabled");
  store.setBindingEnabled({ bindingId: binding.bindingId, enabled: true,
    expectedRevision: binding.revision });
  assert.equal(evaluate().grantEpoch, 1);
  let currentContractDigest = digest;
  let catalogRevision = "fixture-generation-1";
  const dispatcher = new CapabilityDispatcher({ store, permissionEngine: policy,
    resolveToolContract: () => ({ toolIdentity: "echo", downstreamName: "echo",
      contractDigest: currentContractDigest, catalogRevision }), now: () => 1000 });
  const callInput = { authority, execution, envelope, bindingId: binding.bindingId,
    toolIdentity: "echo", downstreamToolName: "echo",
    contractDigest: digest, arguments: { value: "hello" } };
  const client = await PluginMcpClient.connectStdio({ command: process.execPath,
    args: [path.join(__dirname, "fixtures/plugins/mcp-sdk-fixture.cjs"), "2025-11-25"],
    cwd: __dirname, env: { PATH: process.env.PATH },
    connectionId: pending.connectionId, principalIdentity: "account-a",
    authorizeEgress: (request) => dispatcher.authorizeEgress(request), timeoutMs: 3000,
    dataScope: { leaseManager: new PluginDataScopeLeaseManager({ paths }),
      installationId: installed.installationId, scopeId: "a".repeat(64) } });
  try {
    const answer = await dispatcher.dispatch({ client, ...callInput, callId: "call-stdio" });
    assert.equal(answer.structuredContent.echoed, "hello");
    assert.equal(store.getCapabilityCall("call-stdio").phase, "result_confirmed");
  } finally { await client.close(); }
  const failingClient = { async callTool(name, args, callAuthority) {
    dispatcher.authorizeEgress({ connectionId: pending.connectionId,
      principalIdentity: "account-a", toolName: name, arguments: args,
      authority: callAuthority });
    throw new Error("fixture transport failure after send admission");
  } };
  await assert.rejects(dispatcher.dispatch({ client: failingClient, ...callInput,
    callId: "call-unknown" }));
  assert.equal(store.getCapabilityCall("call-unknown").phase, "outcome_unknown");
  assert.throws(() => dispatcher.issueTicket({ ...callInput, callId: "call-unknown" }),
    (failure) => failure.code === "CALL_ALREADY_RECORDED");
  const admit = (ticketId) => dispatcher.authorizeEgress({ connectionId: pending.connectionId,
    principalIdentity: "account-a", toolName: "echo", arguments: { value: "hello" },
    authority: { ticketId } });
  const successfulTicket = dispatcher.issueTicket({ ...callInput, callId: "call-success" });
  assert.equal(admit(successfulTicket).grantEpoch, 1);
  assert.equal(store.getCapabilityCall("call-success").phase, "send_started");
  store.finishCapabilityCall("call-success", { resultConfirmed: true });
  assert.equal(store.getCapabilityCall("call-success").phase, "result_confirmed");
  assert.throws(() => dispatcher.issueTicket({ ...callInput, callId: "call-success" }),
    (failure) => failure.code === "CALL_ALREADY_RECORDED");
  assert.throws(() => admit(successfulTicket), (failure) => failure.code === "CAPABILITY_FORBIDDEN");
  const revokedBeforeSend = dispatcher.issueTicket({ ...callInput, callId: "call-args-mismatch" });
  assert.throws(() => dispatcher.authorizeEgress({ connectionId: pending.connectionId,
    principalIdentity: "account-a", toolName: "echo", arguments: { value: "changed" },
    authority: { ticketId: revokedBeforeSend } }),
  (failure) => failure.code === "CAPABILITY_FORBIDDEN");
  assert.equal(store.getCapabilityCall("call-args-mismatch").phase, "rejected_before_send");
  const changedBeforeSend = dispatcher.issueTicket({ ...callInput, callId: "call-contract-changed" });
  currentContractDigest = "f".repeat(64);
  assert.throws(() => admit(changedBeforeSend),
    (failure) => failure.code === "TOOL_CONTRACT_CHANGED");
  assert.equal(store.getCapabilityCall("call-contract-changed").phase, "rejected_before_send");
  currentContractDigest = digest;
  const refreshedBeforeSend = dispatcher.issueTicket({ ...callInput,
    callId: "call-catalog-refreshed" });
  catalogRevision = "fixture-generation-2";
  assert.throws(() => admit(refreshedBeforeSend),
    (failure) => failure.code === "TOOL_CONTRACT_CHANGED");
  assert.equal(store.getCapabilityCall("call-catalog-refreshed").phase,
    "rejected_before_send");
  const pendingAtRevocation = dispatcher.issueTicket({ ...callInput, callId: "call-revoked" });
  assert.throws(() => evaluate({ authority: { ...authority, profileId: "agent-b" } }),
    (failure) => failure.code === "CAPABILITY_FORBIDDEN");
  assert.throws(() => store.setGrant({ grantId: "grant-a", bindingId: binding.bindingId,
    toolIdentity: "echo", contractDigest: digest, effect: "deny",
    approvalMode: "always", expectedRevision: 0 }),
  (failure) => failure.code === "REVISION_CONFLICT");
  const revoked = store.setGrant({ grantId: "grant-a", bindingId: binding.bindingId,
    toolIdentity: "echo", contractDigest: digest, effect: "deny",
    approvalMode: "always", expectedRevision: 1 });
  assert.equal(revoked.epoch, 2);
  assert.throws(() => admit(pendingAtRevocation), (failure) => failure.code === "GRANT_REVOKED");
  assert.equal(store.getCapabilityCall("call-revoked").phase, "rejected_before_send");
  assert.throws(() => evaluate(), (failure) => failure.code === "GRANT_REVOKED");
  store.setConnectionIdentity({ connectionId: pending.connectionId,
    principalIdentity: "account-b", state: "ready", expectedRevision: ready.revision });
  assert.equal(store.getGrant(binding.bindingId, "echo").effect, "deny");
  const regranted = store.setGrant({ grantId: "grant-a", bindingId: binding.bindingId,
    toolIdentity: "echo", contractDigest: digest, effect: "allow",
    approvalMode: "always", expectedRevision: 3 });
  assert.equal(regranted.principalIdentity, "account-b");
  assert.throws(() => evaluate(), (failure) => failure.code === "TOOL_CONTRACT_CHANGED");
  assert.equal(evaluate({ envelope: { ...envelope, principalIdentity: "account-b",
    grantEpoch: regranted.epoch, connectionAuthRevision: 2 } }).grantEpoch, regranted.epoch);
  store.setConnectionIdentity({ connectionId: pending.connectionId,
    principalIdentity: "account-a", state: "ready", expectedRevision: 3 });
  assert.equal(store.getGrant(binding.bindingId, "echo").effect, "deny");
  fs.appendFileSync(path.join(sourcePath, "skills/issue-summary/SKILL.md"), "\nUpdated fixture.\n");
  const updatePreview = installer.preview(sourcePath);
  const directFingerprint = crypto.createHash("sha256").update(JSON.stringify({
    sourceIdentity: updatePreview.sourceIdentity,
    previewDigest: updatePreview.contentDigest,
    expectedRevision: enabledInstallation.revision,
  })).digest("hex");
  store.beginInstall({ operationId: "capability-direct-active-update",
    fingerprint: directFingerprint });
  assert.throws(() => store.commitInstall({
    operationId: "capability-direct-active-update", fingerprint: directFingerprint,
    installationId: installed.installationId,
    sourceIdentity: updatePreview.sourceIdentity,
    expectedRevision: enabledInstallation.revision, preview: updatePreview,
  }), (failure) => failure.code === "PLUGIN_UPDATE_REQUIRES_DISABLE");
  assert.throws(() => installer.install({ sourcePath,
    previewDigest: updatePreview.contentDigest,
    operationId: "capability-update-while-enabled",
    expectedRevision: enabledInstallation.revision,
  }), (failure) => failure.code === "PLUGIN_UPDATE_REQUIRES_DISABLE");
  assert.equal(store.getInstallation(installed.installationId).desiredState, "enabled");
  const disabledForUpdate = store.setInstallationDesiredState({
    installationId: installed.installationId, desiredState: "disabled",
    expectedRevision: enabledInstallation.revision,
  });
  const disabledPreview = installer.preview(sourcePath);
  assert.equal(disabledPreview.expectedRevision, disabledForUpdate.revision);
  const updated = installer.install({ sourcePath, previewDigest: disabledPreview.contentDigest,
    operationId: "capability-update", expectedRevision: disabledPreview.expectedRevision });
  assert.equal(updated.desiredState, "disabled");
  assert.equal(store.getGrant(binding.bindingId, "echo").effect, "deny");
  assert.equal(store.getBinding(binding.bindingId).enabled, false);
  const reenabled = store.setInstallationDesiredState({ installationId: installed.installationId,
    desiredState: "enabled", expectedRevision: updated.revision });
  store.setInstallationDesiredState({ installationId: installed.installationId,
    desiredState: "disabled", expectedRevision: reenabled.revision });
  assert.equal(store.getGrant(binding.bindingId, "echo").epoch, 8);
  store.beginCapabilityCall({ callId: "call-crash-before-send", runRef: "run-a",
    bindingId: binding.bindingId, connectionId: pending.connectionId,
    principalIdentity: "account-a", toolIdentity: "echo", contractDigest: digest,
    argumentDigest });
  store.beginCapabilityCall({ callId: "call-crash-after-send", runRef: "run-a",
    bindingId: binding.bindingId, connectionId: pending.connectionId,
    principalIdentity: "account-a", toolIdentity: "echo", contractDigest: digest,
    argumentDigest });
  store.markCapabilityCallSendStarted("call-crash-after-send");
  store.close();
  const reopened = new PluginStore({ paths }).open();
  assert.equal(reopened.getGrant(binding.bindingId, "echo").epoch, 8);
  assert.equal(reopened.getConnection(pending.connectionId).principalIdentity, "account-a");
  assert.equal(reopened.getCapabilityCall("call-crash-before-send").phase, "rejected_before_send");
  assert.equal(reopened.getCapabilityCall("call-crash-after-send").phase, "outcome_unknown");
  assert.throws(() => reopened.beginCapabilityCall({ callId: "call-crash-after-send",
    runRef: "run-a", bindingId: binding.bindingId, connectionId: pending.connectionId,
    principalIdentity: "account-a", toolIdentity: "echo", contractDigest: digest,
    argumentDigest }), (failure) => failure.code === "CALL_ALREADY_RECORDED");
  const reopenedInstallation = reopened.getInstallation(installed.installationId);
  reopened.setInstallationDesiredState({ installationId: installed.installationId,
    desiredState: "enabled", expectedRevision: reopenedInstallation.revision });
  const reopenedBinding = reopened.getBinding(binding.bindingId);
  const activeBinding = reopened.setBindingEnabled({ bindingId: binding.bindingId,
    enabled: true, expectedRevision: reopenedBinding.revision });
  const previousGrant = reopened.getGrant(binding.bindingId, "echo");
  const activeGrant = reopened.setGrant({ grantId: "grant-a", bindingId: binding.bindingId,
    toolIdentity: "echo", contractDigest: digest, effect: "allow",
    approvalMode: "always", expectedRevision: previousGrant.revision });
  const resumedDispatcher = new CapabilityDispatcher({ store: reopened, permissionEngine: policy,
    resolveToolContract: () => ({ toolIdentity: "echo", downstreamName: "echo",
      contractDigest: digest, catalogRevision: "fixture-generation-2" }), now: () => 1000 });
  const resumedEnvelope = { ...envelope, releaseDigest: updated.releaseDigest,
    bindingRevision: activeBinding.revision, grantEpoch: activeGrant.epoch,
    connectionAuthRevision: reopened.getConnection(pending.connectionId).authRevision };
  const oldTicket = resumedDispatcher.issueTicket({ ...callInput,
    envelope: resumedEnvelope, callId: "call-binding-toggled" });
  const off = reopened.setBindingEnabled({ bindingId: binding.bindingId,
    enabled: false, expectedRevision: activeBinding.revision });
  const epochAfterOff = reopened.getGrant(binding.bindingId, "echo").epoch;
  assert(epochAfterOff > activeGrant.epoch);
  reopened.setBindingEnabled({ bindingId: binding.bindingId,
    enabled: true, expectedRevision: off.revision });
  assert.equal(reopened.getGrant(binding.bindingId, "echo").epoch, epochAfterOff);
  assert.throws(() => resumedDispatcher.authorizeEgress({
    connectionId: pending.connectionId, principalIdentity: "account-a",
    toolName: "echo", arguments: { value: "hello" },
    authority: { ticketId: oldTicket },
  }), (failure) => failure.code === "TOOL_CONTRACT_CHANGED");
  assert.equal(reopened.getCapabilityCall("call-binding-toggled").phase,
    "rejected_before_send");
  const currentBinding = reopened.getBinding(binding.bindingId);
  const grantBeforeSwitch = reopened.getGrant(binding.bindingId, "echo");
  const accountSwitchTicket = resumedDispatcher.issueTicket({ ...callInput,
    callId: "call-account-switch", envelope: { ...resumedEnvelope,
      bindingRevision: currentBinding.revision, grantEpoch: grantBeforeSwitch.epoch } });
  const otherPending = reopened.createConnection({ connectionId: "connection-b",
    installationId: installed.installationId, componentId: component.componentId,
    endpointIdentity: "fixture://local-issues" });
  assert.throws(() => reopened.setMcpBindingConnection({ bindingId: binding.bindingId,
    connectionId: otherPending.connectionId, expectedRevision: currentBinding.revision }),
  (failure) => failure.code === "CONNECTION_AUTH_REQUIRED");
  const otherReady = reopened.setConnectionIdentity({ connectionId: otherPending.connectionId,
    principalIdentity: "account-b", state: "ready", expectedRevision: otherPending.revision });
  assert.throws(() => reopened.setMcpBindingConnection({ bindingId: binding.bindingId,
    connectionId: otherReady.connectionId, expectedRevision: currentBinding.revision + 1 }),
  (failure) => failure.code === "REVISION_CONFLICT");
  const otherComponent = new PluginComponentCatalog({ store: reopened }).list()[0].components
    .find((entry) => entry.localName === "remote-issues");
  const wrongComponentConnection = reopened.createConnection({
    connectionId: "connection-wrong-component",
    installationId: installed.installationId,
    componentId: otherComponent.componentId,
    endpointIdentity: "fixture://remote-issues" });
  const wrongReady = reopened.setConnectionIdentity({
    connectionId: wrongComponentConnection.connectionId,
    principalIdentity: "account-c", state: "ready",
    expectedRevision: wrongComponentConnection.revision });
  assert.throws(() => reopened.setMcpBindingConnection({ bindingId: binding.bindingId,
    connectionId: wrongReady.connectionId, expectedRevision: currentBinding.revision }),
  (failure) => failure.code === "PLUGIN_BINDING_INVALID");
  const switched = reopened.setMcpBindingConnection({ bindingId: binding.bindingId,
    connectionId: otherReady.connectionId, expectedRevision: currentBinding.revision });
  assert.equal(switched.connectionId, otherReady.connectionId);
  assert.equal(switched.enabled, false);
  assert.equal(reopened.getGrant(binding.bindingId, "echo").effect, "deny");
  assert.deepEqual(reopened.getConnectionCountsForComponent(installed.installationId,
    component.componentId), { pending: 0, verified: 2, disconnected: 0 });
  assert.deepEqual(reopened.getGrantCountsForBinding(binding.bindingId),
    { allow: 0, deny: 1 });
  assert.throws(() => resumedDispatcher.authorizeEgress({
    connectionId: pending.connectionId, principalIdentity: "account-a",
    toolName: "echo", arguments: { value: "hello" },
    authority: { ticketId: accountSwitchTicket },
  }), (failure) => failure.code === "GRANT_REVOKED");
  assert.equal(reopened.getCapabilityCall("call-account-switch").phase,
    "rejected_before_send");
  const switchedEnabled = reopened.setBindingEnabled({ bindingId: binding.bindingId,
    enabled: true, expectedRevision: switched.revision });
  const deniedGrant = reopened.getGrant(binding.bindingId, "echo");
  const accountBGrant = reopened.setGrant({ grantId: "grant-a",
    bindingId: binding.bindingId, toolIdentity: "echo", contractDigest: digest,
    effect: "allow", approvalMode: "always", expectedRevision: deniedGrant.revision });
  assert.equal(accountBGrant.connectionId, otherReady.connectionId);
  assert.equal(accountBGrant.principalIdentity, "account-b");
  assert.throws(() => resumedDispatcher.issueTicket({ ...callInput,
    callId: "call-old-account-after-switch", envelope: { ...resumedEnvelope,
      bindingRevision: switchedEnabled.revision, grantEpoch: accountBGrant.epoch } }),
  (failure) => failure.code === "TOOL_CONTRACT_CHANGED");
  const accountBTicket = resumedDispatcher.issueTicket({ ...callInput,
    callId: "call-explicit-revoke", envelope: { ...resumedEnvelope,
      connectionId: otherReady.connectionId, principalIdentity: "account-b",
      connectionAuthRevision: otherReady.authRevision,
      bindingRevision: switchedEnabled.revision, grantEpoch: accountBGrant.epoch } });
  assert.throws(() => reopened.revokeGrant({ bindingId: binding.bindingId,
    toolIdentity: "echo", expectedRevision: accountBGrant.revision + 1 }),
  (failure) => failure.code === "REVISION_CONFLICT");
  const revokedB = reopened.revokeGrant({ bindingId: binding.bindingId,
    toolIdentity: "echo", expectedRevision: accountBGrant.revision });
  assert.equal(revokedB.effect, "deny");
  assert(revokedB.epoch > accountBGrant.epoch);
  assert.deepEqual(reopened.revokeGrant({ bindingId: binding.bindingId,
    toolIdentity: "echo", expectedRevision: revokedB.revision }), revokedB);
  assert.throws(() => resumedDispatcher.authorizeEgress({
    connectionId: otherReady.connectionId, principalIdentity: "account-b",
    toolName: "echo", arguments: { value: "hello" },
    authority: { ticketId: accountBTicket },
  }), (failure) => failure.code === "GRANT_REVOKED");
  assert.equal(reopened.getCapabilityCall("call-explicit-revoke").phase,
    "rejected_before_send");
  const reallowedB = reopened.setGrant({ grantId: "grant-a",
    bindingId: binding.bindingId, toolIdentity: "echo", contractDigest: digest,
    effect: "allow", approvalMode: "always", expectedRevision: revokedB.revision });
  const bulkTicket = resumedDispatcher.issueTicket({ ...callInput,
    callId: "call-bulk-revoke", envelope: { ...resumedEnvelope,
      connectionId: otherReady.connectionId, principalIdentity: "account-b",
      connectionAuthRevision: otherReady.authRevision,
      bindingRevision: switchedEnabled.revision, grantEpoch: reallowedB.epoch } });
  assert.throws(() => reopened.revokeAllGrants({ bindingId: binding.bindingId,
    expectedRevision: switchedEnabled.revision + 1 }),
  (failure) => failure.code === "REVISION_CONFLICT");
  const bulk = reopened.revokeAllGrants({ bindingId: binding.bindingId,
    expectedRevision: switchedEnabled.revision });
  assert.deepEqual({ bindingId: bulk.bindingId, revokedCount: bulk.revokedCount,
    bindingRevision: bulk.bindingRevision }, { bindingId: binding.bindingId,
    revokedCount: 1, bindingRevision: switchedEnabled.revision });
  assert(bulk.epoch > reallowedB.epoch);
  assert.equal(reopened.revokeAllGrants({ bindingId: binding.bindingId,
    expectedRevision: switchedEnabled.revision }).revokedCount, 0);
  assert.throws(() => resumedDispatcher.authorizeEgress({
    connectionId: otherReady.connectionId, principalIdentity: "account-b",
    toolName: "echo", arguments: { value: "hello" },
    authority: { ticketId: bulkTicket },
  }), (failure) => failure.code === "GRANT_REVOKED");
  assert.equal(reopened.getCapabilityCall("call-bulk-revoke").phase,
    "rejected_before_send");
  const otherAgentBinding = reopened.createBinding({
    bindingId: "binding-other-agent", profileId: "agent-b",
    installationId: installed.installationId, componentId: component.componentId,
    connectionId: otherReady.connectionId });
  const otherAgentEnabled = reopened.setBindingEnabled({
    bindingId: otherAgentBinding.bindingId, enabled: true,
    expectedRevision: otherAgentBinding.revision });
  const otherAgentGrant = reopened.setGrant({ grantId: "grant-other-agent",
    bindingId: otherAgentBinding.bindingId, toolIdentity: "echo",
    contractDigest: digest, effect: "allow", approvalMode: "always",
    expectedRevision: 0 });
  const deniedA = reopened.getGrant(binding.bindingId, "echo");
  const reallowedA = reopened.setGrant({ grantId: "grant-a",
    bindingId: binding.bindingId, toolIdentity: "echo", contractDigest: digest,
    effect: "allow", approvalMode: "always",
    expectedRevision: deniedA.revision });
  const profileTicket = resumedDispatcher.issueTicket({ ...callInput,
    callId: "call-profile-archive", envelope: { ...resumedEnvelope,
      connectionId: otherReady.connectionId, principalIdentity: "account-b",
      connectionAuthRevision: otherReady.authRevision,
      bindingRevision: switchedEnabled.revision, grantEpoch: reallowedA.epoch } });
  const profileRevoke = reopened.revokeProfileBindings("agent-a");
  assert.equal(profileRevoke.disabledBindings, 1);
  assert.equal(profileRevoke.revokedGrants, 1);
  assert(profileRevoke.epoch > reallowedA.epoch);
  assert.equal(reopened.getBinding(binding.bindingId).enabled, false);
  assert.equal(reopened.getGrant(binding.bindingId, "echo").effect, "deny");
  assert.deepEqual(reopened.revokeProfileBindings("agent-a"), {
    profileId: "agent-a", disabledBindings: 0, revokedGrants: 0,
    epoch: profileRevoke.epoch });
  assert.equal(reopened.getBinding(otherAgentBinding.bindingId).revision,
    otherAgentEnabled.revision);
  assert.equal(reopened.getGrant(otherAgentBinding.bindingId, "echo").epoch,
    otherAgentGrant.epoch);
  assert.equal(reopened.getGrant(otherAgentBinding.bindingId, "echo").effect, "allow");
  assert.throws(() => resumedDispatcher.authorizeEgress({
    connectionId: otherReady.connectionId, principalIdentity: "account-b",
    toolName: "echo", arguments: { value: "hello" },
    authority: { ticketId: profileTicket },
  }), (failure) => failure.code === "GRANT_REVOKED");
  assert.equal(reopened.getCapabilityCall("call-profile-archive").phase,
    "rejected_before_send");
  reopened.beginCapabilityCall({ callId: "call-profile-purge-in-flight", runRef: "run-a",
    bindingId: binding.bindingId, connectionId: otherReady.connectionId,
    principalIdentity: "account-b", toolIdentity: "echo", contractDigest: digest,
    argumentDigest });
  reopened.markCapabilityCallSendStarted("call-profile-purge-in-flight");
  assert.throws(() => reopened.purgeProfileBindings("agent-a"),
    (failure) => failure.code === "ACTIVATION_DEFERRED");
  assert(reopened.getBinding(binding.bindingId),
    "an active send must leave the whole purge transaction untouched");
  reopened.finishCapabilityCall("call-profile-purge-in-flight", { resultConfirmed: true });
  const purged = reopened.purgeProfileBindings("agent-a");
  assert.equal(purged.removedBindings, 1);
  assert.equal(purged.removedGrants, 1);
  assert(purged.scrubbedCalls > 0);
  assert.equal(reopened.getBinding(binding.bindingId), null);
  assert.equal(reopened.getGrant(binding.bindingId, "echo"), null);
  assert.deepEqual(reopened.listBindingsForProfile("agent-a"), []);
  assert.equal(reopened.getCapabilityCall("call-crash-after-send").phase,
    "outcome_unknown", "the unknown outcome remains a durable no-replay tombstone");
  assert.equal(reopened.getCapabilityCall("call-crash-after-send").principalIdentity,
    "", "expired Agent call metadata must be scrubbed");
  assert.throws(() => reopened.beginCapabilityCall({
    callId: "call-crash-after-send", runRef: "run-a", bindingId: binding.bindingId,
    connectionId: otherReady.connectionId, principalIdentity: "account-b",
    toolIdentity: "echo", contractDigest: digest, argumentDigest,
  }), (failure) => failure.code === "CALL_ALREADY_RECORDED");
  assert.deepEqual(reopened.purgeProfileBindings("agent-a"), {
    profileId: "agent-a", removedBindings: 0, removedGrants: 0,
    scrubbedCalls: 0, epoch: purged.epoch });
  assert.equal(reopened.getBinding(otherAgentBinding.bindingId).revision,
    otherAgentEnabled.revision);
  assert.equal(reopened.getGrant(otherAgentBinding.bindingId, "echo").effect,
    "allow", "shared Connection and the other Agent must survive purge");
  assert.equal(reopened.getConnection(otherReady.connectionId).state, "ready");
  reopened.close();
  console.log("plugin capability store: PASS");
} finally {
  store.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
})().catch((failure) => { console.error(failure); process.exitCode = 1; });
