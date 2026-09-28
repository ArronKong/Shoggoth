#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { conversationContextBudget } = require("../app/agent-service/conversation-context-budget");

let clock = 500;
const fixture = contextFixture({ now: () => clock });
try {
  const historicalUser = fixture.append({ id: "historical-user", runId: "run-old",
    kind: "user", content: { text: "旧颜色是蓝色，旧交付日在周二，收货地址是上海。" } });
  fixture.append({ id: "historical-assistant", runId: "run-old", kind: "assistant",
    content: { text: "蓝色和上海我都听到了。" } });
  const correction = fixture.append({ id: "correction-user", runId: "run-correction",
    kind: "user", content: { text: "颜色改成绿色，交付日改到周四；上海地址不变。" } });
  fixture.append({ id: "current-user", runId: "run-next", kind: "user",
    content: { text: "现在的颜色和地址是什么？" } });

  const add = (content, sourceRefs, extra = {}) => fixture.memoryEngine.propose({
    profileId: fixture.profile.id, scope: "user", type: "semantic",
    content, sourceRefs, classification: "explicit", ...extra,
  });
  const oldColor = add("用户颜色是蓝色", [historicalUser.id, "run-old"]);
  const oldDelivery = add("用户交付日在周二", [historicalUser.id, "run-old"], { validUntil: 550 });
  const currentAddress = add("用户收货地址是上海", [historicalUser.id, "run-old"]);
  add("用户颜色是绿色", [correction.id, "run-correction"], { supersedes: oldColor.id });
  assert.equal(fixture.memoryStore.get(fixture.profile.id, oldColor.id).status, "superseded");
  assert.equal(fixture.memoryStore.get(fixture.profile.id, oldDelivery.id).status, "active");
  clock = 600;

  const input = { profile: fixture.profile, run: { ...fixture.run, id: "run-next" },
    transcriptSessionId: fixture.transcriptSessionId, query: "现在的颜色和地址是什么？" };
  for (const contextLifecycleV1 of [false, true]) {
    const snapshot = fixture.compiler.compile({ ...input, contextLifecycleV1 });
    assert.match(snapshot.dynamicContext, /旧颜色是蓝色，旧交付日在周二，收货地址是上海/u);
    assert.match(snapshot.dynamicContext, /蓝色和上海我都听到了/u);
    assert.match(snapshot.dynamicContext, /用户颜色是绿色/u);
    assert.doesNotMatch(snapshot.dynamicContext, /现在的颜色和地址是什么/u);
    assert.match(snapshot.dynamicContext,
      new RegExp(`historical-user[^\\n]*${oldColor.id}[^\\n]*superseded`, "u"),
      "原 user 事件应精确标出旧颜色版本，而不判整条消息过时");
    assert.match(snapshot.dynamicContext,
      new RegExp(`historical-user[^\\n]*${oldDelivery.id}[^\\n]*expired`, "u"),
      "已过期交付日应标在同一来源事件");
    assert.match(snapshot.dynamicContext, /historical-assistant[^\n]*possible_echo/u,
      "同 Run 助手复述应提示可能含过时事实");
    assert.match(snapshot.dynamicContext, /other statements may still be current/u,
      "历史提示不能把上海地址也判为过时");
    const sourceStatus = snapshot.dynamicContext.split("\n")
      .find((line) => line.includes("HISTORICAL MEMORY STATUS eventId=historical-user"));
    assert.ok(sourceStatus);
    assert.doesNotMatch(sourceStatus, new RegExp(currentAddress.id, "u"),
      "同条消息中仍 active 的上海地址不能列入过时版本");
  }
  console.log("PASS historical memory status remains attached to exact source and possible assistant echo in both context paths");
} finally {
  fixture.cleanup();
}

const clipped = contextFixture({ budgets: { transcript: 800 } });
try {
  const old = clipped.append({ id: "long-old-user", runId: "run-long-old", kind: "user",
    content: { text: `${"历史背景。".repeat(360)}旧颜色是蓝色。` } });
  const correction = clipped.append({ id: "short-correction", runId: "run-short-correction",
    kind: "user", content: { text: "颜色改成绿色。" } });
  clipped.append({ id: "next-user", runId: "run-next", kind: "user",
    content: { text: "现在是什么颜色？" } });
  const oldMemory = clipped.memoryEngine.propose({ profileId: clipped.profile.id,
    scope: "user", type: "semantic", classification: "explicit",
    content: "用户颜色是蓝色", sourceRefs: [old.id, "run-long-old"] });
  clipped.memoryEngine.propose({ profileId: clipped.profile.id,
    scope: "user", type: "semantic", classification: "explicit",
    content: "用户颜色是绿色", sourceRefs: [correction.id, "run-short-correction"],
    supersedes: oldMemory.id });
  const snapshot = clipped.compiler.compile({ profile: clipped.profile,
    run: { ...clipped.run, id: "run-next" }, transcriptSessionId: clipped.transcriptSessionId,
    query: "现在是什么颜色？", contextLifecycleV1: false });
  const transcript = snapshot.blocks.find((item) => item.id === "transcript");
  assert.equal(transcript.truncated, true);
  assert.match(transcript.content, /\[earlier text omitted\]/u);
  assert.match(transcript.content, /旧颜色是蓝色/u);
  assert.match(transcript.content, /HISTORICAL MEMORY STATUS eventId=long-old-user/u,
    "截断后的旧事实不能丢失过时标记");
  console.log("PASS clipped legacy context retains the historical status beside any surviving stale text");
} finally {
  clipped.cleanup();
}

const legacy = contextFixture({ budgets: { transcript: 1600 } });
try {
  for (let index = 0; index < 32; index += 1) {
    legacy.append({ id: `legacy-filler-${index}`, runId: `legacy-run-${index}`,
      kind: index % 2 ? "assistant" : "user",
      content: { text: `可见的旧会话第 ${index} 条：${"背景资料。".repeat(40)}` } });
  }
  const old = legacy.append({ id: "legacy-old-color", runId: "legacy-old-run", kind: "user",
    content: { text: "以前的颜色是蓝色，地址是上海。" } });
  legacy.append({ id: "legacy-old-echo", runId: "legacy-old-run", kind: "assistant",
    content: { text: "我记下蓝色和上海。" } });
  const correction = legacy.append({ id: "legacy-correction", runId: "legacy-correction-run",
    kind: "user", content: { text: "颜色已经改成绿色，上海地址不变。" } });
  legacy.append({ id: "legacy-current", runId: "legacy-current-run", kind: "user",
    content: { text: "现在是什么颜色？", operationId: "legacy-current-operation" } });
  const oldMemory = legacy.memoryEngine.propose({ profileId: legacy.profile.id,
    scope: "user", type: "semantic", classification: "explicit",
    content: "用户颜色是蓝色", sourceRefs: [old.id, "legacy-old-run"] });
  legacy.memoryEngine.propose({ profileId: legacy.profile.id,
    scope: "user", type: "semantic", classification: "explicit",
    content: "用户颜色是绿色", sourceRefs: [correction.id, "legacy-correction-run"],
    supersedes: oldMemory.id });
  const budget = conversationContextBudget(64000);
  const snapshot = legacy.compiler.compile({ profile: legacy.profile,
    run: { ...legacy.run, id: "legacy-current-run" },
    transcriptSessionId: legacy.transcriptSessionId, query: "现在是什么颜色？",
    contextLifecycleV1: false, requestBudget: budget,
    currentOperationId: "legacy-current-operation", currentPrompt: "现在是什么颜色？",
    freshSession: true });
  assert.equal(snapshot.report.request.historyTruncated, false,
    "普通纠正不应把旧版最近 24 条上下文变成全历史截断并触发 Run 拒绝");
  assert.match(snapshot.dynamicContext, /HISTORICAL MEMORY STATUS eventId=legacy-old-color/u);
  assert.match(snapshot.dynamicContext, /HISTORICAL ASSISTANT NOTICE eventId=legacy-old-echo/u);
  assert.doesNotMatch(snapshot.dynamicContext, /legacy-filler-0/u);
  console.log("PASS long legacy session retains last-24 capacity behavior and marks retained stale facts");
} finally {
  legacy.cleanup();
}
