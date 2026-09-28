import crypto from "node:crypto";
import { readCredential, request } from "./transport.mjs";

const NAMES = new Set(["shoggoth_capability_search", "shoggoth_skill_read",
  "shoggoth_skill_file_read", "shoggoth_plugin_call"]);
const MAX_PENDING = 128;
const MAX_AGE_MS = 60_000;

const schemas = {
  shoggoth_capability_search: { type: "object", additionalProperties: false,
    properties: { query: { type: "string" }, cursor: { type: "integer", minimum: 0 },
      revision: { type: "string", pattern: "^[a-f0-9]{64}$" } },
    required: ["query"] },
  shoggoth_skill_read: { type: "object", additionalProperties: false,
    properties: { skillId: { type: "string" }, cursor: { type: "integer", minimum: 0 } },
    required: ["skillId"] },
  shoggoth_skill_file_read: { type: "object", additionalProperties: false,
    properties: { skillId: { type: "string" }, relativePath: { type: "string" },
      cursor: { type: "integer", minimum: 0 } },
    required: ["skillId", "relativePath"] },
  shoggoth_plugin_call: { type: "object", additionalProperties: false,
    properties: { serverId: { type: "string" }, toolName: { type: "string" },
      arguments: { type: "object" } },
    required: ["serverId", "toolName", "arguments"] },
};

// The hook receives host-owned identity; the tool handler consumes it by the
// actual tool call ID. Model arguments contain no identity or credential field.
export function createAdapter({ requestService = request, credential = readCredential,
  now = Date.now, instanceId = crypto.randomUUID() } = {}) {
  const pending = new Map();
  const keyOf = (sessionId, callId) => `${sessionId}\0${callId}`;
  const purge = () => {
    for (const [key, value] of pending) {
      if (value.createdAt + MAX_AGE_MS <= now()) pending.delete(key);
    }
  };
  return {
    beforeToolCall(event, ctx) {
      if (!NAMES.has(event?.toolName)) return;
      const runId = event.runId || ctx?.runId;
      const toolCallId = event.toolCallId;
      if (![ctx?.agentId, ctx?.sessionId, runId, toolCallId].every(value =>
        typeof value === "string" && value.length > 0 && value.length <= 256)) {
        return { block: true, blockReason: "Shoggoth requires a trusted run and tool identity." };
      }
      purge();
      if (pending.size >= MAX_PENDING) {
        return { block: true, blockReason: "Shoggoth adapter is busy." };
      }
      const key = keyOf(ctx.sessionId, toolCallId);
      if (pending.has(key)) {
        return { block: true, blockReason: "Shoggoth tool identity was already used." };
      }
      pending.set(key, { createdAt: now(), toolName: event.toolName,
        identity: { backendId: "openclaw", instanceId, agentId: ctx.agentId,
          sessionId: ctx.sessionId, runId, toolCallId } });
    },
    tool(name, context) {
      return {
        name, label: name, description: name === "shoggoth_capability_search"
          ? "Search installed and enabled Shoggoth skills and plugin tools."
          : name === "shoggoth_skill_read" ? "Read one installed Shoggoth Skill by id."
            : name === "shoggoth_skill_file_read"
              ? "Read a text file in an installed Shoggoth Skill by relative path."
            : "Call one authorized Shoggoth plugin tool by server and tool name.",
        parameters: schemas[name],
        async execute(callId, args, signal) {
          const key = keyOf(context.sessionId, callId);
          const captured = pending.get(key);
          pending.delete(key);
          if (!captured || captured.toolName !== name
            || captured.identity.agentId !== context.agentId
            || captured.createdAt + MAX_AGE_MS <= now()) {
            throw new Error("Shoggoth call has no trusted host execution identity");
          }
          const identity = captured.identity;
          const opened = await requestService("plugin.external.open", {
            credentialToken: credential(), identity }, { signal });
          const method = name === "shoggoth_capability_search" ? "plugin.external.search"
            : name === "shoggoth_skill_read" ? "plugin.external.skill.read"
              : name === "shoggoth_skill_file_read" ? "plugin.external.skill.file.read"
              : "plugin.external.call";
          const params = name === "shoggoth_capability_search"
            ? { token: opened.token, identity, query: args.query, cursor: args.cursor ?? 0,
              limit: 5, ...(args.revision ? { revision: args.revision } : {}) }
            : name === "shoggoth_skill_read"
              ? { token: opened.token, identity, skillId: args.skillId, cursor: args.cursor ?? 0 }
              : name === "shoggoth_skill_file_read"
                ? { token: opened.token, identity, skillId: args.skillId,
                  relativePath: args.relativePath, cursor: args.cursor ?? 0 }
              : { token: opened.token, identity, serverId: args.serverId,
                toolName: args.toolName, arguments: args.arguments };
          const result = await requestService(method, params, {
            signal, timeoutMs: method === "plugin.external.call" ? 120_000 : 10_000 });
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        },
      };
    },
    register(api) {
      api.on("before_tool_call", (event, ctx) => this.beforeToolCall(event, ctx));
      for (const name of NAMES) api.registerTool(context => this.tool(name, context), { name });
    },
  };
}

export default { id: "shoggoth-shared-capabilities", name: "Shoggoth Shared Capabilities",
  description: "Use installed Shoggoth capabilities through Service-issued per-call leases.",
  register(api) { createAdapter().register(api); } };
