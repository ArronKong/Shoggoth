"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");

const HANDLE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_SELECTIONS = 8;
const TTL_MS = 10 * 60 * 1000;

function selectionError(code) {
  const error = new Error("插件文件选择已失效，请重新选择");
  error.code = code;
  return error;
}

class PluginInstallSelection {
  #entries = new Map();
  #now;

  constructor({ now = Date.now } = {}) {
    if (typeof now !== "function") throw new TypeError("selection clock required");
    this.#now = now;
  }

  #prune() {
    const now = this.#now();
    for (const [handle, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(handle);
    }
    return now;
  }

  create(source, preview) {
    const now = this.#prune();
    let remote = false;
    if (source?.kind === "remote-git") {
      try {
        const url = new URL(source.repositoryUrl);
        remote = Object.keys(source).length === 4 && typeof source.repositoryUrl === "string"
          && source.repositoryUrl.length <= 2048 && url.protocol === "https:"
          && !url.username && !url.password && !url.search && !url.hash
          && typeof source.commit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(source.commit)
          && (source.subdir === null || (typeof source.subdir === "string" && source.subdir.length <= 512));
      } catch { /* Invalid source falls through to rejection. */ }
    }
    const bundled = source?.kind === "bundled" && Object.keys(source).length === 2
      && typeof source.packageId === "string"
      && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(source.packageId);
    if (!Number.isSafeInteger(now) || now < 0
      || (!remote && !bundled && (!["directory", "legacy-directory"].includes(source?.kind) || typeof source.path !== "string"
      || !path.isAbsolute(source.path) || !source.path.isWellFormed()
      || Buffer.byteLength(source.path, "utf8") > 4096))
      || typeof preview?.previewDigest !== "string"
      || !DIGEST.test(preview.previewDigest)
      || !Number.isSafeInteger(preview.expectedRevision)
      || preview.expectedRevision < 0
      || (source.kind === "legacy-directory" && (!["claude-plugin", "codex-plugin"].includes(source.format)
        || !Array.isArray(source.components) || source.components.length < 1 || source.components.length > 2
        || new Set(source.components).size !== source.components.length
        || source.components.some(item => !["skills", "mcp-servers"].includes(item))))) {
      throw selectionError("PLUGIN_SELECTION_INVALID");
    }
    // A canceled preview has no browser round trip to release its handle.
    // Keep the cache bounded while allowing the user to choose again.
    if (this.#entries.size >= MAX_SELECTIONS) {
      this.#entries.delete(this.#entries.keys().next().value);
    }
    const handle = randomUUID();
    this.#entries.set(handle, { source: remote || bundled ? Object.freeze({ ...source }) : Object.freeze({ kind: source.kind,
      path: source.path, ...(source.kind === "legacy-directory" ? { format: source.format,
        components: Object.freeze([...source.components]) } : {}) }), previewDigest: preview.previewDigest,
      expectedRevision: preview.expectedRevision, expiresAt: now + TTL_MS });
    return handle;
  }

  claim(handle, previewDigest, expectedRevision) {
    const now = this.#prune();
    if (typeof handle !== "string" || !HANDLE.test(handle)
      || typeof previewDigest !== "string" || !DIGEST.test(previewDigest)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw selectionError("PLUGIN_SELECTION_INVALID");
    }
    const entry = this.#entries.get(handle);
    if (!entry || entry.expiresAt <= now
      || entry.previewDigest !== previewDigest
      || entry.expectedRevision !== expectedRevision) {
      throw selectionError("PLUGIN_SELECTION_INVALID");
    }
    // Consume before crossing the async Service boundary. An unknown install
    // outcome is reconciled by operationId, never by reusing a picker handle.
    this.#entries.delete(handle);
    return entry.source;
  }
}

module.exports = { PluginInstallSelection };
