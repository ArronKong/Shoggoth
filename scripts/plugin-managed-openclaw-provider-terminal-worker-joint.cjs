#!/usr/bin/env node
"use strict";
// Genuine Node Worker, unchanged production Client/Worker/Supervisor, formal
// Service file-token dispatch/RPC/Controller/encrypted Store. Test-only loader
// controls the small candidate/activation/revision and one ACK delivery fault;
// the WS child and physical verifier are controlled. This is NOT pinned Host,
// real model credential, global runtime, or Keychain acceptance.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { Worker, MessageChannel } = require("node:worker_threads"), { spawnSync } = require("node:child_process");
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
const pins = require(path.join(repo, "app/managed-openclaw-runtime-pins.json"));
const NODE = (process.env.SHOGGOTH_TEST_OPENCLAW_NODE || require('node:path').join(require('node:os').homedir(), '.local', 'share', 'node', 'v24.21.0', 'bin', 'node')), SOURCE = "/opt/homebrew/lib/node_modules/openclaw";
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-credential-joint-")); fs.chmodSync(root, 0o700);
const privateDir = name => { const dir = path.join(root, name); fs.mkdirSync(dir, { mode: 0o700, recursive: true }); return dir; };
const runtimeRoot = privateDir("controlled-runtime"), dropFile = path.join(root, "drop-settle-ack");
const dropMainRecoveryFile=path.join(root,"drop-main-recovery-response");
const clients = [], writers = [], cases = [], verifierCalls = [], faults = [];
let service, closed = false, productCurrent = true, verifierCurrent = true, holdRead = null, failPausedObserve = null;
const sourceFiles = ["managed-openclaw-host-client.js", "managed-openclaw-host-worker.js", "managed-openclaw-host-supervisor.js",
  "managed-openclaw-product-model-api.js", "managed-openclaw-provider-credential.js", "managed-openclaw-provider-credential-schema.js",
  "managed-openclaw-provider-credential-client.js", "managed-openclaw-provider-credential-policy.js", "managed-openclaw-provider-credential-finish.js",
  "managed-openclaw-provider-credential-broker.js", "managed-openclaw-provider-terminal-recovery.js", "managed-openclaw-model-policy.js", "managed-openclaw-config-source-ledger.js",
  "managed-openclaw-config-revision.js", "agent-service/server.js", "agent-service/external-provider-credential-rpc.js",
  "agent-service/external-provider-credential-controller.js", "agent-service/external-provider-credential-writer.js",
  "agent-service/external-provider-credential-runtime.js", "agent-service/encrypted-secret-store.js", "agent-service/client.js",
  "core/model-change-validation.js", "agent-service/service-protocol-version.js", "agent-service/instance-state.js"].map(name => "app/" + name);
sourceFiles.push("scripts/plugin-managed-openclaw-provider-terminal-worker-joint.cjs");
const sourceBefore = Object.fromEntries(sourceFiles.map(file => [file, hash(fs.readFileSync(path.join(repo, file)))]));
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
          else if (kind === "resume") { if (!paused || operationId !== params.operationId) throw Error("foreign resume"); paused = false; operationId = null; persist(kind); value = proof();
            const lost=path.join(descriptor.dataRoot,"drop-recovery-resume-ack");if(fs.existsSync(lost)){fs.unlinkSync(lost);return;} }
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
      return Object.freeze({ ...actual, async settle(...args) { const receipt = await actual.settle(...args);
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
const bootstrap = path.join(root, "controlled-worker.cjs"); fs.writeFileSync(bootstrap, "(" + controlledWorkerLoader.toString() + ")(" + JSON.stringify({ repo, runtimeRoot, node: NODE, dropFile }) + ");\n", { mode: 0o600 });
const userDataRoot = privateDir("service"), paths = resolveServicePaths({ userDataRoot, cacheRoot: path.join(root, "service-cache"), trustedRoot: root });
const aesKey = crypto.randomBytes(32), cryptoCounts = { encrypt: 0, decrypt: 0 };
const cryptoBroker = { async open() {}, async close() {}, async encrypt(bytes) { cryptoCounts.encrypt++; const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  return Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]); }, async decrypt(bytes) { cryptoCounts.decrypt++; const cipher = crypto.createDecipheriv("aes-256-gcm", aesKey, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]); } };
async function verifyManagedWriter(writer, context) {
  context.assertCurrent(); verifierCalls.push({ operationId: writer.operationId, phase: context.phase, writerState:context.writerState||null, pid: writer.pid });
  if (holdRead && context.phase === "read" && writer.operationId === holdRead.operationId) { const barrier = holdRead; holdRead = null; barrier.entered.resolve(); await barrier.resume.promise; context.assertCurrent(); }
  const descriptorFile = path.join(writer.dataRoot, "managed-control.json"), fenceFile = path.join(writer.dataRoot, "writer.fence"), healthFile = path.join(writer.dataRoot, "controlled-health.json");
  const descriptor = read(descriptorFile), fence = read(fenceFile), proof = read(healthFile);
  assert.equal(writer.runtimeRoot, runtimeRoot); assert.equal(writer.interpreterPath, NODE); assert.equal(writer.entryPath, path.join(runtimeRoot, "openclaw.mjs"));
  assert.equal(writer.runtimeTreeSha256, pins.hosts.openclaw.outputTreeSha256); assert.equal(processStart(writer.pid), writer.startIdentity);
  assert.equal(descriptor.nonce, writer.nonce); assert.equal(fence.nonce, writer.nonce); assert.equal(proof.generation, writer.generation);
  assert.equal(proof.pid, writer.pid); assert.equal(proof.nonce, writer.nonce);
  if (context.phase === "advance") assert.equal(processStart(context.previousWriter.pid), null);
  if(context.phase==='terminal-observe'&&context.writerState==='paused'&&failPausedObserve===writer.operationId){failPausedObserve=null;throw Error('controlled preobserve refusal');}
  const expectedPaused = context.phase==='terminal-observe'?context.writerState==='paused':!(context.phase === "settle" && context.outcome !== "needs_verification");
  assert.equal(proof.paused, expectedPaused); assert.equal(proof.operationId, expectedPaused ? writer.operationId : null);
  const generation = proof.generation, inode = fs.lstatSync(fenceFile).ino;
  return () => { context.assertCurrent(); try { const current = read(healthFile), currentFence = read(fenceFile);
    return verifierCurrent && processStart(writer.pid) === writer.startIdentity && fs.lstatSync(fenceFile).ino === inode
      && currentFence.nonce === writer.nonce && current.generation === generation && current.nonce === writer.nonce
      && current.pid === writer.pid && current.paused === expectedPaused && current.operationId === (expectedPaused ? writer.operationId : null);
  } catch { return false; } };
}
const direct = (method, params) => requestService(paths, { id: crypto.randomUUID(), version: SERVICE_PROTOCOL_VERSION,
  token: readClientToken(paths), method: "external.provider.credential." + method, params }, { timeoutMs: 10000 });
async function setup(label = "main", providerKey = "local", relayRecovery=false) {
  const hostState = privateDir("host-" + label), stateDir = privateDir("manager-" + label);
  const client = createManagedOpenClawHostClient({ stateDir, supervisorStateDir: hostState, serviceUserDataRoot: userDataRoot,
    resourcesRoot: path.join(repo, "resources/external-plugin-host-patches"), adapterResourcesRoot: path.join(repo, "resources/external-plugin-adapters"),
    sourceRoot: SOURCE, interpreterPath: NODE, architecture: "arm64", gatewayConfiguration: { models: { providers: { [providerKey]: {
      baseUrl: "http://127.0.0.1:12345/v1", api: "openai-completions", models: [{ id: "old", name: "Original" }] } } } },
    ...(relayRecovery?{commandTimeoutMs:5000}:{}),
    workerFactory(_file, options) {
      if(!relayRecovery)return new Worker(bootstrap,options);
      const outer=options.workerData.port,{port1,port2}=new MessageChannel();let recoveryId=null;
      const actual=new Worker(bootstrap,{...options,workerData:{...options.workerData,port:port2},transferList:[port2]});
      outer.on('message',frame=>{if(frame.command==='modelTerminalRecover')recoveryId=frame.id;port1.postMessage(frame);});
      port1.on('message',frame=>{if(frame.type==='response'&&frame.id===recoveryId&&frame.ok&&fs.existsSync(dropMainRecoveryFile)){fs.unlinkSync(dropMainRecoveryFile);return;}outer.postMessage(frame);});
      actual.once('exit',()=>{port1.close();outer.close();});return actual;
    } });
  clients.push(client); await client.ready; await client.controller.activateCandidate({ candidateId: "1".repeat(64), operationId: "boot-" + label });
  assert.equal(client.getStatus().state, "running"); const first = client.getStatus().identity; writers.push(first);
  let busy = false;
  const product = createManagedOpenClawProductModelApi({ getClient: () => client, canAcquire: () => !busy && client.getStatus().state === "running",
    canContinue: actual => actual === client && productCurrent && client.getStatus().state !== "closed",
    begin() { busy = true; }, resumed() { assert.equal(client.getStatus().state, "running"); busy = false; }, failed() { busy = true; } });
  const broker = createManagedOpenClawProviderCredentialBroker({ paths, modelController: product.api, timeoutMs: 10000 });
  const signal = new AbortController(), owner = product.api.captureModelOwner(), context = broker.createContext({ modelOwner: owner, signal: signal.signal, assertProviderLease() { return true; } });
  const dataRoot=client.getStatus().dataRoot;
  return { client, product, broker, context, signal, providerKey, dataRoot, file: path.join(dataRoot, "openclaw.json"),
    health: () => read(path.join(dataRoot, "controlled-health.json")), trace:()=>fs.readFileSync(path.join(dataRoot,'controlled-trace.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line)) };
}
async function acquire(f, id, name, action = "set", secret = "synthetic-joint-key-1") { // gitleaks:allow -- synthetic fixture key
  const safeSpec = normalizeModelChangeRequest({ providerKey: f.providerKey, sourceModelId: "old", model: { id: "old", name } }).safeSpec;
  const identity = { operationId: id, requestDigest: modelChangeRequestDigest(safeSpec) };
  const lease = await f.product.api.acquireModelLease({ ...identity, safeSpec }), writer = await lease.getCredentialOwner();
  writers.push({ pid: writer.pid, startIdentity: writer.startIdentity, nonce: writer.nonce });
  const scope = { backendId: "openclaw", providerKey: f.providerKey, baseUrl: "http://127.0.0.1:12345/v1", api: "openai-completions", ...identity };
  const permit = await f.broker.prepareAndOpen({ scope, writer, action, ...(action === "set" ? { secret } : {}) }, f.context);
  assert.equal(await lease.bindCredentialPermit(permit), true); assert.equal(f.client.getEndpoint(), null); assert.equal(f.client.getExecution(), null);
  return { lease, permit, safeSpec, identity, name };
}
async function patch(f, op, phase = "candidate", restore) {
  const config = await op.lease.modelRpc("config.get", {}), original = restore || config.parsed.models.providers[f.providerKey];
  const model = { ...original.models.find(model => model.id === "old"), id: "old", name: op.name };
  if (!Array.isArray(model.input)) model.input = ["text"]; if (!model.cost || typeof model.cost !== "object") model.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const provider = { ...original, models: [model] }; delete provider.apiKey;
  const raw = JSON.stringify({ models: { providers: { [f.providerKey]: provider } } }); assert.equal(raw.includes("apiKey"), false);
  return op.lease.modelRpc("config.patch", { raw, baseHash: config.hash, replacePaths: ["models.providers." + f.providerKey + ".models"] }, { credentialPhase: phase });
}
async function restart(f, op) { const old = op.permit; assert.equal(await op.lease.restartPaused(), true); const writer = await op.lease.getCredentialOwner();
  writers.push({ pid: writer.pid, startIdentity: writer.startIdentity, nonce: writer.nonce }); assert.equal(processStart(old.writer.pid), null);
  op.permit = await f.broker.advance(old, writer, f.context); assert.equal(op.permit.owner.ownerId, old.owner.ownerId); assert.notEqual(op.permit.owner.capability, old.owner.capability);
  assert.equal(await op.lease.bindCredentialPermit(op.permit), true); assert.equal(await op.lease.waitHealthy(), true); assert.equal(await op.lease.verifyTarget(op.safeSpec), true); }
async function finish(f, op, outcome = "applied") { assert.equal(await op.lease.finish({ outcome, ...op.identity, safeSpec: op.safeSpec }), true);
  assert.equal(f.health().paused, false); const status = await f.broker.observeFinished(op.permit, outcome, f.context, true); assert.equal(status.state, outcome); return status; }
async function main() {
  // Root adds the trusted factory to createAgentService. The formal server owns
  // request context, exact service identity and lifecycle; verifier is the only
  // controlled authority, supplied from trusted Node test composition.
  service = createAgentService({ paths, repoRoot: repo, prewarmMcpAuth: false, cryptoBroker,
    version: "controlled-worker-credential-joint", externalProviderWriterVerifierFactory() {
      return { verify: verifyManagedWriter, async close() { verifierCurrent = false; } }; } });
  await service.start();
  const f=await setup();const originalConfig=read(f.file);
  const first=await acquire(f,'terminal-baseline-set','First');await patch(f,first);await restart(f,first);await finish(f,first);
  cases.push('genuine Worker baseline set/paused restart/physical advance/resume and formal Service settlement is unchanged');
  const published=await acquire(f,'terminal-finish-main-loss','Published');await patch(f,published);await restart(f,published);
  assert.equal(await published.lease.finish({outcome:'applied',...published.identity,safeSpec:published.safeSpec}),true);
  assert.equal(f.product.api.canRecoverModelLease(published.identity),false);assert.equal(f.product.api.canRecoverCredentialTerminal(published.identity),true);
  const pubConfig=fs.readFileSync(f.file),pubBefore=f.trace(),pubResume=pubBefore.filter(row=>row.method==='resume').length,pubPause=pubBefore.filter(row=>row.method==='pause').length;
  const pubReceipt=await f.product.api.recoverCredentialTerminal(published.identity);assert.deepEqual(pubReceipt,{outcome:'applied',paused:false,resumed:true,healthVerified:true});
  assert.deepEqual(fs.readFileSync(f.file),pubConfig);assert.equal(f.trace().filter(row=>row.method==='resume').length,pubResume);assert.equal(f.trace().filter(row=>row.method==='pause').length,pubPause);
  await f.broker.observeFinished(published.permit,'applied',f.context,true);
  cases.push('completed raw/Product finish with lost Main publication retains original record; fresh original-cap resumed terminal proof performs zero pause/resume/config/settle replay');
  const unknown=await acquire(f,'terminal-settle-unknown','Unknown','set','synthetic-joint-key-3');await patch(f,unknown);await restart(f,unknown);
  fs.writeFileSync(dropFile,'one original settlement ACK lost\n',{mode:0o600});await assert.rejects(unknown.lease.finish({outcome:'applied',...unknown.identity,safeSpec:unknown.safeSpec}));
  const proof=f.health(),rawConfig=fs.readFileSync(f.file),originalExpiry=unknown.lease.expiresAt;
  assert.equal(proof.paused,true);assert.equal(proof.operationId,unknown.identity.operationId);assert.equal(f.client.getEndpoint(),null);
  const observed=await direct('observe',{scope:unknown.permit.scope});assert.equal(observed.state,'applied');assert.equal(f.health().paused,true);
  const count=()=>verifierCalls.filter(row=>row.operationId===unknown.identity.operationId&&row.phase==='settle').length,settles=count();assert.equal(settles,2);
  await assert.rejects(async()=>f.product.api.acquireModelLease({...unknown.identity,safeSpec:unknown.safeSpec,recovery:true}),{code:'MANAGED_HOST_MODEL_TERMINAL_RECOVERY_REQUIRED'});
  assert.equal(unknown.lease.expiresAt,originalExpiry);assert.equal(f.product.api.canRecoverCredentialTerminal(unknown.identity),true);
  cases.push('lost original settle ACK retains original paused writer and frozen expiry; public receipt does not resume and generic acquire cannot rebind or extend terminal authority');
  failPausedObserve=unknown.identity.operationId;const resumesBefore=f.trace().filter(row=>row.method==='resume').length;
  await assert.rejects(f.product.api.recoverCredentialTerminal(unknown.identity));assert.equal(f.health().paused,true);
  assert.equal(f.trace().filter(row=>row.method==='resume').length,resumesBefore);assert.equal(f.product.api.canRecoverCredentialTerminal(unknown.identity),true);
  cases.push('formal Service preobserve refusal performs zero recovery resume and remains retryable using the same original record/cap/writer/expiry');
  const recovered=await f.product.api.recoverCredentialTerminal(unknown.identity);assert.equal(recovered.outcome,'applied');assert.equal(f.health().paused,false);
  assert.equal(f.trace().filter(row=>row.method==='resume').length,resumesBefore+1);assert.equal(count(),settles);assert.deepEqual(fs.readFileSync(f.file),rawConfig);
  const physical=f.health();assert.equal(physical.pid,proof.pid);assert.equal(physical.nonce,proof.nonce);assert.equal(physical.generation,proof.generation);
  const observerStates=verifierCalls.filter(row=>row.operationId===unknown.identity.operationId&&row.phase==='terminal-observe').map(row=>row.writerState);
  assert(observerStates.includes('paused')&&observerStates.includes('resumed'));
  await f.broker.observeFinished(unknown.permit,'applied',f.context,true);
  faults.push({kind:'actual-Service-original-settle-ACK-suppression',operationId:unknown.identity.operationId,serviceState:observed.state,writer:{pid:proof.pid,startIdentity:unknown.permit.writer.startIdentity,nonce:proof.nonce,generation:proof.generation},sameWriter:true,recoveryResumeDispatches:1,settlePhysicalChecks:settles,configReplayed:false});
  cases.push('explicit original terminal recovery independently observes paused binding then one resume and fresh resumed binding; exact same writer/config, zero prepare/secret/config/settle replay');
  const lost=await acquire(f,'terminal-recovery-resume-unknown','Lost Recovery');await patch(f,lost);await restart(f,lost);
  fs.writeFileSync(dropFile,'original terminal ACK loss\n',{mode:0o600});await assert.rejects(lost.lease.finish({outcome:'applied',...lost.identity,safeSpec:lost.safeSpec}));
  const frozen=fs.readFileSync(f.file),onceBefore=f.trace().filter(row=>row.method==='resume').length;
  fs.writeFileSync(path.join(f.dataRoot,'drop-recovery-resume-ack'),'lose one exact recovery dispatch ACK\n',{mode:0o600});
  await assert.rejects(f.product.api.recoverCredentialTerminal(lost.identity));assert.equal(f.health().paused,true);assert.equal(f.health().operationId,lost.identity.operationId);
  const onceAfter=f.trace().filter(row=>row.method==='resume').length;assert.equal(onceAfter,onceBefore+1);
  await assert.rejects(f.product.api.recoverCredentialTerminal(lost.identity));assert.equal(f.trace().filter(row=>row.method==='resume').length,onceAfter);
  assert.deepEqual(fs.readFileSync(f.file),frozen);assert.equal(f.client.getEndpoint(),null);assert.equal(f.client.getExecution(),null);
  faults.push({kind:'controlled-Gateway-recovery-resume-ACK-suppression',operationId:lost.identity.operationId,recoveryResumeDispatches:1,secondRecoveryResumeDispatches:0,pausedAfterUnknown:true,originalExpiry:lost.permit.writer.expiresAt});
  cases.push('unknown recovery resume ACK synchronously consumes original record quota before dispatch, re-pauses exact writer and forbids a second resume even after a new recovery callback');
  const ack=await setup('main-recovery-response-loss','ack-provider',true),ackOp=await acquire(ack,'terminal-worker-main-ack-loss','Worker Completed');
  await patch(ack,ackOp);await restart(ack,ackOp);fs.writeFileSync(dropFile,'one terminal ACK loss\n',{mode:0o600});
  await assert.rejects(ackOp.lease.finish({outcome:'applied',...ackOp.identity,safeSpec:ackOp.safeSpec}));
  const ackConfig=fs.readFileSync(ack.file),ackBefore=ack.trace().filter(row=>row.method==='resume').length;
  fs.writeFileSync(dropMainRecoveryFile,'drop only successful actual Worker recovery response\n',{mode:0o600});
  await assert.rejects(ack.product.api.recoverCredentialTerminal(ackOp.identity),{code:'MANAGED_WORKER_COMMAND_TIMEOUT'});
  assert.equal(ack.health().paused,false);assert.equal(ack.client.getEndpoint(),null);assert.equal(ack.trace().filter(row=>row.method==='resume').length,ackBefore+1);
  const ackAfter=ack.trace().length;const reconciled=await ack.product.api.recoverCredentialTerminal(ackOp.identity);assert.equal(reconciled.outcome,'applied');
  assert.equal(ack.trace().filter(row=>row.method==='resume').length,ackBefore+1);
  assert.equal(ack.trace().slice(ackAfter).some(row=>['pause','resume','retire'].includes(row.method)),false);assert.deepEqual(fs.readFileSync(ack.file),ackConfig);
  await ack.broker.observeFinished(ackOp.permit,'applied',ack.context,true);
  faults.push({kind:'actual-Worker-successful-recovery-response-dropped-before-Main',operationId:ackOp.identity.operationId,recoveryResumeDispatches:1,reconciliationResumeDispatches:0,physicalWriterUnpaused:true,ordinaryEndpointWithdrawnUntilFreshProof:true});
  cases.push('successful actual Worker recovery response lost before Main keeps local hold; exact original read-only resumed proof reconciles the same record with zero second pause/resume/config/settle');
  assert.equal(Object.hasOwn(f.product.api,'request'),false);assert.equal(originalConfig.models.providers.local.apiKey,undefined);
  for (const client of clients) { await client.close({ timeoutMs: 10000 }); assert.equal(client.getStatus().ownership, "absent"); }
  const identities = [...new Map(writers.map(writer => [writer.pid + ":" + writer.startIdentity, writer])).values()];
  for (const identity of identities) assert.equal(processStart(identity.pid), null);
  cases.push("all genuine Node Workers close only known foreground children and release owned fences; no physical child or original operation is adopted or replayed");
  await service.stop(); closed = true;
  const sourceAfter = Object.fromEntries(sourceFiles.map(file => [file, hash(fs.readFileSync(path.join(repo, file)))])); assert.deepEqual(sourceAfter, sourceBefore);
  const report = { status: "PASS", groups: cases.length, cases, boundary: "genuine Worker + formal Service/RPC/encrypted Store + controlled small Gateway/physical verifier/loader; NOT actual pinned Host or real model credential acceptance; terminal recovery uses actual Worker original retained record and formal Service observer",
    sourceBefore, sourceAfter, sourceUnchanged: true, faults, cryptoCounts, verifierRequests: verifierCalls.length,
    pinnedHostStarts: 0, realModelRequests: 0, controlledChildren: identities.map(writer => ({ ...writer, exitConfirmed: true })),
    controlledSource: { workerBootstrapSha256: hash(fs.readFileSync(bootstrap)), gatewaySha256: hash(fs.readFileSync(path.join(runtimeRoot, "openclaw.mjs"))),
      mergeSha256: hash(fs.readFileSync(path.join(runtimeRoot, "dist/merge-patch-CzMe99iw.mjs"))) },
    testOnlyReplacements: ["candidate tree seal", "manager activation lifecycle input", "config revision comparison", "small controlled merge module", "Gateway model/control protocol", "physical writer verifier", "one exact settlement ACK delivery suppression", "one controlled Gateway recovery resume ACK suppression", "one controlled physical preobserve refusal", "one actual Worker recovery response dropped by transparent private-port relay"] };
  const target = process.env.SG_TERMINAL_WORKER_JOINT_REPORT; if (target) fs.writeFileSync(target, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
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
  const report = { status: "FAIL", code: error.code || error.message, cleanupVerified, rootRetained: cleanupVerified ? null : root, casesCompleted: cases,
    sourceBefore, sourceAfter, sourceUnchanged: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter), controlledChildren: children };
  if (process.env.SG_TERMINAL_WORKER_JOINT_REPORT) fs.writeFileSync(process.env.SG_TERMINAL_WORKER_JOINT_REPORT, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  process.stderr.write(JSON.stringify(report) + "\n"); process.exitCode = 1;
});
