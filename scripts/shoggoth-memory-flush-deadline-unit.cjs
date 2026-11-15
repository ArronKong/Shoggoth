"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { A, fixture } = require("./fixtures/memory-repair-fixture.cjs");
const { MEMORY_FLUSH_BUDGET_MS } = require("../app/agent-service/shoggoth-memory/maintenance.cjs");

async function source(t) {
  const f = await fixture(t);
  const turn = f.turn("The telescope calibration happens every evening.", boundSession(f));
  await f.finish(turn);
  return { f, turn, input: { profileId: A, sessionId: turn.session.id } };
}

function boundSession(f) {
  const session = f.session();
  f.service.chatSessionStore.requestBinding(session.sessionKey, `bind-${session.id}`, f.now());
  f.service.chatSessionStore.completeBinding(session.sessionKey, `bind-${session.id}`, `runtime-${session.id}`);
  return f.service.chatSessionStore.getSession(session.sessionKey);
}

test("flush checks the Product tape and all authority stamps in its owner worker view", async t => {
  const { f, input } = await source(t);
  const sessions = f.owner.host(A).sessions;
  for (const method of ["read", "stamp"]) {
    const original = sessions[method].bind(sessions);
    t.mock.method(sessions, method, (...args) => {
      assert.ok(f.owner.memoryViewFor(A), `Product ${method} needs a verified worker view`);
      return original(...args);
    });
  }
  f.model = async () => ({ text: '{"append":"The telescope calibration happens every evening."}' });
  const completed = await f.owner.flushBeforeCompaction(input);
  assert.equal(completed.appended, true);
  assert.equal(sessions.read.mock.callCount(), 1);
  assert.ok(sessions.stamp.mock.callCount() > 1);
  assert.deepEqual(await f.owner.flushBeforeCompaction(input), completed);
  assert.equal(f.modelCalls(), 1);
});

test("a source worker that reaches the flush deadline cannot record optional success or dispatch a model", async t => {
  const { f, input } = await source(t);
  const scan = t.mock.method(f.owner, "withAsyncMemoryReadView", (_profile, lifecycle, _read, waiting) => {
    assert.ok(lifecycle instanceof AbortSignal && waiting instanceof AbortSignal);
    return new Promise((_, reject) => waiting.addEventListener("abort", () => {
      assert.equal(lifecycle.aborted, false);
      reject(waiting.reason);
    }, { once: true }));
  });
  await assert.rejects(f.owner.flushBeforeCompaction({ ...input, deadlineAt: f.now() + 100 }), { code: "MEMORY_FLUSH_DEADLINE" });
  assert.equal(f.modelCalls(), 0);
  const db = f.owner.database.db;
  assert.equal(db.prepare("SELECT count(*) AS n FROM memory_flush_runs").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM memory_flush_cycles").get().n, 0);
  scan.mock.restore();
  f.model = async () => ({ text: "NO_REPLY" });
  assert.equal((await f.owner.flushBeforeCompaction(input)).status, "completed");
  assert.equal(f.modelCalls(), 1);
});

test("flush source withdrawal after the worker returns stops before the receipt and model", async t => {
  const { f, input, turn } = await source(t);
  const original = f.owner.withAsyncMemoryReadView.bind(f.owner);
  t.mock.method(f.owner, "withAsyncMemoryReadView", async (...args) => {
    const result = await original(...args);
    f.service.transcriptStore.setContextExcluded({ profileId: A, sessionId: turn.session.id,
      eventId: turn.event.id, contextExcluded: true });
    return result;
  });
  await assert.rejects(f.owner.flushBeforeCompaction(input), { code: "MEMORY_SOURCE_REVOKED" });
  assert.equal(f.modelCalls(), 0);
  assert.equal(f.owner.database.db.prepare("SELECT count(*) AS n FROM memory_flush_runs").get().n, 0);
});

test("flush retries a stale worker read once before recording intent", async t => {
  const { f, input } = await source(t);
  const original = f.owner.withAsyncMemoryReadView.bind(f.owner);
  const db = f.owner.database.db;
  const stale = Object.assign(new Error("worker memory files changed"), { code: "MEMORY_REVISION_CONFLICT" });
  let attempts = 0;
  const read = t.mock.method(f.owner, "withAsyncMemoryReadView", async (...args) => {
    assert.equal(db.prepare("SELECT count(*) AS n FROM memory_flush_runs").get().n, 0);
    assert.equal(f.modelCalls(), 0);
    if (++attempts === 1) throw stale;
    return original(...args);
  });
  f.model = async () => ({ text: "NO_REPLY" });
  assert.equal((await f.owner.flushBeforeCompaction(input)).status, "completed");
  assert.equal(read.mock.callCount(), 2);
  assert.equal(f.modelCalls(), 1);
});

test("flush reads the tape after an additive journal event at the worker boundary", async t => {
  const { f, input, turn } = await source(t);
  const original = f.owner.withAsyncMemoryReadView.bind(f.owner);
  const text = "The violet calibration lens is ready for the next observation.";
  let flushReads = 0;
  t.mock.method(f.owner, "withAsyncMemoryReadView", async (profileId, lifecycle, read, scanDeadline) => {
    const proof = await original(profileId, lifecycle, read, scanDeadline);
    // Only the flush passes a separate scan deadline in this fixture.
    if (profileId !== A || !scanDeadline) return proof;
    flushReads += 1;
    f.service.transcriptStore.appendEvent({ profileId: A, sessionId: turn.session.id,
      runId: turn.run.id, id: `worker-boundary-${flushReads}`, kind: "assistant", content: { text } });
    return proof;
  });
  f.model = async request => {
    assert.ok(request.prompt.includes(text));
    return { text: "NO_REPLY" };
  };
  assert.equal((await f.owner.flushBeforeCompaction(input)).status, "completed");
  assert.equal(flushReads, 1);
  assert.equal(f.modelCalls(), 1);
});

test("flush deadline returns a durable failure even if the model ignores cancellation; late text and restart cannot replay", async t => {
  const { f, input } = await source(t);
  let release, request, calls = 0;
  f.model = value => { calls++; request = value; return new Promise(resolve => { release = resolve; }); };
  const result = await f.owner.flushBeforeCompaction({ ...input, deadlineAt: f.now() + 100 });
  assert.equal(result.status, "failed"); assert.equal(result.error, "MEMORY_FLUSH_DEADLINE");
  assert.equal(request.signal.aborted, true);
  assert.ok(request.timeoutMs > 0 && request.timeoutMs <= 100);
  assert.equal(f.owner.maintenance.pending.size, 0);
  release({ text: '{"append":"Late calibration notes must not be stored."}' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.owner.store.list(A).every(item => !item.content.includes("Late calibration")));
  await f.owner.maintenance.close(); f.owner.maintenance.open();
  assert.deepEqual(await f.owner.flushBeforeCompaction(input), result);
  assert.equal(calls, 1);
});

test("preflight uses the same bounded deadline and does not retry a failed cycle", async t => {
  const { f, input, turn } = await source(t);
  f.model = () => new Promise(() => {});
  const options = { ...input, deadlineAt: f.now() + 100, contextWindowTokens: 128000,
    contextUsage: { usedTokens: 127000, quality: "exact", observedAt: f.now() } };
  assert.equal((await f.owner.observeBeforeSend(options)).error, "MEMORY_FLUSH_DEADLINE");
  const next = f.turn("More completed context in the same cycle.", turn.session); await f.finish(next);
  assert.equal((await f.owner.observeBeforeSend({ ...options, deadlineAt: f.now() + 100 })).status, "already-flushed");
  assert.equal(f.modelCalls(), 1);
});

test("a refused Codex isolation check records the failed flush and lets compaction proceed", async t => {
  const { f, input } = await source(t);
  f.model = async () => { throw Object.assign(new Error("unverified tool inventory"), { code: "RUNTIME_ISOLATION_UNVERIFIED" }); };
  const result = await f.owner.flushBeforeCompaction(input);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "RUNTIME_ISOLATION_UNVERIFIED");
  assert.equal(f.owner.store.list(A).length, 0);
  assert.deepEqual(await f.owner.flushBeforeCompaction(input), result);
  assert.equal(f.modelCalls(), 1, "a failed pre-compaction save is attempted once per cycle");
});

test("malformed output and typed model failures are optional for explicit pre-compaction flushes", async t => {
  const { f } = await source(t);
  const cases = [
    ["MEMORY_FLUSH_OUTPUT_INVALID", async () => ({ text: "malformed JSON" })],
    ["MEMORY_TEXT_MODEL_UNAVAILABLE", async () => { throw Object.assign(new Error(), { code: "MEMORY_TEXT_MODEL_UNAVAILABLE" }); }],
    ["RUNTIME_RATE_LIMITED", async () => { throw Object.assign(new Error(), { code: "RUNTIME_RATE_LIMITED" }); }],
    ["MEMORY_IMPORT_TIMEOUT", async () => { throw Object.assign(new Error(), { code: "MEMORY_IMPORT_TIMEOUT" }); }],
  ];
  for (const [error, model] of cases) {
    const turn = f.turn(`Calibration record for ${error}.`, boundSession(f));
    await f.finish(turn);
    const input = { profileId: A, sessionId: turn.session.id };
    f.model = model;
    const result = await f.owner.flushBeforeCompaction(input);
    assert.equal(result.status, "failed");
    assert.equal(result.error, error);
    assert.equal(result.outcome, "failed-optional");
    await f.owner.maintenance.close(); f.owner.maintenance.open();
    assert.deepEqual(await f.owner.flushBeforeCompaction(input), result);
  }
  assert.equal(f.modelCalls(), cases.length);
  assert.equal(f.owner.store.list(A).length, 0);
});

test("unknown, ownership and unsettled transaction failures are not optional even in preflight", async t => {
  const { f } = await source(t);
  const cases = ["MODEL_ONLY_ACCEPTANCE_UNKNOWN", "MEMORY_TRANSACTION_UNSETTLED", "MEMORY_IMPORT_BINDING_STALE", "UNRECOGNIZED_FAILURE"];
  for (const code of cases) {
    const turn = f.turn(`Calibration record for ${code}.`, boundSession(f));
    await f.finish(turn);
    const input = { profileId: A, sessionId: turn.session.id };
    // Text deliberately resembles an optional provider error. Only a trusted
    // code from the expected stage can make a failure optional.
    f.model = async () => { throw Object.assign(new Error("HTTP 429: too many requests"), { code }); };
    await assert.rejects(f.owner.observeBeforeSend({ ...input, contextWindowTokens: 128000,
      contextUsage: { usedTokens: 127000, quality: "exact", observedAt: f.now() } }), { code });
    await f.finish(f.turn("More completed context in the same cycle.", turn.session));
    await f.owner.maintenance.close(); f.owner.maintenance.open();
    await assert.rejects(f.owner.flushBeforeCompaction(input), { code });
  }
  assert.equal(f.modelCalls(), cases.length);
});

test("an interrupted legacy flush receipt requires checking the original operation and never replays", async t => {
  const { f, input } = await source(t);
  f.model = async () => ({ text: "NO_REPLY" });
  const result = await f.owner.flushBeforeCompaction(input);
  const db = f.owner.database.db;
  db.prepare("UPDATE memory_flush_runs SET state='running',receipt=NULL WHERE id=?").run(result.id);
  await f.owner.maintenance.close(); f.owner.maintenance.open();
  await assert.rejects(f.owner.flushBeforeCompaction(input), { code: "MEMORY_FLUSH_RECOVERY_REQUIRED" });
  assert.equal(f.modelCalls(), 1);
});

test("known optional legacy model failures remain skippable after reopening", async t => {
  const { f, input } = await source(t);
  f.model = async () => {
    throw Object.assign(new Error("local-only memory configured"), { code: "MEMORY_TEXT_MODEL_DISABLED" });
  };
  const result = await f.owner.flushBeforeCompaction(input);
  const db = f.owner.database.db;
  db.prepare("UPDATE memory_flush_runs SET receipt=? WHERE id=?").run(JSON.stringify({ error: result.error }), result.id);
  await f.owner.maintenance.close(); f.owner.maintenance.open();
  const reopened = await f.owner.flushBeforeCompaction(input);
  assert.equal(reopened.status, "failed");
  assert.equal(reopened.error, "MEMORY_TEXT_MODEL_DISABLED");
  assert.equal(f.modelCalls(), 1);
});

test("default flush budget is sixty seconds and successful publication clears the deadline", async t => {
  const { f, input } = await source(t);
  assert.equal(MEMORY_FLUSH_BUDGET_MS, 60_000);
  f.model = async request => {
    assert.ok(request.timeoutMs > 59_000 && request.timeoutMs <= MEMORY_FLUSH_BUDGET_MS);
    return { text: '{"append":"The telescope calibration happens every evening."}' };
  };
  assert.equal((await f.owner.flushBeforeCompaction(input)).appended, true);
});

test("an answer received in time is still published when its write crosses the deadline", async t => {
  const { f, input } = await source(t);
  f.model = async () => ({ text: '{"append":"The telescope calibration happens every evening."}' });
  const original = f.owner.store.upsertMany;
  // The model answered within the budget; the clock passes the deadline only
  // while the notes wait to be written (for example behind another writer).
  f.owner.store.upsertMany = (items, options) => { f.advance(1_000); return original.call(f.owner.store, items, options); };
  try {
    const result = await f.owner.flushBeforeCompaction({ ...input, deadlineAt: f.now() + 500 });
    assert.equal(result.status, "completed");
    assert.equal(result.appended, true);
  } finally { f.owner.store.upsertMany = original; }
});

test("source withdrawal during a timed-out flush still rejects instead of authorizing compaction", async t => {
  const { f, input, turn } = await source(t);
  f.model = () => {
    f.service.transcriptStore.setContextExcluded({ profileId: A, sessionId: turn.session.id,
      eventId: turn.event.id, contextExcluded: true });
    return new Promise(() => {});
  };
  await assert.rejects(f.owner.flushBeforeCompaction({ ...input, deadlineAt: f.now() + 100 }),
    error => ["MEMORY_SOURCE_REVOKED", "MEMORY_SESSION_CHANGED"].includes(error.code));
});

test("profile cancellation rejects a non-cooperative model and uncertain writes are never swallowed", async t => {
  const { f, input } = await source(t);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.model = () => { entered(); return new Promise(() => {}); };
  const pending = f.owner.flushBeforeCompaction(input);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await started; await f.owner.stopProfile(A); await rejected;
  f.owner.resumeProfile(A);
  const turn = f.turn("A fresh session with calibration information.", boundSession(f)); await f.finish(turn);
  f.model = async () => ({ text: '{"append":"A fresh calibration note."}' });
  const original = f.owner.store.upsertMany;
  f.owner.store.upsertMany = async () => { throw Object.assign(new Error("uncertain"), { code: "MEMORY_WRITE_UNCERTAIN" }); };
  try {
    const writing = { profileId: A, sessionId: turn.session.id };
    await assert.rejects(f.owner.flushBeforeCompaction(writing), { code: "MEMORY_WRITE_UNCERTAIN" });
    await f.owner.maintenance.close(); f.owner.maintenance.open();
    await assert.rejects(f.owner.flushBeforeCompaction(writing), { code: "MEMORY_WRITE_UNCERTAIN" });
    assert.equal(f.modelCalls(), 2);
  } finally { f.owner.store.upsertMany = original; }
});
