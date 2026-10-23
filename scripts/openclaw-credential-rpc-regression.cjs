#!/usr/bin/env node
"use strict";

// OpenClaw credential writes through the official Control UI RPCs
// (models.authStatus / models.authSetApiKey / models.authLogout), against an
// in-process Gateway fake that follows the 2026.9.5 handler semantics: a
// provider with a config connection gets one shared key bound through
// models.providers.<id>.apiKey; other providers write per Agent scope. No real
// Gateway, CLI process, SQLite store or credential is touched.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { OpenClawBackend } = require("../app/core/openclaw-backend");

const RPC_METHODS = ["config.get", "config.patch", "models.authStatus", "models.authSetApiKey", "models.authLogout"];

function merge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete target[key];
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      target[key] ||= {};
      merge(target[key], value);
    } else target[key] = structuredClone(value);
  }
}

/** A Gateway fake with one shared credential store plus per-Agent stores. */
function gateway({ agents = ["main", "cto", "ada"], config, store = [] }) {
  const calls = [];
  let revision = 0;
  const owns = (agentId, row) => (agentId === agents[0] ? row.shared || row.agent === agentId : !row.shared && row.agent === agentId);
  const visible = (agentId) => store.filter((row) => row.shared || row.agent === agentId);
  const dropProfileConfig = (id) => {
    delete config.auth?.profiles?.[id];
    for (const [provider, order] of Object.entries(config.auth?.order || {})) {
      const next = order.filter((value) => value !== id);
      if (next.length) config.auth.order[provider] = next; else delete config.auth.order[provider];
    }
    for (const entry of Object.values(config.models?.providers || {})) if (entry.apiKey === id) delete entry.apiKey;
  };
  const request = async (method, params = {}) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === "config.patch") {
      merge(config, JSON.parse(params.raw));
      revision += 1;
      return {};
    }
    if (method === "models.authStatus") {
      const rows = visible(params.agentId);
      return { providers: [...new Set(rows.map((row) => row.provider))].map((provider) => ({ provider, profiles: rows
        .filter((row) => row.provider === provider).map((row) => ({ profileId: row.id, type: row.type, logoutSupported: true,
          source: config.models?.providers?.[provider]?.apiKey === row.id ? "config"
            : row.shared ? (params.agentId === agents[0] ? "saved" : "inherited") : "saved" })) })) };
    }
    if (method === "models.authSetApiKey") {
      const { provider, apiKey, agentId } = params;
      config.auth ||= {};
      config.auth.profiles ||= {};
      const connection = config.models?.providers?.[provider];
      if (connection) {
        const bound = typeof connection.apiKey === "string" && store.some((row) => row.shared && row.id === connection.apiKey)
          ? connection.apiKey : null;
        const profileId = bound || `${provider}:manual`;
        const row = store.find((item) => item.shared && item.id === profileId);
        if (row) row.key = apiKey;
        else store.push({ agent: agents[0], shared: true, id: profileId, provider, type: "api_key", key: apiKey });
        config.auth.profiles[profileId] = { provider, mode: "api_key" };
        connection.apiKey = profileId;
        return { provider, profileId };
      }
      const local = store.find((row) => !row.shared && row.agent === agentId && row.provider === provider && row.type === "api_key");
      const shared = store.find((row) => row.shared && row.provider === provider && row.type === "api_key");
      const target = local || shared;
      const profileId = target ? target.id : `${provider}:manual`;
      if (target) target.key = apiKey;
      else store.push({ agent: agents[0], shared: true, id: profileId, provider, type: "api_key", key: apiKey });
      config.auth.profiles[profileId] = { provider, mode: "api_key" };
      return { provider, profileId };
    }
    if (method === "models.authLogout") {
      const { provider, agentId } = params;
      const ids = params.profileIds || store.filter((row) => owns(agentId, row) && row.provider === provider
        && row.type === "api_key").map((row) => row.id);
      for (const id of ids) {
        const index = store.findIndex((row) => row.id === id && row.provider === provider && owns(agentId, row));
        if (index === -1) throw Object.assign(new Error("profileIds contain unavailable auth profiles"), { code: "INVALID_REQUEST" });
        store.splice(index, 1);
        dropProfileConfig(id);
      }
      return { provider, removedProfiles: ids };
    }
    throw new Error(`unexpected Gateway method ${method}`);
  };
  return { agents, config, store, calls, request, revision: () => revision };
}

function backendFor(gw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-credential-rpc-"));
  const backend = new OpenClawBackend();
  backend._isLocalGateway = () => true;
  backend._modelAuthCliVersionOverride = "2026.9.5";
  backend._modelAuthAgentIdsOverride = gw.agents;
  backend._gatewayHello = { features: { methods: RPC_METHODS } };
  backend._connect = async () => {};
  backend._configSnapshot = async () => ({ parsed: structuredClone(gw.config), hash: `hash-${gw.revision()}` });
  backend._pathsNeedRestart = async () => false;
  backend._patchRetryDelaysMs = [0];
  backend._registryPathOverride = path.join(dir, "registry.json");
  backend._authProfilesPathOverride = path.join(dir, "legacy-auth-profiles.json");
  backend._runModelAuthCli = async () => { throw new Error("the official credential RPC must replace the CLI"); };
  backend._syncAgentSqliteAuthKey = () => { throw new Error("SQLite stores must not be written directly"); };
  backend._writeAuthProfiles = () => { throw new Error("legacy auth-profiles.json must not be written"); };
  backend._purgeAgentShadowRegistries = () => {};
  backend.request = gw.request;
  return { backend, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function recordingContext() {
  const stages = [];
  const patches = [];
  return {
    stages,
    patches,
    journalEntry: { fingerprints: {} },
    assertProviderLease() {},
    recordStage: async (stage, patch = {}) => { stages.push([stage, patch.secretStep ?? null]); patches.push(patch); },
  };
}

const rows = (gw) => gw.store.map(({ agent, shared, id, key, type }) => [shared ? "shared" : agent, id, type, key ?? null]);
const methods = (gw) => gw.calls.map((call) => call.method);
const secretOnlyInKeyCalls = (gw, secret) => JSON.stringify(gw.calls.filter((call) => call.method !== "models.authSetApiKey"))
  .includes(secret) === false;

test("credential mutation keeps one RPC alive through a 70-second Gateway refresh", async (t) => {
  for (const method of ["models.authSetApiKey", "models.authLogout"]) await t.test(method, async (t) => {
    const gw = gateway({ agents: ["main"], config: { models: { providers: { custom: { models: [{ id: "test" }] } } } },
      store: [{ agent: "main", shared: true, id: "custom:manual", provider: "custom", type: "api_key", key: "old-fixture" }] });
    const { backend, cleanup } = backendFor(gw);
    let sent;
    const dispatched = new Promise((resolve) => { sent = resolve; });
    backend._isGatewaySocketCurrent = () => true;
    backend._ws = { readyState: 1, send(payload) {
      const request = JSON.parse(payload);
      const respond = async () => {
        const result = await gw.request(request.method, request.params);
        const pending = backend._pending.get(request.id);
        backend._pending.delete(request.id);
        pending?.resolve(result);
      };
      if (request.method === method) { setTimeout(() => { void respond(); }, 70_088); sent(); }
      else queueMicrotask(() => { void respond(); });
    } };
    backend.request = require("../app/core/openclaw-backend").OpenClawBackend.prototype.request.bind(backend);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const mutation = method === "models.authSetApiKey"
        ? backend._saveProviderApiKeyViaGateway("custom", "new-fixture")
        : backend._clearProviderApiKeysViaGateway("custom");
      // Attach immediately so a premature timeout is reported by the assertion.
      const outcome = mutation.then((value) => ({ value }), (error) => ({ error }));
      await dispatched;
      t.mock.timers.tick(70_088);
      const result = await outcome;
      assert.equal(result.error, undefined, "a persisted write must not lose its success receipt at 30 seconds");
      assert.equal(gw.calls.filter((call) => call.method === method).length, 1, "never retry a credential mutation");
      assert.equal(backend._pending.size, 0);
    } finally { t.mock.timers.reset(); cleanup(); }
  });
});

test("a saved credential with a failed Gateway refresh requires activation without replaying the write", async (t) => {
  for (const kind of ["create", "update-provider", "clear"]) await t.test(kind, async () => {
    const gw = gateway({ agents: ["main"], config: { models: { providers: kind === "create" ? {} : {
      custom: { baseUrl: "https://fixture.test/v1", api: "openai-completions", models: [{ id: "test" }] },
    } }, agents: { defaults: { modelPolicy: { allow: [] } } } },
    store: kind === "clear" ? [{ agent: "main", shared: true, id: "custom:manual", provider: "custom", type: "api_key", key: "old" }] : [] });
    const originalRequest = gw.request;
    gw.request = async (...args) => {
      const result = await originalRequest(...args);
      return args[0] === (kind === "clear" ? "models.authLogout" : "models.authSetApiKey")
        ? { ...result, warning: "Saved, but Gateway refresh failed; restart required." } : result;
    };
    const { backend, cleanup } = backendFor(gw);
    try {
      const context = recordingContext();
      const spec = kind === "create"
        ? { kind, providerKey: "custom", providerMode: "new", baseUrl: "https://fixture.test/v1", model: { id: "test" } }
        : { kind: "update-provider", providerKey: "custom", patch: kind === "clear" ? { clearApiKey: true } : {} };
      const result = await backend.applyModelChangeConfigOnly(spec, context, kind === "clear" ? null : { apiKey: "test-key" });
      assert.equal(result.status, "applied", "the official success receipt proves that the credential was saved");
      assert.equal(result.restartRequired, true, "refresh failure must not be reported as already active");
      assert.ok(context.patches.some(patch => patch.fingerprints?.configOnlyRestartRequired === true), "activation survives receipt recovery");
      assert.equal(gw.calls.filter(call => call.method === (kind === "clear" ? "models.authLogout" : "models.authSetApiKey")).length, 1);
      assert.equal(JSON.stringify(context.patches).includes("test-key"), false);
    } finally { cleanup(); }
  });
});

test("a missing credential receipt times out after two minutes without repeating a persisted write", async (t) => {
  const gw = gateway({ agents: ["main"], config: { models: { providers: { custom: { models: [{ id: "test" }] } } } } });
  const { backend, cleanup } = backendFor(gw);
  let dispatched;
  const sent = new Promise(resolve => { dispatched = resolve; });
  backend._isGatewaySocketCurrent = () => true;
  backend._ws = { readyState: 1, send(payload) {
    const request = JSON.parse(payload);
    const response = gw.request(request.method, request.params);
    if (request.method !== "models.authSetApiKey") {
      // Status reads are answered; only the credential write loses its receipt.
      void response.then((result) => {
        const entry = backend._pending.get(request.id);
        backend._pending.delete(request.id);
        entry?.resolve(result);
      });
      return;
    }
    void response.then(dispatched);
    // The Gateway saves the key, but no response reaches the pending RPC.
  } };
  backend.request = OpenClawBackend.prototype.request.bind(backend);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let settled = false;
    const outcome = backend._saveProviderApiKeyViaGateway("custom", "fixture-secret").then(
      value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    await sent;
    t.mock.timers.tick(119_999);
    await Promise.resolve();
    assert.equal(settled, false, "keep waiting for the original success receipt");
    t.mock.timers.tick(1);
    const result = await outcome;
    assert.match(result.error?.message || "", /models\.authSetApiKey timeout/);
    assert.equal(gw.calls.filter(call => call.method === "models.authSetApiKey").length, 1);
    assert.equal(gw.store[0].key, "fixture-secret", "the unknown receipt must not be mistaken for a rejected write");
    assert.equal(backend._pending.size, 0);
  } finally { t.mock.timers.reset(); cleanup(); }
});

test("warnings from secondary Agent cleanup and Provider card mutations also require a restart", async (t) => {
  for (const action of ["endpoint-edit", "card-save", "card-clear", "profile-delete"]) await t.test(action, async () => {
    const gw = gateway({ agents: ["main", "cto"], config: { models: { providers: action === "endpoint-edit"
      ? { custom: { models: [{ id: "test" }] } } : {} } }, store: [
      { agent: "main", shared: true, id: "custom:manual", provider: "custom", type: "api_key", key: "old" },
      { agent: "cto", shared: false, id: "custom:default", provider: "custom", type: "api_key", key: "old" },
    ] });
    const originalRequest = gw.request;
    gw.request = async (method, params) => {
      const result = await originalRequest(method, params);
      // The owner save is healthy; only the secondary Agent refresh fails.
      return ["models.authSetApiKey", "models.authLogout"].includes(method) && (params.agentId === "cto" || action === "profile-delete")
        ? { ...result, warning: "Saved, but refresh failed." } : result;
    };
    const { backend, cleanup } = backendFor(gw);
    try {
      if (action === "endpoint-edit") {
        const result = await backend.applyModelChangeConfigOnly({ kind: "update-provider", providerKey: "custom", patch: {} },
          recordingContext(), { apiKey: "new" });
        assert.equal(result.restartRequired, true);
      } else {
        const result = action === "card-save" ? await backend.setModelAuthProfileKey("custom", "new")
          : action === "card-clear" ? await backend.clearModelAuthProviderKeys("custom")
          : await backend.deleteModelAuthProfile("custom:manual");
        assert.deepEqual(result.activation, { kind: "gateway_restart", available: true });
      }
    } finally { cleanup(); }
  });
});

test("deleting an endpoint or its last model preserves a credential refresh warning", async (t) => {
  for (const kind of ["delete-provider", "delete-model", "batch"]) await t.test(kind, async () => {
    const gw = gateway({ agents: ["main"], config: { models: { providers: {
      custom: { baseUrl: "https://fixture.test/v1", models: [{ id: "test" }] },
    } }, agents: { defaults: { modelPolicy: { allow: ["custom/test"] } }, entries: { main: {} } } },
    store: [{ agent: "main", shared: true, id: "custom:manual", provider: "custom", type: "api_key", key: "old" }] });
    const request = gw.request;
    gw.request = async (...args) => {
      const result = await request(...args);
      return args[0] === "models.authLogout" ? { ...result, warning: "Saved, but refresh failed." } : result;
    };
    const { backend, cleanup } = backendFor(gw);
    try {
      const spec = { kind: kind === "batch" ? "delete-model" : kind, providerKey: "custom", sourceModelId: "test" };
      const result = kind === "batch" ? await backend.applyModelChangeConfigOnlyBatch([spec])
        : await backend.applyModelChangeConfigOnly(spec, recordingContext(), null);
      assert.equal(result.status, "applied");
      assert.equal(result.restartRequired, true);
      assert.equal(gw.config.models.providers.custom, undefined);
      assert.deepEqual(rows(gw), []);
      assert.equal(gw.calls.filter(call => call.method === "models.authLogout").length, 1);
    } finally { cleanup(); }
  });
});

test("new custom endpoint writes config first, then one official key save bound to the connection", async () => {
  const gw = gateway({ config: {
    models: { providers: {} },
    agents: { defaults: { modelPolicy: { allow: [] } }, entries: { main: {}, cto: {}, ada: {} } },
    auth: { profiles: {} },
  } });
  const { backend, cleanup } = backendFor(gw);
  try {
    const context = recordingContext();
    const result = await backend.applyModelChangeConfigOnly({ kind: "create", providerKey: "xmxm", providerMode: "new",
      baseUrl: "https://mimo.example/v1", api: "openai-completions", model: { id: "mimo-v2.6-flash" } },
    context, { apiKey: "sk-create-secret" });
    assert.equal(result.status, "applied");
    assert.equal(result.restartRequired, false, "the key is live without a Gateway restart");
    const order = methods(gw);
    assert.ok(order.indexOf("config.patch") < order.indexOf("models.authSetApiKey"), "the connection exists before its key is saved");
    assert.deepEqual(gw.calls.find((call) => call.method === "models.authSetApiKey").params,
      { provider: "xmxm", apiKey: "sk-create-secret", agentId: "main" });
    assert.equal(order.filter((method) => method === "models.authSetApiKey").length, 1, "one save covers every Agent");
    assert.equal(gw.config.models.providers.xmxm.apiKey, "xmxm:manual", "the connection is bound to the saved profile");
    assert.deepEqual(rows(gw), [["shared", "xmxm:manual", "api_key", "sk-create-secret"]]);
    assert.deepEqual(context.stages, [["config-write-pending", null], ["credential-write", null], ["credential-write", "applied"], ["config-write", "applied"]]);
    assert.ok(secretOnlyInKeyCalls(gw, "sk-create-secret"), "the key never enters config.patch or other calls");
  } finally { cleanup(); }
});

test("editing an endpoint key binds one shared key and logs out every legacy per-Agent copy", async () => {
  const gw = gateway({
    config: {
      models: { providers: { qclaw: { baseUrl: "https://old.example/v1", api: "openai-completions", models: [{ id: "modelroute" }] } } },
      auth: { profiles: { "qclaw:default": { provider: "qclaw", mode: "api_key" } }, order: { qclaw: ["qclaw:default"] } },
    },
    store: [
      { agent: "main", shared: true, id: "qclaw:default", provider: "qclaw", type: "api_key", key: "sk-old" },
      { agent: "cto", shared: false, id: "qclaw:default", provider: "qclaw", type: "api_key", key: "sk-old" },
      { agent: "ada", shared: false, id: "qclaw:default", provider: "qclaw", type: "api_key", key: "sk-old" },
    ],
  });
  const { backend, cleanup } = backendFor(gw);
  try {
    const context = recordingContext();
    const result = await backend.applyModelChangeConfigOnly({ kind: "update-provider", providerKey: "qclaw",
      patch: { baseUrl: "https://new.example/v1" } }, context, { apiKey: "sk-edited" });
    assert.equal(result.status, "applied");
    const patch = JSON.parse(gw.calls.find((call) => call.method === "config.patch").params.raw);
    assert.deepEqual(patch.models.providers.qclaw, { baseUrl: "https://new.example/v1" }, "the endpoint patch never clears the binding");
    assert.deepEqual(gw.calls.filter((call) => call.method === "models.authLogout").map((call) => [call.params.agentId, call.params.profileIds]),
      [["main", ["qclaw:default"]], ["cto", ["qclaw:default"]], ["ada", ["qclaw:default"]]]);
    assert.deepEqual(rows(gw), [["shared", "qclaw:manual", "api_key", "sk-edited"]]);
    assert.equal(gw.config.models.providers.qclaw.apiKey, "qclaw:manual");
    assert.deepEqual(Object.keys(gw.config.auth.profiles), ["qclaw:manual"]);
    assert.equal(gw.config.auth.order?.qclaw, undefined, "the retired profile leaves no auth-order entry");
    assert.ok(context.stages.some(([stage, secret]) => stage === "credential-write" && secret === "applied"));
    assert.ok(secretOnlyInKeyCalls(gw, "sk-edited"));
  } finally { cleanup(); }
});

test("clearing an endpoint key removes the binding, the shared key and every Agent copy", async () => {
  const gw = gateway({
    config: {
      models: { providers: { qclaw: { baseUrl: "https://new.example/v1", api: "openai-completions", apiKey: "qclaw:manual",
        models: [{ id: "modelroute" }] } } },
      auth: { profiles: { "qclaw:manual": { provider: "qclaw", mode: "api_key" }, "qclaw:default": { provider: "qclaw", mode: "api_key" } } },
    },
    store: [
      { agent: "main", shared: true, id: "qclaw:manual", provider: "qclaw", type: "api_key", key: "sk-edited" },
      { agent: "cto", shared: false, id: "qclaw:default", provider: "qclaw", type: "api_key", key: "sk-old" },
    ],
  });
  const { backend, cleanup } = backendFor(gw);
  try {
    const result = await backend.applyModelChangeConfigOnly({ kind: "update-provider", providerKey: "qclaw",
      patch: { clearApiKey: true } }, recordingContext(), null);
    assert.equal(result.status, "applied");
    assert.deepEqual(JSON.parse(gw.calls.find((call) => call.method === "config.patch").params.raw).models.providers.qclaw,
      { apiKey: null });
    assert.deepEqual(rows(gw), [], "no Agent keeps the cleared key");
    assert.equal(gw.config.models.providers.qclaw.apiKey, undefined);
    assert.deepEqual(gw.config.auth.profiles, {});
  } finally { cleanup(); }
});

test("Provider card key save updates the shared key and each Agent's local override, without a restart", async () => {
  const gw = gateway({
    config: { models: { providers: {} }, auth: { profiles: { "openrouter:default": { provider: "openrouter", mode: "api_key" },
      "openrouter:team": { provider: "openrouter", mode: "oauth" } } } },
    store: [
      { agent: "main", shared: true, id: "openrouter:default", provider: "openrouter", type: "api_key", key: "sk-or-old" },
      { agent: "main", shared: true, id: "openrouter:team", provider: "openrouter", type: "oauth" },
      { agent: "cto", shared: false, id: "openrouter:default", provider: "openrouter", type: "api_key", key: "sk-or-stale" },
    ],
  });
  const { backend, cleanup } = backendFor(gw);
  try {
    const result = await backend.setModelAuthProfileKey("openrouter", "sk-or-new");
    assert.deepEqual(result, { ok: true, id: "openrouter:default", activation: null });
    assert.deepEqual(gw.calls.filter((call) => call.method === "models.authSetApiKey").map((call) => call.params.agentId),
      ["main", "cto"], "only Agents with their own override are written again; ada inherits the shared key");
    assert.deepEqual(rows(gw), [
      ["shared", "openrouter:default", "api_key", "sk-or-new"],
      ["shared", "openrouter:team", "oauth", null],
      ["cto", "openrouter:default", "api_key", "sk-or-new"],
    ]);
    assert.ok(secretOnlyInKeyCalls(gw, "sk-or-new"));
  } finally { cleanup(); }
});

test("Provider card clear removes every API key of the provider but keeps sign-ins", async () => {
  const gw = gateway({
    config: { models: { providers: {} }, auth: { profiles: { "openrouter:manual": { provider: "openrouter", mode: "api_key" } } } },
    store: [
      { agent: "main", shared: true, id: "openrouter:manual", provider: "openrouter", type: "api_key", key: "sk-or" },
      { agent: "main", shared: true, id: "openrouter:team", provider: "openrouter", type: "oauth" },
      { agent: "ada", shared: false, id: "openrouter:default", provider: "openrouter", type: "api_key", key: "sk-or-stale" },
    ],
  });
  const { backend, cleanup } = backendFor(gw);
  try {
    const result = await backend.clearModelAuthProviderKeys("openrouter");
    assert.deepEqual(result, { ok: true, provider: "openrouter", removed: 2, activation: null });
    assert.deepEqual(rows(gw), [["shared", "openrouter:team", "oauth", null]]);
    assert.deepEqual(gw.config.auth.profiles, {});
  } finally { cleanup(); }
});

test("key save and clear read every Agent's view once, in parallel, before the first write", async (t) => {
  for (const action of ["card-save", "endpoint-edit", "card-clear"]) await t.test(action, async () => {
    const gw = gateway({
      config: { models: { providers: action === "endpoint-edit" ? { qclaw: { models: [{ id: "modelroute" }] } } : {} },
        auth: { profiles: {} } },
      store: [
        { agent: "main", shared: true, id: "qclaw:default", provider: "qclaw", type: "api_key", key: "sk-old" },
        { agent: "cto", shared: false, id: "qclaw:default", provider: "qclaw", type: "api_key", key: "sk-old" },
        { agent: "ada", shared: false, id: "qclaw:default", provider: "qclaw", type: "api_key", key: "sk-old" },
      ],
    });
    const { backend, cleanup } = backendFor(gw);
    let inFlight = 0;
    let maxInFlight = 0;
    const answer = gw.request;
    backend.request = async (method, params) => {
      if (method !== "models.authStatus") return answer(method, params);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return answer(method, params);
    };
    try {
      if (action === "card-save") await backend.setModelAuthProfileKey("qclaw", "sk-new");
      else if (action === "endpoint-edit") await backend._saveProviderApiKeyViaGateway("qclaw", "sk-new");
      else await backend.clearModelAuthProviderKeys("qclaw");
      const order = methods(gw);
      const firstWrite = order.findIndex((method) => method !== "models.authStatus");
      assert.deepEqual(order.slice(0, firstWrite).sort(), ["models.authStatus", "models.authStatus", "models.authStatus"]);
      assert.equal(order.slice(firstWrite).includes("models.authStatus"), false, "no status read between writes");
      assert.equal(maxInFlight, 3, "the three Agent views are read concurrently");
    } finally { cleanup(); }
  });
});

test("Provider directory counts a key that only exists in the credential store", async (t) => {
  for (const readable of [true, false]) await t.test(readable ? "authStatus view" : "config fallback", async () => {
    const gw = gateway({
      config: { models: { providers: {} }, auth: { profiles: {} } },
      store: [{ agent: "main", shared: true, id: "openrouter:default", provider: "openrouter", type: "api_key", key: "sk-or" }],
    });
    const { backend, cleanup } = backendFor(gw);
    backend._localKeyDigests = async () => new Map();
    if (!readable) backend._gatewayAuthProfileRows = async () => { throw new Error("status unavailable"); };
    try {
      const { providers } = await backend.getProviderDirectory();
      const openrouter = providers.find((entry) => entry.id === "openrouter");
      assert.equal(openrouter?.key.configured, readable, "config auth.profiles is optional metadata");
      assert.equal(openrouter?.key.clearable, readable);
      assert.equal(openrouter?.configured, readable);
    } finally { cleanup(); }
  });
});

test("deleting one profile uses its stored provider, and an unknown profile stays a 404", async () => {
  const gw = gateway({
    config: { models: { providers: {} }, auth: { profiles: {} } },
    store: [{ agent: "main", shared: true, id: "anthropic:claude-cli", provider: "claude-cli", type: "oauth" }],
  });
  const { backend, cleanup } = backendFor(gw);
  try {
    assert.deepEqual(await backend.deleteModelAuthProfile("anthropic:claude-cli"), { ok: true, id: "anthropic:claude-cli", activation: null });
    assert.deepEqual(gw.calls.find((call) => call.method === "models.authLogout").params,
      { provider: "claude-cli", agentId: "main", profileIds: ["anthropic:claude-cli"] });
    assert.deepEqual(rows(gw), []);
    await assert.rejects(backend.deleteModelAuthProfile("anthropic:claude-cli"), { code: "auth_profile_not_found", status: 404 });
  } finally { cleanup(); }
});

test("auth profile list comes from models.authStatus with the CLI-compatible shape and no key material", async () => {
  const gw = gateway({
    config: { models: { providers: {} }, auth: { profiles: {} } },
    store: [
      { agent: "main", shared: true, id: "deepseek:default", provider: "deepseek", type: "api_key", key: "sk-never-listed" },
      { agent: "cto", shared: false, id: "cto:only", provider: "cto", type: "api_key", key: "sk-other-agent" },
    ],
  });
  const { backend, cleanup } = backendFor(gw);
  try {
    const listed = await backend.listModelAuthProfiles();
    assert.deepEqual(listed, { supported: true, profiles: [
      { id: "deepseek:default", provider: "deepseek", type: "api_key", source: "canonical" },
    ] });
    assert.deepEqual(gw.calls.map((call) => [call.method, call.params.agentId]), [["models.authStatus", "main"]]);
    assert.equal(JSON.stringify(listed).includes("sk-"), false);
  } finally { cleanup(); }
});

test("a Gateway without the official methods keeps the CLI path and is never connected just to check", async () => {
  const { backend, cleanup } = backendFor(gateway({ config: { models: { providers: {} } } }));
  try {
    let connects = 0;
    backend._connect = async () => { connects += 1; };
    backend._gatewayHello = null;
    assert.equal(await backend._usesGatewayCredentialRpc(), false, "no hello yet: never probe by connecting");
    backend._gatewayHello = { features: { methods: ["config.get", "config.patch", "models.authStatus"] } };
    assert.equal(await backend._usesGatewayCredentialRpc(), false, "a partial method set is not the official channel");
    assert.equal(connects, 0);
    const cli = [];
    backend._modelAuthCliVersionOverride = "2026.9.1";
    backend._modelAuthAgentIdsOverride = ["main"];
    backend._runModelAuthCli = async (args, options = {}) => {
      cli.push(args.slice(0, 3).join(" "));
      if (args[2] === "list") return { profiles: [] };
      assert.equal(args.includes(options.stdin), false);
      return {};
    };
    assert.deepEqual(await backend.setModelAuthProfileKey("openrouter", "sk-cli"),
      { ok: true, id: "openrouter:default", activation: { kind: "gateway_restart", available: true } });
    assert.deepEqual(cli, ["models auth list", "models auth paste-api-key"]);
  } finally { cleanup(); }
});

test("a Gateway that announced the official methods is reconnected after a drop instead of falling back", async () => {
  const { backend, cleanup } = backendFor(gateway({ config: { models: { providers: {} } } }));
  try {
    backend._acceptGatewayHello({ type: "hello-ok", protocol: 4, server: { version: "2026.9.5", connId: "fixture" },
      features: { methods: RPC_METHODS, events: [], capabilities: [] },
      auth: { role: "operator", scopes: ["operator.admin"] }, policy: { maxPayload: 100000, maxBufferedBytes: 200000 } });
    const hello = backend._gatewayHello;
    backend._gatewayHello = null;
    let connects = 0;
    backend._connect = async () => { connects += 1; backend._gatewayHello = hello; };
    assert.equal(await backend._usesGatewayCredentialRpc(), true);
    assert.equal(connects, 1);
  } finally { cleanup(); }
});

test("endpoint readback skips the forced usage refresh only right after this process changed credentials", async () => {
  const gw = gateway({ config: { models: { providers: {} } },
    store: [{ agent: "main", shared: true, id: "custom:manual", provider: "custom", type: "api_key", key: "sk" }] });
  const { backend, cleanup } = backendFor(gw);
  try {
    await backend._loadEndpointAuthKeyProfiles();
    backend._noteGatewayCredentialMutation();
    await backend._loadEndpointAuthKeyProfiles();
    backend._credentialRpcMutatedAt = Date.now() - 61_000;
    await backend._loadEndpointAuthKeyProfiles();
    assert.deepEqual(gw.calls.map((call) => call.params), [
      { agentId: "main", refresh: true },
      { agentId: "main" },
      { agentId: "main", refresh: true },
    ]);
  } finally { cleanup(); }
});

test("an unpublished model catalog is re-read on the same connection before failing", async () => {
  const notReady = () => Object.assign(new Error("Error: Model catalog is not ready. Retry after Gateway startup or refresh finishes."),
    { code: "UNAVAILABLE" });
  for (const [failures, succeeds] of [[2, true], [3, false]]) {
    const backend = new OpenClawBackend();
    let reads = 0;
    backend._configSnapshot = async () => ({ parsed: { models: { providers: {} } }, hash: "h" });
    backend.request = async (method) => {
      assert.equal(method, "models.list");
      reads += 1;
      if (reads <= failures) throw notReady();
      return { models: [{ id: "ready", provider: "alpha" }] };
    };
    if (succeeds) {
      const sources = await backend.getModelCatalogSources();
      assert.equal(sources.runtime[0].id, "ready");
    } else {
      await assert.rejects(backend.getModelCatalogSources(), { code: "ERR_MODEL_CATALOG_RUNTIME" });
    }
    assert.equal(reads, 3, "at most three reads, never an unbounded wait");
  }
});
