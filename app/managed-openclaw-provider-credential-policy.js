"use strict";
// Pure effect policy; only Supervisor's verified Service/socket/physical-owner
// gate may call this before writing. Caller-shaped material grants no authority.
const crypto = require("node:crypto");
const model = require("./managed-openclaw-model-policy");
const schema = require("./managed-openclaw-provider-credential-schema");
const need = (value, code) => { if (!value) throw model.fail(code); };
const clone = value => JSON.parse(JSON.stringify(model.capture(value)));
const provider = (config, key) => config.models?.providers?.[key];
const oldKey = entry => entry && Object.hasOwn(entry, "apiKey") ? entry.apiKey : undefined;
function withoutKey(config, key) { const result = clone(config); if (provider(result, key)) delete provider(result, key).apiKey; return result; }
function sameKey(a, b) {
  if (a === undefined || b === undefined) return a === b;
  if (typeof a !== "string" || typeof b !== "string") return false;
  const first = Buffer.from(a), second = Buffer.from(b);
  try { return first.length === second.length && crypto.timingSafeEqual(first, second); } finally { first.fill(0); second.fill(0); }
}
function domain(entry, key) {
  need(entry && typeof entry.baseUrl === "string", "MANAGED_MODEL_PROVIDER_ENDPOINT_UNBOUND");
  return schema.providerScope({ backendId: "openclaw", providerKey: key, baseUrl: entry.baseUrl, api: entry.api || "openai-completions" });
}
function assertNoWireSecrets(patch) {
  model.capture(patch);
  const entries = patch.models?.providers;
  if (model.plain(entries)) for (const entry of Object.values(entries)) {
    need(!model.plain(entry) || !Object.hasOwn(entry, "apiKey"), "MANAGED_MODEL_PROVIDER_SECRET_IN_WIRE");
  }
  return true;
}
function validateMetadataPatch(before, after, safeSpec, initial) {
  const key = safeSpec.providerKey, old = provider(before, key), next = provider(after, key);
  // Creating/removing a provider or changing its endpoint/API requires explicit
  // Service binding even when this initial private config has no key.
  need(old && next && model.equal(old.baseUrl, next.baseUrl) && model.equal(old.api, next.api)
    && model.equal(oldKey(old), oldKey(next)), "MANAGED_MODEL_PROVIDER_CREDENTIAL_REQUIRED");
  return model.validatePatch(before, after, safeSpec, initial);
}
function priorKey(initial, key, permit, response) {
  const old = provider(initial, key);
  const value = schema.credentialResponse(response, permit, { method: "read", phase: "previous" }).envelope;
  if (old) {
    // Existing config bytes alone never authorize reuse. The original operation
    // must have retained an exact old binding (including a keyless binding).
    if (value.previousScope === null && oldKey(old) === undefined) {
      need(value.credentialRevision === null && !Object.hasOwn(value, "apiKey"), "MANAGED_MODEL_PREVIOUS_CREDENTIAL_UNBOUND");
    } else need(value.previousScope !== null && model.equal(value.previousScope, domain(old, key)), "MANAGED_MODEL_PREVIOUS_CREDENTIAL_UNBOUND");
    if (oldKey(old) === undefined) need(value.credentialRevision === null && !Object.hasOwn(value, "apiKey"), "MANAGED_MODEL_PREVIOUS_CREDENTIAL_UNBOUND");
    else need(value.credentialRevision !== null && sameKey(oldKey(old), value.apiKey), "MANAGED_MODEL_PREVIOUS_CREDENTIAL_UNBOUND");
  } else need(value.previousScope === null && value.credentialRevision === null && !Object.hasOwn(value, "apiKey"), "MANAGED_MODEL_PREVIOUS_CREDENTIAL_UNBOUND");
  return Object.hasOwn(value, "apiKey") ? value.apiKey : undefined;
}
function applyCredentialPatch({ before, after, initial, safeSpec, permit: rawPermit, phase, response, previousResponse }) {
  const permit = schema.credentialPermit(rawPermit), key = safeSpec.providerKey;
  need(key === permit.scope.providerKey && permit.scope.backendId === "openclaw", "MANAGED_MODEL_PROVIDER_CREDENTIAL_UNBOUND");
  need(["candidate", "previous"].includes(phase), "MANAGED_MODEL_PROVIDER_CREDENTIAL_UNBOUND");
  const result = clone(after), next = provider(result, key), original = provider(initial, key);
  if (phase === "previous") {
    const restored = priorKey(initial, key, permit, response);
    if (next) { if (restored === undefined) delete next.apiKey; else next.apiKey = restored; }
    need(model.equal(model.domain(result), model.domain(initial)), "MANAGED_MODEL_PREVIOUS_DOMAIN_UNBOUND");
  } else {
    const value = schema.credentialResponse(response, permit, { method: "read", phase: "candidate" }).envelope;
    const { operationId: _operation, requestDigest: _digest, ...targetScope } = permit.scope;
    if (next) need(model.equal(domain(next, key), targetScope), "MANAGED_MODEL_PROVIDER_CREDENTIAL_UNBOUND");
    else need(safeSpec.kind === "delete-provider" && value.action === "clear" && model.equal(domain(provider(before, key), key), targetScope),
      "MANAGED_MODEL_PROVIDER_CREDENTIAL_UNBOUND");
    if (value.action === "preserve") {
      need(next && original && model.equal(domain(original, key), targetScope), "MANAGED_MODEL_PROVIDER_CREDENTIAL_UNBOUND");
      const previous = priorKey(initial, key, permit, previousResponse);
      if (previous === undefined) delete next.apiKey; else next.apiKey = previous;
    } else if (next) { if (value.action === "clear") delete next.apiKey; else next.apiKey = value.apiKey; }
  }
  // Credential authority changes only this provider's apiKey. All unrelated
  // provider keys, references, models and system fields still face original
  // safeSpec/initial policy, including exact compensation domain.
  model.validatePatch(withoutKey(before, key), withoutKey(result, key), safeSpec, withoutKey(initial, key));
  return result;
}
module.exports = { assertNoWireSecrets, validateMetadataPatch, applyCredentialPatch };
