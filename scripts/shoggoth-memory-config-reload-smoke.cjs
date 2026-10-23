"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MemoryDatabase } = require("../app/agent-service/shoggoth-memory/database.cjs");
const { ShoggothMemoryHost, core } = require("../app/agent-service/shoggoth-memory/host.cjs");
const { MemorySearchIndex } = require("../app/agent-service/shoggoth-memory/search-index.cjs");

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() >= deadline) assert.fail(label); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function transcript(content, revision) {
  const lineMap = [revision], messageTimestampsMs = [100], lineProvenance = [{ originClass: "owner", sessionKind: "interactive", observedAt: 100 }];
  return { content, revisionMs: revision, mtimeMs: 100, size: Buffer.byteLength(content), lineMap,
    messageTimestampsMs, lineProvenance, sessionKind: "interactive", authorityStamp: `${revision}:${content}`,
    hash: core.hashSessionEntrySnapshot({ content, lineMap, messageTimestampsMs, lineProvenance, resetRecallCutoff: null }) };
}
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-memory-config-reload-"));
  const paths = { trustedRoot: root, stateDir: path.join(root, "state"), agentsDir: path.join(root, "agents") };
  const workspace = path.join(root, "one");
  fs.mkdirSync(path.join(workspace, "memory"), { recursive: true, mode: 0o700 });
  const database = new MemoryDatabase({ paths }); database.open();
  const sessions = new Map(), calls = [], handles = [], cleanups = [];
  const resource = {
    list: () => [...sessions].map(([id, value]) => ({ id, sessionKey: `agent:one:chat:${id}`, interactive: true, updatedAt: value.mtimeMs })),
    read: (_profile, id) => ({ ...sessions.get(id) }), stat: (_profile, id) => ({ ...sessions.get(id) }),
    metadata: () => ({ channel: "webchat", chatType: "direct" }),
  };
  const embedding = { identity: "fixture-config-reload-e5-v1", encode: async (text, purpose, request) => {
    calls.push({ text, purpose }); return options.encode ? options.encode(text, purpose, request) : [1, 0];
  } };
  const config = { _shoggothConfigRevision: 0, memory: { search: { provider: options.provider || "shoggoth-e5",
    sources: options.sources || ["memory"], cache: { enabled: true } } } };
  const host = new ShoggothMemoryHost({ database, paths, profileId: "one", workspaceDir: workspace,
    roster: () => [{ id: "one", workspace }], sessions: resource });
  // All text, vectors and provider resources are invented constructor inputs.
  // No production provider, credential store, model worker or network is used.
  const index = new MemorySearchIndex({ host, databasePath: database.path, sharedDatabase: true, embedding,
    getConfig: () => config, backgroundSync: false, logger: { debug() {}, warn() {} },
    embeddingAdapterFactory: adapter => ({ ...adapter, create: async request => {
      const result = await adapter.create(request), close = result.provider.close;
      handles.push(result.provider);
      result.provider.close = async () => options.close ? options.close(close, result.provider) : close();
      return result;
    } }) });
  const f = { root, paths, workspace, database, host, index, config, calls, handles,
    write: (name, content) => fs.writeFileSync(path.join(workspace, name), content, { mode: 0o600 }),
    put: (id, content, revision = 1) => sessions.set(id, transcript(content, revision)),
    target: id => ({ agentId: "one", sessionId: id, sessionKey: `agent:one:chat:${id}` }),
    text: id => database.db.prepare("SELECT text FROM memory_index_chunks WHERE source='sessions' AND path=?").get(index.sessionPath(id))?.text,
    chunks: () => database.db.prepare("SELECT id,path,text,model,embedding FROM memory_index_chunks ORDER BY id").all(),
    run: action => host.run(action), cleanup: action => cleanups.push(action),
    ready: async () => { await index.sync(); return index.searchOwner; },
  };
  t.after(async () => {
    for (const cleanup of cleanups) cleanup();
    await index.close();
    assert.equal(index.searchOwners.size, 0); assert.equal(index.embeddingExecutors.size, 0);
    assert.equal(host.coordinationDatabases?.size || 0, 0);
    database.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  return f;
}

test("native Registry reuses an admitted generation and physically replaces none/E5 owners", async t => {
  const f = fixture(t, { provider: "none" }); f.write("MEMORY.md", "Amber observatory remembers a telescope.");
  const acquire = f.index.registry.acquire; let acquisitions = 0;
  t.mock.method(f.index.registry, "acquire", function (...args) { acquisitions++; return acquire.apply(this, args); });
  const first = await f.ready(), registry = f.index.registry;
  await f.index.sync(); assert.equal(f.index.searchOwner, first);
  assert.match(first.cacheKey, /^one:.*:default$/u);
  f.config.memory.search.provider = "shoggoth-e5"; await f.index.sync();
  const semantic = f.index.searchOwner;
  assert.notEqual(semantic, first); assert.equal(first.closed, true); assert.equal(first.executor.closed, true);
  assert.equal(semantic.registry, registry); assert.equal(f.index.searchOwners.size, 1); assert.equal(f.index.embeddingExecutors.size, 1);
  assert.equal(f.chunks()[0].model, f.index.embedding.identity);
  assert.equal((await f.run(() => semantic.probeEmbeddingAvailability())).ok, true);
  f.config.memory.search.provider = "none"; await f.index.sync();
  assert.equal(semantic.closed, true); assert.equal(semantic.providersPendingRetirement.size, 0);
  assert.equal(f.index.searchOwner.registry, registry); assert.equal(f.chunks()[0].model, "fts-only");
  assert.equal(f.index.embeddingExecutor.provider, null); assert.ok(acquisitions >= 4);
});

test("a changed Product revision replaces a manager even when its native cache key is identical", async t => {
  const f = fixture(t); f.write("MEMORY.md", "Amber observatory."); const first = await f.ready(), key = first.cacheKey;
  f.config._shoggothConfigRevision++; await f.index.sync();
  assert.equal(first.closed, true); assert.notEqual(f.index.searchOwner, first);
  assert.equal(f.index.searchOwner.cacheKey, key); assert.equal(f.index.searchOwners.size, 1);
});

test("a retired native probe cannot publish a cancelled result into the replacement's identical cache key", { timeout: 15_000 }, async t => {
  const entered = deferred(), gate = deferred(); let blocked = true;
  const f = fixture(t, { encode: async text => {
    if (blocked && text === "ping") { entered.resolve(); await gate.promise; }
    return [1, 0];
  } });
  f.cleanup(() => gate.resolve()); f.write("MEMORY.md", "Amber observatory."); const old = await f.ready(), key = old.cacheKey;
  await f.run(() => old.ensureProviderInitialized());
  const probing = f.run(() => old.probeEmbeddingAvailability());
  const rejected = assert.rejects(probing, { code: "MEMORY_CONFIG_CHANGED" });
  await entered.promise; assert.equal(old.embeddingProbeCache.has(key), false);
  f.config._shoggothConfigRevision++;
  let completed = false; const replacing = f.index.sync().then(() => { completed = true; });
  try {
    await rejected; await tick();
    assert.equal(completed, false, "physical ping retirement still owns the replacement barrier");
    assert.equal(old.closing, true); assert.equal(old.closed, false); assert.equal(old.executor.closed, true);
    assert.equal(old.embeddingProbeCache.has(key), false, "the old cancelled native catch cannot poison shared cache");
  } finally { blocked = false; gate.resolve(); }
  await replacing;
  const current = f.index.searchOwner; assert.notEqual(current, old); assert.equal(current.cacheKey, key);
  assert.equal(current.getCachedEmbeddingAvailability(), null);
  const fresh = await f.run(() => current.probeEmbeddingAvailability());
  assert.equal(fresh.ok, true); assert.notEqual(fresh.cached, true);
  assert.equal(current.getCachedEmbeddingAvailability().ok, true);
  assert.equal(f.calls.filter(call => call.text === "ping").length, 2, "the current owner must perform its own healthy ping");
});

test("native Registry waits for actual provider retirement before installing a replacement", { timeout: 15_000 }, async t => {
  const entered = deferred(), gate = deferred(); let closes = 0;
  const f = fixture(t, { close: async close => { closes++; entered.resolve(); await gate.promise; await close(); } });
  f.cleanup(() => gate.resolve()); f.write("MEMORY.md", "Amber observatory."); const old = await f.ready();
  await f.run(() => old.probeEmbeddingAvailability()); const before = f.chunks();
  f.config.memory.search.provider = "none";
  let settled = false; const reload = f.index.sync().then(() => { settled = true; });
  try {
    await entered.promise; await tick();
    assert.equal(settled, false); assert.equal(f.index.searchOwner, old); assert.equal(old.closing, true);
    assert.equal(old.closed, false); assert.equal(f.index.searchOwners.size, 1);
    assert.equal(f.index.embeddingExecutor, old.executor); assert.equal(old.executor.closed, true);
    assert.deepEqual(f.chunks(), before, "retirement alone cannot publish replacement rows");
    assert.ok(old.registry.getProbeOwners(old).length > 0); assert.equal(closes, 1);
  } finally { gate.resolve(); }
  await reload; assert.equal(old.closed, true); assert.equal(f.chunks()[0].model, "fts-only");
  assert.notEqual(f.index.searchOwner, old);
});

test("failed native retirement retains its manager and blocks creation until a later retry succeeds", async t => {
  let attempts = 0;
  const f = fixture(t, { close: async close => { if (++attempts <= 2) throw new Error("Fixture provider retirement failed"); await close(); } });
  f.write("MEMORY.md", "Amber observatory."); const old = await f.ready();
  await f.run(() => old.probeEmbeddingAvailability()); const before = f.chunks(), handle = old.provider;
  f.config.memory.search.query = { maxResults: 2 };
  await assert.rejects(f.index.sync(), error => error instanceof AggregateError && /retire/i.test(error.message));
  assert.equal(attempts, 2); assert.equal(f.index.searchOwner, old); assert.equal(old.closed, false);
  assert.ok(old.providersPendingRetirement.has(handle)); assert.deepEqual(f.chunks(), before);
  assert.equal(f.index.searchOwners.size, 1); assert.equal(f.handles.length, 1);
  await f.index.sync(); assert.equal(attempts, 3); assert.equal(old.closed, true);
  assert.notEqual(f.index.searchOwner, old); assert.deepEqual(f.chunks(), before);
});

test("configuration replacement rejects an old query but joins its physical embedding before reuse", { timeout: 15_000 }, async t => {
  const entered = deferred(), gate = deferred(); let block = false;
  const f = fixture(t, { encode: async (_text, purpose) => { if (block && purpose === "query") { entered.resolve(); await gate.promise; } return [1, 0]; } });
  f.cleanup(() => gate.resolve()); f.write("MEMORY.md", "Amber observatory telescope."); const old = await f.ready();
  block = true; const query = f.index.search("Amber observatory", { minScore: 0, record: false });
  const rejected = assert.rejects(query, { code: "MEMORY_CONFIG_CHANGED" });
  await entered.promise; const before = f.chunks(); f.config.memory.search.provider = "none";
  let reloaded = false; const reload = f.index.sync().then(() => { reloaded = true; });
  try {
    await rejected; await tick(); assert.equal(reloaded, false);
    assert.equal(f.index.searchOwner, old); assert.equal(f.index.db.isOpen, true);
    assert.ok(old.executor.pending.size > 0); assert.deepEqual(f.chunks(), before);
  } finally { gate.resolve(); }
  await reload; assert.equal(old.closed, true); assert.equal(old.executor.pending.size, 0);
  assert.equal(f.chunks()[0].model, "fts-only");
});

test("disabled search drains the native scope and does not construct a providerless replacement", async t => {
  const f = fixture(t); f.write("MEMORY.md", "Amber observatory."); const old = await f.ready();
  await f.run(() => old.probeEmbeddingAvailability()); const before = f.chunks(), handles = f.handles.length;
  f.config.memory.search.enabled = false; await f.index.sync();
  assert.equal(old.closed, true); assert.equal(f.index.searchOwner, null); assert.equal(f.index.embeddingExecutor, null);
  assert.equal(f.index.searchOwners.size, 0); assert.equal(f.index.embeddingExecutors.size, 0);
  assert.equal(f.handles.length, handles); assert.deepEqual(f.chunks(), before);
  assert.deepEqual(await f.index.search("Amber", { record: false }), []);
  assert.deepEqual(await f.index.listTriggerCandidates({ limit: 24 }), []);
  f.config.memory.search.enabled = true; await f.index.sync();
  assert.ok(f.index.searchOwner); assert.notEqual(f.index.searchOwner, old); assert.deepEqual(f.chunks(), before);
});

test("native replacement releases an old manager caller queued behind the config pass without waiting on itself", { timeout: 15_000 }, async t => {
  const f = fixture(t, { provider: "none", sources: ["sessions"] }); f.put("alpha", "User: Amber observatory.");
  const old = await f.ready(), entered = deferred(), gate = deferred(), original = f.index.syncFiles;
  f.cleanup(() => gate.resolve()); let gated = false;
  t.mock.method(f.index, "syncFiles", async function (...args) {
    if (!gated) { gated = true; entered.resolve(); await gate.promise; }
    return original.apply(this, args);
  });
  // A is a public pass before settings have been resolved. B enters the old
  // manager's active-operation counter and queues physically behind A.
  const independent = f.index.sync(); await entered.promise;
  const queued = old.sync({ sessions: [f.target("alpha")] });
  const rejected = assert.rejects(queued, { code: "MEMORY_EMBEDDING_CANCELLED" });
  await until(() => old.activeManagerOperations > 0 && Boolean(old.syncing), "old manager must own the queued logical call");
  f.config._shoggothConfigRevision++; gate.resolve();
  await independent; await rejected; await f.index.tail.catch(() => {});
  assert.equal(old.closed, true); assert.equal(old.activeManagerOperations, 0);
  assert.notEqual(f.index.searchOwner, old); assert.equal(f.index.searchOwners.size, 1);
  assert.match(f.text("alpha"), /Amber/u);
});

test("full and incremental synchronization report progress through the original native state", async t => {
  const f = fixture(t, { provider: "none", sources: ["memory", "sessions"] }), full = [], incremental = [];
  f.write("MEMORY.md", "Amber observatory."); f.put("alpha", "User: Violet telescope.");
  await f.index.sync({ force: true, nativeParams: { progress: update => full.push({ ...update }) } });
  assert.ok(full.length > 0); assert.ok(full.some(update => update.total > 0));
  assert.equal(full.at(-1).completed, full.at(-1).total);
  const executor = f.index.embeddingExecutor, create = executor.createSyncProgress; let states = 0;
  t.mock.method(executor, "createSyncProgress", function (...args) { states++; return create.apply(this, args); });
  f.put("alpha", "User: Violet telescope changed.", 2);
  await f.index.sync({ nativeParams: { progress: update => incremental.push({ ...update }) } });
  assert.equal(states, 1); assert.ok(incremental.length > 0);
  assert.equal(incremental.at(-1).completed, incremental.at(-1).total); assert.match(f.text("alpha"), /changed/u);
});

test("native targeted progress reaches a direct caller and both queued waiters, then releases callbacks", async t => {
  const f = fixture(t, { provider: "none", sources: ["sessions"] });
  for (const id of ["alpha", "beta", "gamma"]) f.put(id, `User: ${id} baseline.`);
  const owner = await f.ready(), entered = deferred(), gate = deferred(), original = f.index.embeddingExecutor.syncArchiveFiles;
  f.cleanup(() => gate.resolve()); let gated = false;
  t.mock.method(f.index.embeddingExecutor, "syncArchiveFiles", async function (request) {
    if (!gated && request.targetArchiveFiles?.some(file => file.endsWith("alpha"))) { gated = true; entered.resolve(); await gate.promise; }
    return original.call(this, request);
  });
  for (const id of ["alpha", "beta", "gamma"]) f.put(id, `User: ${id} changed.`, 2);
  const direct = [], firstQueued = [], secondQueued = [];
  const first = owner.sync({ sessions: [f.target("alpha")], progress: update => direct.push({ ...update }) });
  await entered.promise;
  const second = owner.sync({ sessions: [f.target("beta")], progress: update => firstQueued.push({ ...update }) });
  const third = owner.sync({ sessions: [f.target("gamma")], progress: update => secondQueued.push({ ...update }) });
  gate.resolve(); await Promise.all([first, second, third]);
  assert.ok(direct.length > 0); assert.ok(firstQueued.length > 0); assert.deepEqual(firstQueued, secondQueued);
  assert.equal(direct.at(-1).completed, 1); assert.equal(firstQueued.at(-1).completed, 2);
  assert.equal(owner.sessionSyncQueue.progressCallbacks.size, 0); assert.equal(owner.sessionSyncQueue.pending, null);
  const counts = [direct.length, firstQueued.length, secondQueued.length];
  await owner.sync({ sessions: [f.target("alpha")] });
  assert.deepEqual([direct.length, firstQueued.length, secondQueued.length], counts);
  for (const id of ["alpha", "beta", "gamma"]) assert.match(f.text(id), /changed/u);
});

test("native targeted failure releases rejected waiters' progress callbacks before retaining retry targets", async t => {
  const f = fixture(t, { provider: "none", sources: ["sessions"] });
  for (const id of ["alpha", "beta", "gamma"]) f.put(id, `User: ${id} baseline.`);
  const owner = await f.ready(), entered = deferred(), gate = deferred(), original = f.index.embeddingExecutor.syncArchiveFiles;
  f.cleanup(() => gate.resolve()); let gated = false, failed = false;
  t.mock.method(f.index.embeddingExecutor, "syncArchiveFiles", async function (request) {
    if (!gated && request.targetArchiveFiles?.some(file => file.endsWith("alpha"))) { gated = true; entered.resolve(); await gate.promise; }
    if (!failed && request.targetArchiveFiles?.some(file => file.endsWith("beta"))) { failed = true; throw new Error("Fixture targeted publication failed"); }
    return original.call(this, request);
  });
  f.put("alpha", "User: alpha changed.", 2); f.put("beta", "User: beta changed.", 2);
  const first = owner.sync({ sessions: [f.target("alpha")] }); await entered.promise;
  const oldProgress = [], firstWaiter = owner.sync({ sessions: [f.target("beta")], progress: update => oldProgress.push({ ...update }) });
  const secondWaiter = owner.sync({ sessions: [f.target("beta")], progress: update => oldProgress.push({ ...update }) });
  const rejected = Promise.all([assert.rejects(firstWaiter, /Fixture targeted publication failed/u), assert.rejects(secondWaiter, /Fixture targeted publication failed/u)]);
  gate.resolve(); await first; await rejected;
  assert.equal(owner.sessionSyncQueue.progressCallbacks.size, 0); assert.equal(owner.sessionSyncQueue.pending, null);
  assert.equal(owner.sessionSyncQueue.hasPending, true); const oldCount = oldProgress.length, retryProgress = [];
  f.put("gamma", "User: gamma changed.", 2);
  await owner.sync({ sessions: [f.target("gamma")], progress: update => retryProgress.push({ ...update }) });
  assert.ok(retryProgress.length > 0); assert.equal(oldProgress.length, oldCount);
  assert.equal(owner.sessionSyncQueue.hasPending, false); assert.match(f.text("beta"), /changed/u); assert.match(f.text("gamma"), /changed/u);
});

test("catalog retirement closes the native owner without new inference and preserves derived rows for the next caller", async t => {
  const f = fixture(t); f.write("MEMORY.md", "Amber observatory."); const old = await f.ready();
  await f.run(() => old.probeEmbeddingAvailability());
  const rows = f.chunks(), calls = f.calls.length, handles = f.handles.length;
  await f.index.retireProviderOwner();
  assert.equal(old.closed, true); assert.equal(old.executor.closed, true);
  assert.equal(f.index.searchOwner, null); assert.equal(f.index.embeddingExecutor, null);
  assert.equal(f.index.searchOwners.size, 0); assert.equal(f.index.embeddingExecutors.size, 0);
  assert.equal(f.calls.length, calls); assert.equal(f.handles.length, handles);
  assert.deepEqual(f.chunks(), rows); assert.equal(f.index.db.isOpen, true);
  await f.index.sync(); assert.ok(f.index.searchOwner); assert.notEqual(f.index.searchOwner, old);
  assert.deepEqual(f.chunks(), rows);
});
test("catalog retirement waits for the old admitted physical inference without creating replacement", { timeout: 15_000 }, async t => {
  const entered = deferred(), gate = deferred(); let block = false;
  const f = fixture(t, { encode: async (text) => { if (block && text === "ping") { entered.resolve(); await gate.promise; } return [1, 0]; } });
  f.cleanup(() => gate.resolve()); f.write("MEMORY.md", "Amber observatory."); const old = await f.ready();
  block = true; const probe = f.run(() => old.probeEmbeddingAvailability());
  // The rejected probe is logically finished before its admitted encode tail.
  const probeObserved = probe.catch(() => {});
  await entered.promise; let retired = false;
  const retiring = f.index.retireProviderOwner().then(() => { retired = true; });
  await tick(); await tick(); assert.equal(retired, false); assert.equal(f.index.searchOwner, old);
  assert.equal(f.index.db.isOpen, true); assert.ok(old.executor.pending.size > 0);
  gate.resolve(); await probeObserved; await retiring;
  assert.equal(retired, true); assert.equal(old.closed, true); assert.equal(old.executor.pending.size, 0);
  assert.equal(f.index.searchOwner, null); assert.equal(f.index.searchOwners.size, 0);
});
test("failed catalog retirement retains its owner for a verified close retry", async t => {
  let refuse = true, attempts = 0;
  const f = fixture(t, { close: async close => { attempts++; if (refuse) throw Error("synthetic retirement failure"); await close(); } });
  f.write("MEMORY.md", "Amber observatory."); const old = await f.ready();
  await f.run(() => old.probeEmbeddingAvailability()); const before = f.chunks();
  await assert.rejects(f.index.retireProviderOwner());
  assert.equal(old.closed, false); assert.equal(f.index.searchOwner, old); assert.ok(old.providersPendingRetirement.size > 0);
  assert.deepEqual(f.chunks(), before);
  refuse = false; await f.index.retireProviderOwner();
  assert.equal(old.closed, true); assert.equal(old.providersPendingRetirement.size, 0);
  assert.equal(f.index.searchOwner, null); assert.ok(attempts >= 2); assert.deepEqual(f.chunks(), before);
});
