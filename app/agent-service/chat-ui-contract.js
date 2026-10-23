"use strict";

const crypto = require("node:crypto");
const { normalizeBorrowedMemoryRefs } = require("./shoggoth-memory/borrowed-memory-provenance.cjs");
const { normalizePluginSelection } = require("./plugin-chat-selection");

const VERSION = 1;
const RESOURCE_BUNDLE_ID = "native-chat-ui-v1";
const LIMITS = Object.freeze({ html: 2 * 1024 * 1024, reference: 8 * 1024,
  state: 32 * 1024, patch: 8 * 1024, schema: 12 * 1024, publication: 48 * 1024,
  chunk: 24 * 1024, actions: 6, fields: 64, depth: 6, array: 128,
  profileSoft: 128 * 1024 * 1024, profileHard: 256 * 1024 * 1024,
  freeDisk: 32 * 1024 * 1024, leases: 64, pending: 128, requestsPerSecond: 20,
  leaseMs: 30_000, retentionMs: 30 * 24 * 60 * 60 * 1000 });
const { MESSAGES } = require("./chat-ui-messages");
const METHODS = Object.freeze(["chat.ui.describe", "chat.ui.open", "chat.ui.read",
  "chat.ui.state.save", "chat.ui.renew", "chat.ui.action", "chat.ui.operation.get",
  "chat.ui.close", "chat.ui.import", "chat.ui.export"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
function uiError(code, detail) {
  const safe = Object.hasOwn(MESSAGES, code) ? code : "UI_REQUEST_INVALID";
  return Object.assign(new Error(MESSAGES[safe]), { code: safe, ...(detail || {}) });
}
function fail(code) { throw uiError(code); }
function record(value, code = "UI_REQUEST_INVALID") {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || FORBIDDEN.has(key)
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))) fail(code);
  return value;
}
function fields(value, allowed, required, code = "UI_REQUEST_INVALID") {
  record(value, code);
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail(code);
}
function id(value, code = "UI_REQUEST_INVALID") {
  if (typeof value !== "string" || !ID.test(value)) fail(code); return value;
}
function positive(value, code = "UI_REQUEST_INVALID", zero = false) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) fail(code); return value;
}
function text(value, chars, bytes, code = "UI_REQUEST_INVALID", empty = false) {
  if (typeof value !== "string" || !value.isWellFormed() || (!empty && !value.trim())
    || value.length > chars || Buffer.byteLength(value) > bytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail(code);
  return value;
}
function jsonValue(value, code = "UI_STATE_INVALID", depth = 0, seen = new Set()) {
  if (depth > LIMITS.depth) fail(code);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) fail(code); return value; }
  if (typeof value === "string") return text(value, LIMITS.state, LIMITS.state, code, true);
  if (typeof value !== "object" || seen.has(value)) fail(code);
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    if (value.length > LIMITS.array || Object.keys(value).length !== value.length) fail(code);
    result = value.map(child => jsonValue(child, code, depth + 1, seen));
  } else {
    record(value, code); if (Object.keys(value).length > LIMITS.fields) fail(code);
    result = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonValue(child, code, depth + 1, seen)]));
  }
  seen.delete(value); return result;
}
function bounded(value, max, code = "UI_CONTENT_TOO_LARGE") {
  if (Buffer.byteLength(JSON.stringify(value)) > max) fail(code); return value;
}
function sensitive(value, matcher) {
  try { require("./product-store").assertNoSensitiveFields(value, "chatUi", new Set(), matcher); }
  catch { fail("UI_SENSITIVE_CONTENT"); } return value;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value) { return crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonical(value)).digest("hex"); }

function normalizeSchema(value) {
  value = bounded(jsonValue(value, "UI_SCHEMA_INVALID"), LIMITS.schema);
  let count = 0;
  const visit = (schema, depth) => {
    record(schema, "UI_SCHEMA_INVALID"); if (depth > LIMITS.depth || ++count > 128) fail("UI_SCHEMA_INVALID");
    const common = ["type", "enum", "description"];
    const allowed = { object: ["properties", "required", "additionalProperties"],
      array: ["items", "minItems", "maxItems"], string: ["minLength", "maxLength"],
      number: ["minimum", "maximum"], integer: ["minimum", "maximum"], boolean: [], null: [] }[schema.type];
    if (!allowed) fail("UI_SCHEMA_INVALID"); fields(schema, [...common, ...allowed], ["type"], "UI_SCHEMA_INVALID");
    if (schema.description !== undefined) text(schema.description, 256, 1024, "UI_SCHEMA_INVALID", true);
    if (schema.enum !== undefined) {
      if (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 32
        || schema.enum.some(item => item !== null && !["string", "number", "boolean"].includes(typeof item))
        || new Set(schema.enum.map(canonical)).size !== schema.enum.length) fail("UI_SCHEMA_INVALID");
      for (const item of schema.enum) validateAt(item, { ...schema, enum: undefined }, "UI_SCHEMA_INVALID");
    }
    if (schema.type === "object") {
      record(schema.properties, "UI_SCHEMA_INVALID");
      if (schema.additionalProperties !== false || Object.keys(schema.properties).length > LIMITS.fields
        || Object.keys(schema.properties).some(key => !KEY.test(key) || FORBIDDEN.has(key))) fail("UI_SCHEMA_INVALID");
      const required = schema.required || [];
      if (!Array.isArray(required) || required.some(key => typeof key !== "string" || !Object.hasOwn(schema.properties, key))
        || new Set(required).size !== required.length) fail("UI_SCHEMA_INVALID");
      for (const child of Object.values(schema.properties)) visit(child, depth + 1);
    }
    if (schema.type === "array") {
      positive(schema.maxItems, "UI_SCHEMA_INVALID", true);
      if (schema.maxItems > LIMITS.array || (schema.minItems !== undefined
        && (!Number.isSafeInteger(schema.minItems) || schema.minItems < 0 || schema.minItems > schema.maxItems))) fail("UI_SCHEMA_INVALID");
      visit(schema.items, depth + 1);
    }
    for (const name of ["minimum", "maximum"]) if (schema[name] !== undefined
      && (typeof schema[name] !== "number" || !Number.isFinite(schema[name]))) fail("UI_SCHEMA_INVALID");
    if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) fail("UI_SCHEMA_INVALID");
    if (schema.type === "string") {
      for (const name of ["minLength", "maxLength"]) if (schema[name] !== undefined
        && (!Number.isSafeInteger(schema[name]) || schema[name] < 0 || schema[name] > LIMITS.state)) fail("UI_SCHEMA_INVALID");
      if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) fail("UI_SCHEMA_INVALID");
    }
  };
  visit(value, 0); if (value.type !== "object") fail("UI_SCHEMA_INVALID"); return value;
}
function validateAt(value, schema, code = "UI_STATE_INVALID") {
  if (schema.enum && !schema.enum.some(item => canonical(item) === canonical(value))) fail(code);
  if (schema.type === "null") { if (value !== null) fail(code); }
  else if (schema.type === "object") {
    record(value, code);
    if (Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))
      || (schema.required || []).some(key => !Object.hasOwn(value, key))) fail(code);
    for (const [key, child] of Object.entries(value)) validateAt(child, schema.properties[key], code);
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length > schema.maxItems || value.length < (schema.minItems || 0)) fail(code);
    for (const child of value) validateAt(child, schema.items, code);
  } else if (schema.type === "string") {
    if (typeof value !== "string" || value.length < (schema.minLength || 0)
      || value.length > (schema.maxLength ?? LIMITS.state)) fail(code);
  } else if (["number", "integer"].includes(schema.type)) {
    if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isSafeInteger(value))
      || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) fail(code);
  } else if (schema.type === "boolean") { if (typeof value !== "boolean") fail(code); }
  else fail(code);
}
function normalizeState(value, schema, matcher) {
  const state = bounded(jsonValue(value), LIMITS.state); validateAt(state, schema); return sensitive(state, matcher);
}
function normalizePatch(value, schema, matcher) {
  const patch = bounded(jsonValue(value), LIMITS.patch); record(patch, "UI_STATE_INVALID");
  for (const [key, item] of Object.entries(patch)) {
    if (!Object.hasOwn(schema.properties, key)) fail("UI_STATE_INVALID"); validateAt(item, schema.properties[key]);
  } return sensitive(patch, matcher);
}
function normalizePublication(tool, raw, matcher) {
  const base = ["sourceFile", "title", "summary", "stateSchemaVersion", "stateSchema", "initialState", "actions"];
  const update = tool === "update_ui";
  if (!update && tool !== "render_ui") fail("UI_REQUEST_INVALID");
  fields(raw, [...base, ...(update ? ["artifactId", "expectedRevision", "updateNote"] : [])],
    [...base, ...(update ? ["artifactId", "expectedRevision", "updateNote"] : [])]);
  const value = bounded(jsonValue(raw, "UI_REQUEST_INVALID"), LIMITS.publication);
  text(value.sourceFile, 4096, 8192); text(value.title, 160, 640); text(value.summary, 600, 2400, "UI_REQUEST_INVALID", true);
  if (value.stateSchemaVersion !== VERSION) fail("UI_SCHEMA_INVALID");
  value.stateSchema = normalizeSchema(value.stateSchema); value.initialState = normalizeState(value.initialState, value.stateSchema, matcher);
  if (!Array.isArray(value.actions) || value.actions.length > LIMITS.actions) fail("UI_ACTION_INVALID");
  const ids = new Set();
  for (const action of value.actions) {
    fields(action, ["actionId", "kind", "label", "instruction", "stateFields"], ["actionId", "kind", "label", "instruction", "stateFields"], "UI_ACTION_INVALID");
    id(action.actionId, "UI_ACTION_INVALID"); text(action.label, 80, 320, "UI_ACTION_INVALID"); text(action.instruction, 600, 2400, "UI_ACTION_INVALID");
    if (action.kind !== "continue_agent" || ids.has(action.actionId) || !Array.isArray(action.stateFields)
      || action.stateFields.length > LIMITS.fields || new Set(action.stateFields).size !== action.stateFields.length
      || action.stateFields.some(key => typeof key !== "string" || !Object.hasOwn(value.stateSchema.properties, key))) fail("UI_ACTION_INVALID");
    ids.add(action.actionId);
  }
  if (update) { id(value.artifactId); positive(value.expectedRevision); text(value.updateNote, 600, 2400, "UI_REQUEST_INVALID", true); }
  return sensitive(value, matcher);
}
function normalizePart(value) {
  const required = ["type", "schemaVersion", "artifactId", "revision", "sourceEventId", "segmentId", "title", "summary"];
  fields(value, required, required); if (value.type !== "ui_artifact" || value.schemaVersion !== VERSION) fail("UI_REQUEST_INVALID");
  for (const name of ["artifactId", "sourceEventId", "segmentId"]) id(value[name]); positive(value.revision);
  text(value.title, 160, 640); text(value.summary, 600, 2400, "UI_REQUEST_INVALID", true);
  return bounded(jsonValue(value, "UI_REQUEST_INVALID"), LIMITS.reference);
}
function normalizeProvenance(value) {
  record(value); const refs = normalizeBorrowedMemoryRefs(value.borrowedMemoryRefs || []);
  if (value.borrowedMemoryDerived !== undefined && value.borrowedMemoryDerived !== true) fail("UI_SCOPE_MISMATCH");
  return { origin: "assistant_generated_ui", borrowedMemoryRefs: refs,
    ...(refs.length || value.borrowedMemoryDerived ? { borrowedMemoryDerived: true } : {}) };
}
function assertDirectChatEligibility({ profileId, scope, run, session, origins, hasUser }) {
  if (!scope || typeof scope.assertCurrent !== "function") fail("UI_SCOPE_MISMATCH"); scope.assertCurrent();
  // invokeRuntimeCapability supplies a fenced Run identity, not model-selected
  // Profile/attempt fields. Its synchronous assertion checks the live lease.
  if (scope.runId !== run?.id
    || !["running", "waiting_input", "waiting_approval"].includes(run?.status)) fail("UI_SCOPE_MISMATCH");
  if (!run || run.profileId !== profileId || run.source !== "chat" || run.sourceId !== session?.sessionKey
    || /^shoggoth:chat-send:federation-(?:send|message)-/u.test(run.idempotencyKey || "")
    || session.profileId !== profileId || session.workspace !== run.workspace || session.status !== "ready"
    || hasUser !== true || !origins || ["cron", "inspiration", "proactive", "federation", "group"].some(key => origins[key] !== null)) fail("UI_DIRECT_CHAT_REQUIRED");
  return session;
}
function normalizeUiRequest(method, value) {
  const common = ["profileId", "sessionKey"];
  const byMethod = {
    "chat.ui.describe": ["artifactId", "revision", "sourceEventId"], "chat.ui.open": ["artifactId", "revision", "sourceEventId", "mountId"],
    "chat.ui.read": ["leaseId", "offset"], "chat.ui.state.save": ["leaseId", "baseStateRevision", "patch"],
    "chat.ui.action": ["leaseId", "actionRequestId", "actionId", "stateRevision", "snapshot", "hostProof", "pluginSelection"],
    "chat.ui.operation.get": ["actionRequestId", "operationId"], "chat.ui.close": ["leaseId"], "chat.ui.renew": ["leaseId"],
    "chat.ui.import": ["sourceEventId", "blockIndex"], "chat.ui.export": ["artifactId", "revision", "sourceEventId", "offset"],
  };
  if (!Object.hasOwn(byMethod, method)) fail("UI_REQUEST_INVALID");
  const optional = method === "chat.ui.action" ? ["pluginSelection"] : method === "chat.ui.operation.get" ? ["actionRequestId", "operationId"] : [];
  fields(value, [...common, ...byMethod[method]], [...common, ...byMethod[method].filter(key => !optional.includes(key))]);
  const result = bounded(jsonValue(value, "UI_REQUEST_INVALID"), LIMITS.publication);
  for (const key of [...common, "artifactId", "sourceEventId", "mountId", "leaseId", "actionRequestId", "operationId", "actionId", "hostProof"]) if (result[key] !== undefined) id(result[key]);
  for (const key of ["revision", "offset", "baseStateRevision", "stateRevision", "blockIndex"]) if (result[key] !== undefined) positive(result[key], "UI_REQUEST_INVALID", key !== "revision");
  if (method === "chat.ui.operation.get" && Number(Object.hasOwn(result, "actionRequestId")) + Number(Object.hasOwn(result, "operationId")) !== 1) fail("UI_REQUEST_INVALID");
  if (result.patch !== undefined) bounded(record(result.patch), LIMITS.patch);
  if (result.snapshot !== undefined) bounded(record(result.snapshot), LIMITS.state);
  if (result.pluginSelection !== undefined) result.pluginSelection = normalizePluginSelection(result.pluginSelection);
  return result;
}
module.exports = { VERSION, RESOURCE_BUNDLE_ID, LIMITS, MESSAGES, METHODS, uiError, record,
  fields, id, positive, text, jsonValue, bounded, canonical, hash, sensitive, normalizeSchema,
  normalizeState, normalizePatch, normalizePublication, normalizePart, normalizeProvenance,
  assertDirectChatEligibility, normalizeUiRequest };
