"use strict";

const { core } = require("./host.cjs");
const { validateNativeMemoryModelAliases } = require("../native-memory-config-protocol");
const { serviceError } = require("../security");
const unavailable = () => serviceError("MODEL_NOT_FOUND", "记忆模型别名无法在当前 Runtime 中唯一确认");
const validRef = value => typeof value === "string" && value.length > 0 && value.length <= 512
  && value.isWellFormed() && !/[\u0000-\u0020\u007f]/u.test(value);
const key = ref => JSON.stringify([ref.provider, ref.model]);

function memoryModelAliases(config, profileId) {
  const defaults = config.agents?.defaults?.models, agent = config.agents?.entries?.[profileId]?.models;
  return validateNativeMemoryModelAliases({ ...(defaults ? { defaults } : {}), ...(agent ? { agent } : {}) });
}
const hasMemoryModelAliases = aliases => Object.keys(aliases.defaults || {}).length > 0 || Object.keys(aliases.agent || {}).length > 0;

// Native catalog IDs remain the transport authority. The original OpenClaw
// resolver supplies alias inheritance, qualification and static normalization;
// its result may select only one visible ID in the current Runtime catalog.
function resolveMemoryCatalogModel({ aliases, profileId, runtime, raw, catalog }) {
  if (!validRef(runtime) || !Array.isArray(catalog) || catalog.length > 4096
    || typeof raw !== "string" || !raw.trim() || raw.length > 512 || !raw.isWellFormed()
    || /[\u0000-\u001f\u007f]/u.test(raw)) throw unavailable();
  // Product Binding selects the account. An OpenClaw auth-profile suffix must
  // never be silently stripped and executed against a different account.
  if (core.splitMemoryModelAuthProfile(raw).profile) throw unavailable();
  const policy = validateNativeMemoryModelAliases(aliases);
  const rows = catalog.filter(row => validRef(row?.model)).map(row => ({ row,
    ref: core.normalizeMemoryModelReference(row.model, runtime) }));
  const providers = Object.fromEntries(rows.map(({ ref }) => [ref.provider, {}]));
  const cfg = { agents: { defaults: { models: policy.defaults }, entries: { [profileId]: { models: policy.agent } } },
    models: { providers } };
  const selected = core.resolveMemoryModelReference({ cfg, agentId: profileId, raw, defaultProvider: runtime });
  if (!selected) throw unavailable();
  if (core.splitMemoryModelAuthProfile(`${selected.ref.provider}/${selected.ref.model}`).profile) throw unavailable();
  const matches = rows.filter(({ row, ref }) => row.hidden !== true && key(ref) === key(selected.ref));
  const canonical = selected.ref.provider === runtime ? selected.ref.model : `${selected.ref.provider}/${selected.ref.model}`;
  const exact = matches.find(({ row }) => row.model === canonical);
  if (exact) return exact.row.model;
  const unique = [...new Set(matches.map(({ row }) => row.model))];
  if (unique.length !== 1) throw unavailable();
  return unique[0];
}

module.exports = { memoryModelAliases, hasMemoryModelAliases, resolveMemoryCatalogModel };
