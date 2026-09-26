"use strict";

// This module is also loaded by runtime MCP helpers; keep it free of stores.
const text = (maxLength) => ({ type: "string", minLength: 1, maxLength });
const id = { ...text(256), pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$" };
const revision = { type: "integer", minimum: 0 };
const source = { source: { type: "string", enum: ["chat", "inspiration"] }, sourceId: text(512) };
const object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const DEFINITIONS = [
  ["memory_search", object({ ...source, query: { type: "string", maxLength: 1024 },
    includeCandidates: { type: "boolean" } }, ["source", "sourceId", "query"])],
  ["memory_save", object({ ...source, expectedRevision: revision, content: text(2048),
    scope: { type: "string", enum: ["user", "agent", "project", "workspace"] },
    classification: { type: "string", enum: ["explicit"] },
    sensitivity: { type: "string", enum: ["normal", "private"] },
    sourceQuote: text(2048), supersedes: nullable(id),
    validUntil: nullable({ type: "integer", minimum: 0 }) },
  ["source", "sourceId", "expectedRevision", "content", "scope", "classification", "sourceQuote"])],
  ["memory_forget", object({ ...source, id, expectedRevision: revision, sourceQuote: text(2048) })],
];
const BY_NAME = new Map(DEFINITIONS);
const MEMORY_MCP_TOOL_DEFINITIONS = DEFINITIONS.map(([name, inputSchema]) => ({ name, inputSchema }));
const MEMORY_MCP_WRITE_TOOLS = ["memory_save", "memory_forget"];

function matches(value, schema) {
  if (schema.anyOf) return schema.anyOf.some((item) => matches(value, item));
  if (schema.type === "null") return value === null;
  if (schema.type === "string") return typeof value === "string" && value.isWellFormed()
    && !value.includes("\0") && value.length >= (schema.minLength || 0)
    && (!schema.minLength || value.trim().length > 0)
    && Buffer.byteLength(value, "utf8") <= (schema.maxLength ?? Infinity)
    && (!schema.enum || schema.enum.includes(value))
    && (!schema.pattern || new RegExp(schema.pattern, "u").test(value));
  if (schema.type === "integer") return Number.isSafeInteger(value) && value >= schema.minimum;
  if (schema.type === "boolean") return typeof value === "boolean";
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const fields = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(fields).every((key) => typeof key === "string"
    && Object.hasOwn(schema.properties, key) && Object.hasOwn(fields[key], "value")
    && matches(fields[key].value, schema.properties[key]))
    && schema.required.every((key) => Object.hasOwn(fields, key));
}
function isMemoryMcpTool(name) { return BY_NAME.has(name); }
function validateMemoryMcpArguments(name, args) {
  const schema = BY_NAME.get(name);
  return Boolean(schema && matches(args, schema)
    && (name !== "memory_save" || args.classification !== "explicit" || args.sourceQuote?.trim()));
}

module.exports = { MEMORY_MCP_TOOL_DEFINITIONS, MEMORY_MCP_WRITE_TOOLS,
  isMemoryMcpTool, validateMemoryMcpArguments };
