"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PluginStore } = require("./plugin-store");
const { PluginComponentResolver } = require("./plugin-component-resolver");
const { PluginToolCatalogRegistry } = require("./plugin-tool-catalog-registry");
const { ProductStore } = require("./product-store");
const { HostCapabilityIssuer } = require("./host-capability-issuer");
const { RuntimeAccountAdmission } = require("./runtime-account-admission");
const { assertTrustedCodexTurn } = require("./runtime-mcp-call-binding");
const { ACTIVE_WORK_RUN_STATUSES, canonicalWorkspace } = require("./work-run");
const { SOURCE_IDENTITY, COMPONENT_NAME, VERSION, TRANSPORT, readCodexSecurityNativeComponent,
  nativeEndpointIdentity, nativePrincipalIdentity } = require("./plugin-codex-security-native-component");
const { serviceError } = require("./security");
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = code => { throw serviceError(`CODEX_SECURITY_DISPATCH_${code}`,
  "Codex Security 缺少当前原生所属任务、正式组件或逐工具权限"); };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field?.enumerable && Object.hasOwn(field, "value");
  });

// This is a prerequisite guard for the future dedicated transport, not an
// egress permission or a native host factory. No method sends a tool, consumes
// a Dispatcher ticket, creates a turn, reads auth or constructs caller _meta.
class CodexSecurityNativeDispatchPreconditions {
  #captured = new WeakMap();
  constructor({ store, resolver, toolCatalogRegistry, productStore, dispatcher,
    capabilityIssuer, runtimeAccountAdmission, now = Date.now } = {}) {
    if (!(store instanceof PluginStore) || !(resolver instanceof PluginComponentResolver)
      || resolver.store !== store || !(toolCatalogRegistry instanceof PluginToolCatalogRegistry)
      || !(productStore instanceof ProductStore) || typeof dispatcher?.getRun !== "function"
      || !(capabilityIssuer instanceof HostCapabilityIssuer)
      || !(runtimeAccountAdmission instanceof RuntimeAccountAdmission) || typeof now !== "function") {
      throw new TypeError("Trusted Service native dispatch dependencies required");
    }
    Object.assign(this, { store, resolver, toolCatalogRegistry, productStore, dispatcher,
      capabilityIssuer, runtimeAccountAdmission, now });
  }
  #current(input, scope, lease) {
    const nativeTurn = assertTrustedCodexTurn(scope, scope?.runId);
    const identity = this.capabilityIssuer.assert(lease, { kind: "mcp", sessionId: nativeTurn.threadId,
      turnId: nativeTurn.turnId, identity: { runId: nativeTurn.runId, runtime: "codex" } });
    const run = this.dispatcher.getRun(identity.runId);
    if (!run || hash(run) !== hash(this.productStore.getWorkRun(identity.runId))
      || !ACTIVE_WORK_RUN_STATUSES.has(run.status) || run.profileId !== identity.profileId
      || run.workspace !== identity.workspace || canonicalWorkspace(run.workspace) !== run.workspace) fail("OWNER_CHANGED");
    const profile = this.productStore.resolveAgentRuntimeProfile(identity.profileId, identity.bindingId);
    const account = this.productStore.getRuntimeAccount(profile.runtimeAccountId);
    const expected = { runtime: "codex", runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId, sessionId: nativeTurn.threadId };
    if (!profile.enabled || profile.runtime !== "codex" || profile.runtimeAccountId !== identity.runtimeAccountId
      || account?.kind !== "shoggoth-managed" || account.runtime !== "codex"
      || Object.keys(expected).some(key => run.runtimeSessionRef?.[key] !== expected[key]
        || run.runtimeTurnRef?.[key] !== expected[key]) || run.runtimeTurnRef.turnId !== nativeTurn.turnId) fail("NATIVE_TURN_REQUIRED");
    this.runtimeAccountAdmission.assertRunAdmitted({ runtimeAccountId: profile.runtimeAccountId,
      runId: run.id, generation: identity.accountGeneration });
    const installation = this.resolver.verifyInstallation(input.installationId);
    if (installation.sourceIdentity !== SOURCE_IDENTITY || installation.desiredState !== "enabled"
      || this.store.hasPendingInstallationDisable(input.installationId)) fail("COMPONENT_REQUIRED");
    const release = this.store.getRelease(SOURCE_IDENTITY, installation.releaseDigest);
    const descriptor = release?.components.mcpServers.find(item => item.name === COMPONENT_NAME);
    if (release?.name !== COMPONENT_NAME || release.declaredVersion !== VERSION
      || !descriptor || descriptor.type !== TRANSPORT) fail("COMPONENT_REQUIRED");
    const root = fs.realpathSync(path.join(this.store.paths.pluginPackagesDir, installation.releaseDigest));
    const component = readCodexSecurityNativeComponent(root);
    if (descriptor.descriptorDigest !== component.descriptorDigest) fail("COMPONENT_CHANGED");
    const records = this.store.getCapabilityRecords(input.bindingId, input.toolIdentity);
    const { binding, connection, grant } = records || {}, now = this.now();
    if (!Number.isSafeInteger(now) || now < 0 || !records || records.installation?.installationId !== input.installationId
      || binding.enabled !== true || !((binding.subjectKind === "global" && binding.subjectId === "all-agents")
        || (binding.subjectKind === "native-profile" && binding.subjectId === run.profileId))
      || binding.componentKind !== "mcp-server" || binding.installationId !== installation.installationId
      || binding.componentId !== require("./plugin-component-catalog").componentId(installation.installationId, "mcp-server", COMPONENT_NAME)
      || connection?.state !== "ready" || connection.connectionId !== binding.connectionId
      || connection.componentId !== binding.componentId || connection.installationId !== input.installationId
      || connection.endpointIdentity !== nativeEndpointIdentity(component.descriptorDigest)
      || connection.principalIdentity !== nativePrincipalIdentity(profile.runtimeAccountId)
      || grant?.effect !== "allow" || grant.bindingId !== binding.bindingId || grant.toolIdentity !== input.toolIdentity
      || grant.connectionId !== connection.connectionId || grant.principalIdentity !== connection.principalIdentity
      || (grant.expiresAt !== null && (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= now))) fail("GRANT_REQUIRED");
    const tool = this.toolCatalogRegistry.resolve({ ...records, toolIdentity: input.toolIdentity });
    if (!tool || tool.downstreamName !== input.toolName || tool.contractDigest !== grant.contractDigest
      || !HASH.test(tool.contractDigest) || typeof tool.catalogRevision !== "string") fail("TOOL_CONTRACT_CHANGED");
    // A second native/lease guard is synchronous with returning the snapshot.
    assertTrustedCodexTurn(scope, nativeTurn.runId);
    this.capabilityIssuer.assert(lease, { kind: "mcp", sessionId: nativeTurn.threadId, turnId: nativeTurn.turnId });
    return { owner: { runId: run.id, profileId: run.profileId, bindingId: identity.bindingId,
      runtimeAccountId: identity.runtimeAccountId, accountGeneration: identity.accountGeneration,
      attemptId: identity.attemptId, nativeThreadId: nativeTurn.threadId, nativeTurnId: nativeTurn.turnId,
      contextSnapshotId: run.contextSnapshotId, workspace: run.workspace }, profile, account,
      installation, release, component, records, tool };
  }
  capture(input, scope, lease) {
    if (!exact(input, ["installationId", "bindingId", "toolIdentity", "toolName"])
      || !ID.test(input.installationId || "") || !ID.test(input.bindingId || "")
      || typeof input.toolIdentity !== "string" || !input.toolIdentity || input.toolIdentity.length > 512
      || typeof input.toolName !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(input.toolName)) fail("INVALID");
    const request = Object.freeze({ ...input }), captured = this.#current(request, scope, lease);
    const prerequisite = Object.freeze({ version: 1, kind: "codex-security-native-dispatch-prerequisite" });
    this.#captured.set(prerequisite, { request, scope, lease, digest: hash(captured) });
    return prerequisite;
  }
  assertCurrent(prerequisite, scope, lease) {
    const record = this.#captured.get(prerequisite);
    if (!record || scope !== record.scope || lease !== record.lease
      || hash(this.#current(record.request, scope, lease)) !== record.digest) fail("PREREQUISITE_CHANGED");
    return true;
  }
  describe(prerequisite, scope, lease) {
    this.assertCurrent(prerequisite, scope, lease);
    return Object.freeze({ version: 1, purpose: "native-dispatch-prerequisites-only", fullPluginUsable: false,
      originalToolsUnlocked: false, owningNativeTurnMatched: true, perToolGrantMatched: true,
      blockers: Object.freeze(["AUTHENTICATED_OWNING_NATIVE_HOST_FACTORY_REQUIRED", "SERVICE_ENVIRONMENT_AUTHORIZATION_REQUIRED",
        "PER_TOOL_DISPATCHER_FINAL_EGRESS_REQUIRED", "DURABLE_ORIGINAL_SCAN_JOB_REQUIRED", "APP_SAME_THREAD_API_REQUIRED"]) });
  }
}
module.exports = { CodexSecurityNativeDispatchPreconditions };
