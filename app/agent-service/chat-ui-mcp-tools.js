"use strict";
// Runtime discovery must not initialize ProductStore or any private data root.
const id = { type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$" };
const revision = { type: "integer", minimum: 1 };
const declaration = {
  sourceFile: { type: "string", minLength: 1, maxLength: 4096 },
  title: { type: "string", minLength: 1, maxLength: 160 },
  summary: { type: "string", maxLength: 600 },
  stateSchemaVersion: { type: "integer", enum: [1] },
  stateSchema: { type: "object" }, initialState: { type: "object" },
  actions: { type: "array", maxItems: 6, items: { type: "object", properties: {
    actionId: id, kind: { type: "string", enum: ["continue_agent"] },
    label: { type: "string", minLength: 1, maxLength: 80 },
    instruction: { type: "string", minLength: 1, maxLength: 600 },
    stateFields: { type: "array", maxItems: 64, uniqueItems: true, items: { type: "string", maxLength: 64 } },
  }, required: ["actionId", "kind", "label", "instruction", "stateFields"], additionalProperties: false } },
};
const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const definitions = [
  ["render_ui", object(declaration)],
  ["update_ui", object({ ...declaration, artifactId: id, expectedRevision: revision,
    updateNote: { type: "string", maxLength: 600 } })],
  ["get_ui_state", object({ artifactId: id, revision })],
];
const byName = new Map(definitions);
function stableJson(value, seen = new Set(), depth = 0) {
  if (depth > 32) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.isWellFormed() && !value.includes("\0");
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value) ? value.length <= 512 && Object.keys(value).length === value.length
    && value.every(item => stableJson(item, seen, depth + 1))
    : Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).every(key =>
      typeof key === "string" && !["__proto__", "prototype", "constructor"].includes(key)
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value") && stableJson(value[key], seen, depth + 1));
  seen.delete(value); return valid;
}
function matches(value, schema) {
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "string") return typeof value === "string" && value.length >= (schema.minLength || 0)
    && value.length <= (schema.maxLength ?? Infinity) && (!schema.minLength || value.trim())
    && (!schema.pattern || new RegExp(schema.pattern, "u").test(value));
  if (schema.type === "integer") return Number.isSafeInteger(value) && value >= (schema.minimum || 0);
  if (schema.type === "array") return Array.isArray(value) && value.length <= schema.maxItems
    && (!schema.uniqueItems || new Set(value).size === value.length) && value.every(item => matches(item, schema.items));
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  if (!schema.properties) return true;
  return Object.keys(value).every(key => Object.hasOwn(schema.properties, key) && matches(value[key], schema.properties[key]))
    && schema.required.every(key => Object.hasOwn(value, key));
}
const isChatUiMcpTool = name => byName.has(name);
function validateChatUiMcpArguments(name, args) {
  try { return isChatUiMcpTool(name) && stableJson(args) && matches(args, byName.get(name))
    && Buffer.byteLength(JSON.stringify(args)) <= 48 * 1024; } catch { return false; }
}
module.exports = { CHAT_UI_MCP_TOOL_DEFINITIONS: definitions.map(([name, inputSchema]) => ({ name, inputSchema })),
  CHAT_UI_MCP_WRITE_TOOLS: ["render_ui", "update_ui"], isChatUiMcpTool, validateChatUiMcpArguments };
