"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { RuntimeExtensionCatalog } = require("../app/agent-service/runtime-extension-manifest");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const policy = { sandbox: "danger-full-access", approvalPolicy: "never" }, runtime = "ext-coordinator";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value) + "\n", { mode: 0o600 });
function pathsFor(root) { return resolveServicePaths({ homeDir: root, trustedRoot: root, stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile") }); }
const peerSource = String.raw`
"use strict";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),readline=require("node:readline");
const root=__dirname,log=path.join(root,"peer-log.jsonl"),account=path.basename(process.env.HOME);let active=null,sessionId=null,releaseTimer=null;
const record=(method,params)=>fs.appendFileSync(log,JSON.stringify({pid:process.pid,method,sessionId,account,...(method==="session/prompt"?{prompt:params.prompt}: {})})+"\n",{mode:0o600});
const send=value=>process.stdout.write(JSON.stringify(value)+"\n");
const update=value=>send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:value}});
const finish=(reason="end_turn")=>{if(active===null)return;send({jsonrpc:"2.0",id:active,result:{stopReason:reason}});active=null;if(releaseTimer)clearInterval(releaseTimer);};
readline.createInterface({input:process.stdin}).on("line",line=>{
 const m=JSON.parse(line);if(!m.method)return;record(m.method,m.params);
 if(m.method==="initialize")send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
 if(m.method==="session/new"){
  const config=JSON.parse(fs.readFileSync(path.join(root,"scenario.json"),"utf8"));sessionId=config.fixedSessionId||"native-"+crypto.randomUUID();
  update({sessionUpdate:"available_commands_update",availableCommands:[{name:"plan",description:"Controlled plan"}]});
  send({jsonrpc:"2.0",id:m.id,result:{sessionId}});
 }
 if(m.method==="session/load"){sessionId=m.params.sessionId;const config=JSON.parse(fs.readFileSync(path.join(root,"scenario.json"),"utf8"));if(config.replayCompaction&&config.compactionId)update({sessionUpdate:"compaction_update",compactionId:config.compactionId,status:"completed"});send({jsonrpc:"2.0",id:m.id,result:{}});}
 if(m.method==="session/prompt"){
  active=m.id;let config=JSON.parse(fs.readFileSync(path.join(root,"scenario.json"),"utf8"));const mode=config.accounts?.[account]||config.mode;
  if(config.diagnosticProbe==="ignored")update({sessionUpdate:"x-"+config.diagnosticCanary,body:config.diagnosticCanary,path:config.diagnosticCanary});
  if(config.diagnosticProbe==="invalid"){update({sessionUpdate:"agent_message_chunk",content:{type:"text",text:{private:config.diagnosticCanary}}});return;}
  update({sessionUpdate:"agent_thought_chunk",messageId:"native-reason",content:{type:"text",text:"THOUGHT"}});
  for(let i=0;i<320;i++)update({sessionUpdate:"agent_message_chunk",messageId:"native-preamble",content:{type:"text",text:"x"}});
  update({sessionUpdate:"tool_call",toolCallId:"native-tool",title:"ControlledRead",kind:"read",status:"in_progress",rawInput:{value:"controlled"}});
  update({sessionUpdate:"tool_call_update",toolCallId:"native-tool",status:"completed",rawOutput:{value:"result"}});
  update({sessionUpdate:"agent_message_chunk",messageId:"native-final",content:{type:"text",text:config.output||"FINAL"}});
  update({sessionUpdate:"plan",entries:[{content:"Controlled step",priority:"medium",status:"completed"}]});
  if(config.compactionId){for(let i=0;i<2;i++)update({sessionUpdate:"compaction_update",compactionId:config.compactionId,status:"completed",summary:[{type:"text",text:"Controlled compact summary"}]});}
  if(mode==="unknown"||mode==="drop")update({sessionUpdate:"user_message_chunk",clientId:"coordinator-send",content:{type:"text",text:"controlled echo"}});
  fs.writeFileSync(path.join(root,"prompt-received-"+process.pid+".json"),JSON.stringify({sessionId,pid:process.pid}),{mode:0o600});
  if(mode==="drop"){setTimeout(()=>process.exit(17),30);return;}
  if(mode==="stream"||mode==="unknown"){
   releaseTimer=setInterval(()=>{if(fs.existsSync(path.join(root,"release")))finish();},10);return;
  }
  finish(config.stopReason||"end_turn");
 }
 if(m.method==="session/cancel"&&active!==null){send({jsonrpc:"2.0",id:active,result:{stopReason:"cancelled"}});active=null;}
});
process.stdin.on("end",()=>process.exit(0));
`;
function fixture(mode = "fast") {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/acp-coordinator-")), paths = pathsFor(root), peer = path.join(root, "peer.cjs");
  fs.writeFileSync(peer, peerSource, { mode: 0o600 }); write(path.join(root, "scenario.json"), { mode });
  const command = fs.realpathSync(process.execPath), manifest = { version: 1, runtime, transport: "acp", command, args: [peer],
    files: [command, peer].map(file => ({ path: file, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") })), endpoint: null, credentialRef: null };
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519"), payload = JSON.stringify(Object.fromEntries(Object.keys(manifest).sort().map(key => [key, manifest[key]])));
  new RuntimeExtensionCatalog(paths).install({ manifest, signature: crypto.sign(null, Buffer.from(payload), privateKey).toString("base64") }, publicKey.export({ type: "spki", format: "pem" }));
  return { root, paths, peer, cleanup() { cleanupPeers(root, peer); if (process.env.ACP_COORD_KEEP === "1") { process.stderr.write("Controlled retained root: " + root + "\n"); return; } fs.rmSync(root, { recursive: true, force: true }); } };
}
function logFor(root) {
  const file = path.join(root, "peer-log.jsonl"); if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
function cleanupPeers(root, peer) {
  for (const pid of new Set(logFor(root).map(v => v.pid))) {
    const command = spawnSync("/bin/ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" }).stdout;
    if (!command.includes(peer)) continue;
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
}
function serviceFor(f) {
  const service = createAgentService({ paths: f.paths, runtimeStorageHomedir: f.root,
    parentEnv: { HOME: f.root, PATH: "/usr/bin:/bin" }, safeStorage });
  const acquire = service.runtimeManager.acquire.bind(service.runtimeManager); service.fixtureAcquireErrors = [];
  service.runtimeManager.acquire = async (...args) => { try { return await acquire(...args); }
    catch (error) { service.fixtureAcquireErrors.push(error.code || "UNCLASSIFIED"); throw error; } };
  return service;
}
function profileFor(service, f, accountId = `extension-${runtime}`, name = "Controlled coordinator") {
  const base = { ...service.productStore.listAgentProfiles()[0] }; for (const key of ["defaultBindingId", "bindingsRevision", "selectedBindingId"]) delete base[key];
  const profile = service.productStore.putAgentProfile({ ...base, id: crypto.randomUUID(), agentId: "agent-" + crypto.randomUUID(), name,
    runtime, runtimeProfileId: "profile-" + crypto.randomUUID(), runtimeAccountId: accountId, isDefault: false, enabled: true,
    defaultModel: null, defaultCwd: f.root, permissionPolicy: policy });
  service.agentDefinitionStore.ensureProfile({ profileId: profile.id, profileName: profile.name }); service.memoryStore.ensureProfile(profile.id); return profile;
}
function sessionFor(service, f, profile, operation = "coordinator-create") { return service.chatSessionStore.createSession({ operationId: operation,
  profileId: profile.id, workspace: f.root, createdAt: Date.now() }); }
async function waitFor(predicate, label, limit = 12000) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await pause(10); }
  throw Error("Controlled coordinator fixture timed out: " + label);
}
const terminal = (service, runId) => waitFor(() => {
  const run = service.productStore.getWorkRun(runId); return run && ["completed", "failed", "canceled", "interrupted", "skipped"].includes(run.status) ? run : null;
}, "run terminal");
function ledgerFor(f, profile) {
  const binding = { runtime, runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId };
  const key = crypto.createHash("sha256").update(JSON.stringify([binding, f.root])).digest("hex");
  return JSON.parse(fs.readFileSync(path.join(f.paths.stateDir, "runtime-acp-ledgers", key + ".json"), "utf8"));
}
function snapshotLedgerFiles(f) {
  const directory = path.join(f.paths.stateDir, "runtime-acp-ledgers"), files = [];
  const scan = (at, prefix = "") => { for (const name of fs.readdirSync(at).sort()) {
    const file = path.join(at, name), relative = path.join(prefix, name), stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) scan(file, relative);
    else { assert.equal(stat.isFile(), true); const bytes = fs.readFileSync(file);
      files.push({ file: relative, dev: stat.dev, ino: stat.ino, nlink: stat.nlink, mode: stat.mode,
        size: stat.size, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.toString("base64") }); }
  } }; scan(directory); return files;
}
function ledgerTransactionEvidence(files) {
  const metadata = files.map(({ bytes, ...value }) => value);
  return { files: metadata, backupTargetDifferences: metadata.filter(value => value.file.includes(".backup-")).map(backup => {
    const target = metadata.find(value => value.file === backup.file.split(".backup-")[0]);
    return { target: target?.file ?? null, backup: backup.file, sameInode: !!target && target.dev === backup.dev && target.ino === backup.ino,
      sameBytes: !!target && target.sha256 === backup.sha256, targetNlink: target?.nlink ?? null, backupNlink: backup.nlink };
  }) };
}
async function history(service, sessionKey) { return service.chatServiceController.handle("chat.history", { sessionKey, cursor: null, limit: 100 }, null); }
function nativeHistory(service, session, page) {
  const events = new Map(service.transcriptStore.listEvents(session.profileId, session.id).map(event => [event.id, event]));
  return page.messages.map(v => v.payload?.message).filter(v => events.get(v?.shoggoth?.sourceEventId)?.content?.itemId).map(message => {
    const event = events.get(message.shoggoth.sourceEventId);
    return { id: message.id, itemId: event.content.itemId, type: event.content.transcriptType,
      segmentId: event.content.segmentId ?? null, content: message.content };
  });
}
function assertNativeHistory(service, session, page, items, live = []) {
  const projected = nativeHistory(service, session, page);
  assert.deepEqual([...new Set(projected.map(v => v.itemId))], items.map(v => v.id));
  assert.equal(new Set(projected.map(v => v.id)).size, projected.length);
  for (const entry of projected) {
    if (entry.type === "text") {
      assert.equal(entry.content[0].segmentId, entry.segmentId);
      if (live.length) assert.equal(live.some(v => v.type === "text" && v.payload?.itemId === entry.itemId
        && v.payload?.segmentId === entry.segmentId), true);
    }
    if (["tool.start", "tool.result"].includes(entry.type)) assert.equal(entry.content[0].toolCallId, entry.itemId);
  }
  return projected;
}
function observe(service, runId) {
  const events = [], subscription = service.workRunCoordinator.subscribeRun(runId, { streamId: null, afterSeq: 0 }, event => events.push(event));
  events.push(...subscription.events); return { events, close: subscription.unsubscribe };
}
async function childWorker(root, stage) {
  const f = { root, paths: pathsFor(root) }, service = serviceFor(f), acquire = service.runtimeManager.acquire.bind(service.runtimeManager), wrappers = new WeakMap();
  let profile, session;
  const checkpoint = phase => {
    const run = service.productStore.listWorkRuns({ profileId: profile.id })[0];
    write(path.join(root, "checkpoint.json"), { phase, runId: run.id, profile, sessionKey: session.sessionKey, sessionId: session.id,
      runtimeAttemptRef: run.runtimeAttemptRef, runtimeSessionRef: run.runtimeSessionRef, runtimeTurnRef: run.runtimeTurnRef });
  };
  service.runtimeManager.acquire = async (...args) => {
    const handle = await acquire(...args); if (!handle.capabilities["turn.start.prepare"]) return handle;
    if (wrappers.has(handle)) return wrappers.get(handle);
    const wrapped = { ...handle, async turnStart(input, observer) {
      const controlled = { ...observer,
        async onPrepared(dto) { await observer.onPrepared(dto); if (stage === "prepared") { checkpoint("prepared"); await new Promise(() => {}); } },
        onDispatchAttempt(dto) { observer.onDispatchAttempt(dto); if (stage === "unknown") {
          const timer = setInterval(() => { if (fs.readdirSync(root).some(name => name.startsWith("prompt-received-"))) { clearInterval(timer); checkpoint("write_attempted"); } }, 10);
        } } };
      const result = await handle.turnStart(input, controlled);
      if (stage === "terminal") { checkpoint("terminal_durable"); await new Promise(() => {}); }
      return result;
    } };
    wrappers.set(handle, wrapped); return wrapped;
  };
  await service.start(); profile = profileFor(service, f); session = sessionFor(service, f, profile);
  await service.workRunCoordinator.send({ sessionKey: session.sessionKey, operationId: "coordinator-send", prompt: "Controlled coordinator task" });
}

if (process.argv[2] === "--worker") {
  childWorker(process.argv[3], process.argv[4]).catch(error => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; });
} else {
  for (const diagnosticProbe of ["ignored", "invalid"]) test(`real Service public observability retains safe ACP ${diagnosticProbe} update counts after host retirement`, async () => {
    const f = fixture(), service = serviceFor(f), nativeId = "PRIVATE_NATIVE_SESSION_" + crypto.randomUUID();
    const canary = "PRIVATE_UPDATE_KIND_BODY_/private/path_" + crypto.randomUUID();
    const stage = diagnosticProbe === "ignored" ? "acp_update_ignored" : "acp_invalid_update";
    const code = diagnosticProbe === "ignored" ? "ACP_UPDATE_IGNORED" : "ACP_UPDATE_INVALID";
    const outcome = diagnosticProbe === "ignored" ? "unknown" : "error";
    const readMetrics = () => requestService(f.paths, { token: readClientToken(f.paths), version: SERVICE_PROTOCOL_VERSION,
      method: "runtime.observability.get", params: {} });
    try {
      write(path.join(f.root, "scenario.json"), { mode: "fast", fixedSessionId: nativeId, diagnosticProbe, diagnosticCanary: canary });
      await service.start(); const profile = profileFor(service, f), session = sessionFor(service, f, profile);
      const before = await readMetrics(); assert.equal(before.stageSamples[stage], undefined);
      const ack = await service.workRunCoordinator.send({ sessionKey: session.sessionKey, operationId: "diagnostic-probe-send", prompt: canary });
      const run = await terminal(service, ack.run.id), promptCalls = logFor(f.root).filter(v => v.method === "session/prompt");
      assert.equal(promptCalls.length, 1);
      if (diagnosticProbe === "ignored") assert.equal(run.status, "completed", run.errorCode);
      else {
        assert.equal(["failed", "interrupted"].includes(run.status), true); assert.equal(run.errorCode, "RUNTIME_TURN_ACCEPTANCE_UNKNOWN");
        assert.equal(run.runtimeSessionRef, null); assert.equal(run.runtimeTurnRef, null);
        assert.equal(run.runtimeAttemptRef.dispatchState, "write_attempted");
        const turn = ledgerFor(f, profile).sessions[0].turns[0];
        assert.equal(turn.facts.unknown, true); assert.equal(turn.facts.remoteAccepted, false); assert.equal(turn.facts.terminal, false);
      }
      const snapshot = await readMetrics();
      const expected = { count: 1, success: 0, error: outcome === "error" ? 1 : 0, unknown: outcome === "unknown" ? 1 : 0 };
      assert.deepEqual(snapshot.stageSamples[stage], expected);
      const recorded = snapshot.events.filter(event => event.stage === stage);
      assert.equal(recorded.length, 1); assert.deepEqual(recorded[0], { name: "runtime.stage", at: recorded[0].at, stage, outcome, code, count: 1 });
      await service.runtimeManager.stop({ runtime, runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId });
      await waitFor(() => service.runtimeManager.statistics().hosts === 0, "diagnostic host retirement");
      for (const pid of new Set(promptCalls.map(call => call.pid))) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      const retired = await readMetrics(); assert.deepEqual(retired.stageSamples[stage], expected);
      assert.equal(retired.hosts.hosts, 0); assert.equal(retired.scope, "service-process");
      assert.deepEqual(retired.events.filter(event => event.stage === stage), recorded);
      for (const value of [snapshot, retired]) {
        const serialized = JSON.stringify(value);
        assert.equal(Buffer.byteLength(serialized) < 64 * 1024, true);
        for (const privateValue of [canary, nativeId, f.root, profile.id, profile.runtimeProfileId, profile.runtimeAccountId, session.sessionKey, session.id, ack.run.id]) {
          assert.equal(serialized.includes(privateValue), false, "public observability must omit original text, paths and raw IDs");
        }
      }
      assert.equal(logFor(f.root).filter(v => v.method === "session/prompt").length, 1);
    } finally { await service.stop({ notify: false }); f.cleanup(); }
  });

  test("real Coordinator routes 320 updates during prompt wait and refreshes structured item identity", async () => {
    const f = fixture("stream"), service = serviceFor(f); let subscription;
    try {
      await service.start(); const profile = profileFor(service, f), session = sessionFor(service, f, profile);
      const ack = await service.workRunCoordinator.send({ sessionKey: session.sessionKey, operationId: "coordinator-send", prompt: "Controlled coordinator task" });
      subscription = observe(service, ack.run.id);
      await waitFor(() => subscription.events.filter(v => v.type === "text.delta" && v.payload?.itemId === "native-preamble").length === 320, "320 early text events");
      const live = service.productStore.getWorkRun(ack.run.id);
      assert.equal(["starting", "running"].includes(live.status), true); assert.equal(live.runtimeTurnRef, null);
      assert.equal(live.runtimeAttemptRef.dispatchState, "write_attempted");
      const inProgress = ledgerFor(f, profile).sessions[0].turns[0]; assert.equal(inProgress.facts.remoteAccepted, false); assert.equal(inProgress.facts.terminal, false);
      fs.writeFileSync(path.join(f.root, "release"), "release", { mode: 0o600 });
      const run = await terminal(service, ack.run.id); assert.equal(run.status, "completed", run.errorCode || "completion");
      await pause(40); assert.equal(service.productStore.getWorkRun(run.id).status, "completed");
      const stored = ledgerFor(f, profile).sessions[0].turns[0], liveIds = new Set(subscription.events.map(v => v.payload?.itemId).filter(Boolean));
      assert.equal(stored.facts.remoteAccepted, true); assert.equal(stored.facts.terminal, true);
      for (const item of stored.items) assert.equal(liveIds.has(item.id), true, item.id);
      const first = assertNativeHistory(service, session, await history(service, session.sessionKey), stored.items, subscription.events);
      const second = nativeHistory(service, session, await history(service, session.sessionKey)); assert.deepEqual(second, first);
      assert.deepEqual(first.map(v => v.type), ["reasoning", "text", "tool.start", "tool.result", "text", "plan"]);
    } finally { subscription?.close(); await service.stop({ notify: false }); f.cleanup(); }
  });

  test("extremely fast terminal cannot return a completed WorkRun to running", async () => {
    const f = fixture(), service = serviceFor(f); let subscription;
    try {
      await service.start(); const profile = profileFor(service, f), session = sessionFor(service, f, profile);
      const ack = await service.workRunCoordinator.send({ sessionKey: session.sessionKey, operationId: "coordinator-send", prompt: "Controlled coordinator task" });
      subscription = observe(service, ack.run.id); const run = await terminal(service, ack.run.id);
      assert.equal(run.status, "completed", run.errorCode || "completion"); await pause(75);
      assert.equal(service.productStore.getWorkRun(run.id).status, "completed");
      assert.equal(run.runtimeSessionRef.sessionId, run.runtimeAttemptRef.sessionId); assert.equal(run.runtimeTurnRef.turnId, run.runtimeAttemptRef.turnId);
      const statuses = subscription.events.filter(v => v.type === "status").map(v => v.payload?.status), completed = statuses.lastIndexOf("completed");
      if (completed >= 0) assert.equal(statuses.slice(completed + 1).includes("running"), false);
      assert.equal(logFor(f.root).filter(v => v.method === "session/prompt").length, 1);
    } finally { subscription?.close(); await service.stop({ notify: false }); f.cleanup(); }
  });

  for (const stage of ["terminal", "prepared", "unknown"]) test(`actual Service restart reconciles ${stage} evidence without duplicate execution`, async () => {
    const f = fixture(stage === "unknown" ? "unknown" : "fast"); let worker, service;
    try {
      worker = spawn(process.execPath, [__filename, "--worker", f.root, stage], { stdio: ["ignore", "pipe", "pipe"], env: { HOME: f.root, PATH: process.env.PATH } });
      let errors = ""; worker.stderr.on("data", chunk => { errors += chunk; fs.appendFileSync(path.join(f.root, "worker-stderr.log"), chunk, { mode: 0o600 }); });
      const checkpoint = await waitFor(() => {
        if (worker.exitCode !== null || worker.signalCode !== null) throw Error("Controlled child Service exited: " + JSON.stringify({ exitCode: worker.exitCode, signal: worker.signalCode }) + ":" + errors);
        try { return JSON.parse(fs.readFileSync(path.join(f.root, "checkpoint.json"), "utf8")); } catch { return null; }
      }, stage + " crash checkpoint", 20000);
      assert.equal(checkpoint.runtimeSessionRef, null); assert.equal(checkpoint.runtimeTurnRef, null);
      assert.equal(checkpoint.runtimeAttemptRef.dispatchState, stage === "prepared" ? "prepared" : "write_attempted");
      const count = logFor(f.root).filter(v => v.method === "session/prompt").length;
      const before = ledgerFor(f, checkpoint.profile).sessions[0].turns[0];
      assert.equal(before.facts.terminal, stage === "terminal"); assert.equal(before.facts.writeAttempted, stage !== "prepared");
      const closed = new Promise(resolve => worker.once("close", resolve)); worker.kill("SIGKILL"); await closed; worker = null;
      cleanupPeers(f.root, f.peer); write(path.join(f.root, "scenario.json"), { mode: "fast" });
      const killedLedgerEvidence = stage === "unknown" ? snapshotLedgerFiles(f) : null;
      service = serviceFor(f); await service.start();
      const recovered = await terminal(service, checkpoint.runId);
      assert.equal(recovered.status, stage === "unknown" ? "interrupted" : "completed", (recovered.errorCode || "recovery") + ":" + service.fixtureAcquireErrors.join(","));
      const afterCount = logFor(f.root).filter(v => v.method === "session/prompt").length;
      assert.equal(afterCount, count + (stage === "prepared" ? 1 : 0));
      if (stage === "unknown") {
        assert.equal(recovered.runtimeSessionRef, null); assert.equal(recovered.runtimeTurnRef, null);
        assert.equal(recovered.errorCode, "RUNTIME_TURN_ACCEPTANCE_UNKNOWN");
        assert.deepEqual(recovered.runtimeAttemptRef, checkpoint.runtimeAttemptRef);
        if (service.fixtureAcquireErrors.includes("RUNTIME_LEDGER_UNCERTAIN")) {
          assert.deepEqual(snapshotLedgerFiles(f), killedLedgerEvidence,
            "A refused crash transaction keeps every original file byte, inode and link count unchanged");
          console.log(JSON.stringify({ evidence: "actual-unknown-private-file-barrier", runId: recovered.id,
            productStatus: recovered.status, errorCode: recovered.errorCode, acceptedRefs: null, promptCount: afterCount,
            transaction: ledgerTransactionEvidence(killedLedgerEvidence) }));
        } else {
          const turn = ledgerFor(f, checkpoint.profile).sessions[0].turns[0]; assert.equal(turn.facts.unknown, true); assert.equal(turn.facts.terminal, false);
          assert.equal(turn.items.some(v => v.clientId), false);
        }
      } else {
        assert.equal(recovered.runtimeTurnRef.turnId, before.id); assert.equal(recovered.runtimeAttemptRef.attemptId, checkpoint.runtimeAttemptRef.attemptId);
        const items = ledgerFor(f, checkpoint.profile).sessions[0].turns[0].items;
        const session = service.chatSessionStore.getSession(checkpoint.sessionKey);
        assertNativeHistory(service, session, await history(service, checkpoint.sessionKey), items);
      }
    } finally {
      if (worker && worker.exitCode === null && worker.signalCode === null) { const closed = new Promise(resolve => worker.once("close", resolve)); worker.kill("SIGKILL"); await closed; }
      await service?.stop({ notify: false }); f.cleanup();
    }
  });

  test("a dropped prompt with a local clientId echo cannot affect a concurrent isolated account", async () => {
    const f = fixture(), service = serviceFor(f);
    try {
      await service.start(); const accountA = service.productStore.getRuntimeAccount(`extension-${runtime}`), accountB = "controlled-account-b";
      service.productStore.putRuntimeAccount({ ...accountA, id: accountB, isDefault: false });
      write(path.join(f.root, "scenario.json"), { mode: "fast", accounts: { [accountA.id]: "drop", [accountB]: "fast" } });
      const one = profileFor(service, f, accountA.id, "Unknown fixture"), two = profileFor(service, f, accountB, "Healthy fixture");
      const first = sessionFor(service, f, one, "unknown-create"), second = sessionFor(service, f, two, "healthy-create");
      const [a, b] = await Promise.all([
        service.workRunCoordinator.send({ sessionKey: first.sessionKey, operationId: "coordinator-send", prompt: "Controlled unknown task" }),
        service.workRunCoordinator.send({ sessionKey: second.sessionKey, operationId: "healthy-send", prompt: "Controlled healthy task" }),
      ]);
      const [unknown, healthy] = await Promise.all([terminal(service, a.run.id), terminal(service, b.run.id)]);
      assert.equal(healthy.status, "completed", healthy.errorCode || "healthy account");
      assert.equal(["failed", "interrupted"].includes(unknown.status), true); assert.equal(unknown.errorCode, "RUNTIME_TURN_ACCEPTANCE_UNKNOWN");
      assert.equal(unknown.runtimeTurnRef, null); assert.equal(healthy.runtimeTurnRef.runtimeAccountId, accountB);
      const badLedger = ledgerFor(f, one).sessions[0].turns[0], goodLedger = ledgerFor(f, two).sessions[0].turns[0];
      assert.equal(badLedger.facts.unknown, true); assert.equal(badLedger.items.some(v => v.clientId), false); assert.equal(goodLedger.facts.terminal, true);
      const before = logFor(f.root).filter(v => v.method === "session/prompt").length;
      const retry = await service.workRunCoordinator.send({ sessionKey: first.sessionKey, operationId: "coordinator-send", prompt: "Controlled unknown task" });
      assert.equal(retry.run.id, unknown.id); await pause(50);
      assert.equal(logFor(f.root).filter(v => v.method === "session/prompt").length, before);
    } finally { await service.stop({ notify: false }); f.cleanup(); }
  });

  for (const [stopReason, errorCode] of [["max_tokens", "RUNTIME_MAX_TOKENS"], ["max_turn_requests", "RUNTIME_MAX_TURN_REQUESTS"], ["refusal", "RUNTIME_REFUSED"]]) {
    test(`actual Service retains the distinct ${stopReason} terminal reason`, async () => {
      const f = fixture(), service = serviceFor(f);
      try {
        write(path.join(f.root, "scenario.json"), { mode: "fast", stopReason });
        await service.start(); const profile = profileFor(service, f), session = sessionFor(service, f, profile);
        const ack = await service.workRunCoordinator.send({ sessionKey: session.sessionKey, operationId: "coordinator-send", prompt: "Controlled terminal reason" });
        const run = await terminal(service, ack.run.id);
        assert.equal(run.status, "failed"); assert.equal(run.errorCode, errorCode);
        const turn = ledgerFor(f, profile).sessions[0].turns[0]; assert.equal(turn.facts.stopReason, stopReason);
        assert.equal(turn.facts.terminal, true); assert.equal(turn.facts.remoteAccepted, true);
        assert.equal(turn.contextDelivery.confirmed, stopReason !== "refusal");
      } finally { await service.stop({ notify: false }); f.cleanup(); }
    });
  }

  for (const contextLifecycleV1 of [false, true]) test(`actual Service excludes refusal input and output from future context (${contextLifecycleV1})`, async () => {
    const f = fixture(), service = serviceFor(f);
    try {
      await service.start(); const cfg = service.nativeRuntimeConfig.read();
      service.nativeRuntimeConfig.apply({ ...cfg, revision: cfg.revision + 1,
        flags: { ...cfg.flags, runtimeContextLifecycleV1: contextLifecycleV1 } });
      const profile = profileFor(service, f), session = sessionFor(service, f, profile);
      const send = async (operationId, prompt) => terminal(service, (await service.workRunCoordinator.send({ sessionKey: session.sessionKey, operationId, prompt })).run.id);
      const prior = await send("prior", "PRIOR_CONTEXT_CANARY"); assert.equal(prior.status, "completed", prior.errorCode);
      write(path.join(f.root, "scenario.json"), { mode: "fast", stopReason: "refusal", output: "REFUSAL_OUTPUT_CANARY" });
      const refused = await send("refused", "REFUSAL_INPUT_CANARY"); assert.equal(refused.errorCode, "RUNTIME_REFUSED");
      write(path.join(f.root, "scenario.json"), { mode: "fast" });
      const next = await send("after-refusal", "Continue safely"); assert.equal(next.status, "completed", next.errorCode);
      const prompt = logFor(f.root).filter(v => v.method === "session/prompt").at(-1).prompt.map(v => v.text || "").join("\n");
      assert.doesNotMatch(prompt, /REFUSAL_(INPUT|OUTPUT)_CANARY/);
      const visible = JSON.stringify(await history(service, session.sessionKey));
      assert.match(visible, /PRIOR_CONTEXT_CANARY/); assert.match(visible, /REFUSAL_INPUT_CANARY/); assert.match(visible, /REFUSAL_OUTPUT_CANARY/);
      const events = service.transcriptStore.listEvents(profile.id, session.id);
      const refusalEvents = events.filter(v => v.runId === refused.id && ["user", "assistant", "tool_call", "tool_result"].includes(v.kind));
      assert.equal(refusalEvents.length > 0, true); assert.equal(refusalEvents.every(v => v.contextExcluded), true);
      const priorEvents = events.filter(v => v.runId === prior.id && ["user", "assistant"].includes(v.kind));
      assert.equal(priorEvents.every(v => !v.contextExcluded), true);
      const compiled = service.contextCompiler.compile({ profile: service.productStore.resolveAgentRuntimeProfile(profile.id),
        run: next, transcriptSessionId: session.id, query: "Continue safely", currentPrompt: "Continue safely",
        contextLifecycleV1, currentOperationId: "after-refusal", freshSession: true });
      assert.doesNotMatch(compiled.dynamicContext, /REFUSAL_(INPUT|OUTPUT)_CANARY/);
      assert.match(compiled.dynamicContext, /PRIOR_CONTEXT_CANARY/);
    } finally { await service.stop({ notify: false }); f.cleanup(); }
  });

  test("a memory version change during encrypted preparation sends no prompt byte", async () => {
    const f = fixture(), service = serviceFor(f);
    try {
      await service.start(); const profile = profileFor(service, f), session = sessionFor(service, f, profile);
      const checkpoints = service.conversationCheckpointStore, memoryVersion = checkpoints.nativeMemoryVersion.bind(checkpoints);
      let changed = false, preparationObserved = false;
      checkpoints.nativeMemoryVersion = (...args) => { const version = memoryVersion(...args); assert.ok(version);
        return { ...version, memoryInvalidationRevision: version.memoryInvalidationRevision + (changed ? 1 : 0) }; };
      const executions = service.workRunCoordinator.runExecutionStore, putAttempt = executions.putAttempt.bind(executions);
      executions.putAttempt = async (...args) => { preparationObserved = true; await putAttempt(...args); changed = true; };
      const ack = await service.workRunCoordinator.send({ sessionKey: session.sessionKey, operationId: "coordinator-send", prompt: "Controlled obsolete memory" });
      const run = await terminal(service, ack.run.id);
      assert.equal(preparationObserved, true); assert.equal(run.status, "failed");
      assert.equal(logFor(f.root).filter(v => v.method === "session/prompt").length, 0);
      const turn = ledgerFor(f, profile).sessions[0].turns[0]; assert.equal(turn.facts.writeAttempted, false); assert.equal(turn.facts.notSent, true);
      assert.equal(run.errorCode, "CONTEXT_SOURCE_STALE");
    } finally { await service.stop({ notify: false }); f.cleanup(); }
  });


  for (const stage of ["encrypted-prepare", "bridge-prepare"]) test(`actual Service cancels an unsent ${stage} without waiting for its suspended continuation`, async () => {
    const f = fixture(), service = serviceFor(f); let release;
    const held = new Promise(resolve => { release = resolve; }); let enteredResolve;
    const entered = new Promise(resolve => { enteredResolve = resolve; });
    try {
      await service.start(); const profile = profileFor(service, f), session = sessionFor(service, f, profile), coordinator = service.workRunCoordinator;
      if (stage === "encrypted-prepare") {
        const executions = coordinator.runExecutionStore, putAttempt = executions.putAttempt.bind(executions);
        executions.putAttempt = async (...args) => { await putAttempt(...args); enteredResolve(); await held; };
      } else {
        const acquire = service.runtimeManager.acquire.bind(service.runtimeManager), wrapped = new WeakSet();
        service.runtimeManager.acquire = async (...args) => {
          const handle = await acquire(...args), bridge = handle.host?.acpBridge;
          if (handle.capabilities["turn.start.prepare"] && bridge && !wrapped.has(bridge)) {
            wrapped.add(bridge); const prepareTurn = bridge.prepareTurn.bind(bridge);
            bridge.prepareTurn = async (...params) => { await prepareTurn(...params); enteredResolve(); await held; };
          }
          return handle;
        };
      }
      const ack = await coordinator.send({ sessionKey: session.sessionKey, operationId: "coordinator-send", prompt: "Controlled suspended preparation" });
      await Promise.race([entered, pause(10000).then(() => { throw Error("Controlled preparation did not suspend"); })]);
      const prepared = service.productStore.getWorkRun(ack.run.id), assignment = coordinator.runHostAssignments.get(ack.run.id);
      assert.equal(prepared.status, "starting"); assert.equal(prepared.runtimeSessionRef, null); assert.equal(prepared.runtimeTurnRef, null);
      assert.equal(prepared.runtimeAttemptRef?.dispatchState ?? null, stage === "encrypted-prepare" ? null : "prepared");
      const pid = assignment.host.host.child.pid; assert.equal(Number.isSafeInteger(pid) && pid > 1, true);
      const controller = coordinator.startupControllers.get(ack.run.id), started = Date.now();
      const abort = coordinator.abort({ operationId: "cancel-suspended", sessionKey: session.sessionKey, runId: ack.run.id });
      const canceled = await Promise.race([abort, pause(5000).then(() => { throw Error("Abort waited for a suspended preparation"); })]);
      assert.equal(canceled.status, "canceled"); assert.equal(Date.now() - started < 5000, true); assert.equal(controller.signal.aborted, true);
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      assert.equal(logFor(f.root).filter(v => v.method === "session/prompt").length, 0);
      const beforeRelease = ledgerFor(f, profile).sessions[0].turns[0]; assert.equal(beforeRelease.facts.writeAttempted, false);
      release();
      await waitFor(() => !coordinator.runTails.has(ack.run.id) && !coordinator.runControlTails.has(ack.run.id)
        && !coordinator.preparingAcpCancellations.has(ack.run.id), "late preparation and abort cleanup");
      assert.equal(service.productStore.getWorkRun(ack.run.id).status, "canceled");
      assert.equal(coordinator.startupControllers.has(ack.run.id), false); assert.equal(coordinator.runHostAssignments.has(ack.run.id), false);
      assert.equal([...coordinator.controlOperations.values()].some(v => v.pending), false);
      assert.equal(logFor(f.root).filter(v => v.method === "session/prompt").length, 0);
      assert.equal(ledgerFor(f, profile).sessions[0].turns[0].facts.writeAttempted, false);
      assert.equal(coordinator.poisonError, null);
    } finally { release(); await service.stop({ notify: false }); f.cleanup(); }
  });


  test("actual Coordinator persists one compaction notice across duplicate completion, replay and Service restart", async () => {
    const f = fixture(); let service = serviceFor(f), subscription;
    const transcriptFailures = [];
    const trace = () => { const append = service.transcriptStore.appendEvent.bind(service.transcriptStore);
      service.transcriptStore.appendEvent = input => { try { return append(input); }
        catch (error) { transcriptFailures.push({ code: error.code || "UNCLASSIFIED", type: input.content?.transcriptType, status: input.content?.status }); throw error; } }; };
    trace();
    try {
      write(path.join(f.root, "scenario.json"), { mode: "fast", compactionId: "same-compaction-id", fixedSessionId: "same-native-session-id", replayCompaction: true });
      await service.start(); const cfg = service.nativeRuntimeConfig.read();
      service.nativeRuntimeConfig.apply({ ...cfg, revision: cfg.revision + 1,
        flags: { ...cfg.flags, runtimeContextLifecycleV1: true } });
      const profile = profileFor(service, f), accountB = "controlled-compaction-account-b";
      service.productStore.putRuntimeAccount({ ...service.productStore.getRuntimeAccount(profile.runtimeAccountId), id: accountB, isDefault: false });
      const bindingB = service.productStore.addAgentRuntimeBinding(profile.id, { runtime, runtimeAccountId: accountB }, { operationId: "add-compaction-binding-b" }).binding;
      const session = sessionFor(service, f, profile), bindingA = session.runtimeBindingId;
      const notices = () => service.transcriptStore.listEvents(profile.id, session.id)
        .filter(v => v.content?.transcriptType === "context.native.compacted");
      const compacted = events => events.filter(v => v.type === "status" && v.payload?.status === "compacted");
      const first = await service.workRunCoordinator.send({ sessionKey: session.sessionKey, operationId: "compaction-first", prompt: "Controlled first compaction" });
      subscription = observe(service, first.run.id);
      const firstRun = await terminal(service, first.run.id); assert.equal(firstRun.status, "completed", firstRun.errorCode);
      assert.equal(compacted(subscription.events).length, 1, "a completed-without-start cycle and its duplicate publish only once");
      assert.equal(notices().length, 1); assert.equal(notices()[0].content.compactionId, "same-compaction-id");
      const noticeId = notices()[0].id;
      assert.equal((await history(service, session.sessionKey)).messages.filter(v => v.payload?.message?.notice === "contextCompacted").length, 1);
      subscription.close(); subscription = null; await service.stop({ notify: false });
      service = serviceFor(f); trace(); await service.start();
      const second = await service.workRunCoordinator.send({ sessionKey: session.sessionKey, operationId: "compaction-second", prompt: "Controlled after restart" });
      subscription = observe(service, second.run.id);
      const afterRestart = await terminal(service, second.run.id);
      assert.equal(afterRestart.status, "completed", JSON.stringify({ errorCode: afterRestart.errorCode, acquireErrors: service.fixtureAcquireErrors, transcriptFailures }));
      assert.equal(logFor(f.root).some(v => v.method === "session/load"), true, "the restarted process must exercise actual load replay");
      assert.equal(compacted(subscription.events).length, 0, "a replayed completed ID cannot become a second live compaction");
      assert.equal(notices().length, 1); assert.equal(notices()[0].id, noticeId);
      assert.equal((await history(service, session.sessionKey)).messages.filter(v => v.payload?.message?.notice === "contextCompacted").length, 1);
      subscription.close(); subscription = null;
      const beforeSwitch = service.chatSessionStore.getSession(session.sessionKey);
      const switched = service.chatSessionStore.switchRuntime(session.sessionKey, { bindingId: bindingB.id,
        revision: beforeSwitch.revision, clearModelOverride: true });
      service.chatSessionStore.markRuntimeSwitchAudited(session.sessionKey, switched.revision);
      const third = await service.workRunCoordinator.send({ sessionKey: session.sessionKey, operationId: "compaction-binding-b", prompt: "Controlled compaction in another Binding" });
      subscription = observe(service, third.run.id);
      const switchedRun = await terminal(service, third.run.id);
      assert.equal(switchedRun.status, "completed", JSON.stringify({ errorCode: switchedRun.errorCode, transcriptFailures }));
      assert.equal(switchedRun.runtimeSessionRef.runtimeAccountId, accountB);
      assert.equal(switchedRun.runtimeSessionRef.sessionId, firstRun.runtimeSessionRef.sessionId, "the two Agent accounts deliberately reuse the native session ID");
      assert.equal(compacted(subscription.events).length, 1, "the other Binding owns its own completed compaction");
      assert.equal(notices().length, 2);
      assert.deepEqual(new Set(notices().map(v => v.content.runtimeBindingId)), new Set([bindingA, bindingB.id]));
      assert.equal(notices().every(v => v.content.compactionId === "same-compaction-id"), true);
      assert.equal(new Set(notices().map(v => v.id)).size, 2);
      assert.equal((await history(service, session.sessionKey)).messages.filter(v => v.payload?.message?.notice === "contextCompacted").length, 2);
      assert.equal(transcriptFailures.length, 0);
    } finally { subscription?.close(); await service.stop({ notify: false }); f.cleanup(); }
  });

  for (const recoveryFailure of ["ledger", "stop-ledger"]) test(recoveryFailure === "ledger"
    ? "written ACP ledger uncertainty during recovery preserves unknown without rewriting raw evidence or replaying"
    : "mixed unconfirmed stop and ACP ledger uncertainty during recovery poisons without releasing the active attempt", async () => {
    const f = fixture("unknown"); let worker, service;
    const rawLedgerEvidence = () => snapshotLedgerFiles(f);
    try {
      worker = spawn(process.execPath, [__filename, "--worker", f.root, "unknown"], { stdio: ["ignore", "pipe", "pipe"], env: { HOME: f.root, PATH: process.env.PATH } });
      let errors = ""; worker.stderr.on("data", chunk => { errors += chunk; fs.appendFileSync(path.join(f.root, "worker-stderr.log"), chunk, { mode: 0o600 }); });
      const checkpoint = await waitFor(() => {
        if (worker.exitCode !== null || worker.signalCode !== null) throw Error("Controlled child Service exited: " + JSON.stringify({ exitCode: worker.exitCode, signal: worker.signalCode }) + ":" + errors);
        try { return JSON.parse(fs.readFileSync(path.join(f.root, "checkpoint.json"), "utf8")); } catch { return null; }
      }, "written unknown crash checkpoint", 20000);
      assert.equal(checkpoint.runtimeAttemptRef.dispatchState, "write_attempted");
      assert.equal(checkpoint.runtimeSessionRef, null); assert.equal(checkpoint.runtimeTurnRef, null);
      const count = logFor(f.root).filter(value => value.method === "session/prompt").length; assert.equal(count, 1);
      const closed = new Promise(resolve => worker.once("close", resolve)); worker.kill("SIGKILL"); await closed; worker = null;
      cleanupPeers(f.root, f.peer);
      const rawBefore = rawLedgerEvidence(); assert(rawBefore.some(value => value.file.endsWith(".json")));
      service = serviceFor(f); const acquire = service.runtimeManager.acquire.bind(service.runtimeManager);
      const ledgerUncertainty = Object.assign(Error("Controlled uncertain private-file recovery evidence"), { code: "RUNTIME_LEDGER_UNCERTAIN" });
      const controlled = recoveryFailure === "ledger" ? ledgerUncertainty
        : Object.assign(Error("Controlled process stop remains unconfirmed"), { code: "RUNTIME_STOP_UNCONFIRMED", cause: ledgerUncertainty });
      let acquireFailures = 0;
      service.runtimeManager.acquire = async (...args) => {
        if (args[0]?.runtime === runtime) { acquireFailures++; throw controlled; }
        return acquire(...args);
      };
      if (recoveryFailure === "stop-ledger") {
        const executionFile = path.join(f.paths.stateDir, "run-executions", crypto.createHash("sha256").update(JSON.stringify(checkpoint.runId)).digest("hex") + ".json");
        const executionBefore = fs.readFileSync(executionFile), coordinator = service.workRunCoordinator;
        await assert.rejects(service.start(), { code: "RUNTIME_STOP_UNCONFIRMED" });
        assert.equal(acquireFailures > 0, true); assert.equal(coordinator.poisonError?.code, "RUNTIME_STOP_UNCONFIRMED");
        const { JsonlProductStore } = require("../app/agent-service/product-store"), { TranscriptStore } = require("../app/agent-service/transcript-store");
        const product = new JsonlProductStore({ paths: f.paths }), transcript = new TranscriptStore({ paths: f.paths, readOnly: true });
        try {
          product.open(); transcript.open(); const retained = product.getWorkRun(checkpoint.runId);
          assert.equal(["starting", "running", "waiting_approval", "waiting_input"].includes(retained.status), true);
          assert.deepEqual(retained.runtimeAttemptRef, checkpoint.runtimeAttemptRef);
          assert.equal(retained.runtimeSessionRef, null); assert.equal(retained.runtimeTurnRef, null);
          assert.equal(transcript.listEvents(checkpoint.profile.id, checkpoint.sessionId).filter(value => value.runId === checkpoint.runId && value.content?.transcriptType === "terminal").length, 0);
        } finally { transcript.close(); product.close(); }
        assert.deepEqual(fs.readFileSync(executionFile), executionBefore, "Unconfirmed stop cannot remove the frozen execution descriptor");
        assert.deepEqual(rawLedgerEvidence(), rawBefore); assert.equal(logFor(f.root).filter(value => value.method === "session/prompt").length, count);
        return;
      }
      await service.start();
      const recovered = await terminal(service, checkpoint.runId);
      assert.equal(acquireFailures > 0, true, "Recovery must observe the real acquire rejection; no prompt may be retried");
      assert.equal(recovered.status, "interrupted", recovered.errorCode || "recovery result");
      assert.equal(recovered.errorCode, "RUNTIME_TURN_ACCEPTANCE_UNKNOWN");
      assert.deepEqual(recovered.runtimeAttemptRef, checkpoint.runtimeAttemptRef);
      assert.equal(recovered.runtimeSessionRef, null); assert.equal(recovered.runtimeTurnRef, null);
      assert.deepEqual(rawLedgerEvidence(), rawBefore, "The unavailable ledger and transaction artifacts remain untouched for verification");
      assert.equal(logFor(f.root).filter(value => value.method === "session/prompt").length, count);
      const operation = await service.workRunCoordinator.send({ sessionKey: checkpoint.sessionKey, operationId: "coordinator-send", prompt: "Controlled coordinator task" });
      assert.equal(operation.run.id, recovered.id); assert.equal(operation.run.status, "interrupted");
      assert.equal(logFor(f.root).filter(value => value.method === "session/prompt").length, count);
      const terminals = service.transcriptStore.listEvents(checkpoint.profile.id, checkpoint.sessionId).filter(value => value.content?.transcriptType === "terminal");
      assert.equal(terminals.length, 1); assert.equal(terminals[0].content.errorCode, "RUNTIME_TURN_ACCEPTANCE_UNKNOWN");
    } finally {
      if (worker && worker.exitCode === null && worker.signalCode === null) { const closed = new Promise(resolve => worker.once("close", resolve)); worker.kill("SIGKILL"); await closed; }
      if (service) await service.stop({ notify: false }); f.cleanup();
    }
  });

}
