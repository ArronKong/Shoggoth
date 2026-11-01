"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryTextRouteResolver } = require("../app/agent-service/memory-text-route");
const { validateNativeMemoryConfigProjection } = require("../app/agent-service/native-memory-config-protocol");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");

function routeFixture() {
  let config = { revision: 1, config: {} }, account = { id: "account-a", runtime: "pi", updatedAt: 1 };
  let profile = { id: "owner", enabled: true, runtime: "pi", runtimeProfileId: "chat-profile", runtimeAccountId: account.id,
    selectedBindingId: "default-binding", defaultBindingId: "default-binding", defaultModel: "agent-default-model", providerRef: null,
    permissionPolicy: { approvalPolicy: "never", sandbox: "danger-full-access" } };
  const session = { id: "s", profileId: "owner", workspace: null, status: "ready", runtimeBindingId: "other-chat-binding", modelOverride: "temporary-chat-model" };
  const resolve = createMemoryTextRouteResolver({ productStore: {
    getAgentProfile: () => profile, resolveAgentRuntimeProfile: (id, bindingId) => { assert.equal(id, "owner"); assert(bindingId === undefined || bindingId === "default-binding"); return profile; },
    getRuntimeAccount: () => account,
  }, chatSessionStore: { getSession: () => session }, getConfigProjection: () => config });
  return { resolve: input => resolve({ profileId: "owner", sessionKey: "s", ...input }), session,
    setConfig: value => { config = value; }, setAccount: value => { account = { ...account, ...value }; },
    setProfile: value => { profile = { ...profile, ...value }; } };
}

test("memory text config admits default, local and explicit Binding only; credentials and incomplete routes fail closed", () => {
  for (const value of [{ source: "agent-default" }, { source: "local" }, { source: "binding", profileId: "owner", bindingId: "default-binding", model: "m" }]) {
    assert.deepEqual(validateNativeMemoryConfigProjection({ revision: 1, config: { memory: { textModel: value } } }).config.memory.textModel, value);
  }
  for (const value of [{ source: "binding", profileId: "owner" }, { source: "agent-default", model: "m" },
    { source: "local", runtimeAccountId: "account" }, { source: "binding", profileId: "owner", bindingId: "default-binding", apiKey: "secret" }]) {
    assert.throws(() => validateNativeMemoryConfigProjection({ revision: 1, config: { memory: { textModel: value } } }), { code: "NATIVE_MEMORY_CONFIG_INVALID" });
  }
});

test("default memory lane ignores temporary chat model/permissions and fences saved account/default changes", () => {
  const f = routeFixture(), route = f.resolve();
  assert.equal(route.model, "agent-default-model"); assert.notEqual(route.profile.runtimeProfileId, "chat-profile");
  assert.deepEqual(route.profile.permissionPolicy, { approvalPolicy: "never", sandbox: "read-only" });
  f.session.modelOverride = "yet-another-chat-model"; f.session.permissionMode = "full-access"; f.session.runtimeBindingId = "another-binding";
  route.assertCurrent(); assert.equal(f.resolve().fingerprint, route.fingerprint);
  f.setAccount({ updatedAt: 2 }); assert.throws(() => route.assertCurrent(), { code: "MEMORY_IMPORT_BINDING_STALE" });
});

test("local mode never silently falls back to any account and explicit profile override wins", () => {
  const f = routeFixture();
  f.setConfig({ revision: 2, config: { memory: { textModel: { source: "local" } } } });
  assert.throws(() => f.resolve(), { code: "MEMORY_TEXT_MODEL_DISABLED" });
  f.setConfig({ revision: 3, config: { memory: { textModel: { source: "local" } },
    agents: { entries: { owner: { memory: { textModel: { source: "agent-default" } } } } } } });
  assert.equal(f.resolve().model, "agent-default-model");
});

async function fixture(t) {
  const f = await openHandoffFixture({ catalogs: { codex: ["fixture-model"], pi: ["memory-model"] },
    serviceOptions: { memoryCore: true, prewarmMcpAuth: false } });
  t.after(() => f.close());
  const projection = f.service.nativeMemoryConfig.read();
  f.service.nativeMemoryConfig.apply({ revision: projection.revision + 1, config: { memory: {
    search: { provider: "none" }, textModel: { source: "binding", profileId: f.profile.id, bindingId: f.binding("pi").id, model: "memory-model" } } } });
  f.service.runtimeManager.canGenerateModelOnly = runtime => runtime === "pi";
  const calls = [];
  f.service.runtimeManager.acquire = async (binding, options) => {
    calls.push({ binding, options });
    assert.equal(binding.runtime, "pi"); assert.match(binding.runtimeProfileId, /^memory-/u);
    assert.deepEqual(options.permissionPolicy, { approvalPolicy: "never", sandbox: "read-only" });
    assert.equal(options.modelOnly, true);
    return { capabilities: { "model.generate.toolFree": true, "model.resolve.toolFree": true, "model.resolve.explicit": true },
      modelsList: async () => ({ data: [{ model: "memory-model", displayName: "Memory", isDefault: true }], nextCursor: null }),
      resolveModelOnly: async () => ({ model: "memory-model", provider: "fixture" }),
      generateModelOnly: async request => { calls.push(request); return { text: '{"summary":"synthetic fact"}' }; } };
  };
  return Object.assign(f, { calls });
}

test("real Coordinator uses only the explicitly configured memory lane and preserves the owning source secret scope", async t => {
  const f = await fixture(t), session = f.createSession(), coordinator = f.service.workRunCoordinator;
  const context = await coordinator.prepareMemoryModelContext({ profileId: f.profile.id, sessionKey: session.sessionKey }, "memory_text");
  const output = await coordinator.generateMemoryText({ profileId: f.profile.id, sessionKey: session.sessionKey,
    operationId: "independent-text", prompt: "Synthetic input", model: context.selectedModel, modelSelection: context, timeoutMs: 1000, maxOutputBytes: 1024 });
  assert.match(output.text, /synthetic fact/u);
  const requests = f.calls.filter(call => call.prompt);
  assert.equal(requests.length, 1); assert.equal(requests[0].model, "memory-model");
  assert.deepEqual(requests[0].modelSecretScope, { profileId: f.profile.id, sessionId: session.sessionKey });
  assert.equal(f.service.workDispatcher.listRuns().length, 0);
});

test("a changed memory config during acquisition rejects generation before any model request", async t => {
  const f = await fixture(t), coordinator = f.service.workRunCoordinator;
  const acquire = f.service.runtimeManager.acquire;
  f.service.runtimeManager.acquire = async (...args) => {
    const host = await acquire(...args), current = f.service.nativeMemoryConfig.read();
    f.service.nativeMemoryConfig.apply({ revision: current.revision + 1, config: { memory: { textModel: { source: "local" } } } });
    return host;
  };
  await assert.rejects(coordinator.generateMemoryText({ profileId: f.profile.id, operationId: "changed-route", prompt: "Synthetic input", timeoutMs: 1000, maxOutputBytes: 1024 }),
    error => ["MEMORY_TEXT_MODEL_DISABLED", "MEMORY_IMPORT_BINDING_STALE"].includes(error.code));
  assert.equal(f.calls.filter(call => call.prompt).length, 0);
});

test("unsupported independent model transport is rejected before Runtime acquisition", async t => {
  const f = await fixture(t), coordinator = f.service.workRunCoordinator;
  f.service.runtimeManager.canGenerateModelOnly = () => false;
  await assert.rejects(coordinator.prepareMemoryModelContext({ profileId: f.profile.id }, "memory_text"), { code: "MODEL_ONLY_UNSUPPORTED" });
  assert.equal(f.calls.length, 0);
});

test("an explicitly selected Codex account from another Agent keeps provider authority distinct from memory ownership", async t => {
  const f = await openHandoffFixture({ serviceOptions: { memoryCore: true, prewarmMcpAuth: false } });
  t.after(() => f.close());
  const store = f.service.productStore, id = require("node:crypto").randomUUID();
  const fields = require("../app/agent-service/product-store").AGENT_PROFILE_FIELDS;
  const origin = store.putAgentProfile({ ...Object.fromEntries(fields.map(key => [key, f.profile[key]])),
    id, agentId: id, runtimeProfileId: id, isDefault: false, name: "Independent model source" });
  const projection = f.service.nativeMemoryConfig.read();
  f.service.nativeMemoryConfig.apply({ revision: projection.revision + 1, config: { memory: { textModel: {
    source: "binding", profileId: id, bindingId: origin.defaultBindingId, model: "fixture-model" } } } });
  let calls = 0;
  f.service.runtimeManager.acquire = async (binding, options) => {
    const route = require("../app/agent-service/execution-provider-route").validateFrozenExecutionProviderRoute(options.executionContract);
    require("../app/agent-service/execution-provider-route").assertExecutionProviderRouteCurrent(route,
      { productStore: store, secretStore: f.service.secretStore });
    assert.equal(route.providerFence.profileId, id);
    assert.equal(binding.runtimeAccountId, origin.runtimeAccountId);
    assert.notEqual(binding.runtimeProfileId, origin.runtimeProfileId);
    assert.deepEqual(options.permissionPolicy, { approvalPolicy: "never", sandbox: "read-only" });
    calls++;
    return { capabilities: { "model.resolve.toolFree": true, "model.resolve.explicit": true },
      modelsList: async () => ({ data: [{ model: "fixture-model", displayName: "Fixture", isDefault: true }], nextCursor: null }),
      resolveModelOnly: async () => ({ model: "fixture-model", provider: "fixture" }) };
  };
  const result = await f.service.workRunCoordinator.prepareMemoryModelContext({ profileId: f.profile.id }, "memory_text");
  assert.equal(calls, 1); assert.equal(result.runtime, "codex"); assert.equal(result.selectedModel, "fixture-model");
});
