"use strict";

// Memory repair stage 4: own recall signals count once per user event, only
// after a completed turn without borrowed dependencies, with the original
// relevance, and never block run cleanup.
const test = require("node:test"), assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { A, DAY, FACT, fixture } = require("./fixtures/memory-repair-fixture.cjs");
const { RECALL_SIGNAL_RECEIPTS_NAMESPACE } = require("../app/agent-service/shoggoth-memory/recall-signals.cjs");

const QUERY = "amber telescope calibrated";
const daily = entries => entries.find(entry => /^memory\/\d{4}-\d{2}-\d{2}\.md$/u.test(entry.path));
async function withNote(t) { const f = await fixture(t); await f.dailyNote(`- ${FACT}`); return f; }
async function ask(f, text, { searches = 1, status = "completed", session } = {}) {
  const input = f.turn(text, session);
  for (let i = 0; i < searches; i++) await f.search(QUERY, input, { minScore: 0 });
  await f.finish(input, status);
  return input;
}

test("several searches in one turn count once", { timeout: 60000 }, async t => {
  const f = await withNote(t);
  await ask(f, "When is the amber telescope calibrated?", { searches: 3 });
  const entry = daily(await f.recallEntries());
  assert.equal(entry?.recallCount, 1); assert.equal(entry?.userQueryHashes?.length, 1);
});

test("failed and cancelled turns never count", { timeout: 60000 }, async t => {
  const f = await withNote(t);
  await ask(f, "When is the amber telescope calibrated?", { status: "failed" });
  await ask(f, "How often is the telescope calibrated?", { status: "canceled" });
  assert.equal(daily(await f.recallEntries())?.userQueryHashes?.length ?? 0, 0);
  const reasons = f.diagnostics().filter(record => record.stage === "recall-signal").map(record => record.code);
  assert.deepEqual(reasons, ["NOT_COMPLETED", "NOT_COMPLETED"], "each dropped turn leaves its reason");
});

test("a user event older than the acceptance window never counts", { timeout: 60000 }, async t => {
  const f = await withNote(t);
  const input = f.turn("When is the amber telescope calibrated?");
  await f.search(QUERY, input, { minScore: 0 });
  f.advance(8 * DAY);
  await f.finish(input);
  assert.equal(daily(await f.recallEntries())?.userQueryHashes?.length ?? 0, 0);
});

test("a session whose history borrowed another Agent's memory never counts own hits", { timeout: 60000 }, async t => {
  const f = await withNote(t);
  await f.saveForeign("The amber telescope belongs to the eastern observatory.");
  const session = f.session();
  const first = f.turn("What about the amber telescope?", session);
  assert.ok((await f.search("amber telescope", first, { minScore: 0 })).results.some(result => result.borrowed === true));
  // The borrowed answer becomes part of the session history.
  f.service.transcriptStore.appendEvent({ profileId: A, sessionId: session.id, id: crypto.randomUUID(), runId: first.run.id,
    kind: "assistant", content: { text: "It belongs to the eastern observatory." }, occurredAt: f.now() });
  await f.finish(first);
  await ask(f, "When is it calibrated?", { session });
  assert.equal(daily(await f.recallEntries())?.userQueryHashes?.length ?? 0, 0);
});

test("concurrent commits for the same user event count once", { timeout: 60000 }, async t => {
  const f = await withNote(t), signals = f.owner.recallSignals;
  const input = f.turn("When is the amber telescope calibrated?");
  await f.search(QUERY, input, { minScore: 0 });
  const staged = signals.pending.get(signals.key(A, input.run.id));
  const twin = { ...input.run, id: crypto.randomUUID() };
  signals.pending.set(signals.key(A, twin.id), { profileId: A, results: new Map(staged.results) });
  const question = signals.question(A, input.run);
  signals.question = () => question;
  const outcomes = await Promise.all([signals.commit(input.run, "completed"), signals.commit(twin, "completed")]);
  assert.deepEqual(outcomes.map(outcome => outcome.committed).sort(), [0, 1]);
  assert.equal(daily(await f.recallEntries())?.recallCount, 1);
  await f.finish(input);
});

test("a full receipt store refuses new signals instead of evicting old receipts", { timeout: 120000 }, async t => {
  const f = await withNote(t);
  const store = f.owner.host(A).database.openKeyedStore({ namespace: RECALL_SIGNAL_RECEIPTS_NAMESPACE, maxEntries: 20_000,
    defaultTtlMs: 14 * DAY, overflowPolicy: "reject-new" });
  for (let i = 0; i < 20_000; i++) await store.registerIfAbsent(`filler-${i}`, { at: f.now() });
  await ask(f, "When is the amber telescope calibrated?");
  assert.equal(daily(await f.recallEntries())?.userQueryHashes?.length ?? 0, 0);
  assert.ok(await store.lookup("filler-0"), "old receipts survive");
});

test("the counted relevance is the same with sharing on or off", { timeout: 120000 }, async t => {
  const scores = [];
  for (const sharing of [true, false]) {
    const f = await withNote(t); if (!sharing) await f.sharing(false);
    await ask(f, "When is the amber telescope calibrated?");
    const entry = daily(await f.recallEntries());
    assert.equal(entry?.recallCount, 1); scores.push(entry.totalScore);
  }
  // Two separate indexes differ in tiny bm25 statistics, never by the fused
  // rank (about 0.017 for the top result).
  assert.ok(Math.abs(scores[0] - scores[1]) < 1e-3, `${scores[0]} vs ${scores[1]}`);
  assert.ok(scores[0] > 0.1, `own relevance is kept, not the fused rank (${scores[0]})`);
});

test("a failing signal commit still cleans up borrowing and recall state", { timeout: 60000 }, async t => {
  const f = await withNote(t);
  f.owner.host(A).searchIndex.recordRecallSignals = async () => { throw Object.assign(new Error("disk full"), { code: "SQLITE_FULL" }); };
  const input = f.turn("When is the amber telescope calibrated?");
  await f.search(QUERY, input, { minScore: 0 });
  await f.finish(input);
  assert.equal(f.owner.recallSignals.pending.size, 0);
  assert.equal(f.owner.sharing.requests.has(input.run.id), false);
  assert.ok(f.diagnostics().some(record => record.stage === "recall-signal" && record.outcome === "error" && record.code === "SQLITE_FULL"));
});

test("stopping a Profile discards its staged signals", { timeout: 60000 }, async t => {
  const f = await withNote(t);
  const input = f.turn("When is the amber telescope calibrated?");
  await f.search(QUERY, input, { minScore: 0 });
  assert.equal(f.owner.recallSignals.pending.size, 1);
  await f.owner.stopProfile(A);
  assert.equal(f.owner.recallSignals.pending.size, 0);
});

async function promotes(t, questions) {
  const f = await withNote(t);
  for (const question of questions) { await ask(f, question); f.advance(DAY); }
  f.model = async () => ({ text: "NONE" });
  assert.equal((await f.owner.dream(A)).handled, true);
  const memory = () => f.owner.store.readFile(A, "MEMORY.md");
  const promoted = memory().includes("calibrated every evening");
  if (promoted) {
    assert.equal((await f.owner.dream(A)).handled, true);
    assert.equal(memory().split("calibrated every evening").length - 1, 1, "a second Dreaming run never promotes it again");
  }
  return { promoted, entry: daily(await f.recallEntries()), memory: memory() };
}

test("enough different user questions on different days promote the clean daily fact into MEMORY.md once", { timeout: 120000 }, async t => {
  // Upstream needs >= 3 of each and a 0.75 blend; with exactly three the blend
  // is about 0.71, so the evidence must keep growing before a promotion.
  const { promoted, entry, memory } = await promotes(t, ["When is the amber telescope calibrated?",
    "How often is the amber telescope lens calibrated?", "What is calibrated every evening?",
    "Is the telescope calibrated daily?", "Which lens gets calibrated in the evening?"]);
  assert.equal(promoted, true, JSON.stringify(entry));
  assert.match(memory, /^- The amber telescope lens is calibrated every evening\. \[score=/mu);
  assert.doesNotMatch(memory, /shoggoth-memory-entry|^- - /mu, "storage markers never become memory");
});

test("the same question asked three times reaches the count but not the diversity gate", { timeout: 120000 }, async t => {
  const question = "When is the amber telescope calibrated?";
  const { promoted, entry } = await promotes(t, [question, question, question]);
  assert.equal(entry?.recallCount, 3); assert.equal(entry?.userQueryHashes?.length, 1);
  assert.equal(promoted, false);
});
