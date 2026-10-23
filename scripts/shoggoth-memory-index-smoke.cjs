"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MemoryDatabase } = require("../app/agent-service/shoggoth-memory/database.cjs");
const { ShoggothMemoryHost, core } = require("../app/agent-service/shoggoth-memory/host.cjs");
const { MemorySearchIndex } = require("../app/agent-service/shoggoth-memory/search-index.cjs");

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, { batch, encode = async () => [1, 0], cache = true } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-memory-index-"));
  const paths = { trustedRoot: root, stateDir: path.join(root, "state") };
  const database = new MemoryDatabase({ paths }); database.open();
  const workspace = path.join(root, "one"); fs.mkdirSync(path.join(workspace, "memory"), { recursive: true, mode: 0o700 });
  const host = new ShoggothMemoryHost({ database, paths, profileId: "one", workspaceDir: workspace,
    roster: () => [{ id: "one", workspace }], sessions: { list: () => [], read: () => null } });
  // Private constructor resources only: no public provider config/Vault binding.
  // The loopback marker makes the native resolver include its batch settings.
  const config = { memory: { search: { provider: "shoggoth-e5", cache: { enabled: cache },
    ...(batch ? { remote: { baseUrl: "http://127.0.0.1:1/unused", batch: { enabled: true } } } : {}) } } };
  const logs = [], embedding = { identity: "fixture-index-v1", encode }, runtime = batch ? { batchEmbed: batch } : undefined;
  const options = { host, databasePath: database.path, sharedDatabase: true, embedding, embeddingRuntime: runtime,
    getConfig: () => config, logger: { warn: value => logs.push(value), debug: value => logs.push(value) } };
  const f = { database, host, config, embedding, runtime, logs, index: new MemorySearchIndex(options), options,
    write: (name, content) => fs.writeFileSync(path.join(workspace, name), content, { mode: 0o600 }),
    rows: table => database.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n };
  t.after(async () => { await f.index.close(); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return f;
}

test("native batch failures fall back inline, disable at two, and reset only with a new owner", async t => {
  let jobs = 0, inline = 0;
  const f = fixture(t, { batch: async () => { jobs++; throw new Error("REFLECTED-PRIVATE-MEMORY"); },
    encode: async () => { inline++; return [1, 0]; } });
  f.write("MEMORY.md", "Amber observatory."); await f.index.sync();
  assert.deepEqual(f.index.embeddingExecutor.status(), { batchEnabled: true, batchFailureCount: 1 });
  f.write("memory/2026-10-08.md", "Violet telescope."); await f.index.sync();
  assert.deepEqual(f.index.embeddingExecutor.status(), { batchEnabled: false, batchFailureCount: 2 });
  f.write("memory/2026-10-09.md", "Indigo star."); await f.index.sync();
  assert.equal(jobs, 2); assert.equal(inline, 3); assert.equal(f.rows("memory_embedding_cache"), 3);
  assert.equal(JSON.stringify(f.logs).includes("REFLECTED-PRIVATE-MEMORY"), false);
  await f.index.close(); f.index = new MemorySearchIndex(f.options);
  f.runtime.batchEmbed = async ({ chunks }) => { jobs++; return chunks.map(() => [1, 0]); };
  f.write("memory/2026-10-10.md", "Silver galaxy."); await f.index.sync();
  assert.equal(jobs, 3); assert.equal(inline, 3);
  assert.deepEqual(f.index.embeddingExecutor.status(), { batchEnabled: true, batchFailureCount: 0 });
});

test("native timeout retry succeeds without inline fallback or a failure counter", async t => {
  let jobs = 0, inline = 0;
  const f = fixture(t, { batch: async ({ chunks }) => { if (++jobs === 1) throw new Error("batch timed out"); return chunks.map(() => [1, 0]); },
    encode: async () => { inline++; return [1, 0]; } });
  f.write("MEMORY.md", "Amber observatory."); await f.index.sync();
  assert.equal(jobs, 2); assert.equal(inline, 0);
  assert.deepEqual(f.index.embeddingExecutor.status(), { batchEnabled: true, batchFailureCount: 0 });
});

for (const kind of ["timeout", "unavailable", "null"]) {
  test(`native ${kind} batch result selects the original inline fallback`, async t => {
    let jobs = 0, inline = 0;
    const f = fixture(t, { batch: async () => {
      jobs++;
      if (kind === "null") return null;
      throw Object.assign(new Error(kind === "timeout" ? "batch timed out" : "batch unavailable"),
        kind === "unavailable" ? { code: "embedding_batch_unavailable" } : {});
    }, encode: async () => { inline++; return [1, 0]; } });
    f.write("MEMORY.md", "Amber observatory."); await f.index.sync();
    assert.equal(jobs, kind === "timeout" ? 2 : 1); assert.equal(inline, 1);
    assert.deepEqual(f.index.embeddingExecutor.status(), kind === "null"
      ? { batchEnabled: true, batchFailureCount: 0 } : { batchEnabled: false, batchFailureCount: 2 });
    assert.equal(f.rows("memory_embedding_cache"), 1);
  });
}

test("native cache collection submits only missing chunks and survives derived-row rebuilds", async t => {
  const batches = [];
  const f = fixture(t, { batch: async ({ chunks }) => { batches.push(chunks.map(row => row.text)); return chunks.map(() => [1, 0]); } });
  const content = "# Memory\n- Amber observatory.\n- Violet telescope.\n";
  f.write("MEMORY.md", content); await f.index.sync(); assert.equal(batches[0].length, 3);
  f.database.db.exec("DELETE FROM memory_index_chunks; DELETE FROM memory_index_sources");
  await f.index.sync(); assert.equal(batches.length, 1);
  f.write("MEMORY.md", content + "- Silver galaxy.\n"); await f.index.sync();
  // Appending changes the former last entry's trailing newline as well as
  // adding one entry. The untouched heading and Amber entry remain cached.
  assert.equal(batches.length, 2); assert.deepEqual(batches[1], ["- Violet telescope.", "- Silver galaxy.\n"]);
});

for (const cache of [true, false]) {
  test(`malformed native batch stays out of the index and cache with caching ${cache}`, async t => {
    const f = fixture(t, { cache, batch: async ({ chunks }) => chunks.map((_, n) => n ? [NaN, 0] : [1, 0]) });
    f.write("MEMORY.md", "# Memory\n- Amber observatory.\n- Violet telescope.\n");
    await f.index.sync();
    assert.equal(f.index.embeddingFailure, "MEMORY_EMBEDDING_INVALID");
    assert.equal(f.rows("memory_embedding_cache"), 0);
    assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM memory_index_chunks WHERE length(embedding)>0").get().n, 0);
    f.runtime.batchEmbed = async ({ chunks }) => chunks.map(() => [1, 0]);
    await f.index.sync(); assert.equal(f.index.embeddingFailure, null);
    assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM memory_index_chunks WHERE length(embedding)>0").get().n, 3);
  });
}

test("oversized vectors cannot enter native cache through background or inline batches", async t => {
  const f = fixture(t, { batch: async ({ chunks }) => chunks.map(() => Array(16_385).fill(1)) });
  f.write("MEMORY.md", "Amber observatory."); await f.index.sync();
  assert.equal(f.index.embeddingFailure, null, "a rejected background batch can still recover inline");
  assert.deepEqual(f.index.embeddingExecutor.status(), { batchEnabled: true, batchFailureCount: 1 });
  assert.equal(f.database.db.prepare("SELECT max(dims) AS dims FROM memory_embedding_cache").get().dims, 2);
  const inline = fixture(t, { encode: async () => Array(16_385).fill(1) });
  inline.write("MEMORY.md", "Amber observatory."); await inline.index.sync();
  assert.equal(inline.index.embeddingFailure, "MEMORY_EMBEDDING_INVALID");
  assert.equal(inline.rows("memory_embedding_cache"), 0);
});

test("cancelled indexing rejects promptly, ignores late completion and can retry", async t => {
  const started = deferred(), delayed = deferred(), controller = new AbortController(); let calls = 0;
  const f = fixture(t, { encode: async () => { calls++; started.resolve(); return delayed.promise; } });
  f.write("MEMORY.md", "# Memory\n- Amber observatory.\n- Violet telescope.\n");
  const operation = f.index.sync({ signal: controller.signal });
  const rejected = assert.rejects(operation, { message: "fixture cancelled" });
  await started.promise; controller.abort(new Error("fixture cancelled")); await rejected;
  assert.equal(f.rows("memory_index_chunks"), 0); assert.equal(f.rows("memory_embedding_cache"), 0);
  delayed.resolve([1, 0]); await tick(); assert.equal(calls, 1);
  f.embedding.encode = async () => { calls++; return [1, 0]; };
  await f.index.sync(); assert.equal(f.rows("memory_index_chunks"), 3); assert.equal(calls, 4);
  assert.deepEqual(shadows(f), []);
});

test("cancel during the original rate-limit wait prevents a second model request", async t => {
  const started = deferred(), controller = new AbortController(); let calls = 0;
  const f = fixture(t, { encode: async () => { calls++; started.resolve(); throw Object.assign(new Error("rate limited"), { status: 429 }); } });
  f.write("MEMORY.md", "Amber observatory.");
  const operation = f.index.sync({ signal: controller.signal }); const rejected = assert.rejects(operation, /fixture cancelled/);
  await started.promise; await tick(); controller.abort(new Error("fixture cancelled")); await rejected;
  assert.equal(calls, 1); assert.equal(f.rows("memory_index_chunks"), 0);
});

test("cancelling a background batch does not charge native provider failure accounting", async t => {
  const started = deferred(), delayed = deferred(), controller = new AbortController(); let inline = 0;
  const f = fixture(t, { batch: async () => { started.resolve(); return delayed.promise; },
    encode: async () => { inline++; return [1, 0]; } });
  f.write("MEMORY.md", "Amber observatory.");
  const operation = f.index.sync({ signal: controller.signal }); const rejected = assert.rejects(operation, /fixture cancelled/);
  await started.promise; controller.abort(new Error("fixture cancelled")); await rejected;
  assert.deepEqual(f.index.embeddingExecutor.status(), { batchEnabled: true, batchFailureCount: 0 });
  assert.equal(inline, 0); assert.equal(f.rows("memory_embedding_cache"), 0);
  delayed.resolve([[1, 0]]); await tick();
  f.runtime.batchEmbed = async ({ chunks }) => chunks.map(() => [1, 0]); await f.index.sync();
  assert.equal(f.rows("memory_index_chunks"), 1);
});

test("query cancellation abandons the result without a recall receipt or extra request", async t => {
  const started = deferred(), delayed = deferred(), controller = new AbortController(); let queries = 0;
  const f = fixture(t, { encode: async (_text, purpose) => {
    if (purpose === "passage") return [1, 0]; queries++; started.resolve(); return delayed.promise;
  } });
  f.write("MEMORY.md", "Amber observatory."); await f.index.sync();
  let receiptAdmissions = 0;
  f.host.pruneUnavailableLibraryCandidates = async () => { receiptAdmissions++; };
  const operation = f.index.search("galaxy", { signal: controller.signal });
  const rejected = assert.rejects(operation, /fixture cancelled/);
  await started.promise; controller.abort(new Error("fixture cancelled")); await rejected;
  delayed.resolve([1, 0]); await tick(); assert.equal(queries, 1); assert.equal(f.index.searches.size, 0);
  assert.equal(receiptAdmissions, 0);
});

test("closing aborts an index request but retains its database until the actual provider settles", async t => {
  const started = deferred(), delayed = deferred(); let closed = false;
  const f = fixture(t, { encode: async () => { started.resolve(); return delayed.promise; } });
  f.write("MEMORY.md", "Amber observatory.");
  const operation = f.index.sync(); const rejected = assert.rejects(operation, { code: "MEMORY_EMBEDDING_CANCELLED" });
  await started.promise; const closing = f.index.close().then(() => { closed = true; });
  await rejected; await tick(); assert.equal(closed, false); assert.ok(f.index.db.isOpen);
  delayed.resolve([1, 0]); await closing; assert.equal(f.index.db, null); assert.equal(f.rows("memory_index_chunks"), 0);
  assert.deepEqual(shadows(f), []);
});

test("source changes while a batch runs cannot publish its vectors or reusable cache", async t => {
  const started = deferred(), delayed = deferred();
  const f = fixture(t, { batch: async () => { started.resolve(); return delayed.promise; } });
  f.write("MEMORY.md", "Amber observatory."); const operation = f.index.sync();
  await started.promise; f.write("MEMORY.md", "Violet telescope."); delayed.resolve([[1, 0]]); await operation;
  assert.equal(f.rows("memory_index_chunks"), 0); assert.equal(f.rows("memory_embedding_cache"), 0);
  f.runtime.batchEmbed = async ({ chunks }) => chunks.map(() => [1, 0]); await f.index.sync();
  assert.match(f.database.db.prepare("SELECT text FROM memory_index_chunks").get().text, /Violet/);
});

test("provider disablement retires the previous native executor and preserves lexical search", async t => {
  const f = fixture(t);
  f.write("MEMORY.md", "Amber observatory."); await f.index.sync(); const previous = f.index.embeddingExecutor;
  f.config.memory.search.provider = "none";
  assert.ok((await f.index.search("Amber", { minScore: 0, record: false })).length);
  assert.equal(previous.closed, true); assert.equal(f.index.embeddingExecutor.provider, null);
  await tick(); assert.equal(f.index.embeddingExecutors.size, 1, "the native lexical writer has its own live owner");
});

test("native runtime cache identity changes rebuild vectors without changing source facts", async t => {
  let jobs = 0;
  const f = fixture(t, { batch: async ({ chunks }) => { jobs++; return chunks.map(() => [jobs, 0]); } });
  f.runtime.cacheKeyData = { endpoint: "fixture-one" };
  f.write("MEMORY.md", "Amber observatory."); await f.index.sync();
  const previous = f.index.embeddingExecutor, first = f.database.db.prepare("SELECT id,text FROM memory_index_chunks").get();
  f.runtime.cacheKeyData = { endpoint: "fixture-two" }; await f.index.sync();
  const current = f.database.db.prepare("SELECT id,text FROM memory_index_chunks").get();
  assert.equal(jobs, 2); assert.equal(previous.closed, true); assert.equal(current.id, first.id); assert.equal(current.text, first.text);
  assert.deepEqual(core.decodeMemoryEmbedding(f.database.db.prepare("SELECT embedding FROM memory_index_chunks").get().embedding), [2, 0]);
  assert.equal(f.database.db.prepare("SELECT count(DISTINCT provider_key) AS n FROM memory_embedding_cache").get().n, 2);
});

test("concurrent index owners do not share cancellation or cache generations", async t => {
  const enteredOne = deferred(), enteredTwo = deferred(), first = deferred(), second = deferred(), controller = new AbortController();
  const one = fixture(t, { batch: async () => { enteredOne.resolve(); return first.promise; } });
  const two = fixture(t, { batch: async () => { enteredTwo.resolve(); return second.promise; } });
  one.write("MEMORY.md", "Amber observatory."); two.write("MEMORY.md", "Violet telescope.");
  const firstRun = one.index.sync({ signal: controller.signal }), secondRun = two.index.sync();
  const rejected = assert.rejects(firstRun, /fixture cancelled/);
  await Promise.all([enteredOne.promise, enteredTwo.promise]); controller.abort(new Error("fixture cancelled")); await rejected;
  second.resolve([[0, 1]]); await secondRun; first.resolve([[1, 0]]); await tick();
  assert.equal(one.rows("memory_embedding_cache"), 0); assert.equal(one.rows("memory_index_chunks"), 0);
  assert.equal(two.rows("memory_embedding_cache"), 1); assert.equal(two.rows("memory_index_chunks"), 1);
  assert.deepEqual(core.decodeMemoryEmbedding(two.database.db.prepare("SELECT embedding FROM memory_index_chunks").get().embedding), [0, 1]);
});

test("native source-wide jobs combine files, keep citations, and reuse cached rebuilds", async t => {
  const batches = [];
  const f = fixture(t, { batch: async ({ chunks }) => { batches.push(chunks.map(chunk => chunk.text)); return chunks.map(() => [1, 0]); } });
  f.runtime.sourceWideBatchEmbed = true;
  f.write("MEMORY.md", "Amber observatory."); f.write("memory/2026-10-08.md", "Violet telescope.");
  await f.index.sync(); assert.equal(batches.length, 1); assert.equal(batches[0].length, 2);
  assert.equal(f.rows("memory_index_sources"), 2); assert.equal(f.rows("memory_embedding_cache"), 2);
  const found = await f.index.search("Violet", { minScore: 0, record: false, lexicalOnly: true });
  assert.equal(found.find(row => row.path === "memory/2026-10-08.md")?.citation, "memory/2026-10-08.md#L1-L1");
  f.database.db.exec("DELETE FROM memory_index_chunks; DELETE FROM memory_index_sources");
  await f.index.sync(); assert.equal(batches.length, 1); assert.equal(f.rows("memory_index_chunks"), 2);
  f.write("memory/2026-10-08.md", "Silver galaxy."); await f.index.sync();
  assert.deepEqual(batches[1], ["Silver galaxy."]); assert.equal(f.index.embeddingExecutor.syncProviderGeneration, null);
});

test("one edited source cannot publish stale vectors while its source-wide neighbor remains valid", async t => {
  const entered = deferred(), delayed = deferred();
  const f = fixture(t, { batch: async () => { entered.resolve(); return delayed.promise; } });
  f.runtime.sourceWideBatchEmbed = true;
  f.write("MEMORY.md", "Amber observatory."); f.write("memory/2026-10-08.md", "Violet telescope.");
  const operation = f.index.sync(); await entered.promise;
  f.write("MEMORY.md", "Silver galaxy."); delayed.resolve([[1, 0], [0, 1]]); await operation;
  assert.equal(f.rows("memory_index_chunks"), 1); assert.equal(f.rows("memory_embedding_cache"), 1);
  assert.equal(f.database.db.prepare("SELECT path FROM memory_index_chunks").get().path, "memory/2026-10-08.md");
  assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM memory_embedding_cache WHERE hash=?").get(core.hashText("Amber observatory.")).n, 0);
});

test("native source-wide file groups stop at 2048 and carry the committed cache revision forward", { timeout: 120_000 }, async t => {
  const sizes = [];
  const f = fixture(t, { batch: async ({ chunks }) => { sizes.push(chunks.length); return chunks.map(() => [1, 0]); } });
  f.runtime.sourceWideBatchEmbed = true;
  for (let n = 0; n < 2049; n++) f.write(`memory/reference-${String(n).padStart(4, "0")}.md`, `Fictional observatory ${n}.`);
  await f.index.sync();
  assert.deepEqual(sizes, [2048, 1]); assert.equal(f.rows("memory_index_sources"), 2049);
  assert.equal(f.rows("memory_embedding_cache"), 2049); assert.equal(f.rows("memory_index_chunks"), 2049);
});

test("a source with 50001 chunks uses original 50000-request groups without truncation", { timeout: 120_000 }, async t => {
  const sizes = [];
  const f = fixture(t, { cache: false, batch: async ({ chunks }) => { sizes.push(chunks.length); return chunks.map(() => [1, 0]); } });
  f.runtime.sourceWideBatchEmbed = true;
  f.write("MEMORY.md", Array.from({ length: 50_001 }, (_, n) => `- Fictional observation ${n}.`).join("\n"));
  await f.index.sync();
  assert.deepEqual(sizes, [50_000, 1]); assert.equal(f.rows("memory_index_chunks"), 50_001);
  assert.equal(f.rows("memory_embedding_cache"), 0);
  assert.match(f.database.db.prepare("SELECT text FROM memory_index_chunks WHERE start_line=50001").get().text, /50000/);
});

test("partial native publication failure is surfaced and restart reuses valid vectors", async t => {
  let jobs = 0;
  const f = fixture(t, { batch: async ({ chunks }) => { jobs++; return chunks.map(() => [1, 0]); } });
  f.runtime.sourceWideBatchEmbed = true; await f.index.sync();
  f.write("MEMORY.md", "Amber observatory."); f.write("memory/2026-10-08.md", "Violet telescope.");
  const db = f.index.embeddingExecutor.database, replace = db.replaceSource; let writes = 0;
  db.replaceSource = async (...args) => { if (++writes === 2) throw new Error("fixture publication failed"); return replace(...args); };
  await assert.rejects(f.index.sync(), /fixture publication failed/);
  assert.equal(f.rows("memory_index_sources"), 1); assert.equal(f.rows("memory_embedding_cache"), 2);
  assert.equal(f.index.embeddingFailure, null, "storage failures cannot masquerade as provider degradation");
  await f.index.close(); f.index = new MemorySearchIndex(f.options); await f.index.sync();
  assert.equal(jobs, 1); assert.equal(f.rows("memory_index_sources"), 2); assert.equal(f.rows("memory_index_chunks"), 2);
});

for (const rebuild of [true, false]) test(`a mixed source-wide ${rebuild ? "rebuild" : "update"} cannot cache or publish a withdrawn Product session`, async t => {
  const entered = deferred(), delayed = deferred(); let visible = true;
  const f = fixture(t, { batch: async () => { entered.resolve(); return delayed.promise; } });
  f.runtime.sourceWideBatchEmbed = true; f.config.memory.search.sources = ["memory", "sessions"];
  if (!rebuild) await f.index.sync();
  const session = { content: "User: Fictional violet telescope.", hash: core.hashText("fictional-session-snapshot"), authorityStamp: "one",
    lineMap: [7], lineProvenance: [{ originClass: "owner", sessionKind: "interactive", observedAt: Date.now() }], size: 32, mtimeMs: Date.now() };
  f.host.sessions.list = () => visible ? [{ id: "s1" }] : [];
  f.host.sessions.read = () => { if (!visible) throw Object.assign(new Error("withdrawn"), { code: "MEMORY_SESSION_REVOKED" }); return session; };
  f.write("MEMORY.md", "Amber observatory.");
  const operation = f.index.sync(); const rejected = assert.rejects(operation, { code: "MEMORY_SESSION_CHANGED" });
  await entered.promise; visible = false; delayed.resolve([[1, 0], [0, 1]]); await rejected;
  assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM memory_index_chunks WHERE source='sessions'").get().n, 0);
  assert.equal(f.rows("memory_embedding_cache"), 1);
  // A failed full rebuild publishes no sources; incremental publication keeps
  // the successful neighboring source. Both retain only its reusable cache.
  assert.equal(f.rows("memory_index_sources"), rebuild ? 0 : 1);
});

function publishedSnapshot(f) {
  return Object.fromEntries(["memory_index_sources", "memory_index_chunks", "memory_index_meta", "memory_index_state",
    "memory_index_chunk_recall_metadata", "memory_index_chunk_provenance", "memory_index_chunks_fts", "memory_index_paths_fts"]
    .map(table => [table, f.database.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function shadows(f) {
  return fs.readdirSync(path.dirname(f.database.path)).filter(name => name.startsWith(`${path.basename(f.database.path)}.memory-reindex-`));
}

test("native shadow rebuild preserves the published corpus until one atomic commit and leaves Product state alone", async t => {
  const entered = deferred(), delayed = deferred(); let rebuilding = false;
  const f = fixture(t, { batch: async ({ chunks }) => {
    if (rebuilding) { entered.resolve(); await delayed.promise; }
    return chunks.map(() => [1, 0]);
  } });
  f.write("MEMORY.md", "Amber observatory."); await f.index.sync();
  const state = f.database.openKeyedStore({ namespace: "fixture-product", maxEntries: 10 });
  await state.register("sentinel", { note: "Product facts must survive index replacement" });
  const productRows = f.database.db.prepare("SELECT * FROM memory_state WHERE namespace='fixture-product'").all();
  const before = publishedSnapshot(f), original = f.index.db;
  f.config.memory.search.store = { fts: { tokenizer: "trigram" } };
  f.write("memory/2026-10-08.md", "Violet telescope."); rebuilding = true;
  const operation = f.index.sync(); await entered.promise;
  assert.equal(f.index.db, original); assert.deepEqual(publishedSnapshot(f), before);
  assert.ok(shadows(f).length > 0);
  delayed.resolve(); await operation;
  assert.equal(f.index.db, original); assert.equal(f.rows("memory_index_sources"), 2);
  assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH 'Violet'").get().n, 1);
  assert.match(f.database.db.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_index_chunks_fts'").get().sql, /trigram/);
  assert.deepEqual(f.database.db.prepare("SELECT * FROM memory_state WHERE namespace='fixture-product'").all(), productRows);
  assert.deepEqual(await state.lookup("sentinel"), { note: "Product facts must survive index replacement" });
  assert.deepEqual(shadows(f), []); assert.equal(f.rows("memory_embedding_cache"), 2);
});

test("failure at native publication commit restores all index tables and restart reuses the published cache", async t => {
  let jobs = 0;
  const f = fixture(t, { batch: async ({ chunks }) => { jobs++; return chunks.map(() => [1, 0]); } });
  f.write("MEMORY.md", "Amber observatory."); await f.index.sync();
  const before = publishedSnapshot(f), write = f.index.writePublicationMetadata;
  f.config.memory.search.store = { fts: { tokenizer: "trigram" } };
  f.write("memory/2026-10-08.md", "Violet telescope.");
  f.index.writePublicationMetadata = function (...args) { write.apply(this, args); throw new Error("fixture pre-commit failure"); };
  await assert.rejects(f.index.sync(), /fixture pre-commit failure/);
  assert.deepEqual(publishedSnapshot(f), before); assert.deepEqual(shadows(f), []);
  assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH 'Amber'").get().n, 1);
  assert.equal(f.rows("memory_embedding_cache"), 2); assert.equal(jobs, 2);
  assert.equal(f.index.embeddingFailure, null);
  await f.index.close(); f.index = new MemorySearchIndex(f.options); await f.index.sync();
  assert.equal(jobs, 2, "retry must reuse valid cache even when the shadow failed");
  assert.equal(f.rows("memory_index_sources"), 2); assert.deepEqual(shadows(f), []);
});

test("reopening a trigram publication and a failed rebuild leave its original FTS schema and rows usable", async t => {
  const f = fixture(t);
  f.config.memory.search.store = { fts: { tokenizer: "trigram" } };
  f.write("MEMORY.md", "Amber observatory."); await f.index.sync();
  const before = publishedSnapshot(f), schema = f.database.db.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_index_chunks_fts'").get().sql;
  await f.index.close(); f.index = new MemorySearchIndex(f.options); f.index.open();
  assert.deepEqual(publishedSnapshot(f), before);
  f.config.memory.search.store.fts.tokenizer = "unicode61";
  f.index.writePublicationMetadata = () => { throw new Error("fixture publication failure"); };
  await assert.rejects(f.index.sync(), /fixture publication failure/);
  assert.deepEqual(publishedSnapshot(f), before);
  assert.equal(f.database.db.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_index_chunks_fts'").get().sql, schema);
  assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH 'servatory'").get().n, 1);
  assert.deepEqual(shadows(f), []);
});

test("a changed source after the shadow closes cannot cross native final publication", async t => {
  const f = fixture(t);
  f.write("MEMORY.md", "Amber observatory."); await f.index.sync();
  const before = publishedSnapshot(f), open = f.host.openMemoryIndexShadow.bind(f.host);
  f.host.openMemoryIndexShadow = (...args) => {
    const resource = open(...args), close = resource.closeShadow; let changed = false;
    resource.closeShadow = async () => {
      await close();
      if (!changed) { changed = true; f.write("MEMORY.md", "Violet telescope."); }
    };
    return resource;
  };
  await assert.rejects(f.index.sync({ force: true }), { code: "MEMORY_SOURCE_CHANGED" });
  assert.deepEqual(publishedSnapshot(f), before); assert.deepEqual(shadows(f), []);
});

test("a competing revision invalidates full publication without undoing the newer writer", async t => {
  const entered = deferred(), delayed = deferred(); let wait = false;
  const f = fixture(t, { batch: async ({ chunks }) => { if (wait) { entered.resolve(); await delayed.promise; } return chunks.map(() => [1, 0]); } });
  f.write("MEMORY.md", "Amber observatory."); await f.index.sync();
  let shadowRuns = 0;
  const open = f.host.openMemoryIndexShadow.bind(f.host);
  f.host.openMemoryIndexShadow = (...args) => { shadowRuns++; return open(...args); };
  f.write("memory/2026-10-08.md", "Violet telescope."); wait = true;
  const operation = f.index.sync({ force: true });
  const rejected = assert.rejects(operation, { name: "MemoryIndexRevisionConflictError" });
  await entered.promise;
  f.database.db.exec("UPDATE memory_index_state SET revision=revision+1 WHERE id=1");
  const latest = publishedSnapshot(f); delayed.resolve(); await rejected;
  assert.deepEqual(publishedSnapshot(f), latest); assert.deepEqual(shadows(f), []);
  wait = false; await f.index.sync(); assert.equal(f.rows("memory_index_sources"), 2);
  assert.equal(shadowRuns, 2, "the native failed-full-rebuild state must survive the operation owner");
});

test("a substituted shadow is refused before ATTACH and cleanup never deletes its foreign replacement", async t => {
  const f = fixture(t);
  f.write("MEMORY.md", "Amber observatory."); await f.index.sync();
  const before = publishedSnapshot(f), open = f.host.openMemoryIndexShadow.bind(f.host);
  let substituted;
  f.host.openMemoryIndexShadow = (...args) => {
    const resource = open(...args), close = resource.closeShadow; let replaced = false;
    resource.closeShadow = async () => {
      await close();
      if (!replaced) {
        replaced = true; substituted = resource.shadowPath;
        fs.renameSync(substituted, `${substituted}.retained-fixture`);
        fs.writeFileSync(substituted, "foreign fixture; do not remove", { mode: 0o600 });
      }
    };
    return resource;
  };
  await assert.rejects(f.index.sync({ force: true }), /shadow.*(?:changed|identity)/i);
  assert.deepEqual(publishedSnapshot(f), before);
  assert.equal(fs.readFileSync(substituted, "utf8"), "foreign fixture; do not remove");
});

test("native metadata alone rebuilds older chunkers and protects publications from newer OpenClaw versions", async t => {
  let calls = 0;
  const f = fixture(t, { encode: async () => { calls++; return [1, 0]; } });
  f.write("MEMORY.md", "Amber observatory."); await f.index.sync();
  const current = core.readMemoryIndexMetadata(f.database.db).meta;
  const writeMeta = value => f.database.db.prepare("UPDATE memory_index_meta SET value=? WHERE key=?").run(JSON.stringify(value), core.MEMORY_INDEX_META_KEY);
  writeMeta({ ...current, chunkingVersion: current.chunkingVersion - 1 });
  await f.index.sync(); assert.deepEqual(core.readMemoryIndexMetadata(f.database.db).meta, current);
  writeMeta({ ...current, provenanceVersion: current.provenanceVersion + 1 });
  const before = publishedSnapshot(f);
  f.write("memory/2026-10-08.md", "Violet telescope.");
  await f.index.sync(); await f.index.sync({ force: true });
  assert.equal(calls, 1); assert.deepEqual(publishedSnapshot(f), before); assert.deepEqual(shadows(f), []);
});

test("configured provider loss never replaces existing semantic rows with lexical-only data", async t => {
  const f = fixture(t);
  f.write("MEMORY.md", "Amber observatory."); await f.index.sync();
  const before = publishedSnapshot(f); f.index.embedding = null;
  await assert.rejects(f.index.sync(), { code: "MEMORY_EMBEDDING_UNAVAILABLE" });
  assert.deepEqual(publishedSnapshot(f), before); assert.deepEqual(shadows(f), []);
});

test("already-keyword-only publications keep updating and searching while embeddings are unavailable", async t => {
  const f = fixture(t, { encode: async () => { throw Object.assign(new Error("fixture offline"), { code: "E5_NOT_READY" }); } });
  f.write("MEMORY.md", "Amber observatory."); await f.index.sync();
  f.write("memory/2026-10-08.md", "Violet telescope.");
  const results = await f.index.search("Violet telescope", { minScore: 0, record: false });
  assert.equal(results.length, 1); assert.match(results[0].snippet, /Violet telescope/);
  assert.equal(f.rows("memory_index_sources"), 2); assert.equal(f.rows("memory_embedding_cache"), 0);
  assert.equal(f.index.embeddingFailure, "E5_NOT_READY"); assert.deepEqual(shadows(f), []);
});

test("an in-flight semantic search keeps its published generation while a completed shadow waits", async t => {
  const entered = deferred(), delayed = deferred(), built = deferred();
  const f = fixture(t, { encode: async (_text, purpose) => {
    if (purpose === "query") { entered.resolve(); await delayed.promise; } return [1, 0];
  } });
  f.write("MEMORY.md", "Amber observatory."); await f.index.sync();
  const search = f.index.search("observatory", { minScore: 0, record: false }); await entered.promise;
  const open = f.host.openMemoryIndexShadow.bind(f.host);
  f.host.openMemoryIndexShadow = (...args) => {
    const resource = open(...args), close = resource.closeShadow;
    resource.closeShadow = async () => { await close(); built.resolve(); };
    return resource;
  };
  f.write("memory/2026-10-08.md", "Violet telescope.");
  const rebuild = f.index.sync({ force: true });
  try { await built.promise; assert.equal(f.rows("memory_index_sources"), 1); }
  finally { delayed.resolve(); }
  const results = await search; await rebuild;
  assert.equal(results.length, 1); assert.match(results[0].snippet, /Amber observatory/);
  assert.equal(f.rows("memory_index_sources"), 2); assert.equal(f.host.coordinationDatabases.size, 0);
});

test("incremental source writes wait for the native fused-read lease while native cache work can continue", async t => {
  const f = fixture(t);
  f.write("MEMORY.md", "Amber observatory."); await f.index.sync();
  const release = await f.host.run(() => core.acquireMemoryIndexReadGeneration(f.database.path, undefined, true));
  const requested = deferred(), open = f.host.openNodeSqliteDatabase.bind(f.host);
  f.host.openNodeSqliteDatabase = (...args) => { const db = open(...args); requested.resolve(); return db; };
  f.write("MEMORY.md", "Violet telescope."); let complete = false;
  const update = f.index.sync().then(() => { complete = true; });
  try {
    await requested.promise; await tick(); assert.equal(complete, false);
    assert.match(f.database.db.prepare("SELECT text FROM memory_index_chunks").get().text, /Amber/);
    assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM memory_embedding_cache WHERE hash=?").get(core.hashText("Violet telescope.")).n, 1);
  } finally { await release(); }
  await update;
  assert.match(f.database.db.prepare("SELECT text FROM memory_index_chunks").get().text, /Violet/);
  assert.equal(f.host.coordinationDatabases.size, 0);
});

test("a source edited while waiting for mutation admission cannot publish its stale rows", async t => {
  const f = fixture(t);
  f.write("MEMORY.md", "Amber observatory."); await f.index.sync();
  const release = await f.host.run(() => core.acquireMemoryIndexReadGeneration(f.database.path, undefined, true));
  const requested = deferred(), open = f.host.openNodeSqliteDatabase.bind(f.host);
  f.host.openNodeSqliteDatabase = (...args) => { const db = open(...args); requested.resolve(); return db; };
  f.write("MEMORY.md", "Violet telescope."); const update = f.index.sync();
  try { await requested.promise; f.write("MEMORY.md", "Indigo galaxy."); }
  finally { await release(); }
  await update;
  assert.match(f.database.db.prepare("SELECT text FROM memory_index_chunks").get().text, /Amber/);
  // The vector was cached while its source was current. It is reusable only
  // for that exact content hash and cannot authorize stale source publication.
  assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM memory_embedding_cache WHERE hash=?").get(core.hashText("Violet telescope.")).n, 1);
  await f.index.sync(); assert.match(f.database.db.prepare("SELECT text FROM memory_index_chunks").get().text, /Indigo/);
});

for (const provider of ["none", "shoggoth-e5"]) test(`session retrieval with ${provider} uses the native fused-read exclusion`, async t => {
  const f = fixture(t), entered = deferred(), gate = deferred();
  f.config.memory.search.provider = provider; f.config.memory.search.sources = ["sessions"];
  const content = "User: Fictional violet telescope calibration.";
  const session = { content, hash: core.hashText(content), authorityStamp: "one", size: content.length, mtimeMs: Date.now(),
    lineMap: [7], lineProvenance: [{ originClass: "owner", sessionKind: "interactive", observedAt: Date.now() }] };
  f.host.sessions.list = () => [{ id: "s1" }]; f.host.sessions.read = () => session;
  await f.index.sync();
  const keyword = f.index.keywordWorker.bind(f.index); let waiting = true;
  f.index.keywordWorker = async (...args) => { if (waiting) { waiting = false; entered.resolve(); await gate.promise; } return keyword(...args); };
  const search = f.index.search("violet telescope", { minScore: 0, record: false, sources: ["sessions"], lexicalOnly: provider !== "none" });
  await entered.promise;
  const requested = deferred(), open = f.host.openNodeSqliteDatabase.bind(f.host);
  f.host.openNodeSqliteDatabase = (...args) => { const db = open(...args); requested.resolve(); return db; };
  let mutated = false;
  const mutation = f.host.run(() => core.withMemoryIndexMutationGeneration(f.database.path, async () => { mutated = true; }));
  try { await requested.promise; await tick(); assert.equal(mutated, false); }
  finally { gate.resolve(); }
  const results = await search; await mutation;
  assert.equal(results.length, 1); assert.equal(results[0].startLine, 7); assert.equal(mutated, true);
  assert.equal(f.host.coordinationDatabases.size, 0);
});
