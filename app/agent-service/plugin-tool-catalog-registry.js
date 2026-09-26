"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");
const { buildPluginToolCatalog } = require("./plugin-tool-contract");

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function fail() {
  throw serviceError("TOOL_CONTRACT_CHANGED", "MCP 工具目录尚未确认或已变化");
}

// Service-owned in-memory view of one authenticated Connection's tools/list.
// Refresh invalidates the old view before its first await, so pending tickets
// cannot cross a discovery/reconnect boundary even when the new list is equal.
class PluginToolCatalogRegistry {
  #slots = new Map();

  async refresh({ installation, connection, client } = {}) {
    const installationId = installation?.installationId;
    const releaseDigest = installation?.activeReleaseDigest ?? installation?.releaseDigest;
    const connectionId = connection?.connectionId;
    const componentId = connection?.componentId;
    if (!ID.test(installationId) || !HASH.test(releaseDigest)
      || !ID.test(connectionId) || !HASH.test(componentId)
      || connection.installationId !== installationId
      || connection.state !== "ready" || !connection.principalIdentity
      || !Number.isSafeInteger(connection.authRevision)
      || connection.authRevision < 1 || typeof client?.listTools !== "function") fail();

    const marker = { phase: "refreshing" };
    this.#slots.set(connectionId, marker);
    try {
      const catalog = buildPluginToolCatalog({ installationId, componentId,
        connectionId, tools: await client.listTools() });
      if (this.#slots.get(connectionId) !== marker) fail();
      const catalogRevision = crypto.randomUUID();
      const entries = Object.freeze(catalog.entries.map((entry) => Object.freeze({
        ...entry, catalogRevision,
      })));
      this.#slots.set(connectionId, {
        phase: "ready", installationId, releaseDigest, componentId,
        connectionId, principalIdentity: connection.principalIdentity,
        authRevision: connection.authRevision, endpointIdentity: connection.endpointIdentity,
        catalogRevision,
        entries: new Map(entries.map((entry) => [entry.toolIdentity, entry])),
      });
      return Object.freeze({ catalogRevision, generationDigest: catalog.generationDigest,
        entries });
    } catch (error) {
      if (this.#slots.get(connectionId) === marker) this.#slots.delete(connectionId);
      throw error;
    }
  }

  #currentSlot({ installation, binding, connection } = {}) {
    const slot = this.#slots.get(connection?.connectionId);
    if (slot?.phase !== "ready"
      || slot.installationId !== installation?.installationId
      || slot.releaseDigest !== installation?.activeReleaseDigest
      || slot.componentId !== binding?.componentId
      || slot.componentId !== connection?.componentId
      || slot.connectionId !== binding?.connectionId
      || slot.principalIdentity !== connection?.principalIdentity
      || slot.authRevision !== connection?.authRevision
      || slot.endpointIdentity !== connection?.endpointIdentity
      || connection?.state !== "ready") return null;
    return slot;
  }

  resolve({ installation, binding, connection, toolIdentity } = {}) {
    return this.#currentSlot({ installation, binding, connection })
      ?.entries.get(toolIdentity) ?? null;
  }

  listForBinding({ installation, binding, connection } = {}) {
    const slot = this.#currentSlot({ installation, binding, connection });
    if (!slot) return null;
    return Object.freeze({ catalogRevision: slot.catalogRevision,
      entries: Object.freeze([...slot.entries.values()]) });
  }

  invalidate(connectionId) {
    if (!ID.test(connectionId)) fail();
    this.#slots.delete(connectionId);
  }

  clear() { this.#slots.clear(); }
}

module.exports = { PluginToolCatalogRegistry };
