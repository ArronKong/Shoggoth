#!/usr/bin/env node
"use strict";

// Hermes 目录纯 state builder 与 epoch 原子提交定向回归。

const assert = require("node:assert/strict");
const {
  buildHermesModelCatalogState,
  commitHermesModelCatalogState,
} = require("../app/core/hermes-model-catalog-state");

/** 构造逐 Profile runtime snapshot。 */
function snapshots(reasoning = false) {
  return new Map([
    ["bull", {
      choices: [{ id: "shared", name: "shared", provider: "alpha" }],
      catalogRows: [{ id: "shared", name: "shared", provider: "alpha", backendId: "hermes", profile: "bull", reasoning }],
      meta: new Map([[JSON.stringify(["alpha", "shared"]), { reasoning }]]),
      models: ["shared"],
      identities: new Set([JSON.stringify(["alpha", "shared"])]),
    }],
    ["default", {
      choices: [
        { id: "shared", name: "shared", provider: "alpha" },
        { id: "other", name: "other", provider: "beta" },
      ],
      catalogRows: [
        { id: "shared", name: "shared", provider: "alpha", backendId: "hermes", profile: "default", reasoning },
        { id: "other", name: "other", provider: "beta", backendId: "hermes", profile: "default" },
      ],
      meta: new Map([
        [JSON.stringify(["alpha", "shared"]), { reasoning }],
        [JSON.stringify(["beta", "other"]), {}],
      ]),
      models: ["shared", "other"],
      identities: new Set([JSON.stringify(["alpha", "shared"]), JSON.stringify(["beta", "other"])]),
    }],
  ]);
}

const first = buildHermesModelCatalogState(snapshots(false));
assert.deepEqual(first.modelChoices.map(({ provider, id }) => `${provider}/${id}`), ["alpha/shared", "beta/other"]);
assert.deepEqual(first.modelsByProfile.get("bull"), ["shared"]);
assert.deepEqual(first.modelsByProfile.get("default"), ["shared", "other"]);
assert.equal(first.catalogRevision.length, 64);

const changedMeta = buildHermesModelCatalogState(snapshots(true));
assert.notEqual(changedMeta.catalogRevision, first.catalogRevision, "reasoning 变化必须推进 revision");

const backend = {
  _modelCatalogEpoch: 3,
  modelChoices: [{ id: "old" }],
  modelMeta: new Map([["old", {}]]),
  modelsByProfile: new Map([["default", ["old"]]]),
  modelsByProfileIdentity: new Map(),
  catalogRevision: "old-revision",
  agents: [{ id: "hermes-bull", fallbacks: ["old"] }, { id: "hermes-default", fallbacks: ["old"] }],
  profileById: new Map([["hermes-bull", "bull"], ["hermes-default", "default"]]),
};
assert.equal(commitHermesModelCatalogState(backend, first, 2), false, "迟到 epoch 不得提交");
assert.equal(backend.catalogRevision, "old-revision");
assert.deepEqual(backend.modelChoices, [{ id: "old" }]);

assert.equal(commitHermesModelCatalogState(backend, first, 3), true);
assert.equal(backend.modelChoices, first.modelChoices);
assert.equal(backend.modelMeta, first.modelMeta);
assert.equal(backend.modelsByProfile, first.modelsByProfile);
assert.equal(backend.modelsByProfileIdentity, first.modelsByProfileIdentity);
assert.equal(backend.catalogRevision, first.catalogRevision);
assert.deepEqual(backend.agents[0].fallbacks, ["shared"]);
assert.deepEqual(backend.agents[1].fallbacks, ["shared", "other"]);

console.log("Hermes model catalog state regression: PASS");
