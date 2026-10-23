"use strict";

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { serviceError } = require("../security");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const isVolumeIdentity = value => typeof value === "string"
  && (/^darwin-volume:[A-F0-9-]{36}$/u.test(value) && UUID.test(value.slice(14))
    || /^device:[0-9]+$/u.test(value));

// st_dev identifies the current mount. macOS can assign a different device
// number after reboot, so persistent authority uses the filesystem's UUID.
// The cache is process-local and keyed by the live device, never a saved dev.
function createMemoryVolumeIdentityResolver(options = {}) {
  const platform = options.platform || process.platform;
  const run = options.execFileSync || execFileSync;
  const fileSystem = options.fs || fs;
  const cache = new Map();
  return target => {
    const before = fileSystem.lstatSync(target);
    if (platform !== "darwin") return `device:${before.dev}`;
    if (cache.has(before.dev)) return cache.get(before.dev);
    try {
      const commandOptions = { encoding: "utf8", timeout: 2_000, maxBuffer: 64 * 1024,
        stdio: ["pipe", "pipe", "ignore"] };
      const lines = run("/bin/df", ["-P", target], commandOptions).trim().split(/\r?\n/u);
      const device = lines.at(-1)?.trim().split(/\s+/u)[0];
      if (!/^\/dev\/disk[0-9]+(?:s[0-9]+)*$/u.test(device || "")) throw new Error("Invalid filesystem device");
      const plist = run("/usr/sbin/diskutil", ["info", "-plist", device], commandOptions);
      const uuid = run("/usr/bin/plutil", ["-extract", "VolumeUUID", "raw", "-o", "-", "-"],
        { ...commandOptions, input: plist }).trim();
      if (!UUID.test(uuid) || fileSystem.lstatSync(target).dev !== before.dev) {
        throw new Error("Filesystem identity changed");
      }
      const identity = `darwin-volume:${uuid.toUpperCase()}`;
      cache.set(before.dev, identity);
      return identity;
    } catch {
      throw serviceError("MEMORY_VOLUME_IDENTITY_UNAVAILABLE", "无法验证记忆目录所在卷的身份");
    }
  };
}

module.exports = { createMemoryVolumeIdentityResolver, isVolumeIdentity };
