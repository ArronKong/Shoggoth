"use strict";

// Memory repair stage 5: a flushed list is written as one entry per top-level
// item, so daily ingestion no longer joins unrelated facts as parent > child.
// Entries already written in the old nested form stay readable.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { A, FACT, fixture } = require("./fixtures/memory-repair-fixture.cjs");
const { splitFlushEntries } = require("../app/agent-service/shoggoth-memory/maintenance.cjs");

const entries = text => (text.match(/<!-- shoggoth-memory-entry:[^>]+ -->\n[\s\S]*?\n<!-- \/shoggoth-memory-entry -->/gu) || []);

test("splitFlushEntries keeps children with their parent and leaves prose whole", () => {
  assert.deepEqual(splitFlushEntries("- One.\n- Two.\n  - Detail of two.\n* Three."), ["One.", "Two.\n- Detail of two.", "Three."]);
  assert.deepEqual(splitFlushEntries("A plain paragraph.\nSecond line."), ["A plain paragraph.\nSecond line."]);
  assert.deepEqual(splitFlushEntries("Intro line.\n- One.\n- Two."), ["Intro line.\n- One.\n- Two."], "mixed prose stays one entry");
  assert.deepEqual(splitFlushEntries("1. First.\n2. Second."), ["First.", "Second."]);
});

test("a flushed list becomes separate top-level entries with one bullet each", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const result = await f.dailyNote(`- ${FACT}\n- Violet ink dries overnight.\n  - It needs a cool room.`);
  assert.equal(result.appended, true); assert.equal(result.itemIds.length, 2); assert.equal(result.itemId, result.itemIds[0]);
  const text = f.owner.store.readFile(A, result.path);
  assert.doesNotMatch(text, /^- - /mu);
  assert.equal(entries(text).length, 2);
  assert.match(text, /- Violet ink dries overnight\.\n  - It needs a cool room\./u, "a child stays nested under its own parent");
});

test("prose output stays a single entry", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const result = await f.dailyNote("The telescope routine is stable and needs no change.");
  assert.equal(result.itemIds.length, 1);
  assert.equal(entries(f.owner.store.readFile(A, result.path)).length, 1);
});

test("an old nested entry stays readable, searchable and safe for Dreaming", { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const result = await f.dailyNote(`- ${FACT}`);
  // Rewrite the file as the old renderer did: "- - " on the first line.
  const file = path.join(f.owner.store.workspace(A), result.path);
  const old = fs.readFileSync(file, "utf8").replace(`- ${FACT}`, `- - ${FACT}\n  - Violet ink dries overnight.`);
  fs.writeFileSync(file, old, { mode: 0o600 });
  const input = f.turn("amber telescope");
  const found = await f.search("amber telescope calibrated", input, { minScore: 0 });
  assert.ok(found.results.some(row => row.path === result.path));
  await f.finish(input);
  f.model = async () => ({ text: "NONE" });
  assert.equal((await f.owner.dream(A)).handled, true);
});
