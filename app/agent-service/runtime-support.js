"use strict";

const { resolveRuntimePermissionMode } = require("./runtime-permission-modes");
const { readRuntimeAuthenticationState } = require("./runtime-adapter");
const { isRuntimeAvailable } = require("../runtime-availability");

const RUNTIME_SUPPORT_CODES = Object.freeze(["BINDING_DISABLED", "RUNTIME_NOT_INSTALLED",
  "RUNTIME_RELEASE_DISABLED", "ACCOUNT_NOT_AUTHENTICATED", "ACCOUNT_AUTH_UNKNOWN",
  "MODEL_ROUTE_UNSUPPORTED", "ATTACHMENT_UNSUPPORTED", "PERMISSION_ENFORCEMENT_UNPROVEN",
  "WORKSPACE_REQUIRED", "RUNTIME_FACTS_UNKNOWN"]);
const unsupported = code => Object.freeze({ supported: false, code });

// No discovery or I/O here: a request is checked against one cached fact set.
function supports({ binding, facts, requirements = {} }) {
  if (!binding?.enabled) return unsupported("BINDING_DISABLED");
  if (facts?.releaseEnabled === false) return unsupported("RUNTIME_RELEASE_DISABLED");
  if (facts?.installed === false) return unsupported("RUNTIME_NOT_INSTALLED");
  if (facts?.installed !== true) return unsupported("RUNTIME_FACTS_UNKNOWN");
  if (facts.authenticated === false) return unsupported("ACCOUNT_NOT_AUTHENTICATED");
  // Same gate as execution: a present but not yet proven credential is
  // verified by the next real turn, so it must not block choosing the Runtime.
  if (facts.authenticated !== true && facts.authenticated !== "unverified") return unsupported("ACCOUNT_AUTH_UNKNOWN");
  let permission;
  try {
    permission = resolveRuntimePermissionMode(binding.runtime, requirements.permissionMode ?? null,
      requirements.permissionPolicy);
  } catch { return unsupported("PERMISSION_ENFORCEMENT_UNPROVEN"); }
  if (facts.permissionEnforcementProven !== true
    || (binding.runtime === "deepseek-harness" && permission.permissionPolicy.sandbox === "read-only")
    || (binding.runtime === "opencode" && permission.permissionPolicy.sandbox !== "danger-full-access")) {
    return unsupported("PERMISSION_ENFORCEMENT_UNPROVEN");
  }
  if (permission.permissionPolicy.sandbox !== "read-only" && !requirements.workspace) {
    return unsupported("WORKSPACE_REQUIRED");
  }
  if (requirements.model && !facts.models?.includes(requirements.model)) return unsupported("MODEL_ROUTE_UNSUPPORTED");
  if ((requirements.attachmentKinds || []).some(kind => !facts.attachmentKinds?.includes(kind))) {
    return unsupported("ATTACHMENT_UNSUPPORTED");
  }
  return Object.freeze({ supported: true });
}

function createRuntimeSupportFacts({ runtimeManager, runtimeAccountAdmission, now = Date.now,
  timeoutMs = 5000, maxPending = 8, ttlMs = 30_000, discover, contextIdentity = () => null }) {
  const cache = new Map();
  const pending = new Map();
  const cacheKey = (binding, profile, generation) => JSON.stringify([binding.id, binding.revision, generation,
    profile.permissionPolicy, profile.runtimeProfileId ?? null, contextIdentity(binding, profile)]);
  async function collect(binding, profile) {
    if (discover) return discover(binding, profile);
    const host = await runtimeManager.acquire({ runtime: binding.runtime, runtimeProfileId: binding.runtimeProfileId,
      runtimeAccountId: binding.runtimeAccountId }, { permissionPolicy: profile.permissionPolicy });
    const auth = await readRuntimeAuthenticationState(host, { allowDeferred: true });
    const models = [], modelWindows = Object.create(null), modelLimits = Object.create(null);
    let defaultModel = null;
    let cursor = null;
    for (let page = 0; page < 4 && typeof host.modelsList === "function"; page++) {
      const result = await host.modelsList({ cursor, limit: 64 });
      for (const model of result?.data || result?.models || []) {
        const id = model.model ?? model.id;
        if (typeof id === "string" && models.length < 256) {
          models.push(id);
          if (model.isDefault === true) defaultModel = id;
          // Only the operational context window; advertised maximum/upgrade
          // capacity must never silently enlarge an active CLI's budget.
          if (Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0) modelWindows[id] = model.contextWindow;
          modelLimits[id] = { windowKind: ["input", "total", "effective"].includes(model.contextWindowKind)
            ? model.contextWindowKind : binding.runtime === "codex" ? "effective"
              : binding.runtime === "antigravity" ? "input" : "total",
            inputTokens: Number.isSafeInteger(model.inputTokenLimit) && model.inputTokenLimit > 0 ? model.inputTokenLimit : null,
            outputTokens: Number.isSafeInteger(model.configuredOutputTokens) && model.configuredOutputTokens > 0
              ? model.configuredOutputTokens : null };
        }
      }
      cursor = result?.nextCursor ?? null;
      if (!cursor) break;
    }
    return { installed: true, authenticated: auth.status === "authenticated" ? true
      : auth.status === "unauthenticated" ? false : auth.status === "unverified" ? "unverified" : "unknown",
      models, modelWindows, modelLimits, defaultModel,
      attachmentKinds: binding.runtime.startsWith("ext-") ? []
        : binding.runtime === "opencode" ? ["image", "file"] : ["image", "pdf", "file"],
      permissionEnforcementProven: true };
  }
  return {
    contextWindow(binding, profile, model) {
      if (!binding?.enabled) return null;
      const generation = runtimeAccountAdmission?.read(binding.runtimeAccountId)?.generation ?? 0;
      const key = cacheKey(binding, profile, generation);
      const cached = cache.get(key);
      if (!cached || now() - cached.observedAt >= 7 * 24 * 60 * 60_000 || now() < cached.observedAt) return null;
      const value = cached.facts.modelWindows?.[model ?? cached.facts.defaultModel];
      return Number.isSafeInteger(value) && value > 0 ? value : null;
    },
    contextLimits(binding, profile, model) {
      if (!binding?.enabled) return {};
      const generation = runtimeAccountAdmission?.read(binding.runtimeAccountId)?.generation ?? 0;
      const cached = cache.get(cacheKey(binding, profile, generation));
      if (!cached || now() < cached.observedAt || now() - cached.observedAt >= 7 * 24 * 60 * 60_000) return {};
      return structuredClone(cached.facts.modelLimits?.[model ?? cached.facts.defaultModel] ?? {});
    },
    async read(binding, profile) {
      const generation = runtimeAccountAdmission?.read(binding.runtimeAccountId)?.generation ?? 0;
      const key = cacheKey(binding, profile, generation);
      const base = { installed: "unknown", authenticated: "unknown", generation,
        releaseEnabled: isRuntimeAvailable(binding.runtime), models: [], attachmentKinds: [],
        permissionEnforcementProven: false };
      if (!base.releaseEnabled || !binding.enabled) return base;
      const cached = cache.get(key);
      if (cached && now() - cached.observedAt < ttlMs) return cached.facts;
      if (!pending.has(key)) {
        if (pending.size >= maxPending) return base;
        const task = Promise.resolve().then(() => collect(binding, profile)).then(result => ({ ...base, ...result }), error => ({
          ...base, installed: /(?:BINARY|NOT_INSTALLED|VERSION_UNSUPPORTED|RUNTIME_INVALID)/u.test(error?.code || "")
            ? false : "unknown",
        })).then(facts => {
          cache.delete(key);
          cache.set(key, { facts, observedAt: now() });
          while (cache.size > 512) cache.delete(cache.keys().next().value);
          return facts;
        }).finally(() => pending.delete(key));
        pending.set(key, task);
      }
      let timer;
      try {
        return await Promise.race([pending.get(key), new Promise(resolve => {
          timer = setTimeout(() => resolve(base), timeoutMs);
        })]);
      } finally { clearTimeout(timer); }
    },
    generation(binding) { return runtimeAccountAdmission?.read(binding.runtimeAccountId)?.generation ?? 0; },
    clear() { cache.clear(); },
  };
}

module.exports = { RUNTIME_SUPPORT_CODES, supports, createRuntimeSupportFacts };
