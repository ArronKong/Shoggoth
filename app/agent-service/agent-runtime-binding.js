"use strict";

const crypto = require("node:crypto");
const { runtimeBinding } = require("./runtime-adapter");
const { serviceError } = require("./security");

const MAX_AGENT_RUNTIME_BINDINGS = 128;
const MAX_BINDING_OPERATIONS = 2048;
const BINDING_FIELDS = ["id", "profileId", "runtime", "runtimeProfileId", "runtimeAccountId",
  "label", "enabled", "revision", "createdAt", "updatedAt"];
const PROJECTED_RUNTIME_FIELDS = ["runtime", "runtimeProfileId", "runtimeAccountId"];
const BINDING_STATE_FIELDS = ["defaultBindingId", "bindingsRevision", "bindings", "bindingOperations"];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

function bindingError(code, message = "Agent Runtime Binding 无效") {
  return serviceError(`AGENT_BINDING_${code}`, message);
}
function exact(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}
function stableUuid(namespace, value) {
  const bytes = crypto.createHash("sha256").update(namespace).update("\0").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function bindingId(profileId, runtimeProfileId) {
  return stableUuid("shoggoth-agent-binding-v1", `${profileId}\0${runtimeProfileId}`);
}
function runtimeProfileIdForBinding(profileId, operationId) {
  return `shoggoth-runtime-${stableUuid("shoggoth-agent-runtime-profile-v1", `${profileId}\0${operationId}`)}`;
}
function validateAgentRuntimeBinding(value) {
  if (!exact(value, BINDING_FIELDS) || !UUID.test(value.id)
    || typeof value.profileId !== "string" || !value.profileId || value.profileId.includes("\0")
    || value.id !== bindingId(value.profileId, value.runtimeProfileId)
    || !(value.label === null || (typeof value.label === "string" && value.label.length <= 256
      && value.label.length > 0 && value.label.isWellFormed() && !/[\u0000-\u001f]/u.test(value.label)))
    || typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.createdAt) throw bindingError("INVALID");
  try { runtimeBinding({ runtime: value.runtime, runtimeProfileId: value.runtimeProfileId,
    runtimeAccountId: value.runtimeAccountId }); } catch { throw bindingError("INVALID"); }
  return Object.fromEntries(BINDING_FIELDS.map((key) => [key, value[key]]));
}
function initialBinding(profile) {
  const createdAt = profile.createdAt ?? 0;
  return validateAgentRuntimeBinding({
    id: bindingId(profile.id, profile.runtimeProfileId), profileId: profile.id,
    runtime: profile.runtime, runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId,
    label: null, enabled: true, revision: 1, createdAt, updatedAt: Math.max(createdAt, profile.updatedAt ?? 0),
  });
}
function withInitialBinding(profile) {
  const binding = initialBinding(profile);
  return { ...profile, defaultBindingId: binding.id, bindingsRevision: 1, bindings: [binding], bindingOperations: [] };
}
function validateBindingState(profile) {
  if (!Array.isArray(profile.bindings) || profile.bindings.length < 1
    || profile.bindings.length > MAX_AGENT_RUNTIME_BINDINGS || !Number.isSafeInteger(profile.bindingsRevision)
    || profile.bindingsRevision < 1 || !Array.isArray(profile.bindingOperations)
    || profile.bindingOperations.length > MAX_BINDING_OPERATIONS) throw bindingError("INVALID");
  const bindings = profile.bindings.map(validateAgentRuntimeBinding);
  if (new Set(bindings.map((binding) => binding.id)).size !== bindings.length
    || bindings.some((binding) => binding.profileId !== profile.id || binding.revision > profile.bindingsRevision)) {
    throw bindingError("INVALID");
  }
  const selected = bindings.find((binding) => binding.id === profile.defaultBindingId);
  if (!selected || !selected.enabled) throw bindingError("DEFAULT_PROTECTED");
  const operations = profile.bindingOperations.map((operation) => {
    if (!exact(operation, ["operationId", "bindingId", "fingerprint"])
      || typeof operation.operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(operation.operationId)
      || !UUID.test(operation.bindingId) || !/^[a-f0-9]{64}$/u.test(operation.fingerprint)) throw bindingError("INVALID");
    return { ...operation };
  });
  if (new Set(operations.map((operation) => operation.operationId)).size !== operations.length) throw bindingError("INVALID");
  return { defaultBindingId: selected.id, bindingsRevision: profile.bindingsRevision,
    bindings, bindingOperations: operations };
}
function projectProfile(profile, selectedId = profile.defaultBindingId) {
  const selected = profile.bindings.find((binding) => binding.id === selectedId);
  if (!selected) throw bindingError("NOT_FOUND");
  const { bindings: _bindings, bindingOperations: _operations, selectedBindingId: _selected, ...view } = profile;
  return { ...view, runtime: selected.runtime, runtimeProfileId: selected.runtimeProfileId,
    runtimeAccountId: selected.runtimeAccountId };
}
function profileToDisk(profile) {
  return Object.fromEntries(Object.entries(profile).filter(([field]) => !PROJECTED_RUNTIME_FIELDS.includes(field)
    && field !== "selectedBindingId"));
}
function profileWithoutBindingState(profile) {
  return Object.fromEntries(Object.entries(profile).filter(([field]) => !BINDING_STATE_FIELDS.includes(field)
    && field !== "selectedBindingId"));
}

module.exports = { BINDING_FIELDS, BINDING_STATE_FIELDS, PROJECTED_RUNTIME_FIELDS, MAX_AGENT_RUNTIME_BINDINGS, MAX_BINDING_OPERATIONS,
  bindingError, bindingId, runtimeProfileIdForBinding, stableUuid, validateAgentRuntimeBinding, validateBindingState,
  withInitialBinding, projectProfile, profileToDisk, profileWithoutBindingState };
