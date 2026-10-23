#!/usr/bin/env node
"use strict";
// Actual Core/Base/scanners + real file-token IPC/Gate/Controller/encrypted store.
// Worker/pid/catalogue/finish are controlled doubles: no actual Host acceptance.
const assert = require("node:assert/strict"), crypto = require("node:crypto"), path = require("node:path");
const repo = process.env.SG_CREDENTIAL_CORE_REPO || path.resolve(__dirname, "..");
const { fixture: serviceFixture, scope: serviceScope, writer: makeWriter } = require("./plugin-managed-openclaw-provider-credential-broker-unit.cjs");
const { createManagedOpenClawModelApply, _credentialProtocol } = require(path.join(repo, "app/core/managed-openclaw-model-apply"));
const { createWorkAdmissionGate } = require(path.join(repo, "app/core/work-admission-gate"));
const { normalizeModelChangeRequest, modelChangeRequestDigest } = require(path.join(repo, "app/core/model-change-validation"));
const { credentialPermit } = require(path.join(repo, "app/managed-openclaw-provider-credential-schema"));
const credentialEffect = require(path.join(repo, "app/managed-openclaw-provider-credential-policy"));
const tests = [], test = (name, fn) => tests.push({ name, fn });
const clone = value => JSON.parse(JSON.stringify(value));
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function merge(target, patch) { for (const [key, value] of Object.entries(patch)) {
  if (value === null) delete target[key]; else if (value && typeof value === "object" && !Array.isArray(value)) {
    if (!target[key] || typeof target[key] !== "object") target[key] = {}; merge(target[key], value);
  } else target[key] = clone(value);
} }
const createSpec = extra => normalizeModelChangeRequest({ providerKey: "unit-provider", model: { id: "added", name: "Added" }, ...extra }).safeSpec;
const updateProvider = patch => ({ kind: "update-provider", providerKey: "unit-provider", patch });
async function coreFixture(options = {}) {
  const f = await serviceFixture(options.native === true), config = options.config || { models: { providers: { "unit-provider": {
    baseUrl: serviceScope("ignored").baseUrl, api: "openai-completions", models: [] } } }, agents: { defaults: {} } };
  const gate = createWorkAdmissionGate(), events = [], brands = new WeakSet(), identities = new WeakMap(), leases = [];
  const hash = () => sha(JSON.stringify(config)); let owned = 0;
  const projectedHash = () => "hmac-sha256:v1:" + crypto.createHmac("sha256", Buffer.alloc(32, 13))
    .update(JSON.stringify(["openclaw.gateway.config-revision.raw.v1", hash()])).digest("base64url");
  const getConfig = (privateRead = false) => ({ hash: options.projectedRevision && !privateRead ? projectedHash() : hash(),
    raw: JSON.stringify(config), config: clone(config), parsed: clone(config),
    ...(options.projectedRevision && privateRead && !options.missingRevisionSource ? { managedConfigSource: { version: 1, persistedRawHash: hash(),
      loadedRawHash: hash(), loaded: true, loadedProjectedHash: projectedHash(), ...options.revisionSourcePatch } } : {}) });
  const ordinaryRpc = async (method, params) => {
    if (method === "config.get") return getConfig();
    if (method === "models.list") return { models: Object.entries(config.models.providers).flatMap(([provider, row]) => row.models.map(model => ({ ...clone(model), provider }))) };
    if (method === "sessions.list") return { sessions: [], hasMore: false };
    if (method === "cron.list") return { jobs: [], hasMore: false };
    if (method === "tasks.list") return { supported: true, tasks: [], hasMore: false };
    throw new Error("controlled private method unsupported");
  };
  const backend = { async request(method, params) { events.push({ kind: "ordinary", method }); assert.notEqual(method, "config.patch"); return ordinaryRpc(method, params); } };
  const modelController = { ...f.modelController,
    captureModelOwner: () => f.ownerBrand,
    async isModelApplySupported() { return f.state.product; },
    async getModelReferenceCapabilities() { return {}; },
    async assertModelLease(lease, identity) { return brands.has(lease) && !lease.retired && identities.get(lease).operationId === identity.operationId
      && identities.get(lease).requestDigest === identity.requestDigest; },
    async acquireModelLease(input) {
      const before = clone(config); events.push({ kind: "acquire", identity: { operationId: input.operationId, requestDigest: input.requestDigest }, safeSpec: input.safeSpec });
      if (options.onAcquire) await options.onAcquire(input);
      f.state.finished = false; let expiresAt = Date.now() + (options.ttlMs || 90000), permit = null, generation = 1;
      const state = { paused: true, retired: false, writeCount: 0, finishCount: 0, restartCount: 0, settlementCount: 0 };
      const physical = () => makeWriter(input, { pid: 43210 + owned, startIdentity: "controlled owner " + owned, nonce: sha(input.operationId + ":" + owned),
        generation: "controlled-generation-" + owned, expiresAt });
      owned++; f.state.writers.set(input.operationId, physical());
      const lease = {
        get expiresAt() { return expiresAt; }, get retired() { return state.retired; },
        async assertIdle() { return state.paused; },
        async getCredentialOwner() { assert(!state.retired); events.push({ kind: "owner", generation }); return f.state.writers.get(input.operationId); },
        async bindCredentialPermit(raw) { const captured = credentialPermit(raw); assert.deepEqual(captured.writer, f.state.writers.get(input.operationId));
          assert.equal(captured.scope.operationId, input.operationId); assert.equal(captured.scope.requestDigest, input.requestDigest);
          permit = captured; events.push({ kind: "bind", generation, capability: sha(captured.owner.capability) }); return true; },
        async modelRpc(method, params, privateOptions) {
          assert(!state.retired); if (input.signal?.aborted) throw Object.assign(new Error("controlled canceled"), { code: "CONTROLLED_CANCELED" });
          if (method === "config.get") return getConfig(true);
          if (options.native && method === "config.set") {
            assert.equal(params.baseHash, hash());
            if (options.nativeRejected) return { ok: false, noWrite: true, code: "config_rejected" };
            const after = require("../app/managed-openclaw-model-policy").validateNativeDraft(config, JSON.parse(params.raw), input.safeSpec);
            for (const key of Object.keys(config)) delete config[key]; Object.assign(config, after);
            events.push({ kind: "native-config", method }); state.writeCount++;
            return { ok: true, hash: hash(), restartRequired: true };
          }
          if (options.native && ["models.authSetApiKey", "models.authLogout"].includes(method)) {
            assert.deepEqual(Object.keys(params).sort(), ["agentId", ...(params.credentialScope ? ["credentialScope"] : []), "provider"]);
            assert.equal(params.credentialScope, input.safeSpec.credentialScope);
            assert(permit); const receipt = await f.call("lease.read", { scope: permit.scope, owner: permit.owner, writer: permit.writer });
            const clearing = method === "models.authLogout";
            assert.equal(receipt.envelope.action, clearing ? "clear" : "set");
            if (!clearing) assert.equal(typeof receipt.envelope.apiKey, "string");
            const connection = config.models?.providers?.[params.provider], profileId = params.provider + ":manual";
            const official = async (method, args) => {
              events.push({ kind: "native-auth", method, provider: args.provider, agentId: args.agentId });
              if (options.nativeAuthLost || options.nativeAuthPartial && args.agentId === "other") throw Error("controlled lost official auth response");
              if (clearing) assert.equal(args.credentialType, "api_key");
              else assert.equal(args.apiKey, receipt.envelope.apiKey);
              if (connection) { if (clearing) delete connection.apiKey; else connection.apiKey = profileId; }
              state.writeCount++;
              return clearing ? { provider: args.provider, removedProfiles: [profileId] } : { provider: args.provider, profileId };
            };
            if (params.credentialScope === "provider") return require("../app/openclaw-provider-credential-operation").applyProviderCredentialOperation({
              request: official, provider: params.provider,
              agentIds: require("../app/managed-openclaw-auth-profile-scope").nativeAuthAgentIds(before),
              configuredConnection: Boolean(connection), clear: clearing, apiKey: receipt.envelope.apiKey,
            });
            return official(method, { ...params, ...(clearing ? { credentialType: "api_key" } : { apiKey: receipt.envelope.apiKey }) });
          }
          if (method !== "config.patch") return ordinaryRpc(method, params);
          if (options.beforePatch) await options.beforePatch();
          if (input.signal?.aborted) throw Object.assign(new Error("controlled canceled"), { code: "CONTROLLED_CANCELED" });
          assert.equal(params.baseHash, hash()); const patch = JSON.parse(params.raw);
          credentialEffect.assertNoWireSecrets(patch);
          events.push({ kind: "patch", raw: params.raw, phase: privateOptions?.credentialPhase || null });
          let after = clone(config); merge(after, patch);
          if (permit) {
            assert.deepEqual(privateOptions, { credentialPhase: privateOptions.credentialPhase });
            const phase = privateOptions.credentialPhase;
            const read = await f.call("lease.read", { scope: permit.scope, owner: permit.owner, writer: permit.writer, phase });
            assert.deepEqual(read.service, permit.service);
            after = credentialEffect.applyCredentialPatch({ before: config, after, initial: before, safeSpec: input.safeSpec,
              permit, phase, response: read });
            await f.call("lease.assert", { scope: permit.scope, owner: permit.owner, writer: permit.writer, phase });
          } else { assert.equal(privateOptions, undefined); credentialEffect.validateMetadataPatch(config, after, input.safeSpec, before); }
          for (const key of Object.keys(config)) delete config[key]; Object.assign(config, after);
          state.writeCount++; return options.badPatchReply
            ? { ok: true, hash: hash(), restartRequired: "true" } : { ok: true, hash: hash(), restartRequired: true };
        },
        async renew() { expiresAt = Date.now() + (options.ttlMs || 90000); f.state.writers.set(input.operationId, { ...f.state.writers.get(input.operationId), expiresAt });
          events.push({ kind: "raw-renew" }); return { expiresAt }; },
        async restartPaused() { assert(state.paused); generation++; owned++; state.restartCount++;
          f.state.writers.set(input.operationId, physical()); permit = null; events.push({ kind: "restart", generation }); return true; },
        async waitHealthy() { return state.paused; },
        async verifyTarget(spec) { if (options.verifyFalse) return false;
          if (options.native) return require("../app/managed-openclaw-model-policy").nativeTargetMatches(config, spec, before);
          const target = config.models.providers[spec.providerKey]?.models.find(row => row.id === spec.model?.id);
          return !!target && Object.entries(spec.model || {}).every(([key, value]) => target[key] === value); },
        async convergeAfterRetire() { return true; },
        async finish(result) {
          state.finishCount++; state.originalTerminalOutcome = result.outcome; assert(state.paused); assert.deepEqual(result.safeSpec, input.safeSpec); assert.equal(result.operationId, input.operationId);
          if (result.outcome === "compensated") assert.deepEqual(config, before, "previous private phase restores exact config, including credential");
          if (permit) {
            // Controlled Worker follows production contract: current paused
            // assertion, known resume, once-only settle, then exact success.
            const phase = options.native && result.outcome === "blocked" ? "previous" : events.filter(row => row.kind === "patch").at(-1)?.phase || "candidate";
            if (phase === "previous") await f.call("lease.read", { scope: permit.scope, owner: permit.owner, writer: permit.writer, phase });
            await f.call("lease.assert", { scope: permit.scope, owner: permit.owner, writer: permit.writer, phase });
            state.paused = false; f.state.finished = true; state.settlementCount++;
            const receipt = await f.call("lease.settle", { scope: permit.scope, owner: permit.owner, writer: permit.writer, outcome: result.outcome });
            assert.deepEqual(receipt.service, permit.service); assert.equal(receipt.envelope.state, result.outcome);
            if (options.settleLostAck) { state.paused = true;
              if (options.enableTerminalRecovery) { state.retired = true; f.state.finished = false; }
              return false;
            }
            if (options.afterWorkerSettle) options.afterWorkerSettle(f);
          } else state.paused = false;
          state.retired = true; events.push({ kind: "worker-finished", outcome: result.outcome }); return true;
        },
        async abandon() { state.paused = true; state.retired = true; events.push({ kind: "abandon" }); return true; },
      };
      brands.add(lease); identities.set(lease, input); leases.push({ lease, state, input }); return lease;
    },
  };
  if (options.enableTerminalRecovery) {
    const original = identity => leases.find(row => row.input.operationId === identity.operationId
      && row.input.requestDigest === identity.requestDigest && row.state.originalTerminalOutcome);
    modelController.canRecoverCredentialTerminal = identity => !!original(identity);
    modelController.recoverCredentialTerminal = async identity => {
      const row = original(identity); assert(row); events.push({ kind: "terminal-recovery", identity: clone(identity) });
      if (options.recoveryInvalid) return { outcome: row.state.originalTerminalOutcome, paused: false, resumed: true };
      row.state.paused = false; f.state.finished = true;
      return { outcome: options.recoveryWrongOutcome || row.state.originalTerminalOutcome, paused: false, resumed: true, healthVerified: true };
    };
  }
  const adapter = createManagedOpenClawModelApply({ backend, modelController, admissionGate: gate, credentialBroker: f.broker,
    ...(options.native ? { configurationMode: "native-config" } : {}) });
  const context = async (spec, id, entry) => {
    const preview = await adapter.preview(spec), journal = [];
    return { operationId: id, requestDigest: entry?.requestDigest || modelChangeRequestDigest(spec), journal,
      journalEntry: entry || { fingerprints: preview.fingerprints, commitState: "precommit", ...(options.native ? { mode: "native-config", stage: "preflight" } : {}), ...(options.pendingSecret ? { secretStep: "pending" } : {}) },
      providerLeaseSignal: f.signal.signal, assertProviderLease() { if (!f.state.provider || f.signal.signal.aborted) throw new Error("controlled provider retired"); },
      async recordStage(stage, data) { journal.push({ stage, data }); if (options.onStage) await options.onStage(stage, data); },
      async recordStep() {}, async markCommitting(data) { journal.push({ stage: "committing", data }); },
      async markCommitted(data) { journal.push({ stage: "committed", data }); },
    };
  };
  return { ...f, config, events, modelController, adapter, context, leases, gate, hash };
}
async function seed(f, id = "seed-prior-key") { const p = await f.prepare(serviceScope(id)); await f.read(p); await f.finish(p); }

test("native auth-only builtin Key has one selected Agent and no invented endpoint or model", async () => {
  const f = await coreFixture({ native: true, config: { models: { providers: {} }, agents: { entries: { main: {}, other: {} } } } });
  try {
    const spec = { kind: "update-provider", providerKey: "builtin", agentId: "other", patch: {} };
    const ctx = await f.context(spec, "native-builtin-key");
    const result = await f.adapter.apply(spec, ctx, { apiKey: "synthetic-native-builtin-key" });
    assert.equal(result.status, "applied");
    assert.deepEqual(f.config.models.providers, {});
    assert.deepEqual(f.events.filter(row => row.kind === "native-auth").map(row => row.agentId), ["other"]);
    assert.equal(f.events.some(row => row.kind === "native-config" || row.kind === "patch"), false);
    assert.equal(f.gate.snapshot("openclaw").draining, false);
    assert.equal(f.leases[0].state.settlementCount, 1);
  } finally { await f.close(); }
});

test("native scoped Key survives endpoint edit; explicit clear uses native logout without deleting connection", async () => {
  const f = await coreFixture({ native: true });
  try {
    const spec = updateProvider({}), ctx = await f.context(spec, "native-custom-key");
    assert.equal((await f.adapter.apply(spec, ctx, { apiKey: "synthetic-native-custom-key" })).status, "applied");
    const update = updateProvider({ baseUrl: "https://changed.invalid/v1" });
    assert.equal((await f.adapter.apply(update, await f.context(update, "native-endpoint-only"))).status, "applied");
    assert.equal(f.config.models.providers["unit-provider"].apiKey, "unit-provider:manual");
    const clear = updateProvider({ clearApiKey: true });
    assert.equal((await f.adapter.apply(clear, await f.context(clear, "native-clear"))).status, "applied");
    assert.equal(f.config.models.providers["unit-provider"].baseUrl, "https://changed.invalid/v1");
    assert.equal(Object.hasOwn(f.config.models.providers["unit-provider"], "apiKey"), false);
    assert.equal(f.events.filter(row => row.kind === "native-auth").length, 2);
  } finally { await f.close(); }
});

test("unified native builtin Key keeps one encrypted operation and covers the acquired roster", async () => {
  const f = await coreFixture({ native: true, config: { models: { providers: {} }, agents: { entries: { other: {}, main: {}, third: {} } } } });
  try {
    const spec = { kind: "update-provider", providerKey: "builtin", credentialScope: "provider", patch: {} };
    const result = await f.adapter.apply(spec, await f.context(spec, "native-unified-builtin"), { apiKey: "synthetic-unified-key" });
    assert.equal(result.status, "applied");
    assert.deepEqual(f.events.filter(row => row.kind === "native-auth").map(row => row.agentId), ["main", "other", "third"]);
    assert.equal(f.leases.length, 1);
    assert.equal(f.leases[0].state.settlementCount, 1);
    assert.equal(f.gate.snapshot("openclaw").draining, false);
    assert.deepEqual(f.config.models.providers, {});
    assert.equal(JSON.stringify(f.events).includes("synthetic-unified-key"), false);
  } finally { await f.close(); }
});

test("unified native custom Key is shared once; clear still visits all acquired Agents", async () => {
  const f = await coreFixture({ native: true });
  f.config.agents.entries = { main: {}, other: {} };
  try {
    const spec = { ...updateProvider({}), credentialScope: "provider" };
    assert.equal((await f.adapter.apply(spec, await f.context(spec, "native-unified-custom"), { apiKey: "synthetic-shared-key" })).status, "applied");
    assert.deepEqual(f.events.filter(row => row.kind === "native-auth").map(row => row.agentId), ["main"]);
    const clear = { ...updateProvider({ clearApiKey: true }), credentialScope: "provider" };
    assert.equal((await f.adapter.apply(clear, await f.context(clear, "native-unified-clear"))).status, "applied");
    assert.deepEqual(f.events.filter(row => row.kind === "native-auth" && row.method === "models.authLogout").map(row => row.agentId), ["main", "other"]);
    assert.equal(f.config.models.providers["unit-provider"].apiKey, undefined);
    assert.equal(f.gate.snapshot("openclaw").draining, false);
  } finally { await f.close(); }
});

test("partial unified native credentials keep the owning Worker paused without a false successful settlement", async () => {
  const f = await coreFixture({ native: true, nativeAuthPartial: true,
    config: { models: { providers: {} }, agents: { entries: { main: {}, other: {}, third: {} } } } });
  try {
    const spec = { kind: "update-provider", providerKey: "builtin", credentialScope: "provider", patch: {} };
    const result = await f.adapter.apply(spec, await f.context(spec, "native-unified-partial"), { apiKey: "synthetic-partial-key" });
    assert.equal(result.status, "partial");
    assert.equal(result.code, "provider_credentials_incomplete");
    assert.deepEqual(f.events.filter(row => row.kind === "native-auth").map(row => row.agentId), ["main", "other"]);
    assert.equal(f.leases[0].state.settlementCount, 0);
    assert.equal(f.leases[0].state.paused, true);
    assert.equal(f.events.some(row => row.kind === "worker-finished"), false);
    assert.equal(f.events.some(row => row.kind === "abandon"), true);
  } finally { await f.close(); }
});

test("native rejected config settles exact no-write credentials and reopens admission", async () => {
  const f = await coreFixture({ native: true, nativeRejected: true });
  try {
    const spec = createSpec(), before = clone(f.config);
    const result = await f.adapter.apply(spec, await f.context(spec, "native-invalid-config"), { apiKey: "synthetic-rejected-key" });
    assert.equal(result.status, "failed");
    assert.deepEqual(f.config, before);
    assert.equal(f.events.some(row => row.kind === "native-auth"), false);
    assert.equal(f.gate.snapshot("openclaw").draining, false);
    assert.equal(f.leases[0].state.originalTerminalOutcome, "blocked");
  } finally { await f.close(); }
});

 test("config projection removes provider key from raw/config/parsed while preserving actual hash and original source", async () => {
  const source = { hash: "true-source-hash", raw: '{"apiKey":"do-not-keep"}', parsed: { models: { providers: { p: { apiKey: "private-static-canary", models: [] } } } },
    config: { models: { providers: { p: { apiKey: "private-static-canary", api: "openai-completions" } } } } };
  const projected = _credentialProtocol.projectConfigResponse(source);
  assert.equal(projected.hash, source.hash); assert.equal(JSON.stringify(projected).includes("private-static-canary"), false);
  assert.equal(projected.raw.includes("apiKey"), false); assert.equal(source.parsed.models.providers.p.apiKey, "private-static-canary");
});

test("actual acquired scope derivation distinguishes metadata, explicit domain intent and unsupported clearBaseUrl", async () => {
  const snapshot = { parsed: { models: { providers: { "unit-provider": { baseUrl: serviceScope("ignored").baseUrl, api: "openai-completions" } } } } };
  const identity = { operationId: "derive-only", requestDigest: sha("derive-only") };
  assert.equal(_credentialProtocol.deriveCredentialPlan(createSpec(), snapshot, identity, false), null);
  assert.throws(() => _credentialProtocol.deriveCredentialPlan(updateProvider({ baseUrl: "https://new.example.invalid/v1" }), snapshot, identity, false), { code: "managed_credential_domain_change_requires_intent" });
  const plan = _credentialProtocol.deriveCredentialPlan(updateProvider({ baseUrl: "https://new.example.invalid/v1", clearApiKey: true }), snapshot, identity, false);
  assert.equal(plan.action, "clear"); assert.equal(plan.scope.baseUrl, "https://new.example.invalid/v1");
  assert.throws(() => _credentialProtocol.deriveCredentialPlan(updateProvider({ clearBaseUrl: true, clearApiKey: true }), snapshot, identity, false), { code: "managed_credential_clear_base_url_unsupported" });
  const implicit = { parsed: { models: { providers: { "unit-provider": { baseUrl: serviceScope("ignored").baseUrl } } } } };
  assert.equal(_credentialProtocol.deriveCredentialPlan(updateProvider({}), implicit, identity, true).scope.api, "openai-completions");
  // A raw protocol field edit retains the separate explicit credential-intent boundary.
  assert.throws(() => _credentialProtocol.deriveCredentialPlan(updateProvider({ api: "openai-completions" }), implicit, identity, false), { code: "managed_credential_domain_change_requires_intent" });
});

test("clear deletion projects wire only with a bound clear candidate; metadata/foreign/previous null stays forbidden", async () => {
  const params = { raw: JSON.stringify({ models: { providers: { local: { apiKey: null } } } }), baseHash: "a".repeat(64), replacePaths: [] };
  const bound = { safeSpec: { providerKey: "local" }, credentialPlan: { action: "clear" }, credentialPermit: { scope: { providerKey: "local" } } };
  const projected = _credentialProtocol.projectCredentialPatch(params, bound, "candidate");
  assert.equal(credentialEffect.assertNoWireSecrets(JSON.parse(projected.raw)), true);
  assert.equal(Object.hasOwn(JSON.parse(projected.raw).models.providers.local, "apiKey"), false);
  for (const value of [{ ...bound, credentialPermit: null }, { ...bound, credentialPlan: { action: "set" } },
    { ...bound, safeSpec: { providerKey: "foreign" } }]) assert.throws(() => _credentialProtocol.projectCredentialPatch(params, value, "candidate"), { code: "managed_credential_main_key_forbidden" });
  assert.throws(() => _credentialProtocol.projectCredentialPatch(params, bound, "previous"), { code: "managed_credential_main_key_forbidden" });
  assert.throws(() => credentialEffect.assertNoWireSecrets(JSON.parse(params.raw)), { code: "MANAGED_MODEL_PROVIDER_SECRET_IN_WIRE" });
});

test("metadata-only actual Base/scanners send no provider key and do not mint Service authority from static config key", async () => {
  const f = await coreFixture(); try {
    f.config.models.providers["unit-provider"].apiKey = "unmanaged-static-key";
    const spec = createSpec(), ctx = await f.context(spec, "metadata-only"); assert.equal((await f.adapter.apply(spec, ctx)).status, "applied");
    assert.equal(f.state.requests.length, 0); assert.equal(f.config.models.providers["unit-provider"].apiKey, "unmanaged-static-key");
    assert.equal(JSON.stringify(f.events).includes("unmanaged-static-key"), false);
  } finally { await f.close(); }
});

test("set intent bypasses pending-secret check without a sentinel; capture and Worker-only read keep Base/journal free of key", async () => {
  const entered = deferred(), resume = deferred();
  const f = await coreFixture({ pendingSecret: true, onAcquire: async () => { entered.resolve(); await resume.promise; } }); try {
    const spec = createSpec({ providerKey: "new-provider", providerMode: "new", baseUrl: "https://new-provider.example.invalid/v1" });
    const ctx = await f.context(spec, "new-key-set"), secret = { apiKey: "captured-original-key" };
    const pending = f.adapter.apply(spec, ctx, secret); await entered.promise; secret.apiKey = "mutated-late-key"; resume.resolve();
    const result = await pending; assert.equal(result.status, "applied");
    assert.equal(f.config.models.providers["new-provider"].apiKey, "captured-original-key");
    assert(ctx.journal.some(row => row.data?.secretStep === "applied"));
    assert.equal(JSON.stringify({ events: f.events, journal: ctx.journal }).includes("captured-original-key"), false);
    assert.equal(f.state.requests.some(row => row.method === "lease.settle"), false, "Main never settles Worker transaction");
    assert.deepEqual(f.state.requests.slice(-4).map(row => row.method), ["service.status", "observe", "service.status", "owner.close"]);
  } finally { resume.resolve(); await f.close(); }
});

test("rotation is applied by controlled Worker and finish uses explicit restart→advance→bind before terminal observe", async () => {
  const f = await coreFixture(); try {
    await seed(f); f.config.models.providers["unit-provider"].apiKey = "synthetic-test-key-1";
    const spec = updateProvider({}), ctx = await f.context(spec, "rotate-core");
    assert.equal((await f.adapter.apply(spec, ctx, { apiKey: "core-rotated-key" })).status, "applied");
    assert.equal(f.config.models.providers["unit-provider"].apiKey, "core-rotated-key");
    assert.equal(f.leases[0].state.restartCount, 1); assert.equal(f.leases[0].state.settlementCount, 1);
    const sequence = f.events.map(row => row.kind); assert(sequence.indexOf("restart") < sequence.lastIndexOf("bind"));
    assert.equal(f.state.requests.filter(row => row.method === "owner.advance").length, 1);
  } finally { await f.close(); }
});

test("existing provider without api uses the exact runtime default for real set and clear transactions", async () => {
  const f = await coreFixture(); try {
    delete f.config.models.providers["unit-provider"].api;
    const spec = updateProvider({}), ctx = await f.context(spec, "implicit-api-set");
    assert.equal((await f.adapter.apply(spec, ctx, { apiKey: "implicit-api-owned-key" })).status, "applied");
    assert.equal(f.config.models.providers["unit-provider"].apiKey, "implicit-api-owned-key");
    const prepared = f.state.requests.filter(row => row.method === "prepare");
    assert.equal(prepared.length, 1);
    assert.equal((await f.broker.observe({ ...serviceScope(ctx.operationId), requestDigest: ctx.requestDigest }, f.contextFor(f.broker))).state, "applied");
    const clear = updateProvider({ clearApiKey: true }), clearCtx = await f.context(clear, "implicit-api-clear");
    assert.equal((await f.adapter.apply(clear, clearCtx)).status, "applied");
    assert.equal(Object.hasOwn(f.config.models.providers["unit-provider"], "apiKey"), false);
    assert.equal(f.leases.reduce((total, row) => total + row.state.settlementCount, 0), 2);
    assert.equal((await f.broker.observe({ ...serviceScope(clearCtx.operationId), requestDigest: clearCtx.requestDigest }, f.contextFor(f.broker))).state, "applied");
  } finally { await f.close(); }
});

test("clearApiKey stage patch sends an explicit null and clears config plus the Service binding", async () => {
  const f = await coreFixture(); try {
    await seed(f); f.config.models.providers["unit-provider"].apiKey = "synthetic-test-key-1";
    const spec = updateProvider({ clearApiKey: true }), ctx = await f.context(spec, "clear-core");
    assert.equal((await f.adapter.apply(spec, ctx)).status, "applied");
    assert.equal(Object.hasOwn(f.config.models.providers["unit-provider"], "apiKey"), false);
    assert.equal(Object.hasOwn(JSON.parse(f.events.find(row => row.kind === "patch").raw).models.providers["unit-provider"], "apiKey"), false);
    assert.equal((await f.broker.status(serviceScope("query-clear"), f.contextFor(f.broker))).hasSecret, false);
  } finally { await f.close(); }
});

test("domain update with set then exact previous-phase compensation restores old endpoint and key", async () => {
  const f = await coreFixture({ onStage(stage) { if (stage === "stage-target") throw Object.assign(new Error("controlled post-stage failure"), { code: "CONTROLLED_STAGE_FAILURE" }); } }); try {
    await seed(f); f.config.models.providers["unit-provider"].apiKey = "synthetic-test-key-1"; const before = clone(f.config);
    const spec = updateProvider({ baseUrl: "https://moved.example.invalid/v1", api: "openai-responses" }), ctx = await f.context(spec, "move-compensate");
    assert.equal((await f.adapter.apply(spec, ctx, { apiKey: "new-domain-key" })).status, "compensated");
    assert.deepEqual(f.config, before); assert.deepEqual(f.events.filter(row => row.kind === "patch").map(row => row.phase), ["candidate", "previous"]);
    const planScope = { ...serviceScope("move-compensate"), baseUrl: "https://moved.example.invalid/v1", api: "openai-responses", requestDigest: ctx.requestDigest };
    assert.equal((await f.broker.observe(planScope, f.contextFor(f.broker))).state, "compensated");
  } finally { await f.close(); }
});

test("new provider target failure removes staged key through previous phase then restores actual loaded writer before finish", async () => {
  const f = await coreFixture({ verifyFalse: true }); try {
    const spec = createSpec({ providerKey: "failed-provider", providerMode: "new", baseUrl: "https://new.example.invalid/v1" });
    const ctx = await f.context(spec, "new-compensate"); assert.equal((await f.adapter.apply(spec, ctx, { apiKey: "new-ephemeral-key" })).status, "compensated");
    assert.equal(Object.hasOwn(f.config.models.providers, "failed-provider"), false);
    assert.equal(f.leases[0].state.restartCount, 2); assert.equal(f.leases[0].state.finishCount, 1);
    assert.equal(f.state.requests.filter(row => row.method === "owner.advance").length, 2);
  } finally { await f.close(); }
});

test("new provider without key uses a real clear/no-key operation rather than static config authority", async () => {
  const f = await coreFixture(); try {
    const spec = createSpec({ providerKey: "no-key-provider", providerMode: "new", baseUrl: "https://no-key.example.invalid/v1" });
    const ctx = await f.context(spec, "create-no-key"); assert.equal((await f.adapter.apply(spec, ctx)).status, "applied");
    assert.equal(Object.hasOwn(f.config.models.providers["no-key-provider"], "apiKey"), false);
    assert.equal(f.state.requests.filter(row => row.method === "prepare").length, 1);
    assert.equal(f.state.encrypts, 0); assert.equal(f.leases[0].state.settlementCount, 1);
  } finally { await f.close(); }
});

test("provider deletion first consumes exact clear transaction and leaves no Service key binding", async () => {
  const f = await coreFixture(); try {
    await seed(f); f.config.models.providers["unit-provider"].apiKey = "synthetic-test-key-1";
    const spec = { kind: "delete-provider", providerKey: "unit-provider", sourceModelId: null };
    const ctx = await f.context(spec, "delete-provider-core"); assert.equal((await f.adapter.apply(spec, ctx)).status, "applied");
    assert.equal(Object.hasOwn(f.config.models.providers, "unit-provider"), false);
    assert.equal(f.leases[0].state.settlementCount, 1);
    assert.equal((await f.broker.status(serviceScope("deleted-status"), f.contextFor(f.broker))).hasSecret, false);
  } finally { await f.close(); }
});

test("bad private write receipt cannot mark secret applied, compensate speculatively or resume", async () => {
  const f = await coreFixture({ badPatchReply: true }); try {
    const spec = updateProvider({}), ctx = await f.context(spec, "bad-private-receipt");
    const result = await f.adapter.apply(spec, ctx, { apiKey: "unverified-written-key" }); assert.equal(result.status, "partial");
    assert.equal(f.leases[0].state.writeCount, 1); assert.equal(f.leases[0].state.finishCount, 0);
    assert.equal(f.leases[0].state.paused, true); assert.equal(ctx.journal.some(row => row.data?.secretStep === "applied"), false);
    assert.equal(f.events.filter(row => row.kind === "patch").length, 1);
    assert.equal(f.state.requests.some(row => row.method === "owner.close"), false);
  } finally { await f.close(); }
});

test("retired opaque product owner during metadata await blocks all late writes even without credential preparation", async () => {
  const entered = deferred(), resume = deferred(); const f = await coreFixture({ onStage: async stage => { if (stage === "preflight") { entered.resolve(); await resume.promise; } } }); try {
    const spec = createSpec(), ctx = await f.context(spec, "retired-metadata-owner"); const pending = f.adapter.apply(spec, ctx);
    await entered.promise; f.state.product = false; resume.resolve(); assert.equal((await pending).status, "partial");
    assert.equal(f.events.some(row => row.kind === "patch"), false); assert.equal(f.state.requests.length, 0);
  } finally { resume.resolve(); await f.close(); }
});

test("cancel during acquisition produces zero Service prepare/mint and zero private config writes", async () => {
  const entered = deferred(), resume = deferred(); const f = await coreFixture({ onAcquire: async () => { entered.resolve(); await resume.promise; } }); try {
    const spec = updateProvider({}), ctx = await f.context(spec, "cancel-acquire"); const pending = f.adapter.apply(spec, ctx, { apiKey: "never-published-key" });
    await entered.promise; f.signal.abort(); resume.resolve(); assert.equal((await pending).status, "partial");
    assert.equal(f.state.requests.length, 0); assert.equal(f.events.some(row => row.kind === "patch"), false);
  } finally { resume.resolve(); await f.close(); }
});

test("lost prepare ACK retains original exact operation; explicit recovery only observes and does not reacquire/remint", async () => {
  const f = await coreFixture(); try {
    const spec = updateProvider({}), id = "unknown-prepare-core", ctx = await f.context(spec, id); f.state.drop = "prepare";
    assert.equal((await f.adapter.apply(spec, ctx, { apiKey: "unknown-prepared-key" })).status, "partial");
    const entry = { operationId: id, requestDigest: ctx.requestDigest, kind: "update-provider", providerKey: "unit-provider", commitState: "precommit", secretStep: "pending" };
    const restored = await f.adapter.recover(entry, await f.context(spec, id, entry)); assert.equal(restored.status, "partial"); assert.equal(restored.needsVerification, true);
    assert.equal(f.state.requests.filter(row => row.method === "prepare").length, 1); assert.equal(f.state.requests.some(row => row.method === "owner.open"), false);
    assert.equal(f.events.filter(row => row.kind === "acquire").length, 1); assert.equal(f.events.some(row => row.kind === "patch"), false);
  } finally { await f.close(); }
});

test("Worker settle ACK unknown stays paused and Main never repeats settle or closes the uncertain owner", async () => {
  const f = await coreFixture({ settleLostAck: true }); try {
    const spec = updateProvider({}), ctx = await f.context(spec, "unknown-worker-settle");
    const result = await f.adapter.apply(spec, ctx, { apiKey: "once-only-worker-key" }); assert.equal(result.status, "cleanup_pending");
    assert.equal(f.leases[0].state.paused, true); assert.equal(f.leases[0].state.settlementCount, 1);
    assert.equal(f.state.requests.some(row => ["lease.settle", "owner.close"].includes(row.method)), false);
    const observer = f.broker.createContext({ modelOwner: f.ownerBrand, assertProviderLease() {} });
    assert.equal((await f.broker.observeRetainedOperation({ operationId: ctx.operationId, requestDigest: ctx.requestDigest }, observer)).state, "applied");
  } finally { await f.close(); }
});

test("Service incarnation change after Worker finish keeps Core admission held and forbids late owner close", async () => {
  const f = await coreFixture({ afterWorkerSettle(value) { value.service.instanceNonce = "f".repeat(48); } }); try {
    const spec = updateProvider({}), ctx = await f.context(spec, "terminal-service-change");
    const result = await f.adapter.apply(spec, ctx, { apiKey: "guarded-terminal-key" }); assert.equal(result.status, "cleanup_pending");
    assert.equal(f.gate.snapshot("openclaw").draining, true); assert.equal(f.state.requests.some(row => row.method === "owner.close"), false);
  } finally { await f.close(); }
});

test("heartbeat performs raw renew then verified Service renew and rebind without a second secret prepare", async () => {
  const f = await coreFixture({ ttlMs: 700, onStage: async stage => { if (stage === "preflight") await new Promise(resolve => setTimeout(resolve, 550)); } }); try {
    const spec = updateProvider({}), ctx = await f.context(spec, "renew-core");
    assert.equal((await f.adapter.apply(spec, ctx, { apiKey: "renew-held-key" })).status, "applied");
    assert(f.events.filter(row => row.kind === "raw-renew").length >= 1);
    assert.equal(f.state.requests.filter(row => row.method === "prepare").length, 1);
    assert.equal(f.state.requests.filter(row => row.method === "owner.renew").length, f.events.filter(row => row.kind === "raw-renew").length);
  } finally { await f.close(); }
});

test("explicit terminal recovery converges original Core hold through actual Main/Service observation without acquire/config/settle replay", async () => {
  const f = await coreFixture({ settleLostAck: true, enableTerminalRecovery: true }); try {
    const spec = updateProvider({}), id = "original-terminal-recovery-core", ctx = await f.context(spec, id);
    assert.equal((await f.adapter.apply(spec, ctx, { apiKey: "fixture-original-recovery-key" })).status, "cleanup_pending");
    assert.equal(f.gate.snapshot("openclaw").draining, true); const before = f.events.filter(row => ["acquire", "patch"].includes(row.kind)), requestBoundary = f.state.requests.length;
    const entry = { operationId: id, requestDigest: ctx.requestDigest, kind: "update-provider", providerKey: "unit-provider", commitState: "committed", secretStep: "applied" };
    const recoveryContext = await f.context(spec, id, entry), result = await f.adapter.recover(entry, recoveryContext);
    assert.equal(result.status, "applied"); assert.equal(f.gate.snapshot("openclaw").draining, false);
    assert.deepEqual(f.events.filter(row => ["acquire", "patch"].includes(row.kind)), before);
    assert.equal(f.events.filter(row => row.kind === "terminal-recovery").length, 1);
    assert.equal(f.leases[0].state.finishCount, 1); assert.equal(f.leases[0].state.settlementCount, 1);
    assert.equal(f.state.requests.filter(row => row.method === "owner.close").length, 1);
    assert.ok(f.state.requests.slice(requestBoundary).every(row => ["service.status", "observe", "owner.close"].includes(row.method)));
    assert.equal(f.state.requests.slice(requestBoundary).filter(row => row.method === "owner.close").length, 1);
    assert.equal(recoveryContext.journal.at(-1).stage, "credential-terminal-recovered");
    assert.equal(JSON.stringify({ result, journal: recoveryContext.journal }).includes("fixture-original-recovery-key"), false);
  } finally { await f.close(); }
});

test("foreign or malformed private recovery acknowledgment cannot release original Core hold or close the owner", async () => {
  for (const options of [{ recoveryInvalid: true }, { recoveryWrongOutcome: "compensated" }]) {
    const f = await coreFixture({ settleLostAck: true, enableTerminalRecovery: true, ...options }); try {
      const spec = updateProvider({}), id = "invalid-terminal-recovery-" + Object.keys(options)[0], ctx = await f.context(spec, id);
      assert.equal((await f.adapter.apply(spec, ctx, { apiKey: "fixture-invalid-recovery-key" })).status, "cleanup_pending");
      const entry = { operationId: id, requestDigest: ctx.requestDigest, kind: "update-provider", providerKey: "unit-provider", commitState: "committed", secretStep: "applied" };
      const result = await f.adapter.recover(entry, await f.context(spec, id, entry));
      assert.equal(result.status, "cleanup_pending"); assert.equal(f.gate.snapshot("openclaw").draining, true);
      assert.equal(f.state.requests.some(row => row.method === "owner.close"), false);
      assert.equal(f.leases[0].state.writeCount, 1); assert.equal(f.leases[0].state.settlementCount, 1);
    } finally { await f.close(); }
  }
});

test("changed recovered provider/kind cannot use retained Worker authority even with original operation ID and digest", async () => {
  const f = await coreFixture({ settleLostAck: true, enableTerminalRecovery: true }); try {
    const spec = updateProvider({}), id = "foreign-terminal-provider-core", ctx = await f.context(spec, id);
    await f.adapter.apply(spec, ctx, { apiKey: "fixture-foreign-recovery-key" });
    const entry = { operationId: id, requestDigest: ctx.requestDigest, kind: "delete-provider", providerKey: "unit-provider", commitState: "committed", secretStep: "applied" };
    const restored = await f.adapter.recover(entry, await f.context(spec, id, entry));
    assert.equal(restored.status, "partial"); assert.equal(restored.needsVerification, true);
    assert.equal(f.events.some(row => row.kind === "terminal-recovery"), false); assert.equal(f.gate.snapshot("openclaw").draining, true);
    assert.equal(f.state.requests.some(row => row.method === "owner.close"), false);
  } finally { await f.close(); }
});

test("ordinary HMAC revision is admitted only by the exact acquired raw revision, then private raw CAS sets the credential once", async () => {
  const f = await coreFixture({ projectedRevision: true }); try {
    const spec = updateProvider({}), ctx = await f.context(spec, "projected-revision-set");
    const result = await f.adapter.apply(spec, ctx, { apiKey: "fixture-projected-revision-key" });
    assert.equal(result.status, "applied");
    assert.equal(f.config.models.providers["unit-provider"].apiKey, "fixture-projected-revision-key");
    assert.equal(f.leases[0].state.writeCount, 1);
    assert.equal(f.events.filter(row => row.kind === "patch").length, 1);
  } finally { await f.close(); }
});

test("missing, foreign, staged or malformed acquired revision proof cannot prepare a secret or write configuration", async () => {
  const cases = [
    { missingRevisionSource: true },
    { revisionSourcePatch: { loaded: false } },
    { revisionSourcePatch: { loadedRawHash: "b".repeat(64) } },
    { revisionSourcePatch: { persistedRawHash: "b".repeat(64) } },
    { revisionSourcePatch: { loadedProjectedHash: "hmac-sha256:v1:" + "X".repeat(43) } },
    { revisionSourcePatch: { ready: true } },
  ];
  for (const [index, options] of cases.entries()) {
    const f = await coreFixture({ projectedRevision: true, ...options }); try {
      const spec = updateProvider({}), ctx = await f.context(spec, "reject-revision-" + index);
      const result = await f.adapter.apply(spec, ctx, { apiKey: "fixture-rejected-revision-key" });
      assert.equal(result.status, "partial");
      assert.equal(f.leases[0].state.writeCount, 0);
      assert.equal(f.events.some(row => row.kind === "patch"), false);
      assert.equal(f.state.requests.some(row => row.method === "prepare"), false);
      assert.equal(Object.hasOwn(f.config.models.providers["unit-provider"], "apiKey"), false);
    } finally { await f.close(); }
  }
});

(async () => { const passed = []; for (const { name, fn } of tests) { await fn(); passed.push(name); }
  console.log(JSON.stringify({ verified: true, passed: passed.length, boundary: "actual Core/Base/scanners/private IPC/Gate/Controller/encrypted files + production credential effect policy; controlled physical Worker/catalogue/finish, zero Host/model/remote", tests: passed }));
})().catch(error => { console.error(JSON.stringify({ verified: false, code: error.code || "CREDENTIAL_CORE_UNIT_FAILED", message: error.message, stack: error.stack })); process.exitCode = 1; });
