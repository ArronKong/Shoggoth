"use strict";

const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { lstatIfExists, serviceError } = require("./security");
const { resolveRuntimeFrameworkFlags } = require("./runtime-framework-flags");
const { validateNativeRuntimeConfigProjection } = require("./native-runtime-config-protocol");

function defaultNativeRuntimeConfig() {
  return { revision: 0, maxActive: 100, startupConcurrency: 8, flags: resolveRuntimeFrameworkFlags() };
}

// Core owns configuration. This file is only the last authenticated, applied
// projection, so headless Service restarts do not silently restore old limits.
class NativeRuntimeConfig {
  constructor({ paths, onApplied = () => {} }) {
    this.paths = paths;
    this.file = path.join(paths.stateDir, "native-runtime-config.json");
    this.value = defaultNativeRuntimeConfig();
    this.onApplied = onApplied;
    this.initialized = false;
  }

  open() {
    if (recoverInterruptedPrivateFile(this.file, { trustedRoot: this.paths.trustedRoot }) === "uncertain") {
      throw serviceError("NATIVE_RUNTIME_CONFIG_UNCERTAIN", "原生运行时配置尚未确认");
    }
    if (lstatIfExists(this.file)) {
      const value = JSON.parse(readPrivateFile(this.file, { maxBytes: 4096 }).toString("utf8"));
      validateNativeRuntimeConfigProjection(value);
      this.value = structuredClone(value);
      this.initialized = true;
    }
  }

  read() { return structuredClone(this.value); }

  apply(value) {
    validateNativeRuntimeConfigProjection(value);
    const next = structuredClone(value);
    if (next.revision < this.value.revision) {
      throw serviceError("NATIVE_RUNTIME_CONFIG_STALE", "原生运行时配置版本已变化");
    }
    if (this.initialized && next.revision === this.value.revision) {
      if (next.maxActive !== this.value.maxActive || next.startupConcurrency !== this.value.startupConcurrency
        || Object.keys(this.value.flags).some((key) => next.flags[key] !== this.value.flags[key])) {
        throw serviceError("NATIVE_RUNTIME_CONFIG_CONFLICT", "原生运行时配置版本冲突");
      }
      return this.read();
    }
    atomicWritePrivateFile(this.file, `${JSON.stringify(next)}\n`, { trustedRoot: this.paths.trustedRoot });
    this.value = next;
    this.initialized = true;
    // Observers cannot undo a durable configuration commit.
    try { Promise.resolve(this.onApplied(this.read())).catch(() => {}); } catch {}
    return this.read();
  }
}

module.exports = { NativeRuntimeConfig, defaultNativeRuntimeConfig };
