"use strict";

// File-token IPC only. Request brands are minted after Service authentication.
// Logical capabilities AND independently verified physical writers are required;
// none of these methods is exposed by renderer HTTP or public Backend commands.
const crypto = require("node:crypto");
const { ExternalProviderCredentialController, createExternalProviderManagementAuthority,
  createExternalProviderManagedLeaseAuthority, externalProviderOperationScope } = require("./external-provider-credential-controller");
const { credentialOwner } = require("../managed-openclaw-provider-credential");
const { sameExternalProviderWriter } = require("./external-provider-credential-writer");
const { SERVICE_PROTOCOL_VERSION } = require("./service-protocol-version");
const { serviceError } = require("./security");
const { NATIVE_AUTH_PREFIX } = require("../managed-openclaw-auth-profile-constants");

const PREFIX = "external.provider.credential.";
const METHODS = Object.freeze(["status", "list", "observe", "prepare", "owner.open", "owner.close", "owner.renew", "owner.advance",
  "lease.read", "lease.assert", "lease.settle", "lease.terminal.observe"].map(name => PREFIX + name));
const METHOD_SET = new Set(METHODS);
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_OWNERS = 128, OWNER_TTL = 300000, MAX_FRAME_BYTES = 65536;
const fail = code => { throw serviceError(code, code); };
const need = (value, code = "EXTERNAL_PROVIDER_CREDENTIAL_RPC_INVALID") => { if (!value) fail(code); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function exact(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => { const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value"); });
}
function capture(value, budget = { nodes: 2000, bytes: MAX_FRAME_BYTES }, depth = 0) {
  need(--budget.nodes >= 0 && depth <= 12);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") { need(Number.isFinite(value)); return value; }
  if (typeof value === "string") { budget.bytes -= Buffer.byteLength(value); need(budget.bytes >= 0); return value; }
  need(value && typeof value === "object" && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype));
  const result = Array.isArray(value) ? [] : {};
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    need(typeof key === "string" && !["__proto__", "prototype", "constructor"].includes(key));
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    need(descriptor?.enumerable === true && Object.hasOwn(descriptor, "value"));
    budget.bytes -= Buffer.byteLength(key); need(budget.bytes >= 0);
    result[key] = capture(descriptor.value, budget, depth + 1);
  }
  return Object.freeze(result);
}
function captureOwner(value) {
  need(exact(value, ["ownerId", "capability"]) && typeof value.ownerId === "string" && OPAQUE.test(value.ownerId)
    && typeof value.capability === "string" && /^[a-f0-9]{64}$/u.test(value.capability));
  return value;
}
function captureService(value) {
  const current = capture(value);
  need(exact(current, ["instanceNonce", "pid", "startedAt", "protocolVersion"])
    && typeof current.instanceNonce === "string" && /^[a-f0-9]{48}$/u.test(current.instanceNonce)
    && Number.isSafeInteger(current.pid) && current.pid > 1
    && Number.isSafeInteger(current.startedAt) && current.startedAt > 0 && current.startedAt <= Date.now()
    && current.protocolVersion === SERVICE_PROTOCOL_VERSION, "EXTERNAL_PROVIDER_CREDENTIAL_SERVICE_INVALID");
  return current;
}
function checkFrame(result) {
  // The server enforces the same 128-byte request ID for these private methods.
  // Check the worst response before persisting new secret material.
  need(Buffer.byteLength(JSON.stringify({ id: "i".repeat(128), ok: true, result })) + 1 <= MAX_FRAME_BYTES,
    "EXTERNAL_PROVIDER_CREDENTIAL_FRAME_TOO_LARGE");
}
function createExternalProviderCredentialRpc(options) {
  need(options?.paths && options.secretStore && typeof options.assertServiceCurrent === "function"
    && typeof options.getServiceIdentity === "function" && typeof options.verifyManagedWriter === "function",
  "EXTERNAL_PROVIDER_CREDENTIAL_RPC_OPTIONS_INVALID");
  need(options.namespace === undefined || options.namespace === "auth-profile", "EXTERNAL_PROVIDER_CREDENTIAL_RPC_OPTIONS_INVALID");
  const PREFIX = options.namespace === "auth-profile" ? NATIVE_AUTH_PREFIX : "external.provider.credential.";
  const METHOD_SET = new Set(METHODS.map(method => PREFIX + method.slice("external.provider.credential.".length)));
  const now = options.now || Date.now;
  const contexts = new WeakMap(), managedContexts = new WeakMap(), owners = new Map(), byOperation = new Map();
  let opened = false, incarnation = Symbol("external-provider-credential-rpc"), service = null;
  const isCurrent = () => opened && options.assertServiceCurrent() === true;
  function serviceIdentity() {
    const value = captureService(options.getServiceIdentity());
    if (service) need(equal(service, value), "EXTERNAL_PROVIDER_CREDENTIAL_SERVICE_RETIRED");
    else service = value;
    return value;
  }
  function checkRequest(context) {
    const record = contexts.get(context);
    need(record && record.incarnation === incarnation && isCurrent() && record.assertCurrent() === true,
      "EXTERNAL_PROVIDER_CREDENTIAL_RPC_RETIRED");
    serviceIdentity(); return record;
  }
  function checkOwner(record) {
    need(isCurrent() && record?.incarnation === incarnation && owners.get(record.ownerId) === record
      && record.expiresAt > now(), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_RETIRED");
    serviceIdentity();
  }
  async function verifyWriter(writer, scope, phase, context, owner, extra = {}) {
    checkRequest(context); if (owner) checkOwner(owner);
    const assertion = await options.verifyManagedWriter(writer, { scope, phase, ...extra,
      assertCurrent() { checkRequest(context); if (owner) checkOwner(owner); return true; } });
    checkRequest(context); if (owner) checkOwner(owner);
    need(typeof assertion === "function" && assertion() === true, "EXTERNAL_PROVIDER_CREDENTIAL_WRITER_UNVERIFIED");
    return assertion;
  }
  const controller = new ExternalProviderCredentialController({ paths: options.paths, secretStore: options.secretStore,
    ...(options.namespace ? { namespace: options.namespace } : {}),
    ...(options.fs ? { fs: options.fs } : {}),
    authorizeManagement(_scope, context) {
      checkRequest(context);
      return createExternalProviderManagementAuthority(() => { checkRequest(context); return true; });
    },
    authorizeManagedLease(scope, context) {
      const record = managedContexts.get(context);
      need(record, "EXTERNAL_PROVIDER_CREDENTIAL_RPC_FORBIDDEN");
      const assertion = () => { checkRequest(record.request); checkOwner(record.owner);
        need(record.assertWriter() === true, "EXTERNAL_PROVIDER_CREDENTIAL_WRITER_RETIRED"); return true; };
      assertion();
      need(equal(externalProviderOperationScope(Object.fromEntries(
        ["backendId", "providerKey", "baseUrl", "api", "operationId", "requestDigest"].map(key => [key, scope[key]]))), record.owner.scope),
      "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_SCOPE_MISMATCH");
      return createExternalProviderManagedLeaseAuthority({ ownerGeneration: record.owner.ownerGeneration,
        expiresAt: record.owner.expiresAt, assertCurrent: assertion });
    },
  });
  function forget(record) {
    owners.delete(record.ownerId);
    if (byOperation.get(record.scope.operationId) === record) byOperation.delete(record.scope.operationId);
  }
  function ownerFor(value, scope) {
    const owner = captureOwner(value), record = owners.get(owner.ownerId);
    need(record && record.capability.length === owner.capability.length
      && crypto.timingSafeEqual(Buffer.from(record.capability), Buffer.from(owner.capability)),
    "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_FORBIDDEN");
    checkOwner(record);
    if (scope) need(equal(record.scope, scope), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_SCOPE_MISMATCH");
    return record;
  }
  function boundWriter(value, scope, record) {
    const writer = credentialOwner(value);
    need(writer.operationId === scope.operationId && writer.requestDigest === scope.requestDigest,
      "EXTERNAL_PROVIDER_CREDENTIAL_WRITER_SCOPE_MISMATCH");
    if (record) need(sameExternalProviderWriter(writer, record.writer), "EXTERNAL_PROVIDER_CREDENTIAL_WRITER_CHANGED");
    return writer;
  }
  function permit(record) {
    checkOwner(record);
    return Object.freeze({ version: 1, owner: Object.freeze({ ownerId: record.ownerId, capability: record.capability }),
      scope: record.scope, service: serviceIdentity(), writer: record.writer });
  }
  function wrapped(envelope) {
    const result = Object.freeze({ service: serviceIdentity(), envelope }); checkFrame(result); return result;
  }
  const api = Object.freeze({
    isMethod: method => METHOD_SET.has(method),
    async open() {
      if (opened) return;
      const attempt = Symbol("external-provider-credential-rpc"); incarnation = attempt;
      await controller.open();
      need(incarnation === attempt, "EXTERNAL_PROVIDER_CREDENTIAL_RPC_RETIRED"); opened = true; service = null;
    },
    async close() {
      opened = false; incarnation = Symbol("external-provider-credential-rpc"); service = null;
      owners.clear(); byOperation.clear(); await controller.close();
    },
    createRequestContext(assertCurrent) {
      need(isCurrent() && typeof assertCurrent === "function", "EXTERNAL_PROVIDER_CREDENTIAL_RPC_RETIRED");
      const context = Object.freeze({}); contexts.set(context, { incarnation, assertCurrent });
      checkRequest(context); return context;
    },
    async dispatch(method, rawParams, context) {
      need(METHOD_SET.has(method), "EXTERNAL_PROVIDER_CREDENTIAL_METHOD_INVALID");
      checkRequest(context);
      const params = capture(rawParams); let result;
      if (method === PREFIX + "status") {
        need(exact(params, ["scope"])); result = await controller.getStatus(params.scope, context);
      } else if (method === PREFIX + "list") {
        need(exact(params, [])); result = await controller.list(context);
      } else if (method === PREFIX + "observe") {
        need(exact(params, ["scope"])); result = await controller.observe(params.scope, context);
      } else if (method === PREFIX + "prepare") {
        need(exact(params, ["scope", "action"]) || exact(params, ["scope", "action", "secret"]));
        const scope = externalProviderOperationScope(params.scope);
        if (Object.hasOwn(params, "secret")) {
          checkFrame({ service: serviceIdentity(), envelope: { version: 1, ...scope, action: "set", bindingRevision: Number.MAX_SAFE_INTEGER,
            credentialRevision: Number.MAX_SAFE_INTEGER, ownerGeneration: "g".repeat(128), expiresAt: Number.MAX_SAFE_INTEGER, apiKey: params.secret } });
        }
        result = await controller.prepare({ ...scope, action: params.action,
          ...(Object.hasOwn(params, "secret") ? { secret: params.secret } : {}) }, context);
      } else if (method === PREFIX + "owner.open") {
        need(exact(params, ["scope", "holderEpoch", "writer"]) && typeof params.holderEpoch === "string" && OPAQUE.test(params.holderEpoch));
        const scope = externalProviderOperationScope(params.scope), writer = boundWriter(params.writer, scope);
        const assertion = await verifyWriter(writer, scope, "open", context);
        const status = await controller.observe(scope, context); checkRequest(context); need(assertion() === true, "EXTERNAL_PROVIDER_CREDENTIAL_WRITER_RETIRED");
        need(["prepared", "inflight"].includes(status.state), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
        let record = byOperation.get(scope.operationId);
        if (record) {
          checkOwner(record); need(equal(record.scope, scope) && record.holderEpoch === params.holderEpoch
            && sameExternalProviderWriter(writer, record.writer), "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_SCOPE_MISMATCH");
        } else {
          // Closing an inflight owner does not prove its original write absent.
          need(status.state === "prepared", "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
          for (const candidate of owners.values()) if (candidate.expiresAt <= now()) forget(candidate);
          need(owners.size < MAX_OWNERS, "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_CAPACITY");
          record = { incarnation, scope, holderEpoch: params.holderEpoch, writer, ownerId: crypto.randomUUID(),
            ownerGeneration: "external-owner-" + crypto.randomUUID(), capability: crypto.randomBytes(32).toString("hex"),
            expiresAt: Math.min(writer.expiresAt, now() + OWNER_TTL) };
          owners.set(record.ownerId, record); byOperation.set(scope.operationId, record);
        }
        result = permit(record);
      } else if (method === PREFIX + "owner.close") {
        need(exact(params, ["owner"])); forget(ownerFor(params.owner)); result = Object.freeze({ version: 1, closed: true });
      } else if (method === PREFIX + "owner.renew" || method === PREFIX + "owner.advance") {
        need(exact(params, ["scope", "owner", "writer"]));
        const scope = externalProviderOperationScope(params.scope), previous = ownerFor(params.owner, scope), advance = method.endsWith("advance");
        need(!previous.terminalPending && !previous.terminalObservation, "EXTERNAL_PROVIDER_CREDENTIAL_TERMINAL_OWNER");
        const writer = boundWriter(params.writer, scope, advance ? null : previous);
        const assertion = await verifyWriter(writer, scope, advance ? "advance" : "renew", context, previous,
          advance ? { previousWriter: previous.writer } : {});
        checkOwner(previous); need(assertion() === true, "EXTERNAL_PROVIDER_CREDENTIAL_WRITER_RETIRED");
        need(!previous.terminalPending && !previous.terminalObservation, "EXTERNAL_PROVIDER_CREDENTIAL_TERMINAL_OWNER");
        if (advance) {
          need(!sameExternalProviderWriter(writer, previous.writer) && writer.nonce !== previous.writer.nonce
            && writer.generation !== previous.writer.generation, "EXTERNAL_PROVIDER_CREDENTIAL_WRITER_ADVANCE_INVALID");
          const record = { ...previous, writer, expiresAt: Math.min(writer.expiresAt, now() + OWNER_TTL),
            capability: crypto.randomBytes(32).toString("hex") };
          owners.set(record.ownerId, record); byOperation.set(scope.operationId, record); result = permit(record);
        } else {
          // A read cannot extend authority. Only this verified private renewal can.
          need(writer.expiresAt >= previous.writer.expiresAt, "EXTERNAL_PROVIDER_CREDENTIAL_DEADLINE_REWIND");
          previous.writer = writer; previous.expiresAt = Math.min(writer.expiresAt, now() + OWNER_TTL); result = permit(previous);
        }
      } else if (method === PREFIX + "lease.terminal.observe") {
        need(exact(params, ["scope", "owner", "writer", "outcome", "writerState"])
          && ["applied", "compensated", "blocked"].includes(params.outcome) && ["paused", "resumed"].includes(params.writerState));
        const scope = externalProviderOperationScope(params.scope), record = ownerFor(params.owner, scope);
        const writer = boundWriter(params.writer, scope, record), terminal = record.terminalObservation;
        need(terminal && terminal.capability === record.capability && terminal.outcome === params.outcome
          && equal(terminal.writer, writer) && terminal.expiresAt > now(),
        "EXTERNAL_PROVIDER_CREDENTIAL_TERMINAL_UNVERIFIED");
        const extra = { outcome: params.outcome, writerState: params.writerState };
        const assertWriter = await verifyWriter(writer, scope, "terminal-observe", context, record, extra);
        const managed = Object.freeze({}); managedContexts.set(managed, { request: context, owner: record, assertWriter });
        const observed = await controller.observeTerminalForManagedLease({ scope, outcome: params.outcome }, managed);
        checkOwner(record); need(assertWriter() === true, "EXTERNAL_PROVIDER_CREDENTIAL_WRITER_RETIRED");
        const fresh = await verifyWriter(writer, scope, "terminal-observe", context, record, extra);
        checkOwner(record); need(fresh() === true && observed.assertCurrent() === true
          && terminal === record.terminalObservation && terminal.capability === record.capability
          && terminal.expiresAt > now(), "EXTERNAL_PROVIDER_CREDENTIAL_WRITER_RETIRED");
        result = wrapped(Object.freeze({ ...observed.envelope,
          expiresAt: Math.min(observed.envelope.expiresAt, terminal.expiresAt) }));
      } else {
        const read = method === PREFIX + "lease.read", settle = method === PREFIX + "lease.settle";
        const fields = ["scope", "owner", "writer", ...(settle ? ["outcome"] : [])];
        const optional = read ? ["phase", "recovery"] : settle ? [] : ["phase"];
        need(Object.keys(params).length >= fields.length && exact(params, [...fields, ...optional.filter(key => Object.hasOwn(params, key))]));
        if (Object.hasOwn(params, "phase")) need(["candidate", "previous"].includes(params.phase));
        if (Object.hasOwn(params, "recovery")) need(typeof params.recovery === "boolean");
        const scope = externalProviderOperationScope(params.scope), record = ownerFor(params.owner, scope), writer = boundWriter(params.writer, scope, record);
        const assertWriter = await verifyWriter(writer, scope, settle ? "settle" : read ? "read" : "assert", context, record,
          settle ? { outcome: params.outcome } : {});
        if (settle && params.outcome !== "needs_verification") {
          checkOwner(record); record.terminalPending = true;
        }
        const managed = Object.freeze({}); managedContexts.set(managed, { request: context, owner: record, assertWriter });
        const envelope = read ? await controller.readForManagedLease({ ...scope,
          ...(Object.hasOwn(params, "phase") ? { phase: params.phase } : {}),
          ...(Object.hasOwn(params, "recovery") ? { recovery: params.recovery } : {}) }, managed)
          : settle ? await controller.settleManagedLease({ scope, outcome: params.outcome }, managed)
          : await controller.assertForManagedLease({ ...scope, ...(Object.hasOwn(params, "phase") ? { phase: params.phase } : {}) }, managed);
        if (settle && params.outcome !== "needs_verification" && !record.terminalObservation)
          record.terminalObservation = Object.freeze({ capability: record.capability, writer,
            expiresAt: Math.min(record.expiresAt, writer.expiresAt), outcome: params.outcome });
        checkOwner(record); need(assertWriter() === true, "EXTERNAL_PROVIDER_CREDENTIAL_WRITER_RETIRED");
        // Recheck the pinned tree, actual process/listener and pause state after
        // Store awaits. A retired writer never receives the decrypted material.
        const fresh = await verifyWriter(writer, scope, settle ? "settle" : read ? "read" : "assert", context, record,
          settle ? { outcome: params.outcome } : {});
        checkOwner(record); need(fresh() === true, "EXTERNAL_PROVIDER_CREDENTIAL_WRITER_RETIRED"); result = wrapped(envelope);
      }
      checkRequest(context); checkFrame(result); return result;
    },
  });
  return api;
}
module.exports = { createExternalProviderCredentialRpc, EXTERNAL_PROVIDER_CREDENTIAL_IPC_METHODS: METHODS };
