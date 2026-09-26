"use strict";

// OpenClaw 2026.8.1 agent roster/model policy 的纯配置转换。canonical roster
// 只写 agents.entries；agents.list 仅允许通过显式迁移入口读取。

const CANONICAL_AGENT_ID_RE = /^[a-z0-9_][a-z0-9_-]{0,63}$/i;
const LEGACY_AGENT_ID_RE = /^[a-z0-9_][a-z0-9_-]{0,63}$/;

class OpenClawAgentConfigError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "OpenClawAgentConfigError";
    this.code = code;
    this.status = 409;
    this.details = details;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  }
  return value;
}

function configRoot(config) {
  if (!isRecord(config)) {
    throw new OpenClawAgentConfigError("invalid_agent_config", "OpenClaw 配置必须是对象");
  }
  return config;
}

function normalizedCanonicalAgentId(id, { legacy = false } = {}) {
  const valid = typeof id === "string"
    && (legacy ? LEGACY_AGENT_ID_RE : CANONICAL_AGENT_ID_RE).test(id);
  if (!valid) {
    throw new OpenClawAgentConfigError("invalid_agent_id", "agent id 不是 canonical OpenClaw id", { id });
  }
  return id.toLowerCase();
}

function validateEntryConfig(entry, id) {
  if (!isRecord(entry)) {
    throw new OpenClawAgentConfigError("invalid_agent_entry", "agent entry 必须是对象", { id });
  }
  if (Object.hasOwn(entry, "id")) {
    throw new OpenClawAgentConfigError(
      "agent_entry_id_forbidden",
      "canonical agents.entries 的 entry 内不能包含 id",
      { id },
    );
  }
}

function readEntriesRecord(config) {
  const root = configRoot(config);
  if (root.agents === undefined) return null;
  if (!isRecord(root.agents)) {
    throw new OpenClawAgentConfigError("invalid_agents_config", "agents 必须是对象");
  }
  const hasEntries = Object.hasOwn(root.agents, "entries");
  const hasList = Object.hasOwn(root.agents, "list");
  if (hasEntries && hasList) {
    throw new OpenClawAgentConfigError(
      "ambiguous_agent_roster",
      "agents.entries 与 agents.list 不能同时存在",
    );
  }
  if (!hasEntries) {
    if (hasList) {
      throw new OpenClawAgentConfigError(
        "legacy_agent_list_requires_migration",
        "legacy agents.list 必须先显式迁移为 agents.entries",
      );
    }
    return null;
  }
  if (!isRecord(root.agents.entries)) {
    throw new OpenClawAgentConfigError("invalid_agent_entries", "agents.entries 必须是对象");
  }
  if (Object.keys(root.agents.entries).length === 0) {
    throw new OpenClawAgentConfigError("empty_agent_entries", "agents.entries 至少要包含一个 agent");
  }

  const seen = new Map();
  for (const [id, entry] of Object.entries(root.agents.entries)) {
    const normalized = normalizedCanonicalAgentId(id);
    if (seen.has(normalized)) {
      throw new OpenClawAgentConfigError(
        "duplicate_agent_id",
        "agents.entries 包含规范化后重复的 agent id",
        { id, firstId: seen.get(normalized) },
      );
    }
    seen.set(normalized, id);
    validateEntryConfig(entry, id);
  }
  return root.agents.entries;
}

/** 读取 8.1 canonical agents.entries，统一投影为 [{id, ...entry}]。 */
function readCanonicalAgentEntries(config) {
  const entries = readEntriesRecord(config);
  if (!entries) return [];
  return Object.entries(entries).map(([id, entry]) => ({ id, ...clone(entry) }));
}

function entriesRecordFromUnified(entries, { legacy = false } = {}) {
  if (!Array.isArray(entries)) {
    throw new OpenClawAgentConfigError("invalid_agent_entries", "agent entries 必须是数组");
  }
  if (entries.length === 0) {
    throw new OpenClawAgentConfigError("empty_agent_entries", "agent entries 至少要包含一个 agent");
  }
  const seen = new Map();
  const pairs = [];
  for (const entry of entries) {
    if (!isRecord(entry)) {
      throw new OpenClawAgentConfigError("invalid_agent_entry", "agent entry 必须是对象");
    }
    const { id, ...entryConfig } = entry;
    const normalized = normalizedCanonicalAgentId(id, { legacy });
    if (seen.has(normalized)) {
      throw new OpenClawAgentConfigError(
        "duplicate_agent_id",
        "agent entries 包含规范化后重复的 agent id",
        { id, firstId: seen.get(normalized) },
      );
    }
    seen.set(normalized, id);
    pairs.push([id, clone(entryConfig)]);
  }
  return Object.fromEntries(pairs);
}

/** 将统一数组写回 canonical entries；返回新配置且永不保留 agents.list。 */
function writeCanonicalAgentEntries(config, entries) {
  const root = clone(configRoot(config));
  const agents = root.agents === undefined ? {} : root.agents;
  if (!isRecord(agents)) {
    throw new OpenClawAgentConfigError("invalid_agents_config", "agents 必须是对象");
  }
  const { list: _legacyList, ...canonicalAgents } = agents;
  return {
    ...root,
    agents: {
      ...canonicalAgents,
      entries: entriesRecordFromUnified(entries),
    },
  };
}

/** 将 8.1 尚可识别的 legacy list 显式迁移为唯一 canonical entries 输出。 */
function migrateLegacyAgentListToEntries(config) {
  const root = configRoot(config);
  if (!isRecord(root.agents)) {
    throw new OpenClawAgentConfigError("legacy_agent_list_missing", "配置中不存在 legacy agents.list");
  }
  if (Object.hasOwn(root.agents, "entries")) {
    throw new OpenClawAgentConfigError(
      "ambiguous_agent_roster",
      "迁移输入不能同时包含 agents.entries 与 agents.list",
    );
  }
  if (!Object.hasOwn(root.agents, "list") || !Array.isArray(root.agents.list)) {
    throw new OpenClawAgentConfigError("legacy_agent_list_missing", "配置中不存在有效的 legacy agents.list");
  }
  const record = entriesRecordFromUnified(root.agents.list, { legacy: true });
  return writeCanonicalAgentEntries(
    root,
    Object.entries(record).map(([id, entry]) => ({ id, ...entry })),
  );
}

function readPolicyAllow(owner, path) {
  const policy = owner?.modelPolicy;
  if (policy === undefined) return undefined;
  if (!isRecord(policy)) {
    throw new OpenClawAgentConfigError("invalid_model_policy", `${path}.modelPolicy 必须是对象`);
  }
  if (!Object.hasOwn(policy, "allow")) return undefined;
  if (!Array.isArray(policy.allow) || policy.allow.some((ref) => typeof ref !== "string")) {
    throw new OpenClawAgentConfigError(
      "invalid_model_policy_allow",
      `${path}.modelPolicy.allow 必须是字符串数组`,
    );
  }
  return [...policy.allow];
}

function writePolicyAllow(owner, allow, path) {
  if (allow !== undefined
    && (!Array.isArray(allow) || allow.some((ref) => typeof ref !== "string"))) {
    throw new OpenClawAgentConfigError(
      "invalid_model_policy_allow",
      `${path}.modelPolicy.allow 必须是字符串数组或 undefined`,
    );
  }
  if (owner.modelPolicy !== undefined && !isRecord(owner.modelPolicy)) {
    throw new OpenClawAgentConfigError("invalid_model_policy", `${path}.modelPolicy 必须是对象`);
  }
  const policy = { ...(owner.modelPolicy || {}) };
  if (allow === undefined) delete policy.allow;
  else policy.allow = [...allow];
  if (Object.keys(policy).length === 0) delete owner.modelPolicy;
  else owner.modelPolicy = policy;
}

/** 只读显式 agents.defaults.modelPolicy.allow；绝不从 defaults.models 推导。 */
function readDefaultModelPolicyAllow(config) {
  const root = configRoot(config);
  const defaults = root.agents?.defaults;
  if (defaults === undefined) return undefined;
  if (!isRecord(defaults)) {
    throw new OpenClawAgentConfigError("invalid_agent_defaults", "agents.defaults 必须是对象");
  }
  return readPolicyAllow(defaults, "agents.defaults");
}

/** 更新 defaults policy，同时原样保留 defaults.models 的 alias/settings。 */
function updateDefaultModelPolicyAllow(config, allow) {
  const root = clone(configRoot(config));
  if (root.agents !== undefined && !isRecord(root.agents)) {
    throw new OpenClawAgentConfigError("invalid_agents_config", "agents 必须是对象");
  }
  root.agents = root.agents || {};
  if (root.agents.defaults !== undefined && !isRecord(root.agents.defaults)) {
    throw new OpenClawAgentConfigError("invalid_agent_defaults", "agents.defaults 必须是对象");
  }
  root.agents.defaults = root.agents.defaults || {};
  writePolicyAllow(root.agents.defaults, allow, "agents.defaults");
  return root;
}

function findCanonicalAgentEntry(config, agentId) {
  const target = normalizedCanonicalAgentId(agentId);
  const entries = readEntriesRecord(config);
  if (!entries) {
    throw new OpenClawAgentConfigError("agent_not_found", "agent 不存在", { agentId });
  }
  const key = Object.keys(entries).find((id) => id.toLowerCase() === target);
  if (!key) {
    throw new OpenClawAgentConfigError("agent_not_found", "agent 不存在", { agentId });
  }
  return { key, entry: entries[key] };
}

/** 读取 per-agent 显式 policy；有 allow 时替代 defaults policy。 */
function readAgentModelPolicyAllow(config, agentId) {
  const { key, entry } = findCanonicalAgentEntry(config, agentId);
  return readPolicyAllow(entry, `agents.entries.${key}`);
}

/** 更新 per-agent policy，不改 defaults policy 或 entry.models alias/settings。 */
function updateAgentModelPolicyAllow(config, agentId, allow) {
  const root = clone(configRoot(config));
  const { key } = findCanonicalAgentEntry(root, agentId);
  writePolicyAllow(root.agents.entries[key], allow, `agents.entries.${key}`);
  return root;
}

module.exports = {
  OpenClawAgentConfigError,
  readCanonicalAgentEntries,
  writeCanonicalAgentEntries,
  migrateLegacyAgentListToEntries,
  readDefaultModelPolicyAllow,
  updateDefaultModelPolicyAllow,
  readAgentModelPolicyAllow,
  updateAgentModelPolicyAllow,
};
