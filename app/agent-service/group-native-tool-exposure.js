"use strict";
const crypto = require("node:crypto");
const { isGroupMcpTool } = require("./group-mcp-tools");
const { serviceError } = require("./security");

// Capability observations only: an authenticated helper reports the tools/list
// pages that its current Runtime requested. This never issues a group grant.
class GroupNativeToolExposure {
  constructor({ now = Date.now } = {}) { this.now = now; this.entries = new Map(); }
  record(input, { authorize, executionRunId = null } = {}) {
    if (!input || input.protocolVersion !== 2 || typeof input.instanceId !== "string"
      || !/^[a-f0-9-]{36}$/u.test(input.instanceId) || !Array.isArray(input.tools)
      || input.tools.length > 16 || !input.tools.every(isGroupMcpTool)
      || new Set(input.tools).size !== input.tools.length || typeof authorize !== "function") {
      throw serviceError("MCP_AUTH_REQUEST_INVALID", "mcp_auth_request_invalid");
    }
    authorize();
    const key = crypto.createHash("sha256").update(`${input.sessionToken}:${input.instanceId}`).digest("hex");
    if (input.tools.length === 0) { this.entries.delete(key); return { registered: false }; }
    if (this.entries.size >= 1024 && !this.entries.has(key)) this.entries.delete(this.entries.keys().next().value);
    this.entries.set(key, { runtimeProfileId: input.runtimeProfileId, runtimeAccountId: input.runtimeAccountId,
      executionRunId, tools: new Set(input.tools), authorize, checkedAt: this.now() });
    return { registered: true };
  }
  capability({ runtimeProfileId, runtimeAccountId, runId = null }) {
    let groupTools = false, collaborationActions = false;
    for (const [key, entry] of this.entries) {
      try { entry.authorize(); } catch { this.entries.delete(key); continue; }
      if (entry.runtimeProfileId !== runtimeProfileId || entry.runtimeAccountId !== runtimeAccountId
        || runId && entry.executionRunId && entry.executionRunId !== runId) continue;
      const complete = ["group_member_role_read", "group_messages_read", "group_task"].every(name => entry.tools.has(name));
      groupTools ||= complete; collaborationActions ||= complete && entry.tools.has("group_collaborate");
    }
    return { groupTools, collaborationActions, protocolVersion: collaborationActions ? 2 : 1 };
  }
  recordInvocation({ runtimeProfileId, runtimeAccountId, runId, name }, { authorize } = {}) {
    if (!isGroupMcpTool(name) || typeof authorize !== "function" || typeof runId !== "string") return false;
    authorize();
    const key = `invocation:${runId}`;
    if (this.entries.size >= 1024 && !this.entries.has(key)) this.entries.delete(this.entries.keys().next().value);
    const previous = this.entries.get(key);
    const tools = previous?.tools ?? new Set(); tools.add(name);
    // A bound native group_collaborate call is positive evidence of the new
    // schema reaching this Run. Legacy invocations never prove the new action.
    if (name === "group_collaborate") for (const old of ["group_member_role_read", "group_messages_read", "group_task"]) tools.add(old);
    this.entries.set(key, { runtimeProfileId, runtimeAccountId, executionRunId: runId,
      tools, authorize, checkedAt: this.now() });
    return true;
  }
  clear() { this.entries.clear(); }
}
module.exports = { GroupNativeToolExposure };
