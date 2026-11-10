"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const {
  assertRuntimeAdapter,
  runtimeBinding,
  validRuntime,
} = require("./runtime-adapter");
const { serviceError } = require("./security");
const { isRuntimeAvailable } = require("../runtime-availability");

function registryError(code, message) {
  return serviceError(code, message);
}

class RuntimeAdapterRegistry {
  #adapters = new Map();
  #idle = new Map();
  #stops = new Map();
  #closing = false;
  #facades = new WeakMap();
  #hosts = new Set();
  #retired = 0;
  #activity = new AsyncLocalStorage();
  #warm = new Map();
  #seenHosts = new WeakSet();

  constructor(options = {}) {
    this.validateHandles = options.validateHandles !== false;
    this.onProtocolViolation = options.onProtocolViolation || (() => {});
    this.onCapabilityDifference = options.onCapabilityDifference || (() => {});
    this.isIdle = options.isIdle;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 0;
    this.now = options.now || Date.now;
    this.warmTimeoutMs = options.warmTimeoutMs ?? 15 * 60_000;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.onIdleError = options.onIdleError || (() => {});
    if (this.isIdle !== undefined && (typeof this.isIdle !== "function"
      || !Number.isSafeInteger(this.idleTimeoutMs) || this.idleTimeoutMs < 0)) {
      throw registryError("RUNTIME_IDLE_POLICY_INVALID", "Runtime idle policy is invalid");
    }
    assertRuntimeAdapter(this);
  }

  register(runtime, adapter) {
    if (!validRuntime(runtime)) {
      throw registryError("RUNTIME_REGISTRY_INVALID", "Runtime registry id is invalid");
    }
    if (this.#adapters.has(runtime)) {
      throw registryError(
        "RUNTIME_ADAPTER_ALREADY_REGISTERED",
        `Runtime adapter is already registered: ${runtime}`,
      );
    }
    assertRuntimeAdapter(adapter);
    this.#adapters.set(runtime, adapter);
  }

  async acquire(value, options = {}) {
    return (await this.acquireObserved(value, options)).handle;
  }

  async acquireObserved(value, options = {}) {
    const binding = runtimeBinding(value);
    const adapter = this.#adapter(binding.runtime);
    const raw = await (!this.isIdle ? adapter.acquire(binding, options) : this.#acquireManaged(binding, options, adapter));
    const objectHost = raw !== null && ["object", "function"].includes(typeof raw);
    const hostState = objectHost ? this.#seenHosts.has(raw) ? "reused" : "created" : "unknown";
    if (objectHost) this.#seenHosts.add(raw);
    if (!this.validateHandles) return { handle: raw, hostState };
    if (!this.#facades.has(raw)) {
      const facade = require("./runtime-handle-v1").runtimeHandleV1(raw, binding, {
        onViolation: this.onProtocolViolation, onCapabilityDifference: this.onCapabilityDifference });
      this.#facades.set(raw, facade); this.#hosts.add(facade);
      facade.terminated.finally(() => { if (this.#hosts.delete(facade)) this.#retired++; }).catch(() => {});
    }
    return { handle: this.#facades.get(raw), hostState };
  }

  // Read only: never acquire a transport or wait for a pending startup. The
  // returned facade must still belong to this exact binding and policy, and its
  // trusted adapter must confirm the executable/account identity is current.
  peek(value, { permissionPolicy, workspace } = {}) {
    const binding = runtimeBinding(value);
    if (this.#closing || !isRuntimeAvailable(binding.runtime) || !this.#adapters.has(binding.runtime)
      || this.#stops.has(this.#key(binding))) return null;
    const matches = [];
    for (const handle of this.#hosts) {
      if (["runtime", "runtimeProfileId", "runtimeAccountId"].some(key => handle[key] !== binding[key])
        || workspace !== undefined && handle.workspace !== workspace) continue;
      const policy = handle.capabilityEvidence?.scope.permissionPolicy;
      if (permissionPolicy && (!policy || ["sandbox", "approvalPolicy"].some(key => policy[key] !== permissionPolicy[key]))) continue;
      try {
        handle.assertExecutionProviderCurrent();
        handle.host?.assertRuntimeIdentityCurrent?.();
      } catch { continue; }
      matches.push(handle);
    }
    // A settings read cannot guess which workspace host owns a session fact.
    return matches.length === 1 ? matches[0] : null;
  }

  statistics() { return { hosts: this.#hosts.size, retiredHosts: this.#retired, adapters: this.#adapters.size }; }

  keepWarm(value) {
    const binding = runtimeBinding(value);
    if (binding.runtime !== "codex" || this.#closing || this.idleTimeoutMs === 0) return;
    const key = this.#key(binding);
    this.#warm.delete(key); this.#warm.set(key, this.now() + this.warmTimeoutMs);
    while (this.#warm.size > 2) {
      const evicted = this.#warm.keys().next().value;
      this.#warm.delete(evicted);
      const entry = this.#idle.get(evicted); if (entry) this.#schedule(evicted, entry);
    }
    const entry = this.#idle.get(key); if (entry) this.#schedule(key, entry);
  }

  runtimeIdentityKey(value) {
    const binding = runtimeBinding(value);
    return this.#adapter(binding.runtime).runtimeIdentityKey?.(binding) ?? null;
  }

  // A Service request leases only the bindings it actually acquires. Keep the
  // lease until the operation settles, even if its IPC caller disconnects.
  async withActivity(operation) {
    const scope = { active: true, entries: new Set() };
    return this.#activity.run(scope, async () => {
      try { return await operation(); } finally {
        scope.active = false;
        for (const entry of scope.entries) {
          entry.requests.delete(scope);
          this.#schedule(this.#key(entry.binding), entry);
        }
        scope.entries.clear();
      }
    });
  }

  isBindingActive(value) {
    const entry = this.#idle.get(this.#key(runtimeBinding(value)));
    return !!entry && (entry.pending > 0 || entry.requests.size > 0);
  }

  isBindingActiveExceptCurrent(value) {
    const entry = this.#idle.get(this.#key(runtimeBinding(value)));
    const current = this.#activity.getStore();
    return !!entry && (entry.pending > 1 || [...entry.requests].some(scope => scope !== current));
  }

  canGenerateModelOnly(runtime, { purpose = null } = {}) {
    const adapter = this.#adapters.get(runtime);
    // A purpose-specific proof must not silently enable other model-only
    // consumers, such as conversation compaction or memory extraction.
    return isRuntimeAvailable(runtime) && adapter?.modelOnly === true
      && (!adapter.modelOnlyPurposes || adapter.modelOnlyPurposes.includes(purpose));
  }

  // A native session id that the runtime can never continue (for example one
  // created by a retired transport). Callers move the conversation to a fresh session.
  isRetiredSessionId(runtime, sessionId) {
    const adapter = this.#adapters.get(runtime);
    return typeof adapter?.isRetiredSessionId === "function" && adapter.isRetiredSessionId(sessionId) === true;
  }

  stop(value) {
    const binding = runtimeBinding(value);
    const adapter = this.#adapter(binding.runtime);
    if (!this.isIdle) return adapter.stop(binding);
    const key = this.#key(binding);
    this.#forget(key);
    if (this.#stops.has(key)) return this.#stops.get(key);
    // Publish the retirement before calling the adapter. A simultaneous new
    // request waits for cleanup, then acquires a fresh host and resumes from disk.
    const stopping = Promise.resolve().then(() => adapter.stop(binding)).finally(() => {
      if (this.#stops.get(key) === stopping) this.#stops.delete(key);
    });
    this.#stops.set(key, stopping);
    return stopping;
  }

  async stopAll() {
    this.#closing = true;
    for (const key of this.#idle.keys()) this.#forget(key);
    const retiring = await Promise.allSettled([...this.#stops.values()]);
    const entries = [...this.#adapters.entries()];
    const results = await Promise.allSettled(entries.map(([, adapter]) => (
      Promise.resolve().then(() => adapter.stopAll())
    )));
    const failures = results.flatMap((result, index) => (
      result.status === "rejected"
        ? [{ runtime: entries[index][0], error: result.reason }]
        : []
    ));
    this.#closing = false;
    // Preserve retirement failures even if a later adapter stop is a no-op.
    for (const result of retiring) {
      if (result.status === "rejected") failures.push({ runtime: "idle", error: result.reason });
    }
    if (failures.length === 0) return;
    const aggregate = new AggregateError(
      failures.map((failure) => failure.error),
      "Runtime adapter registry stop failed",
    );
    aggregate.code = "RUNTIME_ADAPTER_REGISTRY_STOP_FAILED";
    aggregate.failures = Object.freeze(failures.map((failure) => Object.freeze(failure)));
    throw aggregate;
  }

  #key(binding) {
    // Adapter.stop retires every workspace host belonging to this profile.
    return JSON.stringify([binding.runtime, binding.runtimeProfileId]);
  }

  async #acquireManaged(binding, options, adapter) {
    const key = this.#key(binding);
    while (this.#stops.has(key)) await this.#stops.get(key);
    if (this.#closing) throw registryError("RUNTIME_REGISTRY_STOPPING", "Runtime registry is stopping");
    let entry = this.#idle.get(key);
    if (!entry) {
      entry = { binding, pending: 0, requests: new Set(), timer: null };
      this.#idle.set(key, entry);
    }
    const scope = this.#activity.getStore();
    if (scope?.active) {
      scope.entries.add(entry);
      entry.requests.add(scope);
    }
    this.clearTimer(entry.timer);
    entry.pending += 1;
    try {
      return await adapter.acquire(binding, options);
    } finally {
      entry.pending -= 1;
      this.#schedule(key, entry);
    }
  }

  #schedule(key, entry) {
    if (this.idleTimeoutMs === 0 || this.#closing || this.#idle.get(key) !== entry) return;
    this.clearTimer(entry.timer);
    entry.timer = this.setTimer(() => {
      if (this.#idle.get(key) !== entry || this.#closing) return;
      // The service checks runs, approvals, login/account mutations and requests.
      // Unknown/broken activity information must retain the runtime.
      let idle = false;
      try { idle = entry.pending === 0 && entry.requests.size === 0 && this.isIdle(entry.binding) === true; } catch {}
      if (!idle) { this.#schedule(key, entry); return; }
      void this.stop(entry.binding).catch((error) => this.onIdleError(error));
    }, Math.max(this.idleTimeoutMs, (this.#warm.get(key) || 0) - this.now()));
    entry.timer?.unref?.();
  }

  #forget(key) {
    this.#warm.delete(key);
    const entry = this.#idle.get(key);
    if (entry) this.clearTimer(entry.timer);
    this.#idle.delete(key);
  }

  #adapter(runtime) {
    if (!isRuntimeAvailable(runtime)) {
      throw registryError("RUNTIME_UNSUPPORTED", "Runtime is unavailable in this release");
    }
    const adapter = this.#adapters.get(runtime);
    if (!adapter) {
      throw registryError("RUNTIME_UNSUPPORTED", `Runtime adapter is not registered: ${runtime}`);
    }
    return adapter;
  }
}

module.exports = { RuntimeAdapterRegistry };
