"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");
const { slackDispatchToolAccess } = require("./plugin-slack-access-policy");
const { SOURCE_IDENTITY: CLOUDFLARE_SOURCE, cloudflareToolAccess } =
  require("./plugin-cloudflare-access-policy");
const { ENDPOINT: FIGMA_DESKTOP_ENDPOINT,
  isFigmaDesktopComponent } = require("../core/figma-desktop-mcp");
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
      if (result.component.transport === "stdio") {
        this.manager.planner.planStdio(result.input); // validation only; no process
      } else if (!isFigmaDesktopComponent(result)) fail("CONNECTION_AUTH_REQUIRED");
      const binding = this.store.listGlobalBindings().find(item =>
        item.installationId === input.installationId && item.componentId === input.componentId);
      return { ...result, profile, binding };
    }
    const binding = this.store.getBinding(input.bindingId);
    if (!binding?.enabled || !((binding.subjectKind === "global" && binding.subjectId === "all-agents")
      || (binding.subjectKind === "native-profile" && binding.subjectId === profile.id))
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
    if (installation.sourceIdentity === "bundled:slack") {
      const scopes = typeof this.manager.slackScopes === "function"
        ? this.manager.slackScopes(connection?.principalIdentity) : null;
      const access = slackDispatchToolAccess({ installation, binding }, tool.downstreamName, scopes);
      if (!access.allowed || (access.requiresEachCall && input.approvalMode !== "each-call")) {
        fail("CAPABILITY_FORBIDDEN");
      }
    }
    if (installation.sourceIdentity === CLOUDFLARE_SOURCE) {
      const access = cloudflareToolAccess({ installation, connection }, tool.downstreamName);
      if (!access.allowed || (access.requiresEachCall && input.approvalMode !== "each-call")) {
        fail("CAPABILITY_FORBIDDEN");
      }
    }
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
      action: "connect", agent: "所有助理", package: context.release.name,
      capability: context.component.name, approvalMode: null,
    } : { action: "allow", agent: context.binding.subjectKind === "global" ? "所有助理" : context.profile.name,
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
    if (input.action === "connect" && isFigmaDesktopComponent(current)) {
      await this.manager.probeFigmaDesktop(current.input);
      if (fingerprint(this.#context(input)) !== pending.fence) fail("REVISION_CONFLICT");
    }
    const kind = input.action === "connect" ? "mcp-connect" : "grant-allow";
    const operation = this.store.performManagementOperation({ operationId: input.operationId,
      kind, fingerprint: fingerprint(input), apply: () => {
        let binding = current.binding;
        if (input.action === "connect") {
          const endpointIdentity = isFigmaDesktopComponent(current)
            ? FIGMA_DESKTOP_ENDPOINT : `stdio:${current.component.descriptorDigest}`;
          const existing = binding && this.store.getConnection(binding.connectionId);
          const connectionId = existing?.endpointIdentity === endpointIdentity
            ? existing.connectionId : fingerprint(["local-connection", "all-agents",
              input.installationId, input.componentId, current.component.descriptorDigest,
              endpointIdentity]);
          let connection = this.store.getConnection(connectionId) || this.store.createConnection({
            connectionId, installationId: input.installationId, componentId: input.componentId,
            endpointIdentity });
          if (connection.state !== "ready") connection = this.store.setConnectionIdentity({
            connectionId, principalIdentity: `local:${process.getuid?.() ?? "user"}`,
            state: "ready", expectedRevision: connection.revision });
          binding ||= this.store.createGlobalBinding({ bindingId: fingerprint(["mcp-binding", "all-agents",
            input.installationId, input.componentId]),
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

  async discover({ profileId, bindingId }, { assertCurrent = null } = {}) {
    if (assertCurrent !== null && typeof assertCurrent !== "function") fail();
    const profile = this.productStore.getAgentProfile(profileId);
    const binding = this.store.getBinding(bindingId);
    if (!profile?.enabled || !binding?.enabled
      || !((binding.subjectKind === "global" && binding.subjectId === "all-agents")
        || (binding.subjectKind === "native-profile" && binding.subjectId === profileId))
      || binding.componentKind !== "mcp-server") fail("PLUGIN_BINDING_INVALID");
    const installation = this.store.getInstallation(binding.installationId);
    const connection = this.store.getConnection(binding.connectionId);
    const checkpoint = () => {
      if (!this.productStore.getAgentProfile(profileId)?.enabled
        || !connection || JSON.stringify(this.store.getBinding(bindingId)) !== JSON.stringify(binding)
        || JSON.stringify(this.store.getConnection(connection.connectionId)) !== JSON.stringify(connection)
        || JSON.stringify(this.store.getInstallation(binding.installationId)) !== JSON.stringify(installation)
        || this.store.hasPendingInstallationDisable(binding.installationId)) fail("CONNECTION_IDENTITY_CHANGED");
      if (assertCurrent !== null) {
        const current = assertCurrent();
        if (current === false || (current && typeof current.then === "function")) fail("CONNECTION_IDENTITY_CHANGED");
      }
    };
    checkpoint();
    const handle = await this.manager.acquire({ installation, binding, connection });
    let snapshot;
    try {
      checkpoint();
      snapshot = await this.registry.refresh({ installation, connection, client: handle,
        assertCurrent: checkpoint });
      checkpoint();
      return { profileId, bindingId, catalogRevision: snapshot.catalogRevision };
    } catch (error) {
      // A different discovery may already own the current slot. Revoke only
      // the exact catalog this invocation published, never its successor.
      if (snapshot) this.registry.invalidate(connection.connectionId, snapshot.catalogRevision);
      throw error;
    } finally { await handle.release(); }
  }

  clear() { this.#pending.clear(); }
}

module.exports = { PluginMcpConsent };
