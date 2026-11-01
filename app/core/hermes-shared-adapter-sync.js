"use strict";

const path = require("node:path");

const HERMES_SHARED_PLUGIN = "shoggoth_shared_capabilities";
const MAX_ROWS = 4096;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const validName = value => typeof value === "string" && /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/u.test(value);
const sameNames = (actual, expected) => actual.length === expected.length
  && new Set(actual).size === actual.length && actual.every(name => expected.includes(name));

function result(state, reason, updated = false, requiresNewSession = false) {
  return { state, ready: state === "ready", reason, updated, requiresNewSession };
}

function readToolset(value, pluginName) {
  if (!record(value) || !Array.isArray(value.toolsets) || value.toolsets.length > MAX_ROWS) return null;
  if (value.complete === false || value.truncated === true) return null;
  if (value.toolsets.some(row => !record(row) || typeof row.name !== "string"
    || !row.name || row.name.length > 256)) return null;
  const own = value.toolsets.filter(row => record(row) && row.name === pluginName);
  if (own.length === 0) return { present: false, enabled: true, tools: [] };
  if (own.length !== 1 || typeof own[0].enabled !== "boolean" || !Array.isArray(own[0].tools)
    || own[0].tools.length > MAX_ROWS || !own[0].tools.every(validName)
    || new Set(own[0].tools).size !== own[0].tools.length
    || own[0].tool_count !== own[0].tools.length) return null;
  return { present: true, enabled: own[0].enabled, tools: own[0].tools };
}

function readSessions(value) {
  if (!record(value) || !Array.isArray(value.sessions) || value.sessions.length > MAX_ROWS
    || value.complete === false || value.truncated === true) return null;
  const ids = new Set();
  for (const row of value.sessions) {
    if (!record(row) || typeof row.id !== "string" || !row.id || row.id.length > 256
      || ids.has(row.id) || !["idle", "working", "waiting", "starting"].includes(row.status)) return null;
    ids.add(row.id);
  }
  return value.sessions;
}

/**
 * Refresh the shared Python adapter through the selected Hermes backend's
 * official activation API. `rpc` and `activate` must be bound to the same
 * verified profile/dashboard; this helper neither discovers nor changes hosts.
 * The caller owns admission while refreshing: session.active_list is an
 * observation, not a host-wide drain lock. Busy/unknown hosts are left alone.
 * `ready` describes the global registry. Python tool snapshots held by existing
 * Agents are not rebuilt; requiresNewSession identifies those observed before a
 * successful registry refresh. No model invocation is needed to refresh it.
 */
async function syncHermesSharedAdapter({ rpc, activate, expectedTools, home,
  pluginName = HERMES_SHARED_PLUGIN, forceRefresh = false, isCurrent = () => true,
  isBusy = () => false } = {}) {
  if (typeof rpc !== "function" || typeof activate !== "function" || typeof isCurrent !== "function"
    || typeof isBusy !== "function"
    || !Array.isArray(expectedTools) || !expectedTools.length || expectedTools.length > 128
    || !expectedTools.every(validName) || new Set(expectedTools).size !== expectedTools.length
    || !validName(pluginName) || typeof forceRefresh !== "boolean"
    || typeof home !== "string" || home.length > 4096 || !path.isAbsolute(home) || path.resolve(home) !== home
    || /[\u0000-\u001f\u007f]/u.test(home)) {
    throw new TypeError("Invalid Hermes shared adapter synchronization options");
  }
  // Never let a caller mutate the expected contract during asynchronous probes.
  const expected = [...expectedTools];
  let stage = "observation";
  const current = () => isCurrent() === true;
  try {
    if (!current()) return result("unavailable", "HERMES_ADAPTER_OBSERVATION_STALE");
    const before = readToolset(await rpc("tools.list", {}), pluginName);
    if (!current()) return result("unavailable", "HERMES_ADAPTER_OBSERVATION_STALE");
    if (!before) return result("unavailable", "HERMES_ADAPTER_TOOLS_INVALID");
    if (!before.enabled) return result("unavailable", "HERMES_ADAPTER_TOOLSET_DISABLED");
    if (!forceRefresh && before.present && sameNames(before.tools, expected)) {
      return result("ready", null);
    }

    const busyBefore = isBusy();
    if (busyBefore === true) return result("deferred", "HERMES_ADAPTER_HOST_BUSY");
    if (busyBefore !== false) return result("unavailable", "HERMES_ADAPTER_SESSIONS_INVALID");
    const sessions = readSessions(await rpc("session.active_list", {}));
    if (!current()) return result("unavailable", "HERMES_ADAPTER_OBSERVATION_STALE");
    if (!sessions) return result("unavailable", "HERMES_ADAPTER_SESSIONS_INVALID");
    if (sessions.some(row => row.status !== "idle")) return result("deferred", "HERMES_ADAPTER_HOST_BUSY");
    const busyAfter = isBusy();
    if (busyAfter === true) return result("deferred", "HERMES_ADAPTER_HOST_BUSY");
    if (busyAfter !== false) return result("unavailable", "HERMES_ADAPTER_SESSIONS_INVALID");

    stage = "activation";
    const response = await activate(Object.freeze({ name: pluginName, home }));
    if (!current()) return result("unavailable", "HERMES_ADAPTER_OBSERVATION_STALE");
    const activation = response?.activation;
    if (!record(response) || response.ok !== true || !record(activation)
      || activation.name !== pluginName || typeof activation.key !== "string"
      || !(activation.key === pluginName || activation.key.endsWith(`/${pluginName}`))
      || !record(activation.deferred) || !Array.isArray(activation.deferred.tools)
      || !sameNames(activation.deferred.tools, expected)) {
      return result("unavailable", "HERMES_ADAPTER_ACTIVATION_INVALID");
    }

    stage = "verification";
    const after = readToolset(await rpc("tools.list", {}), pluginName);
    if (!current()) return result("unavailable", "HERMES_ADAPTER_OBSERVATION_STALE");
    if (!after?.present || !after.enabled || !sameNames(after.tools, expected)) {
      return result("unavailable", "HERMES_ADAPTER_VERIFICATION_FAILED");
    }
    return result("ready", null, true, sessions.length > 0);
  } catch {
    // Unsupported Hermes APIs and transport failures must not look like a
    // successful load. Do not return raw host errors, which can contain secrets.
    return result("unavailable", stage === "activation" ? "HERMES_ADAPTER_ACTIVATION_FAILED"
      : stage === "verification" ? "HERMES_ADAPTER_VERIFICATION_FAILED" : "HERMES_ADAPTER_OBSERVATION_FAILED");
  }
}

module.exports = { HERMES_SHARED_PLUGIN, syncHermesSharedAdapter };
