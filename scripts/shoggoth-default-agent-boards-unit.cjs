"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const { DEFAULT_AGENT_PROFILE_ID } = require(path.join(ROOT, "app", "agent-service", "product-store"));
const {
  defaultBoardSlug,
  ensureAgentBoard,
  ensureDefaultAgentBoards,
} = require(path.join(ROOT, "app", "agent-service", "default-agent-boards"));

function test(name, action) {
  try {
    action();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok - ${name}\n${error.stack || error}\n`);
    process.exitCode = 1;
  }
}

function fixture({ profiles, boards = [] }) {
  const state = boards.map((board) => structuredClone(board));
  const writes = [];
  let clock = 100;
  return {
    state,
    writes,
    productStore: { listAgentProfiles: () => profiles.map((profile) => structuredClone(profile)) },
    kanbanStore: {
      listBoards: () => state.map((board) => structuredClone(board)),
      trustedRepairTimestamp: () => clock++,
      createBoard(input) {
        const saved = { id: `board-${writes.length + 1}`, ...structuredClone(input) };
        state.push(saved);
        writes.push(saved);
        return structuredClone(saved);
      },
    },
  };
}

test("每个启用 Agent 恰好补一个独立默认 Board", () => {
  const codexId = "2c0d5a3e-7b91-4a6f-9d42-0d3a8c5f1e72";
  const ctx = fixture({ profiles: [
    { id: DEFAULT_AGENT_PROFILE_ID, name: "Shoggoth", enabled: true },
    { id: codexId, name: "Codex", enabled: true },
    { id: "disabled", name: "Disabled", enabled: false },
  ] });
  const created = ensureDefaultAgentBoards(ctx.productStore, ctx.kanbanStore);
  assert.equal(created.length, 2);
  assert.deepEqual(created.map((board) => board.profileId), [DEFAULT_AGENT_PROFILE_ID, codexId]);
  assert.deepEqual(created.map((board) => board.slug), ["default", `agent-${codexId}`]);
  assert.equal(new Set(created.map((board) => board.operationId)).size, 2);
  assert.equal(ensureDefaultAgentBoards(ctx.productStore, ctx.kanbanStore).length, 0);
  assert.equal(ctx.writes.length, 2);
});

test("已有任意 Board 的 Agent 保持不变", () => {
  const profile = { id: "profile-a", name: "Renamed", enabled: true };
  const existing = { id: "board-existing", profileId: profile.id, slug: "custom", name: "Custom" };
  const ctx = fixture({ profiles: [profile], boards: [existing] });
  assert.deepEqual(ensureDefaultAgentBoards(ctx.productStore, ctx.kanbanStore), []);
  assert.deepEqual(ctx.state, [existing]);
});

test("生命周期初始化可在 publish enabled 前为目标 Agent 建板", () => {
  const profile = { id: "profile-pending", name: "Pending", enabled: false };
  const ctx = fixture({ profiles: [profile] });
  assert.equal(ensureAgentBoard(ctx.productStore, ctx.kanbanStore, profile.id), null);
  const created = ensureAgentBoard(ctx.productStore, ctx.kanbanStore, profile.id, {
    includeDisabled: true,
  });
  assert.equal(created.profileId, profile.id);
  assert.equal(ensureAgentBoard(ctx.productStore, ctx.kanbanStore, profile.id, {
    includeDisabled: true,
  }).id, created.id);
  assert.equal(ctx.writes.length, 1);
});

test("非默认 Profile 的 slug 由稳定 UUID 隔离", () => {
  assert.equal(defaultBoardSlug(DEFAULT_AGENT_PROFILE_ID), "default");
  assert.equal(defaultBoardSlug("abc"), "agent-abc");
});
