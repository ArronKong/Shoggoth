"use strict";

// Real isolated Product Service and native background SourceSync. No Agent
// search, external Gateway, model process or accelerated native timer is used.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { MemoryIndexRebuild } = require("../app/agent-service/shoggoth-memory/index-rebuild.cjs");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function fixture(t, { provider = "none" } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sg-memory-events-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value), decryptString: value => Buffer.from(value).toString("utf8") };
  const service = createAgentService({ paths, safeStorage, memoryCore: true,
    version: "shoggoth-memory-durable-events-fixture", prewarmMcpAuth: false,
    memoryCoreConfig: {
      memory: { search: { provider, sources: ["sessions"],
        sync: { watch: false, intervalMinutes: 0 }, query: { minScore: 0 } } },
      plugins: { entries: { "memory-core": { config: { dreaming: { enabled: false } } } } },
    },
  });
  let stopped = false, calls = 0;
  t.after(async () => {
    if (!stopped) await service.stop({ notify: false });
    fs.rmSync(root, { recursive: true, force: true });
  });
  await service.start();
  const sourceStores = [["TranscriptStore", service.transcriptStore],
    ["ChatSessionStore", service.chatSessionStore], ["RecallPolicy", service.memoryEngine.recallPolicy]]
    .map(([name, store]) => ({ name, store, serviceSubscriptions: new Set(store.changeSubscriptions) }));
  if (provider === "none") service.memoryEngine.embedding = null;
  service.memoryEngine.complete = async () => { calls++; assert.fail("durable source sync must not invoke a model"); };
  return { root, paths, service, sourceStores, get stopped() { return stopped; }, profileId: DEFAULT_AGENT_PROFILE_ID,
    assertNoModels: () => assert.equal(calls, 0),
    async stop() { await service.stop({ notify: false }); stopped = true; },
  };
}

function completedTurn(f, session, tag, text) {
  const { service, profileId } = f;
  const run = service.workDispatcher.enqueue({ id: `${tag}-run`, profileId, source: "chat",
    sourceId: session.sessionKey, idempotencyKey: `${tag}:direct`, workspace: session.workspace });
  service.workDispatcher.admit(run.id); service.workDispatcher.transition(run.id, "running");
  const event = service.transcriptStore.appendEvent({ profileId, sessionId: session.id,
    id: `${tag}-event`, runId: run.id, kind: "user", content: { text } });
  service.workDispatcher.transition(run.id, "completed");
  assert.equal(service.workDispatcher.getRun(run.id).status, "completed");
  return { run, event };
}

function session(f, tag, text, operationId = `${tag}-session`) {
  const workspace = path.join(f.root, "workspace"); fs.mkdirSync(workspace, { recursive: true });
  const store = f.service.chatSessionStore;
  const created = store.createSession({ profileId: f.profileId, workspace,
    operationId, createdAt: Date.now() });
  store.requestBinding(created.sessionKey, `${tag}-binding`, Date.now());
  store.completeBinding(created.sessionKey, `${tag}-binding`, `${tag}-runtime-session`);
  const ready = store.getSession(created.sessionKey);
  return { session: ready, ...completedTurn(f, ready, tag, text) };
}

function source(index, sessionId) {
  return index.db.prepare("SELECT hash,mtime,size FROM memory_index_sources WHERE source='sessions' AND path=?")
    .get(index.sessionPath(sessionId));
}
function chunks(index, sessionId) {
  return index.db.prepare("SELECT text FROM memory_index_chunks WHERE source='sessions' AND path=? ORDER BY start_line")
    .all(index.sessionPath(sessionId)).map(row => row.text).join("\n");
}
async function openIndex(f) {
  const host = f.service.memoryEngine.host(f.profileId), index = host.searchIndex;
  await index.sync();
  await until(() => index.searchOwner.backgroundStarted && index.searchOwner.activeManagerOperations === 0
    && !index.searchOwner.syncing, "native startup catchup idle");
  return { host, index };
}
function assertNativeListeners(f, count) {
  for (const { name, store, serviceSubscriptions } of f.sourceStores) {
    const retained = f.stopped ? new Set() : serviceSubscriptions;
    assert.equal(store.changeSubscriptions.size, retained.size + count,
      `${name}: exactly ${count} native-index subscriptions; full Service stop retires all observers`);
    for (const subscription of retained) assert.ok(store.changeSubscriptions.has(subscription),
      `${name}: stopping a Profile must preserve other Service source observers`);
  }
}
function assertUnsubscribed(f) { assertNativeListeners(f, 0); }

test("Product archive capture leaves failed worker reads dirty and retries from current source", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const initial = session(f, "archive-worker", "Synthetic violet calibration remains visible.");
  const { host, index } = await openIndex(f);
  const old = chunks(index, initial.session.id);
  const archive = path.join(host.workspaceDir, ".session-source", initial.session.id);
  const work = () => index.sync({ nativeParams: { sessions: [{ agentId: f.profileId,
    sessionId: initial.session.id, sessionKey: initial.session.sessionKey }] } });
  const capture = new AsyncLocalStorage();
  const build = host.buildSessionEntry.bind(host), store = f.service.memoryStore;
  const scan = store.withAsyncReadView.bind(store), stamp = store._filesystemStamp.bind(store);
  let workerReads = 0, synchronousWalks = 0, failNext = true;
  const buildSpy = t.mock.method(host, "buildSessionEntry", (...args) =>
    args[0] === archive ? capture.run(true, () => build(...args)) : build(...args));
  const walker = t.mock.method(store, "_filesystemStamp", (...args) => {
    if (capture.getStore()) synchronousWalks++;
    return stamp(...args);
  });
  const scans = t.mock.method(store, "withAsyncReadView", (profileId, signal, read, scanSignal) => {
    if (capture.getStore()) {
      workerReads++;
      if (failNext) {
        failNext = false;
        throw Object.assign(new Error("archive worker unavailable"), { code: "MEMORY_SCAN_UNAVAILABLE" });
      }
    }
    return scan(profileId, signal, read, scanSignal);
  });
  try {
    completedTurn(f, initial.session, "archive-failed", "Synthetic stale candidate must not reach the index.");
    await assert.rejects(work(), { code: "MEMORY_SCAN_UNAVAILABLE" });
    assert.equal(chunks(index, initial.session.id), old, "failed capture preserves the previous complete index rows");
    assert.equal(index.embeddingExecutor.sessionsDirtyFiles.has(archive), true);
    f.service.transcriptStore.setContextExcluded({ profileId: f.profileId, sessionId: initial.session.id,
      eventId: "archive-failed-event", contextExcluded: true });
    completedTurn(f, initial.session, "archive-retry", "Synthetic current emerald candidate is admitted.");
    await work();
    const indexed = chunks(index, initial.session.id);
    assert.match(indexed, /current emerald candidate/u);
    assert.doesNotMatch(indexed, /stale candidate/u);
    assert.ok(workerReads >= 2);
    assert.equal(synchronousWalks, 0, "archive capture uses a worker projection on both attempts");
    assert.equal(index.embeddingExecutor.sessionsDirtyFiles.has(archive), false);
  } finally { scans.mock.restore(); walker.mock.restore(); buildSpy.mock.restore(); }
});

for (const phase of ["worker proof", "physical send", "stale file proof", "cache publication", "row publication"]) {
  test(`Product index rejects withdrawn session source at ${phase}`, { timeout: 30_000 }, async t => {
    const f = await fixture(t, { provider: "shoggoth-e5" });
    const embedding = f.service.nativeMemorySemanticService.embedding;
    t.mock.method(embedding, "start", async () => {});
    const marker = "New violet freighter source remains private.";
    const initial = session(f, "embedding-proof", "Earlier amber telescope source remains visible.");
    let dispatched = 0, armed = false, reached = false, withdrawn;
    const revoke = () => {
      reached = true;
      f.service.transcriptStore.setContextExcluded({ profileId: f.profileId,
        sessionId: initial.session.id, eventId: withdrawn.id, contextExcluded: true });
    };
    t.mock.method(embedding, "_send", async (method, args) => {
      if (method !== "encode-passage") throw Object.assign(new Error("Fixture indexes Product sessions only"), { code: "E5_WORKER_UNAVAILABLE" });
      if (args.text.includes(marker)) {
        dispatched++;
        if (phase === "cache publication") revoke();
      }
      return Float32Array.of(1, 0);
    });
    const { host, index } = await openIndex(f), executor = index.embeddingExecutor;
    const archive = path.join(host.workspaceDir, ".session-source", initial.session.id);
    const work = () => index.sync({ nativeParams: { sessions: [{ agentId: f.profileId,
      sessionId: initial.session.id, sessionKey: initial.session.sessionKey }] } });
    const oldRows = chunks(index, initial.session.id);
    const cacheRows = () => index.db.prepare("SELECT hash FROM memory_embedding_cache ORDER BY hash").all();
    const oldCache = cacheRows();
    assert.match(oldRows, /amber telescope/u);
    assert.ok(oldCache.length > 0);
    const guarded = new AsyncLocalStorage();
    const store = f.service.memoryStore, scan = store.withAsyncReadView.bind(store), stamp = store._filesystemStamp;
    let walks = 0;
    t.mock.method(f.service.memoryStore, "_filesystemStamp", function(...args) {
      if (guarded.getStore()) walks++;
      return stamp.apply(this, args);
    });
    t.mock.method(store, "withAsyncReadView", (...args) => {
      const caller = new Error().stack;
      if (armed && phase === "worker proof" && !reached && caller.includes("MemoryIndexEmbedding.retainSessionProof")) {
        reached = true;
        throw Object.assign(new Error("index worker unavailable"), { code: "MEMORY_SCAN_UNAVAILABLE" });
      }
      return scan(...args);
    });
    const request = embedding.request.bind(embedding);
    t.mock.method(embedding, "request", (method, args, options) => {
      if (armed && ["physical send", "stale file proof"].includes(phase)
        && method === "encode-passage" && args.text.includes(marker) && !reached) {
        if (phase === "physical send") revoke();
        else {
          reached = true;
          fs.appendFileSync(path.join(host.workspaceDir, "MEMORY.md"), "\nFresh source edit during encoder wait.\n", { mode: 0o600 });
        }
      }
      return guarded.run(true, () => request(method, args, options));
    });
    const mutate = executor.publishedDatabase.withMutation;
    t.mock.method(executor.publishedDatabase, "withMutation", action => mutate(() => {
      if (armed && phase === "row publication" && !reached) revoke();
      return guarded.run(true, action);
    }));
    armed = true;
    ({ event: withdrawn } = completedTurn(f, initial.session, "embedding-new", marker));
    const code = { "worker proof": "MEMORY_SCAN_UNAVAILABLE", "stale file proof": "MEMORY_REVISION_CONFLICT" }[phase] ?? "MEMORY_SESSION_CHANGED";
    await assert.rejects(work(), { code });
    assert.ok(reached);
    assert.equal(dispatched, ["worker proof", "physical send", "stale file proof"].includes(phase) ? 0 : 1);
    assert.equal(chunks(index, initial.session.id), oldRows);
    assert.equal(executor.sessionsDirtyFiles.has(archive), true);
    if (phase !== "row publication") assert.deepEqual(cacheRows(), oldCache);
    assert.equal(walks, 0);
    armed = false;
    if (["worker proof", "stale file proof"].includes(phase)) revoke();
    completedTurn(f, initial.session, "embedding-retry", "Current magenta coastal marker is public.");
    await work();
    assert.match(chunks(index, initial.session.id), /magenta coastal marker/u);
    assert.doesNotMatch(chunks(index, initial.session.id), /violet freighter/u);
    assert.equal(executor.sessionsDirtyFiles.has(archive), false);
  });
}

for (const phase of ["worker unavailable", "session revoked during worker wait", "file edited before commit", "oversized workspace"]) {
  test(`Product shadow publication validates ${phase} without replacing the old index prematurely`, { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    const initial = session(f, "shadow-proof", "Earlier amber telescope remains visible.");
    const { host, index } = await openIndex(f);
    const currentRows = () => index.db.prepare("SELECT id,hash,text FROM memory_index_chunks ORDER BY id").all();
    const currentRevision = () => index.db.prepare("SELECT revision FROM memory_index_state WHERE id=1").get().revision;
    const shadows = () => fs.readdirSync(path.dirname(index.databasePath))
      .filter(name => name.startsWith(`${path.basename(index.databasePath)}.memory-reindex-`));
    const oldRows = currentRows(), oldRevision = currentRevision();
    assert.match(chunks(index, initial.session.id), /amber telescope/u);
    const marker = "New violet freighter is awaiting index publication.";
    const { event } = completedTurn(f, initial.session, "shadow-changed", marker);
    const scope = new AsyncLocalStorage(), store = f.service.memoryStore;
    const scan = store.withAsyncReadView.bind(store), stamp = store._filesystemStamp;
    const publish = MemoryIndexRebuild.prototype.publishShadow;
    const validate = MemoryIndexRebuild.prototype.assertSources;
    let reached = false, armed = true, publicationViews = 0, synchronousWalks = 0;
    const revoke = () => f.service.transcriptStore.setContextExcluded({ profileId: f.profileId,
      sessionId: initial.session.id, eventId: event.id, contextExcluded: true });
    t.mock.method(MemoryIndexRebuild.prototype, "assertSources", function(...args) {
      return scope.run(scope.getStore() || "row validation", () => validate.apply(this, args));
    });
    t.mock.method(MemoryIndexRebuild.prototype, "publishShadow", function(...args) {
      return scope.run("publication", () => publish.apply(this, args));
    });
    t.mock.method(store, "_filesystemStamp", function(...args) {
      if (scope.getStore()) synchronousWalks++;
      return stamp.apply(this, args);
    });
    t.mock.method(store, "withAsyncReadView", async (...args) => {
      if (scope.getStore() === "publication") {
        publicationViews++;
        if (armed && !reached && phase !== "file edited before commit") {
          reached = true;
          if (phase === "worker unavailable" || phase === "oversized workspace") {
            throw Object.assign(new Error(phase), { code: phase === "worker unavailable" ? "MEMORY_SCAN_UNAVAILABLE" : "MEMORY_SCAN_TOO_LARGE" });
          }
          await new Promise(resolve => setImmediate(resolve));
          assert.deepEqual(currentRows(), oldRows, "old rows remain available during the proof wait");
          revoke();
        }
      }
      return scan(...args);
    });
    const execute = index.db.exec.bind(index.db);
    t.mock.method(index.db, "exec", sql => {
      const result = execute(sql);
      if (armed && !reached && phase === "file edited before commit"
        && scope.getStore() === "publication" && sql.includes("DELETE FROM main.memory_index_sources")) {
        reached = true;
        fs.appendFileSync(path.join(host.workspaceDir, "MEMORY.md"), "\nSynthetic edit during shadow transaction.\n", { mode: 0o600 });
      }
      return result;
    });

    const code = { "worker unavailable": "MEMORY_SCAN_UNAVAILABLE",
      "session revoked during worker wait": "MEMORY_SESSION_CHANGED", "file edited before commit": "MEMORY_REVISION_CONFLICT" }[phase];
    if (code) {
      await assert.rejects(index.sync({ force: true }), { code });
      assert.deepEqual(currentRows(), oldRows);
      assert.equal(currentRevision(), oldRevision);
      assert.equal(index.rebuildRetryState.sessionsFullRetryDirty, true);
      assert.equal(synchronousWalks, 0, "authority failure never falls back to a synchronous tree walk");
      if (phase !== "session revoked during worker wait") revoke();
    } else {
      await index.sync({ force: true });
      assert.ok(synchronousWalks > 0, "legacy oversized workspaces use an authoritative synchronous view");
      assert.match(chunks(index, initial.session.id), /violet freighter/u);
      revoke();
    }
    assert.ok(reached);
    assert.equal(publicationViews, 1);
    assert.deepEqual(shadows(), []);

    armed = false; synchronousWalks = 0; publicationViews = 0;
    completedTurn(f, initial.session, "shadow-retry", "Current magenta beacon is ready.");
    await index.sync({ force: true });
    const text = chunks(index, initial.session.id);
    assert.match(text, /magenta beacon/u);
    assert.doesNotMatch(text, /violet freighter/u);
    assert.equal(publicationViews, 1);
    assert.equal(synchronousWalks, 0, "the normal shadow validation and publication use a worker proof");
    assert.equal(index.rebuildRetryState.sessionsFullRetryDirty, false);
    assert.deepEqual(shadows(), []);
  });
}

test("completed transcript commits and context exclusion update native index after the real five-second batch", { timeout: 40_000 }, async t => {
  const f = await fixture(t), initial = session(f, "initial", "Violet calibration remains visible.");
  const { host, index } = await openIndex(f);
  assert.match(chunks(index, initial.session.id), /Violet calibration/u);
  const changes = [], controller = new AbortController();
  const unsubscribe = host.sessions.subscribeChanges(update => changes.push(update),
    { profileId: f.profileId, signal: controller.signal });
  const before = source(index, initial.session.id).hash, started = Date.now();
  const appended = completedTurn(f, initial.session, "late", "Amber telescope arrival must be indexed in the background.");
  await sleep(200);
  assert.deepEqual(changes, [{ target: { agentId: f.profileId,
    sessionId: initial.session.id, sessionKey: initial.session.sessionKey } }]);
  assert.equal(source(index, initial.session.id).hash, before, "native batching does not publish immediately");
  await until(() => chunks(index, initial.session.id).includes("Amber telescope arrival"), "transcript background indexing");
  assert.ok(Date.now() - started >= 4_500, "the actual native 5000ms batching window was used");
  const afterAppend = source(index, initial.session.id).hash;
  f.service.transcriptStore.setContextExcluded({ profileId: f.profileId, sessionId: initial.session.id,
    eventId: appended.event.id, contextExcluded: true });
  await until(() => source(index, initial.session.id)?.hash !== afterAppend
    && !chunks(index, initial.session.id).includes("Amber telescope arrival"), "context exclusion background rewrite");
  assert.match(chunks(index, initial.session.id), /Violet calibration/u);
  controller.abort(); unsubscribe(); unsubscribe();
  const count = changes.length;
  f.service.transcriptStore.setContextExcluded({ profileId: f.profileId, sessionId: initial.session.id,
    eventId: appended.event.id, contextExcluded: false });
  await sleep(100); assert.equal(changes.length, count, "aggregate subscription was canceled");
  f.assertNoModels(); await f.stop(); assertUnsubscribed(f);
  assert.equal(index.db, null); assert.equal(index.searchOwner.closed, true);
});

test("policy withdrawal, Chat deletion, cron classification and Profile purge reconcile without search", { timeout: 40_000 }, async t => {
  const f = await fixture(t);
  const policy = session(f, "policy", "The synthetic orange lighthouse preference should be withdrawn.");
  const deleted = session(f, "deleted", "The synthetic teal lighthouse session should be deleted.");
  const cronRunId = "cron-classification-fixture";
  const cronCreate = `cron-session-${crypto.createHash("sha256").update(cronRunId).digest("hex")}`;
  const cron = session(f, "cron", "The synthetic silver lighthouse must leave the interactive corpus.", cronCreate);
  const survivor = session(f, "survivor", "The synthetic violet lighthouse remains after other removals.");
  const { host, index } = await openIndex(f);
  for (const seeded of [policy, deleted, cron, survivor]) assert.ok(source(index, seeded.session.id));
  const updates = [], unsubscribe = host.sessions.subscribeChanges(update => updates.push(update), { profileId: f.profileId });
  const owner = f.service.memoryEngine;
  const item = await owner.propose({ profileId: f.profileId, scope: "agent", classification: "explicit",
    content: "The synthetic orange lighthouse preference should be withdrawn.",
    sourceRefs: [policy.event.id, policy.run.id] });
  const beforePolicy = source(index, policy.session.id).hash;
  await owner.delete({ profileId: f.profileId, id: item.id, reason: "forgotten", operationId: "policy-withdrawal-fixture" });
  await until(() => !chunks(index, policy.session.id).includes("orange lighthouse")
    && source(index, policy.session.id)?.hash !== beforePolicy, "policy withdrawal source rewrite");
  assert.ok(updates.some(update => update.reconcile === true));
  const store = f.service.chatSessionStore;
  store.requestDelete(deleted.session.sessionKey, "delete-session-fixture", Date.now());
  store.completeRemoteOperation("delete-session-fixture");
  await until(() => !source(index, deleted.session.id), "deleted session stale source cleanup");
  assert.equal(chunks(index, deleted.session.id), "");
  // The public cron API recovers its deterministic create operation, allowing
  // this existing ready session to acquire a durable cron association.
  const classified = store.ensureCronSession({ runId: cronRunId, jobId: "cron-job-fixture", profileId: f.profileId,
    workspace: cron.session.workspace, threadSource: null, runtimeSessionId: cron.session.runtimeSessionId });
  assert.equal(classified.sessionKey, cron.session.sessionKey);
  assert.ok(store.getCronSessionOrigin(cron.session.sessionKey));
  await until(() => !source(index, cron.session.id), "cron classification stale source cleanup");
  assert.match(chunks(index, survivor.session.id), /violet lighthouse/u);
  store.purgeProfile(f.profileId);
  await until(() => index.db.prepare("SELECT count(*) AS n FROM memory_index_sources WHERE source='sessions'").get().n === 0,
    "purged Profile corpus reconciliation");
  assert.equal(index.db.prepare("SELECT count(*) AS n FROM memory_index_chunks WHERE source='sessions'").get().n, 0);
  unsubscribe(); f.assertNoModels(); await f.stop(); assertUnsubscribed(f);
});

test("stopProfile retires observers and resume admits a new native background owner", { timeout: 30_000 }, async t => {
  const f = await fixture(t), initial = session(f, "retirement", "The synthetic copper lighthouse survives owner retirement.");
  const { index } = await openIndex(f), owner = f.service.memoryEngine, oldManager = index.searchOwner;
  // Put a real native session batching timer on the owner being retired.
  completedTurn(f, initial.session, "queued-before-retirement", "Queued synthetic text is recoverable from Product persistence.");
  await sleep(100); assert.ok(oldManager.sessionWatchTimer);
  await owner.stopProfile(f.profileId);
  assert.equal(owner.hosts.has(f.profileId), false); assert.equal(index.db, null);
  assert.equal(oldManager.closed, true); assert.equal(oldManager.sessionWatchTimer, null);
  assertUnsubscribed(f);
  assert.throws(() => owner.host(f.profileId), { code: "MEMORY_SCOPE_REVOKED" },
    "a stopped Profile cannot acquire a replacement index owner");
  await assert.rejects(owner.searchMemory({ profileId: f.profileId, query: "copper lighthouse", lexicalOnly: true }),
    { code: "MEMORY_SCOPE_REVOKED" }, "a public search cannot reopen a stopped Profile");
  assert.equal(owner.hosts.has(f.profileId), false, "rejected admissions leave no replacement SQLite owner");
  assert.equal(index.db, null); assert.equal(oldManager.closed, true);
  assertUnsubscribed(f);
  owner.resumeProfile(f.profileId);
  const next = await openIndex(f);
  assert.notEqual(next.index, index); assert.notEqual(next.index.searchOwner, oldManager);
  await until(() => chunks(next.index, initial.session.id).includes("Queued synthetic text"), "startup recovery after owner retirement");
  assertNativeListeners(f, 1);
  f.assertNoModels(); await f.stop(); assertUnsubscribed(f);
});

test("late policy withdrawal survives an older public index.sync clearing shared session flags", { timeout: 30_000 }, async t => {
  const started = Date.now(), trace = (phase, state) => {
    if (process.env.SHOGGOTH_MEMORY_LATE_TRACE === "1") console.log("[memory-late]", Date.now() - started, phase, state || "");
  };
  trace("fixture:start");
  const f = await fixture(t), initial = session(f, "late-withdrawal", "Synthetic magenta lighthouse preference is withdrawn during sync.");
  trace("fixture:ready");
  const { index } = await openIndex(f), owner = f.service.memoryEngine, manager = index.searchOwner;
  trace("index:idle");
  const item = await owner.propose({ profileId: f.profileId, scope: "agent", classification: "explicit",
    content: "Synthetic magenta lighthouse preference is withdrawn during sync.",
    sourceRefs: [initial.event.id, initial.run.id] });
  trace("propose:done");
  const executor = index.embeddingExecutor, syncArchiveFiles = executor.syncArchiveFiles;
  let enter, release, gateOnce = true;
  const arrived = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  // Pause the actual source pass after its old corpus/source reads, just before
  // native executeSourceSync consumes the shared retry state at successful exit.
  executor.syncArchiveFiles = async function (params) {
    trace("source:enter", { reason: params?.reason, gateOnce });
    const result = await syncArchiveFiles.call(this, params);
    trace("source:read-done", { reason: params?.reason, gateOnce });
    if (gateOnce) { gateOnce = false; enter(); trace("gate:waiting"); await gate; trace("gate:released"); }
    return result;
  };
  trace("direct:start");
  const direct = index.sync(); direct.catch(() => {});
  direct.then(() => trace("direct:resolved"), error => trace("direct:rejected", { code: error?.code, message: error?.message }));
  let deletion;
  try {
    await Promise.race([arrived, direct.then(() => assert.fail("public sync did not reach its native source pass"))]);
    trace("direct:arrived", { syncing: Boolean(manager.syncing), generation: manager.sessionReconcileGeneration });
    assert.equal(manager.syncing, null, "a direct public sync is owned by index.tail, not manager.syncing");
    assert.match(chunks(index, initial.session.id), /magenta lighthouse/u);
    const beforeGeneration = manager.sessionReconcileGeneration;
    // Policy intent commits before the primary FileStore update, which may
    // correctly wait for the public pass's workspace/index-generation lease.
    // Admit the notification first; do not await that primary write while our
    // fixture itself is holding the pass open.
    trace("delete:start");
    deletion = owner.delete({ profileId: f.profileId, id: item.id, reason: "forgotten", operationId: "late-policy-withdrawal" });
    deletion.catch(() => {});
    trace("delete:returned", { generation: manager.sessionReconcileGeneration, syncing: Boolean(manager.syncing) });
    deletion.then(() => trace("delete:resolved"), error => trace("delete:rejected", { code: error?.code, message: error?.message }));
    await until(() => manager.sessionReconcileGeneration > beforeGeneration && Boolean(manager.syncing),
      "policy reconciliation admitted behind the public pass");
    trace("reconcile:admitted", { generation: manager.sessionReconcileGeneration, syncing: Boolean(manager.syncing) });
    release(); await Promise.all([direct, deletion]);
    trace("direct-and-delete:resolved");
    await until(() => !chunks(index, initial.session.id).includes("magenta lighthouse"),
      "late policy withdrawal reconciliation after old pass cleared shared flags");
    trace("reconcile:sql-withdrawn");
    assert.equal(manager.syncingSessionReconcileGeneration, manager.sessionReconcileGeneration);
  } finally {
    trace("finally:drain", { generation: manager.sessionReconcileGeneration, syncing: Boolean(manager.syncing) });
    release(); await Promise.allSettled([direct, deletion].filter(Boolean)); executor.syncArchiveFiles = syncArchiveFiles;
    trace("finally:done");
  }
  f.assertNoModels(); trace("service:stop"); await f.stop(); assertUnsubscribed(f); trace("service:stopped");
});

test("policy reconciliation drops caller ALS and an already-aborted search deadline", { timeout: 30_000 }, async t => {
  const f = await fixture(t), initial = session(f, "background-scope", "Synthetic emerald lighthouse must be withdrawn independently.");
  const { index } = await openIndex(f), owner = f.service.memoryEngine, manager = index.searchOwner;
  const item = await owner.propose({ profileId: f.profileId, scope: "agent", classification: "explicit",
    content: "Synthetic emerald lighthouse must be withdrawn independently.", sourceRefs: [initial.event.id, initial.run.id] });
  const request = new AbortController(), caller = new AsyncLocalStorage(), observed = [];
  request.abort(new Error("synthetic caller deadline expired"));
  const executor = index.embeddingExecutor, syncSources = executor.syncSources;
  executor.syncSources = function (signal, options) {
    if (options?.params?.reason === "product-session-reconcile") observed.push({
      caller: caller.getStore(), operation: manager.operations.getStore(), search: owner.searchScope.getStore(),
      aborted: signal.aborted,
    });
    return syncSources.call(this, signal, options);
  };
  try {
    await caller.run("synthetic-private-caller", () => manager.operations.run({ signal: request.signal },
      () => owner.searchScope.run({ profileId: f.profileId, workspace: initial.session.workspace,
        query: "synthetic-private-query" }, () => owner.delete({ profileId: f.profileId, id: item.id,
        reason: "forgotten", operationId: "background-scope-withdrawal" }))));
    await until(() => !chunks(index, initial.session.id).includes("emerald lighthouse"),
      "independent policy reconciliation despite expired caller deadline");
    assert.ok(observed.length > 0);
    for (const scope of observed) assert.deepEqual(scope,
      { caller: undefined, operation: undefined, search: undefined, aborted: false });
  } finally { executor.syncSources = syncSources; }
  f.assertNoModels(); await f.stop(); assertUnsubscribed(f);
});
