"use strict";

const kind = { type: "string", enum: ["IDENTITY", "SOUL", "AGENTS"] };
const text = (maxLength, minLength = 0) => ({ type: "string", minLength, maxLength });
const integer = (minimum, maximum) => ({ type: "integer", minimum, ...(maximum === undefined ? {} : { maximum }) });
const source = { source: { type: "string", enum: ["chat", "inspiration"] }, sourceId: text(512, 1) };
const object = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
const DEFINITION_MCP_TOOL_DEFINITIONS = [
  { name: "agent_definition_read", inputSchema: object({ ...source, kind, revision: integer(1),
    offset: integer(0, 32768), limit: integer(1, 4096) }, ["source", "sourceId", "kind"]) },
  { name: "agent_definition_update", inputSchema: object({ ...source, kind, expectedRevision: integer(1),
    oldText: text(32 * 1024), newText: text(32 * 1024), sourceQuote: text(2048, 1), newName: text(128, 1) },
  ["source", "sourceId", "kind", "expectedRevision", "oldText", "newText", "sourceQuote"]) },
];

function isDefinitionMcpTool(name) { return DEFINITION_MCP_TOOL_DEFINITIONS.some((tool) => tool.name === name); }
function validateDefinitionMcpArguments(name, args) {
  const schema = DEFINITION_MCP_TOOL_DEFINITIONS.find((tool) => tool.name === name)?.inputSchema;
  if (!schema || !args || typeof args !== "object" || Array.isArray(args)
    || Object.getPrototypeOf(args) !== Object.prototype) return false;
  const fields = Object.getOwnPropertyDescriptors(args);
  if (!schema.required.every((key) => Object.hasOwn(fields, key))
    || !Reflect.ownKeys(fields).every((key) => {
      if (typeof key !== "string" || !Object.hasOwn(schema.properties, key)
        || !Object.hasOwn(fields[key], "value")) return false;
      const value = fields[key].value;
      const rule = schema.properties[key];
      if (rule.type === "integer") return Number.isSafeInteger(value)
        && value >= rule.minimum && value <= (rule.maximum ?? Number.MAX_SAFE_INTEGER);
      return typeof value === "string" && value.isWellFormed() && !value.includes("\0")
        && (!rule.minLength || value.trim().length > 0)
        && Buffer.byteLength(value, "utf8") <= (rule.maxLength ?? Infinity)
        && (!rule.enum || rule.enum.includes(value));
    })) return false;
  return (!Object.hasOwn(args, "newName") || args.kind === "IDENTITY")
    && Buffer.byteLength(JSON.stringify(args), "utf8") <= 48 * 1024;
}

module.exports = { DEFINITION_MCP_TOOL_DEFINITIONS, isDefinitionMcpTool, validateDefinitionMcpArguments };
