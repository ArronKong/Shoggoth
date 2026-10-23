"use strict";
const fs=require("node:fs");const path=require("node:path");const crypto=require("node:crypto");const http=require("node:http");const assert=require("node:assert/strict");
const {createManagedPluginHostRuntimeManager}=require("../app/managed-plugin-host-runtime");
const {createManagedOpenClawHostSupervisor}=require("../app/managed-openclaw-host-supervisor");
const {client}=require("./plugin-managed-openclaw-real-host-fixture.cjs");
const pins=require("../app/managed-openclaw-runtime-pins.json");const REPO=path.resolve(__dirname,"..");
async function main(){
  const sourceRoot=fs.realpathSync(process.argv[2]);assert.ok(sourceRoot.startsWith("/private/tmp/sg-managed-openclaw-"));
  const reader=createManagedPluginHostRuntimeManager({stateDir:path.join(sourceRoot,"app-state"),resourcesRoot:path.join(REPO,"resources/external-plugin-host-patches"),inputPins:pins});
  const pointer=JSON.parse(fs.readFileSync(path.join(sourceRoot,"app-state/external-plugin-host-runtimes/openclaw/candidate.json")));
  const candidate=reader.getCandidate("openclaw",pointer.candidateId);
  const root=fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-managed-openclaw-failure-"));fs.chmodSync(root,0o700);
  const state=path.join(root,"app-state");fs.mkdirSync(state,{mode:0o700});
  let modelRequests=0;const model=http.createServer((req,res)=>{modelRequests+=1;res.writeHead(503);res.end("model must not be called");});
  await new Promise(resolve=>model.listen(0,"127.0.0.1",resolve));
  const supervisor=createManagedOpenClawHostSupervisor({stateDir:state,serviceUserDataRoot:root,adapterResourcesRoot:path.join(REPO,"resources/external-plugin-adapters"),
    getGatewayConfiguration:()=>({models:{mode:"replace",providers:{probe:{baseUrl:`http://127.0.0.1:${model.address().port}/v1`,apiKey:"fixture-only",
      api:"openai-completions",agentRuntime:{id:"openclaw"},models:[{id:"failure-isolated",name:"failure-isolated",reasoning:false,input:["text"],
        cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1024}]}}},
      agents:{defaults:{model:{primary:"probe/failure-isolated"}}},tools:{profile:"minimal"}})});
  const controller=supervisor.controller;let fence,drain,raw,identity;const cases=[];
  const context={backendId:"openclaw",candidate,operationId:"failure-own-start",nonce:crypto.randomBytes(32).toString("hex"),
    deadlineAt:Date.now()+60000,signal:new AbortController().signal,assertCurrent(){}};
  try{
    const owner=await controller.inspectWriter(context);context.dataRoot=owner.dataRoot;context.previousWriter=null;
    drain=await controller.acquireDrain(context);fence=await controller.claimExclusiveDataFence(context);
    identity=await controller.startPaused(context);const proof=await controller.waitHealthy({...context,identity});
    assert.equal(proof.paused,true);assert.equal(supervisor.getEndpoint(),null);
    await controller.failClosed({...context,nonce:"0".repeat(64),identity});
    assert.equal(process.kill(identity.pid,0),true);assert.equal(supervisor.getStatus().ownership,"managed");
    cases.push("foreign launch nonce cannot close the captured healthy paused Gateway");
    const config=JSON.parse(fs.readFileSync(path.join(owner.dataRoot,"openclaw.json")));
    const descriptor=JSON.parse(fs.readFileSync(path.join(owner.dataRoot,"managed-control.json")));
    raw=await client(`ws://127.0.0.1:${config.gateway.port}`,config.gateway.auth.token);
    const params={version:1,controlToken:descriptor.controlToken,nonce:descriptor.nonce,operationId:context.operationId,
      deadlineAt:Date.now()+10000,generation:supervisor.getStatus().generation};
    await raw.request("gateway.shoggoth.managed.retire",params);
    await assert.rejects(raw.request("gateway.shoggoth.managed.resume",params),/MANAGED_RUNTIME_OPERATION_RETIRED/);
    const status=await raw.request("gateway.shoggoth.managed.status",params);assert.equal(status.paused,true);
    await assert.rejects(raw.request("chat.send",{sessionKey:"agent:main:retired",message:"never run",idempotencyKey:crypto.randomUUID()}),/suspension/);
    cases.push("actual Host retires operation and rejects subsequent buffered resume and normal chat");
    raw.close();raw=null;
    await controller.failClosed({...context,identity:null,deadlineAt:Date.now()+15000});
    assert.throws(()=>process.kill(identity.pid,0));assert.equal(supervisor.getStatus().ownership,"absent");
    assert.equal(fs.existsSync(path.join(owner.dataRoot,"writer.fence")),false);
    cases.push("missing start receipt still closes only exact current nonce's captured child and confirms lifetime fence release");
    assert.equal(modelRequests,0);
    const evidence={version:1,status:"PASS",root,candidateId:candidate.candidateId,runtimeTreeSha256:candidate.runtimeTreeSha256,
      actualChild:identity,cases,modelRequests,globalWrites:0,realAccountRequests:0};
    fs.writeFileSync(path.join(root,"public-evidence.json"),JSON.stringify(evidence,null,2)+"\n",{mode:0o600});
    process.stdout.write(JSON.stringify({status:"PASS",groups:cases.length,evidence:path.join(root,"public-evidence.json")})+"\n");
  }finally{
    raw?.close();if(supervisor.getStatus().ownership==="managed")try{await controller.failClosed({...context,identity:null,deadlineAt:Date.now()+15000});}catch{}
    if(supervisor.getStatus().ownership==="absent"){
      if(fence)await fence.release(context);if(drain)await drain.release(context);
      fs.rmSync(state,{recursive:true,force:true});
    }
    model.closeAllConnections();await new Promise(resolve=>model.close(resolve));
  }
}
main().catch(error=>{process.stderr.write(error.stack+"\n");process.exitCode=1;});
