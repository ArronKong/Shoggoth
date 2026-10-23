"use strict";

const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { lstatIfExists } = require("./security");
const { validateNativeMemoryConfigProjection, nativeMemoryConfigError } = require("./native-memory-config-protocol");

// Core's config.json is authoritative. This is only its authenticated last
// applied projection; it neither selects nor starts a memory owner.
class NativeMemoryConfig {
  constructor({ paths }) {
    this.paths = paths; this.file = path.join(paths.stateDir, "native-memory-config.json");
    this.value = { revision: 0, config: {} }; this.initialized = false; this.uncertain = false;
  }
  open() {
    try {
      if (recoverInterruptedPrivateFile(this.file, { trustedRoot: this.paths.trustedRoot }) === "uncertain") {
        throw nativeMemoryConfigError("NATIVE_MEMORY_CONFIG_UNCERTAIN");
      }
      const present = Boolean(lstatIfExists(this.file));
      this.value = present
        ? validateNativeMemoryConfigProjection(JSON.parse(readPrivateFile(this.file, { maxBytes: 64 * 1024 }).toString("utf8")))
        : { revision: 0, config: {} };
      this.initialized = present; this.uncertain = false;
    } catch (error) {
      this.uncertain = true;
      throw nativeMemoryConfigError(error?.code === "NATIVE_MEMORY_CONFIG_UNCERTAIN"
        ? error.code : "NATIVE_MEMORY_CONFIG_INVALID");
    }
  }
  read() {
    if (this.uncertain) throw nativeMemoryConfigError("NATIVE_MEMORY_CONFIG_UNCERTAIN");
    return structuredClone(this.value);
  }
  apply(input) {
    this.read();
    const next = validateNativeMemoryConfigProjection(input);
    if (next.revision < this.value.revision) throw nativeMemoryConfigError("NATIVE_MEMORY_CONFIG_STALE");
    if (this.initialized && next.revision === this.value.revision) {
      if (JSON.stringify(next) !== JSON.stringify(this.value)) throw nativeMemoryConfigError("NATIVE_MEMORY_CONFIG_CONFLICT");
      return this.read();
    }
    try { atomicWritePrivateFile(this.file, `${JSON.stringify(next)}\n`, { trustedRoot: this.paths.trustedRoot }); }
    catch (error) { this.uncertain = true; throw nativeMemoryConfigError("NATIVE_MEMORY_CONFIG_UNCERTAIN"); }
    this.value = next; this.initialized = true;
    return this.read();
  }
}
module.exports = { NativeMemoryConfig };
