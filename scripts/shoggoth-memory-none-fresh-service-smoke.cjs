"use strict";

// Real Service/socket/Backend/REST and encrypted persistence. Every authority,
// key and payload belongs to a newly created isolated temporary fixture.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const http = require("node:http"), { once } = require("node:events"), { spawn } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..");
// Keep macOS Unix socket paths short; Linux does not have /private/tmp.
const fixtureTmpDir = process.platform === "darwin" ? "/private/tmp" : require("node:os").tmpdir();
const load = relative => require(path.join(ROOT, relative));
const { createAgentService, PROTOCOL_VERSION } = load("app/agent-service/server.js");
const { requestService, readClientToken } = load("app/agent-service/client.js");
const { resolveServicePaths } = load("app/agent-service/paths.js");
const { DEFAULT_AGENT_PROFILE_ID: alpha, AGENT_PROFILE_FIELDS } = load("app/agent-service/product-store.js");
const { EncryptedSecretStore } = load("app/agent-service/encrypted-secret-store.js");
const { ShoggothBackend } = load("app/core/shoggoth-backend.js");
const { BackendRegistry } = load("app/core/backend-registry.js");
const { startStaticServer } = load("app/static-server.js");
const P = load("app/agent-service/memory-provider-owner-protocol.cjs");
const beta = "catalog-beta-profile", KEY = "invented-catalog-service-key-924715";
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const failCode = (action, code) => assert.rejects(action, error => error.code === code);
function broker(key) { return {
  async open() {}, async close() {},
  async encrypt(value) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]); },
  async decrypt(value) { const cipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(-16));
    return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]); },
}; }
function pathsFor(root) { return resolveServicePaths({ trustedRoot: root, homeDir: root, userDataRoot: root,
  stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profiles"), cacheRoot: path.join(root, "cache") }); }
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(fixtureTmpDir, "sg-owner-service-")); fs.chmodSync(root, 0o700);
  const paths = pathsFor(root), aes = crypto.randomBytes(32), cryptoBroker = broker(aes);
  const allowed = new Set(), requests = [], originalFetch = globalThis.fetch;
  let gate = null;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    assert.equal(url.hostname, "127.0.0.1", "fixture must never send to a real destination");
    assert.ok(allowed.has(url.origin), `unowned HTTP resource: ${url.origin}`);
    requests.push({ url: url.href, init });
    const response = await originalFetch(input, init);
    if (gate && url.pathname === "/v1/embeddings" && String(init?.body).includes(gate.text)) {
      const captured = gate; gate = null; captured.entered.resolve(); await captured.release.promise;
    }
    return response;
  };
  // The pinned guarded-fetch explicitly selects an injected mock transport
  // when this metadata exists. This wrapper still performs real owned HTTP;
  // it adds authority inspection and a physical-response gate only.
  globalThis.fetch.mock = {};
  let service = null, store = null, backend = null, server = null;
  const config = { memory: { search: { provider: "none", rememberAcrossConversations: false } } };
  const runtimeManager = { async acquire() { assert.fail("catalog management must not acquire a Runtime/model"); }, async stop() {}, async stopAll() {} };
  const f = { root, paths, config, allowed, requests, cryptoBroker, syntheticAesKeyHex: aes.toString("hex"),
    get service() { return service; }, get store() { return store; }, get backend() { return backend; },
    get server() { return server; }, holdNext(text) { assert.equal(typeof text, "string"); gate = { text, entered: deferred(), release: deferred() }; return gate; },
    ipc(method, params, patch = {}) { return requestService(paths, { id: crypto.randomUUID(), token: readClientToken(paths),
      version: PROTOCOL_VERSION, method, params, ...patch }, { timeoutMs: 30_000 }); },
    context(params = {}) { return this.ipc(P.METHODS[0], params); },
    apply(params) { return this.ipc(P.METHODS[1], params); },
    recover(params) { return this.ipc(P.METHODS[2], params); },
    async open() {
      store = new EncryptedSecretStore({ paths, cryptoBroker });
      service = createAgentService({ paths, secretStore: store, cryptoBroker, memoryCore: true, memoryCoreConfig: config,
        runtimeManager, prewarmMcpAuth: false, version: "synthetic-owner-service", ...options });
      try { await service.start(); } catch (error) {
        const describe = value => ({ code: value?.code, name: value?.name, message: value?.message,
          errors: value?.errors?.map(describe), cause: value?.cause ? describe(value.cause) : undefined });
        console.error("isolated Service startup diagnostic", JSON.stringify(describe(error))); throw error;
      } return service;
    },
    async close() { if (server) { await server.close(); server = null; } if (backend) { await backend.stop(); backend = null; }
      if (service) { await service.stop({ notify: false }); service = null; } },
    async stopExpectFailure() { const current = service; await assert.rejects(() => current.stop({ notify: false }), { code: "SERVICE_STOP_FAILED" }); service = null; },
    async restart() { await this.close(); return this.open(); },
    async web() { backend = new ShoggothBackend({ paths }); backend._state = "started";
      const registry = new BackendRegistry(); registry.register(backend);
      server = await startStaticServer(0, { registry, homeDir: root, userDataRoot: path.join(root, "ui") });
      allowed.add(server.url); return server; },
    async http(method, suffix = "", body, origin = server.url) {
      const response = await fetch(`${server.url}/__api/memory-provider-owners${suffix}`, { method,
        headers: { "Content-Type": "application/json", ...(origin === null ? {} : { Origin: origin }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const raw = await response.text(); return { status: response.status, data: raw.startsWith("{") ? JSON.parse(raw) : raw };
    },
    addBeta() {
      const source = service.productStore.getAgentProfile(alpha);
      const profile = Object.fromEntries(AGENT_PROFILE_FIELDS.map(field => [field, source[field]]));
      Object.assign(profile, { id: beta, agentId: "catalog-beta-agent", name: "Synthetic Beta", runtimeProfileId: "catalog-beta-runtime", isDefault: false });
      return service.productStore.putAgentProfile(profile);
    },
    async configure(next) { const current = service.nativeMemoryConfig.read(); return this.ipc("memory.config.apply", { revision: current.revision + 1, config: next }); },
  };
  t.after(async () => { try { await f.close(); assert.equal(gate, null); }
    finally { globalThis.fetch = originalFetch; aes.fill(0); }
    fs.rmSync(root, { recursive: true, force: true }); });
  await f.open(); return f;
}
function creation(extra = {}) { return { action: "create", operationId: `create-${crypto.randomUUID()}`, expectedCatalogRevision: 0,
  scope: { kind: "global" }, providerId: "openai", label: "Synthetic Owner", baseUrl: "http://127.0.0.1:1/v1",
  secretAction: "set", secret: KEY, ...extra }; }
function update(row, extra = {}) { return { action: "update", operationId: `update-${crypto.randomUUID()}`,
  expectedCatalogRevision: row.catalogRevision, ownerRef: row.ownerRef, expectedOwnerRevision: row.ownerRevision,
  label: "Synthetic Updated", baseUrl: "http://127.0.0.1:1/v1", secretAction: "preserve", ...extra }; }
function revoke(row, extra = {}) { return { action: "revoke", operationId: `revoke-${crypto.randomUUID()}`,
  expectedCatalogRevision: row.catalogRevision, ownerRef: row.ownerRef, expectedOwnerRevision: row.ownerRevision, ...extra }; }
function assertPublic(value) { const text = JSON.stringify(value); for (const secret of [KEY, "credentialRef", "fingerprint", "idempotencyKey", "requestDigest"]) assert.equal(text.includes(secret), false, secret); }
function authority(f) { return ["memory-provider-owners.json", "encrypted-secrets.json", "native-memory-config.json"]
  .map(name => { const file = path.join(f.paths.stateDir, name); return [name, fs.existsSync(file) ? sha(fs.readFileSync(file)) : null]; }); }

const { core } = load("app/agent-service/shoggoth-memory/host.cjs");
test("fresh official Service none persists a semantic fact, syncs lexical rows and reconciles without model IO", async t => {
  const f = await fixture(t);
  await f.configure({ memory: { search: { provider: "none", rememberAcrossConversations: true, sources: ["memory"], query: { minScore: 0 } } } });
  const engine = f.service.memoryEngine;
  await engine.propose({ profileId: alpha, id: "fresh-provider-none-fact", content: "Fresh cobalt telescope calibration memory.",
    scope: "agent", sourceRefs: ["user-edit:fresh-provider-none"], type: "semantic", classification: "explicit" });
  const index = engine.host(alpha).searchIndex;
  await index.sync({force:true});
  const rows = index.db.prepare("SELECT text,model,typeof(embedding) AS type,length(embedding) AS size FROM memory_index_chunks").all();
  assert.ok(rows.some(row=>row.text.includes("Fresh cobalt telescope")));
  assert.ok(rows.every(row=>row.type==='blob' && row.size===0 && row.model==='fts-only'));
  await f.configure({ memory: { search: { provider: "none", rememberAcrossConversations: true, sources: ["memory"], query: { minScore: 0, maxResults: 17 } } } });
  const results=await engine.searchMemory({profileId:alpha,workspace:engine.host(alpha).workspaceDir,query:"Fresh cobalt telescope",minScore:0,record:false,maxSensitivity:"private"});
  assert.ok(results.items.some(row=>row.id === "fresh-provider-none-fact"));
  assert.ok(results.results.some(row=>row.snippet.includes("Fresh cobalt telescope")));
  assert.equal(index.searchOwner.provider,null);assert.equal(f.requests.length,0);
});
