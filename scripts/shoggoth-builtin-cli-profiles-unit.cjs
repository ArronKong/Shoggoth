"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const {
  BUILTIN_CLI_AGENT_PROFILES,
  ensureBuiltinCliAgentProfiles,
} = require(path.join(ROOT, "app", "agent-service", "builtin-cli-profiles"));

function fixture(initial = []) {
  const profiles = new Map(initial.map((profile) => [profile.id, structuredClone(profile)]));
  const writes = [];
  return {
    profiles,
    writes,
    store: {
      listAgentProfiles() { return [...profiles.values()].map((profile) => structuredClone(profile)); },
      getAgentProfile(id) { return structuredClone(profiles.get(id) || null); },
      putAgentProfile(profile) {
        const saved = { ...structuredClone(profile), createdAt: 1, updatedAt: 1 };
        profiles.set(saved.id, saved);
        writes.push(saved);
        return structuredClone(saved);
      },
    },
  };
}

function test(name, action) {
  try {
    action();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok - ${name}\n${error.stack || error}\n`);
    process.exitCode = 1;
  }
}

test("首次启动幂等补建五个可用 CLI AgentProfile", () => {
  const ctx = fixture();
  const created = ensureBuiltinCliAgentProfiles(ctx.store);
  assert.equal(created.length, 5);
  assert.deepEqual(created.map((profile) => profile.name), [
    "Codex", "Grok", "Antigravity", "Pi", "DeepSeek Harness",
  ]);
  assert.deepEqual(created.map((profile) => profile.runtime), [
    "codex", "grok-build", "antigravity", "pi", "deepseek-harness",
  ]);
  assert.equal(new Set(created.map((profile) => profile.runtimeProfileId)).size, 5);
  assert.deepEqual(created.map((profile) => profile.backendId), [
    "codex", "grok-build", "antigravity", "pi", "deepseek-harness",
  ]);
  assert.equal(created.every((profile) => profile.enabled && !profile.isDefault), true);
  assert.equal(created.every((profile) => profile.permissionPolicy.approvalPolicy === "on-request"
    && profile.permissionPolicy.sandbox === "danger-full-access"), true);
  assert.equal(ensureBuiltinCliAgentProfiles(ctx.store).length, 0);
  assert.equal(ctx.writes.length, 5);
});

test("已存在的内置 Agent 保留用户可变配置", () => {
  const spec = BUILTIN_CLI_AGENT_PROFILES[0];
  const existing = {
    ...spec,
    name: "My Codex",
    providerRef: null,
    defaultModel: "custom-model",
    defaultCwd: "/workspace",
    permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" },
    concurrency: { maxActive: 2, maxWorkspaceWrites: 0 },
    isDefault: false,
    enabled: false,
    createdAt: 1,
    updatedAt: 2,
  };
  const ctx = fixture([existing]);
  ensureBuiltinCliAgentProfiles(ctx.store);
  assert.deepEqual(ctx.profiles.get(spec.id), existing);
  assert.equal(ctx.writes.length, 4,
    "只应补建缺失的 Grok、Antigravity、Pi 与 DeepSeek Harness profile");
});

test("稳定 ID 被不同 runtime 占用时 fail closed", () => {
  const spec = BUILTIN_CLI_AGENT_PROFILES[0];
  const ctx = fixture([{ ...spec, runtime: "grok-build", isDefault: false }]);
  assert.throws(
    () => ensureBuiltinCliAgentProfiles(ctx.store),
    (error) => error?.code === "BUILTIN_AGENT_PROFILE_CONFLICT",
  );
  assert.equal(ctx.writes.length, 0);
});

test("后一个内置 Agent 冲突时不会提前写入前一个缺失 Agent", () => {
  const grok = BUILTIN_CLI_AGENT_PROFILES[1];
  const ctx = fixture([{ ...grok, runtime: "codex", isDefault: false }]);
  assert.throws(
    () => ensureBuiltinCliAgentProfiles(ctx.store),
    (error) => error?.code === "BUILTIN_AGENT_PROFILE_CONFLICT",
  );
  assert.equal(ctx.profiles.has(BUILTIN_CLI_AGENT_PROFILES[0].id), false);
  assert.equal(ctx.writes.length, 0);
});

test("不同 ID 占用内置 agentId 或 Runtime binding 时全量预检零写入", () => {
  const codex = BUILTIN_CLI_AGENT_PROFILES[0];
  const grok = BUILTIN_CLI_AGENT_PROFILES[1];
  const collisions = [
    { ...codex, id: "11111111-1111-4111-8111-111111111111" },
    {
      ...grok,
      id: "22222222-2222-4222-8222-222222222222",
      agentId: "custom-grok-agent",
    },
  ];
  for (const collision of collisions) {
    const ctx = fixture([collision]);
    assert.throws(
      () => ensureBuiltinCliAgentProfiles(ctx.store),
      (error) => error?.code === "BUILTIN_AGENT_PROFILE_CONFLICT",
    );
    assert.equal(ctx.writes.length, 0);
    assert.equal(ctx.profiles.size, 1);
  }
});

test("禁用 Claude 时保留既有 profile 和用户设置且不补建", () => {
  const spec = BUILTIN_CLI_AGENT_PROFILES.find((item) => item.runtime === "claude-code");
  const existing = { ...spec, name: "My Claude", isDefault: false, enabled: true, defaultModel: "saved-model" };
  const ctx = fixture([existing]);
  ensureBuiltinCliAgentProfiles(ctx.store);
  assert.deepEqual(ctx.profiles.get(spec.id), existing);
  assert.ok(ctx.writes.every((item) => item.runtime !== "claude-code"));
});
