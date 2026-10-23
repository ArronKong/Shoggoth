"use strict";
const { componentId } = require("./plugin-component-catalog");
const { digest, fail, dataAccess, HOOK_LIMITS } = require("./hook-contract");
const hookIdFor = (profileId, installationId, releaseDigest, component) => "plugin-hook-" + digest([profileId, installationId, releaseDigest, component]);
class PluginHookRegistry {
  constructor({ store, resolver, now = Date.now }) { this.store = store; this.resolver = resolver; this.now = now; }
  candidates(profileId, workspace) {
    const items = [];
    for (const installation of this.store.listInstallations()) {
      const release = this.store.getRelease(installation.sourceIdentity, installation.releaseDigest);
      for (const component of release.components.hooks || []) {
        if (items.length >= HOOK_LIMITS.total) fail("HOOK_CAPACITY");
        const selectedId = componentId(installation.installationId, "hook", component.name);
        const stored = this.store.getHookBinding(profileId, installation.installationId, selectedId);
        const binding = stored?.releaseDigest === installation.releaseDigest ? stored : null;
        const reference = { installationId: installation.installationId, installationRevision: installation.revision,
          sourceIdentity: installation.sourceIdentity, releaseDigest: installation.releaseDigest, componentId: selectedId,
          descriptorDigest: component.descriptorDigest };
        const bound = binding?.grant ? binding.workspace : component.definition.scope.workspace === "current" ? workspace : null;
        if (component.definition.scope.workspace === "current" && typeof bound !== "string") continue;
        // No package code is executed here. Source is read only when the Agent
        // asks for this candidate or the enabled binding enters a Run.
        items.push({ hookId: hookIdFor(profileId, installation.installationId, installation.releaseDigest, selectedId),
          profileId, owner: "plugin", revision: binding?.revision ?? 1, version: 1,
          activeVersion: binding?.enabled ? 1 : null, epoch: binding?.epoch ?? 0,
          updatedAt: binding?.updatedAt ?? installation.updatedAt, reference, boundWorkspace: bound,
          definition: { ...component.definition, scope: { ...component.definition.scope, workspace: bound } },
          contentDigest: null, binding, requiresConnections: component.requiresConnections || [] });
      }
    }
    return items;
  }
  get(profileId, hookId, workspace, version = 1) {
    if (version !== 1) fail("HOOK_NOT_FOUND");
    const candidate = this.candidates(profileId, workspace).find(item => item.hookId === hookId);
    if (!candidate) fail("HOOK_NOT_FOUND");
    const loaded = this.resolver.inspectFrozenHook(candidate.reference, candidate.boundWorkspace);
    return { ...candidate, ...loaded, contentDigest: digest(loaded.definition) };
  }
  publicRecord(candidate) {
    const { reference, binding, requiresConnections, sourceFile, ...record } = candidate;
    return { ...record, plugin: { installationId: reference.installationId, releaseDigest: reference.releaseDigest,
      componentId: reference.componentId, descriptorDigest: reference.descriptorDigest },
      grantValid: this.grantValid(candidate), testPassed: this.testValid(candidate) };
  }
  assertCandidate(candidate) {
    const installation = this.store.getInstallation(candidate.reference.installationId);
    if (!installation || installation.desiredState === "uninstalled" || installation.revision !== candidate.reference.installationRevision
      || installation.releaseDigest !== candidate.reference.releaseDigest || this.store.hasPendingInstallationDisable(installation.installationId)) fail("HOOK_REVOKED");
  }
  input(candidate) { return { profileId: candidate.profileId, installationId: candidate.reference.installationId,
    componentId: candidate.reference.componentId, releaseDigest: candidate.reference.releaseDigest }; }
  connections(candidate) {
    return candidate.requiresConnections.map(name => {
      const selectedId = componentId(candidate.reference.installationId, "mcp-server", name);
      const binding = this.store.listBindingsForProfile(candidate.profileId).find(row => row.installationId === candidate.reference.installationId && row.componentId === selectedId);
      const connection = binding && this.store.getConnection(binding.connectionId);
      if (!binding?.enabled || connection?.state !== "ready" || !connection.principalIdentity) fail("HOOK_PLUGIN_CONNECTION_REQUIRED");
      return { bindingId: binding.bindingId, bindingRevision: binding.revision,
        connectionId: connection.connectionId, authRevision: connection.authRevision, principalIdentity: connection.principalIdentity };
    });
  }
  grantValid(candidate) {
    const grant = candidate.binding?.grant;
    if (!grant || grant.incarnation !== this.store.getAuthorityIncarnation() || grant.contentDigest !== candidate.contentDigest
      || digest(grant.access) !== digest(dataAccess(candidate.definition))) return false;
    try { return digest(grant.connections) === digest(this.connections(candidate)); } catch { return false; }
  }
  testValid(candidate) {
    const receipt = candidate.binding?.test;
    return receipt?.passed === true && receipt.incarnation === this.store.getAuthorityIncarnation()
      && receipt.contentDigest === candidate.contentDigest;
  }
  grant(candidate) {
    this.assertCandidate(candidate);
    const grant = { incarnation: this.store.getAuthorityIncarnation(), contentDigest: candidate.contentDigest,
      access: dataAccess(candidate.definition), connections: this.connections(candidate) };
    this.store.setHookGrant(this.input(candidate), grant, candidate.definition.scope.workspace);
    return { hookId: candidate.hookId, version: 1, granted: true, grant: { ...grant.access, contentDigest: grant.contentDigest } };
  }
  recordTest(candidate, passed) {
    this.assertCandidate(candidate);
    this.store.recordHookTest(this.input(candidate), { passed, contentDigest: candidate.contentDigest,
      incarnation: this.store.getAuthorityIncarnation(), testedAt: this.now() });
  }
  enable(candidate, revision) {
    this.assertCandidate(candidate);
    const latest = this.get(candidate.profileId, candidate.hookId, candidate.definition.scope.workspace);
    if (!this.testValid(latest)) fail("HOOK_TEST_REQUIRED");
    if (!this.grantValid(latest)) fail("HOOK_GRANT_REQUIRED");
    this.store.setHookEnabled(this.input(latest), true, revision);
    return { ...this.publicRecord(this.get(candidate.profileId, candidate.hookId, candidate.definition.scope.workspace)), effectiveFrom: "next_run" };
  }
  disable(candidate, revision) {
    this.assertCandidate(candidate);
    const binding = this.store.setHookEnabled(this.input(candidate), false, revision);
    return { hookId: candidate.hookId, revision: binding.revision, disabled: true, removed: false,
      effectiveFrom: "immediate", epoch: binding.epoch };
  }
  entriesForRun(run) {
    return this.candidates(run.profileId, run.workspace).filter(item => item.binding?.enabled)
      .filter(item => item.definition.scope.sources.includes(run.source)
        && (item.definition.scope.workspace === null || item.definition.scope.workspace === run.workspace))
      .map(item => this.get(run.profileId, item.hookId, run.workspace))
      .map(item => {
        if (!this.grantValid(item) || !this.testValid(item)) fail("HOOK_REVOKED");
        return { hookId: item.hookId, version: 1, epoch: item.epoch, contentDigest: item.contentDigest,
          definition: item.definition, sourceFile: item.sourceFile, owner: "plugin", activatedAt: item.binding.updatedAt,
          pluginRef: { ...item.reference, profileId: run.profileId, workspace: item.definition.scope.workspace,
            bindingId: item.binding.bindingId, bindingRevision: item.binding.revision, grantDigest: digest(item.binding.grant),
            authorityIncarnation: this.store.getAuthorityIncarnation(), epoch: item.epoch } };
      });
  }
  hydrate(entry, snapshot) {
    const ref = entry.pluginRef;
    if (!ref || ref.profileId !== snapshot.profileId || entry.hookId !== hookIdFor(ref.profileId, ref.installationId, ref.releaseDigest, ref.componentId)) fail("HOOK_STORE_CORRUPT");
    const loaded = this.resolver.inspectFrozenHook(ref, ref.workspace);
    if (digest(loaded.definition) !== entry.contentDigest) fail("HOOK_SOURCE_CHANGED");
    return { ...entry, ...loaded };
  }
  assertCurrent(snapshot, entry) {
    const ref = entry.pluginRef, installation = this.store.getInstallation(ref.installationId);
    const binding = this.store.getHookBinding(snapshot.profileId, ref.installationId, ref.componentId);
    if (ref.authorityIncarnation !== this.store.getAuthorityIncarnation() || installation?.desiredState !== "enabled"
      || installation.revision !== ref.installationRevision || installation.releaseDigest !== ref.releaseDigest
      || this.store.hasPendingInstallationDisable(ref.installationId) || !binding?.enabled
      || binding.releaseDigest !== ref.releaseDigest || binding.revision !== ref.bindingRevision || binding.epoch !== ref.epoch
      || digest(binding.grant) !== ref.grantDigest) fail("HOOK_REVOKED");
    const release = this.store.getRelease(ref.sourceIdentity, ref.releaseDigest);
    const component = release.components.hooks.find(item => componentId(ref.installationId, "hook", item.name) === ref.componentId);
    if (!component || !this.grantValid({ definition: entry.definition, contentDigest: entry.contentDigest, binding,
      profileId: snapshot.profileId, reference: ref, requiresConnections: component.requiresConnections })) fail("HOOK_REVOKED");
  }
}
module.exports = { PluginHookRegistry, pluginHookIdFor: hookIdFor };
