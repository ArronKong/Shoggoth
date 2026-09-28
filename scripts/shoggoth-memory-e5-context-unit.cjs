"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");

test("prepared semantic hot memory is consumed synchronously, bounded and frozen", async () => {
  let clock = 500;
  const f = contextFixture({ now: () => clock++ });
  try {
    const target = f.memoryEngine.propose({ profileId: f.profile.id, scope: "user", type: "semantic",
      content: "我的观鸟望远镜采用八倍放大和四十二毫米口径。", sourceRefs: ["binocular-source"], classification: "explicit" });
    for (let i=0; i<60; i++) f.memoryEngine.propose({ profileId: f.profile.id, scope: "user", type: "semantic",
      content: "仓库里的第" + i + "号空箱由当天检查员登记，包装及标签按入库流程逐一核对。".repeat(4),
      sourceRefs: ["box-" + i], classification: "explicit" });
    const input = { profile: f.profile, run: f.run, transcriptSessionId: f.transcriptSessionId,
      query: "What are the binocular specifications?" };
    const baseline = f.compiler.compile(input);
    assert.ok(!baseline.report.memoryMatches.includes(target.id));
    let prepares = 0;
    f.compiler.semanticSearch = { async memoryCandidates(args, budgetMs) {
      prepares++; assert.equal(budgetMs, 150); assert.equal(args.maxSensitivity, "private");
      return { status: "ready", stamp: f.memoryEngine.semanticStamp(f.profile.id),
        candidates: [{ id: target.id, score: .94, rankScore: .1 }] };
    } };
    await f.compiler.prepareRelated(input);
    const prepared = f.compiler.compile(input);
    assert.equal(typeof prepared.then, "undefined");
    assert.ok(prepared.report.memoryMatches.includes(target.id));
    assert.match(prepared.dynamicContext, /八倍/u);
    assert.ok(prepared.blocks.find(row => row.id === "user").byteLength <= 8*1024);
    assert.equal(f.compiler.preparedRelated.size, 0);
    assert.ok(!f.compiler.compile(input).report.memoryMatches.includes(target.id), "candidate preparation is consumed once");
    await f.compiler.prepareRelated(input);
    f.memoryEngine.propose({ profileId: f.profile.id, scope: "user", type: "semantic",
      content: "一份新登记的空箱检查记录。", sourceRefs: ["new-box"], classification: "explicit" });
    assert.ok(!f.compiler.compile(input).report.memoryMatches.includes(target.id), "a changed authoritative stamp rejects prepared candidates");
    assert.equal(f.snapshots.get(f.profile.id, prepared.id).contentHash, prepared.contentHash);
    for (const run of [{ ...f.run, source: "cron" }, { ...f.run,
      idempotencyKey: "shoggoth:chat-send:federation-send-test" }]) await f.compiler.prepareRelated({ ...input, run });
    assert.equal(prepares, 2, "background and federated callers cannot prepare private semantic context");
  } finally { f.cleanup(); }
});
