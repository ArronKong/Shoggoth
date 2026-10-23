"use strict";
const fs=require("node:fs");const path=require("node:path");const http=require("node:http");
const crypto=require("node:crypto");const assert=require("node:assert/strict");
const {WebSocket}=require("ws");
const {createManagedPluginHostRuntimeManager,createManagedHostRuntimeAuthority,snapshotRuntimeTree}=require("../app/managed-plugin-host-runtime");
const {createManagedOpenClawHostSupervisor}=require("../app/managed-openclaw-host-supervisor");
const {generateIdentity,buildConnectParams}=require("../app/core/device-auth");
const pins=require("../app/managed-openclaw-runtime-pins.json");
const REPO=path.resolve(__dirname,"..");const SOURCE="/opt/homebrew/lib/node_modules/openclaw";
const NODE=(process.env.SHOGGOTH_TEST_OPENCLAW_NODE || require('node:path').join(require('node:os').homedir(), '.local', 'share', 'node', 'v24.21.0', 'bin', 'node'));const MODEL="managed-isolated-model";
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(callback,label,ms=20000){const end=Date.now()+ms;while(Date.now()<end){if(await callback())return;await delay(100);}throw Error(label+" timed out");}
function stream(res){res.writeHead(200,{"content-type":"text/event-stream"});
  for(const [delta,finish_reason] of [[{role:"assistant",content:"Private managed Host completed."},null],[{},"stop"]])
    res.write(`data: ${JSON.stringify({id:"managed-fixture",object:"chat.completion.chunk",created:1,model:MODEL,choices:[{index:0,delta,finish_reason}]})}\n\n`);
  res.end("data: [DONE]\n\n");}
async function client(url,token){
  const socket=new WebSocket(url,{headers:{Origin:"http://127.0.0.1"}});const identity=generateIdentity();
  const pending=new Map();let n=0;let readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const request=(method,params={})=>new Promise((resolve,reject)=>{const id=`proof-${++n}`;
    const timer=setTimeout(()=>{pending.delete(id);reject(Error(method+" timed out"));},15000);
    pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
    socket.send(JSON.stringify({type:"req",id,method,params}));});
  socket.on("message",bytes=>{const frame=JSON.parse(bytes.toString());
    if(frame.type==="event"&&frame.event==="connect.challenge"){
      void request("connect",buildConnectParams({...identity,token,scopes:["operator.read","operator.write","operator.admin"]},frame.payload?.nonce)).then(readyResolve,readyReject);return;}
    if(frame.type!=="res")return;const p=pending.get(frame.id);if(!p)return;pending.delete(frame.id);
    if(frame.ok)p.resolve(frame.payload);else p.reject(Object.assign(Error(frame.error?.message||"rejected"),{code:frame.error?.code}));});
  socket.on("error",readyReject);socket.on("close",()=>{for(const p of pending.values())p.reject(Error("closed"));pending.clear();});
  await ready;return {request,close:()=>socket.terminate()};
}
async function main(){
  const root=fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-managed-openclaw-"));fs.chmodSync(root,0o700);
  const appState=path.join(root,"app-state");fs.mkdirSync(appState,{mode:0o700});
  const cases=[];const calls=[];const pausedProofs=[];const childIdentities=[];let held=null;let supervisor=null;let manager=null;let candidate=null;
  let raw=null;let failed=false;let modelError=null;
  const model=http.createServer((req,res)=>{let bytes="";req.on("data",chunk=>bytes+=chunk);req.on("end",()=>{
    try{const body=JSON.parse(bytes||"{}");if(req.url?.endsWith("/models")){res.end(JSON.stringify({data:[{id:MODEL}]}));return;}
      calls.push(body);if(JSON.stringify(body.messages).includes("HOLD_MANAGED")){assert.equal(held,null);held=res;return;}stream(res);
    }catch(error){modelError=error;res.writeHead(500);res.end("fixture failed");}});});
  await new Promise(resolve=>model.listen(0,"127.0.0.1",resolve));
  const configuration=()=>({models:{mode:"replace",providers:{probe:{baseUrl:`http://127.0.0.1:${model.address().port}/v1`,apiKey:"fixture-only",
    api:"openai-completions",agentRuntime:{id:"openclaw"},models:[{id:MODEL,name:MODEL,reasoning:false,input:["text"],
      cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1024}]}}},
    agents:{defaults:{model:{primary:`probe/${MODEL}`}}},tools:{profile:"minimal"}});
  try{
    supervisor=createManagedOpenClawHostSupervisor({stateDir:appState,serviceUserDataRoot:root,adapterResourcesRoot:path.join(REPO,"resources/external-plugin-adapters"),getGatewayConfiguration:configuration});
    assert.equal(supervisor.getEndpoint(),null);assert.equal(supervisor.getExecution(),null);
    const original=supervisor.controller;
    const wrapped={...original,waitHealthy:async context=>{
      const proof=await original.waitHealthy(context);assert.equal(proof.paused,true);assert.equal(supervisor.getEndpoint(),null);
      const data=supervisor.getStatus().dataRoot;const config=JSON.parse(fs.readFileSync(path.join(data,"openclaw.json")));
      const descriptor=JSON.parse(fs.readFileSync(path.join(data,"managed-control.json")));
      raw=await client(`ws://127.0.0.1:${config.gateway.port}`,config.gateway.auth.token);
      const params={version:1,controlToken:descriptor.controlToken,nonce:descriptor.nonce,operationId:context.operationId,
        deadlineAt:Date.now()+10000,generation:supervisor.getStatus().generation};
      const actual=await raw.request("gateway.shoggoth.managed.status",params);
      assert.equal(actual.paused,true);assert.equal(actual.runtimeRoot,candidate.runtimeRoot);assert.equal(actual.pid,context.identity.pid);
      assert.equal(actual.snapshot.idle,true);assert.equal(actual.snapshot.counts.totalActive,0);
      assert.equal(actual.selectionSupported,true);assert.ok(actual.adapterGeneration);assert.ok(actual.adapterInstanceId);
      const before=calls.length;
      await assert.rejects(raw.request("chat.send",{sessionKey:"agent:main:paused",message:"must never reach model",idempotencyKey:crypto.randomUUID()}),/suspension/);
      await assert.rejects(raw.request("gateway.shoggoth.managed.resume",{...params,deadlineAt:Date.now()-1}),/MANAGED_RUNTIME_CONTROL_REJECTED/);
      await assert.rejects(raw.request("gateway.shoggoth.managed.resume",{...params,controlToken:"0".repeat(64)}),/MANAGED_RUNTIME_CONTROL_REJECTED/);
      await assert.rejects(raw.request("gateway.shoggoth.managed.resume",{...params,generation:crypto.randomUUID()}),/MANAGED_RUNTIME_CONTROL_REJECTED/);
      assert.equal((await raw.request("gateway.shoggoth.managed.status",{...params,deadlineAt:Date.now()+10000})).paused,true);
      await delay(200);assert.equal(calls.length,before);
      pausedProofs.push({...actual,snapshot:actual.snapshot});childIdentities.push({...context.identity});raw.close();raw=null;
      return proof;
    }};
    manager=createManagedPluginHostRuntimeManager({stateDir:appState,resourcesRoot:path.join(REPO,"resources/external-plugin-host-patches"),
      inputPins:pins,activationAuthority:createManagedHostRuntimeAuthority(wrapped),stageTimeoutMs:60000});
    process.stdout.write(JSON.stringify({phase:"preparing_fixed_candidate",root})+"\n");
    candidate=await manager.prepareCandidate({backendId:"openclaw",sourceRoot:SOURCE,interpreterPath:NODE,architecture:"arm64"});
    assert.equal(candidate.runtimeTreeSha256,pins.hosts.openclaw.outputTreeSha256);
    assert.equal(snapshotRuntimeTree(SOURCE).sha256,pins.hosts.openclaw.inputTreeSha256);
    cases.push("entire original source/dependencies unchanged; fixed managed-v1 candidate copied and sealed");
    process.stdout.write(JSON.stringify({phase:"candidate_ready",runtimeRoot:candidate.runtimeRoot,root})+"\n");
    const first=await manager.activateCandidate({backendId:"openclaw",candidateId:candidate.candidateId,operationId:"managed-first"});
    assert.equal(first.healthVerified,true);assert.equal(supervisor.getStatus().state,"running");
    assert.equal(calls.length,0);cases.push("real Gateway startup paused; ordinary chat, expired resume, wrong token and wrong generation all reject with zero model requests");
    const endpoint=supervisor.getEndpoint();const execution=supervisor.getExecution();assert.ok(endpoint&&execution);
    assert.equal(execution.runtimeRoot,candidate.runtimeRoot);assert.equal(execution.interpreterPath,NODE);
    assert.ok(execution.home.startsWith(supervisor.getStatus().dataRoot+"/"));assert.ok(execution.configPath.startsWith(supervisor.getStatus().dataRoot+"/"));
    const firstGeneration=supervisor.getStatus().generation;
    const firstOp=crypto.randomUUID();
    await supervisor.request("chat.send",{sessionKey:"agent:main:ordinary",message:"ordinary managed message",idempotencyKey:firstOp});
    await until(()=>calls.length===1,"first actual model request");
    await until(async()=>JSON.stringify(await supervisor.request("chat.history",{sessionKey:"agent:main:ordinary",limit:20})).includes("Private managed Host completed."),"actual persisted ordinary result");
    cases.push("App-owned resumed real Gateway completes local model turn and persists actual chat history");
    const holdOp=crypto.randomUUID();await supervisor.request("chat.send",{sessionKey:"agent:main:holding",message:"HOLD_MANAGED",idempotencyKey:holdOp});
    await until(()=>held!==null,"held actual model request");
    const countAtDrain=calls.length;const samePhysical={...supervisor.getStatus().identity};
    const context={backendId:"openclaw",operationId:"managed-replacement",candidate,nonce:"a".repeat(64),deadlineAt:Date.now()+60000,
      signal:new AbortController().signal,assertCurrent(){}};
    const drain=await original.acquireDrain(context);
    const config=JSON.parse(fs.readFileSync(path.join(supervisor.getStatus().dataRoot,"openclaw.json")));
    const descriptor=JSON.parse(fs.readFileSync(path.join(supervisor.getStatus().dataRoot,"managed-control.json")));
    raw=await client(`ws://127.0.0.1:${config.gateway.port}`,config.gateway.auth.token);
    const actualBusy=await raw.request("gateway.shoggoth.managed.status",{version:1,controlToken:descriptor.controlToken,nonce:descriptor.nonce,
      operationId:context.operationId,deadlineAt:Date.now()+10000,generation:firstGeneration});
    assert.equal(actualBusy.paused,true);assert.equal(actualBusy.snapshot.idle,false);assert.ok(actualBusy.snapshot.counts.totalActive>0);
    await assert.rejects(raw.request("chat.send",{sessionKey:"agent:main:new-during-drain",message:"never sent",idempotencyKey:crypto.randomUUID()}),/suspension/);
    await delay(200);assert.equal(calls.length,countAtDrain);
    assert.deepEqual(supervisor.getStatus().identity,samePhysical);
    stream(held);held=null;await original.assertIdle(context);
    await drain.release(context);raw.close();raw=null;
    cases.push("real model work remains tracked while paused; new work refused; admitted model finishes to a complete zero-count idle snapshot");
    const second=await manager.activateCandidate({backendId:"openclaw",candidateId:candidate.candidateId,operationId:"managed-replacement"});
    assert.equal(second.healthVerified,true);assert.notEqual(second.active.writer.pid,first.active.writer.pid);
    assert.notEqual(supervisor.getStatus().generation,firstGeneration);
    assert.throws(()=>process.kill(first.active.writer.pid,0));
    assert.equal(calls.length,countAtDrain);
    assert.ok(JSON.stringify(await supervisor.request("chat.history",{sessionKey:"agent:main:ordinary",limit:20})).includes("Private managed Host completed."));
    cases.push("drain and actual previous foreground child exit precede fresh paused generation; atomic active pointer switches with private chat history preserved");
    const twin=createManagedOpenClawHostSupervisor({stateDir:appState,serviceUserDataRoot:root,adapterResourcesRoot:path.join(REPO,"resources/external-plugin-adapters"),getGatewayConfiguration:configuration});
    assert.equal(twin.getStatus().ownership,"unknown");
    await assert.rejects(twin.stopOwned({operationId:"unknown-stop"}),error=>error.code==="MANAGED_HOST_WRITER_OWNER_UNKNOWN");
    const unknownManager=createManagedPluginHostRuntimeManager({stateDir:appState,resourcesRoot:path.join(REPO,"resources/external-plugin-host-patches"),inputPins:pins,activationAuthority:twin.activationAuthority});
    await assert.rejects(unknownManager.activateCandidate({backendId:"openclaw",candidateId:candidate.candidateId,operationId:"unknown-activate"}),error=>error.code==="RUNTIME_WRITER_OWNER_UNKNOWN");
    assert.equal(supervisor.getStatus().state,"running");assert.equal(calls.length,countAtDrain);
    cases.push("second App supervisor cannot adopt or kill unknown fence owner and cannot start a second writer");
    await supervisor.stopOwned({operationId:"managed-final-stop",timeoutMs:30000});
    assert.equal(supervisor.getStatus().ownership,"absent");assert.equal(supervisor.getEndpoint(),null);
    assert.equal(fs.existsSync(path.join(supervisor.getStatus().dataRoot,"writer.fence")),false);
    for(const value of childIdentities)assert.throws(()=>process.kill(value.pid,0));
    cases.push("actual final drain, idle and captured-child exit release lifetime fence; endpoint and execution become unavailable");
    for(const body of calls){const text=JSON.stringify(body.messages);assert.ok(!text.includes("controlToken")&&!text.includes("runtimeTreeSha256")&&!text.includes("writer.fence"));}
    cases.push("control credentials, runtime binding and selection metadata remain outside model context");
    if(modelError)throw modelError;
    const evidence={version:1,status:"PASS",root,runtimeRoot:candidate.runtimeRoot,candidateId:candidate.candidateId,
      inputTreeSha256:pins.hosts.openclaw.inputTreeSha256,runtimeTreeSha256:candidate.runtimeTreeSha256,
      node:{path:NODE,version:pins.hosts.openclaw.interpreter.version,architecture:pins.hosts.openclaw.interpreter.architecture},
      modelRequests:calls.length,cases,childIdentities,pausedProofs,globalSourceWrites:0,globalHostStarts:0,realAccountRequests:0,
      gaps:["App ui-entry and Backend execution scope wiring owned separately","current-process captured child only; persisted unknown writer is not adopted","arm64 exact local source policy only; no Intel or official clean install baseline"]};
    fs.writeFileSync(path.join(root,"public-evidence.json"),JSON.stringify(evidence,null,2)+"\n",{mode:0o600});
    process.stdout.write(JSON.stringify({status:"PASS",caseCount:cases.length,modelRequests:calls.length,evidence:path.join(root,"public-evidence.json"),runtimeRoot:candidate.runtimeRoot})+"\n");
  }catch(error){failed=true;process.stdout.write(JSON.stringify({status:"FAIL",code:error.code,message:error.message,root})+"\n");throw error;}
  finally{
    raw?.close();if(held){held.destroy();held=null;}
    if(supervisor?.getStatus().ownership==="managed")try{await supervisor.stopOwned({operationId:"fixture-cleanup",timeoutMs:30000});}catch(error){process.stderr.write("owned cleanup pending: "+error.code+"\n");}
    model.closeAllConnections();await new Promise(resolve=>model.close(resolve));
    // Keep the immutable shared candidate until explicitly released by the
    // parent and UI proof consumer; remove private credentials after own exit.
    if(supervisor?.getStatus().ownership==="absent"){
      const data=supervisor.getStatus().dataRoot;for(const rel of ["openclaw.json","managed-control.json","selection-trust.json"])
        if(fs.existsSync(path.join(data,rel)))fs.unlinkSync(path.join(data,rel));
      for(const rel of ["state/agents","state/devices","state/identity","home"])
        if(fs.existsSync(path.join(data,rel)))fs.rmSync(path.join(data,rel),{recursive:true,force:true});
    }
    if(failed)process.exitCode=1;
  }
}
if(require.main===module)main().catch(error=>{process.stderr.write(error.stack+"\n");process.exitCode=1;});
module.exports={client};
