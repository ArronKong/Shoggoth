"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { serviceError, lstatIfExists } = require("./security");
const { tokenizeCommand, resolveOnPath } = require("./mcp-package-launcher");
const { validateConnectorParams } = require("../core/connector-dto");
const { CONNECTOR_PUBLIC_MESSAGES } = require("../core/connector-errors");
const { normalizeConnectionRequest } = require("./chat-ui-contract");
const { canonicalMcpCredentialField, publicOAuthClient } = require("../core/mcp-credential-fields");
const { validatedQueryCredentials, querySecretVariants } = require("./mcp-transport-utils");
const { validateOfficialSkillBridgeCredentials } = require("./official-skill-mcp-launch");
const { matchTicketmasterBridgeLaunch, normalizeTicketmasterTransport, validateTicketmasterBridgeCredentials, KEY_FIELD } = require("./ticketmaster-mcp-launch");
const { matchFlightawareBridgeLaunch, normalizeFlightawareTransport, validateFlightawareBridgeCredentials, flightawareConfiguredFields, KEY_FIELD: FLIGHTAWARE_KEY_FIELD } = require("./flightaware-mcp-launch");
const { normalizeCustomMcpTransport } = require("./mcp-agent-setup-plan");
const { McpAgentSetup } = require("./mcp-agent-setup");
const fail = code => { throw serviceError(code, code); };
const copy = value => JSON.parse(JSON.stringify(value));
const MAX_REQUESTS = 512;
const EXPIRES_MS = 24 * 60 * 60 * 1000;
const RETIRED_TOOLS = Object.freeze(["connector_list_apps", "connector_list_connections", "connector_search_actions", "connector_get_action_guide", "connector_execute_action"]);
const publicRequest = r => Object.fromEntries(["requestId", "kind", "serverId", "registryName", "url", "title", "purpose", "status", "requiredFields", "expiresAt", "createdAt", "updatedAt", ...(r.kind === "setup" ? ["serverIds", "continuation"] : [])].map(k => [k, copy(r[k])]));
function publicUrl(raw) { if (!raw) return null; const u = new URL(raw); u.username = ""; u.password = ""; u.search = ""; u.hash = ""; return u.href; }
const { mcpConnectorSubjectId: subjectId } = require("../core/mcp-connector-identity");
function configured(fields) {
  return ["env", "headers", "query", "arguments", "variables"].flatMap(k => Object.keys(fields?.[k] || {}).map(n => `${k === "headers" ? "header" : k === "arguments" ? "argument" : k === "variables" ? "variable" : k}:${n}`))
    .concat(Object.keys(publicOAuthClient(fields?.oauthClient)).filter(k => k !== "redirectUri").map(k => `oauthClient:${k}`));
}
const executionSignature = record => JSON.stringify([record.enabled, record.transport, record.auth, record.secretRef]);
function credentialFields(fields = {}) { return Object.fromEntries(["env", "headers", "query", "oauthClient"].filter(k => fields[k] !== undefined && Object.keys(fields[k]).length > 0).map(k => [k, fields[k]])); }
function noSecretsInTransport(transport, fields) {
  validatedQueryCredentials(transport, fields.query);
  const serialized = JSON.stringify(transport);
  const values = Object.values(fields.env || {}).concat(Object.values(fields.headers || {}), Object.values(fields.oauthClient || {}), querySecretVariants(fields.query));
  if (values.some(v => typeof v === "string" && v.length && serialized.includes(v))) fail("MCP_SECRET_INVALID");
  if (["stdio-command", "stdio-package"].includes(transport.kind) && (transport.kind === "stdio-command" ? transport.args : transport.packageArgs || []).some(v => /^(?:--?(?:password|token|api[-_]key|secret|authorization))(?:=|$)/iu.test(v))) fail("MCP_SECRET_INVALID");
}

function validateStoredRequest(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) fail("MCP_REQUEST_STORE_CORRUPT");
  const { owner, fingerprint, ...publicValue } = r;
  normalizeConnectionRequest(publicValue);
  if (!/^mcp-request-[A-Za-z0-9-]{1,100}$/u.test(r.requestId) || !/^[a-f0-9]{64}$/u.test(fingerprint || "")) fail("MCP_REQUEST_STORE_CORRUPT");
  const required = ["profileId", "sessionKey", "transcriptSessionId"], optional = ["agentId", "backendId", "runId"];
  if (!owner || Object.getPrototypeOf(owner) !== Object.prototype || required.some(k => !Object.hasOwn(owner, k))
    || Object.keys(owner).some(k => !required.includes(k) && !optional.includes(k))
    || Object.entries(owner).some(([key,v]) => typeof v !== "string" || !v.length || v.length > (key === "sessionKey" ? 2048 : 256) || /[\u0000-\u001f\u007f]/u.test(v))) fail("MCP_REQUEST_STORE_CORRUPT");
  if (owner.backendId && !["shoggoth", "openclaw", "hermes"].includes(owner.backendId)) fail("MCP_REQUEST_STORE_CORRUPT");
  if ((r.kind === "secret" && (!r.serverId || r.requiredFields.length !== 1 || r.registryName || r.url))
    || (r.kind === "connection" && (r.requiredFields.length || Number(Boolean(r.registryName)) + Number(Boolean(r.url)) !== 1))
    || (r.kind === "setup" && (!owner.runId || r.registryName || r.url || r.requiredFields.length))
    || (r.status === "completed" && !r.serverId)) fail("MCP_REQUEST_STORE_CORRUPT");
}

class McpConnectorController {
  constructor({ store, secrets, manager, registry, packageLauncher, oauth, paths, getSubjects = async () => ({ items: [], unavailableBackends: [] }),
    getOwner, chatUiStore, onComplete, waitForSetupOwner, assertSecretSafe = () => {}, now = Date.now, randomUUID = crypto.randomUUID } = {}) {
    Object.assign(this, { store, secrets, manager, registry, packageLauncher, oauth, paths, getSubjects, getOwner, chatUiStore, onComplete, assertSecretSafe, now, randomUUID });
    this.requests = new Map(); this.requestQueue = Promise.resolve(); this.checks = new Map(); this.allChecks = new Set(); this.generations = new Map(); this.mutationQueue = Promise.resolve(); this.runs = new Map(); this.closed = true;
    // Display-only snapshots from the existing readiness probe. Reading a detail
    // dialog must never start a process, repeat a probe or call a business tool.
    this.toolDescriptions = new Map();
    this.requestsPath = path.join(paths.nativeMcpDir, "connection-requests-v1.json");
    this.agentSetup = new McpAgentSetup({ connector: this, publicRequest, waitForOwner: waitForSetupOwner });
  }
  open() {
    const requests = new Map();
    try {
      if (lstatIfExists(this.requestsPath)) {
        const data = JSON.parse(readPrivateFile(this.requestsPath, { maxBytes: 1024 * 1024 }).toString("utf8"));
        if (!data || Object.keys(data).sort().join(",") !== "requests,schemaVersion" || data.schemaVersion !== 1
          || !Array.isArray(data.requests) || data.requests.length > MAX_REQUESTS) fail("MCP_REQUEST_STORE_CORRUPT");
        for (const r of data.requests) {
          validateStoredRequest(r); this.assertSecretSafe(JSON.stringify(r));
          if (requests.has(r.requestId)) fail("MCP_REQUEST_STORE_CORRUPT");
          requests.set(r.requestId, copy(r));
        }
      }
    } catch { fail("MCP_REQUEST_STORE_CORRUPT"); }
    this.requests = requests; this.closed = false;
    this.agentSetup.open();
    return this;
  }
  assertOpen() { if (this.closed) fail("MCP_CONNECTORS_UNAVAILABLE"); }
  stopAdmission() { this.closed = true; this.runs.clear(); this.toolDescriptions.clear(); this.agentSetup.stop(); }
  async close() {
    this.stopAdmission();
    await this.oauth?.close();
    await Promise.allSettled([...this.checks.keys()].map(id => this.manager.closeServer(id)));
    await Promise.allSettled([this.requestQueue, this.mutationQueue, this.agentSetup.queue, ...this.allChecks]);
  }
  mutate(action) {
    const pending = this.mutationQueue.catch(() => {}).then(() => { this.assertOpen(); return action(); });
    this.mutationQueue = pending; return pending;
  }
  expectRevision(revision) { if (revision !== this.store.revision) fail("MCP_REGISTRY_REVISION_CONFLICT"); }
  revokeRuns(id, profiles = null) { for (const snapshot of this.runs.values()) if (!profiles || profiles.includes(snapshot.profileId)) snapshot.ids.delete(id); }
  invalidate(id) { const generation = (this.generations.get(id) || 0) + 1; this.generations.set(id, generation); this.checks.delete(id); this.toolDescriptions.delete(id); return generation; }
  authorizationChanged(event) {
    this.assertOpen();
    if (event.status === "authorized") return this.mutate(() => this.refreshOAuthConfiguredFields(event.id)).then(() => this.verify(event.id, { refresh: true }));
    if (!["signedOut", "failed"].includes(event.status) || !this.store.get(event.id)) return Promise.resolve();
    this.invalidate(event.id); this.revokeRuns(event.id);
    const errorCode = event.status === "signedOut" ? "MCP_SIGN_IN_REQUIRED"
      : Object.hasOwn(CONNECTOR_PUBLIC_MESSAGES, event.errorCode) ? event.errorCode : "MCP_OAUTH_FAILED";
    this.store.setStatus(event.id, event.status, { at: this.now(), toolCount: 0, errorCode });
    return Promise.resolve(this.manager.closeServer(event.id));
  }
  async refreshOAuthConfiguredFields(id) {
    const record = this.store.getPrivate(id); if (!record) fail("MCP_SERVER_NOT_FOUND");
    if (!record.secretRef) return this.store.get(id);
    const saved = await this.secrets.get(record.secretRef);
    const names = configured({ oauthClient: saved?.oauthClient });
    const configuredFields = [...new Set([...record.setup.configuredFields.map(value => canonicalMcpCredentialField(value) || value), ...names])];
    if (JSON.stringify(configuredFields) !== JSON.stringify(record.setup.configuredFields)) this.store.update({ id, patch: { setup: { ...record.setup, configuredFields } }, expectedRevision: this.store.revision });
    return this.store.get(id);
  }
  async completeCredentials(id, fields, expectedRevision) {
    if (!fields.oauthClient) return this.credentials({ id, fields, expectedRevision });
    await this.mutate(async () => {
      this.expectRevision(expectedRevision);
      const record = this.store.getPrivate(id); if (!record) fail("MCP_SERVER_NOT_FOUND");
      const saved = record.secretRef ? await this.secrets.get(record.secretRef) : null;
      const oauthClient = { ...publicOAuthClient(saved?.oauthClient), ...fields.oauthClient };
      if (!oauthClient.clientId) fail("MCP_SECRET_INVALID");
      const input = { id, fields: { oauthClient }, expectedRevision };
      validateConnectorParams("connector.mcp.credentials.update", input);
      await this.writeCredentials(input, { oauthClientMetadata: saved?.oauthClient });
    });
    return this.verify(id);
  }
  mutationFailed(id, generation, error) {
    if (!this.closed && this.generations.get(id) === generation && this.store.get(id)) this.store.setStatus(id, "failed", { at: this.now(), toolCount: 0, errorCode: "MCP_CREDENTIAL_WRITE_FAILED" });
    throw error;
  }
  persistRequests() {
    try { atomicWritePrivateFile(this.requestsPath, `${JSON.stringify({ schemaVersion: 1, requests: [...this.requests.values()] })}\n`, { trustedRoot: this.paths.trustedRoot }); }
    catch { this.stopAdmission(); fail("MCP_REQUEST_STORE_UNAVAILABLE"); }
  }
  ensureRequestCapacity() {
    if (this.requests.size >= MAX_REQUESTS) for (const [id, request] of this.requests) {
      if (request.status !== "pending" || request.expiresAt <= this.now()) this.requests.delete(id);
    }
    if (this.requests.size >= MAX_REQUESTS) fail("MCP_REQUEST_CAPACITY");
  }
  projectRequest(request) {
    if (!request.owner.backendId || request.owner.backendId === "shoggoth") this.chatUiStore?.upsertConnectionRequest(request.owner, publicRequest(request));
  }
  saveRequest(request) {
    validateStoredRequest(request);
    this.requests.set(request.requestId, request);
    try { this.persistRequests(); } catch (error) { this.requests.delete(request.requestId); throw error; }
    this.projectRequest(request);
  }
  captureRun(run) {
    if (this.closed || !run?.id) return;
    if (this.runs.has(run.id)) return;
    this.runs.set(run.id, { profileId: run.profileId, ids: new Set(this.store.list().servers.filter(s => this.store.isAvailable(s.id, run.profileId)).map(s => s.id)) });
    if (this.runs.size > 512) this.runs.delete(this.runs.keys().next().value);
  }
  releaseRun(id) { this.runs.delete(id); }
  available(profileId, runId) {
    this.assertOpen();
    const snapshot = runId ? this.runs.get(runId) : null;
    if (runId && (!snapshot || snapshot.profileId !== profileId)) return [];
    return this.store.list().servers.filter(s => this.store.isAvailable(s.id, profileId) && (!snapshot || snapshot.ids.has(s.id)));
  }
  assertAvailable(id, profileId, runId) { if (!this.available(profileId, runId).some(s => s.id === id)) fail("MCP_CONNECTOR_ACCESS_DENIED"); }
  async verify(id, { refresh = false } = {}) {
    const { operation } = await this.mutate(() => {
      const record = this.store.getPrivate(id); if (!record) fail("MCP_SERVER_NOT_FOUND");
      if (!record.enabled) return { operation: Promise.resolve({ revision: this.store.revision, server: this.store.get(id) }) };
      const key = field => field.startsWith("header:") ? field.toLowerCase() : canonicalMcpCredentialField(field) || field;
      const configured = new Set(record.setup.configuredFields.map(key));
      if (record.source.kind === "custom" && record.setup.requiredFields.some(field => !configured.has(key(field)))) {
        return { operation: Promise.resolve(this.store.setStatus(id, "needsSetup", { at: this.now(), toolCount: 0, errorCode: "MCP_SETUP_REQUIRED" })) };
      }
      const signature = executionSignature(record), previous = this.checks.get(id);
      if (refresh || previous && previous.signature !== signature) this.invalidate(id);
      const generation = this.generations.get(id) || 0;
      if (previous?.generation === generation && previous.signature === signature) return { operation: previous.operation };
      this.store.setStatus(id, "checking", null);
      const operation = this.probe(id, generation, signature);
      this.checks.set(id, { generation, signature, operation }); this.allChecks.add(operation);
      operation.finally(() => { this.allChecks.delete(operation); if (this.checks.get(id)?.operation === operation) this.checks.delete(id); }).catch(() => {});
      return { operation };
    });
    const result = await operation;
    if (result.server?.status === "ready") this.agentSetup.changed();
    return result;
  }
  async probe(id, generation, signature) {
    let status = "ready", errorCode = null, toolCount = 0, tools = [];
    try { await this.manager.closeServer(id); tools = await this.manager.listTools(id); toolCount = tools.length; }
    catch (error) {
      errorCode = /^[A-Z][A-Z0-9_]{0,127}$/u.test(error?.code || "") ? error.code : "MCP_SERVER_PROBE_FAILED";
      status = /AUTH_REQUIRED|SIGN_IN_REQUIRED|OAUTH_REQUIRED/u.test(errorCode) ? "signedOut" : "failed";
    }
    return this.mutate(() => {
      const current = this.store.getPrivate(id);
      if (!current) fail("MCP_SERVER_NOT_FOUND");
      if ((this.generations.get(id) || 0) !== generation || executionSignature(current) !== signature) fail("MCP_REGISTRY_REVISION_CONFLICT");
      if (!current.enabled) return { revision: this.store.revision, server: this.store.get(id) };
      if (status === "signedOut" && current.transport.kind === "remote" && current.auth.kind === "none") this.store.update({ id, patch: { auth: { kind: "oauth-dcr" } }, expectedRevision: this.store.revision });
      const result = this.store.setStatus(id, status, { at: this.now(), toolCount, errorCode });
      if (status === "ready") this.toolDescriptions.set(id, { generation, signature, checkedAt: result.server.lastCheck.at, items: this.displayTools(tools) });
      else this.toolDescriptions.delete(id);
      return result;
    });
  }
  displayTools(tools) {
    const items = [], seen = new Set();
    for (const tool of tools.slice(0, 256)) {
      if (!tool || typeof tool.name !== "string" || !tool.name.length || !tool.name.isWellFormed()
        || /[\u0000-\u001f\u007f]/u.test(tool.name) || Buffer.byteLength(tool.name) > 256 || seen.has(tool.name)) continue;
      let description = typeof tool.description === "string" && tool.description.isWellFormed()
        ? tool.description.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "") : "";
      if (Buffer.byteLength(description) > 2048) {
        let bounded = "";
        for (const character of description) { if (Buffer.byteLength(bounded + character) > 2045) break; bounded += character; }
        description = `${bounded}…`;
      }
      try { this.assertSecretSafe(tool.name); } catch { continue; }
      try { this.assertSecretSafe(description); } catch { description = ""; }
      seen.add(tool.name); items.push({ name: tool.name, description });
    }
    return items;
  }
  tools(id) {
    const record = this.store.getPrivate(id); if (!record) fail("MCP_SERVER_NOT_FOUND");
    const cached = this.toolDescriptions.get(id);
    const available = !!(record.enabled && record.status === "ready" && cached
      && cached.generation === (this.generations.get(id) || 0) && cached.signature === executionSignature(record)
      && cached.checkedAt === record.lastCheck?.at);
    // Recheck the current secret matcher before a snapshot crosses the UI boundary.
    return { id, available, items: available ? this.displayTools(cached.items) : [],
      totalCount: record.lastCheck?.toolCount || 0, checkedAt: record.lastCheck?.at ?? null };
  }
  async add(input, options = {}) { const id = await this.mutate(() => this.addPrepared(options.currentRevision ? { ...input, expectedRevision: this.store.revision } : input, options)); return this.verify(id); }
  async addPrepared(input, options = {}) {
    this.assertOpen();
    if (input.expectedRevision !== this.store.revision) fail("MCP_REGISTRY_REVISION_CONFLICT");
    let transport, requiredFields = [], configuredFields = configured(input.fields), name = input.name, source = input.source;
    let fields = input.fields || {}, previous = null;
    if (source.kind === "registry") {
      const existingRegistry = this.store.list().servers.find(v => v.source.kind === "registry" && v.source.registryName === source.registryName);
      previous = existingRegistry && this.store.getPrivate(existingRegistry.id);
      if (previous?.secretRef) {
        const saved = credentialFields(await this.secrets.get(previous.secretRef) || {});
        fields = { ...saved, ...fields, env: { ...saved.env, ...fields.env }, headers: { ...saved.headers, ...fields.headers } };
      }
      const item = await this.registry.get(source.registryName, source.version);
      const resolved = this.registry.resolveOption(item, input.option.id, fields);
      fields = { ...fields, env: { ...resolved.env, ...fields.env }, headers: { ...resolved.headers, ...fields.headers } };
      transport = resolved.transport; requiredFields = resolved.requiredFields || [];
      configuredFields = [...new Set([...(resolved.configuredFields || []), ...configured(fields)])]; name ||= item.name;
    } else {
      transport = normalizeCustomMcpTransport(input.option, this.paths);
      requiredFields = options.requiredFields || [];
      name ||= transport.kind === "remote" ? new URL(transport.url).hostname : transport.kind === "stdio-package" ? transport.identifier : path.basename(transport.command);
    }
    validateOfficialSkillBridgeCredentials(transport, fields, { paths: this.paths });
    validateTicketmasterBridgeCredentials(transport, fields);
    validateFlightawareBridgeCredentials(transport, fields);
    if (transport.kind === "stdio-command" && matchTicketmasterBridgeLaunch(transport.command, transport.args)) requiredFields = [`env:${KEY_FIELD}`];
    if (transport.kind === "stdio-command" && matchFlightawareBridgeLaunch(transport.command, transport.args)) requiredFields = [`env:${FLIGHTAWARE_KEY_FIELD}`];
    configuredFields = flightawareConfiguredFields(transport, configuredFields, fields);
    noSecretsInTransport({ ...transport, name }, fields);
    if (fields.query && (fields.oauthClient || input.auth && input.auth.kind !== "headers")) fail("MCP_SECRET_INVALID");
    this.assertSecretSafe(JSON.stringify({ name, transport }));
    if (transport.kind === "stdio-package") await this.packageLauncher.prepare(transport);
    const existing = source.kind === "registry" ? this.store.list().servers.find(s => s.source.kind === "registry" && s.source.registryName === source.registryName) : null;
    const id = existing?.id || `mcp-${this.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const explicit = input.fields || {};
    const auth = input.auth || (fields.query ? { kind: "headers" } : explicit.oauthClient ? { kind: "oauth-client" } : Object.keys(explicit.headers || {}).length ? { kind: "headers" } : previous?.auth)
      || { kind: fields.oauthClient ? "oauth-client" : Object.keys(fields.headers || {}).length ? "headers" : "none" };
    const creds = credentialFields(fields);
    const secretRef = Object.keys(creds).length ? this.secrets.refFor(id) : existing ? this.store.getPrivate(id).secretRef : null;
    const server = this.store.prepare({ id, name, enabled: true, source, transport, auth, secretRef,
      setup: { requiredFields, configuredFields }, status: "checking", lastCheck: null, disabledProfileIds: existing?.disabledProfileIds || [] });
    if (input.expectedRevision !== this.store.revision) fail("MCP_REGISTRY_REVISION_CONFLICT");
    this.store.register({ server: { ...server, secretRef: previous?.secretRef || null }, expectedRevision: input.expectedRevision });
    const generation = this.invalidate(id);
    try {
      await this.oauth.cancelServer?.(id);
      if (Object.keys(creds).length) {
        if (!previous?.secretRef) await this.secrets.remove(id);
        await this.secrets.write(id, creds);
        if (this.store.getPrivate(id).secretRef !== secretRef) this.store.update({ id, patch: { secretRef }, expectedRevision: this.store.revision });
      }
    }
    catch (error) { this.mutationFailed(id, generation, error); }
    return id;
  }
  async credentials(input) { await this.mutate(() => this.writeCredentials(input)); return this.verify(input.id); }
  async writeCredentials(input, { oauthClientMetadata } = {}) {
    const record = this.store.getPrivate(input.id); if (!record) fail("MCP_SERVER_NOT_FOUND");
    if (input.expectedRevision !== this.store.revision) fail("MCP_REGISTRY_REVISION_CONFLICT");
    const fields = credentialFields(input.fields);
    if (!Object.keys(fields).length) fail("MCP_SECRET_INVALID");
    validateOfficialSkillBridgeCredentials(record.transport, fields, { paths: this.paths });
    validateTicketmasterBridgeCredentials(record.transport, fields);
    validateFlightawareBridgeCredentials(record.transport, fields);
    noSecretsInTransport(record.transport, fields);
    if (fields.oauthClient && (fields.query || record.secretRef && (await this.secrets.get(record.secretRef))?.query)) fail("MCP_SECRET_INVALID");
    const patch = { status: "checking", lastCheck: null, setup: { ...record.setup, configuredFields: flightawareConfiguredFields(record.transport, [...new Set([...record.setup.configuredFields, ...configured(input.fields)])], fields) },
      ...(fields.oauthClient ? { auth: { kind: "oauth-client" } } : fields.headers || fields.query ? { auth: { kind: "headers" } } : {}) };
    // Revoke availability durably before the asynchronous credential write.
    // All setup mutations share this queue, so stale CAS inputs cannot mutate secrets.
    this.store.update({ id: input.id, patch, expectedRevision: input.expectedRevision });
    const generation = this.invalidate(input.id);
    try {
      await this.oauth.cancelServer?.(input.id);
      if (!record.secretRef) await this.secrets.remove(input.id);
      let privateFields = fields;
      if (fields.oauthClient && oauthClientMetadata) {
        const oauthClient = { ...oauthClientMetadata, ...fields.oauthClient };
        delete oauthClient.client_id; delete oauthClient.client_secret;
        privateFields = { ...fields, oauthClient };
      }
      await this.secrets.write(input.id, { ...privateFields, ...(fields.oauthClient || fields.headers || fields.query ? { oauthToken: null, oauthDiscovery: null, oauthCodeVerifier: null } : {}) });
      if (!record.secretRef) this.store.update({ id: input.id, patch: { secretRef: this.secrets.refFor(input.id) }, expectedRevision: this.store.revision });
    } catch (error) { this.mutationFailed(input.id, generation, error); }
  }
  async import(input) {
    let data; try { data = typeof input.config === "string" ? JSON.parse(input.config) : input.config; } catch { fail("MCP_IMPORT_INVALID"); }
    const servers = data?.mcpServers || data?.servers || (data?.command || data?.url ? { Imported: data } : null);
    if (!servers || Object.getPrototypeOf(servers) !== Object.prototype || Object.keys(servers).length > 64) fail("MCP_IMPORT_INVALID");
    if (input.expectedRevision !== this.store.revision) fail("MCP_REGISTRY_REVISION_CONFLICT");
    const installed = [], errors = [];
    for (const [name, spec] of Object.entries(servers)) {
      try {
        if (!spec || Object.getPrototypeOf(spec) !== Object.prototype || Object.keys(spec).some(k => !["command", "args", "cwd", "env", "url", "headers", "type", "transport"].includes(k))) fail("MCP_IMPORT_INVALID");
        const fields = { ...(spec.env ? { env: spec.env } : {}), ...(spec.headers ? { headers: spec.headers } : {}) };
        const option = spec.url ? { kind: "remote", protocol: spec.type === "sse" || spec.transport === "sse" ? "sse" : "streamable-http", url: spec.url }
          : { kind: "stdio-command", commandLine: [spec.command, ...(spec.args || [])].map(v => `'${String(v).replaceAll("'", "'\\''")}'`).join(" "), cwd: spec.cwd || this.paths.defaultWorkspaceDir };
        const result = await this.add({ source: { kind: "custom" }, name, option, fields, expectedRevision: this.store.revision }); installed.push(result.server);
      } catch (e) { errors.push({ name, errorCode: /^[A-Z][A-Z0-9_]+$/u.test(e?.code || "") ? e.code : "MCP_IMPORT_INVALID" }); }
    }
    return { revision: this.store.revision, servers: installed, errors };
  }
  async request(args, owner) {
    this.assertOpen();
    if (!owner?.profileId || !owner?.sessionKey || !owner?.transcriptSessionId) fail("MCP_REQUEST_ACCESS_DENIED");
    this.assertSecretSafe(JSON.stringify(args));
    if (args.serverId) {
      const field = canonicalMcpCredentialField(args.field); if (!field) fail("MCP_REQUEST_TARGET_MISMATCH");
      args = { ...args, field };
    }
    const kind = args.serverId ? "secret" : "connection";
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify([owner.profileId, owner.sessionKey, owner.runId, kind, args])).digest("hex");
    const old = [...this.requests.values()].find(r => r.fingerprint === fingerprint);
    if (old) return publicRequest(old);
    this.ensureRequestCapacity();
    if (kind === "secret") {
      const server = args.field.startsWith("oauthClient:") ? await this.mutate(() => this.refreshOAuthConfiguredFields(args.serverId)) : this.store.get(args.serverId);
      if (!server || !server.enabled || server.disabledProfileIds.includes(owner.profileId)) fail("MCP_CONNECTOR_ACCESS_DENIED");
      const declared = [...server.setup.requiredFields, ...server.setup.configuredFields].map(value => canonicalMcpCredentialField(value) || value);
      if (!declared.includes(args.field)) fail("MCP_REQUEST_TARGET_MISMATCH");
    }
    // Resolving existing OAuth metadata can yield; preserve same-call idempotency.
    this.assertOpen();
    const duplicate = [...this.requests.values()].find(r => r.fingerprint === fingerprint);
    if (duplicate) return publicRequest(duplicate);
    if (this.requests.size >= MAX_REQUESTS) fail("MCP_REQUEST_CAPACITY");
    const now = this.now();
    const request = { requestId: `mcp-request-${this.randomUUID()}`, kind, serverId: args.serverId || null, registryName: args.registryName || null,
      url: publicUrl(args.url), title: (kind === "secret" ? this.store.get(args.serverId).name : args.registryName || publicUrl(args.url)).slice(0, 240), purpose: args.purpose,
      status: "pending", requiredFields: args.field ? [{ name: args.field.split(":").slice(1).join(":") || args.field, label: args.field, kind: args.field.startsWith("header:") ? "header" : args.field.startsWith("oauth") ? "oauthClient" : "env" }] : [],
      expiresAt: now + EXPIRES_MS, createdAt: now, updatedAt: now, owner: copy(owner), fingerprint };
    this.saveRequest(request);
    return publicRequest(request);
  }
  listRequests(owner) {
    this.assertOpen();
    const items = [...this.requests.values()].filter(r => r.owner.profileId === owner.profileId && r.owner.sessionKey === owner.sessionKey).map(r => {
      if (r.status === "pending" && r.expiresAt <= this.now()) { r.status = "expired"; r.updatedAt = this.now(); this.persistRequests(); }
      return publicRequest(r);
    });
    return { items };
  }
  async complete(input) {
    const action = async () => {
      this.assertOpen(); const r = this.requests.get(input.requestId); if (!r) fail("MCP_REQUEST_NOT_FOUND");
      if (r.status === "completed") return publicRequest(r);
      if (r.expiresAt <= this.now() || r.status !== "pending") fail("MCP_REQUEST_EXPIRED");
      if (this.getOwner) { const current = await this.getOwner({ agentId: r.owner.agentId || r.owner.profileId, sessionKey: r.owner.sessionKey, backendId: r.owner.backendId || "shoggoth" });
        if (!current || current.profileId !== r.owner.profileId || current.transcriptSessionId !== r.owner.transcriptSessionId) fail("MCP_REQUEST_ACCESS_DENIED"); }
      if (r.serverId && input.serverId && input.serverId !== r.serverId) fail("MCP_REQUEST_TARGET_MISMATCH");
      if (r.kind === "setup") {
        if (input.fields) fail("MCP_REQUEST_TARGET_MISMATCH");
        return this.agentSetup.complete(r);
      }
      if (input.fields) {
        if (r.kind !== "secret") fail("MCP_REQUEST_TARGET_MISMATCH");
        const allowed = r.requiredFields[0]; const container = allowed.kind === "header" ? "headers" : allowed.kind === "oauthClient" ? "oauthClient" : "env";
        const name = allowed.kind === "oauthClient" ? canonicalMcpCredentialField(allowed.name.startsWith("oauthClient") ? allowed.name : `oauthClient:${allowed.name}`)?.split(":")[1] : allowed.name;
        if (!name || Object.keys(input.fields).length !== 1 || !input.fields[container] || Object.keys(input.fields[container]).length !== 1
          || !Object.hasOwn(input.fields[container], name)) fail("MCP_REQUEST_TARGET_MISMATCH");
      }
      const id = r.serverId || input.serverId; const server = id && this.store.get(id); if (!server) fail("MCP_SERVER_NOT_FOUND");
      if (r.registryName && (server.source.kind !== "registry" || server.source.registryName !== r.registryName)) fail("MCP_REQUEST_TARGET_MISMATCH");
      if (r.url && (server.transport.kind !== "remote" || publicUrl(server.transport.url) !== r.url)) fail("MCP_REQUEST_TARGET_MISMATCH");
      if (input.fields) await this.completeCredentials(id, input.fields, input.expectedRevision ?? this.store.revision);
      const checked = await this.verify(id); if (checked.server?.status !== "ready") fail("MCP_SERVER_PROBE_FAILED");
      const generation = this.generations.get(id) || 0;
      await this.mutate(() => {
        const current = this.store.get(id);
        if (!current || current.status !== "ready" || (this.generations.get(id) || 0) !== generation) fail("MCP_SERVER_PROBE_FAILED");
        if (current.disabledProfileIds.includes(r.owner.profileId)) this.store.update({ id, patch: { disabledProfileIds: current.disabledProfileIds.filter(v => v !== r.owner.profileId) }, expectedRevision: this.store.revision });
      });
      await this.onComplete?.({ request: publicRequest(r), owner: r.owner, server: this.store.get(id), idempotencyKey: r.requestId });
      r.status = "completed"; r.serverId = id; r.updatedAt = this.now(); this.persistRequests(); if (!r.owner.backendId || r.owner.backendId === "shoggoth") this.chatUiStore?.upsertConnectionRequest(r.owner, publicRequest(r)); return publicRequest(r);
    };
    const pending = this.requestQueue.catch(() => {}).then(action); this.requestQueue = pending; return pending;
  }
  async handle(method, params = {}) {
    this.assertOpen(); validateConnectorParams(method, params);
    switch (method) {
      case "connector.mcp.registry.list": return this.registry.list(params);
      case "connector.mcp.list": return this.store.list();
      case "connector.mcp.tools.list": return this.tools(params.id);
      case "connector.mcp.oauth.info": return { redirectUri: this.oauth.redirectUri };
      case "connector.mcp.agents.list": return this.getSubjects();
      case "connector.mcp.approvals.list": return this.getApprovals?.()?.list() || { items: [], generation: 1 };
      case "connector.mcp.approvals.resolve": { const broker = this.getApprovals?.(); if (!broker) fail("MCP_EXTERNAL_APPROVAL_INVALID"); return broker.resolve(params); }
      case "connector.mcp.add": return this.add(params);
      case "connector.mcp.import": return this.import(params);
      case "connector.mcp.rebind": {
        await this.mutate(async () => {
        this.expectRevision(params.expectedRevision);
        const old = this.store.getPrivate(params.id); if (!old) fail("MCP_SERVER_NOT_FOUND");
        let transport = copy(params.option);
        if (transport.kind === "stdio-package" && old.transport.kind === "stdio-package"
          && transport.identifier === old.transport.identifier && transport.version === old.transport.version && transport.registryType === old.transport.registryType) transport = old.transport;
        if (transport.kind === "stdio-command" && transport.commandLine) {
          const [command, ...args] = tokenizeCommand(transport.commandLine);
          transport = normalizeFlightawareTransport(normalizeTicketmasterTransport({ kind: "stdio-command", command, args, cwd: transport.cwd || this.paths.defaultWorkspaceDir }));
          if (!path.isAbsolute(transport.command)) transport.command = resolveOnPath(transport.command);
        }
        if (transport.kind === "stdio-command") { transport = normalizeFlightawareTransport(normalizeTicketmasterTransport(transport)); transport.cwd ||= this.paths.defaultWorkspaceDir; }
        const savedFields = old.secretRef ? credentialFields(await this.secrets.get(old.secretRef) || {}) : {};
        validateTicketmasterBridgeCredentials(transport, savedFields);
        validateFlightawareBridgeCredentials(transport, savedFields);
        noSecretsInTransport(transport, savedFields); this.assertSecretSafe(JSON.stringify(transport));
        this.expectRevision(params.expectedRevision);
        this.store.update({ id: params.id, patch: { transport, enabled: true, status: "checking", lastCheck: null }, expectedRevision: params.expectedRevision });
        const generation = this.invalidate(params.id);
        try { await this.oauth.cancelServer?.(params.id); } catch (error) { this.mutationFailed(params.id, generation, error); }
        });
        return this.verify(params.id);
      }
      case "connector.mcp.verify": return this.verify(params.id);
      case "connector.mcp.signin.start": return this.mutate(() => this.oauth.start(params.id));
      case "connector.mcp.signin.get": return this.oauth.get(params.signInId);
      case "connector.mcp.signin.cancel": await this.oauth.cancel(params.signInId); return this.oauth.get(params.signInId);
      case "connector.mcp.credentials.update": return this.credentials(params);
      case "connector.mcp.agents.set": return this.mutate(async () => {
        this.expectRevision(params.expectedRevision);
        const subjects = await this.getSubjects(); const known = new Set(subjects.items.map(s => s.profileId));
        const existing = this.store.get(params.id); if (!existing) fail("MCP_SERVER_NOT_FOUND");
        if (params.disabledProfileIds.some(id => !known.has(id) && !existing.disabledProfileIds.includes(id))) fail("MCP_CONNECTOR_ACCESS_DENIED");
        const result = this.store.update({ id: params.id, patch: { disabledProfileIds: params.disabledProfileIds }, expectedRevision: params.expectedRevision });
        this.revokeRuns(params.id, params.disabledProfileIds); return result;
      });
      case "connector.mcp.update": {
        const id = await this.mutate(async () => {
          this.expectRevision(params.expectedRevision);
          const old = this.store.getPrivate(params.id); if (!old || old.source.kind !== "registry") fail("MCP_SERVER_NOT_FOUND");
          const item = await this.registry.get(old.source.registryName, params.version);
          const option = item.options.find(o => o.transport.kind === old.transport.kind); if (!option) fail("MCP_REGISTRY_ENTRY_INVALID");
          return this.addPrepared({ source: { ...old.source, version: params.version }, option: { id: option.id }, auth: old.auth, expectedRevision: params.expectedRevision });
        });
        return this.verify(id);
      }
      case "connector.mcp.remove": return this.mutate(async () => {
        const removed = this.store.remove(params); this.invalidate(params.id); this.revokeRuns(params.id);
        await this.oauth.cancelServer?.(params.id); await this.manager.closeServer(params.id); await this.secrets.remove(params.id); return removed;
      });
      case "connector.mcp.requests.list": { const owner = await this.getOwner?.(params); if (!owner) fail("MCP_REQUEST_ACCESS_DENIED"); return this.listRequests(owner); }
      case "connector.mcp.request.complete": return this.complete(params);
      default: fail("OPEN_CONNECTOR_RETIRED");
    }
  }
}
module.exports = { McpConnectorController, publicMcpConnectionRequest: publicRequest, mcpConnectorSubjectId: subjectId, RETIRED_CONNECTOR_TOOLS: RETIRED_TOOLS };
