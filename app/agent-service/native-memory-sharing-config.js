"use strict";
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { lstatIfExists } = require("./security");
const { validateNativeMemorySharingProjection, validateNativeMemorySharingResult, nativeMemorySharingError } = require("./native-memory-sharing-protocol");
const disabled = () => ({ revision: 0, config: { enabled: false, excludedProfiles: [] } });
// Core remains authoritative; this file is the last authenticated projection.
// A persisted enabled policy cannot bypass the trusted implementation gate.
class NativeMemorySharingConfig {
  constructor({ paths, featureReady = false }) {
    if (typeof featureReady !== "boolean") throw new TypeError("featureReady must be boolean");
    this.paths = paths; this.file = path.join(paths.stateDir, "native-memory-sharing-config.json");
    this.featureReady = featureReady; this.value = disabled(); this.initialized = false; this.uncertain = false;
  }
  open() {
    try {
      if (recoverInterruptedPrivateFile(this.file, { trustedRoot: this.paths.trustedRoot }) === "uncertain") {
        throw nativeMemorySharingError("NATIVE_MEMORY_SHARING_UNCERTAIN");
      }
      const present = Boolean(lstatIfExists(this.file));
      this.value = present ? validateNativeMemorySharingProjection(JSON.parse(readPrivateFile(this.file,
        { maxBytes: 64 * 1024 }).toString("utf8"))) : disabled();
      this.initialized = present; this.uncertain = false;
    } catch (error) {
      this.uncertain = true;
      throw nativeMemorySharingError(error?.code === "NATIVE_MEMORY_SHARING_UNCERTAIN" ? error.code : "NATIVE_MEMORY_SHARING_INVALID");
    }
  }
  read() {
    if (this.uncertain) throw nativeMemorySharingError("NATIVE_MEMORY_SHARING_UNCERTAIN");
    return structuredClone(this.value);
  }
  projection() { return this.read(); }
  apply(input) {
    this.read(); const next = validateNativeMemorySharingProjection(input);
    if (next.revision < this.value.revision) throw nativeMemorySharingError("NATIVE_MEMORY_SHARING_STALE");
    if (this.initialized && next.revision === this.value.revision) {
      if (JSON.stringify(next) !== JSON.stringify(this.value)) throw nativeMemorySharingError("NATIVE_MEMORY_SHARING_CONFLICT");
      return this.read();
    }
    try { atomicWritePrivateFile(this.file, `${JSON.stringify(next)}\n`, { trustedRoot: this.paths.trustedRoot }); }
    catch { this.uncertain = true; throw nativeMemorySharingError("NATIVE_MEMORY_SHARING_UNCERTAIN"); }
    this.value = next; this.initialized = true; return this.read();
  }
  participants(profiles) {
    const config = this.read().config, excluded = new Set(config.excludedProfiles);
    return profiles.filter(profile => profile.enabled === true && profile.backendId === "shoggoth"
      && !excluded.has(profile.id));
  }
  resolve(requesterProfileId, profiles) {
    const projection = this.read();
    const participants = this.participants(profiles);
    const enabled = this.initialized && this.featureReady && projection.config.enabled
      && participants.some(profile => profile.id === requesterProfileId);
    return Object.freeze({ revision: projection.revision, enabled,
      participatingProfileIds: Object.freeze(enabled ? participants.map(profile => profile.id).sort() : []) });
  }
  context(profiles, owner = "shoggoth-memory-core") {
    const projection = this.read(), included = new Set(this.participants(profiles).map(profile => profile.id));
    return validateNativeMemorySharingResult("memory.sharing.config.context", {
      owner, featureReady: this.featureReady, effectiveEnabled: this.initialized && this.featureReady
        && projection.config.enabled && owner === "shoggoth-memory-core", revision: projection.revision,
      agents: profiles.filter(profile => profile.enabled === true && profile.backendId === "shoggoth")
        .map(profile => ({ profileId: profile.id, agentId: profile.agentId, name: profile.name, participating: included.has(profile.id) })),
    });
  }
}
module.exports = { NativeMemorySharingConfig };
