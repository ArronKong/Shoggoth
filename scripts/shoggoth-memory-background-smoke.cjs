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
async function until(check, label, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() >= deadline) assert.fail(label); await new Promise(resolve => setTimeout(resolve, 20)); }
}
function value(content, revision = 1) {
  const lineMap = [revision], lineProvenance = [{ originClass: "owner", sessionKind: "interactive", observedAt: 100 }];
  return { content, revisionMs: revision, mtimeMs: 100, size: Buffer.byteLength(content), lineMap,
    messageTimestampsMs: [100], lineProvenance, sessionKind: "interactive", authorityStamp: `${revision}:${content}`,
    hash: core.hashSessionEntrySnapshot({ content, lineMap, messageTimestampsMs: [100], lineProvenance, resetRecallCutoff: null }) };
}
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-memory-background-"));
  const paths = { trustedRoot: root, stateDir: path.join(root, "state"), agentsDir: path.join(root, "agents") };
  const workspace = path.join(root, "one");
  fs.mkdirSync(path.join(workspace, "memory"), { recursive: true, mode: 0o700 });
  const database = new MemoryDatabase({ paths }); database.open();
  const sessions = new Map(), listeners = new Set(), reads = [], encodes = [], warnings = [];
  const resource = {
    requiresStartupContentRecheck: true,
    list: () => [...sessions].map(([id, item]) => ({ id, sessionKey: `agent:one:chat:${id}`, interactive: true, updatedAt: item.mtimeMs })),
    read: (_profile, id) => { reads.push(id); const item = sessions.get(id); if (!item) throw Object.assign(new Error("Withdrawn"), { code: "MEMORY_SESSION_REVOKED" }); return { ...item }; },
    stat: (_profile, id) => ({ ...sessions.get(id) }),
    metadata: () => ({ channel: "webchat", chatType: "direct" }),
    subscribeChanges: (listener, { signal }) => {
      listeners.add(listener);
      const stop = () => { listeners.delete(listener); signal.removeEventListener("abort", stop); };
      signal.addEventListener("abort", stop, { once: true });
      return stop;
    },
  };
  const config = { memory: { search: { provider: options.embedding ? "shoggoth-e5" : "none", sources: options.sources || ["sessions"],
    cache: { enabled: true }, sync: { watch: options.watch || false, watchDebounceMs: 30, intervalMinutes: options.intervalMinutes || 0 } } } };
  const embedding = options.embedding && { identity: "fixture-background-e5-v1", encode: async (text, purpose) => {
    encodes.push(text); return options.embedding(text, purpose);
  } };
  const host = new ShoggothMemoryHost({ database, paths, profileId: "one", workspaceDir: workspace,
    roster: () => [{ id: "one", workspace }], sessions: resource });
  const index = new MemorySearchIndex({ host, databasePath: database.path, sharedDatabase: true, embedding,
    getConfig: () => config, logger: { debug() {}, warn: message => warnings.push(message) } });
  const f = { root, paths, workspace, database, host, index, config, sessions, listeners, reads, encodes, warnings,
    put: (id, content, revision = 1) => sessions.set(id, value(content, revision)),
    notify: update => { for (const listener of listeners) listener(update); },
    target: id => ({ target: { agentId: "one", sessionId: id, sessionKey: `agent:one:chat:${id}` } }),
    source: id => database.db.prepare("SELECT * FROM memory_index_sources WHERE path=? AND source='sessions'").get(index.sessionPath(id)),
    sourceText: id => database.db.prepare("SELECT text FROM memory_index_chunks WHERE path=? AND source='sessions'").get(index.sessionPath(id))?.text,
  };
  t.after(async () => { await index.close(); assert.equal(listeners.size, 0); assert.equal(host.coordinationDatabases?.size || 0, 0);
    database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return f;
}

test("native background startup is Profile-bound and retains one observer owner", async t => {
  const f = fixture(t); f.put("alpha", "User: Amber telescope."); await f.index.sync();
  await until(() => !f.index.searchOwner.activeManagerOperations, "startup must drain");
  await f.index.tail;
  assert.equal(f.listeners.size, 1); assert.equal(f.index.searchOwner.backgroundStarted, true);
  const before = f.source("alpha"); await f.index.sync();
  assert.equal(f.listeners.size, 1); assert.equal(f.source("alpha").hash, before.hash);
  assert.equal(f.index.embeddingExecutor.sessionUnsubscribe, null, "execution and shadow owners must not subscribe");
  await assert.rejects(f.host.run(() => f.host.readMemoryTranscriptStatsInWorker([
    { agentId: "foreign", sessionId: "alpha", storePath: f.database.path },
  ])), { code: "MEMORY_SCOPE_REVOKED" });
});

test("native five-second session window merges later targets and runs outside a caller ALS", { timeout: 20_000 }, async t => {
  const f = fixture(t); f.put("alpha", "User: Amber telescope."); f.put("beta", "User: Violet observatory.");
  await f.index.sync(); await until(() => !f.index.searchOwner.activeManagerOperations, "startup must drain"); await f.index.tail;
  f.reads.length = 0; f.put("alpha", "User: Amber telescope changed.", 2);
  await new Promise(resolve => setImmediate(() => { f.notify(f.target("alpha")); resolve(); }));
  const timer = f.index.searchOwner.sessionWatchTimer; assert.ok(timer);
  f.put("beta", "User: Violet observatory changed.", 2); f.notify(f.target("beta"));
  assert.equal(f.index.searchOwner.sessionWatchTimer, timer, "later updates cannot restart the native first-event window");
  f.notify({ target: { agentId: "foreign", sessionId: "private", sessionKey: "foreign" } });
  await until(() => f.sourceText("alpha")?.includes("changed") && f.sourceText("beta")?.includes("changed"), "native listener must update without search");
  assert.deepEqual([...new Set(f.reads)].sort(), ["alpha", "beta"]);
  assert.equal(f.index.searchOwner.sessionSyncQueue.hasPending, false);
});

test("native target plans avoid unrelated sources and queue later targets behind physical provider work", async t => {
  const entered = deferred(), gate = deferred(); let blocked = false;
  const f = fixture(t, { embedding: async text => { if (blocked && text.includes("changed-alpha")) { entered.resolve(); await gate.promise; } return [1, 0]; } });
  t.after(() => gate.resolve());
  for (const id of ["alpha", "beta", "other"]) f.put(id, `User: ${id} baseline.`);
  await f.index.sync(); await until(() => !f.index.searchOwner.activeManagerOperations, "startup must drain"); await f.index.tail;
  f.reads.length = 0; blocked = true; f.put("alpha", "User: changed-alpha.", 2);
  const owner = f.index.searchOwner;
  const first = owner.sync({ reason: "fixture-target", sessions: [f.target("alpha").target] });
  await entered.promise; f.put("beta", "User: changed-beta.", 2);
  const second = owner.sync({ reason: "fixture-target", sessions: [f.target("beta").target] });
  assert.equal(owner.sessionSyncQueue.hasPending, true);
  gate.resolve(); await Promise.all([first, second]);
  assert.match(f.sourceText("alpha"), /changed-alpha/u); assert.match(f.sourceText("beta"), /changed-beta/u);
  assert.ok(!f.reads.includes("other"), "targeted queue cannot flatten the unrelated transcript");
  assert.equal(owner.sessionSyncQueue.hasPending, false);
});

test("failed native targeted batches retain their targets for the next trigger", async t => {
  const f = fixture(t); for (const id of ["alpha", "beta"]) f.put(id, `User: ${id} baseline.`);
  await f.index.sync(); await until(() => !f.index.searchOwner.activeManagerOperations, "startup must drain"); await f.index.tail;
  const owner = f.index.searchOwner, entered = deferred(), gate = deferred();
  const original = f.index.embeddingExecutor.syncArchiveFiles; let failed = false;
  t.mock.method(f.index.embeddingExecutor, "syncArchiveFiles", async function (request) {
    if (request.targetArchiveFiles?.some(file => file.endsWith("alpha")) && !failed) {
      failed = true; entered.resolve(); await gate.promise; throw new Error("fixture source publication failure");
    }
    return original.call(this, request);
  });
  f.put("alpha", "User: alpha changed.", 2); f.put("beta", "User: beta changed.", 2);
  const first = owner.sync({ sessions: [f.target("alpha").target] });
  const firstFailure = assert.rejects(first, /fixture source publication failure/u); await entered.promise;
  const queued = owner.sync({ sessions: [f.target("alpha").target, f.target("beta").target] });
  // The queue owns this batch after the first active source failure. The
  // queued pass can retry alpha and include beta without dropping either.
  gate.resolve(); await firstFailure; await queued;
  assert.match(f.sourceText("alpha"), /changed/u); assert.match(f.sourceText("beta"), /changed/u);
});

test("Product withdrawal reconciliation deletes absent rows without a foreground query", async t => {
  const f = fixture(t); f.put("alpha", "User: Amber telescope."); f.put("beta", "User: Violet observatory.");
  await f.index.sync(); await until(() => !f.index.searchOwner.activeManagerOperations, "startup must drain"); await f.index.tail;
  f.sessions.delete("alpha"); f.notify({ reconcile: true });
  await until(() => !f.source("alpha"), "withdrawn row must be deleted by native reconcile");
  assert.ok(f.source("beta"));
});

test("a later Product reconcile survives an active sync failure and clears withdrawn rows", async t => {
  const f = fixture(t); for (const id of ["alpha", "beta"]) f.put(id, `User: ${id} baseline.`);
  await f.index.sync(); await until(() => !f.index.searchOwner.activeManagerOperations, "startup must drain"); await f.index.tail;
  const entered = deferred(), gate = deferred(), original = f.index.embeddingExecutor.syncArchiveFiles;
  let failed = false;
  t.mock.method(f.index.embeddingExecutor, "syncArchiveFiles", async function (request) {
    if (request.targetArchiveFiles && !failed) { failed = true; entered.resolve(); await gate.promise; throw new Error("fixture prior publication failed"); }
    return original.call(this, request);
  });
  const active = f.index.searchOwner.sync({ sessions: [f.target("alpha").target] });
  const rejected = assert.rejects(active, /fixture prior publication failed/u); await entered.promise;
  f.sessions.delete("beta"); f.notify({ reconcile: true }); gate.resolve(); await rejected;
  await until(() => !f.source("beta"), "independent reconciliation must run after the older failure");
  assert.ok(f.source("alpha")); assert.equal(f.index.searchOwner.sessionsReconcileDirty, false);
});

test("failed native queue work is adopted by a later idle trigger", async t => {
  const entered = deferred(), gate = deferred(); let block = false;
  const f = fixture(t, { embedding: async text => { if (block && text.includes("changed-alpha")) { entered.resolve(); await gate.promise; } return [1, 0]; } });
  t.after(() => gate.resolve());
  for (const id of ["alpha", "beta"]) f.put(id, `User: ${id} baseline.`);
  await f.index.sync(); await until(() => !f.index.searchOwner.activeManagerOperations, "startup must drain"); await f.index.tail;
  const original = f.index.embeddingExecutor.syncArchiveFiles; let failed = false;
  t.mock.method(f.index.embeddingExecutor, "syncArchiveFiles", async function (request) {
    if (request.targetArchiveFiles?.some(file => file.endsWith("beta")) && !failed) { failed = true; throw new Error("fixture queued publication failed"); }
    return original.call(this, request);
  });
  block = true; f.put("alpha", "User: changed-alpha.", 2);
  const first = f.index.searchOwner.sync({ sessions: [f.target("alpha").target] }); await entered.promise;
  f.put("beta", "User: changed-beta.", 2);
  const queued = f.index.searchOwner.sync({ sessions: [f.target("beta").target] });
  const rejected = assert.rejects(queued, /fixture queued publication failed/u); gate.resolve(); await first; await rejected;
  const owner = f.index.searchOwner;
  assert.equal(owner.sessionSyncQueue.pending, null); assert.equal(owner.sessionSyncQueue.hasPending, true);
  await owner.sync({ sessions: [f.target("alpha").target] });
  assert.equal(owner.sessionSyncQueue.hasPending, false); assert.match(f.sourceText("beta"), /changed-beta/u);
});

test("startup admits same-sequence same-size Product restores to the native hash gate", async t => {
  const f = fixture(t); f.put("alpha", "User: Amber telescope."); await f.index.sync();
  await until(() => !f.index.searchOwner.activeManagerOperations, "startup must drain"); await f.index.tail;
  const first = f.source("alpha");
  f.put("alpha", "User: Azure telescope.");
  const owner = f.index.searchOwner; owner.startupContentRechecked = false;
  owner.ensureSessionStartupCatchup();
  await until(() => f.source("alpha").hash !== first.hash, "same-revision restore must pass through content hashing");
  assert.match(f.sourceText("alpha"), /Azure/u);
  assert.equal(f.source("alpha").mtime, first.mtime); assert.equal(f.source("alpha").size, first.size);
});

test("closing the native owner removes timers, queued metadata and all subscriptions", async t => {
  const f = fixture(t, { intervalMinutes: 60 }); f.put("alpha", "User: Amber telescope."); await f.index.sync();
  await until(() => !f.index.searchOwner.activeManagerOperations, "startup must drain"); await f.index.tail;
  const owner = f.index.searchOwner; f.notify(f.target("alpha")); assert.ok(owner.sessionWatchTimer);
  assert.equal(owner.intervalTimer, null, "pinned public sync normalization keeps intervalMinutes at zero");
  // Exercise the native timer owner with an isolated constructor resource.
  owner.settings.sync.intervalMinutes = 60; owner.ensureIntervalSync(); assert.ok(owner.intervalTimer);
  await f.index.close();
  assert.equal(f.listeners.size, 0); assert.equal(owner.sessionWatchTimer, null); assert.equal(owner.intervalTimer, null);
  assert.equal(owner.sessionSyncQueue.hasPending, false); assert.equal(owner.activeManagerOperations, 0);
  assert.equal(hostCount(f.host), 0);
});
const hostCount = host => host.coordinationDatabases?.size || 0;
