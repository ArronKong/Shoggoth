"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { SharedReadService } = require("../app/agent-service/shoggoth-memory/shared-read-service.cjs");
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
function fixture() {
  let now = 1000, enabled = true, revision = 1;
  const profiles = ["a", "b", "c"].map(id => ({ id, enabled: true, backendId: "shoggoth", name: `Agent ${id}` }));
  const excluded = new Set(), data = new Map(), active = new Set();
  const run = { id: "read-run", source: "chat", sourceId: "session-key", profileId: "a", workspace: "/project" };
  const input = { profileId: "a", run, workspace: run.workspace, maxSensitivity: "private", query: "telescope", minScore: 0, maxResults: 10 };
  const own = { items: [], results: [{ path: "MEMORY.md", snippet: "Own telescope", score: 0.01, startLine: 1, endLine: 1 }], revision: 4 };
  const scanCounts = new Map(), invalidated = new Set(), suppliedViews = new Map();
  const service = { now: () => now, profiles: () => profiles,
    chatSessionStore: { listSessions: () => [{ id: "session-id", sessionKey: "session-key", profileId: "a", workspace: "/project" }] },
    database: { open() {}, db: { exec() {}, prepare() { return { get: () => null, all: () => [] }; } } },
    store: { getRevision: () => 4 }, activeFileEntries: () => [],
    withMemoryReadView(_profileId, read) { return read(); },
    memoryViewFor(profileId) { return suppliedViews.get(profileId); },
    withSuppliedReadView(profileId, view, read) {
      const prior = suppliedViews.get(profileId);
      suppliedViews.set(profileId, view);
      try { return read(); }
      finally {
        if (prior) suppliedViews.set(profileId, prior);
        else suppliedViews.delete(profileId);
      }
    },
    async withAsyncMemoryReadView(profileId, signal, read, scanSignal = signal) {
      scanSignal?.throwIfAborted();
      scanCounts.set(profileId, (scanCounts.get(profileId) || 0) + 1);
      const view = {
        assertFilesCurrent() {
          signal?.throwIfAborted();
          if (invalidated.has(profileId)) throw Object.assign(new Error("source proof changed"), { code: "MEMORY_REVISION_CONFLICT" });
        },
        retainProof: () => ({ read: callback => { view.assertFilesCurrent(); return callback(view); } }),
      };
      return read(view);
    },
    viewStatus: () => ({ owner: "shoggoth-memory-core" }) };
  const evidence = (ownerProfileId, text, relative = "MEMORY.md", line = 1) => ({ ownerProfileId, canonicalRelativePath: relative, path: relative,
    documentKind: "long_term", sourceHash: hash(text), sourceRevision: `sha256:${hash(text)}`, startLine: line, endLine: line,
    source: "memory", snippet: text, score: ownerProfileId === "b" ? 999 : 0.001, citation: `${relative}#L${line}-L${line}` });
  data.set("b", evidence("b", "Borrowed telescope amber")); data.set("c", evidence("c", "Borrowed telescope violet"));
  const config = { resolve(profileId) { const ids = profiles.filter(p => p.enabled && !excluded.has(p.id)).map(p => p.id);
    return { enabled: enabled && ids.includes(profileId), revision, participatingProfileIds: enabled ? ids : [] }; } };
  const reader = { async search(source) { source.assertCurrent(); active.add(source.ownerProfileId);
    return { results: data.has(source.ownerProfileId) ? [data.get(source.ownerProfileId)] : [], semantic: { status: "ready", modelId: "test" } }; },
    revalidate(source, old) { source.assertCurrent?.(); const current = data.get(source.ownerProfileId);
      if (!current) throw Object.assign(new Error("gone"), { code: "MEMORY_SHARED_SOURCE_REVOKED" });
      if (old.sourceHash !== current.sourceHash) throw Object.assign(new Error("edit"), { code: "MEMORY_SOURCE_CHANGED" });
      return current; } };
  const broker = new SharedReadService(service, { config, reader });
  return { broker, input, own, reader, active, profiles, data, evidence, excluded, scanCounts, invalidated,
    tick: duration => { now += duration; }, disable: () => { enabled = false; revision++; } };
}

test("automatic source fan-out uses reciprocal ranks, source metadata and run-bound capabilities", async t => {
  const f = fixture(); t.after(() => f.broker.close());
  const result = await f.broker.search(f.input, f.own);
  assert.equal(result.coverage, "complete"); assert.equal(result.results.length, 3);
  assert.equal(result.results[0].path, "MEMORY.md", "own rank gets a small documented bias, not the raw score");
  assert.equal(result.results[1].score, result.results[2].score, "incompatible embedding scores are never compared");
  const borrowed = result.results[1]; assert.equal(borrowed.ownerProfileId, "b"); assert.equal(borrowed.documentKind, "long_term");
  const read = f.broker.get({ ...f.input, id: borrowed.sourceRef }); assert.equal(read.text, "Borrowed telescope amber");
  assert.throws(() => f.broker.get({ ...f.input, id: borrowed.sourceRef, from: 1, lines: 2 }), { code: "MEMORY_SHARED_REFERENCE_INVALID" });
  assert.throws(() => f.broker.get({ ...f.input, run: { ...f.input.run, id: "other-run" }, id: borrowed.sourceRef }), { code: "MEMORY_SHARED_REFERENCE_INVALID" });
  assert.throws(() => f.broker.get({ ...f.input, workspace: "/other", id: borrowed.sourceRef }), { code: "MEMORY_SHARED_REFERENCE_INVALID" });
  assert.throws(() => f.broker.get({ ...f.input, id: "shared-memory:made-up" }), { code: "MEMORY_SHARED_REFERENCE_INVALID" });
  assert.ok(!JSON.stringify([...f.broker.access.values()]).includes("Borrowed telescope amber"), "broker state contains no body");
  assert.ok(!JSON.stringify(f.broker.borrowedRefsForRun(f.input.run.id)).includes(borrowed.sourceRef), "durable dependency never grants read access");
  f.tick(600001); assert.throws(() => f.broker.get({ ...f.input, id: borrowed.sourceRef }), { code: "MEMORY_SHARED_REFERENCE_INVALID" });
});

test("optional trigger index preparation honors its deadline and retains physical owner capacity", async t => {
  const f = fixture(); t.after(() => f.broker.close());
  const deadline = new AbortController(), caller = new AbortController(), owners = [];
  let finish;
  const settled = new Promise(resolve => { finish = resolve; });
  const expiration = t.mock.method(AbortSignal, "timeout", ms => {
    assert.equal(ms, 5000);
    return deadline.signal;
  });
  f.reader.prepareTriggers = source => {
    source.assertCurrent();
    owners.push(source.ownerProfileId);
    const ready = new Promise((_, reject) => {
      source.signal.addEventListener("abort", () => reject(source.signal.reason), { once: true });
    });
    return { ready, settled };
  };
  try {
    const preparing = f.broker.prepareTriggerOwners({ ...f.input, signal: caller.signal });
    assert.deepEqual(owners, ["b", "c"]);
    deadline.abort(new DOMException("Synthetic trigger deadline", "TimeoutError"));
    await preparing;
    assert.equal(caller.signal.aborted, false);
    assert.deepEqual([...f.broker.triggerIndexPreparations], ["b", "c"]);
    await f.broker.prepareTriggerOwners({ ...f.input, signal: caller.signal });
    assert.deepEqual(owners, ["b", "c"], "other turns cannot take a cold owner's slot during physical drain");
  } finally {
    finish();
    expiration.mock.restore();
  }
  await settled;
  assert.equal(f.broker.triggerIndexPreparations.size, 0);
  assert.equal((await f.broker.search({ ...f.input, signal: caller.signal }, f.own)).results.length, 3);
});

test("final shared search uses one worker view per owner and rechecks after requester preparation", async t => {
  const f = fixture(); t.after(() => f.broker.close());
  const search = f.reader.search.bind(f.reader), revalidate = f.reader.revalidate.bind(f.reader);
  const second = f.evidence("c", "Borrowed telescope second", "MEMORY.md", 2);
  f.reader.search = async input => {
    const result = await search(input);
    return input.ownerProfileId === "c" ? { ...result, results: [...result.results, second] } : result;
  };
  f.reader.revalidate = (input, old) => {
    if (old === second) { input.assertCurrent(); return second; }
    return revalidate(input, old);
  };
  f.broker.service.withMemoryReadView = () => assert.fail("borrowed search returned to synchronous tree scanning");
  const result = await f.broker.search(f.input, f.own, {
    async withPublicationView(publish) {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.broker.access.size, 0, "capabilities are not issued across the last asynchronous boundary");
      f.invalidated.add("b");
      return publish();
    },
  });
  assert.deepEqual([...f.scanCounts].sort(), [["b", 1], ["c", 1]]);
  assert.equal(result.coverage, "partial");
  assert.deepEqual(result.unavailableSources, [{ ownerProfileId: "b", code: "MEMORY_REVISION_CONFLICT" }]);
  assert.deepEqual(result.results.map(hit => hit.snippet), ["Own telescope", "Borrowed telescope violet", second.snippet]);
  assert.ok([...f.broker.access.values()].every(entry => entry.dependency.ownerProfileId === "c"));
});

test("an unsuccessful requester publication leaves no shared capabilities or dependencies", async t => {
  const f = fixture(); t.after(() => f.broker.close());
  await assert.rejects(f.broker.search(f.input, f.own, {
    publish() { throw Object.assign(new Error("requester became stale"), { code: "MEMORY_REVISION_CONFLICT" }); },
  }), { code: "MEMORY_REVISION_CONFLICT" });
  assert.equal(f.broker.access.size, 0);
  assert.equal(f.broker.runs.size, 0);
});

test("a sibling timeout does not invalidate a finished source proof", async t => {
  const f = fixture(); t.after(() => f.broker.close());
  const read = f.broker.service.withAsyncMemoryReadView.bind(f.broker.service);
  f.broker.service.withAsyncMemoryReadView = async (owner, lifetime, callback, waiting) => {
    if (owner === "c") {
      // Hold one owner past the shared deadline while another completes.
      await new Promise(resolve => setTimeout(resolve, 40));
      waiting.throwIfAborted();
    }
    return read(owner, lifetime, callback, waiting);
  };
  const result = await f.broker.search({ ...f.input, deadlineAt: performance.now() + 25 }, f.own);
  assert.deepEqual(result.results.map(hit => hit.snippet), ["Own telescope", "Borrowed telescope amber"]);
  assert.deepEqual(result.unavailableSources, [{ ownerProfileId: "c", code: "MEMORY_SHARED_SOURCE_TIMEOUT" }]);
  assert.equal(result.coverage, "partial");
});

test("source failure is partial and preserves own results; explicit source filter is only a filter", async t => {
  const f = fixture(); t.after(() => f.broker.close());
  const original = f.reader.search;
  f.reader.search = async input => { if (input.ownerProfileId === "b") throw Object.assign(new Error("provider unavailable"), { code: "MEMORY_SHARED_SOURCE_UNAVAILABLE" }); return original(input); };
  const result = await f.broker.search(f.input, f.own);
  assert.equal(result.coverage, "partial"); assert.equal(result.unavailableSources[0].ownerProfileId, "b");
  assert.ok(result.results.some(value => value.path === "MEMORY.md")); assert.ok(result.results.some(value => value.ownerProfileId === "c"));
  const selected = await f.broker.search({ ...f.input, ownerProfileId: "c" }, f.own);
  assert.equal(selected.results.length, 1); assert.equal(selected.results[0].ownerProfileId, "c");
  await assert.rejects(f.broker.search({ ...f.input, ownerProfileId: "unrelated" }, f.own), { code: "MEMORY_SHARED_SOURCE_UNAVAILABLE" });
});

test("background, delegated, mismatched and own-only reads do not fan out", async t => {
  const f = fixture(); t.after(() => f.broker.close());
  const requests = [ { ...f.input, run: null }, ...["cron", "kanban", "inspiration", "proactive"].map(source => ({ ...f.input, run: { ...f.input.run, source } })),
    { ...f.input, run: { ...f.input.run, idempotencyKey: "shoggoth:chat-send:federation-send-test" } },
    { ...f.input, run: { ...f.input.run, profileId: "b" } }, { ...f.input, memoryScope: "own" } ];
  for (const input of requests) assert.equal(await f.broker.search(input, f.own), f.own);
  assert.equal(f.active.size, 0);
  f.excluded.add("a"); assert.equal(await f.broker.search(f.input, f.own), f.own);
});

test("queued Active Memory reads require a matching durable chat run and never borrow session-only sources", async t => {
  const f = fixture(); t.after(() => f.broker.close());
  let status = "queued";
  f.broker.service.resolveRun = () => ({ ...f.input.run, status });
  assert.equal((await f.broker.search(f.input, f.own)).results.length, 3);
  f.active.clear();
  assert.equal(await f.broker.search({ ...f.input, sources: ["sessions"] }, f.own), f.own);
  assert.equal(f.active.size, 0);
  assert.equal(await f.broker.search({ ...f.input, run: { ...f.input.run, sourceId: "forged-session" } }, f.own), f.own);
  for (status of ["completed", "failed", "canceled", "interrupted"]) {
    assert.equal(await f.broker.search(f.input, f.own), f.own);
  }
  assert.equal(f.active.size, 0);
});

test("content edits invalidate next-turn dependencies without canceling a current run; withdrawal stops it", async t => {
  const f = fixture(); t.after(() => f.broker.close());
  const result = await f.broker.search(f.input, f.own), borrowed = result.results.find(value => value.ownerProfileId === "b");
  assert.equal(f.broker.dependenciesCurrent("a", "session-id", borrowed.borrowedMemoryRefs), true);
  f.data.set("b", f.evidence("b", "Edited telescope teal"));
  assert.equal(f.broker.dependenciesCurrent("a", "session-id", borrowed.borrowedMemoryRefs), false);
  assert.throws(() => f.broker.get({ ...f.input, id: borrowed.sourceRef }), { code: "MEMORY_SOURCE_CHANGED" });
  assert.doesNotThrow(() => f.broker.assertRunCurrent(f.input.run.id));
  let revoked = 0; f.broker.onRevoked = async () => { revoked++; }; f.excluded.add("b");
  await f.broker.reconcileConfig(); assert.equal(revoked, 1); await f.broker.reconcileConfig(); assert.equal(revoked, 1);
  assert.throws(() => f.broker.assertRunCurrent(f.input.run.id), { code: "MEMORY_SHARED_SOURCE_REVOKED" });
});

test("foreground broker admission verifies existing lenders without synchronous scans", async t => {
  const f = fixture(); t.after(() => f.broker.close());
  await f.broker.search(f.input, f.own);
  f.scanCounts.clear();
  f.broker.service.withMemoryReadView = (owner, read) => {
    assert.ok(f.broker.service.memoryViewFor(owner), "prior Run dependencies must use a supplied worker view");
    return read();
  };
  f.data.set("b", f.evidence("b", "Edited telescope teal"));
  assert.equal(await f.broker.search({ ...f.input, memoryScope: "own" }, f.own), f.own);
  assert.deepEqual([...f.scanCounts].sort(), [["b", 1], ["c", 1]]);
  assert.equal(f.broker.runs.get(f.input.run.id).revoked, false);
  f.excluded.add("b");
  await assert.rejects(f.broker.search({ ...f.input, memoryScope: "own" }, f.own), { code: "MEMORY_SHARED_SOURCE_REVOKED" });
  assert.equal(f.broker.runs.get(f.input.run.id).revoked, true);
});

test("global close and run end destroy access capabilities and join bounded monitor state", async t => {
  const f = fixture(); t.after(() => f.broker.close());
  const result = await f.broker.search(f.input, f.own), ref = result.results.find(value => value.borrowed).sourceRef;
  f.broker.endRun(f.input.run); assert.equal(f.broker.access.size, 0); assert.equal(f.broker.runs.size, 0); assert.equal(f.broker.timer, null);
  assert.throws(() => f.broker.get({ ...f.input, id: ref }), { code: "MEMORY_SHARED_REFERENCE_INVALID" });
  await f.broker.search(f.input, f.own); f.disable(); await f.broker.reconcileConfig();
  assert.throws(() => f.broker.assertRunCurrent(f.input.run.id), { code: "MEMORY_SHARED_SOURCE_REVOKED" });
  f.broker.close(); assert.equal(f.broker.access.size, 0); assert.equal(f.broker.timer, null);
});

test("background monitor shares one worker view per owner and never treats a busy scan as revocation", async t => {
  const f = fixture();
  t.after(() => f.broker.close());
  const second = { ...f.input, run: { ...f.input.run, id: "second-run" } };
  await f.broker.search(f.input, f.own);
  await f.broker.search(second, f.own);
  const views = [], revoked = [];
  f.broker.onRevoked = runId => revoked.push(runId);
  f.broker.service.withAsyncMemoryReadView = async (profileId, signal, read) => {
    signal.throwIfAborted();
    views.push(profileId);
    if (profileId === "b") throw Object.assign(new Error("busy"), { code: "MEMORY_SCAN_BUSY" });
    return read({ assertFilesCurrent: () => signal.throwIfAborted() });
  };
  await Promise.all([f.broker.monitorSources(), f.broker.monitorSources()]);
  assert.deepEqual(views, ["b", "c"]);
  assert.deepEqual(revoked, []);
  f.excluded.add("c");
  await f.broker.monitorSources();
  assert.deepEqual(revoked, [f.input.run.id, second.run.id]);
  await f.broker.reconcileConfig();
  assert.equal(revoked.length, 2, "explicit and periodic paths share exactly one interruption");
});

test("config reconciliation fences excluded borrowers before a held worker scan finishes", async t => {
  const f = fixture();
  const { promise: scanned, resolve: entered } = Promise.withResolvers();
  const { promise: hold, resolve: release } = Promise.withResolvers();
  const { promise: stopping, resolve: interrupt } = Promise.withResolvers();
  const { promise: interruptHeld, resolve: finishInterrupt } = Promise.withResolvers();
  await f.broker.search(f.input, f.own);
  t.after(async () => { release(); finishInterrupt(); await f.broker.close(); });
  const read = f.broker.service.withAsyncMemoryReadView.bind(f.broker.service);
  f.broker.service.withMemoryReadView = () => assert.fail("config reconciliation scanned the tree on the Service thread");
  f.broker.service.withAsyncMemoryReadView = async (...args) => {
    entered(); await hold; return read(...args);
  };
  let interrupts = 0, acknowledged = false;
  f.broker.onRevoked = () => { interrupts++; interrupt(); return interruptHeld; };
  const periodic = f.broker.monitorSources();
  await scanned;
  f.excluded.add("b");
  const updates = Promise.all([f.broker.reconcileConfig(), f.broker.reconcileConfig()])
    .then(() => { acknowledged = true; });
  assert.throws(() => f.broker.assertRunCurrent(f.input.run.id), { code: "MEMORY_SHARED_SOURCE_REVOKED" });
  await assert.rejects(f.broker.withRunReadProof(f.input.run.id, undefined, () => assert.fail("a revoked run published")),
    { code: "MEMORY_SHARED_SOURCE_REVOKED" });
  await stopping;
  assert.equal(interrupts, 1);
  assert.equal(acknowledged, false, "both config calls join the pending interrupt");
  finishInterrupt(); await updates;
  release(); await periodic;
});

test("config reconciliation requests a new owner pass after an in-flight periodic scan", async t => {
  const f = fixture();
  const { promise: scanned, resolve: entered } = Promise.withResolvers();
  const { promise: hold, resolve: release } = Promise.withResolvers();
  t.after(async () => { release(); await f.broker.close(); });
  const second = { ...f.input, run: { ...f.input.run, id: "second-run" } };
  await f.broker.search(f.input, f.own); await f.broker.search(second, f.own);
  f.scanCounts.clear();
  f.broker.service.withMemoryReadView = () => assert.fail("explicit reconciliation must use a worker view");
  const read = f.broker.service.withAsyncMemoryReadView.bind(f.broker.service);
  f.broker.service.withAsyncMemoryReadView = async (id, ...args) => {
    if (id === "c") { entered(); await hold; }
    return read(id, ...args);
  };
  const interrupted = [];
  f.broker.onRevoked = runId => interrupted.push(runId);
  const periodic = f.broker.monitorSources();
  await scanned;
  assert.equal(f.scanCounts.get("b"), 1, "the periodic pass already validated the owner once for both Runs");
  f.data.delete("b");
  const mutation = f.broker.reconcileConfig();
  release(); await Promise.all([periodic, mutation]);
  assert.equal(f.scanCounts.get("b"), 2, "the explicit pass must rescan the changed owner once");
  assert.deepEqual(interrupted, [f.input.run.id, second.run.id]);
});

test("uncertain config revalidation cannot revoke or authorize publication", async t => {
  const f = fixture(); t.after(() => f.broker.close());
  await f.broker.search(f.input, f.own);
  const interrupted = [];
  f.broker.onRevoked = runId => interrupted.push(runId);
  f.data.delete("b");
  f.invalidated.add("b");
  await f.broker.reconcileConfig();
  assert.deepEqual(interrupted, []);
  assert.equal(f.broker.runs.get(f.input.run.id).revoked, false);
  await assert.rejects(f.broker.withRunReadProof(f.input.run.id, undefined, () => assert.fail("unverified output published")),
    { code: "CONTEXT_MEMORY_READ_UNAVAILABLE" });
  f.invalidated.delete("b");
  // The next valid worker pass is allowed to turn a proved withdrawal into an interruption.
  await f.broker.reconcileConfig();
  assert.deepEqual(interrupted, [f.input.run.id]);
});

test("fan-out never exceeds three source readers and total result bytes stay bounded", async t => {
  const f = fixture(); t.after(() => f.broker.close());
  for (const id of ["d", "e", "f", "g", "h"]) { f.profiles.push({ id, enabled: true, backendId: "shoggoth" }); f.data.set(id, f.evidence(id, `Borrowed telescope ${id}`)); }
  let active = 0, maximum = 0; const original = f.reader.search;
  f.reader.search = async input => { active++; maximum = Math.max(maximum, active); try { await new Promise(resolve => setTimeout(resolve, 5)); return await original(input); } finally { active--; } };
  const result = await f.broker.search({ ...f.input, maxBytes: 60 }, f.own);
  assert.equal(maximum, 3); assert.ok(result.results.reduce((bytes, value) => bytes + Buffer.byteLength(value.snippet), 0) <= 60);
});


test("a source that changes after ranking cannot fail healthy sources or issue a stale capability", async t => {
  const f = fixture(); t.after(() => f.broker.close());
  const original = f.reader.revalidate;
  f.reader.revalidate = (source, evidence) => {
    if (source.ownerProfileId === "b") throw Object.assign(new Error("changed after ranking"), { code: "MEMORY_SOURCE_CHANGED" });
    return original(source, evidence);
  };
  const result = await f.broker.search(f.input, f.own);
  assert.equal(result.coverage, "partial");
  assert.deepEqual(result.unavailableSources, [{ ownerProfileId: "b", code: "MEMORY_SOURCE_CHANGED" }]);
  assert.ok(result.results.some(item => item.path === "MEMORY.md"));
  assert.ok(result.results.some(item => item.ownerProfileId === "c"));
  assert.equal(result.results.some(item => item.ownerProfileId === "b"), false);
  assert.ok([...f.broker.access.values()].every(item => item.dependency.ownerProfileId === "c"));
});


test("large source inventories and repeated provenance stay inside the complete MCP response budget", async t => {
  const f = fixture(); t.after(() => f.broker.close());
  for (let index = 0; index < 30; index++) {
    const id = `budget-${index}`;
    f.profiles.push({ id, name: "来源".repeat(40), enabled: true, backendId: "shoggoth" });
    f.data.set(id, f.evidence(id, `Borrowed telescope ${id} ${"x".repeat(1100)}`));
  }
  const result = await f.broker.search({ ...f.input, maxResults: 20 }, f.own);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 48 * 1024);
  assert.ok(result.results.some(item => item.path === "MEMORY.md"), "highest-ranked own result survives metadata pressure");
  assert.ok(result.results.some(item => item.borrowed), "a bounded set of valid borrowed matches survives");
  assert.equal(result.truncated, true);
  assert.equal(result.sourceCount, 32);
  assert.equal(result.borrowedMemoryRefs.length, result.results.filter(item => item.borrowed).length);
  const retained = new Set(result.results.filter(item => item.borrowed).map(item => item.sourceRef));
  assert.ok([...f.broker.access.values()].every(capability => retained.has(capability.id)), "unreturned references confer no read access");
});


test("a source withdrawn during a first query preserves the caller and other authorized sources", async t => {
  const f = fixture(); t.after(() => f.broker.close());
  const original = f.reader.search;
  f.reader.search = async input => {
    const value = await original(input);
    if (input.ownerProfileId === "b") f.excluded.add("b");
    return value;
  };
  const result = await f.broker.search(f.input, f.own);
  assert.equal(result.coverage, "partial");
  assert.ok(result.results.some(item => item.path === "MEMORY.md"));
  assert.ok(result.results.some(item => item.ownerProfileId === "c"));
  assert.equal(result.results.some(item => item.ownerProfileId === "b"), false);
  assert.ok(result.unavailableSources.some(item => item.ownerProfileId === "b" && item.code === "MEMORY_SHARED_SOURCE_REVOKED"));
  assert.equal(result.sources.some(item => item.ownerProfileId === "b"), false);
});


test("result count or snippet budget truncation cannot be reported as an exhaustive empty search", async t => {
  const f = fixture(); t.after(() => f.broker.close());
  const tiny = await f.broker.search({ ...f.input, maxBytes: 1 }, f.own);
  assert.equal(tiny.coverage, "complete", "all authorized sources replied");
  assert.equal(tiny.results.length, 0);
  assert.equal(tiny.truncated, true, "budget-excluded hits must remain distinguishable from no matching fact");
  assert.equal(tiny.borrowedMemoryRefs.length, 0);
  assert.equal(f.broker.access.size, 0, "discarded matches never issue capabilities");
  const one = await f.broker.search({ ...f.input, maxResults: 1 }, f.own);
  assert.equal(one.results.length, 1);
  assert.equal(one.truncated, true, "Top-K selection advertises additional authorized matches");
});
