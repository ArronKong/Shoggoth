"use strict";

const { GrokBuildRuntimeHost } = require("./grok-build-runtime-host");
const {
  GROK_BUILD_RUNTIME,
  grokBuildPermissionFingerprint,
  normalizeGrokBuildPermissionPolicy,
  normalizeGrokBuildWorkspace,
} = require("./grok-build-runtime-paths");
const { runtimeBinding, validRuntimeProfileId } = require("./runtime-adapter");
const { NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID } = require("./runtime-account");
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
    throw poolError("GROK_BUILD_RUNTIME_PROFILE_INVALID", "Grok Build runtime profile id is invalid");
  }
  return value;
}

function poolBinding(value) {
  const binding = typeof value === "string" ? runtimeBinding({
    runtime: GROK_BUILD_RUNTIME,
    runtimeProfileId: value,
    runtimeAccountId: NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
  }) : runtimeBinding(value);
  if (binding.runtime !== GROK_BUILD_RUNTIME) {
    throw poolError("RUNTIME_UNSUPPORTED", `Grok Build pool cannot run ${binding.runtime}`);
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
  if (error.code === "GROK_BUILD_PROCESS_CLOSE_TIMEOUT") return true;
  return Array.isArray(error.errors)
    && error.errors.some((nested) => containsCleanupTimeout(nested, seen));
}

class GrokBuildRuntimePool {
  constructor(options = {}) {
    this.options = { ...options };
    this.hostOptions = { ...(options.hostOptions || {}) };
    this.hostFactory = options.hostFactory
      || ((hostOptions) => new GrokBuildRuntimeHost(hostOptions));
    this.runtimeAccountLookup = options.runtimeAccountLookup || defaultRuntimeAccountLookup;
    this.runtimeAccountResolver = options.runtimeAccountResolver || new RuntimeAccountResolver({
      paths: options.paths ?? options.hostOptions?.paths,
      fs: options.fs ?? options.hostOptions?.fs,
      parentEnv: options.parentEnv ?? options.hostOptions?.parentEnv,
      homedir: options.homedir ?? options.hostOptions?.homedir,
    });
    this.maxHosts = options.maxHosts ?? 16;
    if (!Number.isSafeInteger(this.maxHosts) || this.maxHosts < 1 || this.maxHosts > 64) {
      throw poolError("GROK_BUILD_POOL_OPTIONS_INVALID", "Grok Build host limit is invalid");
    }
    this.entries = new Map();
    this.stopPromises = new Map();
    this.stoppingProfiles = new Set();
    this.blockedProfiles = new Set();
    this.authProofs = new Map();
    this.closing = false;
    this.stopAllPromise = null;
  }

  get(value, options = {}) {
    let binding;
    try { binding = poolBinding(value); } catch (error) { return Promise.reject(error); }
    return this._get(binding, options);
  }

  _get(binding, options) {
    const id = binding.runtimeProfileId;
    const accountId = binding.runtimeAccountId;
    const controlInstance = !Object.prototype.hasOwnProperty.call(options, "workspace");
    const workspace = controlInstance ? null : normalizeGrokBuildWorkspace(options.workspace);
    const key = routeKey(id, accountId, controlInstance, workspace);
    const permissionPolicy = normalizeGrokBuildPermissionPolicy(options.permissionPolicy);
    const policyFingerprint = grokBuildPermissionFingerprint(permissionPolicy);
    if (this.blockedProfiles.has(id)) {
      return Promise.reject(poolError(
        "GROK_BUILD_RUNTIME_CLEANUP_INCOMPLETE",
        "Grok Build runtime cleanup is incomplete for this profile",
      ));
    }
    if (this.closing || this.stoppingProfiles.has(id)) {
      return Promise.reject(poolError("GROK_BUILD_POOL_STOPPING", "Grok Build runtime pool is stopping"));
    }
    const conflicting = [...this.entries.values()].find((entry) => (
      entry.runtimeProfileId === id && entry.runtimeAccountId !== accountId
    ));
    if (conflicting) {
      return Promise.reject(poolError(
        "RUNTIME_ACCOUNT_BINDING_CONFLICT",
        "Stop the existing Grok Build runtime before changing its RuntimeAccount",
      ));
    }
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.policyFingerprint !== policyFingerprint) {
        return Promise.reject(poolError(
          "RUNTIME_PERMISSION_POLICY_CONFLICT",
          "Stop the existing Grok Build runtime before changing its permission policy",
        ));
      }
      return existing.promise.then((host) => {
        host.beginAcquire();
        return host;
      });
    }
    if (this.entries.size >= this.maxHosts) {
      return Promise.reject(poolError(
        "GROK_BUILD_HOST_LIMIT",
        "Grok Build runtime host limit was reached",
      ));
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
      stateRoot: this.options.stateRoot ?? this.hostOptions.stateRoot,
      trustedRoot: this.options.trustedRoot ?? this.hostOptions.trustedRoot,
      binaryPath: this.options.binaryPath ?? this.hostOptions.binaryPath,
      fs: this.options.fs ?? this.hostOptions.fs,
      spawnProcess: this.options.spawnProcess ?? this.hostOptions.spawnProcess,
      resolveProxy: this.options.resolveProxy ?? this.hostOptions.resolveProxy,
      parentEnv: this.options.parentEnv ?? this.hostOptions.parentEnv,
      homedir: this.options.homedir ?? this.hostOptions.homedir,
      spawnEnv: this.options.spawnEnv ?? this.hostOptions.spawnEnv,
      packageVersion: this.options.packageVersion ?? this.hostOptions.packageVersion,
      initializeTimeoutMs: this.options.initializeTimeoutMs ?? this.hostOptions.initializeTimeoutMs,
      requestTimeoutMs: this.options.requestTimeoutMs ?? this.hostOptions.requestTimeoutMs,
      serverRequestTimeoutMs: this.options.serverRequestTimeoutMs
        ?? this.hostOptions.serverRequestTimeoutMs,
      promptTimeoutMs: this.options.promptTimeoutMs ?? this.hostOptions.promptTimeoutMs,
      acceptanceTimeoutMs: this.options.acceptanceTimeoutMs ?? this.hostOptions.acceptanceTimeoutMs,
      shutdownGraceMs: this.options.shutdownGraceMs ?? this.hostOptions.shutdownGraceMs,
      killGraceMs: this.options.killGraceMs ?? this.hostOptions.killGraceMs,
      maxFrameBytes: this.options.maxFrameBytes ?? this.hostOptions.maxFrameBytes,
      killProcessGroup: this.options.killProcessGroup ?? this.hostOptions.killProcessGroup,
      processGroupExists: this.options.processGroupExists ?? this.hostOptions.processGroupExists,
      now: this.options.now ?? this.hostOptions.now,
      randomUUID: this.options.randomUUID ?? this.hostOptions.randomUUID,
      onDiagnostic: this.options.onDiagnostic ?? this.hostOptions.onDiagnostic,
      mcpServers: options.mcpServers ?? this.options.mcpServers ?? this.hostOptions.mcpServers,
      mcpServersFactory: options.mcpServersFactory
        ?? this.options.mcpServersFactory ?? this.hostOptions.mcpServersFactory,
      createMcpServer: options.createMcpServer
        ?? this.options.createMcpServer ?? this.hostOptions.createMcpServer,
      runtimeProfileId: id,
      runtimeAccountId: accountId,
      runtimeBinding: binding,
      runtimeEnvironment,
      permissionPolicy,
      controlInstance,
      workspace,
      authProof: Object.freeze({
        read: () => this.authProofs.get(accountId) || null,
        verify: (fingerprint) => {
          if (typeof fingerprint !== "string" || fingerprint.length === 0
            || Buffer.byteLength(fingerprint, "utf8") > 1024) {
            throw poolError("GROK_BUILD_AUTH_PROOF_INVALID", "Grok Build auth proof is invalid");
          }
          this.authProofs.set(accountId, fingerprint);
        },
        invalidate: (fingerprint) => {
          if (typeof fingerprint !== "string" || fingerprint.length === 0
            || Buffer.byteLength(fingerprint, "utf8") > 1024) {
            throw poolError("GROK_BUILD_AUTH_PROOF_INVALID", "Grok Build auth proof is invalid");
          }
          if (this.authProofs.get(accountId) === fingerprint) this.authProofs.delete(accountId);
        },
        clear: (fingerprint) => {
          if (typeof fingerprint !== "string" || fingerprint.length === 0
            || Buffer.byteLength(fingerprint, "utf8") > 1024) {
            throw poolError("GROK_BUILD_AUTH_PROOF_INVALID", "Grok Build auth proof is invalid");
          }
          if (this.authProofs.get(accountId) === fingerprint) this.authProofs.delete(accountId);
        },
      }),
    });
    const entry = {
      host, key, runtimeProfileId: id, runtimeAccountId: accountId,
      workspace, controlInstance, policyFingerprint, promise: null,
    };
    entry.promise = Promise.resolve().then(() => host.initialize()).then(() => {
      if (host.terminated && typeof host.terminated.then === "function") {
        Promise.resolve(host.terminated).then(
          () => {
            if (this.entries.get(key) === entry) this.entries.delete(key);
          },
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
    this.authProofs.clear();
    const entries = [...this.entries.entries()];
    this.entries.clear();
    const profileIds = new Set(entries.map(([, entry]) => entry.runtimeProfileId));
    for (const id of profileIds) this.stoppingProfiles.add(id);
    this.stopAllPromise = (async () => {
      const failures = [];
      try {
        await this._stopEntries(entries.map(([, entry]) => entry));
      } catch (error) {
        failures.push(...(Array.isArray(error?.errors) ? error.errors : [error]));
      }
      const inFlight = await Promise.allSettled([...this.stopPromises.values()]);
      for (const result of inFlight) if (result.status === "rejected") failures.push(result.reason);
      if (failures.length > 0) {
        const aggregate = new AggregateError(failures, "Grok Build runtime pool stop failed");
        aggregate.code = "GROK_BUILD_RUNTIME_POOL_STOP_FAILED";
        throw aggregate;
      }
    })().finally(() => {
      for (const id of profileIds) this.stoppingProfiles.delete(id);
      this.closing = false;
      this.stopAllPromise = null;
    });
    return this.stopAllPromise;
  }

  async _stopEntries(entries) {
    const failures = [];
    await Promise.all(entries.map(async (entry) => {
      const [stopResult] = await Promise.allSettled([
        Promise.resolve().then(() => entry.host.stop()),
        entry.promise,
      ]);
      if (stopResult.status === "rejected") {
        if (entry.host.cleanupIncomplete || containsCleanupTimeout(stopResult.reason)) {
          this.blockedProfiles.add(entry.runtimeProfileId);
        }
        failures.push(stopResult.reason);
      }
    }));
    if (failures.length > 0) {
      const aggregate = new AggregateError(failures, "Grok Build runtime pool stop failed");
      aggregate.code = "GROK_BUILD_RUNTIME_POOL_STOP_FAILED";
      throw aggregate;
    }
  }
}

module.exports = { GrokBuildRuntimePool };
