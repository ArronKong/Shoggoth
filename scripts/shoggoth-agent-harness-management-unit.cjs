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
  validateAgentHarnessParams,
  validateAgentHarnessResult,
} = require(path.join(ROOT, "app", "agent-service", "agent-harness-service-protocol.js"));
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { NativeSkillStore } = require(path.join(
  ROOT, "app", "agent-service", "native-skill-store.js",
));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

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

test("Native Skill 管理按 Profile revision 安装、预览、启用并严格校验协议", () => {
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
    assert.equal(listed.items[0].enabled, false);
    validateAgentHarnessResult("harness.skills.list", listed);
    const preview = value.controller.handle("harness.skills.preview", {
      profileId: "profile-1", skillId: "local-review", source: "user", version: "1.0.0",
      cursor: 0, maxBytes: 32 * 1024,
    });
    assert.match(preview.content, /Read evidence/u);
    validateAgentHarnessResult("harness.skills.preview", preview);
    const enabled = value.controller.handle("harness.skills.enable", {
      profileId: "profile-1", skillId: "local-review", source: "user", version: "1.0.0",
      enabled: true, expectedRevision: listed.profileRevision,
    });
    assert.equal(enabled.skill.enabled, true);
    for (const runtime of [
      "codex", "grok-build", "antigravity", "pi", "claude-code", "deepseek-harness",
    ]) {
      assert.equal(fs.existsSync(path.join(value.paths.stateDir, runtime)), false,
        `enabling a Skill must not materialize a ${runtime} Profile Home`);
    }
    validateAgentHarnessResult("harness.skills.enable", enabled);
    assert.throws(() => value.controller.handle("harness.skills.enable", {
      profileId: "profile-1", skillId: "local-review", source: "user", version: "1.0.0",
      enabled: false, expectedRevision: listed.profileRevision,
    }), (error) => error.code === "SKILL_PROFILE_REVISION_CONFLICT");
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
