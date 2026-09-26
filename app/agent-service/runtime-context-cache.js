"use strict";
const crypto = require("node:crypto");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { lstatIfExists } = require("./security");
const { validateRuntimeContextUsage } = require("./runtime-context-usage");
const hash = key => crypto.createHash("sha256").update(key).digest("hex");

// Recoverable observations, never execution authority. Persist timestamps as
// reported; opening the App must not make an old measurement look fresh.
class RuntimeContextCache {
  constructor({ paths, now = Date.now, maxAgeMs = 7 * 24 * 60 * 60_000 }) {
    this.paths = paths; this.now = now; this.maxAgeMs = maxAgeMs;
    this.file = path.join(paths.cacheDir, "runtime-context-v1.json");
    this.records = new Map(); this.loaded = false;
  }
  #load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (recoverInterruptedPrivateFile(this.file, { trustedRoot: this.paths.trustedRoot }) === "uncertain"
        || !lstatIfExists(this.file)) return;
      const data = JSON.parse(readPrivateFile(this.file, { maxBytes: 512 * 1024 }));
      if (data?.version !== 1 || !Array.isArray(data.records) || data.records.length > 512) return;
      for (const record of data.records) {
        if (!record || Object.keys(record).sort().join() !== "key,usage" || !/^[a-f0-9]{64}$/u.test(record.key)) continue;
        const usage = validateRuntimeContextUsage(record.usage);
        if (usage.observedAt <= this.now() && this.now() - usage.observedAt < this.maxAgeMs) this.records.set(record.key, usage);
      }
    } catch { this.records.clear(); }
  }
  get(key) {
    this.#load();
    const id = hash(key), value = this.records.get(id);
    if (!value || value.observedAt > this.now() || this.now() - value.observedAt >= this.maxAgeMs) {
      this.records.delete(id); return null;
    }
    return structuredClone(value);
  }
  put(key, value) {
    this.#load();
    const usage = validateRuntimeContextUsage(value), id = hash(key);
    if ((this.records.get(id)?.observedAt ?? -1) > usage.observedAt) return;
    this.records.delete(id); this.records.set(id, usage);
    while (this.records.size > 512) this.records.delete(this.records.keys().next().value);
    atomicWritePrivateFile(this.file, `${JSON.stringify({ version: 1,
      records: [...this.records].map(([recordKey, item]) => ({ key: recordKey, usage: item })) })}\n`,
    { trustedRoot: this.paths.trustedRoot });
  }
}
module.exports = { RuntimeContextCache };
