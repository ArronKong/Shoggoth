"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { declaredSecrets } = require("../core/plugin-secret-placeholders");

const HASH = /^[a-f0-9]{64}$/u;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_CACHE = 128;

function readJson(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return null; }
}

// Read-only view of an installed release's MCP declarations for status and
// setup summaries. Installed releases are immutable and digest-addressed, so a
// parse is cached by digest. Execution still uses the verified resolver path.
class PluginPackageDeclarations {
  #packagesDir;
  #cache = new Map();

  constructor({ packagesDir }) {
    if (typeof packagesDir !== "string" || !path.isAbsolute(packagesDir)) {
      throw new TypeError("PluginPackageDeclarations requires the plugin package root");
    }
    this.#packagesDir = packagesDir;
  }

  component(releaseDigest, name) {
    if (typeof releaseDigest !== "string" || !HASH.test(releaseDigest)
      || typeof name !== "string" || !name) return null;
    let release = this.#cache.get(releaseDigest);
    if (!release) {
      const root = path.join(this.#packagesDir, releaseDigest);
      const servers = readJson(path.join(root, "mcp.json"))?.mcpServers;
      const resources = readJson(path.join(root, "plugin.json"))?.extensions?.shoggoth?.mcpOAuthResources;
      release = { servers: servers && typeof servers === "object" && !Array.isArray(servers) ? servers : {},
        resources: resources && typeof resources === "object" && !Array.isArray(resources) ? resources : {} };
      if (this.#cache.size >= MAX_CACHE) this.#cache.clear();
      this.#cache.set(releaseDigest, release);
    }
    const spec = Object.hasOwn(release.servers, name) ? release.servers[name] : null;
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) return null;
    return Object.freeze({ spec: structuredClone(spec),
      oauthResource: typeof release.resources[name] === "string" ? release.resources[name] : null,
      secrets: declaredSecrets(spec) || [] });
  }
}

module.exports = { PluginPackageDeclarations };
