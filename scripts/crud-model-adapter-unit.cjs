"use strict";

// No gateway, network, or user configuration: exercise the smoke's actual adapter
// against both config/auth collisions and an empty underlying provider namespace.
const assert = require("node:assert/strict");
const { installSmokeModelAdapter } = require("./crud-smoke.cjs");

async function verifyCollision(source) {
  const key = "shoggoth-smoke";
  const underlying = {
    marker: "original-config",
    providers: [
      { key: "untouched", source: "config", models: [{ id: "real-model" }] },
      ...(source ? [{ key, source, hasApiKey: true, models: source === "auth" ? [] : [{ id: "original-model" }] }] : []),
    ],
  };
  const before = JSON.stringify(underlying);
  let originalSecretReads = 0;
  const backend = {
    id: "openclaw",
    async getModelConfig() { return underlying; },
    async revealModelProviderKey() {
      originalSecretReads += 1;
      return { apiKey: "original-secret-stub" };
    },
  };
  const originalGetConfig = backend.getModelConfig;
  const originalReveal = backend.revealModelProviderKey;
  const restore = installSmokeModelAdapter(backend);
  let commits = 0;
  const context = {
    assertProviderLease() {},
    async recordStage() {},
    async markCommitting() {},
    async markCommitted() { commits += 1; },
  };
  const save = async (id) => {
    const result = await backend.applyModelChange({ kind: "create", providerKey: key, model: { id } }, context, { apiKey: "fixture-secret" });
    assert.equal(result.status, "applied");
    const row = (await backend.getModelConfig()).providers.find((provider) => provider.key === key);
    assert.equal(row.source, "config");
    assert.deepEqual(row.models.map((model) => model.id), [id]);
  };
  const assertDeleted = async () => {
    const config = await backend.getModelConfig();
    assert.equal(config.marker, "original-config");
    assert.equal(config.providers.some((provider) => provider.key === key), false,
      `${source || "empty"} namespace must not resurrect the deleted fixture`);
    assert.deepEqual(config.providers, [underlying.providers[0]], "unrelated live provider remains visible");
    assert.deepEqual(await backend.getModelCatalogSources(), { models: [], config: [], runtime: [] });
    assert.equal((await backend.revealModelProviderKey(key)).apiKey, null,
      "deleted fixture must not fall through to a same-name real secret");
    assert.equal(originalSecretReads, 0);
    assert.equal(JSON.stringify(underlying), before, "underlying config/auth data stays untouched");
  };
  try {
    await save("fixture-one");
    assert.equal((await backend.applyModelChange({ kind: "delete-provider", providerKey: key }, context)).status, "applied");
    await assertDeleted();
    await save("fixture-two");
    assert.equal((await backend.applyModelChange({ kind: "delete-model", providerKey: key, sourceModelId: "fixture-two" }, context)).status, "applied");
    await assertDeleted();
    assert.equal(commits, 4);
  } finally {
    restore();
  }
  assert.equal(backend.getModelConfig, originalGetConfig);
  assert.equal(backend.revealModelProviderKey, originalReveal);
  assert.equal(await backend.getModelConfig(), underlying, "restoration exposes the original authority intact");
}

(async () => {
  for (const source of [null, "config", "auth"]) await verifyCollision(source);
  console.log("crud model adapter isolation: PASS (empty/config/auth × provider/model delete)");
})().catch((error) => { console.error(error); process.exitCode = 1; });
