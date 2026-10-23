"use strict";

// OpenClaw's config editor changes definitions only. References and credential
// stores belong to their own official APIs, never to a model-definition save.
const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { ModelChangeError } = require("./model-change-validation");

const NATIVE_CONFIG_MODE = "native-config";
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const plain = value => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const digest = value => createHash("sha256").update(stable(value)).digest("hex");
const fail = (code, field) => { throw new ModelChangeError(code, "模型配置草稿无法保存", { field, stage: "preflight", status: 409 }); };
function providerMetadata(value) {
  if (!value) return null;
  const result = clone(value);
  delete result.apiKey; // Credential completion is proved separately, never by config.
  return result;
}
function modelDraftDigest(config, providerKey, targetKey = providerKey, providerKeys = [providerKey, targetKey]) {
  const providers = config.models?.providers || {};
  return digest([...new Set(providerKeys)].sort().map(key => [key, providerMetadata(providers[key])]));
}

/** Merge submitted fields into the original row, retaining all upstream data. */
function editModel(before, model) {
  const { advanced, ...basic } = model;
  const result = { ...(clone(before) || {}), ...clone(basic) };
  mergeAdvanced(result, advanced);
  if (!result.name) result.name = result.id;
  return result;
}
function mergeAdvanced(target, patch) {
  if (!patch) return;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete target[key];
    else if (plain(value)) { if (!plain(target[key])) target[key] = {}; mergeAdvanced(target[key], value); }
    else target[key] = clone(value);
}
}

/** Pure definition edit, shared by the external adapter and owned Host policy. */
function buildOpenClawModelDraft(original, spec) {
  if (!plain(original) || !plain(spec)) fail("invalid_input");
  if (spec.kind === "batch") {
    if (!Array.isArray(spec.patch?.items) || !spec.patch.items.length || spec.patch.items.length > 100) fail("invalid_input");
    let config = original;
    const keys = new Set();
    for (const item of spec.patch.items) {
      if (item.kind === "batch" || item.kind === "save-provider") fail("invalid_input");
      const plan = buildOpenClawModelDraft(config, item);
      config = plan.config;
      for (const key of plan.providerKeys) keys.add(key);
    }
    const providerKeys = [...keys].sort();
    return { config, changed: !isDeepStrictEqual(original, config), targetKey: spec.providerKey,
      providerKeys, targetDigest: modelDraftDigest(config, spec.providerKey, spec.providerKey, providerKeys), targetModel: null };
  }
  const config = clone(original);
  const providerKey = spec.providerKey;
  if (typeof providerKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerKey)) fail("invalid_provider");
  const providers = config.models?.providers || {};
  const before = providers[providerKey];
  const rows = Array.isArray(before?.models) ? before.models : [];
  if (!before && spec.kind === "update-provider" && !spec.patch?.renameTo
    && !Object.hasOwn(spec.patch || {}, "baseUrl") && !Object.hasOwn(spec.patch || {}, "api") && !spec.patch?.clearBaseUrl) {
    return { config, targetKey: providerKey, providerKeys: [providerKey], changed: false,
      targetDigest: modelDraftDigest(config, providerKey), targetModel: null };
  }
  let targetKey = providerKey;
  let next = clone(before);

  if (spec.kind === "delete-provider") {
    if (!before) fail("provider_not_found");
    delete providers[providerKey];
  } else if (spec.kind === "delete-model") {
    if (!before || !rows.some(row => row.id === spec.sourceModelId)) fail("source_not_found");
    next.models = rows.filter(row => row.id !== spec.sourceModelId);
    providers[providerKey] = next;
  } else if (spec.kind === "update-provider" || spec.kind === "save-provider") {
    const patch = spec.patch || {};
    if (!before && spec.kind !== "save-provider") fail("provider_not_found");
    next ||= {};
    mergeAdvanced(next, patch.advanced);
    for (const field of ["baseUrl", "api"]) if (Object.hasOwn(patch, field)) next[field] = patch[field];
    if (patch.clearBaseUrl) delete next.baseUrl;
    targetKey = patch.renameTo || providerKey;
    if (targetKey !== providerKey && Object.hasOwn(providers, targetKey)) fail("provider_exists");
    if (spec.kind === "save-provider") {
      if (!Array.isArray(patch.modelIds)) fail("invalid_input", "models");
      next.models = patch.modelIds.map(id => editModel(rows.find(row => row.id === id), { id }));
    }
    // clearApiKey is an authLogout intent; a definition edit cannot implement it.
    providers[targetKey] = next;
    if (targetKey !== providerKey) delete providers[providerKey];
  } else if (["create", "update", "rename"].includes(spec.kind)) {
    if (!plain(spec.model) || !spec.model.id) fail("required", "model.id");
    const source = rows.find(row => row.id === spec.sourceModelId);
    if (spec.kind !== "create" && !source) fail("source_not_found");
    if (spec.kind === "create" && spec.providerMode === "new" && before) fail("provider_conflict");
    if (!before && spec.providerMode !== "new") fail("provider_not_found");
    if (!before && !spec.baseUrl) fail("provider_base_url_required");
    if (rows.some(row => row.id === spec.model.id && row !== source)) fail("target_conflict");
    next ||= { baseUrl: spec.baseUrl, ...(spec.api ? { api: spec.api } : {}), models: [] };
    const model = editModel(source, spec.model);
    next.models = source ? rows.map(row => row === source ? model : row) : [...rows, model];
    providers[providerKey] = next;
  } else fail("unsupported");

  if (!config.models) config.models = {};
  config.models.providers = providers;
  const target = providers[targetKey];
  return {
    config,
    targetKey,
    changed: !isDeepStrictEqual(original, config),
    providerKeys: [...new Set([providerKey, targetKey])].sort(),
    // Fingerprints contain hashes only. Neither config bytes nor credentials
    // enter the coordinator's journal or public operation observations.
    targetDigest: modelDraftDigest(config, providerKey, targetKey),
    targetModel: spec.model ? target?.models?.find(row => row.id === spec.model.id) : null,
  };
}

function observeOpenClawModelDraft(config, entry) {
  const targetKey = entry.fingerprints?.nativeTargetProvider || entry.providerKey;
  return modelDraftDigest(config, entry.providerKey, targetKey, entry.fingerprints?.nativeProviders) === entry.fingerprints?.nativeTargetDigest;
}

module.exports = { NATIVE_CONFIG_MODE, buildOpenClawModelDraft, observeOpenClawModelDraft, modelDraftDigest };
