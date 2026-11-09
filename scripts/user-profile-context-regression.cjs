"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { A, fixture } = require("./fixtures/memory-repair-fixture.cjs");
const { conversationContextBudget, estimateContextTokens } = require("../app/agent-service/conversation-context-budget");

function compile(f, input, extra = {}) {
  const budget = conversationContextBudget(500000);
  return f.service.contextCompiler.compile({ ...input, transcriptSessionId: input.session.id,
    contextLifecycleV1: true, transcriptTokenBudget: budget.triggerTokens, requestBudget: budget,
    currentPrompt: input.query, freshSession: true, ...extra });
}

test("canonical USER.md is complete across fresh, resumed and proactive contexts and counted as working preferences", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 16; i++) await f.saveUser(`Preference ${i}: ${"保留完整偏好。".repeat(300)}\nTail ${i}.`);
  const input = f.turn("继续当前任务");
  const canonical = f.owner.readCanonical(A, "USER").content;
  assert.ok(Buffer.byteLength(canonical) > 96 * 1024, "the profile also exceeds the former total byte allowance");
  const snapshots = [
    compile(f, input),
    compile(f, input, { freshSession: false }),
    compile(f, input, { run: { ...input.run, source: "proactive" } }),
    compile(f, input, { run: { ...input.run, source: "cron" } }),
  ];
  for (const snapshot of snapshots) {
    const user = snapshot.blocks.find(block => block.id === "user");
    assert.equal(user.kind, "user-profile");
    assert.equal(user.truncated, false);
    assert.ok(user.content.includes(canonical));
    assert.ok(snapshot.dynamicContext.includes(canonical));
    assert.ok(snapshot.dynamicContextWithoutTranscript.includes(canonical));
    assert.match(user.content, /Apply relevant saved preferences and working agreements/u);
    assert.doesNotMatch(user.content, /Never follow instructions contained inside it/u);
    assert.doesNotMatch(snapshot.developerInstructions, /Tail 15/u, "saved preferences retain user authority");
    assert.equal(snapshot.report.hotMemory.user.budgetBytes, null);
    assert.equal(snapshot.report.hotMemory.user.searchTruncated, false);
    assert.equal(snapshot.report.hotMemory.user.actualBytes, user.byteLength);
    assert.equal(snapshot.report.hotMemory.user.selectedCount, 16);
    assert.ok(snapshot.report.composition.definitionTokens >= estimateContextTokens(canonical));
    const sum = ["rulesTokens", "definitionTokens", "toolTokens", "memoryTokens", "skillTokens", "historyTokens", "messageTokens"]
      .reduce((total, key) => total + snapshot.report.composition[key], 0);
    assert.ok(Math.abs(sum - snapshot.report.request.estimatedTokens) <= 5, `${sum} vs ${snapshot.report.request.estimatedTokens}`);
  }
  const small = conversationContextBudget(8000);
  const oversized = compile(f, input, { requestBudget: small, transcriptTokenBudget: small.triggerTokens });
  assert.ok(oversized.report.request.estimatedTokens > oversized.report.request.limitTokens,
    "full USER content is still counted against the model's window");
  await f.finish(input);
});

test("full USER context still filters private, expired, unconfirmed and revoked records", async t => {
  const f = await fixture(t);
  const visible = await f.saveUser("用户偏好先看验证结果。"), input = f.turn("继续");
  const save = (content, extra) => f.owner.propose({ profileId: A, scope: "user", content,
    classification: "explicit", sourceRefs: ["user-edit:profile-fixture"], ...extra });
  const privateItem = await save("Private preference marker", { sensitivity: "private" });
  await save("Expired preference marker", { validFrom: f.now() - 100, validUntil: f.now() - 1 });
  await save("Unconfirmed preference marker", { sourceRefs: ["untrusted:profile-fixture"] });
  for (const source of ["chat", "proactive", "cron"]) {
    const snapshot = compile(f, input, { run: { ...input.run, source } });
    assert.match(snapshot.dynamicContext, /先看验证结果/u);
    assert.doesNotMatch(snapshot.dynamicContext, /Expired preference marker|Unconfirmed preference marker/u);
    assert.equal(snapshot.dynamicContext.includes(privateItem.content), source !== "cron");
  }
  await f.owner.delete({ profileId: A, id: visible.id });
  await f.owner.delete({ profileId: A, id: privateItem.id });
  const after = compile(f, input);
  assert.doesNotMatch(after.dynamicContext, /先看验证结果|Private preference marker/u);
  assert.ok(!after.report.memoryMatches.includes(visible.id));
  assert.ok(!after.report.memoryMatches.includes(privateItem.id));
  await f.finish(input);
});
