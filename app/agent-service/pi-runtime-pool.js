"use strict";

const { PiRuntimeHost } = require("./pi-runtime-host");
const {
  PI_RUNTIME,
  normalizePiPermissionPolicy,
  normalizePiWorkspace,
  piPermissionFingerprint,
} = require("./pi-runtime-paths");
const { runtimeBinding, validRuntimeProfileId } = require("./runtime-adapter");
const { NATIVE_PI_RUNTIME_ACCOUNT_ID } = require("./runtime-account");
const {
  RuntimeAccountResolver,
  defaultRuntimeAccountLookup,
  validateResolvedEnvironment,
} = require("./runtime-account-resolver");
const { serviceError } = require("./security");

function poolError(code, message) {
  return serviceError(code, message);
}

function profileId(value) {
  if (!validRuntimeProfileId(value)) {
    throw poolError("PI_RUNTIME_PROFILE_INVALID", "Pi runtime profile id is invalid");
  }
  return value;
}

function poolBinding(value) {
  const binding = typeof value === "string" ? runtimeBinding({
    runtime: PI_RUNTIME,
    runtimeProfileId: value,
    runtimeAccountId: NATIVE_PI_RUNTIME_ACCOUNT_ID,
  }) : runtimeBinding(value);
  if (binding.runtime !== PI_RUNTIME) {
    throw poolError("RUNTIME_UNSUPPORTED", `Pi pool cannot run ${binding.runtime}`);
  }
  return binding;
}

function routeKey(runtimeProfileId, runtimeAccountId, controlInstance, workspace) {
  return JSON.stringify([
    runtimeProfileId,
    runtimeAccountId,
    controlInstance ? "control" : "execution",
    workspace,
  ]);
}

function containsCleanupTimeout(error, seen = new Set()) {
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  if (error.code === "PI_PROCESS_CLOSE_TIMEOUT") return true;
  return Array.isArray(error.errors)
    && error.errors.some((nested) => containsCleanupTimeout(nested, seen));
}

class PiRuntimePool {
  constructor(options = {}) {
    this.options = { ...options };
    this.hostOptions = { ...(options.hostOptions || {}) };
    this.hostFactory = options.hostFactory || ((hostOptions) => new PiRuntimeHost(hostOptions));
    this.runtimeAccountLookup = options.runtimeAccountLookup || defaultRuntimeAccountLookup;
    this.runtimeAccountResolver = options.runtimeAccountResolver || new RuntimeAccountResolver({
      paths: options.paths ?? options.hostOptions?.paths,
      fs: options.fs ?? options.hostOptions?.fs,
      parentEnv: options.parentEnv ?? options.hostOptions?.parentEnv,
      homedir: options.homedir ?? options.hostOptions?.homedir,
    });
    this.maxHosts = options.maxHosts ?? 16;
    if (!Number.isSafeInteger(this.maxHosts) || this.maxHosts < 1 || this.maxHosts > 64) {
      throw poolError("PI_POOL_OPTIONS_INVALID", "Pi host limit is invalid");
    }
    this.entries = new Map();
    this.profileStates = new Map();
    this.stopPromises = new Map();
    this.stoppingProfiles = new Set();
    this.blockedProfiles = new Set();
    this.closing = false;
    this.stopAllPromise = null;
  }

  get(value, options = {}) {
    let binding;
    try { binding = poolBinding(value); } catch (error) { return Promise.reject(error); }
    const id = binding.runtimeProfileId;
    const accountId = binding.runtimeAccountId;
    const controlInstance = !Object.prototype.hasOwnProperty.call(options, "workspace");
    const workspace = controlInstance ? null : normalizePiWorkspace(options.workspace);
    const key = routeKey(id, accountId, controlInstance, workspace);
    const permissionPolicy = normalizePiPermissionPolicy(options.permissionPolicy);
    const policyFingerprint = piPermissionFingerprint(permissionPolicy);
    if (this.blockedProfiles.has(id)) {
      return Promise.reject(poolError("PI_RUNTIME_CLEANUP_INCOMPLETE", "Pi cleanup is incomplete"));
    }
    if (this.closing || this.stoppingProfiles.has(id)) {
      return Promise.reject(poolError("PI_POOL_STOPPING", "Pi pool is stopping"));
    }
    const conflicting = [...this.entries.values()].find((entry) => (
      entry.runtimeProfileId === id && entry.runtimeAccountId !== accountId
    ));
    if (conflicting) {
      return Promise.reject(poolError(
        "RUNTIME_ACCOUNT_BINDING_CONFLICT",
        "Stop the Pi runtime before changing its RuntimeAccount",
      ));
    }
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.policyFingerprint !== policyFingerprint) {
        return Promise.reject(poolError(
          "RUNTIME_PERMISSION_POLICY_CONFLICT",
          "Stop the Pi runtime before changing its permission policy",
        ));
      }
      return existing.promise.then((host) => { host.beginAcquire(); return host; });
    }
    if (this.entries.size >= this.maxHosts) {
      return Promise.reject(poolError("PI_HOST_LIMIT", "Pi host limit was reached"));
    }
    let profileState = this.profileStates.get(accountId);
    if (!profileState) {
      profileState = { models: null, modelsExpiresAt: 0, auth: null, authExpiresAt: 0 };
      this.profileStates.set(accountId, profileState);
    }
    let runtimeEnvironment;
    try {
      runtimeEnvironment = validateResolvedEnvironment(this.runtimeAccountResolver.resolve(
        binding,
        this.runtimeAccountLookup(accountId),
        { binaryPath: options.binaryPath ?? this.options.binaryPath ?? this.hostOptions.binaryPath },
      ), binding);
    } catch (error) {
      return Promise.reject(error);
    }
    const host = this.hostFactory({
      ...this.hostOptions,
      paths: this.options.paths ?? this.hostOptions.paths,
      binaryPath: this.options.binaryPath ?? this.hostOptions.binaryPath,
      extensionPath: this.options.extensionPath ?? this.hostOptions.extensionPath,
      fs: this.options.fs ?? this.hostOptions.fs,
      spawnProcess: this.options.spawnProcess ?? this.hostOptions.spawnProcess,
      parentEnv: this.options.parentEnv ?? this.hostOptions.parentEnv,
      homedir: this.options.homedir ?? this.hostOptions.homedir,
      requestTimeoutMs: this.options.requestTimeoutMs ?? this.hostOptions.requestTimeoutMs,
      promptTimeoutMs: this.options.promptTimeoutMs ?? this.hostOptions.promptTimeoutMs,
      acceptanceTimeoutMs: this.options.acceptanceTimeoutMs ?? this.hostOptions.acceptanceTimeoutMs,
      shutdownGraceMs: this.options.shutdownGraceMs ?? this.hostOptions.shutdownGraceMs,
      killGraceMs: this.options.killGraceMs ?? this.hostOptions.killGraceMs,
      maxFrameBytes: this.options.maxFrameBytes ?? this.hostOptions.maxFrameBytes,
      maxStreamBytes: this.options.maxStreamBytes ?? this.hostOptions.maxStreamBytes,
      killProcessGroup: this.options.killProcessGroup ?? this.hostOptions.killProcessGroup,
      now: this.options.now ?? this.hostOptions.now,
      randomUUID: this.options.randomUUID ?? this.hostOptions.randomUUID,
      onDiagnostic: this.options.onDiagnostic ?? this.hostOptions.onDiagnostic,
      mcpGateIssuer: this.options.mcpGateIssuer ?? this.hostOptions.mcpGateIssuer,
      runtimeProfileId: id,
      runtimeAccountId: accountId,
      runtimeBinding: binding,
      runtimeEnvironment,
      permissionPolicy,
      controlInstance,
      workspace,
      profileState,
    });
    const entry = {
      host, key, runtimeProfileId: id, runtimeAccountId: accountId, policyFingerprint, promise: null,
    };
    entry.promise = Promise.resolve().then(() => host.initialize()).then(() => {
      if (host.terminated && typeof host.terminated.then === "function") {
        Promise.resolve(host.terminated).then(
          () => { if (this.entries.get(key) === entry) this.entries.delete(key); },
          (error) => {
            if (this.entries.get(key) !== entry) return;
            if (error?.cleanupIncomplete || host.cleanupIncomplete) this.blockedProfiles.add(id);
            this.entries.delete(key);
          },
        );
      }
      return host;
    }).catch(async (error) => {
      try { await host.stop(); } catch {}
      if (this.entries.get(key) === entry) this.entries.delete(key);
      if (host.cleanupIncomplete) this.blockedProfiles.add(id);
      throw error;
    });
    this.entries.set(key, entry);
    return entry.promise;
  }

  stop(runtimeProfileId) {
    const id = profileId(runtimeProfileId);
    const existing = this.stopPromises.get(id);
    if (existing) return existing;
    const entries = [...this.entries.entries()].filter(([, entry]) => entry.runtimeProfileId === id);
    if (entries.length === 0) return Promise.resolve();
    for (const [key] of entries) this.entries.delete(key);
    this.stoppingProfiles.add(id);
    const stopping = this._stopEntries(entries.map(([, entry]) => entry)).finally(() => {
      this.stopPromises.delete(id);
      this.stoppingProfiles.delete(id);
    });
    this.stopPromises.set(id, stopping);
    return stopping;
  }

  stopAll() {
    if (this.stopAllPromise) return this.stopAllPromise;
    this.closing = true;
    this.profileStates.clear();
    const entries = [...this.entries.entries()];
    this.entries.clear();
    const profileIds = new Set(entries.map(([, entry]) => entry.runtimeProfileId));
    for (const id of profileIds) this.stoppingProfiles.add(id);
    this.stopAllPromise = this._stopEntries(entries.map(([, entry]) => entry)).finally(() => {
      for (const id of profileIds) this.stoppingProfiles.delete(id);
      this.closing = false;
      this.stopAllPromise = null;
    });
    return this.stopAllPromise;
  }

  async _stopEntries(entries) {
    const failures = [];
    await Promise.all(entries.map(async (entry) => {
      const [result] = await Promise.allSettled([
        Promise.resolve().then(() => entry.host.stop()),
        entry.promise,
      ]);
      if (result.status === "rejected") {
        if (entry.host.cleanupIncomplete || containsCleanupTimeout(result.reason)) {
          this.blockedProfiles.add(entry.runtimeProfileId);
        }
        failures.push(result.reason);
      }
    }));
    if (failures.length > 0) {
      const aggregate = new AggregateError(failures, "Pi runtime pool stop failed");
      aggregate.code = "PI_RUNTIME_POOL_STOP_FAILED";
      throw aggregate;
    }
  }
}

module.exports = { PiRuntimePool };
