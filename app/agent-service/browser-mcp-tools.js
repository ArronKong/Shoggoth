"use strict";

const source = {
  source: { type: "string", enum: ["chat", "kanban", "cron", "inspiration"] },
  sourceId: { type: "string", minLength: 1, maxLength: 512 },
};
const session = { ...source, sessionId: { type: "string", minLength: 1, maxLength: 128 } };
const definition = (name, properties, required = Object.keys(properties)) => ({ name,
  inputSchema: { type: "object", properties, required, additionalProperties: false } });
const BROWSER_MCP_TOOL_DEFINITIONS = Object.freeze([
  definition("browser_status", {}),
  definition("browser_session_open", source),
  definition("browser_session_close", session),
  definition("browser_session_wait_for_user", { ...session,
    instructions: { type: "string", minLength: 1, maxLength: 512 },
  }),
  definition("browser_tool_list", session),
  definition("browser_tool_call", { ...session,
    toolName: { type: "string", pattern: "^browser_[a-z_]+$", maxLength: 128 },
    arguments: { type: "object", maxProperties: 64 },
  }),
]);
const BROWSER_MCP_TOOL_NAMES = new Set(BROWSER_MCP_TOOL_DEFINITIONS.map(tool => tool.name));

function validateBrowserMcpArguments(name, args) {
  const tool = BROWSER_MCP_TOOL_DEFINITIONS.find(value => value.name === name);
  if (!tool || !args || Object.getPrototypeOf(args) !== Object.prototype
    || Object.keys(args).length !== tool.inputSchema.required.length
    || Object.keys(args).some(key => !tool.inputSchema.required.includes(key))) return false;
  if (name === "browser_status") return true;
  if (!source.source.enum.includes(args.source) || typeof args.sourceId !== "string"
    || !args.sourceId || args.sourceId.length > 512 || !args.sourceId.isWellFormed() || args.sourceId.includes("\0")) return false;
  if (name === "browser_session_open") return true;
  if (typeof args.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(args.sessionId)) return false;
  if (name === "browser_session_wait_for_user") return typeof args.instructions === "string"
    && args.instructions.trim().length > 0 && args.instructions.length <= 512
    && args.instructions.isWellFormed() && !args.instructions.includes("\0");
  if (name !== "browser_tool_call") return true;
  return typeof args.toolName === "string" && /^browser_[a-z_]{1,120}$/u.test(args.toolName)
    && args.arguments && Object.getPrototypeOf(args.arguments) === Object.prototype
    && Object.keys(args.arguments).length <= 64;
}

module.exports = { BROWSER_MCP_TOOL_DEFINITIONS, BROWSER_MCP_TOOL_NAMES, validateBrowserMcpArguments };
