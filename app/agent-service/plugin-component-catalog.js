"use strict";

const crypto = require("node:crypto");

function componentId(installationId, kind, localName) {
  return crypto.createHash("sha256").update(JSON.stringify([installationId, kind, localName]))
    .digest("hex");
}

class PluginComponentCatalog {
  constructor({ store, toolCatalogRegistry = null, secrets = null } = {}) {
    if (!store || typeof store.listInstallations !== "function") {
      throw new TypeError("PluginComponentCatalog requires PluginStore");
    }
    this.store = store;
    this.toolCatalogRegistry = toolCatalogRegistry;
    this.secrets = secrets;
  }

  list() {
    const { createPluginAvailability } = require("./plugin-availability");
    const stateFor = createPluginAvailability(this.store, this.toolCatalogRegistry);
    return this.store.listInstallations().map((installation) => {
      const release = this.store.getRelease(installation.sourceIdentity, installation.releaseDigest);
      if (!release) throw new Error(`Missing release for ${installation.installationId}`);
      const skills = release.components.skills.map((skill) => ({
        componentId: componentId(installation.installationId, "skill", skill.name),
        kind: "skill", localName: skill.name, title: skill.name,
        description: skill.description, descriptorDigest: skill.descriptorDigest,
        state: stateFor(installation, "skill", skill.name),
      }));
      const mcpServers = release.components.mcpServers.map((server) => ({
        componentId: componentId(installation.installationId, "mcp-server", server.name),
        kind: "mcp-server", localName: server.name, title: server.name,
        transport: server.type, descriptorDigest: server.descriptorDigest,
        // A declared `${secret:NAME}` without a stored value cannot start.
        state: installation.desiredState === "enabled"
          && this.secrets?.missing(installation.installationId, installation.releaseDigest, server.name).length
          ? "secret_required" : stateFor(installation, "mcp-server", server.name),
      }));
      const hooks = (release.components.hooks || []).map(hook => ({
        componentId: componentId(installation.installationId, "hook", hook.name), kind: "hook",
        localName: hook.name, title: hook.name, event: hook.event, hookKind: hook.kind,
        descriptorDigest: hook.descriptorDigest,
        state: installation.desiredState === "enabled" ? "permission_required" : "installed_inactive",
      }));
      return {
        ...installation,
        packageName: release.name,
        declaredVersion: release.declaredVersion,
        components: [...skills, ...mcpServers, ...hooks],
        diagnostics: release.diagnostics,
      };
    });
  }
}

module.exports = { PluginComponentCatalog, componentId };
