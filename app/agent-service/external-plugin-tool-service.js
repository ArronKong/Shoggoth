"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");
const { pluginServerId } = require("./plugin-runtime-tool-service");

const MAX_BINDINGS = 64;
const MAX_SKILLS = 5_000;
const MAX_PAGE = 10;

function fail(code = "CAPABILITY_FORBIDDEN") {
  throw serviceError(code, "外部 Agent 的插件能力未获当前授权");
}
function hash(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function ownObject(value) {
  return value && Object.getPrototypeOf(value) === Object.prototype;
}
function immutableJsonArguments(value) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { fail(); }
  if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > 256 * 1024) fail();
  let copy;
  try { copy = JSON.parse(encoded); } catch { fail(); }
  if (!ownObject(copy)) fail();
  const nodes = [copy];
  while (nodes.length) {
    const node = nodes.pop();
    if (!node || typeof node !== "object") continue;
    for (const child of Object.values(node)) nodes.push(child);
    Object.freeze(node);
  }
  return copy;
}
function runKey(identity) {
  return `external-${hash([identity.backendId, identity.instanceId, identity.agentId,
    identity.sessionId, identity.runId || identity.taskId, identity.turnId || null])}`;
}

class ExternalPluginToolService {
  #store;
  #resolver;
  #catalog;
  #dispatcher;
  #acquire;
  #leases;
  #provenance;
  #approvals;
  #activeCalls = new Map();
  #getNativeSkillStore;

  constructor({ store, resolver, toolCatalogRegistry, capabilityDispatcher,
    acquireConnection, leaseManager, provenance, approvalBroker,
    getNativeSkillStore = null } = {}) {
    if (typeof store?.listGlobalBindings !== "function"
      || typeof store?.getCapabilityRecords !== "function"
      || typeof store?.getRelease !== "function"
      || typeof resolver?.listEnabledSkillDescriptors !== "function"
      || typeof resolver?.inspectSkill !== "function"
      || typeof toolCatalogRegistry?.listForBinding !== "function"
      || typeof capabilityDispatcher?.dispatch !== "function"
      || typeof acquireConnection !== "function"
      || typeof leaseManager?.issue !== "function"
      || typeof leaseManager?.claim !== "function"
      || typeof provenance?.begin !== "function"
      || typeof provenance?.recordApproval !== "function"
      || typeof provenance?.journalApproval !== "function"
      || typeof provenance?.settle !== "function"
      || typeof provenance?.requestCancel !== "function"
      || typeof approvalBroker?.request !== "function"
      || (getNativeSkillStore !== null && typeof getNativeSkillStore !== "function")) {
      throw new TypeError("ExternalPluginToolService requires trusted Service authorities");
    }
    this.#store = store;
    this.#resolver = resolver;
    this.#catalog = toolCatalogRegistry;
    this.#dispatcher = capabilityDispatcher;
    this.#acquire = acquireConnection;
    this.#leases = leaseManager;
    this.#provenance = provenance;
    this.#approvals = approvalBroker;
    this.#getNativeSkillStore = getNativeSkillStore;
  }

  #snapshot() {
    const nativeStore = this.#getNativeSkillStore?.();
    const nativeSkills = nativeStore ? nativeStore.listGlobalEnabled().map(item => Object.freeze({
      source: "native-skill", componentId: hash(["native-skill", item.id, item.version,
        item.contentHash]), skillId: item.id, name: item.name, version: item.version,
      contentHash: item.contentHash, registryRevision: item.registryRevision,
      requiredTools: item.requiredTools,
      requiredRuntimeCapabilities: item.requiredRuntimeCapabilities,
      packageName: "Independent Skill", description: item.description,
    })) : [];
    const skills = [...this.#resolver.listEnabledSkillDescriptors(null), ...nativeSkills];
    if (skills.length > MAX_SKILLS) fail("PLUGIN_RUNTIME_CAPACITY");
    const tools = [];
    const bindings = this.#store.listGlobalBindings();
    if (bindings.length > MAX_BINDINGS) fail("PLUGIN_RUNTIME_CAPACITY");
    for (const binding of bindings) {
      if (!binding.enabled || binding.componentKind !== "mcp-server") continue;
      const records = this.#store.getCapabilityRecords(binding.bindingId, "__projection__");
      if (records?.installation?.desiredState !== "enabled"
        || records.connection?.state !== "ready") continue;
      const catalog = this.#catalog.listForBinding(records);
      if (!catalog) continue;
      const release = this.#store.getRelease(records.installation.sourceIdentity,
        records.installation.activeReleaseDigest);
      for (const entry of catalog.entries) {
        if (entry.appUnsupported || (entry.ui && !entry.ui.visibility.includes("model"))) continue;
        const current = this.#store.getCapabilityRecords(binding.bindingId, entry.toolIdentity);
        if (current?.grant?.effect !== "allow"
          || !["always", "each-call"].includes(current.grant.approvalMode)
          || current.grant.contractDigest !== entry.contractDigest
          || current.grant.principalIdentity !== current.connection?.principalIdentity
          || (current.grant.expiresAt != null && current.grant.expiresAt <= Date.now())) continue;
        tools.push(Object.freeze({ serverId: pluginServerId(binding.bindingId),
          bindingId: binding.bindingId, toolName: entry.downstreamName,
          description: entry.description || "", packageName: release?.name || "Agent plugin",
          approvalMode: current.grant.approvalMode,
          entry: Object.freeze({ ...entry }), envelope: Object.freeze({
            authorityIncarnation: current.authorityIncarnation,
            bindingId: binding.bindingId, installationId: binding.installationId,
            releaseDigest: current.installation.activeReleaseDigest,
            componentId: binding.componentId, connectionId: binding.connectionId,
            principalIdentity: current.connection.principalIdentity,
            bindingRevision: current.binding.revision,
            grantEpoch: current.grant.epoch,
            connectionAuthRevision: current.connection.authRevision,
            toolIdentity: entry.toolIdentity, contractDigest: entry.contractDigest,
          }) }));
      }
    }
    const revision = hash([
      skills.map(item => [item.componentId, item.bindingRevision, item.registryRevision,
        item.releaseDigest, item.descriptorDigest, item.contentHash]),
      tools.map(item => [item.serverId, item.toolName, item.entry.catalogRevision, item.envelope]),
    ]);
    return Object.freeze({ skills: Object.freeze(skills), tools: Object.freeze(tools), revision });
  }

  async open({ credentialToken, identity }) {
    return this.#leases.issue({ credentialToken, identity }, () => this.#snapshot());
  }

  #currentTool(frozen) {
    const records = this.#store.getCapabilityRecords(frozen.bindingId, frozen.entry.toolIdentity);
    const { installation, binding, connection, grant } = records || {};
    const envelope = frozen.envelope;
    if (!installation || installation.desiredState !== "enabled"
      || this.#store.hasPendingInstallationDisable?.(installation.installationId)
      || !binding?.enabled || connection?.state !== "ready" || grant?.effect !== "allow"
      || grant.approvalMode !== frozen.approvalMode
      || records.authorityIncarnation !== envelope.authorityIncarnation
      || installation.activeReleaseDigest !== envelope.releaseDigest
      || binding.revision !== envelope.bindingRevision
      || connection.authRevision !== envelope.connectionAuthRevision
      || connection.principalIdentity !== envelope.principalIdentity
      || grant.epoch !== envelope.grantEpoch || grant.contractDigest !== envelope.contractDigest
      || (grant.expiresAt != null && grant.expiresAt <= Date.now())
      || this.#catalog.resolve({ ...records, toolIdentity: frozen.entry.toolIdentity })
        ?.catalogRevision !== frozen.entry.catalogRevision) fail("GRANT_REVOKED");
    return records;
  }

  #currentSkill(descriptor) {
    if (descriptor.source === "native-skill") {
      const nativeStore = this.#getNativeSkillStore?.();
      if (!nativeStore || nativeStore.revision !== descriptor.registryRevision) fail("GRANT_REVOKED");
      return descriptor;
    }
    const installation = this.#store.getInstallation(descriptor.installationId);
    if (!installation || installation.desiredState !== "enabled"
      || installation.revision !== descriptor.bindingRevision
      || installation.releaseDigest !== descriptor.releaseDigest
      || this.#store.hasPendingInstallationDisable?.(descriptor.installationId)) fail("GRANT_REVOKED");
    return descriptor;
  }

  async search({ token, identity, query = "", cursor = 0, limit = 5, revision }) {
    if (typeof query !== "string" || !query.isWellFormed()
      || Buffer.byteLength(query, "utf8") > 512
      || !Number.isSafeInteger(cursor) || cursor < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE
      || (revision !== undefined && (typeof revision !== "string"
        || !/^[a-f0-9]{64}$/u.test(revision)))
      || (cursor > 0 && revision === undefined)) fail();
    const lease = this.#leases.claim({ token, identity });
    try {
      const words = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
      const matches = (text) => words.every(word => text.toLocaleLowerCase().includes(word));
      const skills = lease.snapshot.skills.filter(item => {
        try { this.#currentSkill(item); return matches(`${item.packageName} ${item.name} ${item.description}`); }
        catch { return false; }
      }).map(item => ({ kind: "skill", id: item.componentId,
        packageName: item.packageName, name: item.name, description: item.description,
        source: item.source }));
      const tools = lease.snapshot.tools.filter(item => {
        try { this.#currentTool(item); return matches(`${item.packageName} ${item.toolName} ${item.description}`); }
        catch { return false; }
      }).map(item => ({ kind: "tool", serverId: item.serverId,
        packageName: item.packageName, name: item.toolName, description: item.description }));
      const all = [...skills, ...tools].sort((a, b) =>
        a.packageName.localeCompare(b.packageName) || a.name.localeCompare(b.name));
      // A numeric offset is meaningful only for the same visible query result.
      // Each page uses a fresh host call and lease, so a concurrent install,
      // disable, grant revocation or catalog change must invalidate the cursor.
      const currentRevision = hash([query, lease.snapshot.revision, all]);
      if (revision !== undefined && revision !== currentRevision) {
        fail("CATALOG_REVISION_CHANGED");
      }
      lease.assertCurrent();
      return { items: all.slice(cursor, cursor + limit),
        nextCursor: cursor + limit < all.length ? cursor + limit : null,
        total: all.length, revision: currentRevision };
    } finally { this.#finish(token, identity); }
  }

  async readSkill({ token, identity, skillId, cursor = 0 }) {
    if (typeof skillId !== "string" || !/^[a-f0-9]{64}$/u.test(skillId)
      || !Number.isSafeInteger(cursor) || cursor < 0) fail();
    const lease = this.#leases.claim({ token, identity });
    try {
      const descriptor = lease.snapshot.skills.find(item => item.componentId === skillId);
      if (!descriptor) fail();
      this.#currentSkill(descriptor);
      const skill = descriptor.source === "native-skill"
        ? this.#getNativeSkillStore().readGlobalEnabled({ skillId: descriptor.skillId,
          version: descriptor.version, contentHash: descriptor.contentHash,
          registryRevision: descriptor.registryRevision })
        : this.#resolver.inspectSkill(descriptor);
      this.#currentSkill(descriptor);
      lease.assertCurrent();
      const chars = Array.from(skill.content);
      if (cursor > chars.length) fail();
      const end = Math.min(chars.length, cursor + 8_000);
      return { name: skill.name,
        contentHash: descriptor.source === "native-skill" ? descriptor.contentHash : descriptor.descriptorDigest,
        content: chars.slice(cursor, end).join(""), nextCursor: end < chars.length ? end : null };
    } finally { this.#finish(token, identity); }
  }

  async readSkillFile({ token, identity, skillId, relativePath, cursor = 0 }) {
    if (typeof skillId !== "string" || !/^[a-f0-9]{64}$/u.test(skillId)
      || typeof relativePath !== "string" || !relativePath.isWellFormed()
      || Buffer.byteLength(relativePath, "utf8") > 1024
      || !Number.isSafeInteger(cursor) || cursor < 0) fail();
    const lease = this.#leases.claim({ token, identity });
    try {
      const descriptor = lease.snapshot.skills.find(item => item.componentId === skillId);
      if (!descriptor) fail();
      this.#currentSkill(descriptor);
      const file = descriptor.source === "native-skill"
        ? this.#getNativeSkillStore().readGlobalEnabledFile({ skillId: descriptor.skillId,
          version: descriptor.version, contentHash: descriptor.contentHash,
          registryRevision: descriptor.registryRevision, relativePath })
        : this.#resolver.inspectSkillFile(descriptor, relativePath);
      this.#currentSkill(descriptor);
      lease.assertCurrent();
      const chars = Array.from(file.content);
      if (cursor > chars.length) fail();
      const end = Math.min(chars.length, cursor + 8_000);
      return { name: file.name, relativePath: file.relativePath,
        fileHash: file.fileHash, content: chars.slice(cursor, end).join(""),
        nextCursor: end < chars.length ? end : null };
    } finally { this.#finish(token, identity); }
  }

  async call({ token, identity, serverId, toolName, arguments: args }) {
    if (typeof serverId !== "string" || typeof toolName !== "string"
      || !ownObject(args)) fail();
    const lease = this.#leases.claim({ token, identity });
    let client;
    let auditPending = false;
    let approvalReceipt = null;
    try {
      const frozen = lease.snapshot.tools.find(item =>
        item.serverId === serverId && item.toolName === toolName);
      if (!frozen) fail();
      const records = this.#currentTool(frozen);
      const key = runKey(identity);
      const callId = `external-${hash([key, identity.toolCallId])}`;
      this.#provenance.begin({ callId, identity, bindingId: frozen.bindingId,
        installationId: frozen.envelope.installationId,
        componentId: frozen.envelope.componentId,
        connectionId: frozen.envelope.connectionId,
        toolIdentity: frozen.entry.toolIdentity, toolName,
        approvalRequired: frozen.approvalMode === "each-call" });
      auditPending = true;
      this.#activeCalls.set(token, callId);
      const authority = { kind: "external-agent", backendId: identity.backendId,
        agentId: identity.agentId, instanceId: identity.instanceId };
      const execution = { kind: "external-call", backendId: identity.backendId,
        agentId: identity.agentId, instanceId: identity.instanceId, runKey: key };
      const envelope = { ...frozen.envelope, runId: key };
      const assertCurrent = () => { lease.assertCurrent(); this.#currentTool(frozen); };
      assertCurrent();
      const dispatchInput = { callId, authority,
        execution, envelope, bindingId: frozen.bindingId,
        toolIdentity: frozen.entry.toolIdentity,
        downstreamToolName: toolName, contractDigest: frozen.entry.contractDigest,
        arguments: immutableJsonArguments(args), signal: lease.signal, assertCurrent };
      if (frozen.approvalMode === "each-call") {
        const response = await this.#approvals.request({ token, identity, callId,
          bindingId: frozen.bindingId, connectionId: records.connection.connectionId,
          connectionAuthRevision: records.connection.authRevision,
          packageName: frozen.packageName, toolName,
          arguments: dispatchInput.arguments, signal: lease.signal, assertCurrent,
          recordDecision: (decisionCallId, requestId, outcome) =>
            this.#provenance.journalApproval(decisionCallId, requestId, outcome) });
        this.#provenance.recordApproval(callId, response.requestId,
          response.approved === true ? "approved" : "denied");
        if (response?.approved !== true
          || response.argumentDigest !== hash(dispatchInput.arguments)) fail();
        assertCurrent();
        approvalReceipt = this.#dispatcher.approveCall(dispatchInput);
      }
      client = await this.#acquire(records);
      assertCurrent();
      const result = await this.#dispatcher.dispatch({ client, ...dispatchInput, approvalReceipt });
      auditPending = false;
      // The primary capability call is already confirmed. A failure in this
      // derived audit projection must not turn a completed write into an
      // apparent tool failure that the host might retry with a new call ID.
      try { this.#provenance.settle(callId, { result, canceled: lease.signal.aborted }); }
      catch { console.error("[agent-service] external plugin audit settlement deferred"); }
      const response = { serverId, toolName, callId, result };
      if (Buffer.byteLength(JSON.stringify(response), "utf8") > 48 * 1024) {
        return { serverId, toolName, callId, resultTruncated: true,
          result: { content: [{ type: "text",
            text: "插件工具已完成调用，但结果超过单次显示上限。请在对应服务中查看完整结果。" }] } };
      }
      return response;
    } catch (error) {
      if (approvalReceipt) this.#dispatcher.cancelApproval(approvalReceipt);
      if (auditPending) {
        auditPending = false;
        if (error?.approvalOutcome && error?.approvalRequestId) {
          try { this.#provenance.recordApproval(this.#activeCalls.get(token),
            error.approvalRequestId, error.approvalOutcome); }
          catch { console.error("[agent-service] external plugin approval audit deferred"); }
        }
        try {
          this.#provenance.settle(this.#activeCalls.get(token), {
            error, canceled: lease.signal.aborted });
        } catch { console.error("[agent-service] external plugin audit settlement deferred"); }
      }
      throw error;
    } finally {
      this.#activeCalls.delete(token);
      try { if (client) await client.release(); }
      catch { console.error("[agent-service] external plugin client release failed"); }
      this.#finish(token, identity);
    }
  }

  cancel({ token, identity }) {
    this.#leases.cancel({ token, identity });
    const callId = this.#activeCalls.get(token);
    if (callId) {
      try { this.#provenance.requestCancel(callId); }
      catch { console.error("[agent-service] external plugin audit cancellation deferred"); }
    }
  }
  #finish(token, identity) {
    try { this.#leases.finish({ token, identity }); } catch { /* Expired/canceled leases stay revoked. */ }
  }
  clear() {
    this.#leases.clear();
    for (const callId of this.#activeCalls.values()) {
      try { this.#provenance.requestCancel(callId); } catch { /* Reconcile remains conservative. */ }
    }
  }
}

module.exports = { ExternalPluginToolService, runKey };
