#!/usr/bin/env node
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createManagedOpenClawProductHost } = require("../app/managed-openclaw-product-host");
const { credentialOwner } = require("../app/managed-openclaw-provider-credential");
const tick = () => new Promise(resolve => setImmediate(resolve));
const scope = (operationId = "model-one", recovery = false) => ({ operationId, requestDigest: "d".repeat(64), safeSpec: { kind: "create", providerKey: "fixture", target: { modelId: "local" } }, recovery });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(options = {}) {
  let mode = "existing", state = "absent", clients = 0, withdrawn = 0, reopened = 0, acquires = 0, effects = 0, finishes = 0, closes = 0, ownerReads = 0, permitBinds = 0, receivedPermit = null;
  const brands = new WeakSet(), blockers = new Set();
  let acquireFailure = options.acquireFailure;
  const client = { ready: Promise.resolve(),
    getStatus: () => ({ state, ownership: ["absent", "closed"].includes(state) ? "absent" : "managed", selectionSupported: state === "running" }),
    getEndpoint: () => state === "running" ? { url: "ws://127.0.0.1:9", token: "private" } : null,
    getExecution: () => state === "running" ? { home: "/private/fixture" } : null,
    controller: { getCandidate: async () => ({ candidateId: "a".repeat(64) }), prepareCandidate: async () => { throw new Error("not needed"); },
      activateCandidate: async () => { state = "running"; return { healthVerified: true }; },
      stopOwned: async () => { for (const blocker of blockers) blocker.reject(Object.assign(new Error("retired"), { code: "MANAGED_HOST_MODEL_LEASE_RETIRED" })); state = "absent"; }, },
    close: async () => { closes++; for (const blocker of blockers) blocker.reject(Object.assign(new Error("retired"), { code: "MANAGED_HOST_MODEL_LEASE_RETIRED" })); state = "closed"; },
  };
  client.modelApi = {
    isModelApplySupported: async () => true,
    assertModelLease: async (lease, identity) => brands.has(lease) && lease.operationId === identity.operationId && lease.requestDigest === identity.requestDigest,
    acquireModelLease: async identity => {
      acquires++; state = "paused";
      if (acquireFailure) { acquireFailure = false; throw Object.assign(new Error("lost acquire ack"), { code: "MANAGED_HOST_MODEL_ACK_UNKNOWN" }); }
      const raw = { operationId: identity.operationId, requestDigest: identity.requestDigest, token: "fixture-private-lease", expiresAt: Date.now() + 60000,
        modelRpc: async () => { effects++; if (options.heldRpc) { const wait = deferred(); blockers.add(wait); return wait.promise.finally(() => blockers.delete(wait)); } return { ok: true }; },
        assertIdle: async () => true, renew: async () => ({ expiresAt: Date.now() + 60000 }), restartPaused: async () => true,
        waitHealthy: async () => true, verifyTarget: async () => true, convergeAfterRetire: async () => true,
        finish: async () => { finishes++; if (options.finishWait) await options.finishWait.promise;
          if (options.finishReceipt !== undefined) return options.finishReceipt;
          state = options.badPhysicalStatus ? "paused" : "running"; return { paused: false, resumed: true, healthVerified: true }; },
        abandon: async () => ({ paused: true, resumed: false }),
      };
      if (!options.missingCredentialMethods) {
        raw.getCredentialOwner = async () => { ownerReads++; if (options.ownerWait) await options.ownerWait.promise;
          return credentialOwner({ version: 1, backendId: "openclaw", operationId: options.foreignOwner ? "foreign-owner" : identity.operationId,
            requestDigest: identity.requestDigest, pid: 12345, startIdentity: "synthetic Product brand only", nonce: "a".repeat(64), generation: "fixture-generation",
            runtimeRoot: "/private/tmp/fixture-runtime", runtimeTreeSha256: "b".repeat(64), dataRoot: "/private/tmp/fixture-private-host",
            interpreterPath: "/private/tmp/external-node", entryPath: "/private/tmp/fixture-runtime/openclaw.mjs", expiresAt: raw.expiresAt }); };
        raw.bindCredentialPermit = async value => { permitBinds++; receivedPermit = value; return options.bindReceipt === undefined ? true : options.bindReceipt; };
      }
      brands.add(raw); return raw;
    },
  };
  const host = createManagedOpenClawProductHost({ getMode: () => mode, setManagedMode: () => { mode = "managed"; },
    createClient: () => { clients++; return client; }, onUnavailable: () => { withdrawn++; return options.withdrawalFailure ? Promise.reject(new Error("withdrawal failed")) : Promise.resolve(); },
    onReady: async () => { reopened++; }, });
  return { host, client, api: host.getModelApplyApi(), counts: () => ({ clients, withdrawn, reopened, acquires, effects, finishes, closes, ownerReads, permitBinds }),
    receivedPermit: () => receivedPermit,
    activate: async () => { host.prepare({ operationId: "prepare" }); return host.waitForOperation("prepare"); } };
}
async function activate(t, options) { const f = fixture(options); await f.activate(); t.after(() => f.host.close()); return f; }
test("legacy mode has no client or public lease authority", async () => {
  const f = fixture(); assert.equal(await f.api.isModelApplySupported(), false); assert.equal(f.counts().clients, 0);
  assert.throws(() => f.api.acquireModelLease(scope()), { code: "MANAGED_HOST_MODEL_APPLY_UNAVAILABLE" });
  assert.equal(f.counts().clients, 0); assert.equal(f.host.getExecution(), undefined);
});
test("model acquire synchronously withdraws endpoint and blocks concurrent host/model actions", async t => {
  const f = await activate(t), pending = f.api.acquireModelLease(scope());
  assert.equal(f.host.getEndpoint(), null); assert.equal(f.host.getExecution(), null);
  assert.equal(f.host.getStatus().state, "activating"); assert.equal(f.counts().acquires, 0);
  assert.throws(() => f.host.restart({ operationId: "other" }), { code: "MANAGED_HOST_OPERATION_BUSY" });
  assert.throws(() => f.api.acquireModelLease(scope("other")), { code: "MANAGED_HOST_MODEL_APPLY_UNAVAILABLE" });
  const lease = await pending; assert.equal(await f.api.assertModelLease(lease, scope()), true);
  assert.throws(() => f.api.acquireModelLease(scope("model-one", true)), { code: "MANAGED_HOST_MODEL_APPLY_UNAVAILABLE" });
  assert.equal(f.api.canRecoverModelLease(scope()), false);
  assert.equal(f.counts().acquires, 1);
});
test("clone/wrong identity and wrong finish outcome cannot invoke raw effects", async t => {
  const f = await activate(t), lease = await f.api.acquireModelLease(scope());
  await assert.rejects(f.api.assertModelLease({ ...lease }, scope()), { code: "MANAGED_HOST_MODEL_LEASE_RETIRED" });
  await assert.rejects(f.api.assertModelLease(lease, scope("foreign")), { code: "MANAGED_HOST_MODEL_LEASE_RETIRED" });
  await assert.rejects(lease.finish({ ...scope("foreign"), outcome: "applied" }), { code: "MANAGED_HOST_MODEL_SCOPE_INVALID" });
  assert.equal(f.counts().finishes, 0); assert.equal(f.host.getEndpoint(), null);
});
test("only exact resume receipt plus actual running host reopens product; old handle stays retired", async t => {
  const f = await activate(t), lease = await f.api.acquireModelLease(scope());
  assert.equal(await lease.finish({ ...scope(), outcome: "applied" }), true); await tick();
  assert.equal(f.host.getStatus().state, "running"); assert.ok(f.host.getEndpoint());
  const before = f.counts().withdrawn;
  await assert.rejects(lease.modelRpc("config.patch", {}), { code: "MANAGED_HOST_MODEL_LEASE_RETIRED" });
  assert.equal(f.counts().effects, 0); assert.equal(f.counts().withdrawn, before); assert.equal(f.host.getStatus().state, "running");
});
test("partial/extra/truthy resume receipts keep endpoint closed for exact recovery", async t => {
  for (const receipt of [true, { paused: false, resumed: true }, { paused: false, resumed: "true", healthVerified: true },
    { paused: false, resumed: true, healthVerified: true, extra: true }]) {
    const f = await activate(t, { finishReceipt: receipt }), lease = await f.api.acquireModelLease(scope());
    await assert.rejects(lease.finish({ ...scope(), outcome: "blocked" }), { code: "MANAGED_HOST_MODEL_RESUME_UNVERIFIED" });
    assert.equal(f.host.getStatus().state, "needs_verification"); assert.equal(f.host.getEndpoint(), null);
    assert.throws(() => f.api.acquireModelLease(scope("foreign", true)), { code: "MANAGED_HOST_MODEL_APPLY_UNAVAILABLE" });
    assert.equal(await f.api.assertModelLease(await f.api.acquireModelLease(scope("model-one", true)), scope()), true);
  }
});
test("a resume claim without physical running status never restores readiness", async t => {
  const f = await activate(t, { badPhysicalStatus: true }), lease = await f.api.acquireModelLease(scope());
  await assert.rejects(lease.finish({ ...scope(), outcome: "applied" }), { code: "MANAGED_HOST_MODEL_RESUME_UNVERIFIED" });
  assert.equal(f.host.getStatus().state, "needs_verification"); assert.equal(f.host.getEndpoint(), null);
});
test("lost acquire ack retains original operation/digest; ordinary retry cannot mint another lease", async t => {
  const f = await activate(t, { acquireFailure: true });
  await assert.rejects(f.api.acquireModelLease(scope()), { code: "MANAGED_HOST_MODEL_ACK_UNKNOWN" }); await tick();
  assert.equal(f.host.getStatus().state, "needs_verification"); assert.equal(await f.api.isModelApplySupported(), false);
  assert.equal(f.api.canRecoverModelLease(scope()), true); assert.equal(f.api.canRecoverModelLease(scope("foreign")), false);
  assert.throws(() => f.api.acquireModelLease(scope()), { code: "MANAGED_HOST_MODEL_APPLY_UNAVAILABLE" });
  assert.throws(() => f.api.acquireModelLease({ ...scope("model-one", true), requestDigest: "e".repeat(64) }), { code: "MANAGED_HOST_MODEL_APPLY_UNAVAILABLE" });
  const recovered = await f.api.acquireModelLease(scope("model-one", true));
  assert.equal(await recovered.finish({ ...scope(), outcome: "compensated" }), true); assert.equal(f.counts().acquires, 2);
});
test("concurrent finish invokes raw resume exactly once", async t => {
  const wait = deferred(), f = await activate(t, { finishWait: wait }), lease = await f.api.acquireModelLease(scope());
  const one = lease.finish({ ...scope(), outcome: "applied" }), two = lease.finish({ ...scope(), outcome: "applied" });
  const rejected = assert.rejects(two, { code: "MANAGED_HOST_MODEL_LEASE_RETIRED" }); await tick();
  assert.equal(f.counts().finishes, 1); wait.resolve(); assert.equal(await one, true); await rejected;
});
test("owned close retires pending model continuation before final stop receipt", async t => {
  const f = await activate(t, { heldRpc: true }), lease = await f.api.acquireModelLease(scope());
  const request = lease.modelRpc("config.get", {}), rejected = assert.rejects(request, { code: "MANAGED_HOST_MODEL_LEASE_RETIRED" });
  await tick(); await f.host.close({ operationId: "close-model" }); await rejected;
  assert.equal(f.host.getStatus().state, "stopped"); assert.equal(f.counts().effects, 1); assert.equal(f.counts().finishes, 0);
  await assert.rejects(lease.restartPaused(), { code: "MANAGED_HOST_MODEL_LEASE_RETIRED" });
  assert.equal(f.host.getEndpoint(), null); assert.equal(f.counts().acquires, 1);
});
test("explicit owned stop retires lease and leaves no delayed raw write", async t => {
  const f = await activate(t), lease = await f.api.acquireModelLease(scope());
  f.host.stop({ operationId: "stop-model" }); await f.host.waitForOperation("stop-model");
  await assert.rejects(lease.modelRpc("config.patch", {}), { code: "MANAGED_HOST_MODEL_LEASE_RETIRED" });
  assert.equal(f.counts().effects, 0); assert.equal(f.host.getStatus().state, "stopped");
});

test("verified exact paused abandonment releases its borrow without reopening the endpoint", async t => {
  const f = await activate(t), lease = await f.api.acquireModelLease(scope());
  assert.equal(await lease.abandon(), true); assert.equal(f.host.getEndpoint(), null);
  assert.equal(f.host.getStatus().state, "needs_verification"); assert.equal(f.api.canRecoverModelLease(scope()), true);
  assert.equal(f.counts().finishes, 0);
});

test("old terminal handle cannot withdraw an in-flight recovery of the same original operation", async t => {
  const f = await activate(t, { finishReceipt: { paused: false } }), old = await f.api.acquireModelLease(scope());
  await assert.rejects(old.finish({ ...scope(), outcome: "applied" }), { code: "MANAGED_HOST_MODEL_RESUME_UNVERIFIED" });
  const current = await f.api.acquireModelLease(scope("model-one", true)); const before = f.counts().withdrawn;
  await assert.rejects(old.modelRpc("config.patch", {}), { code: "MANAGED_HOST_MODEL_LEASE_RETIRED" });
  assert.equal(f.counts().withdrawn, before); assert.equal(f.host.getStatus().state, "activating");
  assert.equal(await f.api.assertModelLease(current, scope()), true); assert.equal(f.counts().effects, 0);
});

function ownerPermit(owner) {
  return { version: 1, owner: { ownerId: "synthetic-service-owner", capability: "c".repeat(64) },
    scope: { backendId: "openclaw", providerKey: "fixture", baseUrl: "https://model.example.test/v1", api: "openai-completions",
      operationId: owner.operationId, requestDigest: owner.requestDigest },
    service: { instanceNonce: "d".repeat(48), pid: 23456, startedAt: Date.now() - 10000, protocolVersion: 11 }, writer: owner };
}
test("private opaque owner checker is synchronous and exact; cloning or owned stop cannot retain the original current epoch", async t => {
  const f = await activate(t), owner = f.api.captureModelOwner();
  assert.equal(f.api.isModelOwnerCurrent(owner), true); assert.equal(typeof f.api.isModelOwnerCurrent(owner), "boolean");
  for (const forged of [{}, Object.create(null), { ...owner }, null]) assert.equal(f.api.isModelOwnerCurrent(forged), false);
  const lease = await f.api.acquireModelLease(scope()); assert.equal(f.api.isModelOwnerCurrent(owner), true);
  assert.equal((await lease.getCredentialOwner()).operationId, scope().operationId);
  f.host.stop({ operationId: "stop-owner-brand" }); assert.equal(f.api.isModelOwnerCurrent(owner), false);
  await f.host.waitForOperation("stop-owner-brand");
  await assert.rejects(lease.getCredentialOwner(), { code: "MANAGED_HOST_MODEL_LEASE_RETIRED" });
  assert.equal(f.counts().ownerReads, 1);
});
test("credential getter binds original lease and captures exact closed permit before async brand checks", async t => {
  const f = await activate(t), lease = await f.api.acquireModelLease(scope()), owner = await lease.getCredentialOwner(), permit = ownerPermit(owner);
  assert.throws(() => lease.getCredentialOwner({ callerOwner: owner }), { code: "MANAGED_HOST_MODEL_CREDENTIAL_INVALID" });
  const binding = lease.bindCredentialPermit(permit); permit.scope.operationId = "caller-mutated"; permit.owner.capability = "e".repeat(64);
  assert.equal(await binding, true); assert.equal(f.receivedPermit().scope.operationId, scope().operationId);
  assert.equal(f.receivedPermit().owner.capability, "c".repeat(64)); assert(Object.isFrozen(f.receivedPermit()));
  assert.throws(() => lease.bindCredentialPermit({ ...ownerPermit(owner), secret: "x" }), { code: "MANAGED_MODEL_CREDENTIAL_CONTRACT_INVALID" });
  const foreign = ownerPermit({ ...owner, operationId: "foreign-operation" });
  assert.throws(() => lease.bindCredentialPermit(foreign), { code: "MANAGED_HOST_MODEL_SCOPE_INVALID" });
  assert.equal(f.counts().permitBinds, 1); assert.equal(f.counts().effects, 0);
});
test("foreign physical getter or unsupported/truthy raw binding stays paused; no public fallback is attempted", async t => {
  const bad = await activate(t, { foreignOwner: true }), badLease = await bad.api.acquireModelLease(scope());
  await assert.rejects(badLease.getCredentialOwner(), { code: "MANAGED_HOST_MODEL_CREDENTIAL_INVALID" }); assert.equal(bad.host.getEndpoint(), null);
  const missing = await activate(t, { missingCredentialMethods: true }), missingLease = await missing.api.acquireModelLease(scope());
  await assert.rejects(missingLease.getCredentialOwner(), { code: "MANAGED_HOST_MODEL_CREDENTIAL_UNSUPPORTED" }); assert.equal(missing.counts().ownerReads, 0);
  const truthy = await activate(t, { bindReceipt: { accepted: true } }), truthyLease = await truthy.api.acquireModelLease(scope());
  await assert.rejects(truthyLease.bindCredentialPermit(ownerPermit(await truthyLease.getCredentialOwner())), { code: "MANAGED_HOST_MODEL_CREDENTIAL_INVALID" });
  assert.equal(truthy.counts().permitBinds, 1); assert.equal(truthy.host.getEndpoint(), null);
});
test("late owner receipt cannot publish after exact product epoch retirement", async t => {
  const wait = deferred(), f = await activate(t, { ownerWait: wait }), lease = await f.api.acquireModelLease(scope());
  const owner = f.api.captureModelOwner(), pending = lease.getCredentialOwner(), rejected = assert.rejects(pending, { code: "MANAGED_HOST_MODEL_LEASE_RETIRED" });
  await tick(); f.host.stop({ operationId: "stop-pending-owner" }); assert.equal(f.api.isModelOwnerCurrent(owner), false);
  wait.resolve(); await rejected; await f.host.waitForOperation("stop-pending-owner"); assert.equal(f.counts().ownerReads, 1); assert.equal(f.counts().permitBinds, 0);
});
test("only private config.patch accepts closed candidate/previous third option; metadata call shape stays unchanged", async t => {
  const f = await activate(t), lease = await f.api.acquireModelLease(scope());
  for (const [method, options] of [["config.get", { credentialPhase: "candidate" }], ["config.patch", { credentialPhase: "history" }],
    ["config.patch", { credentialPhase: "candidate", secret: "x" }]]) assert.throws(() => lease.modelRpc(method, {}, options), { code: "MANAGED_MODEL_CREDENTIAL_CONTRACT_INVALID" });
  assert.equal(f.counts().effects, 0); await lease.modelRpc("config.get", {}, undefined);
  await lease.modelRpc("config.patch", {}, { credentialPhase: "candidate" }); await lease.modelRpc("config.patch", {}, { credentialPhase: "previous" });
  assert.equal(f.counts().effects, 3);
});
