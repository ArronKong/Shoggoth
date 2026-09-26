"use strict";

const { componentId } = require("./plugin-component-catalog");

// This is a synchronous, short-lived view for management and chat admission.
// The Runtime still freezes and rechecks each exact tool contract at dispatch.
function createPluginAvailability(store, toolCatalogRegistry = null) {
  const byComponent = new Map();
  for (const binding of store.listGlobalBindings?.() || []) {
    if (binding.componentKind !== "mcp-server") continue;
    const key = `${binding.installationId}:${binding.componentId}`;
    const rows = byComponent.get(key) || [];
    rows.push(binding);
    byComponent.set(key, rows);
  }

  function hasAllowedTool(binding, connection) {
    if (!binding.enabled || connection?.state !== "ready" || !connection.principalIdentity
      || !toolCatalogRegistry) return false;
    try {
      const records = store.getCapabilityRecords(binding.bindingId, "__projection__");
      if (!records || records.binding?.revision !== binding.revision
        || records.connection?.authRevision !== connection.authRevision) return false;
      const catalog = toolCatalogRegistry.listForBinding(records);
      if (!catalog?.entries?.length || catalog.entries.length > 256) return false;
      const batch = store.getCapabilityRecordsForTools(binding.bindingId,
        catalog.entries.map(entry => entry.toolIdentity));
      if (!batch || toolCatalogRegistry.listForBinding(batch.records)?.catalogRevision
        !== catalog.catalogRevision) return false;
      return catalog.entries.some(entry => {
        if (entry.appUnsupported || (entry.ui && !entry.ui.visibility.includes("model"))) return false;
        const grant = batch.grants.get(entry.toolIdentity);
        return grant?.effect === "allow" && grant.contractDigest === entry.contractDigest
          && grant.principalIdentity === connection.principalIdentity
          && (grant.expiresAt === null || grant.expiresAt > Date.now());
      });
    } catch { return false; }
  }

  return function stateFor(installation, kind, localName) {
    if (installation.desiredState !== "enabled"
      || store.hasPendingInstallationDisable?.(installation.installationId)) return "installed_inactive";
    if (kind === "skill") return "ready";
    const id = componentId(installation.installationId, kind, localName);
    let connected = false;
    for (const binding of byComponent.get(`${installation.installationId}:${id}`) || []) {
      const connection = binding.connectionId ? store.getConnection?.(binding.connectionId) : null;
      if (connection?.state !== "ready") continue;
      connected = true;
      if (hasAllowedTool(binding, connection)) return "ready";
    }
    if (!connected && store.getConnectionCountsForComponent?.(installation.installationId, id)?.verified) {
      connected = true;
    }
    return connected ? "permission_required" : "connection_required";
  };
}

module.exports = { createPluginAvailability };
