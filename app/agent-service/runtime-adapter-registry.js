"use strict";

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

  constructor(options = {}) {
    this.isIdle = options.isIdle;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.onIdleError = options.onIdleError || (() => {});
    if (this.isIdle !== undefined && (typeof this.isIdle !== "function"
      || !Number.isSafeInteger(this.idleTimeoutMs) || this.idleTimeoutMs < 1)) {
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

  acquire(value, options = {}) {
    const binding = runtimeBinding(value);
    const adapter = this.#adapter(binding.runtime);
    if (!this.isIdle) return adapter.acquire(binding, options);
    return this.#acquireManaged(binding, options, adapter);
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
      entry = { binding, pending: 0, timer: null };
      this.#idle.set(key, entry);
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
    if (this.#closing || this.#idle.get(key) !== entry) return;
    this.clearTimer(entry.timer);
    entry.timer = this.setTimer(() => {
      if (this.#idle.get(key) !== entry || this.#closing) return;
      // The service checks runs, approvals, login/account mutations and requests.
      // Unknown/broken activity information must retain the runtime.
      let idle = false;
      try { idle = entry.pending === 0 && this.isIdle(entry.binding) === true; } catch {}
      if (!idle) { this.#schedule(key, entry); return; }
      void this.stop(entry.binding).catch((error) => this.onIdleError(error));
    }, this.idleTimeoutMs);
    entry.timer?.unref?.();
  }

  #forget(key) {
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
