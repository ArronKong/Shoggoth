"use strict";

// Hermes runtime 目录的纯 builder 与 epoch 原子提交。builder 不读取/修改 backend；
// commit 先比较 apply epoch，再一次性交换所有目录派生引用。

const { computeCatalogRevision } = require("./model-catalog-revision");

/** provider+modelId 复合键，必须与 HermesBackend 目录身份一致。 */
function catalogKey(provider, modelId) {
  return JSON.stringify([String(provider || ""), String(modelId || "")]);
}

/** 递归隔离副本；保留公开可选字段的 undefined 键，维持既有 strict snapshot shape。 */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  }
  return value;
}

/**
 * 从逐 Profile 独立 snapshot 构造完整目录 state；同身份元数据由字典序最小
 * Profile 胜出，网络完成顺序不能影响 revision 或 UI。
 */
function buildHermesModelCatalogState(profileSnapshots) {
  if (!(profileSnapshots instanceof Map)) throw new TypeError("profileSnapshots 必须是 Map");
  const modelChoices = [];
  const modelMeta = new Map();
  const modelsByProfile = new Map();
  const modelsByProfileIdentity = new Map();
  const catalogRows = [];
  const seen = new Set();
  const profiles = [...profileSnapshots.keys()].sort();

  for (const profile of profiles) {
    const snapshot = profileSnapshots.get(profile) || {};
    const choices = Array.isArray(snapshot.choices) ? snapshot.choices : [];
    const rows = Array.isArray(snapshot.catalogRows) ? snapshot.catalogRows : [];
    const models = Array.isArray(snapshot.models) ? [...snapshot.models] : [];
    const identities = snapshot.identities instanceof Set
      ? new Set(snapshot.identities)
      : new Set(choices.map((choice) => catalogKey(choice.provider, choice.id)));
    modelsByProfile.set(profile, models);
    modelsByProfileIdentity.set(profile, identities);
    catalogRows.push(...clone(rows));
    for (const choice of choices) {
      const identity = catalogKey(choice.provider, choice.id);
      if (seen.has(identity)) continue;
      seen.add(identity);
      modelChoices.push(clone(choice));
      modelMeta.set(identity, clone(snapshot.meta instanceof Map ? snapshot.meta.get(identity) : {}));
    }
  }

  return Object.freeze({
    modelChoices,
    modelMeta,
    modelsByProfile,
    modelsByProfileIdentity,
    catalogRows,
    catalogRevision: computeCatalogRevision({
      backendId: "hermes",
      config: [],
      runtime: catalogRows,
    }),
  });
}

/**
 * epoch 相等时一次性交换完整 state；任何迟到 refresh 都返回 false 且零字段修改。
 */
function commitHermesModelCatalogState(backend, state, expectedEpoch) {
  if (!backend || typeof backend !== "object" || !state || typeof state !== "object") {
    throw new TypeError("backend/state 必须是对象");
  }
  if (backend._modelCatalogEpoch !== expectedEpoch) return false;
  backend.modelChoices = state.modelChoices;
  backend.modelMeta = state.modelMeta;
  backend.modelsByProfile = state.modelsByProfile;
  backend.modelsByProfileIdentity = state.modelsByProfileIdentity;
  backend.catalogRevision = state.catalogRevision;
  for (const agent of Array.isArray(backend.agents) ? backend.agents : []) {
    const profile = backend.profileById?.get(agent.id);
    if (!profile || !state.modelsByProfile.has(profile)) continue;
    agent.fallbacks = state.modelsByProfile.get(profile);
  }
  return true;
}

module.exports = {
  buildHermesModelCatalogState,
  commitHermesModelCatalogState,
};
