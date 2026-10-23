"use strict";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const ENVELOPE_FIELDS = ["version", "operationId", "dispatchRef", "selectionDigest",
  "requiredAdapterId", "adapterGeneration"];
const SUBJECT_FIELDS = ["backendId", "instanceId", "agentId", "sessionId"];
const STATES = new Set(["prepared", "bound", "completed", "canceled", "expired", "outcome_unknown"]);
function exact(value, fields) {
  return value && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === fields.length
    && fields.every(field => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    });
}
function id(value, max = 256) {
  return typeof value === "string" && ID.test(value) && Buffer.byteLength(value, "utf8") <= max;
}
function subject(value) {
  return exact(value, SUBJECT_FIELDS) && ["openclaw", "hermes"].includes(value.backendId)
    && id(value.instanceId, 128) && id(value.agentId, 128) && id(value.sessionId);
}
function envelope(value) {
  return exact(value, ENVELOPE_FIELDS) && value.version === 1
    && id(value.operationId, 128) && id(value.dispatchRef, 128)
    && typeof value.selectionDigest === "string" && HASH.test(value.selectionDigest)
    && id(value.requiredAdapterId, 128) && id(value.adapterGeneration, 128);
}
function invalid() { throw new TypeError("invalid external plugin selection response"); }
function matchesSubject(left, right) {
  return SUBJECT_FIELDS.every(field => left[field] === right[field]);
}
function validSelection(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return false;
  const seen = new Set();
  return value.every(item => {
    if (!exact(item, ["installationId", "revision"]) || !id(item.installationId, 128)
      || !Number.isSafeInteger(item.revision) || item.revision < 1 || seen.has(item.installationId)) return false;
    seen.add(item.installationId);
    return true;
  });
}
function validateExternalPluginSelectionInput(method, value) {
  const prepare = method === "plugins.selection.external.prepare";
  if (!["plugins.selection.external.prepare", "plugins.selection.external.get",
    "plugins.selection.external.cancel", "plugins.selection.external.cancelSession"].includes(method)
    || !exact(value, prepare
      ? ["subject", "operationId", "requiredAdapterId", "adapterGeneration", "pluginSelection"]
      : method === "plugins.selection.external.cancelSession" ? ["subject"] : ["subject", "operationId"])
    || !subject(value.subject)
    || (method !== "plugins.selection.external.cancelSession" && !id(value.operationId, 128))
    || (prepare && (!id(value.requiredAdapterId, 128) || !id(value.adapterGeneration, 128)
      || !validSelection(value.pluginSelection)))) invalid();
  return structuredClone(value);
}
function receipt(value, params) {
  if (!exact(value, [...ENVELOPE_FIELDS, "state", "subject", "identity",
    "createdAt", "updatedAt", "expiresAt"])
    || !envelope(Object.fromEntries(ENVELOPE_FIELDS.map(field => [field, value[field]])))
    || !STATES.has(value.state) || !subject(value.subject)
    || !matchesSubject(value.subject, params.subject) || value.operationId !== params.operationId
    || ![value.createdAt, value.updatedAt, value.expiresAt].every(time => Number.isSafeInteger(time) && time >= 0)
    || value.expiresAt < value.createdAt) invalid();
  if (value.identity !== null) {
    const fields = [...SUBJECT_FIELDS, ...(value.subject.backendId === "openclaw"
      ? ["runId"] : ["taskId", "turnId"])];
    if (!exact(value.identity, fields) || !matchesSubject(value.identity, value.subject)
      || !fields.filter(field => !SUBJECT_FIELDS.includes(field)).every(field => id(value.identity[field]))) invalid();
  }
  if ((["bound", "completed"].includes(value.state) && value.identity === null)
    || (["prepared", "expired"].includes(value.state) && value.identity !== null)) invalid();
  return Object.freeze({ ...value, subject: Object.freeze({ ...value.subject }),
    identity: value.identity && Object.freeze({ ...value.identity }) });
}
function validateExternalPluginSelectionResult(method, value, params) {
  validateExternalPluginSelectionInput(method, params);
  if (method === "plugins.selection.external.cancelSession") {
    if (!Array.isArray(value) || value.length > 128) invalid();
    const seen = new Set();
    return Object.freeze(value.map(item => {
      if (!item || seen.has(item.operationId) || item.state !== "canceled") invalid();
      const result = receipt(item, { subject: params.subject, operationId: item.operationId });
      seen.add(item.operationId);
      return result;
    }));
  }
  if (method !== "plugins.selection.external.prepare") return value === null ? null : receipt(value, params);
  if (!exact(value, ["envelope", "receipt"]) || !envelope(value.envelope)) invalid();
  const resultReceipt = receipt(value.receipt, params);
  if (!ENVELOPE_FIELDS.every(field => value.envelope[field] === resultReceipt[field])
    || resultReceipt.requiredAdapterId !== params.requiredAdapterId
    || resultReceipt.adapterGeneration !== params.adapterGeneration) invalid();
  return Object.freeze({ envelope: Object.freeze({ ...value.envelope }), receipt: resultReceipt });
}
module.exports = { validateExternalPluginSelectionInput, validateExternalPluginSelectionResult };
