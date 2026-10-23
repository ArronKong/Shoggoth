#!/usr/bin/env node
"use strict";
// Real coordinator, journal and OpenClaw backend; all stores/RPC are isolated.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { createOpenClawModelChange } = require("../app/core/openclaw-model-change");
const { ModelChangeCoordinator } = require("../app/core/model-change-coordinator");
const { createModelChangeJournal } = require("../app/core/model-change-journal");

function fixture({ canonical = false, collision = false, failAt = "", rpc = false, warnAt = "" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-provider-rename-"));
  const provider = { baseUrl: "https://fixture.invalid/v1", api: "openai-completions", models: [{ id: "org/model" }] };
  const config = {
    models: { providers: { alpha: provider, ...(collision ? { beta: { ...provider } } : {}) } },
    agents: {
      defaults: { model: { primary: "alpha/org/model", fallbacks: ["alpha/retained", "keep/m"] },
        modelPolicy: { allow: ["alpha/org/model"] }, models: { "alpha/org/model": { alias: "Fast" } },
        subagents: { model: "alpha/org/model" }, imageModel: { primary: "alpha/image" }, heartbeat: { model: "alpha/org/model" } },
      entries: { main: { model: { primary: "alpha/org/model" }, models: { "alpha/org/model": { alias: "Local" } },
        modelPolicy: { allow: ["alpha/*"] }, subagents: { model: { primary: "alpha/org/model" } } } },
    },
    hooks: { mappings: [{ name: "keep", model: "alpha/org/model", messageTemplate: "alpha/prompt stays verbatim" }] },
    auth: { profiles: { "alpha:default": { provider: "alpha", mode: "api_key" } }, order: { alpha: ["alpha:default"] } },
  };
  const sessions = [
    { key: "agent:main:one", sessionId: "sid", lifecycleRevision: "r1", providerOverride: "alpha", modelOverride: "org/model", model: "org/model", modelProvider: "alpha" },
    { key: "agent:main:history", model: "org/model", modelProvider: "alpha" },
    { key: "agent:main:projected", sessionId: "sid", model: "org/model", modelProvider: "alpha", modelOverrideSource: "user" },
  ];
  sessions.push({ key: "agent:main:removed-model", modelOverride: "previously-removed", providerOverride: "alpha" });
  const jobs = [{ id: "cron-1", configRevision: "v1", payload: { kind: "agentTurn", message: "unchanged", model: "alpha/org/model", fallbacks: ["alpha/retained", "keep/m"] } }];
  const calls = [];
  const credentials = [{ agent: "main", id: "alpha:default", type: "api_key", key: "fixture-private-key", order: ["alpha:default"] }];
  // Official credential RPC mode: one shared profile plus a legacy per-Agent copy
  // that older Shoggoth versions wrote into another Agent's own store.
  const store = rpc ? [
    { agent: "main", shared: true, id: "alpha:default", provider: "alpha", type: "api_key", key: "fixture-private-key" },
    { agent: "cto", shared: false, id: "alpha:default", provider: "alpha", type: "api_key", key: "fixture-private-key" },
  ] : [];
  const visible = agentId => store.filter(row => row.shared || row.agent === agentId);
  const dropProfileConfig = (id) => {
    delete config.auth?.profiles?.[id];
    for (const [provider, order] of Object.entries(config.auth?.order || {})) {
      const next = order.filter(value => value !== id);
      if (next.length) config.auth.order[provider] = next; else delete config.auth.order[provider];
    }
    for (const entry of Object.values(config.models.providers)) if (entry.apiKey === id) delete entry.apiKey;
  };
  let failed = false;
  let writes = 0;
  const merge = (target, patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete target[key];
      else if (value && typeof value === "object" && !Array.isArray(value)) {
        target[key] ||= {}; merge(target[key], value);
      } else target[key] = structuredClone(value);
    }
  };
  const hash = () => createHash("sha256").update(JSON.stringify(config)).digest("hex");
  const backend = new OpenClawBackend();
  backend._isLocalGateway = () => true;
  backend._usesCanonicalModelAuthCli = () => canonical;
  backend._configSnapshot = async () => ({ parsed: structuredClone(config), hash: hash() });
  backend._pathsNeedRestart = async () => false;
  backend._patchRetryDelaysMs = [0];
  backend._authProfilesPathOverride = path.join(dir, "auth.json");
  backend._registryPathOverride = path.join(dir, "registry.json");
  backend._modelAuthAgentIdsOverride = rpc ? ["main", "cto"] : ["main"];
  if (rpc) {
    backend._gatewayCredentialRpcOverride = true;
    backend._connect = async () => {};
  }
  fs.writeFileSync(backend._authProfilesPathOverride, JSON.stringify({ profiles: { "alpha:default": { type: "api_key", provider: "alpha", key: "fixture-private-key" } } }));
  fs.writeFileSync(backend._registryPathOverride, JSON.stringify({ providers: { alpha: { ...provider, apiKey: "profile:alpha:default" } } }));
  backend._syncAgentSqliteAuthKey = () => {};
  backend._renameAgentShadowRegistries = () => {};
  backend._loadProviderRenameAuth = async (from, to) => rpc
    ? structuredClone(store.filter(row => [from, to].includes(row.provider))
      .map(({ agent, id, provider, type, key }) => ({ agent, id, provider, type, key, order: [] })))
    : structuredClone(credentials.filter(row => row.id.startsWith("alpha:")));
  backend._runModelAuthCli = async (args, options) => {
    calls.push({ method: "auth", args });
    if (rpc) throw new Error("the official credential RPC must replace every CLI call");
    if (args.includes("paste-api-key")) {
      assert.equal(options.stdin, "fixture-private-key", "blank input preserves the existing credential");
      assert.ok(config.models.providers.beta, "declare the provider before CLI credential creation");
    }
    if (args.includes("logout")) {
      assert.equal(config.models.providers.alpha, undefined);
      credentials.splice(0);
    }
    return {};
  };
  backend.request = async (method, params = {}) => {
    calls.push({ method, params });
    let reply = {};
    if (method === "config.get") return backend._configSnapshot();
    if (method === "sessions.list") return { sessions: structuredClone(sessions.slice(params.offset || 0)), hasMore: false };
    if (method === "cron.list") return { jobs: structuredClone(jobs), total: jobs.length, offset: 0,
      limit: params.limit || 500, hasMore: false, nextOffset: null, snapshotRevision: "snapshot-1" };
    if (method === "sessions.patch") {
      assert.equal(params.expectedSessionId, "sid");
      assert.ok(config.agents.defaults.modelPolicy.allow.includes("beta/org/model"));
      const row = sessions.find(item => item.key === params.key);
      row.providerOverride = params.model.split("/")[0];
      row.modelOverride = params.model.slice(row.providerOverride.length + 1);
      if (row.modelOverrideSource) row.modelProvider = row.providerOverride;
    } else if (method === "cron.update") {
      assert.equal(params.expectedConfigRevision, "v1");
      assert.equal(params.patch.payload.kind, "agentTurn", "Cron payload patch requires a discriminator");
      merge(jobs[0], params.patch);
    } else if (rpc && method === "models.authStatus") {
      const rows = visible(params.agentId);
      return { providers: [...new Set(rows.map(row => row.provider))].map(provider => ({ provider, profiles: rows
        .filter(row => row.provider === provider).map(row => ({ profileId: row.id, type: row.type, logoutSupported: true,
          source: config.models.providers[provider]?.apiKey === row.id ? "config"
            : row.shared ? (params.agentId === "main" ? "saved" : "inherited") : "saved" })) })) };
    } else if (rpc && method === "models.authSetApiKey") {
      assert.deepEqual(params, { provider: "beta", apiKey: "fixture-private-key", agentId: "main" });
      assert.ok(config.models.providers.beta, "the renamed provider is declared before its key is bound");
      const existing = store.find(row => row.shared && row.id === "beta:manual");
      if (existing) existing.key = params.apiKey;
      else store.push({ agent: "main", shared: true, id: "beta:manual", provider: "beta", type: "api_key", key: params.apiKey });
      (config.auth.profiles ||= {})["beta:manual"] = { provider: "beta", mode: "api_key" };
      config.models.providers.beta.apiKey = "beta:manual";
      reply = { provider: "beta", profileId: "beta:manual" };
    } else if (rpc && method === "models.authLogout") {
      assert.equal(params.provider, "alpha");
      assert.equal(config.models.providers.alpha, undefined, "old keys are removed only after the provider retired");
      for (const id of params.profileIds) {
        const index = store.findIndex(row => row.id === id && (params.agentId === "main" ? row.shared : row.agent === params.agentId && !row.shared));
        assert.notEqual(index, -1, `logout targets a profile ${params.agentId} actually owns`);
        store.splice(index, 1);
        dropProfileConfig(id);
      }
    } else if (method === "config.patch") {
      assert.equal(params.baseHash, hash());
      const patch = JSON.parse(params.raw);
      if (patch.models?.providers?.alpha === null && config.models.providers.alpha?.models.length) {
        assert.ok(params.replacePaths?.includes("models.providers.alpha.models"), "Gateway requires explicit retirement of the old provider's model array");
      }
      merge(config, patch); writes++;
    } else throw new Error(`Unexpected fixture method ${method}`);
    const failure = failAt === method || (failAt === "final-config" && method === "config.patch" && writes === 2);
    if (failure && !failed) { failed = true; throw Object.assign(new Error("response lost after write"), { code: "connection_lost" }); }
    return method === warnAt ? { ...reply, warning: "Saved, but Gateway refresh failed." } : reply;
  };
  backend.attachModelChangeAdapter(createOpenClawModelChange({ backend, runtimeApply: {
    async inspect() { return { mode: "hot", safeApply: true }; },
    async acquireForApply() { throw new Error("Provider rename must not use the generic runtime field update"); },
    async recoverLease() {},
  } }));
  const journalFile = path.join(dir, "journal.json");
  const journal = createModelChangeJournal(journalFile);
  const coordinator = new ModelChangeCoordinator({ journal, registry: {
    _activeGet: () => backend,
    listModelsSnapshot: async () => ({ models: Object.entries(config.models.providers).flatMap(([provider, entry]) =>
      entry.models.map(model => ({ ...model, provider, backendId: "openclaw" }))), catalogRevision: hash() }),
  } });
  coordinator.markReady();
  return { backend, coordinator, config, sessions, jobs, calls, journal, journalFile, dir, store, writes: () => writes };
}

(async () => {
  let scenarios = 0;
  const failures = ["", "config.patch", "sessions.patch", "cron.update", "final-config"];
  const modes = [[false, false, failures], [true, false, failures],
    [true, true, [...failures, "models.authSetApiKey", "models.authLogout"]]];
  for (const [canonical, rpc, failPoints] of modes) for (const failAt of failPoints) {
    const f = fixture({ canonical, failAt, rpc });
    try {
      const options = { operationId: `rename-${canonical}-${rpc ? "rpc-" : ""}${failAt || "success"}` };
      let result = await f.coordinator.updateProviderCompat("openclaw", "alpha", { renameTo: "beta" }, options);
      if (failAt) {
        assert.notEqual(result.status, "applied", "lost response must remain pending");
        assert.ok(f.config.models.providers.alpha || f.config.models.providers.beta);
        result = await f.coordinator.updateProviderCompat("openclaw", "alpha", { renameTo: "beta" }, options);
      }
      assert.equal(result.status, "applied", JSON.stringify(result));
      assert.equal(f.config.models.providers.alpha, undefined);
      assert.deepEqual(f.config.models.providers.beta.models, [{ id: "org/model" }]);
      assert.equal(f.config.agents.defaults.model.primary, "beta/org/model");
      assert.deepEqual(f.config.agents.defaults.model.fallbacks, ["beta/retained", "keep/m"]);
      assert.equal(f.config.agents.defaults.subagents.model, "beta/org/model");
      assert.equal(f.config.agents.defaults.imageModel.primary, "beta/image");
      assert.equal(f.config.agents.entries.main.model.primary, "beta/org/model");
      assert.equal(f.config.agents.entries.main.models["beta/org/model"].alias, "Local");
      assert.deepEqual(f.config.agents.entries.main.modelPolicy.allow, ["beta/*"]);
      assert.equal(f.config.hooks.mappings[0].model, "beta/org/model");
      assert.equal(f.config.hooks.mappings[0].messageTemplate, "alpha/prompt stays verbatim");
      assert.equal(f.sessions[0].providerOverride, "beta");
      assert.equal(f.sessions[0].modelProvider, "alpha", "past execution identity stays intact");
      assert.equal(f.sessions[1].providerOverride, undefined, "history must not create a new override");
      assert.equal(f.sessions[2].providerOverride, "beta", "9.1 projected override must migrate");
      assert.equal(f.sessions[3].providerOverride, "alpha", "unavailable pre-existing session choices remain for the user to resolve");
      assert.equal(f.jobs[0].payload.model, "beta/org/model");
      assert.equal(f.jobs[0].payload.message, "unchanged");
      const registry = JSON.parse(fs.readFileSync(f.backend._registryPathOverride));
      if (rpc) {
        assert.equal(f.config.models.providers.beta.apiKey, "beta:manual", "the renamed connection is bound to one saved key");
        assert.deepEqual(f.config.auth.profiles["beta:manual"], { provider: "beta", mode: "api_key" });
        assert.equal(f.config.auth.profiles["alpha:default"], undefined);
        assert.equal(f.config.auth.profiles["beta:default"], undefined, "auth metadata is not moved to a profile that was never created");
        assert.equal(f.config.auth.order?.alpha, undefined);
        assert.deepEqual(f.store.map(row => [row.agent, row.shared, row.id, row.key]),
          [["main", true, "beta:manual", "fixture-private-key"]], "shared key and every legacy Agent copy of the old ID are gone");
        assert.equal(registry.providers.beta.apiKey, undefined, "the mirror never names a profile that does not exist");
        assert.equal(f.calls.some(call => call.method === "auth"), false, "no CLI process is started");
      } else {
        assert.equal(f.config.auth.profiles["beta:default"].provider, "beta");
        assert.deepEqual(f.config.auth.order.beta, ["beta:default"]);
        assert.equal(registry.providers.beta.apiKey, "profile:beta:default");
      }
      const entry = f.journal.get(options.operationId);
      assert.equal(entry.target.provider, "beta");
      assert.equal(fs.readFileSync(f.journalFile, "utf8").includes("fixture-private-key"), false);
      const before = f.writes();
      assert.equal((await f.coordinator.updateProviderCompat("openclaw", "alpha", { renameTo: "beta" }, options)).status, "applied");
      assert.equal(f.writes(), before, "same-operation replay must not repeat the rename");
      scenarios++;
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
  for (const warnAt of ["models.authSetApiKey", "models.authLogout"]) {
    const f = fixture({ canonical: true, rpc: true, warnAt });
    try {
      const result = await f.coordinator.updateProviderCompat("openclaw", "alpha", { renameTo: "beta" }, { operationId: `rename-warning-${warnAt}` });
      assert.equal(result.status, "applied");
      assert.deepEqual(result.activation, { kind: "gateway_restart", available: true });
      assert.equal(f.store.some(row => row.provider === "alpha"), false, "cleanup must run even when the save already needs a restart");
      assert.equal(f.calls.filter(call => call.method === "models.authSetApiKey").length, 1);
      assert.equal(f.calls.filter(call => call.method === "models.authLogout").length, 2);
      assert.equal(f.journal.get(result.operationId).fingerprints.configOnlyRestartRequired, true);
      scenarios++;
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
  const f = fixture({ collision: true, canonical: true });
  try {
    const result = await f.coordinator.updateProviderCompat("openclaw", "alpha", { renameTo: "beta", apiKey: "should-not-write" }, { operationId: "rename-collision" });
    assert.notEqual(result.status, "applied");
    assert.equal(f.writes(), 0);
    assert.equal(f.calls.some(call => call.method === "auth" || call.method.endsWith(".patch") || call.method === "cron.update"), false);
    scenarios++;
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  const preflight = fixture({ canonical: true });
  try {
    const load = preflight.backend._loadProviderRenameAuth;
    preflight.backend._loadProviderRenameAuth = async () => [{ agent: "main", id: "alpha:default", type: "api_key" }];
    const rejected = await preflight.coordinator.updateProviderCompat("openclaw", "alpha", { renameTo: "beta" }, { operationId: "unreadable-key" });
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.stage, "preflight");
    assert.equal(preflight.writes(), 0);
    assert.equal(preflight.journal.listPending().length, 0, "zero-write failure must not lock subsequent edits");
    preflight.backend._loadProviderRenameAuth = load;
    assert.equal((await preflight.coordinator.updateProviderCompat("openclaw", "alpha", { renameTo: "beta" }, { operationId: "readable-key" })).status, "applied");
    scenarios++;
  } finally { fs.rmSync(preflight.dir, { recursive: true, force: true }); }
  console.log(`OpenClaw provider rename: PASS (${scenarios} scenarios)`);
})().catch(error => { console.error(error); process.exitCode = 1; });
