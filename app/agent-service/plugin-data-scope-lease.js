"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");

const HASH = /^[a-f0-9]{64}$/u;
const INSTALLATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
// The Service owns one process-local registry. Its existing single-instance lock
// is required before this manager can protect a live user data root.
const activeWriters = new Map();

class PluginDataScopeLeaseManager {
  constructor({ paths } = {}) {
    if (!paths?.trustedRoot || !paths?.pluginDataDir
      || !path.isAbsolute(paths.trustedRoot) || !path.isAbsolute(paths.pluginDataDir)) {
      throw new TypeError("PluginDataScopeLeaseManager requires Service plugin paths");
    }
    this.paths = paths;
  }

  acquire({ installationId, scopeId } = {}) {
    if (!INSTALLATION_ID.test(installationId) || !HASH.test(scopeId)) {
      throw serviceError("PLUGIN_DATA_SCOPE_INVALID", "插件数据 scope 身份无效");
    }
    const scopedPath = path.join(this.paths.pluginDataDir, installationId, scopeId);
    ensurePrivateDirectoryTree(this.paths.pluginDataDir, this.paths.trustedRoot);
    ensurePrivateDirectoryTree(scopedPath, this.paths.trustedRoot);
    const directory = fs.realpathSync(scopedPath);
    if (activeWriters.has(directory)) {
      throw serviceError("PLUGIN_DATA_WRITER_ACTIVE", "同一插件数据 scope 已有 writer");
    }
    const owner = Symbol("plugin data writer");
    activeWriters.set(directory, owner);
    let released = false;
    return Object.freeze({
      directory,
      release() {
        if (released) return;
        released = true;
        if (activeWriters.get(directory) === owner) activeWriters.delete(directory);
      },
    });
  }
}

module.exports = { PluginDataScopeLeaseManager };
