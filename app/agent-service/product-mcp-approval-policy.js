"use strict";

const { parseMcpToolPermission } = require("../core/shoggoth-interaction-contract");

function ownDataObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

class ProductMcpApprovalPolicy {
  constructor(options = {}) {
    if (!options.toolRegistry || typeof options.toolRegistry.get !== "function"
      || typeof options.toolRegistry.revision !== "string"
      || !options.permissionEngine || typeof options.permissionEngine.profileProjection !== "function"
      || !options.productStore || typeof options.productStore.getAgentProfile !== "function") {
      throw new TypeError("Product MCP approval policy dependencies are invalid");
    }
    this.toolRegistry = options.toolRegistry;
    this.permissionEngine = options.permissionEngine;
    this.productStore = options.productStore;
    this.serverName = options.serverName || "shoggoth";
  }

  evaluate(input) {
    if (!ownDataObject(input) || input.method !== "mcpServer/elicitation/request"
      || !ownDataObject(input.params) || !ownDataObject(input.run)
      || !ownDataObject(input.executionContract)
      || input.run.id !== input.executionContract.runId
      || input.run.profileId !== input.executionContract.profileId) return null;
    const permission = parseMcpToolPermission({
      ...input.params,
      method: input.method,
      kind: "mcp_elicitation",
    });
    if (!permission || permission.serverName !== this.serverName) return null;
    const tool = this.toolRegistry.get(permission.toolName);
    if (!tool || tool.enabled !== true) return null;
    const profile = this.productStore.getAgentProfile(input.run.profileId);
    if (!profile || profile.enabled !== true || profile.id !== input.executionContract.profileId
      || profile.runtimeProfileId !== input.executionContract.runtimeProfileId) return null;
    let projection;
    try { projection = this.permissionEngine.profileProjection(profile.id); } catch { return null; }
    if (!projection || projection.registryRevision !== this.toolRegistry.revision
      || projection.registryRevision !== input.executionContract.toolRegistryRevision
      || projection.revision !== input.executionContract.toolPermissionRevision) return null;
    const permissionEntry = projection.tools.find((entry) => entry.name === permission.toolName);
    if (!permissionEntry || permissionEntry.enabled !== true || permissionEntry.effect !== "allow") return null;
    return Object.freeze({ action: "accept", content: Object.freeze({}) });
  }
}

module.exports = { ProductMcpApprovalPolicy };
