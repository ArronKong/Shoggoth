"use strict";

// Baseline for the 2026-10-28 memory repair plan. "defect" cases fail before
// the repair and pass after it; "guard" cases must pass both before and after.
const test = require("node:test"), assert = require("node:assert/strict");
const { A, DAY, FACT, fixture, recallModel } = require("./fixtures/memory-repair-fixture.cjs");

// ---------------------------------------------------------------- P1

test("defect P1: own search survives an unrelated transcript append", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.saveUser(FACT);
  const input = f.turn("amber telescope"), other = f.session();
  for (let i = 0; i < 5; i++) {
    const pending = f.search("amber telescope", input, { minScore: 0 });
    setImmediate(() => f.noise(other));
    const found = await pending;
    assert.ok(found.results.some(result => result.path === "USER.md"));
  }
  await f.finish(input);
});

test("defect P1: own search survives a session metadata update", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.saveUser(FACT);
  const input = f.turn("amber telescope"), other = f.session();
  for (let i = 0; i < 5; i++) {
    const pending = f.search("amber telescope", input, { minScore: 0 });
    setImmediate(() => f.service.chatSessionStore.touchSession(other.sessionKey, f.now()));
    assert.ok((await pending).results.some(result => result.path === "USER.md"));
  }
  await f.finish(input);
});

test("defect P1: a prepared recall survives ordinary appends before it is taken", { timeout: 60000 }, async t => {
  const f = await fixture(t, { mode: "always" }); await f.saveUser(FACT);
  recallModel(f, "amber telescope");
  const input = f.turn("What do you remember about the amber telescope?", undefined, { queued: true });
  await f.owner.prepareActiveMemory(input);
  f.noise(f.session());
  const taken = f.owner.takeActiveMemory(input);
  assert.match(taken?.content || "", /calibrated every evening/u);
  await f.finish(input);
});

test("defect P1: recall evidence survives an append to the same memory file", { timeout: 60000 }, async t => {
  const f = await fixture(t, { mode: "always" }); await f.saveUser(FACT);
  recallModel(f, "amber telescope", { during: () => f.saveUser("Violet ink dries overnight.") });
  const input = f.turn("What do you remember about the amber telescope?", undefined, { queued: true });
  await f.owner.prepareActiveMemory(input);
  const taken = f.owner.takeActiveMemory(input);
  assert.match(taken?.content || "", /calibrated every evening/u);
  await f.finish(input);
});

test("guard P1: excluding a message from context during a search still conflicts", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.saveUser(FACT);
  const input = f.turn("amber telescope"), other = f.session(), excluded = f.noise(other);
  const pending = f.search("amber telescope", input, { minScore: 0 });
  setImmediate(() => f.service.transcriptStore.setContextExcluded({ profileId: A, sessionId: other.id, eventId: excluded.id, contextExcluded: true }));
  await assert.rejects(pending, { code: "MEMORY_REVISION_CONFLICT" });
  await f.finish(input);
});

test("guard P1: repeated reads of the same unchanged file keep recall evidence", { timeout: 60000 }, async t => {
  const f = await fixture(t, { mode: "always" }); await f.saveUser(FACT);
  recallModel(f, "amber telescope", { steps: [
    { tool: "memory_search", arguments: { query: "amber telescope", minScore: 0, maxResults: 20 } },
    { tool: "memory_get", arguments: { path: "USER.md" } },
  ] });
  const input = f.turn("What do you remember about the amber telescope?", undefined, { queued: true });
  await f.owner.prepareActiveMemory(input);
  assert.match(f.owner.takeActiveMemory(input)?.content || "", /calibrated every evening/u);
  await f.finish(input);
});

// ---------------------------------------------------------------- P2

const CHINESE_FACTS = ["查新闻时要注意时效性，每个新闻都要写出具体日期和来源。", "搜索X的信息可以用这个bird工具。", "长内容可以优化一下信息排版。"];

test("defect P2: Chinese short terms find the stored preference at the default threshold", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  for (const fact of CHINESE_FACTS) await f.saveUser(fact);
  const input = f.turn("中文检索");
  for (const query of ["新闻", "时效性", "bird", "排版"]) {
    const found = await f.search(query, input);
    const rank = found.results.findIndex(result => result.path === "USER.md");
    assert.ok(rank >= 0 && rank < 5, `「${query}」should find USER.md in the top 5`);
  }
  await f.finish(input);
});

test("guard P2: an unrelated Chinese term does not match the preference", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  for (const fact of CHINESE_FACTS) await f.saveUser(fact);
  const input = f.turn("中文检索");
  const found = await f.search("天气预报", input);
  assert.equal(found.results.filter(result => result.path === "USER.md").length, 0);
  await f.finish(input);
});

// ---------------------------------------------------------------- P3

async function deepRecallStarts(f, message) {
  const before = f.modelCalls();
  recallModel(f, "工具");
  const input = f.turn(message, undefined, { queued: true });
  await f.owner.prepareActiveMemory(input); f.owner.takeActiveMemory(input);
  await f.finish(input);
  return f.modelCalls() - before;
}

test("defect P3: natural Chinese recall questions start deep recall", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  for (const message of ["上次我们讨论过哪个方案？", "我之前用的那个工具叫什么？"]) {
    assert.ok(await deepRecallStarts(f, message) > 0, `「${message}」should start deep recall`);
  }
});

test("guard P3: ordinary Chinese questions do not start deep recall", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  for (const message of ["今天有什么新闻？", "明天记得提醒我"]) {
    assert.equal(await deepRecallStarts(f, message), 0, `「${message}」must not start deep recall`);
  }
});

// ---------------------------------------------------------------- P4

async function askAbout(f, text, query = "amber telescope calibrated") {
  const input = f.turn(text);
  const found = await f.search(query, input, { minScore: 0 });
  await f.finish(input);
  return found;
}
const dailyEntry = entries => entries.find(entry => /^memory\/\d{4}-\d{2}-\d{2}\.md$/u.test(entry.path));

test("defect P4: an own daily-note hit counts once a user turn completes with sharing on", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.dailyNote(`- ${FACT}`)).appended, true);
  const found = await askAbout(f, "When is the amber telescope calibrated?");
  assert.ok(found.results.some(result => /^memory\/\d{4}/u.test(result.path)));
  assert.equal(dailyEntry(await f.recallEntries())?.userQueryHashes?.length, 1);
});

test("defect P4: questions A, B, A over two days count three recalls and two questions", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.dailyNote(`- ${FACT}`);
  await askAbout(f, "When is the amber telescope calibrated?");
  f.advance(DAY);
  await askAbout(f, "How often is the telescope lens calibrated?");
  await askAbout(f, "When is the amber telescope calibrated?");
  const entry = dailyEntry(await f.recallEntries());
  assert.equal(entry?.recallCount, 3);
  assert.equal(entry?.userQueryHashes?.length, 2);
});

test("guard P4: a turn that borrowed another Agent's memory never counts own hits", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.dailyNote(`- ${FACT}`);
  await f.saveForeign("The amber telescope belongs to the eastern observatory.");
  const found = await askAbout(f, "What about the amber telescope?", "amber telescope");
  assert.ok(found.results.some(result => result.borrowed === true), "the fixture must actually borrow");
  assert.equal(dailyEntry(await f.recallEntries())?.userQueryHashes?.length ?? 0, 0);
});

// ---------------------------------------------------------------- P5

test("defect P5: a flushed list is written as separate top-level entries", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const result = await f.dailyNote(`- ${FACT}\n- Violet ink dries overnight.`);
  const text = f.owner.store.readFile(A, result.path);
  assert.doesNotMatch(text, /^- - /mu);
  assert.equal((text.match(/<!-- shoggoth-memory-entry:/gu) || []).length, 2);
});

// ---------------------------------------------------------------- P6

test("defect P6: a recall model failure leaves a diagnostic with its original code and no text", { timeout: 60000 }, async t => {
  const f = await fixture(t, { mode: "always" }); await f.saveUser(FACT);
  f.model = async () => { throw Object.assign(new Error("synthetic provider stderr amber"), { code: "SYNTHETIC_MODEL_FAILURE" }); };
  const input = f.turn("What do you remember about the amber telescope?", undefined, { queued: true });
  await f.owner.prepareActiveMemory(input); f.owner.takeActiveMemory(input);
  await f.finish(input);
  const records = f.diagnostics();
  assert.ok(records.some(record => record.code === "SYNTHETIC_MODEL_FAILURE"), JSON.stringify(records));
  assert.doesNotMatch(JSON.stringify(records), /amber|telescope/u);
});
