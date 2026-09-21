"use strict";
// Real backend/coordinator/journal; only the Gateway RPC and catalog transport
// are in memory. Every filesystem mutation is confined to the supplied temp dir.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { OpenClawBackend } = require("../../app/core/openclaw-backend");
const { createOpenClawModelChange } = require("../../app/core/openclaw-model-change");
const { ModelChangeCoordinator } = require("../../app/core/model-change-coordinator");
const { createModelChangeJournal } = require("../../app/core/model-change-journal");

function createEndpointBackendFixture(directory, { latePrimary = false, batchModelSelection = true, extraModels = [], catalogDelayMs = 0 } = {}) {
  const initialModels = ["moonshotai/Kimi-K2.5", "inclusionAI/Ling-2.6-1T", "deepseek-ai/DeepSeek-V4-Flash", "ZhipuAI/GLM-5.2", "MiniMax/MiniMax-M3", ...extraModels];
  let config = {
    models: { providers: { modelscope: { baseUrl: "https://fixture.example/v1", api: "openai-completions", models: initialModels.map(id => ({ id })) } } },
    agents: {
      defaults: { model: { primary: "other/keep", fallbacks: initialModels.slice(0,3).map(id => `modelscope/${id}`) }, modelPolicy: { allow: initialModels.map(id => `modelscope/${id}`) } },
      entries: {
        main: { model: { primary: "modelscope/deepseek-ai/DeepSeek-V4-Flash" } },
        sara: { model: { primary: "modelscope/deepseek-ai/DeepSeek-V4-Flash" } },
        travelplanner: { model: { primary: "modelscope/ZhipuAI/GLM-5.2" } },
      },
    },
  };
  const requests = [];
  let writes = 0;
  let catalogReads = 0;
  let endpointReads = 0;
  const endpointReadOptions = [];
  const hash = () => createHash("sha256").update(JSON.stringify(config)).digest("hex");
  function merge(target, patch) {
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete target[key];
      else if (value && typeof value === "object" && !Array.isArray(value)) {
        if (!target[key] || typeof target[key] !== "object") target[key] = {};
        merge(target[key], value);
      } else target[key] = structuredClone(value);
    }
  }
  const backend = new OpenClawBackend({ getUpstreamUrl: () => "wss://fixture.invalid" });
  backend._isLocalGateway = () => false;
  backend._configSnapshot = async () => ({ parsed: structuredClone(config), hash: hash() });
  backend._providerCatalogSnapshot = () => ({ providers: {} });
  backend._loadLocalAuthKeyProfiles = async () => new Map();
  backend._localAuthKeyProviders = () => new Set();
  backend._localKeyDigests = () => new Map();
  backend._pathsNeedRestart = async () => false;
  backend._syncRegistryProvider = () => {};
  backend._purgeAgentShadowRegistries = () => {};
  backend._dropAuthProfileKeyQuietly = async () => {};
  backend.request = async (method, params = {}) => {
    if (method === "config.get") return backend._configSnapshot();
    if (method === "sessions.list") return { sessions: [], hasMore: false };
    if (method === "cron.list") return { jobs: [], hasMore: false };
    if (method === "config.patch") {
      if (params.baseHash !== hash()) throw new Error("config hash mismatch");
      merge(config, JSON.parse(params.raw));
      writes++;
      return {};
    }
    throw new Error(`Unexpected fixture RPC: ${method}`);
  };
  backend.attachModelChangeAdapter(createOpenClawModelChange({ backend, runtimeApply: {
    async inspect() { return { mode: "unsupported", safeApply: false }; },
    async acquireForApply() { throw new Error("Expected config-only fixture write"); },
    async recoverLease() {},
  } }));
  const journalPath = path.join(directory, "model-change-journal.json");
  const journal = createModelChangeJournal(journalPath);
  const coordinator = new ModelChangeCoordinator({ journal, registry: {
    _activeGet: id => id === "openclaw" ? backend : null,
    listModelsSnapshot: async () => {
      catalogReads++;
      if (catalogDelayMs) await new Promise(resolve => setTimeout(resolve, catalogDelayMs));
      return {
        models: (config.models.providers.modelscope?.models ?? []).map(model => ({ ...model, name: model.id, provider: "modelscope", backendId: "openclaw" })),
        catalogRevision: hash(),
      };
    },
  } });
  coordinator.markReady();
  const readEndpoints = backend.listCustomEndpoints.bind(backend);
  const list = async (options) => {
    endpointReadOptions.push(options ?? {});
    const snapshot = await readEndpoints(options);
    // Reproduce the exact stale-open-form sequence: a primary becomes known
    // only after earlier confirmed deletions have already committed.
    if (latePrimary && endpointReads++ === 0) snapshot.endpoints.forEach(endpoint => { delete endpoint.primaryModelUsage; });
    snapshot.form.batchModelSelection = batchModelSelection;
    snapshot.form.allowPrimaryModelRemoval = batchModelSelection;
    return snapshot;
  };
  const deleteCompat = coordinator.deleteCompat.bind(coordinator);
  coordinator.deleteCompat = async (backendId, ref, options = {}) => {
    requests.push({ providerKey: ref.providerKey, modelId: ref.modelId, operationId: options.operationId, force: options.force });
    return deleteCompat(backendId, ref, options);
  };
  const batchCompat = coordinator.batchCompat.bind(coordinator);
  coordinator.batchCompat = async (backendId, items, options = {}) => {
    requests.push({ items: structuredClone(items), ...options });
    return batchCompat(backendId, items, options);
  };
  const remove = (providerKey, modelId, operationId, force) =>
    coordinator.deleteCompat("openclaw", { providerKey, ...(modelId ? { modelId } : {}) }, { operationId, force });
  backend.listCustomEndpoints = list;
  backend.validateCustomEndpoint = async () => ({ ok: true, reachable: true, models: [...initialModels, "deepseek-ai/DeepSeek-V4.1-Flash"] });
  const state = () => ({ writes, catalogReads, requests, endpointReadOptions, models: config.models.providers.modelscope?.models.map(model => model.id) ?? [],
    fallbacks: config.agents.defaults.model.fallbacks,
    allowed: config.agents.defaults.modelPolicy.allow,
    primary: Object.fromEntries(Object.entries(config.agents.entries).map(([id, agent]) => [id, agent.model.primary])),
    journal: fs.existsSync(journalPath) ? JSON.parse(fs.readFileSync(journalPath)).operations.map(row => ({ operationId: row.operationId, status: row.status, modelId: row.source?.modelId })) : [],
  });
  return { backend, coordinator, list, remove, state, discovered: [...initialModels, "deepseek-ai/DeepSeek-V4.1-Flash"] };
}
module.exports = { createEndpointBackendFixture };
