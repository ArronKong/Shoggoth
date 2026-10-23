#!/usr/bin/env node
"use strict";
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const assert = require("node:assert/strict");
const schema = require("../app/managed-openclaw-provider-credential-schema");
const ERROR = { code: "MANAGED_MODEL_CREDENTIAL_CONTRACT_INVALID" };
const scope = () => ({ backendId: "openclaw", providerKey: "local", baseUrl: "https://model.example.test/v1", api: "openai-completions",
  operationId: "credential-schema-test", requestDigest: "a".repeat(64) });
const service = () => ({ instanceNonce: "b".repeat(48), pid: 12345, startedAt: Date.now() - 60000, protocolVersion: SERVICE_PROTOCOL_VERSION });
const writer = () => ({ version: 1, backendId: "openclaw", operationId: scope().operationId, requestDigest: scope().requestDigest,
  pid: 23456, startIdentity: "synthetic schema only", nonce: "c".repeat(64), generation: "generation-one",
  runtimeRoot: "/private/tmp/fixture-runtime", runtimeTreeSha256: "d".repeat(64), dataRoot: "/private/tmp/fixture-private-host",
  interpreterPath: "/private/tmp/external-node", entryPath: "/private/tmp/fixture-runtime/openclaw.mjs", expiresAt: Date.now() + 120000 });
const permit = () => ({ version: 1, owner: { ownerId: "synthetic-owner", capability: "e".repeat(64) }, scope: scope(), service: service(), writer: writer() });
const candidate = (p, action = "set") => ({ version: 1, ...p.scope, action, bindingRevision: 1, credentialRevision: action === "clear" ? null : 1,
  ownerGeneration: "service-minted-generation", expiresAt: Date.now() + 20000, ...(action === "set" ? { apiKey: "synthetic-canary" } : {}) });
const previous = p => { const { operationId: _op, requestDigest: _digest, ...previousScope } = p.scope; return { version: 1, ...p.scope,
  phase: "previous", previousScope: { ...previousScope, baseUrl: "https://old.example.test/v1" }, bindingRevision: 1, credentialRevision: 1,
  ownerGeneration: "service-minted-generation", expiresAt: Date.now() + 20000, apiKey: "synthetic-old-canary" }; };
const response = (p, envelope) => ({ service: p.service, envelope });
const groups = [];
const p = permit(); assert(Object.isFrozen(schema.credentialPermit(p))); assert(Object.isFrozen(schema.credentialPermit(p).writer));
groups.push("closed permit captures scope/service/physical writer without minting any authority or contacting a Service");
for (const value of [{ ...p, secret: "x" }, { ...p, owner: { ...p.owner, ref: "x" } }, { ...p, writer: { ...p.writer, controlToken: "x" } },
  { ...p, scope: { ...p.scope, requestDigest: "f".repeat(64) } }, { ...p, owner: { ...p.owner, capability: "wrong" } }]) assert.throws(() => schema.credentialPermit(value));
const getter = { ...p.owner }; let reads = 0; Object.defineProperty(getter, "capability", { enumerable: true, get() { reads++; return "e".repeat(64); } });
assert.throws(() => schema.credentialPermit({ ...p, owner: getter })); assert.equal(reads, 0);
assert.throws(() => schema.credentialPermit(Object.create(p))); assert.throws(() => schema.credentialPermit({ ...p, [Symbol("authority")]: true }));
groups.push("prototype/accessor/symbol/extra authority, arbitrary credential ref and mismatched original operation are rejected without invoking getters");
for (const baseUrl of ["https://model.example.test/v1/", "https://model.example.test/v1?token=x", "https://u:p@model.example.test/v1", "https://model.example.test/v1#x", "HTTPS://model.example.test/v1", " https://model.example.test/v1"])
  assert.throws(() => schema.operationScope({ ...p.scope, baseUrl }), ERROR);
assert.throws(() => schema.operationScope({ ...p.scope, api: "unbounded-api" }), ERROR);
assert.throws(() => schema.operationScope({ ...p.scope, providerKey: "../other" }), ERROR);
assert.equal(schema.operationScope({ ...p.scope, baseUrl: "http://127.0.0.1:12345/v1" }).baseUrl, "http://127.0.0.1:12345/v1");
groups.push("scope requires canonical endpoint and fixed API/provider identity; loopback synthetic endpoint remains usable");
for (const patch of [{ instanceNonce: "b".repeat(64) }, { protocolVersion: SERVICE_PROTOCOL_VERSION + 1 }, { pid: "12345" }, { startedAt: Date.now() + 60000 }, { generation: "x" }])
  assert.throws(() => schema.credentialPermit({ ...p, service: { ...p.service, ...patch } }), ERROR);
assert.throws(() => schema.credentialResponse({ service: { ...p.service, pid: 54321 }, envelope: candidate(p) }, p, { method: "read" }), ERROR);
groups.push("Service response must exactly match original incarnation/pid/start/protocol, and cannot silently roll to a new Service");
assert.equal(schema.credentialResponse(response(p, candidate(p)), p, { method: "read" }).envelope.apiKey, "synthetic-canary");
const assertion = candidate(p); delete assertion.apiKey; assert(schema.credentialResponse(response(p, assertion), p, { method: "assert" }));
assert.throws(() => schema.credentialResponse(response(p, candidate(p)), p, { method: "assert" }), ERROR);
assert.throws(() => schema.credentialResponse(response(p, assertion), p, { method: "read" }), ERROR);
assert.throws(() => schema.credentialResponse(response(p, { ...candidate(p), credentialRevision: null }), p, { method: "read" }), ERROR);
groups.push("candidate set read alone contains a bounded canary; assert never returns a key, and set requires a real credential revision");
for (const action of ["clear", "preserve"]) { const value = candidate(p, action); assert(schema.credentialResponse(response(p, value), p, { method: "read" }));
  assert.throws(() => schema.credentialResponse(response(p, { ...value, apiKey: "x" }), p, { method: "read" }), ERROR); }
assert.throws(() => schema.credentialResponse(response(p, { ...candidate(p, "clear"), credentialRevision: 1 }), p, { method: "read" }), ERROR);
assert.throws(() => schema.credentialResponse(response(p, { ...candidate(p), action: "rotate" }), p, { method: "read" }), ERROR);
groups.push("candidate clear/preserve cannot carry keys or invented actions; clear requires a null credential revision");
const old = previous(p); assert.equal(schema.credentialResponse(response(p, old), p, { method: "read", phase: "previous" }).envelope.previousScope.baseUrl, "https://old.example.test/v1");
const oldAssert = { ...old }; delete oldAssert.apiKey; assert(schema.credentialResponse(response(p, oldAssert), p, { method: "assert", phase: "previous" }));
for (const value of [{ ...old, previousScope: { ...old.previousScope, providerKey: "foreign" } }, { ...old, phase: "history" }, { ...old, credentialRef: "arbitrary-history" }, { ...old, bindingRevision: 0 }])
  assert.throws(() => schema.credentialResponse(response(p, value), p, { method: "read", phase: "previous" }), ERROR);
assert.throws(() => schema.credentialResponse(response(p, old), p, { method: "read" }), ERROR);
groups.push("previous phase permits only the operation's same-provider prior domain DTO, separate from candidate; arbitrary history/ref and cross-provider material reject");
const noOld = { ...old, previousScope: null, bindingRevision: 0, credentialRevision: null }; delete noOld.apiKey;
assert(schema.credentialResponse(response(p, noOld), p, { method: "read", phase: "previous" }));
const priorWithoutKey = { ...noOld, previousScope: old.previousScope, bindingRevision: 3 }; assert(schema.credentialResponse(response(p, priorWithoutKey), p, { method: "read", phase: "previous" }));
for (const value of [{ ...noOld, apiKey: "x" }, { ...noOld, bindingRevision: 3 }, { ...priorWithoutKey, credentialRevision: 1 }])
  assert.throws(() => schema.credentialResponse(response(p, value), p, { method: "read", phase: "previous" }), ERROR);
groups.push("missing previous binding is revision zero/null; an existing old binding may have no key, and initial config bytes do not substitute for it");
for (const expiresAt of [Date.now() - 1, Date.now() + 40000, p.writer.expiresAt + 1])
  assert.throws(() => schema.credentialResponse(response(p, { ...candidate(p), expiresAt }), p, { method: "read" }), ERROR);
assert.throws(() => schema.credentialResponse(response(p, { ...candidate(p), requestDigest: "f".repeat(64) }), p, { method: "read" }), ERROR);
assert.throws(() => schema.credentialResponse(response(p, { ...candidate(p), bindingRevision: -1 }), p, { method: "read" }), ERROR);
assert.throws(() => schema.credentialResponse(response(p, { ...candidate(p), apiKey: "\0" }), p, { method: "read" }), ERROR);
groups.push("stale/overlong material deadline, foreign operation/digest/revisions and malformed key reject before any consumer effect");
assert.throws(() => schema.credentialResponse(response(p, { ...candidate(p), apiKey: '"'.repeat(40000) }), p, { method: "read" }), ERROR);
assert.throws(() => schema.credentialResponse({ ...response(p, candidate(p)), extra: true }, p, { method: "read" }), ERROR);
groups.push("JSON escaping participates in the fixed64KiB contract budget; success-shaped oversized and extra-field responses reject");
const settlement = { version: 1, backendId: "openclaw", providerKey: p.scope.providerKey, state: "applied", hasSecret: true, operationId: p.scope.operationId };
assert(schema.credentialSettlement(response(p, settlement), p, "applied"));
for (const dto of [{ ...settlement, apiKey: "x" }, { ...settlement, state: "compensated" }, { ...settlement, operationId: "other" }])
  assert.throws(() => schema.credentialSettlement(response(p, dto), p, "applied"), ERROR);
groups.push("settlement is only exact public status6 bound to original scope/outcome, never a new credential envelope");
assert(schema.sameCredentialWriter(p.writer, { ...p.writer, expiresAt: p.writer.expiresAt + 1000 }));
for (const patch of [{ pid: 23457 }, { nonce: "f".repeat(64) }, { generation: "new-generation" }, { dataRoot: "/private/tmp/other-data" }])
  assert.equal(schema.sameCredentialWriter(p.writer, { ...p.writer, ...patch }), false);
groups.push("expiry is not physical identity; this comparison alone neither renews authority nor permits replacement owner/rebinding");
process.stdout.write(JSON.stringify({ status: "PASS", groups: groups.length, cases: groups, hostStarts: 0, serviceRequests: 0, modelRequests: 0, secretWrites: 0,
  boundary: "pure closed DTO contract only; no physical owner, Service capability, socket or credential consumption is proved" }) + "\n");
