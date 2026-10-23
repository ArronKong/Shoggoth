"use strict";

const { serviceError } = require("./security");
const { validateModelResolution } = require("./runtime-model-resolution");
const { resolveMemoryModelExecution, validateMemoryModelExecution } = require("./memory-model-settings");
const effortLevels = new Set(["low", "medium", "high", "xhigh", "max"]);
const unavailable = () => serviceError("MODEL_ONLY_SETTINGS_UNAVAILABLE", "Claude Code 记忆模型参数不可用");

// This projection is the only part of getSettings retained by model-only work.
// Effective flags prove that managed policy did not override the local request;
// only applied.model/effort attest the CLI's actual model/effort selection.
function projectClaudeMemorySettings(value) {
  let selection;
  try { selection = validateModelResolution({ model: value?.applied?.model, provider: "claude-code" }); }
  catch { throw unavailable(); }
  const effort = value?.applied?.effort;
  const thinkingEnabled = value?.effective?.alwaysThinkingEnabled, fastMode = value?.effective?.fastMode;
  if (effort !== undefined && effort !== null && !effortLevels.has(effort)) throw unavailable();
  if (thinkingEnabled !== undefined && typeof thinkingEnabled !== "boolean"
    || fastMode !== undefined && typeof fastMode !== "boolean") throw unavailable();
  return Object.freeze({ model: selection.model, effort: effort ?? null,
    thinkingEnabled, fastMode });
}

function describeClaudeMemoryModel(settings, catalog, requestedModel) {
  if (!Array.isArray(catalog) || !catalog.length || catalog.length > 512) throw unavailable();
  // Product resolves visible aliases before this generation boundary and uses
  // the canonical selection for its recall cache. An SDK alias row can attest
  // metadata for that fixed model, but a raw alias cannot bypass resolution:
  // it could now point to another model than the one used for the cache key.
  if (requestedModel && requestedModel !== settings.model) throw unavailable();
  const matching = catalog.filter(row => row?.value === settings.model || row?.resolvedModel === settings.model);
  const canonical = matching.filter(row => row.value === settings.model);
  const rows = canonical.length ? canonical : matching;
  if (!rows.length) throw unavailable();
  const profiles = rows.map(row => {
    if (row.supportsEffort !== undefined && typeof row.supportsEffort !== "boolean"
      || row.supportsAdaptiveThinking !== undefined && typeof row.supportsAdaptiveThinking !== "boolean"
      || row.supportsFastMode !== undefined && typeof row.supportsFastMode !== "boolean") throw unavailable();
    const efforts = row.supportsEffort ? row.supportedEffortLevels : [];
    if (!row.supportsEffort && row.supportedEffortLevels !== undefined
      && (!Array.isArray(row.supportedEffortLevels) || row.supportedEffortLevels.length)) throw unavailable();
    if (!Array.isArray(efforts) || !efforts.length && row.supportsEffort || efforts.length > 5
      || efforts.some(level => !effortLevels.has(level)) || new Set(efforts).size !== efforts.length) throw unavailable();
    return { efforts: [...efforts].sort(), adaptive: row.supportsAdaptiveThinking === true, fast: row.supportsFastMode === true };
  });
  if (profiles.some(profile => JSON.stringify(profile) !== JSON.stringify(profiles[0]))) throw unavailable();
  const native = profiles[0];
  const profile = require("./shoggoth-memory/core.cjs").resolveClaudeMemoryThinkingProfile(settings.model, undefined, { includeNativeMax: true });
  const available = new Set(profile.levels.map(level => level.id));
  if (available.has("adaptive") && !native.adaptive && !native.efforts.length) throw unavailable();
  const thinkingOptions = [
    ...(available.has("off") ? ["off"] : []),
    ...native.efforts.filter(level => available.has(level)),
    ...(native.adaptive && available.has("adaptive") ? ["adaptive"] : []),
  ];
  if (!thinkingOptions.length) throw unavailable();
  return Object.freeze({ model: settings.model, supportsEffort: native.efforts.length > 0,
    // These are upstream CLI request choices, not attested model capabilities.
    // The CLI owns the final thinking/output-limit policy; its get_settings
    // response does not report the applied manual token budget.
    ...(!native.efforts.length && !native.adaptive && !available.has("adaptive")
      ? { cliBudgetRequestProfile: profile } : {}),
    capabilities: { thinkingOptions, thinkingDefault: thinkingOptions.includes(settings.effort) ? settings.effort : null,
      fastTier: native.fast ? "fast" : null } });
}

function planClaudeMemoryTransport(execution, model) {
  const validated = execution === undefined ? null : validateMemoryModelExecution(execution);
  const empty = () => Object.freeze({ model: model || null, thinkingEnv: Object.freeze({}), thinkingBudgetRequested: null });
  if (!validated || !model) return empty();
  const core = require("./shoggoth-memory/core.cjs");
  const profile = core.resolveClaudeMemoryThinkingProfile(model, undefined, { includeNativeMax: true });
  // The descriptor selects this planner only for legacy CLI budget requests.
  // Adaptive model families retain their existing native control path.
  if (profile.levels.some(level => level.id === "adaptive")) return empty();
  const level = core.resolveMemoryThinkingLevel({ ...profile,
    levels: profile.levels.map(entry => ({ ...entry, rank: core.MEMORY_THINKING_LEVEL_RANKS[entry.id] })) }, validated.thinking);
  const generated = core.resolveClaudeMemoryCliThinkingEnv(level, model);
  const thinkingEnv = Object.freeze({ ...generated });
  return Object.freeze({ model, thinkingEnv,
    thinkingBudgetRequested: Object.hasOwn(thinkingEnv, "MAX_THINKING_TOKENS") ? Number(thinkingEnv.MAX_THINKING_TOKENS) : null });
}

function resolveClaudeMemoryExecution(execution, model, nowMs = Date.now()) {
  if (model.cliBudgetRequestProfile) {
    const transport = planClaudeMemoryTransport(execution, model.model);
    if (transport.thinkingBudgetRequested === null) throw unavailable();
    // Validate native fast-mode availability without pretending that the CLI
    // request policy advertised manual-budget capabilities in its SDK catalog.
    const resolved = resolveMemoryModelExecution({ ...execution, thinking: "off" }, model.capabilities, nowMs);
    return Object.freeze({ thinkingEnabled: transport.thinkingBudgetRequested !== 0,
      thinkingBudgetRequested: transport.thinkingBudgetRequested,
      ...(resolved.fastMode === undefined ? {} : { fastMode: resolved.fastMode }) });
  }
  if (execution.thinking !== "off" && model.capabilities.thinkingOptions.every(level => level === "off")) {
    // Outside the upstream CLI request policy, missing native controls must
    // fail closed rather than inventing an effort or applied token budget.
    throw unavailable();
  }
  const resolved = resolveMemoryModelExecution(execution, model.capabilities, nowMs);
  const effort = effortLevels.has(resolved.thinkingLevel) ? resolved.thinkingLevel : undefined;
  return Object.freeze({ thinkingEnabled: resolved.thinkingLevel !== "off",
    ...(effort ? { effort } : {}),
    ...(resolved.fastMode === undefined ? {} : { fastMode: resolved.fastMode }) });
}

function assertClaudeMemorySettings(settings, model, resolved) {
  if (settings.model !== model.model || settings.thinkingEnabled !== resolved.thinkingEnabled
    || resolved.effort !== undefined && settings.effort !== resolved.effort
    || resolved.fastMode !== undefined && settings.fastMode !== resolved.fastMode) throw unavailable();
}

module.exports = { projectClaudeMemorySettings, describeClaudeMemoryModel, planClaudeMemoryTransport,
  resolveClaudeMemoryExecution, assertClaudeMemorySettings };
