"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { JsonlProductStore, DEFAULT_AGENT_PROFILE_ID, STORE_SCHEMA_VERSION, snapshotChecksum } = require("../app/agent-service/product-store");
const { ProviderService } = require("../app/agent-service/codex-provider-service");
const { CustomEndpointService } = require("../app/agent-service/custom-endpoint-service");
const { validateCustomEndpointResult } = require("../app/agent-service/custom-endpoint-protocol");
const { createProfileServiceController } = require("../app/agent-service/profile-service-controller");
const { ProviderRuntimeBridge } = require("../app/agent-service/provider-runtime-bridge");
const { resolveServicePaths } = require("../app/agent-service/paths");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-endpoint-service-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const productStore = new JsonlProductStore({ paths });
  productStore.open();
  const secrets = new Map();
  const secretStore = {
    put: async (id, value, meta) => secrets.set(id, { value, ...meta }),
    get: async (id) => secrets.get(id)?.value,
    delete: async (id) => secrets.delete(id),
    listMetadata: () => [...secrets].map(([credentialRef, { kind }]) => ({ credentialRef, kind })),
    getCredentialRevision: (id) => (secrets.has(id) ? 1 : undefined),
  };
  const providerService = new ProviderService({ productStore, secretStore,
    protocolValidator: async () => ({ parsedBy: "codex-0.159.2" }), runtimePool: { stop: async () => {} } });
  const profileServiceController = createProfileServiceController({ productStore,
    providerBootstrap: providerService.profileBootstrapCapability,
    runtimeManager: { stop: async () => {}, acquire: async () => { throw new Error("custom catalog must not start ChatGPT"); } },
    accountAuthManager: { read: async () => ({ account: null }) },
  });
  const service = new CustomEndpointService({ productStore, secretStore, providerService, profileServiceController });
  return { root, paths, productStore, secrets, providerService, profileServiceController, service,
    async close() { await profileServiceController.close(); await providerService.close(); productStore.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const input = { id: "custom-one", name: "custom one", baseUrl: "https://gateway.example/v1", api: "openai-responses",
  model: "model-a", models: ["model-a", "model-b"], apiKey: "fixture-only-endpoint-key" };

// Single-model providers in the original schema 15 format stay readable.
const LEGACY_SCHEMA_VERSION = 15;

test("legacy single-model providers remain readable before upgrading to selected models", async () => {
  const f = fixture();
  try {
    await f.providerService.save({ id: "legacy", kind: "custom-responses", name: "legacy", baseUrl: input.baseUrl, model: "legacy-model" });
    f.productStore.close();
    const snapshot = JSON.parse(fs.readFileSync(f.paths.stateSnapshotPath, "utf8"));
    snapshot.schemaVersion = LEGACY_SCHEMA_VERSION; snapshot.checksum = snapshotChecksum(snapshot);
    fs.writeFileSync(f.paths.stateSnapshotPath, JSON.stringify(snapshot));
    f.productStore.open();
    assert.deepEqual(f.service.list().endpoints[0].models, ["legacy-model"]);
    await f.profileServiceController.open();
    await f.service.save(null, { ...input, id: "legacy" });
    f.productStore.close();
    assert.equal(JSON.parse(fs.readFileSync(f.paths.stateSnapshotPath, "utf8")).schemaVersion, STORE_SCHEMA_VERSION);
    f.productStore.open();
    assert.deepEqual(f.service.list().endpoints[0].models, input.models);
  } finally { await f.close(); }
});

// Anything older than Product 15 (e.g. the schema 9/10 era) is refused.
test("retired Product schemas are refused instead of being read", async () => {
  for (const retired of [9, 10, LEGACY_SCHEMA_VERSION - 1]) {
    const f = fixture();
    try {
      f.productStore.close();
      const snapshot = JSON.parse(fs.readFileSync(f.paths.stateSnapshotPath, "utf8"));
      snapshot.schemaVersion = retired; snapshot.checksum = snapshotChecksum(snapshot);
      fs.writeFileSync(f.paths.stateSnapshotPath, JSON.stringify(snapshot));
      assert.throws(() => f.productStore.open(), { code: "STORE_SCHEMA_UNSUPPORTED" });
    } finally { await f.close(); }
  }
});

test("shared endpoint CRUD persists all selected models, keeps an omitted key and never replaces the default source", async () => {
  const f = fixture();
  const profileOf = (id) => f.productStore.getAgentProfile(id);
  try {
    await f.profileServiceController.open();
    const first = await f.service.save(null, input);
    assert.equal(first.endpoints.length, 1);
    assert.deepEqual(first.endpoints[0].models, input.models);
    assert.equal(first.endpoints[0].hasApiKey, true);
    assert.equal(first.endpoints[0].isCurrent, false);
    assert.deepEqual(first.endpoints[0].activeIn, []);
    assert.equal(first.form.firstModelIsDefault, false);
    assert.equal(JSON.stringify(first).includes(input.apiKey), false);
    assert.deepEqual(validateCustomEndpointResult("provider.endpoints.save", first), first);
    assert.equal(profileOf(DEFAULT_AGENT_PROFILE_ID).providerRef, null, "saving never replaces the default source");
    const originalKey = f.productStore.getModelProvider(input.id).credentialRef;
    await f.service.save(null, { ...input, apiKey: undefined, models: ["model-b", "model-c"], model: "model-b" });
    assert.equal(f.productStore.getModelProvider(input.id).credentialRef, originalKey);
    assert.equal(profileOf(DEFAULT_AGENT_PROFILE_ID).providerRef, null);
    // Choosing an endpoint as default is explicit. A later save keeps that
    // default model while the endpoint still offers it, else its first model.
    await f.profileServiceController.handle("profile.bind", { operationId: "choose-endpoint-default",
      profileId: DEFAULT_AGENT_PROFILE_ID, providerRef: input.id, defaultModel: "model-c", createdAt: Date.now() });
    await f.service.save(null, { ...input, apiKey: undefined, models: ["model-c", "model-d"], model: "model-c" });
    assert.equal(profileOf(DEFAULT_AGENT_PROFILE_ID).defaultModel, "model-c");
    await f.service.save(null, { ...input, apiKey: undefined, models: ["model-d"], model: "model-d" });
    assert.equal(profileOf(DEFAULT_AGENT_PROFILE_ID).providerRef, input.id);
    assert.equal(profileOf(DEFAULT_AGENT_PROFILE_ID).defaultModel, "model-d");
    const other = { ...profileOf(DEFAULT_AGENT_PROFILE_ID), id: "endpoint-profile-two", agentId: "endpoint-agent-two",
      name: "Second", runtimeProfileId: "endpoint-runtime-two", isDefault: false, providerRef: null, defaultModel: null };
    f.productStore.putAgentProfile(other);
    await f.service.save(other.id, { ...input, id: "custom-two", name: "custom two" });
    assert.equal(profileOf(other.id).providerRef, null);
    assert.equal(f.service.list(other.id).endpoints.length, 2);
    await f.profileServiceController.handle("profile.bind", { operationId: "choose-second-model", profileId: other.id,
      providerRef: "custom-two", defaultModel: "model-b", createdAt: Date.now() });
    // A signed-out ChatGPT catalog never hides endpoints; each row names its
    // source (absent = the Profile default source).
    const rows = [];
    let cursor = null;
    do {
      const page = await f.profileServiceController.handle("profile.models.list", { profileId: other.id, cursor, limit: 1 });
      rows.push(...page.models); cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(rows.map(row => [row.modelProviderRef ?? null, row.id, row.isDefault, row.sourceName]), [
      ["custom-one", "model-d", false, "custom one"],
      [null, "model-a", false, "custom two"],
      [null, "model-b", true, "custom two"],
    ]);
    // One Codex process declares ChatGPT (process default) and every endpoint.
    const bridge = new ProviderRuntimeBridge({ productStore: f.productStore, secretStore: f.service.secretStore,
      configWriter: { overlay: () => ({ args: [] }) } });
    const runtime = await bridge.prepareRuntime({ runtimeProfileId: other.runtimeProfileId, runtimeAccountId: other.runtimeAccountId });
    assert.equal(runtime.runtimeConfig.provider, null);
    assert.deepEqual(runtime.runtimeConfig.extraProviders.map(entry => [entry.id, entry.model]),
      [["custom-one", "model-d"], ["custom-two", "model-a"]]);
    assert.equal(Object.keys(runtime.spawnEnv).length, 2);
    assert.equal(runtime.registeredSecrets.length, 1, "both fixture endpoints share one key value");
    runtime.assertCurrent();
    await f.service.save(null, { ...input, apiKey: undefined, models: ["model-d", "model-e"], model: "model-d" });
    assert.throws(() => runtime.assertCurrent(), { code: "EXECUTION_CONTRACT_STALE" }, "an endpoint change retires the host");
    f.productStore.close(); f.productStore.open();
    assert.deepEqual(f.service.list(other.id).endpoints.find(item => item.id === input.id).models, ["model-d", "model-e"]);
    await f.service.remove(other.id, "custom-two");
    assert.equal(profileOf(other.id).providerRef, null);
    assert.equal(profileOf(DEFAULT_AGENT_PROFILE_ID).providerRef, input.id);
    assert.equal(f.secrets.size, 1);
  } finally { await f.close(); }
});

test("invalid input and cross-host implicit key reuse do not overwrite existing configuration", async () => {
  const f = fixture();
  try {
    await f.profileServiceController.open();
    await f.service.save(null, input);
    const baseline = f.productStore.getModelProvider(input.id);
    for (const patch of [{ api: "openai-completions" }, { models: [] }, { id: "../bad" },
      { apiKey: undefined, baseUrl: "https://other.example/v1" }, { models: ["model-a", "x".repeat(513)] }]) {
      await assert.rejects(f.service.save(null, { ...input, ...patch }));
      assert.deepEqual(f.productStore.getModelProvider(input.id), baseline);
    }
  } finally { await f.close(); }
});

test("stored credentials stay in the Service and are only used for the unchanged URL", async () => {
  const f = fixture(); const oldFetch = globalThis.fetch;
  try {
    await f.profileServiceController.open(); await f.service.save(null, input);
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url, authorization: options.headers.authorization });
      return new Response(JSON.stringify({ data: [{ id: "model-a" }] }));
    };
    await f.service.discover(null, { id: input.id, baseUrl: input.baseUrl });
    await f.service.discover(null, { id: input.id, baseUrl: "https://other.example/v1" });
    assert.equal(requests[0].authorization, `Bearer ${input.apiKey}`);
    assert.equal(requests[1].authorization, undefined);
  } finally { globalThis.fetch = oldFetch; await f.close(); }
});
