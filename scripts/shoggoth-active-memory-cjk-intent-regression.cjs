"use strict";

// Memory repair stage 3: Chinese recall questions the upstream rules miss
// start deep recall once, through a fresh Runtime for the same turn, and only
// when the upstream decision found no strong direct hit.
const test = require("node:test"), assert = require("node:assert/strict");
const { A, fixture } = require("./fixtures/memory-repair-fixture.cjs");
const { hasLocalizedRecallIntent } = require("../app/agent-service/shoggoth-memory/cjk-recall-intent.cjs");
const { triggerExcerpt, presentTriggerCandidates } = require("../app/agent-service/shoggoth-memory/trigger-presentation.cjs");

test("trigger presentation preserves authored text, hierarchy, evidence and eligibility", () => {
  const raw = "<!-- shoggoth-memory-entry:sample -->\n- Parent\n  - Child\n  &lt;!-- shoggoth-memory-entry:authored -->\n<!-- /shoggoth-memory-entry -->";
  assert.equal(triggerExcerpt(raw), "Parent\n  - Child\n  &lt;!-- shoggoth-memory-entry:authored -->");
  const input = { snippet: raw, triggers: "writing commit", id: "sample", path: "USER.md", startLine: 4,
    endLine: 8, score: 0.6, projectKey: "workspace:sample", source: "memory", provenance: { originClass: "model_generated" },
    borrowed: true, borrowedMemoryRefs: [{ sourceProfileId: "source" }] };
  const copy = structuredClone(input);
  const [result] = presentTriggerCandidates([input], "我之前 writing commit 用的规范叫什么？");
  assert.deepEqual(input, copy, "the stored candidate remains untouched");
  assert.deepEqual({ ...result, snippet: input.snippet }, input, "English triggers and all authority fields survive exactly");
  assert.equal(presentTriggerCandidates([{ ...input, triggers: "新闻时效性" }], "今天有什么新闻？")[0].triggers, "新闻时效性");
  assert.equal(presentTriggerCandidates([{ ...input, triggers: "newstool 工具" }], "newstoolbox 工具")[0].triggers, "newstool 工具");
});

test("Chinese recall phrasing is recognised; questions, reminders, hypotheticals and quotes are not", () => {
  for (const message of ["我之前用的那个工具叫什么？", "上次我们讨论过哪个方案？", "以前告诉你的偏好还记得吗", "我们聊过这个吗",
    "我的偏好是什么", "昨天发的那篇文章链接是啥", "上周定的会议时间是几点"]) assert.equal(hasLocalizedRecallIntent(message), true, message);
  for (const message of ["今天有什么新闻？", "明天记得提醒我", "以后记得用中文回复", "如果之前的方案不行怎么办", "帮我写一个排序函数",
    "这个按钮叫什么", "他说「我之前用的那个工具很好」你怎么看", "下次讨论这个方案", "", undefined]) assert.equal(hasLocalizedRecallIntent(message), false, String(message));
});

// Counts deep recall starts. The host runs the initial lookup itself, so a
// model that answers at once makes exactly one call per deep recall.
function countingRecall(f, { during } = {}) {
  let starts = 0;
  f.model = async () => {
    starts++;
    await during?.();
    return { text: JSON.stringify({ summary: "NONE" }) };
  };
  return () => starts;
}
async function ask(f, message, extra = {}) {
  const input = { ...f.turn(message, undefined, { queued: true }), ...extra };
  await f.owner.prepareActiveMemory(input);
  const taken = f.owner.takeActiveMemory(input);
  await f.finish(input);
  return taken;
}

test("a Chinese recall question without a strong hit starts deep recall exactly once", { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.saveUser("常用的搜索工具是 bird。");
  const calls = countingRecall(f);
  await ask(f, "我之前用的那个工具叫什么？");
  assert.equal(calls(), 1);
});

test("a strong direct hit keeps priority over the Chinese rule", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.saveUser("Use concise commit descriptions. <!-- trigger:writing commit -->");
  const calls = countingRecall(f);
  const taken = await ask(f, "我之前 writing commit 用的规范叫什么？");
  assert.equal(calls(), 0, "no deep recall starts");
  assert.match(taken?.content || "", /concise commit descriptions/u, "the strong hit is injected directly");
  assert.doesNotMatch(taken.content, /shoggoth-memory-entry|^- - /mu, "storage wrappers are not model context");
});

test("Chinese trigger words match within natural questions and across scripts", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.saveUser("常用的信息检索工具是 bird。 <!-- trigger:工具 -->");
  const calls = countingRecall(f);
  for (const message of ["我之前用的那个工具叫什么？", "之前那個工具叫什麼？"]) {
    const taken = await ask(f, message);
    assert.match(taken?.content || "", /bird/u, message);
    assert.doesNotMatch(taken.content, /shoggoth-memory-entry|^- - /mu);
  }
  assert.equal(calls(), 0, "matching a Chinese word does not launch deep recall");
});

test("Chinese multiword triggers require all content terms; unrelated and single characters do not match", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.saveUser("新闻必须带具体发布日期。 <!-- trigger:新聞時效性 -->");
  await f.saveUser("单字不能触发这个事实。 <!-- trigger:新 -->");
  const calls = countingRecall(f);
  const taken = await ask(f, "之前的新闻需要注意什么时效性？");
  assert.match(taken?.content || "", /具体发布日期/u);
  assert.equal(calls(), 0);
  for (const message of ["今天有什么新闻？", "时效性如何定义？", "新工具有哪些？", "今天的天气如何？"]) {
    const miss = await ask(f, message);
    assert.doesNotMatch(miss?.content || "", /具体发布日期|单字不能触发/u, message);
  }
  assert.equal(calls(), 0, "ordinary misses do not acquire a model");
});

test("a question the upstream rules already recognise is not recalled twice", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const calls = countingRecall(f);
  await ask(f, "你还记得我们之前聊过的什么吗？");
  assert.equal(calls(), 1);
});

test("disabled recall never reaches the Chinese rule", { timeout: 60000 }, async t => {
  const f = await fixture(t, { mode: "off" });
  const calls = countingRecall(f);
  await ask(f, "我之前用的那个工具叫什么？");
  assert.equal(calls(), 0);
});

test("cancelling the turn during the second pass returns nothing and cleans up", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  countingRecall(f, { during: () => controller.abort() });
  assert.equal(await ask(f, "我之前用的那个工具叫什么？", { signal: controller.signal }), null);
  assert.equal(f.owner.host(A).database.db.prepare("SELECT count(*) AS n FROM memory_state WHERE namespace='active-memory-runtime' AND value IS NOT NULL").get().n, 0);
});

test("two concurrent turns each start their own deep recall once", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const calls = countingRecall(f);
  await Promise.all([ask(f, "我之前用的那个工具叫什么？"), ask(f, "上次我们讨论过哪个方案？")]);
  assert.equal(calls(), 2);
});
