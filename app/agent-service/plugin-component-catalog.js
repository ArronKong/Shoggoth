"use strict";

const crypto = require("node:crypto");

function componentId(installationId, kind, localName) {
  return crypto.createHash("sha256").update(JSON.stringify([installationId, kind, localName]))
    .digest("hex");
}

class PluginComponentCatalog {
  constructor({ store } = {}) {
    if (!store || typeof store.listInstallations !== "function") {
      throw new TypeError("PluginComponentCatalog requires PluginStore");
    }
    this.store = store;
  }

  list() {
    return this.store.listInstallations().map((installation) => {
      const release = this.store.getRelease(installation.sourceIdentity, installation.releaseDigest);
      if (!release) throw new Error(`Missing release for ${installation.installationId}`);
      const skills = release.components.skills.map((skill) => ({
        componentId: componentId(installation.installationId, "skill", skill.name),
        kind: "skill", localName: skill.name, title: skill.name,
        description: skill.description, descriptorDigest: skill.descriptorDigest,
        state: "installed_inactive",
      }));
      const mcpServers = release.components.mcpServers.map((server) => ({
        componentId: componentId(installation.installationId, "mcp-server", server.name),
        kind: "mcp-server", localName: server.name, title: server.name,
        transport: server.type, descriptorDigest: server.descriptorDigest,
        state: "installed_inactive",
      }));
      return {
        ...installation,
        packageName: release.name,
        declaredVersion: release.declaredVersion,
        components: [...skills, ...mcpServers],
        diagnostics: release.diagnostics,
      };
    });
  }
}

module.exports = { PluginComponentCatalog, componentId };
