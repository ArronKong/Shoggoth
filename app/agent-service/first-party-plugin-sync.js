"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { serviceError } = require("./security");

const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const MAX_PACKAGES = 64;
const MAX_ATTEMPTS = 3;
const operationKey = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 48);

function firstPartyPluginRoot({ packaged = false, resourcesPath = process.resourcesPath } = {}) {
  return packaged ? path.join(resourcesPath, "shoggoth-plugins")
    : path.join(__dirname, "../../resources/shoggoth-plugins");
}

// Display metadata only; installation validates the whole package.
function readManifest(target) {
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.size > 64 * 1024) return null;
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { return fs.readFileSync(fd, "utf8"); } finally { fs.closeSync(fd); }
}

function manifestOf(directory) {
  for (const file of [".codex-plugin/plugin.json", "plugin.json"]) {
    const target = path.join(directory, file);
    if (!fs.existsSync(target)) continue;
    try {
      const value = JSON.parse(readManifest(target));
      return { name: typeof value.name === "string" ? value.name.slice(0, 128) : path.basename(directory),
        version: typeof value.version === "string" ? value.version.slice(0, 64) : null,
        description: typeof value.description === "string" ? value.description.slice(0, 1024) : "" };
    } catch { return null; }
  }
  return null;
}

// First-party plugins ship inside the signed App under shoggoth-plugins/<id>/.
// Each one is installed and enabled on first start, updated when a new App
// version changes it (an enabled one is drained first and then enabled
// again), and never reinstalled after the user uninstalls it. Operation IDs
// derive from the package and its target contents, so an interrupted update
// resumes on the next start instead of leaving the plugin disabled.
class FirstPartyPluginSync {
  constructor({ root, installer, store, setInstallationState }) {
    if (typeof root !== "string" || typeof installer?.installFirstParty !== "function"
      || typeof store?.getBySource !== "function" || typeof setInstallationState !== "function") {
      throw new TypeError("FirstPartyPluginSync requires the plugin installer and store");
    }
    Object.assign(this, { root, installer, store, setInstallationState });
  }

  packageIds() {
    let entries;
    try { entries = fs.readdirSync(this.root, { withFileTypes: true }); }
    catch (error) { if (error?.code === "ENOENT") return []; throw error; }
    return entries.filter(entry => entry.isDirectory() && PACKAGE_ID.test(entry.name))
      .map(entry => entry.name).sort().slice(0, MAX_PACKAGES);
  }

  // Read-only state for the Plugins page; no package conversion runs here.
  list() {
    return { items: this.packageIds().flatMap(packageId => {
      const manifest = manifestOf(path.join(this.root, packageId));
      if (!manifest) return [];
      const installation = this.store.getBySource(`first-party:${packageId}`);
      return [{ packageId, ...manifest, installationId: installation?.installationId ?? null,
        installationState: !installation ? "not-installed" : installation.desiredState }];
    }) };
  }

  async sync() {
    const report = { installed: [], updated: [], unchanged: [], skipped: [], failed: [] };
    for (const packageId of this.packageIds()) {
      try {
        const { kind, ...entry } = await this.#syncOne(packageId);
        report[kind].push({ packageId, ...entry });
      } catch (error) {
        report.failed.push({ packageId, code: typeof error?.code === "string" ? error.code : "PLUGIN_SERVICE_FAILED" });
      }
    }
    return report;
  }

  // The user's explicit reinstall of an uninstalled (or never installed)
  // first-party plugin. The caller has obtained native confirmation.
  install(packageId) {
    if (!this.packageIds().includes(packageId)) throw serviceError("FIRST_PARTY_PLUGIN_NOT_FOUND", "Shoggoth 内置插件不存在");
    const preview = this.installer.previewFirstParty(packageId);
    if (!preview.installable) throw serviceError("PACKAGE_INVALID", "内置插件内容无效");
    const current = this.store.getBySource(`first-party:${packageId}`);
    if (current && current.desiredState !== "uninstalled") return current;
    return this.installer.installFirstParty({ packageId, previewDigest: preview.contentDigest,
      expectedRevision: current?.revision || 0, activateOnInstall: true,
      operationId: `first-party-reinstall-${operationKey([packageId, preview.contentDigest, current?.revision || 0])}` });
  }

  async #syncOne(packageId) {
    const sourceIdentity = `first-party:${packageId}`;
    const preview = this.installer.previewFirstParty(packageId);
    if (!preview.installable) {
      return { kind: "skipped", reason: "PACKAGE_INVALID",
        diagnostics: preview.diagnostics.map(item => item.reasonCode).slice(0, 16) };
    }
    const digest = preview.contentDigest;
    // A step that failed (for example on a full disk) gets a fresh ID on a
    // later start; a pending or completed one is resumed or replayed as is.
    const variants = step => Array.from({ length: MAX_ATTEMPTS }, (_, attempt) =>
      `first-party-${step}-${operationKey([packageId, digest])}${attempt ? `-${attempt}` : ""}`);
    const done = step => variants(step).some(id => this.store.getOperation(id)?.phase === "completed");
    const next = step => {
      const id = variants(step).find(candidate => this.store.getOperation(candidate)?.phase !== "failed");
      if (!id) throw serviceError("PLUGIN_OPERATION_FAILED", "内置插件多次安装失败");
      return id;
    };
    const current = this.store.getBySource(sourceIdentity);
    if (!current) {
      const installed = this.installer.installFirstParty({ packageId, previewDigest: digest,
        expectedRevision: 0, operationId: next("install"), activateOnInstall: true });
      return { kind: "installed", installationId: installed.installationId };
    }
    if (current.desiredState === "uninstalled") return { kind: "skipped", reason: "USER_UNINSTALLED" };
    const drained = done("disable");
    const enable = revision => this.setInstallationState({ installationId: current.installationId,
      desiredState: "enabled", expectedRevision: revision, operationId: next("enable") });
    if (current.releaseDigest === digest) {
      // Resume an update that stopped after its install step.
      if (drained && current.desiredState === "disabled" && !done("enable")) {
        await enable(current.revision);
        return { kind: "updated", installationId: current.installationId };
      }
      return { kind: "unchanged" };
    }
    // Contents equal to an earlier release would be a rollback; leave that to
    // the explicit rollback flow.
    if (this.store.getRelease(sourceIdentity, digest)) return { kind: "skipped", reason: "PLUGIN_ROLLBACK_REQUIRES_PREVIEW" };
    const reenable = current.desiredState === "enabled" || drained;
    let revision = current.revision;
    if (current.desiredState === "enabled") {
      const { installation } = await this.setInstallationState({ installationId: current.installationId,
        desiredState: "disabled", expectedRevision: current.revision, operationId: next("disable") });
      if (installation?.desiredState !== "disabled") throw serviceError("ACTIVATION_DEFERRED", "内置插件仍在排空");
      revision = installation.revision;
    }
    const updated = this.installer.installFirstParty({ packageId, previewDigest: digest,
      expectedRevision: revision, operationId: next("update"), activateOnInstall: false });
    if (reenable) await enable(updated.revision);
    return { kind: "updated", installationId: current.installationId };
  }
}

module.exports = { FirstPartyPluginSync, firstPartyPluginRoot };
