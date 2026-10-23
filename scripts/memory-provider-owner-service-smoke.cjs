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

test("authenticated real Service CRUD persists private encrypted keys and metadata only without provider IO", async t => {
  const f = await fixture(t); assert.deepEqual(await f.context(), { catalogRevision: 0, owners: [], pendingOperations: [] });
  const request = creation(), created = await f.apply(request); assertPublic(created);
  assert.deepEqual(await f.apply(request), created); assert.equal(f.store.listMetadata().length, 1);
  const context = await f.context(); assertPublic(context); assert.equal(context.owners[0].hasCredential, true);
  const ref = f.store.listMetadata()[0].credentialRef;
  assert.equal(fs.readFileSync(f.paths.encryptedSecretsPath, "utf8").includes(KEY), false);
  const rotated = await f.apply(update(created, { secretAction: "set", secret: "invented-catalog-rotated-key-72184" }));
  assert.equal(f.store.getCredentialFingerprint(ref), null); assert.equal(f.store.listMetadata().length, 1);
  const revoked = await f.apply(revoke(rotated)); assert.equal(revoked.status, "revoked"); assert.equal(f.store.listMetadata().length, 0);
  assert.equal((await f.context()).owners[0].status, "revoked"); assert.equal(f.requests.length, 0);
  await f.restart(); assert.equal((await f.context()).catalogRevision, 3);
  assert.equal((await f.apply(request)).current, false); assert.equal(f.requests.length, 0);
});

test("IPC wrong tokens, extra fields and forged credential refs fail before authority writes", async t => {
  const f = await fixture(t), before = authority(f);
  await failCode(() => f.ipc(P.METHODS[1], creation(), { token: "invented-invalid-service-token" }), "AUTH_FAILED");
  await failCode(() => f.ipc(P.METHODS[1], creation(), { version: PROTOCOL_VERSION + 1 }), "PROTOCOL_VERSION_MISMATCH");
  for (const patch of [{ credentialRef: "forged-credential" }, { apiKey: KEY }, { writer: "forged" }, { headers: { Host: "foreign.example" } }]) {
    await failCode(() => f.apply({ ...creation(), ...patch }), "MEMORY_OWNER_INVALID");
  }
  await failCode(() => f.context({ profileId: "unknown-profile" }), "MEMORY_OWNER_FORBIDDEN");
  await failCode(() => f.ipc(P.METHODS[0], {}, { secret: KEY }), "MEMORY_OWNER_RETIRED");
  assert.deepEqual(authority(f), before); assert.equal(f.requests.length, 0);
});

test("global per-key inheritance projects generic metadata into exact Profiles without plaintext or cross-profile borrowing", async t => {
  const f = await fixture(t); f.addBeta();
  const global = await f.apply(creation({ providerId: "catalog-compatible", api: "openai-responses" }));
  const local = await f.apply(creation({ operationId: "beta-local", expectedCatalogRevision: 1, scope: { kind: "profile", profileId: beta },
    providerId: "catalog-compatible", api: "openai-completions", secret: "invented-beta-profile-key-4568" }));
  const cfg = { memory: { search: { provider: "none", providerRefs: { "catalog-compatible": global.ownerRef } } },
    agents: { entries: { [beta]: { memory: { search: { providerRefs: { "catalog-compatible": local.ownerRef } } } } } } };
  await f.configure(cfg);
  const engine = f.service.memoryEngine, a = engine.config(alpha), b = engine.config(beta);
  assert.deepEqual(a.models.providers["catalog-compatible"], { api: "openai-responses", baseUrl: "http://127.0.0.1:1/v1" });
  assert.deepEqual(b.models.providers["catalog-compatible"], { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1" });
  assertPublic(a); assertPublic(b); assert.equal(f.service.nativeMemoryConfig.read().config.models, undefined);
  const ac = await f.context({ profileId: alpha }), bc = await f.context({ profileId: beta });
  assert.equal(ac.owners.some(row => row.ownerRef === local.ownerRef), false); assert.equal(bc.owners.length, 2);
  await f.configure({ ...cfg, agents: { entries: { [alpha]: { memory: { search: { providerRefs: { "catalog-compatible": local.ownerRef } } } } } } });
  assert.throws(() => engine.config(alpha), { code: "MEMORY_OWNER_FORBIDDEN" }); assert.equal(f.requests.length, 0);
});

test("owned candidate interrupted after real encrypted put resumes only with same transient key through authenticated RPC", async t => {
  const f = await fixture(t), originalPut = f.store.putIfRevision.bind(f.store); let fail = true;
  f.store.putIfRevision = async (...args) => { const result = await originalPut(...args); if (fail) { fail = false; throw new Error("synthetic interruption"); } return result; };
  const request = creation(); await failCode(() => f.apply(request), "MEMORY_OWNER_RECOVERY_REQUIRED");
  assert.equal((await f.context()).pendingOperations[0].phase, "reserved");
  await failCode(() => f.recover({ operationId: request.operationId, mode: "resume" }), "MEMORY_OWNER_RECOVERY_REQUIRED");
  await f.restart(); const recovered = await f.recover({ operationId: request.operationId, mode: "resume", secret: KEY });
  assert.equal(recovered.phase, "completed"); assert.equal(recovered.catalogRevision, 1);
  assert.deepEqual(await f.apply(request), recovered); assert.equal(f.store.listMetadata().length, 1); assert.equal(f.requests.length, 0);
});

test("Backend real socket catalog calls enforce strict frozen DTOs", async t => {
  const f = await fixture(t); await f.web(); const request = creation();
  const created = await f.backend.applyMemoryProviderOwner(request), context = await f.backend.getMemoryProviderOwners();
  assert.ok(Object.isFrozen(created)); assert.ok(Object.isFrozen(context)); assert.ok(Object.isFrozen(context.owners[0])); assertPublic(context);
  assert.deepEqual(await f.backend.recoverMemoryProviderOwner({ operationId: request.operationId, mode: "resume" }), created);
  const invalid = new ShoggothBackend({ paths: f.paths, readToken: () => "synthetic-token", requestService: async () => ({ ...context, credentialRef: "leak" }) });
  await assert.rejects(() => invalid.getMemoryProviderOwners());
  const wrong = new ShoggothBackend({ paths: f.paths, readToken: () => "synthetic-token", requestService: async () => ({ ...created, secret: KEY }) });
  await assert.rejects(() => wrong.applyMemoryProviderOwner(creation()));
  assert.equal(f.requests.length, 0);
});

test("real REST/Backend/authenticated IPC catalog CRUD validates Origin, query, body and response", async t => {
  const f = await fixture(t); await f.web();
  const get = await f.http("GET"); assert.equal(get.status, 200); assert.equal(get.data.catalogRevision, 0);
  const before = authority(f), request = creation();
  assert.equal((await f.http("POST", "", request, null)).status, 403);
  assert.equal((await f.http("POST", "", request, "https://unowned.invalid")).status, 403);
  const crossSite = await fetch(`${f.server.url}/__api/memory-provider-owners`, { method: "POST",
    headers: { "Content-Type": "application/json", Origin: f.server.url, "Sec-Fetch-Site": "cross-site" }, body: JSON.stringify(request) });
  assert.equal(crossSite.status, 403); await crossSite.text();
  assert.equal((await f.http("POST", "", { ...request, credentialRef: "forged" })).status, 400);
  assert.equal((await f.http("GET", "?profileId=a&profileId=b")).status, 400);
  assert.equal((await f.http("GET", "?apiKey=forged")).status, 400);
  assert.deepEqual(authority(f), before);
  const created = await f.http("POST", "", request); assert.equal(created.status, 200); assertPublic(created.data);
  const repeated = await f.http("POST", "/recover", { operationId: request.operationId, mode: "resume" });
  assert.equal(repeated.status, 200); assert.deepEqual(repeated.data, created.data);
  const changed = await f.http("POST", "", update(created.data)); assert.equal(changed.status, 200);
  const deleted = await f.http("POST", "", revoke(changed.data)); assert.equal(deleted.status, 200); assert.equal(deleted.data.status, "revoked");
  assert.equal(f.requests.filter(row => !row.url.includes("/__api/")).length, 0);
});

async function embeddingServer(t, f) {
  const requests = [], errors = [], server = http.createServer(async (req, res) => {
    try { const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ url: req.url, authorization: req.headers.authorization, body });
      assert.equal(req.url, "/v1/embeddings"); assert.ok(Array.isArray(body.input));
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1, 0.5] })) }));
    } catch (error) { errors.push(error); res.destroy(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`; f.allowed.add(origin);
  t.after(async () => { const ended = once(server, "close"); server.close(); server.closeAllConnections(); await ended; assert.deepEqual(errors, []); });
  return { requests, baseUrl: `${origin}/v1` };
}
async function nativeFixture(t) {
  const f = await fixture(t), remote = await embeddingServer(t, f);
  const row = await f.apply(creation({ providerId: "catalog-compatible", api: "openai-completions", baseUrl: remote.baseUrl }));
  await f.configure({ memory: { search: { provider: "catalog-compatible", fallback: "none", model: "synthetic-catalog-embedding", outputDimensionality: 2,
    providerRefs: { "catalog-compatible": row.ownerRef }, rememberAcrossConversations: false, cache: { enabled: false } } } });
  const engine = f.service.memoryEngine, index = engine.host(alpha).searchIndex;
  await index.sync({ force: true });
  assert.equal(index.searchOwner.provider.id, "openai-compatible");
  const chunks = index.db.prepare("SELECT model,embedding FROM memory_index_chunks WHERE embedding IS NOT NULL").all();
  assert.ok(chunks.length > 0); assert.ok(chunks.every(chunk => chunk.model === "synthetic-catalog-embedding"));
  assert.ok(remote.requests.length > 0); assert.ok(remote.requests.every(request => request.authorization === `Bearer ${KEY}`));
  return { f, remote, row, engine, index, provider: index.searchOwner.provider };
}
async function observePublication(f, operationId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const ledger = JSON.parse(fs.readFileSync(path.join(f.paths.stateDir, "memory-provider-owners.json")));
    if (["published", "retired", "completed"].includes(ledger.operations[operationId]?.phase)) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  } assert.fail("owned catalog publication did not arrive");
}
test("formal catalog native query and document owner rotate only after physically held real loopback embedding joins", async t => {
  const { f, remote, row, engine, index, provider } = await nativeFixture(t), oldRef = f.store.listMetadata()[0].credentialRef;
  const hold = f.holdNext("Invented amber telescope query."), embedding = provider.embed("Invented amber telescope query.", { inputType: "query" });
  const rejected = assert.rejects(embedding); await hold.entered.promise;
  const request = update(row, { baseUrl: remote.baseUrl, secretAction: "set", secret: "invented-new-native-owner-key-2841" });
  let completed = false; const rotated = f.apply(request).then(value => { completed = true; return value; });
  try { await observePublication(f, request.operationId); await tick(); assert.equal(completed, false);
    assert.ok(f.store.getCredentialFingerprint(oldRef), "key is retained while native physical work remains held");
  } finally { hold.release.resolve(); }
  const next = await rotated; await rejected; assert.equal(next.ownerRevision, 2); assert.equal(f.store.getCredentialFingerprint(oldRef), null);
  assert.equal(index.searchOwner, null); assert.equal(engine.hosts.size, 1, "retirement does not create a replacement host");
  await index.sync({ force: true }); assert.deepEqual(await index.searchOwner.provider.embed("Invented new owner query.", { inputType: "query" }), [1, 0.5]);
  assert.equal(remote.requests.at(-1).authorization, "Bearer invented-new-native-owner-key-2841");
});

test("catalog revoke joins an existing stopping Profile host before deleting its credential", async t => {
  const { f, remote, row, engine, provider } = await nativeFixture(t), oldRef = f.store.listMetadata()[0].credentialRef;
  const hold = f.holdNext("Invented stopping Profile query."), embedding = provider.embed("Invented stopping Profile query.", { inputType: "query" });
  const rejected = assert.rejects(embedding); await hold.entered.promise;
  const stopGate = deferred(), entered = deferred(), originalStop = engine.activeMemory.stopProfile.bind(engine.activeMemory);
  engine.activeMemory.stopProfile = async id => { entered.resolve(); await stopGate.promise; return originalStop(id); };
  const stopping = engine.stopProfile(alpha); await entered.promise;
  assert.equal(engine.profileSignal(alpha).aborted, true); assert.ok(engine.hosts.has(alpha));
  let done = false; const request = revoke(row), revoked = f.apply(request).then(value => { done = true; return value; });
  try { await observePublication(f, request.operationId); await tick(); assert.equal(done, false);
    assert.ok(f.store.getCredentialFingerprint(oldRef));
  } finally { hold.release.resolve(); }
  assert.equal((await revoked).status, "revoked"); await rejected; assert.equal(f.store.getCredentialFingerprint(oldRef), null);
  stopGate.resolve(); await stopping; assert.equal(engine.hosts.has(alpha), false);
  assert.ok(remote.requests.every(request => request.authorization === `Bearer ${KEY}`));
});

test("uncertain real SecretStore backup cleanup poisons admission and joins native work even with aborted management signal", async t => {
  const { f, remote, row, engine, provider } = await nativeFixture(t), oldRef = f.store.listMetadata()[0].credentialRef;
  const hold = f.holdNext("Invented uncertain owner query."), embedding = provider.embed("Invented uncertain owner query.", { inputType: "query" });
  const rejected = assert.rejects(embedding); await hold.entered.promise;
  const actualFs = f.store.fs; let faults = 0;
  f.store.fs = new Proxy(actualFs, { get(object, name) {
    if (name === "unlinkSync") return file => {
      if (String(file).startsWith(`${f.paths.encryptedSecretsPath}.backup-`)) { faults++; throw Object.assign(new Error("synthetic owned backup cleanup fault"), { code: "EIO" }); }
      return object.unlinkSync(file);
    }; return Reflect.get(object, name);
  } });
  let responded = false; const operation = f.apply(update(row, { baseUrl: remote.baseUrl, secretAction: "set", secret: "invented-uncertain-native-key-79213" }));
  const checked = failCode(() => operation, "MEMORY_OWNER_UNCERTAIN").then(() => { responded = true; });
  try {
    for (let attempt = 0; !faults && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(faults); await tick(); assert.equal(responded, false);
    const stored = JSON.parse(fs.readFileSync(f.paths.encryptedSecretsPath)); assert.ok(stored.credentials[oldRef]);
    assert.equal(engine.remoteEmbeddingResources.closed, false, "catalog poison retires existing indexes without globally stopping Service resources");
  } finally { hold.release.resolve(); f.store.fs = actualFs; }
  await checked; await rejected; assert.equal(engine.host(alpha).searchIndex.searchOwner, null);
  await failCode(() => f.context(), "MEMORY_OWNER_RETIRED");
});

test("Service shutdown joins held native work despite a different memory cleanup failure", async t => {
  const { f, engine, index, provider } = await nativeFixture(t);
  const hold = f.holdNext("Invented shutdown query."), embedding = provider.embed("Invented shutdown query.", { inputType: "query" });
  const rejected = assert.rejects(embedding); await hold.entered.promise;
  const maintenanceClose = engine.maintenance.close.bind(engine.maintenance);
  engine.maintenance.close = async () => { await maintenanceClose(); throw new Error("synthetic isolated maintenance close failure"); };
  let done = false; const closing = f.stopExpectFailure().then(() => { done = true; });
  try { await tick(); await tick(); assert.equal(done, false); }
  finally { hold.release.resolve(); }
  await closing; await rejected;
  assert.equal(engine.remoteEmbeddingResources.closed, true); assert.equal(engine.localEmbeddingHost.closed, true);
  assert.equal(index.db, null); assert.equal(fs.existsSync(f.paths.socketPath), false);
});

async function stoppedArtifact(f, mode) {
  await f.close();
  const code = `"use strict"; const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
    const ROOT=${JSON.stringify(ROOT)},load=relative=>require(path.join(ROOT,relative));
    const {createAgentService,PROTOCOL_VERSION}=load('app/agent-service/server.js');
    const {requestService,readClientToken}=load('app/agent-service/client.js');
    const {resolveServicePaths}=load('app/agent-service/paths.js');
    const {EncryptedSecretStore}=load('app/agent-service/encrypted-secret-store.js');
    const broker=${broker.toString()},pathsFor=${pathsFor.toString()};
    globalThis.fetch=()=>{throw new Error('unexpected HTTP in stopped startup fixture');};
    const root=${JSON.stringify(f.root)},paths=pathsFor(root),mode=${JSON.stringify(mode)},key=Buffer.from(${JSON.stringify(f.syntheticAesKeyHex)},'hex'),cryptoBroker=broker(key);
    const store=new EncryptedSecretStore({paths,cryptoBroker}),service=createAgentService({paths,secretStore:store,cryptoBroker,memoryCore:true,
      memoryCoreConfig:{memory:{search:{provider:'none'}}},prewarmMcpAuth:false,version:'owned-catalog-stop-proof-child',
      runtimeManager:{async acquire(){throw new Error('unexpected Runtime');},async stop(){},async stopAll(){}}});
    (async()=>{await service.start(); const files=new Map(),open=fs.openSync,write=fs.writeSync,close=fs.closeSync;let failed=false;
      fs.openSync=(file,...args)=>{const fd=open(file,...args);files.set(fd,String(file));return fd;};
      fs.closeSync=fd=>{files.delete(fd);return close(fd);};
      fs.writeSync=(fd,...args)=>{const result=write(fd,...args);
        if(!failed&&files.get(fd)?.startsWith(path.join(paths.stateDir,'memory-provider-owners.json.owner-tmp-'))){failed=true;
          if(mode==='crash'){process.stdout.write('catalog-crash-ready\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
          else throw Object.assign(new Error('synthetic owned journal interruption'),{code:'EIO'});}
        return result;};
      const pending=requestService(paths,{id:crypto.randomUUID(),token:readClientToken(paths),version:PROTOCOL_VERSION,
        method:'memory.provider.owner.apply',params:${JSON.stringify(creation({ operationId: `startup-${mode}` }))}},{timeoutMs:30000});
      if(mode==='crash')await pending;else {await assert.rejects(pending);fs.writeSync=write;fs.openSync=open;fs.closeSync=close;await service.stop({notify:false});key.fill(0);process.stdout.write('catalog-closed-ready\\n');}
    })().catch(error=>{console.error('owned child failure',error.code||error.name);process.exitCode=1;});`;
  const child = spawn(process.execPath, ["-e", code], { env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: fixtureTmpDir,
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit"); let stdout = "", stderr = "";
  const arrived = deferred(); child.stdout.on("data", chunk => { stdout += chunk.toString();
    if (stdout.includes(mode === "crash" ? "catalog-crash-ready" : "catalog-closed-ready")) arrived.resolve(); });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  let timer;
  try {
    await Promise.race([arrived.promise, exited.then(() => assert.fail(`owned child exited before fixture gate: ${stderr}`)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("owned child gate timeout")), 15000); })]);
    if (mode === "crash") { child.kill("SIGKILL"); const [code, signal] = await exited; assert.equal(code, null); assert.equal(signal, "SIGKILL"); }
    else { const [code, signal] = await exited; assert.equal(code, 0, stderr); assert.equal(signal, null); }
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
}
for (const mode of ["crash", "closed-no-lock"]) {
  test(`real Service startup recovers exact stopped-writer owned files with ${mode === "crash" ? "catalog and Service stale locks" : "no catalog lock"}`, async t => {
    const f = await fixture(t); await stoppedArtifact(f, mode);
    const lock = path.join(f.paths.stateDir, "memory-provider-owners.json.lock");
    assert.equal(fs.existsSync(lock), mode === "crash");
    assert.ok(fs.readdirSync(f.paths.stateDir).some(name => /\.owner-write-.*\.json$/u.test(name)));
    await f.open(); assert.deepEqual(await f.context(), { catalogRevision: 0, owners: [], pendingOperations: [] });
    assert.equal(fs.readdirSync(f.paths.stateDir).some(name => /\.owner-write-.*\.json$/u.test(name)), false);
    assert.equal((await f.apply(creation())).phase, "completed"); assert.equal(f.requests.length, 0);
  });
}
test("real Service startup preserves foreign temporary evidence and rejects an unowned live catalog lock", async t => {
  const f = await fixture(t); await f.close();
  const file = path.join(f.paths.stateDir, "memory-provider-owners.json.tmp"); fs.writeFileSync(file, "synthetic foreign catalog evidence", { mode: 0o600 });
  const before = fs.readFileSync(file); await assert.rejects(() => f.open()); assert.deepEqual(fs.readFileSync(file), before);
  // The fixture's creator removes only its own known evidence, then creates
  // a live lock in its own root to prove startup cannot grant a dead-pid brand.
  fs.unlinkSync(file);
  const lock = path.join(f.paths.stateDir, "memory-provider-owners.json.lock"), value = `${JSON.stringify({ version: 1, pid: process.pid,
    startedAt: Date.now(), token: crypto.randomBytes(32).toString("hex") })}\n`;
  fs.writeFileSync(lock, value, { mode: 0o600 }); await assert.rejects(() => f.open()); assert.equal(fs.readFileSync(lock, "utf8"), value);
  fs.unlinkSync(lock); await f.open(); assert.equal((await f.context()).catalogRevision, 0); assert.equal(f.requests.length, 0);
});
test("real IPC accepts synthetic key true when public metadata contains only booleans rather than that string", async t => {
  const f = await fixture(t), created = await f.apply(creation({ secret: "true" }));
  assert.equal(created.cleanupComplete, true); assert.equal(created.current, true);
  const context = await f.context(); assert.equal(context.owners[0].hasCredential, true); assert.equal(context.owners[0].label, "Synthetic Owner");
  assert.equal((await f.recover({ operationId: created.operationId, mode: "resume" })).phase, "completed");
  assert.equal(f.requests.length, 0);
});
