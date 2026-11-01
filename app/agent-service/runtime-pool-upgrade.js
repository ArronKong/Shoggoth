"use strict";

const { serviceError } = require("./security");
const changed = () => serviceError("RUNTIME_EXECUTABLE_CHANGED", "Runtime executable changed; wait for active work to finish and check again");

function identityOptions(pool, options = {}) {
  return { ...pool.hostOptions, ...pool.options,
    binaryPath: options.binaryPath ?? pool.options.binaryPath ?? pool.hostOptions?.binaryPath };
}

function observePoolIdentity(pool, binding, options = {}) {
  if (typeof pool.runtimeAccountResolver.observeExecutable !== "function") return null;
  return pool.runtimeAccountResolver.observeExecutable(binding,
    pool.runtimeAccountLookup(binding.runtimeAccountId), identityOptions(pool, options));
}

function poolRuntimeIdentityKey(pool, binding, options = {}) {
  return observePoolIdentity(pool, binding, options)?.stamp ?? null;
}

async function preparePoolHostIdentity(pool, entry, binding, options = {}) {
  const observation = observePoolIdentity(pool, binding, options);
  // Injected test/third-party pools may supply their own identity contract.
  // Every built-in production resolver implements observeExecutable().
  if (!observation) return;
  if (entry.host.profileState?.runtimeExecutableIdentity
    && entry.host.profileState.runtimeExecutableIdentity !== observation.stamp) throw changed();
  const identity = await pool.runtimeAccountResolver.captureExecutable(observation);
  entry.runtimeIdentity = identity;
  entry.binding = binding;
  entry.host.runtimeIdentity = identity;
  const environment = entry.runtimeEnvironment ?? entry.host.runtimeEnvironment ?? entry.host.options?.runtimeEnvironment;
  entry.host.assertRuntimeIdentityCurrent = () => {
    let current;
    try { current = observePoolIdentity(pool, binding, options); } catch {
      entry.runtimeChanged = true; throw changed();
    }
    if (entry.runtimeChanged || current.stamp !== identity.stamp
      || current.binaryPath !== environment?.binaryPath) {
      entry.runtimeChanged = true; throw changed();
    }
  };
  entry.host.assertRuntimeIdentityCurrent();
}

function idleForUpgrade(pool, entry, options) {
  if (entry.capacity && (!entry.capacity.ready || entry.capacity.pending || entry.capacity.retiring)) return false;
  if (entry.host.cleanupIncomplete || entry.host.state !== "ready") return false;
  if (entry.host.canRetireIdle && entry.host.canRetireIdle() !== true) return false;
  if (entry.host.rpc?.pending?.size || entry.host.rpc?.activeServerRequestIds?.size) return false;
  const guard = pool.options.canRetireChangedHost ?? pool.options.canRetireStaleHost ?? pool.canRetireHost;
  try { return typeof guard === "function" && guard(entry.binding, entry.host, options.executionContract?.runId) === true; }
  catch { return false; }
}

// The caller already holds this exact pool entry. A replacement can be created
// only after this host's cleanup has completed; sibling hosts are never stopped.
async function reusePoolHost(pool, entry, options, reacquire) {
  if (entry.upgradeCleanupFailed) throw changed();
  if (entry.retiring) { await entry.retiring; return reacquire(); }
  const host = await entry.promise;
  if (entry.retiring) { await entry.retiring; return reacquire(); }
  try { host.assertRuntimeIdentityCurrent?.(); return host; }
  catch (error) {
    if (error?.code !== "RUNTIME_EXECUTABLE_CHANGED") throw error;
    if (!idleForUpgrade(pool, entry, options)) throw error;
  }
  if (entry.retiring) { await entry.retiring; return reacquire(); }
  if (entry.capacity) entry.capacity.retiring = true;
  const retiring = Promise.resolve().then(() => host.stop()).then(() => {
    if (host.cleanupIncomplete) throw changed();
    if (pool.entries.get(entry.key) === entry) pool.entries.delete(entry.key);
  }).catch(() => {
    // Keep the failed entry as a fence even if a termination listener removed it.
    entry.upgradeCleanupFailed = true;
    if (!pool.entries.has(entry.key)) pool.entries.set(entry.key, entry);
    throw changed();
  });
  entry.retiring = retiring;
  await retiring;
  return reacquire();
}

async function cleanupFailedPoolHost(pool, entry, profileId) {
  let confirmed = true;
  try { await entry.host.stop(); } catch { confirmed = false; }
  if (!confirmed || entry.host.cleanupIncomplete) {
    // Retain the handle for Service shutdown/reconciliation as well as the
    // existing profile cleanup barrier. An exception is not an exit receipt.
    pool.blockedProfiles.add(profileId);
  } else if (pool.entries.get(entry.key) === entry) pool.entries.delete(entry.key);
}

module.exports = { preparePoolHostIdentity, reusePoolHost, poolRuntimeIdentityKey, cleanupFailedPoolHost };
