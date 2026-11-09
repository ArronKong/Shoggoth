"use strict";

// The reference is a name, never a bearer capability. Only the Service's
// authenticated execution scope may resolve it; there is no model-facing get.
const SECRET_REFERENCE_VERSION = 1;
const SECRET_REFERENCE_PATTERN = /\{\{SHOGGOTH_SECRET_([a-f0-9]{32})\}\}/gu;
const SECRET_KINDS = Object.freeze(["password", "api_key", "token", "private_key", "secret"]);
const SECRET_METHODS = Object.freeze(["prepare", "list", "revoke", "result", "results", "capabilities", "disclosures", "decide"].map(action => `chat.secret.${action}`));
const SECRET_MESSAGES = Object.freeze(require("../agent-service/chat-error-messages.json").chatSecrets);

function secretReference(id) {
  if (typeof id !== "string" || !/^[a-f0-9]{32}$/u.test(id)) throw new TypeError("Invalid secret reference id");
  return `{{SHOGGOTH_SECRET_${id}}}`;
}
function secretReferences(text) {
  return typeof text === "string" ? [...text.matchAll(new RegExp(SECRET_REFERENCE_PATTERN))].map(match => ({
    id: match[1], reference: match[0], start: match.index, end: match.index + match[0].length,
  })) : [];
}
function secretCapability({ input = false, productTools = false, nativeTools = false, images = false } = {}) {
  // Product-owned handling only: nativeTools means direct reference injection,
  // while images means the local pixel processor is present. Neither boolean
  // grants access to a native Runtime's independent storage or system privacy.
  return Object.freeze({ version: SECRET_REFERENCE_VERSION, input, productTools, nativeTools, images,
    temporary: true, expires: "local-day-end", targetBinding: "current-tool-call" });
}
function validateSecretResult(method, value) {
  const object = (input, names) => input && Object.getPrototypeOf(input) === Object.prototype
    && Object.keys(input).sort().join() === [...names].sort().join();
  const instant = input => Number.isSafeInteger(input) && input >= 0;
  const reference = input => object(input, ["reference", "kind", "expiresAt", "available"])
    && typeof input.reference === "string" && /^\{\{SHOGGOTH_SECRET_[a-f0-9]{32}\}\}$/u.test(input.reference)
    && SECRET_KINDS.includes(input.kind) && (input.expiresAt === null || instant(input.expiresAt))
    && typeof input.available === "boolean";
  const status = input => ["dispatching", "unknown", "completed"].includes(input);
  const items = (input, check, max) => Array.isArray(input) && input.length <= max && input.every(check);
  let valid = false;
  if (method === "chat.secret.prepare") valid = object(value, ["text", "references", "version"])
    && value.version === SECRET_REFERENCE_VERSION && typeof value.text === "string" && value.text.isWellFormed()
    && items(value.references, reference, 2048);
  if (method === "chat.secret.list") valid = object(value, ["items"]) && items(value.items, reference, 4096);
  if (method === "chat.secret.disclosures") valid = object(value, ["items"]) && items(value.items, item =>
    object(item, ["id", "recipient", "expiresAt"]) && /^[a-f0-9]{64}$/u.test(item.id)
    && item.recipient === "OpenAI" && instant(item.expiresAt), 64);
  if (method === "chat.secret.decide") valid = object(value, ["decided"]) && value.decided === true;
  if (method === "chat.secret.revoke") valid = object(value, ["revoked"]) && instant(value.revoked) && value.revoked <= 4096;
  if (method === "chat.secret.result") valid = object(value, ["status", "result"]) && status(value.status);
  if (method === "chat.secret.results") valid = object(value, ["items"]) && items(value.items, item =>
    object(item, ["receiptId", "tool", "status", "at", "expiresAt", "originalAvailable"])
    && typeof item.receiptId === "string" && /^[a-f0-9]{64}$/u.test(item.receiptId)
    && typeof item.tool === "string" && item.tool.length > 0 && item.tool.length <= 2048
    && status(item.status) && instant(item.at) && instant(item.expiresAt) && typeof item.originalAvailable === "boolean", 100);
  if (method === "chat.secret.capabilities") valid = object(value, Object.keys(secretCapability()))
    && value.version === SECRET_REFERENCE_VERSION && ["input", "productTools", "nativeTools", "images"].every(key => typeof value[key] === "boolean")
    && value.temporary === true && value.expires === "local-day-end" && value.targetBinding === "current-tool-call";
  if (!valid || Buffer.byteLength(JSON.stringify(value), "utf8") > 8 * 1024 * 1024) {
    throw Object.assign(new Error(SECRET_MESSAGES.SECRET_PROCESSING_UNAVAILABLE), { code: "SECRET_PROCESSING_UNAVAILABLE" });
  }
  return value;
}
// Elicitation schemas identify password fields even when a field has an opaque
// ID and a short value. Selection offsets refer to the serialized JSON literal,
// so the local parser decodes escapes exactly once.
function secretAnswerInput(answers, schema = {}) {
  let text = "{";
  const selections = [];
  for (const [key, value] of Object.entries(answers)) {
    if (text.length > 1) text += ",";
    text += `${JSON.stringify(key)}:`;
    const start = text.length;
    text += JSON.stringify(value);
    const field = schema.properties?.[key];
    if ((field?.writeOnly === true || field?.format === "password") && typeof value === "string" && value.length) {
      selections.push({ start, end: text.length, kind: "password" });
    }
  }
  return { text: `${text}}`, selections };
}
module.exports = { SECRET_REFERENCE_VERSION, SECRET_REFERENCE_PATTERN, SECRET_KINDS, SECRET_MESSAGES, SECRET_METHODS,
  secretReference, secretReferences, secretCapability, secretAnswerInput, validateSecretResult };
