"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");
const { buildPluginToolCatalog } = require("./plugin-tool-contract");
const { componentId } = require("./plugin-component-catalog");

const PLUGIN_SERVER_PATTERN = /^plugin\.[a-f0-9]{64}$/u;
const ACTIVE = new Set(["starting", "running", "waiting_approval", "waiting_input"]);
const MAX_RUNS = 100;
const MAX_BINDINGS = 64;
function fail(code = "CAPABILITY_FORBIDDEN") {
  throw serviceError(code, "插件工具不属于当前执行授权");
}
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function pluginServerId(bindingId) { return `plugin.${hash(bindingId)}`; }

// A Run receives one immutable authority projection at admission. Management
// changes can narrow it immediately but never add new tools to an existing Run.
// This in-memory projection is deliberately not reconstructed on Run recovery.
class PluginRuntimeToolService {
  #store;
  #productStore;
  #getRun;
  #catalog;
  #dispatcher;
  #policy;
  #requestApproval;
  #recordAppCall;
  #acquire;
  #runs = new Map();

  constructor({ store, productStore, getRun, toolCatalogRegistry,
    capabilityDispatcher, permissionEngine, acquireConnection, requestApproval = null,
    recordAppCall = null } = {}) {
    if (typeof store?.listBindingsForProfile !== "function"
      || typeof store?.getCapabilityRecords !== "function"
      || typeof store?.getCapabilityRecordsForTools !== "function"
      || typeof store?.getCapabilityCall !== "function"
      || typeof store?.getRelease !== "function"
      || typeof productStore?.getAgentProfile !== "function"
      || typeof getRun !== "function"
      || typeof toolCatalogRegistry?.listForBinding !== "function"
      || typeof toolCatalogRegistry?.refresh !== "function"
      || typeof capabilityDispatcher?.dispatch !== "function"
      || typeof permissionEngine?.profileProjection !== "function"
      || typeof permissionEngine?.authorize !== "function"
      || (requestApproval !== null && typeof requestApproval !== "function")
      || (recordAppCall !== null && typeof recordAppCall !== "function")
      || typeof acquireConnection !== "function") {
      throw new TypeError("PluginRuntimeToolService requires trusted Service authorities");
    }
    this.#store = store;
    this.#productStore = productStore;
    this.#getRun = getRun;
    this.#catalog = toolCatalogRegistry;
    this.#dispatcher = capabilityDispatcher;
    this.#policy = permissionEngine;
    this.#requestApproval = requestApproval;
    this.#recordAppCall = recordAppCall;
    this.#acquire = acquireConnection;
  }

  captureRun(run) {
    if (!run || typeof run.id !== "string" || typeof run.profileId !== "string"
      || !ACTIVE.has(run.status)) fail();
    if (this.#runs.has(run.id)) fail("TOOL_CONTRACT_CHANGED");
    if (this.#runs.size >= MAX_RUNS) fail("PLUGIN_RUNTIME_CAPACITY");
    const profile = this.#productStore.getAgentProfile(run.profileId);
    if (profile?.enabled !== true || profile.id !== run.profileId) fail();
    const productTool = this.#policy.profileProjection(run.profileId).tools
      .find(tool => tool.name === "mcp_server_call");
    if (!productTool?.enabled || productTool.effect !== "allow") {
      this.#runs.set(run.id, { profileId: run.profileId, workspace: run.workspace, servers: new Map() });
      return { serverCount: 0 };
    }
    const bindings = this.#store.listBindingsForProfile(run.profileId);
    const servers = new Map();
    for (const binding of bindings) {
      if (binding.componentKind !== "mcp-server" || !binding.enabled) continue;
      if (servers.size >= MAX_BINDINGS) fail("PLUGIN_RUNTIME_CAPACITY");
      let records = this.#store.getCapabilityRecords(binding.bindingId, "__projection__");
      if (records?.installation?.desiredState !== "enabled"
        || records.connection?.state !== "ready") continue;
      const catalog = this.#catalog.listForBinding(records);
      if (!catalog) continue;
      const batch = this.#store.getCapabilityRecordsForTools(binding.bindingId,
        catalog.entries.map(entry => entry.toolIdentity));
      if (!batch || this.#catalog.listForBinding(batch.records)?.catalogRevision !== catalog.catalogRevision) continue;
      records = batch.records;
      if (records.installation?.desiredState !== "enabled" || !records.binding?.enabled) continue;
      const tools = new Map();
      for (const entry of catalog.entries) {
        if (entry.appUnsupported || (entry.ui && !entry.ui.visibility.includes("model"))) continue;
        const grant = batch.grants.get(entry.toolIdentity);
        if (grant?.effect !== "allow" || grant.contractDigest !== entry.contractDigest
          || grant.principalIdentity !== records.connection.principalIdentity
          || (grant.expiresAt != null && grant.expiresAt <= Date.now())) continue;
        tools.set(entry.downstreamName, Object.freeze({ ...entry,
          approvalMode: grant.approvalMode,
          envelope: Object.freeze({ runId: run.id, authorityIncarnation: records.authorityIncarnation,
            bindingId: binding.bindingId,
            installationId: binding.installationId,
            releaseDigest: records.installation.activeReleaseDigest,
            componentId: binding.componentId, connectionId: binding.connectionId,
            principalIdentity: records.connection.principalIdentity,
            bindingRevision: records.binding.revision, grantEpoch: grant.epoch,
            connectionAuthRevision: records.connection.authRevision,
            toolIdentity: entry.toolIdentity, contractDigest: entry.contractDigest }) }));
      }
      if (tools.size) {
        const release = this.#store.getRelease(records.installation.sourceIdentity,
          records.installation.activeReleaseDigest);
        const component = release?.components?.mcpServers?.find(value =>
          componentId(binding.installationId, "mcp-server", value.name) === binding.componentId);
        servers.set(pluginServerId(binding.bindingId), { bindingId: binding.bindingId,
          name: component ? `${release.name} / ${component.name}` : "Agent plugin", tools });
      }
    }
    this.#runs.set(run.id, { profileId: run.profileId, workspace: run.workspace, servers });
    return { serverCount: servers.size };
  }

  releaseRun(runId) { this.#runs.delete(runId); }
  clear() { this.#runs.clear(); }

  #context(authority, scope) {
    if (authority?.federationClient || typeof scope?.runId !== "string"
      || typeof scope?.assertCurrent !== "function") fail();
    const result = scope.assertCurrent();
    if (result && typeof result.then === "function") fail();
    const snapshot = this.#runs.get(scope.runId);
    const profile = this.#productStore.getAgentProfile(authority.profileId);
    const run = this.#getRun(scope.runId);
    if (!snapshot || snapshot.profileId !== authority.profileId
      || profile?.id !== authority.profileId || profile.enabled !== true
      || run?.id !== scope.runId || run.profileId !== authority.profileId
      || !ACTIVE.has(run.status) || run.workspace !== snapshot.workspace) fail();
    return { snapshot, profile, run };
  }

  #current(entry) {
    const envelope = entry.envelope;
    const records = this.#store.getCapabilityRecords(envelope.bindingId, entry.toolIdentity);
    return this.#assertCurrent(entry, records);
  }

  #assertCurrent(entry, records) {
    const envelope = entry.envelope;
    const { binding, connection, installation, grant } = records || {};
    if (!binding?.enabled || installation?.desiredState !== "enabled"
      || records.authorityIncarnation !== envelope.authorityIncarnation
      || installation.activeReleaseDigest !== envelope.releaseDigest
      || binding.revision !== envelope.bindingRevision
      || connection?.connectionId !== envelope.connectionId || connection.state !== "ready"
      || connection.authRevision !== envelope.connectionAuthRevision
      || connection.principalIdentity !== envelope.principalIdentity
      || grant?.effect !== "allow" || grant.epoch !== envelope.grantEpoch
      || grant.contractDigest !== entry.contractDigest
      || (grant.expiresAt != null && grant.expiresAt <= Date.now())) fail("GRANT_REVOKED");
    return records;
  }

  #currentEntries(server) {
    const all = [...server.tools.values()];
    const batch = this.#store.getCapabilityRecordsForTools(server.bindingId,
      all.map(entry => entry.toolIdentity));
    if (!batch) return { entries: [], records: null };
    let firstRecords = null;
    const entries = all.filter(entry => {
      const records = { ...batch.records, grant: batch.grants.get(entry.toolIdentity) };
      try {
        this.#assertCurrent(entry, records);
        firstRecords ||= records; return true;
      } catch { return false; }
    });
    return { entries, records: firstRecords };
  }

  listServers(authority, scope) {
    // A recovered Run deliberately has no plugin projection. Its ordinary
    // standalone MCP catalog must remain usable without recreating authority.
    if (!this.#runs.has(scope?.runId)) return [];
    const { snapshot } = this.#context(authority, scope);
    const servers = [];
    for (const [id, server] of snapshot.servers) {
      const { entries: tools } = this.#currentEntries(server);
      if (tools.length) servers.push({ id, name: server.name, enabled: true,
        source: "plugin", toolCount: tools.length });
    }
    return servers;
  }

  async listTools({ serverId, cursor, limit }, authority, scope) {
    if (!Number.isSafeInteger(cursor) || cursor < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) fail();
    const { snapshot, run } = this.#context(authority, scope);
    const server = snapshot.servers.get(serverId);
    if (!server) fail();
    const continuation = cursor ? server.page : null;
    if (cursor && (!continuation || continuation.nextCursor !== cursor)) fail("TOOL_CONTRACT_CHANGED");
    const { entries, records } = this.#currentEntries(server);
    if (!entries.length) fail("GRANT_REVOKED");
    const client = await this.#acquire({ ...records, run });
    try {
      this.#context(authority, scope);
      const tools = await client.listTools();
      this.#context(authority, scope);
      const contracts = buildPluginToolCatalog({ installationId: records.installation.installationId,
        componentId: records.binding.componentId, connectionId: records.connection.connectionId, tools });
      const current = new Map(contracts.entries.map(entry => [entry.downstreamName, entry]));
      // Never reuse the pre-await records. Read every current Grant again, with
      // shared Connection/Binding rows only within this synchronous transaction.
      const allowed = new Map(this.#currentEntries(server).entries.map(entry => [entry.downstreamName, entry]));
      if (!allowed.size) fail("GRANT_REVOKED");
      const visible = tools.filter(tool => {
        const frozen = allowed.get(tool.name);
        return frozen && current.get(tool.name)?.contractDigest === frozen.contractDigest;
      }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      const pageDigest = hash(JSON.stringify([contracts.generationDigest,
        visible.map(tool => [tool.name, allowed.get(tool.name).envelope.grantEpoch])]));
      // A numeric cursor is a continuation of the last page for this Run and
      // server. Shrinking authority or changing the remote catalog must not skip
      // or duplicate tools silently; the caller can restart from cursor zero.
      if (cursor && (server.page !== continuation || continuation.digest !== pageDigest)) fail("TOOL_CONTRACT_CHANGED");
      const items = visible.slice(cursor, cursor + limit).map(tool => ({
        name: tool.name, description: tool.description || "", inputSchema: tool.inputSchema,
        source: "plugin", approvalMode: server.tools.get(tool.name).approvalMode,
      }));
      server.page = { digest: pageDigest, nextCursor: cursor + items.length };
      return { serverId, items, nextCursor: cursor + items.length,
        hasMore: cursor + items.length < visible.length };
    } finally { await client.release(); }
  }

  async callTool({ serverId, toolName, arguments: args }, authority, scope) {
    const { snapshot, run, profile } = this.#context(authority, scope);
    const server = snapshot.servers.get(serverId);
    const entry = server?.tools.get(toolName);
    if (!entry) fail();
    const records = this.#current(entry);
    const callId = `runtime-${hash(JSON.stringify([run.id, authority.profileId, authority.callId]))}`;
    if (this.#store.getCapabilityCall(callId)) fail("CALL_ALREADY_RECORDED");
    this.#policy.authorize({ name: "mcp_server_call", profileId: profile.id, profile,
      run, workspace: run.workspace, confirmed: authority.confirmation === true });
    const callArgs = structuredClone(args);
    const client = await this.#acquire({ ...records, run });
    let approvalReceipt = null;
    try {
      this.#context(authority, scope);
      this.#current(entry);
      if (records.grant.approvalMode === "each-call") {
        if (!this.#requestApproval) fail();
        const response = await this.#requestApproval({ runId: run.id, profileId: profile.id,
          packageName: server.name, toolName, arguments: structuredClone(callArgs),
          signal: scope.signal, assertCurrent: () => {
            this.#context(authority, scope); this.#current(entry);
          } });
        if (response?.approved !== true) fail();
        this.#context(authority, scope);
        this.#current(entry);
      }
      if (!this.#catalog.listForBinding(records)) {
        await this.#catalog.refresh({ ...records, client });
      }
      this.#context(authority, scope);
      const input = {
        callId,
        authority: { kind: "native-profile", profileId: profile.id, profile,
          confirmed: authority.confirmation === true },
        execution: { kind: "native-run", profileId: profile.id, workspace: run.workspace, run },
        envelope: entry.envelope, bindingId: records.binding.bindingId,
        toolIdentity: entry.toolIdentity, downstreamToolName: toolName,
        contractDigest: entry.contractDigest, arguments: callArgs,
        assertCurrent: () => { this.#context(authority, scope); },
      };
      if (records.grant.approvalMode === "each-call") approvalReceipt = this.#dispatcher.approveCall(input);
      const result = await this.#dispatcher.dispatch({ client, ...input, approvalReceipt });
      let appCall = null;
      if (entry.ui?.resourceUri && run.source === "chat" && this.#recordAppCall) {
        // A UI seed is optional. Its bounds or retention cannot turn a confirmed
        // downstream result into a failed call (which could prompt a retry).
        try { appCall = this.#recordAppCall({ callId, arguments: callArgs, result }); } catch { /* Text result remains usable. */ }
      }
      return { serverId, toolName, result,
        ...(appCall ? {
          shoggothPluginApp: { callId },
        } : {}) };
    } finally {
      if (approvalReceipt) this.#dispatcher.cancelApproval(approvalReceipt);
      await client.release();
    }
  }
}

module.exports = { PluginRuntimeToolService, PLUGIN_SERVER_PATTERN, pluginServerId };
