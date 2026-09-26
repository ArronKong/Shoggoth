"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { serviceError } = require("./security");

const caches = new WeakMap();
const FRESH_MS = 5 * 60 * 1000;
const MAX_STALE_MS = 30 * 60 * 1000;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

// Fingerprints stay in process memory. Never log them or return them to clients.
// Credential contents are not read; replacement, edits and permission changes
// invalidate the identity through metadata, as do relevant environment changes.
function modelCatalogIdentity({ fs, values, files = [], directories = [] }) {
  const trackedFiles = [...files];
  function visit(directory, depth) {
    if (depth > 8 || trackedFiles.length > 512) {
      throw serviceError("RUNTIME_MODEL_CATALOG_IDENTITY_UNAVAILABLE", "Model catalog configuration exceeds its limit");
    }
    trackedFiles.push(directory);
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (error) {
      if (error?.code === "ENOENT") return;
      throw serviceError("RUNTIME_MODEL_CATALOG_IDENTITY_UNAVAILABLE", "Model catalog configuration is unavailable");
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (["node_modules", ".git", ".cache"].includes(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target, depth + 1);
      else {
        if (entry.isSymbolicLink() && fs.statSync(target).isDirectory()) {
          throw serviceError("RUNTIME_MODEL_CATALOG_IDENTITY_UNAVAILABLE", "Model catalog configuration directory is linked");
        }
        trackedFiles.push(target);
      }
      if (trackedFiles.length > 512) {
        throw serviceError("RUNTIME_MODEL_CATALOG_IDENTITY_UNAVAILABLE", "Model catalog configuration exceeds its limit");
      }
    }
  }
  for (const directory of directories) visit(directory, 0);
  const metadata = trackedFiles.map((file) => {
    try {
      const stat = fs.statSync(file);
      const link = fs.lstatSync(file);
      return [file, ...[link, stat].map((item) => [
        item.dev, item.ino, item.size, item.mtimeMs, item.ctimeMs, item.mode,
      ])];
    } catch (error) {
      if (error?.code === "ENOENT") return [file, "missing"];
      throw serviceError("RUNTIME_MODEL_CATALOG_IDENTITY_UNAVAILABLE", "Model catalog identity is unavailable");
    }
  });
  return crypto.createHash("sha256").update(JSON.stringify(canonical([values, metadata]))).digest("hex");
}

class ModelCatalogCache {
  constructor() {
    this.entries = new Map();
    this.generation = 0;
  }

  invalidate() {
    this.generation += 1;
    this.entries.clear();
  }

  async read({ key, load, isCurrent = () => true, now = Date.now, allowStale = false,
    onRefreshError = null }) {
    if (!isCurrent()) throw serviceError("RUNTIME_MODEL_CATALOG_CHANGED", "Model catalog identity changed");
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { models: null, loadedAt: 0, pending: null, error: null };
      this.entries.set(key, entry);
      // An account can visit multiple configurations. Bound retained snapshots
      // without removing an in-flight request that other callers are joining.
      if (this.entries.size > 32) {
        for (const [oldKey, oldEntry] of this.entries) {
          if (oldKey !== key && !oldEntry.pending) this.entries.delete(oldKey);
          if (this.entries.size <= 32) break;
        }
      }
    }
    const age = now() - entry.loadedAt;
    if (entry.models && !entry.error && age >= 0 && age < FRESH_MS) return entry.models;
    const stale = entry.models && !entry.error && age >= 0 && age < MAX_STALE_MS
      && (typeof allowStale === "function" ? allowStale(entry.models) : allowStale === true);
    if (!entry.pending) {
      const generation = this.generation;
      const current = () => generation === this.generation && this.entries.get(key) === entry && isCurrent();
      const pending = Promise.resolve().then(() => {
        if (!current()) throw serviceError("RUNTIME_MODEL_CATALOG_CHANGED", "Model catalog identity changed before refresh");
        return load();
      }).then((models) => {
        if (!current()) throw serviceError("RUNTIME_MODEL_CATALOG_CHANGED", "Model catalog identity changed during refresh");
        entry.models = models;
        entry.loadedAt = now();
        entry.error = null;
        return models;
      }).catch((error) => {
        if (current()) {
          // A known refresh failure (especially auth) must not be hidden by an
          // older successful snapshot. The next read must validate again.
          entry.error = error;
          try { onRefreshError?.(error); } catch {}
        }
        throw error;
      }).finally(() => {
        if (entry.pending === pending) entry.pending = null;
      });
      entry.pending = pending;
      // Stale readers do not await refresh, but its rejection is still handled.
      pending.catch(() => {});
    }
    if (stale) return entry.models;
    const models = await entry.pending;
    if (!isCurrent()) throw serviceError("RUNTIME_MODEL_CATALOG_CHANGED", "Model catalog identity changed");
    return models;
  }
}

function getModelCatalogCache(profileState) {
  let cache = caches.get(profileState);
  if (!cache) {
    cache = new ModelCatalogCache();
    caches.set(profileState, cache);
  }
  return cache;
}

module.exports = { getModelCatalogCache, modelCatalogIdentity };
