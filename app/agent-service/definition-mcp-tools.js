"use strict";

const kind = { type: "string", enum: ["IDENTITY", "SOUL", "AGENTS"] };
const text = (maxLength, minLength = 0) => ({ type: "string", minLength, maxLength });
const integer = (minimum, maximum) => ({ type: "integer", minimum, ...(maximum === undefined ? {} : { maximum }) });
const source = { source: { type: "string", enum: ["chat", "inspiration", "proactive"], description: "Copy currentWorkSource from the trusted current work source in your instructions." },
  sourceId: { ...text(512, 1), description: "Copy currentWorkSourceId from the same trusted current work source. It is not the Run ID." } };
const heartbeatRevision = { type: "string", pattern: "^[a-f0-9]{64}$" };
const memoryKind = { type: "string", enum: ["USER", "MEMORY"] };
const object = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
const managedSource = {
  ...source, source: { ...source.source, enum: ["chat"] },
  agentId: { ...text(128, 1), pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    description: "The exact native Agent ID returned by federation_agent_list for the Agent the user named." },
  sourceQuote: { ...text(2048, 1), description: "The exact clause from the current user message that names the target and asks for this action." },
  kind: { type: "string", enum: [...kind.enum, ...memoryKind.enum, "HEARTBEAT", "DAILY_REVIEW"] },
};
const managedRequired = ["source", "sourceId", "agentId", "sourceQuote", "kind"];
const DEFINITION_MCP_TOOL_DEFINITIONS = [
  { name: "agent_definition_read", inputSchema: object({ ...source, kind, revision: integer(1),
    offset: integer(0, 32768), limit: integer(1, 4096) }, ["source", "sourceId", "kind"]) },
  { name: "agent_definition_update", inputSchema: object({ ...source, kind, expectedRevision: integer(1),
    oldText: text(32 * 1024), newText: text(32 * 1024), sourceQuote: text(2048, 1),
    newName: { ...text(128, 1), description: "Required when changing the Name in IDENTITY. Set this to the same name as the updated '- Name: ...' line to rename the Profile in this call." } },
  ["source", "sourceId", "kind", "expectedRevision", "oldText", "newText", "sourceQuote"]) },
  // HEARTBEAT.md lives in the proactive store, whose revision is a content hash.
  { name: "heartbeat_rules_read", inputSchema: object({ ...source, offset: integer(0, 16384), limit: integer(1, 4096) },
    ["source", "sourceId"]) },
  { name: "heartbeat_rules_update", inputSchema: object({ ...source, expectedRevision: heartbeatRevision,
    oldText: text(16 * 1024), newText: text(16 * 1024), sourceQuote: text(2048, 1) },
  ["source", "sourceId", "expectedRevision", "oldText", "newText", "sourceQuote"]) },
  // USER.md and MEMORY.md are the file memory source; revision is a content hash.
  { name: "memory_file_read", inputSchema: object({ ...source, kind: memoryKind, offset: integer(0, 1024 * 1024),
    limit: integer(1, 4096) }, ["source", "sourceId", "kind"]) },
  { name: "memory_file_update", inputSchema: object({ ...source, kind: memoryKind, expectedRevision: heartbeatRevision,
    oldText: text(32 * 1024), newText: text(32 * 1024), sourceQuote: text(2048, 1) },
  ["source", "sourceId", "kind", "expectedRevision", "oldText", "newText", "sourceQuote"]) },
  { name: "native_agent_file_read", inputSchema: object({ ...managedSource,
    offset: integer(0, 1024 * 1024), limit: integer(1, 4096) }, managedRequired) },
  { name: "native_agent_file_update", inputSchema: object({ ...managedSource,
    expectedRevision: { type: "string", pattern: "^(?:[1-9][0-9]{0,15}|[a-f0-9]{64})$",
      description: "Copy the revision string from native_agent_file_read for this target and file." },
    oldText: text(32 * 1024), newText: text(32 * 1024), newName: text(128, 1) },
  [...managedRequired, "expectedRevision", "oldText", "newText"]) },
];

function isDefinitionMcpTool(name) { return DEFINITION_MCP_TOOL_DEFINITIONS.some((tool) => tool.name === name); }
function isManagedDefinitionMcpTool(name) { return name === "native_agent_file_read" || name === "native_agent_file_update"; }
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
        && (!rule.enum || rule.enum.includes(value))
        && (!rule.pattern || new RegExp(rule.pattern, "u").test(value));
    })) return false;
  if (name === "native_agent_file_update") {
    const revision = args.expectedRevision;
    if (kind.enum.includes(args.kind)
      ? !Number.isSafeInteger(Number(revision)) || String(Number(revision)) !== revision
      : !/^[a-f0-9]{64}$/u.test(revision)) return false;
  }
  return (!Object.hasOwn(args, "newName") || args.kind === "IDENTITY")
    && Buffer.byteLength(JSON.stringify(args), "utf8") <= 48 * 1024;
}

module.exports = { DEFINITION_MCP_TOOL_DEFINITIONS, isDefinitionMcpTool, isManagedDefinitionMcpTool, validateDefinitionMcpArguments };
