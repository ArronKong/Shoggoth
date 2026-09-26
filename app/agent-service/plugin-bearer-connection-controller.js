"use strict";

const crypto = require("node:crypto");
const { newPluginBearerCredentialRef } = require("./plugin-credential-vault");
const { verifyGitHubBearer } = require("./plugin-github-bearer-verifier");
const { serviceError } = require("./security");

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const ENDPOINT = "https://api.githubcopilot.com/mcp/";
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = (code = "PLUGIN_REQUEST_INVALID") => {
  throw serviceError(code, "GitHub 插件连接请求无效或已变化");
};

class PluginBearerConnectionController {
  #pending = new Map();
  #active = new Set();
  #closed = false;

  constructor({ store, productStore, manager, vault, verifyBearer = verifyGitHubBearer,
    now = Date.now } = {}) {
    if (typeof store?.performManagementOperation !== "function"
      || typeof store?.createConnection !== "function"
      || typeof productStore?.getAgentProfile !== "function"
      || typeof manager?.component !== "function"
      || typeof vault?.storeVerifiedBearer !== "function"
      || typeof verifyBearer !== "function" || typeof now !== "function") {
      throw new TypeError("Bearer controller requires trusted Service dependencies");
    }
    Object.assign(this, { store, productStore, manager, vault, verifyBearer, now });
  }

  #context(input) {
    if (this.#closed) fail("PLUGIN_UNAVAILABLE");
    const profile = this.productStore.getAgentProfile(input.profileId);
    if (!profile?.enabled) fail("PLUGIN_BINDING_INVALID");
    const context = this.manager.component(input.installationId, input.componentId);
    if (context.installation.revision !== input.expectedRevision) fail("REVISION_CONFLICT");
    if (context.installation.sourceIdentity !== "bundled:github"
      || context.component.name !== "github"
      || context.component.transport !== "streamable-http"
      || context.component.spec.url !== ENDPOINT) fail("PLUGIN_BEARER_PROVIDER_UNSUPPORTED");
    const binding = this.store.listGlobalBindings().find(item =>
      item.installationId === input.installationId && item.componentId === input.componentId) || null;
    return { profile, ...context, binding };
  }

  #fence(context) {
    return digest({ authority: this.store.getAuthorityIncarnation(), profile: context.profile,
      installation: context.installation, descriptor: context.component.descriptorDigest,
      endpoint: context.component.spec.url, binding: context.binding });
  }

  prepare(input) {
    if (!exact(input, ["profileId", "installationId", "componentId", "expectedRevision", "operationId"])
      || !["profileId", "installationId", "operationId"].every(key =>
        typeof input[key] === "string" && ID.test(input[key]))
      || typeof input.componentId !== "string" || !HASH.test(input.componentId)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail();
    for (const [key, pending] of this.#pending) {
      if (pending.expiresAt <= this.now()) this.#pending.delete(key);
    }
    if (this.#pending.size >= 32) fail("PLUGIN_CONNECTION_LIMIT");
    const context = this.#context(input);
    const challenge = crypto.randomUUID(), expiresAt = this.now() + 120_000;
    this.#pending.set(challenge, { input: structuredClone(input), fence: this.#fence(context), expiresAt });
    return { challenge, expiresAt, summary: { action: "bearer-connect", agent: "所有助理",
      package: context.release.name, capability: context.component.name,
      provider: "GitHub", reconnect: context.binding !== null } };
  }

  async commit(input) {
    if (!exact(input, ["challenge", "approved", "accessToken"])
      || typeof input.challenge !== "string" || !ID.test(input.challenge)
      || typeof input.approved !== "boolean"
      || (input.approved ? typeof input.accessToken !== "string" || input.accessToken.length > 16_384
        : input.accessToken !== null)) fail();
    const pending = this.#pending.get(input.challenge);
    this.#pending.delete(input.challenge);
    if (!pending || pending.expiresAt <= this.now() || this.#closed) fail("PLUGIN_CONSENT_EXPIRED");
    if (!input.approved) return { canceled: true, receipt: null };
    const key = `${pending.input.installationId}:${pending.input.componentId}`;
    if (this.#active.has(key)) fail("PLUGIN_CONNECTION_LIMIT");
    this.#active.add(key);
    let connectionId = null;
    try {
      const before = this.#context(pending.input);
      if (this.#fence(before) !== pending.fence
        || this.store.getOperation(pending.input.operationId)) fail("REVISION_CONFLICT");
      // The verifier is pinned to GitHub's authenticated-user endpoint in
      // production. No connection or binding changes until identity is proven.
      const principalIdentity = await this.verifyBearer(input.accessToken);
      if (typeof principalIdentity !== "string" || !/^github:[1-9][0-9]{0,19}$/u.test(principalIdentity)) {
        fail("CONNECTION_AUTH_REQUIRED");
      }
      const current = this.#context(pending.input);
      if (this.#fence(current) !== pending.fence
        || this.store.getOperation(pending.input.operationId)) fail("REVISION_CONFLICT");
      connectionId = digest(["bearer", pending.input.installationId,
        pending.input.componentId, pending.input.operationId]);
      if (this.store.getConnection(connectionId)) fail("REVISION_CONFLICT");
      this.store.createConnection({ connectionId, installationId: pending.input.installationId,
        componentId: pending.input.componentId, endpointIdentity: ENDPOINT,
        credentialRef: newPluginBearerCredentialRef() });
      await this.vault.storeVerifiedBearer({ connectionId, expectedRevision: 1,
        accessToken: input.accessToken, principalIdentity });
      const result = this.store.performManagementOperation({
        operationId: pending.input.operationId, kind: "mcp-connect",
        fingerprint: digest(["bearer-connect", pending.input, principalIdentity, connectionId]),
        apply: () => {
          const latest = this.#context(pending.input);
          if (this.#fence(latest) !== pending.fence) fail("REVISION_CONFLICT");
          let binding = latest.binding;
          if (!binding) binding = this.store.createGlobalBinding({
            bindingId: digest(["mcp-binding", "all-agents", pending.input.installationId,
              pending.input.componentId]), installationId: pending.input.installationId,
            componentId: pending.input.componentId, connectionId });
          else binding = this.store.setMcpBindingConnection({ bindingId: binding.bindingId,
            connectionId, expectedRevision: binding.revision });
          binding = this.store.setBindingEnabled({ bindingId: binding.bindingId,
            enabled: true, expectedRevision: binding.revision });
          return { kind: "mcp-connect", profileId: pending.input.profileId,
            bindingId: binding.bindingId, toolIdentity: null, revision: binding.revision };
        },
      });
      return { canceled: false, receipt: result.result };
    } catch (error) {
      // A failed identity or stale fence leaves the previous binding intact.
      // An orphaned new connection is explicitly disabled; its encrypted
      // credential is retained only as an unusable audit artifact.
      if (connectionId) {
        try {
          const connection = this.store.getConnection(connectionId);
          if (connection && connection.state !== "disconnected"
            && !this.store.listBindingsForConnection(connectionId).length) {
            this.store.disconnectMcpConnection({ connectionId, expectedRevision: connection.revision });
          }
        } catch { /* Original failure remains authoritative; no binding was granted. */ }
      }
      throw error;
    } finally { this.#active.delete(key); }
  }

  clear() { this.#closed = true; this.#pending.clear(); }
}

module.exports = { PluginBearerConnectionController };
