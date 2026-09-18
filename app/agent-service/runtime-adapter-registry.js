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

  constructor() {
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
    return this.#adapter(binding.runtime).acquire(binding, options);
  }

  stop(value) {
    const binding = runtimeBinding(value);
    return this.#adapter(binding.runtime).stop(binding);
  }

  async stopAll() {
    const entries = [...this.#adapters.entries()];
    const results = await Promise.allSettled(entries.map(([, adapter]) => (
      Promise.resolve().then(() => adapter.stopAll())
    )));
    const failures = results.flatMap((result, index) => (
      result.status === "rejected"
        ? [{ runtime: entries[index][0], error: result.reason }]
        : []
    ));
    if (failures.length === 0) return;
    const aggregate = new AggregateError(
      failures.map((failure) => failure.error),
      "Runtime adapter registry stop failed",
    );
    aggregate.code = "RUNTIME_ADAPTER_REGISTRY_STOP_FAILED";
    aggregate.failures = Object.freeze(failures.map((failure) => Object.freeze(failure)));
    throw aggregate;
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
