"use strict";

// This module is also loaded by runtime MCP helpers; keep it free of stores.
const text = (maxLength) => ({ type: "string", minLength: 1, maxLength });
const id = { ...text(256), pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$" };
const revision = { type: "integer", minimum: 0 };
const source = { source: { type: "string", enum: ["chat", "inspiration"] }, sourceId: text(512) };
const object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const MEMORY_GET_ARGUMENT_HINT = "Use exactly one of id or path. Prefer the returned borrowed sourceRef as id, omitting path, from and lines. For a path read, copy the exact returned path; omit from and lines to use the original range, or keep both within that returned range.";
const DEFINITIONS = [
  ["memory_search", object({ ...source, query: { type: "string", maxLength: 1024 },
    maxResults: { type: "integer", minimum: 1, maximum: 20 }, minScore: { type: "number", minimum: 0, maximum: 1 },
    memoryScope: { type: "string", enum: ["own", "all"] }, ownerProfileId: id,
    includeCandidates: { type: "boolean" } }, ["source", "sourceId", "query"])],
  ["memory_get", object({ ...source,
    id: { ...id, description: "Exact active memory ID or borrowed sourceRef returned by memory_search. Omit path, from and lines when using id." },
    path: { ...text(1024), description: "Exact path returned by memory_search. Omit id. A borrowed path is an opaque reference, not a filesystem path." },
    from: { type: "integer", minimum: 1, description: "Optional start line for path reads only; omit for the original range. Cannot expand a borrowed result's returned range." },
    lines: { type: "integer", minimum: 1, maximum: 200, description: "Optional line count for path reads only; omit for the original range. Cannot expand a borrowed result's returned range." } }, ["source", "sourceId"])],
  ["memory_explain", object({ ...source, id })],
  ["conversation_search", object({ ...source, query: text(1024),
    sessionId: id, limit: { type: "integer", minimum: 1, maximum: 10 } },
  ["source", "sourceId", "query"])],
  ["conversation_get", object({ ...source, sessionId: id, eventId: id,
    window: { type: "integer", minimum: 0, maximum: 3 } },
  ["source", "sourceId", "sessionId", "eventId"])],
  ["memory_save", object({ ...source, expectedRevision: revision, content: text(2048),
    scope: { type: "string", enum: ["user", "agent", "project", "workspace"] },
    classification: { type: "string", enum: ["explicit", "observed"] },
    sensitivity: { type: "string", enum: ["normal", "private"] },
    sourceQuote: text(2048), supersedes: nullable(id),
    validUntil: nullable({ type: "integer", minimum: 0 }) },
  // sourceQuote is required for classification=explicit (checked below).
  ["source", "sourceId", "expectedRevision", "content", "scope", "classification"])],
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
  if (schema.type === "integer") return Number.isSafeInteger(value)
    && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  if (schema.type === "number") return typeof value === "number" && Number.isFinite(value)
    && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
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
    // Pending background suggestions are human-review only. Preserve callers
    // that explicitly send false, but never silently ignore a true request.
    && (name !== "memory_search" || args.includeCandidates !== true)
    && (name !== "memory_get" || Boolean(args.id) !== Boolean(args.path))
    && (name !== "memory_get" || args.path || args.from === undefined && args.lines === undefined)
    && (name !== "memory_save" || args.classification !== "explicit" || args.sourceQuote?.trim())
    // An Agent's own observation is its private note, never a fact about the user.
    && (name !== "memory_save" || args.classification !== "observed" || args.scope === "agent"));
}

module.exports = { MEMORY_MCP_TOOL_DEFINITIONS, MEMORY_MCP_WRITE_TOOLS, MEMORY_GET_ARGUMENT_HINT,
  isMemoryMcpTool, validateMemoryMcpArguments };
