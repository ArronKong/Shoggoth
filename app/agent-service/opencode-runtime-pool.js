"use strict";

const { OpenCodeRuntimeHost } = require("./opencode-runtime-host");
const { OPENCODE_RUNTIME, normalizeOpenCodePermissionPolicy, normalizeOpenCodeWorkspace } = require("./opencode-runtime-paths");
const { poolLedgerSlot } = require("./runtime-shared-ledger");
const { runtimeBinding, validRuntimeProfileId } = require("./runtime-adapter");
const { NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID } = require("./runtime-account");
const { RuntimeAccountResolver, defaultRuntimeAccountLookup, validateResolvedEnvironment } = require("./runtime-account-resolver");
const { configurePoolCapacity, poolHostLimit, retirePoolHost, trackPoolHost, executionRunIdForPool } = require("./runtime-pool-capacity");
const { serviceError } = require("./security");

const poolError = (code, message) => serviceError(code, message);

class OpenCodeRuntimePool {
  constructor(options = {}) {
    this.options = { ...options };
    this.hostOptions = { ...(options.hostOptions || {}) };
    this.hostFactory = options.hostFactory || (value => new OpenCodeRuntimeHost(value));
    this.runtimeAccountLookup = options.runtimeAccountLookup || defaultRuntimeAccountLookup;
    this.runtimeAccountResolver = options.runtimeAccountResolver || new RuntimeAccountResolver({
      paths: options.paths ?? this.hostOptions.paths, fs: options.fs ?? this.hostOptions.fs,
      parentEnv: options.parentEnv ?? this.hostOptions.parentEnv,
      homedir: options.homedir ?? this.hostOptions.homedir,
    });
    configurePoolCapacity(this, { ...options, maxHosts: options.maxHosts ?? 8 }, "OPENCODE_POOL_OPTIONS_INVALID");
    this.entries = new Map();
    this.stoppingProfiles = new Set();
    this.blockedProfiles = new Set();
    this.stopPromises = new Map();
    this.stopAllPromise = null;
    this.closing = false;
  }

  async get(value, options = {}) {
    const binding = typeof value === "string" ? runtimeBinding({ runtime: OPENCODE_RUNTIME,
      runtimeProfileId: value, runtimeAccountId: NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID }) : runtimeBinding(value);
    if (binding.runtime !== OPENCODE_RUNTIME) throw poolError("RUNTIME_UNSUPPORTED", "OpenCode binding is invalid");
    const profileId = binding.runtimeProfileId;
    if (this.closing || this.stoppingProfiles.has(profileId)) throw poolError("OPENCODE_POOL_STOPPING", "OpenCode pool is stopping");
    if (this.blockedProfiles.has(profileId)) throw poolError("OPENCODE_CLEANUP_INCOMPLETE", "OpenCode cleanup is incomplete");
    const controlInstance = !Object.prototype.hasOwnProperty.call(options, "workspace");
    const workspace = controlInstance ? null : normalizeOpenCodeWorkspace(options.workspace);
    const executionRunId = executionRunIdForPool(options);
    const policy = normalizeOpenCodePermissionPolicy(options.permissionPolicy);
    const fingerprint = JSON.stringify(policy);
    const key = JSON.stringify([profileId, binding.runtimeAccountId,
      controlInstance ? "control" : "execution", workspace, executionRunId]);
    const conflicting = [...this.entries.values()].find(entry => entry.runtimeProfileId === profileId
      && entry.runtimeAccountId !== binding.runtimeAccountId);
    if (conflicting) throw poolError("RUNTIME_ACCOUNT_BINDING_CONFLICT", "Stop OpenCode before changing its RuntimeAccount");
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.retiring) return existing.retiring.then(() => this.get(binding, options));
      if (existing.policyFingerprint !== fingerprint) throw poolError("RUNTIME_PERMISSION_POLICY_CONFLICT", "Stop OpenCode before changing permission policy");
      const host = await existing.promise;
      host.beginAcquire();
      return host;
    }
    if (this.entries.size >= poolHostLimit(this)) {
      await retirePoolHost(this);
      return this.get(binding, options);
    }
    const runtimeEnvironment = validateResolvedEnvironment(this.runtimeAccountResolver.resolve(
      binding, this.runtimeAccountLookup(binding.runtimeAccountId), {
        binaryPath: options.binaryPath ?? this.options.binaryPath ?? this.hostOptions.binaryPath,
      }), binding);
    const ledgerKey = JSON.stringify([profileId, binding.runtimeAccountId,
      controlInstance ? "control" : "execution", workspace]);
    const ledgerSlot = poolLedgerSlot(this, ledgerKey);
    const host = this.hostFactory({ ...this.hostOptions, ...this.options,
      runtimeBinding: binding, runtimeEnvironment, permissionPolicy: policy,
      controlInstance, workspace, mcpExecutionRunId: executionRunId,
      ledgerSlot, paths: this.options.paths ?? this.hostOptions.paths });
    const entry = { host, key, ledgerKey, ledgerSlot, policyFingerprint: fingerprint,
      runtimeProfileId: profileId, runtimeAccountId: binding.runtimeAccountId,
      promise: null };
    trackPoolHost(entry, binding);
    entry.promise = Promise.resolve().then(() => host.initialize()).then(() => {
      entry.capacity.ready = true;
      host.terminated?.finally(() => { if (this.entries.get(key) === entry) this.entries.delete(key); }).catch(() => {});
      return host;
    }).catch(async cause => {
      try { await host.stop(); } catch { this.blockedProfiles.add(profileId); }
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw cause;
    });
    this.entries.set(key, entry);
    return entry.promise;
  }

  async _stopEntries(entries) {
    const results = await Promise.allSettled(entries.map(entry => entry.promise.then(host => host.stop(),
      () => entry.host.stop())));
    const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, "OpenCode runtime cleanup failed");
  }

  stop(value) {
    const profileId = typeof value === "string" ? value : runtimeBinding(value).runtimeProfileId;
    if (!validRuntimeProfileId(profileId)) throw poolError("OPENCODE_RUNTIME_PROFILE_INVALID", "OpenCode profile id is invalid");
    if (this.stopPromises.has(profileId)) return this.stopPromises.get(profileId);
    const entries = [...this.entries.values()].filter(entry => entry.runtimeProfileId === profileId);
    if (!entries.length) return Promise.resolve();
    for (const entry of entries) this.entries.delete(entry.key);
    this.stoppingProfiles.add(profileId);
    const stopping = this._stopEntries(entries).catch(cause => {
      this.blockedProfiles.add(profileId);
      throw cause;
    }).finally(() => { this.stoppingProfiles.delete(profileId); this.stopPromises.delete(profileId); });
    this.stopPromises.set(profileId, stopping);
    return stopping;
  }

  stopAll() {
    if (this.stopAllPromise) return this.stopAllPromise;
    this.closing = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.stopAllPromise = this._stopEntries(entries).finally(() => {
      this.closing = false; this.stopAllPromise = null;
    });
    return this.stopAllPromise;
  }
}

module.exports = { OpenCodeRuntimePool };
