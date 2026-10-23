"use strict";

const crypto = require("node:crypto");
const { GRAPH_ENDPOINT_IDENTITY, componentFor, isGraphSidecar, TRANSPORT } =
  require("./plugin-microsoft-graph-sidecar");
const { CAPABILITIES } = require("./plugin-microsoft-graph-capabilities");
const { serviceError } = require("./security");

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const ACTIVE = new Set(["pending", "exchanging"]);
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(code = "PLUGIN_REQUEST_INVALID") {
  throw serviceError(code, "Outlook Calendar 只读连接请求无效或已变化");
}

// An independent Shoggoth account connection for the frozen Outlook Calendar
// card. This does not implement the Codex managed connector contract.
class PluginOutlookGraphConnectionController {
  #pending = new Map();
  #flows = new Map();
  #closed = false;

  constructor({ store, productStore, manager, calendar, now = Date.now } = {}) {
    if (typeof store?.performManagementOperation !== "function"
      || typeof store?.createConnection !== "function"
      || typeof productStore?.getAgentProfile !== "function"
      || typeof manager?.component !== "function"
      || typeof calendar?.connect !== "function"
      || typeof calendar?.flowStatus !== "function"
      || typeof now !== "function") throw new TypeError("Graph sidecar requires trusted Service authorities");
    Object.assign(this, { store, productStore, manager, calendar, now });
  }

  #context(input) {
    if (this.#closed) fail("PLUGIN_UNAVAILABLE");
    const profile = this.productStore.getAgentProfile(input.profileId);
    if (!profile?.enabled) fail("PLUGIN_BINDING_INVALID");
    const context = this.manager.component(input.installationId, input.componentId);
    if (context.installation.revision !== input.expectedRevision) fail("REVISION_CONFLICT");
    const packageId = context.installation.sourceIdentity.startsWith("bundled:")
      ? context.installation.sourceIdentity.slice("bundled:".length) : null;
    if (!isGraphSidecar(packageId)
      || context.component.transport !== TRANSPORT
      || context.component.name !== componentFor(packageId)
      || !this.calendar.config) {
      fail("PLUGIN_OAUTH_PROVIDER_UNSUPPORTED");
    }
    const binding = this.store.listGlobalBindings().find(item =>
      item.installationId === input.installationId && item.componentId === input.componentId) || null;
    return { profile, ...context, binding, packageId };
  }

  #fence(context) {
    return digest({ profile: context.profile, installation: context.installation,
      component: context.component.descriptorDigest, binding: context.binding,
      clientId: this.calendar.config.clientId });
  }

  #fenceStaleGraphConnections(principalIdentity, grantedScopes) {
    const scopes = new Set(grantedScopes);
    const seen = new Set();
    for (const binding of this.store.listGlobalBindings()) {
      const installation = this.store.getInstallation(binding.installationId);
      const packageId = installation?.sourceIdentity?.startsWith("bundled:")
        ? installation.sourceIdentity.slice("bundled:".length) : null;
      if (!isGraphSidecar(packageId)) continue;
      const connection = this.store.getConnection(binding.connectionId);
      if (!connection || connection.state !== "ready" || seen.has(connection.connectionId)) continue;
      seen.add(connection.connectionId);
      const requiredScope = packageId === "outlook-calendar"
        ? "Calendars.Read" : CAPABILITIES[packageId].scope;
      if (connection.principalIdentity === principalIdentity && scopes.has(requiredScope)) continue;
      this.store.disconnectMcpConnection({ connectionId: connection.connectionId,
        expectedRevision: connection.revision });
    }
  }

  async reconcileStoredAccount() {
    if (this.#closed || !this.calendar.config) return;
    let authority;
    try { authority = await this.calendar.storedPluginAuthority(); }
    catch { authority = null; }
    if (authority === undefined) return;
    this.#fenceStaleGraphConnections(authority?.principalIdentity || null,
      authority?.scopes || []);
  }

  matches(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    const { installationId, componentId } = input;
    if (typeof installationId !== "string" || !ID.test(installationId)
      || typeof componentId !== "string" || !HASH.test(componentId)) return false;
    try {
      const context = this.manager.component(installationId, componentId);
      const packageId = context.installation.sourceIdentity.startsWith("bundled:")
        ? context.installation.sourceIdentity.slice("bundled:".length) : null;
      return isGraphSidecar(packageId)
        && context.component.transport === TRANSPORT
        && context.component.name === componentFor(packageId);
    } catch { return false; }
  }

  ownsChallenge(challenge) { return this.#pending.has(challenge); }

  async prepare(input) {
    if (!exact(input, ["profileId", "installationId", "componentId", "expectedRevision", "operationId"])
      || !["profileId", "installationId", "operationId"].every(key =>
        typeof input[key] === "string" && ID.test(input[key]))
      || typeof input.componentId !== "string" || !HASH.test(input.componentId)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail();
    this.sweep();
    if (this.#pending.size >= 32 || this.#flows.size >= 128) fail("PLUGIN_CONNECTION_LIMIT");
    const context = this.#context(input);
    if (this.store.getOperation(input.operationId)) fail("REVISION_CONFLICT");
    const plan = context.packageId === "outlook-calendar"
      ? { scopes: ["Calendars.Read", "User.Read", "offline_access"], accountRevision: null }
      : await this.calendar.consentPlanForCapability(context.packageId);
    const challenge = crypto.randomUUID(), expiresAt = this.now() + 120_000;
    this.#pending.set(challenge, { input: structuredClone(input), fence: this.#fence(context),
      accountRevision: plan.accountRevision, scopes: [...plan.scopes], expiresAt });
    const capability = context.packageId === "outlook-calendar"
      ? { scope: "Calendars.Read", description: "Microsoft Graph 日历读取" }
      : CAPABILITIES[context.packageId];
    return { challenge, expiresAt, summary: { action: "oauth-connect", agent: "所有助理",
      package: `${context.packageId} · Shoggoth 独立只读功能`,
      capability: capability.description, provider: "Microsoft Graph",
      scopes: [...plan.scopes], reconnect: context.binding !== null } };
  }

  async commit(input) {
    if (!exact(input, ["challenge", "approved"]) || typeof input.challenge !== "string"
      || !ID.test(input.challenge) || typeof input.approved !== "boolean") fail();
    const pending = this.#pending.get(input.challenge);
    this.#pending.delete(input.challenge);
    if (!pending || pending.expiresAt <= this.now() || this.#closed) fail("PLUGIN_CONSENT_EXPIRED");
    if (!input.approved) return { canceled: true, flow: null };
    const context = this.#context(pending.input);
    if (this.#fence(context) !== pending.fence || this.store.getOperation(pending.input.operationId)) {
      fail("REVISION_CONFLICT");
    }
    const connect = context.packageId === "outlook-calendar"
      ? this.calendar.connect.bind(this.calendar)
      : this.calendar.connectForCapability.bind(this.calendar);
    const started = await connect({ profileId: pending.input.profileId,
      packageId: context.packageId,
      ...(context.packageId === "outlook-calendar" ? {}
        : { expectedAccountRevision: pending.accountRevision }),
      onReady: ({ principalHash, grantedScopes }) => {
        const current = this.#context(pending.input);
        if (this.#fence(current) !== pending.fence) fail("REVISION_CONFLICT");
        const connectionId = digest(["shoggoth-graph", pending.input.installationId,
          pending.input.componentId, principalHash, pending.input.operationId]);
        const result = this.store.performManagementOperation({
          operationId: pending.input.operationId, kind: "mcp-connect",
          fingerprint: digest(["shoggoth-graph-connect", pending.input, principalHash]),
          apply: () => {
            this.#fenceStaleGraphConnections(`microsoft-graph:${principalHash}`, grantedScopes);
            const connection = this.store.createConnection({ connectionId,
              installationId: pending.input.installationId,
              componentId: pending.input.componentId,
              endpointIdentity: GRAPH_ENDPOINT_IDENTITY(current.component.descriptorDigest) });
            this.store.setConnectionIdentity({ connectionId,
              principalIdentity: `microsoft-graph:${principalHash}`, state: "ready",
              expectedRevision: connection.revision });
            let binding = this.store.listGlobalBindings().find(item =>
              item.installationId === pending.input.installationId
              && item.componentId === pending.input.componentId) || null;
            if (!binding) binding = this.store.createGlobalBinding({
              bindingId: digest(["mcp-binding", "all-agents",
                pending.input.installationId, pending.input.componentId]),
              installationId: pending.input.installationId,
              componentId: pending.input.componentId, connectionId });
            else binding = this.store.setMcpBindingConnection({ bindingId: binding.bindingId,
              connectionId, expectedRevision: binding.revision });
            binding = this.store.setBindingEnabled({ bindingId: binding.bindingId,
              enabled: true, expectedRevision: binding.revision });
            return { kind: "mcp-connect", profileId: pending.input.profileId,
              bindingId: binding.bindingId, toolIdentity: null, revision: binding.revision };
          },
        });
        const flow = [...this.#flows.values()].find(item =>
          item.input.operationId === pending.input.operationId);
        if (flow) flow.receipt = result.result;
      } });
    this.#flows.set(started.flowId, { input: pending.input,
      flowId: started.flowId, expiresAt: started.expiresAt, receipt: null });
    return { canceled: false, flow: { flowId: started.flowId, status: "pending",
      expiresAt: started.expiresAt, authorizationUrl: started.authorizationUrl } };
  }

  owns({ profileId, flowId } = {}) {
    return this.#flows.get(flowId)?.input.profileId === profileId;
  }

  async status(input) {
    if (!exact(input, ["profileId", "flowId"]) || !ID.test(input.profileId)
      || !ID.test(input.flowId) || !this.owns(input)) fail("PLUGIN_OAUTH_FLOW_NOT_FOUND");
    const flow = this.#flows.get(input.flowId);
    const state = await this.calendar.flowStatus(input);
    return { flowId: input.flowId, status: state.status, expiresAt: state.expiresAt,
      reasonCode: state.status === "failed" ? "CONNECTION_AUTH_REQUIRED" : null,
      bindingId: flow.receipt?.bindingId || null,
      receipt: flow.receipt ? { ...flow.receipt } : null };
  }

  async cancel(input) {
    if (!exact(input, ["profileId", "flowId"]) || !this.owns(input)) fail("PLUGIN_OAUTH_FLOW_NOT_FOUND");
    this.calendar.cancel(input);
    return this.status(input);
  }

  async cancelStaleForBindings(bindings) {
    for (const flow of this.#flows.values()) {
      if (!bindings.some(binding => binding.installationId === flow.input.installationId
        && binding.componentId === flow.input.componentId)) continue;
      const state = await this.calendar.flowStatus({ profileId: flow.input.profileId, flowId: flow.flowId });
      if (ACTIVE.has(state.status)) this.calendar.cancel({ profileId: flow.input.profileId,
        flowId: flow.flowId });
    }
    // The generic disconnect has already fenced the Connection and all its
    // Bindings in PluginStore. Retain the shared encrypted account for direct
    // host grants, but drop stale process-local plugin activation unless a
    // different live Graph binding still uses the same principal.
    const liveGraphPrincipals = new Set(this.store.listGlobalBindings()
      .filter(binding => binding.enabled)
      .map(binding => this.store.getConnection(binding.connectionId))
      .filter(connection => connection?.state === "ready"
        && isGraphSidecar(this.store.getInstallation(connection.installationId)
          ?.sourceIdentity?.replace(/^bundled:/u, ""))
        && connection.endpointIdentity?.startsWith(`${TRANSPORT}:`))
      .map(connection => connection.principalIdentity));
    for (const connectionId of new Set(bindings.map(binding => binding.connectionId))) {
      const connection = this.store.getConnection(connectionId);
      if (connection?.state !== "disconnected"
        || !isGraphSidecar(this.store.getInstallation(connection.installationId)
          ?.sourceIdentity?.replace(/^bundled:/u, ""))
        || !connection.endpointIdentity?.startsWith(`${TRANSPORT}:`)
        || liveGraphPrincipals.has(connection.principalIdentity)) continue;
      this.calendar.deactivatePluginAccount({ principalIdentity: connection.principalIdentity });
    }
  }

  sweep() {
    for (const [key, pending] of this.#pending) {
      if (pending.expiresAt <= this.now()) this.#pending.delete(key);
    }
    for (const [key, flow] of this.#flows) {
      if (flow.expiresAt + 10 * 60_000 <= this.now()) this.#flows.delete(key);
    }
  }

  clear() { this.#closed = true; this.#pending.clear(); this.#flows.clear(); }
}

module.exports = { PluginOutlookGraphConnectionController };
