#!/usr/bin/env node
"use strict";
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{EventEmitter}=require('node:events');
const repo=process.env.SHOGGOTH_TEST_REPO||path.resolve(__dirname,'..');
const {createManagedProviderTerminalRecoveryGate}=require(path.join(repo,'app/managed-openclaw-provider-terminal-recovery'));
const schema=require(path.join(repo,'app/managed-openclaw-provider-credential-schema'));
const {createManagedOpenClawHostClient}=require(path.join(repo,'app/managed-openclaw-host-client'));
const {createManagedOpenClawProductModelApi}=require(path.join(repo,'app/managed-openclaw-product-model-api'));
const {normalizeModelChangeRequest,modelChangeRequestDigest}=require(path.join(repo,'app/core/model-change-validation'));
const {SERVICE_PROTOCOL_VERSION}=require(path.join(repo,'app/agent-service/service-protocol-version'));
const root=fs.realpathSync(fs.mkdtempSync('/private/tmp/sg-terminal-unit-'));fs.chmodSync(root,0o700);
const spec=normalizeModelChangeRequest({providerKey:'local',sourceModelId:'old',model:{id:'old',name:'Original'}}).safeSpec;
const identity={operationId:'terminal-op',requestDigest:modelChangeRequestDigest(spec)};
const scope={backendId:'openclaw',providerKey:'local',baseUrl:'https://model.example.test/v1',api:'openai-completions',...identity};
const owner={version:1,backendId:'openclaw',...identity,pid:12345,startIdentity:'synthetic private port only',nonce:'b'.repeat(64),generation:'owned-generation',
 runtimeRoot:'/private/tmp/terminal-runtime',runtimeTreeSha256:'c'.repeat(64),dataRoot:'/private/tmp/terminal-host',interpreterPath:'/private/tmp/terminal-node',entryPath:'/private/tmp/terminal-runtime/openclaw.mjs',expiresAt:Date.now()+120000};
const permit={version:1,owner:{ownerId:'service-owner',capability:'d'.repeat(64)},scope,service:{instanceNonce:'e'.repeat(48),pid:23456,startedAt:Date.now()-1000,protocolVersion:SERVICE_PROTOCOL_VERSION},writer:owner};
const candidate={version:1,...scope,action:'set',bindingRevision:2,credentialRevision:3,ownerGeneration:'logical-owner'};
const previous={version:1,...scope,phase:'previous',previousScope:Object.fromEntries(schema.SCOPE_FIELDS.map(k=>[k,scope[k]])),bindingRevision:2,credentialRevision:1,ownerGeneration:'logical-owner'};
const response=(outcome='applied')=>({service:permit.service,envelope:{version:1,...scope,outcome,action:'set',bindingScope:previous.previousScope,bindingRevision:outcome==='applied'?3:2,credentialRevision:outcome==='applied'?4:1,ownerGeneration:'logical-owner',expiresAt:Date.now()+9000}});
const cases=[],clients=[];
const defer=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve}};
function workerFactory(record,mode='unknown'){return(_file,{workerData:{port,channelId}})=>{
 const worker=new EventEmitter();record.frames=[];record.port=port;let state='absent';const expiresAt=owner.expiresAt;
 const binding={token:'a'.repeat(64),...identity,generation:owner.generation,writerNonce:owner.nonce};
 const snapshot=()=>{const present=state!=='absent',running=state==='running';const status={backendId:'openclaw',state,ownership:present?'managed':'absent',dataRoot:owner.dataRoot,
  identity:present?{pid:owner.pid,startIdentity:owner.startIdentity,nonce:owner.nonce}:null,runtimeRoot:present?owner.runtimeRoot:null,candidateId:present?'f'.repeat(64):null,
  generation:present?owner.generation:null,selectionSupported:present,adapterGeneration:present?'adapter-generation':null,adapterInstanceId:present?'adapter-instance':null,
  counts:present?{totalActive:0}:null,operationId:state==='paused'?identity.operationId:null};
  const execution=running?{runtimeRoot:owner.runtimeRoot,interpreterPath:owner.interpreterPath,entryPath:owner.entryPath,home:owner.dataRoot,stateDir:owner.dataRoot,configPath:path.join(owner.dataRoot,'openclaw.json'),workspace:path.join(owner.dataRoot,'workspace'),env:{}}:null;
  return{status,endpoint:running?{url:'ws://127.0.0.1:54321',token:'1'.repeat(64),identity:status.identity,dataRoot:owner.dataRoot,runtimeRoot:owner.runtimeRoot,interpreterPath:owner.interpreterPath,entryPath:owner.entryPath}:null,execution,observedAt:Date.now()};};
 worker.terminate=async()=>{port.close();worker.emit('exit',0);};
 port.on('message',frame=>{record.frames.push(frame);if(frame.type==='cancel')return;let value=true,ok=true,error=null;
  if(frame.command==='modelAcquire')state='paused';
  if(frame.command==='modelAction'){
   if(frame.args.action==='credentialOwner')value={...owner};
   if(frame.args.action==='finish'){
    if(mode==='timeout')return;
    if(mode==='success'){state='running';value={paused:false,resumed:true,healthVerified:true};}
    else{state='paused';ok=false;error={code:'MANAGED_MODEL_CREDENTIAL_FINISH_UNKNOWN'};}
   }
  }
  if(frame.command==='modelTerminalRecover'){
   if(mode==='held'){record.held=frame;return;}
   state='running';value={outcome:mode==='wrong-outcome'?'compensated':'applied',paused:false,resumed:true,healthVerified:true};
  }
  let result={binding,expiresAt,value};if(frame.command==='stopOwned'){state='absent';result={ownership:'absent'};}
  if(frame.command==='observe')result=snapshot().status;
  port.postMessage({type:'response',channelId,id:frame.id,ok,result:ok?result:null,error,snapshot:snapshot()});
 });queueMicrotask(()=>port.postMessage({type:'ready',channelId,snapshot:snapshot()}));return worker;
};}
async function setup(mode='unknown'){const record={},client=createManagedOpenClawHostClient({stateDir:path.join(root,mode+clients.length),resourcesRoot:path.join(repo,'resources/external-plugin-host-patches'),adapterResourcesRoot:path.join(repo,'resources/external-plugin-adapters'),sourceRoot:'/opt/homebrew/lib/node_modules/openclaw',interpreterPath:(process.env.SHOGGOTH_TEST_OPENCLAW_NODE || require('node:path').join(require('node:os').homedir(), '.local', 'share', 'node', 'v24.21.0', 'bin', 'node')),architecture:'arm64',gatewayConfiguration:{},serviceUserDataRoot:root,workerFactory:workerFactory(record,mode),...(mode==='timeout'?{commandTimeoutMs:50}:{})});clients.push(client);await client.ready;const raw=await client.modelApi.acquireModelLease({...identity,safeSpec:spec});await raw.bindCredentialPermit(permit);return{client,raw,record};}
async function main(){try{
 let effects=[];const gate=createManagedProviderTerminalRecoveryGate({assertCurrent:()=>true,observeVerified:async state=>{effects.push('observe:'+state);return true;},resumeVerified:async()=>{effects.push('resume');return true;},pauseVerified:async()=>{effects.push('pause');return true;},holdUnverified:()=>{effects.push('hold');}});
 assert.equal(await gate.recover(),true);assert.deepEqual(effects,['observe:paused','resume','observe:resumed']);await assert.rejects(gate.recover());assert.equal(effects.filter(v=>v==='resume').length,1);
 cases.push('original terminal evidence precedes one resume dispatch; fresh resumed observation is mandatory and same gate cannot repeat it');
 let attempted=false,resumes=0,pauses=0;function originalGate(preFail=false){return createManagedProviderTerminalRecoveryGate({assertCurrent:()=>true,observeVerified:async()=>!preFail,
 resumeVerified:async()=>{assert.equal(attempted,false);attempted=true;resumes++;throw Error('unknown ACK');},pauseVerified:async()=>{pauses++;return true;},holdUnverified:()=>{}});}
 await assert.rejects(originalGate(true).recover());assert.equal(attempted,false);assert.equal(resumes,0);await assert.rejects(originalGate().recover());
 await assert.rejects(originalGate().recover());assert.equal(resumes,1);assert.equal(pauses,3);
 cases.push('readonly preobserve refusal consumes no original dispatch quota; recreating callback gates after unknown resume cannot reset the retained original record claim');
 const expected={candidate,previous};assert.equal(schema.credentialTerminalObservation(response(),permit,'applied',expected).envelope.bindingRevision,3);
 for(const outcome of ['compensated','blocked'])assert.equal(schema.credentialTerminalObservation(response(outcome),permit,outcome,expected).envelope.outcome,outcome);
 for(const patch of [{outcome:'compensated'},{bindingRevision:4},{bindingScope:{...previous.previousScope,api:'anthropic-messages'}},{credentialRevision:null},{ownerGeneration:'new-owner'},{expiresAt:Date.now()+11000},{apiKey:'not-allowed'}]){
  const dto=response();Object.assign(dto.envelope,patch);assert.throws(()=>schema.credentialTerminalObservation(dto,permit,'applied',expected));}
 assert.throws(()=>schema.credentialTerminalObservation({...response(),service:{...permit.service,pid:34567}},permit,'applied',expected));
 assert.throws(()=>schema.credentialTerminalObservation(response(),{...permit,writer:{...owner,expiresAt:Date.now()-1}},'applied',expected));
 cases.push('closed keyless terminal DTO binds original scope/outcome/action/current revision/Service and original unextended deadline; stale/cross-domain/secret/changed outcome reject');
 const f=await setup();await assert.rejects(f.raw.finish({...identity,safeSpec:spec,outcome:'applied'}));
 const before=f.record.frames.length;for(const changed of [{...identity,operationId:'foreign'},{...identity,requestDigest:'0'.repeat(64)},{...identity,outcome:'applied'}])await assert.rejects(f.client.modelApi.recoverCredentialTerminal(changed));
 assert.equal(f.record.frames.length,before);const receipt=await f.client.modelApi.recoverCredentialTerminal(identity);assert.deepEqual(receipt,{outcome:'applied',paused:false,resumed:true,healthVerified:true});
 assert.equal(f.record.frames.filter(v=>v.command==='modelAcquire').length,1);assert.equal(f.record.frames.filter(v=>v.command==='modelAction'&&v.args.action==='finish').length,1);
 assert.deepEqual(Object.keys(f.record.frames.find(v=>v.command==='modelTerminalRecover').args),['binding']);assert.ok(f.client.getEndpoint());
 cases.push('Client recovery sends only retained binding; foreign op/digest/caller outcome produce no wire request and success cannot re-acquire or re-finish');
 const g=await setup('success');assert.deepEqual(await g.raw.finish({...identity,safeSpec:spec,outcome:'applied'}),{paused:false,resumed:true,healthVerified:true});
 assert.ok(g.client.getEndpoint());await g.client.modelApi.recoverCredentialTerminal(identity);assert.equal(g.record.frames.filter(v=>v.command==='modelAcquire').length,1);
 cases.push('successful raw finish retains private original history so later Main publication loss can request readonly resumed proof without a new model lease');
 const bad=await setup('wrong-outcome');await assert.rejects(bad.raw.finish({...identity,safeSpec:spec,outcome:'applied'}));await assert.rejects(bad.client.modelApi.recoverCredentialTerminal(identity));assert.equal(bad.client.getEndpoint(),null);
 cases.push('success-shaped wrong outcome cannot clear Client hold or publish a running endpoint');
 const timed=await setup('timeout');await assert.rejects(timed.raw.finish({...identity,safeSpec:spec,outcome:'applied'}),{code:'MANAGED_WORKER_COMMAND_TIMEOUT'});assert.equal(timed.client.getEndpoint(),null);
 await timed.client.modelApi.recoverCredentialTerminal(identity);assert.equal(timed.client.getStatus().state,'running');
 cases.push('poisoned Client after lost original command ACK can only clear poison with exact original physical binding and verified resumed terminal receipt');
 const held=await setup('held');await assert.rejects(held.raw.finish({...identity,safeSpec:spec,outcome:'applied'}));const pending=held.client.modelApi.recoverCredentialTerminal(identity),rejected=assert.rejects(pending);
 await new Promise(r=>setImmediate(r));await held.client.close({operationId:'close-original',timeoutMs:1000});await rejected;
 assert.ok(held.record.frames.findIndex(v=>v.type==='cancel')<held.record.frames.findIndex(v=>v.command==='stopOwned'));
 await assert.rejects(held.client.modelApi.recoverCredentialTerminal(identity));
 cases.push('owned close retires pending terminal recovery before stop and cannot revive old receipt authority');
 // Product layer uses the actual Client private-port implementation above.
 const p=await setup('success');let available=true,resumedCount=0,beginCount=0;
 const bridge=createManagedOpenClawProductModelApi({getClient:()=>p.client,canAcquire:()=>available,canContinue:c=>c===p.client,begin:()=>{available=false;beginCount++;},resumed:async()=>{available=true;resumedCount++;},failed:async()=>{available=false;}});
 // Drop the setup lease only in this synthetic Worker; Product must acquire its own original brand.
 await p.client.controller.stopOwned({operationId:'setup-stop',timeoutMs:1000});
 const lease=await bridge.api.acquireModelLease({...identity,safeSpec:spec});await lease.bindCredentialPermit(permit);assert.equal(await lease.finish({...identity,safeSpec:spec,outcome:'applied'}),true);
 assert.equal(bridge.api.canRecoverModelLease(identity),false);assert.equal(bridge.api.canRecoverCredentialTerminal(identity),true);
 assert.equal((await bridge.api.recoverCredentialTerminal(identity)).outcome,'applied');assert.equal(beginCount,2);assert.equal(resumedCount,2);
 assert.equal(bridge.api.canRecoverCredentialTerminal({...identity,operationId:'foreign'}),false);bridge.retire();assert.equal(bridge.api.canRecoverCredentialTerminal(identity),false);
 cases.push('Product completed history survives Main publication loss only for original Client/epoch/owner brand; recovery synchronously withdraws ordinary endpoint and retirement rejects history');
 const retry=await setup('success');await retry.client.controller.stopOwned({operationId:'retry-setup-stop',timeoutMs:1000});
 let blockBegin=false,failPublish=true,rawRecoverCalls=0;
 const retryBridge=createManagedOpenClawProductModelApi({getClient:()=>retry.client,canAcquire:()=>true,canContinue:c=>c===retry.client,
  begin:()=>{if(blockBegin)throw Error('private begin failed');},resumed:()=>{if(failPublish){failPublish=false;throw Error('Main publication lost');}},failed:()=>{}});
 const retryLease=await retryBridge.api.acquireModelLease({...identity,safeSpec:spec});await retryLease.bindCredentialPermit(permit);
 const retryAcquireCount=retry.record.frames.filter(f=>f.command==='modelAcquire').length;
 await assert.rejects(retryLease.finish({...identity,safeSpec:spec,outcome:'applied'}));assert.equal(retryBridge.api.canRecoverCredentialTerminal(identity),true);
 blockBegin=true;const blockedFrames=retry.record.frames.length;await assert.rejects(retryBridge.api.recoverCredentialTerminal(identity));assert.equal(retry.record.frames.length,blockedFrames);
 blockBegin=false;assert.equal((await retryBridge.api.recoverCredentialTerminal(identity)).outcome,'applied');
 assert.equal(retry.record.frames.filter(f=>f.command==='modelAcquire').length,retryAcquireCount);assert.equal(retry.record.frames.filter(f=>f.command==='modelAction'&&f.args.action==='finish').length,1);
 cases.push('raw finish succeeds but Product resumed publication fails; denied begin performs no Worker effect, and exact original retry retains completed history without acquire/finish replay');
 const expired=await setup();await assert.rejects(expired.raw.finish({...identity,safeSpec:spec,outcome:'applied'}));const realNow=Date.now,beforeExpiry=expired.record.frames.length;
 try{Date.now=()=>owner.expiresAt+1;await assert.rejects(expired.client.modelApi.recoverCredentialTerminal(identity));}finally{Date.now=realNow;}
 assert.equal(expired.record.frames.length,beforeExpiry);assert.equal(expired.client.getEndpoint(),null);
 cases.push('original credential expiry is final even with a plausible success receipt: no private wire command or local authority extension is permitted');
 process.stdout.write(JSON.stringify({status:'PASS',groups:cases.length,cases,boundary:'pure schema/effect gate plus actual Client/Product with synthetic Worker MessagePort; no fixed Host or real Service/model proof'})+'\n');
 }finally{for(const c of clients)if(c.getStatus().state!=='closed')await c.close({operationId:'test-close',timeoutMs:1000});fs.rmSync(root,{recursive:true,force:true});}}
const timeout=setTimeout(()=>{process.stderr.write('terminal unit watchdog\n');process.exit(2);},15000);
main().then(()=>clearTimeout(timeout),error=>{clearTimeout(timeout);process.stderr.write(error.stack+'\n');process.exitCode=1;});
