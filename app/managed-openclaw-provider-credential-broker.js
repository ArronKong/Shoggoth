"use strict";
// App-private Main composition only. A permit is not a secret and no exported
// method reads keys: the owned Worker is the sole lease.read consumer.
const path = require("node:path"), crypto = require("node:crypto");
const { requestService: defaultRequestService, readClientToken: defaultReadClientToken } = require("./agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("./agent-service/service-protocol-version");
const { externalProviderOperationScope } = require("./agent-service/external-provider-credential-controller");
const { credentialOwner } = require("./managed-openclaw-provider-credential");
const { NATIVE_AUTH_PREFIX, NATIVE_AUTH_KEY } = require("./managed-openclaw-auth-profile-constants");
const PREFIX = "external.provider.credential.";
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u, HASH = /^[a-f0-9]{64}$/u;
const METHODS = new Set(["service.status", "status", "list", "observe", "prepare", "owner.open", "owner.renew", "owner.advance", "owner.close"]);
const DTO_KEYS = ["version", "backendId", "providerKey", "state", "hasSecret", "operationId"];
const STATES = new Set(["unconfigured", "stored", "not_found", "prepared", "inflight", "needs_verification", "applied", "compensated", "blocked", "failed"]);
class ManagedProviderCredentialBrokerError extends Error {
  constructor(code) { super("受管凭据操作无法安全继续"); this.name = "ManagedProviderCredentialBrokerError"; this.code = code; this.status = 409; }
}
const fail = code => { throw new ManagedProviderCredentialBrokerError(code); };
const need = (value, code = "MANAGED_CREDENTIAL_BROKER_INVALID") => { if (!value) fail(code); };
function exact(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => { const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value"); });
}
function capture(value, depth = 0, budget = { nodes: 3000, bytes: 65536 }) {
  need(depth <= 12 && --budget.nodes >= 0);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") { need(Number.isFinite(value)); return value; }
  if (typeof value === "string") { budget.bytes -= Buffer.byteLength(value); need(budget.bytes >= 0); return value; }
  need(Array.isArray(value) || exact(value, Object.keys(value || {})));
  if (Array.isArray(value)) return Object.freeze(value.map(item => capture(item, depth + 1, budget)));
  const output = {};
  for (const key of Object.keys(value)) { need(!["__proto__", "prototype", "constructor"].includes(key));
    budget.bytes -= Buffer.byteLength(key); need(budget.bytes >= 0); output[key] = capture(value[key], depth + 1, budget); }
  return Object.freeze(output);
}
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function scopeOf(raw) { try { return externalProviderOperationScope(capture(raw)); } catch { fail("MANAGED_CREDENTIAL_SCOPE_INVALID"); } }
function ownerOf(raw) {
  need(exact(raw, ["ownerId", "capability"]) && typeof raw.ownerId === "string" && OWNER.test(raw.ownerId)
    && typeof raw.capability === "string" && HASH.test(raw.capability), "MANAGED_CREDENTIAL_PERMIT_INVALID");
  return capture(raw);
}
function serviceOf(raw) {
  need(exact(raw, ["instanceNonce", "pid", "startedAt", "protocolVersion"])
    && typeof raw.instanceNonce === "string" && /^[a-f0-9]{48}$/u.test(raw.instanceNonce)
    && Number.isSafeInteger(raw.pid) && raw.pid > 1 && Number.isSafeInteger(raw.startedAt) && raw.startedAt > 0
    && raw.startedAt <= Date.now() && raw.protocolVersion === SERVICE_PROTOCOL_VERSION, "MANAGED_CREDENTIAL_SERVICE_INVALID");
  return capture(raw);
}
function permitOf(raw, scope, writer) {
  need(exact(raw, ["version", "owner", "scope", "service", "writer"]) && raw.version === 1, "MANAGED_CREDENTIAL_PERMIT_INVALID");
  const output = Object.freeze({ version: 1, owner: ownerOf(raw.owner), scope: scopeOf(raw.scope), service: serviceOf(raw.service), writer: credentialOwner(raw.writer) });
  need(equal(output.scope, scope) && equal(output.writer, writer), "MANAGED_CREDENTIAL_PERMIT_SCOPE_MISMATCH"); return output;
}
function managementDTO(raw, scope, requireOperation = false) {
  need(exact(raw, DTO_KEYS) && raw.version === 1 && raw.backendId === "openclaw" && STATES.has(raw.state)
    && typeof raw.hasSecret === "boolean" && (raw.providerKey === null || typeof raw.providerKey === "string" && (PROVIDER.test(raw.providerKey) || NATIVE_AUTH_KEY.test(raw.providerKey)))
    && (raw.operationId === null || typeof raw.operationId === "string" && OWNER.test(raw.operationId)), "MANAGED_CREDENTIAL_DTO_INVALID");
  if (raw.state === "not_found") need(raw.hasSecret === false && raw.operationId !== null, "MANAGED_CREDENTIAL_DTO_INVALID");
  if (scope) need(raw.providerKey === scope.providerKey
    && (!requireOperation || raw.operationId === scope.operationId), "MANAGED_CREDENTIAL_DTO_SCOPE_MISMATCH");
  return capture(raw);
}
function createManagedOpenClawProviderCredentialBroker({ paths, modelController,
  requestService = defaultRequestService, readClientToken = defaultReadClientToken, timeoutMs = 45000 } = {}) {
  need(paths && modelController && typeof modelController.isModelOwnerCurrent === "function"
    && typeof requestService === "function" && typeof readClientToken === "function"
    && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000, "MANAGED_CREDENTIAL_BROKER_OPTIONS_INVALID");
  const fixedPaths = {};
  for (const key of ["runtimeDir", "socketPath", "tokenPath"]) {
    const value = paths[key]; need(typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value
      && Buffer.byteLength(value) <= 4096 && !/[\0\r\n]/u.test(value), "MANAGED_CREDENTIAL_BROKER_PATHS_INVALID"); fixedPaths[key] = value;
  }
  Object.freeze(fixedPaths);
  const contexts = new WeakMap(), permits = new WeakMap(), operations = new Map();
  const holderEpoch = crypto.randomUUID(), fingerprintKey = crypto.randomBytes(32), abort = new AbortController();
  let retired = false;
  function checkpoint(context) {
    const captured = contexts.get(context);
    need(captured && !retired && !abort.signal.aborted && !captured.signal?.aborted, "MANAGED_CREDENTIAL_BROKER_RETIRED");
    let current = false; try { current = modelController.isModelOwnerCurrent(captured.modelOwner) === true; } catch { /* denied */ }
    need(current, "MANAGED_CREDENTIAL_MODEL_OWNER_RETIRED");
    try { const assertion = captured.assertProviderLease();
      need(assertion === undefined || assertion === true, "MANAGED_CREDENTIAL_PROVIDER_LEASE_RETIRED"); }
    catch { fail("MANAGED_CREDENTIAL_PROVIDER_LEASE_RETIRED"); }
    return captured;
  }
  async function rpc(name, params, context) {
    need(METHODS.has(name), "MANAGED_CREDENTIAL_METHOD_FORBIDDEN"); const captured = capture(params);
    const guard = checkpoint(context); let token;
    try {
      token = readClientToken(fixedPaths); checkpoint(context);
      const signal = guard.signal ? AbortSignal.any([abort.signal, guard.signal]) : abort.signal;
      const result = await requestService(fixedPaths, { id: crypto.randomUUID(), version: SERVICE_PROTOCOL_VERSION,
        token, method: name === "service.status" ? name : (guard.nativeAuth ? NATIVE_AUTH_PREFIX : PREFIX) + name, params: captured }, { timeoutMs, signal });
      checkpoint(context); return result;
    } catch (error) {
      if (error instanceof ManagedProviderCredentialBrokerError) throw error;
      const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/u.test(error.code)
        ? error.code : "MANAGED_CREDENTIAL_RPC_UNVERIFIED";
      fail(code);
    } finally { token = null; }
  }
  async function assertOriginalService(permit, context) {
    const result = capture(await rpc("service.status", {}, context));
    need(result && result.healthy === true && result.maintenanceQuiesced === false,
      "MANAGED_CREDENTIAL_SERVICE_UNAVAILABLE");
    const identity = serviceOf(Object.fromEntries(["instanceNonce", "pid", "startedAt", "protocolVersion"].map(key => [key, result[key]])));
    need(equal(identity, permit.service), "MANAGED_CREDENTIAL_SERVICE_CHANGED");
  }
  function currentPermit(permit, context) {
    checkpoint(context); const record = permits.get(permit);
    need(record && record.permit === permit && operations.get(record.scope.operationId) === record
      && record.context === context && record.state === "bound", "MANAGED_CREDENTIAL_PERMIT_RETIRED");
    return record;
  }
  function assertWriter(writer, scope) {
    let captured; try { captured = credentialOwner(writer); } catch { fail("MANAGED_CREDENTIAL_WRITER_INVALID"); }
    need(captured.operationId === scope.operationId && captured.requestDigest === scope.requestDigest,
      "MANAGED_CREDENTIAL_WRITER_SCOPE_MISMATCH"); return captured;
  }
  function secretFingerprint(action, secret) {
    return crypto.createHmac("sha256", fingerprintKey).update(action + "\0").update(secret || "").digest("hex");
  }
  function uncertain(record) { record.state = "needs_verification"; }
  async function ownerRequest(name, record, writer, context) {
    checkpoint(context); const capturedWriter = assertWriter(writer, record.scope);
    let result;
    try { result = await rpc(name, { scope: record.scope, ...(name === "owner.open" ? { holderEpoch } : { owner: record.permit.owner }), writer: capturedWriter }, context); }
    catch (error) { uncertain(record); throw error; }
    let permit;
    try {
      permit = permitOf(result, record.scope, capturedWriter);
      if (record.permit) {
        need(equal(permit.service, record.permit.service) && permit.owner.ownerId === record.permit.owner.ownerId,
          "MANAGED_CREDENTIAL_OWNER_CHANGED");
        need(name === "owner.advance" ? permit.owner.capability !== record.permit.owner.capability
          : permit.owner.capability === record.permit.owner.capability, "MANAGED_CREDENTIAL_OWNER_CHANGED");
      }
      checkpoint(context);
    } catch (error) { uncertain(record); throw error; }
    record.permit = permit; record.writer = capturedWriter; record.state = "bound"; record.context = context;
    permits.set(permit, record); return permit;
  }
  const api = Object.freeze({
    createContext({ modelOwner, assertProviderLease, signal, nativeAuth = false } = {}) {
      need(typeof nativeAuth === "boolean", "MANAGED_CREDENTIAL_CONTEXT_INVALID");
      need(typeof assertProviderLease === "function" && (!signal || typeof signal.aborted === "boolean" && typeof signal.addEventListener === "function"), "MANAGED_CREDENTIAL_CONTEXT_INVALID");
      const context = Object.freeze(Object.create(null)); contexts.set(context, { modelOwner, assertProviderLease, signal, nativeAuth }); checkpoint(context); return context;
    },
    async status(rawScope, context) {
      const operation = scopeOf(rawScope); const provider = Object.fromEntries(["backendId", "providerKey", "baseUrl", "api"].map(key => [key, operation[key]]));
      return managementDTO(await rpc("status", { scope: provider }, context), operation);
    },
    async list(context) { const rows = await rpc("list", {}, context); need(Array.isArray(rows) && rows.length <= 128, "MANAGED_CREDENTIAL_DTO_INVALID"); return Object.freeze(rows.map(value => managementDTO(value))); },
    async observe(rawScope, context) { const scope = scopeOf(rawScope); return managementDTO(await rpc("observe", { scope }, context), scope, true); },
    async prepareAndOpen({ scope: rawScope, action, secret, writer, recovery = false } = {}, context) {
      const scope = scopeOf(rawScope); checkpoint(context);
      need(["set", "clear", "preserve"].includes(action) && typeof recovery === "boolean", "MANAGED_CREDENTIAL_ACTION_INVALID");
      need(action === "set" ? typeof secret === "string" && secret.length > 0 && Buffer.byteLength(secret) <= 65536 && !secret.includes("\0") : secret === undefined,
        "MANAGED_CREDENTIAL_SECRET_INVALID");
      const fingerprint = secretFingerprint(action, secret); let record = operations.get(scope.operationId);
      if (record) {
        need(equal(record.scope, scope) && record.action === action && record.secretFingerprint === fingerprint,
          "MANAGED_CREDENTIAL_OPERATION_CONFLICT");
        checkpoint(context); need(record.context === context || recovery === true, "MANAGED_CREDENTIAL_OPERATION_CONFLICT");
        // Unknown acknowledgments may only be observed. No automatic new owner,
        // key preparation, mutation or recovery authorization is minted.
        if (record.pending && record.context === context && !recovery) {
          const permit = await record.pending; checkpoint(context); return permit;
        }
        if (record.state === "needs_verification" || record.state === "opening" || record.state === "preparing") {
          await api.observe(scope, context); fail("MANAGED_CREDENTIAL_NEEDS_VERIFICATION");
        }
        need(record.state === "bound" && record.context === context && record.permit, "MANAGED_CREDENTIAL_NEEDS_VERIFICATION");
        need(equal(assertWriter(writer, scope), record.writer), "MANAGED_CREDENTIAL_WRITER_CHANGED"); return record.permit;
      }
      need(!recovery, "MANAGED_CREDENTIAL_RECOVERY_INPUT_UNAVAILABLE");
      need(operations.size < 128, "MANAGED_CREDENTIAL_OPERATION_CAPACITY");
      record = { scope, action, secretFingerprint: fingerprint, context, state: "preparing", permit: null, writer: assertWriter(writer, scope) };
      operations.set(scope.operationId, record);
      record.pending = (async () => {
        try {
          // A durable receipt from an earlier Main incarnation forbids a fresh
          // prepare/open. Unknown operations are observations, never retries.
          const original = await api.observe(scope, context);
          need(original.operationId === scope.operationId && original.state === "not_found",
            "MANAGED_CREDENTIAL_NEEDS_VERIFICATION");
          const dto = managementDTO(await rpc("prepare", { scope, action, ...(action === "set" ? { secret } : {}) }, context), scope, true);
          need(dto.state === "prepared", "MANAGED_CREDENTIAL_NEEDS_VERIFICATION");
          record.state = "opening"; return await ownerRequest("owner.open", record, record.writer, context);
        } catch (error) { uncertain(record); throw error; }
        finally { secret = undefined; }
      })();
      try { return await record.pending; } finally { record.pending = null; }
    },
    async renew(permit, writer, context) {
      const record = currentPermit(permit, context), next = assertWriter(writer, record.scope);
      for (const key of Object.keys(record.writer)) if (key !== "expiresAt") need(next[key] === record.writer[key], "MANAGED_CREDENTIAL_WRITER_CHANGED");
      need(next.expiresAt >= record.writer.expiresAt, "MANAGED_CREDENTIAL_WRITER_CHANGED");
      return ownerRequest("owner.renew", record, next, context);
    },
    async advance(permit, writer, context) {
      const record = currentPermit(permit, context), next = assertWriter(writer, record.scope);
      for (const key of ["backendId", "operationId", "requestDigest", "runtimeRoot", "runtimeTreeSha256", "dataRoot", "interpreterPath", "entryPath"])
        need(next[key] === record.writer[key], "MANAGED_CREDENTIAL_WRITER_CHANGED");
      need(next.nonce !== record.writer.nonce && next.generation !== record.writer.generation
        && (next.pid !== record.writer.pid || next.startIdentity !== record.writer.startIdentity),
        "MANAGED_CREDENTIAL_WRITER_CHANGED");
      return ownerRequest("owner.advance", record, next, context);
    },
    async observeRetainedOperation(identity, context) {
      need(exact(identity, ["operationId", "requestDigest"]) && typeof identity.operationId === "string"
        && OWNER.test(identity.operationId) && typeof identity.requestDigest === "string" && HASH.test(identity.requestDigest),
        "MANAGED_CREDENTIAL_OPERATION_CONFLICT");
      checkpoint(context); const record = operations.get(identity.operationId);
      need(record && record.scope.requestDigest === identity.requestDigest, "MANAGED_CREDENTIAL_RECOVERY_INPUT_UNAVAILABLE");
      // Management observation is safe even after the original private caller
      // retired. It never transfers its capability to this new Core context.
      return managementDTO(await rpc("observe", { scope: record.scope }, context), record.scope, true);
    },
    async observeFinished(permit, outcome, context, verifiedWorkerFinish) {
      const record = currentPermit(permit, context);
      need(["applied", "compensated", "blocked"].includes(outcome) && verifiedWorkerFinish === true,
        "MANAGED_CREDENTIAL_FINISH_UNVERIFIED");
      record.state = "observing-terminal";
      try {
        // Worker.finish has already checked the wrapped Service identity and
        // durable settlement. Main must never resend that side-effecting RPC.
        await assertOriginalService(permit, context);
        const dto = managementDTO(await rpc("observe", { scope: record.scope }, context), record.scope, true);
        need(dto.state === outcome, "MANAGED_CREDENTIAL_SETTLE_UNVERIFIED");
        await assertOriginalService(permit, context);
        const closed = await rpc("owner.close", { owner: permit.owner }, context);
        need(exact(closed, ["version", "closed"]) && closed.version === 1 && closed.closed === true,
          "MANAGED_CREDENTIAL_CLOSE_UNVERIFIED");
        record.state = "settled"; record.outcome = outcome; operations.delete(record.scope.operationId); return dto;
      } catch (error) { uncertain(record); throw error; }
    },
    async observeRecoveredTerminal(identity, outcome, context, verifiedWorkerRecovery) {
      need(exact(identity, ["operationId", "requestDigest"]) && typeof identity.operationId === "string"
        && OWNER.test(identity.operationId) && typeof identity.requestDigest === "string" && HASH.test(identity.requestDigest),
        "MANAGED_CREDENTIAL_OPERATION_CONFLICT");
      const captured = checkpoint(context), record = operations.get(identity.operationId);
      need(record && record.scope.requestDigest === identity.requestDigest && record.permit
        && ["bound", "needs_verification"].includes(record.state), "MANAGED_CREDENTIAL_RECOVERY_INPUT_UNAVAILABLE");
      // The new provider lock permits observation/retirement only. It does not
      // transfer the original permit or extend its lifetime to a new model owner.
      need(contexts.get(record.context)?.modelOwner === captured.modelOwner,
        "MANAGED_CREDENTIAL_MODEL_OWNER_RETIRED");
      need(["applied", "compensated", "blocked"].includes(outcome) && verifiedWorkerRecovery === true,
        "MANAGED_CREDENTIAL_FINISH_UNVERIFIED");
      need(!record.terminalObservationPending, "MANAGED_CREDENTIAL_OPERATION_IN_PROGRESS");
      record.terminalObservationPending = true; record.state = "observing-terminal";
      try {
        const permit = record.permit; await assertOriginalService(permit, context);
        const dto = managementDTO(await rpc("observe", { scope: record.scope }, context), record.scope, true);
        need(dto.state === outcome, "MANAGED_CREDENTIAL_SETTLE_UNVERIFIED");
        await assertOriginalService(permit, context);
        const closed = await rpc("owner.close", { owner: permit.owner }, context);
        need(exact(closed, ["version", "closed"]) && closed.version === 1 && closed.closed === true,
          "MANAGED_CREDENTIAL_CLOSE_UNVERIFIED");
        checkpoint(context); need(operations.get(record.scope.operationId) === record, "MANAGED_CREDENTIAL_PERMIT_RETIRED");
        record.state = "settled"; record.outcome = outcome; operations.delete(record.scope.operationId); return dto;
      } catch (error) { uncertain(record); throw error; }
      finally { record.terminalObservationPending = false; }
    },
    hasOperation(operationId, requestDigest) { const record = operations.get(operationId); return !!(record && record.scope.requestDigest === requestDigest); },
    retire() { if (retired) return; retired = true; abort.abort(); fingerprintKey.fill(0); },
  });
  return api;
}
module.exports = { createManagedOpenClawProviderCredentialBroker, ManagedProviderCredentialBrokerError,
  _protocol: Object.freeze({ scopeOf, permitOf, managementDTO }) };
