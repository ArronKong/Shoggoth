"use strict";
// Data validation only. A parsed permit never creates authority; the Worker
// must independently ask the original Service and check its captured writer.
const { plain, capture, equal, HASH, OP, fail } = require("./managed-openclaw-model-policy");
const { credentialOwner } = require("./managed-openclaw-provider-credential");
const { SERVICE_PROTOCOL_VERSION } = require("./agent-service/service-protocol-version");
const { NATIVE_AUTH_API, NATIVE_AUTH_KEY } = require("./managed-openclaw-auth-profile-constants");
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const APIS = new Set(["openai-completions", "openai-responses", "openai-chatgpt-responses", "anthropic-messages",
  "google-generative-ai", "google-vertex", "github-copilot", "bedrock-converse-stream", "ollama", "azure-openai-responses"]);
const SCOPE_FIELDS = Object.freeze(["backendId", "providerKey", "baseUrl", "api"]);
const OPERATION_FIELDS = Object.freeze([...SCOPE_FIELDS, "operationId", "requestDigest"]);
const SERVICE_FIELDS = Object.freeze(["instanceNonce", "pid", "startedAt", "protocolVersion"]);
const MATERIAL_FIELDS = Object.freeze(["version", ...OPERATION_FIELDS, "bindingRevision", "credentialRevision", "ownerGeneration", "expiresAt"]);
const MAX_FRAME_BYTES = 65536;
const invalid = () => { throw fail("MANAGED_MODEL_CREDENTIAL_CONTRACT_INVALID"); };
const need = value => { if (!value) invalid(); };
function exact(value, keys) { return plain(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function canonicalEndpoint(value) {
  need(typeof value === "string" && value.length <= 4096 && value === value.trim());
  let parsed; try { parsed = new URL(value); } catch { invalid(); }
  need(["http:", "https:"].includes(parsed.protocol) && parsed.hostname && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
    && parsed.toString().replace(/\/$/u, "") === value);
  return value;
}
function providerScope(value) {
  if (exact(value, SCOPE_FIELDS) && value.api === NATIVE_AUTH_API) {
    need(value.backendId === "openclaw" && typeof value.providerKey === "string" && NATIVE_AUTH_KEY.test(value.providerKey) && value.baseUrl === null);
    return capture(value);
  }
  need(exact(value, SCOPE_FIELDS) && value.backendId === "openclaw" && typeof value.providerKey === "string" && PROVIDER.test(value.providerKey)
    && typeof value.api === "string" && APIS.has(value.api));
  canonicalEndpoint(value.baseUrl); return capture(value);
}
function operationScope(value) {
  need(exact(value, OPERATION_FIELDS));
  providerScope(Object.fromEntries(SCOPE_FIELDS.map(key => [key, value[key]])));
  need(typeof value.operationId === "string" && OP.test(value.operationId) && typeof value.requestDigest === "string" && HASH.test(value.requestDigest));
  return capture(value);
}
function serviceIdentity(value) {
  need(exact(value, SERVICE_FIELDS) && typeof value.instanceNonce === "string" && /^[a-f0-9]{48}$/u.test(value.instanceNonce)
    && Number.isSafeInteger(value.pid) && value.pid > 1 && Number.isSafeInteger(value.startedAt) && value.startedAt > 0 && value.startedAt <= Date.now()
    && value.protocolVersion === SERVICE_PROTOCOL_VERSION);
  return capture(value);
}
function bounded(value) { need(Buffer.byteLength(JSON.stringify(value)) <= MAX_FRAME_BYTES); return capture(value); }
function credentialPermit(value) {
  need(exact(value, ["version", "owner", "scope", "service", "writer"]) && value.version === 1
    && exact(value.owner, ["ownerId", "capability"]) && typeof value.owner.ownerId === "string" && OP.test(value.owner.ownerId)
    && typeof value.owner.capability === "string" && HASH.test(value.owner.capability));
  const scope = operationScope(value.scope), writer = credentialOwner(value.writer); serviceIdentity(value.service);
  need(writer.operationId === scope.operationId && writer.requestDigest === scope.requestDigest);
  return bounded(value);
}
function material(value, permit, method, phase) {
  need(method === "read" || method === "assert");
  const previous = phase === "previous";
  need(previous || phase === "candidate");
  const fields = [...MATERIAL_FIELDS, ...(previous ? ["phase", "previousScope"] : ["action"])];
  const hasKey = Object.hasOwn(value || {}, "apiKey");
  need(exact(value, [...fields, ...(hasKey ? ["apiKey"] : [])]) && value.version === 1);
  const scope = operationScope(Object.fromEntries(OPERATION_FIELDS.map(key => [key, value[key]])));
  need(equal(scope, permit.scope) && Number.isSafeInteger(value.bindingRevision) && value.bindingRevision >= 0
    && (value.credentialRevision === null || Number.isSafeInteger(value.credentialRevision) && value.credentialRevision >= 0)
    && typeof value.ownerGeneration === "string" && OP.test(value.ownerGeneration)
    && Number.isSafeInteger(value.expiresAt) && value.expiresAt > Date.now() && value.expiresAt <= Date.now() + 30000
    && value.expiresAt <= permit.writer.expiresAt);
  if (previous) {
    need(value.phase === "previous");
    if (value.previousScope === null) need(value.bindingRevision === 0 && value.credentialRevision === null);
    else {
      const old = providerScope(value.previousScope);
      need(old.backendId === scope.backendId && old.providerKey === scope.providerKey && value.bindingRevision > 0);
    }
    need(hasKey === (method === "read" && value.credentialRevision !== null));
  } else {
    need(["set", "clear", "preserve"].includes(value.action));
    need(value.action !== "set" || value.credentialRevision !== null);
    need(value.action !== "clear" || value.credentialRevision === null);
    need(hasKey === (method === "read" && value.action === "set"));
  }
  if (hasKey) need(typeof value.apiKey === "string" && value.apiKey.length > 0 && !value.apiKey.includes("\0"));
  return bounded(value);
}
function credentialResponse(value, rawPermit, options) {
  need(exact(options, ["method"]) || exact(options, ["method", "phase"]));
  const { method, phase = "candidate" } = options;
  const permit = credentialPermit(rawPermit);
  need(exact(value, ["service", "envelope"]));
  need(equal(serviceIdentity(value.service), permit.service));
  material(value.envelope, permit, method, phase);
  return bounded(value);
}
function credentialSettlement(value, rawPermit, outcome) {
  const permit = credentialPermit(rawPermit);
  need(["applied", "compensated", "blocked", "needs_verification"].includes(outcome) && exact(value, ["service", "envelope"]));
  need(equal(serviceIdentity(value.service), permit.service));
  const dto = value.envelope;
  need(exact(dto, ["version", "backendId", "providerKey", "state", "hasSecret", "operationId"])
    && dto.version === 1 && dto.backendId === permit.scope.backendId && dto.providerKey === permit.scope.providerKey
    && dto.operationId === permit.scope.operationId && dto.state === outcome && typeof dto.hasSecret === "boolean");
  return bounded(value);
}
/** No key/ref is read here. Current Service independently verifies the
 * original terminal outcome, binding snapshot and exact paused/resumed writer. */
function credentialTerminalObservation(value, rawPermit, outcome, expected) {
  const permit = credentialPermit(rawPermit);
  need(["applied", "compensated", "blocked"].includes(outcome) && exact(value, ["service", "envelope"]));
  need(equal(serviceIdentity(value.service), permit.service));
  const dto = value.envelope;
  const fields = ["version", ...OPERATION_FIELDS, "outcome", "action", "bindingScope", "bindingRevision", "credentialRevision", "ownerGeneration", "expiresAt"];
  need(exact(dto, fields) && dto.version === 1 && equal(operationScope(Object.fromEntries(OPERATION_FIELDS.map(key => [key, dto[key]]))), permit.scope)
    && dto.outcome === outcome && ["set", "clear", "preserve"].includes(dto.action)
    && Number.isSafeInteger(dto.bindingRevision) && dto.bindingRevision >= 0
    && (dto.credentialRevision === null || Number.isSafeInteger(dto.credentialRevision) && dto.credentialRevision >= 0)
    && typeof dto.ownerGeneration === "string" && OP.test(dto.ownerGeneration)
    && Number.isSafeInteger(dto.expiresAt) && dto.expiresAt > Date.now() && dto.expiresAt <= Date.now() + 10000
    && dto.expiresAt <= permit.writer.expiresAt);
  if (dto.bindingScope !== null) providerScope(dto.bindingScope);
  else need(dto.bindingRevision === 0 && dto.credentialRevision === null);
  need(exact(expected, ["candidate", "previous"]) && exact(expected.candidate, ["version", ...OPERATION_FIELDS, "action", "bindingRevision", "credentialRevision", "ownerGeneration"])
    && dto.action === expected.candidate.action && dto.ownerGeneration === expected.candidate.ownerGeneration);
  const candidate = expected.candidate;
  need(candidate.version === 1 && equal(operationScope(Object.fromEntries(OPERATION_FIELDS.map(key => [key, candidate[key]]))), permit.scope)
    && Number.isSafeInteger(candidate.bindingRevision) && candidate.bindingRevision >= 0
    && (candidate.credentialRevision === null || Number.isSafeInteger(candidate.credentialRevision) && candidate.credentialRevision >= 0));
  if (outcome === "applied") {
    need(dto.bindingRevision === candidate.bindingRevision + 1
      && equal(dto.bindingScope, Object.fromEntries(SCOPE_FIELDS.map(key => [key, permit.scope[key]]))));
    need(dto.action === "set" ? dto.credentialRevision !== null
      : dto.action === "clear" ? dto.credentialRevision === null
      : (dto.credentialRevision !== null) === (candidate.credentialRevision !== null));
  } else {
    const previous = expected.previous;
    need(exact(previous, ["version", ...OPERATION_FIELDS, "phase", "previousScope", "bindingRevision", "credentialRevision", "ownerGeneration"]) && previous.version === 1 && previous.phase === "previous"
      && equal(operationScope(Object.fromEntries(OPERATION_FIELDS.map(key => [key, previous[key]]))), permit.scope)
      && dto.ownerGeneration === previous.ownerGeneration
      && dto.bindingRevision === previous.bindingRevision && equal(dto.bindingScope, previous.previousScope)
      && (dto.credentialRevision !== null) === (previous.credentialRevision !== null));
  }
  return bounded(value);
}
function credentialRpcOptions(method, value) {
  need(method === "config.patch" && exact(value, ["credentialPhase"]) && ["candidate", "previous"].includes(value.credentialPhase));
  return capture(value);
}
// expiresAt is a deadline, not an identity. A different physical owner requires
// Service advance; a later deadline still requires Service renew and rebind.
function sameCredentialWriter(a, b) {
  const first = credentialOwner(a), second = credentialOwner(b);
  const withoutExpiry = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "expiresAt"));
  return equal(withoutExpiry(first), withoutExpiry(second));
}
module.exports = { SCOPE_FIELDS, OPERATION_FIELDS, SERVICE_FIELDS, MAX_FRAME_BYTES,
  providerScope, operationScope, serviceIdentity, credentialPermit, credentialResponse, credentialSettlement, credentialTerminalObservation, credentialRpcOptions, sameCredentialWriter };
