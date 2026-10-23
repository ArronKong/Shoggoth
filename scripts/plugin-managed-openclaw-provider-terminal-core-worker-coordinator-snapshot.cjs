#!/usr/bin/env node
"use strict";
// Actual Core/Base/ALS, Product, Main credential broker, genuine Node Worker,
// formal Service/RPC/Controller and AES encrypted Store with cold reopen.
// Candidate/activation/revision, ordinary read-only Backend and the small WS
// Gateway/physical verifier are controlled. NOT fixed Host/real model/Keychain.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { Worker } = require("node:worker_threads"), { spawnSync } = require("node:child_process");
const { WebSocket } = require("ws");
const repo = path.resolve(__dirname, "..");
const { createAgentService } = require(path.join(repo, "app/agent-service/server"));
const { resolveServicePaths } = require(path.join(repo, "app/agent-service/paths"));
const { requestService, readClientToken } = require(path.join(repo, "app/agent-service/client"));
const { SERVICE_PROTOCOL_VERSION } = require(path.join(repo, "app/agent-service/service-protocol-version"));
const { createManagedOpenClawHostClient } = require(path.join(repo, "app/managed-openclaw-host-client"));
const { createManagedOpenClawProductModelApi } = require(path.join(repo, "app/managed-openclaw-product-model-api"));
const { createManagedOpenClawProviderCredentialBroker } = require(path.join(repo, "app/managed-openclaw-provider-credential-broker"));
const { normalizeModelChangeRequest, modelChangeRequestDigest } = require(path.join(repo, "app/core/model-change-validation"));
const { createManagedOpenClawModelApply } = require(path.join(repo, "app/core/managed-openclaw-model-apply"));
const { createWorkAdmissionGate } = require(path.join(repo, "app/core/work-admission-gate"));
const pins = require(path.join(repo, "app/managed-openclaw-runtime-pins.json"));
const NODE = (process.env.SHOGGOTH_TEST_OPENCLAW_NODE || require('node:path').join(require('node:os').homedir(), '.local', 'share', 'node', 'v24.21.0', 'bin', 'node')), SOURCE = "/opt/homebrew/lib/node_modules/openclaw";
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-credential-core-worker-")); fs.chmodSync(root, 0o700);
const privateDir = name => { const dir = path.join(root, name); fs.mkdirSync(dir, { mode: 0o700, recursive: true }); return dir; };
const runtimeRoot = privateDir("controlled-runtime"), dropFile = path.join(root, "drop-settle-ack"), settleTrace = path.join(root, "controlled-settle-invocations.jsonl");
const clients = [], writers = [], cases = [], verifierCalls = [], faults = [];
let service, closed = false, productCurrent = true, verifierCurrent = true, holdRead = null, serviceEpoch = 0;
const services = [], coreOperations = [], ordinaryCalls = [];
const sourceFiles = ["managed-openclaw-host-client.js", "managed-openclaw-host-worker.js", "managed-openclaw-host-supervisor.js",
  "managed-openclaw-product-model-api.js", "managed-openclaw-provider-credential.js", "managed-openclaw-provider-credential-schema.js",
  "managed-openclaw-provider-credential-client.js", "managed-openclaw-provider-credential-policy.js", "managed-openclaw-provider-credential-finish.js",
  "managed-openclaw-provider-credential-broker.js", "managed-openclaw-provider-terminal-recovery.js", "managed-openclaw-model-policy.js", "managed-openclaw-config-source-ledger.js",
  "managed-openclaw-config-revision.js", "agent-service/server.js", "agent-service/external-provider-credential-rpc.js",
  "agent-service/external-provider-credential-controller.js", "agent-service/external-provider-credential-writer.js",
  "agent-service/external-provider-credential-runtime.js", "agent-service/encrypted-secret-store.js", "agent-service/client.js",
  "core/model-change-validation.js", "agent-service/service-protocol-version.js", "agent-service/instance-state.js"].map(name => "app/" + name);
sourceFiles.push("scripts/plugin-managed-openclaw-provider-terminal-core-worker-coordinator-snapshot.cjs", "app/core/managed-openclaw-model-apply.js", "app/core/openclaw-model-change.js", "app/core/openclaw-model-references.js", "app/core/openclaw-agent-config.js", "app/core/work-admission-gate.js", "app/agent-service/external-provider-credential-writer-worker.js", "app/agent-service/private-file.js", "app/agent-service/external-provider-credential-reconciliation.js", "app/agent-service/paths.js", "app/agent-service/security.js");
sourceFiles.push("app/core/model-change-coordinator.js");
const sourceBefore = Object.fromEntries(sourceFiles.map(file => [file, hash(fs.readFileSync(path.join(repo, file)))]));
assert.equal(sourceBefore['app/core/model-change-coordinator.js'],'2f941f5836b10970c3a4537ee6404c216069a0863f5973938f2143f63b2dff11','trusted source snapshot must match fixed FIFO identity repair');
const originalEvidenceFiles=['scripts/plugin-managed-openclaw-provider-terminal-core-worker-joint.cjs','docs/architecture/plugin-managed-openclaw-provider-terminal-recovery-2026-09-28.md','docs/architecture/plugin-managed-openclaw-provider-terminal-recovery-evidence-2026-09-28.json'];
const originalEvidenceHashes=Object.fromEntries(originalEvidenceFiles.map(file=>[file,hash(fs.readFileSync(path.join(repo,file)))]));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const processStart = pid => { const r = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 1500 });
  if (r.error) throw r.error; return r.status === 0 ? r.stdout.trim() : null; };
function controlledGateway(repo) {
  const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), { WebSocketServer } = require(path.join(repo, "node_modules/ws"));
  const descriptor = JSON.parse(fs.readFileSync(process.env.OPENCLAW_SHOGGOTH_MANAGED_DESCRIPTOR, "utf8"));
  const configPath = process.env.OPENCLAW_CONFIG_PATH, bytes = fs.readFileSync(configPath), config = JSON.parse(bytes);
  const loadedHash = crypto.createHash("sha256").update(bytes).digest("hex"), generation = "controlled-" + crypto.randomUUID();
  const stateFile = path.join(descriptor.dataRoot, "controlled-health.json"), traceFile = path.join(descriptor.dataRoot, "controlled-trace.jsonl");
  let paused = true, operationId = descriptor.operationId;
  const proof = () => ({ version: 1, protocol: "openclaw-managed-v1", backendId: "openclaw", pid: process.pid,
    nonce: descriptor.nonce, generation, runtimeRoot: descriptor.runtimeRoot, runtimeTreeSha256: descriptor.runtimeTreeSha256,
    dataRoot: descriptor.dataRoot, paused, operationId, selectionSupported: true, adapterGeneration: "controlled-adapter",
    adapterInstanceId: "controlled-instance", modelReadProtocol: "openclaw-model-read-v1", snapshot: { idle: true, counts: { totalActive: 0 } } });
  function persist(method) { const temporary = stateFile + ".tmp"; fs.writeFileSync(temporary, JSON.stringify(proof()), { mode: 0o600 }); fs.renameSync(temporary, stateFile);
    fs.appendFileSync(traceFile, JSON.stringify({ method, pid: process.pid, nonce: descriptor.nonce, generation, paused, operationId }) + "\n", { mode: 0o600 }); }
  const server = new WebSocketServer({ host: "127.0.0.1", port: config.gateway.port }); persist("boot-paused");
  server.on("connection", socket => { let authenticated = false; socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: crypto.randomUUID() } }));
    socket.on("message", bytes => { const frame = JSON.parse(bytes.toString()); let value;
      try { if (frame.method === "connect") { if (frame.params.auth?.token !== config.gateway.auth.token) throw Error("auth"); authenticated = true; value = { type: "hello-ok" }; }
        else { if (!authenticated) throw Error("auth"); const params = frame.params;
          if (!frame.method.startsWith("gateway.shoggoth.managed.") || params.controlToken !== descriptor.controlToken || params.nonce !== descriptor.nonce
            || params.deadlineAt <= Date.now() || params.generation !== null && params.generation !== generation) throw Error("control");
          const kind = frame.method.slice("gateway.shoggoth.managed.".length);
          if (kind === "pause" || kind === "retire") { if (paused && operationId !== params.operationId) throw Error("foreign pause"); paused = true; operationId = params.operationId; persist(kind); value = proof(); }
          else if (kind === "resume") { if (!paused || operationId !== params.operationId) throw Error("foreign resume"); paused = false; operationId = null; persist(kind); value = proof(); }
          else if (kind === "status") { persist(kind); value = proof(); }
          else if (kind === "model.read") {
            if (!paused || operationId !== params.operationId) throw Error("model read pause");
            const catalog = Object.entries(config.models.providers).flatMap(([provider, entry]) => entry.models.map(model => ({ ...model, id: provider + "/" + model.id, provider })));
            const result = params.readMethod === "config.get" ? { exists: true, valid: true, path: configPath, hash: loadedHash }
              : params.readMethod === "models.list" ? { models: catalog } : params.readMethod === "sessions.list" ? { sessions: [] }
                : params.readMethod === "cron.list" ? { jobs: [] } : null;
            if (!result) throw Error("unsupported read"); persist("model.read:" + params.readMethod);
            value = { proof: proof(), readMethod: params.readMethod, requestDigest: params.requestDigest, value: result };
          } else throw Error("unsupported control"); }
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: value }));
      } catch { socket.send(JSON.stringify({ type: "res", id: frame.id, ok: false, error: { code: "CONTROLLED_GATEWAY_REJECTED", message: "controlled rejection" } })); }
    }); });
  process.on("SIGTERM", () => { for (const client of server.clients) client.terminate(); server.close(() => process.exit(0)); });
}
function controlledWorkerLoader(config) {
  const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), Module = require("node:module");
  const originalLoad = Module._load, originalResolve = Module._resolveFilename;
  const managerFile = path.join(config.repo, "app/managed-plugin-host-runtime.js"), revisionFile = path.join(config.repo, "app/managed-openclaw-config-revision.js");
  const channelFile = path.join(config.repo, "app/managed-openclaw-provider-credential-client.js");
  const manager = originalLoad(managerFile, module), channel = originalLoad(channelFile, module), authorities = new WeakMap();
  const pin = originalLoad(path.join(config.repo, "app/managed-openclaw-runtime-pins.json"), module).hosts.openclaw;
  const candidate = { backendId: "openclaw", candidateId: "1".repeat(64), runtimeRoot: config.runtimeRoot,
    runtimeTreeSha256: pin.outputTreeSha256, launch: { executable: config.node, args: [path.join(config.runtimeRoot, "openclaw.mjs")] } };
  Module._load = function(request, parent, isMain) {
    const file = originalResolve.call(Module, request, parent, isMain);
    if (file === revisionFile) return { matchesManagedConfigRevision(args) { args.assertCurrent(); return args.rawHash === args.projectedHash; } };
    if (file === channelFile) return { ...channel, createManagedOpenClawProviderCredentialClient(options) {
      const actual = channel.createManagedOpenClawProviderCredentialClient(options);
      return Object.freeze({ ...actual, async settle(...args) { fs.appendFileSync(config.settleTrace, JSON.stringify({ operationId: args[0].scope.operationId, requestDigest: args[0].scope.requestDigest }) + "\n", { mode: 0o600 }); const receipt = await actual.settle(...args);
        if (fs.existsSync(config.dropFile)) { fs.unlinkSync(config.dropFile); throw Object.assign(Error("controlled lost terminal acknowledgment"), { code: "CONTROLLED_SETTLE_ACK_LOST" }); }
        return receipt; } }); } };
    if (file === managerFile) return { ...manager,
      snapshotRuntimeTree(root, options) { return root === config.runtimeRoot ? { sha256: pin.outputTreeSha256, bytes: 0, records: [] } : manager.snapshotRuntimeTree(root, options); },
      createManagedHostRuntimeAuthority(controller) { const handle = manager.createManagedHostRuntimeAuthority(controller); authorities.set(handle, controller); return handle; },
      createManagedPluginHostRuntimeManager(options) {
        const controller = authorities.get(options.activationAuthority); let active = null;
        return Object.freeze({ inspectSource() { throw Error("controlled source inspection unsupported"); }, prepareCandidate() { throw Error("controlled copy unsupported"); },
          getCandidate() { return candidate; }, getActive() { return active; }, async activateCandidate(args) {
            if (args.candidateId !== candidate.candidateId) throw Error("foreign controlled candidate");
            const context = { backendId: "openclaw", candidate, operationId: args.operationId, nonce: crypto.randomBytes(32).toString("hex"),
              deadlineAt: Date.now() + 30000, signal: new AbortController().signal, assertCurrent() {} };
            const owner = await controller.inspectWriter(context); if (owner.ownership !== "absent") throw Error("existing controlled writer");
            const drain = await controller.acquireDrain(context); await controller.claimExclusiveDataFence(context);
            context.identity = await controller.startPaused(context); await controller.waitHealthy(context); await controller.assertIdle(context);
            await controller.resume(context); await drain.release(context); active = { candidateId: candidate.candidateId, identity: context.identity }; return active;
          } }); } };
    return originalLoad.call(Module, request, parent, isMain);
  };
  require(path.join(config.repo, "app/managed-openclaw-host-worker.js"));
}
fs.writeFileSync(path.join(runtimeRoot, "openclaw.mjs"), "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);(" + controlledGateway.toString() + ")(" + JSON.stringify(repo) + ");\n", { mode: 0o500 });
fs.mkdirSync(path.join(runtimeRoot, "dist"), { mode: 0o700 });
// Explicit controlled merge semantics; fixed OpenClaw merge source is part of
// future real-Host acceptance, not certified by this small candidate.
fs.writeFileSync(path.join(runtimeRoot, "dist/merge-patch-CzMe99iw.mjs"), "export function t(base,patch){const result=structuredClone(base);for(const [key,value]of Object.entries(patch)){if(value===null)delete result[key];else if(value&&typeof value==='object'&&!Array.isArray(value))result[key]=t(result[key]||{},value);else result[key]=structuredClone(value);}return result;}\n", { mode: 0o400 });
const bootstrap = path.join(root, "controlled-worker.cjs"); fs.writeFileSync(bootstrap, "(" + controlledWorkerLoader.toString() + ")(" + JSON.stringify({ repo, runtimeRoot, node: NODE, dropFile, settleTrace }) + ");\n", { mode: 0o600 });
const userDataRoot = privateDir("service"), paths = resolveServicePaths({ userDataRoot, cacheRoot: path.join(root, "service-cache"), trustedRoot: root });
const aesKey = crypto.randomBytes(32), cryptoCounts = { encrypt: 0, decrypt: 0 };
const cryptoBroker = { async open() {}, async close() {}, async encrypt(bytes) { cryptoCounts.encrypt++; const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  return Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]); }, async decrypt(bytes) { cryptoCounts.decrypt++; const cipher = crypto.createDecipheriv("aes-256-gcm", aesKey, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]); } };
async function verifyManagedWriter(writer, context) {
  const capturedServiceEpoch = serviceEpoch;
  context.assertCurrent(); verifierCalls.push({ operationId: writer.operationId, phase: context.phase, writerState:context.writerState||null, pid: writer.pid });
  if (holdRead && context.phase === "read" && writer.operationId === holdRead.operationId) { const barrier = holdRead; holdRead = null; barrier.entered.resolve(); await barrier.resume.promise; context.assertCurrent(); }
  const descriptorFile = path.join(writer.dataRoot, "managed-control.json"), fenceFile = path.join(writer.dataRoot, "writer.fence"), healthFile = path.join(writer.dataRoot, "controlled-health.json");
  const descriptor = read(descriptorFile), fence = read(fenceFile), proof = read(healthFile);
  assert.equal(writer.runtimeRoot, runtimeRoot); assert.equal(writer.interpreterPath, NODE); assert.equal(writer.entryPath, path.join(runtimeRoot, "openclaw.mjs"));
  assert.equal(writer.runtimeTreeSha256, pins.hosts.openclaw.outputTreeSha256); assert.equal(processStart(writer.pid), writer.startIdentity);
  assert.equal(descriptor.nonce, writer.nonce); assert.equal(fence.nonce, writer.nonce); assert.equal(proof.generation, writer.generation);
  assert.equal(proof.pid, writer.pid); assert.equal(proof.nonce, writer.nonce);
  if (context.phase === "advance") { assert.equal(processStart(context.previousWriter.pid), null); writers.push({ pid: writer.pid, startIdentity: writer.startIdentity, nonce: writer.nonce, generation: writer.generation }); }
  const expectedPaused = context.phase==="terminal-observe"?context.writerState==="paused":!(context.phase === "settle" && context.outcome !== "needs_verification");
  assert.equal(proof.paused, expectedPaused); assert.equal(proof.operationId, expectedPaused ? writer.operationId : null);
  const generation = proof.generation, inode = fs.lstatSync(fenceFile).ino;
  return () => { context.assertCurrent(); try { const current = read(healthFile), currentFence = read(fenceFile);
    return verifierCurrent && serviceEpoch === capturedServiceEpoch && processStart(writer.pid) === writer.startIdentity && fs.lstatSync(fenceFile).ino === inode
      && currentFence.nonce === writer.nonce && current.generation === generation && current.nonce === writer.nonce
      && current.pid === writer.pid && current.paused === expectedPaused && current.operationId === (expectedPaused ? writer.operationId : null);
  } catch { return false; } };
}
const direct = (method, params) => requestService(paths, { id: crypto.randomUUID(), version: SERVICE_PROTOCOL_VERSION,
  token: readClientToken(paths), method: "external.provider.credential." + method, params }, { timeoutMs: 10000 });
async function setup(label = "main", providerKey = "local") {
  const hostState = privateDir("host-" + label), stateDir = privateDir("manager-" + label);
  const client = createManagedOpenClawHostClient({ stateDir, supervisorStateDir: hostState, serviceUserDataRoot: userDataRoot,
    resourcesRoot: path.join(repo, "resources/external-plugin-host-patches"), adapterResourcesRoot: path.join(repo, "resources/external-plugin-adapters"),
    sourceRoot: SOURCE, interpreterPath: NODE, architecture: "arm64", gatewayConfiguration: { models: { providers: { [providerKey]: {
      baseUrl: "http://127.0.0.1:12345/v1", models: [{ id: "old", name: "Original" }] } } } },
    workerFactory(_file, options) { return new Worker(bootstrap, options); } });
  clients.push(client); await client.ready; await client.controller.activateCandidate({ candidateId: "1".repeat(64), operationId: "boot-" + label });
  assert.equal(client.getStatus().state, "running"); const first = client.getStatus().identity; writers.push(first);
  let busy = false;
  const product = createManagedOpenClawProductModelApi({ getClient: () => client, canAcquire: () => !busy && client.getStatus().state === "running",
    canContinue: actual => actual === client && productCurrent && client.getStatus().state !== "closed",
    begin() { busy = true; }, resumed() { assert.equal(client.getStatus().state, "running"); busy = false; }, failed() { busy = true; } });
  const broker = createManagedOpenClawProviderCredentialBroker({ paths, modelController: product.api, timeoutMs: 10000 });
  const dataRoot = client.getStatus().dataRoot;
  const signal = new AbortController(), owner = product.api.captureModelOwner(), context = broker.createContext({ modelOwner: owner, signal: signal.signal, assertProviderLease() { return true; } });
  return { client, product, broker, context, signal, providerKey, file: path.join(dataRoot, "openclaw.json"),
    health: () => read(path.join(dataRoot, "controlled-health.json")),
    trace:()=>fs.readFileSync(path.join(dataRoot,"controlled-trace.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line)) };
}

async function startFormalService() {
  verifierCurrent = true; serviceEpoch++;
  service = createAgentService({ paths, repoRoot: repo, prewarmMcpAuth: false, cryptoBroker,
    version: "controlled-core-worker-credential-joint", externalProviderWriterVerifierFactory() {
      return { verify: verifyManagedWriter, async close() { verifierCurrent = false; } };
    } });
  await service.start(); closed = false;
  const status = await requestService(paths, { id: crypto.randomUUID(), version: SERVICE_PROTOCOL_VERSION,
    token: readClientToken(paths), method: "service.status", params: {} }, { timeoutMs: 10000 });
  services.push({ instanceNonce: status.instanceNonce, pid: status.pid, startedAt: status.startedAt, protocolVersion: status.protocolVersion });
}
async function setupCore(label, providerKey = "local") {
  const f = await setup(label, providerKey), gate = createWorkAdmissionGate();
  const backend = { async request(method, params) {
    assert.equal(f.client.getStatus().state, "running", "ordinary Backend never borrows paused model authority");
    assert.notEqual(f.client.getEndpoint(), null); ordinaryCalls.push({ label, method });
    const bytes = fs.readFileSync(f.file), config = JSON.parse(bytes);
    if (method === "config.get") return { hash: hash(bytes), raw: bytes.toString("utf8"), parsed: config, config: structuredClone(config) };
    if (method === "models.list") return { models: Object.entries(config.models.providers).flatMap(([provider, entry]) => entry.models.map(model => ({ ...model, id: provider + "/" + model.id, provider }))) };
    if (method === "sessions.list") return { sessions: [], hasMore: false };
    if (method === "cron.list") return { jobs: [], hasMore: false };
    if (method === "tasks.list") return { supported: true, tasks: [], hasMore: false };
    throw Error("controlled ordinary Backend is read-only");
  }, async getModelReferenceCapabilities() { return {}; } };
  const adapter = createManagedOpenClawModelApply({ backend, modelController: f.product.api, admissionGate: gate, credentialBroker: f.broker });
  return { ...f, adapter, gate };
}
async function coreContext(f, spec, operationId) {
  const preview = await f.adapter.preview(spec), journal = [];
  assert.deepEqual(preview.blockers, []);
  const context = { operationId, requestDigest: modelChangeRequestDigest(spec), journal,
    journalEntry: { fingerprints: preview.fingerprints, commitState: "precommit" }, providerLeaseSignal: f.signal.signal,
    assertProviderLease() { if (f.signal.signal.aborted) throw Error("controlled provider canceled"); return true; },
    async recordStage(stage, data) { journal.push({ stage, data }); }, async recordStep(data) { journal.push({ stage: "step", data }); },
    async markCommitting(data) { journal.push({ stage: "committing", data }); }, async markCommitted(data) { journal.push({ stage: "committed", data }); },
  };
  return context;
}
async function applyCore(f, spec, operationId, secret) {
  const context = await coreContext(f, spec, operationId), before = f.health();
  const result = await f.adapter.apply(spec, context, secret === undefined ? undefined : { apiKey: secret });
  assert.equal(result.status, "applied", "actual Core apply returned " + result.status + ":" + result.code);
  assert.equal(f.health().paused, false); assert.equal(f.client.getStatus().state, "running");
  assert.equal(f.gate.snapshot("openclaw").draining, false);
  const current = f.client.getStatus().identity; writers.push(current); assert.equal(processStart(before.pid), null);
  assert.equal(JSON.stringify({ result, journal: context.journal }).includes(secret || "impossible-private-secret-canary"), false);
  const scope = { backendId: "openclaw", providerKey: f.providerKey, baseUrl: "http://127.0.0.1:12345/v1", api: "openai-completions",
    operationId, requestDigest: context.requestDigest };
  const observed = await f.broker.observe(scope, f.context); assert.equal(observed.state, "applied");
  coreOperations.push({ operationId, requestDigest: context.requestDigest, status: result.status, serviceState: observed.state,
    beforeWriter: { pid: before.pid, nonce: before.nonce, generation: before.generation }, actualWriter: current,
    journalStages: context.journal.map(entry => entry.stage), publicJournalContainsSecret: false });
  return { result, context };
}
async function main() {
  await startFormalService();
  const f = await setupCore("main"); assert.equal(Object.hasOwn(read(f.file).models.providers.local, "api"), false);
  const set = normalizeModelChangeRequest({ providerKey: "local", sourceModelId: "old", model: { id: "old", name: "Core Set" } }).safeSpec;
  await applyCore(f, set, "core-worker-set", "synthetic-core-worker-key-1");
  assert.equal(read(f.file).models.providers.local.apiKey, "synthetic-core-worker-key-1");
  assert.equal(read(f.file).models.providers.local.models[0].name, "Core Set");
  assert.equal(fs.readFileSync(paths.encryptedSecretsPath, "utf8").includes("synthetic-core-worker-key-1"), false);
  cases.push("actual Core/Base/ALS updates model and sets key through genuine Worker permit, repeated formal read/assert, exact paused restart/advance and resume-before-settle; absent api uses fixed runtime default");
  const encryptedBefore = hash(fs.readFileSync(paths.encryptedSecretsPath)), decryptedBefore = cryptoCounts.decrypt;
  await service.stop(); closed = true; await startFormalService();
  assert.notEqual(services[0].instanceNonce, services[1].instanceNonce);
  assert(cryptoCounts.decrypt > decryptedBefore, "actual EncryptedSecretStore cold reopen must decrypt its AES ciphertext");
  assert.equal(hash(fs.readFileSync(paths.encryptedSecretsPath)), encryptedBefore);
  assert.equal(read(f.file).models.providers.local.apiKey, "synthetic-core-worker-key-1");
  cases.push("formal Service stops and cold-reopens actual encrypted Store with a new instance nonce, invokes genuine AES-GCM decrypt and preserves previous binding without plaintext ciphertext or new Host");
  const rotated = { kind: "update-provider", providerKey: "local", patch: {} };
  await applyCore(f, rotated, "core-worker-rotate", "synthetic-core-worker-key-2");
  assert.equal(read(f.file).models.providers.local.apiKey, "synthetic-core-worker-key-2");
  assert.equal(fs.readFileSync(paths.encryptedSecretsPath, "utf8").includes("synthetic-core-worker-key-2"), false);
  cases.push("actual Core provider rotation after cold decrypt preserves exact previous Service binding and advances only known old exit to new paused writer");
  const clear = { kind: "update-provider", providerKey: "local", patch: { clearApiKey: true } };
  await applyCore(f, clear, "core-worker-clear");
  assert.equal(Object.hasOwn(read(f.file).models.providers.local, "apiKey"), false);
  cases.push("actual Base clearApiKey null intent is projected only under bound clear permit; genuine Worker receives no wire key and independently clears provider credential");
  const canceled = await setupCore("cancel", "cancel-provider");
  const cancelSpec = normalizeModelChangeRequest({ providerKey: "cancel-provider", sourceModelId: "old", model: { id: "old", name: "Canceled" } }).safeSpec;
  const cancelContext = await coreContext(canceled, cancelSpec, "core-worker-canceled");
  const unchanged = fs.readFileSync(canceled.file), barrier = { operationId: cancelContext.operationId, entered: deferred(), resume: deferred() }; holdRead = barrier;
  const pending = canceled.adapter.apply(cancelSpec, cancelContext, { apiKey: "synthetic-core-worker-canceled-key" });
  await barrier.entered.promise; canceled.signal.abort(); barrier.resume.resolve(); const canceledResult = await pending;
  assert.notEqual(canceledResult.status, "applied"); assert.equal(canceledResult.needsVerification, true);
  assert.deepEqual(fs.readFileSync(canceled.file), unchanged); assert.equal(canceled.health().paused, true); assert.equal(canceled.client.getEndpoint(), null);
  await canceled.client.close({ timeoutMs: 10000 }); assert.equal(canceled.client.getStatus().ownership, "absent");
  cases.push("actual Core cancellation while genuine Worker awaits formal credential read yields unverified paused outcome, zero config change/ordinary fallback and exact owned stop");
  const unknownSpec = normalizeModelChangeRequest({ providerKey: "local", sourceModelId: "old", model: { id: "old", name: "Core Unknown" } }).safeSpec;
  const unknownContext = await coreContext(f, unknownSpec, "core-worker-settle-unknown");
  fs.writeFileSync(dropFile, "one exact original terminal delivery fault\n", { mode: 0o600 });
  const unknownResult = await f.adapter.apply(unknownSpec, unknownContext, { apiKey: "synthetic-core-worker-key-3" });
  assert.equal(unknownResult.status, "cleanup_pending"); assert.equal(unknownResult.needsVerification, true);
  const proof = f.health(); assert.equal(proof.paused, true); assert.equal(proof.operationId, unknownContext.operationId); assert.equal(f.client.getEndpoint(), null);
  const scope = { backendId: "openclaw", providerKey: "local", baseUrl: "http://127.0.0.1:12345/v1", api: "openai-completions", operationId: unknownContext.operationId, requestDigest: unknownContext.requestDigest };
  const observed = await f.broker.observe(scope, f.context); assert.equal(observed.state, "applied"); assert.equal(f.health().paused, true);
  const settlements = verifierCalls.filter(call => call.operationId === unknownContext.operationId && call.phase === "settle").length;
  const originalInvocations = () => fs.readFileSync(settleTrace, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.operationId === unknownContext.operationId).length;
  assert.equal(settlements, 2, "Service performs two fresh physical checks for a single actual settle RPC"); assert.equal(originalInvocations(), 1); await assert.rejects(f.adapter.apply(unknownSpec, unknownContext, { apiKey: "synthetic-core-worker-key-3" }));
  assert.equal(verifierCalls.filter(call => call.operationId === unknownContext.operationId && call.phase === "settle").length, settlements);
  assert.equal(originalInvocations(), 1);
  faults.push({ kind: "actual-Service-terminal-ACK-suppression", operationId: unknownContext.operationId, serviceState: observed.state,
    coreState: unknownResult.status, actualWriter: { pid: proof.pid, nonce: proof.nonce, generation: proof.generation },
    actualWriterPaused: true, actualSettlementInvocations: originalInvocations(), automaticReplay: false });
  cases.push("original formal settlement ACK lost after actual result makes genuine Worker re-pause exact writer; Core keeps cleanup_pending, public observation does not resume and same operation cannot replay prepare/config/settle");
  const initialResume=f.trace().filter(row=>row.method==='resume').length,configBeforeRecovery=fs.readFileSync(f.file),verifierBefore=verifierCalls.length;
  const recoveryEntry={operationId:unknownContext.operationId,requestDigest:unknownContext.requestDigest,providerKey:'local',kind:unknownSpec.kind,
    source:{modelId:'old'},modelDiff:{after:unknownSpec.model},secretStep:true,commitState:'committed'};
  const recovered=await f.adapter.recover(recoveryEntry,{...unknownContext,journalEntry:recoveryEntry});
  assert.equal(recovered.status,'applied','actual Core terminal recovery returned '+recovered.status+':'+recovered.code);
  assert.equal(f.health().paused,false);assert.equal(f.health().pid,proof.pid);assert.equal(f.health().nonce,proof.nonce);assert.equal(f.health().generation,proof.generation);
  assert.equal(f.trace().filter(row=>row.method==='resume').length,initialResume+1);assert.deepEqual(fs.readFileSync(f.file),configBeforeRecovery);
  assert.equal(originalInvocations(),1);assert.equal(verifierCalls.filter(call=>call.operationId===unknownContext.operationId&&call.phase==='settle').length,settlements);
  const newPhases=verifierCalls.slice(verifierBefore).map(call=>call.phase);assert(newPhases.includes('terminal-observe'));
  assert.equal(newPhases.some(phase=>['open','renew','advance','read','assert','settle'].includes(phase)),false);
  assert.equal(f.gate.snapshot('openclaw').draining,false);assert(unknownContext.journal.some(row=>row.stage==='credential-terminal-recovered'));
  faults.push({kind:'actual-Core-original-terminal-recovery',operationId:unknownContext.operationId,originalResult:unknownResult.status,recoveredResult:recovered.status,
    sameCapturedWriter:true,recoveryResumeDispatches:1,actualSettlementInvocations:originalInvocations(),newCredentialAuthority:0,configReplayed:false,originalAdmissionReleased:true});
  cases.push('actual Core original journal recovery invokes retained Product/Client/Worker record; formal Service paused/resumed observer confirms one same-writer resume, then original Main status/observe/owner.close and original admission hold release with zero acquire/prepare/read-material/config/settle replay');
  assert.equal(ordinaryCalls.some(entry => entry.method === "config.patch"), false);
  for (const client of clients) { await client.close({ timeoutMs: 10000 }); assert.equal(client.getStatus().ownership, "absent"); }
  const identities = [...new Map(writers.map(writer => [writer.pid + ":" + writer.startIdentity, writer])).values()];
  for (const identity of identities) assert.equal(processStart(identity.pid), null);
  cases.push("all actual Node Workers and controlled physical children reach known owned exit; no global Host, old operation or new writer is adopted");
  await service.stop(); closed = true;
  const sourceAfter = Object.fromEntries(sourceFiles.map(file => [file, hash(fs.readFileSync(path.join(repo, file)))])); assert.deepEqual(sourceAfter, sourceBefore);
  const report = { status: "PASS", groups: cases.length, cases,
    boundary: "actual Core/Base/ALS/Product/Main broker/genuine Worker/formal Service/Controller/AES cold Store; controlled small Gateway/candidate/revision/ordinary read-only Backend/physical verifier; NOT fixed Host, actual model or Keychain acceptance; terminal explicit recovery path includes actual Core",
    sourceBefore, sourceAfter, sourceUnchanged: true,
    coordinatorSourceContext:{sha256:sourceBefore['app/core/model-change-coordinator.js'],executedInFixture:false,boundary:'Coordinator is a frozen source anchor; FIFO/prune identity dispatch regression is independently tested, while this fixture executes actual Core recovery directly'},
    originalEvidenceHashes, originalEvidenceUnchanged:originalEvidenceFiles.every(file=>hash(fs.readFileSync(path.join(repo,file)))===originalEvidenceHashes[file]), faults, cryptoCounts, serviceIncarnations: services, coreOperations,
    ordinaryReadRequests: ordinaryCalls.length, ordinaryWriteRequests: 0, verifierRequests: verifierCalls.length,
    pinnedHostStarts: 0, realModelRequests: 0, controlledChildren: identities.map(writer => ({ ...writer, exitConfirmed: true })),
    controlledSource: { workerBootstrapSha256: hash(fs.readFileSync(bootstrap)), gatewaySha256: hash(fs.readFileSync(path.join(runtimeRoot, "openclaw.mjs"))), mergeSha256: hash(fs.readFileSync(path.join(runtimeRoot, "dist/merge-patch-CzMe99iw.mjs"))) },
    testOnlyReplacements: ["candidate tree seal", "manager activation lifecycle input", "config revision comparison", "small controlled merge module", "ordinary read-only Backend", "Gateway model/control protocol", "physical writer verifier", "one exact settlement ACK delivery suppression"] };
  if (process.env.SG_TERMINAL_COORDINATOR_SNAPSHOT_REPORT) fs.writeFileSync(process.env.SG_TERMINAL_COORDINATOR_SNAPSHOT_REPORT, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write(JSON.stringify(report) + "\n");
}
const watchdog = setTimeout(() => { process.stderr.write("credential genuine Worker joint timeout; ownership needs verification; root retained: " + root + "\n"); process.exit(2); }, 120000);
main().then(() => { clearTimeout(watchdog); aesKey.fill(0); fs.rmSync(root, { recursive: true, force: true }); }, async error => {
  clearTimeout(watchdog); let cleanupVerified = true;
  for (const client of clients) { try { await client.close({ timeoutMs: 10000 }); cleanupVerified &&= client.getStatus().ownership === "absent"; } catch { cleanupVerified = false; } }
  if (service && !closed) try { await service.stop(); } catch { cleanupVerified = false; }
  aesKey.fill(0); const children = [...new Map(writers.map(writer => [writer.pid + ":" + writer.startIdentity, writer])).values()]
    .map(identity => { let actual = "unknown"; try { actual = processStart(identity.pid); } catch {} return { ...identity, exitConfirmed: actual === null }; });
  cleanupVerified &&= children.every(child => child.exitConfirmed);
  const sourceAfter = Object.fromEntries(sourceFiles.map(file => [file, hash(fs.readFileSync(path.join(repo, file)))]));
  if (cleanupVerified) fs.rmSync(root, { recursive: true, force: true });
  const report = { status: "FAIL", code: error.code || error.message, locations: String(error.stack || "").split("\n").map(line => line.trim()).filter(line => line.startsWith("at ")).slice(0,7), cleanupVerified, rootRetained: cleanupVerified ? null : root, casesCompleted: cases,
    sourceBefore, sourceAfter, sourceUnchanged: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter), controlledChildren: children };
  if (process.env.SG_TERMINAL_COORDINATOR_SNAPSHOT_REPORT) fs.writeFileSync(process.env.SG_TERMINAL_COORDINATOR_SNAPSHOT_REPORT, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  process.stderr.write(JSON.stringify(report) + "\n"); process.exitCode = 1;
});
