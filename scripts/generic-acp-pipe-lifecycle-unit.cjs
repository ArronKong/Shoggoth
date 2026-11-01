"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { AcpJsonlClient } = require("../app/agent-service/acp-jsonl-client");
const { createAcpHandle } = require("../app/agent-service/runtime-acp-handle");
const { runtimeHandleV1 } = require("../app/agent-service/runtime-handle-v1");
const binding = { runtime: "ext-pipe-lifecycle", runtimeProfileId: "profile", runtimeAccountId: "account" };
const ledgerFile = root => path.join(root, "runtime-acp-ledgers", crypto.createHash("sha256").update(JSON.stringify([binding, root])).digest("hex") + ".json");
const observer = extra => ({ version: 1, attemptId: "pipe-attempt", onPrepared: async () => {}, onDispatchAttempt() {}, assertCurrent() {}, ...extra });
const peerSource = String.raw`
"use strict";
const fs=require("node:fs"),readline=require("node:readline");
const [log,mode]=process.argv.slice(2);let active=null;
const send=v=>process.stdout.write(JSON.stringify(v)+"\n");
readline.createInterface({input:process.stdin}).on("line",line=>{
 const m=JSON.parse(line);if(!m.method)return;fs.appendFileSync(log,m.method+"\n",{mode:0o600});
 if(m.method==="initialize")send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
 if(m.method==="session/new")send({jsonrpc:"2.0",id:m.id,result:{sessionId:"pipe-session"}});
 if(m.method==="session/load")send({jsonrpc:"2.0",id:m.id,result:{}});
 if(m.method==="session/prompt"){
   active=m.id;if(mode==="hold")return;
   for(let i=0;i<320;i++)send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"pipe-session",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"x"}}}});
   send({jsonrpc:"2.0",id:m.id,result:{stopReason:"end_turn"}});active=null;
 }
 if(m.method==="session/cancel"&&active!==null){send({jsonrpc:"2.0",id:active,result:{stopReason:"cancelled"}});active=null;}
});
process.stdin.on("end",()=>process.exit(0));
`;
const workerSource = String.raw`
"use strict";
const {spawn}=require("node:child_process");
const [clientFile,handleFile,root,peer,log,mode,bindingJson]=process.argv.slice(2);
const {AcpJsonlClient}=require(clientFile),{createAcpHandle}=require(handleFile),binding=JSON.parse(bindingJson);
(async()=>{
 const child=spawn(process.execPath,[peer,log,"hold"],{stdio:["pipe","pipe","pipe"],env:{PATH:process.env.PATH,HOME:root,TMPDIR:root}});
 const rpc=new AcpJsonlClient(child,{requestTimeoutMs:5000});
 if(mode==="after-written"){
   const request=rpc.request.bind(rpc);rpc.request=(method,params,options={})=>request(method,params,method!=="session/prompt"?options:{...options,onWritten(){options.onWritten?.();setTimeout(()=>process.exit(78),60);}});
 }
 const terminated=new Promise(resolve=>child.once("close",resolve));
 const raw=await createAcpHandle({binding,rpc,home:root,workspace:root,stateDir:root,trustedRoot:root,terminated,stop:async()=>{child.kill("SIGKILL");await terminated;},host:{transport:"acp",assertRuntimeIdentityCurrent(){}}});
 await raw.sessionStart({cwd:root,source:"pipe-source"});
 await raw.turnStart({cwd:root,sessionId:"pipe-session",operationId:"pipe-operation",prompt:"controlled fixture"},{version:1,attemptId:"crashed-attempt",onPrepared:async()=>{if(mode==="prepared")process.exit(76);},onDispatchAttempt(){if(mode==="before-write")process.exit(77);},assertCurrent(){}});
})().catch(()=>process.exit(79));
`;
async function pipeFixture(root, { mode = "fast", wraps = value => value } = {}) {
  const peer = path.join(root, "peer.cjs"), log = path.join(root, "calls.log");
  fs.writeFileSync(peer, peerSource, { mode: 0o600 });
  const child = spawn(process.execPath, [peer, log, mode], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: root, TMPDIR: root } });
  const terminated = new Promise(resolve => child.once("close", resolve)), rpc = new AcpJsonlClient(child, { requestTimeoutMs: 5000 });
  const stop = async () => { child.stdin.end(); if (child.exitCode === null) child.kill("SIGTERM"); await terminated; };
  const raw = await createAcpHandle({ binding, rpc: wraps(rpc), home: root, workspace: root, stateDir: root, trustedRoot: root,
    stop, terminated, host: { transport: "acp", runtimeIdentity: { digest: "pipe" }, assertRuntimeIdentityCurrent() {} } });
  return { raw, handle: runtimeHandleV1(raw, binding), rpc, stop, log, child };
}
const input = root => ({ cwd: root, sessionId: "pipe-session", operationId: "pipe-operation", prompt: "controlled fixture" });
const methods = file => fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : [];

test("real ACP pipes preserve prepared routing for 320 immediate events and matched terminal evidence", async () => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/acp-pipe-fast-")); let f;
  try {
    f = await pipeFixture(root); const events = []; f.handle.subscribe(v => events.push(v));
    await f.handle.sessionStart({ cwd: root, source: "pipe-source" });
    let dto;
    const result = await f.handle.turnStart(input(root), observer({ async onPrepared(value) { dto = value;
      assert.equal(methods(f.log).includes("session/prompt"), false);
      assert.equal(JSON.parse(fs.readFileSync(ledgerFile(root))).sessions[0].turns[0].facts.prepared, true); } }));
    assert.equal(events.filter(v => v.type === "text_delta").length, 320);
    assert.equal(events.every(v => v.turnId === dto.turnId), true);
    assert.equal(result.execution.remoteAccepted, true); assert.equal(result.execution.terminal, true);
    assert.equal(result.execution.frameWritten, true);
  } finally { await f?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("a real before-write fence failure delivers no prompt while preserving conservative unknown", async () => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/acp-pipe-fence-")); let f;
  try {
    f = await pipeFixture(root); await f.handle.sessionStart({ cwd: root, source: "pipe-source" });
    await assert.rejects(f.handle.turnStart(input(root), observer({ onDispatchAttempt() { throw Error("revoked fence"); } })),
      { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN", dispatchState: "write_attempted" });
    assert.equal(methods(f.log).includes("session/prompt"), false);
    assert.equal(JSON.parse(fs.readFileSync(ledgerFile(root))).sessions[0].turns[0].facts.frameWritten, false);
  } finally { await f?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const mode of ["before-write", "after-written"]) test(`Service-process crash ${mode} preserves the durable attempt and cannot replay`, async () => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/acp-pipe-crash-")); let f;
  try {
    const peer = path.join(root, "peer.cjs"), worker = path.join(root, "worker.cjs"), log = path.join(root, "calls.log");
    fs.writeFileSync(peer, peerSource, { mode: 0o600 }); fs.writeFileSync(worker, workerSource, { mode: 0o600 });
    const result = spawnSync(process.execPath, [worker, path.resolve(__dirname, "../app/agent-service/acp-jsonl-client.js"),
      path.resolve(__dirname, "../app/agent-service/runtime-acp-handle.js"), root, peer, log, mode, JSON.stringify(binding)],
      { encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root } });
    assert.equal(result.status, mode === "before-write" ? 77 : 78, result.stderr);
    const receipt = JSON.parse(fs.readFileSync(ledgerFile(root))).sessions[0].turns[0];
    assert.equal(receipt.facts.writeAttempted, true); assert.equal(receipt.facts.terminal, false);
    assert.equal(receipt.facts.frameWritten, mode === "after-written");
    const count = methods(log).filter(v => v === "session/prompt").length;
    assert.equal(count, mode === "before-write" ? 0 : 1);
    f = await pipeFixture(root); await f.handle.sessionResume({ sessionId: "pipe-session" });
    await assert.rejects(f.handle.turnStart(input(root), observer()), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    await assert.rejects(f.handle.turnStart({ ...input(root), operationId: "replacement-operation" }, observer()), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    assert.equal(methods(log).filter(v => v === "session/prompt").length, count);
  } finally { await f?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("real ACP cancellation waits for the matching cancelled terminal", async () => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/acp-pipe-cancel-")); let f;
  try {
    f = await pipeFixture(root, { mode: "hold" }); await f.handle.sessionStart({ cwd: root, source: "pipe-source" });
    let dto; const ready = new Promise(resolve => { dto = resolve; });
    const running = f.handle.turnStart(input(root), observer({ onDispatchAttempt(value) { dto(value); } }));
    const prepared = await ready;
    await f.handle.turnInterrupt({ sessionId: "pipe-session", turnId: prepared.turnId });
    assert.equal((await running).turn.status, "canceled");
    const receipt = JSON.parse(fs.readFileSync(ledgerFile(root))).sessions[0].turns[0];
    assert.equal(receipt.facts.terminal, true); assert.equal(receipt.facts.stopReason, "cancelled");
    assert.equal(methods(f.log).filter(v => v === "session/cancel").length, 1);
  } finally { await f?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});


test("crash after durable preparation but before the observer proves no write and permits only exact input", async () => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/acp-pipe-prepared-")); let f;
  try {
    const peer = path.join(root, "peer.cjs"), worker = path.join(root, "worker.cjs"), log = path.join(root, "calls.log");
    fs.writeFileSync(peer, peerSource, { mode: 0o600 }); fs.writeFileSync(worker, workerSource, { mode: 0o600 });
    const result = spawnSync(process.execPath, [worker, path.resolve(__dirname, "../app/agent-service/acp-jsonl-client.js"),
      path.resolve(__dirname, "../app/agent-service/runtime-acp-handle.js"), root, peer, log, "prepared", JSON.stringify(binding)],
      { encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root } });
    assert.equal(result.status, 76, result.stderr);
    const old = JSON.parse(fs.readFileSync(ledgerFile(root))).sessions[0].turns[0];
    assert.equal(old.facts.prepared, true); assert.equal(old.facts.writeAttempted, false);
    assert.equal(methods(log).includes("session/prompt"), false);
    f = await pipeFixture(root); await f.handle.sessionResume({ sessionId: "pipe-session" });
    const before = JSON.parse(fs.readFileSync(ledgerFile(root))).sessions[0].turns[0];
    assert.equal(before.facts.notSent, true); assert.equal(before.facts.unknown, false);
    await assert.rejects(f.handle.turnStart({ ...input(root), prompt: "changed" }, observer()), { code: "RUNTIME_OPERATION_CONFLICT" });
    const completed = await f.handle.turnStart(input(root), observer({ attemptId: "crashed-attempt" }));
    assert.equal(completed.turn.id, old.id); assert.equal(completed.execution.remoteAccepted, true);
    assert.equal(methods(log).filter(v => v === "session/prompt").length, 1);
  } finally { await f?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
