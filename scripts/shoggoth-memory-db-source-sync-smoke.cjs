"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase, transaction } = require("../app/agent-service/inspiration-database");
const { MemoryDatabase } = require("../app/agent-service/shoggoth-memory/database.cjs");
const { ShoggothMemoryHost, core } = require("../app/agent-service/shoggoth-memory/host.cjs");
const { MemorySearchIndex } = require("../app/agent-service/shoggoth-memory/search-index.cjs");

const tick = () => new Promise(resolve => setImmediate(resolve));
const revision = db => db.prepare("SELECT revision FROM memory_index_state WHERE id=1").get().revision;
const sourceRow = (db, source, pathname) => db.prepare("SELECT * FROM memory_index_sources WHERE source=? AND path=?").get(source, pathname);
const sourceChunks = (db, source, pathname) => db.prepare("SELECT * FROM memory_index_chunks WHERE source=? AND path=? ORDER BY id").all(source, pathname);
const lexicalCount = (db, query) => db.prepare(`SELECT count(*) AS n FROM ${core.MEMORY_INDEX_FTS_TABLE} WHERE ${core.MEMORY_INDEX_FTS_TABLE} MATCH ?`).get(query).n;
const snapshot = db => Object.fromEntries([
  "memory_index_sources", "memory_index_chunks", "memory_index_chunk_recall_metadata", "memory_index_chunk_provenance",
].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()]));

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-memory-db-source-sync-"));
  const paths = { trustedRoot: root, stateDir: path.join(root, "state"), agentsDir: path.join(root, "agents") };
  const workspace = path.join(root, "one");
  fs.mkdirSync(path.join(workspace, "memory"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(workspace, "MEMORY.md"), "Amber observatory.", { mode: 0o600 });
  fs.writeFileSync(path.join(workspace, "memory", "keep.md"), "Violet telescope.", { mode: 0o600 });
  const database = new MemoryDatabase({ paths });
  database.open();
  const host = new ShoggothMemoryHost({ database, paths, profileId: "one", workspaceDir: workspace,
    roster: () => [{ id: "one", workspace }], sessions: { list: () => [], read: () => null } });
  // A real native index owner and SQLite connection, with synthetic local
  // embedding vectors only. No Service state, remote provider or Gateway.
  const config = { memory: { search: { provider: "shoggoth-e5", cache: { enabled: true } } } };
  const index = new MemorySearchIndex({ host, databasePath: database.path, sharedDatabase: true,
    embedding: { identity: "fixture-db-source-sync-v1", encode: async () => [1, 0] }, getConfig: () => config,
    logger: { debug() {}, warn() {} } });
  const privateDatabases = [];
  t.after(async () => {
    await index.close();
    assert.equal(host.coordinationDatabases?.size || 0, 0, "source operations must release their physical generation leases");
    for (const db of privateDatabases) if (db.isOpen) db.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await index.sync();
  const resource = index.embeddingExecutor.publishedDatabase;
  assert.ok(resource.publication instanceof core.MemorySourceIndexKernel);
  const f = { root, database, host, config, index, resource, run: action => host.run(action),
    seed(target, source, pathname, text, hash = core.hashText(text)) {
      const chunks = core.prepareMemoryIndexChunks({ entry: { path: pathname, mtimeMs: 100 }, source, content: text,
        pathClassification: { curatedRoot: source === "memory", originClass: "owner" },
        chunking: { tokens: 400, overlap: 80 }, hardMaxInputTokens: 8192 }).chunks;
      const replacement = { entry: { path: pathname, hash, mtimeMs: 100, size: Buffer.byteLength(text) },
        source, model: "fixture-db-source-sync-v1", now: 100, vectorReady: false,
        ...(source === "sessions" ? { agentId: "one", sessionId: "session-one" } : {}) };
      transaction(target.db, () => target.publication.replaceRows(replacement, chunks.map(chunk => ({ chunk, embedding: [1, 0] }))));
      return replacement.entry;
    },
    shadow() {
      const db = openDatabase(path.join(root, `shadow-${privateDatabases.length}.sqlite`));
      privateDatabases.push(db);
      index.admitSchema(db, "unicode61");
      return index.embeddingExecutor.createDatabase(db, { shadow: true });
    },
  };
  return f;
}

test("source-state and hash reads preserve native source and path filtering", async t => {
  const f = await fixture(t);
  const session = f.seed(f.resource, "sessions", "sessions/one/session-one.jsonl", "User: Silver galaxy.");
  const memory = await f.run(() => f.resource.readSourceState({ source: "memory" }));
  assert.deepEqual(memory.map(row => row.path).sort(), ["MEMORY.md", "memory/keep.md"]);
  assert.ok(memory.every(row => Number.isFinite(row.mtime) && Number.isFinite(row.size) && row.hash));
  const selected = await f.run(() => f.resource.readSourceState({ source: "memory", paths: ["memory/keep.md"] }));
  assert.deepEqual(selected.map(row => row.path), ["memory/keep.md"]);
  assert.deepEqual(await f.run(() => f.resource.readSourceState({ source: "memory", paths: [] })), []);
  assert.deepEqual((await f.run(() => f.resource.readSourceState({ source: "sessions" }))).map(row => row.path), [session.path]);
  const readHash = (source, pathname) => f.run(() => f.resource.read({ type: "source.hash", input: { source, path: pathname } }, () => {}));
  assert.equal(await readHash("sessions", session.path), session.hash);
  assert.equal(await readHash("memory", session.path), undefined);
  assert.equal(await readHash("memory", "memory/missing.md"), undefined);
});

test("native conditional deletion leaves a newer source intact and atomically clears only the matching source", async t => {
  const f = await fixture(t), db = f.database.db;
  const before = snapshot(db), beforeRevision = revision(db), current = sourceRow(db, "memory", "MEMORY.md");
  const ids = sourceChunks(db, "memory", "MEMORY.md").map(row => row.id);
  assert.equal(lexicalCount(db, "Amber"), 1);
  assert.equal(await f.run(() => f.resource.deleteSource({ source: "memory", path: current.path, expectedHash: "older-source-hash" }, () => {})), false);
  assert.deepEqual(snapshot(db), before);
  assert.equal(revision(db), beforeRevision);
  assert.equal(await f.run(() => f.resource.deleteSource({ source: "memory", path: current.path, expectedHash: current.hash }, () => {})), true);
  assert.equal(sourceRow(db, "memory", current.path), undefined);
  assert.deepEqual(sourceChunks(db, "memory", current.path), []);
  for (const id of ids) {
    assert.equal(db.prepare("SELECT chunk_id FROM memory_index_chunk_recall_metadata WHERE chunk_id=?").get(id), undefined);
    assert.equal(db.prepare("SELECT chunk_id FROM memory_index_chunk_provenance WHERE chunk_id=?").get(id), undefined);
  }
  assert.equal(lexicalCount(db, "Amber"), 0);
  assert.equal(lexicalCount(db, "Violet"), 1);
  assert.ok(sourceRow(db, "memory", "memory/keep.md"));
  assert.equal(revision(db), beforeRevision + 1);
});

test("native session metadata refresh preserves chunks and returns false for a competing fingerprint", async t => {
  const f = await fixture(t), db = f.database.db, pathname = "sessions/one/session-one.jsonl";
  const session = f.seed(f.resource, "sessions", pathname, "User: Silver galaxy.", "sqlite:200:content-hash");
  f.seed(f.resource, "memory", pathname, "Synthetic memory row with the same source path.", "memory-hash");
  const chunks = sourceChunks(db, "sessions", pathname), originalSource = sourceRow(db, "sessions", pathname), beforeRevision = revision(db);
  const input = { path: pathname, hash: "sqlite:100:content-hash", mtime: 50, size: session.size + 4, expectedHash: session.hash };
  const before = snapshot(db);
  assert.equal(await f.run(() => f.resource.refreshSourceState({ ...input, expectedHash: "sqlite:300:competing-hash" }, () => {})), false);
  assert.deepEqual(snapshot(db), before);
  assert.equal(revision(db), beforeRevision);
  assert.equal(await f.run(() => f.resource.refreshSourceState(input, () => {})), true);
  assert.deepEqual({ ...sourceRow(db, "sessions", pathname) }, { ...originalSource, hash: input.hash, mtime: input.mtime, size: input.size });
  assert.equal(sourceRow(db, "sessions", pathname).id, originalSource.id, "metadata refresh must retain the native source row identity");
  assert.deepEqual(sourceChunks(db, "sessions", pathname), chunks, "metadata convergence must not replace unchanged session chunks");
  assert.equal(sourceRow(db, "memory", pathname).hash, "memory-hash");
  assert.equal(revision(db), beforeRevision + 1);
});

for (const operation of ["delete", "refresh"]) test(`published ${operation} waits for fused retrieval admission and rechecks authority before mutation`, { timeout: 15_000 }, async t => {
  const f = await fixture(t), db = f.database.db, pathname = "sessions/one/session-one.jsonl";
  const session = f.seed(f.resource, "sessions", pathname, "User: Silver galaxy.", "sqlite:100:content-hash");
  const before = snapshot(db), beforeRevision = revision(db);
  const release = await f.run(() => core.acquireMemoryIndexReadGeneration(f.database.path, undefined, true));
  let current = true, settled = false, checks = 0;
  const assertCurrent = () => {
    checks++;
    if (!current) throw Object.assign(new Error("Fixture source owner revoked"), { code: "MEMORY_SCOPE_REVOKED" });
  };
  const pending = f.run(() => operation === "delete"
    ? f.resource.deleteSource({ path: pathname, source: "sessions", expectedHash: session.hash }, assertCurrent)
    : f.resource.refreshSourceState({ path: pathname, hash: "sqlite:200:content-hash", mtime: 200, size: session.size, expectedHash: session.hash }, assertCurrent));
  pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(pending, { code: "MEMORY_SCOPE_REVOKED" });
  try {
    await tick(); await tick();
    assert.equal(settled, false, "fused readers must exclude source mutation");
    assert.deepEqual(snapshot(db), before);
    assert.equal(revision(db), beforeRevision);
    assert.equal(checks, 1, "transaction admission has not started while retrieval owns the lease");
    current = false;
  } finally { await release(); }
  await rejected;
  assert.ok(checks >= 2, "authority must be checked again after waiting for the lease");
  assert.deepEqual(snapshot(db), before);
  assert.equal(revision(db), beforeRevision);
});

test("a native deletion failure rolls back source rows, chunk metadata, FTS and revision together", async t => {
  const f = await fixture(t), db = f.database.db, before = snapshot(db), beforeRevision = revision(db);
  const current = sourceRow(db, "memory", "MEMORY.md");
  db.exec("CREATE TEMP TRIGGER fixture_source_delete_failure BEFORE DELETE ON memory_index_sources WHEN old.path='MEMORY.md' BEGIN SELECT RAISE(ABORT,'fixture source deletion failed'); END");
  await assert.rejects(f.run(() => f.resource.deleteSource({ source: "memory", path: current.path, expectedHash: current.hash }, () => {})), /fixture source deletion failed/);
  assert.deepEqual(snapshot(db), before);
  assert.equal(lexicalCount(db, "Amber"), 1);
  assert.equal(revision(db), beforeRevision);
  assert.equal(db.isTransaction, false);
  db.exec("DROP TRIGGER fixture_source_delete_failure");
  assert.equal(await f.run(() => f.resource.deleteSource({ source: "memory", path: current.path, expectedHash: current.hash }, () => {})), true);
  assert.equal(revision(db), beforeRevision + 1, "a failed transaction must leave its lease reusable");
});

test("shadow source mutation stays private while a published fused reader is active and closed resources reject access", { timeout: 15_000 }, async t => {
  const f = await fixture(t), publishedBefore = snapshot(f.database.db), publishedRevision = revision(f.database.db);
  const shadow = f.shadow(), session = f.seed(shadow, "sessions", "sessions/one/session-one.jsonl", "User: Silver galaxy.", "sqlite:100:content-hash");
  const memory = f.seed(shadow, "memory", "MEMORY.md", "Amber private shadow.");
  shadow.publishedSources.set("memory:MEMORY.md", { kind: "memory", relative: "MEMORY.md" });
  const release = await f.run(() => core.acquireMemoryIndexReadGeneration(f.database.path, undefined, true));
  let deleted = false, refreshed = false;
  const deletion = f.run(() => shadow.deleteSource({ source: "memory", path: memory.path, expectedHash: memory.hash }, () => {})).then(value => { deleted = value; });
  const refresh = deletion.then(() => f.run(() => shadow.refreshSourceState({ path: session.path, hash: "sqlite:200:content-hash", mtime: 200, size: session.size, expectedHash: session.hash }, () => {}))).then(value => { refreshed = value; });
  try {
    await tick(); await tick();
    assert.equal(deleted, true, "private deletion must not wait for the published mutation lease");
    assert.equal(refreshed, true, "private refresh must not wait for the published mutation lease");
  } finally { await release(); }
  await refresh;
  assert.equal(shadow.publishedSources.has("memory:MEMORY.md"), false);
  assert.equal(revision(shadow.db), 2);
  assert.deepEqual(snapshot(f.database.db), publishedBefore);
  assert.equal(revision(f.database.db), publishedRevision);
  shadow.closed = true;
  await assert.rejects(f.run(() => shadow.readSourceState({ source: "sessions" })), { code: "MEMORY_SCOPE_REVOKED" });
  await assert.rejects(f.run(() => shadow.read({ type: "source.hash", input: { source: "sessions", path: session.path } }, () => {})), { code: "MEMORY_SCOPE_REVOKED" });
  await assert.rejects(f.run(() => shadow.deleteSource({ source: "sessions", path: session.path, expectedHash: "sqlite:200:content-hash" }, () => {})), { code: "MEMORY_SCOPE_REVOKED" });
  await assert.rejects(f.run(() => shadow.refreshSourceState({ path: session.path, hash: "sqlite:300:content-hash", mtime: 300, size: session.size, expectedHash: "sqlite:200:content-hash" }, () => {})), { code: "MEMORY_SCOPE_REVOKED" });
});
