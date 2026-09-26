"use strict";
const crypto = require("node:crypto");
const { componentId } = require("./plugin-component-catalog");
const { serviceError } = require("./security");
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const id = value => typeof value === "string" && ID.test(value);
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code = "PLUGIN_REQUEST_INVALID") => { throw serviceError(code, "插件账号断开请求无效或已变化"); };

class PluginConnectionController {
  #pending = new Map();
  #cleanup = new Map();
  constructor({ store, productStore, drainConnection, cancelStaleOAuth, invalidateConnection,
    now = Date.now, onPhase = null } = {}) {
    if (typeof store?.disconnectMcpConnection !== "function" || typeof store?.listBindingsForConnection !== "function"
      || typeof productStore?.getAgentProfile !== "function" || typeof drainConnection !== "function"
      || typeof cancelStaleOAuth !== "function" || typeof invalidateConnection !== "function"
      || typeof now !== "function" || (onPhase !== null && typeof onPhase !== "function")) {
      throw new TypeError("PluginConnectionController requires trusted Service dependencies");
    }
    Object.assign(this, { store, productStore, drainConnection, cancelStaleOAuth, invalidateConnection, now, onPhase });
  }
  #request(input) {
    if (!exact(input, ["profileId", "bindingId", "expectedRevision", "operationId"])
      || !["profileId", "bindingId", "operationId"].every(key => id(input[key]))
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail();
    return { profileId: input.profileId, bindingId: input.bindingId,
      expectedRevision: input.expectedRevision, operationId: input.operationId };
  }
  #existing(input) {
    const operation = this.store.getOperation(input.operationId);
    if (!operation) return null;
    if (operation.kind !== "mcp-disconnect") fail("REVISION_CONFLICT");
    if (operation.phase === "outcome_unknown"
      || operation.result?.authorityIncarnation !== this.store.getAuthorityIncarnation()) {
      fail("PLUGIN_OPERATION_OUTCOME_UNKNOWN");
    }
    if (operation.phase !== "completed" || digest(operation.result.request) !== digest(input)) fail("REVISION_CONFLICT");
    return operation.result;
  }
  #context(input) {
    const profile = this.productStore.getAgentProfile(input.profileId), binding = this.store.getBinding(input.bindingId);
    if (!profile || !binding || binding.subjectKind !== "native-profile" || binding.subjectId !== input.profileId
      || binding.componentKind !== "mcp-server") fail("PLUGIN_BINDING_INVALID");
    if (binding.revision !== input.expectedRevision) fail("REVISION_CONFLICT");
    const connection = this.store.getConnectionAuth(binding.connectionId);
    if (!connection || connection.installationId !== binding.installationId
      || connection.componentId !== binding.componentId) fail("PLUGIN_CONNECTION_INVALID");
    const installation = this.store.getInstallation(binding.installationId);
    const release = installation && this.store.getRelease(installation.sourceIdentity, installation.releaseDigest);
    if (!release) fail("PLUGIN_INSTALLATION_INVALID");
    const component = release.components.mcpServers.find(item =>
      componentId(binding.installationId, "mcp-server", item.name) === binding.componentId);
    const bindings = this.store.listBindingsForConnection(connection.connectionId);
    if (bindings.length > 1024) fail("PLUGIN_CONNECTION_LIMIT");
    return { authorityIncarnation: this.store.getAuthorityIncarnation(), profile, binding,
      connection, installation, releaseName: release.name, componentName: component?.name || "MCP", bindings };
  }
  #summary(context) {
    return { action: "mcp-disconnect", agent: context.profile.name, package: context.releaseName,
      capability: context.componentName, affectedBindings: context.bindings.length,
      credentialDisposition: context.connection.credentialRef ? "retained_encrypted_unusable" : "none" };
  }
  prepare(raw) {
    const input = this.#request(raw), existing = this.#existing(input);
    const context = existing ? null : this.#context(input);
    for (const [key, pending] of this.#pending) if (pending.expiresAt <= this.now()) this.#pending.delete(key);
    if (this.#pending.size >= 32) fail("PLUGIN_CONSENT_BUSY");
    const challenge = crypto.randomUUID(), expiresAt = this.now() + 120_000;
    this.#pending.set(challenge, { input, context: context ? structuredClone(context) : null, expiresAt });
    return { challenge, expiresAt, summary: existing?.summary || this.#summary(context) };
  }
  #receipt(result) {
    const cleanup = this.#cleanup.get(result.request.operationId);
    return { ...result.receipt, cleanupStatus: cleanup?.status || "pending",
      reasonCode: cleanup?.reasonCode || (cleanup ? null : "PLUGIN_CONNECTION_CLEANUP_PENDING") };
  }
  async #finish(result) {
    const current = this.store.getConnection(result.connectionId);
    // A historical receipt cannot touch a newer identity, or revive any rights.
    if (result.authorityIncarnation !== this.store.getAuthorityIncarnation()
      || !current || current.state !== "disconnected" || current.revision !== result.connectionRevision) {
      this.#cleanup.set(result.request.operationId, { status: "pending", reasonCode: "CONNECTION_IDENTITY_CHANGED" });
      return this.#receipt(result);
    }
    const outcomes = await Promise.allSettled([
      () => this.invalidateConnection(result.connectionId),
      () => this.cancelStaleOAuth(result.bindings), () => this.drainConnection(result.connectionId),
    ].map(task => Promise.resolve().then(task)));
    const failed = outcomes.some(outcome => outcome.status === "rejected");
    this.#cleanup.set(result.request.operationId, { status: failed ? "pending" : "complete",
      reasonCode: failed ? "PLUGIN_CONNECTION_CLEANUP_PENDING" : null });
    if (this.#cleanup.size > 256) this.#cleanup.delete(this.#cleanup.keys().next().value);
    return this.#receipt(result);
  }
  async commit(input) {
    if (!exact(input, ["challenge", "approved"]) || !id(input.challenge) || typeof input.approved !== "boolean") fail();
    const pending = this.#pending.get(input.challenge); this.#pending.delete(input.challenge);
    if (!pending || pending.expiresAt <= this.now()) fail("PLUGIN_CONSENT_EXPIRED");
    if (!input.approved) return { canceled: true, receipt: null };
    let result = this.#existing(pending.input);
    if (!result) {
      const context = this.#context(pending.input);
      if (digest(context) !== digest(pending.context)) fail("REVISION_CONFLICT");
      result = this.store.performManagementOperation({ operationId: pending.input.operationId, kind: "mcp-disconnect",
        fingerprint: digest(["mcp-disconnect", context.authorityIncarnation, pending.input]), apply: () => {
          const changed = this.store.disconnectMcpConnection({ connectionId: context.connection.connectionId,
            expectedRevision: context.connection.revision });
          const binding = changed.bindings.find(item => item.bindingId === context.binding.bindingId);
          return { request: pending.input, authorityIncarnation: context.authorityIncarnation,
            connectionId: changed.connection.connectionId, connectionRevision: changed.connection.revision,
            bindings: changed.bindings, summary: this.#summary(context), receipt: {
              kind: "mcp-disconnect", profileId: pending.input.profileId, bindingId: binding.bindingId,
              revision: binding.revision, connectionId: changed.connection.connectionId,
              affectedBindings: changed.bindings.length, credentialDisposition: this.#summary(context).credentialDisposition } };
        } }).result;
      this.onPhase?.("authority-disconnected");
    }
    return { canceled: false, receipt: await this.#finish(result) };
  }
  operation(input) {
    if (!exact(input, ["profileId", "operationId"]) || !id(input.profileId) || !id(input.operationId)) fail();
    const operation = this.store.getOperation(input.operationId);
    if (operation && operation.kind !== "mcp-disconnect") fail("REVISION_CONFLICT");
    if (operation?.result?.request && operation.result.request.profileId !== input.profileId) fail("PLUGIN_BINDING_INVALID");
    const unknown = operation && (operation.phase === "outcome_unknown"
      || operation.result?.authorityIncarnation !== this.store.getAuthorityIncarnation());
    return { operationId: input.operationId, found: Boolean(operation),
      phase: unknown ? "outcome_unknown" : operation?.phase || null,
      receipt: operation && !unknown ? this.#receipt(operation.result) : null,
      reasonCode: unknown ? "PLUGIN_RESTORE_RECONCILIATION_REQUIRED" : null };
  }
  clear() { this.#pending.clear(); this.#cleanup.clear(); }
}
module.exports = { PluginConnectionController };
