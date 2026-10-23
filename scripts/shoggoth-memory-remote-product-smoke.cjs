"use strict";

// Product host/index and native algorithms use invented records and credentials.
// Every request goes to a fixture server bound to 127.0.0.1. No Vault/user files.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const { MemoryDatabase } = require("../app/agent-service/shoggoth-memory/database.cjs");
const { ShoggothMemoryHost, core } = require("../app/agent-service/shoggoth-memory/host.cjs");
const { MemorySearchIndex } = require("../app/agent-service/shoggoth-memory/search-index.cjs");
const { MemoryRemoteProviderResources } = require("../app/agent-service/shoggoth-memory/remote-provider-resources.cjs");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, message) {
  const stop = Date.now() + 8000;
  while (Date.now() < stop) { if (read()) return; await delay(5); }
  assert.fail(message);
}
async function fixture(t, provider = "openai", search = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sg-memory-remote-product-")); fs.chmodSync(root, 0o700);
  const workspace = path.join(root, "one"); fs.mkdirSync(path.join(workspace, "memory"), { recursive: true, mode: 0o700 });
  const requests = [], held = [], owners = new Map(), credentials = new Map(), e5Calls = [], secretReads = [];
  let mode = "normal", hold = false, revision = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8"); let body;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = { raw }; }
    const request = { url: req.url, method: req.method, headers: req.headers, body }; requests.push(request); res.once("close", () => { request.responseClosed = true; });
    const finish = () => {
      res.setHeader("content-type", "application/json");
      if (mode === "error" || mode === "primary-error" && req.headers.authorization === "Bearer synthetic-openai-credential") { res.writeHead(503); res.end('{"error":"synthetic outage"}'); return; }
      const vector = () => [3, 4, ...Array((body?.dimensions || body?.outputDimensionality || body?.requests?.[0]?.outputDimensionality || 2) - 2).fill(0)];
      if (req.url.includes(":batchEmbedContents")) res.end(JSON.stringify({ embeddings: body.requests.map(() => ({ values: vector() })) }));
      else if (req.url.includes(":embedContent")) res.end(JSON.stringify({ embedding: { values: vector() } }));
      else if (req.url.includes("/api/embed")) res.end(JSON.stringify({ embeddings: (Array.isArray(body.input) ? body.input : [body.input]).map(() => vector()) }));
      else res.end(JSON.stringify({ data: (Array.isArray(body.input) ? body.input : [body.input]).map((_, index) => ({ index, embedding: vector() })).reverse() }));
    };
    if (hold) held.push(finish); else finish();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const paths = { trustedRoot: root, stateDir: path.join(root, "state"), agentsDir: path.join(root, "agents") };
  const database = new MemoryDatabase({ paths, databasePath: path.join(paths.agentsDir, "one.sqlite") }); database.open();
  const config = { _shoggothConfigRevision: 0, memory: { search: { provider, sources: ["memory"], query: { minScore: 0 },
    cache: { enabled: true }, providerRefs: { [provider]: "owner-one" }, ...search } } };
  if (provider === "gemini") Object.assign(config.memory.search, { model: "gemini-embedding-2", outputDimensionality: 128 }, search);
  if (provider === "openai-compatible") config.memory.search.model ||= "fixture-compatible";
  const host = new ShoggothMemoryHost({ database, paths, profileId: "one", workspaceDir: workspace,
    roster: () => [{ id: "one", workspace }], sessions: { list: () => [] } });
  const secretStore = { listMetadata: () => [...credentials].map(([credentialRef, entry]) => ({ credentialRef, kind: entry.kind })),
    getCredentialRevision: ref => credentials.has(ref) ? revision : null,
    get: async ref => { secretReads.push(ref); return credentials.get(ref)?.value; } };
  const resources = new MemoryRemoteProviderResources({ getConfig: id => { assert.equal(id, "one"); return config; },
    assertCurrent: id => { assert.equal(id, "one"); host.assertCurrent(); },
    resolveOwner: ({ agentId, providerId, ownerRef }) => { assert.equal(agentId, "one"); return owners.get(`${providerId}:${ownerRef}`); }, secretStore });
  const addOwner = (id, ref, endpoint = baseUrl, { credentialRef = `key-${id}`, value = `synthetic-${id}-credential`, available = true } = {}) => {
    const owner = { ownerRef: ref, profileId: "one", providerId: id, revision: 0, baseUrl: endpoint,
      credentialRef, credentialKind: credentialRef === null ? null : "external-provider-api-key" };
    owners.set(`${id}:${ref}`, owner);
    if (credentialRef !== null && available) credentials.set(credentialRef, { kind: "external-provider-api-key", value });
    return owner;
  };
  addOwner(provider, "owner-one");
  const index = new MemorySearchIndex({ host, databasePath: database.path, sharedDatabase: true,
    embedding: { identity: "unused-E5", encode: async (...args) => { e5Calls.push(args); assert.fail("Remote providers must not route through E5"); } },
    remoteEmbeddingResources: resources, getConfig: () => config, backgroundSync: false,
    logger: { warn() {}, debug() {} } });
  const chunks = () => database.db.prepare("SELECT id,path,text,model,embedding FROM memory_index_chunks ORDER BY id").all();
  const write = text => fs.writeFileSync(path.join(workspace, "MEMORY.md"), text, { mode: 0o600 });
  t.after(async () => {
    hold = false; for (const finish of held.splice(0)) finish();
    const errors = [];
    try { await index.close(); } catch (error) { errors.push(error); }
    try { await resources.close(); } catch (error) { errors.push(error); }
    assert.equal(index.embeddingExecutors.size, 0); assert.equal(index.searchOwners.size, 0);
    assert.equal(resources.pending.size, 0); assert.equal(resources.handles.size, 0);
    database.close(); const stopped = once(server, "close"); server.close(); server.closeAllConnections(); await stopped;
    fs.rmSync(root, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors);
  });
  return { root, workspace, paths, server, requests, held, owners, credentials, secretReads, baseUrl, host, database, config, index, resources, e5Calls, chunks, write, addOwner,
    change: change => { Object.assign(config.memory.search, change); config._shoggothConfigRevision++; },
    rotate: () => { revision++; }, mode: value => { mode = value; }, hold: value => { hold = value; },
    release: () => { hold = false; for (const finish of held.splice(0)) finish(); } };
}
function sameGeneration(f) {
  const owner = f.index.searchOwner, executor = f.index.embeddingExecutor;
  assert.equal(owner.executor, executor); assert.equal(owner.provider, executor.provider);
  assert.equal(owner.providerRuntime.cacheKeyData, executor.providerRuntime.cacheKeyData);
  assert.equal(f.index.model, owner.provider.model);
  assert.ok(f.chunks().every(row => row.model === owner.provider.model));
  assert.equal(f.e5Calls.length, 0);
  const persisted = JSON.stringify([...f.database.db.prepare("SELECT * FROM memory_index_meta").all(), ...f.database.db.prepare("SELECT * FROM memory_embedding_cache").all()]);
  for (const entry of f.credentials.values()) assert.equal(persisted.includes(entry.value), false);
  assert.equal(owner.cacheKey.includes("synthetic-"), false);
}
for (const provider of ["openai", "mistral", "voyage", "gemini", "ollama", "openai-compatible"]) {
  test(`Product ${provider}: real native document/query calls, one runtime and public identity`, { timeout: 15000 }, async t => {
    const f = await fixture(t, provider); f.write("Amber observatory has a fictional telescope on the mountain.");
    await f.index.sync(); sameGeneration(f); assert.equal(f.chunks().length, 1);
    assert.ok(f.requests.length > 0); const before = f.requests.length;
    const results = await f.index.search("Amber fictional telescope", { minScore: 0, record: false });
    assert.ok(results.some(row => row.path === "MEMORY.md")); sameGeneration(f);
    assert.ok(f.requests.length > before, "query must reach the same native provider");
    const queries = f.requests.slice(before);
    for (const row of f.requests) {
      assert.equal(row.headers.authorization, provider === "gemini" ? undefined : `Bearer synthetic-${provider}-credential`);
      if (provider === "gemini") assert.equal(row.headers["x-goog-api-key"], "synthetic-gemini-credential");
    }
    if (provider === "voyage") {
      assert.ok(f.requests.some(row => row.body?.input_type === "document"));
      assert.ok(queries.some(row => row.body?.input_type === "query"));
    }
    if (provider === "gemini") {
      assert.ok(f.requests.some(row => row.url.includes(":batchEmbedContents")));
      assert.ok(queries.some(row => row.url.includes(":embedContent")));
      assert.ok(queries.some(row => row.body?.content?.parts?.some(part => /query:/u.test(part.text || ""))));
    }
  });
}
test("Product fallback resolves its own owner, endpoint, key and native default model", { timeout: 15000 }, async t => {
  const f = await fixture(t, "openai", { fallback: "mistral" });
  f.credentials.delete("key-openai");
  f.addOwner("mistral", "owner-fallback", f.baseUrl + "/secondary", { value: "synthetic-distinct-fallback-key" });
  f.config.memory.search.providerRefs.mistral = "owner-fallback";
  f.write("Amber fallback observatory has a fictional telescope.");
  await f.index.sync(); sameGeneration(f);
  assert.equal(f.index.searchOwner.provider.id, "mistral"); assert.equal(f.index.model, core.DEFAULT_MISTRAL_EMBEDDING_MODEL);
  assert.equal(f.index.searchOwner.fallbackFrom, "openai");
  assert.deepEqual(f.secretReads, ["key-mistral"]);
  assert.ok(f.requests.every(row => row.headers.authorization === "Bearer synthetic-distinct-fallback-key" && row.url.startsWith("/v1/secondary/")));
  assert.ok((await f.index.search("Amber fallback", { minScore: 0, record: false })).length > 0);
});
test("Product native role overrides remain original and do not leak private keys into config", async t => {
  const f = await fixture(t, "openai", { inputType: "generic", queryInputType: "query-role", documentInputType: "document-role" });
  f.write("Amber role telescope."); await f.index.sync(); await f.index.search("Amber role", { minScore: 0, record: false });
  assert.ok(f.requests.some(row => row.body.input_type === "document-role"));
  assert.ok(f.requests.some(row => row.body.input_type === "query-role"));
  assert.equal(JSON.stringify(f.config).includes("synthetic-openai-credential"), false); sameGeneration(f);
});
test("Product owner endpoint mismatch and another Profile cannot borrow credentials or dispatch", async t => {
  const f = await fixture(t);
  f.config.memory.search.remote = { baseUrl: f.baseUrl + "/other-destination" };
  f.write("Amber endpoint refusal.");
  await assert.rejects(f.index.sync()); assert.equal(f.requests.length, 0); assert.equal(f.secretReads.length, 0);
  delete f.config.memory.search.remote; f.owners.get("openai:owner-one").profileId = "two";
  await assert.rejects(f.index.sync(), { code: "MEMORY_REMOTE_PROVIDER_OWNER_INVALID" });
  assert.equal(f.requests.length, 0); assert.equal(f.secretReads.length, 0);
});
test("Product credential rotation withdraws late query publication and acquires a fresh native owner", { timeout: 15000 }, async t => {
  const f = await fixture(t); f.write("Amber rotation telescope."); await f.index.sync();
  const old = f.index.searchOwner, before = f.chunks(); f.hold(true);
  const query = f.index.search("Amber rotation telescope", { minScore: 0, record: false });
  const rejected = assert.rejects(query, { code: "MEMORY_CONFIG_CHANGED" });
  await until(() => f.held.length > 0, "native query did not reach loopback response gate");
  f.credentials.get("key-openai").value = "synthetic-rotated-key"; f.rotate();
  const heldRequest = f.requests.at(-1);
  const replacement = f.index.sync();
  await rejected; await replacement;
  await until(() => heldRequest.responseClosed, "retired native HTTP request was not physically aborted");
  assert.equal(old.closed, true); assert.equal(old.executor.pending.size, 0);
  assert.equal(f.resources.pending.size, 0); assert.deepEqual(f.chunks(), before); sameGeneration(f);
  f.release();
  await f.index.search("Amber rotation telescope", { minScore: 0, record: false });
  assert.ok(f.requests.some(row => row.headers.authorization === "Bearer synthetic-rotated-key"));
});
test("Product provider outage preserves semantic rows and a recovered provider retries real documents", { timeout: 15000 }, async t => {
  const f = await fixture(t); f.write("Amber healthy telescope."); await f.index.sync(); const before = f.chunks();
  f.mode("error"); f.write("Amber telescope changed during invented outage.");
  await assert.rejects(f.index.sync()); assert.deepEqual(f.chunks(), before);
  f.mode("normal"); await f.index.sync(); sameGeneration(f);
  assert.match(f.chunks()[0].text, /changed/u);
});

test("Product document failure activates native fallback and publishes only its vector generation", { timeout: 15000 }, async t => {
  const f = await fixture(t, "openai", { fallback: "mistral" });
  f.addOwner("mistral", "owner-fallback", f.baseUrl, { value: "synthetic-secondary-model-key" });
  f.config.memory.search.providerRefs.mistral = "owner-fallback";
  f.mode("primary-error"); f.write("Amber original native source fallback telescope.");
  await f.index.sync(); sameGeneration(f);
  assert.equal(f.index.searchOwner.provider.id, "mistral");
  assert.equal(f.index.searchOwner.fallbackFrom, "openai");
  assert.ok(f.requests.some(row => row.headers.authorization === "Bearer synthetic-openai-credential"));
  assert.ok(f.requests.some(row => row.headers.authorization === "Bearer synthetic-secondary-model-key"));
  assert.ok(f.chunks().every(row => row.model === core.DEFAULT_MISTRAL_EMBEDDING_MODEL));
});

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z5kAAAAASUVORK5CYII=", "base64");
const wav = Buffer.alloc(44);
wav.write("RIFF", 0); wav.writeUInt32LE(36, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write("data", 36);
test("Product Gemini 2 media uses real structured native requests, batch-null inline and safe cached rows", async t => {
  const f = await fixture(t, "gemini", { multimodal: { enabled: true, modalities: ["image", "audio"], maxFileBytes: 1048576 }, remote: { batch: { enabled: true } } });
  const library = path.join(f.root, "library"); fs.mkdirSync(library, { mode: 0o700 });
  f.config.memory.search.extraPaths = [library];
  fs.writeFileSync(path.join(library, "telescope.png"), png, { mode: 0o600 });
  fs.writeFileSync(path.join(library, "telescope.wav"), wav, { mode: 0o600 });
  const { validateNativeMemoryConfigProjection } = require("../app/agent-service/native-memory-config-protocol");
  validateNativeMemoryConfigProjection({ revision: 1, config: { memory: f.config.memory } });
  await f.index.sync(); sameGeneration(f); assert.equal(f.chunks().length, 2);
  const inputs = f.requests.flatMap(request => request.body?.requests || [request.body]);
  assert.ok(inputs.some(input => input.content?.parts?.some(part => part.inlineData?.mimeType === "image/png" && part.inlineData.data === png.toString("base64"))));
  assert.ok(inputs.some(input => input.content?.parts?.some(part => part.inlineData?.mimeType === "audio/wav" && part.inlineData.data === wav.toString("base64"))));
  assert.ok(f.requests.every(request => request.url.includes(":batchEmbedContents")), "media uses native structured inline document calls, never vendor batch uploads");
  assert.equal(f.index.embeddingExecutor.batch.enabled, true);
  const count = f.requests.length; await f.index.sync(); assert.equal(f.requests.length, count);
  for (const row of f.chunks()) {
    assert.equal(row.text.includes(png.toString("base64")), false); assert.equal(row.text.includes(wav.toString("base64")), false);
    assert.equal(core.decodeMemoryEmbedding(row.embedding).length, 128);
  }
  const provenance = f.database.db.prepare("SELECT origin_class FROM memory_index_chunk_provenance").all();
  assert.ok(provenance.every(row => row.origin_class === "untrusted"));
  f.change({ extraPaths: [] }); await f.index.sync(); assert.equal(f.chunks().length, 0);
  assert.equal(f.requests.length, count); assert.equal(fs.existsSync(path.join(library, "telescope.png")), true);
});
for (const provider of ["openai", "mistral", "voyage", "ollama", "openai-compatible"]) {
  test(`Product ${provider} media capability rejects before credentials or dispatch`, async t => {
    const f = await fixture(t, provider, { multimodal: { enabled: true, modalities: ["image"] } });
    f.write("Amber must not become a fake media transport.");
    await assert.rejects(f.index.sync(), /multimodal requires/u);
    assert.equal(f.requests.length, 0); assert.equal(f.secretReads.length, 0); assert.deepEqual(f.chunks(), []);
  });
}
test("Product Gemini 001 and media fallback are rejected before any external work", async t => {
  const f = await fixture(t, "gemini", { model: "gemini-embedding-001", multimodal: { enabled: true, modalities: ["audio"] } });
  await assert.rejects(f.index.sync(), /multimodal requires/u);
  f.change({ model: "gemini-embedding-2", fallback: "openai" });
  await assert.rejects(f.index.sync(), /multimodal does not support/u);
  assert.equal(f.requests.length, 0); assert.equal(f.secretReads.length, 0); assert.deepEqual(f.chunks(), []);
});


function syntheticSessions(f, records) {
  const values = new Map(Object.entries(records).map(([id, text]) => [id, { text, stamp: 1791398400000 }]));
  const reads = [];
  const snapshot = id => {
    const record = values.get(id); assert.ok(record, "unknown synthetic session");
    const content = "User: " + record.text + "\nAssistant: Fictional session acknowledgement.";
    const value = { content, lineMap: [7, 42], messageTimestampsMs: [record.stamp, record.stamp],
      lineProvenance: [{ originClass: "owner", sessionKind: "interactive", observedAt: record.stamp },
        { originClass: "agent", sessionKind: "interactive", observedAt: record.stamp }], resetRecallCutoff: null };
    return { ...value, hash: core.hashSessionEntrySnapshot(value), mtimeMs: record.stamp, size: Buffer.byteLength(content) };
  };
  f.host.sessions.list = () => [...values].map(([id, record]) => ({ id, interactive: true, updatedAt: record.stamp }));
  f.host.sessions.read = (agentId, id) => { assert.equal(agentId, "one"); reads.push(id); return snapshot(id); };
  f.host.sessions.stat = (agentId, id) => { assert.equal(agentId, "one"); return snapshot(id); };
  return { reads, update: (id, text) => { const record = values.get(id); record.text = text; record.stamp++; } };
}
function nativeFallback(f) {
  f.addOwner("mistral", "owner-fallback", f.baseUrl + "/secondary", { value: "synthetic-secondary-model-key" });
  f.config.memory.search.providerRefs.mistral = "owner-fallback";
}
test("Product ordinary native fallback retains dirty work until the next native sync", { timeout: 20000 }, async t => {
  const f = await fixture(t, "openai", { fallback: "mistral", sources: ["memory", "sessions"] }); nativeFallback(f);
  syntheticSessions(f, { "session-a": "Amber session A telescope remains unchanged.", "session-b": "Azure session B telescope remains unchanged." });
  f.write("Amber primary publication before fictional outage."); await f.index.sync();
  assert.equal(f.chunks().length, 3); const before = f.chunks(), count = f.requests.length;
  f.write("Amber memory document changed during fictional primary outage."); f.mode("primary-error");
  await f.index.sync({ nativeParams: { reason: "watch" } });
  assert.equal(f.index.searchOwner.provider.id, "mistral"); assert.equal(f.index.searchOwner.fallbackFrom, "openai");
  assert.deepEqual(f.chunks(), before, "ordinary native fallback retains the published generation");
  assert.equal(f.index.embeddingExecutor.dirty, true);
  const failedCalls = f.requests.slice(count);
  assert.ok(failedCalls.length > 0);
  assert.ok(failedCalls.every(row => row.headers.authorization === "Bearer synthetic-openai-credential"));
  assert.ok(failedCalls.every(row => JSON.stringify(row.body).includes("memory document changed")), "ordinary failure must not widen to other documents");
  await f.index.sync({ nativeParams: { reason: "watch" } }); sameGeneration(f);
  assert.equal(f.chunks().length, 3);
  assert.ok(f.chunks().some(row => /memory document changed/u.test(row.text)));
  assert.ok(f.requests.slice(count).some(row => row.headers.authorization === "Bearer synthetic-secondary-model-key"));
});
test("Product targeted native fallback retains only the requested session before a full generation retry", { timeout: 20000 }, async t => {
  const f = await fixture(t, "openai", { fallback: "mistral", sources: ["memory", "sessions"] }); nativeFallback(f);
  const sessions = syntheticSessions(f, { "session-a": "Amber requested session A initial telescope.", "session-b": "Azure unrelated session B initial telescope." });
  f.write("Amber unrequested memory document initial telescope."); await f.index.sync();
  assert.equal(f.chunks().length, 3); const before = f.chunks(), count = f.requests.length;
  sessions.update("session-a", "Amber requested session A changed telescope.");
  sessions.update("session-b", "Azure unrelated session B changed telescope.");
  f.write("Amber unrequested memory document changed telescope."); f.mode("primary-error");
  const nativeParams = { reason: "queued-sessions", sessions: [{ agentId: "one", sessionId: "session-a" }] };
  await assert.rejects(f.index.sync({ nativeParams }), { code: "MEMORY_EMBEDDING_UNAVAILABLE" });
  assert.equal(f.index.searchOwner.provider.id, "mistral"); assert.deepEqual(f.chunks(), before);
  assert.equal(f.index.embeddingExecutor.sessionsDirtyFiles.size, 1);
  assert.ok([...f.index.embeddingExecutor.sessionsDirtyFiles][0].endsWith("/.session-source/session-a"));
  const targetedCalls = f.requests.slice(count); assert.ok(targetedCalls.length > 0);
  assert.ok(targetedCalls.every(row => row.headers.authorization === "Bearer synthetic-openai-credential"));
  assert.ok(targetedCalls.every(row => JSON.stringify(row.body).includes("requested session A changed")));
  assert.ok(targetedCalls.every(row => !/unrelated session B changed|unrequested memory document changed/u.test(JSON.stringify(row.body))));
  const retryCount = f.requests.length;
  await f.index.sync({ nativeParams });
  assert.equal(f.requests.length, retryCount, "a targeted identity mismatch waits for a corpus generation retry");
  assert.deepEqual(f.chunks(), before);
  assert.equal(f.index.embeddingExecutor.sessionsDirtyFiles.size, 1);
  await f.index.sync({ nativeParams: { reason: "watch" } }); sameGeneration(f);
  assert.equal(f.chunks().length, 3);
  assert.ok(f.chunks().every(row => /changed/u.test(row.text)));
  assert.equal(f.index.embeddingExecutor.sessionsDirtyFiles.size, 0);
});
