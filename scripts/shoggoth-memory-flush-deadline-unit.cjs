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
    await assert.rejects(f.owner.flushBeforeCompaction({ profileId: A, sessionId: turn.session.id }), { code: "MEMORY_WRITE_UNCERTAIN" });
  } finally { f.owner.store.upsertMany = original; }
});
