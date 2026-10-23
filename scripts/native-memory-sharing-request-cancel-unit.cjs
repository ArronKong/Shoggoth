"use strict";
// Real Product Service/Coordinator and direct-chat binding. Only the native
// transport and deliberately hanging owner read are controlled fixtures.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const PROFILE_FIELDS = ["id", "backendId", "agentId", "name", "runtime", "runtimeProfileId", "runtimeAccountId", "providerRef", "defaultModel", "defaultCwd", "permissionPolicy", "concurrency", "isDefault", "enabled", "createdAt", "updatedAt"];

async function fixture() {
  const f = await openHandoffFixture({ serviceOptions: { memoryCore: true, memorySharingFeatureReady: true,
    memoryCoreConfig: { memory: { search: { provider: "none", rememberAcrossConversations: false } },
      agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } },
      plugins: { entries: { "active-memory": { config: { enabled: false } } } } } } });
  const config = f.service.nativeRuntimeConfig.read();
  f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
    flags: { ...config.flags, runtimeContextLifecycleV1: false } });
  const B = "request-cancel-source-b", source = Object.fromEntries(PROFILE_FIELDS.map(key => [key, f.profile[key]]));
  Object.assign(source, { id: B, agentId: B, runtimeProfileId: B, name: B, isDefault: false });
  f.service.productStore.putAgentProfile(source); f.service.agentDefinitionStore.ensureProfile({ profileId: B });
  const owner = f.service.memoryEngine;
  owner.store.ensureProfile(B); owner.recallPolicy.assertReady(B);
  f.service.nativeMemorySharingConfig.apply({ revision: 0, config: { enabled: true, excludedProfiles: [] } });
  await owner.propose({ profileId: B, content: "The telescope source remains owner-local CANCEL_SOURCE_128473.",
    scope: "agent", classification: "explicit", sourceRefs: ["user-edit:request-cancel-source"] });
  const session = f.createSession(), run = await f.send(session.sessionKey, "request-cancel", "Find telescope notes");
  assert.equal(run.status, "running", run.errorCode);
  return { ...f, B, owner, session, run };
}
function bounded(promise, message) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 2000); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
function hangingRead() {
  let resolveStarted, observed, calls = 0;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  return {
    started, get observed() { return observed; }, get calls() { return calls; },
    read(input) {
      calls++; observed = input;
      assert.ok(input.signal instanceof AbortSignal, "the pending source receives a merged cancellation signal");
      resolveStarted(input);
      return new Promise((_, reject) => {
        const abort = () => reject(input.signal.reason || new DOMException("Aborted", "AbortError"));
        if (input.signal.aborted) abort(); else input.signal.addEventListener("abort", abort, { once: true });
      });
    },
  };
}
function state(f) {
  return { file: fs.readFileSync(path.join(f.owner.store.workspace(f.B), "MEMORY.md"), "utf8"),
    revision: f.owner.store.getRevision(f.B) };
}
function inputFor(f, caller) {
  return { profileId: f.profile.id, workspace: f.workspace, sessionId: f.session.id, run: f.run,
    query: "telescope", ownerProfileId: f.B, maxSensitivity: "private", maxResults: 10, minScore: 0,
    record: false, signal: caller.signal };
}
function assertEmpty(broker, runId) {
  assert.equal(broker.requests.size, 0, "no request controller remains registered");
  assert.equal(broker.access.size, 0, "no access capability was issued or retained");
  assert.equal(broker.runs.size, 0, "the first hanging read never registers a borrowed dependency");
  assert.deepEqual(broker.borrowedRefsForRun(runId), []);
}

for (const scenario of [
  { name: "ending a run aborts its first pending peer read before any borrowed refs exist", service: true, action: "endRun" },
  { name: "closing the broker aborts a pending trigger read and clears its request registry", trigger: true, action: "close" },
  { name: "caller cancellation aborts direct broker search and removes the pending request", action: "caller" },
]) test(scenario.name, { timeout: 30000 }, async () => {
  const f = await fixture(), broker = f.owner.sharing, caller = new AbortController(), pending = hangingRead();
  const originalReader = broker.reader, before = state(f);
  broker.reader = { ...originalReader, search: pending.read.bind(pending), triggerCandidates: pending.read.bind(pending) };
  let settled;
  try {
    const input = inputFor(f, caller), own = { results: [], items: [] };
    const request = scenario.service ? f.owner.searchMemory(input)
      : broker.search({ ...input, ...(scenario.trigger ? { candidateMode: "trigger", triggerOptions: { query: input.query } } : {}) }, own);
    settled = request.then(value => ({ status: "fulfilled", value }), error => ({ status: "rejected", error }));
    await bounded(pending.started, "the source read did not start");
    assert.equal(pending.calls, 1);
    assert.equal(broker.requests.get(f.run.id)?.size, 1, "nested Service/broker scopes share one run-bound controller");
    assert.equal(broker.access.size, 0); assert.deepEqual(broker.borrowedRefsForRun(f.run.id), []);
    assert.equal(pending.observed.signal.aborted, false);
    if (scenario.action === "endRun") await f.owner.finishActiveMemoryRun(f.run);
    else if (scenario.action === "close") broker.close();
    else caller.abort(new DOMException("Caller canceled this request", "AbortError"));
    assert.equal(pending.observed.signal.aborted, true, "cancellation reaches the owner read immediately");
    const result = await bounded(settled, "the canceled source read did not reject promptly");
    assert.equal(result.status, "rejected", "a canceled read cannot return a completed result");
    assertEmpty(broker, f.run.id); assert.deepEqual(state(f), before, "source Markdown and revision stay unchanged");
  } finally {
    caller.abort(new DOMException("Fixture cleanup", "AbortError"));
    if (settled) await bounded(settled, "fixture source read remained pending");
    broker.reader = originalReader;
    await f.close();
  }
});

test("Service run termination also aborts its own index phase before peer querying begins", { timeout: 30000 }, async () => {
  const f = await fixture(), broker = f.owner.sharing, caller = new AbortController(), pending = hangingRead();
  const host = f.owner.host(f.profile.id), originalSearch = host.searchIndex.search;
  host.searchIndex.search = (_query, options) => pending.read(options);
  let settled;
  try {
    settled = f.owner.searchMemory(inputFor(f, caller)).then(value => ({ status: "fulfilled", value }), error => ({ status: "rejected", error }));
    await bounded(pending.started, "the own-index phase did not start");
    assert.equal(broker.requests.get(f.run.id)?.size, 1); assert.equal(broker.access.size, 0);
    await f.owner.finishActiveMemoryRun(f.run);
    assert.equal(pending.observed.signal.aborted, true);
    assert.equal((await bounded(settled, "the canceled own-index read did not reject promptly")).status, "rejected");
    assertEmpty(broker, f.run.id);
  } finally {
    caller.abort(new DOMException("Fixture cleanup", "AbortError"));
    if (settled) await bounded(settled, "fixture own read remained pending");
    host.searchIndex.search = originalSearch;
    await f.close();
  }
});

test("run cancellation reaches the real OwnerReader trigger-index synchronization phase", { timeout: 30000 }, async () => {
  const f = await fixture(), broker = f.owner.sharing, caller = new AbortController();
  const host = f.owner.host(f.B), originalSync = host.searchIndex.sync, before = state(f);
  let resolveStarted, observed, release, settled;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  host.searchIndex.sync = options => {
    observed = options || {}; resolveStarted();
    return new Promise((_, reject) => {
      release = () => reject(new Error("Controlled source synchronization released"));
      const signal = observed.signal;
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  try {
    const input = inputFor(f, caller);
    settled = broker.search({ ...input, candidateMode: "trigger", triggerOptions: { query: input.query, maxResults: 20 } },
      { results: [], items: [] }).then(value => ({ status: "fulfilled", value }), error => ({ status: "rejected", error }));
    await bounded(started, "the actual source trigger synchronization did not start");
    assert.ok(observed.signal instanceof AbortSignal, "OwnerReader forwards run cancellation through the trigger index to synchronization");
    assert.equal(observed.signal.aborted, false); assert.equal(broker.requests.get(f.run.id)?.size, 1);
    await f.owner.finishActiveMemoryRun(f.run);
    assert.equal(caller.signal.aborted, false, "the test cancels the Product run, not its caller fixture");
    assert.equal(observed.signal.aborted, true, "source trigger synchronization observes the run controller");
    assert.equal((await bounded(settled, "the source trigger synchronization remained pending after endRun")).status, "rejected");
    assertEmpty(broker, f.run.id); assert.deepEqual(state(f), before);
  } finally {
    caller.abort(new DOMException("Fixture cleanup", "AbortError")); release?.();
    if (settled) await bounded(settled, "fixture trigger synchronization remained pending");
    host.searchIndex.sync = originalSync;
    await f.close();
  }
});

test("Active Memory self-trigger candidate jobs receive run cancellation and finish cleanup", { timeout: 30000 }, async () => {
  const f = await fixture(), caller = new AbortController(), originalConfig = f.owner.getConfig;
  const raw = originalConfig(), config = { ...raw, plugins: { ...raw.plugins, entries: { ...raw.plugins?.entries,
    "active-memory": { enabled: true, config: { enabled: true, mode: "escalate", model: "literal",
      timeoutMs: 15000, setupGraceTimeoutMs: 10000 } } } } };
  f.owner.getConfig = () => config;
  require("./fixtures/literal-memory-model-control.cjs").installLiteralMemoryModelControl(f.owner);
  f.owner.complete = async () => assert.fail("canceling trigger preparation must not start model completion");
  const host = f.owner.host(f.profile.id), originalSync = host.searchIndex.sync, observed = [], releases = [];
  let resolveStarted, settled;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  host.searchIndex.sync = options => {
    if (!f.owner.activeMemory.runtimes.size) return originalSync.call(host.searchIndex, options);
    const entry = options || {}; observed.push(entry);
    if (observed.length >= 2) resolveStarted();
    return new Promise((_, reject) => {
      releases.push(() => reject(new Error("Controlled Active trigger synchronization released")));
      const signal = entry.signal;
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  try {
    settled = f.owner.prepareActiveMemory({ profile: f.profile, session: f.session, run: f.run,
      query: "Recall telescope calibration", signal: caller.signal }).then(value => ({ status: "fulfilled", value }), error => ({ status: "rejected", error }));
    await bounded(started, "native Active lane-one search and candidates did not reach synchronization").catch(error => {
      error.message += ` (observed=${observed.length}, pending=${f.owner.activeMemory.pending.size}, runtimes=${f.owner.activeMemory.runtimes.size})`;
      throw error;
    });
    assert.equal(observed.length, 2, "native lane one launches one own search and one own candidate read");
    assert.ok(observed.every(entry => entry.signal instanceof AbortSignal), "both native Active jobs forward cancellation to the owner index");
    assert.ok(observed.every(entry => !entry.signal.aborted));
    await bounded(f.owner.finishActiveMemoryRun(f.run), "Active endRun remained blocked by uncanceled candidate jobs");
    assert.equal(caller.signal.aborted, false); assert.ok(observed.every(entry => entry.signal.aborted));
    assert.equal((await bounded(settled, "Active preparation did not settle after endRun")).status, "fulfilled");
    assert.equal(f.owner.takeActiveMemory({ profile: f.profile, session: f.session, run: f.run, query: "Recall telescope calibration" }), null);
    assert.equal(f.owner.activeMemory.pending.size, 0); assert.equal(f.owner.activeMemory.runs.size, 0);
    assert.equal(f.owner.activeMemory.runtimes.size, 0, "native tracked candidate jobs complete cleanup");
    assertEmpty(f.owner.sharing, f.run.id);
  } finally {
    caller.abort(new DOMException("Fixture cleanup", "AbortError")); for (const release of releases) release();
    if (settled) await bounded(settled, "fixture Active preparation remained pending");
    host.searchIndex.sync = originalSync; f.owner.getConfig = originalConfig;
    await f.close();
  }
});

test("Active Memory preflight synchronization observes endRun before creating a native recall runtime", { timeout: 30000 }, async () => {
  const f = await fixture(), caller = new AbortController(), originalConfig = f.owner.getConfig;
  const raw = originalConfig(), config = { ...raw, plugins: { ...raw.plugins, entries: { ...raw.plugins?.entries,
    "active-memory": { enabled: true, config: { enabled: true, mode: "escalate", model: "literal",
      timeoutMs: 15000, setupGraceTimeoutMs: 10000 } } } } };
  f.owner.getConfig = () => config;
  const host = f.owner.host(f.profile.id), originalSync = host.searchIndex.sync;
  let resolveStarted, observed, release, settled;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  host.searchIndex.sync = options => {
    observed = options || {}; resolveStarted();
    return new Promise((_, reject) => {
      release = () => reject(new Error("Controlled Active preflight synchronization released"));
      const signal = observed.signal;
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  try {
    settled = f.owner.prepareActiveMemory({ profile: f.profile, session: f.session, run: f.run,
      query: "Recall telescope calibration", signal: caller.signal }).then(value => ({ status: "fulfilled", value }), error => ({ status: "rejected", error }));
    await bounded(started, "the actual Active preflight synchronization did not start");
    assert.equal(f.owner.activeMemory.runtimes.size, 0, "the preflight is before native recall runtime creation");
    assert.ok(observed.signal instanceof AbortSignal, "Active preflight forwards its Product run controller to synchronization");
    await bounded(f.owner.finishActiveMemoryRun(f.run), "Active endRun remained blocked by preflight synchronization");
    assert.equal(caller.signal.aborted, false); assert.equal(observed.signal.aborted, true);
    assert.equal((await bounded(settled, "Active preflight did not settle after endRun")).status, "fulfilled");
    assert.equal(f.owner.activeMemory.pending.size, 0); assert.equal(f.owner.activeMemory.runs.size, 0);
    assert.equal(f.owner.activeMemory.runtimes.size, 0); assertEmpty(f.owner.sharing, f.run.id);
  } finally {
    caller.abort(new DOMException("Fixture cleanup", "AbortError")); release?.();
    if (settled) await bounded(settled, "fixture Active preflight remained pending");
    host.searchIndex.sync = originalSync; f.owner.getConfig = originalConfig;
    await f.close();
  }
});
