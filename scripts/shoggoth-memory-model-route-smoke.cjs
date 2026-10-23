"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");

async function fixture(t, { implicit = false, discovery = true, explicitDiscovery = true } = {}) {
  const memoryCoreConfig = { memory: { search: { provider: "none", rememberAcrossConversations: false } },
    plugins: { entries: { "active-memory": { enabled: true, config: { mode: "always" } } } } };
  const models = ["fixture-model", "pi-chat", "pi-memory"];
  const f = await openHandoffFixture({ catalogs: { codex: ["fixture-model"], pi: models },
    serviceOptions: { memoryCore: true, memoryCoreConfig, prewarmMcpAuth: false } });
  t.after(() => f.close());
  f.facts.read = async () => ({ installed: true, releaseEnabled: true, authenticated: true,
    models, attachmentKinds: [], permissionEnforcementProven: true });
  const selectModel = (sessionKey, model) => f.controller.handle("chat.session.runtime.model.set", {
    profileId: f.profile.id, sessionKey, bindingId: f.binding("pi").id,
    revision: f.service.chatSessionStore.getSession(sessionKey).revision, acceptAdjustments: true, model,
  });
  const initial = f.createSession(); await selectModel(initial.sessionKey, "pi-chat");
  if (implicit) {
    f.service.productStore.putAgentProfile({ ...f.service.productStore.getAgentProfile(f.profile.id), defaultModel: null });
    const current = f.service.chatSessionStore.getSession(initial.sessionKey);
    f.service.chatSessionStore.switchRuntime(initial.sessionKey, { bindingId: f.binding("pi").id,
      revision: current.revision, clearModelOverride: true });
  }
  const owner = f.service.memoryEngine, profileId = f.profile.id;
  memoryCoreConfig.plugins.entries["active-memory"].config.agents = [profileId];
  await owner.propose({ profileId, scope: "agent", type: "semantic", classification: "explicit",
    content: "The model route fixture uses an amber telescope.", sourceRefs: ["user-edit:model-route-fixture"] });
  const calls = [], discoveries = [], acquire = f.service.runtimeManager.acquire.bind(f.service.runtimeManager);
  f.actualDefault = "fixture/model-one";
  f.aliases = new Map();
  f.service.runtimeManager.canGenerateModelOnly = runtime => runtime === "pi";
  f.service.runtimeManager.acquire = async (binding, options) => {
    assert.equal(binding.runtime, "pi", "memory must use the conversation Runtime instead of the Agent default");
    const host = await acquire(binding, options);
    host.capabilities = { "model.generate.toolFree": true, "model.generate.settings": true,
      "model.resolve.toolFree": discovery, "model.resolve.explicit": explicitDiscovery };
    host.resolveModelOnly = async request => {
      assert.equal(Object.hasOwn(request, "prompt"), false);
      const model = request.model ? f.aliases.get(request.model) || request.model : f.actualDefault;
      discoveries.push(model);
      if (f.onDiscovery) await f.onDiscovery(request);
      return { model, provider: "fixture" };
    };
    host.generateModelOnly = async request => {
      calls.push({ model: request.model, runtime: binding.runtime, accountId: binding.runtimeAccountId, execution: request.execution });
      if (f.beforeModelResult) await f.beforeModelResult();
      if (f.modelResult) return f.modelResult(request, calls.length);
      return { text: JSON.stringify(calls.length % 2 === 1 ? { tool: "memory_get", arguments: { path: "MEMORY.md" } }
        : { summary: "The model route fixture uses an amber telescope." }) };
    };
    return host;
  };
  let counter = 0;
  const input = () => ({ profile: f.service.productStore.getAgentProfile(profileId),
    run: { id: `model-route-${++counter}`, profileId, source: "chat", sourceId: initial.sessionKey, workspace: initial.workspace },
    query: "Recall the telescope" });
  const recall = async () => {
    const request = input(); await owner.prepareActiveMemory(request);
    const result = owner.takeActiveMemory(request); await owner.finishActiveMemoryRun(request.run); return result;
  };
  return Object.assign(f, { owner, calls, discoveries, input, recall, selectModel, memoryCoreConfig, sessionKey: initial.sessionKey });
}

test("real Service freezes discovered CLI defaults within a run and keys cross-run recall by the actual model", async t => {
  const f = await fixture(t, { implicit: true });
  const request = f.input();
  await f.owner.prepareActiveMemory(request);
  assert.match(f.owner.takeActiveMemory(request).content, /amber telescope/u);
  assert.deepEqual(f.calls.map(call => call.model), ["fixture/model-one", "fixture/model-one"]);
  f.actualDefault = "fixture/model-two";
  await f.owner.prepareActiveMemory(request);
  assert.match(f.owner.takeActiveMemory(request).content, /amber telescope/u);
  assert.equal(f.calls.length, 2); assert.equal(f.discoveries.length, 1, "a Product run retains its first actual selection");
  await f.owner.finishActiveMemoryRun(request.run);
  assert.match((await f.recall()).content, /amber telescope/u);
  assert.deepEqual(f.calls.map(call => call.model), ["fixture/model-one", "fixture/model-one", "fixture/model-two", "fixture/model-two"]);
  assert.match((await f.recall()).content, /amber telescope/u);
  assert.equal(f.calls.length, 4, "same actual model may reuse native cache after a fresh discovery");
  assert.deepEqual(f.discoveries, ["fixture/model-one", "fixture/model-two", "fixture/model-two"]);
});

test("generic memory generation preserves the host JSON recall protocol without requesting native tools", async t => {
  const f = await fixture(t);
  assert.match((await f.recall()).content, /amber telescope/u);
  const generation = f.transport.acquisitions.filter(row => row.options.executionContract?.source === "memory_extraction");
  assert.ok(generation.length);
  for (const { options } of generation) {
    assert.match(options.executionContract.developerInstructions, /host response protocol/u);
    assert.match(options.executionContract.developerInstructions, /JSON request for a read-only memory lookup/u);
    assert.match(options.executionContract.developerInstructions, /do not attempt native tool calls or external actions/u);
    assert.doesNotMatch(options.executionContract.developerInstructions, /Convert the supplied notes/u);
    assert.deepEqual(options.permissionPolicy, { approvalPolicy: "never", sandbox: "read-only" });
  }
});

test("native eligibility and strong triggers do not acquire an implicit-default Runtime", async t => {
  const f = await fixture(t, { implicit: true }), config = f.memoryCoreConfig.plugins.entries["active-memory"].config;
  f.service.runtimeManager.acquire = async () => { assert.fail("no model is needed for this native policy path"); };
  const recall = async query => {
    const input = { ...f.input(), query };
    await f.owner.prepareActiveMemory(input);
    const result = f.owner.takeActiveMemory(input);
    await f.owner.finishActiveMemoryRun(input.run);
    return result;
  };
  config.agents = [];
  assert.equal((await recall("Recall telescope calibration")).content, "");
  config.agents = [f.profile.id]; config.mode = "escalate";
  assert.match((await recall("Hello there")).content, /intentionally skipped deep recall/u);
  fs.appendFileSync(path.join(f.owner.host(f.profile.id).workspaceDir, "MEMORY.md"),
    "\n- Use concise commit descriptions. <!-- trigger:writing commit; commit descriptions -->\n");
  assert.match((await recall("writing commit descriptions")).content, /concise commit descriptions/u);
  assert.equal(f.calls.length, 0); assert.equal(f.discoveries.length, 0);
  assert.equal(f.service.workRunCoordinator.memoryExtractionTasks.size, 0);
  assert.equal(f.owner.activeMemory.runtimes.size, 0);
});

test("native recall forwards thinking and speed policy through real Service and invalidates cache when changed", async t => {
  const f = await fixture(t), config = f.memoryCoreConfig.plugins.entries["active-memory"].config;
  assert.match((await f.recall()).content, /amber telescope/u);
  assert.ok(f.calls.every(call => call.execution.thinking === "off"));
  assert.equal(f.calls[0].execution.startedAtMs, f.calls[1].execution.startedAtMs, "one recall retains its timer through tool steps");
  config.thinking = "max"; config.fastMode = "auto";
  assert.match((await f.recall()).content, /amber telescope/u);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.calls.slice(2).map(call => ({ thinking: call.execution.thinking, fastMode: call.execution.fastMode })),
    [{ thinking: "max", fastMode: "auto" }, { thinking: "max", fastMode: "auto" }]);
  assert.ok(Number.isSafeInteger(f.calls[2].execution.startedAtMs));
  assert.equal(f.calls[2].execution.startedAtMs, f.calls[3].execution.startedAtMs);
  assert.match((await f.recall()).content, /amber telescope/u); assert.equal(f.calls.length, 4);
  config.fastMode = false;
  assert.match((await f.recall()).content, /amber telescope/u);
  assert.ok(f.calls.slice(4).every(call => call.execution.fastMode === false));
});

test("native recall inherits chat speed while its explicit setting wins and chat thinking stays independent", async t => {
  const f = await fixture(t), config = f.memoryCoreConfig.plugins.entries["active-memory"].config;
  f.service.chatSessionStore.setModelSettings(f.sessionKey, { thinkingLevel: "high", serviceTier: "priority" });
  assert.match((await f.recall()).content, /amber telescope/u);
  assert.ok(f.calls.every(call => call.execution.thinking === "off" && call.execution.fastMode === true));
  config.fastMode = false;
  assert.match((await f.recall()).content, /amber telescope/u);
  assert.ok(f.calls.slice(2).every(call => call.execution.fastMode === false));
  delete config.fastMode;
  f.service.chatSessionStore.setModelSettings(f.sessionKey, { thinkingLevel: "high", serviceTier: null });
  assert.match((await f.recall()).content, /amber telescope/u);
  assert.equal(f.calls.length, 6); assert.ok(f.calls.slice(4).every(call => call.execution.fastMode === false));
});

test("parent cancellation waits for implicit model discovery cleanup before releasing the recall run", async t => {
  const f = await fixture(t, { implicit: true }), controller = new AbortController();
  let started, cleaned = false;
  const ready = new Promise(resolve => { started = resolve; });
  f.onDiscovery = async request => {
    started();
    await new Promise(resolve => request.signal.addEventListener("abort", () => setTimeout(() => { cleaned = true; resolve(); }, 10), { once: true }));
  };
  const request = { ...f.input(), signal: controller.signal }, pending = f.owner.prepareActiveMemory(request);
  await ready; controller.abort(); await pending;
  assert.equal(f.owner.takeActiveMemory(request), null); assert.ok(cleaned);
  assert.equal(f.calls.length, 0); assert.equal(f.service.workRunCoordinator.memoryExtractionTasks.size, 0);
  await f.owner.finishActiveMemoryRun(request.run); assert.equal(f.owner.activeMemory.runs.size, 0);
});

test("native recall follows the real Product conversation Binding/model and an explicit memory model takes precedence", async t => {
  const f = await fixture(t);
  assert.equal(f.service.productStore.resolveAgentRuntimeProfile(f.profile.id).runtime, "codex");
  assert.match((await f.recall()).content, /amber telescope/u);
  assert.deepEqual(f.calls.map(call => call.model), ["pi-chat", "pi-chat"]);
  assert.match((await f.recall()).content, /amber telescope/u); assert.equal(f.calls.length, 2, "native cache avoids another model call");
  f.memoryCoreConfig.plugins.entries["active-memory"].config.model = "pi-memory";
  assert.match((await f.recall()).content, /amber telescope/u);
  assert.deepEqual(f.calls.map(call => call.model), ["pi-chat", "pi-chat", "pi-memory", "pi-memory"]);
  f.memoryCoreConfig.plugins.entries["active-memory"].config.model = "not-in-this-runtime";
  assert.equal((await f.recall()).content, "");
  assert.equal(f.calls.length, 4, "unknown model must not invoke or fall back to another model");
});

test("native modelFallback selects only after absent current/default models and an unverified target stays uncached", async t => {
  const f = await fixture(t, { implicit: true, discovery: false });
  f.memoryCoreConfig.plugins.entries["active-memory"].config.modelFallback = "pi-memory";
  assert.match((await f.recall()).content, /amber telescope/u);
  assert.deepEqual(f.calls.map(call => call.model), ["pi-memory", "pi-memory"]);
  assert.match((await f.recall()).content, /amber telescope/u);
  assert.equal(f.calls.length, 4, "a catalog reference alone does not attest an immutable model identity");
  assert.equal(f.discoveries.length, 0);
  await f.selectModel(f.sessionKey, "pi-chat");
  assert.match((await f.recall()).content, /amber telescope/u);
  assert.deepEqual(f.calls.map(call => call.model), ["pi-memory", "pi-memory", "pi-memory", "pi-memory", "pi-chat", "pi-chat"]);
});

test("explicit recall and parent-chat aliases are frozen within a run and rediscovered before cross-run cache lookup", async t => {
  for (const explicit of [false, true]) {
    const f = await fixture(t), alias = explicit ? "pi-memory" : "pi-chat";
    if (explicit) f.memoryCoreConfig.plugins.entries["active-memory"].config.model = alias;
    f.aliases.set(alias, "fixture/model-one");
    const request = f.input(); await f.owner.prepareActiveMemory(request);
    assert.match(f.owner.takeActiveMemory(request).content, /amber telescope/u);
    f.aliases.set(alias, "fixture/model-two");
    await f.owner.prepareActiveMemory(request); assert.match(f.owner.takeActiveMemory(request).content, /amber telescope/u);
    assert.deepEqual(f.calls.map(call => call.model), ["fixture/model-one", "fixture/model-one"]);
    assert.equal(f.discoveries.length, 1);
    await f.owner.finishActiveMemoryRun(request.run);
    assert.match((await f.recall()).content, /amber telescope/u);
    assert.deepEqual(f.calls.slice(2).map(call => call.model), ["fixture/model-two", "fixture/model-two"]);
    assert.match((await f.recall()).content, /amber telescope/u);
    assert.equal(f.calls.length, 4); assert.deepEqual(f.discoveries, ["fixture/model-one", "fixture/model-two", "fixture/model-two"]);
  }
});

test("an older Runtime cannot silently ignore an explicit model resolution or lend an alias cache to the next run", async t => {
  const f = await fixture(t, { explicitDiscovery: false });
  assert.match((await f.recall()).content, /amber telescope/u);
  assert.match((await f.recall()).content, /amber telescope/u);
  assert.deepEqual(f.calls.map(call => call.model), ["pi-chat", "pi-chat", "pi-chat", "pi-chat"]);
  assert.equal(f.discoveries.length, 0);
});

test("configured aliases use original inheritance and changing their target invalidates recall cache", async t => {
  const f = await fixture(t), config = f.memoryCoreConfig.plugins.entries["active-memory"].config;
  f.memoryCoreConfig.agents = { defaults: { models: { "pi-memory": { alias: "Working Memory" } } } };
  config.model = "working memory";
  assert.match((await f.recall()).content, /amber telescope/u);
  assert.deepEqual(f.calls.map(call => call.model), ["pi-memory", "pi-memory"]);
  assert.match((await f.recall()).content, /amber telescope/u); assert.equal(f.calls.length, 2);
  f.memoryCoreConfig.agents.entries = { [f.profile.id]: { models: { "pi-chat": { alias: "working memory" } } } };
  assert.match((await f.recall()).content, /amber telescope/u);
  assert.deepEqual(f.calls.slice(2).map(call => call.model), ["pi-chat", "pi-chat"]);
  f.memoryCoreConfig.agents.entries[f.profile.id].models["pi-chat"].alias = "";
  f.memoryCoreConfig.agents.entries[f.profile.id].models["pi-memory"] = { alias: "" };
  assert.equal((await f.recall()).content, ""); assert.equal(f.calls.length, 4);
});

test("shared memory completion resolves configured models and rejects a proof after alias settings change", async t => {
  const f = await fixture(t);
  const defaults = { models: { "pi-memory": { alias: "recall" } } };
  f.memoryCoreConfig.agents = { defaults };
  const input = { profileId: f.profile.id, sessionKey: f.sessionKey, model: "recall", prompt: "Synthetic background memory", timeoutMs: 10_000 };
  await f.owner.complete(input);
  assert.equal(f.calls[0].model, "pi-memory");
  const selection = await f.owner.prepareModelContext({ profileId: f.profile.id, sessionKey: f.sessionKey, model: "recall" });
  await assert.rejects(f.owner.complete({ ...input, model: "pi-chat", modelSelection: selection }), { code: "MEMORY_MODEL_SELECTION_INVALID" });
  defaults.models["pi-memory"].alias = "changed";
  await assert.rejects(f.owner.complete({ ...input, model: selection.selectedModel, modelSelection: selection }), { code: "MEMORY_IMPORT_BINDING_STALE" });
  assert.equal(f.calls.length, 1);
});

test("configured alias discovery rechecks settings after asynchronous native confirmation", async t => {
  const f = await fixture(t), config = f.memoryCoreConfig.plugins.entries["active-memory"].config;
  const models = { "pi-memory": { alias: "recall" } }; f.memoryCoreConfig.agents = { defaults: { models } }; config.model = "recall";
  f.onDiscovery = () => { models["pi-memory"].alias = "changed"; };
  await assert.rejects(f.owner.prepareModelContext({ profileId: f.profile.id, sessionKey: f.sessionKey, model: "recall" }),
    { code: "MEMORY_IMPORT_BINDING_STALE" });
  models["pi-memory"].alias = "recall";
  assert.equal(await f.recall(), null, "a changed configuration invalidates the prepared recall receipt");
  assert.equal(f.calls.length, 0);
});

test("a discovered Runtime model takes precedence over modelFallback", async t => {
  const f = await fixture(t, { implicit: true });
  f.memoryCoreConfig.plugins.entries["active-memory"].config.modelFallback = "pi-memory";
  assert.match((await f.recall()).content, /amber telescope/u);
  assert.deepEqual(f.calls.map(call => call.model), ["fixture/model-one", "fixture/model-one"]);
  assert.equal(f.discoveries.length, 1);
});

test("modelFallback never substitutes for a failed selected model or bypasses the catalog", async t => {
  const f = await fixture(t);
  f.memoryCoreConfig.plugins.entries["active-memory"].config.modelFallback = "pi-memory";
  f.modelResult = () => { throw new Error("fixture provider failed"); };
  assert.equal((await f.recall()).content, "");
  assert.deepEqual(f.calls.map(call => call.model), ["pi-chat"]);
  const missing = await fixture(t, { implicit: true, discovery: false });
  missing.memoryCoreConfig.plugins.entries["active-memory"].config.modelFallback = "not-in-this-runtime";
  assert.equal((await missing.recall()).content, "");
  assert.equal(missing.calls.length, 0, "fallback still requires a visible Runtime model");
});

test("real Service forwards streamed recall through Coordinator and native timeout recovery", async t => {
  const f = await fixture(t);
  Object.assign(f.memoryCoreConfig.plugins.entries["active-memory"].config, { timeoutMs: 1_000, setupGraceTimeoutMs: 0 });
  let cleanupFinished = false;
  f.modelResult = async (request, count) => {
    if (count === 1) return { text: '{"tool":"memory_get","arguments":{"path":"MEMORY.md"}}' };
    request.onText('{"summary":"The model route fixture uses an amber telescope.');
    try {
      await new Promise((resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
    } finally { cleanupFinished = true; }
  };
  const result = await f.recall();
  assert.match(result.content, /amber telescope/u); assert.equal(f.calls.length, 2); assert.ok(cleanupFinished);
  assert.equal(f.service.workRunCoordinator.memoryExtractionTasks.size, 0); assert.equal(f.owner.activeMemory.runtimes.size, 0);
  assert.equal(f.owner.activeMemory.cacheProofs.size, 0, "native timeout partials are not reusable cross-turn cache");
});

test("Product model changes invalidate both prepared native cache and in-flight recall results", async t => {
  const f = await fixture(t);
  assert.match((await f.recall()).content, /amber telescope/u);
  const prepared = f.input(); await f.owner.prepareActiveMemory(prepared); assert.equal(f.calls.length, 2);
  await f.selectModel(f.sessionKey, "pi-memory");
  assert.equal(f.owner.takeActiveMemory(prepared), null); await f.owner.finishActiveMemoryRun(prepared.run);
  assert.match((await f.recall()).content, /amber telescope/u);
  assert.deepEqual(f.calls.map(call => call.model), ["pi-chat", "pi-chat", "pi-memory", "pi-memory"]);
  f.owner.activeMemory.cacheProofs.clear();
  f.beforeModelResult = async () => {
    f.service.chatSessionStore.setModelOverride(f.sessionKey, "pi-chat");
  };
  assert.equal(await f.recall(), null);
  assert.equal(f.calls.length, 5);
  assert.equal(f.service.workRunCoordinator.memoryExtractionTasks.size, 0);
  assert.equal(f.owner.activeMemory.runtimes.size, 0);
});
