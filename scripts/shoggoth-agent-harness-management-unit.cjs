#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { AgentHarnessServiceController } = require(path.join(
  ROOT, "app", "agent-service", "agent-harness-service-controller.js",
));
const {
  mapAgentHarnessError,
  validateAgentHarnessParams,
  validateAgentHarnessResult,
} = require(path.join(ROOT, "app", "agent-service", "agent-harness-service-protocol.js"));
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { MemoryProvenanceStore } = require("../app/agent-service/memory-provenance-store");
const { MemoryProvenanceService } = require("../app/agent-service/memory-provenance-service");
const { NativeSkillStore } = require(path.join(
  ROOT, "app", "agent-service", "native-skill-store.js",
));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("Memory journal uncertain commit maps to actionable public Harness error", () => {
  const error = Object.assign(new Error("private journal path and write failure"), {
    code: "MEMORY_COMMIT_UNCERTAIN",
    cause: new Error("private fsync diagnostics"),
  });
  const mapped = mapAgentHarnessError(error);
  assert.equal(mapped.code, "MEMORY_COMMIT_UNCERTAIN");
  assert.match(mapped.message, /重启 Shoggoth.*核对记忆状态.*不要重试/u);
  assert.equal(JSON.stringify(mapped).includes("private"), false);
});

test("Transcript journal uncertain commit maps to actionable public Harness error", () => {
  const error = Object.assign(new Error("private transcript journal diagnostics"), {
    code: "TRANSCRIPT_COMMIT_UNCERTAIN",
    cause: new Error("private fsync diagnostics"),
  });
  const mapped = mapAgentHarnessError(error);
  assert.equal(mapped.code, "TRANSCRIPT_COMMIT_UNCERTAIN");
  assert.match(mapped.message, /重启 Shoggoth.*核对会话状态.*不要重试/u);
  assert.equal(JSON.stringify(mapped).includes("private"), false);
});

function fixture(options = {}) {
  const value = contextFixture({ transcriptSessionId: "session-1" });
  const profile = { id: "profile-1", backendId: options.backendId || "shoggoth", enabled: true };
  const sessions = [{
    id: "session-1", sessionKey: "11111111-1111-4111-8111-111111111111",
    profileId: "profile-1", title: "Harness", status: "ready", updatedAt: 500,
  }];
  value.definitions.writeGeneratedView({
    profileId: "profile-1", kind: "TOOLS", revision: value.permissions.toolRegistry.revision,
    content: value.permissions.toolRegistry.toolsMarkdown(),
  });
  const builtinRoot = path.join(value.root, "builtins");
  fs.mkdirSync(builtinRoot, { mode: 0o700 });
  const skillStore = new NativeSkillStore({
    paths: value.paths,
    builtinRoot,
    profileExists: (id) => id === profile.id,
    now: () => 500,
  });
  skillStore.open([profile.id]);
  const controller = new AgentHarnessServiceController({
    productStore: { getAgentProfile: (id) => id === profile.id ? structuredClone(profile) : null },
    definitionStore: value.definitions,
    memoryStore: value.memoryStore,
    memoryEngine: value.memoryEngine,
    chatSessionStore: { listSessions: () => structuredClone(sessions) },
    transcriptStore: value.transcripts,
    toolRegistry: value.permissions.toolRegistry,
    permissionEngine: value.permissions,
    skillStore,
    computerUseController: options.computerUseController,
    now: () => 500,
  });
  const originalCleanup = value.cleanup;
  return {
    ...value,
    skillStore,
    controller,
    cleanup() {
      try { skillStore.close(); } catch {}
      originalCleanup();
    },
  };
}

test("Agent Harness 按 Profile 身份路由，不把非 shoggoth backend 的内置 Agent 误判为不存在", () => {
  const value = fixture({ backendId: "codex" });
  try {
    const meta = value.controller.handle("harness.definition.meta", { profileId: "profile-1" });
    assert.equal(meta.current.revision, 1);
  } finally { value.cleanup(); }
});

function createSkillPackage(root) {
  const target = path.join(root, "local-skill");
  fs.mkdirSync(target, { mode: 0o700 });
  fs.writeFileSync(path.join(target, "skill.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: "local-review",
    name: "local-review",
    version: "1.0.0",
    description: "Review local changes.",
    entry: "SKILL.md",
    requiredTools: [],
    requiredRuntimeCapabilities: [],
    sourceCompatibility: ["shoggoth", "codex"],
  })}\n`);
  fs.writeFileSync(path.join(target, "SKILL.md"), "# Local review\n\nRead evidence before answering.\n");
  return target;
}

test("Definition 管理使用 expected revision，派生 USER/TOOLS 只读且 restore 保留历史", () => {
  const value = fixture();
  try {
    const meta = value.controller.handle("harness.definition.meta", { profileId: "profile-1" });
    assert.equal(meta.current.revision, 1);
    assert.equal(meta.files.find((file) => file.kind === "USER").readOnly, true);
    const saved = value.controller.handle("harness.definition.update", {
      profileId: "profile-1", kind: "SOUL", content: "# Soul\n\nPrecise.\n",
      expectedRevision: 1, reason: "unit",
    });
    assert.equal(saved.current.revision, 2);
    assert.throws(() => value.controller.handle("harness.definition.update", {
      profileId: "profile-1", kind: "SOUL", content: "stale",
      expectedRevision: 1, reason: null,
    }), (error) => error.code === "DEFINITION_REVISION_CONFLICT");
    assert.throws(() => value.controller.handle("harness.definition.update", {
      profileId: "profile-1", kind: "USER", content: "second truth",
      expectedRevision: 2, reason: null,
    }), (error) => error.code === "DEFINITION_WRITE_FORBIDDEN");
    const restored = value.controller.handle("harness.definition.restore", {
      profileId: "profile-1", revision: 1, expectedRevision: 2,
    });
    assert.equal(restored.current.revision, 3);
    assert.equal(value.definitions.history("profile-1").length, 3);
  } finally { value.cleanup(); }
});

test("分片 Definition import 先 preview 后一次原子 commit", () => {
  const value = fixture();
  try {
    const operationId = "import-unit";
    const current = value.definitions.export("profile-1");
    for (const kind of ["IDENTITY", "SOUL", "USER", "AGENTS"]) {
      value.controller.handle("harness.definition.import.stage", {
        profileId: "profile-1", operationId, kind,
        content: kind === "IDENTITY" ? "# Imported\n" : current.documents[kind],
        sourceProfileId: "source-profile", sourceRevision: 9,
      });
    }
    const preview = value.controller.handle("harness.definition.import.preview", {
      profileId: "profile-1", operationId,
    });
    assert.equal(preview.changes.find((change) => change.kind === "IDENTITY").changed, true);
    const committed = value.controller.handle("harness.definition.import.commit", {
      profileId: "profile-1", operationId, expectedRevision: 1,
    });
    assert.equal(committed.current.revision, 2);
    assert.equal(value.definitions.get("profile-1").documents.IDENTITY, "# Imported\n");
  } finally { value.cleanup(); }
});

test("Memory/Transcript/Tool mutations 都以实时 revision 防止旧窗口覆盖", () => {
  const value = fixture();
  try {
    const candidate = value.memoryEngine.propose({
      profileId: "profile-1", classification: "explicit", scope: "user", type: "semantic",
      content: "User prefers concise reports", sourceRefs: ["session-1:event-1"], confidence: 0.5,
    });
    let memories = value.controller.handle("harness.memory.list", {
      profileId: "profile-1", status: null, scope: null, cursor: 0, limit: 50,
    });
    assert.equal(memories.items[0].status, "active");
    const confirmed = value.controller.handle("harness.memory.update", {
      profileId: "profile-1", id: candidate.id, expectedRevision: memories.revision, content: "User prefers concise Chinese reports",
    });
    assert.equal(confirmed.item.status, "active");
    assert.throws(() => value.controller.handle("harness.memory.delete", {
      profileId: "profile-1", id: candidate.id, expectedRevision: memories.revision,
    }), (error) => error.code === "MEMORY_REVISION_CONFLICT");

    value.append({ id: "event-1", kind: "user", content: { text: "durable source" } });
    const events = value.controller.handle("harness.transcript.events", {
      profileId: "profile-1", sessionId: "session-1", cursor: 0, limit: 50,
    });
    const changed = value.controller.handle("harness.transcript.context.set", {
      profileId: "profile-1", sessionId: "session-1", eventId: "event-1",
      contextExcluded: true, expectedRevision: events.revision,
    });
    assert.equal(changed.event.contextExcluded, true);
    assert.throws(() => value.controller.handle("harness.transcript.context.set", {
      profileId: "profile-1", sessionId: "session-1", eventId: "event-1",
      contextExcluded: false, expectedRevision: events.revision,
    }), (error) => error.code === "TRANSCRIPT_REVISION_CONFLICT");

    const tools = value.controller.handle("harness.tools.list", { profileId: "profile-1" });
    const target = tools.tools[0];
    const denied = value.controller.handle("harness.tools.permission.set", {
      profileId: "profile-1", toolName: target.name, effect: "deny", expectedRevision: tools.revision,
    });
    assert.equal(denied.tools.find((tool) => tool.name === target.name).effect, "deny");
    assert.throws(() => value.controller.handle("harness.tools.permission.set", {
      profileId: "profile-1", toolName: target.name, effect: "allow", expectedRevision: tools.revision,
    }), (error) => error.code === "TOOL_PERMISSION_REVISION_CONFLICT");
  } finally { value.cleanup(); }
});

test("撤回同源一条记忆后，普通 active 列表隐藏其余同源记忆", () => {
  const value = fixture();
  try {
    const sourceRefs = ["event-1", "run-1"];
    const forgotten = value.memoryEngine.propose({ profileId: "profile-1",
      classification: "explicit", scope: "user", type: "semantic",
      content: "用户每周五复盘", sourceRefs });
    const sibling = value.memoryEngine.propose({ profileId: "profile-1",
      classification: "explicit", scope: "user", type: "semantic",
      content: "用户偏好简短复盘", sourceRefs });
    value.memoryEngine.delete({ profileId: "profile-1", id: forgotten.id, reason: "user_deleted" });
    assert.equal(value.memoryStore.get("profile-1", sibling.id).status, "active");
    assert.equal(value.memoryEngine.recallPolicy.isMemoryVisible("profile-1",
      value.memoryStore.get("profile-1", sibling.id)), false);
    const active = value.controller.handle("harness.memory.list", {
      profileId: "profile-1", status: "active", scope: null, cursor: 0, limit: 50,
    });
    assert.deepEqual(active.items, []);
    const audit = value.controller.handle("harness.memory.list", {
      profileId: "profile-1", status: "deleted", scope: null, cursor: 0, limit: 50,
    });
    assert.equal(audit.items.some((item) => item.id === forgotten.id), true);
  } finally { value.cleanup(); }
});

test("已接受候选遗忘后仍可在用户审计查看原因，缺失审核回执的记录仍隐藏", () => {
  const value = fixture();
  const provenanceStore = new MemoryProvenanceStore({ paths: value.paths });
  provenanceStore.open();
  try {
    const profileId = "profile-1";
    const candidateId = `mc-${"a".repeat(64)}`;
    const memoryId = `reviewed-${candidateId}`;
    const source = { eventId: "event-reviewed", runId: "run-reviewed", workspace: null };
    const item = value.memoryEngine.propose({ profileId, id: memoryId,
      classification: "imported", scope: "user", type: "semantic",
      content: "用户每周五复盘项目", sourceRefs: [source.eventId, source.runId] });
    const list = (status) => value.controller.handle("harness.memory.list", {
      profileId, status, scope: null, cursor: 0, limit: 50,
    });
    assert.equal(list("active").items.some((entry) => entry.id === memoryId), false,
      "a primary-store write without an accepted receipt cannot appear in the memory UI");
    const candidate = { id: candidateId, profileId, status: "accepted",
      acceptedMemoryId: memoryId, content: item.content, scope: item.scope,
      sensitivity: item.sensitivity, source };
    value.memoryEngine.setReviewReceiptStore({ get: () => ({ candidates: { [candidateId]: candidate } }) });
    value.memoryEngine.setReviewSourceVerifier((_profileId, review) =>
      value.memoryEngine.recallPolicy.isSourceVisible(profileId,
        [review.source.eventId, review.source.runId]));
    assert.equal(list("active").items.some((entry) => entry.id === memoryId), true);

    value.controller.memoryProvenanceService = new MemoryProvenanceService({
      store: provenanceStore, memoryStore: value.memoryStore,
      transcriptStore: value.transcripts, chatSessionStore: { listSessions: () => [] },
      recallPolicy: value.memoryEngine.recallPolicy,
    });
    value.memoryEngine.delete({ profileId, id: memoryId, reason: "forgotten" });
    const deleted = value.memoryStore.get(profileId, memoryId);
    assert.equal(value.memoryEngine.isReviewCommitted(profileId, deleted), false,
      "the source must remain unavailable to Agent reads");
    assert.equal(list("active").items.some((entry) => entry.id === memoryId), false);
    assert.equal(list("deleted").items.some((entry) => entry.id === memoryId), true);
    const audit = value.controller.handle("harness.memory.explain", { profileId, id: memoryId });
    assert.equal(audit.item.status, "deleted");
    assert.equal(audit.withdrawalReason, "forgotten");

    const orphanId = `reviewed-mc-${"b".repeat(64)}`;
    value.memoryEngine.propose({ profileId, id: orphanId,
      classification: "imported", scope: "user", type: "semantic",
      content: "用户偏好小段落", sourceRefs: ["event-orphan", "run-orphan"] });
    value.memoryEngine.delete({ profileId, id: orphanId, reason: "user_deleted" });
    assert.equal(list("deleted").items.some((entry) => entry.id === orphanId), false,
      "a deleted primary-store write without a review receipt remains hidden");
    assert.throws(() => value.controller.handle("harness.memory.explain", {
      profileId, id: orphanId,
    }), (error) => error.code === "MEMORY_NOT_FOUND");
  } finally { provenanceStore.close(); value.cleanup(); }
});

test("拒绝任一 Computer Use 工具会立即关闭该 Profile 的活动会话", async () => {
  const closedProfiles = [];
  const value = fixture({
    computerUseController: {
      status: async () => ({
        available: true, driverVersion: "0.22.0", contractVersion: "0.7.0",
        permissions: { accessibility: true, screenRecording: true }, sessions: [],
      }),
      list: () => [],
      closeForProfile: async (profileId) => { closedProfiles.push(profileId); },
    },
  });
  try {
    const tools = value.controller.handle("harness.tools.list", { profileId: "profile-1" });
    const denied = await value.controller.handle("harness.tools.permission.set", {
      profileId: "profile-1", toolName: "computer_click", effect: "deny",
      expectedRevision: tools.revision,
    });
    assert.equal(denied.tools.find((tool) => tool.name === "computer_click").effect, "deny");
    assert.deepEqual(closedProfiles, ["profile-1"]);
  } finally { value.cleanup(); }
});

test("空记忆视图 revision 0 可读取，保存后返回新 revision，设定仍从 revision 1 开始", () => {
  const value = fixture();
  const read = (kind) => validateAgentHarnessResult("harness.definition.read",
    value.controller.handle("harness.definition.read", { profileId: "profile-1", kind, revision: null }));
  try {
    assert.equal(read("MEMORY").revision, 0);
    assert.equal(read("MEMORY").readOnly, true);
    assert.equal(read("TOOLS").revision, value.permissions.toolRegistry.revision);
    assert.equal(read("IDENTITY").revision, 1);
    for (const kind of ["IDENTITY", "SOUL", "AGENTS", "USER"]) {
      assert.throws(() => validateAgentHarnessResult("harness.definition.read", {
        kind, revision: 0, content: "", readOnly: false,
      }), (error) => error.code === "HARNESS_RESPONSE_INVALID");
    }
    assert.throws(() => validateAgentHarnessResult("harness.definition.read", {
      kind: "MEMORY", revision: -1, content: "", readOnly: true,
    }), (error) => error.code === "HARNESS_RESPONSE_INVALID");
    value.memoryEngine.propose({ profileId: "profile-1", classification: "explicit", scope: "user",
      type: "semantic", content: "用户希望被称呼为 Arron", sourceRefs: ["user-request"] });
    const saved = read("MEMORY");
    assert.ok(saved.revision > 0);
    assert.match(saved.content, /Arron/u);
  } finally { value.cleanup(); }
});

test("Harness protocol 严格拒绝未知字段并限制单帧结果", () => {
  assert.deepEqual(validateAgentHarnessParams("harness.memory.list", {
    profileId: "profile-1", status: null, scope: null, cursor: 0, limit: 50,
  }), { profileId: "profile-1", status: null, scope: null, cursor: 0, limit: 50 });
  assert.throws(() => validateAgentHarnessParams("harness.memory.list", {
    profileId: "profile-1", status: null, scope: null, cursor: 0, limit: 50, extra: true,
  }), (error) => error.code === "INVALID_PARAMS");
  assert.deepEqual(validateAgentHarnessParams("harness.memory.candidates.list", {
    profileId: "profile-1", status: "pending", cursor: 0, limit: 16, expectedRevision: null,
  }), { profileId: "profile-1", status: "pending", cursor: 0, limit: 16, expectedRevision: null });
  assert.throws(() => validateAgentHarnessParams("harness.memory.candidates.accept", {
    profileId: "profile-1", candidateId: "mc-1", expectedRevision: 2,
  }), (error) => error.code === "INVALID_PARAMS");
  assert.deepEqual(validateAgentHarnessParams("harness.memory.candidates.acceptMany", {
    profileId: "profile-1", candidateIds: ["mc-1", "mc-2"],
    expectedRevision: 2, expectedMemoryRevision: 4,
  }).candidateIds, ["mc-1", "mc-2"]);
  assert.throws(() => validateAgentHarnessParams("harness.memory.candidates.acceptMany", {
    profileId: "profile-1", candidateIds: ["mc-1", "mc-1"],
    expectedRevision: 2, expectedMemoryRevision: 4,
  }), (error) => error.code === "INVALID_PARAMS");
  assert.deepEqual(validateAgentHarnessResult("harness.memory.candidates.acceptMany", {
    revision: 3, acceptedCandidateIds: ["mc-1", "mc-2"],
    acceptedMemoryIds: ["reviewed-mc-1", "reviewed-mc-2"],
    memoryRevision: 5, viewStatus: { stale: false, revision: 5 },
  }).acceptedCandidateIds, ["mc-1", "mc-2"]);
  assert.throws(() => validateAgentHarnessResult("harness.memory.candidates.acceptMany", {
    revision: 3, acceptedCandidateIds: ["mc-1"], acceptedMemoryIds: [],
    memoryRevision: 5, viewStatus: { stale: false, revision: 5 },
  }), (error) => error.code === "HARNESS_RESPONSE_INVALID");
  assert.throws(() => validateAgentHarnessResult("harness.definition.read", {
    content: "x".repeat(60 * 1024),
  }), (error) => error.code === "HARNESS_RESPONSE_TOO_LARGE");
  assert.throws(() => validateAgentHarnessResult("harness.memory.list", {
    revision: 1, items: [{ id: "forged" }], nextCursor: 1, hasMore: false,
  }), (error) => error.code === "HARNESS_RESPONSE_INVALID");
  assert.throws(() => validateAgentHarnessResult("harness.tools.list", {
    registryRevision: "not-a-revision", revision: 1, tools: [],
  }), (error) => error.code === "HARNESS_RESPONSE_INVALID");
  const unavailableComputer = {
    available: false, reason: "COMPUTER_PERMISSION_STATUS_FAILED", driverVersion: null, contractVersion: null,
    permissions: { accessibility: null, screenRecording: null }, sessions: [],
  };
  assert.deepEqual(validateAgentHarnessResult("harness.computer.status", unavailableComputer), unavailableComputer);
  const { reason, ...ambiguousReady } = unavailableComputer;
  assert.throws(() => validateAgentHarnessResult("harness.computer.status", { ...ambiguousReady, available: true }),
    (error) => error.code === "HARNESS_RESPONSE_INVALID");
});

test("候选审核回执必须对应请求的 Profile、候选 ID 与 reviewed 记忆 ID", () => {
  const profileId = "profile-1";
  const candidateId = "mc-1";
  const source = { sessionId: "session-1", eventId: "event-1", runId: "run-1", seq: 1,
    contentHash: "a".repeat(64), quoteHash: "b".repeat(64),
    quoteStart: 0, quoteLength: 2, workspace: null };
  const candidate = { id: candidateId, profileId, content: "用户偏好简短答复", scope: "user",
    sensitivity: "normal", source, status: "accepted", createdAt: 1, updatedAt: 2,
    acceptedMemoryId: `reviewed-${candidateId}` };
  const memoryItem = { id: `reviewed-${candidateId}`, profileId, scope: "user",
    type: "semantic", content: candidate.content, sourceRefs: [source.eventId, source.runId],
    confidence: 0.5, sensitivity: "normal", status: "active", validFrom: 1,
    validUntil: null, supersedes: null, createdAt: 1, updatedAt: 2 };
  const accepted = { revision: 2, candidate, memoryItem, memoryRevision: 3,
    viewStatus: { stale: false, revision: 3 } };
  const acceptParams = { profileId, candidateId, expectedRevision: 1, expectedMemoryRevision: 1 };
  const check = (method, result, params, valid = true) => {
    if (valid) assert.deepEqual(validateAgentHarnessResult(method, result, params), result);
    else assert.throws(() => validateAgentHarnessResult(method, result, params),
      (error) => error.code === "HARNESS_RESPONSE_INVALID");
  };
  check("harness.memory.candidates.accept", accepted, acceptParams);
  check("harness.memory.candidates.accept", { ...accepted,
    candidate: { ...candidate, id: "mc-other" } }, acceptParams, false);
  check("harness.memory.candidates.accept", { ...accepted,
    candidate: { ...candidate, profileId: "profile-other" } }, acceptParams, false);
  check("harness.memory.candidates.accept", { ...accepted,
    memoryItem: { ...memoryItem, id: "reviewed-mc-other" } }, acceptParams, false);
  check("harness.memory.candidates.accept", { ...accepted,
    memoryItem: { ...memoryItem, status: "candidate" } }, acceptParams, false);
  const rejected = { revision: 2, candidate: { ...candidate,
    status: "rejected", acceptedMemoryId: null } };
  const rejectParams = { profileId, candidateId, expectedRevision: 1 };
  check("harness.memory.candidates.reject", rejected, rejectParams);
  check("harness.memory.candidates.reject", { ...rejected,
    candidate: { ...rejected.candidate, id: "mc-other" } }, rejectParams, false);
  check("harness.memory.candidates.reject", { ...rejected,
    candidate: { ...rejected.candidate, profileId: "profile-other" } }, rejectParams, false);
  const batchParams = { profileId, candidateIds: ["mc-1", "mc-2"],
    expectedRevision: 1, expectedMemoryRevision: 1 };
  const batch = { revision: 2, acceptedCandidateIds: ["mc-1", "mc-2"],
    acceptedMemoryIds: ["reviewed-mc-1", "reviewed-mc-2"], memoryRevision: 3,
    viewStatus: { stale: false, revision: 3 } };
  check("harness.memory.candidates.acceptMany", batch, batchParams);
  check("harness.memory.candidates.acceptMany", { ...batch,
    acceptedCandidateIds: ["mc-2", "mc-1"] }, batchParams, false);
  check("harness.memory.candidates.acceptMany", { ...batch,
    acceptedMemoryIds: ["reviewed-mc-1", "reviewed-mc-other"] }, batchParams, false);
});

test("来源解释不能把缺少原话的响应标成已验证", () => {
  const value = fixture();
  try {
    const item = value.memoryEngine.propose({ profileId: "profile-1", classification: "explicit",
      scope: "user", type: "semantic", content: "用户喜欢中文答复", sourceRefs: ["user-request"] });
    assert.throws(() => validateAgentHarnessResult("harness.memory.explain", {
      item, evidence: { status: "verified_quote", origin: "conversation", memoryRevision: 1,
        sessionId: "session-1", eventId: "event-1" },
    }), (error) => error.code === "HARNESS_RESPONSE_INVALID");
    assert.equal(validateAgentHarnessResult("harness.memory.explain", {
      item, evidence: { status: "legacy_unverified", reason: "no_verified_provenance" },
    }).evidence.status, "legacy_unverified");
  } finally { value.cleanup(); }
});

test("Memory 与 Transcript 管理结果按 cursor 分页且保留稳定 revision", () => {
  const value = fixture();
  try {
    for (let index = 0; index < 3; index += 1) {
      value.memoryEngine.propose({
        profileId: "profile-1", classification: "explicit", scope: "user", type: "semantic",
        content: `Preference ${index}`, sourceRefs: [`session-1:source-${index}`], confidence: 0.5,
      });
      value.append({ id: `event-${index}`, kind: "user", content: { text: `event ${index}` } });
    }
    const memoryFirst = value.controller.handle("harness.memory.list", {
      profileId: "profile-1", status: null, scope: null, cursor: 0, limit: 2,
    });
    const memorySecond = value.controller.handle("harness.memory.list", {
      profileId: "profile-1", status: null, scope: null, cursor: memoryFirst.nextCursor, limit: 2,
    });
    assert.equal(memoryFirst.items.length, 2);
    assert.equal(memoryFirst.hasMore, true);
    assert.equal(memorySecond.items.length, 1);
    assert.equal(memorySecond.revision, memoryFirst.revision);

    const eventFirst = value.controller.handle("harness.transcript.events", {
      profileId: "profile-1", sessionId: "session-1", cursor: 0, limit: 2,
    });
    const eventSecond = value.controller.handle("harness.transcript.events", {
      profileId: "profile-1", sessionId: "session-1", cursor: eventFirst.nextCursor, limit: 2,
    });
    assert.equal(eventFirst.items.length, 2);
    assert.equal(eventFirst.hasMore, true);
    assert.equal(eventSecond.items.length, 1);
    assert.equal(eventSecond.revision, eventFirst.revision);
  } finally { value.cleanup(); }
});

test("Native Skill 管理全局安装、预览、启停并严格校验 registry revision", () => {
  const value = fixture();
  try {
    const sourcePath = createSkillPackage(value.root);
    const installed = value.controller.handle("harness.skills.install", {
      profileId: "profile-1",
      sourcePath,
      operationId: "install-local-review",
      expectedRevision: 1,
    });
    assert.equal(installed.registryRevision, 2);
    validateAgentHarnessResult("harness.skills.install", installed);
    const listed = value.controller.handle("harness.skills.list", {
      profileId: "profile-1", cursor: 0, limit: 50,
    });
    assert.equal(listed.registryVersion, 2);
    assert.equal(listed.items[0].enabled, true);
    assert.equal(listed.items[0].globalEnabled, true);
    validateAgentHarnessResult("harness.skills.list", listed);
    const preview = value.controller.handle("harness.skills.preview", {
      profileId: "profile-1", skillId: "local-review", source: "user", version: "1.0.0",
      cursor: 0, maxBytes: 32 * 1024,
    });
    assert.match(preview.content, /Read evidence/u);
    validateAgentHarnessResult("harness.skills.preview", preview);
    const disabled = value.controller.handle("harness.skills.global.set", {
      profileId: "profile-1", skillId: "local-review", source: "user", version: "1.0.0",
      enabled: false, expectedRevision: listed.registryVersion,
    });
    assert.equal(disabled.skill.enabled, false);
    assert.equal(disabled.registryRevision, 3);
    for (const runtime of [
      "codex", "grok-build", "antigravity", "pi", "claude-code", "deepseek-harness",
    ]) {
      assert.equal(fs.existsSync(path.join(value.paths.stateDir, runtime)), false,
        `changing a global Skill must not materialize a ${runtime} Profile Home`);
    }
    validateAgentHarnessResult("harness.skills.global.set", disabled);
    const enabled = value.controller.handle("harness.skills.global.set", {
      profileId: "profile-1", skillId: "local-review", source: "user", version: "1.0.0",
      enabled: true, expectedRevision: disabled.registryRevision,
    });
    assert.equal(enabled.skill.enabled, true);
    assert.throws(() => value.controller.handle("harness.skills.global.set", {
      profileId: "profile-1", skillId: "local-review", source: "user", version: "1.0.0",
      enabled: false, expectedRevision: listed.registryVersion,
    }), (error) => error.code === "SKILL_REGISTRY_REVISION_CONFLICT");
    assert.throws(() => validateAgentHarnessParams("harness.skills.enable", {
      profileId: "profile-1", skillId: "local-review", source: "user", version: "1.0.0",
      enabled: false, expectedRevision: listed.profileRevision,
    }), (error) => error.code === "INVALID_PARAMS");
    assert.deepEqual(validateAgentHarnessParams("harness.skills.list", {
      profileId: "profile-1", cursor: 0, limit: 50,
    }), { profileId: "profile-1", cursor: 0, limit: 50 });
  } finally { value.cleanup(); }
});

(async () => {
  for (const { name, fn } of tests) {
    await fn();
    console.log(`PASS ${name}`);
  }
  console.log(`PASS shoggoth agent harness management unit (${tests.length})`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
