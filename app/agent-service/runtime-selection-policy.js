"use strict";
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { ensurePrivateDirectoryTree, lstatIfExists, serviceError } = require("./security");
const { supports } = require("./runtime-support");
const fail = code => { throw serviceError(code, "Runtime 选择策略无效或已变化"); };
const MODES = ["fixed", "preferred", "auto"];
const POLICY_KEYS = ["version", "revision", "mode", "allowedBindingIds", "preferredBindingIds", "affinity", "weights", "compactionBindingId"];
function defaultRuntimeSelectionPolicy() {
  return { version: 1, revision: 0, mode: "fixed", allowedBindingIds: [], preferredBindingIds: [],
    affinity: true, weights: {}, compactionBindingId: null };
}
function validateRuntimeSelectionPolicy(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).sort().join() !== [...POLICY_KEYS].sort().join()
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !Object.hasOwn(field, "value"))) fail("RUNTIME_SELECTION_POLICY_INVALID");
  const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
  const ids = list => Array.isArray(list) && Object.getPrototypeOf(list) === Array.prototype && list.length <= 32
    && Reflect.ownKeys(list).length === list.length + 1
    && Array.from({ length: list.length }, (_, index) => Object.getOwnPropertyDescriptor(list, index))
      .every(field => field?.enumerable && Object.hasOwn(field, "value") && id(field.value))
    && new Set(list).size === list.length;
  if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !MODES.includes(value.mode) || !ids(value.allowedBindingIds) || !ids(value.preferredBindingIds)
    || typeof value.affinity !== "boolean" || (value.mode !== "fixed" && !value.allowedBindingIds.length)
    || value.preferredBindingIds.some(key => !value.allowedBindingIds.includes(key))
    || !value.weights || Object.getPrototypeOf(value.weights) !== Object.prototype
    || Reflect.ownKeys(value.weights).some(key => typeof key !== "string"
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value.weights, key), "value"))
    || Object.entries(value.weights).some(([key, weight]) => !value.allowedBindingIds.includes(key)
      || !Number.isInteger(weight) || weight < 1 || weight > 100)
    || (value.compactionBindingId !== null && !id(value.compactionBindingId))) fail("RUNTIME_SELECTION_POLICY_INVALID");
  return structuredClone(value);
}

// Frozen discovery facts only. Account occupancy, quota and retry timers are
// deliberately not ranking inputs: a selected busy account stays queued.
function selectRuntimeBinding({ policy, bindings, facts, requirements, currentBindingId, defaultBindingId,
  explicitBindingId = null, adapterPriorities = {} }) {
  policy = validateRuntimeSelectionPolicy(policy);
  const allowed = policy.mode === "fixed" ? new Set([explicitBindingId || currentBindingId || defaultBindingId])
    : new Set(policy.allowedBindingIds);
  const candidates = bindings.map(binding => ({ binding, support: allowed.has(binding.id)
    ? supports({ binding, facts: facts[binding.id], requirements }) : { supported: false, code: "POLICY_DENIED" } }));
  const eligible = candidates.filter(candidate => candidate.support.supported).map(candidate => candidate.binding);
  const preference = id => { const index = policy.preferredBindingIds.indexOf(id); return index < 0 ? 999 : index; };
  eligible.sort((a, b) => {
    if (explicitBindingId) return Number(b.id === explicitBindingId) - Number(a.id === explicitBindingId) || a.id.localeCompare(b.id);
    return (policy.affinity ? Number(b.id === currentBindingId) - Number(a.id === currentBindingId) : 0)
      || (policy.mode === "preferred" ? preference(a.id) - preference(b.id) : 0)
      || (adapterPriorities[b.runtime] ?? 0) - (adapterPriorities[a.runtime] ?? 0)
      || (policy.weights[b.id] ?? 1) - (policy.weights[a.id] ?? 1) || a.id.localeCompare(b.id);
  });
  const selected = explicitBindingId ? eligible.find(binding => binding.id === explicitBindingId) : eligible[0];
  const reason = !selected ? "NO_CANDIDATE" : explicitBindingId ? "EXPLICIT_OVERRIDE"
    : policy.affinity && selected.id === currentBindingId ? "CONVERSATION_AFFINITY"
      : policy.mode === "fixed" ? "FIXED_PROFILE" : policy.mode === "preferred"
        ? selected.id === policy.preferredBindingIds[0] ? "PREFERRED_PROFILE" : "PRE_DISPATCH_FALLBACK" : "AUTO_PRIORITY";
  return Object.freeze({ bindingId: selected?.id ?? null, reason, policyRevision: policy.revision,
    candidates: candidates.map(({ binding, support }) => ({ bindingId: binding.id, runtime: binding.runtime, support })) });
}

class RuntimeSelectionPolicyStore {
  constructor({ paths, productStore }) { this.paths = paths; this.productStore = productStore; }
  #file(profileId) {
    if (!this.productStore.getAgentProfile(profileId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(profileId)) fail("UNKNOWN_AGENT_PROFILE");
    const directory = path.join(this.paths.agentsDir, profileId);
    ensurePrivateDirectoryTree(directory, this.paths.trustedRoot);
    return path.join(directory, "runtime-selection-policy.json");
  }
  get(profileId) {
    const file = this.#file(profileId);
    if (recoverInterruptedPrivateFile(file, { trustedRoot: this.paths.trustedRoot }) === "uncertain") fail("STORE_COMMIT_UNCERTAIN");
    if (!lstatIfExists(file)) return defaultRuntimeSelectionPolicy();
    try { return validateRuntimeSelectionPolicy(JSON.parse(readPrivateFile(file, { maxBytes: 32 * 1024 }))); }
    catch { fail("RUNTIME_SELECTION_POLICY_CORRUPT"); }
  }
  set(profileId, input) {
    const value = validateRuntimeSelectionPolicy(input), current = this.get(profileId);
    if (value.revision !== current.revision) fail("RUNTIME_SELECTION_POLICY_STALE");
    const bindings = this.productStore.getAgentRuntimeBindings(profileId).bindings;
    if ([...value.allowedBindingIds, ...(value.compactionBindingId ? [value.compactionBindingId] : [])]
      .some(id => !bindings.some(binding => binding.id === id && binding.enabled))) fail("RUNTIME_SELECTION_POLICY_INVALID");
    const saved = { ...value, revision: current.revision + 1 };
    atomicWritePrivateFile(this.#file(profileId), `${JSON.stringify(saved)}\n`, { trustedRoot: this.paths.trustedRoot });
    return saved;
  }
}
const RUNTIME_POLICY_METHODS = Object.freeze(["agent.runtimePolicy.get", "agent.runtimePolicy.set"]);
const RUNTIME_POLICY_MESSAGES = Object.freeze({
  RUNTIME_SELECTION_POLICY_INVALID: "Runtime 选择策略无效", RUNTIME_SELECTION_POLICY_STALE: "策略已更新，请刷新后重试",
  RUNTIME_SELECTION_POLICY_CORRUPT: "Runtime 选择策略无法读取", RUNTIME_SELECTION_UNAVAILABLE: "没有满足当前模型、权限和附件要求的已授权 Runtime",
  UNKNOWN_AGENT_PROFILE: "Agent 不存在", RUNTIME_SELECTION_POLICY_UNAVAILABLE: "Runtime 选择策略暂不可用",
});
function validateRuntimePolicyParams(method, value) {
  const fields = method === "agent.runtimePolicy.set" ? ["profileId", "policy"] : ["profileId"];
  if (!RUNTIME_POLICY_METHODS.includes(method) || !value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).sort().join() !== fields.sort().join()
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !Object.hasOwn(field, "value"))
    || typeof value.profileId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.profileId)) fail("RUNTIME_SELECTION_POLICY_INVALID");
  return { profileId: value.profileId, ...(method === "agent.runtimePolicy.set" ? { policy: validateRuntimeSelectionPolicy(value.policy) } : {}) };
}
module.exports = { RuntimeSelectionPolicyStore, validateRuntimeSelectionPolicy, defaultRuntimeSelectionPolicy, selectRuntimeBinding,
  RUNTIME_POLICY_METHODS, RUNTIME_POLICY_MESSAGES, validateRuntimePolicyParams };
