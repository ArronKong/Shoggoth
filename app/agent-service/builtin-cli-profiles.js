"use strict";

const { DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME } = require("./runtime-account");
const { serviceError } = require("./security");
const { isRuntimeAvailable } = require("../runtime-availability");

const BUILTIN_CLI_AGENT_PROFILES = Object.freeze([
  Object.freeze({
    id: "2c0d5a3e-7b91-4a6f-9d42-0d3a8c5f1e72",
    backendId: "shoggoth",
    agentId: "shoggoth-codex",
    name: "Codex",
    runtime: "codex",
    runtimeProfileId: "shoggoth-codex-cli-v1",
  }),
  Object.freeze({
    id: "7a4b9c2d-1e63-4f85-a0b7-6c2d9e4f8a31",
    backendId: "shoggoth",
    agentId: "shoggoth-grok",
    name: "Grok",
    runtime: "grok-build",
    runtimeProfileId: "shoggoth-grok-build-v1",
  }),
  Object.freeze({
    id: "b8fd5c6a-397e-4e2d-9c81-6af43d2e7501",
    backendId: "shoggoth",
    agentId: "shoggoth-antigravity",
    name: "Antigravity",
    runtime: "antigravity",
    runtimeProfileId: "shoggoth-antigravity-cli-v1",
  }),
  Object.freeze({
    id: "d34e8f72-6a91-4c5b-b207-9f3a1e6d8c44",
    backendId: "shoggoth",
    agentId: "shoggoth-pi",
    name: "Pi",
    runtime: "pi",
    runtimeProfileId: "shoggoth-pi-cli-v1",
  }),
  Object.freeze({
    id: "4e1c7a92-8b35-4d60-a4f1-2c9e7b5d8306",
    backendId: "shoggoth",
    agentId: "shoggoth-claude-code",
    name: "Claude Code",
    runtime: "claude-code",
    runtimeProfileId: "shoggoth-claude-code-cli-v1",
  }),
  Object.freeze({
    id: "e7f48b2a-9c51-4d36-8f0e-2b8a71d5c603",
    backendId: "shoggoth",
    agentId: "shoggoth-opencode",
    name: "OpenCode",
    runtime: "opencode",
    runtimeProfileId: "shoggoth-opencode-cli-v1",
  }),
  Object.freeze({
    id: "6f2b8d41-93c7-4e5a-b168-7d4c2f9a305e",
    backendId: "shoggoth",
    agentId: "shoggoth-deepseek-harness",
    name: "DeepSeek",
    runtime: "deepseek-harness",
    runtimeProfileId: "shoggoth-deepseek-harness-v1",
  }),
]);
function identityMatches(profile, spec) {
  return profile.id === spec.id
    && profile.backendId === spec.backendId
    && profile.agentId === spec.agentId
    && (profile.defaultBindingId || (profile.runtime === spec.runtime
      && profile.runtimeProfileId === spec.runtimeProfileId))
    && profile.isDefault === false;
}

function createProfile(spec) {
  return {
    ...spec,
    runtimeAccountId: DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME[spec.runtime],
    providerRef: null,
    defaultModel: null,
    defaultCwd: null,
    permissionPolicy: {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    },
    concurrency: { maxActive: null, maxWorkspaceWrites: null },
    isDefault: false,
    enabled: true,
    createdAt: null,
    updatedAt: null,
  };
}

// Each built-in CLI Agent is created at most once. `state` records the ones
// already created, so an Agent the user deleted is not created again.
function planBuiltinCliAgentProfiles(productStore, installedRuntimeAccountIds, state) {
  if (!productStore || typeof productStore.getAgentProfile !== "function"
    || typeof productStore.listAgentProfiles !== "function"
    || typeof productStore.putAgentProfile !== "function"
    || !(installedRuntimeAccountIds instanceof Set)
    || typeof state?.isSeeded !== "function" || typeof state.markSeeded !== "function") {
    throw new TypeError("ProductStore, installed RuntimeAccount IDs and built-in Agent state are required");
  }
  // Preflight every fixed identity before writing any profile. A conflict in a
  // later built-in must not leave an earlier one partially bootstrapped.
  const profiles = productStore.listAgentProfiles();
  for (const spec of BUILTIN_CLI_AGENT_PROFILES) {
    const existing = productStore.getAgentProfile(spec.id);
    if (!existing && (state.isSeeded(spec.id)
      || !installedRuntimeAccountIds.has(DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME[spec.runtime]))) continue;
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
        || (productStore.getAgentRuntimeBindings
          ? productStore.getAgentRuntimeBindings(profile.id).bindings.some((binding) => binding.runtime === spec.runtime
            && binding.runtimeProfileId === spec.runtimeProfileId)
          : profile.runtime === spec.runtime && profile.runtimeProfileId === spec.runtimeProfileId)));
    if (occupied) {
      throw serviceError(
        "BUILTIN_AGENT_PROFILE_CONFLICT",
        `Built-in Agent profile identity is already occupied: ${spec.name}`,
      );
    }
  }
  // record: existing Agents created before the state knew about them.
  // build: Agents to create now.
  // pending: disabled and unrecorded, so either deleted by the user while the
  // record was missing, or interrupted while being created. Only the caller can
  // tell them apart from the archive retention journal.
  const record = [];
  const build = [];
  const pending = [];
  for (const spec of BUILTIN_CLI_AGENT_PROFILES) {
    if (!isRuntimeAvailable(spec.runtime) || state.isSeeded(spec.id)) continue;
    const existing = productStore.getAgentProfile(spec.id);
    if (existing?.enabled) record.push(spec.id);
    else if (existing) pending.push(spec);
    else if (installedRuntimeAccountIds.has(DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME[spec.runtime])) build.push(spec);
  }
  return { record, build, pending };
}

// Service startup path: later startup steps initialize every enabled Profile.
// Pending Agents wait for the runtime path, which can read archive retention.
function ensureBuiltinCliAgentProfiles(productStore, installedRuntimeAccountIds, state, { beforeCreate } = {}) {
  const { record, build } = planBuiltinCliAgentProfiles(productStore, installedRuntimeAccountIds, state);
  for (const spec of BUILTIN_CLI_AGENT_PROFILES) {
    const existing = isRuntimeAvailable(spec.runtime) ? productStore.getAgentProfile(spec.id) : null;
    if (spec.runtime === "deepseek-harness" && existing?.name === "DeepSeek Harness") {
      productStore.putAgentProfile({ ...existing, name: spec.name });
    }
  }
  const created = build.map((spec) => {
    const profile = createProfile(spec);
    beforeCreate?.(profile);
    return productStore.putAgentProfile(profile);
  });
  state.markSeeded([...record, ...build.map((spec) => spec.id)]);
  return created;
}

module.exports = {
  BUILTIN_CLI_AGENT_PROFILES,
  createBuiltinCliAgentProfile: createProfile,
  ensureBuiltinCliAgentProfiles,
  planBuiltinCliAgentProfiles,
};
