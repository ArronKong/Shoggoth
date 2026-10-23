"use strict";

// Invented catalog/key/text and owned 127.0.0.1 servers only. The actual Product
// Service and fixed native adapters execute; no production Vault/config is read.
const test = require("node:test"), assert = require("node:assert/strict");
const http = require("node:http"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { once } = require("node:events");
const core = require("../app/agent-service/shoggoth-memory/core.cjs");
const { MemoryRemoteProviderResources } = require("../app/agent-service/shoggoth-memory/remote-provider-resources.cjs");
const { withMemoryHost } = require("../app/agent-service/shoggoth-memory/host-bridge.cjs");
// Keep macOS Unix socket paths short; Linux does not have /private/tmp.
const fixtureTmpDir = process.platform === "darwin" ? "/private/tmp" : os.tmpdir();
const tick = () => new Promise(done => setImmediate(done));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const key = "invented-remote-memory-fixture-key", text = "Fictional amber telescope catalogue.";
const bounded = (promise, label) => Promise.race([promise, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error(label)), 5000); timer.unref();
})]);
const options = extra => ({ config: {}, provider: "openai", agentId: "one", agentDir: "/private/tmp/unused-private-remote-fixture",
  model: "fixture-embedding", fallback: "none", remote: { apiKey: undefined }, ...extra });
function fixture(t, initial = {}) {
  const config = { _shoggothConfigRevision: 0, memory: { search: { provider: "openai", providerRefs: { openai: "owner-one" } } }, ...initial };
  const owner = { ownerRef: "owner-one", profileId: "one", providerId: "openai", baseUrl: "http://127.0.0.1:1/v1",
    credentialRef: "credential-one", credentialKind: "external-provider-api-key", revision: 1 };
  const owners = new Map([["owner-one", owner]]), secrets = new Map([["credential-one", key]]);
  const revisions = new Map([["credential-one", 1]]), reads = [], lookups = [];
  let stopped = false;
  const resource = new MemoryRemoteProviderResources({ getConfig: id => { assert.equal(id, "one"); return config; },
    assertCurrent: id => { assert.equal(id, "one"); if (stopped) throw Object.assign(new Error("fixture stopped"), { code: "MEMORY_SCOPE_REVOKED" }); },
    resolveOwner: packet => { lookups.push(packet); return owners.get(packet.ownerRef); },
    secretStore: { listMetadata: () => [...secrets].map(([credentialRef]) => ({ credentialRef, kind: "external-provider-api-key" })),
      getCredentialRevision: ref => revisions.get(ref) ?? null, get: async ref => { reads.push(ref); return secrets.get(ref); } } });
  t.after(() => resource.close());
  return { config, owner, owners, secrets, revisions, reads, lookups, resource,
    stop: () => { stopped = true; }, adapter: native => resource.resolveAdapter({ agentId: "one", providerId: native.id || "openai", adapter: native }) };
}
function fakeAdapter(extra = {}) {
  return { id: "openai", transport: "remote", defaultModel: "fixture-model",
    resolveIndexIdentity: request => ({ provider: "openai", model: request.model, baseUrl: request.remote.baseUrl,
      headers: request.remote.headers, dimensions: request.dimensions }),
    create: async request => ({ provider: { id: "openai", model: request.model, embed: async () => [1, 0],
      embedBatch: async values => values.map(() => [1, 0]), close: async () => {} },
      runtime: { cacheKeyData: { baseUrl: request.remote.baseUrl } } }), ...extra };
}
async function localServer(t, action) {
  const requests = [], errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8"), request = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(request); res.setHeader("content-type", "application/json"); await action(request, res);
    } catch (error) { errors.push(error); res.destroy(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { const ended = once(server, "close"); server.close(); server.closeAllConnections(); await ended; assert.deepEqual(errors, []); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
}
const vectors = (request, res) => {
  const body = JSON.parse(request.body); res.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [index + 1, 0.5] })).reverse() }));
};

async function productFixture(t) {
  const { createAgentService } = require("../app/agent-service/server");
  const { resolveServicePaths } = require("../app/agent-service/paths");
  const { DEFAULT_AGENT_PROFILE_ID: id } = require("../app/agent-service/product-store");
  const root = fs.mkdtempSync(path.join(fixtureTmpDir, "shoggoth-rsrc-")); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const config = { memory: { search: { provider: "none", providerRefs: { openai: "owner-one" } } } };
  const lookups = [], privateResources = { resolveOwner: packet => { lookups.push(packet); return { ownerRef: "owner-one", profileId: id, providerId: "openai",
    baseUrl: "http://127.0.0.1:1/v1", credentialRef: "credential-one", credentialKind: "external-provider-api-key", revision: 1 }; },
    secretStore: { listMetadata: () => [{ credentialRef: "credential-one", kind: "external-provider-api-key" }], getCredentialRevision: () => 1, get: async () => key } };
  const service = createAgentService({ paths, memoryCore: true, memoryCoreConfig: config, memoryRemoteProviderResources: privateResources,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => Buffer.from(value).toString("utf8") },
    version: "synthetic-remote-resource-fixture", prewarmMcpAuth: false });
  t.after(async () => { await service.stop({ notify: false }); fs.rmSync(root, { recursive: true, force: true }); });
  return { service, id, lookups };
}

test("opaque Profile references inherit by provider key and never borrow another alias or fallback owner", t => {
  const f = fixture(t), global = f.config.memory.search.providerRefs;
  global.gemini = "global-gemini";
  f.config.agents = { entries: { one: { memory: { search: { providerRefs: { openai: "profile-openai", voyage: "profile-voyage" } } } } } };
  assert.deepEqual(f.resource.refs("one"), { gemini: "global-gemini", openai: "profile-openai", voyage: "profile-voyage" });
  delete f.config.agents.entries.one.memory.search.providerRefs.openai;
  assert.equal(f.resource.refs("one").openai, "owner-one");
  assert.throws(() => f.resource.resolveAdapter({ agentId: "one", providerId: "google", adapter: fakeAdapter() }).create(options()),
    { code: "MEMORY_EMBEDDING_CREDENTIAL_REQUIRED" });
  assert.equal(f.reads.length, 0);
});

test("owner/provider/Profile/kind metadata mismatches refuse before reading key or creating provider", async t => {
  const f = fixture(t); let creates = 0;
  const native = fakeAdapter({ create: async () => { creates++; assert.fail("invalid owner cannot create"); } });
  for (const change of [{ profileId: "other" }, { providerId: "voyage" }, { ownerRef: "foreign" }, { revision: -1 },
    { credentialKind: null }, { credentialRef: "unknown" }, { credentialKind: "oauth" }]) {
    const baseline = { ...f.owner }; Object.assign(f.owner, change);
    assert.throws(() => f.adapter(native).create(options()), error => ["MEMORY_REMOTE_PROVIDER_OWNER_INVALID", "MEMORY_EMBEDDING_CREDENTIAL_REQUIRED"].includes(error.code));
    Object.assign(f.owner, baseline);
  }
  assert.equal(creates, 0); assert.deepEqual(f.reads, []);
});

test("catalog accessors and unknown secret/plaintext fields cannot enter capture or provider creation", t => {
  const f = fixture(t), baseline = { ...f.owner }; let getterReads = 0;
  for (const field of ["apiKey", "credential", "config", "model", "environment", "then"]) {
    f.owners.set("owner-one", { ...baseline, [field]: key });
    assert.throws(() => f.resource.capture("one"), { code: "MEMORY_REMOTE_PROVIDER_OWNER_INVALID" });
  }
  const accessor = { ...baseline }; Object.defineProperty(accessor, "baseUrl", { enumerable: true, get() { getterReads++; return key; } });
  f.owners.set("owner-one", accessor);
  assert.throws(() => f.resource.capture("one"), { code: "MEMORY_REMOTE_PROVIDER_OWNER_INVALID" });
  assert.equal(getterReads, 0); assert.deepEqual(f.reads, []);
});

test("OAuth, plugin, worker and MCP secrets cannot be used as embedding API keys even with matching metadata", t => {
  const f = fixture(t), native = fakeAdapter(); let reads = 0;
  f.resource.secretStore.get = async () => { reads++; return key; };
  for (const kind of ["mcp-oauth", "microsoft-graph-oauth", "plugin-secret", "runtime-worker-token", "mcp-bearer"]) {
    f.owner.credentialKind = kind;
    f.resource.secretStore.listMetadata = () => [{ credentialRef: "credential-one", kind }];
    assert.throws(() => f.adapter(native).create(options()), { code: "MEMORY_REMOTE_PROVIDER_OWNER_INVALID" });
  }
  assert.equal(reads, 0);
});

test("credential URL and secret headers are refused while public endpoint differences are fenced by original destination comparison", t => {
  const f = fixture(t), adapter = f.adapter(fakeAdapter()), baseline = f.owner.baseUrl;
  for (const baseUrl of ["http://user:pass@127.0.0.1:1/v1", baseline + "?api_key=" + key, baseline + "?access_token=x",
    baseline + "#token=x", "file:///private/tmp/key", baseline + "\n"]) {
    f.owner.baseUrl = baseUrl; assert.throws(() => adapter.create(options()), { code: "MEMORY_REMOTE_PROVIDER_OWNER_INVALID" });
  }
  f.owner.baseUrl = baseline;
  for (const baseUrl of ["http://127.0.0.1:2/v1", "https://127.0.0.1:1/v1", "http://127.0.0.1:1/v2", baseline + "?routing=other"]) {
    assert.throws(() => adapter.create(options({ remote: { baseUrl } })), { code: "MEMORY_REMOTE_PROVIDER_DESTINATION_MISMATCH" });
  }
  for (const headers of [{ Authorization: key }, { "x-api-key": key }, { "X-Token": key }, { "X-Foo": "x\r\ny" }]) {
    assert.throws(() => adapter.create(options({ remote: { headers } })), { code: "MEMORY_REMOTE_PROVIDER_OWNER_INVALID" });
  }
  for (const apiKey of [null, key, {}, 1]) assert.throws(() => adapter.create(options({ remote: { apiKey } })), { code: "MEMORY_REMOTE_PROVIDER_OWNER_INVALID" });
  assert.deepEqual(f.reads, []);
});

test("both catalog and public transport headers are refused before credential or native provider IO", t => {
  const f = fixture(t); let creates = 0;
  const native = fakeAdapter({ create: async () => { creates++; assert.fail("refused routing cannot create provider"); } });
  for (const name of ["Host", "hOsT", "Connection", "Proxy-Connection", "Keep-Alive", "Transfer-Encoding", "Content-Length", "TE", "Trailer", "Upgrade", ":authority"]) {
    const headers = { [name]: "fictional-other.invalid" };
    assert.throws(() => f.adapter(native).create(options({ remote: { headers } })), { code: "MEMORY_REMOTE_PROVIDER_OWNER_INVALID" });
    f.owner.headers = headers;
    assert.throws(() => f.adapter(native).create(options()), { code: "MEMORY_REMOTE_PROVIDER_OWNER_INVALID" });
    assert.throws(() => f.resource.capture("one"), { code: "MEMORY_REMOTE_PROVIDER_OWNER_INVALID" });
    delete f.owner.headers;
  }
  assert.equal(creates, 0); assert.deepEqual(f.reads, []);
});

test("an owner reference cannot directly name an arbitrary credential or call native auth discovery", async t => {
  const f = fixture(t); let creates = 0;
  f.config.memory.search.providerRefs.openai = "credential-one";
  const native = fakeAdapter({ create: async () => { creates++; assert.fail("no owner must not create"); } });
  assert.throws(() => f.adapter(native).create(options()), { code: "MEMORY_EMBEDDING_CREDENTIAL_REQUIRED" });
  f.config.memory.search.providerRefs.openai = null;
  assert.throws(() => f.resource.capture("one"), { code: "MEMORY_REMOTE_PROVIDER_OWNER_INVALID" });
  assert.equal(creates, 0); assert.deepEqual(f.reads, []);
});

test("original Ollama adapter can use an explicit no-auth owned destination without reading credentials", async t => {
  const server = await localServer(t, (_request, res) => res.end('{"embeddings":[[3,4]]}'));
  const f = fixture(t, { memory: { search: { provider: "ollama", providerRefs: { ollama: "owner-one" } } } });
  Object.assign(f.owner, { providerId: "ollama", baseUrl: server.baseUrl, credentialRef: null, credentialKind: null });
  const created = await f.adapter(core.ollamaMemoryEmbeddingProviderAdapter).create(options({ provider: "ollama", model: "fixture-ollama" }));
  assert.deepEqual(await created.provider.embed(text, { inputType: "query", signal: AbortSignal.timeout(3000) }), [0.6, 0.8]);
  assert.equal(server.requests.length, 1); assert.equal(server.requests[0].headers.authorization, undefined);
  assert.equal(JSON.parse(server.requests[0].body).model, "fixture-ollama"); assert.deepEqual(f.reads, []);
});

test("primary destination admission cannot be hidden by a valid fallback or unavailable primary credential", async t => {
  const first = await localServer(t, vectors), second = await localServer(t, vectors);
  for (const fallback of ["none", "voyage"]) {
    const f = fixture(t); f.owner.baseUrl = first.baseUrl;
    f.config.memory.search.remote = { baseUrl: second.baseUrl }; f.config.memory.search.fallback = fallback;
    f.config.memory.search.providerRefs.voyage = "fallback-owner";
    f.owners.set("fallback-owner", { ...f.owner, providerId: "voyage", ownerRef: "fallback-owner", baseUrl: second.baseUrl,
      credentialRef: "credential-fallback" });
    f.secrets.set("credential-fallback", "invented-fallback-key"); f.revisions.set("credential-fallback", 1);
    f.secrets.delete("credential-one"); let creates = 0;
    const native = fakeAdapter({ create: async () => { creates++; assert.fail("authority cannot fall through to factory"); } });
    assert.throws(() => f.resource.capture("one"), { code: "MEMORY_REMOTE_PROVIDER_DESTINATION_MISMATCH" });
    assert.throws(() => f.adapter(native).create(options()), { code: "MEMORY_REMOTE_PROVIDER_DESTINATION_MISMATCH" });
    assert.equal(creates, 0); assert.deepEqual(f.reads, []);
    f.config.agents = { entries: { one: { memory: { search: { remote: { baseUrl: first.baseUrl } } } } } };
    assert.equal(typeof f.resource.capture("one"), "string", "Profile endpoint override has field inheritance");
    f.config.agents.entries.one.memory.search.enabled = false;
    f.config.agents.entries.one.memory.search.remote.baseUrl = second.baseUrl;
    assert.equal(typeof f.resource.capture("one"), "string", "disabled capture creates no provider");
  }
  assert.equal(first.requests.length, 0); assert.equal(second.requests.length, 0);
});

test("native apiKey undefined is compatible and identity/capture/cache never contain private plaintext", async t => {
  const f = fixture(t); let received;
  f.owner.headers = { "X-Owned-Routing": "amber" };
  const adapter = f.adapter(fakeAdapter({ create: async request => { received = request; return fakeAdapter().create(request); } }));
  const input = options({ dimensions: 2, remote: { apiKey: undefined, baseUrl: f.owner.baseUrl + "/", headers: { "X-Public-Routing": "telescope" } } });
  const identity = adapter.resolveIndexIdentity(input), stamp = f.resource.capture("one");
  assert.equal(identity.baseUrl, f.owner.baseUrl); assert.equal(identity.dimensions, 2);
  assert.deepEqual(identity.headers, { "X-Owned-Routing": "amber", "X-Public-Routing": "telescope" });
  const created = await adapter.create(input);
  assert.equal(received.remote.apiKey, key); assert.equal(input.remote.apiKey, undefined);
  assert.equal(JSON.stringify({ identity, stamp, runtime: created.runtime }).includes(key), false);
  assert.equal(f.reads.length, 1);
});

test("all effective owner/credential/config revisions are fenced, including an unused fallback and delete/recreate ABA", t => {
  const f = fixture(t), initial = f.resource.capture("one");
  f.revisions.set("credential-one", 2); assert.throws(() => f.resource.assertCurrent("one", initial), { code: "MEMORY_REMOTE_PROVIDER_CHANGED" });
  const fresh = f.resource.capture("one"); f.config._shoggothConfigRevision++;
  assert.throws(() => f.resource.assertCurrent("one", fresh), { code: "MEMORY_REMOTE_PROVIDER_CHANGED" });
  f.config.memory.search.providerRefs.voyage = "second-owner";
  f.owners.set("second-owner", { ...f.owner, ownerRef: "second-owner", providerId: "voyage", revision: 2 });
  const fallback = f.resource.capture("one"); f.owners.get("second-owner").revision++;
  assert.throws(() => f.resource.assertCurrent("one", fallback), { code: "MEMORY_REMOTE_PROVIDER_CHANGED" });
  const beforeDelete = f.resource.capture("one"); f.secrets.delete("credential-one");
  assert.throws(() => f.resource.assertCurrent("one", beforeDelete), { code: "MEMORY_REMOTE_PROVIDER_CHANGED" });
  f.secrets.set("credential-one", key); f.revisions.set("credential-one", 3);
  assert.throws(() => f.resource.assertCurrent("one", beforeDelete), { code: "MEMORY_REMOTE_PROVIDER_CHANGED" });
});

test("credential revision changes during private asynchronous read cannot reach native factory", async t => {
  const f = fixture(t), entered = deferred(), gate = deferred(); let creates = 0;
  f.resource.secretStore.get = async () => { entered.resolve(); await gate.promise; return key; };
  const result = f.adapter(fakeAdapter({ create: async () => { creates++; assert.fail("stale credential cannot create"); } })).create(options());
  const checked = assert.rejects(result, { code: "MEMORY_REMOTE_PROVIDER_CHANGED" });
  await entered.promise; f.revisions.set("credential-one", 2); gate.resolve(); await checked; assert.equal(creates, 0);
});

test("native OpenAI adapter sends actual document/query input types with only the matching owner key", async t => {
  const server = await localServer(t, vectors), f = fixture(t); f.owner.baseUrl = server.baseUrl;
  const result = await f.adapter(core.openAiMemoryEmbeddingProviderAdapter).create(options({
    dimensions: 2, queryInputType: "search_query", documentInputType: "search_document",
  }));
  assert.deepEqual(await result.provider.embedBatch([text, "Invented second record."], { signal: AbortSignal.timeout(3000) }), [[1, 0.5], [2, 0.5]]);
  assert.deepEqual(await result.provider.embed(text, { inputType: "query", signal: AbortSignal.timeout(3000) }), [1, 0.5]);
  assert.deepEqual(server.requests.map(row => JSON.parse(row.body).input_type), ["search_document", "search_query"]);
  assert.ok(server.requests.every(row => row.headers.authorization === "Bearer " + key));
  assert.ok(server.requests.every(row => row.url === "/v1/embeddings"));
  assert.equal(JSON.stringify(result.runtime.cacheKeyData).includes(key), false);
  f.revisions.set("credential-one", 2);
  assert.throws(() => result.provider.embed(text), { code: "MEMORY_REMOTE_PROVIDER_CHANGED" });
  assert.equal(server.requests.length, 2);
});

test("original fallback resolves its independent owner, endpoint and model without inheriting primary route/header/key", async t => {
  const first = await localServer(t, vectors), second = await localServer(t, vectors), f = fixture(t);
  f.owner.baseUrl = first.baseUrl; f.owner.headers = { "X-Primary-Route": "primary" };
  f.config.memory.search.providerRefs.voyage = "voyage-owner";
  f.owners.set("voyage-owner", { ...f.owner, ownerRef: "voyage-owner", providerId: "voyage", baseUrl: second.baseUrl,
    credentialRef: "credential-voyage", headers: { "X-Fallback-Route": "fallback" } });
  f.secrets.set("credential-voyage", "invented-fallback-key"); f.revisions.set("credential-voyage", 1);
  const primary = f.adapter(fakeAdapter({ create: async () => { throw new Error("invented primary unavailable"); } }));
  const fallback = f.resource.resolveAdapter({ agentId: "one", providerId: "voyage", adapter: core.voyageMemoryEmbeddingProviderAdapter });
  const host = { assertCurrent() {}, getMemoryEmbeddingProvider: id => id === "openai" ? primary : id === "voyage" ? fallback : undefined };
  const result = await withMemoryHost(host, () => core.createEmbeddingProvider(options({
    fallback: "voyage", remote: { apiKey: undefined, baseUrl: first.baseUrl, headers: { "X-Public-Primary": "primary" } },
  })));
  assert.equal(result.fallbackFrom, "openai"); assert.equal(result.provider.id, "voyage");
  assert.deepEqual(await result.provider.embed(text, { inputType: "query", signal: AbortSignal.timeout(3000) }), [1, 0.5]);
  assert.equal(first.requests.length, 0); assert.equal(second.requests.length, 1);
  assert.equal(second.requests[0].headers.authorization, "Bearer invented-fallback-key");
  assert.equal(second.requests[0].headers["x-primary-route"], undefined); assert.equal(second.requests[0].headers["x-public-primary"], undefined);
  assert.equal(second.requests[0].headers["x-fallback-route"], "fallback");
  assert.equal(JSON.parse(second.requests[0].body).model, core.voyageMemoryEmbeddingProviderAdapter.defaultModel);
});

test("native OpenAI batch uploads synthetic JSONL and reads real status/output through the original runner", async t => {
  const server = await localServer(t, (request, res) => {
    if (request.url === "/v1/files") res.end('{"id":"input-fixture"}');
    else if (request.url === "/v1/batches") res.end('{"id":"batch-fixture","status":"in_progress"}');
    else if (request.url === "/v1/batches/batch-fixture") res.end('{"id":"batch-fixture","status":"completed","output_file_id":"output-fixture"}');
    else if (request.url === "/v1/files/output-fixture/content") res.end(JSON.stringify({ custom_id: "0", response: { status_code: 200,
      body: { data: [{ embedding: [1, 0.5] }] } } }) + "\n");
    else assert.fail("Unexpected owned batch path: " + request.url);
  });
  const f = fixture(t); f.owner.baseUrl = server.baseUrl;
  const created = await f.adapter(core.openAiMemoryEmbeddingProviderAdapter).create(options());
  const actual = await created.runtime.batchEmbed({ agentId: "one", chunks: [{ text }], wait: true, concurrency: 1, pollIntervalMs: 1, timeoutMs: 3000 });
  assert.deepEqual(actual, [[1, 0.5]]);
  assert.deepEqual(server.requests.map(row => row.url), ["/v1/files", "/v1/batches", "/v1/batches/batch-fixture", "/v1/files/output-fixture/content"]);
  assert.ok(server.requests.every(row => row.headers.authorization === "Bearer " + key));
  assert.match(server.requests[0].body, /Fictional amber telescope/);
  const body = JSON.parse(server.requests[1].body); assert.equal(body.metadata.agent, "one");
});

test("bridge retirement cancels a stalled native batch status response and joins its physical transport", async t => {
  const entered = deferred(), closed = deferred();
  const server = await localServer(t, (request, res) => {
    if (request.url === "/v1/files") res.end('{"id":"input-fixture"}');
    else if (request.url === "/v1/batches") res.end('{"id":"batch-fixture","status":"in_progress"}');
    else { res.writeHead(200); res.write('{"id":'); res.once("close", () => closed.resolve()); entered.resolve(); }
  });
  const f = fixture(t); f.owner.baseUrl = server.baseUrl;
  const created = await f.adapter(core.openAiMemoryEmbeddingProviderAdapter).create(options());
  const pending = created.runtime.batchEmbed({ agentId: "one", chunks: [{ text }], wait: true, concurrency: 1, pollIntervalMs: 1, timeoutMs: 60_000 });
  const checked = assert.rejects(pending); await bounded(entered.promise, "native batch did not poll");
  await bounded(f.resource.close(), "native batch cancellation failed to retire");
  await checked; await bounded(closed.promise, "native response transport did not close");
  assert.equal(f.resource.pending.size, 0); assert.equal(f.resource.handles.size, 0); assert.equal(server.requests.length, 3);
});

test("a revision revoked between batch response and next dispatch cannot upload or poll again", async t => {
  let f;
  const server = await localServer(t, (request, res) => {
    assert.equal(request.url, "/v1/files"); f.revisions.set("credential-one", 2); res.end('{"id":"input-fixture"}');
  });
  f = fixture(t); f.owner.baseUrl = server.baseUrl;
  const created = await f.adapter(core.openAiMemoryEmbeddingProviderAdapter).create(options());
  await assert.rejects(created.runtime.batchEmbed({ agentId: "one", chunks: [{ text }], wait: true, concurrency: 1, pollIntervalMs: 1, timeoutMs: 3000 }));
  assert.equal(server.requests.length, 1);
});

test("late factory result remains owned, is physically retired once and cannot publish from the cancelled generation", async t => {
  const f = fixture(t), entered = deferred(), gate = deferred(), closeGate = deferred(), nativeClose = deferred(); let closes = 0, settled = false;
  const result = f.adapter(fakeAdapter({ create: async () => {
    entered.resolve(); await gate.promise;
    return { provider: { id: "openai", model: "fixture", embed: async () => [1, 0], close: async () => { closes++; nativeClose.resolve(); await closeGate.promise; } } };
  } })).create(options());
  await entered.promise;
  const closing = f.resource.close().then(() => { settled = true; }); await tick(); assert.equal(settled, false);
  gate.resolve(); const created = await result; await nativeClose.promise; assert.equal(settled, false);
  assert.throws(() => created.provider.embed(text), { code: "MEMORY_SCOPE_REVOKED" });
  closeGate.resolve(); await closing; await created.provider.close(); assert.equal(closes, 1);
  assert.equal(f.resource.pending.size, 0); assert.equal(f.resource.handles.size, 0);
});

test("per-handle close refuses new query/batch work and physically joins a held provider before closing once", async t => {
  const f = fixture(t), entered = deferred(), gate = deferred(); let closed = 0, settled = false;
  const created = await f.adapter(fakeAdapter({ create: async () => ({ provider: { id: "openai", model: "fixture",
    embed: async () => { entered.resolve(); await gate.promise; return [1, 0]; }, close: async () => { closed++; } },
    runtime: { batchEmbed: async () => [[1, 0]] } }) })).create(options());
  const pending = created.provider.embed(text); await entered.promise;
  const closing = created.provider.close().then(() => { settled = true; }); await tick(); assert.equal(settled, false);
  assert.throws(() => created.provider.embed(text), { code: "MEMORY_SCOPE_REVOKED" });
  assert.throws(() => created.runtime.batchEmbed({ chunks: [] }), { code: "MEMORY_SCOPE_REVOKED" });
  gate.resolve(); await pending; await closing; await created.provider.close(); assert.equal(closed, 1);
});

test("failed native retirement is reported and retry closes only this owned handle", async t => {
  const f = fixture(t); let closes = 0;
  await f.adapter(fakeAdapter({ create: async () => ({ provider: { close: async () => { if (++closes === 1) throw new Error("owned close failure"); } } }) })).create(options());
  await assert.rejects(f.resource.close(), error => error instanceof AggregateError && error.errors.length === 1);
  assert.equal(f.resource.handles.size, 1); await f.resource.close(); assert.equal(closes, 2); assert.equal(f.resource.handles.size, 0);
});

test("stopped Profile and config change reject a physically late embedding result before it returns", async t => {
  for (const cause of ["profile", "config"]) {
    const f = fixture(t), entered = deferred(), gate = deferred();
    const created = await f.adapter(fakeAdapter({ create: async () => ({ provider: { embed: async () => {
      entered.resolve(); await gate.promise; return [1, 0];
    } } }) })).create(options());
    const pending = created.provider.embed(text), checked = assert.rejects(pending, { code: cause === "profile" ? "MEMORY_SCOPE_REVOKED" : "MEMORY_REMOTE_PROVIDER_CHANGED" });
    await entered.promise; if (cause === "profile") f.stop(); else f.config._shoggothConfigRevision++;
    gate.resolve(); await checked; assert.equal(f.resource.pending.size, 0);
  }
});

test("actual Product Service injects private resources into its index and Profile stop/Service reopen fence retained handles", async t => {
  const { service, id, lookups } = await productFixture(t);
  await service.start(); const owner = service.memoryEngine, bridge = owner.remoteEmbeddingResources, host = owner.host(id);
  assert.equal(host.searchIndex.remoteEmbeddingResources, bridge);
  const created = await bridge.resolveAdapter({ agentId: id, providerId: "openai", adapter: fakeAdapter() }).create(options({ agentId: id }));
  assert.deepEqual(await created.provider.embed(text), [1, 0]);
  await owner.stopProfile(id); assert.throws(() => created.provider.embed(text), { code: "MEMORY_SCOPE_REVOKED" });
  const afterStop = lookups.length; await owner.reconcileConfig(); assert.equal(lookups.length, afterStop, "config apply does not acquire a stopped Profile owner");
  await owner.close(); assert.equal(bridge.closed, true); assert.equal(bridge.handles.size, 0);
  owner.open([]); assert.notEqual(owner.remoteEmbeddingResources, bridge);
  assert.throws(() => bridge.capture(id), { code: "MEMORY_SCOPE_REVOKED" });
  const fresh = owner.remoteEmbeddingResources;
  const restarted = await fresh.resolveAdapter({ agentId: id, providerId: "openai", adapter: fakeAdapter() }).create(options({ agentId: id }));
  assert.deepEqual(await restarted.provider.embed(text), [1, 0]);
  assert.ok(lookups.every(packet => packet.agentId === id && packet.providerId === "openai" && packet.ownerRef === "owner-one"));
});


test("a real Service index retirement failure still joins the remote provider before reporting failure", async t => {
  const { service, id } = await productFixture(t); await service.start();
  const owner = service.memoryEngine, host = owner.host(id), entered = deferred(), gate = deferred();
  let settled = false, physicalCloses = 0;
  const created = await owner.remoteEmbeddingResources.resolveAdapter({ agentId: id, providerId: "openai",
    adapter: fakeAdapter({ create: async () => ({ provider: { id: "openai", close: async () => {
      physicalCloses++; entered.resolve(); await gate.promise;
    } } }) }) }).create(options({ agentId: id }));
  const nativeClose = host.searchIndex.close, failure = new Error("synthetic owned index retirement failure");
  host.searchIndex.close = async () => { await nativeClose.call(host.searchIndex); throw failure; };
  const closing = owner.close(); const checked = assert.rejects(closing, error => error === failure);
  closing.then(() => { settled = true; }, () => { settled = true; });
  try { await entered.promise; await tick(); assert.equal(settled, false); }
  finally { gate.resolve(); host.searchIndex.close = nativeClose; }
  await checked; assert.equal(physicalCloses, 1); assert.equal(owner.remoteEmbeddingResources.handles.size, 0);
  await created.provider.close(); assert.equal(physicalCloses, 1);
});

test("nested private resource scope preserves text and media source authority before the real native dispatch", async t => {
  const server = await localServer(t, (request, res) => {
    const body = JSON.parse(request.body);
    if (request.url.includes("/models/")) res.end(JSON.stringify({ embedding: { values: [3, 4, ...Array(126).fill(0)] } }));
    else vectors(request, res);
  });
  for (const media of [false, true]) {
    const f = fixture(t), entered = deferred(), gate = deferred(); let sourceCurrent = true, requestChecks = 0;
    const native = media ? core.geminiMemoryEmbeddingProviderAdapter : core.openAiMemoryEmbeddingProviderAdapter;
    if (media) {
      f.config.memory.search.provider = "gemini"; f.config.memory.search.providerRefs = { gemini: "owner-one" }; f.owner.providerId = "gemini";
    }
    f.owner.baseUrl = server.baseUrl;
    const adapter = { ...native, create: async request => {
      const created = await native.create(request), embed = created.provider.embed;
      return { ...created, provider: { ...created.provider, embed: async (value, extra) => {
        entered.resolve(); await gate.promise; return embed(value, extra);
      } } };
    } };
    const created = await f.adapter(adapter).create(options({ provider: native.id,
      model: media ? "gemini-embedding-2" : "fixture-embedding", dimensions: media ? 128 : 2 }));
    const input = media ? { text: "Invented image label", parts: [{ type: "text", text: "Invented image label" },
      { type: "inline-data", mimeType: "image/png", data: "AA==" }] } : text;
    const pending = core.withMemoryEmbeddingExecution({ signal: AbortSignal.timeout(3000), assertCurrent() {},
      assertRequestCurrent() { requestChecks++; if (!sourceCurrent) throw Object.assign(new Error("fixture source revoked"), { code: "MEMORY_SOURCE_CHANGED" }); } },
      () => created.provider.embed(input, { inputType: "document" }));
    const checked = assert.rejects(pending, { code: "MEMORY_SOURCE_CHANGED" });
    await bounded(entered.promise, "native source request did not reach fixture gate");
    sourceCurrent = false; gate.resolve(); await checked;
    assert.ok(requestChecks > 0, "parent source guard must survive the resource ALS scope");
    assert.equal(server.requests.length, 0, media ? "revoked media bytes never leave source boundary" : "revoked text never leaves source boundary");
  }
});
