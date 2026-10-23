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

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sg-memory-events-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value), decryptString: value => Buffer.from(value).toString("utf8") };
  const service = createAgentService({ paths, safeStorage, memoryCore: true,
    version: "shoggoth-memory-durable-events-fixture", prewarmMcpAuth: false,
    memoryCoreConfig: {
      memory: { search: { provider: "none", sources: ["sessions"],
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
  service.memoryEngine.embedding = null;
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
