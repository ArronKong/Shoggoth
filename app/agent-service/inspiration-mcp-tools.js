"use strict";

const { validateInspirationServiceParams, validateInspirationServiceResult } = require("./inspiration-service-protocol");

const text = (maxLength) => ({ type: "string", maxLength });
const nullableText = (maxLength) => ({ anyOf: [text(maxLength), { type: "null" }] });
const id = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" };
const publicId = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" };
const revision = { type: "integer", minimum: 1 };
const page = { cursor: nullableText(256), limit: { type: "integer", minimum: 1, maximum: 50 } };
const object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const patch = object({ body: text(16 * 1024), title: nullableText(512),
  favorite: { type: "boolean" }, archived: { type: "boolean" }, accepted: { type: "boolean" } }, []);
patch.minProperties = 1;

const DEFINITIONS = [
  ["inspiration_list", "inspiration.list", object({ query: text(1024), filter: { type: "string", enum: ["all", "saved", "active", "result", "favorite", "archived"] },
    ...page, backendId: publicId, agentId: publicId }, ["query", "filter", "cursor", "limit"])],
  ["inspiration_get", "inspiration.get", object({ id })],
  ["inspiration_create", "inspiration.create", object({ body: text(16 * 1024), paperTone: { type: "integer", minimum: 0, maximum: 7 } }, ["body"])],
  ["inspiration_update", "inspiration.update", object({ id, expectedRevision: revision, patch })],
  ["inspiration_delete", "inspiration.delete", object({ id, expectedRevision: revision })],
  ["inspiration_start", "inspiration.start", object({ id, expectedRevision: revision,
    backendId: publicId, agentId: publicId, instruction: text(16 * 1024), workspace: nullableText(4096) })],
  ["inspiration_executions", "inspiration.executions", object({ id, ...page })],
  ["inspiration_cancel", "inspiration.cancel", object({ id, runId: publicId })],
  ["inspiration_growth_get", "inspiration.growth.get", object({})],
  ["inspiration_growth_set", "inspiration.growth.set", object({ expectedRevision: revision,
    enabled: { type: "boolean" }, executors: { type: "array", maxItems: 32,
      items: object({ backendId: publicId, agentId: publicId }) } })],
];
const BY_NAME = new Map(DEFINITIONS.map(([name, method, inputSchema]) => [name, { method, inputSchema }]));
const INSPIRATION_MCP_TOOL_DEFINITIONS = DEFINITIONS.map(([name, , inputSchema]) => ({ name, inputSchema }));
const INSPIRATION_MCP_WRITE_TOOLS = Object.freeze([
  "inspiration_create", "inspiration_update", "inspiration_delete", "inspiration_start", "inspiration_cancel",
]);

function objectMatchesSchema(value, schema) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const fields = Object.getOwnPropertyDescriptors(value);
  return Object.keys(fields).every(key => Object.hasOwn(schema.properties, key) && Object.hasOwn(fields[key], "value"))
    && schema.required.every(key => Object.hasOwn(fields, key));
}

function inspirationMcpParams(name, args, operationId) {
  return INSPIRATION_MCP_WRITE_TOOLS.includes(name) ? { ...args, operationId } : { ...args };
}

function validateInspirationMcpArguments(name, args) {
  const definition = BY_NAME.get(name);
  if (!definition || !objectMatchesSchema(args, definition.inputSchema)) return false;
  if (name === "inspiration_update" && !objectMatchesSchema(args.patch, patch)) return false;
  try {
    // The confirmation must display every executor within the shared 4 KiB
    // interaction-message limit, including when only pausing dispatch.
    if (name === "inspiration_growth_set"
      && Buffer.byteLength(JSON.stringify(args.executors), "utf8") > 3 * 1024) return false;
    validateInspirationServiceParams(definition.method, inspirationMcpParams(name, args, "mcp-validation"));
    return true;
  } catch { return false; }
}

function inspirationMcpMethod(name) { return BY_NAME.get(name)?.method || null; }

function inspirationMcpResult(name, result) {
  const validated = validateInspirationServiceResult(inspirationMcpMethod(name), result);
  // Models can report a pending user interaction but cannot answer/approve it
  // through this surface. Keep the actual approval payload in the App UI.
  const execution = (value) => {
    if (!value) return value;
    const { attention, ...rest } = value;
    return { ...rest, waitingFor: value.status === "waiting_approval" ? "approval"
      : value.status === "waiting_input" ? "input" : null };
  };
  const idea = value => ({ ...value, latestExecution: execution(value.latestExecution) });
  if (validated.idea) validated.idea = idea(validated.idea);
  if (validated.items) validated.items = validated.items.map(idea);
  if (validated.executions) validated.executions = validated.executions.map(execution);
  return validated;
}

module.exports = { INSPIRATION_MCP_TOOL_DEFINITIONS, INSPIRATION_MCP_WRITE_TOOLS,
  inspirationMcpMethod, inspirationMcpParams, inspirationMcpResult, validateInspirationMcpArguments };
