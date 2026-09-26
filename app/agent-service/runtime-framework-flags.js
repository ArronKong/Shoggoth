"use strict";

const { serviceError } = require("./security");

// Fail-closed defaults for a Service without an authenticated Core projection.
// Product first-install defaults belong to core/config-store; saved explicit
// choices and the validated, revisioned projection remain authoritative.
const DEFAULT_RUNTIME_FRAMEWORK_FLAGS = Object.freeze({
  runtimeAdmissionV1: false,
  runtimeContextLifecycleV1: false,
  runtimeMultiBinding: false,
  runtimeConversationHandoff: false,
});
const RUNTIME_FRAMEWORK_FLAG_NAMES = Object.freeze(Object.keys(DEFAULT_RUNTIME_FRAMEWORK_FLAGS));

function resolveRuntimeFrameworkFlags(overrides = {}) {
  try {
    if (!overrides || Object.getPrototypeOf(overrides) !== Object.prototype) throw new Error();
    const flags = { ...DEFAULT_RUNTIME_FRAMEWORK_FLAGS };
    for (const key of Reflect.ownKeys(overrides)) {
      const field = Object.getOwnPropertyDescriptor(overrides, key);
      if (!RUNTIME_FRAMEWORK_FLAG_NAMES.includes(key) || !field?.enumerable
        || !Object.hasOwn(field, "value") || typeof field.value !== "boolean") throw new Error();
      flags[key] = field.value;
    }
    return Object.freeze(flags);
  } catch {
    // Never echo a value, key or accessor/proxy error from configuration.
    throw serviceError("RUNTIME_FRAMEWORK_FLAGS_INVALID", "Runtime framework flags are invalid");
  }
}

module.exports = {
  DEFAULT_RUNTIME_FRAMEWORK_FLAGS,
  RUNTIME_FRAMEWORK_FLAG_NAMES,
  resolveRuntimeFrameworkFlags,
};
