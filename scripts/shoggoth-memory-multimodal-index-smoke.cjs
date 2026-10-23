"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MemoryDatabase } = require("../app/agent-service/shoggoth-memory/database.cjs");
const { ShoggothMemoryHost, core } = require("../app/agent-service/shoggoth-memory/host.cjs");
const { MemorySearchIndex } = require("../app/agent-service/shoggoth-memory/search-index.cjs");
const { MemoryIndexEmbedding } = require("../app/agent-service/shoggoth-memory/index-embedding.cjs");

// Run with Node 22's built-in node:sqlite. Synthetic containers and constructor
// resources only: no Public remote provider, credentials, network or shared
// .vendor/sqlite link. Production source and provider gates stay untouched.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z5kAAAAASUVORK5CYII=", "base64");
const wav = Buffer.alloc(44);
wav.write("RIFF", 0); wav.writeUInt32LE(36, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32);
wav.writeUInt16LE(8, 34); wav.write("data", 36);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, { batch, sourceWide = false, noProvider = false, cache = true } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-memory-multimodal-index-"));
  fs.chmodSync(root, 0o700);
  const workspace = path.join(root, "one"), library = path.join(root, "library");
  fs.mkdirSync(path.join(workspace, "memory"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(library, { mode: 0o700 });
  const paths = { trustedRoot: root, stateDir: path.join(root, "state") };
  const database = new MemoryDatabase({ paths }); database.open();
  const host = new ShoggothMemoryHost({ database, paths, profileId: "one", workspaceDir: workspace,
    roster: () => [{ id: "one", workspace }], sessions: { list: () => [], read: () => null } });
  const config = { memory: { search: { provider: "shoggoth-e5", cache: { enabled: cache }, extraPaths: [library],
    multimodal: { enabled: true, modalities: ["image", "audio"] } } } };
  const index = new MemorySearchIndex({ host, databasePath: database.path, sharedDatabase: true,
    embedding: { identity: "fixture-multimodal-index-v1", encode: async () => { throw Error("The text-only E5 resource must not receive test media"); } },
    getConfig: () => config, logger: { debug() {}, warn() {} } });
  const calls = [], jobs = [];
  const f = { root, workspace, library, database, host, config, index, calls, jobs,
    inline: async inputs => inputs.map(() => [1, 0]), run: action => host.run(action),
    write(name, bytes = png) { const target = path.join(library, name); fs.writeFileSync(target, bytes, { mode: 0o600 }); return target; },
    rows: table => database.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
    source: relative => database.db.prepare("SELECT * FROM memory_index_sources WHERE path=? AND source='memory'").get(relative),
    chunks: relative => database.db.prepare("SELECT * FROM memory_index_chunks WHERE path=? AND source='memory' ORDER BY start_line").all(relative),
    async inspect(target) {
      const relative = index.sourceFiles.relative(target), snapshot = await this.run(() => index.sourceFiles.readForIndexing(relative, index.settings));
      if (snapshot?.kind === "multimodal") index.mediaSnapshots.set(relative, snapshot);
      return snapshot && { relative, kind: "memory", snapshot };
    },
    async indexPaths(targets, options) {
      const descriptors = (await Promise.all(targets.map(target => this.inspect(target)))).filter(Boolean);
      await this.indexDescriptors(descriptors, options); return descriptors;
    },
    indexDescriptors(descriptors, { signal, forceFtsOnly = false } = {}) {
      return this.run(() => this.executor.indexSources(descriptors, signal, { forceFtsOnly }));
    },
    sync: () => host.run(() => f.executor.syncSources()),
  };
  f.provider = { id: "gemini", model: "fixture-multimodal-index-v1", maxInputTokens: 8192,
    embed: async () => { throw Error("Indexing must use the batch document resource"); },
    embedBatch: async (inputs, options) => {
      calls.push({ inputs: structuredClone(inputs), inputType: options?.inputType });
      return f.inline(inputs, options);
    } };
  f.runtime = batch ? { sourceWideBatchEmbed: sourceWide, batchEmbed: async options => {
    jobs.push(structuredClone(options.chunks)); return batch(options);
  } } : undefined;
  f.refresh = async () => host.run(async () => {
    index.open();
    // Resolve only the native source-selection policy. E5's Public resolver
    // correctly rejects multimodal use. This isolated constructor fixture
    // supplies the remaining fixed index-resource settings, then injects a
    // local fake capable of structured inputs instead of weakening that gate.
    const resolved = { ...index.sourceFiles.settings(), provider: "shoggoth-e5", fallback: "none",
      model: "fixture-multimodal-index-v1", store: { driver: "sqlite", databasePath: database.path,
        fts: { tokenizer: "unicode61" }, vector: { enabled: false } },
      chunking: { tokens: 400, overlap: 80 }, cache: { enabled: cache, maxEntries: 50_000 } };
    const stamp = index.configStamp();
    index.settings = { ...index.settings, ...resolved, enabled: Boolean(resolved),
      sources: resolved.sources, searchSources: resolved.searchSources };
    await index.configureIndex(resolved, stamp);
    // Replace only this fixture's already authorized constructor resources.
    // No remote id enters public configuration or the Production resolver.
    const previous = index.embeddingExecutor;
    await previous.close(); index.embeddingExecutors.delete(previous);
    const executor = new MemoryIndexEmbedding(index, { stamp, provider: noProvider ? null : f.provider, runtime: f.runtime,
      batch: { enabled: Boolean(batch), wait: true, concurrency: 1, timeoutMinutes: 1 } });
    index.embeddingExecutor = executor; index.embeddingExecutors.add(executor); f.executor = executor;
  });
  t.after(async () => { await index.close(); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await f.refresh();
  return f;
}

test("real indexFiles embed original image/audio structured inputs and retain only untrusted one-line chunks", async t => {
  const f = await fixture(t), targets = [f.write("diagram.png"), f.write("meeting.wav", wav)], descriptors = await f.indexPaths(targets);
  assert.ok(f.executor instanceof core.MemoryManagerEmbeddingOps);
  assert.equal(f.calls.length, 2); assert.equal(f.rows("memory_embedding_cache"), 2);
  for (const descriptor of descriptors) {
    const expected = await core.buildMultimodalChunkForIndexing(descriptor.snapshot);
    const call = f.calls.find(item => item.inputs[0].text === descriptor.snapshot.contentText);
    assert.equal(call.inputType, "document"); assert.deepEqual(call.inputs, [expected.chunk.embeddingInput]);
    assert.equal(typeof call.inputs[0], "object"); assert.equal(call.inputs[0].parts[1].type, "inline-data");
    const [chunk] = f.chunks(descriptor.relative);
    assert.equal(chunk.text, descriptor.snapshot.contentText); assert.equal(chunk.start_line, 1); assert.equal(chunk.end_line, 1);
    assert.equal(f.source(descriptor.relative).hash, descriptor.snapshot.hash);
    assert.equal(f.database.db.prepare("SELECT origin_class FROM memory_index_chunk_provenance WHERE chunk_id=?").get(chunk.id).origin_class, "untrusted");
    assert.equal(f.index.isCurrent({ path: descriptor.relative, source: "memory" }), true);
  }
});

test("the Public E5 multimodal configuration gate remains in force", async t => {
  const f = await fixture(t);
  assert.throws(() => f.index.resolveSettings(), /requires a provider adapter that supports multimodal embeddings/);
  assert.equal(f.calls.length, 0); assert.equal(f.jobs.length, 0);
});

test("native media cache reuse needs no provider call after derived rows are deleted", async t => {
  const f = await fixture(t), target = f.write("diagram.png"), [descriptor] = await f.indexPaths([target]);
  await f.run(() => f.executor.publishedDatabase.deleteSource({ source: "memory", path: descriptor.relative, expectedHash: descriptor.snapshot.hash }, () => {}));
  assert.equal(f.rows("memory_index_sources"), 0); assert.equal(f.rows("memory_embedding_cache"), 1);
  await f.indexPaths([target]);
  assert.equal(f.calls.length, 1); assert.equal(f.rows("memory_index_chunks"), 1);
});

test("native source-wide batching keeps media separate and null batch results fall back to structured inline input", async t => {
  const f = await fixture(t, { sourceWide: true, batch: async () => null });
  await f.indexPaths([f.write("diagram.png"), f.write("meeting.wav", wav)]);
  assert.equal(f.jobs.length, 2); assert.ok(f.jobs.every(chunks => chunks.length === 1 && chunks[0].embeddingInput.parts[1].type === "inline-data"));
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.inputs.length === 1 && typeof call.inputs[0] === "object"));
  assert.deepEqual(f.executor.status(), { batchEnabled: true, batchFailureCount: 0 });
});

test("native FTS-only and providerless generations skip media without indexing labels", async t => {
  for (const noProvider of [false, true]) {
    const f = await fixture(t, { noProvider });
    await f.indexPaths([f.write("diagram.png"), f.write("meeting.wav", wav)], { forceFtsOnly: !noProvider });
    assert.equal(f.calls.length, 0); assert.equal(f.rows("memory_embedding_cache"), 0);
    assert.equal(f.rows("memory_index_sources"), 0); assert.equal(f.rows("memory_index_chunks"), 0);
    assert.equal(f.rows(core.MEMORY_INDEX_FTS_TABLE), 0);
  }
});

test("a null media chunk removes the previous indexed source through original conditional deletion", async t => {
  const f = await fixture(t), target = f.write("diagram.png"), descriptors = await f.indexPaths([target]);
  fs.unlinkSync(target); await f.indexDescriptors(descriptors);
  assert.equal(f.executor.dirty, true); assert.equal(f.calls.length, 1);
  assert.equal(f.rows("memory_index_sources"), 0); assert.equal(f.rows("memory_index_chunks"), 0);
  assert.equal(f.rows("memory_index_chunk_provenance"), 0); assert.equal(f.rows(core.MEMORY_INDEX_FTS_TABLE), 0);
  assert.equal(f.index.isCurrent({ path: descriptors[0].relative, source: "memory" }), false);
});

test("native source synchronization withdraws media after extraPaths revocation", async t => {
  const f = await fixture(t), targets = [f.write("diagram.png"), f.write("meeting.wav", wav)];
  await f.sync(); assert.equal(f.rows("memory_index_sources"), 2);
  f.config.memory.search.extraPaths = []; await f.refresh(); await f.sync();
  assert.equal(f.calls.length, 2); assert.equal(f.rows("memory_index_sources"), 0); assert.equal(f.rows("memory_index_chunks"), 0);
  for (const target of targets) assert.equal(f.index.isCurrent({ path: f.index.sourceFiles.relative(target), source: "memory" }), false);
});

test("native source synchronization withdraws a media file whose actual MIME changes family", async t => {
  const f = await fixture(t), target = f.write("diagram.png");
  await f.sync(); assert.equal(f.rows("memory_index_sources"), 1);
  fs.writeFileSync(target, wav); await f.sync();
  assert.equal(f.calls.length, 1); assert.equal(f.rows("memory_index_sources"), 0); assert.equal(f.rows("memory_index_chunks"), 0);
});

test("native 413 handling clears obsolete media chunks without embedding a text label fallback", async t => {
  const f = await fixture(t), target = f.write("diagram.png");
  await f.indexPaths([target]);
  f.inline = async () => { throw Object.assign(new Error("413 payload too large"), { status: 413 }); };
  const replacement = Buffer.from(png); replacement[replacement.length - 1] ^= 1; fs.writeFileSync(target, replacement);
  const [descriptor] = await f.indexPaths([target]);
  assert.equal(f.calls.length, 2); assert.equal(f.rows("memory_index_chunks"), 0); assert.equal(f.rows(core.MEMORY_INDEX_FTS_TABLE), 0);
  assert.equal(f.source(descriptor.relative).hash, descriptor.snapshot.hash); assert.equal(f.rows("memory_embedding_cache"), 1);
  assert.ok(f.calls.every(call => typeof call.inputs[0] === "object" && call.inputs[0].parts[1].type === "inline-data"));
});

test("request authority prevents a retry after the media bytes change", async t => {
  const f = await fixture(t), target = f.write("diagram.png");
  f.inline = async () => {
    const replacement = Buffer.from(png); replacement[replacement.length - 1] ^= 1; fs.writeFileSync(target, replacement);
    throw Object.assign(new Error("rate limited"), { status: 429 });
  };
  await assert.rejects(f.indexPaths([target]), { code: "MEMORY_SOURCE_CHANGED" });
  assert.equal(f.calls.length, 1); assert.equal(f.rows("memory_embedding_cache"), 0); assert.equal(f.rows("memory_index_chunks"), 0);
});

test("media changed while the provider is pending cannot enter cache or publication", async t => {
  const started = deferred(), release = deferred(), f = await fixture(t), target = f.write("diagram.png");
  f.inline = async () => { started.resolve(); return release.promise; };
  const operation = f.indexPaths([target]);
  await started.promise;
  const replacement = Buffer.from(png); replacement[replacement.length - 1] ^= 1; fs.writeFileSync(target, replacement);
  release.resolve([[1, 0]]); await operation;
  assert.equal(f.calls.length, 1); assert.equal(f.rows("memory_embedding_cache"), 0); assert.equal(f.rows("memory_index_chunks"), 0);
});

test("cache admission revalidates byte identity after upstream inspection accepted equal bytes", async t => {
  const f = await fixture(t), target = f.write("diagram.png"), resource = f.executor.publishedDatabase, original = resource.mutateEmbeddingCache.bind(resource);
  let admissions = 0;
  resource.mutateEmbeddingCache = async (...args) => {
    if (args[0].kind === "upsert" && args[0].entries.length) {
      admissions++; const replacement = f.write("replacement.png"); fs.renameSync(replacement, target);
    }
    return original(...args);
  };
  await f.indexPaths([target]);
  assert.equal(admissions, 1); assert.equal(f.rows("memory_embedding_cache"), 0); assert.equal(f.rows("memory_index_chunks"), 0);
});

test("publication revalidates media identity after waiting for its mutation admission", async t => {
  const started = deferred(), release = deferred(), f = await fixture(t), target = f.write("diagram.png"), resource = f.executor.publishedDatabase;
  const original = resource.withMutation;
  resource.withMutation = async action => { started.resolve(); await release.promise; return original(action); };
  const operation = f.indexPaths([target]); await started.promise;
  assert.equal(f.rows("memory_embedding_cache"), 1, "the cache admission preceded withdrawal and was valid");
  const replacement = f.write("replacement.png"); fs.renameSync(replacement, target);
  release.resolve(); await operation;
  assert.equal(f.calls.length, 1); assert.equal(f.rows("memory_index_sources"), 0); assert.equal(f.rows("memory_index_chunks"), 0);
});

test("cache hits and retained database rows cannot authorize withdrawn media search results", async t => {
  const f = await fixture(t), target = f.write("diagram.png"), [descriptor] = await f.indexPaths([target]);
  assert.equal(f.index.isCurrent({ path: descriptor.relative, source: "memory" }), true);
  f.index.mediaSnapshots.clear();
  assert.equal(f.index.isCurrent({ path: descriptor.relative, source: "memory" }), false, "database hash cannot recover a new MIME authority");
  await f.inspect(target); fs.chmodSync(f.library, 0o770);
  assert.equal(f.index.isCurrent({ path: descriptor.relative, source: "memory" }), false);
  assert.equal(f.calls.length, 1); assert.equal(f.rows("memory_embedding_cache"), 1);
});

test("cancellation prevents late media vectors from entering cache or publication", async t => {
  const started = deferred(), release = deferred(), controller = new AbortController(), f = await fixture(t), target = f.write("diagram.png");
  f.inline = async () => { started.resolve(); return release.promise; };
  const operation = f.indexPaths([target], { signal: controller.signal });
  const rejected = assert.rejects(operation, /fixture media cancelled/);
  await started.promise; controller.abort(new Error("fixture media cancelled")); await rejected;
  release.resolve([[1, 0]]); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.rows("memory_embedding_cache"), 0); assert.equal(f.rows("memory_index_chunks"), 0);
});
