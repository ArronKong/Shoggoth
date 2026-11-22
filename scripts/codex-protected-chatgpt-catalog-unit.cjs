"use strict";
// A protected ChatGPT conversation runs on a Codex app-server whose default
// provider is Shoggoth's local projection. Codex 0.167.1 rejects the shared
// models cache there (different provider identity) and its refresh reaches only
// the placeholder loopback address, so that process lists just its bundled
// models. Models delivered by the ChatGPT catalog after the release (such as
// gpt-6.2-sol) are missing from it. Fixtures only; no Codex process or network.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
const { SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");

const BINDING = Object.freeze({ runtime: "codex", runtimeProfileId: "fixture-runtime",
  runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID });
const CHATGPT = Object.freeze({ kind: "chatgpt", configId: "openai" });
const row = (model, defaultReasoningEffort, isDefault = false) => ({ model, displayName: model, description: "",
  isDefault, hidden: false, defaultReasoningEffort });
// Bundled presets of the execution process versus the live ChatGPT catalog.
const BUNDLED = [row("gpt-6.1-sol", "low", true), row("gpt-6-sol", "medium")];
const CHATGPT_CATALOG = [row("gpt-6.2-sol", "low", true), row("gpt-6.1-sol", "medium"), row("gpt-6-sol", "high")];

function fixtureHost(name, models) {
  const host = { name, modelListCalls: 0, turns: [],
    async modelList({ cursor = null } = {}) {
      host.modelListCalls += 1;
      assert.equal(cursor, null);
      return { data: models.map(entry => ({ ...entry })), nextCursor: null };
    },
    async threadStart(params) { host.started = params; return { thread: { id: `${name}-thread` }, model: params.model }; },
    async threadInjectItems() { return {}; },
    async turnStart(params) { host.turns.push(params); return { turn: { id: `${name}-turn` } }; },
  };
  return host;
}

function fixture() {
  const management = fixtureHost("management", CHATGPT_CATALOG);
  const projection = fixtureHost("projection", BUNDLED);
  const gets = [];
  const runtimePool = { async get(binding, options = {}) {
    gets.push(options.modelSecretProviderKind ?? null);
    assert.deepEqual(binding, BINDING);
    return options.modelSecretProviderKind === "chatgpt" ? projection : management;
  } };
  const secretGateway = { async bind() { return { baseUrl: "http://127.0.0.1:9/fixture", close() {} }; } };
  return { management, projection, gets, adapter: new CodexRuntimeAdapter({ runtimePool, secretGateway }) };
}

async function protectedThread(handle, model) {
  const started = await handle.sessionStart({ persistent: true, model, modelProvider: CHATGPT,
    modelSecretScope: { profileId: "fixture-profile", sessionId: "fixture-session" }, cwd: "/fixture/workspace" });
  return started.session.id;
}

test("a protected ChatGPT turn resolves inherited reasoning effort from the ChatGPT catalog", async () => {
  const { adapter, management, projection } = fixture();
  const handle = await adapter.acquire(BINDING, { modelSecretProviderKind: "chatgpt" });
  const sessionId = await protectedThread(handle, "gpt-6.2-sol");
  assert.equal(projection.started.config.model_provider, "shoggoth_local_projection");
  await handle.turnStart({ sessionId, model: "gpt-6.2-sol", prompt: "fixture", operationId: "operation-1",
    thinkingLevel: null, serviceTier: null });
  assert.equal(projection.turns.length, 1);
  assert.equal(projection.turns[0].model, "gpt-6.2-sol");
  assert.equal(projection.turns[0].effort, "low");
  // The catalog default of a bundled model also follows the ChatGPT catalog.
  await handle.turnStart({ sessionId, model: "gpt-6-sol", prompt: "fixture", operationId: "operation-2",
    thinkingLevel: null, serviceTier: null });
  assert.equal(projection.turns[1].effort, "high");
  assert.equal(projection.modelListCalls, 0, "the projection process's bundled list is not a catalog authority");
  assert.equal(management.modelListCalls, 2);
  assert.equal(management.turns.length, 0, "only the catalog is read from the management process");
});

test("a protected ChatGPT handle lists the ChatGPT catalog for model checks", async () => {
  const { adapter, projection } = fixture();
  const handle = await adapter.acquire(BINDING, { modelSecretProviderKind: "chatgpt" });
  const listed = await handle.modelsList({ cursor: null, limit: 64 });
  assert.deepEqual(listed.data.map(entry => entry.model), ["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6-sol"]);
  assert.equal(projection.modelListCalls, 0);
});

test("an explicit effort or an unprotected ChatGPT host keeps the execution process catalog", async () => {
  const { adapter, management, projection, gets } = fixture();
  const handle = await adapter.acquire(BINDING, { modelSecretProviderKind: "chatgpt" });
  const sessionId = await protectedThread(handle, "gpt-6.2-sol");
  await handle.turnStart({ sessionId, model: "gpt-6.2-sol", prompt: "fixture", operationId: "explicit",
    thinkingLevel: "xhigh", serviceTier: null });
  assert.equal(projection.turns[0].effort, "xhigh");
  assert.equal(management.modelListCalls + projection.modelListCalls, 0);
  assert.deepEqual(gets, ["chatgpt"], "an explicit effort needs no catalog");

  const plain = await adapter.acquire(BINDING);
  assert.equal(plain.host, management);
  const listed = await plain.modelsList({ cursor: null, limit: 64 });
  assert.equal(listed.data[0].model, "gpt-6.2-sol");
  assert.deepEqual(gets, ["chatgpt", null], "the management host reads its own catalog");
});

// Codex lets only the host that started or resumed a thread write it. Deleting
// a just-used protected conversation through the management host failed with
// "already has an active writer" (2026-11-21), leaving a durable delete_pending.
test("session maintenance reuses the live host that owns the native thread", async () => {
  const { adapter, management, projection, gets } = fixture();
  const owner = await adapter.acquire(BINDING, { modelSecretProviderKind: "chatgpt" });
  const sessionId = await protectedThread(owner, "gpt-6.2-sol");
  assert.equal(owner.host, projection);

  const affine = await adapter.acquire(BINDING, { sessionAffinity: sessionId, workspace: "/fixture/workspace" });
  assert.equal(affine, owner, "the writer host handles rename/archive/delete of its own thread");
  assert.deepEqual(gets, ["chatgpt"], "no extra host is acquired for the owned thread");

  const unknown = await adapter.acquire(BINDING, { sessionAffinity: "another-thread" });
  assert.equal(unknown.host, management, "a thread no live host owns keeps the default host");
  const other = await adapter.acquire({ ...BINDING, runtimeProfileId: "other-runtime" }, { sessionAffinity: sessionId })
    .catch(error => error);
  assert.ok(other instanceof Error || other.host !== projection, "affinity never crosses Bindings");
});
