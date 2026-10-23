"use strict";

const { authorizeAdapter } = require("./external-plugin-adapter-auth");
const { GROUP_MCP_TOOL_DEFINITIONS, isGroupMcpTool, validateGroupMcpArguments } = require("./group-mcp-tools");
const { exact, id, fail } = require("../group-runtime-host-protocol");

/** Shared-capability adapters also expose group tools in managed runtimes, through their existing private credential. */
class GroupAdapterChannel {
  constructor({ paths, service, now = Date.now, authorize = authorizeAdapter }) {
    this.paths = paths; this.service = service; this.now = now; this.authorize = authorize; this.registrations = new Map(); this.closedInstances = new Set();
  }
  capability({ backendId, agentId }) {
    const registration = this.registrations.get(`${backendId}:${backendId === "openclaw" ? "*" : agentId}`);
    const groupTools = Boolean(registration && registration.expiresAt > this.now());
    return { groupTools, protocolVersion: groupTools ? registration.protocolVersion : 0,
      collaborationActions: groupTools && registration.protocolVersion >= 2 && registration.tools.includes("group_collaborate") };
  }
  available(member) { return this.capability(member).groupTools; }
  reset() { this.registrations.clear(); this.closedInstances.clear(); }
  async handle(method, params) {
    const backendId = params?.backendId;
    if (!["openclaw", "hermes"].includes(backendId) || !this.authorize(this.paths, backendId, params?.credentialToken)) fail("GROUP_HOST_AUTH_FAILED");
    if (["group.adapter.register", "group.adapter.unregister"].includes(method)) {
      const fields = ["backendId", "credentialToken", "agentId", "instanceId"];
      const inventory = method === "group.adapter.register" && Object.hasOwn(params, "protocolVersion");
      if (!exact(params, inventory ? [...fields, "protocolVersion", "tools"] : fields)
        || (inventory && (params.protocolVersion !== 2 || !Array.isArray(params.tools) || params.tools.length < 1
          || params.tools.length > GROUP_MCP_TOOL_DEFINITIONS.length || !params.tools.every(isGroupMcpTool)
          || new Set(params.tools).size !== params.tools.length))
        || !id(params.instanceId) || (backendId === "openclaw" ? params.agentId !== null : !id(params.agentId))) fail("GROUP_HOST_REQUEST_INVALID");
      if (method === "group.adapter.unregister") {
        const key = `${backendId}:${params.agentId ?? "*"}`;
        if (this.registrations.get(key)?.instanceId === params.instanceId) this.registrations.delete(key);
        if (this.closedInstances.size >= 4096) this.closedInstances.delete(this.closedInstances.values().next().value);
        this.closedInstances.add(params.instanceId); return { registered: false };
      }
      if (this.closedInstances.has(params.instanceId)) fail("GROUP_HOST_GRANT_REVOKED");
      this.registrations.set(`${backendId}:${params.agentId ?? "*"}`, { instanceId: params.instanceId, expiresAt: this.now() + 150_000,
        protocolVersion: inventory ? params.protocolVersion : 1, tools: inventory ? [...params.tools] : ["group_member_role_read", "group_messages_read", "group_task"] });
      return { registered: true };
    }
    if (method !== "group.adapter.call" || !exact(params, ["backendId", "credentialToken", "agentId", "callId", "name", "arguments"])
      || !id(params.agentId) || !id(params.callId) || !validateGroupMcpArguments(params.name, params.arguments)
      || !Object.hasOwn(params.arguments, "groupToken")) fail("GROUP_HOST_REQUEST_INVALID");
    if (params.name === "group_collaborate" && !this.capability({ backendId, agentId: params.agentId }).collaborationActions) {
      fail("GROUP_HOST_TOOL_UNSUPPORTED");
    }
    return this.service.callBoundExternalTool(params.name, params.arguments, params.callId, { backendId, agentId: params.agentId });
  }
}

module.exports = { GroupAdapterChannel };
