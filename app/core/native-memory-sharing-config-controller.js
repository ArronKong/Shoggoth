"use strict";
const { projectNativeMemorySharingConfig } = require("./config-store");
const { validateNativeMemorySharingProjection, nativeMemorySharingError } = require("../agent-service/native-memory-sharing-protocol");
function createNativeMemorySharingConfigController({ configStore, registry }) {
  let tail = Promise.resolve();
  const enqueue = action => { const next = tail.then(action); tail = next.catch(() => {}); return next; };
  const apply = async projection => {
    const result = validateNativeMemorySharingProjection(await registry.applyNativeMemorySharingConfig(projection));
    if (JSON.stringify(result) !== JSON.stringify(projection)) throw nativeMemorySharingError("NATIVE_MEMORY_SHARING_CONFLICT");
    return result;
  };
  return Object.freeze({
    context: () => registry.getNativeMemorySharingContext(),
    read: () => enqueue(() => apply(projectNativeMemorySharingConfig(configStore.read()))),
    update: input => enqueue(async () => {
      const before = projectNativeMemorySharingConfig(configStore.read());
      const next = projectNativeMemorySharingConfig(configStore.writeNativeMemorySharingConfig(input));
      try { return await apply(next); }
      catch {
        try {
          const restored = configStore.writeNativeMemorySharingConfig({ expectedRevision: next.revision, config: before.config });
          await apply(projectNativeMemorySharingConfig(restored));
        } catch { throw nativeMemorySharingError("NATIVE_MEMORY_SHARING_ROLLBACK_PENDING"); }
        throw nativeMemorySharingError("NATIVE_MEMORY_SHARING_APPLY_FAILED");
      }
    }),
  });
}
module.exports = { createNativeMemorySharingConfigController };
