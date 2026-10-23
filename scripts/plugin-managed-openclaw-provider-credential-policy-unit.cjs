#!/usr/bin/env node
"use strict";
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const assert = require("node:assert/strict");
const policy = require("../app/managed-openclaw-provider-credential-policy");
const clone = value => JSON.parse(JSON.stringify(value));
const modelEntry = { id: "old", name: "Old", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const initial = { models: { providers: { local: { baseUrl: "https://old.example.test/v1", api: "openai-completions", apiKey: "synthetic-initial-key", models: [modelEntry] },
  foreign: { baseUrl: "https://foreign.example.test/v1", api: "openai-completions", apiKey: "synthetic-foreign-key", models: [{ ...modelEntry, id: "foreign" }] } } },
  agents: { defaults: { model: { primary: "local/old" }, workspace: "/private/owned" }, entries: [{ id: "local-agent", identity: { name: "Preserved" } }] },
  gateway: { owned: "unchanged" }, plugins: { owned: true } };
const op = { operationId: "credential-effect-test", requestDigest: "a".repeat(64) };
const providerScope = (baseUrl = initial.models.providers.local.baseUrl) => ({ backendId: "openclaw", providerKey: "local", baseUrl, api: "openai-completions" });
const permit = (baseUrl) => ({ version: 1, owner: { ownerId: "original-service-owner", capability: "b".repeat(64) }, scope: { ...providerScope(baseUrl), ...op },
  service: { instanceNonce: "c".repeat(48), pid: 12345, startedAt: Date.now() - 10000, protocolVersion: SERVICE_PROTOCOL_VERSION },
  writer: { version: 1, backendId: "openclaw", ...op, pid: 23456, startIdentity: "synthetic effect only", nonce: "d".repeat(64), generation: "generation-one",
    runtimeRoot: "/private/tmp/schema-runtime", runtimeTreeSha256: "e".repeat(64), dataRoot: "/private/tmp/schema-host-data", interpreterPath: "/private/tmp/external-node",
    entryPath: "/private/tmp/schema-runtime/openclaw.mjs", expiresAt: Date.now() + 120000 } });
const candidate = (p, action = "set") => ({ service: p.service, envelope: { version: 1, ...p.scope, action, bindingRevision: 1,
  credentialRevision: action === "clear" ? null : 1, ownerGeneration: "logical-owner-one", expiresAt: Date.now() + 20000,
  ...(action === "set" ? { apiKey: "synthetic-candidate-key" } : {}) } });
const previous = p => ({ service: p.service, envelope: { version: 1, ...p.scope, phase: "previous", previousScope: providerScope(), bindingRevision: 1,
  credentialRevision: 1, ownerGeneration: "logical-owner-one", expiresAt: Date.now() + 20000, apiKey: "synthetic-initial-key" } });
const providerSpec = patch => ({ kind: "update-provider", providerKey: "local", sourceModelId: null, sourceKey: null, targetKey: null, patch });
const modelSpec = { kind: "update", providerMode: "existing", providerKey: "local", sourceModelId: "old", sourceKey: JSON.stringify(["local", "old"]),
  targetKey: JSON.stringify(["local", "old"]), model: { id: "old", name: "Renamed" } };
function apply(before, after, safeSpec, p, response, phase = "candidate", old = previous(p), capturedInitial = initial) {
  return policy.applyCredentialPatch({ before, after, initial: capturedInitial, safeSpec, permit: p, phase, response, previousResponse: old });
}
const groups = [], changed = clone(initial); changed.models.providers.local.models[0].name = "Renamed";
assert.equal(policy.validateMetadataPatch(initial, changed, modelSpec, initial), "change");
assert.equal(changed.models.providers.local.apiKey, initial.models.providers.local.apiKey);
groups.push("pure existing model metadata preserves exact key/endpoint/API and remains on original model authority policy");
for (const change of [config => { config.models.providers.local.apiKey = "caller-key"; }, config => { delete config.models.providers.local.apiKey; },
  config => { config.models.providers.local.baseUrl = "https://exfil.example.test/v1"; }, config => { config.models.providers.local.api = "anthropic-messages"; },
  config => { delete config.models.providers.local; }]) { const value = clone(initial); change(value); assert.throws(() => policy.validateMetadataPatch(initial, value, providerSpec({}), initial)); }
const fresh = clone(initial); delete fresh.models.providers.local;
assert.throws(() => policy.validateMetadataPatch(fresh, initial, { ...modelSpec, kind: "create", providerMode: "new" }, fresh));
groups.push("metadata authority cannot clear/rotate/exfiltrate keys, change API or create/remove providers, including keyless endpoints");
assert.equal(policy.assertNoWireSecrets({ models: { providers: { local: { models: [] } } } }), true);
assert.equal(policy.assertNoWireSecrets({ models: { providers: { local: null } } }), true);
assert.throws(() => policy.assertNoWireSecrets({ models: { providers: { local: { apiKey: "guessed" } } } }), { code: "MANAGED_MODEL_PROVIDER_SECRET_IN_WIRE" });
assert.throws(() => policy.assertNoWireSecrets({ models: { providers: { foreign: { apiKey: "foreign" } } } }), { code: "MANAGED_MODEL_PROVIDER_SECRET_IN_WIRE" });
groups.push("no direct wire apiKey is accepted from Core or caller, even for another provider or a value guessed to equal Service");
const p = permit(), rotated = apply(initial, initial, providerSpec({}), p, candidate(p));
assert.equal(rotated.models.providers.local.apiKey, "synthetic-candidate-key"); assert.equal(initial.models.providers.local.apiKey, "synthetic-initial-key");
assert.equal(rotated.models.providers.foreign.apiKey, "synthetic-foreign-key"); assert.deepEqual(rotated.agents, initial.agents);
groups.push("candidate set injects only Service material after validation, preserving unrelated provider credentials and initial input bytes");
const endpoint = clone(initial); endpoint.models.providers.local.baseUrl = "https://new.example.test/v1";
const newPermit = permit(endpoint.models.providers.local.baseUrl);
assert.equal(apply(initial, endpoint, providerSpec({ baseUrl: endpoint.models.providers.local.baseUrl }), newPermit, candidate(newPermit)).models.providers.local.apiKey, "synthetic-candidate-key");
assert.throws(() => apply(initial, endpoint, providerSpec({ baseUrl: endpoint.models.providers.local.baseUrl }), p, candidate(p)), { code: "MANAGED_MODEL_PROVIDER_CREDENTIAL_UNBOUND" });
assert.throws(() => apply(initial, endpoint, providerSpec({ baseUrl: endpoint.models.providers.local.baseUrl }), newPermit, candidate(newPermit, "preserve")), { code: "MANAGED_MODEL_PROVIDER_CREDENTIAL_UNBOUND" });
groups.push("key transfer to a new canonical endpoint requires exact independently set/clear Service target; preserve never moves an existing key");
assert.equal(Object.hasOwn(apply(initial, initial, providerSpec({ clearApiKey: true }), p, candidate(p, "clear")).models.providers.local, "apiKey"), false);
const deleted = clone(initial); delete deleted.models.providers.local;
assert.equal(apply(initial, deleted, { kind: "delete-provider", providerKey: "local", sourceModelId: null, sourceKey: null, target: null }, p, candidate(p, "clear")).models.providers.local, undefined);
assert.throws(() => apply(initial, deleted, { kind: "delete-provider", providerKey: "local" }, p, candidate(p)), { code: "MANAGED_MODEL_PROVIDER_CREDENTIAL_UNBOUND" });
groups.push("explicit clear removes key or provider without synthetic sentinel; provider delete cannot consume a set permit");
assert.equal(apply(initial, changed, modelSpec, p, candidate(p, "preserve")).models.providers.local.apiKey, "synthetic-initial-key");
const missing = previous(p); missing.envelope.previousScope = null; missing.envelope.bindingRevision = 0; missing.envelope.credentialRevision = null; delete missing.envelope.apiKey;
assert.throws(() => apply(initial, changed, modelSpec, p, candidate(p, "preserve"), "candidate", missing), { code: "MANAGED_MODEL_PREVIOUS_CREDENTIAL_UNBOUND" });
groups.push("same-domain preserve requires original operation's exact previous key binding; local initial key alone grants no reuse");
assert.deepEqual(apply(rotated, initial, providerSpec({}), p, previous(p), "previous"), initial);
const wrongKey = previous(p); wrongKey.envelope.apiKey = "wrong-key";
const wrongDomain = previous(p); wrongDomain.envelope.previousScope.baseUrl = "https://foreign.example.test/v1";
for (const value of [missing, wrongKey, wrongDomain]) assert.throws(() => apply(rotated, initial, providerSpec({}), p, value, "previous"), { code: "MANAGED_MODEL_PREVIOUS_CREDENTIAL_UNBOUND" });
groups.push("compensation restores exact Service-authorized initial key/domain; missing or foreign history cannot copy initial key bytes");
const partialRestore = clone(initial); partialRestore.models.providers.local.models[0].name = "still-changed";
assert.throws(() => apply(rotated, partialRestore, providerSpec({}), p, previous(p), "previous"), { code: "MANAGED_MODEL_PREVIOUS_DOMAIN_UNBOUND" });
const authorityRestore = clone(initial); authorityRestore.agents.defaults.workspace = "/private/foreign";
assert.throws(() => apply(rotated, authorityRestore, providerSpec({}), p, previous(p), "previous"), { code: "MANAGED_MODEL_PREVIOUS_DOMAIN_UNBOUND" });
groups.push("previous phase must restore whole captured models/agents domain and cannot authorize partial restore or new Agent fields");
const initialNoKey = clone(initial); delete initialNoKey.models.providers.local.apiKey;
assert.deepEqual(apply(initialNoKey, initialNoKey, providerSpec({}), p, missing, "previous", undefined, initialNoKey), initialNoKey);
const oldNoKey = previous(p); oldNoKey.envelope.credentialRevision = null; delete oldNoKey.envelope.apiKey;
assert.deepEqual(apply(initialNoKey, initialNoKey, providerSpec({}), p, oldNoKey, "previous", undefined, initialNoKey), initialNoKey);
groups.push("keyless initial domain can be restored from missing or exact keyless previous binding, without inventing a secret");
const changedOther = clone(initial); changedOther.models.providers.foreign.apiKey = "changed-foreign-key";
assert.throws(() => apply(initial, changedOther, providerSpec({}), p, candidate(p)), { code: "MANAGED_MODEL_OTHER_PROVIDER_CHANGED" });
const changedOwned = clone(initial); changedOwned.gateway.owned = "changed";
assert.throws(() => apply(initial, changedOwned, providerSpec({}), p, candidate(p)), { code: "MANAGED_MODEL_OWNED_CONFIG_CHANGED" });
groups.push("valid credential material never broadens authority to unrelated provider keys or owned Gateway/Service configuration");
process.stdout.write(JSON.stringify({ status: "PASS", groups: groups.length, cases: groups, hostStarts: 0, serviceRequests: 0, configWrites: 0,
  boundary: "pure merged config/closed Service DTO effect policy only; physical Service/Writer admission and real secret writes remain separate" }) + "\n");
