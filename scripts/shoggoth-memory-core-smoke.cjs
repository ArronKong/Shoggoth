#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { MemoryDatabase } = require("../app/agent-service/shoggoth-memory/database.cjs");
const { ShoggothMemoryHost, core } = require("../app/agent-service/shoggoth-memory/host.cjs");
const { callHost } = require("../app/agent-service/shoggoth-memory/host-bridge.cjs");
const { MemorySearchIndex } = require("../app/agent-service/shoggoth-memory/search-index.cjs");
const { ShoggothMemoryMigration, sha256 } = require("../app/agent-service/shoggoth-memory/migration.cjs");
const { FileMemoryStore } = require("../app/agent-service/shoggoth-memory/file-store.cjs");

test("upstream session forgetting commits a tombstone, scrubs corpus and is restartable", async t => {
  const f = fixture(t), host = f.host("one");
  host.sessions.list = () => [{ id: "s1", sessionKey: "chat-one", interactive: true, updatedAt: f.now() }];
  const library = path.join(f.root, "library", "memory"); fs.mkdirSync(library, { recursive: true, mode: 0o700 });
  const reference = path.join(library, "2026-10-07.md");
  const original = "[one/sessions/one/s1#L1] User: The old telescope is stored in the western observatory.\n";
  fs.writeFileSync(reference, original, { mode: 0o600 });
  const cfg = { memory: { search: { provider: "none", extraPaths: [library] } } };
  const index = new MemorySearchIndex({ host, databasePath: f.database.path, sharedDatabase: true, getConfig: () => cfg }); index.open();
  const dir = path.join(host.workspaceDir, "memory/.dreams/session-corpus"); fs.mkdirSync(dir, { recursive: true });
  const corpus = path.join(dir, "2026-10-07.md");
  fs.writeFileSync(corpus, original, { mode: 0o600 });
  const result = await host.run(() => core.forgetMemoryEntries({ cfg, agentId: "one", sessionIds: ["s1"] }));
  assert.deepEqual(result.sessionIds, ["s1"]);
  assert.equal(f.database.tombstones("one", ["s1"]).length, 1);
  assert.ok(!fs.existsSync(corpus) || !fs.readFileSync(corpus, "utf8").includes("telescope"));
  const again = await host.run(() => core.forgetMemoryEntries({ cfg, agentId: "one", sessionIds: ["s1"] }));
  assert.deepEqual(again.sessionIds, ["s1"]);
  assert.equal(fs.readFileSync(reference, "utf8"), original, "forgetting cannot rewrite an external library");
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-memory-core-fixture-"));
  fs.chmodSync(root, 0o700);
  const paths = { trustedRoot: root, stateDir: path.join(root, "state") };
  let now = Date.parse("2026-10-07T04:00:00Z");
  const database = new MemoryDatabase({ paths, now: () => now }); database.open();
  const roster = ["one", "two"].map(id => ({ id, workspace: path.join(root, id) }));
  for (const profile of roster) fs.mkdirSync(path.join(profile.workspace, "memory"), { recursive: true, mode: 0o700 });
  const sessions = { list: () => [], read: () => null, stat: () => null, metadata: () => null };
  const host = id => new ShoggothMemoryHost({ database, paths, profileId: id, workspaceDir: roster.find(profile => profile.id === id).workspace, roster: () => roster, sessions });
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, paths, database, roster, host, now: () => now, setNow: value => { now = value; } };
}

test("pinned source integrity", () => {
  const directory = path.resolve(__dirname, "../build/shoggoth-memory");
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.revision, "c10679395819ede78bb073f979f95c157e165bfa");
  for (const entry of manifest.files) {
    const content = fs.readFileSync(path.join(directory, entry.kind === "upstream" ? "source" : "dependencies", entry.path));
    assert.equal(crypto.createHash("sha256").update(content).digest("hex"), entry.sha256, entry.path);
  }
});

test("upstream flush threshold uses fresh projections and one attempt per compaction cycle", () => {
  const plan = core.buildMemoryFlushPlan({ contextWindowTokens: 128000 });
  const threshold = core.resolveCompactionThreshold({ contextWindowTokens: 128000, reserveTokensFloor: plan.reserveTokensFloor }) - plan.softThresholdTokens;
  assert.equal(threshold, 104000);
  const entry = { compactionCount: 3 };
  assert.equal(core.resolveEffectivePromptTokens(100000, 3000, 1000), threshold);
  assert.equal(core.shouldRunMemoryFlush({ entry, tokenCount: threshold - 1, threshold }), false);
  assert.equal(core.shouldRunMemoryFlush({ entry, tokenCount: threshold, threshold }), true);
  assert.equal(core.shouldRunMemoryFlush({ entry: { ...entry, memoryFlush: { compactionCount: 3 } }, tokenCount: threshold, threshold }), false);
  assert.equal(core.shouldRunMemoryFlush({ entry: { ...entry, memoryFlush: { compactionCount: 2 } }, tokenCount: threshold, threshold }), true);
  assert.equal(core.shouldRunMemoryFlush({ entry: { ...entry, totalTokens: 120000, totalTokensFresh: false, totalTokensVersion: 1 }, threshold }), false);
});

test("session chunks keep original noncontiguous Product sequences and rebuild when only lineage changes", async t => {
  const f = fixture(t), host = f.host("one");
  let lineMap = [7, 42];
  const source = () => {
    const content = "User: Amber telescope calibration occurs every evening.\nAssistant: The observatory schedule is confirmed.";
    const lineProvenance = [{ originClass: "owner", sessionKind: "interactive", observedAt: f.now() },
      { originClass: "agent", sessionKind: "interactive", observedAt: f.now() }];
    const value = { content, lineMap, messageTimestampsMs: [f.now(), f.now()], lineProvenance, resetRecallCutoff: null };
    return { ...value, hash: core.hashSessionEntrySnapshot(value), mtimeMs: f.now(), size: Buffer.byteLength(content) };
  };
  host.sessions.list = () => [{ id: "session-one" }]; host.sessions.read = () => source();
  const index = new MemorySearchIndex({ host, databasePath: f.database.path, sharedDatabase: true,
    getConfig: () => ({ memory: { search: { sources: ["sessions"] } } }) });
  const first = await index.search("amber telescope", { minScore: 0, record: false });
  assert.equal(first.length, 1); assert.equal(first[0].startLine, 7); assert.equal(first[0].endLine, 42);
  assert.equal(first[0].citation, "sessions/one/session-one.jsonl#L7-L42");
  assert.equal(index.db.prepare("SELECT origin_class FROM memory_index_chunk_provenance").get().origin_class, "agent");
  lineMap = [9, 44];
  assert.equal(index.isCurrent(first[0]), false);
  const next = await index.search("amber telescope", { minScore: 0, record: false });
  assert.equal(next[0].citation, "sessions/one/session-one.jsonl#L9-L44");
  assert.throws(() => index.sessionIdForPath("sessions/two/session-one.jsonl"), /Foreign/);
  assert.throws(() => index.sessionIdForPath("sessions/one/../secret.jsonl"), /Invalid/);
});

test("keyed state persists, isolates namespaces, enforces TTL and rejects stale CAS", async t => {
  const f = fixture(t), a = f.database.openKeyedStore({ namespace: "a", maxEntries: 2 });
  const first = await a.observe("key");
  assert.equal((await a.compareAndApply("key", first.comparison, { operation: "update", action: "set", value: { owner: 1 } })).status, "applied");
  assert.equal((await a.compareAndApply("key", first.comparison, { operation: "delete", action: "delete" })).status, "conflict");
  assert.equal(await f.database.openKeyedStore({ namespace: "b", maxEntries: 2 }).lookup("key"), undefined);
  f.database.close(); f.database.open();
  assert.deepEqual(await a.lookup("key"), { owner: 1 });
  await a.register("temporary", "value", { ttlMs: 10 });
  f.setNow(f.now() + 11);
  assert.equal(await a.lookup("temporary"), undefined);
  const observed = await a.observe("temporary");
  await a.register("temporary", "new");
  await a.delete("temporary");
  assert.equal((await a.compareAndApply("temporary", observed.comparison, { operation: "update", action: "set", value: "stale" })).status, "conflict");
});

test("two database connections cannot claim the same upstream lock observation", async t => {
  const f = fixture(t), other = new MemoryDatabase({ paths: f.paths }); other.open(); t.after(() => other.close());
  const a = f.database.openKeyedStore({ namespace: "lock", maxEntries: 2 });
  const b = other.openKeyedStore({ namespace: "lock", maxEntries: 2 });
  const observed = await b.observe("workspace");
  await a.register("workspace", { owner: "first" });
  const result = await b.compareAndApply("workspace", observed.comparison, { operation: "update", action: "set", value: { owner: "second" } });
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.current.value, { owner: "first" });
});

test("state mutation rolls back when authority changes before commit", async t => {
  const f = fixture(t); let checks = 0;
  const store = f.database.openKeyedStore({ namespace: "authority", maxEntries: 2 }, () => { if (++checks === 3) throw new Error("revoked"); });
  await assert.rejects(store.register("key", "value"), /revoked/);
  assert.equal(await f.database.openKeyedStore({ namespace: "authority", maxEntries: 2 }).lookup("key"), undefined);
});

test("upstream workspace locks serialize concurrent writes and permit intentional nesting", async t => {
  const f = fixture(t), host = f.host("one"), order = [];
  await Promise.all([1, 2, 3].map(value => host.run(() => core.withMemoryWorkspaceLock(host.workspaceDir, async () => {
    order.push(`begin${value}`);
    await core.withMemoryWorkspaceLock(host.workspaceDir, async () => { await new Promise(resolve => setTimeout(resolve, 4)); });
    order.push(`end${value}`);
  }))));
  assert.deepEqual(order, ["begin1", "end1", "begin2", "end2", "begin3", "end3"]);
  const entries = await f.database.openKeyedStore({ namespace: core.SHORT_TERM_LOCK_NAMESPACE, maxEntries: 4096 }).entries();
  assert.equal(entries.length, 0);
});

test("async host scopes cannot borrow another Profile or leak outside the request", async t => {
  const f = fixture(t), one = f.host("one"), two = f.host("two");
  const values = await Promise.all([one, two].map(host => host.run(async () => {
    await new Promise(resolve => setTimeout(resolve, 2));
    assert.throws(() => host.assertAgent(host.profileId === "one" ? "two" : "one"), /outside/);
    return callHost("resolveDefaultAgentId");
  })));
  assert.deepEqual(values, ["one", "two"]);
  assert.throws(() => callHost("resolveStateDir"), { code: "MEMORY_HOST_SCOPE_REQUIRED" });
});

test("upstream Dreaming ingests daily files, uses durable state, and survives restart", async t => {
  const f = fixture(t), host = f.host("one");
  fs.writeFileSync(path.join(host.workspaceDir, "memory/2026-10-07.md"), "# Notes\n- The user prefers Chinese explanations with concrete source evidence.\n", { mode: 0o600 });
  const config = { agentId: "one", workspaceDir: host.workspaceDir, cfg: { agents: { list: [{ id: "one", workspace: host.workspaceDir }] } }, logger: { info() {}, warn() {}, error() {} }, nowMs: f.now() };
  const outcome = await host.run(() => core.runDreamingSweepPhases(config));
  assert.deepEqual(outcome, { degradedPhases: 0, pendingNarratives: 0 });
  const before = await host.run(() => core.readShortTermRecallEntries({ workspaceDir: host.workspaceDir, nowMs: f.now() }));
  assert.ok(before.length > 0);
  f.database.close(); f.database.open();
  const after = await host.run(() => core.readShortTermRecallEntries({ workspaceDir: host.workspaceDir, nowMs: f.now() }));
  assert.deepEqual(after, before);
  await host.run(() => core.runDreamingSweepPhases(config));
  assert.deepEqual(await host.run(() => core.readShortTermRecallEntries({ workspaceDir: host.workspaceDir, nowMs: f.now() })), after);
});

test("upstream rejects untrusted promotion and applies eligible grounded file content", async t => {
  const f = fixture(t), host = f.host("one");
  const relative = "memory/2026-10-07.md";
  const snippet = "The user prefers source citations and complete validation before shipping software.";
  fs.writeFileSync(path.join(host.workspaceDir, relative), snippet + "\n", { mode: 0o600 });
  const result = { path: relative, startLine: 1, endLine: 1, snippet, score: 0.98, source: "memory", provenance: { originClass: "owner", sessionKind: "interactive", observedAt: f.now() } };
  for (const query of ["validation policy", "software delivery", "citation preference"]) {
    await host.run(() => core.recordShortTermRecalls({ workspaceDir: host.workspaceDir, query, results: [result], nowMs: f.now() }));
  }
  const options = { workspaceDir: host.workspaceDir, minScore: 0, minRecallCount: 3, minUniqueQueries: 3, nowMs: f.now() };
  const candidates = await host.run(() => core.rankShortTermPromotionCandidates(options));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].uniqueQueries, 3);
  const applied = await host.run(() => core.applyShortTermPromotions({ ...options, agentId: "one", candidates }));
  assert.equal(applied.applied, 1);
  assert.match(fs.readFileSync(path.join(host.workspaceDir, "MEMORY.md"), "utf8"), /complete validation/);
  const repeated = await host.run(() => core.rankShortTermPromotionCandidates(options));
  assert.equal(repeated.length, 0);
  const other = f.host("two");
  fs.writeFileSync(path.join(other.workspaceDir, relative), snippet + "\n", { mode: 0o600 });
  await other.run(() => core.recordShortTermRecalls({ workspaceDir: other.workspaceDir, query: "untrusted", results: [{ ...result, provenance: { ...result.provenance, originClass: "untrusted" } }], nowMs: f.now() }));
  assert.deepEqual(await other.run(() => core.rankShortTermPromotionCandidates({ ...options, workspaceDir: other.workspaceDir, minRecallCount: 0, minUniqueQueries: 0 })), []);
});

test("upstream source revalidation refuses edited content before promotion", async t => {
  const f = fixture(t), host = f.host("one"), relative = "memory/2026-10-07.md";
  const snippet = "A durable engineering preference uses source evidence before shipping.";
  fs.writeFileSync(path.join(host.workspaceDir, relative), snippet + "\n", { mode: 0o600 });
  await host.run(() => core.recordShortTermRecalls({ workspaceDir: host.workspaceDir, query: "engineering", results: [{ path: relative, startLine: 1, endLine: 1, snippet, score: 1, source: "memory" }], nowMs: f.now() }));
  const options = { workspaceDir: host.workspaceDir, minScore: 0, minRecallCount: 0, minUniqueQueries: 0, nowMs: f.now() };
  const candidates = await host.run(() => core.rankShortTermPromotionCandidates(options));
  assert.equal(candidates.length, 1);
  fs.writeFileSync(path.join(host.workspaceDir, relative), "The old fact has been removed.\n", { mode: 0o600 });
  const result = await host.run(() => core.applyShortTermPromotions({ ...options, candidates }));
  assert.equal(result.applied, 0);
  assert.equal(fs.existsSync(path.join(host.workspaceDir, "MEMORY.md")), false);
});

test("real SQLite FTS refreshes file edits/deletions and ranks exact paths", async t => {
  const f = fixture(t), host = f.host("one");
  const index = new MemorySearchIndex({ host, databasePath: path.join(f.paths.stateDir, "one-index.sqlite") });
  t.after(() => index.close());
  fs.writeFileSync(path.join(host.workspaceDir, "MEMORY.md"), "# Memory\n- The user prefers Chinese technical explanations.\n", { mode: 0o600 });
  const daily = path.join(host.workspaceDir, "memory/2026-10-07.md");
  fs.writeFileSync(daily, "# Daily\n- The project release uses a reviewed source commit and SHA256 artifact checksum.\n", { mode: 0o600 });
  const results = await index.search("Chinese technical explanations");
  assert.ok(results.some(result => result.path === "MEMORY.md"));
  assert.equal((await index.search("MEMORY.md"))[0].path, "MEMORY.md");
  assert.ok((await index.search("artifact checksum")).some(result => result.path.startsWith("memory/")));
  fs.writeFileSync(daily, "# Daily\n- The source fact has changed completely.\n", { mode: 0o600 });
  assert.deepEqual(await index.search("artifact checksum"), []);
  fs.unlinkSync(daily);
  assert.deepEqual(await index.search("source fact changed"), []);
});

test("upstream hybrid search uses vectors, limits results, and excludes revoked sources", async t => {
  const f = fixture(t), host = f.host("one"); let allowed = true;
  fs.writeFileSync(path.join(host.workspaceDir, "MEMORY.md"), "# Memory\n- The user lives in Hangzhou and prefers Chinese explanations.\n- A telescope helps observe distant galaxies.\n", { mode: 0o600 });
  const embedding = { identity: "fixture-2d", encode: async text => /Hangzhou|中文/.test(text) ? [1, 0] : [0, 1] };
  const index = new MemorySearchIndex({ host, databasePath: path.join(f.paths.stateDir, "vector-index.sqlite"), embedding, allow: () => allowed });
  t.after(() => index.close());
  const results = await index.search("中文", { maxResults: 1 });
  assert.equal(results.length, 1);
  assert.match(results[0].snippet, /Hangzhou/);
  assert.ok(results[0].score >= 0.35);
  allowed = false;
  assert.deepEqual(await index.search("中文"), []);
});

test("tokenizer changes rebuild both derived FTS tables without changing files or source citations", async t => {
  const f = fixture(t), host = f.host("one"), config = { memory: { search: { provider: "none" } } };
  const file = path.join(host.workspaceDir, "MEMORY.md"), content = "# Memory\n杭州天文台观测记录每天整理。\n";
  fs.writeFileSync(file, content, { mode: 0o600 });
  let index = new MemorySearchIndex({ host, databasePath: path.join(f.paths.stateDir, "fts-settings.sqlite"), getConfig: () => config });
  t.after(() => index.close());
  await index.sync();
  const rows = index.db.prepare("SELECT id,path,start_line,end_line FROM memory_index_chunks").all();
  config.memory.search.store = { fts: { tokenizer: "trigram" } };
  const found = await index.search("天文台", { minScore: 0, record: false });
  assert.ok(found.some(row => row.path === "MEMORY.md"));
  assert.deepEqual(index.db.prepare("SELECT id,path,start_line,end_line FROM memory_index_chunks").all(), rows);
  for (const name of ["memory_index_chunks_fts", "memory_index_paths_fts"]) {
    assert.match(index.db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name).sql, /trigram case_sensitive 0/);
  }
  await index.close();
  index = new MemorySearchIndex({ host, databasePath: path.join(f.paths.stateDir, "fts-settings.sqlite"), getConfig: () => config });
  assert.ok((await index.search("天文台", { minScore: 0, record: false })).length);
  config.memory.search.store.fts.tokenizer = "unicode61";
  await index.sync();
  assert.match(index.db.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_index_chunks_fts'").get().sql, /unicode61/);
  assert.equal(fs.readFileSync(file, "utf8"), content);
});

test("provider none and per-Profile override disable embeddings while preserving keyword search", async t => {
  const f = fixture(t), host = f.host("one"); let calls = 0;
  fs.writeFileSync(path.join(host.workspaceDir, "MEMORY.md"), "The amber telescope belongs to the observatory.\n", { mode: 0o600 });
  const config = { memory: { search: { provider: "shoggoth-e5" } }, agents: { entries: { one: { memory: { search: { provider: "none" } } } } } };
  const index = new MemorySearchIndex({ host, databasePath: f.database.path, sharedDatabase: true, getConfig: () => config,
    embedding: { identity: "provider-fixture", encode: async () => { calls++; return [1, 0]; } } });
  assert.ok((await index.search("amber telescope", { minScore: 0, record: false })).length);
  assert.equal(calls, 0); assert.equal(index.model, "fts-only");
  assert.equal(index.db.prepare("SELECT max(length(embedding)) AS bytes FROM memory_index_chunks").get().bytes, 0);
  delete config.agents.entries.one.memory.search.provider;
  assert.ok((await index.search("semantic query", { minScore: 0, record: false })).length);
  assert.ok(calls >= 2); assert.equal(index.model, "provider-fixture");
  config.memory.search.provider = "none";
  const before = calls;
  assert.ok((await index.search("amber telescope", { minScore: 0, record: false })).length);
  assert.equal(calls, before);
  assert.equal(index.db.prepare("SELECT max(length(embedding)) AS bytes FROM memory_index_chunks").get().bytes, 0);
});

test("native trigger lexical lookup skips query embeddings while normal search still uses them", async t => {
  const f = fixture(t), host = f.host("one"), calls = [];
  fs.writeFileSync(path.join(host.workspaceDir, "MEMORY.md"), "Amber telescope calibration happens every evening.\n", { mode: 0o600 });
  const index = new MemorySearchIndex({ host, databasePath: f.database.path, sharedDatabase: true,
    embedding: { identity: "lexical-query-fixture", encode: async (_text, purpose) => { calls.push(purpose); return [1, 0]; } } });
  await index.sync(); const indexed = calls.length;
  assert.ok((await index.search("amber telescope", { lexicalOnly: true, minScore: 0, record: false })).length);
  assert.equal(calls.length, indexed, "trigger lookup must not encode its query");
  assert.ok((await index.search("amber telescope", { minScore: 0, record: false })).length);
  assert.equal(calls.length, indexed + 1); assert.equal(calls.at(-1), "query");
});

test("cache policy controls reads and writes, and malformed persisted dimensions regenerate safely", async t => {
  const f = fixture(t), host = f.host("one"), file = path.join(host.workspaceDir, "MEMORY.md");
  const content = "Amber telescope calibration happens every evening."; let calls = 0;
  fs.writeFileSync(file, content, { mode: 0o600 });
  const config = { memory: { search: { cache: { enabled: true } } } };
  const index = new MemorySearchIndex({ host, databasePath: f.database.path, sharedDatabase: true, getConfig: () => config,
    embedding: { identity: "cache-fixture", encode: async () => { calls++; return [1, 0]; } } });
  await index.sync(); assert.equal(calls, 1);
  // Simulate loss of rebuildable index rows while the independent cache survives.
  const rebuild = async () => { index.db.exec("DELETE FROM memory_index_chunks; DELETE FROM memory_index_sources"); await index.sync(); };
  const cache = index.db.prepare("SELECT * FROM memory_embedding_cache").all(); assert.equal(cache.length, 1);
  await rebuild(); assert.equal(calls, 1);
  config.memory.search.cache.enabled = false;
  await rebuild(); assert.equal(calls, 2);
  assert.deepEqual(index.db.prepare("SELECT * FROM memory_embedding_cache").all(), cache);
  config.memory.search.cache.enabled = true;
  index.db.exec("UPDATE memory_embedding_cache SET dims=9223372036854775807");
  await rebuild(); assert.equal(calls, 3);
  assert.equal(index.db.prepare("SELECT dims FROM memory_embedding_cache").get().dims, 2);
  const corrupt = Buffer.alloc(16); corrupt.writeDoubleLE(NaN, 0); corrupt.writeDoubleLE(Infinity, 8);
  index.db.prepare("UPDATE memory_embedding_cache SET embedding=?").run(corrupt);
  await rebuild(); assert.equal(calls, 4);
  assert.deepEqual(core.decodeMemoryEmbedding(index.db.prepare("SELECT embedding FROM memory_embedding_cache").get().embedding), [1, 0]);
  config.memory.search.cache.enabled = false;
  index.db.exec("DELETE FROM memory_embedding_cache");
  await rebuild();
  assert.equal(index.db.prepare("SELECT count(*) AS n FROM memory_embedding_cache").get().n, 0);
});

test("model identity changes reindex unchanged text and never mix cached vector spaces", async t => {
  const f = fixture(t), host = f.host("one"), file = path.join(host.workspaceDir, "MEMORY.md");
  fs.writeFileSync(file, "Amber telescope calibration schedule.", { mode: 0o600 });
  let calls = 0;
  const embedding = { identity: "model-v1", encode: async () => { calls++; return embedding.identity === "model-v1" ? [1, 0] : [0, 1]; } };
  const index = new MemorySearchIndex({ host, databasePath: f.database.path, sharedDatabase: true, embedding });
  await index.sync(); const first = index.db.prepare("SELECT id,hash FROM memory_index_chunks").get();
  embedding.identity = "model-v2"; await index.sync();
  const second = index.db.prepare("SELECT id,hash,model,embedding FROM memory_index_chunks").get();
  assert.equal(first.hash, second.hash); assert.notEqual(first.id, second.id); assert.equal(calls, 2);
  assert.equal(second.model, "model-v2"); assert.deepEqual(core.decodeMemoryEmbedding(second.embedding), [0, 1]);
  assert.equal(index.db.prepare("SELECT count(DISTINCT provider_key) AS n FROM memory_embedding_cache").get().n, 2);
  embedding.identity = "model-v1"; await index.sync(); assert.equal(calls, 2);
  assert.deepEqual(core.decodeMemoryEmbedding(index.db.prepare("SELECT embedding FROM memory_index_chunks").get().embedding), [1, 0]);
});

test("invalid provider vectors fall back to lexical results and never poison reusable cache", async t => {
  const f = fixture(t), host = f.host("one");
  fs.writeFileSync(path.join(host.workspaceDir, "MEMORY.md"), "Amber telescope observations.", { mode: 0o600 });
  const index = new MemorySearchIndex({ host, databasePath: f.database.path, sharedDatabase: true,
    embedding: { identity: "invalid-fixture", encode: async () => [NaN, Infinity] } });
  const found = await index.search("amber telescope", { minScore: 0, record: false });
  assert.ok(found.length); assert.equal(index.embeddingFailure, "MEMORY_EMBEDDING_INVALID");
  assert.equal(index.db.prepare("SELECT count(*) AS n FROM memory_embedding_cache").get().n, 0);
  assert.equal(index.db.prepare("SELECT length(embedding) AS n FROM memory_index_chunks").get().n, 0);
  index.embedding.encode = async () => [1, 0]; await index.sync();
  fs.writeFileSync(path.join(host.workspaceDir, "memory/2026-10-07.md"), "Amber telescope location has changed.", { mode: 0o600 });
  index.embedding.encode = async () => [1, 0, 0];
  const fallback = await index.search("amber telescope", { minScore: 0, record: false });
  assert.ok(fallback.length); assert.equal(index.embeddingFailure, "MEMORY_EMBEDDING_INVALID");
  assert.equal(index.db.prepare("SELECT count(*) AS n FROM memory_embedding_cache").get().n, 0);
  assert.equal(index.db.prepare("SELECT count(*) AS n FROM memory_index_chunks WHERE length(embedding)=24").get().n, 0);
});

test("extraPaths use upstream directory patterns, explicit files and additive Profile settings", async t => {
  const f = fixture(t), host = f.host("one"), library = path.join(f.root, "library");
  fs.mkdirSync(path.join(library, "reference"), { recursive: true, mode: 0o700 });
  const allowed = path.join(library, "reference", "guide.md"), privateFile = path.join(library, "private.md"), explicit = path.join(library, "standalone.md");
  fs.writeFileSync(allowed, "# Library\nViolet nebula reference catalogue.", { mode: 0o600 });
  fs.writeFileSync(privateFile, "Private violet notebook outside the selected pattern.", { mode: 0o600 });
  fs.writeFileSync(explicit, "Standalone violet catalogue.", { mode: 0o600 });
  fs.writeFileSync(path.join(library, "reference", "ignored.txt"), "Violet non-Markdown document.", { mode: 0o600 });
  const config = { memory: { search: { provider: "none", extraPaths: [{ path: library, pattern: "reference/**/*.md" }] } },
    agents: { entries: { one: { memory: { search: { extraPaths: [explicit] } } } } } };
  const index = new MemorySearchIndex({ host, databasePath: f.database.path, sharedDatabase: true, getConfig: () => config });
  assert.equal(index.readSource(index.sourceFiles.relative(allowed)).text, fs.readFileSync(allowed, "utf8"), "explicit reads do not require a preceding search");
  const results = await index.search("violet", { minScore: 0, record: false });
  assert.deepEqual(results.map(row => row.path).sort(), [allowed, explicit].map(file => index.sourceFiles.relative(file)).sort());
  assert.throws(() => index.readSource(index.sourceFiles.relative(privateFile)), { code: "MEMORY_PATH_NOT_ALLOWED" });
  config.memory.search.extraPaths = []; config.agents.entries.one.memory.search.extraPaths = [];
  assert.equal(index.isCurrent(results[0]), false);
  assert.throws(() => index.readSource(index.sourceFiles.relative(allowed)), { code: "MEMORY_PATH_NOT_ALLOWED" });
  assert.deepEqual(await index.search("violet", { minScore: 0, record: false }), []);
  assert.equal(index.db.prepare("SELECT count(*) AS n FROM memory_index_sources").get().n, 0);
  assert.match(fs.readFileSync(allowed, "utf8"), /Violet nebula/);
});

test("external libraries cannot widen into another Profile or private Service data", async t => {
  const f = fixture(t), host = f.host("one"), otherFile = path.join(f.roster[1].workspace, "MEMORY.md"), stateFile = path.join(f.paths.stateDir, "secret.md");
  fs.writeFileSync(otherFile, "Foreign violet memory must remain private.", { mode: 0o600 });
  fs.writeFileSync(stateFile, "Private Service violet document.", { mode: 0o600 });
  const config = { memory: { search: { provider: "none", extraPaths: [otherFile, stateFile, { path: f.root, pattern: "**/*.md" }] } } };
  const index = new MemorySearchIndex({ host, databasePath: f.database.path, sharedDatabase: true, getConfig: () => config });
  assert.deepEqual(await index.search("violet", { minScore: 0, record: false }), []);
  for (const file of [otherFile, stateFile]) assert.throws(() => index.readSource(index.sourceFiles.relative(file)), { code: "MEMORY_PATH_NOT_ALLOWED" });
});

test("external file reads reject symlink roots, parent replacement, hardlinks and writable sources", async t => {
  const f = fixture(t), host = f.host("one"), library = path.join(f.root, "library"), other = path.join(f.root, "other");
  fs.mkdirSync(library, { mode: 0o700 }); fs.mkdirSync(other, { mode: 0o700 });
  const original = path.join(other, "source.md"); fs.writeFileSync(original, "Hidden astronomy source.", { mode: 0o600 });
  const alias = path.join(f.root, "alias"); fs.symlinkSync(other, alias);
  const config = { memory: { search: { provider: "none", extraPaths: [library, alias] } } };
  const index = new MemorySearchIndex({ host, databasePath: f.database.path, sharedDatabase: true, getConfig: () => config });
  const read = file => index.readSource(index.sourceFiles.relative(file));
  assert.throws(() => read(path.join(alias, "source.md")), { code: "MEMORY_PATH_NOT_ALLOWED" });
  fs.symlinkSync(other, path.join(library, "linked"));
  assert.throws(() => read(path.join(library, "linked", "source.md")), { code: "MEMORY_PATH_NOT_ALLOWED" });
  const hardlink = path.join(library, "hardlink.md"); fs.linkSync(original, hardlink);
  assert.throws(() => read(hardlink), { code: "MEMORY_PATH_NOT_ALLOWED" }); fs.unlinkSync(hardlink);
  const unsafe = path.join(library, "unsafe.md"); fs.writeFileSync(unsafe, "Untrusted writable source.", { mode: 0o600 }); fs.chmodSync(unsafe, 0o666);
  assert.throws(() => read(unsafe), { code: "MEMORY_PATH_NOT_ALLOWED" }); fs.chmodSync(unsafe, 0o600);
  assert.match(read(unsafe).text, /Untrusted/);
  for (const value of [original, "../library/./unsafe.md", "../library\\unsafe.md", "../library/unsafe.md\0"])
    assert.throws(() => index.readSource(value), { code: "MEMORY_PATH_NOT_ALLOWED" });
});

test("removing an extra path during embedding prevents publication and leaves the original file intact", async t => {
  const f = fixture(t), host = f.host("one"), file = path.join(f.root, "reference.md");
  fs.writeFileSync(file, "Violet nebula reference.", { mode: 0o600 });
  const config = { memory: { search: { extraPaths: [file] } } }; let entered, release;
  const arrived = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { release = resolve; });
  const index = new MemorySearchIndex({ host, databasePath: f.database.path, sharedDatabase: true, getConfig: () => config,
    embedding: { identity: "extra-path-race", encode: async () => { entered(); await wait; return [1, 0]; } } });
  const rejected = assert.rejects(index.search("violet", { minScore: 0, record: false }), { code: "MEMORY_CONFIG_CHANGED" });
  await arrived; config.memory.search.extraPaths = []; release(); await rejected;
  assert.equal(index.db.prepare("SELECT count(*) AS n FROM memory_index_sources").get().n, 0);
  assert.equal(index.db.prepare("SELECT count(*) AS n FROM memory_embedding_cache").get().n, 0);
  assert.equal(fs.readFileSync(file, "utf8"), "Violet nebula reference.");
});

test("native external-library provenance allows recall without automatic promotion", async t => {
  const f = fixture(t), host = f.host("one"), directory = path.join(f.root, "library", "memory");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "2026-10-07.md"), text = "Violet nebula observatory reference catalogue.";
  fs.writeFileSync(file, text, { mode: 0o600 });
  const index = new MemorySearchIndex({ host, databasePath: f.database.path, sharedDatabase: true,
    getConfig: () => ({ memory: { search: { provider: "none", extraPaths: [directory] } } }) });
  for (const query of ["violet nebula", "observatory reference", "reference catalogue"]) {
    const results = await index.search(query, { minScore: 0 });
    assert.ok(results.length); assert.ok(results.every(result => result.provenance.originClass === "untrusted"));
  }
  const options = { workspaceDir: host.workspaceDir, minScore: 0, minRecallCount: 3, minUniqueQueries: 3, nowMs: f.now() };
  await host.runWithSourceEvidence(async () => {
    await host.pruneUnavailableLibraryCandidates();
    const candidates = await core.rankShortTermPromotionCandidates(options);
    assert.deepEqual(candidates, []);
    assert.equal((await core.applyShortTermPromotions({ ...options, candidates, agentId: "one" })).applied, 0);
  });
  assert.equal(fs.existsSync(path.join(host.workspaceDir, "MEMORY.md")), false);
  assert.equal(fs.readFileSync(file, "utf8"), text);
  assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM memory_promotion_sources").get().n, 0);
});

test("revoked or replaced library candidates cannot borrow a canonical daily namesake", async t => {
  const f = fixture(t), host = f.host("one"), directory = path.join(f.root, "library", "memory");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "2026-10-07.md"), text = "Violet observatory calibration uses the northern telescope.";
  fs.writeFileSync(file, text, { mode: 0o600 });
  const config = { memory: { search: { provider: "none", extraPaths: [directory] } } };
  const index = new MemorySearchIndex({ host, databasePath: f.database.path, sharedDatabase: true, getConfig: () => config });
  const options = { workspaceDir: host.workspaceDir, minScore: 0, minRecallCount: 1, minUniqueQueries: 1, nowMs: f.now() };
  await index.search("violet observatory", { minScore: 0, record: false });
  // Simulate an already-persisted candidate from the older host's classification.
  // A migration must still withdraw it instead of borrowing a canonical namesake.
  await host.run(() => core.recordShortTermRecalls({ workspaceDir: host.workspaceDir, query: "violet observatory",
    results: [{ path: index.sourceFiles.relative(file), startLine: 1, endLine: 1, snippet: text, score: 1, source: "memory" }], nowMs: f.now() }));
  assert.equal((await host.run(() => core.rankShortTermPromotionCandidates(options))).length, 1);
  fs.writeFileSync(path.join(host.workspaceDir, "memory/2026-10-07.md"), text, { mode: 0o600 });
  fs.writeFileSync(file, "The old external fact is withdrawn.", { mode: 0o600 });
  await host.runWithSourceEvidence(() => host.pruneUnavailableLibraryCandidates());
  assert.deepEqual(await host.run(() => core.rankShortTermPromotionCandidates(options)), []);
  fs.writeFileSync(file, text, { mode: 0o600 });
  await host.run(() => core.recordShortTermRecalls({ workspaceDir: host.workspaceDir, query: "northern telescope",
    results: [{ path: index.sourceFiles.relative(file), startLine: 1, endLine: 1, snippet: text, score: 1, source: "memory" }], nowMs: f.now() }));
  config.memory.search.extraPaths = [];
  await host.pruneUnavailableLibraryCandidates();
  assert.deepEqual(await host.run(() => core.rankShortTermPromotionCandidates(options)), []);
  assert.equal(fs.existsSync(path.join(host.workspaceDir, "MEMORY.md")), false);
});

test("maintenance admits only canonical writes and refuses redirected library or workspace files", async t => {
  const f = fixture(t), host = f.host("one"), library = path.join(host.workspaceDir, "reference", "memory");
  fs.mkdirSync(library, { recursive: true, mode: 0o700 });
  const file = path.join(library, "2026-10-07.md"), text = "Private observatory reference.";
  fs.writeFileSync(file, text, { mode: 0o600 });
  new MemorySearchIndex({ host, databasePath: f.database.path, sharedDatabase: true,
    getConfig: () => ({ memory: { search: { provider: "none", extraPaths: [library] } } }) });
  const files = host.getAgentWorkspaceAccess(host.workspaceDir).memoryFiles, maintenance = files.maintenance;
  assert.equal((await maintenance.readFile(file)).toString(), text);
  assert.equal((await maintenance.stat(file, true)).mode & 0o777, 0o600);
  await assert.rejects(maintenance.commitContent({ filePath: file, content: "Replacement", tempPrefix: "test" }), { code: "MEMORY_PATH_NOT_ALLOWED" });
  await assert.rejects(maintenance.rename(file, path.join(host.workspaceDir, "MEMORY.md")), { code: "MEMORY_PATH_NOT_ALLOWED" });
  const symlink = path.join(host.workspaceDir, "memory/alias.md"), hardlink = path.join(host.workspaceDir, "memory/hardlink.md");
  fs.symlinkSync(file, symlink);
  await assert.rejects(maintenance.readFile(symlink), { code: "MEMORY_PATH_NOT_ALLOWED" });
  await assert.rejects(maintenance.stat(symlink, true), { code: "MEMORY_PATH_NOT_ALLOWED" });
  fs.linkSync(file, hardlink);
  await assert.rejects(maintenance.readFile(hardlink), { code: "MEMORY_PATH_NOT_ALLOWED" });
  await assert.rejects(maintenance.readFile(file), { code: "MEMORY_PATH_NOT_ALLOWED" });
  fs.unlinkSync(hardlink);
  const canonical = path.join(host.workspaceDir, "memory/nested/notes.md");
  await maintenance.commitContent({ filePath: canonical, content: "A canonical note.", tempPrefix: "test" });
  assert.equal(fs.readFileSync(canonical, "utf8"), "A canonical note.");
  assert.equal(fs.readFileSync(file, "utf8"), text);
  assert.deepEqual(await files.listFiles(host.workspaceDir, [library]), [canonical]);
});

function migrationFixture(t, fault = () => {}) {
  const f = fixture(t);
  f.paths.agentsDir = path.join(f.root, "agents");
  const directory = path.join(f.paths.agentsDir, "one", "memory");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const records = Array.from({ length: 80 }, (_, index) => ({
    id: `legacy-${index}`, profileId: "one", content: `记忆 ${index}：` + "完整数据不能从截断的生成视图恢复。".repeat(60),
    scope: index % 2 ? "agent" : "user", type: "semantic", sensitivity: "normal", status: "active",
    sourceRefs: [`event-${index}`, `run-${index}`], confidence: 1, validFrom: f.now() - 100,
    validUntil: null, supersedes: null, createdAt: f.now() - 100, updatedAt: f.now() - 100,
  }));
  records[0].status = "deleted"; records[1].status = "candidate";
  records[2].validUntil = f.now() - 1;
  const source = path.join(directory, "events.jsonl"), data = JSON.stringify(records) + "\n";
  fs.writeFileSync(source, data, { mode: 0o600 });
  const legacy = { revision: 84, recallRevision: 4, records,
    visibleIds: records.filter(item => item.status === "active" && item.id !== "legacy-3").map(item => item.id),
    files: [{ name: "events.jsonl", path: source }], historicalSourceItems: [records[0]],
    provenance: { revokedIds: ["legacy-3"], source: "verified-test-ledger" } };
  const options = { paths: f.paths, now: f.now, readLegacy: () => structuredClone(legacy),
    assertLegacyCurrent: (_id, snapshot, files) => {
      assert.equal(snapshot.revision, legacy.revision);
      for (const file of files) assert.equal(sha256(fs.readFileSync(file.source)), file.sha256);
    }, fault };
  return { ...f, legacy, source, data, options };
}

test("migration imports full authority beyond the old view cap and retains excluded provenance", t => {
  const f = migrationFixture(t), migration = new ShoggothMemoryMigration(f.options);
  const result = migration.run("one");
  assert.equal(result.imported, 76); assert.equal(result.retained, 4);
  assert.equal(fs.readFileSync(f.source, "utf8"), f.data);
  const memory = fs.readFileSync(path.join(result.workspace, "MEMORY.md"), "utf8");
  const user = fs.readFileSync(path.join(result.workspace, "USER.md"), "utf8");
  assert.ok(Buffer.byteLength(memory) > 32 * 1024);
  assert.ok(Buffer.byteLength(user) > 32 * 1024);
  assert.ok(!memory.includes("entry:legacy-3 -->"));
  assert.ok(!user.includes("entry:legacy-2 -->"));
  const snapshot = JSON.parse(fs.readFileSync(migration.locations("one").snapshot, "utf8"));
  assert.equal(snapshot.records.length, 80);
  assert.deepEqual(snapshot.provenance, f.legacy.provenance);
  assert.deepEqual(migration.run("one"), result);
});

for (const stop of ["after-prepared", "after-staged", "after-published"]) {
  test(`migration resumes after process interruption at ${stop}`, t => {
    let interrupted = false;
    const f = migrationFixture(t, stage => { if (stage === stop && !interrupted) { interrupted = true; throw new Error("simulated process loss"); } });
    const first = new ShoggothMemoryMigration(f.options);
    assert.throws(() => first.run("one"), /simulated process loss/);
    const next = new ShoggothMemoryMigration(f.options).run("one");
    assert.equal(next.phase, "active"); assert.equal(next.imported, 76);
    assert.equal(fs.readFileSync(f.source, "utf8"), f.data);
  });
}

test("migration stops on a changed legacy source and preserves both copies", t => {
  const f = migrationFixture(t, stage => { if (stage === "after-prepared") throw new Error("pause"); });
  const migration = new ShoggothMemoryMigration(f.options);
  assert.throws(() => migration.run("one"), /pause/);
  fs.appendFileSync(f.source, "changed\n");
  assert.throws(() => new ShoggothMemoryMigration({ ...f.options, fault: () => {} }).run("one"), /Expected values/);
  assert.equal(fs.existsSync(migration.locations("one").workspace), false);
  assert.equal(fs.readFileSync(path.join(migration.locations("one").directory, "backup/events.jsonl"), "utf8"), f.data);
});

test("file authority preserves stable IDs, detects direct edits and serializes CAS saves", async t => {
  const f = migrationFixture(t), migration = new ShoggothMemoryMigration(f.options);
  f.roster[0].workspace = migration.locations("one").workspace;
  const store = new FileMemoryStore({ paths: f.paths, database: f.database, migration, getHost: f.host, now: f.now });
  store.open(); store.ensureProfile("one");
  assert.equal(store.list("one", { status: "active" }).length, 76);
  assert.equal(store.get("one", "legacy-3").status, "deleted");
  const item = store.get("one", "legacy-5"), revision = store.getRevision("one");
  const outcome = await Promise.allSettled([
    store.upsert({ ...item, content: "One authorized file change", updatedAt: f.now() }, { expectedRevision: revision }),
    store.upsert({ ...item, content: "Stale concurrent file change", updatedAt: f.now() }, { expectedRevision: revision }),
  ]);
  assert.equal(outcome.filter(value => value.status === "fulfilled").length, 1);
  assert.equal(outcome.find(value => value.status === "rejected").reason.code, "MEMORY_REVISION_CONFLICT");
  const current = store.get("one", item.id);
  assert.equal(current.content, "One authorized file change");
  const contentRevision = store.getContentRevision("one", item.id);
  const other = store.get("one", "legacy-7");
  await store.upsert({ ...other, content: "A separate current fact", updatedAt: f.now() });
  assert.equal(store.getContentRevision("one", item.id), contentRevision);
  const target = path.join(migration.locations("one").workspace, "MEMORY.md");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("One authorized file change", "Direct owner file edit"));
  assert.equal(store.get("one", item.id).content, "Direct owner file edit");
  assert.equal(store.get("one", item.id).sourceRefs[0], `user-edit:${sha256("Direct owner file edit")}`);
  const edited = store.get("one", item.id);
  await store.upsert({ ...edited, status: "deleted", updatedAt: f.now() });
  assert.equal(store.get("one", item.id).status, "deleted");
  assert.ok(!fs.readFileSync(target, "utf8").includes("Direct owner file edit"));
  assert.equal(fs.readFileSync(f.source, "utf8"), f.data);
});

test("file authority advances the invalidation revision only when existing memory text changes", async t => {
  const f = migrationFixture(t), migration = new ShoggothMemoryMigration(f.options);
  f.roster[0].workspace = migration.locations("one").workspace;
  const store = new FileMemoryStore({ paths: f.paths, database: f.database, migration, getHost: f.host, now: f.now });
  store.open(); store.ensureProfile("one");
  const workspace = migration.locations("one").workspace;
  const revisions = () => store.getRevisions("one");
  const base = revisions();
  assert.equal(base.invalidationRevision, base.revision, "an untracked profile starts from its current revision");
  const added = { id: "news-preference", profileId: "one", content: "News must list each date and source",
    scope: "user", type: "semantic", sensitivity: "normal", status: "active", sourceRefs: ["event-news", "run-news"],
    confidence: 1, validFrom: f.now(), validUntil: null, supersedes: null, createdAt: f.now(), updatedAt: f.now() };
  await store.upsert(added);
  const afterAdd = revisions();
  assert.ok(afterAdd.revision > base.revision);
  assert.equal(afterAdd.invalidationRevision, base.invalidationRevision, "a saved new item is an addition");
  const daily = path.join(workspace, "memory", "2026-10-21.md");
  fs.mkdirSync(path.dirname(daily), { recursive: true, mode: 0o700 });
  fs.writeFileSync(daily, "- Asked for AI news\n", { mode: 0o600 });
  fs.appendFileSync(daily, "- Prefers dated sources\n");
  const afterAppend = revisions();
  assert.ok(afterAppend.revision > afterAdd.revision);
  assert.equal(afterAppend.invalidationRevision, base.invalidationRevision, "new files and appended lines are additions");
  fs.writeFileSync(daily, "- Asked for sports news\n- Prefers dated sources\n");
  const afterEdit = revisions();
  assert.equal(afterEdit.invalidationRevision, afterEdit.revision, "editing earlier text is an invalidation");
  await store.upsert({ ...store.get("one", "news-preference"), content: "News must list each date, source and link", updatedAt: f.now() });
  const afterUpdate = revisions();
  assert.ok(afterUpdate.invalidationRevision > afterEdit.invalidationRevision, "rewriting an active item is an invalidation");
  const restarted = new FileMemoryStore({ paths: f.paths, database: f.database, migration, getHost: f.host, now: f.now });
  restarted.open(); restarted.ensureProfile("one");
  assert.deepEqual(restarted.getRevisions("one"), afterUpdate, "the record survives a restart");
  fs.rmSync(daily);
  const afterRemove = restarted.getRevisions("one");
  assert.equal(afterRemove.invalidationRevision, afterRemove.revision, "a removed memory file is an invalidation");
});
