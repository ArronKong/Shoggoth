#!/usr/bin/env node
"use strict";

// No real dashboard, configuration, launcher, network, or model calls.
const assert = require("node:assert/strict");
const { HermesBackend } = require("../app/core/hermes-backend");
const tests = [];
const test = (name, run) => tests.push({ name, run });
const model = "nvidia/nemotron-3-ultra-550b-a55b:free";
const parentSessionKey = "agent:hermes-test:legacy-parent";
const named = { slug: "openrouter-ai", is_user_defined: true, models: [model] };

function fixture(providers = [named]) {
  const be = new HermesBackend({ getConfig: () => ({ hermesMode: "local", hermesRemotes: [] }) });
  const dash = { baseUrl: "http://fixture.invalid", token: "fixture" };
  const calls = [], reads = [];
  be.profileById.set("hermes-test", "test");
  be.dashboards.set("test", dash);
  be._settingsGet = async (target, endpoint) => {
    assert.equal(target, dash);
    reads.push(endpoint);
    if (endpoint === "/api/model/options") return { providers };
    if (endpoint === "/api/model/info") return { model: "profile-default", provider: "amd" };
    throw new Error(`Unexpected read ${endpoint}`);
  };
  be._gatewayChatEnabled = () => true;
  be._gwSocket = () => ({ generation: 1, request: async (method, params) => {
    calls.push({ method, params });
    assert.equal(method, "session.create");
    return { session_id: "runtime-fixture", stored_session_id: "stored-fixture", info: { lazy: true } };
  } });
  return { be, dash, calls, reads };
}

test("legacy /new resolves a unique provider from the owning profile before create", async () => {
  const { be, calls, reads } = fixture();
  // A global cache can contain another profile's route and is not authoritative.
  be.modelChoices = [{ id: model, provider: "wrong-profile", acpProviderRef: "custom:wrong-profile" }];
  const key = await be.createSession("hermes-test", { model, parentSessionKey });
  assert.equal(key, "agent:hermes-test:stored-fixture");
  assert.deepEqual(reads, ["/api/model/options"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.model, model);
  assert.equal(calls[0].params.provider, "custom:openrouter-ai");
});

test("legacy inheritance carries the same named provider through ACP", async () => {
  const { be, calls } = fixture();
  be._gatewayChatEnabled = () => false;
  be._clientForProfile = () => ({ newSession: async () => "acp-fixture", setSessionModel: async (id, ref) => calls.push({ id, ref }) });
  const key = await be.createSession("hermes-test", { model, parentSessionKey });
  assert.equal(key, "agent:hermes-test:acp-fixture");
  assert.deepEqual(calls, [{ id: "acp-fixture", ref: `custom:openrouter-ai:${model}` }]);
});

for (const [name, providers] of [
  ["unknown", []],
  ["ambiguous", [named, { slug: "another", models: [model] }]],
  ["unavailable", [{ ...named, unavailable_models: [model] }]],
  ["unauthenticated", [{ ...named, authenticated: false }]],
]) test(`${name} inherited model route fails before any session creation`, async () => {
  const { be, calls } = fixture(providers);
  await assert.rejects(be.createSession("hermes-test", { model, parentSessionKey }), error => error.code === "HERMES_MODEL_PROVIDER_UNRESOLVED");
  assert.equal(calls.length, 0);
  assert.equal(be.freshSessionKeys.size, 0);
});

test("catalog duplicates of one runtime provider do not create ambiguity", async () => {
  const { be, calls } = fixture([named, { ...named, models: [{ id: model }] }]);
  await be.createSession("hermes-test", { model, parentSessionKey });
  assert.equal(calls[0].params.provider, "custom:openrouter-ai");
});

test("existing custom prefix is preserved without doubling", async () => {
  const { be, calls } = fixture([{ ...named, slug: "custom:openrouter-ai" }]);
  await be.createSession("hermes-test", { model, parentSessionKey });
  assert.equal(calls[0].params.provider, "custom:openrouter-ai");
});

test("catalog read failure never falls back to the profile default", async () => {
  const { be, calls } = fixture();
  be._settingsGet = async () => { throw new Error("catalog unavailable"); };
  await assert.rejects(be.createSession("hermes-test", { model, parentSessionKey }), /catalog unavailable/);
  assert.equal(calls.length, 0);
});

test("connection change while resolving route prevents creation", async () => {
  const { be, calls } = fixture();
  be._settingsGet = async () => { be._lifecycleGeneration += 1; return { providers: [named] }; };
  await assert.rejects(be.createSession("hermes-test", { model, parentSessionKey }), /连接配置已变化/);
  assert.equal(calls.length, 0);
});

test("explicit provider and explicit reference retain existing selection", async () => {
  const { be, calls, reads } = fixture();
  await be.createSession("hermes-test", { model, provider: "chosen", acpProviderRef: "custom:chosen", parentSessionKey });
  assert.equal(calls[0].params.provider, "custom:chosen");
  assert.deepEqual(reads, []);
});

test("new chat without parent retains the existing default and model-only contract", async () => {
  const { be, calls, reads } = fixture();
  await be.createSession("hermes-test");
  assert.equal(calls[0].params.model, "profile-default");
  assert.equal(calls[0].params.provider, "amd");
  await be.createSession("hermes-test", { model });
  assert.equal(calls[1].params.model, model);
  assert.equal(calls[1].params.provider, undefined);
  assert.deepEqual(reads, ["/api/model/info"]);
});

(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failed += 1; console.error(`FAIL ${name}: ${error.message}`); }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
