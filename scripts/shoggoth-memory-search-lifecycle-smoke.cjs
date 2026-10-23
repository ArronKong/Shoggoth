"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MemoryDatabase } = require("../app/agent-service/shoggoth-memory/database.cjs");
const { ShoggothMemoryHost, core } = require("../app/agent-service/shoggoth-memory/host.cjs");
const { MemorySearchIndex } = require("../app/agent-service/shoggoth-memory/search-index.cjs");

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-memory-search-lifecycle-"));
  const paths = { trustedRoot: root, stateDir: path.join(root, "state"), agentsDir: path.join(root, "agents") };
  const workspace = path.join(root, "one");
  fs.mkdirSync(path.join(workspace, "memory"), { recursive: true, mode: 0o700 });
  const database = new MemoryDatabase({ paths });
  database.open();
  const calls = [], cleanups = [];
  let visible = true;
  const embedding = Object.hasOwn(options, "embedding") ? options.embedding : {
    identity: "fixture-search-lifecycle-v1",
    encode: async (text, purpose, request) => {
      calls.push({ text, purpose });
      return options.encode ? options.encode(text, purpose, request) : [1, 0];
    },
  };
  const host = new ShoggothMemoryHost({ database, paths, profileId: "one", workspaceDir: workspace,
    roster: () => [{ id: "one", workspace }], sessions: { list: () => [], read: () => null } });
  // The native local adapter consumes these isolated constructor resources.
  // No Product Vault, real embedding process or network endpoint is involved.
  const config = { memory: { search: { provider: "shoggoth-e5", cache: { enabled: true } } } };
  const index = new MemorySearchIndex({ host, databasePath: database.path, sharedDatabase: true, embedding,
    getConfig: () => config, allow: () => visible, logger: { debug() {}, warn() {} } });
  const f = { root, paths, workspace, database, host, index, config, embedding, calls,
    run: action => host.run(action),
    write: (name, content) => fs.writeFileSync(path.join(workspace, name), content, { mode: 0o600 }),
    withdraw: () => { visible = false; },
    cleanup: action => cleanups.push(action),
  };
  t.after(async () => {
    for (const cleanup of cleanups) cleanup();
    await index.close();
    assert.equal(host.coordinationDatabases?.size || 0, 0, "native retrieval leases must physically close");
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return f;
}

test("Product search executes the native orchestration and prepares keyword/index state together", async t => {
  const f = fixture(t);
  f.write("MEMORY.md", "Amber observatory remembers the violet telescope.");
  await f.index.sync();
  assert.ok(f.index.searchOwner instanceof core.MemorySearchOrchestration);
  const nativeSearch = core.MemorySearchOrchestration.prototype.search;
  let nativeCalls = 0;
  t.mock.method(core.MemorySearchOrchestration.prototype, "search", function (...args) {
    nativeCalls++;
    return nativeSearch.apply(this, args);
  });
  const keywordSearch = f.host.runMemoryKeywordSearch, prepared = [];
  t.mock.method(f.host, "runMemoryKeywordSearch", async function (...args) {
    const result = await keywordSearch.apply(this, args);
    if (args[3]) prepared.push(result);
    return result;
  });
  const results = await f.index.search("Amber observatory", { minScore: 0, record: false });
  assert.equal(nativeCalls, 1);
  assert.ok(results.some(result => result.path === "MEMORY.md" && result.snippet.includes("Amber")));
  assert.ok(prepared.length > 0, "the native preparation must request a captured retrieval index state");
  for (const result of prepared) {
    assert.equal(result.kind, "keyword");
    assert.equal(result.indexState.hasIndexedChunks, true);
    assert.equal(result.indexState.meta.provider, "shoggoth-e5");
    assert.ok(Array.isArray(result.body.rows));
    assert.ok(Array.isArray(result.path.rows));
  }
});

test("native availability probes retain their 30-second TTL and belong to their own search owner", async t => {
  const first = fixture(t), second = fixture(t);
  first.write("MEMORY.md", "Amber observatory.");
  second.write("MEMORY.md", "Violet telescope.");
  await first.index.sync();
  await second.index.sync();
  const firstOwner = first.index.searchOwner, secondOwner = second.index.searchOwner;
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const pingCount = f => f.calls.filter(call => call.text === "ping").length;
  assert.equal((await first.run(() => firstOwner.probeEmbeddingAvailability())).ok, true);
  assert.equal(pingCount(first), 1);
  assert.equal(secondOwner.getCachedEmbeddingAvailability(), null);
  const cached = await first.run(() => firstOwner.probeEmbeddingAvailability());
  assert.equal(cached.cached, true);
  assert.equal(cached.checkedAtMs, clock);
  assert.equal(cached.cacheExpiresAtMs, clock + 30_000);
  assert.equal(pingCount(first), 1);
  assert.equal((await second.run(() => secondOwner.probeEmbeddingAvailability())).ok, true);
  assert.equal(pingCount(second), 1, "one owner's cached probe must not suppress another owner's request");
  clock += 29_999;
  assert.equal((await first.run(() => firstOwner.probeEmbeddingAvailability())).cached, true);
  assert.equal(pingCount(first), 1);
  clock += 1;
  assert.equal(firstOwner.getCachedEmbeddingAvailability(), null);
  assert.equal((await first.run(() => firstOwner.probeEmbeddingAvailability())).ok, true);
  assert.equal(pingCount(first), 2, "expiration must perform a new native probe");
});

test("a configured but absent local provider degrades through native bootstrap state and keeps lexical recall", async t => {
  const f = fixture(t, { embedding: null }), debug = [];
  f.write("MEMORY.md", "Amber observatory remains available through keyword recall.");
  const results = await f.index.search("Amber observatory", { minScore: 0, record: false, onDebug: value => debug.push(value) });
  assert.ok(results.some(result => result.path === "MEMORY.md" && result.snippet.includes("Amber")));
  const failure = debug.find(value => value.embeddingBootstrap)?.embeddingBootstrap;
  assert.equal(failure?.ok, false);
  assert.equal(failure?.degradedTo, "keyword-only");
  assert.equal(failure?.provider, "shoggoth-e5");
  const owner = f.index.searchOwner;
  assert.equal(owner.provider, null);
  assert.equal(owner.providerLifecycle.mode, "degraded");
  assert.equal(owner.getCachedEmbeddingAvailability()?.ok, false);
  const source = f.database.db.prepare("SELECT hash FROM memory_index_sources WHERE path=? AND source='memory'").get("MEMORY.md");
  assert.ok(source?.hash, "provider initialization failure must preserve the admitted text source");
  assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM memory_index_chunks WHERE model<>'fts-only'").get().n, 0);
});

test("withdrawal between native keyword preparation and partial acceptance removes both partial and final recall", { timeout: 15_000 }, async t => {
  const started = deferred(), gate = deferred();
  const f = fixture(t, { encode: async (_text, purpose) => {
    if (purpose === "passage") return [1, 0];
    started.resolve();
    return gate.promise;
  } });
  f.cleanup(() => gate.resolve([1, 0]));
  f.write("MEMORY.md", "Amber observatory remembers the violet telescope.");
  await f.index.sync();
  const keywordSearch = f.host.runMemoryKeywordSearch;
  t.mock.method(f.host, "runMemoryKeywordSearch", async function (...args) {
    const result = await keywordSearch.apply(this, args);
    if (args[3]) f.withdraw();
    return result;
  });
  const partial = [];
  const operation = f.index.search("Amber observatory", { minScore: 0, record: false,
    onPartialResults: value => partial.push(value) });
  try {
    await started.promise;
    assert.ok(partial.some(Array.isArray), "the native semantic path must attempt a lexical partial delivery");
    assert.ok(partial.every(value => value === null || value.length === 0), "withdrawn candidates cannot cross the Product acceptance boundary");
  } finally { gate.resolve([1, 0]); }
  assert.deepEqual(await operation, []);
});

test("cancelling after native lexical partial recall prevents late results and recall receipts", { timeout: 15_000 }, async t => {
  const started = deferred(), gate = deferred(), controller = new AbortController();
  const f = fixture(t, { encode: async (_text, purpose) => {
    if (purpose === "passage") return [1, 0];
    started.resolve();
    return gate.promise;
  } });
  f.cleanup(() => gate.resolve([1, 0]));
  f.write("MEMORY.md", "Amber observatory remembers the violet telescope.");
  await f.index.sync();
  const partial = [], prune = f.host.pruneUnavailableLibraryCandidates;
  let receipts = 0;
  t.mock.method(f.host, "pruneUnavailableLibraryCandidates", async function (...args) {
    receipts++;
    return prune.apply(this, args);
  });
  const operation = f.index.search("Amber observatory", { minScore: 0, signal: controller.signal,
    onPartialResults: value => partial.push(value) });
  const rejected = assert.rejects(operation, /fixture query cancelled/);
  try {
    await started.promise;
    assert.ok(partial.some(value => Array.isArray(value) && value.length > 0));
    controller.abort(new Error("fixture query cancelled"));
    await rejected;
    const acceptedPartials = partial.filter(Array.isArray).length;
    gate.resolve([1, 0]);
    await tick();
    await tick();
    assert.equal(partial.filter(Array.isArray).length, acceptedPartials, "physical completion after cancellation cannot deliver new partial recall");
    assert.equal(receipts, 0);
    assert.equal(f.calls.filter(call => call.purpose === "query").length, 1);
    assert.equal(f.index.searches.size, 0);
  } finally { gate.resolve([1, 0]); }
});

test("a failed native provider retirement retains its owner and a subsequent close can retry", async t => {
  const f = fixture(t);
  f.write("MEMORY.md", "Amber observatory.");
  await f.index.sync();
  const owner = f.index.searchOwner;
  assert.equal((await f.run(() => owner.probeEmbeddingAvailability())).ok, true);
  const provider = owner.provider, close = provider.close;
  let attempts = 0;
  provider.close = async function () {
    if (++attempts <= 2) throw new Error("fixture native handle retirement failed");
    return close.call(this);
  };
  await assert.rejects(f.run(() => owner.close()), error => error instanceof AggregateError && /retire/i.test(error.message));
  assert.equal(attempts, 2, "the original retirement drain must exhaust its bounded retries");
  assert.ok(owner.providersPendingRetirement.has(provider));
  assert.ok(owner.registry.getProbeOwners(owner).length > 0, "failed cleanup must retain the provider's lifecycle owner");
  await f.run(() => owner.close());
  assert.equal(attempts, 3);
  assert.equal(owner.providersPendingRetirement.size, 0);
  assert.equal(owner.closed, true);
  assert.deepEqual(owner.registry.getProbeOwners(owner), []);
});

test("native owner shutdown drains physical E5 work without closing the shared Service resource", { timeout: 15_000 }, async t => {
  const started = deferred(), gate = deferred();
  let sharedClosed = false, sharedCloseCalls = 0;
  const embedding = {
    identity: "fixture-shared-e5-v1",
    encode: async (_text, purpose) => {
      assert.equal(sharedClosed, false, "an index retirement cannot close the shared encoder");
      if (purpose === "passage") return [1, 0];
      started.resolve();
      return gate.promise;
    },
    close: async () => { sharedCloseCalls++; sharedClosed = true; },
  };
  const f = fixture(t, { embedding });
  f.cleanup(() => gate.resolve([1, 0]));
  f.write("MEMORY.md", "Amber observatory.");
  await f.index.sync();
  const operation = f.index.search("Amber observatory", { minScore: 0, record: false });
  const rejected = assert.rejects(operation, { code: "MEMORY_EMBEDDING_CANCELLED" });
  let drained = false;
  try {
    await started.promise;
    const closing = f.index.close().then(() => { drained = true; });
    await rejected;
    await tick();
    assert.equal(drained, false, "caller cancellation must not imply that the physical encoder request ended");
    assert.ok(f.index.db?.isOpen, "the admitted database must survive until the provider handle drains");
    gate.resolve([1, 0]);
    await closing;
    assert.equal(f.index.db, null);
    assert.equal(sharedCloseCalls, 0);
    const next = fixture(t, { embedding });
    next.write("MEMORY.md", "Violet telescope.");
    const results = await next.index.search("Violet telescope", { minScore: 0, record: false });
    assert.ok(results.some(result => result.path === "MEMORY.md"));
    assert.equal(sharedCloseCalls, 0, "another index must remain able to use the shared Service encoder");
  } finally { gate.resolve([1, 0]); }
});
