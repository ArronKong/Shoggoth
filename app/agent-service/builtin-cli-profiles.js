"use strict";

const { serviceError } = require("./security");
const { isRuntimeAvailable } = require("../runtime-availability");

const BUILTIN_CLI_AGENT_PROFILES = Object.freeze([
  Object.freeze({
    id: "2c0d5a3e-7b91-4a6f-9d42-0d3a8c5f1e72",
    backendId: "codex",
    agentId: "shoggoth-codex",
    name: "Codex",
    runtime: "codex",
    runtimeProfileId: "shoggoth-codex-cli-v1",
  }),
  Object.freeze({
    id: "7a4b9c2d-1e63-4f85-a0b7-6c2d9e4f8a31",
    backendId: "grok-build",
    agentId: "shoggoth-grok",
    name: "Grok",
    runtime: "grok-build",
    runtimeProfileId: "shoggoth-grok-build-v1",
  }),
  Object.freeze({
    id: "b8fd5c6a-397e-4e2d-9c81-6af43d2e7501",
    backendId: "antigravity",
    agentId: "shoggoth-antigravity",
    name: "Antigravity",
    runtime: "antigravity",
    runtimeProfileId: "shoggoth-antigravity-cli-v1",
  }),
  Object.freeze({
    id: "d34e8f72-6a91-4c5b-b207-9f3a1e6d8c44",
    backendId: "pi",
    agentId: "shoggoth-pi",
    name: "Pi",
    runtime: "pi",
    runtimeProfileId: "shoggoth-pi-cli-v1",
  }),
  Object.freeze({
    id: "4e1c7a92-8b35-4d60-a4f1-2c9e7b5d8306",
    backendId: "claude-code",
    agentId: "shoggoth-claude-code",
    name: "Claude Code",
    runtime: "claude-code",
    runtimeProfileId: "shoggoth-claude-code-cli-v1",
  }),
  Object.freeze({
    id: "6f2b8d41-93c7-4e5a-b168-7d4c2f9a305e",
    backendId: "deepseek-harness",
    agentId: "shoggoth-deepseek-harness",
    name: "DeepSeek Harness",
    runtime: "deepseek-harness",
    runtimeProfileId: "shoggoth-deepseek-harness-v1",
  }),
]);
function identityMatches(profile, spec) {
  return profile.id === spec.id
    && profile.backendId === spec.backendId
    && profile.agentId === spec.agentId
    && profile.runtime === spec.runtime
    && profile.runtimeProfileId === spec.runtimeProfileId
    && profile.isDefault === false;
}

function createProfile(spec) {
  return {
    ...spec,
    providerRef: null,
    defaultModel: null,
    defaultCwd: null,
    permissionPolicy: {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    },
    concurrency: { maxActive: 1, maxWorkspaceWrites: 1 },
    isDefault: false,
    enabled: true,
    createdAt: null,
    updatedAt: null,
  };
}

function ensureBuiltinCliAgentProfiles(productStore) {
  if (!productStore || typeof productStore.getAgentProfile !== "function"
    || typeof productStore.listAgentProfiles !== "function"
    || typeof productStore.putAgentProfile !== "function") {
    throw new TypeError("ProductStore must provide profile listing, lookup, and mutation");
  }
  // Preflight every fixed identity before writing any profile. A conflict in a
  // later built-in must not leave an earlier one partially bootstrapped.
  const profiles = productStore.listAgentProfiles();
  for (const spec of BUILTIN_CLI_AGENT_PROFILES) {
    const existing = productStore.getAgentProfile(spec.id);
    if (existing) {
      if (!identityMatches(existing, spec)) {
        throw serviceError(
          "BUILTIN_AGENT_PROFILE_CONFLICT",
          `Built-in Agent profile identity conflicts with persisted state: ${spec.name}`,
        );
      }
    }
    const occupied = profiles.find((profile) => profile.id !== spec.id
      && (profile.agentId === spec.agentId
        || (profile.runtime === spec.runtime
          && profile.runtimeProfileId === spec.runtimeProfileId)));
    if (occupied) {
      throw serviceError(
        "BUILTIN_AGENT_PROFILE_CONFLICT",
        `Built-in Agent profile identity is already occupied: ${spec.name}`,
      );
    }
  }
  const created = [];
  for (const spec of BUILTIN_CLI_AGENT_PROFILES) {
    if (!isRuntimeAvailable(spec.runtime)) continue;
    if (productStore.getAgentProfile(spec.id)) continue;
    created.push(productStore.putAgentProfile(createProfile(spec)));
  }
  return created;
}

module.exports = {
  BUILTIN_CLI_AGENT_PROFILES,
  ensureBuiltinCliAgentProfiles,
};
