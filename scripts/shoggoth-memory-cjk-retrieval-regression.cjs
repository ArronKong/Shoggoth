"use strict";

// Memory repair stage 2: Chinese and mixed short terms find stored memory
// through the trigram index plus planned-term coverage scoring.
const test = require("node:test"), assert = require("node:assert/strict");
const { hasCjk, planCjkQueryTerms, scoreCjkCandidate } = require("../app/agent-service/shoggoth-memory/cjk-query.cjs");
const { A, fixture } = require("./fixtures/memory-repair-fixture.cjs");

test("query planning keeps content words and drops function and recall words", () => {
  assert.deepEqual(planCjkQueryTerms("我之前用的那个工具叫什么？"), ["工具"]);
  assert.deepEqual(planCjkQueryTerms("排版有什么要求"), ["排版", "要求"]);
  assert.ok(planCjkQueryTerms("搜索X的信息可以用这个bird工具").includes("bird"));
  assert.deepEqual(planCjkQueryTerms("amber telescope"), [], "Latin-only queries stay with the upstream planner");
  assert.deepEqual(planCjkQueryTerms(""), []);
  assert.ok(planCjkQueryTerms("新闻时效性排版来源日期工具方案".repeat(800)).length <= 8, "long input is bounded");
  assert.equal(hasCjk("Tibo"), false); assert.equal(hasCjk("新闻"), true);
});

test("coverage scoring prefers the fact that holds every term and ignores misses", () => {
  const terms = planCjkQueryTerms("查新闻 时效性");
  const fact = scoreCjkCandidate("查新闻时要注意时效性，每个新闻都要写出具体日期和来源。", terms);
  const partial = scoreCjkCandidate(`今天的新闻很多。${"其他内容。".repeat(60)}`, terms);
  assert.ok(fact >= 0.35 && fact > partial, `${fact} > ${partial}`);
  assert.equal(scoreCjkCandidate("完全无关的一段话。", terms), 0);
  assert.equal(scoreCjkCandidate(undefined, terms), 0);
});

test("short, mixed, cased and traditional queries find stored memory at the default threshold", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  for (const fact of ["查新闻时要注意时效性，每个新闻都要写出具体日期和来源。", "搜索X的信息可以用这个bird工具。", "排版要清晰：查新聞時要注意時效性。"]) await f.saveUser(fact);
  const input = f.turn("中文检索");
  await f.search("新闻", input);
  assert.match(f.owner.host(A).searchIndex.db.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_index_chunks_fts'").get().sql,
    /trigram/u, "the Product default index uses the trigram tokenizer");
  for (const query of ["新闻", "BIRD", "bird工具", "時效性", "新聞", "我之前用的那个工具叫什么？"]) {
    const found = await f.search(query, input);
    assert.ok(found.results.some(row => row.path === "USER.md"), `「${query}」should find USER.md`);
  }
  await f.finish(input);
});

test("separate simplified-only and traditional-only memories are searchable in both scripts", { timeout: 60000 }, async t => {
  for (const [fact, queries] of [
    ["新闻必须列出日期和来源；头发颜色为棕色，发票存放在蓝色抽屉。", ["新聞", "頭髮", "發票", "之前新聞的来源是什么"]],
    ["新聞必須列出日期和來源；頭髮顏色為棕色，發票存放在藍色抽屜。", ["新闻", "头发", "发票", "之前新闻的來源是什么"]],
  ]) {
    const f = await fixture(t); await f.saveUser(fact);
    const input = f.turn("繁简检索");
    const file = require("node:path").join(f.owner.store.workspace(A), "USER.md");
    const before = require("node:fs").readFileSync(file);
    for (const query of queries) {
      const found = await f.search(query, input);
      assert.ok(found.results.slice(0, 5).some(row => row.path === "USER.md" && row.snippet.includes(fact.slice(0, 2))), query);
    }
    for (const query of ["飛機引擎", "游泳池", "新屋装修"]) {
      assert.equal((await f.search(query, input)).results.some(row => row.path === "USER.md"), false, query);
    }
    assert.deepEqual(require("node:fs").readFileSync(file), before, "query folding never rewrites memory");
    await f.finish(input);
  }
});

test("empty and overlong queries return without error", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.saveUser("查新闻时要注意时效性。");
  const input = f.turn("中文检索");
  assert.deepEqual((await f.search("  ", input)).results, []);
  const started = performance.now();
  await f.search("新闻时效性".repeat(800), input);
  assert.ok(performance.now() - started < 5000, "an overlong query stays bounded");
  assert.ok((await f.search("時效性", input)).results.some(row => row.path === "USER.md"));
  await f.finish(input);
});
