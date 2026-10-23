#!/usr/bin/env node
"use strict";
// Reuse an already prepared CURRENT production candidate; never copy dependencies
// or mutate an installed Host. One actual Worker ACK is withheld after real pause.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), http = require("node:http");
const { Worker, MessageChannel } = require("node:worker_threads");
const { createManagedOpenClawHostClient } = require("../app/managed-openclaw-host-client");
const { createManagedOpenClawProductHost } = require("../app/managed-openclaw-product-host");
const { createManagedOpenClawProductAuth } = require("../app/managed-openclaw-product-auth");
const { createManagedOpenClawModelApply } = require("../app/core/managed-openclaw-model-apply");
const { createWorkAdmissionGate } = require("../app/core/work-admission-gate");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { normalizeModelChangeRequest, modelChangeRequestDigest } = require("../app/core/model-change-validation");
const pins = require("../app/managed-openclaw-runtime-pins.json");
const ROOT = path.resolve(__dirname, "..");
const SOURCE = "/opt/homebrew/lib/node_modules/openclaw", NODE = (process.env.SHOGGOTH_TEST_OPENCLAW_NODE || require('node:path').join(require('node:os').homedir(), '.local', 'share', 'node', 'v24.21.0', 'bin', 'node')), MODEL = "owned-exit-local";
const sha = data => crypto.createHash("sha256").update(data).digest("hex");
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check, label, milliseconds = 90000) { const deadline = Date.now() + milliseconds; while (Date.now() < deadline) { if (await check()) return; await delay(100); } throw Object.assign(new Error(label), { code: "OWNED_EXIT_PROOF_TIMEOUT" }); }
const sourceFiles = ["app/managed-openclaw-config-source-ledger.js", "app/managed-openclaw-config-revision.js", "app/managed-openclaw-product-host.js", "app/managed-openclaw-product-model-api.js", "app/core/managed-openclaw-model-apply.js", "app/managed-openclaw-host-client.js", "app/managed-openclaw-host-worker.js", "app/managed-openclaw-host-supervisor.js", "app/managed-openclaw-model-policy.js", "app/managed-openclaw-product-auth.js", "app/core/openclaw-backend.js", "app/core/openclaw-model-references.js", "app/core/openclaw-model-change.js", "app/core/model-change-validation.js", "app/core/device-auth.js", "app/core/work-admission-gate.js", "app/managed-plugin-host-runtime.js", "app/managed-openclaw-runtime-pins.json", "resources/external-plugin-adapters/openclaw/transport.mjs", "scripts/plugin-managed-owned-exit-real-host-fixture.cjs"];
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file => [file, sha(fs.readFileSync(path.join(ROOT, file)))]));
function checkedManagerRoot(argument) {
  assert(typeof argument === "string" && argument.startsWith("/private/tmp/sg-managed-openclaw-") && path.isAbsolute(argument), "explicit isolated current candidate root required");
  const root = fs.realpathSync(argument); assert.equal(root, argument); assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  const base = path.join(root, "app-state/external-plugin-host-runtimes/openclaw"), pointer = JSON.parse(fs.readFileSync(path.join(base, "candidate.json")));
  assert.equal(pointer.backendId, "openclaw"); assert(/^[a-f0-9]{64}$/u.test(pointer.candidateId));
  const descriptor = JSON.parse(fs.readFileSync(path.join(base, "candidates", pointer.candidateId, "descriptor.json")));
  assert.equal(descriptor.runtimeTreeSha256, pins.hosts.openclaw.outputTreeSha256, "old candidate cannot stand in for current fixed Host");
  assert.equal(descriptor.policyDigest, sha(JSON.stringify(pins.hosts.openclaw)));
  // Full sealed tree/interpreter verification is mandatory in real Worker getCandidate.
  return root;
}
function relay(state) { return (file, { workerData }) => {
  const outer = workerData.port, { port1, port2 } = new MessageChannel();
  const actual = new Worker(file, { workerData: { ...workerData, port: port2 }, transferList: [port2] }), commands = new Map();
  outer.on("message", frame => {
    if (frame.type === "command") {
      commands.set(frame.id, { command: frame.command, args: frame.args });
      if (frame.command === "modelAcquire") state.acquires++;
      if (frame.command === "modelAction" && frame.args.action === "rpc" && frame.args.params.method === "config.patch") state.privateConfigWrites++;
    }
    try { port1.postMessage(frame); } catch { /* Client close owns cleanup */ }
  });
  port1.on("message", frame => {
    const command = frame.type === "response" ? commands.get(frame.id) : null;
    if (command) {
      commands.delete(frame.id);
      if (command.command === "modelAcquire") state.acquireResponses.push({ok:frame.ok===true,code:frame.error?.code||null});
      if (command.command === "modelAcquire" && command.args.operationId === state.operationId && frame.ok && state.armed) {
        state.armed = false; state.dropped = true;
        // Keep only an empty boolean event in output; actual binding stays inside Worker.
        return;
      }
    }
    try { outer.postMessage(frame); } catch { /* Client close owns cleanup */ }
  });
  const terminate = actual.terminate.bind(actual);
  actual.terminate = async () => { outer.close(); port1.close(); return terminate(); };
  return actual;
}; }
async function main() {
  assert.equal(process.argv.length, 4, "candidate root and evidence file required");
  // Any missing/old pointer rejects before model server, Worker, private data or Host.
  const candidateRoot = checkedManagerRoot(process.argv[2]), output = path.resolve(process.argv[3]), before = sourceHashes();
  const privateRoot = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-owned-exit-host-")); fs.chmodSync(privateRoot, 0o700);
  const serviceUserDataRoot = path.join(privateRoot, "service-user-data"); fs.mkdirSync(serviceUserDataRoot, { mode: 0o700 });
  const globalConfig = require('node:path').join(require('node:os').homedir(), '.openclaw', 'openclaw.json'), globalBefore = fs.existsSync(globalConfig) ? sha(fs.readFileSync(globalConfig)) : null;
  const gate = createWorkAdmissionGate(), lost = { operationId: "owned-exit-uncertain-model", armed: false, dropped: false, acquires: 0, privateConfigWrites: 0, acquireResponses: [] };
  let backend, core, worker, host, model, modelRequests = 0, legacyAccess = 0, proofs = 0, failure = null, success = false;
  const physical = [], groups = [];let phase="initialization",lastCoreResult=null;const readTrace=[];
  try {
    model = http.createServer((request, response) => { let text = ""; request.on("data", bytes => text += bytes); request.on("end", () => {
      try {
        const body = JSON.parse(text); assert.equal(body.model, MODEL); modelRequests++;
        assert(!text.includes("dispatchRef") && !text.includes("requestDigest") && !text.includes("controlToken"));
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const [delta, finish_reason] of [[{ role: "assistant", content: "Owned exit ordinary chat completed." }, null], [{}, "stop"]]) response.write(`data: ${JSON.stringify({ id: "owned-exit-proof", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        response.end("data: [DONE]\n\n");
      } catch (error) { failure = error; response.writeHead(500); response.end("fixture failed"); }
    }); }); await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
    const gatewayConfiguration = { models: { mode: "replace", providers: { local: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: "fixture-only", api: "openai-completions", agentRuntime: { id: "openclaw" }, models: [{ id: MODEL, name: MODEL, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }] } } }, agents: { defaults: { model: { primary: `local/${MODEL}` }, heartbeat: { every: "0m" } } }, tools: { profile: "minimal" } };
    host = createManagedOpenClawProductHost({ getMode: () => "managed", setManagedMode() {},
      createClient: () => worker = createManagedOpenClawHostClient({ stateDir: path.join(candidateRoot, "app-state"), supervisorStateDir: privateRoot, serviceUserDataRoot, resourcesRoot: path.join(ROOT, "resources/external-plugin-host-patches"), adapterResourcesRoot: path.join(ROOT, "resources/external-plugin-adapters"), sourceRoot: SOURCE, interpreterPath: NODE, architecture: "arm64", gatewayConfiguration, workerFactory: relay(lost) }),
      onUnavailable: async () => { core?.runtimeApply.invalidateConnectionGeneration(); await backend?.stop(); }, onModelUnavailable: async () => { await backend.stop(); },
      onOwnedExit: proof => { assert.equal(JSON.stringify(proof), "{}"); proofs++; return core.releaseAfterOwnedExit(proof); }, onReady: async () => backend.start(),
    });
    const legacy = { getGatewayUrl() { legacyAccess++; throw new Error("legacy forbidden"); }, resolveConnectAuth() { legacyAccess++; throw new Error("legacy forbidden"); }, async resolveConnectAuthAsync() { legacyAccess++; throw new Error("legacy forbidden"); }, storeDeviceToken() { legacyAccess++; throw new Error("legacy forbidden"); }, clearDeviceToken() { legacyAccess++; throw new Error("legacy forbidden"); } };
    const auth = createManagedOpenClawProductAuth({ host, legacyResolver: legacy, credentialsDir: path.join(privateRoot, "credentials"), dataRoot: path.join(privateRoot, "external-plugin-host-data/openclaw/v1") });
    backend = new OpenClawBackend({ getUpstreamUrl: () => host.getEndpoint()?.url || "", getOrigin: () => "http://127.0.0.1", authResolver: auth, getManagedExecution: () => host.getExecution() });
    const actualRequest=backend.request.bind(backend);backend.request=async(method,params)=>{const result=await actualRequest(method,params);
      if(['config.get','sessions.list','cron.list'].includes(method)){
        const record={method,paramsDigest:sha(JSON.stringify(params||{}))};
        if(method==='config.get'){record.revisionDigest=sha(String(result?.hash));record.parsedDigest=sha(JSON.stringify(result?.parsed));record.domains=Object.fromEntries(['models','agents','gateway','tools','plugins','meta'].map(key=>[key,sha(JSON.stringify(result?.parsed?.[key])||'null')]));}
        else{const rows=result?.sessions||result?.jobs||[];record.rows=rows.map(row=>({rowIdDigest:sha(String(row.key||row.id)),fields:Object.fromEntries(Object.keys(row).sort().map(key=>[key,sha(JSON.stringify(row[key])||'null')]))}));}
        readTrace.push(record);
      }return result;};
    core = createManagedOpenClawModelApply({ backend, modelController: host.getModelApplyApi(), admissionGate: gate });
    phase="initial-product-start";host.prepare({ operationId: "owned-exit-initial" }); assert.equal((await host.waitForOperation("owned-exit-initial")).state, "running"); physical.push(host.getEndpoint().identity);
    async function normalChat(sessionKey, expected) {
      const agents = await backend.listAgents(); assert(agents.some(agent => agent.id === "main"));
      const leave = gate.enter("openclaw", "chat");
      try { await backend.request("chat.send", { sessionKey, message: "Verify ordinary chat after exact owned exit.", idempotencyKey: crypto.randomUUID() }); } finally { leave(); }
      await until(() => modelRequests === expected, "actual ordinary model");
      await until(async () => JSON.stringify(await backend.request("chat.history", { sessionKey, limit: 20 })).includes("Owned exit ordinary chat completed."), "actual ordinary persisted result");
      assert.equal(failure, null);
    }
    phase="initial-ordinary-model";await normalChat("agent:main:owned-exit-before", 1); groups.push("current sealed candidate + production Product/Auth/Backend drive real local model before uncertain acquisition");
    const spec = normalizeModelChangeRequest({ providerKey: "local", sourceModelId: MODEL, model: { id: MODEL, name: "Must Never Be Written" } }).safeSpec;
    phase="core-preview";const preview = await core.preview(spec), abort = new AbortController(), context = { operationId: lost.operationId, requestDigest: modelChangeRequestDigest(spec), journalEntry: { commitState: "precommit", fingerprints: preview.fingerprints }, providerLeaseSignal: abort.signal, assertProviderLease() {}, async recordStage() {}, async recordStep() {}, async markCommitting() {}, async markCommitted() {} };
    lost.armed = true; phase="core-apply-before-ack";const pending = core.apply(spec, context).then(value=>{lastCoreResult=value;return value;});
    await until(() => lost.dropped||lastCoreResult!==null, "actual acquire acknowledgement withheld");assert.equal(lost.dropped,true,'Core settled before any actual acquire ACK'); assert.equal(host.getEndpoint(), null); assert.equal(host.getExecution(), null); assert.equal(gate.snapshot("openclaw").drainCount, 1); assert.equal(modelRequests, 1);
    abort.abort(); const result = await pending; assert.equal(result.needsVerification, true); assert.equal(gate.snapshot("openclaw").drainCount, 1);
    assert.throws(() => core.releaseAfterOwnedExit(Object.freeze({})), { code: "managed_model_owned_exit_untrusted" }); assert.equal(gate.snapshot("openclaw").drainCount, 1);
    assert.equal(lost.acquires, 1); assert.equal(lost.privateConfigWrites, 0); groups.push("transparent real Worker drops successful acquire ACK after actual pause; Core retains uncertain hold; forged exit proof releases nothing; zero write/new model");
    phase="exact-owned-stop";host.stop({ operationId: "owned-exit-stop" }); assert.equal((await host.waitForOperation("owned-exit-stop")).state, "stopped");
    assert.equal(worker.getStatus().ownership, "absent"); assert.equal(proofs, 1); assert.equal(gate.snapshot("openclaw").drainCount, 0); assert.throws(() => process.kill(physical[0].pid, 0));
    assert.equal(fs.existsSync(path.join(privateRoot, "external-plugin-host-data/openclaw/v1/writer.fence")), false);
    groups.push("actual captured writer exits, private fence releases and all raw flights settle before branded exact owner proof clears old Core drain");
    phase="explicit-same-candidate-restart";host.restart({ operationId: "owned-exit-restart" }); assert.equal((await host.waitForOperation("owned-exit-restart")).state, "running"); physical.push(host.getEndpoint().identity); assert.notEqual(physical[0].nonce, physical[1].nonce);
    await assert.rejects(core.apply(spec, context), { code: "managed_model_requires_recovery" }); assert.equal(lost.acquires, 1); assert.equal(lost.privateConfigWrites, 0);
    phase="post-stop-ordinary-model";await normalChat("agent:main:owned-exit-after", 2); assert.equal(gate.snapshot("openclaw").drainCount, 0); assert.equal(legacyAccess, 0);
    groups.push("explicit same fixed candidate restart restores ordinary production Backend/model chat; original uncertain operation remains fenced without remint/replay");
    phase="exact-product-close";await host.close({ operationId: "owned-exit-proof-close", timeoutMs: 30000 }); assert.equal(worker.getStatus().state, "closed");
    for (const child of physical) assert.throws(() => process.kill(child.pid, 0)); assert.equal(modelRequests, 2); assert.equal(failure, null);
    assert.equal(fs.existsSync(globalConfig) ? sha(fs.readFileSync(globalConfig)) : null, globalBefore); assert.deepEqual(sourceHashes(), before);
    const evidence = { version: 1, status: "PASS", verifiedAt: new Date().toISOString(), groups, sourceHashes: before, candidateTreeSha256: pins.hosts.openclaw.outputTreeSha256, actualWorkerGatewayProductCoreAndBackend: true, actualAcquireAckWithheld: true, modelRequests, physicalChildren:physical, modelRequestIds: [MODEL, MODEL], privateConfigWrites: lost.privateConfigWrites, remintedAcquiresAfterStop: 0, opaqueExitProofsBeforeKnownExit: 0, exactOwnedExitProofs: proofs, currentFixedCandidateReused: true, additionalDependencyCopies: 0, globalWrites: 0, legacyAccess: 0, remoteCalls: 0, scope: "Actual local current fixed Gateway/Worker Product→Core uncertain acquire→owned stop→explicit restart→ordinary Backend chat; Electron UI/HTTP journal/restart recovery are separate" };
    fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n"); success = true; process.stdout.write(JSON.stringify({ status: "PASS", groups: groups.length, modelRequests, evidence: output }) + "\n");
  } catch(error) {
    const resultSummary=lastCoreResult&&Object.fromEntries(['outcome','needsVerification','stage','code','errorCode','status','blockedReason'].filter(key=>Object.hasOwn(lastCoreResult,key)).map(key=>[key,lastCoreResult[key]]));
    fs.writeFileSync(output+'.failure.json',JSON.stringify({status:'FAIL',code:error.code||error.name,message:error.message,phase,groups,physicalChildren:physical,modelRequests,acquires:lost.acquires,actualAcquireAckWithheld:lost.dropped,privateConfigWrites:lost.privateConfigWrites,acquireResponses:lost.acquireResponses,lastCoreResult:resultSummary,readTrace,privateRoot,sourceHashesBefore:before},null,2)+'\n');throw error;
  } finally {
    await backend?.stop(); if (worker?.getStatus().state !== "closed") await host?.close({ operationId: "owned-exit-proof-cleanup", timeoutMs: 30000 });
    if (model) { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
    if (!worker || worker.getStatus().state === "closed") {
      if(fs.existsSync(output+'.failure.json')){const saved=JSON.parse(fs.readFileSync(output+'.failure.json'));saved.cleanup={state:worker?.getStatus().state||'absent',ownership:worker?.getStatus().ownership||'absent',capturedChildrenAbsent:physical.every(child=>{try{process.kill(child.pid,0);return false;}catch(error){return error.code==='ESRCH';}}),fenceAbsent:!fs.existsSync(path.join(privateRoot,'external-plugin-host-data/openclaw/v1/writer.fence'))};fs.writeFileSync(output+'.failure.json',JSON.stringify(saved,null,2)+'\n');}
      fs.rmSync(privateRoot, { recursive: true, force: true });
    }
    else process.stderr.write("OWNED_EXIT_PRIVATE_CLEANUP_NEEDS_VERIFICATION\n");
  }
  assert(success);
}
main().catch(error => { process.stderr.write(`${error.code || error.name || "OWNED_EXIT_PROOF_FAILED"}\n`); process.exitCode = 1; });
