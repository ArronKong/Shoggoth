"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { memoryFixture } = require("./fixtures/shoggoth-memory-fixture.cjs");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { ConversationMemoryService } = require("../app/agent-service/conversation-memory-service");
const { createUpgradeSnapshot } = require("../app/agent-service/upgrade-snapshot");
const { restoreAuthorityBackup } = require("../app/agent-service/authority-backup");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { MemoryStore } = require("../app/agent-service/memory-store");
const { MemoryEngine } = require("../app/agent-service/memory-engine");
const { TranscriptStore } = require("../app/agent-service/transcript-store");
const { ConversationRecallService } = require("../app/agent-service/conversation-recall-service");

const profileId = "profile-1";
function note(value, sourceRefs = ["event-fact", "run-fact"], validUntil = null) {
  return value.engine.propose({ profileId, scope: "user", type: validUntil === null ? "semantic" : "temporary",
    content: "用户要求记住蓝色番茄计划", sourceRefs, classification: "explicit", validUntil });
}
function event(id = "event-fact", runId = "run-fact", text = "请记住蓝色番茄计划") {
  return { id, runId, content: { text } };
}
function restart(value) {
  value.close();
  value.definitions.open();
  value.store.open();
  value.engine.open([profileId]);
}

test("forget intent hides source and same-run echo before and after restart", () => {
  const value = memoryFixture();
  try {
    const item = note(value);
    const policy = value.engine.recallPolicy;
    assert.equal(policy.isEventVisible(profileId, event()), true);
    const before = policy.getRevision(profileId);
    value.engine.delete({ profileId, id: item.id, reason: "forgotten", operationId: "forget-operation-1" });
    assert.equal(policy.getRevision(profileId), before + 1);
    assert.equal(policy.isEventVisible(profileId, event()), false);
    assert.equal(policy.isEventVisible(profileId, event("assistant-echo", "run-fact", "记下了蓝色番茄计划")), false);
    assert.equal(policy.isEventVisible(profileId, event("unrelated", "run-other", "另一件事情")), true);
    assert.equal(value.engine.search({ profileId, query: "蓝色番茄" }).items.length, 0);
    assert.throws(() => value.engine.propose({ profileId, scope: "user", type: "semantic",
      content: "蓝色番茄计划仍然有效", sourceRefs: ["event-fact", "run-fact"],
      classification: "explicit" }), (error) => error.code === "MEMORY_SOURCE_REVOKED");
    assert.throws(() => value.engine.propose({ profileId, scope: "user", type: "semantic",
      content: "蓝色番茄计划仍然有效", sourceRefs: ["new-user-event", "event-fact"],
      classification: "explicit" }), (error) => error.code === "MEMORY_SOURCE_REVOKED");
    assert.throws(() => value.engine.propose({ profileId, scope: "agent", type: "semantic",
      content: "导入：用户要求记住蓝色番茄计划", sourceRefs: ["codex-memory:old-file"],
      classification: "imported" }), (error) => error.code === "MEMORY_SOURCE_REVOKED");
    restart(value);
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId, event()), false);
    assert.equal(value.store.get(profileId, item.id).status, "deleted");
    // A lost receipt may replay the same operation without another journal row.
    const replayBefore = value.engine.recallPolicy.getRevision(profileId);
    value.engine.delete({ profileId, id: item.id, reason: "forgotten", operationId: "forget-operation-1" });
    assert.equal(value.engine.recallPolicy.getRevision(profileId), replayBefore);
    const reauthorized = value.engine.propose({ profileId, scope: "user", type: "semantic",
      content: "用户要求记住蓝色番茄计划", sourceRefs: ["new-user-event", "new-run"],
      classification: "explicit" });
    assert.notEqual(reauthorized.id, item.id);
    assert.equal(reauthorized.status, "active");
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId, event()), false);
  } finally { value.cleanup(); }
});

test("a verified forget request and its Run are suppressed in the same durable intent", () => {
  const value = memoryFixture();
  try {
    const item = note(value);
    const request = event("forget-request", "forget-run", "请忘记绿色番茄偏好");
    const echo = event("forget-echo", "forget-run", "已经忘记绿色番茄偏好");
    const operationId = "forget-command-source";
    const before = value.engine.recallPolicy.getRevision(profileId);
    value.engine.delete({ profileId, id: item.id, reason: "forgotten", operationId,
      revocationSourceRefs: [request.id, request.runId] });
    const policy = value.engine.recallPolicy;
    assert.equal(policy.getRevision(profileId), before + 1);
    assert.equal(policy.isEventVisible(profileId, request), false);
    assert.equal(policy.isEventVisible(profileId, echo), false);
    const recorded = policy.assertReady(profileId).byOperation.get(operationId);
    assert.ok(recorded.sourceRefs.includes(request.id));
    assert.ok(recorded.sourceRefs.includes(request.runId));
    restart(value);
    assert.equal(policy.isEventVisible(profileId, request), false);
    assert.equal(policy.isEventVisible(profileId, echo), false);
    const replayBefore = policy.getRevision(profileId);
    value.engine.delete({ profileId, id: item.id, reason: "forgotten", operationId,
      revocationSourceRefs: [request.id, request.runId] });
    assert.equal(policy.getRevision(profileId), replayBefore);
  } finally { value.cleanup(); }
});

test("pending legacy forget intent repairs missing request suppression on replay", () => {
  const value = memoryFixture();
  try {
    const item = note(value);
    const operationId = "forget-legacy-command";
    value.engine.recallPolicy.recordReason({ profileId, item, reason: "forgotten", operationId });
    restart(value);
    const request = event("legacy-forget-request", "legacy-forget-run", "忘记绿色番茄偏好");
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId, request), true);
    const before = value.engine.recallPolicy.getRevision(profileId);
    value.engine.delete({ profileId, id: item.id, reason: "forgotten", operationId,
      revocationSourceRefs: [request.id, request.runId] });
    assert.equal(value.engine.recallPolicy.getRevision(profileId), before + 1);
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId, request), false);
    restart(value);
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId, request), false);
    const replayBefore = value.engine.recallPolicy.getRevision(profileId);
    value.engine.delete({ profileId, id: item.id, reason: "forgotten", operationId,
      revocationSourceRefs: [request.id, request.runId] });
    assert.equal(value.engine.recallPolicy.getRevision(profileId), replayBefore);
  } finally { value.cleanup(); }
});

test("a forget request fits alongside the maximum number of stored source refs", () => {
  const value = memoryFixture();
  try {
    const refs = Array.from({ length: 64 }, (_, index) => `source-${index}`);
    const item = note(value, refs);
    const operationId = "forget-full-source-set";
    value.engine.delete({ profileId, id: item.id, reason: "forgotten", operationId,
      revocationSourceRefs: ["full-forget-event", "full-forget-run"] });
    const recorded = value.engine.recallPolicy.assertReady(profileId).byOperation.get(operationId);
    assert.equal(recorded.sourceRefs.length, 66);
    assert.ok(refs.every((ref) => recorded.sourceRefs.includes(ref)));
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId,
      event("full-forget-event", "full-forget-run", "忘记绿色番茄偏好")), false);
    restart(value);
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId,
      event("full-forget-event", "full-forget-run", "忘记绿色番茄偏好")), false);
  } finally { value.cleanup(); }
});

test("crash after durable intent is fail closed and restart finishes primary deletion", () => {
  const value = memoryFixture();
  try {
    const item = note(value);
    const original = value.store.upsertMany.bind(value.store);
    value.store.upsertMany = () => { throw new Error("injected primary-store failure"); };
    assert.throws(() => value.engine.delete({ profileId, id: item.id, reason: "forgotten",
      operationId: "forget-operation-2",
      revocationSourceRefs: ["crash-forget-event", "crash-forget-run"] }), /injected primary-store failure/u);
    value.store.upsertMany = original;
    assert.equal(value.store.get(profileId, item.id).status, "active");
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId, event()), false);
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId,
      event("crash-forget-event", "crash-forget-run", "忘记绿色番茄偏好")), false);
    assert.equal(value.engine.search({ profileId, query: "蓝色番茄" }).items.length, 0);
    restart(value);
    assert.equal(value.store.get(profileId, item.id).status, "deleted");
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId, event()), false);
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId,
      event("crash-forget-event", "crash-forget-run", "忘记绿色番茄偏好")), false);
  } finally { value.cleanup(); }
});

test("loss of all local policy files after durable intent cannot revive active memory", () => {
  const value = memoryFixture();
  try {
    const item = note(value);
    value.engine.recallPolicy.recordReason({ profileId, item, reason: "forgotten",
      operationId: "intent-before-primary" });
    assert.equal(value.store.get(profileId, item.id).status, "active");
    value.close();
    const profileDir = path.join(value.paths.agentsDir, profileId);
    for (const name of ["memory/recall-policy.jsonl", "memory/recall-policy.seal.json",
      "recall-policy-installed.json"]) fs.unlinkSync(path.join(profileDir, name));
    value.definitions.open(); value.store.open(); value.engine.open([profileId]);
    assert.equal(value.store.get(profileId, item.id).status, "active");
    assert.throws(() => value.engine.search({ profileId, query: "蓝色番茄" }),
      (error) => error.code === "RECALL_POLICY_UNAVAILABLE");
    assert.throws(() => value.engine.recallPolicy.isEventVisible(profileId, event()),
      (error) => error.code === "RECALL_POLICY_UNAVAILABLE");
  } finally { value.cleanup(); }
});

test("rolling back all local policy files fails against external high-water", () => {
  const value = memoryFixture();
  try {
    const item = note(value);
    const profileDir = path.join(value.paths.agentsDir, profileId);
    const names = ["memory/recall-policy.jsonl", "memory/recall-policy.seal.json",
      "recall-policy-installed.json"];
    const before = names.map((name) => fs.readFileSync(path.join(profileDir, name)));
    value.engine.recallPolicy.recordReason({ profileId, item, reason: "forgotten",
      operationId: "intent-before-rollback" });
    assert.equal(value.store.get(profileId, item.id).status, "active");
    value.close();
    names.forEach((name, index) => fs.writeFileSync(path.join(profileDir, name), before[index],
      { mode: 0o600 }));
    value.definitions.open(); value.store.open(); value.engine.open([profileId]);
    assert.throws(() => value.engine.search({ profileId, query: "蓝色番茄" }),
      (error) => error.code === "RECALL_POLICY_UNAVAILABLE");
  } finally { value.cleanup(); }
});

test("complete-line rollback cannot erase a forgotten intent", () => {
  const value = memoryFixture();
  try {
    const item = note(value);
    value.engine.delete({ profileId, id: item.id, reason: "forgotten", operationId: "rollback-intent" });
    value.close();
    const log = path.join(value.paths.agentsDir, profileId, "memory", "recall-policy.jsonl");
    const lines = fs.readFileSync(log, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 2);
    fs.writeFileSync(log, `${lines[0]}\n`, { mode: 0o600 });
    // Simulate an older App restoring the primary memory entry as well.
    value.store.open();
    value.store.upsert({ ...item, status: "active", updatedAt: item.updatedAt + 100 });
    value.store.close();
    value.definitions.open(); value.store.open(); value.engine.open([profileId]);
    assert.throws(() => value.engine.search({ profileId, query: "蓝色番茄" }),
      (error) => error.code === "RECALL_POLICY_UNAVAILABLE");
  } finally { value.cleanup(); }
});

test("crash after independent high-water write blocks reads before intent append", () => {
  const value = memoryFixture();
  try {
    const item = note(value);
    const policy = value.engine.recallPolicy;
    const log = path.join(value.paths.agentsDir, profileId, "memory", "recall-policy.jsonl");
    const originalFs = policy.fs;
    policy.fs = Object.assign(Object.create(originalFs), {
      openSync(file, ...args) {
        if (file === log) throw new Error("injected append failure");
        return originalFs.openSync(file, ...args);
      },
    });
    try {
      assert.throws(() => value.engine.delete({ profileId, id: item.id, reason: "forgotten" }),
        (error) => error.code === "RECALL_POLICY_UNAVAILABLE");
    } finally { policy.fs = originalFs; }
    assert.throws(() => value.engine.search({ profileId, query: "蓝色番茄" }),
      (error) => error.code === "RECALL_POLICY_UNAVAILABLE");
    restart(value);
    assert.throws(() => value.engine.search({ profileId, query: "蓝色番茄" }),
      (error) => error.code === "RECALL_POLICY_UNAVAILABLE");
  } finally { value.cleanup(); }
});

test("expiry leaves historical source available; later explicit forget of deleted item suppresses it", () => {
  const value = memoryFixture();
  try {
    const item = note(value, ["event-fact", "run-fact"], 2_000);
    value.setNow(3_000);
    assert.equal(value.engine.consolidate(profileId), 1);
    assert.equal(value.store.get(profileId, item.id).status, "deleted");
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId, event()), true);
    restart(value);
    assert.equal(value.engine.recallPolicy.getMemoryReason(profileId, value.store.get(profileId, item.id)), "expired");
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId, event()), true);
    value.engine.delete({ profileId, id: item.id, reason: "forgotten", operationId: "forget-expired" });
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId, event()), false);
  } finally { value.cleanup(); }
});

test("expiry consolidation handles more than one primary-store batch", () => {
  const value = memoryFixture();
  try {
    const first = note(value, ["event-fact", "run-fact"], 2_000);
    value.store.upsertMany(Array.from({ length: 128 }, (_, index) => ({
      ...first, id: `bulk-expiry-${index}`, content: `临时事实 ${index}`,
      sourceRefs: [`event-bulk-expiry-${index}`, `run-bulk-expiry-${index}`],
    })));
    value.setNow(3_000);
    assert.equal(value.engine.consolidate(profileId), 129);
    assert.equal(value.store.list(profileId, { status: "deleted" }).length, 129);
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId, event()), true);
    restart(value);
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId, event()), true);
    assert.equal(value.engine.recallPolicy.getMemoryReason(profileId, value.store.get(profileId, first.id)), "expired");
  } finally { value.cleanup(); }
});

test("old App reactivation then deletion after expiry is reconciled as unknown forget", () => {
  const value = memoryFixture();
  try {
    const item = note(value, ["event-fact", "run-fact"], 2_000);
    value.setNow(3_000);
    value.engine.consolidate(profileId);
    value.engine.close();
    const expired = value.store.get(profileId, item.id);
    value.store.upsert({ ...expired, status: "active", updatedAt: expired.updatedAt + 1 });
    value.store.upsert({ ...expired, status: "deleted", updatedAt: expired.updatedAt + 2 });
    value.store.close(); value.store.open(); value.engine.open([profileId]);
    assert.equal(value.engine.recallPolicy.getMemoryReason(profileId, value.store.get(profileId, item.id)), "legacy_unknown");
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId, event()), false);
  } finally { value.cleanup(); }
});

test("old primary backup restored before expiry and deleted at the same revision cannot inherit expiry reason", () => {
  const value = memoryFixture();
  try {
    const item = note(value, ["event-fact", "run-fact"], 2_000);
    const memoryDir = path.join(value.paths.agentsDir, profileId, "memory");
    const journal = path.join(memoryDir, "events.jsonl");
    const snapshot = path.join(memoryDir, "snapshot.json");
    const oldJournal = fs.readFileSync(journal);
    const oldSnapshot = fs.readFileSync(snapshot);
    value.setNow(3_000);
    value.engine.consolidate(profileId);
    value.close();
    fs.writeFileSync(journal, oldJournal, { mode: 0o600 });
    fs.writeFileSync(snapshot, oldSnapshot, { mode: 0o600 });
    value.store.open();
    assert.equal(value.store.get(profileId, item.id).status, "active");
    value.store.upsert({ ...item, status: "deleted", updatedAt: 9_000 });
    assert.equal(value.store.getRevision(profileId), 2, "old deletion reuses the normal expiry revision");
    value.store.close(); value.definitions.open(); value.store.open(); value.engine.open([profileId]);
    assert.equal(value.engine.recallPolicy.getMemoryReason(profileId, value.store.get(profileId, item.id)), "legacy_unknown");
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId, event()), false);
    const fresh = value.engine.propose({ profileId, scope: "user", type: "semantic",
      content: item.content, sourceRefs: ["event-new", "run-new"], classification: "explicit" });
    assert.equal(value.engine.recallPolicy.isMemoryVisible(profileId, fresh), true);
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId, event()), false);
  } finally { value.cleanup(); }
});

test("expiry deletion without a durable primary commit proof is conservatively suppressed on restart", () => {
  const value = memoryFixture();
  try {
    const item = note(value, ["event-fact", "run-fact"], 2_000);
    const policy = value.engine.recallPolicy;
    const original = policy.recordExpiryCommit.bind(policy);
    policy.recordExpiryCommit = () => {};
    value.setNow(3_000);
    try { value.engine.consolidate(profileId); }
    finally { policy.recordExpiryCommit = original; }
    assert.equal(policy.isEventVisible(profileId, event()), true);
    restart(value);
    assert.equal(value.engine.recallPolicy.getMemoryReason(profileId, value.store.get(profileId, item.id)), "legacy_unknown");
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId, event()), false);
  } finally { value.cleanup(); }
});

test("failure after primary expiry fsync but before the policy commit proof stays fail closed", () => {
  const value = memoryFixture();
  try {
    const item = note(value, ["event-fact", "run-fact"], 2_000);
    const policy = value.engine.recallPolicy;
    const original = policy.recordExpiryCommit.bind(policy);
    policy.recordExpiryCommit = () => { throw new Error("injected expiry-commit fsync failure"); };
    value.setNow(3_000);
    try { assert.throws(() => value.engine.consolidate(profileId), /injected expiry-commit fsync failure/u); }
    finally { policy.recordExpiryCommit = original; }
    assert.equal(value.store.get(profileId, item.id).status, "deleted");
    restart(value);
    assert.equal(value.engine.recallPolicy.getMemoryReason(profileId, value.store.get(profileId, item.id)), "legacy_unknown");
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId, event()), false);
  } finally { value.cleanup(); }
});

test("old App deletion is conservatively reconciled on next startup", () => {
  const value = memoryFixture();
  try {
    const item = note(value);
    value.engine.close();
    value.store.upsert({ ...item, status: "deleted", updatedAt: item.updatedAt + 1 });
    value.store.close();
    value.store.open();
    value.engine.open([profileId]);
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId, event()), false);
    assert.equal(value.engine.recallPolicy.hasRevocations(profileId), true);
  } finally { value.cleanup(); }
});

test("first policy migration backfills deleted records at the marker high-water", () => {
  const value = memoryFixture();
  try {
    const item = note(value);
    value.close();
    const profileDir = path.join(value.paths.agentsDir, profileId);
    for (const target of ["memory/recall-policy.jsonl", "memory/recall-policy.seal.json",
      "recall-policy-installed.json"]) fs.unlinkSync(path.join(profileDir, target));
    fs.unlinkSync(path.join(value.paths.agentsDir, ".recall-policy-installations", `${profileId}.json`));
    value.store.open();
    value.store.upsert({ ...item, status: "deleted", updatedAt: item.updatedAt + 1 });
    value.store.close();
    value.definitions.open(); value.store.open(); value.engine.open([profileId]);
    assert.equal(value.engine.recallPolicy.getRevision(profileId), 2);
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId, event()), false);
  } finally { value.cleanup(); }
});

test("legacy single event source also hides verifiable same-run assistant echo", () => {
  const value = memoryFixture();
  try {
    const item = note(value, ["legacy-source-event"]);
    const policy = value.engine.recallPolicy;
    policy.strictSourceResolution = true;
    policy.chatSessionStore = { listSessions: () => [{ profileId, id: "session-old" }] };
    policy.transcriptStore = { listEvents: () => [{ id: "legacy-source-event", runId: "run-legacy" },
      { id: "legacy-echo", runId: "run-legacy" }] };
    value.engine.delete({ profileId, id: item.id, reason: "forgotten", operationId: "forget-legacy" });
    assert.equal(policy.isEventVisible(profileId, event("legacy-echo", "run-legacy", "我还记得蓝色番茄计划")), false);
  } finally { value.cleanup(); }
});

test("unverifiable source ref falls back to exact content suppression", () => {
  const value = memoryFixture();
  try {
    const item = note(value, ["missing-old-event"]);
    const policy = value.engine.recallPolicy;
    policy.strictSourceResolution = true;
    policy.chatSessionStore = { listSessions: () => [{ profileId, id: "session-new" }] };
    policy.transcriptStore = { listEvents: () => [event("new-copy", "new-run",
      "用户要求记住蓝色番茄计划，现在仍照做")] };
    value.engine.delete({ profileId, id: item.id, reason: "forgotten",
      operationId: "forget-ghost-source" });
    assert.equal(policy.isEventVisible(profileId, event("new-copy", "new-run",
      "用户要求记住蓝色番茄计划，现在仍照做")), false);
    assert.equal(policy.isEventVisible(profileId, event("unrelated", "new-run", "讨论其他主题")), true);
    restart(value);
    assert.equal(policy.isEventVisible(profileId, event("new-copy", "new-run",
      "用户要求记住蓝色番茄计划，现在仍照做")), false);
  } finally { value.cleanup(); }
});

test("forget hides older verbatim copies of the source message across sessions but permits a later user reauthorization", () => {
  const value = memoryFixture();
  try {
    const item = note(value, ["old-source", "old-run"]);
    const policy = value.engine.recallPolicy;
    const originalText = "请记住蓝色番茄计划";
    const source = { id: "old-source", runId: "old-run", kind: "user", occurredAt: 1_000,
      content: { text: originalText } };
    const oldCopy = { id: "old-copy", runId: "copy-run", kind: "user", occurredAt: 2_000,
      content: { text: originalText } };
    const newSource = { id: "new-source", runId: "new-run", kind: "user", occurredAt: 5_001,
      content: { text: `新的明确陈述：${originalText}。` } };
    policy.strictSourceResolution = true;
    policy.chatSessionStore = { listSessions: () => [
      { profileId, id: "original-session" }, { profileId, id: "copy-session" },
      { profileId, id: "new-session" },
    ] };
    policy.transcriptStore = { listEvents: (_profileId, sessionId) => (
      sessionId === "original-session" ? [source]
        : sessionId === "copy-session" ? [oldCopy] : [newSource]
    ) };
    value.setNow(5_000);
    value.engine.delete({ profileId, id: item.id, reason: "forgotten",
      operationId: "forget-verbatim-copy" });
    assert.equal(policy.isEventVisible(profileId, newSource), false,
      "a later user message alone has not authorized historical recall");
    const renewed = value.engine.propose({ profileId, scope: "user", type: "semantic",
      content: item.content, sourceRefs: [newSource.id, newSource.runId],
      classification: "explicit" });
    assert.equal(policy.isMemoryVisible(profileId, renewed), true);
    const assertVisibility = () => {
      assert.equal(policy.isEventVisible(profileId, source), false);
      assert.equal(policy.isEventVisible(profileId, oldCopy), false,
        "the claim paraphrases its source, so claim-content matching alone cannot hide this copy");
      assert.equal(policy.isEventVisible(profileId, { ...oldCopy, id: "old-echo",
        kind: "assistant", occurredAt: 5_001 }), false);
      assert.equal(policy.isEventVisible(profileId, { ...oldCopy, id: "wrapped-echo",
        kind: "assistant", content: { text: `原话：“${originalText}”\n消息 ID：old-source` } }), false,
      "an assistant wrapper must not make a verbatim forgotten source visible again");
      assert.equal(policy.isEventVisible(profileId, { ...oldCopy, id: "query-only",
        content: { text: "请检索蓝色番茄计划的历史原话" } }), true,
      "a query mentioning the topic does not contain the verified source body");
      assert.equal(policy.isEventVisible(profileId, newSource), true);
      assert.equal(policy.isEventVisible(profileId, { ...newSource, id: "new-echo",
        kind: "assistant" }), false);
    };
    assertVisibility();
    restart(value);
    assertVisibility();
  } finally { value.cleanup(); }
});

test("conversation recall removes a wrapped assistant quote from search/get and the persisted index after forgetting", async () => {
  const value = memoryFixture();
  const transcripts = new TranscriptStore({ paths: value.paths, assertSecretSafe: () => true });
  let recall;
  try {
    transcripts.open();
    const sessions = [
      { id: "11111111-1111-4111-8111-111111111111", sessionKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        profileId, workspace: "/wrapped-test", status: "ready" },
      { id: "22222222-2222-4222-8222-222222222222", sessionKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        profileId, workspace: "/wrapped-test", status: "ready" },
    ];
    const sessionStore = { listSessions: () => sessions, getRevision: () => 1,
      getSession: key => sessions.find(session => session.sessionKey === key), getCronSessionOrigin: () => null };
    const runs = new Map();
    const addRun = (id, session) => {
      const run = { id, profileId, workspace: session.workspace, source: "chat",
        sourceId: session.sessionKey, status: "completed", idempotencyKey: `chat:${id}` };
      runs.set(id, run); return run;
    };
    for (const session of sessions) transcripts.ensureSession({ profileId, sessionId: session.id });
    const append = (session, run, id, kind, text) => transcripts.appendEvent({
      profileId, sessionId: session.id, runId: run.id, id, kind, content: { text } });
    const sourceRun = addRun("wrapped-source-run", sessions[0]);
    const echoRun = addRun("wrapped-echo-run", sessions[1]);
    const caller = addRun("wrapped-caller-run", sessions[1]);
    const originalText = "我喜欢代号 WRAPPEDCOPY-0928 的蓝色番茄计划。";
    const source = append(sessions[0], sourceRun, "wrapped-source", "user", originalText);
    append(sessions[1], echoRun, "wrapped-query", "user", "请定位之前的偏好");
    const echo = append(sessions[1], echoRun, "wrapped-assistant", "assistant",
      `原话：“${originalText}”\n消息 ID：${source.id}`);
    append(sessions[1], caller, "wrapped-caller", "user", "检查历史召回");
    const policy = value.engine.recallPolicy;
    policy.strictSourceResolution = true;
    policy.chatSessionStore = sessionStore; policy.transcriptStore = transcripts;
    const item = value.engine.propose({ profileId, scope: "user", type: "semantic",
      content: "用户的测试偏好是 WRAPPEDCOPY-0928", sourceRefs: [source.id, sourceRun.id], classification: "explicit" });
    const openRecall = () => new ConversationRecallService({ paths: value.paths, memoryStore: value.store,
      transcriptStore: transcripts, chatSessionStore: sessionStore, recallPolicy: policy,
      workDispatcher: { getRun: id => runs.get(id) }, getRunSessionKey: run => run.sourceId });
    const search = async () => {
      const input = { profileId, run: caller,
        args: { source: "chat", sourceId: caller.sourceId, query: "WRAPPEDCOPY-0928", limit: 10 } };
      let result = recall.search(input);
      if (result.status === "rebuilding") { await recall.whenIndexReady(profileId); result = recall.search(input); }
      assert.equal(result.status, "ready"); return result;
    };
    const get = (session, event) => recall.get({ profileId, run: caller,
      args: { source: "chat", sourceId: caller.sourceId, sessionId: session.id, eventId: event.id, window: 0 } });
    recall = openRecall();
    assert.deepEqual((await search()).results.map(row => row.eventId).sort(), [source.id, echo.id].sort());
    value.setNow(Date.now() + 1_000);
    value.engine.delete({ profileId, id: item.id, reason: "forgotten", operationId: "forget-wrapped-recall" });
    assert.equal((await search()).count, 0);
    assert.throws(() => get(sessions[0], source), error => error.code === "CONVERSATION_EVENT_NOT_FOUND");
    assert.throws(() => get(sessions[1], echo), error => error.code === "CONVERSATION_EVENT_NOT_FOUND");
    recall.close(); recall = null;
    restart(value);
    recall = openRecall();
    assert.equal((await search()).count, 0);
    assert.throws(() => get(sessions[1], echo), error => error.code === "CONVERSATION_EVENT_NOT_FOUND");
  } finally { recall?.close(); transcripts.close(); value.cleanup(); }
});

test("a later request not to remember a forgotten fact stays out of historical recall", () => {
  const value = memoryFixture();
  try {
    const item = value.engine.propose({ profileId, scope: "user", type: "semantic",
      content: "蓝色番茄计划", sourceRefs: ["codex-memory:old-file"],
      classification: "imported" });
    const policy = value.engine.recallPolicy;
    const denied = { id: "later-denial", runId: "later-run", kind: "user", occurredAt: 6_000,
      content: { text: "别再记住蓝色番茄计划" } };
    const renewedSource = { id: "renewed-source", runId: "renewed-run", kind: "user",
      occurredAt: 7_000, content: { text: "请记住蓝色番茄计划" } };
    let sourceEvents = [denied, renewedSource];
    let transcriptRevision = 1;
    let sourceScans = 0;
    policy.strictSourceResolution = true;
    policy.chatSessionStore = { getRevision: () => 1,
      listSessions: () => [{ profileId, id: "later-session" }] };
    policy.transcriptStore = { getChangeRevision: () => transcriptRevision,
      listEvents: () => { sourceScans++; return sourceEvents; } };
    value.setNow(5_000);
    value.engine.delete({ profileId, id: item.id, reason: "forgotten",
      operationId: "forget-before-denial" });
    assert.equal(policy.isEventVisible(profileId, denied), false);
    assert.equal(policy.isEventVisible(profileId, renewedSource), false);
    const beforeRenewal = policy.getHistoricalVisibilityRevision(profileId);
    const initialScans = sourceScans;
    assert.equal(policy.getHistoricalVisibilityRevision(profileId), beforeRenewal);
    assert.equal(sourceScans, initialScans,
      "unchanged transcript revisions reuse source verification and visibility digest");
    value.setNow(7_001);
    const renewed = value.engine.propose({ profileId, scope: "user", type: "semantic",
      content: item.content, sourceRefs: [renewedSource.id, renewedSource.runId],
      classification: "explicit" });
    assert.equal(policy.isMemoryVisible(profileId, renewed), true);
    assert.equal(policy.isEventVisible(profileId, renewedSource), true);
    const afterRenewal = policy.getHistoricalVisibilityRevision(profileId);
    const renewalScans = sourceScans;
    assert.notEqual(afterRenewal, beforeRenewal,
      "a committed renewal must invalidate the derived historical index");
    assert.equal(policy.isEventVisible(profileId, denied), false,
      "a committed renewal for another event cannot reveal the earlier denial");
    value.engine.propose({ profileId, scope: "agent", type: "semantic",
      content: "另一条不相关的事实", sourceRefs: ["user-edit:unrelated"],
      classification: "explicit" });
    assert.equal(policy.getHistoricalVisibilityRevision(profileId), afterRenewal,
      "an unrelated memory write must not invalidate the derived historical index");
    assert.equal(sourceScans, renewalScans,
      "scanning active memories must reuse the verified user-event index");
    sourceEvents = [denied]; transcriptRevision++;
    assert.equal(policy.isEventVisible(profileId, renewedSource), false,
      "losing the renewed source invalidates the cached authorization");
    assert.notEqual(policy.getHistoricalVisibilityRevision(profileId), afterRenewal);
    sourceEvents = [denied, renewedSource]; transcriptRevision++;
    restart(value);
    assert.equal(policy.isEventVisible(profileId, denied), false);
    assert.equal(policy.isEventVisible(profileId, renewedSource), true);
  } finally { value.cleanup(); }
});

test("a second forget revokes the first renewal until a newer event is committed", () => {
  const value = memoryFixture();
  try {
    const policy = value.engine.recallPolicy;
    const text = "请记住蓝色番茄计划";
    const original = { id: "initial-source", runId: "initial-run", kind: "user",
      occurredAt: 1_000, content: { text } };
    const firstRenewal = { id: "first-renewal", runId: "first-renewal-run", kind: "user",
      occurredAt: 6_000, content: { text } };
    const secondRenewal = { id: "second-renewal", runId: "second-renewal-run", kind: "user",
      occurredAt: 8_000, content: { text } };
    const sourceEvents = [original, firstRenewal, secondRenewal];
    policy.strictSourceResolution = true;
    policy.chatSessionStore = { getRevision: () => 1,
      listSessions: () => [{ profileId, id: "renewal-session" }] };
    policy.transcriptStore = { getChangeRevision: () => 1,
      listEvents: () => sourceEvents };
    const initial = note(value, [original.id, original.runId]);
    value.setNow(5_000);
    value.engine.delete({ profileId, id: initial.id, reason: "forgotten",
      operationId: "first-forget" });
    value.setNow(6_001);
    const renewed = value.engine.propose({ profileId, scope: "user", type: "semantic",
      content: initial.content, sourceRefs: [firstRenewal.id, firstRenewal.runId],
      classification: "explicit" });
    assert.equal(policy.isEventVisible(profileId, firstRenewal), true);
    value.setNow(7_000);
    value.engine.delete({ profileId, id: renewed.id, reason: "forgotten",
      operationId: "second-forget" });
    assert.equal(policy.isEventVisible(profileId, firstRenewal), false);
    assert.equal(policy.isEventVisible(profileId, secondRenewal), false);
    value.setNow(8_001);
    value.engine.propose({ profileId, scope: "user", type: "semantic",
      content: initial.content, sourceRefs: [secondRenewal.id, secondRenewal.runId],
      classification: "explicit" });
    assert.equal(policy.isEventVisible(profileId, original), false);
    assert.equal(policy.isEventVisible(profileId, firstRenewal), false);
    assert.equal(policy.isEventVisible(profileId, secondRenewal), true);
  } finally { value.cleanup(); }
});

test("restoring a legacy event-only source invalidates derived same-Run suppression", () => {
  const value = memoryFixture();
  try {
    const item = note(value, ["legacy-event-only"]);
    const policy = value.engine.recallPolicy;
    let sourceEvents = [];
    let transcriptRevision = 0;
    let scans = 0;
    policy.strictSourceResolution = true;
    policy.chatSessionStore = {
      getRevision: () => 1,
      listSessions: () => [{ profileId, id: "restored-session" }],
    };
    policy.transcriptStore = {
      getChangeRevision: () => transcriptRevision,
      listEvents: () => { scans++; return sourceEvents; },
    };
    value.engine.delete({ profileId, id: item.id, reason: "forgotten",
      operationId: "forget-legacy-source-before-restore" });
    const echo = { id: "legacy-echo", runId: "legacy-run", kind: "assistant",
      occurredAt: 1_000, content: { text: "好的，之前提到的安排已收到" } };
    assert.equal(policy.isEventVisible(profileId, echo), true,
      "without the source event its Run cannot yet be identified");
    const initialScans = scans;
    assert.equal(policy.isEventVisible(profileId, echo), true);
    assert.equal(scans, initialScans, "unchanged source revisions reuse the derivation");

    sourceEvents = [{ id: "legacy-event-only", runId: "legacy-run", kind: "user",
      occurredAt: 900, content: { text: "请记住蓝色番茄计划" } }];
    transcriptRevision++;
    assert.equal(policy.isEventVisible(profileId, echo), false,
      "the same-Run assistant echo must be hidden as soon as the source returns");
    assert.ok(scans > initialScans);
  } finally { value.cleanup(); }
});

test("forget resolves an excluded long source before suppressing an older full-body copy", () => {
  const value = memoryFixture();
  try {
    const item = note(value, ["long-source", "long-run"]);
    const policy = value.engine.recallPolicy;
    const fullText = "请记住蓝色番茄计划，这段正文在 journal 摘要之后";
    const source = { id: "long-source", runId: "long-run", kind: "user", occurredAt: 1_000,
      contextExcluded: true, content: { text: "请记住蓝色", contextRef: { version: 1 } } };
    policy.strictSourceResolution = true;
    policy.chatSessionStore = { listSessions: () => [
      { profileId, id: "long-session" }, { profileId, id: "copy-session" },
    ] };
    policy.transcriptStore = {
      listEvents: (_profileId, sessionId) => sessionId === "long-session" ? [source] : [],
      contextEvent: (_profileId, _sessionId, input) => {
        assert.equal(input.contextExcluded, false);
        return { ...input, content: { text: fullText } };
      },
    };
    value.setNow(5_000);
    value.engine.delete({ profileId, id: item.id, reason: "forgotten",
      operationId: "forget-long-source" });
    assert.equal(policy.isEventVisible(profileId, { id: "old-full-copy", runId: "copy-run",
      kind: "user", occurredAt: 2_000, content: { text: fullText } }), false);
  } finally { value.cleanup(); }
});

test("forgetting one claim hides active siblings from the same source", () => {
  const value = memoryFixture();
  try {
    const first = note(value, ["shared-event", "shared-run"]);
    const sibling = value.engine.propose({ profileId, scope: "user", type: "semantic",
      content: "蓝色番茄计划喜欢鱼", sourceRefs: ["shared-event", "shared-run"],
      classification: "explicit" });
    assert.equal(value.engine.search({ profileId, query: "喜欢鱼" }).items.length, 1);
    value.engine.delete({ profileId, id: first.id, reason: "forgotten",
      operationId: "forget-shared-source" });
    assert.equal(value.store.get(profileId, sibling.id).status, "active");
    assert.equal(value.engine.recallPolicy.isMemoryVisible(profileId, sibling), false);
    assert.equal(value.engine.search({ profileId, query: "喜欢鱼" }).items.length, 0);
    restart(value);
    assert.equal(value.engine.recallPolicy.isMemoryVisible(profileId, sibling), false);
    assert.equal(value.engine.search({ profileId, query: "喜欢鱼" }).items.length, 0);
  } finally { value.cleanup(); }
});

test("forgetting a fact hides older identical claims across sources and scopes", () => {
  const value = memoryFixture();
  try {
    const first = note(value, ["event-a", "run-a"]);
    const copy = value.engine.propose({ profileId, scope: "agent", type: "semantic",
      content: "用户要求记住蓝色番茄计划", sourceRefs: ["event-b", "run-b"],
      classification: "explicit" });
    assert.equal(value.engine.search({ profileId, query: "蓝色番茄" }).items.length, 2);
    value.engine.delete({ profileId, id: first.id, reason: "forgotten",
      operationId: "forget-cross-source-copy" });
    assert.equal(value.store.get(profileId, copy.id).status, "active");
    assert.equal(value.engine.recallPolicy.isMemoryVisible(profileId, copy), false);
    assert.equal(value.engine.search({ profileId, query: "蓝色番茄" }).items.length, 0);
    restart(value);
    assert.equal(value.engine.recallPolicy.isMemoryVisible(profileId, copy), false);
    assert.equal(value.engine.search({ profileId, query: "蓝色番茄" }).items.length, 0);
  } finally { value.cleanup(); }
});

test("fresh user event or UI create reauthorizes exact text; old source and import do not", () => {
  const value = memoryFixture();
  try {
    const first = note(value, ["event-a", "run-a"]);
    const oldSource = value.engine.propose({ profileId, scope: "agent", type: "semantic",
      content: "初始不同内容", sourceRefs: ["event-old", "run-old"],
      classification: "explicit" });
    value.engine.delete({ profileId, id: first.id, reason: "forgotten",
      operationId: "forget-before-reauthorize" });
    const policy = value.engine.recallPolicy;
    policy.strictSourceResolution = true;
    policy.chatSessionStore = { listSessions: () => [{ profileId, id: "session-new" }] };
    policy.transcriptStore = { listEvents: () => [
      { id: "event-old", runId: "run-old", kind: "user", occurredAt: 500 },
      { id: "event-new", runId: "run-new", kind: "user", occurredAt: 10_000 },
    ] };
    const current = value.engine.propose({ profileId, scope: "user", type: "semantic",
      content: first.content, sourceRefs: ["event-new", "run-new"],
      classification: "explicit" });
    const ui = value.engine.propose({ profileId, scope: "workspace", type: "semantic",
      content: first.content, sourceRefs: ["user-edit:new-item", "workspace:test"],
      classification: "explicit" });
    assert.equal(policy.isMemoryVisible(profileId, current), true);
    assert.equal(policy.isMemoryVisible(profileId, ui), true);
    // Editing an old item in place changes its content revision, but its
    // original creation and source remain older than the forget operation.
    const stale = value.store.upsert({ ...oldSource, content: first.content,
      updatedAt: oldSource.updatedAt + 100 });
    assert.equal(policy.isMemoryVisible(profileId, stale), false);
    const imported = value.store.upsert({ ...current, id: "imported-late-copy",
      sourceRefs: ["codex-memory:old-file"], createdAt: 10_001, updatedAt: 10_001 });
    assert.equal(policy.isMemoryVisible(profileId, imported), false);
    assert.deepEqual(new Set(value.engine.search({ profileId, query: "蓝色番茄" }).items.map((item) => item.id)),
      new Set([current.id, ui.id]));
    restart(value);
    assert.equal(policy.isMemoryVisible(profileId, current), true);
    assert.equal(policy.isMemoryVisible(profileId, ui), true);
    assert.equal(policy.isMemoryVisible(profileId, stale), false);
    assert.equal(policy.isMemoryVisible(profileId, imported), false);
  } finally { value.cleanup(); }
});

test("derived-index invalidation failure is reported while revocation remains effective", () => {
  const value = memoryFixture();
  try {
    const item = note(value);
    const policy = value.engine.recallPolicy;
    policy.setOnChange(() => { throw new Error("injected SQLite cleanup failure"); });
    value.engine.delete({ profileId, id: item.id, reason: "forgotten", operationId: "forget-index" });
    assert.equal(policy.getStatus(profileId).indexPending, true);
    assert.equal(policy.isEventVisible(profileId, event()), false);
    policy.setOnChange(() => {});
    const another = note(value, ["other-event", "other-run"]);
    value.engine.delete({ profileId, id: another.id, reason: "forgotten", operationId: "forget-index-retry" });
    assert.equal(policy.getStatus(profileId).indexPending, false);
  } finally { value.cleanup(); }
});

test("forgetting an edited revision atomically revokes its original source chain", () => {
  const value = memoryFixture();
  try {
    const original = note(value);
    const edited = value.engine.propose({ profileId, scope: "user", type: "semantic",
      content: "用户要求记住紫色番茄计划", sourceRefs: ["user-edit:revision-2"],
      supersedes: original.id, classification: "explicit" });
    assert.equal(value.store.get(profileId, original.id).status, "superseded");
    value.engine.delete({ profileId, id: edited.id, reason: "user_deleted", operationId: "forget-edited" });
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId, event()), false);
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId,
      event("later-edit-echo", "other-run", "用户要求记住紫色番茄计划")), false);
    assert.equal(value.store.get(profileId, original.id).status, "deleted");
    assert.equal(value.store.get(profileId, edited.id).status, "deleted");
    restart(value);
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId, event()), false);
  } finally { value.cleanup(); }
});

test("interrupted lineage deletion replays every revision on restart", () => {
  const value = memoryFixture();
  try {
    const original = note(value);
    const edited = value.engine.propose({ profileId, scope: "user", type: "semantic",
      content: "用户要求记住紫色番茄计划", sourceRefs: ["user-edit:revision-crash"],
      supersedes: original.id, classification: "explicit" });
    const originalUpsertMany = value.store.upsertMany.bind(value.store);
    value.store.upsertMany = () => { throw new Error("injected lineage deletion crash"); };
    assert.throws(() => value.engine.delete({ profileId, id: edited.id,
      reason: "user_deleted", operationId: "forget-lineage-crash" }), /lineage deletion crash/u);
    value.store.upsertMany = originalUpsertMany;
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId, event()), false);
    restart(value);
    assert.equal(value.store.get(profileId, original.id).status, "deleted");
    assert.equal(value.store.get(profileId, edited.id).status, "deleted");
  } finally { value.cleanup(); }
});

test("lost or corrupted installed ledger blocks all Agent memory reads", () => {
  for (const kind of ["missing", "corrupt", "truncated", "missing-seal", "missing-installation"]) {
    const value = memoryFixture();
    try {
      note(value);
      const dir = path.join(value.paths.agentsDir, profileId, "memory");
      value.close();
      if (kind === "missing") fs.unlinkSync(path.join(dir, "recall-policy.jsonl"));
      if (kind === "corrupt") {
        const file = path.join(dir, "recall-policy.jsonl");
        fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("recall.init", "recall.evil"), { mode: 0o600 });
      }
      if (kind === "truncated") fs.appendFileSync(path.join(dir, "recall-policy.jsonl"), "{");
      if (kind === "missing-seal") fs.unlinkSync(path.join(dir, "recall-policy.seal.json"));
      if (kind === "missing-installation") fs.unlinkSync(path.join(value.paths.agentsDir,
        ".recall-policy-installations", `${profileId}.json`));
      value.definitions.open(); value.store.open();
      value.engine.open([profileId]);
      assert.equal(value.engine.recallPolicy.opened, true);
      assert.throws(() => value.engine.search({ profileId, query: "蓝色番茄" }),
        (error) => error.code === "RECALL_POLICY_UNAVAILABLE", kind);
    } finally { value.cleanup(); }
  }
});

test("context compilation omits revoked history and no-source exact content", () => {
  const value = contextFixture();
  try {
    const item = value.memoryEngine.propose({ profileId, scope: "user", type: "semantic",
      content: "用户要求记住蓝色番茄计划", sourceRefs: ["old-user", "old-run"], classification: "explicit" });
    value.append({ id: "old-user", runId: "old-run", kind: "user", content: { text: "请记住蓝色番茄计划" } });
    value.append({ id: "old-echo", runId: "old-run", kind: "assistant", content: { text: "已记住蓝色番茄计划" } });
    value.append({ id: "current-user", runId: "run-1", kind: "user", content: { text: "现在处理别的事情" } });
    value.memoryEngine.delete({ profileId, id: item.id, reason: "forgotten", operationId: "forget-context" });
    const compiled = value.compiler.compile({ profile: value.profile, run: value.run,
      transcriptSessionId: value.transcriptSessionId, query: "蓝色番茄" });
    assert.doesNotMatch(compiled.dynamicContext, /蓝色番茄/u);
    const noRef = value.memoryEngine.propose({ profileId, scope: "agent", type: "semantic",
      content: "另一条无来源的私有事实", sourceRefs: ["user-edit:manual"], classification: "explicit" });
    value.memoryEngine.delete({ profileId, id: noRef.id, reason: "user_deleted", operationId: "forget-no-ref" });
    assert.equal(value.memoryEngine.recallPolicy.isEventVisible(profileId,
      event("later-echo", "later-run", "请保存：另一条无来源的私有事实。")), false);
  } finally { value.cleanup(); }
});

test("upgrade backup classifies journal, seal and independent install marker as memory", () => {
  const value = memoryFixture();
  try {
    const item = note(value);
    value.engine.delete({ profileId, id: item.id, reason: "forgotten", operationId: "backup-forget" });
    const snapshot = createUpgradeSnapshot({ paths: value.paths, generationId: "recall-policy-test" });
    const files = snapshot.manifest.components.memory.files.map((entry) => entry.path);
    assert.ok(files.some((file) => file.endsWith("/memory/recall-policy.jsonl")));
    assert.ok(files.some((file) => file.endsWith("/memory/recall-policy.seal.json")));
    assert.ok(files.some((file) => file.endsWith("/recall-policy-installed.json")));
    assert.ok(files.includes(`agents/.recall-policy-installations/${profileId}.json`));
    const destinationStateDir = path.join(value.root, "restored-state");
    restoreAuthorityBackup({ paths: value.paths, backupId: snapshot.manifest.backupId, destinationStateDir });
    for (const name of ["memory/recall-policy.jsonl", "memory/recall-policy.seal.json",
      "recall-policy-installed.json"]) {
      assert.equal(fs.readFileSync(path.join(destinationStateDir, "agents", profileId, name), "utf8"),
        fs.readFileSync(path.join(value.paths.agentsDir, profileId, name), "utf8"));
    }
    assert.equal(fs.readFileSync(path.join(destinationStateDir, "agents",
      ".recall-policy-installations", `${profileId}.json`), "utf8"),
    fs.readFileSync(path.join(value.paths.agentsDir, ".recall-policy-installations",
      `${profileId}.json`), "utf8"));
    const restoredPaths = resolveServicePaths({ stateRoot: destinationStateDir,
      profileRoot: path.join(value.root, "restored-profile"),
      cacheRoot: path.join(value.root, "restored-cache"), trustedRoot: value.root });
    const restoredStore = new MemoryStore({ paths: restoredPaths });
    restoredStore.open();
    const restoredEngine = new MemoryEngine({ store: restoredStore });
    try {
      restoredEngine.open([profileId]);
      assert.equal(restoredEngine.recallPolicy.isEventVisible(profileId, event()), false);
      assert.equal(restoredEngine.search({ profileId, query: "蓝色番茄" }).items.length, 0);
    } finally { restoredEngine.close(); restoredStore.close(); }
  } finally { value.cleanup(); }
});

test("restoring a pre-forget backup overlays the newer same-machine recall ledger", () => {
  const value = memoryFixture();
  try {
    const item = note(value);
    const sibling = value.engine.propose({ profileId, scope: "user", type: "semantic",
      content: "蓝色番茄是本周的排期代号", sourceRefs: [...item.sourceRefs],
      classification: "explicit" });
    const anchorRelative = path.join("agents", profileId, "conversation-checkpoints",
      `${"a".repeat(64)}.native-memory-anchor.json`);
    const sourceAnchor = path.join(value.paths.stateDir, anchorRelative);
    fs.mkdirSync(path.dirname(sourceAnchor), { recursive: true, mode: 0o700 });
    fs.writeFileSync(sourceAnchor, '{"fixture":"old-native-session"}\n', { mode: 0o600 });
    const snapshot = createUpgradeSnapshot({ paths: value.paths, generationId: "before-forget-restore" });
    value.engine.delete({ profileId, id: item.id, reason: "forgotten", operationId: "after-backup-forget" });
    assert.equal(value.store.get(profileId, sibling.id).status, "active");
    assert.equal(value.engine.recallPolicy.isMemoryVisible(profileId, sibling), false);
    const sourceJournal = path.join(value.paths.agentsDir, profileId, "memory", "events.jsonl");
    const backupJournal = path.join(snapshot.backupPath, "payload", "agents", profileId,
      "memory", "events.jsonl");
    const sourceBefore = fs.readFileSync(sourceJournal);
    const backupBefore = fs.readFileSync(backupJournal);
    const destinationStateDir = path.join(value.root, "restore-before-forget");
    const receipt = restoreAuthorityBackup({ paths: value.paths,
      backupId: snapshot.manifest.backupId, destinationStateDir });
    assert.deepEqual(receipt.recallRestore.overlaidProfiles.map((entry) => entry.profileId), [profileId]);
    assert.equal(receipt.nativeMemoryAnchorsInvalidated, 1);
    assert.equal(fs.existsSync(path.join(destinationStateDir, anchorRelative)), false);
    assert.equal(fs.existsSync(sourceAnchor), true);
    assert.equal(fs.existsSync(path.join(snapshot.backupPath, "payload", anchorRelative)), true);
    assert.deepEqual(fs.readFileSync(sourceJournal), sourceBefore);
    assert.deepEqual(fs.readFileSync(backupJournal), backupBefore);
    const restoredPaths = resolveServicePaths({ stateRoot: destinationStateDir,
      profileRoot: path.join(value.root, "restore-profile"),
      cacheRoot: path.join(value.root, "restore-cache"), trustedRoot: value.root });
    const restoredStore = new MemoryStore({ paths: restoredPaths });
    restoredStore.open();
    assert.equal(restoredStore.get(profileId, item.id).status, "deleted",
      "a restored primary journal must already hide forgotten memory from an older App");
    assert.equal(restoredStore.get(profileId, sibling.id).status, "deleted",
      "a sibling hidden by shared source must also be deleted before an older App opens");
    const restoredEngine = new MemoryEngine({ store: restoredStore });
    try {
      restoredEngine.open([profileId]);
      assert.equal(restoredStore.get(profileId, item.id).status, "deleted");
      assert.equal(restoredEngine.recallPolicy.isEventVisible(profileId, event()), false);
      assert.equal(restoredEngine.search({ profileId, query: "蓝色番茄" }).items.length, 0);
    } finally { restoredEngine.close(); restoredStore.close(); }
  } finally { value.cleanup(); }
});

test("failure while overlaying the current recall ledger never publishes a stale restore", () => {
  const value = memoryFixture();
  try {
    const item = note(value);
    const snapshot = createUpgradeSnapshot({ paths: value.paths, generationId: "before-overlay-failure" });
    value.engine.delete({ profileId, id: item.id, reason: "forgotten", operationId: "after-backup-failure" });
    const sourceLog = fs.realpathSync(path.join(value.paths.agentsDir, profileId, "memory", "recall-policy.jsonl"));
    const destinationStateDir = path.join(value.root, "failed-restore");
    const originalCopy = fs.copyFileSync;
    fs.copyFileSync = function (source, destination, ...options) {
      if (source === sourceLog) throw new Error("injected recall ledger copy failure");
      return originalCopy.call(this, source, destination, ...options);
    };
    try {
      assert.throws(() => restoreAuthorityBackup({ paths: value.paths,
        backupId: snapshot.manifest.backupId, destinationStateDir }), /injected recall ledger copy failure/u);
    } finally { fs.copyFileSync = originalCopy; }
    assert.equal(fs.existsSync(destinationStateDir), false);
    assert.equal(value.engine.recallPolicy.isEventVisible(profileId, event()), false);
  } finally { value.cleanup(); }
});

test("restore refuses an old App deletion present only in the current primary journal", () => {
  const value = memoryFixture();
  try {
    const item = note(value);
    const snapshot = createUpgradeSnapshot({ paths: value.paths, generationId: "before-old-app-deletion" });
    value.engine.close();
    value.store.upsert({ ...item, status: "deleted", updatedAt: item.updatedAt + 1 });
    value.store.close();
    const destinationStateDir = path.join(value.root, "restore-old-app-deletion");
    assert.throws(() => restoreAuthorityBackup({ paths: value.paths,
      backupId: snapshot.manifest.backupId, destinationStateDir }),
    (error) => error.code === "BACKUP_RECALL_POLICY_UNCOVERED_DELETION");
    assert.equal(fs.existsSync(destinationStateDir), false);
  } finally { value.cleanup(); }
});

test("restore refuses a source ref carried only by an old backup after old App deletion", () => {
  const value = memoryFixture();
  try {
    const item = note(value, ["event-a", "run-a"]);
    const memoryDir = path.join(value.paths.agentsDir, profileId, "memory");
    const journal = path.join(memoryDir, "events.jsonl");
    const snapshotFile = path.join(memoryDir, "snapshot.json");
    const oldJournal = fs.readFileSync(journal);
    const oldSnapshot = fs.readFileSync(snapshotFile);
    value.engine.update({ profileId, id: item.id, sourceRef: "event-b" });
    const snapshot = createUpgradeSnapshot({ paths: value.paths,
      generationId: "before-old-app-source-rollback" });
    value.close();
    fs.writeFileSync(journal, oldJournal, { mode: 0o600 });
    fs.writeFileSync(snapshotFile, oldSnapshot, { mode: 0o600 });
    value.store.open();
    value.store.upsert({ ...item, status: "deleted", updatedAt: item.updatedAt + 100 });
    value.store.close();
    value.definitions.open(); value.store.open(); value.engine.open([profileId]);
    assert.equal(value.engine.recallPolicy.getMemoryReason(profileId,
      value.store.get(profileId, item.id)), "legacy_unknown");
    value.close();
    const destinationStateDir = path.join(value.root, "restore-extra-source");
    assert.throws(() => restoreAuthorityBackup({ paths: value.paths,
      backupId: snapshot.manifest.backupId, destinationStateDir }),
    (error) => error.code === "BACKUP_RECALL_POLICY_UNCOVERED_SOURCE");
    assert.equal(fs.existsSync(destinationStateDir), false);
  } finally { value.cleanup(); }
});

test("restore refuses to widen an active memory's expiry window", () => {
  const value = memoryFixture();
  try {
    const item = note(value);
    const snapshot = createUpgradeSnapshot({ paths: value.paths,
      generationId: "before-memory-expiry-shortened" });
    const validUntil = item.validFrom + 100;
    value.engine.update({ profileId, id: item.id, validUntil });
    value.setNow(validUntil + 1);
    assert.equal(value.engine.search({ profileId, query: "蓝色番茄" }).items.length, 0);
    value.close();
    const destinationStateDir = path.join(value.root, "restore-expiry-widened");
    assert.throws(() => restoreAuthorityBackup({ paths: value.paths,
      backupId: snapshot.manifest.backupId, destinationStateDir }),
    (error) => error.code === "BACKUP_MEMORY_DIVERGED");
    assert.equal(fs.existsSync(destinationStateDir), false);
  } finally { value.cleanup(); }
});

test("restore refuses to activate a currently quarantined candidate", () => {
  const value = memoryFixture();
  try {
    const item = note(value);
    const snapshot = createUpgradeSnapshot({ paths: value.paths,
      generationId: "before-candidate-quarantine" });
    value.engine.close();
    value.store.upsert({ ...item, status: "candidate", updatedAt: item.updatedAt + 1 });
    value.store.close();
    const destinationStateDir = path.join(value.root, "restore-quarantined-candidate");
    assert.throws(() => restoreAuthorityBackup({ paths: value.paths,
      backupId: snapshot.manifest.backupId, destinationStateDir }),
    (error) => error.code === "BACKUP_MEMORY_DIVERGED");
    assert.equal(fs.existsSync(destinationStateDir), false);
  } finally { value.cleanup(); }
});

test("failed staging reconciliation never publishes an older active version", () => {
  const value = memoryFixture();
  try {
    const item = note(value);
    const snapshot = createUpgradeSnapshot({ paths: value.paths,
      generationId: "before-conflicting-forget" });
    value.engine.close();
    value.store.upsert({ ...item, content: "用户更正为红色番茄计划",
      updatedAt: item.updatedAt + 100 });
    value.store.close();
    value.store.open(); value.engine.open([profileId]);
    value.engine.delete({ profileId, id: item.id, reason: "forgotten" });
    const sourceJournal = path.join(value.paths.agentsDir, profileId, "memory", "events.jsonl");
    const sourceBytes = fs.readFileSync(sourceJournal);
    value.close();
    const destinationStateDir = path.join(value.root, "restore-conflicting-version");
    assert.throws(() => restoreAuthorityBackup({ paths: value.paths,
      backupId: snapshot.manifest.backupId, destinationStateDir }),
    (error) => error.code === "RECALL_POLICY_UNAVAILABLE");
    assert.equal(fs.existsSync(destinationStateDir), false);
    assert.equal(fs.existsSync(snapshot.backupPath), true);
    assert.deepEqual(fs.readFileSync(sourceJournal), sourceBytes);
  } finally { value.cleanup(); }
});

test("restore refuses a pre-correction snapshot that would reactivate a superseded claim", () => {
  const value = memoryFixture();
  try {
    const item = note(value);
    const snapshot = createUpgradeSnapshot({ paths: value.paths, generationId: "before-memory-correction" });
    value.engine.propose({ profileId, scope: "user", type: "semantic",
      content: "用户已更正：计划使用红色番茄", sourceRefs: ["event-correction", "run-correction"],
      classification: "explicit", supersedes: item.id });
    const destinationStateDir = path.join(value.root, "restore-before-correction");
    assert.throws(() => restoreAuthorityBackup({ paths: value.paths,
      backupId: snapshot.manifest.backupId, destinationStateDir }),
    (error) => error.code === "BACKUP_MEMORY_DIVERGED");
    assert.equal(fs.existsSync(destinationStateDir), false);
  } finally { value.cleanup(); }
});

test("memory tools admit only chat-origin Inspiration, never growth or card runs", () => {
  const value = contextFixture();
  try {
    const run = { id: "inspiration-run", source: "inspiration", sourceId: "idea-1",
      profileId, workspace: value.run.workspace };
    value.append({ id: "inspiration-user", runId: run.id, kind: "user", content: { text: "保存这条偏好" } });
    const options = { memoryEngine: value.memoryEngine, memoryStore: value.memoryStore,
      transcriptStore: value.transcripts, getRunSessionKey: () => "inspiration-session-key",
      chatSessionStore: { getSession: () => ({ id: value.transcriptSessionId,
        sessionKey: "inspiration-session-key", profileId, workspace: run.workspace }) } };
    const service = new ConversationMemoryService({ ...options, getInspirationOrigin: () => ({
      runId: run.id, profileId, workspace: run.workspace, ideaId: run.sourceId, inputSource: "chat",
    }) });
    assert.equal(service.bind("memory_search", { query: "偏好" }, run).source.eventId, "inspiration-user");
    for (const inputSource of ["growth", "card", null]) {
      const denied = new ConversationMemoryService({ ...options,
        getInspirationOrigin: () => ({ runId: run.id, profileId, workspace: run.workspace,
          ideaId: run.sourceId, inputSource }) });
      assert.throws(() => denied.bind("memory_search", { query: "偏好" }, run),
        (error) => error.code === "MCP_TOOL_FORBIDDEN");
    }
  } finally { value.cleanup(); }
});
