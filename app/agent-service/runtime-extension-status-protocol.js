"use strict";
const { serviceError } = require("./security");
const { validRuntime, validRuntimeAccountId } = require("./runtime-adapter");
const METHOD = "runtime.extension.status.get";
const CODES = Object.freeze(["RUNTIME_EXTENSION_CATALOG_UNAVAILABLE", "RUNTIME_EXTENSION_UNTRUSTED",
  "RUNTIME_EXTENSION_DISABLED", "RUNTIME_EXTENSION_UNAVAILABLE", "RUNTIME_ACCOUNT_GENERATION_STALE"]);
const MAX_ENTRIES = 256;
const invalid = () => serviceError("RUNTIME_EXTENSION_STATUS_INVALID", "Runtime extension status is unavailable");
function record(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) throw invalid();
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw invalid();
  }
  return value;
}
function list(value, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max
    || Reflect.ownKeys(value).length !== value.length + 1) throw invalid();
  return Array.from({ length: value.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw invalid();
    return field.value;
  });
}
function features(value) {
  record(value, ["attachments", "resume", "compact", "steer"]);
  const attachments = list(value.attachments, 3);
  if (new Set(attachments).size !== attachments.length
    || attachments.some(kind => !["image", "pdf", "file"].includes(kind))
    || ["resume", "compact", "steer"].some(key => !["supported", "unsupported", "unverified"].includes(value[key]))) throw invalid();
  return { attachments, resume: value.resume, compact: value.compact, steer: value.steer };
}
function validateParams(value) { record(value, []); return {}; }
function validateResult(value) {
  record(value, ["entries"]);
  const entries = list(value.entries, MAX_ENTRIES);
  const seen = new Set();
  return { entries: entries.map(entry => {
    record(entry, ["runtime", "runtimeAccountId", "enabled", "availability", "code", "authentication", "features"]);
    if (!validRuntime(entry.runtime) || !entry.runtime.startsWith("ext-") || !validRuntimeAccountId(entry.runtimeAccountId)
      || seen.has(entry.runtimeAccountId) || typeof entry.enabled !== "boolean"
      || !["available", "unavailable", "unknown"].includes(entry.availability)
      || (entry.availability === "available" ? entry.code !== null || !entry.enabled : !CODES.includes(entry.code))
      || !["authenticated", "unauthenticated", "unverified"].includes(entry.authentication)
      || entry.availability !== "available" && entry.authentication !== "unverified") throw invalid();
    seen.add(entry.runtimeAccountId);
    const support = features(entry.features);
    if (entry.availability !== "available" && (support.attachments.length || [support.resume, support.compact, support.steer].some(state => state !== "unverified"))) throw invalid();
    return { ...entry, features: support };
  }) };
}
module.exports = { METHOD, CODES, MAX_ENTRIES, validateParams, validateResult };
