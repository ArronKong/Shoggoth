"use strict";

const { serviceError } = require("./security");

const DEFAULT_MAX_HOSTS = 116;
const HARD_MAX_HOSTS = 128;
const OPERATIONS = Object.freeze([
  "authenticationState", "modelsList", "sessionList", "sessionStart", "sessionResume",
  "sessionRead", "sessionRename", "sessionArchive", "sessionUnarchive", "sessionDelete",
  "turnStart", "turnSteer", "turnInterrupt", "commandsList", "commandExecute",
  // Background catalog refresh and incoming server requests can outlive callers.
  "_runControl", "_readModelCatalog", "_onServerRequest",
]);

function capacityError() {
  return serviceError("RUNTIME_HOST_CAPACITY", "Runtime host capacity is unavailable");
}

function executionRunIdForPool(options) {
  const value = options.executionContract?.runId;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > 256) {
    throw serviceError("RUNTIME_EXECUTION_CONTRACT_INVALID", "Runtime execution binding is invalid");
  }
  return value;
}

function configurePoolCapacity(pool, options, invalidCode) {
  pool.maxHosts = options.maxHosts ?? DEFAULT_MAX_HOSTS;
  pool.resolveMaxHosts = options.resolveMaxHosts;
  pool.canRetireHost = options.canRetireHost;
  if (!Number.isSafeInteger(pool.maxHosts) || pool.maxHosts < 1 || pool.maxHosts > HARD_MAX_HOSTS
    || (pool.resolveMaxHosts !== undefined && typeof pool.resolveMaxHosts !== "function")
    || (pool.canRetireHost !== undefined && typeof pool.canRetireHost !== "function")) {
    throw serviceError(invalidCode, "Runtime host capacity options are invalid");
  }
}

function poolHostLimit(pool) {
  let limit;
  try { limit = pool.resolveMaxHosts ? pool.resolveMaxHosts() : pool.maxHosts; } catch {
    throw capacityError();
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > HARD_MAX_HOSTS) throw capacityError();
  return limit;
}

function trackPoolHost(entry, binding) {
  entry.binding = binding;
  entry.capacity = { ready: false, pending: 0, retiring: false };
  for (const name of OPERATIONS) {
    const operation = entry.host[name];
    if (typeof operation !== "function") continue;
    entry.host[name] = function (...args) {
      if (entry.capacity.retiring) throw capacityError();
      entry.capacity.pending += 1;
      let result;
      try { result = operation.apply(this, args); } catch (error) {
        entry.capacity.pending -= 1;
        throw error;
      }
      if (result && typeof result.then === "function") {
        return Promise.resolve(result).finally(() => { entry.capacity.pending -= 1; });
      }
      entry.capacity.pending -= 1;
      return result;
    };
  }
}

function retirePoolHost(pool) {
  if (pool.capacityRetirement) return pool.capacityRetirement;
  // The Service guard protects acquired-but-not-yet-used hosts using durable
  // active Run/account state. Local I/O checks alone cannot prove this window idle.
  if (typeof pool.canRetireHost !== "function") return Promise.reject(capacityError());
  let selected;
  for (const entry of pool.entries.values()) {
    if (!entry.capacity?.ready || entry.capacity.pending || entry.capacity.retiring
      || pool.stoppingProfiles.has(entry.runtimeProfileId)
      || pool.blockedProfiles.has(entry.runtimeProfileId)) continue;
    try {
      if (entry.host.canRetireIdle?.() !== true
        || pool.canRetireHost(entry.binding, entry.host) !== true) continue;
    } catch { continue; }
    selected = entry;
    break;
  }
  if (!selected) return Promise.reject(capacityError());
  selected.capacity.retiring = true;
  // Keep the entry counted until cleanup finishes; retiring one workspace must
  // never call the pool's profile-wide stop and interrupt a sibling host.
  const retiring = pool._stopEntries([selected]).then(() => {
    if (pool.entries.get(selected.key) === selected) pool.entries.delete(selected.key);
  }, () => {
    pool.blockedProfiles.add(selected.runtimeProfileId);
    throw capacityError();
  }).finally(() => {
    if (pool.capacityRetirement === retiring) pool.capacityRetirement = null;
  });
  selected.retiring = retiring;
  pool.capacityRetirement = retiring;
  return retiring;
}

module.exports = {
  DEFAULT_MAX_HOSTS, HARD_MAX_HOSTS, configurePoolCapacity, poolHostLimit,
  retirePoolHost, trackPoolHost, executionRunIdForPool,
};
