"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");
const { planAgentMcpSetup } = require("./mcp-agent-setup-plan");

const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = code => { throw serviceError(code, code); };
const sameOrigin = (left, right) => left.profileId === right.profileId && left.sessionKey === right.sessionKey
  && left.transcriptSessionId === right.transcriptSessionId && left.runId === right.runId;

// Agent installation and user authentication share the existing request ledger.
// Neither credentials nor executable configuration enter a request card. A batch
// resumes once, after its originating turn ends and every connector is ready.
class McpAgentSetup {
  constructor({ connector, publicRequest, waitForOwner = async () => true }) {
    Object.assign(this, { connector, publicRequest, waitForOwner });
    this.queue = Promise.resolve(); this.observed = new Set(); this.generation = 0;
  }
  open() {
    this.generation++; this.observed.clear();
    let changed = false;
    for (const request of this.connector.requests.values()) {
      if (request.kind === "setup" && request.status === "pending" && request.continuation === "scheduled") {
        request.continuation = "unknown"; changed = true;
      }
    }
    if (changed) this.connector.persistRequests();
  }
  stop() { this.generation++; this.observed.clear(); }
  ready(request) {
    const c = this.connector;
    return request.serverIds.every(id => c.store.isAvailable(id, request.owner.profileId));
  }
  result(request, servers, errors = []) {
    return { servers: servers.map(server => ({ id: server.id, name: server.name, status: server.status,
      toolCount: server.lastCheck?.toolCount || 0, errorCode: server.lastCheck?.errorCode || null })), errors,
    request: request ? this.publicRequest(request) : null,
    continuation: !request ? "not_needed" : request.continuation === "unknown" ? "unknown"
      : this.ready(request) ? "after_current_turn" : "after_setup" };
  }
  install(tool, args, owner, scope) {
    const pending = this.queue.catch(() => {}).then(async () => {
      const c = this.connector; c.assertOpen(); scope?.assertCurrent();
      if (!owner?.profileId || !owner.sessionKey || !owner.transcriptSessionId || !owner.runId) fail("MCP_REQUEST_ACCESS_DENIED");
      c.assertSecretSafe(JSON.stringify(args));
      const plan = planAgentMcpSetup(tool, args, c.paths);
      const fingerprint = hash([owner.profileId, owner.sessionKey, owner.runId, "setup", plan]);
      const existingRequest = [...c.requests.values()].find(request => request.fingerprint === fingerprint);
      if (existingRequest) return this.result(existingRequest, existingRequest.serverIds.map(id => c.store.get(id)).filter(Boolean));
      // Capacity is checked before any package preparation or registry mutation.
      c.ensureRequestCapacity();
      const servers = [], errors = [];
      for (const entry of plan) {
        scope?.assertCurrent(); c.assertOpen();
        try {
          const existing = c.store.list().servers.find(server => {
            const record = c.store.getPrivate(server.id);
            return JSON.stringify(record.transport) === JSON.stringify(entry.input.option);
          });
          if (existing && (!existing.enabled || existing.disabledProfileIds.includes(owner.profileId))) fail("MCP_CONNECTOR_ACCESS_DENIED");
          const result = existing ? existing.status === "ready" ? { server: existing } : await c.verify(existing.id)
            : await c.add(entry.input, { requiredFields: entry.requiredFields, currentRevision: true });
          servers.push(result.server);
        } catch (error) {
          // Uncertain writes must not be turned into a successful partial import.
          if (["MCP_REGISTRY_COMMIT_UNCERTAIN", "MCP_REGISTRY_CLOSED", "MCP_CONNECTORS_UNAVAILABLE"].includes(error?.code)) throw error;
          errors.push({ name: entry.input.name, errorCode: /^[A-Z][A-Z0-9_]+$/u.test(error?.code || "") ? error.code : "MCP_IMPORT_INVALID" });
        }
      }
      scope?.assertCurrent(); c.assertOpen();
      const available = new Set(c.available(owner.profileId, owner.runId).map(server => server.id));
      if (!servers.length || servers.every(server => available.has(server.id))) return this.result(null, servers, errors);
      const now = c.now(), ids = [...new Set(servers.map(server => server.id))];
      const request = { requestId: `mcp-request-${c.randomUUID()}`, kind: "setup", serverId: ids[0], serverIds: ids,
        registryName: null, url: null, title: servers.length === 1 ? servers[0].name.slice(0, 240) : "MCP connectors",
        purpose: args.purpose, status: "pending", requiredFields: [], continuation: "waiting",
        expiresAt: now + 24 * 60 * 60 * 1000, createdAt: now, updatedAt: now, owner: structuredClone(owner), fingerprint };
      c.saveRequest(request);
      this.schedule(request);
      return this.result(request, servers, errors);
    });
    this.queue = pending; return pending;
  }
  changed() {
    if (this.connector.closed) return;
    for (const request of this.connector.requests.values()) if (request.kind === "setup") this.schedule(request);
  }
  schedule(request) {
    const c = this.connector;
    if (c.closed || request.status !== "pending" || request.continuation !== "waiting"
      || request.expiresAt <= c.now() || !this.ready(request) || this.observed.has(request.requestId)) return;
    const generation = this.generation;
    this.observed.add(request.requestId);
    // Never await the source turn from inside its own tool call.
    Promise.resolve().then(() => this.waitForOwner(request.owner)).then(allowed => {
      if (allowed && generation === this.generation && !c.closed) return this.finish(request.owner, generation);
    }).catch(() => { /* Persisted requests remain visible; an unknown dispatch is never replayed. */ })
      .finally(() => { if (generation === this.generation) this.observed.delete(request.requestId); });
  }
  complete(request) {
    if (request.continuation === "unknown") fail("MCP_REQUEST_ACK_UNKNOWN");
    this.schedule(request);
    return this.publicRequest(request);
  }
  finish(owner, generation) {
    const c = this.connector;
    const action = async () => {
      if (c.closed || generation !== this.generation) return;
      const group = [...c.requests.values()].filter(request => request.kind === "setup" && request.status === "pending" && sameOrigin(request.owner, owner));
      if (!group.length || group.some(request => request.continuation !== "waiting" || request.expiresAt <= c.now() || !this.ready(request))) return;
      if (c.getOwner) {
        const current = await c.getOwner({ agentId: owner.agentId || owner.profileId, sessionKey: owner.sessionKey, backendId: owner.backendId || "shoggoth" });
        if (!current || current.profileId !== owner.profileId || current.transcriptSessionId !== owner.transcriptSessionId) fail("MCP_REQUEST_ACCESS_DENIED");
      }
      if (c.closed || generation !== this.generation || group.some(request => !this.ready(request))) return;
      const idempotencyKey = `mcp-request-setup-${hash([owner.profileId, owner.sessionKey, owner.transcriptSessionId, owner.runId]).slice(0, 48)}`;
      for (const request of group) { request.continuation = "scheduled"; request.updatedAt = c.now(); }
      c.persistRequests();
      try {
        await c.onComplete?.({ request: this.publicRequest(group[0]), owner, server: c.store.get(group[0].serverId), idempotencyKey });
        if (c.closed || generation !== this.generation) return;
        for (const request of group) { request.status = "completed"; request.updatedAt = c.now(); }
        c.persistRequests();
      } catch (error) {
        if (!c.closed && generation === this.generation) {
          for (const request of group) { request.continuation = "unknown"; request.updatedAt = c.now(); }
          c.persistRequests();
        }
        throw error;
      } finally {
        if (!c.closed && generation === this.generation) for (const request of group) c.projectRequest(request);
      }
    };
    const pending = c.requestQueue.catch(() => {}).then(action);
    c.requestQueue = pending; return pending;
  }
}

module.exports = { McpAgentSetup };
