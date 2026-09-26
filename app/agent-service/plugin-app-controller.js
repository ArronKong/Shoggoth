"use strict";

const crypto = require("node:crypto");
const { PluginAppSessionManager } = require("./plugin-app-session");
const { serviceError } = require("./security");

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const validId = value => typeof value === "string" && ID.test(value);
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, fields) => plain(value) && Reflect.ownKeys(value).length === fields.length
  && fields.every(field => Object.hasOwn(value, field));
const digest = text => crypto.createHash("sha256").update(text).digest("hex");
const MAX_SEED_BYTES = 32 * 1024;
const MAX_SEEDS = 128;
const fail = (code = "MCP_APP_AUTHORITY_INVALID") => {
  throw serviceError(code, "MCP App 会话或授权已失效");
};

function freezeJson(value) {
  const remaining = [value];
  while (remaining.length) {
    const next = remaining.pop();
    if (next && typeof next === "object") {
      Object.freeze(next);
      remaining.push(...Object.values(next));
    }
  }
  return value;
}

function chunksFor(text) {
  const bytes = Buffer.from(text, "utf8");
  const chunks = [];
  // Each raw segment is a multiple of 3, so concatenated chunks form one
  // canonical base64 value. ASCII is bounded independently of JSON escaping.
  for (let offset = 0; offset < bytes.length; offset += 18 * 1024) {
    chunks.push(bytes.subarray(offset, offset + 18 * 1024).toString("base64"));
  }
  return chunks;
}

class PluginAppController {
  #pending = new Map();
  #sessions = new Map();
  #opening = 0;
  #openingPins = new Map();
  #inFlight = 0;
  #generation = 0;
  #seeds = new Map();

  constructor({ store, productStore, getRun, getConversation, manager, catalog,
    dispatcher, permissionEngine, now = Date.now } = {}) {
    if (typeof store?.getCapabilityCall !== "function" || typeof store?.getCapabilityRecords !== "function"
      || typeof store?.hasPendingInstallationDisable !== "function" || typeof store?.getRelease !== "function"
      || typeof productStore?.getAgentProfile !== "function" || typeof getRun !== "function"
      || typeof getConversation !== "function" || typeof manager?.acquire !== "function"
      || typeof catalog?.resolve !== "function" || typeof catalog?.listForBinding !== "function"
      || typeof dispatcher?.dispatch !== "function" || typeof permissionEngine?.authorize !== "function"
      || typeof now !== "function") throw new TypeError("PluginAppController requires trusted Service authorities");
    Object.assign(this, { store, productStore, getRun, getConversation, manager, catalog,
      dispatcher, permissionEngine, now });
  }

  // Service-only callback after CapabilityDispatcher confirms the durable call.
  // This method is deliberately absent from the browser/model RPC surface.
  recordCall(input) {
    if (!exact(input, ["callId", "arguments", "result"]) || !validId(input.callId)
      || !plain(input.arguments) || !plain(input.result) || !Array.isArray(input.result.content)) {
      fail("MCP_APP_SEED_INVALID");
    }
    const call = this.store.getCapabilityCall(input.callId);
    if (call?.phase !== "result_confirmed") fail("MCP_APP_SEED_UNCONFIRMED");
    let argumentsJson; let notificationsJson;
    try {
      argumentsJson = JSON.stringify(input.arguments);
      notificationsJson = JSON.stringify([
        { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: input.arguments } },
        { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: input.result },
      ]);
    } catch { fail("MCP_APP_SEED_INVALID"); }
    if (typeof argumentsJson !== "string" || digest(argumentsJson) !== call.argumentDigest) {
      fail("MCP_APP_SEED_INVALID");
    }
    if (Buffer.byteLength(notificationsJson, "utf8") > MAX_SEED_BYTES) fail("MCP_APP_SEED_LIMIT");
    const notifications = freezeJson(JSON.parse(notificationsJson));
    // Ensure getters/toJSON cannot change the argument between receipt and seed.
    if (!plain(notifications[0].params.arguments)
      || digest(JSON.stringify(notifications[0].params.arguments)) !== call.argumentDigest
      || !plain(notifications[1].params) || !Array.isArray(notifications[1].params.content)) {
      fail("MCP_APP_SEED_INVALID");
    }
    const seedDigest = digest(notificationsJson);
    const receiptDigest = digest(JSON.stringify(call));
    const existing = this.#seeds.get(input.callId);
    if (existing && (existing.seedDigest !== seedDigest || existing.receiptDigest !== receiptDigest)) {
      fail("MCP_APP_SEED_INVALID");
    }
    if (!existing) {
      while (this.#seeds.size >= MAX_SEEDS) this.#dropSeed(this.#seeds.keys().next().value);
      this.#seeds.set(input.callId, Object.freeze({ seedDigest, receiptDigest, notifications }));
    }
    return { callId: input.callId, seedDigest };
  }

  #current({ profileId, conversationId, callId }) {
    const call = this.store.getCapabilityCall(callId);
    const profile = this.productStore.getAgentProfile(profileId);
    const run = call && this.getRun(call.runRef);
    const conversation = run && this.getConversation(run);
    if (call?.phase !== "result_confirmed" || !run || run.id !== call.runRef
      || run.profileId !== profileId || profile?.id !== profileId || profile.enabled !== true
      || conversation?.id !== conversationId || conversation.profileId !== profileId) fail();
    const seed = this.#seeds.get(callId);
    if (!seed || seed.receiptDigest !== digest(JSON.stringify(call))) fail("MCP_APP_SEED_UNAVAILABLE");
    const records = this.store.getCapabilityRecords(call.bindingId, call.toolIdentity);
    const { installation, binding, connection, grant } = records || {};
    if (installation?.desiredState !== "enabled" || binding?.enabled !== true
      || binding.subjectKind !== "native-profile" || binding.subjectId !== profileId
      || binding.componentKind !== "mcp-server" || connection?.state !== "ready"
      || call.connectionId !== connection.connectionId || call.principalIdentity !== connection.principalIdentity
      || grant?.effect !== "allow" || grant.principalIdentity !== connection.principalIdentity
      || grant.contractDigest !== call.contractDigest || grant.argumentScope !== null
      || (grant.expiresAt !== null && grant.expiresAt <= this.now())
      || this.store.hasPendingInstallationDisable(installation.installationId)) fail();
    const tool = this.catalog.resolve({ ...records, toolIdentity: call.toolIdentity });
    if (!tool || tool.appUnsupported || !tool.ui?.resourceUri || tool.contractDigest !== call.contractDigest) {
      fail("MCP_APP_RESOURCE_FORBIDDEN");
    }
    // This is a deny/capability probe while preparing. Actual resource/tool IO
    // only happens after the native confirmation below creates a private ticket.
    const policy = this.permissionEngine.authorize({ name: "mcp_server_call", profileId,
      profile, workspace: run.workspace, confirmed: true });
    return { profile, run, records, tool, policy, seed };
  }

  #assertPin(pin) {
    const current = this.#current(pin);
    const { records, run, tool, policy, seed } = current;
    if (run.id !== pin.runId || run.workspace !== pin.workspace
      || records.authorityIncarnation !== pin.authorityIncarnation
      || records.installation.revision !== pin.installationRevision
      || records.installation.activeReleaseDigest !== pin.authority.releaseDigest
      || records.binding.revision !== pin.authority.bindingRevision
      || records.connection.authRevision !== pin.authority.authRevision
      || records.connection.principalIdentity !== pin.authority.principalIdentity
      || records.connection.endpointIdentity !== pin.endpointIdentity
      || records.grant.epoch !== pin.originalGrantEpoch
      || records.grant.revision !== pin.originalGrantRevision
      || tool.catalogRevision !== pin.authority.catalogRevision
      || tool.ui.resourceUri !== pin.resourceUri
      || seed.seedDigest !== pin.seed.seedDigest
      || policy.permissionRevision !== pin.policy.permissionRevision
      || policy.toolRevision !== pin.policy.toolRevision) fail("MCP_APP_AUTHORITY_REVOKED");
    return current;
  }

  prepare(input) {
    if (!exact(input, ["profileId", "conversationId", "callId"])
      || !Object.values(input).every(validId)) fail();
    this.sweep();
    if (this.#pending.size >= 32) fail("MCP_APP_LIMIT");
    const { profile, run, records, tool, policy, seed } = this.#current(input);
    const listing = this.catalog.listForBinding(records);
    if (!listing || listing.catalogRevision !== tool.catalogRevision) fail();
    const tools = [];
    for (const entry of listing.entries) {
      const grant = this.store.getCapabilityRecords(records.binding.bindingId, entry.toolIdentity)?.grant;
      if (entry.appUnsupported || (entry.ui && !entry.ui.visibility.includes("app"))
        || grant?.effect !== "allow" || grant.approvalMode !== "always" || grant.argumentScope !== null
        || grant.principalIdentity !== records.connection.principalIdentity
        || grant.contractDigest !== entry.contractDigest
        || (grant.expiresAt !== null && grant.expiresAt <= this.now())) continue;
      tools.push(Object.freeze({ ...entry, grantEpoch: grant.epoch, grantRevision: grant.revision }));
    }
    const authority = { profileId: input.profileId, conversationId: input.conversationId, runId: run.id,
      installationId: records.installation.installationId, releaseDigest: records.installation.activeReleaseDigest,
      componentId: records.binding.componentId, bindingId: records.binding.bindingId,
      bindingRevision: records.binding.revision, connectionId: records.connection.connectionId,
      principalIdentity: records.connection.principalIdentity, authRevision: records.connection.authRevision,
      toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest, catalogRevision: tool.catalogRevision };
    const pin = { ...input, runId: run.id, workspace: run.workspace, authority,
      authorityIncarnation: records.authorityIncarnation,
      installationRevision: records.installation.revision, endpointIdentity: records.connection.endpointIdentity,
      originalGrantEpoch: records.grant.epoch, originalGrantRevision: records.grant.revision,
      resourceUri: tool.ui.resourceUri, tool, tools, policy, seed, expiresAt: this.now() + 120_000 };
    const challenge = crypto.randomBytes(32).toString("hex");
    this.#pending.set(challenge, pin);
    const release = this.store.getRelease(records.installation.sourceIdentity, records.installation.activeReleaseDigest);
    return { challenge, expiresAt: pin.expiresAt, summary: { action: "app-open", agent: profile.name,
      package: release.name, capability: tool.downstreamName, toolCount: tools.length } };
  }

  async commit(input) {
    if (!plain(input) || typeof input.challenge !== "string" || typeof input.approved !== "boolean"
      || !exact(input, input.approved ? ["challenge", "approved", "hostOrigin", "sandboxOrigin", "sourceId"]
        : ["challenge", "approved"])) fail();
    const pin = this.#pending.get(input.challenge);
    this.#pending.delete(input.challenge);
    if (!pin || pin.expiresAt <= this.now()) fail("MCP_APP_SESSION_EXPIRED");
    if (!input.approved) return { canceled: true, descriptor: null };
    if (this.#sessions.size + this.#opening >= 32) fail("MCP_APP_LIMIT");
    try {
      if (!validId(input.sourceId) || typeof input.hostOrigin !== "string" || typeof input.sandboxOrigin !== "string"
        || !["http:", "https:"].includes(new URL(input.hostOrigin).protocol)
        || !["http:", "https:"].includes(new URL(input.sandboxOrigin).protocol)
        || new URL(input.hostOrigin).origin !== input.hostOrigin || new URL(input.sandboxOrigin).origin !== input.sandboxOrigin
        || input.hostOrigin === input.sandboxOrigin) fail("MCP_APP_ORIGIN_INVALID");
    } catch { fail("MCP_APP_ORIGIN_INVALID"); }
    const generation = this.#generation;
    const opening = { pin, canceled: false };
    const assertOpening = () => {
      if (opening.canceled || generation !== this.#generation || pin.expiresAt <= this.now()) fail("MCP_APP_SESSION_EXPIRED");
      this.#assertPin(pin); return true;
    };
    const current = this.#assertPin(pin);
    this.#opening += 1;
    this.#openingPins.set(input.challenge, opening);
    let client;
    try {
      client = await this.manager.acquire(current.records);
      assertOpening();
      if (typeof client.readAppResource !== "function") fail("MCP_APP_UNSUPPORTED");
      const resource = await client.readAppResource({ toolName: pin.tool.downstreamName,
        contractDigest: pin.tool.contractDigest, resourceUri: pin.resourceUri, assertCurrent: assertOpening });
      assertOpening();
      const managementTicket = crypto.randomBytes(32).toString("hex");
      const sessions = new PluginAppSessionManager({ now: this.now,
        assertAuthority: () => { this.#assertPin(pin); return true; },
        dispatchCapability: (request) => this.#dispatch(pin, managementTicket, request) });
      // The originating tool remains part of the resource identity even when
      // its own visibility/each-call policy disallows further App calls.
      const sessionTools = pin.tools.map(entry => ({ ...entry, visibility: ["app"] }));
      if (!sessionTools.some(entry => entry.toolIdentity === pin.tool.toolIdentity)) {
        sessionTools.push({ ...pin.tool, visibility: ["model"] });
      }
      const opened = sessions.create({ authority: pin.authority,
        tool: { name: pin.tool.downstreamName, _meta: { ui: pin.tool.ui } }, resource, tools: sessionTools,
        hostOrigin: input.hostOrigin, sandboxOrigin: input.sandboxOrigin, sourceId: input.sourceId });
      const chunks = chunksFor(opened.resource.html);
      const descriptor = { transport: { sessionId: opened.sessionId, nonce: opened.nonce, sourceId: opened.sourceId,
        origin: opened.sandboxOrigin, conversationId: pin.conversationId },
        hostOrigin: opened.hostOrigin, sandboxOrigin: opened.sandboxOrigin, expiresAt: opened.expiresAt,
        resource: { uri: opened.resource.uri, mimeType: opened.resource.mimeType,
          resourceDigest: opened.resource.resourceDigest, encoding: "base64",
          contentDigest: crypto.createHash("sha256").update(opened.resource.html).digest("hex"),
          byteLength: Buffer.byteLength(opened.resource.html), chunkCount: chunks.length }, policy: opened.resource.policy,
        initialNotifications: structuredClone(pin.seed.notifications) };
      if (Buffer.byteLength(JSON.stringify(descriptor), "utf8") > 44 * 1024) {
        sessions.clear(); fail("MCP_APP_SEED_LIMIT");
      }
      this.#sessions.set(opened.sessionId, { sessions, chunks, pin, expiresAt: opened.expiresAt, reads: 0 });
      return { canceled: false, descriptor };
    } finally {
      this.#opening -= 1; this.#openingPins.delete(input.challenge);
      await client?.release();
    }
  }

  #assertTool(pin, selected) {
    const current = this.#assertPin(pin);
    const records = this.store.getCapabilityRecords(pin.authority.bindingId, selected.toolIdentity);
    const tool = this.catalog.resolve({ ...records, toolIdentity: selected.toolIdentity });
    const grant = records?.grant;
    if (!tool || tool.catalogRevision !== pin.authority.catalogRevision
      || tool.contractDigest !== selected.contractDigest || tool.appUnsupported
      || (tool.ui && !tool.ui.visibility.includes("app"))
      || grant?.effect !== "allow" || grant.approvalMode !== "always"
      || grant.epoch !== selected.grantEpoch || grant.revision !== selected.grantRevision
      || (grant.expiresAt !== null && grant.expiresAt <= this.now())) {
      fail("MCP_APP_TOOL_FORBIDDEN");
    }
    return { ...current, records };
  }

  async #dispatch(pin, managementTicket, request) {
    const selected = pin.tools.find(entry => entry.toolIdentity === request.tool.toolIdentity);
    if (!selected || this.#inFlight >= 64) fail("MCP_APP_TOOL_FORBIDDEN");
    const assertCurrent = () => {
      request.assertCurrent();
      if (request.signal.aborted) fail("MCP_APP_REQUEST_CANCELLED");
      this.#assertTool(pin, selected);
    };
    assertCurrent();
    this.#inFlight += 1;
    let client;
    try {
      const { profile, records } = this.#assertTool(pin, selected);
      client = await this.manager.acquire(records);
      assertCurrent();
      return await this.dispatcher.dispatch({ client, callId: request.callId,
        authority: { kind: "native-profile", profileId: profile.id, profile,
          confirmed: true, managementTicket, managementTicketVerified: true },
        execution: { kind: "user-interaction", profileId: profile.id, workspace: pin.workspace, managementTicket },
        envelope: { runId: pin.runId, authorityIncarnation: pin.authorityIncarnation,
          bindingId: records.binding.bindingId,
          installationId: records.installation.installationId, releaseDigest: pin.authority.releaseDigest,
          componentId: records.binding.componentId, connectionId: records.connection.connectionId,
          principalIdentity: records.connection.principalIdentity, bindingRevision: records.binding.revision,
          grantEpoch: selected.grantEpoch, connectionAuthRevision: records.connection.authRevision,
          toolIdentity: selected.toolIdentity, contractDigest: selected.contractDigest },
        bindingId: records.binding.bindingId, toolIdentity: selected.toolIdentity,
        downstreamToolName: selected.downstreamName, contractDigest: selected.contractDigest,
        arguments: request.arguments, assertCurrent });
    } finally { this.#inFlight -= 1; await client?.release(); }
  }

  #slot(transport) {
    if (!plain(transport) || !validId(transport.sessionId)) fail("MCP_APP_TRANSPORT_INVALID");
    const slot = this.#sessions.get(transport.sessionId);
    if (!slot) fail("MCP_APP_SESSION_EXPIRED");
    try { slot.sessions.assertCurrent(transport); }
    catch (error) {
      // A wrong nonce/source cannot destroy another caller's session.
      if (error?.code !== "MCP_APP_TRANSPORT_INVALID") this.#dispose(transport.sessionId, slot);
      throw error;
    }
    return slot;
  }

  readChunk(transport, index) {
    const slot = this.#slot(transport);
    if (!Number.isSafeInteger(index) || index < 0 || index >= slot.chunks.length) fail("MCP_APP_RESOURCE_INVALID");
    if (++slot.reads > 256) { this.#dispose(transport.sessionId, slot); fail("MCP_APP_LIMIT"); }
    return { index, text: slot.chunks[index], total: slot.chunks.length };
  }

  async message(transport, message) {
    const slot = this.#slot(transport);
    try { return await slot.sessions.handle(transport, message); }
    finally {
      try { slot.sessions.assertCurrent(transport); }
      catch { this.#dispose(transport.sessionId, slot); }
    }
  }

  close(transport) {
    const slot = this.#slot(transport);
    const result = slot.sessions.close(transport);
    this.#dispose(transport.sessionId, slot);
    return result;
  }

  #dispose(id, slot) {
    slot.sessions.clear(); slot.chunks.length = 0;
    this.#sessions.delete(id);
  }

  #dropSeed(callId) {
    this.#seeds.delete(callId);
    for (const [id, slot] of this.#sessions) if (slot.pin.callId === callId) this.#dispose(id, slot);
    for (const [challenge, pin] of this.#pending) if (pin.callId === callId) this.#pending.delete(challenge);
    for (const opening of this.#openingPins.values()) if (opening.pin.callId === callId) opening.canceled = true;
  }

  revoke(selector) {
    if (!plain(selector) || !Object.keys(selector).length
      || Object.keys(selector).some(key => !["profileId", "conversationId", "runId", "connectionId", "installationId"].includes(key)
        || !validId(selector[key]))) fail();
    let closedCount = 0;
    for (const [id, slot] of this.#sessions) {
      if (Object.entries(selector).every(([key, value]) => slot.pin.authority[key] === value)) {
        this.#dispose(id, slot); closedCount += 1;
      }
    }
    for (const [challenge, pin] of this.#pending) {
      if (Object.entries(selector).every(([key, value]) => pin.authority[key] === value)) this.#pending.delete(challenge);
    }
    for (const opening of this.#openingPins.values()) {
      if (Object.entries(selector).every(([key, value]) => opening.pin.authority[key] === value)) opening.canceled = true;
    }
    return { closedCount };
  }

  sweep() {
    for (const [challenge, pin] of this.#pending) if (pin.expiresAt <= this.now()) this.#pending.delete(challenge);
    for (const [id, slot] of this.#sessions) if (slot.expiresAt <= this.now()) this.#dispose(id, slot);
  }

  clear() {
    this.#generation += 1; this.#pending.clear(); this.#seeds.clear();
    for (const [id, slot] of this.#sessions) this.#dispose(id, slot);
  }
}

module.exports = { PluginAppController };
