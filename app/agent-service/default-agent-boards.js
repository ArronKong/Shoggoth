"use strict";

const { DEFAULT_AGENT_PROFILE_ID } = require("./product-store");

function defaultBoardSlug(profileId) {
  return profileId === DEFAULT_AGENT_PROFILE_ID ? "default" : `agent-${profileId}`;
}

function assertDependencies(productStore, kanbanStore) {
  if (!productStore || typeof productStore.listAgentProfiles !== "function"
    || !kanbanStore || typeof kanbanStore.listBoards !== "function"
    || typeof kanbanStore.createBoard !== "function"
    || typeof kanbanStore.trustedRepairTimestamp !== "function") {
    throw new TypeError("Default Agent boards require ProductStore and NativeKanbanStore");
  }
}

function ensureAgentBoard(productStore, kanbanStore, profileId, options = {}) {
  assertDependencies(productStore, kanbanStore);
  const profile = productStore.listAgentProfiles().find((candidate) => candidate.id === profileId);
  if (!profile || (!profile.enabled && options.includeDisabled !== true)) return null;
  const existing = kanbanStore.listBoards().find((board) => board.profileId === profile.id);
  if (existing) return existing;
  return kanbanStore.createBoard({
    operationId: `bootstrap-default-board-v2:${profile.id}`,
    profileId: profile.id,
    slug: defaultBoardSlug(profile.id),
    name: profile.name,
    description: null,
    createdAt: kanbanStore.trustedRepairTimestamp(),
  });
}

function ensureDefaultAgentBoards(productStore, kanbanStore) {
  assertDependencies(productStore, kanbanStore);
  const boards = kanbanStore.listBoards();
  const created = [];
  for (const profile of productStore.listAgentProfiles()) {
    if (!profile.enabled || boards.some((board) => board.profileId === profile.id)) continue;
    const board = kanbanStore.createBoard({
      operationId: `bootstrap-default-board-v2:${profile.id}`,
      profileId: profile.id,
      slug: defaultBoardSlug(profile.id),
      name: profile.name,
      description: null,
      createdAt: kanbanStore.trustedRepairTimestamp(),
    });
    boards.push(board);
    created.push(board);
  }
  return created;
}

module.exports = { defaultBoardSlug, ensureAgentBoard, ensureDefaultAgentBoards };
