"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const TOOL = /^plugin:[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[a-f0-9]{64}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[a-f0-9]{64}$/u;
const id = value => typeof value === "string" && ID.test(value);
const hash = value => typeof value === "string" && HASH.test(value);
const fingerprint = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code = "PLUGIN_REQUEST_INVALID") => { throw serviceError(code, "插件授权请求已失效或无效"); };
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));

// Challenges travel only on authenticated Service IPC and stay in the UI Host.
// The REST response never contains one. Electron's native confirmation is the
// authority broadening decision; a web Origin is only a CSRF check.
class PluginMcpConsent {
  #pending = new Map();
  constructor({ store, productStore, manager, registry, now = Date.now }) {
    Object.assign(this, { store, productStore, manager, registry, now });
  }

  #context(input) {
    const profile = this.productStore.getAgentProfile(input.profileId);
    if (!profile?.enabled) fail("PLUGIN_BINDING_INVALID");
    if (input.action === "connect") {
      const result = this.manager.component(input.installationId, input.componentId);
      if (result.installation.revision !== input.expectedRevision) fail("REVISION_CONFLICT");
      if (result.component.transport !== "stdio") fail("CONNECTION_AUTH_REQUIRED");
      this.manager.planner.planStdio(result.input); // validation only; no process
      const binding = this.store.listBindingsForProfile(profile.id).find(item =>
        item.installationId === input.installationId && item.componentId === input.componentId);
      return { ...result, profile, binding };
    }
    const binding = this.store.getBinding(input.bindingId);
    if (!binding?.enabled || binding.subjectId !== profile.id
      || binding.componentKind !== "mcp-server") fail("PLUGIN_BINDING_INVALID");
    const installation = this.store.getInstallation(binding.installationId);
    if (installation?.desiredState !== "enabled"
      || this.store.hasPendingInstallationDisable(binding.installationId)) fail("PLUGIN_COMPONENT_INACTIVE");
    const connection = this.store.getConnection(binding.connectionId);
    const tool = this.registry.resolve({ installation: { ...installation,
      activeReleaseDigest: installation.releaseDigest }, binding, connection,
      toolIdentity: input.toolIdentity });
    if (!tool || tool.contractDigest !== input.contractDigest
      || tool.catalogRevision !== input.catalogRevision) fail("TOOL_CONTRACT_CHANGED");
    const grant = this.store.getGrant(binding.bindingId, tool.toolIdentity);
    if ((grant?.revision || 0) !== input.expectedRevision) fail("REVISION_CONFLICT");
    return { profile, installation, binding, connection, tool, grant };
  }

  prepare(input) {
    const fields = input?.action === "connect"
      ? ["action", "profileId", "installationId", "componentId", "expectedRevision", "operationId"]
      : ["action", "profileId", "bindingId", "toolIdentity", "contractDigest", "catalogRevision", "approvalMode", "expectedRevision", "operationId"];
    if (!exact(input, fields) || !["connect", "allow"].includes(input.action)
      || !id(input.profileId) || !id(input.operationId)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
      || (input.action === "connect" ? !id(input.installationId) || !hash(input.componentId)
        : !id(input.bindingId) || typeof input.toolIdentity !== "string"
          || !TOOL.test(input.toolIdentity) || !hash(input.contractDigest)
          || !["always", "each-call"].includes(input.approvalMode)
          || typeof input.catalogRevision !== "string" || input.catalogRevision.length > 128)) fail();
    const context = this.#context(input);
    for (const [key, value] of this.#pending) if (value.expiresAt <= this.now()) this.#pending.delete(key);
    if (this.#pending.size >= 32) fail("PLUGIN_CONSENT_BUSY");
    const challenge = crypto.randomUUID();
    const expiresAt = this.now() + 120_000;
    // Includes exact binding/account/generation in the native confirmation fence.
    const fence = fingerprint(context);
    this.#pending.set(challenge, { input: structuredClone(input), fence, expiresAt });
    const summary = input.action === "connect" ? {
      action: "connect", agent: context.profile.name, package: context.release.name,
      capability: context.component.name, approvalMode: null,
    } : { action: "allow", agent: context.profile.name,
      package: this.store.getRelease(context.installation.sourceIdentity,
        context.installation.releaseDigest).name, capability: context.tool.downstreamName,
      approvalMode: input.approvalMode };
    return { challenge, expiresAt, summary };
  }

  async commit({ challenge, approved }) {
    if (typeof challenge !== "string" || typeof approved !== "boolean") fail();
    const pending = this.#pending.get(challenge);
    this.#pending.delete(challenge);
    if (!pending || pending.expiresAt <= this.now()) fail("PLUGIN_CONSENT_EXPIRED");
    if (!approved) return { canceled: true, receipt: null };
    const { input } = pending;
    const current = this.#context(input);
    if (fingerprint(current) !== pending.fence) fail("REVISION_CONFLICT");
    const kind = input.action === "connect" ? "mcp-connect" : "grant-allow";
    const operation = this.store.performManagementOperation({ operationId: input.operationId,
      kind, fingerprint: fingerprint(input), apply: () => {
        let binding = current.binding;
        if (input.action === "connect") {
          const existing = binding && this.store.getConnection(binding.connectionId);
          const connectionId = existing?.endpointIdentity === `stdio:${current.component.descriptorDigest}`
            ? existing.connectionId : fingerprint(["local-connection", input.profileId,
              input.installationId, input.componentId, current.component.descriptorDigest]);
          let connection = this.store.getConnection(connectionId) || this.store.createConnection({
            connectionId, installationId: input.installationId, componentId: input.componentId,
            endpointIdentity: `stdio:${current.component.descriptorDigest}` });
          if (connection.state !== "ready") connection = this.store.setConnectionIdentity({
            connectionId, principalIdentity: `local:${process.getuid?.() ?? "user"}`,
            state: "ready", expectedRevision: connection.revision });
          binding ||= this.store.createBinding({ bindingId: fingerprint(["mcp-binding", input.profileId,
            input.installationId, input.componentId]), profileId: input.profileId,
          installationId: input.installationId, componentId: input.componentId, connectionId });
          if (binding.connectionId !== connectionId) binding = this.store.setMcpBindingConnection({
            bindingId: binding.bindingId, connectionId, expectedRevision: binding.revision });
          binding = this.store.setBindingEnabled({ bindingId: binding.bindingId,
            enabled: true, expectedRevision: binding.revision });
          return { kind, profileId: input.profileId, bindingId: binding.bindingId,
            toolIdentity: null, revision: binding.revision };
        }
        const grant = this.store.setGrant({ grantId: current.grant?.grantId
          || fingerprint(["grant", binding.bindingId, input.toolIdentity]),
        bindingId: binding.bindingId, toolIdentity: input.toolIdentity,
        contractDigest: input.contractDigest, effect: "allow", approvalMode: input.approvalMode,
        expectedRevision: input.expectedRevision });
        return { kind, profileId: input.profileId, bindingId: binding.bindingId,
          toolIdentity: input.toolIdentity, revision: grant.revision };
      } });
    return { canceled: false, receipt: operation.result };
  }

  async discover({ profileId, bindingId }) {
    const profile = this.productStore.getAgentProfile(profileId);
    const binding = this.store.getBinding(bindingId);
    if (!profile?.enabled || !binding?.enabled || binding.subjectId !== profileId
      || binding.componentKind !== "mcp-server") fail("PLUGIN_BINDING_INVALID");
    const installation = this.store.getInstallation(binding.installationId);
    const connection = this.store.getConnection(binding.connectionId);
    const handle = await this.manager.acquire({ installation, binding, connection });
    try {
      if (!this.productStore.getAgentProfile(profileId)?.enabled
        || JSON.stringify(this.store.getBinding(bindingId)) !== JSON.stringify(binding)
        || JSON.stringify(this.store.getConnection(connection.connectionId)) !== JSON.stringify(connection)
        || JSON.stringify(this.store.getInstallation(installation.installationId)) !== JSON.stringify(installation)
        || this.store.hasPendingInstallationDisable(installation.installationId)) fail("CONNECTION_IDENTITY_CHANGED");
      const snapshot = await this.registry.refresh({ installation, connection, client: handle });
      // Archive/disconnect during tools/list cannot publish a usable result.
      if (!this.productStore.getAgentProfile(profileId)?.enabled
        || JSON.stringify(this.store.getBinding(bindingId)) !== JSON.stringify(binding)
        || JSON.stringify(this.store.getConnection(connection.connectionId)) !== JSON.stringify(connection)
        || JSON.stringify(this.store.getInstallation(installation.installationId)) !== JSON.stringify(installation)
        || this.store.hasPendingInstallationDisable(installation.installationId)) {
        this.registry.invalidate(connection.connectionId);
        fail("CONNECTION_IDENTITY_CHANGED");
      }
      return { profileId, bindingId, catalogRevision: snapshot.catalogRevision };
    } finally { await handle.release(); }
  }

  clear() { this.#pending.clear(); }
}

module.exports = { PluginMcpConsent };
