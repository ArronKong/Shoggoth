"use strict";

// In-memory Gateway only. Never connects to an installed Gateway or Provider.
const assert = require("node:assert/strict");
const test = require("node:test");
const { createOpenClawModelChange } = require("../app/core/openclaw-model-change");
const { buildOpenClawModelDraft } = require("../app/core/openclaw-model-config-draft");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ModelChangeCoordinator } = require("../app/core/model-change-coordinator");
const { createModelChangeJournal } = require("../app/core/model-change-journal");
const { normalizeModelChangeRequest } = require("../app/core/model-change-validation");

function fixture() {
  const config = {
    models: { providers: { xmxm: { baseUrl: "https://provider.invalid/v1", api: "openai-completions", models: [{
      id: "mimo", name: "Mimo", input: ["text", "image"], contextWindow: 128000, contextTokens: 64000,
      cost: { input: 3, output: 8 }, params: { region: "test" }, headers: { "x-fixture": "preserved" },
    }] } } },
    agents: { defaults: { model: { primary: "xmxm/mimo", fallbacks: ["other/fallback"] }, modelPolicy: { allow: ["xmxm/mimo"] } }, entries: { main: {} } },
  };
  const jobs = Array.from({ length: 10 }, (_, i) => ({ id: `disabled-${i}`, enabled: false, version: `v${i}`,
    payload: { model: "xmxm/mimo", fallbacks: ["other/fallback"] } }));
  const calls = [];
  let revision = 1;
  const backend = {
    async request(method, params) {
      calls.push({ method, params: structuredClone(params) });
      if (method === "config.get") return { parsed: structuredClone(config), hash: `fixture-r${revision}`, valid: true };
      if (method === "config.set") {
        if (params.baseHash !== `fixture-r${revision}`) throw Object.assign(new Error("conflict"), { code: "INVALID_REQUEST", receiptUncertain: false });
        const next = JSON.parse(params.raw);
        for (const key of Object.keys(config)) delete config[key];
        Object.assign(config, next);
        revision += 1;
        return { ok: true, hash: `fixture-r${revision}` };
      }
      if (method === "models.authSetApiKey") return { provider: params.provider, profileId: `${params.provider}:manual`, warning: "fixture catalog refresh unavailable" };
      if (method === "models.authLogout") return { provider: params.provider, removedProfiles: [] };
      if (method === "sessions.list") return { sessions: [], total: 0 };
      if (method === "cron.list") return { jobs: structuredClone(jobs), total: jobs.length };
      if (method === "models.list") return { models: [] };
      throw new Error(`unexpected fixture RPC: ${method}`);
    },
    async getModelReferenceCapabilities() { return {}; },
    modelAuthAgentId() { return "main"; },
  };
  const runtimeApply = { async inspect() { return { safeApply: false, mode: "unsupported" }; },
    async acquireForApply() { throw new Error("native save must not acquire reference migration lease"); },
    async recoverLease() { throw new Error("native recovery must not replay reference migration"); } };
  const adapter = createOpenClawModelChange({ backend, runtimeApply, configurationMode: "native-config" });
  backend.getModelChangeCapabilities = adapter.getCapabilities;
  backend.previewModelChange = adapter.preview;
  backend.applyModelChange = adapter.apply;
  backend.recoverModelChange = adapter.recover;
  return { config, jobs, calls, backend, adapter };
}

function coordinator(t, f, { catalogFails = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-native-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journal = createModelChangeJournal(path.join(root, "journal.json"));
  const value = new ModelChangeCoordinator({ journal, registry: {
    _activeGet(id) { assert.equal(id, "openclaw"); return f.backend; },
    async listModelsSnapshot() { if (catalogFails) throw new Error("catalog unavailable"); return { models: [], catalogRevision: "fixture-catalog" }; },
  } });
  value.markReady();
  return { value, journal };
}

test("official config preview does not scan or block ten disabled Cron references or primary binding", async () => {
  const f = fixture();
  const result = await f.adapter.preview({ kind: "delete-provider", providerKey: "xmxm", sourceModelId: null });
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.references, []);
  assert.deepEqual(f.calls.map(call => call.method), ["config.get"]);
});

test("definition deletion preserves Agent bindings and all ten disabled jobs", () => {
  const f = fixture(), original = structuredClone(f.config), jobs = structuredClone(f.jobs);
  const result = buildOpenClawModelDraft(f.config, { kind: "delete-provider", providerKey: "xmxm" });
  assert.equal(result.config.models.providers.xmxm, undefined);
  assert.deepEqual(result.config.agents, original.agents);
  assert.deepEqual(f.config, original);
  assert.deepEqual(f.jobs, jobs);
});

test("editing retains media, pricing, practical context cap, headers and provider params", () => {
  const f = fixture(), original = f.config.models.providers.xmxm.models[0];
  const result = buildOpenClawModelDraft(f.config, { kind: "update", providerKey: "xmxm", sourceModelId: "mimo", model: { id: "mimo", name: "Edited" } });
  assert.deepEqual(result.targetModel, { ...original, name: "Edited" });
});

test("advanced model fields reach the official draft without truncation and preserve unedited private headers", () => {
  const f = fixture();
  f.config.models.providers.xmxm.models[0].headers.Authorization = "fixture-private-header";
  const { safeSpec } = normalizeModelChangeRequest({ providerKey: "xmxm", sourceModelId: "mimo", model: { id: "mimo",
    advanced: { input: ["text", "image"], contextTokens: null, cost: { input: 9 }, headers: { "x-fixture": "changed" }, compat: { supportsStore: false } } } });
  const row = buildOpenClawModelDraft(f.config, safeSpec).config.models.providers.xmxm.models[0];
  assert.deepEqual(row.input, ["text", "image"]);
  assert.deepEqual(row.cost, { input: 9, output: 8 });
  assert.equal(Object.hasOwn(row, "contextTokens"), false);
  assert.equal(row.headers.Authorization, "fixture-private-header");
  assert.equal(row.headers["x-fixture"], "changed");
  assert.throws(() => normalizeModelChangeRequest({ providerKey: "xmxm", model: { id: "mimo", advanced: { headers: { Authorization: "must-use-secret-channel" } } } }), { code: "secret_in_model_metadata" });
  assert.throws(() => normalizeModelChangeRequest({ providerKey: "xmxm", model: { id: "mimo", advanced: { headers: { "X-API-Key": "must-use-secret-channel" } } } }), { code: "secret_in_model_metadata" });
});

test("official known config rejection is terminal without pending locks or speculative writes", async t => {
  const f = fixture(), c = coordinator(t, f), request = f.backend.request.bind(f.backend);
  f.backend.request = async (method, params) => { if (method === "config.set") throw Object.assign(Error("invalid schema"), { code: "INVALID_REQUEST" }); return request(method, params); };
  const result = await c.value.deleteCompat("openclaw", { providerKey: "xmxm" }, { operationId: "known-invalid" });
  assert.equal(result.status, "failed");
  assert.deepEqual(c.journal.listPending(), []);
  assert.ok(f.config.models.providers.xmxm);
});

test("lost config acknowledgement is observed under original identity without repeating config.set", async t => {
  const f = fixture(), c = coordinator(t, f), request = f.backend.request.bind(f.backend);
  f.backend.request = async (method, params) => { const value = await request(method, params); if (method === "config.set") throw Error("controlled lost response"); return value; };
  const identity = { operationId: "lost-config-ack", providerKey: "xmxm" };
  assert.equal((await c.value.deleteCompat("openclaw", { providerKey: "xmxm" }, identity)).status, "partial");
  const observed = await c.value.recoverOperation("openclaw", identity);
  assert.equal(observed.status, "applied");
  assert.equal(f.calls.filter(call => call.method === "config.set").length, 1);
});

test("lost native logout is never inferred successful from unchanged definitions or replayed", async t => {
  const f = fixture(), c = coordinator(t, f), request = f.backend.request.bind(f.backend);
  f.backend.request = async (method, params) => { const value = await request(method, params); if (method === "models.authLogout") throw Error("controlled lost logout response"); return value; };
  const identity = { operationId: "lost-logout-ack", providerKey: "xmxm" };
  const result = await c.value.updateProviderCompat("openclaw", "xmxm", { clearApiKey: true }, identity);
  assert.equal(result.status, "partial");
  assert.equal(c.journal.get(identity.operationId).secretStep, "pending");
  const observed = await c.value.recoverOperation("openclaw", identity);
  assert.equal(observed.terminal, false);
  assert.equal(f.calls.filter(call => call.method === "models.authLogout").length, 1);
});

test("last model deletion leaves an editable empty Provider and retains primary/allowlist", () => {
  const f = fixture();
  const result = buildOpenClawModelDraft(f.config, { kind: "delete-model", providerKey: "xmxm", sourceModelId: "mimo" });
  assert.deepEqual(result.config.models.providers.xmxm, { ...f.config.models.providers.xmxm, models: [] });
  assert.deepEqual(result.config.agents, f.config.agents);
});

test("model and Provider rename edit definitions without rewriting bindings or credentials", () => {
  const f = fixture();
  f.config.models.providers.xmxm.apiKey = { source: "file", provider: "default", id: "/fixture/key" };
  const model = buildOpenClawModelDraft(f.config, { kind: "rename", providerKey: "xmxm", sourceModelId: "mimo", model: { id: "new-id" } });
  assert.deepEqual(model.config.agents, f.config.agents);
  assert.equal(model.config.models.providers.xmxm.models[0].id, "new-id");
  const provider = buildOpenClawModelDraft(f.config, { kind: "update-provider", providerKey: "xmxm", patch: { renameTo: "new-provider" } });
  assert.deepEqual(provider.config.agents, f.config.agents);
  assert.deepEqual(provider.config.models.providers["new-provider"], f.config.models.providers.xmxm);
  assert.equal(provider.config.models.providers.xmxm, undefined);
});

test("provider draft replaces model selection once without changing existing metadata or defaults", () => {
  const f = fixture();
  const result = buildOpenClawModelDraft(f.config, { kind: "save-provider", providerKey: "xmxm", patch: { modelIds: ["mimo", "second"], baseUrl: "https://changed.invalid/v1" } });
  assert.deepEqual(result.config.models.providers.xmxm.models[0], f.config.models.providers.xmxm.models[0]);
  assert.deepEqual(result.config.models.providers.xmxm.models[1], { id: "second", name: "second" });
  assert.deepEqual(result.config.agents, f.config.agents);
});

test("existing coordinator deletes referenced Provider through exactly one official config.set", async t => {
  const f = fixture(), beforeAgents = structuredClone(f.config.agents), beforeJobs = structuredClone(f.jobs);
  const c = coordinator(t, f);
  const result = await c.value.deleteCompat("openclaw", { providerKey: "xmxm" }, { operationId: "delete-original" });
  assert.equal(result.status, "applied");
  assert.equal(f.config.models.providers.xmxm, undefined);
  assert.deepEqual(f.config.agents, beforeAgents);
  assert.deepEqual(f.jobs, beforeJobs);
  assert.deepEqual(f.calls.filter(call => call.method !== "config.get").map(call => call.method), ["config.set"]);
  assert.equal(c.journal.get("delete-original").mode, "native-config");
  await c.value.deleteCompat("openclaw", { providerKey: "xmxm" }, { operationId: "delete-original" });
  assert.equal(f.calls.filter(call => call.method === "config.set").length, 1);
});

test("saved definition remains successful and releases pending state when catalog refresh fails", async t => {
  const f = fixture(), c = coordinator(t, f, { catalogFails: true });
  const result = await c.value.deleteCompat("openclaw", { providerKey: "xmxm", modelId: "mimo" }, { operationId: "delete-catalog-unavailable" });
  assert.equal(result.status, "applied");
  assert.equal(result.catalogPending, true);
  assert.deepEqual(c.journal.listPending(), []);
});

test("whole endpoint form is one journaled config save and one scoped official Key save", async t => {
  const f = fixture(), c = coordinator(t, f);
  f.config.agents.entries["chosen-agent"] = {};
  const result = await c.value.saveProviderDraft("openclaw", { providerKey: "xmxm", models: ["mimo", "second", "third"],
    baseUrl: "https://changed.invalid/v1", apiKey: "fixture-key-do-not-persist", agentId: "chosen-agent" }, { operationId: "endpoint-original" });
  assert.equal(result.status, "applied");
  assert.deepEqual(f.calls.filter(call => call.method !== "config.get").map(call => call.method), ["config.set", "models.authSetApiKey"]);
  assert.equal(f.calls.find(call => call.method === "models.authSetApiKey").params.agentId, "chosen-agent");
  assert.match(result.warnings[0], /已保存/);
  assert.equal(JSON.stringify(c.journal.get("endpoint-original")).includes("fixture-key-do-not-persist"), false);
});

test("official Key success remains applied when subsequent Gateway reads are unavailable", async t => {
  const f = fixture(), c = coordinator(t, f), request = f.backend.request.bind(f.backend);
  let keySaved = false;
  f.backend.request = async (method, params) => {
    if (method === "config.get" && keySaved) throw Error("controlled refresh unavailable");
    const value = await request(method, params);
    if (method === "models.authSetApiKey") keySaved = true;
    return value;
  };
  const result = await c.value.updateProviderCompat("openclaw", "xmxm", { apiKey: "synthetic-key" }, { operationId: "known-key-saved" });
  assert.equal(result.status, "applied");
  assert.deepEqual(c.journal.listPending(), []);
  assert.equal(f.calls.filter(call => call.method === "models.authSetApiKey").length, 1);
});

test("stale endpoint form is rejected before any write and retains existing config", async t => {
  const f = fixture(), c = coordinator(t, f), original = structuredClone(f.config);
  const result = await c.value.saveProviderDraft("openclaw", { providerKey: "xmxm", models: [], baseHash: "older-revision" }, { operationId: "stale-form" });
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "preview_stale");
  assert.deepEqual(f.config, original);
  assert.equal(f.calls.some(call => call.method === "config.set"), false);
});

test("stale Provider card cannot change its URL or write an API Key and leaves no pending lock", async t => {
  const f = fixture(), c = coordinator(t, f), original = structuredClone(f.config);
  const result = await c.value.updateProviderCompat("openclaw", "xmxm", {
    baseUrl: "https://changed.invalid/v1", apiKey: "synthetic-key", agentId: "main", baseHash: "older-revision",
  }, { operationId: "stale-provider-card" });
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "preview_stale");
  assert.deepEqual(f.config, original);
  assert.equal(f.calls.some(call => call.method === "config.set" || call.method === "models.authSetApiKey"), false);
  assert.deepEqual(c.journal.listPending(), []);
  await assert.rejects(c.value.updateProviderCompat("openclaw", "xmxm", { apiKey: "synthetic-key", baseHash: {} },
    { operationId: "invalid-provider-revision" }), { code: "invalid_string" });
});

test("native batch uses one durable operation and one config.set across Providers", async t => {
  const f = fixture(), c = coordinator(t, f);
  f.config.models.providers.other = { baseUrl: "https://other.invalid", models: [{ id: "other-id", name: "Other" }] };
  const result = await c.value.batchCompat("openclaw", [
    { op: "delete", providerKey: "xmxm", modelId: "mimo" },
    { op: "delete", providerKey: "other", modelId: "other-id" },
  ], { operationId: "batch-original" });
  assert.equal(result.status, "applied");
  assert.deepEqual(f.config.models.providers.xmxm.models, []);
  assert.deepEqual(f.config.models.providers.other.models, []);
  assert.equal(f.calls.filter(call => call.method === "config.set").length, 1);
  assert.deepEqual(c.journal.get("batch-original").fingerprints.nativeProviders, ["other", "xmxm"]);
});

test("a Gateway without official config methods stays blocked before any write", async t => {
  const f = fixture(), c = coordinator(t, f);
  f.backend.getNativeModelMethodSupport = async () => ({ config: false, credentials: false });
  const result = await c.value.deleteCompat("openclaw", { providerKey: "xmxm" }, { operationId: "unsupported-gateway" });
  assert.equal(result.status, "blocked");
  assert.equal(f.calls.some(call => call.method === "config.set"), false);
  assert.deepEqual(c.journal.listPending(), []);
});

test("unified custom Key saves once through the official shared connection", async t => {
  const f = fixture(), c = coordinator(t, f);
  f.config.agents.entries.other = {};
  const before = structuredClone(f.config);
  const result = await c.value.updateProviderCompat("openclaw", "xmxm", {
    apiKey: "synthetic-unified-key", credentialScope: "provider",
  }, { operationId: "unified-shared-key" });
  assert.equal(result.status, "applied");
  assert.deepEqual(f.calls.filter(call => call.method === "models.authSetApiKey").map(call => call.params),
    [{ provider: "xmxm", agentId: "main", apiKey: "synthetic-unified-key" }]);
  assert.deepEqual(f.config, before);
  assert.equal(JSON.stringify(c.journal.get("unified-shared-key")).includes("synthetic-unified-key"), false);
});

test("unified builtin Key updates every canonical Agent without manufacturing a connection", async t => {
  const f = fixture(), c = coordinator(t, f);
  f.config.agents.entries = { other: {}, main: {}, third: {} };
  const result = await c.value.updateProviderCompat("openclaw", "builtin", {
    apiKey: "synthetic-builtin-key", credentialScope: "provider",
  }, { operationId: "unified-builtin-key" });
  assert.equal(result.status, "applied");
  assert.deepEqual(f.calls.filter(call => call.method === "models.authSetApiKey").map(call => call.params.agentId), ["main", "other", "third"]);
  assert.equal(f.config.models.providers.builtin, undefined);
  assert.equal(f.calls.some(call => call.method === "config.set"), false);
  assert.deepEqual(c.journal.listPending(), []);
});

test("unified clear covers all Agents and only requests API-key logout", async t => {
  const f = fixture(), c = coordinator(t, f);
  f.config.agents.entries.other = {};
  const before = structuredClone(f.config);
  const result = await c.value.updateProviderCompat("openclaw", "xmxm", { clearApiKey: true, credentialScope: "provider" },
    { operationId: "unified-clear-key" });
  assert.equal(result.status, "applied");
  assert.deepEqual(f.calls.filter(call => call.method === "models.authLogout").map(call => call.params), [
    { provider: "xmxm", agentId: "main", credentialType: "api_key" },
    { provider: "xmxm", agentId: "other", credentialType: "api_key" },
  ]);
  assert.deepEqual(f.config, before);
});

test("a partial unified Key write stops, retains its original journal, and is never replayed", async t => {
  const f = fixture(), c = coordinator(t, f), request = f.backend.request.bind(f.backend);
  f.config.agents.entries = { main: {}, other: {}, third: {} };
  f.backend.request = async (method, params) => {
    const result = await request(method, params);
    if (method === "models.authSetApiKey" && params.agentId === "other") throw Error("controlled lost second Agent acknowledgement");
    return result;
  };
  const identity = { operationId: "unified-partial-key", providerKey: "builtin" };
  const result = await c.value.updateProviderCompat("openclaw", "builtin", { apiKey: "synthetic-key", credentialScope: "provider" }, identity);
  assert.equal(result.status, "partial");
  assert.equal(result.code, "provider_credentials_incomplete");
  assert.equal(c.journal.get(identity.operationId).secretStep, "pending");
  assert.equal((await c.value.recoverOperation("openclaw", identity)).terminal, false);
  assert.deepEqual(f.calls.filter(call => call.method === "models.authSetApiKey").map(call => call.params.agentId), ["main", "other"]);
});

test("unified connection URL edits preserve Key and never mutate auth", async t => {
  const f = fixture(), c = coordinator(t, f);
  f.config.models.providers.xmxm.apiKey = "xmxm:manual";
  assert.equal((await c.value.saveProviderDraft("openclaw", { providerKey: "xmxm", models: ["mimo"],
    baseUrl: "https://changed.invalid/v1", credentialScope: "provider" }, { operationId: "unified-url-only" })).status, "applied");
  assert.equal(f.config.models.providers.xmxm.apiKey, "xmxm:manual");
  assert.equal(f.calls.some(call => call.method.startsWith("models.auth")), false);
});

test("unified credential scope cannot silently coexist with a selected Agent", async t => {
  const f = fixture(), c = coordinator(t, f);
  await assert.rejects(c.value.updateProviderCompat("openclaw", "xmxm", { apiKey: "synthetic-key",
    credentialScope: "provider", agentId: "other" }, { operationId: "conflicting-scope" }), { code: "conflicting_fields" });
  await assert.rejects(c.value.saveProviderDraft("openclaw", { providerKey: "xmxm", models: [],
    credentialScope: "all" }, { operationId: "invalid-scope" }), { code: "invalid_credential_scope" });
  assert.equal(f.calls.length, 0);
});
