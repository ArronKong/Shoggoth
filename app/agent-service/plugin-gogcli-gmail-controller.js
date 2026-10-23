"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");
const { SOURCE_IDENTITY, COMPONENT_NAME, TRANSPORT, endpointIdentity } =
  require("./plugin-gogcli-gmail-sidecar");
const { EMAIL } = require("./plugin-gogcli-gmail-runtime");

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const ACTIVE = new Set(["pending", "verifying"]);
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const fail = (code = "PLUGIN_REQUEST_INVALID") => { throw serviceError(code, "Gmail 连接请求无效或已失效"); };

class GogGmailConnectionController {
  #flows = new Map();
  #active = new Set();
  #closed = false;

  constructor({ store, productStore, manager, runtime, now = Date.now } = {}) {
    if (typeof store?.performManagementOperation !== "function"
      || typeof productStore?.getAgentProfile !== "function"
      || typeof manager?.component !== "function" || typeof runtime?.authorize !== "function"
      || typeof runtime?.hasPendingAuthorization !== "function"
      || typeof runtime?.commitAuthorization !== "function"
      || typeof runtime?.pendingAuthorization !== "function"
      || typeof runtime?.reconcilePendingAuthorization !== "function") {
      throw new TypeError("Gmail controller requires trusted Service dependencies");
    }
    Object.assign(this, { store, productStore, manager, runtime, now });
  }

  #context(input) {
    if (this.#closed) fail("CONNECTION_AUTH_REQUIRED");
    const profile = this.productStore.getAgentProfile(input.profileId);
    if (!profile?.enabled) fail("PLUGIN_BINDING_INVALID");
    const component = this.manager.component(input.installationId, input.componentId);
    if (component.installation.revision !== input.expectedRevision) fail("REVISION_CONFLICT");
    if (component.installation.sourceIdentity !== SOURCE_IDENTITY
      || component.component.name !== COMPONENT_NAME
      || component.component.transport !== TRANSPORT
      || JSON.stringify(component.component.spec) !== JSON.stringify({ type: TRANSPORT })) {
      fail("CONNECTION_AUTH_REQUIRED");
    }
    const binding = this.store.listGlobalBindings().find(item =>
      item.installationId === input.installationId && item.componentId === input.componentId) || null;
    return { profile, installation: component.installation, binding,
      descriptorDigest: component.component.descriptorDigest,
      policyRevision: this.runtime.capabilities().revision };
  }

  #validate(input) {
    if (!exact(input, ["profileId", "installationId", "componentId", "expectedRevision", "operationId", "email"])
      || !["profileId", "installationId", "operationId"].every(key =>
        typeof input[key] === "string" && ID.test(input[key]))
      || typeof input.componentId !== "string" || !HASH.test(input.componentId)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
      || typeof input.email !== "string" || !EMAIL.test(input.email)
      || input.email.length > 254) fail("GMAIL_AUTH_INVALID");
  }

  start(input) {
    this.#sweep();
    this.#validate(input);
    if (!this.runtime.status().configured) fail("GMAIL_REGISTRATION_INVALID");
    const context = this.#context(input);
    const key = `${input.installationId}:${input.componentId}`;
    if (this.#active.has(key) || this.#flows.size >= 128
      || this.store.getOperation(input.operationId)) fail("PLUGIN_CONNECTION_LIMIT");
    const flow = { flowId: crypto.randomUUID(), input: structuredClone(input), key,
      status: "pending", expiresAt: this.now() + 330_000, reasonCode: null,
      bindingId: null, receipt: null, fence: digest(context), abort: new AbortController(),
      cancelRequested: false, timedOut: false };
    this.#active.add(key);
    this.#flows.set(flow.flowId, flow);
    void this.#complete(flow).finally(() => this.#active.delete(key)).catch(() => {});
    return { canceled: false, flow: this.#public(flow) };
  }

  async #complete(flow) {
    let connectionId = null;
    try {
      const email = await this.runtime.authorize(flow.input.email, { signal: flow.abort.signal });
      if (flow.abort.signal.aborted || flow.status !== "pending") {
        fail("GMAIL_AUTH_CANCELED");
      }
      flow.status = "verifying";
      if (flow.expiresAt <= this.now() || digest(this.#context(flow.input)) !== flow.fence) {
        fail("CONNECTION_IDENTITY_CHANGED");
      }
      connectionId = digest(["gogcli-gmail", flow.input.installationId,
        flow.input.componentId, flow.input.operationId]);
      if (this.store.getConnection(connectionId) || this.store.getOperation(flow.input.operationId)) {
        fail("REVISION_CONFLICT");
      }
      const current = this.manager.component(flow.input.installationId, flow.input.componentId);
      this.store.createConnection({ connectionId, installationId: flow.input.installationId,
        componentId: flow.input.componentId,
        endpointIdentity: endpointIdentity(current.component.descriptorDigest) });
      this.store.setConnectionIdentity({ connectionId, principalIdentity: `gmail:${email}`,
        state: "ready", expectedRevision: 1 });
      if (flow.abort.signal.aborted || digest(this.#context(flow.input)) !== flow.fence) {
        fail("CONNECTION_IDENTITY_CHANGED");
      }
      const operation = this.store.performManagementOperation({ operationId: flow.input.operationId,
        kind: "mcp-connect", fingerprint: digest(["gogcli-gmail", flow.input,
          connectionId]), apply: () => {
          if (flow.abort.signal.aborted || digest(this.#context(flow.input)) !== flow.fence) {
            fail("CONNECTION_IDENTITY_CHANGED");
          }
          let binding = this.#context(flow.input).binding;
          if (!binding) binding = this.store.createGlobalBinding({
            bindingId: digest(["mcp-binding", "all-agents", flow.input.installationId,
              flow.input.componentId]), installationId: flow.input.installationId,
            componentId: flow.input.componentId, connectionId });
          else binding = this.store.setMcpBindingConnection({ bindingId: binding.bindingId,
            connectionId, expectedRevision: binding.revision });
          binding = this.store.setBindingEnabled({ bindingId: binding.bindingId,
            enabled: true, expectedRevision: binding.revision });
          return { kind: "mcp-connect", profileId: flow.input.profileId,
            bindingId: binding.bindingId, toolIdentity: null, revision: binding.revision };
        } });
      flow.receipt = operation.result;
      flow.bindingId = operation.result.bindingId;
      // The gog refresh token is already in Keychain. Only release the durable
      // recovery marker after the binding transaction has committed.
      this.runtime.commitAuthorization(email);
      flow.status = "ready";
    } catch (error) {
      const recoveryRequired = this.runtime.hasPendingAuthorization()
        || error?.code === "GMAIL_AUTH_RECOVERY_REQUIRED";
      if (recoveryRequired) {
        flow.status = "failed";
        flow.reasonCode = "GMAIL_AUTH_RECOVERY_REQUIRED";
      } else if (flow.timedOut) {
        flow.status = "failed";
        flow.reasonCode = "GMAIL_AUTH_FAILED";
      } else if (flow.cancelRequested || error?.code === "GMAIL_AUTH_CANCELED") {
        flow.status = "canceled";
        flow.reasonCode = null;
      } else {
        flow.status = "failed";
        flow.reasonCode = typeof error?.code === "string" ? error.code : "GMAIL_AUTH_FAILED";
      }
      if (connectionId && !this.store.listBindingsForConnection(connectionId).length) {
        try {
          const connection = this.store.getConnection(connectionId);
          if (connection && connection.state !== "disconnected") this.store.disconnectMcpConnection({
            connectionId, expectedRevision: connection.revision });
        } catch { /* An unusable orphan must never replace a verified binding. */ }
      }
    }
  }

  #public(flow) {
    return { flowId: flow.flowId, status: flow.status, expiresAt: flow.expiresAt,
      reasonCode: flow.reasonCode, bindingId: flow.bindingId,
      receipt: flow.receipt ? { ...flow.receipt } : null };
  }
  #selected(input) {
    this.#sweep();
    if (!exact(input, ["profileId", "flowId"]) || typeof input.profileId !== "string"
      || !ID.test(input.profileId) || typeof input.flowId !== "string" || !ID.test(input.flowId)) fail();
    const flow = this.#flows.get(input.flowId);
    if (!flow || flow.input.profileId !== input.profileId) fail("GMAIL_AUTH_FLOW_NOT_FOUND");
    return flow;
  }
  status(input) {
    const flow = this.#selected(input);
    if (ACTIVE.has(flow.status) && flow.expiresAt <= this.now()) {
      flow.timedOut = true; flow.abort.abort();
    }
    return this.#public(flow);
  }
  cancel(input) {
    const flow = this.#selected(input);
    if (ACTIVE.has(flow.status)) { flow.cancelRequested = true; flow.abort.abort(); }
    return this.#public(flow);
  }
  pendingAuthorization(input) {
    if (!exact(input, ["profileId", "installationId", "componentId", "expectedRevision"])
      || typeof input.profileId !== "string" || !ID.test(input.profileId)
      || typeof input.installationId !== "string" || !ID.test(input.installationId)
      || typeof input.componentId !== "string" || !HASH.test(input.componentId)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail();
    this.#context(input);
    return this.runtime.pendingAuthorization();
  }
  async reconcile(input) {
    if (!exact(input, ["profileId", "installationId", "componentId", "expectedRevision", "email"])) {
      fail("GMAIL_AUTH_INVALID");
    }
    this.#validate({ ...input, operationId: "gmail-reconcile" });
    this.#context(input);
    if (this.#active.size > 0) fail("GMAIL_AUTH_CONFLICT");
    return this.runtime.reconcilePendingAuthorization(input.email);
  }
  #sweep() {
    const now = this.now();
    for (const [id, flow] of this.#flows) {
      if (ACTIVE.has(flow.status) && flow.expiresAt <= now) {
        flow.timedOut = true; flow.abort.abort();
      }
      if (!ACTIVE.has(flow.status) && flow.expiresAt + 10 * 60_000 <= now) {
        this.#flows.delete(id);
      }
    }
  }
  close() {
    this.#closed = true;
    for (const flow of this.#flows.values()) if (ACTIVE.has(flow.status)) {
      flow.cancelRequested = true; flow.abort.abort();
    }
    this.#flows.clear();
  }
}

module.exports = { GogGmailConnectionController };
