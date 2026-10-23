"use strict";

const { projectNativeMemoryConfig } = require("./config-store");
const { validateNativeMemoryConfigProjection, nativeMemoryConfigError } = require("../agent-service/native-memory-config-protocol");

function createNativeMemoryConfigController({ configStore, registry }) {
  let tail = Promise.resolve();
  const enqueue = action => { const next = tail.then(action); tail = next.catch(() => {}); return next; };
  const apply = async projection => {
    const result = validateNativeMemoryConfigProjection(await registry.applyNativeMemoryConfig(projection));
    if (JSON.stringify(result) !== JSON.stringify(projection)) throw nativeMemoryConfigError("NATIVE_MEMORY_CONFIG_CONFLICT");
    return result;
  };
  return Object.freeze({
    context: () => registry.getNativeMemoryContext(),
    read: () => enqueue(() => apply(projectNativeMemoryConfig(configStore.read()))),
    update: input => enqueue(async () => {
      const before = projectNativeMemoryConfig(configStore.read());
      const next = projectNativeMemoryConfig(configStore.writeNativeMemoryConfig(input));
      try { return await apply(next); }
      catch {
        // An IPC timeout can hide a committed apply. Restore with a newer CAS
        // revision; never overwrite concurrent Core edits or claim unverified success.
        try {
          const restored = configStore.writeNativeMemoryConfig({ expectedRevision: next.revision, config: before.config });
          await apply(projectNativeMemoryConfig(restored));
        } catch { throw nativeMemoryConfigError("NATIVE_MEMORY_CONFIG_ROLLBACK_PENDING"); }
        throw nativeMemoryConfigError("NATIVE_MEMORY_CONFIG_APPLY_FAILED");
      }
    }),
  });
}
module.exports = { createNativeMemoryConfigController };
