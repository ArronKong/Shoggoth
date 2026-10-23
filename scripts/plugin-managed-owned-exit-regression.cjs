#!/usr/bin/env node
"use strict";
// Actual Product/Core/Admission modules with an explicit credentialless Client
// boundary double. This is not a real Host, model, Electron or disk-writer proof.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createManagedOpenClawProductHost } = require("../app/managed-openclaw-product-host");
const { createManagedOpenClawModelApply } = require("../app/core/managed-openclaw-model-apply");
const { createWorkAdmissionGate } = require("../app/core/work-admission-gate");
const { normalizeModelChangeRequest, modelChangeRequestDigest } = require("../app/core/model-change-validation");
const ROOT = path.resolve(__dirname, "..");
const files = ["app/core/managed-openclaw-model-apply.js", "app/managed-openclaw-product-model-api.js", "app/managed-openclaw-product-host.js", "app/core/work-admission-gate.js", "scripts/plugin-managed-owned-exit-regression.cjs"];
const sha = data => crypto.createHash("sha256").update(data).digest("hex");
const hashes = () => Object.fromEntries(files.map(file => [file, sha(fs.readFileSync(path.join(ROOT, file)))]));
const baseline = process.argv.includes("--expect-stuck");
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const safeSpec = () => normalizeModelChangeRequest({ providerKey: "local", model: { id: "new", name: "NEW" } }).safeSpec;
async function fixture(options = {}) {
  let physical = "absent", retired = false, acquires = 0, writes = 0, finishes = 0, unknownStop = false;
  let core;
  const gate = createWorkAdmissionGate(), brands = new WeakSet(), proofs = [], records = [];
  const config = { models: { providers: { local: { baseUrl: "http://127.0.0.1:9", api: "openai-completions", models: [] } } }, agents: { defaults: {} } };
  const rpc = async (method) => {
    if (method === "config.get") return { parsed: JSON.parse(JSON.stringify(config)), hash: sha(JSON.stringify(config)) };
    if (method === "models.list") return { models: [] };
    if (method === "sessions.list") return { sessions: [], hasMore: false };
    if (method === "cron.list") return { jobs: [], hasMore: false };
    if (method === "tasks.list") return { supported: true, tasks: [], hasMore: false };
    if (method === "config.patch") { writes++; return { ok: true }; }
    throw new Error(`Unlisted boundary method: ${method}`);
  };
  const client = {
    ready: Promise.resolve(),
    getStatus: () => ({ state: physical, ownership: ["absent", "closed", "stopped"].includes(physical) ? "absent" : physical === "unknown" ? "unknown" : "managed", selectionSupported: physical === "running" }),
    getEndpoint: () => physical === "running" ? { url: "ws://127.0.0.1:9", token: "synthetic-private-token" } : null,
    getExecution: () => physical === "running" ? { home: "/private/synthetic-only" } : null,
    controller: {
      getCandidate: async () => ({ candidateId: "a".repeat(64) }), prepareCandidate: async () => { throw new Error("No dependency copy"); },
      activateCandidate: async () => { physical = "running"; retired = false; return { healthVerified: true }; },
      stopOwned: async () => { physical = unknownStop ? "unknown" : "absent"; retired = true; for (const record of records) record.retired = true; },
    },
    close: async () => { physical = unknownStop ? "unknown" : "closed"; retired = true; for (const record of records) record.retired = true; },
  };
  client.modelApi = {
    isModelApplySupported: async () => { if (options.supportWait) await options.supportWait.promise; return physical === "running"; },
    assertModelLease: async (raw, identity) => brands.has(raw) && !retired && !records.find(row => row.raw === raw)?.retired && raw.operationId === identity.operationId && raw.requestDigest === identity.requestDigest,
    acquireModelLease: async identity => {
      acquires++; physical = "paused";
      if (options.lostAcquireAck) throw Object.assign(new Error("synthetic lost acquire acknowledgement"), { code: "MANAGED_HOST_MODEL_ACK_UNKNOWN" });
      const record = { retired: false, raw: null };
      const raw = { operationId: identity.operationId, requestDigest: identity.requestDigest, token: "synthetic-private-lease", expiresAt: Date.now() + 60000,
        assertIdle: async () => true, renew: async () => ({ expiresAt: Date.now() + 60000 }), modelRpc: rpc,
        restartPaused: async () => true, waitHealthy: async () => true, verifyTarget: async () => true, convergeAfterRetire: async () => true,
        finish: async () => { finishes++; physical = "running"; record.retired = true; return { paused: false, resumed: true, healthVerified: true }; },
        abandon: async () => { if (record.retired) throw Object.assign(new Error("retired"), { code: "MANAGED_HOST_MODEL_LEASE_RETIRED" }); return { paused: true, resumed: false }; },
      }; record.raw = raw; records.push(record); brands.add(raw); return raw;
    },
  };
  const host = createManagedOpenClawProductHost({ getMode: () => "managed", setManagedMode() {}, createClient: () => client,
    onUnavailable: async () => { core?.runtimeApply.invalidateConnectionGeneration(); }, onModelUnavailable: async () => {},
    onOwnedExit: proof => { proofs.push(proof); return core.releaseAfterOwnedExit(proof); },
  });
  core = createManagedOpenClawModelApply({ backend: { request: rpc }, modelController: host.getModelApplyApi(), admissionGate: gate });
  host.prepare({ operationId: "prepare-initial" }); assert.equal((await host.waitForOperation("prepare-initial")).state, "running");
  const context = async (operationId) => {
    const spec = safeSpec(), preview = await core.preview(spec);
    return { operationId, requestDigest: modelChangeRequestDigest(spec), journalEntry: { commitState: "precommit", fingerprints: preview.fingerprints }, assertProviderLease() {},
      async recordStage(stage) { if (options.onStage) await options.onStage(stage); }, async recordStep() {}, async markCommitting() {}, async markCommitted() {},
    };
  };
  const stop = async (operationId) => { host.stop({ operationId }); return host.waitForOperation(operationId); };
  const restart = async (operationId) => { host.restart({ operationId }); return host.waitForOperation(operationId); };
  return { host, core, gate, proofs, context, stop, restart, client, counts: () => ({ acquires, writes, finishes }),
    unknownStop: value => { unknownStop = value; }, dispose: () => { unknownStop = false; return host.close(); } };
}
const groups = [];
function test(name, run) { groups.push({ name, run }); }
function enterChat(gate) { const leave = gate.enter("openclaw", "chat"); leave(); }

test("lost acquire acknowledgement survives owned stop/restart without replaying original operation", async () => {
  const f = await fixture({ lostAcquireAck: true });
  try {
    const spec = safeSpec(), context = await f.context("lost-ack-original");
    const result = await f.core.apply(spec, context);
    assert.equal(result.needsVerification, true); assert.equal(f.gate.snapshot("openclaw").drainCount, 1);
    if (!baseline) {
      assert.throws(() => f.core.releaseAfterOwnedExit(Object.freeze({})), { code: "managed_model_owned_exit_untrusted" });
      assert.equal(f.gate.snapshot("openclaw").drainCount, 1);
      f.unknownStop(true); assert.equal((await f.stop("unknown-stop")).state, "needs_verification");
      assert.equal(f.proofs.length, 0); assert.equal(f.gate.snapshot("openclaw").drainCount, 1);
      f.unknownStop(false);
    }
    assert.equal((await f.stop("known-stop")).state, "stopped");
    assert.equal((await f.restart("known-restart")).state, "running");
    assert.equal(f.gate.snapshot("openclaw").drainCount, baseline ? 1 : 0);
    if (baseline) assert.throws(() => enterChat(f.gate), { code: "gateway_draining" }); else enterChat(f.gate);
    await assert.rejects(f.core.apply(spec, context), { code: "managed_model_requires_recovery" });
    assert.deepEqual(f.counts(), { acquires: 1, writes: 0, finishes: 0 });
    return { knownOwnedStop: true, restartedEndpoint: true, ordinaryChatBlocked: baseline, uncertainOperationCannotRemint: true, configWrites: 0 };
  } finally { await f.dispose(); }
});
test("owned stop racing active Core finally cannot re-create the exited writer hold", async () => {
  const reached = deferred(), release = deferred(), f = await fixture({ onStage: async stage => { if (stage === "preflight") { reached.resolve(); await release.promise; } } });
  try {
    const spec = safeSpec(), context = await f.context("active-finally-original"), pending = f.core.apply(spec, context);
    await reached.promise; assert.equal(f.gate.snapshot("openclaw").drainCount, 1);
    assert.equal((await f.stop("active-known-stop")).state, "stopped");
    if (!baseline) assert.equal(f.gate.snapshot("openclaw").drainCount, 0, "trusted exit releases the still-active scope's own hold");
    release.resolve(); const result = await pending;
    assert.equal(result.needsVerification, true); assert.equal(f.gate.snapshot("openclaw").drainCount, baseline ? 1 : 0);
    assert.equal((await f.restart("active-known-restart")).state, "running");
    if (baseline) assert.throws(() => enterChat(f.gate), { code: "gateway_draining" }); else enterChat(f.gate);
    await assert.rejects(f.core.apply(spec, context), { code: "managed_model_requires_recovery" });
    assert.equal(f.counts().writes, 0); assert.equal(f.counts().finishes, 0);
    return { activeFinallyRace: true, originalPromptScopeRetired: true, oldHoldRecreated: baseline, configWrites: 0, finishes: 0 };
  } finally { release.resolve(); await f.dispose(); }
});
if (!baseline) {
  test("an old opaque exit proof never releases a new generation's unresolved hold", async () => {
    const f = await fixture({ lostAcquireAck: true });
    try {
      await f.core.apply(safeSpec(), await f.context("old-generation"));
      await f.stop("old-generation-stop"); const old = f.proofs.at(-1);
      assert(old && Object.keys(old).length === 0 && JSON.stringify(old) === "{}");
      await f.restart("new-generation-start");
      await f.core.apply(safeSpec(), await f.context("new-generation"));
      assert.equal(f.gate.snapshot("openclaw").drainCount, 1);
      assert.deepEqual(f.core.releaseAfterOwnedExit(old), { released: 0 }); assert.equal(f.gate.snapshot("openclaw").drainCount, 1);
      assert.throws(() => f.core.releaseAfterOwnedExit(JSON.parse(JSON.stringify(old))), { code: "managed_model_owned_exit_untrusted" });
      assert.equal(f.gate.snapshot("openclaw").drainCount, 1);
      await f.stop("new-generation-stop"); assert.equal(f.gate.snapshot("openclaw").drainCount, 0);
      assert.equal(f.counts().acquires, 2); assert.equal(f.counts().writes, 0);
      return { sameClientDistinctOwnerEpochs: true, oldAndForgedProofReleaseNewHolds: 0, twoExactExitsVerified: true };
    } finally { await f.dispose(); }
  });
  test("owned exit waits for all raw capability RPCs before publishing any proof", async () => {
    const wait = deferred(), f = await fixture({ supportWait: wait });
    try {
      const pending = f.host.getModelApplyApi().isModelApplySupported(); await tick();
      f.host.stop({ operationId: "flight-known-stop" }); await tick();
      assert.equal(f.proofs.length, 0); assert.equal(f.host.getStatus().state, "stopping");
      wait.resolve(); assert.equal(await pending, false);
      assert.equal((await f.host.waitForOperation("flight-known-stop")).state, "stopped"); assert.equal(f.proofs.length, 1);
      assert.deepEqual(f.counts(), { acquires: 0, writes: 0, finishes: 0 });
      return { unsettledRawRPCProofs: 0, exactSettledOwnedExitProofs: 1 };
    } finally { wait.resolve(); await f.dispose(); }
  });
}
(async () => {
  const before = hashes(), results = [];
  for (const group of groups) {
    let timer;
    try {
      const evidence = await Promise.race([group.run(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`bounded proof expired: ${group.name}`)), 5000); })]);
      results.push({ name: group.name, evidence }); process.stdout.write(`PASS ${group.name}\n`);
    } finally { clearTimeout(timer); }
  }
  assert.deepEqual(hashes(), before, "source changed during this bounded proof");
  const result = { version: 1, verifiedAt: new Date().toISOString(), status: baseline ? "BUG_REPRODUCED" : "PASS", sourceHashes: before, groupsPassed: results.length,
    actualProductCoreAndAdmissionModules: true, clientBoundaryDouble: true, realHostProcesses: 0, modelRequests: 0, globalWrites: 0, remoteCalls: 0, results,
    scope: "Local Product/Core drain ownership and opaque-proof races; real Worker/Supervisor writer exit and ordinary model chat require separate true-Host proof" };
  const i = process.argv.indexOf("--evidence"); if (i !== -1) { assert(process.argv[i + 1]); fs.writeFileSync(path.resolve(process.argv[i + 1]), JSON.stringify(result, null, 2) + "\n"); }
  process.stdout.write(`${results.length}/${groups.length} owned-exit ${baseline ? "reproduction" : "regression"} groups passed; real Host/model/remote: 0\n`);
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
