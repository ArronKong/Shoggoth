"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function scanPackage(root) {
  const files = [];
  const walk = (directory, prefix = "") => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (name === ".DS_Store") throw new Error("Bundled plugin contains an unexpected file");
      const relative = prefix ? `${prefix}/${name}` : name;
      const target = path.join(directory, name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
        throw new Error(`Unsafe bundled plugin entry: ${relative}`);
      }
      if (stat.isDirectory()) walk(target, relative);
      else files.push({ path: relative, bytes: stat.size, sha256: hash(fs.readFileSync(target)),
        executable: (stat.mode & 0o111) !== 0 });
    }
  };
  walk(root);
  return files;
}

class BundledPluginCatalog {
  constructor(root) {
    this.root = path.resolve(root);
    const rootStat = fs.lstatSync(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Bundled plugin root invalid");
    const catalogPath = path.join(this.root, "catalog.json");
    if (!fs.lstatSync(catalogPath).isFile()) throw new Error("Bundled plugin catalog invalid");
    const source = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    if (![3, 4].includes(source.version) || !HASH.test(source.batchDigest)
      || !Array.isArray(source.packages) || source.packages.length > 62) {
      throw new Error("Bundled plugin catalog version or size invalid");
    }
    this.entries = new Map();
    for (const item of source.packages) {
      if (!ID.test(item.id) || this.entries.has(item.id) || !HASH.test(item.sourceDigest)
        || !["previewable", "needs-adapter"].includes(item.importStatus)
        || !item.converted || Object.keys(item.converted).sort().join(",") !== "mcp,skills"
        || !Number.isSafeInteger(item.converted.skills) || item.converted.skills < 0
        || !Number.isSafeInteger(item.converted.mcp) || item.converted.mcp < 0
        || item.converted.skills > item.components?.skills
        || item.converted.mcp > item.components?.mcp
        || !Array.isArray(item.unconvertedMcp)
        || item.converted.mcp + item.unconvertedMcp.length !== item.components?.mcp
        || item.unconvertedMcp.some(issue => !issue || typeof issue.name !== "string"
          || issue.name.length < 1 || issue.name.length > 128
          || !["LEGACY_MCP_FIELD_UNSUPPORTED", "LEGACY_MCP_ENTRY_INVALID"].includes(issue.reasonCode))
        || (item.importStatus === "previewable") !== (item.converted.skills + item.converted.mcp > 0)
        || typeof item.displayName !== "string" || item.displayName.length > 128
        || typeof item.shortDescription !== "string" || item.shortDescription.length > 1024
        || typeof item.category !== "string" || item.category.length > 128) {
        throw new Error("Bundled plugin catalog item invalid");
      }
      const packagePath = path.join(this.root, "packages", item.id);
      const stat = fs.lstatSync(packagePath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Bundled plugin package invalid");
      if (item.icon !== null) {
        const icon = item.icon;
        if (!icon || !HASH.test(icon.sha256) || !Number.isSafeInteger(icon.bytes)
          || icon.bytes < 0 || icon.bytes > 256 * 1024
          || !["image/svg+xml", "image/png", "image/webp", "image/jpeg"].includes(icon.mimeType)
          || typeof icon.path !== "string" || icon.path.split("/").some(part => !part || part === "." || part === "..")) {
          throw new Error("Bundled plugin icon invalid");
        }
      }
      this.entries.set(item.id, Object.freeze(item));
    }
    this.batchDigest = source.batchDigest;
  }

  get(id) {
    if (typeof id !== "string" || !ID.test(id)) return null;
    return this.entries.get(id) || null;
  }

  list() {
    return { batchDigest: this.batchDigest, items: [...this.entries.values()].map(item => ({
      id: item.id, installationId: hash(`bundled:${item.id}`),
      displayName: item.displayName, shortDescription: item.shortDescription,
      category: item.category, version: item.version, iconAvailable: item.icon !== null,
      components: item.components, converted: item.converted,
      unconvertedMcp: item.unconvertedMcp,
      importStatus: item.importStatus,
    })) };
  }

  packagePath(id) {
    const item = this.get(id);
    if (!item) throw Object.assign(new Error("Unknown bundled plugin"), { code: "BUNDLED_PLUGIN_NOT_FOUND" });
    return path.join(this.root, "packages", item.id);
  }

  assertCurrent(id) {
    const item = this.get(id);
    if (!item) throw Object.assign(new Error("Unknown bundled plugin"), { code: "BUNDLED_PLUGIN_NOT_FOUND" });
    const files = scanPackage(this.packagePath(id));
    if (files.length !== item.fileCount
      || files.reduce((sum, file) => sum + file.bytes, 0) !== item.bytes
      || hash(JSON.stringify(files)) !== item.sourceDigest) {
      throw Object.assign(new Error("Bundled plugin resources changed"), { code: "PACKAGE_CHANGED" });
    }
    return item;
  }

  readIcon(id) {
    const item = this.get(id);
    if (!item?.icon) return null;
    const target = path.join(this.packagePath(id), item.icon.path);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.size !== item.icon.bytes) throw new Error("Bundled plugin icon changed");
    const bytes = fs.readFileSync(target);
    if (hash(bytes) !== item.icon.sha256) throw new Error("Bundled plugin icon changed");
    return { mimeType: item.icon.mimeType, bytes };
  }
}

function bundledRoot({ packaged = false, resourcesPath = process.resourcesPath } = {}) {
  return packaged ? path.join(resourcesPath, "bundled-plugins")
    : path.join(__dirname, "../../resources/bundled-plugins");
}

module.exports = { BundledPluginCatalog, bundledRoot };
