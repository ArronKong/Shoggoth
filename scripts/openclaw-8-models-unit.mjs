import assert from "node:assert/strict";
import backendModule from "../app/core/openclaw-backend.js";

const { OpenClawBackend } = backendModule;

{
  const backend = new OpenClawBackend();
  backend._connect = async () => {};
  const calls = [];
  backend.request = async (method, params) => {
    calls.push({ method, params });
    return {
      models: [{
        id: "model-1",
        name: "Model One",
        provider: "provider",
        alias: "daily",
        tags: ["configured"],
        available: false,
        unavailableReason: "cooldown",
        unavailableUntil: 123,
        contextWindow: 1000,
        contextWindows: [{ id: "large", label: "Large", contextWindow: 2000 }],
        contextWindowDefault: "large",
        reasoning: true,
        thinkingLevels: [{ id: "high", label: "High" }],
        thinkingDefault: "high",
        effectiveFastMode: "auto",
        supportsTools: true,
        agentRuntime: { id: "codex", fallback: "openclaw", source: "model" },
      }],
    };
  };
  const models = await backend.getModels();
  assert.deepEqual(calls, [{
    method: "models.list",
    params: { view: "all", includeProviderCapabilities: true },
  }]);
  assert.equal(models[0].available, false);
  assert.equal(models[0].unavailableReason, "cooldown");
  assert.equal(models[0].thinkingDefault, "high");
  assert.equal(models[0].agentRuntime.id, "codex");
}

{
  const backend = new OpenClawBackend();
  backend._configSnapshot = async () => ({ parsed: {}, hash: "hash" });
  backend.request = async (method, params) => {
    assert.equal(method, "models.list");
    assert.deepEqual(params, {
      view: "all",
      includeProviderCapabilities: true,
      refresh: true,
    });
    return { models: [{ id: "live", name: "Live", provider: "p" }] };
  };
  const sources = await backend.getModelCatalogSources();
  assert.equal(sources.models[0].id, "live");
  assert.deepEqual(sources.models, sources.runtime);
}

{
  const backend = new OpenClawBackend();
  backend._configSnapshot = async () => ({
    hash: "hash-1",
    parsed: {
      agents: {
        entries: {
          main: {
            name: "Main",
            model: { primary: "p/old", fallbacks: ["p/fallback"] },
            models: { "p/old": { alias: "daily" } },
          },
        },
      },
    },
  });
  let patch;
  backend.request = async (method, params) => {
    assert.equal(method, "config.patch");
    patch = params;
    return { ok: true };
  };
  await backend._patchAgentModel("main", { primary: "p/new", fallbacks: [] });
  assert.equal(patch.baseHash, "hash-1");
  assert.deepEqual(patch.replacePaths, ["agents.entries.main.model.fallbacks"]);
  assert.deepEqual(JSON.parse(patch.raw), {
    agents: {
      entries: {
        main: {
          name: "Main",
          model: { primary: "p/new", fallbacks: [] },
          models: { "p/old": { alias: "daily" } },
        },
      },
    },
  });
}

{
  const backend = new OpenClawBackend();
  backend._patchRetryDelaysMs = [0];
  backend._configSnapshot = async () => ({
    hash: "hash-2",
    parsed: {
      agents: {
        defaults: {
          model: { primary: "p/old", fallbacks: ["p/old"] },
          modelPolicy: { allow: ["p/old"] },
          models: { "p/old": { alias: "daily" } },
        },
        entries: {
          main: { model: { primary: "p/new", fallbacks: ["p/old"] } },
        },
      },
      models: { providers: {} },
    },
  });
  let configPatch;
  backend.request = async (method, params) => {
    if (method === "config.patch") {
      configPatch = params;
      return { ok: true };
    }
    if (method === "config.schema.lookup") return { reloadKind: "hot" };
    throw new Error(`unexpected ${method}`);
  };
  await backend._patchModelProviders(() => ({
    patchProviders: {},
    replacePaths: ["agents.defaults.model.fallbacks", "agents.entries.main.model.fallbacks"],
    patchAgentModels: { "p/old": null, "p/new": {} },
    patchModelRefs: {
      defaultsPrimary: "p/new",
      defaultsFallbacks: ["p/new"],
      entries: [{ id: "main", model: { primary: "p/new", fallbacks: ["p/new"] } }],
    },
  }));
  const raw = JSON.parse(configPatch.raw);
  assert.deepEqual(raw.agents.defaults.modelPolicy.allow, ["p/new"]);
  assert.equal(Object.hasOwn(raw.agents.defaults, "models"), false);
  assert.deepEqual(raw.agents.entries.main.model.fallbacks, ["p/new"]);
  assert.equal(configPatch.replacePaths.includes("agents.defaults.modelPolicy.allow"), true);
}

console.log("openclaw 8 models: PASS");
