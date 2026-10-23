#!/usr/bin/env node
"use strict";

// Actual ModelChange/scanners + process admission gate. Worker protocol is a controlled,
// credentialless boundary double with a WeakSet brand; this is not a real Host proof.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createManagedOpenClawModelApply } = require("../app/core/managed-openclaw-model-apply");
const { createManagedOpenClawProductModelApi } = require("../app/managed-openclaw-product-model-api");
const { createWorkAdmissionGate } = require("../app/core/work-admission-gate");
const { normalizeModelChangeRequest, modelChangeRequestDigest } = require("../app/core/model-change-validation");
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const clone = (value) => JSON.parse(JSON.stringify(value));
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function until(fn) {
  for (let n = 0; n < 500; n++) { if (fn()) return; await new Promise((done) => setTimeout(done, 2)); }
  assert.fail("bounded observable condition was not reached");
}
function spec(providerKey = "local", id = "new", extra = {}) {
  return normalizeModelChangeRequest({ providerKey, model: { id, name: id.toUpperCase() }, ...extra }).safeSpec;
}
function merge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete target[key];
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== "object") target[key] = {};
      merge(target[key], value);
    } else target[key] = clone(value);
  }
}
function fixture(options = {}) {
  const config = options.config || { models: { providers: { local: { baseUrl: "http://127.0.0.1:9", api: "openai-completions", models: [] } } }, agents: { defaults: {} } };
  const events = [];
  const gate = createWorkAdmissionGate();
  const brands = new WeakSet();
  const identities = new WeakMap();
  const leases = [];
  const hash = () => createHash("sha256").update(JSON.stringify(config)).digest("hex");
  const rpc = async (method, params, operationId) => {
    if (options.beforeRpc) await options.beforeRpc(method, params, operationId);
    if (method === "config.get") return { parsed: clone(config), hash: hash() };
    if (method === "config.patch") {
      assert.equal(params.baseHash, hash(), "conditional config hash must match");
      assert.equal(typeof params.raw, "string");
      assert(Array.isArray(params.replacePaths));
      merge(config, JSON.parse(params.raw));
      return { ok: true };
    }
    if (method === "config.set" && options.native) {
      assert.equal(params.baseHash, hash());
      const next = JSON.parse(params.raw);
      for (const key of Object.keys(config)) delete config[key];
      Object.assign(config, next);
      return { ok: true, hash: hash(), restartRequired: true };
    }
    if (method === "models.list") return { models: Object.entries(config.models.providers).flatMap(([provider, row]) => row.models.map((model) => ({ ...clone(model), provider }))) };
    if (method === "sessions.list") return { sessions: clone(options.sessions || []), hasMore: false };
    if (method === "cron.list") return { jobs: [], hasMore: false };
    if (method === "tasks.list") return { supported: true, tasks: [], hasMore: false };
    throw Object.assign(new Error("fixed Worker method unsupported"), { code: "managed_model_rpc_unsupported" });
  };
  const backend = {
    async request(method, params) {
      events.push({ boundary: "ordinary", method });
      assert(!["config.patch", "config.set", "sessions.patch", "cron.update"].includes(method), "ordinary Backend must never receive transaction writes");
      return rpc(method, params, null);
    },
  };
  const modelController = {
    async isModelApplySupported() { return options.supported === undefined ? true : options.supported; },
    async getModelReferenceCapabilities() { return {}; },
    async canRecoverModelLease() { return options.recoverySupported !== false; },
    async assertModelLease(lease, identity) {
      events.push({ boundary: "brand", op: identity.operationId });
      if (options.onAssert) await options.onAssert(lease, identity);
      const original = identities.get(lease);
      return brands.has(lease) && original?.operationId === identity.operationId && original?.requestDigest === identity.requestDigest && !lease.retired;
    },
    async acquireModelLease(input) {
      assert.equal(gate.snapshot("openclaw").draining, true);
      assert.equal(Object.isFrozen(input.safeSpec), true);
      if (input.safeSpec.model) assert.equal(Object.isFrozen(input.safeSpec.model), true);
      events.push({ boundary: "acquire", op: input.operationId, safeSpec: input.safeSpec, recovery: input.recovery });
      if (options.onAcquire) await options.onAcquire(input);
      let expiresAt = Date.now() + (options.ttlMs || 30000);
      const before = clone(config);
      const state = { paused: true, retired: false };
      const lease = {
        get expiresAt() { return expiresAt; },
        get retired() { return state.retired; },
        async assertIdle() { events.push({ boundary: "idle", op: input.operationId }); return options.idle !== false; },
        async modelRpc(method, params) {
          assert.equal(Object.isFrozen(params), true);
          events.push({ boundary: "private", method, op: input.operationId });
          return rpc(method, params, input.operationId);
        },
        async renew() {
          events.push({ boundary: "renew", op: input.operationId });
          if (options.renewFails) throw new Error("synthetic lost lease");
          expiresAt = Date.now() + (options.ttlMs || 30000);
          return { expiresAt };
        },
        async restartPaused() { events.push({ boundary: "restart-paused", op: input.operationId }); assert(state.paused); return true; },
        async waitHealthy() { events.push({ boundary: "health-paused", op: input.operationId }); assert(state.paused); return true; },
        async verifyTarget(safeSpec) {
          events.push({ boundary: "verify", op: input.operationId });
          assert(state.paused);
          if (options.verify === false) return false;
          if (options.native) return true; // Boundary double; real source handler covered separately.
          const target = config.models.providers[safeSpec.providerKey]?.models.find((row) => row.id === safeSpec.model?.id);
          return Boolean(target && Object.entries(safeSpec.model || {}).every(([key, value]) => target[key] === value));
        },
        async convergeAfterRetire() { events.push({ boundary: "converge", op: input.operationId }); assert(state.paused); return true; },
        async finish(inputResult) {
          events.push({ boundary: "finish", op: input.operationId, outcome: inputResult.outcome });
          assert.equal(inputResult.operationId, input.operationId);
          assert.equal(inputResult.requestDigest, input.requestDigest);
          assert.deepEqual(inputResult.safeSpec, input.safeSpec);
          assert(state.paused);
          assert.equal(events.some((item) => item.boundary === "commit" && item.op === input.operationId), inputResult.outcome === "applied");
          if (inputResult.outcome === "compensated") assert.deepEqual(config, before, "a compensated finish requires original exact configuration");
          if (options.finishFalse) return false;
          if (options.onFinish) await options.onFinish(inputResult, state);
          state.paused = false;
          state.retired = true;
          return true;
        },
        async abandon() { events.push({ boundary: "abandon", op: input.operationId }); assert(state.paused); state.retired = true; return true; },
      };
      if (!options.forged) brands.add(lease);
      identities.set(lease, input);
      leases.push({ lease, state, input });
      return lease;
    },
  };
  const adapter = createManagedOpenClawModelApply({ backend, modelController, admissionGate: gate, drainTimeoutMs: options.drainTimeoutMs || 100,
    ...(options.native ? { configurationMode: "native-config" } : {}) });
  const context = async (safeSpec, operationId = "operation-1", entry = null) => {
    const preview = await adapter.preview(safeSpec);
    const captured = {
      operationId, requestDigest: entry?.requestDigest || modelChangeRequestDigest(safeSpec),
      journalEntry: entry || { commitState: "precommit", fingerprints: preview.fingerprints,
        ...(options.native ? { mode: "native-config", stage: "preflight" } : {}) },
      providerLeaseSignal: options.signal,
      assertProviderLease() { if (options.signal?.aborted) throw new Error("provider canceled"); },
      async recordStage(stage) {
        events.push({ boundary: "stage", stage, op: operationId });
        if (options.onStage) await options.onStage(stage, operationId);
      },
      async recordStep() {},
      async markCommitting() { events.push({ boundary: "committing", op: operationId }); },
      async markCommitted() { events.push({ boundary: "commit", op: operationId }); },
    };
    return captured;
  };
  return { adapter, backend, modelController, gate, config, events, leases, context };
}

test("native metadata save retains the coordinator-owned private lease and uses config.set without scanning references", async () => {
  const f = fixture({ native: true });
  f.config.agents.defaults.model = { primary: "local/old" };
  f.config.models.providers.local.models.push({ id: "old", name: "Old", input: ["image", "text"], contextTokens: 64000 });
  const s = { kind: "delete-model", providerKey: "local", sourceModelId: "old", sourceKey: '["local","old"]', target: null };
  const result = await f.adapter.apply(s, await f.context(s));
  assert.equal(result.status, "applied");
  assert.deepEqual(f.config.models.providers.local.models, []);
  assert.equal(f.config.agents.defaults.model.primary, "local/old");
  assert.equal(f.events.filter(row => row.boundary === "private" && row.method === "config.set").length, 1);
  assert.equal(f.events.some(row => ["sessions.list", "cron.list", "config.patch"].includes(row.method)), false);
  assert.equal(f.events.filter(row => row.boundary === "restart-paused").length, 1);
  assert.equal(f.gate.snapshot("openclaw").draining, false);
});

test("native endpoint draft is one scoped save, retains old row metadata and never changes Agent bindings", async () => {
  const f = fixture({ native: true });
  f.config.models.providers.local.models.push({ id: "old", name: "Old", input: ["image"], contextTokens: 64000 });
  const { normalizeModelProviderDraft } = require("../app/core/model-change-validation");
  const s = normalizeModelProviderDraft({ providerKey: "local", baseUrl: "https://changed.invalid", models: ["old", "new"] }).safeSpec;
  const result = await f.adapter.apply(s, await f.context(s));
  assert.equal(result.status, "applied");
  assert.equal(f.config.models.providers.local.baseUrl, "https://changed.invalid");
  assert.deepEqual(f.config.models.providers.local.models[0].input, ["image"]);
  assert.equal(f.config.models.providers.local.models[0].contextTokens, 64000);
  assert.equal(f.events.filter(row => row.boundary === "private" && row.method === "config.set").length, 1);
});

test("ordinary preview is real read-only Backend; truthy capability is not support", async () => {
  const f = fixture({ supported: "true" });
  const caps = await f.adapter.getCapabilities();
  assert.equal(caps.supported, false);
  const preview = await f.adapter.preview(spec());
  assert(preview.blockers.some((row) => row.code === "runtime_apply_unsupported"));
  assert.equal(f.leases.length, 0);
  assert(f.events.every((row) => row.boundary === "ordinary"));
});

test("exact original digest and guarded context are mandatory before acquire", async () => {
  const f = fixture(); const s = spec(); const ctx = await f.context(s);
  const wrong = { ...ctx, requestDigest: "a".repeat(64) };
  await assert.rejects(f.adapter.apply(s, wrong), { code: "managed_model_digest_mismatch" });
  assert.throws(() => f.adapter.apply({ ...s, apiKey: "synthetic-not-secret" }, ctx), { code: "managed_model_invalid_spec" });
  await assert.rejects(f.adapter.apply(s, { ...ctx, assertProviderLease: null }), { code: "managed_model_context_incomplete" });
  assert.equal(f.leases.length, 0);
});

test("actual create uses one branded private lease; commit precedes finish; no ordinary write", async () => {
  const f = fixture(); const s = spec(); const ctx = await f.context(s);
  f.events.length = 0;
  assert.equal((await f.adapter.apply(s, ctx)).status, "applied");
  assert.equal(f.leases.length, 1);
  assert.equal(f.events.filter((row) => row.boundary === "private" && row.method === "config.patch").length, 1);
  const acquiredAt = f.events.findIndex((row) => row.boundary === "acquire");
  assert(f.events.slice(acquiredAt + 1).every((row) => row.boundary !== "ordinary"));
  assert(f.events.findIndex((row) => row.boundary === "commit") < f.events.findIndex((row) => row.boundary === "finish"));
  assert.equal(f.leases[0].state.paused, false);
  assert.equal(f.gate.snapshot("openclaw").draining, false);
});

test("uncertain acquire ACK never becomes a terminal compensation or ordinary retry", async () => {
  const f = fixture({ onAcquire: async () => { throw new Error("synthetic lost owning lease ACK"); } });
  const s = spec(); const result = await f.adapter.apply(s, await f.context(s));
  assert.equal(result.status, "partial");
  assert.equal(result.code, "managed_model_acquire_unverified");
  assert.equal(result.needsVerification, true);
  assert.equal(f.events.filter((row) => row.boundary === "acquire").length, 1);
  assert.equal(f.events.some((row) => ["private", "finish", "abandon"].includes(row.boundary)), false);
  assert.equal(f.gate.snapshot("openclaw").draining, true);
  assert.throws(() => f.gate.enter("openclaw", "chat.send"), { code: "gateway_draining" });
});

test("unknown acquisition holds ordinary work until exact original-op recovery is verified", async () => {
  let loseAck = true;
  const f = fixture({ onAcquire: async () => { if (loseAck) throw new Error("synthetic lost lease ACK"); } });
  const s = spec(); const ctx = await f.context(s);
  assert.equal((await f.adapter.apply(s, ctx)).status, "partial");
  const oldCount = f.events.filter((row) => row.boundary === "acquire").length;
  await assert.rejects(f.adapter.apply(s, ctx), { code: "managed_model_requires_recovery" });
  assert.equal(f.events.filter((row) => row.boundary === "acquire").length, oldCount);
  // Controlled durable target representing the original operation. No second model send.
  f.config.models.providers.local.models.push({ ...s.model });
  loseAck = false;
  const entry = { operationId: ctx.operationId, requestDigest: ctx.requestDigest, kind: "create", providerKey: "local", source: null,
    modelDiff: { after: { ...s.model } }, commitState: "precommit", stage: "stage-target", createdProvider: false };
  const recovered = await f.adapter.recover(entry, { ...ctx, journalEntry: entry });
  assert.equal(recovered.status, "applied");
  assert.equal(f.gate.snapshot("openclaw").drainCount, 0);
  assert.equal(f.config.models.providers.local.models.length, 1);
  const leave = f.gate.enter("openclaw", "chat.send"); leave();
});

test("actual ProductModelApi admits only its retained recovery while ordinary capability is false", async () => {
  let loseAck = true, modelBusy = false;
  const f = fixture({ onAcquire: async () => { if (loseAck) throw new Error("synthetic lost owning ACK"); } });
  const rawApi = {
    isModelApplySupported: f.modelController.isModelApplySupported,
    assertModelLease: f.modelController.assertModelLease,
    async acquireModelLease(input) {
      const lease = await f.modelController.acquireModelLease(input);
      const originalFinish = lease.finish.bind(lease);
      lease.finish = async (...args) => await originalFinish(...args) === true
        ? { paused: false, resumed: true, healthVerified: true } : false;
      return lease;
    },
  };
  const client = { modelApi: rawApi };
  const bridge = createManagedOpenClawProductModelApi({
    getClient: () => client,
    canAcquire: () => !modelBusy,
    canContinue: (candidate) => candidate === client,
    begin: () => { modelBusy = true; },
    resumed: async () => { modelBusy = false; },
    failed: async () => { modelBusy = true; },
  });
  const adapter = createManagedOpenClawModelApply({ backend: f.backend, modelController: bridge.api, admissionGate: f.gate });
  const s = spec(); const ctx = await f.context(s);
  assert.equal((await adapter.apply(s, ctx)).status, "partial");
  assert.equal(await bridge.api.isModelApplySupported(), false);
  f.config.models.providers.local.models.push({ ...s.model }); loseAck = false;
  const entry = { operationId: ctx.operationId, requestDigest: ctx.requestDigest, kind: "create", providerKey: "local", source: null,
    modelDiff: { after: { ...s.model } }, commitState: "precommit", stage: "stage-target", createdProvider: false };
  // A foreign journal identity does not create a Worker lease while the product is paused.
  const count = f.leases.length;
  const foreign = { ...entry, operationId: "foreign-operation" };
  await assert.rejects(adapter.recover(foreign, { ...ctx, operationId: foreign.operationId }), { code: "managed_model_recovery_unavailable" });
  assert.equal(f.leases.length, count);
  assert.equal(await bridge.api.isModelApplySupported(), false);
  const result = await adapter.recover(entry, ctx);
  assert.equal(result.status, "applied");
  assert.equal(await bridge.api.isModelApplySupported(), true);
  // Read-only refusal created no foreign hold; verified original recovery frees its hold.
  assert.equal(f.gate.snapshot("openclaw").drainCount, 0);
  assert.equal(f.leases.at(-1).input.operationId, entry.operationId);
  assert.equal(f.events.some((row) => row.boundary === "private" && row.method === "config.patch"), false);
});

test("unresolved operation capacity fails closed without evicting an older hold", async () => {
  const f = fixture({ onAcquire: async () => { throw new Error("synthetic unknown acquire"); } });
  const s = spec(); const ctx = await f.context(s);
  for (let n = 0; n < 128; n++) {
    assert.equal((await f.adapter.apply(s, { ...ctx, operationId: `unresolved-${n}` })).status, "partial");
  }
  assert.equal(f.gate.snapshot("openclaw").drainCount, 128);
  const count = f.events.filter((row) => row.boundary === "acquire").length;
  await assert.rejects(f.adapter.apply(s, { ...ctx, operationId: "unresolved-over-limit" }), { code: "managed_model_unresolved_limit" });
  assert.equal(f.events.filter((row) => row.boundary === "acquire").length, count);
  await assert.rejects(f.adapter.apply(s, { ...ctx, operationId: "unresolved-0" }), { code: "managed_model_requires_recovery" });
  assert.equal(f.gate.snapshot("openclaw").drainCount, 128);
});

test("a lease-shaped unbranded object never receives writes, idle, finish, or abandon", async () => {
  const f = fixture({ forged: true }); const s = spec();
  const result = await f.adapter.apply(s, await f.context(s));
  assert.equal(result.status, "partial");
  assert.equal(f.events.some((row) => ["private", "idle", "finish", "abandon"].includes(row.boundary)), false);
  assert.equal(f.config.models.providers.local.models.length, 0);
  assert.equal(f.gate.snapshot("openclaw").draining, true);
});

test("paused target failure compensates through the same private conditional writer", async () => {
  const f = fixture({ verify: false }); const s = spec();
  const result = await f.adapter.apply(s, await f.context(s));
  assert.equal(result.status, "compensated");
  assert.equal(f.config.models.providers.local.models.length, 0);
  assert.equal(f.events.filter((row) => row.boundary === "private" && row.method === "config.patch").length, 2);
  assert.equal(f.events.at(-1).boundary, "finish");
  assert.equal(f.events.at(-1).outcome, "compensated");
});

test("managed Main without credential broker rejects a secret before acquire or write", async () => {
  const f = fixture({ verify: false }); const s = spec();
  await assert.rejects(f.adapter.apply(s, await f.context(s), { apiKey: "fixture-value-only" }), { code: "managed_credential_broker_unavailable" });
  assert.equal(f.events.some(row => ["acquire", "private", "finish", "abandon"].includes(row.boundary)), false);
});

test("unknown finish acknowledgement is nonterminal and never an automatic resume", async () => {
  const f = fixture({ finishFalse: true }); const s = spec();
  const result = await f.adapter.apply(s, await f.context(s));
  assert.equal(result.status, "cleanup_pending");
  assert.equal(result.code, "managed_model_finish_unverified");
  assert.equal(result.needsVerification, true);
  assert.equal(f.events.at(-1).boundary, "abandon");
  assert.equal(f.leases[0].state.paused, true);
});

test("spec/context are captured before asynchronous admission and brand lookup; secrets use private broker tests", async () => {
  const entered = deferred(); const release = deferred();
  const f = fixture({ onAcquire: async () => { entered.resolve(); await release.promise; } });
  const original = spec("local", "new"); const mutable = { ...original, model: { ...original.model } };
  const ctx = await f.context(mutable);
  const running = f.adapter.apply(mutable, ctx);
  await entered.promise;
  mutable.model.id = "foreign"; mutable.providerKey = "foreign";
  ctx.operationId = "foreign"; ctx.requestDigest = "0".repeat(64); ctx.markCommitted = async () => { assert.fail("mutated hook must not execute"); };
  release.resolve();
  assert.equal((await running).status, "applied");
  assert.equal(f.leases[0].input.operationId, "operation-1");
  assert.equal(f.leases[0].input.safeSpec.model.id, "new");
  assert.equal(Object.hasOwn(f.config.models.providers.local, "apiKey"), false);
  assert.equal(f.config.models.providers.local.models[0].id, "new");
});

test("independent preview and concurrent transactions never inherit another ALS lease", async () => {
  const firstHeld = deferred(); const releaseFirst = deferred();
  const f = fixture({
    config: { models: { providers: { local: { models: [] }, other: { models: [] } } }, agents: { defaults: {} } },
    onStage: async (stage, op) => { if (stage === "preflight" && op === "first") { firstHeld.resolve(); await releaseFirst.promise; } },
  });
  const s1 = spec("local"); const s2 = spec("other");
  const c1 = await f.context(s1, "first"); const c2 = await f.context(s2, "second");
  const first = f.adapter.apply(s1, c1);
  await firstHeld.promise;
  const before = f.events.length;
  await f.adapter.preview(spec("local", "preview-only"));
  assert(f.events.slice(before).every((row) => row.boundary === "ordinary"));
  const second = await f.adapter.apply(s2, c2);
  assert.equal(second.status, "applied");
  releaseFirst.resolve();
  const result = await first;
  assert.equal(result.status, "partial");
  assert.equal(f.leases[0].state.paused, true, "global configuration changed after acquire: uncertain compensation cannot resume");
  assert(f.events.filter((row) => row.boundary === "private").every((row) => row.op === "first" || row.op === "second"));
  assert.equal(f.leases.length, 2);
  assert.equal(f.gate.snapshot("openclaw").draining, false);
});

test("same operation cannot acquire a second lease while its original transaction is live", async () => {
  const held = deferred(); const release = deferred();
  const f = fixture({ onStage: async (stage) => { if (stage === "preflight") { held.resolve(); await release.promise; } } });
  const s = spec(); const ctx = await f.context(s);
  const running = f.adapter.apply(s, ctx); await held.promise;
  await assert.rejects(f.adapter.apply(s, ctx), { code: "managed_model_operation_in_progress" });
  release.resolve(); assert.equal((await running).status, "applied");
  assert.equal(f.leases.length, 1);
});

test("canceled in-flight writer keeps original operation paused with no public fallback", async () => {
  const abort = new AbortController(); const held = deferred(); const release = deferred();
  const f = fixture({ signal: abort.signal, beforeRpc: async (method, params, op) => {
    if (op && method === "config.patch") { held.resolve(); await release.promise; }
  } });
  const s = spec(); const running = f.adapter.apply(s, await f.context(s));
  await held.promise; abort.abort(); release.resolve();
  const result = await running;
  assert.equal(result.status, "partial");
  assert.equal(f.events.some((row) => row.boundary === "finish"), false);
  assert.equal(f.leases[0].state.paused, true);
  const start = f.events.findIndex((row) => row.boundary === "acquire");
  assert.equal(f.events.slice(start).some((row) => row.boundary === "ordinary"), false);
});

test("lease renewal failure fences journal continuation and all subsequent effects", async () => {
  const held = deferred(); const release = deferred();
  const f = fixture({ ttlMs: 90, renewFails: true, onStage: async (stage) => { if (stage === "preflight") { held.resolve(); await release.promise; } } });
  const s = spec(); const running = f.adapter.apply(s, await f.context(s));
  await held.promise; await until(() => f.events.some((row) => row.boundary === "renew"));
  await new Promise((done) => setImmediate(done)); release.resolve();
  const result = await running;
  assert.equal(result.status, "partial");
  assert.equal(f.events.some((row) => row.boundary === "private" && row.method === "config.patch"), false);
  assert.equal(f.events.some((row) => row.boundary === "finish"), false);
  assert.equal(f.leases[0].state.paused, true);
});

test("recovery first read uses original branded op/digest; no endpoint or secret is invented", async () => {
  const s = spec();
  const entry = { operationId: "original-recovery", requestDigest: modelChangeRequestDigest(s), kind: "create", providerKey: "local", source: null,
    modelDiff: { after: { ...s.model, backendId: "openclaw", providerKey: "local" } }, commitState: "precommit", stage: "stage-target", createdProvider: false };
  const f = fixture({ config: { models: { providers: { local: { models: [{ ...s.model }] } } }, agents: { defaults: {} } } });
  const ctx = await f.context(s, entry.operationId, entry); f.events.length = 0;
  assert.equal((await f.adapter.recover(entry, ctx)).status, "applied");
  assert.equal(f.events.some((row) => row.boundary === "ordinary"), false);
  assert.equal(f.leases[0].input.requestDigest, entry.requestDigest);
  assert.equal(f.leases[0].input.recovery, true);
  assert.equal(Object.hasOwn(f.leases[0].input.safeSpec, "baseUrl"), false);
  assert.equal(Object.hasOwn(f.leases[0].input.safeSpec, "apiKey"), false);
  assert.equal(f.events.some((row) => row.boundary === "private" && row.method === "config.patch"), false);
  await assert.rejects(f.adapter.recover({ ...entry, requestDigest: "1".repeat(64) }, ctx), { code: "managed_model_operation_mismatch" });
});

test("trusted read-only recovery refusal creates no owning lease or unresolved local hold", async () => {
  const s = spec(); const f = fixture({ recoverySupported: false });
  const entry = { operationId: "not-retained", requestDigest: modelChangeRequestDigest(s), kind: "create", providerKey: "local", source: null,
    modelDiff: { after: { ...s.model } }, commitState: "precommit", stage: "stage-target", createdProvider: false };
  const ctx = await f.context(s, entry.operationId, entry);
  await assert.rejects(f.adapter.recover(entry, ctx), { code: "managed_model_recovery_unavailable" });
  assert.equal(f.leases.length, 0);
  assert.equal(f.gate.snapshot("openclaw").drainCount, 0);
});

test("missing reference concurrency stays blocked; no fabricated migration capability", async () => {
  const f = fixture({ config: { models: { providers: { local: { models: [{ id: "old" }] } } }, agents: { defaults: {} } }, sessions: [{ key: "agent:main:one", providerOverride: "local", modelOverride: "old" }] });
  const s = spec("local", "new", { sourceModelId: "old" });
  const preview = await f.adapter.preview(s);
  assert(preview.blockers.some((row) => row.code === "reference_concurrency_unsupported"));
  const result = await f.adapter.apply(s, await f.context(s));
  assert.equal(result.status, "blocked");
  assert.equal(f.leases.length, 0);
});

test("unavailable journal recovery target cannot reconstruct missing endpoint or mutate config", async () => {
  const s = spec("brand", "new", { providerMode: "new", baseUrl: "http://127.0.0.1:9" });
  const entry = { operationId: "original-new-provider", requestDigest: modelChangeRequestDigest(s), kind: "create", providerKey: "brand", source: null,
    modelDiff: { after: { ...s.model } }, commitState: "precommit", stage: "preflight", createdProvider: true };
  const f = fixture();
  const ctx = await f.context(s, entry.operationId, entry);
  const result = await f.adapter.recover(entry, ctx);
  assert.equal(result.status, "partial");
  assert.equal(result.code, "managed_credential_recovery_observation_only");
  assert.equal(f.events.some((row) => row.boundary === "private" && row.method === "config.patch"), false);
  assert.equal(f.events.some((row) => row.boundary === "finish"), false);
  assert.equal(f.leases.length, 0, "unknown credential recovery does not remint a physical lease");
});

test("connection invalidation fences delayed transaction; old callbacks cannot regain ordinary access", async () => {
  const held = deferred(); const release = deferred(); const late = deferred();
  let lateAction;
  const f = fixture({ onStage: async (stage) => { if (stage === "preflight") { held.resolve(); await release.promise; } }, onFinish: async () => {
    // ALS propagates into this detached callback; Core must reject it after transaction completion.
    lateAction = () => f.adapter.runtimeApply.verifyTarget();
    setImmediate(() => late.resolve());
  } });
  const s = spec(); const running = f.adapter.apply(s, await f.context(s));
  await held.promise; f.adapter.runtimeApply.invalidateConnectionGeneration(); release.resolve();
  assert.equal((await running).status, "partial");
  assert.equal(f.leases[0].state.paused, true);
  const normal = fixture({ onFinish: async () => { setImmediate(async () => {
    try { await normal.adapter.runtimeApply.verifyTarget(); late.resolve("unexpected"); }
    catch (error) { late.resolve(error.code); }
  }); } });
  const out = await normal.adapter.apply(s, await normal.context(s));
  assert.equal(out.status, "applied");
  assert.equal(await late.promise, "managed_model_scope_expired");
  assert.equal(lateAction, undefined);
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); passed++; process.stdout.write(`PASS ${name}\n`); }
    catch (error) { process.stderr.write(`FAIL ${name}\n${error.stack}\n`); process.exitCode = 1; }
  }
  process.stdout.write(`${passed}/${tests.length} managed model Core boundary groups passed; real Host/model/credentials: 0\n`);
})().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
