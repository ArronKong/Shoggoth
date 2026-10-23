"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MemoryDatabase } = require("../app/agent-service/shoggoth-memory/database.cjs");
const { ShoggothMemoryHost, core } = require("../app/agent-service/shoggoth-memory/host.cjs");
const { MemorySearchIndex } = require("../app/agent-service/shoggoth-memory/search-index.cjs");

const source = (f, kind, pathname) => f.database.db.prepare("SELECT * FROM memory_index_sources WHERE source=? AND path=?").get(kind, pathname);
const chunks = (f, kind, pathname) => f.database.db.prepare("SELECT * FROM memory_index_chunks WHERE source=? AND path=? ORDER BY id").all(kind, pathname);
const revision = f => f.database.db.prepare("SELECT revision FROM memory_index_state WHERE id=1").get().revision;
const lexicalCount = (f, query) => f.database.db.prepare(`SELECT count(*) AS n FROM ${core.MEMORY_INDEX_FTS_TABLE} WHERE ${core.MEMORY_INDEX_FTS_TABLE} MATCH ?`).get(query).n;
const publishedSnapshot = f => Object.fromEntries([
  "memory_index_sources", "memory_index_chunks", "memory_index_meta", "memory_index_state",
  "memory_index_chunk_recall_metadata", "memory_index_chunk_provenance", core.MEMORY_INDEX_FTS_TABLE, "memory_index_paths_fts",
].map(table => [table, f.database.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const shadows = f => fs.readdirSync(path.dirname(f.database.path)).filter(name => name.startsWith(`${path.basename(f.database.path)}.memory-reindex-`));
function assertLightSessionReceipts(resource) {
  for (const receipt of resource.publishedSources.values()) {
    assert.equal(receipt.kind, "sessions");
    assert.ok(receipt.snapshot.hash);
    assert.equal(typeof receipt.snapshot.authorityStamp, "string");
    for (const field of ["content", "text", "lineMap", "messageTimestampsMs", "lineProvenance"]) {
      assert.equal(receipt.snapshot[field], undefined, `settled shadow receipts must not retain flattened transcript ${field}`);
    }
  }
}

function sessionValue(id, content, sequence = 1, clock = 100) {
  const lineMap = [sequence], messageTimestampsMs = [100], lineProvenance = [
    { originClass: "owner", sessionKind: "interactive", observedAt: 100 },
  ];
  return { content, hash: core.hashSessionEntrySnapshot({ content, lineMap, messageTimestampsMs,
    lineProvenance, resetRecallCutoff: null }), lineMap, messageTimestampsMs, lineProvenance,
    authorityStamp: JSON.stringify([id, sequence, clock]), mtimeMs: clock, revisionMs: clock,
    size: Buffer.byteLength(content), sessionKind: "interactive" };
}

function fixture(t, { sources = ["memory"], sourceWide = false, shareWorkspace = false } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-memory-native-source-policy-"));
  const paths = { trustedRoot: root, stateDir: path.join(root, "state"), agentsDir: path.join(root, "agents") };
  const workspace = path.join(root, "one"), foreignWorkspace = shareWorkspace ? workspace : path.join(root, "two");
  fs.mkdirSync(path.join(workspace, "memory"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(foreignWorkspace, { recursive: true, mode: 0o700 });
  const database = new MemoryDatabase({ paths });
  database.open();
  const sessions = new Map(), reads = [], stats = [], encodes = [], batches = [];
  const sessionResource = {
    list: () => Array.from(sessions, ([id, value]) => ({ id, interactive: true,
      sessionKey: `agent:one:chat:${id}`, updatedAt: value.mtimeMs })),
    read: (profileId, id) => {
      reads.push({ profileId, id });
      const value = sessions.get(id);
      if (!value) throw Object.assign(new Error("Fixture session withdrawn"), { code: "MEMORY_SESSION_REVOKED" });
      return { ...value };
    },
    stat: (profileId, id) => {
      stats.push({ profileId, id });
      const value = sessions.get(id);
      if (!value) throw Object.assign(new Error("Fixture session withdrawn"), { code: "MEMORY_SESSION_REVOKED" });
      return { ...value };
    },
    metadata: () => ({ channel: "webchat", chatType: "direct" }),
  };
  const host = new ShoggothMemoryHost({ database, paths, profileId: "one", workspaceDir: workspace,
    roster: () => [{ id: "one", workspace }, { id: "two", workspace: foreignWorkspace }], sessions: sessionResource });
  // Isolated Product constructor resources. The native batch adapter receives
  // fake vectors and cannot contact a provider or start another Gateway.
  const config = { memory: { search: { sources, provider: "shoggoth-e5", cache: { enabled: true },
    ...(sourceWide ? { remote: { baseUrl: "http://127.0.0.1:1/unused", batch: { enabled: true } } } : {}) } } };
  const embedding = { identity: "fixture-native-source-policy-v1", encode: async (text, purpose) => {
    encodes.push({ text, purpose }); return [1, 0];
  } };
  const runtime = sourceWide ? { sourceWideBatchEmbed: true, batchEmbed: async ({ chunks: inputs }) => {
    batches.push(inputs.length); return inputs.map(() => [1, 0]);
  } } : undefined;
  const index = new MemorySearchIndex({ host, databasePath: database.path, sharedDatabase: true,
    embedding, embeddingRuntime: runtime, getConfig: () => config, logger: { debug() {}, warn() {} } });
  t.after(async () => {
    await index.close();
    assert.equal(host.coordinationDatabases?.size || 0, 0);
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, workspace, database, host, index, config, sessions, reads, stats, encodes, batches,
    run: action => host.run(action),
    write: (name, content) => fs.writeFileSync(path.join(workspace, name), content, { mode: 0o600 }),
    putSession: (id, content, sequence = 1, clock = 100) => sessions.set(id, sessionValue(id, content, sequence, clock)),
    clearCalls: () => { reads.length = 0; stats.length = 0; encodes.length = 0; batches.length = 0; },
  };
}

test("actual native incremental memory policy skips unchanged files, indexes changes and removes vanished sources", async t => {
  const f = fixture(t);
  f.write("MEMORY.md", "Amber observatory.");
  f.write("memory/change.md", "Violet telescope.");
  f.write("memory/remove.md", "Silver galaxy.");
  await f.index.sync();
  const executor = f.index.embeddingExecutor, nativeSyncMemoryFiles = executor.syncMemoryFiles;
  let nativePasses = 0;
  t.mock.method(executor, "syncMemoryFiles", function (...args) {
    nativePasses++; return nativeSyncMemoryFiles.apply(this, args);
  });
  const unchanged = chunks(f, "memory", "MEMORY.md"), beforeRevision = revision(f);
  f.clearCalls();
  await f.index.sync();
  assert.equal(nativePasses, 1);
  assert.equal(f.encodes.length, 0);
  assert.equal(revision(f), beforeRevision, "an unchanged memory corpus must not publish another generation");
  f.write("memory/change.md", "Indigo calibration.");
  f.write("memory/new.md", "Golden comet.");
  fs.unlinkSync(path.join(f.workspace, "memory", "remove.md"));
  await f.index.sync();
  assert.equal(nativePasses, 2, "the incremental path must execute the original SourceSyncOps method");
  assert.deepEqual(f.encodes.filter(call => call.purpose === "passage").map(call => call.text).sort(), ["Golden comet.", "Indigo calibration."]);
  assert.deepEqual(chunks(f, "memory", "MEMORY.md"), unchanged);
  assert.equal(source(f, "memory", "memory/remove.md"), undefined);
  assert.equal(lexicalCount(f, "Silver"), 0);
  assert.equal(lexicalCount(f, "Indigo"), 1);
  assert.equal(lexicalCount(f, "Golden"), 1);
  assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM memory_index_sources").get().n, 3);
  assert.equal(executor.sourceJobs.getStore(), undefined, "flattened source snapshots belong to their admitted native batch only");
});

test("native session metadata convergence keeps same-text chunks and avoids embedding after a backward revision restore", async t => {
  const f = fixture(t, { sources: ["sessions"] });
  await f.index.sync();
  f.putSession("session-one", "User: Amber observatory.", 7, 200);
  await f.index.sync();
  const pathname = f.index.sessionPath("session-one"), original = chunks(f, "sessions", pathname), current = f.sessions.get("session-one");
  assert.equal(source(f, "sessions", pathname).hash, `sqlite:200:${current.hash}`);
  const beforeRevision = revision(f), resource = f.index.embeddingExecutor.publishedDatabase, refresh = resource.refreshSourceState;
  const inputs = [];
  t.mock.method(resource, "refreshSourceState", function (input, ...rest) {
    inputs.push({ ...input }); return refresh.call(this, input, ...rest);
  });
  f.sessions.set("session-one", { ...current, mtimeMs: 50, revisionMs: 50, authorityStamp: "fixture-restored-metadata" });
  f.clearCalls();
  await f.index.sync();
  assert.equal(f.encodes.length, 0);
  assert.equal(inputs.length, 1, "same-text revision changes must take the native metadata-refresh branch");
  assert.equal(inputs[0].expectedHash, `sqlite:200:${current.hash}`);
  assert.equal(inputs[0].hash, `sqlite:50:${current.hash}`);
  assert.equal(source(f, "sessions", pathname).hash, `sqlite:50:${current.hash}`);
  assert.equal(source(f, "sessions", pathname).mtime, 50);
  assert.deepEqual(chunks(f, "sessions", pathname), original);
  assert.equal(revision(f), beforeRevision + 1);
});

test("native incremental session policy embeds only changed text and deletes withdrawn corpus members", async t => {
  const f = fixture(t, { sources: ["sessions"] });
  await f.index.sync();
  f.putSession("change", "User: Amber observatory.");
  f.putSession("remove", "User: Silver galaxy.");
  f.putSession("keep", "User: Violet telescope.");
  await f.index.sync();
  const stable = chunks(f, "sessions", f.index.sessionPath("keep"));
  const executor = f.index.embeddingExecutor, nativeSyncArchiveFiles = executor.syncArchiveFiles;
  let nativePasses = 0;
  t.mock.method(executor, "syncArchiveFiles", function (...args) {
    nativePasses++; return nativeSyncArchiveFiles.apply(this, args);
  });
  f.putSession("change", "User: Indigo calibration.", 2, 200);
  f.sessions.delete("remove");
  f.clearCalls();
  await f.index.sync();
  assert.equal(nativePasses, 1);
  assert.deepEqual(f.encodes.filter(call => call.purpose === "passage").map(call => call.text), ["User: Indigo calibration."]);
  assert.equal(source(f, "sessions", f.index.sessionPath("remove")), undefined);
  assert.deepEqual(chunks(f, "sessions", f.index.sessionPath("remove")), []);
  assert.deepEqual(chunks(f, "sessions", f.index.sessionPath("keep")), stable);
  assert.equal(lexicalCount(f, "Silver"), 0);
  assert.equal(lexicalCount(f, "Indigo"), 1);
  assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM memory_index_sources WHERE source='sessions'").get().n, 2);
});

test("transcript construction and stat reject foreign Profile, store, canonical path and session identity before reading", async t => {
  const f = fixture(t, { sources: ["sessions"], shareWorkspace: true });
  await f.index.sync();
  f.putSession("session-one", "User: Amber observatory.");
  const canonical = path.join(f.workspace, ".session-source", "session-one");
  const options = { agentId: "one", sessionId: "session-one", storePath: f.database.path };
  for (const method of ["buildSessionEntry", "statSessionEntrySync"]) {
    const good = f.run(() => f.host[method](canonical, options));
    assert.equal(good.path, f.index.sessionPath("session-one"));
    assert.equal(good.absPath, canonical);
    assert.equal(good.sessionId, "session-one");
    f.clearCalls();
    const cases = [
      [canonical, { ...options, agentId: "two" }],
      [canonical, { ...options, storePath: path.join(f.root, "foreign.sqlite") }],
      [path.join(f.workspace, ".session-source", "different-session"), options],
      [path.join(f.workspace, ".session-source") + "/./session-one", options],
      [canonical, { ...options, sessionId: "../session-one" }],
    ];
    for (const [absolutePath, target] of cases) assert.throws(() => f.run(() => f.host[method](absolutePath, target)));
    assert.equal(f.reads.length, 0, "an invalid transcript target must never reach Product source reads");
    assert.equal(f.stats.length, 0, "an invalid transcript target must never reach Product source stats");
  }
  assert.throws(() => f.run(() => f.host.sessionPathForSessionIdentity("two", "session-one")));
});

test("real native source-wide session indexing flushes flattened transcripts in groups of 128", { timeout: 120_000 }, async t => {
  const f = fixture(t, { sources: ["sessions"], sourceWide: true });
  await f.index.sync();
  for (let n = 0; n < 257; n++) f.putSession(`session-${String(n).padStart(3, "0")}`, `User: Fictional observatory ${n}.`, n + 1, 100 + n);
  const executor = f.index.embeddingExecutor, nativeIndexFiles = executor.indexFiles, build = f.host.buildSessionEntry;
  const prepared = new Set(), groups = [];
  t.mock.method(f.host, "buildSessionEntry", function (absolutePath, options) {
    const value = build.call(this, absolutePath, options);
    prepared.add(options.sessionId);
    return value;
  });
  t.mock.method(executor, "indexFiles", function (items) {
    groups.push({ files: items.length, prepared: prepared.size });
    assert.ok(items.every(item => item.source === "sessions"));
    return nativeIndexFiles.call(this, items);
  });
  f.clearCalls();
  await f.index.sync();
  assert.deepEqual(groups, [{ files: 128, prepared: 128 }, { files: 128, prepared: 256 }, { files: 1, prepared: 257 }]);
  assert.deepEqual(f.batches, [128, 128, 1]);
  assert.equal(f.encodes.length, 0, "the configured source-wide provider must not fall back to per-file encoding");
  assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM memory_index_sources WHERE source='sessions'").get().n, 257);
  assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM memory_index_chunks WHERE source='sessions'").get().n, 257);
  assert.equal(executor.sourceJobs.getStore(), undefined);
});

test("full shadow rebuilding uses native 128-session groups while cache belongs to the published owner", { timeout: 120_000 }, async t => {
  const f = fixture(t, { sources: ["sessions"], sourceWide: true });
  await f.index.sync();
  f.putSession("baseline", "User: Preserved violet telescope.");
  await f.index.sync();
  const before = publishedSnapshot(f), beforeRevision = revision(f), publishedCache = count(f.database.db, "memory_embedding_cache");
  assert.equal(publishedCache, 1);
  f.sessions.clear();
  for (let n = 0; n < 257; n++) f.putSession(`session-${String(n).padStart(3, "0")}`, `User: Full shadow observatory ${n}.`, n + 1, 100 + n);
  const executor = f.index.embeddingExecutor, nativeIndexFiles = executor.indexFiles, build = f.host.buildSessionEntry;
  const prepared = new Set(), groups = [];
  let shadow;
  t.mock.method(f.host, "buildSessionEntry", function (absolutePath, options) {
    const value = build.call(this, absolutePath, options);
    prepared.add(options.sessionId);
    return value;
  });
  t.mock.method(executor, "indexFiles", function (items) {
    shadow = this.database;
    assert.equal(shadow.isShadow, true, "force sync must execute the actual private shadow path");
    assert.notEqual(shadow.db, this.publishedDatabase.db);
    assert.equal(this.syncProviderGeneration.database, this.publishedDatabase, "cache generation must capture the canonical published resource");
    assert.deepEqual(publishedSnapshot(f), before, "a prepared shadow group cannot replace live rows before final publication");
    assert.equal(count(shadow.db, "memory_embedding_cache"), 0, "derived cache writes must never enter the shadow connection");
    assertLightSessionReceipts(shadow);
    groups.push({ files: items.length, prepared: prepared.size, shadowRows: count(shadow.db, "memory_index_sources"),
      receipts: shadow.publishedSources.size, publishedCache: count(f.database.db, "memory_embedding_cache") });
    return nativeIndexFiles.call(this, items);
  });
  f.clearCalls();
  await f.index.sync({ force: true });
  assert.deepEqual(groups, [
    { files: 128, prepared: 128, shadowRows: 0, receipts: 0, publishedCache: 1 },
    { files: 128, prepared: 256, shadowRows: 128, receipts: 128, publishedCache: 129 },
    { files: 1, prepared: 257, shadowRows: 256, receipts: 256, publishedCache: 257 },
  ]);
  assert.deepEqual(f.batches, [128, 128, 1]);
  assert.equal(f.encodes.length, 0);
  assert.equal(count(f.database.db, "memory_index_sources"), 257);
  assert.equal(count(f.database.db, "memory_index_chunks"), 257);
  assert.equal(count(f.database.db, "memory_embedding_cache"), 258, "canonical cache must retain both the old valid vector and the completed shadow work");
  assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM memory_index_chunks AS chunk WHERE EXISTS (SELECT 1 FROM memory_embedding_cache AS cache WHERE cache.hash=chunk.hash)").get().n, 257);
  assert.equal(f.database.db.prepare("SELECT max(dims) AS dims FROM memory_embedding_cache").get().dims, 2);
  assert.equal(source(f, "sessions", f.index.sessionPath("baseline")), undefined);
  assert.equal(lexicalCount(f, "Full"), 257);
  assert.equal(revision(f), beforeRevision + 1, "the full generation must publish once atomically");
  assert.equal(shadow.closed, true);
  assert.equal(shadow.shadowReleased, true);
  assert.equal(shadow.db.isOpen, false);
  assert.equal(shadow.publishedSources.size, 257);
  assertLightSessionReceipts(shadow);
  assert.deepEqual(shadows(f), []);
  assert.equal(executor.sourceJobs.getStore(), undefined);
});

test("a failed full shadow group keeps the old live generation and canonical cached work for retry", { timeout: 120_000 }, async t => {
  const f = fixture(t, { sources: ["sessions"], sourceWide: true });
  await f.index.sync();
  f.putSession("baseline", "User: Preserved violet telescope.");
  await f.index.sync();
  const before = publishedSnapshot(f), beforeRevision = revision(f);
  f.sessions.clear();
  for (let n = 0; n < 257; n++) f.putSession(`session-${String(n).padStart(3, "0")}`, `User: Failed shadow observatory ${n}.`, n + 1, 100 + n);
  const executor = f.index.embeddingExecutor, createDatabase = executor.createDatabase, resources = [];
  let fail = true;
  t.mock.method(executor, "createDatabase", function (db, options) {
    const resource = createDatabase.call(this, db, options);
    if (options?.shadow) {
      resources.push(resource);
      const replace = resource.replaceSource;
      let attempts = 0;
      t.mock.method(resource, "replaceSource", function (...args) {
        if (fail && ++attempts === 129) throw new Error("Fixture second shadow group publication failed");
        return replace.apply(this, args);
      });
    }
    return resource;
  });
  f.clearCalls();
  await assert.rejects(f.index.sync({ force: true }), /Fixture second shadow group publication failed/);
  assert.deepEqual(f.batches, [128, 128]);
  assert.equal(f.encodes.length, 0);
  assert.deepEqual(publishedSnapshot(f), before, "a partially completed shadow must never publish its rows or metadata");
  assert.equal(revision(f), beforeRevision);
  assert.equal(lexicalCount(f, "Preserved"), 1);
  assert.equal(lexicalCount(f, "Failed"), 0);
  assert.equal(count(f.database.db, "memory_embedding_cache"), 257, "the two completed provider groups remain reusable on the canonical cache owner");
  assert.equal(f.index.embeddingFailure, null, "a storage failure must not be reclassified as provider degradation");
  assert.equal(f.index.rebuildRetryState.sessionsFullRetryDirty, true);
  assert.equal(resources.length, 1);
  assert.equal(resources[0].publishedSources.size, 128);
  assertLightSessionReceipts(resources[0]);
  assert.equal(resources[0].closed, true);
  assert.equal(resources[0].shadowReleased, true);
  assert.equal(resources[0].db.isOpen, false);
  assert.deepEqual(shadows(f), []);
  fail = false;
  await f.index.sync({ force: true });
  assert.deepEqual(f.batches, [128, 128, 1], "retry must reuse cached vectors from the failed shadow and request only its missing final group");
  assert.equal(count(f.database.db, "memory_index_sources"), 257);
  assert.equal(count(f.database.db, "memory_index_chunks"), 257);
  assert.equal(count(f.database.db, "memory_embedding_cache"), 258);
  assert.equal(lexicalCount(f, "Failed"), 257);
  assert.equal(revision(f), beforeRevision + 1);
  assert.deepEqual(shadows(f), []);
});
