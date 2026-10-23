"use strict";

const { serviceError } = require("./security");
const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"]);
const fail = code => serviceError(code, "当前 Runtime 无法确认记忆模型参数");

function validateMemoryModelExecution(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => !["thinking", "fastMode", "startedAtMs"].includes(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))
    || !levels.has(value.thinking)
    || value.fastMode !== undefined && ![true, false, "auto"].includes(value.fastMode)
    || value.startedAtMs !== undefined && (!Number.isSafeInteger(value.startedAtMs) || value.startedAtMs < 0)
    || value.fastMode === "auto" && value.startedAtMs === undefined) throw fail("MODEL_ONLY_SETTINGS_INVALID");
  return Object.freeze({ thinking: value.thinking,
    ...(value.fastMode === undefined ? {} : { fastMode: value.fastMode }),
    ...(value.startedAtMs === undefined ? {} : { startedAtMs: value.startedAtMs }) });
}

// Runtime metadata supplies the available native spellings. OpenClaw's original
// ranked selector chooses among their canonical levels; no model-name heuristics
// or global provider/plugin discovery enter this model-only boundary.
function resolveMemoryModelExecution(value, capabilities, nowMs = Date.now()) {
  const execution = validateMemoryModelExecution(value);
  const options = capabilities?.thinkingOptions;
  if (!require("./chat-model-settings").validModelCapabilities(capabilities)) {
    throw fail("MODEL_ONLY_SETTINGS_UNAVAILABLE");
  }
  const core = require("./shoggoth-memory/core.cjs");
  const native = new Map();
  for (const option of options) {
    const canonical = core.normalizeMemoryThinkingLevel(option);
    if (levels.has(canonical) && !native.has(canonical)) native.set(canonical, option);
  }
  if (options.length && !native.size) throw fail("MODEL_ONLY_SETTINGS_UNAVAILABLE");
  let thinkingLevel;
  if (native.size) {
    const selected = core.resolveMemoryThinkingLevel({
      levels: [...native.keys()].map(id => ({ id, rank: core.MEMORY_THINKING_LEVEL_RANKS[id] })),
      defaultLevel: core.normalizeMemoryThinkingLevel(capabilities.thinkingDefault),
    }, execution.thinking);
    thinkingLevel = native.get(selected);
    if (thinkingLevel === undefined) throw fail("MODEL_ONLY_SETTINGS_UNAVAILABLE");
  } else if (execution.thinking !== "off") throw fail("MODEL_ONLY_SETTINGS_UNAVAILABLE");
  // No advertised reasoning control means there is no override to send for off.
  const fastMode = execution.fastMode === undefined ? undefined : core.resolveMemoryFastModeForElapsed({
    mode: execution.fastMode, startedAtMs: execution.startedAtMs ?? nowMs, nowMs,
  }).enabled;
  if (fastMode === true && !capabilities.fastTier) throw fail("MODEL_ONLY_SETTINGS_UNAVAILABLE");
  return { ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(fastMode === undefined ? {} : { fastMode }) };
}

module.exports = { validateMemoryModelExecution, resolveMemoryModelExecution };
