#!/usr/bin/env node
"use strict";

// Execute the actual desktop OpenClaw composition block. The Worker/client and
// config RPC transport below are credentialless boundary doubles, not Host proof.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { createHermesModelMutationGate } = require("../app/core/hermes-model-mutation");
const { createWorkAdmissionGate } = require("../app/core/work-admission-gate");
const { createOpenClawRuntimeApply } = require("../app/core/openclaw-runtime-apply");
const { createOpenClawModelChange } = require("../app/core/openclaw-model-change");
const { createManagedOpenClawModelApply } = require("../app/core/managed-openclaw-model-apply");
const { createManagedOpenClawProductHost } = require("../app/managed-openclaw-product-host");
const { createManagedOpenClawProductAuth } = require("../app/managed-openclaw-product-auth");
const { createManagedOpenClawProviderCredentialBroker } = require("../app/managed-openclaw-provider-credential-broker");
const { createManagedOpenClawEndpointGeneration } = require("../app/managed-openclaw-endpoint-generation");
const { createOpenclawHostController } = require("../app/openclaw-host");
const { normalizeModelChangeRequest, modelChangeRequestDigest } = require("../app/core/model-change-validation");
const sourceFiles = [
  "app/ui-entry.js", "app/core/openclaw-backend.js", "app/core/backend-registry.js",
  "app/managed-openclaw-product-host.js", "app/managed-openclaw-product-model-api.js",
  "app/managed-openclaw-product-auth.js", "app/managed-openclaw-endpoint-generation.js",
  "app/core/managed-openclaw-model-apply.js", "app/core/openclaw-model-change.js",
  "app/core/openclaw-model-references.js", "app/core/model-validation.js",
  "app/core/openclaw-agent-config.js", "app/core/model-change-validation.js",
  "app/core/work-admission-gate.js", "app/core/openclaw-runtime-apply.js", "app/openclaw-host.js",
  "app/core/device-auth.js", "app/core/upstream-endpoint-generation.js", "app/core/openclaw-local-runtime-scope.js",
  "app/managed-openclaw-provider-credential-broker.js", "app/agent-service/client.js",
  "app/managed-openclaw-auth-profile-constants.js", "app/managed-openclaw-auth-profile-scope.js",
  "app/openclaw-provider-credential-operation.js",
  "app/agent-service/service-protocol-version.js", "app/agent-service/external-provider-credential-controller.js",
  "scripts/plugin-managed-model-composition-regression.cjs",
];
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file => [file, sha(fs.readFileSync(path.join(ROOT, file)))]));
const source = fs.readFileSync(path.join(ROOT, "app/ui-entry.js"), "utf8");
const START = "    const workAdmissionGate = createWorkAdmissionGate();";
const END = "    const hermesBackend = new HermesBackend({";
assert.equal(source.split(START).length, 2, "desktop composition start must be unique");
assert.equal(source.split(END).length, 2, "desktop composition end must be unique");
const start = source.indexOf(START), end = source.indexOf(END, start);
assert(end > start);
const composition = source.slice(start, end);
const activeRoots = new Set();
const clone = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function merge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete target[key];
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== "object") target[key] = {};
      merge(target[key], value);
    } else target[key] = clone(value);
  }
}
const safeSpec = () => normalizeModelChangeRequest({ providerKey: "local", model: { id: "new", name: "NEW" } }).safeSpec;

async function fixture(options = {}) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sg-managed-model-composition-"));
  activeRoots.add(temporaryRoot);
  const config = { gatewayUrl: "ws://127.0.0.1:9", token: "fixture-unusable-token", openclawPluginHostMode: "managed", disabledBackends: [] };
  const modelConfig = { models: { providers: { local: { baseUrl: "http://127.0.0.1:9", api: "openai-completions", models: [] } } }, agents: { defaults: {} } };
  const events = [], brands = new WeakSet(), rawRecords = [];
  let physicalState = "absent", createCount = 0;
  const hash = () => sha(JSON.stringify(modelConfig));
  const rpc = async (method, params, operationId) => {
    if (method === "config.get") return { parsed: clone(modelConfig), hash: hash() };
    if (method === "models.list") return { models: Object.entries(modelConfig.models.providers).flatMap(([provider, row]) => row.models.map(model => ({ ...clone(model), provider }))) };
    if (method === "sessions.list") return { sessions: [], hasMore: false };
    if (method === "cron.list") return { jobs: [], hasMore: false };
    if (method === "tasks.list") return { supported: true, tasks: [], hasMore: false };
    assert(["config.patch", "config.set"].includes(method), "controlled RPC must use an explicit fixed method");
    assert(operationId, "ordinary config writes are forbidden");
    assert.equal(params.baseHash, hash());
    assert.equal(typeof params.raw, "string"); if (method === "config.patch") assert(Array.isArray(params.replacePaths));
    events.push({ kind: "config-write", operationId });
    if (method === "config.set") { for (const key of Object.keys(modelConfig)) delete modelConfig[key]; Object.assign(modelConfig, JSON.parse(params.raw)); }
    else merge(modelConfig, JSON.parse(params.raw));
    return { ok: true };
  };
  const client = {
    ready: Promise.resolve(),
    getStatus: () => ({ state: physicalState, ownership: ["absent", "closed", "stopped"].includes(physicalState) ? "absent" : "managed", selectionSupported: physicalState === "running" }),
    getEndpoint: () => physicalState === "running" ? { url: "ws://127.0.0.1:9", token: "fixture-private-unusable-token" } : null,
    getExecution: () => physicalState === "running" ? { home: path.join(temporaryRoot, "home") } : null,
    controller: {
      getCandidate: async () => ({ candidateId: "a".repeat(64) }),
      prepareCandidate: async () => { throw new Error("no clone permitted in composition unit"); },
      activateCandidate: async () => { physicalState = "running"; events.push({ kind: "controlled-activation" }); return { healthVerified: true }; },
      stopOwned: async () => { physicalState = "stopped"; events.push({ kind: "controlled-owned-stop" }); for (const record of rawRecords) record.retired = true; },
    },
    close: async () => { physicalState = "closed"; events.push({ kind: "controlled-owned-close" }); for (const record of rawRecords) record.retired = true; },
  };
  client.modelApi = {
    isModelApplySupported: async () => physicalState === "running",
    assertModelLease: async (raw, identity) => brands.has(raw) && !rawRecords.find(row => row.raw === raw)?.retired
      && raw.operationId === identity.operationId && raw.requestDigest === identity.requestDigest,
    acquireModelLease: async input => {
      assert.equal(input.requestDigest, modelChangeRequestDigest(input.safeSpec));
      events.push({ kind: "private-acquire", operationId: input.operationId, recovery: input.recovery === true });
      physicalState = "paused";
      const record = { retired: false, paused: true, raw: null };
      const raw = { operationId: input.operationId, requestDigest: input.requestDigest, token: "synthetic-private-model-lease", expiresAt: Date.now() + 60000,
        async assertIdle() { return true; },
        async renew() { raw.expiresAt = Date.now() + 60000; return { expiresAt: raw.expiresAt }; },
        async modelRpc(method, params) { assert.equal(record.retired, false); events.push({ kind: "private-rpc", method, operationId: input.operationId }); return rpc(method, params, input.operationId); },
        async restartPaused() { assert(record.paused); return true; },
        async waitHealthy() { assert(record.paused); return true; },
        async verifyTarget(spec) { assert(record.paused); const found = modelConfig.models.providers[spec.providerKey]?.models.find(row => row.id === spec.model?.id); return !!found; },
        async convergeAfterRetire() { assert(record.paused); return true; },
        async finish(result) {
          assert.equal(result.operationId, input.operationId); assert.equal(result.requestDigest, input.requestDigest);
          events.push({ kind: "private-finish", outcome: result.outcome, operationId: input.operationId });
          if (options.finishReceipt !== undefined) return options.finishReceipt;
          record.paused = false; record.retired = true; physicalState = "running";
          return { paused: false, resumed: true, healthVerified: true };
        },
        async abandon() { events.push({ kind: "private-abandon", operationId: input.operationId }); record.retired = true; physicalState = "paused"; return { paused: true, resumed: false }; },
      };
      brands.add(raw); record.raw = raw; rawRecords.push(record); return raw;
    },
  };
  const sandbox = {
    path, crypto, process, __dirname: path.join(ROOT, "app"),
    app: { isPackaged: false, getPath: name => { assert.equal(name, "userData"); return temporaryRoot; } },
    shoggothServicePaths: { stateDir: temporaryRoot, runtimeDir: temporaryRoot,
      socketPath: path.join(temporaryRoot, "credential-fixture.sock"), tokenPath: path.join(temporaryRoot, "credential-fixture-token") },
    readConfig: () => config,
    configStore: { write: patch => Object.assign(config, patch) },
    legacyOpenClawAuth: { getGatewayUrl: () => config.gatewayUrl },
    serverOrigin: "http://127.0.0.1:9",
    openClawEndpointGeneration: 0,
    gatewayProxy: { invalidateOpenClawUpstream: () => events.push({ kind: "ordinary-withdrawal" }) },
    resolveOpenclawBin: () => null, // resolving this controlled input never runs a CLI
    resolveManagedOpenClawProductInputs: () => ({}),
    createWorkAdmissionGate, createHermesModelMutationGate, createOpenclawHostController, BackendRegistry, OpenClawBackend,
    createManagedOpenClawProductHost, createManagedOpenClawProductAuth, createManagedOpenClawProviderCredentialBroker,
    createOpenClawRuntimeApply, createOpenClawModelChange, createManagedOpenClawModelApply,
    require: name => {
      if (name === "./agent-service/external-plugin-adapter-auth") return { ensureCredential: () => events.push({ kind: "credential-boundary-not-executed" }) };
      if (name === "./managed-openclaw-host-client") return { createManagedOpenClawHostClient: () => { createCount++; return client; } };
      throw new Error(`unanticipated desktop composition import ${name}`);
    },
  };
  sandbox.openClawCredentialGeneration = createManagedOpenClawEndpointGeneration({ getConfig: () => config,
    isManaged: () => sandbox.managedOpenClawProductHost?.isManaged() === true,
    getOwnerGeneration: () => sandbox.openClawEndpointGeneration });
  vm.runInNewContext(composition + "\nglobalThis.composed = { openclawBackend, managedOpenClawModelChange, workAdmissionGate, registry };", sandbox,
    { filename: "app/ui-entry.js:actual-OpenClaw-composition", timeout: 1000 });
  const { openclawBackend: backend, managedOpenClawModelChange: core, workAdmissionGate: gate, registry } = sandbox.composed;
  const host = sandbox.managedOpenClawProductHost;
  registry.register(backend);
  backend.request = async (method, params) => {
    assert.equal(host.getStatus().state, "running", "ordinary reads must not regain a paused endpoint");
    assert.notEqual(method, "config.patch");
    events.push({ kind: "ordinary-rpc", method }); return rpc(method, params, null);
  };
  const context = async (spec, operationId) => {
    const preview = await core.preview(spec);
    return { operationId, requestDigest: modelChangeRequestDigest(spec), journalEntry: { mode: "native-config", stage: "preflight", commitState: "precommit", fingerprints: preview.fingerprints },
      assertProviderLease() {},
      async recordStage(stage) { events.push({ kind: "stage", stage }); if (options.onStage) await options.onStage(stage); },
      async recordStep() {}, async markCommitting() {}, async markCommitted() { events.push({ kind: "commit", operationId }); },
    };
  };
  async function dispose() { try { sandbox.managedOpenClawCredentialBroker?.retire(); await host.close(); await backend.stop(); } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); activeRoots.delete(temporaryRoot); } }
  host.prepare({ operationId: "prepare-composition" });
  const activated = await host.waitForOperation("prepare-composition");
  assert.equal(activated.state, "running", JSON.stringify(activated));
  assert.equal(createCount, 1);
  assert.equal(backend.stop, OpenClawBackend.prototype.stop, "stop must be the actual production method");
  return { host, backend, core, gate, client, config, modelConfig, events, rawRecords, context, dispose,
    generation: () => sandbox.openClawEndpointGeneration,
  };
}

const groups = [];
const test = (name, run) => groups.push({ name, run });
test("actual own model withdrawal preserves Core scope through one write and exact finish", async () => {
  const f = await fixture();
  try {
    const spec = safeSpec(), context = await f.context(spec, "own-model-transaction");
    const first = f.events.length, before = f.backend._connectionGeneration;
    const result = await f.core.apply(spec, context);
    assert.equal(result.status, "applied");
    const during = f.events.slice(first);
    assert.equal(during.filter(row => row.kind === "config-write").length, 1);
    assert.equal(during.filter(row => row.kind === "private-finish").length, 1);
    assert.equal(during.filter(row => row.kind === "private-acquire").length, 1);
    assert.equal(during.filter(row => row.kind === "ordinary-withdrawal").length, 1);
    assert(f.backend._connectionGeneration > before, "actual Backend.stop must withdraw its ordinary socket");
    assert(during.findIndex(row => row.kind === "commit") < during.findIndex(row => row.kind === "private-finish"));
    assert.equal(f.gate.snapshot("openclaw").draining, false);
    assert.equal(f.host.getStatus().state, "running"); assert(f.host.getEndpoint());
    return { configWrites: 1, owningAcquires: 1, verifiedFinishes: 1, actualBackendStop: true, localDrainReleased: true };
  } finally { await f.dispose(); }
});
test("foreign owned stop retires delayed Core transaction before any write or resume", async () => {
  const reached = deferred(), release = deferred();
  const f = await fixture({ onStage: async stage => { if (stage === "config-save") { reached.resolve(); await release.promise; } } });
  try {
    const spec = safeSpec(), pending = f.core.apply(spec, await f.context(spec, "stop-owned-model-transaction"));
    await reached.promise;
    f.host.stop({ operationId: "foreign-owned-stop" }); await f.host.waitForOperation("foreign-owned-stop");
    release.resolve(); const result = await pending;
    assert.equal(result.status, "partial"); assert.equal(result.needsVerification, true);
    assert.equal(f.events.filter(row => row.kind === "config-write").length, 0);
    assert.equal(f.events.filter(row => row.kind === "private-finish").length, 0);
    assert.equal(f.host.getStatus().state, "stopped"); assert.equal(f.host.getEndpoint(), null);
    assert.equal(f.gate.snapshot("openclaw").drainCount, 0, "exact trusted owned exit must release the retired Core scope drain");
    return { configWrites: 0, verifiedFinishes: 0, stopped: true, needsVerification: true, drainCount: f.gate.snapshot("openclaw").drainCount };
  } finally { release.resolve(); await f.dispose(); }
});
test("foreign disable and suspend block delayed model transaction without ordinary fallback", async () => {
  const reached = deferred(), release = deferred();
  const f = await fixture({ onStage: async stage => { if (stage === "config-save") { reached.resolve(); await release.promise; } } });
  try {
    const spec = safeSpec(), pending = f.core.apply(spec, await f.context(spec, "disabled-model-transaction"));
    await reached.promise;
    f.config.disabledBackends.push("openclaw"); await f.host.suspend({ operationId: "disabled-owned-close" });
    release.resolve(); const result = await pending;
    assert.equal(result.status, "partial"); assert.equal(result.needsVerification, true);
    assert.equal(f.events.filter(row => row.kind === "config-write").length, 0);
    assert.equal(f.events.filter(row => row.kind === "private-finish").length, 0);
    assert.equal(f.host.getEndpoint(), null); assert.equal(f.host.getExecution(), null);
    return { configWrites: 0, verifiedFinishes: 0, disabled: true, needsVerification: true };
  } finally { release.resolve(); await f.dispose(); }
});
test("same-operation recovery has a new attempt and old handle cannot withdraw it", async () => {
  const options = {}, f = await fixture(options);
  try {
    const spec = safeSpec(), scope = { operationId: "recover-original-operation", requestDigest: modelChangeRequestDigest(spec), safeSpec: spec };
    const api = f.host.getModelApplyApi(), old = await api.acquireModelLease(scope);
    assert.equal(await old.abandon({ reason: "nonterminal_outcome" }), true);
    assert.equal(api.canRecoverModelLease(scope), true);
    const current = await api.acquireModelLease({ ...scope, recovery: true }), before = f.generation();
    await assert.rejects(old.modelRpc("config.patch", {}), { code: "MANAGED_HOST_MODEL_LEASE_RETIRED" });
    assert.equal(f.generation(), before); assert.equal(f.host.getStatus().state, "activating");
    assert.equal(await api.assertModelLease(current, scope), true);
    assert.equal(f.events.filter(row => row.kind === "config-write").length, 0);
    options.finishReceipt = undefined;
    assert.equal(await current.finish({ ...scope, outcome: "blocked" }), true);
    assert.equal(f.host.getStatus().state, "running");
    return { staleRawEffects: 0, staleWithdrawals: 0, currentAttemptBrandVerified: true, exactRecoveryFinished: true };
  } finally { await f.dispose(); }
});
test("unknown terminal finish permits no second acquire or speculative config write", async () => {
  const f = await fixture({ finishReceipt: { paused: false } });
  try {
    const spec = safeSpec(), scope = { operationId: "terminal-unknown-original-operation", requestDigest: modelChangeRequestDigest(spec), safeSpec: spec };
    const api = f.host.getModelApplyApi(), old = await api.acquireModelLease(scope);
    await assert.rejects(old.finish({ ...scope, outcome: "blocked" }), { code: "MANAGED_HOST_MODEL_RESUME_UNVERIFIED" });
    assert.equal(api.canRecoverModelLease(scope), true);
    assert.equal(api.canRecoverCredentialTerminal(scope), true);
    const acquisitions = f.events.filter(row => row.kind === "private-acquire").length, generation = f.generation();
    assert.throws(() => api.acquireModelLease({ ...scope, recovery: true }), { code: "MANAGED_HOST_MODEL_TERMINAL_RECOVERY_REQUIRED" });
    assert.equal(f.events.filter(row => row.kind === "private-acquire").length, acquisitions);
    assert.equal(f.events.filter(row => row.kind === "config-write").length, 0);
    assert.equal(f.events.filter(row => row.kind === "private-finish").length, 1);
    assert.equal(f.generation(), generation);
    assert.equal(f.host.getEndpoint(), null);
    return { owningAcquires: acquisitions, terminalFinishes: 1, automaticReplay: 0, terminalObservationRequired: true };
  } finally { await f.dispose(); }
});
test("exact paused abandonment projects true and never reopens the product endpoint", async () => {
  const f = await fixture();
  try {
    const spec = safeSpec(), scope = { operationId: "abandon-original-operation", requestDigest: modelChangeRequestDigest(spec), safeSpec: spec };
    const api = f.host.getModelApplyApi(), lease = await api.acquireModelLease(scope);
    assert.equal(await lease.abandon({ reason: "nonterminal_outcome" }), true);
    assert.equal(f.host.getStatus().state, "needs_verification"); assert.equal(f.host.getEndpoint(), null);
    assert.equal(api.canRecoverModelLease(scope), true);
    assert.equal(f.events.filter(row => row.kind === "private-finish").length, 0);
    return { verifiedPausedAbandonment: true, endpointReopened: false, originalRecoveryRetained: true };
  } finally { await f.dispose(); }
});

(async () => {
  const before = sourceHashes(), results = [];
  for (const group of groups) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`bounded group expired: ${group.name}`)), 5000); });
    let evidence;
    try { evidence = await Promise.race([group.run(), timeout]); } finally { clearTimeout(timer); }
    results.push({ name: group.name, passed: true, evidence });
    process.stdout.write(`PASS ${group.name}\n`);
  }
  const after = sourceHashes(); assert.deepEqual(after, before, "production sources changed during proof; rerun required");
  const evidence = { version: 1, verified: true, generatedAt: new Date().toISOString(), groupsPassed: results.length,
    evidenceType: "actual-desktop-composition-controlled-worker-boundary", realHostProcesses: 0, realModels: 0, userCredentials: 0,
    pausedSkillsRun: 0, sourceHashes: before,
    extractedComposition: { file: "app/ui-entry.js", startMarker: START.trim(), endMarker: END.trim(), sha256: sha(composition) },
    limitations: ["Worker/client/config RPC are explicit credentialless boundary doubles; no real Host, managed config writer or model verified",
      "Desktop Electron startup, HTTP model coordinator/journal persistence and cross-process recovery are outside this fixture",
      "Foreign lifecycle cancellation remains needs_verification; no automatic retry or synthetic terminal recovery"], results };
  const flag = process.argv.indexOf("--evidence");
  if (flag !== -1) { assert(process.argv[flag + 1]); fs.writeFileSync(path.resolve(process.argv[flag + 1]), JSON.stringify(evidence, null, 2) + "\n"); }
  process.stdout.write(`${results.length}/${groups.length} actual desktop composition boundary groups passed; real Host/model/credentials/paused Skills: 0\n`);
})().catch(error => {
  for (const root of activeRoots) fs.rmSync(root, { recursive: true, force: true });
  process.stderr.write(`${error.stack}\n`); process.exitCode = 1;
});
