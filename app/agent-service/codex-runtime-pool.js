"use strict";

const { CodexRuntimeHost } = require("./codex-runtime-host");
const { assertRuntimeProfileId, runtimeError } = require("./codex-runtime-paths");
const { runtimeBinding } = require("./runtime-adapter");
const { SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("./runtime-account");
const {
  RuntimeAccountResolver,
  defaultRuntimeAccountLookup,
  validateResolvedEnvironment,
} = require("./runtime-account-resolver");
const { runtimeStageError, runtimeStageFromError } = require("./runtime-stage-error");

function containsErrorCode(error, code, seen = new Set()) {
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  if (error.code === code) return true;
  const nested = error instanceof AggregateError ? error.errors : error.errors;
  return Array.isArray(nested) && nested.some((entry) => containsErrorCode(entry, code, seen));
}

class CodexRuntimePool {
  constructor(options = {}) {
    this.options = { ...options };
    this.paths = options.paths;
    this.runtimeAccountLookup = options.runtimeAccountLookup || defaultRuntimeAccountLookup;
    this.runtimeAccountResolver = options.runtimeAccountResolver || new RuntimeAccountResolver({
      ...options.hostOptions,
      paths: options.paths,
      fs: options.fs ?? options.hostOptions?.fs,
      parentEnv: options.parentEnv ?? options.hostOptions?.parentEnv,
      homedir: options.homedir ?? options.hostOptions?.homedir,
      repoRoot: options.repoRoot ?? options.hostOptions?.repoRoot,
      packaged: options.packaged ?? options.hostOptions?.packaged,
      resourcesPath: options.resourcesPath ?? options.hostOptions?.resourcesPath,
    });
    this.hostFactory = options.hostFactory || ((hostOptions) => new CodexRuntimeHost(hostOptions));
    this.now = options.now || Date.now;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.failureWindowMs = options.failureWindowMs ?? 60_000;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.entries = new Map();
    this.circuits = new Map();
    this.stoppingProfiles = new Set();
    this.stopPromises = new Map();
    this.blockedProfiles = new Set();
    this.closing = false;
    this.stopAllPromise = null;
  }

  get(value, options = {}) {
    const binding = typeof value === "string"
      ? runtimeBinding({
        runtime: "codex",
        runtimeProfileId: value,
        runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      })
      : runtimeBinding(value);
    if (binding.runtime !== "codex") {
      return Promise.reject(runtimeError("RUNTIME_UNSUPPORTED", `Codex pool cannot run ${binding.runtime}`));
    }
    const { runtimeProfileId, runtimeAccountId } = binding;
    assertRuntimeProfileId(runtimeProfileId);
    if (this.blockedProfiles.has(runtimeProfileId)) {
      return Promise.reject(runtimeError(
        "CODEX_RUNTIME_CLEANUP_INCOMPLETE",
        "Codex runtime cleanup is incomplete for this profile",
      ));
    }
    if (this.closing || this.stoppingProfiles.has(runtimeProfileId)) {
      return Promise.reject(runtimeError("CODEX_POOL_STOPPING", "Codex runtime pool is stopping"));
    }
    const key = JSON.stringify([runtimeProfileId, runtimeAccountId]);
    const conflicting = [...this.entries.values()].find((entry) => (
      entry.runtimeProfileId === runtimeProfileId && entry.runtimeAccountId !== runtimeAccountId
    ));
    if (conflicting) {
      return Promise.reject(runtimeError(
        "RUNTIME_ACCOUNT_BINDING_CONFLICT",
        "Stop the existing Codex runtime before changing its RuntimeAccount",
      ));
    }
    const existing = this.entries.get(key);
    if (existing) return existing.promise;
    const now = this.now();
    const circuit = this.circuits.get(runtimeProfileId);
    if (circuit?.openUntil > now) {
      return Promise.reject(runtimeError("CODEX_CIRCUIT_OPEN", "Codex runtime circuit breaker is open"));
    }
    let account;
    let runtimeEnvironment;
    try {
      account = this.runtimeAccountLookup(runtimeAccountId);
      runtimeEnvironment = validateResolvedEnvironment(this.runtimeAccountResolver.resolve(
        binding,
        account,
        {
          binaryPath: options.binaryPath ?? this.options.binaryPath,
          repoRoot: this.options.repoRoot ?? this.options.hostOptions?.repoRoot,
          packaged: this.options.packaged ?? this.options.hostOptions?.packaged,
          resourcesPath: this.options.resourcesPath ?? this.options.hostOptions?.resourcesPath,
        },
      ), binding);
    } catch (error) {
      return Promise.reject(error);
    }
    const host = this.hostFactory({
      ...this.options.hostOptions,
      paths: this.paths,
      parentEnv: this.options.parentEnv ?? this.options.hostOptions?.parentEnv,
      homedir: this.options.homedir ?? this.options.hostOptions?.homedir,
      runtimeProfileId,
      runtimeAccountId,
      runtimeBinding: binding,
      runtimeEnvironment,
      spawnEnv: options.spawnEnv,
      nativeAuth: this.options.nativeAuth,
    });
    this.options.nativeAuth?.open();
    const entry = { host, runtimeProfileId, runtimeAccountId, promise: null };
    entry.promise = Promise.resolve().then(() => host.initialize()).then(() => {
      this.circuits.delete(runtimeProfileId);
      if (host.terminated && typeof host.terminated.then === "function") {
        host.terminated.then(
          () => {
            if (this.entries.get(key) === entry) this.entries.delete(key);
          },
          (error) => {
            if (this.entries.get(key) !== entry) return;
            if (error?.cleanupIncomplete || host.cleanupIncomplete) this.blockedProfiles.add(runtimeProfileId);
            this.entries.delete(key);
            this._recordFailure(runtimeProfileId);
          },
        );
      }
      return host;
    }).catch(async (error) => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      try { await host.stop(); } catch {}
      if (host.cleanupIncomplete) this.blockedProfiles.add(runtimeProfileId);
      const credentialsLocked = error?.code === "credentials_locked";
      if (!credentialsLocked && !this.closing && !this.stoppingProfiles.has(runtimeProfileId)) {
        this._recordFailure(runtimeProfileId);
      }
      if (credentialsLocked || runtimeStageFromError(error)) throw error;
      throw runtimeStageError(
        host.startupStage === "rpc_initialize" ? "rpc_initialize" : "process_spawn",
        error,
      );
    });
    this.entries.set(key, entry);
    return entry.promise;
  }

  _recordFailure(runtimeProfileId) {
    const now = this.now();
    const previous = this.circuits.get(runtimeProfileId);
    const failures = (previous?.failures || []).filter((timestamp) => now - timestamp <= this.failureWindowMs);
    failures.push(now);
    const openUntil = failures.length >= this.failureThreshold ? now + this.cooldownMs : 0;
    this.circuits.set(runtimeProfileId, { failures, openUntil });
  }

  async stop(runtimeProfileId) {
    assertRuntimeProfileId(runtimeProfileId);
    const existingStop = this.stopPromises.get(runtimeProfileId);
    if (existingStop) return existingStop;
    const entries = [...this.entries.entries()].filter(([, entry]) => (
      entry.runtimeProfileId === runtimeProfileId
    ));
    if (entries.length === 0) return;
    this.stoppingProfiles.add(runtimeProfileId);
    for (const [key] of entries) this.entries.delete(key);
    const stopping = (async () => {
      const failures = [];
      await Promise.all(entries.map(async ([, entry]) => {
        const hostStop = Promise.resolve().then(() => entry.host.stop());
        const [stopResult] = await Promise.allSettled([hostStop, entry.promise]);
        if (stopResult.status === "rejected") {
          if (entry.host.cleanupIncomplete || containsErrorCode(stopResult.reason, "CODEX_PROCESS_CLOSE_TIMEOUT")) {
            this.blockedProfiles.add(runtimeProfileId);
          }
          failures.push(stopResult.reason);
        }
      }));
      if (failures.length > 0) {
        const aggregate = new AggregateError(failures, "Codex runtime profile stop failed");
        aggregate.code = "CODEX_RUNTIME_STOP_FAILED";
        throw aggregate;
      }
    })().finally(() => {
      this.stopPromises.delete(runtimeProfileId);
      this.stoppingProfiles.delete(runtimeProfileId);
    });
    this.stopPromises.set(runtimeProfileId, stopping);
    return stopping;
  }

  stopAll() {
    if (this.stopAllPromise) return this.stopAllPromise;
    this.closing = true;
    const entries = [...this.entries.entries()];
    this.entries.clear();
    this.stopAllPromise = (async () => {
      const errors = [];
      await Promise.all(entries.map(async ([, entry]) => {
          const { runtimeProfileId } = entry;
          this.stoppingProfiles.add(runtimeProfileId);
          const hostStop = Promise.resolve().then(() => entry.host.stop());
          const [stopResult] = await Promise.allSettled([hostStop, entry.promise]);
          if (stopResult.status === "rejected") {
            if (entry.host.cleanupIncomplete || containsErrorCode(stopResult.reason, "CODEX_PROCESS_CLOSE_TIMEOUT")) {
              this.blockedProfiles.add(runtimeProfileId);
            }
            errors.push(stopResult.reason);
          }
          this.stoppingProfiles.delete(runtimeProfileId);
      }));
      const inFlightStops = await Promise.allSettled([...this.stopPromises.values()]);
      for (const result of inFlightStops) if (result.status === "rejected") errors.push(result.reason);
      try { await this.options.nativeAuth?.close(); } catch (error) { errors.push(error); }
      if (errors.length > 0) {
        const aggregate = new AggregateError(errors, "Codex runtime pool stop failed");
        aggregate.code = "CODEX_RUNTIME_POOL_STOP_FAILED";
        throw aggregate;
      }
    })().finally(() => {
      this.closing = false;
      this.stopAllPromise = null;
    });
    return this.stopAllPromise;
  }
}

module.exports = { CodexRuntimePool };
