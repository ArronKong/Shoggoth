"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { JsonlProductStore, DEFAULT_AGENT_PROFILE_ID, STORE_SCHEMA_VERSION, snapshotChecksum, eventChecksum } = require("../app/agent-service/product-store");
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
  };
  const providerService = new ProviderService({ productStore, secretStore,
    protocolValidator: async () => ({ parsedBy: "codex-0.149.0" }), runtimePool: { stop: async () => {} } });
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

test("schema 9 single-model providers remain readable before upgrading to selected models", async () => {
  const f = fixture();
  try {
    await f.providerService.save({ id: "legacy", kind: "custom-responses", name: "legacy", baseUrl: input.baseUrl, model: "legacy-model" });
    f.productStore.close();
    const snapshot = JSON.parse(fs.readFileSync(f.paths.stateSnapshotPath, "utf8"));
    snapshot.schemaVersion = 9; snapshot.checksum = snapshotChecksum(snapshot);
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

test("schema upgrades keep both schema 9 and schema 10 downgrade barriers", async () => {
  for (const authority of [9, STORE_SCHEMA_VERSION]) {
    for (const fromSnapshot of [true, false]) {
      const f = fixture();
      try {
        f.productStore.close();
        const snapshot = JSON.parse(fs.readFileSync(f.paths.stateSnapshotPath, "utf8"));
        snapshot.schemaVersion = fromSnapshot ? authority : authority - 1;
        snapshot.checksum = snapshotChecksum(snapshot);
        fs.writeFileSync(f.paths.stateSnapshotPath, JSON.stringify(snapshot));
        const profile = snapshot.agentProfiles[0];
        const versions = fromSnapshot ? [authority - 1] : [authority, authority - 1];
        const events = versions.map((schemaVersion, index) => {
          const event = { schemaVersion, seq: snapshot.lastSeq + index + 1, aggregateId: profile.id,
            type: "agent_profile.put", time: profile.updatedAt, payload: { profile } };
          return { ...event, checksum: eventChecksum(event) };
        });
        fs.appendFileSync(f.paths.eventLogPath, `${events.map(JSON.stringify).join("\n")}\n`);
        assert.throws(() => f.productStore.open(), { code: "STORE_CORRUPT_EVENT_LOG" });
      } finally { await f.close(); }
    }
  }
});

test("shared endpoint CRUD persists all selected models, keeps an omitted key and isolates Profile activation", async () => {
  const f = fixture();
  try {
    await f.profileServiceController.open();
    const first = await f.service.save(null, input);
    assert.equal(first.endpoints.length, 1);
    assert.deepEqual(first.endpoints[0].models, input.models);
    assert.equal(first.endpoints[0].hasApiKey, true);
    assert.equal(JSON.stringify(first).includes(input.apiKey), false);
    assert.deepEqual(validateCustomEndpointResult("provider.endpoints.save", first), first);
    const originalKey = f.productStore.getModelProvider(input.id).credentialRef;
    await f.service.save(null, { ...input, apiKey: undefined, models: ["model-b", "model-c"], model: "model-b" });
    assert.equal(f.productStore.getModelProvider(input.id).credentialRef, originalKey);
    assert.equal(f.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID).defaultModel, "model-b");
    const other = { ...f.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID), id: "endpoint-profile-two", agentId: "endpoint-agent-two",
      name: "Second", runtimeProfileId: "endpoint-runtime-two", isDefault: false, providerRef: null, defaultModel: null };
    f.productStore.putAgentProfile(other);
    await f.service.save(other.id, { ...input, id: "custom-two", name: "custom two" });
    assert.equal(f.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID).providerRef, input.id);
    assert.equal(f.productStore.getAgentProfile(other.id).providerRef, "custom-two");
    assert.equal(f.service.list(other.id).endpoints.length, 2);
    await f.profileServiceController.handle("profile.bind", { operationId: "choose-second-model", profileId: other.id,
      providerRef: "custom-two", defaultModel: "model-b", createdAt: Date.now() });
    const page = await f.profileServiceController.handle("profile.models.list", { profileId: other.id, cursor: null, limit: 1 });
    assert.deepEqual(page.models.map(item => item.id), ["model-a"]);
    assert.equal(page.models[0].isDefault, false);
    const second = await f.profileServiceController.handle("profile.models.list", { profileId: other.id, cursor: page.nextCursor, limit: 1 });
    assert.deepEqual(second.models.map(item => item.id), ["model-b"]);
    assert.equal(second.models[0].isDefault, true);
    assert.equal(second.hasMore, false);
    const bridge = new ProviderRuntimeBridge({ productStore: f.productStore, secretStore: f.service.secretStore,
      configWriter: { overlay: () => ({ args: [] }) } });
    const runtime = await bridge.prepareRuntime({ runtimeProfileId: other.runtimeProfileId, runtimeAccountId: other.runtimeAccountId });
    assert.equal(runtime.runtimeConfig.provider.model, "model-b");
    f.productStore.close(); f.productStore.open();
    assert.deepEqual(f.service.list(other.id).endpoints.find(item => item.id === input.id).models, ["model-b", "model-c"]);
    await f.service.remove(other.id, "custom-two");
    assert.equal(f.productStore.getAgentProfile(other.id).providerRef, null);
    assert.equal(f.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID).providerRef, input.id);
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
