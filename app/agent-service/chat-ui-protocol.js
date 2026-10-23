"use strict";
const c = require("./chat-ui-contract");
const METHODS = Object.freeze([...c.METHODS, "chat.ui.config.read", "chat.ui.config.apply"]);
function validateChatUiConfig(value) {
  c.fields(value, ["revision", "config"], ["revision", "config"]); c.positive(value.revision, "UI_REQUEST_INVALID", true);
  c.fields(value.config, ["nativeChatUiV1"], ["nativeChatUiV1"]);
  if (typeof value.config.nativeChatUiV1 !== "boolean") throw c.uiError("UI_REQUEST_INVALID");
  return { revision: value.revision, config: { nativeChatUiV1: value.config.nativeChatUiV1 } };
}
function validateParams(method, value) {
  if (method === "chat.ui.config.read") { c.fields(value, [], []); return {}; }
  if (method === "chat.ui.config.apply") return validateChatUiConfig(value);
  return c.normalizeUiRequest(method, value);
}
function validateDescriptor(value) {
  const fields = ["enabled", "part", "actions", "stateSchemaVersion", "bridgeApiVersion", "rendererPolicyVersion",
    "resourceBundleId", "legacy", "htmlHash", "htmlBytes", "headRevision", "readOnly", "readOnlyReason"];
  c.fields(value, fields, fields); c.normalizePart(value.part);
  if (typeof value.enabled !== "boolean" || typeof value.legacy !== "boolean" || typeof value.readOnly !== "boolean"
    || !Array.isArray(value.actions) || value.actions.length > c.LIMITS.actions
    || value.stateSchemaVersion !== 1 || value.bridgeApiVersion !== 1 || value.rendererPolicyVersion !== 1
    || value.resourceBundleId !== c.RESOURCE_BUNDLE_ID || !/^[a-f0-9]{64}$/u.test(value.htmlHash)
    || value.htmlBytes > c.LIMITS.html || (value.readOnlyReason !== null && !Object.hasOwn(c.MESSAGES, value.readOnlyReason))) throw c.uiError("UI_REQUEST_INVALID");
  c.positive(value.htmlBytes); c.positive(value.headRevision);
  const ids = new Set();
  for (const action of value.actions) {
    c.fields(action, ["actionId", "kind", "label", "instruction", "stateFields"], ["actionId", "kind", "label", "instruction", "stateFields"]);
    c.id(action.actionId); c.text(action.label, 80, 320); c.text(action.instruction, 600, 2400);
    if (action.kind !== "continue_agent" || ids.has(action.actionId) || !Array.isArray(action.stateFields)
      || action.stateFields.length > 64 || action.stateFields.some(key => typeof key !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key))
      || new Set(action.stateFields).size !== action.stateFields.length) throw c.uiError("UI_REQUEST_INVALID"); ids.add(action.actionId);
  }
  return value;
}
function validateResult(method, input) {
  if (method.startsWith("chat.ui.config.")) return validateChatUiConfig(input);
  const value = c.bounded(c.jsonValue(input, "UI_REQUEST_INVALID"), 48 * 1024);
  if (method === "chat.ui.describe") validateDescriptor(value);
  else if (["chat.ui.read", "chat.ui.export"].includes(method)) {
    const keys = ["encoding", "data", "offset", "nextOffset", "done", "htmlHash", "htmlBytes"];
    c.fields(value, keys, keys);
    if (value.encoding !== "base64" || typeof value.data !== "string"
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.data)
      || Buffer.byteLength(value.data, "base64") > c.LIMITS.chunk || typeof value.done !== "boolean"
      || !/^[a-f0-9]{64}$/u.test(value.htmlHash)) throw c.uiError("UI_REQUEST_INVALID");
    c.positive(value.offset, "UI_REQUEST_INVALID", true); c.positive(value.nextOffset, "UI_REQUEST_INVALID", true); c.positive(value.htmlBytes);
    if (value.htmlBytes > c.LIMITS.html || value.nextOffset < value.offset || value.nextOffset > value.htmlBytes
      || value.nextOffset - value.offset !== Buffer.byteLength(value.data, "base64") || value.done !== (value.nextOffset === value.htmlBytes)) throw c.uiError("UI_REQUEST_INVALID");
  } else if (["chat.ui.open", "chat.ui.renew"].includes(method)) {
    const keys = ["leaseId", "expiresAt", "state", "stateRevision", "readOnly", "readOnlyReason", ...(method === "chat.ui.open" ? ["part"] : [])];
    c.fields(value, keys, keys); c.id(value.leaseId); c.positive(value.expiresAt); c.record(value.state);
    c.bounded(value.state, c.LIMITS.state); c.positive(value.stateRevision, "UI_REQUEST_INVALID", true);
    if (typeof value.readOnly !== "boolean" || (value.readOnlyReason !== null && !Object.hasOwn(c.MESSAGES, value.readOnlyReason))) throw c.uiError("UI_REQUEST_INVALID");
    if (method === "chat.ui.open") c.normalizePart(value.part);
  } else if (method === "chat.ui.state.save") {
    c.fields(value, ["state", "stateRevision"], ["state", "stateRevision"]); c.record(value.state); c.bounded(value.state, c.LIMITS.state);
    c.positive(value.stateRevision, "UI_REQUEST_INVALID", true);
  } else if (method === "chat.ui.close") {
    c.fields(value, ["closed"], ["closed"]); if (value.closed !== true) throw c.uiError("UI_REQUEST_INVALID");
  } else if (method === "chat.ui.import") {
    c.fields(value, ["publicationId", "status", "part"], ["publicationId", "status", "part"]);
    c.id(value.publicationId); c.normalizePart(value.part); if (value.status !== "ready") throw c.uiError("UI_REQUEST_INVALID");
  } else if (["chat.ui.action", "chat.ui.operation.get"].includes(method)) {
    const { validateUiOperationResult } = require("./chat-ui-operation-protocol");
    return validateUiOperationResult(method, value);
  } else throw c.uiError("UI_REQUEST_INVALID");
  return value;
}
module.exports = { METHODS, MESSAGES: c.MESSAGES, validateChatUiConfig, validateParams, validateResult, validateDescriptor };
