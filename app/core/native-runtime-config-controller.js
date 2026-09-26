"use strict";

const { projectNativeRuntimeConfig } = require("./config-store");
const { validateNativeRuntimeConfigProjection, validateNativeCapacitySnapshot,
  NATIVE_RUNTIME_CONFIG_PUBLIC_MESSAGES } = require("../agent-service/native-runtime-config-protocol");

function configError(code) {
  return Object.assign(new Error(NATIVE_RUNTIME_CONFIG_PUBLIC_MESSAGES[code]), { code });
}

function createNativeRuntimeConfigController({ configStore, registry }) {
  let tail = Promise.resolve();
  const enqueue = (task) => {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };
  const apply = async (projection) => {
    const applied = validateNativeRuntimeConfigProjection(await registry.applyNativeRuntimeConfig(projection));
    if (JSON.stringify(applied) !== JSON.stringify(projection)) throw configError("NATIVE_RUNTIME_CONFIG_CONFLICT");
  };
  const capacityFor = async (projection) => {
    const capacity = validateNativeCapacitySnapshot(await registry.getNativeCapacity());
    if (capacity.revision !== projection.revision || capacity.maxActive !== projection.maxActive
      || capacity.startupConcurrency !== projection.startupConcurrency
      || capacity.enabled !== projection.flags.runtimeAdmissionV1) {
      throw configError("NATIVE_RUNTIME_CONFIG_CONFLICT");
    }
    return capacity;
  };
  return Object.freeze({
    read() {
      return enqueue(async () => {
        const projection = projectNativeRuntimeConfig(configStore.read());
        await apply(projection);
        return capacityFor(projection);
      });
    },
    update(input) {
      return enqueue(async () => {
        if (!input || Object.getPrototypeOf(input) !== Object.prototype
          || Object.keys(input).sort().join(",") !== "enabled,expectedRevision,maxActive,startupConcurrency"
          || typeof input.enabled !== "boolean") throw configError("NATIVE_RUNTIME_CONFIG_INVALID");
        const previous = projectNativeRuntimeConfig(configStore.read());
        const saved = configStore.writeNativeRuntimeConfig({
          expectedRevision: input.expectedRevision, maxActive: input.maxActive,
          startupConcurrency: input.startupConcurrency,
          flags: { ...previous.flags, runtimeAdmissionV1: input.enabled },
        });
        const projection = projectNativeRuntimeConfig(saved);
        try {
          await apply(projection);
          return await capacityFor(projection);
        } catch {
          // A timed-out apply can have committed remotely. Compensate with a
          // newer revision, never replay the old revision or overwrite another
          // writer's newer core configuration. Core remains the sole authority.
          try {
            const restored = configStore.writeNativeRuntimeConfig({
              expectedRevision: projection.revision, maxActive: previous.maxActive,
              startupConcurrency: previous.startupConcurrency, flags: previous.flags,
            });
            await apply(projectNativeRuntimeConfig(restored));
          } catch { throw configError("NATIVE_RUNTIME_CONFIG_ROLLBACK_PENDING"); }
          throw configError("NATIVE_RUNTIME_CONFIG_APPLY_FAILED");
        }
      });
    },
  });
}

module.exports = { createNativeRuntimeConfigController };
