"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs"), path = require("node:path");
const { A, FACT, fixture, recallModel } = require("./fixtures/memory-repair-fixture.cjs");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function drainWarm(owner, id) {
  const end = Date.now() + 10_000;
  while (owner.indexWarmTimers.has(id) || owner.indexWarmFlights.has(id)) {
    if (Date.now() > end) throw Error("warm did not drain");
    await delay(20);
  }
}

test("background preparation retains fresh writes, external edits and immediate forgetting barriers", { timeout: 60_000 }, async t => {
  const f = await fixture(t), saved = await f.saveUser(FACT);
  assert.ok(f.owner.indexWarmTimers.has(A), "a committed memory write schedules indexing");
  await drainWarm(f.owner, A);
  const input = f.turn("amber telescope");
  assert.ok((await f.search("amber telescope", input, { minScore: 0 })).results.some(row => row.snippet.includes("calibrated")));
  // No background timer has run for this new write. Foreground still sees it.
  await f.saveUser("A violet astrolabe is stored in the north cabinet.");
  assert.ok((await f.search("violet astrolabe", input, { minScore: 0 })).results.some(row => row.snippet.includes("astrolabe")));
  const file = path.join(f.owner.store.workspace(A), "MEMORY.md");
  fs.appendFileSync(file, "\nThe copper sundial is stored by the window.\n");
  assert.ok((await f.search("copper sundial", input, { minScore: 0 })).results.some(row => row.snippet.includes("sundial")),
    "external edits still pass through the full freshness barrier");
  await f.owner.delete({ profileId: A, id: saved.id, reason: "forgotten", operationId: crypto.randomUUID() });
  assert.ok(!(await f.search("amber telescope", input, { minScore: 0 })).results.some(row => row.snippet.includes("calibrated")));
  await f.finish(input);
});

test("full model recall waits beyond 1.5 seconds and preserves source revocation before use", { timeout: 60_000 }, async t => {
  const f = await fixture(t, { mode: "always" }), saved = await f.saveUser(FACT);
  recallModel(f, "amber telescope", { during: () => delay(1700) });
  const input = f.turn("What do you remember about the amber telescope?", undefined, { queued: true });
  let finished = false;
  const pending = f.owner.prepareActiveMemory(input).then(() => { finished = true; });
  await delay(1550);
  assert.equal(finished, false, "latency optimization must not bypass model recall after 1.5 seconds");
  await pending;
  const prepared = f.owner.takeActiveMemory(input);
  assert.match(prepared?.content || "", /calibrated every evening/u);
  await f.owner.delete({ profileId: A, id: saved.id, reason: "forgotten", operationId: crypto.randomUUID() });
  assert.equal(f.owner.activeMemory.valid(input, prepared), false, "warmed results cannot outlive source withdrawal");
  await f.finish(input);
});

test("stopping a profile cancels queued warm work before closing its search index", { timeout: 60_000 }, async t => {
  const f = await fixture(t); await f.saveUser(FACT);
  f.owner.scheduleIndexWarm(A); assert.ok(f.owner.indexWarmTimers.has(A));
  await f.owner.stopProfile(A);
  assert.equal(f.owner.indexWarmTimers.has(A), false);
  assert.equal(f.owner.indexWarmFlights.has(A), false);
  f.owner.scheduleIndexWarm(A);
  assert.equal(f.owner.indexWarmTimers.has(A), false);
});
