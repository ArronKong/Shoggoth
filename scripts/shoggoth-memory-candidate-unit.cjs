"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { ConversationRecallService } = require("../app/agent-service/conversation-recall-service");
const { ConversationMemoryService } = require("../app/agent-service/conversation-memory-service");
const { MemoryCandidateStore, checksum } = require("../app/agent-service/memory-candidate-store");
const { MemoryCandidateService, EXTRACTOR_VERSION } = require("../app/agent-service/memory-candidate-service");
const { MemoryEngine, contentHash, workspaceMemoryRef } = require("../app/agent-service/memory-engine");
const { MemoryProvenanceStore } = require("../app/agent-service/memory-provenance-store");
const { MemoryProvenanceService } = require("../app/agent-service/memory-provenance-service");
const { candidateSessionForCompletedRun } = require("../app/agent-service/server");
const { openFixture } = require("./shoggoth-work-run-coordinator-unit.cjs");

function candidateFixture({ maxModelCallsPerDay = 20 } = {}) {
  let tick = 10_000;
  const fixture = contextFixture({ now: () => tick++ });
  const session = { id: fixture.transcriptSessionId,
    sessionKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", profileId: "profile-1",
    workspace: fixture.run.workspace, status: "ready" };
  const runs = new Map();
  let counter = 0;
  const append = (text, options = {}) => {
    const id = `event-${++counter}`;
    const runId = `run-candidate-${counter}`;
    runs.set(runId, { id: runId, source: "chat", sourceId: session.sessionKey,
      profileId: "profile-1", workspace: session.workspace, status: "completed" });
    fixture.transcripts.appendEvent({ profileId: "profile-1", sessionId: session.id,
      runId, id, kind: "user", content: { text }, runtimeRef: null,
      contextExcluded: options.contextExcluded === true, occurredAt: tick++ });
    return { id, runId };
  };
  const chatSessionStore = {
    listSessions: () => [structuredClone(session)],
    getSession: (key) => key === session.sessionKey ? structuredClone(session) : null,
    getCronSessionOrigin: () => null,
  };
  const recall = new ConversationRecallService({
    paths: fixture.paths, transcriptStore: fixture.transcripts,
    memoryStore: fixture.memoryStore,
    chatSessionStore, workDispatcher: { getRun: (id) => runs.get(id) || null },
    getRunSessionKey: (run) => run.sourceId,
    recallPolicy: fixture.memoryEngine.recallPolicy,
  });
  const queue = new MemoryCandidateStore({ paths: fixture.paths, now: () => tick++ });
  const calls = [];
  const provenanceRecords = [];
  let answer = { candidates: [] };
  const service = new MemoryCandidateService({ candidateStore: queue,
    memoryEngine: fixture.memoryEngine, memoryStore: fixture.memoryStore,
    conversationRecallService: recall, chatSessionStore,
    provenanceService: { recordConversationSave(input) { provenanceRecords.push(input); } },
    extractCandidates: async (input) => { calls.push(input); return answer; },
    isProfileEligible: () => true, now: () => tick++, maxModelCallsPerDay });
  return { fixture, session, runs, append, queue, service, calls, provenanceRecords,
    setAnswer(value) { answer = value; },
    cleanup() { recall.close(); fixture.cleanup(); } };
}

async function pendingPair(f) {
  const first = f.append("我每周五做项目复盘。");
  const second = f.append("我习惯在周一整理需求。");
  f.setAnswer({ candidates: [
    { eventId: first.id, sourceQuote: "每周五做项目复盘",
      content: "用户每周五做项目复盘", scope: "user" },
    { eventId: second.id, sourceQuote: "在周一整理需求",
      content: "用户习惯在周一整理需求", scope: "project" },
  ] });
  assert.equal((await f.service.processSession({ profileId: "profile-1",
    sessionId: f.session.id })).created, 2);
  return { first, second, page: f.service.list({ profileId: "profile-1" }) };
}

function restartedReview(f) {
  f.fixture.memoryEngine.close();
  const engine = new MemoryEngine({ store: f.fixture.memoryStore,
    definitionStore: f.fixture.definitions, transcriptStore: f.fixture.transcripts,
    chatSessionStore: f.service.sessions, strictSourceResolution: true });
  engine.setReviewReceiptStore(f.queue);
  engine.open(["profile-1"]);
  const recall = new ConversationRecallService({ paths: f.fixture.paths,
    transcriptStore: f.fixture.transcripts, memoryStore: f.fixture.memoryStore,
    chatSessionStore: f.service.sessions,
    workDispatcher: { getRun: (id) => f.runs.get(id) || null },
    getRunSessionKey: (run) => run.sourceId, recallPolicy: engine.recallPolicy });
  const service = new MemoryCandidateService({ candidateStore: f.queue,
    memoryEngine: engine, memoryStore: f.fixture.memoryStore,
    conversationRecallService: recall, chatSessionStore: f.service.sessions,
    isProfileEligible: () => true,
    extractCandidates: () => { throw new Error("must not call model"); } });
  return { engine, recall, service, close() { recall.close(); engine.close(); } };
}

test("candidate extraction is durable, bounded, review-only and idempotent", async () => {
  const f = candidateFixture();
  try {
    const source = f.append("我每周五做项目复盘。", {});
    f.setAnswer({ candidates: [{ eventId: source.id, sourceQuote: "每周五做项目复盘",
      content: "用户每周五做项目复盘", scope: "user" }] });
    const result = await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    assert.equal(result.created, 1);
    assert.equal(result.modelCalls, 1);
    assert.equal(f.calls[0].toolFree, true);
    assert.equal(f.calls[0].profileId, "profile-1");
    assert.equal(f.calls[0].sessionKey, f.session.sessionKey);
    assert.match(f.calls[0].operationId, /^memory-extraction-/u);
    assert.equal(f.calls[0].events.length, 1);
    const pending = f.service.list({ profileId: "profile-1" });
    assert.equal(pending.items.length, 1);
    assert.equal(pending.items[0].status, "pending");
    assert.equal(f.fixture.memoryStore.list("profile-1", { status: "active" }).length, 0);
    assert.doesNotMatch(f.fixture.definitions.get("profile-1").documents.USER, /每周五/u);
    const again = await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    assert.equal(again.modelCalls, 0, "no new source means no model cost");
    assert.equal(f.calls.length, 1);
    const reopened = new MemoryCandidateStore({ paths: f.fixture.paths });
    assert.equal(reopened.get("profile-1").cursors[f.session.id].throughSeq, 1);

    const accepted = f.service.accept({ profileId: "profile-1", candidateId: pending.items[0].id,
      expectedRevision: pending.revision, expectedMemoryRevision: f.fixture.memoryStore.getRevision("profile-1") });
    assert.equal(accepted.candidate.status, "accepted");
    assert.equal(accepted.memoryItem.status, "active");
    assert.ok(accepted.memoryItem.sourceRefs.includes(source.id));
    assert.equal(f.provenanceRecords.length, 1);
    assert.deepEqual(f.provenanceRecords[0].source, {
      sessionId: f.session.id, eventId: source.id, runId: source.runId,
      eventTextHash: pending.items[0].source.contentHash,
      quoteHash: pending.items[0].source.quoteHash,
      quoteStartUtf16: pending.items[0].source.quoteStart,
      quoteEndUtf16: pending.items[0].source.quoteStart + pending.items[0].source.quoteLength,
    });
    assert.match(f.fixture.definitions.get("profile-1").documents.USER, /每周五/u);
    assert.equal(f.service.list({ profileId: "profile-1" }).items.length, 0);
  } finally { f.cleanup(); }
});

test("superseded and expired memory sources cannot re-enter pending review or active memory", async () => {
  const f = candidateFixture();
  try {
    const old = f.append("我的项目代号是蓝鸟。");
    f.setAnswer({ candidates: [{ eventId: old.id, sourceQuote: "项目代号是蓝鸟",
      content: "用户的项目代号是蓝鸟", scope: "project" }] });
    assert.equal((await f.service.processSession({ profileId: "profile-1",
      sessionId: f.session.id })).created, 1);
    const oldPage = f.service.list({ profileId: "profile-1" });
    const oldCandidate = oldPage.items[0];
    const oldMemory = f.fixture.memoryEngine.propose({ profileId: "profile-1",
      content: "用户的项目代号是蓝鸟", scope: "project", type: "semantic",
      classification: "explicit", sourceRefs: [old.id, old.runId,
        workspaceMemoryRef(f.session.workspace)] });
    const correction = f.append("项目代号已经改成绿洲。");
    f.fixture.memoryEngine.propose({ profileId: "profile-1",
      content: "用户的项目代号是绿洲", scope: "project", type: "semantic",
      classification: "explicit", sourceRefs: [correction.id, correction.runId,
        workspaceMemoryRef(f.session.workspace)], supersedes: oldMemory.id });
    assert.equal(f.service.list({ profileId: "profile-1" }).items.length, 0,
      "outdated pending candidates must not remain reviewable");
    assert.throws(() => f.service.accept({ profileId: "profile-1",
      candidateId: oldCandidate.id, expectedRevision: oldPage.revision,
      expectedMemoryRevision: f.fixture.memoryStore.getRevision("profile-1") }),
    (error) => error.code === "MEMORY_CANDIDATE_SOURCE_OUTDATED");

    const unprocessed = f.append("我的工作区标记是松林。");
    const unprocessedMemory = f.fixture.memoryEngine.propose({ profileId: "profile-1",
      content: "用户的工作区标记是松林", scope: "workspace", type: "semantic",
      classification: "explicit", sourceRefs: [unprocessed.id, unprocessed.runId,
        workspaceMemoryRef(f.session.workspace)] });
    const replacement = f.append("工作区标记已经改成海岬。");
    f.fixture.memoryEngine.propose({ profileId: "profile-1",
      content: "用户的工作区标记是海岬", scope: "workspace", type: "semantic",
      classification: "explicit", sourceRefs: [replacement.id, replacement.runId,
        workspaceMemoryRef(f.session.workspace)], supersedes: unprocessedMemory.id });

    const expired = f.append("我的临时项目名是琥珀。");
    f.fixture.memoryEngine.propose({ profileId: "profile-1",
      content: "用户的临时项目名是琥珀", scope: "user", type: "temporary",
      classification: "explicit", sourceRefs: [expired.id, expired.runId],
      validFrom: 0, validUntil: 1 });
    f.setAnswer({ candidates: [
      { eventId: unprocessed.id, sourceQuote: "工作区标记是松林",
        content: "用户的工作区标记是松林", scope: "workspace" },
      { eventId: expired.id, sourceQuote: "临时项目名是琥珀",
        content: "用户的临时项目名是琥珀", scope: "user" },
    ] });
    const result = await f.service.processSession({ profileId: "profile-1",
      sessionId: f.session.id });
    assert.equal(result.created, 0);
    assert.ok(f.calls.at(-1).events.every((event) => event.eventId !== unprocessed.id
      && event.eventId !== expired.id),
    "the model must not receive superseded or expired source events");
  } finally { f.cleanup(); }
});

test("accepted candidate loses Agent visibility when another fact from its source becomes outdated", async () => {
  const f = candidateFixture();
  try {
    const source = f.append("我每周五复盘项目，主题色是蓝色。");
    f.setAnswer({ candidates: [{ eventId: source.id, sourceQuote: "每周五复盘项目",
      content: "用户每周五复盘项目", scope: "user" }] });
    await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    const page = f.service.list({ profileId: "profile-1" });
    const accepted = f.service.accept({ profileId: "profile-1", candidateId: page.items[0].id,
      expectedRevision: page.revision,
      expectedMemoryRevision: f.fixture.memoryStore.getRevision("profile-1") });
    assert.equal(accepted.memoryItem.status, "active");
    assert.equal(f.fixture.memoryEngine.search({ profileId: "profile-1",
      query: "每周五" }).items.length, 1);

    const oldColor = f.fixture.memoryEngine.propose({ profileId: "profile-1",
      content: "用户的主题色是蓝色", scope: "user", type: "semantic",
      classification: "explicit", sourceRefs: [source.id, source.runId] });
    const correction = f.append("主题色改成绿色。");
    f.fixture.memoryEngine.propose({ profileId: "profile-1",
      content: "用户的主题色是绿色", scope: "user", type: "semantic",
      classification: "explicit", sourceRefs: [correction.id, correction.runId],
      supersedes: oldColor.id });
    assert.equal(f.fixture.memoryEngine.isReviewCommitted("profile-1",
      f.fixture.memoryStore.get("profile-1", accepted.memoryItem.id)), false);
    assert.equal(f.fixture.memoryEngine.search({ profileId: "profile-1",
      query: "每周五" }).items.length, 0);
    assert.equal(f.service.list({ profileId: "profile-1", status: "all" }).items.length, 0);
    assert.doesNotMatch(f.fixture.definitions.get("profile-1").documents.USER, /每周五/u);
  } finally { f.cleanup(); }
});

test("a correction during model latency cannot commit a stale candidate", async () => {
  const f = candidateFixture();
  try {
    const source = f.append("我的项目代号是蓝鸟。");
    f.service.extract = async () => {
      const old = f.fixture.memoryEngine.propose({ profileId: "profile-1",
        content: "用户的项目代号是蓝鸟", scope: "project", type: "semantic",
        classification: "explicit", sourceRefs: [source.id, source.runId,
          workspaceMemoryRef(f.session.workspace)] });
      const correction = f.append("项目代号改成绿洲。");
      f.fixture.memoryEngine.propose({ profileId: "profile-1",
        content: "用户的项目代号是绿洲", scope: "project", type: "semantic",
        classification: "explicit", sourceRefs: [correction.id, correction.runId,
          workspaceMemoryRef(f.session.workspace)], supersedes: old.id });
      return { candidates: [{ eventId: source.id, sourceQuote: "项目代号是蓝鸟",
        content: "用户的项目代号是蓝鸟", scope: "project" }] };
    };
    const result = await f.service.processSession({ profileId: "profile-1",
      sessionId: f.session.id });
    assert.equal(result.created, 0);
    assert.equal(f.service.list({ profileId: "profile-1" }).items.length, 0);
    assert.equal(f.fixture.memoryStore.list("profile-1", { status: "active" }).length, 1,
      "only the user's corrected explicit memory remains active");
  } finally { f.cleanup(); }
});

test("运行中原始 journal 丢失后候选审核不能使用缓存来源", async () => {
  const f = candidateFixture();
  try {
    const source = f.append("我每周五做项目复盘。");
    f.setAnswer({ candidates: [{ eventId: source.id, sourceQuote: "每周五做项目复盘",
      content: "用户每周五做项目复盘", scope: "user" }] });
    assert.equal((await f.service.processSession({ profileId: "profile-1",
      sessionId: f.session.id })).created, 1);
    const pending = f.service.list({ profileId: "profile-1" });
    assert.equal(pending.items.length, 1);
    const memoryRevision = f.fixture.memoryStore.getRevision("profile-1");
    const log = path.join(f.fixture.transcripts._sessionDir("profile-1", f.session.id),
      "events.jsonl");
    fs.unlinkSync(log);
    assert.equal(f.service.list({ profileId: "profile-1" }).items.length, 0,
      "来源 journal 丢失后审核列表应隐藏缓存候选");
    assert.throws(() => f.service.accept({ profileId: "profile-1",
      candidateId: pending.items[0].id, expectedRevision: pending.revision,
      expectedMemoryRevision: memoryRevision }),
    (error) => error.code === "TRANSCRIPT_SOURCE_CHANGED" && !String(error.message).includes("每周五"));
    assert.equal(f.fixture.memoryStore.getRevision("profile-1"), memoryRevision,
      "来源丢失的候选不能写入 active 记忆");
  } finally { f.cleanup(); }
});

test("source lost after accepted receipt but before activation leaves reviewed memory staged", async () => {
  const f = candidateFixture();
  try {
    const source = f.append("我每周五做项目复盘。");
    f.setAnswer({ candidates: [{ eventId: source.id, sourceQuote: "每周五做项目复盘",
      content: "用户每周五做项目复盘", scope: "user" }] });
    await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    const page = f.service.list({ profileId: "profile-1" });
    const candidate = page.items[0];
    const journal = path.join(f.fixture.transcripts._sessionDir("profile-1", f.session.id),
      "events.jsonl");
    const originalActivate = f.fixture.memoryEngine.activateReviewedBatch.bind(f.fixture.memoryEngine);
    f.fixture.memoryEngine.activateReviewedBatch = (request) => {
      fs.unlinkSync(journal);
      return originalActivate(request);
    };
    assert.throws(() => f.service.acceptMany({ profileId: "profile-1",
      candidateIds: [candidate.id], expectedRevision: page.revision,
      expectedMemoryRevision: f.fixture.memoryStore.getRevision("profile-1") }),
    (error) => error.code === "MEMORY_CANDIDATE_COMMIT_UNCERTAIN"
      && error.cause?.code === "MEMORY_SOURCE_REVOKED");
    assert.equal(f.queue.get("profile-1").candidates[candidate.id].status, "accepted");
    assert.equal(f.fixture.memoryStore.get("profile-1", `reviewed-${candidate.id}`).status, "candidate");
    assert.equal(f.fixture.memoryEngine.search({ profileId: "profile-1", query: "每周五" }).items.length, 0);
    assert.doesNotMatch(f.fixture.definitions.get("profile-1").documents.USER, /每周五/u);
    assert.equal(f.service.recoverProfile("profile-1").blocked, 1);
    assert.equal(f.fixture.memoryStore.list("profile-1", { status: "active" }).length, 0);
  } finally { f.cleanup(); }
});

test("source lost during active journal commit is hidden on reads and quarantined on recovery", async () => {
  const f = candidateFixture();
  let restarted = null;
  try {
    const source = f.append("我每周五做项目复盘。");
    f.setAnswer({ candidates: [{ eventId: source.id, sourceQuote: "每周五做项目复盘",
      content: "用户每周五做项目复盘", scope: "user" }] });
    await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    const page = f.service.list({ profileId: "profile-1" });
    const candidate = page.items[0];
    const journal = path.join(f.fixture.transcripts._sessionDir("profile-1", f.session.id),
      "events.jsonl");
    const originalUpsert = f.fixture.memoryStore.upsertMany.bind(f.fixture.memoryStore);
    f.fixture.memoryStore.upsertMany = (items, options) => {
      if (items.some((item) => item.status === "active")) fs.unlinkSync(journal);
      return originalUpsert(items, options);
    };
    assert.throws(() => f.service.acceptMany({ profileId: "profile-1",
      candidateIds: [candidate.id], expectedRevision: page.revision,
      expectedMemoryRevision: f.fixture.memoryStore.getRevision("profile-1") }),
    (error) => error.code === "TRANSCRIPT_SOURCE_CHANGED");
    f.fixture.memoryStore.upsertMany = originalUpsert;
    const id = `reviewed-${candidate.id}`;
    assert.equal(f.fixture.memoryStore.get("profile-1", id).status, "active",
      "the primary commit may have succeeded before the source disappeared");
    assert.equal(f.fixture.memoryEngine.isReviewCommitted("profile-1",
      f.fixture.memoryStore.get("profile-1", id)), false);
    assert.equal(f.fixture.memoryEngine.search({ profileId: "profile-1", query: "每周五" }).items.length, 0,
      "an accepted receipt cannot make an invalid source model-visible");
    f.fixture.memoryEngine.rebuildViews("profile-1");
    assert.doesNotMatch(f.fixture.definitions.get("profile-1").documents.USER, /每周五/u,
      "a view rebuild must recheck the source even if its active index was cached");
    assert.doesNotMatch(f.fixture.definitions.readGeneratedView("profile-1", "MEMORY").content,
      /每周五/u);
    f.fixture.transcripts.close();
    f.fixture.transcripts.open();
    restarted = restartedReview(f);
    assert.equal(restarted.engine.search({ profileId: "profile-1", query: "每周五" }).items.length, 0);
    assert.equal(restarted.service.recoverProfile("profile-1").blocked, 1);
    assert.equal(f.fixture.memoryStore.get("profile-1", id).status, "candidate");
    assert.doesNotMatch(f.fixture.definitions.get("profile-1").documents.USER, /每周五/u);
  } finally { restarted?.close(); f.cleanup(); }
});

test("durable memory receipt replay hides reviewed content after its source disappears", async () => {
  const f = candidateFixture();
  try {
    const source = f.append("我每周五做项目复盘。");
    f.setAnswer({ candidates: [{ eventId: source.id, sourceQuote: "每周五做项目复盘",
      content: "用户每周五做项目复盘", scope: "user" }] });
    await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    const page = f.service.list({ profileId: "profile-1" });
    const accepted = f.service.accept({ profileId: "profile-1", candidateId: page.items[0].id,
      expectedRevision: page.revision,
      expectedMemoryRevision: f.fixture.memoryStore.getRevision("profile-1") });
    const reads = new ConversationMemoryService({ memoryEngine: f.fixture.memoryEngine,
      memoryStore: f.fixture.memoryStore, transcriptStore: f.fixture.transcripts,
      chatSessionStore: f.service.sessions, getRunSessionKey: (run) => run.sourceId });
    const originalReceipt = reads.result("profile-1", accepted.memoryItem);
    assert.equal(originalReceipt.saved, true);
    const journal = path.join(f.fixture.transcripts._sessionDir("profile-1", f.session.id),
      "events.jsonl");
    fs.unlinkSync(journal);
    const replay = reads.revalidateWriteResult("profile-1", originalReceipt, f.session.workspace);
    assert.equal(replay.saved, false);
    assert.deepEqual(replay.item, { id: accepted.memoryItem.id, status: "active" });
    assert.equal(JSON.stringify(replay).includes(accepted.memoryItem.content), false);
  } finally { f.cleanup(); }
});

test("reordered extraction and an old position-based ID keep one review candidate per claim", async () => {
  const f = candidateFixture();
  try {
    const source = f.append("我喜欢简短回答，也习惯周五复盘。");
    const event = f.service.recall.scanEligibleSession({ profileId: "profile-1",
      sessionId: f.session.id }).events[0];
    const preference = { eventId: source.id, sourceQuote: "喜欢简短回答",
      content: "用户偏好简短回答", scope: "user" };
    const review = { eventId: source.id, sourceQuote: "习惯周五复盘",
      content: "用户习惯周五复盘", scope: "user" };
    const first = f.service._proposal("profile-1", f.session, event, preference, 0);
    const reordered = f.service._proposal("profile-1", f.session, event, preference, 2);
    assert.equal(first.id, reordered.id, "model output position must not change candidate identity");
    assert.notEqual(first.id, f.service._proposal("profile-1", f.session, event,
      { ...preference, scope: "project" }).id, "scope is part of candidate identity");
    assert.notEqual(first.id, f.service._proposal("profile-1", f.session,
      { ...event, contentHash: "b".repeat(64) }, preference).id,
    "a changed source body has a new candidate identity");

    // Reproduce an already persisted v1 position-based ID with a cursor that
    // needs to scan this event again. Its audit and eventual reviewed memory ID
    // must survive the new deterministic-ID algorithm.
    const legacyId = `mc-${crypto.createHash("sha256").update(`${EXTRACTOR_VERSION}\0profile-1\0${f.session.id}\0${source.id}\0${0}\0${contentHash(preference.content)}`).digest("hex")}`;
    assert.notEqual(legacyId, first.id);
    f.queue.mutate("profile-1", null, (state) => {
      state.candidates[legacyId] = { ...first, id: legacyId };
    });
    f.setAnswer({ candidates: [review, preference, review, preference] });
    const result = await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    assert.equal(result.created, 1, "new review is added; reordered and repeated old claim is not");
    const persisted = f.queue.get("profile-1");
    assert.equal(Object.keys(persisted.candidates).length, 2);
    assert.equal(persisted.candidates[legacyId].status, "pending");
    assert.equal(Object.values(persisted.candidates)
      .filter((item) => item.content === preference.content).length, 1);
    const accepted = f.service.accept({ profileId: "profile-1", candidateId: legacyId,
      expectedRevision: persisted.revision,
      expectedMemoryRevision: f.fixture.memoryStore.getRevision("profile-1") });
    assert.equal(accepted.memoryItem.id, `reviewed-${legacyId}`);
    assert.equal(accepted.memoryItem.status, "active");
  } finally { f.cleanup(); }
});

test("an excluded user event becomes one review candidate after inclusion, including idle backlog", async () => {
  const f = candidateFixture();
  try {
    const source = f.append("我每周五做项目复盘。", { contextExcluded: true });
    f.setAnswer({ candidates: [{ eventId: source.id, sourceQuote: "每周五做项目复盘",
      content: "用户每周五做项目复盘", scope: "user" }] });
    const skipped = await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    assert.equal(skipped.created, 0);
    assert.equal(skipped.modelCalls, 0);
    assert.deepEqual(f.queue.get("profile-1").cursors[f.session.id].deferredSeqs, [1]);
    f.fixture.transcripts.setContextExcluded({ profileId: "profile-1", sessionId: f.session.id,
      eventId: source.id, contextExcluded: false });
    const recovered = await f.service.processBacklog();
    assert.equal(recovered.processed, 1);
    assert.equal(recovered.created, 1);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.queue.get("profile-1").cursors[f.session.id].deferredSeqs, []);
    assert.equal(f.service.list({ profileId: "profile-1" }).items.length, 1);
    await f.service.processBacklog();
    await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    assert.equal(f.calls.length, 1, "already processed events never spend another model call");
    f.fixture.transcripts.setContextExcluded({ profileId: "profile-1", sessionId: f.session.id,
      eventId: source.id, contextExcluded: true });
    f.fixture.transcripts.setContextExcluded({ profileId: "profile-1", sessionId: f.session.id,
      eventId: source.id, contextExcluded: false });
    await f.service.processBacklog();
    assert.equal(f.calls.length, 1, "later context toggles do not re-extract a processed event");
  } finally { f.cleanup(); }
});

test("including an excluded forgotten source cannot resurrect it as a candidate", async () => {
  const f = candidateFixture();
  try {
    const source = f.append("我每周五做项目复盘。", { contextExcluded: true });
    await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    f.fixture.transcripts.setContextExcluded({ profileId: "profile-1", sessionId: f.session.id,
      eventId: source.id, contextExcluded: false });
    const forgotten = f.fixture.memoryEngine.propose({ profileId: "profile-1",
      scope: "user", type: "semantic", content: "用户每周五做项目复盘",
      sourceRefs: [source.id, source.runId], classification: "explicit" });
    f.fixture.memoryEngine.delete({ profileId: "profile-1", id: forgotten.id, reason: "forgotten" });
    const recovered = await f.service.processBacklog();
    assert.equal(recovered.modelCalls, 0);
    assert.equal(recovered.created, 0);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.queue.get("profile-1").cursors[f.session.id].deferredSeqs, []);
  } finally { f.cleanup(); }
});

test("re-excluded source during model latency stays deferred and cannot enter review", async () => {
  const f = candidateFixture();
  try {
    const source = f.append("我每周五做项目复盘。", { contextExcluded: true });
    await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    f.fixture.transcripts.setContextExcluded({ profileId: "profile-1", sessionId: f.session.id,
      eventId: source.id, contextExcluded: false });
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    let release;
    f.service.extract = () => { entered(); return new Promise((resolve) => { release = resolve; }); };
    const extraction = f.service.processSession({ profileId: "profile-1", sessionId: f.session.id,
      maxBatches: 1 });
    await started;
    f.fixture.transcripts.setContextExcluded({ profileId: "profile-1", sessionId: f.session.id,
      eventId: source.id, contextExcluded: true });
    release({ candidates: [{ eventId: source.id, sourceQuote: "每周五做项目复盘",
      content: "用户每周五做项目复盘", scope: "user" }] });
    const first = await extraction;
    assert.equal(first.created, 0);
    assert.deepEqual(f.queue.get("profile-1").cursors[f.session.id].deferredSeqs, [1]);
    assert.equal(f.service.list({ profileId: "profile-1" }).items.length, 0);
    f.fixture.transcripts.setContextExcluded({ profileId: "profile-1", sessionId: f.session.id,
      eventId: source.id, contextExcluded: false });
    f.service.extract = async () => ({ candidates: [{ eventId: source.id,
      sourceQuote: "每周五做项目复盘", content: "用户每周五做项目复盘", scope: "user" }] });
    assert.equal((await f.service.processBacklog()).created, 1);
  } finally { f.cleanup(); }
});

test("a restored source with an unfinished Run stays deferred until the Run completes", async () => {
  const f = candidateFixture();
  try {
    const source = f.append("我每周五做项目复盘。", { contextExcluded: true });
    await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    f.fixture.transcripts.setContextExcluded({ profileId: "profile-1", sessionId: f.session.id,
      eventId: source.id, contextExcluded: false });
    f.runs.get(source.runId).status = "running";
    const waiting = await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    assert.equal(waiting.modelCalls, 0);
    const cursor = f.queue.get("profile-1").cursors[f.session.id];
    assert.deepEqual(cursor.deferredSeqs, [1]);
    assert.notEqual(cursor.transcriptRevision,
      f.fixture.transcripts.getRevision("profile-1", f.session.id));
    f.runs.get(source.runId).status = "completed";
    f.setAnswer({ candidates: [{ eventId: source.id, sourceQuote: "每周五做项目复盘",
      content: "用户每周五做项目复盘", scope: "user" }] });
    assert.equal((await f.service.processBacklog()).created, 1);
    assert.deepEqual(f.queue.get("profile-1").cursors[f.session.id].deferredSeqs, []);
  } finally { f.cleanup(); }
});

test("restored-source batch and daily limits leave the remaining source retryable", async () => {
  const f = candidateFixture({ maxModelCallsPerDay: 1 });
  try {
    const sources = Array.from({ length: 17 }, (_, index) =>
      f.append(`我每周复盘项目 ${index}。`, { contextExcluded: true }));
    await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    assert.equal(f.queue.get("profile-1").cursors[f.session.id].deferredSeqs.length, 17);
    for (const source of sources) f.fixture.transcripts.setContextExcluded({
      profileId: "profile-1", sessionId: f.session.id,
      eventId: source.id, contextExcluded: false });
    f.setAnswer({ candidates: [{ eventId: sources[0].id, sourceQuote: "每周复盘项目 0",
      content: "用户每周复盘项目 0", scope: "user" }] });
    const first = await f.service.processSession({ profileId: "profile-1",
      sessionId: f.session.id, maxBatches: 1 });
    assert.equal(first.modelCalls, 1);
    assert.equal(f.calls[0].events.length, 16);
    assert.deepEqual(f.queue.get("profile-1").cursors[f.session.id].deferredSeqs, [17]);
    const capped = await f.service.processBacklog();
    assert.equal(capped.failed, 1);
    assert.equal(capped.failures[0].code, "MEMORY_CANDIDATE_DAILY_CAP");
    assert.deepEqual(f.queue.get("profile-1").cursors[f.session.id].deferredSeqs, [17]);
    f.service.now = () => Date.parse("2026-09-28T00:00:00Z");
    f.setAnswer({ candidates: [{ eventId: sources[16].id, sourceQuote: "每周复盘项目 16",
      content: "用户每周复盘项目 16", scope: "user" }] });
    const resumed = await f.service.processBacklog();
    assert.equal(resumed.created, 1);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.queue.get("profile-1").cursors[f.session.id].deferredSeqs, []);
  } finally { f.cleanup(); }
});

test("batch review stages then activates in two journal records and rebuilds USER/MEMORY once", async () => {
  const f = candidateFixture();
  try {
    const { page } = await pendingPair(f);
    const beforeMemory = f.fixture.memoryStore.getRevision("profile-1");
    let rebuilds = 0;
    const originalRebuild = f.fixture.memoryEngine._rebuildViews.bind(f.fixture.memoryEngine);
    f.fixture.memoryEngine._rebuildViews = (...args) => { rebuilds++; return originalRebuild(...args); };
    const accepted = f.service.acceptMany({ profileId: "profile-1",
      candidateIds: page.items.map((item) => item.id), expectedRevision: page.revision,
      expectedMemoryRevision: beforeMemory });
    assert.equal(accepted.acceptedCandidateIds.length, 2);
    assert.equal(accepted.acceptedMemoryIds.length, 2);
    assert.equal(accepted.memoryRevision, beforeMemory + 2);
    assert.equal(rebuilds, 1);
    assert.equal(f.fixture.memoryStore.list("profile-1", { status: "active" }).length, 2);
    assert.equal(f.service.list({ profileId: "profile-1" }).items.length, 0);
    assert.equal(f.provenanceRecords.length, 2);
    assert.ok(Buffer.byteLength(JSON.stringify(accepted), "utf8") < 56 * 1024);
  } finally { f.cleanup(); }
});

test("a pre-stage journal failure leaves the whole review batch pending", async () => {
  const f = candidateFixture();
  try {
    const { page } = await pendingPair(f);
    const beforeMemory = f.fixture.memoryStore.getRevision("profile-1");
    const originalUpsert = f.fixture.memoryStore.upsertMany.bind(f.fixture.memoryStore);
    f.fixture.memoryStore.upsertMany = () => { throw Object.assign(new Error("journal unavailable"),
      { code: "MEMORY_WRITE_FAILED" }); };
    assert.throws(() => f.service.acceptMany({ profileId: "profile-1",
      candidateIds: page.items.map((item) => item.id), expectedRevision: page.revision,
      expectedMemoryRevision: beforeMemory }),
    (error) => error.code === "MEMORY_WRITE_FAILED");
    f.fixture.memoryStore.upsertMany = originalUpsert;
    assert.equal(f.fixture.memoryStore.getRevision("profile-1"), beforeMemory);
    assert.equal(f.fixture.memoryStore.list("profile-1").length, 0);
    assert.equal(f.queue.get("profile-1").revision, page.revision);
  } finally { f.cleanup(); }
});

test("batch review rejects a conflict before any candidate or memory is written", async () => {
  const f = candidateFixture();
  try {
    const { first, page } = await pendingPair(f);
    f.fixture.memoryEngine.propose({ profileId: "profile-1", scope: "user", type: "semantic",
      content: "用户每周五做项目复盘", classification: "explicit",
      sourceRefs: [first.id, first.runId] });
    const beforeMemory = f.fixture.memoryStore.getRevision("profile-1");
    assert.throws(() => f.service.acceptMany({ profileId: "profile-1",
      candidateIds: page.items.map((item) => item.id), expectedRevision: page.revision,
      expectedMemoryRevision: beforeMemory }),
    (error) => error.code === "MEMORY_CANDIDATE_CONFLICT");
    assert.equal(f.fixture.memoryStore.getRevision("profile-1"), beforeMemory);
    assert.equal(f.queue.get("profile-1").revision, page.revision);
    assert.equal(f.service.list({ profileId: "profile-1" }).items.length, 2);
  } finally { f.cleanup(); }
});

test("batch review rejects every candidate when one source was forgotten", async () => {
  const f = candidateFixture();
  try {
    const { first, page } = await pendingPair(f);
    const prior = f.fixture.memoryEngine.propose({ profileId: "profile-1", scope: "user",
      type: "semantic", content: "用户每周五做项目复盘", classification: "explicit",
      sourceRefs: [first.id, first.runId] });
    f.fixture.memoryEngine.delete({ profileId: "profile-1", id: prior.id, reason: "forgotten" });
    const beforeMemory = f.fixture.memoryStore.getRevision("profile-1");
    assert.throws(() => f.service.acceptMany({ profileId: "profile-1",
      candidateIds: page.items.map((item) => item.id), expectedRevision: page.revision,
      expectedMemoryRevision: beforeMemory }),
    (error) => error.code === "MEMORY_CANDIDATE_SOURCE_UNAVAILABLE");
    assert.equal(f.fixture.memoryStore.getRevision("profile-1"), beforeMemory);
    assert.equal(f.queue.get("profile-1").revision, page.revision);
    assert.equal(f.fixture.memoryStore.list("profile-1", { status: "active" }).length, 0);
  } finally { f.cleanup(); }
});

test("batch review reconciles one committed journal batch after a failed review receipt", async () => {
  const f = candidateFixture();
  try {
    const { page } = await pendingPair(f);
    const beforeMemory = f.fixture.memoryStore.getRevision("profile-1");
    let rebuilds = 0;
    const originalRebuild = f.fixture.memoryEngine._rebuildViews.bind(f.fixture.memoryEngine);
    f.fixture.memoryEngine._rebuildViews = (...args) => { rebuilds++; return originalRebuild(...args); };
    const originalMutate = f.queue.mutate.bind(f.queue);
    f.queue.mutate = () => { throw Object.assign(new Error("review receipt unavailable"),
      { code: "MEMORY_CANDIDATE_UNAVAILABLE" }); };
    const request = { profileId: "profile-1", candidateIds: page.items.map((item) => item.id),
      expectedRevision: page.revision, expectedMemoryRevision: beforeMemory };
    assert.throws(() => f.service.acceptMany(request),
      (error) => error.code === "MEMORY_CANDIDATE_COMMIT_UNCERTAIN"
        && error.committedUncertain === true);
    f.queue.mutate = originalMutate;
    assert.equal(f.fixture.memoryStore.getRevision("profile-1"), beforeMemory + 1);
    assert.equal(f.fixture.memoryStore.list("profile-1", { status: "active" }).length, 0,
      "an older App also ignores staged candidate records");
    assert.equal(f.fixture.memoryStore.list("profile-1", { status: "candidate" }).length, 2);
    assert.equal(f.queue.get("profile-1").revision, page.revision);
    assert.equal(rebuilds, 0, "views wait for the accepted review receipt");
    assert.equal(f.fixture.memoryEngine.search({ profileId: "profile-1", query: "每周五" }).items.length, 0,
      "a pending review receipt cannot expose the committed memory to an Agent");
    const originalGet = f.queue.get.bind(f.queue);
    f.queue.get = () => { throw new Error("candidate sidecar unavailable"); };
    assert.equal(f.fixture.memoryEngine.search({ profileId: "profile-1", query: "每周五" }).items.length, 0,
      "an unreadable review receipt must fail closed");
    f.queue.get = originalGet;
    assert.doesNotMatch(f.fixture.definitions.get("profile-1").documents.USER, /每周五/u);
    const accepted = f.service.acceptMany(request);
    assert.equal(accepted.acceptedCandidateIds.length, 2);
    assert.equal(f.fixture.memoryStore.getRevision("profile-1"), beforeMemory + 2);
    assert.equal(rebuilds, 1, "receipt reconciliation must not rebuild views again");
    assert.equal(f.fixture.memoryEngine.search({ profileId: "profile-1", query: "每周五" }).items.length, 1);
  } finally { f.cleanup(); }
});

test("a new active duplicate blocks staged retry and restart promotion of the whole batch", async () => {
  const f = candidateFixture();
  let restarted = null;
  try {
    const { page } = await pendingPair(f);
    const request = { profileId: "profile-1", candidateIds: page.items.map((item) => item.id),
      expectedRevision: page.revision,
      expectedMemoryRevision: f.fixture.memoryStore.getRevision("profile-1") };
    const originalMutate = f.queue.mutate.bind(f.queue);
    f.queue.mutate = () => { throw new Error("receipt unavailable"); };
    assert.throws(() => f.service.acceptMany(request),
      (error) => error.code === "MEMORY_CANDIDATE_COMMIT_UNCERTAIN");
    f.queue.mutate = originalMutate;
    const candidate = page.items[0];
    f.fixture.memoryEngine.propose({ profileId: "profile-1", scope: candidate.scope,
      type: "semantic", content: candidate.content, classification: "explicit", sensitivity: "private",
      sourceRefs: [candidate.source.eventId, candidate.source.runId,
        ...(["project", "workspace"].includes(candidate.scope)
          ? [workspaceMemoryRef(candidate.source.workspace)] : [])] });
    assert.throws(() => f.service.acceptMany(request),
      (error) => error.code === "MEMORY_CANDIDATE_COMMIT_UNCERTAIN"
        && error.cause?.code === "MEMORY_CONFLICT_INVALID");
    assert.equal(f.fixture.memoryStore.list("profile-1", { status: "candidate" }).length, 2);
    assert.equal(f.fixture.memoryStore.list("profile-1", { status: "active" }).length, 1);
    restarted = restartedReview(f);
    assert.equal(restarted.service.recoverProfile("profile-1").blocked, 2);
    assert.equal(f.fixture.memoryStore.list("profile-1", { status: "candidate" }).length, 2);
    assert.equal(restarted.engine.search({ profileId: "profile-1", query: page.items[1].content }).items
      .some((item) => item.id.startsWith("reviewed-")), false);
  } finally { restarted?.close(); f.cleanup(); }
});

test("receipt committed before activation recovers after restart without exposing staged memory", async () => {
  const f = candidateFixture();
  let restarted = null;
  try {
    const { page } = await pendingPair(f);
    const beforeMemory = f.fixture.memoryStore.getRevision("profile-1");
    const originalActivate = f.fixture.memoryEngine.activateReviewedBatch.bind(f.fixture.memoryEngine);
    f.fixture.memoryEngine.activateReviewedBatch = () => { throw new Error("activation unavailable"); };
    assert.throws(() => f.service.acceptMany({ profileId: "profile-1",
      candidateIds: page.items.map((item) => item.id), expectedRevision: page.revision,
      expectedMemoryRevision: beforeMemory }),
    (error) => error.code === "MEMORY_CANDIDATE_COMMIT_UNCERTAIN");
    f.fixture.memoryEngine.activateReviewedBatch = originalActivate;
    assert.equal(f.fixture.memoryStore.getRevision("profile-1"), beforeMemory + 1);
    assert.equal(f.fixture.memoryStore.list("profile-1", { status: "candidate" }).length, 2);
    assert.equal(f.fixture.memoryStore.list("profile-1", { status: "active" }).length, 0);
    restarted = restartedReview(f);
    assert.equal(restarted.engine.search({ profileId: "profile-1", query: "每周五" }).items.length, 0);
    assert.equal(restarted.service.list({ profileId: "profile-1", status: "accepted" }).items.length, 2,
      "the first review read repairs accepted receipts after restart");
    assert.equal(f.fixture.memoryStore.getRevision("profile-1"), beforeMemory + 2);
    assert.equal(restarted.engine.search({ profileId: "profile-1", query: "每周五" }).items.length, 1);
  } finally { restarted?.close(); f.cleanup(); }
});

test("recovery rechecks the original journal at its own activation boundary", async () => {
  const f = candidateFixture();
  let restarted = null;
  try {
    const { page } = await pendingPair(f);
    f.fixture.memoryEngine.activateReviewedBatch = () => { throw new Error("activation unavailable"); };
    assert.throws(() => f.service.acceptMany({ profileId: "profile-1",
      candidateIds: page.items.map((item) => item.id), expectedRevision: page.revision,
      expectedMemoryRevision: f.fixture.memoryStore.getRevision("profile-1") }),
    (error) => error.code === "MEMORY_CANDIDATE_COMMIT_UNCERTAIN");
    restarted = restartedReview(f);
    const originalActivate = restarted.engine.activateReviewedBatch.bind(restarted.engine);
    const journal = path.join(f.fixture.transcripts._sessionDir("profile-1", f.session.id),
      "events.jsonl");
    restarted.engine.activateReviewedBatch = (request) => {
      fs.unlinkSync(journal);
      return originalActivate(request);
    };
    assert.equal(restarted.service.recoverProfile("profile-1").blocked, 2);
    assert.equal(f.fixture.memoryStore.list("profile-1", { status: "candidate" }).length, 2);
    assert.equal(f.fixture.memoryStore.list("profile-1", { status: "active" }).length, 0);
    assert.equal(restarted.engine.search({ profileId: "profile-1", query: "每周五" }).items.length, 0);
  } finally { restarted?.close(); f.cleanup(); }
});

test("activation committed before a lost response is recognized after restart", async () => {
  const f = candidateFixture();
  let restarted = null;
  try {
    const { page } = await pendingPair(f);
    const beforeMemory = f.fixture.memoryStore.getRevision("profile-1");
    const originalActivate = f.fixture.memoryEngine.activateReviewedBatch.bind(f.fixture.memoryEngine);
    f.fixture.memoryEngine.activateReviewedBatch = (request) => {
      originalActivate(request);
      throw new Error("activation response lost");
    };
    assert.throws(() => f.service.acceptMany({ profileId: "profile-1",
      candidateIds: page.items.map((item) => item.id), expectedRevision: page.revision,
      expectedMemoryRevision: beforeMemory }),
    (error) => error.code === "MEMORY_CANDIDATE_COMMIT_UNCERTAIN");
    f.fixture.memoryEngine.activateReviewedBatch = originalActivate;
    assert.equal(f.fixture.memoryStore.getRevision("profile-1"), beforeMemory + 2);
    assert.equal(f.fixture.memoryStore.list("profile-1", { status: "active" }).length, 2);
    restarted = restartedReview(f);
    assert.equal(restarted.service.recoverProfile("profile-1").activated, 0);
    assert.equal(f.fixture.memoryStore.getRevision("profile-1"), beforeMemory + 2);
    assert.equal(restarted.engine.search({ profileId: "profile-1", query: "每周五" }).items.length, 1);
  } finally { restarted?.close(); f.cleanup(); }
});

test("restart and later source revocation keep an uncertain review batch invisible", async () => {
  const f = candidateFixture();
  let reopened = null;
  let reopenedRecall = null;
  try {
    const { first, page } = await pendingPair(f);
    const request = { profileId: "profile-1", candidateIds: page.items.map((item) => item.id),
      expectedRevision: page.revision,
      expectedMemoryRevision: f.fixture.memoryStore.getRevision("profile-1") };
    const originalMutate = f.queue.mutate.bind(f.queue);
    f.queue.mutate = () => { throw new Error("receipt disk failure"); };
    assert.throws(() => f.service.acceptMany(request),
      (error) => error.code === "MEMORY_CANDIDATE_COMMIT_UNCERTAIN");
    f.queue.mutate = originalMutate;
    f.fixture.memoryEngine.close();
    reopened = new MemoryEngine({ store: f.fixture.memoryStore,
      definitionStore: f.fixture.definitions, transcriptStore: f.fixture.transcripts,
      chatSessionStore: f.service.sessions, strictSourceResolution: true });
    reopened.setReviewReceiptStore(f.queue);
    reopened.open(["profile-1"]);
    assert.equal(reopened.search({ profileId: "profile-1", query: "每周五" }).items.length, 0);
    assert.doesNotMatch(f.fixture.definitions.get("profile-1").documents.USER, /每周五/u);
    const prior = reopened.propose({ profileId: "profile-1", scope: "user", type: "semantic",
      content: "用户希望保留原始复盘记录", classification: "explicit",
      sourceRefs: [first.id, first.runId] });
    reopened.delete({ profileId: "profile-1", id: prior.id, reason: "forgotten" });
    const afterForget = f.fixture.memoryStore.getRevision("profile-1");
    reopenedRecall = new ConversationRecallService({ paths: f.fixture.paths,
      transcriptStore: f.fixture.transcripts, memoryStore: f.fixture.memoryStore,
      chatSessionStore: f.service.sessions,
      workDispatcher: { getRun: (id) => f.runs.get(id) || null },
      getRunSessionKey: (run) => run.sourceId, recallPolicy: reopened.recallPolicy });
    const resumed = new MemoryCandidateService({ candidateStore: f.queue,
      memoryEngine: reopened, memoryStore: f.fixture.memoryStore,
      conversationRecallService: reopenedRecall, chatSessionStore: f.service.sessions,
      isProfileEligible: () => true,
      extractCandidates: () => { throw new Error("must not call model"); } });
    assert.throws(() => resumed.acceptMany(request),
      (error) => error.code === "MEMORY_CANDIDATE_SOURCE_UNAVAILABLE");
    assert.equal(f.fixture.memoryStore.getRevision("profile-1"), afterForget);
    assert.equal(f.queue.get("profile-1").revision, page.revision);
    assert.equal(reopened.search({ profileId: "profile-1", query: "每周五" }).items.length, 0);
  } finally { reopenedRecall?.close(); reopened?.close(); f.cleanup(); }
});

test("startup quarantines an older active reviewed memory without an accepted receipt", async () => {
  const f = candidateFixture();
  let restarted = null;
  try {
    const { page } = await pendingPair(f);
    const candidate = page.items[0];
    const memoryId = `reviewed-${candidate.id}`;
    f.fixture.memoryEngine.propose({ profileId: "profile-1", id: memoryId,
      scope: candidate.scope, type: "semantic", content: candidate.content,
      classification: "imported", sensitivity: candidate.sensitivity,
      sourceRefs: [candidate.source.eventId, candidate.source.runId,
        ...(["project", "workspace"].includes(candidate.scope)
          ? [workspaceMemoryRef(candidate.source.workspace)] : [])] });
    assert.equal(f.fixture.memoryStore.get("profile-1", memoryId).status, "active");
    restarted = restartedReview(f);
    assert.equal(f.fixture.memoryStore.get("profile-1", memoryId).status, "candidate",
      "rollback to an older App must not expose a missing review receipt");
    assert.equal(restarted.engine.search({ profileId: "profile-1", query: candidate.content }).items.length, 0);
  } finally { restarted?.close(); f.cleanup(); }
});

test("candidate rejection, source revocation and daily cap fail closed", async () => {
  const f = candidateFixture({ maxModelCallsPerDay: 2 });
  try {
    const first = f.append("我喜欢清晰的变更记录。");
    f.setAnswer({ candidates: [{ eventId: first.id, sourceQuote: "清晰的变更记录",
      content: "用户偏好清晰的变更记录", scope: "user" }] });
    await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    let list = f.service.list({ profileId: "profile-1" });
    const rejected = f.service.reject({ profileId: "profile-1", candidateId: list.items[0].id,
      expectedRevision: list.revision });
    assert.equal(rejected.candidate.status, "rejected");
    assert.equal(f.fixture.memoryStore.list("profile-1", { status: "active" }).length, 0);

    const second = f.append("我计划每月检查备份。");
    f.setAnswer({ candidates: [{ eventId: second.id, sourceQuote: "每月检查备份",
      content: "用户每月检查备份", scope: "user" }] });
    await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    list = f.service.list({ profileId: "profile-1" });
    assert.equal(list.items.length, 1);
    const prior = f.fixture.memoryEngine.propose({ profileId: "profile-1",
      scope: "user", type: "semantic", content: "用户每月检查备份",
      sourceRefs: [second.id, second.runId], classification: "explicit" });
    f.fixture.memoryEngine.delete({ profileId: "profile-1", id: prior.id, reason: "forgotten" });
    assert.throws(() => f.service.accept({ profileId: "profile-1", candidateId: list.items[0].id,
      expectedRevision: list.revision, expectedMemoryRevision: f.fixture.memoryStore.getRevision("profile-1") }),
    (error) => error.code === "MEMORY_CANDIDATE_SOURCE_UNAVAILABLE");

    const third = f.append("文档里的示例是“我每周三跑步”。");
    f.setAnswer({ candidates: [{ eventId: third.id, sourceQuote: "我每周三跑步",
      content: "用户每周三跑步", scope: "user" }] });
    await assert.rejects(() => f.service.processSession({ profileId: "profile-1", sessionId: f.session.id }),
      (error) => error.code === "MEMORY_CANDIDATE_DAILY_CAP");
    assert.equal(f.service.list({ profileId: "profile-1" }).items.length, 0,
      "a forgotten candidate stays stored for audit but its text is hidden from review lists");
    assert.equal(Object.values(f.queue.get("profile-1").candidates).filter((item) => item.status === "pending").length, 1,
      "daily cap cannot create a new candidate or advance the source cursor");
  } finally { f.cleanup(); }
});

test("pending, accepted and rejected review lists hide lost or forgotten source text", async () => {
  const f = candidateFixture();
  try {
    const { page } = await pendingPair(f);
    const accepted = f.service.accept({ profileId: "profile-1", candidateId: page.items[0].id,
      expectedRevision: page.revision,
      expectedMemoryRevision: f.fixture.memoryStore.getRevision("profile-1") });
    f.session.status = "deleted";
    for (const status of ["pending", "accepted", "rejected", "all"]) {
      assert.equal(f.service.list({ profileId: "profile-1", status }).items.length, 0,
        `${status} must not reveal candidates from an unavailable session`);
    }
    f.session.status = "ready";
    f.fixture.memoryEngine.delete({ profileId: "profile-1", id: accepted.memoryItem.id,
      reason: "forgotten" });
    assert.equal(f.service.list({ profileId: "profile-1", status: "accepted" }).items.length, 0);
    const pending = f.service.list({ profileId: "profile-1" });
    assert.equal(pending.items.length, 1);
    f.service.reject({ profileId: "profile-1", candidateId: pending.items[0].id,
      expectedRevision: pending.revision });
    const source = pending.items[0].source;
    const prior = f.fixture.memoryEngine.propose({ profileId: "profile-1", scope: "project",
      type: "semantic", content: "用户希望保留另一个项目说明", classification: "explicit",
      sourceRefs: [source.eventId, source.runId, workspaceMemoryRef(f.session.workspace)] });
    f.fixture.memoryEngine.delete({ profileId: "profile-1", id: prior.id, reason: "forgotten" });
    assert.equal(f.service.list({ profileId: "profile-1", status: "rejected" }).items.length, 0);
    assert.equal(f.service.list({ profileId: "profile-1", status: "all" }).items.length, 0);
  } finally { f.cleanup(); }
});

test("review list hides a forgotten claim even when a different source event remains visible", async () => {
  const f = candidateFixture();
  try {
    const oldSource = f.append("我喜欢茉莉花茶。");
    const otherSource = f.append("关于饮料，我仍偏好茉莉花茶。");
    f.setAnswer({ candidates: [{ eventId: otherSource.id, sourceQuote: "偏好茉莉花茶",
      content: "用户喜欢茉莉花茶", scope: "user" }] });
    await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    const before = f.service.list({ profileId: "profile-1" });
    assert.equal(before.items.length, 1);
    const prior = f.fixture.memoryEngine.propose({ profileId: "profile-1", scope: "user",
      type: "semantic", content: "用户喜欢茉莉花茶", classification: "explicit",
      sourceRefs: [oldSource.id, oldSource.runId] });
    f.fixture.memoryEngine.delete({ profileId: "profile-1", id: prior.id, reason: "forgotten" });
    assert.equal(f.service._sourceNow("profile-1", before.items[0]).eventId, otherSource.id,
      "the second event itself remains eligible, isolating claim-content revocation");
    assert.equal(f.fixture.memoryEngine.recallPolicy.hasRevokedContent("profile-1",
      before.items[0].content), true);
    assert.equal(f.service.list({ profileId: "profile-1", status: "pending" }).items.length, 0);
    assert.equal(f.service.list({ profileId: "profile-1", status: "all" }).items.length, 0);
    const beforeRejectRevision = f.queue.get("profile-1").revision;
    assert.throws(() => f.service.reject({ profileId: "profile-1",
      candidateId: before.items[0].id, expectedRevision: beforeRejectRevision }),
    (error) => error.code === "MEMORY_CANDIDATE_SOURCE_UNAVAILABLE"
      && !String(error.message).includes(before.items[0].content));
    assert.throws(() => f.service.accept({ profileId: "profile-1",
      candidateId: before.items[0].id, expectedRevision: beforeRejectRevision,
      expectedMemoryRevision: f.fixture.memoryStore.getRevision("profile-1") }),
    (error) => error.code === "MEMORY_CANDIDATE_SOURCE_UNAVAILABLE"
      && !String(error.message).includes(before.items[0].content));
    assert.throws(() => f.service.acceptMany({ profileId: "profile-1",
      candidateIds: [before.items[0].id], expectedRevision: beforeRejectRevision,
      expectedMemoryRevision: f.fixture.memoryStore.getRevision("profile-1") }),
    (error) => error.code === "MEMORY_CANDIDATE_SOURCE_UNAVAILABLE");
    assert.equal(f.queue.get("profile-1").revision, beforeRejectRevision,
      "unavailable candidate cannot be rejected or accepted through a stale ID");
  } finally { f.cleanup(); }
});

test("extraction does not write a candidate matching an independently forgotten claim", async () => {
  const f = candidateFixture();
  try {
    const oldSource = f.append("我喜欢茉莉花茶。");
    const otherSource = f.append("关于饮料，我仍偏好茉莉花茶。");
    const prior = f.fixture.memoryEngine.propose({ profileId: "profile-1", scope: "user",
      type: "semantic", content: "用户喜欢茉莉花茶", classification: "explicit",
      sourceRefs: [oldSource.id, oldSource.runId] });
    f.fixture.memoryEngine.delete({ profileId: "profile-1", id: prior.id, reason: "forgotten" });
    f.setAnswer({ candidates: [{ eventId: otherSource.id, sourceQuote: "偏好茉莉花茶",
      content: "用户喜欢茉莉花茶", scope: "user" }] });
    const result = await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    assert.equal(result.modelCalls, 1);
    assert.equal(result.created, 0);
    assert.equal(Object.keys(f.queue.get("profile-1").candidates).length, 0);
    assert.equal(f.service.list({ profileId: "profile-1" }).items.length, 0);
  } finally { f.cleanup(); }
});

test("accepted replay and reject never return content after an independent claim is forgotten", async () => {
  const f = candidateFixture();
  try {
    const oldSource = f.append("我喜欢茉莉花茶。");
    const otherSource = f.append("关于饮料，我仍偏好茉莉花茶。");
    f.setAnswer({ candidates: [{ eventId: otherSource.id, sourceQuote: "偏好茉莉花茶",
      content: "用户喜欢茉莉花茶", scope: "user" }] });
    await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    const pending = f.service.list({ profileId: "profile-1" });
    const accepted = f.service.accept({ profileId: "profile-1", candidateId: pending.items[0].id,
      expectedRevision: pending.revision,
      expectedMemoryRevision: f.fixture.memoryStore.getRevision("profile-1") });
    assert.equal(accepted.memoryItem.status, "active");
    const oldClaim = f.fixture.memoryEngine.propose({ profileId: "profile-1", scope: "user",
      type: "episodic", content: accepted.candidate.content, classification: "explicit",
      sourceRefs: [oldSource.id, oldSource.runId] });
    f.fixture.memoryEngine.delete({ profileId: "profile-1", id: oldClaim.id, reason: "forgotten" });
    assert.equal(f.service._sourceNow("profile-1", accepted.candidate).eventId, otherSource.id);
    const revision = f.queue.get("profile-1").revision;
    const memoryRevision = f.fixture.memoryStore.getRevision("profile-1");
    for (const action of [
      () => f.service.accept({ profileId: "profile-1", candidateId: accepted.candidate.id,
        expectedRevision: revision, expectedMemoryRevision: memoryRevision }),
      () => f.service.acceptMany({ profileId: "profile-1", candidateIds: [accepted.candidate.id],
        expectedRevision: revision, expectedMemoryRevision: memoryRevision }),
      () => f.service.reject({ profileId: "profile-1", candidateId: accepted.candidate.id,
        expectedRevision: revision }),
    ]) {
      assert.throws(action, (error) => error.code === "MEMORY_CANDIDATE_SOURCE_UNAVAILABLE"
        && !String(error.message).includes(accepted.candidate.content));
    }
    assert.equal(f.queue.get("profile-1").revision, revision);
    assert.equal(f.fixture.memoryStore.getRevision("profile-1"), memoryRevision);
    assert.equal(f.service.list({ profileId: "profile-1", status: "accepted" }).items.length, 0);
  } finally { f.cleanup(); }
});

test("quoted interior text cannot become a candidate; provenance sidecar failure does not strand acceptance", async () => {
  const f = candidateFixture();
  try {
    const quoted = f.append("他说「我喜欢咖啡和茶」，这是引用示例。");
    const direct = f.append("我每周五做项目复盘。");
    f.setAnswer({ candidates: [
      { eventId: quoted.id, sourceQuote: "喜欢咖啡", content: "用户喜欢咖啡", scope: "user" },
      { eventId: direct.id, sourceQuote: "每周五做项目复盘", content: "用户每周五做项目复盘", scope: "user" },
    ] });
    assert.equal((await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id })).created, 1);
    const list = f.service.list({ profileId: "profile-1" });
    assert.equal(list.items.length, 1);
    f.service.provenance.recordConversationSave = () => { throw new Error("sidecar unavailable"); };
    const accepted = f.service.accept({ profileId: "profile-1", candidateId: list.items[0].id,
      expectedRevision: list.revision, expectedMemoryRevision: f.fixture.memoryStore.getRevision("profile-1") });
    assert.equal(accepted.candidate.status, "accepted");
    assert.equal(accepted.memoryItem.status, "active");
    assert.equal(f.queue.get("profile-1").operations[0].status, "completed");
  } finally { f.cleanup(); }
});

test("candidate review pages stay below the response budget and skip unverifiable sources", async () => {
  const f = candidateFixture();
  try {
    const source = f.append("我每周五做项目复盘。");
    f.setAnswer({ candidates: [{ eventId: source.id, sourceQuote: "每周五做项目复盘",
      content: "用户每周五做项目复盘", scope: "user" }] });
    await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    const base = f.service.list({ profileId: "profile-1" }).items[0];
    let hidden = 0;
    f.queue.mutate("profile-1", null, (state) => {
      for (let index = 1; index < 70; index++) {
        const item = { ...structuredClone(base), id: `candidate-page-${index}`,
          content: `候选 ${index} ${"资料".repeat(300)}`, createdAt: base.createdAt + index,
          updatedAt: base.updatedAt + index };
        if (index % 7 === 0) {
          item.source.contentHash = "0".repeat(64);
          hidden++;
        }
        state.candidates[item.id] = item;
      }
    });
    const revision = f.queue.get("profile-1").revision;
    const seen = new Set();
    let cursor = 0;
    for (;;) {
      const page = f.service.list({ profileId: "profile-1", limit: 100, cursor,
        expectedRevision: revision });
      assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= 40 * 1024);
      for (const item of page.items) seen.add(item.id);
      if (!page.hasMore) break;
      assert.ok(page.nextCursor > cursor);
      cursor = page.nextCursor;
    }
    assert.equal(seen.size, 70 - hidden);
    assert.throws(() => f.service.list({ profileId: "profile-1", cursor: 1,
      expectedRevision: revision - 1 }), (error) => error.code === "MEMORY_CANDIDATE_REVISION_CONFLICT");
  } finally { f.cleanup(); }
});

test("an all-hidden review page advances its raw cursor without leaking text", async () => {
  const f = candidateFixture();
  try {
    const source = f.append("我每周五做项目复盘。");
    f.setAnswer({ candidates: [{ eventId: source.id, sourceQuote: "每周五做项目复盘",
      content: "用户每周五做项目复盘", scope: "user" }] });
    await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    const base = f.service.list({ profileId: "profile-1" }).items[0];
    f.queue.mutate("profile-1", null, (state) => {
      for (let index = 1; index <= 300; index++) {
        state.candidates[`candidate-hidden-${index}`] = { ...structuredClone(base),
          id: `candidate-hidden-${index}`, content: `不可展示的候选 ${index}`,
          source: { ...base.source, contentHash: "0".repeat(64) },
          createdAt: base.createdAt + index, updatedAt: base.updatedAt + index };
      }
    });
    const first = f.service.list({ profileId: "profile-1", limit: 10 });
    assert.deepEqual(first.items, []);
    assert.equal(first.hasMore, true);
    assert.ok(first.nextCursor > 0);
    const second = f.service.list({ profileId: "profile-1", limit: 10,
      cursor: first.nextCursor, expectedRevision: first.revision });
    assert.deepEqual(second.items.map((item) => item.id), [base.id]);
    assert.equal(second.hasMore, false);
  } finally { f.cleanup(); }
});

test("candidate extraction injects the coordinator tool-free model path and records usage in the sidecar", async () => {
  const f = candidateFixture();
  const work = await openFixture({ sessionStatus: "ready" });
  try {
    const source = f.append("我每周五做项目复盘。");
    const baseProfile = work.productStore.getAgentProfile("profile-shoggoth");
    work.coordinator.productStore.getAgentProfile = () => ({ ...baseProfile, id: "profile-1" });
    work.coordinator.chatSessionStore.getSession = (key) => key === f.session.sessionKey
      ? structuredClone(f.session) : null;
    work.coordinator.runtimeManager.canGenerateModelOnly = () => true;
    work.coordinator.runtimeManager.acquire = async (_binding, options) => {
      assert.equal(options.permissionPolicy.sandbox, "read-only");
      return { capabilities: { "model.generate.toolFree": true },
        generateModelOnly: async ({ operationId }) => {
          assert.match(operationId, /^memory-extraction-/u);
          return { text: JSON.stringify({ candidates: [{ eventId: source.id,
            sourceQuote: "每周五做项目复盘", content: "用户每周五做项目复盘", scope: "user" }] }),
          model: "fixture-model", usage: { totalTokens: 30, inputTokens: 20, outputTokens: 10,
            cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 } };
        } };
    };
    f.service.extract = (request) => work.coordinator.extractMemoryCandidatesModelOnly(request);
    const result = await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    assert.equal(result.created, 1);
    assert.equal(f.fixture.memoryStore.list("profile-1", { status: "active" }).length, 0);
    const state = f.queue.get("profile-1");
    assert.equal(state.operations[0].status, "completed");
    assert.equal(state.operations[0].model, "fixture-model");
    assert.equal(state.usage.calls, 1);
    assert.equal(state.usage.inputTokens, 20);
    assert.equal(state.usage.outputTokens, 10);
    assert.equal(work.dispatcher.listRuns().length, 0);
  } finally { await work.coordinator.close(); f.cleanup(); }
});

test("a restarted review read marks an unfinished model call interrupted without replay", () => {
  const f = candidateFixture();
  try {
    f.queue.mutate("profile-1", null, (state) => {
      state.operations.push({ operationId: "memory-extraction-crash-cut", sessionId: f.session.id,
        day: "2026-09-27", status: "started", startedAt: 1,
        finishedAt: null, errorCode: null, inputTokens: 0, outputTokens: 0,
        model: null, runtime: null, runtimeAccountId: null });
      state.usage = { day: "2026-09-27", calls: 1, inputTokens: 0, outputTokens: 0 };
    });
    const restarted = new MemoryCandidateService({ candidateStore: f.queue,
      memoryEngine: f.fixture.memoryEngine, memoryStore: f.fixture.memoryStore,
      conversationRecallService: f.service.recall, chatSessionStore: f.service.sessions,
      isProfileEligible: () => true,
      extractCandidates: () => { throw new Error("must not replay"); }, now: () => 20_000 });
    const before = f.queue.get("profile-1").revision;
    const page = restarted.list({ profileId: "profile-1" });
    assert.ok(page.revision > before);
    assert.equal(f.queue.get("profile-1").operations[0].status, "interrupted");
    assert.equal(f.queue.get("profile-1").operations[0].errorCode,
      "MEMORY_EXTRACTION_RECOVERY_UNAVAILABLE");
    assert.equal(f.queue.get("profile-1").usage.calls, 1,
      "an uncertain model attempt retains its budget charge");
  } finally { f.cleanup(); }
});

test("bounded backlog wake recovers a completed chat whose terminal extraction callback was lost", async () => {
  const f = candidateFixture();
  try {
    const source = f.append("我每周五做项目复盘。");
    const restarted = new MemoryCandidateService({ candidateStore: f.queue,
      memoryEngine: f.fixture.memoryEngine, memoryStore: f.fixture.memoryStore,
      conversationRecallService: f.service.recall, chatSessionStore: f.service.sessions,
      isProfileEligible: () => true,
      extractCandidates: async () => ({ candidates: [{ eventId: source.id,
        sourceQuote: "每周五做项目复盘", content: "用户每周五做项目复盘", scope: "user" }] }) });
    const first = await restarted.processBacklog();
    assert.equal(first.scanned, 1);
    assert.equal(first.processed, 1);
    assert.equal(first.modelCalls, 1);
    assert.equal(first.created, 1);
    assert.equal(f.queue.get("profile-1").cursors[f.session.id].throughSeq, 1);
    const quiet = await restarted.processBacklog();
    assert.equal(quiet.modelCalls, 0, "a wake without new evidence cannot call the model");
  } finally { f.cleanup(); }
});

test("bounded backlog wakes resume the durable cursor after a four-page tail", async () => {
  const f = candidateFixture();
  try {
    for (let index = 0; index < 65; index++) f.append(`我偏好第${index}号蓝色计划。`);
    f.service.extract = async ({ events }) => {
      const event = events.at(-1);
      return { candidates: [{ eventId: event.eventId, sourceQuote: event.text,
        content: event.text.replace("我偏好", "用户偏好"), scope: "user" }] };
    };
    const first = await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    assert.equal(first.modelCalls, 4);
    assert.equal(first.throughSeq, 64);
    const restarted = new MemoryCandidateService({ candidateStore: f.queue,
      memoryEngine: f.fixture.memoryEngine, memoryStore: f.fixture.memoryStore,
      conversationRecallService: f.service.recall, chatSessionStore: f.service.sessions,
      isProfileEligible: () => true,
      extractCandidates: f.service.extract });
    const tail = await restarted.processBacklog();
    assert.equal(tail.modelCalls, 1);
    assert.equal(tail.created, 1);
    assert.equal(f.queue.get("profile-1").cursors[f.session.id].throughSeq, 65);
    assert.equal((await restarted.processBacklog()).modelCalls, 0);
  } finally { f.cleanup(); }
});

test("backlog stops before an unfinished direct Run and retries it after completion", async () => {
  const f = candidateFixture();
  try {
    const source = f.append("我每周五做项目复盘。");
    f.runs.get(source.runId).status = "running";
    f.setAnswer({ candidates: [{ eventId: source.id, sourceQuote: "每周五做项目复盘",
      content: "用户每周五做项目复盘", scope: "user" }] });
    const held = await f.service.processBacklog();
    assert.equal(held.modelCalls, 0);
    assert.equal(f.queue.get("profile-1").cursors[f.session.id]?.throughSeq, 0,
      "an active user event must remain behind the durable cursor");
    f.runs.get(source.runId).status = "completed";
    const finished = await f.service.processBacklog();
    assert.equal(finished.modelCalls, 1);
    assert.equal(f.queue.get("profile-1").cursors[f.session.id].throughSeq, 1);
  } finally { f.cleanup(); }
});

test("backlog reaches a fifth session after restart using durable session cursors", async () => {
  const f = candidateFixture();
  try {
    const sessions = [f.session];
    f.append("我偏好第0号蓝色计划。");
    for (let index = 1; index < 5; index++) {
      const session = { ...f.session, id: `backlog-session-${index}`,
        sessionKey: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${index + 2}` };
      sessions.push(session);
      f.fixture.transcripts.ensureSession({ profileId: "profile-1", sessionId: session.id });
      const runId = `backlog-run-${index}`;
      f.runs.set(runId, { id: runId, source: "chat", sourceId: session.sessionKey,
        profileId: "profile-1", workspace: session.workspace, status: "completed" });
      f.fixture.transcripts.appendEvent({ profileId: "profile-1", sessionId: session.id,
        runId, id: `backlog-event-${index}`, kind: "user",
        content: { text: `我偏好第${index}号蓝色计划。` },
        runtimeRef: null, contextExcluded: false, occurredAt: 20_000 + index });
    }
    f.service.sessions.listSessions = () => structuredClone(sessions);
    f.service.sessions.getSession = (key) => structuredClone(sessions.find(
      (session) => session.sessionKey === key) || null);
    const extract = async ({ events }) => ({ candidates: [{ eventId: events[0].eventId,
      sourceQuote: events[0].text,
      content: events[0].text.replace("我偏好", "用户偏好"), scope: "user" }] });
    f.service.extract = extract;
    const first = await f.service.processBacklog();
    assert.equal(first.scanned, 5);
    assert.equal(first.processed, 4);
    assert.equal(first.modelCalls, 4);
    const lastSession = sessions.slice().sort((left, right) => left.id.localeCompare(right.id))[4];
    assert.equal(f.queue.get("profile-1").cursors[lastSession.id], undefined);
    const restarted = new MemoryCandidateService({ candidateStore: f.queue,
      memoryEngine: f.fixture.memoryEngine, memoryStore: f.fixture.memoryStore,
      conversationRecallService: f.service.recall, chatSessionStore: f.service.sessions,
      isProfileEligible: () => true,
      extractCandidates: extract });
    const second = await restarted.processBacklog();
    assert.equal(second.modelCalls, 1);
    assert.equal(f.queue.get("profile-1").cursors[lastSession.id].throughSeq, 1);
    assert.equal((await restarted.processBacklog()).modelCalls, 0);
  } finally { f.cleanup(); }
});

test("disabled Profile cannot spend a background model call or advance its cursor", async () => {
  const f = candidateFixture();
  try {
    f.append("我每周五做项目复盘。");
    f.service.isProfileEligible = () => false;
    assert.equal((await f.service.processBacklog()).modelCalls, 0);
    assert.equal(f.queue.get("profile-1").cursors[f.session.id], undefined);
    await assert.rejects(() => f.service.processSession({ profileId: "profile-1",
      sessionId: f.session.id }), (error) => error.code === "MEMORY_CANDIDATE_PROFILE_DISABLED");
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test("late model output cannot recreate a purged Profile's candidate directory", async () => {
  const f = candidateFixture();
  try {
    f.append("我每周五做项目复盘。");
    let enabled = true;
    let generation = 1;
    f.service.isProfileEligible = () => enabled;
    f.service.getProfileGeneration = () => generation;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    let release;
    f.service.extract = () => { entered(); return new Promise((resolve) => { release = resolve; }); };
    const backlog = f.service.processBacklog();
    await started;
    enabled = false;
    generation++;
    const profileDir = path.join(f.fixture.paths.agentsDir, "profile-1");
    fs.rmSync(profileDir, { recursive: true });
    release({ candidates: [] });
    const result = await backlog;
    assert.equal(result.failed, 1);
    assert.equal(fs.existsSync(profileDir), false,
      "late model receipt and backlog attempt must not recreate a purged Profile");
    assert.equal(f.service.inFlightOperations.size, 0);
  } finally { f.cleanup(); }
});

test("archive and restore cannot accept a model response from the old Profile generation", async () => {
  const f = candidateFixture();
  try {
    const source = f.append("我每周五做项目复盘。");
    let generation = 1;
    f.service.getProfileGeneration = () => generation;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    let release;
    f.service.extract = () => { entered(); return new Promise((resolve) => { release = resolve; }); };
    const backlog = f.service.processBacklog();
    await started;
    generation = 3; // The Product Profile was archived and then restored.
    release({ candidates: [{ eventId: source.id, sourceQuote: "每周五做项目复盘",
      content: "用户每周五做项目复盘", scope: "user" }] });
    const result = await backlog;
    assert.equal(result.failed, 1);
    const state = f.queue.get("profile-1");
    assert.equal(Object.keys(state.candidates).length, 0);
    assert.equal(state.cursors[f.session.id], undefined,
      "the stale backlog must not advance the restored Profile cursor");
    assert.equal(state.operations[0].status, "started",
      "restart or the next read records an interrupted old-generation attempt");
  } finally { f.cleanup(); }
});

test("full candidate queue defers backlog visibly before any model cost", async () => {
  const f = candidateFixture();
  try {
    f.append("我每周五做项目复盘。");
    const originalGet = f.queue.get.bind(f.queue);
    const full = Object.fromEntries(Array.from({ length: 4096 }, (_, index) =>
      [`capacity-${index}`, null]));
    f.queue.get = (profileId) => ({ ...originalGet(profileId), candidates: full });
    await assert.rejects(() => f.service.processSession({ profileId: "profile-1",
      sessionId: f.session.id }), (error) => error.code === "MEMORY_CANDIDATE_CAPACITY");
    const backlog = await f.service.processBacklog();
    assert.equal(backlog.failed, 1);
    assert.deepEqual(backlog.failures, [{ profileId: "profile-1",
      sessionId: f.session.id, code: "MEMORY_CANDIDATE_CAPACITY" }]);
    assert.equal(backlog.modelCalls, 0);
    assert.equal(f.calls.length, 0);
    assert.equal(originalGet("profile-1").usage.calls, 0);
  } finally { f.cleanup(); }
});

test("one remaining candidate slot still saves a valid proposal", async () => {
  const f = candidateFixture();
  try {
    const source = f.append("我每周五做项目复盘。");
    const originalGet = f.queue.get.bind(f.queue);
    const almostFull = Object.fromEntries(Array.from({ length: 4095 }, (_, index) =>
      [`capacity-${index}`, null]));
    f.queue.get = (profileId) => ({ ...originalGet(profileId), candidates: almostFull });
    f.setAnswer({ candidates: [{ eventId: source.id, sourceQuote: "每周五做项目复盘",
      content: "用户每周五做项目复盘", scope: "user" }] });
    const result = await f.service.processSession({ profileId: "profile-1",
      sessionId: f.session.id });
    assert.equal(result.created, 1);
    assert.match(f.calls[0].prompt, /At most 1 candidates total/u);
    assert.equal(Object.keys(originalGet("profile-1").candidates).length, 1);
    assert.equal(originalGet("profile-1").cursors[f.session.id].throughSeq, 1);
    const later = f.append("我习惯在周一整理需求。");
    f.setAnswer({ candidates: [
      { eventId: later.id, sourceQuote: "在周一整理需求",
        content: "用户习惯在周一整理需求", scope: "project" },
      { eventId: later.id, sourceQuote: "周一整理需求",
        content: "用户每周一整理需求", scope: "user" },
    ] });
    await assert.rejects(() => f.service.processSession({ profileId: "profile-1",
      sessionId: f.session.id }), (error) => error.code === "MEMORY_CANDIDATE_MODEL_INVALID");
    assert.equal(originalGet("profile-1").cursors[f.session.id].throughSeq, 1,
      "an over-limit output cannot silently advance past a valid claim");
  } finally { f.cleanup(); }
});

test("terminal extraction admits only direct chat and chat-origin Inspiration", () => {
  const session = { id: "session-direct", sessionKey: "session-key-direct",
    profileId: "profile-1", workspace: "/workspace", status: "ready" };
  const sessions = { getSession: (key) => key === session.sessionKey ? session : null };
  const chat = { id: "run-chat", source: "chat", sourceId: session.sessionKey,
    profileId: session.profileId, workspace: session.workspace };
  const inspiration = { ...chat, id: "run-inspiration", source: "inspiration", sourceId: "idea-1" };
  const origin = { runId: inspiration.id, ideaId: inspiration.sourceId,
    profileId: inspiration.profileId, workspace: inspiration.workspace,
    sessionKey: session.sessionKey, inputSource: "chat" };
  const origins = { executionForRun: () => origin };
  assert.equal(candidateSessionForCompletedRun(chat, { status: "completed" }, sessions, origins), session);
  assert.equal(candidateSessionForCompletedRun(inspiration, { status: "completed" }, sessions, origins), session);
  assert.equal(candidateSessionForCompletedRun(inspiration, { status: "failed" }, sessions, origins), null);
  assert.equal(candidateSessionForCompletedRun(inspiration, { status: "completed" }, sessions,
    { executionForRun: () => ({ ...origin, inputSource: "card" }) }), null);
  assert.equal(candidateSessionForCompletedRun(inspiration, { status: "completed" }, sessions,
    { executionForRun: () => ({ ...origin, workspace: "/other" }) }), null);
  assert.equal(candidateSessionForCompletedRun({ ...chat,
    idempotencyKey: "shoggoth:chat-send:federation-message-1" },
  { status: "completed" }, sessions, origins), null);
});

test("accepted candidate explains an exact live user quote through the real provenance sidecar", async () => {
  const f = candidateFixture();
  const store = new MemoryProvenanceStore({ paths: f.fixture.paths });
  store.open();
  try {
    const source = f.append("我每周五做项目复盘。");
    f.setAnswer({ candidates: [{ eventId: source.id, sourceQuote: "每周五做项目复盘",
      content: "用户每周五做项目复盘", scope: "user" }] });
    const provenance = new MemoryProvenanceService({ store, memoryStore: f.fixture.memoryStore,
      transcriptStore: f.fixture.transcripts, chatSessionStore: f.service.sessions,
      recallPolicy: f.fixture.memoryEngine.recallPolicy,
      getRun: (id) => f.runs.get(id) || null, getRunSessionKey: (run) => run.sourceId });
    f.service.provenance = provenance;
    await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    const page = f.service.list({ profileId: "profile-1" });
    const accepted = f.service.accept({ profileId: "profile-1", candidateId: page.items[0].id,
      expectedRevision: page.revision, expectedMemoryRevision: f.fixture.memoryStore.getRevision("profile-1") });
    const explained = provenance.explain({ profileId: "profile-1", id: accepted.memoryItem.id,
      viewer: "user", workspace: f.session.workspace });
    assert.equal(explained.evidence.status, "verified_quote");
    assert.equal(explained.evidence.quote, "每周五做项目复盘");
  } finally { store.close(); f.cleanup(); }
});

test("candidate sidecar upgrades its pre-audit snapshot without touching legacy app stores", () => {
  const f = candidateFixture();
  try {
    f.queue.mutate("profile-1", null, (state) => { state.usage.day = "2026-09-27"; });
    const file = path.join(f.fixture.paths.agentsDir, "profile-1", "memory", "candidate-review.json");
    const old = JSON.parse(fs.readFileSync(file, "utf8"));
    delete old.operations;
    old.schemaVersion = 1;
    old.checksum = checksum(old);
    fs.writeFileSync(file, `${JSON.stringify(old)}\n`, { mode: 0o600 });
    const upgraded = f.queue.get("profile-1");
    assert.equal(upgraded.schemaVersion, 3);
    assert.deepEqual(upgraded.operations, []);
    f.queue.mutate("profile-1", upgraded.revision, (state) => { state.usage.calls++; });
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion, 3);
  } finally { f.cleanup(); }
});

test("V2 candidate cursor backfills currently excluded user events without replaying visible history", async () => {
  const f = candidateFixture();
  try {
    const visible = f.append("我每周五做项目复盘。");
    const excluded = f.append("我每周一整理需求。", { contextExcluded: true });
    f.setAnswer({ candidates: [{ eventId: visible.id, sourceQuote: "每周五做项目复盘",
      content: "用户每周五做项目复盘", scope: "user" }] });
    await f.service.processSession({ profileId: "profile-1", sessionId: f.session.id });
    const file = path.join(f.fixture.paths.agentsDir, "profile-1", "memory", "candidate-review.json");
    const old = JSON.parse(fs.readFileSync(file, "utf8"));
    delete old.cursors[f.session.id].deferredSeqs;
    old.schemaVersion = 2;
    old.checksum = checksum(old);
    fs.writeFileSync(file, `${JSON.stringify(old)}\n`, { mode: 0o600 });
    assert.equal(f.queue.get("profile-1").cursors[f.session.id].transcriptRevision, 0);
    await f.service.processBacklog();
    assert.deepEqual(f.queue.get("profile-1").cursors[f.session.id].deferredSeqs, [2]);
    assert.equal(f.calls.length, 1, "visible history is not extracted again during migration");
    f.fixture.transcripts.setContextExcluded({ profileId: "profile-1", sessionId: f.session.id,
      eventId: excluded.id, contextExcluded: false });
    f.setAnswer({ candidates: [{ eventId: excluded.id, sourceQuote: "每周一整理需求",
      content: "用户每周一整理需求", scope: "user" }] });
    assert.equal((await f.service.processBacklog()).created, 1);
    assert.equal(f.calls.length, 2);
  } finally { f.cleanup(); }
});
