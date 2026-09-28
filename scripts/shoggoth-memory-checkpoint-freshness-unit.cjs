"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { conversationContextBudget } = require("../app/agent-service/conversation-context-budget");
const { planConversationCompaction } = require("../app/agent-service/conversation-compaction");
const { ConversationCheckpointStore, SUMMARY_FIELDS, coveredTranscript } = require("../app/agent-service/conversation-checkpoint-store");

function summary(state) {
  return { ...Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, []])), state: [state] };
}

function compile(f) {
  const budget = conversationContextBudget(64000);
  return f.compiler.compile({ profile: f.profile, run: f.run,
    transcriptSessionId: f.transcriptSessionId, contextLifecycleV1: true,
    transcriptTokenBudget: budget.triggerTokens, requestBudget: budget,
    currentOperationId: "current", currentPrompt: "继续", freshSession: true });
}

function checkpoint(f, store, text) {
  const events = f.transcripts.listEvents(f.profile.id, f.transcriptSessionId);
  const memory = store.memoryState(f.profile.id);
  return store.commit({ profileId: f.profile.id, sessionId: f.transcriptSessionId,
    expectedRevision: f.transcripts.getRevision(f.profile.id, f.transcriptSessionId),
    expectedMemoryRevision: memory.revision, expectedMemoryFreshUntil: memory.freshUntil,
    throughSeq: 1, coveredHash: coveredTranscript(events, 1).hash,
    summary: summary(text), provenance: { runId: "summary", bindingId: "binding",
      runtime: "pi", model: "model", method: "model" } });
}

test("a correction invalidates an older checkpoint even though the transcript prefix is unchanged", () => {
  let now = 500;
  const f = contextFixture({ now: () => now });
  const store = new ConversationCheckpointStore({ paths: f.paths, transcriptStore: f.transcripts,
    memoryStore: f.memoryStore, now: () => now });
  store.open(); f.compiler.checkpointStore = store;
  try {
    const old = f.memoryEngine.propose({ profileId: f.profile.id, scope: "user", type: "semantic",
      content: "用户喜欢蓝色", sourceRefs: ["user-1"], classification: "explicit" });
    f.append({ id: "user-1", kind: "user", content: { text: "请继续" } });
    const firstMemory = store.memoryState(f.profile.id);
    const first = checkpoint(f, store, "用户喜欢蓝色");
    assert.equal(first.version, 2, "摘要主文件保持旧版可读取的格式");
    f.append({ id: "current", kind: "user", content: { text: "继续", operationId: "current" } });
    assert.equal(store.compatible(f.profile.id, f.transcriptSessionId)?.id, first.id);
    assert.match(compile(f).dynamicContext, /用户喜欢蓝色/u);

    now = 600;
    f.memoryEngine.propose({ profileId: f.profile.id, scope: "user", type: "semantic",
      content: "用户喜欢红色", sourceRefs: ["user-2"], classification: "explicit",
      supersedes: old.id });
    assert.equal(store.compatible(f.profile.id, f.transcriptSessionId), null);
    const next = compile(f);
    assert.equal(next.blocks.some((block) => block.id === "conversation-checkpoint"), false);
    assert.doesNotMatch(next.dynamicContext, /用户喜欢蓝色/u);
    assert.match(next.dynamicContext, /用户喜欢红色/u);
    assert.throws(() => store.commit({ profileId: f.profile.id, sessionId: f.transcriptSessionId,
      expectedRevision: f.transcripts.getRevision(f.profile.id, f.transcriptSessionId),
      expectedMemoryRevision: firstMemory.revision,
      expectedMemoryFreshUntil: firstMemory.freshUntil,
      throughSeq: 1, coveredHash: first.coveredHash,
      summary: summary("用户喜欢蓝色"), provenance: first.provenance }),
    { code: "CHECKPOINT_STALE" });
    const current = checkpoint(f, store, "用户喜欢红色");
    assert.equal(store.compatible(f.profile.id, f.transcriptSessionId)?.id, current.id);
  } finally { store.close(); f.cleanup(); }
});

test("a temporary memory expiry invalidates a checkpoint without a journal revision change", () => {
  let now = 500;
  const f = contextFixture({ now: () => now });
  const store = new ConversationCheckpointStore({ paths: f.paths, transcriptStore: f.transcripts,
    memoryStore: f.memoryStore, now: () => now });
  store.open(); f.compiler.checkpointStore = store;
  try {
    f.memoryEngine.propose({ profileId: f.profile.id, scope: "user", type: "temporary",
      content: "本周使用蓝色代号", sourceRefs: ["user-1"], classification: "explicit", validUntil: 510 });
    f.append({ id: "user-1", kind: "user", content: { text: "请继续" } });
    checkpoint(f, store, "本周使用蓝色代号");
    f.append({ id: "current", kind: "user", content: { text: "继续", operationId: "current" } });
    assert.ok(store.compatible(f.profile.id, f.transcriptSessionId));
    now = 510;
    assert.equal(store.compatible(f.profile.id, f.transcriptSessionId), null);
    assert.doesNotMatch(compile(f).dynamicContext, /本周使用蓝色代号/u);
    const refreshed = checkpoint(f, store, "到期后重新生成的摘要");
    assert.equal(store.compatible(f.profile.id, f.transcriptSessionId)?.id, refreshed.id);
  } finally { store.close(); f.cleanup(); }
});

test("cross-session correction cannot recompact an old source or its assistant echo", () => {
  let now = 500;
  const f = contextFixture({ now: () => now });
  const store = new ConversationCheckpointStore({ paths: f.paths, transcriptStore: f.transcripts,
    memoryStore: f.memoryStore, recallPolicy: f.memoryEngine.recallPolicy, now: () => now });
  store.open();
  try {
    const oldEvent = f.append({ id: "old-color-user", runId: "old-color-run", kind: "user",
      content: { text: "我最喜欢蓝色。" } });
    f.append({ id: "old-color-assistant", runId: "old-color-run", kind: "assistant",
      content: { text: "我记住你最喜欢蓝色。" } });
    const old = f.memoryEngine.propose({ profileId: f.profile.id, scope: "user", type: "semantic",
      content: "用户最喜欢蓝色", sourceRefs: [oldEvent.id, oldEvent.runId],
      classification: "explicit" });
    const events = f.transcripts.listEvents(f.profile.id, f.transcriptSessionId);
    const memory = store.memoryState(f.profile.id);
    const original = store.commit({ profileId: f.profile.id, sessionId: f.transcriptSessionId,
      expectedRevision: f.transcripts.getRevision(f.profile.id, f.transcriptSessionId),
      expectedMemoryRevision: memory.revision, expectedMemoryFreshUntil: memory.freshUntil,
      throughSeq: 2, coveredHash: coveredTranscript(events, 2).hash,
      summary: summary("用户最喜欢蓝色"), provenance: { runId: "summary-old", bindingId: "binding",
        runtime: "pi", model: "model", method: "model" } });
    assert.equal(store.compatible(f.profile.id, f.transcriptSessionId)?.id, original.id);

    now = 600;
    const correctionSession = "44444444-4444-4444-8444-444444444444";
    const correction = f.transcripts.appendEvent({ profileId: f.profile.id,
      sessionId: correctionSession, runId: "new-color-run", runtimeRef: null,
      contextExcluded: false, occurredAt: now, id: "new-color-user", kind: "user",
      content: { text: "现在我最喜欢红色。" } });
    f.memoryEngine.propose({ profileId: f.profile.id, scope: "user", type: "semantic",
      content: "用户最喜欢红色", sourceRefs: [correction.id, correction.runId],
      classification: "explicit", supersedes: old.id });
    assert.equal(store.compatible(f.profile.id, f.transcriptSessionId), null,
      "旧摘要包含过时来源时即使原话前缀未变也不能继续使用");
    assert.equal(planConversationCompaction({ profileId: f.profile.id,
      sessionId: f.transcriptSessionId, transcriptStore: f.transcripts,
      checkpointStore: store, force: true, targetThroughSeq: 2 }), null,
    "旧会话不得为过时来源生成新的模型摘要提示");
    assert.throws(() => store.commit({ profileId: f.profile.id,
      sessionId: f.transcriptSessionId,
      expectedRevision: f.transcripts.getRevision(f.profile.id, f.transcriptSessionId),
      expectedMemoryRevision: store.memoryState(f.profile.id).revision,
      expectedMemoryFreshUntil: store.memoryState(f.profile.id).freshUntil,
      throughSeq: 2, coveredHash: coveredTranscript(events, 2).hash,
      summary: summary("用户最喜欢蓝色"), provenance: original.provenance }),
    { code: "CHECKPOINT_STALE" }, "直接提交摘要也须拒绝过时来源");
    assert.ok(planConversationCompaction({ profileId: f.profile.id,
      sessionId: correctionSession, transcriptStore: f.transcripts,
      checkpointStore: store, force: true, targetThroughSeq: 1 }),
    "仅受影响的会话停止摘要");
  } finally { store.close(); f.cleanup(); }
});

test("expiry boundary stops compaction of a still-active temporary memory source", () => {
  let now = 500;
  const f = contextFixture({ now: () => now });
  const store = new ConversationCheckpointStore({ paths: f.paths, transcriptStore: f.transcripts,
    memoryStore: f.memoryStore, recallPolicy: f.memoryEngine.recallPolicy, now: () => now });
  store.open();
  try {
    const source = f.append({ id: "delivery-user", runId: "delivery-run", kind: "user",
      content: { text: "本周二交付。" } });
    const item = f.memoryEngine.propose({ profileId: f.profile.id, scope: "user", type: "temporary",
      content: "本周二交付", sourceRefs: [source.id, source.runId],
      classification: "explicit", validUntil: 510 });
    const plan = () => planConversationCompaction({ profileId: f.profile.id,
      sessionId: f.transcriptSessionId, transcriptStore: f.transcripts,
      checkpointStore: store, force: true, targetThroughSeq: 1 });
    assert.ok(plan());
    now = 510;
    assert.equal(f.memoryStore.get(f.profile.id, item.id).status, "active");
    assert.equal(store.historicalMemory.view(f.profile.id).forEvent(source).refs[0].status, "expired");
    assert.equal(plan(), null, "validUntil 到达时即使 journal 未变也不得摘要旧事实");
  } finally { store.close(); f.cleanup(); }
});

test("legacy in-place edits retain a cautious warning without claiming the edited text was spoken", () => {
  const f = contextFixture();
  const store = new ConversationCheckpointStore({ paths: f.paths, transcriptStore: f.transcripts,
    memoryStore: f.memoryStore, recallPolicy: f.memoryEngine.recallPolicy });
  store.open();
  try {
    const source = f.append({ id: "legacy-source", runId: "legacy-run", kind: "user",
      content: { text: "我喜欢蓝色。" } });
    const old = f.memoryEngine.propose({ profileId: f.profile.id, scope: "user", type: "semantic",
      content: "用户喜欢蓝色", sourceRefs: [source.id, source.runId],
      classification: "explicit" });
    f.memoryEngine.update({ profileId: f.profile.id, id: old.id,
      content: "用户喜欢黄色", sourceRef: "user-edit:agent-settings" });
    f.memoryEngine.propose({ profileId: f.profile.id, scope: "user", type: "semantic",
      content: "用户喜欢红色", sourceRefs: ["later-user", "later-run"],
      classification: "explicit", supersedes: old.id });
    f.memoryStore.forgetProfile(f.profile.id);
    const notice = store.historicalMemory.view(f.profile.id).forEvent(source);
    assert.deepEqual(notice.refs[0], { id: old.id, status: "superseded",
      sourceBinding: "legacy_unverified" });
    assert.match(notice.note, /Do not infer the user said the edited content/u);
    assert.equal(planConversationCompaction({ profileId: f.profile.id,
      sessionId: f.transcriptSessionId, transcriptStore: f.transcripts,
      checkpointStore: store, force: true, targetThroughSeq: 1 }), null);
  } finally { store.close(); f.cleanup(); }
});

test("legacy checkpoints remain readable but require a separate memory anchor before projection", () => {
  const f = contextFixture();
  const legacy = new ConversationCheckpointStore({ paths: f.paths, transcriptStore: f.transcripts,
    now: () => 500 });
  legacy.open();
  let guarded;
  try {
    f.append({ id: "user-1", kind: "user", content: { text: "请继续" } });
    const older = checkpoint(f, legacy, "旧摘要中的事实");
    legacy.close();
    guarded = new ConversationCheckpointStore({ paths: f.paths, transcriptStore: f.transcripts,
      memoryStore: f.memoryStore, now: () => 500 });
    guarded.open(); f.compiler.checkpointStore = guarded;
    assert.equal(guarded.get(f.profile.id, f.transcriptSessionId)?.id, older.id);
    assert.equal(guarded.compatible(f.profile.id, f.transcriptSessionId), null);
    f.append({ id: "current", kind: "user", content: { text: "继续", operationId: "current" } });
    assert.doesNotMatch(compile(f).dynamicContext, /旧摘要中的事实/u);
    const current = checkpoint(f, guarded, "已重新生成的摘要");
    assert.equal(guarded.compatible(f.profile.id, f.transcriptSessionId)?.id, current.id);
    const anchor = path.join(f.paths.agentsDir, f.profile.id, "conversation-checkpoints",
      `${current.id}.memory-anchor.json`);
    fs.writeFileSync(anchor, fs.readFileSync(anchor, "utf8").replace('"memoryRevision":0', '"memoryRevision":1'));
    assert.equal(guarded.compatible(f.profile.id, f.transcriptSessionId), null);
  } finally { guarded?.close(); legacy.close(); f.cleanup(); }
});

test("a durable forget intent blocks compaction before the primary memory revision changes", () => {
  const f = contextFixture();
  const store = new ConversationCheckpointStore({ paths: f.paths, transcriptStore: f.transcripts,
    memoryStore: f.memoryStore, recallPolicy: f.memoryEngine.recallPolicy });
  store.open();
  try {
    f.append({ id: "private-1", kind: "user", content: { text: "请记住我的私人代号是蓝鲸" } });
    const item = f.memoryEngine.propose({ profileId: f.profile.id, scope: "user", type: "semantic",
      content: "私人代号是蓝鲸", sourceRefs: ["private-1", "run-1"], classification: "explicit" });
    const before = planConversationCompaction({ profileId: f.profile.id, sessionId: f.transcriptSessionId,
      transcriptStore: f.transcripts, checkpointStore: store, force: true, targetThroughSeq: 1 });
    assert.match(before.prompt, /蓝鲸/u);
    const old = checkpoint(f, store, "私人代号是蓝鲸");
    const revision = f.memoryStore.getRevision(f.profile.id);
    f.memoryEngine.recallPolicy.recordReason({ profileId: f.profile.id, item,
      reason: "forgotten", operationId: "forget-before-primary-delete" });
    assert.equal(f.memoryStore.getRevision(f.profile.id), revision);
    assert.equal(store.compatible(f.profile.id, f.transcriptSessionId), null);
    assert.equal(planConversationCompaction({ profileId: f.profile.id, sessionId: f.transcriptSessionId,
      transcriptStore: f.transcripts, checkpointStore: store, force: true, targetThroughSeq: 1 }), null);
    assert.throws(() => store.commit({ profileId: f.profile.id, sessionId: f.transcriptSessionId,
      expectedRevision: f.transcripts.getRevision(f.profile.id, f.transcriptSessionId),
      expectedMemoryRevision: revision, expectedMemoryFreshUntil: null,
      throughSeq: 1, coveredHash: old.coveredHash,
      summary: summary("私人代号是蓝鲸"), provenance: old.provenance }),
    { code: "CHECKPOINT_STALE" });
    const invalidation = store.invalidation(f.profile.id, f.transcriptSessionId, "native-1", "binding");
    assert.equal(invalidation.nativeSessionId, "native-1");
  } finally { store.close(); f.cleanup(); }
});

test("each memory correction invalidates the currently active native session", () => {
  const f = contextFixture();
  const store = new ConversationCheckpointStore({ paths: f.paths, transcriptStore: f.transcripts,
    memoryStore: f.memoryStore, recallPolicy: f.memoryEngine.recallPolicy });
  store.open();
  try {
    f.append({ id: "user-1", kind: "user", content: { text: "继续" } });
    const blue = f.memoryEngine.propose({ profileId: f.profile.id, scope: "user", type: "semantic",
      content: "用户喜欢蓝色", sourceRefs: ["user-1"], classification: "explicit" });
    checkpoint(f, store, "用户喜欢蓝色");
    const red = f.memoryEngine.propose({ profileId: f.profile.id, scope: "user", type: "semantic",
      content: "用户喜欢红色", sourceRefs: ["user-2"], classification: "explicit", supersedes: blue.id });
    const first = store.invalidation(f.profile.id, f.transcriptSessionId, "native-1", "binding");
    assert.equal(first.nativeSessionId, "native-1");
    f.memoryEngine.propose({ profileId: f.profile.id, scope: "user", type: "semantic",
      content: "用户喜欢绿色", sourceRefs: ["user-3"], classification: "explicit", supersedes: red.id });
    const second = store.invalidation(f.profile.id, f.transcriptSessionId, "native-2", "binding");
    assert.equal(second.nativeSessionId, "native-2");
    assert.notEqual(second.memoryRevision, first.memoryRevision);
    assert.deepEqual(store.invalidation(f.profile.id, f.transcriptSessionId, "native-3", "binding"), second);
  } finally { store.close(); f.cleanup(); }
});

test("native history without any product checkpoint is renewed after each correction or forget", () => {
  const f = contextFixture();
  const store = new ConversationCheckpointStore({ paths: f.paths, transcriptStore: f.transcripts,
    memoryStore: f.memoryStore, recallPolicy: f.memoryEngine.recallPolicy });
  store.open();
  try {
    const profileId = f.profile.id, sessionId = f.transcriptSessionId;
    assert.equal(store.get(profileId, sessionId), null);
    assert.equal(store.nativeSessionStale(profileId, sessionId, "native-1", "binding"), true,
      "a pre-upgrade thread has no safe memory version anchor");
    const initial = store.nativeMemoryVersion(profileId);
    assert.equal(store.recordNativeSession(profileId, sessionId, "native-1", "binding", initial), true);
    assert.equal(store.nativeSessionStale(profileId, sessionId, "native-1", "binding"), false);
    const blue = f.memoryEngine.propose({ profileId, scope: "user", type: "semantic",
      content: "用户喜欢蓝色", sourceRefs: ["user-1"], classification: "explicit" });
    assert.equal(store.nativeSessionStale(profileId, sessionId, "native-1", "binding"), true);
    assert.equal(store.recordNativeSession(profileId, sessionId, "native-2", "binding", initial), false,
      "a stale execution contract cannot launder an older native thread");
    const updated = store.nativeMemoryVersion(profileId);
    assert.equal(store.recordNativeSession(profileId, sessionId, "native-2", "binding", updated), true);
    assert.equal(store.nativeSessionStale(profileId, sessionId, "native-2", "binding"), false);
    f.memoryEngine.delete({ profileId, id: blue.id, reason: "forgotten", operationId: "no-checkpoint-forget" });
    assert.equal(store.hasRevocations(profileId), true);
    assert.equal(store.invalidation(profileId, sessionId, "native-2", "binding"), null,
      "the checkpoint invalidation path has no checkpoint to examine");
    assert.equal(store.nativeSessionStale(profileId, sessionId, "native-2", "binding"), true);
    const revoked = store.nativeMemoryVersion(profileId);
    assert.equal(store.recordNativeSession(profileId, sessionId, "native-3", "binding", revoked), true);
    assert.equal(store.nativeSessionStale(profileId, sessionId, "native-3", "binding"), false,
      "the fresh native thread does not rotate on every turn");
    const file = path.join(f.paths.agentsDir, profileId, "conversation-checkpoints",
      `${require("node:crypto").createHash("sha256").update(sessionId).digest("hex")}.native-memory-anchor.json`);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"native-3"', '"native-4"'));
    assert.throws(() => store.nativeSessionStale(profileId, sessionId, "native-3", "binding"),
      { code: "CHECKPOINT_STORE_CORRUPT" });
  } finally { store.close(); f.cleanup(); }
});

test("withdrawn text cannot return through nested tool payloads or attachment names", () => {
  const f = contextFixture();
  try {
    const item = f.memoryEngine.propose({ profileId: f.profile.id, scope: "agent",
      type: "semantic", content: "我的代号是蓝鲸", sourceRefs: ["user-edit:manual"],
      classification: "explicit" });
    f.append({ id: "nested-tool", runId: "older-tool-run", kind: "tool_result",
      content: { transcriptType: "tool_result", result: { detail: "我的代号是蓝鲸" } } });
    f.append({ id: "attachment-label", runId: "older-attachment-run", kind: "assistant",
      content: { text: "已检查附件", attachments: [{ name: "蓝鲸-资料.txt" }] } });
    f.append({ id: "current", kind: "user", content: { text: "继续", operationId: "current" } });
    assert.match(compile(f).dynamicContext, /蓝鲸/u,
      "the fixture must exercise the prior projection of nested tool data");
    f.memoryEngine.delete({ profileId: f.profile.id, id: item.id,
      reason: "user_deleted", operationId: "forget-projected-metadata" });
    for (const contextLifecycleV1 of [false, true]) {
      const value = contextLifecycleV1 ? compile(f) : f.compiler.compile({
        profile: f.profile, run: f.run, transcriptSessionId: f.transcriptSessionId,
        query: "继续", contextLifecycleV1: false, currentOperationId: "current",
        currentPrompt: "继续", freshSession: true,
      });
      assert.doesNotMatch(value.dynamicContext, /蓝鲸/u, `lifecycle=${contextLifecycleV1}`);
    }
  } finally { f.cleanup(); }
});

test("legacy fresh native context restores all visible history after a withdrawal or refuses to send", () => {
  const f = contextFixture();
  try {
    const item = f.memoryEngine.propose({ profileId: f.profile.id, scope: "agent",
      type: "semantic", content: "不再使用临时代号蓝鲸", sourceRefs: ["user-edit:manual"],
      classification: "explicit" });
    f.memoryEngine.delete({ profileId: f.profile.id, id: item.id,
      reason: "forgotten", operationId: "legacy-history-forget" });
    for (let index = 0; index < 30; index++) {
      f.append({ id: `history-${index}`, kind: index % 2 ? "assistant" : "user",
        content: { text: `可见历史第 ${index} 条：请继续按当前计划工作。` } });
    }
    f.append({ id: "current", kind: "user", content: { text: "继续", operationId: "current" } });
    const budget = conversationContextBudget(64000);
    const input = (operationId) => ({ profile: f.profile, run: f.run,
      transcriptSessionId: f.transcriptSessionId, contextLifecycleV1: false,
      requestBudget: budget, currentOperationId: operationId,
      currentPrompt: "继续", freshSession: true });
    const complete = f.compiler.compile(input("current"));
    assert.match(complete.dynamicContext, /可见历史第 0 条/u,
      "撤回后的新 native 线程不能静默丢掉第 25 条之前的可见原话");
    assert.match(complete.dynamicContext, /可见历史第 29 条/u);
    assert.equal(complete.report.request.historyTruncated, false);

    for (let index = 0; index < 25; index++) {
      f.append({ id: `long-history-${index}`, kind: "assistant",
        content: { text: `较长的可见历史 ${index}：${"详细资料".repeat(160)}` } });
    }
    f.append({ id: "current-2", kind: "user", content: { text: "继续", operationId: "current-2" } });
    assert.throws(() => f.compiler.compile(input("current-2")),
      { code: "CONTEXT_COMPACTION_REQUIRED" },
      "超过预算且不能安全摘要时必须拒绝向新 native 线程发送截断历史");
  } finally { f.cleanup(); }
});
